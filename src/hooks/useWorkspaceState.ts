import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react'

type WorkspaceStateOptions<T> = {
  enabled?: boolean
  /** Whether this account may initialize an empty remote store. */
  seedWhenEmpty?: boolean
  /** Stable authorization-scope identifier used only to isolate the browser cache. */
  scope?: string
  validate?: (value: unknown) => value is T
}

type ScopedValue<T> = {
  identity: string
  value: T
}

type PendingWrite = {
  controller: AbortController
  identity: string
}

type HydrationWaiter = {
  identity: string
  finish: (ready: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

type WorkspaceWriteOptions = {
  /** Use after a dedicated API already committed the same value. */
  persist?: boolean
  /** Workspace hash returned by that dedicated API commit. */
  serverVersion?: string
}

export type WorkspaceWriteResult = {
  ok: boolean
  persisted: boolean
  status?: number
  message?: string
}

export type WorkspaceStateSetter<T> = (
  action: SetStateAction<T>,
  options?: WorkspaceWriteOptions,
) => Promise<WorkspaceWriteResult>

type WriteContext<T> = {
  previousValue: T
  version: number
}

function emitWorkspaceFailure(key: string, status: number | undefined, message: string) {
  if (typeof window === 'undefined') return
  const detail = { key, status, message }
  window.dispatchEvent(new CustomEvent('onfactory:workspace-error', { detail }))
  if (status === 401) window.dispatchEvent(new CustomEvent('onfactory:auth-expired', { detail }))
}

function readCache<T>(cacheKey: string | null, initialValue: T, validate?: (value: unknown) => value is T): T {
  if (!cacheKey || typeof window === 'undefined') return initialValue

  try {
    const cached = window.localStorage.getItem(cacheKey)
    const parsed: unknown = cached ? JSON.parse(cached) : null
    return parsed !== null && (!validate || validate(parsed)) ? parsed as T : initialValue
  } catch {
    return initialValue
  }
}

function writeCache<T>(cacheKey: string | null, value: T) {
  if (!cacheKey || typeof window === 'undefined') return
  try { window.localStorage.setItem(cacheKey, JSON.stringify(value)) } catch { /* cache is optional */ }
}

function waitForHydration(
  waiters: Set<HydrationWaiter>,
  identity: string,
  timeoutMs = 8000,
): Promise<boolean> {
  return new Promise((resolve) => {
    let waiter: HydrationWaiter
    const finish = (ready: boolean) => {
      clearTimeout(waiter.timer)
      waiters.delete(waiter)
      resolve(ready)
    }
    waiter = {
      identity,
      finish,
      timer: setTimeout(() => finish(false), timeoutMs),
    }
    waiters.add(waiter)
  })
}

function settleHydration(waiters: Set<HydrationWaiter>, identity: string, ready: boolean) {
  for (const waiter of [...waiters]) {
    if (waiter.identity === identity) waiter.finish(ready)
  }
}

/**
 * Keeps tenant-scoped operational data synchronized with the local API server.
 * localStorage is only an offline/bootstrap cache; the authenticated server store
 * remains the shared source for other employees and browser sessions.
 *
 * A stable `scope` (normally tenant id + account id) enables the offline cache.
 * Omitting it deliberately disables localStorage so data can never be reused across
 * tenants merely because two tenants use the same workspace key.
 */
export function useWorkspaceState<T>(
  key: string,
  initialValue: T,
  options: WorkspaceStateOptions<T> = {},
): [T, WorkspaceStateSetter<T>] {
  const { enabled = true, seedWhenEmpty = true, scope, validate } = options
  const normalizedScope = scope?.trim() || null
  const cacheKey = normalizedScope ? `onfactory-workspace:${normalizedScope}:${key}` : null
  const identity = useMemo(
    () => JSON.stringify([enabled, seedWhenEmpty, normalizedScope, key]),
    [enabled, key, normalizedScope, seedWhenEmpty],
  )
  const [scopedValue, setScopedValue] = useState<ScopedValue<T>>(() => ({
    identity,
    value: readCache(cacheKey, initialValue, validate),
  }))
  const requestSequence = useRef(0)
  const hydratedRef = useRef(false)
  const dirtyRef = useRef(false)
  const activeIdentityRef = useRef(identity)
  const committedIdentityRef = useRef(identity)
  const valueRef = useRef(scopedValue.value)
  const writeVersionRef = useRef(0)
  const serverVersionRef = useRef<string | null>(null)
  const pendingWritesRef = useRef<Set<PendingWrite>>(new Set())
  const hydrationWaitersRef = useRef<Set<HydrationWaiter>>(new Set())

  // Hide the previous scope's state immediately. The effect below commits this
  // bootstrap value and then hydrates it from the authenticated tenant store.
  if (activeIdentityRef.current !== identity) {
    activeIdentityRef.current = identity
    requestSequence.current += 1
    hydratedRef.current = false
    dirtyRef.current = false
    writeVersionRef.current += 1
    serverVersionRef.current = null
    valueRef.current = readCache(cacheKey, initialValue, validate)
  } else if (scopedValue.identity === identity) {
    valueRef.current = scopedValue.value
  }

  const writeValue = useCallback(async (nextValue: T, context?: WriteContext<T>): Promise<WorkspaceWriteResult> => {
    const writeIdentity = identity
    if (activeIdentityRef.current !== writeIdentity) return { ok: false, persisted: false }

    writeCache(cacheKey, nextValue)
    if (!enabled) return { ok: true, persisted: false }
    if (!hydratedRef.current) {
      const message = '공유 데이터를 불러오는 중입니다. 잠시 후 다시 시도해 주세요.'
      emitWorkspaceFailure(key, undefined, message)
      return { ok: false, persisted: false, message }
    }

    const controller = new AbortController()
    const pendingWrite: PendingWrite = { controller, identity: writeIdentity }
    pendingWritesRef.current.add(pendingWrite)
    try {
      const response = await fetch(`/api/workspace/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          ...(serverVersionRef.current ? { 'if-match': `"${serverVersionRef.current}"` } : {}),
          ...(normalizedScope ? { 'x-workspace-identity': normalizedScope } : {}),
        },
        body: JSON.stringify({ data: nextValue }),
        keepalive: true,
        signal: controller.signal,
      })
      if (!response.ok) {
        let message = '공유 데이터를 저장하지 못했습니다. 다시 시도해 주세요.'
        let currentVersion: string | null = null
        try {
          const body = await response.json() as { error?: { message?: string }; currentVersion?: string }
          if (body.error?.message) message = body.error.message
          currentVersion = body.currentVersion ?? null
        } catch { /* the status code is still enough to report the failure */ }
        emitWorkspaceFailure(key, response.status, message)
        if (response.status === 409 && activeIdentityRef.current === writeIdentity) {
          serverVersionRef.current = currentVersion
          try {
            const latest = await fetch(`/api/workspace/${encodeURIComponent(key)}`, {
              headers: normalizedScope ? { 'x-workspace-identity': normalizedScope } : undefined,
            })
            if (latest.ok) {
              const body = await latest.json() as { data?: unknown; version?: string }
              if (Object.prototype.hasOwnProperty.call(body, 'data') && body.data !== null && (!validate || validate(body.data))) {
                const latestValue = body.data as T
                serverVersionRef.current = body.version ?? latest.headers.get('etag')?.replace(/^W\//, '').replace(/^"|"$/g, '') ?? null
                writeVersionRef.current += 1
                valueRef.current = latestValue
                committedIdentityRef.current = writeIdentity
                dirtyRef.current = false
                setScopedValue({ identity: writeIdentity, value: latestValue })
                writeCache(cacheKey, latestValue)
              }
            }
          } catch { /* the conflict itself has already been reported */ }
          return { ok: false, persisted: false, status: response.status, message }
        }
        if (context && activeIdentityRef.current === writeIdentity && writeVersionRef.current === context.version) {
          valueRef.current = context.previousValue
          committedIdentityRef.current = writeIdentity
          dirtyRef.current = false
          setScopedValue({ identity: writeIdentity, value: context.previousValue })
          writeCache(cacheKey, context.previousValue)
        }
        return { ok: false, persisted: false, status: response.status, message }
      }
      try {
        const body = await response.json() as { version?: string }
        serverVersionRef.current = body.version ?? response.headers.get('etag')?.replace(/^W\//, '').replace(/^"|"$/g, '') ?? serverVersionRef.current
      } catch { /* a successful status still confirms persistence */ }
      return { ok: true, persisted: true, status: response.status }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return { ok: false, persisted: false }
      const message = '공유 데이터 서버에 연결하지 못했습니다. 변경 내용을 저장하지 않았습니다.'
      emitWorkspaceFailure(key, undefined, message)
      if (context && activeIdentityRef.current === writeIdentity && writeVersionRef.current === context.version) {
        valueRef.current = context.previousValue
        committedIdentityRef.current = writeIdentity
        dirtyRef.current = false
        setScopedValue({ identity: writeIdentity, value: context.previousValue })
        writeCache(cacheKey, context.previousValue)
      }
      return { ok: false, persisted: false, message }
    } finally {
      pendingWritesRef.current.delete(pendingWrite)
    }
  }, [cacheKey, enabled, identity, key, normalizedScope, validate])

  const setSharedValue = useCallback<WorkspaceStateSetter<T>>(async (action, writeOptions = {}) => {
    const updateIdentity = identity
    if (activeIdentityRef.current !== updateIdentity) return { ok: false, persisted: false }
    if (enabled && writeOptions.persist !== false && !hydratedRef.current) {
      const ready = await waitForHydration(hydrationWaitersRef.current, updateIdentity)
      if (!ready || activeIdentityRef.current !== updateIdentity) {
        const message = '공유 데이터를 준비하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요.'
        return { ok: false, persisted: false, message }
      }
    }

    dirtyRef.current = true
    const currentValue = valueRef.current
    const nextValue = typeof action === 'function'
      ? (action as (previous: T) => T)(currentValue)
      : action
    valueRef.current = nextValue
    committedIdentityRef.current = updateIdentity
    setScopedValue({ identity: updateIdentity, value: nextValue })
    writeCache(cacheKey, nextValue)
    if (writeOptions.persist === false) {
      if (typeof writeOptions.serverVersion === 'string' && writeOptions.serverVersion) {
        serverVersionRef.current = writeOptions.serverVersion
      }
      return { ok: true, persisted: false }
    }
    const version = ++writeVersionRef.current
    return writeValue(nextValue, { previousValue: currentValue, version })
  }, [cacheKey, enabled, identity, key, writeValue])

  useEffect(() => {
    const hydrationIdentity = identity
    const sequence = ++requestSequence.current

    if (!enabled) {
      hydratedRef.current = false
      settleHydration(hydrationWaitersRef.current, hydrationIdentity, true)
      return
    }

    hydratedRef.current = false
    const bootstrapValue = readCache(cacheKey, initialValue, validate)
    if (committedIdentityRef.current !== hydrationIdentity) {
      committedIdentityRef.current = hydrationIdentity
      if (!dirtyRef.current && activeIdentityRef.current === hydrationIdentity) {
        valueRef.current = bootstrapValue
        setScopedValue({ identity: hydrationIdentity, value: bootstrapValue })
      }
    }

    const controller = new AbortController()
    let active = true
    let loadSucceeded = false
    let remoteWasEmpty = false
    fetch(`/api/workspace/${encodeURIComponent(key)}`, {
      signal: controller.signal,
      headers: normalizedScope ? { 'x-workspace-identity': normalizedScope } : undefined,
    })
      .then(async (response) => {
        if (!response.ok) {
          let message = '공유 데이터를 불러오지 못했습니다.'
          try {
            const body = await response.json() as { error?: { message?: string } }
            if (body.error?.message) message = body.error.message
          } catch { /* keep the safe generic message */ }
          throw Object.assign(new Error(message), { status: response.status })
        }
        const body = await response.json() as unknown
        if (!body || typeof body !== 'object' || !Object.prototype.hasOwnProperty.call(body, 'data')) {
          throw new Error('공유 데이터 응답 형식이 올바르지 않습니다.')
        }
        return body as { data: unknown; version?: string }
      })
      .then(({ data, version }) => {
        if (sequence !== requestSequence.current || activeIdentityRef.current !== hydrationIdentity) return
        if (data !== null && validate && !validate(data)) throw new Error('공유 데이터 형식이 올바르지 않아 안전하게 불러오지 않았습니다.')
        loadSucceeded = true
        serverVersionRef.current = version ?? null
        if (data === null) {
          remoteWasEmpty = true
          return
        }
        if (dirtyRef.current) return
        valueRef.current = data as T
        committedIdentityRef.current = hydrationIdentity
        setScopedValue({ identity: hydrationIdentity, value: data as T })
        writeCache(cacheKey, data as T)
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        if (sequence !== requestSequence.current || activeIdentityRef.current !== hydrationIdentity) return
        const status = typeof error?.status === 'number' ? error.status : undefined
        const message = error instanceof Error ? error.message : '공유 데이터를 불러오지 못했습니다.'
        emitWorkspaceFailure(key, status, message)
      })
      .finally(() => {
        if (!active || sequence !== requestSequence.current || activeIdentityRef.current !== hydrationIdentity) return
        if (!loadSucceeded) {
          hydratedRef.current = false
          settleHydration(hydrationWaitersRef.current, hydrationIdentity, false)
          return
        }
        hydratedRef.current = true
        const hasWaitingAction = [...hydrationWaitersRef.current]
          .some((waiter) => waiter.identity === hydrationIdentity)
        if (remoteWasEmpty && seedWhenEmpty && !dirtyRef.current && !hasWaitingAction) {
          void writeValue(valueRef.current)
        }
        settleHydration(hydrationWaitersRef.current, hydrationIdentity, true)
      })

    return () => {
      active = false
      controller.abort()
      settleHydration(hydrationWaitersRef.current, hydrationIdentity, false)
      for (const pendingWrite of pendingWritesRef.current) {
        if (pendingWrite.identity !== hydrationIdentity) continue
        pendingWrite.controller.abort()
        pendingWritesRef.current.delete(pendingWrite)
      }
    }
  }, [cacheKey, enabled, identity, key, normalizedScope, seedWhenEmpty, validate, writeValue])

  const value = scopedValue.identity === identity ? scopedValue.value : valueRef.current
  return [value, setSharedValue]
}

import { env as cloudflareEnv } from 'cloudflare:workers'
import { httpServerHandler as cloudflareHttpServerHandler } from 'cloudflare:node'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import currentWorkspaceSeed from './initial-workspace-state.json' with { type: 'json' }
import { createApp as createExpressApp } from '../server/app.mjs'

const STATE_ID = 'onfactory'
const REQUEST_LOCK_ID = 'onfactory-api'
const EXPRESS_PORT = 3000
const DOCUMENT_DIRECTORY = '/tmp/onfactory-documents'
const LOCK_LEASE_MS = 30_000
const LOCK_WAIT_MS = 75_000
const LOCK_HEARTBEAT_MS = 10_000
const LOCK_RETRY_MIN_MS = 30
const LOCK_RETRY_MAX_MS = 250

const STATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS app_state (
    id TEXT PRIMARY KEY NOT NULL,
    payload TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  )
`
const REQUEST_LOCK_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS request_locks (
    id TEXT PRIMARY KEY NOT NULL,
    owner TEXT,
    expires_at INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )
`
const RATE_LIMIT_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS api_rate_limits (
    key TEXT PRIMARY KEY NOT NULL,
    request_count INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  )
`

const AUTH_RATE_LIMITS = {
  '/api/auth/login': { identityLimit: 10, addressLimit: 50, windowMs: 15 * 60_000 },
  '/api/auth/password-reset': { identityLimit: 5, addressLimit: 20, windowMs: 60 * 60_000 },
  '/api/auth/password-reset/confirm': { identityLimit: 10, addressLimit: 30, windowMs: 15 * 60_000 },
}

class RequestLockTimeoutError extends Error {
  constructor(retryAfterSeconds) {
    super('배포 저장소가 다른 요청을 처리하고 있습니다.')
    this.name = 'RequestLockTimeoutError'
    this.retryAfterSeconds = retryAfterSeconds
  }
}

class RequestLockLostError extends Error {
  constructor() {
    super('배포 저장소 잠금의 소유권을 잃었습니다.')
    this.name = 'RequestLockLostError'
  }
}

class RuntimeConfigurationError extends Error {
  constructor() {
    super('ERP_SEED_PASSWORD 배포 secret이 12자 이상의 안전한 값으로 설정되지 않았습니다.')
    this.name = 'RuntimeConfigurationError'
  }
}

function cloneSeed(seed) {
  const value = seed && typeof seed === 'object' && !Array.isArray(seed) ? structuredClone(seed) : {}
  value.version = 2
  value.tenants = value.tenants && typeof value.tenants === 'object' && !Array.isArray(value.tenants) ? value.tenants : {}
  value.platform = value.platform && typeof value.platform === 'object' && !Array.isArray(value.platform) ? value.platform : {}
  value.accountApprovals = value.accountApprovals && typeof value.accountApprovals === 'object' && !Array.isArray(value.accountApprovals) ? value.accountApprovals : {}
  value.accountCredentials = value.accountCredentials && typeof value.accountCredentials === 'object' && !Array.isArray(value.accountCredentials) ? value.accountCredentials : {}
  value.invitedAccounts = Array.isArray(value.invitedAccounts) ? value.invitedAccounts : []
  value.passwordResetRequests = Array.isArray(value.passwordResetRequests) ? value.passwordResetRequests : []
  return value
}

function deploymentSeed(seed) {
  const value = cloneSeed(seed)
  for (const tenantStore of Object.values(value.tenants)) {
    const locations = tenantStore?.['inventory-locations']
    if (Array.isArray(locations?.data)) {
      locations.data = locations.data.filter((item) => !(item?.id === 'WH-77537' && item?.name === 'ㅇㅇ'))
    }
    const movements = tenantStore?.['inventory-movements']
    if (Array.isArray(movements?.data)) {
      movements.data = movements.data.filter((item) => !(item?.product === '통합 QA 테스트 품목' && item?.lot === 'LOT-QA-260820'))
    }
  }
  return value
}

function changes(result) {
  return Number(result?.meta?.changes ?? 0)
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function hashRateLimitKey(value) {
  return createHash('sha256').update(value).digest('base64url')
}

function clientAddress(request) {
  const forwarded = String(request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '')
    .split(',')[0]
    .trim()
  return forwarded || 'unknown-client'
}

function validSeedPassword(runtimeEnv) {
  const password = typeof runtimeEnv.ERP_SEED_PASSWORD === 'string' ? runtimeEnv.ERP_SEED_PASSWORD : ''
  if (password.length < 12 || password === 'demo1234') {
    throw new RuntimeConfigurationError()
  }
  return password
}

async function ensureRuntimeTables(runtimeEnv) {
  await runtimeEnv.DB.prepare(STATE_TABLE_SQL).run()
  await runtimeEnv.DB.prepare(REQUEST_LOCK_TABLE_SQL).run()
  await runtimeEnv.DB.prepare(RATE_LIMIT_TABLE_SQL).run()
  await runtimeEnv.DB.prepare('CREATE INDEX IF NOT EXISTS idx_api_rate_limits_expires_at ON api_rate_limits (expires_at)').run()
  await runtimeEnv.DB.prepare(`
    INSERT OR IGNORE INTO request_locks (id, owner, expires_at, updated_at)
    VALUES (?, NULL, 0, ?)
  `).bind(REQUEST_LOCK_ID, new Date().toISOString()).run()
}

async function acquireRequestLock(runtimeEnv, options = {}) {
  const waitMs = options.waitMs ?? LOCK_WAIT_MS
  const leaseMs = options.leaseMs ?? LOCK_LEASE_MS
  const sleep = options.sleep ?? delay
  const owner = `${Date.now()}-${randomBytes(12).toString('hex')}`
  const deadline = Date.now() + waitMs
  let retryMs = LOCK_RETRY_MIN_MS
  while (true) {
    const now = Date.now()
    const result = await runtimeEnv.DB.prepare(`
      UPDATE request_locks
      SET owner = ?, expires_at = ?, updated_at = ?
      WHERE id = ? AND (owner IS NULL OR expires_at <= ?)
    `).bind(owner, now + leaseMs, new Date(now).toISOString(), REQUEST_LOCK_ID, now).run()
    if (changes(result) === 1) break
    if (now >= deadline) throw new RequestLockTimeoutError(Math.max(1, Math.ceil(leaseMs / 1_000)))
    await sleep(Math.min(retryMs, Math.max(1, deadline - now)))
    retryMs = Math.min(LOCK_RETRY_MAX_MS, Math.ceil(retryMs * 1.5))
  }
  return {
    owner,
    async renew() {
      const now = Date.now()
      const result = await runtimeEnv.DB.prepare(`
        UPDATE request_locks SET expires_at = ?, updated_at = ? WHERE id = ? AND owner = ?
      `).bind(now + leaseMs, new Date(now).toISOString(), REQUEST_LOCK_ID, owner).run()
      if (changes(result) !== 1) throw new RequestLockLostError()
    },
    async assertOwned() {
      const row = await runtimeEnv.DB.prepare('SELECT owner, expires_at FROM request_locks WHERE id = ?')
        .bind(REQUEST_LOCK_ID)
        .first()
      if (row?.owner !== owner || Number(row.expires_at) <= Date.now()) throw new RequestLockLostError()
    },
    async release() {
      await runtimeEnv.DB.prepare(`
        UPDATE request_locks SET owner = NULL, expires_at = 0, updated_at = ? WHERE id = ? AND owner = ?
      `).bind(new Date().toISOString(), REQUEST_LOCK_ID, owner).run()
    },
  }
}

function startLockHeartbeat(lock, intervalMs = LOCK_HEARTBEAT_MS) {
  let stopped = false
  let heartbeatError = null
  let pending = Promise.resolve()
  const timer = setInterval(() => {
    if (stopped) return
    pending = pending.then(() => lock.renew()).catch((error) => { heartbeatError = error })
  }, intervalMs)
  return {
    async assertHealthy() {
      await pending
      if (heartbeatError) throw heartbeatError
      await lock.assertOwned()
    },
    async stop() {
      stopped = true
      clearInterval(timer)
      await pending
    },
  }
}

async function loadRuntimeState(runtimeEnv, seed) {
  let row = await runtimeEnv.DB.prepare('SELECT payload, revision FROM app_state WHERE id = ?').bind(STATE_ID).first()
  if (!row) {
    const initial = { workspaceStore: deploymentSeed(seed), sessions: [] }
    await runtimeEnv.DB.prepare(`
      INSERT OR IGNORE INTO app_state (id, payload, revision, updated_at) VALUES (?, ?, 1, ?)
    `).bind(STATE_ID, JSON.stringify(initial), new Date().toISOString()).run()
    row = await runtimeEnv.DB.prepare('SELECT payload, revision FROM app_state WHERE id = ?').bind(STATE_ID).first()
  }
  if (!row) throw new Error('배포 저장소를 초기화하지 못했습니다.')
  try {
    const parsed = JSON.parse(String(row.payload))
    return {
      workspaceStore: cloneSeed(parsed?.workspaceStore),
      sessions: Array.isArray(parsed?.sessions) ? parsed.sessions : [],
      revision: Number(row.revision) || 1,
    }
  } catch {
    throw new Error('배포 저장소의 데이터를 안전하게 읽지 못했습니다.')
  }
}

function serializeRuntimeState(workspaceStore, sessions) {
  return JSON.stringify({ workspaceStore, sessions: [...sessions.entries()] })
}

async function compareAndSwapState(runtimeEnv, payload, expectedRevision) {
  const result = await runtimeEnv.DB.prepare(`
    UPDATE app_state SET payload = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?
  `).bind(payload, new Date().toISOString(), STATE_ID, expectedRevision).run()
  return changes(result) === 1
}

async function consumeRateLimit(runtimeEnv, key, limit, windowMs, now) {
  const row = await runtimeEnv.DB.prepare('SELECT request_count, expires_at FROM api_rate_limits WHERE key = ?').bind(key).first()
  if (!row || Number(row.expires_at) <= now) {
    const expiresAt = now + windowMs
    await runtimeEnv.DB.prepare(`
      INSERT INTO api_rate_limits (key, request_count, expires_at, updated_at) VALUES (?, 1, ?, ?)
      ON CONFLICT(key) DO UPDATE SET request_count = 1, expires_at = excluded.expires_at, updated_at = excluded.updated_at
    `).bind(key, expiresAt, new Date(now).toISOString()).run()
    return { allowed: true, expiresAt }
  }
  const requestCount = Number(row.request_count) || 0
  if (requestCount >= limit) return { allowed: false, expiresAt: Number(row.expires_at) }
  await runtimeEnv.DB.prepare(`
    UPDATE api_rate_limits SET request_count = request_count + 1, updated_at = ? WHERE key = ?
  `).bind(new Date(now).toISOString(), key).run()
  return { allowed: true, expiresAt: Number(row.expires_at) }
}

async function enforceAuthRateLimit(runtimeEnv, request) {
  if (request.method !== 'POST') return null
  const pathname = new URL(request.url).pathname
  const policy = AUTH_RATE_LIMITS[pathname]
  if (!policy) return null
  const body = await request.clone().json().catch(() => ({}))
  const identity = pathname === '/api/auth/password-reset/confirm'
    ? String(body?.token ?? '')
    : String(body?.email ?? '').trim().toLowerCase()
  const address = clientAddress(request)
  const now = Date.now()
  await runtimeEnv.DB.prepare('DELETE FROM api_rate_limits WHERE expires_at <= ?').bind(now).run()
  const addressResult = await consumeRateLimit(runtimeEnv, `auth:${pathname}:address:${hashRateLimitKey(address)}`, policy.addressLimit, policy.windowMs, now)
  const identityResult = await consumeRateLimit(runtimeEnv, `auth:${pathname}:identity:${hashRateLimitKey(identity || 'missing')}`, policy.identityLimit, policy.windowMs, now)
  if (addressResult.allowed && identityResult.allowed) return null
  const retryAfter = Math.max(1, Math.ceil((Math.max(addressResult.expiresAt, identityResult.expiresAt) - now) / 1_000))
  return Response.json(
    { error: { code: 'AUTH_RATE_LIMITED', message: '인증 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' } },
    { status: 429, headers: { 'Retry-After': String(retryAfter) } },
  )
}

function findDocument(workspaceStore, id) {
  for (const [tenantId, tenantStore] of Object.entries(workspaceStore.tenants ?? {})) {
    const documents = tenantStore?.['company-documents']?.data
    if (!Array.isArray(documents)) continue
    const document = documents.find((item) => item?.id === id)
    if (document) return { tenantId, document }
  }
  return null
}

function findPlatformEvidence(workspaceStore, id) {
  const ticket = workspaceStore.platform?.supportTickets?.find((item) => item?.evidence?.id === id)
  return ticket?.evidence ? { ticket, evidence: ticket.evidence } : null
}

function documentFilePath(documentDirectory, tenantId, id) {
  return path.join(documentDirectory, tenantId, `${id}.bin`)
}

async function hydrateDocument(runtimeEnv, workspaceStore, documentDirectory, id) {
  const found = findDocument(workspaceStore, id)
  if (!found) return
  const filePath = documentFilePath(documentDirectory, found.tenantId, id)
  if (existsSync(filePath)) return
  const object = await runtimeEnv.FILES.get(`documents/${found.tenantId}/${id}.bin`)
  if (!object) return
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, Buffer.from(await object.arrayBuffer()), { mode: 0o600 })
}

async function hydratePlatformEvidence(runtimeEnv, workspaceStore, documentDirectory, id) {
  const found = findPlatformEvidence(workspaceStore, id)
  if (!found) return
  const filePath = path.join(documentDirectory, '_platform', `${id}.bin`)
  if (existsSync(filePath)) return
  const object = await runtimeEnv.FILES.get(`platform/${id}.bin`)
  if (!object) return
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, Buffer.from(await object.arrayBuffer()), { mode: 0o600 })
}

async function hydrateRequestReferences(runtimeEnv, workspaceStore, documentDirectory, request) {
  const url = new URL(request.url)
  const documentRoute = url.pathname.match(/^\/api\/documents\/(DOC-[^/]+)(?:\/download)?$/)
  if (documentRoute) await hydrateDocument(runtimeEnv, workspaceStore, documentDirectory, decodeURIComponent(documentRoute[1]))
  const evidenceRoute = url.pathname.match(/^\/api\/platform\/tickets\/[^/]+\/evidence$/)
  if (evidenceRoute) {
    const ticketId = decodeURIComponent(url.pathname.split('/')[4] ?? '')
    const ticket = workspaceStore.platform?.supportTickets?.find((item) => item?.id === ticketId)
    if (ticket?.evidence?.id) await hydratePlatformEvidence(runtimeEnv, workspaceStore, documentDirectory, ticket.evidence.id)
  }
  if (!['POST', 'PUT', 'PATCH'].includes(request.method)) return
  if (!String(request.headers.get('content-type') ?? '').includes('application/json')) return
  const text = await request.clone().text()
  const ids = [...new Set(text.match(/DOC-[A-Za-z0-9-]+/g) ?? [])]
  await Promise.all(ids.slice(0, 20).map((id) => hydrateDocument(runtimeEnv, workspaceStore, documentDirectory, id)))
}

async function captureR2Object(bucket, key) {
  const object = await bucket.get(key)
  if (!object) return null
  return {
    bytes: Buffer.from(await object.arrayBuffer()),
    httpMetadata: object.httpMetadata,
    customMetadata: object.customMetadata,
  }
}

async function restoreR2Object(bucket, key, snapshot) {
  if (!snapshot) {
    await bucket.delete(key)
    return
  }
  await bucket.put(key, snapshot.bytes, {
    ...(snapshot.httpMetadata ? { httpMetadata: snapshot.httpMetadata } : {}),
    ...(snapshot.customMetadata ? { customMetadata: snapshot.customMetadata } : {}),
  })
}

function emptyBinaryPlan() {
  return { hasMutation: false, rollbackBeforeCommit: async () => {}, commitAfterState: async () => {} }
}

async function stagedR2Put(bucket, key, bytes, metadata) {
  const previous = await captureR2Object(bucket, key)
  try {
    await bucket.put(key, bytes, metadata)
  } catch (error) {
    try { await restoreR2Object(bucket, key, previous) } catch { /* preserve original error */ }
    throw error
  }
  return async () => restoreR2Object(bucket, key, previous)
}

async function prepareBinaryMutation(runtimeEnv, documentDirectory, request, response, beforeWorkspaceStore, afterWorkspaceStore) {
  if (!response.ok) return emptyBinaryPlan()
  const url = new URL(request.url)
  if (request.method === 'POST' && url.pathname === '/api/documents') {
    const body = await response.clone().json().catch(() => null)
    const id = body?.document?.id
    const found = id ? findDocument(afterWorkspaceStore, id) : null
    if (!found) throw new Error('업로드된 문서 메타데이터를 찾지 못했습니다.')
    const filePath = documentFilePath(documentDirectory, found.tenantId, id)
    if (!existsSync(filePath)) throw new Error('업로드된 문서 원본을 찾지 못했습니다.')
    const key = `documents/${found.tenantId}/${id}.bin`
    const rollbackBeforeCommit = await stagedR2Put(runtimeEnv.FILES, key, readFileSync(filePath), {
      httpMetadata: { contentType: found.document.mime || 'application/octet-stream' },
      customMetadata: { name: found.document.originalName || found.document.name },
    })
    return { hasMutation: true, rollbackBeforeCommit, commitAfterState: async () => {} }
  }
  const documentRoute = url.pathname.match(/^\/api\/documents\/(DOC-[^/]+)$/)
  if (request.method === 'DELETE' && documentRoute) {
    const id = decodeURIComponent(documentRoute[1])
    const found = findDocument(beforeWorkspaceStore, id)
    if (!found) return emptyBinaryPlan()
    const key = `documents/${found.tenantId}/${id}.bin`
    const previous = await captureR2Object(runtimeEnv.FILES, key)
    return {
      hasMutation: true,
      rollbackBeforeCommit: async () => {},
      async commitAfterState() {
        try {
          await runtimeEnv.FILES.delete(key)
        } catch (error) {
          try { await restoreR2Object(runtimeEnv.FILES, key, previous) } catch { /* preserve deletion failure */ }
          throw error
        }
      },
    }
  }
  if (request.method === 'POST' && url.pathname === '/api/platform/tickets') {
    const body = await response.clone().json().catch(() => null)
    const evidence = body?.ticket?.evidence
    if (!evidence?.id) return emptyBinaryPlan()
    const filePath = path.join(documentDirectory, '_platform', `${evidence.id}.bin`)
    if (!existsSync(filePath)) throw new Error('업로드된 CS 증빙 원본을 찾지 못했습니다.')
    const key = `platform/${evidence.id}.bin`
    const rollbackBeforeCommit = await stagedR2Put(runtimeEnv.FILES, key, readFileSync(filePath), {
      httpMetadata: { contentType: evidence.mime || 'application/octet-stream' },
      customMetadata: { name: evidence.name || 'evidence' },
    })
    return { hasMutation: true, rollbackBeforeCommit, commitAfterState: async () => {} }
  }
  return emptyBinaryPlan()
}

async function bufferResponse(response, requestMethod) {
  const noBody = requestMethod === 'HEAD' || [101, 204, 205, 304].includes(response.status)
  const body = noBody ? null : await response.arrayBuffer()
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}

async function closeExpressServer(server) {
  if (!server || typeof server.close !== 'function') return
  await new Promise((resolve, reject) => {
    try { server.close((error) => error ? reject(error) : resolve()) } catch (error) { reject(error) }
  })
}

export function createSitesWorker(dependencies = {}) {
  const runtimeEnv = dependencies.env ?? cloudflareEnv
  const createApplication = dependencies.createApp ?? createExpressApp
  const createHttpHandler = dependencies.httpServerHandler ?? cloudflareHttpServerHandler
  const workspaceSeed = dependencies.initialWorkspaceSeed ?? currentWorkspaceSeed
  const documentDirectory = dependencies.documentDirectory ?? DOCUMENT_DIRECTORY
  const expressPort = dependencies.expressPort ?? EXPRESS_PORT
  const lockOptions = dependencies.lockOptions ?? {}
  let schemaPromise
  const ensureSchema = () => {
    schemaPromise ??= ensureRuntimeTables(runtimeEnv).catch((error) => {
      schemaPromise = undefined
      throw error
    })
    return schemaPromise
  }

  return {
    async fetch(request, workerEnv, ctx) {
      const pathname = new URL(request.url).pathname
      if (!pathname.startsWith('/api/')) {
        if (runtimeEnv.ASSETS?.fetch) return runtimeEnv.ASSETS.fetch(request)
        return new Response('Not found', { status: 404 })
      }
      let lock
      let heartbeat
      let expressServer
      let binaryPlan = emptyBinaryPlan()
      try {
        const seedPassword = validSeedPassword(runtimeEnv)
        await ensureSchema()
        lock = await acquireRequestLock(runtimeEnv, lockOptions)
        heartbeat = startLockHeartbeat(lock, lockOptions.heartbeatMs ?? LOCK_HEARTBEAT_MS)
        const limited = await enforceAuthRateLimit(runtimeEnv, request)
        if (limited) return limited

        const snapshot = await loadRuntimeState(runtimeEnv, workspaceSeed)
        const workspaceStore = snapshot.workspaceStore
        const sessions = new Map(snapshot.sessions)
        const beforePayload = serializeRuntimeState(workspaceStore, sessions)
        const beforeWorkspaceStore = structuredClone(workspaceStore)
        let workspaceDirty = false
        const app = createApplication({
          initialWorkspaceStore: workspaceStore,
          sessions,
          distDirectory: '/tmp/onfactory-static',
          documentUploadDirectory: documentDirectory,
          apiKey: runtimeEnv.ANTHROPIC_API_KEY,
          model: runtimeEnv.CLAUDE_MODEL,
          seedPassword,
          requireSeedPasswordChange: true,
          exposePasswordResetTokens: false,
          onWorkspaceStoreChange: () => { workspaceDirty = true },
        })
        expressServer = app.listen(expressPort)
        const expressHandler = createHttpHandler({ port: expressPort })
        await hydrateRequestReferences(runtimeEnv, workspaceStore, documentDirectory, request)
        const rawResponse = await expressHandler.fetch(request, workerEnv, ctx)
        const response = await bufferResponse(rawResponse, request.method)
        binaryPlan = await prepareBinaryMutation(runtimeEnv, documentDirectory, request, response, beforeWorkspaceStore, workspaceStore)
        const afterPayload = serializeRuntimeState(workspaceStore, sessions)
        const stateChanged = workspaceDirty || afterPayload !== beforePayload
        if (binaryPlan.hasMutation && !stateChanged) {
          await binaryPlan.rollbackBeforeCommit()
          return Response.json({ error: { code: 'FILE_STATE_MISMATCH', message: '첨부파일 메타데이터를 함께 저장하지 못했습니다.' } }, { status: 500 })
        }

        await heartbeat.assertHealthy()
        let committedRevision = snapshot.revision
        if (stateChanged) {
          let stored
          try { stored = await compareAndSwapState(runtimeEnv, afterPayload, snapshot.revision) }
          catch (error) { await binaryPlan.rollbackBeforeCommit(); throw error }
          if (!stored) {
            await binaryPlan.rollbackBeforeCommit()
            await loadRuntimeState(runtimeEnv, workspaceSeed)
            return Response.json({ error: { code: 'STATE_CONFLICT', message: '다른 사용자의 변경을 반영했습니다. 요청을 다시 실행해 주세요.' } }, { status: 409 })
          }
          committedRevision += 1
        }

        try { await binaryPlan.commitAfterState() }
        catch {
          let stateRestored = !stateChanged
          if (stateChanged) stateRestored = await compareAndSwapState(runtimeEnv, beforePayload, committedRevision)
          if (!stateRestored) console.error('[sites-worker] Failed to compensate state after R2 mutation failure')
          return Response.json({ error: { code: 'FILE_PERSIST_FAILED', message: '첨부파일 저장을 완료하지 못해 변경사항을 복원했습니다.' } }, { status: 500 })
        }
        return response
      } catch (error) {
        if (error instanceof RuntimeConfigurationError) {
          return Response.json(
            { error: { code: 'SERVER_CONFIGURATION_ERROR', message: '배포 인증 secret이 설정되지 않아 API를 안전하게 중단했습니다.' } },
            { status: 503 },
          )
        }
        if (error instanceof RequestLockTimeoutError) {
          return Response.json(
            { error: { code: 'REQUEST_BUSY', message: '다른 요청을 저장하고 있습니다. 잠시 후 다시 시도해 주세요.' } },
            { status: 503, headers: { 'Retry-After': String(error.retryAfterSeconds) } },
          )
        }
        if (error instanceof RequestLockLostError) {
          try { await binaryPlan.rollbackBeforeCommit() } catch { /* best effort R2 compensation */ }
          return Response.json({ error: { code: 'STATE_LOCK_LOST', message: '저장 잠금이 만료되어 요청을 안전하게 중단했습니다.' } }, { status: 409 })
        }
        console.error('[sites-worker]', { message: error?.message, stack: error?.stack })
        return Response.json({ error: { code: 'WORKER_ERROR', message: '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.' } }, { status: 500 })
      } finally {
        try { await closeExpressServer(expressServer) } catch (error) { console.error('[sites-worker] Express shutdown failed', { message: error?.message }) }
        try { await heartbeat?.stop() } catch (error) { console.error('[sites-worker] Lock heartbeat failed', { message: error?.message }) }
        try { await lock?.release() } catch (error) { console.error('[sites-worker] Lock release failed', { message: error?.message }) }
      }
    },
  }
}

export default createSitesWorker()

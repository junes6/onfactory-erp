import { randomBytes } from 'node:crypto'

const PERSONAL_TODO_KEY = 'personal-todos'
const MAX_TODOS_PER_TENANT = 10_000
const MAX_TODOS_PER_OWNER = 500
const MAX_TITLE_LENGTH = 180
const VALID_PRIORITIES = new Set(['low', 'normal', 'high'])

const validIsoUtc = (value) => typeof value === 'string'
  && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value

function seoulDate(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value)
  const part = (type) => parts.find((entry) => entry.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

function seoulEndOfDayIso(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const instant = new Date(`${date}T23:59:59.999+09:00`)
  return Number.isFinite(instant.getTime()) ? instant.toISOString() : null
}

function normalizeSource(value) {
  if (value == null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const kind = String(value.kind ?? '').trim()
  const id = String(value.id ?? '').trim()
  const action = String(value.action ?? '').trim()
  if (!['work-item', 'daily-journal'].includes(kind) || !id || id.length > 160 || !action || action.length > 80) return null
  return { kind, id, action }
}

export function normalizePersonalTodo(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const id = String(value.id ?? '').trim()
  const ownerId = String(value.ownerId ?? '').trim()
  const title = String(value.title ?? '').trim()
  const status = ['open', 'completed', 'dismissed'].includes(value.status) ? value.status : null
  const origin = value.origin === 'ai' ? 'ai' : value.origin === 'manual' ? 'manual' : null
  const priority = VALID_PRIORITIES.has(value.priority) ? value.priority : null
  const dueAt = value.dueAt == null || value.dueAt === '' ? null : String(value.dueAt).trim()
  const completedAt = value.completedAt == null || value.completedAt === '' ? null : String(value.completedAt).trim()
  const createdAt = String(value.createdAt ?? '').trim()
  const updatedAt = String(value.updatedAt ?? '').trim()
  const source = value.source == null ? null : normalizeSource(value.source)
  const reason = value.reason == null ? '' : String(value.reason).trim()
  const automationEnabled = typeof value.automationEnabled === 'boolean' ? value.automationEnabled : origin === 'ai'
  if (!id || id.length > 120 || !ownerId || ownerId.length > 120 || !title || title.length > MAX_TITLE_LENGTH
    || !status || !origin || !priority || (dueAt && !validIsoUtc(dueAt))
    || (completedAt && !validIsoUtc(completedAt)) || (status === 'completed') !== Boolean(completedAt)
    || !validIsoUtc(createdAt) || !validIsoUtc(updatedAt) || (value.source != null && !source)
    || reason.length > 240) return null
  return { id, ownerId, title, status, origin, priority, dueAt, completedAt, createdAt, updatedAt, source, reason, automationEnabled }
}

function normalizePersonalTodos(value) {
  if (!Array.isArray(value) || value.length > MAX_TODOS_PER_TENANT) return null
  const todos = value.map(normalizePersonalTodo)
  if (todos.some((todo) => !todo)) return null
  if (new Set(todos.map((todo) => todo.id)).size !== todos.length) return null
  return todos
}

function workspaceRecordVersion(record) {
  return record?.updatedAt && Array.isArray(record?.data)
    ? `${record.updatedAt}:${record.data.length}`
    : 'empty'
}

function sourceKey(source) {
  return source ? `${source.kind}:${source.id}:${source.action}` : ''
}

function uniqueLegacyName(auth, accounts) {
  return accounts.filter((account) => account?.tenantId === auth.tenantId && account?.approved && account?.name === auth.name).length === 1
}

function ownsWorkItem(item, auth, allowLegacyName) {
  return item?.ownerId === auth.id || (allowLegacyName && !item?.ownerId && item?.owner === auth.name)
}

function requestsWorkItem(item, auth, allowLegacyName) {
  return item?.requesterId === auth.id || (allowLegacyName && !item?.requesterId && item?.requestedBy === auth.name)
}

function ownsJournal(journal, auth, allowLegacyName) {
  return journal?.authorId === auth.id || (allowLegacyName && !journal?.authorId && journal?.author === auth.name)
}

function aiCandidates(tenantStore, auth, now, accounts) {
  const candidates = []
  const allowLegacyName = uniqueLegacyName(auth, accounts)
  const workItems = Array.isArray(tenantStore?.['work-items']?.data) ? tenantStore['work-items'].data : []
  for (const item of workItems) {
    if (!item?.id || !item?.title || item.status === '결재완료') continue
    if (item.status === '결재대기' && requestsWorkItem(item, auth, allowLegacyName)) {
      candidates.push({
        title: `확인하기 · ${String(item.title).trim()}`,
        dueAt: validIsoUtc(item.due) ? item.due : null,
        priority: item.priority === '긴급' ? 'high' : 'normal',
        source: { kind: 'work-item', id: item.id, action: 'approve' },
        reason: '내 확인을 기다리는 업무에서 자동 등록',
      })
    } else if (ownsWorkItem(item, auth, allowLegacyName)) {
      candidates.push({
        title: String(item.title).trim(),
        dueAt: validIsoUtc(item.due) ? item.due : null,
        priority: item.priority === '긴급' || item.priority === '높음' ? 'high' : 'normal',
        source: { kind: 'work-item', id: item.id, action: 'execute' },
        reason: '나에게 배정된 업무에서 자동 등록',
      })
    }
  }

  const date = seoulDate(now)
  const journals = Array.isArray(tenantStore?.['daily-journals']?.data) ? tenantStore['daily-journals'].data : []
  const journal = journals.find((item) => item?.date === date && ownsJournal(item, auth, allowLegacyName))
  if (!journal || ['임시저장', '반려'].includes(journal.status)) {
    candidates.push({
      title: journal?.status === '반려' ? '오늘 업무일지 보완해서 다시 내기' : '오늘 업무일지 작성하기',
      dueAt: seoulEndOfDayIso(date),
      priority: journal?.status === '반려' ? 'high' : 'normal',
      source: { kind: 'daily-journal', id: date, action: 'submit' },
      reason: journal?.status === '반려' ? '보완이 필요한 오늘 업무일지에서 자동 등록' : '오늘 업무일지가 없어 자동 등록',
    })
  }
  return candidates
}

function sourceIsComplete(todo, tenantStore, auth, accounts) {
  if (!todo.source || todo.automationEnabled !== true) return false
  const allowLegacyName = uniqueLegacyName(auth, accounts)
  if (todo.source.kind === 'work-item') {
    const workItems = Array.isArray(tenantStore?.['work-items']?.data) ? tenantStore['work-items'].data : []
    const item = workItems.find((entry) => entry?.id === todo.source.id)
    return item?.status === '결재완료'
  }
  if (todo.source.kind === 'daily-journal') {
    const journals = Array.isArray(tenantStore?.['daily-journals']?.data) ? tenantStore['daily-journals'].data : []
    const journal = journals.find((entry) => entry?.date === todo.source.id && ownsJournal(entry, auth, allowLegacyName))
    return ['결재요청', '승인'].includes(journal?.status)
  }
  return false
}

export function registerPersonalTodoRoutes({
  app,
  requireAuth,
  requireMatchingWorkspaceIdentity,
  workspaceStore,
  accounts,
  commitWorkspaceStore,
  clock = () => new Date(),
}) {
  const guards = [requireAuth, requireMatchingWorkspaceIdentity]

  const requireTenantStore = (request, response) => {
    if (!request.auth?.tenantId) {
      response.status(403).json({ error: { code: 'TENANT_REQUIRED', message: '고객사 워크스페이스에서만 개인 할 일을 사용할 수 있습니다.' } })
      return null
    }
    const tenantStore = workspaceStore.tenants?.[request.auth.tenantId] ?? {}
    const stored = tenantStore[PERSONAL_TODO_KEY]?.data ?? []
    const todos = normalizePersonalTodos(stored)
    if (!todos) {
      response.status(500).json({ error: { code: 'PERSONAL_TODO_DATA_INVALID', message: '개인 할 일 형식이 올바르지 않아 안전하게 처리하지 않았습니다.' } })
      return null
    }
    return { tenantStore, todos }
  }

  const visibleTodos = (todos, auth) => todos
    .filter((todo) => todo.ownerId === auth.id && todo.status !== 'dismissed')
    .sort((left, right) => {
      if (left.status !== right.status) return left.status === 'open' ? -1 : 1
      if (left.priority !== right.priority) return ({ high: 0, normal: 1, low: 2 })[left.priority] - ({ high: 0, normal: 1, low: 2 })[right.priority]
      return String(left.dueAt ?? '9999').localeCompare(String(right.dueAt ?? '9999')) || right.createdAt.localeCompare(left.createdAt)
    })

  const commitTodos = async (auth, tenantStore, previousRecord, todos) => {
    const normalized = normalizePersonalTodos(todos)
    const ownerCounts = new Map()
    if (!normalized) throw new Error('PERSONAL_TODO_LIMIT_REACHED')
    for (const todo of normalized) ownerCounts.set(todo.ownerId, (ownerCounts.get(todo.ownerId) ?? 0) + 1)
    if ([...ownerCounts.values()].some((count) => count > MAX_TODOS_PER_OWNER)) throw new Error('PERSONAL_TODO_LIMIT_REACHED')
    const now = clock().toISOString()
    const record = { data: normalized, updatedAt: now, updatedBy: auth.id }
    tenantStore[PERSONAL_TODO_KEY] = record
    workspaceStore.tenants[auth.tenantId] = tenantStore
    try {
      await commitWorkspaceStore()
      return record
    } catch (error) {
      if (previousRecord) tenantStore[PERSONAL_TODO_KEY] = previousRecord
      else delete tenantStore[PERSONAL_TODO_KEY]
      throw error
    }
  }

  app.get('/api/personal-todos', ...guards, (request, response) => {
    const state = requireTenantStore(request, response)
    if (!state) return
    response.json({ items: visibleTodos(state.todos, request.auth), version: workspaceRecordVersion(state.tenantStore[PERSONAL_TODO_KEY]) })
  })

  app.post('/api/personal-todos', ...guards, async (request, response) => {
    const state = requireTenantStore(request, response)
    if (!state) return
    const title = String(request.body?.title ?? '').trim()
    const priority = VALID_PRIORITIES.has(request.body?.priority) ? request.body.priority : 'normal'
    const dueAt = request.body?.dueAt == null || request.body.dueAt === '' ? null : String(request.body.dueAt).trim()
    if (!title || title.length > MAX_TITLE_LENGTH || (dueAt && !validIsoUtc(dueAt))) {
      response.status(400).json({ error: { code: 'PERSONAL_TODO_INVALID', message: '할 일은 180자 이내로 입력하고 마감일을 확인해 주세요.' } })
      return
    }
    if (state.todos.length >= MAX_TODOS_PER_TENANT || state.todos.filter((todo) => todo.ownerId === request.auth.id).length >= MAX_TODOS_PER_OWNER) {
      response.status(409).json({ error: { code: 'PERSONAL_TODO_LIMIT_REACHED', message: '완료하거나 필요 없는 할 일을 정리한 뒤 다시 추가해 주세요.' } })
      return
    }
    const now = clock().toISOString()
    const todo = {
      id: `TODO-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString('hex').toUpperCase()}`,
      ownerId: request.auth.id,
      title,
      status: 'open',
      origin: 'manual',
      priority,
      dueAt,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
      source: null,
      reason: '',
      automationEnabled: false,
    }
    try {
      const previousRecord = state.tenantStore[PERSONAL_TODO_KEY]
      const record = await commitTodos(request.auth, state.tenantStore, previousRecord, [todo, ...state.todos])
      response.status(201).json({ item: todo, items: visibleTodos([todo, ...state.todos], request.auth), version: workspaceRecordVersion(record) })
    } catch {
      response.status(500).json({ error: { code: 'PERSONAL_TODO_WRITE_FAILED', message: '할 일을 저장하지 못했습니다.' } })
    }
  })

  app.patch('/api/personal-todos/:id', ...guards, async (request, response) => {
    const state = requireTenantStore(request, response)
    if (!state) return
    const index = state.todos.findIndex((todo) => todo.id === request.params.id && todo.ownerId === request.auth.id)
    if (index < 0) {
      response.status(404).json({ error: { code: 'PERSONAL_TODO_NOT_FOUND', message: '내 할 일에서 해당 항목을 찾을 수 없습니다.' } })
      return
    }
    const previous = state.todos[index]
    const next = { ...previous }
    let changed = false
    if (Object.prototype.hasOwnProperty.call(request.body ?? {}, 'title')) {
      const title = String(request.body.title ?? '').trim()
      if (!title || title.length > MAX_TITLE_LENGTH) {
        response.status(400).json({ error: { code: 'PERSONAL_TODO_INVALID', message: '할 일은 180자 이내로 입력해 주세요.' } })
        return
      }
      next.title = title
      changed ||= title !== previous.title
    }
    if (Object.prototype.hasOwnProperty.call(request.body ?? {}, 'priority')) {
      if (!VALID_PRIORITIES.has(request.body.priority)) {
        response.status(400).json({ error: { code: 'PERSONAL_TODO_INVALID', message: '우선순위를 확인해 주세요.' } })
        return
      }
      next.priority = request.body.priority
      changed ||= next.priority !== previous.priority
    }
    if (Object.prototype.hasOwnProperty.call(request.body ?? {}, 'dueAt')) {
      const dueAt = request.body.dueAt == null || request.body.dueAt === '' ? null : String(request.body.dueAt).trim()
      if (dueAt && !validIsoUtc(dueAt)) {
        response.status(400).json({ error: { code: 'PERSONAL_TODO_INVALID', message: '마감일 형식을 확인해 주세요.' } })
        return
      }
      next.dueAt = dueAt
      changed ||= dueAt !== previous.dueAt
    }
    if (Object.prototype.hasOwnProperty.call(request.body ?? {}, 'completed')) {
      if (typeof request.body.completed !== 'boolean') {
        response.status(400).json({ error: { code: 'PERSONAL_TODO_INVALID', message: '완료 상태를 확인해 주세요.' } })
        return
      }
      next.status = request.body.completed ? 'completed' : 'open'
      next.completedAt = request.body.completed ? clock().toISOString() : null
      if (next.origin === 'ai') next.automationEnabled = false
      changed ||= next.status !== previous.status
    }
    if (!changed) {
      response.json({ item: previous, items: visibleTodos(state.todos, request.auth), version: workspaceRecordVersion(state.tenantStore[PERSONAL_TODO_KEY]) })
      return
    }
    next.updatedAt = clock().toISOString()
    const nextTodos = state.todos.map((todo, todoIndex) => todoIndex === index ? next : todo)
    try {
      const previousRecord = state.tenantStore[PERSONAL_TODO_KEY]
      const record = await commitTodos(request.auth, state.tenantStore, previousRecord, nextTodos)
      response.json({ item: next, items: visibleTodos(nextTodos, request.auth), version: workspaceRecordVersion(record) })
    } catch {
      response.status(500).json({ error: { code: 'PERSONAL_TODO_WRITE_FAILED', message: '할 일을 수정하지 못했습니다.' } })
    }
  })

  app.delete('/api/personal-todos/:id', ...guards, async (request, response) => {
    const state = requireTenantStore(request, response)
    if (!state) return
    const found = state.todos.find((todo) => todo.id === request.params.id && todo.ownerId === request.auth.id && todo.status !== 'dismissed')
    if (!found) {
      response.status(404).json({ error: { code: 'PERSONAL_TODO_NOT_FOUND', message: '내 할 일에서 해당 항목을 찾을 수 없습니다.' } })
      return
    }
    const nextTodos = found.origin === 'ai' && found.source
      ? state.todos.map((todo) => todo.id === found.id ? { ...todo, status: 'dismissed', completedAt: null, updatedAt: clock().toISOString(), automationEnabled: false, reason: '사용자가 AI 자동 항목을 삭제함' } : todo)
      : state.todos.filter((todo) => !(todo.id === request.params.id && todo.ownerId === request.auth.id))
    try {
      const previousRecord = state.tenantStore[PERSONAL_TODO_KEY]
      const record = await commitTodos(request.auth, state.tenantStore, previousRecord, nextTodos)
      response.json({ deletedId: request.params.id, items: visibleTodos(nextTodos, request.auth), version: workspaceRecordVersion(record) })
    } catch {
      response.status(500).json({ error: { code: 'PERSONAL_TODO_WRITE_FAILED', message: '할 일을 삭제하지 못했습니다.' } })
    }
  })

  app.post('/api/personal-todos/ai-sync', ...guards, async (request, response) => {
    const state = requireTenantStore(request, response)
    if (!state) return
    const instant = clock()
    const now = instant.toISOString()
    let created = 0
    let completed = 0
    let nextTodos = state.todos.map((todo) => {
      if (todo.ownerId !== request.auth.id || todo.status !== 'open' || todo.origin !== 'ai' || !sourceIsComplete(todo, state.tenantStore, request.auth, accounts)) return todo
      completed += 1
      return { ...todo, status: 'completed', completedAt: now, updatedAt: now, reason: '연결된 원본 업무가 완료되어 자동 체크' }
    })
    const existingSources = new Set(nextTodos.filter((todo) => todo.ownerId === request.auth.id).map((todo) => sourceKey(todo.source)).filter(Boolean))
    const ownerCount = nextTodos.filter((todo) => todo.ownerId === request.auth.id).length
    const createLimit = Math.max(0, Math.min(MAX_TODOS_PER_OWNER - ownerCount, MAX_TODOS_PER_TENANT - nextTodos.length))
    for (const candidate of aiCandidates(state.tenantStore, request.auth, instant, accounts).slice(0, createLimit)) {
      const key = sourceKey(candidate.source)
      if (existingSources.has(key)) continue
      existingSources.add(key)
      created += 1
      nextTodos.unshift({
        id: `TODO-AI-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString('hex').toUpperCase()}`,
        ownerId: request.auth.id,
        title: candidate.title.slice(0, MAX_TITLE_LENGTH),
        status: 'open',
        origin: 'ai',
        priority: candidate.priority,
        dueAt: candidate.dueAt,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
        source: candidate.source,
        reason: candidate.reason,
        automationEnabled: true,
      })
    }
    if (!created && !completed) {
      response.json({ items: visibleTodos(state.todos, request.auth), changes: { created, completed }, version: workspaceRecordVersion(state.tenantStore[PERSONAL_TODO_KEY]) })
      return
    }
    try {
      const previousRecord = state.tenantStore[PERSONAL_TODO_KEY]
      const record = await commitTodos(request.auth, state.tenantStore, previousRecord, nextTodos)
      response.json({ items: visibleTodos(nextTodos, request.auth), changes: { created, completed }, version: workspaceRecordVersion(record) })
    } catch {
      response.status(500).json({ error: { code: 'PERSONAL_TODO_SYNC_FAILED', message: 'AI 자동 정리를 저장하지 못했습니다.' } })
    }
  })
}

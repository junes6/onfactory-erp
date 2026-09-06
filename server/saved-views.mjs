import { randomBytes } from 'node:crypto'

import { GUEST_ROLE, GUEST_SCOPE_FORBIDDEN } from './guest-access.mjs'
import { CUSTOM_FIELD_KEY_PATTERN } from './custom-fields.mjs'

/**
 * 저장된 보기 — 보기 방식(목록·보드·캘린더·타임라인)과 필터·정렬·보조줄을 한 이름으로 묶는다.
 *
 * 왜 전용 라우트인가: 이 배열에는 행마다 주인이 있다('내 것' 또는 '전사 공유'). generic
 * PUT /api/workspace/:key에는 행 단위 소유권 개념이 없어 직원 하나가 배열 전체를 덮어쓸 수 있다.
 * 그래서 WORKSPACE_STORE_KEYS에 넣지 않았고, generic GET/PUT은 코드 한 줄 없이
 * 404 STORE_KEY_NOT_FOUND로 끝난다(ai-conversations가 이미 같은 상태다).
 *
 * 왜 미지 키를 버리지 않고 거절하는가: 저장된 보기는 사람이 이름 붙여 공유하는 산출물이다.
 * '저장했다'고 말해 놓고 조건 하나를 조용히 버리면 그 보기는 거짓말을 한다. 어느 칸이
 * 문제인지(path)까지 함께 돌려주어 화면이 그 자리를 가리킬 수 있게 한다.
 *
 * 왜 전사 공유는 관리자만인가: 보기 이름과 filters.ownerIds·projectIds는 사람·프로젝트의
 * 열거원이다. 서버의 행 필터(isMemberWorkItem)가 데이터는 막지만 이름은 막지 못한다.
 * 직원이 잃는 것은 '남에게 보이게 하기' 하나뿐이고 개인 보기 50개는 그대로다.
 *
 * 가시성 안전성: 저장된 보기는 **필터일 뿐**이고 서버의 행 필터가 언제나 먼저 적용된다.
 * 공유 보기가 남의 업무를 보이게 만들 수는 없다(saved-views.test.mjs가 고정한다).
 */

export const SAVED_VIEW_KEY = 'saved-views'
const MAX_VIEWS_PER_TENANT = 2_000
const MAX_VIEWS_PER_OWNER = 50
const MAX_NAME_LENGTH = 40
const MAX_FILTER_VALUES = 20
const MAX_TEXT_LENGTH = 80
const MAX_VALUE_LENGTH = 120
const MAX_COLUMNS = 3
const MAX_FIELD_FILTERS = 10
const MAX_DUE_WITHIN_DAYS = 365

export const SAVED_VIEW_SURFACES = new Set(['work', 'document', 'file', 'opportunity'])
/**
 * 표면별로 지원하는 보기. 서버가 이 표를 갖는 이유: 지원하지 않는 모드를 저장해 두면
 * 화면이 조용히 다른 모드로 떨어지고, 사람은 그것을 '저장이 안 됐다'고 읽는다.
 * document·file·opportunity가 list 하나뿐인 것은 상태축이 없기 때문이다 —
 * 상태축이 없는 목록에 보드를 만들지 않는다.
 */
const SURFACE_MODES = Object.freeze({
  work: ['list', 'board', 'calendar', 'timeline'],
  document: ['list'],
  file: ['list'],
  opportunity: ['list'],
})
export const SAVED_VIEW_SORT_FIELDS = new Set(['due', 'startAt', 'priority', 'title', 'owner', 'status', 'createdAt'])
/** 보조줄에 무엇을 이어 넣을지. 표의 열이 아니다 — 한 줄 원칙(DECISIONS.md)을 깨지 않는다. */
export const SAVED_VIEW_COLUMNS = new Set(['owner', 'project', 'parent', 'category', 'priority', 'startAt', 'origin'])
export const SAVED_VIEW_VISIBILITIES = new Set(['private', 'tenant'])
const SCOPES = new Set(['all', 'mine', 'requested'])
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const CF_PREFIX = 'cf:'

/** 본문이 정할 수 있는 것은 이 일곱뿐. id·ownerId·createdAt 같은 출처는 서버가 채운다. */
const EDITABLE_KEYS = ['surface', 'name', 'mode', 'filters', 'sort', 'columns', 'visibility']
const FILTER_KEYS = [
  'scope', 'ownerIds', 'statuses', 'priorities', 'categories', 'projectIds', 'originKinds',
  'dueFrom', 'dueTo', 'dueWithinDays', 'overdueOnly', 'hasParent', 'text', 'fields',
]

export const SAVED_VIEW_ERRORS = Object.freeze({
  INVALID: { code: 'SAVED_VIEW_INVALID', message: '보기 설정을 확인해 주세요.' },
  MODE_UNSUPPORTED: { code: 'SAVED_VIEW_MODE_UNSUPPORTED', message: '이 화면에서는 지원하지 않는 보기 방식입니다.' },
  SHARE_FORBIDDEN: { code: 'SAVED_VIEW_SHARE_FORBIDDEN', message: '전사 공유 보기는 관리자만 만들 수 있습니다. 나만 보기로 저장한 뒤 관리자에게 공유를 요청하세요.' },
  FORBIDDEN: { code: 'SAVED_VIEW_FORBIDDEN', message: '전사 공유 보기는 만든 사람이나 관리자만 바꿀 수 있습니다.' },
  NOT_FOUND: { code: 'SAVED_VIEW_NOT_FOUND', message: '저장된 보기를 찾을 수 없습니다.' },
  LIMIT: { code: 'SAVED_VIEW_LIMIT_REACHED', message: `저장된 보기는 한 사람당 ${MAX_VIEWS_PER_OWNER}개까지 만들 수 있습니다. 쓰지 않는 보기를 지워 주세요.` },
  // 두 상한은 다른 사실이다. 회사 상한에 걸린 사람에게 '한 사람당 50개'라고 답하면
  // 자기 보기가 세 개뿐인 사람은 무엇을 지워야 할지 알 수 없고, 다 지워도 저장되지 않는다.
  TENANT_LIMIT: { code: 'SAVED_VIEW_TENANT_LIMIT_REACHED', message: `이 회사에 저장된 보기가 상한(${MAX_VIEWS_PER_TENANT}개)에 도달했습니다. 관리자에게 정리를 요청하세요.` },
  WRITE_FAILED: { code: 'SAVED_VIEW_WRITE_FAILED', message: '저장된 보기를 저장하지 못했습니다.' },
})

const invalid = (path) => ({ ...SAVED_VIEW_ERRORS.INVALID, path })

/** 문자열 목록 하나. 상한을 넘거나 빈 값이 섞이면 null(형식 오류). */
function stringList(value, max = MAX_FILTER_VALUES, maxLength = MAX_VALUE_LENGTH) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > max) return null
  const list = value.map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
  if (list.some((entry) => !entry || entry.length > maxLength)) return null
  return [...new Set(list)]
}

/** 닫힌 enum 목록. 값 하나라도 표 밖이면 null — 조용히 버리면 저장한 보기가 다른 뜻이 된다. */
function enumList(value, allowed) {
  const list = stringList(value)
  if (!list) return null
  return list.every((entry) => allowed.has(entry)) ? list : null
}

/** 커스텀 필드 축 하나. select 다중값 · number {min,max} · date {from,to} 세 형태뿐. */
function fieldFilter(value) {
  if (Array.isArray(value)) return stringList(value)
  if (!value || typeof value !== 'object') return null
  const keys = Object.keys(value)
  if (keys.length === 0 || keys.length > 2) return null
  if (keys.every((key) => key === 'min' || key === 'max')) {
    if (keys.some((key) => typeof value[key] !== 'number' || !Number.isFinite(value[key]))) return null
    return { ...(value.min !== undefined ? { min: value.min } : {}), ...(value.max !== undefined ? { max: value.max } : {}) }
  }
  if (keys.every((key) => key === 'from' || key === 'to')) {
    if (keys.some((key) => typeof value[key] !== 'string' || !DATE_PATTERN.test(value[key]))) return null
    return { ...(value.from !== undefined ? { from: value.from } : {}), ...(value.to !== undefined ? { to: value.to } : {}) }
  }
  return null
}

/** 통과하면 { filters }, 아니면 { path }. 미지 키는 버리지 않고 그 자리를 이름으로 돌려준다. */
export function normalizeSavedViewFilters(value, { statuses, priorities }) {
  if (value == null) return { filters: emptyFilters() }
  if (typeof value !== 'object' || Array.isArray(value)) return { path: 'filters' }
  const unknown = Object.keys(value).find((key) => !FILTER_KEYS.includes(key))
  if (unknown) return { path: `filters.${unknown}` }

  const filters = emptyFilters()
  if (value.scope !== undefined) {
    if (!SCOPES.has(value.scope)) return { path: 'filters.scope' }
    filters.scope = value.scope
  }
  for (const [key, allowed] of [['statuses', statuses], ['priorities', priorities]]) {
    if (value[key] === undefined) continue
    const list = enumList(value[key], allowed)
    if (!list) return { path: `filters.${key}` }
    filters[key] = list
  }
  for (const key of ['ownerIds', 'categories', 'projectIds', 'originKinds']) {
    if (value[key] === undefined) continue
    const list = stringList(value[key], MAX_FILTER_VALUES, key === 'categories' ? 40 : MAX_VALUE_LENGTH)
    if (!list) return { path: `filters.${key}` }
    filters[key] = list
  }
  for (const key of ['dueFrom', 'dueTo']) {
    if (value[key] === undefined || value[key] === null || value[key] === '') continue
    if (typeof value[key] !== 'string' || !DATE_PATTERN.test(value[key])) return { path: `filters.${key}` }
    filters[key] = value[key]
  }
  if (value.dueWithinDays !== undefined && value.dueWithinDays !== null) {
    const days = value.dueWithinDays
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 0 || days > MAX_DUE_WITHIN_DAYS) return { path: 'filters.dueWithinDays' }
    filters.dueWithinDays = days
  }
  if (value.overdueOnly !== undefined) {
    if (typeof value.overdueOnly !== 'boolean') return { path: 'filters.overdueOnly' }
    filters.overdueOnly = value.overdueOnly
  }
  if (value.hasParent !== undefined && value.hasParent !== null) {
    if (typeof value.hasParent !== 'boolean') return { path: 'filters.hasParent' }
    filters.hasParent = value.hasParent
  }
  if (value.text !== undefined && value.text !== null) {
    if (typeof value.text !== 'string' || value.text.length > MAX_TEXT_LENGTH) return { path: 'filters.text' }
    filters.text = value.text
  }
  if (value.fields !== undefined && value.fields !== null) {
    const fields = value.fields
    if (typeof fields !== 'object' || Array.isArray(fields)) return { path: 'filters.fields' }
    const entries = Object.entries(fields)
    if (entries.length > MAX_FIELD_FILTERS) return { path: 'filters.fields' }
    for (const [key, entry] of entries) {
      if (!CUSTOM_FIELD_KEY_PATTERN.test(key)) return { path: `filters.fields.${key}` }
      const normalized = fieldFilter(entry)
      if (!normalized) return { path: `filters.fields.${key}` }
      filters.fields[key] = normalized
    }
  }
  return { filters }
}

const emptyFilters = () => ({
  scope: 'all', ownerIds: [], statuses: [], priorities: [], categories: [], projectIds: [], originKinds: [],
  dueFrom: null, dueTo: null, dueWithinDays: null, overdueOnly: false, hasParent: null, text: '', fields: {},
})

/** 정렬 축 하나. 고정 목록이거나 `cf:<key>` 패턴. */
const validSortField = (field) => (
  SAVED_VIEW_SORT_FIELDS.has(field) || (field.startsWith(CF_PREFIX) && CUSTOM_FIELD_KEY_PATTERN.test(field.slice(CF_PREFIX.length)))
)
const validColumn = (column) => (
  SAVED_VIEW_COLUMNS.has(column) || (column.startsWith(CF_PREFIX) && CUSTOM_FIELD_KEY_PATTERN.test(column.slice(CF_PREFIX.length)))
)

/**
 * 본문 → 저장할 보기의 편집 가능한 부분. 통과하면 { value }, 아니면 { error }.
 * id·ownerId·createdAt은 여기서 만들지 않는다 — 출처는 요청이 정하지 않는다.
 */
export function normalizeSavedViewInput(body, { statuses, priorities }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: invalid('body') }
  const unknown = Object.keys(body).find((key) => !EDITABLE_KEYS.includes(key))
  if (unknown) return { error: invalid(unknown) }

  const surface = String(body.surface ?? 'work')
  if (!SAVED_VIEW_SURFACES.has(surface)) return { error: invalid('surface') }
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name || name.length > MAX_NAME_LENGTH) return { error: invalid('name') }
  const mode = String(body.mode ?? 'list')
  if (!SURFACE_MODES.work.includes(mode)) return { error: invalid('mode') }
  // 모드 자체는 아는 값인데 이 표면이 못 그리는 경우는 다른 문장으로 답한다 — 오타가 아니라 조합의 문제다.
  if (!SURFACE_MODES[surface].includes(mode)) return { error: SAVED_VIEW_ERRORS.MODE_UNSUPPORTED }
  const visibility = String(body.visibility ?? 'private')
  if (!SAVED_VIEW_VISIBILITIES.has(visibility)) return { error: invalid('visibility') }

  const { filters, path } = normalizeSavedViewFilters(body.filters, { statuses, priorities })
  if (path) return { error: invalid(path) }

  let sort = { field: 'due', direction: 'asc' }
  if (body.sort !== undefined && body.sort !== null) {
    const value = body.sort
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: invalid('sort') }
    if (Object.keys(value).some((key) => key !== 'field' && key !== 'direction')) return { error: invalid('sort') }
    const field = String(value.field ?? 'due')
    if (!validSortField(field)) return { error: invalid('sort.field') }
    const direction = String(value.direction ?? 'asc')
    if (direction !== 'asc' && direction !== 'desc') return { error: invalid('sort.direction') }
    sort = { field, direction }
  }

  const columns = stringList(body.columns, MAX_COLUMNS, 60)
  if (!columns) return { error: invalid('columns') }
  if (columns.some((column) => !validColumn(column))) return { error: invalid('columns') }

  return { value: { surface, name, mode, filters, sort, columns, visibility } }
}

/** 저장된 한 줄을 읽는다. 못 읽으면 null. */
export function normalizeSavedView(value, { statuses, priorities }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const id = String(value.id ?? '').trim()
  const ownerId = String(value.ownerId ?? '').trim()
  const ownerName = String(value.ownerName ?? '').trim()
  const createdAt = String(value.createdAt ?? '').trim()
  const updatedAt = String(value.updatedAt ?? '').trim()
  const editable = normalizeSavedViewInput({
    surface: value.surface, name: value.name, mode: value.mode, filters: value.filters,
    sort: value.sort, columns: value.columns, visibility: value.visibility,
  }, { statuses, priorities })
  if (!id || id.length > 120 || !ownerId || !createdAt || !updatedAt || editable.error) return null
  return { id, ...editable.value, ownerId, ownerName, createdAt, updatedAt }
}

const newViewId = () => `VIEW-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString('hex').toUpperCase()}`

export function registerSavedViewRoutes({
  app, requireAuth, requireMatchingWorkspaceIdentity, workspaceStore, commitWorkspaceStore,
  workspaceRecordVersion, statuses, priorities, clock = () => new Date(),
}) {
  const guards = [requireAuth, requireMatchingWorkspaceIdentity]
  const enums = { statuses, priorities }
  /** 같은 고객사의 깨진 줄을 매 요청마다 다시 적지 않는다. */
  const warned = new Set()

  /**
   * 읽을 수 없는 줄이 하나 있다고 그 고객사의 저장된 보기 전체를 잠그지 않는다.
   *
   * 500으로 답하면 GET·POST·PATCH·DELETE가 전부 막히고, 문제의 줄을 지울 길이 앱 안에 없어진다 —
   * 복원·부분 이관·다음 절의 스키마 변경이 한 줄만 깨뜨려도 되돌릴 방법이 없는 막다른 길이다.
   * 그래서 못 읽는 줄은 작업 집합에서 빼고(같은 파일의 definitionMap이 이미 그렇게 한다),
   * **쓰기에서는 원본 그대로 다시 실어 보낸다** — 읽지 못한 것을 지우는 것은 더 나쁜 답이다.
   */
  const requireTenantStore = (request, response) => {
    if (!request.auth?.tenantId) {
      response.status(403).json({ error: { code: 'TENANT_REQUIRED', message: '고객사 워크스페이스에서만 사용할 수 있습니다.' } })
      return null
    }
    if (request.auth.role === GUEST_ROLE) {
      response.status(403).json({ error: GUEST_SCOPE_FORBIDDEN })
      return null
    }
    const tenantStore = workspaceStore.tenants[request.auth.tenantId] ?? {}
    const stored = Array.isArray(tenantStore[SAVED_VIEW_KEY]?.data) ? tenantStore[SAVED_VIEW_KEY].data : []
    const views = []
    const unreadable = []
    for (const raw of stored) {
      const view = normalizeSavedView(raw, enums)
      if (view) views.push(view)
      else unreadable.push(raw)
    }
    if (unreadable.length && !warned.has(request.auth.tenantId)) {
      warned.add(request.auth.tenantId)
      console.warn('[saved-views] Skipped unreadable rows', { tenantId: request.auth.tenantId, count: unreadable.length })
    }
    return { tenantStore, views, unreadable }
  }

  /** 보이는 집합 = 내 것 또는 전사 공유. 서버가 거른다 — 화면 필터에 기대지 않는다. */
  const visibleTo = (views, auth, surface) => views
    .filter((view) => view.surface === surface && (view.ownerId === auth.id || view.visibility === 'tenant'))
    .sort((left, right) => (
      (left.visibility === 'tenant' ? 0 : 1) - (right.visibility === 'tenant' ? 0 : 1)
      || left.name.localeCompare(right.name, 'ko')
      || left.id.localeCompare(right.id)
    ))

  /** kept = 읽지 못해 작업 집합에서 뺀 원본 줄. 함께 다시 써야 이번 쓰기가 그 줄을 조용히 지우지 않는다. */
  const commitViews = async (auth, tenantStore, previousRecord, views, kept = []) => {
    const now = clock().toISOString()
    const record = { data: [...kept, ...views], updatedAt: now, updatedBy: auth.id }
    tenantStore[SAVED_VIEW_KEY] = record
    workspaceStore.tenants[auth.tenantId] = tenantStore
    try {
      await commitWorkspaceStore()
      return record
    } catch (error) {
      if (previousRecord) tenantStore[SAVED_VIEW_KEY] = previousRecord
      else delete tenantStore[SAVED_VIEW_KEY]
      throw error
    }
  }

  app.get('/api/saved-views', ...guards, (request, response) => {
    const state = requireTenantStore(request, response)
    if (!state) return
    const surface = String(request.query?.surface ?? 'work')
    if (!SAVED_VIEW_SURFACES.has(surface)) {
      response.status(400).json({ error: invalid('surface') })
      return
    }
    response.json({
      items: visibleTo(state.views, request.auth, surface),
      version: workspaceRecordVersion(state.tenantStore[SAVED_VIEW_KEY]),
    })
  })

  app.post('/api/saved-views', ...guards, async (request, response) => {
    const state = requireTenantStore(request, response)
    if (!state) return
    const parsed = normalizeSavedViewInput(request.body, enums)
    if (parsed.error) {
      response.status(400).json({ error: parsed.error })
      return
    }
    if (parsed.value.visibility === 'tenant' && request.auth.role !== 'tenant-admin') {
      response.status(403).json({ error: SAVED_VIEW_ERRORS.SHARE_FORBIDDEN })
      return
    }
    // 두 상한은 다른 사실이고 다른 답을 요구한다 — 회사 상한에 걸린 사람은 자기 보기를 다 지워도 저장할 수 없다.
    if (state.views.length + state.unreadable.length >= MAX_VIEWS_PER_TENANT) {
      response.status(409).json({ error: SAVED_VIEW_ERRORS.TENANT_LIMIT })
      return
    }
    const mine = state.views.filter((view) => view.ownerId === request.auth.id).length
    if (mine >= MAX_VIEWS_PER_OWNER) {
      response.status(409).json({ error: SAVED_VIEW_ERRORS.LIMIT })
      return
    }
    const now = clock().toISOString()
    // 출처는 세션이 정한다 — 본문의 ownerId는 위 미지 키 검사에서 이미 400이 된다.
    const view = { id: newViewId(), ...parsed.value, ownerId: request.auth.id, ownerName: request.auth.name ?? '', createdAt: now, updatedAt: now }
    const nextViews = [...state.views, view]
    try {
      const previousRecord = state.tenantStore[SAVED_VIEW_KEY]
      const record = await commitViews(request.auth, state.tenantStore, previousRecord, nextViews, state.unreadable)
      // 읽은 줄만 목록에 싣는다 — record.data에는 못 읽은 원본이 섞여 있고, 그것을 정렬하면 여기서 터진다.
      response.status(201).json({ item: view, items: visibleTo(nextViews, request.auth, view.surface), version: workspaceRecordVersion(record) })
    } catch (error) {
      console.error('[saved-views] Failed to persist view', { message: error?.message })
      response.status(500).json({ error: SAVED_VIEW_ERRORS.WRITE_FAILED })
    }
  })

  /**
   * 남의 private 보기는 404(GET에도 안 보이므로 존재를 알리지 않는다),
   * 남의 tenant 보기는 403(GET에는 보이므로 404를 내면 거짓말이 된다).
   */
  const findForWrite = (state, request, response) => {
    const view = state.views.find((candidate) => candidate.id === request.params.id)
    const isAdmin = request.auth.role === 'tenant-admin'
    if (!view || (view.ownerId !== request.auth.id && view.visibility !== 'tenant')) {
      response.status(404).json({ error: SAVED_VIEW_ERRORS.NOT_FOUND })
      return null
    }
    if (view.ownerId !== request.auth.id && !isAdmin) {
      response.status(403).json({ error: SAVED_VIEW_ERRORS.FORBIDDEN })
      return null
    }
    return view
  }

  app.patch('/api/saved-views/:id', ...guards, async (request, response) => {
    const state = requireTenantStore(request, response)
    if (!state) return
    const previous = findForWrite(state, request, response)
    if (!previous) return
    const parsed = normalizeSavedViewInput({ ...pickEditable(previous), ...(request.body ?? {}) }, enums)
    if (parsed.error) {
      response.status(400).json({ error: parsed.error })
      return
    }
    // 공유로 올리는 것도 만드는 것과 같은 행위다 — 같은 게이트를 지난다.
    if (parsed.value.visibility === 'tenant' && previous.visibility !== 'tenant' && request.auth.role !== 'tenant-admin') {
      response.status(403).json({ error: SAVED_VIEW_ERRORS.SHARE_FORBIDDEN })
      return
    }
    const next = { ...previous, ...parsed.value, updatedAt: clock().toISOString() }
    const nextViews = state.views.map((view) => view.id === next.id ? next : view)
    try {
      const previousRecord = state.tenantStore[SAVED_VIEW_KEY]
      const record = await commitViews(request.auth, state.tenantStore, previousRecord, nextViews, state.unreadable)
      response.json({ item: next, items: visibleTo(nextViews, request.auth, next.surface), version: workspaceRecordVersion(record) })
    } catch (error) {
      console.error('[saved-views] Failed to persist view change', { message: error?.message })
      response.status(500).json({ error: SAVED_VIEW_ERRORS.WRITE_FAILED })
    }
  })

  app.delete('/api/saved-views/:id', ...guards, async (request, response) => {
    const state = requireTenantStore(request, response)
    if (!state) return
    const previous = findForWrite(state, request, response)
    if (!previous) return
    const nextViews = state.views.filter((view) => view.id !== previous.id)
    try {
      const previousRecord = state.tenantStore[SAVED_VIEW_KEY]
      const record = await commitViews(request.auth, state.tenantStore, previousRecord, nextViews, state.unreadable)
      response.json({ deletedId: previous.id, items: visibleTo(nextViews, request.auth, previous.surface), version: workspaceRecordVersion(record) })
    } catch (error) {
      console.error('[saved-views] Failed to delete view', { message: error?.message })
      response.status(500).json({ error: SAVED_VIEW_ERRORS.WRITE_FAILED })
    }
  })
}

/** PATCH는 부분 갱신이다 — 기존 값을 바닥에 깔고 본문을 덮는다. */
function pickEditable(view) {
  return Object.fromEntries(EDITABLE_KEYS.map((key) => [key, view[key]]))
}

import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import { GUEST_ROLE, GUEST_SCOPE_FORBIDDEN } from './guest-access.mjs'

/**
 * 업무 커스텀 필드 — 관리자가 정의하고, 값은 업무 payload의 fields 안에 산다.
 *
 * 왜 정의와 값을 나누는가: 정의는 회사가 한 번 정하는 어휘(50개 상한)이고 값은 업무마다 다르다.
 * 값을 이 테이블에 같이 두면 업무 하나를 읽을 때마다 두 배열을 맞춰야 하고, 업무를 지울 때
 * 값 행이 남는다. 반대로 정의를 업무 안에 두면 라벨을 고칠 때 1,000행을 고쳐야 한다.
 *
 * 왜 타입이 다섯인가(text·number·select·date·person): 'file'을 넣지 않은 것은 우연이 아니다.
 * linkedDocumentIds(server/app.mjs)는 attachments[].id·completion.evidence[].id 같은 하드코딩된
 * 경로만 훑으므로, fields 안의 DOC- id는 canReferenceDocuments의 권한 검사를 받지 않고
 * documentIsReferenced가 그 참조를 보지 못해 '아직 쓰이는 문서가 삭제 가능'해진다.
 * 파일 타입을 열려면 그 두 함수의 키 목록을 함께 고쳐야 한다.
 *
 * 왜 key·type·surface가 불변인가: 값은 fields[key]로 저장돼 있다. key를 바꾸면 최대 1,000행의 값이
 * 한 번에 고아가 되고, type을 바꾸면 이미 저장된 값이 정의와 어긋나 그 업무의 모든 저장이 400이 되는
 * 막다른 길이 생긴다. 바꾸려면 새 필드를 만들고 옛 필드를 보관한다.
 */

export const CUSTOM_FIELD_KEY = 'custom-fields'
const WORK_ITEM_KEY = 'work-items'

export const MAX_DEFINITIONS = 50
/** 한 업무의 fields 키 개수. 정의 개수(50)와 별개다 — 정의를 늘려도 한 업무가 지고 갈 무게는 따로 잡는다. */
export const MAX_WORK_FIELD_KEYS = 30
const MAX_LABEL = 20
const MAX_OPTIONS = 20
const MAX_OPTION_LENGTH = 40
const MAX_TEXT_VALUE = 200

/** 키는 payload의 JSON 키가 된다 — 대문자·한글·공백을 받으면 저장 경로마다 다르게 정규화될 여지가 생긴다. */
export const CUSTOM_FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/
export const CUSTOM_FIELD_TYPES = new Set(['text', 'number', 'select', 'date', 'person'])
export const CUSTOM_FIELD_SURFACES = new Set(['work'])

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export const CUSTOM_FIELD_ERRORS = Object.freeze({
  INVALID: { code: 'CUSTOM_FIELD_INVALID', message: '항목 정의 형식을 확인해 주세요.' },
  KEY_INVALID: { code: 'CUSTOM_FIELD_KEY_INVALID', message: '필드 키는 영문 소문자로 시작하고 소문자·숫자·밑줄만 쓸 수 있습니다(40자 이내).' },
  KEY_DUPLICATE: { code: 'CUSTOM_FIELD_KEY_DUPLICATE', message: '같은 필드 키가 이미 있습니다. 보관 처리된 필드의 키도 다시 쓸 수 없습니다.' },
  KEY_IMMUTABLE: { code: 'CUSTOM_FIELD_KEY_IMMUTABLE', message: '필드 키는 바꿀 수 없습니다. 새 항목을 만들고 기존 항목을 보관해 주세요.' },
  TYPE_IMMUTABLE: { code: 'CUSTOM_FIELD_TYPE_IMMUTABLE', message: '항목 형식은 바꿀 수 없습니다. 새 항목을 만들고 기존 항목을 보관해 주세요.' },
  NOT_FOUND: { code: 'CUSTOM_FIELD_NOT_FOUND', message: '항목 정의를 찾을 수 없습니다.' },
  LIMIT: { code: 'CUSTOM_FIELD_LIMIT_REACHED', message: `업무 추가 항목은 ${MAX_DEFINITIONS}개까지 만들 수 있습니다. 쓰지 않는 항목을 보관해 주세요.` },
  IN_USE: { code: 'CUSTOM_FIELD_IN_USE', message: '이 항목의 값을 가진 업무가 있어 삭제할 수 없습니다. 보관 처리하면 기존 값은 남고 새 입력만 막힙니다.' },
  // 이미 보관한 항목에 '보관하세요'라고 답하면, 관리자가 이미 한 일을 다시 시키는 문장이 된다.
  // 코드는 같다 — 화면의 처리도 상태 코드도 같고 다음에 할 일만 다르다(app.mjs의 DOCUMENT_IN_USE 두 문장과 같은 선례).
  IN_USE_ARCHIVED: { code: 'CUSTOM_FIELD_IN_USE', message: '이 항목의 값을 가진 업무가 있어 삭제할 수 없습니다. 보관을 해제하고 그 업무들에서 값을 비운 뒤 삭제해 주세요.' },
  OPTION_IN_USE: { code: 'CUSTOM_FIELD_OPTION_IN_USE', message: '이미 쓰이고 있는 선택지는 지울 수 없습니다. 그 값을 쓰는 업무를 먼저 바꿔 주세요.' },
  WRITE_FAILED: { code: 'CUSTOM_FIELD_WRITE_FAILED', message: '항목 정의를 저장하지 못했습니다.' },
  // 값 대조 — customFieldViolation과 /fields가 함께 쓴다. 한 문장이 두 문에서 같은 말을 해야 한다.
  UNKNOWN: { code: 'CUSTOM_FIELD_UNKNOWN', message: '관리자가 정의하지 않은 항목입니다. 항목 관리에서 먼저 만들어 주세요.' },
  ARCHIVED: { code: 'CUSTOM_FIELD_ARCHIVED', message: '보관 처리된 항목에는 새 값을 넣을 수 없습니다.' },
  VALUE_TYPE: { code: 'CUSTOM_FIELD_TYPE', message: '항목 형식에 맞지 않는 값입니다.' },
  OPTION: { code: 'CUSTOM_FIELD_OPTION', message: '선택지에 없는 값입니다.' },
  PERSON: { code: 'CUSTOM_FIELD_PERSON', message: '이 회사의 구성원만 사람 항목에 넣을 수 있습니다.' },
  REQUIRED: { code: 'CUSTOM_FIELD_REQUIRED', message: '입력이 필요한 항목의 값은 비울 수 없습니다.' },
})

export const WORK_FIELD_ERRORS = Object.freeze({
  INVALID: { code: 'WORK_FIELD_INVALID', message: '추가 정보 형식을 확인해 주세요.' },
  // 상한 두 가지는 '형식을 확인해 주세요' 하나로 답하면 사람이 무엇을 고쳐야 하는지 알 수 없다.
  // 어느 칸인지(key)는 다른 거절과 같은 자리에 싣고, 숫자는 문장 안에 넣는다.
  VALUE_TOO_LONG: { code: 'WORK_FIELD_VALUE_TOO_LONG', message: `추가 정보의 글자 값은 ${MAX_TEXT_VALUE}자까지 넣을 수 있습니다.` },
  LIMIT: { code: 'WORK_FIELD_LIMIT_REACHED', message: `한 업무에 채울 수 있는 추가 항목은 ${MAX_WORK_FIELD_KEYS}개까지입니다. 쓰지 않는 값을 비워 주세요.` },
  FORBIDDEN: { code: 'WORK_FIELD_FORBIDDEN', message: '이 업무의 담당자나 지시한 사람만 추가 정보를 채울 수 있습니다.' },
  LOCKED: { code: 'WORK_FIELD_LOCKED', message: '완료 보고한 업무의 추가 정보는 바꿀 수 없습니다.' },
  WRITE_FAILED: { code: 'WORK_FIELD_WRITE_FAILED', message: '추가 정보를 저장하지 못했습니다.' },
})

/** 값을 채울 수 없는 상태. 완료 보고가 올라간 뒤에 근거가 바뀌면 결재자가 본 것과 다른 것이 남는다. */
export const WORK_FIELD_CLOSED_STATUSES = Object.freeze(['결재대기', '결재완료'])

/**
 * 순수 형태 검사 — 정의 목록도 store도 모른다.
 *
 * hasWorkItemShape는 여섯 곳(관리자 PUT·직원 PUT·전이 재검증·/parent·/schedule·승인 큐)에서 불리고
 * store 인자가 없다. 여기에 정의 대조를 넣으면 canMemberReplaceWorkItems가 이전 배열의 항목까지
 * 재검증하므로, 정의를 바꾼 뒤 옛 값을 가진 기존 업무 하나 때문에 아무 저장도 못 하는 막다른 길이 생긴다.
 *
 * 값 타입은 string | number 둘뿐이다. '지우기'는 null을 **보내는 것**이고 결과는 **키 삭제**다 —
 * 이렇게 해야 '값 없음'이 한 가지뿐이고(startAt과 같은 규율), structuredClone·JSON 직렬화 경로에서
 * undefined가 사라지는 함정도 닫힌다.
 */
export function hasWorkFieldValuesShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  if (keys.length > MAX_WORK_FIELD_KEYS) return false
  return keys.every((key) => {
    if (!CUSTOM_FIELD_KEY_PATTERN.test(key)) return false
    const entry = value[key]
    if (typeof entry === 'string') return entry.length <= MAX_TEXT_VALUE
    if (typeof entry === 'number') return Number.isFinite(entry)
    return false
  })
}

/** 저장된 정의 한 줄을 읽는다. 못 읽으면 null — 부르는 쪽이 버릴지 500을 낼지 정한다. */
export function normalizeCustomFieldDefinition(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const id = String(value.id ?? '').trim()
  const surface = String(value.surface ?? '').trim()
  const key = String(value.key ?? '').trim()
  const label = String(value.label ?? '').trim()
  const type = String(value.type ?? '').trim()
  const required = value.required === true
  const position = Number.isFinite(value.position) ? Math.trunc(value.position) : 0
  const archivedAt = value.archivedAt == null || value.archivedAt === '' ? null : String(value.archivedAt).trim()
  const createdAt = String(value.createdAt ?? '').trim()
  const updatedAt = String(value.updatedAt ?? '').trim()
  const options = type === 'select' ? normalizeOptions(value.options) : []
  if (!id || id.length > 120 || !CUSTOM_FIELD_SURFACES.has(surface) || !CUSTOM_FIELD_KEY_PATTERN.test(key)
    || !label || label.length > MAX_LABEL || !CUSTOM_FIELD_TYPES.has(type) || !options
    || (type === 'select' && options.length === 0)
    || position < 0 || position > 1_000 || !createdAt || !updatedAt) return null
  return { id, surface, key, label, type, options, required, archivedAt, position, createdAt, updatedAt }
}

/** 선택지 목록. 중복·빈 값·상한 위반이면 null(형식 오류)이고, select가 아니면 빈 배열이다. */
function normalizeOptions(value) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > MAX_OPTIONS) return null
  const options = value.map((entry) => String(entry ?? '').trim())
  if (options.some((entry) => !entry || entry.length > MAX_OPTION_LENGTH)) return null
  if (new Set(options).size !== options.length) return null
  return options
}

/** 저장된 배열에서 읽을 수 있는 정의만 골라 key로 찾을 수 있게 한다. 못 읽는 줄은 없는 것으로 친다. */
function definitionMap(definitions) {
  const map = new Map()
  for (const raw of Array.isArray(definitions) ? definitions : []) {
    const definition = normalizeCustomFieldDefinition(raw)
    if (definition && !map.has(definition.key)) map.set(definition.key, definition)
  }
  return map
}

/** 정의와 값 하나를 맞춰 본다. 통과하면 null. */
function valueTypeViolation(definition, value, accounts, tenantId) {
  // 빈 문자열·공백만 있는 값은 '값'이 아니다. 받아 주면 '값 없음'이 두 가지가 되고(키 없음 / 빈 글자),
  // 화면에는 아무것도 안 보이는데 countFieldUsage는 1로 세어 그 정의를 영영 지울 수 없게 만든다.
  // /fields는 ''를 이 문 앞에서 '지우기'로 소비하므로, 여기 걸리는 것은 배열 PUT과 공백뿐이다.
  if (definition.type === 'text') return typeof value === 'string' && value.trim() !== '' ? null : CUSTOM_FIELD_ERRORS.VALUE_TYPE
  if (definition.type === 'number') return typeof value === 'number' && Number.isFinite(value) ? null : CUSTOM_FIELD_ERRORS.VALUE_TYPE
  if (definition.type === 'date') {
    if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return CUSTOM_FIELD_ERRORS.VALUE_TYPE
    // '2026-13-99'·'2026-02-31'은 정규식을 통과하지만 날짜가 아니다.
    return Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) ? null : CUSTOM_FIELD_ERRORS.VALUE_TYPE
  }
  if (definition.type === 'select') {
    if (typeof value !== 'string') return CUSTOM_FIELD_ERRORS.VALUE_TYPE
    return definition.options.includes(value) ? null : CUSTOM_FIELD_ERRORS.OPTION
  }
  // person: 같은 고객사의 계정이고 게스트가 아니어야 한다. 게스트를 사람 항목에 넣으면
  // 범위 밖 사람의 이름이 그 업무를 보는 모든 화면에 나타나는 첫 경로가 된다.
  if (typeof value !== 'string' || !value) return CUSTOM_FIELD_ERRORS.VALUE_TYPE
  const account = (accounts ?? []).find((candidate) => candidate?.id === value)
  return account && account.tenantId === tenantId && account.role !== GUEST_ROLE ? null : CUSTOM_FIELD_ERRORS.PERSON
}

/**
 * 배열 저장 직전의 정의 대조. 통과하면 null, 아니면 { code, message, itemId, key }.
 *
 * **기존** 값은 통과시키고 **새** 값만 판정한다(work-item-tree.mjs의 attachedNow와 같은 기법).
 * 무조건 통과시키면 배열 PUT으로 보관 항목에 새 값을 주입할 수 있고,
 * 무조건 막으면 옛 값을 가진 업무의 평범한 저장이 전부 실패한다.
 * 이 규칙은 보관뿐 아니라 네 판정 전부에 걸린다 — 정의가 사라지거나 사람 항목의 계정이 회사를 떠나면
 * 그 값 하나가 배열 전체의 저장을 영구히 막는다(값을 고칠 화면에 닿기 전에 PUT이 먼저 막힌다).
 *
 * required는 여기서 보지 않는다(적극적 결정). 정의를 required로 바꾼 순간 값이 없는 기존 업무 전부가
 * 저장 불가가 되고, 그 값을 채울 화면에 닿기 전에 배열 PUT이 통째로 막힌다. 또 반복 규칙 실체화는
 * shape 실패를 조용히 건너뛰고 승인 큐·AI 승격·템플릿 실체화도 커스텀 필드를 채우지 않으므로,
 * required를 저장 게이트로 만들면 그 네 경로의 업무가 오류 없이 사라진다.
 * required는 입력 시점 규칙이다 — /fields에서 '이미 있는 값을 비우기'만 막는다.
 */
export function customFieldViolation(nextItems, previousItems = [], definitions = [], accounts = [], tenantId = '') {
  const defs = definitionMap(definitions)
  const previousById = new Map((previousItems ?? []).map((item) => [item?.id, item]))
  for (const item of nextItems ?? []) {
    const fields = item?.fields
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) continue
    const before = previousById.get(item.id)?.fields
    for (const [key, value] of Object.entries(fields)) {
      // 이미 저장돼 있던 값은 이 문을 한 번 통과한 값이다. 그것을 다시 판정하면 정의 변경·구성원 이동이
      // 손대지도 않은 행 하나 때문에 배열 전체를 저장 불가로 만든다 — 화면에서 빠져나갈 길이 없는 막다른 길이다.
      // 새 값과 바뀐 값만 아래 세 문을 지난다.
      const unchanged = Boolean(before) && typeof before === 'object' && !Array.isArray(before)
        && Object.prototype.hasOwnProperty.call(before, key) && before[key] === value
      if (unchanged) continue
      const definition = defs.get(key)
      if (!definition) return { ...CUSTOM_FIELD_ERRORS.UNKNOWN, itemId: item.id ?? '', key }
      if (definition.archivedAt) return { ...CUSTOM_FIELD_ERRORS.ARCHIVED, itemId: item.id ?? '', key }
      const violation = valueTypeViolation(definition, value, accounts, tenantId)
      if (violation) return { ...violation, itemId: item.id ?? '', key }
    }
  }
  return null
}

/**
 * 이 키의 값을 가진 업무 수. 삭제·선택지 제거를 막을지 정하는 유일한 근거다.
 *
 * 빈 문자열은 세지 않는다: 화면에 그릴 것이 없는 값이 삭제를 막으면, 관리자에게는 지울 값이 보이지 않는데
 * 정의는 지워지지 않는 막다른 길이 된다. 새로 들어오는 ''는 valueTypeViolation이 이미 거절하지만,
 * 그 전에 저장된 줄이 남아 있을 수 있어 세는 쪽에서도 같은 판단을 한다(선택지는 빈 값일 수 없어 option 비교와 충돌하지 않는다).
 */
export function countFieldUsage(items, key, option) {
  let count = 0
  for (const item of Array.isArray(items) ? items : []) {
    const value = item?.fields?.[key]
    if (value === undefined || value === '') continue
    if (option === undefined || value === option) count += 1
  }
  return count
}

const newDefinitionId = () => `CF-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString('hex').toUpperCase()}`

/**
 * 정의 라우트 4개 + 값 라우트 1개.
 *
 * 왜 /fields 라우트가 따로 있어야 하는가: 'fields'를 WORK_ITEM_OPTIONAL_FIELDS에 올리는 순간
 * sameWorkItemExceptStatus가 직원의 generic PUT에서 이 필드 변경을 자동으로 403으로 만든다
 * (parentId가 이미 증명한 성질). 담당자가 자기 업무의 값을 채울 다른 길이 없어진다.
 *
 * 게스트 allowlist에는 넣지 않았으므로 게이트가 먼저 403을 낸다(여기 role 검사는 이중 방어).
 */
export function registerCustomFieldRoutes({
  app, requireAuth, requireTenantAdmin, requireMatchingWorkspaceIdentity, workspaceStore, accounts,
  operatorAwareAccounts, commitWorkspaceStore, events, hasWorkItemShape, workspaceRecordVersion, clock = () => new Date(),
}) {
  const guards = [requireAuth, requireMatchingWorkspaceIdentity]
  /**
   * 사람 항목의 계정 목록은 **한 함수에서만** 나온다.
   *
   * 배열 PUT(app.mjs)은 operatorAwareAccounts로 판정하는데 여기가 raw accounts를 보면,
   * 고객사에 들어간 플랫폼 운영자의 id가 한쪽에서는 통과하고 다른 쪽에서는 거절된다 —
   * 같은 질문에 두 답이 나오는 순간 어느 쪽이 규칙인지 아무도 모른다.
   */
  const accountsFor = (auth) => typeof operatorAwareAccounts === 'function' ? operatorAwareAccounts(auth) : accounts
  const adminGuards = [requireAuth, requireTenantAdmin, requireMatchingWorkspaceIdentity]
  /** 같은 고객사의 깨진 줄을 매 요청마다 다시 적지 않는다. */
  const warned = new Set()

  /**
   * 못 읽는 줄은 **없는 것으로 친다** — 이 파일의 definitionMap이 이미 같은 판단을 한다.
   *
   * 500으로 답하면 그 고객사의 GET·POST·PATCH·DELETE와 값 저장까지 전부 막히고,
   * 문제의 줄을 지울 길이 앱 안에 없어진다. 대신 쓰기에서는 원본 그대로 다시 실어 보낸다 —
   * 읽지 못한 것을 지우는 것은 더 나쁜 답이다.
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
    const stored = Array.isArray(tenantStore[CUSTOM_FIELD_KEY]?.data) ? tenantStore[CUSTOM_FIELD_KEY].data : []
    const definitions = []
    const unreadable = []
    for (const raw of stored) {
      const definition = normalizeCustomFieldDefinition(raw)
      if (definition) definitions.push(definition)
      else unreadable.push(raw)
    }
    if (unreadable.length && !warned.has(request.auth.tenantId)) {
      warned.add(request.auth.tenantId)
      console.warn('[custom-fields] Skipped unreadable rows', { tenantId: request.auth.tenantId, count: unreadable.length })
    }
    return { tenantStore, definitions, unreadable }
  }

  const workItemsOf = (tenantStore) => Array.isArray(tenantStore[WORK_ITEM_KEY]?.data) ? tenantStore[WORK_ITEM_KEY].data : []

  /** 화면 순서 = position → 만든 순. 두 관리자가 같은 자리를 줘도 목록이 흔들리지 않는다. */
  const ordered = (definitions) => [...definitions].sort((left, right) => (
    left.position - right.position || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  ))

  /** kept = 읽지 못해 작업 집합에서 뺀 원본 줄. 함께 다시 써야 이번 쓰기가 그 줄을 조용히 지우지 않는다. */
  const commitDefinitions = async (auth, tenantStore, previousRecord, definitions, kept = []) => {
    const now = clock().toISOString()
    const record = { data: [...kept, ...definitions], updatedAt: now, updatedBy: auth.id }
    tenantStore[CUSTOM_FIELD_KEY] = record
    workspaceStore.tenants[auth.tenantId] = tenantStore
    try {
      await commitWorkspaceStore()
      return record
    } catch (error) {
      if (previousRecord) tenantStore[CUSTOM_FIELD_KEY] = previousRecord
      else delete tenantStore[CUSTOM_FIELD_KEY]
      throw error
    }
  }

  app.get('/api/custom-fields', ...guards, (request, response) => {
    const state = requireTenantStore(request, response)
    if (!state) return
    const surface = String(request.query?.surface ?? 'work')
    if (!CUSTOM_FIELD_SURFACES.has(surface)) {
      response.status(400).json({ error: CUSTOM_FIELD_ERRORS.INVALID })
      return
    }
    // 보관된 정의도 내려보낸다 — 옛 값의 라벨을 그릴 곳이 화면에 있어야 한다.
    response.json({
      items: ordered(state.definitions.filter((definition) => definition.surface === surface)),
      version: workspaceRecordVersion(state.tenantStore[CUSTOM_FIELD_KEY]),
    })
  })

  app.post('/api/custom-fields', ...adminGuards, async (request, response) => {
    const state = requireTenantStore(request, response)
    if (!state) return
    const body = request.body
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      response.status(400).json({ error: CUSTOM_FIELD_ERRORS.INVALID })
      return
    }
    const key = String(body.key ?? '').trim()
    if (!CUSTOM_FIELD_KEY_PATTERN.test(key)) {
      response.status(400).json({ error: CUSTOM_FIELD_ERRORS.KEY_INVALID })
      return
    }
    // 보관분까지 통틀어 유일해야 한다: 보관된 정의의 key를 재사용하면 옛 payload 값이
    // 새 정의의 값처럼 되살아난다.
    if (state.definitions.some((definition) => definition.key === key)) {
      response.status(400).json({ error: CUSTOM_FIELD_ERRORS.KEY_DUPLICATE })
      return
    }
    if (state.definitions.length >= MAX_DEFINITIONS) {
      response.status(409).json({ error: CUSTOM_FIELD_ERRORS.LIMIT })
      return
    }
    const now = clock().toISOString()
    const definition = normalizeCustomFieldDefinition({
      id: newDefinitionId(),
      surface: body.surface ?? 'work',
      key,
      label: body.label,
      type: body.type,
      options: body.options,
      required: body.required,
      archivedAt: null,
      position: Number.isFinite(body.position) ? body.position : state.definitions.length,
      createdAt: now,
      updatedAt: now,
    })
    if (!definition) {
      response.status(400).json({ error: CUSTOM_FIELD_ERRORS.INVALID })
      return
    }
    const nextDefinitions = [...state.definitions, definition]
    try {
      const previousRecord = state.tenantStore[CUSTOM_FIELD_KEY]
      const record = await commitDefinitions(request.auth, state.tenantStore, previousRecord, nextDefinitions, state.unreadable)
      events.publish(request.auth.tenantId, 'work', { key: CUSTOM_FIELD_KEY })
      // 읽은 줄만 목록에 싣는다 — record.data에는 못 읽은 원본이 섞여 있고, 그것을 정렬하면 여기서 터진다.
      response.status(201).json({ item: definition, items: ordered(nextDefinitions), version: workspaceRecordVersion(record) })
    } catch (error) {
      console.error('[custom-fields] Failed to persist definition', { message: error?.message })
      response.status(500).json({ error: CUSTOM_FIELD_ERRORS.WRITE_FAILED })
    }
  })

  app.patch('/api/custom-fields/:id', ...adminGuards, async (request, response) => {
    const state = requireTenantStore(request, response)
    if (!state) return
    const body = request.body
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      response.status(400).json({ error: CUSTOM_FIELD_ERRORS.INVALID })
      return
    }
    const previous = state.definitions.find((definition) => definition.id === request.params.id)
    if (!previous) {
      response.status(404).json({ error: CUSTOM_FIELD_ERRORS.NOT_FOUND })
      return
    }
    // 실어 보냈는데 값이 다르면 조용히 무시하지 않고 이유를 말한다 — 무시하면 화면은 바꿨다고 믿는다.
    if (body.key !== undefined && String(body.key).trim() !== previous.key) {
      response.status(400).json({ error: CUSTOM_FIELD_ERRORS.KEY_IMMUTABLE })
      return
    }
    if (body.type !== undefined && String(body.type).trim() !== previous.type) {
      response.status(400).json({ error: CUSTOM_FIELD_ERRORS.TYPE_IMMUTABLE })
      return
    }
    if (body.surface !== undefined && String(body.surface).trim() !== previous.surface) {
      response.status(400).json({ error: CUSTOM_FIELD_ERRORS.INVALID })
      return
    }
    const has = (field) => Object.prototype.hasOwnProperty.call(body, field)
    const next = normalizeCustomFieldDefinition({
      ...previous,
      ...(has('label') ? { label: body.label } : {}),
      ...(has('options') ? { options: body.options } : {}),
      ...(has('required') ? { required: body.required === true } : {}),
      ...(has('position') ? { position: body.position } : {}),
      ...(has('archivedAt') ? { archivedAt: body.archivedAt ? clock().toISOString() : null } : {}),
      updatedAt: clock().toISOString(),
    })
    if (!next) {
      response.status(400).json({ error: CUSTOM_FIELD_ERRORS.INVALID })
      return
    }
    if (next.type === 'select') {
      const removed = previous.options.filter((option) => !next.options.includes(option))
      for (const option of removed) {
        const count = countFieldUsage(workItemsOf(state.tenantStore), previous.key, option)
        if (count > 0) {
          response.status(409).json({ error: { ...CUSTOM_FIELD_ERRORS.OPTION_IN_USE, option, count } })
          return
        }
      }
    }
    /**
     * 자리 번호는 **서버가 한 커밋에서 다시 매긴다**.
     *
     * 화면은 '한 칸 위'를 이웃의 자리 번호로 말할 뿐이고, 그 자리에 끼워 넣은 뒤 0..n-1을 새로 부여하는 것은
     * 여기다. 클라이언트가 ±1만 적어 보내면 이웃과 번호가 같아지고, 그때는 ordered()의 다음 기준(createdAt)이
     * 이겨서 목록이 한 칸도 움직이지 않는다. 두 번의 PATCH로 자리를 맞바꾸지 않는 이유는 그 사이에 실패하면
     * 순서가 반쯤 적용된 채로 남기 때문이다 — 한 쓰기에 딸린 일은 한 커밋에 함께 들어간다.
     */
    let committed = state.definitions.map((definition) => definition.id === next.id ? next : definition)
    let item = next
    if (has('position')) {
      const others = ordered(committed.filter((definition) => definition.surface === next.surface && definition.id !== next.id))
      others.splice(Math.max(0, Math.min(others.length, next.position)), 0, next)
      const seats = new Map(others.map((definition, index) => [definition.id, index]))
      committed = committed.map((definition) => {
        const seat = seats.get(definition.id)
        // 이웃의 updatedAt은 건드리지 않는다 — 자리 번호를 다시 매긴 것은 그 항목이 바뀐 일이 아니다.
        return seat === undefined || seat === definition.position ? definition : { ...definition, position: seat }
      })
      item = committed.find((definition) => definition.id === next.id) ?? next
    }
    try {
      const previousRecord = state.tenantStore[CUSTOM_FIELD_KEY]
      const record = await commitDefinitions(request.auth, state.tenantStore, previousRecord, committed, state.unreadable)
      events.publish(request.auth.tenantId, 'work', { key: CUSTOM_FIELD_KEY })
      response.json({ item, items: ordered(committed), version: workspaceRecordVersion(record) })
    } catch (error) {
      console.error('[custom-fields] Failed to persist definition change', { message: error?.message })
      response.status(500).json({ error: CUSTOM_FIELD_ERRORS.WRITE_FAILED })
    }
  })

  /**
   * 하드 삭제는 값이 0건일 때만. 값이 있으면 409 + 건수 + 보관 안내.
   *
   * 값을 함께 지우지 않는 이유: 정의는 custom-fields 배열, 값은 최대 1,000건의 work-items payload 안이다.
   * purge하려면 두 저장소 키를 한 commitWorkspaceStore()로 묶고 실패 시 둘 다 복원해야 한다.
   * 사용 0건일 때의 삭제와 보관, 두 갈래로 답하는 편이 되돌릴 수 있다.
   */
  app.delete('/api/custom-fields/:id', ...adminGuards, async (request, response) => {
    const state = requireTenantStore(request, response)
    if (!state) return
    const previous = state.definitions.find((definition) => definition.id === request.params.id)
    if (!previous) {
      response.status(404).json({ error: CUSTOM_FIELD_ERRORS.NOT_FOUND })
      return
    }
    const count = countFieldUsage(workItemsOf(state.tenantStore), previous.key)
    if (count > 0) {
      const reason = previous.archivedAt ? CUSTOM_FIELD_ERRORS.IN_USE_ARCHIVED : CUSTOM_FIELD_ERRORS.IN_USE
      response.status(409).json({ error: { ...reason, count } })
      return
    }
    const nextDefinitions = state.definitions.filter((definition) => definition.id !== previous.id)
    try {
      const previousRecord = state.tenantStore[CUSTOM_FIELD_KEY]
      const record = await commitDefinitions(request.auth, state.tenantStore, previousRecord, nextDefinitions, state.unreadable)
      events.publish(request.auth.tenantId, 'work', { key: CUSTOM_FIELD_KEY })
      response.json({ deletedId: previous.id, items: ordered(nextDefinitions), version: workspaceRecordVersion(record) })
    } catch (error) {
      console.error('[custom-fields] Failed to delete definition', { message: error?.message })
      response.status(500).json({ error: CUSTOM_FIELD_ERRORS.WRITE_FAILED })
    }
  })

  /**
   * POST /api/work-items/:id/fields — 값 편집(부분 병합).
   *
   * null 또는 빈 문자열을 보내면 그 키를 **지운다**(부분 병합 PATCH의 관례).
   * 남은 키가 하나도 없으면 fields 키 자체를 지운다 — '값 없음'이 한 가지여야
   * JSON 모드와 PG 모드, 그리고 sameWorkItemExceptStatus의 deep-equal이 같은 답을 낸다.
   */
  app.post('/api/work-items/:id/fields', ...guards, async (request, response) => {
    const state = requireTenantStore(request, response)
    if (!state) return
    const values = request.body?.values
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      response.status(400).json({ error: WORK_FIELD_ERRORS.INVALID })
      return
    }
    const previousRecord = state.tenantStore[WORK_ITEM_KEY]
    const previousData = Array.isArray(previousRecord?.data) ? previousRecord.data : []
    // 배열이 고객사별이므로 타 테넌트 id는 구조적으로 여기서 없는 업무가 된다.
    const previous = previousData.find((item) => item?.id === request.params.id)
    if (!previous) {
      response.status(404).json({ error: { code: 'WORK_ITEM_NOT_FOUND', message: '업무를 찾을 수 없습니다.' } })
      return
    }
    if (request.auth.role !== 'tenant-admin' && previous.ownerId !== request.auth.id && previous.requesterId !== request.auth.id) {
      response.status(403).json({ error: WORK_FIELD_ERRORS.FORBIDDEN })
      return
    }
    // 상태 충돌은 409 — CHECKLIST_LOCKED·SCHEDULE_LOCKED와 같은 관례.
    if (WORK_FIELD_CLOSED_STATUSES.includes(previous.status)) {
      response.status(409).json({ error: WORK_FIELD_ERRORS.LOCKED })
      return
    }
    const active = new Map(state.definitions.filter((definition) => !definition.archivedAt).map((definition) => [definition.key, definition]))
    const known = new Map(state.definitions.map((definition) => [definition.key, definition]))
    const merged = { ...(previous.fields && typeof previous.fields === 'object' && !Array.isArray(previous.fields) ? previous.fields : {}) }
    for (const [key, value] of Object.entries(values)) {
      const clearing = value === null || value === ''
      /**
       * 값을 **넣는** 곳은 활성 정의뿐이다(보관된 항목은 여기서 '없는 항목'이다).
       * 값을 **지우는** 것은 보관된 항목에서도 된다 — 그러지 않으면 보관 뒤에 남은 값은 어느 길로도 없앨 수 없고,
       * DELETE는 그 값을 세어 영원히 409를 낸다. '값 없음은 한 가지'라는 이 파일의 불변식은 지우는 길이 있어야 성립한다.
       */
      const definition = clearing ? known.get(key) : active.get(key)
      if (!definition) {
        response.status(400).json({ error: { ...CUSTOM_FIELD_ERRORS.UNKNOWN, key } })
        return
      }
      if (clearing) {
        // required 항목의 이미 있는 값은 비울 수 없다. 없던 값을 계속 없는 채로 두는 것은 막지 않는다 —
        // 그렇게 하면 값 없는 기존 업무의 다른 항목 저장까지 막힌다(입력 시점 규칙의 경계).
        // 보관된 항목의 required는 더 이상 입력 규칙이 아니다 — 그 칸은 새 업무 화면에 그려지지도 않는다.
        if (!definition.archivedAt && definition.required && merged[key] !== undefined) {
          response.status(400).json({ error: { ...CUSTOM_FIELD_ERRORS.REQUIRED, key } })
          return
        }
        delete merged[key]
        continue
      }
      const violation = valueTypeViolation(definition, value, accountsFor(request.auth), request.auth.tenantId)
      if (violation) {
        response.status(400).json({ error: { ...violation, key } })
        return
      }
      // 글자 상한은 아래 hasWorkFieldValuesShape도 잡지만 그 문장은 어느 칸인지도 상한도 말하지 않는다.
      // 같은 루프의 다른 거절과 같은 자리에서, 같은 모양({ code, message, key })으로 답한다.
      if (typeof value === 'string' && value.length > MAX_TEXT_VALUE) {
        response.status(400).json({ error: { ...WORK_FIELD_ERRORS.VALUE_TOO_LONG, key } })
        return
      }
      merged[key] = value
    }
    // 정의는 50개까지 만들 수 있고 한 업무가 담는 값은 30개까지다(둘은 다른 무게다).
    // 그 경계도 '형식을 확인해 주세요'가 아니라 상한을 말하는 한 문장으로 답한다.
    if (Object.keys(merged).length > MAX_WORK_FIELD_KEYS) {
      response.status(400).json({ error: WORK_FIELD_ERRORS.LIMIT })
      return
    }
    const nextFields = Object.keys(merged).length ? merged : undefined
    const next = { ...previous }
    if (nextFields) next.fields = nextFields
    else delete next.fields
    if (!hasWorkFieldValuesShape(nextFields ?? {})) {
      response.status(400).json({ error: WORK_FIELD_ERRORS.INVALID })
      return
    }
    // 키 순서가 아니라 내용으로 본다 — 같은 값을 다시 보낸 요청이 순서 때문에 쓰기가 되면 안 된다.
    if (isDeepStrictEqual(previous.fields ?? null, next.fields ?? null)) {
      // 같은 값이면 쓰지 않는다 — updatedAt·version이 그대로여야 화면이 헛된 재조회를 하지 않는다.
      response.json({ item: previous, updatedAt: previousRecord?.updatedAt ?? null, version: workspaceRecordVersion(previousRecord) })
      return
    }
    if (!hasWorkItemShape(next)) {
      response.status(400).json({ error: { code: 'INVALID_WORK_ITEM', message: '업무 처리 데이터 형식을 확인해 주세요.' } })
      return
    }
    // 이중 방어: 위 루프와 같은 판정을 배열 검증기로 한 번 더 본다(두 문이 갈리지 않게 같은 함수를 쓴다).
    const violation = customFieldViolation([next], [previous], state.definitions, accountsFor(request.auth), request.auth.tenantId)
    if (violation) {
      response.status(400).json({ error: violation })
      return
    }

    const now = clock().toISOString()
    const nextData = previousData.map((item) => item?.id === next.id ? next : item)
    const record = { data: nextData, updatedAt: now, updatedBy: request.auth.id }
    state.tenantStore[WORK_ITEM_KEY] = record
    workspaceStore.tenants[request.auth.tenantId] = state.tenantStore
    try {
      await commitWorkspaceStore()
    } catch (error) {
      if (previousRecord) state.tenantStore[WORK_ITEM_KEY] = previousRecord
      else delete state.tenantStore[WORK_ITEM_KEY]
      console.error('[custom-fields] Failed to persist work item fields', { message: error?.message })
      response.status(500).json({ error: WORK_FIELD_ERRORS.WRITE_FAILED })
      return
    }
    // 제목을 싣지 않는다 — 게스트 스트림은 key·id만 받는다. 배정도 마감 변경도 아니므로 알림·센티널은 없다.
    events.publish(request.auth.tenantId, 'work', { key: WORK_ITEM_KEY, taskId: next.id })
    response.json({ item: next, updatedAt: now, version: workspaceRecordVersion(record) })
  })
}

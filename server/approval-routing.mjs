import { randomBytes } from 'node:crypto'

import { billingMonth } from './billing-service.mjs'

/**
 * 양식형 전자결재 — 결재선을 도는 규칙. 순수 함수만 있고 I/O가 0이다.
 *
 * 왜 규칙을 라우트에서 떼어 놓는가: 「누가 지금 결재할 차례인가」와 「이 승인으로 문서가 끝났는가」는
 * HTTP·저장소·권한 미들웨어와 아무 상관이 없는 판정이다. 라우트 안에 두면 그 판정을 확인하려고
 * 매번 서버를 띄우고 로그인부터 해야 하고, 같은 판정을 인쇄·집계·화면이 각자 흉내 내게 된다.
 *
 * 세 가지 규율을 이 파일 전체가 지킨다.
 * 1) **시계를 주입한다.** `now` 없이는 아무 함수도 돌지 않고, 없으면 던진다. 벽시계를 읽는 함수는
 *    한밤중에만 실패하는 테스트를 만든다. `billingMonth`는 기본값이 있지만 우리는 늘 값을 넘긴다.
 * 2) **글자는 자르고, 구조는 거절한다.** 사람이 읽는 문자열(이름·설명·의견)은 상한에서 자르고,
 *    구조(키·타입·단계 수·결재자 수)는 자르지 않고 거절한다. 자른 뒤에 길이를 다시 보는 죽은 검사를 두지 않는다.
 * 3) **입력을 변형하지 않는다.** 결재 진행 함수는 깊게 얼린(`Object.freeze`) 문서를 받아도 던지지 않고
 *    새 객체를 돌려준다. 저장 실패 시 롤백이 원본 참조를 그대로 되돌릴 수 있어야 하기 때문이다.
 *
 * id·기안자·결재 결정 시각은 요청 본문에서 절대 오지 않는다. 본문이 정할 수 있는 것은
 * 「무엇을 적었는가」뿐이고, 「누가·언제·어떤 자격으로」는 세션과 주입한 시계가 정한다.
 */

export const APPROVAL_FORM_KINDS = Object.freeze(['지출결의', '구매요청', '품의', '기안', '출장'])
export const APPROVAL_FIELD_TYPES = Object.freeze(['text', 'number', 'money', 'date', 'select', 'attachment'])
export const APPROVAL_STATUSES = Object.freeze(['기안', '결재중', '승인', '반려', '회수'])
export const APPROVAL_STEP_MODES = Object.freeze(['sequential', 'parallel'])
export const APPROVER_DECISIONS = Object.freeze(['pending', 'approved', 'rejected'])
/**
 * server/tax-evidence-export.mjs 의 TAX_BUCKETS 와 문자 그대로 같아야 한다.
 * 어긋나면 결재 양식에서 고른 증빙 분류가 세무 ZIP 안에서 조용히 '기타'로 떨어진다.
 * approval-routing.test.mjs 가 그 파일을 읽어 정규식으로 뽑아 비교한다.
 */
export const TAX_EVIDENCE_CATEGORIES = Object.freeze(['매출', '매입', '급여', '경비', '신고·납부', '기타'])

export const MAX_FORMS_PER_TENANT = 60
export const MAX_DOCUMENTS_PER_TENANT = 5_000
export const MAX_FIELDS_PER_FORM = 30
export const MAX_OPTIONS_PER_FIELD = 20
export const MAX_LINE_STEPS = 8
export const MAX_APPROVERS_PER_STEP = 5
export const MAX_CC = 20
export const MAX_ATTACHMENTS = 10
export const MAX_TITLE = 120
export const MAX_LABEL = 20
export const MAX_HELP = 120
export const MAX_TEXT_VALUE = 1_000
export const MAX_COMMENT = 500
export const MIN_REJECTION_REASON = 5
export const MAX_REJECTION_REASON = 500
export const MAX_HISTORY = 100
export const MAX_MONEY = 1_000_000_000_000
/** 선택지 한 줄의 길이. 라벨(20자)보다 길게 잡는다 — 「신고·납부(부가세 2기 확정)」 같은 값이 실제로 온다. */
export const MAX_OPTION_VALUE = 40

export const FORM_ID_RE = /^AFM-[A-Z0-9-]{4,40}$/
export const DELEGATE_ID_RE = /^ADG-[A-Za-z0-9_-]{2,120}$/
export const DOCUMENT_ID_RE = /^APD-[A-Z0-9-]{4,40}$/
export const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,29}$/
export const ATTACHMENT_ID_RE = /^DOC-[A-Za-z0-9_-]{4,160}$/

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
/** 줄바꿈(0x0A)만 남기고 나머지 제어문자를 지운다. 의견·사유는 여러 줄일 수 있다. */
const CONTROL_RE = /[\x00-\x09\x0B-\x1F\x7F]/g

/**
 * 오류 사전. **항목까지 얼린다** — 대부분의 갈래가 사본이 아니라 이 객체 자체를 `{ error }` 로 돌려주므로,
 * 받은 쪽(라우트·다국어층)이 message 한 글자를 고치면 그 프로세스의 모든 테넌트가 이후 그 문구를 받는다.
 * key·reason 을 붙이는 갈래는 스프레드로 사본을 만들어 붙인다(`{ ...VALUE_INVALID, key }`).
 */
const APPROVAL_ERROR_TABLE = {
  FORM_INVALID: { code: 'APPROVAL_FORM_INVALID', message: '양식 정보를 확인해 주세요.' },
  FORM_KIND_INVALID: { code: 'APPROVAL_FORM_KIND_INVALID', message: '양식 종류는 지출결의·구매요청·품의·기안·출장 중 하나여야 합니다.' },
  FIELD_INVALID: { code: 'APPROVAL_FIELD_INVALID', message: '양식 항목을 확인해 주세요.' },
  AMOUNT_FIELD_INVALID: { code: 'APPROVAL_FORM_AMOUNT_FIELD_INVALID', message: '금액 집계 항목은 이 양식의 금액 항목 중에서 골라야 합니다.' },
  EVIDENCE_INVALID: { code: 'APPROVAL_FORM_EVIDENCE_INVALID', message: '증빙 분류는 「매출」·「매입」·「급여」·「경비」·「신고·납부」·「기타」 중 하나여야 합니다.' },
  // 숫자를 말하는 문장은 돌아가는 앱이 실제로 거절하는 값과 같아야 한다(규칙 11). 「2명 이상」만
  // 적으면 6명을 넣어 거절당한 사람이 자기가 이미 2명 이상을 넣었다는 사실만 확인하고 끝난다.
  // 이 문장의 세 숫자는 MAX_LINE_STEPS·MAX_APPROVERS_PER_STEP 이 정본이고, 시험이 그 상수로 다시 잰다.
  LINE_INVALID: { code: 'APPROVAL_LINE_INVALID', message: '결재선을 확인해 주세요. 단계는 8개까지, 순차 단계는 결재자 1명, 병렬 단계는 2~5명이어야 합니다.' },
  LINE_SELF: { code: 'APPROVAL_LINE_SELF', message: '기안자는 자기 문서의 결재자가 될 수 없습니다.' },
  LINE_DUPLICATE: { code: 'APPROVAL_LINE_DUPLICATE', message: '같은 사람을 결재선에 두 번 넣을 수 없습니다.' },
  LINE_UNKNOWN: { code: 'APPROVAL_LINE_UNKNOWN_APPROVER', message: '결재자로 지정할 수 없는 계정이 있습니다.' },
  LINE_REQUIRED: { code: 'APPROVAL_LINE_REQUIRED', message: '결재선을 한 단계 이상 지정해야 상신할 수 있습니다.' },
  VALUE_REQUIRED: { code: 'APPROVAL_VALUE_REQUIRED', message: '필수 항목을 채워 주세요.' },
  VALUE_INVALID: { code: 'APPROVAL_VALUE_INVALID', message: '항목 값을 확인해 주세요.' },
  NOT_APPROVER: { code: 'APPROVAL_NOT_APPROVER', message: '지금 이 문서를 결재할 차례가 아닙니다.' },
  ALREADY_DECIDED: { code: 'APPROVAL_ALREADY_DECIDED', message: '이미 끝난 결재입니다.' },
  // 「아직 시작하지 않았다」와 「이미 끝났다」는 다른 사실이다. 결재선에 이름이 적힌 사람은 상신 전
  // 문서도 목록에서 보므로 실제로 눌러 볼 수 있는 자리이고, 그때 「이미 끝난 결재입니다」를 받으면
  // 같은 응답에 실린 상태(`기안`)와 정면으로 어긋난다.
  NOT_SUBMITTED: { code: 'APPROVAL_NOT_SUBMITTED', message: '아직 상신되지 않은 문서입니다. 기안자가 상신해야 결재할 수 있습니다.' },
  LINE_BROKEN: { code: 'APPROVAL_LINE_BROKEN', message: '결재선이 손상되었습니다. 관리자에게 알려 주세요.' },
  REASON_REQUIRED: { code: 'APPROVAL_REASON_REQUIRED', message: '반려 사유를 5자 이상 적어 주세요.' },
  RECALL_FORBIDDEN: { code: 'APPROVAL_RECALL_FORBIDDEN', message: '이미 결재가 시작된 문서는 회수할 수 없습니다.' },
  NOT_EDITABLE: { code: 'APPROVAL_NOT_EDITABLE', message: '상신한 뒤에는 내용을 고칠 수 없습니다.' },
  DELEGATE_INVALID: { code: 'APPROVAL_DELEGATE_INVALID', message: '대결자와 기간을 확인해 주세요.' },
  DELEGATE_CYCLE: { code: 'APPROVAL_DELEGATE_CYCLE', message: '대결은 한 단계까지만 지정할 수 있습니다.' },
  SEAT_TAKEN: { code: 'APPROVAL_SEAT_TAKEN', message: '이 결재선에서 이미 한 자리를 결재하셨습니다. 남은 자리는 다른 분이 결재해야 합니다.' },
}

export const APPROVAL_ERRORS = Object.freeze(
  Object.fromEntries(Object.entries(APPROVAL_ERROR_TABLE).map(([key, entry]) => [key, Object.freeze(entry)])),
)

export const MIN_POSTING_MONTHS = 1
export const MAX_POSTING_MONTHS = 24
export const DEFAULT_POSTING_MONTHS = 6

const APPROVAL_FORM_KIND_SET = new Set(APPROVAL_FORM_KINDS)
const APPROVAL_FIELD_TYPE_SET = new Set(APPROVAL_FIELD_TYPES)
const APPROVAL_STEP_MODE_SET = new Set(APPROVAL_STEP_MODES)
const TAX_EVIDENCE_CATEGORY_SET = new Set(TAX_EVIDENCE_CATEGORIES)
/** 값 판정 실패를 나타내는 표식. `null`·`undefined`는 「비었다」는 뜻으로 이미 쓰고 있어 겹칠 수 없다. */
const INVALID = Symbol('approval-value-invalid')

/**
 * 시각 문자열의 모양. `Date.parse` 는 '5' 를 2001년 5월로, '2026' 을 그 해 1월로 읽어 준다 —
 * 그 값을 그대로 저장하면 decidedAt·completedAt·history.at 에 「5」라는 시각이 앉는다.
 * 그래서 파싱되는지 묻기 전에 날짜처럼 생겼는지부터 본다.
 */
const NOW_SHAPE_RE = /^\d{4}-\d{2}-\d{2}([T ]|$)/

/**
 * 주입한 시계. 없으면 던진다 — 기본값을 두면 그 함수는 밤 9시 이후에만 다른 답을 낸다.
 * 넘긴 문자열을 그대로 돌려주는 이유: 저장되는 시각 문자열이 호출자가 준 값과 글자까지 같아야
 * 같은 요청을 다시 보냈을 때 만들어지는 문서가 같아진다(멱등 재시도). 그래서 다듬지 않는 대신 모양을 본다.
 */
function requireNow(now) {
  if (now instanceof Date) {
    if (!Number.isFinite(now.getTime())) throw new TypeError('approval-routing: now 가 올바른 시각이 아니다.')
    return now.toISOString()
  }
  const text = typeof now === 'string' ? now.trim() : ''
  if (!text || !NOW_SHAPE_RE.test(text) || !Number.isFinite(Date.parse(text))) {
    throw new TypeError('approval-routing: now(주입 시계)를 YYYY-MM-DD 로 시작하는 시각으로 받아야 한다. 이 파일은 벽시계를 읽지 않는다.')
  }
  return text
}

/** 행위자는 세션에서만 온다. 없으면 배선이 잘못된 것이므로 400이 아니라 던진다. */
function requireActor(actor) {
  const id = String(actor?.id ?? '').trim()
  if (!id) throw new TypeError('approval-routing: actor(세션 계정)를 받아야 한다.')
  return { id, name: clip(actor?.name, MAX_TITLE) }
}

/**
 * 사람이 읽는 문자열 하나를 다듬는다 — 이 파일의 유일한 문자열 정규화기.
 * 줄바꿈은 살리고 나머지 제어문자는 없앤 뒤 상한에서 자른다.
 * 자른 뒤 길이를 다시 보는 검사는 어디에도 두지 않는다. 이미 자른 값은 언제나 상한 이하다.
 *
 * 상한 자리가 이모지 한가운데면 한 코드유닛을 더 뗀다. 결재 의견은 사람이 실제로 이모지를 쓰는 칸이고,
 * 짝 잃은 상위 서로게이트가 남으면 JSON 에 짝 없는 `\ud83d` 이스케이프가 그대로 실려 나간다.
 */
function clip(value, max) {
  const text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_RE, '')
    .trim()
    .slice(0, max)
  return /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text
}

/** 실달력 검증. server/tax-evidence-export.mjs 의 validDate 와 같은 방식이되 던지지 않고 참·거짓을 준다. */
function isCalendarDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  if (year < 2000 || year > 2100) return false
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
}

/**
 * 결재자가 될 수 있는 계정 목록을 id→이름 표로 만든다.
 * `Map<id,name>` · `Set<id>` · `string[]` · `{ id|accountId, name }[]` 중 무엇으로 줘도 같게 읽는다.
 * `null`을 주면 표를 만들지 않는다 = 계정 대조를 건너뛴다(양식의 기본 결재선처럼 기안자도 계정 목록도 없는 자리).
 */
function accountIndex(source) {
  if (source == null) return null
  const map = new Map()
  if (source instanceof Map) {
    for (const [id, name] of source) {
      const key = String(id ?? '').trim()
      if (key) map.set(key, clip(name, MAX_TITLE))
    }
    return map
  }
  const list = source instanceof Set ? [...source] : Array.isArray(source) ? source : []
  for (const entry of list) {
    if (typeof entry === 'string') {
      const key = entry.trim()
      if (key) map.set(key, '')
      continue
    }
    const key = String(entry?.id ?? entry?.accountId ?? '').trim()
    if (key) map.set(key, clip(entry?.name ?? '', MAX_TITLE))
  }
  return map
}

function idList(value) {
  if (value == null) return []
  const list = value instanceof Set ? [...value] : Array.isArray(value) ? value : []
  return list.map((entry) => String(entry ?? '').trim()).filter(Boolean)
}

/**
 * 새 id. 시각 부분은 주입한 시계에서 오고 뒤 4자리만 난수다 —
 * 시계를 주입한 테스트에서 접두사가 재현되고, 같은 밀리초에 두 건이 만들어져도 충돌하지 않는다.
 */
export function newApprovalId(prefix, now) {
  const at = requireNow(now)
  const stamp = new Date(at).getTime().toString(36).toUpperCase()
  return `${prefix}-${stamp}-${randomBytes(2).toString('hex').toUpperCase()}`
}

/** 선택지 목록. 구조가 어긋나면 null(거절), 아니면 다듬은 배열. */
function normalizeFieldOptions(value) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > MAX_OPTIONS_PER_FIELD) return null
  const options = value.map((entry) => clip(entry, MAX_OPTION_VALUE))
  if (options.some((entry) => !entry)) return null
  // 자른 뒤에 중복을 본다 — 41자에서 갈리는 두 값은 잘리고 나면 같은 선택지가 된다.
  if (new Set(options).size !== options.length) return null
  return options
}

/** 양식 항목 한 줄. position 은 배열 순서로 서버가 다시 매긴다 — 본문이 보낸 순서 값은 쓰지 않는다. */
function normalizeFormField(raw, position) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const key = String(raw.key ?? '').trim()
  const type = String(raw.type ?? '').trim()
  const label = clip(raw.label, MAX_LABEL)
  if (!FIELD_KEY_RE.test(key) || !APPROVAL_FIELD_TYPE_SET.has(type) || !label) return null
  const options = type === 'select' ? normalizeFieldOptions(raw.options) : []
  if (!options || (type === 'select' && options.length === 0)) return null
  return { key, label, type, required: raw.required === true, options, help: clip(raw.help, MAX_HELP), position }
}

/** 참조자 목록. 상한을 넘으면 null(거절). 중복은 상한을 본 뒤에 지운다. */
function normalizeCcIds(value) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > MAX_CC) return null
  return [...new Set(idList(value))]
}

/**
 * 양식 한 벌. `previous`가 있으면 갱신이고, id·최초 작성자·최초 시각은 그쪽에서 그대로 가져온다.
 * 기존 문서는 만들어질 때 formName·formVersion·kind 를 자기 안에 복사해 두므로,
 * 양식을 고쳐도 이미 돌고 있는 결재의 얼굴이 바뀌지 않는다.
 */
export function normalizeApprovalForm(input, { actor, now, previous } = {}) {
  const at = requireNow(now)
  const author = requireActor(actor)
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: APPROVAL_ERRORS.FORM_INVALID }

  const name = clip(input.name, MAX_TITLE)
  if (!name) return { error: APPROVAL_ERRORS.FORM_INVALID }
  const kind = String(input.kind ?? '').trim()
  if (!APPROVAL_FORM_KIND_SET.has(kind)) return { error: APPROVAL_ERRORS.FORM_KIND_INVALID }

  const rawFields = Array.isArray(input.fields) ? input.fields : null
  // 항목이 하나도 없는 양식은 빈 문서만 찍어 낸다. 금액 집계 항목을 가리킬 자리도 없다.
  if (!rawFields || rawFields.length === 0 || rawFields.length > MAX_FIELDS_PER_FORM) return { error: APPROVAL_ERRORS.FIELD_INVALID }
  const fields = []
  for (const [position, raw] of rawFields.entries()) {
    const field = normalizeFormField(raw, position)
    if (!field) return { error: APPROVAL_ERRORS.FIELD_INVALID }
    fields.push(field)
  }
  if (new Set(fields.map((field) => field.key)).size !== fields.length) return { error: APPROVAL_ERRORS.FIELD_INVALID }

  const amountFieldKey = input.amountFieldKey == null || input.amountFieldKey === '' ? null : String(input.amountFieldKey).trim()
  if (amountFieldKey && !fields.some((field) => field.key === amountFieldKey && field.type === 'money')) {
    return { error: APPROVAL_ERRORS.AMOUNT_FIELD_INVALID }
  }
  const evidenceCategory = input.evidenceCategory == null || input.evidenceCategory === '' ? null : String(input.evidenceCategory).trim()
  if (evidenceCategory && !TAX_EVIDENCE_CATEGORY_SET.has(evidenceCategory)) return { error: APPROVAL_ERRORS.EVIDENCE_INVALID }

  // 양식의 기본 결재선은 모양만 본다. 계정 대조와 기안자 자기 자신 검사는 문서를 기안할 때
  // 같은 함수가 다시 한 번 하므로(그때는 계정 목록과 기안자가 있다) 여기서 건너뛰어도 새는 곳이 없다.
  const defaultLine = normalizeApprovalLine(input.defaultLine, { drafterId: null, approverIds: null })
  if (defaultLine.error) return { error: defaultLine.error }
  const ccIds = normalizeCcIds(input.ccIds)
  if (!ccIds) return { error: APPROVAL_ERRORS.FORM_INVALID }

  const base = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : null
  const id = base ? String(base.id ?? '').trim() : newApprovalId('AFM', at)
  if (!FORM_ID_RE.test(id)) return { error: APPROVAL_ERRORS.FORM_INVALID }

  return {
    form: {
      recordType: 'form',
      id,
      name,
      kind,
      description: clip(input.description, MAX_HELP),
      fields,
      defaultLine: defaultLine.line,
      ccIds,
      amountFieldKey,
      evidenceCategory,
      active: input.active === undefined ? (base ? base.active !== false : true) : input.active === true,
      version: Number.isFinite(base?.version) ? base.version + 1 : 1,
      createdById: base ? String(base.createdById ?? '') : author.id,
      createdByName: base ? clip(base.createdByName, MAX_TITLE) : author.name,
      createdAt: base && base.createdAt ? String(base.createdAt) : at,
      updatedAt: at,
      updatedById: author.id,
    },
  }
}

function approverIdOf(entry) {
  if (typeof entry === 'string') return entry.trim()
  return String(entry?.accountId ?? entry?.id ?? '').trim()
}

/**
 * 결재선. 언제나 **새로 pending 상태로** 만든다 — 본문이 보낸 decision·decidedAt 은 읽지 않는다.
 * 읽으면 기안 본문 하나로 「이미 승인된 문서」를 만들어 낼 수 있다.
 *
 * `line`이 **아예 없을 때만**(`null`·`undefined`) `defaultLine`을 쓴다. 「고르지 않았다」와 「전부 지웠다」는
 * 다른 말이다. 빈 배열을 기본 결재선으로 채우면 기안자가 고르지 않은 사람에게 문서가 상신되고 응답은 200 이며,
 * 결재선이 채워져 버려 상신 때의 LINE_REQUIRED 도 영원히 울리지 않는다. 배열이 아닌 것은 같은 이유로 거절한다.
 * 결재선이 비었을 때 거절할지는 부르는 쪽이 정한다 (`requireSteps`) — 양식을 저장할 때는 기본 결재선이
 * 없어도 되고, 상신할 때는 있어야 한다.
 *
 * mode 의 뜻: sequential 은 결재자 **정확히 1명**, parallel 은 **2~5명이며 전원 승인**해야 다음 단계로 간다.
 * 진행 규칙(applyApprovalDecision)은 두 모드가 같은 문장을 쓰므로, 모드가 갈리는 곳은 여기 한 군데뿐이다.
 */
export function normalizeApprovalLine(line, { drafterId = null, approverIds = null, defaultLine = null, requireSteps = false } = {}) {
  // 글자는 자르고 구조는 거절한다 — 결재선은 구조다.
  if (line != null && !Array.isArray(line)) return { error: APPROVAL_ERRORS.LINE_INVALID }
  if (defaultLine != null && !Array.isArray(defaultLine)) return { error: APPROVAL_ERRORS.LINE_INVALID }
  const source = line == null ? defaultLine ?? [] : line
  if (source.length === 0) return requireSteps ? { error: APPROVAL_ERRORS.LINE_REQUIRED } : { line: [] }
  if (source.length > MAX_LINE_STEPS) return { error: APPROVAL_ERRORS.LINE_INVALID }

  const index = accountIndex(approverIds)
  const drafter = String(drafterId ?? '').trim()
  const seen = new Set()
  const steps = []
  for (const [position, raw] of source.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: APPROVAL_ERRORS.LINE_INVALID }
    const mode = String(raw.mode ?? '').trim()
    if (!APPROVAL_STEP_MODE_SET.has(mode)) return { error: APPROVAL_ERRORS.LINE_INVALID }
    const ids = Array.isArray(raw.approvers) ? raw.approvers.map(approverIdOf) : null
    if (!ids || ids.some((id) => !id)) return { error: APPROVAL_ERRORS.LINE_INVALID }
    if (mode === 'sequential' && ids.length !== 1) return { error: APPROVAL_ERRORS.LINE_INVALID }
    if (mode === 'parallel' && (ids.length < 2 || ids.length > MAX_APPROVERS_PER_STEP)) return { error: APPROVAL_ERRORS.LINE_INVALID }

    const approvers = []
    for (const id of ids) {
      if (drafter && id === drafter) return { error: APPROVAL_ERRORS.LINE_SELF }
      if (seen.has(id)) return { error: APPROVAL_ERRORS.LINE_DUPLICATE }
      seen.add(id)
      if (index && !index.has(id)) return { error: APPROVAL_ERRORS.LINE_UNKNOWN }
      // 이름은 계정 표에서만 온다. 본문이 보낸 이름을 쓰면 인쇄물의 결재자 칸이 남의 이름으로 찍힌다.
      //
      // decidedById 는 「이 자리를 실제로 누른 사람」이다. 대결이면 원결재자(accountId)와 다르다.
      // **저장·재적재에서 반드시 살아남아야 하는 필드다**(I2 의 DDL·I3 의 직렬화). 인쇄물의 「C(대결 B)」와
      // §1.5 가시성 규칙(대결로 누른 사람이 기간이 끝난 뒤에도 그 문서를 본다)이 이 값 하나에 기댄다.
      // 떨어져 나가도 「한 사람은 이 결재선에서 자리 하나」는 이력이 두 번째 증인으로 지킨다(approvalSeatFor).
      approvers.push({ accountId: id, name: index?.get(id) ?? '', decision: 'pending', decidedAt: null, decidedById: null, comment: '', delegateOf: null })
    }
    // 단계 번호는 배열 순서로 다시 매긴다. 본문이 5·9로 보내도 저장되는 것은 1·2다.
    steps.push({ step: position + 1, mode, approvers })
  }
  return { line: steps }
}

function isBlankValue(value) {
  if (value == null) return true
  return typeof value === 'string' && clip(value, MAX_TEXT_VALUE) === ''
}

/** 값 하나. 타입마다 받는 모양이 하나씩뿐이다 — 「숫자처럼 생긴 글자」를 받아 주면 저장 경로마다 다르게 읽힌다. */
function normalizeFieldValue(field, raw) {
  if (field.type === 'text') return typeof raw === 'string' ? clip(raw, MAX_TEXT_VALUE) : INVALID
  if (field.type === 'number') {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || Math.abs(raw) > 1e12) return INVALID
    return raw + 0
  }
  if (field.type === 'money') {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return INVALID
    // 원 단위로 먼저 반올림한 뒤 그 값으로 상한을 본다. 자르고 나서 다시 보는 검사를 만들지 않기 위해서다.
    // `+ 0` 은 -0 을 0 으로 만든다: Math.round(-0.4) 는 -0 이고 `-0 < 0` 은 거짓이라 그대로 통과하는데,
    // 값으로는 0 과 같아도 ko-KR 서식이 인쇄물 금액 칸에 「-0」을 찍는다. 0 은 한 가지 모양뿐이어야 한다.
    const rounded = Math.round(raw) + 0
    return rounded < 0 || rounded > MAX_MONEY ? INVALID : rounded
  }
  if (field.type === 'date') return isCalendarDate(raw) ? raw : INVALID
  if (field.type === 'select') return typeof raw === 'string' && field.options.includes(raw) ? raw : INVALID
  return typeof raw === 'string' && ATTACHMENT_ID_RE.test(raw) ? raw : INVALID
}

/**
 * 양식과 값을 맞춘다. 값 검증은 이 함수 한 곳에만 있다.
 *
 * 양식에 없는 키는 버리지 않고 **거절**한다(`reason:'unknown-field'`). 조용히 버리면
 * 화면이 잘못된 키로 저장을 보내도 200이 돌아오고, 사람은 적은 값이 사라진 것을 나중에야 안다.
 * 비어 있는 선택 항목은 키 자체를 넣지 않는다 — 「값 없음」이 한 가지뿐이어야 집계가 흔들리지 않는다.
 */
export function normalizeApprovalValues(form, values) {
  const fields = Array.isArray(form?.fields) ? form.fields : []
  if (values != null && (typeof values !== 'object' || Array.isArray(values))) {
    return { error: { ...APPROVAL_ERRORS.VALUE_INVALID, key: '' } }
  }
  const source = values ?? {}
  const known = new Set(fields.map((field) => field?.key))
  for (const key of Object.keys(source)) {
    if (!known.has(key)) return { error: { ...APPROVAL_ERRORS.VALUE_INVALID, key, reason: 'unknown-field' } }
  }

  const normalized = {}
  for (const field of fields) {
    // 제 값만 읽는다. `source[key]` 로 읽으면 key 가 'constructor' 인 양식에서 빈 칸이
    // Object.prototype.constructor(함수)를 값으로 집어 「비었다」가 「이상하다」로 뒤집힌다.
    const raw = Object.hasOwn(source, field.key) ? source[field.key] : undefined
    if (isBlankValue(raw)) {
      if (field.required) return { error: { ...APPROVAL_ERRORS.VALUE_REQUIRED, key: field.key } }
      continue
    }
    const value = normalizeFieldValue(field, raw)
    if (value === INVALID) return { error: { ...APPROVAL_ERRORS.VALUE_INVALID, key: field.key } }
    normalized[field.key] = value
  }
  return { values: normalized }
}

/** 두 기간이 하루라도 겹치는가. 겹치지 않는 두 대결은 어느 순간에도 사슬이 되지 않는다. */
function periodsOverlap(a, b) {
  return a.from <= b.to && b.from <= a.to
}

/**
 * 대결자 지정. id 가 `ADG-<accountId>`로 결정론이라 upsert 가 곧 멱등이다.
 *
 * 대결은 **한 단계까지만** 산다. 그래서 두 가지를 막는다.
 * (1) 고른 대결자가 이미 자기 대결자를 두고 있으면 A→B→C 사슬이 되고,
 * (2) 지정하는 본인이 이미 남의 대결자면 X→본인→새 대결자 사슬이 된다.
 * 기간이 겹칠 때만 사슬이므로 겹치는 것만 본다.
 */
export function normalizeDelegate(input, { accountId, accounts, now, actor, existingDelegates } = {}) {
  const at = requireNow(now)
  const owner = String(accountId ?? '').trim()
  const id = `ADG-${owner}`
  if (!owner || !DELEGATE_ID_RE.test(id)) return { error: APPROVAL_ERRORS.DELEGATE_INVALID }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: APPROVAL_ERRORS.DELEGATE_INVALID }

  // 맡기는 사람과 맡는 사람이 **둘 다** 이 회사의 계정이어야 한다. 관리자가 남의 대결을 지정할 수 있으므로
  // 경로로 들어온 accountId 도 여기서 함께 본다 — 한쪽만 보면 떠난 사람 앞으로 대결이 걸린다.
  const index = accountIndex(accounts) ?? new Map()
  if (!index.has(owner)) return { error: APPROVAL_ERRORS.DELEGATE_INVALID }
  const delegateId = String(input.delegateId ?? '').trim()
  if (!delegateId || delegateId === owner || !index.has(delegateId)) return { error: APPROVAL_ERRORS.DELEGATE_INVALID }

  const from = String(input.from ?? '').trim()
  const to = String(input.to ?? '').trim()
  if (!isCalendarDate(from) || !isCalendarDate(to) || from > to) return { error: APPROVAL_ERRORS.DELEGATE_INVALID }

  const period = { from, to }
  for (const raw of Array.isArray(existingDelegates) ? existingDelegates : []) {
    if (!raw || typeof raw !== 'object') continue
    const rowOwner = String(raw.accountId ?? '').trim()
    const rowDelegate = String(raw.delegateId ?? '').trim()
    const rowFrom = String(raw.from ?? '').trim()
    const rowTo = String(raw.to ?? '').trim()
    if (!rowOwner || !rowDelegate || !isCalendarDate(rowFrom) || !isCalendarDate(rowTo)) continue
    if (rowOwner === owner) continue // 지금 덮어쓰는 자기 행은 사슬 판정에서 뺀다.
    if (!periodsOverlap(period, { from: rowFrom, to: rowTo })) continue
    if (rowOwner === delegateId) return { error: APPROVAL_ERRORS.DELEGATE_CYCLE }
    if (rowDelegate === owner) return { error: APPROVAL_ERRORS.DELEGATE_CYCLE }
  }

  return {
    delegate: {
      recordType: 'delegate',
      id,
      accountId: owner,
      delegateId,
      delegateName: index.get(delegateId) ?? '',
      from,
      to,
      note: clip(input.note, MAX_HELP),
      updatedAt: at,
      updatedById: String(actor?.id ?? '').trim() || owner,
    },
  }
}

/**
 * 지금 결재를 기다리는 단계. 번호는 **양쪽 다 정수일 때만** 맞춘다 —
 * `undefined === undefined` 를 참으로 받으면 단계 번호가 없는 결재선에서 아무 단계나 골라 놓고,
 * 이어지는 반영이 그 단계 하나로 결재선 전체를 덮어써 다른 결재자의 기록을 통째로 지운다.
 */
export const currentStepOf = (document) => {
  const line = Array.isArray(document?.line) ? document.line : []
  const no = document?.currentStep
  if (!Number.isInteger(no)) return null
  return line.find((step) => Number.isInteger(step?.step) && step.step === no) ?? null
}

export const pendingApproverIds = (document) => {
  if (document?.status !== '결재중') return []
  const approvers = currentStepOf(document)?.approvers ?? []
  return approvers.filter((approver) => approver?.decision === 'pending').map((approver) => approver.accountId)
}

/**
 * 이 문서를 올린 사람인가. 기안자 판정은 이 문장 하나뿐이고, 회수·수정·자기결재 차단이 모두 이것을 쓴다.
 * 양쪽을 실제 문자열로 읽는다 — `undefined === undefined` 가 참이라는 이유로 권한이 열리는 자리를 없앤다.
 * (이 모듈에는 문서를 만드는 함수가 없어 drafterId 가 반드시 채워져 있다는 보장이 없다.)
 */
const isDrafter = (document, accountId) => {
  const owner = String(document?.drafterId ?? '').trim()
  const who = String(accountId ?? '').trim()
  return Boolean(owner) && owner === who
}

/**
 * 회수는 「아직 아무도 보지 않았을 때」만 된다. 한 명이라도 승인했으면 그 승인을 없던 일로 만드는 셈이라
 * 이력이 거짓말을 하게 된다 — 그때는 반려를 받거나 그대로 두는 수밖에 없다.
 */
export const canRecall = (document, actorId) => isDrafter(document, actorId) && document?.status === '결재중'
  && (Array.isArray(document?.line) ? document.line : []).every(
    (step) => (Array.isArray(step?.approvers) ? step.approvers : []).every((approver) => approver?.decision === 'pending'),
  )

export const canEditDraft = (document, actorId) => isDrafter(document, actorId) && document?.status === '기안'

/**
 * 금액 게시. 금액 집계 항목이 없거나, 값이 수가 아니거나, 0 이하면 **null** 이다.
 * 0원 게시를 만들면 집계 화면에 「0원짜리 승인 3건」이라는 가짜 사실이 생긴다(PRODUCT.md: 없으면 없다고 한다).
 * 월 경계는 billingMonth(Asia/Seoul)를 그대로 쓴다 — 이 저장소에 KST 월을 만드는 문장은 그것 하나뿐이다.
 */
export function approvalPosting(form, document, now) {
  const at = requireNow(now)
  const fieldKey = String(form?.amountFieldKey ?? '').trim()
  if (!fieldKey) return null
  const amount = document?.values?.[fieldKey]
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return null
  return { month: billingMonth(at), amount, currency: 'KRW', fieldKey, kind: String(document?.kind ?? ''), postedAt: at }
}

function pushHistory(history, entry) {
  const list = Array.isArray(history) ? history : []
  // 오래된 것부터 잘린다 — 최근 결재가 이력에서 밀려나면 「지금 무슨 일이 있었나」를 볼 수 없다.
  return [...list, entry].slice(-MAX_HISTORY)
}

/**
 * 이 사람이 지금 이 문서에서 채울 수 있는 자리 — 결재 자격 판정의 **유일한** 술어.
 * `applyApprovalDecision`(실제 결재)과 「내 결재함」·배지(목록)가 같은 문장을 써야
 * 「대기 중이라고 표시된 문서를 눌렀더니 403」이 생기지 않는다.
 * → `{ seat, delegateOf, step }` | `{ error }`
 *
 * 여기서 못 박는 사실 셋:
 *
 * 1) **기안자는 자기 문서를 결재하지 않는다.** 결재선에 이름이 적혔을 때는 기안 시점에 LINE_SELF 가
 *    막지만, 결재자의 대결자로 지정되면 결재선에는 이름이 없다. 같은 사실이므로 판정은 여기 함께 둔다.
 *
 * 2) **한 사람은 이 결재선에서 자리 하나다.** 「자리」는 이름이 적힌 자리(`accountId`)와 대결로 눌러
 *    채운 자리(`decidedById`)를 함께 뜻하고, 범위는 **결재선 전체**다 — 기안 때 LINE_DUPLICATE 가
 *    보는 범위와 글자 그대로 같다. 범위를 한 단계로 좁히면 이름으로 막은 「같은 사람이 두 번」이
 *    대결 경로로 되살아나, 여러 결재자의 대결을 함께 맡은 한 사람이 단계를 옮겨 가며 다단계 결재선을
 *    혼자 최종 승인한다(관리자는 D17의 대결 지정만으로 그 자리에 설 수 있다).
 *    그래서 대결은 **이 결재선에 아직 아무 자리도 갖지 않은 사람만** 맡는다. 자기 이름이 뒤 단계에
 *    적힌 사람에게 앞 단계의 대결 자리를 내주면, 정작 자기 자리에서 스스로 잠겨 아무도 못 푸는
 *    교착이 된다(회수도 이미 닫혀 있다).
 *
 * 3) **어긋난 결재선은 진행하지 않는다.** 단계 번호는 배열 순서대로 1..N 이어야 하고(`normalizeApprovalLine`
 *    이 그렇게만 만든다), `currentStep` 앞의 단계는 전원 승인이어야 한다. 번호가 겹치면 `currentStepOf` 가
 *    앞의 것만 골라 뒷 단계가 통째로 건너뛰어진 채 「승인」+completedAt 이 찍히고, 앞 단계가 pending 인
 *    문서를 그대로 진행하면 아무도 보지 않은 단계를 남긴 채 문서가 끝난다.
 */
export function approvalSeatFor(document, { actorId, delegateFor } = {}) {
  const { id: actor } = requireActor({ id: actorId })
  // 상신 전(`기안`)과 종결(`승인`·`반려`·`회수`)을 가른다 — 둘 다 결재할 수 없지만 푸는 길이 다르다.
  if (document?.status === '기안') return { error: APPROVAL_ERRORS.NOT_SUBMITTED }
  if (document?.status !== '결재중') return { error: APPROVAL_ERRORS.ALREADY_DECIDED }

  const line = Array.isArray(document?.line) ? document.line : []
  // 번호가 배열 순서대로 1..N 인가 — 이 결재선이 성한지 묻는 문장은 여기 하나뿐이고,
  // 진행(applyApprovalDecision)은 이 사실 위에서 배열 위치로만 다음 단계를 고른다.
  if (line.some((entry, position) => entry?.step !== position + 1)) return { error: APPROVAL_ERRORS.LINE_BROKEN }
  const step = currentStepOf(document)
  if (!step || !Array.isArray(step.approvers)) return { error: APPROVAL_ERRORS.LINE_BROKEN }
  const approversOf = (entry) => (Array.isArray(entry?.approvers) ? entry.approvers : [])
  const behind = line.slice(0, line.indexOf(step))
  if (behind.some((entry) => !approversOf(entry).every((approver) => approver?.decision === 'approved'))) {
    return { error: APPROVAL_ERRORS.LINE_BROKEN }
  }

  if (isDrafter(document, actor)) return { error: APPROVAL_ERRORS.NOT_APPROVER }

  // 이 결재선에서 이 사람이 가진 자리 전부. 아래 판정의 근거는 이 배열 하나뿐이다.
  const held = line.flatMap(approversOf).filter(
    (approver) => approver?.accountId === actor || approver?.decidedById === actor,
  )
  // 자리에 남는 decidedById 는 §1.3 이 선언한 여섯 필드에 없어서, 저장·재적재가 선언대로만 옮기면
  // 떨어져 나간다. 그때도 「내가 남을 대신해 한 자리를 눌렀다」는 사실은 이력에 남는다(actorId + delegateOf).
  // 같은 사실을 두 기록에서 읽되, 판정하는 문장은 바로 아래 한 줄뿐이다.
  const pressedForOther = (Array.isArray(document?.history) ? document.history : []).some(
    (entry) => String(entry?.actorId ?? '').trim() === actor && Boolean(entry?.delegateOf),
  )
  // 이미 한 자리를 결재했다면 이 문서에서 이 사람의 차례는 끝났다. 「자격이 없다」와는 다른 사실이므로
  // 다르게 답한다 — 이 답을 받는 사람은 이미 이 결재선 안에 있어(눌렀거나 이름이 적혔다)
  // 결재선 구성이 새어 나가지 않고, 화면은 「원결재자를 기다리거나 대결자를 바꾸라」고 말할 수 있다.
  if (pressedForOther || held.some((approver) => approver.decision !== 'pending')) return { error: APPROVAL_ERRORS.SEAT_TAKEN }

  const waiting = step.approvers.filter((approver) => approver?.decision === 'pending')
  const own = waiting.find((approver) => held.includes(approver))
  if (own) return { seat: own, delegateOf: null, step }

  // 여기부터는 대결 자리다. 대결은 이 결재선에 아직 아무 자리도 갖지 않은 사람만 맡는다.
  const delegates = new Set(idList(delegateFor))
  const seat = waiting.find((approver) => delegates.has(approver.accountId))
  if (!seat) return { error: APPROVAL_ERRORS.NOT_APPROVER }
  // 자기 이름이 다른 단계에 적힌 사람에게 이 자리를 내주면 자기 자리에서 스스로 잠겨 아무도 못 푸는
  // 교착이 된다(회수도 이미 닫혀 있다). 답은 「당신 차례가 아니다」로 같지만 푸는 길이 다르므로
  // 이유를 붙여 보낸다 — 화면은 「결재선에 이름이 있는 사람은 대결로 눌러 줄 수 없다. 다른 사람을
  // 대결자로 지정하면 풀린다」(D17)를 말할 수 있고, 결재선 밖 사람에게는 이 이유가 가지 않는다.
  if (held.length > 0) return { error: { ...APPROVAL_ERRORS.NOT_APPROVER, reason: 'delegate-has-own-seat' } }
  return { seat, delegateOf: seat.accountId, step }
}

/**
 * 목록·배지가 쓰는 얼굴. 실제 결재와 **같은 함수**를 부르므로 둘의 답이 갈릴 수 없다.
 * 술어는 던지지 않는다 — 세션 id 를 아직 모르는 한 프레임에서 배지 하나 때문에 목록이 통째로 깨지면 안 된다.
 * 쓰는 함수(applyApprovalDecision·approvalSeatFor)는 그대로 던진다: 쓰기는 던지고 읽기는 답한다.
 */
export const canDecide = (document, actorId, delegateFor) => {
  if (!String(actorId ?? '').trim()) return false
  return Boolean(approvalSeatFor(document, { actorId, delegateFor }).seat)
}

/**
 * 결재 한 번을 문서에 반영한다. 입력 문서를 변형하지 않고 새 문서를 돌려준다.
 *
 * `delegateFor`: 이 행위자가 대결자로 지정된 **원결재자 id 집합**. 라우트가 오늘(KST)이 기간 안인
 * 대결 행만 모아 만든다. 대결의 대결은 없다 — 집합을 만드는 곳에서 한 단계로 끊는다.
 *
 * 「누가 지금 이 문서를 결재할 수 있는가」는 이 함수가 다시 판정하지 않고 `approvalSeatFor` 하나에 맡긴다 —
 * 목록이 보여 주는 것과 실제로 통과하는 것이 갈리지 않게 하려면 두 곳이 같은 함수를 불러야 한다.
 */
export function applyApprovalDecision(document, { actorId, actorName, decision, comment, reason, now, delegateFor } = {}) {
  const at = requireNow(now)
  // 행위자는 세션에서만 온다. 없으면 배선이 잘못된 것이므로 「행위자가 빈 문자열인 승인」을 남기지 않고 던진다.
  const { id: actor, name } = requireActor({ id: actorId, name: actorName })
  if (decision !== 'approve' && decision !== 'reject') return { error: { ...APPROVAL_ERRORS.VALUE_INVALID, key: 'decision' } }

  const found = approvalSeatFor(document, { actorId: actor, delegateFor })
  if (found.error) return { error: found.error }
  const { seat: hit, delegateOf, step } = found

  const trimmedReason = clip(reason, MAX_REJECTION_REASON)
  if (decision === 'reject' && trimmedReason.length < MIN_REJECTION_REASON) return { error: APPROVAL_ERRORS.REASON_REQUIRED }

  const decided = {
    ...hit,
    decision: decision === 'approve' ? 'approved' : 'rejected',
    decidedAt: at,
    // 누가 실제로 눌렀는지를 자리에 남긴다 — 대결이면 accountId(원결재자)와 다른 사람이고,
    // 「한 사람이 한 단계에서 자리 하나」를 다음 요청에서 판정할 근거가 이 값 하나뿐이다.
    decidedById: actor,
    comment: clip(comment, MAX_COMMENT),
    ...(delegateOf ? { delegateOf } : {}),
  }
  const nextStep = { ...step, approvers: step.approvers.map((approver) => (approver === hit ? decided : approver)) }
  // 단계를 되찾는 근거는 객체 자체다 — 번호를 다시 읽지 않으므로 「어느 단계를 골랐는가」와
  // 「어느 단계를 바꾸는가」가 갈릴 자리가 없다(성한 결재선인지는 approvalSeatFor 가 이미 물었다).
  const position = document.line.indexOf(step)
  const nextLine = document.line.map((entry) => (entry === step ? nextStep : entry))
  const version = Number.isFinite(document.version) ? document.version + 1 : 1

  if (decision === 'reject') {
    // 병렬이라도 한 사람이 반려하면 문서가 반려된다. 남은 결재자는 pending 으로 남겨
    // 「누가 아직 보지 않았는가」가 이력에 그대로 남게 한다.
    return {
      document: {
        ...document,
        line: nextLine,
        status: '반려',
        rejectionReason: trimmedReason,
        currentStep: nextStep.step,
        completedAt: at,
        updatedAt: at,
        version,
        history: pushHistory(document.history, { at, actorId: actor, actorName: name, action: '반려', comment: trimmedReason, delegateOf }),
      },
    }
  }

  // 순차(1명)와 병렬(전원)이 같은 문장을 쓴다 — 진행 규칙은 하나고, 모드는 결재선을 만들 때만 갈린다.
  const stepDone = nextStep.approvers.every((approver) => approver?.decision === 'approved')
  // 「몇 번째 단계인가」는 배열 위치가 답이다. 번호가 성한지(1..N)는 approvalSeatFor 가 이미 물었으므로
  // 여기서 번호를 다시 견주지 않는다 — 같은 사실을 두 곳에서 확인하면 둘이 갈리는 날이 온다.
  const isLast = position === nextLine.length - 1
  const status = stepDone && isLast ? '승인' : '결재중'
  const nextNo = stepDone && !isLast ? nextLine[position + 1].step : nextStep.step
  const action = status === '승인' ? '최종 승인' : stepDone ? `${nextStep.step}단계 승인` : '승인'
  return {
    document: {
      ...document,
      line: nextLine,
      status,
      currentStep: nextNo,
      completedAt: status === '승인' ? at : null,
      updatedAt: at,
      version,
      history: pushHistory(document.history, { at, actorId: actor, actorName: name, action, comment: clip(comment, MAX_COMMENT), delegateOf }),
    },
  }
}

/** 'YYYY-MM' 에 개월을 더하거나 뺀다. 날짜 산술을 하지 않으므로 표준시·윤일에 흔들리지 않는다. */
function shiftMonth(month, delta) {
  const [year, index] = month.split('-').map(Number)
  const total = year * 12 + (index - 1) + delta
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`
}

/**
 * 승인된 지출 집계 — 판정 9의 「승인된 지출」 패널이 읽는다.
 *
 * 창 안의 달은 금액이 0이어도 모두 나온다. 빈 달을 빼면 막대 6개짜리 그림에서 한 달이 통째로
 * 사라져 「그 달에는 아무 일도 없었다」와 「그 달을 안 세었다」를 구별할 수 없다.
 * byKind 의 합은 언제나 그 달의 amount·count 와 같다 — 세는 것과 말하는 수가 어긋나지 않게
 * 같은 순회에서 둘을 함께 올린다.
 *
 * `scopeIds` 를 주면 그 사람들이 기안한 문서만 센다(직원은 자기 것만 본다).
 * 창 크기(`months`)는 **선언된 상한 안에서만** 받는다 — 구조는 자르지 않고 거절한다.
 * 조용히 24로 자르면 36개월을 달라고 한 화면이 24개월을 받고도 잘렸다는 것을 알 길이 없다.
 */
export function summarizePostings(documents, { months = DEFAULT_POSTING_MONTHS, now, scopeIds = null } = {}) {
  const at = requireNow(now)
  if (!Number.isInteger(months) || months < MIN_POSTING_MONTHS || months > MAX_POSTING_MONTHS) {
    return { error: { ...APPROVAL_ERRORS.VALUE_INVALID, key: 'months' } }
  }
  const span = months
  const last = billingMonth(at)
  const buckets = new Map()
  for (let offset = span - 1; offset >= 0; offset -= 1) {
    const month = shiftMonth(last, -offset)
    buckets.set(month, { month, amount: 0, count: 0, kinds: new Map() })
  }
  const scope = scopeIds == null ? null : new Set(idList(scopeIds))

  for (const document of Array.isArray(documents) ? documents : []) {
    // 「승인된 지출」이라고 이름 붙었으면 그 사실을 이 함수가 직접 읽는다. 게시를 어느 시점에 찍든
    // 반려·회수된 문서의 금액이 월 합계에 섞이지 않는다 — 다른 파일의 순서에 기대지 않는다.
    if (document?.status !== '승인') continue
    const posting = document.posting
    if (!posting || typeof posting !== 'object' || Array.isArray(posting)) continue
    // 통화가 섞이면 더한 수가 아무 뜻이 없다. 오늘 만드는 게시는 전부 KRW 다.
    if (posting.currency != null && posting.currency !== 'KRW') continue
    const bucket = buckets.get(String(posting.month ?? ''))
    if (!bucket) continue
    if (scope && !scope.has(String(document?.drafterId ?? ''))) continue
    const amount = posting.amount
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) continue

    const kind = clip(posting.kind ?? document?.kind, MAX_LABEL) || '기타'
    bucket.amount += amount
    bucket.count += 1
    const entry = bucket.kinds.get(kind) ?? { kind, amount: 0, count: 0 }
    entry.amount += amount
    entry.count += 1
    bucket.kinds.set(kind, entry)
  }

  return {
    months: [...buckets.values()].map(({ month, amount, count, kinds }) => ({
      month,
      amount,
      count,
      byKind: [...kinds.values()].sort((a, b) => b.amount - a.amount || a.kind.localeCompare(b.kind, 'ko')),
    })),
  }
}

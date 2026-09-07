import { randomBytes } from 'node:crypto'

/**
 * 문서(위키)의 블록 — 모양·상한·링크·파생 텍스트. 순수 모듈이다(저장소·요청을 모른다).
 *
 * 왜 타입별 규격을 표 하나(`BLOCK_SPEC`)로 두는가: 검증·타입 변경·기본값 채우기가 같은 사실을 세 번
 * 적으면 언젠가 한 곳만 낡는다. 낡은 한 곳이 곧 "슬래시 메뉴로 바꾸면 level이 남아 있는 todo"가 되고,
 * 그 블록은 화면마다 다르게 그려진다. 규격은 여기 한 벌뿐이고 나머지는 전부 이 표를 읽는다.
 *
 * 왜 자르지 않고 거절하는가: 상한을 넘긴 본문을 조용히 잘라 저장하면 사람이 방금 친 문장이 사라지고,
 * 그 사실은 새로 고친 뒤에야 드러난다. 길이·모양은 전부 400으로 되돌린다 — 자르는 곳은 파생값
 * (searchText·요약·미리보기)뿐이고, 그 셋은 원본이 따로 남아 있다.
 */

// ── 상한 ────────────────────────────────────────────────────────────────────
export const MAX_DOCUMENTS_PER_TENANT = 500
export const MAX_BLOCKS_PER_DOCUMENT = 500
/** 실효 상한. 블록 수 × 블록 길이가 아니라 문서 총합이 응답 크기를 정한다(express.json 4mb 안). */
export const MAX_DOCUMENT_TEXT = 200_000
export const MAX_BLOCK_TEXT = 4_000
export const MAX_CODE_TEXT = 20_000
export const MAX_TITLE = 200
export const MAX_ICON = 8
export const MAX_CAPTION = 200
export const MAX_TABLE_ROWS = 30
export const MAX_TABLE_COLS = 8
export const MAX_CELL = 200
export const MAX_INDENT = 3
export const MAX_OPS_PER_BATCH = 50
export const MAX_TOMBSTONES = 200
export const MAX_RECENT_OP_IDS = 200
export const MAX_LINK_LABEL = 80
export const MAX_SEARCH_TEXT = 20_000
export const MAX_SEARCH_SCAN_DOCUMENTS = 300
export const MAX_TREE_DEPTH_UI = 3
export const MAX_SUMMARY = 400
export const ARCHIVE_RETENTION_DAYS = 30
export const PRESENCE_TTL_MS = 45_000
export const PRESENCE_HEARTBEAT_MS = 15_000
export const PRESENCE_MIN_INTERVAL_MS = 5_000

// ── 식별자 ──────────────────────────────────────────────────────────────────
export const BLOCK_ID_RE = /^BLK-[A-Za-z0-9_-]{8,40}$/
export const DOCUMENT_ID_RE = /^WDOC-[A-Za-z0-9_-]{4,40}$/
export const OP_ID_RE = /^OP-[A-Za-z0-9_-]{6,40}$/
/** 첨부는 기업 자료실의 문서 id다 — `chat-attachments.mjs:26`과 같은 형식을 쓴다. */
export const ATTACHMENT_ID_RE = /^DOC-[A-Za-z0-9_-]{4,160}$/

const base36 = () => Date.now().toString(36).toUpperCase()
export const newBlockId = () => `BLK-${base36()}-${randomBytes(3).toString('hex').toUpperCase()}`
export const newDocumentId = () => `WDOC-${base36()}-${randomBytes(2).toString('hex').toUpperCase()}`
export const newOpId = () => `OP-${base36()}-${randomBytes(3).toString('hex').toUpperCase()}`

// ── 타입 ────────────────────────────────────────────────────────────────────
export const BLOCK_TYPES = Object.freeze(['heading', 'text', 'bulleted', 'numbered', 'todo', 'table', 'image', 'file', 'code', 'quote', 'divider'])
/** 슬래시 메뉴가 서로 바꿀 수 있는 타입. 이 울타리 밖의 변경은 삭제 + 삽입이지 변경이 아니다. */
export const TEXTUAL_TYPES = Object.freeze(['text', 'heading', 'bulleted', 'numbered', 'todo', 'quote', 'code'])
export const LIST_TYPES = Object.freeze(['bulleted', 'numbered', 'todo'])
export const CODE_LANGUAGES = Object.freeze(['', 'text', 'javascript', 'typescript', 'python', 'sql', 'json', 'yaml', 'bash', 'html', 'css', 'java', 'go'])
export const HEADING_LEVELS = Object.freeze([1, 2, 3])

/** 서버만 쓰는 필드. 클라이언트가 보내면 무시하지 않고 거절한다 — 무시하면 클라 버그가 영영 안 드러난다. */
export const SERVER_OWNED_BLOCK_FIELDS = Object.freeze(['seq', 'editedById', 'editedAt', 'workItemId'])

export const WIKI_BLOCK_INVALID = 'WIKI_BLOCK_INVALID'
export const WIKI_BLOCK_TYPE_CHANGE_FORBIDDEN = 'WIKI_BLOCK_TYPE_CHANGE_FORBIDDEN'
/** 본문이 **지금 이 블록의 타입에서만** 너무 길다. 다른 타입에서는 적법한 길이라 클라 버그가 아니다. */
export const WIKI_BLOCK_TOO_LONG_FOR_TYPE = 'WIKI_BLOCK_TOO_LONG_FOR_TYPE'

export const LINK_GONE_LABEL = '삭제된 항목'
export const LINK_HIDDEN_LABEL = '접근 권한 없음'
export const LINK_UNTITLED_LABEL = '제목 없음'

/**
 * 타입별 규격 한 벌.
 * `required`는 새 블록을 만들 때 반드시 있어야 하는 필드, `optional`은 없으면 기본값이 들어가는 필드다.
 * 여기 없는 필드는 그 타입에 존재할 수 없다 — 타입을 바꾸면 표에서 사라진 필드가 블록에서도 사라진다.
 */
const BLOCK_SPEC = Object.freeze({
  heading: { required: ['text'], optional: ['level'], maxText: MAX_TITLE },
  text: { required: ['text'], optional: [], maxText: MAX_BLOCK_TEXT },
  quote: { required: ['text'], optional: [], maxText: MAX_BLOCK_TEXT },
  bulleted: { required: ['text'], optional: ['indent'], maxText: MAX_BLOCK_TEXT },
  numbered: { required: ['text'], optional: ['indent'], maxText: MAX_BLOCK_TEXT },
  todo: { required: ['text', 'checked'], optional: ['indent'], maxText: MAX_BLOCK_TEXT },
  code: { required: ['text'], optional: ['language'], maxText: MAX_CODE_TEXT },
  divider: { required: [], optional: [] },
  table: { required: ['rows'], optional: [] },
  image: { required: ['attachmentId'], optional: ['text'], maxText: MAX_CAPTION },
  file: { required: ['attachmentId'], optional: ['text'], maxText: MAX_CAPTION },
})

const DEFAULTS = Object.freeze({ text: '', level: 2, indent: 0, checked: false, language: '', rows: [], attachmentId: '' })

const fieldsOf = (type) => [...BLOCK_SPEC[type].required, ...BLOCK_SPEC[type].optional]

/**
 * 어떤 타입에서도 본문이 넘을 수 없는 값(= 타입별 상한 중 가장 큰 것, 지금은 code의 20_000).
 * 규격 표에서 계산하므로 표가 바뀌면 함께 움직인다 — 손으로 적으면 언젠가 한쪽만 낡는다.
 *
 * 왜 필요한가: 목적지 블록이 이미 지워졌거나 남이 모양을 바꿨으면 그 본문은 `applyPatch`를 지나지
 * 못하고 곧장 이력(`lostEdits`)으로 간다. 그 갈래에는 상한이 하나도 없어서, 선언된 §1-4 상한이
 * **본문이 실제로 저장되는 경로 중 하나에서만** 걸리지 않는다. 병합기가 op을 받자마자 이 값으로 한 번 본다.
 */
export const MAX_ANY_BLOCK_TEXT = Math.max(...Object.values(BLOCK_SPEC).map((spec) => spec.maxText ?? 0))

/** 어떤 타입에서든 클라이언트가 보낼 수 있는 필드 이름 전부. 서버 소유 필드는 여기 없다. */
const CLIENT_BLOCK_FIELDS = Object.freeze(
  new Set(Object.keys(BLOCK_SPEC).flatMap((type) => fieldsOf(type))),
)

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const bad = (field, code = WIKI_BLOCK_INVALID) => ({ ok: false, field, code })

/**
 * `bad`와 같되 **튕긴 이유가 클라이언트가 보낸 값 자체가 아니라 이 블록의 지금 모양**이라고 표시한다 —
 * 같은 patch를 클라이언트가 보고 있던 모양에 얹었다면 통과했거나(= 남이 먼저 타입을 바꿨다),
 * 애초에 그 값이 아니라 목표 타입의 규격이 좁아서 걸린 것이라는 뜻이다.
 *
 * 병합기가 이 표시를 읽어 배치 전체를 400으로 되돌리는 대신 그 op 하나만 거절한다. 표시가 없으면
 * "남이 먼저 고쳤다"와 "클라이언트가 틀린 모양을 보냈다"가 한 오류로 뭉개지고, 앞의 것이 같은 배치의
 * 멀쩡한 편집까지 영구히 죽인다(재전송해도 같은 결과라 사람이 쓴 글자가 되돌아올 길이 없다).
 */
const staleShape = (field, code = WIKI_BLOCK_INVALID) => ({ ok: false, field, code, staleShape: true })

/**
 * 이 실패가 **길이 축**인가 — 즉 같은 값이 다른 타입에서는 적법한가.
 *
 * 본문 상한만이 타입에 따라 달라지는 축이다(제목 200 · 문단 4_000 · 코드 20_000). 나머지 필드
 * (level·indent·checked·language·attachmentId·rows)는 타입과 무관한 값 검사라, 튕겼다면 클라이언트가
 * 틀린 것이 맞다. 그래서 "지금 타입에서는 너무 길다"는 클라 버그가 아니라 셋 중 하나다:
 *   (a) 남이 슬래시 메뉴로 타입을 좁혔고 낡은 op이 그 위에 얹혔다(클라이언트는 더 넓은 상한을 보고 있었다),
 *   (b) 이 op 자체가 좁은 타입으로 바꾸는 중이고 **기존 본문**이 그 상한을 넘는다(300자 문단 → 제목),
 *   (c) 둘이 겹쳤다.
 * 어느 쪽이든 클라이언트가 같은 배치를 다시 보내도 결과가 같으므로, 배치 전체를 400으로 되돌리면
 * 같은 배치의 멀쩡한 편집이 영영 돌아오지 못한다. **어떤 타입에도 얹힐 수 없는 길이**만이 진짜 클라
 * 버그이고(`MAX_ANY_BLOCK_TEXT` 초과), 그것은 병합기가 op을 받자마자 목적지와 무관하게 막는다.
 */
const tooLongForType = (type, field, value) => (
  field === 'text' && typeof value === 'string'
  && value.length > (BLOCK_SPEC[type].maxText ?? 0) && value.length <= MAX_ANY_BLOCK_TEXT
)

/** 필드 하나의 값 검사. 통과하면 { ok:true, value }, 아니면 { ok:false }. */
function checkField(type, field, value) {
  switch (field) {
    case 'text': {
      if (typeof value !== 'string') return { ok: false }
      return value.length <= BLOCK_SPEC[type].maxText ? { ok: true, value } : { ok: false }
    }
    case 'level':
      return HEADING_LEVELS.includes(value) ? { ok: true, value } : { ok: false }
    case 'indent':
      return Number.isInteger(value) && value >= 0 && value <= MAX_INDENT ? { ok: true, value } : { ok: false }
    case 'checked':
      return typeof value === 'boolean' ? { ok: true, value } : { ok: false }
    case 'language':
      return CODE_LANGUAGES.includes(value) ? { ok: true, value } : { ok: false }
    case 'attachmentId':
      return typeof value === 'string' && ATTACHMENT_ID_RE.test(value) ? { ok: true, value } : { ok: false }
    case 'rows': {
      if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TABLE_ROWS) return { ok: false }
      const width = Array.isArray(value[0]) ? value[0].length : -1
      if (width < 1 || width > MAX_TABLE_COLS) return { ok: false }
      const rows = []
      for (const row of value) {
        if (!Array.isArray(row) || row.length !== width) return { ok: false }
        for (const cell of row) if (typeof cell !== 'string' || cell.length > MAX_CELL) return { ok: false }
        rows.push([...row])
      }
      return { ok: true, value: rows }
    }
    default:
      return { ok: false }
  }
}

/**
 * 클라이언트가 보낼 수 있는 키만 남았는지 본다. 미지 키·서버 소유 필드는 그 키 이름으로 거절한다.
 *
 * 그 타입에는 없지만 **다른 타입에는 있는** 필드(`text`가 표에, `checked`가 문단에 온 경우)는
 * 클라이언트가 본 모양과 지금 모양이 다르다는 뜻이므로 `staleShape`로 표시한다 — 클라 버그가 아니다.
 */
function rejectForeignKeys(raw, type, { allowId }) {
  const allowed = new Set(['type', ...fieldsOf(type)])
  if (allowId) allowed.add('id')
  for (const key of Object.keys(raw)) {
    if (SERVER_OWNED_BLOCK_FIELDS.includes(key)) return bad(key)
    if (allowed.has(key)) continue
    return CLIENT_BLOCK_FIELDS.has(key) ? staleShape(key) : bad(key)
  }
  return null
}

/**
 * 새 블록 하나. 통과하면 `{ ok:true, block }` — block에는 그 타입의 필드만 들어 있다.
 * seq·editedById·editedAt은 여기서 붙이지 않는다(병합기가 붙인다).
 */
export function validateNewBlock(raw) {
  if (!isPlainObject(raw)) return bad('block')
  if (typeof raw.id !== 'string' || !BLOCK_ID_RE.test(raw.id)) return bad('id')
  if (typeof raw.type !== 'string' || !BLOCK_TYPES.includes(raw.type)) return bad('type')
  const foreign = rejectForeignKeys(raw, raw.type, { allowId: true })
  if (foreign) return foreign

  const block = { id: raw.id, type: raw.type }
  for (const field of BLOCK_SPEC[raw.type].required) {
    if (!Object.hasOwn(raw, field)) return bad(field)
    const checked = checkField(raw.type, field, raw[field])
    if (!checked.ok) return bad(field)
    block[field] = checked.value
  }
  for (const field of BLOCK_SPEC[raw.type].optional) {
    if (!Object.hasOwn(raw, field)) { block[field] = DEFAULTS[field]; continue }
    const checked = checkField(raw.type, field, raw[field])
    if (!checked.ok) return bad(field)
    block[field] = checked.value
  }
  return { ok: true, block }
}

/**
 * 기존 블록에 부분 수정을 얹는다. 타입 변경은 `TEXTUAL_TYPES` 안에서만 허용하고,
 * 새 타입에 없는 필드는 지우며 새 타입에만 있는 필드는 기본값으로 채운다.
 *
 * `workItemId`는 규격 표 밖의 서버 필드라 규격이 지우지 않는다 — 문단을 목록으로 바꿨다고
 * 그 문단에서 만든 업무와의 연결이 끊기면, 승인 큐가 가리키던 자리가 사라진다.
 */
export function applyPatch(before, patch) {
  if (!isPlainObject(before)) return bad('block')
  if (!isPlainObject(patch)) return bad('block')
  if (Object.hasOwn(patch, 'id') && patch.id !== before.id) return bad('id')

  const nextType = Object.hasOwn(patch, 'type') ? patch.type : before.type
  if (typeof nextType !== 'string' || !BLOCK_TYPES.includes(nextType)) return bad('type')
  if (nextType !== before.type && !(TEXTUAL_TYPES.includes(nextType) && TEXTUAL_TYPES.includes(before.type))) {
    // 슬래시 메뉴가 낼 수 있는 변환(TEXTUAL 안)을 요청했는데 튕겼다면, 튕긴 이유는 **지금 블록의 타입**이다
    // — 클라이언트가 보던 문단이 그 사이에 표가 됐다는 뜻이지 클라이언트가 틀린 것이 아니다.
    return TEXTUAL_TYPES.includes(nextType)
      ? staleShape('type', WIKI_BLOCK_TYPE_CHANGE_FORBIDDEN)
      : bad('type', WIKI_BLOCK_TYPE_CHANGE_FORBIDDEN)
  }
  const foreign = rejectForeignKeys(patch, nextType, { allowId: true })
  if (foreign) return foreign

  const block = { id: before.id, type: nextType }
  for (const field of fieldsOf(nextType)) {
    const source = Object.hasOwn(patch, field) ? patch[field]
      : Object.hasOwn(before, field) ? before[field]
        : DEFAULTS[field]
    const checked = checkField(nextType, field, source)
    // 길이 축은 클라 버그가 아니다(위 `tooLongForType` 주석) — op 하나만 거절하도록 표시하고,
    // 화면이 "제목은 200자까지입니다"라고 말할 수 있게 사유를 따로 준다.
    if (!checked.ok) return tooLongForType(nextType, field, source) ? staleShape(field, WIKI_BLOCK_TOO_LONG_FOR_TYPE) : bad(field)
    block[field] = checked.value
  }
  if (typeof before.workItemId === 'string' && before.workItemId) block.workItemId = before.workItemId
  return { ok: true, block }
}

/**
 * 서버 소유 필드를 뺀, 클라이언트가 보낼 수 있는 모양. 복원·템플릿 복제가 블록을 op으로 되돌릴 때 쓴다.
 * `id`는 넣지 않는다 — 삽입은 붙이고 수정은 붙이면 안 되므로 부르는 쪽이 정한다.
 */
export function blockPayload(block) {
  const type = block?.type
  if (!BLOCK_SPEC[type]) return null
  const payload = { type }
  for (const field of fieldsOf(type)) {
    payload[field] = field === 'rows'
      ? (block.rows ?? []).map((row) => [...row])
      : (Object.hasOwn(block, field) ? block[field] : DEFAULTS[field])
  }
  return payload
}

/** 사람이 편집하는 필드만 비교한다 — seq·editedAt은 항상 다르므로 내용 비교에 넣으면 전부 '바뀜'이 된다. */
export function sameBlockContent(a, b) {
  if (!a || !b || a.type !== b.type) return false
  for (const field of fieldsOf(a.type)) {
    if (field === 'rows') { if (JSON.stringify(a.rows ?? []) !== JSON.stringify(b.rows ?? [])) return false; continue }
    if ((a[field] ?? DEFAULTS[field]) !== (b[field] ?? DEFAULTS[field])) return false
  }
  return (a.workItemId ?? '') === (b.workItemId ?? '')
}

// ── 링크 ────────────────────────────────────────────────────────────────────

/**
 * `[[doc:WDOC-…|보이는 이름]]`. 라벨에 `]`와 개행을 넣을 수 없어 토큰 안에서 토큰을 만들 수 없다.
 *
 * **상태 있는 정규식을 내보내지 않는다.** `/g` 정규식은 `lastIndex`를 들고 다니므로, 공용 상수 하나를
 * 여럿이 나눠 쓰면 누군가 `.test()`를 한 번 부른 뒤 `matchAll`을 도는 쪽이 앞쪽 토큰을 통째로 건너뛴다.
 * 이 모듈에서 그 자리는 **쓰기 시점 링크 인가가 훑는 `linkTokensIn`**이고, 건너뛴 링크는 인가를 받지
 * 못한 채 저장돼 §3-4가 닫아 둔 존재 오라클이 렌더 시점에 다시 열린다. 그래서 부르는 쪽마다 새로 만든다.
 * (같은 파일이 내보내는 다른 `*_RE`는 전부 비-global이라 `.test()`로 써도 안전하다.)
 */
export const LINK_TOKEN_SOURCE = '\\[\\[(doc|task|person):([A-Za-z0-9_-]{1,64})\\|([^\\]\\n]{0,80})\\]\\]'
/** 갓 만든 `/g` 정규식 하나. 호출마다 새 객체이므로 lastIndex가 호출 사이를 넘어가지 않는다. */
export const linkTokenRe = () => new RegExp(LINK_TOKEN_SOURCE, 'g')
export const LINK_KINDS = Object.freeze(['doc', 'task', 'person'])
/** 링크 종류별로 id 접두가 맞아야 한다. 어긋나면 쓰기 시점에 400이다. */
export const LINK_ID_PREFIX = Object.freeze({ doc: 'WDOC-', task: 'WK-', person: 'USR-' })

/** 라벨로 쓸 수 있게 다듬는다 — 토큰을 깨는 글자를 빼고 상한에서 자른다. */
export function linkLabel(title) {
  const cleaned = String(title ?? '').replace(/[[\]\r\n]/gu, ' ').replace(/\s+/gu, ' ').trim()
  return cleaned ? cleaned.slice(0, MAX_LINK_LABEL) : LINK_UNTITLED_LABEL
}

/** 본문에 든 링크 토큰 목록. 쓰기 시점 인가가 이 목록을 훑는다. */
export function linkTokensIn(text) {
  const found = []
  for (const match of String(text ?? '').matchAll(linkTokenRe())) {
    found.push({ token: match[0], kind: match[1], id: match[2], label: match[3] })
  }
  return found
}

/**
 * 본문이 나가는 **모든** 경로에서 통과시킨다. 저장된 라벨은 낡을 수 있으므로 믿지 않고,
 * 볼 수 있으면 지금 제목으로, 못 보면 '접근 권한 없음'으로, 없으면 '삭제된 항목'으로 바꿔 쓴다.
 * `resolve`가 없으면 전부 가린다 — 주입을 잊었을 때 조용히 열리는 쪽이 아니라 닫히는 쪽으로 넘어진다.
 */
export function redactLinks(text, resolve) {
  const source = typeof text === 'string' ? text : ''
  if (!source.includes('[[')) return source
  return source.replace(linkTokenRe(), (_match, kind, id) => {
    const found = typeof resolve === 'function' ? resolve(kind, id) : 'hidden'
    if (found === 'gone') return `[[${kind}:${id}|${LINK_GONE_LABEL}]]`
    if (!found || found === 'hidden' || typeof found !== 'object') return `[[${kind}:${id}|${LINK_HIDDEN_LABEL}]]`
    return `[[${kind}:${id}|${linkLabel(found.title)}]]`
  })
}

/** 토큰을 라벨만 남긴다 — 사람이 읽는 텍스트(내보내기·템플릿 복제)로 내릴 때 쓴다. */
export function stripLinks(text) {
  const source = typeof text === 'string' ? text : ''
  if (!source.includes('[[')) return source
  return source.replace(linkTokenRe(), (_match, _kind, _id, label) => label)
}

/**
 * 토큰을 통째로 지운다(라벨도 남기지 않는다). 검색 색인 전용이다.
 *
 * 왜 라벨까지 지우는가: 색인에 라벨이 남으면 볼 수 없는 업무의 제목을 검색어로 넣어 히트 유무로
 * 존재를 떠볼 수 있다. 대가는 "링크에 쓴 낱말로는 검색되지 않는다"이며, 그 편이 낫다.
 */
export function removeLinks(text) {
  const source = typeof text === 'string' ? text : ''
  if (!source.includes('[[')) return source
  return source.replace(linkTokenRe(), ' ')
}

// ── 파생 텍스트 ─────────────────────────────────────────────────────────────

const collapse = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim()

/**
 * 검색 색인에 실을 한 블록의 문자열. 첨부 id는 절대 싣지 않는다(캡션만).
 *
 * 표도 예외가 아니다 — 셀에도 링크 토큰이 들어온다(`wikiPlainText`가 셀마다 `redactLinks`를 거는 이유가
 * 그것이다). 여기서 빼먹으면 볼 수 없는 업무의 제목을 검색어로 넣어 히트 유무로 존재를 떠보는
 * 오라클이 표 경로로 열린다(D10). 셀을 이어 붙인 **뒤에** 지우므로 셀 경계를 넘는 토큰도 함께 사라진다.
 */
function searchPieceOf(block) {
  if (!block) return ''
  if (block.type === 'divider') return ''
  if (block.type === 'table') return collapse(removeLinks((block.rows ?? []).map((row) => row.join(' ')).join(' ')))
  return collapse(removeLinks(block.text ?? ''))
}

/** 문서 본문의 검색 색인. ops 커밋과 같은 트랜잭션에서 갱신하는 파생 저장값이다. */
export function buildSearchText(blocks) {
  const parts = []
  for (const block of blocks ?? []) {
    const piece = searchPieceOf(block)
    if (piece) parts.push(piece)
  }
  return parts.join('\n').slice(0, MAX_SEARCH_TEXT)
}

/** 문서 본문 총 길이. `MAX_DOCUMENT_TEXT`의 판정 기준이다. */
export function documentTextLength(blocks) {
  let total = 0
  for (const block of blocks ?? []) {
    if (!block) continue
    if (typeof block.text === 'string') total += block.text.length
    if (Array.isArray(block.rows)) for (const row of block.rows) for (const cell of row) total += String(cell ?? '').length
    if (typeof block.attachmentId === 'string') total += block.attachmentId.length
  }
  return total
}

const TYPE_ONLY_LABEL = Object.freeze({ divider: '구분선', image: '이미지', file: '파일' })

/** 목록·이력·diff가 쓰는 한 줄 미리보기. 본문 없는 타입은 라벨로 답한다. */
export function blockPreview(block, resolve, limit = 120) {
  if (!block) return ''
  if (block.type === 'table') {
    const rows = block.rows ?? []
    return `표 ${rows.length}×${rows[0]?.length ?? 0}`
  }
  if (TYPE_ONLY_LABEL[block.type]) {
    const caption = collapse(redactLinks(block.text ?? '', resolve))
    return caption ? `${TYPE_ONLY_LABEL[block.type]} · ${caption}`.slice(0, limit) : TYPE_ONLY_LABEL[block.type]
  }
  return collapse(redactLinks(block.text ?? '', resolve)).slice(0, limit)
}

/** 문서 목록·검색 스니펫의 발췌. */
export function excerptOf(text, limit = 200) {
  const cleaned = collapse(text)
  return cleaned.length <= limit ? cleaned : `${cleaned.slice(0, limit)}…`
}

const TABLE_DIVIDER = (width) => `| ${Array.from({ length: width }, () => '---').join(' | ')} |`

/**
 * 마크다운 본문. 내보내기(`GET /api/wiki/:id/export`)와 렌즈 입력이 같은 문자열을 쓴다.
 * 링크는 먼저 재인가하고(`redactLinks`) 그 다음 표시이름만 남긴다(`stripLinks`) —
 * 옛 버전이라고 인가가 느슨해지지 않는다.
 */
export function wikiPlainText(document, resolve) {
  const lines = []
  const title = String(document?.title ?? '').trim()
  if (title) lines.push(`# ${title}`, '')
  for (const block of document?.blocks ?? []) {
    if (!block) continue
    const text = stripLinks(redactLinks(block.text ?? '', resolve))
    const pad = '  '.repeat(Math.min(Number(block.indent) || 0, MAX_INDENT))
    switch (block.type) {
      case 'heading': lines.push(`${'#'.repeat(HEADING_LEVELS.includes(block.level) ? block.level : 2)} ${text}`); break
      case 'quote': lines.push(text.split('\n').map((line) => `> ${line}`).join('\n')); break
      case 'bulleted': lines.push(`${pad}- ${text}`); break
      case 'numbered': lines.push(`${pad}1. ${text}`); break
      case 'todo': lines.push(`${pad}- [${block.checked ? 'x' : ' '}] ${text}`); break
      case 'code': lines.push(`\`\`\`${block.language ?? ''}`, text, '```'); break
      case 'divider': lines.push('---'); break
      case 'image': lines.push(`![${text || '이미지'}](${block.attachmentId ?? ''})`); break
      case 'file': lines.push(`[${text || '첨부 파일'}](${block.attachmentId ?? ''})`); break
      case 'table': {
        const rows = block.rows ?? []
        if (!rows.length) break
        const cells = (row) => `| ${row.map((cell) => stripLinks(redactLinks(cell, resolve)).replaceAll('|', '\\|')).join(' | ')} |`
        lines.push(cells(rows[0]), TABLE_DIVIDER(rows[0].length), ...rows.slice(1).map(cells))
        break
      }
      default: lines.push(text)
    }
    lines.push('')
  }
  return lines.join('\n').replace(/\n{3,}/gu, '\n\n').trim()
}

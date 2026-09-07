import { randomBytes } from 'node:crypto'

import { GUEST_ROLE, GUEST_SCOPE_FORBIDDEN } from './guest-access.mjs'
import { AI_POLICIES, DEFAULT_BULK_AI_POLICY, AI_POLICY_RANK, documentAiPolicy } from './document-ai-policy.mjs'

/**
 * Flow 파일함 벌크 이관 — 폴더 묶음 하나를 세션 하나로 만든다.
 *
 * 왜 엔트리를 세션 행에 인라인하지 않는가: 자료실이 이미 겪는 결함(persistDocumentList가 매 업로드마다
 * 테넌트 문서 배열 전체를 다시 쓴다)을 이관 도구에서 되풀이하지 않기 위해서다. 5,000 엔트리를 한 행에
 * 담으면 파일 하나 올릴 때마다 수 MB짜리 payload를 재작성한다. 500개씩 끊은 청크 행으로 나누면
 * 파일당 쓰기가 고정 크기가 되고, express.json({limit:'4mb'}) 아래에서 매니페스트를 나눠 보낼 수 있다.
 *
 * 왜 전용 라우트인가: 이 배열에는 행마다 주인이 있고(세션을 만든 사람), 진행 상태는 서버가 진실이다.
 * generic PUT /api/workspace/:key에는 행 단위 소유권 개념이 없어 직원 하나가 남의 이관 상태를
 * 통째로 덮어쓸 수 있다. 그래서 WORKSPACE_STORE_KEYS에 넣지 않았고, generic GET/PUT은 코드 한 줄 없이
 * 404 STORE_KEY_NOT_FOUND로 끝난다(ai-conversations·saved-views가 이미 같은 상태다).
 *
 * 왜 totals를 매번 다시 세는가: 진행 보고는 10건 또는 3초마다 묶여 오고, 같은 배치가 재전송될 수 있다.
 * 누적(+1)으로 세면 재전송 한 번에 숫자가 어긋나고 그 어긋남은 되돌릴 수 없다. 엔트리 상태에서
 * 매번 다시 세면 순서에도 재전송에도 무관하다.
 */

export const BULK_IMPORT_KEY = 'bulk-imports'
export const BULK_IMPORT_RULE_KEY = 'bulk-import-rules'

export const MAX_ENTRIES_PER_SESSION = 5_000
export const MAX_ENTRIES_PER_CHUNK = 500
export const MAX_MANIFEST_PAGE = 200
export const MAX_MAPPING_ROWS = 100
export const MAX_SESSIONS_PER_TENANT = 100
export const MAX_RULES_PER_TENANT = 50
export const MAX_PATH_LENGTH = 400
export const MAX_TAGS_PER_MAPPING = 20
/**
 * 사람이 한 행에 적을 수 있는 태그 수. documentFieldsFor가 예약 태그 두 개('bulk-import',
 * 'import:<세션>')를 앞에 붙인 뒤 MAX_TAGS_PER_MAPPING으로 자르므로, 20개를 받아 두면
 * **마지막 두 개가 말없이 사라진다**. 받을 수 있는 수를 그 사실에 맞춘다.
 */
export const MAX_USER_TAGS_PER_MAPPING = MAX_TAGS_PER_MAPPING - 2
export const MAX_FAILURES_KEPT = 200
export const ENTRY_PAGE_SIZE = 100
export const MAX_PROGRESS_RESULTS = 50
/** 재전송 판정에 기억하는 clientRequestId 개수. 페이지가 200건이므로 40개면 8,000건 분량이다. */
export const MAX_MANIFEST_PAGES_REMEMBERED = 40
/** app.mjs의 express.raw({ limit: '10mb' })와 같은 값. 여기서 미리 알려 500을 받지 않게 한다. */
export const MAX_BULK_FILE_BYTES = 10 * 1024 * 1024
const MAX_NAME_LENGTH = 80
const MAX_TAG_LENGTH = 40
const MAX_ERROR_LENGTH = 200
const MAX_RULE_NAME_LENGTH = 40

export const SHA256_PATTERN = /^[a-f0-9]{64}$/
const SESSION_STATUSES = ['draft', 'mapping', 'uploading', 'paused', 'done', 'failed']
/** 종료 상태에서 나가는 전이는 없다 — 끝난 이관의 숫자가 나중에 바뀌면 보고서가 거짓말이 된다. */
const STATUS_TRANSITIONS = Object.freeze({
  draft: ['mapping', 'uploading'],
  mapping: ['uploading'],
  uploading: ['paused', 'done', 'failed'],
  paused: ['uploading', 'done', 'failed'],
  done: [],
  failed: [],
})

export const OVERSIZE_MESSAGE = '10MB를 넘는 파일은 아직 올릴 수 없습니다.'
/**
 * 재개할 때 그 파일이 **다시 고른 폴더에 없었다**는 사실. 이 문장은 클라이언트가 진행 보고에 싣는다
 * (그 사실을 아는 쪽이 클라이언트뿐이다). 마감 라우트가 남은 pending을 닫을 때는 쓰지 않는다 —
 * '이관 중단'으로 끝낸 이관의 안 올린 파일에게 '다시 선택하지 않았다'는 거짓이기 때문이다.
 *
 * **서버 코드 경로는 이 상수를 읽지 않는다.** 이 파일은 그 문장의 단일 출처이고, 클라이언트 복사본과의
 * 동치를 계약 시험이 글자까지 잠근다 — 한 사실을 두 곳이 각자 쓰면 화면과 보고서가 다른 말을 한다.
 */
export const ABANDONED_MESSAGE = '재개할 때 이 파일을 다시 선택하지 않았습니다.'
/** 마감까지 올라가지 않은 파일. 중단이든 재개 실패든 이 문장은 언제나 참이다. */
export const UNFINISHED_MESSAGE = '이관을 마칠 때까지 올리지 않은 파일입니다.'
/**
 * 클라이언트가 '올렸다'고 보고했는데 그 문서를 자료실에서 찾지 못한 경우.
 * 그 주장을 그대로 받으면 보고서의 '올린 파일 N개 · X MB'가 **저장된 적 없는 바이트**를 센다.
 */
export const UNVERIFIED_UPLOAD_MESSAGE = '올렸다고 보고됐지만 자료실에서 그 자료를 찾지 못했습니다. 다시 시도해 주세요.'
/**
 * 매핑 표 어디에도 걸리지 않은 경로의 문장. **화면의 미리 알림과 서버의 거절이 이 한 문장을 함께 쓴다** —
 * 두 곳이 각자 쓰면 사람은 미리 본 문장과 다른 이유를 나중에 듣게 된다.
 */
export const UNMAPPED_MESSAGE = '매핑 표에 없는 폴더의 파일입니다. 대상 프로젝트가 없는 파일은 회사 전체가 보는 자료가 되므로 회사 관리자만 올릴 수 있습니다. 매핑 표에 이 폴더를 추가해 주세요.'

export const BULK_IMPORT_ERRORS = Object.freeze({
  FORBIDDEN: { status: 403, code: 'BULK_IMPORT_FORBIDDEN', message: '벌크 이관은 회사 관리자, 또는 대상 프로젝트의 관리자·편집자만 할 수 있습니다.' },
  UNMAPPED: { status: 403, code: 'BULK_IMPORT_UNMAPPED', message: UNMAPPED_MESSAGE },
  NOT_FOUND: { status: 404, code: 'BULK_IMPORT_NOT_FOUND', message: '이관 세션을 찾을 수 없습니다.' },
  PATH_INVALID: { status: 400, code: 'BULK_IMPORT_PATH_INVALID', message: '원본 폴더 경로를 읽을 수 없습니다. 폴더를 다시 선택해 주세요.' },
  ENTRY_INVALID: { status: 400, code: 'BULK_IMPORT_ENTRY_INVALID', message: '파일 목록의 형식을 확인해 주세요. 폴더를 다시 선택해 주세요.' },
  PAGE_TOO_LARGE: { status: 413, code: 'BULK_IMPORT_PAGE_TOO_LARGE', message: `파일 목록은 한 번에 ${MAX_MANIFEST_PAGE}개까지 보낼 수 있습니다.` },
  ENTRY_LIMIT: { status: 409, code: 'BULK_IMPORT_ENTRY_LIMIT', message: `한 번의 이관에는 파일 ${MAX_ENTRIES_PER_SESSION}개까지 담을 수 있습니다. 폴더를 나눠 올려 주세요.` },
  SESSION_LIMIT: { status: 409, code: 'BULK_IMPORT_SESSION_LIMIT', message: `이관 기록이 상한(${MAX_SESSIONS_PER_TENANT}개)에 도달했습니다. 끝난 이관 기록을 지워 주세요.` },
  STATUS_INVALID: { status: 409, code: 'BULK_IMPORT_STATUS_INVALID', message: '지금 상태에서는 할 수 없는 동작입니다.' },
  /**
   * '이 파일은 이미 끝났다'는 세션 상태 409(STATUS_INVALID)와 **다른 사실**이라 코드를 나눈다.
   * 재개는 이 응답을 '건너뛴다'로 읽어야 한다. 하나로 묶으면 클라이언트가 연결 실패로 세고,
   * 세 번 만에 스스로 멈춰 다시는 재개하지 못한다(브라우저에서 실제로 그렇게 됐다).
   */
  ENTRY_SETTLED: { status: 409, code: 'BULK_IMPORT_ENTRY_SETTLED', message: '이 파일은 이미 이관을 마쳤습니다. 다시 올리지 않았습니다.' },
  PAUSED: { status: 409, code: 'BULK_IMPORT_PAUSED', message: '이관이 일시 중지되어 있습니다. 이어서 올리기를 누른 뒤 다시 시도해 주세요.' },
  MAPPING_INVALID: { status: 400, code: 'BULK_IMPORT_MAPPING_INVALID', message: '폴더 매핑을 확인해 주세요.' },
  // 클라이언트가 주장한 해시는 서버가 계산하기 전까지 권위가 없다. app.mjs의 업로드 분기가 이 한 문장을 쓴다.
  HASH_MISMATCH: { status: 400, code: 'BULK_IMPORT_HASH_MISMATCH', message: '파일 내용이 매니페스트에 적힌 해시와 다릅니다. 폴더를 다시 선택해 주세요.' },
  AI_LEVEL_INVALID: { status: 400, code: 'BULK_IMPORT_AI_LEVEL_INVALID', message: 'AI 처리 수준을 확인해 주세요.' },
  RULE_LIMIT: { status: 409, code: 'BULK_IMPORT_RULE_LIMIT', message: `저장한 매핑은 ${MAX_RULES_PER_TENANT}개까지 둘 수 있습니다. 쓰지 않는 매핑을 지워 주세요.` },
  RULE_NOT_FOUND: { status: 404, code: 'BULK_IMPORT_RULE_NOT_FOUND', message: '저장된 매핑을 찾을 수 없습니다.' },
  WRITE_FAILED: { status: 500, code: 'BULK_IMPORT_WRITE_FAILED', message: '이관 상태를 저장하지 못했습니다.' },
})

const errorBody = ({ code, message }, extra = {}) => ({ code, message, ...extra })

// ---------------------------------------------------------------------------
// 순수 규칙
// ---------------------------------------------------------------------------

/**
 * 원본 폴더 경로를 표시·필터용 문자열 하나로 정규화한다. 못 읽으면 null.
 *
 * 저장소 키 순회는 normalizeStorageKey(storage/index.mjs)가 이미 막고 있다. 여기서 한 번 더 자르는 이유는
 * sourcePath가 **저장소 키가 아니라 화면에 그려지는 문자열**이기 때문이다 — 제어문자 한 글자가 목록 한 줄을 깨뜨린다.
 * '.' 세그먼트도 거절한다: 뜻이 없고, 남겨 두면 같은 폴더가 두 이름으로 보인다.
 */
export function normalizeImportPath(value) {
  const raw = String(value ?? '').replaceAll('\\', '/')
  if (/[\u0000-\u001f]/.test(raw)) return null
  // 빈 조각을 버리는 것이 '연속 // 축약'과 '선행 / 제거'를 동시에 한다.
  const segments = raw.split('/').filter(Boolean).map((segment) => segment.trim())
  if (!segments.length) return null
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
  const joined = segments.join('/')
  return joined.length > MAX_PATH_LENGTH ? null : joined
}

/** 경로가 이 접두 폴더 안인가. 'Flow/계약'이 'Flow/계약서/x.pdf'를 삼키지 않도록 경계를 본다. */
const underPrefix = (path, prefix) => !prefix || path === prefix || path.startsWith(`${prefix}/`)

export const defaultMappingRow = () => ({ folderPrefix: '', projectId: null, tags: [], aiLevel: DEFAULT_BULK_AI_POLICY })

/**
 * 실제로 걸린 매핑 행. 가장 긴 folderPrefix가 이기고, 길이가 같으면 먼저 선언된 것.
 * 어디에도 안 걸리면 **null** — '기본 행으로 떨어졌다'와 '사람이 그 행을 선언했다'는 다른 사실이고,
 * 그 차이가 곧 "이 파일을 전 직원에게 공개해도 되는가"의 판정 근거다.
 */
export function matchMappingRow(path, mapping) {
  let best = null
  for (const row of Array.isArray(mapping) ? mapping : []) {
    const prefix = String(row?.folderPrefix ?? '')
    if (!underPrefix(path, prefix)) continue
    if (!best || prefix.length > String(best.folderPrefix ?? '').length) best = row
  }
  return best ? { ...defaultMappingRow(), ...best } : null
}

/** 이 경로에 실제로 적용되는 행. 어디에도 안 걸리면 기본 행(자료실·보관만). */
export function resolveMapping(path, mapping) {
  return matchMappingRow(path, mapping) ?? defaultMappingRow()
}

/**
 * 매핑 표 전체. 통과하면 { mapping }, 아니면 { path } — 어느 칸이 문제인지 화면이 가리킬 수 있게.
 *
 * lenient는 **이미 저장된 세션 행을 읽을 때만** 켠다: 상한이 내려가기 전에 저장된 행(태그 20개)을
 * 만나면 자르고 계속 읽는다. 쓰기 경로는 관대하지 않다 — 사람이 방금 적은 태그를 말없이 버리는 대신
 * 어느 칸이 문제인지 돌려준다. 관대 모드가 없으면 그런 행 하나가 표 **전체**를 비우고,
 * 빈 표에서는 모든 경로가 기본 행(대상 프로젝트 없음)으로 떨어져 프로젝트 자료가 전사 공개가 된다.
 */
export function normalizeMapping(value, { lenient = false } = {}) {
  if (value == null) return { mapping: [] }
  if (!Array.isArray(value)) return { path: 'mapping' }
  if (value.length > MAX_MAPPING_ROWS) return { path: 'mapping' }
  const mapping = []
  const seen = new Set()
  for (const [index, row] of value.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return { path: `mapping[${index}]` }
    const rawPrefix = String(row.folderPrefix ?? '')
    const folderPrefix = rawPrefix.trim() ? normalizeImportPath(rawPrefix) : ''
    if (folderPrefix === null) return { path: `mapping[${index}].folderPrefix` }
    if (seen.has(folderPrefix)) return { path: `mapping[${index}].folderPrefix` }
    seen.add(folderPrefix)
    const projectId = row.projectId == null || row.projectId === '' ? null : String(row.projectId).trim()
    if (projectId !== null && (!projectId || projectId.length > 120)) return { path: `mapping[${index}].projectId` }
    if (row.tags != null && !Array.isArray(row.tags)) return { path: `mapping[${index}].tags` }
    const rawTags = Array.isArray(row.tags) ? row.tags : []
    // 예약 태그 두 칸을 남겨 둔다 — 20개를 받아 두면 documentFieldsFor의 slice가 뒤 두 개를 조용히 버린다.
    if (rawTags.length > MAX_USER_TAGS_PER_MAPPING && !lenient) return { path: `mapping[${index}].tags` }
    // 자르는 일은 관대 모드에서만 실제로 일어난다(쓰기 경로는 위에서 이미 거절했다).
    const tags = [...new Set(rawTags.map((tag) => String(tag ?? '').trim()).filter(Boolean))].slice(0, MAX_USER_TAGS_PER_MAPPING)
    if (tags.some((tag) => tag.length > MAX_TAG_LENGTH)) return { path: `mapping[${index}].tags` }
    const aiLevel = row.aiLevel === undefined ? DEFAULT_BULK_AI_POLICY : row.aiLevel
    if (!AI_POLICIES.includes(aiLevel)) return { path: `mapping[${index}].aiLevel` }
    mapping.push({ folderPrefix, projectId, tags, aiLevel })
  }
  return { mapping }
}

/**
 * 매핑 한 줄이 **새로 올라가는 문서**에 남기는 값. 업로드 분기(resolveUpload)만 이 함수를 부른다.
 *
 * 중복 확장 경로는 일부러 다른 길로 간다: 거기서는 문서가 **이미 있고**, 이관은 있던 자료의
 * 분류·태그·AI 수준을 덮어쓰지 않는다(그 자료의 주인이 정한 값이다). 그 갈래가 하는 일은
 * grantDocumentAccess로 열람자 목록을 넓히는 것 하나뿐이고, 그래서 권한 표면이 둘로 갈린다 —
 * 이 주석이 '두 곳이 같은 함수를 쓴다'고 적어 두면 그 갈래를 아무도 다시 보지 않게 된다.
 */
export function documentFieldsFor(row, { sessionId, projectMemberIds = [] }) {
  /**
   * 여기서 다시 자르지 않는다. 상한은 normalizeMapping 한 곳에서만 건다 —
   * 쓰기 경로는 MAX_USER_TAGS_PER_MAPPING을 넘기면 거절하고, 저장된 옛 행은 관대 모드가 그 수로 자른다.
   * 이미 잘린 값을 한 번 더 자르는 줄은 아무것도 막지 못하면서 '여기서도 막고 있다'는 인상만 남긴다.
   */
  const tags = [...new Set(['bulk-import', `import:${sessionId}`, ...(row.tags ?? [])])]
  return row.projectId
    ? { category: '프로젝트', visibility: 'restricted', allowedUserIds: [...new Set(projectMemberIds)], tags, aiPolicy: row.aiLevel, projectId: row.projectId }
    : { category: '공통자료', visibility: 'all', allowedUserIds: [], tags, aiPolicy: row.aiLevel, projectId: null }
}

/**
 * 이 문서가 **대상 프로젝트 구성원 전원**에게 열리는가.
 *
 * 왜 이 판정이 필요한가: 매니페스트가 '중복'으로 닫은 파일은 영영 올라가지 않는다. 그런데 사람이 읽는
 * '이미 있으니 안 올렸다'와 실제 '그 프로젝트에는 없다'가 다르면, 이관한 폴더는 멤버에게 구멍 난 채로 남고
 * 화면도 보고서도 그 사실을 말하지 못한다. 그래서 닫기 전에 **정말 열리는지**를 여기서 본다.
 *
 * 'department'가 false인 이유: 그 부서 밖의 프로젝트 구성원은 그 자료를 열지 못한다.
 * 올린 사람은 언제나 자기 자료를 읽으므로(canReadDocument) 구성원 목록에서 그 한 명은 통과시킨다.
 */
export function documentOpensToProject(document, memberIds = []) {
  if (!document) return false
  if (document.visibility === 'all') return true
  if (document.visibility !== 'restricted') return false
  const allowed = new Set(Array.isArray(document.allowedUserIds) ? document.allowedUserIds : [])
  const owner = String(document.uploadedById ?? '')
  return (Array.isArray(memberIds) ? memberIds : []).every((id) => allowed.has(id) || String(id) === owner)
}

/**
 * 같은 묶음 안의 '먼저 올라갈 파일' 색인 키. **한 함수가 키 모양의 유일한 출처다** —
 * 색인을 채우는 쪽(라우트)과 찾는 쪽(planManifest)이 각자 문자열을 지으면, 그 어긋남은
 * '중복이라 안 올렸다'와 '그 프로젝트에는 없다'가 갈리는 자리에서만 드러난다.
 * \u0000은 목적지에도 지문에도 나올 수 없는 글자라 'A'+'0B'와 'A0'+'B'가 같은 키가 되지 않는다.
 */
export const sameRunAnchorKey = (destination, sha256) => `${destination ?? ''}\u0000${sha256}`

/** 상태 전이. 같은 상태로의 전이는 멱등이고, 표 밖은 null(409). */
export function nextStatus(from, to) {
  if (!SESSION_STATUSES.includes(from) || !SESSION_STATUSES.includes(to)) return null
  if (from === to) return to
  return (STATUS_TRANSITIONS[from] ?? []).includes(to) ? to : null
}

/**
 * 매니페스트 한 페이지의 판정.
 *
 * existingByChecksum에는 **읽을 수 있는** 문서만 들어 있다(라우트가 canReadDocument로 거른다).
 * 볼 수 없는 문서와 같은 해시라는 사실을 알려 주면 그 문서의 존재가 새어 나가기 때문이다 —
 * 그런 파일은 중복이 아니라 새 업로드로 처리한다(사본 하나가 늘 뿐, 정보는 새지 않는다).
 *
 * canCloseDuplicate(path, { documentId | otherPath })는 **중복으로 닫아도 되는가**를 답한다.
 * 닫힌 파일은 영영 올라가지 않으므로, 그 사본이 대상 프로젝트에서 실제로 열릴 때만 닫아야 한다.
 * 여기서는 규칙을 모른다(프로젝트 멤버십은 라우트의 것이다) — 그래서 주입받고, 기본값은 '닫는다'다.
 *
 * anchorKeyFor(path)는 같은 묶음 안의 '먼저 올라갈 파일' 색인을 **목적지별로** 가른다.
 * 해시 하나로만 색인하면 다른 프로젝트로 갈 파일이 서로의 기준이 되고, 그러면 두 번째 프로젝트에는
 * 그 파일이 영영 없다(닫힌 중복은 다시 올라가지 않는다).
 */
export function planManifest({
  entries, existingByChecksum = new Map(), knownByChecksum = new Map(), knownEntries = new Map(),
  maxFileBytes = MAX_BULK_FILE_BYTES, canCloseDuplicate = () => true, anchorKeyFor = () => '',
}) {
  if (!Array.isArray(entries)) return { error: { ...BULK_IMPORT_ERRORS.ENTRY_INVALID, index: 0 } }
  if (entries.length > MAX_MANIFEST_PAGE) return { error: { ...BULK_IMPORT_ERRORS.PAGE_TOO_LARGE } }
  const verdicts = []
  const accepted = []
  const updates = []
  /** 이 페이지가 '중복'으로 닫은, 자료실에 실물이 있는 엔트리. 라우트가 열람 범위를 넓힐 대상이다. */
  const duplicates = []
  for (const [index, raw] of entries.entries()) {
    const path = normalizeImportPath(raw?.path)
    if (!path) return { error: { ...BULK_IMPORT_ERRORS.PATH_INVALID, index } }
    /**
     * 지문은 있으면 64자 소문자 hex여야 하고, **빈 문자열은 허용한다** — 그것이
     * '이 브라우저는 파일 지문을 만들지 못했다'는 사실이다(crypto.subtle은 보안 컨텍스트에만 있다).
     * 그런 엔트리는 중복 색인에 들어가지 않고, 업로드 시점에 서버가 본문을 해싱해 걸러낸다(dedupe=1).
     * 빈 값을 거절하면 사내 LAN(http)에서 연 사람만 기능 전체를 쓰지 못한다.
     */
    const sha256 = String(raw?.sha256 ?? '')
    if (sha256 && !SHA256_PATTERN.test(sha256)) return { error: { ...BULK_IMPORT_ERRORS.ENTRY_INVALID, index, field: 'sha256' } }
    const size = raw?.size
    if (!Number.isSafeInteger(size) || size < 0) return { error: { ...BULK_IMPORT_ERRORS.ENTRY_INVALID, index, field: 'size' } }
    const name = String(raw?.name ?? '').trim().slice(0, 180) || path.split('/').at(-1)

    /**
     * 이미 이 세션이 아는 경로. 엔트리를 두 번 만들지 않고 **그 엔트리의 실제 상태를 그대로 답한다**.
     * 재개는 같은 폴더를 다시 고른 뒤 같은 매니페스트를 다시 보내는 흐름이라 이 갈래를 반드시 지난다 —
     * 여기서 무조건 'duplicate'라고 답하면 아직 올리지 않은 파일이 '이미 올라갔다'가 되어
     * 재개가 한 건도 올리지 못하고 전부 실패로 마감된다(브라우저 판정에서 실제로 그렇게 됐다).
     */
    const known = knownEntries.get(path)
    if (known) {
      /**
       * 지문을 갈아 끼울 수 있는 상태는 **resolveUpload가 다시 받아 주는 상태와 같아야 한다**.
       * failed를 빼 두면(옛 코드가 그랬다) 실패 뒤 내용이 바뀐 파일이 화면에는 새 지문으로 보이고
       * 서버에는 옛 지문으로 남아, 올릴 때마다 400 HASH_MISMATCH가 나고 그 문장이 시키는 대로
       * 폴더를 다시 골라도 같은 답이 돌아온다.
       */
      const retryable = known.status === 'pending' || known.status === 'failed'
      const changed = retryable && Boolean(sha256) && Boolean(known.sha256) && known.sha256 !== sha256
      // 다시 고른 파일의 내용이 바뀌었으면 새 지문으로 갈아 끼운다. 옛 지문으로는 업로드가 400이 된다.
      if (changed || (retryable && !known.sha256 && sha256)) updates.push({ path, sha256, changed })
      /**
       * 이미 '중복'으로 닫아 둔 엔트리도 **다시 판정한다**. 첫 매니페스트는 자동 감지 매핑
       * (대상 프로젝트 없음)으로 가고, 사람이 표에서 프로젝트를 고르는 것은 그 뒤다 —
       * 여기서 다시 보지 않으면 그때 닫힌 파일은 영영 그 프로젝트에 없다.
       *
       * **두 종류를 함께 본다**: 자료실의 문서로 닫은 것(duplicateOf)과 같은 묶음의 먼저 올라갈
       * 파일로 닫은 것(duplicateOfPath). 한쪽만 보면 나머지 한쪽은 다시 판정되지 않고,
       * 첫 판정 때는 모든 행에 대상 프로젝트가 없어 **전부 닫힌 채로 시작한다** — 그래서
       * 한 파일을 두 프로젝트 폴더에 복사해 둔 흔한 내보내기가 두 번째 프로젝트에 구멍을 남긴다.
       */
      const anchorKey = sha256 ? sameRunAnchorKey(anchorKeyFor(path), sha256) : ''
      const closable = known.status !== 'duplicate' || (known.duplicateOf
        ? canCloseDuplicate(path, { documentId: known.duplicateOf })
        : Boolean(known.duplicateOfPath) && canCloseDuplicate(path, { otherPath: known.duplicateOfPath }))
      let status = known.status
      let duplicateOf = known.duplicateOf
      let duplicateOfPath = known.duplicateOfPath
      let reopened = false
      if (!closable) {
        /**
         * 이 묶음 안에 **지금 매핑에서도 닫을 수 있는** 다른 기준이 있으면 그쪽으로 옮긴다.
         * 같은 프로젝트로 갈 사본을 두 벌 올리지 않는다 — 되돌린 첫 파일이 그 기준이 된다.
         */
        const anchor = anchorKey ? knownByChecksum.get(anchorKey) : undefined
        if (anchor && anchor !== path && canCloseDuplicate(path, { otherPath: anchor })) {
          duplicateOf = ''
          duplicateOfPath = anchor
          updates.push({ path, duplicateOfPath: anchor })
        } else {
          reopened = true
          status = 'pending'
          duplicateOf = ''
          duplicateOfPath = ''
          updates.push({ path, reopen: true })
          // 되돌아온 파일이 이 묶음의 새 기준이 된다 — 뒤따르는 같은 파일이 닫힌 옛 기준을 가리키지 않게.
          if (anchorKey && !knownByChecksum.has(anchorKey)) knownByChecksum.set(anchorKey, path)
        }
      }
      if (status === 'duplicate' && duplicateOf) duplicates.push({ path, duplicateOf })
      verdicts.push({
        index, path, name, size, sha256, status,
        ...(duplicateOf ? { duplicateOf } : {}),
        // 같은 묶음 안의 기준도 응답에 적는다 — 화면이 '왜 안 올라갔나'를 그 경로로 말할 수 있어야 한다.
        ...(duplicateOfPath ? { duplicateOfPath } : {}),
        ...(known.error && !reopened ? { error: known.error } : {}),
        ...(changed ? { changed: true } : {}),
      })
      continue
    }
    const entry = { path, name, size, sha256, status: 'pending', documentId: '', duplicateOf: '', duplicateOfPath: '', error: '', changed: false }
    // 지문이 없으면 중복을 알 길이 없다. 거짓 음성(중복을 못 잡음)은 사본 하나가 느는 것이고,
    // 거짓 양성(엉뚱한 것을 중복으로 봄)은 파일을 잃는 것이다. 의도한 비대칭이다.
    const existing = sha256 ? existingByChecksum.get(sha256) : undefined
    const newAnchorKey = sha256 ? sameRunAnchorKey(anchorKeyFor(path), sha256) : ''
    const sameRun = newAnchorKey ? knownByChecksum.get(newAnchorKey) : undefined
    if (existing && canCloseDuplicate(path, { documentId: existing })) {
      entry.status = 'duplicate'
      entry.duplicateOf = existing
      duplicates.push({ path, duplicateOf: existing })
    } else if (sameRun && canCloseDuplicate(path, { otherPath: sameRun })) {
      // 아직 올라가지 않은 것을 id로 가리킬 수는 없다. 먼저 올라갈 파일의 경로로 가리킨다.
      entry.status = 'duplicate'
      entry.duplicateOfPath = sameRun
    } else if (size > maxFileBytes) {
      entry.status = 'failed'
      entry.error = OVERSIZE_MESSAGE
    } else if (newAnchorKey && !knownByChecksum.has(newAnchorKey)) {
      /**
       * **먼저 정해진 기준을 덮지 않는다.** 닫히지 못한 파일(목적지가 달라 새 사본이 필요한 파일)이
       * 기준을 가로채면, 뒤따르는 같은 프로젝트의 파일이 엉뚱한 기준과 견주어져 사본이 두 벌 올라간다.
       */
      knownByChecksum.set(newAnchorKey, path)
    }
    knownEntries.set(path, entry)
    accepted.push(entry)
    verdicts.push({
      index, path, name, size, sha256, status: entry.status,
      ...(entry.duplicateOf ? { duplicateOf: entry.duplicateOf } : {}),
      ...(entry.duplicateOfPath ? { duplicateOfPath: entry.duplicateOfPath } : {}),
      ...(entry.error ? { error: entry.error } : {}),
    })
  }
  return { verdicts, entries: accepted, updates, duplicates }
}

/** 엔트리 목록의 한 페이지. 경계에서 중복도 누락도 없어야 재개가 진실을 본다. */
export function pageEntries(entries, cursor = 0, limit = ENTRY_PAGE_SIZE) {
  const list = Array.isArray(entries) ? entries : []
  const start = Number.isSafeInteger(cursor) && cursor > 0 ? cursor : 0
  const size = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, ENTRY_PAGE_SIZE) : ENTRY_PAGE_SIZE
  const slice = list.slice(start, start + size)
  return { entries: slice, nextCursor: start + size < list.length ? start + size : null }
}

/** 엔트리 상태에서 집계를 다시 센다. 누적하지 않는다 — 재전송 한 번에 어긋나면 되돌릴 수 없다. */
export function recomputeTotals(entries) {
  const totals = { files: 0, bytes: 0, uploaded: 0, skippedDuplicate: 0, failed: 0 }
  for (const entry of entries) {
    totals.files += 1
    if (entry.status === 'uploaded') { totals.uploaded += 1; totals.bytes += Number.isSafeInteger(entry.size) ? entry.size : 0 }
    else if (entry.status === 'duplicate') totals.skippedDuplicate += 1
    else if (entry.status === 'failed') totals.failed += 1
  }
  return totals
}

/**
 * 이 엔트리가 **실제로 들어간** 행. 올라간 엔트리에는 그때 적용된 값이 새겨져 있다(markUploaded).
 *
 * 왜 지금 매핑으로 다시 풀지 않는가: 매핑은 이관이 끝난 뒤에도 고칠 수 있고, 그때 보고서를
 * 현재 매핑으로 다시 풀면 '하지 않은 일'을 말한다 — 이미 PRJ-CONTRACT로 잠겨 저장된 파일이
 * 보고서에서는 '설계 이관 · 활용'이 된다. 아직 올라가지 않은 엔트리에는 새겨진 값이 없으므로
 * 그때만 현재 매핑으로 푼다(그 파일에 앞으로 적용될 행이 실제로 그 행이다).
 */
export function appliedRowOf(entry, session) {
  if (entry?.status === 'uploaded' && typeof entry.appliedPrefix === 'string') {
    return {
      folderPrefix: entry.appliedPrefix,
      projectId: entry.appliedProjectId ?? null,
      aiLevel: AI_POLICIES.includes(entry.appliedAiLevel) ? entry.appliedAiLevel : DEFAULT_BULK_AI_POLICY,
      stamped: true,
    }
  }
  return { ...resolveMapping(String(entry?.path ?? ''), session?.mapping), stamped: false }
}

/**
 * 완료 보고. failures는 저장하지 않고 여기서 만든다 —
 * 저장해 두면 엔트리와 어긋날 수 있고, 어긋난 보고서는 없느니만 못하다.
 */
export function completionReport(session, entries) {
  const totals = recomputeTotals(entries)
  const failures = []
  for (const entry of entries) {
    if (entry.status !== 'failed') continue
    if (failures.length < MAX_FAILURES_KEPT) failures.push({ path: entry.path, name: entry.name, error: entry.error || '' })
  }
  const folders = new Map()
  for (const entry of entries) {
    const row = appliedRowOf(entry, session)
    const key = row.folderPrefix
    const bucket = folders.get(key) ?? { folderPrefix: key, projectId: row.projectId, aiLevel: row.aiLevel, stamped: false, files: 0, uploaded: 0, skippedDuplicate: 0, failed: 0 }
    // 실제로 적용된 값이 언제나 이긴다 — 한 묶음의 첫 줄이 아직 안 올라간 엔트리일 수 있다.
    if (row.stamped && !bucket.stamped) { bucket.projectId = row.projectId; bucket.aiLevel = row.aiLevel; bucket.stamped = true }
    bucket.files += 1
    if (entry.status === 'uploaded') bucket.uploaded += 1
    else if (entry.status === 'duplicate') bucket.skippedDuplicate += 1
    else if (entry.status === 'failed') bucket.failed += 1
    folders.set(key, bucket)
  }
  return {
    ...totals,
    pending: totals.files - totals.uploaded - totals.skippedDuplicate - totals.failed,
    failures,
    failuresTruncated: totals.failed > failures.length,
    // stamped는 집계용 표시일 뿐이라 응답에 싣지 않는다 — 화면이 읽을 값이 아니다.
    folders: [...folders.values()]
      .sort((left, right) => left.folderPrefix.localeCompare(right.folderPrefix, 'ko'))
      .map(({ stamped: _stamped, ...bucket }) => bucket),
  }
}

/**
 * 이관을 할 수 있는가.
 *
 * 이관은 손으로 올렸을 때보다 더 넓은 자료를 만들 수 없어야 한다. 프로젝트 editor는 이미 게시글 첨부로
 * 같은 프로젝트에 파일을 넣고 그 파일이 멤버에게 열린다 — 벌크는 그 행위의 건수만 늘린다.
 * projectId가 비어 있는 행은 회사 전체가 보는 자료실('all')에 넣는 행위라 관리자 권한이다.
 * 메시지에 프로젝트 이름을 넣지 않는다 — 범위 밖 프로젝트의 존재를 알리지 않는다.
 */
export function canBulkImport({ auth, mapping, projects = [], projectRoleOf }) {
  if (!auth?.tenantId) return { ok: false, error: BULK_IMPORT_ERRORS.FORBIDDEN }
  if (auth.role === GUEST_ROLE) return { ok: false, error: BULK_IMPORT_ERRORS.FORBIDDEN }
  if (auth.role === 'tenant-admin') return { ok: true }
  if (auth.role !== 'tenant-member') return { ok: false, error: BULK_IMPORT_ERRORS.FORBIDDEN }
  const rows = Array.isArray(mapping) ? mapping : []
  if (!rows.length) return { ok: false, error: BULK_IMPORT_ERRORS.FORBIDDEN }
  for (const row of rows) {
    if (!row?.projectId) return { ok: false, error: BULK_IMPORT_ERRORS.FORBIDDEN }
    const project = projects.find((candidate) => candidate?.id === row.projectId)
    const role = project ? projectRoleOf(project, auth) : null
    if (role !== 'owner' && role !== 'editor') return { ok: false, error: BULK_IMPORT_ERRORS.FORBIDDEN }
  }
  return { ok: true }
}

const newSessionId = () => `IMP-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString('hex').toUpperCase()}`
const newRuleId = () => `IMR-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString('hex').toUpperCase()}`
const chunkId = (sessionId, index) => `${sessionId}-C${String(index).padStart(3, '0')}`

/** 세션 행 한 줄을 읽는다. 못 읽으면 null — 깨진 줄 하나가 목록 전체를 잠그지 않는다. */
function normalizeSession(value) {
  if (!value || typeof value !== 'object' || value.kind !== 'session') return null
  const id = String(value.id ?? '').trim()
  if (!id || !SESSION_STATUSES.includes(value.status)) return null
  // 저장된 행은 관대 모드로 읽는다 — 상한이 내려가기 전에 저장된 태그 때문에 표 전체를 잃지 않는다.
  const parsed = normalizeMapping(value.mapping, { lenient: true })
  return {
    kind: 'session', id,
    name: String(value.name ?? '').slice(0, MAX_NAME_LENGTH),
    status: value.status,
    createdById: String(value.createdById ?? ''),
    createdByName: String(value.createdByName ?? ''),
    createdAt: String(value.createdAt ?? ''),
    updatedAt: String(value.updatedAt ?? ''),
    finishedAt: value.finishedAt ? String(value.finishedAt) : null,
    totals: { files: 0, bytes: 0, uploaded: 0, skippedDuplicate: 0, failed: 0, ...(value.totals ?? {}) },
    mapping: parsed.mapping ?? [],
    /**
     * 읽지 못한 표를 **빈 표로 바꾸지 않는다**. 빈 표에서는 모든 경로가 기본 행(대상 프로젝트 없음)으로
     * 떨어져 프로젝트 자료가 전 직원 자료실로 올라간다 — 못 읽었다는 사실이 권한을 넓히는 방향으로
     * 조용히 해석되는 자리다. 그 사실을 그대로 들고 다니고, 매니페스트와 업로드가 보고 거절한다
     * (표를 다시 저장하면 그 자리에서 풀린다). 저장된 행의 이 칸은 읽지 않는다 — 언제나 여기서 다시 센다.
     */
    mappingBroken: Boolean(parsed.path),
    chunks: Number.isSafeInteger(value.chunks) && value.chunks >= 0 ? value.chunks : 0,
    manifestPages: Array.isArray(value.manifestPages) ? value.manifestPages.map(String).slice(-MAX_MANIFEST_PAGES_REMEMBERED) : [],
  }
}

// ---------------------------------------------------------------------------
// 라우트
// ---------------------------------------------------------------------------

export function registerBulkImportRoutes({
  app, requireAuth, requireTenantAdmin, requireMatchingWorkspaceIdentity,
  workspaceStore, commitWorkspaceStore,
  documentsOf, canReadDocument, persistDocuments, projectSpacesOf, projectRoleOf, projectMemberIds,
  grantDocumentAccess,
  clock = () => new Date(),
}) {
  const guards = [requireAuth, requireMatchingWorkspaceIdentity]
  const adminGuards = [requireAuth, requireTenantAdmin, requireMatchingWorkspaceIdentity]
  const now = () => clock().toISOString()

  const fail = (response, entry, extra = {}) => { response.status(entry.status).json({ error: errorBody(entry, extra) }) }

  /** 테넌트 + 게스트 이중 방어. 게이트가 이미 403을 내지만, 라우트가 스스로도 거절한다. */
  const requireTenantState = (request, response) => {
    if (!request.auth?.tenantId) {
      response.status(403).json({ error: { code: 'TENANT_REQUIRED', message: '고객사 워크스페이스에서만 사용할 수 있습니다.' } })
      return null
    }
    if (request.auth.role === GUEST_ROLE) {
      response.status(403).json({ error: GUEST_SCOPE_FORBIDDEN })
      return null
    }
    const tenantStore = workspaceStore.tenants[request.auth.tenantId] ?? {}
    const rows = Array.isArray(tenantStore[BULK_IMPORT_KEY]?.data) ? tenantStore[BULK_IMPORT_KEY].data : []
    return { tenantStore, rows }
  }

  const sessionsOf = (rows) => rows.map(normalizeSession).filter(Boolean)
  const chunksOf = (rows, sessionId) => rows
    .filter((row) => row?.kind === 'chunk' && row.sessionId === sessionId)
    .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
    .map((row) => ({ ...row, entries: Array.isArray(row.entries) ? row.entries : [] }))
  const allEntries = (rows, sessionId) => chunksOf(rows, sessionId).flatMap((chunk) => chunk.entries)

  /** 세션 하나를 쓰기 위해 찾는다. 남의 것·다른 테넌트는 존재를 알리지 않고 404. */
  const findSession = (state, request, response) => {
    const session = sessionsOf(state.rows).find((row) => row.id === request.params.id)
    const isAdmin = request.auth.role === 'tenant-admin'
    if (!session || (!isAdmin && session.createdById !== request.auth.id)) {
      fail(response, BULK_IMPORT_ERRORS.NOT_FOUND)
      return null
    }
    return session
  }

  /**
   * 세션 행 하나와 청크 행 여럿을 한 번에 갈아 끼우고 커밋한다.
   * 실패하면 이전 레코드를 그대로 되돌린다 — 한 쓰기에 속한 부수 효과는 함께 살거나 함께 죽는다.
   */
  const commitRows = async (auth, tenantStore, nextRows, onRollback = null) => {
    const previousRecord = tenantStore[BULK_IMPORT_KEY]
    tenantStore[BULK_IMPORT_KEY] = { data: nextRows, updatedAt: now(), updatedBy: auth.id }
    workspaceStore.tenants[auth.tenantId] = tenantStore
    try {
      await commitWorkspaceStore()
    } catch (error) {
      if (previousRecord) tenantStore[BULK_IMPORT_KEY] = previousRecord
      else delete tenantStore[BULK_IMPORT_KEY]
      // 이 쓰기에 딸린 다른 키의 변경(열람 범위 확장 등)도 함께 되돌린다 —
      // 한쪽만 살아남으면 다음 성공한 쓰기가 그 변경을 조용히 확정한다.
      onRollback?.()
      throw error
    }
  }

  /** 세션 행만 갈아 끼운 새 배열. 청크는 그대로 둔다. */
  const withSession = (rows, session) => rows.map((row) => (row?.kind === 'session' && row.id === session.id ? session : row))

  const publicSession = (session, entriesCount = null) => ({
    id: session.id, name: session.name, status: session.status,
    createdById: session.createdById, createdByName: session.createdByName,
    createdAt: session.createdAt, updatedAt: session.updatedAt, finishedAt: session.finishedAt,
    totals: session.totals, mapping: session.mapping, chunks: session.chunks,
    ...(entriesCount === null ? {} : { entriesCount }),
  })

  const permissionFor = (request, mapping) => canBulkImport({
    auth: request.auth, mapping, projects: projectSpacesOf(request.auth.tenantId), projectRoleOf,
  })

  // 1. 목록 — 관리자는 전량, 직원은 본인 것만.
  app.get('/api/bulk-imports', ...guards, (request, response) => {
    const state = requireTenantState(request, response)
    if (!state) return
    const isAdmin = request.auth.role === 'tenant-admin'
    const sessions = sessionsOf(state.rows)
      .filter((session) => isAdmin || session.createdById === request.auth.id)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .map((session) => publicSession(session))
    response.json({ sessions })
  })

  // 2. 세션 생성.
  app.post('/api/bulk-imports', ...guards, async (request, response) => {
    const state = requireTenantState(request, response)
    if (!state) return
    const name = String(request.body?.name ?? '').trim()
    if (name.length < 2 || name.length > MAX_NAME_LENGTH) { fail(response, BULK_IMPORT_ERRORS.MAPPING_INVALID, { path: 'name' }); return }
    const parsed = normalizeMapping(request.body?.mapping)
    if (parsed.path) { fail(response, BULK_IMPORT_ERRORS.MAPPING_INVALID, { path: parsed.path }); return }
    const permitted = permissionFor(request, parsed.mapping)
    if (!permitted.ok) { fail(response, permitted.error); return }
    if (sessionsOf(state.rows).length >= MAX_SESSIONS_PER_TENANT) { fail(response, BULK_IMPORT_ERRORS.SESSION_LIMIT); return }
    const stamp = now()
    // 출처는 세션이 정한다 — 본문의 createdById는 읽지 않는다.
    const session = {
      kind: 'session', id: newSessionId(), name, status: 'draft',
      createdById: request.auth.id, createdByName: request.auth.name ?? '',
      createdAt: stamp, updatedAt: stamp, finishedAt: null,
      totals: { files: 0, bytes: 0, uploaded: 0, skippedDuplicate: 0, failed: 0 },
      mapping: parsed.mapping, chunks: 0, manifestPages: [],
    }
    try {
      await commitRows(request.auth, state.tenantStore, [session, ...state.rows])
      response.status(201).json({ session: publicSession(session) })
    } catch (error) {
      console.error('[bulk-import] Failed to create session', { message: error?.message })
      fail(response, BULK_IMPORT_ERRORS.WRITE_FAILED)
    }
  })

  // 3. 세션 하나 + 엔트리 한 페이지 + 보고서.
  app.get('/api/bulk-imports/:id', ...guards, (request, response) => {
    const state = requireTenantState(request, response)
    if (!state) return
    const session = findSession(state, request, response)
    if (!session) return
    const chunks = chunksOf(state.rows, session.id)
    const entries = chunks.flatMap((chunk) => chunk.entries)
    const chunkIndex = Number(request.query?.chunk ?? 0)
    const chunk = chunks.find((row) => row.index === chunkIndex) ?? null
    const cursor = Number(request.query?.cursor ?? 0)
    const limit = request.query?.limit === undefined ? ENTRY_PAGE_SIZE : Number(request.query.limit)
    const page = pageEntries(chunk?.entries ?? [], cursor, limit)
    const documents = documentsOf(request.auth.tenantId)
    const documentIds = new Set(documents.map((document) => document?.id))
    const withResume = page.entries.map((entry) => {
      // 크래시 창: 파일은 저장됐는데 상태 기록 전에 브라우저가 죽은 경우. 문서 쪽에서 되찾는다.
      if (entry.status === 'pending') {
        return { ...entry, resumeDocumentId: documents.find((document) => document?.importId === session.id && document?.sourcePath === entry.path)?.id ?? null }
      }
      // 자료실에서 지운 문서는 보고서에 그렇게 적는다. 세션은 참조가 아니라 이력이라
      // documentIsReferenced에 넣지 않았고, 그래서 삭제를 막지도 않는다.
      if (entry.status === 'uploaded' && entry.documentId && !documentIds.has(entry.documentId)) {
        return { ...entry, documentDeleted: true }
      }
      return entry
    })
    response.json({
      session: publicSession(session, entries.length),
      chunk: { index: Number.isSafeInteger(chunkIndex) && chunkIndex >= 0 ? chunkIndex : 0, entries: withResume },
      nextCursor: page.nextCursor,
      report: completionReport(session, entries),
    })
  })

  // 4. 이름·매핑·상태 수정.
  app.patch('/api/bulk-imports/:id', ...guards, async (request, response) => {
    const state = requireTenantState(request, response)
    if (!state) return
    const session = findSession(state, request, response)
    if (!session) return
    const next = { ...session, updatedAt: now() }
    if (request.body?.name !== undefined) {
      const name = String(request.body.name ?? '').trim()
      if (name.length < 2 || name.length > MAX_NAME_LENGTH) { fail(response, BULK_IMPORT_ERRORS.MAPPING_INVALID, { path: 'name' }); return }
      next.name = name
    }
    if (request.body?.mapping !== undefined) {
      const parsed = normalizeMapping(request.body.mapping)
      if (parsed.path) { fail(response, BULK_IMPORT_ERRORS.MAPPING_INVALID, { path: parsed.path }); return }
      // 멤버십은 이관 도중에도 바뀐다 — 매핑을 고칠 때마다 다시 본다.
      const permitted = permissionFor(request, parsed.mapping)
      if (!permitted.ok) { fail(response, permitted.error); return }
      next.mapping = parsed.mapping
    }
    if (request.body?.status !== undefined) {
      const target = nextStatus(session.status, String(request.body.status))
      if (!target) { fail(response, BULK_IMPORT_ERRORS.STATUS_INVALID); return }
      next.status = target
      if (target === 'done' || target === 'failed') next.finishedAt = now()
    }
    try {
      await commitRows(request.auth, state.tenantStore, withSession(state.rows, next))
      response.json({ session: publicSession(next) })
    } catch (error) {
      console.error('[bulk-import] Failed to update session', { message: error?.message })
      fail(response, BULK_IMPORT_ERRORS.WRITE_FAILED)
    }
  })

  // 5. 매니페스트 한 페이지.
  app.post('/api/bulk-imports/:id/manifest', ...guards, async (request, response) => {
    const state = requireTenantState(request, response)
    if (!state) return
    const session = findSession(state, request, response)
    if (!session) return
    if (session.status === 'done' || session.status === 'failed') { fail(response, BULK_IMPORT_ERRORS.STATUS_INVALID); return }
    // 표를 읽지 못한 세션으로는 판정하지 않는다 — 빈 표의 판정은 전 직원 공개 쪽으로 기운다.
    if (session.mappingBroken) { fail(response, BULK_IMPORT_ERRORS.MAPPING_INVALID, { path: 'mapping' }); return }
    // 멤버십은 이관 도중에도 바뀐다 — 페이지마다 다시 본다.
    const permitted = permissionFor(request, session.mapping)
    if (!permitted.ok) { fail(response, permitted.error); return }

    const entries = request.body?.entries
    if (!Array.isArray(entries)) { fail(response, BULK_IMPORT_ERRORS.ENTRY_INVALID, { index: 0 }); return }
    if (entries.length > MAX_MANIFEST_PAGE) { fail(response, BULK_IMPORT_ERRORS.PAGE_TOO_LARGE); return }
    const clientRequestId = String(request.body?.clientRequestId ?? '').trim().slice(0, 80)
    const chunks = chunksOf(state.rows, session.id)
    const existingEntries = chunks.flatMap((chunk) => chunk.entries)

    /**
     * 같은 페이지 재전송은 아무것도 늘리지 않는다 — 그것은 **이미 아는 경로를 다시 담지 않는다**는
     * 아래 규칙이 보장한다. 여기서 빈 판정을 돌려주고 끝내지 않는 이유: 재개는 같은 폴더를
     * 다시 골라 같은 매니페스트를 다시 보내는 흐름이라 그 갈래를 반드시 지나고, 빈 판정을 받으면
     * 클라이언트에 올릴 목록이 하나도 없게 된다.
     */
    const replayed = Boolean(clientRequestId && session.manifestPages.includes(clientRequestId))

    // 중복 인덱스는 요청당 한 번만 만든다 — 엔트리마다 문서 배열을 훑으면 O(문서수 × 엔트리수)다.
    const documents = documentsOf(request.auth.tenantId)
    const byChecksum = new Map()
    for (const document of documents) {
      if (typeof document?.checksum !== 'string' || !SHA256_PATTERN.test(document.checksum)) continue
      if (!canReadDocument(document, request.auth)) continue
      if (!byChecksum.has(document.checksum)) byChecksum.set(document.checksum, document.id)
    }
    /**
     * 같은 묶음 안의 기준은 **목적지별로** 나눠 색인한다. 지문 하나로 색인하면 다른 프로젝트로 갈
     * 파일이 서로의 기준이 되고, 닫힌 중복은 다시 올라가지 않으므로 두 번째 프로젝트에는 그 파일이 없다.
     */
    const anchorKeyFor = (path) => resolveMapping(path, session.mapping).projectId ?? ''
    const knownByChecksum = new Map()
    const knownEntries = new Map()
    for (const entry of existingEntries) {
      knownEntries.set(entry.path, entry)
      if (entry.status !== 'pending' || !entry.sha256) continue
      const key = sameRunAnchorKey(anchorKeyFor(entry.path), entry.sha256)
      if (!knownByChecksum.has(key)) knownByChecksum.set(key, entry.path)
    }

    /**
     * 중복 하나에 대한 결정. **한 함수가 두 물음에 답한다** — '중복으로 닫아도 되는가'와
     * '무엇을 넓히는가'. 둘을 따로 적으면 주석으로만 일치하는 두 판정이 되고, 그 어긋남은
     * '이미 있으니 안 올렸다'와 '그 프로젝트에는 없다'가 갈리는 자리에서 드러난다.
     *
     * 닫지 못한 중복은 pending으로 남아 **새 사본이 프로젝트에 올라간다** — 손으로 올렸을 때와 같고,
     * 볼 수 없는 문서에 대해 이미 하고 있는 처리와도 같다(권한 표면이 넓어지지 않는다).
     */
    const isAdmin = request.auth.role === 'tenant-admin'
    const projects = projectSpacesOf(request.auth.tenantId)
    const documentById = new Map(documents.filter((document) => document?.id).map((document) => [document.id, document]))
    const duplicateDecision = (path, { documentId = '', otherPath = '' } = {}) => {
      const row = resolveMapping(path, session.mapping)
      // 대상 프로젝트가 없는 행(자료실)에는 '구멍'이라는 개념이 없다.
      if (!row.projectId) return { close: true, grantTo: null }
      // 같은 묶음 안의 중복은 먼저 올라갈 파일이 **같은 프로젝트**에 갈 때만 닫는다.
      if (otherPath) return { close: resolveMapping(otherPath, session.mapping).projectId === row.projectId, grantTo: null }
      const project = projects.find((candidate) => candidate?.id === row.projectId)
      const target = documentById.get(documentId)
      /**
       * 매핑이 가리키는 프로젝트가 없거나 그 문서가 자료실에서 사라졌으면 **닫지 않는다.**
       * 업로드 단계가 다시 판정해 주지 않기 때문이다 — resolveUpload는 'duplicate' 엔트리를
       * ENTRY_SETTLED로 되돌려보내므로, 여기서 닫으면 그 파일은 어디에도 저장되지 않은 채
       * 보고서에만 '이미 있어서 건너뜀'으로 남는다(파일을 잃고, 잃었다는 말도 하지 않는다).
       */
      if (!project || !target) return { close: false, grantTo: null }
      const members = projectMemberIds(project)
      // 이미 그 프로젝트 전원이 읽는 자료는 넓힐 것도, 다시 올릴 것도 없다.
      if (documentOpensToProject(target, members)) return { close: true, grantTo: null }
      /**
       * **이미 restricted인 문서만** 넓힌다: grantDocumentAccess는 'department' 문서를 restricted로
       * 바꿔 버려 그 부서의 나머지 사람이 열람을 잃는다. 그리고 **남의 자료는 건드리지 않는다** —
       * 같은 해시의 사본을 폴더에 갖고 있다는 이유로 동료의 자료를 프로젝트(그 안의 외부 게스트 포함)에
       * 열어 줄 수는 없다. 관리자는 원래 전 자료의 열람 범위를 정하는 사람이라 예외다.
       */
      const widenable = target.visibility === 'restricted'
        && (isAdmin || String(target.uploadedById ?? '') === String(request.auth.id))
      return widenable ? { close: true, grantTo: members } : { close: false, grantTo: null }
    }

    const planned = planManifest({
      entries, existingByChecksum: byChecksum, knownByChecksum, knownEntries, anchorKeyFor,
      canCloseDuplicate: (path, options) => duplicateDecision(path, options).close,
    })
    if (planned.error) { fail(response, planned.error, { ...(planned.error.index === undefined ? {} : { index: planned.error.index }), ...(planned.error.field ? { field: planned.error.field } : {}) }); return }
    // 상한은 **새로 담기는 것**만 센다. 재전송분까지 세면 같은 목록을 두 번 보낸 것만으로 상한에 걸린다.
    if (existingEntries.length + planned.entries.length > MAX_ENTRIES_PER_SESSION) { fail(response, BULK_IMPORT_ERRORS.ENTRY_LIMIT); return }

    /**
     * 닫아 둔 중복의 열람 범위를 **넓힌다**. 대상은 이 페이지가 실제로 닫은 엔트리 전부다 —
     * 이번에 새로 판정한 것과 **이미 알고 있던 것** 둘 다(첫 매니페스트는 대상 프로젝트 없이 가고,
     * 사람이 표에서 프로젝트를 고르는 것은 그 뒤라, 아는 경로를 빼면 넓히는 일이 영영 일어나지 않는다).
     * grantDocumentAccess는 멱등이고 실제로 바뀐 건수만 센다.
     *
     * grantDocumentAccess는 스스로 커밋하지 않으므로 이 요청 안에서 반드시 함께 커밋하고,
     * 실패하면 함께 되돌린다. 이 일은 아직 한 바이트도 올리기 전인 '확인' 단계에서 일어난다.
     *
     * **프로젝트 귀속 도장(projectId)은 찍지 않는다.** 이 갈래의 문서는 이미 있던 자료이고,
     * 귀속은 '이 파일이 어느 프로젝트의 것인가'라는 사실이다 — 사본을 가진 사람의 폴더 이름이
     * 남의 자료의 출처를 바꿀 수는 없다. 새로 올라가는 파일에만 documentFieldsFor가 찍는다.
     */
    const documentsBefore = workspaceStore.tenants[request.auth.tenantId]?.['company-documents']
    const restoreDocuments = () => {
      const current = workspaceStore.tenants[request.auth.tenantId]
      if (!current) return
      if (documentsBefore) current['company-documents'] = documentsBefore
      else delete current['company-documents']
    }
    let accessWidened = 0
    for (const { path, duplicateOf } of planned.duplicates) {
      const { grantTo } = duplicateDecision(path, { documentId: duplicateOf })
      if (!grantTo) continue
      if (grantDocumentAccess(request.auth.tenantId, [duplicateOf], grantTo)) accessWidened += 1
    }

    /**
     * 기존 엔트리 갈아 끼우기. 세 갈래가 있다 —
     * (1) 다시 고른 파일의 지문이 바뀌었다(옛 지문으로는 업로드가 400이 된다),
     * (2) 닫아 둔 중복을 다시 열었다(그 프로젝트에서 열리지 않는 자료였다),
     * (3) 같은 묶음 안의 기준을 옮겼다(옛 기준은 다른 프로젝트로 가고, 새 기준이 같은 프로젝트로 간다).
     * 한 경로에 둘 이상은 오지 않지만 합쳐 두면 나중에 갈래가 늘어도 마지막 것만 살아남지 않는다.
     */
    const updateByPath = new Map()
    for (const update of planned.updates) updateByPath.set(update.path, { ...updateByPath.get(update.path), ...update })
    const nextChunks = chunks.map((chunk) => ({
      ...chunk,
      entries: chunk.entries.map((entry) => {
        const update = updateByPath.get(entry.path)
        if (!update) return entry
        return {
          ...entry,
          ...(update.sha256 === undefined ? {} : { sha256: update.sha256, changed: update.changed || entry.changed }),
          ...(update.reopen ? { status: 'pending', duplicateOf: '', duplicateOfPath: '', documentId: '', error: '' } : {}),
          ...(update.duplicateOfPath ? { duplicateOf: '', duplicateOfPath: update.duplicateOfPath } : {}),
        }
      }),
    }))
    for (const entry of planned.entries) {
      let last = nextChunks.at(-1)
      if (!last || last.entries.length >= MAX_ENTRIES_PER_CHUNK) {
        last = { kind: 'chunk', id: chunkId(session.id, nextChunks.length), sessionId: session.id, index: nextChunks.length, entries: [] }
        nextChunks.push(last)
      }
      last.entries.push(entry)
    }
    const nextEntries = nextChunks.flatMap((chunk) => chunk.entries)
    const nextSession = {
      ...session,
      status: session.status === 'draft' ? 'mapping' : session.status,
      updatedAt: now(),
      totals: recomputeTotals(nextEntries),
      chunks: nextChunks.length,
      manifestPages: clientRequestId ? [...session.manifestPages, clientRequestId].slice(-MAX_MANIFEST_PAGES_REMEMBERED) : session.manifestPages,
    }
    const others = state.rows.filter((row) => !(row?.kind === 'chunk' && row.sessionId === session.id))
    try {
      await commitRows(request.auth, state.tenantStore, [...withSession(others, nextSession), ...nextChunks], restoreDocuments)
      response.json({
        chunk: nextChunks.at(-1)?.index ?? 0,
        totals: nextSession.totals,
        verdicts: planned.verdicts,
        ...(replayed ? { replayed: true } : {}),
        // 몇 건을 넓혔는지 숫자로 답한다 — 화면이 '조용히 바꿨다'가 되지 않게 한 문장을 그린다.
        ...(accessWidened ? { accessWidened } : {}),
      })
    } catch (error) {
      console.error('[bulk-import] Failed to store manifest page', { message: error?.message })
      fail(response, BULK_IMPORT_ERRORS.WRITE_FAILED)
    }
  })

  // 6. 진행 보고(10건 또는 3초마다 묶어서).
  app.post('/api/bulk-imports/:id/progress', ...guards, async (request, response) => {
    const state = requireTenantState(request, response)
    if (!state) return
    const session = findSession(state, request, response)
    if (!session) return
    if (session.status === 'done' || session.status === 'failed') { fail(response, BULK_IMPORT_ERRORS.STATUS_INVALID); return }
    const results = Array.isArray(request.body?.results) ? request.body.results : null
    if (!results || results.length > MAX_PROGRESS_RESULTS) { fail(response, BULK_IMPORT_ERRORS.ENTRY_INVALID, { index: 0 }); return }

    const byPath = new Map()
    for (const result of results) {
      const path = normalizeImportPath(result?.path)
      if (!path) { fail(response, BULK_IMPORT_ERRORS.PATH_INVALID, { index: results.indexOf(result) }); return }
      const status = String(result?.status ?? '')
      if (!['uploaded', 'duplicate', 'failed'].includes(status)) { fail(response, BULK_IMPORT_ERRORS.ENTRY_INVALID, { index: results.indexOf(result), field: 'status' }); return }
      byPath.set(path, {
        status,
        documentId: String(result?.documentId ?? '').slice(0, 120),
        error: String(result?.error ?? '').slice(0, MAX_ERROR_LENGTH),
        changed: result?.changed === true,
      })
    }

    /**
     * '올렸다'는 보고는 **서버가 그 문서를 찾을 수 있을 때만** 받는다.
     *
     * 이 갈래를 정직하게 지나는 흐름은 크래시 복구 하나뿐이다(파일은 저장됐는데 상태 기록 전에
     * 브라우저가 죽은 창 — 그때는 문서가 실제로 있다). 보통의 업로드는 POST /api/documents 안에서
     * markUploaded가 이미 상태와 **서버가 잰 크기**를 새겨 두므로 아래 '이미 끝났다' 갈래로 빠진다.
     * 확인 없이 받아 주면 보고서의 '올린 파일 N개 · X MB'가 저장된 적 없는 바이트를 세게 된다.
     */
    /**
     * 찾는 방법은 **이 세션의 이 경로**뿐이다. 본문이 보낸 documentId로 테넌트 전체를 조회하면
     * 직원이 읽지 못하는 문서의 존재와 크기를 알아내는 창구가 된다(엔트리에 그 크기가 새겨지고
     * GET /api/bulk-imports/:id가 그대로 돌려준다). 정직한 크래시 복구가 싣는 값은 서버가
     * importId+sourcePath로 찾아 준 resumeDocumentId라, 이 술어로 언제나 다시 찾을 수 있다.
     */
    const documents = documentsOf(request.auth.tenantId)
    const bySourcePath = new Map()
    for (const document of documents) {
      if (document?.importId !== session.id || typeof document?.sourcePath !== 'string') continue
      if (!bySourcePath.has(document.sourcePath)) bySourcePath.set(document.sourcePath, document)
    }
    const verifyUpload = (entry, update) => {
      const document = bySourcePath.get(entry.path)
      if (!document) return null
      return !update.documentId || document.id === update.documentId ? document : null
    }

    const nextChunks = chunksOf(state.rows, session.id).map((chunk) => ({
      ...chunk,
      entries: chunk.entries.map((entry) => {
        const update = byPath.get(entry.path)
        if (!update) return entry
        // 이미 끝난 엔트리는 되돌리지 않는다 — 늦게 도착한 배치가 완료된 파일을 실패로 바꾸면
        // 보고서가 뒤집히고 재개가 이미 올린 파일을 다시 올린다.
        if (entry.status === 'uploaded' || entry.status === 'duplicate') return entry
        if (update.status === 'uploaded') {
          const document = verifyUpload(entry, update)
          // 찾지 못하면 실패로 적는다 — pending으로 두면 마감이 다른 이유(안 올림)로 닫고,
          // uploaded로 두면 없는 파일을 올렸다고 말한다. failed는 재개가 다시 시도한다.
          if (!document) return { ...entry, status: 'failed', error: UNVERIFIED_UPLOAD_MESSAGE, changed: update.changed || entry.changed }
          return {
            ...entry,
            status: 'uploaded',
            documentId: document.id,
            ...(Number.isSafeInteger(document.size) && document.size >= 0 ? { size: document.size } : {}),
            /**
             * 이 갈래로 확정된 엔트리에도 **그때 적용된 행**을 새긴다. 새기지 않으면 appliedRowOf가
             * 현재 매핑으로 다시 풀어, 이관이 끝난 뒤 표를 고친 것만으로 보고서가 하지 않은 일을 말한다.
             * 귀속과 수준은 **문서에 실제로 실린 값**이 진실이다(폴더는 지금 매핑이 아는 최선이다).
             */
            appliedPrefix: resolveMapping(entry.path, session.mapping).folderPrefix,
            appliedProjectId: document.projectId ?? null,
            appliedAiLevel: documentAiPolicy(document),
            error: '',
            changed: update.changed || entry.changed,
          }
        }
        return {
          ...entry,
          status: update.status,
          documentId: update.documentId || entry.documentId,
          error: update.status === 'failed' ? (update.error || entry.error) : '',
          changed: update.changed || entry.changed,
        }
      }),
    }))
    const nextEntries = nextChunks.flatMap((chunk) => chunk.entries)
    const nextSession = { ...session, updatedAt: now(), totals: recomputeTotals(nextEntries) }
    const others = state.rows.filter((row) => !(row?.kind === 'chunk' && row.sessionId === session.id))
    try {
      await commitRows(request.auth, state.tenantStore, [...withSession(others, nextSession), ...nextChunks])
      // 일시 중지는 '지금까지의 보고는 받되 새 업로드는 받지 않는다'는 뜻이다.
      // 보고를 409로 막으면 이미 올라간 파일의 상태를 잃는다.
      if (session.status === 'paused') { fail(response, BULK_IMPORT_ERRORS.PAUSED); return }
      response.json({ totals: nextSession.totals })
    } catch (error) {
      console.error('[bulk-import] Failed to record progress', { message: error?.message })
      fail(response, BULK_IMPORT_ERRORS.WRITE_FAILED)
    }
  })

  // 7. 마감.
  app.post('/api/bulk-imports/:id/finish', ...guards, async (request, response) => {
    const state = requireTenantState(request, response)
    if (!state) return
    const session = findSession(state, request, response)
    if (!session) return
    /**
     * 남은 pending은 여기서 닫는다. 영원히 '올리는 중'인 세션을 남기지 않는다.
     * 문장은 UNFINISHED_MESSAGE다 — 여기 걸리는 파일에는 '이관 중단'을 누른 사람의 파일도 있고,
     * 그 사람에게 '재개할 때 다시 선택하지 않았습니다'라고 말하면 화면이 하지 않은 일을 지어낸다.
     */
    const nextChunks = chunksOf(state.rows, session.id).map((chunk) => ({
      ...chunk,
      entries: chunk.entries.map((entry) => (entry.status === 'pending' ? { ...entry, status: 'failed', error: UNFINISHED_MESSAGE } : entry)),
    }))
    const nextEntries = nextChunks.flatMap((chunk) => chunk.entries)
    const totals = recomputeTotals(nextEntries)
    const target = nextStatus(session.status, totals.uploaded === 0 && totals.failed > 0 ? 'failed' : 'done')
    if (!target) { fail(response, BULK_IMPORT_ERRORS.STATUS_INVALID); return }
    const nextSession = { ...session, status: target, updatedAt: now(), finishedAt: now(), totals }
    const others = state.rows.filter((row) => !(row?.kind === 'chunk' && row.sessionId === session.id))
    try {
      await commitRows(request.auth, state.tenantStore, [...withSession(others, nextSession), ...nextChunks])
      response.json({ session: publicSession(nextSession), report: completionReport(nextSession, nextEntries) })
    } catch (error) {
      console.error('[bulk-import] Failed to finish session', { message: error?.message })
      fail(response, BULK_IMPORT_ERRORS.WRITE_FAILED)
    }
  })

  // 8. 세션 삭제 — 문서는 지우지 않는다.
  app.delete('/api/bulk-imports/:id', ...guards, async (request, response) => {
    const state = requireTenantState(request, response)
    if (!state) return
    const session = findSession(state, request, response)
    if (!session) return
    const nextRows = state.rows.filter((row) => !(row?.kind === 'session' && row.id === session.id) && !(row?.kind === 'chunk' && row.sessionId === session.id))
    try {
      await commitRows(request.auth, state.tenantStore, nextRows)
      response.json({ deletedId: session.id, message: '이관 기록을 지웠습니다. 올라간 자료는 자료실에 그대로 있습니다.' })
    } catch (error) {
      console.error('[bulk-import] Failed to delete session', { message: error?.message })
      fail(response, BULK_IMPORT_ERRORS.WRITE_FAILED)
    }
  })

  // 9. 폴더 단위 AI 처리 수준 올리기 — 관리자만, 그리고 **올라가는 방향으로만**.
  app.post('/api/bulk-imports/:id/ai-level', ...adminGuards, async (request, response) => {
    const state = requireTenantState(request, response)
    if (!state) return
    const session = findSession(state, request, response)
    if (!session) return
    const level = String(request.body?.level ?? '')
    if (!AI_POLICIES.includes(level)) { fail(response, BULK_IMPORT_ERRORS.AI_LEVEL_INVALID); return }
    const rawPrefix = String(request.body?.folderPrefix ?? '')
    const folderPrefix = rawPrefix.trim() ? normalizeImportPath(rawPrefix) : ''
    if (folderPrefix === null) { fail(response, BULK_IMPORT_ERRORS.PATH_INVALID, { index: 0 }); return }

    /**
     * 버튼의 효과와 그 옆의 숫자는 **같은 함수**에서 나와야 한다 — 보고서가 appliedRowOf로 묶었으니
     * 여기도 그것으로 고른다. underPrefix로 고르면 '(최상위)' 행의 버튼 하나가 세션 전체를 올린다:
     * underPrefix(path, '')는 모든 경로에 참이고, 보고서의 '' 묶음은 **다른 행에 걸리지 않은 파일들**만
     * 담기 때문이다. 중첩된 두 행('Flow'와 'Flow/계약')도 같은 이유로 서로를 삼킨다.
     */
    const folderByPath = new Map()
    for (const entry of allEntries(state.rows, session.id)) folderByPath.set(entry.path, appliedRowOf(entry, session).folderPrefix)

    const documents = documentsOf(request.auth.tenantId)
    let updated = 0
    const next = documents.map((document) => {
      if (document?.importId !== session.id) return document
      const path = String(document.sourcePath ?? '')
      const bucket = folderByPath.has(path) ? folderByPath.get(path) : resolveMapping(path, session.mapping).folderPrefix
      if (bucket !== folderPrefix) return document
      // 올라가는 것만 바꾼다. 내리는 것은 문서 하나하나의 결정이라 자료 정보 화면(PATCH)에서 한다 —
      // 폴더 단위로 내리면 사람이 올려 둔 문서까지 함께 잠긴다.
      if (AI_POLICY_RANK[level] <= AI_POLICY_RANK[documentAiPolicy(document)]) return document
      updated += 1
      return { ...document, aiPolicy: level }
    })
    if (!updated) { response.json({ updated: 0 }); return }
    try {
      await persistDocuments(request.auth.tenantId, next, request.auth.id)
      response.json({ updated })
    } catch (error) {
      console.error('[bulk-import] Failed to raise ai level', { message: error?.message })
      fail(response, BULK_IMPORT_ERRORS.WRITE_FAILED)
    }
  })

  // 10-12. 저장한 매핑 규칙.
  const rulesState = (request, response) => {
    const state = requireTenantState(request, response)
    if (!state) return null
    const rules = Array.isArray(state.tenantStore[BULK_IMPORT_RULE_KEY]?.data) ? state.tenantStore[BULK_IMPORT_RULE_KEY].data : []
    return { ...state, rules }
  }
  const commitRules = async (auth, tenantStore, rules) => {
    const previousRecord = tenantStore[BULK_IMPORT_RULE_KEY]
    tenantStore[BULK_IMPORT_RULE_KEY] = { data: rules, updatedAt: now(), updatedBy: auth.id }
    workspaceStore.tenants[auth.tenantId] = tenantStore
    try {
      await commitWorkspaceStore()
    } catch (error) {
      if (previousRecord) tenantStore[BULK_IMPORT_RULE_KEY] = previousRecord
      else delete tenantStore[BULK_IMPORT_RULE_KEY]
      throw error
    }
  }
  const visibleRules = (rules, auth) => rules.filter((rule) => auth.role === 'tenant-admin' || rule?.ownerId === auth.id)

  app.get('/api/bulk-import-rules', ...guards, (request, response) => {
    const state = rulesState(request, response)
    if (!state) return
    response.json({ rules: visibleRules(state.rules, request.auth) })
  })

  app.post('/api/bulk-import-rules', ...guards, async (request, response) => {
    const state = rulesState(request, response)
    if (!state) return
    const name = String(request.body?.name ?? '').trim()
    if (!name || name.length > MAX_RULE_NAME_LENGTH) { fail(response, BULK_IMPORT_ERRORS.MAPPING_INVALID, { path: 'name' }); return }
    const parsed = normalizeMapping(request.body?.mapping)
    if (parsed.path) { fail(response, BULK_IMPORT_ERRORS.MAPPING_INVALID, { path: parsed.path }); return }
    const mine = visibleRules(state.rules, request.auth)
    const existing = mine.find((rule) => rule?.name === name && (request.auth.role === 'tenant-admin' || rule.ownerId === request.auth.id))
    if (!existing && state.rules.length >= MAX_RULES_PER_TENANT) { fail(response, BULK_IMPORT_ERRORS.RULE_LIMIT); return }
    const stamp = now()
    const rule = existing
      ? { ...existing, mapping: parsed.mapping, updatedAt: stamp }
      : { id: newRuleId(), name, mapping: parsed.mapping, ownerId: request.auth.id, ownerName: request.auth.name ?? '', createdAt: stamp, updatedAt: stamp }
    const nextRules = existing ? state.rules.map((row) => (row?.id === existing.id ? rule : row)) : [...state.rules, rule]
    try {
      await commitRules(request.auth, state.tenantStore, nextRules)
      response.status(existing ? 200 : 201).json({ rule, rules: visibleRules(nextRules, request.auth) })
    } catch (error) {
      console.error('[bulk-import] Failed to save rule', { message: error?.message })
      fail(response, BULK_IMPORT_ERRORS.WRITE_FAILED)
    }
  })

  app.delete('/api/bulk-import-rules/:id', ...guards, async (request, response) => {
    const state = rulesState(request, response)
    if (!state) return
    const rule = state.rules.find((row) => row?.id === request.params.id)
    if (!rule || (request.auth.role !== 'tenant-admin' && rule.ownerId !== request.auth.id)) { fail(response, BULK_IMPORT_ERRORS.RULE_NOT_FOUND); return }
    const nextRules = state.rules.filter((row) => row?.id !== rule.id)
    try {
      await commitRules(request.auth, state.tenantStore, nextRules)
      response.json({ deletedId: rule.id, rules: visibleRules(nextRules, request.auth) })
    } catch (error) {
      console.error('[bulk-import] Failed to delete rule', { message: error?.message })
      fail(response, BULK_IMPORT_ERRORS.WRITE_FAILED)
    }
  })

  // -------------------------------------------------------------------------
  // POST /api/documents 가 부르는 세 함수
  // -------------------------------------------------------------------------

  /**
   * 업로드 한 건이 이 세션의 어느 엔트리인지 찾고, 문서에 실릴 값을 서버가 정한다.
   * 클라이언트가 200개 파일마다 분류·태그·권한을 다시 보내면 하나만 어긋나도 묶음이 갈라진다.
   */
  const resolveUpload = ({ auth, importId, sourcePath }) => {
    if (!auth?.tenantId || auth.role === GUEST_ROLE) return { error: BULK_IMPORT_ERRORS.FORBIDDEN }
    const tenantStore = workspaceStore.tenants[auth.tenantId] ?? {}
    const rows = Array.isArray(tenantStore[BULK_IMPORT_KEY]?.data) ? tenantStore[BULK_IMPORT_KEY].data : []
    const session = sessionsOf(rows).find((row) => row.id === importId)
    if (!session || (auth.role !== 'tenant-admin' && session.createdById !== auth.id)) return { error: BULK_IMPORT_ERRORS.NOT_FOUND }
    if (session.status === 'paused') return { error: BULK_IMPORT_ERRORS.PAUSED }
    if (session.status !== 'uploading') return { error: BULK_IMPORT_ERRORS.STATUS_INVALID }
    // 표를 읽지 못했으면 기본 행(전 직원 공개)으로 떨어뜨리지 않고 거절한다 — 표를 다시 저장하면 풀린다.
    if (session.mappingBroken) return { error: BULK_IMPORT_ERRORS.MAPPING_INVALID }
    // 멤버십은 이관 도중에도 바뀐다 — 업로드마다 다시 본다.
    const permitted = canBulkImport({ auth, mapping: session.mapping, projects: projectSpacesOf(auth.tenantId), projectRoleOf })
    if (!permitted.ok) return { error: permitted.error }

    const path = normalizeImportPath(sourcePath)
    if (!path) return { error: BULK_IMPORT_ERRORS.PATH_INVALID }
    const chunks = chunksOf(rows, session.id)
    for (const chunk of chunks) {
      const entryIndex = chunk.entries.findIndex((entry) => entry.path === path)
      if (entryIndex < 0) continue
      const entry = chunk.entries[entryIndex]
      /**
       * failed는 다시 시도한다 — 실패한 엔트리에는 문서가 없고, 화면이 '이어서 올리기를 누르면
       * 실패한 파일부터 다시 시도합니다'라고 적어 두었다. 이미 끝난(uploaded·duplicate) 것만 막고,
       * 그것을 STATUS_INVALID가 아니라 전용 코드로 알린다(재개가 연결 실패로 오해하지 않게).
       */
      if (entry.status !== 'pending' && entry.status !== 'failed') return { error: BULK_IMPORT_ERRORS.ENTRY_SETTLED }
      /**
       * **선언된 행이 아니라 실제로 적용되는 행**을 판정한다. canBulkImport는 세션 매핑의 행들만 보는데,
       * 매핑 어디에도 걸리지 않은 경로는 defaultMappingRow(projectId: null)로 떨어져
       * '전 직원 공개 자료실'이 된다 — 직원이 자기 프로젝트 행만 선언해 두고 그 밖의 파일을
       * 전사 공개로 만들 수 있다. 같은 함수에 이 한 행만 넘겨 다시 본다(판정이 두 벌이 되지 않게).
       */
      const matched = matchMappingRow(path, session.mapping)
      const row = matched ?? defaultMappingRow()
      const applied = canBulkImport({ auth, mapping: [row], projects: projectSpacesOf(auth.tenantId), projectRoleOf })
      if (!applied.ok) return { error: matched ? applied.error : BULK_IMPORT_ERRORS.UNMAPPED }
      const project = row.projectId ? projectSpacesOf(auth.tenantId).find((candidate) => candidate?.id === row.projectId) : null
      if (row.projectId && !project) return { error: BULK_IMPORT_ERRORS.FORBIDDEN }
      return {
        tenantId: auth.tenantId, sessionId: session.id, path,
        locator: { chunkIndex: chunk.index, entryIndex },
        entry,
        // 보고서가 '무엇을 했는지' 말하려면 그때 걸린 행을 엔트리에 새겨야 한다(markUploaded가 쓴다).
        appliedPrefix: row.folderPrefix,
        ...documentFieldsFor(row, { sessionId: session.id, projectMemberIds: project ? projectMemberIds(project) : [] }),
      }
    }
    return { error: BULK_IMPORT_ERRORS.NOT_FOUND }
  }

  /**
   * 엔트리 상태를 통째로 갈아 끼우고, **교체 전 레코드를 되돌릴 수 있는 손잡이**를 돌려준다.
   * 문서 배열 커밋이 실패하면 부르는 쪽이 restore()로 함께 되돌린다 —
   * persistDocumentList의 스냅샷은 테넌트 store 참조를 되돌릴 뿐이라 이 키의 변경은 살아남는다.
   */
  const applyEntry = ({ tenantId, sessionId, locator }, patch) => {
    const tenantStore = workspaceStore.tenants[tenantId] ?? {}
    const previousRecord = tenantStore[BULK_IMPORT_KEY]
    const rows = Array.isArray(previousRecord?.data) ? previousRecord.data : []
    const nextChunks = chunksOf(rows, sessionId).map((chunk) => (
      chunk.index !== locator.chunkIndex ? chunk : {
        ...chunk,
        entries: chunk.entries.map((entry, index) => (index === locator.entryIndex ? { ...entry, ...patch } : entry)),
      }
    ))
    const nextEntries = nextChunks.flatMap((chunk) => chunk.entries)
    const session = sessionsOf(rows).find((row) => row.id === sessionId)
    if (!session) return { restore: () => {} }
    const nextSession = { ...session, updatedAt: now(), totals: recomputeTotals(nextEntries) }
    const others = rows.filter((row) => !(row?.kind === 'chunk' && row.sessionId === sessionId))
    tenantStore[BULK_IMPORT_KEY] = {
      data: [...others.map((row) => (row?.kind === 'session' && row.id === sessionId ? nextSession : row)), ...nextChunks],
      updatedAt: now(),
      updatedBy: session.createdById,
    }
    workspaceStore.tenants[tenantId] = tenantStore
    return {
      restore: () => {
        const current = workspaceStore.tenants[tenantId]
        if (!current) return
        if (previousRecord) current[BULK_IMPORT_KEY] = previousRecord
        else delete current[BULK_IMPORT_KEY]
      },
    }
  }

  /**
   * 업로드 실패에 markFailed를 두지 않는 이유: 실패한 엔트리는 **pending으로 남아야** 재개가 다시 시도한다.
   * 실패 사실은 클라이언트가 진행 보고(POST /progress)로 싣고, 그 보고가 화면과 서버 보고서에
   * 같은 문장을 남긴다 — 서버가 여기서 한 번 더 적으면 두 곳이 다른 이유를 말하게 된다.
   */
  /**
   * size는 **저장된 본문의 길이**다. 매니페스트가 적어 온 크기를 그대로 두면 보고서의
   * '올린 파일 N개 · X MB'가 클라이언트의 주장이 된다 — 지문을 못 만드는 주소(http)에서는
   * 해시 대조도 없어 그 주장이 틀려도 아무도 모른다. 서버가 센 값으로 갈아 끼운다.
   */
  const markUploaded = (bulk, documentId, size) => applyEntry(bulk, {
    status: 'uploaded',
    documentId: String(documentId ?? ''),
    ...(Number.isSafeInteger(size) && size >= 0 ? { size } : {}),
    /**
     * 그때 적용된 행을 함께 새긴다. 매핑은 이관이 끝난 뒤에도 고칠 수 있고, 보고서를 현재 매핑으로
     * 다시 풀면 이미 저장된 파일에 대해 하지 않은 일을 말한다('설계 이관 · 활용'). 세 값은 이미
     * 이 요청이 계산해 문서에 실은 값 그대로다 — 두 번 계산하지 않는다.
     */
    appliedPrefix: String(bulk?.appliedPrefix ?? ''),
    appliedProjectId: bulk?.projectId ?? null,
    appliedAiLevel: bulk?.aiPolicy ?? DEFAULT_BULK_AI_POLICY,
    error: '',
  })

  return { resolveUpload, markUploaded }
}

import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * 기회 초안의 업로드 자리(slot).
 *
 * 왜 이 파일이 생겼는가: 워커는 서버 간 토큰(`OPPORTUNITY_INGEST_TOKEN`)으로 기회를 등재하는데,
 * 신청서 초안만은 사람의 로그인 세션 쿠키를 손으로 붙여 넣어야 자료실에 올라갔다. 세션은 만료되고,
 * 만료되는 순간 초안 업로드가 조용히 멈춘다. 실제로 그렇게 됐다 — 나라장터 실행에서 초안 18건이
 * 전부 빠졌다. **서버 간 통합에 사람 세션을 요구한 것**이 원인이다.
 *
 * 그렇다고 인제스트 토큰에 자료실 업로드 권한을 주면 안 된다. 그 토큰 하나가 새면 아무 고객사의
 * 자료실에나 아무 파일을 넣을 수 있게 된다. 그래서 권한을 **건별로** 좁힌다:
 * 인제스트가 방금 받아들인 한 건마다, 그 기회 하나에만 초안 하나를 붙일 수 있는 자리표를 돌려준다.
 *
 * 자리표가 담는 것은 셋뿐이다 — 어느 테넌트, 어느 기회, 언제까지. 그리고 그 셋을 인제스트 토큰으로
 * 서명한다. 워커는 자리표를 읽을 수는 있어도 **고쳐 쓸 수는 없다**. 그래서 워커가 테넌트를 스스로
 * 고를 길이 없고, 테넌트 격리는 워커가 보낸 값이 아니라 서명이 지킨다.
 *
 * 별도의 비밀을 새로 두지 않고 인제스트 토큰을 서명 키로 쓰는 이유: 운영에서 관리할 비밀이 하나면
 * 하나만 회전하면 되고, **토큰을 회전하면 남아 있던 자리표가 함께 닫힌다**. 비밀이 둘이면 토큰을
 * 급히 갈아 끼운 날에도 옛 자리표가 살아남는다.
 */

export const DRAFT_TICKET_VERSION = 'v1'

/**
 * 자리표의 수명. 워커는 인제스트 응답을 받자마자 올리므로 넉넉하다.
 * 짧을수록 좋지만, 한 실행에서 50건을 순서대로 올리는 동안은 살아 있어야 한다.
 */
export const DRAFT_TICKET_TTL_MS = 30 * 60 * 1_000

/**
 * 초안 하나의 상한. 초안은 마크다운 텍스트다 — 자료실의 10MB와 같은 상한을 줄 이유가 없다.
 * 좁은 권한에는 좁은 크기를 함께 건다.
 */
export const MAX_DRAFT_BYTES = 512 * 1_024

/** 서버가 정하는 초안 문서의 분류·태그·MIME. 워커가 보낸 값은 어느 것도 여기 닿지 않는다. */
export const DRAFT_CATEGORY = '제안·견적'
export const DRAFT_TAG = '기회발굴'
export const DRAFT_MIME = 'text/markdown'

const encode = (value) => Buffer.from(value).toString('base64url')

const signature = (secret, body) => createHmac('sha256', String(secret)).update(body).digest()

const refusal = (code, message) => ({ ok: false, status: 401, code, message })

/**
 * 자리표 한 장. `v1.<본문>.<서명>` — 본문은 읽을 수 있고(워커가 만료 시각을 볼 수 있다)
 * 서명은 인제스트 토큰을 아는 쪽만 만들 수 있다.
 */
export function signDraftTicket({ secret, tenantId, opportunityId, expiresAt }) {
  if (!secret || !tenantId || !opportunityId) return ''
  const body = `${DRAFT_TICKET_VERSION}.${encode(JSON.stringify({ t: String(tenantId), o: String(opportunityId), x: Number(expiresAt) }))}`
  return `${body}.${encode(signature(secret, body))}`
}

/**
 * 자리표를 연다. 실패는 던지지 않고 사유와 함께 돌려준다 — 라우트가 그대로 응답에 싣는다.
 * 서명이 틀린 것과 만료된 것을 구별해 말하는 이유: 만료는 워커가 스스로 고칠 수 있는 일이고
 * (인제스트를 다시 보내면 새 자리를 받는다), 서명 오류는 운영자가 볼 일이다.
 */
export function verifyDraftTicket({ secret, ticket, now = Date.now() }) {
  if (!secret) return { ok: false, status: 503, code: 'INGEST_NOT_CONFIGURED', message: '인제스트 토큰(OPPORTUNITY_INGEST_TOKEN)이 설정되지 않았습니다.' }
  const raw = String(ticket ?? '').trim()
  if (!raw) return refusal('DRAFT_TICKET_REQUIRED', '초안 업로드 자리표가 없습니다. 인제스트 응답의 draftUpload.ticket을 그대로 보내 주세요.')

  const parts = raw.split('.')
  if (parts.length !== 3 || parts[0] !== DRAFT_TICKET_VERSION) return refusal('DRAFT_TICKET_INVALID', '초안 업로드 자리표를 읽을 수 없습니다.')
  const expected = signature(secret, `${parts[0]}.${parts[1]}`)
  let provided
  try { provided = Buffer.from(parts[2], 'base64url') } catch { return refusal('DRAFT_TICKET_INVALID', '초안 업로드 자리표를 읽을 수 없습니다.') }
  // 길이가 다르면 timingSafeEqual이 던진다. 먼저 걸러 낸다 — 길이는 서명에서 비밀이 아니다.
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return refusal('DRAFT_TICKET_INVALID', '초안 업로드 자리표의 서명이 맞지 않습니다.')
  }

  let claim
  try { claim = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) } catch { claim = null }
  const tenantId = String(claim?.t ?? '')
  const opportunityId = String(claim?.o ?? '')
  const expiresAt = Number(claim?.x)
  if (!tenantId || !opportunityId || !Number.isFinite(expiresAt)) return refusal('DRAFT_TICKET_INVALID', '초안 업로드 자리표를 읽을 수 없습니다.')
  if (expiresAt <= Number(now)) {
    return refusal('DRAFT_TICKET_EXPIRED', '초안 업로드 자리표의 유효 기간이 지났습니다. 인제스트를 다시 보내면 새 자리를 받습니다.')
  }
  return { ok: true, tenantId, opportunityId, expiresAt }
}

/**
 * 방금 저장한 기회 한 건에 딸린 자리. 다음 둘 중 하나라도 아니면 자리를 만들지 않는다:
 *   - 워커가 초안을 **예고했는가**(payload의 draft). 예고 없는 건에 자리를 주면 무엇을 올릴지 서버가 모른다.
 *   - 아직 문서가 **붙지 않았는가**. 붙은 뒤에도 자리를 주면 초안을 덮어쓸 수 있게 된다.
 * 중복·없는 고객사로 저장되지 않은 건은 애초에 record가 없으므로 부르는 쪽에서 걸린다.
 */
export function draftUploadSlot({ secret, tenantId, record, now = Date.now(), ttlMs = DRAFT_TICKET_TTL_MS }) {
  if (!secret || !tenantId || !record?.id) return null
  if (!record.draft || record.draft.documentId) return null
  const expiresAt = Number(now) + ttlMs
  const ticket = signDraftTicket({ secret, tenantId, opportunityId: record.id, expiresAt })
  if (!ticket) return null
  return {
    opportunityId: record.id,
    path: `/api/opportunities/${record.id}/draft`,
    ticket,
    expiresAt: new Date(expiresAt).toISOString(),
    contentType: DRAFT_MIME,
    maxBytes: MAX_DRAFT_BYTES,
  }
}

/**
 * 초안 문서가 자료실에 남기는 값. **전부 기회 기록에서만 나온다** — 업로드 요청은 바이트만 싣는다.
 * R16-G의 벌크 이관(`bulk-import.mjs`의 documentFieldsFor)이 쓰는 규율과 같다: 200개 파일마다
 * 클라이언트가 같은 값을 다시 보내면 하나만 어긋나도 묶음이 갈라지고, 여기서는 그 어긋남이
 * 곧 **워커가 자료실의 분류·열람 범위를 정하는 일**이 된다.
 *
 * visibility가 'all'인 이유: 이 초안이 딸린 기회 자체가 회사 안에서 누구나 보는 목록이다
 * (GET /api/opportunities는 requireAuth 하나로 열린다). 초안만 더 좁히면 카드가 가리키는 자료를
 * 정작 그 카드를 본 사람이 열지 못한다.
 *
 * aiPolicy 칸은 만들지 않는다 — 칸 없는 문서의 실효 수준이 이미 '활용'이라(document-ai-policy.mjs)
 * 값을 적어 넣어도 판정이 한 글자도 달라지지 않는다. 회의 녹음처럼 잠글 이유도 없다:
 * 초안의 재료는 공개된 공고문과 회사가 스스로 넣어 둔 프로필이다.
 */
export function draftDocumentFields(record) {
  return {
    category: DRAFT_CATEGORY,
    visibility: 'all',
    departments: [],
    allowedUserIds: [],
    tags: [DRAFT_TAG, `opportunity:${record?.key ?? record?.id ?? ''}`],
  }
}

/**
 * 초안 문서의 이름. 인제스트 때 워커가 예고하고 **서버가 이미 정규화해 저장해 둔** 이름을 쓴다
 * (normalizeDraftRef의 plainText). 업로드 요청이 이름을 다시 보내게 두면 카드에 적힌 이름과
 * 자료실의 이름이 갈릴 수 있다 — 한 사실은 한 곳에서만 나와야 한다.
 */
export function draftDocumentName(record) {
  const announced = String(record?.draft?.name ?? '').trim()
  return (announced || `${String(record?.title ?? '기회').trim()} 신청서 초안.md`).slice(0, 180)
}

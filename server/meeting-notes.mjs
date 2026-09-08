import { randomBytes } from 'node:crypto'

import { AI_LEVELS, aiLevelOf, aiMayDerive, aiMayReadBody, normalizeAiLevel } from './ai-policy.mjs'
import { GUEST_ROLE } from './guest-access.mjs'
import {
  MEETING_SUMMARY_OUTPUT_CONFIG,
  MeetingSummaryError,
  buildMeetingBlocks,
  buildMeetingSummaryPrompt,
  fallbackMeetingSummary,
  normalizeMeetingSummary,
} from './meeting-summary.mjs'
import { TranscriptionError, clipCharacters, countCharacters } from './transcription.mjs'

/**
 * 회의록 — HTTP 표면.
 *
 * 흐름 하나다: 사람이 올린 원본 → 전사(어댑터) → 요약 → **회의록 문서**(문서/위키) → 업무 제안이
 * **기존 승인 큐**에 오른다. 회의를 위한 별도의 승인 화면을 새로 만들지 않는다.
 *
 * 이 파일이 지키는 것 다섯:
 *
 * 1) **없는 것을 있는 것처럼 말하지 않는다.** 실제 음성 전사 벤더는 아직 정해지지 않았다.
 *    `TRANSCRIPTION_PROVIDER=none`이 기본이고, 부르면 503으로 「연동되지 않았다」고 답한다.
 *    가짜 전사를 지어내지 않는다. 오늘 되는 것은 사람이 올린 원문(.txt·.vtt·.srt·.md)에서
 *    요약·결정·할 일을 뽑는 것뿐이고, `GET /api/meetings`가 그 사실을 화면에 먼저 알린다.
 * 2) **판정은 순수 모듈이 한다.** 「이 인용이 근거인가」·「이 형식을 읽을 수 있는가」는
 *    meeting-summary.mjs·transcription.mjs가 답하고, 이 파일은 세션에서 사람을 읽고 저장소에서
 *    줄을 읽어 그 답을 HTTP로 옮긴다.
 * 3) **AI 처리 수준이 문이다.** 회의 녹음은 업로드 시 서버가 '보관만'으로 정한다(app.mjs).
 *    사람이 회의록 화면에서 수준을 **올리기 전에는** 전사도 요약도 제안도 돌지 않는다.
 *    수준을 올리는 일은 원본을 올린 사람이나 관리자만, **올리는 방향으로만** 할 수 있다.
 *    수준은 처리 시작에 한 번만 읽지 않는다 — 파일을 읽고 모델을 부르는 동안 사람이 내릴 수 있으므로
 *    **쓰기 직전에 다시 잰다**(`recheckBeforeWrite`). 프로세스 내 잠금은 회의 id로만 잡혀
 *    자료 화면의 `PATCH`도, 형제 회의의 `revoke-ai`도 이 처리를 배제하지 못하기 때문이다.
 * 4) **한 쓰기에 딸린 부수효과는 한 커밋에 들어간다.** 요약 한 번이 회의 레코드·업무 제안·
 *    자동화 통계 세 키를 함께 쓰고, 커밋이 실패하면 셋 다 되돌아간다. 알림·SSE는 커밋 **뒤에** 낸다.
 * 5) **generic 저장소 라우트는 닫혀 있다**(app.mjs의 `MEETING_ONLY_KEYS`). 전사 원문과 근거 인용이
 *    원료이므로 PUT 한 번으로 「아무도 하지 않은 말」이 끝난 회의록이 되는 길이 있으면 안 된다.
 */

const MEETINGS_KEY = 'meeting-notes'

/** 회사 하나가 가질 수 있는 회의 수. 넘으면 새로 만들 수 없다(지난 회의를 지우면 자리가 난다). */
export const MAX_MEETINGS_PER_TENANT = 1_000
/**
 * 회의 레코드에 담아 두는 전사 원문의 상한(글자). 넘으면 앞부분만 두고, **원문의 정본은 자료실의
 * 원본 파일**이다(`transcriptDocumentId`). 그래서 그 파일은 자료실에서 그냥 지워지지 않는다(app.mjs).
 */
export const MAX_TRANSCRIPT_STORED = 20_000
/** 회의 상세가 돌려주는 원문 미리보기 길이. 전문은 원본 파일에서 본다. */
const TRANSCRIPT_PREVIEW = 2_000
const MAX_MEETING_TITLE = 120
/**
 * 참석자 명단 상한. **화면이 이 수를 읽어야 한다** — `normalizeParticipants`가 조용히 잘라 200으로
 * 답하므로, 화면이 상한을 모르면 21번째로 고른 사람이 말없이 사라지고 그 명단은 곧 열람 명단이다
 * (규칙 11: 화면이 말하는 것은 실제로 일어난 일이어야 한다). 제목이 `MAX_MEETING_TITLE`을
 * `maxLength`로 쓰는 것과 같은 관례로, 수는 여기 한 곳에서만 나온다.
 */
export const MAX_PARTICIPANTS = 20
/** 실패 사유 한 줄. 사람이 화면에서 읽는 문장이고, 스택이 아니다. */
const MAX_ERROR_TEXT = 300
/**
 * 목록 한 묶음의 크기와 그 상한. 화면은 이 크기로 묶음을 세고 `offset`으로 이어 붙이므로
 * (`MEETING_LIST_PAGE_SIZE`), 두 수가 갈리면 「남은 N건」이 실제로 열리는 수와 어긋난다 —
 * `scripts/meeting-ui-contract.test.mjs`가 화면의 묶음 크기를 이 두 수에 맞대 본다.
 */
export const DEFAULT_LIST_LIMIT = 50
export const MAX_LIST_LIMIT = 200
/** 요약 출력 상한. 예약 추정치와 실제 호출이 **같은 수**를 본다. */
const SUMMARY_MAX_TOKENS = 1_500

export const MEETING_STATUSES = Object.freeze(['uploaded', 'transcribing', 'summarizing', 'done', 'failed'])

/**
 * 사용량 기록이 어떻게 끝났는지 말하는 어휘. 설계 §3.2가 이름만 적고 값을 정하지 않아 M3이 정한다
 * (선례: 일지 초안·문서 판독의 `usageAccounting`).
 *   recorded                  — 원장에 남았다(같은 id가 이미 있으면 그 한 줄로 흡수된다).
 *   reconciliation-pending    — 원장 쓰기가 실패해 정산 대기로 넘겼다.
 *   reconciliation-unavailable— 정산 대기 기록마저 실패했다(로그에만 남는다).
 *   not-recorded              — 예약도 기록도 하지 못했다(한도 차단 등). 회의록은 그대로 만들어졌다.
 *   not-applicable            — 부를 모델이 없었다. **0원 행을 원장에 넣지 않는다.**
 */
export const MEETING_USAGE_ACCOUNTING = Object.freeze([
  'recorded', 'reconciliation-pending', 'reconciliation-unavailable', 'not-recorded', 'not-applicable',
])

/**
 * 앞선 시도가 원장에 **이미 남긴** 사실. 재시도가 실패해도 이 셋은 되돌아가지 않는다 —
 * 원장의 줄은 그대로 있고, 없어진 것은 이번 시도의 성공뿐이기 때문이다.
 */
const STANDING_ACCOUNTING = Object.freeze(['recorded', 'reconciliation-pending', 'reconciliation-unavailable'])

const ERRORS = Object.freeze({
  TENANT_REQUIRED: { status: 403, code: 'TENANT_REQUIRED', message: '고객사 워크스페이스에서만 사용할 수 있습니다.' },
  NOT_FOUND: { status: 404, code: 'MEETING_NOT_FOUND', message: '회의를 찾을 수 없거나 열람 권한이 없습니다.' },
  TITLE_REQUIRED: { status: 400, code: 'MEETING_TITLE_REQUIRED', message: '회의 제목을 입력해 주세요.' },
  SOURCE_REQUIRED: { status: 400, code: 'MEETING_SOURCE_REQUIRED', message: '녹음 파일이나 회의록 원문 파일을 하나는 지정해 주세요.' },
  SOURCE_FORBIDDEN: { status: 403, code: 'MEETING_SOURCE_FORBIDDEN', message: '지정한 자료를 찾을 수 없거나 열람 권한이 없습니다.' },
  SOURCE_MISSING: { status: 410, code: 'MEETING_SOURCE_MISSING', message: '회의 원본 파일이 자료실에 없습니다. 파일을 다시 올린 뒤 회의를 새로 만들어 주세요.' },
  LIMIT: { status: 409, code: 'MEETING_LIMIT', message: `회의록은 회사당 ${MAX_MEETINGS_PER_TENANT}건까지입니다. 지난 회의를 지운 뒤 다시 시도해 주세요.` },
  ALREADY_PROCESSING: { status: 409, code: 'MEETING_ALREADY_PROCESSING', message: '이 회의를 지금 처리하고 있습니다. 끝난 뒤 다시 시도해 주세요.' },
  TRANSCRIPT_REQUIRED: { status: 409, code: 'MEETING_TRANSCRIPT_REQUIRED', message: '먼저 전사를 끝내야 요약할 수 있습니다.' },
  POLICY_FORBIDDEN: { status: 403, code: 'MEETING_POLICY_FORBIDDEN', message: '이 원본을 올린 사람이나 회사 관리자만 AI 처리 수준을 바꿀 수 있습니다.' },
  OWNER_ONLY: { status: 403, code: 'MEETING_OWNER_ONLY', message: '회의를 만든 사람이나 회사 관리자만 회의 제목·참석자 명단을 바꾸거나 회의를 지울 수 있습니다.' },
  SOURCE_NOT_MINE: { status: 403, code: 'MEETING_SOURCE_NOT_MINE', message: '내가 올린 자료나 회사 관리자가 지정한 자료만 회의 원본으로 쓸 수 있습니다. 자료를 올린 사람에게 회의 생성을 요청해 주세요.' },
  WRITE_FAILED: { status: 500, code: 'MEETING_WRITE_FAILED', message: '회의록을 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' },
})

/**
 * AI 처리 수준이 '보관만'이라 열 수 없다는 **한 문장**. 클라이언트 사전 경고와 서버 거절이
 * 같은 자리에서 나온다(규칙 3) — 화면은 이 코드를 받으면 동의 대화상자를 연다.
 */
const AI_LOCKED = Object.freeze({
  status: 409,
  code: 'MEETING_AI_LOCKED',
  message: '이 회의 원본의 AI 처리 수준이 「보관만」입니다. 회의록 화면에서 「정리」 이상으로 올려야 전사·요약할 수 있습니다.',
})

const CONTROL_RE = /[\x00-\x09\x0B-\x1F\x7F]/g

/** 사람이 읽는 한 줄. 제어문자를 지우고 자른다(서로게이트 쌍을 반으로 가르지 않는다). */
const clip = (value, max) => clipCharacters(String(value ?? '').replace(/\r\n?/g, ' ').replace(CONTROL_RE, '').trim(), max)

const newMeetingId = () => `MTG-${Date.now().toString(36).toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}`

/**
 * 회의 하나가 가지는 회의록 문서의 **서버 전용** 멱등 키. 위키의 `systemRequestId` 칸에만 들어가고,
 * 사람이 보내는 본문(`POST /api/wiki { clientRequestId }`)은 그 칸을 절대 쓰지 못한다(규칙 7).
 * 한 자리에서 만들어야 「문서를 만들 때」와 「문서가 있는지 볼 때」가 같은 글자를 본다.
 */
const meetingDocumentKey = (meetingId) => `meeting:${meetingId}`

/**
 * 이 회의가 만든 업무 제안의 `sourceKey` 앞머리. **만료·재지목·개수 세기가 이 하나에서 나온다** —
 * 세 곳에 손으로 적으면 화면이 「대기 2건」이라 말하는데 되돌리기는 0건을 만료하는 날이 온다(규칙 3·8).
 */
const meetingProposalPrefix = (meetingId) => `meeting:${meetingId}:`

/**
 * 회의록 문서를 누가 읽는가. 위키에는 문서별 열람 제한이 없어(설계 §0.3) 회의록 문서는 **회사 전원**이
 * 읽는다 — 원본 자료가 부서 공개나 열람 제한이어도 그렇다. 오늘 실제로 도는 `grounded-fallback`에서는
 * 요약도 결정 사항도 원문의 문장을 그대로 인용하므로, 열람이 좁은 원본의 문장이 그 문서를 타고
 * 전 직원에게 간다. **그 사실을 서버가 말한다** — 화면이 산문으로 지어 쓰지 않고 이 문장을 그대로
 * 동의 전에 보여 준다(규칙 3: 클라 사전 경고와 서버 문구가 한 템플릿에서 나온다).
 */
const DOCUMENT_AUDIENCE_MESSAGE = Object.freeze({
  same: '회의록 문서(요약·결정 사항·할 일)는 회사 구성원 전원이 읽을 수 있습니다.',
  wider: '회의록 문서(요약·결정 사항·할 일)는 회사 구성원 전원이 읽을 수 있습니다. 원본 자료는 열람 범위가 더 좁아, 요약과 결정 사항에 인용된 문장이 원본을 볼 수 없는 사람에게도 보이게 됩니다.',
})

/**
 * 원문 미리보기를 가렸다는 것이 「원문이 보호된다」는 뜻은 **아니다**. 오늘 도는 갈래에서 요약과
 * 결정·할 일의 `quote`는 원문의 문장을 글자 그대로 담고, 그것은 회의를 볼 수 있는 사람 전원에게
 * (회의록 문서를 타고서는 회사 전원에게) 그대로 나간다. 화면이 차단을 보호로 읽지 않게
 * 서버가 `transcriptHidden` **바로 그 자리에서** 말한다(규칙 3·11).
 */
const TRANSCRIPT_HIDDEN_NOTE = '원문 미리보기는 가렸습니다. 다만 요약과 결정 사항·할 일에 인용된 문장은 원문 그대로 나갑니다.'

/**
 * 되돌리기·삭제가 「회의록 문서는 남아 있다」를 말하는 **한 벌의 문장**. 두 문이 같은 결과를
 * 다르게 말하지 않게 한 자리에서 만든다(규칙 3).
 */
const remainingDocumentSentence = (count, { includesOwn = true } = {}) => {
  if (!count) return ''
  // 이 회의의 문서가 그 안에 없으면 **그렇게 말한다.** 형제 회의(같은 원본을 쓰는 다른 회의)의
  // 문서를 「회의록 문서는 남아 있습니다」로 뭉뚱그리면, 한 번도 회의록 문서를 가진 적 없는
  // 회의에서도 그 문장이 나가 사람이 있지도 않은 자기 문서를 찾으러 간다(규칙 11).
  const subject = includesOwn
    ? (count > 1 ? `회의록 문서 ${count}건은` : '회의록 문서는')
    : (count > 1 ? `이 원본을 함께 쓰는 다른 회의의 회의록 문서 ${count}건은` : '이 원본을 함께 쓰는 다른 회의의 회의록 문서는')
  return `${subject} 남아 있습니다. 필요하면 문서 화면에서 직접 지워 주세요.`
}

/**
 * 이번 요약이 회의록 문서를 **다시 쓰지 않았다**는 사실 한 문장. 문서는 회의당 한 번만 만들고
 * (사람이 이어서 고쳤을 수 있어 서버가 덮어쓰지 않는다), 그래서 되돌린 뒤 다시 요약하면
 * 큐에 오르는 근거와 문서의 내용이 갈릴 수 있다 — 화면이 지어 쓰지 않게 서버가 말한다.
 */
const DOCUMENT_REUSED_MESSAGE = '회의록 문서는 처음 만든 그대로입니다 — 이번 요약으로 다시 쓰지 않았습니다. 새 요약을 문서에도 옮기려면 문서 화면에서 직접 고쳐 주세요.'

export function registerMeetingNoteRoutes({
  app, requireAuth, requireMatchingWorkspaceIdentity,
  workspaceStore, accounts, commitWorkspaceStore,
  client = null, model = '', billingService = null, usageMetadataFor = () => ({}), extractText, mapAnthropicError,
  documentStorage, documentRecord, getTenantDocument, stageDocumentList, canReadDocument,
  isDocumentOpenToEveryone,
  createWikiDocument, findSystemWikiDocument,
  enqueueProposal, announceProposal, newProposalId, proposalsOf, writeProposals,
  transcription,
  clock = () => new Date(),
}) {
  // H(문서)가 먼저 들어가야 한다. 없으면 **부팅에서** 드러난다 — 회의록이 요약까지 해 놓고
  // 마지막에 문서를 만들지 못해 사람이 승인 큐에서 근거 없는 할 일만 보게 되는 것보다 낫다.
  if (typeof createWikiDocument !== 'function' || typeof findSystemWikiDocument !== 'function') {
    throw new TypeError('회의록은 문서(위키)가 있어야 만들 수 있습니다. R16-H가 먼저 들어가야 합니다.')
  }
  if (!transcription || typeof transcription.transcribe !== 'function' || typeof transcription.accepts !== 'function') {
    throw new TypeError('회의록은 전사 어댑터가 있어야 합니다. createTranscription(...)의 결과를 넘겨 주세요.')
  }
  // 「이 문서가 원본보다 넓게 열리는가」는 동의 전에 사람이 읽는 문장이다. 술어가 없으면 그 문장이
  // 조용히 거짓이 되므로(개발운영지원 자료는 visibility 'all'이어도 올린 사람에게만 열린다)
  // 조용히 넘기지 않고 **부팅에서** 드러낸다(규칙 8·11).
  if (typeof isDocumentOpenToEveryone !== 'function') {
    throw new TypeError('회의록은 자료의 열람 범위 판정(isDocumentOpenToEveryone)이 있어야 합니다.')
  }

  const guards = [requireAuth, requireMatchingWorkspaceIdentity]
  const nowIso = () => clock().toISOString()

  const fail = (response, refusal) => {
    response.status(refusal.status).json({ error: { code: refusal.code, message: refusal.message } })
  }

  const requireTenant = (request, response) => {
    if (request.auth?.tenantId) return true
    fail(response, ERRORS.TENANT_REQUIRED)
    return false
  }

  // ── 저장소 ────────────────────────────────────────────────────────────────
  const meetingsOf = (tenantId) => {
    const record = workspaceStore.tenants[tenantId]?.[MEETINGS_KEY]
    return Array.isArray(record?.data) ? record.data : []
  }

  const documentsOf = (tenantId) => {
    const record = documentRecord(tenantId)
    return Array.isArray(record?.data) ? record.data : []
  }

  const libraryDocumentOf = (tenantId, id) => (id ? documentsOf(tenantId).find((row) => row?.id === id) ?? null : null)

  /**
   * 아직 커밋되지 않은 **다른 키**의 변경 하나를 손에 쥔 손잡이(오늘은 자료 목록의 AI 수준 올리기).
   *
   * **`committed()`는 처리가 끝까지 간 마지막 저장에서만 부른다.** 중간 저장(status 'transcribing'·
   * 'summarizing')에서 부르면, 그 커밋이 이미 디스크에 올려 둔 AI 수준을 그 뒤의 어떤 실패도
   * 되돌리지 못한다 — 아무것도 만들지 못한 처리가 자료의 문만 열어 두고 사라지고, 그 문은 이 모듈
   * 밖의 다른 AI 기능(문서 렌즈·분류 제안·AI 검색)에게도 그 원본의 본문을 연다(규칙 9).
   *
   * 실패하거나 그 뒤 다른 단계에서 멈추면 `rollback`이 메모리의 변경을 걷어낸다 — 걷어내지 않으면
   * **저장되지 않은 AI 수준이 이 프로세스 안에서만 올라간 채로 보여** 다음 요청이 그것을
   * 「이미 올린 수준」으로 읽는다. 두 번 불러도 한 번만 되돌린다.
   * `reverted`는 「되돌리기가 실제로 돌았는가」다 — 중간 커밋이 디스크에 남긴 것을 부르는 쪽이
   * 다시 지워야 하는지 정한다.
   */
  const stagedWrite = (rollback) => {
    let pending = rollback ?? null
    let reverted = false
    return {
      rollback: () => { const run = pending; pending = null; if (run) { run(); reverted = true } },
      committed: () => { pending = null },
      get reverted() { return reverted },
    }
  }

  /**
   * 회의 배열을 쓰고 커밋한다. 실패하면 이 키를 되돌리고, 같은 커밋에 실린 다른 키도
   * (`staged`·`rollbackExtra`) 함께 되돌린다 — 갈라지면 저장되지 않은 회의를 가리키는 제안만 큐에 남는다.
   */
  const saveMeetings = async (tenantId, rows, actorId, staged = null, rollbackExtra = null) => {
    const tenantStore = workspaceStore.tenants[tenantId] ??= {}
    const previous = tenantStore[MEETINGS_KEY]
    tenantStore[MEETINGS_KEY] = { data: rows, updatedAt: nowIso(), updatedBy: actorId }
    try {
      await commitWorkspaceStore()
      staged?.committed()
      return true
    } catch (error) {
      if (previous) tenantStore[MEETINGS_KEY] = previous
      else delete tenantStore[MEETINGS_KEY]
      rollbackExtra?.()
      staged?.rollback()
      console.error('[meeting-notes] 회의록을 저장하지 못했습니다', { message: error?.message })
      return false
    }
  }

  /** 제안·자동화 통계 두 키의 지금 모습을 붙잡아 둔다. 커밋이 실패하면 이 되돌리기가 함께 돈다. */
  const snapshotProposals = (tenantId) => {
    const tenantStore = workspaceStore.tenants[tenantId] ??= {}
    const before = ['ai-proposals', 'automation-policies'].map((key) => [key, tenantStore[key]])
    return () => {
      for (const [key, record] of before) {
        if (record) tenantStore[key] = record
        else delete tenantStore[key]
      }
    }
  }

  const replaceMeeting = (rows, next) => rows.map((row) => (row?.id === next.id ? next : row))

  // ── 권한 ──────────────────────────────────────────────────────────────────
  /**
   * 이 회의를 볼 수 있는가. **테넌트 비교를 무조건 한다** — `meeting.tenantId &&`로 단락하면
   * tenantId가 빈 행이 어느 회사에서도 통과한다. 못 보는 사람에게는 없는 회의와 같은 답(404)이다.
   */
  const canSeeMeeting = (meeting, auth) => {
    if (!meeting || !auth?.tenantId) return false
    if (meeting.tenantId !== auth.tenantId) return false
    if (meeting.createdById === auth.id) return true
    if (Array.isArray(meeting.participantIds) && meeting.participantIds.includes(auth.id)) return true
    return auth.role === 'tenant-admin'
  }

  /**
   * 이 회의를 **바꿀** 수 있는가(참석자 명단·삭제). 볼 수 있다는 것과 바꿀 수 있다는 것은
   * 다른 권한이다 — 참석자는 열람자이지 관리자가 아니다(규칙 8).
   */
  const canManageMeeting = (meeting, auth) => Boolean(meeting)
    && (meeting.createdById === auth?.id || auth?.role === 'tenant-admin')

  const findMeeting = (auth, id) => {
    const meeting = meetingsOf(auth.tenantId).find((row) => row?.id === id) ?? null
    return meeting && canSeeMeeting(meeting, auth) ? meeting : null
  }

  /** 전사할 원본. 사람이 올린 회의록 원문이 있으면 그것이 먼저다(오늘의 어댑터가 읽을 수 있는 쪽). */
  const sourceOf = (tenantId, meeting) => (
    libraryDocumentOf(tenantId, meeting.transcriptDocumentId) ?? libraryDocumentOf(tenantId, meeting.recordingDocumentId)
  )

  const sourceFileName = (source) => String(source?.originalName || source?.name || '')

  /**
   * **쓰기 직전에 다시 잰다.** 손에 든 회의는 파일을 읽고 모델을 부르는 동안 낡는다 — 그 사이에
   * 사람이 AI 처리 수준을 「보관만」으로 내렸을 수 있고(문이 둘: 자료 화면의 `PATCH /api/documents/:id`와
   * 회의록의 `revoke-ai`), 회의 자체가 지워졌을 수도 있다. 프로세스 내 잠금은 **회의 id**로만 잡으므로
   * 어느 쪽도 이 처리를 배제하지 못한다. 낡은 사본으로 덮으면 방금 파기된 전사 사본·요약이
   * 되살아나고, 잠긴 자료에서 회의록 문서와 업무 제안이 태어난다(DECISIONS.md 3-5, 규칙 9).
   *
   * 반환은 `{ meeting, source, level }` 또는 `{ refusal }`. 회의는 **저장된 지금 그 행**이다.
   */
  const recheckBeforeWrite = (auth, meetingId) => {
    const current = meetingsOf(auth.tenantId).find((row) => row?.id === meetingId) ?? null
    if (!current) return { refusal: ERRORS.NOT_FOUND }
    const source = sourceOf(auth.tenantId, current)
    if (!source) return { refusal: ERRORS.SOURCE_REQUIRED }
    const level = aiLevelOf(source)
    if (!aiMayReadBody(level)) return { refusal: AI_LOCKED }
    return { meeting: current, source, level }
  }

  // ── 바깥으로 나가는 모양 ──────────────────────────────────────────────────
  /**
   * 사용량 한 칸. 원장 재기록에만 쓰는 이벤트 신원(`transcriptionEvent`)은 빼고 나간다 —
   * 화면이 쓸 일이 없고, 나가는 값은 화면이 실제로 읽는 것만이어야 한다.
   */
  const publicUsage = (usage) => {
    const { transcriptionEvent: _identity, ...rest } = usage && typeof usage === 'object' ? usage : {}
    return rest
  }

  /**
   * 목록·상세가 돌려주는 회의 한 건. `tenantId`와 `transcriptText`는 싣지 않는다 —
   * 원문은 상세의 미리보기와 자료실 원본 파일 두 곳에서만 나간다.
   */
  /**
   * 이 회의의 회의록 문서 가운데 **지금 실제로 있는 것**의 id. 회의 레코드의 `documentId`는 사본이고,
   * 그 문서는 사람 손 없이도 사라진다(보관 30일 뒤 `sweepWikiArchive`·관리자의 완전 삭제).
   * 사본을 그대로 실어 보내면 화면이 그것을 보고 「회의록 열기」를 그려 없는 문서로 사람을 보낸다.
   * 「문서가 있는가」를 위키의 실제 행으로 재는 자리는 되돌리기·삭제에 이미 있다(부록 C-2) —
   * 목록과 상세만 사본을 믿고 있었다. 같은 사실은 한 곳에서 나온다(규칙 3·11).
   */
  const liveDocumentIdOf = (meeting) => findSystemWikiDocument(meeting?.tenantId ?? '', meetingDocumentKey(meeting?.id ?? ''))?.id ?? ''

  /**
   * 이 회의에서 나온 업무 제안 가운데 **지금 승인 큐에서 기다리는** 것의 수.
   *
   * 회의 레코드의 `proposalIds`는 지금까지 올린 것의 **누적 이력**이다 — 결재가 끝나도 줄지 않고,
   * 다시 정리하면 새 제안이 더해져 늘기만 한다. 그 길이로 「승인 큐에 N건이 올라가 있습니다」를
   * 말하면 결재자가 둘을 처리한 순간 화면이 「2건」이라 말하는데 큐는 비어 있고, 다시 정리하면
   * 「4건」이라 말하는데 실제는 2건이다(규칙 13). 그래서 **서버가 실제로 센다**.
   *
   * 세는 술어는 `expireMeetingProposals`가 쓰는 것과 **글자 그대로 같다**(대기 중 · 이 회의의 앞머리).
   */
  const pendingProposalCountOf = (tenantId, meetingId) => {
    if (!tenantId || !meetingId) return 0
    const prefix = meetingProposalPrefix(meetingId)
    let pending = 0
    for (const row of proposalsOf(tenantId)) {
      if (row?.status !== 'pending') continue
      if (String(row?.sourceKey ?? '').startsWith(prefix)) pending += 1
    }
    return pending
  }

  const publicMeeting = (meeting) => ({
    id: meeting.id,
    title: meeting.title,
    status: meeting.status,
    error: meeting.error ?? '',
    recordingDocumentId: meeting.recordingDocumentId ?? '',
    transcriptDocumentId: meeting.transcriptDocumentId ?? '',
    transcriptChars: Number(meeting.transcriptChars ?? 0),
    transcriptTruncated: Boolean(meeting.transcriptTruncated),
    // 어댑터가 상한(200,000자)에서 **읽지도 못한** 글자 수. `transcriptTruncated`(회의 레코드에
    // 20,000자만 담았다)와 다른 사실이다 — 이쪽은 요약이 그 뒷부분을 보지 못했다는 뜻이다.
    transcriptUnreadChars: Number(meeting.transcriptUnreadChars ?? 0),
    hasTranscript: Boolean(String(meeting.transcriptText ?? '').trim()),
    documentId: liveDocumentIdOf(meeting),
    participantIds: Array.isArray(meeting.participantIds) ? meeting.participantIds : [],
    summary: meeting.summary ?? null,
    // 누적 이력. 「이 회의가 지금까지 무엇을 올렸는가」이지 「지금 몇 건이 기다리는가」가 아니다.
    proposalIds: Array.isArray(meeting.proposalIds) ? meeting.proposalIds : [],
    // 지금 승인 큐에서 기다리는 수. 화면의 현재형 문장은 **이 수**를 쓴다(위 주석 참고).
    pendingProposals: pendingProposalCountOf(meeting.tenantId ?? '', meeting.id),
    usage: publicUsage(meeting.usage),
    createdById: meeting.createdById,
    createdByName: meeting.createdByName ?? '',
    createdAt: meeting.createdAt,
    updatedAt: meeting.updatedAt,
  })

  /**
   * 지금 전사가 되는가를 화면에 그대로 말한다. 화면이 이것을 읽고 「녹음」 버튼의 사실을 정한다 —
   * 되지 않는 일을 되는 것처럼 그려 두지 않기 위한 유일한 근거다.
   */
  /**
   * 회의록 문서의 열람 범위 한 칸. **동의 전에** 화면이 이 문장을 그대로 보여 줄 수 있게
   * 목록이 아니라 상세와 처리 응답에 싣는다. `sourceVisibility`는 원본 자료의 공개 범위이고,
   * `widerThanSource`가 참이면 문서가 원본보다 넓게 열린다는 뜻이다.
   */
  const documentAudienceOf = (source) => {
    const sourceVisibility = String(source?.visibility ?? '')
    // **문자열이 아니라 판정을 읽는다.** `visibility:'all'`이라도 개발운영지원 자료(분류 '개발운영지원'
    // 또는 태그 'developer-support')는 올린 사람에게만 열린다 — 그 갈래에서 문자열로 재면
    // 문서가 원본보다 **훨씬** 넓게 열리는 바로 그때 경고가 빠진다(규칙 8·11).
    const widerThanSource = Boolean(source) && !isDocumentOpenToEveryone(source)
    return {
      scope: 'tenant',
      sourceVisibility,
      widerThanSource,
      message: widerThanSource ? DOCUMENT_AUDIENCE_MESSAGE.wider : DOCUMENT_AUDIENCE_MESSAGE.same,
    }
  }

  /**
   * AI 처리 수준을 **올리거나 내릴 수 있는 사람** — 그 자료를 올린 사람과 관리자뿐이다(부록 C-1).
   * 라우트 8(올리기)·9(되돌리기)와 화면에 실어 보내는 `aiLevel.mayRaise`가 **한 술어**를 본다:
   * 셋이 갈리면 화면이 누를 수 없는 사람에게 버튼을 그려 주고 그 버튼은 403만 받는다(규칙 8·11).
   */
  const canChangeAiLevel = (source, auth) => Boolean(source) && (source.uploadedById === auth?.id || auth?.role === 'tenant-admin')

  /**
   * 「지금 수준이 무엇이고, **이 사람이** 더 올릴 수 있는가」. 화면은 이것으로 「「활용」으로 올려
   * 다시 정리」를 그릴지 정한다 — 「정리」에서 「활용」으로 가는 길이 409 갈래에만 있으면,
   * 한 번 「정리」를 고른 사람은 409를 다시 받지 못해 화면에서 영영 올라갈 수 없다(규칙 11).
   */
  const aiLevelStateOf = (auth, meeting) => {
    const source = sourceOf(auth.tenantId, meeting)
    return { current: source ? aiLevelOf(source) : '', mayRaise: canChangeAiLevel(source, auth) }
  }

  /**
   * 이 회의들의 회의록 문서 가운데 **위키에 실제로 남아 있는 것**. 회의 레코드의 `documentId`로
   * 재지 않는다 — 요약 커밋이 실패해 생긴 미아 문서는 `documentId`가 ''인데도 전 직원에게 열려 있고,
   * 회의를 지운 뒤에는 레코드 자체가 없다(규칙 11).
   * 되돌리기와 삭제가 같은 사실을 같은 말로 말하게 하는 한 벌이다(규칙 3).
   */
  const remainingMeetingDocuments = (tenantId, meetingIds, ownMeetingId = null) => {
    const documentIds = [...new Set(meetingIds
      .map((id) => findSystemWikiDocument(tenantId, meetingDocumentKey(id))?.id ?? '')
      .filter(Boolean))]
    const ownDocumentId = ownMeetingId
      ? findSystemWikiDocument(tenantId, meetingDocumentKey(ownMeetingId))?.id ?? ''
      : ''
    return {
      documentIds,
      ownDocumentId,
      sentence: remainingDocumentSentence(documentIds.length, { includesOwn: ownMeetingId ? Boolean(ownDocumentId) : true }),
    }
  }

  const transcriptionStatus = () => ({
    provider: transcription.name,
    acceptsAudio: Boolean(transcription.acceptsAudio),
    acceptsTranscript: Boolean(transcription.acceptsTranscript),
    mimeTypes: Array.isArray(transcription.mimeTypes) ? [...transcription.mimeTypes] : [],
    extensions: Array.isArray(transcription.extensions) ? [...transcription.extensions] : [],
  })

  // ── 사용량 원장 ───────────────────────────────────────────────────────────
  const usageActorFor = (id, tenantId) => ({ id, role: 'system', trusted: true, tenantId })

  /**
   * 원장 쓰기 한 번. **어떤 실패도 회의록을 막지 않는다** — 청구를 남기지 못한 것은 청구의 문제이지
   * 사람이 올린 회의의 문제가 아니다. 무슨 일이 있었는지는 회의 레코드의 `*Accounting`이 말한다.
   */
  const recordUsage = async ({ actorId, tenantId, event, reservationId, previousAccounting = null }) => {
    if (!billingService) return 'not-applicable'
    const actor = usageActorFor(actorId, tenantId)
    try {
      await billingService.recordUsageEvent(actor, { ...event, reservationId: reservationId ?? null })
      return 'recorded'
    } catch (ledgerError) {
      if (!reservationId) {
        // 예약이 없으면 정산 대기로 넘길 자리도 없다. 다만 **앞선 시도가 이미 원장에 남긴 사실**은
        // 이번 실패가 지우지 못한다 — 정산 대기 줄이 원장에 그대로 있는데 「예약도 기록도 하지
        // 못했다」(not-recorded)로 되돌리면, 화면이 읽는 낱말이 원장과 어긋난다(규칙 11).
        return STANDING_ACCOUNTING.includes(previousAccounting) ? previousAccounting : 'not-recorded'
      }
      try {
        await billingService.recordReconciliationPending(actor, {
          ...event,
          reservationId,
          usageEventId: event.id,
          id: `reconciliation:${event.id}`,
          lastError: ledgerError instanceof Error ? ledgerError.message : String(ledgerError),
        })
        return 'reconciliation-pending'
      } catch (reconciliationError) {
        console.error('[meeting-notes] 사용량 정산 대기 기록에 실패했습니다', { message: reconciliationError?.message })
        return 'reconciliation-unavailable'
      }
    }
  }

  /**
   * 전사 한 번의 사용량. 이벤트 id가 회의별로 결정론이라 **다시 눌러도 원장에는 한 줄**이다.
   *
   * 그래서 처음 성공한 이벤트의 신원(누가·어느 어댑터로·언제)을 회의에 적어 두고 재시도 때 그대로
   * 다시 낸다 — 원장의 중복 판정은 id만이 아니라 그 값들까지 함께 보므로(billing-service의
   * `usageIdentity`), 시각이나 사람이 달라지면 같은 일이 두 줄이 되거나 409로 갈린다.
   * 두 번째부터는 예약도 잡지 않는다(이미 확정된 한 줄을 다시 확정할 뿐이다).
   */
  const recordTranscriptionUsage = async (meeting, auth, { durationMs, sourceMime, characters, startedAt }) => {
    if (!billingService) return { accounting: 'not-applicable', identity: meeting.usage?.transcriptionEvent ?? null }
    const known = meeting.usage?.transcriptionEvent ?? null
    const identity = known ?? {
      id: `meeting:${meeting.id}:transcription`,
      userId: auth.id,
      model: `transcription:${transcription.name}`,
      occurredAt: startedAt.toISOString(),
    }
    let reservationId = null
    if (!known) {
      // 예약을 먼저 잡는다 — 예약이 있으면 원장의 한도 차단을 건너뛴다. 예약 자체가 막히면
      // (한도 초과 + 차단 설정) 회의록은 그대로 만들고 사용량만 남기지 못한 것으로 적는다.
      try {
        const reserved = await billingService.reserveUsage(usageActorFor('server:meeting-notes', meeting.tenantId), {
          id: `meeting-transcription-res:${meeting.tenantId}:${auth.id}:${randomBytes(12).toString('hex')}`,
          tenantId: meeting.tenantId,
          userId: identity.userId,
          feature: 'meeting-transcription',
          model: identity.model,
          estimatedInputTokens: 0,
          estimatedOutputTokens: 0,
          occurredAt: identity.occurredAt,
        })
        reservationId = reserved.reservation.id
      } catch (error) {
        console.error('[meeting-notes] 전사 사용량 예약에 실패했습니다', { message: error?.message })
      }
    }
    const accounting = await recordUsage({
      actorId: 'server:meeting-notes',
      tenantId: meeting.tenantId,
      reservationId,
      // 재시도(`known`)는 예약을 새로 잡지 않는다 — 이미 확정된 한 줄을 다시 확정할 뿐이다.
      // 그때 원장이 여전히 죽어 있어도 **앞선 시도가 남긴 회계 사실**은 그대로다.
      previousAccounting: known ? meeting.usage?.transcriptionAccounting ?? null : null,
      event: {
        ...identity,
        tenantId: meeting.tenantId,
        feature: 'meeting-transcription',
        inputTokens: 0,
        outputTokens: 0,
        durationMs,
        metadata: {
          meetingId: meeting.id,
          provider: transcription.name,
          sourceMime: String(sourceMime ?? ''),
          characters,
          ...usageMetadataFor(auth),
        },
      },
    })
    return { accounting, identity: accounting === 'not-recorded' && !known ? null : identity }
  }

  // ── 전사 ──────────────────────────────────────────────────────────────────
  /** 어댑터가 던진 것을 그대로 HTTP로 옮긴다. 문장은 어댑터가 갖고 있다(없는 연동 503, 못 읽는 형식 415). */
  const transcriptionRefusal = (error) => (error instanceof TranscriptionError
    ? { status: error.status, code: error.code, message: error.message }
    : ERRORS.WRITE_FAILED)

  /**
   * 전사 한 번. 반환은 `{ meeting }` 또는 `{ refusal }`.
   * `staged`는 같은 커밋에 실린 자료 목록 변경(AI 수준 올리기)의 손잡이다.
   */
  const runTranscription = async (auth, meeting, { staged = null } = {}) => {
    const source = sourceOf(auth.tenantId, meeting)
    if (!source) return { refusal: ERRORS.SOURCE_REQUIRED }
    if (!canReadDocument(source, auth)) return { refusal: ERRORS.SOURCE_FORBIDDEN }
    if (!aiMayReadBody(aiLevelOf(source))) return { refusal: AI_LOCKED }
    if (!documentStorage) return { refusal: ERRORS.SOURCE_MISSING }

    const filename = sourceFileName(source)
    if (!transcription.accepts(source.mime, filename)) {
      // 파일을 읽어 오기 전에 어댑터에게 **먼저 묻는다** — 연동이 없으면(none) 바이트를 꺼낼 이유가 없고,
      // 「왜 안 되는가」의 문장은 어댑터가 갖고 있다. 여기서 다시 적으면 두 문장이 갈린다.
      try {
        await transcription.transcribe({ body: '', mime: source.mime, filename })
      } catch (error) {
        return { refusal: transcriptionRefusal(error) }
      }
      // accepts와 transcribe가 서로 다른 말을 했다. 사람에게는 형식 문제로 답한다.
      return { refusal: { status: 415, code: 'MEETING_SOURCE_UNSUPPORTED', message: '이 형식은 회의록 원문으로 읽을 수 없습니다. TXT·VTT·SRT·Markdown 파일을 올려 주세요.' } }
    }

    // **중간 저장은 `staged`를 확정하지 않는다.** 이 커밋은 「지금 전사 중」이라는 사실만 남기는
    // 자리이고, 여기서 자료 목록 변경까지 확정해 버리면 그 뒤의 어떤 실패(410·어댑터 오류·
    // 502·503)도 올린 AI 수준을 되돌리지 못한다 — 아무것도 만들지 못한 처리가 문만 열어 둔다(규칙 9).
    const transcribing = { ...meeting, status: 'transcribing', error: '', updatedAt: nowIso() }
    if (!await saveMeetings(auth.tenantId, replaceMeeting(meetingsOf(auth.tenantId), transcribing), auth.id)) {
      return { refusal: ERRORS.WRITE_FAILED }
    }

    const startedAt = clock()
    let body = null
    try {
      body = await getTenantDocument(documentStorage, source, auth.tenantId)
    } catch (error) {
      console.error('[meeting-notes] 회의 원본 파일을 읽지 못했습니다', { message: error?.message })
      return { refusal: ERRORS.SOURCE_MISSING, failed: transcribing }
    }

    let result = null
    try {
      result = await transcription.transcribe({ body, mime: source.mime, filename })
    } catch (error) {
      return { refusal: transcriptionRefusal(error), failed: transcribing }
    }

    const stored = clipCharacters(result.text, MAX_TRANSCRIPT_STORED)
    const read = countCharacters(result.text)
    // 글자 수는 **원문 전체**를 센다. 어댑터가 자기 상한(200,000자)에서 이미 자른 뒤의 길이를 세면
    // 화면이 실제보다 짧은 회의였다고 말한다 — 어댑터가 버린 글자 수는 `unreadCharacters`로 온다.
    const unread = Math.max(0, Number(result.unreadCharacters ?? 0))
    const characters = Number.isFinite(Number(result.sourceCharacters)) ? Number(result.sourceCharacters) : read + unread
    const usage = await recordTranscriptionUsage(transcribing, auth, {
      durationMs: Math.max(0, clock().getTime() - startedAt.getTime()),
      sourceMime: source.mime,
      characters,
      startedAt,
    })
    // 파일을 읽고 사용량을 적는 동안 사람이 수준을 내렸을 수 있다. **잠긴 자료의 전사 사본을
    // 남기지 않는다** — 이 자리에서 다시 재는 것이 그 약속을 지키는 유일한 지점이다.
    const fresh = recheckBeforeWrite(auth, transcribing.id)
    if (fresh.refusal) return { refusal: fresh.refusal, failed: transcribing }
    const next = {
      ...fresh.meeting,
      transcriptText: stored,
      transcriptChars: characters,
      // 회의 레코드에 앞부분만 담았다(정본은 자료실의 원본 파일이다).
      transcriptTruncated: read > MAX_TRANSCRIPT_STORED,
      // 어댑터가 아예 읽지 못한 뒷부분. 0이 아니면 요약도 그만큼을 보지 못했다.
      transcriptUnreadChars: unread,
      status: 'uploaded',
      error: '',
      usage: {
        ...fresh.meeting.usage,
        transcriptionMs: Number(result.durationMs ?? 0),
        transcriptionAccounting: usage.accounting,
        ...(usage.identity ? { transcriptionEvent: usage.identity } : {}),
      },
      updatedAt: nowIso(),
    }
    if (!await saveMeetings(auth.tenantId, replaceMeeting(meetingsOf(auth.tenantId), next), auth.id, staged)) {
      return { refusal: ERRORS.WRITE_FAILED, failed: transcribing }
    }
    return { meeting: next }
  }

  // ── 요약 · 문서 · 제안 ────────────────────────────────────────────────────
  const participantNamesOf = (tenantId, participantIds) => (Array.isArray(participantIds) ? participantIds : [])
    .map((id) => accounts.find((account) => account?.id === id && account?.tenantId === tenantId)?.name ?? '')
    .filter(Boolean)

  /**
   * 모델에게 물어 요약을 받는다. 반환은 `{ summary, usage }` 또는 `{ refusal }`.
   * 실패를 조용히 폴백으로 덮지 않는다 — 사람이 다시 누를 수 있고, 무엇이 안 됐는지 알아야 한다
   * (설계 §3.5의 오류표. 자동 재시도는 없다).
   */
  const askForSummary = async (auth, meeting) => {
    const startedAt = clock()
    const usageActor = usageActorFor('server:meeting-summary', auth.tenantId)
    const { system, user } = buildMeetingSummaryPrompt({
      title: meeting.title,
      transcript: meeting.transcriptText,
      participants: participantNamesOf(auth.tenantId, meeting.participantIds),
    })
    const messages = [{ role: 'user', content: user }]
    let reservation = null
    let providerSucceeded = false
    try {
      const counted = typeof client.messages.countTokens === 'function'
        ? await client.messages.countTokens({ model, system, messages })
        : { input_tokens: Math.ceil(JSON.stringify({ system, messages }).length / 4) }
      reservation = (await billingService.reserveUsage(usageActor, {
        id: `meeting-summary-res:${auth.tenantId}:${auth.id}:${randomBytes(12).toString('hex')}`,
        tenantId: auth.tenantId,
        userId: auth.id,
        feature: 'meeting-summary',
        model,
        estimatedInputTokens: Number(counted.input_tokens || 0),
        estimatedOutputTokens: SUMMARY_MAX_TOKENS,
        occurredAt: startedAt.toISOString(),
      })).reservation
      const result = await client.messages.create({
        model,
        max_tokens: SUMMARY_MAX_TOKENS,
        system,
        messages,
        output_config: MEETING_SUMMARY_OUTPUT_CONFIG,
      })
      providerSucceeded = true
      // 토큰은 이미 썼다. 응답의 모양이 틀렸더라도 **원장에는 먼저 적는다** —
      // 쓴 것을 적지 않으면 청구가 사용자에게 유리한 방향으로 틀린다.
      const accounting = await recordUsage({
        actorId: 'server:meeting-summary',
        tenantId: auth.tenantId,
        reservationId: reservation.id,
        event: {
          id: `anthropic:${result.id || randomBytes(12).toString('hex')}`,
          tenantId: auth.tenantId,
          userId: auth.id,
          feature: 'meeting-summary',
          // 청구 모델 정체성은 **예약 시점의 모델**이다(요율 스냅샷이 그때 잡혔다).
          model: reservation.model,
          inputTokens: Number(result.usage?.input_tokens || 0),
          outputTokens: Number(result.usage?.output_tokens || 0),
          occurredAt: startedAt.toISOString(),
          durationMs: Math.max(0, clock().getTime() - startedAt.getTime()),
          metadata: { meetingId: meeting.id, providerResponseModel: result.model || model, ...usageMetadataFor(auth) },
        },
      })
      const summary = normalizeMeetingSummary(extractText(result), meeting.transcriptText)
      return {
        summary,
        usage: {
          tokensIn: Number(result.usage?.input_tokens || 0),
          tokensOut: Number(result.usage?.output_tokens || 0),
          summaryAccounting: accounting,
        },
      }
    } catch (error) {
      if (!providerSucceeded && reservation) {
        try { await billingService.releaseUsageReservation(usageActor, { tenantId: auth.tenantId, reservationId: reservation.id }) }
        catch { /* 잡아 둔 예약은 만료로 스스로 풀린다 */ }
      }
      // 요약 결과의 모양이 틀렸다(502 MEETING_SUMMARY_INVALID) — 순수 모듈이 갖고 있는 문장 그대로.
      if (error instanceof MeetingSummaryError) return { refusal: { status: error.status, code: error.code, message: error.message } }
      // 한도·원장 거절도 그 문장 그대로 나간다. 「회의록이 안 된다」가 아니라 「한도를 넘었다」가 사실이다.
      if (error?.name === 'BillingServiceError') return { refusal: { status: error.status, code: error.code, message: error.message } }
      console.error('[meeting-notes] 회의 요약에 실패했습니다', { message: error?.message })
      // 벤더 오류는 이 저장소가 이미 쓰는 한 벌로 옮긴다(인증 실패 503 CLAUDE_AUTH_ERROR 등).
      // 폴백으로 조용히 덮지 않는다 — 무엇이 안 됐는지 알아야 사람이 다시 누를 수 있다.
      return { refusal: typeof mapAnthropicError === 'function' ? mapAnthropicError(error) : { status: 502, code: 'CLAUDE_API_ERROR', message: 'Claude 응답을 가져오지 못했습니다. 잠시 후 다시 시도해 주세요.' } }
    }
  }

  /**
   * 요약 → 회의록 문서 → 업무 제안. 반환은 `{ meeting, queued, skipped, mode, proposalsSkipped }` 또는 `{ refusal }`.
   * 문서는 **한 번만** 만든다(`documentId`가 이미 있으면 다시 만들지 않는다).
   */
  const runSummary = async (auth, meeting, { level, staged = null } = {}) => {
    // 수준을 먼저 본다. 둘 다 참일 때(잠긴 원본 + 전사 없음) 사람이 **할 수 있는 일**을 말하는 쪽은
    // 이쪽이다 — 잠겨 있으면 전사부터가 되지 않으므로 「먼저 전사하라」는 아무도 못 하는 일을 시킨다.
    if (!aiMayReadBody(level)) return { refusal: AI_LOCKED }
    if (!String(meeting.transcriptText ?? '').trim()) return { refusal: ERRORS.TRANSCRIPT_REQUIRED }

    // 전사와 같은 이유로 중간 저장은 `staged`를 확정하지 않는다(위 runTranscription 주석).
    const summarizing = { ...meeting, status: 'summarizing', error: '', updatedAt: nowIso() }
    if (!await saveMeetings(auth.tenantId, replaceMeeting(meetingsOf(auth.tenantId), summarizing), auth.id)) {
      return { refusal: ERRORS.WRITE_FAILED }
    }

    let summary = null
    let usagePatch = { tokensIn: 0, tokensOut: 0, summaryAccounting: 'not-applicable' }
    if (client && billingService) {
      const asked = await askForSummary(auth, summarizing)
      if (asked.refusal) return { refusal: asked.refusal, failed: summarizing }
      summary = asked.summary
      usagePatch = asked.usage
    } else {
      // 모델을 부르지 않았다. **0원 행을 원장에 넣지 않는다** — 부르지 않은 호출의 값은 0이 아니라 없음이다.
      summary = fallbackMeetingSummary(summarizing.transcriptText, { title: summarizing.title, now: clock() })
    }

    // 모델을 부르는 동안 사람이 수준을 내렸을 수 있다. **잠긴 자료에서 회의록 문서와 업무 제안이
    // 태어나지 않게** 만들기 직전에 다시 잰다 — 되돌리기가 지나갔다면 전사 사본도 이미 비어 있다.
    const fresh = recheckBeforeWrite(auth, summarizing.id)
    if (fresh.refusal) return { refusal: fresh.refusal, failed: summarizing }
    if (!String(fresh.meeting.transcriptText ?? '').trim()) return { refusal: ERRORS.TRANSCRIPT_REQUIRED, failed: summarizing }
    const current = fresh.meeting
    // 파생물을 만들어도 되는가도 **지금** 값으로 판정한다(수준은 그 사이에 오르내릴 수 있다).
    const mayDerive = aiMayDerive(fresh.level)

    // 1) 회의록 문서. 원문 전문은 담지 않는다 — 이 문서는 회사 전원이 읽는다.
    //
    // **「문서가 있는가」는 위키의 실제 행으로 잰다.** 회의 레코드의 `documentId`는 그때 만든 문서의
    // id를 적어 둔 사본일 뿐이고, 그 문서는 사람 손(관리자 완전 삭제)으로도 사람 손 없이도
    // (보관 30일 뒤 `sweepWikiArchive`) 사라진다. 사본으로 재면 사라진 뒤에도 「이미 있다」로 읽혀
    // 회의는 문서를 영영 다시 만들지 못하고, 응답의 `documentId`·`documentReused`와 그 뒤 태어나는
    // 업무 제안의 `payload.documentId`(승인하면 업무의 `origin.focusId`까지)가 모두 404가 되는
    // id를 가리킨다 — 결재자가 근거를 열 수 없다(규칙 11).
    // 되돌리기·삭제가 남은 문서를 세는 자리와 **같은 자**다(`findSystemWikiDocument`, 규칙 3·8).
    const existingDocument = findSystemWikiDocument(auth.tenantId, meetingDocumentKey(summarizing.id))
    let documentId = existingDocument?.id ?? ''
    // 문서는 회의당 한 번만 만든다. 두 번째부터는 **이번 요약이 문서에 들어가지 않았다**는 사실을
    // 응답이 말해야 한다 — 사람이 이어서 고쳤을 수 있어 서버가 덮어쓰지 않기 때문이다(설계 §0.3).
    let documentReused = Boolean(existingDocument)
    if (!existingDocument) {
      const recording = libraryDocumentOf(auth.tenantId, summarizing.recordingDocumentId)
      const transcript = libraryDocumentOf(auth.tenantId, summarizing.transcriptDocumentId)
      const created = await createWikiDocument({
        auth,
        // 제목은 **다시 읽은 그 행**의 것을 쓴다 — 손에 든 사본은 모델을 부르는 동안 낡는다.
        title: `${current.title} 회의록`,
        templateId: 'WDOC-TPL-MEETING',
        blocks: buildMeetingBlocks({
          summary,
          recordingDocumentId: summarizing.recordingDocumentId ?? '',
          transcriptDocumentId: summarizing.transcriptDocumentId ?? '',
          recordingName: recording?.name ?? '',
          transcriptName: transcript?.name ?? '',
        }),
        origin: { kind: 'meeting', label: '회의록에서 생성', page: 'meetings', focusId: summarizing.id },
        // 같은 회의에 문서가 둘 생기지 않게 한다 — 아래 커밋이 실패해 사람이 다시 눌러도
        // 문서는 그때 만든 그 한 건이다. **`POST /api/wiki`가 쓰는 `clientRequestId`와 다른 칸**이다:
        // 같은 칸이면 회의를 볼 수 있는 아무나 이 키로 빈 문서를 먼저 만들어 두는 것만으로
        // 요약이 그 문서를 회의록으로 채택한다(규칙 7).
        systemRequestId: meetingDocumentKey(summarizing.id),
      })
      if (created.refusal) return { refusal: created.refusal, failed: summarizing }
      documentId = created.document.id
      // 멱등 키로 되돌아온 문서(앞선 시도가 만들어 둔 것)도 이번 요약을 담고 있지 않다.
      documentReused = Boolean(created.replayed)
    }

    // 2) 업무 제안. '활용'일 때만 만든다 — 파생물을 만드는 것은 '활용'의 뜻 그 자체다.
    const rollbackProposals = snapshotProposals(auth.tenantId)
    const queuedProposals = []
    let skipped = 0
    if (mayDerive) {
      for (const [index, task] of summary.tasks.entries()) {
        const proposal = {
          id: newProposalId(),
          kind: 'meeting-task',
          status: 'pending',
          confidence: null,
          // 같은 회의를 다시 요약해도 대기 중인 제안은 회의·순서당 하나다.
          sourceKey: `${meetingProposalPrefix(current.id)}${index}`,
          summary: task.title,
          // 결재자가 읽는 근거 문장. 제목은 기안자·관리자만 바꿀 수 있고(라우트 4), 여기에는
          // **다시 읽은 그 행**의 제목이 들어간다.
          evidence: `“${task.quote}” · 회의록 「${current.title}」`,
          payload: {
            title: task.title,
            owner: task.owner,
            due: task.due,
            meetingId: current.id,
            documentId,
          },
          createdAt: nowIso(),
          createdBy: auth.id,
        }
        // 알림·SSE는 커밋 뒤에 낸다 — 되돌릴 수 없는 것은 되돌릴 수 있는 것 **뒤에** 선다.
        if (enqueueProposal(auth.tenantId, proposal, { announce: false })) queuedProposals.push(proposal)
        else skipped += 1
      }
    }
    // 앞선 요약이 남긴 **대기 중** 제안은 그때의 문서 id를 사본으로 들고 있다. 문서가 사라져
    // 방금 새로 만들었다면 그 사본만 죽은 id로 남아 결재자의 「근거 열기」가 404로 간다 —
    // 사본은 정본을 따른다(규칙 11). 같은 커밋에 실리므로 `rollbackProposals`가 함께 되돌린다.
    if (documentId) repointMeetingProposals(auth.tenantId, current.id, documentId, auth.id)

    const next = {
      // 낡은 사본이 아니라 **다시 잰 그 행** 위에 얹는다(위 recheckBeforeWrite 참고).
      ...current,
      summary,
      documentId,
      proposalIds: [...new Set([...(current.proposalIds ?? []), ...queuedProposals.map((row) => row.id)])],
      usage: { ...current.usage, ...usagePatch, mode: summary.mode },
      status: 'done',
      error: '',
      updatedAt: nowIso(),
    }
    if (!await saveMeetings(auth.tenantId, replaceMeeting(meetingsOf(auth.tenantId), next), auth.id, staged, rollbackProposals)) {
      return { refusal: ERRORS.WRITE_FAILED, failed: summarizing }
    }
    for (const proposal of queuedProposals) {
      try { announceProposal(auth.tenantId, proposal) } catch (error) { console.error('[meeting-notes] 제안 알림에 실패했습니다', { message: error?.message }) }
    }
    return {
      meeting: next,
      queued: queuedProposals.length,
      skipped,
      mode: summary.mode,
      documentReused,
      ...(mayDerive ? {} : { proposalsSkipped: 'ai-level' }),
    }
  }

  /**
   * 실패를 회의에 적어 둔다. 적지 못해도 사람에게 답하는 오류는 바뀌지 않는다.
   *
   * **지금 저장돼 있는 행 위에 적는다.** 손에 든 옛 사본으로 덮으면 그 사이에 파기된 전사 사본과
   * 요약이 「실패」라는 이름표를 달고 되살아나고, 지워진 회의가 다시 목록에 선다(규칙 9).
   */
  const markFailed = async (auth, meeting, refusal) => {
    const rows = meetingsOf(auth.tenantId)
    const current = rows.find((row) => row?.id === meeting.id)
    if (!current) return
    const failed = { ...current, status: 'failed', error: clip(refusal.message, MAX_ERROR_TEXT), updatedAt: nowIso() }
    await saveMeetings(auth.tenantId, replaceMeeting(rows, failed), auth.id)
  }

  // ── AI 처리 수준 ──────────────────────────────────────────────────────────
  /**
   * 본문이 요청한 AI 처리 수준을 원본 자료에 **올리는 방향으로만** 얹는다.
   * `PATCH /api/documents/:id`(관리자 전용)를 건드리지 않는 이유가 여기다 — 직원이 자기 회의를
   * 스스로 처리할 수 있어야 하고, 그 권한은 「이 원본을 올린 사람」이라는 사실에서 나온다.
   * 반환은 `{ level, rollback }` 또는 `{ refusal }`.
   */
  const applyRequestedLevel = (auth, meeting, requested) => {
    const source = sourceOf(auth.tenantId, meeting)
    if (!source) return { refusal: ERRORS.SOURCE_REQUIRED }
    if (!canReadDocument(source, auth)) return { refusal: ERRORS.SOURCE_FORBIDDEN }
    const current = aiLevelOf(source)
    if (requested === undefined || requested === null || requested === '') return { level: current, rollback: null }
    if (!canChangeAiLevel(source, auth)) return { refusal: ERRORS.POLICY_FORBIDDEN }
    const wanted = normalizeAiLevel(requested)
    // 모르는 값과 「지금보다 낮거나 같은 값」은 같은 답이다 — 아무것도 하지 않는다.
    // 회의록 화면은 수준을 **올리는** 자리이지 내리는 자리가 아니다(내리는 것은 revoke-ai가 한다).
    if (!wanted || AI_LEVELS.indexOf(wanted) <= AI_LEVELS.indexOf(current)) return { level: current, rollback: null }
    const documents = documentsOf(auth.tenantId).map((row) => (row?.id === source.id ? { ...row, aiPolicy: wanted } : row))
    // 커밋은 부르는 쪽(전사·요약의 저장)이 한다. 자료 목록과 회의가 **한 커밋**에 들어가고 함께 되돌아간다.
    return { level: wanted, rollback: stageDocumentList(auth.tenantId, documents, auth.id) }
  }

  // ── 프로세스 내 잠금 ──────────────────────────────────────────────────────
  /**
   * 지금 처리 중인 회의. 저장된 status로 재지 않는다 — 프로세스가 죽으면 'transcribing'으로 굳은
   * 회의를 아무도 다시 처리할 수 없게 된다(스케줄러를 쓰지 않으므로 되살릴 사람은 사용자뿐이다).
   * 한계: 한 프로세스 안에서만 유효하다.
   */
  const processing = new Set()
  /**
   * 이 회의를 처리하는 한 번. 실패를 회의에 적는 일도 **잠금 안에서** 한다 —
   * 밖에서 적으면 그 사이에 시작된 다음 처리의 'transcribing'을 지난 실패로 덮어쓴다.
   */
  const processMeeting = async (auth, meeting, run) => {
    if (processing.has(meeting.id)) return { refusal: ERRORS.ALREADY_PROCESSING }
    processing.add(meeting.id)
    try {
      const result = await run()
      if (result.refusal && result.failed) await markFailed(auth, result.failed, result.refusal)
      return result
    } finally {
      processing.delete(meeting.id)
    }
  }

  // ── 라우트 ────────────────────────────────────────────────────────────────

  // 1. 목록
  app.get('/api/meetings', ...guards, (request, response) => {
    if (!requireTenant(request, response)) return
    const auth = request.auth
    const status = String(request.query?.status ?? '').trim()
    const requestedLimit = Number.parseInt(String(request.query?.limit ?? ''), 10)
    const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, MAX_LIST_LIMIT) : DEFAULT_LIST_LIMIT
    // 한 묶음 뒤의 나머지에 닿는 길. `limit`만으로는 상한 200 뒤의 회의를 영영 열 수 없는데,
    // 회사당 상한은 1,000건이고 그 409 문구는 「지난 회의를 지운 뒤」라고 말한다 —
    // 정작 지워야 할 지난 회의(정렬은 updatedAt 내림차순)가 닿지 않는 쪽에 있으면 그 문구가 거짓이 된다.
    // 형제 목록(`GET /api/approval-documents`)이 쓰는 것과 같은 이름·같은 규칙이다.
    const requestedOffset = Number(request.query?.offset ?? '')
    const offset = Number.isInteger(requestedOffset) && requestedOffset > 0 ? requestedOffset : 0
    const rows = meetingsOf(auth.tenantId)
      .filter((row) => canSeeMeeting(row, auth))
      .filter((row) => (status ? row.status === status : true))
      .sort((left, right) => String(right?.updatedAt ?? '').localeCompare(String(left?.updatedAt ?? '')))
    response.json({
      meetings: rows.slice(offset, offset + limit).map(publicMeeting),
      // 자른 배열의 길이가 아니라 **실제로 몇 건인가**를 답한다. 화면이 「3건 중 3건」이라고 말하게 두지 않는다.
      total: rows.length,
      transcription: transcriptionStatus(),
    })
  })

  // 2. 만들기
  app.post('/api/meetings', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const auth = request.auth
    const body = request.body ?? {}
    const title = clip(body.title, MAX_MEETING_TITLE)
    if (!title) { fail(response, ERRORS.TITLE_REQUIRED); return }

    const recordingDocumentId = String(body.recordingDocumentId ?? '').trim().slice(0, 160)
    const transcriptDocumentId = String(body.transcriptDocumentId ?? '').trim().slice(0, 160)
    if (!recordingDocumentId && !transcriptDocumentId) { fail(response, ERRORS.SOURCE_REQUIRED); return }
    // 없는 자료와 못 보는 자료에 **같은 답**을 준다 — 가르면 id를 넣어 보는 것만으로 존재가 샌다.
    for (const id of [recordingDocumentId, transcriptDocumentId].filter(Boolean)) {
      const source = libraryDocumentOf(auth.tenantId, id)
      if (!source || !canReadDocument(source, auth)) { fail(response, ERRORS.SOURCE_FORBIDDEN); return }
      // **자료를 열 수 있다는 것과 그 자료를 잠글 수 있다는 것은 다른 권한이다**(규칙 8).
      // 회의 원본으로 지목하면 그 자료는 자료실에서 지워지지 않고(app.mjs의 `'meeting-source'`),
      // 그 409 문구는 「그 회의를 삭제하면 풀린다」고 말한다. 지목이 아무에게나 열려 있으면
      // 자료 주인은 보지도 지우지도 못하는 회의 때문에 자기 자료를 영영 지울 수 없다(규칙 3·11).
      if (source.uploadedById !== auth.id && auth.role !== 'tenant-admin') { fail(response, ERRORS.SOURCE_NOT_MINE); return }
    }

    const rows = meetingsOf(auth.tenantId)
    if (rows.length >= MAX_MEETINGS_PER_TENANT) { fail(response, ERRORS.LIMIT); return }

    const now = nowIso()
    // id·기안자·시각은 본문에서 오지 않는다.
    const meeting = {
      id: newMeetingId(),
      tenantId: auth.tenantId,
      title,
      recordingDocumentId,
      transcriptDocumentId,
      transcriptText: '',
      transcriptChars: 0,
      transcriptTruncated: false,
      transcriptUnreadChars: 0,
      documentId: '',
      participantIds: normalizeParticipants(auth.tenantId, body.participantIds),
      status: 'uploaded',
      error: '',
      summary: null,
      proposalIds: [],
      usage: {},
      createdById: auth.id,
      createdByName: auth.name ?? '',
      createdAt: now,
      updatedAt: now,
    }
    if (!await saveMeetings(auth.tenantId, [meeting, ...rows], auth.id)) { fail(response, ERRORS.WRITE_FAILED); return }
    response.status(201).json({ meeting: publicMeeting(meeting) })
  })

  /**
   * 참석자 명단 정규화. **소속만 보지 않고 역할도 본다**(규칙 8).
   *
   * 참석자 명단은 곧 열람 명단이고(`canSeeMeeting`), 회의 상세는 전사 원문 미리보기가 나가는 문이다.
   * 외부 게스트(`tenant-guest`)는 초대된 프로젝트 안에서만 사는 계정이라 그 문 안에 이름을 올릴
   * 자리가 아니다. 오늘 실제 유출은 없다 — 게스트 라우트 게이트가 `/api/meetings` 전부를 403으로
   * 막는다 — 그러나 방어가 한 층뿐이면 그 게이트가 언젠가 넓어질 때 조용히 열린다.
   * 화면(`/api/directory`)도 이미 `kind === 'employee'`만 후보로 그리므로 서버만 넓었다.
   */
  function normalizeParticipants(tenantId, value) {
    const ids = Array.isArray(value) ? value.map((id) => String(id ?? '').trim()).filter(Boolean) : []
    return [...new Set(ids)]
      .filter((id) => accounts.some((account) => (
        account?.id === id && account?.tenantId === tenantId && account?.role !== GUEST_ROLE
      )))
      .slice(0, MAX_PARTICIPANTS)
  }

  // 3. 한 건
  app.get('/api/meetings/:id', ...guards, (request, response) => {
    if (!requireTenant(request, response)) return
    const auth = request.auth
    const meeting = findMeeting(auth, request.params.id)
    if (!meeting) { fail(response, ERRORS.NOT_FOUND); return }
    // 원문 미리보기는 **원본 자료를 읽을 수 있는 사람에게만** 나간다 — 전사·요약·처리·되돌리기가
    // 전부 `canReadDocument`를 보는데 원문 2,000자를 실제로 내보내는 이 문만 보지 않으면,
    // 열람이 막힌 자료도 참석자로 이름만 올려 두면 읽힌다(규칙 8: 판정은 한 벌이어야 한다).
    const source = sourceOf(auth.tenantId, meeting)
    const mayReadSource = Boolean(source) && canReadDocument(source, auth)
    const transcriptPreview = mayReadSource ? clipCharacters(String(meeting.transcriptText ?? ''), TRANSCRIPT_PREVIEW) : ''
    response.json({
      meeting: publicMeeting(meeting),
      transcriptPreview,
      // **글자를 세는 자리는 하나다.** 미리보기는 코드포인트 상한으로 잘리고 `transcriptChars`도
      // 코드포인트로 세는데, 화면이 `String.length`(UTF-16 코드유닛)로 다시 세면 이모지가 섞인
      // 원문에서 「앞부분 4,000자 보기 (전체 2,100자)」처럼 미리보기가 전체보다 길다고 말한다(규칙 13).
      transcriptPreviewChars: countCharacters(transcriptPreview),
      // 비어 있는 것이 「원문이 없다」인지 「보여 주지 않는다」인지 화면이 갈라 말할 수 있게 한 칸으로 답한다.
      transcriptHidden: !mayReadSource && Boolean(String(meeting.transcriptText ?? '').trim()),
      // 그 차단이 「원문은 보호된다」는 뜻이 아니라는 사실을 **같은 자리에서** 말한다 —
      // 요약과 결정·할 일의 인용은 원문의 문장을 글자 그대로 담아 그대로 나간다(규칙 3·11).
      transcriptHiddenNote: !mayReadSource && Boolean(String(meeting.transcriptText ?? '').trim()) ? TRANSCRIPT_HIDDEN_NOTE : '',
      documentAudience: documentAudienceOf(source),
      // 「정리」에 멈춰 있는 회의를 「활용」으로 올릴 길을 화면이 그릴 근거. 누가 읽느냐에 따라 답이 다르다.
      aiLevel: aiLevelStateOf(auth, meeting),
      transcription: transcriptionStatus(),
    })
  })

  // 4. 제목·참석자
  app.patch('/api/meetings/:id', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const auth = request.auth
    const meeting = findMeeting(auth, request.params.id)
    if (!meeting) { fail(response, ERRORS.NOT_FOUND); return }
    const body = request.body ?? {}
    const next = { ...meeting }
    if (Object.hasOwn(body, 'title')) {
      // 제목은 그냥 이름표가 아니다 — 이 회의에서 나오는 승인 큐 제안의 `evidence`에
      // (“인용” · 회의록 「제목」) 그대로 실려 **결재자가 읽는 근거 문장**이 된다. 참석자는
      // 열람자이지 관리자가 아니므로, 근거를 손볼 수 있는 사람은 기안자와 관리자뿐이다(규칙 8).
      if (!canManageMeeting(meeting, auth)) { fail(response, ERRORS.OWNER_ONLY); return }
      const title = clip(body.title, MAX_MEETING_TITLE)
      if (!title) { fail(response, ERRORS.TITLE_REQUIRED); return }
      next.title = title
    }
    if (Object.hasOwn(body, 'participantIds')) {
      // 참석자 명단은 **열람 명단**이다(참석자는 회의 상세를 본다). 참석자가 참석자를 더할 수 있으면
      // 자기가 받은 열람을 제3자에게 재배포하는 길이 열린다 — 명단은 기안자와 관리자만 바꾼다.
      if (!canManageMeeting(meeting, auth)) { fail(response, ERRORS.OWNER_ONLY); return }
      next.participantIds = normalizeParticipants(auth.tenantId, body.participantIds)
    }
    next.updatedAt = nowIso()
    if (!await saveMeetings(auth.tenantId, replaceMeeting(meetingsOf(auth.tenantId), next), auth.id)) { fail(response, ERRORS.WRITE_FAILED); return }
    response.json({ meeting: publicMeeting(next) })
  })

  // 5. 삭제 — 회의록 문서와 원본 파일은 지우지 않는다(참조만 끊는다).
  //    자료실이 원본을 붙잡아 두는 409 문구가 「회의를 지우면 풀린다」고 말하므로, 이 라우트가
  //    실제로 그 일을 해야 그 문장이 참이 된다.
  app.delete('/api/meetings/:id', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const auth = request.auth
    const meeting = findMeeting(auth, request.params.id)
    if (!meeting) { fail(response, ERRORS.NOT_FOUND); return }
    // 지우는 것은 되돌릴 수 없고, 자료실의 409 문구가 「회의를 지우면 자료도 지울 수 있다」고
    // 말하는 대상은 기안자와 관리자다. 참석자에게 열어 두면 남의 회의를 지우는 길이 된다.
    if (!canManageMeeting(meeting, auth)) { fail(response, ERRORS.OWNER_ONLY); return }
    /**
     * 이 회의에서 나온 **대기 중 제안**을 같은 커밋에서 만료시킨다. 파기의 문 둘(`revoke-ai`·
     * 자료실 `PATCH`)은 모두 「그 자료를 원본으로 쓰는 회의」를 훑어 찾으므로, 회의 행이 사라진
     * 순간 두 문 다 이 제안에 닿지 못한다 — 전사 원문을 글자 그대로 인용한 제안이 승인 큐에
     * 영원히 남고, 원본 파일까지 지운 뒤에는 어떤 수준 조작으로도 파기할 수 없다(DECISIONS 3-5).
     * 회의 행을 지우는 쓰기와 **함께 살거나 함께 죽는다**(규칙 9).
     */
    const rollbackProposals = snapshotProposals(auth.tenantId)
    const expiredProposals = expireMeetingProposals(auth.tenantId, [meeting.id], auth.id)
    const rows = meetingsOf(auth.tenantId).filter((row) => row?.id !== meeting.id)
    if (!await saveMeetings(auth.tenantId, rows, auth.id, null, rollbackProposals)) { fail(response, ERRORS.WRITE_FAILED); return }
    // 회의는 사라져도 **회사 전원이 읽는 회의록 문서는 그대로 남는다**. 같은 사실을 revoke-ai가
    // 말하는 것과 같은 문장으로 말한다(규칙 3) — 남은 것을 알아야 사람이 스스로 정할 수 있다.
    const remaining = remainingMeetingDocuments(auth.tenantId, [meeting.id], meeting.id)
    const parts = ['회의를 지웠습니다. 원본 파일은 자료실에 그대로 있습니다.']
    if (expiredProposals) parts.push(`대기 중이던 업무 제안 ${expiredProposals}건을 만료했습니다.`)
    if (remaining.sentence) parts.push(remaining.sentence)
    response.json({
      ok: true,
      documentId: meeting.documentId ?? '',
      documentIds: remaining.documentIds,
      expiredProposals,
      message: parts.join(' '),
    })
  })

  // 6. 전사
  app.post('/api/meetings/:id/transcribe', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const auth = request.auth
    const meeting = findMeeting(auth, request.params.id)
    if (!meeting) { fail(response, ERRORS.NOT_FOUND); return }
    const result = await processMeeting(auth, meeting, () => runTranscription(auth, meeting))
    if (result.refusal) { fail(response, result.refusal); return }
    response.json({ meeting: publicMeeting(result.meeting) })
  })

  // 7. 요약 — 문서와 업무 제안까지
  app.post('/api/meetings/:id/summarize', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const auth = request.auth
    const meeting = findMeeting(auth, request.params.id)
    if (!meeting) { fail(response, ERRORS.NOT_FOUND); return }
    const source = sourceOf(auth.tenantId, meeting)
    if (!source) { fail(response, ERRORS.SOURCE_REQUIRED); return }
    if (!canReadDocument(source, auth)) { fail(response, ERRORS.SOURCE_FORBIDDEN); return }
    const result = await processMeeting(auth, meeting, () => runSummary(auth, meeting, { level: aiLevelOf(source) }))
    if (result.refusal) { fail(response, result.refusal); return }
    respondProcessed(response, auth, result)
  })

  const respondProcessed = (response, auth, result) => {
    response.json({
      meeting: publicMeeting(result.meeting),
      documentId: result.meeting.documentId,
      queued: result.queued,
      skipped: result.skipped,
      mode: result.mode,
      // 방금 만든 회의록 문서를 **누가 읽는가**. 화면이 그 문장을 지어 쓰지 않게 서버가 싣는다.
      documentAudience: documentAudienceOf(sourceOf(auth.tenantId, result.meeting)),
      // 이번 요약이 그 문서에 들어갔는가. 두 번째 요약부터는 들어가지 않는다 —
      // 화면이 「문서가 이번 요약을 담고 있다」고 읽지 않게 서버가 사실을 싣는다(규칙 11).
      documentReused: Boolean(result.documentReused),
      // 「제안을 올리지 않았다」는 답과 **같은 자리**에서 그 이유를 풀 길이 있는지 말한다 —
      // 화면의 토스트가 지목할 곳(버튼)이 이 사람에게 실제로 있는지가 여기서 갈린다(규칙 11).
      aiLevel: aiLevelStateOf(auth, result.meeting),
      ...(result.documentReused ? { documentNote: DOCUMENT_REUSED_MESSAGE } : {}),
      ...(result.proposalsSkipped ? { proposalsSkipped: result.proposalsSkipped } : {}),
    })
  }

  // 8. 한 번에 — 전사 다음 요약. 본문으로 AI 처리 수준을 **올릴 수 있다**.
  app.post('/api/meetings/:id/process', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const auth = request.auth
    const found = findMeeting(auth, request.params.id)
    if (!found) { fail(response, ERRORS.NOT_FOUND); return }

    const result = await processMeeting(auth, found, async () => {
      const applied = applyRequestedLevel(auth, found, request.body?.aiPolicy)
      if (applied.refusal) return { refusal: applied.refusal }
      const staged = stagedWrite(applied.rollback)
      try {
        if (!aiMayReadBody(applied.level)) return { refusal: AI_LOCKED }
        let meeting = found
        if (!String(meeting.transcriptText ?? '').trim()) {
          const transcribed = await runTranscription(auth, meeting, { staged })
          if (transcribed.refusal) return transcribed
          meeting = transcribed.meeting
        }
        return await runSummary(auth, meeting, { level: applied.level, staged })
      } finally {
        // 저장되지 못한 자료 목록 변경을 메모리에 남기지 않는다 — 커밋되지 않은 채 보이면
        // 다음 요청이 그것을 「이미 올라간 수준」으로 읽는다. 커밋에 성공했다면 아무것도 하지 않는다.
        staged.rollback()
        if (staged.reverted) {
          // 중간 저장(status 'transcribing'·'summarizing')이 이미 커밋됐다면 올라간 수준은 **디스크에도**
          // 있다. 메모리만 되돌리면 재기동 뒤 그 수준이 되살아난다 — 되돌림을 같이 남긴다(규칙 9).
          try { await commitWorkspaceStore() } catch (error) {
            console.error('[meeting-notes] 되돌린 AI 처리 수준을 저장하지 못했습니다', { message: error?.message })
          }
        }
      }
    })

    if (result.refusal) { fail(response, result.refusal); return }
    respondProcessed(response, auth, result)
  })

  // 9. 되돌리기 — 원본을 '보관만'으로 내리고 파생물을 파기한다.
  app.post('/api/meetings/:id/revoke-ai', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const auth = request.auth
    const meeting = findMeeting(auth, request.params.id)
    if (!meeting) { fail(response, ERRORS.NOT_FOUND); return }
    const source = sourceOf(auth.tenantId, meeting)
    if (!source) { fail(response, ERRORS.SOURCE_REQUIRED); return }
    if (!canReadDocument(source, auth)) { fail(response, ERRORS.SOURCE_FORBIDDEN); return }
    if (!canChangeAiLevel(source, auth)) { fail(response, ERRORS.POLICY_FORBIDDEN); return }

    const result = await processMeeting(auth, meeting, async () => {
      const documents = documentsOf(auth.tenantId).map((row) => (row?.id === source.id ? { ...row, aiPolicy: 'locked' } : row))
      const rollbackDocuments = stageDocumentList(auth.tenantId, documents, auth.id)
      // 잠금은 **문서 단위**다(`aiPolicy`는 문서의 칸이다). 파기도 같은 범위여야 한다 —
      // 이 회의만 지우면 같은 원문의 전사 사본·요약·대기 제안이 다른 회의에 그대로 살아남는데
      // 자료는 잠긴다. 자료실 PATCH가 부르는 것과 **같은 함수**다(문이 둘, 규칙은 하나).
      const purged = purgeMeetingDerivatives(auth.tenantId, source.id, auth.id)
      try {
        await commitWorkspaceStore()
      } catch (error) {
        purged.rollback()
        rollbackDocuments()
        console.error('[meeting-notes] AI 처리 수준 되돌리기를 저장하지 못했습니다', { message: error?.message })
        return { refusal: ERRORS.WRITE_FAILED }
      }
      return { meeting: meetingsOf(auth.tenantId).find((row) => row?.id === meeting.id) ?? meeting, purged }
    })

    if (result.refusal) { fail(response, result.refusal); return }
    // **남아 있는 회의록 문서는 회의 레코드의 `documentId`가 아니라 위키에 실제로 있는 행으로 센다.**
    // 요약 커밋이 실패해 생긴 미아 문서는 `documentId`가 ''인데도 전 직원에게 열려 있다 —
    // `documentId`로 재면 응답이 「문서는 남아 있습니다」를 빼고 거짓을 말한다(규칙 11).
    // 이번에 지운 회의뿐 아니라 **이 원본을 쓰는 모든 회의**의 문서를 센다 — 두 번째로 눌러
    // 지울 것이 없을 때도 「그 문서는 아직 열려 있다」는 사실은 그대로이기 때문이다.
    const remaining = remainingMeetingDocuments(auth.tenantId, result.purged.sourceMeetingIds, meeting.id)
    // **한 일만 말한다.** 두 번째로 누르거나 한 번도 처리한 적 없는 회의에서는 지울 파생물이 없다 —
    // 그때도 「지우고 만료했습니다」라고 하면 화면이 그 문장을 그대로 보여 주어 하지 않은 일을
    // 했다고 말한다(규칙 11). 응답의 숫자(0·0)와 문장이 같은 사실을 말해야 한다.
    const parts = [result.purged.meetings || result.purged.proposals
      ? '전사 원문과 요약을 지우고 대기 중인 업무 제안을 만료했습니다.'
      : '원본을 「보관만」으로 되돌렸습니다. 지울 파생물은 없었습니다.']
    // 실제로 몇 건을 지웠는가를 말한다(자른 배열의 길이가 아니다 — 규칙 13).
    if (result.purged.meetings > 1) parts.push(`이 원본을 함께 쓰던 회의 ${result.purged.meetings}건에 모두 적용했습니다.`)
    if (remaining.sentence) parts.push(remaining.sentence)
    response.json({
      meeting: publicMeeting(result.meeting),
      expiredProposals: result.purged.proposals,
      purgedMeetings: result.purged.meetings,
      documentId: remaining.ownDocumentId,
      documentIds: remaining.documentIds,
      // 화면이 이 문장을 그대로 보여 준다 — 남은 것을 사람이 알아야 스스로 정할 수 있다.
      message: parts.join(' '),
    })
  })

  /**
   * 이 회의들에서 나온 **대기 중** 제안을 만료로 바꾼다. 지우지 않는 이유: 결정 이력은 나중에
   * 자동화 승급의 원료가 되고, 지워진 제안은 「사람이 무엇을 보고 무엇을 접었는가」를 말하지 못한다.
   * 실제로 바꾼 수를 돌려준다(자른 배열의 길이가 아니다 — 규칙 13).
   */
  function expireMeetingProposals(tenantId, meetingIds, actorId) {
    const prefixes = meetingIds.map((id) => meetingProposalPrefix(id))
    if (!prefixes.length) return 0
    const existing = proposalsOf(tenantId)
    let expired = 0
    const next = existing.map((row) => {
      if (row?.status !== 'pending') return row
      const key = String(row?.sourceKey ?? '')
      if (!prefixes.some((prefix) => key.startsWith(prefix))) return row
      expired += 1
      return {
        ...row,
        status: 'expired',
        decidedAt: nowIso(),
        decidedBy: actorId,
        decisionDiff: null,
        resolutionNote: 'AI 처리 수준을 「보관만」으로 되돌림',
      }
    })
    if (expired) writeProposals(tenantId, next, actorId)
    return expired
  }

  /**
   * 이 회의의 **대기 중** 제안이 들고 있는 회의록 문서 id를 지금 문서로 맞춘다.
   * `payload.documentId`는 회의 문서 id의 **사본**이라, 문서가 사라져 다시 만들어지면 그 사본만
   * 죽은 id로 남아 결재자가 「근거 열기」에서 404를 본다(규칙 11). 실제로 바꾼 수를 돌려준다(규칙 13).
   * **커밋은 부르는 쪽이 한다** — 요약 저장과 같은 커밋에 실려 함께 살거나 함께 죽는다(규칙 9).
   */
  function repointMeetingProposals(tenantId, meetingId, documentId, actorId) {
    const prefix = meetingProposalPrefix(meetingId)
    const existing = proposalsOf(tenantId)
    let moved = 0
    const next = existing.map((row) => {
      if (row?.status !== 'pending' || row?.kind !== 'meeting-task') return row
      if (!String(row?.sourceKey ?? '').startsWith(prefix)) return row
      if (String(row?.payload?.documentId ?? '') === documentId) return row
      moved += 1
      return { ...row, payload: { ...row.payload, documentId } }
    })
    if (moved) writeProposals(tenantId, next, actorId)
    return moved
  }

  /**
   * 이 자료를 원본(녹음·전사 원문)으로 쓰는 **모든 회의**의 파생물을 파기한다 —
   * 전사 사본·요약·대기 중인 업무 제안. **커밋은 부르는 쪽이 한다**(여기서는 메모리의 세 키만 얹고
   * 되돌리기를 돌려준다) — 수준을 내리는 쓰기와 **같은 커밋**에 실려 함께 살거나 함께 죽어야 한다(규칙 9).
   *
   * 수준을 내리는 문이 둘이다: 회의록의 `POST /api/meetings/:id/revoke-ai`와 자료실의
   * `PATCH /api/documents/:id { aiPolicy:'locked' }`. 판정과 파기가 이 함수 하나에서 나와야
   * 한쪽 문만 약속을 지키는 일이 없다(DECISIONS.md 3-5: 수준을 낮추면 그 위 단계에서 만든
   * 파생물은 파기한다).
   *
   * **회의록 문서(위키)는 지우지 않는다** — 사람이 이어서 고쳤을 수 있고, 서버가 임의로 지우면
   * 사람의 작업을 지운다(설계 §0.3). 그 사실은 부르는 쪽의 응답이 말한다.
   *
   * 반환: `{ meetings, proposals, meetingIds, rollback }` — 개수는 실제로 바꾼 수다(규칙 13).
   */
  const purgeMeetingDerivatives = (tenantId, documentId, actorId) => {
    const id = String(documentId ?? '')
    const tenantStore = workspaceStore.tenants[tenantId] ??= {}
    const previousMeetings = tenantStore[MEETINGS_KEY]
    const rollbackProposals = snapshotProposals(tenantId)
    const rollback = () => {
      rollbackProposals()
      if (previousMeetings) tenantStore[MEETINGS_KEY] = previousMeetings
      else delete tenantStore[MEETINGS_KEY]
    }
    const rows = meetingsOf(tenantId)
    // 빈 id가 「원본을 지정하지 않은 회의」와 맞아떨어지지 않게 먼저 가른다.
    const usingSource = id ? rows.filter((row) => row?.recordingDocumentId === id || row?.transcriptDocumentId === id) : []
    const sourceMeetingIds = usingSource.map((row) => row.id)
    // 이미 비어 있는 회의는 세지 않는다 — 「3건에 적용했습니다」가 **실제로 지운** 건수여야 한다(규칙 13).
    const affected = usingSource.filter((row) => Boolean(String(row?.transcriptText ?? '').trim()) || row?.summary)
    if (!affected.length) return { meetings: 0, proposals: 0, meetingIds: [], sourceMeetingIds, rollback }

    const meetingIds = affected.map((row) => row.id)
    const purgedIds = new Set(meetingIds)
    const now = nowIso()
    const next = rows.map((row) => (purgedIds.has(row?.id) ? {
      ...row,
      transcriptText: '',
      transcriptChars: 0,
      transcriptTruncated: false,
      transcriptUnreadChars: 0,
      summary: null,
      proposalIds: [],
      status: 'uploaded',
      error: '',
      // 전사 이벤트의 신원은 남긴다 — 나중에 수준을 다시 올려 전사해도 원장에는 그 한 줄뿐이어야 한다.
      usage: { ...row.usage, mode: '' },
      updatedAt: now,
    } : row))
    tenantStore[MEETINGS_KEY] = { data: next, updatedAt: now, updatedBy: actorId }
    const proposals = expireMeetingProposals(tenantId, meetingIds, actorId)
    return { meetings: affected.length, proposals, meetingIds, sourceMeetingIds, rollback }
  }

  // 자료실의 `PATCH /api/documents/:id`가 수준을 내릴 때 **같은 규칙**으로 파기하도록 밖에 준다.
  return { purgeMeetingDerivatives }
}

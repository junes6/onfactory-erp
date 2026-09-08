import type { StatusBadgeTone } from '../components/StatusBadge'

/**
 * 회의록 화면이 쓰는 낱말과 모양.
 *
 * 서버(`server/meeting-notes.mjs` · `server/ai-policy.mjs`)가 정본이고 이 파일은 **거울**이다.
 * 거울이 필요한 이유는 화면이 그 값을 한국어로 그려야 하기 때문이고, 거울이 갈리지 않게
 * `scripts/meeting-ui-contract.test.mjs`가 서버 파일을 읽어 글자 그대로 맞대 본다.
 */

/** 서버 `MEETING_STATUSES`와 같은 어휘·같은 순서. */
export type MeetingStatus = 'uploaded' | 'transcribing' | 'summarizing' | 'done' | 'failed'

/**
 * 상태 한 낱말. 「올림」은 파일이 자리에 있다는 뜻이지 AI가 무엇을 했다는 뜻이 아니다 —
 * 아직 아무것도 돌지 않았다는 사실을 그대로 말한다.
 */
export const MEETING_STATUS_LABEL: Record<MeetingStatus, string> = {
  uploaded: '올림',
  transcribing: '전사 중',
  summarizing: '요약 중',
  done: '완료',
  failed: '실패',
}

export function meetingStatusTone(status: string): StatusBadgeTone {
  if (status === 'done') return 'success'
  if (status === 'failed') return 'danger'
  if (status === 'transcribing' || status === 'summarizing') return 'info'
  return 'neutral'
}

/**
 * 「이 회의를 지금 누르면 무엇이 되는가」의 버튼 라벨. **한 곳에서만 나온다** — 목록 줄과 상세
 * 바닥글이 각각 적으면 같은 회의에 두 이름이 붙고, `MEETING_DOCUMENT_MISSING_NOTE`가 지목하는
 * 「다시 정리」가 실제 버튼의 글자와 갈린다(규칙 3·11).
 *
 * `transcribing`·`summarizing`도 「다시 정리」다. 서버는 **저장된 status로 막지 않으므로**
 * (프로세스 안의 잠금만 본다) 프로세스가 죽어 굳은 회의를 사람이 되살릴 수 있고, 그것이
 * 되살릴 유일한 길이다 — 화면이 그 길을 닫으면 그 회의는 영영 굳은 채로 남는다(규칙 1·11).
 */
export function meetingProcessLabel(status: MeetingStatus): string {
  if (status === 'failed') return '다시 시도'
  if (status === 'uploaded') return 'AI로 정리'
  return '다시 정리'
}

/**
 * 「전사 중」·「요약 중」 줄에 붙는 한 문장.
 *
 * 「끝나면 결과가 여기에 나옵니다」는 **참이 아닐 수 있다**: 이 화면은 스스로 새로 고치지 않고,
 * 서버 프로세스가 죽으면 그 상태 그대로 굳는다(서버가 저장된 status로 막지 않는 이유가 바로 그것이다).
 * 그래서 문장은 지금 참인 것만 말하고, **같은 줄에 실제로 있는 버튼 두 개**를 지목한다(규칙 11).
 */
export function meetingProgressNote(status: MeetingStatus): string {
  return `${MEETING_STATUS_LABEL[status] ?? status}입니다. 이 화면은 스스로 새로 고쳐지지 않습니다 — 「새로고침」으로 확인하고, 오래 멈춰 있으면 「${meetingProcessLabel(status)}」를 눌러 주세요.`
}

/** 서버 `AI_LEVELS`·`AI_LEVEL_LABELS`의 거울. 저장은 영문, 표시는 한국어다. */
export type AiLevel = 'locked' | 'indexed' | 'active'
export const AI_LEVEL_LABEL: Record<AiLevel, string> = { locked: '보관만', indexed: '정리', active: '활용' }
export const aiLevelLabel = (value: string) => AI_LEVEL_LABEL[value as AiLevel] ?? AI_LEVEL_LABEL.active

/**
 * 「보관만이라 열 수 없다」는 **한 문장**. 화면의 사전 경고와 서버의 409 거절이 같은 자리에서 나온다
 * (규칙 3). 서버 `server/meeting-notes.mjs`의 `AI_LOCKED.message`와 글자 그대로 같아야 하고,
 * 계약 테스트가 그 파일을 읽어 대조한다.
 */
export const MEETING_AI_LOCKED_MESSAGE = '이 회의 원본의 AI 처리 수준이 「보관만」입니다. 회의록 화면에서 「정리」 이상으로 올려야 전사·요약할 수 있습니다.'

/** 서버가 이 코드를 주면 화면은 동의 대화상자를 연다. */
export const MEETING_AI_LOCKED_CODE = 'MEETING_AI_LOCKED'

/**
 * AI 처리 수준을 **바꿀 수 있는 사람**이 아니라는 한 문장. 서버 `ERRORS.POLICY_FORBIDDEN.message`의
 * 거울이고 계약 테스트가 그 파일을 읽어 대조한다.
 *
 * 라우트 8(올리기)·9(되돌리기)와 상세 응답의 `aiLevel.mayRaise`가 **한 술어**(`canChangeAiLevel`)를
 * 보므로, `mayRaise`가 거짓이면 「AI 결과 파기」는 **언제나** 이 403이다. 그래서 그 자리에는
 * 버튼 대신 이 문장을 둔다 — 눌러야 안 된다는 것을 알게 되는 버튼은 버튼이 아니다(규칙 8·11).
 */
export const MEETING_POLICY_FORBIDDEN_MESSAGE = '이 원본을 올린 사람이나 회사 관리자만 AI 처리 수준을 바꿀 수 있습니다.'

/**
 * 참석자 명단 상한. 서버 `MAX_PARTICIPANTS`의 거울이고 계약 테스트가 두 수를 맞대 본다.
 * 서버의 `normalizeParticipants`는 상한을 넘긴 뒤부터 **조용히 잘라 내고 200으로 답한다** —
 * 그 명단은 곧 열람 명단이므로, 화면이 이 수를 말하지 않으면 21번째로 고른 사람이 말없이 사라진다.
 */
export const MAX_PARTICIPANTS = 20

/**
 * 참석자 상한을 말하는 한 문장. **사실이 둘이라 갈래도 둘이다**(규칙 11): 아직 여유가 있다 ·
 * 상한에 닿아 더 고를 수 없다. 수는 언제나 서버에서 온 상수 하나에서 나온다.
 */
export function meetingParticipantLimitNote(selected: number, limit: number): string {
  return selected >= limit
    ? `참석자는 최대 ${limit}명까지입니다. 더 고르려면 이미 고른 사람을 먼저 빼 주세요.`
    : `참석자는 최대 ${limit}명까지 고를 수 있습니다.`
}

/** 자료 목록을 읽어 봤는가. 「아직 모른다」·「못 읽었다」·「읽었다」는 서로 다른 사실이다. */
export type DocumentsState = 'loading' | 'failed' | 'ready'

/**
 * 원본 자료 한 줄을 그리지 못할 때의 문장. **「모른다」와 「없다」는 다른 사실이므로 문장도 다르다**
 * (규칙 3·11).
 *
 * 자료 목록 요청이 실패하면(세션 만료·네트워크) 화면은 그 자료가 있는지 없는지 **모른다**.
 * 그 상태에서 「열람할 권한이 없거나 사라졌습니다」라고 원인을 단정하면 둘 다 참이 아닐 수 있다 —
 * 요청만 실패했을 뿐이고, 자료는 멀쩡히 있으며 사람에게는 볼 권한도 있다.
 */
export function meetingSourceMissingNote(state: DocumentsState): string {
  if (state === 'loading') return '원본 자료 정보를 불러오는 중입니다…'
  if (state === 'failed') return '자료 목록을 불러오지 못해 원본 자료의 이름과 AI 처리 수준을 표시할 수 없습니다. 「새로고침」을 눌러 다시 시도해 주세요.'
  return '이 회의의 원본 자료를 열람할 권한이 없거나 자료실에서 사라졌습니다.'
}

/**
 * 「회의록 문서는 회사 전원이 읽는다」의 **약한 쪽**(원본도 전원 공개일 때) 한 문장.
 * 서버 `DOCUMENT_AUDIENCE_MESSAGE.same`의 거울이고 계약 테스트가 그 파일을 읽어 대조한다.
 *
 * 화면이 이 거울을 갖는 이유는 하나뿐이다: 동의를 묻는 순간에 상세를 못 읽어도(네트워크가 끊겼거나
 * 서버가 답하지 않아도) **동의 전에 열람 범위를 말하지 않는 일**은 없어야 하기 때문이다.
 * 이 문장은 언제나 참이다 — 원본이 좁으면 서버가 더 강한 문장을 주고, 화면은 그것을 그대로 쓴다.
 */
export const MEETING_DOCUMENT_AUDIENCE_MESSAGE = '회의록 문서(요약·결정 사항·할 일)는 회사 구성원 전원이 읽을 수 있습니다.'

/**
 * 회의 레코드에 담기는 전사 원문 상한(글자). 서버 `MAX_TRANSCRIPT_STORED`의 거울이고
 * 계약 테스트가 두 수를 맞대 본다 — 두 곳에 손으로 적으면 조용히 갈린다.
 */
export const MAX_TRANSCRIPT_STORED = 20_000

/**
 * 요약이 원문의 **뒷부분을 보지 못했다**는 사실 한 문장.
 *
 * 형제 문장(`transcriptUnreadChars` — 어댑터가 상한 200,000자에서 아예 읽지도 못한 글자)과는
 * **다른 사실**이라 문장도 다르다(규칙 11). 이쪽이 10배 먼저 닿는다: 어댑터는 읽었지만
 * 회의 레코드에 20,000자만 담기고, 요약은 그 담긴 것만 본다.
 */
export const transcriptTruncatedNote = (limit: number) =>
  `회의록에 담은 앞부분 ${limit.toLocaleString('ko-KR')}자까지만 요약했습니다. 그 뒤는 원본 파일에서 확인해 주세요.`

/**
 * 끝난 회의인데 회의록 문서가 없다는 사실 한 문장. 문서는 사람 손 없이도 사라지므로
 * (보관 30일 뒤 스윕·관리자의 완전 삭제, 부록 C-2) 이 갈래는 실제로 온다.
 * **여기서 지목하는 「다시 정리」는 같은 줄에 실제로 있는 버튼의 라벨이다** — 누를 곳 없는
 * 해결책을 말하지 않는다(규칙 11).
 */
export const MEETING_DOCUMENT_MISSING_NOTE = '회의록 문서가 없습니다. 「다시 정리」를 누르면 새로 만듭니다.'

/**
 * 목록 한 묶음의 크기. 서버 `DEFAULT_LIST_LIMIT`과 같은 수이고 `MAX_LIST_LIMIT`을 넘지 않는다
 * (계약 테스트가 서버 상수와 맞대 본다). 화면은 이 묶음을 `offset`으로 이어 붙여
 * **세는 수(total)와 보여 주는 수가 갈리지 않게** 한다(규칙 11·13).
 */
export const MEETING_LIST_PAGE_SIZE = 50

/**
 * 회의 원본 자료가 자료실에서 받는 분류와 태그. 서버는 이 둘 중 **하나만 보고도**
 * 그 자료의 AI 처리 수준을 '보관만'으로 정한다(`server/app.mjs`의 `isMeetingRecordingUpload`).
 * 화면이 값을 잊어도 안전한 쪽으로 떨어지도록 수준 자체는 보내지 않는다 — 정하는 곳은 서버다.
 */
export const MEETING_SOURCE_CATEGORY = '회의녹음'
export const MEETING_SOURCE_TAG = 'meeting-recording'

/** 파일 선택 상자가 받는 것. 오디오는 보관용, 글 파일이 오늘 실제로 요약까지 가는 길이다. */
export const MEETING_SOURCE_ACCEPT = 'audio/*,.m4a,.mp3,.wav,.webm,.txt,.vtt,.srt,.md'

/**
 * 회의록 원문으로 읽히는 확장자. 서버 `server/transcription.mjs`의 `TRANSCRIPT_EXTENSIONS`와
 * 같은 집합이어야 하고(계약 테스트가 그 파일을 읽어 대조한다), 화면은 이것으로 올린 파일이
 * 「원문」인지 「녹음」인지만 정한다 — 실제로 읽을 수 있는지는 서버가 다시 잰다(규칙 1).
 */
export const TRANSCRIPT_EXTENSIONS = ['.txt', '.md', '.markdown', '.vtt', '.srt']

export function isTranscriptFileName(name: string) {
  const lower = String(name ?? '').toLowerCase()
  return TRANSCRIPT_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

export type TranscriptionStatus = {
  provider: string
  acceptsAudio: boolean
  acceptsTranscript: boolean
  mimeTypes: string[]
  extensions: string[]
}

/**
 * 지금 무엇이 되고 무엇이 안 되는지 한 문단으로 말한다. **가짜 진행 표시를 만들지 않는다** —
 * 연결이 없으면 없다고 쓰고, 오늘 실제로 되는 길(원문 업로드)을 그 자리에서 알려 준다.
 * 세 갈래는 서로 다른 사실이라 문장도 셋이다(규칙 11).
 */
export function transcriptionNotice(status: TranscriptionStatus | null): string {
  if (!status) return ''
  if (status.acceptsAudio) return ''
  if (status.acceptsTranscript) {
    return '음성 전사 연결이 아직 설정되지 않았습니다. 회의록 원문(.txt·.vtt·.srt·.md)을 올리면 요약과 할 일 추출은 그대로 됩니다. 녹음 파일은 자료실에 보관되기만 합니다.'
  }
  return '음성 전사 연결이 아직 설정되지 않았습니다. 지금은 회의록 원문 파일도 읽지 못합니다 — 관리자가 TRANSCRIPTION_PROVIDER를 text로 켜면 원문(.txt·.vtt·.srt·.md)에서 요약과 할 일을 뽑습니다. 올린 파일은 그때까지 자료실에 그대로 보관됩니다.'
}

/**
 * 화면 맨 위가 「이 회의록 화면이 무엇을 하는가」를 말하는 한 문장.
 *
 * 무조건 「요약·결정 사항·할 일을 뽑아 문서로 만듭니다」라고 약속하면 기본 설정
 * (`TRANSCRIPTION_PROVIDER=none`)에서 거짓이다 — 바로 아래 `.meeting-provider-note`가 같은 화면에서
 * 「원문 파일도 읽지 못합니다」라고 정반대를 말하게 된다(규칙 3·11). 두 문장이 **같은 술어**를 본다.
 *
 * 모르는 것(`null`)은 없는 것이 아니다 — 그때는 아래 안내도 비어 있으므로 갈릴 문장이 없다.
 */
export function meetingHeadline(status: TranscriptionStatus | null): string {
  if (!status || status.acceptsAudio) {
    return '회의 녹음이나 회의록 원문을 올리면 요약·결정 사항·할 일을 뽑아 문서로 만듭니다. 할 일은 승인 큐에 제안으로 올라갑니다.'
  }
  if (status.acceptsTranscript) {
    return '회의록 원문을 올리면 요약·결정 사항·할 일을 뽑아 문서로 만듭니다. 녹음 파일은 자료실에 보관됩니다. 할 일은 승인 큐에 제안으로 올라갑니다.'
  }
  return '회의 녹음과 회의록 원문을 자료실에 보관합니다. 음성 전사 연결이 켜지면 여기에서 요약·결정 사항·할 일을 뽑아 문서로 만듭니다.'
}

/**
 * 전사 연결이 아예 없을 때 서버가 돌려주는 503 문장의 **거울**. 서버
 * `server/transcription.mjs`의 `TRANSCRIPTION_NOT_CONFIGURED`와 글자 그대로 같아야 하고,
 * 계약 테스트가 그 파일을 읽어 대조한다(규칙 3: 사전 경고와 거절이 한 템플릿에서 나온다).
 */
export const TRANSCRIPTION_NOT_CONFIGURED_MESSAGE = '음성 전사 연결이 아직 설정되지 않았습니다. 관리자가 TRANSCRIPTION_PROVIDER를 text로 켜면 회의록 원문(.txt·.vtt·.srt)을 올려 요약과 업무 추출까지 할 수 있습니다.'

/** 글은 읽지만 소리는 못 읽는 어댑터에게 녹음 파일을 준 경우의 415 문장. 역시 서버의 거울이다. */
export const MEETING_SOURCE_UNSUPPORTED_MESSAGE = '이 형식은 회의록 원문으로 읽을 수 없습니다. TXT·VTT·SRT·Markdown 파일을 올려 주세요.'

/** 원본이 글이냐 소리냐 — **기계가 읽는 값**. 표시용 한국어는 아래 `meetingSourceKind`가 만든다. */
export type MeetingSourceKind = 'transcript' | 'recording' | ''

/**
 * 지금 설정으로 이 회의를 정리할 수 **없다면** 그 이유 한 문장, 정리할 수 있으면 빈 문자열.
 *
 * 이것이 있어야 하는 이유: 「AI로 정리」는 자료 수준이 「보관만」이면 409를 받고 화면은 그 자리에서
 * **개인정보 동의**를 묻는다. 그런데 전사 연결이 없으면 동의를 받아 낸 뒤에도 503으로 끝나고,
 * 올렸던 수준마저 통째로 되돌아간다(부록 C-4) — **되지 않을 일에 동의를 받지 않는다.**
 *
 * 모르면(`status === null`) 막지 않는다. 막는 것은 서버이고 화면은 아는 것만 말한다(규칙 1).
 * 전사 원문이 이미 있으면 어댑터를 부르지 않으므로(라우트 8은 `transcriptText`가 비었을 때만
 * 전사한다) 벤더가 없어도 다시 요약할 수 있다 — 그 갈래도 막지 않는다.
 */
export function meetingProcessBlockedNote(
  status: TranscriptionStatus | null,
  kind: MeetingSourceKind,
  hasTranscript: boolean,
): string {
  if (!status || hasTranscript) return ''
  if (kind === 'transcript') return status.acceptsTranscript ? '' : TRANSCRIPTION_NOT_CONFIGURED_MESSAGE
  if (kind === 'recording') {
    if (status.acceptsAudio) return ''
    // 글은 읽는 어댑터에게 소리를 준 것과, 아무것도 읽지 못하는 것은 다른 사실이다(규칙 11).
    return status.acceptsTranscript ? MEETING_SOURCE_UNSUPPORTED_MESSAGE : TRANSCRIPTION_NOT_CONFIGURED_MESSAGE
  }
  return ''
}

/**
 * 회의를 막 만든 뒤의 토스트. **다음에 무엇을 누르라고 말하기 전에 그것이 되는지 먼저 본다** —
 * 되지 않는 설정에서 「「AI로 정리」를 누르면 요약과 할 일을 뽑습니다」는 같은 화면 위쪽의
 * 안내와 정면으로 어긋난다(규칙 3·11).
 */
export function meetingCreatedToast(status: TranscriptionStatus | null, kind: MeetingSourceKind): string {
  const blocked = meetingProcessBlockedNote(status, kind, false)
  return blocked
    ? `회의를 만들었습니다. ${blocked}`
    : '회의를 만들었습니다. 「AI로 정리」를 누르면 요약과 할 일을 뽑습니다.'
}

/**
 * 녹음 버튼 옆에 붙는 한 문장. 눌러도 되는 이유와, 눌러도 안 되는 것을 함께 말한다.
 * **원문 업로드가 실제로 되는 설정(`acceptsTranscript`)에서만** 그 길을 지목한다.
 */
export const RECORDING_WITHOUT_VENDOR_NOTE = '녹음 파일은 자료실에 보관되지만, 음성 전사 연결이 없어 지금은 글로 옮기지 못합니다. 요약이 필요하면 회의록 원문 파일을 올려 주세요.'

/**
 * 전사 연결이 **아무것도** 없을 때(`TRANSCRIPTION_PROVIDER=none`, 오늘의 기본값).
 *
 * 이 갈래에서 「원문 파일을 올려 주세요」는 거짓이다 — 원문을 올려도 503으로 막힌다. 같은 화면
 * 위쪽의 `transcriptionNotice`가 이미 「원문 파일도 읽지 못합니다」라고 말하고 있으므로, 여기서
 * 반대를 말하면 한 화면이 한 사실을 두 문장으로 갈라 말하게 된다(규칙 3·11).
 */
export const RECORDING_WITHOUT_TRANSCRIPT_NOTE = '녹음 파일은 자료실에 보관되지만, 음성 전사 연결이 없어 지금은 글로 옮기지 못합니다. 회의록 원문 파일도 아직 읽지 못하므로, 관리자가 전사 연결을 켜기 전까지는 요약이 만들어지지 않습니다.'

/**
 * 전사 연결 상태를 **아직 읽지 못했을 때**. 목록 요청이 실패하면 정확히 이 상태가 된다.
 * 「연결이 없다」와 「모른다」는 다른 사실이므로 문장도 다르다(규칙 11) — 모르면서 없다고 쓰면
 * 벤더가 붙은 회사에서 거짓을 말하게 된다.
 */
export const RECORDING_UNKNOWN_VENDOR_NOTE = '음성 전사 연결 상태를 확인하지 못했습니다. 녹음 파일은 자료실에 보관되지만 글로 옮겨지지 않을 수 있습니다 — 요약이 필요하면 회의록 원문 파일을 올려 주세요.'

/**
 * 녹음을 시작하기 전에 보여 줄 한 문장. **모르는 쪽은 안전한 쪽으로 떨어진다** —
 * 상태를 못 읽었으면 확인을 건너뛰지 않고, 모른다고 말한 뒤 사람이 알고 누르게 한다.
 *
 * 갈래가 셋인 이유는 사실이 셋이기 때문이다(규칙 11): 모른다 · 소리는 못 읽지만 글은 읽는다 ·
 * 둘 다 못 읽는다. 셋째에서 「원문 파일을 올려 주세요」를 말하면 그 길은 503으로 막혀 있다.
 */
export function recordingConfirmNote(status: TranscriptionStatus | null): string {
  if (!status) return RECORDING_UNKNOWN_VENDOR_NOTE
  if (!status.acceptsTranscript) return RECORDING_WITHOUT_TRANSCRIPT_NOTE
  return RECORDING_WITHOUT_VENDOR_NOTE
}

export type MeetingDecision = { text: string; quote: string }
export type MeetingTask = { title: string; owner: string; due: string; quote: string }

export type MeetingSummary = {
  summary: string
  participants: string[]
  decisions: MeetingDecision[]
  tasks: MeetingTask[]
  insufficient: boolean
  mode: string
  notice: string
}

export type Meeting = {
  id: string
  title: string
  status: MeetingStatus
  error: string
  recordingDocumentId: string
  transcriptDocumentId: string
  transcriptChars: number
  transcriptTruncated: boolean
  transcriptUnreadChars: number
  hasTranscript: boolean
  documentId: string
  participantIds: string[]
  summary: MeetingSummary | null
  /**
   * 이 회의가 지금까지 승인 큐에 올린 제안의 **누적 이력**. 결재가 끝나도 줄지 않고 다시 정리하면
   * 늘기만 한다 — 그래서 화면의 현재형 문장은 이 배열의 길이를 세지 않는다(아래 `pendingProposals`).
   */
  proposalIds: string[]
  /** 지금 승인 큐에서 **실제로 기다리는** 제안 수. 서버가 제안 행을 세어 싣는다(규칙 13). */
  pendingProposals: number
  usage: Record<string, unknown>
  createdById: string
  createdByName: string
  createdAt: string
  updatedAt: string
}

export type DocumentAudience = {
  scope: string
  sourceVisibility: string
  widerThanSource: boolean
  message: string
}

export type MeetingDetail = {
  meeting: Meeting
  transcriptPreview: string
  /**
   * 미리보기의 **글자(코드포인트) 수**. 서버가 세어 싣는다 — 화면이 `String.length`로 다시 세면
   * 이모지 한 자가 둘로 세어져 「앞부분 4,000자 (전체 2,100자)」처럼 미리보기가 전체보다 길어진다
   * (규칙 13: 개수를 말하는 필드는 실제 개수와 같아야 한다).
   */
  transcriptPreviewChars: number
  transcriptHidden: boolean
  transcriptHiddenNote: string
  documentAudience: DocumentAudience | null
  /** 원본의 지금 AI 처리 수준과, **이 사람이** 더 올릴 수 있는가. 서버가 정하고 화면은 그린다. */
  aiLevel: AiLevelState | null
  transcription: TranscriptionStatus | null
}

export type AiLevelState = { current: string; mayRaise: boolean }

/**
 * 원본이 글이냐 소리냐. 오늘의 어댑터가 읽는 쪽(원문)이 먼저다 — 서버의 `sourceOf`와 같은 순서다.
 * 표시용 한국어와 판정용 값이 **한 술어**에서 나온다(둘로 나뉘면 어느 날 순서가 갈린다).
 */
export function sourceKindOf(meeting: Pick<Meeting, 'transcriptDocumentId' | 'recordingDocumentId'>): MeetingSourceKind {
  if (meeting.transcriptDocumentId) return 'transcript'
  if (meeting.recordingDocumentId) return 'recording'
  return ''
}

export function meetingSourceKind(meeting: Pick<Meeting, 'transcriptDocumentId' | 'recordingDocumentId'>) {
  const kind = sourceKindOf(meeting)
  if (kind === 'transcript') return '원문'
  if (kind === 'recording') return '녹음'
  return ''
}

export function meetingSourceId(meeting: Pick<Meeting, 'transcriptDocumentId' | 'recordingDocumentId'>) {
  return meeting.transcriptDocumentId || meeting.recordingDocumentId || ''
}

/**
 * 끝난 회의가 실제로 내놓은 것. **세는 것과 말하는 것이 같아야 한다**(규칙 13).
 *
 * 마지막 칸은 「지금 승인 큐에서 기다리는 수」이고, 그 수는 서버가 제안 행을 세어 준
 * `pendingProposals`에서 온다. 누적 이력(`proposalIds`)의 길이를 세면 결재가 끝난 뒤에도
 * 그 수가 남고, 다시 정리할 때마다 늘어 화면이 실제와 벌어진다. 할 일 후보(`summary.tasks`)도
 * 대신 세지 않는다 — AI 처리 수준이 「정리」면 할 일은 뽑히고 제안은 0건이다.
 */
export function meetingOutcomeLine(meeting: Meeting): string {
  if (!meeting.summary) return ''
  const parts = [
    `결정 ${meeting.summary.decisions.length}`,
    `할 일 ${meeting.summary.tasks.length}`,
    `승인 대기 ${Number(meeting.pendingProposals ?? 0)}`,
  ]
  return parts.join(' · ')
}

/**
 * 승인 큐에서 기다리는 이 회의의 업무 제안 이야기. **누구에게 말하느냐로 갈린다.**
 *
 * `GET /api/proposals`는 `requireTenantAdmin`이고 승인 큐 화면은 비관리자에게 AI 제안 패널을
 * 통째로 감춘다. 그런데 회의록은 직원이 주 사용자다 — 직원에게 「승인 큐 열기」를 그려 주면
 * 그 버튼은 아무것도 보여 주지 못하는 곳으로 보낸다(규칙 11: 누를 곳 없는 해결책을 말하지 않는다).
 * 수는 누적 이력이 아니라 서버가 센 대기 수에서 온다(규칙 13).
 */
export function meetingPendingProposalNote(pending: number, isAdmin: boolean): string {
  const count = Number(pending ?? 0)
  if (!count) return '승인 큐에서 기다리는 업무 제안이 없습니다.'
  if (isAdmin) return `승인 큐에서 업무 제안 ${count}건이 결재를 기다리고 있습니다.`
  return `업무 제안 ${count}건이 승인 큐에서 회사 관리자의 확인을 기다리고 있습니다. 승인되면 업무로 실행됩니다.`
}

/**
 * 처리 직후의 토스트에서 「제안을 올렸다」를 말하는 한 문장. 위 `meetingPendingProposalNote`와
 * 같은 갈래로 나뉜다 — 두 자리가 갈리면 상세는 「관리자가 확인한다」인데 토스트는
 * 「승인 큐에 올렸습니다」가 되어 직원이 큐를 열어 보고 빈 화면을 만난다(규칙 3).
 */
export function meetingQueuedToast(queued: number, skipped: number, isAdmin: boolean): string {
  const made = Number(queued ?? 0)
  const kept = Number(skipped ?? 0)
  const head = isAdmin
    ? `업무 제안 ${made}건을 승인 큐에 올렸습니다.`
    : `업무 제안 ${made}건을 올렸습니다. 회사 관리자가 승인 큐에서 확인한 뒤 실행됩니다.`
  return kept ? `${head} 이미 올라간 ${kept}건은 그대로 뒀습니다.` : head
}

/**
 * 「정리」에 멈춘 회의를 「활용」으로 올리는 버튼의 라벨. **문장이 지목하는 글자와 버튼에 찍히는
 * 글자가 같아야 한다**(규칙 11) — 그래서 두 자리가 이 상수 하나를 쓴다. 낫표는 라벨 안에 넣지
 * 않는다: 문장이 라벨을 「」로 감싸므로 안에도 두면 겹낫표가 되어 읽기 어렵다.
 */
export const MEETING_ACTIVE_UPGRADE_LABEL = `${AI_LEVEL_LABEL.active}으로 올려 다시 정리`

/**
 * AI 처리 수준이 「정리」라 업무 제안이 만들어지지 않았다는 사실 한 문장.
 *
 * **막힌 이유만 말하고 끝내지 않는다** — 서버는 `POST /api/meetings/:id/process { aiPolicy:'active' }`를
 * 받아 제안을 만들 준비가 되어 있다. 그런데 동의 대화상자는 409에서만 열리고, 한 번 「정리」를
 * 고르면 자료 수준이 locked를 벗어나 409가 다시 오지 않는다. 그래서 화면은 409 갈래 **밖에도**
 * 올라갈 길을 두고 이 문장이 그곳을 지목한다(규칙 11).
 *
 * 올릴 수 없는 사람(원본을 올린 사람도 관리자도 아닌 참석자)에게는 버튼을 지목하지 않는다 —
 * 그 사람이 눌러 봐야 403이다.
 */
export function meetingAiLevelNote(mayRaise: boolean): string {
  const head = `AI 처리 수준이 「${AI_LEVEL_LABEL.indexed}」 단계라 업무 제안은 올리지 않습니다.`
  return mayRaise
    ? `${head} 「${MEETING_ACTIVE_UPGRADE_LABEL}」를 누르면 수준을 올려 제안까지 만듭니다.`
    : `${head} 원본을 올린 사람이나 회사 관리자가 「${AI_LEVEL_LABEL.active}」으로 올려야 제안이 만들어집니다.`
}

/**
 * 처리 직후의 토스트에서 같은 사실을 말하는 문장. 토스트는 사라지므로 **누를 곳이 남아 있는
 * 자리**(회의 상세)를 지목한다. 위 `meetingAiLevelNote`와 같은 갈래로 나뉜다(규칙 3).
 */
export function meetingAiLevelSkippedToast(mayRaise: boolean): string {
  const head = `AI 처리 수준이 「${AI_LEVEL_LABEL.indexed}」 단계라 업무 제안은 올리지 않았습니다.`
  return mayRaise
    ? `${head} 회의 상세에서 「${MEETING_ACTIVE_UPGRADE_LABEL}」를 누르면 제안까지 만듭니다.`
    : `${head} 원본을 올린 사람이나 회사 관리자가 「${AI_LEVEL_LABEL.active}」으로 올려야 제안이 만들어집니다.`
}

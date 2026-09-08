import { MAX_DOCUMENT_BYTES } from './documentAttachments.ts'

/**
 * 브라우저 녹음 — `MediaRecorder`와 `getUserMedia`를 부르는 **저장소 안 유일한 파일**.
 *
 * 왜 한 파일인가: 이 두 API는 브라우저·기기마다 되고 안 되는 것이 다르고, 실패도 조용하다.
 * 화면 여기저기에서 부르면 「이 브라우저에서 안 된다」·「마이크를 막았다」·「용량이 찼다」를
 * 서로 다른 문장으로 말하게 되고, 어느 화면이 무엇을 말하는지 아무도 세지 못한다.
 * (`scripts/meeting-ui-contract.test.mjs`가 저장소 전체를 훑어 이 파일 하나만 남았는지 잰다.)
 */

/** 컴포넌트가 recorder 객체를 들고 있을 때 쓰는 이름. 이 파일 밖에서 원래 이름을 적지 않는다. */
export type Recorder = MediaRecorder
export type MicrophoneStream = MediaStream

/**
 * 먼저 되는 것을 쓴다. 크롬·엣지는 첫째, 사파리는 셋째만 된다 —
 * 하나만 적어 두면 사파리에서 녹음 버튼이 눌리지도 않는다.
 */
export const RECORDER_MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'] as const

/**
 * 한 번에 녹음할 수 있는 바이트. **자료실 업로드 상한에서 나온다** — 상한을 넘긴 녹음은
 * 통째로 거절당하고, 사람이 그 사실을 아는 때는 녹음이 끝난 뒤다.
 * 여유 1MB는 마지막 조각과 컨테이너 헤더 몫이다(opus 32kbps로 대략 39분).
 */
export const MAX_RECORDING_BYTES = MAX_DOCUMENT_BYTES - 1024 * 1024

/** 이 비율을 넘으면 화면이 「곧 멈춘다」고 미리 말한다. 말없이 멈추면 사람은 고장으로 읽는다. */
export const RECORDING_WARN_RATIO = 0.9

/** 녹음 조각을 받는 주기(ms). 이 주기가 곧 「용량이 찼다」를 알아채는 주기다. */
export const RECORDER_TIMESLICE_MS = 1_000

export const RECORDER_UNSUPPORTED_MESSAGE = '이 브라우저는 녹음을 지원하지 않습니다. 회의 파일을 올려 주세요.'
export const MICROPHONE_DENIED_MESSAGE = '마이크 권한이 필요합니다. 주소창의 자물쇠 아이콘에서 마이크를 허용해 주세요.'
/**
 * 브라우저 권한 대화상자가 떠 있는 동안 화면이 하는 말. **아직 아무것도 녹음되지 않았다**는
 * 사실을 그 자리에서 말한다 — 승인을 기다리는 시간에 빨간 점과 경과 시간을 그리면
 * 그것은 가짜 진행 표시이고, 그때 「그만」을 눌러도 멈출 녹음이 아직 없다.
 */
export const MICROPHONE_WAITING_MESSAGE = '마이크 승인을 기다리는 중입니다. 브라우저가 묻는 창에서 허용을 눌러 주세요 — 아직 녹음은 시작되지 않았습니다.'
export const MICROPHONE_MISSING_MESSAGE = '마이크를 찾지 못했습니다. 입력 장치를 연결한 뒤 다시 시도해 주세요.'
export const RECORDING_NEAR_LIMIT_MESSAGE = '용량이 거의 찼습니다 — 곧 자동으로 멈춥니다.'
export const RECORDING_AUTO_STOPPED_MESSAGE = '용량 상한에 닿아 녹음을 자동으로 멈췄습니다. 여기까지 녹음한 소리는 그대로 저장됩니다.'

/**
 * 이 브라우저가 실제로 만들 수 있는 형식. 하나도 없으면 빈 문자열이고, 그때 화면은
 * 녹음 버튼을 **그리지 않는다** — 눌러야 안 된다는 것을 아는 버튼은 버튼이 아니다.
 * `isSupported`를 주입받는 이유는 이 판정을 브라우저 없이도 재어 보기 위해서다.
 */
export function pickRecorderMime(
  isSupported: (type: string) => boolean = (type) => (
    typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function'
      ? MediaRecorder.isTypeSupported(type)
      : false
  ),
): string {
  return RECORDER_MIME_CANDIDATES.find((type) => {
    try { return isSupported(type) } catch { return false }
  }) ?? ''
}

export function createRecorder(stream: MicrophoneStream, mimeType: string): Recorder {
  return new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
}

export async function requestMicrophone(): Promise<MicrophoneStream> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error(RECORDER_UNSUPPORTED_MESSAGE)
  }
  return navigator.mediaDevices.getUserMedia({ audio: true })
}

/** 마이크 표시등을 끈다. 트랙을 놓지 않으면 녹음이 끝난 뒤에도 브라우저가 계속 듣고 있다. */
export function stopStream(stream: MicrophoneStream | null) {
  if (!stream) return
  for (const track of stream.getTracks()) {
    try { track.stop() } catch { /* 이미 끝난 트랙 */ }
  }
}

/** 브라우저가 던진 것을 사람이 읽는 한 문장으로. 이름이 아니라 **푸는 길**을 말한다. */
export function microphoneErrorMessage(error: unknown): string {
  const name = error && typeof error === 'object' && 'name' in error ? String((error as { name?: unknown }).name) : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return MICROPHONE_DENIED_MESSAGE
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return MICROPHONE_MISSING_MESSAGE
  if (error instanceof Error && error.message) return error.message
  return '마이크를 열지 못했습니다. 잠시 뒤 다시 시도해 주세요.'
}

export type RecordingSession = {
  mimeType: string
  /** 사람이 「그만」을 눌렀을 때. 자동 정지와 같은 문을 지난다. */
  stop: () => void
}

/**
 * 녹음 한 번. 조각이 올 때마다 누적 바이트를 세고, **상한에 닿으면 스스로 멈춘다** —
 * 상한을 넘긴 파일은 업로드에서 통째로 거절당하므로, 넘기게 두는 것은 그때까지의 녹음을
 * 버리는 것과 같다. 멈춘 뒤에는 `onFinish`가 그 사실(`autoStopped`)을 함께 말한다.
 */
export function startRecordingSession({
  stream, mimeType, onProgress, onFinish, onError,
}: {
  stream: MicrophoneStream
  mimeType: string
  onProgress: (bytes: number) => void
  onFinish: (result: { blob: Blob; bytes: number; autoStopped: boolean }) => void
  onError: (message: string) => void
}): RecordingSession {
  const chunks: Blob[] = []
  let bytes = 0
  let autoStopped = false
  const recorder = createRecorder(stream, mimeType)

  const halt = () => {
    // 이미 멈춘 recorder에 stop()을 부르면 InvalidStateError가 난다 — 두 문(사람·자동)이
    // 같은 자리로 모이므로 상태를 여기서 한 번만 본다.
    if (recorder.state === 'inactive') return
    try { recorder.stop() } catch { /* 이미 멈췄다 */ }
  }

  recorder.ondataavailable = (event) => {
    const chunk = event.data
    if (!chunk || !chunk.size) return
    chunks.push(chunk)
    bytes += chunk.size
    onProgress(bytes)
    // 자동 정지 분기: 상한에 닿으면 여기서 멈춘다.
    if (bytes >= MAX_RECORDING_BYTES && !autoStopped) {
      autoStopped = true
      halt()
    }
  }
  recorder.onerror = () => { onError('녹음 중 문제가 생겼습니다. 다시 시도해 주세요.') }
  recorder.onstop = () => { onFinish({ blob: new Blob(chunks, { type: mimeType || 'audio/webm' }), bytes, autoStopped }) }
  recorder.start(RECORDER_TIMESLICE_MS)

  return { mimeType, stop: halt }
}

/** 녹음 파일 이름. 확장자는 형식에서 나온다 — 자료실이 이름으로 형식을 다시 읽기 때문이다. */
export function recordingFileName(startedAt: Date, mimeType: string) {
  const stamp = [
    startedAt.getFullYear(),
    String(startedAt.getMonth() + 1).padStart(2, '0'),
    String(startedAt.getDate()).padStart(2, '0'),
    '-',
    String(startedAt.getHours()).padStart(2, '0'),
    String(startedAt.getMinutes()).padStart(2, '0'),
  ].join('')
  const extension = mimeType.includes('mp4') ? 'm4a' : 'webm'
  return `회의녹음-${stamp}.${extension}`
}

/** 경과 시간 한 줄(mm:ss). 시간을 넘기면 h:mm:ss. */
export function formatElapsed(seconds: number) {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`
}

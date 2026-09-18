/**
 * 브라우저 받아쓰기 — `SpeechRecognition`을 부르는 **저장소 안 유일한 파일**.
 *
 * 왜 따로 두는가: 서버에 음성 전사 벤더(TRANSCRIPTION_PROVIDER=whisper)가 없는 회사에서도
 * 「녹음 → 글 → 회의록 문서 → 할 일 제안」이 끝까지 돌게 하려면, 녹음하는 **동안** 브라우저가
 * 말을 글자로 옮겨 두는 수밖에 없다. 녹음 파일은 그대로 자료실에 보관되고, 받아쓴 글은 자막
 * 원문(.vtt)으로 함께 올라가 서버의 text 규칙으로 읽힌다 — 서버에 새 길을 만들지 않는다.
 *
 * 되고 안 되는 곳: 크롬·엣지·삼성 인터넷·사파리(14.1+)는 된다. 파이어폭스는 안 된다.
 * 크롬·엣지는 소리를 **브라우저 제공사 서버**로 보내 글자로 바꾼다. 그래서 켜기 전에 그 사실을
 * 말하고(DICTATION_PRIVACY_NOTE) 사람이 고르게 한다. 조용히 켜지 않는다.
 *
 * 브라우저 인식은 말이 끊기거나 1분쯤 지나면 스스로 멈춘다. 녹음이 계속되는 동안에는 다시 켠다 —
 * 그러지 않으면 40분 회의의 첫 1분만 글이 된다.
 */

type RecognitionAlternative = { transcript: string; confidence: number }
type RecognitionResult = { isFinal: boolean; length: number; [index: number]: RecognitionAlternative }
type RecognitionResultList = { length: number; [index: number]: RecognitionResult }
type RecognitionEvent = { resultIndex: number; results: RecognitionResultList }
type RecognitionErrorEvent = { error: string }

type Recognition = {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  onresult: ((event: RecognitionEvent) => void) | null
  onerror: ((event: RecognitionErrorEvent) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

type RecognitionConstructor = new () => Recognition

/** 받아쓴 한 마디. 시각은 녹음 시작부터 잰 밀리초다 — 자막(.vtt)의 타임코드가 된다. */
export type DictationCue = { startMs: number; endMs: number; text: string }

export type DictationSession = {
  /** 받아쓰기를 멈추고 지금까지의 마디를 돌려준다. 여러 번 불러도 된다. */
  stop: () => DictationCue[]
  cues: () => DictationCue[]
}

export const DICTATION_LANG = 'ko-KR'

/**
 * 켜기 전에 사람이 읽는 문장. 소리가 어디로 가는지를 먼저 말한다(회의 음성은 개인정보다).
 * 녹음 파일 자체가 어디에 남는지도 함께 말해, 받아쓰기를 끄는 것이 녹음을 끄는 것이 아님을 알린다.
 */
export const DICTATION_PRIVACY_NOTE = '받아쓰기는 브라우저의 음성 인식을 씁니다. 크롬·엣지에서는 말소리가 구글·마이크로소프트 서버로 보내져 글자로 바뀝니다. 녹음 파일은 회사 자료실에만 저장됩니다.'
export const DICTATION_ON_LABEL = '말하는 동안 글자로 받아 적기'
export const DICTATION_BLOCKED_MESSAGE = '받아쓰기가 막혀 있습니다. 주소창의 자물쇠 아이콘에서 마이크를 허용해 주세요. 녹음은 계속됩니다.'
export const DICTATION_NETWORK_MESSAGE = '받아쓰기 연결이 끊겼습니다. 녹음은 계속되고, 연결되면 다시 받아 적습니다.'

function recognitionConstructor(): RecognitionConstructor | null {
  if (typeof window === 'undefined') return null
  const scope = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor }
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null
}

/** 이 브라우저가 받아쓸 수 있는가. 없으면 화면은 받아쓰기 선택지를 **그리지 않는다**. */
export function dictationSupported(): boolean {
  return recognitionConstructor() !== null
}

/**
 * 받아쓰기를 시작한다. `startedAt`은 녹음 세션이 실제로 시작된 시각이다 — 자막 타임코드가
 * 녹음 파일의 같은 자리를 가리키게 한다.
 */
export function startDictation({ startedAt, lang = DICTATION_LANG, onUpdate, onNotice }: {
  startedAt: Date
  lang?: string
  /** 확정된 마디 수와 지금 듣고 있는(아직 확정 전) 글. 화면의 실시간 자막이 읽는다. */
  onUpdate?: (state: { cues: number; lastFinal: string; interim: string }) => void
  /** 사람이 알아야 하는 일(권한 거절·연결 끊김). 녹음은 멈추지 않는다. */
  onNotice?: (message: string) => void
}): DictationSession | null {
  const Constructor = recognitionConstructor()
  if (!Constructor) return null
  const cues: DictationCue[] = []
  let active = true
  let blocked = false
  let segmentStartMs: number | null = null
  let lastFinal = ''
  let recognition: Recognition | null = null
  const offset = () => Math.max(0, Date.now() - startedAt.getTime())

  const launch = () => {
    if (!active || blocked) return
    const next = new Constructor()
    next.lang = lang
    next.continuous = true
    next.interimResults = true
    next.maxAlternatives = 1
    next.onresult = (event) => {
      let interim = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        const text = String(result?.[0]?.transcript ?? '').trim()
        if (!text) continue
        if (segmentStartMs === null) segmentStartMs = offset()
        if (result.isFinal) {
          const endMs = offset()
          cues.push({ startMs: segmentStartMs, endMs: Math.max(endMs, segmentStartMs + 500), text })
          lastFinal = text
          segmentStartMs = null
        } else {
          interim = `${interim} ${text}`.trim()
        }
      }
      onUpdate?.({ cues: cues.length, lastFinal, interim })
    }
    next.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        blocked = true
        onNotice?.(DICTATION_BLOCKED_MESSAGE)
      } else if (event.error === 'network') {
        onNotice?.(DICTATION_NETWORK_MESSAGE)
      }
      // no-speech·aborted는 사람이 알 일이 아니다 — onend에서 다시 켠다.
    }
    next.onend = () => {
      // 브라우저가 스스로 멈췄다. 녹음이 계속되는 동안에는 다시 켠다.
      if (active && !blocked) window.setTimeout(launch, 250)
    }
    recognition = next
    try { next.start() } catch { /* 이미 시작된 인식 — onend가 다시 부른다 */ }
  }

  launch()

  return {
    cues: () => [...cues],
    stop: () => {
      active = false
      try { recognition?.stop() } catch { /* 이미 멈춘 인식 */ }
      return [...cues]
    },
  }
}

const pad = (value: number, size = 2) => String(value).padStart(size, '0')

/** 밀리초 → `00:01:02.345` (WebVTT 타임코드). */
export function vttTimestamp(ms: number): string {
  const total = Math.max(0, Math.round(ms))
  const hours = Math.floor(total / 3_600_000)
  const minutes = Math.floor((total % 3_600_000) / 60_000)
  const seconds = Math.floor((total % 60_000) / 1_000)
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(total % 1_000, 3)}`
}

/**
 * 받아쓴 마디를 WebVTT로. 서버는 이 파일을 자막 규칙(타임코드를 걷고 말만 남긴다)으로 읽고,
 * 사람은 자료실에서 이 파일을 열어 녹음의 몇 분 몇 초에 무슨 말이 있었는지 되짚는다.
 * 빈 마디는 싣지 않는다.
 */
export function cuesToVtt(cues: DictationCue[]): string {
  const lines = ['WEBVTT', '']
  for (const cue of cues) {
    const text = cue.text.replace(/\s+/g, ' ').trim()
    if (!text) continue
    // 자막 문법에서 '-->'는 타임코드 구분자다. 말 속에 있으면 자막 파서가 타임코드로 읽는다.
    lines.push(`${vttTimestamp(cue.startMs)} --> ${vttTimestamp(Math.max(cue.endMs, cue.startMs + 1))}`, text.replace(/-->/g, '→'), '')
  }
  return lines.join('\n')
}

/** 녹음 파일 이름에서 받아쓰기 파일 이름을 만든다. 둘이 자료실에 나란히 놓인다. */
export function dictationFileName(recordingName: string): string {
  const base = String(recordingName ?? '').replace(/\.[^.]+$/, '') || '회의 녹음'
  return `${base} 받아쓰기.vtt`
}

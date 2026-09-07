// 회의 음성 전사 어댑터 — 자리만 열어 둔다.
//
// 실제 음성 벤더는 아직 정해지지 않았다. 어느 벤더를, 어떤 요금으로, 회의 음성이 어느 나라에서
// 처리되는지(회의 음성은 개인정보다)는 사용자만 정할 수 있다. 그래서 오늘 출하하는 구현은 둘뿐이다.
//
//   none — 아무것도 전사하지 않는다. 부르면 "설정되지 않았다"고 분명히 답한다.
//   text — 사람이 올린 회의록 원문(.txt·.vtt·.srt·.md)에서 말만 남긴다.
//
// 비어 있는 자리를 되는 것처럼 보이게 만들지 않는다. 가짜 전사 결과를 지어내지 않고,
// 키가 없으면 그 사실을 그대로 답한다.

/** 오늘 출하하는 구현. 이 목록에 없는 값은 부팅에서 드러난다(조용히 none으로 떨어뜨리지 않는다). */
export const TRANSCRIPTION_PROVIDERS = Object.freeze(['none', 'text'])

// 회의록 원문으로 읽을 수 있는 파일 형식. 두 갈래를 나눠 두는 것이 이 모듈의 핵심이다 —
// 큐(자막) 파일에만 헤더·큐 번호·타임코드를 걷어내는 규칙을 걸고, 평문·마크다운에는 걸지 않는다.
// 그 규칙을 평문에 걸면 사람이 쓴 회의록에서 NOTE·STYLE·REGION 으로 시작하는 문단과
// 안건표의 시간 구간이 조용히 사라진다(= 사용자가 올린 회의 내용을 지운다).
const CUE_MIME_TYPES = Object.freeze(new Set(['text/vtt', 'application/x-subrip']))
const PLAIN_MIME_TYPES = Object.freeze(new Set(['text/plain', 'text/markdown']))
const CUE_EXTENSIONS = Object.freeze(new Set(['.vtt', '.srt']))
const PLAIN_EXTENSIONS = Object.freeze(new Set(['.txt', '.md', '.markdown']))

/** 회의록 원문으로 읽을 수 있는 파일 형식. */
export const TRANSCRIPT_MIME_TYPES = Object.freeze(new Set([...PLAIN_MIME_TYPES, ...CUE_MIME_TYPES]))
/** 같은 목록의 확장자 쪽. 윈도우는 .vtt·.srt·.md에 MIME을 등록해 두지 않아 이쪽이 유일한 단서일 때가 있다. */
export const TRANSCRIPT_EXTENSIONS = Object.freeze(new Set([...PLAIN_EXTENSIONS, ...CUE_EXTENSIONS]))

/** 한 회의에서 받아 두는 전사 원문의 상한. 코드유닛이 아니라 사람이 세는 글자 수다. */
export const MAX_TRANSCRIPT_CHARS = 200_000

export class TranscriptionError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'TranscriptionError'
    this.code = code
    this.status = status
  }
}

/** MIME 파라미터(`; charset=utf-8`)를 떼고 소문자로 맞춘 형식 이름. */
function mimeName(mime) {
  return String(mime ?? '').split(';')[0].trim().toLowerCase()
}

/** 경로를 떼고 소문자로 맞춘 확장자(`.vtt`). 확장자가 없으면 빈 문자열. */
function extensionName(filename) {
  const base = String(filename ?? '').trim().toLowerCase().split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot) : ''
}

/**
 * 올린 파일을 어떤 형식으로 읽을지 정한다 — `'cue'`(자막) · `'plain'`(평문·마크다운), 못 읽으면 `null`.
 * 이 판단은 여기 한 곳에만 있다.
 *
 * MIME은 **거부권**이다. 형식을 분명히 말하는데 그 형식이 회의록 원문이 아니면(`audio/webm`·`application/pdf`)
 * 파일 이름이 `.txt`여도 읽지 않는다 — 바이너리를 글자로 옮겨 놓고 그것을 전사 결과라고 부르지 않는다.
 * MIME이 회의록 원문이라고 말한 뒤에는 확장자가 갈래를 정한다: 브라우저는 `.vtt`·`.srt`를 `text/plain`으로
 * 보내기도 하고, 이 사용자의 윈도우는 `.vtt`·`.srt`·`.md`에 Content Type을 등록해 두지 않아
 * 빈 문자열이나 `application/octet-stream`으로 보낸다.
 * 본문을 들여다보지는 않는다 — 첫 줄이 `WEBVTT`라는 단어로 시작하는 평범한 회의록이 자막으로 읽히면
 * 그 문단이 통째로 사라진다.
 */
export function transcriptFormatOf({ mime, filename } = {}) {
  const name = mimeName(mime)
  // `application/octet-stream`은 "모른다"는 말이지 형식을 말한 것이 아니다.
  if (name && name !== 'application/octet-stream' && !TRANSCRIPT_MIME_TYPES.has(name)) return null
  const extension = extensionName(filename)
  if (CUE_EXTENSIONS.has(extension)) return 'cue'
  if (PLAIN_EXTENSIONS.has(extension)) return 'plain'
  if (CUE_MIME_TYPES.has(name)) return 'cue'
  if (PLAIN_MIME_TYPES.has(name)) return 'plain'
  return null
}

/** 글자(코드포인트) 수를 센다. UTF-16 코드유닛이 아니라 사람이 세는 글자다. */
export function countCharacters(text) {
  const source = String(text ?? '')
  let count = 0
  for (let index = 0; index < source.length; index += source.codePointAt(index) > 0xffff ? 2 : 1) count += 1
  return count
}

/**
 * 글자 수 상한으로 자른다. 서로게이트 쌍을 반으로 가르지 않는다 —
 * 짝 없는 조각으로 끝나는 문자열은 well-formed UTF-16이 아니어서 UTF-8로 저장하는 순간
 * 마지막 글자가 U+FFFD가 되고 되돌아오지 않는다(저장본과 반환본이 달라진다).
 */
export function clipCharacters(text, limit) {
  const source = String(text ?? '')
  if (source.length <= limit) return source // 코드유닛 수가 상한 이하면 글자 수도 반드시 이하다
  let end = 0
  let count = 0
  while (end < source.length && count < limit) {
    end += source.codePointAt(end) > 0xffff ? 2 : 1
    count += 1
  }
  return source.slice(0, end)
}

/**
 * 올린 바이트를 UTF-8로 읽는다. UTF-8이 아니면 **읽지 않고 그 사실을 답한다** —
 * 관대한 디코더는 CP949·EUC-KR로 저장한 .srt(한국에서 흔하다. SubRip에는 인코딩 선언이 없다)를
 * 소리 없이 「?」로 채워 놓고 그것을 '전사 원문'이라고 부른다. 원문에 없던 글자를 회의 결과로 내놓지 않는다.
 */
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })
function decodeUtf8(bytes) {
  try {
    return utf8Decoder.decode(bytes)
  } catch {
    throw new TranscriptionError(
      'MEETING_SOURCE_NOT_UTF8',
      '이 파일은 UTF-8이 아닙니다. 메모장에서 「UTF-8」로 다시 저장해 올려 주세요.',
      400,
    )
  }
}

/**
 * 줄바꿈을 LF로 맞추고 보이지 않는 글자를 걷어낸다(줄바꿈·탭은 남긴다 — 그것도 사람이 쓴 모양이다).
 * 제어문자(Cc)와 함께 폭 없는 서식 문자(Cf: U+200B 폭 없는 공백·U+FEFF BOM·U+00AD soft hyphen…)도 건다.
 * 그러지 않으면 '읽을 글이 있는가'가 같은 자리에서 갈린다 — 공백·전각공백은 거부되는데
 * 폭 없는 공백만 든 파일은 전사 결과로 통과해, 요약 블록이 정직한 '찾지 못했습니다' 대신
 * 사람 눈에 빈 문단으로 나온다. 판정은 그대로 아래 `text.trim()` 한 곳에 남는다.
 */
function normalizeSource(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\p{Cc}\p{Cf}]/gu, (invisible) => (invisible === '\n' || invisible === '\t' ? invisible : ''))
}

const TIMECODE_LINE = /^\s*(?:\d{1,3}:)?\d{1,3}:\d{2}(?:[.,]\d{1,3})?\s*-->\s*(?:\d{1,3}:)?\d{1,3}:\d{2}(?:[.,]\d{1,3})?/
const BLOCK_HEADER_LINE = /^(?:NOTE|STYLE|REGION)\b/
/**
 * VTT 헤더 블록의 메타데이터(`Kind: captions`·`Language: ko`·`X-TIMESTAMP-MAP=LOCAL:…`).
 * ASCII 키만 헤더로 읽는다 — 한국어 화자 표시(`김지훈: 안녕하세요`)를 헤더로 오인해 지우지 않는다.
 */
const VTT_HEADER_META_LINE = /^[A-Za-z][A-Za-z0-9-]*\s*[:=]/

/**
 * 이 줄이 큐 식별자인가 — **자리**로 정한다: 비어 있지 않고, 자기 자신은 타임코드가 아니며,
 * 바로 다음 줄이 타임코드인 줄. 숫자로 정하면 Zoom의 `1`만 지우고 Teams의 GUID(`4f1c…/1-0`)와
 * Otter의 이름 식별자(`speaker-kim-2`)는 발언으로 남아 요약 첫머리에 찍힌다.
 * 큐 본문 안에서는 이 검사를 걸지 않는다(부르는 쪽이 `inCue`로 가른다) — 빈 줄 없이 다음 큐가
 * 이어지는 파일에서 마지막 발언 줄이 식별자로 오인돼 사라지지 않게.
 */
function isCueIdentifier(lines, index) {
  const trimmed = String(lines[index] ?? '').trim()
  if (!trimmed || TIMECODE_LINE.test(trimmed)) return false
  return TIMECODE_LINE.test(String(lines[index + 1] ?? '').trim())
}

/** 이 줄에서 새 큐가 시작되는가 — 타임코드 줄이거나 큐 식별자 줄. */
function startsCue(lines, index) {
  return TIMECODE_LINE.test(String(lines[index] ?? '').trim()) || isCueIdentifier(lines, index)
}

/**
 * 사람이 쓴 평문·마크다운 회의록. 줄바꿈과 제어문자만 다듬고 글은 그대로 옮긴다.
 * 여기서는 아무 줄도 지우지 않는다 — 지울 규칙이 있는 쪽은 자막 파일뿐이다.
 */
export function transcriptFromPlainText(text) {
  return normalizeSource(text).trim()
}

/**
 * WEBVTT·SRT의 헤더·큐 번호·타임코드를 걷어내고 말만 남긴다.
 * 지어내지 않고 있는 글자만 옮긴다 — 지우기만 하고 새로 쓰지 않는다.
 * **자막 파일에만 쓴다**(`transcriptFormatOf`가 `'cue'`라고 답한 파일). 평문에는 `transcriptFromPlainText`.
 * (줄마다 trim으로 재는데, trim은 BOM도 공백으로 보고 걷어낸다.)
 */
export function transcriptFromCues(text) {
  const lines = normalizeSource(text).split('\n')
  const kept = []
  let index = 0

  // VTT 헤더 블록은 첫 줄(`WEBVTT …`)과 뒤따르는 `Kind: captions` 꼴 메타데이터까지다.
  // '첫 빈 줄까지'로 먹으면 헤더 뒤에 빈 줄이 없는 파일이 글 전체를 잃고, 그러고도
  // '올린 파일에서 읽을 글이 없습니다'라는 사실과 다른 말을 사람에게 하게 된다.
  while (index < lines.length && !lines[index].trim()) index += 1
  if (index < lines.length && /^WEBVTT\b/.test(lines[index].trim())) {
    index += 1
    while (index < lines.length && VTT_HEADER_META_LINE.test(lines[index].trim())) index += 1
  }

  // 지금 큐 본문(발언) 안인가. 자막의 규칙은 큐 **밖**에만 건다 —
  // 발언이 NOTE·STYLE·REGION으로 시작한다는 이유로 사람이 말한 줄을 지우지 않는다.
  // (.srt에는 그 세 낱말이 규격에 아예 없어 자막 본문은 무조건 발언이다.)
  let inCue = false
  for (; index < lines.length; index += 1) {
    const trimmed = lines[index].trim()
    if (!trimmed) {
      inCue = false // 빈 줄이 큐를 닫는다
      kept.push(lines[index])
      continue
    }
    if (TIMECODE_LINE.test(trimmed)) {
      inCue = true
      continue
    }
    if (!inCue) {
      // NOTE·STYLE·REGION 블록은 말이 아니라 파일의 주석·스타일이다. 다음 빈 줄까지가 한 블록이지만,
      // 빈 줄 없이 다음 큐가 시작되면 거기서 멈춘다 — 규격을 어긴 파일이 발언을 잃지 않게.
      if (BLOCK_HEADER_LINE.test(trimmed)) {
        const blockStart = index
        index += 1
        while (index < lines.length && lines[index].trim() && !startsCue(lines, index)) index += 1
        if (index < lines.length) {
          if (startsCue(lines, index)) index -= 1 // 이 줄은 큐다. for가 다시 보게 되돌린다
          continue
        }
        // 빈 줄도 큐도 만나지 못하고 파일 끝에 닿았다 — 종결자 없는 블록은 블록이 아니다.
        // 여기서 되돌리지 않으면 타임코드가 하나도 없는 자막 파일에서 회의 내용이 파일 끝까지
        // 통째로 사라지고, 그러고도 transcribe는 오류도 알림도 없이 성공을 돌려준다.
        index = blockStart
      }
      if (isCueIdentifier(lines, index)) continue
    }
    kept.push(lines[index])
  }

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 전사 어댑터를 만든다.
 * `fetchImpl`은 실제 음성 벤더가 정해졌을 때 쓸 주입 자리다 — 오늘의 두 구현은 네트워크를 부르지 않는다.
 */
export function createTranscription({ env = process.env, fetchImpl = fetch } = {}) {
  const name = String(env.TRANSCRIPTION_PROVIDER ?? 'none').trim() || 'none'

  if (!TRANSCRIPTION_PROVIDERS.includes(name)) {
    // 실제 음성 벤더 자리(구현하지 않는다):
    //   if (name === 'whisper') return httpTranscription({ endpoint: env.TRANSCRIPTION_ENDPOINT,
    //     apiKey: env.TRANSCRIPTION_API_KEY, model: env.TRANSCRIPTION_MODEL, fetchImpl })
    // (그래서 `fetchImpl`은 오늘 아무도 부르지 않는다. 벤더가 정해지면 위 자리에서 쓴다.)
    // 알 수 없는 값을 조용히 none으로 떨어뜨리지 않는다 — 설정 실수는 부팅에서 드러나야 한다.
    throw new TranscriptionError(
      'TRANSCRIPTION_PROVIDER_UNKNOWN',
      `아직 구현되지 않은 TRANSCRIPTION_PROVIDER 값입니다: ${name}. 지금 쓸 수 있는 값은 ${TRANSCRIPTION_PROVIDERS.join(' · ')} 입니다.`,
      500,
    )
  }

  if (name === 'none') {
    return {
      name: 'none',
      acceptsAudio: false,
      acceptsTranscript: false,
      mimeTypes: [],
      extensions: [],
      accepts: () => false,
      async transcribe() {
        // 문구는 **이 갈래에서 참인 것만** 말한다. none은 원문 업로드도 받지 않으므로(accepts가 언제나 false)
        // '원문을 올리면 됩니다'는 이 자리에서 거짓이다 — 그 일이 실제로 되는 설정 이름을 대신 알려 준다.
        throw new TranscriptionError(
          'TRANSCRIPTION_NOT_CONFIGURED',
          '음성 전사 연결이 아직 설정되지 않았습니다. 관리자가 TRANSCRIPTION_PROVIDER를 text로 켜면 회의록 원문(.txt·.vtt·.srt)을 올려 요약과 업무 추출까지 할 수 있습니다.',
          503,
        )
      },
    }
  }

  return {
    name: 'text',
    acceptsAudio: false,
    acceptsTranscript: true,
    mimeTypes: [...TRANSCRIPT_MIME_TYPES],
    extensions: [...TRANSCRIPT_EXTENSIONS],
    accepts: (mime, filename) => transcriptFormatOf({ mime, filename }) !== null,
    async transcribe({ body, mime, filename } = {}) {
      const format = transcriptFormatOf({ mime, filename })
      if (!format) {
        throw new TranscriptionError(
          'MEETING_SOURCE_UNSUPPORTED',
          '이 형식은 회의록 원문으로 읽을 수 없습니다. TXT·VTT·SRT·Markdown 파일을 올려 주세요.',
          415,
        )
      }
      // 이 어댑터의 계약은 "어떤 입력에도 TranscriptionError로 답한다"이다. 문자열도 바이트도 아닌 값을
      // Buffer.from에 그대로 넘기면 status 없는 TypeError가 나가 라우트가 500으로 흘리고,
      // 배열은 던지지도 않고 원문에 없던 NUL 한 글자를 '전사 결과'로 돌려준다 — 가짜 결과를 지어내지 않는다.
      const isBytes = Buffer.isBuffer(body) || body instanceof Uint8Array
      if (typeof body !== 'string' && !isBytes) {
        throw new TranscriptionError(
          'MEETING_SOURCE_UNREADABLE',
          '올린 파일의 내용을 읽지 못했습니다. 회의록 원문 파일을 다시 올려 주세요.',
          400,
        )
      }
      const raw = typeof body === 'string' ? body : decodeUtf8(body)
      const parsed = format === 'cue' ? transcriptFromCues(raw) : transcriptFromPlainText(raw)
      // toWellFormed는 짝 없는 서로게이트만 U+FFFD로 바꾼다. 문자열 body로 들어온 그 조각을 그대로 두면
      // 반환본과 UTF-8 저장본이 달라져 아래 bytes가 거짓말이 된다(바이트 body는 위에서 이미 걸러진다).
      const text = clipCharacters(parsed, MAX_TRANSCRIPT_CHARS).toWellFormed()
      if (!text.trim()) {
        throw new TranscriptionError('MEETING_TRANSCRIPT_EMPTY', '올린 파일에서 읽을 글이 없습니다.', 400)
      }
      // characters는 사람이 세는 글자 수, bytes는 저장 크기다. 어느 척도인지 이름이 말하게 둔다.
      return {
        text,
        durationMs: 0,
        provider: 'text',
        model: 'transcript-upload',
        format,
        characters: countCharacters(text),
        bytes: Buffer.byteLength(text, 'utf8'),
      }
    },
  }
}

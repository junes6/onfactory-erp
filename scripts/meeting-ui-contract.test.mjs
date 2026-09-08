import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'

import { AI_LEVEL_LABELS, AI_LEVELS } from '../server/ai-policy.mjs'
import {
  DEFAULT_LIST_LIMIT as SERVER_DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT as SERVER_MAX_LIST_LIMIT,
  MAX_PARTICIPANTS as SERVER_MAX_PARTICIPANTS,
  MAX_TRANSCRIPT_STORED as SERVER_MAX_TRANSCRIPT_STORED,
  MEETING_STATUSES,
} from '../server/meeting-notes.mjs'
import { TRANSCRIPT_EXTENSIONS as SERVER_TRANSCRIPT_EXTENSIONS } from '../server/transcription.mjs'
import { MAX_DOCUMENT_BYTES } from '../src/utils/documentAttachments.ts'
import { MAX_RECORDING_BYTES, RECORDER_MIME_CANDIDATES, pickRecorderMime } from '../src/utils/mediaRecorder.ts'
import {
  AI_LEVEL_LABEL,
  MAX_TRANSCRIPT_STORED,
  MEETING_AI_LOCKED_MESSAGE,
  MEETING_DOCUMENT_AUDIENCE_MESSAGE,
  MEETING_LIST_PAGE_SIZE,
  MEETING_STATUS_LABEL,
  RECORDING_UNKNOWN_VENDOR_NOTE,
  RECORDING_WITHOUT_VENDOR_NOTE,
  TRANSCRIPT_EXTENSIONS,
  isTranscriptFileName,
  meetingOutcomeLine,
  recordingConfirmNote,
  transcriptionNotice,
} from '../src/utils/meetingNotes.ts'

/**
 * 회의록 화면 계약.
 *
 * 여기서 잠그는 것은 「예쁘게 그렸는가」가 아니라 **이 절이 실제로 다칠 자리들**이다:
 * 되지 않는 일을 되는 것처럼 그리는 것 · 브라우저 API가 화면 여기저기로 새는 것 ·
 * 상한을 넘긴 녹음이 통째로 버려지는 것 · 관리자 전용 문서 PATCH로 AI 수준을 올리려는 것 ·
 * 한글 입력이 끊기는 onChange · 서버와 화면의 문장이 갈리는 것.
 */

const read = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')

const [meetingNotesTsx, meetingRecorderTsx, meetingNotesCss, meetingNotesUtil, mediaRecorderUtil, meetingNotesServer, transcriptionServer, app, registry] = await Promise.all([
  read('src/components/MeetingNotes.tsx'),
  read('src/components/MeetingRecorder.tsx'),
  read('src/components/MeetingNotes.css'),
  read('src/utils/meetingNotes.ts'),
  read('src/utils/mediaRecorder.ts'),
  read('server/meeting-notes.mjs'),
  read('server/transcription.mjs'),
  read('src/App.tsx'),
  read('src/modules/registry.ts'),
])

const meetingScreen = `${meetingNotesTsx}\n${meetingRecorderTsx}`
const count = (source, pattern) => (source.match(pattern) ?? []).length

/**
 * 주석을 걷어낸 원문. 「이 화면은 무엇을 부르는가」를 재는 단언은 **도는 코드**만 봐야 한다 —
 * 주석에 적어 둔 라우트 이름(`/api/documents/:id`를 부르지 않는다고 설명하는 줄)까지 세면
 * 그 설명을 지우는 것만으로 단언이 통과 상태가 바뀐다.
 */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')

const meetingCode = stripComments(meetingScreen)

/**
 * `fetch(` 의 **첫 인자 원문**을 짝이 맞을 때까지 읽어 모은다. 표기가 아니라 목적지를 재기 위한
 * 것이다 — 문자열 이어붙이기(`'/api/documents/' + id`)도, 조각난 템플릿(`` `/api/${'documents'}/…` ``)도
 * 여기서는 「허용 목록에 없는 목적지」로 똑같이 걸린다.
 */
function fetchTargets(source) {
  const targets = []
  for (const match of source.matchAll(/\bfetch\(/g)) {
    let depth = 0
    let quote = ''
    let argument = ''
    for (let index = match.index + 'fetch'.length; index < source.length; index += 1) {
      const character = source[index]
      if (quote) {
        argument += character
        if (character === '\\') { argument += source[index + 1] ?? ''; index += 1 }
        else if (character === quote) quote = ''
        continue
      }
      if (character === '"' || character === "'" || character === '`') { quote = character; argument += character; continue }
      if (character === '(' || character === '[' || character === '{') {
        depth += 1
        if (depth > 1) argument += character
        continue
      }
      if (character === ')' || character === ']' || character === '}') {
        depth -= 1
        if (depth === 0) break
        argument += character
        continue
      }
      if (character === ',' && depth === 1) break
      if (depth >= 1) argument += character
    }
    targets.push(argument.trim())
  }
  return targets
}

/** `{` 로 열리는 JSX 속성 값 하나를 짝이 맞을 때까지 읽는다(문자열·중첩 중괄호를 넘긴다). */
function attributeBody(source, openIndex) {
  let depth = 0
  let quote = ''
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index]
    if (quote) {
      if (character === '\\') index += 1
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'" || character === '`') { quote = character; continue }
    if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return source.slice(openIndex, index + 1)
    }
  }
  return source.slice(openIndex)
}

test('MediaRecorder·getUserMedia는 src/utils/mediaRecorder.ts 한 파일에서만 나온다', async () => {
  const allowed = 'src/utils/mediaRecorder.ts'
  const offenders = []
  const walk = async (directory) => {
    for (const entry of await readdir(new URL(`../${directory}/`, import.meta.url), { withFileTypes: true })) {
      const next = `${directory}/${entry.name}`
      if (entry.isDirectory()) { await walk(next); continue }
      if (!next.endsWith('.ts') && !next.endsWith('.tsx')) continue
      if (next === allowed) continue
      if (/\bMediaRecorder\b|getUserMedia/.test(await read(next))) offenders.push(next)
    }
  }
  await walk('src')
  // 두 API는 브라우저·기기마다 되고 안 되는 것이 다르고 실패도 조용하다. 부르는 곳이 여럿이면
  // 「안 된다」를 서로 다른 문장으로 말하게 되고, 어느 화면이 무엇을 말하는지 아무도 세지 못한다.
  assert.deepEqual(offenders, [], '녹음 API는 한 파일에서만 부른다')
})

test('녹음 형식은 폴백 목록에서 고르고, 하나도 없으면 버튼을 그리지 않는다', () => {
  assert.ok(RECORDER_MIME_CANDIDATES.length >= 2, '브라우저마다 되는 형식이 다르므로 후보가 여럿이어야 한다')
  assert.equal(pickRecorderMime(() => false), '', '지원 형식이 없으면 빈 문자열이다')
  assert.equal(pickRecorderMime((type) => type === RECORDER_MIME_CANDIDATES.at(-1)), RECORDER_MIME_CANDIDATES.at(-1))
  assert.equal(pickRecorderMime(() => { throw new Error('isTypeSupported가 던진다') }), '', '판정이 던져도 화면이 죽지 않는다')
  // 빈 형식이면 버튼 자리에 이유가 온다 — 눌러야 안 된다는 것을 알게 되는 버튼은 버튼이 아니다.
  assert.match(meetingRecorderTsx, /if \(!mimeType\) \{[\s\S]{0,160}RECORDER_UNSUPPORTED_MESSAGE/)
  assert.match(mediaRecorderUtil, /RECORDER_UNSUPPORTED_MESSAGE = '이 브라우저는 녹음을 지원하지 않습니다\./)
})

test('녹음 상한은 업로드 상한에서 나오고, 닿으면 스스로 멈춘다', () => {
  // 상한을 넘긴 녹음은 업로드에서 통째로 거절당한다 — 넘기게 두는 것은 그때까지의 녹음을 버리는 것이다.
  assert.ok(MAX_RECORDING_BYTES < MAX_DOCUMENT_BYTES, '녹음 상한은 업로드 상한보다 작아야 한다')
  assert.ok(MAX_RECORDING_BYTES < 10 * 1024 * 1024, '서버 express.raw 10MB 안쪽이어야 한다')
  assert.ok(MAX_RECORDING_BYTES > 8 * 1024 * 1024, '지나치게 짧게 잘라 40분 회의를 못 담게 하지 않는다')
  // 두 수가 따로 적혀 있으면 조용히 갈린다 — 한 수에서 나와야 한다.
  assert.match(mediaRecorderUtil, /MAX_RECORDING_BYTES = MAX_DOCUMENT_BYTES - /)
  // 자동 정지 분기.
  assert.match(mediaRecorderUtil, /if \(bytes >= MAX_RECORDING_BYTES && !autoStopped\) \{[\s\S]{0,120}halt\(\)/)
  assert.match(mediaRecorderUtil, /RECORDING_AUTO_STOPPED_MESSAGE = '용량 상한에 닿아 녹음을 자동으로 멈췄습니다\./)
  assert.match(meetingRecorderTsx, /if \(autoStopped\) onToast\(RECORDING_AUTO_STOPPED_MESSAGE\)/, '자동으로 멈췄다는 사실을 사람에게 말한다')
})

test('마이크가 막히면 이름이 아니라 푸는 길을 말한다', () => {
  assert.match(mediaRecorderUtil, /마이크 권한이 필요합니다\. 주소창의 자물쇠 아이콘에서 마이크를 허용해 주세요\./)
  assert.match(mediaRecorderUtil, /name === 'NotAllowedError'[\s\S]{0,80}MICROPHONE_DENIED_MESSAGE/)
  assert.match(meetingRecorderTsx, /onToast\(microphoneErrorMessage\(cause\)\)/)
  // 실패해도 마이크 표시등은 끈다.
  assert.match(meetingRecorderTsx, /stopStream\(streamRef\.current\)/)
})

test('전사 연결이 없으면 그렇다고 쓴다 — 가짜 진행 표시를 만들지 않는다', () => {
  const vendorless = transcriptionNotice({ provider: 'text', acceptsAudio: false, acceptsTranscript: true, mimeTypes: [], extensions: [] })
  const nothing = transcriptionNotice({ provider: 'none', acceptsAudio: false, acceptsTranscript: false, mimeTypes: [], extensions: [] })
  const ready = transcriptionNotice({ provider: 'whisper', acceptsAudio: true, acceptsTranscript: true, mimeTypes: [], extensions: [] })
  assert.match(vendorless, /음성 전사 연결이 아직 설정되지 않았습니다/)
  assert.match(vendorless, /회의록 원문\(\.txt·\.vtt·\.srt·\.md\)을 올리면 요약과 할 일 추출은 그대로 됩니다/)
  assert.match(nothing, /음성 전사 연결이 아직 설정되지 않았습니다/)
  // 'none'은 원문 업로드도 읽지 못한다 — 되는 것처럼 말하면 사람이 파일을 올리고 503을 본다.
  assert.match(nothing, /지금은 회의록 원문 파일도 읽지 못합니다/)
  assert.equal(ready, '', '벤더가 붙으면 안내를 감춘다')
  // 화면이 이 문장을 실제로 그린다.
  assert.match(meetingNotesTsx, /const notice = transcriptionNotice\(transcription\)/)
  assert.match(meetingNotesTsx, /\{notice && <p className="meeting-provider-note">/)
  // 녹음 버튼은 벤더가 없거나 **모를 때** 곧바로 녹음하지 않고 먼저 그 사실을 말한다(시험 46).
  assert.match(meetingRecorderTsx, /if \(!transcription \|\| !transcription\.acceptsAudio\) setPhase\('confirm'\)/)
  assert.match(meetingNotesUtil, /RECORDING_WITHOUT_VENDOR_NOTE = '녹음 파일은 자료실에 보관되지만, 음성 전사 연결이 없어 지금은 글로 옮기지 못합니다\./)
})

test('동의 대화상자가 3단 수준과 「사람이 다시 승인한다」를 함께 말한다', () => {
  const consent = meetingNotesTsx.slice(meetingNotesTsx.indexOf('function MeetingConsentDialog'))
  // 세 낱말은 화면에 손으로 적지 않고 `AI_LEVEL_LABEL` 한 곳에서 나온다 — 서버 어휘와 갈리지 않게.
  // 「보관만」은 서버가 보낸 `lockedMessage`가 그 자리에서 말하고(위 시험이 그 문장을 글자 그대로 잠근다),
  // 「정리」·「활용」은 라디오 두 줄이 말한다.
  assert.match(consent, /\{lockedMessage\}/)
  assert.match(MEETING_AI_LOCKED_MESSAGE, new RegExp(`「${AI_LEVEL_LABELS.locked}」`))
  assert.match(consent, new RegExp(`\\{AI_LEVEL_LABEL\\.indexed\\} — `))
  assert.match(consent, new RegExp(`\\{AI_LEVEL_LABEL\\.active\\} — `))
  assert.deepEqual(
    [AI_LEVEL_LABELS.locked, AI_LEVEL_LABELS.indexed, AI_LEVEL_LABELS.active],
    ['보관만', '정리', '활용'],
    '동의 화면이 사람에게 보여 주는 세 낱말',
  )
  assert.match(consent, /승인 큐에서 사람이 다시 승인해야 실행됩니다/)
  assert.match(consent, /const \[level, setLevel\] = useState<AiLevel>\('active'\)/, '기본 선택은 「활용」이다')
  assert.match(consent, /onConfirm\(level\)/)
  // 라디오는 두 개 — 「보관만」으로 되돌리는 것은 이 자리가 아니라 revoke-ai 다.
  assert.equal(count(consent, /type="radio"/g), 2)
})

test('AI 수준은 회의 라우트가 올린다 — 관리자 전용 문서 PATCH를 부르지 않는다', () => {
  // `PATCH /api/documents/:id`는 requireTenantAdmin이라 직원이 자기 회의를 처리할 수 없다.
  assert.doesNotMatch(meetingScreen, /api\/documents\/\$\{/, '회의 화면은 문서 한 건 라우트를 부르지 않는다')
  assert.match(meetingNotesTsx, /\/api\/meetings\/\$\{encodeURIComponent\(meeting\.id\)\}\/process/)
  assert.match(meetingNotesTsx, /body: JSON\.stringify\(aiPolicy \? \{ aiPolicy \} : \{\}\)/)
  // 업로드는 수준을 보내지 않는다 — 정하는 곳은 서버 하나다(화면이 잊어도 안전한 쪽으로 떨어진다).
  assert.doesNotMatch(meetingScreen, /aiPolicy:\s*'locked'/)

  /*
   * **표기가 아니라 목적지를 잰다.** 위 `doesNotMatch`는 템플릿 리터럴 한 가지 모양만 막는다 —
   * 같은 라우트를 `'/api/documents/' + id` 로 잇거나 `` `/api/${'documents'}/${id}` `` 로 쪼개면
   * 그 단언은 그대로 통과한다. 그래서 이 화면이 실제로 부르는 **모든** fetch 목적지를 세고,
   * 허용 목록에 없는 것이 하나라도 있으면 빨개지게 한다.
   */
  const targets = fetchTargets(meetingCode)
  assert.ok(targets.length >= 4, `fetch 목적지를 읽지 못했다: ${JSON.stringify(targets)}`)
  const allowed = /^(['`])\/api\/(meetings|documents|directory)\b/
  for (const target of targets) {
    assert.match(target, allowed, `회의 화면이 허용 목록 밖을 부른다: ${target}`)
  }
  // 자료실 쪽으로 가는 것은 **목록 읽기 한 번**뿐이다. 문서 한 건 라우트는 어떤 표기로도 없다.
  assert.deepEqual(
    targets.filter((target) => target.includes('documents')),
    ["'/api/documents'"],
    '자료실 호출은 목록 읽기 한 번뿐이어야 한다',
  )
  // 이 화면이 보내는 PATCH 는 회의 라우트 하나다(자료 PATCH 가 끼어들면 여기서 걸린다).
  assert.equal(count(meetingCode, /method:\s*'PATCH'/g), 1)
  assert.doesNotMatch(meetingCode, /method:\s*'PATCH'[\s\S]{0,240}?\/api\/documents/)
})

test('막는 것은 서버다 — 409를 받으면 그 문장으로 동의를 묻는다', () => {
  const serverSentence = /message: '(이 회의 원본의 AI 처리 수준이 「보관만」입니다\.[^']*)'/.exec(meetingNotesServer)?.[1]
  assert.ok(serverSentence, '서버 사전에서 「보관만」 문장을 읽어야 한다')
  // 규칙 3: 클라이언트 사전 경고와 서버 거절이 한 문장에서 나온다.
  assert.equal(MEETING_AI_LOCKED_MESSAGE, serverSentence)
  assert.match(meetingNotesTsx, /if \(body\.error\?\.code === MEETING_AI_LOCKED_CODE\) \{/)
  assert.match(meetingNotesTsx, /setConsent\(\{\s*\n\s*meeting,\s*\n\s*message: body\.error\.message \|\| MEETING_AI_LOCKED_MESSAGE,/)
})

test('화면이 말하는 것은 서버가 실제로 한 일이다', () => {
  // 「지웠습니다」·「제안 N건」을 화면이 지어 쓰지 않는다(규칙 11·13).
  assert.match(meetingNotesTsx, /onToast\(body\.message \|\| '회의를 지웠습니다\.'\)/)
  assert.match(meetingNotesTsx, /onToast\(body\.message \|\| '원본을 「보관만」으로 되돌렸습니다\.'\)/)
  assert.match(meetingNotesTsx, /if \(body\.proposalsSkipped === 'ai-level'\)/)
  assert.match(meetingNotesTsx, /if \(body\.documentNote\) parts\.push\(body\.documentNote\)/)
  // 목록 개수는 서버의 total이다 — 자른 배열의 길이를 세지 않는다.
  assert.match(meetingNotesTsx, /setTotal\(Number\(bodies\[0\]\?\.total \?\? rows\.length\)\)/)
  // 완료 줄의 마지막 칸은 **지금 승인 큐에서 기다리는 수**(서버가 센 `pendingProposals`)이지
  // 할 일 후보 수도, 지금까지 올린 것의 누적 이력도 아니다.
  assert.equal(
    meetingOutcomeLine({
      summary: { summary: '', participants: [], decisions: [{ text: 'a', quote: 'a' }], tasks: [{ title: 't', owner: '', due: '', quote: 'q' }, { title: 'u', owner: '', due: '', quote: 'r' }], insufficient: false, mode: 'grounded-fallback', notice: '' },
      proposalIds: [],
      pendingProposals: 0,
    }),
    '결정 1 · 할 일 2 · 승인 대기 0',
  )
})

test('상태·수준·확장자는 서버 어휘의 거울이다', () => {
  assert.deepEqual(Object.keys(MEETING_STATUS_LABEL), [...MEETING_STATUSES])
  assert.deepEqual(Object.keys(AI_LEVEL_LABEL), [...AI_LEVELS])
  assert.deepEqual(AI_LEVEL_LABEL, { ...AI_LEVEL_LABELS })
  assert.deepEqual([...TRANSCRIPT_EXTENSIONS].sort(), [...SERVER_TRANSCRIPT_EXTENSIONS].sort())
  assert.equal(isTranscriptFileName('10월 회의.VTT'), true)
  assert.equal(isTranscriptFileName('10월 회의.m4a'), false)
})

test('화면당 primary 버튼은 하나라는 규칙이 회의록 화면에서도 지켜진다', () => {
  // 화면 셋 = page-header 1 + 「새 회의」 대화상자 1 + AI 수준 동의 대화상자 1. 정확히 셋이다.
  assert.equal(count(meetingNotesTsx, /tone="primary"/g), 3, 'MeetingNotes.tsx의 tone="primary"는 정확히 3개')
  assert.equal(count(meetingRecorderTsx, /tone="primary"/g), 0, '녹음은 그 화면의 기본 행동이 아니다')
  // 상세 대화상자의 기본 행동은 「결정」이 아니라 「읽기」다 — primary 를 두지 않는다.
  const detail = meetingNotesTsx.slice(meetingNotesTsx.indexOf('function MeetingDetailDialog'), meetingNotesTsx.indexOf('function MeetingConsentDialog'))
  assert.equal(count(detail, /tone="primary"/g), 0)
})

test('회의록 화면에 hex 색이 없고, 라우트는 레지스트리 한 곳에서 나온다', () => {
  for (const [name, source] of [['MeetingNotes.css', meetingNotesCss], ['MeetingNotes.tsx', meetingNotesTsx], ['MeetingRecorder.tsx', meetingRecorderTsx]]) {
    assert.equal(count(source, /#[0-9a-fA-F]{3,8}\b/g), 0, `${name}에 hex 색이 남아 있다`)
  }
  assert.match(registry, /meetings: \{ id: 'meetings', label: '회의록', icon: Mic \}/, '메뉴 라벨은 레지스트리 한 곳에서 나온다')
  assert.match(app, /case 'meetings': return <MeetingNotesPage/)
  // 회의록 문서는 문서 화면의 **그 문서**를 연다 — page만 바꾸면 목록 첫 화면이 열려 근거에 닿지 못한다.
  assert.match(app, /onOpenDocument=\{\(documentId\) => \{ setWikiFocusId\(documentId\); navigate\('wiki'\) \}\}/)
})

test('한글 입력이 끊기지 않는다 — onChange는 받은 값을 그대로 넘긴다', () => {
  const banned = /\.trim\(\)|\.replace\(|\.toUpperCase\(\)|\.toLowerCase\(\)|Number\(|parseInt|parseFloat/
  for (const [name, source] of [['MeetingNotes.tsx', meetingNotesTsx], ['MeetingRecorder.tsx', meetingRecorderTsx]]) {
    for (const match of source.matchAll(/onChange=\{/g)) {
      const body = attributeBody(source, match.index + 'onChange='.length)
      for (const target of body.matchAll(/event\.target\.(\w+)/g)) {
        assert.ok(['value', 'files', 'checked'].includes(target[1]),
          `${name}: onChange가 event.target.${target[1]}을 읽는다 — value·files·checked만 읽어야 한다`)
      }
      if (!body.includes('event.target.value')) continue
      assert.doesNotMatch(body, banned, `${name}: onChange가 입력 중인 값을 고친다 — 조합 중인 한글이 끊긴다`)
    }
  }
  // 다듬기는 제출 시점에만.
  assert.match(meetingNotesTsx, /if \(!title\.trim\(\)\) \{ onToast\('회의 제목을 입력해 주세요\.'\); return \}/)
})

test('회의 화면이 create → update → delete 를 모두 전용 라우트로 지난다', () => {
  assert.match(meetingNotesTsx, /await fetch\('\/api\/meetings', \{\s*\n?\s*method: 'POST'/)
  assert.match(meetingNotesTsx, /method: 'PATCH', headers: jsonHeaders, body: JSON\.stringify\(patch\)/)
  assert.match(meetingNotesTsx, /\{ method: 'DELETE', headers \}\)/)
  // 제목·참석자를 바꾸고 지우는 사람은 서버의 canManageMeeting 과 같다 — 참석자는 열람자다.
  assert.match(meetingNotesTsx, /meeting!\.createdById === currentUserId \|\| isAdmin/)
  assert.match(meetingNotesServer, /canManageMeeting = \(meeting, auth\)/)
})

/**
 * ── M4 검증 지적 반영 (1회차) ────────────────────────────────────────────────
 * 아래 다섯은 1회차 적대적 검증에서 실제로 재현된 결함을 잠근다. 전부 고치기 전 상태에서 빨갛다.
 */

test('43. 동의를 묻는 자리에는 열람 범위 문장이 **언제나** 실린다 — 목록에서 들어와도', () => {
  // 이 화면이 만드는 회의는 예외 없이 경고의 강한 쪽이다: 원본은 올린 사람만 읽는
  // `visibility:'restricted'` 로 올라가는데, 거기서 뽑은 요약·결정 인용은 회사 전원이 읽는다.
  // 설계 §0.3 은 「화면이 그 사실을 말한다」를 유일한 완화책으로 삼았다.
  const serverAudience = /DOCUMENT_AUDIENCE_MESSAGE = Object\.freeze\(\{\s*\n\s*same: '([^']+)'/.exec(meetingNotesServer)?.[1]
  assert.ok(serverAudience, '서버 사전에서 열람 범위 문장을 읽어야 한다')
  assert.equal(MEETING_DOCUMENT_AUDIENCE_MESSAGE, serverAudience, '규칙 3: 화면과 서버가 한 문장에서 나온다')

  // 409 를 받으면 **상세를 한 번 물어** 서버가 준 문장을 채운다. 상세가 열려 있지 않다고
  // 조건부로 비우면, 주 경로(목록 행의 「AI로 정리」)에서만 경고가 통째로 빠진다.
  assert.match(meetingNotesTsx, /audience: await audienceMessageOf\(meeting\.id\)/)
  assert.match(meetingNotesTsx, /audienceMessage=\{consent\.audience\}/)
  assert.doesNotMatch(meetingNotesTsx, /audienceMessage=\{detail/, '상세가 열려 있을 때만 말하면 안 된다')
  // 못 물었을 때 빈 문자열로 떨어지지 않는다 — 언제나 참인 약한 쪽 문장으로 떨어진다.
  assert.match(meetingNotesTsx, /return MEETING_DOCUMENT_AUDIENCE_MESSAGE/)
  // 처리 응답에 실려 오는 같은 칸도 읽는다(선언해 두고 한 번도 읽지 않으면 같은 누락의 흔적이다).
  assert.match(meetingNotesTsx, /body\.documentAudience/)
})

test('44. 20,000자에서 잘린 요약은 그 사실을 말한다 — 형제 문장과 다른 사실이다', () => {
  assert.equal(MAX_TRANSCRIPT_STORED, SERVER_MAX_TRANSCRIPT_STORED, '상한은 서버 한 곳에서 나온다')
  // 화면이 그리는 유일한 경고가 `transcriptUnreadChars`(어댑터 상한 200,000자)뿐이면
  // 10배 먼저 닿는 20,000자 절단에서는 아무 말도 나가지 않는다.
  assert.match(meetingNotesTsx, /meeting\.transcriptTruncated &&/, '화면이 이 칸을 읽어야 한다')
  assert.match(meetingNotesTsx, /transcriptTruncatedNote\(MAX_TRANSCRIPT_STORED\)/)
  assert.match(meetingNotesTsx, /meeting\.transcriptUnreadChars > 0 &&/, '형제 문장은 그대로 남는다')
})

test('45. 세는 수와 보여 주는 수가 갈리지 않는다 — 「남은 N건」에 닿는 길이 실제로 있다', () => {
  assert.ok(MEETING_LIST_PAGE_SIZE <= SERVER_MAX_LIST_LIMIT, '한 묶음이 서버 상한을 넘을 수 없다')
  assert.equal(MEETING_LIST_PAGE_SIZE, SERVER_DEFAULT_LIST_LIMIT, '묶음 크기는 서버 기본값과 같은 수다')
  // 목록은 묶음을 offset 으로 이어 붙인다 — limit 만 올리면 상한 200 뒤의 회의에 영영 닿지 못한다
  // (회사당 상한은 1,000건이고, 그 상한 문구는 「지난 회의를 지운 뒤」라고 말한다).
  assert.match(meetingNotesTsx, /limit: String\(MEETING_LIST_PAGE_SIZE\)/)
  assert.match(meetingNotesTsx, /params\.set\('offset', String\(index \* MEETING_LIST_PAGE_SIZE\)\)/)
  assert.match(meetingNotesTsx, /meetings\.length < total/)
  assert.match(meetingNotesTsx, /건을 보여 주고 있습니다 · 남은/)
  assert.match(meetingNotesTsx, /더 보기/)
  // 끝난 회의인데 문서가 없으면, 그 문장이 지목하는 「다시 정리」가 같은 줄에 실제로 있다.
  // 라벨은 유틸 한 곳에서 나온다 — 그 글자가 문장의 글자와 같은지는 시험 59가 잰다.
  assert.match(meetingNotesTsx, /MEETING_DOCUMENT_MISSING_NOTE/)
  assert.match(meetingNotesTsx, /meetingProcessLabel\(meeting\.status\)/)
  assert.match(meetingNotesUtil, /'다시 정리'/)
})

test('46. 전사 연결 상태를 모르면 확인을 건너뛰지 않는다', () => {
  // 목록 요청이 실패하면 `transcription` 은 null 로 남고 버튼은 다시 눌린다.
  // 그때 조건이 거짓이 되어 곧장 녹음이 시작되면, 사람은 40분을 녹음한 뒤에야 알게 된다.
  assert.match(meetingRecorderTsx, /if \(!transcription \|\| !transcription\.acceptsAudio\) setPhase\('confirm'\)/)
  assert.doesNotMatch(meetingRecorderTsx, /if \(transcription && !transcription\.acceptsAudio\) setPhase\('confirm'\)/)
  // 「없다」와 「모른다」는 다른 사실이라 문장도 다르다(규칙 11).
  assert.equal(recordingConfirmNote(null), RECORDING_UNKNOWN_VENDOR_NOTE)
  assert.equal(
    recordingConfirmNote({ provider: 'text', acceptsAudio: false, acceptsTranscript: true, mimeTypes: [], extensions: [] }),
    RECORDING_WITHOUT_VENDOR_NOTE,
  )
  assert.notEqual(RECORDING_UNKNOWN_VENDOR_NOTE, RECORDING_WITHOUT_VENDOR_NOTE)
  assert.match(meetingRecorderTsx, /recordingConfirmNote\(transcription\)/)
})

test('47. 마이크 승인을 기다리는 동안에는 녹음 표시를 그리지 않는다', () => {
  const begin = meetingRecorderTsx.slice(meetingRecorderTsx.indexOf('const begin = async'))
  const micAt = begin.indexOf('await requestMicrophone()')
  assert.ok(micAt > 0, 'begin() 안에서 마이크를 요청해야 한다')
  // 승인이 떨어지기 전에 빨간 점·경과 시간·용량 막대를 그리면 그것은 가짜 진행 표시다(설계 §4.3).
  assert.ok(begin.indexOf("setPhase('recording')") > micAt, '녹음 표시는 승인이 돌아온 뒤에 켠다')
  assert.ok(begin.indexOf('startedAtRef.current = new Date()') > micAt, '경과 시간의 기준은 실제 녹음 시작이다')
  // 「그만」이 실제로 멈출 것이 있으려면 세션이 먼저 잡혀 있어야 한다.
  assert.ok(
    begin.indexOf('sessionRef.current = startRecordingSession') < begin.indexOf("setPhase('recording')"),
    '녹음 표시가 켜질 때는 멈출 세션이 이미 있어야 한다',
  )
  const requestingAt = meetingRecorderTsx.indexOf("if (phase === 'requesting')")
  const recordingAt = meetingRecorderTsx.indexOf("if (phase === 'recording' || phase === 'saving')")
  assert.ok(requestingAt > 0 && recordingAt > requestingAt, "'requesting' 갈래를 녹음 갈래보다 먼저 그린다")
  const requesting = meetingRecorderTsx.slice(requestingAt, recordingAt)
  assert.match(requesting, /MICROPHONE_WAITING_MESSAGE/)
  assert.doesNotMatch(requesting, /meeting-recorder-meter|formatElapsed|meeting-recorder-dot/, '기다리는 동안 진행 표시는 없다')
  // 「취소」는 뒤늦게 도착한 스트림을 그대로 놓는다 — 누르고 나서 녹음이 시작되면 취소가 아니다.
  assert.match(requesting, /attemptRef\.current \+= 1/)
  assert.match(begin, /if \(attempt !== attemptRef\.current\) \{[\s\S]{0,400}stopStream\(stream\)/)
})

test('48. 승인 큐를 지목하는 세 자리는 직원과 관리자에게 다르게 말한다', async () => {
  const {
    MEETING_ACTIVE_UPGRADE_LABEL, meetingAiLevelNote, meetingPendingProposalNote, meetingQueuedToast,
  } = await import('../src/utils/meetingNotes.ts')

  // `GET /api/proposals` 는 requireTenantAdmin 이고 ApprovalQueue 는 비관리자에게 AI 제안 패널을
  // 통째로 감춘다 — 직원에게 「승인 큐 열기」를 그려 주면 아무것도 없는 곳으로 보낸다(규칙 11).
  const adminNote = meetingPendingProposalNote(2, true)
  const memberNote = meetingPendingProposalNote(2, false)
  assert.notEqual(adminNote, memberNote, '누가 읽느냐에 따라 참인 문장이 다르다')
  assert.match(adminNote, /승인 큐/)
  assert.match(memberNote, /관리자/, '직원에게는 실제로 일어날 일을 말한다')
  assert.doesNotMatch(memberNote, /승인 큐 열기/)
  assert.equal(meetingPendingProposalNote(0, true), meetingPendingProposalNote(0, false), '0건이면 갈릴 사실이 없다')

  const adminToast = meetingQueuedToast(2, 0, true)
  const memberToast = meetingQueuedToast(2, 0, false)
  assert.notEqual(adminToast, memberToast)
  assert.match(memberToast, /관리자/)
  assert.match(meetingQueuedToast(0, 3, true), /3건/, '이미 올라간 건수도 그대로 말한다')

  // 화면은 이 문장들을 손으로 다시 적지 않고 한 곳에서 가져온다(규칙 3).
  assert.match(meetingNotesTsx, /meetingPendingProposalNote\(/)
  assert.match(meetingNotesTsx, /meetingQueuedToast\(/)
  // 「승인 큐 열기」 버튼은 관리자 갈래에만 있다. **도는 코드만 본다** — 주석에 적어 둔 라벨까지
  // 세면 그 설명을 지우는 것만으로 단언의 통과 여부가 바뀐다.
  const detail = stripComments(meetingNotesTsx.slice(meetingNotesTsx.indexOf('function MeetingDetailDialog'), meetingNotesTsx.indexOf('function MeetingConsentDialog')))
  const queueButtonAt = detail.indexOf('승인 큐 열기')
  assert.ok(queueButtonAt > 0, '관리자에게는 그 버튼이 있어야 한다')
  assert.match(detail.slice(Math.max(0, queueButtonAt - 400), queueButtonAt), /isAdmin &&/, '비관리자 갈래에 승인 큐 링크가 없다')
  assert.equal(detail.indexOf('승인 큐 열기', queueButtonAt + 1), -1, '승인 큐로 보내는 자리는 하나여야 갈리지 않는다')

  // 「정리」에서 「활용」으로 올라가는 길이 409 갈래 밖에도 있다(누를 곳 없는 문장을 만들지 않는다).
  // 라벨은 손으로 다시 적지 않는다 — 문장이 지목하는 글자와 버튼에 찍히는 글자가 한 곳에서 나온다.
  assert.match(meetingNotesTsx, /\{MEETING_ACTIVE_UPGRADE_LABEL\}/, '화면이 그 라벨을 실제로 그려야 한다')
  assert.match(meetingNotesTsx, /onProcess\(meeting, 'active'\)/)
  assert.ok(meetingAiLevelNote(true).includes(MEETING_ACTIVE_UPGRADE_LABEL), '올릴 수 있는 사람에게는 그 버튼을 지목한다')
  assert.ok(!meetingAiLevelNote(false).includes(MEETING_ACTIVE_UPGRADE_LABEL), '누를 수 없는 사람에게 버튼을 지목하지 않는다')
  assert.match(meetingAiLevelNote(false), /관리자/)
})

test('49. 「올라가 있다」는 누적 이력이 아니라 서버가 센 대기 수에서 나온다', async () => {
  const { meetingPendingProposalNote } = await import('../src/utils/meetingNotes.ts')
  // 결재가 끝나면 proposalIds 는 그대로인데 대기는 0건이 된다 — 그 길이를 세면 화면이 거짓을 말한다.
  assert.equal(
    meetingOutcomeLine({
      summary: { summary: '', participants: [], decisions: [{ text: 'a', quote: 'a' }], tasks: [{ title: 't', owner: '', due: '', quote: 'q' }, { title: 'u', owner: '', due: '', quote: 'r' }], insufficient: false, mode: 'grounded-fallback', notice: '' },
      proposalIds: ['P1', 'P2', 'P3', 'P4'],
      pendingProposals: 1,
    }),
    '결정 1 · 할 일 2 · 승인 대기 1',
  )
  assert.match(meetingPendingProposalNote(1, true), /1건/)
  // 화면의 도는 코드 어디에도 `proposalIds.length` 가 없다.
  assert.doesNotMatch(meetingCode, /proposalIds\.length/, '누적 이력의 길이로 「지금」을 말하지 않는다')
  assert.match(meetingNotesUtil, /pendingProposals: number/, '서버가 실은 칸을 화면 타입이 받는다')
})

test('50. 녹음 확인 문장은 원문 업로드가 실제로 되는 설정에서만 그 길을 지목한다', async () => {
  const { RECORDING_WITHOUT_TRANSCRIPT_NOTE } = await import('../src/utils/meetingNotes.ts')
  const none = recordingConfirmNote({ provider: 'none', acceptsAudio: false, acceptsTranscript: false, mimeTypes: [], extensions: [] })
  const text = recordingConfirmNote({ provider: 'text', acceptsAudio: false, acceptsTranscript: true, mimeTypes: [], extensions: [] })
  assert.equal(none, RECORDING_WITHOUT_TRANSCRIPT_NOTE)
  assert.equal(text, RECORDING_WITHOUT_VENDOR_NOTE)
  assert.notEqual(none, text, '「원문도 못 읽는다」와 「원문은 읽는다」는 다른 사실이다')
  // 같은 화면 위쪽의 안내와 갈리지 않는다 — 하나는 「원문 파일도 읽지 못한다」인데
  // 다른 하나가 「원문 파일을 올려 주세요」이면 한 사실을 두 문장으로 갈라 말하는 것이다(규칙 3).
  assert.doesNotMatch(none, /원문 파일을 올려 주세요/)
  assert.match(none, /원문 파일도/)
  assert.match(text, /원문 파일을 올려 주세요/)
})

test('51. 선언한 CSS 클래스에는 실제 규칙이 있다', () => {
  // 설계 §4.6이 나열한 클래스 가운데 화면이 실제로 쓰는 것은 스타일시트에도 있어야 한다.
  for (const name of ['meeting-outcome', 'meeting-detail', 'meeting-source-card', 'meeting-transcript', 'meeting-proposal-link', 'meeting-ai-consent']) {
    // `meeting-outcome-line` 이 `meeting-outcome` 을 대신 통과시키지 않게 뒤도 잠근다.
    assert.match(meetingScreen, new RegExp(`className=[^\\n]*\\b${name}(?![-\\w])`), `${name}를 화면이 써야 한다`)
    assert.match(meetingNotesCss, new RegExp(`\\.${name}[\\s,{]`), `${name}에 실제 규칙이 없다`)
  }
})

test('52. 「AI 결과 파기」도 형제 버튼과 같은 자를 댄다 — 한 대화상자에서 두 자리가 갈리지 않는다', async () => {
  const { MEETING_POLICY_FORBIDDEN_MESSAGE } = await import('../src/utils/meetingNotes.ts')
  // 서버는 라우트 8(올리기)·9(되돌리기)와 상세의 `aiLevel.mayRaise`가 **한 술어**를 본다.
  // 그러니 mayRaise 가 거짓인 사람에게 「AI 결과 파기」는 언제나 403이다(규칙 8·11).
  assert.match(meetingNotesServer, /if \(!canChangeAiLevel\(source, auth\)\) \{ fail\(response, ERRORS\.POLICY_FORBIDDEN\)/, '라우트 9가 그 술어를 본다')
  assert.match(meetingNotesServer, /mayRaise: canChangeAiLevel\(source, auth\)/, '화면에 실어 보내는 깃발도 같은 술어다')
  assert.ok(meetingNotesServer.includes(MEETING_POLICY_FORBIDDEN_MESSAGE), '화면의 거울이 서버 문구와 글자 그대로 같아야 한다')

  const detail = stripComments(meetingNotesTsx.slice(meetingNotesTsx.indexOf('function MeetingDetailDialog'), meetingNotesTsx.indexOf('function MeetingConsentDialog')))
  const revokeAt = detail.indexOf('AI 결과 파기')
  assert.ok(revokeAt > 0, '파기 버튼이 있어야 한다')
  assert.match(detail.slice(Math.max(0, revokeAt - 200), revokeAt), /aiLevel\?\.mayRaise/, '파기 버튼도 그 깃발을 본다')
  // 거짓일 때는 버튼 없이 **누가 할 수 있는지**를 말한다 — 형제 자리(meetingAiLevelNote(false))와 같은 어투다.
  assert.match(detail, /MEETING_POLICY_FORBIDDEN_MESSAGE/, '거짓 갈래에서 서버가 할 말을 그 자리에서 한다')
  assert.ok(detail.indexOf('MEETING_POLICY_FORBIDDEN_MESSAGE') > revokeAt, '버튼 대신 그리는 자리여야 한다')
})

test('53. 미리보기 글자 수는 서버가 센 것을 그대로 그린다 — 화면이 다시 세지 않는다', () => {
  // 미리보기는 코드포인트 상한으로 잘리고 `transcriptChars`도 코드포인트다. 화면이 `String.length`로
  // 다시 세면 이모지 한 자가 둘로 세어져 「앞부분 4,000자 (전체 2,100자)」가 된다(규칙 13).
  assert.doesNotMatch(meetingCode, /transcriptPreview\.length/, '화면이 코드유닛으로 다시 세지 않는다')
  assert.match(meetingNotesTsx, /detail\.transcriptPreviewChars\.toLocaleString/, '서버가 센 수를 그린다')
  assert.match(meetingNotesUtil, /transcriptPreviewChars: number/, '화면 타입이 그 칸을 받는다')
  assert.match(meetingNotesServer, /transcriptPreviewChars: countCharacters\(transcriptPreview\)/, '서버가 코드포인트로 센다')
})

test('54. 녹음 취소는 시도별로 무효가 된다 — 컴포넌트 하나짜리 깃발은 두 번째 시도에서 무너진다', () => {
  // 깃발 하나면 `begin()`이 맨 위에서 되돌리므로, 취소 뒤 다시 시작한 순간 **앞선** 시도의 스트림이
  // 취소로 읽히지 않고 `streamRef`를 차지했다가 덮인다 — 그 마이크는 아무도 놓지 않는다.
  assert.doesNotMatch(meetingRecorderTsx, /cancelledRef/, '시도 하나에 하나인 깃발을 쓰지 않는다')
  const begin = meetingRecorderTsx.slice(meetingRecorderTsx.indexOf('const begin = async'))
  assert.match(begin, /const attempt = \+\+attemptRef\.current/, '시도마다 번호를 매긴다')
  // 무효가 된 시도는 **자기 스트림만** 놓고 물러난다 — 단계를 건드리면 뒤에 온 시도의 화면을 지운다.
  const stale = begin.slice(begin.indexOf('if (attempt !== attemptRef.current)'))
  const staleBranch = stale.slice(0, stale.indexOf('return') + 6)
  assert.match(staleBranch, /stopStream\(stream\)/)
  assert.doesNotMatch(staleBranch, /streamRef\.current = stream|setPhase/)
  // 취소·언마운트는 번호를 밀기만 하면 된다(진행 중인 모든 시도가 한 번에 무효가 된다).
  assert.ok(count(meetingRecorderTsx, /attemptRef\.current \+= 1/g) >= 2, '취소와 언마운트 두 자리가 번호를 민다')
  // 무효가 된 시도의 실패로 지금 시도의 스트림을 놓아 버리지 않는다.
  assert.match(begin, /catch \(cause\) \{[\s\S]{0,300}if \(attempt !== attemptRef\.current\) return/)
})

test('55. 참석자 상한은 서버 상수 한 곳에서 나오고, 화면이 그 수를 말한다', async () => {
  const { MAX_PARTICIPANTS, meetingParticipantLimitNote } = await import('../src/utils/meetingNotes.ts')
  assert.equal(MAX_PARTICIPANTS, SERVER_MAX_PARTICIPANTS, '두 곳에 손으로 적으면 조용히 갈린다')
  // 서버는 상한을 넘긴 명단을 **말없이** 자르고 200으로 답한다. 그 명단은 곧 열람 명단이다.
  assert.match(meetingNotesServer, /\.slice\(0, MAX_PARTICIPANTS\)/)
  assert.match(meetingNotesTsx, /meetingParticipantLimitNote\(participantIds\.length, MAX_PARTICIPANTS\)/, '화면이 그 수를 말한다')
  assert.match(meetingNotesTsx, /disabled=\{!picked && participantIds\.length >= MAX_PARTICIPANTS\}/, '상한에 닿으면 더 고를 수 없다')
  // 이미 고른 칸은 계속 끌 수 있어야 한다 — 빼는 길까지 막으면 상한이 함정이 된다(규칙 1).
  const limitNote = meetingParticipantLimitNote(MAX_PARTICIPANTS, MAX_PARTICIPANTS)
  assert.notEqual(limitNote, meetingParticipantLimitNote(0, MAX_PARTICIPANTS), '닿았을 때와 여유가 있을 때는 다른 사실이다')
  assert.match(limitNote, /빼 주세요/)
  assert.ok([limitNote, meetingParticipantLimitNote(0, MAX_PARTICIPANTS)].every((row) => row.includes(String(MAX_PARTICIPANTS))))
  // 수는 문장에 손으로 박히지 않는다 — 서버가 상한을 바꾸면 화면 문장도 따라 바뀌어야 한다.
  assert.doesNotMatch(meetingNotesUtil, /최대 20명/)
})

test('56. 「모른다」와 「없다」를 가른다 — 자료 목록을 못 읽은 것은 자료가 없는 것이 아니다', async () => {
  const { meetingSourceMissingNote } = await import('../src/utils/meetingNotes.ts')
  const loading = meetingSourceMissingNote('loading')
  const failed = meetingSourceMissingNote('failed')
  const gone = meetingSourceMissingNote('ready')
  assert.equal(new Set([loading, failed, gone]).size, 3, '사실이 셋이므로 문장도 셋이다')
  assert.match(gone, /열람할 권한이 없거나 자료실에서 사라졌습니다/)
  // 요청만 실패했을 때 원인을 단정하면 둘 다 참이 아닐 수 있다.
  assert.doesNotMatch(failed, /사라졌|권한이 없/)
  assert.match(failed, /불러오지 못/)
  assert.match(failed, /새로고침/, '푸는 길이 실제로 있는 버튼을 지목한다')
  // 화면이 그 사실을 남긴다 — 실패를 조용히 삼키면 가를 근거가 없다.
  assert.match(meetingCode, /setDocumentsState\('failed'\)/)
  assert.match(meetingCode, /setDocumentsState\('ready'\)/)
  assert.match(meetingCode, /meetingSourceMissingNote\(documentsState\)/)
  assert.doesNotMatch(meetingCode, /이 회의의 원본 자료를 열람할 권한이 없거나/, '문장은 유틸 한 곳에서만 나온다')
})

test('57. 편집 폼은 회의가 바뀔 때만 채운다 — 처리 응답이 저장하지 않은 편집을 덮지 않는다', () => {
  const detail = meetingNotesTsx.slice(meetingNotesTsx.indexOf('function MeetingDetailDialog'), meetingNotesTsx.indexOf('function MeetingConsentDialog'))
  // `participantIds`는 응답마다 새 배열이고, 처리·되돌리기가 성공하면 그 meeting이 그대로 꽂힌다.
  // 그 둘을 의존성에 두면 한 대화상자 안에서 편집이 조용히 되돌아간다.
  assert.match(detail, /\}, \[meeting\?\.id\]\)/, '초기화는 회의가 바뀔 때만 돈다')
  assert.doesNotMatch(detail, /\[meeting\?\.id, meeting\?\.(title|participantIds)/)
  // 처리 응답이 meeting 을 꽂는 자리는 그대로 있어야 한다(그래야 이 시험이 재는 갈래가 실재한다).
  assert.match(meetingCode, /setDetail\(\(current\) => \(current && current\.meeting\.id === body\.meeting!\.id/)
})

test('58. 되지 않을 일에 동의를 받지 않는다 — 전사 연결이 없으면 동의를 묻기 전에 거절한다', async () => {
  const {
    MEETING_SOURCE_UNSUPPORTED_MESSAGE, TRANSCRIPTION_NOT_CONFIGURED_MESSAGE,
    meetingCreatedToast, meetingHeadline, meetingProcessBlockedNote,
  } = await import('../src/utils/meetingNotes.ts')
  const none = { provider: 'none', acceptsAudio: false, acceptsTranscript: false, mimeTypes: [], extensions: [] }
  const text = { provider: 'text', acceptsAudio: false, acceptsTranscript: true, mimeTypes: [], extensions: [] }

  // 서버 문장의 거울이다 — 사전 경고와 실제 거절이 한 템플릿에서 나온다(규칙 3).
  assert.ok(transcriptionServer.includes(TRANSCRIPTION_NOT_CONFIGURED_MESSAGE))
  assert.ok(transcriptionServer.includes(MEETING_SOURCE_UNSUPPORTED_MESSAGE))

  assert.equal(meetingProcessBlockedNote(none, 'transcript', false), TRANSCRIPTION_NOT_CONFIGURED_MESSAGE)
  assert.equal(meetingProcessBlockedNote(none, 'recording', false), TRANSCRIPTION_NOT_CONFIGURED_MESSAGE)
  assert.equal(meetingProcessBlockedNote(text, 'transcript', false), '', '오늘 실제로 되는 길은 막지 않는다')
  assert.equal(meetingProcessBlockedNote(text, 'recording', false), MEETING_SOURCE_UNSUPPORTED_MESSAGE)
  // 라우트 8은 전사문이 이미 있으면 어댑터를 부르지 않는다 — 그 갈래는 벤더 없이도 된다.
  assert.equal(meetingProcessBlockedNote(none, 'transcript', true), '')
  // 모르면 막지 않는다. 막는 것은 서버다(규칙 1).
  assert.equal(meetingProcessBlockedNote(null, 'transcript', false), '')

  // 409(보관만) 갈래가 동의를 묻기 **전에** 이 판정을 지난다.
  const lockedAt = meetingCode.indexOf('MEETING_AI_LOCKED_CODE')
  const consentAt = meetingCode.indexOf('setConsent({')
  assert.ok(lockedAt > 0 && consentAt > lockedAt)
  assert.match(meetingCode.slice(lockedAt, consentAt), /meetingProcessBlockedNote\(transcription, sourceKindOf\(meeting\), meeting\.hasTranscript\)/)

  // 헤더 한 줄과 아래 안내가 한 술어를 본다 — 하나가 「문서로 만듭니다」인데 다른 하나가
  // 「원문 파일도 읽지 못합니다」이면 한 화면이 한 사실을 갈라 말한다.
  assert.match(meetingNotesTsx, /\{meetingHeadline\(transcription\)\}/)
  assert.notEqual(meetingHeadline(none), meetingHeadline(text))
  assert.doesNotMatch(meetingHeadline(none), /^회의 녹음이나 회의록 원문을 올리면/)
  assert.match(meetingHeadline(none), /전사 연결이 켜지면/)
  assert.equal(meetingHeadline(null), meetingHeadline({ ...none, acceptsAudio: true }), '모르면 아래 안내도 비어 있어 갈릴 문장이 없다')

  // 만든 직후의 토스트도 같은 갈래로 나뉜다.
  assert.notEqual(meetingCreatedToast(none, 'transcript'), meetingCreatedToast(text, 'transcript'))
  assert.match(meetingCreatedToast(text, 'transcript'), /「AI로 정리」를 누르면/)
  assert.doesNotMatch(meetingCreatedToast(none, 'transcript'), /「AI로 정리」를 누르면/)
  assert.match(meetingNotesTsx, /meetingCreatedToast\(transcription,/)
})

test('59. 굳은 회의에도 나가는 길이 있다 — 진행 문장이 지목하는 버튼이 같은 줄에 실제로 있다', async () => {
  const { MEETING_DOCUMENT_MISSING_NOTE, meetingProcessLabel, meetingProgressNote } = await import('../src/utils/meetingNotes.ts')
  // 서버는 저장된 status 로 막지 않는다(프로세스 안의 잠금만 본다) — 굳은 회의를 되살릴 사람은
  // 사용자뿐이다. 화면이 버튼을 지우면 그 회의는 영영 굳은 채로 남는다(규칙 1·11).
  assert.match(meetingNotesServer, /const processing = new Set\(\)/)
  assert.doesNotMatch(meetingCode, /status !== 'transcribing' && meeting\.status !== 'summarizing'/, '바닥글이 두 상태에서 버튼을 지우지 않는다')
  assert.doesNotMatch(meetingCode, /끝나면 결과가 여기에 나옵니다/, '스스로 새로 고치지 않는 화면이 할 수 없는 약속이다')

  for (const status of ['transcribing', 'summarizing']) {
    const note = meetingProgressNote(status)
    assert.ok(note.includes(meetingProcessLabel(status)), `${status}: 문장이 지목하는 글자가 버튼의 글자여야 한다`)
    assert.match(note, /새로고침/)
  }
  // 「다시 정리」를 지목하는 다른 문장도 같은 라벨을 쓴다.
  assert.ok(MEETING_DOCUMENT_MISSING_NOTE.includes(meetingProcessLabel('done')))
  assert.equal(meetingProcessLabel('failed'), '다시 시도')
  assert.equal(meetingProcessLabel('uploaded'), 'AI로 정리')

  // 목록 줄은 진행 문장과 버튼을 함께 그리고, 라벨은 두 자리 모두 한 곳에서 가져온다.
  const rows = meetingCode.slice(meetingCode.indexOf('meeting-row-actions'), meetingCode.indexOf('meeting-more'))
  assert.match(rows, /meetingProgressNote\(meeting\.status\)/)
  assert.match(rows, /meetingProcessLabel\(meeting\.status\)/)
  assert.equal(count(meetingCode, /meetingProcessLabel\(meeting\.status\)/g), 2, '목록과 바닥글이 같은 라벨을 쓴다')
  assert.match(meetingCode, /새로고침<\/Button>/, '문장이 지목하는 「새로고침」이 실제로 있다')
})

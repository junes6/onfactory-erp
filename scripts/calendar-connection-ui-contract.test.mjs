import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * R16-E 일정 화면 계약.
 *
 * 화면을 렌더하지 않고 소스를 읽는다. 여기서 잠그는 것은 사람이 나중에 무심코 되돌릴 만한 것들이다:
 * 화면당 primary 하나, 최상위 훅 수(게스트 계약), IME 위험이 없는 입력, 토큰 문자열 부재,
 * 그리고 서버·클라이언트가 같은 목록을 들고 있다는 사실.
 */
const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')
const connection = read('src/components/CalendarConnection.tsx')
const connectionCss = read('src/components/CalendarConnection.css')
const collaboration = read('src/components/CollaborationSuite.tsx')
const app = read('src/App.tsx')
const notificationCenter = read('src/components/NotificationCenter.tsx')
const workspaceState = read('src/hooks/useWorkspaceState.ts')
const eventStreamHook = read('src/hooks/useEventStream.ts')
const eventStreamServer = read('server/event-stream.mjs')
const calendarSyncServer = read('server/calendar-sync.mjs')

const schedulePageSlice = () => {
  const start = collaboration.indexOf('export function SchedulePage(')
  const end = collaboration.indexOf('function ScheduleEventDialog(')
  assert.ok(start > 0 && end > start, 'SchedulePage 슬라이스를 찾지 못했다')
  return collaboration.slice(start, end)
}

test('1. 연결 카드에는 primary 버튼이 없다 — 이 화면의 primary는 일정 등록 하나다', () => {
  assert.equal((connection.match(/tone="primary"/g) ?? []).length, 0)
  const slice = schedulePageSlice()
  assert.equal((slice.match(/tone="primary"/g) ?? []).length, 1, 'SchedulePage의 primary는 .schedule-create-button 하나')
  assert.match(slice, /className="schedule-create-button"/)
})

test('2. 상태별 문구가 실제로 있고 없는 값은 0이나 —로 꾸미지 않는다', () => {
  assert.match(connection, /연동키 설정 후 사용할 수 있습니다/)
  assert.match(connection, /아직 동기화하지 않았습니다/)
  // 문장은 서버가 실제로 하는 일과 같아야 한다(remoteWriteBlockOf의 'unselected'와 그 예외 한 줄).
  assert.match(connection, /선택하지 않은 캘린더는 읽지 않고, 내보낼 캘린더가 아닌 한 쓰지도 않습니다/)
  assert.match(calendarSyncServer, /if \(!calendar\.selected && calendar\.id !== connection\?\.writeCalendarId\) return 'unselected'/)
  assert.match(connection, /<legend>동기화할 캘린더<\/legend>/)
  // 재연결은 사람이 마음먹어야 하는 일이라 토스트가 아니라 배너다.
  assert.match(connection, /role="alert"/)
  assert.match(connection, /가져온 구글 일정은/)
})

test('3. 연결 상태는 최상위 훅이 아니라 컴포넌트 안의 fetch로 읽는다', () => {
  // 훅을 하나 더 걸면 App의 'enabled: tenantDataEnabled,' 3회 계약(guest-ui-contract)이 깨진다.
  assert.doesNotMatch(connection, /useWorkspaceState[<(]/)
  assert.match(connection, /const load = useCallback\(async \(\) => \{[\s\S]*?await fetch\(STATUS_ENDPOINT/)
  assert.equal((app.match(/enabled: tenantDataEnabled,/g) ?? []).length, 3)
})

test('4. 캘린더 체크박스는 즉시 저장하지 않는다 — 저장은 선택 적용 버튼에만 있다', () => {
  const checkboxHandler = connection.match(/onChange=\{\(event\) => setSelection\([\s\S]*?\)\}/)?.[0] ?? ''
  assert.ok(checkboxHandler, '체크박스 onChange를 찾지 못했다')
  assert.equal(/fetch\(/.test(checkboxHandler), false, '키보드로 목록을 지나가는 동안 매번 저장되면 안 된다')
  assert.match(connection, /onClick=\{applySelection\}[\s\S]{0,80}선택 적용/)
  assert.match(connection, /const applySelection = async \(\) => \{[\s\S]*?method: 'PATCH'/)
})

test('5. 화면 코드 어디에도 토큰 이름이 없다', () => {
  assert.doesNotMatch(connection, /accessToken|refreshToken|client_secret/)
  assert.doesNotMatch(collaboration, /accessTokenEnc|refreshTokenEnc/)
})

test('6. 모든 네트워크 호출에 try/catch가 있고 finally에서 진행 상태를 푼다', () => {
  const calls = connection.match(/await fetch\(/g) ?? []
  assert.ok(calls.length >= 6, `fetch 호출이 너무 적다: ${calls.length}`)
  // setBusy를 켜는 곳마다 finally 또는 실패 경로에서 반드시 다시 푼다.
  const busyOn = (connection.match(/setBusy\('(?!'\))[a-z]+'\)/g) ?? []).length
  const busyOff = (connection.match(/setBusy\(''\)/g) ?? []).length
  assert.ok(busyOff >= busyOn - 1, `버튼을 영영 잠그는 경로가 있다: on ${busyOn} / off ${busyOff}`)
  assert.equal((connection.match(/catch \{/g) ?? []).length >= 6, true)
})

test('7. 연결 시작은 top-level 이동이다 — fetch나 팝업이면 세션 쿠키가 콜백에 실리지 않는다', () => {
  assert.match(connection, /window\.location\.assign\(body\.authorizeUrl\)/)
  assert.equal(connection.includes('window.open('), false)
})

test('8. 일정 화면이 카드를 한 번 걸고 동기화 뒤 서버에서 다시 읽는다', () => {
  const slice = schedulePageSlice()
  assert.equal((slice.match(/<CalendarConnectionCard/g) ?? []).length, 1)
  assert.match(slice, /reloadToken: calendarReload/)
  assert.match(slice, /onSynced=\{\(\) => setCalendarReload\(\(current\) => current \+ 1\)\}/)
  // 훅이 실제로 그 값을 identity에 넣어야 재조회가 일어난다.
  assert.equal((workspaceState.match(/reloadToken/g) ?? []).length, 4)
  assert.match(workspaceState, /JSON\.stringify\(\[enabled, seedWhenEmpty, normalizedScope, key, reloadToken\]\)/)
  // R16-C의 envelope 계약은 그대로다.
  assert.equal((workspaceState.match(/onEnvelope\?\.\(/g) ?? []).length, 2)
})

test('9. 외부 일정 표식은 색만이 아니라 문장으로도 전달된다', () => {
  const slice = schedulePageSlice()
  // 달력 칩 2회(클래스·sr-only) + 아젠다 3회(클래스·title·sr-only).
  assert.equal((slice.match(/externalIdSet\.has\(event\.id\)/g) ?? []).length, 5)
  assert.match(slice, /구글 캘린더와 연결된 일정/)
  assert.match(connectionCss, /\.calendar-event\.external/)
  assert.match(connectionCss, /\.schedule-agenda-item\.external/)
  assert.doesNotMatch(connectionCss, /#[0-9a-fA-F]{3,8}\b/)
  assert.equal(connectionCss.includes('.ui-button {'), false)
})

test('10. 콜백 플래그는 한 곳에서만 읽고 한 번 쓰고 비워지며 문구는 표에서 고른다', () => {
  assert.equal((app.match(/params\.get\('calendar'\)/g) ?? []).length, 1)
  assert.match(app, /window\.history\.replaceState\(null, '', window\.location\.pathname\)/)
  // 비우지 않으면 '방금 연결했다'가 세션 내내 참이라 일정 화면에 들어갈 때마다 구글 왕복이 한 번씩 더 돈다.
  assert.match(app, /onCalendarCallbackHandled=\{\(\) => setCalendarCallbackFlag\(''\)\}/)
  assert.match(collaboration, /onCallbackHandled=\{onCalendarCallbackHandled\}/)
  assert.match(connection, /if \(justConnected\) onCallbackHandled\?\.\(\)/)
  // 서버가 내는 reason 아홉 가지가 모두 문장을 갖는다 — 사용자에게 'norefresh'를 보여 주지 않는다.
  const reasons = calendarSyncServer.match(/export const CALLBACK_REASONS = Object\.freeze\(\[([^\]]*)\]\)/)?.[1] ?? ''
  const list = [...reasons.matchAll(/'([a-z]+)'/g)].map((match) => match[1])
  assert.equal(list.length, 9, reasons)
  for (const reason of list) assert.ok(connection.includes(`  ${reason}: '`), `${reason} 문장이 없다`)
})

test('11. 알림 유형이 세 곳에 모두 더해졌다', () => {
  assert.equal((notificationCenter.match(/'calendar-reauth'/g) ?? []).length, 3)
})

test('12. SSE 종류 목록이 서버와 같다', () => {
  const serverKinds = [...(eventStreamServer.match(/export const EVENT_KINDS = Object\.freeze\(\[([\s\S]*?)\]\)/)?.[1] ?? '').matchAll(/'([a-z]+)'/g)].map((match) => match[1])
  const clientType = [...(eventStreamHook.match(/export type StreamEventKind =([^\n]*)/)?.[1] ?? '').matchAll(/'([a-z]+)'/g)].map((match) => match[1])
  const clientList = [...(eventStreamHook.match(/const kinds: StreamEventKind\[\] = \[([^\]]*)\]/)?.[1] ?? '').matchAll(/'([a-z]+)'/g)].map((match) => match[1])
  // R16-H에서 'wiki'가 늘어 여덟이 됐다. 화면 유니온과 addEventListener 배열이 함께 늘지 않으면
  // 서버는 보내는데 화면은 구독하지 않아 프레임이 조용히 버려진다 — 아래 두 deepEqual이 그것을 잡는다.
  assert.equal(serverKinds.length, 8, serverKinds.join(','))
  assert.deepEqual(clientType.sort(), [...serverKinds].sort())
  assert.deepEqual(clientList.sort(), [...serverKinds].sort())
})

test('13. 덮어쓴 내역은 편집 모드에서만 지연 로드되고 0건이면 그리지 않는다', () => {
  assert.match(collaboration, /\/api\/calendar\/events\/\$\{encodeURIComponent\(eventId\)\}\/overwrites/)
  assert.match(collaboration, /if \(!editing \|\| !eventId\) \{ setOverwrites\(null\); return \}/)
  assert.match(connection, /if \(!history \|\| history\.overwrites\.length === 0\) return null/)
  // 목록 응답에 이력을 실으면 GET /api/workspace/calendar-events의 version 계산이 바뀐다.
  assert.equal(collaboration.includes("useWorkspaceState<CalendarEvent[]>('calendar-events'"), true)
})

test('14. 캘린더 상한 문장은 화면과 서버가 한 벌이고 화면은 막지 않는다', () => {
  // 규칙: 미리 알리는 문장과 서버의 거절 문장이 두 벌이면 한쪽만 고쳐져 사람이 다른 말을 두 번 듣는다.
  const sentence = '동기화할 캘린더는 최대 ${MAX_SELECTED_CALENDARS}개까지 고를 수 있습니다.'
  assert.ok(connection.includes(sentence), '화면 문장이 없다')
  assert.ok(calendarSyncServer.includes(sentence), '서버 문장이 없다')
  assert.match(connection, /const MAX_SELECTED_CALENDARS = 10/)
  assert.match(calendarSyncServer, /export const MAX_SELECTED_CALENDARS = 10/)
  // 서버가 자르기 전에 400을 낸다 — 조용히 잘라 저장하면 체크가 스스로 풀린다.
  assert.match(calendarSyncServer, /if \(body\.selected\.length > MAX_SELECTED_CALENDARS\)/)
  // 미리 알리되 막지 않는다: 상한을 넘겨도 '선택 적용' 버튼은 그대로 눌린다.
  assert.match(connection, /onClick=\{applySelection\} disabled=\{busy !== ''\}/)
})

test('15. 서버가 보내는 calendar 프레임에는 받는 쪽이 있다', () => {
  // publish만 있고 소비자가 없으면 브라우저가 프레임을 파싱해 버리는 죽은 배선이 된다.
  assert.match(calendarSyncServer, /eventStream\.publish\?\.\(tenantId, 'calendar'/)
  const slice = schedulePageSlice()
  assert.match(slice, /event\.kind === 'calendar' \|\| event\.kind === 'resync'/)
  // version은 배열 길이가 아니라 다른 publish와 같은 레코드 버전이어야 한다.
  assert.doesNotMatch(calendarSyncServer, /version: nextEvents\.length/)
  assert.match(calendarSyncServer, /version: recordVersion\(/)
})

test('16. 손실 안내는 저장을 막지 않는다 — aria-disabled를 쓰지 않는다', () => {
  // 규칙: aria-disabled는 핸들러가 실제로 거절하는 컨트롤에만 붙인다. 여러 날 일정의 첫날 정보는
  // 여전히 고칠 수 있어야 하므로 문장으로만 알린다.
  assert.match(collaboration, /여러 날에 걸친 구글 일정입니다/)
  assert.match(collaboration, /반복 일정입니다/)
  const dialog = collaboration.slice(collaboration.indexOf('function ScheduleEventDialog('))
  assert.equal(dialog.includes('aria-disabled'), false)
})

test('17. 한 상태에는 한 이름만 있다 — 카드와 관리자 개관이 같은 표를 읽는다', () => {
  // 규칙: 같은 사실을 두 자리가 각자 적으면 사람은 같은 것을 다른 말로 두 번 읽는다
  // (revoked를 카드는 '연결 안 됨', 개관은 '해제됨'이라고 불렀다).
  assert.match(connection, /export const CALENDAR_STATUS_LABELS: Record<string, string> = \{/)
  assert.equal((connection.match(/CALENDAR_STATUS_LABELS/g) ?? []).length, 6, '표 하나를 만들고 다섯 자리에서 읽는다')
  assert.match(connection, /<span>\{CALENDAR_STATUS_LABELS\[row\.status\] \?\? CALENDAR_STATUS_LABELS\.revoked\}<\/span>/)
  assert.doesNotMatch(connection, /row\.status === 'connected' \?/, '개관이 자기 문자열을 다시 적으면 두 벌이 된다')
  // 동의를 마치지 않은 행에는 주소가 없다. 빈 값을 가리면 '숨긴 주소'로 읽힌다.
  assert.match(connection, /\{row\.email \|\| '계정 없음'\}/)
  assert.match(calendarSyncServer, /email: row\.email \? maskEmail\(row\.email\) : '',/)
})

test('18. 스케줄러가 돌린 통과 뒤에도 연결 카드가 스스로 다시 읽는다', () => {
  // 일정 배열만 다시 읽으면 새 일정에 '구글 캘린더와 연결된 일정' 표식이 붙지 않고
  // 마지막 동기화 시각이 화면을 다시 열 때까지 낡은 채로 남는다.
  const slice = schedulePageSlice()
  assert.match(slice, /reloadToken=\{calendarReload\}/)
  assert.match(connection, /reloadToken = 0,/)
  assert.match(connection, /\}, \[workspaceScope, reloadToken\]\)/, 'load가 그 값을 의존성에 넣어야 다시 읽는다')
})

test('19. 서버가 내려보내는 값에는 받는 곳이 있다 — 죽은 필드를 만들지 않는다', () => {
  // counts·syncing은 계산되어 매 응답에 실린다. 화면이 쓰지 않으면 그것은 비용만 있는 거짓 약속이다.
  assert.match(connection, /connection\.counts\.linked > 0/)
  assert.match(connection, /const syncing = busy === 'sync' \|\| status\.syncing/)
  // 0건은 적지 않는다 — '연결된 일정 0건'은 아무것도 알려 주지 않는다.
  assert.match(connection, /\{connection\.counts\.truncated > 0 && ` · 여러 날 일정/)
  assert.match(connection, /연결된 일정 \$\{connection\.counts\.linked\}건/)
  assert.match(connection, /내보낸 업무 마감 \$\{connection\.counts\.workDue\}건/)
  // 아무도 안 쓰는 값은 내려보내지도 않는다. 화면이 받는 요약(publicConnection)에 토큰 수명은 없다.
  assert.equal(connection.includes('tokenExpiresAt'), false)
  const publicSlice = calendarSyncServer.slice(
    calendarSyncServer.indexOf('export function publicConnection('),
    calendarSyncServer.indexOf('const isWritable ='),
  )
  assert.ok(publicSlice.length > 200, 'publicConnection 슬라이스를 찾지 못했다')
  // 주석으로는 이름이 나와도 좋다(왜 안 싣는지가 거기 적혀 있다). 필드로 나오면 안 된다.
  assert.doesNotMatch(publicSlice, /^\s*tokenExpiresAt:/m)
})

test('20. 출처가 막혔다는 안내는 서버가 보낸 사실에서만 나오고 이유마다 문장이 다르다', () => {
  // 클라이언트가 accessRole을 보고 스스로 판단하면 서버가 실제로 무엇을 했는지와 어긋난다.
  // 그리고 사실이 셋이면 문장도 셋이다 — 사라진 캘린더를 '읽기 전용'이라 부르면 없는 권한을 설명하게 된다.
  for (const reason of ['read-only', 'unselected', 'unknown']) {
    assert.ok(collaboration.includes(`overwrites?.sourceBlocked === '${reason}'`), `${reason} 갈래가 없다`)
    assert.match(calendarSyncServer, new RegExp(`return '${reason}'`), `서버가 ${reason}을 내지 않는다`)
  }
  assert.match(collaboration, /읽기 전용 구글 캘린더에서 가져온 일정입니다/)
  // **기억하지 않고 계산한다.** 링크에 새겨 두면 그것을 지우는 자리가 '패치가 통했을 때' 하나뿐이라,
  // 캘린더를 다시 골라 이제는 잘 나가는 일정 옆에서 '보내지 않습니다'라고 계속 말하게 된다.
  assert.match(calendarSyncServer, /sourceBlocked: link\.detachedAt \? '' : remoteWriteBlockOf\(connectionFor\(request\.auth\) \?\? \{\}, link\)/)
  assert.equal(calendarSyncServer.includes('link.sourceBlocked'), false, '막힌 이유를 링크 행에 저장하면 두 번째 사본이 생긴다')
  // 같은 사실을 두 칸에 적지 않는다 — 불리언과 이유가 함께 있으면 주석으로만 일치하게 된다.
  assert.equal(calendarSyncServer.includes('sourceReadOnly'), false, '이유 칸 하나면 충분하다')
  assert.equal(connection.includes('sourceReadOnly'), false)
  // 서버의 한 문장이 카드의 lastError 줄로 그대로 간다(문장을 화면에 두 번 적지 않는다).
  assert.match(calendarSyncServer, /export const CALENDAR_SOURCE_READ_ONLY_MESSAGE = '읽기 전용 캘린더에서 가져온 일정은 구글로 보내지 않습니다\.'/)
  assert.equal(connection.includes('읽기 전용 캘린더에서 가져온 일정은'), false, '서버 문장을 화면이 다시 적으면 두 벌이 된다')
})

test('21. 손실 안내 다섯 문장은 모두 같은 한 마디로 끝난다', () => {
  // 규칙: 화면이 말하는 결과는 서버가 실제로 하는 일과 같아야 한다(하드윈 11).
  // 서버는 이 링크들의 수정도 삭제도 내보내지 않는다. 문장이 '고친 내용'만 말하면
  // 사람은 하루짜리로 보이는 줄을 지우고 구글의 사흘짜리 원본이 사라질 것을 예상하지 못한다.
  const dialog = collaboration.slice(collaboration.indexOf('function ScheduleEventDialog('))
  const notes = dialog.match(/<p className="schedule-sync-note" role="status">[\s\S]*?<\/p>/g) ?? []
  assert.equal(notes.length, 5, `손실 안내가 다섯 갈래여야 한다: ${notes.length}`)
  for (const note of notes) {
    assert.ok(note.includes('여기서 고치거나 지운 내용은 구글로 보내지 않습니다'), `한 마디가 빠졌다: ${note}`)
  }
})

test('22. 원격 쓰기를 막는 판정은 한 함수뿐이고 계획 자리는 전부 그것을 지난다', () => {
  // 규칙 8: 권한 판정은 자기가 주장하는 모든 차원을 실제로 읽어야 하고, 자리마다 적으면 한쪽만 고쳐진다.
  // 실제로 그렇게 됐다 — 읽기 전용 판정이 패치 두 곳에만 붙어 삭제 세 곳은 매 통과 403을 맞았다.
  // 판정은 모듈 함수 하나다 — 통과와 라우트 8(다이얼로그가 읽는 자리)이 같은 것을 부른다.
  assert.equal((calendarSyncServer.match(/export function remoteWriteBlockOf\(connection, link\) \{/g) ?? []).length, 1)
  assert.match(calendarSyncServer, /const blockOf = \(link\) => remoteWriteBlockOf\(connection, link\)/)
  // '내보낼 수 있는 캘린더가 있는가'도 한 함수다 — 새 일정을 만드는 자리와 'no-export' 판정이 같은 값을 읽는다.
  assert.match(calendarSyncServer, /const exportEnabled = Boolean\(exportTargetOf\(connection\)\)/)
  assert.match(calendarSyncServer, /if \(!exportTargetOf\(connection\)\) return 'no-export'/)
  // 계획을 넣는 자리는 planDelete·planPatch 두 함수 안뿐이다.
  const pushes = calendarSyncServer.match(/remoteWrites\.push\(/g) ?? []
  assert.equal(pushes.length, 4, `계획 push 자리가 늘었다: ${pushes.length}`)
  assert.match(calendarSyncServer, /const planDelete = \(link\) => \{[\s\S]*?blockOf\(link\)/)
  assert.match(calendarSyncServer, /const planPatch = \(write\) => \{[\s\S]*?blockOf\(link\)/)
  // 막힌 이유마다 카드 문장이 한 벌씩 있다.
  const table = calendarSyncServer.match(/export const CALENDAR_BLOCK_MESSAGES = Object\.freeze\(\{([\s\S]*?)\}\)/)?.[1] ?? ''
  for (const reason of ['no-export', 'unknown', 'unselected', 'read-only']) {
    assert.ok(table.includes(reason), `${reason} 문장이 표에 없다`)
  }
})

test('23. 콜백 이유 목록은 장식이 아니다 — 핸들러가 실제로 내는 낱말과 같다', () => {
  // 목록을 손으로만 맞춰 두면 새 fail('quota')가 게이트를 전부 통과하고,
  // 사용자는 문장 없는 화면을 본다. 그래서 (1) 핸들러가 목록을 읽고 (2) 시험이 두 집합을 맞춘다.
  assert.match(calendarSyncServer, /CALLBACK_REASONS\.includes\(reason\) \? reason : 'upstream'/)
  const declared = [...(calendarSyncServer.match(/export const CALLBACK_REASONS = Object\.freeze\(\[([^\]]*)\]\)/)?.[1] ?? '').matchAll(/'([a-z]+)'/g)].map((match) => match[1])
  const emitted = [...calendarSyncServer.matchAll(/\bfail(?:AfterExchange)?\('([a-z]+)'/g)].map((match) => match[1])
  assert.ok(emitted.length >= 9, `fail 호출을 찾지 못했다: ${emitted.length}`)
  assert.deepEqual([...new Set(emitted)].sort(), [...declared].sort())
})

test('24. 배경 갱신이 사람이 찍던 체크를 되돌리지 않는다', () => {
  // reloadToken은 같은 회사 누군가의 동기화로도 오른다. load가 선택을 비우면 지금 체크박스를
  // 만지던 사람의 선택이 아무 말 없이 서버 값으로 돌아가고, '선택 적용'은 그대로 눌린다.
  const loadBody = connection.match(/const load = useCallback\(async \(\) => \{[\s\S]*?\n  \}, \[workspaceScope, reloadToken\]\)/)?.[0] ?? ''
  assert.ok(loadBody, 'load 슬라이스를 찾지 못했다')
  assert.equal(loadBody.includes('setSelection('), false, '배경 갱신이 사람의 선택을 지운다')
  // 선택이 정해지는 자리는 저장이 끝난 뒤 하나뿐이다.
  assert.match(connection, /onToast\('동기화할 캘린더를 저장했습니다\.'\)/)
  assert.match(connection, /setSelection\(null\)\n      onToast\('동기화할 캘린더를 저장했습니다\.'\)/)
})

test('25. 끊는 문은 연동키가 없어도 열려 있다', () => {
  // 서버는 해제·기록 삭제에 configured·secretBoxReady를 걸지 않는다. 화면만 감추면 사용자는
  // '사용 불가' 한 줄 앞에서 살아 있는 연결을 끊을 방법이 없다(연결 시작은 그대로 막힌다).
  assert.match(connection, /\{\(!status\.configured \|\| !status\.secretBoxReady\) && connection && connection\.status !== 'revoked' && \(/)
  assert.match(connection, /\{connection && connection\.status === 'revoked' && \(\n\s*<Button[^>]*onClick=\{forget\}/)
  assert.equal((connection.match(/onClick=\{disconnect\}/g) ?? []).length, 2)
  assert.match(calendarSyncServer, /app\.post\('\/api\/integrations\/google\/calendar\/disconnect', \.\.\.guards/)
  // 거두지 못한 허가는 한 문장으로 알린다 — 서버가 사실을 싣고 화면이 그 한 벌을 붙인다.
  assert.match(calendarSyncServer, /response\.json\(\{ removedLinks: links\.length - kept\.length, hadToken, revoked \}\)/)
  assert.match(connection, /export const CALENDAR_MANUAL_REVOKE_MESSAGE = /)
  assert.match(connection, /const withRevokeNote = \(message: string, body: \{ hadToken\?: boolean; revoked\?: boolean \}\)/)
  assert.equal((connection.match(/withRevokeNote\(/g) ?? []).length, 2, '해제와 기록 삭제가 같은 한 문장을 쓴다')
})

test('26. 캘린더 목록은 얼어붙지 않는다 — 새로 고침 손잡이가 화면에도 서버에도 있다', () => {
  // 목록이 연결 시점의 사본으로 굳으면 구글에서 새로 만든 캘린더는 영원히 고를 수 없고,
  // 되돌리는 길은 '연결 해제 → 다시 연결'뿐이다.
  assert.match(calendarSyncServer, /app\.post\('\/api\/integrations\/google\/calendar\/calendars\/refresh', \.\.\.guards/)
  assert.match(calendarSyncServer, /export const CALENDAR_LIST_REFRESH_MS = /)
  assert.match(calendarSyncServer, /forceCalendarList \|\| now\.getTime\(\) - listedAt >= CALENDAR_LIST_REFRESH_MS/)
  assert.match(connection, /캘린더 목록 새로 고침/)
  assert.match(connection, /const refreshCalendars = async \(\) => \{[\s\S]*?method: 'POST'/)
  // 갱신은 사용자의 선택 위에 얹는다 — 통과가 쥔 옛 선택으로 덮으면 그 사이 누른 '선택 적용'이 사라진다.
  assert.match(calendarSyncServer, /normalizeCalendars\(calendarItems, \{ previous: rows\[at\]\.calendars \?\? \[\] \}\)/)
})

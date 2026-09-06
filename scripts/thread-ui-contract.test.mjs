import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

/**
 * 스레드 화면 계약(설계서 J절 §4·§7).
 *
 * 브라우저 스모크는 사람이 하지만, 여기서 잠그는 것은 문장으로 되돌아오지 않는 것들이다.
 *  - 답글이 본채널로 새는 길 여섯 개가 전부 같은 배열(channelMessages)에서 나온다.
 *  - '답글 0개'를 그리지 않는다(가짜 0).
 *  - 스레드에서 나가는 길이 화면에 늘 있다(닫기·대화로).
 *  - 새 컴포저도 한글 조합 가드를 쓴다.
 *  - 게스트 계약이 글자 그대로 고정한 세 줄을 스레드가 건드리지 않았다.
 */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const collaboration = await read('src/components/CollaborationSuite.tsx')
const collaborationCss = await read('src/components/CollaborationSuite.css')
const messengerExtras = await read('src/components/MessengerExtras.tsx')
const threadPanel = await read('src/components/ThreadPanel.tsx')
const threadServer = await read('server/messenger-threads.mjs')
const notificationCenter = await read('src/components/NotificationCenter.tsx')
const originBadge = await read('src/components/OriginBadge.tsx')

const count = (source, pattern) => (source.match(pattern) ?? []).length

test('본채널이 보는 배열은 한 벌뿐이다 — 답글이 새는 길 일곱 개가 모두 여기서 나온다', () => {
  assert.equal(
    count(collaboration, /const channelMessages = selectedConversation\.messages\.filter\(\(item\) => !item\.threadRootId\)/g),
    1,
    '술어가 여러 벌이 되면 어딘가 한 곳으로 답글이 샌다',
  )
  // 파생 일곱: 창·숨은 건수·고정 스트립·방 안 검색·미읽음·점프 계산·딥링크의 창 넓히기.
  assert.match(collaboration, /const visibleMessages = channelMessages\.slice\(/)
  assert.match(collaboration, /const hiddenMessageCount = Math\.max\(0, channelMessages\.length - visibleMessages\.length\)/)
  assert.match(collaboration, /\.map\(\(id\) => channelMessages\.find\(/, '고정 스트립도 본채널에서만 찾는다')
  assert.match(collaboration, /const roomSearchMatches = [\s\S]{0,80}\? channelMessages/)
  assert.match(collaboration, /const rows = conversation\.messages\.filter\(\(item\) => !item\.threadRootId\)/, '미읽음도 본채널만 센다')
  assert.match(collaboration, /const index = channelMessages\.findIndex\(\(item\) => item\.id === messageId\)/)
  // 딥링크는 방을 막 바꾼 순간이라 channelMessages를 쓸 수 없다(그 값은 이전 방의 것이다).
  // 그래도 세는 배열은 본채널이어야 한다 — visibleCount가 잘리는 배열과 같은 것이 아니면 창이 헛돈다.
  assert.match(collaboration, /const mainMessages = \(room\?\.messages \?\? \[\]\)\.filter\(\(item\) => !item\.threadRootId\)/)
  assert.match(collaboration, /Math\.max\(current, mainMessages\.length - index \+ 10\)/)
  assert.doesNotMatch(collaboration, /room\.messages\.length - index/, '답글이 섞인 길이로 창을 넓히지 않는다')
})

test('스레드 안에서 걸린 검색 결과는 점프가 아니라 스레드를 연다', () => {
  assert.match(collaboration, /const threadSearchMatches = /)
  assert.match(collaboration, /if \(target\?\.threadRootId\) \{ void openThread\(target\.threadRootId\)/)
  assert.match(messengerExtras, /threadMatches\?: /)
  assert.match(messengerExtras, /onOpenThread\?: \(rootId: string\) => void/)
})

test('답글 0이면 요약 줄을 그리지 않는다 — 가짜 0을 만들지 않는다', () => {
  // 루트가 지워져도 요약 줄은 남는다(!removed를 조건에 두지 않는다) — 답글은 다른 사람의 말이고,
  // 여기가 그 스레드로 가는 유일한 문이다. 세는 것은 언제나 답글 수 하나뿐이다.
  assert.match(collaboration, /!inThread && !item\.threadRootId && \(item\.replyCount \?\? 0\) > 0 &&/)
  assert.doesNotMatch(collaboration, /답글 0개/)
  // 패널 헤더의 개수도 0에서는 그리지 않는다. 문자열 보간이라 리터럴 검사로는 잡히지 않으므로 조건을 잠근다.
  assert.match(collaboration, /thread && thread\.replies\.length > 0 \? ` · 답글 \$\{thread\.replies\.length\}개` : ''/)
  // 요약 줄의 숫자는 언제나 값에서 나온다. 리터럴로 적힌 개수는 화면에 없다(주석은 논외).
  assert.match(threadPanel, /답글 \{replyCount\}개/)
  assert.doesNotMatch(threadPanel.replace(/\/\*[\s\S]*?\*\//g, ''), /답글 \d+개/)
})

test('답장은 자기 칸의 컴포저를 겨눈다 — 스레드에서 누른 답장이 본채널로 새지 않는다', () => {
  assert.match(
    collaboration,
    /onReply=\{inThread\s*\?\s*\(\) => \{ setThreadReplyTo\(item\); threadComposerRef\.current\?\.focus\(\) \}\s*:\s*\(\) => \{ setReplyTo\(item\); composerRef\.current\?\.focus\(\) \}\}/,
  )
  // 스레드 컴포저에도 자기 답장 줄이 있다. 안 그러면 무엇을 인용 중인지 화면에 없다.
  const drawer = collaboration.slice(collaboration.indexOf('<form className="messenger-composer messenger-thread-composer"'))
  const form = drawer.slice(0, drawer.indexOf('</form>'))
  assert.match(form, /\{threadReplyTo && \(/)
  assert.match(form, /aria-label="답장 취소"/)
  // 보낼 때도 칸을 따라간다 — 스레드의 인용은 스레드 안만 가리킨다(서버가 다시 판정한다).
  assert.match(collaboration, /\(inThread \? threadReplyTo : replyTo\)/)
  // 나가는 길과 보낸 뒤 양쪽에서 지워진다. 남아 있으면 다음 답글이 엉뚱한 말을 인용한다.
  const close = collaboration.slice(collaboration.indexOf('const closeThread = () => {'))
  assert.match(close.slice(0, close.indexOf('\n  }')), /setThreadReplyTo\(null\)/, 'closeThread가 인용 대상도 함께 지운다')
  assert.match(collaboration, /setThreadMessage\(''\)\s+setThreadReplyTo\(null\)\s+await refreshThread/, '보낸 뒤에도 지운다')
})

test('같은 루트가 두 칸에 그려져도 편집 상자는 한 곳에만 열린다', () => {
  assert.match(collaboration, /const isEditing = editing\?\.id === item\.id && editing\.inThread === inThread/)
  assert.match(collaboration, /useState<\{ id: string; text: string; inThread: boolean \} \| null>/)
  // primary('저장')가 두 개 서는 길은 이 조건 하나로 닫힌다 — 정적 슬라이스 검사로는 보이지 않는다.
  assert.match(collaboration, /\{isEditing \? \(/)
  assert.match(collaboration, /\{!removed && !isEditing && \(/)
})

test('스레드에서 나가는 길이 화면에 늘 있다', () => {
  assert.match(collaboration, /<aside className="messenger-thread"/)
  assert.match(collaboration, /aria-label="스레드 닫기"/)
  assert.match(collaboration, /aria-label="대화로"/)
  assert.match(messengerExtras, /aria-label="스레드 열기"/)
  // 헤더가 스크롤과 함께 사라지면 나갈 길이 없다.
  const header = collaborationCss.slice(collaborationCss.indexOf('.messenger-thread-header {'))
  assert.match(header.slice(0, header.indexOf('}')), /flex: 0 0 auto/)
  // 승격 세 단추는 줄지 않는다. 넷을 한 줄에 세우면 360px 칸에서는 제목이 3px로 눌리고
  // 375px에서는 닫기가 뷰포트 밖으로 나간다 — 폭과 무관한 한 벌로 승격만 둘째 줄에 세운다.
  assert.match(header.slice(0, header.indexOf('}')), /flex-wrap: wrap/)
  assert.match(collaborationCss, /\.messenger-thread-promotions \{ order: 1; width: 100%;/)
  assert.match(collaborationCss, /\.messenger-thread-header > \.ui-icon-button \{ margin-left: auto; \}/, '닫기는 어떤 폭에서도 첫 줄 오른쪽 끝이다')
})

test('좁은 화면에서 스레드는 채널 위가 아니라 채널 대신 선다', () => {
  assert.match(collaboration, /useState<MessengerPane>/)
  assert.match(collaboration, /mobilePane === 'thread' \? 'show-thread'/)
  assert.match(collaboration, /threadRootId \? 'has-thread' : ''/)
  assert.match(collaborationCss, /\.messenger-drawer\.has-thread \{ width: min\(1240px/)
  assert.match(collaborationCss, /\.messenger-drawer\.show-thread :is\(\.messenger-sidebar, \.messenger-chat\) \{ display: none; \}/)
})

test('패널이 서는 조건과 반 칸씩 갈아 끼우는 클래스의 조건이 하나다', () => {
  // 둘이 갈라지면 휴대폰에서 목록·채널이 숨은 채 패널만 아직 없는 순간이 생긴다 — 나갈 길 없는 빈 서랍이다.
  assert.match(collaboration, /\{threadRootId && \(\s+<aside className="messenger-thread"/)
  assert.match(collaboration, /className="messenger-thread-loading"/, '아직 못 받았으면 그 사실을 한 줄로 말한다')
})

test('목록 접기는 세 열이 설 수 있는 폭에서만 일어난다', () => {
  // 1271px 접기가 휴대폰까지 걸리면 show-list + has-thread에서 목록·채널·스레드가 모두 숨는다.
  assert.match(collaborationCss, /@media \(min-width: 721px\) and \(max-width: 1271px\) \{/, '세 열을 밀어 넣을 자리가 없으면 목록을 접는다')
  assert.doesNotMatch(collaborationCss, /@media \(max-width: 1271px\)/)
  const collapse = collaborationCss.slice(collaborationCss.indexOf('@media (min-width: 721px) and (max-width: 1271px) {'))
  assert.match(collapse.slice(0, collapse.indexOf('\n}')), /\.messenger-drawer\.has-thread \.messenger-sidebar \{ display: none; \}/)
})

test('게스트 임베드는 스레드를 열어도 담은 칸 밖으로 나가지 않는다', () => {
  // .has-thread(0,2,0)가 .is-embedded(0,2,0)보다 뒤에 있어 폭 싸움에서 이긴다 — 여기서 되돌린다.
  const widen = collaborationCss.indexOf('.messenger-drawer.has-thread { width: min(1240px')
  const restore = collaborationCss.indexOf('.messenger-drawer.is-embedded.has-thread { width: 100%; }')
  assert.ok(restore > widen, '임베드 폭 복원은 넓히는 규칙보다 뒤에 있어야 이긴다')
  // 임베드의 폭은 뷰포트가 아니라 담은 칸이 정한다. 미디어 쿼리가 볼 수 없으므로 두 열로 세운다.
  assert.match(collaborationCss, /\.messenger-drawer\.is-embedded\.has-thread \.messenger-layout \{ grid-template-columns: minmax\(0, 1fr\) 320px; \}/)
  assert.match(collaborationCss, /\.messenger-drawer\.is-embedded\.has-thread \.messenger-sidebar \{ display: none; \}/)
})

test('새 컴포저도 한글 조합 중의 Enter를 삼키지 않는다', () => {
  assert.ok(
    count(collaboration, /event\.nativeEvent\.isComposing/g) >= 3,
    '본채널 컴포저·편집 상자·스레드 컴포저가 모두 같은 가드를 쓴다',
  )
  assert.match(collaboration, /placeholder="이 스레드에 답글 쓰기"/)
})

test('게스트 계약이 글자 그대로 고정한 세 줄을 스레드가 건드리지 않았다', () => {
  assert.match(collaboration, /canEdit=\{mine && !readOnlyRooms\}/)
  assert.match(collaboration, /canPin=\{!readOnlyRooms\}/)
  assert.match(collaboration, /useOverlayFocus\(open && !embedded, onClose\)/)
})

test('답글에는 고정 단추가 없다 — 서버가 언제나 409로 되돌리는 자리다', () => {
  // canPin은 '사람의 자격'이고 pinnable은 '말의 자격'이다. 게스트 계약이 글자 그대로 고정한
  // canPin 줄을 건드리지 않고, 그 아래 한 줄로 답글만 뺀다.
  assert.match(collaboration, /pinnable=\{!item\.threadRootId\}/)
  assert.match(messengerExtras, /\{canPin && pinnable && <IconButton/)
  assert.match(messengerExtras, /pinnable\?: boolean/)
})

test('스레드를 방 밖으로 올리는 네 단추가 같은 조건으로 켜지고, 올린 뒤에는 그렇게 말한다', () => {
  // 셋은 켜져 있는데 하나만 꺼져 있으면, 같은 전제(살아 있는 답글)에 답이 둘이 된다 —
  // 서버는 넷 모두를 THREAD_EMPTY로 되돌린다.
  assert.equal(
    count(collaboration, /disabled=\{!thread \|\| thread\.liveReplyCount === 0 \|\| threadPending\}/g),
    2,
    '승격 세 단추와 [채널에 공유]가 한 문장을 나눠 쓴다',
  )
  // 올린 기억으로 막지는 않는다. 업무·자료는 서버가 두 번째를 허용하므로, 새로고침으로 되살릴 수 없는
  // 값으로 화면이 그 행동을 금지하면 사람은 '패널을 닫았다 열기'라는 우회로를 배운다.
  assert.doesNotMatch(collaboration, /disabled=\{done \|\|/)
  assert.match(collaboration, /const done = \(threadPromoted\[threadRootId\] \?\? \[\]\)\.includes\(kind\)/)
  assert.match(collaboration, /\{done \? doneLabel : label\}/, '막는 대신 낱말이 바뀐다')
  assert.match(collaboration, /promotion\?\.duplicates && \(threadPromoted\[rootId\] \?\? \[\]\)\.includes\(kind\)/, '이미 올린 갈래는 두 번째 누름에서 한 번 되묻는다')
  assert.match(collaboration, /\{ kind: 'decision', label: '결정으로', doneLabel: '결정으로 올림', duplicates: false \}/, '결정만 서버가 409로 막으므로 되묻지 않는다')
  assert.match(collaboration, /setThreadPromoted\(\{\}\)/, '스레드를 닫으면 그 기억도 사라진다 — 판정하는 쪽은 서버다')
})

test('승격 세 갈래의 공개 범위가 같지 않다는 사실을 화면이 말한다', () => {
  // 넓이 순서는 자료 > 업무 > 결정이다.
  //  - 업무: ownerId·requesterId가 올린 사람이고 tenant-member 필터가 isMemberWorkItem이라 올린 사람 + 관리자.
  //  - 결정: /api/proposals가 requireTenantAdmin이라 관리자만.
  //  - 자료: restricted 명단(방 사람들 ∪ 올린 사람) + canReadDocument가 통과시키는 관리자 전원.
  // 문장이 이 순서를 뒤집으면, 내용을 방 안에 두려는 사람이 가장 넓은 갈래를 고른다 — 그래서 잠근다.
  const sentence = collaboration.match(/const THREAD_PROMOTION_SCOPE_NOTICE = '([^']+)'/)?.[1]
  assert.ok(sentence, '공개 범위 문장은 상수 한 곳에 있다')
  assert.match(sentence, /^업무로 올리면 나와 관리자에게, 결정으로 올리면 관리자에게 보입니다\./)
  assert.match(sentence, /자료로 올리면 이 방의 사람들\(외부 게스트 포함\)과 관리자에게 열립니다\.$/)
  assert.doesNotMatch(sentence, /회사 구성원 전체/, '업무·결정은 전사 공개가 아니다 — 서버가 그렇게 하지 않는다')
  assert.doesNotMatch(sentence, /이 방의 사람들에게만/, '자료도 관리자에게는 열린다 — "만"이 틀린 낱말이다')
  assert.match(collaboration, /\{!readOnlyRooms && thread && \(\s*<p className="messenger-thread-note">/)
  assert.match(collaborationCss, /\.messenger-thread-note \{/)
})

test('답글이 전부 지워지면 왜 거절하는지를 그 자리에서 말한다', () => {
  // 헤더는 tombstone까지 세고(본채널 요약과 같은 수) 단추 넷은 살아 있는 답글로 켜고 끈다.
  // 두 수가 갈리는 순간이 실제로 있으므로, 수만 적어 놓고 말없이 거절하지 않게 문장을 붙인다.
  assert.match(collaboration, /const THREAD_ALL_REPLIES_DELETED_NOTICE = '남아 있는 답글이 없어/)
  assert.match(
    collaboration,
    /thread\.liveReplyCount === 0 && thread\.replies\.length > 0\s*\n\s*\? THREAD_ALL_REPLIES_DELETED_NOTICE\s*\n\s*: THREAD_PROMOTION_SCOPE_NOTICE/,
    '단추를 끄는 조건과 문장을 세우는 조건이 글자 그대로 같다',
  )
})

test('스레드 헤더는 어떤 방 이름에서도 첫 줄에 닫기를 남긴다', () => {
  // flex-wrap이 켜져 있으면 줄바꿈이 flex-shrink보다 먼저 일어난다. 제목의 basis가 auto면
  // nowrap 방 이름의 max-content 폭이 그대로 가정 폭이 되어 제목이 통째로 둘째 줄로 밀린다.
  assert.match(collaborationCss, /\.messenger-thread-header \{[\s\S]*?flex-wrap: wrap;/)
  assert.match(collaborationCss, /\.messenger-thread-header > div:not\(\.messenger-thread-promotions\) \{ flex: 1 1 0; \}/)
  assert.match(collaborationCss, /\.messenger-thread-header > \.ui-icon-button \{ margin-left: auto; \}/)
  assert.match(collaborationCss, /\.messenger-thread-promotions \{ order: 1; width: 100%;/)
})

test('열려 있는 스레드는 SSE 한 번 실패로 닫히지 않는다 — 초안은 사람의 것이다', () => {
  // refreshThread는 SSE 틱마다 돈다. 서버 재시작 한 번에 패널이 닫히면 쓰던 답글이 함께 사라진다.
  assert.match(collaboration, /const refreshThread = async \(rootId: string, conversationId = selectedConversation\.id, \{ closeOnFailure = false \} = \{\}\) =>/)
  assert.match(collaboration, /const fail = \(text: string\) => \{\s*\n\s*if \(closeOnFailure\) closeThread\(\)/, '두 실패 갈래가 한 문장을 나눠 쓴다')
  assert.match(collaboration, /await refreshThread\(rootId, conversationId, \{ closeOnFailure: true \}\)/, '여는 순간에만 닫는다')
  assert.equal(count(collaboration, /void refreshThread\(threadRootId\)/g), 1)
  assert.doesNotMatch(collaboration, /\n\s*closeThread\(\)\n\s*onToast\('스레드를 불러오지 못했습니다\.'\)/)
})

test('본채널로 가는 점프는 휴대폰에서 본채널을 먼저 세운다', () => {
  // 스레드 패널이 화면을 덮고 있으면 본채널은 display:none이라 scrollIntoView가 아무 일도 하지 않는다.
  const jump = collaboration.slice(collaboration.indexOf('const jumpToMessage = (messageId: string) => {'))
  assert.match(
    jump.slice(0, jump.indexOf('\n  }')),
    /if \(target\?\.threadRootId\)[\s\S]*?setMobilePane\(\(current\) => \(current === 'thread' \? 'chat' : current\)\)/,
    '스레드로 가는 갈래가 먼저 빠져나간 뒤에만 pane을 되돌린다',
  )
})

test('지워진 루트의 스레드는 컴포저 대신 서버와 같은 문장을 그린다', () => {
  // 읽기는 열리는데 쓰기만 거절되는 유일한 갈래다. 컴포저를 켜 두면 눈앞에 열린 스레드를 두고 거절 문장을 받는다.
  const screen = collaboration.match(/const THREAD_ROOT_DELETED_NOTICE = '([^']+)'/)?.[1]
  const server = threadServer.match(/ROOT_DELETED: \{ code: 'THREAD_ROOT_DELETED', message: '([^']+)' \}/)?.[1]
  assert.ok(screen, '화면은 그 문장을 상수 한 곳에 둔다')
  assert.equal(screen, server, '사전 안내와 서버의 거절이 한 벌이다 — 한 사실에 한 문장')
  assert.match(collaboration, /\{thread\?\.root\.deletedAt \? \(/)
  assert.match(collaboration, /className="messenger-thread-note is-blocked">\{THREAD_ROOT_DELETED_NOTICE\}/)
})

test('스레드 컴포저도 본채널과 같은 문장으로 막는다', () => {
  // sendMessage가 !activeConversation에서 조용히 되돌아가므로 그 사실이 disabled에 적혀 있어야 한다.
  assert.match(collaboration, /aria-label="답글 보내기" disabled=\{!activeConversation \|\| !threadMessage\.trim\(\) \|\| threadSending\}/)
})

test('공지 보드로 갈아 끼울 때 옆 칸의 스레드도 함께 닫힌다', () => {
  const board = collaboration.slice(collaboration.indexOf('const openNoticeBoard = () => {'))
  assert.match(board.slice(0, board.indexOf('\n  }')), /closeThread\(\)/, '보드 옆에 다른 방의 스레드가 서 있으면 안 된다')
})

test('늦게 온 스레드 응답이 방금 연 스레드를 덮어쓰지 않는다', () => {
  assert.match(collaboration, /const threadRootIdRef = useRef<string \| null>\(null\)/)
  assert.match(collaboration, /if \(data\?\.root\?\.id !== rootId \|\| threadRootIdRef\.current !== rootId\) return/)
})

test('메신저 표면의 기본 행동은 여전히 하나 — 승격·공유는 quiet과 secondary다', () => {
  const drawer = collaboration.slice(collaboration.indexOf('<aside className="messenger-thread"'))
  const panel = drawer.slice(0, drawer.indexOf('</aside>'))
  assert.doesNotMatch(panel, /tone="primary"/, '스레드 패널 안에 기본 행동을 하나 더 두지 않는다')
  // 서버가 THREAD_EMPTY를 판정하는 수(살아 있는 답글)로 켜고 끈다 — 켜져 있는데 누르면 409가 나는 자리를 만들지 않는다.
  assert.match(panel, /tone="secondary" size="sm" disabled=\{!thread \|\| thread\.liveReplyCount === 0/, '답글이 없으면 공유할 결론도 없다')
  // 공유 대화상자 안에서만 그 대화상자의 primary가 하나 있다.
  const dialog = messengerExtras.slice(messengerExtras.indexOf('export function ThreadShareDialog'))
  assert.equal(count(dialog, /tone="primary"/g), 1)
  assert.match(dialog, /placeholder="무엇을 정했는지 한두 줄로 적어 주세요\."/)
  assert.doesNotMatch(dialog, /useState\(rootText\)|useState\(lastReply/, '요약 칸을 채워 두면 사람은 그대로 보낸다 — 그건 요약이 아니라 복사다')
})

test('갈 곳 없는 인용은 단추가 아니다', () => {
  // ThreadShareDialog의 미리보기에는 onJump가 없다. 그래도 button이면 키보드·스크린리더에게
  // "원문으로 이동"이라고 알려 주고는 아무 일도 하지 않는 초점 자리가 생긴다.
  assert.match(messengerExtras, /if \(!onJump\) return <div className="messenger-quote is-static">\{body\}<\/div>/)
  assert.match(collaborationCss, /\.messenger-quote\.is-static \{ cursor: default; \}/)
  // 패널 안에서 같은 스레드를 가리키는 인용도 마찬가지다. 패널 말풍선은 ref를 달지 않고(점프의 목적지는
  // 언제나 본채널이다), 375px show-thread에서는 그 본채널 열이 아예 display:none이다.
  // 비교 대상은 열려 있는 스레드의 루트여야 한다 — item.threadRootId로 재면 패널의 루트에서
  // undefined === undefined가 참이 되어, 본채널에 멀쩡히 있는 인용까지 갈 곳 없는 문장이 된다.
  assert.match(
    collaboration,
    /const quotedInThread = inThread && Boolean\(quoted\) && \(quoted!\.threadRootId === threadRootId \|\| quoted!\.id === threadRootId\)/,
  )
  assert.match(collaboration, /onJump=\{quotedInThread \? undefined : \(\) => jumpToMessage\(quoted\.id\)\}/)
})

test('읽음 표시는 본채널의 것이다 — 답글에는 붙이지 않는다', () => {
  // /read가 본채널 메시지만 찍으므로(app.mjs) 답글의 readBy에는 보낸 사람뿐이다.
  assert.match(collaboration, /const receipts = item\.threadRootId \? '' : readCountFor\(item\)/)
  assert.match(collaboration, /\{receipts && <small>\{receipts\}<\/small>\}/)
})

test('본채널이 바닥으로 따라 내려가는 것도 본채널 길이로만 정한다', () => {
  assert.match(collaboration, /\}, \[open, selectedId, channelMessages\.length\]\)/)
})

test('새 알림 유형과 출처 배지가 화면 사전에 등록돼 있다', () => {
  assert.match(notificationCenter, /\| 'thread-reply'/)
  assert.match(notificationCenter, /'thread-reply': MessagesSquare,/)
  assert.match(notificationCenter, /'thread-reply': 'violet',/)
  assert.match(originBadge, /kind === 'thread' \? MessagesSquare/)
})

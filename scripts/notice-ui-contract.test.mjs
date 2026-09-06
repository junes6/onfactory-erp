import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { canJudgeMissingNotice } from '../src/utils/noticeFocus.ts'

/**
 * 공지 화면 계약(설계서 D절 §2·§7).
 *
 * 브라우저 스모크는 사람이 하지만, 여기서 잠그는 것은 문장으로 되돌아오지 않는 것들이다.
 *  - 낱말 하나에 뜻 하나: '공지'는 NTC 게시글만, 말풍선 핀은 '고정'이다.
 *  - 화면당 기본 행동 하나: NoticeCenter의 tone="primary"는 두 대화상자 footer에만 있다.
 *  - 본문은 텍스트 노드로만 그린다: dangerouslySetInnerHTML이 없다.
 *  - 화면이 만드는 명단과 서버의 기본 대상 집합이 같다: 작성자 본인을 뺀다.
 *  - 딥링크는 클릭보다 나중에 도착한 목록에서만 "없다"를 판정한다(그 규칙만 순수 함수로 떼어 직접 돌린다).
 */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const noticeCenter = await read('src/components/NoticeCenter.tsx')
const noticeCss = await read('src/components/NoticeCenter.css')
const collaboration = await read('src/components/CollaborationSuite.tsx')
const collaborationCss = await read('src/components/CollaborationSuite.css')
const messengerExtras = await read('src/components/MessengerExtras.tsx')
const notificationCenter = await read('src/components/NotificationCenter.tsx')
const app = await read('src/App.tsx')
const noticesServer = await read('server/notices.mjs')
const messengerRooms = await read('server/messenger-rooms.mjs')

test("낱말 하나에 뜻 하나 — 말풍선을 붙박아 두는 일은 '고정'이고 '공지'가 아니다", () => {
  assert.match(messengerExtras, /aria-label=\{pinned \? '고정 해제' : '고정'\}/)
  assert.doesNotMatch(messengerExtras, /공지로 고정/)
  assert.match(collaboration, /aria-label="고정된 메시지"/)
  assert.doesNotMatch(collaboration, /고정된 공지|공지로 고정했습니다/)
  // 주석도 사전을 따른다 — 주석이 다른 낱말을 쓰면 다음 사람이 그 낱말로 코드를 짠다.
  assert.doesNotMatch(collaborationCss, /고정된 공지|공지로 고정/)
  assert.doesNotMatch(messengerExtras, /공지방/)
  // 서버 주석도 같은 사전을 쓴다 — 낱말이 서버에서만 옛말로 남으면 다음 사람이 그 낱말로 코드를 짠다.
  assert.doesNotMatch(messengerRooms, /공지방|고정\(공지\)/)
})

test('.messenger-chat은 flex다 — 공지 스트립이 붙어도 스크롤은 메시지 영역 하나에만 있다', () => {
  const block = collaborationCss.slice(collaborationCss.indexOf('.messenger-chat {'))
  const body = block.slice(0, block.indexOf('}'))
  assert.match(body, /display: flex/)
  assert.doesNotMatch(body, /grid-template-rows: auto minmax\(0, 1fr\) auto/)
})

test('NoticeCenter의 문장과 빈 상태 — 가짜 0을 만들지 않는다', () => {
  for (const phrase of ['확인했습니다', '아직 공지가 없습니다', '모두 확인했습니다.']) {
    assert.ok(noticeCenter.includes(phrase), `${phrase}가 없다`)
  }
  assert.doesNotMatch(noticeCenter, /확인 0\/0|대상 0명/)
  // 본문은 텍스트 노드로만 그린다(줄바꿈은 CSS white-space가 살린다).
  assert.doesNotMatch(noticeCenter, /dangerouslySetInnerHTML/)
})

test('화면당 기본 행동은 하나 — tone="primary"는 두 대화상자 footer에만 있다', () => {
  assert.equal((noticeCenter.match(/tone="primary"/g) ?? []).length, 2)
  // 스트립·보드의 카드에는 primary가 없다. 목록 안의 버튼이 기본 행동이 되면 화면에 기본이 여럿이 된다.
  const beforeDialogs = noticeCenter.slice(0, noticeCenter.indexOf('export function NoticeComposerDialog'))
  assert.doesNotMatch(beforeDialogs, /tone="primary"/)
})

test('확인 명단 대화상자의 바닥도 몸통과 같은 state를 지난다 — 안 온 명단으로 "모두 확인했습니다"라고 하지 않는다', () => {
  // openNoticeAcks는 열 때마다 명단을 {confirmed: [], unconfirmed: []}로 비우고 state를 'loading'으로
  // 되돌린다. 바닥이 길이만 보면 열 때마다 '명단을 불러오는 중입니다.' 바로 아래에 '모두 확인했습니다.'가
  // 붙고, 실패하면 그 두 문장이 나란히 굳는다 — 게다가 그 자리를 <p>가 차지해 '다시 알림'이 사라진다.
  assert.match(noticeCenter, /\{state === 'ready' && \(list\.unconfirmed\.length === 0\s*\?\s*<p className="messenger-notice-allclear">모두 확인했습니다\.<\/p>/)
  assert.match(collaboration, /setNoticeAcks\(\{ confirmed: \[\], unconfirmed: \[\] \}\)/)
})

test('보관한 필독에는 확인 명단·다시 알림 버튼을 그리지 않는다 — 서버가 409로 거절할 자리다', () => {
  // 보관함 탭에서도 카드는 그대로 그려진다. mustRead만 보면 눌리는 버튼이 남고, 그 알림을 받은 사람은
  // 목록에 없는 공지를 확인하라는 문장을 읽는다(ack는 409, 목록은 빈 배열).
  assert.match(noticeCenter, /notice\.mustRead && !notice\.archivedAt && <Button tone="quiet" size="sm" onClick=\{onOpenAcks\}/)
  assert.match(noticeCenter, /notice\.mustRead && !notice\.archivedAt && <Button tone="quiet" size="sm" disabled=\{busy\} onClick=\{onRemind\}/)
  // 서버도 두 라우트가 한 문장을 쓴다(ack·remind가 같은 상수를 본다).
  assert.equal((noticesServer.match(/error: ARCHIVED/g) ?? []).length, 2)
})

test('컴포저의 확인 대상은 작성자 본인을 뺀다 — 서버의 기본 대상 집합과 같은 사람들이다', () => {
  assert.match(noticeCenter, /currentUserId: string/)
  assert.match(noticeCenter, /roster\.filter\(\(person\) => person\.id !== currentUserId\)/)
  assert.match(collaboration, /currentUserId=\{currentUserId\}/)
  // 낱말도 실제와 맞춘다: 이 목록은 '볼 수 있는 사람'이 아니라 '확인 기록을 남길 사람'이다.
  assert.match(noticeCenter, /확인 대상 \{audience\.length - excluded\.length\}명/)
})

test('사람 이름을 못 찾아도 계정 id를 그대로 노출하지 않는다', () => {
  assert.match(noticeCenter, /export const UNKNOWN_PERSON_NAME = '퇴사한 계정'/)
  assert.match(noticeCenter, /\?\? \{ id, name: UNKNOWN_PERSON_NAME \}/)
  assert.doesNotMatch(noticeCenter, /\?\? \{ id, name: id \}/)
})

test('본문 한도는 화면이 숫자로만 말한다 — 문장은 서버 한 곳에서만 짓는다', () => {
  assert.match(noticeCenter, /const overLimit = body\.length > MAX_NOTICE_BODY/)
  assert.match(noticeCenter, /disabled=\{!canSubmit\}/)
  assert.doesNotMatch(noticeCenter, /한도를 넘|너무 깁니다/)
  // 쿨다운 문구도 서버 message를 그대로 쓴다. 화면이 분을 다시 세면 두 문장이 갈라진다.
  assert.doesNotMatch(collaboration, /분 뒤에 다시 보낼 수 있습니다/)
})

test('본문 상한 숫자는 화면과 서버가 같다 — 어긋나면 막지 않은 글이 400으로 되돌아온다', () => {
  const pick = (source, name) => source.match(new RegExp(`export const ${name} = ([0-9_]+)`))?.[1]
  assert.equal(pick(noticeCenter, 'MAX_NOTICE_BODY'), pick(noticesServer, 'MAX_NOTICE_BODY'))
  assert.equal(pick(noticesServer, 'MAX_NOTICE_BODY'), '20_000')
  // 제목 상한은 화면에 소비자가 없다 — 쓰지 않는 사본을 두면 서버 값이 바뀔 때 조용히 어긋난 채 남는다.
  assert.equal(pick(noticeCenter, 'MAX_NOTICE_TITLE'), undefined)
})

test('딥링크는 focusId 한 문자열로 가고, onNavigate 시그니처는 그대로 두 인자다', () => {
  assert.match(noticeCenter, /export function parseMessengerFocus/)
  assert.match(noticeCenter, /event\.nativeEvent\.isComposing/)
  // 규약을 읽는 함수는 여전히 한 벌(NoticeCenter)이고, 부르는 자리만 늘어난다.
  // R16-J에서 업무 출처 배지(스레드에서 승격)가 두 번째 호출부가 됐다 — 'messenger'는 industryRoutes에
  // 없어 navigate로는 토스트로 끝나므로, 여기서도 서랍을 그 자리에 여는 같은 갈래를 탄다.
  assert.equal((app.match(/parseMessengerFocus\(focusId\)/g) ?? []).length, 2)
  assert.match(app, /const openWorkOrigin = \(originPage: string, focusId: string\) => \{[\s\S]{0,400}?originPage === 'messenger' \? parseMessengerFocus\(focusId\) : null/)
  assert.equal((app.match(/hit\.kind === 'notice'/g) ?? []).length, 1)
  assert.match(notificationCenter, /onNavigate: \(page: string, focusId: string\) => void/)
})

test('닫은 사이에 올라온 공지의 딥링크 — 지난 목록으로는 "없다"를 판정하지 않는다', () => {
  const click = 1_000
  // 1) 서랍을 한 번 열어 목록을 받은 뒤 닫았다가 다시 여는 길. 상태는 'ready'로 살아 있지만
  //    그 목록은 클릭보다 먼저 받은 것이므로 아직 판정할 수 없다 — focus는 한 바퀴 살아남는다.
  assert.equal(canJudgeMissingNotice('ready', click - 1, click), false)
  // 2) 새 목록이 도착하면 그때 판정한다.
  assert.equal(canJudgeMissingNotice('ready', click + 1, click), true)
  assert.equal(canJudgeMissingNotice('ready', click, click), true, '같은 순간에 도착한 목록도 판정할 수 있다')
  // 3) 첫 열기(한 번도 못 받음)도 같은 규칙 하나로 걸린다.
  assert.equal(canJudgeMissingNotice('loading', 0, click), false)
  // 4) 목록을 못 받은 경우는 기다려도 오지 않는다 — 여기서 판정하지 않으면 딥링크가 영원히 열리지 않는다.
  assert.equal(canJudgeMissingNotice('error', 0, click), true)

  // 화면이 실제로 이 규칙을 쓰는지, 그리고 목록이 도착할 때 다시 도는지.
  // 판정할 수 없을 때는 한 번만 다시 읽고 물러난다 — 기다림에 끝이 있어야 딥링크가 죽지 않는다.
  assert.match(collaboration, /if \(!canJudgeMissingNotice\(noticesState, noticesLoadedAt, focus\.at\) && focusReloadRef\.current !== focus\.at\) \{[\s\S]{0,500}?focusReloadRef\.current = focus\.at\s+reloadNotices\(\)\s+return\s+\}/)
  assert.match(collaboration, /\}, \[focus\?\.at, notices\.length, noticesState, noticesLoadedAt, conversationsSettled\]\)/)
  assert.match(noticeCenter, /return \{ notices, state, loadedAt, reload \}/)
})

test('탭을 바꾸면 이전 파라미터의 행을 그 탭의 것으로 보여 주지 않는다', () => {
  // 보드의 탭은 클라이언트 필터가 아니라 서버 파라미터다(200건 상한 때문에). 손에 든 행을 그대로 둔 채
  // 새 요청을 보내면 한 왕복 동안 '보관함' 아래에 보관되지 않은 공지가 앉는다.
  assert.match(noticeCenter, /const key = useMemo\(/)
  assert.match(noticeCenter, /const answered = result\.key === key/)
  assert.match(noticeCenter, /const notices = answered \? result\.rows : \[\]/)
  assert.match(noticeCenter, /const state: NoticeListState = answered \? result\.state : 'loading'/)
  // 실패한 요청도 자기 key를 남긴다 — 안 그러면 새 탭이 영원히 '불러오는 중'에 머문다.
  assert.match(noticeCenter, /setResult\(\(current\) => \(\{ key, rows: current\.key === key \? current\.rows : \[\], state: 'error', loadedAt: 0 \}\)\)/)
  // load 첫 줄의 setState('loading')은 쓰지 않는다 — SSE 재적재마다 보드가 깜빡이고 딥링크 판정이 흔들린다.
  assert.doesNotMatch(noticeCenter, /const load = useCallback\(async \(signal\?: AbortSignal\) => \{\s+setState/)
})

test('공지 보드를 보는 중에는 현재 항목이 둘이 되지 않고, 대화를 고르면 보드에서 빠져나온다', () => {
  assert.match(collaboration, /aria-current=\{pane === 'chat' && conversation\.id === selectedId \? 'true' : undefined\}/)
  // 방을 고르는 세 길(목록 행·새 대화·새 그룹방)이 모두 한 곳을 지난다. 하나라도 새면 보드가 열린 채
  // 선택만 바뀌어 화면이 아무 반응도 하지 않고, 휴대폰에서는 사이드바만 사라져 보드에 갇힌다.
  // R16-J에서 스레드 닫기가 한 줄 더 붙었다. 세 줄의 순서와 내용은 그대로 잠그되, 이 자리에
  // '방을 바꿀 때 함께 되돌려야 하는 것'이 늘어나는 것 자체는 막지 않는다 — 그것이 이 함수의 일이다.
  assert.match(collaboration, /const selectConversation = \(id: string\) => \{\s+setPane\('chat'\)\s+setSelectedId\(id\)\s+setMobilePane\('chat'\)\s/)
  assert.equal((collaboration.match(/selectConversation\(/g) ?? []).length, 5, '딥링크 두 갈래 + 방을 고르는 세 길')
  const body = (name) => collaboration.slice(collaboration.indexOf(`const ${name} = `), collaboration.indexOf(`const ${name} = `) + 1_600)
  for (const name of ['chooseConversation', 'startDirectConversation', 'createGroupRoom']) {
    assert.match(body(name), /selectConversation\(/, `${name}이 pane을 되돌리지 않는다`)
  }
  assert.doesNotMatch(collaboration, /setSelectedId\(body\.conversation/)
})

test('딥링크의 스크롤은 시간이 아니라 카드가 붙었는지로 정한다 — 스트립과 보드가 같은 한 벌을 쓴다', () => {
  // 스트립은 방마다 따로 물어보므로 고정된 지연으로 재면 느린 회선에서 강조가 조용히 사라진다.
  assert.match(collaboration, /pendingNoticeScrollRef/)
  assert.doesNotMatch(collaboration, /noticeRefs\.current\[target\.id\]/)
  // 판정은 카드를 그리는 쪽(ref 콜백)에서 한다. effect의 deps로는 보드의 목록이 도착한 순간을 알 수 없다 —
  // NoticeBoard는 자기 안에서 useNotices를 돌리므로 스트립의 행도 selectedId도 그때 바뀌지 않는다.
  assert.match(collaboration, /const noticeCardRef = \(id: string\) => \(node: HTMLElement \| null\) => \{[\s\S]{0,400}?pendingNoticeScrollRef\.current !== id[\s\S]{0,400}?classList\.add\('is-focused'\)/)
  assert.doesNotMatch(collaboration, /\}, \[openNoticeId, channelNoticeRows, selectedId\]\)/)
  // 강조를 지우는 타이머는 effect 정리에 매달지 않는다. 매달면 옆방 메시지 한 건에 목록이 다시 읽히는
  // 순간 정리가 돌아 타이머만 죽고 outline이 카드에 그대로 굳는다.
  assert.doesNotMatch(collaboration, /return \(\) => window\.clearTimeout\(timer\)/)
  // 회사 공지(보드로 가는 갈래)도 스크롤 대상이다 — 가장 흔한 알림이 스크롤도 강조도 못 받으면 안 된다.
  assert.equal((collaboration.match(/pendingNoticeScrollRef\.current = target\.id/g) ?? []).length, 2, '방으로 가는 갈래와 보드로 가는 갈래 둘 다')
})

test('딥링크는 들어갈 수 있는 방으로만 보낸다 — 볼 수는 있어도 못 여는 방이 있다', () => {
  // 프로젝트 공지는 프로젝트 멤버 전원에게 보이지만(noticeVisibleTo) 채널 참여자가 아니면 그 방은
  // 내 목록에 없다. 그대로 고르면 '대화를 선택하세요'로 떨어져 공지가 어디에도 뜨지 않는다.
  assert.match(collaboration, /const room = target\.conversationId && myConversations\.some\(\(item\) => item\.id === target\.conversationId\)/)
  assert.match(collaboration, /if \(room\) \{[\s\S]{0,400}?selectConversation\(room\)\s+\} else if \(!readOnlyRooms\) \{/)
  // '못 들어간다'는 판정에만 자격이 필요하다: 방 목록이 한 번은 답해야 한다. 캐시가 빈 첫 열기에서는
  // 공지 응답이 방 목록보다 먼저 도착할 수 있고, 그때 판정하면 게스트는 아무 갈래도 타지 못한 채
  // focus만 소비된다. 반대로 목록에 이미 있는 방은 증거가 손안에 있으므로 기다리지 않는다.
  assert.match(collaboration, /if \(target\.conversationId && !room && !conversationsSettled\) return/)
  // 기다림에는 끝이 있다 — 성공이든 실패든 요청이 답하면 켜진다.
  assert.match(collaboration, /\.finally\(\(\) => \{ if \(active\) setConversationsSettled\(true\) \}\)/)
})

test('필독을 끄면 좁혀 둔 확인 대상도 함께 지운다 — 화면이 안 보여 주는 것을 보내지 않는다', () => {
  assert.match(noticeCenter, /setMustRead\(event\.target\.checked\); if \(!event\.target\.checked\) setExcluded\(\[\]\)/)
})

test('받을 사람이 없는 회사에서는 컴포저가 그 사실을 한 줄로 말한다', () => {
  // 승인된 사람이 관리자 하나뿐인 테넌트도 공지를 올릴 수 있다(서버는 201, 카드는 '대상이 없습니다').
  // 컴포저만 빈 <ul>을 가리키며 '아래 사람에게만 갑니다'라고 하면, 화면에 없는 명단을 가리키는 문장이 된다.
  assert.match(noticeCenter, /audience\.length === 0 \? \([\s\S]{0,200}?확인 대상이 없습니다\. 지금 올리면 확인 기록 없이 게시됩니다\./)
  assert.match(noticeCenter, /확인 기록과 첨부 열람은 아래 사람에게만 갑니다/)
})

test('사이드바 회사 공지 행은 자기 몫을 따로 읽고, 가장 새것을 보여 준다', () => {
  // 전체 목록은 서버가 필독 먼저·200건에서 자른다. 그것을 걸러 쓰면 (1) 공지가 있는데 없다고 하고
  // (2) 어제 올린 필독이 오늘 올린 공지 자리에 앉는다.
  assert.match(collaboration, /useNotices\(open && !readOnlyRooms, workspaceScope, \{ scope: 'company'/)
  assert.match(collaboration, /const latestCompanyNotice = \[\.\.\.companyNotices\]\.sort\(/)
  assert.doesNotMatch(collaboration, /companyNotices\[0\]/)
  // (3) 아직 오지 않은(또는 못 받은) 목록으로 '없다'고 말하는 것도 가짜 0이다. 보드와 같은 훅에서
  //     state를 함께 받아, 도착한 뒤에만 그 문장을 쓴다.
  assert.match(collaboration, /state: companyNoticesState/)
  assert.match(collaboration, /companyNoticesState === 'ready' \? '아직 공지가 없습니다' : ''/)
})

test('컴포저가 기대는 사실은 타입에도 적혀 있다 — /api/directory의 kind와 active', () => {
  // 회사 공지의 확인 대상에서 게스트를 빼는 근거가 kind다. 응답 타입이 그 사실을 말하지 않으면
  // 매핑을 명시적으로 바꾸는 순간 kind가 undefined가 되어 게스트가 목록에 되돌아오고,
  // 한 명만 체크 해제해도 서버 audience 밖이 되어 400으로 되돌아온다.
  assert.match(collaboration, /members\?: Array<\{[^}]*system\?: boolean; kind\?: 'employee' \| 'guest'; active\?: boolean \}>/)
  assert.match(noticeCenter, /others\.filter\(\(person\) => person\.kind !== 'guest'\)/)
})

test('접힌 카드는 실제로 접힌다 — display를 적은 규칙이 브라우저의 [hidden]을 이긴다', () => {
  // .messenger-notice-body에 display: grid만 있으면 author 규칙이 UA의 [hidden] { display: none }을
  // 이겨, hidden={!expanded}가 아무 일도 하지 않는다. 카드는 늘 펼쳐진 채 뜨고 접기 버튼은
  // aria-expanded만 바꾸는 죽은 버튼이 된다(낭독기에는 보이는 것과 다른 말을 하게 된다).
  assert.match(noticeCenter, /className="messenger-notice-body" id=\{bodyId\} hidden=\{!expanded\}/)
  assert.match(noticeCss, /\.messenger-notice-body\[hidden\]\s*\{[^}]*display:\s*none/)
})

test('NoticeCenter.css는 토큰만 쓰고 공용 버튼을 다시 칠하지 않는다', () => {
  assert.doesNotMatch(noticeCss, /#[0-9a-f]{3,8}\b/i)
  assert.doesNotMatch(noticeCss, /\.ui-button\s*\{/)
  // 죽은 클래스를 두지 않는다 — 화면에 붙인 이름에는 규칙이 있어야 한다.
  assert.ok(collaboration.includes('messenger-notice-home'))
  assert.match(noticeCss, /\.messenger-notice-home /)
})

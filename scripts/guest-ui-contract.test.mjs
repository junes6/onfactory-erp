import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

/**
 * 외부 게스트 화면 계약(설계서 A절 §5·§6-3).
 * 브라우저 스모크는 서버 트랙과 합친 뒤 통합 단계에서 하고, 여기서는 소스가 그 계약을 담고 있는지 고정한다.
 * - 게스트는 사이드바·탑바·휴대폰 셸을 DOM에 두지 않는다(App.tsx 조기 반환).
 * - 게스트 세션에서는 테넌트 데이터 fetch가 시작되지 않는다(403 토스트 방지).
 * - 초대 수락(?guestInvite=)·인사 게스트 섹션·배지·업무 프로젝트 필수가 존재한다.
 */
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const app = await read('src/App.tsx')
const guestWorkspace = await read('src/components/GuestWorkspace.tsx')
const access = await read('src/components/AccessExperience.tsx')
const people = await read('src/components/PeopleOperations.tsx')
const projects = await read('src/components/ProjectSpaces.tsx')
const collaboration = await read('src/components/CollaborationSuite.tsx')
const domain = await read('src/domainData.ts')

test('게스트 역할은 App.tsx가 셸을 그리기 전에 전용 화면으로 빠진다', () => {
  assert.match(app, /role: 'tenant-admin' \| 'tenant-member' \| 'tenant-guest' \| 'platform-operator'/)
  assert.match(app, /guestScope\?: GuestScope/)
  const guestReturn = app.indexOf("if (account?.role === 'tenant-guest') {")
  const shellStart = app.indexOf('<aside id="main-navigation"')
  const passwordGate = app.indexOf('if (account?.requiresPasswordChange) return <PasswordChangePage')
  assert.ok(guestReturn > 0 && shellStart > 0 && passwordGate > 0)
  assert.ok(passwordGate < guestReturn && guestReturn < shellStart, '게스트 분기는 비밀번호 변경 분기 뒤, 사이드바 렌더 앞에 있어야 한다')
  const guestBranch = app.slice(guestReturn, app.indexOf('return (', guestReturn))
  assert.match(guestBranch, /<GuestWorkspace /)
  for (const forbidden of ['nav-list', '<GlobalSearch', 'MobileTabBar', 'MobileMoreSheet', 'messenger-trigger', 'notification-wrap', '<AIHome']) {
    assert.equal(guestBranch.includes(forbidden), false, `게스트 분기에 ${forbidden}가 있으면 안 된다`)
  }
})

test('게스트 세션에서는 테넌트 데이터 fetch effect가 시작되지 않는다', () => {
  assert.match(app, /const isGuestSession = account\?\.role === 'tenant-guest'/)
  assert.match(app, /const tenantDataEnabled = authStatus === 'signed-in' && mode === 'tenant' && !account\?\.requiresPasswordChange && !isGuestSession/)
  // work-items · work-rules · calendar-events · 업종 모듈 키 · directory · materialize 전부 같은 스위치를 탄다.
  assert.equal((app.match(/enabled: tenantDataEnabled,/g) ?? []).length, 3)
  assert.match(app, /const tenantSignedIn = tenantDataEnabled/)
  assert.match(app, /if \(!tenantDataEnabled \|\| !workspaceScope \|\| workRules\.length === 0\) return/)
  assert.match(app, /if \(!tenantDataEnabled \|\| !account\?\.tenantId\) \{\s*setDirectoryAssignees\(\[\]\)/)
})

test('초대 링크(?guestInvite=)는 로그인 상태와 무관하게 수락 화면을 먼저 띄운다', () => {
  assert.match(app, /new URLSearchParams\(window\.location\.search\)\.get\('guestInvite'\)/)
  const acceptBranch = app.indexOf('if (guestInviteToken) {')
  const checking = app.indexOf("if (authStatus === 'checking') return")
  assert.ok(acceptBranch > 0 && acceptBranch < checking, '수락 분기는 세션 확인 분기보다 앞에 있어야 한다')
  assert.match(access, /export function GuestAcceptPage\(/)
  assert.match(access, /\/api\/guest\/invitations\/\$\{encodeURIComponent\(token\)\}/)
  assert.match(access, /\/api\/guest\/invitations\/\$\{encodeURIComponent\(token\)\}\/accept/)
  assert.match(access, /유효하지 않은 초대 링크입니다\. 초대한 회사에 재발송을 요청하세요\./)
  assert.equal((access.match(/유효하지 않은 초대 링크입니다/g) ?? []).length, 1, '같은 문구는 한 화면에 한 번(alert만)')
  // 게스트 설정 드로어에는 푸터 로그아웃이 없다(헤더에 이미 있다).
  assert.match(access, /\{!guestMode && <footer><button className="settings-logout"/)
  assert.match(access, /거래처 게스트로 초대받았다면 메일의 초대 링크로 들어오세요/)
  assert.match(access, /<PasswordRules value=\{password\} \/>/)
})

test('GuestWorkspace는 업무·채널·자료·게시판 네 탭과 게스트 배지만 가진다', () => {
  assert.match(guestWorkspace, /fetch\('\/api\/guest\/me'/)
  for (const label of ["label: '업무'", "label: '채널'", "label: '자료'", "label: '게시판'"]) assert.match(guestWorkspace, new RegExp(label))
  assert.match(guestWorkspace, /className="segmented-tabs guest-tabs" role="tablist"/)
  assert.match(guestWorkspace, /tone="warning" icon=\{<ShieldCheck size=\{13\} \/>\}>게스트 · \{orgName\}/)
  assert.match(guestWorkspace, /projects\.length > 1 && <label className="guest-project-select">/)
  // 허용 목록 밖 라우트는 부르지 않는다.
  for (const forbidden of ['/api/directory', '/api/search', '/api/activity', '/api/chat', '/api/admin/', '/api/workspace/project-spaces', '/api/leave-approvers']) {
    assert.equal(guestWorkspace.includes(forbidden), false, `GuestWorkspace가 ${forbidden}를 호출하면 안 된다`)
  }
  // 업무 행동은 accept/submit 둘만, 완료 보고는 공용 CompletionModal.
  assert.match(guestWorkspace, /action: 'accept' \| 'submit'/)
  assert.match(guestWorkspace, /<CompletionModal item=\{completionItem\}/)
  assert.equal(guestWorkspace.includes("'approve'"), false)
  // primary는 완료 보고 하나 — 그것도 펼친 행(open) 한 곳에서만. 진행 중 업무가 여럿이어도 화면에 primary는 1개다.
  assert.equal((guestWorkspace.match(/tone="primary"/g) ?? []).length, 0)
  assert.equal((guestWorkspace.match(/tone: 'primary'/g) ?? []).length, 0, '행마다 primary를 주는 객체 리터럴이 있으면 안 된다')
  assert.equal((guestWorkspace.match(/'primary'/g) ?? []).length, 1, "primary 리터럴은 open && action.primary 삼항 한 곳")
  assert.match(guestWorkspace, /primary: true, run: \(\) => \{ if \(blocked\)/)
  assert.match(guestWorkspace, /tone=\{open && action\.primary \? 'primary' : 'secondary'\}/)
  // 카드 안에 카드 금지: 탭을 감싸는 section은 panel(카드)이 아니다. 카드 층은 행·메신저·게시글 하나뿐.
  assert.doesNotMatch(guestWorkspace, /className="panel guest-panel"/)
  assert.match(guestWorkspace, /<section className="guest-panel"/)
  // 알림 표면: 벨 + NotificationCenter(허용 라우트만 부른다). 업무 알림은 업무 탭으로, 멘션은 채널 탭으로.
  assert.match(guestWorkspace, /<NotificationCenter workspaceScope=\{workspaceScope\} feed=\{notificationFeed\} onReload=\{onReloadNotifications\}/)
  assert.match(guestWorkspace, /if \(page === 'tasks'\) \{ setTab\('tasks'\)/)
  assert.match(guestWorkspace, /if \(page === 'messenger'\) \{ setTab\('channels'\)/)
  assert.match(guestWorkspace, /if \(event\.kind === 'notification' \|\| event\.kind === 'resync'\) void onReloadNotifications\(\)/)
  // App은 게스트 세션에서 자기 스트림을 열지 않는다(GuestWorkspace 구독 하나가 업무·알림을 맡는다).
  assert.match(app, /useEventStream\(authStatus === 'signed-in' && mode === 'tenant' && account\?\.role !== 'tenant-guest'/)
  assert.match(app, /notificationFeed=\{notificationFeed\} onReloadNotifications=\{loadNotifications\}/)
  // 채널은 메신저를 읽기 전용·프로젝트 로스터로 재사용하고, 게시판은 ProjectSpacesPage guestMode.
  assert.match(guestWorkspace, /<MessengerDrawer embedded readOnlyRooms open rosterOverride=\{roster\}/)
  assert.match(guestWorkspace, /<ProjectSpacesPage guestMode focusProjectId=\{selectedProject\?\.id\}/)
  assert.equal(guestWorkspace.includes('/api/documents?'), false, '게스트 자료 탭에는 업로드가 없다')
})

test('메신저는 rosterOverride가 있으면 /api/directory를 건너뛰고, readOnlyRooms면 방 관리 UI를 숨긴다', () => {
  assert.match(collaboration, /rosterOverride\?: MessengerRosterEntry\[\]/)
  assert.match(collaboration, /readOnlyRooms\?: boolean/)
  assert.match(collaboration, /if \(rosterOverride\) \{[\s\S]*?setDirectory\(rosterOverride\.map/)
  assert.match(collaboration, /\{!readOnlyRooms && <Button tone="primary" full/)
  assert.match(collaboration, /\{!readOnlyRooms && <Button tone="quiet" size="sm" onClick=\{\(\) => setGroupDialog\('create'\)\}/)
  assert.match(collaboration, /canEdit=\{mine && !readOnlyRooms\}/)
  assert.match(collaboration, /canPin=\{!readOnlyRooms\}/)
  assert.match(collaboration, /useOverlayFocus\(open && !embedded, onClose\)/)
})

test('인사·조직 계정·권한 탭에 외부 게스트 섹션과 초대·재발송·회수·범위·비활성·해지가 있다', () => {
  assert.match(people, /'guest-invite' \| 'guest-scope'/)
  assert.match(people, /<section className="guest-admin-section" aria-labelledby="guest-admin-title">/)
  assert.match(people, /<h3 id="guest-admin-title">외부 게스트<\/h3>/)
  assert.match(people, /초대한 게스트가 없습니다/)
  assert.match(people, /<Button tone="secondary" type="button" onClick=\{\(event\) => openGuestInvite\(event\.currentTarget\)\}>/)
  assert.match(people, /fetch\('\/api\/admin\/guests'/)
  assert.match(people, /`\/api\/admin\/guests\$\{path\}`/)
  for (const path of ['/resend', '/revoke-invitation', '/status']) assert.match(people, new RegExp(`\\)\\}${path}\``))
  assert.match(people, /method: 'PATCH',\s*body: JSON\.stringify\(\{\s*projectIds: guestProjectPick/)
  assert.match(people, /\{ method: 'DELETE' \}, '게스트를 해지하지 못했습니다\.'/)
  assert.match(people, /inviteExpiresInDays: Math\.min\(30, Math\.max\(1,/)
  assert.match(people, /navigator\.clipboard\.writeText\(url\)/)
  assert.match(people, /메일 발송 어댑터가 없어 링크를 직접 전달해 주세요/)
  assert.match(people, /delivery === 'sent'/)
  // 계정·권한 탭의 primary는 '초대 보내기' 하나 — 게스트 초대는 secondary.
  const accountsTab = people.slice(people.indexOf("tab === 'accounts' && <section"), people.indexOf('<section className="operator-access-log"'))
  assert.equal((accountsTab.match(/tone="primary"/g) ?? []).length, 2, '승인 버튼(목록 안)과 초대 보내기(헤더)만 primary')
  assert.equal(accountsTab.includes('tone="secondary" type="button" onClick={(event) => openGuestInvite'), true)
})

test('프로젝트 로스터·댓글·멤버 아바타와 업무 이력에 게스트 배지가 붙고, 게스트 담당 업무는 프로젝트가 필수다', () => {
  assert.match(projects, /kind\?: MemberKind/)
  assert.match(projects, /authorRole\?: string/)
  assert.match(projects, /comment\.authorRole === 'tenant-guest' && <GuestBadge \/>/)
  assert.match(projects, /disabled=\{guest\} aria-label=\{`\$\{entry\.name\} 권한/)
  assert.match(projects, /role: isGuestEntry\(id\) \? 'viewer' : 'editor'/)
  assert.match(projects, /외부 게스트 초대는 인사·조직 → 계정·권한에서/)
  assert.match(projects, /guestMode\?: boolean/)
  assert.match(projects, /\{!guestMode && <button type="button" className="project-back"/)
  assert.match(app, /completion\.submittedByRole === 'tenant-guest' && <StatusBadge className="status-pill" tone="warning">게스트<\/StatusBadge>/)
  assert.match(app, /const ownerIsGuest = selectedOwner\?\.kind === 'guest'/)
  assert.match(app, /if \(owner\.kind === 'guest' && !projectId\)/)
  assert.match(app, /\.\.\.\(projectId \? \{ projectId \} : \{\}\)/)
  assert.match(app, /assignees\.filter\(\(assignee\) => assignee\.kind !== 'guest'\)/)
  assert.match(domain, /projectId\?: string/)
  assert.match(domain, /submittedByRole\?: string/)
})

test('게스트 화면 CSS는 토큰만 쓰고 버튼 모양을 정의하지 않는다', async () => {
  const css = await read('src/components/GuestWorkspace.css')
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i)
  assert.doesNotMatch(css, /\.ui-button\s*\{[^}]*(?:background|color|border)\s*:/)
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

/**
 * 하위 업무 트리 화면 계약(설계서 C절 §2).
 * 브라우저 스모크와 별개로, 소스가 계약을 담고 있는지 여기서 고정한다.
 * - 세 표면(데스크톱 카드·휴대폰·게스트)이 같은 행 렌더러(SubtaskList)를 쓴다.
 * - 상태 문구는 src/utils/workStatus.ts 한 곳에서만 정한다.
 * - 차단 사유는 누르기 전에 보이고, 상위 바꾸기는 '적용'을 눌러야만 실행된다.
 * - 자식이 없으면 진행률 줄 자체가 없다(가짜 0% 금지).
 */
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const count = (source, pattern) => (source.match(pattern) ?? []).length

const app = await read('src/App.tsx')
const subtaskList = await read('src/components/SubtaskList.tsx')
const workStatus = await read('src/utils/workStatus.ts')
const blockedCss = await read('src/components/SubtaskList.css')
const buttonCss = await read('src/components/ui/Button.css')
const workTree = await read('src/utils/workTree.ts')
const workspaceState = await read('src/hooks/useWorkspaceState.ts')
const guestWorkspace = await read('src/components/GuestWorkspace.tsx')
const mobileShell = await read('src/components/MobileShell.tsx')
const domain = await read('src/domainData.ts')

const workPage = app.slice(app.indexOf('function WorkPage('), app.indexOf('function InventoryPage('))
const renderCard = workPage.slice(workPage.indexOf('const renderCard ='), workPage.indexOf('return <div className="content-page workflow-page">'))
const taskModal = app.slice(app.indexOf('function TaskModal('), app.indexOf('function SupportSessionModal('))

test('하위 업무 행은 공용 렌더러 하나가 한 줄 원칙대로 그린다', () => {
  // 상위 카드 전체가 클릭 가능하므로 안쪽 클릭은 전부 멈춰야 한다(칩·제목·행동 버튼).
  assert.ok(count(subtaskList, /event\.stopPropagation\(\)/g) >= 2)
  // 자식 행 버튼은 조용한 톤만 — 화면의 기본 버튼(primary)은 여전히 하나다.
  assert.ok(count(subtaskList, /tone="quiet"/g) >= 1)
  assert.equal(count(subtaskList, /tone="primary"/g), 0)
  // 카드 안에 카드를 두지 않는다.
  assert.equal(count(subtaskList, /<article/g), 0)
  // 목록 이름은 기본 '하위 업무'. 이미 같은 이름의 구역 안에 들어갈 때만 호출 쪽에서 바꾼다(이름을 두 번 읽어 주지 않게).
  assert.match(subtaskList, /label = '하위 업무'/)
  assert.match(subtaskList, /aria-label=\{label\}/)
  assert.match(subtaskList, /role="progressbar"/)
  assert.match(subtaskList, /aria-valuenow=\{progress\.percent\}/)
  // '모른다'는 값이 아니라 없음으로 온다 — 제목이 '상위 업무'인 진짜 상위와 구별되어야 한다.
  assert.match(subtaskList, /export function ParentChip\(\{ title, onOpen \}: \{ title\?: string/)
  assert.ok(subtaskList.includes('const label = title ? `상위: ${title}` : UNKNOWN_PARENT_TITLE'))
  assert.match(workTree, /export const parentTitleOf = \([^)]*\): string \| undefined/)
})

test('보드는 상위만 칼럼에 세우고, 자식은 상위 카드 안에서 펼친다', () => {
  assert.match(workPage, /isTopLevelIn\(item, scopedIds\)/)
  assert.match(workPage, /\{progress && <details className="workflow-card-subtasks"/)
  assert.match(workPage, /<SubtaskRows items=\{cardChildren\}/)
  // 칼럼 머리 숫자와 요약줄은 같은 집합(자식 포함)을 센다.
  assert.match(workPage, /const stageCount = \(status: WorkItem\['status'\]\) => scoped\.filter\(\(item\) => item\.status === status\)\.length/)
  assert.match(workPage, /aria-label=\{`\$\{column\.label\} \$\{count\}건`\}/)
  // 자식이 없으면 진행률 줄 자체가 없다 — 없는 값을 0%로 적지 않는다.
  assert.doesNotMatch(workPage, /'0%'/)
  assert.doesNotMatch(workPage, /진행률 0%/)
  // 머리 숫자와 그린 카드 수가 다르면 그 차이를 말한다. 버튼에는 두 번째 숫자를 적지 않는다(같은 칼럼에 두 개의 건수가 생긴다).
  assert.match(workPage, /\{list\.length > 0 && count > list\.length && <p className="workflow-column-note">\{count - list\.length\}건은 상위 업무 카드 안에 있습니다<\/p>\}/)
  assert.match(workPage, /'완료 업무 모두 보기'/)
  assert.doesNotMatch(workPage, /완료 \$\{list\.length\}건 모두 보기/)
  // 업무 카드 안에 article이 겹치지 않는다(반복 규칙 카드는 renderCard 밖의 별개 article이다).
  assert.equal(count(renderCard, /<article/g), 1)
  // 카드에는 role="button"을 붙이지 않는다 — ARIA가 button의 자식을 보조기술에서 지워(children presentational)
  // 하위 목록·펼침·행동 버튼이 통째로 사라진다. 상세로 가는 조작점은 제목 버튼 하나다.
  assert.doesNotMatch(renderCard, /role="button"/)
  assert.match(renderCard, /<h3><button type="button" className="workflow-card-title" aria-haspopup="dialog"/)
  // 한 화면 기본 버튼 하나: 헤더 '새 업무 지시'와 드로어 '지금 할 일' 둘뿐이다.
  assert.equal(count(workPage, /tone="primary"/g), 2)
})

test('막힌 완료 보고는 누르기 전에 이유가 보이되, 문은 잠기지 않는다', () => {
  assert.match(workPage, /className=\{`workflow-card-action\$\{action\.blocked \? ' is-warned' : ''\}`\}/)
  // 사유는 title이 아니라 눈에 보이는 한 줄이고, 버튼은 그 줄을 가리킨다(마우스 없는 사람에게도 같은 문장).
  assert.match(workPage, /<p className="workflow-card-blocked" id=\{`workflow-card-blocked-\$\{item\.id\}`\}>/)
  assert.match(workPage, /aria-describedby=\{action\.blocked \? `workflow-card-blocked-\$\{item\.id\}` : undefined\}/)
  assert.match(workPage, /<p className="workflow-drawer-blocked" id="workflow-drawer-blocked">/)
  assert.match(workPage, /aria-describedby=\{drawerAction\.blocked \? 'workflow-drawer-blocked'/)
  // 진행률·차단 사유는 필터와 무관한 사실이라 items 전체로 세고, 행은 보이는 집합에서만 그린다.
  assert.match(workPage, /const blocked = subtaskBlockReason\(items, item\.id\)/)
  assert.match(workPage, /const progress = subtaskProgress\(items, item\.id\)/)
  assert.match(workPage, /const cardChildren = childrenOf\(scoped, item\.id\)/)
  // 그린 행보다 센 건수가 많으면 나머지가 어디 있는지 밝힌다(행이 하나도 없을 때만이 아니라 언제나).
  // 다만 '다른 담당자'라고 단정하지 않는다 — '내가 지시' 필터에서는 내가 담당인 자식도 빠진다.
  assert.match(workPage, /하위 업무 \{progress\.total - cardChildren\.length\}건은 지금 고른 범위 밖에 있습니다\./)
  assert.doesNotMatch(workPage, /다른 담당자가 맡고 있습니다/)
  // 그러나 그 건수로 문을 잠그지는 않는다 — 화면이 든 사본은 이 세션 동안 갱신되지 않는다.
  // 눌러서 열고, 아직 남았는지는 제출 시점에 서버가 409 SUBTASKS_INCOMPLETE로 그때의 건수로 말한다.
  assert.match(workPage, /blocked: blocked \|\| undefined, run: \(\) => setDialog\(\{ type: 'completion', item \}\)/)
  assert.doesNotMatch(workPage, /if \(blocked\) \{ onToast\(blocked\)/)
  // 눌리는 버튼에 aria-disabled를 붙이면 '조작할 수 없다'는 거짓말이 된다 — 막지 않는 표면에는 붙이지 않는다.
  assert.doesNotMatch(workPage, /aria-disabled=\{action\.blocked/)
  assert.doesNotMatch(workPage, /aria-disabled=\{drawerAction\.blocked/)
  assert.doesNotMatch(blockedCss, /\.workflow-card-action[^\n]*cursor: not-allowed/)
  // 같은 이유로 '상위 업무' 칸도 미리 숨기지 않는다. 보이는 자식이 없으면 열어 두고, 안 되면 서버 문장이 토스트로 온다.
  assert.match(workPage, /const canReparent = [^\n]*drawerChildren\.length === 0/)
  // 안내 문장은 '잠겼다'가 아니라 '거절될 수 있다'고 말한다 — 실제로 눌리기 때문이다.
  assert.equal(count(workPage, /하위 업무가 남아 있어 제출이 거절될 수 있습니다\./g), 1)
  assert.doesNotMatch(workPage, /하위 업무가 끝나면 완료 보고할 수 있습니다\./)
  // disabled로 막으면 포커스와 사유가 함께 사라진다.
  assert.doesNotMatch(workPage, /<Button tone="primary" type="button" disabled=\{drawerAction/)
  // 경고 톤은 마우스를 올려도 유지된다(일반 :hover가 같은 순위로 덮어쓰지 못하게).
  assert.match(blockedCss, /\.workflow-card-action\.is-warned:hover/)
  // 실제로 막는 표면(게스트)의 aria-disabled는 disabled와 같은 모양이어야 한다.
  assert.match(buttonCss, /\.ui-button\[aria-disabled='true'\], \.ui-icon-button\[aria-disabled='true'\] \{ cursor: not-allowed; opacity: \.5; \}/)
  assert.equal(count(buttonCss, /:hover:not\(:disabled\)(?!:not)/g), 0, '모든 hover 규칙이 aria-disabled까지 함께 막는다')
  // 공용 행 렌더러도 같은 규칙을 판단할 근거를 받는다 — 사유(blocked)와 실제로 막는가(stops)는 다른 값이다.
  assert.match(subtaskList, /aria-disabled=\{action\.stops \? true : undefined\}/)
  assert.match(subtaskList, /blocked\?: string; stops\?: boolean/)
})

test('같은 사실은 같은 문장으로 말한다 — 경고와 거절 토스트가 한 템플릿에서 나온다', () => {
  assert.match(workTree, /export const subtaskBlockMessage = \(remaining: number\) => `하위 업무 \$\{remaining\}건이 끝나야 완료 보고를 할 수 있습니다\.`/)
  assert.match(workTree, /return remaining \? subtaskBlockMessage\(remaining\) : ''/)
  // 서버 409 문장을 그대로 쓰지 않는다(내부 상태어 '결재완료'가 섞여 있고, 버튼 위 경고와 다른 문장이 된다).
  for (const source of [app, guestWorkspace]) {
    assert.match(source, /body\.error\?\.code === 'SUBTASKS_INCOMPLETE' && typeof body\.error\.count === 'number' \? subtaskBlockMessage\(body\.error\.count\) : ''/)
  }
})

test('드로어에 하위 업무·상위 업무 두 구역이 있고, 상위 이동은 적용을 눌러야 실행된다', () => {
  assert.match(workPage, /aria-label="하위 업무"/)
  assert.match(workPage, /aria-label="상위 업무"/)
  assert.match(workPage, /아직 하위 업무가 없습니다\./)
  assert.match(workPage, /하위 업무 추가/)
  // select 변경은 상태만 바꾼다. 서버 호출은 '적용' 버튼 onClick 한 곳뿐이다.
  assert.match(workPage, /onChange=\{\(event\) => setReparentTarget\(event\.target\.value\)\}/)
  assert.match(workPage, /onClick=\{\(\) => \{ setParentBusy\(true\); void onMoveParent\(drawerItem\.id, reparentTarget \|\| null\)/)
  const selectStart = workPage.indexOf('onChange={(event) => setReparentTarget(')
  const applyStart = workPage.indexOf('setParentBusy(true)')
  assert.ok(selectStart > 0 && applyStart > selectStart)
  assert.doesNotMatch(workPage.slice(selectStart, workPage.indexOf('</select>', selectStart)), /onMoveParent/)
})

test('새 업무 지시에서 상위 업무를 고를 수 있고, 프로젝트는 상위를 따른다', () => {
  assert.match(taskModal, /name="parentId"/)
  assert.match(taskModal, /\.\.\.\(parentId \? \{ parentId \} : \{\}\)/)
  assert.match(taskModal, /\.\.\.\(projectId \? \{ projectId \} : \{\}\)/)
  assert.match(taskModal, /open=\{Boolean\(initialDescription\) \|\| Boolean\(initialParentId\)\}/)
  // 상위를 지우면 따라왔던 프로젝트도 함께 지운다 — 직원 담당이면 프로젝트 칸이 화면에 없어 되돌릴 수 없다.
  assert.match(taskModal, /useEffect\(\(\) => \{ if \(parent\) setProjectId\(parent\.projectId \?\? ''\); else if \(!parentId\) setProjectId\(''\) \}/)
  assert.match(taskModal, /게스트에게 맡기는 하위 업무는 프로젝트가 있는 상위 업무 아래에만 둘 수 있습니다\./)
  // 프로젝트 없는 상위 + 게스트 담당: 칸을 잠그지 않고 이유를 적는다. 잠그면 '지시하기'가 이유 없이 회색으로 굳어 제출 검증까지 닿지 못한다.
  assert.match(taskModal, /disabled=\{Boolean\(parent\?\.projectId\)\}/)
  assert.match(taskModal, /이 상위 업무는 프로젝트에 속하지 않아 게스트에게 맡길 수 없습니다\./)
})

test('상태 문구는 한 곳에서만 정하고 세 표면이 그것을 쓴다', () => {
  assert.match(workStatus, /'결재대기': '확인 기다리는 중'/)
  for (const source of [app, guestWorkspace, mobileShell]) assert.doesNotMatch(source, /'결재대기': '/)
  assert.doesNotMatch(mobileShell, />\{task\.status\}</)
  assert.doesNotMatch(mobileShell, /\{task\.status\} ·/)
  assert.ok(count(mobileShell, /workStatusLabel\(/g) >= 2)
  assert.doesNotMatch(guestWorkspace, /const statusLabel/)
  assert.match(guestWorkspace, /<details className="guest-task-children"/)
  assert.match(mobileShell, /<details className="mobile-line-children"/)
})

test('상위 제목은 서버 응답 봉투로만 오고, 상위 이동은 전용 라우트를 부른다', () => {
  assert.match(app, /\/api\/work-items\/\$\{encodeURIComponent\(id\)\}\/parent/)
  assert.equal(count(app, /onEnvelope: \(body\) =>/g), 1)
  // 게스트 세션에서 테넌트 데이터 fetch가 늘어나면 안 된다(훅을 새로 부르지 않았다).
  assert.equal(count(app, /enabled: tenantDataEnabled,/g), 3)
  assert.equal(count(workspaceState, /onEnvelope\?\.\(/g), 2)
  assert.match(domain, /parentId\?: string/)
  // 진행률·차단 건수는 저장하지 않고 자식 status에서 파생한다.
  assert.match(workTree, /children\.filter\(\(child\) => child\.status === '결재완료'\)\.length/)
})

test('화면 커밋은 서버를 건드리지 않는다 — 화면은 자기가 보는 목록만 세어 말한다', async () => {
  const appServer = await read('server/app.mjs')
  const tree = await read('server/work-item-tree.mjs')
  // 자식 건수 봉투(subtasks)는 이 커밋에 없다. 서버 변경은 재시작 확인을 함께 넣는 서버 커밋에서만 한다(설계 §0-1).
  assert.doesNotMatch(tree, /subtaskCountsFor/)
  assert.doesNotMatch(appServer, /subtasks/)
  // 그래서 화면은 보이지 않는 자식을 두고 아무것도 주장하지 않는다 — 판정은 제출 시점의 서버 몫이다.
  assert.doesNotMatch(workTree, /counts/)
  // 봉투(상위 제목)는 최신성 검사를 지난 뒤에만 화면으로 간다 — 지나간 범위의 상위 제목이 남으면 안 된다.
  const guardAt = workspaceState.indexOf('if (sequence !== requestSequence.current')
  assert.ok(guardAt > 0 && workspaceState.indexOf('options.onEnvelope?.(envelope)') > guardAt)
})

test('막다른 길을 만들지 않는다: 출처 배지는 프로젝트 상세로, 게스트 하위 행은 상세로 이어진다', async () => {
  const projectSpaces = await read('src/components/ProjectSpaces.tsx')
  // 비게스트도 focusProjectId를 쓴다 — 쓰지 않으면 배지가 프로젝트 목록에서 끝난다.
  assert.match(projectSpaces, /if \(focusProjectId\) \{ setSelectedId\(focusProjectId\); onFocusHandled\?\.\(\) \}/)
  // 지목은 한 번만 쓴다. 지우지 않으면 이 화면에 올 때마다 같은 상세가 다시 열려 목록이 사라진 것처럼 보인다.
  assert.match(app, /onFocusHandled=\{\(\) => setProjectFocusId\(undefined\)\}/)
  // 데스크톱·휴대폰이 같은 함수를 쓴다. 휴대폰은 page만 바꾸면 업무 탭에 그대로 남으므로 탭도 함께 옮긴다.
  assert.equal(count(app, /onOpenOrigin=\{openWorkOrigin\}/g), 2, '데스크톱·휴대폰 두 마운트가 같은 통로를 쓴다')
  assert.match(app, /if \(originPage === 'projects'\) \{ setProjectFocusId\(focusId\); setWorkFocusId\(''\); setMobileTab\('more'\) \}/)
  // 게스트 자식 행도 열리고, 열린 자식의 상세는 상위와 같은 것을 쓴다.
  assert.match(guestWorkspace, /onOpen=\{\(child\) => \{ setOpenTaskId\(openTaskId === child\.id \? null : child\.id\); openChildList\(item\.id\) \}\}/)
  assert.match(guestWorkspace, /\{openChild && taskDetail\(openChild\)\}/)
  // <details>는 집합 하나로만 제어한다. 계산식(`집합 || 행 || 자식`)이면 값이 true에 머무는 동안 React가 DOM에 다시 쓰지 않아
  // 한 번 접힌 목록은 알림으로도 다시 펼 수 없다 — 하위 업무 알림을 눌러도 아무 일이 없는 화면이 된다.
  assert.match(guestWorkspace, /open=\{openChildLists\.has\(item\.id\)\}/)
  assert.doesNotMatch(guestWorkspace, /open=\{openChildLists\.has\(item\.id\) \|\|/)
  assert.match(guestWorkspace, /onToggle=\{\(event\) => setOpenChildLists\(/)
  // 펼쳐야 하는 사건마다 집합에 넣는다: 알림에서 넘어올 때·행을 펼칠 때·자식 상세를 열 때.
  assert.match(guestWorkspace, /if \(focusId\) \{ setOpenTaskId\(focusId\); openChildListOf\(focusId\) \}/)
  assert.match(guestWorkspace, /onClick=\{\(\) => \{ setOpenTaskId\(open \? null : item\.id\); if \(!open\) openChildList\(item\.id\) \}\}/)
  assert.equal(count(guestWorkspace, /const taskDetail = \(item: WorkItem\) =>/g), 1)
})

test('게스트에게는 퍼센트를 말하지 않고, 막힌 이유는 누르기 전에 붙는다', () => {
  // 서버가 게스트에게 주는 것은 자기 담당 행뿐이다 — 분모를 모르는 채로 100%를 적으면 그 옆에서 서버가 409로 거절한다.
  assert.doesNotMatch(guestWorkspace, /progressLabel|subtaskProgress/)
  assert.match(guestWorkspace, /subtaskCountLabel\(children\.length\)/)
  assert.match(workTree, /export const subtaskCountLabel = \(total: number\) => `하위 \$\{total\}건`/)
  // 이유는 토스트로만 알리지 않는다 — 버튼에 붙여 누르기 전에 보이게 한다(공용 Button이 둘 다 그대로 넘긴다).
  assert.match(guestWorkspace, /aria-disabled=\{action\.blocked \? true : undefined\} title=\{action\.blocked\}/)
  assert.match(guestWorkspace, /blocked: reason \|\| undefined, primary: true/)
})

test('건수는 자식까지 센다 — 목록에서 접었다고 맡은 일이 줄지 않는다', () => {
  assert.match(mobileShell, /const openCount = \(allTasks \?\? tasks\)\.filter\(\(task\) => task\.status !== '결재완료'\)\.length/)
  assert.match(mobileShell, /내 업무 \{openCount\}건/)
  assert.match(mobileShell, /const openTotal = tasks\.filter\(\(task\) => task\.status !== '결재완료'\)\.length/)
  assert.match(mobileShell, /업무 \{openTotal\}건/)
  // 접는 기준은 '진행 중인 상위'다 — 끝난 상위 아래 남은 자식까지 접으면 제목은 '업무 1건'인데 목록은 비어 보인다.
  assert.match(mobileShell, /const open = tasks\.filter\(\(task\) => task\.status !== '결재완료' && isTopLevelIn\(task, openIds\)\)/)
  // 최상위로 올릴지 정한 집합과 상위 칩을 판정하는 집합은 같아야 한다 — 다르면 끌어올린 자식이 칩 없이 독립 업무처럼 보인다.
  assert.match(mobileShell, /const row = \(task: WorkItem, foldIds: Set<string>\) =>/)
  assert.match(mobileShell, /isSubtask\(task\) && !foldIds\.has\(task\.parentId\)/)
  assert.match(mobileShell, /\{open\.map\(\(task\) => row\(task, openIds\)\)\}/)
  assert.match(mobileShell, /done\.slice\(0, 20\)\.map\(\(task\) => row\(task, ids\)\)/)
  // '나머지 N건 보기'는 5줄 제한이 자른 줄만 센다 — 접힌 자식까지 세면 다 보이는 화면에서도 버튼이 뜬다.
  assert.match(mobileShell, /const hidden = Math\.max\(0, tasks\.length - shown\.length\)/)
  // 끌어올린 자식을 상위 행 안에서 또 그리지 않는다.
  assert.match(mobileShell, /\.filter\(\(child\) => !promoted\.has\(child\.id\)\)/)
  assert.match(guestWorkspace, /const openWorkCount = workItems\.filter/)
})

test('하위 업무 CSS는 토큰만 쓰고 버튼 모양을 정의하지 않는다', async () => {
  const subtaskCss = await read('src/components/SubtaskList.css')
  const guestCss = await read('src/components/GuestWorkspace.css')
  const styles = await read('src/styles.css')
  // styles.css·GuestWorkspace.css는 이번에 더한 블록만 본다.
  const newBlocks = [
    subtaskCss,
    guestCss.split('\n').filter((line) => line.includes('guest-task-children')).join('\n'),
    styles.split('\n').filter((line) => line.includes('mobile-line-children') || line.includes('has-children')).join('\n'),
  ]
  for (const block of newBlocks) {
    assert.ok(block.trim().length > 0)
    assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b/i)
    assert.doesNotMatch(block, /\.ui-button\s*\{/)
    // 진행률 막대 4px은 카드 우선순위 바와 같은 예외다. 나머지 치수는 min-*/line-height만 허용한다.
    for (const line of block.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')) {
      const stripped = line.replace(/(?:min-height|min-width|line-height)\s*:\s*[^;}]+/g, '').replace(/height: 4px/g, '')
      assert.doesNotMatch(stripped, /\d+px/, `토큰 밖 픽셀: ${line.trim()}`)
    }
  }
})

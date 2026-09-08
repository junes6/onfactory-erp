import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'

import { saveApprovalDraft } from '../src/utils/approvalDraft.ts'
import { approvalListEmptyText, filledLineSteps, notificationFocusTarget } from '../src/utils/approvalLine.ts'

/**
 * 양식형 전자결재 화면 계약.
 *
 * 여기서 잠그는 것은 「예쁘게 그렸는가」가 아니라 **다시 부서질 자리들**이다:
 * 결재를 별도 화면으로 떼어내는 것 · 직원이 관리자 전용 라우트를 부르는 것 ·
 * 한글 입력이 끊기는 onChange · 배지 숫자가 서로를 덮어쓰는 합산 · 화면과 서버의 문장이 갈리는 것.
 */

const read = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')

const APPROVAL_DIR = new URL('../src/components/approval/', import.meta.url)

const [app, approvalQueue, taxWorkspace, registry, approvalRouting, approvalForms, approvalLine, approvalTypes] = await Promise.all([
  read('src/App.tsx'),
  read('src/components/ApprovalQueue.tsx'),
  read('src/components/TaxWorkspace.tsx'),
  read('src/modules/registry.ts'),
  read('server/approval-routing.mjs'),
  read('server/approval-forms.mjs'),
  read('src/utils/approvalLine.ts'),
  read('src/components/approval/approvalTypes.ts'),
])

const approvalFileNames = (await readdir(APPROVAL_DIR)).sort()
const approvalFiles = Object.fromEntries(await Promise.all(
  approvalFileNames.map(async (name) => [name, await readFile(new URL(name, APPROVAL_DIR), 'utf8')]),
))
const approvalTsx = Object.entries(approvalFiles).filter(([name]) => name.endsWith('.tsx'))
const approvalAll = Object.values(approvalFiles).join('\n')

const count = (source, pattern) => (source.match(pattern) ?? []).length

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

test('결재는 별도 화면이 아니라 승인 큐 안에 산다', () => {
  assert.match(approvalQueue, /<ApprovalDocumentSection/, 'ApprovalQueue가 전자결재 섹션을 그려야 한다')
  assert.match(approvalQueue, /<h1>결재 · AI 제안<\/h1>/, '화면 제목이 결재를 함께 말해야 한다')
  assert.match(registry, /approvals: \{ id: 'approvals', label: '결재 · AI 제안'/, '메뉴 라벨은 레지스트리 한 곳에서 나온다')
  // 라우트를 새로 만들면 그것이 곧 별도 결재함이다.
  assert.equal(count(registry, /\| 'approval/g), 1, '결재용 라우트 id는 approvals 하나뿐이어야 한다')
})

test("저장소 어디에도 '결재함'이라는 낱말이 없다", async () => {
  // 화면 코드만 보면 서버 주석이 그 낱말을 되살려 놓는다. 사람이 읽는 글자는 화면이든 주석이든
  // 같은 개념을 가리키고, 「별도 결재함을 만들지 않는다」는 그 개념 자체를 두지 않겠다는 뜻이다.
  const roots = ['src', 'server', 'scripts', 'worker', 'db', 'supabase', 'public']
  const self = 'scripts/approval-ui-contract.test.mjs'
  const offenders = []
  const walk = async (directory) => {
    for (const entry of await readdir(new URL(`../${directory}/`, import.meta.url), { withFileTypes: true })) {
      const next = `${directory}/${entry.name}`
      if (entry.isDirectory()) { await walk(next); continue }
      if (next === self) continue
      if (!/\.(?:tsx?|mjs|js|css|sql|md)$/.test(entry.name)) continue
      if ((await read(next)).includes('결재함')) offenders.push(next)
    }
  }
  for (const root of roots) await walk(root)
  assert.deepEqual(offenders, [], '별도 결재함을 만들지 않는다 — 저장소 어디에도 그 낱말이 남으면 안 된다')
})

test('화면당 primary 버튼은 하나라는 규칙이 결재 화면에서도 지켜진다', () => {
  // page-header의 '새 기안' + 기존 ProposalEditDialog 안의 1개. 정확히 둘이다.
  assert.equal(count(approvalQueue, /tone="primary"/g), 2, 'ApprovalQueue의 tone="primary"는 정확히 2개')
  for (const [name, source] of approvalTsx) {
    assert.ok(count(source, /tone="primary"/g) <= 1, `${name}의 tone="primary"는 1개 이하여야 한다`)
  }
})

test('결재 목록의 행 버튼은 줄 클릭을 삼키고, 목록에 article을 겹치지 않는다', () => {
  const section = approvalFiles['ApprovalDocumentSection.tsx']
  assert.match(section, /className=\{`approval-doc-row is-\$\{/, '행 클래스가 상태를 함께 말해야 한다')
  assert.match(section, /onClick=\{\(event\) => \{ event\.stopPropagation\(\); action\.run\(\) \}\}/, '행 버튼이 줄 클릭을 삼켜야 한다')
  assert.equal(count(approvalAll, /<article/g), 0, 'approval/ 안에 <article> 중첩을 만들지 않는다')
})

test('반려는 사유 없이 보낼 수 없고, 인쇄는 PDF로 저장하는 길을 말한다', () => {
  const detail = approvalFiles['ApprovalDetailDialog.tsx']
  assert.match(detail, /<textarea[\s\S]{0,200}required[\s\S]{0,200}minLength=\{5\}/, '반려 사유 입력에 required·minLength가 있어야 한다')
  assert.match(detail, /PDF로 저장/, '인쇄 안내가 PDF 저장 경로를 말해야 한다')
  assert.match(detail, /인쇄 창이 차단되었습니다\. 브라우저에서 팝업을 허용해 주세요\./, '팝업 차단 시 푸는 길을 말해야 한다')
})

test('화면의 사전 경고와 서버 오류가 같은 한 문장에서 나온다', () => {
  const lineRequired = /LINE_REQUIRED: \{ code: 'APPROVAL_LINE_REQUIRED', message: '([^']+)' \}/.exec(approvalRouting)?.[1]
  const reasonRequired = /REASON_REQUIRED: \{ code: 'APPROVAL_REASON_REQUIRED', message: '([^']+)' \}/.exec(approvalRouting)?.[1]
  assert.ok(lineRequired && reasonRequired, '서버 오류 사전에서 두 문장을 읽어야 한다')
  assert.match(approvalTypes, new RegExp(`APPROVAL_LINE_REQUIRED_MESSAGE = '${lineRequired.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`))
  assert.match(approvalTypes, new RegExp(`APPROVAL_REASON_REQUIRED_MESSAGE = '${reasonRequired.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`))
  // 화면이 그 상수를 실제로 쓰는가 — 문장을 손으로 다시 적으면 두 곳이 갈린다.
  assert.match(approvalFiles['ApprovalDraftDialog.tsx'], /onToast\(APPROVAL_LINE_REQUIRED_MESSAGE\)/)
  assert.match(approvalFiles['ApprovalDetailDialog.tsx'], /onToast\(APPROVAL_REASON_REQUIRED_MESSAGE\)/)
})

test('결재선이 비어도 상신 버튼은 disabled가 아니라 사유를 남긴다', () => {
  const draft = approvalFiles['ApprovalDraftDialog.tsx']
  assert.match(draft, /aria-disabled=\{lineEmpty \|\| busy\}/, '이유를 말할 수 있게 aria-disabled를 쓴다')
  assert.match(draft, /title=\{lineEmpty \? APPROVAL_LINE_REQUIRED_MESSAGE : undefined\}/)
  assert.match(draft, /if \(submit && lineEmpty\) \{ onToast\(APPROVAL_LINE_REQUIRED_MESSAGE\); return \}/, '핸들러가 실제로 거절해야 aria-disabled가 정직하다')
})

test('한글 입력이 끊기지 않는다 — onChange는 받은 값을 그대로 넘긴다', () => {
  const banned = /\.trim\(\)|\.replace\(|\.toUpperCase\(\)|\.toLowerCase\(\)|Number\(|parseInt|parseFloat/
  for (const [name, source] of approvalTsx) {
    for (const match of source.matchAll(/onChange=\{/g)) {
      const body = attributeBody(source, match.index + 'onChange='.length)
      for (const target of body.matchAll(/event\.target\.(\w+)/g)) {
        assert.ok(['value', 'files'].includes(target[1]),
          `${name}: onChange가 event.target.${target[1]}을 읽는다 — value(또는 파일 입력의 files)만 읽어야 한다`)
      }
      if (!body.includes('event.target.value')) continue
      assert.doesNotMatch(body, banned, `${name}: onChange가 입력 중인 값을 고친다 — 조합 중인 한글이 끊긴다`)
    }
  }
  // 콤마·수 변환은 제출 시점에만.
  assert.match(approvalFiles['ApprovalDraftDialog.tsx'], /제출할 때만\*\* 부른다/)
})

test('결재 배지는 두 사실을 배지에서만 더한다', () => {
  assert.match(app, /const \[approvalWaiting, setApprovalWaiting\] = useState\(0\)/)
  assert.match(app, /item\.id === 'approvals' \? pendingProposals \+ approvalWaiting \+ approvalDecided : undefined/)
  // D13 회귀: 합산값을 pendingProposals에 넣으면 SSE와 onPendingChange가 30초마다 그것을 지운다.
  assert.doesNotMatch(app, /setPendingProposals\([^)]*approvalWaiting/, 'setPendingProposals에 결재 대기 수를 더하지 않는다')
  assert.match(app, /\/api\/approval-documents\/summary\?seenAt=/, '배지는 저비용 요약 경로를 읽는다')
  assert.match(app, /setApprovalWaiting\(Number\(body\.waitingOnMe \?\? 0\)\)/)
  assert.match(app, /setApprovalDecided\(Number\(body\.decidedUnread \?\? 0\)\)/)
})

test('홈 타일의 문장은 세는 것과 같은 것을 말한다 — 끝난 내 기안을 「대기」라 부르지 않는다', () => {
  // 결재할 것이 하나도 없는 사람이 승인 완료 문서 하나로 「대기 1건」을 읽고 들어오면,
  // 첫 탭('내 결재')은 '지금 결재할 문서가 없습니다'다. 두 사실이면 문장도 둘이어야 한다(규칙 11·13).
  assert.match(app, /const \[approvalDecided, setApprovalDecided\] = useState\(0\)/,
    '결재 대기와 결과 확인은 다른 사실이라 다른 state 다')
  assert.match(app, /decidedUnread > 0\s*\n?\s*\? `결재·검토 대기 \$\{pendingProposals\}건 · 결과 확인 \$\{decidedUnread\}건`/,
    '결과 확인 건수가 있으면 그 사실을 따로 말해야 한다')
  assert.match(app, /: `결재·검토 대기 \$\{pendingProposals\}건`/)
  assert.equal(count(app, /decidedUnread=\{approvalDecided\}/g), 2, 'AIHome 두 호출부 모두 결과 확인 수를 따로 넘긴다')
  // 요약을 받는 콜백은 안정된 참조여야 한다 — 매 렌더 새 함수면 load 가 다시 만들어져 폴링이 폭주한다.
  assert.match(app, /const handleApprovalSummary = useCallback\(/)
})

test('승인 큐의 한 글자 단축키는 결재 대화상자 위에서 살지 않는다', () => {
  // Enter/A·E·X 는 preventDefault 로 대화상자 버튼의 기본 동작을 삼키고 무관한 AI 제안을 결정한다.
  assert.match(approvalQueue, /if \(editing \|\| pendingDecision \|\| approvalModalOpen\) return/,
    '가드가 결재 대화상자와 확인 대화상자를 함께 봐야 한다')
  assert.match(approvalQueue, /\}, \[approvalModalOpen, editing, pendingDecision, selected, selectedId, visible\]\)/,
    '의존성 배열에 없으면 핸들러가 낡은 값을 본다')
  assert.match(approvalQueue, /onModalChange=\{setApprovalModalOpen\}/, '섹션이 대화상자 열림을 위로 알려야 한다')
  // 「열려 있는가」를 답하는 곳은 대화상자를 실제로 그리는 그 컴포넌트 하나다.
  assert.match(approvalFiles['ApprovalDocumentSection.tsx'],
    /const modalOpen = Boolean\(draftOpen \|\| editing \|\| detailId \|\| \(formAdminOpen && isAdmin\)\)/)
  assert.match(approvalFiles['ApprovalDocumentSection.tsx'], /useEffect\(\(\) => \{ onModalChange\?\.\(modalOpen\) \}, \[modalOpen, onModalChange\]\)/)
})

test('열 수 없는 첨부에는 내려받기 버튼도, 이름도 주지 않는다', () => {
  const detail = approvalFiles['ApprovalDetailDialog.tsx']
  // 서버가 요청 시점에 다시 재는 사실이다. 화면은 그 답을 그대로 그린다(규칙 1·5).
  // 이름이 `name?:` 인 것이 계약의 핵심이다 — 열 수 없는 첨부에는 서버가 이름을 싣지 않는다.
  assert.match(detail, /attachments\?:\s*\{ id: string; name\?: string; canRead: boolean \}\[\]/)
  assert.match(detail, /entry\.canRead\s*\n?\s*\?/, '열 수 있을 때만 버튼이다')
  assert.match(detail, /APPROVAL_ATTACHMENT_CLOSED_MESSAGE/, '열 수 없으면 그 자리에서 사유를 말한다')
  assert.match(approvalTypes, /APPROVAL_ATTACHMENT_CLOSED_MESSAGE = '열람 권한이 없어 내려받을 수 없습니다\.'/)
  // 잠금 문구 옆에 이름을 붙이면 서버가 감춘 것을 화면이 되돌려 놓는 꼴이 된다.
  assert.doesNotMatch(detail, /approval-attachment-closed[\s\S]{0,200}entry\.name/, '잠긴 첨부 자리에 이름을 그리지 않는다')
})

test('결재 첨부는 자료실 경로가 아니라 결재 범위 경로로 받는다', () => {
  // 결재는 자료실의 열람 명단을 고치지 않는다(그 넓힘은 되돌아오지 않아 대결 한 번·결재 한 번이
  // 남의 원본을 영구히 열었다). 그래서 결재자가 근거를 여는 문은 결재 문서에 매달린 이 경로뿐이다.
  const detail = approvalFiles['ApprovalDetailDialog.tsx']
  assert.match(detail, /\/api\/approval-documents\/\$\{encodeURIComponent\(documentId\)\}\/attachments\/\$\{encodeURIComponent\(id\)\}/)
  assert.doesNotMatch(detail, /downloadDocumentAttachment/, '자료실 경로로 받으면 결재자가 열지 못한다')
  // 서버도 같은 자리에서 같은 술어를 쓴다 — 두 곳이 각자 판정하면 「버튼은 있는데 404」가 생긴다.
  assert.match(approvalForms, /app\.get\('\/api\/approval-documents\/:id\/attachments\/:attachmentId'/)
  assert.match(approvalForms, /const canReadApprovalAttachment = /)
  assert.equal(count(approvalForms, /canReadApprovalAttachment\(document, row, auth\)/g), 3,
    '상세·내려받기·인쇄가 같은 술어를 부른다 — 갈리면 「버튼은 있는데 404」거나 「종이에만 이름이 샌다」')
  // 저장소 ACL 을 고치던 옛 길은 남아 있으면 안 된다 — 하나만 남아도 넓힘이 다시 새어 나온다.
  for (const gone of ['nextLibraryForReaders', 'writeDocumentsWithReaders', 'writeFormsWithReaders']) {
    assert.doesNotMatch(approvalForms, new RegExp(gone), `${gone} 가 남아 있다 — 결재가 자료실 명단을 다시 고친다`)
  }
})

test('목록이 잘리면 그 사실을 적고, 나머지에 닿는 길을 실제로 준다', () => {
  const section = approvalFiles['ApprovalDocumentSection.tsx']
  // 탭이 「내 결재 105」라 써 놓고 100줄만 그리면, 세는 수와 보여 주는 수가 화면에서 갈린다(규칙 13).
  assert.match(section, /const \[total, setTotal\] = useState\(0\)/)
  assert.match(section, /documents\.length < total/, '잘렸는지는 두 수를 견주어 답한다')
  assert.match(section, /\$\{documents\.length\}건을 보여 주고 있습니다 · 남은 \$\{total - documents\.length\}건/)
  // 「내 결재」 탭에서 상태 좁히기는 갈래를 만들지 못한다(canDecide 가 '결재중'만 통과시킨다).
  // 그래서 나머지에 닿는 길은 offset 이어야 한다 — 문장이 참이 되는 유일한 길이다(규칙 11).
  assert.match(section, /더 보기/, '남은 건수를 말했으면 그 건수에 닿는 길이 있어야 한다')
  assert.match(section, /setPages\(\(current\) => current \+ 1\)/)
  assert.match(section, /params\.set\('offset', String\(index \* PAGE_SIZE\)\)/)
  // 한 묶음 크기는 서버 상한과 같은 수여야 한다 — 크게 부르면 서버가 조용히 자르고 offset 이 어긋난다.
  const serverLimit = /const MAX_LIST_LIMIT = (\d+)/.exec(approvalForms)?.[1]
  assert.ok(serverLimit, '서버에서 MAX_LIST_LIMIT 을 읽어야 한다')
  assert.match(section, new RegExp(`const PAGE_SIZE = ${serverLimit}\\b`), `화면의 묶음 크기가 서버 상한(${serverLimit})과 다르다`)
  // 탭·상태를 바꾸면 펼친 묶음도 처음으로 돌아간다.
  assert.match(section, /setTab\(next\)\n\s*(?:\/\/[^\n]*\n\s*)*setPages\(1\)/)
  assert.match(section, /const chooseStatus = \(next: StatusFilter\) => \{\n\s*setStatus\(next\)\n\s*setPages\(1\)/)
})

test('목록의 빈 문구는 필터를 안다 — 탭 숫자와 본문이 서로를 부정하지 않는다', () => {
  // 「전체」에서 '승인'으로 좁혀 둔 채 「내 결재」를 누르면 탭에는 요약이 그린 숫자가, 본문에는
  // 「지금 결재할 문서가 없습니다」가 함께 남는다. 어느 쪽도 필터 때문이라고 말하지 않는다(규칙 11·13).
  assert.equal(approvalListEmptyText('waiting', ''), '지금 결재할 문서가 없습니다')
  assert.equal(approvalListEmptyText('drafted', ''), '아직 올린 결재가 없습니다')
  assert.equal(approvalListEmptyText('waiting', '승인'), '‘승인’ 상태로 좁힌 결과가 없습니다')
  assert.equal(approvalListEmptyText('cc', '반려'), '‘반려’ 상태로 좁힌 결과가 없습니다')
  const section = approvalFiles['ApprovalDocumentSection.tsx']
  assert.match(section, /approvalListEmptyText\(tab, status\)/)
  // 그 자리에서 필터를 푸는 길을 함께 준다.
  assert.match(section, /모든 상태 보기/)
  assert.match(section, /onClick=\{\(\) => chooseStatus\(''\)\}/)
})

test('결재자를 고르지 않은 단계는 저장을 막지 않는다 — 「기안은 메모장」이 그 자리에서 깨지지 않게', () => {
  // 서버는 순차 단계에 결재자 정확히 1명을 요구한다. 빈 단계를 그대로 보내면 임시저장 한 번이
  // 통째로 400 이 되고 적어 둔 것이 한 글자도 남지 않는다.
  assert.deepEqual(filledLineSteps([{ mode: 'sequential', approverIds: [''] }]), [])
  assert.deepEqual(filledLineSteps([{ mode: 'parallel', approverIds: ['', ''] }]), [])
  assert.deepEqual(
    filledLineSteps([{ mode: 'sequential', approverIds: ['U-1'] }, { mode: 'sequential', approverIds: [''] }]),
    [{ mode: 'sequential', approverIds: ['U-1'] }],
  )
  assert.deepEqual(filledLineSteps(null), [])
  const draft = approvalFiles['ApprovalDraftDialog.tsx']
  assert.match(draft, /line: filledLineSteps\(line\)\.map\(/, '보내는 본문에서 빈 단계를 걷어낸다')
  // 「비었는가」를 답하는 곳이 하나여야 aria-disabled 와 핸들러의 거절이 같은 것을 말한다(규칙 2·3).
  assert.match(draft, /const lineEmpty = filledLineSteps\(line\)\.length === 0/)
  assert.match(draft, /if \(submit && lineEmpty\) \{ onToast\(APPROVAL_LINE_REQUIRED_MESSAGE\); return \}/)
})

test('상신이 거절돼도 그 대화상자에서 다시 저장할 수 있다 — version 은 응답이 정한다', async () => {
  /**
   * 서버의 version 규칙을 그대로 흉내 낸 가짜다. 화면이 프롭 스냅샷을 계속 다시 쓰면
   * 두 번째 요청부터 409 「다른 곳에서 먼저 저장되었습니다」가 난다 — 아무도 먼저 저장하지
   * 않았는데 그렇게 말하는 거짓 문장이고, 대화상자 안에는 빠져나갈 길이 없다.
   */
  const server = { version: 1, values: {} }
  const calls = []
  const call = async (method, path, body) => {
    calls.push({ method, path, version: body.version })
    if (body.version !== server.version) {
      return { ok: false, body: { error: { code: 'APPROVAL_VERSION_CONFLICT', message: '다른 곳에서 먼저 저장되었습니다. 최신 내용을 불러온 뒤 다시 시도해 주세요.', currentVersion: server.version } } }
    }
    if (path.endsWith('/submit')) {
      if (!server.values.spent_on) return { ok: false, body: { error: { code: 'APPROVAL_VALUE_REQUIRED', message: '‘지출일’ 항목을 채워 주세요.' } } }
      server.version += 1
      return { ok: true, body: { document: { version: server.version } } }
    }
    server.values = body.values ?? server.values
    server.version += 1
    return { ok: true, body: { document: { version: server.version } } }
  }

  let version = 1
  const first = await saveApprovalDraft({ id: 'APD-1', version, payload: { values: {} }, submit: true, call })
  assert.equal(first.ok, false)
  assert.equal(first.message, '‘지출일’ 항목을 채워 주세요.')
  assert.equal(first.version, 2, 'PATCH 는 성공했다 — 그 사실을 version 으로 돌려주지 않으면 다음 시도가 막힌다')
  version = first.version

  const second = await saveApprovalDraft({ id: 'APD-1', version, payload: { values: { spent_on: '2026-09-01' } }, submit: true, call })
  assert.equal(second.ok, true, `채워 넣고 다시 눌렀는데 거절됐다 — ${JSON.stringify(second)}`)
  assert.equal(second.submitted, true)
  assert.deepEqual(server.values, { spent_on: '2026-09-01' }, '사람이 채운 값이 서버에 들어가지 못했다')
  assert.deepEqual(calls.map((entry) => entry.version), [1, 2, 2, 3])

  // 진짜 충돌이 났을 때는 서버가 알려 준 지금 version 을 받아 적어 다음 시도가 이어진다.
  server.version = 9
  const conflicted = await saveApprovalDraft({ id: 'APD-1', version: 3, payload: { values: {} }, submit: false, call })
  assert.equal(conflicted.ok, false)
  assert.equal(conflicted.version, 9, '서버가 준 currentVersion 을 버리면 사람은 영원히 409 를 본다')
  const recovered = await saveApprovalDraft({ id: 'APD-1', version: conflicted.version, payload: { values: {} }, submit: false, call })
  assert.equal(recovered.ok, true)
})

test('기안 대화상자는 프롭 스냅샷 version 을 다시 쓰지 않는다', () => {
  const draft = approvalFiles['ApprovalDraftDialog.tsx']
  assert.match(draft, /const \[version, setVersion\] = useState\(\(\) => draft\?\.version \?\? 0\)/)
  assert.match(draft, /saveApprovalDraft\(\{ id: draft\.id, version, payload: body, submit, call \}\)/)
  assert.match(draft, /setVersion\(outcome\.version\)/, '실패했을 때도 받아 적어야 다음 시도가 이어진다')
  assert.doesNotMatch(draft, /version: draft\.version/, '프롭 스냅샷을 요청에 다시 실으면 두 번째부터 409 다')
  // 실패하면 목록도 낡았다 — 닫지 않고 다시 읽는다(고치던 내용이 대화상자 안에 있다).
  assert.match(draft, /onRefresh\?\.\(\)/)
  assert.match(approvalFiles['ApprovalDocumentSection.tsx'], /onRefresh=\{\(\) => \{ void load\(true\) \}\}/)
})

test('App 최상위 훅은 늘지 않았고, 직원도 결재 화면에 들어온다', () => {
  // 게스트 세션에서 도는 테넌트 데이터 fetch는 그대로 셋이다(결재는 컴포넌트 안에서 부른다).
  assert.equal(count(app, /enabled: tenantDataEnabled,/g), 3)
  assert.match(app, /const tenantMemberPages = new Set<PageId>\(\['ai', 'schedule', 'tasks', 'approvals'/)
})

test('직원은 관리자 전용 제안 라우트를 부르지 않는다', () => {
  assert.match(approvalQueue, /const isAdmin = account\.role === 'tenant-admin'/)
  assert.match(approvalQueue, /if \(!isAdmin\) \{ setData\(null\); setLoading\(false\); return \}[\s\S]{0,200}fetch\('\/api\/proposals'/)
  assert.equal(count(approvalQueue, /fetch\('\/api\/proposals'/g), 1, '제안 목록을 부르는 곳은 한 군데뿐이다')
  assert.match(approvalQueue, /\{isAdmin && <OpportunityWatch/, '기회 감시도 관리자 화면 안에 있다')
})

test('승인된 지출은 세무·자산 화면에서 보이고, 범위를 스스로 말한다', () => {
  assert.match(taxWorkspace, /<ApprovalSpendPanel workspaceScope=\{workspaceScope\} canManage=\{canManage\} \/>/)
  const panel = approvalFiles['ApprovalSpendPanel.tsx']
  assert.match(panel, /승인된 지출/)
  assert.match(panel, /결재로 승인된 금액만 모읍니다\. 결재 전 금액은 세지 않습니다\./)
  assert.match(panel, /아직 승인된 지출이 없습니다/)
  assert.match(panel, /scope === 'mine' \? <p className="approval-spend-scope">내가 올린 결재만 셉니다\.<\/p> : null/)
})

test('결재 화면은 색을 직접 쓰지 않는다', () => {
  for (const [name, source] of Object.entries(approvalFiles)) {
    assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/, `${name}에 하드코딩 색상이 있다`)
  }
})

test('결재선 거울은 서버 술어와 같은 규칙을 적는다', () => {
  // 이 넷이 갈리면 「내 결재 3건」이라 써 놓고 눌렀을 때 403이 난다.
  for (const rule of [
    /if \(line\.some\(\(entry, position\) => entry\?\.step !== position \+ 1\)\) return false/,
    /if \(pressedForOther \|\| held\.some\(\(approver\) => approver\.decision !== 'pending'\)\) return false/,
    /if \(isDrafter\(document, actor\)\) return false/,
    /return held\.length === 0/,
  ]) assert.match(approvalLine, rule)
  // 그럼에도 화면은 막다른 길을 만들지 않는다 — 상세는 서버가 준 permissions를 읽는다.
  assert.match(approvalFiles['ApprovalDetailDialog.tsx'], /permissions\?\.canDecide/)
})

test('알림이 지목한 결재 문서는 결재 자리로 가고, 업무 id 자리에 섞이지 않는다', () => {
  // 판정은 page 가 아니라 **id 의 모양**이다. page 로 먼저 가르면, 결재 문서를 가리키면서
  // page 가 'approvals' 가 아닌 알림이 업무 id 자리로 흘러들어 아무것도 열리지 않는다.
  assert.deepEqual(notificationFocusTarget('approvals', 'APD-MTKCDCW0-DE3D'),
    { page: 'approvals', approvalFocusId: 'APD-MTKCDCW0-DE3D', workFocusId: '' })
  // 아침 요약(buildQuietDigest)과 유형표가 아직 'tasks' 인 결재 요청이 여기로 온다.
  assert.deepEqual(notificationFocusTarget('tasks', 'APD-MTKCDCW0-DE3D'),
    { page: 'approvals', approvalFocusId: 'APD-MTKCDCW0-DE3D', workFocusId: '' })
  // 업무 알림은 그대로 업무 자리로 간다.
  assert.deepEqual(notificationFocusTarget('tasks', 'WRK-2026-0001'),
    { page: 'tasks', approvalFocusId: '', workFocusId: 'WRK-2026-0001' })
  assert.equal(count(app, /const target = notificationFocusTarget\(page, focus/g), 2, '알림 센터와 푸시 클릭 두 곳 모두에서')
  assert.equal(count(app, /setApprovalFocusId\(target\.approvalFocusId\)/g), 2)
  assert.match(app, /if \(nextPage !== 'approvals'\) setApprovalFocusId\(''\)/, '떠날 때 지워야 다음에 다시 열리지 않는다')
  assert.match(approvalQueue, /focusId=\{focusId\}/)
})

test("page:'approvals' 알림이 전부 결재 문서인 것은 아니다 — 결재 문서 id 일 때만 상세를 연다", () => {
  // AI 제안(PRP-)·센티널·외부 기회(OPP-)가 같은 page 로 온다. 그 id 를 결재 상세에 넘기면
  // 서버가 404 를 주고 사람은 「결재 문서를 찾을 수 없거나 열람 권한이 없습니다.」만 본다.
  assert.deepEqual(notificationFocusTarget('approvals', 'PRP-2026-0007'),
    { page: 'approvals', approvalFocusId: '', workFocusId: '' })
  assert.deepEqual(notificationFocusTarget('approvals', 'OPP-88'),
    { page: 'approvals', approvalFocusId: '', workFocusId: '' })
  assert.match(app, /import \{[^}]*notificationFocusTarget[^}]*\} from '\.\/utils\/approvalLine'/)
  // 모양의 정본은 서버다. 두 글자가 갈리면 진짜 결재 알림이 조용히 버려진다.
  const server = /export const DOCUMENT_ID_RE = (\/\^APD-[^\n]*\/)\n/.exec(approvalRouting)?.[1]
  assert.ok(server, '서버에서 DOCUMENT_ID_RE 를 읽어야 한다')
  assert.ok(approvalLine.includes(`export const APPROVAL_DOCUMENT_ID_RE = ${server}`),
    `화면의 결재 문서 id 모양이 서버(${server})와 달라졌다`)
  // 아침 요약이 원 알림의 자리를 그대로 물려받는지는 서버가 답한다(요약이 유형표로 다시 찍으면
  // page 와 focusId 가 갈린다). server/notification-policy.test.mjs 가 값으로 잰다.
})

test('직원 화면의 결재 배지는 관리자 전용 제안 수를 세지 않는다', () => {
  // /api/proposals 는 requireTenantAdmin 이고 제안 패널도 isAdmin 으로 감춰져 있다. 그런데
  // proposal SSE 프레임은 테넌트 전원에게 간다 — role 검사 없이 받으면 직원은 결재 0건인 화면을
  // 「결재·검토 대기 1건」으로 알고 눌러 들어가 빈 화면을 본다.
  assert.match(app, /if \(isTenantAdmin && event\.kind === 'proposal'/, 'SSE 제안 프레임은 관리자 세션만 배지에 그린다')
  assert.equal(count(app, /setPendingProposals\(event\.data\.pending\)/g), 1, '제안 수를 SSE 에서 받는 곳은 한 군데다')
})

test('관리자는 내려둔 양식을 화면에서 되살릴 수 있다', () => {
  const section = approvalFiles['ApprovalDocumentSection.tsx']
  assert.match(section, /\/api\/approval-forms\$\{isAdmin \? '\?all=1' : ''\}/,
    '관리자 목록이 ?all=1 을 부르지 않으면 「다시 쓰기」 버튼에 도달할 길이 없다')
  const admin = approvalFiles['ApprovalFormAdmin.tsx']
  assert.match(admin, /form\.active === false \? '다시 쓰기' : '내리기'/)
  assert.match(approvalFiles['ApprovalDraftDialog.tsx'], /forms\.filter\(\(form\) => form\.active !== false\)/,
    '기안에서는 내려둔 양식을 고를 수 없어야 한다')
})

test('결재 첨부는 대화상자를 떠나지 않고 이름과 함께 내려받는다', () => {
  const detail = approvalFiles['ApprovalDetailDialog.tsx']
  assert.match(detail, /downloadAttachmentFrom/, '바이트를 받아 저장하는 방법은 한 곳에만 둔다')
  assert.doesNotMatch(detail, /onOpenEvidence\?\.\('documents'/,
    "App 이 'documents' focusId 를 버리므로 화면만 갈아 끼우고 상세가 닫힌다")
  // 이름 없는 링크는 무엇을 받는지 말하지 않는다. 서버가 준 이름을 그대로 쓴다.
  assert.match(detail, /attachments\?:\s*\{ id: string; name\?: string; canRead: boolean \}\[\]/)
  assert.match(detail, /catch/, '네트워크 호출에는 try\/catch 가 붙는다')
})

test('양식 항목은 순서를 바꿀 수 있고, 금액 후보는 저장할 때와 같은 키로 뽑는다', () => {
  const admin = approvalFiles['ApprovalFormAdmin.tsx']
  assert.match(admin, /const moveField = /, '항목 순서를 바꿀 길이 없으면 중간에 빠뜨린 항목을 되살릴 수 없다')
  assert.match(admin, /aria-label=\{`항목 \$\{index \+ 1\} 위로`\}/)
  assert.match(admin, /aria-label=\{`항목 \$\{index \+ 1\} 아래로`\}/)
  // 「무엇이 이 항목의 키인가」를 답하는 곳은 하나여야 한다 — bodyOf 와 다른 잣대로 고르면
  // 한글 라벨만 적은 money 항목이 금액 집계 후보에서 사라지고 amountFieldKey 가 null 로 저장된다.
  assert.match(admin, /const withKeys = \(\) => fields\.map\(\(field, position\) => \(\{ \.\.\.field, key: keyOf\(field, position\) \}\)\)/)
  assert.match(admin, /const moneyFields = withKeys\(\)\.filter\(\(field\) => field\.type === 'money'\)/)
})

test('승인된 지출 패널은 증빙 파일함의 일부가 아니다', () => {
  // 증빙 파일함 섹션 안에 넣으면 aria-labelledby 가 그 이름을 결재 지출에도 씌운다.
  assert.match(taxWorkspace, /<ApprovalSpendPanel workspaceScope=\{workspaceScope\} canManage=\{canManage\} \/>\s*\n\s*<section className="tax-section-panel" aria-labelledby="tax-evidence-title">/,
    '패널은 증빙 파일함 섹션 바로 위 형제여야 한다')
})

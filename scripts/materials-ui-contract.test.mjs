import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('문서 메뉴 하나에 문서 · 회의록 · 검토 자료 탭 — 회의록 메뉴는 따로 없고 옛 주소는 회의록 탭으로 온다', async () => {
  const hub = await read('src/components/DocumentsHub.tsx')
  for (const label of ['문서', '회의록', '검토 자료']) assert.match(hub, new RegExp(`label: '${label}'`))
  assert.match(hub, /role="tablist"/)
  const registry = await read('src/modules/registry.ts')
  const core = /id: 'core'[\s\S]*?routes: \[([^\]]*)\]/.exec(registry)?.[1] ?? ''
  assert.doesNotMatch(core, /'meetings'/, '사이드바에 회의록이 따로 없다')
  const app = await read('src/App.tsx')
  assert.match(app, /if \(requestedPage === 'meetings'\) setDocumentsTab\('meetings'\)/)
  assert.match(app, /case 'meetings':\s*\n\s*case 'wiki': return <DocumentsHub/)
  assert.match(app, /meetings=\{<MeetingNotesPage /)
  assert.match(app, /materials=\{<MaterialsPage /)
})

test('검토 자료 원본은 격리된 칸에서만 그린다 — allow-same-origin 없이, 보낸 창을 확인하고', async () => {
  const frame = await read('src/components/materials/MaterialFrame.tsx')
  assert.match(frame, /sandbox="allow-scripts"/)
  assert.doesNotMatch(frame, /allow-same-origin|allow-popups|allow-forms|allow-top-navigation/)
  assert.match(frame, /event\.source !== frameRef\.current\.contentWindow/)
  assert.match(frame, /외부 사이트를 열까요\?/)
  assert.match(frame, /noopener,noreferrer/)
})

test('자료실의 HTML 줄에서 [함께 검토하기] — 파일을 다시 올리지 않는다', async () => {
  const library = await read('src/components/CompanyLibrary.tsx')
  assert.match(library, /함께 검토하기/)
  assert.match(library, /materialFromDocument\(workspaceScope, document\.id\)/)
  const app = await read('src/App.tsx')
  assert.match(app, /onReviewMaterial=\{\(materialId\) => \{ setMaterialFocusId\(materialId\); navigate\('wiki'\) \}\}/)
})

test('검토 자료 화면: 네 버튼(찬성·수정해서·반대·질문)과 결정 네 가지, 읽기 모드가 휴대폰·큰 글자에서 먼저 열린다', async () => {
  const review = await read('src/components/materials/MaterialReview.tsx')
  const api = await read('src/components/materials/materialsApi.ts')
  assert.match(api, /STANCE_LABELS: Record<Stance, string> = \{ agree: '찬성', amend: '수정해서', oppose: '반대', question: '질문' \}/)
  assert.match(api, /DECISION_OPTIONS = \['반영', '수정 후 반영', '보류', '미반영'\]/)
  assert.match(review, /preferReading \|\| window\.innerWidth <= 768 \? 'reading' : 'original'/)
  assert.match(review, /aria-pressed=\{pressed\}/, '누른 생각은 보조기기에도 눌렸다고 알린다')
  assert.match(review, /writeDraft\(key, text\)/, '보내지 못한 의견은 기기에 남겨 둔다')
  const app = await read('src/App.tsx')
  assert.match(app, /preferReading=\{fontSize !== 'standard' \|\| easyMode === 'easy'\}/)
  assert.match(app, /if \(event\.kind === 'material'\) window\.dispatchEvent\(new CustomEvent\('itf:material'/)
})

test('휴대폰: 메뉴·알림으로 다른 화면에 가면 그 화면이 보인다(더보기 탭 아래)', async () => {
  const app = await read('src/App.tsx')
  assert.match(app, /if \(phoneShell\) \{ setMobileTab\(nextPage === 'tasks' \? 'tasks' : nextPage === 'ai' \? 'today' : 'more'\); setMessengerOpen\(false\) \}/)
})

test('검토 자료 머리글: 자주 쓰는 셋(검토 요청·회의 준비·결정 요약)만 밖에, 나머지는 [더 보기]에 접는다', async () => {
  const page = await read('src/components/materials/MaterialsPage.tsx')
  const header = page.slice(page.indexOf('<div className="page-header-actions">', page.indexOf('function MaterialDetailView')), page.indexOf('</header>', page.indexOf('function MaterialDetailView')))
  const buttons = header.match(/<Button /g) ?? []
  assert.ok(buttons.length <= 3, `머리글 버튼 ${buttons.length}개 — 셋을 넘지 않는다`)
  assert.match(header, /<MoreMenu items=/)
  for (const label of ['판 비교', '새 판 올리기', '다음 판 요청서', '원본 내려받기', '전체 기록 내려받기 (ZIP)']) assert.ok(header.includes(label), `${label}은(는) 더 보기에 있다`)
  const menu = await read('src/components/ui/MoreMenu.tsx')
  assert.match(menu, /aria-haspopup="menu"/)
  assert.match(menu, /event\.key === 'Escape'/)
  assert.match(menu, /ArrowDown/)
})

test('회의 진행 모드: 결정 전 항목을 한 장씩 크게, ←·→ 키, 결정권자는 그 자리에서 결정', async () => {
  const review = await read('src/components/materials/MaterialReview.tsx')
  assert.match(review, /function MeetingMode\(/)
  assert.match(review, /includeDecided \|\| !decisionOf\(anchor\.lineageId\)/)
  assert.match(review, /event\.key === 'ArrowRight'/)
  assert.match(review, /renderPanel=\{\(anchor\) => thread\(anchor\)\}/, '결정 상자·찬반·AI 초안은 같은 스레드 한 벌을 쓴다')
})

test('결정 → 업무는 승인 큐 한 길, AI 정리는 초안으로 보이고 근거 수를 함께 말한다', async () => {
  const decisions = await read('src/components/materials/MaterialDecisions.tsx')
  assert.match(decisions, /proposeMaterialTask\(/)
  assert.match(decisions, /approveProposal\(workspaceScope, proposalId\)/)
  const api = await read('src/components/materials/materialsApi.ts')
  assert.match(api, /\/api\/proposals\/\$\{encodeURIComponent\(proposalId\)\}\/decide/, '[바로 승인]은 기존 결정 라우트다')
  const synthesis = await read('src/components/materials/MaterialSynthesis.tsx')
  assert.match(synthesis, /<span className="material-ai-badge">초안<\/span>/)
  assert.match(synthesis, /근거 의견 \{point\.feedbackIds\.length\}개/)
  assert.match(synthesis, /AI가 아니라 <strong>찬반·의견을 세는 규칙<\/strong>/)
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
const stylesSource = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8')
const workPageSource = appSource.slice(appSource.indexOf('function WorkPage('), appSource.indexOf('function InventoryPage('))
const completionSource = appSource.slice(appSource.indexOf('function CompletionModal('), appSource.indexOf('function WorkReviewModal('))
const taskModalSource = appSource.slice(appSource.indexOf('function TaskModal('), appSource.indexOf('function SupportSessionModal('))

test('업무 내부 상태는 쉬운 표시 문구로 변환한다', () => {
  for (const [internal, display] of [
    ['업무요청', '시작 전'],
    ['수행중', '진행 중'],
    ['결재대기', '확인 기다리는 중'],
    ['결재완료', '완료'],
  ]) assert.match(appSource, new RegExp(`'${internal}': '${display}'`))
  assert.doesNotMatch(workPageSource, />\{drawerItem\.status\}</)
})

test('보드는 4단계 칼럼과 카드별 기본 행동 버튼 하나를 제공한다', () => {
  for (const label of ['요청됨', '진행 중', '결재 대기', '완료']) assert.match(workPageSource, new RegExp(`label: '${label}'`))
  for (const label of ['업무 시작', '완료 보고', '보완 후 재제출', '검토하기']) assert.match(workPageSource, new RegExp(`'${label}'`))
  assert.match(workPageSource, /event\.stopPropagation\(\); action\.run\(\)/)
  assert.match(stylesSource, /\.workflow-board \{ display: grid; grid-template-columns: repeat\(4,minmax\(0,1fr\)\)/)
  assert.match(stylesSource, /\.workflow-card-action \{/)
})

test('업무 카드의 키보드 상세 열기는 자식 행동 버튼의 Enter·Space를 가로채지 않는다', () => {
  assert.match(workPageSource, /onKeyDown=\{\(event\) => \{ if \(event\.target === event\.currentTarget && \(event\.key === 'Enter' \|\| event\.key === ' '\)\)/)
})

test('시작부터 완료 제출까지 3클릭 흐름을 유지한다', () => {
  assert.match(workPageSource, /item\.status === '업무요청'\) return \{ label: '업무 시작', run: \(\) => void onTransition\(item\.id, 'accept'\) \}/)
  assert.match(workPageSource, /setDialog\(\{ type: 'completion', item \}\)/)
  assert.match(completionSource, /<h2 id="completion-modal-title">완료 보고하기<\/h2>/)
  assert.match(completionSource, /무엇을 했나요\? <em>필수<\/em>/)
  assert.match(completionSource, /사진·파일 첨부 <small>선택<\/small>/)
  assert.match(completionSource, /제출하면 \{item\.requestedBy\}님에게 확인 요청이 갑니다\./)
  assert.match(completionSource, /> 제출<\/button>/)
})

test('최신 보완 사유와 완료 기준은 상세 드로어에서만 조건부 표시한다', () => {
  assert.equal((workPageSource.match(/drawerItem\.review\?\.requestedChanges/g) ?? []).length, 1)
  assert.match(workPageSource, /explicitCompletionCriteria\(drawerItem\) && <section/)
  assert.doesNotMatch(completionSource, /수정 요청 내용/)
  assert.match(workPageSource, /aria-label="진행 이력"/)
})

test('새 업무 지시는 필수 3칸과 접힌 선택 항목으로 구성한다', () => {
  for (const label of ['무엇을', '누가', '언제까지']) assert.match(taskModalSource, new RegExp(`${label} <em>필수</em>`))
  assert.match(taskModalSource, /initialDescription = ''/)
  assert.match(taskModalSource, /<details className="task-optional-fields" open=\{Boolean\(initialDescription\)\}>/)
  assert.match(stylesSource, /\.task-optional-fields:not\(\[open\]\) > \.task-optional-fields-body \{ display: none; \}/)
  for (const label of ['우선순위', '완료 기준', '사진·파일']) assert.match(taskModalSource, new RegExp(label))
  assert.doesNotMatch(taskModalSource, /담당자가 업무 내용을 확인하고 완료 결과를 남깁니다/)
})

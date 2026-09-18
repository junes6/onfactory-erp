import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const registry = read('src/modules/registry.ts')
const app = read('src/App.tsx')
const queue = read('src/components/ApprovalQueue.tsx')
const mobile = read('src/components/MobileShell.tsx')
const server = read('server/app.mjs')

test("'결재'는 승인 큐 한 메뉴에만 — 업무 메뉴는 '업무', 업무의 마지막 단계는 '확인'", () => {
  assert.match(registry, /tasks: \{ id: 'tasks', label: '업무',/)
  assert.doesNotMatch(registry, /label: '업무지시 · 결재'/)
  assert.match(app, /<PageHeader eyebrow="WORKFLOW" title="업무"/, '메뉴 이름과 화면 제목이 같다')
  assert.match(app, /\{mode === 'approve' \? '완료 확인' : '보완 요청'\}/)
  assert.match(mobile, /if \(status === '결재대기'\) return '확인하기'/)
  assert.match(server, /title: `확인 요청: \$\{next\.title\}`/, '업무 완료 보고 알림은 전자결재의 "결재 요청"과 다른 말')
  // 메뉴 이름과 화면 제목이 달랐던 두 곳.
  const business = read('src/components/BusinessPages.tsx')
  assert.match(business, /<h1>제품관리<\/h1>/)
  assert.match(business, /<h1>판매채널<\/h1>/)
})

test('결재 화면 머리에 "지금 내가 확인할 것" — 다른 화면에서 처리하는 것까지 길을 모은다', () => {
  assert.match(queue, /<strong>지금 내가 확인할 것<\/strong>/)
  assert.match(queue, /업무 완료 확인 \{elsewhere\.tasks\}건/)
  assert.match(queue, /업무일지 결재 \{elsewhere\.journals\}건/)
  assert.match(queue, /휴가 결재 \{elsewhere\.leaves\}건/)
  assert.match(server, /app\.get\('\/api\/inbox\/summary'/)
  assert.match(app, /elsewhere=\{\{ tasks: scopedWorkItems\.filter\(\(item\) => item\.status === '결재대기' && item\.requesterId === account\?\.id\)\.length, \.\.\.inboxSummary \}\}/)
  // 대부분 '아직 데이터 없음'이던 승인률 카드는 접고, 결정이 쌓인 유형만.
  assert.match(queue, /<details className="approval-stats-fold">/)
  assert.match(queue, /stats\.filter\(\(stat\) => stat\.total > 0\)\.map/)
})

test('사이드바는 묶음(내 일·함께·회사·업종)으로 — 묶음 안 순서는 사람이 정한 순서, 고른 메뉴는 보이게', () => {
  // registry.ts는 확장자 없이 불러오는 화면 모듈이라 node로 직접 싣지 않고 원문으로 잰다.
  assert.ok(registry.includes("export const NAV_GROUP_ORDER = ['내 일', '함께', '회사'] as const"))
  assert.match(registry, /ai: '내 일', tasks: '내 일', approvals: '내 일', schedule: '내 일', journal: '내 일', judgement: '내 일',/)
  assert.match(registry, /wiki: '함께', projects: '함께', documents: '함께', meetings: '함께',/)
  assert.match(registry, /people: '회사', finance: '회사', ip: '회사',/)
  assert.ok(registry.includes('return NAV_GROUP_OF[id] ?? industryLabel'), '업종 모듈은 업종 이름 묶음')
  assert.match(app, /<span className="nav-group-caption" role="presentation">\{group\}<\/span>/)
  assert.match(app, /document\.querySelector\('\.nav-list button\.active'\)\?\.scrollIntoView\(\{ block: 'nearest' \}\)/)
})

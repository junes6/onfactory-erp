import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
const dashboard = await readFile(new URL('../src/components/DashboardWorkspace.tsx', import.meta.url), 'utf8')
const widget = await readFile(new URL('../src/components/PersonalTodoWidget.tsx', import.meta.url), 'utf8')

test('personal To-do is a default editable dashboard widget in standard and easy home', () => {
  assert.match(dashboard, /DashboardWidgetId = [^\n]*'todo'/)
  assert.match(dashboard, /\{ id: 'todo', visible: true, size: 'half' \}/)
  assert.match(app, /preference\.id === 'todo'/)
  assert.ok((app.match(/<PersonalTodoWidget/g) ?? []).length >= 2, 'standard and easy dashboard both render the personal To-do')
})

test('personal To-do supports direct input, checkbox completion, editing, deletion, and active AI sync', () => {
  for (const contract of [
    /name="title"[\s\S]*placeholder="할 일을 바로 입력하세요"/,
    /role="checkbox"/,
    /\/api\/personal-todos\/ai-sync/,
    /method: 'PATCH'/,
    /method: 'DELETE'/,
    /AI가 나에게 온 업무와 오늘 일지를 여기에 모읍니다\. 마감이 지난 것이 맨 위이고, 업무가 끝나면 저절로 체크됩니다/,
  ]) assert.match(widget, contract)
  assert.doesNotMatch(widget, /localStorage|sessionStorage/)
})

test('홈에서 같은 업무를 한 번만 — 내 할 일의 업무 줄이 다음 행동을 달고, 다음 업무 칸은 접는다(감사 live-ui-06)', () => {
  // 업무에서 온 줄: 체크(내 목록에서만 사라지는 닫기) 대신 그 업무의 다음 행동.
  assert.match(widget, /if \(work && todo\.status === 'open'\) \{/)
  assert.match(widget, /if \(item\.status === '업무요청'\) return '시작하기'/)
  assert.match(widget, /onClick=\{\(\) => onAdvanceTask\(work\)\}/)
  // 마감이 지난 것 먼저, 빨갛게.
  assert.match(widget, /\.filter\(\(item\) => item\.status === 'open'\)\.sort\(byUrgency\)/)
  assert.match(widget, /className=\{isOverdue\(todo\.dueAt\) \? 'is-overdue' : ''\}/)
  assert.match(app, /<PersonalTodoWidget workspaceScope=\{workspaceScope\} onNavigate=\{onNavigate\} onToast=\{onToast\} workItems=\{workItems\} currentUserId=\{currentUserId\} onOpenTask=\{onOpenTask\} onAdvanceTask=\{onAdvanceTask\} \/>/)
  // 쉬운 화면은 업무를 큰 목록으로 따로 보이므로 내 할 일에서 업무 줄을 뺀다.
  assert.match(app, /<PersonalTodoWidget workspaceScope=\{workspaceScope\} onNavigate=\{onNavigate\} onToast=\{onToast\} hideWorkItems \/>/)
  // '다음 업무'는 기본으로 접히고, 이미 저장된 배치도 판이 오를 때 한 번 접힌다.
  assert.match(dashboard, /\{ id: 'work', visible: false, size: 'half' \}/)
  assert.match(dashboard, /if \(version < 4\) migrated = migrated\.map\(\(item\) => item\.id === 'work' \? \{ \.\.\.item, visible: false \} : item\)/)
  // 중요 알림은 마감이 지난 업무를 먼저 올린다.
  assert.match(app, /const overdueWork = openWork\.filter\(\(item\) => item\.status !== '결재대기'/)
  assert.match(app, /const dashboardAlert = \(overdueWork\[0\]/)
})

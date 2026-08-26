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
    /AI는 배정 업무와 오늘 일지를 근거로 항목을 추가하고, 원본이 완료되면 자동 체크합니다/,
  ]) assert.match(widget, contract)
  assert.doesNotMatch(widget, /localStorage|sessionStorage/)
})

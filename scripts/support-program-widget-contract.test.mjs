import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const dashboard = await readFile(new URL('../src/components/DashboardWorkspace.tsx', import.meta.url), 'utf8')
const widget = await readFile(new URL('../src/components/SupportProgramsWidget.tsx', import.meta.url), 'utf8')
const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
const worker = await readFile(new URL('../worker/index.mjs', import.meta.url), 'utf8')

test('every tenant receives an editable government-support widget without disturbing saved layouts', () => {
  assert.match(dashboard, /DashboardWidgetId = [^\n]*'support'/)
  assert.match(dashboard, /\{ id: 'support', visible: true, size: 'wide' \}/)
  assert.match(dashboard, /for \(const fallback of defaultDashboardWidgets\)/)
  assert.match(app, /preference\.id === 'support'/)
  assert.match(app, /<SupportProgramsWidget workspaceScope=\{workspaceScope\}/)
})

test('the widget exposes honest live, stale and unconfigured states with official new-window links', () => {
  assert.match(widget, /공공데이터 연동 전입니다/)
  assert.match(widget, /마지막 동기화 자료입니다/)
  assert.match(widget, /target="_blank" rel="noreferrer noopener"/)
  assert.match(widget, /K-Startup 모집중 공고/)
  assert.match(widget, /기업마당 지원사업 공고/)
  assert.doesNotMatch(widget, /샘플|추천 사업/)
})

test('Sites keeps the global feed in a D1 cache and injects server-only keys', () => {
  assert.match(worker, /CREATE TABLE IF NOT EXISTS support_program_feed_cache/)
  assert.match(worker, /createD1SupportProgramCache\(runtimeEnv\.DB\)/)
  assert.match(worker, /kstartupServiceKey: runtimeEnv\.KSTARTUP_SERVICE_KEY/)
  assert.doesNotMatch(widget, /KSTARTUP_SERVICE_KEY|BIZINFO_CERT_KEY/)
})

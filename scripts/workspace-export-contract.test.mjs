import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('회사 데이터 전체 내보내기는 관리자 설정에서, 링크 내려받기로(감사 data-core-13)', () => {
  const app = read('src/App.tsx')
  const drawer = read('src/components/AccessExperience.tsx')
  assert.ok(app.includes("onExportCompany={account?.role === 'tenant-admin' ? exportCompanyData : undefined}"), '관리자에게만')
  assert.ok(app.includes("fetch('/api/export/workspace', { method: 'POST'"), '한 번 쓰는 주소를 받아')
  assert.ok(app.includes('anchor.href = body.url'), '링크로 연다 — 큰 묶음을 화면 메모리에 담지 않는다')
  assert.ok(drawer.includes('{!guestMode && onExportCompany && <section className="setting-section">'))
  assert.ok(drawer.includes('1:1 대화와 개인 기록(AI 대화·내 할 일·알림)은 담지 않습니다.'))
  const server = read('server/workspace-export.mjs')
  for (const key of ['ai-conversations', 'personal-todos', 'notifications', 'push-subscriptions']) assert.ok(server.includes(`'${key}'`), `${key}는 담지 않는다`)
  assert.ok(server.includes("'calendar-connections'"))
})

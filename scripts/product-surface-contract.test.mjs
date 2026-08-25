import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('shared access copy stays industry-neutral across login and password onboarding', () => {
  const source = read('src/components/AccessExperience.tsx')
  assert.equal(source.includes('FOOD OPERATIONS CLOUD'), false)
  assert.equal(source.includes('공장의 오늘'), false)
  assert.equal(source.match(/BUSINESS OPERATIONS CLOUD/g)?.length, 2)
  assert.match(source, /회사의 오늘을/)
  assert.match(source, /업종별 모듈과 AI/)
})

test('tenant workspaces cannot navigate to or render cost and point surfaces', () => {
  const app = read('src/App.tsx')
  const tenantNavigation = app.match(/const tenantNavAll:[\s\S]*?\/\/ 메뉴 =/)?.[0] ?? ''
  assert.ok(tenantNavigation, 'tenant navigation block must remain discoverable')
  assert.doesNotMatch(tenantNavigation, /billing|비용\s*·\s*포인트|포인트 사용량|AI 포인트/)
  assert.doesNotMatch(app, /nextPage !== 'billing'/)

  const registry = read('src/modules/registry.ts')
  const coreModule = registry.match(/id: 'core',[\s\S]*?\n\s*},/)?.[0] ?? ''
  assert.ok(coreModule, 'core module block must remain discoverable')
  assert.doesNotMatch(coreModule, /['"]points['"]|billing/)

  const billing = read('src/components/BillingDashboard.tsx')
  assert.doesNotMatch(billing, /TenantPointGaugeCard|mode\s*===\s*['"]tenant['"]|BillingMode\s*=\s*['"]platform['"]\s*\|/)
})

test('cost and point dashboard route is guarded by the existing platform operator middleware', () => {
  const routes = read('server/billing-routes.mjs')
  assert.match(routes, /app\.get\('\/api\/billing\/dashboard',\s*requireAuth,\s*requirePlatformOperator,/)

  const service = read('server/billing-service.mjs')
  assert.match(service, /'dashboard:read',[\s\S]*?'configuration:read'/)
  assert.match(service, /dashboard:\s*\{[^}]*auth:\s*'platform-operator'/)
})

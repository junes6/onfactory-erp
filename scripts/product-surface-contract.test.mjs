import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

function contrastRatio(left, right) {
  const luminance = (hex) => {
    const channels = hex.match(/[0-9a-f]{2}/gi).map((part) => Number.parseInt(part, 16) / 255)
      .map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2]
  }
  const values = [luminance(left), luminance(right)]
  return (Math.max(...values) + .05) / (Math.min(...values) + .05)
}

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
  const registry = read('src/modules/registry.ts')
  const tenantNavigation = registry.match(/const routeNavigation:[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(tenantNavigation, 'registry-backed tenant navigation block must remain discoverable')
  assert.doesNotMatch(tenantNavigation, /billing|비용\s*·\s*포인트|포인트 사용량|AI 포인트/)
  assert.doesNotMatch(app, /nextPage !== 'billing'/)

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

test('dark mode uses one readable semantic token system across every workspace', () => {
  const tokens = read('src/tokens.css')
  const dark = tokens.match(/html\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
  assert.ok(dark, 'dark token block must exist')
  const color = (name) => dark.match(new RegExp(`${name}\\s*:\\s*(#[0-9A-Fa-f]{6})`))?.[1]
  const page = color('--color-page')
  const surface = color('--color-surface')
  const ink = color('--color-ink')
  const muted = color('--color-gray-600')
  const line = color('--color-card-line')
  assert.ok(page && surface && ink && muted && line, 'dark semantic colors must be fixed color tokens')
  assert.ok(contrastRatio(ink, surface) >= 7, 'dark body text must reach enhanced contrast')
  assert.ok(contrastRatio(muted, surface) >= 4.5, 'dark secondary text must remain readable')
  assert.ok(contrastRatio(line, surface) >= 1.6, 'dark card boundaries must remain visible')
  assert.notEqual(page.toLowerCase(), surface.toLowerCase())

  const css = [
    'src/styles.css',
    'src/components/FactoryManagement.css',
    'src/components/PeopleOperations.css',
  ].map(read).join('\n')
  assert.doesNotMatch(css, /(?:^|[;{]\s*)color\s*:\s*var\(--(?:[\w-]+-soft|surface)\)/m)
})

test('factory editor keeps the canvas and inspector visible together on desktop', () => {
  const component = read('src/components/FactoryManagement.tsx')
  const css = read('src/components/FactoryManagement.css')

  assert.match(component, /aria-label=\{`\$\{factory\.name\} 블록 배치 편집기`\}/)
  assert.match(component, /블록 드래그 이동 · 모서리 크기 조절 · 배경 드래그 이동 · 휠 확대\/축소/)
  assert.match(component, /addBlock\('벽'\)/)
  assert.match(component, /addBlock\('문'\)/)
  assert.match(component, /className="is-primary" onClick=\{\(\) => void addBlock\(\)\}/)
  assert.match(component, /오른쪽 패널에서 이름·용도·색상·위치·크기·품목·재고와 상세 위치를 한 화면에서 바로 편집합니다/)
  assert.match(component, /const updateBlock = [\s\S]*?setLayouts\(\(current\) => \{[\s\S]*?const blocks = current\[factory\.id\] \?\? \[\][\s\S]*?const currentBlock = blocks\.find[\s\S]*?normalizeBlockGeometry\(\{ \.\.\.currentBlock, \.\.\.patch \}\)/)
  assert.match(component, /const queueGesturePersist = [\s\S]*?onChange\(id, \{\}, true\)[\s\S]*?220/)
  assert.equal(component.match(/onLostPointerCapture=\{stop(?:Pointer|Resize)\}/g)?.length, 2)

  assert.match(css, /\.factory-workspace\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+370px[^}]*min-height:\s*700px/)
  assert.match(css, /\.factory-layout-viewport\s*\{[^}]*min-height:\s*610px/)
  assert.match(css, /\.factory-layout-sidebar\s*\{[^}]*max-height:\s*760px[^}]*overflow-y:\s*auto/)
  assert.match(css, /@media \(max-width:\s*1120px\)[\s\S]*?\.factory-workspace\s*\{\s*grid-template-columns:\s*1fr/)
  assert.doesNotMatch(css, /\.factory-(?:map-frame|layout-viewport|layout-editor)[^}]*72vh/)
})

test('easy screen is isolated to the AI home and never enlarges workspaces', () => {
  const app = read('src/App.tsx')
  const settings = read('src/components/AccessExperience.tsx')

  assert.match(app, /const easyHomeActive = mode === 'tenant' && page === 'ai' && easyMode === 'easy'/)
  assert.match(app, /document\.documentElement\.dataset\.easyMode = easyHomeActive \? 'on' : 'off'/)
  assert.equal(app.match(/easyMode=\{easyHomeActive\}/g)?.length, 2)
  assert.doesNotMatch(app, /easyMode=\{easyMode === 'easy'\}/)
  assert.match(settings, /메인 화면만 큰 바로가기와 지금 할 일 중심으로 단순화합니다\. 다른 업무 화면은 기본 배치를 유지합니다\./)
})

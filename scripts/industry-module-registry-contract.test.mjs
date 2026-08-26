import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('industry registry is the single source for tenant navigation and exposes the IT project route', () => {
  const registry = read('src/modules/registry.ts')
  const app = read('src/App.tsx')
  const itModule = registry.match(/id: 'it-services',[\s\S]*?\n\s*},/)?.[0] ?? ''

  assert.match(itModule, /routes:\s*\['it-projects', 'it-deliverables', 'it-contracts'\]/)
  assert.match(registry, /const routeNavigation:\s*Readonly<Record<TenantRouteId, NavigationModuleItem>>/)
  assert.match(registry, /'it-projects':\s*\{ id: 'it-projects', label: '프로젝트'/)
  assert.match(registry, /navigationForIndustry[\s\S]*?isItServices && route === 'projects'/)
  assert.match(app, /navigationForIndustry\(account\?\.industryType\)/)
  assert.doesNotMatch(app, /const tenantNavAll:/)
  assert.match(app, /case 'it-projects': return <ProjectSpacesPage/)
})

test('industry-aware assistant and library copy is resolved by the registry, not screen conditionals', () => {
  const registry = read('src/modules/registry.ts')
  const chat = read('src/components/AIChat.tsx')
  const library = read('src/components/CompanyLibrary.tsx')

  assert.match(registry, /export function assistantExperienceForIndustry/)
  assert.match(registry, /export function librarySearchPlaceholderForIndustry/)
  assert.match(chat, /assistantExperienceForIndustry\(industryType,/)
  assert.match(chat, /assistantExperience\.suggestions\.map/)
  assert.match(library, /placeholder=\{librarySearchPlaceholderForIndustry\(industryType\)\}/)
  assert.doesNotMatch(chat, /industryType\s*===/)
  assert.doesNotMatch(library, /industryType\s*===/)
})

test('tenant breadcrumb labels come from the same route registry as the sidebar', () => {
  const registry = read('src/modules/registry.ts')
  const app = read('src/App.tsx')

  assert.match(registry, /export function routeLabel/)
  assert.match(app, /routeLabel\(page as TenantRouteId\)/)
  assert.doesNotMatch(app, /const pageTitles:\s*Record<PageId/)
})

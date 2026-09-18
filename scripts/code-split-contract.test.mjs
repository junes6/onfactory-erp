import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const lazyPages = readFileSync(new URL('../src/lazyPages.tsx', import.meta.url), 'utf8')

test('첫 화면에 필요 없는 화면은 나눠 싣는다 — App이 화면 모듈을 값으로 직접 부르지 않는다', () => {
  const heavy = ['ProjectSpaces', 'TaxAssets', 'IpRights', 'BusinessPages', 'BillingDashboard', 'CompanyLibrary', 'wiki/WikiPage', 'MeetingNotes', 'DocumentsHub', 'materials/MaterialsPage', 'ComplianceCenter', 'FactoryManagement', 'PeopleOperations', 'ItServices', 'PlatformConsole', 'GuestWorkspace', 'LensPanel', 'PersonalCorePage', 'ApprovalQueue']
  for (const module of heavy) {
    const valueImport = new RegExp(`^import (?!type )[^\n]*from '\./components/${module.replace('/', '\/')}'`, 'm')
    assert.doesNotMatch(app, valueImport, `${module}는 lazyPages로만(타입은 import type)`)
    assert.ok(lazyPages.includes(`import('./components/${module}')`), `${module}는 lazyPages에서 나눠 싣는다`)
  }
  assert.ok(app.includes('<main id="main-content" className="main-content" tabIndex={-1}><Suspense fallback={<PageLoading />}>'), '화면 자리는 불러오는 동안 무엇을 하는지 말한다')
  assert.ok(app.includes("useEffect(() => { if (authStatus === 'signed-in') prefetchPages() }, [authStatus])"))
  assert.ok(lazyPages.includes("matchMedia?.('(min-width: 761px)')"), '미리 받기는 데스크톱만 — 휴대폰은 데이터를 아낀다')
})

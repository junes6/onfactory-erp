import assert from 'node:assert/strict'
import { CONSENT_ITEM_IDS } from './policies/consent-terms.mjs'
import test from 'node:test'

import { createApp } from './app.mjs'
import { DEMO_ACCOUNT_DEFINITIONS, PLATFORM_TENANT_FIXTURES } from './store/demo-seed.mjs'
import { withServer } from './test-server.mjs'

async function login(origin, email, workspace = 'tenant') {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace, email, password: 'demo1234' }),
  })
  return { response, cookie: response.headers.get('set-cookie') ?? '' }
}

const freshStore = () => ({
  version: 2, tenants: { 'TENANT-SUNSEA': {}, 'TENANT-3DMUSE': {} }, platform: {},
  accountApprovals: {}, accountCredentials: {}, invitedAccounts: [], passwordResetRequests: [],
})

test('demo seed includes the it_services tenant 3D뮤즈 with one admin', () => {
  const muse = PLATFORM_TENANT_FIXTURES.find((tenant) => tenant.id === 'TENANT-3DMUSE')
  assert.ok(muse, '3D뮤즈 시드가 있어야 한다')
  assert.equal(muse.industryType, 'it_services')
  const admins = DEMO_ACCOUNT_DEFINITIONS.filter((account) => account.tenantId === 'TENANT-3DMUSE')
  assert.equal(admins.length, 1)
  assert.equal(admins[0].role, 'tenant-admin')
})

test('session carries industryType and IT workspace keys are writable while food keys stay untouched', async () => {
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: freshStore(), onWorkspaceStoreChange: () => {} }), async (origin) => {
    const muse = await login(origin, 'admin@3dmuse.demo')
    assert.equal(muse.response.status, 200)
    const museBody = await muse.response.json()
    assert.equal(museBody.account.industryType, 'it_services')
    assert.equal(museBody.account.tenantId, 'TENANT-3DMUSE')

    const sunsea = await login(origin, 'admin@sunsea.co.kr')
    assert.equal((await sunsea.response.json()).account.industryType, 'food_manufacturing')

    const headers = { 'content-type': 'application/json', cookie: muse.cookie, 'x-workspace-identity': 'TENANT-3DMUSE:USR-3DMUSE-ADMIN' }
    const project = { id: 'PRJ-1', name: '전시 콘텐츠 제작', client: '○○박물관', status: '진행 중', owner: '김뮤즈', startDate: '2026-08-01', dueDate: '2026-09-30', amount: 12000000, note: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    const saveProject = await fetch(`${origin}/api/workspace/it-projects`, { method: 'PUT', headers, body: JSON.stringify({ data: [project] }) })
    assert.equal(saveProject.status, 200, await saveProject.text())
    const deliverable = { id: 'DLV-1', projectId: 'PRJ-1', name: '화면 설계서', version: 'v1.0', attachments: [], note: '', createdBy: '김뮤즈', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    const saveDeliverable = await fetch(`${origin}/api/workspace/it-deliverables`, { method: 'PUT', headers, body: JSON.stringify({ data: [deliverable] }) })
    assert.equal(saveDeliverable.status, 200, await saveDeliverable.text())
    const contract = { id: 'CTR-1', client: '○○박물관', title: '콘텐츠 제작 계약', startDate: '2026-08-01', endDate: '2026-12-31', amount: 12000000, attachments: [], note: '', updatedAt: new Date().toISOString() }
    const saveContract = await fetch(`${origin}/api/workspace/it-contracts`, { method: 'PUT', headers, body: JSON.stringify({ data: [contract] }) })
    assert.equal(saveContract.status, 200, await saveContract.text())

    const readBack = await (await fetch(`${origin}/api/workspace/it-projects`, { headers: { cookie: muse.cookie, 'x-workspace-identity': 'TENANT-3DMUSE:USR-3DMUSE-ADMIN' } })).json()
    assert.equal(readBack.data[0].name, '전시 콘텐츠 제작')

    // 플랫폼 상태의 업종 배지와 변경 라우트
    const operator = await login(origin, 'operator@onfactory.co.kr', 'platform')
    const state = await (await fetch(`${origin}/api/platform/state`, { headers: { cookie: operator.cookie } })).json()
    assert.equal(state.tenants.find((tenant) => tenant.id === 'TENANT-3DMUSE').industryType, 'it_services')
    assert.equal(state.tenants.find((tenant) => tenant.id === 'TENANT-SUNSEA').industryType, 'food_manufacturing')

    const invalid = await fetch(`${origin}/api/platform/tenants/TENANT-3DMUSE`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: operator.cookie }, body: JSON.stringify({ industryType: 'unknown' }) })
    assert.equal(invalid.status, 400)
    const changed = await fetch(`${origin}/api/platform/tenants/TENANT-3DMUSE`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: operator.cookie }, body: JSON.stringify({ industryType: 'food_manufacturing' }) })
    assert.equal(changed.status, 200)
    assert.equal((await changed.json()).tenant.industryType, 'food_manufacturing')
    const session = await (await fetch(`${origin}/api/auth/session`, { headers: { cookie: muse.cookie } })).json()
    assert.equal(session.account.industryType, 'food_manufacturing', '업종 변경이 세션 신원에 즉시 반영된다')

    // 운영자가 테넌트를 만들 때 업종을 지정한다
    const created = await fetch(`${origin}/api/platform/tenants`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: operator.cookie },
      body: JSON.stringify({ companyName: '코드웍스', industry: 'SI · 유지보수', industryType: 'it_services', plan: 'Growth', adminName: '이개발', adminEmail: 'admin@codeworks.test', targetDate: '2026-10-01', consents: Object.fromEntries(CONSENT_ITEM_IDS.map((id) => [id, true])) }),
    })
    const createdText = await created.text()
    assert.equal(created.status, 201, createdText)
    assert.equal(JSON.parse(createdText).tenant.industryType, 'it_services')
  })
})

test('an existing tenant named 3D뮤즈 without industryType is migrated to it_services and the demo fixture is not duplicated', async () => {
  const store = freshStore()
  store.tenants = { 'TENANT-REAL-MUSE': {} }
  store.platform = { tenants: [{ id: 'TENANT-REAL-MUSE', name: '3D뮤즈', industry: '3D 콘텐츠', contract: '온보딩', plan: 'Growth', adminEmail: 'owner@3dmuse.real', adminAccount: { id: 'USR-TENANT-REAL-MUSE-ADMIN', name: '대표', email: 'owner@3dmuse.real', team: '경영지원', jobRole: '운영 관리자' }, createdAt: '2026-08-21T00:00:00.000Z' }], supportTickets: [], integrations: [], actions: [], auditEvents: [] }
  createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {} })
  const museTenants = store.platform.tenants.filter((tenant) => tenant.name === '3D뮤즈')
  assert.equal(museTenants.length, 1, '같은 이름의 데모 시드가 중복 추가되면 안 된다')
  assert.equal(museTenants[0].id, 'TENANT-REAL-MUSE')
  assert.equal(museTenants[0].industryType, 'it_services', '이름 기준으로 업종이 마이그레이션된다')
  assert.ok(store.platform.tenants.find((tenant) => tenant.id === 'TENANT-SUNSEA'))
})

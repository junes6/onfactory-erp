import assert from 'node:assert/strict'
import test from 'node:test'

import { createApp } from './app.mjs'
import { PLATFORM_TENANT_FIXTURES } from './store/demo-seed.mjs'
import { withServer } from './test-server.mjs'

async function login(origin, email, workspace = 'tenant') {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace, email, password: 'demo1234' }),
  })
  assert.equal(response.status, 200)
  return response.headers.get('set-cookie') ?? ''
}

const freshStore = () => ({
  version: 2, tenants: { 'TENANT-SUNSEA': {}, 'TENANT-POHANG': {} }, platform: {},
  accountApprovals: {}, accountCredentials: {}, invitedAccounts: [], passwordResetRequests: [], guestGrants: [],
})

test('demo tenant fixtures carry no fixed metric values', () => {
  for (const fixture of PLATFORM_TENANT_FIXTURES) {
    for (const field of ['users', 'activeUsers', 'integrations', 'sync', 'tickets', 'aiUsage', 'storage', 'health', 'csm', 'sites', 'service']) {
      assert.equal(Object.hasOwn(fixture, field), false, `${fixture.id}.${field} 고정 지표는 시드에 있으면 안 된다`)
    }
    assert.ok(['food_manufacturing', 'it_services'].includes(fixture.industryType))
  }
})

test('platform tenant metrics are live aggregates that move when a tenant creates work', async () => {
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: freshStore(), onWorkspaceStoreChange: () => {} }), async (origin) => {
    const operator = await login(origin, 'operator@onfactory.co.kr', 'platform')
    const before = await (await fetch(`${origin}/api/platform/state`, { headers: { cookie: operator } })).json()
    const sunseaBefore = before.tenants.find((tenant) => tenant.id === 'TENANT-SUNSEA')
    assert.ok(sunseaBefore.metrics, 'metrics 객체가 있어야 한다')
    for (const field of ['users', 'activeUsers', 'sync', 'aiUsage', 'storage', 'health', 'csm']) assert.equal(Object.hasOwn(sunseaBefore, field), false, `${field} 고정 문자열 지표는 응답에 없어야 한다`)
    assert.equal(typeof sunseaBefore.metrics.members, 'number')
    assert.ok(sunseaBefore.metrics.members >= 1, '멤버 수는 계정 테이블 집계')
    assert.equal(sunseaBefore.metrics.todayActivity, 0)
    assert.equal(sunseaBefore.metrics.lastActivityAt, null)
    assert.equal(sunseaBefore.industryType, 'food_manufacturing')

    // 햇살바다 관리자가 업무 1건 생성 → 오늘 활동 1, 마지막 활동 갱신
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const headers = { 'content-type': 'application/json', cookie: admin, 'x-workspace-identity': 'TENANT-SUNSEA:USR-SUNSEA-ADMIN' }
    const workItem = {
      id: 'WK-METRIC-1', title: '지표 반영 확인', description: '', owner: '박지현', ownerId: 'USR-SUNSEA-PARK',
      requestedBy: '김서원', requesterId: 'USR-SUNSEA-ADMIN', due: '2026-12-31T09:00:00.000Z', priority: '보통', status: '업무요청', category: '일반',
      createdAt: new Date().toISOString(),
    }
    const save = await fetch(`${origin}/api/workspace/work-items`, { method: 'PUT', headers, body: JSON.stringify({ data: [workItem] }) })
    assert.equal(save.status, 200, await save.text())

    const after = await (await fetch(`${origin}/api/platform/state`, { headers: { cookie: operator } })).json()
    const sunseaAfter = after.tenants.find((tenant) => tenant.id === 'TENANT-SUNSEA')
    assert.equal(sunseaAfter.metrics.todayActivity, 1)
    assert.ok(sunseaAfter.metrics.lastActivityAt, '마지막 활동 시각이 기록된다')
    assert.equal(sunseaAfter.service, sunseaAfter.metrics.openTickets > 0 ? '주의' : '정상', 'service는 미처리 티켓·24시간 무활동에서만 파생된다')

    // 미처리 티켓이 생기면 주의 신호
    const ticket = await fetch(`${origin}/api/platform/tickets`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: operator },
      body: JSON.stringify({ tenantId: 'TENANT-SUNSEA', title: '지표 테스트 티켓', priority: 'P2', owner: '미배정', description: '미처리 티켓 신호 확인' }),
    })
    assert.equal(ticket.status, 201, await ticket.text())
    const withTicket = await (await fetch(`${origin}/api/platform/state`, { headers: { cookie: operator } })).json()
    const sunseaTicket = withTicket.tenants.find((tenant) => tenant.id === 'TENANT-SUNSEA')
    assert.equal(sunseaTicket.metrics.openTickets, sunseaAfter.metrics.openTickets + 1, '새 티켓이 미처리 집계에 반영된다')
    assert.equal(sunseaTicket.service, '주의')
  })
})

test('platform member counts exclude external guests and expose them as guestCount', async () => {
  const store = freshStore()
  const guestId = 'USR-TENANT-SUNSEA-GUESTMETRIC'
  store.invitedAccounts.push({ id: guestId, email: 'metric.guest@partner.example', name: '홍거래', tenantId: 'TENANT-SUNSEA', tenantName: '햇살바다', team: '파트너상사', jobRole: '외부 게스트', requested: '게스트 초대', role: 'tenant-guest', guestGrantId: 'GST-METRIC' })
  store.accountApprovals[guestId] = 'approved'
  store.guestGrants.push({ id: 'GST-METRIC', tenantId: 'TENANT-SUNSEA', accountId: guestId, email: 'metric.guest@partner.example', name: '홍거래', orgName: '파트너상사', projectIds: [], invitedById: 'USR-SUNSEA-ADMIN', invitedByName: '김서원', status: 'active', tokenHash: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' })
  let membersWithoutGuest = null
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: freshStore(), onWorkspaceStoreChange: () => {} }), async (origin) => {
    const operator = await login(origin, 'operator@onfactory.co.kr', 'platform')
    const state = await (await fetch(`${origin}/api/platform/state`, { headers: { cookie: operator } })).json()
    const sunsea = state.tenants.find((tenant) => tenant.id === 'TENANT-SUNSEA')
    membersWithoutGuest = sunsea.metrics.members
    assert.equal(sunsea.metrics.guestCount, 0)
  })
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {} }), async (origin) => {
    const operator = await login(origin, 'operator@onfactory.co.kr', 'platform')
    const state = await (await fetch(`${origin}/api/platform/state`, { headers: { cookie: operator } })).json()
    const sunsea = state.tenants.find((tenant) => tenant.id === 'TENANT-SUNSEA')
    assert.equal(sunsea.metrics.members, membersWithoutGuest, '게스트는 인원 수에 들어가지 않는다')
    assert.equal(sunsea.metrics.guestCount, 1)
    assert.equal(sunsea.metrics.pendingAccounts, 1, '승인 대기 수에도 게스트는 없다(데모 신규 직원 1명만)')
  })
})

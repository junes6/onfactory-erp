import assert from 'node:assert/strict'
import test from 'node:test'

import { createApp } from './app.mjs'
import { withServer } from './test-server.mjs'

async function login(origin, email, workspace = 'tenant', password = 'demo1234') {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace, email, password }),
  })
  return { response, cookie: response.headers.get('set-cookie') ?? '' }
}

const freshStore = () => ({
  version: 2,
  tenants: { 'TENANT-SUNSEA': {}, 'TENANT-POHANG': {} },
  platform: {},
  accountApprovals: {},
  accountCredentials: {},
  invitedAccounts: [],
  passwordResetRequests: [],
  guestGrants: [],
})

test('platform operator logs in from either workspace selector and lands on the platform console', async () => {
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: freshStore(), onWorkspaceStoreChange: () => {} }), async (origin) => {
    const viaTenant = await login(origin, 'operator@onfactory.co.kr', 'tenant')
    assert.equal(viaTenant.response.status, 200, '운영자는 고객사 선택으로도 로그인되어야 한다')
    const body = await viaTenant.response.json()
    assert.equal(body.account.role, 'platform-operator')
    assert.equal(body.account.tenantId, null)
    assert.equal(body.account.operatorMode, undefined)

    const viaPlatform = await login(origin, 'operator@onfactory.co.kr', 'platform')
    assert.equal(viaPlatform.response.status, 200)

    const memberOnPlatform = await login(origin, 'jihyun.park@sunsea.co.kr', 'platform')
    assert.equal(memberOnPlatform.response.status, 403, '일반 계정의 플랫폼 콘솔 로그인은 계속 거부된다')
  })
})

test('operator enters a tenant, acts as its admin with audit trail, exits, and enters another tenant in one session', async () => {
  const store = freshStore()
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {} }), async (origin) => {
    const operator = await login(origin, 'operator@onfactory.co.kr', 'platform')
    assert.equal(operator.response.status, 200)
    const cookie = operator.cookie

    // 진입 전: 테넌트 데이터 접근은 막힌다
    const beforeEnter = await fetch(`${origin}/api/workspace/work-items`, { headers: { cookie } })
    assert.equal(beforeEnter.status, 403)

    // 햇살바다 접속
    const enter = await fetch(`${origin}/api/platform/tenants/TENANT-SUNSEA/enter`, { method: 'POST', headers: { cookie } })
    const enterText = await enter.text()
    assert.equal(enter.status, 200, enterText)
    const entered = JSON.parse(enterText)
    assert.equal(entered.account.role, 'tenant-admin')
    assert.equal(entered.account.tenantId, 'TENANT-SUNSEA')
    assert.equal(entered.account.id, 'USR-ONFACTORY-OPS')
    assert.equal(entered.account.operatorMode.operatorId, 'USR-ONFACTORY-OPS')
    assert.equal(entered.account.operatorMode.tenantName, '햇살바다')

    // 세션 조회도 같은 유효 신원을 돌려준다
    const session = await (await fetch(`${origin}/api/auth/session`, { headers: { cookie } })).json()
    assert.equal(session.account.operatorMode.tenantId, 'TENANT-SUNSEA')

    // 플랫폼 전용 라우트는 운영자 모드 동안 차단된다 (유효 신원이 tenant-admin이므로)
    const platformState = await fetch(`${origin}/api/platform/state`, { headers: { cookie } })
    assert.equal(platformState.status, 403)

    // 관리자 권한으로 업무 생성(요청자 = 운영자) → 결재 흐름 동작
    const identity = 'TENANT-SUNSEA:USR-ONFACTORY-OPS'
    const headers = { 'content-type': 'application/json', cookie, 'x-workspace-identity': identity }
    const workItem = {
      id: 'WK-OPMODE-1', title: '운영자 모드 테스트 업무', description: '', owner: '박지현', ownerId: 'USR-SUNSEA-PARK',
      requestedBy: '김서원', requesterId: 'USR-ONFACTORY-OPS', due: '2026-12-31T09:00:00.000Z', priority: '보통', status: '업무요청', category: '일반',
      createdAt: new Date().toISOString(),
    }
    const save = await fetch(`${origin}/api/workspace/work-items`, { method: 'PUT', headers, body: JSON.stringify({ data: [workItem] }) })
    assert.equal(save.status, 200, await save.text())
    const saved = await (await fetch(`${origin}/api/workspace/work-items`, { headers: { cookie, 'x-workspace-identity': identity } })).json()
    assert.equal(saved.data[0].requesterId, 'USR-ONFACTORY-OPS')

    // 잘못된 identity(다른 테넌트)는 여전히 차단
    const crossTenant = await fetch(`${origin}/api/workspace/work-items`, { headers: { cookie, 'x-workspace-identity': 'TENANT-POHANG:USR-ONFACTORY-OPS' } })
    assert.equal(crossTenant.status, 401)

    // 감사 기록: 접속 + 변경이 운영자 신원으로 남고, 테넌트 관리자 화면 API로 조회된다
    const accessLog = await (await fetch(`${origin}/api/operator-access-log`, { headers: { cookie } })).json()
    const events = accessLog.events.map((event) => event.event)
    assert.ok(events.includes('운영자 테넌트 접속'), `접속 이벤트가 있어야 한다: ${events.join(',')}`)
    assert.ok(events.includes('운영자 변경'), `변경 이벤트가 있어야 한다: ${events.join(',')}`)
    assert.ok(accessLog.events.every((event) => event.actor.startsWith('운영자 ')))

    // 나가기 → 다시 플랫폼 콘솔
    const exit = await fetch(`${origin}/api/platform/exit`, { method: 'POST', headers: { cookie } })
    assert.equal(exit.status, 200)
    const exited = await exit.json()
    assert.equal(exited.account.role, 'platform-operator')
    assert.equal(exited.account.operatorMode, undefined)
    const afterExit = await fetch(`${origin}/api/platform/state`, { headers: { cookie } })
    assert.equal(afterExit.status, 200)
    const platformAudit = await afterExit.json()
    assert.ok(platformAudit.auditEvents.some((event) => event.event === '운영자 테넌트 나가기' && event.tenantId === 'TENANT-SUNSEA'))

    // 같은 세션으로 다른 테넌트 접속
    const enterOther = await fetch(`${origin}/api/platform/tenants/TENANT-POHANG/enter`, { method: 'POST', headers: { cookie } })
    assert.equal(enterOther.status, 200)
    assert.equal((await enterOther.json()).account.tenantId, 'TENANT-POHANG')
  })
})

test('tenant admin sees the operator access history but regular member cross-tenant access stays blocked', async () => {
  const store = freshStore()
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {} }), async (origin) => {
    const operator = await login(origin, 'operator@onfactory.co.kr', 'platform')
    await fetch(`${origin}/api/platform/tenants/TENANT-SUNSEA/enter`, { method: 'POST', headers: { cookie: operator.cookie } })
    await fetch(`${origin}/api/workspace/work-items`, { headers: { cookie: operator.cookie, 'x-workspace-identity': 'TENANT-SUNSEA:USR-ONFACTORY-OPS' } })

    const admin = await login(origin, 'admin@sunsea.co.kr')
    const log = await (await fetch(`${origin}/api/operator-access-log`, { headers: { cookie: admin.cookie } })).json()
    assert.ok(log.events.length >= 1)
    assert.ok(log.events.every((event) => event.tenantId === 'TENANT-SUNSEA'))

    const member = await login(origin, 'jihyun.park@sunsea.co.kr')
    const memberLog = await fetch(`${origin}/api/operator-access-log`, { headers: { cookie: member.cookie } })
    assert.equal(memberLog.status, 403)
    const memberEnter = await fetch(`${origin}/api/platform/tenants/TENANT-POHANG/enter`, { method: 'POST', headers: { cookie: member.cookie } })
    assert.equal(memberEnter.status, 403)
  })
})

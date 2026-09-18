import assert from 'node:assert/strict'
import test from 'node:test'

import { createApp } from './app.mjs'
import { evaluateSentinel } from './proposal-engine.mjs'
import { withServer } from './test-server.mjs'

/**
 * P1-7(감사 ai-04): 센티널은 결정된 사안을 **조건이 이어지는 동안만** 조용히 두고, 풀렸다 다시 생기면 새로 알린다.
 * 센티널이 만든 업무는 센티널의 감시 대상이 아니다(자기 자신을 먹이로 불어나지 않는다). 새 경고는 관리자에게 알린다.
 */

const accounts = [{ id: 'U1', name: '박지현', tenantId: 'T', approved: true, role: 'tenant-member' }]
const evaluate = (tenantStore, existing, now) => evaluateSentinel({ tenantStore, existing, industryType: 'food_manufacturing', accounts, tenantId: 'T', now })

test('결정한 경고는 조건이 이어지는 동안 조용하고, 풀렸다 다시 생기면 새로 알린다', () => {
  const now = new Date('2026-08-22T03:00:00.000Z')
  const tenantStore = { 'product-catalog': { data: [{ id: 'P-1', name: '새우젓', stock: 2, safetyStock: 10 }] } }
  const first = evaluate(tenantStore, [], now)
  assert.equal(first.created, 1)
  // 관리자가 거절(또는 승인)했다.
  const decided = first.proposals.map((proposal) => ({ ...proposal, status: 'rejected', decidedAt: now.toISOString() }))
  assert.equal(evaluate(tenantStore, decided, now).created, 0, '재고가 여전히 모자란 동안에는 다시 올리지 않는다')

  tenantStore['product-catalog'].data[0].stock = 50 // 채워 넣었다 — 조건 해소
  const settled = evaluate(tenantStore, decided, now)
  assert.equal(settled.cleared, 1)
  assert.ok(settled.proposals[0].clearedAt, '결정에 해소 시각이 찍힌다(상태는 결정 그대로)')
  assert.equal(settled.proposals[0].status, 'rejected')

  tenantStore['product-catalog'].data[0].stock = 1 // 다시 모자라다
  const again = evaluate(tenantStore, settled.proposals, now)
  assert.equal(again.created, 1, '전에는 한 번 결정한 대상을 영구히 다시 알리지 않았다')
  assert.equal(again.proposals.filter((proposal) => proposal.status === 'pending').length, 1)
})

test('센티널이 만든 업무는 마감을 넘겨도 "마감 초과 점검"을 또 낳지 않는다', () => {
  const now = new Date('2026-08-22T03:00:00.000Z')
  const tenantStore = {
    'work-items': { data: [
      { id: 'WK-1', title: '라벨 교체', status: '업무요청', ownerId: 'U1', owner: '박지현', due: '2026-08-20T09:00:00.000Z' },
      { id: 'WK-2', title: '마감 초과 점검: 라벨 교체', status: '업무요청', ownerId: 'U1', owner: '박지현', due: '2026-08-21T09:00:00.000Z', origin: { kind: 'sentinel-task', label: '센티널 경고' } },
      { id: 'WK-3', title: '결재 처리: 설비 점검', status: '결재대기', ownerId: 'U1', owner: '박지현', due: '2026-08-30T09:00:00.000Z', completion: { submittedAt: '2026-08-19T00:00:00.000Z' }, origin: { kind: 'sentinel-task' } },
    ] },
  }
  const keys = evaluate(tenantStore, [], now).proposals.map((proposal) => proposal.sourceKey)
  assert.deepEqual(keys, ['sentinel:overdue:WK-1'])
})

test('새 경고는 관리자에게 알린다 — 많으면 한 줄로 묶는다', async () => {
  const store = { version: 2, tenants: { 'TENANT-SUNSEA': {
    'product-catalog': { data: [{ id: 'P-1', name: '새우젓', stock: 2, safetyStock: 10 }], updatedAt: '2026-09-18T00:00:00.000Z', updatedBy: 'seed' },
  } }, platform: {}, accountApprovals: {}, accountCredentials: {}, invitedAccounts: [], passwordResetRequests: [], guestGrants: [] }
  const app = createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {} })
  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: 'tenant', email: 'admin@sunsea.co.kr', password: 'demo1234' }) })
    const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0]
    app.locals.runSentinelForTenant('TENANT-SUNSEA')
    const items = (await (await fetch(`${origin}/api/notifications`, { headers: { cookie } })).json()).items ?? []
    const warning = items.find((item) => item.type === 'sentinel-warning')
    assert.ok(warning, '전에는 센티널 제안이 큐에 조용히 쌓였다')
    assert.match(warning.title, /새우젓/)
    assert.equal(warning.page, 'approvals')
  })
})

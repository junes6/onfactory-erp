import assert from 'node:assert/strict'
import test from 'node:test'

import { createApp } from './app.mjs'
import { withServer } from './test-server.mjs'

async function login(origin, email) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: 'tenant', email, password: 'demo1234' }),
  })
  assert.equal(response.status, 200, `${email} login`)
  return response.headers.get('set-cookie')
}

async function createPendingLeave(origin, cookie, reason) {
  const response = await fetch(`${origin}/api/leave-requests`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: '병가', period: '2099-01-05', days: 1, reason }),
  })
  const body = await response.json()
  assert.equal(response.status, 201, JSON.stringify(body))
  return body.leave
}

test('only the requester can cancel a pending leave; decided leave history remains immutable', async () => {
  await withServer(createApp({ apiKey: '' }), async (origin) => {
    const requester = await login(origin, 'taesik.oh@sunsea.co.kr')
    const colleague = await login(origin, 'jihyun.park@sunsea.co.kr')
    const admin = await login(origin, 'admin@sunsea.co.kr')

    const pending = await createPendingLeave(origin, requester, '취소 권한 회귀 테스트')
    const colleagueDelete = await fetch(`${origin}/api/leave-requests/${encodeURIComponent(pending.id)}`, {
      method: 'DELETE', headers: { cookie: colleague },
    })
    assert.equal(colleagueDelete.status, 403)
    assert.equal((await colleagueDelete.json()).error.code, 'LEAVE_REQUESTER_REQUIRED')

    const adminDelete = await fetch(`${origin}/api/leave-requests/${encodeURIComponent(pending.id)}`, {
      method: 'DELETE', headers: { cookie: admin },
    })
    assert.equal(adminDelete.status, 403, 'tenant admins cannot bypass requester ownership')

    const colleagueUpdate = await fetch(`${origin}/api/leave-requests/${encodeURIComponent(pending.id)}`, {
      method: 'PATCH', headers: { cookie: colleague, 'content-type': 'application/json' },
      body: JSON.stringify({ type: '병가', period: '2099-01-05', days: 1, reason: '타인 수정 금지' }),
    })
    assert.equal(colleagueUpdate.status, 403)
    assert.equal((await colleagueUpdate.json()).error.code, 'LEAVE_REQUESTER_REQUIRED')

    const updated = await fetch(`${origin}/api/leave-requests/${encodeURIComponent(pending.id)}`, {
      method: 'PATCH', headers: { cookie: requester, 'content-type': 'application/json' },
      body: JSON.stringify({ type: '병가', period: '2099-01-06', days: 1, reason: '본인 수정 성공 테스트' }),
    })
    const updatedBody = await updated.json()
    assert.equal(updated.status, 200, JSON.stringify(updatedBody))
    assert.equal(updatedBody.leave.reason, '본인 수정 성공 테스트')

    const decision = await fetch(`${origin}/api/leave-requests/${encodeURIComponent(pending.id)}/decision`, {
      method: 'PATCH', headers: { cookie: admin, 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    })
    assert.equal(decision.status, 200, await decision.text())
    const decidedDelete = await fetch(`${origin}/api/leave-requests/${encodeURIComponent(pending.id)}`, {
      method: 'DELETE', headers: { cookie: requester },
    })
    assert.equal(decidedDelete.status, 409)
    assert.equal((await decidedDelete.json()).error.code, 'LEAVE_ALREADY_DECIDED')
    const decidedUpdate = await fetch(`${origin}/api/leave-requests/${encodeURIComponent(pending.id)}`, {
      method: 'PATCH', headers: { cookie: requester, 'content-type': 'application/json' },
      body: JSON.stringify({ type: '병가', period: '2099-01-07', days: 1, reason: '결재 후 수정 금지' }),
    })
    assert.equal(decidedUpdate.status, 409)

    const cancellable = await createPendingLeave(origin, requester, '본인 취소 성공 테스트')
    const cancelled = await fetch(`${origin}/api/leave-requests/${encodeURIComponent(cancellable.id)}`, {
      method: 'DELETE', headers: { cookie: requester },
    })
    const cancelledBody = await cancelled.json()
    assert.equal(cancelled.status, 200, JSON.stringify(cancelledBody))
    assert.equal(cancelledBody.deleted, true)

    const stored = await fetch(`${origin}/api/workspace/leave-requests`, {
      headers: { cookie: requester, 'x-workspace-identity': 'TENANT-SUNSEA:USR-SUNSEA-OH' },
    })
    assert.equal(stored.status, 200)
    const leaves = (await stored.json()).data
    assert.ok(leaves.some((leave) => leave.id === pending.id && leave.status === '승인'))
    assert.ok(!leaves.some((leave) => leave.id === cancellable.id))
  })
})

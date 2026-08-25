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
  const account = (await response.json()).account
  return { cookie: response.headers.get('set-cookie'), account, identity: `${account.tenantId}:${account.id}` }
}

const attendanceFetch = (origin, path, session, init = {}) => fetch(`${origin}${path}`, {
  ...init,
  headers: { cookie: session.cookie, 'x-workspace-identity': session.identity, ...init.headers },
})

test('attendance clock lifecycle persists ISO UTC and members can only read their own account-id records', async () => {
  const initialWorkspaceStore = {
    version: 2,
    tenants: { 'TENANT-SUNSEA': {}, 'TENANT-3DMUSE': {} },
    platform: {}, accountApprovals: {}, accountCredentials: {}, invitedAccounts: [], passwordResetRequests: [],
  }
  let instant = '2026-08-25T00:05:00.000Z'
  const options = { apiKey: '', initialWorkspaceStore, attendanceClock: () => new Date(instant) }

  await withServer(createApp(options), async (origin) => {
    const employee = await login(origin, 'taesik.oh@sunsea.co.kr')
    const colleague = await login(origin, 'jihyun.park@sunsea.co.kr')
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const otherTenant = await login(origin, 'admin@3dmuse.demo')

    const unauthorized = await fetch(`${origin}/api/attendance`)
    assert.equal(unauthorized.status, 401)

    const wrongIdentity = await attendanceFetch(origin, '/api/attendance', { ...employee, identity: admin.identity })
    assert.equal(wrongIdentity.status, 401)
    assert.equal((await wrongIdentity.json()).error.code, 'WORKSPACE_IDENTITY_MISMATCH')

    const memberSettings = await attendanceFetch(origin, '/api/attendance/settings', employee, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ standardStartTime: '09:30' }),
    })
    assert.equal(memberSettings.status, 403)

    const clockIn = await attendanceFetch(origin, '/api/attendance/clock-in', employee, { method: 'POST' })
    const clockInBody = await clockIn.json()
    assert.equal(clockIn.status, 201, JSON.stringify(clockInBody))
    assert.equal(clockInBody.record.accountId, employee.account.id)
    assert.equal(clockInBody.record.employeeName, employee.account.name)
    assert.equal(clockInBody.record.clockInAt, instant)
    assert.equal(clockInBody.record.clockOutAt, null)
    assert.equal(clockInBody.record.workDate, '2026-08-25')
    assert.equal(clockInBody.record.standardStartTime, '09:00')

    const duplicate = await attendanceFetch(origin, '/api/attendance/clock-in', employee, { method: 'POST' })
    assert.equal(duplicate.status, 409)
    assert.equal((await duplicate.json()).error.code, 'ATTENDANCE_ALREADY_CLOCKED_IN')

    instant = '2026-08-25T08:00:00.000Z'
    const clockOut = await attendanceFetch(origin, '/api/attendance/clock-out', employee, { method: 'POST' })
    const clockOutBody = await clockOut.json()
    assert.equal(clockOut.status, 200, JSON.stringify(clockOutBody))
    assert.equal(clockOutBody.record.clockInAt, '2026-08-25T00:05:00.000Z', 'clock-in stays immutable')
    assert.equal(clockOutBody.record.clockOutAt, instant)

    const settings = await attendanceFetch(origin, '/api/attendance/settings', admin, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ standardStartTime: '09:30' }),
    })
    assert.equal(settings.status, 200, await settings.text())

    instant = '2026-08-26T00:00:00.000Z'
    const colleagueClockIn = await attendanceFetch(origin, '/api/attendance/clock-in', colleague, { method: 'POST' })
    assert.equal(colleagueClockIn.status, 201, await colleagueClockIn.text())

    const ownView = await attendanceFetch(origin, '/api/attendance', employee)
    const ownData = (await ownView.json()).data
    assert.equal(ownData.records.length, 1)
    assert.ok(ownData.records.every((record) => record.accountId === employee.account.id))

    const adminView = await attendanceFetch(origin, '/api/attendance', admin)
    const adminData = (await adminView.json()).data
    assert.equal(adminData.records.length, 2)
    assert.equal(adminData.policy.standardStartTime, '09:30')
    assert.equal(adminData.records.find((record) => record.accountId === employee.account.id).standardStartTime, '09:00', 'policy snapshot is immutable')
    assert.equal(adminData.records.find((record) => record.accountId === colleague.account.id).standardStartTime, '09:30')

    const genericOverwrite = await attendanceFetch(origin, '/api/workspace/attendance-records', admin, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: { policy: { standardStartTime: '00:00' }, records: [] } }),
    })
    assert.equal(genericOverwrite.status, 403)
    assert.equal((await genericOverwrite.json()).error.code, 'ATTENDANCE_ROUTE_REQUIRED')

    const genericRead = await attendanceFetch(origin, '/api/workspace/attendance-records', employee)
    assert.equal(genericRead.status, 403)
    assert.equal((await genericRead.json()).error.code, 'ATTENDANCE_ROUTE_REQUIRED')

    instant = '2026-08-26T01:00:00.000Z'
    const otherClockIn = await attendanceFetch(origin, '/api/attendance/clock-in', otherTenant, { method: 'POST' })
    assert.equal(otherClockIn.status, 201, await otherClockIn.text())
    const isolatedView = await attendanceFetch(origin, '/api/attendance', otherTenant)
    const isolatedData = (await isolatedView.json()).data
    assert.equal(isolatedData.records.length, 1)
    assert.equal(isolatedData.records[0].accountId, otherTenant.account.id)
    assert.ok(adminData.records.every((record) => record.accountId !== otherTenant.account.id))
  })

  assert.equal(initialWorkspaceStore.tenants['TENANT-SUNSEA']['attendance-records'].data.records.length, 2)
  assert.equal(initialWorkspaceStore.tenants['TENANT-3DMUSE']['attendance-records'].data.records.length, 1)

  await withServer(createApp(options), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const persisted = await attendanceFetch(origin, '/api/attendance', admin)
    assert.equal(persisted.status, 200)
    assert.equal((await persisted.json()).data.records.length, 2, 'records remain after an application restart')
  })
})

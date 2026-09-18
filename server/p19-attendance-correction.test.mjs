import assert from 'node:assert/strict'
import test from 'node:test'

import { createApp } from './app.mjs'
import { withServer } from './test-server.mjs'

/**
 * P1-9(감사 work-15): 퇴근을 빠뜨린 다음 날. 전에는 출근이 막히고, 누를 수 있는 단추는 전날 기록에 '지금'을 찍어
 * 24시간 넘는 근무를 만드는 [퇴근하기]뿐이었다. 그날 퇴근한 시각을 적어 닫고, 관리자는 사유와 함께 고친다.
 */

async function login(origin, email) {
  const response = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: 'tenant', email, password: 'demo1234' }) })
  assert.equal(response.status, 200, email)
  return (response.headers.get('set-cookie') ?? '').split(';')[0]
}
const post = (origin, cookie, path, body) => fetch(`${origin}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
const readJson = async (response) => { const text = await response.text(); try { return JSON.parse(text) } catch { return { raw: text } } }
const emptyStore = () => ({ version: 2, tenants: { 'TENANT-SUNSEA': {} }, platform: {}, accountApprovals: {}, accountCredentials: {}, invitedAccounts: [], passwordResetRequests: [], guestGrants: [] })

test('퇴근을 빠뜨린 다음 날: 출근이 그날 퇴근 시각을 묻고, 적으면 전날을 닫고 바로 출근한다 — 정정 기록이 남는다', async () => {
  let instant = '2026-09-17T00:02:00.000Z' // 9/17 09:02 KST
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: emptyStore(), attendanceClock: () => new Date(instant) }), async (origin) => {
    const employee = await login(origin, 'taesik.oh@sunsea.co.kr')
    assert.equal((await post(origin, employee, '/api/attendance/clock-in')).status, 201)

    instant = '2026-09-17T23:55:00.000Z' // 9/18 08:55 KST — 어제 퇴근을 안 찍었다
    const blocked = await post(origin, employee, '/api/attendance/clock-in')
    assert.equal(blocked.status, 409)
    const blockedBody = await readJson(blocked)
    assert.match(blockedBody.error.message, /9월 17일 퇴근을 찍지 않았습니다\. 그날 퇴근한 시각을 적어 주세요/)
    assert.equal(blockedBody.error.openRecord.workDate, '2026-09-17')

    // 그냥 [퇴근하기]를 눌러도 '지금'을 찍지 않는다(전에는 24시간 근무가 됐다).
    const plainOut = await post(origin, employee, '/api/attendance/clock-out')
    assert.equal(plainOut.status, 409)
    assert.equal((await readJson(plainOut)).error.code, 'ATTENDANCE_MISSED_CLOCK_OUT')

    const both = await readJson(await post(origin, employee, '/api/attendance/clock-in', { previousClockOutTime: '18:10' }))
    const yesterday = both.data.records.find((record) => record.workDate === '2026-09-17')
    assert.equal(yesterday.clockOutAt, '2026-09-17T09:10:00.000Z', '그날 18:10(서울)')
    assert.equal(yesterday.corrections[0].kind, 'self-missed-clock-out')
    assert.equal(yesterday.corrections[0].before, null)
    assert.equal(both.record.workDate, '2026-09-18', '오늘 출근이 함께 찍힌다')
  })
})

test('퇴근 시각만 따로 적을 수도 있다 — 그날 출근보다 이르거나 지금보다 늦은 시각은 받지 않는다', async () => {
  let instant = '2026-09-17T00:02:00.000Z'
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: emptyStore(), attendanceClock: () => new Date(instant) }), async (origin) => {
    const employee = await login(origin, 'taesik.oh@sunsea.co.kr')
    await post(origin, employee, '/api/attendance/clock-in')
    instant = '2026-09-18T01:00:00.000Z'
    // 출근(09:02)보다 이른 08:30은 다음 날 새벽으로 읽혀 24시간을 넘는다 → 거절
    assert.equal((await post(origin, employee, '/api/attendance/clock-out', { clockOutTime: '08:30' })).status, 409)
    const closed = await readJson(await post(origin, employee, '/api/attendance/clock-out', { clockOutTime: '19:00' }))
    assert.equal(closed.record.clockOutAt, '2026-09-17T10:00:00.000Z')
  })
})

test('야간 근무: 전날 밤 출근·오늘 새벽 퇴근은 그대로 [퇴근하기] 한 번이다', async () => {
  let instant = '2026-09-17T13:00:00.000Z' // 9/17 22:00 KST
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: emptyStore(), attendanceClock: () => new Date(instant) }), async (origin) => {
    const employee = await login(origin, 'taesik.oh@sunsea.co.kr')
    await post(origin, employee, '/api/attendance/clock-in')
    instant = '2026-09-17T21:00:00.000Z' // 9/18 06:00 KST
    const out = await readJson(await post(origin, employee, '/api/attendance/clock-out'))
    assert.equal(out.record.clockOutAt, '2026-09-17T21:00:00.000Z')
    assert.equal(out.record.corrections, undefined)
  })
})

test('관리자 정정: 사유는 필수, 바꾼 칸마다 이전값·새값·정정자가 남고 직원은 자기 기록에서 본다', async () => {
  let instant = '2026-09-17T00:40:00.000Z' // 09:40 지각
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: emptyStore(), attendanceClock: () => new Date(instant) }), async (origin) => {
    const employee = await login(origin, 'taesik.oh@sunsea.co.kr')
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const clockedIn = await readJson(await post(origin, employee, '/api/attendance/clock-in'))
    instant = '2026-09-17T09:00:00.000Z'
    await post(origin, employee, '/api/attendance/clock-out')
    const id = clockedIn.record.id
    const patch = (cookie, body) => fetch(`${origin}/api/attendance/records/${id}`, { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })

    assert.equal((await patch(employee, { clockInTime: '09:00', reason: '외근' })).status, 403, '직원은 자기 기록을 고치지 못한다')
    assert.equal((await readJson(await patch(admin, { clockInTime: '09:00' }))).error.code, 'ATTENDANCE_REASON_REQUIRED')
    const fixed = await readJson(await patch(admin, { clockInTime: '08:55', reason: '출입 카드 기록으로 확인 — 단말 오류' }))
    assert.equal(fixed.record.clockInAt, '2026-09-16T23:55:00.000Z')
    assert.deepEqual(fixed.record.corrections.map((entry) => [entry.field, entry.before, entry.after, entry.kind, entry.byName]),
      [['clockInAt', '2026-09-17T00:40:00.000Z', '2026-09-16T23:55:00.000Z', 'admin', '김서원']])
    const mine = await readJson(await fetch(`${origin}/api/attendance`, { headers: { cookie: employee } }))
    assert.match(mine.data.records[0].corrections[0].reason, /출입 카드/)
  })
})

import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { createApp } from './app.mjs'
import { buildDigest } from './daily-digest.mjs'
import { withServer } from './test-server.mjs'
import { isScheduleInstant, MAX_SCHEDULE_SPAN_DAYS, SCHEDULE_ERRORS, scheduleViolation } from './work-item-schedule.mjs'

/**
 * 업무 기간(startAt·due) — 순수 규칙과 HTTP 계약.
 *
 * 기간을 바꾸는 문은 POST /api/work-items/:id/schedule 하나다. 이 파일은 그 문이
 * 누구에게 열리는지(지시자·관리자), 무엇을 받는지(ISO 하나뿐), 무엇을 남기는지(SSE 한 건·알림 0)를 고정한다.
 * 모든 시험은 자기 store로 시작해 순서에 기대지 않는다.
 */

const TENANT = 'TENANT-SUNSEA'
const ADMIN = { id: 'USR-SUNSEA-ADMIN', name: '김서원', email: 'admin@sunsea.co.kr' }
const PARK = { id: 'USR-SUNSEA-PARK', name: '박지현', email: 'jihyun.park@sunsea.co.kr' }
const OH = { id: 'USR-SUNSEA-OH', name: '오태식', email: 'taesik.oh@sunsea.co.kr' }
const GUEST = { id: 'USR-TENANT-SUNSEA-GUEST01', name: '홍거래', email: 'guest@partner.example', password: 'Guest!Pass2026' }
const GUEST_FORBIDDEN_BODY = { error: { code: 'GUEST_SCOPE_FORBIDDEN', message: '초대된 프로젝트 안에서만 사용할 수 있습니다.' } }

const DUE = '2026-09-10T09:00:00.000Z'
const START = '2026-09-07T00:00:00.000Z'

// 다른 테넌트의 업무. 그 id로 기간을 바꾸려는 시도가 "없는 업무"로 끝나고 저쪽 배열이 변하지 않아야 한다.
const POHANG_ITEM = { id: 'WK-POHANG-P', title: '포항 업무', description: '', owner: '박해진', ownerId: 'USR-POHANG-ADMIN', requestedBy: '박해진', requesterId: 'USR-POHANG-ADMIN', due: DUE, priority: '보통', status: '업무요청', category: '일반' }

// app.mjs의 passwordDigest와 같은 계산. 게스트 로그인만을 위해 서버 내부 함수를 끌어오지 않는다.
const digestHex = (password, accountId) => scryptSync(String(password), `onfactory:${accountId}`, 32).toString('hex')

const freshStore = () => ({
  version: 2,
  tenants: { [TENANT]: {}, 'TENANT-POHANG': { 'work-items': { data: [POHANG_ITEM], updatedAt: '2026-09-01T00:00:00.000Z' } } },
  platform: {}, accountApprovals: {}, accountCredentials: {}, invitedAccounts: [], passwordResetRequests: [], guestGrants: [],
})

/** 게스트 한 명이 로그인할 수 있는 최소 픽스처. 초대 라우트를 거치지 않고 store에 직접 심는다. */
function storeWithGuest() {
  const store = freshStore()
  store.tenants[TENANT]['project-spaces'] = {
    data: [{
      id: 'PRJ-A', name: '파트너 협업 A', description: '', visibility: 'members', status: 'active', stage: '진행 중', client: '', amount: 0,
      ownerId: ADMIN.id, ownerName: ADMIN.name,
      members: [{ id: ADMIN.id, name: ADMIN.name, role: 'owner' }, { id: GUEST.id, name: GUEST.name, team: '파트너상사', role: 'viewer', kind: 'guest' }],
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    }],
    updatedAt: '2026-09-01T00:00:00.000Z',
  }
  store.accountApprovals[GUEST.id] = 'approved'
  store.accountCredentials[GUEST.id] = { passwordHash: digestHex(GUEST.password, GUEST.id), mustChangePassword: false, temporaryPasswordExpiresAt: null }
  store.invitedAccounts.push({ id: GUEST.id, email: GUEST.email, name: GUEST.name, tenantId: TENANT, tenantName: '고객사', team: '파트너상사', jobRole: '외부 게스트', requested: '게스트 초대', role: 'tenant-guest', guestGrantId: 'GST-TENANT-SUNSEA-000001' })
  store.guestGrants.push({
    id: 'GST-TENANT-SUNSEA-000001', tenantId: TENANT, accountId: GUEST.id, email: GUEST.email, name: GUEST.name, orgName: '파트너상사', projectIds: ['PRJ-A'],
    invitedById: ADMIN.id, invitedByName: ADMIN.name, status: 'active', tokenHash: null, tokenIssuedAt: null, tokenExpiresAt: null,
    resendCount: 0, lastResentAt: null, accessExpiresAt: null, acceptedAt: '2026-09-01T00:00:00.000Z', revokedAt: null, revokedById: null, deactivatedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  })
  return store
}

const buildApp = (store, extra = {}) => createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {}, ...extra })
const readJson = async (response) => { const text = await response.text(); try { return JSON.parse(text) } catch { return { raw: text } } }

async function login(origin, email, password = 'demo1234') {
  const response = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: 'tenant', email, password }) })
  const body = await readJson(response)
  assert.equal(response.status, 200, JSON.stringify(body))
  const account = body.account
  return { account, headers: { 'content-type': 'application/json', cookie: response.headers.get('set-cookie') ?? '', 'x-workspace-identity': `${account.tenantId}:${account.id}` } }
}
const api = (origin, session) => async (method, route, body) => {
  const response = await fetch(`${origin}${route}`, { method, headers: session.headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return { status: response.status, body: await readJson(response) }
}

const item = (id, owner, overrides = {}) => ({
  id, title: `${id} 제목`, description: '', owner: owner.name, ownerId: owner.id, requestedBy: ADMIN.name, requesterId: ADMIN.id,
  due: DUE, priority: '보통', status: '업무요청', category: '일반', ...overrides,
})
const schedule = (call, id, body) => call('POST', `/api/work-items/${id}/schedule`, body)
const plusDays = (iso, days) => new Date(Date.parse(iso) + days * 86_400_000).toISOString()

test('1. isScheduleInstant는 ISO UTC 한 형식만 받는다', () => {
  assert.equal(isScheduleInstant('2026-10-08T09:00:00.000Z'), true)
  for (const value of ['2026-10-08', '오늘 18:00', '', null, undefined, 123, {}, '2026-10-08T09:00:00Z', '2026-10-08T18:00:00+09:00', `${'2026-10-08T09:00:00.000Z'}${' '.repeat(20)}`]) {
    assert.equal(isScheduleInstant(value), false, `${String(value)}는 받지 않는다`)
  }
})

test('2. scheduleViolation: 같은 시각은 정상, 뒤집힘·과도한 기간·범위 밖만 막는다', () => {
  assert.equal(scheduleViolation({ startAt: START, due: DUE }), null)
  assert.equal(scheduleViolation({ startAt: DUE, due: DUE }), null, '같은 날 시작·마감은 하루짜리 업무다')
  assert.equal(scheduleViolation({ startAt: null, due: DUE }), null)
  assert.equal(scheduleViolation({ due: DUE }), null, 'startAt 없음도 정상이다')
  assert.equal(scheduleViolation({ startAt: plusDays(DUE, 1), due: DUE })?.code, 'SCHEDULE_ORDER_INVALID')
  assert.equal(scheduleViolation({ startAt: plusDays(DUE, -MAX_SCHEDULE_SPAN_DAYS), due: DUE }), null, '730일은 경계 안이다')
  assert.equal(scheduleViolation({ startAt: plusDays(DUE, -(MAX_SCHEDULE_SPAN_DAYS + 1)), due: DUE })?.code, 'SCHEDULE_SPAN_TOO_LONG')
  assert.equal(scheduleViolation({ startAt: null, due: '2101-01-01T00:00:00.000Z' })?.code, 'SCHEDULE_OUT_OF_RANGE')
  assert.equal(scheduleViolation({ startAt: null, due: '1999-12-31T00:00:00.000Z' })?.code, 'SCHEDULE_OUT_OF_RANGE')
  // 시작일도 두 끝을 같은 문장으로 거절한다. 위쪽이 빠져 있으면 2200년 시작일이 ORDER로 새어 나가
  // '시작일은 마감일보다 뒤일 수 없습니다'가 연도 오타의 안내가 된다 — 어디를 볼지 말해 주지 못하는 문장이다.
  assert.equal(scheduleViolation({ startAt: '2200-01-01T00:00:00.000Z', due: DUE })?.code, 'SCHEDULE_OUT_OF_RANGE')
  assert.equal(scheduleViolation({ startAt: '1999-12-31T00:00:00.000Z', due: DUE })?.code, 'SCHEDULE_OUT_OF_RANGE')
  assert.equal(scheduleViolation({ startAt: '2026-10-08', due: DUE })?.code, 'SCHEDULE_INVALID')
  assert.equal(scheduleViolation({ startAt: START, due: '오늘 18:00' })?.code, 'SCHEDULE_INVALID')
})

test('3. 관리자가 기간을 바꾸면 store·GET·version이 함께 움직인다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const a = api(origin, await login(origin, ADMIN.email))
    assert.equal((await a('PUT', '/api/workspace/work-items', { data: [item('W1', PARK)] })).status, 200)
    const before = await a('GET', '/api/workspace/work-items')

    const moved = await schedule(a, 'W1', { startAt: START, due: plusDays(DUE, 3) })
    assert.equal(moved.status, 200, JSON.stringify(moved.body))
    assert.equal(moved.body.item.startAt, START)
    assert.equal(moved.body.item.due, plusDays(DUE, 3))
    assert.notEqual(moved.body.version, before.body.version, '기간이 바뀌면 version도 바뀐다')

    const stored = store.tenants[TENANT]['work-items'].data.find((row) => row.id === 'W1')
    assert.equal(stored.startAt, START)
    assert.equal(stored.due, plusDays(DUE, 3))
    const after = await a('GET', '/api/workspace/work-items')
    assert.deepEqual(after.body.data.find((row) => row.id === 'W1').startAt, START, 'GET 라운드트립도 같은 값이다')
  })
})

test('4. 지시자와 관리자만 바꾼다 — 담당자도, 무관한 직원도 403', async () => {
  await withServer(buildApp(freshStore()), async (origin) => {
    const a = api(origin, await login(origin, ADMIN.email))
    const park = api(origin, await login(origin, PARK.email))
    const oh = api(origin, await login(origin, OH.email))
    // W1: 지시자 박지현·담당 오태식. W2: 지시자 관리자·담당 박지현.
    const seed = [item('W1', OH, { requestedBy: PARK.name, requesterId: PARK.id }), item('W2', PARK)]
    assert.equal((await a('PUT', '/api/workspace/work-items', { data: seed })).status, 200)

    const byRequester = await schedule(park, 'W1', { due: plusDays(DUE, 1) })
    assert.equal(byRequester.status, 200, JSON.stringify(byRequester.body))
    assert.equal(byRequester.body.item.due, plusDays(DUE, 1))

    const byOwner = await schedule(oh, 'W1', { due: plusDays(DUE, 2) })
    assert.equal(byOwner.status, 403)
    assert.equal(byOwner.body.error.code, 'SCHEDULE_FORBIDDEN')

    const byStranger = await schedule(oh, 'W2', { due: plusDays(DUE, 2) })
    assert.equal(byStranger.status, 403)
    assert.equal(byStranger.body.error.code, 'SCHEDULE_FORBIDDEN')
  })
})

test('5. 게스트는 게이트에서 막히고 본문은 고정 문구 하나다', async () => {
  const store = storeWithGuest()
  await withServer(buildApp(store), async (origin) => {
    const a = api(origin, await login(origin, ADMIN.email))
    assert.equal((await a('PUT', '/api/workspace/work-items', { data: [item('W1', PARK, { projectId: 'PRJ-A' })] })).status, 200)
    const guest = api(origin, await login(origin, GUEST.email, GUEST.password))
    const blocked = await schedule(guest, 'W1', { due: plusDays(DUE, 1) })
    assert.equal(blocked.status, 403)
    assert.deepEqual(blocked.body, GUEST_FORBIDDEN_BODY)
    assert.equal(store.tenants[TENANT]['work-items'].data[0].due, DUE, '거절된 요청은 아무것도 쓰지 않는다')
  })
})

test('6. 형식 음성 4종은 전부 400 SCHEDULE_INVALID', async () => {
  await withServer(buildApp(freshStore()), async (origin) => {
    const a = api(origin, await login(origin, ADMIN.email))
    assert.equal((await a('PUT', '/api/workspace/work-items', { data: [item('W1', PARK)] })).status, 200)
    for (const body of [{}, { due: '2026-10-08' }, { due: DUE, startAt: '' }, { due: '오늘 18:00' }, { due: DUE, startAt: 12_345 }]) {
      const invalid = await schedule(a, 'W1', body)
      assert.equal(invalid.status, 400, JSON.stringify(body))
      assert.equal(invalid.body.error.code, 'SCHEDULE_INVALID', JSON.stringify(body))
    }
  })
})

test('7. 뒤집힌 기간과 730일을 넘는 기간은 각자의 코드로 거절된다', async () => {
  await withServer(buildApp(freshStore()), async (origin) => {
    const a = api(origin, await login(origin, ADMIN.email))
    assert.equal((await a('PUT', '/api/workspace/work-items', { data: [item('W1', PARK)] })).status, 200)
    const reversed = await schedule(a, 'W1', { startAt: plusDays(DUE, 1), due: DUE })
    assert.equal(reversed.status, 400)
    assert.equal(reversed.body.error.code, 'SCHEDULE_ORDER_INVALID')
    const tooLong = await schedule(a, 'W1', { startAt: plusDays(DUE, -(MAX_SCHEDULE_SPAN_DAYS + 1)), due: DUE })
    assert.equal(tooLong.status, 400)
    assert.equal(tooLong.body.error.code, 'SCHEDULE_SPAN_TOO_LONG')
  })
})

test('8. 결재완료는 409로 잠기고, 결재대기는 잠기지 않는다', async () => {
  await withServer(buildApp(freshStore()), async (origin) => {
    const a = api(origin, await login(origin, ADMIN.email))
    const seed = [
      item('DONE', PARK, { status: '결재완료' }),
      item('WAIT', PARK, { status: '결재대기' }),
    ]
    assert.equal((await a('PUT', '/api/workspace/work-items', { data: seed })).status, 200)
    const locked = await schedule(a, 'DONE', { due: plusDays(DUE, 1) })
    assert.equal(locked.status, 409, JSON.stringify(locked.body))
    assert.equal(locked.body.error.code, 'SCHEDULE_LOCKED')
    // 확인을 기다리는 동안 지시자가 마감을 미루는 것은 정상 업무다.
    const waiting = await schedule(a, 'WAIT', { due: plusDays(DUE, 1) })
    assert.equal(waiting.status, 200, JSON.stringify(waiting.body))
  })
})

test('9. startAt: null은 키를 지운다 — 빈 문자열을 남기지 않는다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const a = api(origin, await login(origin, ADMIN.email))
    assert.equal((await a('PUT', '/api/workspace/work-items', { data: [item('W1', PARK, { startAt: START })] })).status, 200)
    const cleared = await schedule(a, 'W1', { startAt: null, due: DUE })
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body))
    assert.equal('startAt' in cleared.body.item, false)
    assert.equal('startAt' in store.tenants[TENANT]['work-items'].data[0], false)
  })
})

test('10. startAt 키를 빼고 보내면 기존 시작일은 그대로 남는다', async () => {
  await withServer(buildApp(freshStore()), async (origin) => {
    const a = api(origin, await login(origin, ADMIN.email))
    assert.equal((await a('PUT', '/api/workspace/work-items', { data: [item('W1', PARK, { startAt: START })] })).status, 200)
    const dueOnly = await schedule(a, 'W1', { due: plusDays(DUE, 2) })
    assert.equal(dueOnly.status, 200, JSON.stringify(dueOnly.body))
    assert.equal(dueOnly.body.item.startAt, START)
    assert.equal(dueOnly.body.item.due, plusDays(DUE, 2))
  })
})

test('11. 같은 값으로 다시 부르면 쓰지 않는다', async () => {
  await withServer(buildApp(freshStore()), async (origin) => {
    const a = api(origin, await login(origin, ADMIN.email))
    assert.equal((await a('PUT', '/api/workspace/work-items', { data: [item('W1', PARK, { startAt: START })] })).status, 200)
    const before = await a('GET', '/api/workspace/work-items')
    const same = await schedule(a, 'W1', { startAt: START, due: DUE })
    assert.equal(same.status, 200)
    assert.equal(same.body.updatedAt, before.body.updatedAt)
    assert.equal(same.body.version, before.body.version)
  })
})

test('12. 없는 업무와 타 테넌트 업무는 같은 404이고 저쪽 배열은 그대로다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const a = api(origin, await login(origin, ADMIN.email))
    assert.equal((await a('PUT', '/api/workspace/work-items', { data: [item('W1', PARK)] })).status, 200)
    const pohangBefore = JSON.stringify(store.tenants['TENANT-POHANG']['work-items'].data)
    for (const id of ['NOPE', POHANG_ITEM.id]) {
      const missing = await schedule(a, id, { due: plusDays(DUE, 1) })
      assert.equal(missing.status, 404, id)
      assert.equal(missing.body.error.code, 'WORK_ITEM_NOT_FOUND', id)
    }
    assert.equal(JSON.stringify(store.tenants['TENANT-POHANG']['work-items'].data), pohangBefore)
  })
})

test('13. 커밋이 실패하면 500이고 메모리 값은 이전으로 돌아간다', async () => {
  const store = freshStore()
  let failNext = false
  const app = createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => { if (failNext) { failNext = false; throw new Error('disk full') } } })
  await withServer(app, async (origin) => {
    const a = api(origin, await login(origin, ADMIN.email))
    assert.equal((await a('PUT', '/api/workspace/work-items', { data: [item('W1', PARK, { startAt: START })] })).status, 200)
    failNext = true
    const failed = await schedule(a, 'W1', { startAt: null, due: plusDays(DUE, 5) })
    assert.equal(failed.status, 500, JSON.stringify(failed.body))
    assert.equal(failed.body.error.code, 'SCHEDULE_WRITE_FAILED')
    const after = await a('GET', '/api/workspace/work-items')
    const row = after.body.data.find((entry) => entry.id === 'W1')
    assert.equal(row.due, DUE, '마감은 이전 값으로 돌아온다')
    assert.equal(row.startAt, START, '시작일도 이전 값으로 돌아온다')
  })
})

test('14. 직원의 generic PUT은 startAt 변경을 자동으로 막고, 상태만 바꾸는 저장은 startAt을 보존한다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const a = api(origin, await login(origin, ADMIN.email))
    const park = api(origin, await login(origin, PARK.email))
    assert.equal((await a('PUT', '/api/workspace/work-items', { data: [item('W1', PARK, { startAt: START })] })).status, 200)
    const mine = (await park('GET', '/api/workspace/work-items')).body.data

    const shifted = await park('PUT', '/api/workspace/work-items', { data: mine.map((row) => ({ ...row, startAt: plusDays(START, 1) })) })
    assert.equal(shifted.status, 403)
    assert.equal(shifted.body.error.code, 'WORK_ITEM_TRANSITION_FORBIDDEN')

    const accepted = await park('PUT', '/api/workspace/work-items', { data: mine.map((row) => ({ ...row, status: '수행중' })) })
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body))
    const stored = store.tenants[TENANT]['work-items'].data[0]
    assert.equal(stored.status, '수행중')
    assert.equal(stored.startAt, START)
  })
})

test('15. 관리자 generic PUT도 형식이 아닌 startAt은 저장하지 못한다', async () => {
  await withServer(buildApp(freshStore()), async (origin) => {
    const a = api(origin, await login(origin, ADMIN.email))
    for (const startAt of ['not-iso', '', '2026-10-08', 12_345, null]) {
      const saved = await a('PUT', '/api/workspace/work-items', { data: [item('W1', PARK, { startAt })] })
      assert.equal(saved.status, 400, JSON.stringify(startAt))
      assert.equal(saved.body.error.code, 'INVALID_WORK_ITEMS', JSON.stringify(startAt))
    }
  })
})

test('16. 반복 규칙 실체화는 startAt 없는 업무를 그대로 만든다 — 조용히 건너뛰지 않는다', async () => {
  await withServer(buildApp(freshStore()), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const a = api(origin, admin)
    const park = await login(origin, PARK.email)
    // 어제 시작하는 규칙 — 만들자마자 회차 하나가 도래한다. (오늘을 읽되 고정 날짜를 단언하지 않는다.)
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    const rule = await a('POST', '/api/work-rules', {
      title: '일일 냉장 온도 점검', description: '창고 온도 기록', ownerId: park.account.id,
      frequency: 'daily', interval: 1, startDate: yesterday, dueTime: '18:00', priority: '보통', category: '품질',
    })
    assert.equal(rule.status, 201, JSON.stringify(rule.body))
    const list = await a('GET', '/api/workspace/work-items')
    const generated = list.body.data.filter((row) => row.ruleId === rule.body.rule.id)
    assert.ok(generated.length >= 1, `도래한 회차가 만들어져야 한다: ${JSON.stringify(list.body.data)}`)
    for (const row of generated) assert.equal('startAt' in row, false, '어느 생성 경로도 startAt을 지어내지 않는다')
  })
})

test('17. 마감을 과거로 밀면 마감 초과 센티널이 새 마감으로 판정한다', async () => {
  const store = freshStore()
  const app = buildApp(store)
  await withServer(app, async (origin) => {
    const a = api(origin, await login(origin, ADMIN.email))
    const now = new Date('2026-09-20T00:00:00.000Z')
    assert.equal((await a('PUT', '/api/workspace/work-items', { data: [item('W1', PARK, { due: '2026-10-30T09:00:00.000Z' })] })).status, 200)
    // 미래 마감일 때는 마감 초과가 아니다.
    app.locals.runSentinelForTenant(TENANT, now)
    const overdueOf = () => (store.tenants[TENANT]['ai-proposals']?.data ?? []).filter((proposal) => proposal?.payload?.ruleId === 'work-overdue')
    assert.equal(overdueOf().length, 0)

    const moved = await schedule(a, 'W1', { due: '2026-09-10T09:00:00.000Z' })
    assert.equal(moved.status, 200, JSON.stringify(moved.body))
    app.locals.runSentinelForTenant(TENANT, now)
    assert.equal(overdueOf().length, 1, '전용 라우트가 바꾼 마감도 센티널이 본다')
  })
  // 라우트가 센티널 재평가를 예약한다는 사실 자체(1.5초 타이머)는 시계를 읽지 않고는 관찰할 수 없다.
  // 예약 호출이 남아 있는지는 소스로 고정하고, 판정이 새 마감을 본다는 것은 위에서 실제로 확인한다.
  const source = await readFile(new URL('./work-item-schedule.mjs', import.meta.url), 'utf8')
  assert.match(source, /scheduleSentinel\(request\.auth\.tenantId\)/)
})

test('18. 파생 소비자는 옛 마감을 보지 않는다 — 브리핑은 새 마감으로, 이행률은 그대로', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const a = api(origin, admin)
    const park = await login(origin, PARK.email)
    const rule = await a('POST', '/api/work-rules', {
      title: '월간 설비 점검', description: '설비 상태 기록', ownerId: park.account.id,
      frequency: 'monthly', interval: 1, monthlyMode: 'day-of-month', monthDay: 15, startDate: '2027-01-15', dueTime: '18:00', priority: '보통', category: '설비',
    })
    assert.equal(rule.status, 201, JSON.stringify(rule.body))
    const current = store.tenants[TENANT]['work-items']?.data ?? []
    assert.equal((await a('PUT', '/api/workspace/work-items', { data: [...current, item('W1', PARK, { due: '2026-08-31T09:00:00.000Z' })] })).status, 200)
    const complianceBefore = await a('GET', '/api/work-rules/compliance')
    assert.equal(complianceBefore.status, 200)

    const moved = await schedule(a, 'W1', { due: '2026-09-30T09:00:00.000Z' })
    assert.equal(moved.status, 200, JSON.stringify(moved.body))

    // 브리핑은 새 마감을 본다 — 옛 마감(8/31) 기준으로는 '오늘 마감'이 아니다.
    const morning = new Date('2026-09-30T00:30:00.000Z') // KST 09:30
    const digest = buildDigest(store.tenants[TENANT], { now: morning })
    const dueToday = digest.lines.find((line) => line.id === 'due-today')
    assert.ok(dueToday, `새 마감이 오늘 마감 줄에 잡혀야 한다: ${JSON.stringify(digest.lines)}`)
    assert.match(dueToday.text, /W1 제목/)

    // 이행률은 회차(ruleOccurrence)와 상태로만 계산한다 — 마감을 옮겨도 흔들리지 않아야 한다.
    const complianceAfter = await a('GET', '/api/work-rules/compliance')
    assert.equal(complianceAfter.status, 200)
    assert.deepEqual(complianceAfter.body.rules.map((row) => [row.id, row.rate, row.total]), complianceBefore.body.rules.map((row) => [row.id, row.rate, row.total]))
  })
})

test('19. SSE는 key와 id만 보낸다 — 제목을 싣지 않는다', async () => {
  await withServer(buildApp(freshStore()), async (origin) => {
    const adminSession = await login(origin, ADMIN.email)
    const a = api(origin, adminSession)
    assert.equal((await a('PUT', '/api/workspace/work-items', { data: [item('W1', PARK, { title: '스트림에 새면 안 되는 제목' })] })).status, 200)
    const controller = new AbortController()
    const stream = await fetch(`${origin}/api/events`, { headers: adminSession.headers, signal: controller.signal })
    assert.equal(stream.status, 200)
    const reader = stream.body.getReader()
    let text = ''
    // 프레임이 도착할 때까지 읽는다(고정 대기 없음). 안전 밸브는 실패 경로에만 쓴다.
    const drained = (async () => {
      try {
        while (!text.includes('event: work')) {
          const { done, value } = await reader.read()
          if (done) break
          text += Buffer.from(value).toString('utf8')
        }
      } catch { /* abort */ }
    })()
    const guard = setTimeout(() => controller.abort(), 5_000)
    const moved = await schedule(a, 'W1', { startAt: START, due: plusDays(DUE, 1) })
    assert.equal(moved.status, 200, JSON.stringify(moved.body))
    await drained
    clearTimeout(guard)
    controller.abort()
    assert.match(text, /event: work/)
    const frame = text.split('\n\n').find((chunk) => chunk.includes('event: work')) ?? ''
    const data = JSON.parse(frame.match(/^data: (.*)$/m)?.[1] ?? '{}')
    assert.deepEqual(data, { key: 'work-items', taskId: 'W1' })
    assert.ok(!text.includes('스트림에 새면 안 되는 제목'), `SSE에 제목이 실렸다: ${text}`)
  })
})

test('20. 배열 저장도 거꾸로 된 기간을 받지 않는다 — 두 문이 같은 문장으로 거절한다', async () => {
  await withServer(buildApp(freshStore()), async (origin) => {
    const a = api(origin, await login(origin, ADMIN.email))
    const reversed = { startAt: '2026-12-01T00:00:00.000Z', due: DUE }
    // 새 업무 지시가 쓰는 문(관리자 배열 PUT). /schedule이 거절하는 짝은 여기서도 거절된다.
    const saved = await a('PUT', '/api/workspace/work-items', { data: [item('W-REVERSED', PARK, reversed)] })
    assert.equal(saved.status, 400, JSON.stringify(saved.body))
    assert.equal(saved.body.error.code, SCHEDULE_ERRORS.ORDER.code)
    assert.equal(saved.body.error.message, SCHEDULE_ERRORS.ORDER.message, '두 문의 문장은 하나다')
    assert.equal(saved.body.error.itemId, 'W-REVERSED', '어느 행인지까지 말한다')
    // 거절된 저장은 한 줄도 남기지 않는다(아직 한 번도 저장된 적 없으므로 배열조차 생기지 않는다).
    assert.deepEqual((await a('GET', '/api/workspace/work-items')).body.data ?? [], [])

    // 뒤집힘만이 아니라 /schedule의 세 규칙 전부다. 2년을 넘는 짝이 여기로 들어와 앉으면
    // 그 막대는 드래그도 드로어 적용도 전부 SCHEDULE_SPAN_TOO_LONG으로 막히는데, 그것은 고치는 방법이 아니다.
    const tooLong = await a('PUT', '/api/workspace/work-items', { data: [item('W-LONG', PARK, { startAt: '2020-01-01T00:00:00.000Z', due: DUE })] })
    assert.equal(tooLong.status, 400, JSON.stringify(tooLong.body))
    assert.equal(tooLong.body.error.code, SCHEDULE_ERRORS.SPAN.code)
    assert.equal(tooLong.body.error.message, SCHEDULE_ERRORS.SPAN.message)
    assert.equal(tooLong.body.error.itemId, 'W-LONG')
    // 다루는 범위 밖의 연도도 같은 문이 막는다(연도 오타).
    const outOfRange = await a('PUT', '/api/workspace/work-items', { data: [item('W-OLD-YEAR', PARK, { startAt: '1500-01-01T00:00:00.000Z', due: DUE })] })
    assert.equal(outOfRange.status, 400, JSON.stringify(outOfRange.body))
    assert.equal(outOfRange.body.error.code, SCHEDULE_ERRORS.RANGE.code)

    // 같은 시각은 정상(하루짜리 업무)이고, 앞뒤가 맞으면 그대로 저장된다.
    assert.equal((await a('PUT', '/api/workspace/work-items', { data: [item('W1', PARK, { startAt: DUE, due: DUE })] })).status, 200)
    assert.equal((await a('PUT', '/api/workspace/work-items', { data: [item('W1', PARK, { startAt: START, due: DUE })] })).status, 200)
  })
})

test('21. 레거시 마감과 이미 저장된 어긋남은 배열 저장을 막지 않는다', async () => {
  const store = freshStore()
  // 이 규칙이 생기기 전에 앉은 행. 배열 전체를 다시 판정하면 이 행 하나가 그 뒤의 모든 저장을 막는다.
  store.tenants[TENANT]['work-items'] = {
    data: [item('W-OLD', PARK, { startAt: '2026-12-01T00:00:00.000Z', due: DUE })],
    updatedAt: '2026-09-01T00:00:00.000Z',
  }
  await withServer(buildApp(store), async (origin) => {
    const a = api(origin, await login(origin, ADMIN.email))
    const kept = await a('PUT', '/api/workspace/work-items', {
      data: [item('W-OLD', PARK, { startAt: '2026-12-01T00:00:00.000Z', due: DUE, status: '수행중' }), item('W2', OH, { startAt: START, due: DUE })],
    })
    assert.equal(kept.status, 200, JSON.stringify(kept.body))
    assert.equal((await a('GET', '/api/workspace/work-items')).body.data.find((row) => row.id === 'W-OLD').status, '수행중')

    // 그 행의 기간을 다시 건드리는 순간에는 판정한다 — 손대지 않을 때만 통과한다.
    const touched = await a('PUT', '/api/workspace/work-items', {
      data: [item('W-OLD', PARK, { startAt: '2026-12-02T00:00:00.000Z', due: DUE })],
    })
    assert.equal(touched.status, 400)
    assert.equal(touched.body.error.code, SCHEDULE_ERRORS.ORDER.code)

    // ISO가 아닌 마감(레거시 자유 문자열)은 판정하지 않는다 — 문자열 대소 비교는 뜻이 없다.
    const legacy = await a('PUT', '/api/workspace/work-items', { data: [item('W3', OH, { startAt: START, due: '오늘 18:00' })] })
    assert.equal(legacy.status, 200, JSON.stringify(legacy.body))
  })
})

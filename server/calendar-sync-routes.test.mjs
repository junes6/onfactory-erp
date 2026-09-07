import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import test from 'node:test'

import { createApp } from './app.mjs'
import { createFakeGoogle, fixtureEvents } from './fixtures/google-calendar.mjs'
import { withServer } from './test-server.mjs'

/**
 * 구글 캘린더 — HTTP 계약.
 *
 * 실계정도 실키도 없이 전 경로를 밟는다: 가짜 구글(server/fixtures/google-calendar.mjs)을 통째로 주입하고
 * SECRET_BOX_KEY는 시험마다 새로 만든다. **운영 키는 이 파일에 없다.**
 * 모든 시험은 자기 store로 시작해 순서에 기대지 않는다.
 */

const TENANT = 'TENANT-SUNSEA'
const ADMIN = { id: 'USR-SUNSEA-ADMIN', email: 'admin@sunsea.co.kr' }
const PARK = { id: 'USR-SUNSEA-PARK', email: 'jihyun.park@sunsea.co.kr', name: '박지현' }
const OH = { id: 'USR-SUNSEA-OH', email: 'taesik.oh@sunsea.co.kr', name: '오태식' }
const GUEST = { id: 'USR-TENANT-SUNSEA-GUEST01', email: 'guest@partner.test', password: 'Guest!Pass2026' }
const CAL = 'primary@example.test'
const SHARED = 'shared@example.test'

/** app.mjs의 passwordDigest와 같은 계산. 로그인 가능한 게스트 자격을 시험이 직접 심는다. */
const guestPasswordHash = () => scryptSync(GUEST.password, `onfactory:${GUEST.id}`, 32).toString('hex')

const freshStore = () => ({
  version: 2,
  tenants: { [TENANT]: {} },
  platform: {}, accountApprovals: {}, accountCredentials: {}, invitedAccounts: [], passwordResetRequests: [], guestGrants: [],
})

/** 시험마다 새 키를 만든다. 값은 어디에도 찍지 않는다. */
const freshKey = async () => (await import('node:crypto')).randomBytes(32).toString('base64')

const readJson = async (response) => { const text = await response.text(); try { return JSON.parse(text) } catch { return { raw: text } } }
async function login(origin, email, password = 'demo1234') {
  const response = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: 'tenant', email, password }) })
  const body = await readJson(response)
  assert.equal(response.status, 200, JSON.stringify(body))
  const account = body.account
  return { account, cookie: response.headers.get('set-cookie') ?? '', headers: { 'content-type': 'application/json', cookie: response.headers.get('set-cookie') ?? '', 'x-workspace-identity': `${account.tenantId}:${account.id}` } }
}
const api = (origin, session) => async (method, route, body) => {
  const response = await fetch(`${origin}${route}`, { method, headers: session.headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return { status: response.status, headers: response.headers, body: await readJson(response) }
}

/** 시계를 주입한다. 벽시계를 읽는 시험은 언젠가 밤에 실패한다. */
const movableClock = (startIso) => {
  let current = new Date(startIso)
  const clock = () => new Date(current)
  clock.advance = (ms) => { current = new Date(current.getTime() + ms) }
  clock.set = (iso) => { current = new Date(iso) }
  return clock
}

const buildApp = async (store, extra = {}) => {
  const clock = extra.clock ?? movableClock('2026-09-10T01:00:00.000Z')
  const fake = extra.fake ?? createFakeGoogle({ now: clock, events: fixtureEvents() })
  const env = {
    SECRET_BOX_KEY: extra.noKey ? '' : await freshKey(),
    APP_PUBLIC_URL: '',
    ...(extra.env ?? {}),
  }
  const app = createApp({
    apiKey: '', initialWorkspaceStore: store,
    onWorkspaceStoreChange: extra.onWorkspaceStoreChange ?? (() => {}),
    env,
    googleCalendarTransport: extra.notConfigured ? { ...fake.transport, configured: false } : fake.transport,
    calendarSyncClock: clock,
  })
  return { app, fake, clock, env }
}

/** 콜백 한 번. 세션 쿠키만 들고 non-/api 경로를 친다(브라우저의 top-level 이동과 같다). */
const callback = (origin, session, query) => fetch(`${origin}/oauth/google/callback?${new URLSearchParams(query)}`, {
  headers: { cookie: session.cookie }, redirect: 'manual',
})

/** authorize → 콜백까지 한 번에. 대부분의 시험은 여기서 시작한다. */
async function connect(origin, session) {
  const call = api(origin, session)
  const authorized = await call('GET', '/api/integrations/google/calendar/authorize')
  assert.equal(authorized.status, 200, JSON.stringify(authorized.body))
  const state = new URL(authorized.body.authorizeUrl).searchParams.get('state')
  const redirected = await callback(origin, session, { code: 'CODE', state })
  assert.equal(redirected.status, 302)
  assert.match(redirected.headers.get('location') ?? '', /calendar=connected/)
  return { state, call }
}

const connectionRow = (store, accountId) => (store.tenants[TENANT]['calendar-connections']?.data ?? []).find((row) => row.accountId === accountId)
const linkRows = (store) => store.tenants[TENANT]['calendar-sync-links']?.data ?? []
const eventRows = (store) => store.tenants[TENANT]['calendar-events']?.data ?? []

test('1. 기능이 꺼져 있으면 상태만 내려주고 authorize는 503이다', async () => {
  const store = freshStore()
  const { app } = await buildApp(store, { notConfigured: true })
  await withServer(app, async (origin) => {
    const call = api(origin, await login(origin, PARK.email))
    const status = await call('GET', '/api/integrations/google/calendar')
    assert.equal(status.status, 200)
    assert.equal(status.body.configured, false)
    assert.equal(status.body.connection, null)

    const authorize = await call('GET', '/api/integrations/google/calendar/authorize')
    assert.equal(authorize.status, 503)
    assert.equal(authorize.body.error.code, 'GOOGLE_CALENDAR_NOT_CONFIGURED')
    assert.equal(authorize.body.error.message, '연동키 설정 후 사용할 수 있습니다.')
  })
})

test('2. 상자가 꺼져 있으면 구글로 보내기 전에 503이고 store에 pendingAuth가 생기지 않는다', async () => {
  const store = freshStore()
  const { app, fake } = await buildApp(store, { noKey: true })
  await withServer(app, async (origin) => {
    const call = api(origin, await login(origin, PARK.email))
    const status = await call('GET', '/api/integrations/google/calendar')
    assert.equal(status.body.secretBoxReady, false)
    assert.match(status.body.secretBoxMessage, /SECRET_BOX_KEY/)

    const authorize = await call('GET', '/api/integrations/google/calendar/authorize')
    assert.equal(authorize.status, 503)
    assert.equal(authorize.body.error.code, 'SECRET_BOX_KEY_MISSING')
    // 토큰을 손에 쥐고 저장 못 하는 경로를 구조적으로 만들지 않는다.
    assert.equal(store.tenants[TENANT]['calendar-connections'], undefined)
    assert.equal(fake.requests.length, 0)
  })
})

test('3. authorize는 S256 challenge를 만들고 state·verifier 평문을 저장하지 않는다', async () => {
  const store = freshStore()
  const { app } = await buildApp(store)
  await withServer(app, async (origin) => {
    const session = await login(origin, PARK.email)
    const call = api(origin, session)
    const authorized = await call('GET', '/api/integrations/google/calendar/authorize')
    assert.equal(authorized.status, 200)
    const url = new URL(authorized.body.authorizeUrl)
    const state = url.searchParams.get('state')
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(url.searchParams.get('code_challenge').length, 43)

    const serialized = JSON.stringify(store)
    assert.equal(serialized.includes(state), false, 'state 평문이 저장소에 있으면 안 된다')
    const row = connectionRow(store, PARK.account?.id ?? session.account.id)
    assert.match(row.pendingAuth.stateHash, /^[a-f0-9]{64}$/)
    assert.match(row.pendingAuth.pkceVerifierSecretEnc, /^v1:/)
  })
})

test('4. 콜백 정상 — 302 connected · no-store · 토큰 평문 0 · primary 하나만 선택', async () => {
  const store = freshStore()
  const { app } = await buildApp(store)
  await withServer(app, async (origin) => {
    const session = await login(origin, PARK.email)
    const authorized = await api(origin, session)('GET', '/api/integrations/google/calendar/authorize')
    const state = new URL(authorized.body.authorizeUrl).searchParams.get('state')
    const redirected = await callback(origin, session, { code: 'CODE', state })

    assert.equal(redirected.status, 302)
    assert.equal(redirected.headers.get('location'), '/?calendar=connected')
    // /api 밖이라 no-store 미들웨어를 타지 않는다 — 핸들러가 직접 붙인다.
    assert.match(redirected.headers.get('cache-control') ?? '', /no-store/)
    assert.match(redirected.headers.get('vary') ?? '', /Cookie/i)

    const serialized = JSON.stringify(store)
    assert.equal(serialized.includes('fake-access-1'), false)
    assert.equal(serialized.includes('fake-refresh-1'), false)

    const row = connectionRow(store, session.account.id)
    assert.equal(row.pendingAuth, null)
    assert.match(row.accessTokenEnc, /^v1:/)
    assert.match(row.refreshTokenEnc, /^v1:/)
    assert.deepEqual(row.calendars.filter((calendar) => calendar.selected).map((calendar) => calendar.id), [CAL])
    assert.equal(row.writeCalendarId, CAL)
  })
})

test('5. 콜백 음성 9종 — 전부 store를 바꾸지 않는다', async () => {
  const store = freshStore()
  const { app, clock } = await buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const oh = await login(origin, OH.email)
    const call = api(origin, park)

    const authorized = await call('GET', '/api/integrations/google/calendar/authorize')
    const state = new URL(authorized.body.authorizeUrl).searchParams.get('state')
    const snapshot = () => JSON.stringify(store.tenants[TENANT]['calendar-connections'])

    const expectReason = async (session, query, reason, { unchanged = true } = {}) => {
      const before = snapshot()
      const response = await callback(origin, session, query)
      assert.equal(response.status, 302, reason)
      assert.match(response.headers.get('location') ?? '', new RegExp(reason.startsWith('calendar=') ? reason : `reason=${reason}`), reason)
      if (unchanged) assert.equal(snapshot(), before, `${reason}: store 무변경`)
    }

    // (1) 세션 없음
    const anonymous = await fetch(`${origin}/oauth/google/callback?state=${state}&code=C`, { redirect: 'manual' })
    assert.match(anonymous.headers.get('location') ?? '', /reason=session/)
    // (2) 형식이 틀린 state
    await expectReason(park, { state: 'short', code: 'C' }, 'state')
    // (3) 다른 계정의 state — 오태식 세션으로 박지현의 state를 들고 온다. 이것이 로그인-CSRF 차단의 본체다.
    await expectReason(oh, { state, code: 'C' }, 'state')
    // (4) 사용자가 취소
    await expectReason(park, { error: 'access_denied', state }, 'calendar=cancelled')
    // (5) 만료(TTL 10분)
    clock.advance(11 * 60 * 1_000)
    await expectReason(park, { state, code: 'C' }, 'state')
    clock.set('2026-09-10T01:00:00.000Z')
    // 나머지 음성 3종(교환 실패·refresh 없음·scope 부족)은 store를 새로 잡아야 해서 다음 시험이 맡는다.
  })
})

test('6. 콜백 음성 — 토큰 실패·refresh 없음·scope 부족은 연결을 저장하지 않는다', async () => {
  for (const [label, arrange, reason] of [
    ['token 400', (fake) => fake.failNext('token', { outcome: 'failed', status: 400, reason: 'invalid_request' }), 'exchange'],
    ['refresh 없음', (fake) => fake.failNext('token', { outcome: 'ok', status: 200, tokens: { accessToken: 'fake-access-x', refreshToken: '', expiresIn: 3600, scope: 'https://www.googleapis.com/auth/calendar.events', email: 'a@b.test' } }), 'norefresh'],
    ['scope 부족', (fake) => fake.failNext('token', { outcome: 'ok', status: 200, tokens: { accessToken: 'fake-access-x', refreshToken: 'fake-refresh-x', expiresIn: 3600, scope: 'openid email', email: 'a@b.test' } }), 'scope'],
  ]) {
    const store = freshStore()
    const { app, fake } = await buildApp(store)
    await withServer(app, async (origin) => {
      const session = await login(origin, PARK.email)
      const authorized = await api(origin, session)('GET', '/api/integrations/google/calendar/authorize')
      const state = new URL(authorized.body.authorizeUrl).searchParams.get('state')
      arrange(fake)
      const redirected = await callback(origin, session, { code: 'CODE', state })
      assert.match(redirected.headers.get('location') ?? '', new RegExp(`reason=${reason}`), label)
      const row = connectionRow(store, session.account.id)
      assert.equal(row.accessTokenEnc, null, `${label}: 연결이 저장되면 안 된다`)
      assert.equal(row.pendingAuth, null, `${label}: state는 1회용으로 소각된다`)
    })
  }
})

test('7. 같은 state를 두 번 쓰면 두 번째는 거절된다(1회용 소각)', async () => {
  const store = freshStore()
  const { app } = await buildApp(store)
  await withServer(app, async (origin) => {
    const session = await login(origin, PARK.email)
    const authorized = await api(origin, session)('GET', '/api/integrations/google/calendar/authorize')
    const state = new URL(authorized.body.authorizeUrl).searchParams.get('state')
    assert.match((await callback(origin, session, { code: 'C1', state })).headers.get('location') ?? '', /calendar=connected/)
    assert.match((await callback(origin, session, { code: 'C2', state })).headers.get('location') ?? '', /reason=state/)
  })
})

test('8. 게스트는 콜백을 탈 수 없다 — 게이트가 못 보는 유일한 문을 손으로 잠근다', async () => {
  // **진짜 게스트 세션으로 문을 민다.** 익명 요청만 확인하면 이 시험은 reason=session만 밟고
  // 정작 잠그려는 분기(auth.role === GUEST_ROLE → reason=forbidden)는 한 번도 실행되지 않는다.
  const store = freshStore()
  store.accountApprovals = { [GUEST.id]: 'approved' }
  store.accountCredentials = { [GUEST.id]: { passwordHash: guestPasswordHash(), mustChangePassword: false, temporaryPasswordExpiresAt: null } }
  store.invitedAccounts = [{
    id: GUEST.id, name: '외부 담당자', email: GUEST.email, role: 'tenant-guest',
    tenantId: TENANT, tenantName: '선씨푸드', team: '거래처', jobRole: '외부 게스트',
    requested: '게스트 초대', guestGrantId: 'GST-1',
  }]
  store.guestGrants = [{
    id: 'GST-1', accountId: GUEST.id, tenantId: TENANT, email: GUEST.email, name: '외부 담당자',
    orgName: '거래처', projectIds: [], invitedById: ADMIN.id, invitedByName: '김서원',
    status: 'active', accessExpiresAt: null, acceptedAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  }]
  const { app } = await buildApp(store)
  await withServer(app, async (origin) => {
    const guest = await login(origin, GUEST.email, GUEST.password)
    assert.equal(guest.account.role, 'tenant-guest')
    const before = JSON.stringify(store.tenants[TENANT])

    const denied = await callback(origin, guest, { state: 'x'.repeat(43), code: 'C' })
    assert.equal(denied.status, 302)
    assert.match(denied.headers.get('location') ?? '', /reason=forbidden/)
    // 연결 행이 하나도 생기지 않는다 — 게스트에게는 시작조차 없다.
    assert.equal(store.tenants[TENANT]['calendar-connections'], undefined)
    assert.equal(JSON.stringify(store.tenants[TENANT]), before)
    assert.equal((await api(origin, guest)('GET', '/api/integrations/google/calendar')).status, 403)

    const anonymous = await fetch(`${origin}/oauth/google/callback?state=${'x'.repeat(43)}&code=C`, { redirect: 'manual' })
    assert.equal(anonymous.status, 302)
    assert.match(anonymous.headers.get('location') ?? '', /reason=session/)
    // /api 여덟 개는 allowlist 밖이라 전수 스윕이 자동으로 잠근다(server/guest-access.test.mjs).
    const gated = await fetch(`${origin}/api/integrations/google/calendar`, { headers: { cookie: '' } })
    assert.equal(gated.status, 401)
  })
})

test('9. 계정 격리 — 남의 연결은 보이지도 않고 404다', async () => {
  const store = freshStore()
  const { app } = await buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    await connect(origin, park)

    const oh = api(origin, await login(origin, OH.email))
    assert.equal((await oh('GET', '/api/integrations/google/calendar')).body.connection, null)
    assert.equal((await oh('POST', '/api/integrations/google/calendar/sync')).status, 404)
    assert.equal((await oh('POST', '/api/integrations/google/calendar/disconnect')).status, 404)
    assert.equal((await oh('DELETE', '/api/integrations/google/calendar')).status, 404)

    // x-workspace-identity 불일치는 401이다.
    const forged = await fetch(`${origin}/api/integrations/google/calendar`, { headers: { cookie: park.cookie, 'x-workspace-identity': `${TENANT}:${OH.id}` } })
    assert.equal(forged.status, 401)
  })
})

test('10. 관리자 개관에는 토큰이 어떤 형태로도 없다', async () => {
  const store = freshStore()
  const { app } = await buildApp(store)
  await withServer(app, async (origin) => {
    await connect(origin, await login(origin, PARK.email))
    const admin = api(origin, await login(origin, ADMIN.email))
    const overview = await admin('GET', '/api/integrations/google/calendar/overview')
    assert.equal(overview.status, 200)
    const body = JSON.stringify(overview.body)
    for (const secret of ['Enc', 'v1:', 'fake-access', 'fake-refresh']) assert.equal(body.includes(secret), false, secret)
    assert.equal(overview.body.rows.length, 1)
    assert.match(overview.body.rows[0].email, /^\w{2}\*+@/)
    assert.match(overview.body.keyFingerprint, /^[a-f0-9]{8}$/)

    // 직원은 개관을 볼 수 없다.
    const park = api(origin, await login(origin, PARK.email))
    assert.equal((await park('GET', '/api/integrations/google/calendar/overview')).status, 403)
  })
})

test('11. 첫 동기화 — 원격 일정이 개인 범위로 들어오고 다른 직원에게는 보이지 않는다', async () => {
  const store = freshStore()
  const { app, clock } = await buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    clock.advance(60_000)
    const synced = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(synced.status, 200, JSON.stringify(synced.body))
    assert.ok(synced.body.result.pulled >= 4, JSON.stringify(synced.body.result))

    const imported = eventRows(store).filter((event) => event.id.startsWith('EV-G-'))
    assert.ok(imported.length >= 4)
    for (const event of imported) {
      assert.equal(event.scope, 'personal')
      assert.equal(event.ownerId, park.account.id)
    }
    // 가져온 개인 일정은 다른 직원의 목록에 나타나지 않는다.
    const oh = api(origin, await login(origin, OH.email))
    const ohList = await oh('GET', '/api/workspace/calendar-events')
    assert.deepEqual(ohList.body.data.filter((event) => event.id.startsWith('EV-G-')), [])
  })
})

test('12. 멱등성 — 아무것도 안 바뀐 2회차는 증분 목록 한 건 외에 요청이 없다', async () => {
  const store = freshStore()
  const { app, fake, clock } = await buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    clock.advance(60_000)
    await call('POST', '/api/integrations/google/calendar/sync')

    const afterFirst = fake.requests.length
    const eventsAfterFirst = JSON.stringify(store.tenants[TENANT]['calendar-events'].data)
    clock.advance(60_000)
    const second = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(second.status, 200, JSON.stringify(second.body))

    const newRequests = fake.requests.slice(afterFirst)
    assert.deepEqual(newRequests.map((request) => request.pathname), ['/events.list'], JSON.stringify(newRequests.map((r) => r.pathname)))
    assert.equal(JSON.stringify(store.tenants[TENANT]['calendar-events'].data), eventsAfterFirst)
    assert.deepEqual(second.body.result, { pulled: 0, pushed: 0, conflicts: 0, deletedLocal: 0, deletedRemote: 0, skipped: 0 })
  })
})

test('13. 구글에서 고치면 우리 쪽이 따라오고, 양쪽이 고치면 늦은 쪽이 이력에 남는다', async () => {
  const store = freshStore()
  const { app, fake, clock } = await buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    clock.advance(60_000)
    await call('POST', '/api/integrations/google/calendar/sync')

    const timedLink = linkRows(store).find((link) => link.externalId === 'EV-TIMED')
    assert.ok(timedLink, '링크가 생겨야 한다')

    // 구글에서만 제목을 고친다 → pull, 덮어쓴 것이 없으므로 이력도 없다.
    clock.advance(60_000)
    fake.setEvent(CAL, { id: 'EV-TIMED', summary: 'Weekly sync', start: { dateTime: '2026-09-10T10:00:00+09:00' }, end: { dateTime: '2026-09-10T11:00:00+09:00' }, status: 'confirmed', updated: clock().toISOString() })
    const pulled = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(pulled.body.result.pulled, 1)
    assert.equal(eventRows(store).find((event) => event.id === timedLink.eventId).title, 'Weekly sync')
    assert.equal(linkRows(store).find((link) => link.id === timedLink.id).history.length, 0)

    // 이제 양쪽에서 고친다. 우리가 먼저(10:00), 구글이 나중(10:05) → 구글이 이기고 우리 값이 이력에 남는다.
    clock.advance(60_000)
    const mine = eventRows(store).map((event) => (event.id === timedLink.eventId ? { ...event, title: '주간 회의' } : event))
    const saved = await call('PUT', '/api/workspace/calendar-events', { data: mine })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    clock.advance(60_000)
    fake.setEvent(CAL, { id: 'EV-TIMED', summary: '구글이 마지막', start: { dateTime: '2026-09-10T10:00:00+09:00' }, end: { dateTime: '2026-09-10T11:00:00+09:00' }, status: 'confirmed', updated: clock().toISOString() })
    clock.advance(60_000)
    const conflicted = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(conflicted.body.result.conflicts, 1, JSON.stringify(conflicted.body.result))
    assert.equal(eventRows(store).find((event) => event.id === timedLink.eventId).title, '구글이 마지막')

    const overwrites = await call('GET', `/api/calendar/events/${timedLink.eventId}/overwrites`)
    assert.equal(overwrites.status, 200)
    assert.equal(overwrites.body.overwrites[0].source, 'google')
    assert.equal(overwrites.body.overwrites[0].before.title, '주간 회의')
  })
})

test('14. 사람이 지운 일정은 되살아나지 않고 원격에서도 지워진다', async () => {
  const store = freshStore()
  const { app, fake, clock } = await buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    clock.advance(60_000)
    await call('POST', '/api/integrations/google/calendar/sync')
    const link = linkRows(store).find((row) => row.externalId === 'EV-TIMED')

    clock.advance(60_000)
    const remaining = eventRows(store).filter((event) => event.id !== link.eventId)
    assert.equal((await call('PUT', '/api/workspace/calendar-events', { data: remaining })).status, 200)
    // 툼스톤이 찍혔는가 — 이것이 없으면 다음 통과가 되살린다.
    assert.ok(linkRows(store).find((row) => row.id === link.id).localDeletedAt)

    clock.advance(60_000)
    const swept = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(swept.body.result.deletedRemote, 1, JSON.stringify(swept.body.result))
    assert.equal(eventRows(store).some((event) => event.id === link.eventId), false, '지운 일정이 되살아나면 안 된다')
    assert.equal(fake.eventsOf(CAL).find((event) => event.id === 'EV-TIMED').status, 'cancelled')
  })
})

test('15. 원격에서 지우면 우리 쪽도 지워지고 그 사실이 이력에 남는다', async () => {
  const store = freshStore()
  const { app, fake, clock } = await buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    clock.advance(60_000)
    await call('POST', '/api/integrations/google/calendar/sync')
    const link = linkRows(store).find((row) => row.externalId === 'EV-TIMED')

    clock.advance(60_000)
    fake.removeEvent(CAL, 'EV-TIMED')
    const swept = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(swept.body.result.deletedLocal, 1, JSON.stringify(swept.body.result))
    assert.equal(eventRows(store).some((event) => event.id === link.eventId), false)
    assert.equal(linkRows(store).find((row) => row.id === link.id).history[0].source, 'google')
  })
})

test('16. 410 재동기화 — 전량을 다시 읽어도 로컬 일정 수가 늘지 않는다', async () => {
  const store = freshStore()
  const { app, fake, clock } = await buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    clock.advance(60_000)
    await call('POST', '/api/integrations/google/calendar/sync')
    const before = eventRows(store).length

    // syncToken을 무효로 만든다 → 410 → 전량 재조회.
    fake.state.syncTokens.set(CAL, 'stale-token')
    clock.advance(60_000)
    const resynced = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(resynced.status, 200, JSON.stringify(resynced.body))
    assert.equal(eventRows(store).length, before, '재입양이 되지 않으면 여기서 두 배가 된다')
  })
})

test('17. 업무 마감 내보내기 — 종일·배타 end이고 pushWorkDue를 끄면 0건이다', async () => {
  const store = freshStore()
  const { app, fake, clock } = await buildApp(store)
  await withServer(app, async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const saved = await admin('PUT', '/api/workspace/work-items', {
      data: [{
        id: 'WK-DUE', title: '보고서 제출', description: '', owner: PARK.name, ownerId: PARK.id,
        requestedBy: '김서원', requesterId: ADMIN.id, due: '2026-09-30T09:00:00.000Z',
        priority: '보통', status: '업무요청', category: '일반',
      }],
    })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))

    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    clock.advance(60_000)
    const synced = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(synced.status, 200, JSON.stringify(synced.body))

    // 카드가 읽는 두 수. [마감] 표식에는 대응하는 일정 행이 없으므로 '연결된 일정'에 섞으면 안 된다 —
    // 화면에 다섯 줄뿐인데 '연결된 일정 6건'이라고 적히게 된다.
    assert.equal(synced.body.connection.counts.linked, 5, JSON.stringify(synced.body.connection.counts))
    assert.equal(synced.body.connection.counts.workDue, 1)

    const inserted = fake.requests.filter((request) => request.pathname === '/events.insert')
    const dueBody = inserted.map((request) => request.body).find((body) => body.summary === '[마감] 보고서 제출')
    assert.ok(dueBody, JSON.stringify(inserted.map((request) => request.body?.summary)))
    assert.equal(dueBody.start.date, '2026-09-30')
    // 구글 종일 end는 배타다.
    assert.equal(dueBody.end.date, '2026-10-01')
    assert.equal(dueBody.transparency, 'transparent')

    // 끄면 다음 통과에서 새 마감을 내보내지 않는다.
    await call('PATCH', '/api/integrations/google/calendar/calendars', { pushWorkDue: false })
    const before = fake.requests.filter((request) => request.pathname === '/events.insert').length
    clock.advance(60_000)
    await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(fake.requests.filter((request) => request.pathname === '/events.insert').length, before)
  })
})

test('18. 캘린더 선택 — 없는 id는 400, 읽기 전용을 내보내기로 고르면 400', async () => {
  const store = freshStore()
  const { app } = await buildApp(store)
  await withServer(app, async (origin) => {
    const { call } = await connect(origin, await login(origin, PARK.email))
    assert.equal((await call('PATCH', '/api/integrations/google/calendar/calendars', { selected: ['nope@example.test'] })).body.error.code, 'CALENDAR_UNKNOWN_ID')
    assert.equal((await call('PATCH', '/api/integrations/google/calendar/calendars', { writeCalendarId: 'shared@example.test' })).body.error.code, 'CALENDAR_NOT_WRITABLE')
    const ok = await call('PATCH', '/api/integrations/google/calendar/calendars', { selected: [CAL, 'shared@example.test'] })
    assert.equal(ok.status, 200)
    assert.deepEqual(ok.body.connection.calendars.filter((calendar) => calendar.selected).map((calendar) => calendar.id), [CAL, 'shared@example.test'])
  })
})

test('19. 해제 — 일정은 남고 암호문은 지워지며 revoke가 500이어도 200이다', async () => {
  const store = freshStore()
  const { app, fake, clock } = await buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    clock.advance(60_000)
    await call('POST', '/api/integrations/google/calendar/sync')
    const eventsBefore = eventRows(store).length
    const link = linkRows(store)[0]

    fake.failNext('revoke', { outcome: 'retry', status: 500, reason: 'boom' })
    const disconnected = await call('POST', '/api/integrations/google/calendar/disconnect')
    assert.equal(disconnected.status, 200, JSON.stringify(disconnected.body))
    assert.equal(disconnected.body.disconnected, true)
    assert.equal(eventRows(store).length, eventsBefore, '연결 해제 시 인더필드 데이터는 유지된다')

    const row = connectionRow(store, park.account.id)
    assert.equal(row.accessTokenEnc, null)
    assert.equal(row.refreshTokenEnc, null)
    assert.equal(row.status, 'revoked')
    assert.ok(linkRows(store).find((item) => item.id === link.id).detachedAt)
    // 해제해도 덮어쓴 내역은 읽을 수 있다.
    assert.equal((await call('GET', `/api/calendar/events/${link.eventId}/overwrites`)).status, 200)
  })
})

test('20. 재연결 — 해제 뒤 다시 붙여도 일정이 두 벌이 되지 않는다', async () => {
  const store = freshStore()
  const { app, clock } = await buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    clock.advance(60_000)
    await call('POST', '/api/integrations/google/calendar/sync')
    const before = eventRows(store).length
    await call('POST', '/api/integrations/google/calendar/disconnect')

    await connect(origin, park)
    clock.advance(60_000)
    const synced = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(synced.status, 200, JSON.stringify(synced.body))
    assert.equal(eventRows(store).length, before, '재입양이 안 되면 여기서 두 배가 된다')
  })
})

test('21. 연결 기록 완전 삭제는 링크만 지우고 일정은 남긴다', async () => {
  const store = freshStore()
  const { app, clock } = await buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    clock.advance(60_000)
    await call('POST', '/api/integrations/google/calendar/sync')
    const events = eventRows(store).length
    const removed = await call('DELETE', '/api/integrations/google/calendar')
    assert.equal(removed.status, 200)
    assert.ok(removed.body.removedLinks > 0)
    assert.equal(eventRows(store).length, events)
    assert.equal(linkRows(store).length, 0)
    assert.equal((await call('GET', '/api/integrations/google/calendar')).body.connection, null)
  })
})

test('22. invalid_grant는 재연결 알림을 정확히 한 번만 보내고, 429는 status를 바꾸지 않는다', async () => {
  const store = freshStore()
  const { app, fake, clock } = await buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)

    // 토큰을 만료시켜 갱신 경로로 들어가게 한다.
    const expire = () => {
      const row = connectionRow(store, park.account.id)
      row.tokenExpiresAt = new Date(clock().getTime() - 60_000).toISOString()
    }
    clock.advance(60_000)
    expire()
    fake.failNext('refresh', { outcome: 'reauth', status: 400, reason: 'invalid_grant' })
    assert.equal((await call('POST', '/api/integrations/google/calendar/sync')).status, 409)
    assert.equal(connectionRow(store, park.account.id).status, 'needs-reauth')

    const notificationsOf = () => (store.tenants[TENANT].notifications?.data ?? []).filter((row) => row.type === 'calendar-reauth')
    assert.equal(notificationsOf().length, 1)

    // 두 번째 실패는 알림을 더하지 않는다.
    clock.advance(60_000)
    expire()
    fake.failNext('refresh', { outcome: 'reauth', status: 400, reason: 'invalid_grant' })
    await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(notificationsOf().length, 1, '재연결 알림이 매 통과마다 울리면 사람은 알림을 꺼 버린다')

    // 429는 연결을 끊지 않는다 — 구글이 잠깐 흔들렸다고 매주 다시 로그인하게 만들면 안 된다.
    await connect(origin, park)
    clock.advance(60_000)
    expire()
    fake.failNext('refresh', { outcome: 'retry', status: 429, reason: 'rate limited ya29.leaked-token' })
    const throttled = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(throttled.status, 502)
    const row = connectionRow(store, park.account.id)
    assert.equal(row.status, 'connected')
    assert.ok(row.lastError.length > 0)
    assert.equal(row.lastError.includes('ya29.'), false, 'lastError에 토큰 문자열이 남으면 안 된다')
    assert.equal(notificationsOf().length, 1)
  })
})

test('23. 갱신 — 회전된 refresh는 반영하고, 안 준 응답에서는 기존 값을 지킨다', async () => {
  const store = freshStore()
  const { app, fake, clock, env } = await buildApp(store)
  const { createSecretBox } = await import('./secret-box.mjs')
  const box = createSecretBox({ env, logger: { warn: () => {} } })
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    const aad = `google-calendar:${TENANT}:${park.account.id}`
    const firstRefresh = box.open(connectionRow(store, park.account.id).refreshTokenEnc, { aad })
    assert.equal(firstRefresh, 'fake-refresh-1')

    // 회전 없음: 기존 refresh 유지.
    connectionRow(store, park.account.id).tokenExpiresAt = new Date(clock().getTime() - 60_000).toISOString()
    clock.advance(60_000)
    await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(box.open(connectionRow(store, park.account.id).refreshTokenEnc, { aad }), firstRefresh)

    // 회전 있음: 새 값으로 갈아 끼운다.
    fake.rotateRefreshToken()
    connectionRow(store, park.account.id).tokenExpiresAt = new Date(clock().getTime() - 60_000).toISOString()
    clock.advance(60_000)
    await call('POST', '/api/integrations/google/calendar/sync')
    assert.notEqual(box.open(connectionRow(store, park.account.id).refreshTokenEnc, { aad }), firstRefresh)
  })
})

test('24. 봉인은 계정에 묶인다 — 남의 행에 옮겨 붙인 암호문은 열리지 않는다', async () => {
  const store = freshStore()
  const { app, env } = await buildApp(store)
  const { createSecretBox } = await import('./secret-box.mjs')
  const box = createSecretBox({ env, logger: { warn: () => {} } })
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    await connect(origin, park)
    const sealed = connectionRow(store, park.account.id).refreshTokenEnc
    assert.equal(box.open(sealed, { aad: `google-calendar:${TENANT}:${park.account.id}` }), 'fake-refresh-1')
    // B의 AAD로는 열리지 않는다. 저장소를 만질 수 있는 상대가 A의 토큰을 B 행에 붙여도 소용없다.
    assert.equal(box.open(sealed, { aad: `google-calendar:${TENANT}:${OH.id}` }), null)
    assert.equal(box.open(sealed, { aad: `google-calendar:TENANT-OTHER:${park.account.id}` }), null)
  })
})

test('25. 겹친 동기화는 429/409로 막히고 커밋 실패는 세 키를 함께 되돌린다', async () => {
  const store = freshStore()
  let failNextCommit = false
  const { app, clock } = await buildApp(store, {
    onWorkspaceStoreChange: () => { if (failNextCommit) { failNextCommit = false; throw new Error('commit boom') } },
  })
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    clock.advance(60_000)
    await call('POST', '/api/integrations/google/calendar/sync')

    // 방금 돌았으므로 곧바로 다시 누르면 429다.
    const tooSoon = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(tooSoon.status, 429)
    assert.equal(tooSoon.body.error.code, 'CALENDAR_SYNC_TOO_SOON')
    assert.ok(tooSoon.body.retryAfterSeconds > 0)

    clock.advance(60_000)
    const snapshot = {
      events: JSON.stringify(store.tenants[TENANT]['calendar-events']),
      links: JSON.stringify(store.tenants[TENANT]['calendar-sync-links']),
      connections: JSON.stringify(store.tenants[TENANT]['calendar-connections']),
    }
    failNextCommit = true
    const failed = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(failed.status, 500)
    assert.equal(failed.body.error.code, 'CALENDAR_SYNC_WRITE_FAILED')
    // 세 키가 한 커밋에 실렸으므로 되돌릴 때도 셋이 함께 돌아온다.
    assert.equal(JSON.stringify(store.tenants[TENANT]['calendar-events']), snapshot.events)
    assert.equal(JSON.stringify(store.tenants[TENANT]['calendar-sync-links']), snapshot.links)
    assert.equal(JSON.stringify(store.tenants[TENANT]['calendar-connections']), snapshot.connections)
  })
})

test('26. generic PUT 커밋 실패는 일정과 링크를 함께 되돌린다', async () => {
  const store = freshStore()
  let failNextCommit = false
  const { app, clock } = await buildApp(store, {
    onWorkspaceStoreChange: () => { if (failNextCommit) { failNextCommit = false; throw new Error('commit boom') } },
  })
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    clock.advance(60_000)
    await call('POST', '/api/integrations/google/calendar/sync')

    const linksBefore = JSON.stringify(store.tenants[TENANT]['calendar-sync-links'])
    const eventsBefore = JSON.stringify(store.tenants[TENANT]['calendar-events'])
    failNextCommit = true
    const rejected = await call('PUT', '/api/workspace/calendar-events', { data: [] })
    assert.equal(rejected.status, 500)
    // 한쪽만 되돌리면 툼스톤이 메모리에 남아 다음 통과가 멀쩡한 일정을 지운다.
    assert.equal(JSON.stringify(store.tenants[TENANT]['calendar-sync-links']), linksBefore)
    assert.equal(JSON.stringify(store.tenants[TENANT]['calendar-events']), eventsBefore)
  })
})

test('27. 직원 쓰기 회귀 — 가져온 행의 제목만 바꿔 저장해도 200이다', async () => {
  const store = freshStore()
  const { app, clock } = await buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    clock.advance(60_000)
    await call('POST', '/api/integrations/google/calendar/sync')

    const rows = eventRows(store)
    const imported = rows.find((event) => event.id.startsWith('EV-G-'))
    assert.ok(imported, '가져온 행이 있어야 한다')
    // 임포트 행이 hasCalendarShape를 통과하지 못하면 이 저장이 403이 된다 — 전 직원의 일정 쓰기가 막히는 지점이다.
    const saved = await call('PUT', '/api/workspace/calendar-events', {
      data: rows.map((event) => (event.id === imported.id ? { ...event, title: '내가 고친 제목' } : event)),
    })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
  })
})

test('28. generic GET/PUT은 두 키를 존재조차 인정하지 않는다(404)', async () => {
  const store = freshStore()
  const { app } = await buildApp(store)
  await withServer(app, async (origin) => {
    for (const session of [await login(origin, ADMIN.email), await login(origin, PARK.email)]) {
      const call = api(origin, session)
      for (const key of ['calendar-connections', 'calendar-sync-links']) {
        const read = await call('GET', `/api/workspace/${key}`)
        assert.equal(read.status, 404, key)
        assert.equal(read.body.error.code, 'STORE_KEY_NOT_FOUND')
        const write = await call('PUT', `/api/workspace/${key}`, { data: [] })
        assert.equal(write.status, 404, key)
        assert.equal(write.body.error.code, 'STORE_KEY_NOT_FOUND')
      }
    }
  })
})

test('29. 덮어쓴 내역은 남의 것을 볼 수 없고 없는 일정은 404다', async () => {
  const store = freshStore()
  const { app, clock } = await buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    clock.advance(60_000)
    await call('POST', '/api/integrations/google/calendar/sync')
    const link = linkRows(store)[0]

    const oh = api(origin, await login(origin, OH.email))
    assert.equal((await oh('GET', `/api/calendar/events/${link.eventId}/overwrites`)).status, 404)
    assert.equal((await call('GET', '/api/calendar/events/EV-NOPE/overwrites')).status, 404)
  })
})

test('30. 스케줄러 잡이 등록되어 있고 연결이 없으면 조용히 끝난다', async () => {
  const store = freshStore()
  const { app, clock } = await buildApp(store)
  const summary = await app.locals.calendarSync.runAll({ now: clock() })
  assert.equal(summary.connections, 0)
  assert.equal(summary.skipped, undefined)
})

/** 일정 한 행. hasCalendarShape가 요구하는 열 칸 + ownerId를 그대로 채운다. */
const eventRow = (overrides = {}) => ({
  id: 'EV-X', title: '제목', date: '2026-09-11', start: '14:00', end: '15:00',
  scope: 'personal', department: '품질관리', location: '', owner: '오태식', note: '', ownerId: OH.id, ...overrides,
})

test('31. 남의 일정 id를 원격 표식에 심어도 그 행을 되찾지 못한다', async () => {
  // 표식(extendedProperties.private)은 공격자가 자기 캘린더의 일정에 마음대로 적을 수 있는 값이다.
  // 되찾기가 소유자를 확인하지 않으면 남의 개인 일정을 자기 구글로 끌어오거나 통째로 덮어쓸 수 있다.
  const store = freshStore()
  const victim = eventRow({
    id: 'EV-OH-SECRET', title: '오태식 개인 병원 예약', location: '서울성모병원 3층', note: '진료 기록 지참',
  })
  store.tenants[TENANT]['calendar-events'] = { data: [victim], updatedAt: '2026-09-09T00:00:00.000Z', updatedBy: OH.id }
  const clock = movableClock('2026-09-10T01:00:00.000Z')
  const fake = createFakeGoogle({ now: clock, events: [] })
  const { app } = await buildApp(store, { clock, fake })
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    // 전제: 박지현에게 오태식의 개인 일정은 보이지 않는다.
    assert.deepEqual((await call('GET', '/api/workspace/calendar-events')).body.data.map((row) => row.id), [])

    fake.setEvent(CAL, {
      id: 'EV-ATTACK', summary: '가로채기', status: 'confirmed',
      start: { dateTime: '2026-09-11T09:00:00+09:00' }, end: { dateTime: '2026-09-11T10:00:00+09:00' },
      extendedProperties: { private: { inthefieldEventId: 'EV-OH-SECRET', inthefieldTenantId: TENANT, inthefieldKind: 'event' } },
    })
    clock.advance(60_000)
    const synced = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(synced.status, 200, JSON.stringify(synced.body))
    assert.equal(synced.body.result.pushed, 0, '남의 행이 구글로 나가면 안 된다')
    assert.equal(synced.body.result.conflicts, 0)

    // 피해자의 행은 한 글자도 바뀌지 않았다.
    assert.deepEqual(eventRows(store).find((row) => row.id === 'EV-OH-SECRET'), victim)
    // 공격자의 구글 일정도 그대로다 — 피해자 본문이 흘러 들어가지 않았다.
    const attacker = fake.eventsOf(CAL).find((event) => event.id === 'EV-ATTACK')
    assert.equal(attacker.summary, '가로채기')
    assert.equal(attacker.location, undefined)
    // 링크는 남의 행이 아니라 새로 가져온 자기 행에 붙는다.
    assert.equal(linkRows(store).some((link) => link.eventId === 'EV-OH-SECRET'), false)
  })
})

test('32. 내보낸 전사 일정이 구글 수정을 따라와도 공개 범위는 그대로다', async () => {
  // fromGoogleEvent의 scope:'personal'은 구글에서 처음 온 행에는 옳지만, 우리가 내보냈던 전사 일정에
  // 그대로 씌우면 그 일정이 조용히 개인 일정이 되어 다른 직원의 달력에서 사라진다.
  const store = freshStore()
  const company = eventRow({
    id: 'EV-COMPANY-1', title: '전사 창립기념 행사', scope: 'company', department: '전사',
    owner: PARK.name, ownerId: PARK.id, date: '2026-09-18', start: '10:00', end: '12:00',
  })
  store.tenants[TENANT]['calendar-events'] = { data: [company], updatedAt: '2026-09-09T00:00:00.000Z', updatedBy: PARK.id }
  const clock = movableClock('2026-09-10T01:00:00.000Z')
  const fake = createFakeGoogle({ now: clock, events: [] })
  const { app } = await buildApp(store, { clock, fake })
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    clock.advance(60_000)
    const first = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(first.body.result.pushed, 1, JSON.stringify(first.body.result))
    const remoteId = fake.eventsOf(CAL)[0].id

    clock.advance(60_000)
    fake.setEvent(CAL, { id: remoteId, summary: '창립기념 행사(장소 변경)', updated: clock().toISOString() })
    clock.advance(60_000)
    const second = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(second.body.result.pulled, 1, JSON.stringify(second.body.result))

    const after = eventRows(store).find((row) => row.id === 'EV-COMPANY-1')
    assert.equal(after.title, '창립기념 행사(장소 변경)', '여섯 칸은 따라온다')
    assert.equal(after.scope, 'company', '공개 범위는 동기화가 건드릴 값이 아니다')
    assert.equal(after.department, '전사')
    assert.equal(after.owner, PARK.name)
    assert.equal(after.ownerId, PARK.id)
    // 다른 직원에게도 여전히 보인다 — 이것이 이 회귀가 지키는 사실이다.
    const oh = api(origin, await login(origin, OH.email))
    assert.equal((await oh('GET', '/api/workspace/calendar-events')).body.data.some((row) => row.id === 'EV-COMPANY-1'), true)
  })
})

test('33. 동의 화면에서 그냥 돌아서면 연결됨이 아니고 재연결 알림도 없다', async () => {
  const store = freshStore()
  const { app, clock } = await buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const call = api(origin, park)
    const authorized = await call('GET', '/api/integrations/google/calendar/authorize')
    assert.equal(authorized.status, 200)
    // 콜백은 오지 않았다.
    const status = await call('GET', '/api/integrations/google/calendar')
    assert.notEqual(status.body.connection.status, 'connected', '토큰이 없는 행을 연결됨이라 부르면 안 된다')
    assert.equal(status.body.connection.status, 'revoked')

    // 관리자 개관도 같은 판정을 쓴다.
    const admin = api(origin, await login(origin, ADMIN.email))
    assert.equal((await admin('GET', '/api/integrations/google/calendar/overview')).body.rows[0].status, 'revoked')

    clock.advance(60_000)
    const synced = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(synced.status, 409)
    // 한 번도 연결된 적 없는 계정에 '연결이 끊겼습니다'를 밀어 보내지 않는다.
    const notifications = (store.tenants[TENANT].notifications?.data ?? []).filter((row) => row.type === 'calendar-reauth')
    assert.equal(notifications.length, 0, JSON.stringify(notifications))
  })
})

test('34. 업무 마감은 2회차에도 410 재조회 뒤에도 구글에 살아 있다', async () => {
  const store = freshStore()
  const { app, fake, clock } = await buildApp(store, { fake: undefined })
  await withServer(app, async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    assert.equal((await admin('PUT', '/api/workspace/work-items', {
      data: [{
        id: 'WK-DUE', title: '보고서 제출', description: '', owner: PARK.name, ownerId: PARK.id,
        requestedBy: '김서원', requesterId: ADMIN.id, due: '2026-09-30T09:00:00.000Z',
        priority: '보통', status: '업무요청', category: '일반',
      }],
    })).status, 200)

    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    clock.advance(60_000)
    await call('POST', '/api/integrations/google/calendar/sync')
    const alive = () => fake.eventsOf(CAL).filter((event) => event.summary === '[마감] 보고서 제출' && event.status !== 'cancelled')
    const inserts = () => fake.requests.filter((request) => request.pathname === '/events.insert').length
    assert.equal(alive().length, 1, '1회차에 마감이 나가야 한다')
    assert.equal(inserts(), 1)

    // 2회차: 구글의 증분 목록은 우리가 방금 쓴 항목도 돌려준다. 그것을 '사람이 지웠다'로 읽으면
    // 지웠다 다시 만드는 무한 왕복이 된다.
    clock.advance(60_000)
    const second = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(second.body.result.deletedRemote, 0, JSON.stringify(second.body.result))
    assert.equal(alive().length, 1, '2회차에서 마감이 사라졌다')
    assert.equal(inserts(), 1, '지웠다 다시 만들면 insert가 늘어난다')

    // 410 전량 재조회 뒤에도 마찬가지다.
    fake.state.syncTokens.set(CAL, 'stale-token')
    clock.advance(60_000)
    const third = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(third.body.result.deletedRemote, 0, JSON.stringify(third.body.result))
    assert.equal(alive().length, 1, '전량 재조회 뒤에 마감이 사라졌다')
    assert.equal(inserts(), 1)
  })
})

test('35. 결재완료된 업무의 마감 표식은 구글에서 걷힌다', async () => {
  const store = freshStore()
  const { app, fake, clock } = await buildApp(store)
  await withServer(app, async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const item = {
      id: 'WK-DUE', title: '보고서 제출', description: '', owner: PARK.name, ownerId: PARK.id,
      requestedBy: '김서원', requesterId: ADMIN.id, due: '2026-09-30T09:00:00.000Z',
      priority: '보통', status: '업무요청', category: '일반',
    }
    assert.equal((await admin('PUT', '/api/workspace/work-items', { data: [item] })).status, 200)

    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    clock.advance(60_000)
    await call('POST', '/api/integrations/google/calendar/sync')
    const marker = () => fake.eventsOf(CAL).find((event) => event.summary === '[마감] 보고서 제출')
    assert.equal(marker().status, 'confirmed')
    // 한 통과를 더 돈다: 이제 구글의 증분 목록은 이 표식을 더 이상 돌려주지 않는다.
    // 그러므로 아래 삭제는 원격 목록이 아니라 '업무가 더는 후보가 아니다'만 보고 내리는 판단이다.
    clock.advance(60_000)
    await call('POST', '/api/integrations/google/calendar/sync')

    assert.equal((await admin('PUT', '/api/workspace/work-items', { data: [{ ...item, status: '결재완료' }] })).status, 200)
    clock.advance(60_000)
    const swept = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(swept.body.result.deletedRemote, 1, JSON.stringify(swept.body.result))
    assert.equal(marker().status, 'cancelled', '끝난 마감이 달력에 영원히 남으면 안 된다')
    assert.equal(linkRows(store).some((link) => link.workItemId === 'WK-DUE'), false)
  })
})

test('36. 인더필드가 이긴 충돌은 구글에 실제로 도달하고 다음 통과는 조용하다', async () => {
  const store = freshStore()
  const { app, fake, clock } = await buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    clock.advance(60_000)
    await call('POST', '/api/integrations/google/calendar/sync')
    const link = linkRows(store).find((row) => row.externalId === 'EV-TIMED')

    // 우리가 나중에 고친다: 원격 수정 시각을 목록 시점 직후로 두고, 우리 저장은 그보다 뒤에 한다.
    const remoteAt = new Date(clock().getTime() + 1_000).toISOString()
    fake.setEvent(CAL, { id: 'EV-TIMED', summary: 'Weekly sync', status: 'confirmed', updated: remoteAt })
    clock.advance(60_000)
    const mine = eventRows(store).map((event) => (event.id === link.eventId ? { ...event, title: '주간 회의' } : event))
    assert.equal((await call('PUT', '/api/workspace/calendar-events', { data: mine })).status, 200)

    clock.advance(60_000)
    const conflicted = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(conflicted.body.result.conflicts, 1, JSON.stringify(conflicted.body.result))
    assert.equal(conflicted.body.result.pushed, 1, '이긴 값이 구글에 도달하지 않으면 두 쪽이 영원히 어긋난다')
    assert.equal(fake.eventsOf(CAL).find((event) => event.id === 'EV-TIMED').summary, '주간 회의')

    // 다음 통과: 증분 목록이 우리가 쓴 것을 돌려주지만 양쪽이 같으므로 아무 요청도 더 나가지 않는다.
    const before = fake.requests.length
    clock.advance(60_000)
    const settled = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(settled.status, 200, JSON.stringify(settled.body))
    assert.deepEqual(fake.requests.slice(before).map((request) => request.pathname), ['/events.list'])
    assert.deepEqual(settled.body.result, { pulled: 0, pushed: 0, conflicts: 0, deletedLocal: 0, deletedRemote: 0, skipped: 0 })
  })
})

test('37. 410 전량 재조회에서도 구글에서 지운 일정이 우리 쪽에서 사라진다', async () => {
  // 전량 목록은 showDeleted=false로 나간다 — '목록에 없음'이 곧 삭제다.
  // 증분 규칙(없음=무변경)을 그대로 쓰면 토큰 만료가 한 번 낄 때마다 원격 삭제가 영영 묻힌다.
  const store = freshStore()
  const { app, fake, clock } = await buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    clock.advance(60_000)
    await call('POST', '/api/integrations/google/calendar/sync')
    const link = linkRows(store).find((row) => row.externalId === 'EV-TIMED')
    assert.ok(link)

    fake.removeEvent(CAL, 'EV-TIMED')
    fake.state.syncTokens.set(CAL, 'stale-token')
    clock.advance(60_000)
    const swept = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(swept.status, 200, JSON.stringify(swept.body))
    assert.equal(swept.body.result.deletedLocal, 1, JSON.stringify(swept.body.result))
    assert.equal(eventRows(store).some((event) => event.id === link.eventId), false)
    assert.equal(linkRows(store).find((row) => row.id === link.id).history[0].source, 'google')
    // 나머지 일정은 그대로다 — '목록에 없다'가 아니라 '전량 목록에 없다'만 삭제로 읽는다.
    assert.equal(eventRows(store).length >= 3, true, JSON.stringify(eventRows(store).map((row) => row.id)))
  })
})

test('38. 캘린더를 상한보다 많이 고르면 조용히 자르지 않고 400으로 말한다', async () => {
  const store = freshStore()
  const { app } = await buildApp(store)
  await withServer(app, async (origin) => {
    const { call } = await connect(origin, await login(origin, PARK.email))
    const many = Array.from({ length: 11 }, (_, index) => `cal-${index}@example.test`)
    const rejected = await call('PATCH', '/api/integrations/google/calendar/calendars', { selected: many })
    assert.equal(rejected.status, 400)
    assert.equal(rejected.body.error.code, 'CALENDAR_TOO_MANY_SELECTED')
    assert.equal(rejected.body.error.message, '동기화할 캘린더는 최대 10개까지 고를 수 있습니다.')
    // 저장은 일어나지 않았다.
    const status = await call('GET', '/api/integrations/google/calendar')
    assert.deepEqual(status.body.connection.calendars.filter((calendar) => calendar.selected).map((calendar) => calendar.id), [CAL])
  })
})

test('40. generic PUT이 찍는 링크 시각은 주입 시계 위에 있다', async () => {
  // 이 한 줄만 벽시계를 읽으면 충돌 판정이 비교하는 두 값(link.localUpdatedAt과 remote.updated)이
  // 서로 다른 시간축에 놓인다. 그러면 승자가 '오늘이 며칠인가'에 따라 뒤집히고,
  // 지금 초록인 시험이 며칠 뒤 아무 이유 없이 빨강이 된다.
  const store = freshStore()
  const { app, clock } = await buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    clock.advance(60_000)
    await call('POST', '/api/integrations/google/calendar/sync')
    const link = linkRows(store).find((row) => row.externalId === 'EV-TIMED')

    clock.advance(60_000)
    const mine = eventRows(store).map((event) => (event.id === link.eventId ? { ...event, title: '주간 회의' } : event))
    assert.equal((await call('PUT', '/api/workspace/calendar-events', { data: mine })).status, 200)
    assert.equal(linkRows(store).find((row) => row.id === link.id).localUpdatedAt, clock().toISOString())
  })
})

test('39. 회전된 refresh 토큰은 마지막 커밋이 실패해도 살아남는다', async () => {
  // 구글이 회전시킨 순간 옛 값은 무효다. 새 값을 마지막 커밋까지 들고 가다 실패하면
  // 저장소에는 이미 죽은 옛 값만 남고 그 계정은 다음 통과에서 영구히 끊긴다.
  const store = freshStore()
  let armed = false
  let commits = 0
  const { app, fake, clock, env } = await buildApp(store, {
    onWorkspaceStoreChange: () => {
      if (!armed) return
      commits += 1
      if (commits === 2) throw new Error('commit boom')
    },
  })
  const { createSecretBox } = await import('./secret-box.mjs')
  const box = createSecretBox({ env, logger: { warn: () => {} } })
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    const aad = `google-calendar:${TENANT}:${park.account.id}`
    assert.equal(box.open(connectionRow(store, park.account.id).refreshTokenEnc, { aad }), 'fake-refresh-1')

    fake.rotateRefreshToken()
    connectionRow(store, park.account.id).tokenExpiresAt = new Date(clock().getTime() - 60_000).toISOString()
    clock.advance(60_000)
    armed = true
    const failed = await call('POST', '/api/integrations/google/calendar/sync')
    armed = false
    assert.equal(failed.status, 500, JSON.stringify(failed.body))
    assert.equal(commits, 2, '갱신 커밋과 마지막 커밋 두 번이어야 한다')
    assert.equal(box.open(connectionRow(store, park.account.id).refreshTokenEnc, { aad }), 'fake-refresh-2')
  })
})

/** 로컬에서 만든(구글에서 오지 않은) 개인 일정 한 벌. 내보내기 스위치가 실제로 꺼져 있는지 재는 데 쓴다. */
const localEvent = (overrides = {}) => ({
  id: 'EV-LOCAL', title: '병원 예약', date: '2026-09-20', start: '10:00', end: '11:00',
  scope: 'personal', department: '영업', location: '', owner: PARK.name, note: '', ownerId: PARK.id, ...overrides,
})

test('41. 재연결은 고른 캘린더도 "내보내지 않음"도 지우지 않는다', async () => {
  // 배너가 시키는 대로 '다시 연결'을 눌렀을 뿐인데 선택이 초기화되고 내보내기가 스스로 켜지면,
  // 사용자는 아무것도 하지 않은 채 개인 일정이 구글로 나가는 것을 보게 된다.
  const store = freshStore()
  store.tenants[TENANT]['calendar-events'] = { data: [localEvent()], updatedAt: '2026-09-01T00:00:00.000Z', updatedBy: 'seed' }
  const { app, fake, clock } = await buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    const chosen = await call('PATCH', '/api/integrations/google/calendar/calendars', { selected: [CAL, SHARED], writeCalendarId: '' })
    assert.equal(chosen.status, 200, JSON.stringify(chosen.body))
    assert.equal(connectionRow(store, park.account.id).writeCalendarId, '')

    clock.advance(60_000)
    await connect(origin, park)   // 재연결 — 사용자가 한 일은 이것뿐이다.

    const row = connectionRow(store, park.account.id)
    assert.deepEqual(row.calendars.filter((calendar) => calendar.selected).map((calendar) => calendar.id), [CAL, SHARED], '고른 캘린더가 초기화되면 안 된다')
    assert.equal(row.writeCalendarId, '', '내보내기가 스스로 켜지면 안 된다')

    clock.advance(60_000)
    assert.equal((await call('POST', '/api/integrations/google/calendar/sync')).status, 200)
    assert.equal(fake.requests.filter((request) => request.pathname === '/events.insert').length, 0)
    assert.equal(fake.eventsOf(CAL).some((event) => event.summary === '병원 예약'), false, '끈 적 없는 내보내기가 개인 일정을 내보냈다')
  })
})

test('42. 같은 공유 캘린더를 두 사람이 골라도 서로의 행을 빼앗지 않는다', async () => {
  // 링크 id·일정 id에 계정이 없으면 두 사람이 같은 행을 만든다 — 나중에 동기화한 사람이
  // 앞사람의 덮어쓴 내역을 지우고 소유자를 자기로 바꾼다.
  const store = freshStore()
  const { app, fake, clock } = await buildApp(store)
  fake.setEvent(SHARED, {
    id: 'EV-TEAM', summary: '팀 회의', status: 'confirmed',
    start: { dateTime: '2026-09-10T14:00:00+09:00' }, end: { dateTime: '2026-09-10T15:00:00+09:00' },
    location: '', description: '', updated: '2026-09-09T09:00:00.000Z',
  })
  await withServer(app, async (origin) => {
    const syncAs = async (person) => {
      const session = await login(origin, person.email)
      const { call } = await connect(origin, session)
      assert.equal((await call('PATCH', '/api/integrations/google/calendar/calendars', { selected: [SHARED], writeCalendarId: '' })).status, 200)
      clock.advance(60_000)
      const synced = await call('POST', '/api/integrations/google/calendar/sync')
      assert.equal(synced.status, 200, JSON.stringify(synced.body))
      return { session, call, result: synced.body.result }
    }
    const park = await syncAs(PARK)
    assert.equal(park.result.pulled, 1)
    const parkEvent = eventRows(store).find((event) => event.ownerId === PARK.id && event.title === '팀 회의')
    assert.ok(parkEvent, '박지현이 가져온 행이 없다')
    assert.equal((await park.call('GET', `/api/calendar/events/${parkEvent.id}/overwrites`)).status, 200)

    const oh = await syncAs(OH)
    assert.equal(oh.result.pulled, 1, '두 번째 사람도 자기 행을 가져와야 한다')

    const teamLinks = linkRows(store).filter((link) => link.externalId === 'EV-TEAM')
    assert.equal(teamLinks.length, 2, '한 벌뿐이면 한 사람의 링크가 다른 사람의 것으로 덮였다')
    assert.deepEqual([...new Set(teamLinks.map((link) => link.accountId))].sort(), [OH.id, PARK.id].sort())
    const teamEvents = eventRows(store).filter((event) => event.title === '팀 회의')
    assert.equal(teamEvents.length, 2)
    assert.deepEqual([...new Set(teamEvents.map((event) => event.ownerId))].sort(), [OH.id, PARK.id].sort())

    // 앞사람의 행은 그대로 있고 이력 조회도 그대로 200이다.
    assert.ok(eventRows(store).some((event) => event.id === parkEvent.id && event.ownerId === PARK.id), '소유자가 뒤에 동기화한 사람으로 넘어갔다')
    assert.equal((await park.call('GET', `/api/calendar/events/${parkEvent.id}/overwrites`)).status, 200, '남의 통과가 덮어쓴 내역을 지웠다')
    const mine = await park.call('GET', '/api/workspace/calendar-events')
    assert.ok((mine.body.data ?? []).some((event) => event.id === parkEvent.id), '자기 화면에서 일정이 사라졌다')

    // 2회차는 양쪽 다 조용하다.
    for (const person of [park, oh]) {
      clock.advance(60_000)
      const again = await person.call('POST', '/api/integrations/google/calendar/sync')
      assert.deepEqual(again.body.result, { pulled: 0, pushed: 0, conflicts: 0, deletedLocal: 0, deletedRemote: 0, skipped: 0 }, JSON.stringify(again.body.result))
    }
  })
})

test('43. 비활성 계정의 연결은 통과를 돌지 않고 그 자리에서 끊긴다', async () => {
  // 퇴사한 사람의 연결이 계속 돌면 그 사람의 개인 구글 일정이 회사 저장소로 계속 들어오고,
  // 본인은 세션이 끊겨 해제할 수도 없다.
  const store = freshStore()
  const { app, fake, clock } = await buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    clock.advance(60_000)
    await call('POST', '/api/integrations/google/calendar/sync')
    const before = eventRows(store).length
    assert.ok(before > 0)

    const admin = api(origin, await login(origin, ADMIN.email))
    // 이 판정은 '퇴사'만 걸러야 한다 — 명단에 있는 관리자는 여전히 연결을 시작할 수 있다.
    assert.equal((await admin('GET', '/api/integrations/google/calendar/authorize')).status, 200)
    assert.equal((await admin('POST', `/api/admin/accounts/${PARK.id}/status`, { status: 'inactive' })).status, 200)

    // 그 사이 구글에 새 일정이 생겨도 가져오지 않는다.
    fake.setEvent(CAL, {
      id: 'EV-AFTER', summary: '퇴사 뒤 개인 일정', status: 'confirmed',
      start: { dateTime: '2026-09-18T10:00:00+09:00' }, end: { dateTime: '2026-09-18T11:00:00+09:00' },
    })
    clock.advance(60_000)
    const summary = await app.locals.calendarSync.runAll({ now: clock() })
    assert.equal(summary.connections, 0, '비활성 계정의 연결을 돌렸다')
    assert.equal(summary.retired, 1)
    assert.equal(eventRows(store).length, before, '퇴사자의 구글 일정이 회사 저장소로 들어왔다')

    const row = connectionRow(store, PARK.id)
    assert.equal(row.accessTokenEnc, null)
    assert.equal(row.refreshTokenEnc, null, '봉인된 토큰이 퇴사 뒤에도 저장소에 남으면 안 된다')
    assert.equal(row.status, 'revoked')
    assert.ok(row.disconnectedAt)
    assert.ok(fake.requests.some((request) => request.pathname === '/revoke'), '구글에도 최선 노력으로 알린다')
  })
})

test('44. 읽기 전용 캘린더로는 내보내지 않고 그 사실을 한 문장으로 말한다', async () => {
  // 읽기 전용 캘린더로 PATCH를 내면 진짜 구글은 403을 낸다. contentHash는 갱신되지 않으므로
  // 같은 쓰기가 매 통과마다 영원히 다시 나가고, 사용자는 '내보냄 0건'만 본다.
  const store = freshStore()
  const { app, fake, clock } = await buildApp(store)
  fake.setEvent(SHARED, {
    id: 'EV-TEAM', summary: '팀 회의', status: 'confirmed',
    start: { dateTime: '2026-09-10T14:00:00+09:00' }, end: { dateTime: '2026-09-10T15:00:00+09:00' },
    location: '', description: '', updated: '2026-09-09T09:00:00.000Z',
  })
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    assert.equal((await call('PATCH', '/api/integrations/google/calendar/calendars', { selected: [SHARED] })).status, 200)
    clock.advance(60_000)
    await call('POST', '/api/integrations/google/calendar/sync')
    const link = linkRows(store).find((row) => row.externalId === 'EV-TEAM')
    assert.ok(link)

    clock.advance(60_000)
    const mine = eventRows(store).map((event) => (event.id === link.eventId ? { ...event, title: '팀 회의(장소 변경)' } : event))
    assert.equal((await call('PUT', '/api/workspace/calendar-events', { data: mine })).status, 200)

    const patches = () => fake.requests.filter((request) => request.pathname === '/events.patch').length
    for (let pass = 0; pass < 3; pass += 1) {
      clock.advance(60_000)
      const synced = await call('POST', '/api/integrations/google/calendar/sync')
      assert.equal(synced.status, 200, JSON.stringify(synced.body))
      assert.equal(patches(), 0, `읽기 전용 캘린더로 쓰기를 냈다(통과 ${pass + 1})`)
      assert.equal(connectionRow(store, park.account.id).lastError, '읽기 전용 캘린더에서 가져온 일정은 구글로 보내지 않습니다.')
    }
    // 다이얼로그가 같은 사실을 말할 수 있게 링크에도 남는다 — 이유까지 그대로.
    assert.equal((await call('GET', `/api/calendar/events/${link.eventId}/overwrites`)).body.sourceBlocked, 'read-only')
  })
})

test('45. 한 사람의 통과가 남의 링크에 삭제를 쏘지 않는다', async () => {
  // 내보내기 쓸이 두 곳이 테넌트 전체 링크를 돌면, 한 사람의 통과가 자기 토큰으로 남의 구글 일정을 지우고
  // 남의 링크 행까지 저장소에서 없앤다.
  const store = freshStore()
  const { app, fake, clock } = await buildApp(store)
  await withServer(app, async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    assert.equal((await admin('PUT', '/api/workspace/work-items', {
      data: [{
        id: 'WK-DUE', title: '보고서 제출', description: '', owner: OH.name, ownerId: OH.id,
        requestedBy: '김서원', requesterId: ADMIN.id, due: '2026-09-30T09:00:00.000Z',
        priority: '보통', status: '업무요청', category: '일반',
      }],
    })).status, 200)

    const oh = await login(origin, OH.email)
    const ohCall = (await connect(origin, oh)).call
    clock.advance(60_000)
    await ohCall('POST', '/api/integrations/google/calendar/sync')
    const marker = () => fake.eventsOf(CAL).find((event) => event.summary === '[마감] 보고서 제출')
    assert.equal(marker().status, 'confirmed')

    // 오태식이 앱에서 일정 하나를 지운다(툼스톤). 아직 그의 다음 통과는 돌지 않았다.
    clock.advance(60_000)
    const ohLink = linkRows(store).find((row) => row.externalId === 'EV-TIMED' && row.accountId === OH.id)
    assert.ok(ohLink)
    const kept = eventRows(store).filter((event) => event.id !== ohLink.eventId)
    assert.equal((await ohCall('PUT', '/api/workspace/calendar-events', { data: kept })).status, 200)

    const ohLinksBefore = JSON.stringify(linkRows(store).filter((row) => row.accountId === OH.id))
    const deletesBefore = fake.requests.filter((request) => request.pathname === '/events.delete').length

    const park = await login(origin, PARK.email)
    const parkCall = (await connect(origin, park)).call
    clock.advance(60_000)
    const synced = await parkCall('POST', '/api/integrations/google/calendar/sync')
    assert.equal(synced.status, 200, JSON.stringify(synced.body))
    assert.equal(synced.body.result.deletedRemote, 0, '남의 링크에 삭제를 쐈다')
    assert.equal(fake.requests.filter((request) => request.pathname === '/events.delete').length, deletesBefore)
    assert.equal(JSON.stringify(linkRows(store).filter((row) => row.accountId === OH.id)), ohLinksBefore, '남의 링크 행이 사라졌다')
    assert.equal(marker().status, 'confirmed', '남의 [마감] 표식을 지웠다')
    assert.equal(fake.eventsOf(CAL).find((event) => event.id === 'EV-TIMED').status, 'confirmed', '남의 툼스톤을 내 토큰으로 처리했다')
  })
})

test('46. 되살아난 일정의 구글 원본은 같은 통과에서 지워지지 않는다', async () => {
  // '삭제보다 수정이 이긴다'로 방금 되살린 링크를 낡은 스냅샷으로 읽으면, 같은 통과가 그 구글 원본을
  // 지워 버린다. 다음 통과는 그것을 알맹이 없는 새 일정으로 다시 만든다 — 참석자·주최자·id가 사라진다.
  const store = freshStore()
  const { app, fake, clock } = await buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    clock.advance(60_000)
    await call('POST', '/api/integrations/google/calendar/sync')
    const link = linkRows(store).find((row) => row.externalId === 'EV-TIMED')
    assert.ok(link)

    clock.advance(60_000)
    const kept = eventRows(store).filter((event) => event.id !== link.eventId)
    assert.equal((await call('PUT', '/api/workspace/calendar-events', { data: kept })).status, 200)
    assert.ok(linkRows(store).find((row) => row.id === link.id).localDeletedAt, '툼스톤이 찍히지 않았다')

    // 그 사이 구글에서 같은 일정을 고쳤다 — 삭제보다 수정이 이긴다.
    fake.setEvent(CAL, { id: 'EV-TIMED', summary: 'Weekly sync', status: 'confirmed', updated: new Date(clock().getTime() + 1_000).toISOString() })
    const insertsBefore = fake.requests.filter((request) => request.pathname === '/events.insert').length

    clock.advance(60_000)
    const revived = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(revived.status, 200, JSON.stringify(revived.body))
    assert.equal(revived.body.result.deletedRemote, 0, '되살린 일정의 구글 원본을 같은 통과에서 지웠다')
    assert.equal(eventRows(store).find((event) => event.id === link.eventId)?.title, 'Weekly sync')
    assert.equal(fake.eventsOf(CAL).find((event) => event.id === 'EV-TIMED').status, 'confirmed', '사용자의 진짜 구글 일정이 사라졌다')

    // 3회차: 알맹이 없는 사본을 새로 만들지 않는다.
    clock.advance(60_000)
    await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(fake.requests.filter((request) => request.pathname === '/events.insert').length, insertsBefore)
    assert.equal(fake.eventsOf(CAL).filter((event) => event.summary === 'Weekly sync' && event.status !== 'cancelled').length, 1)
  })
})

test('47. 해제 문구의 "가져온 일정 N건"은 정말 가져온 것만 센다', async () => {
  const store = freshStore()
  store.tenants[TENANT]['calendar-events'] = {
    data: [
      { id: 'EV-WORKSHOP', title: '전사 워크숍', date: '2026-09-18', start: '09:00', end: '18:00', scope: 'company', department: '전사', location: '본사', owner: '김서원', note: '', ownerId: ADMIN.id },
      { id: 'EV-DINNER', title: '팀 회식', date: '2026-09-19', start: '18:30', end: '21:00', scope: 'department', department: '영업', location: '', owner: OH.name, note: '', ownerId: OH.id },
    ],
    updatedAt: '2026-09-01T00:00:00.000Z', updatedBy: 'seed',
  }
  const { app, clock } = await buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    clock.advance(60_000)
    const synced = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(synced.body.result.pulled, 5)
    assert.equal(eventRows(store).length, 7)

    const disconnected = await call('POST', '/api/integrations/google/calendar/disconnect')
    assert.equal(disconnected.status, 200)
    assert.equal(disconnected.body.keptEvents, 5, '남의 전사·부서 일정까지 "가져온 일정"으로 세면 안 된다')
  })
})

test('48. 모양이 어긋난 원격 행은 저장하지 않고 skipped로 센다', async () => {
  // 어긋난 행 한 줄이 calendar-events에 들어가면 mergeMemberCalendarEvents가 그 뒤로
  // 전 직원의 일정 저장을 403으로 막는다 — 설계가 이름 붙인 그 사고다.
  const store = freshStore()
  const clock = movableClock('2026-09-10T01:00:00.000Z')
  const fake = createFakeGoogle({
    now: clock,
    events: [...fixtureEvents(), {
      // 날짜 형식이 어긋난 종일 일정. fromGoogleEvent는 행을 만들지만 hasCalendarShape는 거절한다.
      id: 'EV-BROKEN', summary: '깨진 날짜', status: 'confirmed', start: { date: '2026-9-1' },
      updated: '2026-09-09T09:00:00.000Z', etag: '"1"',
    }],
  })
  const { app } = await buildApp(store, { clock, fake })
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    clock.advance(60_000)
    const synced = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(synced.status, 200, JSON.stringify(synced.body))
    assert.equal(synced.body.result.pulled, 5)
    assert.ok(synced.body.result.skipped >= 1, JSON.stringify(synced.body.result))
    assert.equal(eventRows(store).some((event) => event.title === '깨진 날짜'), false)
    // 그 뒤로도 전 직원의 일정 저장이 살아 있다.
    assert.equal((await call('PUT', '/api/workspace/calendar-events', { data: eventRows(store) })).status, 200)
  })
})

test('49. 재연결 알림은 토큰 갱신을 사이에 두고도 한 번뿐이다', async () => {
  // 갱신이 성공하면 status가 'connected'로 돌아온다. 상태값만으로 중복을 막으면
  // 갱신은 되는데 캘린더 API가 401을 내는 연결이 통과마다 새 알림을 밀어 보낸다.
  const store = freshStore()
  const { app, fake, clock } = await buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    const notificationsOf = () => (store.tenants[TENANT].notifications?.data ?? []).filter((row) => row.type === 'calendar-reauth')

    clock.advance(60_000)
    fake.failNext('events.list', { outcome: 'reauth', status: 401, reason: 'unauthorized' })
    assert.equal((await call('POST', '/api/integrations/google/calendar/sync')).status, 409)
    assert.equal(notificationsOf().length, 1)

    // 액세스 토큰을 만료시켜 갱신 경로를 태운다 — 갱신은 성공하고 status는 'connected'로 돌아온다.
    connectionRow(store, park.account.id).tokenExpiresAt = new Date(clock().getTime() - 60_000).toISOString()
    clock.advance(2 * 60 * 60 * 1_000)
    fake.failNext('events.list', { outcome: 'reauth', status: 401, reason: 'unauthorized' })
    assert.equal((await call('POST', '/api/integrations/google/calendar/sync')).status, 409)
    assert.equal(notificationsOf().length, 1, '같은 사실을 두 번 통보하면 사람은 알림을 꺼 버린다')

    // 실제로 다시 연결하면 다음 사고는 다시 알린다.
    await connect(origin, park)
    clock.advance(60_000)
    fake.failNext('events.list', { outcome: 'reauth', status: 401, reason: 'unauthorized' })
    assert.equal((await call('POST', '/api/integrations/google/calendar/sync')).status, 409)
    assert.equal(notificationsOf().length, 2)
  })
})

test('50. 상한을 넘긴 원격 쓰기는 조용히 사라지지 않고 skipped로 센다', async () => {
  const store = freshStore()
  const { app, clock } = await buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    const connectionId = connectionRow(store, park.account.id).id
    // 1회차로 증분 토큰을 만든다. 2회차부터는 전량 목록이 아니라서 '목록에 없는 링크' 판정이 돌지 않고,
    // 고른 캘린더 위의 툼스톤이 먼저 정리되지 않은 채 툼스톤 쓸이까지 온다.
    clock.advance(60_000)
    assert.equal((await call('POST', '/api/integrations/google/calendar/sync')).status, 200)

    const stamp = clock().toISOString()
    // 상한(300)보다 하나 많은 툼스톤. 가져오기 고리 밖에서 쌓이는 쓰기라 예전에는 세지 않고 잘렸다.
    // **고른·쓸 수 있는 캘린더에 둔다** — 고르지 않은 캘린더에 두면 게이트가 먼저 막아 삭제가 0건이 된다.
    store.tenants[TENANT]['calendar-sync-links'] = {
      data: [...linkRows(store), ...Array.from({ length: 301 }, (unused, index) => ({
        id: `CLK-OVER-${index}`, connectionId, accountId: park.account.id, calendarId: CAL,
        eventId: null, workItemId: null, kind: 'event', externalId: `EV-OVER-${index}`,
        externalEtag: '', contentHash: '', remoteUpdatedAt: null, localUpdatedAt: stamp,
        localDeletedAt: stamp, remoteDeletedAt: null, detachedAt: null,
        truncated: '', readOnly: false, origin: 'inthefield', history: [], createdAt: stamp, updatedAt: stamp,
      }))],
      updatedAt: stamp, updatedBy: 'seed',
    }

    clock.advance(60_000)
    const synced = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(synced.status, 200, JSON.stringify(synced.body))
    assert.equal(synced.body.result.deletedRemote, 300)
    assert.ok(synced.body.result.skipped >= 1, `넘친 쓰기를 세지 않았다: ${JSON.stringify(synced.body.result)}`)
  })
})

test('51. 개관은 지문과 함께 옛 키로 봉인된 연결 수를 센다', async () => {
  const store = freshStore()
  const { app } = await buildApp(store)
  await withServer(app, async (origin) => {
    await connect(origin, await login(origin, PARK.email))
    const admin = api(origin, await login(origin, ADMIN.email))
    const fresh = await admin('GET', '/api/integrations/google/calendar/overview')
    assert.equal(fresh.status, 200)
    assert.equal(fresh.body.staleCount, 0)
    assert.ok(fresh.body.keyFingerprint)

    // 키를 교체한 흉내: 이 행은 옛 지문을 들고 있다.
    connectionRow(store, PARK.id).keyFingerprint = 'deadbeef'
    assert.equal((await admin('GET', '/api/integrations/google/calendar/overview')).body.staleCount, 1)
  })
})

/**
 * 통과 한가운데를 붙잡는 전송. listEvents 첫 호출에서 멈춰 서서, 그 사이에 사용자가 라우트를
 * 하나 더 치게 해 준다. **이 구간이 이 기능의 진짜 경합 구간이다** — 목록·삽입·패치·삭제가
 * 전부 여기 뒤에 있고, 시간당 한 번 도는 스케줄러 통과는 사람이 화면을 보고 있는 동안 돈다.
 */
const holdingTransport = (fake) => {
  let reached = () => {}
  let release = () => {}
  const arrived = new Promise((resolve) => { reached = resolve })
  const held = new Promise((resolve) => { release = resolve })
  const control = { arrived, release: () => release(), armed: false }
  const transport = {
    ...fake.transport,
    async listEvents(args) {
      if (control.armed) { control.armed = false; reached(); await held }
      return fake.transport.listEvents(args)
    },
  }
  return { control, fake: { ...fake, transport } }
}

test('52. 읽기 전용 캘린더에서 가져온 일정을 지워도 구글에 삭제를 내지 않는다', async () => {
  // 패치와 똑같은 이유로 삭제도 막아야 한다: 진짜 구글은 403을 내고, 툼스톤은 그대로 남으므로
  // **같은 DELETE가 매 통과 영원히 다시 나간다.** 그리고 아무 화면도 그 사실을 말하지 않았다.
  const store = freshStore()
  const { app, fake, clock } = await buildApp(store)
  fake.setEvent(SHARED, {
    id: 'EV-TEAM', summary: '팀 회의', status: 'confirmed',
    start: { dateTime: '2026-09-10T14:00:00+09:00' }, end: { dateTime: '2026-09-10T15:00:00+09:00' },
    location: '', description: '', updated: '2026-09-09T09:00:00.000Z',
  })
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    assert.equal((await call('PATCH', '/api/integrations/google/calendar/calendars', { selected: [SHARED] })).status, 200)
    clock.advance(60_000)
    await call('POST', '/api/integrations/google/calendar/sync')
    const link = linkRows(store).find((row) => row.externalId === 'EV-TEAM')
    assert.ok(link)

    // 사람이 앱에서 그 줄을 지운다.
    clock.advance(60_000)
    const kept = eventRows(store).filter((event) => event.id !== link.eventId)
    assert.equal((await call('PUT', '/api/workspace/calendar-events', { data: kept })).status, 200)
    assert.ok(linkRows(store).find((row) => row.id === link.id).localDeletedAt, '툼스톤이 찍히지 않았다')

    const deletes = () => fake.requests.filter((request) => request.pathname === '/events.delete').length
    for (let pass = 0; pass < 3; pass += 1) {
      clock.advance(60_000)
      const synced = await call('POST', '/api/integrations/google/calendar/sync')
      assert.equal(synced.status, 200, JSON.stringify(synced.body))
      assert.equal(deletes(), 0, `읽기 전용 캘린더에 삭제를 냈다(통과 ${pass + 1})`)
      assert.equal(synced.body.result.deletedRemote, 0)
      assert.equal(
        connectionRow(store, park.account.id).lastError,
        '읽기 전용 캘린더에서 가져온 일정은 구글로 보내지 않습니다.',
        `막힌 사실을 아무 데도 적지 않았다(통과 ${pass + 1})`,
      )
    }
    assert.equal(fake.eventsOf(SHARED).find((event) => event.id === 'EV-TEAM').status, 'confirmed', '남의 공유 캘린더 원본이 사라졌다')
    assert.equal((await call('GET', `/api/calendar/events/${link.eventId}/overwrites`)).body.sourceBlocked, 'read-only')
  })
})

test('53. 동기화에서 뺀 캘린더에는 수정도 삭제도 나가지 않는다', async () => {
  // 화면은 체크박스 밑에서 "선택하지 않은 캘린더는 읽지 않고, 그 캘린더의 일정은 구글로 되돌려
  // 보내지도 않습니다"라고 약속한다. 뺀 캘린더의 팀 일정을 지우는 것은 되돌릴 수 없는 일이다.
  const store = freshStore()
  const clock = movableClock('2026-09-10T01:00:00.000Z')
  const TEAM = 'team@example.test'
  const fake = createFakeGoogle({
    now: clock,
    events: fixtureEvents(),
    calendars: [
      { id: CAL, summary: '내 캘린더', primary: true, accessRole: 'owner' },
      { id: TEAM, summary: '팀 캘린더', primary: false, accessRole: 'owner' },
    ],
  })
  fake.setEvent(TEAM, {
    id: 'EV-TEAMCAL', summary: '팀 미팅', status: 'confirmed',
    start: { dateTime: '2026-09-11T14:00:00+09:00' }, end: { dateTime: '2026-09-11T15:00:00+09:00' },
    location: '', description: '', updated: '2026-09-09T09:00:00.000Z',
  })
  const { app } = await buildApp(store, { clock, fake })
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    assert.equal((await call('PATCH', '/api/integrations/google/calendar/calendars', { selected: [CAL, TEAM] })).status, 200)
    clock.advance(60_000)
    await call('POST', '/api/integrations/google/calendar/sync')
    const link = linkRows(store).find((row) => row.externalId === 'EV-TEAMCAL')
    assert.ok(link, '팀 캘린더 일정을 가져오지 못했다')

    // 사용자가 팀 캘린더를 동기화 대상에서 뺀다.
    assert.equal((await call('PATCH', '/api/integrations/google/calendar/calendars', { selected: [CAL] })).status, 200)

    // (a) 고쳐도 나가지 않는다.
    clock.advance(60_000)
    const edited = eventRows(store).map((event) => (event.id === link.eventId ? { ...event, title: '팀 미팅(변경)' } : event))
    assert.equal((await call('PUT', '/api/workspace/calendar-events', { data: edited })).status, 200)
    clock.advance(60_000)
    let synced = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(synced.status, 200, JSON.stringify(synced.body))
    assert.equal(fake.requests.filter((request) => request.query?.calendarId === TEAM && request.method === 'PATCH').length, 0)
    assert.equal(fake.eventsOf(TEAM).find((event) => event.id === 'EV-TEAMCAL').summary, '팀 미팅')
    assert.equal(
      connectionRow(store, park.account.id).lastError,
      '동기화 대상에서 뺀 캘린더의 일정이라 이 변경은 구글로 보내지 않았습니다.',
    )
    assert.equal((await call('GET', `/api/calendar/events/${link.eventId}/overwrites`)).body.sourceBlocked, 'unselected')

    // (b) 지워도 나가지 않는다 — 세 통과 내내.
    clock.advance(60_000)
    const kept = eventRows(store).filter((event) => event.id !== link.eventId)
    assert.equal((await call('PUT', '/api/workspace/calendar-events', { data: kept })).status, 200)
    for (let pass = 0; pass < 3; pass += 1) {
      clock.advance(60_000)
      synced = await call('POST', '/api/integrations/google/calendar/sync')
      assert.equal(synced.status, 200, JSON.stringify(synced.body))
      assert.equal(synced.body.result.deletedRemote, 0, `뺀 캘린더에 삭제를 쐈다(통과 ${pass + 1})`)
    }
    assert.equal(fake.requests.filter((request) => request.pathname === '/events.delete').length, 0)
    assert.equal(fake.eventsOf(TEAM).find((event) => event.id === 'EV-TEAMCAL').status, 'confirmed', '뺀 캘린더의 팀 일정을 지웠다')
  })
})

test('54. 내보내지 않음이면 충돌에서 이겨도 구글로 나가지 않는다', async () => {
  // '내보내지 않음'은 새 일정만이 아니라 이미 연결된 일정의 수정에도 걸린다.
  // 가져오기 고리 안에서 계획되는 충돌 패치는 예전에 그 판정 밖에 있었다.
  const store = freshStore()
  const { app, fake, clock } = await buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    clock.advance(60_000)
    await call('POST', '/api/integrations/google/calendar/sync')
    const link = linkRows(store).find((row) => row.externalId === 'EV-TIMED')
    assert.ok(link)

    assert.equal((await call('PATCH', '/api/integrations/google/calendar/calendars', { writeCalendarId: '' })).status, 200)
    assert.equal(connectionRow(store, park.account.id).writeCalendarId, '')

    // 구글이 먼저 바뀌고(t2), 우리가 나중에 바뀐다(t3) — 마지막 수정 우선이면 인더필드가 이긴다.
    clock.advance(60_000)
    fake.setEvent(CAL, { id: 'EV-TIMED', summary: 'Weekly sync', status: 'confirmed', updated: clock().toISOString() })
    clock.advance(60_000)
    const edited = eventRows(store).map((event) => (event.id === link.eventId ? { ...event, title: '주간 회의' } : event))
    assert.equal((await call('PUT', '/api/workspace/calendar-events', { data: edited })).status, 200)

    const patches = () => fake.requests.filter((request) => request.pathname === '/events.patch').length
    for (let pass = 0; pass < 2; pass += 1) {
      clock.advance(60_000)
      const synced = await call('POST', '/api/integrations/google/calendar/sync')
      assert.equal(synced.status, 200, JSON.stringify(synced.body))
      assert.equal(patches(), 0, `내보내지 않음인데 구글에 썼다(통과 ${pass + 1})`)
      assert.equal(
        connectionRow(store, park.account.id).lastError,
        '내보낼 캘린더를 ‘내보내지 않음’으로 두어 이 변경은 구글로 보내지 않았습니다.',
        `막힌 사실을 아무 데도 적지 않았다(통과 ${pass + 1})`,
      )
    }
    assert.equal(fake.eventsOf(CAL).find((event) => event.id === 'EV-TIMED').summary, 'Weekly sync', '구글 값이 우리 값으로 덮였다')
  })
})

test('55. 여러 날 구글 일정을 여기서 지워도 구글 원본은 남는다', async () => {
  // 우리 쪽에는 첫날 한 줄만 있다. 그 줄을 지웠다고 사흘짜리 원본을 지우면 사람은 본 적도 없는 것을 잃는다.
  // 다이얼로그가 삭제 버튼 바로 위에서 '여기서 고치거나 지운 내용은 구글로 보내지 않습니다'라고 말하는 그 경우다.
  const store = freshStore()
  const { app, fake, clock } = await buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    clock.advance(60_000)
    await call('POST', '/api/integrations/google/calendar/sync')
    const link = linkRows(store).find((row) => row.externalId === 'EV-MULTIDAY')
    assert.ok(link)
    assert.equal(link.truncated, 'multi-day')

    clock.advance(60_000)
    const kept = eventRows(store).filter((event) => event.id !== link.eventId)
    assert.equal((await call('PUT', '/api/workspace/calendar-events', { data: kept })).status, 200)

    for (let pass = 0; pass < 2; pass += 1) {
      clock.advance(60_000)
      const synced = await call('POST', '/api/integrations/google/calendar/sync')
      assert.equal(synced.status, 200, JSON.stringify(synced.body))
      assert.equal(synced.body.result.deletedRemote, 0, `여러 날 원본을 지웠다(통과 ${pass + 1})`)
    }
    assert.equal(fake.requests.filter((request) => request.query?.eventId === 'EV-MULTIDAY' && request.method === 'DELETE').length, 0)
    assert.equal(fake.eventsOf(CAL).find((event) => event.id === 'EV-MULTIDAY').status, 'confirmed', '사흘짜리 원본이 사라졌다')
    // 카드에는 오류 줄을 남기지 않는다 — 툼스톤이 계속 남아 영영 지워지지 않는 줄이 된다.
    // 사람은 삭제를 누르기 직전 다이얼로그에서 같은 사실을 이미 읽었다.
    assert.equal(connectionRow(store, park.account.id).lastError, '')
  })
})

test('56. 통과 도중 누른 연결 해제는 통과가 끝나며 되살아나지 않는다', async () => {
  // 통과는 첫 네트워크 호출 앞에서 연결 행을 복제해 들고 다닌다. 그 사본을 마지막에 그대로 대입하면
  // **해제가 방금 지운 봉인된 토큰이 되살아난다** — 사용자는 끊었다고 들었는데 앱은 계속 읽는다.
  const store = freshStore()
  const clock = movableClock('2026-09-10T01:00:00.000Z')
  const base = createFakeGoogle({ now: clock, events: fixtureEvents() })
  const { control, fake } = holdingTransport(base)
  const { app } = await buildApp(store, { clock, fake })
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    clock.advance(60_000)
    control.armed = true
    const syncing = call('POST', '/api/integrations/google/calendar/sync')
    await control.arrived

    const disconnected = await call('POST', '/api/integrations/google/calendar/disconnect')
    assert.equal(disconnected.status, 200, JSON.stringify(disconnected.body))
    control.release()
    await syncing

    const row = connectionRow(store, park.account.id)
    assert.equal(row.refreshTokenEnc, null, '해제가 지운 봉인이 되살아났다')
    assert.equal(row.accessTokenEnc, null)
    assert.ok(row.disconnectedAt, '해제 시각이 지워졌다')
    assert.equal((await call('GET', '/api/integrations/google/calendar')).body.connection.status, 'revoked')
    assert.equal(linkRows(store).some((link) => !link.detachedAt), false, '해제가 뗀 링크가 다시 붙었다')

    // 결정적 증거: 해제 뒤 구글에 생긴 일정은 우리 쪽으로 들어오지 않는다.
    const before = eventRows(store).length
    base.setEvent(CAL, {
      id: 'EV-AFTER', summary: '해제 뒤 만든 일정', status: 'confirmed',
      start: { dateTime: '2026-09-20T10:00:00+09:00' }, end: { dateTime: '2026-09-20T11:00:00+09:00' },
    })
    clock.advance(60_000)
    const again = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(again.status, 409, JSON.stringify(again.body))
    assert.equal(eventRows(store).length, before, '해제된 연결이 계속 구글을 읽었다')
    assert.equal(eventRows(store).some((event) => event.title === '해제 뒤 만든 일정'), false)
  })
})

test('57. 통과 도중 바꾼 캘린더 설정은 통과가 끝나며 되돌아가지 않는다', async () => {
  const store = freshStore()
  const clock = movableClock('2026-09-10T01:00:00.000Z')
  const base = createFakeGoogle({ now: clock, events: fixtureEvents() })
  const { control, fake } = holdingTransport(base)
  const { app } = await buildApp(store, { clock, fake })
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    clock.advance(60_000)
    control.armed = true
    const syncing = call('POST', '/api/integrations/google/calendar/sync')
    await control.arrived

    const patched = await call('PATCH', '/api/integrations/google/calendar/calendars', {
      selected: [CAL, SHARED], writeCalendarId: '', pushWorkDue: false,
    })
    assert.equal(patched.status, 200, JSON.stringify(patched.body))
    control.release()
    const synced = await syncing
    assert.equal(synced.status, 200, JSON.stringify(synced.body))

    const row = connectionRow(store, park.account.id)
    assert.deepEqual(row.calendars.filter((calendar) => calendar.selected).map((calendar) => calendar.id), [CAL, SHARED], '고른 캘린더가 되돌아갔다')
    assert.equal(row.writeCalendarId, '', '내보내기가 스스로 켜졌다')
    assert.equal(row.pushWorkDue, false, '마감 보내기가 스스로 켜졌다')
    // 통과가 소유한 칸은 제대로 남는다.
    assert.ok(row.lastSyncAt, '통과 결과가 사라졌다')
    const status = await call('GET', '/api/integrations/google/calendar')
    assert.equal(status.body.connection.writeCalendarId, '')
    assert.equal(status.body.connection.pushWorkDue, false)
  })
})

test('58. 연결 기록 완전 삭제도 구글에 허가를 거둔다', async () => {
  // 이 호출은 암호문을 함께 없앤다. 여기서 거두지 않으면 그 허가는 **다시는 거둘 수 없다** —
  // 버튼은 '연결 기록 완전히 지우기'라고 적혀 있는데 구글 계정에는 허가가 그대로 남는다.
  const store = freshStore()
  const { app, fake } = await buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    assert.equal(fake.state.revoked, 0)
    const removed = await call('DELETE', '/api/integrations/google/calendar')
    assert.equal(removed.status, 200, JSON.stringify(removed.body))
    assert.equal(fake.state.revoked, 1, '허가를 거두지 않고 암호문만 지웠다')
    assert.equal(connectionRow(store, park.account.id), undefined)
  })
})

test('59. APP_PUBLIC_URL 뒤의 슬래시는 주소를 //로 만들지 않는다', async () => {
  const store = freshStore()
  const { app } = await buildApp(store, { env: { APP_PUBLIC_URL: 'https://app.example.test/' } })
  await withServer(app, async (origin) => {
    const session = await login(origin, PARK.email)
    const authorized = await api(origin, session)('GET', '/api/integrations/google/calendar/authorize')
    assert.equal(authorized.status, 200, JSON.stringify(authorized.body))
    const state = new URL(authorized.body.authorizeUrl).searchParams.get('state')
    const redirected = await callback(origin, session, { code: 'CODE', state })
    assert.equal(redirected.headers.get('location'), 'https://app.example.test/?calendar=connected')
  })
})

test('60. 구글 계정에서 사라진 캘린더는 읽기 전용이라고 부르지 않는다', async () => {
  // '없는 캘린더'와 '읽기 전용 캘린더'는 다른 사실이다. 하나로 뭉치면 다이얼로그가
  // 존재하지도 않는 캘린더의 권한을 설명하게 된다 — 사람이 고치러 갈 곳이 없는 안내가 된다.
  const store = freshStore()
  const clock = movableClock('2026-09-10T01:00:00.000Z')
  const TEAM = 'team@example.test'
  const fake = createFakeGoogle({
    now: clock,
    events: fixtureEvents(),
    calendars: [
      { id: CAL, summary: '내 캘린더', primary: true, accessRole: 'owner' },
      { id: TEAM, summary: '팀 캘린더', primary: false, accessRole: 'owner' },
    ],
  })
  fake.setEvent(TEAM, {
    id: 'EV-TEAMCAL', summary: '팀 미팅', status: 'confirmed',
    start: { dateTime: '2026-09-11T14:00:00+09:00' }, end: { dateTime: '2026-09-11T15:00:00+09:00' },
    location: '', description: '', updated: '2026-09-09T09:00:00.000Z',
  })
  const { app } = await buildApp(store, { clock, fake })
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    assert.equal((await call('PATCH', '/api/integrations/google/calendar/calendars', { selected: [CAL, TEAM] })).status, 200)
    clock.advance(60_000)
    await call('POST', '/api/integrations/google/calendar/sync')
    const link = linkRows(store).find((row) => row.externalId === 'EV-TEAMCAL')
    assert.ok(link)

    // 구글 쪽에서 그 캘린더 구독을 끊었다. 재연결하면 목록에서 사라진다.
    fake.state.calendars = fake.state.calendars.filter((calendar) => calendar.id !== TEAM)
    clock.advance(60_000)
    await connect(origin, park)
    assert.equal(connectionRow(store, park.account.id).calendars.some((calendar) => calendar.id === TEAM), false)

    clock.advance(60_000)
    const edited = eventRows(store).map((event) => (event.id === link.eventId ? { ...event, title: '팀 미팅(변경)' } : event))
    assert.equal((await call('PUT', '/api/workspace/calendar-events', { data: edited })).status, 200)
    clock.advance(60_000)
    const synced = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(synced.status, 200, JSON.stringify(synced.body))

    assert.equal(fake.requests.filter((request) => request.query?.calendarId === TEAM && request.method === 'PATCH').length, 0)
    assert.equal(
      connectionRow(store, park.account.id).lastError,
      '구글 계정에서 사라진 캘린더의 일정이라 이 변경은 구글로 보내지 않았습니다.',
    )
    const overwrites = await call('GET', `/api/calendar/events/${link.eventId}/overwrites`)
    assert.equal(overwrites.body.sourceBlocked, 'unknown', '없는 캘린더를 읽기 전용이라고 불렀다')
  })
})

test('61. 내보낼 캘린더로 고른 곳에는 동기화 목록에서 빠져 있어도 쓴다', async () => {
  // 만들 수는 있는데 고칠 수는 없는 상태를 만들지 않는다. 내보내기 대상은 정의상 쓰기 범위 안이고,
  // 화면도 "선택하지 않은 캘린더는 읽지 않고, 내보낼 캘린더가 아닌 한 쓰지도 않습니다"라고 적는다.
  const store = freshStore()
  store.tenants[TENANT]['calendar-events'] = { data: [localEvent()], updatedAt: '2026-09-01T00:00:00.000Z', updatedBy: 'seed' }
  const clock = movableClock('2026-09-10T01:00:00.000Z')
  const TEAM = 'team@example.test'
  const fake = createFakeGoogle({
    now: clock,
    events: fixtureEvents(),
    calendars: [
      { id: CAL, summary: '내 캘린더', primary: true, accessRole: 'owner' },
      { id: TEAM, summary: '팀 캘린더', primary: false, accessRole: 'owner' },
    ],
  })
  const { app } = await buildApp(store, { clock, fake })
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    // 읽는 곳은 내 캘린더 하나, 내보내는 곳은 고르지 않은 팀 캘린더.
    assert.equal((await call('PATCH', '/api/integrations/google/calendar/calendars', { selected: [CAL], writeCalendarId: TEAM })).status, 200)

    clock.advance(60_000)
    assert.equal((await call('POST', '/api/integrations/google/calendar/sync')).status, 200)
    const exported = fake.eventsOf(TEAM).find((event) => event.summary === '병원 예약')
    assert.ok(exported, '내보낼 캘린더로 고른 곳에 새 일정을 만들지 않았다')

    // 그리고 그 일정을 여기서 고치면 같은 곳으로 나간다 — 만들기만 되고 고치기는 막히면 안 된다.
    clock.advance(60_000)
    const edited = eventRows(store).map((event) => (event.id === 'EV-LOCAL' ? { ...event, title: '치과 예약' } : event))
    assert.equal((await call('PUT', '/api/workspace/calendar-events', { data: edited })).status, 200)
    clock.advance(60_000)
    const synced = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(synced.status, 200, JSON.stringify(synced.body))
    assert.equal(synced.body.result.pushed, 1, JSON.stringify(synced.body.result))
    assert.equal(fake.eventsOf(TEAM).find((event) => event.id === exported.id).summary, '치과 예약')
    assert.equal(connectionRow(store, park.account.id).lastError, '')
  })
})

test('62. 통과 도중 해제하면 회전된 토큰도 저장하지 않는다', async () => {
  // 갱신 결과는 API 호출 전에 따로 커밋한다(회전된 refresh를 잃으면 계정이 영구히 끊긴다).
  // 그 중간 저장도 통과 맨 앞의 사본을 그대로 쓰면, 사용자가 그 사이 누른 해제를 도로 덮는다 —
  // 지운 봉인이 '새 토큰'이라는 이름으로 되살아난다.
  const store = freshStore()
  const clock = movableClock('2026-09-10T01:00:00.000Z')
  const base = createFakeGoogle({ now: clock, events: fixtureEvents() })
  let reached = () => {}
  let release = () => {}
  const arrived = new Promise((resolve) => { reached = resolve })
  const held = new Promise((resolve) => { release = resolve })
  let armed = false
  const fake = {
    ...base,
    transport: {
      ...base.transport,
      async refresh(args) {
        if (armed) { armed = false; reached(); await held }
        return base.transport.refresh(args)
      },
    },
  }
  const { app } = await buildApp(store, { clock, fake })
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    base.rotateRefreshToken()

    // 액세스 토큰 수명을 넘긴다 — 이 통과는 갱신부터 한다.
    clock.advance(3 * 60 * 60 * 1_000)
    armed = true
    const syncing = call('POST', '/api/integrations/google/calendar/sync')
    await arrived

    const disconnected = await call('POST', '/api/integrations/google/calendar/disconnect')
    assert.equal(disconnected.status, 200, JSON.stringify(disconnected.body))
    release()
    const synced = await syncing
    assert.equal(synced.status, 409, JSON.stringify(synced.body))

    const row = connectionRow(store, park.account.id)
    assert.equal(row.refreshTokenEnc, null, '해제가 지운 봉인이 회전된 토큰으로 되살아났다')
    assert.equal(row.accessTokenEnc, null)
    assert.ok(row.disconnectedAt)
    assert.equal((await call('GET', '/api/integrations/google/calendar')).body.connection.status, 'revoked')
  })
})

test('63. 끝까지 성공한 통과는 "재연결 필요"를 푼다', async () => {
  // 캘린더 API의 401 한 번(시계 오차·갓 발급된 토큰·일시적 흔들림)으로 needs-reauth가 된 행이
  // **동기화가 멀쩡히 되는데도** 거기서 굳었다: runAll도 화면의 자동 동기화도 'connected'만 보므로
  // 자동 경로가 둘 다 죽고, 배너는 방금 오간 변경을 두고 '아직 오가지 않았습니다'라고 말했다.
  const store = freshStore()
  const { app, fake, clock } = await buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    clock.advance(60_000)
    assert.equal((await call('POST', '/api/integrations/google/calendar/sync')).status, 200)

    fake.failNext('events.list', { outcome: 'reauth', status: 401, reason: 'invalid credentials' })
    clock.advance(60_000)
    assert.equal((await call('POST', '/api/integrations/google/calendar/sync')).status, 409)
    assert.equal((await call('GET', '/api/integrations/google/calendar')).body.connection.status, 'needs-reauth')

    clock.advance(60_000)
    const recovered = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body))
    assert.equal(recovered.body.connection.status, 'connected', '성공한 통과가 상태를 되돌리지 않았다')
    assert.equal((await call('GET', '/api/integrations/google/calendar')).body.connection.status, 'connected')
    assert.equal(connectionRow(store, park.account.id).lastError, '')

    // 스케줄러가 이 연결을 다시 본다 — 여기가 죽으면 자동 경로가 통째로 사라진다.
    clock.advance(60_000)
    const summary = await app.locals.calendarSync.runAll({ now: clock() })
    assert.equal(summary.connections, 1, '살아 있는 연결을 스케줄러가 건너뛴다')
  })
})

test('64. 이어 읽은 전량 목록은 전량이 아니다 — 앞 페이지의 일정을 지우지 않는다', async () => {
  // 전량 목록이 페이지로 잘리고 중간에 구글이 한 번 흔들리면, 다음 통과는 남은 페이지만 읽고
  // 그것을 '전량'으로 친다. 그러면 "목록에 없으면 지워졌다" 쓸이가 앞 페이지의 멀쩡한 일정을 전부 지운다.
  const store = freshStore()
  const clock = movableClock('2026-09-10T01:00:00.000Z')
  const base = createFakeGoogle({ now: clock, events: fixtureEvents(), pageSize: 3 })
  let listCalls = 0
  const fake = {
    ...base,
    transport: {
      ...base.transport,
      async listEvents(args) {
        listCalls += 1
        // 두 번째 페이지에서 구글이 한 번 흔들린다(실제로 흔한 일이다).
        if (listCalls === 2) return { outcome: 'failed', status: 503, reason: 'backend error' }
        return base.transport.listEvents(args)
      },
    },
  }
  const { app } = await buildApp(store, { clock, fake })
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    clock.advance(60_000)
    const first = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.equal(first.body.result.pulled, 3)
    const paused = connectionRow(store, park.account.id)
    assert.ok(paused.pending?.[CAL]?.pageToken, '못 읽은 페이지를 기억하지 않았다')
    assert.match(paused.lastError, /일부 응답을 받지 못했습니다/)

    clock.advance(60_000)
    const second = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(second.status, 200, JSON.stringify(second.body))
    assert.equal(second.body.result.deletedLocal, 0, '이어 읽은 페이지에 없다는 이유로 앞 페이지를 지웠다')
    assert.equal(second.body.result.pulled, 2)
    assert.equal(eventRows(store).length, 5, '구글에 다섯 건이 살아 있는데 우리 쪽에서 사라졌다')
    // 이어 읽기가 끝났으니 다음 통과는 증분이다 — 원격 삭제는 그쪽으로 온다.
    const resumed = connectionRow(store, park.account.id)
    assert.equal(resumed.pending?.[CAL], undefined)
    assert.ok(resumed.syncTokens?.[CAL])
  })
})

test('65. 구글에서 새로 만든 캘린더는 해제하지 않고도 고를 수 있다', async () => {
  // 목록을 연결 시점에 한 번만 읽으면 그 뒤에 만든 캘린더는 영원히 화면에 없고, PATCH는
  // CALENDAR_UNKNOWN_ID로 거절한다 — 되돌리는 길이 '연결 해제 → 다시 연결'뿐이 된다.
  const store = freshStore()
  const NEW = 'site@example.test'
  const LATER = 'later@example.test'
  const { app, fake, clock } = await buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    clock.advance(60_000)
    await call('POST', '/api/integrations/google/calendar/sync')

    fake.state.calendars.push({ id: NEW, summary: '현장 캘린더', primary: false, accessRole: 'owner' })
    clock.advance(60_000)
    // 통과마다 목록을 부르지는 않는다(멱등성). 그래서 사람이 누를 손잡이가 하나 있어야 한다.
    await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal((await call('GET', '/api/integrations/google/calendar')).body.connection.calendars.some((row) => row.id === NEW), false)

    clock.advance(60_000)
    const refreshed = await call('POST', '/api/integrations/google/calendar/calendars/refresh')
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body))
    assert.ok(refreshed.body.connection.calendars.some((row) => row.id === NEW), '새로 고침이 새 캘린더를 데려오지 않았다')
    const patched = await call('PATCH', '/api/integrations/google/calendar/calendars', { selected: [CAL, NEW] })
    assert.equal(patched.status, 200, JSON.stringify(patched.body))

    // 그리고 목록이 오래되면 통과가 스스로도 갱신한다 — 사용자의 선택은 그 갱신을 지나도 남는다.
    fake.state.calendars.push({ id: LATER, summary: '나중 캘린더', primary: false, accessRole: 'owner' })
    clock.advance(7 * 60 * 60 * 1_000)
    const later = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(later.status, 200, JSON.stringify(later.body))
    const row = connectionRow(store, park.account.id)
    assert.ok(row.calendars.some((calendar) => calendar.id === LATER))
    assert.deepEqual(row.calendars.filter((calendar) => calendar.selected).map((calendar) => calendar.id).sort(), [CAL, NEW].sort())
  })
})

test('66. 살아 있는 링크는 원격 표식만으로 다른 항목에 옮겨 붙지 않는다', async () => {
  // 31번의 이웃 갈래. 거기서는 표식이 가리키는 행에 링크가 아예 없었다. 링크가 있는 갈래는
  // 테넌트도 소유자도 보지 않고 그냥 옮겨 붙였다 — 공유 캘린더에 쓸 수 있는 사람이면 누구나
  // 표식 한 줄로 남의 일정을 통째로 덮어쓸 수 있었다(이력도 남지 않는다).
  const store = freshStore()
  const mine = localEvent({ id: 'EV-LOCAL-1', title: '가족 병원 예약', location: '서울대병원', note: '보험 서류' })
  store.tenants[TENANT]['calendar-events'] = { data: [mine], updatedAt: '2026-09-01T00:00:00.000Z', updatedBy: 'seed' }
  const clock = movableClock('2026-09-10T01:00:00.000Z')
  const fake = createFakeGoogle({ now: clock, events: [] })
  const { app } = await buildApp(store, { clock, fake })
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    // 읽기 전용 공유 캘린더도 함께 본다 — 카드가 읽기 전용 칩을 그리는, 정식으로 지원하는 구성이다.
    assert.equal((await call('PATCH', '/api/integrations/google/calendar/calendars', { selected: [CAL, SHARED] })).status, 200)
    clock.advance(60_000)
    assert.equal((await call('POST', '/api/integrations/google/calendar/sync')).status, 200)
    const link = linkRows(store).find((row) => row.eventId === 'EV-LOCAL-1')
    assert.ok(link?.externalId, '내보내지 않았다')
    const before = eventRows(store).find((row) => row.id === 'EV-LOCAL-1')

    // 공유 캘린더에 쓸 수 있는 사람이 표식을 심는다. 표식은 내보낸 사본에 그대로 적혀 있어 누구나 읽는다.
    fake.setEvent(SHARED, {
      id: 'EV-EVIL', summary: '전 직원 필독', status: 'confirmed',
      start: { date: '2026-09-25' }, end: { date: '2026-09-26' },
      location: '공격자 장소', description: '공격자 본문',
      extendedProperties: { private: { inthefieldEventId: 'EV-LOCAL-1', inthefieldTenantId: TENANT, inthefieldKind: 'event' } },
    })
    clock.advance(60_000)
    const synced = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(synced.status, 200, JSON.stringify(synced.body))

    assert.deepEqual(eventRows(store).find((row) => row.id === 'EV-LOCAL-1'), before, '사용자의 행이 공격자 본문으로 덮였다')
    const after = linkRows(store).find((row) => row.id === link.id)
    assert.equal(after.externalId, link.externalId, '살아 있는 링크가 공격자의 항목으로 옮겨 갔다')
    assert.equal(after.calendarId, CAL)
    assert.equal((after.history ?? []).length, 0)
    // 공격자의 일정은 그 캘린더의 여느 일정처럼 새 행으로 들어올 뿐이다.
    const imported = linkRows(store).find((row) => row.externalId === 'EV-EVIL')
    assert.ok(imported && imported.eventId !== 'EV-LOCAL-1')
    // 진짜 원본도 그대로다.
    assert.equal(fake.eventsOf(CAL).find((event) => event.id === link.externalId).summary, '가족 병원 예약')
  })
})

test('67. 읽지 않는 캘린더의 412는 다음 통과에서 풀린다', async () => {
  // 동기화 목록 밖인데 내보내기 대상으로만 고른 캘린더는 우리가 목록을 읽지 않는다 —
  // 412를 맞아도 새 etag를 배울 자리가 어디에도 없어 같은 낡은 etag로 매 통과 412를 맞는다.
  // 사용자의 수정은 영원히 도착하지 않고 할당량만 탄다.
  const store = freshStore()
  store.tenants[TENANT]['calendar-events'] = { data: [localEvent()], updatedAt: '2026-09-01T00:00:00.000Z', updatedBy: 'seed' }
  const clock = movableClock('2026-09-10T01:00:00.000Z')
  const fake = createFakeGoogle({ now: clock, events: [] })
  const { app } = await buildApp(store, { clock, fake })
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    assert.equal((await call('PATCH', '/api/integrations/google/calendar/calendars', { selected: [], writeCalendarId: CAL })).status, 200)
    clock.advance(60_000)
    assert.equal((await call('POST', '/api/integrations/google/calendar/sync')).body.result.pushed, 1)
    const link = linkRows(store).find((row) => row.eventId === 'EV-LOCAL')
    assert.ok(link.externalEtag)

    // 저쪽에서 사람이 손댔다(etag가 올라간다). 그리고 이쪽에서도 고친다.
    fake.setEvent(CAL, { id: link.externalId, summary: '구글에서 고친 제목' })
    clock.advance(60_000)
    const edited = eventRows(store).map((event) => (event.id === 'EV-LOCAL' ? { ...event, title: '치과 예약' } : event))
    assert.equal((await call('PUT', '/api/workspace/calendar-events', { data: edited })).status, 200)

    const patches = () => fake.requests.filter((request) => request.pathname === '/events.patch').length
    clock.advance(60_000)
    const blocked = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(blocked.body.result.pushed, 0)
    assert.equal(blocked.body.result.skipped, 1)
    const afterConflict = patches()

    clock.advance(60_000)
    const settled = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(settled.body.result.pushed, 1, '412가 스스로 풀리지 않아 수정이 영영 도착하지 않는다')
    assert.equal(fake.eventsOf(CAL).find((event) => event.id === link.externalId).summary, '치과 예약')

    // 그리고 조용해진다 — 매 통과 한 건씩 태우지 않는다.
    clock.advance(60_000)
    assert.equal((await call('POST', '/api/integrations/google/calendar/sync')).body.result.pushed, 0)
    assert.equal(patches(), afterConflict + 1)
  })
})

test('68. 읽기 전용 허가는 연결이 아니고, 교환 뒤의 실패는 구글 허가를 거둔다', async () => {
  // include_granted_scopes=true라 예전에 준 읽기 전용 허가가 scope 문자열에 섞여 돌아온다.
  // substring으로 재면 'calendar.events.readonly'가 그대로 통과해서, 모든 내보내기가 구글에서
  // 403으로 조용히 사라지는 '연결됨'이 만들어진다. 그리고 prompt=consent라 실패한 시도마다
  // 새 refresh token이 발급되므로, 거두지 않으면 아무도 볼 수 없는 허가가 계정에 쌓인다.
  const store = freshStore()
  const clock = movableClock('2026-09-10T01:00:00.000Z')
  const base = createFakeGoogle({ now: clock, events: [] })
  let readonlyScope = true
  const fake = {
    ...base,
    transport: {
      ...base.transport,
      async exchangeCode(args) {
        const result = await base.transport.exchangeCode(args)
        if (!readonlyScope) return result
        return { ...result, tokens: { ...result.tokens, scope: 'https://www.googleapis.com/auth/calendar.events.readonly openid email' } }
      },
    },
  }
  const { app } = await buildApp(store, { clock, fake })
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const call = api(origin, park)
    const authorize = async () => {
      const authorized = await call('GET', '/api/integrations/google/calendar/authorize')
      assert.equal(authorized.status, 200, JSON.stringify(authorized.body))
      return new URL(authorized.body.authorizeUrl).searchParams.get('state')
    }

    const readonly = await callback(origin, park, { code: 'CODE', state: await authorize() })
    assert.equal(readonly.status, 302)
    assert.match(readonly.headers.get('location') ?? '', /calendar=error&reason=scope/)
    assert.equal(connectionRow(store, park.account.id).refreshTokenEnc, null, '읽기 전용 허가를 저장했다')
    assert.equal((await call('GET', '/api/integrations/google/calendar')).body.connection.status, 'revoked')
    assert.equal(base.state.revoked, 1, '교환한 refresh token을 거두지 않고 버렸다')

    // 목록을 못 받아 실패한 경로도 마찬가지다 — 여기서도 손에 쥔 허가를 거둔다.
    readonlyScope = false
    base.failNext('calendarList', { outcome: 'unavailable', status: 503, reason: 'down' })
    const upstream = await callback(origin, park, { code: 'CODE', state: await authorize() })
    assert.equal(upstream.status, 302)
    assert.match(upstream.headers.get('location') ?? '', /calendar=error&reason=upstream/)
    assert.equal(connectionRow(store, park.account.id).refreshTokenEnc, null)
    assert.equal(base.state.revoked, 2)

    // 제대로 된 허가는 그대로 연결된다.
    const ok = await callback(origin, park, { code: 'CODE', state: await authorize() })
    assert.match(ok.headers.get('location') ?? '', /calendar=connected/)
    assert.equal(base.state.revoked, 2, '성공한 연결에서 허가를 거뒀다')
  })
})

test('69. 구글 허가를 거두지 못한 해제는 그 사실을 숨기지 않는다', async () => {
  // 이 두 라우트는 호출 뒤 암호문을 지운다 — 두 번째 기회가 없다.
  // 아무 말도 하지 않으면 사용자는 살아 있는 캘린더 쓰기 권한을 남긴 채 '해제했습니다'만 읽는다.
  const store = freshStore()
  const { app, fake, clock } = await buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)

    // (가) 구글이 거절한다. 예외가 없었다는 것을 성공으로 읽으면 안 된다.
    fake.failNext('revoke', { outcome: 'failed', status: 500, reason: 'server error' })
    const refused = await call('POST', '/api/integrations/google/calendar/disconnect')
    assert.equal(refused.status, 200, JSON.stringify(refused.body))
    assert.equal(refused.body.hadToken, true)
    assert.equal(refused.body.revoked, false, '구글이 거절했는데 거뒀다고 말했다')

    // (나) 키가 바뀌어 봉인을 열지 못한다 — 요청 자체가 나가지 못한다.
    clock.advance(60_000)
    await connect(origin, park)
    const rows = store.tenants[TENANT]['calendar-connections'].data
    const at = rows.findIndex((row) => row.accountId === park.account.id)
    rows[at] = { ...rows[at], refreshTokenEnc: 'not-a-sealed-value' }
    const revokes = () => fake.requests.filter((request) => request.pathname === '/revoke').length
    const sealed = revokes()
    const unopened = await call('DELETE', '/api/integrations/google/calendar')
    assert.equal(unopened.status, 200, JSON.stringify(unopened.body))
    assert.equal(unopened.body.hadToken, true)
    assert.equal(unopened.body.revoked, false)
    assert.equal(revokes(), sealed, '열지도 못한 토큰으로 요청을 냈다')

    // (다) 애초에 토큰이 없던 행은 안내할 것도 없다.
    clock.advance(60_000)
    await call('GET', '/api/integrations/google/calendar/authorize')
    const never = await call('POST', '/api/integrations/google/calendar/disconnect')
    assert.equal(never.body.hadToken, false)
    assert.equal(never.body.revoked, false)
  })
})

test('70. 막힌 이유는 기억하지 않고 그때그때 계산한다', async () => {
  // 링크에 새겨 두면 그것을 지우는 자리가 '패치가 실제로 통했을 때' 하나뿐이라,
  // 캘린더를 다시 골랐는데 마침 나갈 쓰기가 없으면 이제는 잘 나가는 일정 옆에서
  // 다이얼로그가 '구글로 보내지 않습니다'라고 계속 말한다.
  const store = freshStore()
  const clock = movableClock('2026-09-10T01:00:00.000Z')
  const WORK = 'work@example.test'
  const fake = createFakeGoogle({
    now: clock,
    events: [],
    calendars: [
      { id: CAL, summary: '내 캘린더', primary: true, accessRole: 'owner' },
      { id: WORK, summary: '업무 캘린더', primary: false, accessRole: 'owner' },
    ],
  })
  fake.setEvent(WORK, {
    id: 'EV-WORK', summary: '공정 회의', status: 'confirmed',
    start: { dateTime: '2026-09-11T10:00:00+09:00' }, end: { dateTime: '2026-09-11T11:00:00+09:00' },
    location: '', description: '', updated: '2026-09-09T09:00:00.000Z',
  })
  const { app } = await buildApp(store, { clock, fake })
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    assert.equal((await call('PATCH', '/api/integrations/google/calendar/calendars', { selected: [CAL, WORK] })).status, 200)
    clock.advance(60_000)
    await call('POST', '/api/integrations/google/calendar/sync')
    const link = linkRows(store).find((row) => row.externalId === 'EV-WORK')
    assert.ok(link)

    // 업무 캘린더를 동기화에서 뺀다 — 그 뒤의 수정은 구글로 나가지 않는다(여기까지는 옳다).
    assert.equal((await call('PATCH', '/api/integrations/google/calendar/calendars', { selected: [CAL] })).status, 200)
    clock.advance(60_000)
    const edited = eventRows(store).map((event) => (event.id === link.eventId ? { ...event, title: '공정 회의(수정)' } : event))
    assert.equal((await call('PUT', '/api/workspace/calendar-events', { data: edited })).status, 200)
    clock.advance(60_000)
    const blocked = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(blocked.body.result.skipped, 1, JSON.stringify(blocked.body.result))
    assert.equal((await call('GET', `/api/calendar/events/${link.eventId}/overwrites`)).body.sourceBlocked, 'unselected')

    // 다시 고른다. 마침 나갈 쓰기가 없어도 문장은 그 자리에서 바뀌어야 한다.
    assert.equal((await call('PATCH', '/api/integrations/google/calendar/calendars', { selected: [CAL, WORK] })).status, 200)
    assert.equal(
      (await call('GET', `/api/calendar/events/${link.eventId}/overwrites`)).body.sourceBlocked, '',
      '이미 없는 제약을 다이얼로그가 계속 설명한다',
    )

    // 그리고 실제로 나간다.
    clock.advance(60_000)
    const synced = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(synced.body.result.pushed, 1, JSON.stringify(synced.body.result))
    assert.equal(fake.eventsOf(WORK).find((event) => event.id === 'EV-WORK').summary, '공정 회의(수정)')
  })
})

test('71. 다른 테넌트가 찍은 표식은 해제된 링크도 되찾지 못한다', async () => {
  // 되찾기 갈래에는 테넌트 검사가 아예 없었다. 링크가 죽어 있으면(해제·원격 삭제) 남의 테넌트 이름을
  // 적은 표식 한 줄로도 그 링크를 자기 항목에 묶고, 곧바로 사용자의 행을 자기 본문으로 덮어쓸 수 있었다.
  const store = freshStore()
  const mine = localEvent({ id: 'EV-LOCAL-1', title: '가족 병원 예약', location: '서울대병원', note: '보험 서류' })
  store.tenants[TENANT]['calendar-events'] = { data: [mine], updatedAt: '2026-09-01T00:00:00.000Z', updatedBy: 'seed' }
  const clock = movableClock('2026-09-10T01:00:00.000Z')
  const fake = createFakeGoogle({ now: clock, events: [] })
  const { app } = await buildApp(store, { clock, fake })
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const { call } = await connect(origin, park)
    assert.equal((await call('PATCH', '/api/integrations/google/calendar/calendars', { selected: [CAL, SHARED] })).status, 200)
    clock.advance(60_000)
    await call('POST', '/api/integrations/google/calendar/sync')
    const link = linkRows(store).find((row) => row.eventId === 'EV-LOCAL-1')
    assert.ok(link?.externalId)

    // 해제하면 링크는 detachedAt을 달고 살아남는다(이력 보존). 그 사이 구글 쪽 사본도 사라진다.
    assert.equal((await call('POST', '/api/integrations/google/calendar/disconnect')).status, 200)
    fake.removeEvent(CAL, link.externalId)
    clock.advance(60_000)
    await connect(origin, park)
    assert.ok(linkRows(store).find((row) => row.id === link.id).detachedAt, '해제가 링크를 떼지 않았다')

    // 공유 캘린더에 남의 테넌트 이름으로 표식을 심는다.
    fake.setEvent(SHARED, {
      id: 'EV-EVIL', summary: '전 직원 필독', status: 'confirmed',
      start: { date: '2026-09-25' }, end: { date: '2026-09-26' },
      location: '공격자 장소', description: '공격자 본문',
      extendedProperties: { private: { inthefieldEventId: 'EV-LOCAL-1', inthefieldTenantId: 'TENANT-OTHER', inthefieldKind: 'event' } },
    })
    clock.advance(60_000)
    const synced = await call('POST', '/api/integrations/google/calendar/sync')
    assert.equal(synced.status, 200, JSON.stringify(synced.body))

    assert.deepEqual(eventRows(store).find((row) => row.id === 'EV-LOCAL-1'), mine, '사용자의 행이 공격자 본문으로 덮였다')
    const after = linkRows(store).find((row) => row.id === link.id)
    assert.equal(after.externalId, link.externalId, '죽은 링크가 공격자의 항목으로 옮겨 갔다')
    assert.equal(after.calendarId, CAL)
  })
})

import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { createApp } from './app.mjs'
import { withServer } from './test-server.mjs'
import {
  BACKOFF_MS, MAX_DELIVERIES_PER_TENANT, WEBHOOK_EVENTS,
  isPrivateAddress, isPrivateIpv6, webhookUrlViolation,
} from './webhook-routes.mjs'

/**
 * 발신 웹훅 — 판정 12의 뒤쪽 절반("업무 완료 시 외부 URL에 도달한다")의 서버 쪽 증명.
 *
 * 여기서 지키는 다섯 가지:
 *  1. 사내망으로는 나가지 않는다 — 등록 시점과 발신 시점 두 번 본다.
 *  2. 서명 없이 보내지 않는다 — 봉투를 못 열면 fetch를 부르지 않는다.
 *  3. 나가는 값은 이벤트별 fields뿐이다 — 본문·설명·연락처는 실리지 않는다.
 *  4. 상태 변경과 배송 행은 한 커밋이다 — 커밋이 실패하면 '일어나지 않은 사건'도 함께 사라진다.
 *  5. 목록 응답에 해시도 봉투도 실리지 않는다.
 *
 * SECRET_BOX_KEY는 테스트 안에서 만든다. 어떤 실제 키도 픽스처로 들어오지 않는다.
 */

const TENANT = 'TENANT-SUNSEA'
const ADMIN = { id: 'USR-SUNSEA-ADMIN', name: '김서원', email: 'admin@sunsea.co.kr' }
const PARK = { id: 'USR-SUNSEA-PARK', name: '박지현', email: 'jihyun.park@sunsea.co.kr' }
const HOOK_URL = 'https://hooks.example.com/inbound'
const PUBLIC_ADDRESS = '203.0.113.10'
const LONG_DESCRIPTION = '고객 이메일 buyer@partner.example 로 회신하고 첨부한 성적서를 확인할 것'

const task = (overrides) => ({
  id: 'WK-T1', title: '3호기 점검', description: LONG_DESCRIPTION,
  owner: ADMIN.name, ownerId: ADMIN.id, requestedBy: ADMIN.name, requesterId: ADMIN.id,
  due: '2026-09-20T09:00:00.000Z', priority: '보통', status: '업무요청', category: '일반',
  createdAt: '2026-09-01T00:00:00.000Z', ...overrides,
})

function seedStore() {
  return {
    version: 2,
    tenants: {
      [TENANT]: {
        'work-items': { data: [
          task({}),
          task({ id: 'WK-T2', title: '완료 보고 대기', status: '결재대기' }),
        ], updatedAt: '2026-09-01T00:00:00.000Z' },
        'compliance-records': { data: [
          { id: 'CMP-1', name: 'HACCP 정기심사', owner: ADMIN.name, expiresAt: '2026-09-20', status: '유효' },
        ], updatedAt: '2026-09-01T00:00:00.000Z' },
        'ai-proposals': { data: [{
          id: 'PRP-1', kind: 'task-from-message', status: 'pending', confidence: 0.8,
          sourceKey: 'msg:m-1', summary: '업무 생성: 성적서 회신', evidence: '메신저 지시',
          payload: { title: '성적서 회신', description: LONG_DESCRIPTION, ownerId: PARK.id, due: '2026-09-25T09:00:00.000Z', priority: '보통', category: '일반' },
          createdAt: '2026-09-01T00:00:00.000Z', createdBy: 'ai:messenger-instruction',
        }], updatedAt: '2026-09-01T00:00:00.000Z' },
      },
    },
    platform: {},
    accountApprovals: {},
    accountCredentials: {},
    invitedAccounts: [],
    passwordResetRequests: [],
    guestGrants: [],
  }
}

/** 응답을 흉내 내는 최소 객체. status 하나만 본다(이 코드가 응답 본문을 읽지 않기 때문이다). */
function fetchStub() {
  const calls = []
  let responder = () => ({ status: 200 })
  return {
    calls,
    respond(next) { responder = typeof next === 'function' ? next : () => next },
    impl: async (url, init) => {
      calls.push({ url: String(url), init })
      // await 한 번이면 응답을 붙잡아 두는 시나리오(드레인 중 적재)도 같은 틀로 쓸 수 있다.
      const result = await responder(calls.length)
      if (result instanceof Error) throw result
      return { status: result.status ?? 200 }
    },
  }
}

async function withApp(run, { store = seedStore(), withKey = true, address = PUBLIC_ADDRESS } = {}) {
  const fetcher = fetchStub()
  // 고정 시계는 실시간보다 뒤에 둔다. 배송 행의 nextAttemptAt은 사건이 일어난 실시각으로 찍히는데,
  // 시계가 그보다 앞서 있으면 "아직 보낼 때가 아니다"가 되어 드레인이 한 건도 집지 않는다.
  // 이름 하나가 주소 여러 개를 가질 수 있다. 기본은 한 개이고, 필요한 테스트가 addresses를 갈아 끼운다.
  const state = { failNextCommit: false, now: new Date('2027-01-01T00:00:00.000Z'), addresses: [address] }
  Object.defineProperty(state, 'address', {
    get() { return state.addresses[0] ?? '' },
    set(value) { state.addresses = value === '' ? [] : [value] },
  })
  const app = createApp({
    apiKey: '',
    initialWorkspaceStore: store,
    onWorkspaceStoreChange: () => {
      if (!state.failNextCommit) return
      state.failNextCommit = false
      throw new Error('디스크가 가득 찼습니다')
    },
    env: withKey ? { SECRET_BOX_KEY: randomBytes(32).toString('base64') } : {},
    webhookFetch: fetcher.impl,
    // 실물 dns.lookup과 같은 계약이다: all이면 배열, 아니면 한 개.
    webhookLookup: async (_host, options) => (options?.all
      ? state.addresses.map((item) => ({ address: item, family: item.includes(':') ? 6 : 4 }))
      : { address: state.addresses[0] ?? '', family: 4 }),
    webhookClock: () => state.now,
  })
  await withServer(app, (origin) => run({ origin, store, app, state, fetcher }))
}

async function login(origin, email, password = 'demo1234') {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: 'tenant', email, password }),
  })
  assert.equal(response.status, 200, `${email} 로그인 실패`)
  const account = (await response.json()).account
  return { account, headers: { 'content-type': 'application/json', cookie: response.headers.get('set-cookie'), 'x-workspace-identity': `${account.tenantId}:${account.id}` } }
}

const api = (origin, session, path, method = 'POST', body) => fetch(`${origin}/api${path}`, {
  method, headers: session.headers, ...(method === 'GET' || method === 'DELETE' ? {} : { body: JSON.stringify(body ?? {}) }),
})
const readJson = async (response) => { try { return await response.json() } catch { return null } }

/** 보내는 연동 하나. 서명키는 만들 때 함께 생기고, 평문은 재발급 응답에서만 볼 수 있다. */
async function outboundEndpoint(origin, session, events = ['work.transitioned']) {
  const response = await api(origin, session, '/webhooks', 'POST', { direction: 'outbound', label: '주문 시스템', url: HOOK_URL, events })
  const body = await readJson(response)
  assert.equal(response.status, 201, JSON.stringify(body))
  return body.endpoint
}
const revealSecret = async (origin, session, id) => (await readJson(await api(origin, session, `/webhooks/${id}/secret`, 'POST'))).secret

const deliveriesOf = (store) => store.tenants[TENANT]['webhook-deliveries']?.data ?? []
const endpointRow = (store, id) => (store.tenants[TENANT]['webhook-endpoints']?.data ?? []).find((item) => item.id === id)
const settle = (app) => app.locals.webhookDispatch.settle()

test('사내망·비https·이상한 포트로는 등록조차 되지 않는다', () => {
  const table = [
    ['http://hooks.example.com/x', 'WEBHOOK_URL_NOT_HTTPS'],
    ['ftp://hooks.example.com/x', 'WEBHOOK_URL_NOT_HTTPS'],
    ['https://user:pw@hooks.example.com/x', 'WEBHOOK_URL_HAS_CREDENTIALS'],
    ['https://hooks.example.com:8443/x', 'WEBHOOK_URL_PORT_FORBIDDEN'],
    ['https://hooks.example.com:9200/x', 'WEBHOOK_URL_PORT_FORBIDDEN'],
    ['https://hooks.example.com:5432/x', 'WEBHOOK_URL_PORT_FORBIDDEN'],
    ['https://hooks.example.com:6379/x', 'WEBHOOK_URL_PORT_FORBIDDEN'],
    ['https://localhost/x', 'WEBHOOK_URL_PRIVATE'],
    ['https://app.localhost/x', 'WEBHOOK_URL_PRIVATE'],
    ['https://db.internal/x', 'WEBHOOK_URL_PRIVATE'],
    ['https://nas.local/x', 'WEBHOOK_URL_PRIVATE'],
    ['https://router.home/x', 'WEBHOOK_URL_PRIVATE'],
    ['https://printer.lan/x', 'WEBHOOK_URL_PRIVATE'],
    // 끝의 점은 루트를 명시한 같은 이름이다. 떼고 보지 않으면 이름 검사를 통째로 비켜 간다.
    ['https://localhost./x', 'WEBHOOK_URL_PRIVATE'],
    ['https://a.internal./x', 'WEBHOOK_URL_PRIVATE'],
    ['https://svc.corp.internal../hook', 'WEBHOOK_URL_PRIVATE'],
    ['https://127.0.0.1/x', 'WEBHOOK_URL_PRIVATE'],
    ['https://0.0.0.0/x', 'WEBHOOK_URL_PRIVATE'],
    ['https://10.0.0.1/x', 'WEBHOOK_URL_PRIVATE'],
    ['https://169.254.169.254/latest/meta-data', 'WEBHOOK_URL_PRIVATE'],
    ['https://172.16.0.1/x', 'WEBHOOK_URL_PRIVATE'],
    ['https://172.31.255.255/x', 'WEBHOOK_URL_PRIVATE'],
    ['https://192.168.1.1/x', 'WEBHOOK_URL_PRIVATE'],
    ['https://100.64.0.1/x', 'WEBHOOK_URL_PRIVATE'],
    ['https://198.18.0.1/x', 'WEBHOOK_URL_PRIVATE'],
    ['https://2130706433/x', 'WEBHOOK_URL_PRIVATE'],
    ['https://0x7f000001/x', 'WEBHOOK_URL_PRIVATE'],
    ['https://[::1]/x', 'WEBHOOK_URL_PRIVATE'],
    ['not a url', 'WEBHOOK_URL_INVALID'],
    ['', 'WEBHOOK_URL_INVALID'],
    [`https://hooks.example.com/${'x'.repeat(500)}`, 'WEBHOOK_URL_INVALID'],
  ]
  for (const [url, expected] of table) assert.equal(webhookUrlViolation(url), expected, url)
  // 172.15·172.32는 사설이 아니다 — 대역을 통째로 막아 정상 주소를 거절하지 않는다.
  for (const url of [HOOK_URL, 'https://hooks.example.com:443/x', 'https://203.0.113.10/x', 'https://172.15.0.1/x', 'https://172.32.0.1/x']) {
    assert.equal(webhookUrlViolation(url), null, url)
  }
})

test('보내기 직전에 이름이 사설 주소를 가리키면 fetch를 부르지 않는다', async () => {
  await withApp(async ({ origin, store, app, state, fetcher }) => {
    const admin = await login(origin, ADMIN.email)
    await outboundEndpoint(origin, admin)
    state.address = '10.1.2.3'

    await api(origin, admin, '/work-items/WK-T1/transition', 'POST', { action: 'accept' })
    await settle(app)

    assert.equal(fetcher.calls.length, 0, '사설 주소로 확인되면 요청 자체를 만들지 않는다')
    const row = deliveriesOf(store)[0]
    assert.equal(row.status, 'failed')
    assert.match(row.lastError, /사내망 주소/)
  })
})

test('3xx는 따라가지 않고 그 자리에서 포기한다', async () => {
  await withApp(async ({ origin, store, app, fetcher }) => {
    const admin = await login(origin, ADMIN.email)
    await outboundEndpoint(origin, admin)
    fetcher.respond({ status: 302 })

    await api(origin, admin, '/work-items/WK-T1/transition', 'POST', { action: 'accept' })
    await settle(app)

    assert.equal(fetcher.calls.length, 1, '리다이렉트를 따라가면 안 된다')
    assert.equal(fetcher.calls[0].init.redirect, 'manual')
    const row = deliveriesOf(store)[0]
    assert.equal(row.status, 'gave-up')
    assert.match(row.lastError, /리다이렉트/)
  })
})

test('서명 헤더는 t와 v1 두 조각이고 HMAC이 본문과 맞는다', async () => {
  await withApp(async ({ origin, app, fetcher }) => {
    const admin = await login(origin, ADMIN.email)
    const endpoint = await outboundEndpoint(origin, admin)
    const secret = await revealSecret(origin, admin, endpoint.id)
    assert.ok(secret && secret.length >= 32)

    await api(origin, admin, '/work-items/WK-T1/transition', 'POST', { action: 'accept' })
    await settle(app)

    assert.equal(fetcher.calls.length, 1)
    const { init } = fetcher.calls[0]
    assert.equal(init.headers['x-inthefield-event'], 'work.transitioned')
    assert.match(init.headers['x-inthefield-delivery'], /^WHD-/)
    assert.equal(init.headers['user-agent'], 'inthefield-webhook/1')
    const signature = init.headers['x-inthefield-signature']
    assert.match(signature, /^t=\d+,v1=[a-f0-9]{64}$/)
    const [, stamp, digest] = signature.match(/^t=(\d+),v1=([a-f0-9]{64})$/)
    assert.equal(createHmac('sha256', secret).update(`${stamp}.${init.body}`).digest('hex'), digest)
  })
})

test('나가는 값은 이벤트별 fields뿐이다 — 설명·이메일은 실리지 않는다', async () => {
  await withApp(async ({ origin, app, fetcher }) => {
    const admin = await login(origin, ADMIN.email)
    await outboundEndpoint(origin, admin)

    await api(origin, admin, '/work-items/WK-T1/transition', 'POST', { action: 'accept' })
    await settle(app)

    const body = JSON.parse(fetcher.calls[0].init.body)
    assert.deepEqual(Object.keys(body).sort(), ['actor', 'aggregateId', 'data', 'id', 'occurredAt', 'tenantId', 'type'].sort())
    assert.equal(body.type, 'work.transitioned')
    assert.deepEqual(Object.keys(body.data).sort(), [...WEBHOOK_EVENTS['work.transitioned'].fields].sort())
    assert.equal(body.data.beforeState, '업무요청')
    assert.equal(body.data.afterState, '수행중')
    const text = fetcher.calls[0].init.body
    assert.ok(!text.includes(LONG_DESCRIPTION), '업무 설명이 바깥으로 나가면 안 된다')
    assert.ok(!text.includes('buyer@partner.example'), '이메일이 바깥으로 나가면 안 된다')
    assert.ok(!text.includes('description'))
  })
})

test('구독하지 않은 사건에서는 아무것도 나가지 않는다', async () => {
  await withApp(async ({ origin, store, app, fetcher }) => {
    const admin = await login(origin, ADMIN.email)
    await outboundEndpoint(origin, admin, ['notice.posted'])
    await api(origin, admin, '/work-items/WK-T1/transition', 'POST', { action: 'accept' })
    await settle(app)
    assert.equal(fetcher.calls.length, 0)
    assert.deepEqual(deliveriesOf(store), [])
  })
})

test('백오프는 1분·5분·30분·2시간·6시간이고 여섯 번째에 포기한다', async () => {
  await withApp(async ({ origin, store, app, state, fetcher }) => {
    const admin = await login(origin, ADMIN.email)
    await outboundEndpoint(origin, admin)
    fetcher.respond({ status: 503 })

    await api(origin, admin, '/work-items/WK-T1/transition', 'POST', { action: 'accept' })
    await settle(app)

    const id = deliveriesOf(store)[0].id
    const rowNow = () => deliveriesOf(store).find((item) => item.id === id)
    for (let attempt = 1; attempt <= BACKOFF_MS.length; attempt += 1) {
      const row = rowNow()
      assert.equal(row.status, 'failed', `${attempt}회차`)
      assert.equal(row.attempts, attempt)
      assert.equal(
        Date.parse(row.nextAttemptAt) - state.now.getTime(),
        BACKOFF_MS[attempt - 1],
        `${attempt}회차 대기 간격`,
      )
      state.now = new Date(Date.parse(row.nextAttemptAt))
      await app.locals.webhookDispatch.drainWebhookDeliveries(TENANT, { now: state.now })
    }
    assert.equal(rowNow().status, 'gave-up')
    assert.equal(rowNow().nextAttemptAt, null)
    assert.equal(fetcher.calls.length, BACKOFF_MS.length + 1)
  })
})

test('고칠 수 없는 응답은 즉시 포기하고, 다시 해 볼 만한 응답만 재시도로 남는다', async () => {
  for (const [status, expected] of [[400, 'gave-up'], [403, 'gave-up'], [404, 'gave-up'], [410, 'gave-up'], [408, 'failed'], [429, 'failed'], [503, 'failed']]) {
    await withApp(async ({ origin, store, app, fetcher }) => {
      const admin = await login(origin, ADMIN.email)
      await outboundEndpoint(origin, admin)
      fetcher.respond({ status })
      await api(origin, admin, '/work-items/WK-T1/transition', 'POST', { action: 'accept' })
      await settle(app)
      const row = deliveriesOf(store)[0]
      assert.equal(row.status, expected, `HTTP ${status}`)
      assert.equal(row.lastStatusCode, status)
    })
  }
  // 네트워크 오류(응답 자체가 없는 경우)는 재시도한다.
  await withApp(async ({ origin, store, app, fetcher }) => {
    const admin = await login(origin, ADMIN.email)
    await outboundEndpoint(origin, admin)
    fetcher.respond(new Error('ECONNRESET'))
    await api(origin, admin, '/work-items/WK-T1/transition', 'POST', { action: 'accept' })
    await settle(app)
    const row = deliveriesOf(store)[0]
    assert.equal(row.status, 'failed')
    assert.equal(row.lastStatusCode, null)
    assert.match(row.lastError, /ECONNRESET/)
  })
})

test('연속 20회 실패하면 스스로 멈추고 관리자에게 알린다 — 다시 켜면 이력이 지워진다', async () => {
  await withApp(async ({ origin, store, app, state, fetcher }) => {
    const admin = await login(origin, ADMIN.email)
    const endpoint = await outboundEndpoint(origin, admin)
    fetcher.respond({ status: 500 })

    // 사건 스무 개를 한 번에 적재하고 한 번에 보낸다(사건마다 라우트를 두드리지 않는다).
    for (let index = 0; index < 20; index += 1) {
      app.locals.webhookDispatch.queueWebhookDeliveries(TENANT, 'work.transitioned', {
        aggregateId: `WK-${index}`, actor: ADMIN.id, occurredAt: new Date(state.now.getTime() - 60_000 + index).toISOString(),
        data: { id: `WK-${index}`, title: '반복', beforeState: '업무요청', afterState: '수행중', ownerId: ADMIN.id },
      })
    }
    await app.locals.webhookDispatch.drainWebhookDeliveries(TENANT, { now: state.now })

    const row = endpointRow(store, endpoint.id)
    assert.equal(row.consecutiveFailures, 20)
    assert.equal(row.enabled, false)
    assert.ok(row.disabledAt)
    const alerts = (store.tenants[TENANT].notifications?.data ?? []).filter((item) => item.type === 'webhook-disabled')
    assert.equal(alerts.length, 1)
    assert.equal(alerts[0].recipientId, ADMIN.id)
    assert.equal(alerts[0].page, 'people')
    assert.equal(alerts[0].focusId, endpoint.id)

    // 멈춘 뒤에는 새 사건이 큐에 들어가지도 않는다.
    const before = fetcher.calls.length
    await api(origin, admin, '/work-items/WK-T1/transition', 'POST', { action: 'accept' })
    await settle(app)
    assert.equal(fetcher.calls.length, before, '멈춘 연동으로는 아무것도 나가지 않는다')

    const patched = await readJson(await api(origin, admin, `/webhooks/${endpoint.id}`, 'PATCH', { enabled: true }))
    assert.equal(patched.endpoint.enabled, true)
    assert.equal(patched.endpoint.consecutiveFailures, 0)
    assert.equal(patched.endpoint.disabledAt, null)
  })
})

test('같은 사건을 두 번 발행해도 전달 행은 하나다', async () => {
  await withApp(async ({ origin, store, app, state }) => {
    const admin = await login(origin, ADMIN.email)
    await outboundEndpoint(origin, admin)
    const payload = {
      aggregateId: 'WK-T1', actor: ADMIN.id, occurredAt: state.now.toISOString(),
      data: { id: 'WK-T1', title: '점검', beforeState: '업무요청', afterState: '수행중', ownerId: ADMIN.id },
    }
    app.locals.webhookDispatch.queueWebhookDeliveries(TENANT, 'work.transitioned', payload)
    app.locals.webhookDispatch.queueWebhookDeliveries(TENANT, 'work.transitioned', payload)
    assert.equal(deliveriesOf(store).length, 1)
  })
})

test('봉투를 열 수 없으면 서명 없이 보내는 대신 포기한다', async () => {
  await withApp(async ({ origin, store, app, fetcher }) => {
    const admin = await login(origin, ADMIN.email)
    const endpoint = await outboundEndpoint(origin, admin)
    // 키가 바뀐 상황을 흉내 낸다 — 형식은 맞지만 열리지 않는 봉투.
    store.tenants[TENANT]['webhook-endpoints'].data = store.tenants[TENANT]['webhook-endpoints'].data.map((item) => (
      item.id === endpoint.id ? { ...item, signingSecretEnc: 'v1:AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBB:CCCCCCCC' } : item
    ))

    await api(origin, admin, '/work-items/WK-T1/transition', 'POST', { action: 'accept' })
    await settle(app)

    assert.equal(fetcher.calls.length, 0, '서명 없이 보내지 않는다')
    const row = deliveriesOf(store)[0]
    assert.equal(row.status, 'gave-up')
    assert.match(row.lastError, /SECRET_BOX_KEY/)
  })
})

test('커밋이 실패하면 배송 행도 함께 사라진다 — 일어나지 않은 사건은 나가지 않는다', async () => {
  await withApp(async ({ origin, store, app, state, fetcher }) => {
    const admin = await login(origin, ADMIN.email)
    await outboundEndpoint(origin, admin)
    const before = JSON.parse(JSON.stringify(store.tenants[TENANT]['webhook-deliveries'] ?? null))

    state.failNextCommit = true
    const response = await api(origin, admin, '/work-items/WK-T1/transition', 'POST', { action: 'accept' })
    assert.equal(response.status, 500)
    assert.equal((await readJson(response)).error.code, 'WORK_TRANSITION_WRITE_FAILED')
    await settle(app)

    assert.deepEqual(store.tenants[TENANT]['webhook-deliveries'] ?? null, before)
    assert.equal(fetcher.calls.length, 0)
  })
})

test('목록 응답에는 토큰 해시도 봉투도 실리지 않는다', async () => {
  await withApp(async ({ origin }) => {
    const admin = await login(origin, ADMIN.email)
    const endpoint = await outboundEndpoint(origin, admin)
    const inbound = await readJson(await api(origin, admin, '/webhooks', 'POST', { direction: 'inbound', label: '받기', conversationId: '' }))
    await api(origin, admin, `/webhooks/${inbound.endpoint.id}/token`, 'POST')

    const listed = await readJson(await api(origin, admin, '/webhooks', 'GET'))
    const text = JSON.stringify(listed)
    assert.doesNotMatch(text, /v1:[A-Za-z0-9_-]+:/, '봉투가 목록에 실리면 안 된다')
    assert.doesNotMatch(text, /[a-f0-9]{64}/, '토큰 해시가 목록에 실리면 안 된다')
    assert.equal(listed.endpoints.find((item) => item.id === endpoint.id).hasSecret, true)
    assert.equal(listed.endpoints.find((item) => item.id === inbound.endpoint.id).hasToken, true)
    assert.equal(listed.secretBoxAvailable, true)
    // 어댑터가 하나도 없으면 화면이 그릴 채널도 없다 — 켤 수 없는 체크박스를 만들지 않는다.
    assert.deepEqual(listed.channels, [])
  })
})

test('구성원은 외부 연동 화면을 열 수 없고, 봉인 키가 없으면 보내는 연동을 만들 수 없다', async () => {
  await withApp(async ({ origin }) => {
    const member = await login(origin, PARK.email)
    for (const [method, path] of [['GET', '/webhooks'], ['POST', '/webhooks'], ['GET', '/webhooks/deliveries']]) {
      const response = await api(origin, member, path, method, { direction: 'inbound', label: 'x' })
      assert.equal(response.status, 403, `${method} ${path}`)
    }
  })

  await withApp(async ({ origin }) => {
    const admin = await login(origin, ADMIN.email)
    const response = await api(origin, admin, '/webhooks', 'POST', { direction: 'outbound', label: '주문', url: HOOK_URL, events: [] })
    assert.equal(response.status, 503)
    assert.equal((await readJson(response)).error.code, 'SECRET_BOX_UNAVAILABLE')
    const listed = await readJson(await api(origin, admin, '/webhooks', 'GET'))
    assert.equal(listed.secretBoxAvailable, false, '화면이 왜 막혔는지 미리 말할 수 있어야 한다')
    // 받는 연동은 서명키가 필요 없으므로 그대로 만들어진다.
    const inbound = await api(origin, admin, '/webhooks', 'POST', { direction: 'inbound', label: '받기' })
    assert.equal(inbound.status, 201)
  }, { withKey: false })
})

test('여섯 가지 사건이 각각 배송 행 하나를 만든다', async () => {
  await withApp(async ({ origin, store, app, state, fetcher }) => {
    const admin = await login(origin, ADMIN.email)
    await outboundEndpoint(origin, admin, [...Object.keys(WEBHOOK_EVENTS)])

    // 1) 업무 상태 변경
    assert.equal((await api(origin, admin, '/work-items/WK-T1/transition', 'POST', { action: 'accept' })).status, 200)
    // 2) 업무 결재 완료(= 상태 변경 + 결재 완료 두 건)
    assert.equal((await api(origin, admin, '/work-items/WK-T2/transition', 'POST', { action: 'approve', review: { comment: '확인' } })).status, 200)
    // 3) 결재 완료 + 업무 생성 (승인 큐 결재 한 번이 둘을 만든다)
    assert.equal((await api(origin, admin, '/proposals/PRP-1/decide', 'POST', { decision: 'approve' })).status, 200)
    // 4) 공지 게시
    assert.equal((await api(origin, admin, '/notices', 'POST', { scope: 'company', title: '9월 안전교육', body: '전원 참석', mustRead: true })).status, 201)
    // 5) 센티널 경고
    app.locals.runSentinelForTenant(TENANT, state.now)
    await settle(app)

    const byType = new Map()
    for (const row of deliveriesOf(store)) byType.set(row.eventType, (byType.get(row.eventType) ?? 0) + 1)
    // 여섯 가지가 모두 실제로 발생한다.
    for (const eventType of Object.keys(WEBHOOK_EVENTS)) {
      assert.ok((byType.get(eventType) ?? 0) >= 1, `${eventType} 배송 행이 하나도 없다`)
    }
    // 상태 변경은 두 번 일어났다 — 시작(WK-T1)과 승인(WK-T2). 승인 한 번이 상태 변경과 결재 완료를 함께 낸다.
    assert.equal(byType.get('work.transitioned'), 2)
    assert.equal(byType.get('work.approved'), 1)
    assert.equal(byType.get('approval.completed'), 1)
    assert.equal(byType.get('work.created'), 1)
    assert.equal(byType.get('notice.posted'), 1)
    // fields allowlist는 '무엇이 바깥으로 나가는가'를 말하는 목록이다. 발행하는 쪽이 채우지 않은 칸은
    // null로 나가므로, 키만 맞는지 보면 그 목록이 두 칸을 과장해도 통과한다. 값까지 본다.
    for (const row of deliveriesOf(store)) {
      const fields = WEBHOOK_EVENTS[row.eventType]?.fields ?? []
      assert.deepEqual(Object.keys(row.payload).sort(), [...fields].sort(), row.eventType)
      for (const field of fields) {
        assert.notEqual(row.payload[field], null, `${row.eventType}.${field}가 늘 null로 나간다`)
      }
    }
    const notice = deliveriesOf(store).find((row) => row.eventType === 'notice.posted')
    assert.equal(notice.payload.title, '9월 안전교육')
    assert.equal(notice.payload.mustRead, true)
    assert.ok(Number.isInteger(notice.payload.targetCount) && notice.payload.targetCount > 0)
    assert.equal(notice.payload.authorId, ADMIN.id)
    assert.equal(notice.actor, ADMIN.id, '다른 사건은 전부 행위자를 싣는데 공지만 비어 있으면 안 된다')
    // 센티널은 규칙팩이 그 순간 감지한 만큼 낸다(마감이 지난 업무 둘 + 만료가 다가온 인증 하나).
    // 건수를 못박으면 규칙 하나만 늘어도 이 테스트가 먼저 깨진다 — 여기서 재는 것은 '경로가 이어졌는가'다.
    assert.equal(deliveriesOf(store).every((row) => row.status === 'delivered'), true)
    assert.equal(fetcher.calls.length, deliveriesOf(store).length)
  })
})

test('테스트 보내기는 그 엔드포인트에만 가고, 다시 보내기가 실패한 행을 되살린다', async () => {
  await withApp(async ({ origin, app, fetcher }) => {
    const admin = await login(origin, ADMIN.email)
    const endpoint = await outboundEndpoint(origin, admin, [])
    const sent = await readJson(await api(origin, admin, `/webhooks/${endpoint.id}/test`, 'POST'))
    assert.equal(sent.delivery.eventType, 'webhook.test')
    assert.equal(sent.delivery.status, 'delivered')
    assert.equal(fetcher.calls.length, 1)
    assert.equal(JSON.parse(fetcher.calls[0].init.body).data.endpointId, endpoint.id)

    fetcher.respond({ status: 500 })
    const failed = await readJson(await api(origin, admin, `/webhooks/${endpoint.id}/test`, 'POST'))
    assert.equal(failed.delivery.status, 'failed')

    fetcher.respond({ status: 200 })
    const retried = await readJson(await api(origin, admin, `/webhooks/deliveries/${failed.delivery.id}/retry`, 'POST'))
    assert.equal(retried.delivery.status, 'delivered')
    await settle(app)
  })
})

test('보내는 연동을 만들면 서명 비밀키 평문이 그 응답에 딱 한 번 실린다', async () => {
  await withApp(async ({ origin, app, fetcher }) => {
    const admin = await login(origin, ADMIN.email)
    const created = await readJson(await api(origin, admin, '/webhooks', 'POST', { direction: 'outbound', label: '주문 시스템', url: HOOK_URL, events: ['work.transitioned'] }))
    assert.ok(created.secret, '만들어진 순간 받는 쪽이 검증할 열쇠를 손에 쥐어야 한다')
    assert.equal(created.endpoint.hasSecret, true)

    // 첫 배달부터 그 열쇠로 검증된다 — 재발급 없이도.
    await api(origin, admin, '/work-items/WK-T1/transition', 'POST', { action: 'accept' })
    await settle(app)
    const { init } = fetcher.calls[0]
    const [, stamp, digest] = init.headers['x-inthefield-signature'].match(/^t=(\d+),v1=([a-f0-9]{64})$/)
    assert.equal(createHmac('sha256', created.secret).update(`${stamp}.${init.body}`).digest('hex'), digest)

    // 목록에는 있다/없다만 남는다.
    const listed = await readJson(await api(origin, admin, '/webhooks', 'GET'))
    assert.doesNotMatch(JSON.stringify(listed), new RegExp(created.secret.slice(0, 16)))
    // 받는 연동에는 서명키가 없으므로 평문도 없다.
    const inbound = await readJson(await api(origin, admin, '/webhooks', 'POST', { direction: 'inbound', label: '받기' }))
    assert.equal(inbound.secret, undefined)
  })
})

test('커밋이 실패하면 운영 감사 기록도 함께 되돌아간다', async () => {
  await withApp(async ({ origin, store, state }) => {
    const admin = await login(origin, ADMIN.email)
    const before = JSON.parse(JSON.stringify(store.platform.auditEvents ?? []))

    state.failNextCommit = true
    const response = await api(origin, admin, '/webhooks', 'POST', { direction: 'outbound', label: '실패할 연동', url: HOOK_URL, events: [] })
    assert.equal(response.status, 500)
    assert.equal((await readJson(response)).error.code, 'WEBHOOK_WRITE_FAILED')

    assert.equal(store.tenants[TENANT]['webhook-endpoints'] ?? null, null, '없던 연동이 남으면 안 된다')
    // 존재한 적 없는 연동의 '외부 연동 추가'가 감사 이력에 남으면, 운영자가 읽는 기록이 거짓이 된다.
    assert.deepEqual(store.platform.auditEvents ?? [], before)
  })
})

test('드레인 도중에 적재된 사건도 같은 kick에서 나간다', async () => {
  await withApp(async ({ origin, store, app, fetcher }) => {
    const admin = await login(origin, ADMIN.email)
    await outboundEndpoint(origin, admin, ['work.transitioned'])

    let release = () => {}
    const gate = new Promise((resolve) => { release = resolve })
    fetcher.respond(async (index) => { if (index === 1) await gate; return { status: 200 } })

    // 첫 번째 전달이 받는 쪽에서 붙잡혀 있는 동안 두 번째 사건이 일어난다.
    await api(origin, admin, '/work-items/WK-T1/transition', 'POST', { action: 'accept' })
    await api(origin, admin, '/work-items/WK-T2/transition', 'POST', { action: 'approve', review: { comment: '확인' } })
    release()
    await settle(app)

    // 두 건 모두 나갔다. 그러지 않으면 두 번째는 매시 쓸기(최대 한 시간)까지, Sites에서는 영영 기다린다.
    assert.equal(fetcher.calls.length, 2)
    assert.deepEqual(deliveriesOf(store).map((row) => row.status).sort(), ['delivered', 'delivered'])
  })
})

test('지운 연동의 실패 행은 닫히고, 다시 보내기는 사유를 말한다', async () => {
  await withApp(async ({ origin, store, app, fetcher }) => {
    const admin = await login(origin, ADMIN.email)
    const endpoint = await outboundEndpoint(origin, admin, ['work.transitioned'])
    fetcher.respond({ status: 503 })

    await api(origin, admin, '/work-items/WK-T1/transition', 'POST', { action: 'accept' })
    await settle(app)
    const row = deliveriesOf(store)[0]
    assert.equal(row.status, 'failed', '관리자가 연동을 지우는 시점의 행은 대개 pending이 아니라 failed다')

    assert.equal((await api(origin, admin, `/webhooks/${endpoint.id}`, 'DELETE')).status, 204)
    const closed = deliveriesOf(store).find((item) => item.id === row.id)
    assert.equal(closed.status, 'gave-up')
    assert.equal(closed.nextAttemptAt, null)
    assert.match(closed.lastError, /연동이 삭제되어/)

    const before = fetcher.calls.length
    const retried = await api(origin, admin, `/webhooks/deliveries/${row.id}/retry`, 'POST')
    assert.equal(retried.status, 409)
    assert.equal((await readJson(retried)).error.code, 'WEBHOOK_ENDPOINT_DISABLED')
    assert.equal(fetcher.calls.length, before)
    // 사유를 지우고 '대기'로 되돌리지 않는다 — 아무도 집지 않을 행이 영원히 남는다.
    assert.equal(deliveriesOf(store).find((item) => item.id === row.id).status, 'gave-up')
  })
})

test('꺼진 연동에는 테스트를 보내지 않고, 이미 전달된 행은 다시 보내지 않는다', async () => {
  await withApp(async ({ origin, app, fetcher }) => {
    const admin = await login(origin, ADMIN.email)
    const endpoint = await outboundEndpoint(origin, admin, [])

    const sent = await readJson(await api(origin, admin, `/webhooks/${endpoint.id}/test`, 'POST'))
    assert.equal(sent.delivery.status, 'delivered')

    const again = await api(origin, admin, `/webhooks/deliveries/${sent.delivery.id}/retry`, 'POST')
    assert.equal(again.status, 409)
    assert.equal((await readJson(again)).error.code, 'WEBHOOK_DELIVERY_ALREADY_SENT')

    await api(origin, admin, `/webhooks/${endpoint.id}`, 'PATCH', { enabled: false })
    const before = fetcher.calls.length
    const blocked = await api(origin, admin, `/webhooks/${endpoint.id}/test`, 'POST')
    assert.equal(blocked.status, 409, '대기 · 사유 없음 이라는 가짜 상태를 만들지 않는다')
    assert.equal((await readJson(blocked)).error.code, 'WEBHOOK_ENDPOINT_DISABLED')
    assert.equal(fetcher.calls.length, before)
    await settle(app)
  })
})

test('다시 보내기는 새 시도다 — 백오프 횟수를 물려받아 저장 상한을 넘기지 않는다', async () => {
  await withApp(async ({ origin, store, app, fetcher }) => {
    const admin = await login(origin, ADMIN.email)
    const endpoint = await outboundEndpoint(origin, admin, [])
    fetcher.respond({ status: 500 })
    const failed = await readJson(await api(origin, admin, `/webhooks/${endpoint.id}/test`, 'POST'))
    assert.equal(failed.delivery.attempts, 1)

    const retried = await readJson(await api(origin, admin, `/webhooks/deliveries/${failed.delivery.id}/retry`, 'POST'))
    // 사람이 누른 한 번은 사다리의 다음 칸이 아니라 첫 칸이다.
    assert.equal(retried.delivery.attempts, 1)
    assert.equal(deliveriesOf(store).find((item) => item.id === failed.delivery.id).attempts, 1)
    await settle(app)
  })
})

test('node:dns는 보낼 때 부른다 — 없는 런타임에서 API가 통째로 죽지 않는다', async () => {
  // app.mjs가 모듈 스코프에서 이 파일을 읽고, Sites 워커도 같은 app.mjs를 읽는다. 정적 import로 두면
  // 그 런타임에 node:dns/promises가 없을 때 웹훅이 아니라 워커 전체가 부팅에 실패한다.
  const source = await readFile(new URL('./webhook-dispatch.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /^import .*'node:dns/m, 'node:dns를 모듈 스코프에서 정적으로 읽지 않는다')
  assert.match(source, /await import\('node:dns\/promises'\)/)
  assert.match(source, /이 실행 환경에서는 주소를 확인할 수 없어 보내지 않았습니다\./, '실패해도 그 배달만 사유를 남긴다')
})

test('테스트 보내기가 저장에 실패하면 그 행도 남지 않는다 — 나중에 몰래 나가지 않는다', async () => {
  await withApp(async ({ origin, store, app, state, fetcher }) => {
    const admin = await login(origin, ADMIN.email)
    const endpoint = await outboundEndpoint(origin, admin, [])
    const before = JSON.parse(JSON.stringify(store.tenants[TENANT]['webhook-deliveries'] ?? null))

    state.failNextCommit = true
    const response = await api(origin, admin, `/webhooks/${endpoint.id}/test`, 'POST')
    assert.equal(response.status, 500)
    assert.equal((await readJson(response)).error.code, 'WEBHOOK_WRITE_FAILED')
    assert.deepEqual(store.tenants[TENANT]['webhook-deliveries'] ?? null, before, '실패했다고 답한 요청의 행이 남으면 안 된다')

    // 남았다면 다음 커밋에 실려 저장되고, 매시 쓸기가 몇 분 뒤 실제로 그 요청을 바깥으로 보낸다.
    const calls = fetcher.calls.length
    await app.locals.webhookDispatch.sweepDeliveries(state.now)
    assert.equal(fetcher.calls.length, calls)
  })
})

test('드레인이 도는 중의 테스트 보내기는 가짜 사유를 만들지 않는다', async () => {
  await withApp(async ({ origin, app, fetcher }) => {
    const admin = await login(origin, ADMIN.email)
    const endpoint = await outboundEndpoint(origin, admin, ['work.transitioned'])
    let release = () => {}
    const gate = new Promise((resolve) => { release = resolve })
    fetcher.respond(async (index) => { if (index === 1) await gate; return { status: 200 } })

    // 첫 전달이 받는 쪽에 붙잡혀 있는 동안 [테스트 보내기]를 누른다.
    await api(origin, admin, '/work-items/WK-T1/transition', 'POST', { action: 'accept' })
    const sent = await readJson(await api(origin, admin, `/webhooks/${endpoint.id}/test`, 'POST'))
    assert.equal(sent.delivery.status, 'pending')
    assert.equal(sent.delivery.lastError, null)
    // 이 한 칸이 없으면 화면은 '대기 · 사유 없음'을 그린다 — 사유가 없는 것이 아니라 아직 결과가 없다.
    assert.equal(sent.queued, true)

    release()
    await settle(app)
    assert.equal(fetcher.calls.length, 2, '코얼레스된 판에서 결국 나간다')
  })
})

test('대기 행만으로 상한을 넘어도 저장은 상한을 지킨다', async () => {
  await withApp(async ({ origin, store, app, state }) => {
    const admin = await login(origin, ADMIN.email)
    const endpoint = await outboundEndpoint(origin, admin, ['work.transitioned'])
    const at = new Date(state.now.getTime() - 3_600_000).toISOString()
    const rows = []
    for (let index = 0; index < MAX_DELIVERIES_PER_TENANT; index += 1) {
      rows.push({
        id: `WHD-wait-${String(index).padStart(5, '0')}`,
        endpointId: endpoint.id, channel: 'webhook', eventType: 'work.transitioned',
        eventId: `work.transitioned:WK-W${index}:${at}`, aggregateId: `WK-W${index}`, target: 'hooks.example.com',
        status: 'failed', attempts: 1, nextAttemptAt: new Date(state.now.getTime() + 21_600_000).toISOString(),
        lastStatusCode: 503, lastError: '받는 쪽 응답 503', requestedAt: at, deliveredAt: null,
        payload: { id: `WK-W${index}`, title: '대기', beforeState: '업무요청', afterState: '수행중', ownerId: ADMIN.id },
        actor: ADMIN.id,
      })
    }
    store.tenants[TENANT]['webhook-deliveries'] = { data: rows, updatedAt: at, updatedBy: 'test' }

    app.locals.webhookDispatch.queueWebhookDeliveries(TENANT, 'work.transitioned', {
      aggregateId: 'WK-NEW', actor: ADMIN.id, occurredAt: state.now.toISOString(),
      data: { id: 'WK-NEW', title: '새 사건', beforeState: '업무요청', afterState: '수행중', ownerId: ADMIN.id },
    })

    // '고객사당 2,000건'이 상한이라고 말했으면 어떤 갈래에서도 상한이어야 한다.
    assert.equal(deliveriesOf(store).length, MAX_DELIVERIES_PER_TENANT)
    assert.ok(deliveriesOf(store).some((row) => row.aggregateId === 'WK-NEW'))
    assert.equal(deliveriesOf(store).every((row) => row.status !== 'gave-up'), true, '상한 위에 얹으려고 행을 닫지 않는다')
  })
})

test('보관 한도를 넘겨도 아직 못 보낸 행은 버리지 않는다', async () => {
  await withApp(async ({ origin, store, app, state }) => {
    const admin = await login(origin, ADMIN.email)
    const endpoint = await outboundEndpoint(origin, admin, ['work.transitioned'])
    const at = new Date(state.now.getTime() - 3_600_000).toISOString()
    const bulk = (index, status) => ({
      id: `WHD-bulk-${String(index).padStart(5, '0')}`,
      endpointId: endpoint.id, channel: 'webhook', eventType: 'work.transitioned',
      eventId: `work.transitioned:WK-B${index}:${at}`, aggregateId: `WK-B${index}`, target: 'hooks.example.com',
      status, attempts: 1,
      nextAttemptAt: status === 'failed' ? new Date(state.now.getTime() + 21_600_000).toISOString() : null,
      lastStatusCode: status === 'failed' ? 503 : 200, lastError: status === 'failed' ? '받는 쪽 응답 503' : null,
      requestedAt: at, deliveredAt: status === 'delivered' ? at : null,
      payload: { id: `WK-B${index}`, title: '보관', beforeState: '업무요청', afterState: '수행중', ownerId: ADMIN.id },
      actor: ADMIN.id,
    })
    // 새것이 앞. 가장 오래된 한 건만 6시간 사다리 위에서 기다리는 중이다.
    const rows = []
    for (let index = 0; index < MAX_DELIVERIES_PER_TENANT - 1; index += 1) rows.push(bulk(index, 'delivered'))
    rows.push(bulk(MAX_DELIVERIES_PER_TENANT - 1, 'failed'))
    store.tenants[TENANT]['webhook-deliveries'] = { data: rows, updatedAt: at, updatedBy: 'test' }

    app.locals.webhookDispatch.queueWebhookDeliveries(TENANT, 'work.transitioned', {
      aggregateId: 'WK-NEW', actor: ADMIN.id, occurredAt: state.now.toISOString(),
      data: { id: 'WK-NEW', title: '새 사건', beforeState: '업무요청', afterState: '수행중', ownerId: ADMIN.id },
    })

    const stored = deliveriesOf(store)
    assert.equal(stored.length, MAX_DELIVERIES_PER_TENANT)
    const waiting = stored.find((row) => row.id === `WHD-bulk-${String(MAX_DELIVERIES_PER_TENANT - 1).padStart(5, '0')}`)
    assert.ok(waiting, '사다리 위에서 기다리던 행이 통째로 사라지면 그 사건은 아무 데도 남지 않는다')
    assert.equal(waiting.status, 'failed')
    assert.ok(stored.some((row) => row.aggregateId === 'WK-NEW'))
    // 대신 밀려난 것은 이미 끝난 행이다.
    assert.equal(stored.filter((row) => row.status === 'delivered').length, MAX_DELIVERIES_PER_TENANT - 2)
  })
})

test('사설 v6는 막고 공인 v6는 내보낸다 — 콜론이 있다고 사내망이 아니다', async () => {
  // 순수 함수 표. IPv6가 열린 배포에서는 getaddrinfo가 AAAA를 먼저 돌려주므로,
  // '콜론이 있으면 거절'은 듀얼스택 수신처로 가는 모든 배달을 거짓 사유와 함께 죽인다.
  // 마지막 다섯은 같은 주소를 펼쳐 적은 표기다. '::'로 시작하는 갈래만으로는 잡히지 않아
  // 공인으로 판정되던 자리다 — 표기 하나에 SSRF의 마지막 문이 열리게 두지 않는다.
  for (const address of ['::1', '::', 'fe80::1', 'fd00::abcd', 'fc00::1', 'fec0::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:10.1.2.3', '2002:7f00:0001::', '64:ff9b::7f00:1', 'zz::1',
    '0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:0000:0000:0001', '0::1',
    '0:0:0:0:0:ffff:169.254.169.254', '0:0:0:0:0:ffff:10.0.0.1']) {
    assert.equal(isPrivateIpv6(address), true, address)
    assert.equal(isPrivateAddress(address), true, address)
  }
  // 읽을 수 없는 값은 '공인'이 아니다 — 모르는 것을 통과시키는 쪽이 더 나쁘다.
  assert.equal(isPrivateAddress('nonsense'), true)
  assert.equal(isPrivateAddress('999.1.1.1'), true)
  // 공인 v6, 공인 v4를 품은 매핑, 공인 v4의 6to4 — 셋 다 나갈 수 있어야 한다.
  for (const address of ['2606:4700:4700::1111', '2400:cb00::1', '::ffff:203.0.113.10', '2002:cb00:7101::']) {
    assert.equal(isPrivateIpv6(address), false, address)
  }
  assert.equal(isPrivateAddress('2606:4700:4700::1111'), false)
  assert.equal(isPrivateAddress('203.0.113.10'), false)
  assert.equal(isPrivateAddress('10.1.2.3'), true)
  assert.equal(isPrivateAddress(''), true, '주소가 없으면 보내지 않는다')

  await withApp(async ({ origin, store, app, state, fetcher }) => {
    const admin = await login(origin, ADMIN.email)
    await outboundEndpoint(origin, admin)
    state.addresses = ['2606:4700:4700::1111']

    await api(origin, admin, '/work-items/WK-T1/transition', 'POST', { action: 'accept' })
    await settle(app)

    assert.equal(fetcher.calls.length, 1, '공인 IPv6 수신처로는 실제로 나간다')
    assert.equal(deliveriesOf(store)[0].status, 'delivered')
  })
})

test('주소가 여럿이면 하나라도 사내망일 때 보내지 않고, 하나도 없으면 그 사실을 말한다', async () => {
  await withApp(async ({ origin, store, app, state, fetcher }) => {
    const admin = await login(origin, ADMIN.email)
    await outboundEndpoint(origin, admin)
    // 공인 A와 사설 A를 함께 올린 이름. 하나만 읽고 통과시키면 fetch의 자체 해석이 사설로 나갈 수 있다.
    state.addresses = ['203.0.113.10', '10.1.2.3']

    await api(origin, admin, '/work-items/WK-T1/transition', 'POST', { action: 'accept' })
    await settle(app)
    assert.equal(fetcher.calls.length, 0)
    assert.match(deliveriesOf(store)[0].lastError, /사내망 주소/)

    state.addresses = []
    await api(origin, admin, '/work-items/WK-T2/transition', 'POST', { action: 'approve' })
    await settle(app)
    assert.equal(fetcher.calls.length, 0)
    // 사내망인 것과 주소를 못 찾은 것은 다른 사실이다. 한 문장으로 묶으면 방화벽을 뒤지게 된다.
    const missing = deliveriesOf(store).find((row) => row.aggregateId === 'WK-T2')
    assert.match(missing.lastError, /IP를 찾지 못해/)
  })
})

test('밀린 전달은 오래된 것부터 나간다 — 되살아난 수신처가 옛 상태로 끝나지 않는다', async () => {
  await withApp(async ({ origin, store, app, state, fetcher }) => {
    const admin = await login(origin, ADMIN.email)
    const endpoint = await outboundEndpoint(origin, admin, ['work.transitioned'])
    const failed = (index) => {
      const at = new Date(state.now.getTime() - (5 - index) * 60_000).toISOString()
      return {
        id: `WHD-back-${index}`, endpointId: endpoint.id, channel: 'webhook', eventType: 'work.transitioned',
        eventId: `work.transitioned:WK-${index}:${at}`, aggregateId: `WK-${index}`, target: 'hooks.example.com',
        status: 'failed', attempts: 1, nextAttemptAt: at, lastStatusCode: 503, lastError: '받는 쪽 응답 503',
        requestedAt: at, deliveredAt: null,
        payload: { id: `WK-${index}`, title: '밀린 전이', beforeState: '업무요청', afterState: '수행중', ownerId: ADMIN.id },
        actor: ADMIN.id,
      }
    }
    // 저장 순서는 새것이 앞이다(기록 화면이 그 순서를 원한다).
    store.tenants[TENANT]['webhook-deliveries'] = {
      data: [failed(4), failed(3), failed(2), failed(1)], updatedAt: state.now.toISOString(), updatedBy: 'test',
    }

    await app.locals.webhookDispatch.drainWebhookDeliveries(TENANT)
    await settle(app)

    const order = fetcher.calls.map((call) => JSON.parse(call.init.body).aggregateId)
    assert.deepEqual(order, ['WK-1', 'WK-2', 'WK-3', 'WK-4'], '보내는 순서는 일어난 순서다')
  })
})

test('업무 화면에서 만든 업무도 work.created로 나간다 — 켠 체크박스가 지키는 약속이다', async () => {
  await withApp(async ({ origin, store, app, fetcher }) => {
    const admin = await login(origin, ADMIN.email)
    await outboundEndpoint(origin, admin, ['work.created'])

    const rows = store.tenants[TENANT]['work-items'].data
    const saved = await api(origin, admin, '/workspace/work-items', 'PUT', {
      data: [...rows, task({ id: 'WK-NEW', title: '신규 점검' })],
    })
    assert.equal(saved.status, 200, JSON.stringify(await readJson(saved)))
    await settle(app)

    const created = deliveriesOf(store).filter((row) => row.eventType === 'work.created')
    assert.equal(created.length, 1, '새로 생긴 한 건만 나간다 — 저장할 때마다 목록 전체가 나가면 안 된다')
    assert.equal(created[0].aggregateId, 'WK-NEW')
    assert.equal(created[0].status, 'delivered')
    assert.equal(JSON.parse(fetcher.calls.at(-1).init.body).data.title, '신규 점검')
    // 바깥으로 나가는 값은 이벤트별 fields뿐이다 — 저장한 설명이 실려 나가지 않는다.
    assert.equal(JSON.stringify(fetcher.calls.at(-1).init.body).includes('buyer@partner.example'), false)
  })
})

test('저장이 실패하면 work.created 행도 함께 사라진다', async () => {
  await withApp(async ({ origin, store, app, state, fetcher }) => {
    const admin = await login(origin, ADMIN.email)
    await outboundEndpoint(origin, admin, ['work.created'])
    const before = JSON.stringify(store.tenants[TENANT]['webhook-deliveries'] ?? null)

    state.failNextCommit = true
    const saved = await api(origin, admin, '/workspace/work-items', 'PUT', {
      data: [...store.tenants[TENANT]['work-items'].data, task({ id: 'WK-GHOST', title: '유령' })],
    })
    assert.equal(saved.status, 500)
    assert.equal(JSON.stringify(store.tenants[TENANT]['webhook-deliveries'] ?? null), before)

    await app.locals.webhookDispatch.sweepDeliveries(state.now)
    await settle(app)
    assert.equal(fetcher.calls.length, 0, '일어나지 않은 생성이 몇 분 뒤에 몰래 나가지 않는다')
  })
})

test('템플릿 실체화가 만든 업무도 work.created로 나간다 — 한 번에 가장 많이 생기는 갈래다', async () => {
  await withApp(async ({ origin, store, app, state, fetcher }) => {
    const admin = await login(origin, ADMIN.email)
    await outboundEndpoint(origin, admin, ['work.created'])
    // 기본 템플릿은 첫 목록 조회에서 심긴다.
    assert.equal((await api(origin, admin, '/project-templates', 'GET')).status, 200)
    const body = { name: '가을 신제품', startDate: '2026-10-01', roleMap: { PM: ADMIN.id, 품질: ADMIN.id, 생산: ADMIN.id } }

    // 먼저 커밋 실패. 프로젝트도 업무도 없는데 배송 행만 남아 있으면 일어나지 않은 생성이 몇 분 뒤 나간다.
    state.failNextCommit = true
    const failed = await api(origin, admin, '/project-templates/PT-SYS-FOOD-NEW-PRODUCT/instantiate', 'POST', { ...body, clientRequestId: 'req-fail' })
    assert.equal(failed.status, 500, JSON.stringify(await readJson(failed)))
    assert.equal(deliveriesOf(store).filter((row) => row.eventType === 'work.created').length, 0)

    const made = await api(origin, admin, '/project-templates/PT-SYS-FOOD-NEW-PRODUCT/instantiate', 'POST', { ...body, clientRequestId: 'req-ok' })
    const madeBody = await readJson(made)
    assert.equal(made.status, 201, JSON.stringify(madeBody))
    await settle(app)

    const created = deliveriesOf(store).filter((row) => row.eventType === 'work.created')
    assert.equal(created.length, madeBody.workItems.length, '만든 업무 수만큼 나간다 — 하나도 빠지지 않는다')
    assert.ok(created.length > 1, '템플릿은 여러 건을 한 번에 만든다')
    assert.ok(created.every((row) => row.status === 'delivered'))
    assert.equal(fetcher.calls.length, created.length)
    // 나가는 값은 이벤트별 fields뿐이다 — 템플릿이 채운 설명이 실려 나가지 않는다.
    assert.deepEqual(
      Object.keys(JSON.parse(fetcher.calls.at(-1).init.body).data).sort(),
      ['due', 'id', 'ownerId', 'status', 'title'],
    )
  })
})

test('반복 업무 규칙이 찍어 낸 업무도 work.created로 나간다', async () => {
  const store = seedStore()
  store.tenants[TENANT]['work-rules'] = {
    data: [{
      id: 'RULE-1', title: '주간 설비 점검', description: '점검표대로 확인', owner: ADMIN.name, ownerId: ADMIN.id,
      requester: ADMIN.name, requesterId: ADMIN.id, frequency: 'yearly', interval: 1, monthDay: 1, dueTime: '09:00',
      priority: '보통', category: '일반', active: true, nextRun: '2026-01-01',
      createdAt: '2020-01-01T00:00:00.000Z',
    }],
    updatedAt: '2020-01-01T00:00:00.000Z',
  }
  await withApp(async ({ origin, store: live, app, fetcher }) => {
    const admin = await login(origin, ADMIN.email)
    await outboundEndpoint(origin, admin, ['work.created'])

    const run = await api(origin, admin, '/work-rules/materialize', 'POST', {})
    assert.equal(run.status, 200, JSON.stringify(await readJson(run)))
    await settle(app)

    const created = deliveriesOf(live).filter((row) => row.eventType === 'work.created')
    assert.ok(created.length >= 1, '규칙이 만든 업무도 사람이 만든 업무와 같은 사건이다')
    assert.ok(created.every((row) => row.aggregateId.startsWith('WK-R-')))
    assert.ok(fetcher.calls.length >= 1)
  }, { store })
})

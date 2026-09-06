import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import test from 'node:test'

import { createApp } from './app.mjs'
import { withServer } from './test-server.mjs'

/**
 * 수신 웹훅 — 판정 12의 앞쪽 절반("외부 POST가 채널에 게시된다")의 서버 쪽 증명.
 *
 * 여기서 지키는 네 가지:
 *  1. 실패는 전부 같은 404 본문이다 — 토큰의 존재 여부를 알려 주는 오라클을 만들지 않는다.
 *  2. 기계가 보낸 말은 승인 큐와 멘션 알림으로 번지지 않는다.
 *  3. 외부 시스템의 재시도가 중복 게시·중복 업무가 되지 않는다.
 *  4. 게스트 쿠키를 단 요청은 게이트가 먼저 막는다(고정 본문 403).
 */

const TENANT = 'TENANT-SUNSEA'
const ADMIN = { id: 'USR-SUNSEA-ADMIN', name: '김서원', email: 'admin@sunsea.co.kr' }
const PARK = { id: 'USR-SUNSEA-PARK', name: '박지현', email: 'jihyun.park@sunsea.co.kr' }
const OTHER_TENANT_ADMIN = 'USR-POHANG-ADMIN'
const GUEST = { id: 'USR-TENANT-SUNSEA-GUEST01', name: '홍거래', email: 'guest@partner.example', password: 'Guest!Pass2026' }
const GRANT_ID = 'GST-TENANT-SUNSEA-000001'

const digestHex = (password, accountId) => scryptSync(String(password), `onfactory:${accountId}`, 32).toString('hex')
const room = (overrides) => ({ type: 'team', kind: 'group', name: '방', subtitle: '', unread: 0, lastMessage: '', lastTime: '', messages: [], ...overrides })

function seedStore() {
  return {
    version: 2,
    tenants: {
      [TENANT]: {
        'project-spaces': { data: [{
          id: 'PRJ-A', name: '파트너 협업 A', description: '', visibility: 'members', status: 'active', stage: '진행 중',
          client: '파트너상사', amount: 0, ownerId: ADMIN.id, ownerName: ADMIN.name,
          members: [
            { id: ADMIN.id, name: ADMIN.name, role: 'owner' },
            { id: PARK.id, name: PARK.name, role: 'editor' },
            { id: GUEST.id, name: GUEST.name, role: 'viewer', kind: 'guest' },
          ],
          createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
        }], updatedAt: '2026-09-01T00:00:00.000Z' },
        'messenger-conversations': { data: [
          room({ id: 'grp-hook', name: '설비 모니터링', projectId: 'PRJ-A', participantIds: [ADMIN.id, PARK.id, GUEST.id], ownerId: ADMIN.id }),
          room({ id: 'grp-second', name: '두 번째 방', participantIds: [ADMIN.id, PARK.id], ownerId: ADMIN.id }),
          // 둘만의 대화. 관리자라도 여기에는 글을 쓸 수 없어야 한다.
          room({
            id: 'dm-park-oh', type: 'direct', kind: 'direct', name: '박지현', participantIds: [PARK.id, GUEST.id], ownerId: PARK.id,
            messages: [{ id: 'm-dm-1', senderId: PARK.id, senderName: PARK.name, senderRole: 'member', text: '둘만의 이야기', time: '09:00', createdAt: '2026-09-01T00:00:00.000Z', readBy: [] }],
          }),
        ], updatedAt: '2026-09-01T00:00:00.000Z' },
      },
      'TENANT-POHANG': {},
    },
    platform: {},
    accountApprovals: { [GUEST.id]: 'approved' },
    accountCredentials: { [GUEST.id]: { passwordHash: digestHex(GUEST.password, GUEST.id), mustChangePassword: false, temporaryPasswordExpiresAt: null } },
    invitedAccounts: [{
      id: GUEST.id, email: GUEST.email, name: GUEST.name, tenantId: TENANT, tenantName: '데모', team: '파트너상사',
      jobRole: '외부 게스트', requested: '게스트 초대', role: 'tenant-guest', guestGrantId: GRANT_ID,
    }],
    passwordResetRequests: [],
    guestGrants: [{
      id: GRANT_ID, tenantId: TENANT, accountId: GUEST.id, email: GUEST.email, name: GUEST.name, orgName: '파트너상사',
      projectIds: ['PRJ-A'], invitedById: ADMIN.id, invitedByName: ADMIN.name, status: 'active',
      tokenHash: null, tokenIssuedAt: null, tokenExpiresAt: null, resendCount: 0, lastResentAt: null,
      accessExpiresAt: null, acceptedAt: '2026-09-01T00:00:00.000Z', revokedAt: null, revokedById: null, deactivatedAt: null,
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    }],
  }
}

async function withApp(run, { store = seedStore(), ...extra } = {}) {
  const state = { failNextCommit: false }
  const app = createApp({
    apiKey: '',
    initialWorkspaceStore: store,
    onWorkspaceStoreChange: () => {
      if (!state.failNextCommit) return
      state.failNextCommit = false
      throw new Error('디스크가 가득 찼습니다')
    },
    // 봉인 키 없이도 받는 연동은 만들 수 있다 — 서명이 필요한 것은 보내는 쪽뿐이다.
    env: {},
    ...extra,
  })
  await withServer(app, (origin) => run({ origin, store, app, state }))
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

/** 받는 연동 하나를 만들고 토큰까지 발급해 평문을 돌려준다. */
async function inboundEndpoint(origin, session, body) {
  const created = await (await api(origin, session, '/webhooks', 'POST', { direction: 'inbound', label: '설비 모니터링', ...body })).json()
  assert.ok(created.endpoint?.id, JSON.stringify(created))
  const issued = await (await api(origin, session, `/webhooks/${created.endpoint.id}/token`, 'POST')).json()
  assert.ok(issued.token, JSON.stringify(issued))
  // 건네는 주소는 실제로 닿는 주소여야 한다. 로컬에는 TLS가 없으므로 여기에 https를 적으면
  // '이 주소로 POST하면 도착합니다'가 붙여 넣는 그 자리에서 거짓이 된다.
  assert.equal(issued.hookUrl, `${origin}/api/hooks/${issued.token}`)
  return { id: created.endpoint.id, token: issued.token, hookUrl: issued.hookUrl }
}

const hook = (origin, token, body, headers = {}) => fetch(`${origin}/api/hooks/${token}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
})

const conversationOf = (store, id) => store.tenants[TENANT]['messenger-conversations'].data.find((item) => item.id === id)
const readJson = async (response) => { try { return await response.json() } catch { return null } }

test('토큰이 틀린 모든 경우가 같은 404 본문이다 — 존재 오라클을 만들지 않는다', async () => {
  await withApp(async ({ origin, store }) => {
    const admin = await login(origin, ADMIN.email)
    const endpoint = await inboundEndpoint(origin, admin, { conversationId: 'grp-hook' })

    const bodies = []
    for (const token of ['', 'short', 'x'.repeat(41), `${endpoint.token}A`]) {
      const response = await hook(origin, token || 'x', { text: '안녕' })
      assert.equal(response.status, 404, `token='${token}'`)
      bodies.push(await response.json())
    }
    // 토큰을 회수하면 같은 문장으로 돌아간다.
    await api(origin, admin, `/webhooks/${endpoint.id}/token`, 'DELETE')
    const revoked = await hook(origin, endpoint.token, { text: '안녕' })
    assert.equal(revoked.status, 404)
    bodies.push(await revoked.json())

    for (const body of bodies) assert.deepEqual(body, bodies[0], '실패 본문은 하나뿐이다')
    assert.equal(bodies[0].error.code, 'WEBHOOK_NOT_FOUND')
    assert.equal(conversationOf(store, 'grp-hook').messages.length, 0)
  })
})

test('{text}는 채널에 봇 이름으로 게시되고, 승인 큐와 멘션 알림으로 번지지 않는다', async () => {
  await withApp(async ({ origin, store }) => {
    const admin = await login(origin, ADMIN.email)
    const endpoint = await inboundEndpoint(origin, admin, { conversationId: 'grp-hook' })

    // 지시 문형에 멘션까지 넣는다. 사람이 썼다면 제안 한 건과 멘션 알림이 나갔을 문장이다.
    const response = await hook(origin, endpoint.token, { text: '@박지현 3호기 온도 이상, 내일까지 처리 바랍니다.' })
    assert.equal(response.status, 202, await response.text())

    const messages = conversationOf(store, 'grp-hook').messages
    assert.equal(messages.length, 1)
    assert.equal(messages[0].senderId, 'SYS-WEBHOOK')
    assert.equal(messages[0].senderName, '설비 모니터링')
    assert.equal(messages[0].senderRole, 'system')
    assert.match(messages[0].text, /3호기 온도 이상/)
    assert.deepEqual(messages[0].readBy, [])

    assert.deepEqual(store.tenants[TENANT]['ai-proposals']?.data ?? [], [], '기계가 보낸 지시가 승인 큐를 채우면 안 된다')
    assert.deepEqual(store.tenants[TENANT].notifications?.data ?? [], [], '@이름 흉내로 알림을 쏘는 길도 막는다')

    // 수신 집계는 엔드포인트에 남는다.
    const listed = await (await api(origin, admin, '/webhooks', 'GET')).json()
    const row = listed.endpoints.find((item) => item.id === endpoint.id)
    assert.equal(row.receivedCount, 1)
    assert.ok(row.lastReceivedAt)
    assert.equal(row.hasToken, true)
    assert.equal(row.hasSecret, false)
  })
})

test('{task}는 업무요청으로 들어오고 출처 배지가 외부 연동을 가리킨다', async () => {
  await withApp(async ({ origin, store }) => {
    const admin = await login(origin, ADMIN.email)
    const endpoint = await inboundEndpoint(origin, admin, { defaultOwnerId: PARK.id })

    const response = await hook(origin, endpoint.token, { task: { title: '3호기 점검', description: '온도 이상 확인', due: '2026-09-20' } })
    const created = await readJson(response)
    assert.equal(response.status, 202, JSON.stringify(created))

    const tasks = store.tenants[TENANT]['work-items'].data
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].id, created.id)
    assert.equal(tasks[0].status, '업무요청', '외부에서 결재 상태머신을 건너뛸 수 없다')
    assert.equal(tasks[0].ownerId, PARK.id)
    assert.deepEqual(tasks[0].origin, {
      kind: 'webhook', label: '외부 연동에서 생성', detail: '설비 모니터링', page: 'people', focusId: endpoint.id,
    })
    const assigned = (store.tenants[TENANT].notifications?.data ?? []).filter((item) => item.type === 'task-assigned')
    assert.equal(assigned.length, 1)
    assert.equal(assigned[0].recipientId, PARK.id)
  })
})

test('담당자를 못 찾는 세 경우가 같은 코드·같은 본문이다', async () => {
  await withApp(async ({ origin }) => {
    const admin = await login(origin, ADMIN.email)
    const endpoint = await inboundEndpoint(origin, admin, {})

    const bodies = []
    for (const ownerId of [undefined, OTHER_TENANT_ADMIN, 'USR-NOT-A-REAL-ACCOUNT']) {
      const response = await hook(origin, endpoint.token, { task: { title: '제목', ...(ownerId ? { ownerId } : {}) } })
      assert.equal(response.status, 400, `ownerId=${ownerId}`)
      bodies.push(await response.json())
    }
    for (const body of bodies) assert.deepEqual(body, bodies[0], '다른 고객사 계정과 없는 id가 구분되면 안 된다')
    assert.equal(bodies[0].error.code, 'WEBHOOK_OWNER_REQUIRED')
  })
})

test('같은 전달 id로 두 번 보내도 한 건이다 — 재시도가 중복이 되지 않는다', async () => {
  await withApp(async ({ origin, store }) => {
    const admin = await login(origin, ADMIN.email)
    const messageHook = await inboundEndpoint(origin, admin, { conversationId: 'grp-hook' })
    const taskHook = await inboundEndpoint(origin, admin, { defaultOwnerId: PARK.id })

    const headers = { 'x-inthefield-delivery-id': 'evt-2026-09-06-001' }
    const first = await hook(origin, messageHook.token, { text: '중복 확인' }, headers)
    assert.equal(first.status, 202)
    const second = await hook(origin, messageHook.token, { text: '중복 확인' }, headers)
    assert.equal(second.status, 200)
    assert.equal((await second.json()).replayed, true)
    assert.equal(conversationOf(store, 'grp-hook').messages.length, 1)

    const firstTask = await hook(origin, taskHook.token, { task: { title: '중복 업무' } }, headers)
    assert.equal(firstTask.status, 202)
    const secondTask = await hook(origin, taskHook.token, { task: { title: '중복 업무' } }, headers)
    assert.equal(secondTask.status, 200)
    assert.equal((await secondTask.json()).replayed, true)
    assert.equal(store.tenants[TENANT]['work-items'].data.length, 1)
  })
})

test('엔드포인트별 분당 상한을 넘으면 429이고, 다른 엔드포인트는 영향받지 않는다', async () => {
  await withApp(async ({ origin }) => {
    const admin = await login(origin, ADMIN.email)
    const busy = await inboundEndpoint(origin, admin, { conversationId: 'grp-hook' })
    const calm = await inboundEndpoint(origin, admin, { conversationId: 'grp-second' })

    // 본문 검사는 레이트 리밋 뒤에 온다 — 빈 본문으로 버킷만 비운다(게시 60건을 만들지 않는다).
    for (let index = 0; index < 60; index += 1) {
      const response = await hook(origin, busy.token, {})
      assert.equal(response.status, 400, `${index + 1}번째 요청`)
    }
    const limited = await hook(origin, busy.token, { text: '한 건 더' })
    assert.equal(limited.status, 429)
    assert.equal(limited.headers.get('retry-after'), '60')
    assert.equal((await limited.json()).error.code, 'WEBHOOK_RATE_LIMITED')

    const other = await hook(origin, calm.token, { text: '다른 방은 멀쩡하다' })
    assert.equal(other.status, 202, await other.text())
  })
})

test('64KB를 넘는 본문은 전역 4mb 파서가 먹기 전에 413으로 막힌다', async () => {
  await withApp(async ({ origin, store }) => {
    const admin = await login(origin, ADMIN.email)
    const endpoint = await inboundEndpoint(origin, admin, { conversationId: 'grp-hook' })
    const huge = JSON.stringify({ text: 'x'.repeat(65 * 1024) })

    const withLength = await fetch(`${origin}/api/hooks/${endpoint.token}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: huge,
    })
    assert.equal(withLength.status, 413)
    const tooLarge = await withLength.json()
    assert.equal(tooLarge.error.code, 'PAYLOAD_TOO_LARGE')
    assert.match(tooLarge.error.message, /64KB/, '상한을 KB로 말해야 사람이 고칠 수 있다')

    // json이 아닌 content-type은 어느 파서도 잡지 않는다. 핸들러의 두 번째 그물이 같은 문장으로 답한다.
    const plain = await fetch(`${origin}/api/hooks/${endpoint.token}`, {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: huge,
    })
    assert.equal(plain.status, 413)
    assert.deepEqual(await plain.json(), tooLarge, '같은 잘못에 두 가지 문장을 주지 않는다')

    // content-length 없이 청크로 보내도 파서가 같은 상한에서 끊는다.
    const chunked = await fetch(`${origin}/api/hooks/${endpoint.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      duplex: 'half',
      body: new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()
          controller.enqueue(encoder.encode(huge))
          controller.close()
        },
      }),
    })
    assert.equal(chunked.status, 413)
    assert.deepEqual(await readJson(chunked), tooLarge)

    assert.equal(conversationOf(store, 'grp-hook').messages.length, 0)
  })
})

test('게스트 쿠키를 단 수신 요청은 게이트가 먼저 막는다 — 고정 본문 403이다', async () => {
  await withApp(async ({ origin, store }) => {
    const admin = await login(origin, ADMIN.email)
    const endpoint = await inboundEndpoint(origin, admin, { conversationId: 'grp-hook' })
    const guest = await login(origin, GUEST.email, GUEST.password)

    const response = await fetch(`${origin}/api/hooks/${endpoint.token}`, {
      method: 'POST', headers: { ...guest.headers }, body: JSON.stringify({ text: '게스트가 보냄' }),
    })
    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: { code: 'GUEST_SCOPE_FORBIDDEN', message: '초대된 프로젝트 안에서만 사용할 수 있습니다.' } })
    assert.equal(conversationOf(store, 'grp-hook').messages.length, 0)

    // 관리 라우트도 통째로 막힌다.
    for (const [method, path] of [['GET', '/api/webhooks'], ['POST', '/api/webhooks'], ['GET', '/api/webhooks/deliveries']]) {
      const blocked = await fetch(`${origin}${path}`, { method, headers: guest.headers, ...(method === 'GET' ? {} : { body: '{}' }) })
      assert.equal(blocked.status, 403, `${method} ${path}`)
      assert.equal((await blocked.json()).error.code, 'GUEST_SCOPE_FORBIDDEN')
    }
  })
})

test('저장에 실패하면 500이고 대화는 이전 상태로 되돌아간다', async () => {
  await withApp(async ({ origin, store, state }) => {
    const admin = await login(origin, ADMIN.email)
    const endpoint = await inboundEndpoint(origin, admin, { conversationId: 'grp-hook' })
    const before = JSON.parse(JSON.stringify(store.tenants[TENANT]['messenger-conversations']))

    state.failNextCommit = true
    const response = await hook(origin, endpoint.token, { text: '저장 실패' })
    assert.equal(response.status, 500)
    assert.equal((await response.json()).error.code, 'WEBHOOK_WRITE_FAILED')
    assert.deepEqual(store.tenants[TENANT]['messenger-conversations'], before, '실패한 게시가 메모리에 남으면 안 된다')
  })
})

test('본문이 text와 task 둘 다이거나 둘 다 아니면 400이다', async () => {
  await withApp(async ({ origin }) => {
    const admin = await login(origin, ADMIN.email)
    const endpoint = await inboundEndpoint(origin, admin, { conversationId: 'grp-hook' })
    for (const body of [{}, { text: '하나', task: { title: '둘' } }, { other: 1 }]) {
      const response = await hook(origin, endpoint.token, body)
      assert.equal(response.status, 400, JSON.stringify(body))
      assert.equal((await response.json()).error.code, 'WEBHOOK_PAYLOAD_INVALID')
    }
  })
})

test('받을 채널이 사라지면 409로 답하고, 지원 채널은 애초에 고를 수 없다', async () => {
  await withApp(async ({ origin, store }) => {
    const admin = await login(origin, ADMIN.email)
    const endpoint = await inboundEndpoint(origin, admin, { conversationId: 'grp-hook' })
    // 방을 tombstone으로 만든다(삭제 라우트가 하는 일과 같은 모양).
    const conversations = store.tenants[TENANT]['messenger-conversations'].data
    store.tenants[TENANT]['messenger-conversations'].data = conversations.map((item) => (
      item.id === 'grp-hook' ? { ...item, lifecycle: 'deleted' } : item
    ))
    const response = await hook(origin, endpoint.token, { text: '사라진 방' })
    assert.equal(response.status, 409)
    assert.equal((await response.json()).error.code, 'WEBHOOK_CHANNEL_MISSING')

    const missing = await api(origin, admin, '/webhooks', 'POST', { direction: 'inbound', label: '없는 방', conversationId: 'grp-nope' })
    assert.equal(missing.status, 404)
    assert.equal((await missing.json()).error.code, 'CONVERSATION_NOT_FOUND')
  })
})

test('엉터리 토큰을 아무리 던져도 유효한 수신은 막히지 않는다', async () => {
  await withApp(async ({ origin, store }) => {
    const admin = await login(origin, ADMIN.email)
    const endpoint = await inboundEndpoint(origin, admin, { conversationId: 'grp-hook' })

    // 인증 없이 누구나 할 수 있는 일이다. 토큰이 틀린 요청 전체 버킷(120/분)을 훌쩍 넘겨 비운다.
    let refused = 0
    for (let index = 0; index < 130; index += 1) {
      const response = await hook(origin, `zzz${'x'.repeat(41)}${index}`.slice(0, 60), { text: '없는 토큰' })
      assert.ok(response.status === 404 || response.status === 429, `${index + 1}번째: ${response.status}`)
      if (response.status === 429) refused += 1
      await response.text()
    }
    assert.ok(refused > 0, '틀린 토큰은 결국 스스로 429에 걸린다')

    // 그리고 유효한 토큰은 그대로 도착한다 — 낯선 사람이 남의 몫을 대신 쓸 수 없다.
    const accepted = await hook(origin, endpoint.token, { text: '정상 배달' })
    assert.equal(accepted.status, 202, await accepted.text())
    assert.equal(conversationOf(store, 'grp-hook').messages.length, 1)
  })
})

test('1:1 대화는 받는 곳으로 고를 수 없다 — 서버가 고르개보다 느슨하지 않다', async () => {
  await withApp(async ({ origin, store }) => {
    const admin = await login(origin, ADMIN.email)

    const created = await api(origin, admin, '/webhooks', 'POST', { direction: 'inbound', label: '몰래 넣기', conversationId: 'dm-park-oh' })
    assert.equal(created.status, 404, '없는 방과 같은 문장으로 거절한다')
    assert.equal((await readJson(created)).error.code, 'CONVERSATION_NOT_FOUND')

    // 만들기와 고치기가 같은 문을 지난다.
    const ok = await inboundEndpoint(origin, admin, { conversationId: 'grp-hook' })
    const patched = await api(origin, admin, `/webhooks/${ok.id}`, 'PATCH', { conversationId: 'dm-park-oh' })
    assert.equal(patched.status, 404)
    assert.equal((await readJson(patched)).error.code, 'CONVERSATION_NOT_FOUND')

    assert.deepEqual(
      conversationOf(store, 'dm-park-oh').messages.map((item) => item.senderId),
      [PARK.id],
      '외부에서 들어온 말이 둘만의 대화에 섞이면 안 된다',
    )
  })
})

test('건네준 수신 주소는 실제로 받는 주소다 — 세 갈래가 모두 자기 배포를 가리킨다', async () => {
  await withApp(async ({ origin, store }) => {
    const admin = await login(origin, ADMIN.email)
    const endpoint = await inboundEndpoint(origin, admin, { conversationId: 'grp-hook' })

    // 1) 로컬: 건네준 주소 그대로 POST하면 도착한다(화면이 하는 약속을 여기서 잰다).
    const posted = await fetch(endpoint.hookUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '건네준 주소 그대로' }),
    })
    assert.equal(posted.status, 202, await posted.text())
    assert.equal(conversationOf(store, 'grp-hook').messages.length, 1)

    // 2) 프록시 뒤: 토큰이 경로에 실려 있으므로 https로 적는다.
    const forwarded = await readJson(await fetch(`${origin}/api/webhooks/${endpoint.id}/token`, {
      method: 'POST', headers: { ...admin.headers, 'x-forwarded-proto': 'https' },
    }))
    assert.match(forwarded.hookUrl, /^https:\/\//)
  })

  // 3) APP_PUBLIC_URL이 있으면 그 도메인이 정답이다(요청이 어디로 들어왔든).
  await withApp(async ({ origin }) => {
    const admin = await login(origin, ADMIN.email)
    const created = await readJson(await api(origin, admin, '/webhooks', 'POST', { direction: 'inbound', label: '설비', conversationId: 'grp-hook' }))
    const issued = await readJson(await api(origin, admin, `/webhooks/${created.endpoint.id}/token`, 'POST'))
    assert.equal(issued.hookUrl, `https://erp.example.com/api/hooks/${issued.token}`)
  }, { env: { APP_PUBLIC_URL: 'https://erp.example.com/' } })

  // 4) 잘못 적힌 APP_PUBLIC_URL 한 줄이 토큰을 평문으로 흘려보내지 않는다. 이 토큰은 인증 그 자체라
  //    http 주소를 인쇄해 주면 매 호출마다 자격이 그대로 노출된다 — 설정값이라고 믿지 않는다.
  for (const configured of ['http://erp.example.com', 'not a url']) {
    await withApp(async ({ origin }) => {
      const admin = await login(origin, ADMIN.email)
      const created = await readJson(await api(origin, admin, '/webhooks', 'POST', { direction: 'inbound', label: '설비', conversationId: 'grp-hook' }))
      const issued = await readJson(await api(origin, admin, `/webhooks/${created.endpoint.id}/token`, 'POST'))
      assert.doesNotMatch(issued.hookUrl, /^http:\/\/erp\.example\.com/, configured)
      // 요청 기준으로 떨어진다. 로컬이라 http지만 그 주소는 실제로 받는 주소다.
      assert.equal(issued.hookUrl, `${origin}/api/hooks/${issued.token}`)
    }, { env: { APP_PUBLIC_URL: configured } })
  }
})

test('토큰 발급은 관리자가 끈 스위치를 조용히 켜지 않는다', async () => {
  await withApp(async ({ origin }) => {
    const admin = await login(origin, ADMIN.email)
    const created = await readJson(await api(origin, admin, '/webhooks', 'POST', {
      direction: 'inbound', label: '아직 끄고 준비 중', conversationId: 'grp-hook', enabled: false,
    }))
    assert.equal(created.endpoint.enabled, false)

    const issued = await readJson(await api(origin, admin, `/webhooks/${created.endpoint.id}/token`, 'POST'))
    // 켜 버리면 대화상자의 '사용' 체크는 꺼진 채로 남아, 그다음 [저장]이 다시 끈다 —
    // 관리자는 부탁한 적 없는 변경을 두 번 받는다.
    assert.equal(issued.endpoint.enabled, false)
    const refused = await hook(origin, issued.token, { text: '꺼진 연동' })
    assert.equal(refused.status, 404, '꺼진 연동은 토큰이 있어도 받지 않는다')
  })
})

test('토큰 역조회 색인은 회전·끄기·켜기를 그 자리에서 따라간다', async () => {
  await withApp(async ({ origin, store }) => {
    const admin = await login(origin, ADMIN.email)
    const endpoint = await inboundEndpoint(origin, admin, { conversationId: 'grp-hook' })
    assert.equal((await hook(origin, endpoint.token, { text: '첫 번째' })).status, 202)

    // 회전: 옛 토큰은 그 자리에서 죽고 새 토큰이 산다(색인이 한 판 늦으면 회수가 늦어진다).
    const rotated = await readJson(await api(origin, admin, `/webhooks/${endpoint.id}/token`, 'POST'))
    assert.equal((await hook(origin, endpoint.token, { text: '옛 토큰' })).status, 404)
    assert.equal((await hook(origin, rotated.token, { text: '새 토큰' })).status, 202)

    // 끄기·켜기도 마찬가지다.
    await api(origin, admin, `/webhooks/${endpoint.id}`, 'PATCH', { enabled: false })
    assert.equal((await hook(origin, rotated.token, { text: '꺼짐' })).status, 404)
    await api(origin, admin, `/webhooks/${endpoint.id}`, 'PATCH', { enabled: true })
    assert.equal((await hook(origin, rotated.token, { text: '다시 켜짐' })).status, 202)

    assert.deepEqual(
      conversationOf(store, 'grp-hook').messages.map((item) => item.text),
      ['첫 번째', '새 토큰', '다시 켜짐'],
    )
  })
})

test('형식이 깨진 행이 있으면 목록이 그 사실을 말한다 — 멀쩡해 보이는데 저장만 막히지 않는다', async () => {
  await withApp(async ({ origin, store }) => {
    const admin = await login(origin, ADMIN.email)
    await inboundEndpoint(origin, admin, { conversationId: 'grp-hook' })
    const rows = store.tenants[TENANT]['webhook-endpoints'].data
    store.tenants[TENANT]['webhook-endpoints'] = { data: [...rows, { id: 'WHK-BROKEN' }], updatedAt: rows[0].updatedAt }

    const listed = await readJson(await api(origin, admin, '/webhooks', 'GET'))
    assert.equal(listed.endpoints.length, 1, '성한 행은 그대로 보인다 — 한 행 때문에 화면을 통째로 막지 않는다')
    // 쓰기가 거절하는 그 문장 그대로다. 같은 사실을 두 낱말로 말하면 관리자가 둘을 잇지 못한다.
    const blocked = await api(origin, admin, `/webhooks/${listed.endpoints[0].id}`, 'PATCH', { label: '이름 고치기' })
    assert.equal(blocked.status, 409)
    assert.equal(listed.dataIssueMessage, (await readJson(blocked)).error.message)

    // 깨진 것이 없으면 아무 말도 하지 않는다(가짜 경고를 만들지 않는다).
    store.tenants[TENANT]['webhook-endpoints'] = { data: rows, updatedAt: rows[0].updatedAt }
    assert.equal((await readJson(await api(origin, admin, '/webhooks', 'GET'))).dataIssueMessage, '')
  })
})

test('토큰 회수는 끄기일 뿐, 일어나지 않은 실패를 적지 않는다', async () => {
  await withApp(async ({ origin }) => {
    const admin = await login(origin, ADMIN.email)
    const endpoint = await inboundEndpoint(origin, admin, { conversationId: 'grp-hook' })

    const revoked = await readJson(await api(origin, admin, `/webhooks/${endpoint.id}/token`, 'DELETE'))
    assert.equal(revoked.endpoint.enabled, false)
    assert.equal(revoked.endpoint.hasToken, false)
    assert.equal(revoked.endpoint.consecutiveFailures, 0)
    // disabledAt은 '연속 실패로 스스로 멈췄다'는 뜻이다. 사람이 회수한 것에 그 자국을 남기면
    // 화면이 '중지됨 · 연속 실패 0회'라고 없던 원인을 말한다.
    assert.equal(revoked.endpoint.disabledAt, null)
  })
})

test('채널이 지워져도 이름 고치기와 끄기는 막히지 않는다 — 수습하는 길을 잠그지 않는다', async () => {
  await withApp(async ({ origin, store }) => {
    const admin = await login(origin, ADMIN.email)
    const endpoint = await inboundEndpoint(origin, admin, { conversationId: 'grp-hook' })
    const conversations = store.tenants[TENANT]['messenger-conversations'].data
    store.tenants[TENANT]['messenger-conversations'].data = conversations.map((item) => (
      item.id === 'grp-hook' ? { ...item, lifecycle: 'deleted' } : item
    ))

    // 화면의 [저장]은 늘 conversationId를 함께 보낸다. 바뀌지 않은 그 값 때문에 이름만 고치는
    // 저장까지 404가 되면, 가장 안전한 수습(끄기)이 먼저 다른 채널을 고르라고 요구하게 된다.
    const renamed = await api(origin, admin, `/webhooks/${endpoint.id}`, 'PATCH', {
      label: '설비 모니터링(중지 예정)', conversationId: 'grp-hook', defaultOwnerId: '', enabled: true,
    })
    const renamedBody = await readJson(renamed)
    assert.equal(renamed.status, 200, JSON.stringify(renamedBody))
    assert.equal(renamedBody.endpoint.label, '설비 모니터링(중지 예정)')

    const off = await api(origin, admin, `/webhooks/${endpoint.id}`, 'PATCH', {
      label: '설비 모니터링(중지 예정)', conversationId: 'grp-hook', defaultOwnerId: '', enabled: false,
    })
    assert.equal(off.status, 200)
    assert.equal((await readJson(off)).endpoint.enabled, false)

    // 미룬 검사가 문을 열지는 않는다 — 수신 라우트가 살아 있지 않은 대화를 그대로 거절한다.
    const reopened = await api(origin, admin, `/webhooks/${endpoint.id}`, 'PATCH', { enabled: true })
    assert.equal(reopened.status, 200)
    const posted = await hook(origin, endpoint.token, { text: '사라진 방' })
    assert.equal(posted.status, 409)
    assert.equal((await posted.json()).error.code, 'WEBHOOK_CHANNEL_MISSING')

    // 새로 고르는 값은 여전히 검사한다.
    const moved = await api(origin, admin, `/webhooks/${endpoint.id}`, 'PATCH', { conversationId: 'grp-nope' })
    assert.equal(moved.status, 404)
    assert.equal((await moved.json()).error.code, 'CONVERSATION_NOT_FOUND')
  })
})

test('기본 담당자가 비활성이 되어도 이름 고치기와 끄기는 막히지 않는다 — 채널과 같은 규칙이다', async () => {
  await withApp(async ({ origin }) => {
    const admin = await login(origin, ADMIN.email)
    const endpoint = await inboundEndpoint(origin, admin, { defaultOwnerId: PARK.id })
    const stopped = await api(origin, admin, `/admin/accounts/${PARK.id}/status`, 'POST', { status: 'inactive' })
    assert.equal(stopped.status, 200, JSON.stringify(await readJson(stopped)))

    // 화면의 [저장]은 늘 defaultOwnerId를 함께 보낸다. 바뀌지 않은 그 값 때문에 이름만 고치는
    // 저장까지 400이 되면, 담당자가 퇴사한 연동은 끌 수조차 없다.
    const body = { label: '설비 모니터링(담당 없음)', conversationId: '', defaultOwnerId: PARK.id }
    const renamed = await api(origin, admin, `/webhooks/${endpoint.id}`, 'PATCH', { ...body, enabled: true })
    const renamedBody = await readJson(renamed)
    assert.equal(renamed.status, 200, JSON.stringify(renamedBody))
    assert.equal(renamedBody.endpoint.label, '설비 모니터링(담당 없음)')
    assert.equal(renamedBody.endpoint.defaultOwnerId, PARK.id, '미룬 검사가 값을 지우지도 않는다')

    const off = await api(origin, admin, `/webhooks/${endpoint.id}`, 'PATCH', { ...body, enabled: false })
    assert.equal(off.status, 200)
    assert.equal((await readJson(off)).endpoint.enabled, false)

    // 미룬 검사가 문을 열지는 않는다 — 배달마다 담당자를 다시 본다.
    assert.equal((await api(origin, admin, `/webhooks/${endpoint.id}`, 'PATCH', { enabled: true })).status, 200)
    const posted = await hook(origin, endpoint.token, { task: { title: '설비 점검' } })
    assert.equal(posted.status, 400)
    assert.equal((await posted.json()).error.code, 'WEBHOOK_OWNER_REQUIRED')

    // 새로 고르는 값은 여전히 검사한다.
    const moved = await api(origin, admin, `/webhooks/${endpoint.id}`, 'PATCH', { defaultOwnerId: 'USR-NOPE' })
    assert.equal(moved.status, 400)
    assert.equal((await moved.json()).error.code, 'WEBHOOK_OWNER_REQUIRED')
  })
})

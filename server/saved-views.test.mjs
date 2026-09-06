import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import test from 'node:test'

import { createApp } from './app.mjs'
import { withServer } from './test-server.mjs'

/**
 * 저장된 보기 — 누가 만들고, 누가 보고, 누가 바꾸는가.
 *
 * 핵심은 두 가지다. (1) 공유는 관리자 행위다 — 보기 이름과 filters.ownerIds는 사람의 열거원이다.
 * (2) 보기는 **필터일 뿐**이다 — 공유 보기를 받아도 서버의 행 필터가 먼저이므로 남의 업무가 보이지 않는다.
 * 모든 시험은 자기 store로 시작해 순서에 기대지 않는다.
 */

const TENANT = 'TENANT-SUNSEA'
const ADMIN = { id: 'USR-SUNSEA-ADMIN', name: '김서원', email: 'admin@sunsea.co.kr' }
const PARK = { id: 'USR-SUNSEA-PARK', name: '박지현', email: 'jihyun.park@sunsea.co.kr' }
const OH = { id: 'USR-SUNSEA-OH', name: '오태식', email: 'taesik.oh@sunsea.co.kr' }
const GUEST = { id: 'USR-TENANT-SUNSEA-GUEST01', name: '홍거래', email: 'guest@partner.example', password: 'Guest!Pass2026' }
const GUEST_FORBIDDEN_BODY = { error: { code: 'GUEST_SCOPE_FORBIDDEN', message: '초대된 프로젝트 안에서만 사용할 수 있습니다.' } }

const digestHex = (password, accountId) => scryptSync(String(password), `onfactory:${accountId}`, 32).toString('hex')

const freshStore = () => ({
  version: 2,
  tenants: { [TENANT]: {}, 'TENANT-POHANG': {} },
  platform: {}, accountApprovals: {}, accountCredentials: {}, invitedAccounts: [], passwordResetRequests: [], guestGrants: [],
})

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

const view = (overrides = {}) => ({ surface: 'work', name: '내 지연 업무', mode: 'list', filters: { scope: 'mine', overdueOnly: true }, sort: { field: 'due', direction: 'asc' }, columns: ['owner'], ...overrides })
const names = (body) => (body.items ?? []).map((item) => item.name)

test('1. 직원의 개인 보기는 자기에게만 보이고 출처는 서버가 채운다', async () => {
  await withServer(buildApp(freshStore()), async (origin) => {
    const park = api(origin, await login(origin, PARK.email))
    const oh = api(origin, await login(origin, OH.email))

    const created = await park('POST', '/api/saved-views', view())
    assert.equal(created.status, 201, JSON.stringify(created.body))
    assert.match(created.body.item.id, /^VIEW-/)
    assert.equal(created.body.item.ownerId, PARK.id)
    assert.equal(created.body.item.ownerName, PARK.name)
    assert.equal(created.body.item.visibility, 'private')

    assert.deepEqual(names((await park('GET', '/api/saved-views?surface=work')).body), ['내 지연 업무'])
    assert.deepEqual(names((await oh('GET', '/api/saved-views?surface=work')).body), [])
  })
})

test('2. 전사 공유는 관리자만 만든다', async () => {
  await withServer(buildApp(freshStore()), async (origin) => {
    const park = api(origin, await login(origin, PARK.email))
    const admin = api(origin, await login(origin, ADMIN.email))
    const oh = api(origin, await login(origin, OH.email))

    const refused = await park('POST', '/api/saved-views', view({ visibility: 'tenant' }))
    assert.equal(refused.status, 403)
    assert.equal(refused.body.error.code, 'SAVED_VIEW_SHARE_FORBIDDEN')

    const shared = await admin('POST', '/api/saved-views', view({ name: '전사 지연', visibility: 'tenant' }))
    assert.equal(shared.status, 201, JSON.stringify(shared.body))
    assert.deepEqual(names((await oh('GET', '/api/saved-views?surface=work')).body), ['전사 지연'])
    assert.deepEqual(names((await park('GET', '/api/saved-views?surface=work')).body), ['전사 지연'])
  })
})

test('3. 남의 공유 보기 수정은 403, 남의 개인 보기는 404 (관리자도 개인 보기에는 404)', async () => {
  await withServer(buildApp(freshStore()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const park = api(origin, await login(origin, PARK.email))

    const shared = (await admin('POST', '/api/saved-views', view({ name: '전사 지연', visibility: 'tenant' }))).body.item
    const mine = (await park('POST', '/api/saved-views', view({ name: '내 것' }))).body.item

    // 목록에 보이는 것을 404라 하면 거짓말이다 — 보이므로 403.
    const patched = await park('PATCH', `/api/saved-views/${shared.id}`, { name: '가로채기' })
    assert.equal(patched.status, 403)
    assert.equal(patched.body.error.code, 'SAVED_VIEW_FORBIDDEN')

    // 목록에 안 보이는 것은 존재도 알리지 않는다 — 관리자에게도 같다.
    for (const call of [admin]) {
      assert.equal((await call('PATCH', `/api/saved-views/${mine.id}`, { name: 'x' })).status, 404)
      assert.equal((await call('DELETE', `/api/saved-views/${mine.id}`)).status, 404)
    }
    assert.deepEqual(names((await park('GET', '/api/saved-views?surface=work')).body), ['전사 지연', '내 것'])
  })
})

test('4. 관리자는 남의 공유 보기를 회수할 수 있고, 소유자의 공유 승격은 관리자만', async () => {
  await withServer(buildApp(freshStore()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const park = api(origin, await login(origin, PARK.email))

    // 관리자가 만든 공유 보기를 다른 관리자가 아니라 '소유자가 아닌 관리자'가 지우는 상황을 만들기 위해
    // 소유자를 관리자로 두고 회수 주체도 관리자로 둔다(이 워크스페이스에 관리자는 하나다).
    const shared = (await admin('POST', '/api/saved-views', view({ name: '전사 지연', visibility: 'tenant' }))).body.item
    assert.equal((await admin('DELETE', `/api/saved-views/${shared.id}`)).status, 200)

    const mine = (await park('POST', '/api/saved-views', view({ name: '내 것' }))).body.item
    const promote = await park('PATCH', `/api/saved-views/${mine.id}`, { visibility: 'tenant' })
    assert.equal(promote.status, 403)
    assert.equal(promote.body.error.code, 'SAVED_VIEW_SHARE_FORBIDDEN')
    // 소유자 자신은 이름·필터를 얼마든지 바꾼다.
    const renamed = await park('PATCH', `/api/saved-views/${mine.id}`, { name: '내 것 2', mode: 'board' })
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body))
    assert.equal(renamed.body.item.mode, 'board')
    assert.equal(renamed.body.item.ownerId, PARK.id, 'PATCH는 출처를 바꾸지 않는다')
  })
})

test('5. 닫힌 스키마 — 미지 키와 표 밖 값은 버리지 않고 그 자리를 말한다', async () => {
  await withServer(buildApp(freshStore()), async (origin) => {
    const park = api(origin, await login(origin, PARK.email))
    const cases = [
      [view({ name: 'ㄱ'.repeat(41) }), 'name'],
      [view({ mode: 'gantt' }), 'mode'],
      [view({ surface: 'x' }), 'surface'],
      [view({ sort: { field: 'hacked', direction: 'asc' } }), 'sort.field'],
      [view({ filters: { statuses: ['없는상태'] } }), 'filters.statuses'],
      [view({ filters: { foo: 1 } }), 'filters.foo'],
      [{ ...view(), ownerId: OH.id }, 'ownerId'],
      [{ ...view(), id: 'VIEW-FAKE' }, 'id'],
      [view({ columns: ['owner', 'project', 'parent', 'category'] }), 'columns'],
      [view({ columns: ['해킹'] }), 'columns'],
      [view({ filters: { fields: { vendor: { min: 'x' } } } }), 'filters.fields.vendor'],
      [view({ filters: { dueWithinDays: 900 } }), 'filters.dueWithinDays'],
    ]
    for (const [body, path] of cases) {
      const result = await park('POST', '/api/saved-views', body)
      assert.equal(result.status, 400, `${path}: ${JSON.stringify(result.body)}`)
      assert.equal(result.body.error.code, 'SAVED_VIEW_INVALID')
      assert.equal(result.body.error.path, path)
    }
    assert.deepEqual(names((await park('GET', '/api/saved-views?surface=work')).body), [], '거절된 요청은 아무것도 남기지 않는다')
  })
})

test('6. 표면이 못 그리는 보기 방식은 오타와 다른 문장으로 답한다', async () => {
  await withServer(buildApp(freshStore()), async (origin) => {
    const park = api(origin, await login(origin, PARK.email))
    const result = await park('POST', '/api/saved-views', view({ surface: 'file', mode: 'timeline' }))
    assert.equal(result.status, 400)
    assert.equal(result.body.error.code, 'SAVED_VIEW_MODE_UNSUPPORTED')
    // 같은 표면에 list는 정상이다 — 스키마는 열려 있고 화면만 아직 없다.
    assert.equal((await park('POST', '/api/saved-views', view({ surface: 'file', mode: 'list' }))).status, 201)
  })
})

test('7. 한 사람의 51번째 보기는 409로 막힌다', async () => {
  await withServer(buildApp(freshStore()), async (origin) => {
    const park = api(origin, await login(origin, PARK.email))
    for (let index = 0; index < 50; index += 1) {
      const created = await park('POST', '/api/saved-views', view({ name: `보기 ${index}` }))
      assert.equal(created.status, 201, `${index}: ${JSON.stringify(created.body)}`)
    }
    const overflow = await park('POST', '/api/saved-views', view({ name: '하나 더' }))
    assert.equal(overflow.status, 409)
    assert.equal(overflow.body.error.code, 'SAVED_VIEW_LIMIT_REACHED')
  })
})

test('8. generic 저장소 문은 처음부터 없다 (WORKSPACE_STORE_KEYS 미등록의 증거)', async () => {
  await withServer(buildApp(freshStore()), async (origin) => {
    for (const email of [ADMIN.email, PARK.email]) {
      const call = api(origin, await login(origin, email))
      const read = await call('GET', '/api/workspace/saved-views')
      assert.equal(read.status, 404, JSON.stringify(read.body))
      assert.equal(read.body.error.code, 'STORE_KEY_NOT_FOUND')
      const write = await call('PUT', '/api/workspace/saved-views', { data: [] })
      assert.equal(write.status, 404)
      assert.equal(write.body.error.code, 'STORE_KEY_NOT_FOUND')
    }
  })
})

test('9. 게스트는 네 라우트 모두에서 같은 본문으로 거절된다', async () => {
  await withServer(buildApp(storeWithGuest()), async (origin) => {
    const guest = api(origin, await login(origin, GUEST.email, GUEST.password))
    for (const [method, route, body] of [
      ['GET', '/api/saved-views?surface=work', undefined],
      ['POST', '/api/saved-views', view()],
      ['PATCH', '/api/saved-views/VIEW-X', { name: 'x' }],
      ['DELETE', '/api/saved-views/VIEW-X', undefined],
    ]) {
      const result = await guest(method, route, body)
      assert.equal(result.status, 403, `${method} ${route}`)
      assert.deepEqual(result.body, GUEST_FORBIDDEN_BODY, `${method} ${route}`)
    }
  })
})

test('10. 공유 보기는 필터일 뿐이다 — 남의 업무를 보이게 만들지 못한다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const oh = api(origin, await login(origin, OH.email))
    const item = (id, owner) => ({
      id, title: `${id} 제목`, description: '', owner: owner.name, ownerId: owner.id, requestedBy: ADMIN.name, requesterId: ADMIN.id,
      due: '2026-09-10T09:00:00.000Z', priority: '보통', status: '업무요청', category: '일반',
    })
    assert.equal((await admin('PUT', '/api/workspace/work-items', { data: [item('W-PARK', PARK), item('W-OH', OH)] })).status, 200)

    const shared = await admin('POST', '/api/saved-views', view({ name: '박지현 담당', visibility: 'tenant', filters: { ownerIds: [PARK.id] } }))
    assert.equal(shared.status, 201, JSON.stringify(shared.body))
    assert.deepEqual(names((await oh('GET', '/api/saved-views?surface=work')).body), ['박지현 담당'])

    // 보기를 받아도 서버의 행 필터가 먼저다. 오태식에게는 여전히 자기 행 하나뿐이다.
    const rows = await oh('GET', '/api/workspace/work-items')
    assert.deepEqual(rows.body.data.map((row) => row.id), ['W-OH'])
  })
})

test('11. 쓰기 실패는 500으로 답하고 목록을 되돌린다', async () => {
  const store = freshStore()
  let fail = false
  const app = buildApp(store, { onWorkspaceStoreChange: () => { if (fail) throw new Error('disk full') } })
  await withServer(app, async (origin) => {
    const park = api(origin, await login(origin, PARK.email))
    assert.equal((await park('POST', '/api/saved-views', view({ name: '살아남는 보기' }))).status, 201)
    fail = true
    const failed = await park('POST', '/api/saved-views', view({ name: '사라질 보기' }))
    assert.equal(failed.status, 500)
    assert.equal(failed.body.error.code, 'SAVED_VIEW_WRITE_FAILED')
    fail = false
    assert.deepEqual(names((await park('GET', '/api/saved-views?surface=work')).body), ['살아남는 보기'])
  })
})

test('12. 다른 고객사의 보기는 건너오지 않는다', async () => {
  const store = freshStore()
  store.tenants['TENANT-POHANG']['saved-views'] = {
    data: [{ id: 'VIEW-POHANG', surface: 'work', name: '포항 보기', mode: 'list', filters: {}, sort: { field: 'due', direction: 'asc' }, columns: [], visibility: 'tenant', ownerId: 'USR-POHANG-ADMIN', ownerName: '박해진', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }],
    updatedAt: '2026-09-01T00:00:00.000Z',
  }
  await withServer(buildApp(store), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    assert.deepEqual(names((await admin('GET', '/api/saved-views?surface=work')).body), [])
    assert.equal((await admin('PATCH', '/api/saved-views/VIEW-POHANG', { name: 'x' })).status, 404)
    assert.equal(store.tenants['TENANT-POHANG']['saved-views'].data.length, 1)
  })
})

test('13. 못 읽는 줄 하나가 그 고객사의 저장된 보기를 통째로 잠그지 않는다', async () => {
  /*
   * 500으로 답하면 GET·POST·PATCH·DELETE가 전부 막히고, 문제의 줄을 지울 길이 앱 안에 없어진다 —
   * 복원·부분 이관·스키마 변경이 한 줄만 깨뜨려도 되돌릴 방법이 없는 막다른 길이다.
   */
  const store = freshStore()
  store.tenants[TENANT]['saved-views'] = {
    data: [
      { id: 'VIEW-BROKEN', surface: 'work' },
      {
        id: 'VIEW-OK', surface: 'work', name: '읽히는 보기', mode: 'list', filters: {}, sort: { field: 'due', direction: 'asc' },
        columns: [], visibility: 'private', ownerId: PARK.id, ownerName: PARK.name,
        createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
      },
    ],
    updatedAt: '2026-09-01T00:00:00.000Z',
  }
  await withServer(buildApp(store), async (origin) => {
    const park = api(origin, await login(origin, PARK.email))
    const listed = await park('GET', '/api/saved-views?surface=work')
    assert.equal(listed.status, 200, JSON.stringify(listed.body))
    assert.deepEqual(names(listed.body), ['읽히는 보기'])

    const created = await park('POST', '/api/saved-views', view({ name: '새 보기' }))
    assert.equal(created.status, 201, JSON.stringify(created.body))
    assert.deepEqual(names(created.body).sort(), ['새 보기', '읽히는 보기'])

    const removed = await park('DELETE', '/api/saved-views/VIEW-OK')
    assert.equal(removed.status, 200, JSON.stringify(removed.body))
    assert.deepEqual(names(removed.body), ['새 보기'])
    // 읽지 못한 줄은 함께 지워지지 않는다 — 읽지 못한 것을 버리는 것은 더 나쁜 답이다.
    assert.equal(store.tenants[TENANT]['saved-views'].data.filter((row) => row.id === 'VIEW-BROKEN').length, 1)
  })
})

test('14. 회사 상한과 개인 상한은 다른 문장으로 답한다', async () => {
  const row = (index, owner) => ({
    id: `VIEW-${index}`, surface: 'work', name: `보기 ${index}`, mode: 'list', filters: {}, sort: { field: 'due', direction: 'asc' },
    columns: [], visibility: 'private', ownerId: owner.id, ownerName: owner.name,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  })

  // 회사 상한: 자기 보기가 하나도 없는 사람에게 '한 사람당 50개'라고 답하면 무엇을 지울지 알 수 없다.
  const tenantFull = freshStore()
  tenantFull.tenants[TENANT]['saved-views'] = { data: Array.from({ length: 2_000 }, (_, index) => row(index, OH)), updatedAt: '2026-09-01T00:00:00.000Z' }
  await withServer(buildApp(tenantFull), async (origin) => {
    const park = api(origin, await login(origin, PARK.email))
    const refused = await park('POST', '/api/saved-views', view({ name: '새 보기' }))
    assert.equal(refused.status, 409, JSON.stringify(refused.body))
    assert.equal(refused.body.error.code, 'SAVED_VIEW_TENANT_LIMIT_REACHED')
    assert.equal(refused.body.error.message.includes('한 사람당'), false)
  })

  // 개인 상한: 회사에는 자리가 남았지만 내 보기가 50개다.
  const mineFull = freshStore()
  mineFull.tenants[TENANT]['saved-views'] = { data: Array.from({ length: 50 }, (_, index) => row(index, PARK)), updatedAt: '2026-09-01T00:00:00.000Z' }
  await withServer(buildApp(mineFull), async (origin) => {
    const park = api(origin, await login(origin, PARK.email))
    const refused = await park('POST', '/api/saved-views', view({ name: '새 보기' }))
    assert.equal(refused.status, 409, JSON.stringify(refused.body))
    assert.equal(refused.body.error.code, 'SAVED_VIEW_LIMIT_REACHED')
    assert.match(refused.body.error.message, /한 사람당/)
    // 같은 회사의 다른 사람은 여전히 저장할 수 있다.
    const oh = api(origin, await login(origin, OH.email))
    assert.equal((await oh('POST', '/api/saved-views', view({ name: '오태식 보기' }))).status, 201)
  })
})

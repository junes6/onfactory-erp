import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { createApp } from './app.mjs'
import { withServer } from './test-server.mjs'
import { hasWorkFieldValuesShape, MAX_WORK_FIELD_KEYS } from './custom-fields.mjs'

/**
 * 업무 커스텀 필드 — 정의는 관리자만, 값은 담당자·지시자·관리자.
 *
 * 가장 조심한 것은 '막다른 길'이다: 정의를 바꾼 뒤 옛 값을 가진 기존 업무의 평범한 저장이
 * 통째로 막히면 그 값을 고칠 화면에 닿지도 못한다. 보관(archived)과 required가 그 경계다.
 * 모든 시험은 자기 store로 시작해 순서에 기대지 않는다.
 */

const TENANT = 'TENANT-SUNSEA'
const ADMIN = { id: 'USR-SUNSEA-ADMIN', name: '김서원', email: 'admin@sunsea.co.kr' }
const PARK = { id: 'USR-SUNSEA-PARK', name: '박지현', email: 'jihyun.park@sunsea.co.kr' }
const OH = { id: 'USR-SUNSEA-OH', name: '오태식', email: 'taesik.oh@sunsea.co.kr' }
const GUEST = { id: 'USR-TENANT-SUNSEA-GUEST01', name: '홍거래', email: 'guest@partner.example', password: 'Guest!Pass2026' }
const GUEST_FORBIDDEN_BODY = { error: { code: 'GUEST_SCOPE_FORBIDDEN', message: '초대된 프로젝트 안에서만 사용할 수 있습니다.' } }

const DUE = '2026-09-10T09:00:00.000Z'
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

const item = (id, owner, overrides = {}) => ({
  id, title: `${id} 제목`, description: '', owner: owner.name, ownerId: owner.id, requestedBy: ADMIN.name, requesterId: ADMIN.id,
  due: DUE, priority: '보통', status: '업무요청', category: '일반', ...overrides,
})
const vendorDefinition = (overrides = {}) => ({ surface: 'work', key: 'vendor', label: '거래처', type: 'select', options: ['A', 'B'], required: false, ...overrides })
const setFields = (call, id, values) => call('POST', `/api/work-items/${id}/fields`, { values })

test('1. hasWorkFieldValuesShape는 값 타입 둘(string·number)만 받는다', () => {
  assert.equal(hasWorkFieldValuesShape({}), true)
  assert.equal(hasWorkFieldValuesShape({ vendor: 'A', amount: 3 }), true)
  assert.equal(hasWorkFieldValuesShape({ a: 'x'.repeat(200) }), true)
  for (const value of [null, undefined, [], 'x', 3]) assert.equal(hasWorkFieldValuesShape(value), false, String(value))
  for (const bad of [{ '대문자Key': 'x' }, { '한글': 'x' }, { '1a': 'x' }, { A: 'x' }, { 'a-b': 'x' }]) {
    assert.equal(hasWorkFieldValuesShape(bad), false, JSON.stringify(bad))
  }
  for (const bad of [{ a: [1] }, { a: true }, { a: null }, { a: NaN }, { a: {} }, { a: 'x'.repeat(201) }]) {
    assert.equal(hasWorkFieldValuesShape(bad), false, JSON.stringify(bad))
  }
  const tooMany = Object.fromEntries(Array.from({ length: MAX_WORK_FIELD_KEYS + 1 }, (_, index) => [`k${index}`, 'x']))
  assert.equal(hasWorkFieldValuesShape(tooMany), false)
})

test('2. 정의는 관리자만 만들고, 직원도 읽는다(라벨을 그려야 한다)', async () => {
  await withServer(buildApp(freshStore()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const park = api(origin, await login(origin, PARK.email))

    const created = await admin('POST', '/api/custom-fields', vendorDefinition())
    assert.equal(created.status, 201, JSON.stringify(created.body))
    assert.match(created.body.item.id, /^CF-/)
    assert.equal(created.body.item.archivedAt, null)

    const refused = await park('POST', '/api/custom-fields', vendorDefinition({ key: 'other' }))
    assert.equal(refused.status, 403)
    assert.equal(refused.body.error.code, 'TENANT_ADMIN_REQUIRED')

    const read = await park('GET', '/api/custom-fields?surface=work')
    assert.equal(read.status, 200)
    assert.deepEqual(read.body.items.map((row) => row.key), ['vendor'])
  })
})

test('3. 정의 음성 — 키 형식·중복·타입·상한', async () => {
  await withServer(buildApp(freshStore()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    assert.equal((await admin('POST', '/api/custom-fields', vendorDefinition())).status, 201)

    for (const key of ['1abc', '한글', 'Vendor', 'a'.repeat(41), '']) {
      const result = await admin('POST', '/api/custom-fields', vendorDefinition({ key }))
      assert.equal(result.body.error.code, 'CUSTOM_FIELD_KEY_INVALID', `${key}: ${JSON.stringify(result.body)}`)
    }
    assert.equal((await admin('POST', '/api/custom-fields', vendorDefinition())).body.error.code, 'CUSTOM_FIELD_KEY_DUPLICATE')
    assert.equal((await admin('POST', '/api/custom-fields', vendorDefinition({ key: 'note', label: 'ㄱ'.repeat(21), type: 'text' }))).body.error.code, 'CUSTOM_FIELD_INVALID')
    assert.equal((await admin('POST', '/api/custom-fields', vendorDefinition({ key: 'proof', type: 'file' }))).body.error.code, 'CUSTOM_FIELD_INVALID')
    assert.equal((await admin('POST', '/api/custom-fields', vendorDefinition({ key: 'many', options: Array.from({ length: 21 }, (_, i) => `O${i}`) }))).body.error.code, 'CUSTOM_FIELD_INVALID')
    assert.equal((await admin('POST', '/api/custom-fields', vendorDefinition({ key: 'empty', options: [] }))).body.error.code, 'CUSTOM_FIELD_INVALID')

    for (let index = 1; index < 50; index += 1) {
      const created = await admin('POST', '/api/custom-fields', vendorDefinition({ key: `field_${index}`, type: 'text', options: undefined }))
      assert.equal(created.status, 201, `${index}: ${JSON.stringify(created.body)}`)
    }
    const overflow = await admin('POST', '/api/custom-fields', vendorDefinition({ key: 'one_more', type: 'text', options: undefined }))
    assert.equal(overflow.status, 409)
    assert.equal(overflow.body.error.code, 'CUSTOM_FIELD_LIMIT_REACHED')
  })
})

test('4. key·type은 불변이고, 보관해도 정의와 값은 남는다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const definition = (await admin('POST', '/api/custom-fields', vendorDefinition())).body.item
    assert.equal((await admin('PUT', '/api/workspace/work-items', { data: [item('W1', PARK, { fields: { vendor: 'A' } })] })).status, 200)

    assert.equal((await admin('PATCH', `/api/custom-fields/${definition.id}`, { key: 'supplier' })).body.error.code, 'CUSTOM_FIELD_KEY_IMMUTABLE')
    assert.equal((await admin('PATCH', `/api/custom-fields/${definition.id}`, { type: 'text' })).body.error.code, 'CUSTOM_FIELD_TYPE_IMMUTABLE')

    const archived = await admin('PATCH', `/api/custom-fields/${definition.id}`, { archivedAt: new Date().toISOString() })
    assert.equal(archived.status, 200, JSON.stringify(archived.body))
    assert.notEqual(archived.body.item.archivedAt, null)
    // 보관해도 목록에서 사라지지 않는다 — 옛 값의 라벨을 그릴 곳이 필요하다.
    assert.deepEqual((await admin('GET', '/api/custom-fields?surface=work')).body.items.map((row) => row.key), ['vendor'])
    assert.equal(store.tenants[TENANT]['work-items'].data[0].fields.vendor, 'A', '값은 그대로 남는다')
    // 보관된 key는 다시 쓸 수 없다 — 재사용하면 옛 payload 값이 새 정의의 값처럼 되살아난다.
    assert.equal((await admin('POST', '/api/custom-fields', vendorDefinition())).body.error.code, 'CUSTOM_FIELD_KEY_DUPLICATE')
  })
})

test('5. 쓰이고 있는 선택지는 지울 수 없고, 값이 있는 정의는 삭제되지 않는다', async () => {
  await withServer(buildApp(freshStore()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const definition = (await admin('POST', '/api/custom-fields', vendorDefinition())).body.item
    assert.equal((await admin('PUT', '/api/workspace/work-items', { data: [item('W1', PARK, { fields: { vendor: 'A' } }), item('W2', OH, { fields: { vendor: 'A' } })] })).status, 200)

    const removed = await admin('PATCH', `/api/custom-fields/${definition.id}`, { options: ['B'] })
    assert.equal(removed.status, 409)
    assert.equal(removed.body.error.code, 'CUSTOM_FIELD_OPTION_IN_USE')
    assert.equal(removed.body.error.option, 'A')
    assert.equal(removed.body.error.count, 2)

    const deleted = await admin('DELETE', `/api/custom-fields/${definition.id}`)
    assert.equal(deleted.status, 409)
    assert.equal(deleted.body.error.code, 'CUSTOM_FIELD_IN_USE')
    assert.equal(deleted.body.error.count, 2)
    assert.match(deleted.body.error.message, /보관 처리하면/)

    // 값을 걷어내면 삭제된다.
    assert.equal((await admin('PUT', '/api/workspace/work-items', { data: [item('W1', PARK), item('W2', OH)] })).status, 200)
    assert.equal((await admin('DELETE', `/api/custom-fields/${definition.id}`)).status, 200)
    assert.deepEqual((await admin('GET', '/api/custom-fields?surface=work')).body.items, [])
  })
})

test('6. 배열 저장(관리자 PUT)은 정의와 대조한다', async () => {
  await withServer(buildApp(storeWithGuest()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    for (const definition of [
      vendorDefinition(),
      vendorDefinition({ key: 'amount', label: '금액', type: 'number', options: undefined }),
      vendorDefinition({ key: 'ship_on', label: '출고일', type: 'date', options: undefined }),
      vendorDefinition({ key: 'reviewer', label: '검토자', type: 'person', options: undefined }),
    ]) {
      assert.equal((await admin('POST', '/api/custom-fields', definition)).status, 201, definition.key)
    }
    const put = (fields) => admin('PUT', '/api/workspace/work-items', { data: [item('W1', PARK, fields ? { fields } : {})] })

    assert.equal((await put({ vendor: 'A', amount: 5, ship_on: '2026-09-01', reviewer: OH.id })).status, 200)
    const round = await admin('GET', '/api/workspace/work-items')
    assert.deepEqual(round.body.data[0].fields, { vendor: 'A', amount: 5, ship_on: '2026-09-01', reviewer: OH.id })

    const cases = [
      [{ vendor: 'C' }, 'CUSTOM_FIELD_OPTION', 'vendor'],
      [{ ghost: 'x' }, 'CUSTOM_FIELD_UNKNOWN', 'ghost'],
      [{ amount: '5' }, 'CUSTOM_FIELD_TYPE', 'amount'],
      [{ ship_on: '2026-9-1' }, 'CUSTOM_FIELD_TYPE', 'ship_on'],
      [{ ship_on: '2026-13-99' }, 'CUSTOM_FIELD_TYPE', 'ship_on'],
      [{ reviewer: 'USR-POHANG-ADMIN' }, 'CUSTOM_FIELD_PERSON', 'reviewer'],
      [{ reviewer: GUEST.id }, 'CUSTOM_FIELD_PERSON', 'reviewer'],
    ]
    for (const [fields, code, key] of cases) {
      const result = await put(fields)
      assert.equal(result.status, 400, `${key}: ${JSON.stringify(result.body)}`)
      assert.equal(result.body.error.code, code, JSON.stringify(result.body))
      assert.equal(result.body.error.key, key)
      assert.equal(result.body.error.itemId, 'W1')
    }
  })
})

test('7. 보관 뒤 두 갈래 — 기존 값은 통과하고 새 값만 막힌다', async () => {
  await withServer(buildApp(freshStore()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const definition = (await admin('POST', '/api/custom-fields', vendorDefinition())).body.item
    assert.equal((await admin('POST', '/api/custom-fields', vendorDefinition({ key: 'note', label: '메모', type: 'text', options: undefined }))).status, 201)
    assert.equal((await admin('PUT', '/api/workspace/work-items', { data: [item('W1', PARK, { fields: { vendor: 'A' } }), item('W2', OH)] })).status, 200)
    assert.equal((await admin('PATCH', `/api/custom-fields/${definition.id}`, { archivedAt: new Date().toISOString() })).status, 200)

    // (a) 이미 그 값을 가진 행의 다른 필드만 바꾸는 저장은 통과한다 — 막다른 길을 만들지 않는다.
    const kept = await admin('PUT', '/api/workspace/work-items', {
      data: [item('W1', PARK, { fields: { vendor: 'A', note: '변경' } }), item('W2', OH)],
    })
    assert.equal(kept.status, 200, JSON.stringify(kept.body))

    // (b) 같은 키에 새 값을 넣는 저장은 막힌다 — 보관을 무조건 통과시키면 배열 PUT이 주입 경로가 된다.
    for (const fields of [{ vendor: 'B' }, { vendor: 'A' }]) {
      const injected = await admin('PUT', '/api/workspace/work-items', { data: [item('W1', PARK, { fields: { vendor: 'A', note: '변경' } }), item('W2', OH, { fields })] })
      assert.equal(injected.status, 400, JSON.stringify(injected.body))
      assert.equal(injected.body.error.code, 'CUSTOM_FIELD_ARCHIVED')
      assert.equal(injected.body.error.itemId, 'W2')
    }
  })
})

test('8. required는 배열 저장을 막지 않는다 (반복 규칙 실체화가 조용히 사라지지 않는다)', async () => {
  await withServer(buildApp(freshStore()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const definition = (await admin('POST', '/api/custom-fields', vendorDefinition())).body.item
    assert.equal((await admin('PUT', '/api/workspace/work-items', { data: [item('W1', PARK), item('W2', OH), item('W3', PARK)] })).status, 200)
    assert.equal((await admin('PATCH', `/api/custom-fields/${definition.id}`, { required: true })).status, 200)

    const saved = await admin('PUT', '/api/workspace/work-items', { data: [item('W1', PARK, { category: '변경' }), item('W2', OH), item('W3', PARK)] })
    assert.equal(saved.status, 200, '값 없는 기존 행이 required 때문에 저장 불가가 되면 안 된다')
  })
})

test('9. /fields — 담당자·지시자·관리자만, 완료 보고 뒤에는 409', async () => {
  await withServer(buildApp(freshStore()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const park = api(origin, await login(origin, PARK.email))
    const oh = api(origin, await login(origin, OH.email))
    assert.equal((await admin('POST', '/api/custom-fields', vendorDefinition())).status, 201)
    assert.equal((await admin('PUT', '/api/workspace/work-items', {
      data: [item('W1', PARK), item('W-WAIT', PARK, { status: '결재대기' }), item('W-DONE', PARK, { status: '결재완료' })],
    })).status, 200)

    assert.equal((await setFields(park, 'W1', { vendor: 'A' })).status, 200, '담당자')
    assert.equal((await setFields(admin, 'W1', { vendor: 'B' })).status, 200, '지시자이자 관리자')
    const third = await setFields(oh, 'W1', { vendor: 'A' })
    assert.equal(third.status, 403)
    assert.equal(third.body.error.code, 'WORK_FIELD_FORBIDDEN')

    for (const id of ['W-WAIT', 'W-DONE']) {
      const locked = await setFields(park, id, { vendor: 'A' })
      assert.equal(locked.status, 409, id)
      assert.equal(locked.body.error.code, 'WORK_FIELD_LOCKED')
    }
    assert.equal((await setFields(park, 'NOPE', { vendor: 'A' })).status, 404)
  })
})

test('10. /fields — null은 지우기이고, 마지막 키가 사라지면 fields 키 자체가 없어진다', async () => {
  await withServer(buildApp(freshStore()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const park = api(origin, await login(origin, PARK.email))
    assert.equal((await admin('POST', '/api/custom-fields', vendorDefinition())).status, 201)
    assert.equal((await admin('POST', '/api/custom-fields', vendorDefinition({ key: 'note', label: '메모', type: 'text', options: undefined }))).status, 201)
    assert.equal((await admin('PUT', '/api/workspace/work-items', { data: [item('W1', PARK)] })).status, 200)

    assert.deepEqual((await setFields(park, 'W1', { vendor: 'A', note: '메모다' })).body.item.fields, { vendor: 'A', note: '메모다' })
    assert.deepEqual((await setFields(park, 'W1', { note: '' })).body.item.fields, { vendor: 'A' }, '빈 문자열도 지우기다')

    const before = await admin('GET', '/api/workspace/work-items')
    const unchanged = await setFields(park, 'W1', { vendor: 'A' })
    assert.equal(unchanged.status, 200)
    assert.equal(unchanged.body.updatedAt, before.body.updatedAt, '같은 값을 다시 보내면 쓰지 않는다')

    const cleared = await setFields(park, 'W1', { vendor: null })
    assert.equal(cleared.status, 200)
    assert.equal('fields' in cleared.body.item, false, '남은 키가 없으면 fields 자체가 사라진다')
  })
})

test('11. /fields — 미정의·보관·형식·required 음성', async () => {
  await withServer(buildApp(freshStore()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const park = api(origin, await login(origin, PARK.email))
    const definition = (await admin('POST', '/api/custom-fields', vendorDefinition())).body.item
    assert.equal((await admin('POST', '/api/custom-fields', vendorDefinition({ key: 'amount', label: '금액', type: 'number', options: undefined }))).status, 201)
    assert.equal((await admin('PUT', '/api/workspace/work-items', { data: [item('W1', PARK)] })).status, 200)

    assert.equal((await setFields(park, 'W1', { ghost: 'x' })).body.error.code, 'CUSTOM_FIELD_UNKNOWN')
    assert.equal((await setFields(park, 'W1', { ghost: 'x' })).body.error.key, 'ghost')
    assert.equal((await setFields(park, 'W1', { vendor: 'C' })).body.error.code, 'CUSTOM_FIELD_OPTION')
    assert.equal((await setFields(park, 'W1', { amount: '5' })).body.error.code, 'CUSTOM_FIELD_TYPE')
    assert.equal((await park('POST', '/api/work-items/W1/fields', { values: [] })).body.error.code, 'WORK_FIELD_INVALID')
    const tooMany = Object.fromEntries(Array.from({ length: MAX_WORK_FIELD_KEYS + 1 }, (_, index) => [`k${index}`, 'x']))
    assert.equal((await setFields(park, 'W1', tooMany)).body.error.code, 'CUSTOM_FIELD_UNKNOWN', '정의 없는 키가 먼저 걸린다')

    // required 필드의 이미 있는 값은 비울 수 없다. 없던 값은 계속 없어도 된다.
    assert.equal((await setFields(park, 'W1', { vendor: 'A' })).status, 200)
    assert.equal((await admin('PATCH', `/api/custom-fields/${definition.id}`, { required: true })).status, 200)
    const cleared = await setFields(park, 'W1', { vendor: null })
    assert.equal(cleared.status, 400)
    assert.equal(cleared.body.error.code, 'CUSTOM_FIELD_REQUIRED')
    assert.equal(cleared.body.error.key, 'vendor')

    // 보관된 정의에는 새 값을 넣을 수 없다 — 활성 정의만이 입력 대상이다.
    assert.equal((await admin('PATCH', `/api/custom-fields/${definition.id}`, { archivedAt: new Date().toISOString() })).status, 200)
    assert.equal((await setFields(park, 'W1', { vendor: 'B' })).body.error.code, 'CUSTOM_FIELD_UNKNOWN')
  })
})

test('12. 직원의 generic PUT으로 fields를 바꾸면 403 (전용 라우트만이 문이다)', async () => {
  await withServer(buildApp(freshStore()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const park = api(origin, await login(origin, PARK.email))
    assert.equal((await admin('POST', '/api/custom-fields', vendorDefinition())).status, 201)
    assert.equal((await admin('PUT', '/api/workspace/work-items', { data: [item('W1', PARK)] })).status, 200)

    const forged = await park('PUT', '/api/workspace/work-items', { data: [item('W1', PARK, { fields: { vendor: 'A' } })] })
    assert.equal(forged.status, 403)
    assert.equal(forged.body.error.code, 'WORK_ITEM_TRANSITION_FORBIDDEN')

    // 관리자 PUT이라도 모양이 틀리면 배열 검증이 먼저 거절한다.
    for (const fields of [{ a: true }, { a: null }, { 'A': 'x' }]) {
      const bad = await admin('PUT', '/api/workspace/work-items', { data: [item('W1', PARK, { fields })] })
      assert.equal(bad.status, 400, JSON.stringify(bad.body))
      assert.equal(bad.body.error.code, 'INVALID_WORK_ITEMS')
    }
  })
})

test('13. generic 저장소 문은 처음부터 없다', async () => {
  await withServer(buildApp(freshStore()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    assert.equal((await admin('GET', '/api/workspace/custom-fields')).body.error.code, 'STORE_KEY_NOT_FOUND')
    assert.equal((await admin('PUT', '/api/workspace/custom-fields', { data: [] })).body.error.code, 'STORE_KEY_NOT_FOUND')
  })
})

test('14. 게스트는 정의 라우트와 /fields 모두에서 거절된다', async () => {
  await withServer(buildApp(storeWithGuest()), async (origin) => {
    const guest = api(origin, await login(origin, GUEST.email, GUEST.password))
    for (const [method, route, body] of [
      ['GET', '/api/custom-fields?surface=work', undefined],
      ['POST', '/api/custom-fields', vendorDefinition()],
      ['PATCH', '/api/custom-fields/CF-X', { label: 'x' }],
      ['DELETE', '/api/custom-fields/CF-X', undefined],
      ['POST', '/api/work-items/W1/fields', { values: { vendor: 'A' } }],
    ]) {
      const result = await guest(method, route, body)
      assert.equal(result.status, 403, `${method} ${route}`)
      assert.deepEqual(result.body, GUEST_FORBIDDEN_BODY, `${method} ${route}`)
    }
  })
})

test('15. 쓰기 실패는 500으로 답하고 store를 되돌린다', async () => {
  const store = freshStore()
  let fail = false
  const app = buildApp(store, { onWorkspaceStoreChange: () => { if (fail) throw new Error('disk full') } })
  await withServer(app, async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const park = api(origin, await login(origin, PARK.email))
    assert.equal((await admin('POST', '/api/custom-fields', vendorDefinition())).status, 201)
    assert.equal((await admin('PUT', '/api/workspace/work-items', { data: [item('W1', PARK)] })).status, 200)

    fail = true
    const definitionFailed = await admin('POST', '/api/custom-fields', vendorDefinition({ key: 'note', label: '메모', type: 'text', options: undefined }))
    assert.equal(definitionFailed.status, 500)
    assert.equal(definitionFailed.body.error.code, 'CUSTOM_FIELD_WRITE_FAILED')
    const valueFailed = await setFields(park, 'W1', { vendor: 'A' })
    assert.equal(valueFailed.status, 500)
    assert.equal(valueFailed.body.error.code, 'WORK_FIELD_WRITE_FAILED')

    fail = false
    assert.deepEqual((await admin('GET', '/api/custom-fields?surface=work')).body.items.map((row) => row.key), ['vendor'])
    assert.equal('fields' in (await admin('GET', '/api/workspace/work-items')).body.data[0], false)
  })
})

test('16. 순서 버튼은 실제로 목록을 움직인다 — 자리 번호는 서버가 다시 매긴다', async () => {
  await withServer(buildApp(freshStore()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const created = []
    for (const key of ['alpha', 'bravo', 'charlie']) {
      const response = await admin('POST', '/api/custom-fields', vendorDefinition({ key, label: key, type: 'text', options: undefined }))
      assert.equal(response.status, 201, key)
      created.push(response.body.item)
    }
    const listed = async () => (await admin('GET', '/api/custom-fields?surface=work')).body.items
    const keys = async () => (await listed()).map((definition) => definition.key)
    assert.deepEqual(await keys(), ['alpha', 'bravo', 'charlie'])
    assert.deepEqual(created.map((definition) => definition.position), [0, 1, 2])

    /*
     * 화면이 보내는 그 본문이다: '한 칸 위'는 이웃의 자리 번호로 말한다.
     * position ± 1을 보내던 동안에는 이웃과 번호가 같아지고 ordered()의 다음 기준(createdAt)이 이겨서
     * 두 번 눌러야 한 칸이 움직였고, 맨 위로는 영원히 갈 수 없었다.
     */
    const up = await admin('PATCH', `/api/custom-fields/${created[2].id}`, { position: created[1].position })
    assert.equal(up.status, 200, JSON.stringify(up.body))
    assert.deepEqual(await keys(), ['alpha', 'charlie', 'bravo'], '한 번 눌러 한 칸 움직인다')
    assert.equal(up.body.item.position, 1, '응답의 item도 다시 매긴 자리를 싣는다')
    // 자리 번호는 언제나 0..n-1로 유일하다 — 겹치기 시작하면 다음 클릭이 한 칸이 아닌 곳으로 간다.
    assert.deepEqual((await listed()).map((definition) => definition.position), [0, 1, 2])

    const rows = await listed()
    const down = await admin('PATCH', `/api/custom-fields/${rows[0].id}`, { position: rows[1].position })
    assert.equal(down.status, 200)
    assert.deepEqual(await keys(), ['charlie', 'alpha', 'bravo'])

    // 보관된 항목이 사이에 끼어 있어도 화면에 보이는 만큼만 움직인다(이웃의 번호로 말하기 때문이다).
    const middle = (await listed())[1]
    assert.equal((await admin('PATCH', `/api/custom-fields/${middle.id}`, { archivedAt: new Date().toISOString() })).status, 200)
    const active = (await listed()).filter((definition) => !definition.archivedAt)
    assert.deepEqual(active.map((definition) => definition.key), ['charlie', 'bravo'])
    assert.equal((await admin('PATCH', `/api/custom-fields/${active[1].id}`, { position: active[0].position })).status, 200)
    assert.deepEqual((await listed()).filter((definition) => !definition.archivedAt).map((definition) => definition.key), ['bravo', 'charlie'])
  })
})

test('17. 이미 저장된 값 하나가 배열 전체의 저장을 막지 않는다', async () => {
  /*
   * 정의가 사라지거나(옛 값) 사람 항목의 계정이 회사를 떠나면, 손대지도 않은 행 하나 때문에
   * 관리자의 평범한 배열 저장이 400으로 막혔다 — 그 값을 고칠 화면에 닿기 전에 문이 닫힌다.
   * 이미 저장돼 있던 값은 이 문을 한 번 통과한 값이므로 다시 판정하지 않는다.
   */
  const store = freshStore()
  store.tenants[TENANT]['custom-fields'] = {
    data: [{
      id: 'CF-OLD', surface: 'work', key: 'reviewer', label: '검토자', type: 'person', options: [], required: false,
      archivedAt: null, position: 0, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    }],
    updatedAt: '2026-09-01T00:00:00.000Z',
  }
  store.tenants[TENANT]['work-items'] = {
    data: [item('WK-OLD', PARK, { fields: { reviewer: 'USR-SUNSEA-GONE', ghost: '사라진 정의의 값' } })],
    updatedAt: '2026-09-01T00:00:00.000Z',
  }
  await withServer(buildApp(store), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const stored = (await admin('GET', '/api/workspace/work-items')).body.data
    assert.deepEqual(stored[0].fields, { reviewer: 'USR-SUNSEA-GONE', ghost: '사라진 정의의 값' })

    const kept = await admin('PUT', '/api/workspace/work-items', { data: [{ ...stored[0], category: '변경' }] })
    assert.equal(kept.status, 200, JSON.stringify(kept.body))
    const added = await admin('PUT', '/api/workspace/work-items', { data: [stored[0], item('W2', OH)] })
    assert.equal(added.status, 200, '손대지 않은 행이 다른 행의 저장까지 막지 않는다')

    // 새 값·바뀐 값은 여전히 같은 문을 지난다 — 통과가 아니라 '이미 통과한 값'만 건너뛴다.
    const moved = await admin('PUT', '/api/workspace/work-items', { data: [{ ...stored[0], fields: { reviewer: 'USR-POHANG-ADMIN', ghost: '사라진 정의의 값' } }] })
    assert.equal(moved.status, 400, JSON.stringify(moved.body))
    assert.equal(moved.body.error.code, 'CUSTOM_FIELD_PERSON')
    const injected = await admin('PUT', '/api/workspace/work-items', { data: [{ ...stored[0], fields: { ...stored[0].fields, phantom: 'x' } }] })
    assert.equal(injected.status, 400)
    assert.equal(injected.body.error.code, 'CUSTOM_FIELD_UNKNOWN')
    assert.equal(injected.body.error.key, 'phantom')
  })
})

test('18. 사람 항목의 계정 목록은 두 문이 같은 함수에서 받는다', async () => {
  /*
   * 배열 PUT(app.mjs)은 operatorAwareAccounts로 판정한다. /fields가 raw accounts를 보면
   * 고객사에 들어간 플랫폼 운영자의 id가 한쪽에서는 통과하고 다른 쪽에서는 거절된다 —
   * 권한 판정은 자기가 본다고 말한 차원을 전부 읽어야 한다.
   */
  const source = await readFile(new URL('./custom-fields.mjs', import.meta.url), 'utf8')
  assert.match(source, /const accountsFor = \(auth\) =>/)
  // 라우트 안에서 raw accounts를 그대로 넘기는 자리가 하나도 없어야 한다(순수 함수의 매개변수 이름은 별개다).
  assert.equal(source.includes('accounts, request.auth.tenantId'), false)
  assert.equal((source.match(/accountsFor\(request\.auth\)/g) ?? []).length, 2, '/fields의 두 판정이 같은 목록을 본다')
  const appSource = await readFile(new URL('./app.mjs', import.meta.url), 'utf8')
  assert.match(appSource, /registerCustomFieldRoutes\(\{[\s\S]{0,400}?operatorAwareAccounts,/)
})

test('19. 값 상한 거절은 어느 칸인지와 상한을 함께 말한다', async () => {
  /*
   * 두 상한(글자 200자·한 업무 30키)만 루프 밖의 shape 검사에서 걸려,
   * 같은 루프의 다른 거절이 전부 { key }를 싣는 것과 달리 '추가 정보 형식을 확인해 주세요.' 한 줄로 끝났다.
   * 칸이 여러 개 그려진 화면에서 그 문장은 무엇을 고쳐야 하는지 아무것도 말하지 않는다.
   */
  await withServer(buildApp(freshStore()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    assert.equal((await admin('POST', '/api/custom-fields', vendorDefinition({ key: 'memo', label: '메모', type: 'text', options: undefined }))).status, 201)
    assert.equal((await admin('PUT', '/api/workspace/work-items', { data: [item('W1', PARK)] })).status, 200)
    const park = api(origin, await login(origin, PARK.email))

    const long = await setFields(park, 'W1', { memo: 'ㄱ'.repeat(201) })
    assert.equal(long.status, 400, JSON.stringify(long.body))
    assert.equal(long.body.error.code, 'WORK_FIELD_VALUE_TOO_LONG')
    assert.equal(long.body.error.key, 'memo', '다른 거절과 같은 자리에 어느 칸인지를 싣는다')
    assert.match(long.body.error.message, /200자/, '상한을 문장이 말한다')
    // 경계는 상한 그 자체다 — 200자는 통과한다.
    assert.equal((await setFields(park, 'W1', { memo: 'ㄱ'.repeat(200) })).status, 200)

    for (let index = 0; index < MAX_WORK_FIELD_KEYS; index += 1) {
      const key = `f${index}`
      assert.equal((await admin('POST', '/api/custom-fields', vendorDefinition({ key, label: key, type: 'text', options: undefined }))).status, 201, key)
    }
    // memo가 이미 한 칸을 차지하므로 30개를 더 채우면 31개가 된다.
    const values = Object.fromEntries(Array.from({ length: MAX_WORK_FIELD_KEYS }, (_, index) => [`f${index}`, 'x']))
    const tooMany = await setFields(park, 'W1', values)
    assert.equal(tooMany.status, 400, JSON.stringify(tooMany.body))
    assert.equal(tooMany.body.error.code, 'WORK_FIELD_LIMIT_REACHED')
    assert.match(tooMany.body.error.message, new RegExp(`${MAX_WORK_FIELD_KEYS}개`))
    // 상한 안이면 그대로 저장된다(29개 + memo = 30).
    delete values.f29
    assert.equal((await setFields(park, 'W1', values)).status, 200)
  })
})

test('20. 못 읽는 정의 한 줄이 항목 관리와 값 저장을 통째로 잠그지 않는다', async () => {
  /*
   * 500 DATA_INVALID로 답하면 그 고객사의 GET·POST·PATCH·DELETE와 값 저장이 전부 막히고,
   * 문제의 줄을 지울 길이 앱 안에 없어진다. definitionMap은 이미 '못 읽는 줄은 없는 것으로 친다'고
   * 판단하고 있었으므로 라우트만 그 판단과 갈려 있었다.
   */
  const store = freshStore()
  store.tenants[TENANT]['custom-fields'] = {
    data: [
      { id: 'CF-BROKEN', surface: 'work' },
      {
        id: 'CF-OK', surface: 'work', key: 'vendor', label: '거래처', type: 'select', options: ['A', 'B'], required: false,
        archivedAt: null, position: 0, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
      },
    ],
    updatedAt: '2026-09-01T00:00:00.000Z',
  }
  store.tenants[TENANT]['work-items'] = { data: [item('W1', PARK)], updatedAt: '2026-09-01T00:00:00.000Z' }
  await withServer(buildApp(store), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const park = api(origin, await login(origin, PARK.email))

    const listed = await admin('GET', '/api/custom-fields?surface=work')
    assert.equal(listed.status, 200, JSON.stringify(listed.body))
    assert.deepEqual(listed.body.items.map((definition) => definition.key), ['vendor'])
    assert.equal((await setFields(park, 'W1', { vendor: 'A' })).status, 200)

    const created = await admin('POST', '/api/custom-fields', vendorDefinition({ key: 'memo', label: '메모', type: 'text', options: undefined }))
    assert.equal(created.status, 201, JSON.stringify(created.body))
    assert.deepEqual(created.body.items.map((definition) => definition.key), ['vendor', 'memo'])
    // 읽지 못한 줄은 지우지 않는다 — 읽지 못한 것을 버리는 것은 더 나쁜 답이다.
    assert.equal(store.tenants[TENANT]['custom-fields'].data.filter((row) => row.id === 'CF-BROKEN').length, 1)
  })
})

test("21. 빈 글자는 값이 아니다 — 배열 PUT이 거절하고, 세는 쪽도 세지 않는다", async () => {
  /*
   * '값 없음'은 한 가지여야 한다(키 없음). 빈 문자열을 값으로 받아 주면 화면에는 아무것도 안 보이는데
   * countFieldUsage가 1로 세어, 관리자는 지울 값이 보이지 않는 채로 그 정의를 영영 삭제할 수 없게 된다.
   * /fields는 ''를 '지우기'로 이미 소비하므로, 갈려 있던 문은 배열 PUT 하나였다.
   */
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const definition = (await admin('POST', '/api/custom-fields', { surface: 'work', key: 'memo', label: '메모', type: 'text' })).body.item
    assert.ok(definition, '정의를 만들지 못하면 아래 단언이 뜻을 잃는다')

    for (const blank of ['', '   ']) {
      const saved = await admin('PUT', '/api/workspace/work-items', { data: [item('W1', PARK, { fields: { memo: blank } })] })
      assert.equal(saved.status, 400, JSON.stringify(saved.body))
      assert.equal(saved.body.error.code, 'CUSTOM_FIELD_TYPE')
      assert.equal(saved.body.error.key, 'memo')
    }
    // 값이 있는 글자는 그대로 통과한다 — 좁힌 것은 '빈 값' 하나뿐이다.
    assert.equal((await admin('PUT', '/api/workspace/work-items', { data: [item('W1', PARK, { fields: { memo: ' 3동 라인 ' } })] })).status, 200)
  })

  // 좁히기 전에 저장된 줄이 남아 있을 수 있다. 그 줄이 삭제를 막으면 막다른 길은 그대로다.
  const legacy = freshStore()
  legacy.tenants[TENANT]['custom-fields'] = {
    data: [{
      id: 'CF-MEMO', surface: 'work', key: 'memo', label: '메모', type: 'text', options: [], required: false,
      archivedAt: null, position: 0, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    }],
    updatedAt: '2026-09-01T00:00:00.000Z',
  }
  legacy.tenants[TENANT]['work-items'] = { data: [item('W1', PARK, { fields: { memo: '' } })], updatedAt: '2026-09-01T00:00:00.000Z' }
  await withServer(buildApp(legacy), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const deleted = await admin('DELETE', '/api/custom-fields/CF-MEMO')
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body))
    assert.deepEqual((await admin('GET', '/api/custom-fields?surface=work')).body.items, [])
  })
})

test('22. 보관된 항목의 남은 값은 지울 수 있고, 삭제 거절은 이미 한 일을 다시 시키지 않는다', async () => {
  /*
   * 보관 뒤에 남은 값을 지울 길이 없으면 그 정의는 영원히 409다 — 게다가 그 409가 하는 말이
   * '보관 처리하면 …'이어서, 관리자는 이미 한 일을 다시 하라는 답만 받는다.
   * 값을 **넣는** 문은 여전히 활성 정의뿐이다(보관된 항목에 새 값이 들어오면 안 된다).
   */
  await withServer(buildApp(freshStore()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const park = api(origin, await login(origin, PARK.email))
    const definition = (await admin('POST', '/api/custom-fields', vendorDefinition({ required: true }))).body.item
    assert.equal((await admin('PUT', '/api/workspace/work-items', { data: [item('W1', PARK)] })).status, 200)
    assert.equal((await setFields(park, 'W1', { vendor: 'A' })).status, 200)

    assert.equal((await admin('PATCH', `/api/custom-fields/${definition.id}`, { archivedAt: '2026-09-05T00:00:00.000Z' })).status, 200)
    const blocked = await admin('DELETE', `/api/custom-fields/${definition.id}`)
    assert.equal(blocked.status, 409)
    assert.equal(blocked.body.error.code, 'CUSTOM_FIELD_IN_USE')
    assert.equal(blocked.body.error.count, 1)
    assert.match(blocked.body.error.message, /보관을 해제하고/)
    assert.doesNotMatch(blocked.body.error.message, /보관 처리하면/, '이미 보관한 사람에게 보관하라고 답하지 않는다')

    // 보관된 항목에 새 값은 여전히 못 넣는다.
    const rejected = await setFields(park, 'W1', { vendor: 'B' })
    assert.equal(rejected.status, 400)
    assert.equal(rejected.body.error.code, 'CUSTOM_FIELD_UNKNOWN')
    assert.equal(rejected.body.error.key, 'vendor')

    // 지우는 것은 된다. required였지만 보관된 항목의 required는 더 이상 입력 규칙이 아니다.
    const cleared = await setFields(park, 'W1', { vendor: null })
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body))
    assert.equal(cleared.body.item.fields, undefined, "남은 키가 없으면 fields 자체가 사라진다 — '값 없음'은 한 가지다")

    const removed = await admin('DELETE', `/api/custom-fields/${definition.id}`)
    assert.equal(removed.status, 200, JSON.stringify(removed.body))
    assert.deepEqual((await admin('GET', '/api/custom-fields?surface=work')).body.items, [])
  })
})

test('23. 활성 required 항목의 있는 값은 여전히 비울 수 없다', async () => {
  // 위 시험이 연 문이 required의 입력 시점 규칙까지 열어 버리면 안 된다 — 열린 것은 '보관된 항목' 하나다.
  await withServer(buildApp(freshStore()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const park = api(origin, await login(origin, PARK.email))
    await admin('POST', '/api/custom-fields', vendorDefinition({ required: true }))
    assert.equal((await admin('PUT', '/api/workspace/work-items', { data: [item('W1', PARK)] })).status, 200)
    assert.equal((await setFields(park, 'W1', { vendor: 'A' })).status, 200)

    const refused = await setFields(park, 'W1', { vendor: '' })
    assert.equal(refused.status, 400)
    assert.equal(refused.body.error.code, 'CUSTOM_FIELD_REQUIRED')
    assert.equal(refused.body.error.key, 'vendor')
  })
})

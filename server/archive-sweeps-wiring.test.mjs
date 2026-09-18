import assert from 'node:assert/strict'
import test from 'node:test'

import { createApp } from './app.mjs'
import { HOT_LIMITS } from './archive-sweeps.mjs'
import { withServer } from './test-server.mjs'

/**
 * P0-3b 배선: 쓰는 자리가 더는 자르지 않고, 넘친 기록은 보관함으로 가며, 읽는 화면은 보관함까지 이어 읽는다.
 */

function memoryStorage() {
  const files = new Map()
  return {
    files,
    backend: 'local',
    async put(key, body) { files.set(key, Buffer.from(body)); return { key, size: body.length } },
    async get(key) {
      const value = files.get(key)
      if (!value) { const error = new Error('없음'); error.code = 'STORAGE_NOT_FOUND'; throw error }
      return value
    },
    async exists(key) { return files.has(key) },
    async delete(key) { return files.delete(key) },
    async getSignedUrl(_key, options = {}) { return options.fallbackUrl ?? null },
  }
}

const freshStore = () => ({ version: 2, tenants: { 'TENANT-SUNSEA': {}, 'TENANT-POHANG': {} }, platform: {}, accountApprovals: {}, accountCredentials: {}, invitedAccounts: [], passwordResetRequests: [], guestGrants: [] })

async function login(origin, email, workspace = 'tenant') {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace, email, password: 'demo1234' }),
  })
  assert.equal(response.status, 200)
  const account = (await response.json()).account
  const cookie = response.headers.get('set-cookie').split(';')[0]
  return { account, headers: { cookie, ...(account.tenantId ? { 'x-workspace-identity': `${account.tenantId}:${account.id}` } : {}), 'content-type': 'application/json' } }
}

const until = async (check, { timeout = 3_000 } = {}) => {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

test('감사 기록은 쓰는 자리에서 잘리지 않고, 크게 넘치면 곧바로 보관함으로 간다 — 운영사 접속 이력은 보관분까지 이어 읽는다', async () => {
  const store = freshStore()
  // 5,000건이 이미 차 있다(옛 상한). 새것이 앞. 짝수는 선해(SUNSEA), 홀수는 포항.
  store.platform.auditEvents = Array.from({ length: 5_000 }, (_, index) => ({
    id: `AUD-SEED-${String(index).padStart(5, '0')}`,
    tenantId: index % 2 ? 'TENANT-POHANG' : 'TENANT-SUNSEA',
    at: new Date(Date.UTC(2026, 8, 1) - index * 60_000).toISOString(),
    event: '운영자 워크스페이스 조회', scope: '업무', actor: '운영자', result: '완료', reference: '—',
  }))
  const app = createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {}, documentStorage: memoryStorage() })
  await withServer(app, async (origin) => {
    // 운영자가 들어오면 감사 기록이 한 건 더 붙는다 — 전에는 여기서 가장 오래된 한 건이 말없이 지워졌다.
    const operator = await login(origin, 'operator@onfactory.co.kr', 'platform')
    assert.equal((await fetch(`${origin}/api/platform/tenants/TENANT-SUNSEA/enter`, { method: 'POST', headers: { cookie: operator.headers.cookie } })).status, 200)
    // 넘침(> 5,000)을 본 정리기가 다음 틱에 돌아 뜨거운 배열을 4,000건으로 줄이고 나머지를 보관한다.
    // 정리 뒤에도 운영자의 요청이 감사 기록을 몇 줄 더 붙일 수 있다 — 4,000건 언저리면 정리된 것이다.
    assert.ok(await until(() => store.platform.auditEvents.length <= HOT_LIMITS.audit + 10), `정리 후 ${store.platform.auditEvents.length}건`)
    const oldest = await app.locals.archive.list('TENANT-POHANG', 'audit-events', { query: 'AUD-SEED-04999', limit: 1 })
    assert.equal(oldest.total, 1, '가장 오래된 기록은 지워지지 않고 보관함에 있다')
    const isOperator = (event) => event.tenantId === 'TENANT-SUNSEA' && event.event.startsWith('운영자')
    const sunseaArchived = await app.locals.archive.list('TENANT-SUNSEA', 'audit-events', { limit: 1, filter: isOperator })
    const everywhere = new Set(store.platform.auditEvents.map((event) => event.id))
    for (const tenantId of ['TENANT-SUNSEA', 'TENANT-POHANG', '_platform']) {
      for (let offset = 0; ; offset += 200) {
        const page = await app.locals.archive.list(tenantId, 'audit-events', { offset, limit: 200 })
        for (const row of page.rows) {
          assert.ok(!everywhere.has(row.id), `${row.id}는 뜨거운 쪽과 보관함 두 곳에 있지 않다`)
          everywhere.add(row.id)
        }
        if (offset + 200 >= page.total) break
      }
    }
    for (let index = 0; index < 5_000; index += 1) {
      assert.ok(everywhere.has(`AUD-SEED-${String(index).padStart(5, '0')}`), `AUD-SEED-${index}가 빠짐없이 남았다`)
    }

    // 고객사 관리자: 30건씩 넘겨 끝까지 읽으면 뜨거운 쪽 + 보관분이 새것부터 한 줄로 이어진다.
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const first = await (await fetch(`${origin}/api/operator-access-log?limit=30`, { headers: admin.headers })).json()
    const expected = store.platform.auditEvents.filter(isOperator).length + sunseaArchived.total
    assert.equal(first.total, expected, '총계는 보관분까지 센다')
    assert.equal(first.events.length, 30)
    const seen = [...first.events]
    while (seen.length < first.total) {
      const page = await (await fetch(`${origin}/api/operator-access-log?offset=${seen.length}&limit=200`, { headers: admin.headers })).json()
      assert.ok(page.events.length > 0, '다음 쪽이 비지 않는다')
      seen.push(...page.events)
    }
    assert.equal(new Set(seen.map((event) => event.id)).size, expected, '겹치거나 빠진 줄이 없다')
    assert.ok(seen.every((event) => event.tenantId === 'TENANT-SUNSEA'), '다른 회사 기록은 섞이지 않는다')
    assert.equal(seen.at(-1).id, 'AUD-SEED-04998', '가장 오래된 선해 기록이 맨 끝에 있다')
  })
})

test('휴가 원장은 지우거나 고치는 저장을 거절한다 — 새 줄을 더하는 저장은 받는다', async () => {
  const store = freshStore()
  const entry = (id, days) => ({ id, name: '박지현', team: '생산 1팀', type: '부여', days, balanceAfter: 15, memo: '연차 부여', actor: '김서원', createdAt: '2026-01-02T00:00:00.000Z' })
  store.tenants['TENANT-SUNSEA']['leave-management'] = {
    data: { policy: { mode: 'yearly', annualDays: 15, monthlyDays: 1, carryOverLimit: 5, renewalDate: '01-01' }, balances: [], ledger: [entry('LED-2', 1), entry('LED-1', 14)] },
    updatedAt: '2026-01-02T00:00:00.000Z', updatedBy: 'seed',
  }
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {}, documentStorage: memoryStorage() }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const read = async () => (await fetch(`${origin}/api/workspace/leave-management`, { headers: admin.headers })).json()
    const put = async (data, version) => fetch(`${origin}/api/workspace/leave-management`, { method: 'PUT', headers: { ...admin.headers, 'if-match': `"${version}"` }, body: JSON.stringify({ data }) })

    let current = await read()
    const erased = await put({ ...current.data, ledger: current.data.ledger.slice(0, 1) }, current.version)
    assert.equal(erased.status, 409)
    assert.equal((await erased.json()).error.code, 'LEAVE_LEDGER_APPEND_ONLY')
    const edited = await put({ ...current.data, ledger: current.data.ledger.map((row) => (row.id === 'LED-1' ? { ...row, days: 30 } : row)) }, current.version)
    assert.equal(edited.status, 409, '이미 있는 줄의 일수를 고치는 저장도 거절한다')

    const appended = await put({ ...current.data, ledger: [entry('LED-3', 2), ...current.data.ledger] }, current.version)
    assert.equal(appended.status, 200, await appended.clone().text())
    current = await read()
    assert.deepEqual(current.data.ledger.map((row) => row.id), ['LED-3', 'LED-2', 'LED-1'])
  })
})

test('프로젝트가 500개면 가장 오래된 것을 지우지 않고 새로 만들기를 거절한다', async () => {
  const store = freshStore()
  const spaces = Array.from({ length: 500 }, (_, index) => ({
    id: `PRJ-SEED-${index}`, name: `프로젝트 ${index}`, description: '', visibility: 'company', status: 'active',
    ownerId: 'USR-SUNSEA-ADMIN', ownerName: '김서원', members: [{ id: 'USR-SUNSEA-ADMIN', name: '김서원', role: 'owner' }],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }))
  store.tenants['TENANT-SUNSEA']['project-spaces'] = { data: spaces, updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'seed' }
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {}, documentStorage: memoryStorage() }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const created = await fetch(`${origin}/api/projects`, { method: 'POST', headers: admin.headers, body: JSON.stringify({ name: '새 프로젝트' }) })
    assert.equal(created.status, 409)
    const body = await created.json()
    assert.equal(body.error.code, 'PROJECT_LIMIT_REACHED')
    assert.match(body.error.message, /지우지 않고/)
    const data = store.tenants['TENANT-SUNSEA']['project-spaces'].data
    assert.equal(data.length, 500)
    assert.ok(data.some((project) => project.id === 'PRJ-SEED-499'), '가장 오래된 프로젝트가 남아 있다')
  })
})

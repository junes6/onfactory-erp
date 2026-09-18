import assert from 'node:assert/strict'
import test from 'node:test'

import { createApp } from './app.mjs'
import { withServer } from './test-server.mjs'
import { archivableWorkItemIds, workCompletedAt } from './work-archive.mjs'
import { WORK_ITEMS_CAP } from './work-item-tree.mjs'

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

const freshStore = () => ({ version: 2, tenants: { 'TENANT-SUNSEA': {} }, platform: {}, accountApprovals: {}, accountCredentials: {}, invitedAccounts: [], passwordResetRequests: [], guestGrants: [] })

const item = (id, extra = {}) => ({
  id, title: `업무 ${id}`, description: '', owner: '박지현', ownerId: 'USR-SUNSEA-PARK', requestedBy: '김서원', requesterId: 'USR-SUNSEA-ADMIN',
  due: '2026-01-10T09:00:00.000Z', priority: '보통', status: '업무요청', category: '일반', ...extra,
})
const done = (id, reviewedAt, extra = {}) => item(id, {
  status: '결재완료',
  review: { decision: 'approved', comment: '', reviewedAt, reviewerId: 'USR-SUNSEA-ADMIN', reviewerName: '김서원' },
  ...extra,
})

async function login(origin, email) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: 'tenant', email, password: 'demo1234' }),
  })
  assert.equal(response.status, 200)
  const account = (await response.json()).account
  return { account, headers: { cookie: response.headers.get('set-cookie').split(';')[0], 'x-workspace-identity': `${account.tenantId}:${account.id}`, 'content-type': 'application/json' } }
}

test('옮겨도 되는 업무: 결재완료·기준일 지남 — 진행 중 하위가 남은 상위와, 상위가 남는 하위는 두고 간다', () => {
  const now = new Date('2026-09-18T00:00:00.000Z')
  const items = [
    done('OLD', '2026-06-01T00:00:00.000Z'),
    done('RECENT', '2026-09-10T00:00:00.000Z'),
    item('ACTIVE'),
    done('PARENT', '2026-05-01T00:00:00.000Z'),
    item('CHILD-OPEN', { parentId: 'PARENT' }),
    done('PARENT2', '2026-05-01T00:00:00.000Z'),
    done('CHILD-DONE', '2026-05-02T00:00:00.000Z', { parentId: 'PARENT2' }),
    item('PARENT3'),
    done('CHILD-OF-ACTIVE', '2026-05-02T00:00:00.000Z', { parentId: 'PARENT3' }),
  ]
  const ids = archivableWorkItemIds(items, { now, olderThanDays: 60 })
  assert.deepEqual([...ids].sort(), ['CHILD-DONE', 'OLD', 'PARENT2'])
  assert.equal(workCompletedAt(done('X', '2026-01-01T00:00:00.000Z')), '2026-01-01T00:00:00.000Z')
  assert.deepEqual([...archivableWorkItemIds(items, { now, olderThanDays: 0 })].sort(), ['CHILD-DONE', 'OLD', 'PARENT2', 'RECENT'], '0일이면 기준일 없이 결재완료 전부(트리 규칙은 그대로)')
})

test('상한에서는 지우지 않고 거절한다 — 보관하면 자리가 나고, 직원은 자기 업무만, 관리자는 꺼낼 수 있다', async () => {
  const store = freshStore()
  const storage = memoryStorage()
  const full = Array.from({ length: WORK_ITEMS_CAP }, (_, index) => (index < 900
    ? done(`WK-${String(index).padStart(4, '0')}`, '2026-03-01T00:00:00.000Z', index % 2 ? { ownerId: 'USR-SUNSEA-OH', owner: '오태식' } : {})
    : item(`WK-${String(index).padStart(4, '0')}`)))
  store.tenants['TENANT-SUNSEA']['work-items'] = { data: full, updatedAt: '2026-09-01T00:00:00.000Z', updatedBy: 'seed' }
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {}, documentStorage: storage }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const park = await login(origin, 'jihyun.park@sunsea.co.kr')

    // 1) 가득 찬 목록에 한 건을 더하면 지우지 않고 409 — 무엇을 하면 되는지 같은 문장에서 말한다.
    const listed = await (await fetch(`${origin}/api/workspace/work-items`, { headers: admin.headers })).json()
    const overfull = await fetch(`${origin}/api/workspace/work-items`, {
      method: 'PUT', headers: { ...admin.headers, 'if-match': `"${listed.version}"` },
      body: JSON.stringify({ data: [item('WK-NEW'), ...listed.data] }),
    })
    assert.equal(overfull.status, 409)
    const refusal = await overfull.json()
    assert.equal(refusal.error.code, 'WORK_ITEMS_FULL')
    assert.match(refusal.error.message, /보관함/)
    assert.equal(store.tenants['TENANT-SUNSEA']['work-items'].data.length, WORK_ITEMS_CAP, '아무것도 지워지지 않았다')

    // 2) 직원은 지금 옮기기를 할 수 없다.
    assert.equal((await fetch(`${origin}/api/work-items/archive`, { method: 'POST', headers: park.headers, body: '{}' })).status, 403)

    // 3) 관리자가 지금 옮기면 결재완료 900건이 보관함으로 간다. 진행 중 100건은 남는다.
    const archived = await (await fetch(`${origin}/api/work-items/archive`, { method: 'POST', headers: admin.headers, body: '{}' })).json()
    assert.deepEqual(archived, { archived: 900, remaining: 100 })
    assert.equal(store.tenants['TENANT-SUNSEA']['work-items'].data.length, 100)

    // 4) 보관함: 관리자는 전부, 직원은 자기 업무만. 검색도 된다.
    const adminPage = await (await fetch(`${origin}/api/work-items/archive?limit=10`, { headers: admin.headers })).json()
    assert.equal(adminPage.total, 900)
    assert.equal(adminPage.canManage, true)
    const parkPage = await (await fetch(`${origin}/api/work-items/archive?limit=200`, { headers: park.headers })).json()
    assert.equal(parkPage.total, 450, '박지현이 담당한 절반만')
    assert.ok(parkPage.rows.every((row) => row.ownerId === 'USR-SUNSEA-PARK'))
    const searched = await (await fetch(`${origin}/api/work-items/archive?q=${encodeURIComponent('업무 WK-0010')}`, { headers: admin.headers })).json()
    assert.ok(searched.rows.some((row) => row.id === 'WK-0010'))

    // 5) 이제 새 업무가 들어간다.
    const current = await (await fetch(`${origin}/api/workspace/work-items`, { headers: admin.headers })).json()
    const added = await fetch(`${origin}/api/workspace/work-items`, {
      method: 'PUT', headers: { ...admin.headers, 'if-match': `"${current.version}"` },
      body: JSON.stringify({ data: [item('WK-NEW'), ...current.data] }),
    })
    assert.equal(added.status, 200, await added.clone().text())

    // 6) 꺼내기(관리자): 진행 중 목록으로 돌아오고 보관함에서 빠진다. 두 번은 안 된다.
    const restored = await fetch(`${origin}/api/work-items/archive/WK-0010/restore`, { method: 'POST', headers: admin.headers, body: '{}' })
    assert.equal(restored.status, 200, await restored.clone().text())
    assert.ok(store.tenants['TENANT-SUNSEA']['work-items'].data.some((row) => row.id === 'WK-0010'))
    assert.equal((await (await fetch(`${origin}/api/work-items/archive?limit=1`, { headers: admin.headers })).json()).total, 899)
    assert.equal((await fetch(`${origin}/api/work-items/archive/WK-0010/restore`, { method: 'POST', headers: admin.headers, body: '{}' })).status, 409)
    assert.equal((await fetch(`${origin}/api/work-items/archive/WK-0011/restore`, { method: 'POST', headers: park.headers, body: '{}' })).status, 403)
  })
})

test('매일 정리는 60일 지난 완료 업무만 옮긴다', async () => {
  const store = freshStore()
  store.tenants['TENANT-SUNSEA']['work-items'] = { data: [done('A', '2026-06-01T00:00:00.000Z'), done('B', '2026-09-15T00:00:00.000Z'), item('C')], updatedAt: '', updatedBy: '' }
  const app = createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {}, documentStorage: memoryStorage() })
  const result = await app.locals.workArchive.archiveCompletedWorkItems('TENANT-SUNSEA', { now: new Date('2026-09-18T00:00:00.000Z') })
  assert.deepEqual(result, { archived: 1, remaining: 2 })
  assert.deepEqual(store.tenants['TENANT-SUNSEA']['work-items'].data.map((row) => row.id), ['B', 'C'])
  assert.equal((await app.locals.archive.summary('TENANT-SUNSEA', 'work-items')).total, 1)
})

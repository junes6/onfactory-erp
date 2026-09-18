import assert from 'node:assert/strict'
import test from 'node:test'

import { createApp, rebaseRowWrite } from './app.mjs'
import { withServer } from './test-server.mjs'

/**
 * 동시 저장 유실(감사 data-core-01)의 재현 시험.
 *
 * 저장 경로는 "버전 확인 → 첨부 원본이 있는지 확인(await) → 쓰기"다. 그 await 동안 다른 요청이 같은 키를 쓰면,
 * 잡아 둔 옛 배열로 덮어 그 쓰기가 사라졌다(둘 다 200). 벽시계로 겹치게 하지 않는다 —
 * 저장소의 `exists`를 게이트로 붙잡아 두고 시험이 연다.
 */
function gatedStorage() {
  const files = new Map()
  let gate = null
  const storage = {
    files,
    backend: 'local',
    async put(key, body) { files.set(key, Buffer.from(body)); return { key, size: body.length } },
    async get(key) {
      const value = files.get(key)
      if (!value) { const error = new Error('없음'); error.code = 'STORAGE_NOT_FOUND'; throw error }
      return value
    },
    async exists(key) {
      if (gate) await gate.promise
      return files.has(key)
    },
    async delete(key) { return files.delete(key) },
    async getSignedUrl(_key, options = {}) { return options.fallbackUrl ?? null },
  }
  return {
    storage,
    hold() { let open; gate = { promise: new Promise((resolve) => { open = resolve }) }; gate.open = open },
    release() { const current = gate; gate = null; current?.open() },
  }
}

const freshStore = () => ({ version: 2, tenants: { 'TENANT-SUNSEA': {} }, platform: {}, accountApprovals: {}, accountCredentials: {}, invitedAccounts: [], passwordResetRequests: [], guestGrants: [] })

async function login(origin, email) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: 'tenant', email, password: 'demo1234' }),
  })
  assert.equal(response.status, 200)
  const account = (await response.json()).account
  const cookie = response.headers.get('set-cookie').split(';')[0]
  return { account, headers: { cookie, 'x-workspace-identity': `${account.tenantId}:${account.id}`, 'content-type': 'application/json' } }
}

async function upload(origin, who, name) {
  const query = new URLSearchParams({ name, category: '공통자료', visibility: 'all' })
  const response = await fetch(`${origin}/api/documents?${query}`, {
    method: 'POST',
    headers: { cookie: who.headers.cookie, 'x-workspace-identity': who.headers['x-workspace-identity'], 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name), 'x-file-type': 'application/pdf' },
    body: Buffer.from('%PDF-1.4 증빙'),
  })
  assert.equal(response.status, 201)
  return (await response.json()).document
}

const workItem = (id, extra = {}) => ({
  id, title: `업무 ${id}`, description: '', owner: '박지현', ownerId: 'USR-SUNSEA-PARK', requestedBy: '김서원', requesterId: 'USR-SUNSEA-ADMIN',
  due: '2026-09-30T09:00:00.000Z', priority: '보통', status: '업무요청', category: '일반', ...extra,
})

test('한 행만 바꾸는 쓰기는 최신 배열 위에 다시 얹힌다 — 이 행이 바뀌었으면 null', () => {
  const a = { id: 'A', v: 1 }
  const b = { id: 'B', v: 1 }
  const previous = { data: [a, b] }
  assert.deepEqual(rebaseRowWrite(previous, previous, a, { id: 'A', v: 2 }), [{ id: 'A', v: 2 }, b])
  const latest = { data: [{ id: 'NEW' }, { id: 'A', v: 1 }, b] }
  assert.deepEqual(rebaseRowWrite(latest, previous, a, { id: 'A', v: 2 }), [{ id: 'NEW' }, { id: 'A', v: 2 }, b], '그 사이 생긴 행을 지키며 이 행만 바꾼다')
  assert.equal(rebaseRowWrite({ data: [{ id: 'A', v: 9 }, b] }, previous, a, { id: 'A', v: 2 }), null, '이 행이 바뀌었으면 판정의 전제가 무너졌다')
  assert.equal(rebaseRowWrite({ data: [b] }, previous, a, { id: 'A', v: 2 }), null, '이 행이 사라졌으면 되살리지 않는다')
})

test('같은 버전을 든 두 저장이 겹치면 하나만 받고 나머지는 409 — 둘 다 200을 받고 하나가 사라지지 않는다', async () => {
  const store = freshStore()
  const gated = gatedStorage()
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {}, documentStorage: gated.storage }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const document = await upload(origin, admin, '증빙.pdf')
    const attachment = { id: document.id, name: '증빙.pdf', size: '1 KB', type: 'application/pdf' }
    const seeded = await fetch(`${origin}/api/workspace/work-items`, { method: 'PUT', headers: admin.headers, body: JSON.stringify({ data: [workItem('WK-0001', { attachments: [attachment] })] }) })
    assert.equal(seeded.status, 200, await seeded.clone().text())
    const version = (await seeded.json()).version

    gated.hold()
    const put = (id) => fetch(`${origin}/api/workspace/work-items`, {
      method: 'PUT', headers: { ...admin.headers, 'if-match': `"${version}"` },
      body: JSON.stringify({ data: [workItem(id), workItem('WK-0001', { attachments: [attachment] })] }),
    })
    const first = put('WK-0002')
    const second = put('WK-0003')
    await new Promise((resolve) => setTimeout(resolve, 50))
    gated.release()
    const statuses = [(await first).status, (await second).status].sort()
    assert.deepEqual(statuses, [200, 409], '둘 다 200이면 한쪽 쓰기가 사라진 것이다')
    const ids = store.tenants['TENANT-SUNSEA']['work-items'].data.map((item) => item.id).sort()
    assert.equal(ids.length, 2)
    assert.ok(ids.includes('WK-0001'))
  })
})

test('완료 보고가 증빙을 확인하는 동안 관리자가 만든 새 업무가 사라지지 않는다', async () => {
  const store = freshStore()
  const gated = gatedStorage()
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {}, documentStorage: gated.storage }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const park = await login(origin, 'jihyun.park@sunsea.co.kr')
    const seeded = await fetch(`${origin}/api/workspace/work-items`, { method: 'PUT', headers: admin.headers, body: JSON.stringify({ data: [workItem('WK-0001', { status: '수행중' })] }) })
    assert.equal(seeded.status, 200, await seeded.clone().text())
    const evidenceDocument = await upload(origin, park, '현장사진.pdf')

    gated.hold()
    const report = fetch(`${origin}/api/work-items/WK-0001/transition`, {
      method: 'POST', headers: park.headers,
      body: JSON.stringify({ action: 'submit', completion: { summary: '점검을 마쳤습니다.', evidence: [{ id: evidenceDocument.id, name: '현장사진.pdf', size: '1 KB', type: 'application/pdf' }] } }),
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    // 증빙 확인이 붙잡혀 있는 사이 관리자가 새 업무를 지시한다(첨부가 없어 기다리지 않는다).
    const current = (await (await fetch(`${origin}/api/workspace/work-items`, { headers: admin.headers })).json())
    const created = await fetch(`${origin}/api/workspace/work-items`, {
      method: 'PUT', headers: { ...admin.headers, 'if-match': `"${current.version}"` },
      body: JSON.stringify({ data: [workItem('WK-NEW'), ...current.data] }),
    })
    assert.equal(created.status, 200, await created.clone().text())
    gated.release()
    const reported = await report
    assert.equal(reported.status, 200, await reported.clone().text())

    const rows = store.tenants['TENANT-SUNSEA']['work-items'].data
    assert.ok(rows.some((item) => item.id === 'WK-NEW'), '관리자가 만든 새 업무가 남아 있어야 한다')
    assert.equal(rows.find((item) => item.id === 'WK-0001').status, '결재대기', '완료 보고도 반영된다')
  })
})

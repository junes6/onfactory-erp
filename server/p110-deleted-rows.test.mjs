import assert from 'node:assert/strict'
import test from 'node:test'

import { createApp } from './app.mjs'
import { withServer } from './test-server.mjs'

/**
 * P1-10(감사 business-admin-19): 대장의 [삭제]는 영구 삭제였다. 이제 generic PUT이 뺀 행이 '지운 기록'에 30일 남고,
 * 되살리면 행과 함께 휴지통에 간 첨부도 돌아온다. 되살리기는 그 대장을 쓸 수 있는 사람만, 직원은 자기가 지운 것만 본다.
 */

const TENANT = 'TENANT-SUNSEA'
const readJson = async (response) => { const text = await response.text(); try { return JSON.parse(text) } catch { return { raw: text } } }
async function login(origin, email) {
  const response = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: 'tenant', email, password: 'demo1234' }) })
  assert.equal(response.status, 200, email)
  return (response.headers.get('set-cookie') ?? '').split(';')[0]
}
function memoryStorage() {
  const files = new Map()
  return {
    files, backend: 'local',
    async put(key, body) { files.set(key, Buffer.from(body)); return { key, size: body.length } },
    async get(key) { const value = files.get(key); if (!value) { const error = new Error('없음'); error.code = 'STORAGE_NOT_FOUND'; throw error } return value },
    async delete(key) { return files.delete(key) },
    async exists(key) { return files.has(key) },
    async getSignedUrl(_key, options = {}) { return options.fallbackUrl ?? null },
  }
}
const asset = (id, extra = {}) => ({ id, name: `노트북 ${id}`, category: 'IT 기기', status: '사용 중', holder: '오태식', acquiredAt: '2026-03-02', cost: 1_800_000, attachments: [], ...extra })
const json = (cookie, version) => ({ cookie, 'content-type': 'application/json', ...(version ? { 'if-match': version } : {}) })

test('자산을 지우면 지운 기록에 남고, 되살리면 행과 휴지통의 첨부가 함께 돌아온다', async () => {
  const store = { version: 2, tenants: { [TENANT]: {} }, platform: {}, accountApprovals: {}, accountCredentials: {}, invitedAccounts: [], passwordResetRequests: [], guestGrants: [] }
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {}, documentStorage: memoryStorage() }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const uploaded = await readJson(await fetch(`${origin}/api/documents?name=${encodeURIComponent('영수증.pdf')}&visibility=restricted&category=${encodeURIComponent('자산')}`, {
      method: 'POST', headers: { cookie: admin, 'content-type': 'application/octet-stream', 'x-file-type': 'application/pdf', 'x-file-name': encodeURIComponent('영수증.pdf') }, body: Buffer.from('%PDF receipt'),
    }))
    const attachment = { id: uploaded.document.id, name: '영수증.pdf', size: '1 KB' }

    const first = await readJson(await fetch(`${origin}/api/workspace/company-assets`, { method: 'PUT', headers: json(admin), body: JSON.stringify({ data: [asset('AS-1', { attachments: [attachment] }), asset('AS-2')] }) }))
    // 화면과 같은 순서: 행을 빼고 → 첨부를 휴지통으로.
    const removed = await fetch(`${origin}/api/workspace/company-assets`, { method: 'PUT', headers: json(admin, first.version), body: JSON.stringify({ data: [asset('AS-2')] }) })
    assert.equal(removed.status, 200)
    assert.equal((await fetch(`${origin}/api/documents/${attachment.id}`, { method: 'DELETE', headers: { cookie: admin } })).status, 200)

    const listed = await readJson(await fetch(`${origin}/api/deleted-rows?key=company-assets`, { headers: { cookie: admin } }))
    assert.equal(listed.days, 30)
    assert.deepEqual(listed.items.map((item) => [item.rowId, item.label, item.deletedByName]), [['AS-1', '노트북 AS-1', '김서원']])

    const restored = await readJson(await fetch(`${origin}/api/deleted-rows/${listed.items[0].id}/restore`, { method: 'POST', headers: json(admin) }))
    assert.equal(restored.row.id, 'AS-1')
    assert.equal(restored.restoredFiles, 1, '휴지통의 첨부도 함께 꺼낸다')
    const assets = await readJson(await fetch(`${origin}/api/workspace/company-assets`, { headers: { cookie: admin } }))
    assert.deepEqual(assets.data.map((row) => row.id).sort(), ['AS-1', 'AS-2'])
    assert.equal((await fetch(`${origin}/api/documents/${attachment.id}/download`, { headers: { cookie: admin } })).status, 200)
    assert.equal((await readJson(await fetch(`${origin}/api/deleted-rows?key=company-assets`, { headers: { cookie: admin } }))).items.length, 0, '되살린 것은 목록에서 빠진다')

    // 다시 지우면 다시 되살릴 수 있다(봉투 id가 지울 때마다 새것).
    const again = await readJson(await fetch(`${origin}/api/workspace/company-assets`, { headers: { cookie: admin } }))
    await fetch(`${origin}/api/workspace/company-assets`, { method: 'PUT', headers: json(admin, again.version), body: JSON.stringify({ data: again.data.filter((row) => row.id !== 'AS-1') }) })
    const undo = await fetch(`${origin}/api/deleted-rows/restore-latest`, { method: 'POST', headers: json(admin), body: JSON.stringify({ key: 'company-assets', rowId: 'AS-1' }) })
    assert.equal(undo.status, 200, '알림의 [되돌리기]는 가장 최근에 지운 것을 꺼낸다')
    assert.equal((await fetch(`${origin}/api/deleted-rows/restore-latest`, { method: 'POST', headers: json(admin), body: JSON.stringify({ key: 'company-assets', rowId: 'AS-1' }) })).status, 404)
  })
})

test('직원은 자기가 지운 것만 보고, 쓸 수 없는 대장의 기록은 되살리지 못한다', async () => {
  const store = { version: 2, tenants: { [TENANT]: {
    'company-assets': { data: [asset('AS-9')], updatedAt: '2026-09-18T00:00:00.000Z', updatedBy: 'seed' },
  } }, platform: {}, accountApprovals: {}, accountCredentials: {}, invitedAccounts: [], passwordResetRequests: [], guestGrants: [] }
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {}, documentStorage: memoryStorage() }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const member = await login(origin, 'taesik.oh@sunsea.co.kr')
    const current = await readJson(await fetch(`${origin}/api/workspace/company-assets`, { headers: { cookie: admin } }))
    await fetch(`${origin}/api/workspace/company-assets`, { method: 'PUT', headers: json(admin, current.version), body: JSON.stringify({ data: [] }) })
    assert.equal((await readJson(await fetch(`${origin}/api/deleted-rows?key=company-assets`, { headers: { cookie: member } }))).items.length, 0, '남이 지운 기록은 보이지 않는다')
    assert.equal((await fetch(`${origin}/api/deleted-rows/restore-latest`, { method: 'POST', headers: json(member), body: JSON.stringify({ key: 'company-assets', rowId: 'AS-9' }) })).status, 404)
    assert.equal((await fetch(`${origin}/api/deleted-rows?key=work-items`, { headers: { cookie: admin } })).status, 404, '보관하지 않는 영역')
  })
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { createApp } from './app.mjs'
import { withServer } from './test-server.mjs'

/**
 * P1-6: 자료실의 [삭제]는 30일 휴지통으로 간다. 올린 사람·지운 사람·관리자가 되살리고,
 * 완전히 지우는 일은 휴지통에서 회사 관리자만 한다. 기한이 지나면 매일 도는 일이 비운다.
 */

const json = (cookie) => ({ 'content-type': 'application/json', cookie })
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
const emptyStore = () => ({ version: 2, tenants: {}, platform: {}, accountApprovals: {}, accountCredentials: {}, invitedAccounts: [], passwordResetRequests: [], guestGrants: [] })
async function upload(origin, cookie, name, body = `${name} 내용`) {
  const response = await fetch(`${origin}/api/documents?name=${encodeURIComponent(name)}&visibility=all`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-type': 'text/plain', 'x-file-name': encodeURIComponent(name) }, body: Buffer.from(body),
  })
  assert.equal(response.status, 201, name)
  return (await response.json()).document
}
const listIds = async (origin, cookie, trash = false) => ((await readJson(await fetch(`${origin}/api/documents${trash ? '?trash=1' : ''}`, { headers: { cookie } }))).documents ?? []).map((document) => document.id)

test('삭제는 휴지통으로: 목록·내려받기에서 빠지고, 올린 사람이 되살리면 그대로 돌아온다 — 남은 못 본다', async () => {
  const storage = memoryStorage()
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: emptyStore(), onWorkspaceStoreChange: () => {}, documentStorage: storage }), async (origin) => {
    const owner = await login(origin, 'taesik.oh@sunsea.co.kr')
    const other = await login(origin, 'jihyun.park@sunsea.co.kr')
    const document = await upload(origin, owner, '9월 원가표.txt')

    const trashed = await readJson(await fetch(`${origin}/api/documents/${document.id}`, { method: 'DELETE', headers: { cookie: owner } }))
    assert.equal(trashed.trashed, true)
    assert.equal(trashed.trashDays, 30)
    assert.ok(Date.parse(trashed.purgeAt) - Date.now() > 29 * 86_400_000, '30일 뒤에 지워진다')
    assert.equal(storage.files.size, 1, '파일은 그대로 있다')

    assert.ok(!(await listIds(origin, owner)).includes(document.id), '목록에서 빠진다')
    assert.equal((await fetch(`${origin}/api/documents/${document.id}/download`, { headers: { cookie: owner } })).status, 404, '내려받을 수 없다')
    assert.deepEqual(await listIds(origin, owner, true), [document.id], '올린 사람의 휴지통에 있다')
    assert.deepEqual(await listIds(origin, other, true), [], '다른 직원의 휴지통에는 없다')
    assert.equal((await fetch(`${origin}/api/documents/${document.id}/restore`, { method: 'POST', headers: { cookie: other } })).status, 404, '남은 되살리지 못한다')
    assert.equal((await fetch(`${origin}/api/documents/${document.id}`, { method: 'DELETE', headers: { cookie: owner } })).status, 409, '이미 휴지통에 있다')

    const purgeByOwner = await readJson(await fetch(`${origin}/api/documents/${document.id}?permanent=1`, { method: 'DELETE', headers: { cookie: owner } }))
    assert.equal(purgeByOwner.error.code, 'DOCUMENT_PURGE_FORBIDDEN', '완전 삭제는 관리자만')

    const restored = await readJson(await fetch(`${origin}/api/documents/${document.id}/restore`, { method: 'POST', headers: { cookie: owner } }))
    assert.equal(restored.document.id, document.id)
    assert.equal(restored.document.trashedAt, undefined)
    assert.ok((await listIds(origin, owner)).includes(document.id))
    assert.ok((await listIds(origin, other)).includes(document.id), '전 직원 공개 자료는 다시 모두에게 보인다')
    const download = await fetch(`${origin}/api/documents/${document.id}/download`, { headers: { cookie: other } })
    assert.equal(download.status, 200)
    assert.equal(await download.text(), '9월 원가표.txt 내용')
  })
})

test('완전 삭제: 휴지통에 있는 것만, 회사 관리자만 — 파일까지 지운다. 휴지통 자료는 고칠 수 없다', async () => {
  const storage = memoryStorage()
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: emptyStore(), onWorkspaceStoreChange: () => {}, documentStorage: storage }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const owner = await login(origin, 'taesik.oh@sunsea.co.kr')
    const document = await upload(origin, owner, '견적서.txt')

    const notTrashed = await readJson(await fetch(`${origin}/api/documents/${document.id}?permanent=1`, { method: 'DELETE', headers: { cookie: admin } }))
    assert.equal(notTrashed.error.code, 'DOCUMENT_NOT_TRASHED', '바로 완전 삭제는 없다 — 휴지통을 거친다')

    assert.equal((await fetch(`${origin}/api/documents/${document.id}`, { method: 'DELETE', headers: { cookie: owner } })).status, 200)
    assert.deepEqual(await listIds(origin, admin, true), [document.id], '관리자 휴지통에는 모두의 자료')
    const patched = await fetch(`${origin}/api/documents/${document.id}`, { method: 'PATCH', headers: json(admin), body: JSON.stringify({ name: '바꾼 이름' }) })
    assert.equal(patched.status, 404, '휴지통 자료는 되살린 뒤에 고친다')

    const purged = await readJson(await fetch(`${origin}/api/documents/${document.id}?permanent=1`, { method: 'DELETE', headers: { cookie: admin } }))
    assert.equal(purged.permanent, true)
    assert.equal(storage.files.size, 0, '파일까지 지웠다')
    assert.deepEqual(await listIds(origin, admin, true), [])
  })
})

test('매일 비우기: 30일이 지난 휴지통 자료만 파일과 기록을 함께 지운다', async () => {
  const storage = memoryStorage()
  const app = createApp({ apiKey: '', initialWorkspaceStore: emptyStore(), onWorkspaceStoreChange: () => {}, documentStorage: storage })
  await withServer(app, async (origin) => {
    const owner = await login(origin, 'taesik.oh@sunsea.co.kr')
    const old = await upload(origin, owner, '오래된 자료.txt')
    const recent = await upload(origin, owner, '어제 지운 자료.txt')
    const kept = await upload(origin, owner, '쓰는 자료.txt')
    assert.equal((await fetch(`${origin}/api/documents/${old.id}`, { method: 'DELETE', headers: { cookie: owner } })).status, 200)
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal((await fetch(`${origin}/api/documents/${recent.id}`, { method: 'DELETE', headers: { cookie: owner } })).status, 200)

    const { removed } = await app.locals.sweepDocumentTrash(new Date(Date.now() + 10 * 86_400_000))
    assert.equal(removed, 0, '열흘 뒤에는 아직 아무것도 지우지 않는다')
    const trashRows = (await readJson(await fetch(`${origin}/api/documents?trash=1`, { headers: { cookie: owner } }))).documents
    assert.equal(trashRows.length, 2)
    const oldTrashedAt = Date.parse(trashRows.find((row) => row.id === old.id).trashedAt)
    // 먼저 지운 자료의 기한만 막 지난 시각 — 40ms 늦게 지운 자료는 아직 기한 안이다.
    const later = await app.locals.sweepDocumentTrash(new Date(oldTrashedAt + 30 * 86_400_000 + 10))
    assert.equal(later.removed, 1)
    assert.deepEqual(await listIds(origin, owner, true), [recent.id], '기한 안의 자료는 휴지통에 남는다')
    assert.deepEqual(await listIds(origin, owner), [kept.id])
    assert.equal(storage.files.size, 2, '지운 자료의 파일만 사라졌다')
  })
})

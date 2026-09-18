import assert from 'node:assert/strict'
import test from 'node:test'

import { createApp } from './app.mjs'
import { withServer } from './test-server.mjs'

/**
 * P1-8(감사 collab-17): 회의 녹음만 24MB(전사 whisper 25MB 안쪽)까지 받는다. 다른 자료는 10MB 그대로.
 * 한 시간 회의를 휴대폰으로 녹음하면 10MB를 넘어, 회의록을 만들려면 파일을 쪼개야 했다.
 */

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
const MB = 1024 * 1024
const upload = (origin, cookie, { name, bytes, category = '공통자료', tags = '' }) => fetch(`${origin}/api/documents?${new URLSearchParams({ name, category, visibility: 'restricted', ...(tags ? { tags } : {}) })}`, {
  method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-type': 'audio/webm', 'x-file-name': encodeURIComponent(name) }, body: Buffer.alloc(bytes, 1),
})

test('회의 녹음은 24MB까지, 다른 자료는 10MB까지 — 넘으면 무엇을 하면 되는지 말한다', async () => {
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: emptyStore(), onWorkspaceStoreChange: () => {}, documentStorage: memoryStorage() }), async (origin) => {
    const member = await login(origin, 'taesik.oh@sunsea.co.kr')
    const hour = await upload(origin, member, { name: '9월 품질회의.webm', bytes: 14 * MB, category: '회의녹음', tags: 'meeting-recording' })
    assert.equal(hour.status, 201, '한 시간 회의 녹음(14MB)이 올라간다')
    const ordinary = await upload(origin, member, { name: '큰 도면.pdf', bytes: 14 * MB })
    assert.equal(ordinary.status, 413)
    const body = await ordinary.json()
    assert.equal(body.error.code, 'DOCUMENT_TOO_LARGE')
    assert.match(body.error.message, /10MB까지/)
    const tooLong = await upload(origin, member, { name: '세 시간 워크숍.webm', bytes: 24 * MB + 1, category: '회의녹음', tags: 'meeting-recording' })
    assert.equal(tooLong.status, 413)
  })
})

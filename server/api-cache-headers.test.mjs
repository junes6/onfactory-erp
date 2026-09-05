import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createApp } from './app.mjs'
import { withServer } from './test-server.mjs'

/**
 * API 응답은 브라우저가 저장하지 않는다.
 *
 * 한 브라우저에서 운영자로 목록을 연 뒤 게스트로 로그인했을 때, 서버는 빈 목록을 보냈는데
 * 화면에는 운영자 때의 업무 8건이 그대로 떴다 — Cache-Control이 없어 브라우저가 이전
 * 사람의 응답을 재사용한 것이다. 이 테스트는 그 구멍이 다시 열리지 않게 한다.
 */
async function withApp(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'api-cache-'))
  try {
    const app = createApp({ apiKey: '', workspaceStoreFile: path.join(directory, 'state.json'), documentUploadDirectory: path.join(directory, 'documents') })
    await withServer(app, run)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const expectNoStore = (response, label) => {
  const control = String(response.headers.get('cache-control') ?? '')
  assert.match(control, /no-store/, `${label}: cache-control에 no-store가 없다 (${control || '헤더 없음'})`)
  assert.equal(response.headers.get('vary'), 'Cookie', `${label}: 세션에 따라 달라지는 응답은 Vary: Cookie 를 단다`)
}

test('모든 /api 응답은 no-store 다 — 인증 전·후·목록·오류 가리지 않고', async () => {
  await withApp(async (origin) => {
    expectNoStore(await fetch(`${origin}/api/health`), '/api/health')

    const denied = await fetch(`${origin}/api/workspace/work-items`)
    assert.equal(denied.status, 401)
    expectNoStore(denied, '401 응답')

    const login = await fetch(`${origin}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: 'tenant', email: 'jihyun.park@sunsea.co.kr', password: 'demo1234' }),
    })
    assert.equal(login.status, 200)
    expectNoStore(login, '로그인 응답')
    const account = (await login.json()).account
    const headers = { cookie: login.headers.get('set-cookie'), 'x-workspace-identity': `${account.tenantId}:${account.id}` }

    const list = await fetch(`${origin}/api/workspace/work-items`, { headers })
    assert.equal(list.status, 200)
    expectNoStore(list, '업무 목록')

    const missing = await fetch(`${origin}/api/no-such-route`, { headers })
    expectNoStore(missing, '없는 주소')
  })
})

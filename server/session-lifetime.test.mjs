import assert from 'node:assert/strict'
import test from 'node:test'

import { createApp } from './app.mjs'
import { withServer } from './test-server.mjs'

/**
 * 세션은 쓰는 동안 밀린다. 전에는 로그인 후 8시간 절대값이라, 일하던 사람이 퇴근 무렵 갑자기 튕겼다.
 * 「이 기기에서 로그인 유지」: 30일(쿠키도 30일, 앱을 열 때마다 다시 민다). 끄면 12시간 쓰지 않을 때 끝(쿠키는 브라우저 세션).
 */
const freshStore = () => ({ version: 2, tenants: { 'TENANT-SUNSEA': {} }, platform: {}, accountApprovals: {}, accountCredentials: {}, invitedAccounts: [], passwordResetRequests: [], guestGrants: [] })
const HOUR = 60 * 60 * 1_000

async function login(origin, remember) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: 'tenant', email: 'jihyun.park@sunsea.co.kr', password: 'demo1234', ...(remember === undefined ? {} : { remember }) }),
  })
  assert.equal(response.status, 200)
  const setCookie = response.headers.get('set-cookie') ?? ''
  return { setCookie, cookie: setCookie.split(';')[0], token: decodeURIComponent(setCookie.split(';')[0].split('=').slice(1).join('=')) }
}

test('로그인 유지(기본): 30일 세션 · 30일 쿠키, 앱을 열면 쿠키 수명을 다시 민다', async () => {
  const sessions = new Map()
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: freshStore(), onWorkspaceStoreChange: () => {}, sessions }), async (origin) => {
    const { setCookie, cookie, token } = await login(origin)
    assert.match(setCookie, /Max-Age=2592000/)
    const session = sessions.get(token)
    assert.equal(session.remember, true)
    assert.ok(session.expiresAt - Date.now() > 29 * 24 * HOUR)

    // 오래 전에 연장된 세션처럼 만든다 → 쓰면 다시 30일로 밀린다.
    session.expiresAt = Date.now() + 2 * HOUR
    const reopened = await fetch(`${origin}/api/auth/session`, { headers: { cookie } })
    assert.equal(reopened.status, 200)
    assert.match(reopened.headers.get('set-cookie') ?? '', /Max-Age=2592000/, '앱을 열면 쿠키 수명도 민다')
    assert.ok(sessions.get(token).expiresAt - Date.now() > 29 * 24 * HOUR, '만료가 밀렸다')
  })
})

test('로그인 유지 끔: 12시간 쓰지 않으면 끝, 쿠키는 브라우저 세션 — 쓰는 동안에는 밀린다', async () => {
  const sessions = new Map()
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: freshStore(), onWorkspaceStoreChange: () => {}, sessions }), async (origin) => {
    const { setCookie, cookie, token } = await login(origin, false)
    assert.doesNotMatch(setCookie, /Max-Age/)
    const session = sessions.get(token)
    assert.equal(session.remember, false)
    assert.ok(Math.abs(session.expiresAt - Date.now() - 12 * HOUR) < 60_000)

    // 방금 연장했으면(1시간 안) 다시 기록하지 않는다.
    const before = session.expiresAt
    await fetch(`${origin}/api/auth/session`, { headers: { cookie } })
    assert.equal(sessions.get(token).expiresAt, before, '요청마다 쓰지 않는다')

    // 10시간 뒤처럼(남은 2시간) → 쓰면 다시 12시간.
    session.expiresAt = Date.now() + 2 * HOUR
    const again = await fetch(`${origin}/api/auth/session`, { headers: { cookie } })
    assert.equal(again.status, 200)
    assert.ok(sessions.get(token).expiresAt - Date.now() > 11 * HOUR)
    assert.doesNotMatch(again.headers.get('set-cookie') ?? '', /Max-Age/, '유지 안 함 세션에는 오래가는 쿠키를 주지 않는다')

    // 만료되면 끝.
    sessions.get(token).expiresAt = Date.now() - 1
    assert.equal((await fetch(`${origin}/api/auth/session`, { headers: { cookie } })).status, 401)
  })
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { createApp } from './app.mjs'
import { withServer } from './test-server.mjs'

async function login(origin) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: 'tenant', email: 'admin@sunsea.co.kr', password: 'demo1234' }),
  })
  assert.equal(response.status, 200)
  const account = (await response.json()).account
  return { cookie: response.headers.get('set-cookie'), identity: `${account.tenantId}:${account.id}` }
}

test('support program feed requires an authenticated matching tenant and clamps request options', async () => {
  const calls = []
  const supportProgramService = { list: async (options) => { calls.push(options); return { items: [], syncedAt: null, stale: false, sources: {}, officialLinks: [] } } }
  await withServer(createApp({ apiKey: '', supportProgramService }), async (origin) => {
    assert.equal((await fetch(`${origin}/api/support-programs`)).status, 401)
    const session = await login(origin)
    const mismatched = await fetch(`${origin}/api/support-programs`, { headers: { cookie: session.cookie, 'x-workspace-identity': 'TENANT-OTHER:ACCOUNT-X' } })
    assert.equal(mismatched.status, 401)
    const invalid = await fetch(`${origin}/api/support-programs?source=unknown`, { headers: { cookie: session.cookie, 'x-workspace-identity': session.identity } })
    assert.equal(invalid.status, 400)
    const response = await fetch(`${origin}/api/support-programs?source=kstartup&limit=999`, { headers: { cookie: session.cookie, 'x-workspace-identity': session.identity } })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('cache-control') ?? '', /private/)
    assert.deepEqual(calls, [{ source: 'kstartup', limit: 12 }])
  })
})

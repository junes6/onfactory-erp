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
    const badSort = await fetch(`${origin}/api/support-programs?sort=random`, { headers: { cookie: session.cookie, 'x-workspace-identity': session.identity } })
    assert.equal(badSort.status, 400)
    const response = await fetch(`${origin}/api/support-programs?source=kstartup&limit=999`, { headers: { cookie: session.cookie, 'x-workspace-identity': session.identity } })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('cache-control') ?? '', /private/)
    const body = await response.json()
    assert.equal(body.sort, 'recommended', '기본 정렬은 추천순이다')
    assert.deepEqual(body.summary, { total: 0, open: 0, closed: 0, closingSoon: 0, recommended: 0, top: null })
    // 표시 개수는 30건으로 자르되, 관련성 채점이 충분한 후보를 보도록 서비스에는 최소 30건을 요청한다.
    assert.deepEqual(calls, [{ source: 'kstartup', limit: 30 }])
  })
})

test('the feed ranks by relevance to the tenant watch profile and explains each score', async () => {
  const items = [
    { id: 'a', source: 'bizinfo', sourceLabel: '기업마당', title: '축산 분뇨처리 개선 지원', agency: 'A', summary: '', endsOn: '2026-09-02', detailUrl: 'https://www.bizinfo.go.kr/x' },
    { id: 'b', source: 'g2b', sourceLabel: '나라장터', title: '수산물 납품 용역 입찰', agency: 'B', summary: '', endsOn: '2026-11-30', detailUrl: 'https://www.g2b.go.kr/y' },
  ]
  const supportProgramService = { sources: ['kstartup', 'bizinfo', 'g2b', 'ulsan'], list: async () => ({ items, syncedAt: null, stale: false, sources: {}, officialLinks: [] }) }
  await withServer(createApp({ apiKey: '', supportProgramService }), async (origin) => {
    const session = await login(origin)
    const headers = { cookie: session.cookie, 'x-workspace-identity': session.identity }
    // 햇살바다는 식품제조 기본 키워드(급식·수산물 납품·식품 R&D)를 쓴다.
    const recommended = await (await fetch(`${origin}/api/support-programs?limit=5`, { headers })).json()
    assert.deepEqual(recommended.items.map((item) => item.id), ['b', 'a'], '마감이 멀어도 관련성 높은 건이 위로 온다')
    assert.ok(recommended.items[0].relevance.score > recommended.items[1].relevance.score)
    assert.match(recommended.items[0].relevance.reasons[0], /감시 키워드 '수산물 납품' 일치/)
    assert.deepEqual(recommended.items[1].relevance.reasons, ['일치하는 감시 조건이 없습니다'])
    assert.deepEqual(recommended.profile.keywords, ['급식', '수산물 납품', '식품 R&D'])

    const byDeadline = await (await fetch(`${origin}/api/support-programs?limit=5&sort=deadline`, { headers })).json()
    assert.deepEqual(byDeadline.items.map((item) => item.id), ['a', 'b'])
    assert.equal(byDeadline.sort, 'deadline')
  })
})

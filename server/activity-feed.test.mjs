import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createApp } from './app.mjs'
import { withServer } from './test-server.mjs'
import { buildActivityFeed } from './activity-feed.mjs'

const NOW = new Date('2026-09-01T06:00:00.000Z')
const admin = { id: 'U-ADMIN', role: 'tenant-admin', tenantId: 'T1' }
const member = { id: 'U-MEMBER', role: 'tenant-member', tenantId: 'T1' }

const store = {
  'work-items': { data: [
    { id: 'WK-1', title: '급식 납품 견적', owner: '오태식', ownerId: 'U-MEMBER', requestedBy: '김서원', requesterId: 'U-ADMIN', createdAt: '2026-09-01T01:00:00.000Z',
      completion: { submittedAt: '2026-09-01T02:00:00.000Z', submittedByName: '오태식' },
      review: { decision: 'approved', reviewedAt: '2026-09-01T03:00:00.000Z', reviewerName: '김서원' } },
    { id: 'WK-2', title: '남의 업무', owner: '박지현', ownerId: 'U-OTHER', requestedBy: '김서원', requesterId: 'U-ADMIN', createdAt: '2026-09-01T04:00:00.000Z' },
    { id: 'WK-3', title: '미래에서 온 업무', owner: '오태식', ownerId: 'U-MEMBER', requestedBy: '김서원', requesterId: 'U-ADMIN', createdAt: '2027-01-01T00:00:00.000Z' },
  ] },
  'daily-journals': { data: [
    { id: 'JN-1', author: '오태식', authorId: 'U-MEMBER', date: '2026-09-01', status: '결재요청', submittedAt: '2026-09-01T05:00:00.000Z' },
    { id: 'JN-2', author: '박지현', authorId: 'U-OTHER', date: '2026-09-01', status: '임시저장', submittedAt: '2026-09-01T05:30:00.000Z' },
  ] },
  'ai-proposals': { data: [
    { id: 'PRP-1', kind: 'sentinel-task', status: 'pending', summary: 'HACCP 인증 만료 D-7', evidence: '만료 2026-09-08', createdAt: '2026-09-01T05:45:00.000Z' },
    { id: 'PRP-2', kind: 'document-classification', status: 'approved', summary: '문서 분류 제안', evidence: '패턴 일치', createdAt: '2026-09-01T00:30:00.000Z', decidedAt: '2026-09-01T05:50:00.000Z', decidedByName: '김서원' },
  ] },
  opportunities: { data: [
    { id: 'OPP-1', title: '학교 급식 식자재 납품', source: '나라장터', deadline: '2026-10-15', status: 'queued', receivedAt: '2026-09-01T05:55:00.000Z' },
    { id: 'OPP-2', title: '기준 미만 건', source: '기업마당', status: 'below-threshold', receivedAt: '2026-09-01T05:56:00.000Z' },
  ] },
}

test('the feed is newest first and never shows a row dated in the future', () => {
  const feed = buildActivityFeed(store, admin, { now: NOW, limit: 20 })
  assert.deepEqual(feed.slice(0, 4).map((row) => row.kind), ['opportunity-new', 'proposal-decided', 'sentinel-warning', 'journal-submitted'])
  assert.equal(feed.some((row) => row.id === 'act:work-created:WK-3'), false, '미래 시각 행은 맨 위를 차지하지 않는다')
  // 한 업무의 생성·보고·승인이 각각 한 줄이다.
  assert.deepEqual(
    feed.filter((row) => row.focusId === 'WK-1').map((row) => row.kind).sort(),
    ['work-approved', 'work-created', 'work-submitted'],
  )
})

test('every row says where clicking goes', () => {
  for (const row of buildActivityFeed(store, admin, { now: NOW, limit: 40 })) {
    assert.ok(row.page, `${row.kind}에 이동할 화면이 없다`)
    assert.ok(row.focusId, `${row.kind}에 이동할 항목이 없다`)
    assert.ok(row.title)
  }
})

test('an ordinary employee sees only their own work and journals, and no approval-queue rows at all', () => {
  const feed = buildActivityFeed(store, member, { now: NOW, limit: 40 })
  assert.equal(feed.some((row) => row.focusId === 'WK-2'), false, '남의 업무는 보이지 않는다')
  assert.equal(feed.some((row) => row.focusId === 'JN-2'), false, '남의 일지는 보이지 않는다')
  assert.equal(feed.some((row) => ['proposal-created', 'proposal-decided', 'sentinel-warning', 'opportunity-new'].includes(row.kind)), false,
    '읽을 수 없는 자료가 피드로 새지 않는다')
  assert.ok(feed.some((row) => row.focusId === 'WK-1'))
  assert.ok(feed.some((row) => row.focusId === 'JN-1'))
})

test('only queued opportunities and submitted journals reach the feed', () => {
  const feed = buildActivityFeed(store, admin, { now: NOW, limit: 40 })
  assert.equal(feed.some((row) => row.focusId === 'OPP-2'), false, '기준 미만 기회는 피드에 올리지 않는다')
  assert.equal(feed.some((row) => row.focusId === 'JN-2'), false, '임시저장 일지는 제출이 아니다')
})

test('an empty workspace produces an empty feed rather than invented rows', () => {
  assert.deepEqual(buildActivityFeed({}, admin, { now: NOW }), [])
  assert.deepEqual(buildActivityFeed(undefined, admin, { now: NOW }), [])
})

test('the route serves the feed and enforces the same permission split', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inthefield-activity-'))
  try {
    await withServer(createApp({ apiKey: '', workspaceStoreFile: path.join(directory, 'state.json') }), async (origin) => {
      const login = async (email) => {
        const response = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'demo1234' }) })
        const account = (await response.json()).account
        return { account, headers: { cookie: response.headers.get('set-cookie'), 'x-workspace-identity': `${account.tenantId}:${account.id}`, 'content-type': 'application/json' } }
      }
      const adminSession = await login('admin@sunsea.co.kr')
      const memberSession = await login('taesik.oh@sunsea.co.kr')

      assert.equal((await fetch(`${origin}/api/activity`)).status, 401)
      const adminFeed = await (await fetch(`${origin}/api/activity?limit=40`, { headers: adminSession.headers })).json()
      const memberFeed = await (await fetch(`${origin}/api/activity?limit=40`, { headers: memberSession.headers })).json()
      assert.ok(Array.isArray(adminFeed.items))
      assert.equal(memberFeed.items.some((row) => ['proposal-created', 'sentinel-warning', 'opportunity-new'].includes(row.kind)), false)
      // limit은 상한을 넘지 못한다.
      const capped = await (await fetch(`${origin}/api/activity?limit=999`, { headers: adminSession.headers })).json()
      assert.ok(capped.items.length <= 40)
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { createApp } from './app.mjs'
import { withServer } from './test-server.mjs'

const TENANT_ID = 'TENANT-SUNSEA'
const ADMIN_ID = 'USR-SUNSEA-ADMIN'
const OH_ID = 'USR-SUNSEA-OH'
const UNIQUE_ID = 'USR-SUNSEA-PARK'
const DUPLICATE_IDS = ['USR-SUNSEA-DUP-A', 'USR-SUNSEA-DUP-B']
const DUPLICATE_NAME = '오태식'
const UNIQUE_NAME = '박지현'

const journal = (id, author, completed) => ({
  id, date: '2026-08-21', title: `2026-08-21_${author}_업무일지`, author, department: '생산 1팀',
  completed, issue: '', nextPlan: '', approver: '김서원', status: '임시저장',
  updatedAt: '2026-08-21T00:00:00.000Z', feedback: '', attachments: [], reviews: [],
})

const leave = (id, name, reason) => ({
  id, name, team: '생산 1팀', type: '연차', period: '2099-01-07', days: 1,
  reason, approverId: ADMIN_ID, approverName: '김서원', status: '결재대기',
  requestedAt: '2026-08-21T00:00:00.000Z', updatedAt: '2026-08-21T00:00:00.000Z',
})

function fixture() {
  const now = new Date().toISOString()
  return {
    version: 2,
    tenants: {
      [TENANT_ID]: {
        'daily-journals': { data: [
          journal('J-AMBIGUOUS', DUPLICATE_NAME, '동명이인 비공개 일지'),
          journal('J-UNIQUE-UPDATE', UNIQUE_NAME, '고유 사용자 수정 대상'),
          journal('J-UNIQUE-DELETE', UNIQUE_NAME, '고유 사용자 삭제 대상'),
        ], updatedAt: now, updatedBy: 'legacy-import' },
        'leave-requests': { data: [
          leave('L-AMBIGUOUS', DUPLICATE_NAME, '동명이인 비공개 휴가'),
          leave('L-UNIQUE-UPDATE', UNIQUE_NAME, '고유 사용자 수정 대상'),
          leave('L-UNIQUE-DELETE', UNIQUE_NAME, '고유 사용자 삭제 대상'),
        ], updatedAt: now, updatedBy: 'legacy-import' },
        'work-items': { data: [
          { id: 'WK-AMBIGUOUS-OWNER', title: '동명이인 완료업무 비공개', owner: DUPLICATE_NAME, ownerId: 'oh', status: '결재완료', completion: { summary: '다른 동명이인의 완료 내용', submittedAt: now } },
          { id: 'WK-AMBIGUOUS-REVIEW', title: '동명이인 결재 비공개', owner: UNIQUE_NAME, ownerId: UNIQUE_ID, status: '결재완료', review: { decision: 'approved', comment: '다른 동명이인의 결재 내용', reviewedAt: now, reviewerId: 'oh', reviewerName: DUPLICATE_NAME } },
          { id: 'WK-UNIQUE-OWNER', title: '고유 사용자 완료업무', owner: UNIQUE_NAME, ownerId: 'park', status: '결재완료', completion: { summary: '고유 사용자의 완료 내용', submittedAt: now } },
        ], updatedAt: now, updatedBy: 'legacy-import' },
        'calendar-events': { data: [{
          id: 'CAL-AMBIGUOUS-ALIAS', title: '동명이인 개인 일정', date: '2099-01-07', start: '09:00', end: '10:00',
          scope: 'personal', department: '생산 1팀', location: '', owner: DUPLICATE_NAME, ownerId: 'oh', note: 'legacy alias',
        }], updatedAt: now, updatedBy: 'legacy-import' },
        'messenger-conversations': { data: [{
          id: 'DIRECT-AMBIGUOUS-ALIAS', type: 'direct', name: '김서원', subtitle: '경영지원 · 운영 관리자',
          memberId: ADMIN_ID, participantIds: [ADMIN_ID, 'oh'], hiddenFor: [], lifecycle: 'active', unread: 0,
          lastMessage: '동명이인 비공개 대화', lastTime: '방금', messages: [],
        }], updatedAt: now, updatedBy: 'legacy-import' },
      },
    },
    platform: {}, accountApprovals: {}, accountCredentials: {}, invitedAccounts: [], passwordResetRequests: [],
    accounts: DUPLICATE_IDS.map((id, index) => ({
      id, name: DUPLICATE_NAME, email: `same-name-${index + 1}@sunsea.co.kr`, role: 'tenant-member',
      tenantId: TENANT_ID, tenantName: '햇살바다', team: '생산 1팀', jobRole: '생산 작업자',
      approved: true, approvalStatus: 'approved', requested: 'legacy-test',
    })),
  }
}

function testSessions() {
  const expiresAt = Date.now() + 60_000
  return new Map([
    ['admin-session', { accountId: ADMIN_ID, expiresAt }],
    ['oh-session', { accountId: OH_ID, expiresAt }],
    ['unique-session', { accountId: UNIQUE_ID, expiresAt }],
    ['dup-a-session', { accountId: DUPLICATE_IDS[0], expiresAt }],
    ['dup-b-session', { accountId: DUPLICATE_IDS[1], expiresAt }],
  ])
}

const cookie = (token) => `onfactory_session=${token}`
const scope = (accountId) => `${TENANT_ID}:${accountId}`
const headers = (token, accountId, json = false) => ({
  cookie: cookie(token), 'x-workspace-identity': scope(accountId), ...(json ? { 'content-type': 'application/json' } : {}),
})

async function workspace(origin, token, accountId, key) {
  const response = await fetch(`${origin}/api/workspace/${key}`, { headers: headers(token, accountId) })
  const body = await response.json()
  assert.equal(response.status, 200, JSON.stringify(body))
  return body
}

test('duplicate active names never confer legacy journal, leave, or AI-evidence ownership', async () => {
  const store = fixture()
  const app = createApp({
    apiKey: '', initialWorkspaceStore: store, sessions: testSessions(),
    skipStartupMigrations: true, seedPlatformFixtures: false,
  })
  await withServer(app, async (origin) => {
    for (const [token, accountId] of [['oh-session', OH_ID], ['dup-a-session', DUPLICATE_IDS[0]], ['dup-b-session', DUPLICATE_IDS[1]]]) {
      assert.deepEqual((await workspace(origin, token, accountId, 'daily-journals')).data, [])
      assert.deepEqual((await workspace(origin, token, accountId, 'leave-requests')).data, [])
      assert.deepEqual((await workspace(origin, token, accountId, 'calendar-events')).data, [])
      assert.deepEqual((await workspace(origin, token, accountId, 'messenger-conversations')).data, [])

      const legacyJournal = store.tenants[TENANT_ID]['daily-journals'].data.find((item) => item.id === 'J-AMBIGUOUS')
      const draftWrite = await fetch(`${origin}/api/daily-journals/J-AMBIGUOUS/draft`, {
        method: 'PUT', headers: headers(token, accountId, true), body: JSON.stringify({ journal: legacyJournal }),
      })
      assert.equal(draftWrite.status, 403)

      const claimWrite = await fetch(`${origin}/api/workspace/daily-journals`, {
        method: 'PUT', headers: headers(token, accountId, true),
        body: JSON.stringify({ data: [{ ...legacyJournal, authorId: accountId }] }),
      })
      assert.equal(claimWrite.status, 403)

      for (const method of ['PATCH', 'DELETE']) {
        const leaveWrite = await fetch(`${origin}/api/leave-requests/L-AMBIGUOUS`, {
          method, headers: headers(token, accountId, method === 'PATCH'),
          ...(method === 'PATCH' ? { body: JSON.stringify({ type: '연차', period: '2099-01-08', days: 1, reason: '동명이인 공격' }) } : {}),
        })
        assert.equal(leaveWrite.status, 403, `${method} must reject duplicate-name ownership`)
      }

      const draft = await fetch(`${origin}/api/daily-journals/draft`, { method: 'POST', headers: headers(token, accountId) })
      const draftBody = await draft.json()
      assert.equal(draft.status, 200, JSON.stringify(draftBody))
      assert.equal(draftBody.sourceCount, 0)
      assert.deepEqual(draftBody.sources, [])
    }

    const adminJournals = await workspace(origin, 'admin-session', ADMIN_ID, 'daily-journals')
    const adminLeaves = await workspace(origin, 'admin-session', ADMIN_ID, 'leave-requests')
    assert.ok(adminJournals.data.some((item) => item.id === 'J-AMBIGUOUS' && !item.authorId))
    assert.ok(adminLeaves.data.some((item) => item.id === 'L-AMBIGUOUS' && !item.requesterId))
  })
})

test('a unique active name is safely backfilled and can use journal and leave lifecycle actions', async () => {
  const store = fixture()
  await withServer(createApp({
    apiKey: '', initialWorkspaceStore: store, sessions: testSessions(),
    skipStartupMigrations: true, seedPlatformFixtures: false,
  }), async (origin) => {
    const journals = await workspace(origin, 'unique-session', UNIQUE_ID, 'daily-journals')
    assert.deepEqual(journals.data.map((item) => item.authorId), [UNIQUE_ID, UNIQUE_ID])
    const leaves = await workspace(origin, 'unique-session', UNIQUE_ID, 'leave-requests')
    assert.deepEqual(leaves.data.map((item) => item.requesterId), [UNIQUE_ID, UNIQUE_ID])

    const uniqueJournal = journals.data.find((item) => item.id === 'J-UNIQUE-UPDATE')
    const draftWrite = await fetch(`${origin}/api/daily-journals/${uniqueJournal.id}/draft`, {
      method: 'PUT', headers: headers('unique-session', UNIQUE_ID, true),
      body: JSON.stringify({ journal: { ...uniqueJournal, completed: '안전하게 본인 일지를 수정했습니다.', draftRevision: 1 } }),
    })
    const draftBody = await draftWrite.json()
    assert.equal(draftWrite.status, 200, JSON.stringify(draftBody))
    assert.equal(draftBody.journal.authorId, UNIQUE_ID)

    const deleteOwnDraft = await fetch(`${origin}/api/workspace/daily-journals`, {
      method: 'PUT', headers: headers('unique-session', UNIQUE_ID, true), body: JSON.stringify({ data: [draftBody.journal] }),
    })
    assert.equal(deleteOwnDraft.status, 200, await deleteOwnDraft.text())
    const afterDelete = await workspace(origin, 'admin-session', ADMIN_ID, 'daily-journals')
    assert.ok(afterDelete.data.some((item) => item.id === 'J-AMBIGUOUS'))
    assert.ok(!afterDelete.data.some((item) => item.id === 'J-UNIQUE-DELETE'))

    const updateLeave = await fetch(`${origin}/api/leave-requests/L-UNIQUE-UPDATE`, {
      method: 'PATCH', headers: headers('unique-session', UNIQUE_ID, true),
      body: JSON.stringify({ type: '연차', period: '2099-01-08', days: 1, reason: '고유 사용자 수정 성공' }),
    })
    const updatedLeave = await updateLeave.json()
    assert.equal(updateLeave.status, 200, JSON.stringify(updatedLeave))
    assert.equal(updatedLeave.leave.requesterId, UNIQUE_ID)

    const deleteLeave = await fetch(`${origin}/api/leave-requests/L-UNIQUE-DELETE`, {
      method: 'DELETE', headers: headers('unique-session', UNIQUE_ID),
    })
    assert.equal(deleteLeave.status, 200, await deleteLeave.text())

    const draft = await fetch(`${origin}/api/daily-journals/draft`, { method: 'POST', headers: headers('unique-session', UNIQUE_ID) })
    const grounded = await draft.json()
    assert.equal(draft.status, 200, JSON.stringify(grounded))
    assert.ok(grounded.sourceCount >= 1)
    assert.ok(grounded.sources.some((source) => source.id === 'WK-UNIQUE-OWNER'))
    assert.ok(!grounded.sources.some((source) => source.id.startsWith('WK-AMBIGUOUS')))
  })
})

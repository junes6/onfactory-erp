import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { newDb } from 'pg-mem'

import { createApp } from '../app.mjs'
import { withServer } from '../test-server.mjs'
import { seedDemo } from '../../scripts/seed-demo.mjs'
import { PostgresStoreAdapter } from './postgres-store.mjs'

const SEED_PASSWORD = 'Demo-Seed!2026'

async function login(origin, email) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: 'tenant', email, password: SEED_PASSWORD }),
  })
  assert.equal(response.status, 200, await response.text())
  return response.headers.get('set-cookie')
}

function appFor(adapter, workspaceStore, sessions, documentUploadDirectory) {
  return createApp({
    apiKey: '',
    initialWorkspaceStore: workspaceStore,
    sessions,
    documentUploadDirectory,
    seedPlatformFixtures: false,
    seedDemoAccounts: false,
    skipStartupMigrations: true,
    onWorkspaceStoreChange: (store) => adapter.commitSnapshot(store, { referenceDate: '2026-08-20' }),
  })
}

async function runPostgresAppFlow(pool) {
  await seedDemo({
    fixturePath: path.resolve('worker/initial-workspace-state.json'),
    password: SEED_PASSWORD,
    requirePasswordChange: false,
    referenceDate: '2026-08-20',
    pool,
  })
  const adapter = new PostgresStoreAdapter({ pool })
  await adapter.connect()
  const documentUploadDirectory = await mkdtemp(path.join(os.tmpdir(), 'onfactory-pg-app-'))
  let adminCookie
  try {
    const initial = await adapter.loadSnapshot()
    const sessions = await adapter.createSessionMap()
    await withServer(appFor(adapter, initial, sessions, documentUploadDirectory), async (origin) => {
      adminCookie = await login(origin, 'admin@sunsea.co.kr')
      const memberCookie = await login(origin, 'taesik.oh@sunsea.co.kr')

      const work = {
        id: 'WK-PG-INTEGRATION', title: 'Postgres 전이 검증', description: '저장 후 재시작 상태를 확인합니다.',
        owner: '오태식', ownerId: 'USR-SUNSEA-OH', requestedBy: '김서원', requesterId: 'USR-SUNSEA-ADMIN',
        due: '2026-08-20T09:00:00.000Z', priority: '높음', status: '업무요청', category: '품질',
      }
      const createWork = await fetch(`${origin}/api/workspace/work-items`, {
        method: 'PUT', headers: { 'content-type': 'application/json', cookie: adminCookie }, body: JSON.stringify({ data: [work] }),
      })
      assert.equal(createWork.status, 200, await createWork.text())
      const accept = await fetch(`${origin}/api/work-items/${work.id}/transition`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie: memberCookie }, body: JSON.stringify({ action: 'accept' }),
      })
      assert.equal(accept.status, 200, await accept.text())
      const submit = await fetch(`${origin}/api/work-items/${work.id}/transition`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie: memberCookie },
        body: JSON.stringify({ action: 'submit', completion: { summary: 'Postgres 재시작 검증을 완료했습니다.', evidence: [] } }),
      })
      assert.equal(submit.status, 200, await submit.text())

      const upload = await fetch(`${origin}/api/documents?name=${encodeURIComponent('PG_업무일지.txt')}&category=${encodeURIComponent('일일업무일지')}&visibility=restricted`, {
        method: 'POST',
        headers: { cookie: memberCookie, 'content-type': 'application/octet-stream', 'x-file-type': 'text/plain', 'x-file-name': encodeURIComponent('PG_업무일지.txt') },
        body: Buffer.from('Postgres journal attachment', 'utf8'),
      })
      assert.equal(upload.status, 201, await upload.clone().text())
      const document = (await upload.json()).document

      const currentJournalsResponse = await fetch(`${origin}/api/workspace/daily-journals`, { headers: { cookie: memberCookie } })
      assert.equal(currentJournalsResponse.status, 200)
      const currentJournals = (await currentJournalsResponse.json()).data ?? []
      const journal = {
        id: 'JR-PG-INTEGRATION', date: '2026-08-20', title: '2026-08-20_오태식_업무일지', author: '오태식', department: '생산 1팀',
        completed: 'Postgres 통합 검증', issue: '', nextPlan: '재시작 후 조회', approver: '김서원', status: '결재요청',
        updatedAt: '2026-08-20T06:00:00.000Z', feedback: '', attachments: [{ id: document.id, name: document.name, size: '27 B' }], reviews: [],
      }
      const submitJournal = await fetch(`${origin}/api/workspace/daily-journals`, {
        method: 'PUT', headers: { 'content-type': 'application/json', cookie: memberCookie }, body: JSON.stringify({ data: [...currentJournals, journal] }),
      })
      assert.equal(submitJournal.status, 200, await submitJournal.text())

      const direct = await fetch(`${origin}/api/messenger/conversations/direct`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie: adminCookie },
        body: JSON.stringify({ participantId: 'USR-SUNSEA-OH' }),
      })
      assert.ok([200, 201].includes(direct.status), await direct.clone().text())
      const room = (await direct.json()).conversation
      const message = await fetch(`${origin}/api/messenger/conversations/${room.id}/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie: adminCookie },
        body: JSON.stringify({ text: 'Postgres 영속 메시지입니다.' }),
      })
      assert.equal(message.status, 201, await message.text())
    })

    await sessions.flush()
    await adapter.flush()
    const restartedAdapter = new PostgresStoreAdapter({ pool })
    await restartedAdapter.connect()
    const restarted = await restartedAdapter.loadSnapshot()
    const tenant = restarted.tenants['TENANT-SUNSEA']
    assert.equal(tenant['work-items'].data.find((item) => item.id === 'WK-PG-INTEGRATION').status, '결재대기')
    const journal = tenant['daily-journals'].data.find((item) => item.id === 'JR-PG-INTEGRATION')
    assert.equal(journal.status, '결재요청')
    assert.match(journal.submittedAt, /^\d{4}-\d{2}-\d{2}T/)
    const persistedMessage = tenant['messenger-conversations'].data.flatMap((room) => room.messages ?? []).find((message) => message.text === 'Postgres 영속 메시지입니다.')
    assert.match(persistedMessage.createdAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.ok(tenant['company-documents'].data.some((document) => document.name === 'PG_업무일지.txt'))

    const eventTypes = new Set((await pool.query('SELECT event_type FROM events')).rows.map((row) => row.event_type))
    for (const type of ['work.created', 'work.transitioned', 'journal.submitted', 'messenger.message_created', 'document.uploaded']) assert.ok(eventTypes.has(type), type)

    const restartedSessions = await restartedAdapter.createSessionMap()
    await withServer(appFor(restartedAdapter, restarted, restartedSessions, documentUploadDirectory), async (origin) => {
      const session = await fetch(`${origin}/api/auth/session`, { headers: { cookie: adminCookie } })
      assert.equal(session.status, 200, await session.clone().text())
      assert.equal((await session.json()).account.isDemo, true)
    })
    await restartedAdapter.close()
  } finally {
    await adapter.close()
    await rm(documentUploadDirectory, { recursive: true, force: true })
  }
}

test('PostgresStoreAdapter -> createApp preserves authenticated state machines across restart', async () => {
  const memory = newDb({ autoCreateForeignKeyIndices: true })
  const pg = memory.adapters.createPg()
  const pool = new pg.Pool()
  try { await runPostgresAppFlow(pool) } finally { await pool.end() }
})

test('real Postgres runs the same adapter-to-app flow when explicitly enabled', {
  skip: !(process.env.DATABASE_URL && process.env.RUN_POSTGRES_E2E === 'true'),
}, async () => {
  const pg = await import('pg')
  const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL })
  try { await runPostgresAppFlow(pool) } finally { await pool.end() }
})

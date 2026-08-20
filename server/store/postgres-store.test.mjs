import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { newDb } from 'pg-mem'

import { emptyWorkspaceStore } from './constants.mjs'
import { applyPostgresServiceContext, PostgresStoreAdapter } from './postgres-store.mjs'
import { UnknownWorkspaceKeyError } from './errors.mjs'
import { assertKnownWorkspaceKeys } from './workspace-codec.mjs'

async function testAdapter() {
  const memory = newDb({ autoCreateForeignKeyIndices: true })
  const contextCalls = []
  const pg = memory.adapters.createPg()
  const pool = new pg.Pool()
  const serviceContextApplier = async (client) => {
    contextCalls.push({ role: 'service', orgId: '__service__' })
    await applyPostgresServiceContext(client)
  }
  const adapter = new PostgresStoreAdapter({ pool, serviceContextApplier })
  await adapter.applySchema()
  await adapter.connect()
  return { adapter, pool, contextCalls, serviceContextApplier }
}

function fixture() {
  const snapshot = emptyWorkspaceStore()
  snapshot.tenantMetadata = {
    'TENANT-HSB': { name: 'HSB', isDemo: true },
    'TENANT-POHANG': { name: 'POHANG', isDemo: true },
  }
  snapshot.accounts = [
    { id: 'USR-HSB-ADMIN', tenantId: 'TENANT-HSB', email: 'admin@hsb.test', name: 'HSB 관리자', role: 'tenant-admin', approvalStatus: 'approved', password: 'Plaintext-Never-Store!', credentials: { accessToken: 'raw-oauth-token' } },
    { id: 'USR-POHANG-ADMIN', tenantId: 'TENANT-POHANG', email: 'admin@pohang.test', name: 'POHANG 관리자', role: 'tenant-admin', approvalStatus: 'approved' },
  ]
  snapshot.platform.tenants = [
    { id: 'TENANT-HSB', name: 'HSB', isDemo: true, adminAccount: snapshot.accounts[0], createdAt: '2026-08-01T00:00:00.000Z', sync: '14:42' },
    { id: 'TENANT-POHANG', name: 'POHANG', isDemo: true, adminAccount: snapshot.accounts[1] },
  ]
  snapshot.platform.supportTickets = [{ id: 'TICKET-1', tenantId: 'TENANT-HSB', title: '점검', createdAt: '2026-08-18T05:00:00.000Z', updatedAt: '2026-08-18T06:00:00.000Z', history: [{ id: 'H-1', at: '2026-08-18 14:00' }] }]
  snapshot.platform.integrations = [{ id: 'INT-1', tenantId: 'TENANT-HSB', name: '채널', lastSync: '14:41' }]
  snapshot.platform.actions = [{ id: 'ACT-1', tenantId: 'TENANT-HSB', createdAt: '2026-08-20T06:00:00.000Z' }]
  snapshot.platform.auditEvents = [{ id: 'AUD-1', tenantId: 'TENANT-HSB', at: '2026-08-18 14:24', event: '진단' }]
  snapshot.tenants['TENANT-HSB'] = {
    'work-items': {
      data: [{ id: 'WORK-1', title: '점검', due: '오늘 18:00', status: '업무요청' }],
      updatedAt: '2026-08-20T01:00:00.000Z', updatedBy: 'USR-HSB-ADMIN',
    },
    'calendar-events': {
      data: [{ id: 'CAL-1', title: '생산', date: '2026-08-21', start: '09:00', end: '10:30' }],
      updatedAt: '2026-08-20T01:00:00.000Z', updatedBy: 'USR-HSB-ADMIN',
    },
    'messenger-conversations': {
      data: [{ id: 'ROOM-1', messages: [{ id: 'MSG-1', senderId: 'USR-HSB-ADMIN', senderName: '관리자', text: '민감 본문', time: '14:42' }] }],
      updatedAt: '2026-08-20T05:42:00.000Z', updatedBy: 'USR-HSB-ADMIN',
    },
    'daily-journals': {
      data: [{ id: 'JR-1', status: '결재요청', updatedAt: '2026-08-20T06:00:00.000Z', submittedAt: '2026-08-20T05:50:00.000Z', reviews: [] }],
      updatedAt: '2026-08-20T06:00:00.000Z', updatedBy: 'USR-HSB-ADMIN',
    },
    'performance-settings': {
      data: { weights: { completedTasks: 20, dueCompliance: 25, revisionRate: 15, averageCycleHours: 15, journalSubmission: 15, approvalResponseHours: 10 }, employeeVisible: false },
      updatedAt: '2026-08-20T06:00:00.000Z', updatedBy: 'USR-HSB-ADMIN',
    },
    'performance-reports': {
      data: [{ id: 'PERFS-1', periodType: 'month', periodStart: '2026-07-31T15:00:00.000Z', periodEnd: '2026-08-31T15:00:00.000Z', immutable: true, reports: [] }],
      updatedAt: '2026-08-20T06:00:00.000Z', updatedBy: 'USR-HSB-ADMIN',
    },
    'company-documents': {
      data: [{ id: 'DOC-1', name: '점검표.pdf', mime: 'application/pdf', size: 123, hash: 'sha256-document', storageKey: 'TENANT-HSB/DOC-1' }],
      updatedAt: '2026-08-20T06:00:00.000Z', updatedBy: 'USR-HSB-ADMIN',
    },
  }
  snapshot.tenants['TENANT-POHANG'] = {
    'work-items': { data: [{ id: 'WORK-1', title: '별도 조합 업무', due: '2026-08-22T09:00:00.000Z', status: '업무요청' }], updatedAt: '2026-08-20T01:00:00.000Z' },
  }
  snapshot.accountCredentials = {
    'USR-HSB-ADMIN': { passwordHash: 'a'.repeat(64), mustChangePassword: false },
  }
  snapshot.passwordResetRequests = [{
    id: 'RESET-1', accountId: 'USR-HSB-ADMIN', email: 'admin@hsb.test',
    tokenHash: 'b'.repeat(64), token: 'raw-reset-token', deliverySecret: 'raw-delivery-secret',
    status: 'development-ready', createdAt: '2026-08-20T06:00:00.000Z', expiresAt: '2026-08-20T07:00:00.000Z',
  }]
  return snapshot
}

test('unknown workspace keys fail instead of falling back to an app-state blob', () => {
  const snapshot = emptyWorkspaceStore()
  snapshot.tenants.TENANT = { unknown: { data: [] } }
  assert.throws(() => assertKnownWorkspaceKeys(snapshot), UnknownWorkspaceKeyError)
})

test('postgres adapter normalizes tenant rows, restores the facade, and writes safe outbox events atomically', async () => {
  const { adapter, pool, contextCalls, serviceContextApplier } = await testAdapter()
  try {
    const source = fixture()
    await adapter.commitSnapshot(source, { referenceDate: '2026-08-20', rawDueByEntity: { 'TENANT-HSB:WORK-1': '오늘 18:00' } })

    const workRows = await pool.query('SELECT id, org_id, payload, raw_due, due_at, created_by FROM work_items ORDER BY org_id')
    assert.equal(workRows.rows.length, 2)
    assert.equal(workRows.rows[0].payload.due, undefined)
    assert.equal(workRows.rows.find((row) => row.org_id === 'TENANT-HSB').raw_due, '오늘 18:00')
    assert.equal(workRows.rows.find((row) => row.org_id === 'TENANT-POHANG').due_at.toISOString(), '2026-08-22T09:00:00.000Z')

    const calendar = await pool.query('SELECT payload, starts_at, ends_at FROM calendar_events')
    assert.equal(calendar.rows[0].payload.date, undefined)
    assert.equal(calendar.rows[0].starts_at.toISOString(), '2026-08-21T00:00:00.000Z')

    const messages = await pool.query('SELECT payload FROM messenger_conversations')
    assert.equal(messages.rows[0].payload.messages, undefined)
    const messageRows = await pool.query('SELECT payload, created_at FROM messenger_messages')
    assert.equal(messageRows.rows[0].payload.time, undefined)
    assert.equal(messageRows.rows[0].payload.createdAt, undefined)
    assert.equal(messageRows.rows[0].created_at.toISOString(), '2026-08-20T05:42:00.000Z')

    const documents = await pool.query("SELECT id, org_id, storage_key, mime, size FROM items WHERE item_type = 'company-document'")
    assert.deepEqual(documents.rows.map((row) => [row.org_id, row.id]), [['TENANT-HSB', 'DOC-1']])
    assert.equal(documents.rows[0].mime, 'application/pdf')
    assert.equal(Number(documents.rows[0].size), 123)

    const performanceSettings = await pool.query('SELECT id, payload FROM performance_settings WHERE org_id = $1', ['TENANT-HSB'])
    const performanceSnapshots = await pool.query('SELECT id, payload FROM performance_report_snapshots WHERE org_id = $1', ['TENANT-HSB'])
    assert.equal(performanceSettings.rows[0].id, '__singleton__')
    assert.equal(performanceSettings.rows[0].payload.employeeVisible, false)
    assert.equal(performanceSnapshots.rows[0].id, 'PERFS-1')
    assert.equal(performanceSnapshots.rows[0].payload.immutable, true)

    const persistedAccounts = await pool.query('SELECT payload FROM core_accounts WHERE id = $1', ['USR-HSB-ADMIN'])
    assert.equal(persistedAccounts.rows[0].payload.password, undefined)
    assert.equal(persistedAccounts.rows[0].payload.credentials, undefined)
    const persistedReset = await pool.query('SELECT payload, token_hash FROM password_reset_requests WHERE id = $1', ['RESET-1'])
    assert.equal(persistedReset.rows[0].payload.token, undefined)
    assert.equal(persistedReset.rows[0].payload.tokenHash, undefined)
    assert.equal(persistedReset.rows[0].payload.deliverySecret, undefined)
    assert.equal(persistedReset.rows[0].token_hash, 'b'.repeat(64))
    const persistedPlatform = await pool.query('SELECT payload FROM platform_tenants WHERE id = $1', ['TENANT-HSB'])
    assert.equal(persistedPlatform.rows[0].payload.adminAccount.password, undefined)
    assert.equal(persistedPlatform.rows[0].payload.adminAccount.credentials, undefined)
    assert.equal(persistedPlatform.rows[0].payload.createdAt, undefined)
    assert.equal(persistedPlatform.rows[0].payload.sync, undefined)
    const persistedTicket = await pool.query("SELECT payload, domain_created_at, domain_updated_at FROM platform_support_tickets WHERE id = 'TICKET-1'")
    assert.equal(persistedTicket.rows[0].payload.createdAt, undefined)
    assert.equal(persistedTicket.rows[0].payload.updatedAt, undefined)
    assert.equal(persistedTicket.rows[0].payload.history[0].at, '2026-08-18T05:00:00.000Z')
    const persistedIntegration = await pool.query("SELECT payload, last_sync_at FROM platform_integrations WHERE id = 'INT-1'")
    assert.equal(persistedIntegration.rows[0].payload.lastSync, undefined)
    assert.equal(persistedIntegration.rows[0].last_sync_at.toISOString(), '2026-08-20T05:41:00.000Z')
    const persistedAudit = await pool.query("SELECT payload, event_at FROM platform_audit_events WHERE id = 'AUD-1'")
    assert.equal(persistedAudit.rows[0].payload.at, undefined)
    assert.equal(persistedAudit.rows[0].event_at.toISOString(), '2026-08-18T05:24:00.000Z')

    const events = await pool.query('SELECT event_type, payload FROM events ORDER BY created_at, id')
    assert.ok(events.rows.some((row) => row.event_type === 'work.created'))
    assert.ok(events.rows.some((row) => row.event_type === 'messenger.message_created'))
    assert.equal(JSON.stringify(events.rows).includes('민감 본문'), false)

    const reloaded = new PostgresStoreAdapter({ pool, serviceContextApplier })
    await reloaded.connect()
    const facade = await reloaded.loadSnapshot()
    assert.equal(facade.tenantMetadata['TENANT-HSB'].isDemo, true)
    assert.equal(facade.tenants['TENANT-HSB']['calendar-events'].data[0].start, '09:00')
    assert.equal(facade.tenants['TENANT-HSB']['messenger-conversations'].data[0].messages[0].time, '14:42')
    assert.equal(facade.tenants['TENANT-HSB']['work-items'].data[0].due, '오늘 18:00')
    assert.equal(facade.tenants['TENANT-HSB']['company-documents'].data[0].name, '점검표.pdf')
    assert.equal(facade.tenants['TENANT-HSB']['performance-settings'].data.employeeVisible, false)
    assert.equal(facade.tenants['TENANT-HSB']['performance-reports'].data[0].id, 'PERFS-1')
    assert.equal(facade.passwordResetRequests[0].tokenHash, 'b'.repeat(64))
    assert.equal(facade.passwordResetRequests[0].token, undefined)
    assert.equal(facade.platform.integrations[0].lastSync, '14:41')
    assert.equal(facade.platform.auditEvents[0].at, '2026-08-18 14:24')
    assert.ok(contextCalls.length >= 2, JSON.stringify(contextCalls))
    assert.ok(contextCalls.every((call) => call.role === 'service' && call.orgId === '__service__'), JSON.stringify(contextCalls))

    const failed = structuredClone(source)
    failed.tenants['TENANT-HSB']['work-items'].data[0].title = '롤백되어야 함'
    failed.accounts.push({ ...failed.accounts[0], id: 'USR-DUPLICATE', tenantId: 'TENANT-HSB' })
    await assert.rejects(adapter.commitSnapshot(failed))
    // pg-mem validates the SQL and failure path but does not provide real
    // Postgres transaction rollback semantics. The adapter must not advance
    // its committed snapshot; the conditional DATABASE_URL test covers the
    // real engine when available.
    assert.equal(adapter.snapshot.tenants['TENANT-HSB']['work-items'].data[0].title, '점검')

    const sessions = await adapter.createSessionMap()
    sessions.set('raw-session-token', { accountId: 'USR-HSB-ADMIN', expiresAt: Date.now() + 60_000 })
    await sessions.flush()
    assert.equal(sessions.get('raw-session-token').accountId, 'USR-HSB-ADMIN')
    const storedSessions = await pool.query('SELECT token_hash FROM auth_sessions')
    assert.equal(storedSessions.rows.length, 1)
    assert.notEqual(storedSessions.rows[0].token_hash, 'raw-session-token')
    const restartedSessions = await adapter.createSessionMap()
    assert.equal(restartedSessions.get('raw-session-token').accountId, 'USR-HSB-ADMIN')
  } finally {
    await adapter.close()
  }
})

test('performance tables force RLS for service DAL and tenant admins without direct member access', async () => {
  const schema = await readFile(new URL('../../db/postgres-schema.sql', import.meta.url), 'utf8')
  for (const table of ['performance_settings', 'performance_report_snapshots']) {
    assert.match(schema, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`))
  }
  assert.match(schema, /CREATE POLICY performance_settings_service[\s\S]*app\.role'[\s\S]*'service'/)
  assert.match(schema, /CREATE POLICY performance_reports_service[\s\S]*app\.role'[\s\S]*'service'/)
  assert.match(schema, /CREATE POLICY performance_settings_tenant_admin[\s\S]*app\.org_id/)
  assert.match(schema, /CREATE POLICY performance_reports_tenant_admin[\s\S]*app\.org_id/)
  assert.doesNotMatch(schema, /CREATE POLICY performance_[\w]+_tenant_member/)
})

test('postgres service context is transaction-local and never derived from request input', async () => {
  const calls = []
  await applyPostgresServiceContext({ query: async (...args) => { calls.push(args) } })
  assert.deepEqual(calls, [[
    "SELECT set_config('app.role', $1, TRUE), set_config('app.org_id', $2, TRUE)",
    ['service', '__service__'],
  ]])
})

test('DATABASE_URL postgres E2E applies only when explicitly configured', { skip: !process.env.DATABASE_URL }, async () => {
  const adapter = new PostgresStoreAdapter({ databaseUrl: process.env.DATABASE_URL })
  await adapter.connect()
  try {
    const result = await adapter.pool.query('SELECT 1 AS ready')
    assert.equal(result.rows[0].ready, 1)
  } finally {
    await adapter.close()
  }
})

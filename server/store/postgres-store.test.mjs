import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'

import { newDb } from 'pg-mem'

import { emptyWorkspaceStore } from './constants.mjs'
import { JsonStoreAdapter } from './json-store.mjs'
import { applyPostgresGuestContext, applyPostgresServiceContext, PostgresStoreAdapter, withoutPgMemUnsupportedRls } from './postgres-store.mjs'
import { StoreVerificationError, UnknownWorkspaceKeyError } from './errors.mjs'
import { assertKnownWorkspaceKeys } from './workspace-codec.mjs'

const GUEST_TOKEN_HASH = 'c'.repeat(64)

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
      // WORK-2는 하위 업무. parentId는 payload JSONB 안에 그대로 남아야 한다(DDL 무변경).
      // R16-F: startAt도 같은 자리다 — raw_start/start_at 컬럼을 만들지 않으므로 WORK-2처럼
      // 시작일이 없던 행은 왕복 뒤에도 키가 없어야 한다(빈 문자열이 생기면 JSON 모드와 갈린다).
      // R16-K: fields(커스텀 필드 값)도 같다. 숫자가 문자열로 굳어 돌아오면 number 정의와 어긋나
      // 그 업무의 모든 저장이 CUSTOM_FIELD_TYPE으로 막힌다.
      data: [
        { id: 'WORK-1', title: '점검', due: '오늘 18:00', status: '업무요청', startAt: '2026-08-19T00:00:00.000Z', fields: { vendor: 'A', amount: 5 } },
        { id: 'WORK-2', title: '하위', parentId: 'WORK-1', status: '업무요청', due: '2026-08-22T09:00:00.000Z' },
      ],
      updatedAt: '2026-08-20T01:00:00.000Z', updatedBy: 'USR-HSB-ADMIN',
    },
    'calendar-events': {
      data: [{ id: 'CAL-1', title: '생산', date: '2026-08-21', start: '09:00', end: '10:30' }],
      updatedAt: '2026-08-20T01:00:00.000Z', updatedBy: 'USR-HSB-ADMIN',
    },
    // R16-J: 배열의 마지막 원소가 스레드 답글인 방. 채널 목록 시각(last_message_at)은
    // 답글이 아니라 본채널의 마지막 말에서 나와야 한다 — JSON 모드에서는 드러나지 않는 갈래다.
    'messenger-conversations': {
      data: [{
        id: 'ROOM-1',
        messages: [
          { id: 'MSG-1', senderId: 'USR-HSB-ADMIN', senderName: '관리자', text: '민감 본문', time: '14:42', replyCount: 1, lastReplyAt: '2026-08-20T06:10:00.000Z' },
          { id: 'MSG-2', senderId: 'USR-HSB-ADMIN', senderName: '관리자', text: '스레드 답글', time: '15:10', threadRootId: 'MSG-1' },
        ],
      }],
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
    // R16-B: 프로젝트 템플릿. 중첩 배열(tasks > children)까지 payload JSONB로 그대로 왕복해야 한다.
    'project-templates': {
      data: [{
        id: 'PT-1', name: '표준 진행', description: '', industryType: 'food_manufacturing', origin: 'custom', version: 1,
        roles: ['PM'], tasks: [{ key: 'a', title: '요구 정리', role: 'PM', dueOffsetDays: 7, priority: '높음', category: '제품', children: [{ key: 'a1', title: '인터뷰', role: 'PM', dueOffsetDays: 3, priority: '높음', category: '제품' }] }],
        channels: [], documentCategories: ['제품·표시사항'], rules: [], history: [], createdAt: '2026-08-20T06:00:00.000Z', updatedAt: '2026-08-20T06:00:00.000Z',
      }],
      updatedAt: '2026-08-20T06:00:00.000Z', updatedBy: 'USR-HSB-ADMIN',
    },
    // R16-D: 공지. 확인 명단과 리마인더 이력이 payload JSONB로 그대로 왕복해야 한다 —
    // 확인 기록이 왕복에서 사라지면 "누가 언제 확인했다"는 증거가 배포마다 리셋된다.
    'notices': {
      data: [{
        id: 'NTC-fixture-01', scope: 'project', conversationId: 'ROOM-1', projectId: 'PRJ-A',
        title: '점검 일정 공지', body: '첫 줄\n둘째 줄', attachments: [],
        authorId: 'USR-HSB-ADMIN', authorName: '관리자', mustRead: true,
        targetIds: ['USR-HSB-ADMIN', 'USR-TENANT-HSB-GUEST01'],
        acknowledgements: [{ accountId: 'USR-TENANT-HSB-GUEST01', at: '2026-08-20T07:00:00.000Z' }],
        reminders: { remindedAt: { 'USR-TENANT-HSB-GUEST01': '2026-08-20T08:00:00.000Z' }, summary48SentAt: null, lastManualRemindAt: null },
        archivedAt: null, createdAt: '2026-08-20T06:00:00.000Z', updatedAt: '2026-08-20T07:00:00.000Z',
      }],
      updatedAt: '2026-08-20T07:00:00.000Z', updatedBy: 'USR-HSB-ADMIN',
    },
    // R16-L: 외부 연동. tokenHash(sha256)와 signingSecretEnc(봉인문)가 왕복에서 살아남아야 한다 —
    // platform 컬렉션에 두면 stripSensitivePayload가 이 두 값을 지워 재기동 후 모든 수신 주소가 404가 된다.
    'webhook-endpoints': {
      data: [{
        id: 'WHK-fixture-01', direction: 'outbound', label: '주문 알림', conversationId: null, defaultOwnerId: null,
        tokenHash: null, tokenIssuedAt: null, url: 'https://hooks.example.com/inbound',
        events: ['work.transitioned'], signingSecretEnc: 'v1:aaaa:bbbb:cccc', enabled: true,
        consecutiveFailures: 0, disabledAt: null, createdById: 'USR-HSB-ADMIN',
        createdAt: '2026-08-20T06:00:00.000Z', updatedAt: '2026-08-20T06:00:00.000Z',
        lastDeliveredAt: null, lastReceivedAt: null, receivedCount: 0,
      }],
      updatedAt: '2026-08-20T06:00:00.000Z', updatedBy: 'USR-HSB-ADMIN',
    },
    'webhook-deliveries': {
      data: [{
        id: 'WHD-fixture-01', endpointId: 'WHK-fixture-01', channel: 'webhook', eventType: 'work.transitioned',
        eventId: 'work.transitioned:WORK-1:2026-08-20T06:05:00.000Z', aggregateId: 'WORK-1', target: 'hooks.example.com',
        status: 'failed', attempts: 1, nextAttemptAt: '2026-08-20T06:06:00.000Z', lastStatusCode: 503,
        lastError: '받는 쪽 응답 503', requestedAt: '2026-08-20T06:05:00.000Z', deliveredAt: null,
        payload: { id: 'WORK-1', title: '설비 점검', beforeState: '수행중', afterState: '결재대기', ownerId: 'USR-HSB-ADMIN' },
        actor: 'USR-HSB-ADMIN',
      }],
      updatedAt: '2026-08-20T06:05:00.000Z', updatedBy: 'system:webhook',
    },
    // R16-K: 저장된 보기와 커스텀 필드 정의. 닫힌 스키마의 중첩(filters·sort·options)이
    // payload JSONB로 그대로 왕복해야 한다 — 조건 하나가 왕복에서 사라지면 그 보기는 거짓말을 한다.
    'saved-views': {
      data: [{
        id: 'VIEW-fixture-01', surface: 'work', name: '내 지연 업무', mode: 'list',
        filters: { scope: 'mine', ownerIds: [], statuses: ['수행중'], priorities: [], categories: [], projectIds: [], originKinds: [], dueFrom: null, dueTo: '2026-09-30', dueWithinDays: null, overdueOnly: true, hasParent: null, text: '', fields: { vendor: ['A'] } },
        sort: { field: 'due', direction: 'asc' }, columns: ['owner', 'cf:vendor'], visibility: 'tenant',
        ownerId: 'USR-HSB-ADMIN', ownerName: 'HSB 관리자',
        createdAt: '2026-08-20T06:00:00.000Z', updatedAt: '2026-08-20T06:00:00.000Z',
      }],
      updatedAt: '2026-08-20T06:00:00.000Z', updatedBy: 'USR-HSB-ADMIN',
    },
    'custom-fields': {
      data: [{
        id: 'CF-fixture-01', surface: 'work', key: 'vendor', label: '거래처', type: 'select',
        options: ['A', 'B'], required: false, archivedAt: null, position: 0,
        createdAt: '2026-08-20T06:00:00.000Z', updatedAt: '2026-08-20T06:00:00.000Z',
      }],
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
  // A절: 외부 게스트. 계정은 invitedAccounts(role 'tenant-guest')에, 범위는 guestGrants에.
  snapshot.invitedAccounts = [{
    id: 'USR-TENANT-HSB-GUEST01', tenantId: 'TENANT-HSB', email: 'guest@partner.test', name: '거래처 게스트',
    role: 'tenant-guest', guestGrantId: 'GST-TENANT-HSB-000001', team: '파트너사', jobRole: '외부 게스트',
    approved: false, approvalStatus: 'pending',
  }]
  snapshot.guestGrants = [{
    id: 'GST-TENANT-HSB-000001', tenantId: 'TENANT-HSB', accountId: 'USR-TENANT-HSB-GUEST01',
    email: 'guest@partner.test', name: '거래처 게스트', orgName: '파트너사',
    projectIds: ['PRJ-A'], invitedById: 'USR-HSB-ADMIN', invitedByName: 'HSB 관리자', status: 'invited',
    tokenHash: GUEST_TOKEN_HASH, tokenIssuedAt: '2026-08-20T06:00:00.000Z', tokenExpiresAt: '2026-08-27T06:00:00.000Z',
    resendCount: 0, lastResentAt: null, accessExpiresAt: null,
    acceptedAt: null, revokedAt: null, revokedById: null, deactivatedAt: null,
    createdAt: '2026-08-20T06:00:00.000Z', updatedAt: '2026-08-20T06:00:00.000Z',
  }]
  snapshot.tenants['TENANT-HSB']['project-spaces'] = {
    data: [
      { id: 'PRJ-A', name: '공동 프로젝트', visibility: 'members', members: [{ id: 'USR-HSB-ADMIN', role: 'owner' }, { id: 'USR-TENANT-HSB-GUEST01', role: 'viewer' }] },
      { id: 'PRJ-B', name: '사내 프로젝트', visibility: 'company', members: [{ id: 'USR-HSB-ADMIN', role: 'owner' }] },
    ],
    updatedAt: '2026-08-20T06:00:00.000Z', updatedBy: 'USR-HSB-ADMIN',
  }
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
    assert.equal(workRows.rows.length, 3)
    assert.equal(workRows.rows[0].payload.due, undefined)
    assert.equal(workRows.rows.find((row) => row.id === 'WORK-1').raw_due, '오늘 18:00')
    assert.equal(workRows.rows.find((row) => row.id === 'WORK-2').payload.parentId, 'WORK-1', '하위 업무의 parentId는 payload로 왕복한다')
    assert.equal(workRows.rows.find((row) => row.id === 'WORK-1').payload.startAt, '2026-08-19T00:00:00.000Z', '시작일은 컬럼이 아니라 payload로 간다')
    await assert.rejects(pool.query('SELECT start_at FROM work_items'), 'start_at 컬럼을 만들지 않는다')
    assert.equal(workRows.rows.find((row) => row.org_id === 'TENANT-POHANG').due_at.toISOString(), '2026-08-22T09:00:00.000Z')

    const templateRows = await pool.query('SELECT id, org_id, payload FROM project_templates')
    assert.equal(templateRows.rows.length, 1)
    assert.equal(templateRows.rows[0].payload.tasks[0].children[0].key, 'a1', '템플릿의 하위 업무는 payload 안에 그대로 남는다')

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
    const roundTrippedRoom = facade.tenants['TENANT-HSB']['messenger-conversations'].data[0]
    assert.equal(roundTrippedRoom.messages[0].replyCount, 1, '루트의 답글 집계는 왕복에서 살아 있어야 한다')
    assert.equal(roundTrippedRoom.messages[0].lastReplyAt, '2026-08-20T06:10:00.000Z')
    assert.equal(roundTrippedRoom.messages[1].threadRootId, 'MSG-1', '답글의 루트 참조는 왕복에서 살아 있어야 한다')
    assert.equal(roundTrippedRoom.lastTime, '14:42', '채널 목록 시각은 답글(15:10)이 아니라 본채널 마지막 말에서 나온다')
    assert.equal(facade.tenants['TENANT-HSB']['work-items'].data[0].due, '오늘 18:00')
    assert.equal(facade.tenants['TENANT-HSB']['work-items'].data.find((row) => row.id === 'WORK-2').parentId, 'WORK-1')
    assert.equal(facade.tenants['TENANT-HSB']['work-items'].data.find((row) => row.id === 'WORK-1').startAt, '2026-08-19T00:00:00.000Z')
    assert.equal('startAt' in facade.tenants['TENANT-HSB']['work-items'].data.find((row) => row.id === 'WORK-2'), false, '시작일이 없던 행은 왕복 뒤에도 키가 없다')
    assert.deepEqual(facade.tenants['TENANT-HSB']['work-items'].data.find((row) => row.id === 'WORK-1').fields, { vendor: 'A', amount: 5 }, '커스텀 필드 값은 타입까지 그대로 왕복한다')
    assert.equal('fields' in facade.tenants['TENANT-HSB']['work-items'].data.find((row) => row.id === 'WORK-2'), false, '값이 없던 행은 왕복 뒤에도 fields 키가 없다')
    const roundTrippedView = facade.tenants['TENANT-HSB']['saved-views'].data[0]
    assert.equal(roundTrippedView.filters.overdueOnly, true)
    assert.deepEqual(roundTrippedView.filters.fields, { vendor: ['A'] }, '커스텀 필드 축이 왕복에서 사라지면 그 보기는 다른 뜻이 된다')
    assert.deepEqual(roundTrippedView.columns, ['owner', 'cf:vendor'])
    assert.deepEqual(facade.tenants['TENANT-HSB']['custom-fields'].data[0].options, ['A', 'B'])
    assert.equal(facade.tenants['TENANT-HSB']['project-templates'].data[0].tasks[0].children[0].title, '인터뷰')
    const roundTrippedNotice = facade.tenants['TENANT-HSB'].notices.data[0]
    assert.equal(roundTrippedNotice.body, '첫 줄\n둘째 줄', '공지 본문의 줄바꿈은 왕복에서 살아 있어야 한다')
    assert.deepEqual(roundTrippedNotice.acknowledgements, [{ accountId: 'USR-TENANT-HSB-GUEST01', at: '2026-08-20T07:00:00.000Z' }])
    assert.deepEqual(roundTrippedNotice.reminders.remindedAt, { 'USR-TENANT-HSB-GUEST01': '2026-08-20T08:00:00.000Z' })
    const roundTrippedEndpoint = facade.tenants['TENANT-HSB']['webhook-endpoints'].data[0]
    assert.equal(roundTrippedEndpoint.signingSecretEnc, 'v1:aaaa:bbbb:cccc', '봉인된 서명키는 왕복에서 지워지면 안 된다')
    assert.deepEqual(roundTrippedEndpoint.events, ['work.transitioned'])
    const roundTrippedDelivery = facade.tenants['TENANT-HSB']['webhook-deliveries'].data[0]
    assert.equal(roundTrippedDelivery.status, 'failed')
    assert.equal(roundTrippedDelivery.payload.afterState, '결재대기', '보낼 내용이 사라지면 재시도가 불가능하다')
    assert.equal(facade.tenants['TENANT-HSB']['company-documents'].data[0].name, '점검표.pdf')
    assert.equal(facade.tenants['TENANT-HSB']['performance-settings'].data.employeeVisible, false)
    assert.equal(facade.tenants['TENANT-HSB']['performance-reports'].data[0].id, 'PERFS-1')
    assert.equal(facade.passwordResetRequests[0].tokenHash, 'b'.repeat(64))
    assert.equal(facade.passwordResetRequests[0].token, undefined)

    // 게스트 grant 라운드트립: payload에서는 token* 이 지워지고, 컬럼에서 되돌아온다.
    const persistedGrant = await pool.query('SELECT payload, token_hash, token_issued_at, token_expires_at, project_ids, status, account_id FROM guest_grants WHERE id = $1', ['GST-TENANT-HSB-000001'])
    assert.equal(persistedGrant.rows.length, 1)
    assert.equal(persistedGrant.rows[0].payload.tokenHash, undefined)
    assert.equal(persistedGrant.rows[0].payload.tokenIssuedAt, undefined)
    assert.equal(persistedGrant.rows[0].payload.tokenExpiresAt, undefined)
    assert.equal(persistedGrant.rows[0].token_hash, GUEST_TOKEN_HASH)
    assert.equal(persistedGrant.rows[0].token_expires_at.toISOString(), '2026-08-27T06:00:00.000Z')
    assert.deepEqual(persistedGrant.rows[0].project_ids, ['PRJ-A'])
    assert.equal(persistedGrant.rows[0].status, 'invited')
    assert.equal(persistedGrant.rows[0].account_id, 'USR-TENANT-HSB-GUEST01')
    assert.equal(facade.guestGrants.length, 1)
    assert.equal(facade.guestGrants[0].tokenHash, GUEST_TOKEN_HASH)
    assert.equal(facade.guestGrants[0].tokenIssuedAt, '2026-08-20T06:00:00.000Z')
    assert.equal(facade.guestGrants[0].tokenExpiresAt, '2026-08-27T06:00:00.000Z')
    assert.deepEqual(facade.guestGrants[0].projectIds, ['PRJ-A'])
    assert.equal(facade.guestGrants[0].orgName, '파트너사')
    // 초대 계정의 role 'tenant-guest'는 core_accounts 컬럼과 facade 양쪽에 보존된다(재기동 승격 회귀 방지).
    const guestAccount = await pool.query('SELECT role, tenant_id FROM core_accounts WHERE id = $1', ['USR-TENANT-HSB-GUEST01'])
    assert.equal(guestAccount.rows[0].role, 'tenant-guest')
    assert.equal(guestAccount.rows[0].tenant_id, 'TENANT-HSB')
    assert.equal(facade.invitedAccounts.find((invited) => invited.id === 'USR-TENANT-HSB-GUEST01').role, 'tenant-guest')
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

test('guest grants soft-delete when they leave the snapshot and reload without them', async () => {
  const { adapter, pool, serviceContextApplier } = await testAdapter()
  try {
    const source = fixture()
    await adapter.commitSnapshot(source, { referenceDate: '2026-08-20' })
    const next = structuredClone(source)
    next.guestGrants = []
    next.invitedAccounts = []
    await adapter.commitSnapshot(next, { referenceDate: '2026-08-20' })
    const rows = await pool.query('SELECT id, deleted_at FROM guest_grants')
    assert.equal(rows.rows.length, 1)
    assert.ok(rows.rows[0].deleted_at)
    const reloaded = new PostgresStoreAdapter({ pool, serviceContextApplier })
    await reloaded.connect()
    const facade = await reloaded.loadSnapshot()
    assert.deepEqual(facade.guestGrants, [])
  } finally {
    await adapter.close()
  }
})

test('guest scope RLS policies exist in the schema for the six tables plus core_accounts self-row', async () => {
  const schema = await readFile(new URL('../../db/postgres-schema.sql', import.meta.url), 'utf8')
  const migration = await readFile(new URL('../../supabase/migrations/20260906010000_guest_scope_rls.sql', import.meta.url), 'utf8')
  const table = await readFile(new URL('../../supabase/migrations/20260906000000_guest_grants.sql', import.meta.url), 'utf8')
  for (const sql of [schema, migration]) {
    assert.match(sql, /CREATE OR REPLACE FUNCTION app_guest_project_ids\(\)/)
    // 닫는 대괄호는 보지 않는다. 이 루프는 [schema, migration] 두 파일에 같은 리터럴을 요구하는데,
    // 베이스라인은 R16-D에서 'notices'가 더해져 일곱이고 이미 적용된 20260906010000은 여섯 그대로이기 때문이다.
    assert.match(sql, /ARRAY\['project_spaces', 'project_posts', 'work_items', 'messenger_conversations', 'items', 'guest_grants'/)
    assert.match(sql, /FORCE ROW LEVEL SECURITY/)
    for (const policy of ['project_spaces_guest_read', 'project_posts_guest_read', 'work_items_guest_read', 'messenger_conversations_guest_read', 'items_guest_read', 'core_accounts_guest_self']) {
      assert.match(sql, new RegExp(`CREATE POLICY ${policy} ON \\w+ FOR SELECT USING \\([\\s\\S]*?'tenant-guest'`))
    }
    assert.match(sql, /CREATE POLICY core_accounts_service ON core_accounts/)
    assert.match(sql, /items_guest_read ON items FOR SELECT USING \([\s\S]*?item_type = 'company-document'/)
    // guest_grants에는 게스트 SELECT 정책이 없어야 한다(service 전용).
    assert.doesNotMatch(sql, /CREATE POLICY guest_grants_guest/)
  }
  for (const sql of [schema, table]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS guest_grants \([\s\S]*?token_hash TEXT,[\s\S]*?token_issued_at TIMESTAMPTZ,[\s\S]*?token_expires_at TIMESTAMPTZ/)
    assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_guest_grants_account ON guest_grants \(account_id\) WHERE deleted_at IS NULL/)
  }
  // 정책 대상 테이블은 supabase 마이그레이션 체인 안에 CREATE TABLE로 존재해야 한다. 한 테이블이라도 빠지면
  // DO 루프 첫 반복에서 'relation does not exist'로 RLS 마이그레이션 전체가 실패하고, 환경별 격리 수준이 갈라진다.
  const migrationsDir = new URL('../../supabase/migrations/', import.meta.url)
  const chain = (await Promise.all((await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort().map((name) => readFile(new URL(name, migrationsDir), 'utf8')))).join('\n')
  for (const tableName of ['project_spaces', 'project_posts', 'work_items', 'messenger_conversations', 'items', 'guest_grants', 'core_accounts', 'notices', 'webhook_endpoints', 'webhook_deliveries']) {
    assert.match(chain, new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName}\\b`), `${tableName}가 supabase/migrations 안에서 만들어져야 한다`)
  }
  // 그리고 RLS 마이그레이션 파일 이름은 테이블 마이그레이션보다 뒤여야 한다(사전순 적용).
  assert.ok('20260906000000_guest_grants.sql' < '20260906010000_guest_scope_rls.sql')
  // pg-mem용 스키마에는 RLS·함수·DO 블록이 하나도 남지 않아야 한다(남으면 메모리 엔진이 파싱 실패).
  const stripped = withoutPgMemUnsupportedRls(schema)
  assert.doesNotMatch(stripped, /ROW LEVEL SECURITY|CREATE POLICY|DROP POLICY|CREATE OR REPLACE FUNCTION|DO \$\$/)
  assert.match(stripped, /CREATE TABLE IF NOT EXISTS guest_grants/)
  assert.match(stripped, /CREATE TABLE IF NOT EXISTS platform_tenants/)
})

test('postgres guest context sets the four session variables transaction-locally and rejects unsafe input', async () => {
  const calls = []
  const client = { query: async (...args) => { calls.push(args) } }
  await applyPostgresGuestContext(client, { tenantId: 'TENANT-HSB', accountId: 'USR-TENANT-HSB-GUEST01', projectIds: ['PRJ-A', 'PRJ-B', 'PRJ-A', ''] })
  assert.deepEqual(calls, [[
    "SELECT set_config('app.role', $1, TRUE), set_config('app.org_id', $2, TRUE), set_config('app.current_account_id', $3, TRUE), set_config('app.guest_project_ids', $4, TRUE)",
    ['tenant-guest', 'TENANT-HSB', 'USR-TENANT-HSB-GUEST01', 'PRJ-A,PRJ-B'],
  ]])
  await assert.rejects(applyPostgresGuestContext(client, { tenantId: '', accountId: 'X', projectIds: [] }), StoreVerificationError)
  await assert.rejects(applyPostgresGuestContext(client, { tenantId: 'T', accountId: null, projectIds: [] }), StoreVerificationError)
  // 콤마가 든 id는 app.guest_project_ids 문자열을 조작할 수 있으므로 거절한다.
  await assert.rejects(applyPostgresGuestContext(client, { tenantId: 'T', accountId: 'U', projectIds: ['PRJ-A,PRJ-B'] }), StoreVerificationError)
})

test('guestVisibleIds intersects candidates with rows selected under the guest context (pg-mem: existence only)', async () => {
  const { adapter } = await testAdapter()
  try {
    await adapter.commitSnapshot(fixture(), { referenceDate: '2026-08-20', rawDueByEntity: { 'TENANT-HSB:WORK-1': '오늘 18:00' } })
    const scope = { tenantId: 'TENANT-HSB', accountId: 'USR-TENANT-HSB-GUEST01', projectIds: ['PRJ-A'] }
    // 워크스페이스 키와 테이블 이름 둘 다 받는다.
    assert.deepEqual(await adapter.guestVisibleIds({ ...scope, table: 'project-spaces', candidateIds: ['PRJ-A', 'PRJ-NOPE'] }), ['PRJ-A'])
    assert.deepEqual(await adapter.guestVisibleIds({ ...scope, table: 'project_spaces', candidateIds: ['PRJ-B', 'PRJ-A'] }), ['PRJ-B', 'PRJ-A'])
    assert.deepEqual(await adapter.guestVisibleIds({ ...scope, table: 'work-items', candidateIds: ['WORK-1', 'WORK-404'] }), ['WORK-1'])
    assert.deepEqual(await adapter.guestVisibleIds({ ...scope, table: 'company-documents', candidateIds: ['DOC-1'] }), ['DOC-1'])
    assert.deepEqual(await adapter.guestVisibleIds({ ...scope, table: 'messenger-conversations', candidateIds: ['ROOM-1', 'ROOM-1'] }), ['ROOM-1'])
    // 다른 테넌트의 행은 org_id 조건에서 걸러진다.
    assert.deepEqual(await adapter.guestVisibleIds({ ...scope, tenantId: 'TENANT-POHANG', table: 'work_items', candidateIds: ['CAL-1', 'WORK-1'] }), ['WORK-1'])
    assert.deepEqual(await adapter.guestVisibleIds({ ...scope, table: 'work-items', candidateIds: [] }), [])
    // 정책이 없는 테이블은 거절한다 — 정책 없는 테이블은 게스트 컨텍스트에서 전량이 보이기 때문이다.
    await assert.rejects(adapter.guestVisibleIds({ ...scope, table: 'calendar-events', candidateIds: ['CAL-1'] }), StoreVerificationError)
    await assert.rejects(adapter.guestVisibleIds({ ...scope, table: 'core_accounts', candidateIds: ['USR-HSB-ADMIN'] }), StoreVerificationError)
    await assert.rejects(adapter.guestVisibleIds({ ...scope, tenantId: '', table: 'work-items', candidateIds: ['WORK-1'] }), StoreVerificationError)
  } finally {
    await adapter.close()
  }
})

test('json adapter returns guest candidates unchanged (no RLS to intersect with)', async () => {
  const adapter = new JsonStoreAdapter({ file: null, readOnly: true })
  assert.deepEqual(await adapter.guestVisibleIds({ table: 'work-items', tenantId: 'T', accountId: 'U', projectIds: ['PRJ-A'], candidateIds: ['W1', 'W2'] }), ['W1', 'W2'])
  assert.deepEqual(await adapter.guestVisibleIds({ candidateIds: undefined }), [])
  const snapshot = await adapter.loadSnapshot()
  assert.deepEqual(snapshot.guestGrants, [])
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

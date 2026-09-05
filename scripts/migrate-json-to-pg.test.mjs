import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { newDb } from 'pg-mem'

import {
  migrateJsonToPostgres,
  normalizeLegacyDue,
  prepareMigrationSnapshot,
  verifyNormalizedCounts,
} from './migrate-json-to-pg.mjs'

function sourceFixture() {
  return {
    version: 2,
    tenants: {
      'TENANT-MIGRATION': {
        'work-items': {
          data: [
            { id: 'WORK-TODAY', title: '오늘 작업', due: '오늘 18:00', status: '업무요청' },
            { id: 'WORK-MONTH', title: '월일 작업', due: '8월 23일 09:30', status: '업무요청' },
          ],
          updatedAt: '2026-08-20T01:00:00.000Z',
          updatedBy: 'USR-MIGRATION',
        },
      },
    },
    platform: { tenants: [{ id: 'TENANT-MIGRATION', name: 'Migration tenant', isDemo: false }], supportTickets: [], integrations: [], actions: [], auditEvents: [] },
    accountApprovals: {}, accountCredentials: {},
    invitedAccounts: [{
      id: 'USR-TENANT-MIGRATION-GUEST01', tenantId: 'TENANT-MIGRATION', email: 'guest@partner.test', name: '거래처 게스트',
      role: 'tenant-guest', guestGrantId: 'GST-TENANT-MIGRATION-000001', approved: false, approvalStatus: 'pending',
    }],
    passwordResetRequests: [],
    guestGrants: [{
      id: 'GST-TENANT-MIGRATION-000001', tenantId: 'TENANT-MIGRATION', accountId: 'USR-TENANT-MIGRATION-GUEST01',
      email: 'guest@partner.test', name: '거래처 게스트', orgName: '파트너사', projectIds: ['PRJ-M'],
      status: 'invited', tokenHash: 'd'.repeat(64), tokenIssuedAt: '2026-08-20T06:00:00.000Z', tokenExpiresAt: '2026-08-27T06:00:00.000Z',
      createdAt: '2026-08-20T06:00:00.000Z', updatedAt: '2026-08-20T06:00:00.000Z',
    }],
  }
}

test('migration snapshot fills guestGrants for legacy files that predate the collection', () => {
  const legacy = sourceFixture()
  delete legacy.guestGrants
  const prepared = prepareMigrationSnapshot(legacy, '2026-08-20')
  assert.deepEqual(prepared.snapshot.guestGrants, [])
})

test('relative due conversion uses an explicit Korea base date and preserves raw text', () => {
  assert.deepEqual(normalizeLegacyDue('오늘 18:00', '2026-08-20'), {
    due: '2026-08-20T09:00:00.000Z', rawDue: '오늘 18:00',
  })
  assert.deepEqual(normalizeLegacyDue('내일 09:30', '2026-12-31'), {
    due: '2027-01-01T00:30:00.000Z', rawDue: '내일 09:30',
  })
  const prepared = prepareMigrationSnapshot(sourceFixture(), '2026-08-20')
  assert.equal(prepared.snapshot.tenants['TENANT-MIGRATION']['work-items'].data[1].due, '2026-08-23T00:30:00.000Z')
  assert.equal(prepared.rawDueByEntity['TENANT-MIGRATION:WORK-MONTH'], '8월 23일 09:30')
})

test('migration keeps the JSON source immutable, creates a timestamp backup, and verifies normalized row counts', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'onfactory-migrate-'))
  const sourcePath = path.join(directory, 'workspace-state.json')
  const source = `${JSON.stringify(sourceFixture(), null, 2)}\n`
  await writeFile(sourcePath, source, 'utf8')
  const memory = newDb({ autoCreateForeignKeyIndices: true })
  const pg = memory.adapters.createPg()
  const pool = new pg.Pool()
  try {
    const result = await migrateJsonToPostgres({ sourcePath, referenceDate: '2026-08-20', pool })
    assert.equal(await readFile(sourcePath, 'utf8'), source)
    assert.equal(await readFile(result.backupPath, 'utf8'), source)

    const rows = await pool.query('SELECT id, payload, due_at, raw_due FROM work_items ORDER BY id')
    assert.equal(rows.rows.length, 2)
    assert.equal(rows.rows[0].payload.due, undefined)
    assert.equal(rows.rows.find((row) => row.id === 'WORK-TODAY').due_at.toISOString(), '2026-08-20T09:00:00.000Z')
    assert.equal(rows.rows.find((row) => row.id === 'WORK-TODAY').raw_due, '오늘 18:00')

    // 게스트 grant도 함께 이관되고 건수 검증에 포함된다. 토큰 해시는 payload가 아니라 컬럼에만 있다.
    const grants = await pool.query('SELECT id, token_hash, payload FROM guest_grants WHERE deleted_at IS NULL')
    assert.deepEqual(grants.rows.map((row) => row.id), ['GST-TENANT-MIGRATION-000001'])
    assert.equal(grants.rows[0].token_hash, 'd'.repeat(64))
    assert.equal(grants.rows[0].payload.tokenHash, undefined)
    assert.ok(result.counts.some((row) => row.key === 'guestGrants' && row.source === 1 && row.loaded === 1 && row.status === 'OK'))
    assert.equal(result.snapshot.guestGrants[0].tokenHash, 'd'.repeat(64))
    const guestRole = await pool.query('SELECT role FROM core_accounts WHERE id = $1', ['USR-TENANT-MIGRATION-GUEST01'])
    assert.equal(guestRole.rows[0].role, 'tenant-guest')

    const wrong = sourceFixture()
    wrong.tenants['TENANT-MIGRATION']['work-items'].data.push({ id: 'WORK-MISSING', due: '오늘', title: '누락', status: '업무요청' })
    await assert.rejects(verifyNormalizedCounts(pool, wrong), (error) => {
      assert.match(error.message, /건수 검증 실패/)
      assert.ok(error.counts.some((row) => row.key === 'work-items' && row.source === 3 && row.loaded === 2 && row.status === 'MISMATCH'))
      return true
    })
  } finally {
    await pool.end()
    await rm(directory, { recursive: true, force: true })
  }
})

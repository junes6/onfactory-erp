import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { newDb } from 'pg-mem'

import { DEMO_ACCOUNT_DEFINITIONS } from '../server/store/demo-seed.mjs'
import { seedDemo } from './seed-demo.mjs'

test('demo seed separates both tenants, marks is_demo, and persists credentials outside account JSON', async () => {
  const memory = newDb({ autoCreateForeignKeyIndices: true })
  const pg = memory.adapters.createPg()
  const pool = new pg.Pool()
  try {
    const snapshot = await seedDemo({
      fixturePath: path.resolve('worker/initial-workspace-state.json'),
      password: 'Demo-Seed!2026',
      referenceDate: '2026-08-20',
      pool,
    })
    assert.ok(snapshot.tenants['TENANT-SUNSEA'])
    assert.ok(snapshot.tenants['TENANT-POHANG'])
    assert.equal(snapshot.tenantMetadata['TENANT-SUNSEA'].isDemo, true)
    assert.equal(snapshot.tenantMetadata['TENANT-POHANG'].isDemo, true)
    assert.equal(snapshot.accounts.length, DEMO_ACCOUNT_DEFINITIONS.length)

    const tenants = await pool.query('SELECT id, is_demo FROM core_tenants ORDER BY id')
    assert.deepEqual(tenants.rows.map((row) => [row.id, row.is_demo]), [
      ['TENANT-POHANG', true], ['TENANT-SUNSEA', true],
    ])
    const account = await pool.query("SELECT payload FROM core_accounts WHERE id = 'USR-SUNSEA-ADMIN'")
    assert.equal(account.rows[0].payload.password, undefined)
    assert.equal(account.rows[0].payload.passwordHash, undefined)
    const credential = await pool.query("SELECT password_hash, must_change_password FROM account_credentials WHERE account_id = 'USR-SUNSEA-ADMIN'")
    assert.equal(credential.rows[0].password_hash.length, 64)
    assert.equal(credential.rows[0].must_change_password, true)

    const due = await pool.query("SELECT due_at, raw_due, payload FROM work_items WHERE org_id = 'TENANT-SUNSEA' AND id = 'WK-22354608'")
    assert.equal(due.rows[0].due_at.toISOString(), '2026-08-20T09:00:00.000Z')
    assert.equal(due.rows[0].raw_due, '오늘 18:00')
    assert.equal(due.rows[0].payload.due, undefined)
  } finally {
    await pool.end()
  }
})

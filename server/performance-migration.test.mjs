import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { newDb } from 'pg-mem'

const migrationUrl = new URL('../supabase/migrations/20260821010000_performance_rls_service.sql', import.meta.url)

function withoutPgMemUnsupportedRls(sql) {
  return sql
    .replace(/ALTER TABLE performance_(?:settings|report_snapshots) (?:ENABLE|FORCE) ROW LEVEL SECURITY;\s*/g, '')
    .replace(/DROP POLICY IF EXISTS performance_[\w]+ ON performance_(?:settings|report_snapshots);\s*/g, '')
    .replace(/CREATE POLICY performance_[\s\S]*?WITH CHECK \([^;]+\);\s*/g, '')
}

test('performance RLS upgrade creates missing tables first and is additive on rerun', async () => {
  const migration = await readFile(migrationUrl, 'utf8')
  for (const table of ['performance_settings', 'performance_report_snapshots']) {
    const createAt = migration.indexOf(`CREATE TABLE IF NOT EXISTS ${table}`)
    const alterAt = migration.indexOf(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)
    assert.ok(createAt >= 0, `${table} create statement is required`)
    assert.ok(alterAt > createAt, `${table} must exist before RLS is enabled`)
  }
  assert.doesNotMatch(migration, /\b(?:DROP|TRUNCATE|DELETE)\s+TABLE\b/i)

  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true })
  const pg = memory.adapters.createPg()
  const pool = new pg.Pool()
  try {
    await pool.query('CREATE TABLE core_tenants (id TEXT PRIMARY KEY)')
    await pool.query("INSERT INTO core_tenants (id) VALUES ('TENANT-UPGRADE')")
    const executableMigration = withoutPgMemUnsupportedRls(migration)
    await pool.query(executableMigration)
    await pool.query(`
      INSERT INTO performance_settings (id, org_id, payload, created_by)
      VALUES ('__singleton__', 'TENANT-UPGRADE', '{"employeeVisible":true}'::jsonb, 'ADMIN-1')
    `)
    await pool.query(`
      INSERT INTO performance_report_snapshots (id, org_id, payload, created_by)
      VALUES ('PERFS-LEGACY', 'TENANT-UPGRADE', '{"immutable":true}'::jsonb, 'ADMIN-1')
    `)

    await pool.query(executableMigration)
    const settings = await pool.query("SELECT payload FROM performance_settings WHERE org_id = 'TENANT-UPGRADE'")
    const reports = await pool.query("SELECT payload FROM performance_report_snapshots WHERE org_id = 'TENANT-UPGRADE'")
    assert.equal(settings.rows.length, 1)
    assert.equal(settings.rows[0].payload.employeeVisible, true)
    assert.equal(reports.rows.length, 1)
    assert.equal(reports.rows[0].payload.immutable, true)
  } finally {
    await pool.end()
  }
})

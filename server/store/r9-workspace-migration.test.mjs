import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { newDb } from 'pg-mem'

const migrationUrl = new URL('../../supabase/migrations/20260824000000_r9_workspace_tables.sql', import.meta.url)

test('R9 workspace migration is additive, idempotent, and preserves tenant rows', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  for (const table of ['company_assets', 'tax_events', 'ip_rights']) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i'))
  }
  assert.doesNotMatch(sql, /\b(?:DROP|TRUNCATE)\s+TABLE\b/i)

  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true })
  db.public.none(`CREATE TABLE core_tenants (id TEXT PRIMARY KEY)`)
  db.public.none(`INSERT INTO core_tenants (id) VALUES ('TENANT-MIGRATION')`)
  db.public.none(sql)
  db.public.none(`INSERT INTO tax_events (id, org_id, payload, position) VALUES ('TAX-1', 'TENANT-MIGRATION', '{"title":"보존 일정"}', 0)`)
  db.public.none(sql)

  assert.equal(db.public.one(`SELECT payload->>'title' AS title FROM tax_events WHERE org_id='TENANT-MIGRATION' AND id='TAX-1'`).title, '보존 일정')
  for (const table of ['company_assets', 'tax_events', 'ip_rights']) {
    assert.equal(db.public.many(`SELECT column_name FROM information_schema.columns WHERE table_name='${table}'`).some((row) => row.column_name === 'deleted_at'), true)
  }
})

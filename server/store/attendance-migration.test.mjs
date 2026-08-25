import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { newDb } from 'pg-mem'

const migrationUrl = new URL('../../supabase/migrations/20260825000000_attendance_records.sql', import.meta.url)

test('attendance migration is additive, idempotent, and preserves tenant records', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  assert.match(sql, /CREATE TABLE IF NOT EXISTS attendance_records\b/i)
  assert.doesNotMatch(sql, /\b(?:DROP|TRUNCATE)\s+TABLE\b/i)

  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true })
  db.public.none('CREATE TABLE core_tenants (id TEXT PRIMARY KEY)')
  db.public.none("INSERT INTO core_tenants (id) VALUES ('TENANT-ATTENDANCE')")
  db.public.none(sql)
  db.public.none(`INSERT INTO attendance_records (id, org_id, payload, position) VALUES ('__singleton__', 'TENANT-ATTENDANCE', '{"policy":{"standardStartTime":"09:00"},"records":[]}', 0)`)
  db.public.none(sql)

  const preserved = db.public.one("SELECT payload->'policy'->>'standardStartTime' AS start_time FROM attendance_records WHERE org_id='TENANT-ATTENDANCE'")
  assert.equal(preserved.start_time, '09:00')
  const columns = db.public.many("SELECT column_name FROM information_schema.columns WHERE table_name='attendance_records'")
  for (const column of ['id', 'org_id', 'created_at', 'updated_at', 'deleted_at', 'created_by']) {
    assert.ok(columns.some((row) => row.column_name === column), `${column} column`)
  }
})


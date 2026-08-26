import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { newDb } from 'pg-mem'

const migrationUrl = new URL('../../supabase/migrations/20260826000000_personal_todos.sql', import.meta.url)

test('personal To-do migration is additive, idempotent, and indexes the payload owner', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  assert.match(sql, /CREATE TABLE IF NOT EXISTS personal_todos\b/i)
  assert.match(sql, /payload->>'ownerId'/)
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true })
  db.public.none('CREATE TABLE core_tenants (id TEXT PRIMARY KEY)')
  db.public.none("INSERT INTO core_tenants (id) VALUES ('TENANT-TODO')")
  db.public.none(sql)
  db.public.none(`INSERT INTO personal_todos (id, org_id, payload, position) VALUES ('TODO-1', 'TENANT-TODO', '{"ownerId":"ACCOUNT-1","title":"보존"}', 0)`)
  db.public.none(sql)
  assert.equal(db.public.one("SELECT payload->>'title' AS title FROM personal_todos WHERE org_id='TENANT-TODO'").title, '보존')
})

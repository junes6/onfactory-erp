import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'

import { newDb } from 'pg-mem'

import { withoutPgMemUnsupportedRls } from './postgres-store.mjs'

const migrationUrl = new URL('../../supabase/migrations/20260907000000_project_templates.sql', import.meta.url)
const schemaUrl = new URL('../../db/postgres-schema.sql', import.meta.url)
const migrationsDir = new URL('../../supabase/migrations/', import.meta.url)

const freshDb = () => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true })
  db.public.none('CREATE TABLE core_tenants (id TEXT PRIMARY KEY)')
  db.public.none("INSERT INTO core_tenants (id) VALUES ('TENANT-T')")
  return db
}

test('project-templates migration is additive, idempotent, and locked to the service context', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  assert.match(sql, /CREATE TABLE IF NOT EXISTS project_templates\b/i)
  assert.doesNotMatch(sql, /\b(?:DROP|TRUNCATE)\s+TABLE\b/i)
  // 게스트는 이 테이블을 읽지 않는다 — 게스트 정책이 생기면 내부 프로세스명이 외부로 열린다.
  assert.match(sql, /FORCE ROW LEVEL SECURITY/)
  assert.match(sql, /CREATE POLICY project_templates_service ON project_templates/)
  assert.doesNotMatch(sql, /CREATE POLICY project_templates_guest/)

  const db = freshDb()
  const applied = withoutPgMemUnsupportedRls(sql)
  db.public.none(applied)
  db.public.none(`INSERT INTO project_templates (id, org_id, payload, position) VALUES ('PT-1', 'TENANT-T', '{"name":"템플릿"}', 0)`)
  db.public.none(applied)

  const preserved = db.public.one("SELECT payload->>'name' AS name FROM project_templates WHERE org_id='TENANT-T'")
  assert.equal(preserved.name, '템플릿')
  const columns = db.public.many("SELECT column_name FROM information_schema.columns WHERE table_name='project_templates'")
  for (const column of ['id', 'org_id', 'created_at', 'updated_at', 'deleted_at', 'created_by']) {
    assert.ok(columns.some((row) => row.column_name === column), `${column} column`)
  }
})

test('baseline schema carries project_templates and the ai_conversations table that was only in the migration chain', async () => {
  const schema = await readFile(schemaUrl, 'utf8')
  // applySchema는 베이스라인 한 파일만 읽는다. 체인에만 있는 테이블은 새 배포에서 통째로 빠진다.
  assert.match(schema, /CREATE TABLE IF NOT EXISTS project_templates\b/i)
  assert.match(schema, /CREATE TABLE IF NOT EXISTS ai_conversations\b/i)

  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort()
  const chain = (await Promise.all(files.map((name) => readFile(new URL(name, migrationsDir), 'utf8')))).join('\n')
  assert.match(chain, /CREATE TABLE IF NOT EXISTS project_templates\b/i)
  assert.match(chain, /CREATE TABLE IF NOT EXISTS ai_conversations\b/i)

  // 게스트 RLS DO 루프의 테이블 목록은 그대로다 — 템플릿은 그 목록에 들어가지 않는다.
  assert.match(schema, /ARRAY\['project_spaces', 'project_posts', 'work_items', 'messenger_conversations', 'items', 'guest_grants'\]/)

  // 베이스라인은 빈 데이터베이스에 한 번 적용된다(applyStoreSchema). 두 번 적용은 pg-mem이
  // CREATE OR REPLACE VIEW를 못 다시 읽어 실패하므로, 멱등성은 체인 파일 쪽 테스트가 지킨다.
  const db = freshDb()
  db.public.none(withoutPgMemUnsupportedRls(schema))
  const columns = db.public.many("SELECT column_name FROM information_schema.columns WHERE table_name='project_templates'")
  for (const column of ['id', 'org_id', 'created_at', 'updated_at', 'deleted_at', 'created_by']) {
    assert.ok(columns.some((row) => row.column_name === column), `${column} column`)
  }
})

test('the new migration sorts after the last existing one', async () => {
  assert.ok('20260906010000_guest_scope_rls.sql' < '20260907000000_project_templates.sql')
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort()
  assert.equal(files.at(-1), '20260907000000_project_templates.sql')
})

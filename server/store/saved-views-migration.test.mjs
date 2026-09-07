import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'

import { newDb } from 'pg-mem'

import { withoutPgMemUnsupportedRls } from './postgres-store.mjs'

/**
 * R16-K 마이그레이션 — 저장된 보기 + 커스텀 필드 정의.
 *
 * 두 가지를 함께 못 박는다:
 * (1) 체인 파일이 추가만 하고 멱등이며 공통 컬럼을 갖춘다,
 * (2) **베이스라인(db/postgres-schema.sql)에도 같은 CREATE가 있다**.
 * ai_conversations가 한동안 체인에만 있었고, applySchema는 베이스라인 하나만 읽으므로
 * 로컬 pg-mem은 통과하면서 실제 Supabase에서만 터지는 구멍이 그렇게 생겼다.
 */
const migrationUrl = new URL('../../supabase/migrations/20260909000000_saved_views_custom_fields.sql', import.meta.url)
const schemaUrl = new URL('../../db/postgres-schema.sql', import.meta.url)

test('1. 마이그레이션은 두 테이블을 추가만 하고 게스트 정책을 만들지 않는다', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  assert.match(sql, /CREATE TABLE IF NOT EXISTS saved_views\b/i)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS custom_fields\b/i)
  assert.doesNotMatch(sql, /\b(?:DROP|TRUNCATE)\s+TABLE\b/i)
  assert.match(sql, /FORCE ROW LEVEL SECURITY/)
  assert.match(sql, /CREATE POLICY saved_views_service ON saved_views/)
  assert.match(sql, /CREATE POLICY custom_fields_service ON custom_fields/)
  // 게스트는 이 두 테이블을 읽지 않는다 — 정책이 생기는 순간 외부인에게 사람·프로젝트 열거원이 열린다.
  assert.doesNotMatch(sql, /CREATE POLICY (?:saved_views|custom_fields)_guest/)
})

test('2. pg-mem에 두 번 적용해도 행이 살아 있고 공통 컬럼 6개가 있다', async () => {
  const sql = withoutPgMemUnsupportedRls(await readFile(migrationUrl, 'utf8'))
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true })
  db.public.none('CREATE TABLE core_tenants (id TEXT PRIMARY KEY)')
  db.public.none("INSERT INTO core_tenants (id) VALUES ('TENANT-VIEWS')")
  db.public.none(sql)
  db.public.none(`INSERT INTO saved_views (id, org_id, payload, position) VALUES ('VIEW-1', 'TENANT-VIEWS', '{"name":"내 지연 업무","visibility":"private"}', 0)`)
  db.public.none(`INSERT INTO custom_fields (id, org_id, payload, position) VALUES ('CF-1', 'TENANT-VIEWS', '{"key":"vendor","type":"select"}', 0)`)
  db.public.none(sql)

  assert.equal(db.public.one("SELECT payload->>'name' AS name FROM saved_views WHERE org_id='TENANT-VIEWS'").name, '내 지연 업무')
  assert.equal(db.public.one("SELECT payload->>'key' AS key FROM custom_fields WHERE org_id='TENANT-VIEWS'").key, 'vendor')
  for (const table of ['saved_views', 'custom_fields']) {
    const columns = db.public.many(`SELECT column_name FROM information_schema.columns WHERE table_name='${table}'`)
    for (const column of ['id', 'org_id', 'created_at', 'updated_at', 'deleted_at', 'created_by']) {
      assert.ok(columns.some((row) => row.column_name === column), `${table}.${column}`)
    }
  }
})

test('3. 베이스라인 스키마에도 같은 CREATE가 있다 (applySchema는 이 파일만 읽는다)', async () => {
  const schema = await readFile(schemaUrl, 'utf8')
  assert.match(schema, /CREATE TABLE IF NOT EXISTS saved_views\b/i)
  assert.match(schema, /CREATE TABLE IF NOT EXISTS custom_fields\b/i)
  assert.match(schema, /CREATE POLICY saved_views_service ON saved_views/)
  assert.match(schema, /CREATE POLICY custom_fields_service ON custom_fields/)
  assert.match(schema, /CREATE INDEX IF NOT EXISTS idx_saved_views_active ON saved_views/)
  assert.match(schema, /CREATE INDEX IF NOT EXISTS idx_custom_fields_active ON custom_fields/)
})

test('4. 게스트 RLS 루프의 테이블 목록은 한 글자도 바뀌지 않는다', async () => {
  const schema = await readFile(schemaUrl, 'utf8')
  assert.ok(schema.includes("ARRAY['project_spaces', 'project_posts', 'work_items', 'messenger_conversations', 'items', 'guest_grants', 'notices']"),
    '게스트가 읽는 테이블은 이 절에서 늘지 않는다')
})

test('5. 새 마이그레이션은 기존 체인 뒤에 온다 (사전순 적용 전제)', async () => {
  const files = (await readdir(new URL('../../supabase/migrations/', import.meta.url))).filter((name) => name.endsWith('.sql')).sort()
  const mine = '20260909000000_saved_views_custom_fields.sql'
  const previous = '20260908000000_notices_webhooks.sql'
  assert.ok(files.includes(mine))
  // '마지막이어야 한다'로 적으면 다음 절이 마이그레이션을 하나 더할 때마다 이 시험이 깨진다.
  // 잠글 것은 순서지 마지막 자리가 아니다 — 이 파일이 자기 앞 체인 뒤에만 오면 된다.
  assert.ok(files.indexOf(mine) > files.indexOf(previous), `${mine}이 ${previous}보다 앞에 있으면 안 된다`)
})

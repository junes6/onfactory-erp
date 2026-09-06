import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'

import { newDb } from 'pg-mem'

import { withoutPgMemUnsupportedRls } from './postgres-store.mjs'

/**
 * 공지 테이블의 DDL — 베이스라인과 체인이 같은 것을 만들어야 한다.
 *
 * applySchema는 베이스라인 한 파일만 읽는다. 체인에만 있는 테이블은 새로 배포한 데이터베이스에서
 * 통째로 빠지고, 베이스라인에만 있는 정책은 이미 배포된 데이터베이스에 영영 도착하지 않는다.
 * 특히 notices_guest_read의 `scope = 'project'` 한 줄이 회사 공지를 게스트의 PG 읽기에서 막는다 —
 * 앱 층(noticeVisibleTo)과 이중 방어이므로 둘 중 하나가 사라지면 안 된다.
 */

const migrationUrl = new URL('../../supabase/migrations/20260908000000_notices_webhooks.sql', import.meta.url)
const schemaUrl = new URL('../../db/postgres-schema.sql', import.meta.url)
const migrationsDir = new URL('../../supabase/migrations/', import.meta.url)

const freshDb = () => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true })
  db.public.none('CREATE TABLE core_tenants (id TEXT PRIMARY KEY)')
  db.public.none("INSERT INTO core_tenants (id) VALUES ('TENANT-T')")
  return db
}

const COMMON_COLUMNS = ['id', 'org_id', 'created_at', 'updated_at', 'deleted_at', 'created_by']

test('베이스라인과 체인 양쪽에 notices 테이블과 게스트 정책이 있다', async () => {
  const schema = await readFile(schemaUrl, 'utf8')
  const migration = await readFile(migrationUrl, 'utf8')

  for (const [name, sql] of [['베이스라인', schema], ['20260908000000', migration]]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS notices\b/i, `${name}에 notices 테이블이 없다`)
    assert.match(sql, /CREATE POLICY notices_guest_read ON notices/, `${name}에 게스트 정책이 없다`)
    // 이 한 줄이 회사 공지를 게스트의 PG 읽기에서 막는다.
    assert.match(sql, /payload->>'scope' = 'project'/, `${name}에 scope 조건이 없다`)
    assert.match(sql, /app_guest_project_ids\(\)/, `${name}이 게스트 프로젝트 목록을 보지 않는다`)
  }
  // service 정책: 베이스라인은 DO 루프가 테이블 목록을 돌며 만들고, 마이그레이션은 한 테이블만 직접 만든다.
  assert.match(migration, /CREATE POLICY notices_service ON notices/)
  assert.match(migration, /ALTER TABLE notices FORCE ROW LEVEL SECURITY/)

  // 이미 적용된 마이그레이션을 고쳐 쓰지 않는다 — 새 정책은 이 파일에서만 얹는다.
  const applied = await readFile(new URL('20260906010000_guest_scope_rls.sql', migrationsDir), 'utf8')
  assert.doesNotMatch(applied, /notices/i, '이미 배포된 마이그레이션은 손대지 않는다')

  // 베이스라인의 DO 루프에는 notices가 들어 있어야 게스트 정책이 붙는 테이블 목록과 맞는다.
  assert.match(schema, /ARRAY\['project_spaces', 'project_posts', 'work_items', 'messenger_conversations', 'items', 'guest_grants', 'notices'\]/)
})

test('마이그레이션은 가산적이고 두 번 적용해도 같은 상태다', async () => {
  const migration = await readFile(migrationUrl, 'utf8')
  assert.doesNotMatch(migration, /\b(?:DROP|TRUNCATE)\s+TABLE\b/i, '남의 데이터를 지우는 문장이 있으면 안 된다')

  const db = freshDb()
  const applied = withoutPgMemUnsupportedRls(migration)
  db.public.none(applied)
  db.public.none(`INSERT INTO notices (id, org_id, payload, position) VALUES ('NTC-1', 'TENANT-T', '{"scope":"project","projectId":"PRJ-A"}', 0)`)
  db.public.none(applied)

  const preserved = db.public.one("SELECT payload->>'projectId' AS project FROM notices WHERE org_id='TENANT-T'")
  assert.equal(preserved.project, 'PRJ-A', '두 번째 적용이 이미 있던 행을 지우면 안 된다')

  const columns = db.public.many("SELECT column_name FROM information_schema.columns WHERE table_name='notices'")
  for (const column of COMMON_COLUMNS) {
    assert.ok(columns.some((row) => row.column_name === column), `${column} 공통 컬럼`)
  }
})

test('베이스라인도 같은 컬럼으로 notices를 만든다', async () => {
  const schema = await readFile(schemaUrl, 'utf8')
  const db = freshDb()
  db.public.none(withoutPgMemUnsupportedRls(schema))
  const columns = db.public.many("SELECT column_name FROM information_schema.columns WHERE table_name='notices'")
  for (const column of COMMON_COLUMNS) {
    assert.ok(columns.some((row) => row.column_name === column), `${column} 공통 컬럼`)
  }
})

test('새 마이그레이션은 앞의 것 뒤에 온다 — 체인은 사전순으로 적용된다', async () => {
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort()
  const index = files.indexOf('20260908000000_notices_webhooks.sql')
  assert.ok(index >= 0, '공지 마이그레이션이 체인에 있어야 한다')
  assert.equal(files[index - 1], '20260907000000_project_templates.sql')
})

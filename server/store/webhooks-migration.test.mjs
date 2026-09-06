import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'

import { newDb } from 'pg-mem'

import { withoutPgMemUnsupportedRls } from './postgres-store.mjs'

/**
 * 외부 연동 두 테이블의 DDL — 베이스라인과 체인이 같은 것을 만들어야 한다.
 *
 * applySchema는 베이스라인 한 파일만 읽는다. 체인에만 있는 테이블은 새로 배포한 데이터베이스에서
 * 통째로 빠지고, 베이스라인에만 있는 정책은 이미 배포된 데이터베이스에 영영 도착하지 않는다.
 *
 * 그리고 이 두 테이블에는 **게스트 정책이 없어야 한다**. 여기에 게스트 SELECT를 만들면
 * 수신 주소의 해시와 봉인된 서명키가 외부인 세션의 사거리에 들어온다.
 */

const migrationUrl = new URL('../../supabase/migrations/20260908000000_notices_webhooks.sql', import.meta.url)
const schemaUrl = new URL('../../db/postgres-schema.sql', import.meta.url)
const migrationsDir = new URL('../../supabase/migrations/', import.meta.url)

const TABLES = ['webhook_endpoints', 'webhook_deliveries']
const COMMON_COLUMNS = ['id', 'org_id', 'created_at', 'updated_at', 'deleted_at', 'created_by']

const freshDb = () => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true })
  db.public.none('CREATE TABLE core_tenants (id TEXT PRIMARY KEY)')
  db.public.none("INSERT INTO core_tenants (id) VALUES ('TENANT-T')")
  return db
}

test('베이스라인과 체인 양쪽에 두 테이블과 service 전용 정책이 있다', async () => {
  const schema = await readFile(schemaUrl, 'utf8')
  const migration = await readFile(migrationUrl, 'utf8')

  for (const [name, sql] of [['베이스라인', schema], ['20260908000000', migration]]) {
    for (const table of TABLES) {
      assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`), `${name}에 ${table} 테이블이 없다`)
      assert.match(sql, new RegExp(`CREATE POLICY ${table}_service ON ${table}`), `${name}에 ${table} service 정책이 없다`)
      assert.match(sql, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`), `${name}에 ${table} FORCE RLS가 없다`)
    }
    // 게스트 정책은 어느 쪽에도 없어야 한다 — 있으면 봉인문과 토큰 해시가 외부인에게 열린다.
    assert.doesNotMatch(sql, /CREATE POLICY webhook_\w+_guest/, `${name}에 웹훅 게스트 정책이 생기면 안 된다`)
    // 토큰 하나로 고객사를 역조회하므로 전역 유니크 인덱스가 필요하다.
    assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS webhook_endpoints_token_idx/, `${name}에 토큰 유니크 인덱스가 없다`)
  }

  // 이미 적용된 마이그레이션은 손대지 않는다.
  const applied = await readFile(new URL('20260906010000_guest_scope_rls.sql', migrationsDir), 'utf8')
  assert.doesNotMatch(applied, /webhook/i)

  // 게스트 DO 루프에는 넣지 않는다 — 게스트 범위가 아니다.
  const loop = schema.match(/FOREACH t IN ARRAY ARRAY\[[^\]]*\]/)?.[0] ?? ''
  assert.ok(loop, '게스트 DO 루프를 찾지 못했다')
  assert.doesNotMatch(loop, /webhook/i)
})

test('마이그레이션은 가산적이고 두 번 적용해도 같은 상태다', async () => {
  const migration = await readFile(migrationUrl, 'utf8')
  assert.doesNotMatch(migration, /\b(?:DROP|TRUNCATE)\s+TABLE\b/i, '남의 데이터를 지우는 문장이 있으면 안 된다')

  const db = freshDb()
  const applied = withoutPgMemUnsupportedRls(migration)
  db.public.none(applied)
  db.public.none(`INSERT INTO webhook_endpoints (id, org_id, payload, position) VALUES ('WHK-1', 'TENANT-T', '{"direction":"outbound","tokenHash":null}', 0)`)
  db.public.none(`INSERT INTO webhook_deliveries (id, org_id, payload, position) VALUES ('WHD-1', 'TENANT-T', '{"status":"pending"}', 0)`)
  db.public.none(applied)

  const endpoint = db.public.one("SELECT payload->>'direction' AS direction FROM webhook_endpoints WHERE org_id='TENANT-T'")
  assert.equal(endpoint.direction, 'outbound', '두 번째 적용이 이미 있던 행을 지우면 안 된다')
  const delivery = db.public.one("SELECT payload->>'status' AS status FROM webhook_deliveries WHERE org_id='TENANT-T'")
  assert.equal(delivery.status, 'pending')

  for (const table of TABLES) {
    const columns = db.public.many(`SELECT column_name FROM information_schema.columns WHERE table_name='${table}'`)
    for (const column of COMMON_COLUMNS) {
      assert.ok(columns.some((row) => row.column_name === column), `${table}.${column} 공통 컬럼`)
    }
  }
})

test('베이스라인도 같은 컬럼으로 두 테이블을 만든다', async () => {
  const schema = await readFile(schemaUrl, 'utf8')
  const db = freshDb()
  db.public.none(withoutPgMemUnsupportedRls(schema))
  for (const table of TABLES) {
    const columns = db.public.many(`SELECT column_name FROM information_schema.columns WHERE table_name='${table}'`)
    for (const column of COMMON_COLUMNS) {
      assert.ok(columns.some((row) => row.column_name === column), `${table}.${column} 공통 컬럼`)
    }
  }
})

test('두 테이블 모두 supabase 체인 안에서 만들어진다', async () => {
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort()
  const chain = (await Promise.all(files.map((name) => readFile(new URL(name, migrationsDir), 'utf8')))).join('\n')
  for (const table of TABLES) {
    assert.match(chain, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`), `${table}가 supabase/migrations 안에서 만들어져야 한다`)
  }
})

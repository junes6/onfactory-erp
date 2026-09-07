import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'

import { newDb } from 'pg-mem'

import { withoutPgMemUnsupportedRls } from './postgres-store.mjs'

/**
 * R16-G 마이그레이션 — 벌크 이관 세션·청크와 재사용 매핑 규칙.
 *
 * 두 가지를 함께 못 박는다:
 * (1) 체인 파일이 추가만 하고 멱등이며 공통 컬럼을 갖춘다,
 * (2) **베이스라인(db/postgres-schema.sql)에도 같은 CREATE가 있다**.
 * applySchema는 베이스라인 하나만 읽으므로 한쪽만 넣으면 로컬 pg-mem은 통과하면서
 * 실제 Supabase에서만 터진다(ai_conversations가 한동안 그 상태였다).
 */
const migrationUrl = new URL('../../supabase/migrations/20260910010000_bulk_imports.sql', import.meta.url)
const schemaUrl = new URL('../../db/postgres-schema.sql', import.meta.url)

test('1. 마이그레이션은 두 테이블을 추가만 하고 게스트·관리자 정책을 만들지 않는다', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  assert.match(sql, /CREATE TABLE IF NOT EXISTS bulk_imports\b/i)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS bulk_import_rules\b/i)
  assert.doesNotMatch(sql, /\b(?:DROP|TRUNCATE)\s+TABLE\b/i)
  assert.match(sql, /FORCE ROW LEVEL SECURITY/)
  assert.match(sql, /CREATE POLICY bulk_imports_service ON bulk_imports/)
  assert.match(sql, /CREATE POLICY bulk_import_rules_service ON bulk_import_rules/)
  // 게스트에게는 이 테이블의 존재 자체가 없어야 한다 — 세션 행에는 회사의 원본 폴더 구조가 통째로 들어 있다.
  assert.doesNotMatch(sql, /CREATE POLICY (?:bulk_imports|bulk_import_rules)_guest/)
  assert.doesNotMatch(sql, /CREATE POLICY (?:bulk_imports|bulk_import_rules)_tenant/)
})

test('2. pg-mem에 두 번 적용해도 행이 살아 있고 공통 컬럼 6개가 있다', async () => {
  const sql = withoutPgMemUnsupportedRls(await readFile(migrationUrl, 'utf8'))
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true })
  db.public.none('CREATE TABLE core_tenants (id TEXT PRIMARY KEY)')
  db.public.none("INSERT INTO core_tenants (id) VALUES ('TENANT-IMP')")
  db.public.none(sql)
  db.public.none(`INSERT INTO bulk_imports (id, org_id, payload, position) VALUES ('IMP-1', 'TENANT-IMP', '{"kind":"session","sessionId":"IMP-1","status":"uploading"}', 0)`)
  db.public.none(`INSERT INTO bulk_import_rules (id, org_id, payload, position) VALUES ('IMR-1', 'TENANT-IMP', '{"name":"기본 매핑"}', 0)`)
  db.public.none(sql)

  assert.equal(db.public.one("SELECT payload->>'status' AS status FROM bulk_imports WHERE org_id='TENANT-IMP'").status, 'uploading')
  assert.equal(db.public.one("SELECT payload->>'name' AS name FROM bulk_import_rules WHERE org_id='TENANT-IMP'").name, '기본 매핑')
  for (const table of ['bulk_imports', 'bulk_import_rules']) {
    const columns = db.public.many(`SELECT column_name FROM information_schema.columns WHERE table_name='${table}'`)
    for (const column of ['id', 'org_id', 'created_at', 'updated_at', 'deleted_at', 'created_by']) {
      assert.ok(columns.some((row) => row.column_name === column), `${table}.${column}`)
    }
  }
})

test('3. 베이스라인 스키마에도 같은 CREATE·정책·인덱스가 있다', async () => {
  const schema = await readFile(schemaUrl, 'utf8')
  assert.match(schema, /CREATE TABLE IF NOT EXISTS bulk_imports\b/i)
  assert.match(schema, /CREATE TABLE IF NOT EXISTS bulk_import_rules\b/i)
  assert.match(schema, /CREATE POLICY bulk_imports_service ON bulk_imports/)
  assert.match(schema, /CREATE POLICY bulk_import_rules_service ON bulk_import_rules/)
  assert.match(schema, /CREATE INDEX IF NOT EXISTS idx_bulk_imports_active ON bulk_imports/)
  assert.match(schema, /CREATE INDEX IF NOT EXISTS idx_bulk_import_rules_active ON bulk_import_rules/)
})

test('4. 파일명이 사전순 뒤이고 RLS 문장이 pg-mem 필터로 완전히 걷힌다', async () => {
  const files = (await readdir(new URL('../../supabase/migrations/', import.meta.url))).filter((name) => name.endsWith('.sql')).sort()
  // '마지막이어야 한다'로 적으면 다음 절이 마이그레이션을 하나 더할 때마다 깨진다. 잠글 것은 순서다.
  assert.ok(files.indexOf('20260910010000_bulk_imports.sql') > files.indexOf('20260910000000_calendar_sync.sql'))
  const filtered = withoutPgMemUnsupportedRls(await readFile(migrationUrl, 'utf8'))
  // 정책 본문에 세미콜론이 있으면 필터가 반쪽만 걷어내고 PG 테스트 전체가 파싱 오류로 죽는다.
  assert.doesNotMatch(filtered, /ROW LEVEL SECURITY/)
  assert.doesNotMatch(filtered, /CREATE POLICY/)
  assert.doesNotMatch(filtered, /current_setting/)
})

test('5. 저장소 키 두 개가 등록되어 있고 게스트 테이블 목록에는 없다', async () => {
  const { WORKSPACE_TABLES, ARRAY_WORKSPACE_KEYS, GUEST_SCOPE_TABLES } = await import('./constants.mjs')
  assert.equal(WORKSPACE_TABLES['bulk-imports'], 'bulk_imports')
  assert.equal(WORKSPACE_TABLES['bulk-import-rules'], 'bulk_import_rules')
  assert.ok(ARRAY_WORKSPACE_KEYS.has('bulk-imports'))
  assert.ok(ARRAY_WORKSPACE_KEYS.has('bulk-import-rules'))
  assert.equal('bulk_imports' in GUEST_SCOPE_TABLES, false)
  assert.equal('bulk_import_rules' in GUEST_SCOPE_TABLES, false)
})

test('6. 두 키를 WORKSPACE_STORE_KEYS에 넣지 않은 것이 의도다(다음 사람이 채워 넣지 않게)', async () => {
  const source = await readFile(new URL('../app.mjs', import.meta.url), 'utf8')
  const declared = source.match(/const WORKSPACE_STORE_KEYS = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? ''
  assert.ok(declared, 'WORKSPACE_STORE_KEYS 선언을 찾지 못했다')
  // 등록하면 generic PUT이 열리고, 그 라우트에는 '이 세션은 누구 것인가'가 없다.
  assert.equal(declared.includes('bulk-imports'), false)
  assert.equal(declared.includes('bulk-import-rules'), false)
})

/**
 * ai_policy 컬럼은 DDL 변경 없이 이미 기다리고 있다.
 * documentColumns가 payload.aiPolicy를 그 컬럼에 투영하고 CHECK 값도 일치한다 —
 * 진실은 payload이고 컬럼은 인덱스·조회 전용이다.
 */
test('7. items.ai_policy는 payload.aiPolicy를 그대로 받는다(새 DDL이 필요 없다)', async () => {
  const { documentColumns } = await import('./postgres-store.mjs')
  assert.equal(documentColumns({ aiPolicy: 'locked' }).aiPolicy, 'locked')
  assert.equal(documentColumns({ aiPolicy: 'indexed' }).aiPolicy, 'indexed')
  // 값이 없는 옛 문서는 'active' — 어제까지 되던 렌즈가 오늘 막히지 않는다.
  assert.equal(documentColumns({}).aiPolicy, 'active')
  assert.equal(documentColumns({ aiPolicy: '보관만' }).aiPolicy, 'active')
  /**
   * 닫힌 집합의 출처는 document-ai-policy.mjs 하나다. 투영이 목록을 다시 적으면, 수준이 하나 늘었을 때
   * payload는 받아 주고 **컬럼만 조용히 'active'로 내려앉는다** — 조회와 실물이 갈린다.
   */
  const { AI_POLICIES } = await import('../document-ai-policy.mjs')
  for (const level of AI_POLICIES) assert.equal(documentColumns({ aiPolicy: level }).aiPolicy, level)
  const storeSource = await readFile(new URL('./postgres-store.mjs', import.meta.url), 'utf8')
  assert.match(storeSource, /AI_POLICIES\.includes\(payload\?\.aiPolicy\)/)
  assert.equal(storeSource.includes("['locked', 'indexed', 'active']"), false, '컬럼 투영이 닫힌 집합을 다시 적지 않는다')
  const schema = await readFile(schemaUrl, 'utf8')
  assert.match(schema, /ai_policy/i)
})

import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'

import { newDb } from 'pg-mem'

import { withoutPgMemUnsupportedRls } from './postgres-store.mjs'

/**
 * R16-E 마이그레이션 — 구글 캘린더 연결 + 동기화 링크.
 *
 * 두 가지를 함께 못 박는다:
 * (1) 체인 파일이 추가만 하고 멱등이며 공통 컬럼을 갖춘다,
 * (2) **베이스라인(db/postgres-schema.sql)에도 같은 CREATE가 있다**.
 * applySchema는 베이스라인 하나만 읽으므로 한쪽만 넣으면 로컬 pg-mem은 통과하면서
 * 실제 Supabase에서만 터진다(ai_conversations가 한동안 그 상태였다).
 */
const migrationUrl = new URL('../../supabase/migrations/20260910000000_calendar_sync.sql', import.meta.url)
const schemaUrl = new URL('../../db/postgres-schema.sql', import.meta.url)

test('1. 마이그레이션은 두 테이블을 추가만 하고 게스트·관리자 정책을 만들지 않는다', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  assert.match(sql, /CREATE TABLE IF NOT EXISTS calendar_connections\b/i)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS calendar_sync_links\b/i)
  assert.doesNotMatch(sql, /\b(?:DROP|TRUNCATE)\s+TABLE\b/i)
  assert.match(sql, /FORCE ROW LEVEL SECURITY/)
  assert.match(sql, /CREATE POLICY calendar_connections_service ON calendar_connections/)
  assert.match(sql, /CREATE POLICY calendar_sync_links_service ON calendar_sync_links/)
  // 게스트는 이 두 테이블을 읽지 않고, 연결 행에는 봉인된 OAuth 토큰이 들어 있다.
  assert.doesNotMatch(sql, /CREATE POLICY (?:calendar_connections|calendar_sync_links)_guest/)
  // 관리자도 토큰 행에 직접 SELECT할 이유가 없다 — 상태는 /overview가 가려서 준다.
  assert.doesNotMatch(sql, /CREATE POLICY (?:calendar_connections|calendar_sync_links)_tenant/)
})

test('2. pg-mem에 두 번 적용해도 행이 살아 있고 공통 컬럼 6개가 있다', async () => {
  const sql = withoutPgMemUnsupportedRls(await readFile(migrationUrl, 'utf8'))
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true })
  db.public.none('CREATE TABLE core_tenants (id TEXT PRIMARY KEY)')
  db.public.none("INSERT INTO core_tenants (id) VALUES ('TENANT-CAL')")
  db.public.none(sql)
  db.public.none(`INSERT INTO calendar_connections (id, org_id, payload, position) VALUES ('CAL-1', 'TENANT-CAL', '{"accountId":"USR-A","accessTokenEnc":"v1:a:b:c"}', 0)`)
  db.public.none(`INSERT INTO calendar_sync_links (id, org_id, payload, position) VALUES ('CLK-1', 'TENANT-CAL', '{"accountId":"USR-A","eventId":"EV-1"}', 0)`)
  db.public.none(sql)

  assert.equal(db.public.one("SELECT payload->>'accountId' AS owner FROM calendar_connections WHERE org_id='TENANT-CAL'").owner, 'USR-A')
  assert.equal(db.public.one("SELECT payload->>'eventId' AS event FROM calendar_sync_links WHERE org_id='TENANT-CAL'").event, 'EV-1')
  for (const table of ['calendar_connections', 'calendar_sync_links']) {
    const columns = db.public.many(`SELECT column_name FROM information_schema.columns WHERE table_name='${table}'`)
    for (const column of ['id', 'org_id', 'created_at', 'updated_at', 'deleted_at', 'created_by']) {
      assert.ok(columns.some((row) => row.column_name === column), `${table}.${column}`)
    }
  }
})

test('3. 베이스라인 스키마에도 같은 CREATE·정책·인덱스가 있다', async () => {
  const schema = await readFile(schemaUrl, 'utf8')
  assert.match(schema, /CREATE TABLE IF NOT EXISTS calendar_connections\b/i)
  assert.match(schema, /CREATE TABLE IF NOT EXISTS calendar_sync_links\b/i)
  assert.match(schema, /CREATE POLICY calendar_connections_service ON calendar_connections/)
  assert.match(schema, /CREATE POLICY calendar_sync_links_service ON calendar_sync_links/)
  assert.match(schema, /CREATE INDEX IF NOT EXISTS idx_calendar_connections_active ON calendar_connections/)
  assert.match(schema, /CREATE INDEX IF NOT EXISTS idx_calendar_sync_links_active ON calendar_sync_links/)
})

test('4. 파일명이 사전순 뒤이고 RLS 문장이 pg-mem 필터로 완전히 걷힌다', async () => {
  const files = (await readdir(new URL('../../supabase/migrations/', import.meta.url))).filter((name) => name.endsWith('.sql')).sort()
  // '마지막이어야 한다'로 적으면 다음 절이 마이그레이션을 하나 더할 때마다 깨진다. 잠글 것은 순서다.
  assert.ok(files.indexOf('20260910000000_calendar_sync.sql') > files.indexOf('20260909000000_saved_views_custom_fields.sql'))
  const filtered = withoutPgMemUnsupportedRls(await readFile(migrationUrl, 'utf8'))
  // 정책 본문에 세미콜론이 있으면 필터가 반쪽만 걷어내고 PG 테스트 전체가 파싱 오류로 죽는다.
  assert.doesNotMatch(filtered, /ROW LEVEL SECURITY/)
  assert.doesNotMatch(filtered, /CREATE POLICY/)
  assert.doesNotMatch(filtered, /current_setting/)
})

test('5. 저장소 키 두 개가 등록되어 있고 게스트 테이블 목록에는 없다', async () => {
  const { WORKSPACE_TABLES, ARRAY_WORKSPACE_KEYS, GUEST_SCOPE_TABLES } = await import('./constants.mjs')
  assert.equal(WORKSPACE_TABLES['calendar-connections'], 'calendar_connections')
  assert.equal(WORKSPACE_TABLES['calendar-sync-links'], 'calendar_sync_links')
  assert.ok(ARRAY_WORKSPACE_KEYS.has('calendar-connections'))
  assert.ok(ARRAY_WORKSPACE_KEYS.has('calendar-sync-links'))
  // 게스트에게는 이 테이블의 존재 자체가 없다 — guestVisibleIds가 목록 밖 테이블을 거절한다.
  assert.equal('calendar_connections' in GUEST_SCOPE_TABLES, false)
  assert.equal('calendar_sync_links' in GUEST_SCOPE_TABLES, false)
})

/**
 * 안전한 실패 방향을 이름으로 고정한다.
 *
 * 봉인된 값은 테넌트 workspace 키에만 두고, upsertWorkspaceRows에는 stripping이 없어 암호문이 보존된다.
 * 그럼에도 필드 이름을 …TokenEnc·…SecretEnc로 지어 stripSensitivePayload의 정규식에 **일부러 걸리게** 한다.
 * 이 행이 언젠가 계정 payload나 platform 경로로 흘러가면 비밀이 새는 대신 사라진다.
 */
test('6. 토큰 필드 이름은 stripSensitivePayload 정규식에 걸린다', async () => {
  const source = await readFile(new URL('./postgres-store.mjs', import.meta.url), 'utf8')
  const declared = source.match(/const SECRET_ACCOUNT_FIELD = (\/.+\/[a-z]*)/)?.[1]
  assert.ok(declared, 'SECRET_ACCOUNT_FIELD 선언을 찾지 못했다')
  const [, body, flags] = declared.match(/^\/(.*)\/([a-z]*)$/)
  const pattern = new RegExp(body, flags)
  for (const field of ['accessTokenEnc', 'refreshTokenEnc', 'pkceVerifierSecretEnc']) {
    assert.equal(pattern.test(field), true, `${field}는 stripping 경로에서 지워져야 한다`)
  }
  // 반대로 상태 필드는 걸리지 않아야 화면이 계속 상태를 볼 수 있다.
  for (const field of ['lastSyncAt', 'writeCalendarId', 'keyFingerprint']) {
    assert.equal(pattern.test(field), false, field)
  }
})

test('7. 두 키를 WORKSPACE_STORE_KEYS에 넣지 않은 것이 의도다(다음 사람이 채워 넣지 않게)', async () => {
  const source = await readFile(new URL('../app.mjs', import.meta.url), 'utf8')
  const declared = source.match(/const WORKSPACE_STORE_KEYS = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? ''
  assert.ok(declared, 'WORKSPACE_STORE_KEYS 선언을 찾지 못했다')
  // 등록하면 generic GET/PUT이 열리고, 403 ..._ROUTE_REQUIRED는 "그런 키가 있다"는 존재 오라클이 된다.
  assert.equal(declared.includes('calendar-connections'), false)
  assert.equal(declared.includes('calendar-sync-links'), false)
})

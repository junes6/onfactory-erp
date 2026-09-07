import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'

import { newDb } from 'pg-mem'

import { withoutPgMemUnsupportedRls } from './postgres-store.mjs'

const migrationName = '20260911000000_wiki_documents.sql'
const migrationUrl = new URL(`../../supabase/migrations/${migrationName}`, import.meta.url)
const migrationDirectory = new URL('../../supabase/migrations/', import.meta.url)
const baselineUrl = new URL('../../db/postgres-schema.sql', import.meta.url)

test('wiki migration is additive, service-only, and never opens a guest policy', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  assert.match(sql, /CREATE TABLE IF NOT EXISTS wiki_documents\b/i)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS wiki_revisions\b/i)
  assert.doesNotMatch(sql, /\b(?:DROP|TRUNCATE)\s+TABLE\b/i)
  assert.match(sql, /FORCE ROW LEVEL SECURITY/i)
  assert.match(sql, /CREATE POLICY wiki_documents_service\b/i)
  assert.match(sql, /CREATE POLICY wiki_revisions_service\b/i)
  // 게스트 정책을 만드는 순간 앱 필터 한 겹만으로 외부 거래처에 사내 문서 본문이 열린다.
  assert.doesNotMatch(sql, /wiki_\w+_guest/i)
})

test('wiki migration applies twice on pg-mem and keeps the rows written in between', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true })
  db.public.none('CREATE TABLE core_tenants (id TEXT PRIMARY KEY)')
  db.public.none("INSERT INTO core_tenants (id) VALUES ('TENANT-WIKI')")
  const applied = withoutPgMemUnsupportedRls(sql)
  db.public.none(applied)
  db.public.none(`INSERT INTO wiki_documents (id, org_id, payload, position) VALUES ('WDOC-1', 'TENANT-WIKI', '{"title":"품질 표준","version":1}', 0)`)
  db.public.none(`INSERT INTO wiki_revisions (id, org_id, payload, position) VALUES ('WREV-1-1', 'TENANT-WIKI', '{"documentId":"WDOC-1","version":1}', 0)`)
  db.public.none(applied)

  const preserved = db.public.one("SELECT payload->>'title' AS title FROM wiki_documents WHERE org_id='TENANT-WIKI'")
  assert.equal(preserved.title, '품질 표준')
  const revision = db.public.one("SELECT payload->>'documentId' AS document_id FROM wiki_revisions WHERE org_id='TENANT-WIKI'")
  assert.equal(revision.document_id, 'WDOC-1')
  for (const table of ['wiki_documents', 'wiki_revisions']) {
    const columns = db.public.many(`SELECT column_name FROM information_schema.columns WHERE table_name='${table}'`)
    for (const column of ['id', 'org_id', 'created_at', 'updated_at', 'deleted_at', 'created_by']) {
      assert.ok(columns.some((row) => row.column_name === column), `${table}.${column} column`)
    }
  }
})

test('the baseline schema carries the same two tables as the migration chain', async () => {
  // ai_conversations가 체인에만 있어 베이스라인 하나로 세운 데이터베이스에서만 없던 결함의 재발 방지다.
  const baseline = await readFile(baselineUrl, 'utf8')
  for (const table of ['wiki_documents', 'wiki_revisions']) {
    assert.match(baseline, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i'), `베이스라인에 ${table}`)
    assert.match(baseline, new RegExp(`CREATE POLICY ${table}_service\\b`, 'i'), `베이스라인에 ${table}_service 정책`)
  }
  // 게스트 RLS DO 루프의 ARRAY는 불변이다 — 여기에 문서가 끼면 외부인 세션이 사내 문서를 SELECT한다.
  assert.match(baseline, /FOREACH t IN ARRAY ARRAY\['project_spaces', 'project_posts', 'work_items', 'messenger_conversations', 'items', 'guest_grants', 'notices'\]/)
})

test('the wiki migration sorts after every migration that came before it', async () => {
  const files = (await readdir(migrationDirectory)).filter((name) => name.endsWith('.sql')).sort()
  // '마지막이어야 한다'로 적으면 다음 절이 마이그레이션을 하나 더할 때마다 깨진다(R16-I2에서 실제로 깨졌다).
  // 잠글 것은 순서다. 다만 `before.every((name) => name < migrationName)` 은 적으면 안 된다 —
  // before 가 정렬된 배열의 앞부분이라 정의상 항상 참이고, 어떤 입력에서도 빨개지지 않는 죽은 단언이다.
  // 앞선 마이그레이션이 '실제로 있고 앞에 온다'를 묻는 아래 한 줄만이 순서를 잰다.
  assert.ok(files.includes(migrationName), '위키 마이그레이션이 사슬 안에 있어야 한다')
  const before = files.slice(0, files.indexOf(migrationName))
  assert.ok(before.includes('20260910010000_bulk_imports.sql'), '앞선 마이그레이션이 실제로 앞에 있어야 한다')
})

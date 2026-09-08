import assert from 'node:assert/strict'
import fs from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { newDb } from 'pg-mem'

import { createApp } from '../app.mjs'
import { withServer } from '../test-server.mjs'
import { withoutPgMemUnsupportedRls } from './postgres-store.mjs'

const migrationName = '20260913000000_approval_forms.sql'
const migrationsDirectory = new URL('../../supabase/migrations/', import.meta.url)
const migrationUrl = new URL(migrationName, migrationsDirectory)
const baselineUrl = new URL('../../db/postgres-schema.sql', import.meta.url)

/** `CREATE TABLE IF NOT EXISTS <name> ( ... );` 의 괄호 안 본문을 공백만 눌러 돌려준다. */
function createBodyOf(sql, table) {
  const match = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${table}\\s*\\(([\\s\\S]*?)\\)\\s*;`, 'i'))
  return match ? match[1].replace(/\s+/g, ' ').trim() : null
}

/** `CREATE POLICY <table>_service ON <table> ... ;` 한 문장을 공백만 눌러 돌려준다. */
function servicePolicyOf(sql, table) {
  const match = sql.match(new RegExp(`CREATE POLICY ${table}_service ON ${table}[^;]*;`, 'i'))
  return match ? match[0].replace(/\s+/g, ' ').trim() : null
}

/** `CREATE INDEX IF NOT EXISTS <name> ... ;` 한 문장을 공백만 눌러 돌려준다(식까지 통째로). */
function indexStatementOf(sql, name) {
  const match = sql.match(new RegExp(`CREATE INDEX IF NOT EXISTS ${name}\\b[^;]*;`, 'i'))
  return match ? match[0].replace(/\s+/g, ' ').trim() : null
}

/** 그 파일이 이 테이블에 만드는 정책 **이름 전부**. 이름을 모르는 정책까지 잡으려면 목록을 견줘야 한다. */
function policyNamesOn(sql, table) {
  return [...sql.matchAll(new RegExp(`CREATE POLICY\\s+(\\w+)\\s+ON\\s+${table}\\b`, 'gi'))].map((match) => match[1]).sort()
}

test('1. 결재 마이그레이션은 더하기만 하고 서비스 전용 정책만 만든다', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  assert.match(sql, /CREATE TABLE IF NOT EXISTS approval_forms\b/i)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS approval_documents\b/i)
  assert.doesNotMatch(sql, /\b(?:DROP|TRUNCATE)\s+TABLE\b/i)
  for (const table of ['approval_forms', 'approval_documents']) {
    // 테이블마다 따로 요구한다 — `/FORCE ROW LEVEL SECURITY/` 한 줄로는 다른 테이블의 한 줄이 대신 만족시킨다.
    assert.match(sql, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, 'i'), `${table} 에 ENABLE RLS`)
    assert.match(sql, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`, 'i'), `${table} 에 FORCE RLS`)
    // 「켜는가」만이 아니라 「무엇으로 막는가」까지 못 박는다.
    // FORCE RLS 위의 `USING (true)` 는 아무도 막지 않는 no-op이고, 그러면 tenant-guest 세션도
    // 급여·단가·거래처가 든 approval_documents 를 그대로 통과한다.
    const policy = servicePolicyOf(sql, table)
    assert.ok(policy, `사슬에서 ${table}_service 정책 본문을 읽어야 한다`)
    assert.match(policy, /USING \(current_setting\('app\.role', TRUE\) = 'service'\)/, `${table} 읽기는 service 컨텍스트만`)
    assert.match(policy, /WITH CHECK \(current_setting\('app\.role', TRUE\) = 'service'\)/, `${table} 쓰기는 service 컨텍스트만`)
    assert.doesNotMatch(policy, /USING \(true\)/i, `${table} 정책이 열려 있다`)
  }
  // 게스트 정책을 만드는 순간 앱 필터 한 겹만으로 외부 거래처에 급여·단가·거래처가 열린다.
  assert.doesNotMatch(sql, /approval_\w+_guest/i)
})

test('2. pg-mem에 두 번 적용해도 그 사이에 쓴 행이 그대로 남는다', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true })
  db.public.none('CREATE TABLE core_tenants (id TEXT PRIMARY KEY)')
  db.public.none("INSERT INTO core_tenants (id) VALUES ('TENANT-APPROVAL')")
  const applied = withoutPgMemUnsupportedRls(sql)
  db.public.none(applied)
  db.public.none(`INSERT INTO approval_forms (id, org_id, payload, position) VALUES ('AFM-1', 'TENANT-APPROVAL', '{"recordType":"form","name":"지출결의서","amountFieldKey":"amount"}', 0)`)
  db.public.none(`INSERT INTO approval_documents (id, org_id, payload, position) VALUES ('APD-1', 'TENANT-APPROVAL', '{"status":"결재중","drafterId":"USR-1","posting":{"month":"2026-08","amount":250000}}', 0)`)
  db.public.none(applied)

  const form = db.public.one("SELECT payload->>'name' AS name FROM approval_forms WHERE org_id='TENANT-APPROVAL'")
  assert.equal(form.name, '지출결의서')
  const document = db.public.one("SELECT payload->>'status' AS status, payload->'posting'->>'month' AS month FROM approval_documents WHERE org_id='TENANT-APPROVAL'")
  assert.equal(document.status, '결재중')
  assert.equal(document.month, '2026-08', '게시 월 인덱스가 짚는 경로가 실제로 그 자리에 있어야 한다')
})

test('3. 두 테이블 모두 공통 컬럼 여섯 개를 갖는다', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true })
  db.public.none('CREATE TABLE core_tenants (id TEXT PRIMARY KEY)')
  db.public.none(withoutPgMemUnsupportedRls(sql))
  for (const table of ['approval_forms', 'approval_documents']) {
    const columns = db.public.many(`SELECT column_name FROM information_schema.columns WHERE table_name='${table}'`)
    for (const column of ['id', 'org_id', 'created_at', 'updated_at', 'deleted_at', 'created_by']) {
      assert.ok(columns.some((row) => row.column_name === column), `${table}.${column} column`)
    }
  }
})

test('4. 베이스라인이 사슬과 같은 두 테이블을 같은 본문으로 담는다', async () => {
  // ai_conversations가 체인에만 있어 베이스라인 하나로 세운 데이터베이스에서만 없던 결함의 재발 방지다.
  const baseline = await readFile(baselineUrl, 'utf8')
  const sql = await readFile(migrationUrl, 'utf8')
  for (const table of ['approval_forms', 'approval_documents']) {
    assert.match(baseline, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i'), `베이스라인에 ${table}`)
    assert.match(baseline, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, 'i'), `베이스라인에 ${table} ENABLE RLS`)
    assert.match(baseline, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`, 'i'), `베이스라인에 ${table} FORCE RLS`)
    const chainBody = createBodyOf(sql, table)
    assert.ok(chainBody, `사슬에서 ${table} 본문을 읽어야 한다`)
    assert.equal(createBodyOf(baseline, table), chainBody, `${table} 의 CREATE 본문이 두 곳에서 같아야 한다`)
    // 정책도 이름이 아니라 본문을 견준다. scripts/verify-schema-parity.mjs 는 '테이블:정책이름'만 모으므로
    // 한쪽만 `USING (true)` 로 넓어지면 이 줄 말고는 저장소 어디도 빨개지지 않는다.
    const chainPolicy = servicePolicyOf(sql, table)
    assert.ok(chainPolicy, `사슬에서 ${table}_service 정책 본문을 읽어야 한다`)
    assert.equal(servicePolicyOf(baseline, table), chainPolicy, `${table}_service 정책 본문이 두 곳에서 같아야 한다`)
    // 시험 1의 게스트 금지는 사슬 한쪽만 잠근다. 빈 DB를 세우고 PostgresStoreAdapter 가 부팅에서
    // 적용하는 파일은 베이스라인이고(server/store/postgres-store.mjs schemaFile), 저장소의 다른
    // 게스트 정책도 DO 루프가 아니라 거기에 직접 적혀 있다 — 실제로 손대는 자리가 이쪽이다.
    // verify-schema-parity 는 '사슬에 있는 것이 베이스라인에도 있는가' 한 방향만 보므로
    // 베이스라인에만 더한 정책은 아무 데서도 걸리지 않는다. 그래서 이름 금지가 아니라
    // **정책 목록 자체**를 못 박는다 — 이름을 뭐라 붙이든 service 말고는 생길 수 없다.
    for (const [label, text] of [['사슬', sql], ['베이스라인', baseline]]) {
      assert.deepEqual(policyNamesOn(text, table), [`${table}_service`], `${label}의 ${table} 정책은 service 하나뿐이어야 한다`)
    }
  }
  // 인덱스도 이름이 아니라 식을 견준다 — CREATE INDEX IF NOT EXISTS 는 이름이 같으면 다른 식을 조용히 건너뛴다.
  for (const index of ['approval_documents_status_idx', 'approval_documents_drafter_idx', 'approval_documents_month_idx']) {
    const chainIndex = indexStatementOf(sql, index)
    assert.ok(chainIndex, `사슬에 ${index}`)
    assert.equal(indexStatementOf(baseline, index), chainIndex, `${index} 의 식이 두 곳에서 같아야 한다`)
  }
  // 게스트 RLS DO 루프의 ARRAY는 불변이다 — 여기에 결재가 끼면 외부인 세션이 급여·단가를 SELECT한다.
  assert.match(baseline, /FOREACH t IN ARRAY ARRAY\['project_spaces', 'project_posts', 'work_items', 'messenger_conversations', 'items', 'guest_grants', 'notices'\]/)
})

test('5. 파일명이 사전순 뒤이고 RLS 문장이 pg-mem 필터로 완전히 걷힌다', async () => {
  const files = (await readdir(migrationsDirectory)).filter((name) => name.endsWith('.sql')).sort()
  // '마지막이어야 한다'로 적으면 다음 절이 마이그레이션을 더할 때마다 깨진다. 잠글 것은 순서다.
  // `indexOf(A) > indexOf(B)` 로 적으면 정렬된 배열 위의 상수 두 개를 견주는 셈이라 아무것도 잠기지 않는다
  // (B가 사라져도 -1이라 여전히 참이다). 앞부분 배열에 실제로 들어 있는지를 묻는다.
  assert.ok(files.includes(migrationName), '사슬 안에 있어야 한다')
  const before = files.slice(0, files.indexOf(migrationName))
  assert.ok(before.includes('20260911000000_wiki_documents.sql'), '위키 마이그레이션이 실제로 앞에 있어야 한다')
  const filtered = withoutPgMemUnsupportedRls(await readFile(migrationUrl, 'utf8'))
  // 정책 본문에 세미콜론이 있으면 필터가 반쪽만 걷어내고 PG 테스트 전체가 파싱 오류로 죽는다.
  assert.doesNotMatch(filtered, /ROW LEVEL SECURITY/)
  assert.doesNotMatch(filtered, /CREATE POLICY/)
  assert.doesNotMatch(filtered, /DROP POLICY/)
  assert.doesNotMatch(filtered, /current_setting/)
})

test('6. 저장소 키 두 개가 등록되어 있고 게스트 테이블 목록에는 없다', async () => {
  const { WORKSPACE_TABLES, ARRAY_WORKSPACE_KEYS, GUEST_SCOPE_TABLES } = await import('./constants.mjs')
  assert.equal(WORKSPACE_TABLES['approval-forms'], 'approval_forms')
  assert.equal(WORKSPACE_TABLES['approval-documents'], 'approval_documents')
  // 두 키 모두 배열 키다 — singleton으로 들어가면 문서 한 건이 그 회사의 결재 전체를 덮어쓴다.
  assert.ok(ARRAY_WORKSPACE_KEYS.has('approval-forms'))
  assert.ok(ARRAY_WORKSPACE_KEYS.has('approval-documents'))
  assert.equal('approval_forms' in GUEST_SCOPE_TABLES, false)
  assert.equal('approval_documents' in GUEST_SCOPE_TABLES, false)
})

/*
 * 아래 두 시험은 SQL이 아니라 **돌아가는 앱**을 잰다. 결재 두 키의 잠금은 스키마가 아니라
 * 라우트와 참조 판정에 걸려 있고, 소스 텍스트로 재면 경계를 잘못 잡는 순간 조용히 초록이 된다.
 */
const TENANT = 'TENANT-SUNSEA'
const ADMIN_EMAIL = 'admin@sunsea.co.kr'
const uploadDirectory = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onfactory-approval-')), 'documents')
const readJson = async (response) => { const text = await response.text(); try { return JSON.parse(text) } catch { return { raw: text } } }

async function loginAdmin(origin) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: 'tenant', email: ADMIN_EMAIL, password: 'demo1234' }),
  })
  const body = await readJson(response)
  assert.ok(body.account, `관리자 로그인 실패: ${JSON.stringify(body)}`)
  const headers = {
    'content-type': 'application/json',
    cookie: response.headers.get('set-cookie') ?? '',
    'x-workspace-identity': `${body.account.tenantId}:${body.account.id}`,
  }
  return async (method, route, payload) => {
    const result = await fetch(`${origin}${route}`, {
      method, headers, ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    })
    return { status: result.status, body: await readJson(result) }
  }
}

/** 자료실 한 건. 시험 8·9가 같은 모양을 쓴다. */
const document = (id, name) => ({
  id, tenantId: TENANT, name, originalName: name, mime: 'application/pdf', size: 12,
  checksum: `sha-${id}`, category: '공통자료', visibility: 'company', departments: [], allowedUserIds: [],
  tags: [], summary: '', uploadedAt: '2026-09-01T00:00:00.000Z',
  uploadedById: 'USR-SUNSEA-ADMIN', uploadedByName: '김서원', storage: 'local',
})

/**
 * 형제 마이그레이션 시험 넷이 갖고 있는 잠금을 결재에도 건다 — 다만 '짝'으로 적고, **라우트를 실제로 친다**.
 *
 * 설계는 I3에서 두 키를 WORKSPACE_STORE_KEYS에 **등록하고 403으로 닫는다**(D9). 그러니 형제처럼
 * '키가 없다'만 요구하면 I3이 지운다. 위험한 것은 등록과 403 사이의 중간 상태다 — 그 상태에서는
 * tenant-admin 한 명이 generic PUT 한 번으로 status·currentStep·결재선 판정을 통째로 덮어쓰고
 * 이력도 남지 않는다. 그래서 키마다 (오늘의 404) 또는 (I3 뒤의 403) 만 통과시키고 200은 무조건 막는다.
 *
 * 소스 텍스트를 긁던 앞 판은 못 쓴다: `app.put('/api/workspace/:key'` 부터 다음 `  app.<method>(`
 * 까지를 'PUT 본문'으로 잘랐는데 그 사이에 라우트 **등록 구역**(registerWorkItemTreeRoutes·
 * registerWikiRoutes…)이 통째로 들어가 900줄이 됐다. I3이 그 자리에 registerApprovalRoutes 를 놓으면
 * 주석 한 줄만으로도 초록이 되고, generic PUT은 활짝 열린 채로 남는다.
 */
test('7. 두 키는 generic 저장소 라우트로 읽히지도 쓰이지도 않는다 — 앱에 직접 물어본다', async () => {
  const store = { version: 2, tenants: { [TENANT]: {} }, platform: {} }
  const app = createApp({
    apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {}, documentUploadDirectory: uploadDirectory(),
  })
  await withServer(app, async (origin) => {
    const call = await loginAdmin(origin)
    // 대조군. 이것이 없으면 아래 404가 '키 미등록'인지 로그인·헤더·경로가 어긋난 404인지 갈라지지 않고,
    // I3·I4가 인증 미들웨어를 건드려 이 호출이 다른 이유로 404가 되면 시험이 조용히 초록으로 남는다.
    const registered = await call('GET', '/api/workspace/work-items')
    assert.equal(registered.status, 200, `generic 저장소 라우트 자체가 죽었다 — ${registered.status} ${JSON.stringify(registered.body)}`)
    for (const key of ['approval-forms', 'approval-documents']) {
      /** 오늘은 키 미등록(404), I3 뒤에는 전용 라우트 안내(403). 그 밖은 전부 실패다. */
      const assertClosed = ({ status, body }, what) => {
        const code = body?.error?.code
        const closed = (status === 404 && code === 'STORE_KEY_NOT_FOUND') || (status === 403 && code === 'APPROVAL_ROUTE_REQUIRED')
        assert.ok(closed, `generic ${what} /api/workspace/${key} 가 열려 있다 — ${status} ${JSON.stringify(body)}`)
      }
      assertClosed(await call('GET', `/api/workspace/${key}`), 'GET')
      // 결재선도 이력도 없이 '승인'인 문서다. 이것이 실린다면 그 순간 결재 판정 전체가 무의미해진다.
      assertClosed(await call('PUT', `/api/workspace/${key}`, {
        data: [{ id: 'APD-FORGED-01', status: '승인', currentStep: 9, line: [], history: [], posting: { month: '2026-09', amount: 999_999_999 } }],
      }), 'PUT')
      assert.equal(store.tenants[TENANT][key], undefined, `${key} 가 generic PUT으로 저장되면 안 된다`)
    }
  })
})

/**
 * 결재 문서가 붙잡은 자료실 파일은 자료실에서 지워지지 않는다.
 *
 * 위키가 같은 사고를 시험으로 못 박아 둔 자리의 결재 짝이다(server/wiki-routes.test.mjs:765).
 * 결재 첨부는 `{id}` 객체가 아니라 `DOC-` **문자열** 배열이고(설계 §1.3 ATTACHMENT_ID_RE),
 * 증빙은 `evidenceId` 한 개다. 둘 다 참조로 세지 않으면 결재가 도는 중에 근거 파일이 사라진다.
 */
test('8. 결재 문서의 첨부·증빙은 자료실에서 지워지지 않고, 아무도 안 쓰는 파일은 지워진다', async () => {
  const store = {
    version: 2,
    tenants: {
      [TENANT]: {
        'company-documents': {
          data: [document('DOC-APPROVAL-ATT', '견적서.pdf'), document('DOC-APPROVAL-EVI', '세금계산서.pdf'), document('DOC-APPROVAL-FREE', '아무도 안 쓰는 파일.pdf')],
          updatedAt: '2026-09-01T00:00:00.000Z',
        },
        'approval-documents': {
          data: [{
            id: 'APD-REF-01', formId: 'AFM-EXPENSE', title: '9월 원부자재 대금', status: '결재중', currentStep: 1,
            drafterId: 'USR-SUNSEA-ADMIN', values: {}, attachments: ['DOC-APPROVAL-ATT'], evidenceId: 'DOC-APPROVAL-EVI',
            line: [], ccIds: [], history: [], version: 1,
          }],
          updatedAt: '2026-09-01T00:00:00.000Z',
        },
      },
    },
    platform: {},
  }
  const app = createApp({
    apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {}, documentUploadDirectory: uploadDirectory(),
  })
  await withServer(app, async (origin) => {
    const call = await loginAdmin(origin)
    for (const [id, what] of [['DOC-APPROVAL-ATT', '첨부'], ['DOC-APPROVAL-EVI', '증빙']]) {
      const removed = await call('DELETE', `/api/documents/${id}`)
      assert.equal(removed.status, 409, `결재 ${what} 파일이 지워졌다 — ${JSON.stringify(removed.body)}`)
      assert.equal(removed.body?.error?.code, 'DOCUMENT_IN_USE')
      // 규칙 11: 범위를 말하는 문장은 돌아가는 앱에 대고 잰다. 결재가 붙잡아 나가는 409가
      // 「업무·일지·인증·재고·공장 또는 메신저」 여섯 화면만 세면, 사용자는 그 자료를 붙잡고
      // 있지도 않은 화면에 가서 연결을 풀라는 말을 듣는다. 열거를 늘리는 대신 범위를 다시 썼으므로
      // 여기서 잠글 것은 '닫힌 열거로 되돌아가지 않았는가'다.
      assert.doesNotMatch(
        String(removed.body?.error?.message ?? ''),
        /업무·일지·인증·재고·공장 또는 메신저/,
        `409 문장이 실제 범위보다 좁은 닫힌 열거다 — ${removed.body?.error?.message}`,
      )
      // 그리고 문장은 **실제로 할 수 있는 일**을 말해야 한다. 이 문서는 `'결재중'` 이라 PATCH 가
      // 409 `APPROVAL_NOT_EDITABLE` 이고 DELETE 도 닫혀 있다 — 「연결을 해제한 뒤 삭제하라」는
      // 이 갈래에서 아무도 할 수 없는 행동이다. 결과에 따라 갈린다는 사실을 그대로 적는다.
      assert.match(String(removed.body?.error?.message ?? ''), /반려·회수되면 삭제할 수 있고/)
      assert.doesNotMatch(
        String(removed.body?.error?.message ?? ''),
        /연결을 해제/,
        `결재중 문서의 409가 할 수 없는 행동을 하라고 말한다 — ${removed.body?.error?.message}`,
      )
    }
    // 대조군이 없으면 '무엇이든 409'인 시험과 구분되지 않는다.
    const free = await call('DELETE', '/api/documents/DOC-APPROVAL-FREE')
    assert.equal(free.status, 200, `아무도 참조하지 않는 파일은 지워져야 한다 — ${JSON.stringify(free.body)}`)
  })
})

/**
 * 문자열 첨부 갈래는 **결재 키에서만** 열린다.
 *
 * `linkedDocumentIds` 는 두 곳이 함께 쓴다 — 삭제를 막는 `documentIsReferenced` 와, generic PUT의
 * 수용을 판정하는 `canReferenceDocuments`(server/app.mjs, 12개 키). 문자열 갈래를 helper 전체에
 * 켜 두면 결재와 무관한 그 12개 키의 계약까지 같이 좁아져, 예전에 `attachments: ['DOC-…']` 로
 * 저장된 행을 **GET 한 그대로 다시 PUT 할 수 없게 된다**(저장소 규칙 1: 클라이언트가 새로 고칠 수
 * 없는 데이터로 행동을 영구히 막지 않는다). 게다가 객체 첨부만 쓰는 그 키들에 문자열 한 줄을 심어
 * 남의 자료를 삭제 불가로 만드는 길도 함께 열린다 — 그 갈래는 권한 검사를 통과하지 않기 때문이다.
 *
 * 그래서 이 시험은 결재 밖 키 하나(company-assets)를 대조군으로 못 박는다.
 */
test('9. 문자열 첨부 갈래는 결재 키에서만 열린다 — 결재 밖 키의 수용·삭제 판정은 그대로다', async () => {
  const store = {
    version: 2,
    tenants: {
      [TENANT]: {
        'company-documents': { data: [document('DOC-LEGACY-STR', '옛 첨부.pdf')], updatedAt: '2026-09-01T00:00:00.000Z' },
        // 문자열 첨부로 이미 저장돼 있는 행. 오늘의 클라이언트는 이런 모양을 만들지 않지만,
        // 이 시험이 잠그는 것은 '만들어져 있었다면 어떻게 되는가'다.
        'company-assets': {
          data: [{ id: 'AST-LEGACY', name: '노트북', attachments: ['DOC-LEGACY-STR'] }],
          updatedAt: '2026-09-01T00:00:00.000Z',
        },
      },
    },
    platform: {},
  }
  const app = createApp({
    apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {}, documentUploadDirectory: uploadDirectory(),
  })
  await withServer(app, async (origin) => {
    const call = await loginAdmin(origin)
    // (1) 읽은 그대로 다시 저장할 수 있다.
    const read = await call('GET', '/api/workspace/company-assets')
    assert.equal(read.status, 200)
    const rewritten = await call('PUT', '/api/workspace/company-assets', { data: read.body?.data })
    assert.equal(rewritten.status, 200, `읽은 그대로 다시 저장이 거절됐다 — ${rewritten.status} ${JSON.stringify(rewritten.body)}`)

    // (2) 그 문자열은 결재 밖 키에서 참조로 세지 않는다 — 남의 자료를 삭제 불가로 묶지 못한다.
    const removed = await call('DELETE', '/api/documents/DOC-LEGACY-STR')
    assert.equal(removed.status, 200, `결재 밖 키의 문자열 첨부가 자료 삭제를 잠갔다 — ${JSON.stringify(removed.body)}`)

    // (3) 대조군. 객체 첨부의 판정은 예전 그대로 좁다 — 못 읽는 자료를 가리키면 여전히 거절이다.
    //     이 줄이 없으면 (1)은 '무엇이든 200'인 시험과 구분되지 않는다.
    const objectAttachment = await call('PUT', '/api/workspace/company-assets', {
      data: [{ id: 'AST-LEGACY', name: '노트북', attachments: [{ id: 'DOC-NOT-THERE', name: '없는 파일', size: '1 KB' }] }],
    })
    assert.equal(objectAttachment.status, 400, `객체 첨부의 참조 검사가 함께 풀렸다 — ${objectAttachment.status}`)
    assert.equal(objectAttachment.body?.error?.code, 'INVALID_DOCUMENT_REFERENCE')
  })
})

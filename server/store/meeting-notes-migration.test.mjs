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

const migrationName = '20260914000000_meeting_notes.sql'
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

test('1. 회의록 마이그레이션은 더하기만 하고 서비스 전용 정책만 만든다', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  assert.match(sql, /CREATE TABLE IF NOT EXISTS meeting_notes\b/i)
  assert.doesNotMatch(sql, /\b(?:DROP|TRUNCATE)\s+TABLE\b/i)
  assert.match(sql, /ALTER TABLE meeting_notes ENABLE ROW LEVEL SECURITY/i)
  assert.match(sql, /ALTER TABLE meeting_notes FORCE ROW LEVEL SECURITY/i)
  // 「켜는가」만이 아니라 「무엇으로 막는가」까지 못 박는다. FORCE RLS 위의 `USING (true)` 는
  // 아무도 막지 않는 no-op이고, 그러면 tenant-guest 세션도 회의 전사 원문을 그대로 통과한다.
  const policy = servicePolicyOf(sql, 'meeting_notes')
  assert.ok(policy, '사슬에서 meeting_notes_service 정책 본문을 읽어야 한다')
  assert.match(policy, /USING \(current_setting\('app\.role', TRUE\) = 'service'\)/, '읽기는 service 컨텍스트만')
  assert.match(policy, /WITH CHECK \(current_setting\('app\.role', TRUE\) = 'service'\)/, '쓰기는 service 컨텍스트만')
  assert.doesNotMatch(policy, /USING \(true\)/i, 'meeting_notes 정책이 열려 있다')
  // 게스트 정책을 만드는 순간 앱 필터 한 겹만으로 외부 거래처에 회의 전사 원문이 열린다.
  assert.doesNotMatch(sql, /meeting_notes_\w*guest/i)
})

test('2. pg-mem에 두 번 적용해도 그 사이에 쓴 행이 그대로 남는다', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true })
  db.public.none('CREATE TABLE core_tenants (id TEXT PRIMARY KEY)')
  db.public.none("INSERT INTO core_tenants (id) VALUES ('TENANT-MEETING')")
  const applied = withoutPgMemUnsupportedRls(sql)
  db.public.none(applied)
  db.public.none(`INSERT INTO meeting_notes (id, org_id, payload, position) VALUES ('MTG-1', 'TENANT-MEETING', '{"title":"9월 품질 회의","status":"done","documentId":"WDOC-1","transcriptChars":1200}', 0)`)
  db.public.none(applied)

  const row = db.public.one("SELECT payload->>'title' AS title, payload->>'status' AS status, payload->>'documentId' AS document_id FROM meeting_notes WHERE org_id='TENANT-MEETING'")
  assert.equal(row.title, '9월 품질 회의')
  assert.equal(row.status, 'done', '상태 인덱스가 짚는 경로가 실제로 그 자리에 있어야 한다')
  assert.equal(row.document_id, 'WDOC-1', '회의록 문서를 가리키는 id가 사라지면 만든 문서로 돌아갈 길이 없다')
})

test('3. 공통 컬럼 여섯 개를 갖고, 컬럼 집합이 형제 approval_documents 와 글자 그대로 같다', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true })
  db.public.none('CREATE TABLE core_tenants (id TEXT PRIMARY KEY)')
  db.public.none(withoutPgMemUnsupportedRls(sql))
  const columnsOf = (database, table) => database.public
    .many(`SELECT column_name FROM information_schema.columns WHERE table_name='${table}'`)
    .map((row) => row.column_name)
    .sort()
  const columns = columnsOf(db, 'meeting_notes')
  for (const column of ['id', 'org_id', 'created_at', 'updated_at', 'deleted_at', 'created_by']) {
    assert.ok(columns.includes(column), `meeting_notes.${column} column`)
  }
  // 「형제와 같은 모양」은 사람이 세어 적는 숫자가 아니라 **세운 DB에 물어서** 나와야 한다.
  // 설계 본문 §1.2/§3.2 와 M2 보고가 이 테이블을 「11컬럼」이라 적었지만 실제로는 10개다.
  const baseline = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true })
  baseline.public.none(withoutPgMemUnsupportedRls(await readFile(baselineUrl, 'utf8')))
  assert.deepEqual(columns, columnsOf(baseline, 'approval_documents'), '형제 approval_documents 와 컬럼 집합이 같아야 한다')
  assert.equal(columns.length, 10, `meeting_notes 는 10컬럼이다 — ${columns.join(', ')}`)
})

test('4. 베이스라인이 사슬과 같은 테이블을 같은 본문으로 담는다', async () => {
  // ai_conversations가 체인에만 있어 베이스라인 하나로 세운 데이터베이스에서만 없던 결함의 재발 방지다.
  const baseline = await readFile(baselineUrl, 'utf8')
  const sql = await readFile(migrationUrl, 'utf8')
  assert.match(baseline, /CREATE TABLE IF NOT EXISTS meeting_notes\b/i, '베이스라인에 meeting_notes')
  assert.match(baseline, /ALTER TABLE meeting_notes ENABLE ROW LEVEL SECURITY/i, '베이스라인에 ENABLE RLS')
  assert.match(baseline, /ALTER TABLE meeting_notes FORCE ROW LEVEL SECURITY/i, '베이스라인에 FORCE RLS')
  const chainBody = createBodyOf(sql, 'meeting_notes')
  assert.ok(chainBody, '사슬에서 meeting_notes 본문을 읽어야 한다')
  assert.equal(createBodyOf(baseline, 'meeting_notes'), chainBody, 'CREATE 본문이 두 곳에서 같아야 한다')
  // 정책도 이름이 아니라 본문을 견준다. scripts/verify-schema-parity.mjs 는 '테이블:정책이름'만 모으므로
  // 한쪽만 `USING (true)` 로 넓어지면 이 줄 말고는 저장소 어디도 빨개지지 않는다.
  const chainPolicy = servicePolicyOf(sql, 'meeting_notes')
  assert.ok(chainPolicy, '사슬에서 meeting_notes_service 정책 본문을 읽어야 한다')
  assert.equal(servicePolicyOf(baseline, 'meeting_notes'), chainPolicy, '정책 본문이 두 곳에서 같아야 한다')
  // 시험 1의 게스트 금지는 사슬 한쪽만 잠근다. 빈 DB를 세우고 PostgresStoreAdapter 가 부팅에서
  // 적용하는 파일은 베이스라인이고(server/store/postgres-store.mjs schemaFile), verify-schema-parity 는
  // '사슬에 있는 것이 베이스라인에도 있는가' 한 방향만 보므로 베이스라인에만 더한 정책은
  // 아무 데서도 걸리지 않는다. 그래서 이름 금지가 아니라 **정책 목록 자체**를 못 박는다.
  for (const [label, text] of [['사슬', sql], ['베이스라인', baseline]]) {
    assert.deepEqual(policyNamesOn(text, 'meeting_notes'), ['meeting_notes_service'], `${label}의 meeting_notes 정책은 service 하나뿐이어야 한다`)
  }
  // 인덱스도 이름이 아니라 식을 견준다 — CREATE INDEX IF NOT EXISTS 는 이름이 같으면 다른 식을 조용히 건너뛴다.
  const chainIndex = indexStatementOf(sql, 'meeting_notes_status_idx')
  assert.ok(chainIndex, '사슬에 meeting_notes_status_idx')
  assert.equal(indexStatementOf(baseline, 'meeting_notes_status_idx'), chainIndex, '인덱스 식이 두 곳에서 같아야 한다')
  // 게스트 RLS DO 루프의 ARRAY는 불변이다 — 여기에 회의록이 끼면 외부인 세션이 전사 원문을 SELECT한다.
  assert.match(baseline, /FOREACH t IN ARRAY ARRAY\['project_spaces', 'project_posts', 'work_items', 'messenger_conversations', 'items', 'guest_grants', 'notices'\]/)
})

test('5. 파일명이 사전순 뒤이고 RLS 문장이 pg-mem 필터로 완전히 걷힌다', async () => {
  const files = (await readdir(migrationsDirectory)).filter((name) => name.endsWith('.sql')).sort()
  // '마지막이어야 한다'로 적으면 다음 절이 마이그레이션을 더할 때마다 깨진다. 잠글 것은 순서다.
  assert.ok(files.includes(migrationName), '사슬 안에 있어야 한다')
  const before = files.slice(0, files.indexOf(migrationName))
  assert.ok(before.includes('20260913000000_approval_forms.sql'), '결재 마이그레이션이 실제로 앞에 있어야 한다')
  assert.ok(before.includes('20260911000000_wiki_documents.sql'), '회의록은 문서(위키) 뒤에 온다 — 회의록 문서가 위키에 실린다')
  const filtered = withoutPgMemUnsupportedRls(await readFile(migrationUrl, 'utf8'))
  // 정책 본문에 세미콜론이 있으면 필터가 반쪽만 걷어내고 PG 테스트 전체가 파싱 오류로 죽는다.
  assert.doesNotMatch(filtered, /ROW LEVEL SECURITY/)
  assert.doesNotMatch(filtered, /CREATE POLICY/)
  assert.doesNotMatch(filtered, /DROP POLICY/)
  assert.doesNotMatch(filtered, /current_setting/)
})

test('6. 저장소 키가 등록되어 있고 게스트 테이블 목록에는 없다', async () => {
  const { WORKSPACE_TABLES, ARRAY_WORKSPACE_KEYS, GUEST_SCOPE_TABLES } = await import('./constants.mjs')
  assert.equal(WORKSPACE_TABLES['meeting-notes'], 'meeting_notes')
  // 배열 키다 — singleton으로 들어가면 회의 한 건이 그 회사의 회의록 전체를 덮어쓴다.
  assert.ok(ARRAY_WORKSPACE_KEYS.has('meeting-notes'))
  assert.equal('meeting_notes' in GUEST_SCOPE_TABLES, false)
})

/*
 * 아래 시험은 SQL이 아니라 **돌아가는 앱**을 잰다. 회의록 키의 잠금은 스키마가 아니라
 * 라우트에 걸려 있고, 소스 텍스트로 재면 경계를 잘못 잡는 순간 조용히 초록이 된다.
 */
const TENANT = 'TENANT-SUNSEA'
const ADMIN_EMAIL = 'admin@sunsea.co.kr'
const uploadDirectory = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onfactory-meeting-')), 'documents')
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

/**
 * 설계는 M3에서 이 키를 WORKSPACE_STORE_KEYS에 **등록하고 403으로 닫는다**(D9). 그러니 형제처럼
 * '키가 없다'만 요구하면 M3이 지운다. 위험한 것은 등록과 403 사이의 중간 상태다 — 그 상태에서는
 * 아무 구성원이나 generic PUT 한 번으로 지어낸 전사 원문과 요약을 회의록에 심고, 그것이 그대로
 * 회의록 문서와 업무 제안의 근거가 된다. 그래서 (오늘의 404) 또는 (M3 뒤의 403) 만 통과시키고
 * 200은 무조건 막는다.
 */
test('7. 회의록 키는 generic 저장소 라우트로 읽히지도 쓰이지도 않는다 — 앱에 직접 물어본다', async () => {
  const store = { version: 2, tenants: { [TENANT]: {} }, platform: {} }
  const app = createApp({
    apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {}, documentUploadDirectory: uploadDirectory(),
  })
  await withServer(app, async (origin) => {
    const call = await loginAdmin(origin)
    // 대조군. 이것이 없으면 아래 404가 '키 미등록'인지 로그인·헤더·경로가 어긋난 404인지 갈라지지 않고,
    // M3·M4가 인증 미들웨어를 건드려 이 호출이 다른 이유로 404가 되면 시험이 조용히 초록으로 남는다.
    const registered = await call('GET', '/api/workspace/work-items')
    assert.equal(registered.status, 200, `generic 저장소 라우트 자체가 죽었다 — ${registered.status} ${JSON.stringify(registered.body)}`)

    /** 오늘은 키 미등록(404), M3 뒤에는 전용 라우트 안내(403). 그 밖은 전부 실패다. */
    const assertClosed = ({ status, body }, what) => {
      const code = body?.error?.code
      const closed = (status === 404 && code === 'STORE_KEY_NOT_FOUND') || (status === 403 && code === 'MEETING_ROUTE_REQUIRED')
      assert.ok(closed, `generic ${what} /api/workspace/meeting-notes 가 열려 있다 — ${status} ${JSON.stringify(body)}`)
    }
    assertClosed(await call('GET', '/api/workspace/meeting-notes'), 'GET')
    // 아무도 하지 않은 말이 적힌 '끝난' 회의록이다. 이것이 실린다면 그 순간 회의록의 근거 규칙 전체가 무의미해진다.
    assertClosed(await call('PUT', '/api/workspace/meeting-notes', {
      data: [{
        id: 'MTG-FORGED-01', title: '지어낸 회의', status: 'done', transcriptText: '아무도 하지 않은 말',
        summary: { summary: '지어낸 요약', participants: [], decisions: [], tasks: [], insufficient: false, mode: 'grounded-fallback', notice: '' },
        documentId: 'WDOC-FORGED', proposalIds: [],
      }],
    }), 'PUT')
    assert.equal(store.tenants[TENANT]['meeting-notes'], undefined, 'meeting-notes 가 generic PUT으로 저장되면 안 된다')
  })
})

/** 자료실 한 행. 파일 바이트는 없어도 된다 — 삭제 라우트는 잠금을 먼저 보고, 파일이 없으면 그냥 지운다. */
const libraryDocument = (id, name) => ({
  id, tenantId: TENANT, name, originalName: name, mime: 'application/octet-stream', size: 12, checksum: `sha-${id}`,
  category: '공통자료', visibility: 'all', departments: [], allowedUserIds: [], tags: [], summary: '',
  uploadedAt: '2026-09-01T00:00:00.000Z', uploadedById: 'USR-SUNSEA-ADMIN', uploadedByName: '김서원', storage: 'local',
})

/**
 * 회의록 payload 는 원본 녹음·전사 원문을 자료실 문서 **id 로만** 가리킨다(§3.2). 그 자료가 자료실에서
 * 지워지면 회의록에는 없는 파일을 가리키는 id 만 남고, 20,000자를 넘는 전사에서는 「원문이 정본」이라던
 * 그 정본이 사라진다. 회의록 문서(위키)도 이것을 대신 붙잡지 못한다 — `buildMeetingBlocks` 는 원본을
 * `attachmentId` 가 든 블록이 아니라 **문단 텍스트**로 적으므로 위키 갈래가 그 id 를 세지 않는다.
 *
 * 그래서 잠금은 회의록 자기 갈래로 선다. 문구도 갈라야 한다 — 회의에는 원본 연결을 끊는 길이 없고
 * (`PATCH /api/meetings/:id` 는 제목·참석자만 받는다) 회의를 삭제하는 것만이 푸는 길이므로,
 * 'linked' 의 「해당 화면에서 먼저 연결을 해제한 뒤」를 주면 아무도 할 수 없는 일을 시키는 셈이다(규칙 3·11).
 */
test('8. 회의가 원본으로 쓰는 녹음·전사 파일은 자료실에서 그냥 지워지지 않는다 — 앱에 직접 물어본다', async () => {
  const store = {
    version: 2,
    tenants: {
      [TENANT]: {
        'company-documents': {
          data: [
            libraryDocument('DOC-MTG-REC-77', '9월 품질 회의.m4a'),
            libraryDocument('DOC-MTG-TXT-77', '9월 품질 회의.vtt'),
            libraryDocument('DOC-FREE-77', '아무도 안 쓰는 자료.pdf'),
          ],
          updatedAt: '2026-09-01T00:00:00.000Z',
        },
        'meeting-notes': {
          data: [{
            id: 'MTG-HOLD-01', tenantId: TENANT, title: '9월 품질 회의',
            recordingDocumentId: 'DOC-MTG-REC-77', transcriptDocumentId: 'DOC-MTG-TXT-77',
            transcriptText: '김서원: 단가는 동결합니다.', transcriptChars: 14,
            documentId: 'WDOC-hold-01', participantIds: [], status: 'done', error: '',
            summary: null, proposalIds: [], usage: {},
            createdById: 'USR-SUNSEA-ADMIN', createdByName: '김서원',
            createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
          }],
          updatedAt: '2026-09-01T00:00:00.000Z',
        },
      },
    },
    platform: {}, accountApprovals: {}, accountCredentials: {}, invitedAccounts: [], passwordResetRequests: [],
  }
  const app = createApp({
    apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {}, documentUploadDirectory: uploadDirectory(),
  })
  await withServer(app, async (origin) => {
    const call = await loginAdmin(origin)
    // 대조군. 회의가 잡지 않은 자료는 그대로 지워진다 — 아래 409 가 '삭제가 통째로 막혔다'가 아님을 가른다.
    const free = await call('DELETE', '/api/documents/DOC-FREE-77')
    assert.equal(free.status, 200, `잡히지 않은 자료가 지워지지 않는다 — ${free.status} ${JSON.stringify(free.body)}`)

    for (const [id, what] of [['DOC-MTG-REC-77', '녹음'], ['DOC-MTG-TXT-77', '전사 원문']]) {
      const blocked = await call('DELETE', `/api/documents/${id}`)
      assert.equal(blocked.status, 409, `회의 ${what} 원본이 그냥 지워진다 — ${blocked.status} ${JSON.stringify(blocked.body)}`)
      assert.equal(blocked.body?.error?.code, 'DOCUMENT_IN_USE')
      const message = String(blocked.body?.error?.message ?? '')
      assert.match(message, /회의/, `문구가 무엇이 잡고 있는지 말하지 않는다 — ${message}`)
      // 회의에는 원본 연결만 끊는 길이 없다. 그 문장을 주면 사용자는 찾다가 못 찾고 같은 409를 다시 받는다.
      assert.doesNotMatch(message, /연결을 해제/, `회의에는 연결을 해제할 자리가 없다 — ${message}`)
    }
  })
})

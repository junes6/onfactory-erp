import assert from 'node:assert/strict'
import { createHash, scryptSync } from 'node:crypto'
import test from 'node:test'

import { createApp } from './app.mjs'
import { MAX_MANIFEST_PAGE, OVERSIZE_MESSAGE, UNFINISHED_MESSAGE, UNMAPPED_MESSAGE, UNVERIFIED_UPLOAD_MESSAGE } from './bulk-import.mjs'
import { withServer } from './test-server.mjs'

/**
 * Flow 파일함 벌크 이관 — HTTP 계약.
 *
 * **대용량 없이 대용량을 시험한다**: 실제로 올리는 파일은 3단계 폴더의 7개(수십 바이트)이고,
 * 프로토콜이 200개를 넘겨도 버티는지는 220개짜리 합성 매니페스트로 본다(바이트 0).
 * 판정 7이 '폴더 3단계·파일 200개 이상'을 예시로 들었으므로, 페이지 나눔과 4mb 본문 한계를 함께 잠근다.
 */

const TENANT = 'TENANT-SUNSEA'
const OTHER_TENANT = 'TENANT-POHANG'
const ADMIN = { id: 'USR-SUNSEA-ADMIN', email: 'admin@sunsea.co.kr' }
const PARK = { id: 'USR-SUNSEA-PARK', name: '박지현', email: 'jihyun.park@sunsea.co.kr' }
const OH = { id: 'USR-SUNSEA-OH', name: '오태식', email: 'taesik.oh@sunsea.co.kr' }
const GUEST = { id: 'USR-TENANT-SUNSEA-GUEST01', name: '홍거래', email: 'guest@partner.example', password: 'Guest!Pass2026' }
const GRANT_ID = 'GST-TENANT-SUNSEA-000001'

const digestHex = (password, accountId) => scryptSync(String(password), `onfactory:${accountId}`, 32).toString('hex')
const sha = (value) => createHash('sha256').update(value).digest('hex')

/** 3단계 폴더 · 7개 파일. 바이트는 8~40이면 충분하다 — 시험하려는 것은 크기가 아니라 경로와 매핑이다. */
const FILES = [
  { path: 'Flow/계약/2025/삼성전자_계약서.pdf', body: '계약 본문 하나' },
  { path: 'Flow/계약/2025/부속합의서.pdf', body: '부속 합의 본문' },
  { path: 'Flow/계약/2024/구계약.pdf', body: '옛 계약 본문' },
  { path: 'Flow/설계/도면/A동.dwg', body: 'A동 도면 데이터' },
  { path: 'Flow/설계/도면/B동.dwg', body: 'B동 도면 데이터' },
  { path: 'Flow/설계/검토/검토의견.docx', body: '검토 의견 본문' },
  { path: '잡자료/메모.txt', body: '메모' },
]
const manifestEntry = (file) => ({ path: file.path, name: file.path.split('/').at(-1), size: Buffer.byteLength(file.body), sha256: sha(file.body) })

const project = (id, name, members) => ({
  id, name, description: '', visibility: 'members', status: 'active', stage: '진행 중', client: '', amount: 0,
  ownerId: ADMIN.id, ownerName: '김서원', members: [{ id: ADMIN.id, name: '김서원', role: 'owner' }, ...members],
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
})

function freshStore({ documents = [] } = {}) {
  return {
    version: 2,
    tenants: {
      [TENANT]: {
        'project-spaces': { data: [
          project('PRJ-CONTRACT', '계약 이관', [{ id: PARK.id, name: PARK.name, role: 'editor' }, { id: OH.id, name: OH.name, role: 'viewer' }, { id: GUEST.id, name: GUEST.name, role: 'viewer', kind: 'guest' }]),
          project('PRJ-DESIGN', '설계 이관', [{ id: PARK.id, name: PARK.name, role: 'editor' }]),
          project('PRJ-CLOSED', '남의 프로젝트', []),
        ], updatedAt: '2026-09-01T00:00:00.000Z' },
        ...(documents.length ? { 'company-documents': { data: documents, updatedAt: '2026-09-01T00:00:00.000Z' } } : {}),
      },
      [OTHER_TENANT]: {},
    },
    platform: {},
    accountApprovals: { [GUEST.id]: 'approved' },
    accountCredentials: { [GUEST.id]: { passwordHash: digestHex(GUEST.password, GUEST.id), mustChangePassword: false, temporaryPasswordExpiresAt: null } },
    invitedAccounts: [{ id: GUEST.id, email: GUEST.email, name: GUEST.name, tenantId: TENANT, tenantName: '햇살바다', team: '파트너상사', jobRole: '외부 게스트', requested: '게스트 초대', role: 'tenant-guest', guestGrantId: GRANT_ID }],
    passwordResetRequests: [],
    guestGrants: [{
      id: GRANT_ID, tenantId: TENANT, accountId: GUEST.id, email: GUEST.email, name: GUEST.name, orgName: '파트너상사', projectIds: ['PRJ-CONTRACT'],
      invitedById: ADMIN.id, invitedByName: '김서원', status: 'active', tokenHash: null, tokenIssuedAt: null, tokenExpiresAt: null,
      resendCount: 0, lastResentAt: null, accessExpiresAt: null, acceptedAt: '2026-09-01T00:00:00.000Z', revokedAt: null, revokedById: null, deactivatedAt: null,
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    }],
  }
}

/** 메모리 저장소. 업로드가 바이트를 실제로 남겼는지(또는 남기지 않았는지)를 직접 센다. */
function memoryStorage() {
  const files = new Map()
  return {
    files,
    backend: 'local',
    async put(key, body) { files.set(key, Buffer.from(body)); return { key, size: body.length } },
    async get(key) {
      const value = files.get(key)
      if (!value) { const error = new Error('없음'); error.code = 'STORAGE_NOT_FOUND'; throw error }
      return value
    },
    async delete(key) { return files.delete(key) },
    async getSignedUrl(_key, options = {}) { return options.fallbackUrl ?? null },
  }
}

const readJson = async (response) => { const text = await response.text(); try { return JSON.parse(text) } catch { return { raw: text } } }
const buildApp = (store, extra = {}) => createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {}, documentStorage: memoryStorage(), ...extra })

async function login(origin, email, password = 'demo1234') {
  const response = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: 'tenant', email, password }) })
  const body = await readJson(response)
  assert.equal(response.status, 200, JSON.stringify(body))
  const account = body.account
  return { account, headers: { 'content-type': 'application/json', cookie: response.headers.get('set-cookie') ?? '', 'x-workspace-identity': `${account.tenantId}:${account.id}` } }
}
const api = (origin, session) => async (method, route, body) => {
  const response = await fetch(`${origin}${route}`, { method, headers: session.headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return { status: response.status, body: await readJson(response) }
}
/**
 * 파일 한 건 업로드. 벌크는 분류·태그·권한을 보내지 않는다 — 서버가 매핑에서 정한다.
 * 지문 헤더도 보내지 않는다: 서버는 **매니페스트에 적힌 해시**와 본문을 대조하고 요청이 주장하는
 * 값은 읽지 않는다(시험 도우미가 그 헤더를 보내면 '검사하고 있다'는 인상만 남는다).
 */
const upload = (origin, session) => async (file, { importId, extra = '' } = {}) => {
  const query = new URLSearchParams({ name: file.path.split('/').at(-1), ...(importId ? { importId, sourcePath: file.path } : {}) })
  const response = await fetch(`${origin}/api/documents?${query}${extra}`, {
    method: 'POST',
    headers: {
      cookie: session.headers.cookie, 'x-workspace-identity': session.headers['x-workspace-identity'],
      'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.path.split('/').at(-1)),
      'x-file-type': 'application/pdf',
    },
    body: Buffer.from(file.body),
  })
  return { status: response.status, body: await readJson(response) }
}

/** 세션 하나를 uploading까지 끌고 간다. 대부분의 시험이 여기서 시작한다. */
async function startSession(call, { name = '2025 Flow 이관', mapping } = {}) {
  const created = await call('POST', '/api/bulk-imports', { name, mapping })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const id = created.body.session.id
  const manifest = await call('POST', `/api/bulk-imports/${id}/manifest`, { clientRequestId: 'page-1', pageIndex: 0, entries: FILES.map(manifestEntry) })
  assert.equal(manifest.status, 200, JSON.stringify(manifest.body))
  const started = await call('PATCH', `/api/bulk-imports/${id}`, { status: 'uploading' })
  assert.equal(started.status, 200, JSON.stringify(started.body))
  return { id, manifest }
}

const CONTRACT_MAPPING = [
  { folderPrefix: 'Flow/계약', projectId: 'PRJ-CONTRACT', tags: ['계약'], aiLevel: 'locked' },
  { folderPrefix: 'Flow/설계', projectId: 'PRJ-DESIGN', tags: [], aiLevel: 'locked' },
  { folderPrefix: '', projectId: null, tags: [], aiLevel: 'locked' },
]

test('1. 전 흐름: 세션 → 매니페스트 → 업로드 → 진행 보고 → 마감', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const call = api(origin, admin)
    const send = upload(origin, admin)
    const { id, manifest } = await startSession(call, { mapping: CONTRACT_MAPPING })
    assert.deepEqual(manifest.body.verdicts.map((entry) => entry.status), Array(7).fill('pending'))
    assert.deepEqual(manifest.body.totals, { files: 7, bytes: 0, uploaded: 0, skippedDuplicate: 0, failed: 0 })

    const results = []
    for (const file of FILES) {
      const uploaded = await send(file, { importId: id })
      assert.equal(uploaded.status, 201, `${file.path}: ${JSON.stringify(uploaded.body)}`)
      results.push({ path: file.path, status: 'uploaded', documentId: uploaded.body.document.id })
    }
    const progress = await call('POST', `/api/bulk-imports/${id}/progress`, { results })
    assert.equal(progress.status, 200, JSON.stringify(progress.body))

    const finished = await call('POST', `/api/bulk-imports/${id}/finish`)
    assert.equal(finished.status, 200, JSON.stringify(finished.body))
    assert.equal(finished.body.session.status, 'done')
    assert.ok(finished.body.session.finishedAt)
    assert.deepEqual(finished.body.session.totals, {
      files: 7, uploaded: 7, skippedDuplicate: 0, failed: 0,
      bytes: FILES.reduce((sum, file) => sum + Buffer.byteLength(file.body), 0),
    })
    assert.equal(finished.body.report.pending, 0)
    assert.deepEqual(finished.body.report.failures, [])
    // 폴더별 표는 매핑 접두로 묶인다 — 완료 화면이 폴더 단위 승격 버튼을 그릴 근거다.
    assert.deepEqual(finished.body.report.folders.map((row) => [row.folderPrefix, row.files]), [['', 1], ['Flow/계약', 3], ['Flow/설계', 3]])

    // 종료 상태에서 나가는 전이는 없다.
    const reopen = await call('PATCH', `/api/bulk-imports/${id}`, { status: 'uploading' })
    assert.equal(reopen.status, 409)
    assert.equal(reopen.body.error.code, 'BULK_IMPORT_STATUS_INVALID')
  })
})

test('2. 220개 매니페스트: 200/20으로 나뉘고, 같은 clientRequestId 재전송은 아무것도 늘리지 않는다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const call = api(origin, await login(origin, ADMIN.email))
    const created = await call('POST', '/api/bulk-imports', { name: '대량 이관', mapping: [{ folderPrefix: '', projectId: null, tags: [], aiLevel: 'locked' }] })
    const id = created.body.session.id

    const synthetic = Array.from({ length: 220 }, (_, index) => ({
      path: `Flow/계약/2025/${String(index).padStart(3, '0')}.pdf`,
      name: `${String(index).padStart(3, '0')}.pdf`,
      size: 1_024 + index,
      sha256: sha(`f${index}`),
    }))
    const first = { clientRequestId: 'bulk-page-1', pageIndex: 0, entries: synthetic.slice(0, MAX_MANIFEST_PAGE) }
    // 4mb 본문 한계 회귀: 200건짜리 페이지는 200KB를 넘지 않는다.
    assert.ok(Buffer.byteLength(JSON.stringify(first)) < 200 * 1024, `${Buffer.byteLength(JSON.stringify(first))} bytes`)

    const page1 = await call('POST', `/api/bulk-imports/${id}/manifest`, first)
    assert.equal(page1.status, 200, JSON.stringify(page1.body))
    assert.equal(page1.body.totals.files, 200)
    const page2 = await call('POST', `/api/bulk-imports/${id}/manifest`, { clientRequestId: 'bulk-page-2', pageIndex: 1, entries: synthetic.slice(MAX_MANIFEST_PAGE) })
    assert.equal(page2.status, 200, JSON.stringify(page2.body))
    assert.equal(page2.body.totals.files, 220)

    // 재전송은 totals 불변·엔트리 중복 0. 네트워크가 흔들려도 220건이 440건이 되지 않는다.
    const replay = await call('POST', `/api/bulk-imports/${id}/manifest`, first)
    assert.equal(replay.status, 200)
    assert.equal(replay.body.replayed, true)
    assert.deepEqual(replay.body.totals.files, 220)

    // 엔트리는 한 페이지 100개씩 내려온다. 경계에서 중복도 누락도 없다.
    const seen = []
    let cursor = 0
    for (let guard = 0; guard < 6; guard += 1) {
      const page = await call('GET', `/api/bulk-imports/${id}?chunk=0&cursor=${cursor}`)
      assert.equal(page.status, 200, JSON.stringify(page.body))
      seen.push(...page.body.chunk.entries.map((entry) => entry.path))
      if (page.body.nextCursor === null) break
      cursor = page.body.nextCursor
    }
    assert.equal(seen.length, 220)
    assert.equal(new Set(seen).size, 220)
    const overview = await call('GET', `/api/bulk-imports/${id}`)
    assert.equal(overview.body.session.entriesCount, 220)
    assert.equal(overview.body.report.files, 220)
    assert.equal(overview.body.report.pending, 220)
    // 폴더 3단계가 원본 그대로 매니페스트에 남아 있다.
    assert.equal(seen[0], 'Flow/계약/2025/000.pdf')
  })
})

test('3. 경로 위반 다섯 갈래는 몇 번째 항목인지 알려 주고 페이지 전체를 거절한다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const call = api(origin, await login(origin, ADMIN.email))
    const created = await call('POST', '/api/bulk-imports', { name: '경로 시험', mapping: [] })
    const id = created.body.session.id
    const bad = [
      { path: 'Flow/../x.pdf' },
      { path: '' },
      { path: `${'a'.repeat(400)}/x.pdf` },
      { path: 'Flow/\u0000x.pdf' },
      { path: '   ' },
    ]
    for (const [index, entry] of bad.entries()) {
      const result = await call('POST', `/api/bulk-imports/${id}/manifest`, {
        clientRequestId: `bad-${index}`, pageIndex: 0,
        entries: [{ path: 'Flow/ok.pdf', name: 'ok.pdf', size: 1, sha256: sha('ok') }, { ...entry, name: 'x.pdf', size: 1, sha256: sha('x') }],
      })
      assert.equal(result.status, 400, JSON.stringify(result.body))
      assert.equal(result.body.error.code, 'BULK_IMPORT_PATH_INVALID')
      assert.equal(result.body.error.index, 1)
    }
    // 거절된 페이지는 아무것도 남기지 않는다 — 앞선 정상 항목도 저장되지 않는다.
    const after = await call('GET', `/api/bulk-imports/${id}`)
    assert.equal(after.body.session.entriesCount, 0)
  })
})

test('4·5. 매핑이 문서에 실리고 원본 경로가 목록에서도 보인다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const call = api(origin, admin)
    const send = upload(origin, admin)
    const { id } = await startSession(call, { mapping: CONTRACT_MAPPING })

    const contract = await send(FILES[0], { importId: id })
    assert.equal(contract.status, 201, JSON.stringify(contract.body))
    const contractDocument = contract.body.document
    assert.equal(contractDocument.category, '프로젝트')
    assert.equal(contractDocument.visibility, 'restricted')
    // 프로젝트 멤버 전원(게스트 포함)이 열람자다 — 손으로 게시글에 첨부했을 때와 같은 범위다.
    assert.deepEqual(contractDocument.allowedUserIds, [ADMIN.id, PARK.id, OH.id, GUEST.id])
    assert.equal(contractDocument.projectId, 'PRJ-CONTRACT')
    assert.deepEqual(contractDocument.tags, ['bulk-import', `import:${id}`, '계약'])
    assert.equal(contractDocument.aiPolicy, 'locked')
    assert.equal(contractDocument.sourcePath, 'Flow/계약/2025/삼성전자_계약서.pdf')
    assert.equal(contractDocument.importId, id)

    const loose = await send(FILES[6], { importId: id })
    assert.equal(loose.status, 201, JSON.stringify(loose.body))
    assert.equal(loose.body.document.category, '공통자료')
    assert.equal(loose.body.document.visibility, 'all')
    assert.deepEqual(loose.body.document.allowedUserIds, [])
    assert.equal(loose.body.document.projectId, undefined)

    // 원본 경로 보존은 목록에서도 보여야 보존한 값이다.
    const listed = await call('GET', '/api/documents')
    const found = listed.body.documents.find((document) => document.id === contractDocument.id)
    assert.equal(found.sourcePath, 'Flow/계약/2025/삼성전자_계약서.pdf')
    assert.equal(found.importId, id)
  })
})

test('6. 해시 불일치는 400이고 문서도 파일도 남지 않는다', async () => {
  const store = freshStore()
  const storage = memoryStorage()
  await withServer(buildApp(store, { documentStorage: storage }), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const call = api(origin, admin)
    const { id } = await startSession(call, { mapping: CONTRACT_MAPPING })
    const before = storage.files.size

    const tampered = await fetch(`${origin}/api/documents?importId=${id}&sourcePath=${encodeURIComponent(FILES[0].path)}`, {
      method: 'POST',
      headers: {
        cookie: admin.headers.cookie, 'x-workspace-identity': admin.headers['x-workspace-identity'],
        'content-type': 'application/octet-stream', 'x-file-name': 'x.pdf', 'x-file-type': 'application/pdf',
      },
      // 매니페스트에는 FILES[0]의 해시가 적혀 있는데 본문은 다른 파일이다.
      body: Buffer.from('바꿔치기한 본문'),
    })
    const body = await readJson(tampered)
    assert.equal(tampered.status, 400, JSON.stringify(body))
    assert.equal(body.error.code, 'BULK_IMPORT_HASH_MISMATCH')
    assert.equal(storage.files.size, before, '스토리지에 바이트가 남지 않았다')
    const listed = await call('GET', '/api/documents')
    assert.equal(listed.body.documents.length, 0, '문서 배열에도 아무것도 남지 않았다')
    const session = await call('GET', `/api/bulk-imports/${id}`)
    assert.equal(session.body.report.uploaded, 0)
  })
})

test('7. 크래시 복구: 문서는 있는데 엔트리가 pending이면 재개가 그 문서를 알려 준다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const call = api(origin, admin)
    const send = upload(origin, admin)
    const { id } = await startSession(call, { mapping: CONTRACT_MAPPING })
    const uploaded = await send(FILES[0], { importId: id })
    assert.equal(uploaded.status, 201)

    // 상태 기록 전에 브라우저가 죽은 상황을 만든다 — 엔트리만 pending으로 되돌린다.
    const rows = store.tenants[TENANT]['bulk-imports'].data
    for (const row of rows) {
      if (row.kind !== 'chunk') continue
      row.entries = row.entries.map((entry) => (entry.path === FILES[0].path ? { ...entry, status: 'pending', documentId: '' } : entry))
    }

    const resumed = await call('GET', `/api/bulk-imports/${id}`)
    const entry = resumed.body.chunk.entries.find((row) => row.path === FILES[0].path)
    assert.equal(entry.status, 'pending')
    assert.equal(entry.resumeDocumentId, uploaded.body.document.id, '업로드 없이 건너뛸 수 있어야 한다')
    // 아직 올리지 않은 파일에는 되찾을 문서가 없다.
    assert.equal(resumed.body.chunk.entries.find((row) => row.path === FILES[1].path).resumeDocumentId, null)

    // 클라이언트는 업로드를 건너뛰고 진행 보고만 보낸다.
    const progress = await call('POST', `/api/bulk-imports/${id}/progress`, { results: [{ path: FILES[0].path, status: 'uploaded', documentId: uploaded.body.document.id }] })
    assert.equal(progress.status, 200)
    assert.equal(progress.body.totals.uploaded, 1)
  })
})

test('8. 커밋 실패는 문서와 엔트리를 함께 되돌린다 — pending으로 남아 다시 시도된다', async () => {
  const store = freshStore()
  let failNext = false
  const app = buildApp(store, { onWorkspaceStoreChange: () => { if (failNext) { failNext = false; throw new Error('디스크 실패') } } })
  await withServer(app, async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const call = api(origin, admin)
    const send = upload(origin, admin)
    const { id } = await startSession(call, { mapping: CONTRACT_MAPPING })

    failNext = true
    const failed = await send(FILES[0], { importId: id })
    assert.equal(failed.status, 500, JSON.stringify(failed.body))
    assert.equal(failed.body.error.code, 'DOCUMENT_UPLOAD_FAILED')

    const after = await call('GET', `/api/bulk-imports/${id}`)
    const entry = after.body.chunk.entries.find((row) => row.path === FILES[0].path)
    // 문서가 없는데 uploaded로 남으면 재개가 그 파일을 영원히 건너뛴다.
    assert.equal(entry.status, 'pending')
    assert.equal(entry.documentId, '')
    assert.equal(after.body.report.uploaded, 0)
    const listed = await call('GET', '/api/documents')
    assert.equal(listed.body.documents.length, 0)

    // 다시 시도하면 정상으로 올라간다.
    const retried = await send(FILES[0], { importId: id })
    assert.equal(retried.status, 201, JSON.stringify(retried.body))
  })
})

test('9. 중복 + 프로젝트 매핑이면 기존 문서의 열람 범위를 넓히고 그 요청 안에서 커밋한다', async () => {
  const existing = {
    id: 'DOC-OLD', tenantId: TENANT, name: '삼성전자_계약서.pdf', originalName: '삼성전자_계약서.pdf', mime: 'application/pdf',
    size: Buffer.byteLength(FILES[0].body), checksum: sha(FILES[0].body), category: '공통자료', visibility: 'restricted',
    departments: [], allowedUserIds: [ADMIN.id], tags: [], summary: '', uploadedAt: '2026-09-01T00:00:00.000Z',
    uploadedById: ADMIN.id, uploadedByName: '김서원', storage: 'local',
  }
  const store = freshStore({ documents: [existing] })
  await withServer(buildApp(store), async (origin) => {
    const call = api(origin, await login(origin, ADMIN.email))
    const created = await call('POST', '/api/bulk-imports', { name: '중복 시험', mapping: CONTRACT_MAPPING })
    const id = created.body.session.id
    const manifest = await call('POST', `/api/bulk-imports/${id}/manifest`, { clientRequestId: 'dup-1', pageIndex: 0, entries: [manifestEntry(FILES[0]), manifestEntry(FILES[1])] })
    assert.equal(manifest.status, 200, JSON.stringify(manifest.body))
    assert.deepEqual(manifest.body.verdicts.map((entry) => entry.status), ['duplicate', 'pending'])
    assert.equal(manifest.body.verdicts[0].duplicateOf, 'DOC-OLD')
    assert.equal(manifest.body.totals.skippedDuplicate, 1)

    // grantDocumentAccess는 스스로 커밋하지 않는다 — 요청이 끝난 뒤 store를 다시 읽어 반영을 확인한다.
    const stored = store.tenants[TENANT]['company-documents'].data.find((document) => document.id === 'DOC-OLD')
    // 프로젝트 멤버에는 **초대된 외부 게스트가 들어 있다**. 화면의 문장이 그 사실을 말해야 한다.
    assert.deepEqual([...stored.allowedUserIds].sort(), [ADMIN.id, GUEST.id, OH.id, PARK.id].sort())
    /**
     * 귀속 도장은 찍지 않는다. 이 문서는 이미 있던 자료이고, projectId는 '이 파일이 어느 프로젝트의
     * 것인가'라는 사실이다 — 사본을 가진 사람의 폴더 이름이 그 사실을 바꿀 수는 없다.
     */
    assert.equal(stored.projectId, undefined, '있던 자료의 프로젝트 귀속을 이관이 다시 쓰지 않는다')
    // 숫자로 답한다 — 화면이 '기존 자료 N건의 범위를 넓혔습니다'라고 적을 근거이고,
    // '조용히 바꿨다'가 되지 않게 하는 유일한 값이다.
    assert.equal(manifest.body.accessWidened, 1)

    /**
     * 볼 수 없는 문서와 같은 해시라는 사실을 알려 주면 그 문서의 존재가 새어 나간다.
     * 그래서 중복 색인에는 canReadDocument를 통과한 문서만 들어간다 — 못 보는 파일은
     * 중복이 아니라 새 업로드로 처리된다(사본 하나가 늘 뿐, 정보는 새지 않는다).
     */
    const hidden = {
      ...existing, id: 'DOC-HIDDEN', name: '오태식만 보는 파일.pdf', checksum: sha(FILES[3].body),
      visibility: 'restricted', allowedUserIds: [OH.id], uploadedById: OH.id, uploadedByName: OH.name, projectId: undefined,
    }
    store.tenants[TENANT]['company-documents'].data.push(hidden)
    const park = api(origin, await login(origin, PARK.email))
    const mine = await park('POST', '/api/bulk-imports', { name: '직원 이관', mapping: [{ folderPrefix: 'Flow/설계', projectId: 'PRJ-DESIGN', tags: [], aiLevel: 'locked' }] })
    assert.equal(mine.status, 201, JSON.stringify(mine.body))
    const blind = await park('POST', `/api/bulk-imports/${mine.body.session.id}/manifest`, { clientRequestId: 'hidden-1', pageIndex: 0, entries: [manifestEntry(FILES[3])] })
    assert.equal(blind.status, 200, JSON.stringify(blind.body))
    assert.equal(blind.body.verdicts[0].status, 'pending', '볼 수 없는 문서와 같은 해시는 중복이 아니다')
    assert.equal(blind.body.verdicts[0].duplicateOf, undefined)
    // 관리자에게는 같은 파일이 중복으로 보인다 — 판정이 '누가 보느냐'에 달려 있다는 증거다.
    const asAdmin = await call('POST', `/api/bulk-imports/${id}/manifest`, { clientRequestId: 'hidden-2', pageIndex: 1, entries: [manifestEntry(FILES[3])] })
    assert.equal(asAdmin.body.verdicts[0].status, 'duplicate')
    assert.equal(asAdmin.body.verdicts[0].duplicateOf, 'DOC-HIDDEN')
  })
})

test('9-1. 넓힐 수 없는 중복은 닫지 않는다 — 부서 자료는 그대로 두고 사본이 프로젝트로 간다', async () => {
  /**
   * 이 갈래는 '확인' 단계에서, 즉 한 바이트도 올리기 전에 일어난다. grantDocumentAccess는
   * visibility 'all'만 비켜 가고 'department'는 restricted로 바꿔 버리는데, 그러면 품질관리 부서 전원이
   * 보던 지침서가 PRJ-CONTRACT 멤버 세 명만 보는 자료가 된다 — 이관이 있던 자료를 좁힌 것이다.
   *
   * 그렇다고 '중복'으로 닫아 버리면 그 파일은 영영 올라가지 않는데, 대상 프로젝트에는 그 자료가 없다.
   * 사람이 읽는 '이미 있으니 안 올렸다'와 실제 '그 프로젝트에는 없다'가 갈리는 자리다 —
   * 그래서 닫지 않고 pending으로 두어 **사본이 프로젝트로 올라간다**(손으로 올렸을 때와 같다).
   */
  const departmentDocument = {
    id: 'DOC-DEPT', tenantId: TENANT, name: '품질지침.pdf', originalName: '품질지침.pdf', mime: 'application/pdf',
    size: Buffer.byteLength(FILES[0].body), checksum: sha(FILES[0].body), category: '공통자료',
    visibility: 'department', departments: ['품질관리'], allowedUserIds: [], tags: [], summary: '',
    uploadedAt: '2026-09-01T00:00:00.000Z', uploadedById: ADMIN.id, uploadedByName: '김서원', storage: 'local',
  }
  const store = freshStore({ documents: [departmentDocument] })
  await withServer(buildApp(store), async (origin) => {
    const session = await login(origin, ADMIN.email)
    const call = api(origin, session)
    const send = upload(origin, session)
    const created = await call('POST', '/api/bulk-imports', { name: '부서 자료 시험', mapping: CONTRACT_MAPPING })
    const id = created.body.session.id
    const manifest = await call('POST', `/api/bulk-imports/${id}/manifest`, { clientRequestId: 'dept-1', pageIndex: 0, entries: [manifestEntry(FILES[0])] })
    assert.equal(manifest.status, 200, JSON.stringify(manifest.body))
    assert.equal(manifest.body.verdicts[0].status, 'pending', '그 프로젝트에서 열리지 않는 자료는 중복으로 닫지 않는다')
    assert.equal(manifest.body.verdicts[0].duplicateOf, undefined)
    assert.equal(manifest.body.accessWidened, undefined, '넓힌 것이 없으면 그 사실도 말하지 않는다')

    const stored = store.tenants[TENANT]['company-documents'].data.find((document) => document.id === 'DOC-DEPT')
    assert.equal(stored.visibility, 'department', '부서 공개는 그대로다')
    assert.deepEqual(stored.departments, ['품질관리'])
    assert.deepEqual(stored.allowedUserIds, [])
    assert.equal(stored.projectId, undefined, '프로젝트 귀속 도장도 찍지 않는다')

    // 그리고 사본은 실제로 프로젝트에 도착한다 — 지침서는 부서 것으로 남고, 계약 프로젝트는 제 자료를 갖는다.
    await call('PATCH', `/api/bulk-imports/${id}`, { status: 'uploading' })
    const uploaded = await send(FILES[0], { importId: id })
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body))
    const copies = store.tenants[TENANT]['company-documents'].data.filter((document) => document.checksum === sha(FILES[0].body))
    assert.equal(copies.length, 2, '부서 자료 한 벌 + 프로젝트 사본 한 벌')
    const copy = copies.find((document) => document.id !== 'DOC-DEPT')
    assert.equal(copy.projectId, 'PRJ-CONTRACT')
    assert.equal(copy.visibility, 'restricted')
    assert.equal(copy.allowedUserIds.includes(GUEST.id), true, '프로젝트 구성원 전원이 그 사본을 연다')
  })
})

test('9-3. 남의 자료는 넓히지 않는다 — 직원의 확인 단계가 동료의 문서를 프로젝트에 열지 않는다', async () => {
  /**
   * 이 갈래는 '확인' 단계에서 일어난다: 한 바이트도 올리기 전, 되돌릴 라우트도 없이.
   * 같은 해시의 사본을 자기 폴더에 갖고 있다는 이유로 동료의 문서가 프로젝트 멤버 전원에게
   * (그 프로젝트에 초대된 **외부 게스트를 포함해**) 열려서는 안 된다.
   */
  const shared = {
    id: 'DOC-SHARED', tenantId: TENANT, name: '오태식 계약 사본.pdf', originalName: '오태식 계약 사본.pdf', mime: 'application/pdf',
    size: Buffer.byteLength(FILES[0].body), checksum: sha(FILES[0].body), category: '공통자료', visibility: 'restricted',
    departments: [], allowedUserIds: [OH.id, PARK.id], tags: [], summary: '', uploadedAt: '2026-09-01T00:00:00.000Z',
    uploadedById: OH.id, uploadedByName: OH.name, storage: 'local',
  }
  const store = freshStore({ documents: [shared] })
  await withServer(buildApp(store), async (origin) => {
    const parkSession = await login(origin, PARK.email)
    const park = api(origin, parkSession)
    const mine = await park('POST', '/api/bulk-imports', { name: '남의 자료 시험', mapping: [{ folderPrefix: 'Flow/계약', projectId: 'PRJ-CONTRACT', tags: [], aiLevel: 'locked' }] })
    assert.equal(mine.status, 201, JSON.stringify(mine.body))
    const manifest = await park('POST', `/api/bulk-imports/${mine.body.session.id}/manifest`, { clientRequestId: 'other-1', pageIndex: 0, entries: [manifestEntry(FILES[0])] })
    assert.equal(manifest.status, 200, JSON.stringify(manifest.body))
    /**
     * 넓히지 못하는 중복은 **닫지도 않는다**. 닫아 버리면 박지현이 읽을 수 있다는 이유로 그 파일이
     * '이미 있다'가 되는데, 프로젝트의 외부 게스트에게는 그 자료가 아예 없다 — 화면은 '건너뜀 1'이라
     * 적고 폴더는 멤버에게 구멍 난 채로 남는다. pending으로 두면 사본이 프로젝트로 올라간다.
     */
    assert.equal(manifest.body.verdicts[0].status, 'pending', '남의 자료는 넓히지도, 대신 닫지도 않는다')
    assert.equal(manifest.body.verdicts[0].duplicateOf, undefined)
    assert.equal(manifest.body.accessWidened, undefined, '넓힌 것이 없으면 그 사실도 말하지 않는다')

    const untouched = store.tenants[TENANT]['company-documents'].data.find((document) => document.id === 'DOC-SHARED')
    assert.deepEqual([...untouched.allowedUserIds].sort(), [OH.id, PARK.id].sort(), '외부 게스트가 동료의 자료를 얻지 않는다')
    assert.equal(untouched.projectId, undefined)

    // 관리자는 원래 전 자료의 열람 범위를 정하는 사람이다 — 그때만 넓어지고, 그래도 귀속은 그대로다.
    const admin = api(origin, await login(origin, ADMIN.email))
    const theirs = await admin('POST', '/api/bulk-imports', { name: '관리자 확인', mapping: [{ folderPrefix: 'Flow/계약', projectId: 'PRJ-CONTRACT', tags: [], aiLevel: 'locked' }] })
    const asAdmin = await admin('POST', `/api/bulk-imports/${theirs.body.session.id}/manifest`, { clientRequestId: 'other-2', pageIndex: 0, entries: [manifestEntry(FILES[0])] })
    assert.equal(asAdmin.body.accessWidened, 1)
    const widened = store.tenants[TENANT]['company-documents'].data.find((document) => document.id === 'DOC-SHARED')
    assert.equal(widened.allowedUserIds.includes(GUEST.id), true, '프로젝트 구성원에는 초대된 외부 게스트가 들어 있다')
    assert.equal(widened.projectId, undefined)
  })
})

test('9-4. 닫지 않은 중복은 사본이 되어 프로젝트에 도착한다 — 폴더가 멤버에게 구멍 나지 않는다', async () => {
  /**
   * '건너뜀 1'이라고 적힌 파일이 대상 프로젝트에는 아예 없다면, 화면이 말한 것과 일어난 일이 다르다.
   * 여기서는 그 사실을 **프로젝트에 초대된 외부 게스트의 눈으로** 잰다: 이관 전에는 그 파일이 보이지
   * 않고, 이관 뒤에는 (동료의 자료가 열린 것이 아니라) 새 사본이 프로젝트 자료로 보인다.
   */
  const shared = {
    id: 'DOC-SHARED', tenantId: TENANT, name: '오태식 계약 사본.pdf', originalName: '오태식 계약 사본.pdf', mime: 'application/pdf',
    size: Buffer.byteLength(FILES[0].body), checksum: sha(FILES[0].body), category: '공통자료', visibility: 'restricted',
    departments: [], allowedUserIds: [OH.id, PARK.id], tags: [], summary: '', uploadedAt: '2026-09-01T00:00:00.000Z',
    uploadedById: OH.id, uploadedByName: OH.name, storage: 'local',
  }
  const store = freshStore({ documents: [shared] })
  await withServer(buildApp(store), async (origin) => {
    const parkSession = await login(origin, PARK.email)
    const park = api(origin, parkSession)
    const guest = api(origin, await login(origin, GUEST.email, GUEST.password))
    const before = await guest('GET', '/api/documents')
    assert.equal(before.body.documents.some((document) => document.checksum === sha(FILES[0].body)), false, '이관 전에는 그 파일이 프로젝트에 없다')

    const mine = await park('POST', '/api/bulk-imports', { name: '구멍 시험', mapping: [{ folderPrefix: 'Flow/계약', projectId: 'PRJ-CONTRACT', tags: [], aiLevel: 'locked' }] })
    const id = mine.body.session.id
    const manifest = await park('POST', `/api/bulk-imports/${id}/manifest`, { clientRequestId: 'gap-1', pageIndex: 0, entries: [manifestEntry(FILES[0])] })
    assert.equal(manifest.body.verdicts[0].status, 'pending')
    await park('PATCH', `/api/bulk-imports/${id}`, { status: 'uploading' })
    const copied = await upload(origin, parkSession)(FILES[0], { importId: id })
    assert.equal(copied.status, 201, JSON.stringify(copied.body))

    const after = await guest('GET', '/api/documents')
    const seen = after.body.documents.filter((document) => document.checksum === sha(FILES[0].body))
    assert.equal(seen.length, 1, '게스트가 보는 것은 새 사본 하나뿐이다')
    assert.equal(seen[0].id, copied.body.document.id)
    assert.equal(store.tenants[TENANT]['company-documents'].data.find((document) => document.id === 'DOC-SHARED').allowedUserIds.includes(GUEST.id), false, '동료의 자료는 그대로다')

    /**
     * 지문 없는 브라우저(dedupe=1)도 같은 판정을 지난다 — 그쪽만 '이미 있다'로 닫으면 같은 구멍이 남는다.
     * 대상은 오태식의 또 다른 restricted 자료다(박지현은 읽을 수 있고, 프로젝트 게스트는 볼 수 없다).
     */
    store.tenants[TENANT]['company-documents'].data.push({
      ...shared, id: 'DOC-SHARED-2', name: '구계약 사본.pdf', checksum: sha(FILES[2].body), size: Buffer.byteLength(FILES[2].body),
    })
    const noHash = await park('POST', `/api/bulk-imports/${id}/manifest`, { clientRequestId: 'gap-2', pageIndex: 1, entries: [{ path: FILES[2].path, name: '구계약.pdf', size: Buffer.byteLength(FILES[2].body), sha256: '' }] })
    assert.equal(noHash.body.verdicts[0].status, 'pending')
    const backstop = await upload(origin, parkSession)(FILES[2], { importId: id, extra: '&dedupe=1' })
    assert.equal(backstop.status, 201, JSON.stringify(backstop.body))
    assert.equal(backstop.body.duplicateOf, undefined, '그 프로젝트에서 열리지 않는 자료를 백스톱이 대신 닫지 않는다')
    assert.equal(backstop.body.document.projectId, 'PRJ-CONTRACT')
  })
})

test('9-2. 매핑에 없는 폴더: 직원은 전사 공개를 만들 수 없고, 관리자만 자료실로 올린다', async () => {
  /**
   * canBulkImport는 **선언된 행**만 본다. 매핑 어디에도 걸리지 않는 경로는 기본 행(projectId: null)으로
   * 떨어져 '전 직원 공개'가 되므로, 자기 프로젝트 행만 선언한 직원이 그 밖의 파일을 전사에 공개할 수 있다.
   * 그래서 업로드는 **실제로 적용되는 행**을 같은 함수로 다시 본다.
   */
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const parkSession = await login(origin, PARK.email)
    const park = api(origin, parkSession)
    const mine = await park('POST', '/api/bulk-imports', { name: '계약 이관', mapping: [{ folderPrefix: 'Flow/계약', projectId: 'PRJ-CONTRACT', tags: [], aiLevel: 'locked' }] })
    assert.equal(mine.status, 201, JSON.stringify(mine.body))
    const id = mine.body.session.id
    await park('POST', `/api/bulk-imports/${id}/manifest`, { clientRequestId: 'm-1', pageIndex: 0, entries: [manifestEntry(FILES[0]), manifestEntry(FILES[6])] })
    await park('PATCH', `/api/bulk-imports/${id}`, { status: 'uploading' })

    const mapped = await upload(origin, parkSession)(FILES[0], { importId: id })
    assert.equal(mapped.status, 201, JSON.stringify(mapped.body))
    assert.equal(mapped.body.document.visibility, 'restricted')
    assert.equal(mapped.body.document.projectId, 'PRJ-CONTRACT')

    const unmapped = await upload(origin, parkSession)(FILES[6], { importId: id })
    assert.equal(unmapped.status, 403, JSON.stringify(unmapped.body))
    assert.equal(unmapped.body.error.code, 'BULK_IMPORT_UNMAPPED')
    // 화면이 미리 보여 주는 문장과 **글자까지 같은 문장**이어야 한다.
    assert.equal(unmapped.body.error.message, UNMAPPED_MESSAGE)
    assert.doesNotMatch(JSON.stringify(unmapped.body), /PRJ-|남의 프로젝트/)
    assert.equal(store.tenants[TENANT]['company-documents'].data.filter((document) => document.sourcePath === FILES[6].path).length, 0, '거절된 파일은 저장되지 않는다')

    // 관리자에게는 같은 경로가 정상이다 — 전사 공개는 관리자의 권한이라는 것이 이 판정의 전부다.
    const adminSession = await login(origin, ADMIN.email)
    const admin = api(origin, adminSession)
    const theirs = await startSession(admin, { mapping: [{ folderPrefix: 'Flow/계약', projectId: 'PRJ-CONTRACT', tags: [], aiLevel: 'locked' }] })
    const wide = await upload(origin, adminSession)(FILES[6], { importId: theirs.id })
    assert.equal(wide.status, 201, JSON.stringify(wide.body))
    assert.equal(wide.body.document.visibility, 'all')
    assert.equal(wide.body.document.category, '공통자료')
  })
})

test('10. dedupe=1 백스톱은 바이트를 저장하지 않고, 볼 수 없는 문서는 중복으로 세지 않는다', async () => {
  const mine = {
    id: 'DOC-MINE', tenantId: TENANT, name: '내 파일.pdf', originalName: '내 파일.pdf', mime: 'application/pdf',
    size: Buffer.byteLength(FILES[0].body), checksum: sha(FILES[0].body), category: '공통자료', visibility: 'all',
    departments: [], allowedUserIds: [], tags: [], summary: '', uploadedAt: '2026-09-01T00:00:00.000Z',
    uploadedById: ADMIN.id, uploadedByName: '김서원', storage: 'local',
  }
  const hidden = {
    ...mine, id: 'DOC-HIDDEN', name: '비밀 파일.pdf', checksum: sha(FILES[1].body),
    visibility: 'restricted', allowedUserIds: [OH.id], uploadedById: OH.id, uploadedByName: OH.name,
  }
  const store = freshStore({ documents: [mine, hidden] })
  const storage = memoryStorage()
  await withServer(buildApp(store, { documentStorage: storage }), async (origin) => {
    const park = await login(origin, PARK.email)
    const send = upload(origin, park)
    const before = storage.files.size

    const duplicate = await send(FILES[0], { extra: '&dedupe=1' })
    assert.equal(duplicate.status, 200, JSON.stringify(duplicate.body))
    assert.equal(duplicate.body.duplicateOf, 'DOC-MINE')
    assert.equal(duplicate.body.document, undefined, '문서 객체를 실으면 메타데이터 오라클이 된다')
    assert.equal(storage.files.size, before, '중복은 바이트를 저장하지 않는다')

    // 볼 수 없는 문서와 같은 바이트는 중복이 아니다 — 사본 하나가 늘 뿐, 그 문서의 존재는 새지 않는다.
    const fresh = await send(FILES[1], { extra: '&dedupe=1' })
    assert.equal(fresh.status, 201, JSON.stringify(fresh.body))
    assert.equal(fresh.body.document.id.startsWith('DOC-'), true)
    assert.notEqual(fresh.body.document.id, 'DOC-HIDDEN')
    assert.equal(storage.files.size, before + 1)
  })
})

test("11. AI 처리 수준: 벌크는 '보관만'으로 잠기고, 폴더 단위로만 올라간다", async () => {
  const store = freshStore()
  // 모델에게 **실제로 보낸 것**을 본다 — 답을 보는 것으로는 '무엇이 나갔는가'를 알 수 없다.
  const sent = []
  const client = { messages: { countTokens: async () => ({ input_tokens: 1 }), create: async (params) => { sent.push(params); return { id: 'x', model: 'claude-test', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: '{"headline":"요약","bullets":["한 줄"],"decisions":[],"evidence":[{"quote":"근거","where":"1쪽"}],"insufficient":false}' }] } } } }
  const billingService = {
    reserveUsage: async (_actor, input) => ({ reservation: { ...input, status: 'pending' } }),
    recordUsageEvent: async (_actor, input) => ({ event: input }),
    recordReconciliationPending: async (_actor, input) => ({ reconciliation: input }),
    releaseUsageReservation: async () => {},
  }
  await withServer(buildApp(store, { apiKey: 'test-key', client, model: 'claude-test', billingService }), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const call = api(origin, admin)
    const send = upload(origin, admin)
    const park = api(origin, await login(origin, PARK.email))
    const { id } = await startSession(call, { mapping: CONTRACT_MAPPING })

    const before = await call('GET', '/api/proposals')
    const uploaded = []
    for (const file of FILES.slice(0, 3)) {
      const result = await send(file, { importId: id })
      assert.equal(result.status, 201, JSON.stringify(result.body))
      assert.equal(result.body.document.aiPolicy, 'locked')
      uploaded.push(result.body.document)
    }
    // 200건 벌크가 승인 큐에 200개 제안을 쏟지 않는다 — 분류 제안도 AI가 파일을 읽는 행위다.
    const after = await call('GET', '/api/proposals')
    assert.equal(after.body.pendingCount, before.body.pendingCount)

    const lens = await call('POST', `/api/documents/${uploaded[0].id}/lens`, { lensId: 'LENS-BUILTIN-CORE' })
    assert.equal(lens.status, 409, JSON.stringify(lens.body))
    assert.equal(lens.body.error.code, 'DOCUMENT_AI_LOCKED')
    assert.match(lens.body.error.message, /자료 정보에서 수준을 올린 뒤/)

    const extract = await call('POST', `/api/documents/${uploaded[0].id}/extract`, { target: 'ip-right' })
    assert.equal(extract.status, 409)
    assert.equal(extract.body.error.code, 'DOCUMENT_AI_LOCKED')

    const chat = await call('POST', '/api/chat', { feature: 'document-search', messages: [{ role: 'user', content: '이 계약서 요약해 줘' }], attachments: [{ documentId: uploaded[0].id }] })
    assert.equal(chat.status, 409, JSON.stringify(chat.body))
    assert.equal(chat.body.error.code, 'DOCUMENT_AI_LOCKED')
    assert.match(chat.body.error.message, /‘보관만’인 자료입니다/)

    /**
     * 채팅 첨부는 '활용'을 요구하므로 '정리' 자료도 막힌다 — 그때 문장이 '보관만'이라고 하면
     * 라우트가 스스로 거짓을 말한다. 그 자료의 수준은 '보관만'이 아니고, 화면 배지도 그렇게 적혀 있다.
     */
    const lifted = await call('PATCH', `/api/documents/${uploaded[1].id}`, { aiPolicy: 'indexed' })
    assert.equal(lifted.status, 200, JSON.stringify(lifted.body))
    const indexedChat = await call('POST', '/api/chat', { feature: 'document-search', messages: [{ role: 'user', content: '요약해 줘' }], attachments: [{ documentId: uploaded[1].id }] })
    assert.equal(indexedChat.status, 409, JSON.stringify(indexedChat.body))
    assert.match(indexedChat.body.error.message, /‘정리’인 자료입니다/)
    assert.doesNotMatch(indexedChat.body.error.message, /보관만/)
    // 같은 자료의 렌즈('정리'면 충분하다)는 그대로 열린다 — 게이트마다 요구 수준이 다르다는 사실 그대로다.
    const openLens = await call('POST', `/api/documents/${uploaded[1].id}/lens`, { lensId: 'LENS-BUILTIN-CORE' })
    assert.notEqual(openLens.status, 409, JSON.stringify(openLens.body))
    // 아래의 폴더 승격 숫자는 '계약 폴더 세 건'이라는 사실을 재므로, 빌려 쓴 문서를 제자리에 돌려 둔다.
    assert.equal((await call('PATCH', `/api/documents/${uploaded[1].id}`, { aiPolicy: 'locked' })).status, 200)

    /**
     * 다섯 번째 게이트: 첨부가 아니라 **자료 목록 자체**가 시스템 프롬프트에 실려 모델에 간다.
     * 첨부만 막으면 잠긴 계약서의 이름·분류·태그·요약이 매 대화마다 나가면서
     * 화면에는 '보관만: AI가 열지 않습니다'가 적혀 있게 된다.
     */
    const catalogue = await call('POST', '/api/chat', { feature: 'document-search', messages: [{ role: 'user', content: '삼성전자 계약서 찾아 줘' }] })
    assert.equal(catalogue.status, 200, JSON.stringify(catalogue.body))
    assert.doesNotMatch(JSON.stringify(sent.at(-1)?.system ?? ''), /삼성전자_계약서/, '잠긴 자료는 이름도 모델에 나가지 않는다')
    assert.match(JSON.stringify(sent.at(-1)?.system ?? ''), /accessibleDocuments/, '목록 자체는 실린다 — 위 단언이 빈 단언이 아니다')

    // 직원은 스스로 올릴 수 없다(PATCH가 requireTenantAdmin) — 그래서 다른 문장을 준다.
    const memberLens = await park('POST', `/api/documents/${uploaded[0].id}/lens`, { lensId: 'LENS-BUILTIN-CORE' })
    assert.equal(memberLens.status, 409)
    assert.match(memberLens.body.error.message, /회사 관리자에게 수준 상향을 요청/)

    const memberRaise = await park('POST', `/api/bulk-imports/${id}/ai-level`, { folderPrefix: 'Flow/계약', level: 'indexed' })
    assert.equal(memberRaise.status, 403)

    const raised = await call('POST', `/api/bulk-imports/${id}/ai-level`, { folderPrefix: 'Flow/계약', level: 'indexed' })
    assert.equal(raised.status, 200, JSON.stringify(raised.body))
    assert.equal(raised.body.updated, 3, '계약 폴더의 세 건만 올라간다')
    // 두 번째 호출은 올릴 것이 없다 — 올라가는 방향으로만 바꾸므로 멱등이다.
    const again = await call('POST', `/api/bulk-imports/${id}/ai-level`, { folderPrefix: 'Flow/계약', level: 'indexed' })
    assert.equal(again.body.updated, 0)
    const lowered = await call('POST', `/api/bulk-imports/${id}/ai-level`, { folderPrefix: 'Flow/계약', level: 'locked' })
    assert.equal(lowered.body.updated, 0, '폴더 단위로 내리지 않는다 — 사람이 올려 둔 문서까지 함께 잠긴다')

    const lensAfter = await call('POST', `/api/documents/${uploaded[0].id}/lens`, { lensId: 'LENS-BUILTIN-CORE' })
    assert.equal(lensAfter.status, 200, JSON.stringify(lensAfter.body))
    // 수준을 올리면 목록에도 다시 실린다 — 위의 doesNotMatch가 상황에 반응한다는 증거다.
    await call('POST', '/api/chat', { feature: 'document-search', messages: [{ role: 'user', content: '삼성전자 계약서 찾아 줘' }] })
    assert.match(JSON.stringify(sent.at(-1)?.system ?? ''), /삼성전자_계약서/)
  })
})

test("11-1. 폴더 승격은 보고서가 묶은 그 행만 올린다 — '(최상위)'가 세션 전체를 삼키지 않는다", async () => {
  /**
   * underPrefix(path, '')는 모든 경로에 참이다. 반면 보고서의 '' 묶음은 **다른 행에 걸리지 않은 파일**만
   * 담는다. 두 규칙이 다르면 행에는 1건이라고 적혀 있는데 버튼은 3건을 올린다 — 관리자가 일부러
   * '보관만'에 둔 계약서가 함께 열린다. 버튼의 효과와 그 옆 숫자는 같은 함수에서 나와야 한다.
   */
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const call = api(origin, admin)
    const send = upload(origin, admin)
    const { id } = await startSession(call, { mapping: CONTRACT_MAPPING })
    for (const file of [FILES[0], FILES[1], FILES[6]]) {
      assert.equal((await send(file, { importId: id })).status, 201)
    }
    const finished = await call('POST', `/api/bulk-imports/${id}/finish`)
    const root = finished.body.report.folders.find((folder) => folder.folderPrefix === '')
    assert.equal(root.uploaded, 1, '최상위 묶음에는 잡자료/메모.txt 하나만 있다')

    const raised = await call('POST', `/api/bulk-imports/${id}/ai-level`, { folderPrefix: '', level: 'indexed' })
    assert.equal(raised.status, 200, JSON.stringify(raised.body))
    assert.equal(raised.body.updated, 1, '그 행의 숫자와 같아야 한다')
    const documents = store.tenants[TENANT]['company-documents'].data
    assert.equal(documents.find((document) => document.sourcePath === FILES[6].path).aiPolicy, 'indexed')
    for (const file of [FILES[0], FILES[1]]) {
      assert.equal(documents.find((document) => document.sourcePath === file.path).aiPolicy, 'locked', '계약 폴더는 그대로 잠겨 있다')
    }
  })
})

test("12. 수준을 '보관만'으로 내리면 그 문서의 pending 분류 제안이 사라진다", async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const call = api(origin, admin)
    // 벌크가 아닌 보통 업로드 — 실효 수준이 '활용'이라 분류 제안이 생긴다.
    const plain = await upload(origin, admin)({ path: '견적서_2025.pdf', body: '견적 본문' })
    assert.equal(plain.status, 201, JSON.stringify(plain.body))
    const documentId = plain.body.document.id
    // 기존 호출부 회귀: importId 없이 올린 문서에는 세 키가 아예 없다.
    assert.equal('sourcePath' in plain.body.document, false)
    assert.equal('importId' in plain.body.document, false)
    assert.equal('aiPolicy' in plain.body.document, false)

    const proposals = await call('GET', '/api/proposals')
    const mine = proposals.body.proposals.filter((item) => item.sourceKey === `doc:${documentId}` && item.status === 'pending')

    const locked = await call('PATCH', `/api/documents/${documentId}`, { aiPolicy: 'locked' })
    assert.equal(locked.status, 200, JSON.stringify(locked.body))
    assert.equal(locked.body.document.aiPolicy, 'locked')

    const afterProposals = await call('GET', '/api/proposals')
    assert.equal(afterProposals.body.proposals.filter((item) => item.sourceKey === `doc:${documentId}` && item.status === 'pending').length, 0, `내리기 전 ${mine.length}건`)

    // 원본 경로도 자료 정보에서 고칠 수 있다. importId는 아니다 — 출처는 사실이지 설정이 아니다.
    const path = await call('PATCH', `/api/documents/${documentId}`, { sourcePath: '/보관/2025//견적.pdf' })
    assert.equal(path.body.document.sourcePath, '보관/2025/견적.pdf')
    const bad = await call('PATCH', `/api/documents/${documentId}`, { sourcePath: '../x' })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.error.code, 'BULK_IMPORT_PATH_INVALID')
    const wrongLevel = await call('PATCH', `/api/documents/${documentId}`, { aiPolicy: '보관만' })
    assert.equal(wrongLevel.status, 400)
    assert.equal(wrongLevel.body.error.code, 'BULK_IMPORT_AI_LEVEL_INVALID')
  })
})

/**
 * R16: 회의 녹음의 AI 처리 수준은 **서버가** 정한다.
 *
 * 회의 음성은 사람의 목소리가 든 개인정보다. 클라이언트가 `aiPolicy=locked`를 실어 보내는 설계면,
 * 그 한 줄을 잊은 화면 하나가 회사의 모든 회의 녹음을 렌즈·판독·채팅 첨부에 통째로 연다.
 * 그래서 분류('회의녹음')나 태그('meeting-recording') 하나만 보고 서버가 잠근다.
 *
 * 짝이 되는 사실도 함께 잠근다: 그 업로드는 **분류 제안을 만들지 않는다.** 회의 하나에
 * 분류 제안과 (M3의) 할 일 제안이 겹쳐 쌓이면 승인 큐가 시끄러워지고 사람은 무엇을 봐야 할지 모른다.
 */
test('12-2. 회의 녹음 업로드는 쿼리에 아무 말이 없어도 서버가 ‘보관만’으로 잠그고 분류 제안을 만들지 않는다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const call = api(origin, admin)

    const recording = await upload(origin, admin)({ path: '9월 주간회의.webm', body: '녹음 바이트' }, { extra: '&tags=meeting-recording' })
    assert.equal(recording.status, 201, JSON.stringify(recording.body))
    assert.equal(recording.body.document.aiPolicy, 'locked', '녹음이 잠기지 않으면 「보관만」이라는 약속이 거짓이 된다')
    const byCategory = await upload(origin, admin)({ path: '10월 정기회의.webm', body: '녹음 바이트2' }, { extra: `&category=${encodeURIComponent('회의녹음')}` })
    assert.equal(byCategory.body.document.aiPolicy, 'locked', '분류 하나로도 같은 결론이어야 한다')

    const proposals = await call('GET', '/api/proposals')
    for (const id of [recording.body.document.id, byCategory.body.document.id]) {
      assert.equal(proposals.body.proposals.filter((item) => item.sourceKey === `doc:${id}`).length, 0, `녹음 ${id} 에 분류 제안이 생겼다`)
    }

    // 대조군. 회의가 아닌 업로드는 오늘과 똑같다 — 칸이 생기지 않고 분류 제안은 그대로 쌓인다.
    const plain = await upload(origin, admin)({ path: '견적서_2026.pdf', body: '견적 본문' })
    assert.equal('aiPolicy' in plain.body.document, false)
    const after = await call('GET', '/api/proposals')
    assert.ok(after.body.proposals.some((item) => item.sourceKey === `doc:${plain.body.document.id}`), '보통 업로드의 분류 제안까지 함께 막혔다')
  })
})

test('13. 권한: editor는 자기 프로젝트만, viewer·프로젝트 없음은 403, 이관 중 멤버 제외도 잡힌다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const parkSession = await login(origin, PARK.email)
    const park = api(origin, parkSession)
    const ohSession = await login(origin, OH.email)
    const oh = api(origin, ohSession)

    const mine = await park('POST', '/api/bulk-imports', { name: '내 프로젝트 이관', mapping: [{ folderPrefix: 'Flow/계약', projectId: 'PRJ-CONTRACT', tags: [], aiLevel: 'locked' }] })
    assert.equal(mine.status, 201, JSON.stringify(mine.body))

    const viewerOnly = await oh('POST', '/api/bulk-imports', { name: 'viewer 이관', mapping: [{ folderPrefix: 'Flow/계약', projectId: 'PRJ-CONTRACT', tags: [], aiLevel: 'locked' }] })
    assert.equal(viewerOnly.status, 403)
    assert.equal(viewerOnly.body.error.code, 'BULK_IMPORT_FORBIDDEN')

    const wide = await park('POST', '/api/bulk-imports', { name: '전사 이관', mapping: [{ folderPrefix: '', projectId: null, tags: [], aiLevel: 'locked' }] })
    assert.equal(wide.status, 403)
    // 범위 밖 프로젝트의 존재를 메시지가 알리지 않는다.
    assert.doesNotMatch(JSON.stringify(wide.body), /PRJ-|남의 프로젝트|설계 이관/)

    const outside = await park('POST', '/api/bulk-imports', { name: '남의 이관', mapping: [{ folderPrefix: 'X', projectId: 'PRJ-CLOSED', tags: [], aiLevel: 'locked' }] })
    assert.equal(outside.status, 403)

    // 관리자는 둘 다 된다.
    const adminWide = await admin('POST', '/api/bulk-imports', { name: '관리자 전사 이관', mapping: [{ folderPrefix: '', projectId: null, tags: [], aiLevel: 'locked' }] })
    assert.equal(adminWide.status, 201, JSON.stringify(adminWide.body))

    // 남의 세션은 존재를 알리지 않는다.
    assert.equal((await park('GET', `/api/bulk-imports/${adminWide.body.session.id}`)).status, 404)
    const listed = await park('GET', '/api/bulk-imports')
    assert.deepEqual(listed.body.sessions.map((session) => session.id), [mine.body.session.id])

    // 이관 도중에 멤버에서 빠지면 다음 업로드가 막힌다 — 멤버십은 네 지점에서 다시 본다.
    const id = mine.body.session.id
    await park('POST', `/api/bulk-imports/${id}/manifest`, { clientRequestId: 'p1', pageIndex: 0, entries: [manifestEntry(FILES[0])] })
    await park('PATCH', `/api/bulk-imports/${id}`, { status: 'uploading' })
    const projects = store.tenants[TENANT]['project-spaces'].data
    projects[0].members = projects[0].members.filter((member) => member.id !== PARK.id)
    const blocked = await upload(origin, parkSession)(FILES[0], { importId: id })
    assert.equal(blocked.status, 403, JSON.stringify(blocked.body))
    assert.equal(blocked.body.error.code, 'BULK_IMPORT_FORBIDDEN')
    const blockedPage = await park('POST', `/api/bulk-imports/${id}/manifest`, { clientRequestId: 'p2', pageIndex: 1, entries: [manifestEntry(FILES[1])] })
    assert.equal(blockedPage.status, 403)
  })
})

test('14. 게스트: 이관 라우트 전부 403이고, 업로드의 importId·sourcePath는 무시된다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const adminSession = await login(origin, ADMIN.email)
    const admin = api(origin, adminSession)
    const { id } = await startSession(admin, { mapping: CONTRACT_MAPPING })

    const guestSession = await login(origin, GUEST.email, GUEST.password)
    const guest = api(origin, guestSession)
    const routes = [
      ['GET', '/api/bulk-imports'],
      ['POST', '/api/bulk-imports'],
      ['GET', `/api/bulk-imports/${id}`],
      ['PATCH', `/api/bulk-imports/${id}`],
      ['POST', `/api/bulk-imports/${id}/manifest`],
      ['POST', `/api/bulk-imports/${id}/progress`],
      ['POST', `/api/bulk-imports/${id}/finish`],
      ['DELETE', `/api/bulk-imports/${id}`],
      ['POST', `/api/bulk-imports/${id}/ai-level`],
      ['GET', '/api/bulk-import-rules'],
      ['POST', '/api/bulk-import-rules'],
      ['DELETE', '/api/bulk-import-rules/IMR-1'],
    ]
    for (const [method, route] of routes) {
      const result = await guest(method, route, method === 'GET' || method === 'DELETE' ? undefined : {})
      assert.equal(result.status, 403, `${method} ${route}: ${JSON.stringify(result.body)}`)
      assert.deepEqual(result.body, { error: { code: 'GUEST_SCOPE_FORBIDDEN', message: '초대된 프로젝트 안에서만 사용할 수 있습니다.' } })
    }

    // POST /api/documents는 게스트 allowlist에 있다. 핸들러가 importId·sourcePath를 명시적으로 버린다.
    const guestUpload = await upload(origin, guestSession)(FILES[0], { importId: id })
    assert.equal(guestUpload.status, 201, JSON.stringify(guestUpload.body))
    assert.equal('importId' in guestUpload.body.document, false)
    assert.equal('sourcePath' in guestUpload.body.document, false)
    assert.equal(guestUpload.body.document.visibility, 'restricted')
    /**
     * 게스트가 넣은 파일의 AI 수준은 언제나 '보관만'이다. 값이 없으면 실효 수준이 '활용'이라
     * 외부 협력사가 올린 파일을 렌즈·판독·채팅 첨부가 전부 열 수 있다 —
     * 주석만 있고 코드가 없었을 때 정확히 그 상태였다.
     */
    assert.equal(guestUpload.body.document.aiPolicy, 'locked')
    const guestLens = await admin('POST', `/api/documents/${guestUpload.body.document.id}/lens`, { lensId: 'LENS-BUILTIN-CORE' })
    assert.equal(guestLens.status, 409, JSON.stringify(guestLens.body))
    assert.equal(guestLens.body.error.code, 'DOCUMENT_AI_LOCKED')

    // 게스트가 **실제로 읽을 수 있는** 벌크 이관분을 하나 만든다. 게스트가 PRJ-CONTRACT 멤버라
    // 계약 폴더로 들어간 자료는 allowedUserIds에 게스트가 들어간다 — 그 자료에서 두 키가 지워져야 한다.
    const imported = await upload(origin, adminSession)(FILES[0], { importId: id })
    assert.equal(imported.status, 201, JSON.stringify(imported.body))
    assert.equal(imported.body.document.sourcePath, FILES[0].path)
    assert.ok(imported.body.document.allowedUserIds.includes(GUEST.id), '게스트가 읽을 수 있어야 이 시험이 뜻을 갖는다')

    const guestList = await guest('GET', '/api/documents')
    assert.equal(guestList.status, 200, JSON.stringify(guestList.body))
    assert.ok(guestList.body.documents.some((document) => document.id === imported.body.document.id), '게스트에게 그 자료가 보인다')
    for (const document of guestList.body.documents) {
      assert.equal('sourcePath' in document, false, '사내 폴더 구조는 회사 정보다')
      assert.equal('importId' in document, false)
    }
  })
})

test('15. 일시 중지: 진행 보고는 통과하고 새 업로드는 409', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const call = api(origin, admin)
    const send = upload(origin, admin)
    const { id } = await startSession(call, { mapping: CONTRACT_MAPPING })
    const first = await send(FILES[0], { importId: id })
    assert.equal(first.status, 201)

    const paused = await call('PATCH', `/api/bulk-imports/${id}`, { status: 'paused' })
    assert.equal(paused.status, 200, JSON.stringify(paused.body))

    // 이미 올라간 파일의 상태는 잃지 않는다 — 409를 내기 전에 먼저 기록한다.
    const progress = await call('POST', `/api/bulk-imports/${id}/progress`, { results: [{ path: FILES[0].path, status: 'uploaded', documentId: first.body.document.id }] })
    assert.equal(progress.status, 409)
    assert.equal(progress.body.error.code, 'BULK_IMPORT_PAUSED')
    const seen = await call('GET', `/api/bulk-imports/${id}`)
    assert.equal(seen.body.report.uploaded, 1)

    const blocked = await send(FILES[1], { importId: id })
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body))
    assert.equal(blocked.body.error.code, 'BULK_IMPORT_PAUSED')

    const resumed = await call('PATCH', `/api/bulk-imports/${id}`, { status: 'uploading' })
    assert.equal(resumed.status, 200)
    assert.equal((await send(FILES[1], { importId: id })).status, 201)
  })
})

test('16. 세션을 지워도 문서는 남고, 문서를 지워도 보고서는 500이 되지 않는다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const call = api(origin, admin)
    const send = upload(origin, admin)
    const { id } = await startSession(call, { mapping: CONTRACT_MAPPING })
    const uploaded = await send(FILES[6], { importId: id })
    assert.equal(uploaded.status, 201)

    // 문서를 지우면 보고서가 그렇게 적는다 — 세션은 참조가 아니라 이력이라 삭제를 막지 않는다.
    const removed = await call('DELETE', `/api/documents/${uploaded.body.document.id}`)
    assert.equal(removed.status, 200, JSON.stringify(removed.body))
    const seen = await call('GET', `/api/bulk-imports/${id}`)
    assert.equal(seen.status, 200)
    assert.equal(seen.body.chunk.entries.find((entry) => entry.path === FILES[6].path).documentDeleted, true)

    const contract = await send(FILES[0], { importId: id })
    assert.equal(contract.status, 201)
    const deleted = await call('DELETE', `/api/bulk-imports/${id}`)
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body))
    assert.match(deleted.body.message, /자료실에 그대로 있습니다/)
    assert.equal((await call('GET', `/api/bulk-imports/${id}`)).status, 404)
    const listed = await call('GET', '/api/documents')
    assert.equal(listed.body.documents.some((document) => document.id === contract.body.document.id), true)
    // 청크 행도 함께 사라진다.
    assert.equal((store.tenants[TENANT]['bulk-imports'].data ?? []).length, 0)
  })
})

test('17. generic 저장소는 네 키 모두 404다 — 존재 오라클을 만들지 않는다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    for (const key of ['bulk-imports', 'bulk-import-rules', 'calendar-connections', 'calendar-sync-links']) {
      const read = await admin('GET', `/api/workspace/${key}`)
      assert.equal(read.status, 404, `${key} GET: ${JSON.stringify(read.body)}`)
      assert.equal(read.body.error.code, 'STORE_KEY_NOT_FOUND')
      const write = await admin('PUT', `/api/workspace/${key}`, { data: [] })
      assert.equal(write.status, 404, `${key} PUT: ${JSON.stringify(write.body)}`)
      assert.equal(write.body.error.code, 'STORE_KEY_NOT_FOUND')
    }
  })
})

test('18. 매핑 규칙 CRUD와 상한, 그리고 다른 테넌트의 세션 id는 404', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const call = api(origin, await login(origin, ADMIN.email))
    const created = await call('POST', '/api/bulk-import-rules', { name: '계약 폴더 매핑', mapping: CONTRACT_MAPPING })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    assert.equal(created.body.rule.mapping.length, 3)

    // 같은 이름은 덮어쓴다 — 저장한 매핑이 두 벌이 되면 어느 쪽이 최신인지 알 수 없다.
    const overwritten = await call('POST', '/api/bulk-import-rules', { name: '계약 폴더 매핑', mapping: [{ folderPrefix: 'Flow', projectId: 'PRJ-DESIGN', tags: [], aiLevel: 'indexed' }] })
    assert.equal(overwritten.status, 200)
    assert.equal(overwritten.body.rules.length, 1)
    assert.equal(overwritten.body.rule.id, created.body.rule.id)

    for (let index = 1; index < 50; index += 1) {
      const result = await call('POST', '/api/bulk-import-rules', { name: `매핑 ${index}`, mapping: [] })
      assert.equal(result.status, 201, `${index}: ${JSON.stringify(result.body)}`)
    }
    const over = await call('POST', '/api/bulk-import-rules', { name: '51번째', mapping: [] })
    assert.equal(over.status, 409)
    assert.equal(over.body.error.code, 'BULK_IMPORT_RULE_LIMIT')

    const removed = await call('DELETE', `/api/bulk-import-rules/${created.body.rule.id}`)
    assert.equal(removed.status, 200)
    assert.equal((await call('DELETE', `/api/bulk-import-rules/${created.body.rule.id}`)).status, 404)

    // 다른 테넌트의 세션 id는 존재를 알리지 않는다.
    store.tenants[OTHER_TENANT]['bulk-imports'] = { data: [{ kind: 'session', id: 'IMP-OTHER', name: '남의 이관', status: 'uploading', createdById: 'USR-POHANG-ADMIN', createdByName: '박해진', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', finishedAt: null, totals: { files: 0, bytes: 0, uploaded: 0, skippedDuplicate: 0, failed: 0 }, mapping: [], chunks: 0, manifestPages: [] }], updatedAt: '2026-09-01T00:00:00.000Z' }
    assert.equal((await call('GET', '/api/bulk-imports/IMP-OTHER')).status, 404)
    const listed = await call('GET', '/api/bulk-imports')
    assert.equal(listed.body.sessions.some((session) => session.id === 'IMP-OTHER'), false)
  })
})

/**
 * 재개는 '같은 폴더를 다시 골라 같은 매니페스트를 다시 보낸다'는 흐름이다.
 * 브라우저 판정에서 이 갈래가 통째로 무너지는 것을 봤다 — 아는 경로를 모두 duplicate로 답하는 바람에
 * 올릴 목록이 비어 5건이 전부 '다시 선택하지 않았습니다'로 마감됐다. 그 정확한 흐름을 여기 고정한다.
 */
test('19. 재개: 같은 매니페스트를 다시 보내면 아직 안 올린 파일이 pending 그대로 돌아온다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const call = api(origin, admin)
    const send = upload(origin, admin)
    const { id } = await startSession(call, { mapping: CONTRACT_MAPPING })
    const first = await send(FILES[0], { importId: id })
    assert.equal(first.status, 201)
    await call('POST', `/api/bulk-imports/${id}/progress`, { results: [{ path: FILES[0].path, status: 'uploaded', documentId: first.body.document.id }] })
    const paused = await call('PATCH', `/api/bulk-imports/${id}`, { status: 'paused' })
    assert.equal(paused.status, 200)

    // 탭을 닫았다 열고 같은 폴더를 다시 골랐다. 같은 clientRequestId까지 그대로다.
    const again = await call('POST', `/api/bulk-imports/${id}/manifest`, { clientRequestId: 'page-1', pageIndex: 0, entries: FILES.map(manifestEntry) })
    assert.equal(again.status, 200, JSON.stringify(again.body))
    assert.equal(again.body.replayed, true)
    assert.deepEqual(again.body.totals, { files: 7, bytes: first.body.document.size, uploaded: 1, skippedDuplicate: 0, failed: 0 }, '엔트리가 두 벌이 되지 않는다')
    assert.equal(again.body.verdicts.filter((entry) => entry.status === 'pending').length, 6, '아직 안 올린 6건은 pending 그대로여야 재개가 그것을 올린다')
    assert.equal(again.body.verdicts.find((entry) => entry.path === FILES[0].path).status, 'uploaded')

    const resumed = await call('PATCH', `/api/bulk-imports/${id}`, { status: 'uploading' })
    assert.equal(resumed.status, 200)
    const results = []
    for (const file of FILES.slice(1)) {
      const uploaded = await send(file, { importId: id })
      assert.equal(uploaded.status, 201, `${file.path}: ${JSON.stringify(uploaded.body)}`)
      results.push({ path: file.path, status: 'uploaded', documentId: uploaded.body.document.id })
    }
    await call('POST', `/api/bulk-imports/${id}/progress`, { results })
    const finished = await call('POST', `/api/bulk-imports/${id}/finish`)
    assert.equal(finished.body.session.status, 'done')
    assert.equal(finished.body.report.uploaded, 7)
    assert.deepEqual(finished.body.report.failures, [], '재개가 끝난 뒤에는 다시 고르지 않은 파일이 하나도 없다')
  })
})

test('19-1. 같은 탭에서 재개: 끝난 파일은 전용 코드로 거절되고, 실패한 파일은 다시 받아 준다', async () => {
  /**
   * 브라우저 판정에서 놓친 갈래다. 일시 중지 뒤 '이어서 올리기'는 같은 탭에서 목록을 다시 걷는데,
   * 이미 올린 파일이 그 목록에 남아 있으면 서버가 409를 낸다. 그 409가 세션 상태 409와 같은 코드면
   * 클라이언트는 '연결이 불안정하다'로 읽고 세 번 만에 스스로 멈춘다 — 영원히 재개하지 못한다.
   * 그래서 (1) 끝난 엔트리는 전용 코드로 답하고 (2) 실패한 엔트리는 다시 받는다.
   */
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const call = api(origin, admin)
    const send = upload(origin, admin)
    const { id } = await startSession(call, { mapping: CONTRACT_MAPPING })
    const first = await send(FILES[0], { importId: id })
    assert.equal(first.status, 201)
    await call('POST', `/api/bulk-imports/${id}/progress`, {
      results: [
        { path: FILES[0].path, status: 'uploaded', documentId: first.body.document.id },
        { path: FILES[1].path, status: 'failed', error: '연결이 끊겨 올리지 못했습니다.' },
      ],
    })

    // 이미 끝난 파일: 다시 올리지 않고, 그 사실을 세션 상태 409와 다른 코드로 알린다.
    const settled = await send(FILES[0], { importId: id })
    assert.equal(settled.status, 409, JSON.stringify(settled.body))
    assert.equal(settled.body.error.code, 'BULK_IMPORT_ENTRY_SETTLED')
    assert.notEqual(settled.body.error.code, 'BULK_IMPORT_STATUS_INVALID')

    // 실패한 파일: 문서가 없으므로 다시 받는다 — '실패한 파일부터 다시 시도합니다'가 사실이 된다.
    const retried = await send(FILES[1], { importId: id })
    assert.equal(retried.status, 201, JSON.stringify(retried.body))
    const seen = await call('GET', `/api/bulk-imports/${id}`)
    assert.equal(seen.body.report.uploaded, 2)
    assert.equal(seen.body.report.failed, 0, '다시 올라간 파일은 더 이상 실패가 아니다')
  })
})

test('20. 다시 고른 파일의 내용이 바뀌면 새 지문으로 갈아 끼워 업로드가 통과한다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const call = api(origin, admin)
    const send = upload(origin, admin)
    const { id } = await startSession(call, { mapping: CONTRACT_MAPPING })
    const edited = { path: FILES[0].path, body: '계약 본문을 고쳤다' }
    const again = await call('POST', `/api/bulk-imports/${id}/manifest`, { clientRequestId: 'page-2', pageIndex: 1, entries: [manifestEntry(edited)] })
    assert.equal(again.status, 200, JSON.stringify(again.body))
    assert.equal(again.body.verdicts[0].status, 'pending')
    assert.equal(again.body.verdicts[0].changed, true)
    assert.equal(again.body.totals.files, 7, '경로가 같으므로 엔트리는 늘지 않는다')
    const uploaded = await send(edited, { importId: id })
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body))
    // 옛 지문을 그대로 뒀다면 여기서 400 BULK_IMPORT_HASH_MISMATCH가 났을 것이다.
    assert.equal(uploaded.body.document.sourcePath, FILES[0].path)
  })
})

/**
 * http로 연 브라우저에는 crypto.subtle이 없다(사내 LAN 주소가 그렇다).
 * 그때도 매핑·재개·보고서가 그대로 돌아야 한다 — 중복만 서버가 업로드 시점에 잡는다.
 */
test('21. 지문 없는 매니페스트도 받아 매핑을 살리고, 중복은 dedupe=1이 잡는다', async () => {
  const existing = {
    id: 'DOC-SAME', tenantId: TENANT, name: '부속합의서.pdf', originalName: '부속합의서.pdf', mime: 'application/pdf',
    size: Buffer.byteLength(FILES[1].body), checksum: sha(FILES[1].body), category: '공통자료', visibility: 'all',
    departments: [], allowedUserIds: [], tags: [], summary: '', uploadedAt: '2026-09-01T00:00:00.000Z',
    uploadedById: ADMIN.id, uploadedByName: '김서원', storage: 'local',
  }
  const store = freshStore({ documents: [existing] })
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const call = api(origin, admin)
    const send = upload(origin, admin)
    const created = await call('POST', '/api/bulk-imports', { name: '지문 없는 이관', mapping: CONTRACT_MAPPING })
    const id = created.body.session.id
    const blind = await call('POST', `/api/bulk-imports/${id}/manifest`, {
      clientRequestId: 'blind-1', pageIndex: 0,
      entries: [FILES[0], FILES[1]].map((file) => ({ path: file.path, name: file.path.split('/').at(-1), size: Buffer.byteLength(file.body), sha256: '' })),
    })
    assert.equal(blind.status, 200, JSON.stringify(blind.body))
    assert.deepEqual(blind.body.verdicts.map((entry) => entry.status), ['pending', 'pending'], '지문이 없으면 중복을 미리 알 수 없다')
    await call('PATCH', `/api/bulk-imports/${id}`, { status: 'uploading' })

    // 지문이 없으니 업로드에 해시 헤더도 없다. 서버가 본문을 해싱해 중복을 잡는다.
    const first = await fetch(`${origin}/api/documents?importId=${id}&dedupe=1&sourcePath=${encodeURIComponent(FILES[0].path)}&name=x.pdf`, {
      method: 'POST',
      headers: { cookie: admin.headers.cookie, 'x-workspace-identity': admin.headers['x-workspace-identity'], 'content-type': 'application/octet-stream', 'x-file-name': 'x.pdf', 'x-file-type': 'application/pdf' },
      body: Buffer.from(FILES[0].body),
    })
    const firstBody = await readJson(first)
    assert.equal(first.status, 201, JSON.stringify(firstBody))
    // 매핑은 지문과 무관하게 그대로 적용된다.
    assert.equal(firstBody.document.category, '프로젝트')
    assert.equal(firstBody.document.aiPolicy, 'locked')
    assert.equal(firstBody.document.sourcePath, FILES[0].path)

    const duplicate = await send(FILES[1], { importId: id, extra: '&dedupe=1' })
    assert.equal(duplicate.status, 200, JSON.stringify(duplicate.body))
    assert.equal(duplicate.body.duplicateOf, 'DOC-SAME')
  })
})

test('22. 10MB를 넘는 파일은 매니페스트 단계에서 미리 알리고, 마감이 남은 pending을 닫는다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const call = api(origin, await login(origin, ADMIN.email))
    const created = await call('POST', '/api/bulk-imports', { name: '큰 파일 이관', mapping: [] })
    const id = created.body.session.id
    const manifest = await call('POST', `/api/bulk-imports/${id}/manifest`, {
      clientRequestId: 'big-1', pageIndex: 0,
      entries: [manifestEntry(FILES[0]), { path: 'Flow/계약/2024/구계약.pdf', name: '구계약.pdf', size: 11 * 1024 * 1024, sha256: sha('큰 파일') }],
    })
    assert.equal(manifest.status, 200, JSON.stringify(manifest.body))
    assert.deepEqual(manifest.body.verdicts.map((entry) => entry.status), ['pending', 'failed'])
    assert.equal(manifest.body.verdicts[1].error, OVERSIZE_MESSAGE)

    await call('PATCH', `/api/bulk-imports/${id}`, { status: 'uploading' })
    // 아무것도 올리지 않고 마감하면 남은 pending이 닫힌다 — 영원히 '올리는 중'인 세션을 남기지 않는다.
    const finished = await call('POST', `/api/bulk-imports/${id}/finish`)
    assert.equal(finished.status, 200, JSON.stringify(finished.body))
    assert.equal(finished.body.session.status, 'failed')
    assert.equal(finished.body.report.pending, 0)
    assert.equal(finished.body.report.failed, 2)
    /**
     * 마감이 닫는 pending에는 '이관 중단'을 누른 사람의 파일도 섞인다 — 그 사람은 폴더를 고른 채
     * 멈췄으므로 '재개할 때 다시 선택하지 않았습니다'는 거짓이다. 마감의 문장은 언제나 참인 쪽이다.
     */
    assert.equal(finished.body.report.failures.find((row) => row.path === FILES[0].path).error, UNFINISHED_MESSAGE)
    assert.doesNotMatch(finished.body.report.failures.find((row) => row.path === FILES[0].path).error, /다시 선택하지 않았습니다/)
  })
})

test('23. 보고서의 용량은 서버가 저장한 길이다 — 매니페스트가 주장한 크기가 아니다', async () => {
  /**
   * markUploaded가 상태만 갈아 끼우면 recomputeTotals는 매니페스트에 적힌 size를 더한다.
   * 그 값은 클라이언트의 주장이고, 지문을 만들 수 없는 주소(http)에서는 해시 대조도 없어
   * 틀려도 아무도 모른다. '올린 파일 N개 · X MB'는 서버가 센 값이어야 한다.
   */
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const call = api(origin, admin)
    const created = await call('POST', '/api/bulk-imports', { name: '용량 시험', mapping: CONTRACT_MAPPING })
    const id = created.body.session.id
    const manifest = await call('POST', `/api/bulk-imports/${id}/manifest`, {
      clientRequestId: 'size-1', pageIndex: 0,
      entries: [{ ...manifestEntry(FILES[0]), size: 9_999_999 }],
    })
    assert.equal(manifest.status, 200, JSON.stringify(manifest.body))
    await call('PATCH', `/api/bulk-imports/${id}`, { status: 'uploading' })
    const uploaded = await upload(origin, admin)(FILES[0], { importId: id })
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body))

    const finished = await call('POST', `/api/bulk-imports/${id}/finish`)
    assert.equal(finished.body.report.bytes, Buffer.byteLength(FILES[0].body), '저장한 바이트 수와 같다')
    assert.notEqual(finished.body.report.bytes, 9_999_999)
  })
})

test('12-1. 수준 내리기가 저장에 실패하면 지운 제안도 함께 살아 돌아온다', async () => {
  /**
   * 제안 삭제(writeProposals)는 테넌트 store를 **제자리에서** 고치고, persistDocumentList의 스냅샷은
   * store '참조'만 되돌린다. 그래서 커밋이 실패하면 문서의 aiPolicy는 되돌아가는데 제안 삭제만 살아남고,
   * 그 뒤 성공하는 아무 쓰기가 그것을 조용히 확정한다 — 한 쓰기에 속한 변경은 함께 살거나 함께 죽는다.
   */
  const store = freshStore()
  let failNext = false
  const app = buildApp(store, { onWorkspaceStoreChange: () => { if (failNext) { failNext = false; throw new Error('디스크 실패') } } })
  await withServer(app, async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const call = api(origin, admin)
    const plain = await upload(origin, admin)({ path: '견적서_2025.pdf', body: '견적 본문' })
    assert.equal(plain.status, 201, JSON.stringify(plain.body))
    const documentId = plain.body.document.id
    const pendingOf = async () => {
      const proposals = await call('GET', '/api/proposals')
      return proposals.body.proposals.filter((item) => item.sourceKey === `doc:${documentId}` && item.status === 'pending')
    }
    const before = await pendingOf()
    assert.ok(before.length > 0, '분류 제안이 없으면 이 시험은 아무것도 보지 않는다')

    failNext = true
    const failed = await call('PATCH', `/api/documents/${documentId}`, { aiPolicy: 'locked' })
    assert.equal(failed.status, 500, JSON.stringify(failed.body))
    assert.equal(failed.body.error.code, 'DOCUMENT_UPDATE_FAILED')

    const documents = await call('GET', '/api/documents')
    assert.equal(documents.body.documents.find((item) => item.id === documentId).aiPolicy, undefined, '문서 변경은 되돌아간다')
    assert.equal((await pendingOf()).length, before.length, '제안 삭제도 함께 되돌아간다')

    // 되돌린 뒤에도 정상 경로는 그대로 동작한다 — 롤백이 상태를 망가뜨리지 않았다는 증거다.
    const locked = await call('PATCH', `/api/documents/${documentId}`, { aiPolicy: 'locked' })
    assert.equal(locked.status, 200, JSON.stringify(locked.body))
    assert.equal((await pendingOf()).length, 0)
  })
})

test('19-2. ‘올렸다’는 보고는 그 자료가 실제로 있을 때만 받는다', async () => {
  /**
   * 진행 보고 라우트는 클라이언트의 주장을 받는다. 확인 없이 받아 주면 보고서의 '올린 파일 N개 · X MB'가
   * 매니페스트가 적어 온 숫자가 된다 — 저장소에는 한 바이트도 없는데 9MB를 올렸다고 말하게 된다.
   */
  const store = freshStore()
  const storage = memoryStorage()
  await withServer(buildApp(store, { documentStorage: storage }), async (origin) => {
    const call = api(origin, await login(origin, ADMIN.email))
    const created = await call('POST', '/api/bulk-imports', { name: '허위 보고 시험', mapping: CONTRACT_MAPPING })
    const id = created.body.session.id
    await call('POST', `/api/bulk-imports/${id}/manifest`, { clientRequestId: 'claim-1', pageIndex: 0, entries: [{ ...manifestEntry(FILES[0]), size: 9_000_000 }] })
    await call('PATCH', `/api/bulk-imports/${id}`, { status: 'uploading' })

    const progress = await call('POST', `/api/bulk-imports/${id}/progress`, { results: [{ path: FILES[0].path, status: 'uploaded', documentId: 'DOC-NOT-REAL' }] })
    assert.equal(progress.status, 200, JSON.stringify(progress.body))
    assert.deepEqual(progress.body.totals, { files: 1, bytes: 0, uploaded: 0, skippedDuplicate: 0, failed: 1 })
    assert.equal(storage.files.size, 0, '저장된 바이트가 없다')

    const finished = await call('POST', `/api/bulk-imports/${id}/finish`)
    assert.equal(finished.body.report.uploaded, 0)
    assert.equal(finished.body.report.bytes, 0, '저장된 적 없는 바이트를 세지 않는다')
    assert.equal(finished.body.report.failures[0].error, UNVERIFIED_UPLOAD_MESSAGE)
  })
})

test('19-3. 크래시 복구 보고는 그대로 받고, 용량은 저장된 문서에서 가져온다', async () => {
  /**
   * 19-2의 짝. 이 갈래를 정직하게 지나는 흐름(파일은 저장됐는데 상태 기록 전에 브라우저가 죽은 창)은
   * 막히지 않아야 하고, 그때 보고서의 용량은 매니페스트가 아니라 **저장된 문서**에서 나와야 한다.
   */
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const call = api(origin, admin)
    const created = await call('POST', '/api/bulk-imports', { name: '복구 시험', mapping: CONTRACT_MAPPING })
    const id = created.body.session.id
    await call('POST', `/api/bulk-imports/${id}/manifest`, { clientRequestId: 'crash-1', pageIndex: 0, entries: [{ ...manifestEntry(FILES[0]), size: 9_000_000 }] })
    await call('PATCH', `/api/bulk-imports/${id}`, { status: 'uploading' })
    const stored = await upload(origin, admin)(FILES[0], { importId: id })
    assert.equal(stored.status, 201, JSON.stringify(stored.body))

    // 엔트리를 pending으로 되돌린다 — 파일은 저장됐는데 상태 기록 전에 브라우저가 죽은 창 그대로다.
    for (const row of store.tenants[TENANT]['bulk-imports'].data) {
      if (row?.kind !== 'chunk') continue
      for (const entry of row.entries) if (entry.path === FILES[0].path) { entry.status = 'pending'; entry.documentId = ''; entry.size = 9_000_000 }
    }
    const progress = await call('POST', `/api/bulk-imports/${id}/progress`, { results: [{ path: FILES[0].path, status: 'uploaded', documentId: stored.body.document.id }] })
    assert.equal(progress.status, 200, JSON.stringify(progress.body))
    assert.deepEqual(progress.body.totals, { files: 1, bytes: Buffer.byteLength(FILES[0].body), uploaded: 1, skippedDuplicate: 0, failed: 0 })
  })
})

test('24. 보고서는 그때 적용된 행으로 묶는다 — 나중에 고친 매핑이 이력을 바꾸지 않는다', async () => {
  /**
   * 매핑은 이관이 끝난 뒤에도 고칠 수 있다. 보고서를 현재 매핑으로 다시 풀면 이미 저장된 파일에 대해
   * 하지 않은 일을 말한다: PRJ-CONTRACT로 잠겨 저장된 계약서가 '설계 이관 · 활용'으로 적힌다.
   * 그 행 옆의 '정리 수준으로 올리기' 버튼도 같은 묶음을 봐야 숫자와 효과가 어긋나지 않는다.
   */
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const call = api(origin, admin)
    const { id } = await startSession(call, { mapping: CONTRACT_MAPPING })
    const stored = await upload(origin, admin)(FILES[0], { importId: id })
    assert.equal(stored.status, 201, JSON.stringify(stored.body))
    assert.equal(stored.body.document.projectId, 'PRJ-CONTRACT')
    assert.equal(stored.body.document.aiPolicy, 'locked')

    // 이관 도중 매핑을 통째로 갈아 끼운다(사람이 표를 고칠 수 있는 값이다).
    const patched = await call('PATCH', `/api/bulk-imports/${id}`, { mapping: [{ folderPrefix: 'Flow', projectId: 'PRJ-DESIGN', tags: [], aiLevel: 'active' }] })
    assert.equal(patched.status, 200, JSON.stringify(patched.body))

    const finished = await call('POST', `/api/bulk-imports/${id}/finish`)
    const applied = finished.body.report.folders.find((folder) => folder.folderPrefix === 'Flow/계약')
    assert.ok(applied, '올라간 파일은 그때 걸린 행으로 남는다')
    assert.equal(applied.projectId, 'PRJ-CONTRACT')
    assert.equal(applied.aiLevel, 'locked')
    assert.equal(applied.uploaded, 1)
    // 아직 올라가지 않은 엔트리는 앞으로 적용될 행(지금 매핑)으로 묶인다 — 그 둘은 다른 사실이다.
    const future = finished.body.report.folders.find((folder) => folder.folderPrefix === 'Flow')
    assert.equal(future.projectId, 'PRJ-DESIGN')
    assert.equal(future.uploaded, 0)

    // 버튼의 효과는 그 행의 숫자와 같아야 한다.
    const raised = await call('POST', `/api/bulk-imports/${id}/ai-level`, { folderPrefix: 'Flow/계약', level: 'indexed' })
    assert.equal(raised.status, 200, JSON.stringify(raised.body))
    assert.equal(raised.body.updated, 1)
    assert.equal(store.tenants[TENANT]['company-documents'].data.find((document) => document.sourcePath === FILES[0].path).aiPolicy, 'indexed')
  })
})

test('19-4. 진행 보고의 ‘올렸다’는 남의 문서 id로 증명되지 않는다 — 크기 오라클을 만들지 않는다', async () => {
  /**
   * 검증이 문서 id만 보고 그 문서가 **이 세션·이 경로의 것인지** 보지 않으면, 테넌트의 아무나
   * 읽지 못하는 문서의 존재와 크기를 알아내는 창구가 된다: 200이면 있는 것이고, 엔트리에 새겨진
   * size가 그 문서의 바이트 수다(GET /api/bulk-imports/:id가 그대로 돌려준다).
   */
  const secret = {
    id: 'DOC-SECRET-1', tenantId: TENANT, name: '임원 계약.pdf', originalName: '임원 계약.pdf', mime: 'application/pdf',
    size: 987_654, checksum: sha('임원 계약 본문'), category: '공통자료', visibility: 'restricted',
    departments: [], allowedUserIds: [OH.id], tags: [], summary: '', uploadedAt: '2026-09-01T00:00:00.000Z',
    uploadedById: OH.id, uploadedByName: OH.name, storage: 'local',
  }
  const store = freshStore({ documents: [secret] })
  await withServer(buildApp(store), async (origin) => {
    const park = api(origin, await login(origin, PARK.email))
    // 박지현은 그 문서를 목록에서도 보지 못한다 — 여기가 시험의 출발점이다.
    const visible = await park('GET', '/api/documents')
    assert.equal(visible.body.documents.some((document) => document.id === 'DOC-SECRET-1'), false)

    const created = await park('POST', '/api/bulk-imports', { name: '오라클 시험', mapping: [{ folderPrefix: 'Flow/계약', projectId: 'PRJ-CONTRACT', tags: [], aiLevel: 'locked' }] })
    const id = created.body.session.id
    await park('POST', `/api/bulk-imports/${id}/manifest`, { clientRequestId: 'oracle-1', pageIndex: 0, entries: [manifestEntry(FILES[0])] })
    await park('PATCH', `/api/bulk-imports/${id}`, { status: 'uploading' })

    const claimed = await park('POST', `/api/bulk-imports/${id}/progress`, { results: [{ path: FILES[0].path, status: 'uploaded', documentId: 'DOC-SECRET-1' }] })
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body))
    assert.deepEqual(claimed.body.totals, { files: 1, bytes: 0, uploaded: 0, skippedDuplicate: 0, failed: 1 }, '남의 문서로는 아무것도 증명되지 않는다')
    const page = await park('GET', `/api/bulk-imports/${id}?chunk=0`)
    const entry = page.body.chunk.entries.find((row) => row.path === FILES[0].path)
    assert.equal(entry.status, 'failed')
    assert.equal(entry.error, UNVERIFIED_UPLOAD_MESSAGE)
    assert.equal(entry.size, Buffer.byteLength(FILES[0].body), '남의 문서 크기가 새겨지지 않는다')
    assert.equal(entry.documentId, '')
  })
})

test('19-5. 크래시 복구로 확정된 엔트리에도 그때 적용된 행이 새겨진다', async () => {
  /**
   * 도장이 있는 이유는 하나다: 이관이 끝난 뒤 매핑을 고쳐도 보고서가 하지 않은 일을 말하지 않는 것.
   * 이 갈래(진행 보고)만 새기지 않으면 그 약속이 여기서만 깨진다.
   */
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const adminSession = await login(origin, ADMIN.email)
    const call = api(origin, adminSession)
    const created = await call('POST', '/api/bulk-imports', { name: '도장 시험', mapping: CONTRACT_MAPPING })
    const id = created.body.session.id
    await call('POST', `/api/bulk-imports/${id}/manifest`, { clientRequestId: 'stamp-1', pageIndex: 0, entries: [manifestEntry(FILES[0])] })
    await call('PATCH', `/api/bulk-imports/${id}`, { status: 'uploading' })
    const stored = await upload(origin, adminSession)(FILES[0], { importId: id })
    assert.equal(stored.body.document.projectId, 'PRJ-CONTRACT')

    // 상태 기록 전에 브라우저가 죽은 창을 그대로 만든다.
    for (const row of store.tenants[TENANT]['bulk-imports'].data) {
      if (row?.kind !== 'chunk') continue
      for (const entry of row.entries) {
        if (entry.path !== FILES[0].path) continue
        entry.status = 'pending'; entry.documentId = ''
        delete entry.appliedPrefix; delete entry.appliedProjectId; delete entry.appliedAiLevel
      }
    }
    const progress = await call('POST', `/api/bulk-imports/${id}/progress`, { results: [{ path: FILES[0].path, status: 'uploaded', documentId: stored.body.document.id }] })
    assert.equal(progress.status, 200, JSON.stringify(progress.body))

    await call('PATCH', `/api/bulk-imports/${id}`, { mapping: [{ folderPrefix: 'Flow', projectId: 'PRJ-DESIGN', tags: [], aiLevel: 'active' }] })
    const finished = await call('POST', `/api/bulk-imports/${id}/finish`)
    const applied = finished.body.report.folders.find((folder) => folder.folderPrefix === 'Flow/계약')
    assert.ok(applied, '올라간 파일은 그때 걸린 행으로 남는다')
    assert.equal(applied.projectId, 'PRJ-CONTRACT', '문서에 실제로 실린 값이 그때의 진실이다')
    assert.equal(applied.aiLevel, 'locked')
    assert.equal(applied.uploaded, 1)
  })
})

test('9-5. 매핑을 고친 뒤 다시 보낸 매니페스트가 그때서야 열람 범위를 넓힌다', async () => {
  /**
   * 첫 매니페스트는 언제나 자동 감지 매핑(대상 프로젝트 없음)으로 간다 — 표는 그 판정 뒤에 그려지고,
   * 사람은 거기서 프로젝트를 고른다. 아는 경로를 다시 판정하지 않으면 '이미 있는 자료의 열람 범위를
   * 넓혔습니다'는 관리자의 정상 흐름에서 **한 번도** 일어나지 않는다(직원은 첫 세션 생성이 403이라
   * 우연히 표를 먼저 거친다 — 역할에 따라 갈리는 비대칭이었다).
   */
  const existing = {
    id: 'DOC-OLD', tenantId: TENANT, name: '삼성전자_계약서.pdf', originalName: '삼성전자_계약서.pdf', mime: 'application/pdf',
    size: Buffer.byteLength(FILES[0].body), checksum: sha(FILES[0].body), category: '공통자료', visibility: 'restricted',
    departments: [], allowedUserIds: [ADMIN.id], tags: [], summary: '', uploadedAt: '2026-09-01T00:00:00.000Z',
    uploadedById: ADMIN.id, uploadedByName: '김서원', storage: 'local',
  }
  const store = freshStore({ documents: [existing] })
  await withServer(buildApp(store), async (origin) => {
    const call = api(origin, await login(origin, ADMIN.email))
    // 화면이 실제로 보내는 첫 매핑: 자동 감지 폴더 하나, 대상 프로젝트 없음.
    const created = await call('POST', '/api/bulk-imports', { name: '나중에 고른 매핑', mapping: [{ folderPrefix: 'Flow', projectId: null, tags: [], aiLevel: 'locked' }] })
    const id = created.body.session.id
    const page = { clientRequestId: 'late-1', pageIndex: 0, entries: [manifestEntry(FILES[0])] }
    const first = await call('POST', `/api/bulk-imports/${id}/manifest`, page)
    assert.equal(first.body.verdicts[0].status, 'duplicate', '자료실 행에서는 닫는 것이 맞다 — 대상 프로젝트가 없다')
    assert.equal(first.body.accessWidened, undefined)
    assert.deepEqual(store.tenants[TENANT]['company-documents'].data[0].allowedUserIds, [ADMIN.id])

    // 사람이 표에서 대상 프로젝트를 고른다. 그 다음 '이관 시작'이 같은 목록을 다시 보낸다.
    await call('PATCH', `/api/bulk-imports/${id}`, { mapping: [{ folderPrefix: 'Flow', projectId: 'PRJ-CONTRACT', tags: [], aiLevel: 'locked' }] })
    const second = await call('POST', `/api/bulk-imports/${id}/manifest`, { ...page, clientRequestId: 'late-2' })
    assert.equal(second.status, 200, JSON.stringify(second.body))
    assert.equal(second.body.verdicts[0].status, 'duplicate')
    assert.equal(second.body.accessWidened, 1, '그때서야 넓힌다 — 화면의 문장이 뜰 수 있는 유일한 자리다')
    const widened = store.tenants[TENANT]['company-documents'].data.find((document) => document.id === 'DOC-OLD')
    assert.equal(widened.allowedUserIds.includes(GUEST.id), true)
    assert.equal(widened.projectId, undefined, '있던 자료의 귀속은 이관이 다시 쓰지 않는다')
    assert.equal(second.body.totals.files, 1, '아는 경로는 엔트리를 늘리지 않는다')

    // 한 번 더 보내도 같은 상태다 — 이미 열려 있으므로 넓힐 것이 없다(멱등).
    const third = await call('POST', `/api/bulk-imports/${id}/manifest`, { ...page, clientRequestId: 'late-3' })
    assert.equal(third.body.accessWidened, undefined)
  })
})

test('9-6. 넓힐 수 없게 바뀐 중복은 다시 올릴 대상으로 돌아온다', async () => {
  /**
   * 자료실 행에서 닫힌 중복을 사람이 프로젝트 행으로 고쳤는데 그 자료가 부서 공개라면,
   * 그 프로젝트 구성원은 그것을 열지 못한다. 닫아 둔 판정을 그대로 두면 보고서는 '건너뜀 1'이라
   * 적고 그 프로젝트에는 그 파일이 없다.
   */
  const departmentDocument = {
    id: 'DOC-DEPT', tenantId: TENANT, name: '품질지침.pdf', originalName: '품질지침.pdf', mime: 'application/pdf',
    size: Buffer.byteLength(FILES[0].body), checksum: sha(FILES[0].body), category: '공통자료',
    visibility: 'department', departments: ['품질관리'], allowedUserIds: [], tags: [], summary: '',
    uploadedAt: '2026-09-01T00:00:00.000Z', uploadedById: ADMIN.id, uploadedByName: '김서원', storage: 'local',
  }
  const store = freshStore({ documents: [departmentDocument] })
  await withServer(buildApp(store), async (origin) => {
    const call = api(origin, await login(origin, ADMIN.email))
    const created = await call('POST', '/api/bulk-imports', { name: '되돌아오는 중복', mapping: [{ folderPrefix: 'Flow', projectId: null, tags: [], aiLevel: 'locked' }] })
    const id = created.body.session.id
    const page = { clientRequestId: 'reopen-1', pageIndex: 0, entries: [manifestEntry(FILES[0])] }
    const first = await call('POST', `/api/bulk-imports/${id}/manifest`, page)
    assert.equal(first.body.verdicts[0].status, 'duplicate')
    assert.equal(first.body.totals.skippedDuplicate, 1)

    await call('PATCH', `/api/bulk-imports/${id}`, { mapping: [{ folderPrefix: 'Flow', projectId: 'PRJ-CONTRACT', tags: [], aiLevel: 'locked' }] })
    const second = await call('POST', `/api/bulk-imports/${id}/manifest`, { ...page, clientRequestId: 'reopen-2' })
    assert.equal(second.body.verdicts[0].status, 'pending', '그 프로젝트에서 열리지 않는 자료는 다시 올린다')
    assert.equal(second.body.verdicts[0].duplicateOf, undefined)
    assert.deepEqual(second.body.totals, { files: 1, bytes: 0, uploaded: 0, skippedDuplicate: 0, failed: 0 })
    // 저장된 엔트리도 함께 열린다 — 응답만 pending이면 업로드가 ENTRY_SETTLED로 거절된다.
    const stored = store.tenants[TENANT]['bulk-imports'].data.find((row) => row?.kind === 'chunk').entries[0]
    assert.equal(stored.status, 'pending')
    assert.equal(stored.duplicateOf, '')
  })
})

test('9-7. 같은 파일이 두 프로젝트 폴더에 있으면 두 프로젝트 모두에 도착한다', async () => {
  /**
   * 화면이 실제로 밟는 순서: 첫 매니페스트는 자동 감지 매핑(폴더 하나·대상 프로젝트 없음)으로 가고,
   * 사람은 그 뒤에 표를 나눠 두 프로젝트를 고른다. 그 시점에 같은 묶음의 중복을 다시 판정하지 않으면
   * 두 번째 프로젝트에는 그 파일이 **영영 없고**, 보고서는 '이미 있어서 건너뜀'이라고 적는다.
   * Flow 내보내기가 공통 문서를 계약·설계 폴더에 함께 넣는 흔한 경우다.
   */
  const COPIES = [
    { path: 'Flow/계약/공통_표준계약서.pdf', body: '두 폴더에 복사해 둔 같은 본문' },
    { path: 'Flow/설계/공통_표준계약서.pdf', body: '두 폴더에 복사해 둔 같은 본문' },
    { path: 'Flow/계약/사본_표준계약서.pdf', body: '두 폴더에 복사해 둔 같은 본문' },
    { path: 'Flow/설계/사본_표준계약서.pdf', body: '두 폴더에 복사해 둔 같은 본문' },
  ]
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const call = api(origin, admin)
    const send = upload(origin, admin)
    const created = await call('POST', '/api/bulk-imports', { name: '두 폴더에 같은 파일', mapping: [{ folderPrefix: 'Flow', projectId: null, tags: [], aiLevel: 'locked' }] })
    const id = created.body.session.id
    const page = { pageIndex: 0, entries: COPIES.map(manifestEntry) }

    const first = await call('POST', `/api/bulk-imports/${id}/manifest`, { ...page, clientRequestId: 'copies-1' })
    assert.deepEqual(first.body.verdicts.map((entry) => entry.status), ['pending', 'duplicate', 'duplicate', 'duplicate'], '대상 프로젝트가 없으면 닫는 것이 맞다')

    // 사람이 표를 나눠 두 프로젝트를 고른다 → '이관 시작'이 같은 목록을 다시 보낸다(지문은 다시 만들지 않는다).
    await call('PATCH', `/api/bulk-imports/${id}`, { mapping: [
      { folderPrefix: 'Flow/계약', projectId: 'PRJ-CONTRACT', tags: [], aiLevel: 'locked' },
      { folderPrefix: 'Flow/설계', projectId: 'PRJ-DESIGN', tags: [], aiLevel: 'locked' },
    ] })
    const second = await call('POST', `/api/bulk-imports/${id}/manifest`, { ...page, clientRequestId: 'copies-2' })
    assert.equal(second.status, 200, JSON.stringify(second.body))
    assert.deepEqual(second.body.verdicts.map((entry) => entry.status), ['pending', 'pending', 'duplicate', 'duplicate'])
    // 되돌아온 파일이 그 프로젝트의 새 기준이 된다 — 같은 프로젝트로 갈 사본이 두 벌 올라가지 않는다.
    assert.equal(second.body.verdicts[2].duplicateOfPath, 'Flow/계약/공통_표준계약서.pdf')
    assert.equal(second.body.verdicts[3].duplicateOfPath, 'Flow/설계/공통_표준계약서.pdf')
    assert.equal(second.body.totals.files, 4, '아는 경로는 엔트리를 늘리지 않는다')
    const storedEntries = store.tenants[TENANT]['bulk-imports'].data.find((row) => row?.kind === 'chunk').entries
    assert.equal(storedEntries[1].status, 'pending', '저장된 엔트리도 함께 열려야 업로드가 409로 막히지 않는다')
    assert.equal(storedEntries[3].duplicateOfPath, 'Flow/설계/공통_표준계약서.pdf')

    await call('PATCH', `/api/bulk-imports/${id}`, { status: 'uploading' })
    for (const file of [COPIES[0], COPIES[1]]) {
      const result = await send(file, { importId: id })
      assert.equal(result.status, 201, `${file.path} → ${JSON.stringify(result.body)}`)
    }
    const finished = await call('POST', `/api/bulk-imports/${id}/finish`)
    const design = finished.body.report.folders.find((folder) => folder.folderPrefix === 'Flow/설계')
    assert.deepEqual({ uploaded: design.uploaded, skippedDuplicate: design.skippedDuplicate, projectId: design.projectId }, { uploaded: 1, skippedDuplicate: 1, projectId: 'PRJ-DESIGN' })

    // 설계 프로젝트의 구성원이 실제로 그 파일을 본다 — 보고서의 '건너뜀'이 구멍을 가리지 않는다.
    const park = api(origin, await login(origin, PARK.email))
    const visible = await park('GET', '/api/documents')
    const inDesign = visible.body.documents.filter((document) => document.projectId === 'PRJ-DESIGN')
    assert.equal(inDesign.length, 1, JSON.stringify(visible.body.documents.map((document) => [document.sourcePath, document.projectId])))
    assert.equal(inDesign[0].sourcePath, 'Flow/설계/공통_표준계약서.pdf')
    assert.equal(visible.body.documents.filter((document) => document.projectId === 'PRJ-CONTRACT').length, 1)
  })
})

test('9-8. 중복 대상이 사라졌으면 닫지 않는다 — 파일을 잃고 건너뛰었다고 적지 않는다', async () => {
  /**
   * 업로드 단계는 'duplicate' 엔트리를 다시 판정하지 않는다(ENTRY_SETTLED로 되돌려보낸다).
   * 그러니 매니페스트가 '문서가 사라졌으니 업로드가 다시 보겠지'라고 닫으면 그 파일은 어디에도
   * 저장되지 않은 채 보고서에만 '이미 있어서 건너뜀'으로 남는다 — 파일을 잃고, 잃었다는 말도 없다.
   */
  const existing = {
    id: 'DOC-OLD', tenantId: TENANT, name: '삼성전자_계약서.pdf', originalName: '삼성전자_계약서.pdf', mime: 'application/pdf',
    size: Buffer.byteLength(FILES[0].body), checksum: sha(FILES[0].body), category: '공통자료', visibility: 'all',
    departments: [], allowedUserIds: [], tags: [], summary: '', uploadedAt: '2026-09-01T00:00:00.000Z',
    uploadedById: ADMIN.id, uploadedByName: '김서원', storage: 'local',
  }
  const store = freshStore({ documents: [existing] })
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const call = api(origin, admin)
    const created = await call('POST', '/api/bulk-imports', { name: '사라진 대상', mapping: [{ folderPrefix: 'Flow', projectId: 'PRJ-CONTRACT', tags: [], aiLevel: 'locked' }] })
    const id = created.body.session.id
    const page = { pageIndex: 0, entries: [manifestEntry(FILES[0])] }
    const first = await call('POST', `/api/bulk-imports/${id}/manifest`, { ...page, clientRequestId: 'gone-1' })
    assert.equal(first.body.verdicts[0].status, 'duplicate', '전 직원 자료는 그 프로젝트에서도 열린다')

    // 그 사이 누군가 자료실에서 그 자료를 지운다.
    const removed = await call('DELETE', '/api/documents/DOC-OLD')
    assert.equal(removed.status, 200, JSON.stringify(removed.body))

    const second = await call('POST', `/api/bulk-imports/${id}/manifest`, { ...page, clientRequestId: 'gone-2' })
    assert.equal(second.body.verdicts[0].status, 'pending', '가리킬 자료가 없으면 다시 올릴 대상이다')
    assert.equal(second.body.verdicts[0].duplicateOf, undefined)

    await call('PATCH', `/api/bulk-imports/${id}`, { status: 'uploading' })
    const sent = await upload(origin, admin)(FILES[0], { importId: id })
    assert.equal(sent.status, 201, JSON.stringify(sent.body))
    const finished = await call('POST', `/api/bulk-imports/${id}/finish`)
    assert.deepEqual(
      { uploaded: finished.body.report.uploaded, skipped: finished.body.report.skippedDuplicate, failed: finished.body.report.failed },
      { uploaded: 1, skipped: 0, failed: 0 },
    )
    const stored = store.tenants[TENANT]['company-documents'].data.filter((document) => document.sourcePath === FILES[0].path)
    assert.equal(stored.length, 1)
    assert.equal(stored[0].projectId, 'PRJ-CONTRACT')
  })
})

test('9-9. 읽지 못한 매핑 표는 빈 표가 아니다 — 전 직원 공개로 떨어지지 않는다', async () => {
  /**
   * 저장된 세션 한 행을 읽지 못했을 때 표를 비우면, 모든 경로가 기본 행(대상 프로젝트 없음)으로
   * 떨어져 프로젝트 자료가 회사 전체가 보는 자료실로 올라간다 — '못 읽었다'가 권한을 넓히는
   * 방향으로 번역되는 자리다. 매니페스트도 업로드도 그 사실을 보고 거절하고, 표를 다시 저장하면 풀린다.
   */
  const store = freshStore()
  store.tenants[TENANT]['bulk-imports'] = { data: [{
    kind: 'session', id: 'IMP-BROKEN', name: '깨진 표', status: 'uploading',
    createdById: ADMIN.id, createdByName: '김서원', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    finishedAt: null, totals: { files: 0, bytes: 0, uploaded: 0, skippedDuplicate: 0, failed: 0 },
    // 같은 접두를 두 번 선언한 행 — normalizeMapping이 표 전체를 거절하는 갈래다.
    mapping: [{ folderPrefix: 'Flow/계약', projectId: 'PRJ-CONTRACT' }, { folderPrefix: 'Flow/계약', projectId: 'PRJ-DESIGN' }],
    chunks: 1, manifestPages: [],
  }, {
    kind: 'chunk', id: 'IMP-BROKEN-C000', sessionId: 'IMP-BROKEN', index: 0,
    entries: [{ path: FILES[0].path, name: '삼성전자_계약서.pdf', size: Buffer.byteLength(FILES[0].body), sha256: sha(FILES[0].body), status: 'pending', documentId: '', duplicateOf: '', duplicateOfPath: '', error: '', changed: false }],
  }], updatedAt: '2026-09-01T00:00:00.000Z' }
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const call = api(origin, admin)
    const manifest = await call('POST', '/api/bulk-imports/IMP-BROKEN/manifest', { clientRequestId: 'broken-1', pageIndex: 0, entries: [manifestEntry(FILES[0])] })
    assert.equal(manifest.status, 400, JSON.stringify(manifest.body))
    assert.equal(manifest.body.error.code, 'BULK_IMPORT_MAPPING_INVALID')
    const sent = await upload(origin, admin)(FILES[0], { importId: 'IMP-BROKEN' })
    assert.equal(sent.status, 400, JSON.stringify(sent.body))
    assert.equal(sent.body.error.code, 'BULK_IMPORT_MAPPING_INVALID')
    assert.equal(store.tenants[TENANT]['company-documents'], undefined, '전사 공개 자료가 하나도 생기지 않는다')

    // 표를 고치면 그 자리에서 풀린다 — 사람이 화면에서 빠져나갈 수 있는 길이 있어야 한다.
    const fixed = await call('PATCH', '/api/bulk-imports/IMP-BROKEN', { mapping: [{ folderPrefix: 'Flow/계약', projectId: 'PRJ-CONTRACT', tags: [], aiLevel: 'locked' }] })
    assert.equal(fixed.status, 200, JSON.stringify(fixed.body))
    const again = await upload(origin, admin)(FILES[0], { importId: 'IMP-BROKEN' })
    assert.equal(again.status, 201, JSON.stringify(again.body))
    assert.equal(again.body.document.visibility, 'restricted')
    assert.equal(again.body.document.projectId, 'PRJ-CONTRACT')
  })
})

test('9-10. 상한이 내려가기 전에 저장된 행은 잘라서 읽는다 — 프로젝트 귀속을 잃지 않는다', async () => {
  /**
   * 사용자 태그 상한이 20에서 18로 내려간 뒤, 그 전에 저장된 행(태그 20개)을 만나면 표 전체가
   * 거절될 수 있다. 그 결과가 '빈 표'라면 그 행의 파일들은 대상 프로젝트를 잃고 전 직원 자료실로 간다 —
   * 상한을 고친 일이 권한을 넓히는 사고가 된다. 저장된 행은 잘라서 읽고 귀속은 그대로 지킨다.
   */
  const store = freshStore()
  store.tenants[TENANT]['bulk-imports'] = { data: [{
    kind: 'session', id: 'IMP-LEGACY', name: '옛 태그 세션', status: 'uploading',
    createdById: ADMIN.id, createdByName: '김서원', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    finishedAt: null, totals: { files: 0, bytes: 0, uploaded: 0, skippedDuplicate: 0, failed: 0 },
    mapping: [{ folderPrefix: 'Flow/계약', projectId: 'PRJ-CONTRACT', tags: Array.from({ length: 20 }, (_, index) => `t${index}`), aiLevel: 'locked' }],
    chunks: 1, manifestPages: [],
  }, {
    kind: 'chunk', id: 'IMP-LEGACY-C000', sessionId: 'IMP-LEGACY', index: 0,
    entries: [{ path: FILES[0].path, name: '삼성전자_계약서.pdf', size: Buffer.byteLength(FILES[0].body), sha256: sha(FILES[0].body), status: 'pending', documentId: '', duplicateOf: '', duplicateOfPath: '', error: '', changed: false }],
  }], updatedAt: '2026-09-01T00:00:00.000Z' }
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const call = api(origin, admin)
    const loaded = await call('GET', '/api/bulk-imports/IMP-LEGACY')
    assert.equal(loaded.body.session.mapping.length, 1, '한 행 때문에 표 전체를 잃지 않는다')
    assert.equal(loaded.body.session.mapping[0].tags.length, 18)
    const sent = await upload(origin, admin)(FILES[0], { importId: 'IMP-LEGACY' })
    assert.equal(sent.status, 201, JSON.stringify(sent.body))
    assert.equal(sent.body.document.projectId, 'PRJ-CONTRACT')
    assert.equal(sent.body.document.visibility, 'restricted', '읽지 못한 표가 전 직원 공개로 번역되지 않는다')
    assert.equal(sent.body.document.tags.length, 20, '예약 태그 두 칸을 더해도 문서 상한 안이다')
  })
})

test('9-11. 같은 묶음의 기준은 목적지별로 나뉜다 — 한 프로젝트에 같은 파일을 두 벌 올리지 않는다', async () => {
  /**
   * 지문 하나로만 색인하면 **다른 프로젝트로 갈 파일이 기준 자리를 차지한다.** 그러면 같은 프로젝트로
   * 갈 두 사본이 서로를 못 보고 둘 다 올라간다(같은 자료가 그 프로젝트에 두 벌). 목적지별로 나눠 두면
   * 첫 사본이 그 프로젝트의 기준이 되고 두 번째는 닫힌다 — 그리고 다른 프로젝트의 사본은 그대로 올라간다.
   */
  const COPIES = [
    { path: 'Flow/계약/공용양식.pdf', body: '두 프로젝트가 함께 쓰는 양식' },
    { path: 'Flow/설계/공용양식.pdf', body: '두 프로젝트가 함께 쓰는 양식' },
    { path: 'Flow/설계/공용양식_사본.pdf', body: '두 프로젝트가 함께 쓰는 양식' },
  ]
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const call = api(origin, admin)
    const created = await call('POST', '/api/bulk-imports', { name: '공용 양식', mapping: [
      { folderPrefix: 'Flow/계약', projectId: 'PRJ-CONTRACT', tags: [], aiLevel: 'locked' },
      { folderPrefix: 'Flow/설계', projectId: 'PRJ-DESIGN', tags: [], aiLevel: 'locked' },
    ] })
    const id = created.body.session.id
    const manifest = await call('POST', `/api/bulk-imports/${id}/manifest`, { clientRequestId: 'shared-1', pageIndex: 0, entries: COPIES.map(manifestEntry) })
    assert.deepEqual(manifest.body.verdicts.map((entry) => entry.status), ['pending', 'pending', 'duplicate'])
    assert.equal(manifest.body.verdicts[2].duplicateOfPath, 'Flow/설계/공용양식.pdf', '같은 프로젝트의 먼저 올라갈 파일이 기준이다')

    await call('PATCH', `/api/bulk-imports/${id}`, { status: 'uploading' })
    const send = upload(origin, admin)
    for (const file of [COPIES[0], COPIES[1]]) assert.equal((await send(file, { importId: id })).status, 201)
    const documents = store.tenants[TENANT]['company-documents'].data
    assert.equal(documents.filter((document) => document.projectId === 'PRJ-DESIGN').length, 1, '한 프로젝트에 같은 자료가 두 벌 생기지 않는다')
    assert.equal(documents.filter((document) => document.projectId === 'PRJ-CONTRACT').length, 1, '다른 프로젝트의 사본은 그대로 올라간다')
  })
})

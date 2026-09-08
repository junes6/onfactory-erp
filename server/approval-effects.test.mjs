import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { createApp } from './app.mjs'
import { getTenantDocument } from './document-storage-service.mjs'
import { NOTIFICATION_TYPE_IDS } from './notifications.mjs'
import { buildTaxEvidenceArchive, resolveEvidencePeriod, selectTaxEvidence } from './tax-evidence-export.mjs'
import { withServer } from './test-server.mjs'

/**
 * **승인 한 번의 부수효과** — 이 절에서 가장 중요한 파일.
 *
 * 최종 승인은 세 가지를 한꺼번에 한다: 결재 문서를 '승인'으로 바꾸고, 세무 증빙 파일을 만들어
 * 자료실에 얹고, 금액을 그 달에 게시한다. 세 가지가 **한 커밋**에 들어가지 않으면 다음이 일어난다.
 *
 * - 태그만 붙고 파일이 없으면, 그 기간의 세무사 전달 **전체**가 410 TAX_EVIDENCE_FILE_MISSING 으로
 *   막힌다. 한 건이 아니라 묶음 전체다. 그래서 시험 2는 태그를 세는 데서 멈추지 않고 실제로
 *   `buildTaxEvidenceArchive` 를 돌려 원본 바이트가 있는지까지 확인한다.
 * - 자료 목록만 커밋되고 결재 문서가 되돌아가면, 아무도 승인하지 않은 결재의 증빙이 세무 자료에 남는다.
 * - 되돌리기가 테넌트 객체 통째면 같은 커밋에 실린 결재 문서 키가 함께 사라진다(시험 6).
 *
 * 시계는 주입한다. 증빙의 tax-date·게시의 month 가 '오늘'에서 나오므로 벽시계로 재면
 * 월말 자정에만 빨개지는 시험이 된다.
 */

const TENANT = 'TENANT-SUNSEA'
const ADMIN = { id: 'USR-SUNSEA-ADMIN', name: '김서원', email: 'admin@sunsea.co.kr' }
const OH = { id: 'USR-SUNSEA-OH', name: '오태식', email: 'taesik.oh@sunsea.co.kr' }
const SEO = { id: 'USR-SUNSEA-SEO', name: '서동현', email: 'donghyun.seo@sunsea.co.kr' }
const YOON = { id: 'USR-SUNSEA-YOON', name: '윤서진', email: 'seojin.yoon@sunsea.co.kr' }
const LEE = { id: 'USR-SUNSEA-LEE', name: '이정민', email: 'jungmin.lee@sunsea.co.kr' }

const NOW = '2026-09-03T01:00:00.000Z'   // KST 2026-09-03 10:00
const SPENT_ON = '2026-09-02'

const readJson = async (response) => { const text = await response.text(); try { return JSON.parse(text) } catch { return { raw: text } } }

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

const libraryDocument = (id, name, tags = []) => ({
  id, tenantId: TENANT, name, originalName: name, mime: 'application/pdf', size: 12, checksum: `sha-${id}`,
  category: '공통자료', visibility: 'all', departments: [], allowedUserIds: [], tags, summary: '',
  uploadedAt: '2026-09-01T00:00:00.000Z', uploadedById: ADMIN.id, uploadedByName: ADMIN.name, storage: 'local',
})

const freshStore = (tenant = {}) => ({
  version: 2,
  tenants: { [TENANT]: tenant },
  platform: {}, accountApprovals: {}, accountCredentials: {}, invitedAccounts: [], passwordResetRequests: [],
})

async function login(origin, email) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: 'tenant', email, password: 'demo1234' }),
  })
  const body = await readJson(response)
  assert.equal(response.status, 200, `${email}: ${JSON.stringify(body)}`)
  const account = body.account
  return { account, headers: { 'content-type': 'application/json', cookie: response.headers.get('set-cookie') ?? '', 'x-workspace-identity': `${account.tenantId}:${account.id}` } }
}

const api = (origin, session) => async (method, route, body) => {
  const response = await fetch(`${origin}${route}`, { method, headers: session.headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return { status: response.status, body: await readJson(response) }
}

/** 증빙 분류와 금액 집계 항목을 **둘 다** 가진 양식. 부수효과 두 갈래가 함께 도는 유일한 모양이다. */
const form = ({ evidenceCategory = '경비', amountFieldKey = 'amount' } = {}) => ({
  name: '지출결의서', kind: '지출결의',
  fields: [
    { key: 'spent_on', label: '지출일', type: 'date', required: true },
    { key: 'vendor', label: '거래처', type: 'text', required: true },
    { key: 'amount', label: '금액', type: 'money', required: true },
    { key: 'receipt', label: '영수증', type: 'attachment', required: false },
  ],
  defaultLine: [], ccIds: [], amountFieldKey, evidenceCategory,
})

const documentsIn = (store) => (store.tenants[TENANT]['company-documents']?.data ?? [])
const evidenceRows = (store) => documentsIn(store).filter((row) => Array.isArray(row?.tags) && row.tags.includes('tax-evidence'))
const notificationsFor = (store, recipientId) => (store.tenants[TENANT].notifications?.data ?? []).filter((row) => row?.recipientId === recipientId)

/**
 * 기안 → 상신 → (line 순서대로) 결재. 마지막 결재의 응답을 돌려준다.
 * 시험마다 같은 여섯 줄을 다시 쓰지 않으려는 것이지, 판정을 감추려는 것이 아니다 —
 * 각 시험은 돌려받은 응답과 store 를 직접 읽어 자기 사실을 확인한다.
 */
async function runApproval(origin, { formInput, values, attachments = [], ccIds = [], approvers = [SEO], decision = 'approve', reason }) {
  const admin = await login(origin, ADMIN.email)
  const drafter = await login(origin, OH.email)
  const created = await api(origin, admin)('POST', '/api/approval-forms', formInput)
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const drafted = await api(origin, drafter)('POST', '/api/approval-documents', {
    formId: created.body.form.id, title: '9월 원부자재 대금', values, attachments, ccIds,
    line: approvers.map((approver) => ({ mode: 'sequential', approvers: [approver.id] })), submit: true,
  })
  assert.equal(drafted.status, 201, JSON.stringify(drafted.body))
  const id = drafted.body.document.id
  let last = null
  for (const [index, approver] of approvers.entries()) {
    const session = await login(origin, approver.email)
    const isLast = index === approvers.length - 1
    last = await api(origin, session)('POST', `/api/approval-documents/${id}/decide`, {
      decision: isLast ? decision : 'approve', ...(isLast && reason ? { reason } : {}),
    })
    assert.equal(last.status, 200, JSON.stringify(last.body))
  }
  return { id, formId: created.body.form.id, drafter, last }
}

const buildApp = (store, storage, extra = {}) => createApp({
  apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {},
  documentStorage: storage, approvalClock: () => new Date(NOW), ...extra,
})

test('1. 최종 승인이 증빙 1건을 남기고 그 원본 바이트가 실제로 저장소에 있다 — 세무사 전달이 통째로 막히지 않는다', async () => {
  const store = freshStore()
  const storage = memoryStorage()
  await withServer(buildApp(store, storage), async (origin) => {
    const { last } = await runApproval(origin, {
      formInput: form(), values: { spent_on: SPENT_ON, vendor: '동해수산', amount: 1_240_000 },
    })
    assert.equal(last.body.document.status, '승인')

    // (1) 태그에 'tax-evidence'가 든 행이 정확히 1건.
    const evidence = evidenceRows(store)
    assert.equal(evidence.length, 1, `증빙 행이 ${evidence.length}건이다`)
    assert.equal(evidence[0].id, last.body.effects.evidenceId)
    assert.equal(evidence[0].category, '세무·회계')
    assert.equal(evidence[0].visibility, 'restricted')
    assert.deepEqual(evidence[0].allowedUserIds.sort(), [OH.id, SEO.id].sort(), '기안자와 결재자만 연다')
    assert.ok(evidence[0].tags.includes(`tax-bucket:경비`))
    assert.ok(evidence[0].tags.includes(`tax-date:${SPENT_ON}`), '귀속일은 양식의 첫 날짜 항목에서 온다')
    assert.ok(evidence[0].tags.includes('tax-year:2026'))
    assert.ok(evidence[0].tags.includes(`approval:${last.body.document.id}`))

    // (2) 태그만 붙이고 파일이 없으면 그 기간의 전달 전체가 410으로 막힌다. 실제로 묶어 본다.
    const period = resolveEvidencePeriod({ year: 2026 })
    const selected = selectTaxEvidence(documentsIn(store), period)
    assert.equal(selected.length, 1)
    const archive = await buildTaxEvidenceArchive({
      year: 2026, documents: documentsIn(store),
      getDocument: (document) => getTenantDocument(storage, document, TENANT),
      preparedAt: NOW, preparedBy: ADMIN.name,
    })
    assert.equal(archive.fileCount, 1)
    assert.ok(archive.totalBytes > 0, '증빙 본문이 비어 있다')

    // (3) 저장된 checksum 과 실제 바이트의 해시가 같다(409 CHECKSUM_MISMATCH 가 나지 않는다).
    const bytes = await getTenantDocument(storage, evidence[0], TENANT)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), evidence[0].checksum)
    assert.equal(evidence[0].size, bytes.length)
    // 증빙 본문은 결재 내용을 그대로 담는다 — 세무사에게 가는 것이 이 마크다운이다.
    const body = bytes.toString('utf8')
    assert.ok(body.includes('1,240,000원'))
    assert.ok(body.includes('동해수산'))
    assert.ok(body.includes('서동현'))

    // (4) 금액 게시.
    const posting = last.body.effects.posting
    assert.equal(posting.month, '2026-09')
    assert.equal(posting.amount, 1_240_000)
    assert.equal(posting.currency, 'KRW')
    assert.equal(posting.fieldKey, 'amount')
    assert.equal(store.tenants[TENANT]['approval-documents'].data[0].posting.amount, 1_240_000, '게시는 문서에도 남아야 집계가 읽는다')
  })
})

test('2. 증빙 분류가 없는 양식은 증빙을 만들지 않고 게시만 한다', async () => {
  const store = freshStore()
  const storage = memoryStorage()
  await withServer(buildApp(store, storage), async (origin) => {
    const { last } = await runApproval(origin, {
      formInput: form({ evidenceCategory: null }), values: { spent_on: SPENT_ON, vendor: '동해수산', amount: 500_000 },
    })
    assert.equal(evidenceRows(store).length, 0)
    assert.equal(last.body.effects.evidenceId, undefined)
    assert.equal(storage.files.size, 0, '증빙을 만들지 않았는데 저장소에 바이트가 남았다')
    assert.equal(last.body.effects.posting.amount, 500_000)
  })
})

test('3. 금액 집계 항목이 없는 양식은 게시하지 않고 증빙만 만든다', async () => {
  const store = freshStore()
  const storage = memoryStorage()
  await withServer(buildApp(store, storage), async (origin) => {
    const { last } = await runApproval(origin, {
      formInput: form({ amountFieldKey: null }), values: { spent_on: SPENT_ON, vendor: '동해수산', amount: 700_000 },
    })
    assert.equal(evidenceRows(store).length, 1)
    assert.equal(last.body.effects.posting, undefined)
    assert.equal(last.body.document.posting, null, '가짜 0원 게시를 만들지 않는다')
    // 게시가 없으면 집계에도 잡히지 않는다.
    const admin = await login(origin, ADMIN.email)
    const postings = await api(origin, admin)('GET', '/api/approval-documents/postings')
    assert.equal(postings.body.months.at(-1).amount, 0)
    assert.equal(postings.body.months.at(-1).count, 0)
  })
})

test('4. 승인된 문서에 다시 결재하면 409이고 증빙도 게시도 늘지 않는다', async () => {
  const store = freshStore()
  const storage = memoryStorage()
  await withServer(buildApp(store, storage), async (origin) => {
    const { id } = await runApproval(origin, {
      formInput: form(), values: { spent_on: SPENT_ON, vendor: '동해수산', amount: 1_000_000 },
    })
    const before = { evidence: evidenceRows(store).length, files: storage.files.size, documents: documentsIn(store).length }
    const approver = await login(origin, SEO.email)
    const again = await api(origin, approver)('POST', `/api/approval-documents/${id}/decide`, { decision: 'approve' })
    assert.equal(again.status, 409)
    assert.equal(again.body.error.code, 'APPROVAL_ALREADY_DECIDED')
    assert.equal(evidenceRows(store).length, before.evidence)
    assert.equal(storage.files.size, before.files)
    assert.equal(documentsIn(store).length, before.documents)
    // 관리자가 눌러도 같다 — 권한이 아니라 문서의 상태가 막는다.
    const admin = await login(origin, ADMIN.email)
    assert.equal((await api(origin, admin)('POST', `/api/approval-documents/${id}/decide`, { decision: 'approve' })).status, 409)
    assert.equal(evidenceRows(store).length, before.evidence)
  })
})

test('5. 태그가 17개인 첨부에는 증빙 태그를 붙이지 않고 건너뛰며, 그 사실이 이력에 남는다', async () => {
  const crowded = Array.from({ length: 17 }, (_value, index) => `tag-${index}`)
  const store = freshStore({
    'company-documents': {
      data: [libraryDocument('DOC-CROWDED', '태그 가득한 영수증.pdf', crowded), libraryDocument('DOC-ROOMY', '여유 있는 견적서.pdf', ['quote'])],
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
  })
  const storage = memoryStorage()
  await withServer(buildApp(store, storage), async (origin) => {
    const { last } = await runApproval(origin, {
      formInput: form(),
      values: { spent_on: SPENT_ON, vendor: '동해수산', amount: 300_000, receipt: 'DOC-CROWDED' },
      attachments: ['DOC-ROOMY'],
    })
    const crowdedRow = documentsIn(store).find((row) => row.id === 'DOC-CROWDED')
    const roomyRow = documentsIn(store).find((row) => row.id === 'DOC-ROOMY')
    // 자르지 않고 건너뛴다. 17 + 4 = 21 은 상한 20을 넘는다.
    assert.equal(crowdedRow.tags.length, 17)
    assert.ok(!crowdedRow.tags.includes('tax-evidence'))
    // 대조군이 없으면 '아무것도 안 붙이는' 구현과 구분되지 않는다.
    assert.equal(roomyRow.tags.length, 5)
    assert.ok(roomyRow.tags.includes('tax-evidence'))
    assert.ok(roomyRow.tags.includes(`tax-date:${SPENT_ON}`))
    assert.equal(last.body.effects.evidenceTaggedAttachments, 1)

    const warning = last.body.document.history.find((entry) => entry.action === '증빙 경고')
    assert.ok(warning, '태그 상한으로 건너뛴 사실이 이력에 없다 — 사용자는 「첨부가 증빙함에 안 보인다」만 겪는다')
    assert.ok(warning.comment.includes('태그 가득한 영수증.pdf'))
    // 조사는 값에 따라 갈린다(받침이 없는 '…png'·'…jpg' 로 끝나는 이름이 실제로 온다). 이 저장소의
    // 관례대로 `은(는)` 으로 적는다 — 이 문장은 결재 이력에 영구히 남는다.
    assert.ok(warning.comment.includes('은(는)'), `값에 따라 갈리는 조사를 한쪽으로 못 박았다 — ${warning.comment}`)
    // 「첨부」 항목 값과 첨부 배열을 같은 잣대로 본다: 증빙은 그래도 1건 만들어졌다.
    assert.equal(evidenceRows(store).filter((row) => row.category === '세무·회계').length, 1)
  })
})

test('6. 커밋이 실패하면 결재 문서와 자료 목록이 함께 되돌아가고, 저장소에 쓴 증빙 파일도 지워진다', async () => {
  const store = freshStore({
    'company-documents': { data: [libraryDocument('DOC-KEEP', '기존 자료.pdf')], updatedAt: '2026-09-01T00:00:00.000Z' },
  })
  const storage = memoryStorage()
  let failCommit = false
  await withServer(buildApp(store, storage, { onWorkspaceStoreChange: () => { if (failCommit) throw new Error('디스크가 꽉 찼다') } }), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const drafter = await login(origin, OH.email)
    const approver = await login(origin, SEO.email)
    const created = await api(origin, admin)('POST', '/api/approval-forms', form())
    const drafted = await api(origin, drafter)('POST', '/api/approval-documents', {
      formId: created.body.form.id, title: '커밋 실패 시험', values: { spent_on: SPENT_ON, vendor: '동해수산', amount: 800_000 },
      line: [{ mode: 'sequential', approvers: [SEO.id] }], submit: true,
    })
    assert.equal(drafted.status, 201, JSON.stringify(drafted.body))

    const documentsBefore = store.tenants[TENANT]['company-documents']
    const approvalsBefore = store.tenants[TENANT]['approval-documents']
    const filesBefore = storage.files.size
    assert.ok(approvalsBefore, '되돌리기를 재려면 이전 값이 있어야 한다')

    failCommit = true
    const failed = await api(origin, approver)('POST', `/api/approval-documents/${drafted.body.document.id}/decide`, { decision: 'approve' })
    failCommit = false
    assert.equal(failed.status, 500, JSON.stringify(failed.body))
    assert.equal(failed.body.error.code, 'APPROVAL_WRITE_FAILED')

    // (9) 두 키가 **둘 다** 이전 값 그대로다 — 객체 참조까지 같아야 '되돌렸다'가 참이다.
    assert.equal(store.tenants[TENANT]['company-documents'], documentsBefore)
    assert.equal(store.tenants[TENANT]['approval-documents'], approvalsBefore)
    assert.equal(documentsIn(store).length, 1)
    assert.equal(evidenceRows(store).length, 0)
    assert.equal(store.tenants[TENANT]['approval-documents'].data[0].status, '결재중')

    // (10) 자료 목록의 롤백이 결재 문서 키를 지우지 않는다(키 단위 롤백이라는 것을 값으로 확인).
    assert.notEqual(store.tenants[TENANT]['approval-documents'], undefined, '자료 목록 롤백이 결재 키를 통째로 날렸다')

    // (11) 저장소에 쓴 증빙 바이트가 best-effort 로 지워졌다 — 커밋되지 않은 파일은 고아다.
    assert.equal(storage.files.size, filesBefore, '커밋이 실패했는데 증빙 파일이 저장소에 남았다')

    // 다시 눌러 보면 이번에는 통과한다. 실패가 문서를 잠그지 않는다.
    const retried = await api(origin, approver)('POST', `/api/approval-documents/${drafted.body.document.id}/decide`, { decision: 'approve' })
    assert.equal(retried.status, 200, JSON.stringify(retried.body))
    assert.equal(evidenceRows(store).length, 1)
  })
})

test('7. 알림은 다음 단계 결재자에게만 가고, 반려는 기안자에게 간다 — 새 알림 유형은 만들지 않았다', async () => {
  const store = freshStore()
  const storage = memoryStorage()
  await withServer(buildApp(store, storage), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const drafter = await login(origin, OH.email)
    const first = await login(origin, SEO.email)
    const created = await api(origin, admin)('POST', '/api/approval-forms', form())
    const drafted = await api(origin, drafter)('POST', '/api/approval-documents', {
      formId: created.body.form.id, title: '알림 시험', values: { spent_on: SPENT_ON, vendor: '동해수산', amount: 90_000 },
      line: [{ mode: 'sequential', approvers: [SEO.id] }, { mode: 'sequential', approvers: [YOON.id] }],
      ccIds: [LEE.id], submit: true,
    })
    const id = drafted.body.document.id
    // 상신은 1단계 결재자에게만 알린다.
    assert.equal(notificationsFor(store, SEO.id).length, 1)
    assert.equal(notificationsFor(store, YOON.id).length, 0, '아직 차례가 아닌 사람에게 미리 알리지 않는다')

    const step1 = await api(origin, first)('POST', `/api/approval-documents/${id}/decide`, { decision: 'approve' })
    assert.equal(step1.status, 200, JSON.stringify(step1.body))

    // (12) 다음 단계 결재자에게만. 참조자·기안자에게는 가지 않는다.
    const toSecond = notificationsFor(store, YOON.id)
    assert.equal(toSecond.length, 1)
    assert.equal(toSecond[0].type, 'approval-requested')
    assert.equal(toSecond[0].page, 'approvals')
    assert.equal(toSecond[0].focusId, id)
    assert.equal(toSecond[0].source.kind, 'approval-document')
    assert.equal(notificationsFor(store, LEE.id).length, 0, '참조자는 열람만 한다 — 알림은 할 일이 있는 사람에게만 간다')
    assert.equal(notificationsFor(store, OH.id).length, 0)
    assert.equal(notificationsFor(store, SEO.id).length, 1, '이미 결재한 사람에게 다시 알리지 않는다')

    // (13) 반려는 기안자에게 changes-requested 한 건.
    const second = await login(origin, YOON.email)
    const rejected = await api(origin, second)('POST', `/api/approval-documents/${id}/decide`, { decision: 'reject', reason: '금액 근거를 붙여 주세요.' })
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body))
    const toDrafter = notificationsFor(store, OH.id)
    assert.equal(toDrafter.length, 1)
    assert.equal(toDrafter[0].type, 'changes-requested')
    assert.equal(toDrafter[0].page, 'approvals')
    assert.ok(toDrafter[0].body.includes('금액 근거'))
    assert.equal(evidenceRows(store).length, 0, '반려에는 증빙도 게시도 없다')
    assert.equal(rejected.body.document.posting, null)

    /**
     * 알림 유형은 **한 개도 늘지 않았다**. 새 유형을 더하면 구버전 서버로 롤백했을 때
     * normalizeNotifications 가 그 테넌트의 알림을 통째로 무효화한다 — 결재 알림 하나 때문에
     * 그 회사의 모든 알림이 사라진다. 숫자는 돌아가는 코드에 대고 잰 값이고,
     * 유형을 늘리려면 이 줄을 함께 고치면서 롤백 영향을 다시 생각하게 된다.
     */
    assert.equal(NOTIFICATION_TYPE_IDS.length, 14)
    assert.deepEqual(NOTIFICATION_TYPE_IDS.filter((type) => type.startsWith('approval')), ['approval-requested'])
  })
})

test('8. 최종 승인은 알림 없이도 기안자에게 닿는다 — 「내가 올린 것」의 점 하나로', async () => {
  const store = freshStore()
  const storage = memoryStorage()
  await withServer(buildApp(store, storage), async (origin) => {
    const seenAt = '2026-09-03T00:00:00.000Z'   // 승인(NOW) 직전
    const { drafter } = await runApproval(origin, {
      formInput: form(), values: { spent_on: SPENT_ON, vendor: '동해수산', amount: 120_000 },
    })
    // (14) 최종 승인 알림을 만들지 않는 대신, 기안자가 그 사실을 알 길이 실제로 있다.
    const summary = await api(origin, drafter)('GET', `/api/approval-documents/summary?seenAt=${encodeURIComponent(seenAt)}`)
    assert.equal(summary.status, 200, JSON.stringify(summary.body))
    assert.ok(summary.body.decidedUnread >= 1, '승인이 끝났는데 기안자에게 아무 표시도 남지 않는다')
    assert.equal(notificationsFor(store, OH.id).length, 0, '최종 승인에 새 알림 유형을 만들지 않는다')
    const afterSeen = await api(origin, drafter)('GET', `/api/approval-documents/summary?seenAt=${encodeURIComponent('2026-09-04T00:00:00.000Z')}`)
    assert.equal(afterSeen.body.decidedUnread, 0)
  })
})

test('9. 「첨부」 항목으로 붙인 파일도 증빙 태그를 받고, 그 파일 이름이 증빙 본문에 적힌다', async () => {
  const store = freshStore({
    'company-documents': { data: [libraryDocument('DOC-RECEIPT-01', '영수증-2026-09-02.pdf')], updatedAt: '2026-09-01T00:00:00.000Z' },
  })
  const storage = memoryStorage()
  await withServer(buildApp(store, storage), async (origin) => {
    const { last } = await runApproval(origin, {
      formInput: form(),
      // 첨부 배열은 비운다. 씨앗 지출결의서의 「영수증」은 이 갈래로 붙는다.
      values: { spent_on: SPENT_ON, vendor: '동해수산', amount: 1_240_000, receipt: 'DOC-RECEIPT-01' },
    })
    assert.equal(last.body.effects.evidenceTaggedAttachments, 1, '항목으로 붙인 첨부를 세지 않았다')
    const receipt = documentsIn(store).find((row) => row.id === 'DOC-RECEIPT-01')
    assert.ok(receipt.tags.includes('tax-evidence'), '첨부에 세무 태그가 붙지 않았다')

    // 태그는 붙었는데 이름이 본문에 없으면, 같은 파일을 두고 ZIP 과 증빙 본문이 다른 사실을 말한다.
    const evidence = documentsIn(store).find((row) => row.id === last.body.effects.evidenceId)
    const body = (await getTenantDocument(storage, evidence, TENANT)).toString('utf8')
    assert.ok(body.includes('## 첨부'), `증빙 본문에 첨부 절이 없다\n${body}`)
    assert.ok(body.includes('영수증-2026-09-02.pdf'), `증빙 본문에 첨부 파일 이름이 없다\n${body}`)
  })
})

/** put 이 끝날 때까지 승인을 붙잡아 두는 저장소. 「읽은 뒤 늦게 쓰는 창」을 시계 없이 정확히 연다. */
function gatedStorage() {
  const base = memoryStorage()
  let open
  let entered
  const gate = new Promise((resolve) => { open = resolve })
  const putEntered = new Promise((resolve) => { entered = resolve })
  return { ...base, putEntered, open: () => open(), async put(key, body) { entered(); await gate; return base.put(key, body) } }
}

test('10. 증빙 파일을 쓰는 동안 확정된 다른 쓰기가 사라지지 않는다 — 읽은 배열로 늦게 덮어쓰지 않는다', async () => {
  const store = freshStore({
    'company-documents': { data: [libraryDocument('DOC-RENAME-01', '원래이름.pdf')], updatedAt: '2026-09-01T00:00:00.000Z' },
  })
  const storage = gatedStorage()
  await withServer(buildApp(store, storage), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const drafter = await login(origin, OH.email)
    const approver = await login(origin, SEO.email)
    const other = await login(origin, LEE.email)
    const created = await api(origin, admin)('POST', '/api/approval-forms', form())
    const formId = created.body.form.id
    const drafted = await api(origin, drafter)('POST', '/api/approval-documents', {
      formId, title: '승인될 문서', values: { spent_on: SPENT_ON, vendor: '동해수산', amount: 1_000 },
      line: [{ mode: 'sequential', approvers: [SEO.id] }], submit: true,
    })
    assert.equal(drafted.status, 201, JSON.stringify(drafted.body))

    // 승인을 증빙 파일 쓰기 한가운데에 세워 둔다.
    const deciding = api(origin, approver)('POST', `/api/approval-documents/${drafted.body.document.id}/decide`, { decision: 'approve' })
    await storage.putEntered

    // 그 창 안에서 두 쓰기가 200/201 로 확정된다. 확정된 쓰기는 확정된 채로 남아야 한다.
    const renamed = await api(origin, admin)('PATCH', '/api/documents/DOC-RENAME-01', { name: '바뀐이름.pdf' })
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body))
    const late = await api(origin, other)('POST', '/api/approval-documents', {
      formId, title: '창 안에서 올린 기안', values: { spent_on: SPENT_ON, vendor: '남해수산', amount: 2_000 },
    })
    assert.equal(late.status, 201, JSON.stringify(late.body))

    storage.open()
    const decided = await deciding
    assert.equal(decided.status, 200, JSON.stringify(decided.body))
    assert.equal(decided.body.document.status, '승인')

    assert.equal(documentsIn(store).find((row) => row.id === 'DOC-RENAME-01')?.name, '바뀐이름.pdf', '200 으로 답한 이름 변경이 조용히 되돌아갔다')
    const rows = store.tenants[TENANT]['approval-documents'].data
    assert.ok(rows.some((row) => row.id === late.body.document.id), '201 로 답한 기안이 승인 커밋에 지워졌다')
    assert.equal(rows.find((row) => row.id === drafted.body.document.id).status, '승인')
    assert.equal(evidenceRows(store).length, 1)
  })
})

/**
 * 「무엇이 첨부인가」의 답은 **하나**다 — 쓰기 때 forbiddenAttachment 를 지나 저장된 linkedAttachmentIds.
 *
 * 증빙 태그·증빙 본문·인쇄물이 그 배열 대신 「그때의 양식」으로 다시 계산하면, 관리자가 항목 하나의
 * 타입을 바꾸는 것만으로 두 답이 갈린다. 그 순간 셋이 함께 일어난다: 권한 검사를 한 번도 지나지
 * 않은 자료의 이름이 증빙 마크다운과 인쇄물에 실리고(세무사에게 나간다), 그 자료에 tax-evidence
 * 태그가 붙어 전달 묶음에 섞이고, 태그가 붙었는데도 삭제 잠금은 옛 값을 보므로 잠기지 않는다.
 */
test('11. 양식 항목의 타입이 바뀌어도 증빙·인쇄는 쓰기 때 검사한 집합만 읽는다', async () => {
  const secret = {
    ...libraryDocument('DOC-SECRET-9', '임원급여대장.pdf'),
    uploadedById: ADMIN.id, visibility: 'restricted', allowedUserIds: [ADMIN.id],
  }
  const store = freshStore({ 'company-documents': { data: [secret], updatedAt: '2026-09-01T00:00:00.000Z' } })
  const storage = memoryStorage()
  await withServer(buildApp(store, storage), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const drafter = await login(origin, OH.email)
    const approver = await login(origin, SEO.email)

    // memo 는 **자유 text** 다. 기안자는 남의 자료 id 를 그냥 적을 수 있고, 그것은 첨부가 아니다.
    const created = await api(origin, admin)('POST', '/api/approval-forms', {
      name: '항목 타입 뒤집기', kind: '지출결의',
      fields: [
        { key: 'spent_on', label: '지출일', type: 'date', required: true },
        { key: 'amount', label: '금액', type: 'money', required: true },
        { key: 'memo', label: '메모', type: 'text', required: false },
      ],
      defaultLine: [], ccIds: [], amountFieldKey: 'amount', evidenceCategory: '경비',
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const form = created.body.form

    const drafted = await api(origin, drafter)('POST', '/api/approval-documents', {
      formId: form.id, title: '메모에 남의 자료 id', values: { spent_on: SPENT_ON, amount: 1_000, memo: 'DOC-SECRET-9' },
      line: [{ mode: 'sequential', approvers: [SEO.id] }], submit: true,
    })
    assert.equal(drafted.status, 201, JSON.stringify(drafted.body))
    assert.deepEqual(drafted.body.document.linkedAttachmentIds, [], 'text 칸은 첨부가 아니다 — 이 시험의 전제')
    const id = drafted.body.document.id

    // 관리자가 그 항목을 「첨부」로 바꾼다. 이미 돌고 있는 문서의 값은 그대로다.
    const patched = await api(origin, admin)('PATCH', `/api/approval-forms/${form.id}`, {
      ...form, version: form.version,
      fields: form.fields.map((field) => (field.key === 'memo' ? { ...field, type: 'attachment' } : field)),
    })
    assert.equal(patched.status, 200, JSON.stringify(patched.body))
    assert.equal(patched.body.form.fields.find((field) => field.key === 'memo').type, 'attachment')

    const decided = await api(origin, approver)('POST', `/api/approval-documents/${id}/decide`, { decision: 'approve' })
    assert.equal(decided.status, 200, JSON.stringify(decided.body))
    assert.equal(decided.body.document.status, '승인')

    // (a) 세무 태그가 붙지 않았다 — 붙었다면 세무사 전달 ZIP 에 원본 바이트째로 실려 나간다.
    const secretRow = documentsIn(store).find((row) => row.id === 'DOC-SECRET-9')
    assert.deepEqual(secretRow.tags, [], `검사받지 않은 자료에 세무 태그가 붙었다 — ${JSON.stringify(secretRow.tags)}`)
    assert.equal(decided.body.effects.evidenceTaggedAttachments, 0)
    assert.equal(selectTaxEvidence(documentsIn(store), resolveEvidencePeriod({ year: '2026' })).length, 1, '증빙 묶음에 남의 자료가 섞였다')

    // (b) 증빙 마크다운에도 (c) 인쇄물에도 그 파일 이름이 없다. 둘 다 회사 밖으로 나가는 종이다.
    const evidence = documentsIn(store).find((row) => row.id === decided.body.effects.evidenceId)
    const body = (await getTenantDocument(storage, evidence, TENANT)).toString('utf8')
    assert.ok(!body.includes('임원급여대장.pdf'), `증빙 본문에 열람 권한 없는 자료의 이름이 실렸다\n${body}`)
    const printed = await fetch(`${origin}/api/approval-documents/${id}/print`, { headers: drafter.headers })
    assert.equal(printed.status, 200)
    assert.ok(!(await printed.text()).includes('임원급여대장.pdf'), '인쇄물에 열람 권한 없는 자료의 이름이 실렸다')

    // (d) 태그가 붙지 않았으므로 잠금도 없다 — 셋이 같은 배열을 읽는다는 사실을 삭제로 확인한다.
    assert.equal((await api(origin, admin)('DELETE', '/api/documents/DOC-SECRET-9')).status, 200)
  })
})

test('12. 반대로 항목을 양식에서 빼도 잠긴 자료는 인쇄물에 그대로 보인다 — 409 문구가 참이다', async () => {
  const store = freshStore({
    'company-documents': { data: [libraryDocument('DOC-RECEIPT-77', '9월 영수증.pdf')], updatedAt: '2026-09-01T00:00:00.000Z' },
  })
  await withServer(buildApp(store, memoryStorage()), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const drafter = await login(origin, OH.email)
    const created = await api(origin, admin)('POST', '/api/approval-forms', form())
    const formInput = created.body.form
    const drafted = await api(origin, drafter)('POST', '/api/approval-documents', {
      formId: formInput.id, title: '영수증 붙인 기안',
      values: { spent_on: SPENT_ON, vendor: '동해수산', amount: 1_000, receipt: 'DOC-RECEIPT-77' },
    })
    assert.equal(drafted.status, 201, JSON.stringify(drafted.body))

    const patched = await api(origin, admin)('PATCH', `/api/approval-forms/${formInput.id}`, {
      ...formInput, version: formInput.version, fields: formInput.fields.filter((field) => field.key !== 'receipt'),
    })
    assert.equal(patched.status, 200, JSON.stringify(patched.body))

    // 「해당 화면에서 먼저 연결을 해제한 뒤 삭제해 주세요」가 참이려면 그 연결이 화면에 보여야 한다.
    const blocked = await api(origin, admin)('DELETE', '/api/documents/DOC-RECEIPT-77')
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body))
    assert.equal(blocked.body.error.code, 'DOCUMENT_IN_USE')
    const printed = await fetch(`${origin}/api/approval-documents/${drafted.body.document.id}/print`, { headers: drafter.headers })
    assert.ok((await printed.text()).includes('9월 영수증.pdf'), '잠겨 있는데 인쇄물 어디에도 그 연결이 보이지 않는다')
  })
})

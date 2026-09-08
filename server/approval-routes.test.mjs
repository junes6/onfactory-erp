import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import test from 'node:test'

import { createApp } from './app.mjs'
// 상한은 순수 모듈이 정본이다. 시험이 숫자를 다시 적으면 상한이 바뀔 때 시험만 조용히 낡는다.
import { MAX_DOCUMENTS_PER_TENANT, MAX_FORMS_PER_TENANT } from './approval-routing.mjs'
import { withServer } from './test-server.mjs'

/**
 * 양식형 전자결재 — HTTP 계약.
 *
 * 이 파일이 잠그는 것은 「누가 무엇을 볼 수 있고 무엇을 할 수 있는가」다. 결재선을 도는 규칙 자체는
 * approval-routing.test.mjs 가 값으로 재고, 승인 한 번의 부수효과는 approval-effects.test.mjs 가 잰다.
 *
 * 시계는 전부 주입한다(approvalClock). 대결 기간은 '오늘'을 읽어 판정하므로, 벽시계로 재면
 * 자정을 넘긴 밤에만 빨개지는 시험이 된다.
 */

const TENANT = 'TENANT-SUNSEA'
const ADMIN = { id: 'USR-SUNSEA-ADMIN', name: '김서원', email: 'admin@sunsea.co.kr' }
const OH = { id: 'USR-SUNSEA-OH', name: '오태식', email: 'taesik.oh@sunsea.co.kr' }
const PARK = { id: 'USR-SUNSEA-PARK', name: '박지현', email: 'jihyun.park@sunsea.co.kr' }
const SEO = { id: 'USR-SUNSEA-SEO', name: '서동현', email: 'donghyun.seo@sunsea.co.kr' }
const YOON = { id: 'USR-SUNSEA-YOON', name: '윤서진', email: 'seojin.yoon@sunsea.co.kr' }
const LEE = { id: 'USR-SUNSEA-LEE', name: '이정민', email: 'jungmin.lee@sunsea.co.kr' }
const GUEST = { id: 'USR-TENANT-SUNSEA-GUEST01', name: '홍거래', email: 'guest@partner.example', password: 'Guest!Pass2026' }
const GRANT_ID = 'GST-TENANT-SUNSEA-000001'

const NOW = '2026-09-03T01:00:00.000Z'   // KST 2026-09-03 10:00
const TODAY = '2026-09-03'

const digestHex = (password, accountId) => scryptSync(String(password), `onfactory:${accountId}`, 32).toString('hex')
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

const libraryDocument = (id, name, uploadedById = ADMIN.id) => ({
  id, tenantId: TENANT, name, originalName: name, mime: 'application/pdf', size: 12, checksum: `sha-${id}`,
  category: '공통자료', visibility: 'all', departments: [], allowedUserIds: [], tags: [], summary: '',
  uploadedAt: '2026-09-01T00:00:00.000Z', uploadedById, uploadedByName: '김서원', storage: 'local',
})

function freshStore(tenant = {}) {
  return {
    version: 2,
    tenants: { [TENANT]: tenant, 'TENANT-POHANG': {} },
    platform: {},
    accountApprovals: { [GUEST.id]: 'approved' },
    accountCredentials: { [GUEST.id]: { passwordHash: digestHex(GUEST.password, GUEST.id), mustChangePassword: false, temporaryPasswordExpiresAt: null } },
    invitedAccounts: [{ id: GUEST.id, email: GUEST.email, name: GUEST.name, tenantId: TENANT, tenantName: '햇살바다', team: '파트너상사', jobRole: '외부 게스트', requested: '게스트 초대', role: 'tenant-guest', guestGrantId: GRANT_ID }],
    passwordResetRequests: [],
    guestGrants: [{
      id: GRANT_ID, tenantId: TENANT, accountId: GUEST.id, email: GUEST.email, name: GUEST.name, orgName: '파트너상사', projectIds: [],
      invitedById: ADMIN.id, invitedByName: ADMIN.name, status: 'active', tokenHash: null, tokenIssuedAt: null, tokenExpiresAt: null,
      resendCount: 0, lastResentAt: null, accessExpiresAt: null, acceptedAt: '2026-09-01T00:00:00.000Z', revokedAt: null, revokedById: null, deactivatedAt: null,
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    }],
  }
}

const buildApp = (store, extra = {}) => createApp({
  apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {},
  documentStorage: memoryStorage(), approvalClock: () => new Date(NOW), ...extra,
})

async function login(origin, email, password = 'demo1234') {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: 'tenant', email, password }),
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

/** 양식 한 벌. 증빙은 붙이지 않는다 — 부수효과는 approval-effects.test.mjs 의 몫이다. */
const EXPENSE_FORM = {
  name: '출장비 정산', kind: '출장',
  fields: [
    { key: 'spent_on', label: '지출일', type: 'date', required: true },
    { key: 'amount', label: '금액', type: 'money', required: true },
    { key: 'purpose', label: '용도', type: 'text', required: false },
    { key: 'receipt', label: '영수증', type: 'attachment', required: false },
  ],
  defaultLine: [], ccIds: [], amountFieldKey: 'amount',
}

const line = (...ids) => ids.map((id) => (Array.isArray(id)
  ? { mode: 'parallel', approvers: id }
  : { mode: 'sequential', approvers: [id] }))

test('1. 기안 → 상신 → 2단계 결재 → 승인까지 전 경로가 200이고, 참조자는 읽지만 결재하지 못한다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const drafter = await login(origin, OH.email)
    const first = await login(origin, SEO.email)
    const second = await login(origin, YOON.email)
    const watcher = await login(origin, LEE.email)
    const stranger = await login(origin, PARK.email)

    const created = await api(origin, admin)('POST', '/api/approval-forms', EXPENSE_FORM)
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const formId = created.body.form.id
    assert.equal(created.body.form.version, 1)

    const drafted = await api(origin, drafter)('POST', '/api/approval-documents', {
      formId, title: '9월 부산 출장비', values: { spent_on: '2026-09-01', amount: 320_000, purpose: '거래처 방문' },
      line: line(SEO.id, YOON.id), ccIds: [LEE.id], submit: true,
    })
    assert.equal(drafted.status, 201, JSON.stringify(drafted.body))
    const id = drafted.body.document.id
    assert.equal(drafted.body.document.status, '결재중')
    assert.equal(drafted.body.document.currentStep, 1)
    assert.equal(drafted.body.document.drafterId, OH.id, '기안자는 세션이 정한다')

    // 참조자는 읽을 수 있다. 그러나 결재는 못 한다 — 참조는 열람이지 자리가 아니다.
    const watched = await api(origin, watcher)('GET', `/api/approval-documents/${id}`)
    assert.equal(watched.status, 200, JSON.stringify(watched.body))
    assert.equal(watched.body.permissions.canDecide, false)
    const watcherDecides = await api(origin, watcher)('POST', `/api/approval-documents/${id}/decide`, { decision: 'approve' })
    assert.equal(watcherDecides.status, 403)
    assert.equal(watcherDecides.body.error.code, 'APPROVAL_NOT_APPROVER')

    // 결재선에도 참조에도 없는 직원에게는 「없는 문서」와 같은 404다(존재 오라클 차단).
    const hidden = await api(origin, stranger)('GET', `/api/approval-documents/${id}`)
    const missing = await api(origin, stranger)('GET', '/api/approval-documents/APD-NOPE-0000')
    assert.equal(hidden.status, 404)
    assert.deepEqual(hidden.body, missing.body)

    const step1 = await api(origin, first)('POST', `/api/approval-documents/${id}/decide`, { decision: 'approve', comment: '확인' })
    assert.equal(step1.status, 200, JSON.stringify(step1.body))
    assert.equal(step1.body.document.status, '결재중')
    assert.equal(step1.body.document.currentStep, 2)

    // 이미 자기 자리를 채운 사람이 다시 누르면 「자격 없음」이 아니라 「자리를 이미 썼다」다.
    const again = await api(origin, first)('POST', `/api/approval-documents/${id}/decide`, { decision: 'approve' })
    assert.equal(again.status, 403)
    assert.equal(again.body.error.code, 'APPROVAL_SEAT_TAKEN')

    const step2 = await api(origin, second)('POST', `/api/approval-documents/${id}/decide`, { decision: 'approve' })
    assert.equal(step2.status, 200, JSON.stringify(step2.body))
    assert.equal(step2.body.document.status, '승인')
    assert.equal(step2.body.document.completedAt, NOW)
    assert.equal(step2.body.effects.posting.amount, 320_000)
    assert.equal(step2.body.effects.posting.currency, 'KRW')
    assert.equal(step2.body.effects.evidenceId, undefined, '증빙 분류가 없는 양식은 증빙을 만들지 않는다')

    const done = await api(origin, second)('POST', `/api/approval-documents/${id}/decide`, { decision: 'approve' })
    assert.equal(done.status, 409)
    assert.equal(done.body.error.code, 'APPROVAL_ALREADY_DECIDED')
  })
})

test('2. 대결자는 기간 안에서만 결재하고, decidedById 는 재기동을 넘어 살아남는다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const drafter = await login(origin, OH.email)
    const approver = await login(origin, SEO.email)
    const substitute = await login(origin, YOON.email)

    const formId = (await api(origin, admin)('POST', '/api/approval-forms', EXPENSE_FORM)).body.form.id
    const drafted = await api(origin, drafter)('POST', '/api/approval-documents', {
      formId, title: '대결 시험', values: { spent_on: '2026-09-01', amount: 10_000 }, line: line(SEO.id), submit: true,
    })
    const id = drafted.body.document.id

    // 기간 밖 대결은 없는 것과 같다. 그 사람은 이 문서를 **볼 수도** 없으므로 답은 403이 아니라
    // 404다 — 결재선 밖 사람에게 403을 주면 그 문서가 있다는 사실이 새어 나간다(§1.5).
    const past = await api(origin, approver)('PUT', '/api/approval-delegates/me', { delegateId: YOON.id, from: '2026-08-01', to: '2026-08-31' })
    assert.equal(past.status, 200, JSON.stringify(past.body))
    const tooEarly = await api(origin, substitute)('POST', `/api/approval-documents/${id}/decide`, { decision: 'approve' })
    assert.equal(tooEarly.status, 404)
    assert.equal(tooEarly.body.error.code, 'APPROVAL_DOCUMENT_NOT_FOUND')
    assert.equal((await api(origin, substitute)('GET', `/api/approval-documents/${id}`)).status, 404)

    // 관리자도 남의 대결자를 지정할 수 있다(사람이 갑자기 빠졌을 때 결재를 푸는 유일한 길이다).
    const byAdmin = await api(origin, admin)('PUT', `/api/approval-delegates/${SEO.id}`, { delegateId: YOON.id, from: TODAY, to: '2026-09-10', note: '휴가' })
    assert.equal(byAdmin.status, 200, JSON.stringify(byAdmin.body))
    assert.equal(byAdmin.body.delegate.id, `ADG-${SEO.id}`, 'id 가 결정론이라 upsert 가 곧 멱등이다')

    const decided = await api(origin, substitute)('POST', `/api/approval-documents/${id}/decide`, { decision: 'approve' })
    assert.equal(decided.status, 200, JSON.stringify(decided.body))
    const seat = decided.body.document.line[0].approvers[0]
    assert.equal(seat.accountId, SEO.id)
    assert.equal(seat.decidedById, YOON.id, '실제로 누른 사람이 자리에 남아야 한다')
    assert.equal(seat.delegateOf, SEO.id)

    // 대조군. 같은 결재선인데 **아직 아무도 누르지 않은** 문서다. 대결 기간이 끝나면 이것은 보이지 않는다.
    const untouched = await api(origin, drafter)('POST', '/api/approval-documents', {
      formId, title: '아무도 안 누른 건', values: { spent_on: '2026-09-01', amount: 20_000 }, line: line(SEO.id), submit: true,
    })
    assert.equal(untouched.status, 201, JSON.stringify(untouched.body))

    // 재기동. 시계는 **대결 기간(…09-10)이 끝난 뒤**로 준다 — 기간이 살아 있으면 가시성 다섯째 절
    // (대결 기간)이 열람을 대신 열어 주어, 이 시험은 넷째 절(decidedById)을 잠그지 못한다.
    // 그 값이 떨어지면 인쇄물의 「대결」 표기와 대결자의 열람 권한이 함께 죽는다.
    await withServer(buildApp(store, { approvalClock: () => new Date('2026-09-20T01:00:00.000Z') }), async (rebooted) => {
      const reader = await login(rebooted, YOON.email)
      const stale = await api(rebooted, reader)('GET', `/api/approval-documents/${untouched.body.document.id}`)
      assert.equal(stale.status, 404, '대결 기간이 아직 살아 있다 — 이 시험은 decidedById 를 잠그지 못한다')
      const reloaded = await api(rebooted, reader)('GET', `/api/approval-documents/${id}`)
      assert.equal(reloaded.status, 200, '대결로 결재한 사람이 기간이 끝난 뒤 자기가 누른 문서를 못 본다')
      assert.equal(reloaded.body.document.line[0].approvers[0].decidedById, YOON.id)
    })
  })
})

test('3. PATCH·DELETE·회수는 기안자와 「기안」 상태에서만 열리고, version 이 어긋나면 409다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const drafter = await login(origin, OH.email)
    const approver = await login(origin, SEO.email)
    const call = api(origin, drafter)

    const formId = (await api(origin, admin)('POST', '/api/approval-forms', EXPENSE_FORM)).body.form.id
    const drafted = await call('POST', '/api/approval-documents', {
      formId, title: '고칠 문서', values: { spent_on: '2026-09-01', amount: 5_000 }, line: line(SEO.id),
    })
    assert.equal(drafted.status, 201, JSON.stringify(drafted.body))
    const id = drafted.body.document.id
    assert.equal(drafted.body.document.status, '기안')

    const stale = await call('PATCH', `/api/approval-documents/${id}`, { version: 99, title: '헛것' })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.error.code, 'APPROVAL_VERSION_CONFLICT')
    assert.equal(stale.body.error.currentVersion, 1)

    const patched = await call('PATCH', `/api/approval-documents/${id}`, { version: 1, title: '고친 제목' })
    assert.equal(patched.status, 200, JSON.stringify(patched.body))
    assert.equal(patched.body.document.title, '고친 제목')
    assert.equal(patched.body.document.version, 2)

    // 결재자는 이 문서를 볼 수는 있지만 고치지 못한다 — 404 가 아니라 403 이다.
    const byApprover = await api(origin, approver)('PATCH', `/api/approval-documents/${id}`, { version: 2, title: '남의 기안' })
    assert.equal(byApprover.status, 403)
    assert.equal(byApprover.body.error.code, 'APPROVAL_DRAFTER_REQUIRED')

    // 기안 상태에서는 회수할 것이 없다.
    const earlyRecall = await call('POST', `/api/approval-documents/${id}/recall`, { version: 2 })
    assert.equal(earlyRecall.status, 409)
    assert.equal(earlyRecall.body.error.code, 'APPROVAL_RECALL_FORBIDDEN')

    const submitted = await call('POST', `/api/approval-documents/${id}/submit`, { version: 2 })
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body))
    assert.equal(submitted.body.document.status, '결재중')

    const lateEdit = await call('PATCH', `/api/approval-documents/${id}`, { version: 3, title: '늦은 수정' })
    assert.equal(lateEdit.status, 409)
    assert.equal(lateEdit.body.error.code, 'APPROVAL_NOT_EDITABLE')
    assert.match(lateEdit.body.error.message, /고칠 수 없습니다/)
    /**
     * 삭제에는 삭제의 답을 준다. 예전에는 두 경로가 `APPROVAL_NOT_EDITABLE` 하나를 함께 써서,
     * 「삭제」를 누른 사람이 「내용을 고칠 수 없습니다」를 들었다(라이브 서버에서 실측했다).
     * 묻지 않은 것에 답하면 사람은 고치는 길이 따로 있는 줄 알고 그것을 찾는다.
     */
    const lateDelete = await call('DELETE', `/api/approval-documents/${id}`)
    assert.equal(lateDelete.status, 409)
    assert.equal(lateDelete.body.error.code, 'APPROVAL_NOT_DELETABLE')
    assert.match(lateDelete.body.error.message, /지울 수 없습니다/)
    assert.match(lateDelete.body.error.message, /반려/, '끝내는 길을 말한다')
    assert.doesNotMatch(lateDelete.body.error.message, /고칠 수 없습니다/, '묻지 않은 것에 답하지 않는다')

    // 아직 아무도 보지 않았으므로 회수된다.
    const recalled = await call('POST', `/api/approval-documents/${id}/recall`, { version: 3 })
    assert.equal(recalled.status, 200, JSON.stringify(recalled.body))
    assert.equal(recalled.body.document.status, '회수')
    // 회수는 종결이다. 이미 끝난 문서는 결재되지 않는다.
    const afterRecall = await api(origin, approver)('POST', `/api/approval-documents/${id}/decide`, { decision: 'approve' })
    assert.equal(afterRecall.status, 409)
    assert.equal(afterRecall.body.error.code, 'APPROVAL_ALREADY_DECIDED')

    // 한 명이라도 승인한 뒤에는 회수가 닫힌다 — 그 승인을 없던 일로 만들면 이력이 거짓말을 한다.
    const second = await call('POST', '/api/approval-documents', {
      formId, title: '이미 본 문서', values: { spent_on: '2026-09-01', amount: 5_000 }, line: line(SEO.id, YOON.id), submit: true,
    })
    const seenId = second.body.document.id
    await api(origin, approver)('POST', `/api/approval-documents/${seenId}/decide`, { decision: 'approve' })
    const blocked = await call('POST', `/api/approval-documents/${seenId}/recall`, { version: 2 })
    assert.equal(blocked.status, 409)
    assert.equal(blocked.body.error.code, 'APPROVAL_RECALL_FORBIDDEN')

    // 기안 상태의 문서는 지워진다(잘못 시작한 기안을 지울 길이 사용자에게도 있어야 한다).
    const throwaway = await call('POST', '/api/approval-documents', {
      formId, title: '잘못 시작한 기안', values: { spent_on: '2026-09-01', amount: 1_000 },
    })
    const removed = await call('DELETE', `/api/approval-documents/${throwaway.body.document.id}`)
    assert.equal(removed.status, 200, JSON.stringify(removed.body))
    assert.deepEqual(removed.body, { ok: true })
    const gone = await call('GET', `/api/approval-documents/${throwaway.body.document.id}`)
    assert.equal(gone.status, 404)
  })
})

test('4. 같은 clientRequestId 재시도는 새 문서를 만들지 않고, 결재선 없이 상신하면 LINE_REQUIRED 다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const drafter = await login(origin, OH.email)
    const call = api(origin, drafter)
    const formId = (await api(origin, admin)('POST', '/api/approval-forms', EXPENSE_FORM)).body.form.id

    const payload = { formId, title: '재시도', values: { spent_on: '2026-09-01', amount: 7_000 }, clientRequestId: 'req-abc-1' }
    const first = await call('POST', '/api/approval-documents', payload)
    assert.equal(first.status, 201, JSON.stringify(first.body))
    const retry = await call('POST', '/api/approval-documents', payload)
    assert.equal(retry.status, 200)
    assert.equal(retry.body.replayed, true)
    assert.equal(retry.body.document.id, first.body.document.id)
    const listed = await call('GET', '/api/approval-documents?scope=drafted')
    assert.equal(listed.body.documents.length, 1, '재시도가 문서를 두 건 만들었다')

    // 결재선을 **비워서** 보내면 양식의 기본 결재선으로 떨어지지 않는다. 상신 때 반드시 울린다.
    const empty = await call('POST', '/api/approval-documents', {
      formId, title: '결재선 없음', values: { spent_on: '2026-09-01', amount: 1_000 }, line: [], submit: true,
    })
    assert.equal(empty.status, 400)
    assert.equal(empty.body.error.code, 'APPROVAL_LINE_REQUIRED')

    // 기안자 자신을 결재선에 넣을 수 없고, 없는 계정도 결재자가 될 수 없다.
    const self = await call('POST', '/api/approval-documents', {
      formId, title: '자기결재', values: { spent_on: '2026-09-01', amount: 1_000 }, line: line(OH.id),
    })
    assert.equal(self.status, 400)
    assert.equal(self.body.error.code, 'APPROVAL_LINE_SELF')
    const unknown = await call('POST', '/api/approval-documents', {
      formId, title: '없는 사람', values: { spent_on: '2026-09-01', amount: 1_000 }, line: line('USR-NOBODY'),
    })
    assert.equal(unknown.status, 400)
    assert.equal(unknown.body.error.code, 'APPROVAL_LINE_UNKNOWN_APPROVER')

    // 값 검증은 순수 함수 한 곳에서 나오고 그 key 가 그대로 응답에 실린다.
    const badValue = await call('POST', '/api/approval-documents', {
      formId, title: '잘못된 값', values: { spent_on: '2026-02-30', amount: 1_000 },
    })
    assert.equal(badValue.status, 400)
    assert.equal(badValue.body.error.code, 'APPROVAL_VALUE_INVALID')
    assert.equal(badValue.body.error.key, 'spent_on')
    const unknownKey = await call('POST', '/api/approval-documents', {
      formId, title: '없는 항목', values: { spent_on: '2026-09-01', amount: 1_000, ghost: 'x' },
    })
    assert.equal(unknownKey.body.error.reason, 'unknown-field')
  })
})

test('5. 대결자 지정은 자기 자신·기간 역전을 400으로, 사슬을 409로 막고, 남의 지정은 관리자만 한다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const seo = await login(origin, SEO.email)
    const yoon = await login(origin, YOON.email)

    assert.equal((await api(origin, seo)('PUT', '/api/approval-delegates/me', { delegateId: SEO.id, from: TODAY, to: '2026-09-10' })).status, 400)
    assert.equal((await api(origin, seo)('PUT', '/api/approval-delegates/me', { delegateId: YOON.id, from: '2026-09-10', to: TODAY })).status, 400)
    assert.equal((await api(origin, seo)('PUT', '/api/approval-delegates/me', { delegateId: 'USR-NOBODY', from: TODAY, to: '2026-09-10' })).status, 400)

    const set = await api(origin, seo)('PUT', '/api/approval-delegates/me', { delegateId: YOON.id, from: TODAY, to: '2026-09-10' })
    assert.equal(set.status, 200, JSON.stringify(set.body))

    // 이미 남의 대결자인 사람이 다시 자기 대결자를 두면 A→B→C 사슬이 된다. 대결은 한 단계까지다.
    const chain = await api(origin, yoon)('PUT', '/api/approval-delegates/me', { delegateId: LEE.id, from: TODAY, to: '2026-09-10' })
    assert.equal(chain.status, 409)
    assert.equal(chain.body.error.code, 'APPROVAL_DELEGATE_CYCLE')

    // 남의 대결 지정은 관리자만.
    const notAdmin = await api(origin, yoon)('PUT', `/api/approval-delegates/${SEO.id}`, { delegateId: LEE.id, from: TODAY, to: '2026-09-10' })
    assert.equal(notAdmin.status, 403)
    assert.equal(notAdmin.body.error.code, 'TENANT_ADMIN_REQUIRED')
    const nobody = await api(origin, admin)('PUT', '/api/approval-delegates/USR-NOBODY', { delegateId: LEE.id, from: TODAY, to: '2026-09-10' })
    assert.equal(nobody.status, 404)

    // 비우기는 검증을 지나지 않는다 — 「그만둔다」와 「잘못 골랐다」는 다른 요청이다.
    const cleared = await api(origin, seo)('PUT', '/api/approval-delegates/me', { delegateId: null })
    assert.equal(cleared.status, 200)
    assert.equal(cleared.body.delegate, null)
    assert.equal((await api(origin, seo)('GET', '/api/approval-forms')).body.delegate, null)
  })
})

test('6. 지출결의 씨앗은 두 번 불러도 한 번만 생기고, 내린 뒤에는 되살아나지 않는다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const member = await login(origin, OH.email)

    const first = await api(origin, admin)('GET', '/api/approval-forms')
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.equal(first.body.canManage, true)
    const seeds = first.body.forms.filter((form) => form.id === 'AFM-SEED-EXPENSE')
    assert.equal(seeds.length, 1)
    assert.equal(seeds[0].amountFieldKey, 'amount')
    assert.equal(seeds[0].evidenceCategory, '경비')
    assert.deepEqual(seeds[0].defaultLine, [], '씨앗에 실명을 넣으면 그 순간 데모 데이터가 된다')

    const second = await api(origin, member)('GET', '/api/approval-forms')
    assert.equal(second.body.forms.filter((form) => form.id === 'AFM-SEED-EXPENSE').length, 1, '조회할 때마다 씨앗이 늘었다')
    assert.equal(second.body.canManage, false)

    // 관리자가 내리면 목록에서 빠지고, 다시 조회해도 되살아나지 않는다.
    assert.equal((await api(origin, admin)('DELETE', '/api/approval-forms/AFM-SEED-EXPENSE')).status, 200)
    const afterDelete = await api(origin, admin)('GET', '/api/approval-forms')
    assert.equal(afterDelete.body.forms.filter((form) => form.id === 'AFM-SEED-EXPENSE').length, 0)
    const asAdminAll = await api(origin, admin)('GET', '/api/approval-forms?all=1')
    assert.equal(asAdminAll.body.forms.filter((form) => form.id === 'AFM-SEED-EXPENSE' && form.active === false).length, 1, '행은 남아야 진행 중 문서가 항목 라벨을 잃지 않는다')
    // 직원에게는 all=1 이 없다 — 내린 양식으로 새 기안을 시작할 길을 열지 않는다.
    const asMemberAll = await api(origin, member)('GET', '/api/approval-forms?all=1')
    assert.equal(asMemberAll.body.forms.filter((form) => form.active === false).length, 0)
  })
})

test('7. 승인된 지출 집계는 관리자에게 테넌트 전체, 직원에게 자기 기안분만 보여 준다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const oh = await login(origin, OH.email)
    const park = await login(origin, PARK.email)
    const approver = await login(origin, SEO.email)
    const formId = (await api(origin, admin)('POST', '/api/approval-forms', EXPENSE_FORM)).body.form.id

    for (const [session, amount] of [[oh, 100_000], [park, 250_000]]) {
      const drafted = await api(origin, session)('POST', '/api/approval-documents', {
        formId, title: '집계 대상', values: { spent_on: '2026-09-01', amount }, line: line(SEO.id), submit: true,
      })
      const decided = await api(origin, approver)('POST', `/api/approval-documents/${drafted.body.document.id}/decide`, { decision: 'approve' })
      assert.equal(decided.status, 200, JSON.stringify(decided.body))
    }

    const tenantWide = await api(origin, admin)('GET', '/api/approval-documents/postings')
    assert.equal(tenantWide.status, 200, JSON.stringify(tenantWide.body))
    assert.equal(tenantWide.body.scope, 'tenant')
    assert.equal(tenantWide.body.months.length, 6, '기본 창은 6개월이고 빈 달도 나온다')
    const september = tenantWide.body.months.at(-1)
    assert.equal(september.month, '2026-09')
    assert.equal(september.amount, 350_000)
    assert.equal(september.count, 2)
    assert.equal(september.byKind.reduce((sum, kind) => sum + kind.amount, 0), september.amount)

    const mine = await api(origin, oh)('GET', '/api/approval-documents/postings?months=3')
    assert.equal(mine.body.scope, 'mine')
    assert.equal(mine.body.months.length, 3)
    assert.equal(mine.body.months.at(-1).amount, 100_000, '직원은 자기 기안분만 본다')

    // 창 크기는 자르지 않고 거절한다. 36을 달라고 한 화면이 24를 받고도 잘렸다는 것을 알 길이 없다.
    const tooWide = await api(origin, admin)('GET', '/api/approval-documents/postings?months=36')
    assert.equal(tooWide.status, 400)
    assert.equal(tooWide.body.error.key, 'months')
    assert.equal((await api(origin, admin)('GET', '/api/approval-documents/postings?months=abc')).status, 400)
  })
})

test('8. generic 저장소 라우트는 두 키를 열지 않고, 게스트 세션은 결재 라우트 18개 전부에서 막힌다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    for (const key of ['approval-forms', 'approval-documents']) {
      const read = await api(origin, admin)('GET', `/api/workspace/${key}`)
      assert.equal(read.status, 403, JSON.stringify(read.body))
      assert.equal(read.body.error.code, 'APPROVAL_ROUTE_REQUIRED')
      const write = await api(origin, admin)('PUT', `/api/workspace/${key}`, { data: [] })
      assert.equal(write.status, 403)
      assert.equal(write.body.error.code, 'APPROVAL_ROUTE_REQUIRED')
    }

    // 구성원도 같은 문장을 받는다. 「없는 영역」과 「전용 라우트가 있는 영역」이 같은 답을 주면
    // 화면은 어디로 가야 하는지 알 수 없다 — 그래서 키 판정이 직무 판정보다 **앞**이어야 하고,
    // 그 순서가 GET 과 PUT 에서 같아야 한다.
    const member = await login(origin, OH.email)
    for (const key of ['approval-forms', 'approval-documents']) {
      for (const [method, payload] of [['GET', undefined], ['PUT', { data: [] }]]) {
        const result = await api(origin, member)(method, `/api/workspace/${key}`, payload)
        assert.equal(result.status, 403, `${method} ${key}`)
        assert.equal(result.body.error.code, 'APPROVAL_ROUTE_REQUIRED', `구성원의 ${method} ${key} 가 다른 문장을 받았다 — ${JSON.stringify(result.body)}`)
      }
    }

    const guest = await login(origin, GUEST.email, GUEST.password)
    const routes = [
      ['GET', '/api/approval-forms'], ['POST', '/api/approval-forms'],
      ['PATCH', '/api/approval-forms/AFM-X'], ['DELETE', '/api/approval-forms/AFM-X'],
      ['PUT', '/api/approval-delegates/me'], ['PUT', `/api/approval-delegates/${OH.id}`],
      ['GET', '/api/approval-documents'], ['GET', '/api/approval-documents/summary'],
      ['GET', '/api/approval-documents/postings'], ['GET', '/api/approval-documents/APD-X'],
      ['POST', '/api/approval-documents'], ['PATCH', '/api/approval-documents/APD-X'],
      ['DELETE', '/api/approval-documents/APD-X'], ['POST', '/api/approval-documents/APD-X/submit'],
      ['POST', '/api/approval-documents/APD-X/decide'], ['POST', '/api/approval-documents/APD-X/recall'],
      ['GET', '/api/approval-documents/APD-X/print'],
      ['GET', '/api/approval-documents/APD-X/attachments/DOC-X'],
    ]
    assert.equal(routes.length, 18, '결재 라우트는 18개다 — 늘리면 이 목록도 함께 늘려야 한다')
    for (const [method, route] of routes) {
      const result = await api(origin, guest)(method, route, method === 'GET' || method === 'DELETE' ? undefined : {})
      assert.equal(result.status, 403, `게스트가 ${method} ${route} 를 뚫었다 — ${result.status}`)
      assert.equal(result.body.error.code, 'GUEST_SCOPE_FORBIDDEN', `${method} ${route}`)
    }
  })
})

test('9. 결재가 붙잡은 「첨부」 항목 값은 자료실에서 지워지지 않는다 — 결재 밖 키의 values 는 그대로다', async () => {
  const store = freshStore({
    'company-documents': {
      data: [
        libraryDocument('DOC-RECEIPT-01', '영수증.pdf'),
        libraryDocument('DOC-ASSET-01', '자산 사진.pdf'),
        libraryDocument('DOC-TEXT-01', '자유 텍스트에 적힌 파일.pdf'),
      ],
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
    // 대조군. 결재 밖 키의 values 안에 든 DOC- 문자열은 참조로 세지 않는다 —
    // 여기까지 열면 아무 키에나 한 줄을 심어 남의 자료를 삭제 불가로 묶을 수 있다.
    'company-assets': { data: [{ id: 'AST-1', name: '노트북', values: { photo: 'DOC-ASSET-01' } }], updatedAt: '2026-09-01T00:00:00.000Z' },
  })
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const drafter = await login(origin, OH.email)
    const formId = (await api(origin, admin)('POST', '/api/approval-forms', EXPENSE_FORM)).body.form.id

    const drafted = await api(origin, drafter)('POST', '/api/approval-documents', {
      formId, title: '영수증 붙인 기안', values: { spent_on: '2026-09-01', amount: 3_000, receipt: 'DOC-RECEIPT-01' },
    })
    assert.equal(drafted.status, 201, JSON.stringify(drafted.body))

    const locked = await api(origin, admin)('DELETE', '/api/documents/DOC-RECEIPT-01')
    assert.equal(locked.status, 409, `「첨부」 항목 값이 참조로 세지 않는다 — ${JSON.stringify(locked.body)}`)
    assert.equal(locked.body.error.code, 'DOCUMENT_IN_USE')

    const free = await api(origin, admin)('DELETE', '/api/documents/DOC-ASSET-01')
    assert.equal(free.status, 200, `결재 밖 키의 values 가 자료 삭제를 잠갔다 — ${JSON.stringify(free.body)}`)

    // 대조군 ①: **같은 결재 문서 안**의 text 칸에 든 DOC- 는 참조가 아니다. 참조로 세는 집합이
    // 첨부 권한을 검사한 집합보다 넓으면, 아무나 자유 텍스트 한 줄로 남의 자료를 묶을 수 있다.
    const inText = await api(origin, drafter)('POST', '/api/approval-documents', {
      formId, title: 'text 칸에 적어 둔 id', values: { spent_on: '2026-09-01', amount: 1_000, purpose: 'DOC-TEXT-01' },
    })
    assert.equal(inText.status, 201, JSON.stringify(inText.body))
    const textFree = await api(origin, admin)('DELETE', '/api/documents/DOC-TEXT-01')
    assert.equal(textFree.status, 200, `결재 문서의 text 칸이 자료 삭제를 잠갔다 — ${JSON.stringify(textFree.body)}`)

    // 열지 못하는 자료는 결재에 붙일 수 없다(첨부 배열도 같은 잣대).
    const hiddenFile = libraryDocument('DOC-SECRET', '남의 비밀.pdf', PARK.id)
    store.tenants[TENANT]['company-documents'].data.push({ ...hiddenFile, visibility: 'restricted', allowedUserIds: [PARK.id] })
    const forbidden = await api(origin, drafter)('POST', '/api/approval-documents', {
      formId, title: '못 읽는 첨부', values: { spent_on: '2026-09-01', amount: 3_000 }, attachments: ['DOC-SECRET'],
    })
    assert.equal(forbidden.status, 400)
    assert.equal(forbidden.body.error.code, 'APPROVAL_ATTACHMENT_FORBIDDEN')

    // 대조군 ②: 같은 자료의 id 를 **text 칸**에 적으면 400 도 아니고 잠금도 아니다.
    // 읽을 권한조차 없는 자료를 문자열 한 줄로 영구히 붙잡는 길이 열려 있으면 안 된다.
    const secretInText = await api(origin, drafter)('POST', '/api/approval-documents', {
      formId, title: '못 읽는 자료를 text 칸에', values: { spent_on: '2026-09-01', amount: 3_000, purpose: 'DOC-SECRET' },
    })
    assert.equal(secretInText.status, 201, JSON.stringify(secretInText.body))
    const secretFree = await api(origin, admin)('DELETE', '/api/documents/DOC-SECRET')
    assert.equal(secretFree.status, 200, `읽을 권한도 없는 자료가 text 한 줄로 잠겼다 — ${JSON.stringify(secretFree.body)}`)

    // ── PATCH 갈래. 파생 필드를 **고칠 때도** 다시 적지 않으면 두 가지가 함께 무너진다:
    // 「첨부」 칸을 비워도 자료가 영원히 잠기고, PATCH 가 「기안 때의 옛 집합」을 검사하게 되어
    // 읽을 권한 없는 자료를 밀어 넣는 길이 열린다. 두 사실을 각각 잰다.
    const editable = await api(origin, drafter)('POST', '/api/approval-documents', {
      formId, title: 'PATCH 로 고칠 기안', values: { spent_on: '2026-09-01', amount: 5_000, receipt: 'DOC-RECEIPT-01' },
    })
    assert.equal(editable.status, 201, JSON.stringify(editable.body))
    const draftedId = editable.body.document.id
    assert.deepEqual(editable.body.document.linkedAttachmentIds, ['DOC-RECEIPT-01'])

    const cleared = await api(origin, drafter)('PATCH', `/api/approval-documents/${draftedId}`, {
      version: editable.body.document.version, values: { spent_on: '2026-09-01', amount: 5_000 },
    })
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body))
    assert.deepEqual(cleared.body.document.linkedAttachmentIds, [], 'PATCH 가 파생 필드를 다시 적지 않았다')
    // 처음 기안(위쪽 '영수증 붙인 기안')도 아직 이 자료를 붙잡고 있으므로, 그것부터 지워야 잠금이 풀린다.
    const firstDraftId = (await api(origin, drafter)('GET', '/api/approval-documents?scope=drafted'))
      .body.documents.find((row) => row.title === '영수증 붙인 기안').id
    assert.equal((await api(origin, drafter)('DELETE', `/api/approval-documents/${firstDraftId}`)).status, 200)
    const unlocked = await api(origin, admin)('DELETE', '/api/documents/DOC-RECEIPT-01')
    assert.equal(unlocked.status, 200, `「첨부」 칸을 비웠는데 자료가 잠긴 채로 남았다 — ${JSON.stringify(unlocked.body)}`)

    store.tenants[TENANT]['company-documents'].data.push({
      ...libraryDocument('DOC-SECRET-2', '또 다른 비밀.pdf', PARK.id), visibility: 'restricted', allowedUserIds: [PARK.id],
    })
    const pushed = await api(origin, drafter)('PATCH', `/api/approval-documents/${draftedId}`, {
      version: cleared.body.document.version, values: { spent_on: '2026-09-01', amount: 5_000, receipt: 'DOC-SECRET-2' },
    })
    assert.equal(pushed.status, 400, `PATCH 가 읽을 수 없는 자료를 받아들였다 — ${JSON.stringify(pushed.body)}`)
    assert.equal(pushed.body.error.code, 'APPROVAL_ATTACHMENT_FORBIDDEN')
  })
})

test('12. 목록은 상한 100에서 자르고 total 은 자르기 전 개수이며, 멱등 키는 자르지 않고 거절한다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const drafter = await login(origin, OH.email)
    const call = api(origin, drafter)
    const formId = (await api(origin, admin)('POST', '/api/approval-forms', EXPENSE_FORM)).body.form.id

    // 상한을 잃으면 5,000건 저장 상한까지 한 응답에 실린다. 101을 달라고 해도 100이다.
    const seeded = Array.from({ length: 105 }, (_value, index) => ({
      id: `APD-SEED-${String(index).padStart(4, '0')}`, formId, formName: '출장비 정산', formVersion: 1, kind: '출장',
      title: `심어 둔 문서 ${index}`, values: {}, attachments: [], linkedAttachmentIds: [], line: [], ccIds: [],
      drafterId: OH.id, drafterName: OH.name, status: '기안', currentStep: 0, rejectionReason: '',
      evidenceId: null, posting: null, history: [], version: 1, clientRequestId: '',
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: `2026-09-01T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
      submittedAt: null, completedAt: null,
    }))
    store.tenants[TENANT]['approval-documents'] = { data: seeded, updatedAt: '2026-09-01T00:00:00.000Z' }

    const listed = await call('GET', '/api/approval-documents?limit=101')
    assert.equal(listed.status, 200, JSON.stringify(listed.body))
    assert.equal(listed.body.documents.length, 100, '목록 상한 100이 사라졌다')
    // 자른 배열의 길이를 세지 않는다(규칙 13).
    assert.equal(listed.body.total, 105)
    assert.equal((await call('GET', '/api/approval-documents?limit=5')).body.documents.length, 5)

    // 121자 이상에서 앞 120자가 같은 두 키는 **합쳐지지 않는다.** 먼저 자른 뒤 모양을 보면
    // 두 번째 기안이 만들어지지 않고 첫 문서가 replayed 로 돌아가 남의 제목이 화면에 뜬다.
    const long = await call('POST', '/api/approval-documents', {
      formId, title: '너무 긴 멱등 키', values: { spent_on: '2026-09-01', amount: 1_000 }, clientRequestId: `${'a'.repeat(120)}1`,
    })
    assert.equal(long.status, 400, JSON.stringify(long.body))
    assert.equal(long.body.error.code, 'APPROVAL_VALUE_INVALID')
    assert.equal(long.body.error.key, 'clientRequestId')
    // 120자까지는 그대로 받고, 재시도는 여전히 한 건이다.
    const key = 'a'.repeat(120)
    const first = await call('POST', '/api/approval-documents', {
      formId, title: '경계값 멱등 키', values: { spent_on: '2026-09-01', amount: 1_000 }, clientRequestId: key,
    })
    assert.equal(first.status, 201, JSON.stringify(first.body))
    assert.equal(first.body.document.clientRequestId, key, '멱등 키가 저장될 때 잘렸다')
    const retry = await call('POST', '/api/approval-documents', {
      formId, title: '경계값 멱등 키', values: { spent_on: '2026-09-01', amount: 1_000 }, clientRequestId: key,
    })
    assert.equal(retry.body.replayed, true)
  })
})

test('13. 상신 전 문서를 결재하면 「이미 끝난 결재」가 아니라 「아직 상신되지 않았다」로 답한다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const drafter = await login(origin, OH.email)
    const approver = await login(origin, SEO.email)
    const formId = (await api(origin, admin)('POST', '/api/approval-forms', EXPENSE_FORM)).body.form.id
    const drafted = await api(origin, drafter)('POST', '/api/approval-documents', {
      formId, title: '아직 안 올린 문서', values: { spent_on: '2026-09-01', amount: 1_000 }, line: line(SEO.id),
    })
    assert.equal(drafted.status, 201, JSON.stringify(drafted.body))
    const id = drafted.body.document.id

    // 결재선에 이름이 적힌 사람은 상신 전 문서도 목록에서 본다 — 그래서 실제로 눌러 볼 수 있는 자리다.
    const read = await api(origin, approver)('GET', `/api/approval-documents/${id}`)
    assert.equal(read.status, 200, JSON.stringify(read.body))
    assert.equal(read.body.document.status, '기안')
    assert.equal(read.body.permissions.canDecide, false)

    const decided = await api(origin, approver)('POST', `/api/approval-documents/${id}/decide`, { decision: 'approve' })
    assert.equal(decided.status, 409, JSON.stringify(decided.body))
    assert.equal(decided.body.error.code, 'APPROVAL_NOT_SUBMITTED')
    assert.notEqual(decided.body.error.code, 'APPROVAL_ALREADY_DECIDED', '끝나지도 시작하지도 않은 문서를 「이미 끝났다」고 말한다')

    // 상신한 뒤에는 같은 사람이 같은 요청으로 200을 받는다 — 막은 것은 상태뿐이다.
    const submitted = await api(origin, drafter)('POST', `/api/approval-documents/${id}/submit`, { version: drafted.body.document.version })
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body))
    assert.equal((await api(origin, approver)('POST', `/api/approval-documents/${id}/decide`, { decision: 'approve' })).status, 200)
    // 끝난 뒤에야 「이미 끝난 결재」다.
    const again = await api(origin, approver)('POST', `/api/approval-documents/${id}/decide`, { decision: 'approve' })
    assert.equal(again.status, 409)
    assert.equal(again.body.error.code, 'APPROVAL_ALREADY_DECIDED')
  })
})

test('14. 커밋이 실패하면 저장된 적 없는 회사 객체도 함께 되돌아간다', async () => {
  // 회사 칸이 아예 없는 저장소. `??= {}` 로 만든 빈 회사를 남기면 다음 성공 커밋이 그것을 디스크에 싣는다.
  const store = { ...freshStore(), tenants: {} }
  let failCommit = false
  await withServer(buildApp(store, { onWorkspaceStoreChange: () => { if (failCommit) throw new Error('디스크가 꽉 찼다') } }), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    assert.equal(Object.hasOwn(store.tenants, TENANT), false, '시험이 시작부터 전제를 잃었다')

    failCommit = true
    const created = await api(origin, admin)('POST', '/api/approval-forms', EXPENSE_FORM)
    failCommit = false
    assert.equal(created.status, 500, JSON.stringify(created.body))
    assert.equal(created.body.error.code, 'APPROVAL_WRITE_FAILED')
    assert.equal(Object.hasOwn(store.tenants, TENANT), false, '커밋이 실패했는데 없던 회사 객체가 남았다')

    // 대조군: 원래 있던 회사는 실패해도 지워지지 않는다(그 안의 다른 키가 함께 사라지면 안 된다).
    store.tenants[TENANT] = { notifications: { data: [], updatedAt: '2026-09-01T00:00:00.000Z' } }
    failCommit = true
    assert.equal((await api(origin, admin)('POST', '/api/approval-forms', EXPENSE_FORM)).status, 500)
    failCommit = false
    assert.equal(Object.hasOwn(store.tenants, TENANT), true, '있던 회사 객체를 지웠다')
    assert.ok(store.tenants[TENANT].notifications, '같은 회사의 다른 키가 함께 사라졌다')
    assert.equal(store.tenants[TENANT]['approval-forms'], undefined, '실패한 쓰기가 그 키에 남았다')
  })
})

test('10. 양식 고치기는 관리자만·version 이 맞을 때만이고, 목록·요약이 같은 사실을 말한다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const member = await login(origin, OH.email)
    const approver = await login(origin, SEO.email)

    const created = await api(origin, admin)('POST', '/api/approval-forms', EXPENSE_FORM)
    const formId = created.body.form.id
    assert.equal((await api(origin, member)('POST', '/api/approval-forms', EXPENSE_FORM)).status, 403)
    assert.equal((await api(origin, member)('PATCH', `/api/approval-forms/${formId}`, { ...EXPENSE_FORM, version: 1 })).status, 403)
    assert.equal((await api(origin, admin)('PATCH', '/api/approval-forms/AFM-NOPE', { ...EXPENSE_FORM, version: 1 })).status, 404)

    const conflict = await api(origin, admin)('PATCH', `/api/approval-forms/${formId}`, { ...EXPENSE_FORM, version: 7 })
    assert.equal(conflict.status, 409)
    assert.equal(conflict.body.error.currentVersion, 1)
    const patched = await api(origin, admin)('PATCH', `/api/approval-forms/${formId}`, { ...EXPENSE_FORM, name: '출장비 정산(개정)', version: 1 })
    assert.equal(patched.status, 200, JSON.stringify(patched.body))
    assert.equal(patched.body.form.version, 2)
    assert.equal(patched.body.form.createdById, ADMIN.id, '최초 작성자는 갱신으로 바뀌지 않는다')

    // 양식이 바뀌어도 이미 돌고 있는 문서의 얼굴은 그대로다.
    const drafted = await api(origin, member)('POST', '/api/approval-documents', {
      formId, title: '이름 고정 시험', values: { spent_on: '2026-09-01', amount: 9_000 }, line: line(SEO.id), submit: true,
    })
    assert.equal(drafted.body.document.formName, '출장비 정산(개정)')
    assert.equal(drafted.body.document.formVersion, 2)

    const waiting = await api(origin, approver)('GET', '/api/approval-documents?scope=waiting')
    assert.equal(waiting.body.documents.length, 1)
    assert.equal(waiting.body.summary.waitingOnMe, 1)
    assert.equal(waiting.body.total, 1)
    // 목록이 「대기」라고 말한 문서는 실제로 결재된다 — 두 답이 같은 함수에서 나오기 때문이다.
    const decided = await api(origin, approver)('POST', `/api/approval-documents/${drafted.body.document.id}/decide`, { decision: 'approve' })
    assert.equal(decided.status, 200, JSON.stringify(decided.body))

    // 기안자는 「내가 올린 것」이 끝났다는 사실을 seenAt 이후의 점 하나로 안다.
    const summary = await api(origin, member)('GET', `/api/approval-documents/summary?seenAt=${encodeURIComponent('2026-09-02T00:00:00.000Z')}`)
    assert.equal(summary.status, 200, JSON.stringify(summary.body))
    assert.equal(summary.body.drafted, 1)
    assert.ok(summary.body.decidedUnread >= 1)
    const afterSeen = await api(origin, member)('GET', `/api/approval-documents/summary?seenAt=${encodeURIComponent('2026-09-04T00:00:00.000Z')}`)
    assert.equal(afterSeen.body.decidedUnread, 0, '이미 본 뒤에는 점이 사라져야 한다')
  })
})

test('11. 반려는 사유 5자 이상을 요구하고, 병렬 단계는 전원 승인해야 다음으로 간다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const drafter = await login(origin, OH.email)
    const seo = await login(origin, SEO.email)
    const yoon = await login(origin, YOON.email)
    const formId = (await api(origin, admin)('POST', '/api/approval-forms', EXPENSE_FORM)).body.form.id

    const parallel = await api(origin, drafter)('POST', '/api/approval-documents', {
      formId, title: '병렬 결재', values: { spent_on: '2026-09-01', amount: 20_000 },
      line: line([SEO.id, YOON.id]), submit: true,
    })
    assert.equal(parallel.status, 201, JSON.stringify(parallel.body))
    const id = parallel.body.document.id

    const half = await api(origin, seo)('POST', `/api/approval-documents/${id}/decide`, { decision: 'approve' })
    assert.equal(half.body.document.status, '결재중', '병렬은 전원 승인해야 다음으로 간다')
    assert.equal(half.body.document.currentStep, 1)

    const shortReason = await api(origin, yoon)('POST', `/api/approval-documents/${id}/decide`, { decision: 'reject', reason: '노노' })
    assert.equal(shortReason.status, 400)
    assert.equal(shortReason.body.error.code, 'APPROVAL_REASON_REQUIRED')
    const bogus = await api(origin, yoon)('POST', `/api/approval-documents/${id}/decide`, { decision: 'maybe' })
    assert.equal(bogus.status, 400)
    assert.equal(bogus.body.error.code, 'INVALID_DECISION')

    const rejected = await api(origin, yoon)('POST', `/api/approval-documents/${id}/decide`, { decision: 'reject', reason: '금액 근거가 없습니다.' })
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body))
    assert.equal(rejected.body.document.status, '반려')
    assert.equal(rejected.body.document.rejectionReason, '금액 근거가 없습니다.')
    // 먼저 승인한 사람의 기록은 지워지지 않는다 — 누가 무엇을 했는지가 이력의 전부다.
    assert.equal(rejected.body.document.line[0].approvers.find((approver) => approver.accountId === SEO.id).decision, 'approved')
  })
})

/**
 * §1.5 표가 선언한 두 상한. 동작은 옳았지만 잠그는 시험이 하나도 없었다 —
 * 잠금이 없는 상한은 다음 리팩터가 조용히 지운다. 상한-1 통과와 상한 거절을 함께 잰다.
 */
test('15. 양식 60개·문서 5,000건 상한은 상한-1 에서 통과하고 상한에서 409다', async () => {
  const seedForm = (index) => ({
    recordType: 'form', id: `AFM-SEED-${String(index).padStart(4, '0')}`, name: `씨앗 양식 ${index}`, kind: '품의',
    description: '', fields: [], defaultLine: [], ccIds: [], amountFieldKey: null, evidenceCategory: null,
    active: true, version: 1, createdById: ADMIN.id, createdByName: '김서원',
    createdAt: NOW, updatedAt: NOW, updatedById: ADMIN.id,
  })
  const forms = freshStore({
    'approval-forms': { data: Array.from({ length: MAX_FORMS_PER_TENANT - 1 }, (_value, index) => seedForm(index)), updatedAt: NOW },
  })
  await withServer(buildApp(forms), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const last = await api(origin, admin)('POST', '/api/approval-forms', EXPENSE_FORM)
    assert.equal(last.status, 201, `상한-1(${MAX_FORMS_PER_TENANT - 1}개)에서 거절했다 — ${JSON.stringify(last.body)}`)
    const over = await api(origin, admin)('POST', '/api/approval-forms', { ...EXPENSE_FORM, name: '넘치는 양식' })
    assert.equal(over.status, 409, JSON.stringify(over.body))
    assert.equal(over.body.error.code, 'APPROVAL_FORM_LIMIT')
    // 숫자를 말하는 문장은 실제 상한과 같아야 한다(규칙 11).
    assert.ok(over.body.error.message.includes(`${MAX_FORMS_PER_TENANT}개`), `문구가 상한을 말하지 않는다 — ${over.body.error.message}`)
  })

  const seedDocument = (index) => ({
    id: `APD-SEED-${String(index).padStart(5, '0')}`, formId: 'AFM-SEED-0000', formName: '씨앗 양식 0', formVersion: 1,
    kind: '품의', title: `씨앗 문서 ${index}`, values: {}, attachments: [], linkedAttachmentIds: [],
    line: [], ccIds: [], drafterId: OH.id, drafterName: '오태식', status: '기안', currentStep: 1,
    rejectionReason: '', evidenceId: null, posting: null, history: [], version: 1, clientRequestId: '',
    createdAt: NOW, updatedAt: NOW, submittedAt: null, completedAt: null,
  })
  const documents = freshStore({
    'approval-documents': { data: Array.from({ length: MAX_DOCUMENTS_PER_TENANT - 1 }, (_value, index) => seedDocument(index)), updatedAt: NOW },
  })
  await withServer(buildApp(documents), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const drafter = await login(origin, OH.email)
    const formId = (await api(origin, admin)('POST', '/api/approval-forms', EXPENSE_FORM)).body.form.id
    const body = { formId, values: { spent_on: '2026-09-01', amount: 1_000 } }
    const last = await api(origin, drafter)('POST', '/api/approval-documents', { ...body, title: '마지막 한 건' })
    assert.equal(last.status, 201, `상한-1(${MAX_DOCUMENTS_PER_TENANT - 1}건)에서 거절했다 — ${JSON.stringify(last.body)}`)
    const over = await api(origin, drafter)('POST', '/api/approval-documents', { ...body, title: '넘치는 한 건' })
    assert.equal(over.status, 409, JSON.stringify(over.body))
    assert.equal(over.body.error.code, 'APPROVAL_DOCUMENT_LIMIT')
    assert.ok(over.body.error.message.includes(`${MAX_DOCUMENTS_PER_TENANT}건`), `문구가 상한을 말하지 않는다 — ${over.body.error.message}`)
  })
})

/**
 * 같은 이름·같은 모양의 칸이 라우트마다 다른 사실을 세면, 그 차이는 응답 어디에도 적히지 않는다.
 * 목록으로 「내가 올린 것」 탭 점을 찍는 화면에서는 그 점이 영원히 꺼지지 않는다.
 */
test('16. summary.decidedUnread 는 목록에서도 요약에서도 같은 뜻이다 — seenAt 을 같은 규칙으로 읽는다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const drafter = await login(origin, OH.email)
    const approver = await login(origin, SEO.email)
    const formId = (await api(origin, admin)('POST', '/api/approval-forms', EXPENSE_FORM)).body.form.id
    for (const title of ['9월 출장 정산 1', '9월 출장 정산 2']) {
      const drafted = await api(origin, drafter)('POST', '/api/approval-documents', {
        formId, title, values: { spent_on: '2026-09-01', amount: 1_000 }, line: line(SEO.id), submit: true,
      })
      assert.equal(drafted.status, 201, JSON.stringify(drafted.body))
      const decided = await api(origin, approver)('POST', `/api/approval-documents/${drafted.body.document.id}/decide`, { decision: 'approve' })
      assert.equal(decided.status, 200, JSON.stringify(decided.body))
    }
    const call = api(origin, drafter)
    const pairs = async (query) => [
      (await call('GET', `/api/approval-documents${query}`)).body.summary.decidedUnread,
      (await call('GET', `/api/approval-documents/summary${query}`)).body.decidedUnread,
    ]
    // seenAt 이 없으면 「끝난 내 기안 전부」다 — 두 라우트가 같은 수를 말한다.
    assert.deepEqual(await pairs(''), [2, 2])
    // 마지막으로 본 시각 뒤에 끝난 것은 없다. 목록이 seenAt 을 버리면 여기서 2가 나온다.
    assert.deepEqual(await pairs(`?seenAt=${encodeURIComponent(NOW)}`), [0, 0])
    // 못 읽는 값은 두 라우트 모두 「전부」로 떨어진다 — 조용히 0으로 만들면 점이 영영 안 켜진다.
    assert.deepEqual(await pairs('?seenAt=어제'), [2, 2])
  })
})

/**
 * 409 문구는 **할 수 있는 행동**을 말해야 한다(규칙 11). 종결한 결재의 첨부에는 세 가지 사실이 있고,
 * 그 셋은 사람이 할 수 있는 일이 서로 다르므로 같은 문장을 받으면 안 된다.
 */
test('17. 끝난 결재의 첨부 — 반려·회수는 풀리고, 승인 근거는 잠긴 채 그 사실을 문구가 말한다', async () => {
  const store = freshStore({
    'company-documents': {
      data: [
        libraryDocument('DOC-REJ-1', '반려된 영수증.pdf'),
        libraryDocument('DOC-RCL-1', '회수된 영수증.pdf'),
        libraryDocument('DOC-APR-1', '승인된 영수증.pdf'),
        libraryDocument('DOC-ACT-1', '도는 중인 영수증.pdf'),
        libraryDocument('DOC-DRF-1', '기안에 붙은 영수증.pdf'),
      ],
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
  })
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const drafter = await login(origin, OH.email)
    const approver = await login(origin, SEO.email)
    const formId = (await api(origin, admin)('POST', '/api/approval-forms', EXPENSE_FORM)).body.form.id
    const draft = async (title, receipt, submit) => {
      const created = await api(origin, drafter)('POST', '/api/approval-documents', {
        formId, title, values: { spent_on: '2026-09-01', amount: 1_000, receipt }, line: line(SEO.id), submit,
      })
      assert.equal(created.status, 201, JSON.stringify(created.body))
      return created.body.document
    }
    const remove = (id) => api(origin, admin)('DELETE', `/api/documents/${id}`)

    // ① 반려. 종결 문서는 PATCH 도 DELETE 도 409 라서 화면에 연결을 풀 길이 없다 —
    //    잠금이 남으면 잘못 올려 반려된 기안 하나가 그 영수증을 자료실에 영구히 못 박는다.
    const rejectedDoc = await draft('반려될 기안', 'DOC-REJ-1', true)
    const rejected = await api(origin, approver)('POST', `/api/approval-documents/${rejectedDoc.id}/decide`, { decision: 'reject', reason: '영수증이 흐립니다.' })
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body))
    assert.equal(rejected.body.document.status, '반려')
    assert.equal((await api(origin, drafter)('PATCH', `/api/approval-documents/${rejectedDoc.id}`, { version: rejected.body.document.version, values: {} })).status, 409, '이 시험의 전제: 종결 문서는 고칠 수 없다')
    const freedByReject = await remove('DOC-REJ-1')
    assert.equal(freedByReject.status, 200, `반려된 결재가 자료를 영구히 붙잡았다 — ${JSON.stringify(freedByReject.body)}`)

    // ② 회수도 같다.
    const recalledDoc = await draft('회수할 기안', 'DOC-RCL-1', true)
    const recalled = await api(origin, drafter)('POST', `/api/approval-documents/${recalledDoc.id}/recall`, { version: recalledDoc.version })
    assert.equal(recalled.status, 200, JSON.stringify(recalled.body))
    assert.equal(recalled.body.document.status, '회수')
    const freedByRecall = await remove('DOC-RCL-1')
    assert.equal(freedByRecall.status, 200, `회수된 결재가 자료를 영구히 붙잡았다 — ${JSON.stringify(freedByRecall.body)}`)

    // ③ 승인은 영구히 잠긴다. 그것이 근거의 뜻이다 — 다만 「연결을 해제하라」고 말하지 않는다.
    const approvedDoc = await draft('승인될 기안', 'DOC-APR-1', true)
    const approved = await api(origin, approver)('POST', `/api/approval-documents/${approvedDoc.id}/decide`, { decision: 'approve' })
    assert.equal(approved.body.document.status, '승인')
    const locked = await remove('DOC-APR-1')
    assert.equal(locked.status, 409, JSON.stringify(locked.body))
    assert.equal(locked.body.error.code, 'DOCUMENT_IN_USE')
    assert.match(locked.body.error.message, /삭제할 수 없습니다/)
    assert.doesNotMatch(locked.body.error.message, /연결을 해제/, '할 수 없는 행동을 하라고 말한다')

    // ④ 결재중은 아직 갈리지 않았다. 문구가 두 갈래를 그대로 말한다.
    await draft('도는 중인 기안', 'DOC-ACT-1', true)
    const active = await remove('DOC-ACT-1')
    assert.equal(active.status, 409, JSON.stringify(active.body))
    assert.match(active.body.error.message, /반려·회수되면/)

    // ⑤ 기안은 기안자가 풀 수 있다 — 「연결을 해제한 뒤」가 참인 유일한 갈래다. 문구대로 해 본다.
    const draftDoc = await draft('아직 상신 안 한 기안', 'DOC-DRF-1', false)
    const held = await remove('DOC-DRF-1')
    assert.equal(held.status, 409, JSON.stringify(held.body))
    assert.match(held.body.error.message, /연결을 해제한 뒤/)
    assert.equal((await api(origin, drafter)('DELETE', `/api/approval-documents/${draftDoc.id}`)).status, 200)
    const freed = await remove('DOC-DRF-1')
    assert.equal(freed.status, 200, `문구가 말한 대로 연결을 풀었는데도 잠긴 채로 남았다 — ${JSON.stringify(freed.body)}`)
  })
})

/**
 * 화면과 같은 질의로 자료를 올린다(src/utils/documentAttachments.ts 의 uploadDocumentAttachment).
 * allowedUserIds 를 붙이지 않는 것까지 그대로 — 결재선은 이 시점에 아직 정해지지 않았을 수 있다.
 */
async function uploadAttachment(origin, session, name) {
  const params = new URLSearchParams({
    name, category: '결재증빙', visibility: 'restricted', summary: `전자결재 · ${name}`, tags: 'approval-attachment',
  })
  const response = await fetch(`${origin}/api/documents?${params}`, {
    method: 'POST',
    headers: { ...session.headers, 'content-type': 'application/octet-stream', 'x-file-type': 'application/pdf', 'x-file-name': encodeURIComponent(name) },
    body: Buffer.from(`bytes-of-${name}`),
  })
  const body = await readJson(response)
  assert.equal(response.status, 201, JSON.stringify(body))
  return body.document
}

/** 자료실 경로. 결재와 무관하게 「이 사람이 이 파일 자체를 열 수 있는가」를 잰다. */
const download = (origin, session, id) => fetch(`${origin}/api/documents/${id}/download`, {
  headers: { cookie: session.headers.cookie, 'x-workspace-identity': session.headers['x-workspace-identity'] },
})

/**
 * 결재 범위 전용 경로. 「이 결재를 볼 수 있는 사람이, 이 결재가 붙잡은 첨부를」 여는 문이다.
 * 자료실 명단을 고치지 않으므로 결재 문서가 닫히는 순간 이 문도 함께 닫힌다.
 */
const scopedDownload = (origin, session, documentId, attachmentId) => fetch(
  `${origin}/api/approval-documents/${documentId}/attachments/${attachmentId}`,
  { headers: { cookie: session.headers.cookie, 'x-workspace-identity': session.headers['x-workspace-identity'] } },
)

test('18. 결재선·참조에 선 사람은 그 결재 안에서 첨부를 연다 — 자료실 명단은 한 글자도 바뀌지 않는다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const drafter = await login(origin, OH.email)
    const approver = await login(origin, SEO.email)
    const watcher = await login(origin, LEE.email)
    const stranger = await login(origin, PARK.email)

    const formId = (await api(origin, admin)('POST', '/api/approval-forms', EXPENSE_FORM)).body.form.id
    const receipt = await uploadAttachment(origin, drafter, '영수증.pdf')
    const extra = await uploadAttachment(origin, drafter, '견적서.pdf')
    const unrelated = await uploadAttachment(origin, drafter, '무관한자료.pdf')
    assert.equal(receipt.visibility, 'restricted')
    assert.deepEqual(receipt.allowedUserIds, [OH.id], '이 시험의 전제: 올리는 순간에는 기안자만 열 수 있다')

    const drafted = await api(origin, drafter)('POST', '/api/approval-documents', {
      formId, title: '9월 원부자재 대금',
      values: { spent_on: '2026-09-01', amount: 1_240_000, receipt: receipt.id },
      attachments: [extra.id], line: line(SEO.id), ccIds: [LEE.id], submit: true,
    })
    assert.equal(drafted.status, 201, JSON.stringify(drafted.body))
    const id = drafted.body.document.id

    // ① 결재를 볼 수 있는 사람은 그 결재 안에서 근거를 연다. 바이트까지 잰다 —
    //    200 만 재면 「빈 응답을 200 으로 돌려주는」 구현도 통과한다.
    for (const [who, session] of [['기안자', drafter], ['결재자', approver], ['참조자', watcher], ['관리자', admin]]) {
      for (const [label, target] of [['항목 첨부', receipt], ['첨부 배열', extra]]) {
        const got = await scopedDownload(origin, session, id, target.id)
        assert.equal(got.status, 200, `${who}가 자기가 볼 결재의 ${label}을 열지 못한다`)
        assert.equal(await got.text(), `bytes-of-${target.name}`, `${who}: ${label} 의 바이트가 다르다`)
      }
    }

    // ② 그런데 자료실은 그대로다. 결재 한 번이 남의 자료실 열람 명단을 **영구히** 고치면,
    //    그 결재가 끝나거나 사라져도 열람은 닫히지 않고 다음 결재가 그것을 또 넓힌다.
    assert.equal((await download(origin, approver, receipt.id)).status, 404, '결재가 자료실 문까지 열었다')
    assert.equal((await download(origin, watcher, extra.id)).status, 404, '결재가 자료실 문까지 열었다')
    const after = (await api(origin, admin)('GET', '/api/documents')).body.documents.find((row) => row.id === receipt.id)
    assert.deepEqual(after.allowedUserIds, [OH.id], '결재가 자료실 열람 명단을 넓혔다')
    assert.equal(after.visibility, 'restricted', '결재가 공개 범위를 바꿨다')
    const listed = await api(origin, approver)('GET', '/api/documents')
    assert.equal((listed.body.documents ?? []).some((row) => row.id === receipt.id), false,
      '결재 첨부가 결재자의 자료실 목록에 앉았다 — 결재가 끝나도 그 자리는 닫히지 않는다')

    // ③ 결재선 밖의 직원에게는 두 문 모두 닫혀 있다.
    assert.equal((await scopedDownload(origin, stranger, id, receipt.id)).status, 404, '결재선 밖 직원에게 열렸다')
    assert.equal((await download(origin, stranger, receipt.id)).status, 404)

    // ④ 이 결재가 붙잡지 않은 자료는 이 문으로 나가지 않는다 — 문서 id 하나로 자료실 전체를 여는 창구가 되면 안 된다.
    assert.equal((await scopedDownload(origin, approver, id, unrelated.id)).status, 404,
      '결재가 붙잡지 않은 자료가 결재 경로로 나갔다')

    // ⑤ 상세는 첨부의 이름을 함께 준다(인쇄물·증빙과 같은 답이 한 곳에서 나온다).
    const detail = await api(origin, approver)('GET', `/api/approval-documents/${id}`)
    assert.equal(detail.status, 200, JSON.stringify(detail.body))
    assert.deepEqual(detail.body.attachments.map((entry) => entry.name).sort(), ['견적서.pdf', '영수증.pdf'])
    assert.deepEqual(detail.body.attachments.map((entry) => entry.canRead), [true, true])
  })
})

test('19. 첨부를 여는 근거는 저장된 명단이 아니라 결재 문서다 — 커밋이 실패하면 열 근거도 없다', async () => {
  const store = freshStore()
  let failCommit = false
  await withServer(buildApp(store, { onWorkspaceStoreChange: () => { if (failCommit) throw new Error('디스크가 꽉 찼다') } }), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const drafter = await login(origin, OH.email)
    const approver = await login(origin, SEO.email)
    const formId = (await api(origin, admin)('POST', '/api/approval-forms', EXPENSE_FORM)).body.form.id
    const receipt = await uploadAttachment(origin, drafter, '롤백될 영수증.pdf')

    failCommit = true
    const created = await api(origin, drafter)('POST', '/api/approval-documents', {
      formId, title: '커밋이 실패할 기안', values: { spent_on: '2026-09-01', amount: 1_000, receipt: receipt.id },
      line: line(SEO.id), submit: true,
    })
    failCommit = false
    assert.equal(created.status, 500, JSON.stringify(created.body))
    assert.equal(created.body.error.code, 'APPROVAL_WRITE_FAILED')

    assert.deepEqual((await api(origin, drafter)('GET', '/api/approval-documents?scope=all')).body.documents, [])
    const row = (await api(origin, admin)('GET', '/api/documents')).body.documents.find((entry) => entry.id === receipt.id)
    assert.deepEqual(row.allowedUserIds, [OH.id], '실패한 쓰기가 자료의 열람 명단에 흔적을 남겼다')

    // 대조군: 같은 요청이 커밋에 성공하면 그때 비로소 그 문서를 통해 열린다. 자료실은 여전히 닫혀 있다.
    const ok = await api(origin, drafter)('POST', '/api/approval-documents', {
      formId, title: '이번엔 성공하는 기안', values: { spent_on: '2026-09-01', amount: 1_000, receipt: receipt.id },
      line: line(SEO.id), submit: true,
    })
    assert.equal(ok.status, 201, JSON.stringify(ok.body))
    assert.equal((await scopedDownload(origin, approver, ok.body.document.id, receipt.id)).status, 200)
    assert.equal((await download(origin, approver, receipt.id)).status, 404)
    const still = (await api(origin, admin)('GET', '/api/documents')).body.documents.find((entry) => entry.id === receipt.id)
    assert.deepEqual(still.allowedUserIds, [OH.id], '성공한 쓰기가 자료의 열람 명단을 넓혔다')
  })
})

test('20. 대결자는 자기가 결재할 문서의 첨부를 연다 — 미리 잡아 둔 대결도 그 날이 되면 열리고, 끝나면 닫힌다', async () => {
  const store = freshStore()
  // 시계를 옮겨 가며 잰다. 대결 기간은 '오늘'을 읽어 판정하므로, 「지정하는 순간」에 한 번 넓히고 마는
  // 구현은 **미리 잡아 둔 대결**(휴가 전날 지정 — 가장 흔한 경우)에서 조용히 어긋난다.
  const nowRef = { value: NOW }
  await withServer(buildApp(store, { approvalClock: () => new Date(nowRef.value) }), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const drafter = await login(origin, OH.email)
    const standIn = await login(origin, YOON.email)   // SEO 의 대결자
    const formId = (await api(origin, admin)('POST', '/api/approval-forms', EXPENSE_FORM)).body.form.id

    const receipt = await uploadAttachment(origin, drafter, '대결-영수증.pdf')
    const sent = await api(origin, drafter)('POST', '/api/approval-documents', {
      formId, title: '내일부터 대결', values: { spent_on: '2026-09-01', amount: 90_000, receipt: receipt.id },
      line: line(SEO.id), submit: true,
    })
    assert.equal(sent.status, 201, JSON.stringify(sent.body))
    const id = sent.body.document.id

    // ① 휴가 전날, 내일부터의 대결을 잡는다. 오늘은 아직 아무 자격도 없다.
    assert.equal((await api(origin, admin)('PUT', `/api/approval-delegates/${SEO.id}`, {
      delegateId: YOON.id, from: '2026-09-04', to: '2026-09-10',
    })).status, 200)
    assert.equal((await api(origin, standIn)('GET', `/api/approval-documents/${id}`)).status, 404, '기간 전인데 문서가 열렸다')
    assert.equal((await scopedDownload(origin, standIn, id, receipt.id)).status, 404, '기간 전인데 첨부가 열렸다')

    // ② 기간이 시작되는 날. 결재할 자격과 그 근거를 여는 자격이 **같은 날** 함께 온다 —
    //    「승인 버튼은 눌리는데 영수증은 404」인 막다른 길을 만들지 않는다.
    nowRef.value = '2026-09-04T01:00:00.000Z'
    const onDuty = await api(origin, standIn)('GET', `/api/approval-documents/${id}`)
    assert.equal(onDuty.status, 200, JSON.stringify(onDuty.body))
    assert.equal(onDuty.body.permissions.canDecide, true, '이 시험의 전제: 대결 당일에는 결재할 차례다')
    assert.deepEqual(onDuty.body.attachments, [{ id: receipt.id, name: '대결-영수증.pdf', canRead: true }],
      '결재해야 할 사람에게 이름만 주고 파일은 닫아 두면 그 버튼은 막다른 길이다')
    const bytes = await scopedDownload(origin, standIn, id, receipt.id)
    assert.equal(bytes.status, 200, '대결 당일인데 근거를 열지 못한다')
    assert.equal(await bytes.text(), 'bytes-of-대결-영수증.pdf')
    assert.equal((await download(origin, standIn, receipt.id)).status, 404, '대결이 자료실 문까지 열었다')

    // ③ 기간이 끝나면 함께 닫힌다. 저장된 명단으로 넓혀 두면 이 자리에서 200 이 남는다.
    nowRef.value = '2026-09-11T01:00:00.000Z'
    assert.equal((await api(origin, standIn)('GET', `/api/approval-documents/${id}`)).status, 404)
    assert.equal((await scopedDownload(origin, standIn, id, receipt.id)).status, 404, '대결이 끝났는데 근거가 열린 채다')

    // ④ 대결로 실제로 누른 사람은 그 뒤에도 연다 — 자리에 decidedById 가 남기 때문이다.
    nowRef.value = '2026-09-04T02:00:00.000Z'
    assert.equal((await api(origin, standIn)('POST', `/api/approval-documents/${id}/decide`, { decision: 'approve' })).status, 200)
    nowRef.value = '2026-09-11T01:00:00.000Z'
    assert.equal((await scopedDownload(origin, standIn, id, receipt.id)).status, 200,
      '대결 기간이 끝나자 자기가 승인한 건의 근거가 닫혔다')
  })
})

test('21. 임시저장은 미완성 기안을 받고, 필수는 상신에서 잰다 — 오류가 어느 칸인지 말한다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const drafter = await login(origin, OH.email)
    const call = api(origin, drafter)
    const formId = (await api(origin, admin)('POST', '/api/approval-forms', EXPENSE_FORM)).body.form.id

    // ① 지출일만 적고 임시저장 — 「임시저장」이 미완성 기안을 저장하지 못하면 그 버튼은 이름을 거짓말한다.
    const saved = await call('POST', '/api/approval-documents', {
      formId, title: '아직 쓰는 중', values: { spent_on: '2026-09-01' }, line: line(SEO.id), submit: false,
    })
    assert.equal(saved.status, 201, JSON.stringify(saved.body))
    assert.equal(saved.body.document.status, '기안')
    const id = saved.body.document.id

    // ② 이어서 작성하다 채운 칸을 다시 비우는 것도 임시저장이다.
    const cleared = await call('PATCH', `/api/approval-documents/${id}`, {
      version: saved.body.document.version, values: { spent_on: '' },
    })
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body))

    // ③ 상신에서 비로소 잰다. 그리고 **어느 칸인지** 말한다.
    const blocked = await call('POST', `/api/approval-documents/${id}/submit`, { version: cleared.body.document.version })
    assert.equal(blocked.status, 400, JSON.stringify(blocked.body))
    assert.equal(blocked.body.error.code, 'APPROVAL_VALUE_REQUIRED')
    assert.equal(blocked.body.error.key, 'spent_on')
    assert.match(blocked.body.error.message, /지출일/, '한 문장이 네 칸을 함께 가리키면 사람은 어디를 고칠지 모른다')

    // ④ 다른 칸은 다른 문장을 받는다 — 다섯 갈래가 한 문장으로 뭉치지 않는다.
    const filledDate = await call('PATCH', `/api/approval-documents/${id}`, {
      version: cleared.body.document.version, values: { spent_on: '2026-09-01' },
    })
    assert.equal(filledDate.status, 200, JSON.stringify(filledDate.body))
    const missingAmount = await call('POST', `/api/approval-documents/${id}/submit`, { version: filledDate.body.document.version })
    assert.equal(missingAmount.body.error.key, 'amount')
    assert.notEqual(missingAmount.body.error.message, blocked.body.error.message, '두 칸이 같은 문장을 받는다')
    assert.match(missingAmount.body.error.message, /금액/)

    // ⑤ 제목은 임시저장에서도 필요하다(목록에 이름 없는 줄을 만들지 않는다) — 그 문장도 칸을 말한다.
    const noTitle = await call('POST', '/api/approval-documents', { formId, title: '   ', submit: false })
    assert.equal(noTitle.status, 400, JSON.stringify(noTitle.body))
    assert.equal(noTitle.body.error.key, 'title')
    assert.match(noTitle.body.error.message, /제목/)

    // ⑥ 다 채우면 상신된다. POST 로 곧장 상신할 때도 같은 잣대다.
    const ready = (await call('GET', `/api/approval-documents/${id}`)).body.document
    const filled = await call('PATCH', `/api/approval-documents/${id}`, {
      version: ready.version, values: { spent_on: '2026-09-01', amount: 5_000 },
    })
    assert.equal(filled.status, 200, JSON.stringify(filled.body))
    const submitted = await call('POST', `/api/approval-documents/${id}/submit`, { version: filled.body.document.version })
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body))
    assert.equal(submitted.body.document.status, '결재중')
    const straight = await call('POST', '/api/approval-documents', {
      formId, title: '곧장 상신', values: { spent_on: '2026-09-01' }, line: line(SEO.id), submit: true,
    })
    assert.equal(straight.status, 400, JSON.stringify(straight.body))
    assert.equal(straight.body.error.key, 'amount')

    // ⑦ 결재자 자리가 빈 단계는 **구조로** 거절된다. 그래서 화면은 「단계 추가」만 누른 상태를
    //    그대로 보내면 안 된다 — 임시저장 한 번이 통째로 400 이 되어 적어 둔 것이 남지 않는다.
    //    화면이 빈 단계를 걷어내는 근거가 이 줄이다(scripts/approval-ui-contract.test.mjs 의 filledLineSteps).
    const emptyStep = await call('POST', '/api/approval-documents', {
      formId, title: '단계만 추가한 기안', values: {}, line: [{ mode: 'sequential', approvers: [] }], submit: false,
    })
    assert.equal(emptyStep.status, 400, JSON.stringify(emptyStep.body))
    assert.equal(emptyStep.body.error.code, 'APPROVAL_LINE_INVALID')
    const withoutStep = await call('POST', '/api/approval-documents', {
      formId, title: '단계만 추가한 기안', values: {}, line: [], submit: false,
    })
    assert.equal(withoutStep.status, 201, `빈 단계를 걷어내면 임시저장이 지나야 한다 — ${JSON.stringify(withoutStep.body)}`)
    assert.equal(withoutStep.body.document.status, '기안')
  })
})

test('21-b. 상신이 거절돼도 그 다음 저장이 이어진다 — 화면이 타는 PATCH→상신 순서를 그대로 재현한다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const drafter = await login(origin, OH.email)
    const call = api(origin, drafter)
    const formId = (await api(origin, admin)('POST', '/api/approval-forms', EXPENSE_FORM)).body.form.id

    const saved = await call('POST', '/api/approval-documents', {
      formId, title: '이어서 작성할 기안', values: {}, line: line(SEO.id), submit: false,
    })
    assert.equal(saved.status, 201, JSON.stringify(saved.body))
    const id = saved.body.document.id
    // 화면이 대화상자를 열 때 잡은 스냅샷. 이 값을 고정으로 계속 쓰면 두 번째 요청부터 409 다.
    let version = saved.body.document.version

    // ① PATCH 는 성공하고 상신이 400 으로 거절된다 — 이 회차가 처음 만든 갈래다.
    const firstPatch = await call('PATCH', `/api/approval-documents/${id}`, { version, values: {}, title: '이어서 작성할 기안' })
    assert.equal(firstPatch.status, 200, JSON.stringify(firstPatch.body))
    version = firstPatch.body.document.version
    const rejected = await call('POST', `/api/approval-documents/${id}/submit`, { version })
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body))
    assert.equal(rejected.body.error.key, 'spent_on')

    // ② 사람이 지적받은 칸을 채우고 다시 누른다. 아무도 먼저 저장하지 않았으므로 409 가 나면 안 된다.
    const secondPatch = await call('PATCH', `/api/approval-documents/${id}`, {
      version, values: { spent_on: '2026-09-01', amount: 3_000 },
    })
    assert.equal(secondPatch.status, 200, `상신 거절 뒤 다시 저장할 길이 없다 — ${JSON.stringify(secondPatch.body)}`)
    version = secondPatch.body.document.version
    const ok = await call('POST', `/api/approval-documents/${id}/submit`, { version })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.equal(ok.body.document.status, '결재중')
    assert.deepEqual(ok.body.document.values.spent_on, '2026-09-01', '사람이 채운 값이 서버에 들어가지 못했다')

    // ③ 진짜 충돌이 났을 때는 서버가 **지금 version** 을 함께 준다 — 화면이 스스로 맞출 수 있게.
    const other = await call('POST', '/api/approval-documents', {
      formId, title: '충돌을 볼 기안', values: {}, line: line(SEO.id), submit: false,
    })
    assert.equal(other.status, 201, JSON.stringify(other.body))
    const stale = await call('PATCH', `/api/approval-documents/${other.body.document.id}`, { version: 0, values: {} })
    assert.equal(stale.status, 409, JSON.stringify(stale.body))
    assert.equal(stale.body.error.code, 'APPROVAL_VERSION_CONFLICT')
    assert.equal(stale.body.error.currentVersion, other.body.document.version)
  })
})

test('22. 「기안」은 아무 문도 열지 않는다 — 초안 하나로 남의 자료가 새 나가지 않는다', async () => {
  const store = freshStore()
  store.tenants[TENANT]['company-documents'] = {
    data: [{ ...libraryDocument('DOC-PAY-1', '급여대장.pdf', ADMIN.id), visibility: 'restricted', allowedUserIds: [OH.id] }],
    updatedAt: '2026-09-01T00:00:00.000Z', updatedBy: ADMIN.id,
  }
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const drafter = await login(origin, OH.email)
    const cc = await login(origin, PARK.email)
    const approver = await login(origin, SEO.email)
    const formId = (await api(origin, admin)('POST', '/api/approval-forms', EXPENSE_FORM)).body.form.id
    const allowedOf = async () => (await api(origin, admin)('GET', '/api/documents')).body.documents
      .find((row) => row.id === 'DOC-PAY-1').allowedUserIds
    // 이 시험의 자료는 저장소에 바이트가 없는 고정물이다. 그래서 **인가를 지났는지**는 상태 코드로 갈린다:
    // 404 = 인가 거절, 410 = 인가는 지났고 원본이 없다.
    const sees = async (session) => (await api(origin, session)('GET', '/api/documents')).body.documents
      .some((row) => row.id === 'DOC-PAY-1')

    // 대조군: 직원이 PATCH 로 남의 자료 명단을 고치는 길은 관리자 전용이다.
    assert.equal((await api(origin, drafter)('PATCH', '/api/documents/DOC-PAY-1', { allowedUserIds: [OH.id, PARK.id] })).status, 403)

    // ① 초안만으로는 아무도 열리지 않는다. 초안은 기안자 말고 아무도 「지금 볼 이유」가 없다.
    const draft = await api(origin, drafter)('POST', '/api/approval-documents', {
      formId, title: '초안', values: { spent_on: '2026-09-01', amount: 1_000 },
      attachments: ['DOC-PAY-1'], ccIds: [PARK.id], line: line(SEO.id), submit: false,
    })
    assert.equal(draft.status, 201, JSON.stringify(draft.body))
    const draftId = draft.body.document.id
    assert.equal(await sees(cc), false, '초안 하나로 남의 자료가 열렸다')
    assert.equal(await sees(approver), false, '초안 하나로 남의 자료가 열렸다')
    assert.equal((await scopedDownload(origin, cc, draftId, 'DOC-PAY-1')).status, 404, '초안이 결재 경로로 남의 자료를 열었다')
    assert.equal((await scopedDownload(origin, approver, draftId, 'DOC-PAY-1')).status, 404, '초안이 결재 경로로 남의 자료를 열었다')
    assert.equal((await scopedDownload(origin, drafter, draftId, 'DOC-PAY-1')).status, 410,
      '대조군: 자기 권한으로 열리는 사람은 초안에서도 지난다(410 = 인가는 지났고 원본이 없다)')
    assert.deepEqual(await allowedOf(), [OH.id])

    // ② 그 초안을 지워도 남는 것이 없다.
    assert.equal((await api(origin, drafter)('DELETE', `/api/approval-documents/${draftId}`)).status, 200)
    assert.deepEqual((await api(origin, drafter)('GET', '/api/approval-documents?scope=all')).body.documents, [])
    assert.deepEqual(await allowedOf(), [OH.id])

    // ③ 상신하면 **결재 범위에서** 열린다. 자료실 명단은 그대로다 — 넓힘이 남지 않으므로
    //    관리자가 자료실에서 회수한 결정이 다음 결재 한 번으로 되돌아오지 않는다.
    const sent = await api(origin, drafter)('POST', '/api/approval-documents', {
      formId, title: '상신본', values: { spent_on: '2026-09-01', amount: 1_000 },
      attachments: ['DOC-PAY-1'], ccIds: [PARK.id], line: line(SEO.id), submit: false,
    })
    assert.equal(sent.status, 201, JSON.stringify(sent.body))
    const sentId = sent.body.document.id
    const submitted = await api(origin, drafter)('POST', `/api/approval-documents/${sentId}/submit`, { version: sent.body.document.version })
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body))

    assert.equal((await scopedDownload(origin, cc, sentId, 'DOC-PAY-1')).status, 410, '상신했는데도 참조자가 근거를 열지 못한다')
    assert.equal((await scopedDownload(origin, approver, sentId, 'DOC-PAY-1')).status, 410, '상신했는데도 결재자가 근거를 열지 못한다')
    assert.deepEqual(await allowedOf(), [OH.id], '상신이 자료실 열람 명단을 넓혔다')
    assert.equal(await sees(cc), false, '결재 첨부가 참조자의 자료실 목록에 앉았다')
    assert.equal(await sees(approver), false, '결재 첨부가 결재자의 자료실 목록에 앉았다')

    // ④ 상신한 문서는 어떤 끝에서도 지워지지 않는다 — 「누가·무엇을 근거로 열었는가」가 언제나 남는다.
    assert.equal((await api(origin, drafter)('DELETE', `/api/approval-documents/${sentId}`)).status, 409)
    const flowing = (await api(origin, drafter)('GET', `/api/approval-documents/${sentId}`)).body.document
    assert.equal((await api(origin, drafter)('POST', `/api/approval-documents/${sentId}/recall`, { version: flowing.version })).status, 200)
    assert.equal((await api(origin, drafter)('DELETE', `/api/approval-documents/${sentId}`)).status, 409, '회수한 뒤에도 근거는 남아야 한다')
    assert.equal((await api(origin, admin)('DELETE', `/api/approval-documents/${sentId}`)).status, 409, '관리자도 근거를 지우지 못한다')
  })
})

test('23. 부서 공개 자료도 결재 범위에서는 열린다 — 그러나 공개 범위 자체는 건드리지 않는다', async () => {
  const store = freshStore()
  store.tenants[TENANT]['company-documents'] = {
    data: [{ ...libraryDocument('DOC-DEPT-1', '생산1팀-내부단가.pdf', OH.id), visibility: 'department', departments: ['생산 1팀'] }],
    updatedAt: '2026-09-01T00:00:00.000Z', updatedBy: OH.id,
  }
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const drafter = await login(origin, OH.email)
    const approver = await login(origin, SEO.email)   // 물류팀 — 그 부서가 아니다
    const formId = (await api(origin, admin)('POST', '/api/approval-forms', EXPENSE_FORM)).body.form.id

    const sent = await api(origin, drafter)('POST', '/api/approval-documents', {
      formId, title: '부서 공개 자료를 붙인 결재', values: { spent_on: '2026-09-01', amount: 3_000 },
      attachments: ['DOC-DEPT-1'], line: line(SEO.id), submit: true,
    })
    assert.equal(sent.status, 201, JSON.stringify(sent.body))
    const id = sent.body.document.id

    // 기안자가 그 자료를 붙여 이 사람에게 결재를 청했다 — 근거를 못 보는 채로 승인하게 두지 않는다.
    // 이름과 바이트는 언제나 함께 간다(둘이 갈리면 이름만 새는 자리가 생긴다).
    const theirs = await api(origin, approver)('GET', `/api/approval-documents/${id}`)
    assert.equal(theirs.status, 200, JSON.stringify(theirs.body))
    assert.deepEqual(theirs.body.attachments, [{ id: 'DOC-DEPT-1', name: '생산1팀-내부단가.pdf', canRead: true }])
    assert.equal((await scopedDownload(origin, approver, id, 'DOC-DEPT-1')).status, 410, '인가는 지나야 한다(410 = 원본 없음)')

    // 그러나 자료실 쪽은 한 글자도 바뀌지 않았다 — 부서 공개를 restricted 로 바꿔 넓히면
    // 그 파일을 보던 같은 부서 전원이 끊긴다(확대가 축소를 겸한다).
    assert.equal((await download(origin, approver, 'DOC-DEPT-1')).status, 404, '결재가 자료실 문까지 열었다')
    const same = (await api(origin, admin)('GET', '/api/documents')).body.documents.find((row) => row.id === 'DOC-DEPT-1')
    assert.equal(same.visibility, 'department', '부서 공개를 restricted 로 바꾸면 그 부서 전원이 끊긴다')
    assert.deepEqual(same.departments, ['생산 1팀'])
    assert.deepEqual(same.allowedUserIds, [])
  })
})

test('24. 대결 지정 한 번이 자료실을 넓히지 않는다 — 연쇄도, 관리자 회수의 무력화도 없다', async () => {
  const store = freshStore()
  const nowRef = { value: NOW }
  await withServer(buildApp(store, { approvalClock: () => new Date(nowRef.value) }), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const owner = await login(origin, OH.email)       // 영수증을 올린 사람
    const seat = await login(origin, SEO.email)       // 결재선에 이름이 적힌 평사원
    const standIn = await login(origin, LEE.email)    // 그가 세운 하루짜리 대결자 — 이 결재와 무관한 동료
    const third = await login(origin, PARK.email)     // 대결자가 자기 결재의 참조로 넣으려는 사람
    const formId = (await api(origin, admin)('POST', '/api/approval-forms', EXPENSE_FORM)).body.form.id
    const receipt = await uploadAttachment(origin, owner, '남의-영수증.pdf')
    const allowedOf = async () => (await api(origin, admin)('GET', '/api/documents')).body.documents
      .find((row) => row.id === receipt.id).allowedUserIds

    const sent = await api(origin, owner)('POST', '/api/approval-documents', {
      formId, title: '대결이 붙을 결재', values: { spent_on: '2026-09-01', amount: 7_000, receipt: receipt.id },
      line: line(SEO.id), submit: true,
    })
    assert.equal(sent.status, 201, JSON.stringify(sent.body))
    const id = sent.body.document.id

    // ① 평사원 한 사람이 하루짜리 대결자를 세운다. 자료실 명단은 그대로여야 한다.
    assert.equal((await api(origin, seat)('PUT', '/api/approval-delegates/me', {
      delegateId: LEE.id, from: TODAY, to: TODAY,
    })).status, 200)
    assert.deepEqual(await allowedOf(), [OH.id], '대결 지정 한 번이 자료실 열람 명단을 넓혔다')
    assert.equal((await download(origin, standIn, receipt.id)).status, 404, '대결자가 자료실에서 남의 원본을 연다')
    assert.equal((await scopedDownload(origin, standIn, id, receipt.id)).status, 200, '대결 당일에는 결재 범위에서 열려야 한다')

    // ② 대결 행을 지우면 그 문이 닫힌다. 저장된 명단으로 넓혀 두면 여기서 200 이 남는다.
    assert.equal((await api(origin, seat)('PUT', '/api/approval-delegates/me', { delegateId: null })).status, 200)
    assert.equal((await scopedDownload(origin, standIn, id, receipt.id)).status, 404, '대결 행을 지웠는데 근거가 열린 채다')
    assert.equal((await api(origin, standIn)('GET', `/api/approval-documents/${id}`)).status, 404)
    assert.deepEqual(await allowedOf(), [OH.id])

    // ③ 연쇄가 없다 — 대결로 잠깐 열렸던 사람이 그 파일을 자기 결재에 붙여 남에게 넘길 수 없다.
    //    (붙이려면 그 자료를 **자기 권한으로** 읽을 수 있어야 한다.)
    const relay = await api(origin, standIn)('POST', '/api/approval-documents', {
      formId, title: '넘겨 보기', values: { spent_on: '2026-09-01', amount: 1_000, receipt: receipt.id },
      line: line(YOON.id), ccIds: [PARK.id], submit: true,
    })
    assert.equal(relay.status, 400, JSON.stringify(relay.body))
    assert.equal(relay.body.error.code, 'APPROVAL_ATTACHMENT_FORBIDDEN')
    assert.equal((await download(origin, third, receipt.id)).status, 404)
    assert.deepEqual(await allowedOf(), [OH.id])

    // ④ 관리자의 회수가 결재 한 번으로 되돌아오지 않는다.
    assert.equal((await api(origin, admin)('PATCH', `/api/documents/${receipt.id}`, { allowedUserIds: [] })).status, 200)
    const flowing = (await api(origin, seat)('GET', `/api/approval-documents/${id}`)).body.document
    assert.equal(flowing.status, '결재중')
    assert.equal((await api(origin, seat)('POST', `/api/approval-documents/${id}/decide`, { decision: 'approve' })).status, 200)
    assert.deepEqual(await allowedOf(), [], '결재 한 번이 관리자의 회수를 되돌렸다')
    // 올린 사람은 자기 업로드라 그대로 열린다(canReadDocument 의 기존 규칙). 그 밖의 사람은 닫힌 채다.
    assert.equal((await download(origin, seat, receipt.id)).status, 404, '결재를 누른 것만으로 자료실 문이 열렸다')
    assert.equal((await download(origin, standIn, receipt.id)).status, 404, '관리자가 회수한 열람이 결재로 되살아났다')
  })
})

test('25. 열 수 없는 첨부는 이름을 싣지 않는다 — 이 저장소에서 파일 이름은 종종 내용이다', async () => {
  const store = freshStore()
  store.tenants[TENANT]['company-documents'] = {
    data: [{ ...libraryDocument('DOC-DEPT-1', '생산1팀-내부단가.pdf', OH.id), visibility: 'department', departments: ['생산 1팀'] }],
    updatedAt: '2026-09-01T00:00:00.000Z', updatedBy: OH.id,
  }
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const drafter = await login(origin, OH.email)
    const approver = await login(origin, SEO.email)
    const formId = (await api(origin, admin)('POST', '/api/approval-forms', EXPENSE_FORM)).body.form.id

    // 아직 상신하지 않은 기안이다. 결재선에 이름은 적혀 있어 문서는 보이지만, 첨부는 아직 열 수 없다.
    const draft = await api(origin, drafter)('POST', '/api/approval-documents', {
      formId, title: '아직 안 보낸 기안', values: { spent_on: '2026-09-01', amount: 3_000 },
      attachments: ['DOC-DEPT-1'], line: line(SEO.id), submit: false,
    })
    assert.equal(draft.status, 201, JSON.stringify(draft.body))
    const id = draft.body.document.id

    const theirs = await api(origin, approver)('GET', `/api/approval-documents/${id}`)
    assert.equal(theirs.status, 200, JSON.stringify(theirs.body))
    assert.deepEqual(theirs.body.attachments, [{ id: 'DOC-DEPT-1', canRead: false }],
      '열 수 없는 첨부의 이름이 그대로 실려 나갔다')
    assert.equal((await scopedDownload(origin, approver, id, 'DOC-DEPT-1')).status, 404, '이 시험의 전제: 그 파일은 실제로 닫혀 있다')

    // 인쇄물도 같은 잣대다 — 상세에서 감춘 이름을 종이가 되돌려 놓으면 감춘 적이 없는 것과 같다.
    const printed = await fetch(`${origin}/api/approval-documents/${id}/print`, {
      headers: { cookie: approver.headers.cookie, 'x-workspace-identity': approver.headers['x-workspace-identity'] },
    })
    assert.equal(printed.status, 200)
    const html = await printed.text()
    assert.ok(!html.includes('생산1팀-내부단가'), '인쇄물에 열 수 없는 첨부의 이름이 실렸다')
    assert.match(html, /열람 권한이 없는 첨부/)

    // 대조군: 기안자 자신에게는 이름과 바이트가 함께 간다. 인쇄물에도 이름이 그대로 실린다.
    const mine = await api(origin, drafter)('GET', `/api/approval-documents/${id}`)
    assert.deepEqual(mine.body.attachments, [{ id: 'DOC-DEPT-1', name: '생산1팀-내부단가.pdf', canRead: true }])
    const ownPrint = await fetch(`${origin}/api/approval-documents/${id}/print`, {
      headers: { cookie: drafter.headers.cookie, 'x-workspace-identity': drafter.headers['x-workspace-identity'] },
    })
    assert.match(await ownPrint.text(), /생산1팀-내부단가\.pdf/)
  })
})

test('26. 목록의 나머지에 닿는 길이 실제로 있다 — offset 이 그 다음 묶음을 꺼낸다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const drafter = await login(origin, OH.email)
    const approver = await login(origin, SEO.email)
    const formId = (await api(origin, admin)('POST', '/api/approval-forms', EXPENSE_FORM)).body.form.id

    const titles = []
    for (let index = 0; index < 5; index += 1) {
      const title = `대기 ${index + 1}`
      const created = await api(origin, drafter)('POST', '/api/approval-documents', {
        formId, title, values: { spent_on: '2026-09-01', amount: 1_000 }, line: line(SEO.id), submit: true,
      })
      assert.equal(created.status, 201, JSON.stringify(created.body))
      titles.push(title)
    }

    // 「내 결재」 탭은 서버가 canDecide 로 거른다 — 그 탭에서는 상태 좁히기가 갈래를 만들지 못하므로
    // (모두 '결재중'이다) 나머지에 닿는 길은 offset 뿐이다.
    const call = api(origin, approver)
    const first = await call('GET', '/api/approval-documents?scope=waiting&limit=2')
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.equal(first.body.total, 5, '자른 배열의 길이가 아니라 전체 개수를 세야 한다')
    assert.equal(first.body.documents.length, 2)

    const second = await call('GET', '/api/approval-documents?scope=waiting&limit=2&offset=2')
    const third = await call('GET', '/api/approval-documents?scope=waiting&limit=2&offset=4')
    const reached = [...first.body.documents, ...second.body.documents, ...third.body.documents].map((row) => row.title)
    assert.deepEqual([...new Set(reached)].sort(), [...titles].sort(), '이어 부르면 전부에 닿아야 한다')
    assert.equal(second.body.total, 5, 'total 은 페이지마다 같은 뜻이어야 한다')

    // 끝을 넘기면 빈 묶음이다(오류가 아니다) — 화면이 「더 보기」를 한 번 더 눌러도 막다른 길이 없다.
    const past = await call('GET', '/api/approval-documents?scope=waiting&limit=2&offset=5')
    assert.equal(past.status, 200, JSON.stringify(past.body))
    assert.deepEqual(past.body.documents, [])
    assert.equal(past.body.total, 5)
    // 모양이 아닌 값은 거절하지 않고 처음부터 준다 — 목록은 읽기다.
    const junk = await call('GET', '/api/approval-documents?scope=waiting&limit=2&offset=-3')
    assert.equal(junk.body.documents.length, 2)
  })
})

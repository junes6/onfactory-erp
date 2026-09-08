import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import test from 'node:test'

import { createApp } from './app.mjs'
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

    // 재기동. 같은 저장소로 앱을 새로 세워 decidedById 가 살아남는지 본다 —
    // 이 값이 떨어지면 인쇄물의 「대결」 표기와 대결자의 열람 권한이 함께 죽는다.
    await withServer(buildApp(store), async (rebooted) => {
      const reader = await login(rebooted, YOON.email)
      const reloaded = await api(rebooted, reader)('GET', `/api/approval-documents/${id}`)
      assert.equal(reloaded.status, 200, '대결로 결재한 사람이 재기동 뒤 자기가 누른 문서를 못 본다')
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
    const lateDelete = await call('DELETE', `/api/approval-documents/${id}`)
    assert.equal(lateDelete.status, 409)
    assert.equal(lateDelete.body.error.code, 'APPROVAL_NOT_EDITABLE')

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

test('8. generic 저장소 라우트는 두 키를 열지 않고, 게스트 세션은 결재 라우트 17개 전부에서 막힌다', async () => {
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
    ]
    assert.equal(routes.length, 17, '결재 라우트는 17개다 — 늘리면 이 목록도 함께 늘려야 한다')
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
      data: [libraryDocument('DOC-RECEIPT-01', '영수증.pdf'), libraryDocument('DOC-ASSET-01', '자산 사진.pdf')],
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

    // 열지 못하는 자료는 결재에 붙일 수 없다(첨부 배열도 같은 잣대).
    const hiddenFile = libraryDocument('DOC-SECRET', '남의 비밀.pdf', PARK.id)
    store.tenants[TENANT]['company-documents'].data.push({ ...hiddenFile, visibility: 'restricted', allowedUserIds: [PARK.id] })
    const forbidden = await api(origin, drafter)('POST', '/api/approval-documents', {
      formId, title: '못 읽는 첨부', values: { spent_on: '2026-09-01', amount: 3_000 }, attachments: ['DOC-SECRET'],
    })
    assert.equal(forbidden.status, 400)
    assert.equal(forbidden.body.error.code, 'APPROVAL_ATTACHMENT_FORBIDDEN')
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

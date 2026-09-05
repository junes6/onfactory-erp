import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createApp } from './app.mjs'
import { withServer } from './test-server.mjs'
import { approvalStatistics, classifyDocument, evaluateSentinel, isInstructionMessage, proposeDocumentClassification, proposeTaskFromMessage } from './proposal-engine.mjs'
import { CONSENT_ITEM_IDS, CONSENT_TERMS_VERSION } from './policies/consent-terms.mjs'

async function login(origin, email, workspace = 'tenant', password = 'demo1234') {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace, email, password }),
  })
  return { response, cookie: response.headers.get('set-cookie') ?? '' }
}
const freshStore = () => ({ version: 2, tenants: { 'TENANT-SUNSEA': {}, 'TENANT-POHANG': {} }, platform: {}, accountApprovals: {}, accountCredentials: {}, invitedAccounts: [], passwordResetRequests: [], guestGrants: [] })
const jsonHeaders = (cookie) => ({ 'content-type': 'application/json', cookie })
const readJson = async (response) => { const text = await response.text(); try { return JSON.parse(text) } catch { return { raw: text } } }

test('engine: instruction detection and due estimation', () => {
  assert.equal(isInstructionMessage('내일까지 원가표 정리해 주세요'), true)
  assert.equal(isInstructionMessage('점심 뭐 먹지'), false)
  const now = new Date('2026-08-24T01:00:00.000Z') // 월요일 10:00 KST
  const proposal = proposeTaskFromMessage({ message: { id: 'M1', senderId: 'A', senderName: '김대표', text: '금요일까지 HACCP 점검표 제출 부탁드립니다' }, conversation: { id: 'C1', name: '품질팀', type: 'direct', participantIds: ['A', 'B'] }, recipients: [{ id: 'B', name: '박지현' }], now })
  assert.ok(proposal)
  assert.equal(proposal.kind, 'task-from-message')
  assert.equal(proposal.payload.ownerId, 'B')
  assert.match(proposal.payload.due, /^2026-08-28T/)
  assert.equal(proposeTaskFromMessage({ message: { id: 'M2', text: '네 알겠습니다', senderName: 'x' }, conversation: {}, now }), null)
})

test('engine: food sentinel rule pack dedupes and expires', () => {
  const now = new Date('2026-08-22T03:00:00.000Z')
  const tenantStore = {
    'compliance-records': { data: [{ id: 'CR-1', name: 'HACCP 인증', owner: '박지현', expiresAt: '2026-09-10' }, { id: 'CR-2', name: '수질검사', owner: '박지현', expiresAt: '2026-12-01' }] },
    'product-catalog': { data: [{ id: 'P-1', name: '새우젓', stock: 2, safetyStock: 10 }] },
    'work-items': { data: [{ id: 'WK-1', title: '라벨 교체', status: '업무요청', owner: '박지현', ownerId: 'U1', due: '2026-08-20T09:00:00.000Z' }, { id: 'WK-2', title: '설비 점검', status: '결재대기', owner: '박지현', ownerId: 'U1', due: '2026-08-30T09:00:00.000Z', completion: { submittedAt: '2026-08-19T00:00:00.000Z' } }] },
  }
  const accounts = [{ id: 'U1', name: '박지현', tenantId: 'T', approved: true, role: 'tenant-member' }]
  const first = evaluateSentinel({ tenantStore, existing: [], industryType: 'food_manufacturing', accounts, tenantId: 'T', now })
  const keys = first.proposals.map((item) => item.sourceKey).sort()
  assert.deepEqual(keys, ['sentinel:backlog:WK-2', 'sentinel:compliance:CR-1:d30', 'sentinel:overdue:WK-1', 'sentinel:stock:P-1'])
  assert.ok(first.proposals.every((item) => item.evidence && item.payload.due && item.payload.description.includes('근거:')))
  assert.equal(first.proposals.find((item) => item.sourceKey === 'sentinel:compliance:CR-1:d30').payload.ownerId, 'U1')
  // 같은 사안 재평가 → 중복 없음
  const second = evaluateSentinel({ tenantStore, existing: first.proposals, industryType: 'food_manufacturing', accounts, tenantId: 'T', now })
  assert.equal(second.created, 0)
  assert.equal(second.proposals.length, 4)
  // 재고 해소 → 해당 제안 expired
  tenantStore['product-catalog'].data[0].stock = 50
  const third = evaluateSentinel({ tenantStore, existing: second.proposals, industryType: 'food_manufacturing', accounts, tenantId: 'T', now })
  assert.equal(third.expired, 1)
  assert.equal(third.proposals.find((item) => item.sourceKey === 'sentinel:stock:P-1').status, 'expired')
  // IT 업종은 코어 규칙(결재 적체·마감 초과)만 받고 식품 규칙은 받지 않는다.
  const itOnly = evaluateSentinel({ tenantStore, existing: [], industryType: 'it_services', accounts, tenantId: 'T', now })
  assert.deepEqual(itOnly.proposals.map((item) => item.sourceKey).sort(), ['sentinel:backlog:WK-2', 'sentinel:overdue:WK-1'])
  const stats = approvalStatistics([{ kind: 'sentinel-task', status: 'approved', decidedAt: now.toISOString() }, { kind: 'sentinel-task', status: 'rejected', decidedAt: now.toISOString() }], { now })
  assert.equal(stats.find((row) => row.kind === 'sentinel-task').approvalRate, 50)
})

test('engine: an IT tenant gets contract-expiry and project-overdue instead of food rules', () => {
  const now = new Date('2026-08-22T03:00:00.000Z')
  const tenantStore = {
    // 식품 키를 함께 두어도 IT 팩은 이를 보지 않는다.
    'compliance-records': { data: [{ id: 'CR-1', name: 'HACCP 인증', owner: '박지현', expiresAt: '2026-09-10' }] },
    'product-catalog': { data: [{ id: 'P-1', name: '새우젓', stock: 0, safetyStock: 10 }] },
    'it-contracts': { data: [{ id: 'CT-1', client: '한국도로공사', title: '유지보수 계약', endDate: '2026-09-10', ownerId: 'U1' }, { id: 'CT-2', client: '먼 거래처', title: '내년 계약', endDate: '2027-06-01' }] },
    'it-projects': { data: [{ id: 'PJ-1', name: '관제 시뮬레이터', client: '한국도로공사', status: '진행 중', dueDate: '2026-08-19', ownerId: 'U1' }, { id: 'PJ-2', name: '완료 건', client: 'A사', status: '완료', dueDate: '2026-08-01' }] },
    'work-items': { data: [] },
  }
  const accounts = [{ id: 'U1', name: '박지현', tenantId: 'T', approved: true, role: 'tenant-member' }]
  const result = evaluateSentinel({ tenantStore, existing: [], industryType: 'it_services', accounts, tenantId: 'T', now })
  assert.deepEqual(result.proposals.map((item) => item.sourceKey).sort(), ['sentinel:contract:CT-1', 'sentinel:project:PJ-1'])
  assert.equal(result.proposals.find((item) => item.sourceKey === 'sentinel:contract:CT-1').payload.ownerId, 'U1')
  assert.match(result.proposals.find((item) => item.sourceKey === 'sentinel:project:PJ-1').evidence, /마감 3일 경과/)
  // 식품 테넌트는 반대로 IT 규칙을 받지 않는다.
  const food = evaluateSentinel({ tenantStore, existing: [], industryType: 'food_manufacturing', accounts, tenantId: 'T', now })
  assert.ok(food.proposals.every((item) => !item.sourceKey.startsWith('sentinel:contract:') && !item.sourceKey.startsWith('sentinel:project:')))
})

test('engine: document classification suggests only categories the industry actually has', () => {
  const drawing = { id: 'D-1', name: '공장 배치도.pdf', category: '공통자료', tags: [] }
  assert.equal(classifyDocument(drawing, 'food_manufacturing').category, '공장도면')
  assert.equal(classifyDocument(drawing, 'it_services'), null, 'IT 고객사에 공장도면을 제안하지 않는다')

  const spec = { id: 'D-2', name: '요구사항 명세서 v2.docx', category: '공통자료', tags: [] }
  assert.equal(classifyDocument(spec, 'it_services').category, '산출물')
  assert.equal(classifyDocument(spec, 'food_manufacturing'), null)

  // 코어 분류는 업종과 무관하게 동작한다.
  const contract = { id: 'D-3', name: 'NDA 협약.pdf', category: '공통자료', tags: [] }
  for (const industry of ['food_manufacturing', 'it_services']) {
    assert.equal(classifyDocument(contract, industry).category, '계약 · 거래처')
  }
  assert.equal(proposeDocumentClassification(spec, { industryType: 'it_services' }).payload.category, '산출물')
  assert.equal(proposeDocumentClassification(spec, { industryType: 'food_manufacturing' }), null)
})

test('document upload and instruction message land in the approval queue; approve / edit(diff) / reject execute correctly', async () => {
  const store = freshStore()
  const documentUploadDirectory = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onfactory-proposals-')), 'documents')
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {}, documentUploadDirectory }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const member = await login(origin, 'jihyun.park@sunsea.co.kr')
    assert.equal(admin.response.status, 200)

    // 1) 문서 업로드 → 분류 제안
    const params = new URLSearchParams({ name: 'HACCP_인증서_2026.pdf', category: '기타', visibility: 'team', tags: '' })
    const upload = await fetch(`${origin}/api/documents?${params}`, {
      method: 'POST', headers: { cookie: admin.cookie, 'content-type': 'application/octet-stream', 'x-file-type': 'application/pdf', 'x-file-name': encodeURIComponent('HACCP_인증서_2026.pdf') }, body: Buffer.from('%PDF-1.4 test'),
    })
    const uploaded = await readJson(upload)
    assert.equal(upload.status, 201, JSON.stringify(uploaded))

    // 2) 메신저 지시 문형 → 업무 제안
    const room = await readJson(await fetch(`${origin}/api/messenger/conversations/direct`, { method: 'POST', headers: jsonHeaders(admin.cookie), body: JSON.stringify({ participantId: 'USR-SUNSEA-PARK' }) }))
    assert.ok(room.conversation?.id, JSON.stringify(room))
    const send = await fetch(`${origin}/api/messenger/conversations/${room.conversation.id}/messages`, { method: 'POST', headers: jsonHeaders(admin.cookie), body: JSON.stringify({ text: '내일까지 8월 원가표 정리해 주세요' }) })
    assert.equal(send.status, 201)
    const chat = await fetch(`${origin}/api/messenger/conversations/${room.conversation.id}/messages`, { method: 'POST', headers: jsonHeaders(admin.cookie), body: JSON.stringify({ text: '수고했어요' }) })
    assert.equal(chat.status, 201)

    // 큐 조회 (관리자만)
    const memberQueue = await fetch(`${origin}/api/proposals`, { headers: { cookie: member.cookie } })
    assert.equal(memberQueue.status, 403)
    const queue = await readJson(await fetch(`${origin}/api/proposals`, { headers: { cookie: admin.cookie } }))
    const documentProposal = queue.proposals.find((item) => item.kind === 'document-classification' && item.payload.documentId === uploaded.document.id)
    const taskProposal = queue.proposals.find((item) => item.kind === 'task-from-message')
    assert.ok(documentProposal, '문서 분류 제안이 큐에 있어야 한다')
    assert.equal(documentProposal.payload.category, '식품안전·인증')
    assert.ok(documentProposal.confidence >= .85)
    assert.ok(taskProposal, '지시 문형 제안이 큐에 있어야 한다')
    assert.equal(queue.proposals.filter((item) => item.kind === 'task-from-message').length, 1, '일반 대화는 제안하지 않는다')
    assert.equal(taskProposal.payload.ownerId, 'USR-SUNSEA-PARK')
    assert.equal(queue.pendingCount, 2)

    // generic PUT으로는 변경 불가
    const directPut = await fetch(`${origin}/api/workspace/ai-proposals`, { method: 'PUT', headers: jsonHeaders(admin.cookie), body: JSON.stringify({ data: [] }) })
    assert.equal(directPut.status, 403)

    // ✓ 승인 → 문서 분류 반영
    const approve = await readJson(await fetch(`${origin}/api/proposals/${documentProposal.id}/decide`, { method: 'POST', headers: jsonHeaders(admin.cookie), body: JSON.stringify({ decision: 'approve' }) }))
    assert.equal(approve.proposal.status, 'approved', JSON.stringify(approve))
    const documents = store.tenants['TENANT-SUNSEA']['company-documents'].data
    assert.equal(documents.find((item) => item.id === uploaded.document.id).category, '식품안전·인증')

    // ✏ 수정 승인 → diff 저장 + 업무 생성
    const edit = await readJson(await fetch(`${origin}/api/proposals/${taskProposal.id}/decide`, { method: 'POST', headers: jsonHeaders(admin.cookie), body: JSON.stringify({ decision: 'edit', payload: { title: '8월 원가표 정리 및 검토', priority: '높음' } }) }))
    assert.equal(edit.proposal.status, 'edited', JSON.stringify(edit))
    assert.deepEqual(Object.keys(edit.proposal.decisionDiff).sort(), ['priority', 'title'])
    assert.equal(edit.proposal.decisionDiff.title.after, '8월 원가표 정리 및 검토')
    assert.equal(edit.resultRef.type, 'work-item')
    const workItems = store.tenants['TENANT-SUNSEA']['work-items'].data
    const created = workItems.find((item) => item.id === edit.resultRef.id)
    assert.equal(created.title, '8월 원가표 정리 및 검토')
    assert.equal(created.ownerId, 'USR-SUNSEA-PARK')
    assert.equal(created.status, '업무요청')
    assert.equal(created.priority, '높음')

    // 이미 처리된 제안 재결정 409
    const again = await fetch(`${origin}/api/proposals/${taskProposal.id}/decide`, { method: 'POST', headers: jsonHeaders(admin.cookie), body: JSON.stringify({ decision: 'reject' }) })
    assert.equal(again.status, 409)

    // 승인률 집계 (automation-policies)
    const after = await readJson(await fetch(`${origin}/api/proposals`, { headers: { cookie: admin.cookie } }))
    assert.equal(after.pendingCount, 0)
    assert.equal(after.stats.find((row) => row.kind === 'document-classification').approvalRate, 100)
    assert.equal(store.tenants['TENANT-SUNSEA']['automation-policies'].data.find((row) => row.kind === 'task-from-message').edited, 1)
  })
})

test('sentinel proposes expiring compliance tasks with evidence, without duplicates, and rejection is recorded', async () => {
  const store = freshStore()
  const soon = new Date(Date.now() + 20 * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10)
  store.tenants['TENANT-SUNSEA']['compliance-records'] = { data: [{ id: 'CR-HACCP', name: 'HACCP 인증', owner: '박지현', expiresAt: soon }], updatedAt: new Date().toISOString() }
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {} }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const first = await readJson(await fetch(`${origin}/api/proposals/evaluate`, { method: 'POST', headers: { cookie: admin.cookie } }))
    assert.equal(first.created, 1, JSON.stringify(first))
    const second = await readJson(await fetch(`${origin}/api/proposals/evaluate`, { method: 'POST', headers: { cookie: admin.cookie } }))
    assert.equal(second.created, 0, '같은 사안은 해소 전 1건만')
    const queue = await readJson(await fetch(`${origin}/api/proposals`, { headers: { cookie: admin.cookie } }))
    const sentinel = queue.proposals.filter((item) => item.kind === 'sentinel-task')
    assert.equal(sentinel.length, 1)
    assert.match(sentinel[0].evidence, /HACCP 인증 만료 D-\d+/)
    assert.equal(sentinel[0].payload.ownerId, 'USR-SUNSEA-PARK')
    assert.match(sentinel[0].payload.description, /근거:/)
    const reject = await readJson(await fetch(`${origin}/api/proposals/${sentinel[0].id}/decide`, { method: 'POST', headers: jsonHeaders(admin.cookie), body: JSON.stringify({ decision: 'reject', comment: '이미 갱신 접수함' }) }))
    assert.equal(reject.proposal.status, 'rejected')
    assert.equal(reject.proposal.comment, '이미 갱신 접수함')
    // 거절된 사안은 다시 제안하지 않는다
    const third = await readJson(await fetch(`${origin}/api/proposals/evaluate`, { method: 'POST', headers: { cookie: admin.cookie } }))
    assert.equal(third.created, 0)
  })
})

test('operator switches tenants directly from an entered state with exit + enter audit entries', async () => {
  const store = freshStore()
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {} }), async (origin) => {
    const operator = await login(origin, 'operator@onfactory.co.kr', 'platform')
    const cookie = operator.cookie
    const enterA = await fetch(`${origin}/api/platform/tenants/TENANT-SUNSEA/enter`, { method: 'POST', headers: { cookie } })
    assert.equal(enterA.status, 200)
    const enterB = await fetch(`${origin}/api/platform/tenants/TENANT-POHANG/enter`, { method: 'POST', headers: { cookie } })
    const bodyB = await readJson(enterB)
    assert.equal(enterB.status, 200, JSON.stringify(bodyB))
    assert.equal(bodyB.account.tenantId, 'TENANT-POHANG')
    const audit = store.platform.auditEvents ?? []
    const events = audit.filter((entry) => ['운영자 테넌트 나가기', '운영자 테넌트 접속'].includes(entry.event)).map((entry) => `${entry.event}:${entry.tenantId}`)
    assert.ok(events.includes('운영자 테넌트 접속:TENANT-SUNSEA'), JSON.stringify(events))
    assert.ok(events.includes('운영자 테넌트 나가기:TENANT-SUNSEA'), JSON.stringify(events))
    assert.ok(events.includes('운영자 테넌트 접속:TENANT-POHANG'), JSON.stringify(events))
  })
})

test('tenant consent is stored on creation, visible to the tenant admin, and re-consent works', async () => {
  const store = freshStore()
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {} }), async (origin) => {
    const terms = await readJson(await fetch(`${origin}/api/consent-terms`))
    assert.equal(terms.version, CONSENT_TERMS_VERSION)
    assert.equal(terms.items.length, CONSENT_ITEM_IDS.length, '공개 약관은 정책이 요구하는 항목을 빠짐없이 보여 준다')
    const operator = await login(origin, 'operator@onfactory.co.kr', 'platform')
    const created = await readJson(await fetch(`${origin}/api/platform/tenants`, {
      method: 'POST', headers: jsonHeaders(operator.cookie),
      body: JSON.stringify({ companyName: '동의테스트식품', industry: '식품 제조', plan: 'Growth', adminName: '최동의', adminEmail: 'admin@consent.test', targetDate: '2026-10-01', consentVersion: CONSENT_TERMS_VERSION, consents: Object.fromEntries(CONSENT_ITEM_IDS.map((id) => [id, true])) }),
    }))
    assert.ok(created.tenant?.id, JSON.stringify(created))
    const stored = store.platform.tenants.find((tenant) => tenant.id === created.tenant.id)
    assert.equal(stored.consent.version, CONSENT_TERMS_VERSION)
    assert.equal(stored.consent.agreedBy.id, 'USR-ONFACTORY-OPS')
    assert.equal(stored.consent.items.length, CONSENT_ITEM_IDS.length)

    // 기존(동의 없는) 테넌트 관리자 → 재동의 필요
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const before = await readJson(await fetch(`${origin}/api/tenant/consent`, { headers: { cookie: admin.cookie } }))
    assert.equal(before.needsReconsent, true)
    const partial = await fetch(`${origin}/api/tenant/consent`, { method: 'POST', headers: jsonHeaders(admin.cookie), body: JSON.stringify({ consents: { dataAccess: true } }) })
    assert.equal(partial.status, 400)
    const agree = await readJson(await fetch(`${origin}/api/tenant/consent`, { method: 'POST', headers: jsonHeaders(admin.cookie), body: JSON.stringify({ consents: Object.fromEntries(CONSENT_ITEM_IDS.map((id) => [id, true])) }) }))
    assert.equal(agree.needsReconsent, false)
    assert.equal(agree.consent.agreedBy.id, 'USR-SUNSEA-ADMIN')
    const member = await login(origin, 'jihyun.park@sunsea.co.kr')
    assert.equal((await fetch(`${origin}/api/tenant/consent`, { headers: { cookie: member.cookie } })).status, 403)
  })
})

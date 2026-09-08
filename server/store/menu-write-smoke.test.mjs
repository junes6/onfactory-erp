import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createApp } from '../app.mjs'
import { withServer } from '../test-server.mjs'
import { initializeRuntimeStore } from './index.mjs'

const TENANT_ID = 'TENANT-SUNSEA'
const ADMIN_ID = 'USR-SUNSEA-ADMIN'
const WORKSPACE_IDENTITY = `${TENANT_ID}:${ADMIN_ID}`

const workRule = {
  id: 'SMOKE-AI-RULE', title: 'AI 주간 점검 초안', description: 'AI 업무허브 대표 쓰기 항목',
  owner: '박지현', ownerId: 'USR-SUNSEA-PARK', requester: '김서원', requesterId: ADMIN_ID,
  frequency: 'weekly', interval: 1, weekday: 3, nextRun: '2099-01-07', dueTime: '18:00',
  priority: '보통', category: '품질', active: true, createdAt: '2026-08-21T00:00:00.000Z',
}
const calendarEvent = {
  id: 'SMOKE-CALENDAR', title: '스모크 일정', date: '2099-01-07', start: '09:00', end: '10:00',
  scope: 'company', department: '전사', location: '회의실', owner: '김서원', note: '메뉴 쓰기 점검',
}
const workItem = {
  id: 'SMOKE-WORK', title: '스모크 업무', description: '업무 화면 대표 쓰기 항목', owner: '박지현',
  ownerId: 'USR-SUNSEA-PARK', requestedBy: '김서원', requesterId: ADMIN_ID,
  due: '2099-01-07T09:00:00.000Z', priority: '보통', status: '업무요청', category: '일반',
  createdAt: '2026-08-21T00:00:00.000Z',
}
const journal = {
  id: 'SMOKE-JOURNAL', date: '2026-08-21', title: '2026-08-21_김서원_업무일지', authorId: ADMIN_ID,
  author: '김서원', department: '경영지원', completed: '창고 등록 스모크 점검', issue: '', nextPlan: '',
  approver: '소속 관리자', status: '임시저장', updatedAt: '2026-08-21T00:00:00.000Z', feedback: '',
  attachments: [], reviews: [],
}
const product = {
  id: 'SMOKE-PRODUCT', code: 'SMOKE-001', name: '스모크 제품', shortName: '스모크', category: '테스트',
  specification: '100g', price: 1000, stock: 10, available: 10, safetyStock: 2, storage: '냉장',
  labelStatus: '검토중', status: '정상', channels: 0, visual: 1,
  fact: { manufacturer: '스모크 공장', foodType: '기타가공품' },
}
const warehouse = {
  id: 'SMOKE-WAREHOUSE', name: '스모크 냉장창고', type: '냉장', temperature: '3℃',
  condition: '3℃ · 정상', items: '등록 재고 0개', utilization: 0, alert: '이상 없음',
}
const layoutBlock = {
  id: 'SMOKE-BLOCK', factoryId: 'SMOKE-FACTORY', zoneId: 'production', name: '스모크 생산구역',
  purpose: '생산', kind: '생산', x: 4, y: 4, width: 24, height: 22,
  color: 'var(--color-warning-soft)', item: '', current: 0, capacity: 100, unit: 'ea', note: '수정 단계 블록',
}
const salesShipment = {
  id: 'SMOKE-SHIPMENT', orderNo: 'ORDER-SMOKE-001', channelId: 'naver', channelName: '네이버 스마트스토어',
  recipient: '스모크 수취인', phone: '010-0000-0000', address: '경북 포항시 스모크로 1',
  productName: '스모크 제품', quantity: 1, courier: '', trackingNo: '', status: '출고대기',
  orderedAt: '2026-08-21T00:00:00.000Z',
}
const leaveRequest = {
  id: 'SMOKE-LEAVE', requesterId: ADMIN_ID, name: '김서원', team: '경영지원', type: '연차',
  period: '2099-01-07', startDate: '2099-01-07', endDate: '2099-01-07', days: 1,
  reason: '스모크 점검', approverId: 'USR-SUNSEA-PARK', status: '대기',
}
const compliance = {
  id: 'SMOKE-COMPLIANCE', category: 'HACCP', name: '스모크 인증', authority: '시험기관',
  certificateNo: 'SMOKE-001', issuedAt: '2026-08-21', expiresAt: '2099-08-21', owner: '김서원',
  status: '보완필요', checklist: ['문서 확인'], attachments: [], note: '생성 단계', updatedAt: '2026-08-21T00:00:00.000Z',
}
const companyAsset = {
  id: 'SMOKE-ASSET', name: '스모크 자산', kind: '장비', serial: 'ASSET-001', acquiredAt: '2026-08-21',
  price: 100000, status: '사용 중', owner: '김서원', location: '본사', note: '생성 단계', attachments: [],
  updatedAt: '2026-08-21T00:00:00.000Z',
}
const taxEvent = {
  id: 'SMOKE-TAX', kind: '부가가치세', title: '스모크 세무 일정', dueDate: '2099-01-25', amount: 0,
  status: '예정', owner: '김서원', note: '생성 단계', attachments: [], updatedAt: '2026-08-21T00:00:00.000Z',
}
const ipRight = {
  id: 'SMOKE-IP', kind: '특허', title: '스모크 특허', number: '10-2099-0000001', holder: '스모크 법인',
  filedAt: '2098-01-01', registeredAt: '2099-01-01', expiresAt: '2099-12-31', status: '등록', owner: '김서원',
  note: '생성 단계', attachments: [], updatedAt: '2026-08-21T00:00:00.000Z',
}
const itContract = {
  id: 'SMOKE-CONTRACT', client: '스모크 거래처', title: '스모크 유지보수 계약', number: '2099-CT-001',
  startDate: '2099-01-01', endDate: '2099-12-31', amount: 1000000, attachments: [], note: '생성 단계',
  updatedAt: '2026-08-21T00:00:00.000Z',
}

const workspaceCases = [
  { screen: '일정관리', key: 'calendar-events', created: [calendarEvent], updated: [{ ...calendarEvent, title: '스모크 일정 수정' }], empty: [] },
  { screen: '업무지시·결재', key: 'work-rules', created: [workRule], updated: [{ ...workRule, title: '반복 업무 규칙 수정', active: false }], empty: [] },
  { screen: '업무지시·결재 · 상태머신 보조', key: 'work-items', created: [workItem], updated: [{ ...workItem, title: '스모크 업무 수정' }], empty: [] },
  {
    screen: '일일업무일지', key: 'daily-journals', created: [journal], updated: [{ ...journal, completed: '창고·공장 등록 스모크 점검 완료' }], empty: [],
    verify(actual, expected) {
      assert.equal(actual.length, expected.length)
      if (expected.length) {
        assert.equal(actual[0].id, expected[0].id)
        assert.equal(actual[0].completed, expected[0].completed)
        assert.equal(actual[0].status, expected[0].status)
        assert.equal(actual[0].authorId, ADMIN_ID)
      }
    },
  },
  { screen: '제품관리', key: 'product-catalog', created: [product], updated: [{ ...product, name: '스모크 제품 수정' }], empty: [] },
  { screen: '재고·LOT', key: 'inventory-locations', created: [warehouse], updated: [{ ...warehouse, name: '스모크 냉장창고 수정', utilization: 25 }], empty: [] },
  { screen: '공장관리', key: 'factory-layouts', created: { 'SMOKE-FACTORY': [] }, updated: { 'SMOKE-FACTORY': [layoutBlock] }, empty: {} },
  { screen: '판매채널', key: 'sales-shipments', created: [salesShipment], updated: [{ ...salesShipment, recipient: '스모크 수취인 수정', trackingNo: '1234567890', courier: 'CJ대한통운', status: '송장등록' }], empty: [] },
  { screen: '인사·조직', key: 'leave-requests', created: [leaveRequest], updated: [{ ...leaveRequest, reason: '스모크 점검 수정' }], empty: [] },
  { screen: '식품안전·인증', key: 'compliance-records', created: [compliance], updated: [{ ...compliance, note: '수정 단계' }], empty: [] },
  { screen: '세무·자산 · 자산대장', key: 'company-assets', created: [companyAsset], updated: [{ ...companyAsset, name: '스모크 자산 수정', note: '수정 단계' }], empty: [] },
  { screen: '세무·자산 · 세무일정', key: 'tax-events', created: [taxEvent], updated: [{ ...taxEvent, title: '스모크 세무 일정 수정', status: '신고 완료' }], empty: [] },
  { screen: '지식재산·인증', key: 'ip-rights', created: [ipRight], updated: [{ ...ipRight, title: '스모크 특허 수정', note: '수정 단계' }], empty: [] },
  { screen: '계약·거래처', key: 'it-contracts', created: [itContract], updated: [{ ...itContract, title: '스모크 계약 수정', number: '2099-CT-002' }], empty: [] },
]
const documentCase = { screen: '기업 자료실', persistenceId: 'documents-api' }
// 문서(위키)는 generic 워크스페이스 PUT이 없다(병합을 우회할 수 없게 막았다) — 자료실처럼 전용 라우트로 산다.
const wikiCase = { screen: '문서', persistenceId: 'wiki-api' }
// 양식형 전자결재도 generic PUT이 403으로 닫혀 있다(결재선·이력이 원료라 PUT 한 번으로 '승인'이 되면 안 된다).
const approvalCase = { screen: '결재 · AI 제안', persistenceId: 'approval-api' }

function emptyStore() {
  return {
    version: 2,
    tenants: { [TENANT_ID]: {} },
    platform: { tenants: [], supportTickets: [], integrations: [], actions: [], auditEvents: [] },
    accountApprovals: {}, accountCredentials: {}, invitedAccounts: [], passwordResetRequests: [],
  }
}

async function login(origin, email = 'admin@sunsea.co.kr') {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: 'tenant', email, password: 'demo1234' }),
  })
  assert.equal(response.status, 200, `${email} login`)
  return response.headers.get('set-cookie')
}

function authHeaders(cookie, contentType = true, identity = WORKSPACE_IDENTITY) {
  return {
    cookie,
    ...(contentType ? { 'content-type': 'application/json' } : {}),
    ...(identity ? { 'x-workspace-identity': identity } : {}),
  }
}

async function withRuntimeApp(storeFile, documentDirectory, callback) {
  const runtime = await initializeRuntimeStore({
    backend: 'json', jsonReadOnly: false, workspaceStoreFile: storeFile, env: {},
  })
  try {
    const app = createApp({
      apiKey: '', initialWorkspaceStore: runtime.workspaceStore, sessions: runtime.sessions,
      onWorkspaceStoreChange: (store) => runtime.adapter.commitSnapshot(store),
      workspaceStoreFile: storeFile, documentUploadDirectory: documentDirectory,
      seedPlatformFixtures: false,
    })
    await withServer(app, callback)
  } finally {
    await runtime.adapter.close()
  }
}

async function putWorkspace(origin, cookie, item, data) {
  const response = await fetch(`${origin}/api/workspace/${item.key}`, {
    method: 'PUT', headers: authHeaders(cookie), body: JSON.stringify({ data }),
  })
  const body = await response.json().catch(() => null)
  assert.equal(response.status, 200, `${item.screen} ${item.key}: ${JSON.stringify(body)}`)
}

async function readWorkspace(origin, cookie, item) {
  const response = await fetch(`${origin}/api/workspace/${item.key}`, { headers: authHeaders(cookie, false) })
  assert.equal(response.status, 200, `${item.screen} ${item.key} read`)
  return (await response.json()).data
}

function verifyWorkspace(item, actual, expected) {
  if (item.verify) item.verify(actual, expected)
  else assert.deepEqual(actual, expected, `${item.screen} persisted payload`)
}

test('all tenant write surfaces create, survive a store/app restart, update, and delete', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'onfactory-menu-smoke-'))
  const storeFile = path.join(directory, 'workspace-state.json')
  const documentDirectory = path.join(directory, 'documents')
  let documentId = ''
  let wikiId = ''
  let wikiBlockId = ''
  let approvalId = ''
  try {
    await writeFile(storeFile, JSON.stringify(emptyStore()), 'utf8')

    await withRuntimeApp(storeFile, documentDirectory, async (origin) => {
      const cookie = await login(origin)
      for (const item of workspaceCases) await putWorkspace(origin, cookie, item, item.created)
      const upload = await fetch(`${origin}/api/documents?name=${encodeURIComponent('스모크 자료.txt')}&category=${encodeURIComponent('공통자료')}&visibility=all&summary=${encodeURIComponent('자료실 대표 쓰기 항목')}`, {
        method: 'POST',
        headers: { ...authHeaders(cookie, false), 'content-type': 'application/octet-stream', 'x-file-type': 'text/plain', 'x-file-name': encodeURIComponent('smoke.txt') },
        body: Buffer.from('onfactory menu smoke'),
      })
      const body = await upload.json()
      assert.equal(upload.status, 201, JSON.stringify(body))
      documentId = body.document.id
      const wikiCreate = await fetch(`${origin}/api/wiki`, {
        method: 'POST', headers: authHeaders(cookie),
        body: JSON.stringify({ title: '스모크 문서', clientRequestId: 'WNEW-smoke-1' }),
      })
      const wikiBody = await wikiCreate.json()
      assert.equal(wikiCreate.status, 201, JSON.stringify(wikiBody))
      wikiId = wikiBody.document.id
      wikiBlockId = wikiBody.document.blocks[0].id
      // 결재는 씨앗 양식을 읽는 것에서 시작한다 — 목록 라우트가 없으면 만들지 못하는 멱등 시드다.
      const formsResponse = await fetch(`${origin}/api/approval-forms`, { headers: authHeaders(cookie, false) })
      const formsBody = await formsResponse.json()
      assert.equal(formsResponse.status, 200, JSON.stringify(formsBody))
      const seedForm = formsBody.forms.find((form) => form.id === 'AFM-SEED-EXPENSE')
      assert.ok(seedForm, '지출결의 씨앗 양식이 있어야 결재를 기안할 수 있다')
      const approvalCreate = await fetch(`${origin}/api/approval-documents`, {
        method: 'POST', headers: authHeaders(cookie),
        body: JSON.stringify({
          formId: seedForm.id,
          title: '스모크 지출결의',
          values: { spent_on: '2026-08-21', vendor: '스모크 거래처', amount: 12000, purpose: '메뉴 쓰기 점검' },
          clientRequestId: 'APD-SMOKE-1',
        }),
      })
      const approvalBody = await approvalCreate.json()
      assert.equal(approvalCreate.status, 201, JSON.stringify(approvalBody))
      assert.equal(approvalBody.document.status, '기안')
      approvalId = approvalBody.document.id
      t.diagnostic(`CREATE ${workspaceCases.length + 3}/${workspaceCases.length + 3} PASS · ${workspaceCases.map((item) => item.screen).join(', ')}, 기업 자료실, ${wikiCase.screen}, ${approvalCase.screen}`)
    })

    await withRuntimeApp(storeFile, documentDirectory, async (origin) => {
      const cookie = await login(origin)
      for (const item of workspaceCases) verifyWorkspace(item, await readWorkspace(origin, cookie, item), item.created)
      const documentsResponse = await fetch(`${origin}/api/documents`, { headers: authHeaders(cookie, false) })
      const documents = (await documentsResponse.json()).documents
      assert.equal(documentsResponse.status, 200)
      assert.equal(documents.find((item) => item.id === documentId)?.name, '스모크 자료.txt')
      const download = await fetch(`${origin}/api/documents/${encodeURIComponent(documentId)}/download`, { headers: authHeaders(cookie, false) })
      assert.equal(download.status, 200)
      assert.equal(await download.text(), 'onfactory menu smoke')
      const wikiRead = await fetch(`${origin}/api/wiki/${encodeURIComponent(wikiId)}`, { headers: authHeaders(cookie, false) })
      const wikiReadBody = await wikiRead.json()
      assert.equal(wikiRead.status, 200, JSON.stringify(wikiReadBody))
      assert.equal(wikiReadBody.document.title, '스모크 문서')
      const approvalRead = await fetch(`${origin}/api/approval-documents/${encodeURIComponent(approvalId)}`, { headers: authHeaders(cookie, false) })
      const approvalReadBody = await approvalRead.json()
      assert.equal(approvalRead.status, 200, JSON.stringify(approvalReadBody))
      assert.equal(approvalReadBody.document.title, '스모크 지출결의')
      t.diagnostic(`RESTART/PERSIST ${workspaceCases.length + 3}/${workspaceCases.length + 3} PASS · 생성 데이터와 자료 원본 유지`)

      for (const item of workspaceCases) await putWorkspace(origin, cookie, item, item.updated)
      const updateDocument = await fetch(`${origin}/api/documents/${encodeURIComponent(documentId)}`, {
        method: 'PATCH', headers: authHeaders(cookie), body: JSON.stringify({ name: '스모크 자료 수정.txt', summary: '수정 단계' }),
      })
      assert.equal(updateDocument.status, 200, await updateDocument.text())
      // 문서는 PUT이 아니라 조각(op)으로 고친다. 저장 경로가 다르니 라이프사이클도 그 문으로 지난다.
      const wikiOps = await fetch(`${origin}/api/wiki/${encodeURIComponent(wikiId)}/ops`, {
        method: 'POST', headers: authHeaders(cookie),
        body: JSON.stringify({
          baseVersion: 1, clientId: 'WCL-SMOKE',
          ops: [{ opId: 'OP-SMOKE-000001', kind: 'update', blockId: wikiBlockId, baseSeq: 1, block: { type: 'text', text: '스모크 문단 수정' } }],
        }),
      })
      const wikiOpsBody = await wikiOps.json()
      assert.equal(wikiOps.status, 200, JSON.stringify(wikiOpsBody))
      assert.deepEqual(wikiOpsBody.applied, ['OP-SMOKE-000001'])
      // 결재 기안은 generic PUT이 아니라 전용 PATCH로 고친다. version이 맞아야 지나간다.
      const approvalUpdate = await fetch(`${origin}/api/approval-documents/${encodeURIComponent(approvalId)}`, {
        method: 'PATCH', headers: authHeaders(cookie),
        body: JSON.stringify({ version: approvalReadBody.document.version, title: '스모크 지출결의 수정' }),
      })
      assert.equal(approvalUpdate.status, 200, await approvalUpdate.text())
      t.diagnostic(`UPDATE ${workspaceCases.length + 3}/${workspaceCases.length + 3} PASS · 공장 토큰색 블록 및 창고 정보 포함`)
    })

    await withRuntimeApp(storeFile, documentDirectory, async (origin) => {
      const cookie = await login(origin)
      for (const item of workspaceCases) verifyWorkspace(item, await readWorkspace(origin, cookie, item), item.updated)
      const documents = (await (await fetch(`${origin}/api/documents`, { headers: authHeaders(cookie, false) })).json()).documents
      assert.equal(documents.find((item) => item.id === documentId)?.name, '스모크 자료 수정.txt')
      const wikiAfterUpdate = await (await fetch(`${origin}/api/wiki/${encodeURIComponent(wikiId)}`, { headers: authHeaders(cookie, false) })).json()
      assert.equal(wikiAfterUpdate.document.blocks[0].text, '스모크 문단 수정')
      assert.equal(wikiAfterUpdate.document.version, 2)
      const approvalAfterUpdate = await (await fetch(`${origin}/api/approval-documents/${encodeURIComponent(approvalId)}`, { headers: authHeaders(cookie, false) })).json()
      assert.equal(approvalAfterUpdate.document.title, '스모크 지출결의 수정')
      t.diagnostic(`RESTART/UPDATE-PERSIST ${workspaceCases.length + 3}/${workspaceCases.length + 3} PASS`)

      for (const item of workspaceCases) await putWorkspace(origin, cookie, item, item.empty)
      const removeDocument = await fetch(`${origin}/api/documents/${encodeURIComponent(documentId)}`, {
        method: 'DELETE', headers: authHeaders(cookie, false),
      })
      assert.equal(removeDocument.status, 200, await removeDocument.text())
      // 문서는 보관 뒤에만 완전히 지울 수 있다 — 두 문을 모두 지나야 라이프사이클이 끝난다.
      const wikiArchive = await fetch(`${origin}/api/wiki/${encodeURIComponent(wikiId)}`, { method: 'DELETE', headers: authHeaders(cookie, false) })
      assert.equal(wikiArchive.status, 200, await wikiArchive.text())
      const wikiPurge = await fetch(`${origin}/api/wiki/${encodeURIComponent(wikiId)}?purge=1`, { method: 'DELETE', headers: authHeaders(cookie, false) })
      assert.equal(wikiPurge.status, 200, await wikiPurge.text())
      // 결재는 '기안' 상태에서만 지울 수 있다. 상신한 뒤에는 회수·반려로만 끝난다.
      const approvalDelete = await fetch(`${origin}/api/approval-documents/${encodeURIComponent(approvalId)}`, {
        method: 'DELETE', headers: authHeaders(cookie, false),
      })
      assert.equal(approvalDelete.status, 200, await approvalDelete.text())
      t.diagnostic(`DELETE ${workspaceCases.length + 3}/${workspaceCases.length + 3} PASS · 본인 임시저장 일지 및 자료 원본 포함`)
    })

    await withRuntimeApp(storeFile, documentDirectory, async (origin) => {
      const cookie = await login(origin)
      for (const item of workspaceCases) verifyWorkspace(item, await readWorkspace(origin, cookie, item), item.empty)
      const documents = (await (await fetch(`${origin}/api/documents`, { headers: authHeaders(cookie, false) })).json()).documents
      assert.equal(documents.length, 0)
      const wikiList = await (await fetch(`${origin}/api/wiki`, { headers: authHeaders(cookie, false) })).json()
      assert.equal(wikiList.documents.length, 0, '완전히 지운 문서는 재기동해도 돌아오지 않는다')
      const wikiGone = await fetch(`${origin}/api/wiki/${encodeURIComponent(wikiId)}`, { headers: authHeaders(cookie, false) })
      assert.equal(wikiGone.status, 404)
      const approvalGone = await fetch(`${origin}/api/approval-documents/${encodeURIComponent(approvalId)}`, { headers: authHeaders(cookie, false) })
      assert.equal(approvalGone.status, 404, '지운 결재 기안은 재기동해도 돌아오지 않는다')
      const approvalList = await (await fetch(`${origin}/api/approval-documents`, { headers: authHeaders(cookie, false) })).json()
      assert.equal(approvalList.documents.length, 0)
      t.diagnostic(`FINAL RESTART/EMPTY ${workspaceCases.length + 3}/${workspaceCases.length + 3} PASS · 삭제 후 재등장 없음`)
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('journal draft deletion is owner-only and never removes submitted approval records', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'onfactory-journal-delete-rbac-'))
  const storeFile = path.join(directory, 'workspace-state.json')
  try {
    await writeFile(storeFile, JSON.stringify(emptyStore()), 'utf8')
    await withRuntimeApp(storeFile, path.join(directory, 'documents'), async (origin) => {
      const adminCookie = await login(origin)
      const submitted = { ...journal, id: 'RBAC-SUBMITTED', title: '제출 일지', status: '결재요청', completed: '제출 완료 업무' }
      const adminDraft = { ...journal, id: 'RBAC-ADMIN-DRAFT', title: '관리자 초안', date: '2026-08-22' }
      const initial = await fetch(`${origin}/api/workspace/daily-journals`, {
        method: 'PUT', headers: authHeaders(adminCookie), body: JSON.stringify({ data: [adminDraft, submitted] }),
      })
      assert.equal(initial.status, 200, await initial.text())

      const memberCookie = await login(origin, 'jihyun.park@sunsea.co.kr')
      const memberIdentity = `${TENANT_ID}:USR-SUNSEA-PARK`
      const memberDraft = { ...journal, id: 'RBAC-MEMBER-DRAFT', title: '직원 초안', authorId: 'USR-SUNSEA-PARK', author: '박지현', department: '품질관리' }
      const addMemberDraft = await fetch(`${origin}/api/workspace/daily-journals`, {
        method: 'PUT', headers: authHeaders(memberCookie, true, memberIdentity), body: JSON.stringify({ data: [memberDraft] }),
      })
      assert.equal(addMemberDraft.status, 200, await addMemberDraft.text())

      const all = (await (await fetch(`${origin}/api/workspace/daily-journals`, { headers: authHeaders(adminCookie, false) })).json()).data
      const byId = new Map(all.map((item) => [item.id, item]))
      const withoutSubmitted = [byId.get('RBAC-ADMIN-DRAFT'), byId.get('RBAC-MEMBER-DRAFT')]
      const rejectSubmittedDelete = await fetch(`${origin}/api/workspace/daily-journals`, {
        method: 'PUT', headers: authHeaders(adminCookie), body: JSON.stringify({ data: withoutSubmitted }),
      })
      assert.equal(rejectSubmittedDelete.status, 403)

      const withoutColleagueDraft = [byId.get('RBAC-ADMIN-DRAFT'), byId.get('RBAC-SUBMITTED')]
      const rejectColleagueDelete = await fetch(`${origin}/api/workspace/daily-journals`, {
        method: 'PUT', headers: authHeaders(adminCookie), body: JSON.stringify({ data: withoutColleagueDraft }),
      })
      assert.equal(rejectColleagueDelete.status, 403)

      const deleteOwnDraft = await fetch(`${origin}/api/workspace/daily-journals`, {
        method: 'PUT', headers: authHeaders(adminCookie), body: JSON.stringify({ data: [byId.get('RBAC-SUBMITTED'), byId.get('RBAC-MEMBER-DRAFT')] }),
      })
      assert.equal(deleteOwnDraft.status, 200, await deleteOwnDraft.text())

      const deleteMemberOwnDraft = await fetch(`${origin}/api/workspace/daily-journals`, {
        method: 'PUT', headers: authHeaders(memberCookie, true, memberIdentity), body: JSON.stringify({ data: [] }),
      })
      assert.equal(deleteMemberOwnDraft.status, 200, await deleteMemberOwnDraft.text())

      const final = (await (await fetch(`${origin}/api/workspace/daily-journals`, { headers: authHeaders(adminCookie, false) })).json()).data
      assert.deepEqual(final.map((item) => item.id), ['RBAC-SUBMITTED'])
      assert.equal(final[0].status, '결재요청')
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a failed adapter commit rolls back the active workspace snapshot', async () => {
  const state = emptyStore()
  await withServer(createApp({
    apiKey: '', initialWorkspaceStore: state, seedPlatformFixtures: false,
    onWorkspaceStoreChange: () => { throw new Error('simulated adapter failure') },
  }), async (origin) => {
    const cookie = await login(origin)
    const failedWrite = await fetch(`${origin}/api/workspace/inventory-locations`, {
      method: 'PUT', headers: authHeaders(cookie), body: JSON.stringify({ data: [warehouse] }),
    })
    assert.equal(failedWrite.status, 500)
    assert.equal((await failedWrite.json()).error.code, 'STORE_WRITE_FAILED')

    const afterFailure = await fetch(`${origin}/api/workspace/inventory-locations`, {
      headers: authHeaders(cookie, false),
    })
    assert.equal(afterFailure.status, 200)
    assert.equal((await afterFailure.json()).data, null)
    assert.equal(state.tenants[TENANT_ID]['inventory-locations'], undefined)
  })
})

import { randomBytes } from 'node:crypto'

import {
  APPROVAL_ERRORS,
  ATTACHMENT_ID_RE,
  DEFAULT_POSTING_MONTHS,
  MAX_ATTACHMENTS,
  MAX_CC,
  MAX_DOCUMENTS_PER_TENANT,
  MAX_FORMS_PER_TENANT,
  MAX_HISTORY,
  MAX_TITLE,
  applyApprovalDecision,
  approvalPosting,
  approvalSeatFor,
  canDecide,
  canEditDraft,
  canRecall,
  newApprovalId,
  normalizeApprovalForm,
  normalizeApprovalLine,
  normalizeApprovalValues,
  normalizeDelegate,
  pendingApproverIds,
  summarizePostings,
} from './approval-routing.mjs'
import { renderApprovalMarkdown, renderApprovalPrintHtml } from './approval-print.mjs'
import { billingDate } from './billing-service.mjs'
import { GUEST_ROLE, GUEST_SCOPE_FORBIDDEN } from './guest-access.mjs'

/**
 * 양식형 전자결재 — HTTP 표면.
 *
 * 판정은 하나도 여기서 하지 않는다. 「누가 결재할 차례인가」·「이 값이 양식에 맞는가」·
 * 「이 승인으로 문서가 끝났는가」는 전부 approval-routing.mjs 의 순수 함수가 답하고,
 * 이 파일은 **세션에서 사람을 읽고, 저장소에서 줄을 읽고, 그 답을 HTTP 로 옮기는 일**만 한다.
 * 그래서 같은 판정이 목록·배지·결재·인쇄에서 갈릴 자리가 없다.
 *
 * 이 파일이 지키는 것 넷:
 *
 * 1) **볼 수 없는 문서는 404다.** 결재선에는 급여·단가·거래처가 적힌다. 「권한이 없습니다」는
 *    그 문서가 있다는 사실 자체를 알려 주므로, 못 보는 사람에게는 없는 문서와 같은 답을 준다.
 *    볼 수는 있는데 못 하는 일(남의 기안을 고치기 등)만 403이다.
 * 2) **id·기안자·시각은 본문에서 오지 않는다.** 본문이 정하는 것은 「무엇을 적었는가」뿐이다.
 * 3) **한 쓰기에 딸린 부수효과는 한 커밋에 들어간다.** 승인 한 번이 결재 문서와 자료 목록 두 키를
 *    함께 쓰고, 커밋이 실패하면 둘 다 되돌아가며 저장소에 쓴 증빙 파일도 지운다.
 * 4) **generic 저장소 라우트는 닫혀 있다.** 결재선·이력이 원료이므로 PUT 한 번으로 status 를
 *    '승인'으로 바꿀 길이 있으면 이 파일의 판정 전체가 장식이 된다(app.mjs 의 APPROVAL_ONLY_KEYS).
 */

const FORMS_KEY = 'approval-forms'
const DOCUMENTS_KEY = 'approval-documents'
const SEED_FORM_ID = 'AFM-SEED-EXPENSE'
/** 자료실 문서 한 건이 가질 수 있는 태그 수. server/app.mjs 의 PATCH 가 `slice(0, 20)` 으로 자르는 그 값이다. */
const MAX_DOCUMENT_TAGS = 20
const APPROVAL_STATUS_SET = new Set(['기안', '결재중', '승인', '반려', '회수'])
const SCOPES = new Set(['waiting', 'drafted', 'cc', 'all'])
const MAX_LIST_LIMIT = 100
const CLIENT_REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,120}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 오류 코드 → HTTP 상태. 적히지 않은 것은 400 이다.
 * 403 과 409 를 가르는 기준: 403 은 「당신이 할 일이 아니다」(사람이 바뀌면 된다),
 * 409 는 「지금 이 문서의 상태에서 할 수 없다」(문서가 바뀌어야 한다).
 */
const ERROR_STATUS = new Map([
  [APPROVAL_ERRORS.NOT_APPROVER.code, 403],
  [APPROVAL_ERRORS.SEAT_TAKEN.code, 403],
  [APPROVAL_ERRORS.ALREADY_DECIDED.code, 409],
  [APPROVAL_ERRORS.LINE_BROKEN.code, 409],
  [APPROVAL_ERRORS.RECALL_FORBIDDEN.code, 409],
  [APPROVAL_ERRORS.NOT_EDITABLE.code, 409],
  [APPROVAL_ERRORS.DELEGATE_CYCLE.code, 409],
])

const NOT_FOUND = { code: 'APPROVAL_DOCUMENT_NOT_FOUND', message: '결재 문서를 찾을 수 없거나 열람 권한이 없습니다.' }
const FORM_NOT_FOUND = { code: 'APPROVAL_FORM_NOT_FOUND', message: '결재 양식을 찾을 수 없습니다.' }
const WRITE_FAILED = { code: 'APPROVAL_WRITE_FAILED', message: '결재 내용을 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }
const DRAFTER_REQUIRED = { code: 'APPROVAL_DRAFTER_REQUIRED', message: '기안자만 할 수 있습니다.' }

const CONTROL_RE = /[\x00-\x09\x0B-\x1F\x7F]/g

/** 사람이 읽는 문자열 한 칸. approval-routing 의 clip 과 같은 규칙이다(줄바꿈만 남기고 자른다). */
function clip(value, max) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n').replace(CONTROL_RE, '').trim().slice(0, max)
  return /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text
}

/** 파일 이름 한 칸. 경로 구분자와 따옴표를 지운다 — 저장소 키와 다운로드 헤더 둘 다에 실린다. */
function safeFileName(value, fallback) {
  const text = String(value ?? '').replace(/[\r\n"/\\]/g, '_').trim().slice(0, 160)
  return text || fallback
}

const pushHistory = (history, entry) => [...(Array.isArray(history) ? history : []), entry].slice(-MAX_HISTORY)

const errorBody = (error) => ({
  code: error.code,
  message: error.message,
  ...(error.key !== undefined ? { key: error.key } : {}),
  ...(error.reason !== undefined ? { reason: error.reason } : {}),
})

/**
 * 지출결의 씨앗. 고정 id 라 **없을 때만** 만들어지고, 관리자가 비활성화하면 `active:false` 로 남아
 * 되살아나지 않는다. `defaultLine` 이 빈 이유: 씨앗에 실명·계정 id 를 넣으면 그 순간 데모 데이터가 된다.
 */
const SEED_FORM_INPUT = Object.freeze({
  name: '지출결의서',
  kind: '지출결의',
  description: '쓴 돈을 증빙과 함께 결재받고, 승인되면 세무 증빙함에 그대로 쌓입니다.',
  fields: [
    { key: 'spent_on', label: '지출일', type: 'date', required: true },
    { key: 'vendor', label: '거래처', type: 'text', required: true },
    { key: 'amount', label: '금액', type: 'money', required: true, help: '원 단위로 적어 주세요.' },
    { key: 'purpose', label: '용도', type: 'text', required: true },
    { key: 'receipt', label: '영수증', type: 'attachment', required: false },
  ],
  defaultLine: [],
  ccIds: [],
  amountFieldKey: 'amount',
  evidenceCategory: '경비',
})

export function registerApprovalRoutes({
  app,
  requireAuth,
  requireTenantAdmin,
  requireMatchingWorkspaceIdentity,
  workspaceStore,
  accounts,
  commitWorkspaceStore,
  notify,
  documentStorage,
  documentRecord,
  stageDocumentList,
  putTenantDocument,
  deleteTenantDocument,
  canReadDocument,
  workspaceRecordVersion,
  operatorAwareAccounts,
  clock = () => new Date(),
} = {}) {
  const guards = [requireAuth, requireMatchingWorkspaceIdentity]

  const rowsOf = (tenantId, key) => {
    const data = workspaceStore.tenants?.[tenantId]?.[key]?.data
    return Array.isArray(data) ? data : []
  }
  const formsOf = (tenantId) => rowsOf(tenantId, FORMS_KEY)
    .filter((row) => row && typeof row === 'object' && !Array.isArray(row) && row.recordType !== 'delegate' && typeof row.id === 'string')
  const delegateRowsOf = (tenantId) => rowsOf(tenantId, FORMS_KEY)
    .filter((row) => row?.recordType === 'delegate' && typeof row.accountId === 'string')
  const documentRowsOf = (tenantId) => rowsOf(tenantId, DOCUMENTS_KEY)
  const documentsOf = (tenantId) => documentRowsOf(tenantId)
    .filter((row) => row && typeof row === 'object' && !Array.isArray(row) && typeof row.id === 'string')

  /**
   * 키 하나를 쓰고 커밋한다. 실패하면 **그 키만** 이전 값으로 되돌린다 —
   * 테넌트 객체 전체를 되돌리면 같은 커밋에 실린 다른 키의 변경까지 함께 사라진다.
   */
  const writeRows = async (tenantId, key, rows, accountId, now) => {
    const tenantStore = workspaceStore.tenants[tenantId] ??= {}
    const previous = tenantStore[key]
    tenantStore[key] = { data: rows, updatedAt: now, updatedBy: accountId }
    try {
      await commitWorkspaceStore()
      return true
    } catch {
      if (previous === undefined) delete tenantStore[key]
      else tenantStore[key] = previous
      return false
    }
  }

  /** 결재자로 지정할 수 있는 계정. 게스트와 미승인 계정은 결재선에 설 수 없다. */
  const accountIndexOf = (auth) => new Map(
    (typeof operatorAwareAccounts === 'function' ? operatorAwareAccounts(auth) : accounts)
      .filter((account) => account?.tenantId === auth.tenantId && account?.approved !== false
        && (account?.role === 'tenant-admin' || account?.role === 'tenant-member'))
      .map((account) => [String(account.id), String(account.name ?? '')]),
  )

  /**
   * 이 사람이 **오늘** 대신 결재해 줄 수 있는 원결재자들.
   * 기간 밖 대결은 없는 것과 같다 — 휴가가 끝난 사람의 대결자가 계속 결재하면 결재선이 거짓말이 된다.
   * 대결의 대결은 여기서 만들지 않는다(한 단계). 사슬은 normalizeDelegate 가 쓰기 시점에 막는다.
   */
  const delegateForOf = (tenantId, accountId, today) => new Set(
    delegateRowsOf(tenantId)
      .filter((row) => row.delegateId === accountId
        && DATE_RE.test(String(row.from ?? '')) && DATE_RE.test(String(row.to ?? ''))
        && row.from <= today && today <= row.to)
      .map((row) => row.accountId),
  )

  /**
   * 이 문서를 볼 수 있는가. 넷째 절이 `decidedById` 인 이유: 자리에 남는 `delegateOf` 는
   * **원결재자** id 라서 대결로 실제 결재한 사람에게는 결코 참이 되지 않는다. 마지막 절(대결 기간)은
   * 기간이 끝나는 순간 거짓이 되므로, 이 한 줄이 없으면 대결로 승인한 사람이 자기가 승인한 문서를
   * 다음 날 못 본다.
   */
  const canReadApprovalDocument = (document, auth, delegateFor) => {
    if (!document) return false
    if (auth.role === 'tenant-admin') return true
    if (document.drafterId === auth.id) return true
    if (Array.isArray(document.ccIds) && document.ccIds.includes(auth.id)) return true
    const steps = Array.isArray(document.line) ? document.line : []
    const approvers = steps.flatMap((step) => (Array.isArray(step?.approvers) ? step.approvers : []))
    if (approvers.some((approver) => approver?.accountId === auth.id || approver?.decidedById === auth.id)) return true
    return approvers.some((approver) => delegateFor.has(approver?.accountId))
  }

  const gate = (request, response) => {
    const auth = request.auth
    if (!auth?.tenantId) {
      response.status(403).json({ error: { code: 'TENANT_REQUIRED', message: '고객사 워크스페이스에서만 사용할 수 있습니다.' } })
      return null
    }
    // 게이트가 먼저 막지만 이 라우트 혼자서도 같은 결론을 내야 한다(이중 방어).
    if (auth.role === GUEST_ROLE) {
      response.status(403).json({ error: GUEST_SCOPE_FORBIDDEN })
      return null
    }
    return auth
  }

  const fail = (response, error) => {
    response.status(ERROR_STATUS.get(error?.code) ?? 400).json({ error: errorBody(error) })
  }

  /**
   * 지출결의 씨앗을 한 번만 심는다. 커밋이 실패하면 심지 않은 것으로 되돌아가고 목록은 그대로 나간다 —
   * 「양식 목록을 못 봤다」보다 「기본 양식이 아직 없다」가 사용자에게 덜 나쁘고, 다음 조회에서 다시 시도된다.
   */
  const seedExpenseForm = async (auth, now) => {
    const rows = rowsOf(auth.tenantId, FORMS_KEY)
    if (rows.some((row) => row?.id === SEED_FORM_ID)) return
    const seeded = normalizeApprovalForm(SEED_FORM_INPUT, {
      actor: { id: 'system', name: '기본 양식' },
      now,
      previous: { id: SEED_FORM_ID, version: 0, createdById: 'system', createdByName: '기본 양식', createdAt: now, active: true },
    })
    if (seeded.error) return
    await writeRows(auth.tenantId, FORMS_KEY, [seeded.form, ...rows], 'system:approval-seed', now)
  }

  /** 양식이 「첨부」로 받는 항목에 든 DOC- 값. 첨부 배열과 함께 참조·권한·증빙 태그의 대상이 된다. */
  const attachmentValueIds = (document, form) => {
    const fields = Array.isArray(form?.fields) ? form.fields : []
    const values = document?.values && typeof document.values === 'object' ? document.values : {}
    return fields
      .filter((field) => field?.type === 'attachment')
      .map((field) => values[field.key])
      .filter((value) => typeof value === 'string' && ATTACHMENT_ID_RE.test(value))
  }

  const attachmentIdsOf = (document, form) => [...new Set([
    ...(Array.isArray(document?.attachments) ? document.attachments : []).filter((id) => typeof id === 'string'),
    ...attachmentValueIds(document, form),
  ])]

  /**
   * 첨부 목록. 구조가 어긋나면 거절하고, **읽을 수 없는 자료를 가리키면 거절한다** —
   * 열지 못하는 파일을 결재에 붙일 수 있으면 결재 첨부가 남의 자료를 훔쳐보는 창구가 된다.
   */
  const normalizeAttachments = (value) => {
    if (value == null) return { attachments: [] }
    if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) return { error: { ...APPROVAL_ERRORS.VALUE_INVALID, key: 'attachments' } }
    const ids = value.map((entry) => String(entry ?? '').trim())
    if (ids.some((id) => !ATTACHMENT_ID_RE.test(id))) return { error: { ...APPROVAL_ERRORS.VALUE_INVALID, key: 'attachments' } }
    return { attachments: [...new Set(ids)] }
  }

  const forbiddenAttachment = (ids, auth) => {
    if (!ids.length) return false
    const documents = Array.isArray(documentRecord(auth.tenantId)?.data) ? documentRecord(auth.tenantId).data : []
    const byId = new Map(documents.map((document) => [document?.id, document]))
    return ids.some((id) => !canReadDocument(byId.get(id), auth))
  }

  const normalizeCcIds = (value, index) => {
    if (value == null) return { ccIds: [] }
    if (!Array.isArray(value) || value.length > MAX_CC) return { error: { ...APPROVAL_ERRORS.VALUE_INVALID, key: 'ccIds' } }
    const ids = [...new Set(value.map((entry) => String(entry ?? '').trim()).filter(Boolean))]
    if (ids.some((id) => !index.has(id))) return { error: { ...APPROVAL_ERRORS.VALUE_INVALID, key: 'ccIds' } }
    return { ccIds: ids }
  }

  const publicForm = (form) => ({ id: form.id, name: form.name, kind: form.kind, active: form.active !== false })

  const summaryOf = (documents, auth, delegateFor, seenAt) => {
    const readable = documents.filter((document) => canReadApprovalDocument(document, auth, delegateFor))
    return {
      waitingOnMe: readable.filter((document) => canDecide(document, auth.id, delegateFor)).length,
      drafted: readable.filter((document) => document.drafterId === auth.id).length,
      cc: readable.filter((document) => Array.isArray(document.ccIds) && document.ccIds.includes(auth.id)).length,
      // 최종 승인에는 알림 유형을 만들지 않는다(구버전 롤백이 그 테넌트 알림 전체를 무효화한다).
      // 대신 「내가 올린 것」이 마지막으로 본 시각 뒤에 끝났는지를 센다 — 반려만 알리고 승인은 침묵하는
      // 비대칭을 남기지 않으려는 것이므로, 승인과 반려를 함께 센다.
      decidedUnread: readable.filter((document) => document.drafterId === auth.id
        && (document.status === '승인' || document.status === '반려')
        && typeof document.completedAt === 'string' && document.completedAt
        && (!seenAt || document.completedAt > seenAt)).length,
    }
  }

  // ── 1. 양식 목록 ────────────────────────────────────────────────────────────
  app.get('/api/approval-forms', ...guards, async (request, response) => {
    const auth = gate(request, response)
    if (!auth) return
    const now = clock().toISOString()
    try { await seedExpenseForm(auth, now) } catch { /* 씨앗 실패가 목록 조회를 막지 않는다 */ }
    const isAdmin = auth.role === 'tenant-admin'
    const wantsAll = String(request.query.all ?? '') === '1' && isAdmin
    const forms = formsOf(auth.tenantId).filter((form) => wantsAll || form.active !== false)
    const delegate = delegateRowsOf(auth.tenantId).find((row) => row.accountId === auth.id) ?? null
    response.json({ forms, delegate, canManage: isAdmin })
  })

  // ── 2. 양식 만들기 ──────────────────────────────────────────────────────────
  app.post('/api/approval-forms', requireAuth, requireTenantAdmin, requireMatchingWorkspaceIdentity, async (request, response) => {
    const auth = gate(request, response)
    if (!auth) return
    const now = clock().toISOString()
    const rows = rowsOf(auth.tenantId, FORMS_KEY)
    if (formsOf(auth.tenantId).length >= MAX_FORMS_PER_TENANT) {
      response.status(409).json({ error: { code: 'APPROVAL_FORM_LIMIT', message: `양식은 회사당 ${MAX_FORMS_PER_TENANT}개까지 만들 수 있습니다. 쓰지 않는 양식을 정리해 주세요.` } })
      return
    }
    const result = normalizeApprovalForm(request.body, { actor: auth, now })
    if (result.error) { fail(response, result.error); return }
    if (!await writeRows(auth.tenantId, FORMS_KEY, [result.form, ...rows], auth.id, now)) {
      response.status(500).json({ error: WRITE_FAILED })
      return
    }
    response.status(201).json({ form: result.form })
  })

  // ── 3. 양식 고치기 ──────────────────────────────────────────────────────────
  app.patch('/api/approval-forms/:id', requireAuth, requireTenantAdmin, requireMatchingWorkspaceIdentity, async (request, response) => {
    const auth = gate(request, response)
    if (!auth) return
    const now = clock().toISOString()
    const rows = rowsOf(auth.tenantId, FORMS_KEY)
    const index = rows.findIndex((row) => row?.id === request.params.id && row?.recordType !== 'delegate')
    if (index < 0) { response.status(404).json({ error: FORM_NOT_FOUND }); return }
    const previous = rows[index]
    if (!Number.isInteger(request.body?.version) || request.body.version !== previous.version) {
      response.status(409).json({ error: { code: 'APPROVAL_FORM_VERSION_CONFLICT', message: '다른 곳에서 먼저 저장되었습니다. 최신 내용을 불러온 뒤 다시 시도해 주세요.', currentVersion: previous.version } })
      return
    }
    const result = normalizeApprovalForm(request.body, { actor: auth, now, previous })
    if (result.error) { fail(response, result.error); return }
    const next = rows.map((row, position) => (position === index ? result.form : row))
    if (!await writeRows(auth.tenantId, FORMS_KEY, next, auth.id, now)) {
      response.status(500).json({ error: WRITE_FAILED })
      return
    }
    response.json({ form: result.form })
  })

  // ── 4. 양식 내리기 ──────────────────────────────────────────────────────────
  // 행을 지우지 않는다. 이미 돌고 있는 문서가 이 양식의 이름과 항목 라벨을 가리키고 있어,
  // 지우면 진행 중인 결재의 인쇄물에서 항목 이름이 통째로 사라진다.
  app.delete('/api/approval-forms/:id', requireAuth, requireTenantAdmin, requireMatchingWorkspaceIdentity, async (request, response) => {
    const auth = gate(request, response)
    if (!auth) return
    const now = clock().toISOString()
    const rows = rowsOf(auth.tenantId, FORMS_KEY)
    const index = rows.findIndex((row) => row?.id === request.params.id && row?.recordType !== 'delegate')
    if (index < 0) { response.status(404).json({ error: FORM_NOT_FOUND }); return }
    const previous = rows[index]
    const next = rows.map((row, position) => (position === index
      ? { ...previous, active: false, updatedAt: now, updatedById: auth.id, version: Number.isFinite(previous.version) ? previous.version + 1 : 1 }
      : row))
    if (!await writeRows(auth.tenantId, FORMS_KEY, next, auth.id, now)) {
      response.status(500).json({ error: WRITE_FAILED })
      return
    }
    response.json({ ok: true, deactivated: true })
  })

  // ── 5·6. 대결자 지정 ────────────────────────────────────────────────────────
  const putDelegate = async (request, response, targetId) => {
    const auth = gate(request, response)
    if (!auth) return
    const now = clock().toISOString()
    const index = accountIndexOf(auth)
    if (!index.has(targetId)) {
      response.status(404).json({ error: { code: 'APPROVAL_ACCOUNT_NOT_FOUND', message: '해당 계정을 찾을 수 없습니다.' } })
      return
    }
    const rows = rowsOf(auth.tenantId, FORMS_KEY)
    const existing = delegateRowsOf(auth.tenantId)
    const delegateId = request.body?.delegateId
    // 비우기. 「대결을 그만둔다」는 「대결자를 잘못 골랐다」와 다른 요청이라 검증을 지나지 않는다.
    if (delegateId == null || delegateId === '') {
      const next = rows.filter((row) => !(row?.recordType === 'delegate' && row.accountId === targetId))
      if (next.length !== rows.length && !await writeRows(auth.tenantId, FORMS_KEY, next, auth.id, now)) {
        response.status(500).json({ error: WRITE_FAILED })
        return
      }
      response.json({ delegate: null })
      return
    }
    const result = normalizeDelegate(request.body, { accountId: targetId, accounts: index, now, actor: auth, existingDelegates: existing })
    if (result.error) { fail(response, result.error); return }
    const position = rows.findIndex((row) => row?.recordType === 'delegate' && row.accountId === targetId)
    const next = position < 0 ? [...rows, result.delegate] : rows.map((row, at) => (at === position ? result.delegate : row))
    if (!await writeRows(auth.tenantId, FORMS_KEY, next, auth.id, now)) {
      response.status(500).json({ error: WRITE_FAILED })
      return
    }
    response.json({ delegate: result.delegate })
  }

  app.put('/api/approval-delegates/me', ...guards, (request, response) => putDelegate(request, response, request.auth?.id ?? ''))
  // 휴가로 갑자기 빠진 사람 때문에 결재가 멈추는 것을 풀 사람이 필요하다(D17).
  app.put('/api/approval-delegates/:accountId', requireAuth, requireTenantAdmin, requireMatchingWorkspaceIdentity, (request, response) => putDelegate(request, response, String(request.params.accountId ?? '')))

  // ── 7. 문서 목록 ────────────────────────────────────────────────────────────
  app.get('/api/approval-documents', ...guards, (request, response) => {
    const auth = gate(request, response)
    if (!auth) return
    const now = clock().toISOString()
    const delegateFor = delegateForOf(auth.tenantId, auth.id, billingDate(now))
    const all = documentsOf(auth.tenantId)
    const readable = all.filter((document) => canReadApprovalDocument(document, auth, delegateFor))
    // scope 를 주지 않으면 「볼 수 있는 전부」다. 기본값을 waiting 으로 두면 documents 라는 이름의
    // 응답 칸이 요청마다 다른 뜻이 되고, 그 사실은 응답 어디에도 적히지 않는다.
    const scope = SCOPES.has(String(request.query.scope ?? '')) ? String(request.query.scope) : 'all'
    const status = APPROVAL_STATUS_SET.has(String(request.query.status ?? '')) ? String(request.query.status) : ''
    const requested = Number(request.query.limit)
    const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_LIST_LIMIT) : MAX_LIST_LIMIT
    const scoped = readable.filter((document) => {
      if (scope === 'waiting') return canDecide(document, auth.id, delegateFor)
      if (scope === 'drafted') return document.drafterId === auth.id
      if (scope === 'cc') return Array.isArray(document.ccIds) && document.ccIds.includes(auth.id)
      return true
    }).filter((document) => !status || document.status === status)
    const documents = [...scoped]
      .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))
      .slice(0, limit)
    response.json({
      documents,
      // 자른 배열의 길이를 세지 않는다. summary 는 「볼 수 있는 전부」를 세고, documents 는 그중 limit 개다.
      summary: summaryOf(all, auth, delegateFor, ''),
      total: scoped.length,
      forms: formsOf(auth.tenantId).map(publicForm),
      version: workspaceRecordVersion(workspaceStore.tenants?.[auth.tenantId]?.[DOCUMENTS_KEY]),
    })
  })

  // ── 8. 배지·탭 점 전용 저비용 경로 ──────────────────────────────────────────
  app.get('/api/approval-documents/summary', ...guards, (request, response) => {
    const auth = gate(request, response)
    if (!auth) return
    const now = clock().toISOString()
    const delegateFor = delegateForOf(auth.tenantId, auth.id, billingDate(now))
    const seenAt = String(request.query.seenAt ?? '').trim()
    response.json(summaryOf(documentsOf(auth.tenantId), auth, delegateFor, Number.isFinite(Date.parse(seenAt)) ? seenAt : ''))
  })

  // ── 9. 승인된 지출 집계 ─────────────────────────────────────────────────────
  app.get('/api/approval-documents/postings', ...guards, (request, response) => {
    const auth = gate(request, response)
    if (!auth) return
    const now = clock().toISOString()
    const isAdmin = auth.role === 'tenant-admin'
    const raw = request.query.months
    const months = raw === undefined || raw === '' ? DEFAULT_POSTING_MONTHS : Number(raw)
    // 창 크기는 자르지 않고 거절한다 — 36개월을 달라고 한 화면이 24개월을 받고도 잘렸다는 것을 알 길이 없다.
    const result = summarizePostings(documentsOf(auth.tenantId), { months, now, scopeIds: isAdmin ? null : [auth.id] })
    if (result.error) { fail(response, result.error); return }
    response.json({ months: result.months, scope: isAdmin ? 'tenant' : 'mine' })
  })

  const findDocument = (auth, id, delegateFor) => {
    const rows = documentRowsOf(auth.tenantId)
    const index = rows.findIndex((row) => row?.id === id)
    if (index < 0) return null
    const document = rows[index]
    if (!canReadApprovalDocument(document, auth, delegateFor)) return null
    return { rows, index, document }
  }

  // ── 10. 문서 한 건 ──────────────────────────────────────────────────────────
  app.get('/api/approval-documents/:id', ...guards, (request, response) => {
    const auth = gate(request, response)
    if (!auth) return
    const now = clock().toISOString()
    const delegateFor = delegateForOf(auth.tenantId, auth.id, billingDate(now))
    const found = findDocument(auth, request.params.id, delegateFor)
    if (!found) { response.status(404).json({ error: NOT_FOUND }); return }
    const { document } = found
    const form = formsOf(auth.tenantId).find((entry) => entry.id === document.formId) ?? null
    const seat = approvalSeatFor(document, { actorId: auth.id, delegateFor })
    response.json({
      document,
      form,
      permissions: {
        canDecide: Boolean(seat.seat),
        canRecall: canRecall(document, auth.id),
        canEdit: canEditDraft(document, auth.id),
        canDelete: (document.drafterId === auth.id || auth.role === 'tenant-admin') && document.status === '기안',
      },
      delegateOf: seat.delegateOf ?? null,
    })
  })

  // ── 11. 기안 ────────────────────────────────────────────────────────────────
  app.post('/api/approval-documents', ...guards, async (request, response) => {
    const auth = gate(request, response)
    if (!auth) return
    const now = clock().toISOString()
    const rows = documentRowsOf(auth.tenantId)
    const clientRequestId = clip(request.body?.clientRequestId, 120)
    if (clientRequestId && !CLIENT_REQUEST_ID_RE.test(clientRequestId)) {
      fail(response, { ...APPROVAL_ERRORS.VALUE_INVALID, key: 'clientRequestId' })
      return
    }
    // 같은 요청을 두 번 보낸 것과 두 건을 올린 것은 다른 사실이다. 재시도는 새 문서를 만들지 않는다.
    if (clientRequestId) {
      const replayed = rows.find((row) => row?.clientRequestId === clientRequestId && row?.drafterId === auth.id)
      if (replayed) { response.json({ document: replayed, replayed: true }); return }
    }
    if (documentsOf(auth.tenantId).length >= MAX_DOCUMENTS_PER_TENANT) {
      response.status(409).json({ error: { code: 'APPROVAL_DOCUMENT_LIMIT', message: `결재 문서는 회사당 ${MAX_DOCUMENTS_PER_TENANT}건까지 보관합니다. 관리자에게 정리를 요청해 주세요.` } })
      return
    }
    const form = formsOf(auth.tenantId).find((entry) => entry.id === String(request.body?.formId ?? ''))
    if (!form) { response.status(404).json({ error: FORM_NOT_FOUND }); return }
    if (form.active === false) {
      response.status(409).json({ error: { code: 'APPROVAL_FORM_INACTIVE', message: '더 이상 쓰지 않는 양식입니다. 다른 양식을 골라 주세요.' } })
      return
    }
    const title = clip(request.body?.title, MAX_TITLE)
    if (!title) { fail(response, { ...APPROVAL_ERRORS.VALUE_REQUIRED, key: 'title' }); return }
    const values = normalizeApprovalValues(form, request.body?.values)
    if (values.error) { fail(response, values.error); return }
    const attachments = normalizeAttachments(request.body?.attachments)
    if (attachments.error) { fail(response, attachments.error); return }
    const index = accountIndexOf(auth)
    const cc = normalizeCcIds(request.body?.ccIds, index)
    if (cc.error) { fail(response, cc.error); return }
    const submit = request.body?.submit === true
    const line = normalizeApprovalLine(request.body?.line, {
      drafterId: auth.id, approverIds: index, defaultLine: form.defaultLine, requireSteps: submit,
    })
    if (line.error) { fail(response, line.error); return }

    const draft = {
      id: newApprovalId('APD', now),
      formId: form.id,
      formName: form.name,
      formVersion: form.version,
      kind: form.kind,
      title,
      values: values.values,
      attachments: attachments.attachments,
      line: line.line,
      ccIds: cc.ccIds,
      drafterId: auth.id,
      drafterName: clip(auth.name, MAX_TITLE),
      status: submit ? '결재중' : '기안',
      currentStep: submit ? line.line[0].step : 0,
      rejectionReason: '',
      evidenceId: null,
      posting: null,
      history: [{ at: now, actorId: auth.id, actorName: clip(auth.name, MAX_TITLE), action: submit ? '상신' : '기안', comment: '', delegateOf: null }],
      version: 1,
      clientRequestId,
      createdAt: now,
      updatedAt: now,
      submittedAt: submit ? now : null,
      completedAt: null,
    }
    // 열지 못하는 자료를 결재에 붙일 수 없다 — 첨부 배열과 「첨부」 항목 값을 같은 잣대로 본다.
    if (forbiddenAttachment(attachmentIdsOf(draft, form), auth)) {
      response.status(400).json({ error: { code: 'APPROVAL_ATTACHMENT_FORBIDDEN', message: '열람할 수 없는 자료는 결재에 첨부할 수 없습니다.' } })
      return
    }
    if (!await writeRows(auth.tenantId, DOCUMENTS_KEY, [draft, ...rows], auth.id, now)) {
      response.status(500).json({ error: WRITE_FAILED })
      return
    }
    if (submit) announceStep(auth, draft, form, now)
    response.status(201).json({ document: draft })
  })

  // ── 12. 기안 고치기 ─────────────────────────────────────────────────────────
  app.patch('/api/approval-documents/:id', ...guards, async (request, response) => {
    const auth = gate(request, response)
    if (!auth) return
    const now = clock().toISOString()
    const delegateFor = delegateForOf(auth.tenantId, auth.id, billingDate(now))
    const found = findDocument(auth, request.params.id, delegateFor)
    if (!found) { response.status(404).json({ error: NOT_FOUND }); return }
    const { rows, index, document } = found
    if (document.drafterId !== auth.id) { response.status(403).json({ error: DRAFTER_REQUIRED }); return }
    if (!canEditDraft(document, auth.id)) { fail(response, APPROVAL_ERRORS.NOT_EDITABLE); return }
    if (!Number.isInteger(request.body?.version) || request.body.version !== document.version) {
      response.status(409).json({ error: { code: 'APPROVAL_VERSION_CONFLICT', message: '다른 곳에서 먼저 저장되었습니다. 최신 내용을 불러온 뒤 다시 시도해 주세요.', currentVersion: document.version } })
      return
    }
    const form = formsOf(auth.tenantId).find((entry) => entry.id === document.formId) ?? null
    const next = { ...document, updatedAt: now, version: document.version + 1 }
    const body = request.body ?? {}
    if (Object.hasOwn(body, 'title')) {
      const title = clip(body.title, MAX_TITLE)
      if (!title) { fail(response, { ...APPROVAL_ERRORS.VALUE_REQUIRED, key: 'title' }); return }
      next.title = title
    }
    if (Object.hasOwn(body, 'values')) {
      if (!form) { response.status(404).json({ error: FORM_NOT_FOUND }); return }
      const values = normalizeApprovalValues(form, body.values)
      if (values.error) { fail(response, values.error); return }
      next.values = values.values
    }
    if (Object.hasOwn(body, 'attachments')) {
      const attachments = normalizeAttachments(body.attachments)
      if (attachments.error) { fail(response, attachments.error); return }
      next.attachments = attachments.attachments
    }
    const accountIndex = accountIndexOf(auth)
    if (Object.hasOwn(body, 'ccIds')) {
      const cc = normalizeCcIds(body.ccIds, accountIndex)
      if (cc.error) { fail(response, cc.error); return }
      next.ccIds = cc.ccIds
    }
    if (Object.hasOwn(body, 'line')) {
      const line = normalizeApprovalLine(body.line, { drafterId: auth.id, approverIds: accountIndex })
      if (line.error) { fail(response, line.error); return }
      next.line = line.line
    }
    if (forbiddenAttachment(attachmentIdsOf(next, form), auth)) {
      response.status(400).json({ error: { code: 'APPROVAL_ATTACHMENT_FORBIDDEN', message: '열람할 수 없는 자료는 결재에 첨부할 수 없습니다.' } })
      return
    }
    const written = rows.map((row, position) => (position === index ? next : row))
    if (!await writeRows(auth.tenantId, DOCUMENTS_KEY, written, auth.id, now)) {
      response.status(500).json({ error: WRITE_FAILED })
      return
    }
    response.json({ document: next })
  })

  // ── 13. 기안 지우기 ─────────────────────────────────────────────────────────
  // 첨부 파일은 지우지 않는다. 그 파일은 자료실의 것이고, 결재는 빌려 쓴 것뿐이다.
  app.delete('/api/approval-documents/:id', ...guards, async (request, response) => {
    const auth = gate(request, response)
    if (!auth) return
    const now = clock().toISOString()
    const delegateFor = delegateForOf(auth.tenantId, auth.id, billingDate(now))
    const found = findDocument(auth, request.params.id, delegateFor)
    if (!found) { response.status(404).json({ error: NOT_FOUND }); return }
    const { rows, index, document } = found
    if (document.drafterId !== auth.id && auth.role !== 'tenant-admin') { response.status(403).json({ error: DRAFTER_REQUIRED }); return }
    if (document.status !== '기안') { fail(response, APPROVAL_ERRORS.NOT_EDITABLE); return }
    const written = rows.filter((_row, position) => position !== index)
    if (!await writeRows(auth.tenantId, DOCUMENTS_KEY, written, auth.id, now)) {
      response.status(500).json({ error: WRITE_FAILED })
      return
    }
    response.json({ ok: true })
  })

  /** 다음 차례가 된 사람들에게만 알린다. 참조자에게는 보내지 않는다 — 참조는 열람이지 할 일이 아니다. */
  function announceStep(auth, document, form, now) {
    try {
      notify(auth.tenantId, pendingApproverIds(document).map((recipientId) => ({
        type: 'approval-requested',
        recipientId,
        actorId: auth.id,
        title: `결재 요청: ${document.title}`,
        body: `${document.drafterName}님이 올린 ${form?.name ?? document.formName ?? '결재 문서'}입니다.`,
        page: 'approvals',
        focusId: document.id,
        source: { kind: 'approval-document', id: document.id, label: '전자결재' },
      })), { now: new Date(now) })
    } catch { /* 알림 실패가 결재를 되돌리지 않는다 */ }
  }

  // ── 14. 상신 ────────────────────────────────────────────────────────────────
  app.post('/api/approval-documents/:id/submit', ...guards, async (request, response) => {
    const auth = gate(request, response)
    if (!auth) return
    const now = clock().toISOString()
    const delegateFor = delegateForOf(auth.tenantId, auth.id, billingDate(now))
    const found = findDocument(auth, request.params.id, delegateFor)
    if (!found) { response.status(404).json({ error: NOT_FOUND }); return }
    const { rows, index, document } = found
    if (document.drafterId !== auth.id) { response.status(403).json({ error: DRAFTER_REQUIRED }); return }
    if (!canEditDraft(document, auth.id)) { fail(response, APPROVAL_ERRORS.NOT_EDITABLE); return }
    if (!Number.isInteger(request.body?.version) || request.body.version !== document.version) {
      response.status(409).json({ error: { code: 'APPROVAL_VERSION_CONFLICT', message: '다른 곳에서 먼저 저장되었습니다. 최신 내용을 불러온 뒤 다시 시도해 주세요.', currentVersion: document.version } })
      return
    }
    // 상신 순간에 결재선을 다시 잰다 — 기안한 뒤 퇴사한 사람이 결재선에 남아 있으면 그 문서는
    // 아무도 결재할 수 없는 채로 돌기 시작한다. 아직 아무도 결정하지 않았으므로 다시 만들어도 잃는 것이 없다.
    const line = normalizeApprovalLine(document.line, { drafterId: auth.id, approverIds: accountIndexOf(auth), requireSteps: true })
    if (line.error) { fail(response, line.error); return }
    const next = {
      ...document,
      line: line.line,
      status: '결재중',
      currentStep: line.line[0].step,
      submittedAt: now,
      updatedAt: now,
      version: document.version + 1,
      history: pushHistory(document.history, { at: now, actorId: auth.id, actorName: clip(auth.name, MAX_TITLE), action: '상신', comment: '', delegateOf: null }),
    }
    const written = rows.map((row, position) => (position === index ? next : row))
    if (!await writeRows(auth.tenantId, DOCUMENTS_KEY, written, auth.id, now)) {
      response.status(500).json({ error: WRITE_FAILED })
      return
    }
    announceStep(auth, next, formsOf(auth.tenantId).find((entry) => entry.id === next.formId) ?? null, now)
    response.json({ document: next })
  })

  // ── 15. 결재(승인·반려)와 그 부수효과 ───────────────────────────────────────
  app.post('/api/approval-documents/:id/decide', ...guards, async (request, response) => {
    const auth = gate(request, response)
    if (!auth) return
    const now = clock().toISOString()
    const delegateFor = delegateForOf(auth.tenantId, auth.id, billingDate(now))
    const found = findDocument(auth, request.params.id, delegateFor)
    if (!found) { response.status(404).json({ error: NOT_FOUND }); return }
    const { rows, index, document } = found
    const decision = String(request.body?.decision ?? '')
    if (decision !== 'approve' && decision !== 'reject') {
      response.status(400).json({ error: { code: 'INVALID_DECISION', message: '승인 또는 반려만 보낼 수 있습니다.' } })
      return
    }
    const applied = applyApprovalDecision(document, {
      actorId: auth.id, actorName: auth.name, decision, comment: request.body?.comment, reason: request.body?.reason, now, delegateFor,
    })
    if (applied.error) { fail(response, applied.error); return }
    const decided = applied.document
    const form = formsOf(auth.tenantId).find((entry) => entry.id === decided.formId) ?? null

    const effects = {}
    let evidenceDoc = null
    let nextDocumentList = null

    if (decided.status === '승인') {
      // 0) 멱등의 전부. 이미 만들어진 절반은 다시 만들지 않는다.
      if (form?.evidenceCategory && !decided.evidenceId) {
        if (!documentStorage) {
          decided.history = pushHistory(decided.history, {
            at: now, actorId: auth.id, actorName: clip(auth.name, MAX_TITLE), action: '증빙 보류',
            comment: '파일 저장소가 설정되지 않아 증빙 파일을 만들지 못했습니다.', delegateOf: null,
          })
        } else {
          try {
            const staged = await buildEvidence({ auth, decided, form, now })
            evidenceDoc = staged.evidenceDoc
            nextDocumentList = staged.documents
            decided.evidenceId = staged.evidenceDoc.id
            decided.history = staged.history
            effects.evidenceId = staged.evidenceDoc.id
            effects.evidenceTaggedAttachments = staged.tagged
          } catch {
            response.status(500).json({ error: WRITE_FAILED })
            return
          }
        }
      }
      if (form?.amountFieldKey && !decided.posting) {
        const posting = approvalPosting(form, decided, now)
        if (posting) { decided.posting = posting; effects.posting = posting }
      }
    }

    // 3) 저장 — 두 키를 한 커밋으로. 되돌리기는 키 단위다.
    const tenantStore = workspaceStore.tenants[auth.tenantId] ??= {}
    const previousDocumentsRecord = tenantStore[DOCUMENTS_KEY]
    tenantStore[DOCUMENTS_KEY] = {
      data: rows.map((row, position) => (position === index ? decided : row)),
      updatedAt: now,
      updatedBy: auth.id,
    }
    const rollbackDocuments = nextDocumentList ? stageDocumentList(auth.tenantId, nextDocumentList, auth.id) : () => {}
    try {
      await commitWorkspaceStore()
    } catch {
      rollbackDocuments()
      if (previousDocumentsRecord === undefined) delete tenantStore[DOCUMENTS_KEY]
      else tenantStore[DOCUMENTS_KEY] = previousDocumentsRecord
      // 저장소에 이미 쓴 증빙 바이트를 최선을 다해 지운다. 실패해도 500 은 그대로다 —
      // 커밋이 안 됐으므로 그 파일을 가리키는 행이 어디에도 없다.
      if (evidenceDoc) { try { await deleteTenantDocument(documentStorage, evidenceDoc, auth.tenantId) } catch { /* best-effort */ } }
      response.status(500).json({ error: WRITE_FAILED })
      return
    }

    // 4) 알림. 커밋 성공 뒤에만, 실패해도 결재를 되돌리지 않는다.
    if (decided.status === '반려') {
      try {
        notify(auth.tenantId, [{
          type: 'changes-requested',
          recipientId: decided.drafterId,
          actorId: auth.id,
          title: `반려: ${decided.title}`,
          body: String(decided.rejectionReason ?? '').slice(0, 300),
          page: 'approvals',
          focusId: decided.id,
          source: { kind: 'approval-document', id: decided.id, label: '전자결재' },
        }], { now: new Date(now) })
      } catch { /* 알림 실패가 결재를 되돌리지 않는다 */ }
    } else if (decided.status === '결재중' && decided.currentStep !== document.currentStep) {
      announceStep(auth, decided, form, now)
    }
    response.json({ document: decided, effects })
  })

  /**
   * 승인 증빙 한 벌을 **만들어 두기만** 한다. 커밋은 부르는 쪽이 결재 문서와 함께 한 번에 한다.
   *
   * 저장소에 바이트를 쓰는 것은 여기서 일어나고(커밋보다 먼저여야 원본 없는 행이 생기지 않는다),
   * 자료 목록에 얹는 것은 부르는 쪽이 stageDocumentList 로 한다.
   */
  async function buildEvidence({ auth, decided, form, now }) {
    const documents = Array.isArray(documentRecord(auth.tenantId)?.data) ? [...documentRecord(auth.tenantId).data] : []
    const names = accountIndexOf(auth)
    const attachmentIds = attachmentIdsOf(decided, form)
    const attachments = attachmentIds
      .map((id) => documents.find((row) => row?.id === id))
      .filter(Boolean)
      .map((row) => ({ id: row.id, name: String(row.name ?? row.originalName ?? '첨부파일') }))

    const dateField = (Array.isArray(form.fields) ? form.fields : []).find((field) => field?.type === 'date')
    const fromValues = dateField ? decided.values?.[dateField.key] : null
    const taxDate = typeof fromValues === 'string' && DATE_RE.test(fromValues) ? fromValues : billingDate(now)
    const taxTags = ['tax-evidence', `tax-year:${taxDate.slice(0, 4)}`, `tax-bucket:${form.evidenceCategory}`, `tax-date:${taxDate}`]

    const body = Buffer.from(renderApprovalMarkdown({
      document: decided, form, tenantName: auth.tenantName ?? '', attachments, names,
    }), 'utf8')
    const evidenceId = `DOC-${new Date(now).getTime()}-${randomBytes(4).toString('hex')}`
    const approvers = (Array.isArray(decided.line) ? decided.line : []).flatMap((step) => (Array.isArray(step?.approvers) ? step.approvers : []))
    const evidenceDoc = {
      id: evidenceId,
      tenantId: auth.tenantId,
      name: `${safeFileName(decided.title, '결재문서')}.md`,
      originalName: `${safeFileName(decided.title, '결재문서')}.md`,
      mime: 'text/markdown',
      size: body.length,
      category: '세무·회계',
      visibility: 'restricted',
      departments: [],
      // 이름이 적힌 결재자와 **실제로 누른 사람**을 함께 넣는다. decidedById 를 빼면 대결로 승인한
      // 사람이 자기가 승인한 건의 증빙을 열지 못한다(§1.5 가시성이 고친 것과 같은 종류의 구멍이다).
      allowedUserIds: [...new Set([
        decided.drafterId,
        ...approvers.map((approver) => approver?.accountId),
        ...approvers.map((approver) => approver?.decidedById),
      ].filter(Boolean))],
      aiPolicy: 'active',
      tags: [...taxTags, `approval:${decided.id}`],
      summary: `${taxDate} ${form.evidenceCategory} · ${form.name} 승인`,
      uploadedAt: now,
      uploadedById: auth.id,
      uploadedByName: auth.name,
      uploadedByRole: auth.role,
      storage: documentStorage.backend,
    }
    const stored = await putTenantDocument(documentStorage, {
      tenantId: auth.tenantId, id: evidenceId, body, contentType: 'text/markdown',
    })
    Object.assign(evidenceDoc, stored)

    // 첨부도 같은 기간에 묶이게 태그를 더한다. 자료실 한 건의 태그 상한을 넘기면 **자르지 않고 건너뛰고**
    // 그 사실을 이력에 남긴다 — 조용히 자르면 사용자는 '첨부가 증빙함에 안 보인다'만 겪는다.
    let history = decided.history
    let tagged = 0
    const attachmentSet = new Set(attachmentIds)
    const nextDocuments = documents.map((row) => {
      if (!attachmentSet.has(row?.id)) return row
      const current = Array.isArray(row.tags) ? row.tags : []
      const missing = taxTags.filter((tag) => !current.includes(tag))
      if (!missing.length) return row
      if (current.length + missing.length > MAX_DOCUMENT_TAGS) {
        history = pushHistory(history, {
          at: now, actorId: auth.id, actorName: clip(auth.name, MAX_TITLE), action: '증빙 경고',
          comment: `첨부 ‘${String(row.name ?? row.id)}’은 태그 상한으로 증빙 태그를 붙이지 못했습니다.`,
          delegateOf: null,
        })
        return row
      }
      tagged += 1
      return { ...row, tags: [...current, ...missing] }
    })
    nextDocuments.unshift(evidenceDoc)
    return { evidenceDoc, documents: nextDocuments, history, tagged }
  }

  // ── 16. 회수 ────────────────────────────────────────────────────────────────
  app.post('/api/approval-documents/:id/recall', ...guards, async (request, response) => {
    const auth = gate(request, response)
    if (!auth) return
    const now = clock().toISOString()
    const delegateFor = delegateForOf(auth.tenantId, auth.id, billingDate(now))
    const found = findDocument(auth, request.params.id, delegateFor)
    if (!found) { response.status(404).json({ error: NOT_FOUND }); return }
    const { rows, index, document } = found
    if (document.drafterId !== auth.id) { response.status(403).json({ error: DRAFTER_REQUIRED }); return }
    if (!Number.isInteger(request.body?.version) || request.body.version !== document.version) {
      response.status(409).json({ error: { code: 'APPROVAL_VERSION_CONFLICT', message: '다른 곳에서 먼저 저장되었습니다. 최신 내용을 불러온 뒤 다시 시도해 주세요.', currentVersion: document.version } })
      return
    }
    // 한 명이라도 결재했으면 회수는 그 결재를 없던 일로 만드는 셈이라 이력이 거짓말을 하게 된다.
    if (!canRecall(document, auth.id)) { fail(response, APPROVAL_ERRORS.RECALL_FORBIDDEN); return }
    const next = {
      ...document,
      status: '회수',
      completedAt: now,
      updatedAt: now,
      version: document.version + 1,
      history: pushHistory(document.history, { at: now, actorId: auth.id, actorName: clip(auth.name, MAX_TITLE), action: '회수', comment: '', delegateOf: null }),
    }
    const written = rows.map((row, position) => (position === index ? next : row))
    if (!await writeRows(auth.tenantId, DOCUMENTS_KEY, written, auth.id, now)) {
      response.status(500).json({ error: WRITE_FAILED })
      return
    }
    response.json({ document: next })
  })

  // ── 17. 인쇄 ────────────────────────────────────────────────────────────────
  app.get('/api/approval-documents/:id/print', ...guards, (request, response) => {
    const auth = gate(request, response)
    if (!auth) return
    const now = clock().toISOString()
    const delegateFor = delegateForOf(auth.tenantId, auth.id, billingDate(now))
    const found = findDocument(auth, request.params.id, delegateFor)
    if (!found) { response.status(404).json({ error: NOT_FOUND }); return }
    const { document } = found
    const form = formsOf(auth.tenantId).find((entry) => entry.id === document.formId) ?? null
    const library = Array.isArray(documentRecord(auth.tenantId)?.data) ? documentRecord(auth.tenantId).data : []
    const attachments = attachmentIdsOf(document, form)
      .map((id) => library.find((row) => row?.id === id))
      .filter(Boolean)
      .map((row) => ({ id: row.id, name: String(row.name ?? row.originalName ?? '첨부파일') }))
    response.set('content-type', 'text/html; charset=utf-8')
    // 결재문서는 사람이 열 때마다 지금의 결재선을 그대로 찍어야 한다. 프록시가 한 장을 캐시하면
    // 다음 사람이 남의 진행 상태를 본다.
    response.set('cache-control', 'no-store')
    response.send(renderApprovalPrintHtml({
      document, form, tenantName: auth.tenantName ?? '', printedAt: now, attachments, names: accountIndexOf(auth),
    }))
  })
}

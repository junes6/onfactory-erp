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
  valueError,
} from './approval-routing.mjs'
import { renderApprovalMarkdown, renderApprovalPrintHtml } from './approval-print.mjs'
import { billingDate } from './billing-service.mjs'
import { DocumentStorageError, getTenantDocument, tenantDocumentSignedUrl } from './document-storage-service.mjs'
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
  [APPROVAL_ERRORS.NOT_SUBMITTED.code, 409],
  [APPROVAL_ERRORS.LINE_BROKEN.code, 409],
  [APPROVAL_ERRORS.RECALL_FORBIDDEN.code, 409],
  [APPROVAL_ERRORS.NOT_EDITABLE.code, 409],
  [APPROVAL_ERRORS.DELEGATE_CYCLE.code, 409],
])

const NOT_FOUND = { code: 'APPROVAL_DOCUMENT_NOT_FOUND', message: '결재 문서를 찾을 수 없거나 열람 권한이 없습니다.' }
/** 첨부 한 건의 404. 「이 결재의 첨부가 아니다」와 「열 권한이 없다」를 가르지 않는다 — 가르면 존재가 샌다. */
const ATTACHMENT_NOT_FOUND = { code: 'APPROVAL_ATTACHMENT_NOT_FOUND', message: '첨부 자료를 찾을 수 없거나 열람 권한이 없습니다.' }
/** 열 수 없는 첨부가 인쇄물에서 차지하는 자리. 이름 대신 이 문장이다 — 파일 이름은 종종 내용이다. */
const ATTACHMENT_CLOSED_LABEL = '열람 권한이 없는 첨부'
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
   *
   * 되돌리기의 마지막 줄은 회사 객체 자체다(app.mjs 의 stageDocumentList 와 같은 모양). `??= {}` 로
   * 만들어 놓은 빈 회사를 남기면 **저장된 적 없는 회사**가 메모리에 앉고, 다음 성공 커밋이 그것을
   * 그대로 디스크에 싣는다. 우리가 만들었고 아직 비어 있을 때만 지운다.
   */
  const writeRows = async (tenantId, key, rows, accountId, now) => {
    const hadTenant = Object.prototype.hasOwnProperty.call(workspaceStore.tenants, tenantId)
    const tenantStore = workspaceStore.tenants[tenantId] ??= {}
    const previous = tenantStore[key]
    tenantStore[key] = { data: rows, updatedAt: now, updatedBy: accountId }
    try {
      await commitWorkspaceStore()
      return true
    } catch {
      if (previous === undefined) delete tenantStore[key]
      else tenantStore[key] = previous
      if (!hadTenant && Object.keys(tenantStore).length === 0) delete workspaceStore.tenants[tenantId]
      return false
    }
  }

  /**
   * 승인 증빙 문서(`writeEvidenceFile`)를 열 사람들 — 기안자 · 참조자 · 결재선에 이름이 적힌 사람과
   * 실제로 누른 사람.
   *
   * **여기서 만드는 명단은 이 커밋에서 새로 태어나는 자료 한 건(.md)의 것뿐이다.** 이미 있던
   * 자료실 행의 `allowedUserIds` 는 결재가 절대 고치지 않는다 — 그 이유는 아래
   * `canReadApprovalAttachment` 의 주석이 적는다.
   *
   * 오늘자 대결자를 넣지 않는 이유도 같다. 대결은 기간이 끝나면 사라지는 사실인데, 새 문서의
   * 명단에 박아 두면 그 사람은 대결이 끝난 뒤에도 영원히 그 증빙을 연다. 대결로 **실제로 누른**
   * 사람은 자리에 `decidedById` 로 남아 아래 배열에 그대로 들어온다.
   */
  const evidenceReaderIds = (document) => {
    const approvers = (Array.isArray(document?.line) ? document.line : [])
      .flatMap((step) => (Array.isArray(step?.approvers) ? step.approvers : []))
    return [...new Set([
      document?.drafterId,
      ...(Array.isArray(document?.ccIds) ? document.ccIds : []),
      ...approvers.map((approver) => approver?.accountId),
      ...approvers.map((approver) => approver?.decidedById),
    ].filter((id) => typeof id === 'string' && id))]
  }

  /**
   * 이 사람이 **지금** 이 결재의 이 첨부를 열 수 있는가. 부르는 쪽은 이미 두 가지를 지났다:
   * 문서를 볼 수 있다(`canReadApprovalDocument`)는 것과, 그 id 가 이 문서가 붙잡은 첨부
   * (`linkedAttachmentIdsOf`)라는 것.
   *
   * **저장된 명단이 아니라 매 요청 다시 재는 술어다.** 이전 회차는 결재가 자료실 행의
   * `allowedUserIds` 에 사람을 더해 두는 방식이었는데, 그 넓힘은 되돌아오지 않아서 —
   *
   * - 평사원 한 명이 아무 동료나 하루짜리 대결자로 세우는 것만으로 그 동료가 남의 restricted
   *   원본을 영구히 얻었고(대결 행을 지워도 닫히지 않았다),
   * - 그렇게 얻은 사람이 같은 파일을 자기 결재에 붙여 또 넘기는 **연쇄**가 있었고,
   * - 관리자가 `PATCH /api/documents/:id` 로 회수해도 **다음 결재 한 번이 되돌려** 놓았다.
   *
   * 결재 문서의 가시성은 이미 매 요청 다시 재고 있었다(대결이 끝나는 순간 404). 첨부만 저장된
   * ACL 로 남겨 두면 그 비대칭이 곧 구멍이다 — 문서는 404 인데 원본만 200 으로 열려, 맥락 없이
   * 파일만 남는다. 그래서 첨부도 문서와 **같은 방식으로** 잰다.
   *
   * 「기안」은 아무 문도 열지 않는다. 초안은 아직 아무에게도 갈 일이 없는데 여기서 열어 주면
   * 초안 하나를 만드는 것만으로 남의 자료를 임의의 구성원에게 보여 줄 수 있다. 상신 뒤로 미루면
   * 넓힘을 설명하는 결재 문서가 **반드시** 남는다(상신한 문서는 어떤 끝에서도 지워지지 않는다).
   * 그때까지는 자기 자료실 권한으로만 연다.
   */
  const canReadApprovalAttachment = (document, row, auth) => {
    if (!row) return false
    if (canReadDocument(row, auth)) return true
    return document?.status !== '기안'
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

  /**
   * 이 문서가 붙잡은 자료 전부 — 첨부 배열 ∪ 「첨부」 항목 값. **쓰기 시점에만** 부른다.
   *
   * 이 배열 하나가 **세 가지 답의 원천**이다: 열람 권한 검사(forbiddenAttachment)·증빙 태그·
   * 자료실의 삭제 잠금(app.mjs 의 linkedDocumentIds 가 읽는 `linkedAttachmentIds`).
   * 셋이 각자 「무엇이 첨부인가」를 판정하면 그 사이가 벌어지는 순간이 곧 구멍이다.
   */
  const attachmentIdsOf = (document, form) => [...new Set([
    ...(Array.isArray(document?.attachments) ? document.attachments : []).filter((id) => typeof id === 'string'),
    ...attachmentValueIds(document, form),
  ])]

  /**
   * **읽기 시점의 답** — 증빙 태그·증빙 본문·인쇄물이 무엇을 첨부로 볼 것인가.
   *
   * 여기서 `attachmentIdsOf` 를 다시 부르면 그 순간의 **양식**으로 다시 계산하게 되어, 관리자가
   * 항목 하나의 타입을 text → attachment 로 바꾸는 것만으로 쓰기 때 `forbiddenAttachment` 를
   * 한 번도 지나지 않은 자료 id 가 증빙·인쇄 경로로 들어온다(그 파일 이름이 증빙 마크다운과
   * 인쇄물에 실리고, tax-evidence 태그가 붙어 세무사 전달 묶음에 섞인다). 반대로 항목을 양식에서
   * 빼면 삭제 잠금만 남고 인쇄물 어디에도 그 연결이 보이지 않아 409 문구가 거짓이 된다.
   *
   * 그래서 답은 **쓰기 때 검사를 지나 저장된 서버 소유 필드 하나**뿐이다. 그 필드가 없는 옛 행에서만
   * 양식으로 다시 계산한다(하위호환) — 그 행은 애초에 이 필드가 생기기 전에 쓰인 것이다.
   */
  const linkedAttachmentIdsOf = (document, form) => (Array.isArray(document?.linkedAttachmentIds)
    ? document.linkedAttachmentIds.filter((id) => typeof id === 'string')
    : attachmentIdsOf(document, form))

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

  /**
   * `?seenAt=` 한 곳. **목록과 요약이 같은 규칙을 쓴다** — 같은 이름·같은 모양의 `summary.decidedUnread`
   * 가 라우트마다 다른 사실을 세면(요약은 「본 뒤에 끝난 것」, 목록은 「끝난 것 전부」) 그 차이는
   * 응답 어디에도 적히지 않고, 목록으로 탭 점을 찍는 화면에서는 점이 영원히 꺼지지 않는다.
   * 못 읽는 값은 빈 문자열로 떨어져 「전부」가 된다 — 조용히 0으로 만들면 점이 반대로 영영 안 켜진다.
   */
  const seenAtOf = (request) => {
    const value = String(request.query.seenAt ?? '').trim()
    return Number.isFinite(Date.parse(value)) ? value : ''
  }

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
    // 대결 행만 쓴다. 자료실 열람 명단은 건드리지 않는다 — 대결자가 근거를 여는 자격은
    // 저장해 두는 명단이 아니라 요청마다 다시 재는 술어다(canReadApprovalAttachment).
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
    /**
     * 나머지에 닿는 길. 이것이 없으면 「내 결재」 탭에서 상한을 넘긴 문서에 **어떤 길로도** 닿지
     * 못한다 — 그 탭은 서버가 `canDecide` 로 거르는데 canDecide 는 '결재중'만 통과시키므로,
     * 화면이 주는 상태 좁히기 여섯 갈래 중 '결재중'은 좁히지 않은 것과 같고 나머지는 0건이다.
     * 「남은 N건은 좁혀 찾아 주세요」가 참이 되려면 좁힐 길이 실제로 있어야 한다(규칙 11).
     * 모양이 아닌 값은 거절하지 않고 처음부터 준다 — 목록은 읽기이고, 400 은 화면을 멈춘다.
     */
    const requestedOffset = Number(request.query.offset)
    const offset = Number.isInteger(requestedOffset) && requestedOffset > 0 ? requestedOffset : 0
    const scoped = readable.filter((document) => {
      if (scope === 'waiting') return canDecide(document, auth.id, delegateFor)
      if (scope === 'drafted') return document.drafterId === auth.id
      if (scope === 'cc') return Array.isArray(document.ccIds) && document.ccIds.includes(auth.id)
      return true
    }).filter((document) => !status || document.status === status)
    const documents = [...scoped]
      .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))
      .slice(offset, offset + limit)
    response.json({
      documents,
      // 자른 배열의 길이를 세지 않는다. summary 는 「볼 수 있는 전부」를 세고, documents 는 그중 limit 개다.
      // `seenAt` 은 요약 라우트와 같은 자리에서 같은 규칙으로 읽는다(seenAtOf).
      summary: summaryOf(all, auth, delegateFor, seenAtOf(request)),
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
    response.json(summaryOf(documentsOf(auth.tenantId), auth, delegateFor, seenAtOf(request)))
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
    // 첨부의 **이름**은 여기서 한 번만 답한다. 화면이 자료 목록을 따로 훑어 이름을 맞추면
    // 인쇄물·증빙과 다른 답이 나올 수 있고, 이름 없는 내려받기 버튼은 무엇을 내려받는지 말하지
    // 못한다. 무엇이 첨부인가는 쓰기 때 저장된 배열이 정한다(linkedAttachmentIdsOf).
    //
    // `canRead` 는 내려받기 라우트와 **같은 술어**로 답한다(canReadApprovalAttachment) — 두 자리가
    // 각자 판정하면 「버튼은 그려지는데 누르면 404」나 그 반대가 생긴다(규칙 1·3·5·8).
    //
    // 그리고 `canRead:false` 인 항목에는 **이름을 싣지 않는다.** 이 저장소에서 파일 이름은 종종
    // 내용이다(「생산1팀-내부단가.pdf」). 열 수 없는 파일의 이름을 주는 것은 「무엇을 내려받는지
    // 말해 준다」는 근거가 서지 않는 자리다 — 내려받을 수 없으니까.
    const library = Array.isArray(documentRecord(auth.tenantId)?.data) ? documentRecord(auth.tenantId).data : []
    const attachments = linkedAttachmentIdsOf(document, form)
      .map((attachmentId) => library.find((row) => row?.id === attachmentId))
      .filter(Boolean)
      .map((row) => (canReadApprovalAttachment(document, row, auth)
        ? { id: row.id, name: String(row.name ?? row.originalName ?? '첨부파일'), canRead: true }
        : { id: row.id, canRead: false }))
    response.json({
      document,
      form,
      attachments,
      permissions: {
        canDecide: Boolean(seat.seat),
        canRecall: canRecall(document, auth.id),
        canEdit: canEditDraft(document, auth.id),
        canDelete: (document.drafterId === auth.id || auth.role === 'tenant-admin') && document.status === '기안',
      },
      delegateOf: seat.delegateOf ?? null,
    })
  })

  // ── 10-b. 결재 범위 첨부 내려받기 ───────────────────────────────────────────
  /**
   * **결재가 붙잡은 첨부를, 그 결재를 볼 수 있는 사람에게만** 넘긴다.
   *
   * 이 문이 있어야 결재가 자료실의 열람 명단을 고치지 않을 수 있다. 자료실 명단을 고치는 방식은
   * 되돌아오지 않아서 대결 한 번·결재 한 번이 남의 원본을 영구히 열어젖혔다
   * (`canReadApprovalAttachment` 주석). 여기서는 매 요청 세 가지를 다시 잰다:
   *
   * 1) 이 결재를 볼 수 있는가(`findDocument` → `canReadApprovalDocument`) — 대결이 끝나면 거짓이 된다,
   * 2) 이 id 가 **이 결재가 붙잡은** 첨부인가(`linkedAttachmentIdsOf`) — 아니면 문서 id 하나로
   *    자료실 전체를 여는 창구가 된다,
   * 3) 「기안」이 아니거나, 자기 자료실 권한으로 이미 열리는가(`canReadApprovalAttachment`).
   *
   * 하나라도 어긋나면 404다 — 「권한이 없습니다」는 그 파일이 이 결재에 붙어 있다는 사실 자체를
   * 알려 준다(이 파일이 지키는 것 ①).
   */
  app.get('/api/approval-documents/:id/attachments/:attachmentId', ...guards, async (request, response) => {
    const auth = gate(request, response)
    if (!auth) return
    const now = clock().toISOString()
    const delegateFor = delegateForOf(auth.tenantId, auth.id, billingDate(now))
    const found = findDocument(auth, request.params.id, delegateFor)
    if (!found) { response.status(404).json({ error: NOT_FOUND }); return }
    const { document } = found
    const attachmentId = String(request.params.attachmentId ?? '')
    const form = formsOf(auth.tenantId).find((entry) => entry.id === document.formId) ?? null
    if (!linkedAttachmentIdsOf(document, form).includes(attachmentId)) {
      response.status(404).json({ error: ATTACHMENT_NOT_FOUND }); return
    }
    const library = Array.isArray(documentRecord(auth.tenantId)?.data) ? documentRecord(auth.tenantId).data : []
    const row = library.find((entry) => entry?.id === attachmentId)
    if (!canReadApprovalAttachment(document, row, auth)) {
      response.status(404).json({ error: ATTACHMENT_NOT_FOUND }); return
    }
    if (!documentStorage) { response.status(404).json({ error: ATTACHMENT_NOT_FOUND }); return }
    // 내려받기 횟수는 세지 않는다. '자주 찾는 파일' 집계는 자료실의 사실이고, 결재자가 근거를
    // 한 번 열어 본 것을 거기에 섞으면 그 수가 무엇을 세는지 답할 수 없게 된다.
    try {
      const signedUrl = await tenantDocumentSignedUrl(documentStorage, row, auth.tenantId)
      if (signedUrl) { response.redirect(302, signedUrl); return }
      const body = await getTenantDocument(documentStorage, row, auth.tenantId)
      response.setHeader('content-type', row.mime || 'application/octet-stream')
      response.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeFileName(row.originalName || row.name, 'document'))}`)
      response.send(body)
    } catch (error) {
      // 자료실 경로와 같은 문장을 쓴다 — 같은 파일을 두 문으로 열었을 때 다른 말을 하면 안 된다.
      const status = error instanceof DocumentStorageError ? error.status : 500
      const code = error instanceof DocumentStorageError ? error.code : 'DOCUMENT_DOWNLOAD_FAILED'
      response.status(status).json({ error: { code, message: status === 410 ? '파일 원본을 찾을 수 없습니다. 관리자에게 복구를 요청해 주세요.' : '자료를 다운로드하지 못했습니다.' } })
    }
  })

  // ── 11. 기안 ────────────────────────────────────────────────────────────────
  app.post('/api/approval-documents', ...guards, async (request, response) => {
    const auth = gate(request, response)
    if (!auth) return
    const now = clock().toISOString()
    const rows = documentRowsOf(auth.tenantId)
    // 멱등 키는 **자르지 않고 거절한다.** 사람이 읽는 글자가 아니라 구조이기 때문이다 —
    // 먼저 120자로 자른 뒤 모양을 보면 121자 이상에서 앞 120자가 같은 두 요청이 같은 키가 되어,
    // 두 번째 기안이 만들어지지 않고 첫 번째 문서가 replayed 로 돌아간다(두 건을 올린 사람에게
    // 남의 제목이 뜬다). 자르지 않으므로 정규식의 길이 경계 {1,120} 도 죽은 검사가 아니게 된다.
    const rawClientRequestId = request.body?.clientRequestId
    if (rawClientRequestId != null && rawClientRequestId !== ''
      && (typeof rawClientRequestId !== 'string' || !CLIENT_REQUEST_ID_RE.test(rawClientRequestId))) {
      fail(response, { ...APPROVAL_ERRORS.VALUE_INVALID, key: 'clientRequestId' })
      return
    }
    const clientRequestId = typeof rawClientRequestId === 'string' ? rawClientRequestId : ''
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
    const submit = request.body?.submit === true
    const title = clip(request.body?.title, MAX_TITLE)
    // 제목은 임시저장에서도 받는다 — 목록에 이름 없는 줄을 만들면 「이어서 작성」할 문서를 고를 길이 없다.
    if (!title) { fail(response, valueError(APPROVAL_ERRORS.VALUE_REQUIRED, { key: 'title', label: '제목' })); return }
    // 필수 항목은 **상신에서** 잰다. '기안'은 아직 아무에게도 가지 않은 메모장이다(normalizeApprovalValues 주석).
    const values = normalizeApprovalValues(form, request.body?.values, { requireFilled: submit })
    if (values.error) { fail(response, values.error); return }
    const attachments = normalizeAttachments(request.body?.attachments)
    if (attachments.error) { fail(response, attachments.error); return }
    const index = accountIndexOf(auth)
    const cc = normalizeCcIds(request.body?.ccIds, index)
    if (cc.error) { fail(response, cc.error); return }
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
      // 서버가 정하는 파생 필드. 요청 본문은 이 칸을 정하지 못한다 — 여기에 임의의 id 를 실을 수
      // 있으면 자료실의 삭제 잠금이 본문 한 줄로 열린다.
      linkedAttachmentIds: attachmentIdsOf({ attachments: attachments.attachments, values: values.values }, form),
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
    if (forbiddenAttachment(draft.linkedAttachmentIds, auth)) {
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
      if (!title) { fail(response, valueError(APPROVAL_ERRORS.VALUE_REQUIRED, { key: 'title', label: '제목' })); return }
      next.title = title
    }
    if (Object.hasOwn(body, 'values')) {
      if (!form) { response.status(404).json({ error: FORM_NOT_FOUND }); return }
      // PATCH 는 '기안'에서만 열린다 — 여기가 곧 임시저장이므로 필수를 재지 않는다.
      // 「이어서 작성」하다 채운 칸을 다시 비우는 것도 저장돼야 한다.
      const values = normalizeApprovalValues(form, body.values, { requireFilled: false })
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
    // 값이 바뀌었으면 붙잡은 자료도 바뀐다. 파생 필드를 여기서 다시 적지 않으면 「첨부」 칸을
    // 비운 뒤에도 그 자료가 자료실에서 지워지지 않는다.
    next.linkedAttachmentIds = attachmentIdsOf(next, form)
    if (forbiddenAttachment(next.linkedAttachmentIds, auth)) {
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
    // 필수 항목도 여기서 잰다. '기안'은 임시저장이라 빈 칸을 받아 두고, 남에게 가는 순간에 비로소
    // 다 채웠는지 묻는다. 양식이 사라진 옛 문서는 무엇이 필수인지 답할 곳이 없으므로 그냥 지난다 —
    // 되살릴 수 없는 양식 때문에 이미 쓴 기안이 영영 상신되지 못하는 막다른 길을 만들지 않는다.
    const submitForm = formsOf(auth.tenantId).find((entry) => entry.id === document.formId) ?? null
    if (submitForm) {
      const values = normalizeApprovalValues(submitForm, document.values, { requireFilled: true })
      if (values.error) { fail(response, values.error); return }
    }
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
    announceStep(auth, next, submitForm, now)
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
    const { document } = found
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
    let evidence = null

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
            evidence = await writeEvidenceFile({ auth, decided, form, now })
            decided.evidenceId = evidence.evidenceDoc.id
            effects.evidenceId = evidence.evidenceDoc.id
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
    //
    // **두 배열은 여기서 다시 읽는다.** 증빙 바이트를 쓰는 `await` 동안 다른 요청이 같은 두 키에
    // 이미 200/201 로 답했을 수 있고, 그때 읽어 둔 배열로 덮어쓰면 확정된 그 쓰기가 응답만 남기고
    // 조용히 사라진다(자료 이름 변경 · 같은 순간의 다른 기안). 읽기와 쓰기 사이에 await 가 있는 한
    // 쓸 수 있는 것은 **쓰기 직전에 읽은** 배열뿐이다.
    const currentRows = documentRowsOf(auth.tenantId)
    const currentIndex = currentRows.findIndex((row) => row?.id === document.id)
    const current = currentIndex < 0 ? null : currentRows[currentIndex]
    if (!current || current.version !== document.version || current.status !== document.status) {
      // 이 문서 자체가 그 사이에 바뀌었다. 결정은 우리가 읽은 그 순간의 사실에 대한 것이었으므로 버린다.
      if (evidence) { try { await deleteTenantDocument(documentStorage, evidence.evidenceDoc, auth.tenantId) } catch { /* best-effort */ } }
      response.status(409).json({ error: { code: 'APPROVAL_VERSION_CONFLICT', message: '다른 곳에서 먼저 저장되었습니다. 최신 내용을 불러온 뒤 다시 시도해 주세요.', currentVersion: current?.version ?? null } })
      return
    }
    let nextDocumentList = null
    if (evidence) {
      const applied = applyEvidenceToLibrary(evidence, { auth, history: decided.history, now })
      nextDocumentList = applied.documents
      decided.history = applied.history
      effects.evidenceTaggedAttachments = applied.tagged
    }
    const tenantStore = workspaceStore.tenants[auth.tenantId] ??= {}
    const previousDocumentsRecord = tenantStore[DOCUMENTS_KEY]
    tenantStore[DOCUMENTS_KEY] = {
      data: currentRows.map((row, position) => (position === currentIndex ? decided : row)),
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
      if (evidence) { try { await deleteTenantDocument(documentStorage, evidence.evidenceDoc, auth.tenantId) } catch { /* best-effort */ } }
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
   * 승인 증빙의 **바이트만** 쓴다. 자료 목록에 얹는 일은 하지 않는다.
   *
   * 두 일을 갈라 놓은 이유가 이 함수의 전부다: 바이트 쓰기는 `await` 이고, 그 await 를 사이에 두고
   * 「자료 목록을 읽어」→「그 배열로 덮어쓰기」를 하면 그동안 확정된 남의 쓰기가 사라진다.
   * 그래서 목록을 읽는 일은 await 가 끝난 뒤 `applyEvidenceToLibrary` 가 한다.
   * 바이트가 커밋보다 먼저인 것은 그대로다 — 원본 없는 행이 생기는 쪽이 더 나쁘다.
   */
  async function writeEvidenceFile({ auth, decided, form, now }) {
    const documents = Array.isArray(documentRecord(auth.tenantId)?.data) ? documentRecord(auth.tenantId).data : []
    const names = accountIndexOf(auth)
    // 쓰기 때 검사를 지난 그 배열. 양식으로 다시 계산하지 않는다(linkedAttachmentIdsOf 주석).
    const attachmentIds = linkedAttachmentIdsOf(decided, form)
    const attachments = attachmentIds
      .map((id) => documents.find((row) => row?.id === id))
      .filter(Boolean)
      .map((row) => ({ id: row.id, name: String(row.name ?? row.originalName ?? '첨부파일') }))

    const dateField = (Array.isArray(form.fields) ? form.fields : []).find((field) => field?.type === 'date')
    const fromValues = dateField ? decided.values?.[dateField.key] : null
    const taxDate = typeof fromValues === 'string' && DATE_RE.test(fromValues) ? fromValues : billingDate(now)
    const taxTags = ['tax-evidence', `tax-year:${taxDate.slice(0, 4)}`, `tax-bucket:${form.evidenceCategory}`, `tax-date:${taxDate}`]

    const body = Buffer.from(renderApprovalMarkdown({
      document: decided, form, tenantName: auth.tenantName ?? '', attachments, attachmentIds, names,
    }), 'utf8')
    const evidenceId = `DOC-${new Date(now).getTime()}-${randomBytes(4).toString('hex')}`
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
      // **이 커밋에서 새로 태어나는 문서 하나**의 명단이다. 이미 있던 자료실 행은 건드리지 않는다.
      allowedUserIds: evidenceReaderIds(decided),
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
    return { evidenceDoc, attachmentIds, taxTags }
  }

  /**
   * 증빙 행을 자료 목록에 얹고, 첨부에도 같은 기간의 태그를 더한다. **동기**다 —
   * 목록을 읽는 순간과 그 배열로 쓰는 순간 사이에 다른 요청이 끼어들 틈을 두지 않기 위해서다.
   * 자료실 한 건의 태그 상한을 넘기면 **자르지 않고 건너뛰고** 그 사실을 이력에 남긴다 —
   * 조용히 자르면 사용자는 '첨부가 증빙함에 안 보인다'만 겪는다.
   */
  function applyEvidenceToLibrary({ evidenceDoc, attachmentIds, taxTags }, { auth, history: startingHistory, now }) {
    const documents = Array.isArray(documentRecord(auth.tenantId)?.data) ? documentRecord(auth.tenantId).data : []
    let history = startingHistory
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
          // 조사는 값에 따라 갈린다('영수증.png'는 받침이 없어 '는'이다). 이 저장소의 관례대로
          // `은(는)` 으로 적는다 — 이 이력은 「첨부가 증빙함에 안 보인다」를 겪는 사람이 이유를
          // 찾으러 읽는 유일한 문장이고, 결재 이력에 영구히 남는다.
          comment: `첨부 ‘${String(row.name ?? row.id)}’은(는) 태그 상한으로 증빙 태그를 붙이지 못했습니다.`,
          delegateOf: null,
        })
        return row
      }
      tagged += 1
      return { ...row, tags: [...current, ...missing] }
    })
    nextDocuments.unshift(evidenceDoc)
    return { documents: nextDocuments, history, tagged }
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
    // 무엇이 첨부인지는 여기서 한 번만 답하고, 렌더러는 그 목록에 이름을 붙일 뿐이다.
    // 그 답은 쓰기 때 저장된 배열이다 — 인쇄물이 증빙·삭제 잠금과 같은 사실을 말해야 한다.
    const attachmentIds = linkedAttachmentIdsOf(document, form)
    // 이름을 실을지도 상세·내려받기와 **같은 술어**로 가른다. 인쇄물만 이름을 흘리면 상세에서
    // 감춘 것을 종이가 되돌려 놓는다(규칙 3·8). 열 수 없는 첨부는 이름 대신 그 사실을 적는다.
    const attachments = attachmentIds
      .map((id) => library.find((row) => row?.id === id))
      .filter(Boolean)
      .map((row) => ({
        id: row.id,
        name: canReadApprovalAttachment(document, row, auth)
          ? String(row.name ?? row.originalName ?? '첨부파일')
          : ATTACHMENT_CLOSED_LABEL,
      }))
    response.set('content-type', 'text/html; charset=utf-8')
    // 결재문서는 사람이 열 때마다 지금의 결재선을 그대로 찍어야 한다. 프록시가 한 장을 캐시하면
    // 다음 사람이 남의 진행 상태를 본다.
    response.set('cache-control', 'no-store')
    response.send(renderApprovalPrintHtml({
      document, form, tenantName: auth.tenantName ?? '', printedAt: now, attachments, attachmentIds, names: accountIndexOf(auth),
    }))
  })
}

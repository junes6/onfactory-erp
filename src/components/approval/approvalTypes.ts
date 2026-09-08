import type { StatusBadgeTone } from '../StatusBadge'

/**
 * 양식형 전자결재 화면이 읽는 서버 레코드의 모양.
 *
 * 서버(`server/approval-routing.mjs`)가 만드는 그대로를 옮겨 적는다 — 화면이 자기 편한 모양으로
 * 다시 빚으면 「무엇이 결재선인가」를 답하는 곳이 둘이 되고, 그 둘은 언젠가 갈린다.
 * 값 검증·자리 판정은 서버 몫이고, 이 파일은 이름과 타입만 맞춘다.
 */

export type ApprovalStatus = '기안' | '결재중' | '승인' | '반려' | '회수'
export type ApprovalFieldType = 'text' | 'number' | 'money' | 'date' | 'select' | 'attachment'
export type ApprovalStepMode = 'sequential' | 'parallel'
export type ApproverDecision = 'pending' | 'approved' | 'rejected'

/** 양식 종류. 서버 `APPROVAL_FORM_KINDS`와 순서까지 같다. */
export const APPROVAL_FORM_KINDS = ['지출결의', '구매요청', '품의', '기안', '출장'] as const
/** 증빙 분류. 서버 `TAX_EVIDENCE_CATEGORIES`(= 세무 증빙함의 여섯 칸)와 문자 그대로 같다. */
export const TAX_EVIDENCE_CATEGORIES = ['매출', '매입', '급여', '경비', '신고·납부', '기타'] as const
export const APPROVAL_FIELD_TYPES = ['text', 'number', 'money', 'date', 'select', 'attachment'] as const

/** 항목 타입의 사람 말. 관리자 화면의 선택지 라벨이 여기 한 곳에서만 나온다. */
export const APPROVAL_FIELD_TYPE_LABEL: Record<ApprovalFieldType, string> = {
  text: '글자',
  number: '숫자',
  money: '금액',
  date: '날짜',
  select: '고르기',
  attachment: '첨부',
}

export type ApprovalField = {
  key: string
  label: string
  type: ApprovalFieldType
  required: boolean
  options: string[]
  help: string
  position: number
}

export type ApprovalApprover = {
  accountId: string
  name: string
  decision: ApproverDecision
  decidedAt: string | null
  /** 이 자리를 실제로 누른 사람. 대결이면 accountId(원결재자)와 다르다. */
  decidedById: string | null
  comment: string
  /** 대결로 채운 자리면 원결재자 id. */
  delegateOf: string | null
}

export type ApprovalStep = {
  step: number
  mode: ApprovalStepMode
  approvers: ApprovalApprover[]
}

export type ApprovalPosting = {
  month: string
  amount: number
  currency: string
  fieldKey: string
  kind: string
  postedAt: string
}

export type ApprovalHistoryEntry = {
  at: string
  actorId: string
  actorName: string
  action: string
  comment: string
  delegateOf: string | null
}

export type ApprovalForm = {
  recordType?: 'form'
  id: string
  name: string
  kind: string
  description: string
  fields: ApprovalField[]
  defaultLine: ApprovalStep[]
  ccIds: string[]
  amountFieldKey: string | null
  evidenceCategory: string | null
  active: boolean
  version: number
  createdById: string
  createdByName: string
  createdAt: string
  updatedAt: string
  updatedById: string
}

/** 목록 응답이 함께 주는 얇은 양식(고르기 전용). */
export type ApprovalFormBrief = { id: string; name: string; kind: string; active: boolean }

export type ApprovalDelegate = {
  recordType: 'delegate'
  id: string
  accountId: string
  delegateId: string
  delegateName: string
  from: string
  to: string
  note: string
  updatedAt: string
  updatedById: string
}

export type ApprovalValue = string | number

export type ApprovalDocument = {
  id: string
  formId: string
  formName: string
  formVersion: number
  kind: string
  title: string
  values: Record<string, ApprovalValue>
  attachments: string[]
  line: ApprovalStep[]
  ccIds: string[]
  drafterId: string
  drafterName: string
  status: ApprovalStatus
  currentStep: number
  rejectionReason: string
  evidenceId: string | null
  posting: ApprovalPosting | null
  history: ApprovalHistoryEntry[]
  version: number
  createdAt: string
  updatedAt: string
  submittedAt: string | null
  completedAt: string | null
}

export type ApprovalSummary = {
  waitingOnMe: number
  drafted: number
  cc: number
  decidedUnread: number
}

export type ApprovalPermissions = {
  canDecide: boolean
  canRecall: boolean
  canEdit: boolean
  canDelete: boolean
}

export type ApprovalMonthTotal = {
  month: string
  amount: number
  count: number
  byKind: { kind: string; amount: number; count: number }[]
}

/** 결재 화면을 쓰는 사람. App이 세션에서 읽어 그대로 내려준다. */
export type ApprovalAccount = { id: string; name: string; role: string }

/** 결재선 편집·참조자 고르기에 쓰는 사람 목록 한 줄. */
export type ApprovalMember = { id: string; name: string; team?: string; active?: boolean }

/**
 * 결재선 없이 상신하려 할 때의 한 문장. 서버 `APPROVAL_ERRORS.LINE_REQUIRED.message`와 **글자 그대로 같다**.
 * 한 사실은 한 문장이어야 하므로(규칙 3), 화면의 사전 경고와 서버가 돌려주는 오류 문구가 갈리면 안 된다.
 * `scripts/approval-ui-contract.test.mjs`가 서버 사전을 읽어 이 상수와 견준다.
 */
export const APPROVAL_LINE_REQUIRED_MESSAGE = '결재선을 한 단계 이상 지정해야 상신할 수 있습니다.'

/** 반려 사유가 짧을 때의 한 문장. 서버 `APPROVAL_ERRORS.REASON_REQUIRED.message`와 글자 그대로 같다(규칙 3). */
export const APPROVAL_REASON_REQUIRED_MESSAGE = '반려 사유를 5자 이상 적어 주세요.'

/**
 * 첨부는 이름이 보이는데 그 파일은 열 수 없을 때의 한 문장.
 * 결재 첨부는 「이 결재를 볼 수 있는가」를 서버가 매 요청 다시 재어 연다(저장된 명단이 아니다).
 * 아직 상신하지 않은 기안처럼 그 문이 닫혀 있는 자리가 남는데, 그때 상세는 `canRead:false` 와 함께
 * **이름도 주지 않는다** — 파일 이름은 종종 내용이기 때문이다. 화면은 버튼 대신 이 한 문장을 그린다:
 * 눌러 봐야 오류 토스트만 뜨는 버튼을 그리지 않는다(규칙 1·5).
 */
export const APPROVAL_ATTACHMENT_CLOSED_MESSAGE = '열람 권한이 없어 내려받을 수 없습니다.'

export const APPROVAL_STATUS_TONE: Record<ApprovalStatus, StatusBadgeTone> = {
  기안: 'neutral',
  결재중: 'info',
  승인: 'success',
  반려: 'danger',
  회수: 'neutral',
}

/** 상태 → CSS 클래스 조각. 한글 상태를 그대로 클래스에 넣지 않기 위한 유일한 표다. */
export const APPROVAL_STATUS_SLUG: Record<ApprovalStatus, string> = {
  기안: 'draft',
  결재중: 'running',
  승인: 'approved',
  반려: 'rejected',
  회수: 'recalled',
}

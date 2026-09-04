export type SeaProduct = {
  id: string
  code: string
  name: string
  shortName: string
  category: string
  specification: string
  price: number
  stock: number
  available: number
  safetyStock: number
  storage: string
  labelStatus: '승인' | '검토중' | '수정필요'
  status: '정상' | '주의' | '품절'
  channels: number
  visual: 1 | 2 | 3 | 4
}

export type ChannelMetric = {
  id: string
  name: string
  short: string
  color: string
  orders: number
  units: number
  revenue: number
  delta: number
  sync: string
  status: '정상' | '주의' | '설정중'
}

export type WorkEvidence = { id: string; name: string; size: string; type: string }

export type WorkCompletion = {
  summary: string
  evidence: WorkEvidence[]
  submittedAt: string
  submittedById: string
  submittedByName: string
}

export type WorkReview = {
  decision: 'approved' | 'changes-requested'
  comment: string
  requestedChanges?: string
  reviewedAt: string
  reviewerId: string
  reviewerName: string
}

export type WorkItem = {
  id: string
  title: string
  description: string
  owner: string
  ownerId?: string
  requestedBy: string
  requesterId?: string
  due: string
  priority: '긴급' | '높음' | '보통'
  status: '업무요청' | '수행중' | '결재대기' | '결재완료'
  category: string
  attachments?: WorkEvidence[]
  completion?: WorkCompletion
  completionHistory?: WorkCompletion[]
  /** 반복 규칙이 붙여 준 점검 항목. 전부 done이어야 완료 보고를 받는다. */
  checklist?: { id: string; label: string; done: boolean }[]
  review?: WorkReview
  reviewHistory?: WorkReview[]
  ruleId?: string
  ruleOccurrence?: string
  createdAt?: string
  /** 이 업무가 어디서 비롯됐는지. 사람이 직접 만든 업무에는 없다. */
  origin?: { kind: string; label?: string; detail?: string; page?: string; focusId?: string }
}

export type WorkRule = {
  id: string
  title: string
  description: string
  owner: string
  ownerId: string
  requester: string
  requesterId: string
  frequency: 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly'
  interval: number
  monthlyMode?: 'day-of-month' | 'last-weekday' | 'last-business-day'
  weekday?: number
  monthDay?: number
  nextRun: string
  dueTime: string
  priority: WorkItem['priority']
  category: string
  active: boolean
  createdAt: string
  lastGeneratedAt?: string
  /** 공휴일·주말과 겹쳤을 때: 그대로 / 앞당김 / 미룸 / 건너뜀 */
  holidayPolicy?: 'none' | 'before' | 'after' | 'skip'
  /** 매 회차에 체크박스로 펼쳐지는 점검 항목. 전부 마쳐야 완료 보고가 된다. */
  checklist?: { id: string; label: string }[]
  assignMode?: 'fixed' | 'rotation'
  rotation?: string[]
  rotationIndex?: number
  remindAfterMinutes?: number
  escalateAfterMinutes?: number
}

export type TenantIndustryType = 'food_manufacturing' | 'it_services'

/** 플랫폼 콘솔 사업체 지표 — 전부 서버 실집계. 값이 없으면 null/0이며 화면은 '아직 데이터 없음'으로 표시한다. */
export type TenantMetrics = {
  members: number
  todayActivity: number
  openTickets: number
  lastActivityAt: string | null
  pointsUsed: number | null
  storageBytes: number
  pendingAccounts?: number
  pendingProposals?: number
  sentinelAlerts?: number
}

export type TenantAdminSummary = { id: string; name: string; email: string; mustChangePassword?: boolean; temporaryPasswordExpiresAt?: string | null }

export type Tenant = {
  id: string
  name: string
  industry: string
  industryType: TenantIndustryType
  contract: '운영중' | '온보딩'
  service: '정상' | '주의'
  plan: string
  metrics: TenantMetrics
  admins?: TenantAdminSummary[]
  consent?: { version: string; agreedAt: string; agreedBy: string } | null
  consentCurrent?: boolean
}

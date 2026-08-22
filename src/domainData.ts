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
  review?: WorkReview
  reviewHistory?: WorkReview[]
  ruleId?: string
  ruleOccurrence?: string
  createdAt?: string
}

export type WorkRule = {
  id: string
  title: string
  description: string
  owner: string
  ownerId: string
  requester: string
  requesterId: string
  frequency: 'weekly' | 'monthly'
  interval: number
  monthlyMode?: 'day-of-month' | 'last-weekday'
  weekday?: number
  monthDay?: number
  nextRun: string
  dueTime: string
  priority: WorkItem['priority']
  category: string
  active: boolean
  createdAt: string
  lastGeneratedAt?: string
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
}

export type Tenant = {
  id: string
  name: string
  industry: string
  industryType: TenantIndustryType
  contract: '운영중' | '온보딩'
  service: '정상' | '주의'
  plan: string
  metrics: TenantMetrics
}

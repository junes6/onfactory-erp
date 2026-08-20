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

export const seaProducts: SeaProduct[] = [
  { id: 'SP-001', code: 'FG-MJG-300', name: '햇살바다 멍게젓 300g', shortName: '멍게젓', category: '젓갈', specification: '300g × 12병 / BOX', price: 15000, stock: 148, available: 132, safetyStock: 180, storage: '냉장 0~10℃', labelStatus: '수정필요', status: '주의', channels: 3, visual: 1 },
  { id: 'SP-002', code: 'FG-RCR-RMN-120', name: '햇살바다 붉은대게라면 120g', shortName: '붉은대게라면', category: '면류', specification: '120g × 40봉 / BOX', price: 1800, stock: 3240, available: 3150, safetyStock: 1500, storage: '실온 보관', labelStatus: '검토중', status: '정상', channels: 4, visual: 2 },
  { id: 'SP-003', code: 'FG-RCR-BTH-GFT', name: '붉은대게 육수다시 선물세트', shortName: '육수다시 선물세트', category: '조미식품', specification: '5g × 20포 × 2박스', price: 25000, stock: 412, available: 380, safetyStock: 200, storage: '실온·건조', labelStatus: '승인', status: '정상', channels: 4, visual: 3 },
  { id: 'SP-004', code: 'FG-NAT-MST-GFT', name: '자연다시 바이오 미스틱 선물세트', shortName: '바이오 미스틱', category: '조미식품', specification: '10g × 20스틱', price: 25000, stock: 96, available: 88, safetyStock: 120, storage: '실온·건조', labelStatus: '수정필요', status: '주의', channels: 3, visual: 4 },
  { id: 'SP-005', code: 'FG-RCR-FSH-500', name: '붉은대게 어간장 500mL', shortName: '붉은대게 어간장', category: '소스류', specification: '500mL × 12병', price: 11900, stock: 680, available: 654, safetyStock: 300, storage: '실온 보관', labelStatus: '승인', status: '정상', channels: 3, visual: 3 },
  { id: 'SP-006', code: 'FG-RCR-BTH-100', name: '붉은대게 육수다시 100g', shortName: '붉은대게 육수다시', category: '조미식품', specification: '5g × 20포', price: 13900, stock: 1120, available: 1040, safetyStock: 500, storage: '실온·건조', labelStatus: '검토중', status: '정상', channels: 4, visual: 3 },
  { id: 'SP-007', code: 'FG-OJG-300', name: '햇살바다 오징어젓 300g', shortName: '오징어젓', category: '젓갈', specification: '300g × 12병 / BOX', price: 13000, stock: 54, available: 54, safetyStock: 150, storage: '냉장 0~10℃', labelStatus: '수정필요', status: '주의', channels: 3, visual: 1 },
  { id: 'SP-008', code: 'FG-RCR-RICE-250', name: '붉은대게살 볶음밥 250g', shortName: '붉은대게살 볶음밥', category: '냉동식품', specification: '250g × 20팩', price: 6900, stock: 180, available: 0, safetyStock: 400, storage: '냉동 -18℃ 이하', labelStatus: '검토중', status: '품절', channels: 2, visual: 2 },
]

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

export const channelMetrics: ChannelMetric[] = [
  { id: 'coupang', name: '쿠팡', short: 'C', color: '#e94b35', orders: 142, units: 328, revenue: 4876000, delta: 12.4, sync: '1분 전', status: '정상' },
  { id: 'naver', name: '네이버 스마트스토어', short: 'N', color: '#03c75a', orders: 86, units: 174, revenue: 2984000, delta: 8.1, sync: '2분 전', status: '정상' },
  { id: 'gmarket', name: 'G마켓', short: 'G', color: '#0b57d0', orders: 38, units: 79, revenue: 1248000, delta: -3.2, sync: '5분 전', status: '주의' },
  { id: 'own', name: '자사몰', short: 'H', color: '#164c3f', orders: 27, units: 48, revenue: 918000, delta: 16.8, sync: '방금', status: '정상' },
]

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
  completion?: WorkCompletion
  review?: WorkReview
  ruleId?: string
  ruleOccurrence?: string
  createdAt?: string
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

export const initialWorkItems: WorkItem[] = [
  { id: 'WK-260819-01', title: 'G마켓 SKU 매핑 오류 2건 확인', description: '붉은대게라면 묶음상품 SKU와 ERP 품목코드를 다시 연결합니다.', owner: '김서원', ownerId: 'USR-SUNSEA-ADMIN', requestedBy: '김서원', requesterId: 'USR-SUNSEA-ADMIN', due: '오늘 15:30', priority: '긴급', status: '수행중', category: '판매채널' },
  { id: 'WK-260819-02', title: '멍게젓 제품정보 수정본 검토', description: '새우 알레르기와 멍게 원산지 문구를 최종 확인합니다.', owner: '박지현', ownerId: 'USR-SUNSEA-PARK', requestedBy: '김서원', requesterId: 'USR-SUNSEA-ADMIN', due: '오늘 16:00', priority: '높음', status: '결재대기', category: '제품' },
  { id: 'WK-260819-03', title: '붉은대게라면 내일 생산량 확정', description: '쿠팡 판매 증가분을 반영하여 1,200개 추가 생산 여부를 결정합니다.', owner: '오태식', ownerId: 'USR-SUNSEA-OH', requestedBy: '김서원', requesterId: 'USR-SUNSEA-ADMIN', due: '오늘 17:00', priority: '높음', status: '업무요청', category: '생산' },
  { id: 'WK-260819-04', title: '냉장 2창고 FEFO 피킹', description: '멍게젓 임박 LOT 18개를 오늘 주문에 우선 할당합니다.', owner: '서동현', ownerId: 'USR-SUNSEA-SEO', requestedBy: '김서원', requesterId: 'USR-SUNSEA-ADMIN', due: '오늘 17:30', priority: '보통', status: '업무요청', category: '재고' },
  { id: 'WK-260818-08', title: '육수다시 선물세트 상세페이지 승인', description: '3개 판매채널의 상품정보 일치 여부를 확인했습니다.', owner: '윤서진', ownerId: 'USR-SUNSEA-YOON', requestedBy: '박지현', requesterId: 'USR-SUNSEA-PARK', due: '어제', priority: '보통', status: '결재완료', category: '제품' },
]

export const initialWorkRules: WorkRule[] = [
  { id: 'WR-WEEKLY-QUALITY', title: '주간 표시사항 변경 점검', description: '변경된 원료·알레르기·원산지 문구를 매주 확인합니다.', owner: '박지현', ownerId: 'USR-SUNSEA-PARK', requester: '김서원', requesterId: 'USR-SUNSEA-ADMIN', frequency: 'weekly', interval: 1, weekday: 5, nextRun: '2026-08-21', dueTime: '16:00', priority: '높음', category: '제품', active: true, createdAt: '2026-08-19T09:00:00+09:00' },
  { id: 'WR-MONTHLY-STOCK', title: '월말 냉장창고 실사', description: '냉장창고 LOT 수량과 FEFO 배치를 매월 마지막 주 월요일에 대조합니다.', owner: '서동현', ownerId: 'USR-SUNSEA-SEO', requester: '김서원', requesterId: 'USR-SUNSEA-ADMIN', frequency: 'monthly', interval: 1, monthlyMode: 'last-weekday', weekday: 1, nextRun: '2026-08-31', dueTime: '17:00', priority: '보통', category: '재고', active: true, createdAt: '2026-08-19T09:05:00+09:00' },
]

export type Tenant = {
  id: string
  name: string
  industry: string
  contract: '운영중' | '온보딩'
  service: '정상' | '주의'
  health: number
  plan: string
  sites: number
  users: number
  activeUsers: number
  integrations: string
  sync: string
  tickets: number
  aiUsage: string
  storage: string
  csm: string
}

export const tenants: Tenant[] = [
  { id: 'TEN-HSB-001', name: '햇살바다', industry: '수산가공 · HMR · 온라인 유통', contract: '운영중', service: '정상', health: 98, plan: 'Enterprise', sites: 2, users: 46, activeUsers: 28, integrations: '5 / 5', sync: '14:42', tickets: 1, aiUsage: '1,284 / 5,000', storage: '41.8 / 100GB', csm: '이민지' },
  { id: 'TEN-PSC-002', name: '포항시수산가공협동조합', industry: '수산가공 · 조합 공동판매', contract: '온보딩', service: '주의', health: 82, plan: 'Growth', sites: 1, users: 24, activeUsers: 11, integrations: '3 / 5', sync: '14:36', tickets: 3, aiUsage: '412 / 2,000', storage: '13.2 / 50GB', csm: '박하늘' },
]

export const csTickets = [
  { id: 'CS-260818-021', tenant: '포항시수산가공협동조합', title: 'G마켓 SKU 27개 매핑 실패', priority: 'P1', status: '기술팀 처리중', sla: '37분 남음', owner: '김도윤' },
  { id: 'CS-260818-019', tenant: '포항시수산가공협동조합', title: '네이버 API 권한 인증', priority: 'P2', status: '고객 회신 대기', sla: '일시정지', owner: '박하늘' },
  { id: 'CS-260817-031', tenant: '포항시수산가공협동조합', title: '초기 품목 12개 중복코드 검증', priority: 'P2', status: '수정본 검증중', sla: '2시간 12분', owner: '이민지' },
  { id: 'CS-260817-028', tenant: '햇살바다', title: '제품 이미지 일괄등록 문의', priority: 'P3', status: '고객 확인 대기', sla: '18시간', owner: '이민지' },
]

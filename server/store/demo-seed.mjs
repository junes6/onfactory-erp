// Demo-only fixtures live outside the runtime application so production code
// can boot from an empty database without tenant-specific branches.
export const DEFAULT_LOCAL_DEMO_PASSWORD = 'demo1234'

export const LEGACY_ID_BY_NAME = new Map([
  ['박지현', 'park'], ['오태식', 'oh'], ['서동현', 'seo'], ['윤서진', 'yoon'], ['이정민', 'lee'], ['한예린', 'han'],
])

export const DEMO_ACCOUNT_DEFINITIONS = Object.freeze([
  { id: 'USR-SUNSEA-ADMIN', name: '김서원', email: 'admin@sunsea.co.kr', role: 'tenant-admin', tenantId: 'TENANT-SUNSEA', tenantName: '햇살바다', team: '경영지원', jobRole: '운영 관리자', requested: '초기 관리자', approved: true, approvalStatus: 'approved' },
  { id: 'USR-POHANG-ADMIN', name: '박해진', email: 'admin@pohangcoop.co.kr', role: 'tenant-admin', tenantId: 'TENANT-POHANG', tenantName: '포항시수산가공협동조합', team: '조합 운영', jobRole: '운영 관리자', requested: '초기 관리자', approved: true, approvalStatus: 'approved' },
  { id: 'USR-ONFACTORY-OPS', name: '김서원', email: 'operator@onfactory.co.kr', role: 'platform-operator', tenantId: null, tenantName: null, team: '플랫폼 운영', jobRole: 'Platform Operator', requested: '초기 운영자', approved: true, approvalStatus: 'approved' },
  { id: 'USR-SUNSEA-PARK', name: '박지현', email: 'jihyun.park@sunsea.co.kr', role: 'tenant-member', tenantId: 'TENANT-SUNSEA', tenantName: '햇살바다', team: '품질관리', jobRole: '품질 책임자', requested: '기존 구성원', approved: true, approvalStatus: 'approved' },
  { id: 'USR-SUNSEA-OH', name: '오태식', email: 'taesik.oh@sunsea.co.kr', role: 'tenant-member', tenantId: 'TENANT-SUNSEA', tenantName: '햇살바다', team: '생산 1팀', jobRole: '생산 반장', requested: '기존 구성원', approved: true, approvalStatus: 'approved' },
  { id: 'USR-SUNSEA-SEO', name: '서동현', email: 'donghyun.seo@sunsea.co.kr', role: 'tenant-member', tenantId: 'TENANT-SUNSEA', tenantName: '햇살바다', team: '물류팀', jobRole: '재고 담당', requested: '기존 구성원', approved: true, approvalStatus: 'approved' },
  { id: 'USR-SUNSEA-YOON', name: '윤서진', email: 'seojin.yoon@sunsea.co.kr', role: 'tenant-member', tenantId: 'TENANT-SUNSEA', tenantName: '햇살바다', team: '판매운영', jobRole: '온라인 MD', requested: '기존 구성원', approved: true, approvalStatus: 'approved' },
  { id: 'USR-SUNSEA-LEE', name: '이정민', email: 'jungmin.lee@sunsea.co.kr', role: 'tenant-member', tenantId: 'TENANT-SUNSEA', tenantName: '햇살바다', team: '품질관리', jobRole: '품질 담당', requested: '기존 구성원', approved: true, approvalStatus: 'approved' },
  { id: 'USR-SUNSEA-HAN', name: '한예린', email: 'yerin.han@sunsea.co.kr', role: 'tenant-member', tenantId: 'TENANT-SUNSEA', tenantName: '햇살바다', team: '구매팀', jobRole: '원부자재 구매', requested: '기존 구성원', approved: true, approvalStatus: 'approved' },
  { id: 'USR-SUNSEA-PENDING', name: '신규 직원', email: 'newstaff@sunsea.co.kr', role: 'tenant-member', tenantId: 'TENANT-SUNSEA', tenantName: '햇살바다', team: '생산 1팀', jobRole: '생산 작업자', requested: '오늘 09:24', approved: false, approvalStatus: 'pending' },
  // it_services 업종 모듈 검증용 데모 테넌트의 관리자 (실운영 3D뮤즈 계정과는 별개 이메일)
  { id: 'USR-3DMUSE-ADMIN', name: '김뮤즈', email: 'admin@3dmuse.demo', role: 'tenant-admin', tenantId: 'TENANT-3DMUSE', tenantName: '3D뮤즈', team: '경영지원', jobRole: '운영 관리자', requested: '초기 관리자', approved: true, approvalStatus: 'approved' },
])

export const PLATFORM_TENANT_FIXTURES = Object.freeze([
  // 지표(멤버 수·활동·티켓·포인트·용량)는 시드에 넣지 않는다 — 전부 스토어 실집계로 계산된다.
  { id: 'TENANT-SUNSEA', name: '햇살바다', industry: '수산가공 · HMR · 온라인 유통', industryType: 'food_manufacturing', contract: '운영중', plan: 'Enterprise', adminEmail: 'admin@sunsea.co.kr', adminAccount: { id: 'USR-SUNSEA-ADMIN', name: '김서원', email: 'admin@sunsea.co.kr', team: '경영지원', jobRole: '운영 관리자' }, createdAt: '2026-08-01T00:00:00.000Z' },
  { id: 'TENANT-POHANG', name: '포항시수산가공협동조합', industry: '수산가공 · 조합 공동판매', industryType: 'food_manufacturing', contract: '온보딩', plan: 'Growth', adminEmail: 'admin@pohangcoop.co.kr', adminAccount: { id: 'USR-POHANG-ADMIN', name: '박해진', email: 'admin@pohangcoop.co.kr', team: '조합 운영', jobRole: '운영 관리자' }, createdAt: '2026-08-01T00:00:00.000Z' },
  { id: 'TENANT-3DMUSE', name: '3D뮤즈', industry: '3D 콘텐츠 · IT 서비스', industryType: 'it_services', contract: '온보딩', plan: 'Growth', adminEmail: 'admin@3dmuse.demo', adminAccount: { id: 'USR-3DMUSE-ADMIN', name: '김뮤즈', email: 'admin@3dmuse.demo', team: '경영지원', jobRole: '운영 관리자' }, createdAt: '2026-08-21T00:00:00.000Z' },
])

export const PLATFORM_INTEGRATION_FIXTURES = Object.freeze([
  ...[['COUPANG', '쿠팡', 'C', '판매채널', '정상', '14:42', '수집 지연 없음', '99.9%'], ['NAVER', '네이버 스마트스토어', 'N', '판매채널', '정상', '14:41', '인증 유효', '100%'], ['GMARKET', 'G마켓', 'G', '판매채널', '주의', '14:38', 'SKU 매핑 2건', '99.7%'], ['DELIVERY', '택배 연동', 'T', '물류', '정상', '14:40', '송장 상태 정상', '99.9%'], ['CLAUDE', 'Claude AI', 'AI', 'AI', '정상', '14:42', '응답 지연 정상', '99.8%']].map(([suffix, name, short, kind, status, lastSync, result, successRate]) => ({ id: `SUNSEA-${suffix}`, tenantId: 'TENANT-SUNSEA', name, short, kind, status, lastSync, result, successRate })),
  ...[['COUPANG', '쿠팡', 'C', '판매채널', '정상', '14:36', '수집 지연 없음', '99.8%'], ['NAVER', '네이버 스마트스토어', 'N', '판매채널', '설정중', '—', '고객 인증 대기', '—'], ['GMARKET', 'G마켓', 'G', '판매채널', '주의', '14:31', 'SKU 매핑 점검 필요', '91.4%'], ['DELIVERY', '택배 연동', 'T', '물류', '정상', '14:34', '송장 상태 정상', '99.6%'], ['CLAUDE', 'Claude AI', 'AI', 'AI', '정상', '14:35', '응답 지연 정상', '99.5%']].map(([suffix, name, short, kind, status, lastSync, result, successRate]) => ({ id: `POHANG-${suffix}`, tenantId: 'TENANT-POHANG', name, short, kind, status, lastSync, result, successRate })),
])

const ticketSeeds = [
  { id: 'CS-260818-021', tenantId: 'TENANT-POHANG', tenant: '포항시수산가공협동조합', title: 'G마켓 SKU 27개 매핑 실패', priority: 'P1', status: '기술팀 처리중', sla: '37분 남음', owner: '김도윤' },
  { id: 'CS-260818-019', tenantId: 'TENANT-POHANG', tenant: '포항시수산가공협동조합', title: '네이버 API 권한 인증', priority: 'P2', status: '고객 회신 대기', sla: '일시정지', owner: '박하늘' },
  { id: 'CS-260817-031', tenantId: 'TENANT-POHANG', tenant: '포항시수산가공협동조합', title: '초기 품목 12개 중복코드 검증', priority: 'P2', status: '수정본 검증중', sla: '2시간 12분', owner: '이민지' },
  { id: 'CS-260817-028', tenantId: 'TENANT-SUNSEA', tenant: '햇살바다', title: '제품 이미지 일괄등록 문의', priority: 'P3', status: '고객 회신 대기', sla: '18시간', owner: '이민지' },
]
export const PLATFORM_TICKET_FIXTURES = Object.freeze(ticketSeeds.map((ticket) => ({
  ...ticket, description: `${ticket.title} 관련 고객 지원 요청입니다.`, createdAt: '2026-08-18T05:00:00.000Z', updatedAt: '2026-08-18T05:00:00.000Z',
  history: [{ id: `${ticket.id}-H1`, at: '2026-08-18 14:00', title: 'CS 접수', detail: ticket.title, actor: '플랫폼 운영' }],
})))

export const PLATFORM_AUDIT_FIXTURES = Object.freeze([
  { id: 'AUD-260818-104', tenantId: 'TENANT-SUNSEA', at: '2026-08-18 14:24', event: '지원 세션 정상 종료', scope: '설정 조회 · 읽기 전용 · 9분', actor: '지원팀 김도윤', result: '완료', reference: 'CS-260817-028' },
  { id: 'AUD-260818-098', tenantId: 'TENANT-POHANG', at: '2026-08-18 13:58', event: '연동 상태 진단 실행', scope: 'G마켓 설정 메타데이터', actor: '시스템 자동화', result: '검토필요', reference: 'CS-260818-021' },
  { id: 'AUD-260818-083', tenantId: 'TENANT-POHANG', at: '2026-08-18 11:32', event: 'CS 담당 조직 변경', scope: '기술지원팀으로 이관', actor: 'CSM 박하늘', result: '완료', reference: 'CS-260818-021' },
  { id: 'AUD-260817-241', tenantId: 'TENANT-SUNSEA', at: '2026-08-17 17:10', event: '지원 세션 요청 승인', scope: '설정 조회 · 15분 제한', actor: '고객사 관리자', result: '완료', reference: 'CS-260817-028' },
])

export function legacyConversationParticipantIds(conversation) {
  if (Array.isArray(conversation?.participantIds) && conversation.participantIds.length > 0) return conversation.participantIds
  if (conversation?.id === 'team-ops') return []
  if (conversation?.id === 'team-quality') return ['park', 'lee']
  if (conversation?.type === 'direct' && typeof conversation.memberId === 'string') return ['USR-SUNSEA-ADMIN', conversation.memberId]
  return []
}

export const DEMO_PLATFORM_FIXTURES = Object.freeze({
  tenants: PLATFORM_TENANT_FIXTURES,
  supportTickets: PLATFORM_TICKET_FIXTURES,
  integrations: PLATFORM_INTEGRATION_FIXTURES,
  actions: [],
  auditEvents: PLATFORM_AUDIT_FIXTURES,
})

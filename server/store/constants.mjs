export const WORKSPACE_TABLES = Object.freeze({
  'work-items': 'work_items',
  'inventory-locations': 'inventory_locations',
  'sales-channels': 'sales_channels',
  'messenger-conversations': 'messenger_conversations',
  'calendar-events': 'calendar_events',
  'daily-journals': 'daily_journals',
  'leave-requests': 'leave_requests',
  'account-requests': 'account_requests',
  'factory-locations': 'factory_locations',
  'factory-layouts': 'factory_layouts',
  'leave-management': 'leave_management',
  'work-rules': 'work_rules',
  'product-catalog': 'product_catalog',
  'inventory-movements': 'inventory_movements',
  'calendar-departments': 'calendar_departments',
  'sales-shipments': 'sales_shipments',
  'compliance-records': 'compliance_records',
  'document-storage-settings': 'document_storage_settings',
  'performance-settings': 'performance_settings',
  'performance-reports': 'performance_report_snapshots',
  'attendance-records': 'attendance_records',
  'personal-todos': 'personal_todos',
  // it_services 업종 모듈
  'it-projects': 'it_projects',
  'it-deliverables': 'it_deliverables',
  'it-contracts': 'it_contracts',
  // 승인 큐: 기존 코어 테이블을 채운다
  'ai-proposals': 'proposals',
  'automation-policies': 'automation_policies',
  // R7: 거래처·지원사업(IT), 프로젝트 공간
  'it-clients': 'it_clients',
  'it-support-programs': 'it_support_programs',
  'project-spaces': 'project_spaces',
  'project-posts': 'project_posts',
  // R9: 세무·자산, 지식재산
  'company-assets': 'company_assets',
  'tax-events': 'tax_events',
  'ip-rights': 'ip_rights',
  // P11: 세무사 전달 이력 (서버 전용 기록)
  'tax-deliveries': 'tax_deliveries',
  // R11-B: 파일 렌즈 정의 (코어 lenses 테이블 재사용)
  'document-lenses': 'lenses',
  // R11-G: 외부 기회 신호 (인제스트 결과 + 테넌트 감시 설정)
  'opportunities': 'opportunities',
  'opportunity-settings': 'opportunity_settings',
  // R11-C: 대표 브리핑 스냅샷
  'digests': 'digests',
  // P2: 알림 센터 (알림 · 유형별 설정 · 웹푸시 구독)
  'notifications': 'notifications',
  'notification-settings': 'notification_settings',
  'push-subscriptions': 'push_subscriptions',
  // R15-E: AI 대화 히스토리 (계정 소유·테넌트 격리)
  'ai-conversations': 'ai_conversations',
})

export const WORKSPACE_KEYS = Object.freeze(Object.keys(WORKSPACE_TABLES))
export const WORKSPACE_KEY_SET = new Set(WORKSPACE_KEYS)
export const COMPANY_DOCUMENTS_KEY = 'company-documents'

export const WORKSPACE_SHAPES = Object.freeze({
  'factory-layouts': 'object-map',
  'leave-management': 'singleton',
  'document-storage-settings': 'singleton',
  'performance-settings': 'singleton',
  'attendance-records': 'singleton',
  'opportunity-settings': 'singleton',
  // 계정별 설정을 한 레코드에 담는다 (배열이 아니다).
  'notification-settings': 'singleton',
})

export const ARRAY_WORKSPACE_KEYS = new Set(
  WORKSPACE_KEYS.filter((key) => !Object.prototype.hasOwnProperty.call(WORKSPACE_SHAPES, key)),
)

export const STORE_BACKENDS = new Set(['postgres', 'json'])

export const emptyWorkspaceStore = () => ({
  version: 2,
  tenants: {},
  platform: {
    tenants: [],
    supportTickets: [],
    integrations: [],
    actions: [],
    auditEvents: [],
  },
  // R11-D: 계정 소유 개인 지식 코어 (테넌트 격리 위의 별도 계층)
  personal: {},
  accountApprovals: {},
  accountCredentials: {},
  invitedAccounts: [],
  passwordResetRequests: [],
  // A절: 외부 게스트 권한(grant). 테넌트 키가 아니라 invitedAccounts와 같은 최상위 컬렉션이다 —
  // 계정은 invitedAccounts(role 'tenant-guest')에, "어느 프로젝트까지"는 여기에 둔다.
  guestGrants: [],
})

// 게스트 RLS 정책이 걸린 테이블. PostgresStoreAdapter.guestVisibleIds가 이 밖의 테이블을 거절한다 —
// 정책 없는 테이블에 게스트 컨텍스트로 SELECT하면 FORCE RLS가 아닌 경우 전량이 보이기 때문이다.
export const GUEST_SCOPE_TABLES = Object.freeze({
  project_spaces: Object.freeze({}),
  project_posts: Object.freeze({}),
  work_items: Object.freeze({}),
  messenger_conversations: Object.freeze({}),
  // items는 여러 종류를 담는 공용 테이블이라 회사 자료만 걸러 본다.
  items: Object.freeze({ itemType: 'company-document' }),
})

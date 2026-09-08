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
  // R16-B: 프로젝트 템플릿. 전용 라우트(/api/project-templates)로만 읽고 쓴다.
  // 본문에는 역할 문자열과 상대 마감일만 — 실명·계정 id는 저장하지 않는다.
  'project-templates': 'project_templates',
  // R16-D: 공지 게시글 + 필독 확인. 채널 안에 살지만 메시지가 아니다 —
  // 장문·확인 명단·리마인더 이력을 방당 5,000건 상한과 4,000자 상한 안에 우겨넣지 않는다.
  'notices': 'notices',
  // R16-L: 외부 연동. 엔드포인트에는 tokenHash(sha256)와 봉인된 서명키(AES-256-GCM)만 들어간다.
  // platform 컬렉션이 아니라 테넌트 키에 두는 이유: platform은 PG에서 다섯 개만 동기화되고,
  // stripSensitivePayload가 token/secret이 든 키를 지워 재기동 후 조용히 사라진다.
  'webhook-endpoints': 'webhook_endpoints',
  'webhook-deliveries': 'webhook_deliveries',
  // R16-K: 저장된 보기(목록·보드·캘린더·타임라인 + 필터·정렬). '내 것만' 또는 '전사 공유'가 행마다 다르므로
  // WORKSPACE_STORE_KEYS에는 넣지 않는다 — generic PUT에는 행 단위 소유권 개념이 없어 직원이 남의 보기를 통째로 덮어쓴다.
  'saved-views': 'saved_views',
  // R16-K: 업무 커스텀 필드 '정의'만 산다. 값은 work-items payload의 fields 안에 있다 —
  // 정의를 바꿔도 값은 그 자리에 남고, 대조는 저장 직전 배열 후검증(customFieldViolation)에서 한 번 한다.
  'custom-fields': 'custom_fields',
  // R16-E: 구글 캘린더 연결(계정 소유·토큰 암호문)과 항목별 동기화 링크(외부 id·해시·덮어쓴 내역).
  // 링크를 calendar-events 행에 얹지 않는 이유: hasCalendarShape(server/app.mjs)가 CALENDAR_FIELDS 밖 키를
  // 전부 거절해 전 직원의 일정 쓰기가 403이 된다.
  // WORKSPACE_STORE_KEYS(server/app.mjs)에는 **일부러 넣지 않는다** — 미등록 키는 generic GET/PUT이
  // 테넌트 검사보다 먼저 404 STORE_KEY_NOT_FOUND를 낸다. 403 ..._ROUTE_REQUIRED는 "그런 키가 있다"는
  // 존재 오라클이고, 토큰 암호문을 담는 키에는 그것을 만들지 않는다(ai-conversations 선례).
  'calendar-connections': 'calendar_connections',
  'calendar-sync-links': 'calendar_sync_links',
  // R16-G: Flow 파일함 벌크 이관. 세션 행과 청크 행이 같은 키에 산다 —
  // 엔트리를 세션 행에 인라인하면 파일 하나 올릴 때마다 5,000엔트리짜리 payload를 다시 쓴다.
  // WORKSPACE_STORE_KEYS에는 넣지 않는다: generic PUT에는 '이 세션은 누구 것인가'가 없어
  // 직원 하나가 남의 이관 상태를 통째로 덮어쓸 수 있다. 전용 라우트만 문이 된다.
  'bulk-imports': 'bulk_imports',
  'bulk-import-rules': 'bulk_import_rules',
  // R16-H: 문서(위키). 본문·블록은 wiki_documents, 버전 이력은 wiki_revisions에 나눠 둔다.
  // 한 배열에 합치면 문서 한 건을 읽을 때마다 그 문서의 이력 전체가 함께 딸려 온다.
  // WORKSPACE_STORE_KEYS(server/app.mjs)에는 넣지 않는다 — generic GET/PUT은 404 STORE_KEY_NOT_FOUND로
  // 끝나고 전용 라우트만 문이 된다. 열어 두면 누구든 PUT 한 번으로 병합·이력·링크 인가를 통째로 우회한다.
  'wiki-documents': 'wiki_documents',
  'wiki-revisions': 'wiki_revisions',
  // R16-I: 양식형 전자결재. 양식 정의(+대결자 설정)와 결재 문서를 나눠 둔다.
  // 한 배열에 합치면 양식 한 장을 읽을 때마다 그 회사의 결재 문서 전체가 딸려 온다.
  'approval-forms': 'approval_forms',
  'approval-documents': 'approval_documents',
  // R16-M: 회의록. 전사 원문과 요약이 payload 안에 산다 — 회의 음성은 개인정보라
  // 게스트 정책도, generic PUT 도 열지 않고 전용 라우트만 문이 된다(M3).
  'meeting-notes': 'meeting_notes',
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
  // R16-D: 게스트는 초대된 프로젝트 채널의 공지만 본다(notices_guest_read). 회사 공지는 정책의 scope 조건에서 걸린다.
  notices: Object.freeze({}),
})

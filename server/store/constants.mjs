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
})

export const WORKSPACE_KEYS = Object.freeze(Object.keys(WORKSPACE_TABLES))
export const WORKSPACE_KEY_SET = new Set(WORKSPACE_KEYS)
export const COMPANY_DOCUMENTS_KEY = 'company-documents'

export const WORKSPACE_SHAPES = Object.freeze({
  'factory-layouts': 'object-map',
  'leave-management': 'singleton',
  'document-storage-settings': 'singleton',
  'performance-settings': 'singleton',
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
  accountApprovals: {},
  accountCredentials: {},
  invitedAccounts: [],
  passwordResetRequests: [],
})

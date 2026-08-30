import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1))), '..')

function walk(directory, extensions) {
  const result = []
  for (const entry of readdirSync(directory)) {
    const target = path.join(directory, entry)
    if (statSync(target).isDirectory()) result.push(...walk(target, extensions))
    else if (extensions.some((extension) => target.endsWith(extension))) result.push(target)
  }
  return result
}

function relative(file) {
  return path.relative(root, file).replaceAll('\\', '/')
}

function linesFor(source, pattern) {
  const matches = []
  for (const match of source.matchAll(pattern)) matches.push(source.slice(0, match.index).split('\n').length)
  return matches
}

const errors = []
const productFiles = [
  ...walk(path.join(root, 'src'), ['.ts', '.tsx']),
  path.join(root, 'server', 'app.mjs'),
].filter((file) => !file.endsWith('.test.mjs'))

const forbiddenDemoPatterns = [
  [/\bisSunseaDemo\b/g, 'tenant ID 기반 데모 분기'],
  [/\bseedDemoData\b/g, '런타임 데모 seed prop'],
  [/\bisSunseaFixture\w*\b/g, '데모 fixture 필터'],
  [/\bUSR-SUNSEA(?:-[A-Z]+)?\b/g, '하드코딩 데모 사용자 ID'],
  [/\bdemo1234\b/g, '하드코딩 데모 비밀번호'],
  [/햇살바다/g, '하드코딩 데모 고객사/제품 데이터'],
  [/포항시수산가공협동조합/g, '하드코딩 데모 고객사 데이터'],
]

for (const file of productFiles) {
  const source = readFileSync(file, 'utf8')
  for (const [pattern, label] of forbiddenDemoPatterns) {
    for (const line of linesFor(source, pattern)) errors.push(`${relative(file)}:${line} ${label}`)
  }
}

for (const file of walk(path.join(root, 'src'), ['.ts', '.tsx'])) {
  if (file.endsWith(path.join('utils', 'dateTime.ts'))) continue
  const source = readFileSync(file, 'utf8')
  for (const line of linesFor(source, /new\s+Intl\.DateTimeFormat\b/g)) {
    errors.push(`${relative(file)}:${line} 화면별 Intl.DateTimeFormat 사용 — dateTime 유틸을 사용하세요.`)
  }
  for (const line of linesFor(source, /new\s+Date\([^\n;]*\)\.toLocale(?:DateString|TimeString|String)\b/g)) {
    errors.push(`${relative(file)}:${line} 화면별 날짜 문자열 변환 — dateTime 유틸을 사용하세요.`)
  }
}

const schemaPath = path.join(root, 'db', 'postgres-schema.sql')
const schema = readFileSync(schemaPath, 'utf8').toLowerCase()
const requiredTables = [
  'spaces', 'space_members', 'items', 'proposals', 'lenses', 'decisions', 'playbooks',
  'automation_policies', 'bookmarks', 'events', 'audit_log',
  'core_tenants', 'core_accounts', 'auth_sessions', 'account_invites', 'password_reset_requests',
  'principles', 'personal_notes', 'correction_log', 'knowledge_gaps',
]
for (const table of requiredTables) {
  if (!new RegExp(`create\\s+table\\s+if\\s+not\\s+exists\\s+${table}\\b`, 'i').test(schema)) {
    errors.push(`db/postgres-schema.sql:1 필수 테이블 누락: ${table}`)
  }
}

const requiredCoreColumns = {
  items: ['storage_key', 'mime', 'size', 'hash', 'ai_policy', 'version_group_id', 'version_no', 'summary'],
  proposals: ['kind', 'payload', 'confidence', 'status', 'decision_diff'],
  events: ['event_type', 'org_id', 'scope', 'payload', 'processed_at'],
}
for (const [table, columns] of Object.entries(requiredCoreColumns)) {
  const definition = schema.match(new RegExp(`create\\s+table\\s+if\\s+not\\s+exists\\s+${table}\\s*\\(([\\s\\S]*?)\\);`, 'i'))?.[1] ?? ''
  for (const column of columns) {
    if (!new RegExp(`\\b${column}\\b`, 'i').test(definition)) errors.push(`db/postgres-schema.sql:1 ${table}.${column} 필수 컬럼 누락`)
  }
}

if (/create\s+table(?:\s+if\s+not\s+exists)?\s+app_state\b/i.test(schema)) {
  errors.push('db/postgres-schema.sql:1 app_state JSON blob 테이블은 사용할 수 없습니다.')
}

const workspaceTables = [
  'work_items', 'messenger_conversations', 'calendar_events', 'sales_channels', 'inventory_locations',
  'factory_locations', 'leave_requests', 'account_requests', 'daily_journals', 'work_rules',
  'inventory_movements', 'product_catalog', 'leave_management', 'factory_layouts', 'calendar_departments',
  'document_storage_settings', 'compliance_records', 'sales_shipments', 'performance_settings', 'performance_report_snapshots',
  'it_projects', 'it_deliverables', 'it_contracts', 'proposals', 'automation_policies', 'it_clients', 'it_support_programs', 'project_spaces', 'project_posts', 'company_assets', 'tax_events', 'ip_rights',
  'attendance_records', 'tax_deliveries', 'lenses', 'opportunities', 'opportunity_settings', 'digests',
]
for (const table of workspaceTables) {
  const definition = schema.match(new RegExp(`create\\s+table\\s+if\\s+not\\s+exists\\s+${table}\\s*\\(([\\s\\S]*?)\\);`, 'i'))?.[1] ?? ''
  for (const column of ['id', 'org_id', 'created_at', 'updated_at', 'deleted_at', 'created_by']) {
    if (!new RegExp(`\\b${column}\\b`, 'i').test(definition)) errors.push(`db/postgres-schema.sql:1 ${table}.${column} 공통 컬럼 누락`)
  }
}

const requiredArtifacts = [
  'scripts/migrate-json-to-pg.mjs',
  'scripts/seed-demo.mjs',
  'server/storage/index.mjs',
  'server/storage/local.mjs',
  'server/storage/s3.mjs',
  'server/store/index.mjs',
  'server/store/json-store.mjs',
  'server/store/postgres-store.mjs',
  'server/billing-service.mjs',
  'server/billing-repository.mjs',
  'server/billing-routes.mjs',
  'server/performance-service.mjs',
  'server/performance-routes.mjs',
  'drizzle/0002_billing.sql',
  'supabase/migrations/20260821000000_billing.sql',
  'src/components/BillingDashboard.tsx',
  'src/components/PerformanceReports.tsx',
  'src/tokens.css',
  'src/utils/dateTime.ts',
  'server/personal-core.mjs',
  'server/personal-core-routes.mjs',
  'supabase/migrations/20260831020000_personal_core.sql',
]
for (const artifact of requiredArtifacts) {
  try { statSync(path.join(root, artifact)) }
  catch { errors.push(`${artifact}:1 필수 산출물 누락`) }
}

try {
  const storageSource = readFileSync(path.join(root, 'server/storage/index.mjs'), 'utf8')
  for (const operation of ['put', 'get', 'delete', 'getSignedUrl']) {
    const adapters = ['local.mjs', 's3.mjs']
    for (const adapter of adapters) {
      const source = readFileSync(path.join(root, 'server/storage', adapter), 'utf8')
      if (!new RegExp(`(?:async\\s+)?${operation.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*\\(`).test(source)) {
        errors.push(`server/storage/${adapter}:1 storage.${operation} 구현 누락`)
      }
    }
  }
  if (!/FILE_STORAGE_BACKEND/.test(storageSource)) errors.push('server/storage/index.mjs:1 FILE_STORAGE_BACKEND 스위치 누락')
} catch { /* required artifact errors above are clearer */ }

try {
  const billingSchema = readFileSync(path.join(root, 'supabase', 'migrations', '20260821000000_billing.sql'), 'utf8').toLowerCase()
  for (const table of ['billing_model_rates', 'billing_plans', 'billing_tenant_assignments', 'billing_usage_reservations', 'billing_usage_events', 'billing_storage_daily_snapshots', 'billing_monthly_snapshots']) {
    if (!new RegExp(`create\\s+table\\s+if\\s+not\\s+exists\\s+${table}\\b`, 'i').test(billingSchema)) {
      errors.push(`supabase/migrations/20260821000000_billing.sql:1 비용 원장 테이블 누락: ${table}`)
    }
  }
  if (!/billing_monthly_snapshots_immutable/i.test(billingSchema)) errors.push('supabase/migrations/20260821000000_billing.sql:1 월 청구 불변성 트리거 누락')
} catch { /* required artifact errors above are clearer */ }

if (errors.length) {
  console.error(`[architecture] ${errors.length}개 위반을 발견했습니다.`)
  console.error(errors.join('\n'))
  process.exitCode = 1
} else {
  console.log('[architecture] 데모 분리·필수 코어 테이블·20개 행 테이블 공통 컬럼 계약을 통과했습니다.')
}

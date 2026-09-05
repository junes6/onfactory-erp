import { config } from 'dotenv'
import path from 'node:path'
import Anthropic from '@anthropic-ai/sdk'

import { createApp } from './app.mjs'
import { createPostgresBillingRepository } from './billing-repository.mjs'
import { createBillingService, createMemoryBillingRepository } from './billing-service.mjs'
import { performanceMaintenanceErrors, runPerformanceMonthlyMaintenance } from './performance-maintenance.mjs'
import { initializeRuntimeStore } from './store/index.mjs'
import { backupSettings } from './backup-mirror.mjs'
import { createMailDelivery } from './mail-delivery.mjs'

// .env.local is already covered by the project's *.local gitignore rule.
config({ path: '.env.local', quiet: true })

const rawPort = Number.parseInt(process.env.PORT ?? '8787', 10)
const port = Number.isInteger(rawPort) && rawPort > 0 ? rawPort : 8787
const host = process.env.HOST?.trim() || '127.0.0.1'
const dataDirectory = path.resolve(process.env.ONFACTORY_DATA_DIRECTORY?.trim() || 'server/data')
const workspaceStoreFile = path.resolve(process.env.WORKSPACE_STORE_FILE?.trim() || path.join(dataDirectory, 'workspace-state.json'))
const runtimeStore = await initializeRuntimeStore({ workspaceStoreFile })
if (runtimeStore.adapter.fallbackReason) console.warn(`[store] ${runtimeStore.adapter.fallbackReason}`)
const billingRepository = runtimeStore.adapter.kind === 'postgres'
  ? createPostgresBillingRepository(runtimeStore.adapter.pool)
  : createMemoryBillingRepository()
const billingService = createBillingService({ repository: billingRepository })
const performanceModel = process.env.CLAUDE_MODEL?.trim() || 'claude-sonnet-5'
const performanceClient = process.env.ANTHROPIC_API_KEY?.trim()
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY.trim(), maxRetries: 1, timeout: 60_000 })
  : null
// 메일 어댑터. MAIL_TRANSPORT가 없으면 null이고, 초대·재설정 링크는 화면에서 복사해 전달한다.
const mailDelivery = createMailDelivery({ env: process.env })
const app = createApp({
  initialWorkspaceStore: runtimeStore.workspaceStore,
  sessions: runtimeStore.sessions,
  workspaceStoreFile,
  dataDirectory,
  onWorkspaceStoreChange: (workspaceStore) => runtimeStore.adapter.commitSnapshot(workspaceStore),
  // Postgres 모드에서 게스트 GET을 RLS와 교집합할 어댑터(guestVisibleIds가 있을 때만 쓰인다).
  storeAdapter: runtimeStore.adapter,
  guestInviteDelivery: mailDelivery?.sendGuestInvitation ?? null,
  passwordResetDelivery: mailDelivery?.sendPasswordReset ?? null,
  seedPlatformFixtures: runtimeStore.adapter.kind === 'json' && !runtimeStore.adapter.readOnly,
  seedDemoAccounts: runtimeStore.adapter.kind === 'json',
  skipStartupMigrations: runtimeStore.adapter.kind === 'postgres',
  billingService,
  kstartupServiceKey: process.env.KSTARTUP_SERVICE_KEY?.trim() || '',
  bizinfoCertKey: process.env.BIZINFO_CERT_KEY?.trim() || '',
  bizinfoCommercialUseApproved: process.env.BIZINFO_COMMERCIAL_USE_APPROVED?.trim().toLowerCase() === 'true',
  g2bServiceKey: process.env.G2B_SERVICE_KEY?.trim() || '',
  ulsanServiceKey: process.env.ULSAN_SERVICE_KEY?.trim() || '',
  storeStatus: {
    kind: runtimeStore.adapter.kind,
    readOnly: Boolean(runtimeStore.adapter.readOnly),
    fallbackReason: runtimeStore.adapter.fallbackReason ?? null,
  },
})

function previousBillingMonth(now = new Date()) {
  const seoul = new Date(now.getTime() + 9 * 60 * 60 * 1_000)
  const previous = new Date(Date.UTC(seoul.getUTCFullYear(), seoul.getUTCMonth() - 1, 1))
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, '0')}`
}

const scheduleTenantIds = () => new Set([
  ...Object.keys(runtimeStore.workspaceStore.tenants ?? {}),
  ...(runtimeStore.workspaceStore.platform?.tenants ?? []).map((tenant) => tenant.id).filter(Boolean),
])

/** 사용량 정산. 예약 후 확정되지 못한 호출을 정리한다. */
async function reconcileUsage() {
  const failures = []
  const tenantIds = scheduleTenantIds()
  for (const tenantId of tenantIds) {
    try {
      await billingService.reconcilePendingUsageBatch({ id: 'system:billing-reconciliation', role: 'system', trusted: true, tenantId }, { tenantId })
    } catch (error) { failures.push(`${tenantId}: ${error?.message ?? error}`) }
  }
  if (failures.length === tenantIds.size && tenantIds.size > 0) throw new Error(`정산 실패 — ${failures.join(' / ')}`)
  return { detail: `고객사 ${tenantIds.size}곳 정산${failures.length ? ` · 실패 ${failures.length}건` : ''}` }
}

/** 저장 용량 일별 스냅샷. 월 청구의 원료다. */
async function snapshotStorage(now) {
  const failures = []
  const tenantIds = scheduleTenantIds()
  for (const tenantId of tenantIds) {
    try {
      const documents = runtimeStore.workspaceStore.tenants?.[tenantId]?.['company-documents']?.data ?? []
      const bytes = documents.reduce((sum, document) => sum + Math.max(0, Number(document?.size || 0)), 0)
      await billingService.recordDailyStorageSnapshot(
        { id: 'system:storage-snapshot', role: 'system', trusted: true, tenantId },
        { tenantId, bytes: Math.trunc(bytes), objectCount: documents.length, measuredAt: now },
      )
    } catch (error) { failures.push(`${tenantId}: ${error?.message ?? error}`) }
  }
  if (failures.length === tenantIds.size && tenantIds.size > 0) throw new Error(`용량 스냅샷 실패 — ${failures.join(' / ')}`)
  return { detail: `고객사 ${tenantIds.size}곳 기록${failures.length ? ` · 실패 ${failures.length}건` : ''}` }
}

/** 월 1회: 전월 청구 스냅샷과 성과 리포트. */
async function closeMonth(now) {
  const month = previousBillingMonth(now)
  const tenantIds = scheduleTenantIds()
  const operator = { id: 'system:billing-month-close', role: 'platform-operator', tenantId: null }
  const failures = []
  for (const tenantId of tenantIds) {
    try { await billingService.createMonthlySnapshot(operator, { tenantId, month }) }
    catch (error) { failures.push(`${tenantId}: ${error?.message ?? error}`) }
  }
  const performanceResults = await runPerformanceMonthlyMaintenance({
    workspaceStore: runtimeStore.workspaceStore,
    accounts: runtimeStore.workspaceStore.accounts ?? [],
    tenantIds,
    commitWorkspaceStore: () => runtimeStore.adapter.commitSnapshot(runtimeStore.workspaceStore),
    client: performanceClient,
    model: performanceModel,
    billingService,
    clock: () => now,
  })
  const performanceFailures = performanceMaintenanceErrors(performanceResults)
  if (failures.length === tenantIds.size && tenantIds.size > 0) throw new Error(`${month} 청구 스냅샷 실패 — ${failures.join(' / ')}`)
  return { detail: `${month} 마감 · 고객사 ${tenantIds.size}곳 · 성과 리포트 ${performanceResults.length}건${failures.length + performanceFailures.length ? ` · 실패 ${failures.length + performanceFailures.length}건` : ''}` }
}

// 청구·성과는 저장소를 아는 이쪽에서 등록한다. 센티널·브리핑·백업은 app.mjs가 이미 등록했다.
app.locals.scheduler.register({
  id: 'usage-reconcile',
  label: '사용량 정산',
  description: '예약 후 확정되지 못한 AI 호출을 정리합니다.',
  spec: { every: 'hour', minute: 10 },
  run: () => reconcileUsage(),
})
app.locals.scheduler.register({
  id: 'storage-snapshot',
  label: '저장 용량 스냅샷',
  description: '고객사별 저장 용량을 일 1회 기록합니다.',
  spec: { every: 'day', hour: 2 },
  run: ({ now }) => snapshotStorage(now),
})
app.locals.scheduler.register({
  id: 'billing-month-close',
  label: '월간 청구·성과 마감',
  description: '전월 청구 스냅샷과 직원 성과 리포트를 만듭니다.',
  spec: { every: 'month', day: 1, hour: 4 },
  run: ({ now }) => closeMonth(now),
})

// 백업 주기를 환경변수로 바꿔 둔 배포는 그 값을 존중한다 (기본은 매일 03:00).
const backupSchedule = backupSettings(process.env)
if (!backupSchedule.enabled) {
  console.log('[scheduler] 백업 미러는 BACKUP_ENABLED=1일 때만 실행됩니다.')
}

app.locals.scheduler.start()
console.log(`[scheduler] ${app.locals.scheduler.listJobs().length}개 정기 작업 등록 — 접속과 무관하게 실행됩니다.`)

const server = app.listen(port, host, () => {
  const mode = process.env.ANTHROPIC_API_KEY?.trim() ? 'Claude' : 'demo'
  console.log(`[server] http://${host}:${port} (${mode} mode, ${runtimeStore.adapter.kind}${runtimeStore.adapter.readOnly ? ' read-only' : ''} store)`)
})

let shuttingDown = false
function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  app.locals.scheduler.stop()
  app.locals.events.stop()
  console.log(`[server] ${signal} received; shutting down`)
  server.close(async () => {
    try {
      await runtimeStore.sessions.flush?.()
      await runtimeStore.adapter.close()
      process.exit(0)
    } catch (error) {
      console.error('[server] 저장소 종료 처리에 실패했습니다.', { message: error?.message })
      process.exit(1)
    }
  })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

import { config } from 'dotenv'
import path from 'node:path'
import Anthropic from '@anthropic-ai/sdk'

import { createApp } from './app.mjs'
import { createPostgresBillingRepository } from './billing-repository.mjs'
import { createBillingService, createMemoryBillingRepository } from './billing-service.mjs'
import { performanceMaintenanceErrors, runPerformanceMonthlyMaintenance } from './performance-maintenance.mjs'
import { initializeRuntimeStore } from './store/index.mjs'

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
const app = createApp({
  initialWorkspaceStore: runtimeStore.workspaceStore,
  sessions: runtimeStore.sessions,
  workspaceStoreFile,
  onWorkspaceStoreChange: (workspaceStore) => runtimeStore.adapter.commitSnapshot(workspaceStore),
  seedPlatformFixtures: runtimeStore.adapter.kind === 'json' && !runtimeStore.adapter.readOnly,
  seedDemoAccounts: runtimeStore.adapter.kind === 'json',
  skipStartupMigrations: runtimeStore.adapter.kind === 'postgres',
  billingService,
})

function previousBillingMonth(now = new Date()) {
  const seoul = new Date(now.getTime() + 9 * 60 * 60 * 1_000)
  const previous = new Date(Date.UTC(seoul.getUTCFullYear(), seoul.getUTCMonth() - 1, 1))
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, '0')}`
}

async function runBillingMaintenance() {
  const now = new Date()
  const tenantIds = new Set([
    ...Object.keys(runtimeStore.workspaceStore.tenants ?? {}),
    ...(runtimeStore.workspaceStore.platform?.tenants ?? []).map((tenant) => tenant.id),
  ])
  const operator = { id: 'system:billing-month-close', role: 'platform-operator', tenantId: null }
  const maintenanceErrors = []
  for (const tenantId of tenantIds) {
    const collector = { id: 'system:billing-reconciliation', role: 'system', trusted: true, tenantId }
    try {
      await billingService.reconcilePendingUsageBatch(collector, { tenantId })
    } catch (error) {
      maintenanceErrors.push(Object.assign(error instanceof Error ? error : new Error(String(error)), { tenantId, operation: 'billing-reconciliation' }))
    }
    try {
      const documents = runtimeStore.workspaceStore.tenants?.[tenantId]?.['company-documents']?.data ?? []
      const bytes = documents.reduce((sum, document) => sum + Math.max(0, Number(document?.size || 0)), 0)
      await billingService.recordDailyStorageSnapshot(
        { id: 'system:storage-snapshot', role: 'system', trusted: true, tenantId },
        { tenantId, bytes: Math.trunc(bytes), objectCount: documents.length, measuredAt: now },
      )
      await billingService.createMonthlySnapshot(operator, { tenantId, month: previousBillingMonth(now) })
    } catch (error) {
      maintenanceErrors.push(Object.assign(error instanceof Error ? error : new Error(String(error)), { tenantId, operation: 'billing-snapshot' }))
    }
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
  maintenanceErrors.push(...performanceMaintenanceErrors(performanceResults))
  if (maintenanceErrors.length) throw new AggregateError(maintenanceErrors, '정기 유지관리 일부 작업이 실패했습니다.')
}

void runBillingMaintenance().catch((error) => console.warn('[billing] maintenance deferred', { message: error?.message }))
const billingMaintenanceTimer = setInterval(() => {
  void runBillingMaintenance().catch((error) => console.warn('[billing] maintenance failed', { message: error?.message }))
}, 60 * 60 * 1_000)
billingMaintenanceTimer.unref?.()

const server = app.listen(port, host, () => {
  const mode = process.env.ANTHROPIC_API_KEY?.trim() ? 'Claude' : 'demo'
  console.log(`[server] http://${host}:${port} (${mode} mode, ${runtimeStore.adapter.kind}${runtimeStore.adapter.readOnly ? ' read-only' : ''} store)`)
})

let shuttingDown = false
function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  clearInterval(billingMaintenanceTimer)
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

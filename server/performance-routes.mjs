import { randomUUID } from 'node:crypto'

import {
  applyAiNarrative,
  buildPerformancePrompt,
  generatePerformanceReports,
  normalizePerformanceSettings,
  previousMonthPeriod,
  resolvePerformancePeriod,
} from './performance-service.mjs'

const SETTINGS_KEY = 'performance-settings'
const REPORTS_KEY = 'performance-reports'

const clone = (value) => value === undefined ? undefined : structuredClone(value)

function tenantRecord(workspaceStore, tenantId, key) {
  return workspaceStore.tenants?.[tenantId]?.[key] ?? null
}

function recordData(workspaceStore, tenantId, key, fallback) {
  return tenantRecord(workspaceStore, tenantId, key)?.data ?? fallback
}

function tenantEmployees(accounts, tenantId) {
  return accounts
    .filter((account) => account?.tenantId === tenantId && account.approved && account.role !== 'platform-operator')
    .map((account) => ({ id: account.id, name: account.name, team: account.team || '미지정', jobRole: account.jobRole || '' }))
}

function samePeriod(snapshot, period) {
  return snapshot?.periodType === period.type && snapshot.periodStart === period.start && snapshot.periodEnd === period.end
}

function periodSnapshots(workspaceStore, tenantId, period) {
  return recordData(workspaceStore, tenantId, REPORTS_KEY, [])
    .filter((snapshot) => samePeriod(snapshot, period))
    .sort((left, right) => Number(right.revision || 0) - Number(left.revision || 0))
}

function responseFor(snapshot, settings, period) {
  return {
    reports: clone(snapshot?.reports ?? []),
    settings: clone(settings),
    period: clone(period),
    generatedAt: snapshot?.generatedAt ?? null,
  }
}

function selfResponseFor(snapshot, period) {
  return {
    reports: clone(snapshot?.reports ?? []),
    period: clone(period),
    generatedAt: snapshot?.generatedAt ?? null,
    visibility: 'public',
  }
}

function textFromClaude(result) {
  return (result?.content ?? []).filter((block) => block?.type === 'text').map((block) => block.text).join('\n').trim()
}

function parseNarrativeLines(text) {
  if (!text) return null
  try {
    const parsed = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? text)
    if (Array.isArray(parsed) && parsed.length === 4) return parsed.map((line) => String(line).trim())
  } catch { /* readable line fallback below */ }
  const lines = text.split(/\r?\n/).map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim()).filter(Boolean)
  return lines.length === 4 ? lines : null
}

async function enrichWithAi(reports, { client, model, workItems, journals, billingService, onAiUsage, tenantId, actorId, feature }) {
  if (!client) return reports
  const byId = new Map(workItems.map((item) => [item.id, item]))
  const output = []
  for (const report of reports) {
    if (report.score === null || report.narrative.evidence.length === 0) {
      output.push(report)
      continue
    }
    const evidence = report.narrative.evidence.map((link) => {
      const item = byId.get(link.id)
      return item ? { id: item.id, title: item.title, description: item.description, completion: item.completion?.summary } : link
    })
    const employeeJournals = journals
      .filter((journal) => {
        const submittedAt = new Date(journal.submittedAt || journal.updatedAt || journal.date).getTime()
        return journal.authorId === report.employeeId
          && journal.status !== '임시저장'
          && Number.isFinite(submittedAt)
          && submittedAt >= new Date(report.periodStart).getTime()
          && submittedAt < new Date(report.periodEnd).getTime()
      })
      .slice(-12)
      .map((journal) => ({ title: journal.title, completed: journal.completed, issue: journal.issue }))
    let reservation = null
    let providerSucceeded = false
    const usageActor = { id: 'server:performance', role: 'system', trusted: true, tenantId }
    const startedAt = new Date()
    try {
      const prompt = buildPerformancePrompt(report, [...evidence, ...employeeJournals])
      if (billingService) {
        const messages = [{ role: 'user', content: prompt }]
        const count = typeof client.messages.countTokens === 'function'
          ? await client.messages.countTokens({ model, messages })
          : { input_tokens: Math.ceil(JSON.stringify(messages).length / 4) }
        reservation = (await billingService.reserveUsage(usageActor, {
          id: `performance-res:${tenantId}:${report.employeeId}:${randomUUID()}`,
          tenantId,
          userId: actorId,
          feature,
          model,
          estimatedInputTokens: Number(count.input_tokens || 0),
          estimatedOutputTokens: 700,
          occurredAt: startedAt.toISOString(),
        })).reservation
      }
      const result = await client.messages.create({
        model,
        max_tokens: 700,
        messages: [{ role: 'user', content: prompt }],
      })
      providerSucceeded = true
      if (billingService && reservation) {
        const usageEvent = {
          id: `anthropic:${result.id || randomUUID()}`,
          reservationId: reservation.id,
          tenantId,
          userId: actorId,
          feature,
          model: reservation.model,
          inputTokens: Number(result.usage?.input_tokens || 0),
          outputTokens: Number(result.usage?.output_tokens || 0),
          occurredAt: startedAt.toISOString(),
          durationMs: Date.now() - startedAt.getTime(),
          metadata: { providerResponseModel: result.model || model },
        }
        try {
          await billingService.recordUsageEvent(usageActor, usageEvent)
        } catch (ledgerError) {
          try {
            await billingService.recordReconciliationPending(usageActor, {
              ...usageEvent,
              usageEventId: usageEvent.id,
              id: `reconciliation:${usageEvent.id}`,
              lastError: ledgerError instanceof Error ? ledgerError.message : String(ledgerError),
            })
          } catch (reconciliationError) {
            console.error('Performance AI usage reconciliation persistence failed after provider success', reconciliationError)
          }
        }
      }
      const lines = parseNarrativeLines(textFromClaude(result))
      output.push(applyAiNarrative(report, lines))
      try {
        await onAiUsage?.({
          tenantId,
          userId: actorId,
          feature,
          model: result.model || model,
          inputTokens: Number(result.usage?.input_tokens || 0),
          outputTokens: Number(result.usage?.output_tokens || 0),
          occurredAt: new Date().toISOString(),
        })
      } catch { /* usage accounting must not duplicate or corrupt a completed report */ }
    } catch {
      if (!providerSucceeded && billingService && reservation) {
        try { await billingService.releaseUsageReservation(usageActor, { tenantId, reservationId: reservation.id }) }
        catch { /* pending reservations expire automatically */ }
      }
      if (!providerSucceeded) output.push(report)
      else if (!output.some((item) => item.employeeId === report.employeeId)) output.push(report)
    }
  }
  return output
}

function snapshotId(tenantId, period, revision) {
  return `PERFS-${tenantId}-${period.type}-${period.start.slice(0, 10)}-R${revision}`
}

async function persistSnapshot({
  workspaceStore, tenantId, actorId, period, reports, commitWorkspaceStore, immutable, reason,
}) {
  const tenantStore = workspaceStore.tenants[tenantId] ??= {}
  const previousRecord = clone(tenantStore[REPORTS_KEY] ?? null)
  const snapshots = Array.isArray(previousRecord?.data) ? clone(previousRecord.data) : []
  const revision = Math.max(0, ...snapshots.filter((snapshot) => samePeriod(snapshot, period)).map((snapshot) => Number(snapshot.revision || 0))) + 1
  const generatedAt = new Date().toISOString()
  const snapshot = {
    id: snapshotId(tenantId, period, revision),
    periodType: period.type,
    periodStart: period.start,
    periodEnd: period.end,
    periodLabel: period.label,
    revision,
    immutable: Boolean(immutable),
    reason,
    generatedAt,
    generatedBy: actorId,
    reports: reports.map((report) => ({ ...report, generatedAt, snapshot: Boolean(immutable) })),
  }
  tenantStore[REPORTS_KEY] = { data: [...snapshots, snapshot], updatedAt: generatedAt, updatedBy: actorId }
  try {
    await commitWorkspaceStore()
  } catch (error) {
    if (previousRecord) tenantStore[REPORTS_KEY] = previousRecord
    else delete tenantStore[REPORTS_KEY]
    throw error
  }
  return snapshot
}

async function buildReports({ workspaceStore, accounts, tenantId, period, settings, now, client, model, billingService, onAiUsage, actorId, feature }) {
  const workItems = recordData(workspaceStore, tenantId, 'work-items', [])
  const journals = recordData(workspaceStore, tenantId, 'daily-journals', [])
  const reports = generatePerformanceReports({
    employees: tenantEmployees(accounts, tenantId), workItems, journals, period, settings, now,
  })
  return enrichWithAi(reports, { client, model, workItems, journals, billingService, onAiUsage, tenantId, actorId, feature })
}

export async function materializePreviousMonthPerformance({
  workspaceStore,
  accounts,
  tenantId,
  commitWorkspaceStore,
  client = null,
  model = 'claude-sonnet-5',
  billingService = null,
  onAiUsage = null,
  clock = () => new Date(),
}) {
  const period = previousMonthPeriod(clock())
  const existing = periodSnapshots(workspaceStore, tenantId, period).find((snapshot) => snapshot.immutable)
  if (existing) return { snapshot: existing, created: false }
  if (tenantEmployees(accounts, tenantId).length === 0) return { snapshot: null, created: false, skipped: 'no-employees' }
  const settings = normalizePerformanceSettings(recordData(workspaceStore, tenantId, SETTINGS_KEY, {}))
  const reports = await buildReports({
    workspaceStore, accounts, tenantId, period, settings, now: clock(), client, model,
    billingService, onAiUsage, actorId: 'system-performance-snapshot', feature: 'performance-monthly-summary',
  })
  const snapshot = await persistSnapshot({
    workspaceStore, tenantId, actorId: 'system-performance-snapshot', period, reports,
    commitWorkspaceStore, immutable: true, reason: 'monthly-auto',
  })
  return { snapshot, created: true }
}

export function registerPerformanceRoutes({
  app,
  requireAuth,
  requireTenantAdmin,
  requireMatchingWorkspaceIdentity,
  workspaceStore,
  accounts,
  commitWorkspaceStore,
  client = null,
  model = 'claude-sonnet-5',
  billingService = null,
  onAiUsage = null,
  clock = () => new Date(),
}) {
  const adminGuards = [requireAuth, requireTenantAdmin, requireMatchingWorkspaceIdentity]

  app.get('/api/performance/reports', ...adminGuards, async (request, response) => {
    try {
      await materializePreviousMonthPerformance({
        workspaceStore, accounts, tenantId: request.auth.tenantId, commitWorkspaceStore, client, model,
        billingService, onAiUsage, clock,
      })
      const period = resolvePerformancePeriod({ periodType: request.query.periodType, anchor: request.query.anchor })
      const settings = normalizePerformanceSettings(recordData(workspaceStore, request.auth.tenantId, SETTINGS_KEY, {}))
      let snapshot = periodSnapshots(workspaceStore, request.auth.tenantId, period)[0] ?? null
      if (!snapshot) {
        const reports = generatePerformanceReports({
          employees: tenantEmployees(accounts, request.auth.tenantId),
          workItems: recordData(workspaceStore, request.auth.tenantId, 'work-items', []),
          journals: recordData(workspaceStore, request.auth.tenantId, 'daily-journals', []),
          period,
          settings,
          now: clock(),
        })
        snapshot = { reports, generatedAt: clock().toISOString() }
      }
      response.json(responseFor(snapshot, settings, period))
    } catch (error) {
      response.status(error instanceof TypeError ? 400 : 500).json({ error: { code: 'PERFORMANCE_READ_FAILED', message: error instanceof TypeError ? error.message : '성과 리포트를 불러오지 못했습니다.' } })
    }
  })

  app.post('/api/performance/reports/generate', ...adminGuards, async (request, response) => {
    try {
      const period = resolvePerformancePeriod(request.body)
      const settings = normalizePerformanceSettings(recordData(workspaceStore, request.auth.tenantId, SETTINGS_KEY, {}))
      const reports = await buildReports({
        workspaceStore, accounts, tenantId: request.auth.tenantId, period, settings, now: clock(), client, model,
        billingService, onAiUsage, actorId: request.auth.id, feature: 'performance-manual-summary',
      })
      const immutable = period.type === 'month' && new Date(period.end) <= clock()
      const snapshot = await persistSnapshot({
        workspaceStore, tenantId: request.auth.tenantId, actorId: request.auth.id, period, reports,
        commitWorkspaceStore, immutable, reason: 'manual-regeneration',
      })
      response.status(201).json(responseFor(snapshot, settings, period))
    } catch (error) {
      response.status(error instanceof TypeError ? 400 : 500).json({ error: { code: 'PERFORMANCE_GENERATE_FAILED', message: error instanceof TypeError ? error.message : '성과 리포트를 생성하지 못했습니다.' } })
    }
  })

  app.patch('/api/performance/settings', ...adminGuards, async (request, response) => {
    try {
      const settings = normalizePerformanceSettings(request.body)
      const tenantStore = workspaceStore.tenants[request.auth.tenantId] ??= {}
      const previousRecord = clone(tenantStore[SETTINGS_KEY] ?? null)
      tenantStore[SETTINGS_KEY] = { data: settings, updatedAt: clock().toISOString(), updatedBy: request.auth.id }
      try { await commitWorkspaceStore() } catch (error) {
        if (previousRecord) tenantStore[SETTINGS_KEY] = previousRecord
        else delete tenantStore[SETTINGS_KEY]
        throw error
      }
      response.json({ settings })
    } catch (error) {
      response.status(error instanceof TypeError ? 400 : 500).json({ error: { code: 'PERFORMANCE_SETTINGS_FAILED', message: error instanceof TypeError ? error.message : '성과 설정을 저장하지 못했습니다.' } })
    }
  })

  app.get('/api/performance/me', requireAuth, requireMatchingWorkspaceIdentity, async (request, response) => {
    if (!request.auth.tenantId) {
      response.status(403).json({ error: { code: 'TENANT_REQUIRED', message: '고객사 계정에서만 조회할 수 있습니다.' } })
      return
    }
    try {
      const settings = normalizePerformanceSettings(recordData(workspaceStore, request.auth.tenantId, SETTINGS_KEY, {}))
      if (request.auth.role === 'tenant-member' && !settings.employeeVisible) {
        response.status(403).json({ error: { code: 'PERFORMANCE_PRIVATE', message: '관리자가 직원 공개를 활성화하지 않았습니다.' } })
        return
      }
      const period = resolvePerformancePeriod({ periodType: request.query.periodType, anchor: request.query.anchor })
      const snapshot = periodSnapshots(workspaceStore, request.auth.tenantId, period)[0]
      const reports = snapshot?.reports ?? generatePerformanceReports({
        employees: tenantEmployees(accounts, request.auth.tenantId).filter((employee) => employee.id === request.auth.id),
        workItems: recordData(workspaceStore, request.auth.tenantId, 'work-items', []),
        journals: recordData(workspaceStore, request.auth.tenantId, 'daily-journals', []),
        period, settings, now: clock(),
      })
      response.json(selfResponseFor({ reports: reports.filter((report) => report.employeeId === request.auth.id), generatedAt: snapshot?.generatedAt ?? clock().toISOString() }, period))
    } catch (error) {
      response.status(error instanceof TypeError ? 400 : 500).json({ error: { code: 'PERFORMANCE_SELF_READ_FAILED', message: error instanceof TypeError ? error.message : '개인 성과 리포트를 불러오지 못했습니다.' } })
    }
  })
}

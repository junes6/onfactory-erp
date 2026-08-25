import { randomUUID } from 'node:crypto'

export const BILLING_LIMIT_ACTIONS = Object.freeze(['warn', 'block'])
export const BILLING_UNCONFIRMED_AMOUNT = 0
export const BILLING_DEFAULT_WARNING_THRESHOLD_PERCENT = 80
export const BILLING_REPOSITORY_METHODS = Object.freeze([
  'transaction',
  'getModelRate', 'listModelRates', 'upsertModelRate',
  'getPlan', 'listPlans', 'upsertPlan',
  'getAssignment', 'listAssignments', 'upsertAssignment',
  'getUsageReservation', 'insertUsageReservation', 'updateUsageReservation', 'listActiveUsageReservations',
  'getUsageEvent', 'insertUsageEvent', 'listUsageEvents',
  'getReconciliation', 'insertReconciliation', 'updateReconciliation', 'listPendingReconciliations',
  'getStorageSnapshot', 'insertStorageSnapshot', 'listStorageSnapshots',
  'getMonthlySnapshot', 'insertMonthlySnapshot', 'listMonthlySnapshots',
  'listKnownTenantIds',
])

const TOKENS_PER_MILLION = 1_000_000
const BYTES_PER_GB = 1_000_000_000
const DASHBOARD_MONTH_COUNT = 6
const USAGE_RESERVATION_TTL_MS = 15 * 60 * 1_000
const LIMIT_ACTION_SET = new Set(BILLING_LIMIT_ACTIONS)
const PLATFORM_ONLY_OPERATIONS = new Set([
  'dashboard:read',
  'configuration:read',
  'model-rate:write',
  'plan:write',
  'assignment:write',
  'monthly-snapshot:write',
])
const INTERNAL_OPERATIONS = new Set(['usage:write', 'storage-snapshot:write'])

export class BillingServiceError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message)
    this.name = 'BillingServiceError'
    this.code = code
    this.status = status
    this.details = details
  }
}

const clone = (value) => value === undefined ? undefined : structuredClone(value)
const roundMetric = (value) => Math.round((Number(value) + Number.EPSILON) * 1_000_000) / 1_000_000

function requiredText(value, field, maximum = 160) {
  const normalized = String(value ?? '').trim()
  if (!normalized || normalized.length > maximum) {
    throw new BillingServiceError('BILLING_INVALID_INPUT', `${field} 값이 올바르지 않습니다.`, 400, { field })
  }
  return normalized
}

function optionalText(value, maximum = 160) {
  const normalized = String(value ?? '').trim()
  if (normalized.length > maximum) throw new BillingServiceError('BILLING_INVALID_INPUT', '문자열 길이가 허용 범위를 초과했습니다.')
  return normalized
}

function nonNegativeNumber(value, field, fallback = BILLING_UNCONFIRMED_AMOUNT) {
  const candidate = value === undefined || value === null || value === '' ? fallback : Number(value)
  if (!Number.isFinite(candidate) || candidate < 0) {
    throw new BillingServiceError('BILLING_INVALID_INPUT', `${field} 값은 0 이상의 숫자여야 합니다.`, 400, { field })
  }
  return roundMetric(candidate)
}

function nonNegativeInteger(value, field) {
  const candidate = Number(value)
  if (!Number.isSafeInteger(candidate) || candidate < 0) {
    throw new BillingServiceError('BILLING_INVALID_INPUT', `${field} 값은 0 이상의 안전한 정수여야 합니다.`, 400, { field })
  }
  return candidate
}

function normalizedIso(value, field = 'occurredAt') {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new BillingServiceError('BILLING_INVALID_INPUT', `${field} 시간이 올바르지 않습니다.`, 400, { field })
  return date.toISOString()
}

function koreaDateParts(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(value))
  const read = (type) => parts.find((part) => part.type === type)?.value
  return { year: read('year'), month: read('month'), day: read('day') }
}

export function billingMonth(value = new Date()) {
  const { year, month } = koreaDateParts(value)
  return `${year}-${month}`
}

export function billingDate(value = new Date()) {
  const { year, month, day } = koreaDateParts(value)
  return `${year}-${month}-${day}`
}

function assertMonth(value) {
  const month = requiredText(value, 'month', 7)
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new BillingServiceError('BILLING_INVALID_MONTH', '청구 월은 YYYY-MM 형식이어야 합니다.')
  return month
}

function shiftMonth(month, delta) {
  const [year, numericMonth] = assertMonth(month).split('-').map(Number)
  const shifted = new Date(Date.UTC(year, numericMonth - 1 + delta, 1))
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`
}

function monthRange(month) {
  const normalized = assertMonth(month)
  return {
    startAt: new Date(`${normalized}-01T00:00:00+09:00`).toISOString(),
    endAt: new Date(`${shiftMonth(normalized, 1)}-01T00:00:00+09:00`).toISOString(),
  }
}

function assertActor(actor) {
  if (!actor || typeof actor !== 'object' || !actor.role || !actor.id) {
    throw new BillingServiceError('BILLING_UNAUTHENTICATED', '인증된 사용자가 필요합니다.', 401)
  }
  return actor
}

export function authorizeBillingOperation(actorInput, operation, tenantId = undefined) {
  const actor = assertActor(actorInput)
  if (PLATFORM_ONLY_OPERATIONS.has(operation)) {
    if (actor.role !== 'platform-operator' || actor.tenantId) {
      throw new BillingServiceError('BILLING_FORBIDDEN', '플랫폼 운영자 권한이 필요합니다.', 403)
    }
    return actor
  }
  if (INTERNAL_OPERATIONS.has(operation)) {
    if (actor.role === 'platform-operator' && !actor.tenantId) return actor
    if (actor.role !== 'system' || actor.trusted !== true || (actor.tenantId && actor.tenantId !== tenantId)) {
      throw new BillingServiceError('BILLING_FORBIDDEN', '서버 내부 수집 권한이 필요합니다.', 403)
    }
    return actor
  }
  throw new BillingServiceError('BILLING_UNKNOWN_OPERATION', '지원하지 않는 비용 관리 작업입니다.', 400)
}

function normalizeRate(input, existing, actor, now, defaultCurrency) {
  const model = requiredText(input?.model ?? existing?.model, 'model', 120)
  return {
    model,
    displayName: optionalText(input?.displayName ?? existing?.displayName ?? model, 120) || model,
    currency: requiredText(input?.currency ?? existing?.currency ?? defaultCurrency, 'currency', 12).toUpperCase(),
    inputCostPerMillion: nonNegativeNumber(input?.inputCostPerMillion, 'inputCostPerMillion', existing?.inputCostPerMillion),
    outputCostPerMillion: nonNegativeNumber(input?.outputCostPerMillion, 'outputCostPerMillion', existing?.outputCostPerMillion),
    inputPointsPerMillion: nonNegativeNumber(input?.inputPointsPerMillion, 'inputPointsPerMillion', existing?.inputPointsPerMillion),
    outputPointsPerMillion: nonNegativeNumber(input?.outputPointsPerMillion, 'outputPointsPerMillion', existing?.outputPointsPerMillion),
    confirmed: input?.confirmed === undefined ? Boolean(existing?.confirmed) : input.confirmed === true,
    updatedAt: normalizedIso(now(), 'updatedAt'),
    updatedBy: actor.id,
  }
}

function normalizePlan(input, existing, actor, now, defaultCurrency) {
  const id = requiredText(input?.id ?? existing?.id, 'id', 100)
  const threshold = nonNegativeNumber(input?.warningThresholdPercent, 'warningThresholdPercent', existing?.warningThresholdPercent ?? BILLING_DEFAULT_WARNING_THRESHOLD_PERCENT)
  if (threshold > 100) throw new BillingServiceError('BILLING_INVALID_INPUT', 'warningThresholdPercent는 100 이하여야 합니다.')
  return {
    id,
    name: requiredText(input?.name ?? existing?.name, 'name', 120),
    currency: requiredText(input?.currency ?? existing?.currency ?? defaultCurrency, 'currency', 12).toUpperCase(),
    monthlyPrice: nonNegativeNumber(input?.monthlyPrice, 'monthlyPrice', existing?.monthlyPrice),
    includedPoints: nonNegativeNumber(input?.includedPoints, 'includedPoints', existing?.includedPoints),
    includedStorageBytes: nonNegativeInteger(input?.includedStorageBytes ?? existing?.includedStorageBytes ?? BILLING_UNCONFIRMED_AMOUNT, 'includedStorageBytes'),
    storageOveragePerGb: nonNegativeNumber(input?.storageOveragePerGb, 'storageOveragePerGb', existing?.storageOveragePerGb),
    pointOveragePrice: nonNegativeNumber(input?.pointOveragePrice, 'pointOveragePrice', existing?.pointOveragePrice ?? BILLING_UNCONFIRMED_AMOUNT),
    warningThresholdPercent: threshold,
    confirmed: input?.confirmed === undefined ? Boolean(existing?.confirmed) : input.confirmed === true,
    active: input?.active === undefined ? existing?.active !== false : input.active === true,
    updatedAt: normalizedIso(now(), 'updatedAt'),
    updatedBy: actor.id,
    createdAt: existing?.createdAt ?? normalizedIso(now(), 'createdAt'),
  }
}

function normalizeAssignment(input, plan, actor, now) {
  const tenantId = requiredText(input?.tenantId, 'tenantId', 120)
  const limitAction = input?.limitAction ?? 'warn'
  if (!LIMIT_ACTION_SET.has(limitAction)) throw new BillingServiceError('BILLING_INVALID_INPUT', 'limitAction은 warn 또는 block이어야 합니다.')
  const override = input?.pointLimitOverride
  return {
    tenantId,
    planId: plan.id,
    pointLimitOverride: override === undefined || override === null || override === '' ? null : nonNegativeNumber(override, 'pointLimitOverride'),
    limitAction,
    assignedAt: normalizedIso(now(), 'assignedAt'),
    assignedBy: actor.id,
  }
}

function emptyRate(model, defaultCurrency) {
  return {
    model,
    displayName: model,
    currency: defaultCurrency,
    inputCostPerMillion: BILLING_UNCONFIRMED_AMOUNT,
    outputCostPerMillion: BILLING_UNCONFIRMED_AMOUNT,
    inputPointsPerMillion: BILLING_UNCONFIRMED_AMOUNT,
    outputPointsPerMillion: BILLING_UNCONFIRMED_AMOUNT,
    confirmed: false,
  }
}

function chargeForUsage(rate, inputTokens, outputTokens) {
  const inputCost = roundMetric(inputTokens * rate.inputCostPerMillion / TOKENS_PER_MILLION)
  const outputCost = roundMetric(outputTokens * rate.outputCostPerMillion / TOKENS_PER_MILLION)
  const inputPoints = roundMetric(inputTokens * rate.inputPointsPerMillion / TOKENS_PER_MILLION)
  const outputPoints = roundMetric(outputTokens * rate.outputPointsPerMillion / TOKENS_PER_MILLION)
  return {
    inputCost,
    outputCost,
    totalCost: roundMetric(inputCost + outputCost),
    inputPoints,
    outputPoints,
    totalPoints: roundMetric(inputPoints + outputPoints),
  }
}

function pointLimit(assignment, plan) {
  if (!assignment || !plan || !plan.confirmed) return null
  return assignment.pointLimitOverride ?? plan.includedPoints
}

function usageIdentity(event) {
  return JSON.stringify([
    event.tenantId, event.userId, event.feature, event.model,
    event.inputTokens, event.outputTokens, event.occurredAt,
  ])
}

function reservationIdentity(reservation) {
  return JSON.stringify([
    reservation.tenantId, reservation.userId, reservation.feature, reservation.model,
    reservation.estimatedInputTokens, reservation.estimatedOutputTokens,
  ])
}

function reconciliationIdentity(item) {
  return JSON.stringify([
    item.tenantId, item.usageEventId, item.reservationId, item.userId, item.feature,
    item.model, item.inputTokens, item.outputTokens, item.occurredAt,
  ])
}

function sum(values) {
  return roundMetric(values.reduce((total, value) => total + Number(value || 0), 0))
}

function groupRows(events, keyFor, labelFor = keyFor) {
  const rows = new Map()
  for (const event of events) {
    const key = String(keyFor(event))
    const row = rows.get(key) ?? {
      key, label: String(labelFor(event)), eventCount: 0, inputTokens: 0, outputTokens: 0, pointsUsed: 0, aiCost: 0,
    }
    row.eventCount += 1
    row.inputTokens += event.inputTokens
    row.outputTokens += event.outputTokens
    row.pointsUsed = roundMetric(row.pointsUsed + event.totalPoints)
    row.aiCost = roundMetric(row.aiCost + event.totalCost)
    rows.set(key, row)
  }
  return [...rows.values()].sort((left, right) => right.aiCost - left.aiCost || right.pointsUsed - left.pointsUsed || left.label.localeCompare(right.label))
}

async function calculateLiveTenantMonth(repository, tenantId, month) {
  const { startAt, endAt } = monthRange(month)
  const [events, storageSnapshots, assignment] = await Promise.all([
    repository.listUsageEvents({ tenantId, startAt, endAt }),
    repository.listStorageSnapshots({ tenantId, startDate: `${month}-01`, endDate: `${shiftMonth(month, 1)}-01` }),
    repository.getAssignment(tenantId),
  ])
  const plan = assignment ? await repository.getPlan(assignment.planId) : null
  const latestStorage = [...storageSnapshots].sort((left, right) => right.snapshotDate.localeCompare(left.snapshotDate))[0] ?? null
  const storageBytes = latestStorage?.bytes ?? 0
  const storageOverageBytes = plan ? Math.max(0, storageBytes - plan.includedStorageBytes) : 0
  const storageOverageRevenue = plan ? roundMetric(storageOverageBytes / BYTES_PER_GB * plan.storageOveragePerGb) : 0
  const apiCost = sum(events.map((event) => event.totalCost))
  const pointsUsed = sum(events.map((event) => event.totalPoints))
  const baseRevenue = plan?.monthlyPrice ?? 0
  const limit = pointLimit(assignment, plan)
  const pointOveragePoints = plan && limit !== null ? Math.max(0, roundMetric(pointsUsed - limit)) : 0
  const pointOverageRevenue = plan ? roundMetric(pointOveragePoints * plan.pointOveragePrice) : 0
  const revenue = roundMetric(baseRevenue + pointOverageRevenue + storageOverageRevenue)
  const margin = roundMetric(revenue - apiCost)
  const utilizationPercent = limit === null ? null : limit === 0 ? (pointsUsed > 0 ? 100 : 0) : roundMetric(pointsUsed / limit * 100)
  const summary = {
    tenantId,
    month,
    currency: plan?.currency ?? events[0]?.rateSnapshot?.currency ?? null,
    eventCount: events.length,
    inputTokens: sum(events.map((event) => event.inputTokens)),
    outputTokens: sum(events.map((event) => event.outputTokens)),
    pointsUsed,
    pointLimit: limit,
    utilizationPercent,
    revenue,
    invoiceTotal: revenue,
    apiCost,
    margin,
    baseRevenue,
    pointOveragePoints,
    pointOverageRevenue,
    storageOverageRevenue,
    // Compatibility aliases for existing consumers. totalCost is the customer invoice,
    // while aiCost remains the provider API cost and is never part of revenue.
    aiCost: apiCost,
    planCost: baseRevenue,
    storageCost: storageOverageRevenue,
    totalCost: revenue,
    storageBytes,
    storageObjectCount: latestStorage?.objectCount ?? 0,
    limitAction: assignment?.limitAction ?? 'warn',
    planId: plan?.id ?? null,
    planName: plan?.name ?? null,
    configurationStatus: !assignment || !plan ? 'unconfigured' : !plan.confirmed || events.some((event) => !event.rateConfirmed) ? 'unconfirmed' : 'confirmed',
  }
  return {
    summary,
    details: {
      models: groupRows(events, (event) => event.model),
      features: groupRows(events, (event) => event.feature),
      users: groupRows(events, (event) => event.userId),
      dailyStorage: storageSnapshots.sort((left, right) => left.snapshotDate.localeCompare(right.snapshotDate)),
    },
    plan,
    assignment,
  }
}

function normalizeFinancialSummary(summary) {
  const baseRevenue = Number(summary?.baseRevenue ?? summary?.planCost ?? 0)
  const pointOverageRevenue = Number(summary?.pointOverageRevenue ?? 0)
  const storageOverageRevenue = Number(summary?.storageOverageRevenue ?? summary?.storageCost ?? 0)
  const revenue = Number(summary?.revenue ?? summary?.invoiceTotal ?? roundMetric(baseRevenue + pointOverageRevenue + storageOverageRevenue))
  const apiCost = Number(summary?.apiCost ?? summary?.aiCost ?? 0)
  const margin = Number(summary?.margin ?? roundMetric(revenue - apiCost))
  return {
    ...summary,
    revenue,
    invoiceTotal: Number(summary?.invoiceTotal ?? revenue),
    apiCost,
    margin,
    baseRevenue,
    pointOveragePoints: Number(summary?.pointOveragePoints ?? 0),
    pointOverageRevenue,
    storageOverageRevenue,
    aiCost: apiCost,
    planCost: baseRevenue,
    storageCost: storageOverageRevenue,
    totalCost: Number(summary?.invoiceTotal ?? revenue),
  }
}

async function tenantMonth(repository, tenantId, month, preferSnapshot) {
  if (preferSnapshot) {
    const snapshot = await repository.getMonthlySnapshot(tenantId, month)
    if (snapshot) return { summary: normalizeFinancialSummary(snapshot.summary), details: clone(snapshot.details), snapshot: clone(snapshot) }
  }
  return calculateLiveTenantMonth(repository, tenantId, month)
}

function aggregateSummaries(summaries, month) {
  const configuredLimits = summaries.map((item) => item.pointLimit).filter((value) => value !== null)
  const pointsUsed = sum(summaries.map((item) => item.pointsUsed))
  const pointLimitTotal = configuredLimits.length ? sum(configuredLimits) : null
  return {
    month,
    tenantCount: summaries.length,
    currency: summaries.map((item) => item.currency).filter(Boolean).find((value, _index, values) => values.every((candidate) => candidate === value)) ?? null,
    eventCount: summaries.reduce((total, item) => total + item.eventCount, 0),
    inputTokens: sum(summaries.map((item) => item.inputTokens)),
    outputTokens: sum(summaries.map((item) => item.outputTokens)),
    pointsUsed,
    pointLimit: pointLimitTotal,
    utilizationPercent: pointLimitTotal === null ? null : pointLimitTotal === 0 ? (pointsUsed > 0 ? 100 : 0) : roundMetric(pointsUsed / pointLimitTotal * 100),
    revenue: sum(summaries.map((item) => item.revenue ?? item.totalCost)),
    invoiceTotal: sum(summaries.map((item) => item.invoiceTotal ?? item.totalCost)),
    apiCost: sum(summaries.map((item) => item.apiCost ?? item.aiCost)),
    margin: sum(summaries.map((item) => item.margin ?? ((item.totalCost || 0) - (item.aiCost || 0)))),
    baseRevenue: sum(summaries.map((item) => item.baseRevenue ?? item.planCost)),
    pointOveragePoints: sum(summaries.map((item) => item.pointOveragePoints)),
    pointOverageRevenue: sum(summaries.map((item) => item.pointOverageRevenue)),
    storageOverageRevenue: sum(summaries.map((item) => item.storageOverageRevenue ?? item.storageCost)),
    aiCost: sum(summaries.map((item) => item.apiCost ?? item.aiCost)),
    planCost: sum(summaries.map((item) => item.baseRevenue ?? item.planCost)),
    storageCost: sum(summaries.map((item) => item.storageOverageRevenue ?? item.storageCost)),
    totalCost: sum(summaries.map((item) => item.invoiceTotal ?? item.totalCost)),
    storageBytes: summaries.reduce((total, item) => total + item.storageBytes, 0),
    storageObjectCount: summaries.reduce((total, item) => total + item.storageObjectCount, 0),
    configurationStatus: summaries.every((item) => item.configurationStatus === 'confirmed') ? 'confirmed'
      : summaries.some((item) => item.configurationStatus === 'unconfigured') ? 'unconfigured' : 'unconfirmed',
  }
}

function createMemoryAccessors(state) {
  const by = (collection, predicate) => state[collection].find(predicate)
  return {
    async getModelRate(model) { return clone(by('modelRates', (item) => item.model === model) ?? null) },
    async listModelRates() { return clone(state.modelRates) },
    async upsertModelRate(rate) {
      const index = state.modelRates.findIndex((item) => item.model === rate.model)
      if (index < 0) state.modelRates.push(clone(rate)); else state.modelRates[index] = clone(rate)
      return clone(rate)
    },
    async getPlan(id) { return clone(by('plans', (item) => item.id === id) ?? null) },
    async listPlans() { return clone(state.plans) },
    async upsertPlan(plan) {
      const index = state.plans.findIndex((item) => item.id === plan.id)
      if (index < 0) state.plans.push(clone(plan)); else state.plans[index] = clone(plan)
      return clone(plan)
    },
    async getAssignment(tenantId) { return clone(by('assignments', (item) => item.tenantId === tenantId) ?? null) },
    async listAssignments() { return clone(state.assignments) },
    async upsertAssignment(assignment) {
      const index = state.assignments.findIndex((item) => item.tenantId === assignment.tenantId)
      if (index < 0) state.assignments.push(clone(assignment)); else state.assignments[index] = clone(assignment)
      return clone(assignment)
    },
    async getUsageReservation(id) { return clone(by('usageReservations', (item) => item.id === id) ?? null) },
    async insertUsageReservation(reservation) {
      if (state.usageReservations.some((item) => item.id === reservation.id)) throw new BillingServiceError('BILLING_RESERVATION_CONFLICT', '동일한 사용 예약 ID가 이미 존재합니다.', 409)
      state.usageReservations.push(clone(reservation)); return clone(reservation)
    },
    async updateUsageReservation(reservation) {
      const index = state.usageReservations.findIndex((item) => item.id === reservation.id)
      if (index < 0) throw new BillingServiceError('BILLING_RESERVATION_NOT_FOUND', '사용 예약을 찾을 수 없습니다.', 404)
      state.usageReservations[index] = clone(reservation); return clone(reservation)
    },
    async listActiveUsageReservations({ tenantId, startAt, endAt, now } = {}) {
      const reference = now ?? new Date().toISOString()
      return clone(state.usageReservations.filter((item) => item.status === 'pending' && (item.reconciliationPending || item.expiresAt > reference)
        && (!tenantId || item.tenantId === tenantId) && (!startAt || item.occurredAt >= startAt) && (!endAt || item.occurredAt < endAt)))
    },
    async getUsageEvent(id) { return clone(by('usageEvents', (item) => item.id === id) ?? null) },
    async insertUsageEvent(event) {
      if (state.usageEvents.some((item) => item.id === event.id)) throw new BillingServiceError('BILLING_EVENT_CONFLICT', '동일한 사용 이벤트 ID가 이미 존재합니다.', 409)
      state.usageEvents.push(clone(event)); return clone(event)
    },
    async listUsageEvents({ tenantId, tenantIds, startAt, endAt } = {}) {
      const scope = tenantIds ? new Set(tenantIds) : null
      return clone(state.usageEvents.filter((item) => (!tenantId || item.tenantId === tenantId)
        && (!scope || scope.has(item.tenantId)) && (!startAt || item.occurredAt >= startAt) && (!endAt || item.occurredAt < endAt)))
    },
    async getReconciliation(id) { return clone(by('reconciliations', (item) => item.id === id) ?? null) },
    async insertReconciliation(item) {
      if (state.reconciliations.some((candidate) => candidate.id === item.id)) {
        throw new BillingServiceError('BILLING_RECONCILIATION_CONFLICT', '동일한 조정 대기 ID가 이미 존재합니다.', 409)
      }
      state.reconciliations.push(clone(item)); return clone(item)
    },
    async updateReconciliation(item) {
      const index = state.reconciliations.findIndex((candidate) => candidate.id === item.id)
      if (index < 0) throw new BillingServiceError('BILLING_RECONCILIATION_NOT_FOUND', '조정 대기 내역을 찾을 수 없습니다.', 404)
      state.reconciliations[index] = clone(item); return clone(item)
    },
    async listPendingReconciliations({ tenantId, limit = 100, now } = {}) {
      const reference = now ?? new Date().toISOString()
      return clone(state.reconciliations.filter((item) => item.status === 'pending'
        && (!tenantId || item.tenantId === tenantId) && (!item.nextAttemptAt || item.nextAttemptAt <= reference))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)).slice(0, limit))
    },
    async getStorageSnapshot(tenantId, snapshotDate) { return clone(by('storageSnapshots', (item) => item.tenantId === tenantId && item.snapshotDate === snapshotDate) ?? null) },
    async insertStorageSnapshot(snapshot) {
      if (state.storageSnapshots.some((item) => item.tenantId === snapshot.tenantId && item.snapshotDate === snapshot.snapshotDate)) {
        throw new BillingServiceError('BILLING_STORAGE_SNAPSHOT_CONFLICT', '해당 날짜의 저장공간 스냅샷이 이미 존재합니다.', 409)
      }
      state.storageSnapshots.push(clone(snapshot)); return clone(snapshot)
    },
    async listStorageSnapshots({ tenantId, startDate, endDate } = {}) {
      return clone(state.storageSnapshots.filter((item) => (!tenantId || item.tenantId === tenantId)
        && (!startDate || item.snapshotDate >= startDate) && (!endDate || item.snapshotDate < endDate)))
    },
    async getMonthlySnapshot(tenantId, month) { return clone(by('monthlySnapshots', (item) => item.tenantId === tenantId && item.billingMonth === month) ?? null) },
    async insertMonthlySnapshot(snapshot) {
      if (state.monthlySnapshots.some((item) => item.tenantId === snapshot.tenantId && item.billingMonth === snapshot.billingMonth)) {
        throw new BillingServiceError('BILLING_MONTHLY_SNAPSHOT_IMMUTABLE', '확정된 월 청구 스냅샷은 변경할 수 없습니다.', 409)
      }
      state.monthlySnapshots.push(clone(snapshot)); return clone(snapshot)
    },
    async listMonthlySnapshots({ tenantId, tenantIds } = {}) {
      const scope = tenantIds ? new Set(tenantIds) : null
      return clone(state.monthlySnapshots.filter((item) => (!tenantId || item.tenantId === tenantId) && (!scope || scope.has(item.tenantId))))
    },
    async listKnownTenantIds() {
      return [...new Set([
        ...state.assignments.map((item) => item.tenantId),
        ...state.usageReservations.map((item) => item.tenantId),
        ...state.usageEvents.map((item) => item.tenantId),
        ...state.reconciliations.map((item) => item.tenantId),
        ...state.storageSnapshots.map((item) => item.tenantId),
        ...state.monthlySnapshots.map((item) => item.tenantId),
      ])]
    },
  }
}

export function createMemoryBillingRepository(seed = {}) {
  let state = {
    modelRates: clone(seed.modelRates ?? []),
    plans: clone(seed.plans ?? []),
    assignments: clone(seed.assignments ?? []),
    usageReservations: clone(seed.usageReservations ?? []),
    usageEvents: clone(seed.usageEvents ?? []),
    reconciliations: clone(seed.reconciliations ?? []),
    storageSnapshots: clone(seed.storageSnapshots ?? []),
    monthlySnapshots: clone(seed.monthlySnapshots ?? []),
  }
  let transactionTail = Promise.resolve()
  const repository = {
    ...createMemoryAccessors(state),
    transaction(work) {
      const execute = transactionTail.then(async () => {
        const draft = clone(state)
        const result = await work(createMemoryAccessors(draft))
        state = draft
        Object.assign(repository, createMemoryAccessors(state))
        return clone(result)
      })
      transactionTail = execute.catch(() => undefined)
      return execute
    },
    inspect() { return clone(state) },
  }
  return repository
}

export const BILLING_HTTP_API_CONTRACT = Object.freeze({
  dashboard: { method: 'GET', path: '/api/billing/dashboard', auth: 'platform-operator' },
  configuration: { method: 'GET', path: '/api/billing/configuration', auth: 'platform-operator' },
  modelRate: { method: 'PUT', path: '/api/billing/model-rates/:model', auth: 'platform-operator' },
  plan: { method: 'PUT', path: '/api/billing/plans/:id', auth: 'platform-operator' },
  assignment: { method: 'PUT', path: '/api/billing/tenant-assignments/:tenantId', auth: 'platform-operator' },
  usageEvent: { method: 'POST', path: '/internal/billing/usage-events', auth: 'trusted server only; never expose to browser' },
  usageReservation: { method: 'POST', path: '/internal/billing/usage-reservations', auth: 'trusted server preflight only; reserve before model call' },
  storageSnapshot: { method: 'POST', path: '/internal/billing/storage-snapshots', auth: 'trusted scheduler only; once per Korea date' },
  monthlySnapshot: { method: 'POST', path: '/api/billing/monthly-snapshots', auth: 'platform-operator; closed months only' },
})

export function createBillingService({ repository, clock = () => new Date(), idFactory = randomUUID, defaultCurrency = 'KRW' } = {}) {
  const missingMethods = BILLING_REPOSITORY_METHODS.filter((method) => typeof repository?.[method] !== 'function')
  if (missingMethods.length) {
    throw new BillingServiceError('BILLING_REPOSITORY_REQUIRED', 'billing repository 계약을 충족하지 않습니다.', 500, { missingMethods })
  }

  const readConfiguration = async (actor) => {
    authorizeBillingOperation(actor, 'configuration:read')
    const [modelRates, plans, assignments] = await Promise.all([
      repository.listModelRates(), repository.listPlans(), repository.listAssignments(),
    ])
    return { modelRates, plans, assignments, defaults: { currency: defaultCurrency, limitAction: 'warn' } }
  }

  const service = {
    getConfiguration: readConfiguration,

    async upsertModelRate(actorInput, input) {
      const actor = authorizeBillingOperation(actorInput, 'model-rate:write')
      return repository.transaction(async (transaction) => {
        const model = requiredText(input?.model, 'model', 120)
        const existing = await transaction.getModelRate(model)
        return transaction.upsertModelRate(normalizeRate(input, existing, actor, clock, defaultCurrency))
      })
    },

    async upsertPlan(actorInput, input) {
      const actor = authorizeBillingOperation(actorInput, 'plan:write')
      return repository.transaction(async (transaction) => {
        const id = requiredText(input?.id, 'id', 100)
        const existing = await transaction.getPlan(id)
        return transaction.upsertPlan(normalizePlan(input, existing, actor, clock, defaultCurrency))
      })
    },

    async assignPlan(actorInput, input) {
      const actor = authorizeBillingOperation(actorInput, 'assignment:write')
      return repository.transaction(async (transaction) => {
        const planId = requiredText(input?.planId, 'planId', 100)
        const plan = await transaction.getPlan(planId)
        if (!plan || !plan.active) throw new BillingServiceError('BILLING_PLAN_NOT_FOUND', '활성 요금제를 찾을 수 없습니다.', 404)
        return transaction.upsertAssignment(normalizeAssignment(input, plan, actor, clock))
      })
    },

    async reserveUsage(actorInput, input) {
      const tenantId = requiredText(input?.tenantId, 'tenantId', 120)
      const actor = authorizeBillingOperation(actorInput, 'usage:write', tenantId)
      const now = normalizedIso(clock(), 'reservedAt')
      const normalizedInput = {
        id: requiredText(input?.id ?? idFactory(), 'id', 160),
        tenantId,
        userId: requiredText(input?.userId, 'userId', 160),
        feature: requiredText(input?.feature, 'feature', 120),
        model: requiredText(input?.model, 'model', 120),
        estimatedInputTokens: nonNegativeInteger(input?.estimatedInputTokens, 'estimatedInputTokens'),
        estimatedOutputTokens: nonNegativeInteger(input?.estimatedOutputTokens, 'estimatedOutputTokens'),
        occurredAt: normalizedIso(input?.occurredAt ?? clock(), 'occurredAt'),
      }
      return repository.transaction(async (transaction) => {
        const existing = await transaction.getUsageReservation(normalizedInput.id)
        if (existing) {
          if (reservationIdentity(existing) !== reservationIdentity(normalizedInput)) {
            throw new BillingServiceError('BILLING_RESERVATION_CONFLICT', '동일 ID의 사용 예약 내용이 일치하지 않습니다.', 409)
          }
          return { reservation: existing, duplicate: true, decision: existing.limitDecision }
        }
        const rate = await transaction.getModelRate(normalizedInput.model) ?? emptyRate(normalizedInput.model, defaultCurrency)
        const estimatedCharge = chargeForUsage(rate, normalizedInput.estimatedInputTokens, normalizedInput.estimatedOutputTokens)
        const assignment = await transaction.getAssignment(tenantId)
        const plan = assignment ? await transaction.getPlan(assignment.planId) : null
        const limit = pointLimit(assignment, plan)
        const { startAt, endAt } = monthRange(billingMonth(normalizedInput.occurredAt))
        const [priorEvents, activeReservations] = await Promise.all([
          transaction.listUsageEvents({ tenantId, startAt, endAt }),
          transaction.listActiveUsageReservations({ tenantId, startAt, endAt, now }),
        ])
        const priorPoints = sum(priorEvents.map((event) => event.totalPoints))
        const reservedPoints = sum(activeReservations.map((reservation) => reservation.estimatedPoints))
        const projectedPoints = roundMetric(priorPoints + reservedPoints + estimatedCharge.totalPoints)
        const utilizationPercent = limit === null ? null : limit === 0 ? (projectedPoints > 0 ? 100 : 0) : roundMetric(projectedPoints / limit * 100)
        const threshold = plan?.warningThresholdPercent ?? BILLING_DEFAULT_WARNING_THRESHOLD_PERCENT
        let status = limit === null ? 'unconfigured' : utilizationPercent > 100 ? 'exceeded' : utilizationPercent >= threshold ? 'warning' : 'ok'
        const action = assignment?.limitAction ?? 'warn'
        if (status === 'exceeded' && action === 'block') {
          throw new BillingServiceError('BILLING_LIMIT_EXCEEDED', '이번 AI 요청은 고객사의 포인트 한도를 초과하여 실행 전에 차단되었습니다.', 402, {
            tenantId, limit, priorPoints, reservedPoints, requestedPoints: estimatedCharge.totalPoints, projectedPoints, action,
          })
        }
        if (!rate.confirmed) status = status === 'ok' ? 'unconfirmed-rate' : status
        const reservation = {
          ...normalizedInput,
          billingMonth: billingMonth(normalizedInput.occurredAt),
          estimatedPoints: estimatedCharge.totalPoints,
          estimatedCost: estimatedCharge.totalCost,
          currency: rate.currency,
          rateConfirmed: Boolean(rate.confirmed),
          rateSnapshot: clone(rate),
          limitDecision: { status, action, pointLimit: limit, projectedPoints, utilizationPercent },
          status: 'pending',
          reservedAt: now,
          expiresAt: new Date(new Date(now).getTime() + USAGE_RESERVATION_TTL_MS).toISOString(),
          reservedBy: actor.id,
        }
        await transaction.insertUsageReservation(reservation)
        return { reservation, duplicate: false, decision: reservation.limitDecision }
      })
    },

    async releaseUsageReservation(actorInput, input) {
      const tenantId = requiredText(input?.tenantId, 'tenantId', 120)
      const actor = authorizeBillingOperation(actorInput, 'usage:write', tenantId)
      return repository.transaction(async (transaction) => {
        const reservation = await transaction.getUsageReservation(requiredText(input?.reservationId, 'reservationId', 160))
        if (!reservation || reservation.tenantId !== tenantId) throw new BillingServiceError('BILLING_RESERVATION_NOT_FOUND', '사용 예약을 찾을 수 없습니다.', 404)
        if (reservation.status !== 'pending' || reservation.reconciliationPending) return { reservation, changed: false }
        const released = { ...reservation, status: 'released', releasedAt: normalizedIso(clock(), 'releasedAt'), releasedBy: actor.id }
        await transaction.updateUsageReservation(released)
        return { reservation: released, changed: true }
      })
    },

    async recordUsageEvent(actorInput, input) {
      const tenantId = requiredText(input?.tenantId, 'tenantId', 120)
      const actor = authorizeBillingOperation(actorInput, 'usage:write', tenantId)
      const normalizedInput = {
        id: requiredText(input?.id ?? idFactory(), 'id', 160),
        tenantId,
        userId: requiredText(input?.userId, 'userId', 160),
        feature: requiredText(input?.feature, 'feature', 120),
        model: requiredText(input?.model, 'model', 120),
        inputTokens: nonNegativeInteger(input?.inputTokens, 'inputTokens'),
        outputTokens: nonNegativeInteger(input?.outputTokens, 'outputTokens'),
        occurredAt: normalizedIso(input?.occurredAt ?? clock(), 'occurredAt'),
        durationMs: input?.durationMs === undefined ? null : nonNegativeInteger(input.durationMs, 'durationMs'),
        reservationId: input?.reservationId ? requiredText(input.reservationId, 'reservationId', 160) : null,
        metadata: input?.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? clone(input.metadata) : {},
      }
      return repository.transaction(async (transaction) => {
        const existing = await transaction.getUsageEvent(normalizedInput.id)
        if (existing) {
          if (usageIdentity(existing) !== usageIdentity(normalizedInput)) {
            throw new BillingServiceError('BILLING_EVENT_CONFLICT', '동일 ID의 사용 이벤트 내용이 일치하지 않습니다.', 409)
          }
          return { event: existing, duplicate: true, decision: existing.limitDecision }
        }
        const reservation = normalizedInput.reservationId ? await transaction.getUsageReservation(normalizedInput.reservationId) : null
        const isReconciliation = reservation?.reconciliationPending === true
        if (normalizedInput.reservationId && (!reservation || reservation.status !== 'pending'
          || reservation.tenantId !== tenantId || reservation.userId !== normalizedInput.userId
          || reservation.feature !== normalizedInput.feature || reservation.model !== normalizedInput.model
          || (!isReconciliation && reservation.expiresAt <= normalizedIso(clock(), 'recordedAt')))) {
          throw new BillingServiceError('BILLING_RESERVATION_INVALID', '유효한 AI 사용 예약을 찾을 수 없습니다.', 409)
        }
        const rate = reservation?.rateSnapshot ?? await transaction.getModelRate(normalizedInput.model) ?? emptyRate(normalizedInput.model, defaultCurrency)
        const charge = chargeForUsage(rate, normalizedInput.inputTokens, normalizedInput.outputTokens)
        const assignment = await transaction.getAssignment(tenantId)
        const plan = assignment ? await transaction.getPlan(assignment.planId) : null
        const limit = pointLimit(assignment, plan)
        const { startAt, endAt } = monthRange(billingMonth(normalizedInput.occurredAt))
        const now = normalizedIso(clock(), 'recordedAt')
        const [priorEvents, activeReservations] = await Promise.all([
          transaction.listUsageEvents({ tenantId, startAt, endAt }),
          transaction.listActiveUsageReservations({ tenantId, startAt, endAt, now }),
        ])
        const priorPoints = sum(priorEvents.map((event) => event.totalPoints))
        const reservedPoints = sum(activeReservations.filter((item) => item.id !== reservation?.id).map((item) => item.estimatedPoints))
        const projectedPoints = roundMetric(priorPoints + reservedPoints + charge.totalPoints)
        const utilizationPercent = limit === null ? null : limit === 0 ? (projectedPoints > 0 ? 100 : 0) : roundMetric(projectedPoints / limit * 100)
        const threshold = plan?.warningThresholdPercent ?? BILLING_DEFAULT_WARNING_THRESHOLD_PERCENT
        let status = limit === null ? 'unconfigured' : utilizationPercent > 100 ? 'exceeded' : utilizationPercent >= threshold ? 'warning' : 'ok'
        const action = assignment?.limitAction ?? 'warn'
        if (status === 'exceeded' && action === 'block' && !reservation) {
          throw new BillingServiceError('BILLING_LIMIT_EXCEEDED', '이번 AI 요청은 고객사의 포인트 한도를 초과하여 차단되었습니다.', 402, {
            tenantId, limit, priorPoints, reservedPoints, requestedPoints: charge.totalPoints, projectedPoints, action,
          })
        }
        if (!rate.confirmed) status = status === 'ok' ? 'unconfirmed-rate' : status
        const event = {
          ...normalizedInput,
          billingMonth: billingMonth(normalizedInput.occurredAt),
          ...charge,
          currency: rate.currency,
          rateConfirmed: Boolean(rate.confirmed),
          rateSnapshot: clone(rate),
          limitDecision: { status, action, pointLimit: limit, projectedPoints, utilizationPercent, reservationCommitted: Boolean(reservation) },
          recordedAt: now,
          recordedBy: actor.id,
        }
        await transaction.insertUsageEvent(event)
        if (reservation) await transaction.updateUsageReservation({ ...reservation, status: 'committed', reconciliationPending: false, committedAt: now, usageEventId: event.id })
        return { event, duplicate: false, decision: event.limitDecision }
      })
    },

    async recordReconciliationPending(actorInput, input) {
      const tenantId = requiredText(input?.tenantId, 'tenantId', 120)
      const actor = authorizeBillingOperation(actorInput, 'usage:write', tenantId)
      const now = normalizedIso(clock(), 'updatedAt')
      const normalized = {
        id: requiredText(input?.id ?? `reconciliation:${input?.usageEventId ?? idFactory()}`, 'id', 200),
        usageEventId: requiredText(input?.usageEventId, 'usageEventId', 160),
        reservationId: requiredText(input?.reservationId, 'reservationId', 160),
        tenantId,
        userId: requiredText(input?.userId, 'userId', 160),
        feature: requiredText(input?.feature, 'feature', 120),
        model: requiredText(input?.model, 'model', 120),
        inputTokens: nonNegativeInteger(input?.inputTokens, 'inputTokens'),
        outputTokens: nonNegativeInteger(input?.outputTokens, 'outputTokens'),
        occurredAt: normalizedIso(input?.occurredAt ?? clock(), 'occurredAt'),
        durationMs: input?.durationMs === undefined ? null : nonNegativeInteger(input.durationMs, 'durationMs'),
        metadata: input?.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? clone(input.metadata) : {},
        lastError: optionalText(input?.lastError, 500),
      }
      return repository.transaction(async (transaction) => {
        const existing = await transaction.getReconciliation(normalized.id)
        if (existing) {
          if (reconciliationIdentity(existing) !== reconciliationIdentity(normalized)) {
            throw new BillingServiceError('BILLING_RECONCILIATION_CONFLICT', '동일 ID의 조정 대기 내용이 일치하지 않습니다.', 409)
          }
          return { reconciliation: existing, duplicate: true }
        }
        const reservation = await transaction.getUsageReservation(normalized.reservationId)
        if (!reservation || reservation.tenantId !== tenantId || reservation.userId !== normalized.userId
          || reservation.feature !== normalized.feature || reservation.model !== normalized.model
          || reservation.status !== 'pending') {
          throw new BillingServiceError('BILLING_RESERVATION_INVALID', '조정할 AI 사용 예약을 찾을 수 없습니다.', 409)
        }
        const reconciliation = {
          ...normalized,
          status: 'pending',
          attempts: 0,
          nextAttemptAt: now,
          createdAt: now,
          updatedAt: now,
          recordedBy: actor.id,
        }
        await transaction.insertReconciliation(reconciliation)
        if (!reservation.reconciliationPending) {
          await transaction.updateUsageReservation({ ...reservation, reconciliationPending: true })
        }
        return { reconciliation, duplicate: false }
      })
    },

    async reconcilePendingUsage(actorInput, input) {
      const tenantId = requiredText(input?.tenantId, 'tenantId', 120)
      const actor = authorizeBillingOperation(actorInput, 'usage:write', tenantId)
      const id = requiredText(input?.id, 'id', 200)
      const pending = await repository.getReconciliation(id)
      if (!pending || pending.tenantId !== tenantId) throw new BillingServiceError('BILLING_RECONCILIATION_NOT_FOUND', '조정 대기 내역을 찾을 수 없습니다.', 404)
      if (pending.status === 'resolved') return { reconciliation: pending, duplicate: true }
      try {
        const result = await service.recordUsageEvent(actor, {
          id: pending.usageEventId,
          reservationId: pending.reservationId,
          tenantId: pending.tenantId,
          userId: pending.userId,
          feature: pending.feature,
          model: pending.model,
          inputTokens: pending.inputTokens,
          outputTokens: pending.outputTokens,
          occurredAt: pending.occurredAt,
          durationMs: pending.durationMs ?? undefined,
          metadata: { ...pending.metadata, reconciledFrom: pending.id },
        })
        const resolved = await repository.transaction(async (transaction) => {
          const current = await transaction.getReconciliation(id)
          if (!current) throw new BillingServiceError('BILLING_RECONCILIATION_NOT_FOUND', '조정 대기 내역을 찾을 수 없습니다.', 404)
          const updated = {
            ...current,
            status: 'resolved',
            attempts: Number(current.attempts || 0) + 1,
            resolvedAt: normalizedIso(clock(), 'resolvedAt'),
            updatedAt: normalizedIso(clock(), 'updatedAt'),
            lastError: '',
          }
          await transaction.updateReconciliation(updated)
          return updated
        })
        return { reconciliation: resolved, usage: result, duplicate: false }
      } catch (error) {
        await repository.transaction(async (transaction) => {
          const current = await transaction.getReconciliation(id)
          if (!current || current.status !== 'pending') return current
          const updated = {
            ...current,
            attempts: Number(current.attempts || 0) + 1,
            lastError: optionalText(error instanceof Error ? error.message : String(error), 500),
            nextAttemptAt: new Date(new Date(clock()).getTime() + 60_000).toISOString(),
            updatedAt: normalizedIso(clock(), 'updatedAt'),
          }
          await transaction.updateReconciliation(updated)
          return updated
        }).catch(() => undefined)
        throw error
      }
    },

    async reconcilePendingUsageBatch(actorInput, input) {
      const tenantId = requiredText(input?.tenantId, 'tenantId', 120)
      const actor = authorizeBillingOperation(actorInput, 'usage:write', tenantId)
      const limit = Math.min(100, Math.max(1, nonNegativeInteger(input?.limit ?? 25, 'limit')))
      const pending = await repository.listPendingReconciliations({
        tenantId,
        limit,
        now: normalizedIso(clock(), 'now'),
      })
      const results = []
      for (const item of pending) {
        try {
          const result = await service.reconcilePendingUsage(actor, { tenantId, id: item.id })
          results.push({ id: item.id, status: 'resolved', duplicate: result.duplicate === true })
        } catch (error) {
          results.push({ id: item.id, status: 'pending', error: error instanceof Error ? error.message : String(error) })
        }
      }
      return {
        tenantId,
        attempted: results.length,
        resolved: results.filter((item) => item.status === 'resolved').length,
        pending: results.filter((item) => item.status === 'pending').length,
        results,
      }
    },

    async recordDailyStorageSnapshot(actorInput, input) {
      const tenantId = requiredText(input?.tenantId, 'tenantId', 120)
      const actor = authorizeBillingOperation(actorInput, 'storage-snapshot:write', tenantId)
      const measuredAt = normalizedIso(input?.measuredAt ?? clock(), 'measuredAt')
      const snapshotDate = billingDate(measuredAt)
      if (input?.snapshotDate && input.snapshotDate !== snapshotDate) {
        throw new BillingServiceError('BILLING_SNAPSHOT_DATE_MISMATCH', 'snapshotDate는 측정 시각의 한국 날짜와 일치해야 합니다.')
      }
      return repository.transaction(async (transaction) => {
        const existing = await transaction.getStorageSnapshot(tenantId, snapshotDate)
        if (existing) return { snapshot: existing, duplicate: true }
        const snapshot = {
          id: `${tenantId}:${snapshotDate}`,
          tenantId,
          snapshotDate,
          bytes: nonNegativeInteger(input?.bytes, 'bytes'),
          objectCount: nonNegativeInteger(input?.objectCount, 'objectCount'),
          measuredAt,
          recordedAt: normalizedIso(clock(), 'recordedAt'),
          recordedBy: actor.id,
        }
        await transaction.insertStorageSnapshot(snapshot)
        return { snapshot, duplicate: false }
      })
    },

    async createMonthlySnapshot(actorInput, input) {
      const actor = authorizeBillingOperation(actorInput, 'monthly-snapshot:write')
      const tenantId = requiredText(input?.tenantId, 'tenantId', 120)
      const month = assertMonth(input?.month)
      if (month >= billingMonth(clock())) {
        throw new BillingServiceError('BILLING_MONTH_NOT_CLOSED', '현재 월과 미래 월은 확정할 수 없습니다.', 409)
      }
      return repository.transaction(async (transaction) => {
        const existing = await transaction.getMonthlySnapshot(tenantId, month)
        if (existing) return { snapshot: existing, created: false }
        const calculated = await calculateLiveTenantMonth(transaction, tenantId, month)
        const snapshot = {
          id: `${tenantId}:${month}`,
          tenantId,
          billingMonth: month,
          summary: clone(calculated.summary),
          details: clone(calculated.details),
          assignmentSnapshot: clone(calculated.assignment),
          planSnapshot: clone(calculated.plan),
          immutable: true,
          finalizedAt: normalizedIso(clock(), 'finalizedAt'),
          finalizedBy: actor.id,
        }
        await transaction.insertMonthlySnapshot(snapshot)
        return { snapshot, created: true }
      })
    },

    async getDashboard(actorInput, input = {}) {
      const actor = authorizeBillingOperation(actorInput, 'dashboard:read')
      const month = assertMonth(input.month ?? billingMonth(clock()))
      const requested = input.tenantId ? [input.tenantId] : Array.isArray(input.tenantIds) ? input.tenantIds : await repository.listKnownTenantIds()
      const tenantIds = [...new Set(requested.map((value) => requiredText(value, 'tenantId', 120)))]
      const selectedTenantRows = await Promise.all(tenantIds.map(async (tenantId) => {
        const row = await tenantMonth(repository, tenantId, month, month < billingMonth(clock()))
        return { tenantId, ...row.summary, details: row.details, snapshot: row.snapshot ?? null }
      }))
      const months = Array.from({ length: DASHBOARD_MONTH_COUNT }, (_value, index) => shiftMonth(month, index - (DASHBOARD_MONTH_COUNT - 1)))
      const series = []
      for (const seriesMonth of months) {
        const rows = await Promise.all(tenantIds.map((tenantId) => tenantMonth(repository, tenantId, seriesMonth, seriesMonth < billingMonth(clock()))))
        series.push(aggregateSummaries(rows.map((row) => row.summary), seriesMonth))
      }
      const { startAt, endAt } = monthRange(month)
      const events = await repository.listUsageEvents({ tenantIds, startAt, endAt })
      const summary = aggregateSummaries(selectedTenantRows, month)
      const snapshots = (await repository.listMonthlySnapshots({ tenantIds })).map((snapshot) => ({
        ...snapshot,
        summary: normalizeFinancialSummary(snapshot.summary),
      }))
      const dashboard = {
        scope: 'platform',
        month,
        tenantIds,
        cards: {
          revenue: summary.revenue,
          invoiceTotal: summary.invoiceTotal,
          apiCost: summary.apiCost,
          margin: summary.margin,
          pointOverageRevenue: summary.pointOverageRevenue,
          storageOverageRevenue: summary.storageOverageRevenue,
          totalCost: summary.totalCost,
          aiCost: summary.aiCost,
          pointsUsed: summary.pointsUsed,
          pointLimit: summary.pointLimit,
          utilizationPercent: summary.utilizationPercent,
          storageBytes: summary.storageBytes,
          eventCount: summary.eventCount,
          configurationStatus: summary.configurationStatus,
          currency: summary.currency,
        },
        summary,
        gauge: tenantIds.length === 1 ? {
          tenantId: tenantIds[0],
          pointsUsed: selectedTenantRows[0]?.pointsUsed ?? 0,
          pointLimit: selectedTenantRows[0]?.pointLimit ?? null,
          utilizationPercent: selectedTenantRows[0]?.utilizationPercent ?? null,
          limitAction: selectedTenantRows[0]?.limitAction ?? 'warn',
          configurationStatus: selectedTenantRows[0]?.configurationStatus ?? 'unconfigured',
        } : null,
        series,
        details: {
          tenants: selectedTenantRows,
          models: groupRows(events, (event) => event.model),
          features: groupRows(events, (event) => event.feature),
          users: groupRows(events, (event) => event.userId),
        },
        monthlySnapshots: snapshots.sort((left, right) => right.billingMonth.localeCompare(left.billingMonth)),
      }
      dashboard.configuration = await readConfiguration(actor)
      return dashboard
    },
  }
  return service
}

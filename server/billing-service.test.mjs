import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BillingServiceError,
  createBillingService,
  createMemoryBillingRepository,
} from './billing-service.mjs'

const platform = { id: 'operator-1', role: 'platform-operator', name: '플랫폼 운영자' }
const systemFor = (tenantId) => ({ id: 'billing-collector', role: 'system', trusted: true, tenantId })
const adminFor = (tenantId) => ({ id: `admin-${tenantId}`, role: 'tenant-admin', tenantId })
const fixedClock = () => new Date('2026-08-21T03:00:00.000Z')

function createFixture() {
  const repository = createMemoryBillingRepository()
  const service = createBillingService({ repository, clock: fixedClock })
  return { repository, service }
}

async function configureTenant(service, tenantId, overrides = {}) {
  await service.upsertModelRate(platform, {
    model: 'model-a',
    displayName: 'Model A',
    currency: 'KRW',
    inputCostPerMillion: overrides.inputCostPerMillion ?? 10,
    outputCostPerMillion: overrides.outputCostPerMillion ?? 20,
    inputPointsPerMillion: overrides.inputPointsPerMillion ?? 100,
    outputPointsPerMillion: overrides.outputPointsPerMillion ?? 200,
    confirmed: true,
  })
  await service.upsertPlan(platform, {
    id: 'plan-a',
    name: 'Plan A',
    currency: 'KRW',
    monthlyPrice: overrides.monthlyPrice ?? 50,
    includedPoints: overrides.includedPoints ?? 100,
    includedStorageBytes: overrides.includedStorageBytes ?? 1_000,
    storageOveragePerGb: overrides.storageOveragePerGb ?? 0,
    pointOveragePrice: overrides.pointOveragePrice ?? 0,
    warningThresholdPercent: overrides.warningThresholdPercent ?? 80,
    confirmed: true,
    active: true,
  })
  return service.assignPlan(platform, {
    tenantId,
    planId: 'plan-a',
    limitAction: overrides.limitAction ?? 'warn',
  })
}

test('unconfigured models are recorded at zero as explicitly unconfirmed and event retries are idempotent', async () => {
  const { repository, service } = createFixture()
  const input = {
    id: 'usage-unknown', tenantId: 'tenant-a', userId: 'user-a', feature: 'ai-chat', model: 'unpriced-model',
    inputTokens: 120, outputTokens: 80, occurredAt: '2026-08-20T01:00:00.000Z',
  }
  const first = await service.recordUsageEvent(systemFor('tenant-a'), input)
  assert.equal(first.duplicate, false)
  assert.equal(first.event.totalCost, 0)
  assert.equal(first.event.totalPoints, 0)
  assert.equal(first.event.rateConfirmed, false)
  assert.equal(first.decision.status, 'unconfigured')

  const retry = await service.recordUsageEvent(systemFor('tenant-a'), input)
  assert.equal(retry.duplicate, true)
  assert.equal(repository.inspect().usageEvents.length, 1)

  await assert.rejects(
    service.recordUsageEvent(systemFor('tenant-a'), { ...input, outputTokens: 81 }),
    (error) => error instanceof BillingServiceError && error.code === 'BILLING_EVENT_CONFLICT',
  )
})

test('editable rates and plans drive warn/block decisions without repricing stored events', async () => {
  const { repository, service } = createFixture()
  await configureTenant(service, 'tenant-a')

  const first = await service.recordUsageEvent(systemFor('tenant-a'), {
    id: 'usage-1', tenantId: 'tenant-a', userId: 'user-a', feature: 'label-check', model: 'model-a',
    inputTokens: 500_000, outputTokens: 100_000, occurredAt: '2026-08-20T01:00:00.000Z',
  })
  assert.equal(first.event.totalCost, 7)
  assert.equal(first.event.totalPoints, 70)
  assert.equal(first.decision.status, 'ok')

  const warning = await service.recordUsageEvent(systemFor('tenant-a'), {
    id: 'usage-2', tenantId: 'tenant-a', userId: 'user-a', feature: 'label-check', model: 'model-a',
    inputTokens: 200_000, outputTokens: 0, occurredAt: '2026-08-20T02:00:00.000Z',
  })
  assert.equal(warning.decision.status, 'warning')
  assert.equal(warning.decision.projectedPoints, 90)

  await service.assignPlan(platform, { tenantId: 'tenant-a', planId: 'plan-a', limitAction: 'block' })
  await assert.rejects(
    service.recordUsageEvent(systemFor('tenant-a'), {
      id: 'usage-3', tenantId: 'tenant-a', userId: 'user-a', feature: 'label-check', model: 'model-a',
      inputTokens: 200_000, outputTokens: 0, occurredAt: '2026-08-20T03:00:00.000Z',
    }),
    (error) => error instanceof BillingServiceError && error.code === 'BILLING_LIMIT_EXCEEDED' && error.status === 402,
  )
  assert.equal(repository.inspect().usageEvents.length, 2)

  await service.upsertModelRate(platform, {
    model: 'model-a', displayName: 'Model A', currency: 'KRW', inputCostPerMillion: 999,
    outputCostPerMillion: 999, inputPointsPerMillion: 999, outputPointsPerMillion: 999, confirmed: true,
  })
  assert.equal(repository.inspect().usageEvents[0].totalCost, 7)
  assert.equal(repository.inspect().usageEvents[0].rateSnapshot.inputCostPerMillion, 10)
})

test('tenant transactions serialize concurrent point-limit checks', async () => {
  const { repository, service } = createFixture()
  await configureTenant(service, 'tenant-a', {
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    inputPointsPerMillion: 1_000_000,
    outputPointsPerMillion: 0,
    includedPoints: 100,
    limitAction: 'block',
  })
  const event = (id) => service.recordUsageEvent(systemFor('tenant-a'), {
    id, tenantId: 'tenant-a', userId: 'user-a', feature: 'ai-chat', model: 'model-a',
    inputTokens: 60, outputTokens: 0, occurredAt: '2026-08-20T04:00:00.000Z',
  })
  const results = await Promise.allSettled([event('concurrent-a'), event('concurrent-b')])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason?.code === 'BILLING_LIMIT_EXCEEDED').length, 1)
  assert.equal(repository.inspect().usageEvents.length, 1)
})

test('storage collection is immutable and idempotent once per Korea date', async () => {
  const { repository, service } = createFixture()
  const first = await service.recordDailyStorageSnapshot(systemFor('tenant-a'), {
    tenantId: 'tenant-a', bytes: 1_200, objectCount: 4, measuredAt: '2026-08-20T16:00:00.000Z',
  })
  assert.equal(first.snapshot.snapshotDate, '2026-08-21')
  assert.equal(first.duplicate, false)

  const retry = await service.recordDailyStorageSnapshot(systemFor('tenant-a'), {
    tenantId: 'tenant-a', bytes: 9_999, objectCount: 99, measuredAt: '2026-08-21T01:00:00.000Z',
  })
  assert.equal(retry.duplicate, true)
  assert.equal(retry.snapshot.bytes, 1_200)
  assert.equal(repository.inspect().storageSnapshots.length, 1)

  await assert.rejects(
    service.recordDailyStorageSnapshot(systemFor('tenant-b'), {
      tenantId: 'tenant-a', bytes: 1, objectCount: 1, measuredAt: '2026-08-21T01:00:00.000Z',
    }),
    (error) => error?.code === 'BILLING_FORBIDDEN',
  )
})

test('billing dashboards are platform-only and operators finalize immutable closed months', async () => {
  const { service } = createFixture()
  await configureTenant(service, 'tenant-a', { includedPoints: 1_000, monthlyPrice: 25 })
  await service.recordUsageEvent(systemFor('tenant-a'), {
    id: 'july-usage', tenantId: 'tenant-a', userId: 'user-a', feature: 'document-search', model: 'model-a',
    inputTokens: 100_000, outputTokens: 50_000, occurredAt: '2026-07-12T03:00:00.000Z',
  })
  await service.recordDailyStorageSnapshot(systemFor('tenant-a'), {
    tenantId: 'tenant-a', bytes: 2_000, objectCount: 8, measuredAt: '2026-07-31T03:00:00.000Z',
  })

  const own = await service.getDashboard(platform, { tenantId: 'tenant-a', month: '2026-07' })
  assert.equal(own.scope, 'platform')
  assert.deepEqual(own.tenantIds, ['tenant-a'])
  assert.equal(own.series.length, 6)
  assert.equal(own.gauge.tenantId, 'tenant-a')
  assert.equal(own.details.tenants.length, 1)

  await assert.rejects(
    service.getDashboard(adminFor('tenant-a'), { tenantId: 'tenant-a', month: '2026-07' }),
    (error) => error?.code === 'BILLING_FORBIDDEN',
  )
  await assert.rejects(
    service.upsertPlan(adminFor('tenant-a'), { id: 'forbidden', name: 'Forbidden' }),
    (error) => error?.code === 'BILLING_FORBIDDEN',
  )

  const finalized = await service.createMonthlySnapshot(platform, { tenantId: 'tenant-a', month: '2026-07' })
  assert.equal(finalized.created, true)
  assert.equal(finalized.snapshot.immutable, true)
  const originalTotal = finalized.snapshot.summary.totalCost

  await service.upsertPlan(platform, {
    id: 'plan-a', name: 'Plan A revised', currency: 'KRW', monthlyPrice: 999,
    includedPoints: 1_000, includedStorageBytes: 1_000, storageOveragePerGb: 0, confirmed: true, active: true,
  })
  const historical = await service.getDashboard(platform, { tenantId: 'tenant-a', month: '2026-07' })
  assert.equal(historical.cards.totalCost, originalTotal)
  assert.equal(historical.details.tenants[0].snapshot.immutable, true)

  const retry = await service.createMonthlySnapshot(platform, { tenantId: 'tenant-a', month: '2026-07' })
  assert.equal(retry.created, false)
  assert.equal(retry.snapshot.summary.totalCost, originalTotal)
  await assert.rejects(
    service.createMonthlySnapshot(platform, { tenantId: 'tenant-a', month: '2026-08' }),
    (error) => error?.code === 'BILLING_MONTH_NOT_CLOSED',
  )
})

test('invoice revenue separates base, point overage and storage overage from provider API cost and margin', async () => {
  const { service } = createFixture()
  await configureTenant(service, 'tenant-a', {
    monthlyPrice: 100,
    includedPoints: 50,
    pointOveragePrice: 2,
    includedStorageBytes: 1_000,
    storageOveragePerGb: 10,
    inputCostPerMillion: 10,
    inputPointsPerMillion: 100,
  })
  await service.recordUsageEvent(systemFor('tenant-a'), {
    id: 'invoice-usage', tenantId: 'tenant-a', userId: 'user-a', feature: 'ai-chat', model: 'model-a',
    inputTokens: 600_000, outputTokens: 0, occurredAt: '2026-08-21T03:00:00.000Z',
  })
  await service.recordDailyStorageSnapshot(systemFor('tenant-a'), {
    tenantId: 'tenant-a', bytes: 1_000_001_000, objectCount: 2, measuredAt: '2026-08-21T03:00:00.000Z',
  })
  const dashboard = await service.getDashboard(platform, { tenantId: 'tenant-a', month: '2026-08' })
  assert.equal(dashboard.summary.baseRevenue, 100)
  assert.equal(dashboard.summary.pointOveragePoints, 10)
  assert.equal(dashboard.summary.pointOverageRevenue, 20)
  assert.equal(dashboard.summary.storageOverageRevenue, 10)
  assert.equal(dashboard.summary.revenue, 130)
  assert.equal(dashboard.summary.invoiceTotal, 130)
  assert.equal(dashboard.summary.apiCost, 6)
  assert.equal(dashboard.summary.margin, 124)
  assert.equal(dashboard.summary.totalCost, 130)
})

test('provider-success ledger failures persist a reconciliation reservation and recover idempotently', async () => {
  const base = createMemoryBillingRepository()
  let failUsageInsert = true
  const failingRepository = new Proxy(base, {
    get(target, property) {
      if (property === 'transaction') {
        return (work) => target.transaction((transaction) => work(new Proxy(transaction, {
          get(transactionTarget, transactionProperty) {
            if (transactionProperty === 'insertUsageEvent' && failUsageInsert) {
              return async () => { failUsageInsert = false; throw new Error('temporary ledger outage') }
            }
            return transactionTarget[transactionProperty]
          },
        })))
      }
      return target[property]
    },
  })
  const service = createBillingService({ repository: failingRepository, clock: fixedClock })
  await configureTenant(service, 'tenant-a', { includedPoints: 1_000 })
  const actor = systemFor('tenant-a')
  const reservation = (await service.reserveUsage(actor, {
    id: 'reconcile-reservation', tenantId: 'tenant-a', userId: 'user-a', feature: 'ai-chat', model: 'model-a',
    estimatedInputTokens: 100, estimatedOutputTokens: 20,
  })).reservation
  const usage = {
    id: 'provider:event-a', reservationId: reservation.id, tenantId: 'tenant-a', userId: 'user-a', feature: 'ai-chat', model: 'model-a',
    inputTokens: 90, outputTokens: 10, occurredAt: '2026-08-21T03:00:00.000Z', metadata: { providerResponseModel: 'model-a' },
  }
  await assert.rejects(service.recordUsageEvent(actor, usage), /temporary ledger outage/)
  const queued = await service.recordReconciliationPending(actor, {
    ...usage, usageEventId: usage.id, id: 'reconciliation-a', lastError: 'temporary ledger outage',
  })
  assert.equal(queued.reconciliation.status, 'pending')
  assert.equal(base.inspect().usageReservations[0].status, 'pending')
  assert.equal(base.inspect().usageReservations[0].reconciliationPending, true)
  assert.equal(base.inspect().reconciliations.length, 1)

  const restarted = createBillingService({ repository: base, clock: fixedClock })
  const batch = await restarted.reconcilePendingUsageBatch(actor, { tenantId: 'tenant-a' })
  assert.equal(batch.resolved, 1)
  assert.equal(base.inspect().reconciliations[0].status, 'resolved')
  assert.equal(base.inspect().usageReservations[0].status, 'committed')
  assert.equal(base.inspect().usageEvents.length, 1)
  const retry = await restarted.reconcilePendingUsage(actor, { tenantId: 'tenant-a', id: 'reconciliation-a' })
  assert.equal(retry.duplicate, true)
  assert.equal(base.inspect().usageEvents.length, 1)
})

test('usage events tagged with metadata.actorRole roll up into actorRoles and guests axes without changing duplicate detection', async () => {
  const { repository, service } = createFixture()
  await configureTenant(service, 'tenant-a')
  const guestEvent = {
    id: 'guest-usage-1', tenantId: 'tenant-a', userId: 'USR-GUEST-1', feature: 'ai-chat', model: 'model-a',
    inputTokens: 100_000, outputTokens: 0, occurredAt: '2026-08-21T03:00:00.000Z',
    metadata: { providerResponseModel: 'model-a', actorRole: 'tenant-guest', guestGrantId: 'GST-1' },
  }
  await service.recordUsageEvent(systemFor('tenant-a'), guestEvent)
  await service.recordUsageEvent(systemFor('tenant-a'), {
    id: 'member-usage-1', tenantId: 'tenant-a', userId: 'user-a', feature: 'ai-chat', model: 'model-a',
    inputTokens: 200_000, outputTokens: 0, occurredAt: '2026-08-21T04:00:00.000Z', metadata: { actorRole: 'tenant-member' },
  })
  await service.recordUsageEvent(systemFor('tenant-a'), {
    id: 'legacy-usage-1', tenantId: 'tenant-a', userId: 'user-b', feature: 'ai-chat', model: 'model-a',
    inputTokens: 50_000, outputTokens: 0, occurredAt: '2026-08-21T05:00:00.000Z',
  })
  // 같은 id를 다시 넣으면 metadata와 무관하게 중복이다 — usageIdentity는 바뀌지 않았다.
  const retry = await service.recordUsageEvent(systemFor('tenant-a'), { ...guestEvent, metadata: { actorRole: 'tenant-member' } })
  assert.equal(retry.duplicate, true)
  assert.equal(repository.inspect().usageEvents.length, 3)

  const dashboard = await service.getDashboard(platform, { tenantId: 'tenant-a', month: '2026-08' })
  const roles = Object.fromEntries(dashboard.details.actorRoles.map((row) => [row.key, row]))
  assert.deepEqual(Object.keys(roles).sort(), ['tenant-guest', 'tenant-member', 'unknown'], '태그 없는 옛 이벤트는 unknown')
  assert.equal(roles['tenant-guest'].inputTokens, 100_000)
  assert.equal(roles['tenant-member'].inputTokens, 200_000)
  assert.equal(roles.unknown.inputTokens, 50_000)
  assert.deepEqual(dashboard.details.guests.map((row) => row.key), ['USR-GUEST-1'])
  assert.equal(dashboard.details.guests[0].eventCount, 1)
  assert.equal(dashboard.details.users.length, 3, '기존 users 축은 그대로')
})

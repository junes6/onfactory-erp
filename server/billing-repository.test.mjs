import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { newDb } from 'pg-mem'

import { createD1BillingRepository, createPostgresBillingRepository } from './billing-repository.mjs'
import { createBillingService } from './billing-service.mjs'

class SqliteD1Statement {
  constructor(database, sql, parameters = []) {
    this.database = database
    this.sql = sql
    this.parameters = parameters
  }

  bind(...parameters) { return new SqliteD1Statement(this.database, this.sql, parameters) }

  execute() {
    const statement = this.database.prepare(this.sql)
    if (/^\s*(?:SELECT|PRAGMA)\b/i.test(this.sql)) {
      return { results: statement.all(...this.parameters), success: true, meta: { changes: 0 } }
    }
    const result = statement.run(...this.parameters)
    return { results: [], success: true, meta: { changes: Number(result.changes) } }
  }

  async all() { return this.execute() }
  async run() { return this.execute() }
}

class SqliteD1Database {
  constructor(database) { this.database = database }
  prepare(sql) { return new SqliteD1Statement(this.database, sql) }
  withSession() { return this }
  async batch(statements) {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const results = statements.map((statement) => statement.execute())
      this.database.exec('COMMIT')
      return results
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }
}

const platform = { id: 'operator-a', role: 'platform-operator' }
const system = { id: 'collector-a', role: 'system', trusted: true, tenantId: 'tenant-a' }
const fixedClock = () => new Date('2026-08-21T03:00:00.000Z')
const postgresMigration = readFileSync(new URL('../supabase/migrations/20260821000000_billing.sql', import.meta.url), 'utf8')
const postgresAdditiveMigration = readFileSync(new URL('../supabase/migrations/20260821120000_billing_revenue_reconciliation.sql', import.meta.url), 'utf8')
const d1Migrations = [
  readFileSync(new URL('../drizzle/0002_billing.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../drizzle/0003_billing_revenue_reconciliation.sql', import.meta.url), 'utf8'),
].join('\n')

async function configure(service) {
  await service.upsertModelRate(platform, {
    model: 'model-a', displayName: 'Model A', currency: 'KRW',
    inputCostPerMillion: 10, outputCostPerMillion: 20,
    inputPointsPerMillion: 1_000_000, outputPointsPerMillion: 0,
    confirmed: true,
  })
  await service.upsertPlan(platform, {
    id: 'plan-a', name: 'Plan A', currency: 'KRW', monthlyPrice: 0,
    includedPoints: 100, includedStorageBytes: 0, storageOveragePerGb: 0,
    pointOveragePrice: 0,
    warningThresholdPercent: 80, confirmed: true, active: true,
  })
  await service.assignPlan(platform, { tenantId: 'tenant-a', planId: 'plan-a', limitAction: 'block' })
}

test('D1 repository persists configuration, reservations and usage across service instances', async () => {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(d1Migrations)
  const binding = new SqliteD1Database(sqlite)
  const firstService = createBillingService({ repository: createD1BillingRepository(binding), clock: fixedClock })
  await configure(firstService)

  const reservation = await firstService.reserveUsage(system, {
    id: 'reservation-a', tenantId: 'tenant-a', userId: 'user-a', feature: 'ai-chat', model: 'model-a',
    estimatedInputTokens: 20, estimatedOutputTokens: 0,
  })
  assert.equal(reservation.reservation.status, 'pending')
  await firstService.recordUsageEvent(system, {
    id: 'event-a', reservationId: reservation.reservation.id,
    tenantId: 'tenant-a', userId: 'user-a', feature: 'ai-chat', model: 'model-a',
    inputTokens: 18, outputTokens: 0, occurredAt: '2026-08-21T03:00:00.000Z',
  })

  const restartedService = createBillingService({ repository: createD1BillingRepository(binding), clock: fixedClock })
  const dashboard = await restartedService.getDashboard({ id: 'admin-a', role: 'tenant-admin', tenantId: 'tenant-a' }, { month: '2026-08' })
  assert.equal(dashboard.cards.eventCount, 1)
  assert.equal(dashboard.cards.pointsUsed, 18)
  assert.equal(dashboard.gauge.pointLimit, 100)
  assert.equal(sqlite.prepare('SELECT status FROM billing_usage_reservations WHERE id=?').get('reservation-a').status, 'committed')
  assert.equal(sqlite.prepare("SELECT revision FROM billing_repository_meta WHERE id='billing'").get().revision > 0, true)
  sqlite.close()
})

test('D1 CAS retries concurrent preflight reservations and preserves block limits across isolates', async () => {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(d1Migrations)
  const binding = new SqliteD1Database(sqlite)
  const serviceA = createBillingService({ repository: createD1BillingRepository(binding), clock: fixedClock })
  const serviceB = createBillingService({ repository: createD1BillingRepository(binding), clock: fixedClock })
  await configure(serviceA)

  const reserve = (service, id) => service.reserveUsage(system, {
    id, tenantId: 'tenant-a', userId: 'user-a', feature: 'ai-chat', model: 'model-a',
    estimatedInputTokens: 60, estimatedOutputTokens: 0,
  })
  const results = await Promise.allSettled([reserve(serviceA, 'reservation-a'), reserve(serviceB, 'reservation-b')])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason?.code === 'BILLING_LIMIT_EXCEEDED').length, 1)
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM billing_usage_reservations WHERE status='pending'").get().count, 1)
  sqlite.close()
})

test('Postgres repository persists rated usage and normalizes timestamps after a service restart', async () => {
  const database = newDb({ autoCreateForeignKeyIndices: true })
  database.public.none(`
    CREATE TABLE core_tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW());
    INSERT INTO core_tenants (id, name) VALUES ('tenant-a', 'Tenant A');
  `)
  const schemaOnly = `${postgresMigration.slice(0, postgresMigration.indexOf('CREATE OR REPLACE FUNCTION'))}\n${postgresAdditiveMigration}`
    .replace(/^BEGIN;\s*/i, '')
    .replace(/\bBEGIN;|\bCOMMIT;/gi, '')
    // pg-mem does not implement PostgreSQL's text regex operator; production Postgres does.
    .replace(/CHECK \(billing_month ~ '[^']+'\)/g, '')
  database.public.none(schemaOnly)
  const { Pool } = database.adapters.createPg()
  const pool = new Pool()
  const firstService = createBillingService({ repository: createPostgresBillingRepository(pool), clock: fixedClock })
  await configure(firstService)
  const reservation = await firstService.reserveUsage(system, {
    id: 'pg-reservation', tenantId: 'tenant-a', userId: 'user-a', feature: 'ai-chat', model: 'model-a',
    estimatedInputTokens: 25, estimatedOutputTokens: 0,
  })
  const usageInput = {
    id: 'pg-event', reservationId: reservation.reservation.id, tenantId: 'tenant-a', userId: 'user-a',
    feature: 'ai-chat', model: 'model-a', inputTokens: 20, outputTokens: 0, occurredAt: '2026-08-21T03:00:00.000Z',
  }
  await firstService.recordUsageEvent(system, usageInput)

  const restartedService = createBillingService({ repository: createPostgresBillingRepository(pool), clock: fixedClock })
  const retry = await restartedService.recordUsageEvent(system, usageInput)
  assert.equal(retry.duplicate, true)
  const dashboard = await restartedService.getDashboard({ id: 'admin-a', role: 'tenant-admin', tenantId: 'tenant-a' }, { month: '2026-08' })
  assert.equal(dashboard.cards.eventCount, 1)
  assert.equal(dashboard.cards.pointsUsed, 20)
  assert.equal((await pool.query('SELECT status FROM billing_usage_reservations WHERE id=$1', ['pg-reservation'])).rows[0].status, 'committed')
  await pool.end()
})

test('D1 and Postgres repositories persist reconciliation-pending usage across restarts', async () => {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(d1Migrations)
  const d1Repository = createD1BillingRepository(new SqliteD1Database(sqlite))
  const d1Service = createBillingService({ repository: d1Repository, clock: fixedClock })
  await configure(d1Service)
  const reservation = (await d1Service.reserveUsage(system, {
    id: 'd1-recon-res', tenantId: 'tenant-a', userId: 'user-a', feature: 'ai-chat', model: 'model-a',
    estimatedInputTokens: 10, estimatedOutputTokens: 0,
  })).reservation
  await d1Service.recordReconciliationPending(system, {
    id: 'd1-recon', usageEventId: 'd1-event', reservationId: reservation.id, tenantId: 'tenant-a', userId: 'user-a',
    feature: 'ai-chat', model: 'model-a', inputTokens: 9, outputTokens: 0, occurredAt: '2026-08-21T03:00:00.000Z',
    lastError: 'ledger unavailable',
  })
  const d1Restarted = createBillingService({ repository: createD1BillingRepository(new SqliteD1Database(sqlite)), clock: fixedClock })
  await d1Restarted.reconcilePendingUsage(system, { tenantId: 'tenant-a', id: 'd1-recon' })
  assert.equal(sqlite.prepare('SELECT status FROM billing_reconciliation_queue WHERE id=?').get('d1-recon').status, 'resolved')
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM billing_usage_events WHERE id=?').get('d1-event').count, 1)
  sqlite.close()

  const database = newDb({ autoCreateForeignKeyIndices: true })
  database.public.none(`
    CREATE TABLE core_tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW());
    INSERT INTO core_tenants (id, name) VALUES ('tenant-a', 'Tenant A');
  `)
  const schemaOnly = `${postgresMigration.slice(0, postgresMigration.indexOf('CREATE OR REPLACE FUNCTION'))}\n${postgresAdditiveMigration}`
    .replace(/^BEGIN;\s*/i, '').replace(/\bBEGIN;|\bCOMMIT;/gi, '').replace(/CHECK \(billing_month ~ '[^']+'\)/g, '')
  database.public.none(schemaOnly)
  const { Pool } = database.adapters.createPg()
  const pool = new Pool()
  const pgService = createBillingService({ repository: createPostgresBillingRepository(pool), clock: fixedClock })
  await configure(pgService)
  const pgReservation = (await pgService.reserveUsage(system, {
    id: 'pg-recon-res', tenantId: 'tenant-a', userId: 'user-a', feature: 'ai-chat', model: 'model-a',
    estimatedInputTokens: 10, estimatedOutputTokens: 0,
  })).reservation
  await pgService.recordReconciliationPending(system, {
    id: 'pg-recon', usageEventId: 'pg-recon-event', reservationId: pgReservation.id, tenantId: 'tenant-a', userId: 'user-a',
    feature: 'ai-chat', model: 'model-a', inputTokens: 8, outputTokens: 0, occurredAt: '2026-08-21T03:00:00.000Z',
    lastError: 'ledger unavailable',
  })
  const pgRestarted = createBillingService({ repository: createPostgresBillingRepository(pool), clock: fixedClock })
  await pgRestarted.reconcilePendingUsage(system, { tenantId: 'tenant-a', id: 'pg-recon' })
  assert.equal((await pool.query('SELECT status FROM billing_reconciliation_queue WHERE id=$1', ['pg-recon'])).rows[0].status, 'resolved')
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM billing_usage_events WHERE id=$1', ['pg-recon-event'])).rows[0].count, 1)
  await pool.end()
})

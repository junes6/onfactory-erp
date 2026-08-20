import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

const d1Migration = readFileSync(new URL('../drizzle/0002_billing.sql', import.meta.url), 'utf8')
const d1AdditiveMigration = readFileSync(new URL('../drizzle/0003_billing_revenue_reconciliation.sql', import.meta.url), 'utf8')
const postgresMigration = readFileSync(new URL('../supabase/migrations/20260821000000_billing.sql', import.meta.url), 'utf8')
const postgresAdditiveMigration = readFileSync(new URL('../supabase/migrations/20260821120000_billing_revenue_reconciliation.sql', import.meta.url), 'utf8')

const postgresBillingTables = [
  'billing_model_rates',
  'billing_plans',
  'billing_tenant_assignments',
  'billing_usage_reservations',
  'billing_usage_events',
  'billing_reconciliation_queue',
  'billing_storage_daily_snapshots',
  'billing_monthly_snapshots',
  'billing_audit_log',
]
const d1BillingTables = ['billing_repository_meta', ...postgresBillingTables]

test('Sites D1 billing migration applies and enforces immutable monthly snapshots', () => {
  const database = new DatabaseSync(':memory:')
  database.exec(`${d1Migration}\n${d1AdditiveMigration}`)
  const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'billing_%' ORDER BY name").all().map((row) => row.name)
  assert.deepEqual(tables, [...d1BillingTables].sort())

  database.prepare(`
    INSERT INTO billing_monthly_snapshots (
      tenant_id, billing_month, currency, total_cost, points_used, storage_bytes,
      summary, details, finalized_by, finalized_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('tenant-a', '2026-07', 'KRW', 0, 0, 0, '{}', '{}', 'operator-a', '2026-08-01T00:00:00.000Z')

  assert.throws(
    () => database.prepare('UPDATE billing_monthly_snapshots SET total_cost = ? WHERE tenant_id = ? AND billing_month = ?').run(1, 'tenant-a', '2026-07'),
    /immutable/,
  )
  assert.throws(
    () => database.prepare('DELETE FROM billing_monthly_snapshots WHERE tenant_id = ? AND billing_month = ?').run('tenant-a', '2026-07'),
    /immutable/,
  )
  database.close()
})

test('Sites additive billing migration upgrades an existing 0002 database without losing rows', () => {
  const database = new DatabaseSync(':memory:')
  database.exec(d1Migration)
  database.prepare(`INSERT INTO billing_plans (
    id,name,currency,monthly_price,included_points,included_storage_bytes,storage_overage_per_gb,
    warning_threshold_percent,confirmed,active,updated_by,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'legacy-plan','Legacy','KRW',10,100,1_000,2,80,1,1,'operator-a','2026-08-20T00:00:00.000Z','2026-08-20T00:00:00.000Z',
  )
  database.exec(d1AdditiveMigration)
  const upgraded = database.prepare('SELECT id,monthly_price,point_overage_price FROM billing_plans WHERE id=?').get('legacy-plan')
  assert.equal(upgraded.id, 'legacy-plan')
  assert.equal(upgraded.monthly_price, 10)
  assert.equal(upgraded.point_overage_price, 0)
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='table' AND name='billing_reconciliation_queue'").get().count, 1)
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('billing_usage_reservations') WHERE name='reconciliation_pending'").get().count, 1)
  database.close()
})

test('Postgres billing draft contains normalized ledgers, tenant indexes and immutable triggers', () => {
  const combinedMigration = `${postgresMigration}\n${postgresAdditiveMigration}`
  for (const table of postgresBillingTables) assert.match(combinedMigration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`))
  assert.match(postgresMigration, /PRIMARY KEY \(tenant_id, snapshot_date\)/)
  assert.match(postgresMigration, /PRIMARY KEY \(tenant_id, billing_month\)/)
  assert.match(postgresMigration, /idx_billing_usage_tenant_month/)
  assert.match(combinedMigration, /idx_billing_reconciliation_pending/)
  assert.match(postgresAdditiveMigration, /ADD COLUMN IF NOT EXISTS point_overage_price/)
  assert.match(postgresAdditiveMigration, /ADD COLUMN IF NOT EXISTS revenue[\s\S]*ADD COLUMN IF NOT EXISTS api_cost[\s\S]*ADD COLUMN IF NOT EXISTS margin/)
  assert.match(postgresMigration, /billing_monthly_snapshots_immutable/)
  assert.match(postgresMigration, /billing_usage_events_immutable/)
  assert.doesNotMatch(postgresMigration, /DEFAULT\s+(?!0\b|80\b|TRUE\b|FALSE\b|'warn'\b|'\{\}'::JSONB\b|NOW\(\))\d+(?:\.\d+)?/i)
})

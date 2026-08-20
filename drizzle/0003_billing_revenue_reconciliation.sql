-- Additive billing v2 migration. Keep 0002 unchanged for databases where it
-- has already been applied; D1 runs each numbered migration exactly once.
ALTER TABLE billing_plans ADD COLUMN point_overage_price REAL NOT NULL DEFAULT 0 CHECK (point_overage_price >= 0);

ALTER TABLE billing_usage_reservations ADD COLUMN reconciliation_pending INTEGER NOT NULL DEFAULT 0 CHECK (reconciliation_pending IN (0, 1));

ALTER TABLE billing_monthly_snapshots ADD COLUMN revenue REAL NOT NULL DEFAULT 0 CHECK (revenue >= 0);
ALTER TABLE billing_monthly_snapshots ADD COLUMN api_cost REAL NOT NULL DEFAULT 0 CHECK (api_cost >= 0);
ALTER TABLE billing_monthly_snapshots ADD COLUMN margin REAL NOT NULL DEFAULT 0;
ALTER TABLE billing_monthly_snapshots ADD COLUMN point_overage_revenue REAL NOT NULL DEFAULT 0 CHECK (point_overage_revenue >= 0);
ALTER TABLE billing_monthly_snapshots ADD COLUMN storage_overage_revenue REAL NOT NULL DEFAULT 0 CHECK (storage_overage_revenue >= 0);

CREATE TABLE IF NOT EXISTS billing_reconciliation_queue (
  id TEXT PRIMARY KEY NOT NULL,
  usage_event_id TEXT NOT NULL UNIQUE,
  reservation_id TEXT NOT NULL REFERENCES billing_usage_reservations(id) ON DELETE RESTRICT,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  model_key TEXT NOT NULL,
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  duration_ms INTEGER CHECK (duration_ms >= 0),
  occurred_at TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT NOT NULL DEFAULT '',
  next_attempt_at TEXT,
  recorded_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_billing_reconciliation_pending
ON billing_reconciliation_queue (status, next_attempt_at, tenant_id);

PRAGMA optimize;

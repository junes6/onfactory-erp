BEGIN;

ALTER TABLE billing_plans
  ADD COLUMN IF NOT EXISTS point_overage_price NUMERIC(24, 6) NOT NULL DEFAULT 0 CHECK (point_overage_price >= 0);

ALTER TABLE billing_usage_reservations
  ADD COLUMN IF NOT EXISTS reconciliation_pending BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE billing_monthly_snapshots
  ADD COLUMN IF NOT EXISTS revenue NUMERIC(24, 6) NOT NULL DEFAULT 0 CHECK (revenue >= 0),
  ADD COLUMN IF NOT EXISTS api_cost NUMERIC(24, 6) NOT NULL DEFAULT 0 CHECK (api_cost >= 0),
  ADD COLUMN IF NOT EXISTS margin NUMERIC(24, 6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS point_overage_revenue NUMERIC(24, 6) NOT NULL DEFAULT 0 CHECK (point_overage_revenue >= 0),
  ADD COLUMN IF NOT EXISTS storage_overage_revenue NUMERIC(24, 6) NOT NULL DEFAULT 0 CHECK (storage_overage_revenue >= 0);

CREATE TABLE IF NOT EXISTS billing_reconciliation_queue (
  id TEXT PRIMARY KEY,
  usage_event_id TEXT NOT NULL UNIQUE,
  reservation_id TEXT NOT NULL REFERENCES billing_usage_reservations(id) ON DELETE RESTRICT,
  tenant_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  model_key TEXT NOT NULL,
  input_tokens BIGINT NOT NULL CHECK (input_tokens >= 0),
  output_tokens BIGINT NOT NULL CHECK (output_tokens >= 0),
  duration_ms BIGINT CHECK (duration_ms >= 0),
  occurred_at TIMESTAMPTZ NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT NOT NULL DEFAULT '',
  next_attempt_at TIMESTAMPTZ,
  recorded_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_billing_reconciliation_pending
ON billing_reconciliation_queue (status, next_attempt_at, tenant_id);

INSERT INTO schema_migrations (id)
VALUES ('20260821_billing_revenue_reconciliation_v2')
ON CONFLICT (id) DO NOTHING;

COMMIT;

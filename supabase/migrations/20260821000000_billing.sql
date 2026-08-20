BEGIN;

CREATE TABLE IF NOT EXISTS billing_model_rates (
  model_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  currency TEXT NOT NULL,
  input_cost_per_million NUMERIC(24, 6) NOT NULL DEFAULT 0 CHECK (input_cost_per_million >= 0),
  output_cost_per_million NUMERIC(24, 6) NOT NULL DEFAULT 0 CHECK (output_cost_per_million >= 0),
  input_points_per_million NUMERIC(24, 6) NOT NULL DEFAULT 0 CHECK (input_points_per_million >= 0),
  output_points_per_million NUMERIC(24, 6) NOT NULL DEFAULT 0 CHECK (output_points_per_million >= 0),
  confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS billing_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  monthly_price NUMERIC(24, 6) NOT NULL DEFAULT 0 CHECK (monthly_price >= 0),
  included_points NUMERIC(24, 6) NOT NULL DEFAULT 0 CHECK (included_points >= 0),
  included_storage_bytes BIGINT NOT NULL DEFAULT 0 CHECK (included_storage_bytes >= 0),
  storage_overage_per_gb NUMERIC(24, 6) NOT NULL DEFAULT 0 CHECK (storage_overage_per_gb >= 0),
  warning_threshold_percent NUMERIC(7, 4) NOT NULL DEFAULT 80 CHECK (warning_threshold_percent BETWEEN 0 AND 100),
  confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS billing_tenant_assignments (
  tenant_id TEXT PRIMARY KEY REFERENCES core_tenants(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES billing_plans(id),
  point_limit_override NUMERIC(24, 6) CHECK (point_limit_override >= 0),
  limit_action TEXT NOT NULL DEFAULT 'warn' CHECK (limit_action IN ('warn', 'block')),
  assigned_by TEXT NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS billing_usage_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  model_key TEXT NOT NULL,
  input_tokens BIGINT NOT NULL CHECK (input_tokens >= 0),
  output_tokens BIGINT NOT NULL CHECK (output_tokens >= 0),
  duration_ms BIGINT CHECK (duration_ms >= 0),
  occurred_at TIMESTAMPTZ NOT NULL,
  billing_month CHAR(7) NOT NULL CHECK (billing_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  currency TEXT NOT NULL,
  input_cost NUMERIC(24, 6) NOT NULL DEFAULT 0 CHECK (input_cost >= 0),
  output_cost NUMERIC(24, 6) NOT NULL DEFAULT 0 CHECK (output_cost >= 0),
  total_cost NUMERIC(24, 6) NOT NULL DEFAULT 0 CHECK (total_cost >= 0),
  input_points NUMERIC(24, 6) NOT NULL DEFAULT 0 CHECK (input_points >= 0),
  output_points NUMERIC(24, 6) NOT NULL DEFAULT 0 CHECK (output_points >= 0),
  total_points NUMERIC(24, 6) NOT NULL DEFAULT 0 CHECK (total_points >= 0),
  rate_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  rate_snapshot JSONB NOT NULL,
  limit_decision JSONB NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  recorded_by TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reservation_id TEXT
);

CREATE TABLE IF NOT EXISTS billing_usage_reservations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  model_key TEXT NOT NULL,
  estimated_input_tokens BIGINT NOT NULL CHECK (estimated_input_tokens >= 0),
  estimated_output_tokens BIGINT NOT NULL CHECK (estimated_output_tokens >= 0),
  estimated_points NUMERIC(24, 6) NOT NULL DEFAULT 0 CHECK (estimated_points >= 0),
  estimated_cost NUMERIC(24, 6) NOT NULL DEFAULT 0 CHECK (estimated_cost >= 0),
  currency TEXT NOT NULL,
  billing_month CHAR(7) NOT NULL CHECK (billing_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  occurred_at TIMESTAMPTZ NOT NULL,
  rate_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  rate_snapshot JSONB NOT NULL,
  limit_decision JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'released')),
  usage_event_id TEXT REFERENCES billing_usage_events(id) ON DELETE RESTRICT,
  reserved_by TEXT NOT NULL,
  reserved_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  committed_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  released_by TEXT
);

ALTER TABLE billing_usage_events
  ADD CONSTRAINT billing_usage_events_reservation_fk
  FOREIGN KEY (reservation_id) REFERENCES billing_usage_reservations(id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS billing_storage_daily_snapshots (
  tenant_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE RESTRICT,
  snapshot_date DATE NOT NULL,
  bytes BIGINT NOT NULL CHECK (bytes >= 0),
  object_count BIGINT NOT NULL CHECK (object_count >= 0),
  measured_at TIMESTAMPTZ NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, snapshot_date)
);

CREATE TABLE IF NOT EXISTS billing_monthly_snapshots (
  tenant_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE RESTRICT,
  billing_month CHAR(7) NOT NULL CHECK (billing_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  currency TEXT,
  total_cost NUMERIC(24, 6) NOT NULL DEFAULT 0 CHECK (total_cost >= 0),
  points_used NUMERIC(24, 6) NOT NULL DEFAULT 0 CHECK (points_used >= 0),
  storage_bytes BIGINT NOT NULL DEFAULT 0 CHECK (storage_bytes >= 0),
  summary JSONB NOT NULL,
  details JSONB NOT NULL,
  assignment_snapshot JSONB,
  plan_snapshot JSONB,
  finalized_by TEXT NOT NULL,
  finalized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, billing_month)
);

CREATE TABLE IF NOT EXISTS billing_audit_log (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES core_tenants(id) ON DELETE SET NULL,
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_billing_assignments_plan ON billing_tenant_assignments (plan_id, tenant_id);
CREATE INDEX IF NOT EXISTS idx_billing_usage_tenant_month ON billing_usage_events (tenant_id, billing_month, occurred_at);
CREATE INDEX IF NOT EXISTS idx_billing_usage_tenant_user_month ON billing_usage_events (tenant_id, user_id, billing_month);
CREATE INDEX IF NOT EXISTS idx_billing_usage_model_month ON billing_usage_events (model_key, billing_month, tenant_id);
CREATE INDEX IF NOT EXISTS idx_billing_reservations_active ON billing_usage_reservations (tenant_id, billing_month, expires_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_billing_monthly_month ON billing_monthly_snapshots (billing_month, tenant_id);
CREATE INDEX IF NOT EXISTS idx_billing_audit_target ON billing_audit_log (target_type, target_id, created_at);

CREATE OR REPLACE FUNCTION prevent_billing_immutable_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'billing ledger rows are immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS billing_usage_events_immutable ON billing_usage_events;
CREATE TRIGGER billing_usage_events_immutable
BEFORE UPDATE OR DELETE ON billing_usage_events
FOR EACH ROW EXECUTE FUNCTION prevent_billing_immutable_mutation();

DROP TRIGGER IF EXISTS billing_storage_snapshots_immutable ON billing_storage_daily_snapshots;
CREATE TRIGGER billing_storage_snapshots_immutable
BEFORE UPDATE OR DELETE ON billing_storage_daily_snapshots
FOR EACH ROW EXECUTE FUNCTION prevent_billing_immutable_mutation();

DROP TRIGGER IF EXISTS billing_monthly_snapshots_immutable ON billing_monthly_snapshots;
CREATE TRIGGER billing_monthly_snapshots_immutable
BEFORE UPDATE OR DELETE ON billing_monthly_snapshots
FOR EACH ROW EXECUTE FUNCTION prevent_billing_immutable_mutation();

INSERT INTO schema_migrations (id)
VALUES ('20260821_billing_v1')
ON CONFLICT (id) DO NOTHING;

COMMIT;

CREATE TABLE IF NOT EXISTS billing_repository_meta (
  id TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  write_owner TEXT,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO billing_repository_meta (id, revision, write_owner, updated_at)
VALUES ('billing', 0, NULL, '1970-01-01T00:00:00.000Z');

CREATE TABLE IF NOT EXISTS billing_model_rates (
  model_key TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL,
  currency TEXT NOT NULL,
  input_cost_per_million REAL NOT NULL DEFAULT 0 CHECK (input_cost_per_million >= 0),
  output_cost_per_million REAL NOT NULL DEFAULT 0 CHECK (output_cost_per_million >= 0),
  input_points_per_million REAL NOT NULL DEFAULT 0 CHECK (input_points_per_million >= 0),
  output_points_per_million REAL NOT NULL DEFAULT 0 CHECK (output_points_per_million >= 0),
  confirmed INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_plans (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  monthly_price REAL NOT NULL DEFAULT 0 CHECK (monthly_price >= 0),
  included_points REAL NOT NULL DEFAULT 0 CHECK (included_points >= 0),
  included_storage_bytes INTEGER NOT NULL DEFAULT 0 CHECK (included_storage_bytes >= 0),
  storage_overage_per_gb REAL NOT NULL DEFAULT 0 CHECK (storage_overage_per_gb >= 0),
  warning_threshold_percent REAL NOT NULL DEFAULT 80 CHECK (warning_threshold_percent BETWEEN 0 AND 100),
  confirmed INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_tenant_assignments (
  tenant_id TEXT PRIMARY KEY NOT NULL,
  plan_id TEXT NOT NULL REFERENCES billing_plans(id),
  point_limit_override REAL CHECK (point_limit_override >= 0),
  limit_action TEXT NOT NULL DEFAULT 'warn' CHECK (limit_action IN ('warn', 'block')),
  assigned_by TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_usage_events (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  model_key TEXT NOT NULL,
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  duration_ms INTEGER CHECK (duration_ms >= 0),
  occurred_at TEXT NOT NULL,
  billing_month TEXT NOT NULL CHECK (length(billing_month) = 7),
  currency TEXT NOT NULL,
  input_cost REAL NOT NULL DEFAULT 0 CHECK (input_cost >= 0),
  output_cost REAL NOT NULL DEFAULT 0 CHECK (output_cost >= 0),
  total_cost REAL NOT NULL DEFAULT 0 CHECK (total_cost >= 0),
  input_points REAL NOT NULL DEFAULT 0 CHECK (input_points >= 0),
  output_points REAL NOT NULL DEFAULT 0 CHECK (output_points >= 0),
  total_points REAL NOT NULL DEFAULT 0 CHECK (total_points >= 0),
  rate_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (rate_confirmed IN (0, 1)),
  rate_snapshot TEXT NOT NULL,
  limit_decision TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  reservation_id TEXT
);

CREATE TABLE IF NOT EXISTS billing_usage_reservations (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  model_key TEXT NOT NULL,
  estimated_input_tokens INTEGER NOT NULL CHECK (estimated_input_tokens >= 0),
  estimated_output_tokens INTEGER NOT NULL CHECK (estimated_output_tokens >= 0),
  estimated_points REAL NOT NULL DEFAULT 0 CHECK (estimated_points >= 0),
  estimated_cost REAL NOT NULL DEFAULT 0 CHECK (estimated_cost >= 0),
  currency TEXT NOT NULL,
  billing_month TEXT NOT NULL CHECK (length(billing_month) = 7),
  occurred_at TEXT NOT NULL,
  rate_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (rate_confirmed IN (0, 1)),
  rate_snapshot TEXT NOT NULL,
  limit_decision TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'released')),
  usage_event_id TEXT REFERENCES billing_usage_events(id),
  reserved_by TEXT NOT NULL,
  reserved_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  committed_at TEXT,
  released_at TEXT,
  released_by TEXT
);

CREATE TABLE IF NOT EXISTS billing_storage_daily_snapshots (
  tenant_id TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  object_count INTEGER NOT NULL CHECK (object_count >= 0),
  measured_at TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, snapshot_date)
);

CREATE TABLE IF NOT EXISTS billing_monthly_snapshots (
  tenant_id TEXT NOT NULL,
  billing_month TEXT NOT NULL CHECK (length(billing_month) = 7),
  currency TEXT,
  total_cost REAL NOT NULL DEFAULT 0 CHECK (total_cost >= 0),
  points_used REAL NOT NULL DEFAULT 0 CHECK (points_used >= 0),
  storage_bytes INTEGER NOT NULL DEFAULT 0 CHECK (storage_bytes >= 0),
  summary TEXT NOT NULL,
  details TEXT NOT NULL,
  assignment_snapshot TEXT,
  plan_snapshot TEXT,
  finalized_by TEXT NOT NULL,
  finalized_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, billing_month)
);

CREATE TABLE IF NOT EXISTS billing_audit_log (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT,
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_billing_assignments_plan
ON billing_tenant_assignments (plan_id, tenant_id);

CREATE INDEX IF NOT EXISTS idx_billing_usage_tenant_month
ON billing_usage_events (tenant_id, billing_month, occurred_at);

CREATE INDEX IF NOT EXISTS idx_billing_usage_tenant_user_month
ON billing_usage_events (tenant_id, user_id, billing_month);

CREATE INDEX IF NOT EXISTS idx_billing_usage_model_month
ON billing_usage_events (model_key, billing_month, tenant_id);

CREATE INDEX IF NOT EXISTS idx_billing_reservations_active
ON billing_usage_reservations (tenant_id, billing_month, expires_at)
WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_billing_monthly_month
ON billing_monthly_snapshots (billing_month, tenant_id);

CREATE INDEX IF NOT EXISTS idx_billing_audit_target
ON billing_audit_log (target_type, target_id, created_at);

CREATE TRIGGER IF NOT EXISTS billing_usage_events_no_update
BEFORE UPDATE ON billing_usage_events
BEGIN
  SELECT RAISE(ABORT, 'billing usage events are immutable');
END;

CREATE TRIGGER IF NOT EXISTS billing_usage_events_no_delete
BEFORE DELETE ON billing_usage_events
BEGIN
  SELECT RAISE(ABORT, 'billing usage events are immutable');
END;

CREATE TRIGGER IF NOT EXISTS billing_storage_snapshots_no_update
BEFORE UPDATE ON billing_storage_daily_snapshots
BEGIN
  SELECT RAISE(ABORT, 'billing storage snapshots are immutable');
END;

CREATE TRIGGER IF NOT EXISTS billing_storage_snapshots_no_delete
BEFORE DELETE ON billing_storage_daily_snapshots
BEGIN
  SELECT RAISE(ABORT, 'billing storage snapshots are immutable');
END;

CREATE TRIGGER IF NOT EXISTS billing_monthly_snapshots_no_update
BEFORE UPDATE ON billing_monthly_snapshots
BEGIN
  SELECT RAISE(ABORT, 'billing monthly snapshots are immutable');
END;

CREATE TRIGGER IF NOT EXISTS billing_monthly_snapshots_no_delete
BEFORE DELETE ON billing_monthly_snapshots
BEGIN
  SELECT RAISE(ABORT, 'billing monthly snapshots are immutable');
END;

PRAGMA optimize;

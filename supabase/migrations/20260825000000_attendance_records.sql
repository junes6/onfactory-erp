-- P6 attendance storage. Additive and idempotent: existing tenant data is untouched.
CREATE TABLE IF NOT EXISTS attendance_records (
  id TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  source_updated_at TIMESTAMPTZ,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  created_by TEXT,
  PRIMARY KEY (org_id, id)
);

CREATE INDEX IF NOT EXISTS idx_attendance_records_active
ON attendance_records (org_id, position)
WHERE deleted_at IS NULL;

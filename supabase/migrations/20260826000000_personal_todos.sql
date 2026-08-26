-- P7 personal To-do storage. Additive and idempotent; formal work-item state remains untouched.
CREATE TABLE IF NOT EXISTS personal_todos (
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

CREATE INDEX IF NOT EXISTS idx_personal_todos_active
ON personal_todos (org_id, (payload->>'ownerId'), position)
WHERE deleted_at IS NULL;

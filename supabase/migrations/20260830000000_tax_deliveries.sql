-- P11 세무사 전달 이력. 압축본을 만든 시점에 서버가 기록하며, 기존 세무 데이터는 건드리지 않는다.
CREATE TABLE IF NOT EXISTS tax_deliveries (
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

CREATE INDEX IF NOT EXISTS idx_tax_deliveries_recent
ON tax_deliveries (org_id, (payload->>'deliveredAt') DESC)
WHERE deleted_at IS NULL;

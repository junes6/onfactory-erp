-- R11-G 외부 기회 신호. 외부 워커가 인제스트 API로 밀어넣은 결과와 테넌트 감시 설정.
CREATE TABLE IF NOT EXISTS opportunities (
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

CREATE TABLE IF NOT EXISTS opportunity_settings (
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

-- 같은 공고번호는 테넌트당 한 번만 남는다 (인제스트 중복 방지의 마지막 방어선).
CREATE UNIQUE INDEX IF NOT EXISTS idx_opportunities_notice
ON opportunities (org_id, (payload->>'key'))
WHERE deleted_at IS NULL;

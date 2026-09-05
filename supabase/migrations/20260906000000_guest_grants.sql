-- A절 외부 게스트 초대: 게스트 권한(grant) 테이블.
-- 계정 자체는 core_accounts(role='tenant-guest')에 두고, "어느 프로젝트까지 보이는가"와
-- 초대 링크의 수명은 이 테이블이 갖는다. payload(JSONB)가 진실이고 나머지 컬럼은
-- 인덱스·RLS 판정용 사본이다. 단, 초대 토큰 해시와 토큰 발급·만료 시각은 payload에
-- 넣지 않는다 — 서버가 payload를 저장할 때 민감 필드(token*)를 지우기 때문에 컬럼에 따로 둔다.

-- 선행조건: R7 프로젝트 공간 테이블. db/postgres-schema.sql에는 있었지만 supabase 마이그레이션 체인에는
-- 빠져 있었다. 다음 마이그레이션(게스트 RLS)이 이 두 테이블에 정책을 걸므로, 체인만으로 적용하는
-- 환경(Supabase)에서 "relation does not exist"로 전체가 실패하지 않게 여기서 먼저 만든다.
-- 정의는 db/postgres-schema.sql의 project_spaces·project_posts와 같다.
CREATE TABLE IF NOT EXISTS project_spaces (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);

CREATE TABLE IF NOT EXISTS project_posts (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);

CREATE TABLE IF NOT EXISTS guest_grants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES core_tenants(id),
  account_id TEXT NOT NULL REFERENCES core_accounts(id),
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'invited',
  project_ids TEXT[] NOT NULL DEFAULT '{}',
  token_hash TEXT,
  token_issued_at TIMESTAMPTZ,
  token_expires_at TIMESTAMPTZ,
  access_expires_at TIMESTAMPTZ,
  invited_by TEXT,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

-- 관리자 화면은 항상 "이 테넌트의 게스트"를 상태별로 본다.
CREATE INDEX IF NOT EXISTS idx_guest_grants_tenant ON guest_grants (tenant_id, status);
-- 한 게스트 계정에는 살아 있는 grant가 하나만 있어야 한다(해지된 것은 감사 추적용으로 남는다).
CREATE UNIQUE INDEX IF NOT EXISTS idx_guest_grants_account ON guest_grants (account_id) WHERE deleted_at IS NULL;

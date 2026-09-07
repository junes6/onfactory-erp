-- R16-G: Flow 파일함 벌크 이관 — 세션·청크 한 테이블, 재사용 매핑 규칙 한 테이블.
--
-- 베이스라인(db/postgres-schema.sql)과 이 체인 파일에 같은 내용을 함께 넣는다.
-- 한쪽만 넣으면 applySchema가 베이스라인만 읽는 탓에 로컬 pg-mem 테스트는 통과하면서
-- 실제 Supabase에서만 터진다(ai_conversations가 한동안 그 상태였다).
--
-- 게스트 정책은 만들지 않는다: 게스트는 파일을 올릴 수 있어도 이관 세션은 직원의 것이고,
-- 세션 행에는 회사의 원본 폴더 구조가 통째로 들어 있다. tenant_admin 정책도 두지 않는다 —
-- 관리자가 볼 것은 라우트가 가려서 주는 보고서이지 행 자체가 아니다.
--
-- 정책 본문에 세미콜론을 넣지 않고 한 문장을 한 줄에 둔다 — postgres-store.mjs의
-- withoutPgMemUnsupportedRls가 이 형식만 걷어낼 수 있다.

CREATE TABLE IF NOT EXISTS bulk_imports (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);

CREATE TABLE IF NOT EXISTS bulk_import_rules (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);

CREATE INDEX IF NOT EXISTS idx_bulk_imports_active ON bulk_imports (org_id, (payload ->> 'sessionId'), position) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_bulk_import_rules_active ON bulk_import_rules (org_id, (payload ->> 'name')) WHERE deleted_at IS NULL;

ALTER TABLE bulk_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE bulk_imports FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bulk_imports_service ON bulk_imports;
CREATE POLICY bulk_imports_service ON bulk_imports USING (current_setting('app.role', TRUE) = 'service') WITH CHECK (current_setting('app.role', TRUE) = 'service');

ALTER TABLE bulk_import_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE bulk_import_rules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bulk_import_rules_service ON bulk_import_rules;
CREATE POLICY bulk_import_rules_service ON bulk_import_rules USING (current_setting('app.role', TRUE) = 'service') WITH CHECK (current_setting('app.role', TRUE) = 'service');

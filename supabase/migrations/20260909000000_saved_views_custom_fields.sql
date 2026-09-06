-- R16-K: 저장된 보기 + 업무 커스텀 필드 정의.
--
-- 베이스라인(db/postgres-schema.sql)과 이 체인 파일에 같은 내용을 함께 넣는다.
-- 한쪽만 넣으면 applySchema가 베이스라인만 읽는 탓에 로컬 pg-mem 테스트는 통과하면서
-- 실제 Supabase에서만 터진다(ai_conversations가 한동안 그 상태였다).
--
-- 게스트 정책은 만들지 않는다: 게스트는 이 두 테이블을 읽지 않는다.
-- 보기 이름과 filters.ownerIds·projectIds는 사람·프로젝트의 열거원이고, 필드 라벨은 회사의 내부 어휘다.
-- 정책 본문에 세미콜론을 넣지 않고 한 문장을 한 줄에 둔다 — postgres-store.mjs의
-- withoutPgMemUnsupportedRls가 이 형식만 걷어낼 수 있다.

CREATE TABLE IF NOT EXISTS saved_views (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);

CREATE TABLE IF NOT EXISTS custom_fields (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);

CREATE INDEX IF NOT EXISTS idx_saved_views_active ON saved_views (org_id, (payload ->> 'ownerId'), position) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_custom_fields_active ON custom_fields (org_id, (payload ->> 'surface'), position) WHERE deleted_at IS NULL;

ALTER TABLE saved_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_views FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saved_views_service ON saved_views;
CREATE POLICY saved_views_service ON saved_views USING (current_setting('app.role', TRUE) = 'service') WITH CHECK (current_setting('app.role', TRUE) = 'service');

ALTER TABLE custom_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_fields FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS custom_fields_service ON custom_fields;
CREATE POLICY custom_fields_service ON custom_fields USING (current_setting('app.role', TRUE) = 'service') WITH CHECK (current_setting('app.role', TRUE) = 'service');

-- R16-E: 구글 캘린더 연결 + 항목별 동기화 링크.
--
-- 베이스라인(db/postgres-schema.sql)과 이 체인 파일에 같은 내용을 함께 넣는다.
-- 한쪽만 넣으면 applySchema가 베이스라인만 읽는 탓에 로컬 pg-mem 테스트는 통과하면서
-- 실제 Supabase에서만 터진다(ai_conversations가 한동안 그 상태였다).
--
-- 게스트 정책은 만들지 않는다: 게스트는 이 두 테이블을 읽지 않고, calendar_connections에는
-- 봉인된 OAuth 토큰이 들어 있다. tenant_admin 정책도 두지 않는다 — 관리자도 토큰 행을
-- 직접 SELECT할 이유가 없고, 상태는 /overview 라우트가 가려서 준다.
--
-- 정책 본문에 세미콜론을 넣지 않고 한 문장을 한 줄에 둔다 — postgres-store.mjs의
-- withoutPgMemUnsupportedRls가 이 형식만 걷어낼 수 있다.

CREATE TABLE IF NOT EXISTS calendar_connections (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);

CREATE TABLE IF NOT EXISTS calendar_sync_links (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);

CREATE INDEX IF NOT EXISTS idx_calendar_connections_active ON calendar_connections (org_id, (payload ->> 'accountId')) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_calendar_sync_links_active ON calendar_sync_links (org_id, (payload ->> 'accountId'), (payload ->> 'eventId')) WHERE deleted_at IS NULL;

ALTER TABLE calendar_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_connections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS calendar_connections_service ON calendar_connections;
CREATE POLICY calendar_connections_service ON calendar_connections USING (current_setting('app.role', TRUE) = 'service') WITH CHECK (current_setting('app.role', TRUE) = 'service');

ALTER TABLE calendar_sync_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_sync_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS calendar_sync_links_service ON calendar_sync_links;
CREATE POLICY calendar_sync_links_service ON calendar_sync_links USING (current_setting('app.role', TRUE) = 'service') WITH CHECK (current_setting('app.role', TRUE) = 'service');

-- R16-B: 프로젝트 템플릿. additive · idempotent.
-- 다른 워크스페이스 키와 같은 JSONB 행 모양(org_id + payload + 공통 컬럼)이다.
-- 본문에는 역할 문자열과 상대 마감일만 들어간다 — 실명·계정 id는 저장하지 않는다.
CREATE TABLE IF NOT EXISTS project_templates (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);

-- 목록은 기본 템플릿 먼저, 그다음 위치 순으로 본다.
CREATE INDEX IF NOT EXISTS idx_project_templates_active ON project_templates (org_id, (payload ->> 'origin'), position) WHERE deleted_at IS NULL;

-- 게스트 정책 없음(게스트는 이 테이블을 읽지 않는다). 서비스 컨텍스트만 통과.
ALTER TABLE project_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_templates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS project_templates_service ON project_templates;
CREATE POLICY project_templates_service ON project_templates USING (current_setting('app.role', TRUE) = 'service') WITH CHECK (current_setting('app.role', TRUE) = 'service');

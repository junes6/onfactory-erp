-- 검토 자료(AI가 만든 HTML 회의 자료). 행에는 제목·판 목록·항목 계보만 있다 — 원본은 자료실 문서(items),
-- 그리기 사본·항목·그림은 파일 저장소에 있다. 의견·찬반·결정은 추가만 하는 기록으로 review_feedback에 따로 둔다.
-- 서비스 컨텍스트만 통과한다. 게스트 정책은 만들지 않는다(1차에서 게스트는 검토 자료에 들어오지 않는다).
CREATE TABLE IF NOT EXISTS review_materials (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);

CREATE TABLE IF NOT EXISTS review_feedback (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);

CREATE INDEX IF NOT EXISTS review_feedback_material_idx ON review_feedback (org_id, (payload ->> 'materialId')) WHERE deleted_at IS NULL;

ALTER TABLE review_materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_materials FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS review_materials_service ON review_materials;
CREATE POLICY review_materials_service ON review_materials USING (current_setting('app.role', TRUE) = 'service') WITH CHECK (current_setting('app.role', TRUE) = 'service');
ALTER TABLE review_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_feedback FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS review_feedback_service ON review_feedback;
CREATE POLICY review_feedback_service ON review_feedback USING (current_setting('app.role', TRUE) = 'service') WITH CHECK (current_setting('app.role', TRUE) = 'service');

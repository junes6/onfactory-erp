-- R16-I: 양식형 전자결재 — 관리자가 만든 양식과 대결자 설정(recordType으로 갈린다)
CREATE TABLE IF NOT EXISTS approval_forms (
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

-- R16-I: 기안된 결재 문서. 결재선·이력·게시 결과가 payload 안에 통째로 들어간다.
CREATE TABLE IF NOT EXISTS approval_documents (
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

CREATE INDEX IF NOT EXISTS approval_documents_status_idx
  ON approval_documents (org_id, (payload ->> 'status')) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS approval_documents_drafter_idx
  ON approval_documents (org_id, (payload ->> 'drafterId')) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS approval_documents_month_idx
  ON approval_documents (org_id, (payload -> 'posting' ->> 'month')) WHERE deleted_at IS NULL;

-- 서비스 컨텍스트만 통과한다. 게스트 정책은 만들지 않는다 — 결재 문서에는 급여·단가·거래처가 들어가고,
-- 외부 거래처 세션에 그것을 여는 것은 앱 필터 한 겹으로 감당할 일이 아니다.
-- 여는 날에는 게스트 DO 루프 ARRAY와 함께 고친다.
ALTER TABLE approval_forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_forms FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS approval_forms_service ON approval_forms;
CREATE POLICY approval_forms_service ON approval_forms USING (current_setting('app.role', TRUE) = 'service') WITH CHECK (current_setting('app.role', TRUE) = 'service');
ALTER TABLE approval_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS approval_documents_service ON approval_documents;
CREATE POLICY approval_documents_service ON approval_documents USING (current_setting('app.role', TRUE) = 'service') WITH CHECK (current_setting('app.role', TRUE) = 'service');

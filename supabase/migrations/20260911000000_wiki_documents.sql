-- R16-H: 문서(위키). payload에 blocks 배열이 통째로 들어간다.
CREATE TABLE IF NOT EXISTS wiki_documents (
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

-- R16-H: 문서 버전 이력. 되돌리기의 원본이며, 병합에서 밀린 문장이 남는 유일한 자리다.
CREATE TABLE IF NOT EXISTS wiki_revisions (
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

CREATE INDEX IF NOT EXISTS wiki_documents_tree_idx
  ON wiki_documents (org_id, (payload ->> 'parentId')) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS wiki_documents_project_idx
  ON wiki_documents (org_id, (payload ->> 'projectId')) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS wiki_revisions_document_idx
  ON wiki_revisions (org_id, (payload ->> 'documentId'), (payload ->> 'version') DESC) WHERE deleted_at IS NULL;

-- 서비스 롤만 접근한다. 게스트 정책은 만들지 않는다(R16-H에서 문서를 게스트에게 열지 않는다) —
-- 여기에 게스트 SELECT를 만들면 앱 필터 한 겹만으로 외부 거래처에 사내 문서 본문이 열린다.
ALTER TABLE wiki_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE wiki_documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wiki_documents_service ON wiki_documents;
CREATE POLICY wiki_documents_service ON wiki_documents USING (current_setting('app.role', TRUE) = 'service') WITH CHECK (current_setting('app.role', TRUE) = 'service');
ALTER TABLE wiki_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE wiki_revisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wiki_revisions_service ON wiki_revisions;
CREATE POLICY wiki_revisions_service ON wiki_revisions USING (current_setting('app.role', TRUE) = 'service') WITH CHECK (current_setting('app.role', TRUE) = 'service');

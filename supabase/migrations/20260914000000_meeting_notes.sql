-- R16-M: 회의록. 전사 원문·요약·결정·할 일과 그 결과로 만든 문서·제안의 id가 payload 안에 통째로 들어간다.
-- 회의록 문서 본문은 여기에 없다 — 그것은 wiki_documents 에 있고, 이 행은 그 문서의 id 만 들고 있다.
CREATE TABLE IF NOT EXISTS meeting_notes (
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

-- 회의록 목록은 언제나 '아직 도는 것(transcribing·summarizing)'과 '끝난 것'을 갈라 읽는다.
CREATE INDEX IF NOT EXISTS meeting_notes_status_idx ON meeting_notes (org_id, (payload ->> 'status')) WHERE deleted_at IS NULL;

-- 서비스 컨텍스트만 통과한다. 게스트 정책은 만들지 않는다 — 회의 음성과 그 전사는 참석하지 않은
-- 사람의 말까지 담는 개인정보이고, 외부 거래처 세션에 그것을 여는 것은 앱 필터 한 겹으로 감당할 일이 아니다.
-- 여는 날에는 게스트 DO 루프 ARRAY와 함께 고친다.
ALTER TABLE meeting_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_notes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meeting_notes_service ON meeting_notes;
CREATE POLICY meeting_notes_service ON meeting_notes USING (current_setting('app.role', TRUE) = 'service') WITH CHECK (current_setting('app.role', TRUE) = 'service');

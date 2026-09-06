-- R16-D: 공지 게시글과 필독 확인. additive · idempotent.
-- 이미 적용된 20260906010000_guest_scope_rls.sql은 손대지 않는다 — 그 파일의 DO 루프 목록을
-- 늘리면 이미 배포된 마이그레이션의 내용이 바뀐다. 여기서는 notices 한 테이블에만 정책을 얹는다.
--
-- (R16-L의 webhook_endpoints·webhook_deliveries는 같은 파일에 이어 붙는다. 그 테이블들은
--  게스트 범위가 아니므로 DO 루프가 아니라 service 전용 정책만 갖는다.)

CREATE TABLE IF NOT EXISTS notices (
  id TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  position INTEGER NOT NULL DEFAULT 0,
  source_updated_at TIMESTAMPTZ,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  created_by TEXT,
  PRIMARY KEY (org_id, id)
);

-- 채널 상단 스트립은 방 하나의 최신 공지부터 읽는다.
CREATE INDEX IF NOT EXISTS notices_channel_idx
  ON notices (org_id, (payload ->> 'conversationId'), (payload ->> 'createdAt') DESC)
  WHERE deleted_at IS NULL;

-- 게스트 정책(app_guest_project_ids)과 프로젝트별 목록이 같은 두 컬럼을 본다.
CREATE INDEX IF NOT EXISTS notices_project_idx
  ON notices (org_id, (payload ->> 'scope'), (payload ->> 'projectId'))
  WHERE deleted_at IS NULL;

ALTER TABLE notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE notices FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notices_service ON notices;
CREATE POLICY notices_service ON notices
  USING (current_setting('app.role', TRUE) = 'service')
  WITH CHECK (current_setting('app.role', TRUE) = 'service');

-- 회사 공지는 scope 조건에서 걸러진다. 게스트에게는 PG 층에서도 존재하지 않는다.
-- 프로젝트 조건만으로는 부족하다: 같은 프로젝트 아래 '내부 전용' 채널(participantIds에 게스트가 없는 방)의
-- 공지가 그대로 내려간다. 같은 방의 메시지는 messenger_conversations_guest_read가 participantIds를
-- 요구하므로, 공지도 그 방을 한 번 더 물어 같은 조건을 본다(앱의 noticeVisibleTo와 같은 문장).
DROP POLICY IF EXISTS notices_guest_read ON notices;
CREATE POLICY notices_guest_read ON notices FOR SELECT USING (
  current_setting('app.role', TRUE) = 'tenant-guest'
  AND org_id = current_setting('app.org_id', TRUE)
  AND payload->>'scope' = 'project'
  AND payload->>'projectId' = ANY (app_guest_project_ids())
  AND EXISTS (
    SELECT 1 FROM messenger_conversations c
    WHERE c.org_id = notices.org_id
      AND c.id = notices.payload->>'conversationId'
      AND c.deleted_at IS NULL
      AND c.payload->'participantIds' ? current_setting('app.current_account_id', TRUE)
  )
);

-- R16-D/L: 공지 게시글과 외부 연동(수신·발신 웹훅, 전달 이력). additive · idempotent.
-- 이미 적용된 20260906010000_guest_scope_rls.sql은 손대지 않는다 — 그 파일의 DO 루프 목록을
-- 늘리면 이미 배포된 마이그레이션의 내용이 바뀐다. 여기서는 notices 한 테이블에만 정책을 얹고,
-- webhook_* 두 테이블은 게스트 범위가 아니므로 service 전용 정책만 갖는다.

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

-- ── webhook_endpoints ────────────────────────────────────────────────────
-- tokenHash(sha256)와 signingSecretEnc(AES-256-GCM 봉인문)만 들어간다. 평문은 저장하지 않는다.
-- 테넌트 workspace 행에는 stripSensitivePayload가 적용되지 않으므로 이 두 값이 재기동을 넘어 살아남는다 —
-- platform 컬렉션에 두면 같은 값이 조용히 지워져 모든 수신 주소가 404가 된다.
CREATE TABLE IF NOT EXISTS webhook_endpoints (
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

-- 토큰 하나로 고객사를 역조회해야 하므로 org 없이 전역 유니크다.
CREATE UNIQUE INDEX IF NOT EXISTS webhook_endpoints_token_idx
  ON webhook_endpoints ((payload ->> 'tokenHash'))
  WHERE deleted_at IS NULL AND payload ->> 'tokenHash' IS NOT NULL;

ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS webhook_endpoints_service ON webhook_endpoints;
CREATE POLICY webhook_endpoints_service ON webhook_endpoints
  USING (current_setting('app.role', TRUE) = 'service')
  WITH CHECK (current_setting('app.role', TRUE) = 'service');

-- ── webhook_deliveries ───────────────────────────────────────────────────
-- 전달 이력. 사건별 fields allowlist를 지난 값만 payload에 실린다(본문·첨부·연락처는 들어가지 않는다).
CREATE TABLE IF NOT EXISTS webhook_deliveries (
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

CREATE INDEX IF NOT EXISTS webhook_deliveries_pending_idx
  ON webhook_deliveries (org_id, (payload ->> 'status'), (payload ->> 'nextAttemptAt'))
  WHERE deleted_at IS NULL;

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS webhook_deliveries_service ON webhook_deliveries;
CREATE POLICY webhook_deliveries_service ON webhook_deliveries
  USING (current_setting('app.role', TRUE) = 'service')
  WITH CHECK (current_setting('app.role', TRUE) = 'service');

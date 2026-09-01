-- P2: 알림 센터 — 알림 · 유형별 설정 · 웹푸시 구독.
-- 다른 워크스페이스 키와 같은 JSONB 행 모양을 쓴다(org_id + payload + 공통 컬럼).
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);
CREATE TABLE IF NOT EXISTS notification_settings (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);

-- 안 읽은 알림을 사람별로 세는 것이 가장 잦은 조회다.
CREATE INDEX IF NOT EXISTS notifications_recipient_idx
  ON notifications (org_id, (payload ->> 'recipientId'), (payload ->> 'readAt'));
CREATE INDEX IF NOT EXISTS push_subscriptions_account_idx
  ON push_subscriptions (org_id, (payload ->> 'accountId'));

-- R15-E: AI 대화 히스토리.
-- 다른 워크스페이스 키와 같은 JSONB 행 모양을 쓴다(org_id + payload + 공통 컬럼).
CREATE TABLE IF NOT EXISTS ai_conversations (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);

-- 목록은 언제나 "내 대화"로 좁힌 뒤 최근 순으로 본다. 남의 대화는 조회 자체를 하지 않는다.
CREATE INDEX IF NOT EXISTS ai_conversations_owner_idx
  ON ai_conversations (org_id, (payload ->> 'ownerId'), (payload ->> 'updatedAt') DESC);

-- 휴지통 비우기가 만료된 것만 훑도록.
CREATE INDEX IF NOT EXISTS ai_conversations_trash_idx
  ON ai_conversations (org_id, (payload ->> 'deletedAt'));

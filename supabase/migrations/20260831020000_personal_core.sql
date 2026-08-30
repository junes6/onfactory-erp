-- R11-D 개인 지식 코어. 테넌트 격리 "위에" 얹는 계정 소유 계층.
-- 소유자는 org_id가 아니라 owner_account_id다. 한 계정이 여러 고객사를 오가도 자기 기록은
-- 따라오고, 다른 계정은 존재 자체를 조회할 수 없다 (RLS로 강제).
CREATE TABLE IF NOT EXISTS principles (
  id TEXT PRIMARY KEY,
  owner_account_id TEXT NOT NULL REFERENCES core_accounts(id) ON DELETE CASCADE,
  statement TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  confidence DOUBLE PRECISION,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS personal_notes (
  id TEXT PRIMARY KEY,
  owner_account_id TEXT NOT NULL REFERENCES core_accounts(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  topic TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  gap_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS correction_log (
  id TEXT PRIMARY KEY,
  owner_account_id TEXT NOT NULL REFERENCES core_accounts(id) ON DELETE CASCADE,
  proposal_id TEXT,
  kind TEXT,
  reason TEXT,
  diff JSONB,
  org_id TEXT REFERENCES core_tenants(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS knowledge_gaps (
  id TEXT PRIMARY KEY,
  owner_account_id TEXT NOT NULL REFERENCES core_accounts(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  topic TEXT,
  source TEXT NOT NULL DEFAULT 'ai',
  reference TEXT,
  confidence DOUBLE PRECISION,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  note_id TEXT,
  seen_count INTEGER NOT NULL DEFAULT 1,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  created_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_principles_owner ON principles (owner_account_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_personal_notes_owner ON personal_notes (owner_account_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_correction_log_owner ON correction_log (owner_account_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_knowledge_gaps_owner ON knowledge_gaps (owner_account_id, status) WHERE deleted_at IS NULL;

-- 소유자 격리는 애플리케이션 권한 검사와 별개로 DB에서도 강제한다.
-- app.current_account_id 세션 변수를 설정한 커넥션만 자기 행을 본다.
ALTER TABLE principles ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE correction_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_gaps ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  target TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY['principles', 'personal_notes', 'correction_log', 'knowledge_gaps'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_owner_only ON %I', target, target);
    EXECUTE format($policy$
      CREATE POLICY %I_owner_only ON %I
      USING (owner_account_id = current_setting('app.current_account_id', true))
      WITH CHECK (owner_account_id = current_setting('app.current_account_id', true))
    $policy$, target, target);
    -- 서비스 롤(서버 프로세스)만 우회할 수 있다.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
  END LOOP;
END $$;

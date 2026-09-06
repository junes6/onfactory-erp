BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS core_tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'active',
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'workspace',
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ, created_by TEXT
);

CREATE TABLE IF NOT EXISTS space_members (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  role TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ, created_by TEXT,
  UNIQUE (space_id, account_id)
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  space_id TEXT REFERENCES spaces(id) ON DELETE SET NULL,
  item_type TEXT NOT NULL,
  parent_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  position INTEGER NOT NULL DEFAULT 0,
  source_updated_at TIMESTAMPTZ,
  updated_by TEXT,
  storage_key TEXT, mime TEXT, size BIGINT, hash TEXT,
  ai_policy TEXT NOT NULL DEFAULT 'active' CHECK (ai_policy IN ('locked', 'indexed', 'active')),
  version_group_id TEXT, version_no INTEGER NOT NULL DEFAULT 1, summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ, created_by TEXT,
  PRIMARY KEY (org_id, id)
);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE, space_id TEXT REFERENCES spaces(id),
  kind TEXT NOT NULL, payload JSONB NOT NULL DEFAULT '{}'::JSONB, confidence DOUBLE PRECISION,
  status TEXT NOT NULL DEFAULT 'draft', decision_diff JSONB,
  position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ, created_by TEXT,
  PRIMARY KEY (org_id, id)
);
CREATE TABLE IF NOT EXISTS lenses (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE, space_id TEXT REFERENCES spaces(id),
  name TEXT, payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ, created_by TEXT,
  PRIMARY KEY (org_id, id)
);
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE, space_id TEXT REFERENCES spaces(id),
  status TEXT NOT NULL, payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  decided_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ, created_by TEXT,
  PRIMARY KEY (org_id, id)
);
CREATE TABLE IF NOT EXISTS playbooks (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE, space_id TEXT REFERENCES spaces(id),
  name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ, created_by TEXT,
  PRIMARY KEY (org_id, id)
);
CREATE TABLE IF NOT EXISTS automation_policies (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE, space_id TEXT REFERENCES spaces(id),
  enabled BOOLEAN NOT NULL DEFAULT TRUE, payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ, created_by TEXT,
  PRIMARY KEY (org_id, id)
);
CREATE TABLE IF NOT EXISTS bookmarks (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE, space_id TEXT REFERENCES spaces(id),
  label TEXT NOT NULL, url TEXT NOT NULL, payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ, created_by TEXT,
  PRIMARY KEY (org_id, id)
);

CREATE TABLE IF NOT EXISTS core_accounts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES core_tenants(id),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  team TEXT,
  job_role TEXT,
  approval_status TEXT NOT NULL DEFAULT 'pending',
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS account_credentials (
  account_id TEXT PRIMARY KEY REFERENCES core_accounts(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  temporary_password_expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS account_approvals (
  account_id TEXT PRIMARY KEY REFERENCES core_accounts(id) ON DELETE CASCADE,
  decision TEXT NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS account_invites (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES core_tenants(id),
  email TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (tenant_id, email)
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES core_accounts(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS password_reset_requests (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES core_accounts(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A절 외부 게스트 초대: 게스트 권한(grant). supabase/migrations/20260906000000_guest_grants.sql과 동일 내용.
-- payload(JSONB)가 진실, 나머지 컬럼은 인덱스·RLS 판정용 사본. 초대 토큰 해시·발급·만료 시각은
-- 서버가 payload 저장 시 민감 필드(token*)를 지우므로 컬럼에 따로 둔다.
CREATE TABLE IF NOT EXISTS guest_grants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES core_tenants(id),
  account_id TEXT NOT NULL REFERENCES core_accounts(id),
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'invited',
  project_ids TEXT[] NOT NULL DEFAULT '{}',
  token_hash TEXT,
  token_issued_at TIMESTAMPTZ,
  token_expires_at TIMESTAMPTZ,
  access_expires_at TIMESTAMPTZ,
  invited_by TEXT,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_guest_grants_tenant ON guest_grants (tenant_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_guest_grants_account ON guest_grants (account_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS workspace_store_meta (
  tenant_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  workspace_key TEXT NOT NULL,
  data_shape TEXT NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  source_updated_at TIMESTAMPTZ,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, workspace_key)
);

CREATE TABLE IF NOT EXISTS work_items (
  id TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  raw_due TEXT,
  due_at TIMESTAMPTZ,
  source_updated_at TIMESTAMPTZ,
  updated_by TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (org_id, id)
);

CREATE TABLE IF NOT EXISTS inventory_locations (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);
CREATE TABLE IF NOT EXISTS sales_channels (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);
CREATE TABLE IF NOT EXISTS messenger_conversations (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);
CREATE TABLE IF NOT EXISTS messenger_messages (
  id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  sender_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  created_by TEXT,
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, conversation_id) REFERENCES messenger_conversations(org_id, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  starts_at TIMESTAMPTZ, ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);
CREATE TABLE IF NOT EXISTS daily_journals (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  entity_updated_at TIMESTAMPTZ, submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);
CREATE TABLE IF NOT EXISTS leave_requests (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  domain_created_at TIMESTAMPTZ, starts_on DATE, ends_on DATE, raw_period TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);
CREATE TABLE IF NOT EXISTS account_requests (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);
CREATE TABLE IF NOT EXISTS factory_locations (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);
CREATE TABLE IF NOT EXISTS factory_layouts (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);
CREATE TABLE IF NOT EXISTS leave_management (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);
CREATE TABLE IF NOT EXISTS work_rules (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  next_run_at TIMESTAMPTZ, raw_next_run TEXT, last_generated_at TIMESTAMPTZ, raw_last_generated_at TEXT, domain_created_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);
CREATE TABLE IF NOT EXISTS product_catalog (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);
CREATE TABLE IF NOT EXISTS inventory_movements (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);
CREATE TABLE IF NOT EXISTS calendar_departments (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);
CREATE TABLE IF NOT EXISTS sales_shipments (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);
CREATE TABLE IF NOT EXISTS compliance_records (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);
CREATE TABLE IF NOT EXISTS document_storage_settings (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);

CREATE TABLE IF NOT EXISTS performance_settings (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);
CREATE TABLE IF NOT EXISTS performance_report_snapshots (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);
CREATE TABLE IF NOT EXISTS attendance_records (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);
CREATE TABLE IF NOT EXISTS personal_todos (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);
-- P11: 세무사 전달 이력. 서버가 압축본을 만든 순간에만 기록한다(클라이언트 직접 쓰기 금지).
-- R11-D 개인 지식 코어: 소유자는 테넌트가 아니라 계정이다.
CREATE TABLE IF NOT EXISTS principles (
  id TEXT PRIMARY KEY, owner_account_id TEXT NOT NULL REFERENCES core_accounts(id) ON DELETE CASCADE,
  statement TEXT NOT NULL, payload JSONB NOT NULL DEFAULT '{}'::JSONB, confidence DOUBLE PRECISION,
  status TEXT NOT NULL DEFAULT 'active', confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ, retired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ, created_by TEXT
);
CREATE TABLE IF NOT EXISTS personal_notes (
  id TEXT PRIMARY KEY, owner_account_id TEXT NOT NULL REFERENCES core_accounts(id) ON DELETE CASCADE,
  body TEXT NOT NULL, topic TEXT, source TEXT NOT NULL DEFAULT 'manual', gap_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ, created_by TEXT
);
CREATE TABLE IF NOT EXISTS correction_log (
  id TEXT PRIMARY KEY, owner_account_id TEXT NOT NULL REFERENCES core_accounts(id) ON DELETE CASCADE,
  proposal_id TEXT, kind TEXT, reason TEXT, diff JSONB, org_id TEXT REFERENCES core_tenants(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ, created_by TEXT
);
CREATE TABLE IF NOT EXISTS knowledge_gaps (
  id TEXT PRIMARY KEY, owner_account_id TEXT NOT NULL REFERENCES core_accounts(id) ON DELETE CASCADE,
  question TEXT NOT NULL, topic TEXT, source TEXT NOT NULL DEFAULT 'ai', reference TEXT, confidence DOUBLE PRECISION,
  status TEXT NOT NULL DEFAULT 'open', note_id TEXT, seen_count INTEGER NOT NULL DEFAULT 1, resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ, created_by TEXT
);
CREATE TABLE IF NOT EXISTS digests (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);
CREATE TABLE IF NOT EXISTS opportunities (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);
CREATE TABLE IF NOT EXISTS opportunity_settings (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);
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
CREATE TABLE IF NOT EXISTS tax_deliveries (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);

-- it_services 업종 모듈 (프로젝트 · 산출물 · 계약/거래처)
CREATE TABLE IF NOT EXISTS it_projects (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);
CREATE TABLE IF NOT EXISTS it_deliverables (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);
CREATE TABLE IF NOT EXISTS it_contracts (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);

CREATE TABLE IF NOT EXISTS it_clients (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);

CREATE TABLE IF NOT EXISTS it_support_programs (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);

CREATE TABLE IF NOT EXISTS project_spaces (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);

CREATE TABLE IF NOT EXISTS project_posts (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);

-- R16-B: 프로젝트 템플릿. 다른 워크스페이스 키와 같은 JSONB 행 모양이다.
-- 본문에는 역할 이름과 상대 마감일만 들어간다 — 실명·계정 id는 저장하지 않는다.
CREATE TABLE IF NOT EXISTS project_templates (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);

-- R16-D: 공지 게시글 + 필독 확인. 확인 명단과 리마인더 이력이 payload 안에 함께 산다.
-- 게스트 정책은 아래 게스트 RLS 구간에 notices_guest_read로 붙는다(프로젝트 공지만).
CREATE TABLE IF NOT EXISTS notices (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);

-- R16-L: 외부 연동. tokenHash(sha256)와 signingSecretEnc(AES-256-GCM 봉인문)만 들어간다 — 평문은 저장하지 않는다.
-- 게스트 범위가 아니므로 아래 게스트 DO 루프에 넣지 않고 service 전용 정책만 붙인다.
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);

-- R15-E: AI 대화 히스토리. supabase/migrations/20260905000000_ai_conversations.sql 에만 있고
-- 이 베이스라인에 빠져 있던 것을 보충한다 — applySchema는 이 파일 하나만 읽는다.
CREATE TABLE IF NOT EXISTS ai_conversations (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);

-- R16-K: 저장된 보기. private는 소유자만, tenant는 그 고객사 구성원 전부(게스트 제외).
-- 누가 볼 수 있는지는 payload의 ownerId·visibility가 정하고 행 필터는 앱이 한다 — 여기에는 게스트 정책이 없다.
CREATE TABLE IF NOT EXISTS saved_views (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);

-- R16-K: 업무 커스텀 필드 정의. 값은 work_items.payload->'fields'에 있고 여기에는 정의만 있다.
CREATE TABLE IF NOT EXISTS custom_fields (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);

CREATE TABLE IF NOT EXISTS company_assets (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);

CREATE TABLE IF NOT EXISTS tax_events (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);

CREATE TABLE IF NOT EXISTS ip_rights (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0, source_updated_at TIMESTAMPTZ, updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ,
  created_by TEXT, PRIMARY KEY (org_id, id)
);

ALTER TABLE performance_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_report_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE performance_report_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS performance_settings_service ON performance_settings;
CREATE POLICY performance_settings_service ON performance_settings
  USING (current_setting('app.role', TRUE) = 'service')
  WITH CHECK (current_setting('app.role', TRUE) = 'service');
DROP POLICY IF EXISTS performance_settings_tenant_admin ON performance_settings;
CREATE POLICY performance_settings_tenant_admin ON performance_settings
  USING (org_id = current_setting('app.org_id', TRUE) AND current_setting('app.role', TRUE) = 'tenant-admin')
  WITH CHECK (org_id = current_setting('app.org_id', TRUE) AND current_setting('app.role', TRUE) = 'tenant-admin');
DROP POLICY IF EXISTS performance_reports_service ON performance_report_snapshots;
CREATE POLICY performance_reports_service ON performance_report_snapshots
  USING (current_setting('app.role', TRUE) = 'service')
  WITH CHECK (current_setting('app.role', TRUE) = 'service');
DROP POLICY IF EXISTS performance_reports_tenant_admin ON performance_report_snapshots;
CREATE POLICY performance_reports_tenant_admin ON performance_report_snapshots
  USING (org_id = current_setting('app.org_id', TRUE) AND current_setting('app.role', TRUE) = 'tenant-admin')
  WITH CHECK (org_id = current_setting('app.org_id', TRUE) AND current_setting('app.role', TRUE) = 'tenant-admin');

-- A절 외부 게스트 초대: 게스트 범위 RLS. supabase/migrations/20260906010000_guest_scope_rls.sql과 동일 내용.
-- 앱 필터가 실수해도 DB가 한 번 더 자르기 위한 2차 방어. 서버는 평소 app.role='service'로 전량 통과하고,
-- 게스트 GET 라우트만 트랜잭션 안에서 app.role='tenant-guest' + app.org_id + app.current_account_id +
-- app.guest_project_ids(콤마 구분)를 세팅해 SELECT한다. 게스트 컨텍스트에는 쓰기 정책이 없다.
-- 주의: 접속 롤이 rolsuper 또는 rolbypassrls면 FORCE RLS를 포함해 이 정책들이 앱 커넥션에 적용되지 않는다 —
-- 운영 DATABASE_URL은 NOBYPASSRLS 비특권 롤이어야 하며, run-postgres-e2e의 checkRolePrivileges가 이를 검사한다.
-- pg-mem은 함수·DO 블록·RLS DDL을 못 읽으므로 postgres-store.mjs가 이 구간을 걷어내고 적용한다.
CREATE OR REPLACE FUNCTION app_guest_project_ids() RETURNS TEXT[] LANGUAGE sql STABLE AS $$
  SELECT COALESCE(string_to_array(NULLIF(current_setting('app.guest_project_ids', TRUE), ''), ','), '{}')
$$;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['project_spaces', 'project_posts', 'work_items', 'messenger_conversations', 'items', 'guest_grants', 'notices'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_service ON %I', t, t);
    EXECUTE format($p$
      CREATE POLICY %I_service ON %I
      USING (current_setting('app.role', TRUE) = 'service')
      WITH CHECK (current_setting('app.role', TRUE) = 'service')
    $p$, t, t);
  END LOOP;
END $$;

-- R16-B: 프로젝트 템플릿은 게스트가 읽지 않는다. 게스트 정책을 만들지 않고 서비스 컨텍스트만 통과시킨다 —
-- 정책이 하나도 없는 채로 RLS만 켜면 앱이 못 읽고, 게스트 정책을 만들면 외부인에게 내부 프로세스명이 열린다.
ALTER TABLE project_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_templates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS project_templates_service ON project_templates;
CREATE POLICY project_templates_service ON project_templates USING (current_setting('app.role', TRUE) = 'service') WITH CHECK (current_setting('app.role', TRUE) = 'service');

-- R16-L: 외부 연동은 게스트가 읽지 않는다. 게스트 정책을 만들지 않고 서비스 컨텍스트만 통과시킨다 —
-- 여기에 게스트 SELECT를 만들면 수신 주소의 해시와 봉인문이 외부인 세션에 노출된다.
ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS webhook_endpoints_service ON webhook_endpoints;
CREATE POLICY webhook_endpoints_service ON webhook_endpoints USING (current_setting('app.role', TRUE) = 'service') WITH CHECK (current_setting('app.role', TRUE) = 'service');
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS webhook_deliveries_service ON webhook_deliveries;
CREATE POLICY webhook_deliveries_service ON webhook_deliveries USING (current_setting('app.role', TRUE) = 'service') WITH CHECK (current_setting('app.role', TRUE) = 'service');

-- R16-K: 저장된 보기·커스텀 필드 정의는 게스트가 읽지 않는다. 게스트 정책을 만들지 않고 서비스 컨텍스트만 통과시킨다 —
-- 보기 이름과 filters.ownerIds·projectIds는 사람·프로젝트의 열거원이고, 필드 라벨은 회사의 내부 어휘다.
ALTER TABLE saved_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_views FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saved_views_service ON saved_views;
CREATE POLICY saved_views_service ON saved_views USING (current_setting('app.role', TRUE) = 'service') WITH CHECK (current_setting('app.role', TRUE) = 'service');
ALTER TABLE custom_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_fields FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS custom_fields_service ON custom_fields;
CREATE POLICY custom_fields_service ON custom_fields USING (current_setting('app.role', TRUE) = 'service') WITH CHECK (current_setting('app.role', TRUE) = 'service');

DROP POLICY IF EXISTS project_spaces_guest_read ON project_spaces;
CREATE POLICY project_spaces_guest_read ON project_spaces FOR SELECT USING (
  current_setting('app.role', TRUE) = 'tenant-guest'
  AND org_id = current_setting('app.org_id', TRUE)
  AND id = ANY (app_guest_project_ids())
  AND payload->'members' @> jsonb_build_array(jsonb_build_object('id', current_setting('app.current_account_id', TRUE)))
);
DROP POLICY IF EXISTS project_posts_guest_read ON project_posts;
CREATE POLICY project_posts_guest_read ON project_posts FOR SELECT USING (
  current_setting('app.role', TRUE) = 'tenant-guest'
  AND org_id = current_setting('app.org_id', TRUE)
  AND payload->>'projectId' = ANY (app_guest_project_ids())
);
DROP POLICY IF EXISTS work_items_guest_read ON work_items;
CREATE POLICY work_items_guest_read ON work_items FOR SELECT USING (
  current_setting('app.role', TRUE) = 'tenant-guest'
  AND org_id = current_setting('app.org_id', TRUE)
  AND payload->>'projectId' = ANY (app_guest_project_ids())
  AND payload->>'ownerId' = current_setting('app.current_account_id', TRUE)
);
DROP POLICY IF EXISTS messenger_conversations_guest_read ON messenger_conversations;
CREATE POLICY messenger_conversations_guest_read ON messenger_conversations FOR SELECT USING (
  current_setting('app.role', TRUE) = 'tenant-guest'
  AND org_id = current_setting('app.org_id', TRUE)
  AND payload->'participantIds' ? current_setting('app.current_account_id', TRUE)
  AND (payload->>'type' = 'direct' OR payload->>'projectId' = ANY (app_guest_project_ids()))
);
-- R16-D: 회사 공지는 scope 조건에서 걸러진다. 게스트에게는 PG 층에서도 존재하지 않는다.
-- 프로젝트 조건만으로는 부족하다 — 같은 프로젝트 아래 '내부 전용' 채널의 공지가 그대로 내려간다.
-- 바로 위 messenger_conversations_guest_read와 같은 participantIds 조건을 방을 물어 한 번 더 본다
-- (앱의 noticeVisibleTo가 게스트 갈래에서 요구하는 것과 같은 문장이다).
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
DROP POLICY IF EXISTS items_guest_read ON items;
CREATE POLICY items_guest_read ON items FOR SELECT USING (
  current_setting('app.role', TRUE) = 'tenant-guest'
  AND org_id = current_setting('app.org_id', TRUE)
  AND item_type = 'company-document'
  AND (
    payload->>'uploadedById' = current_setting('app.current_account_id', TRUE)
    OR (payload->>'visibility' = 'restricted' AND payload->'allowedUserIds' ? current_setting('app.current_account_id', TRUE))
  )
);
ALTER TABLE core_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE core_accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS core_accounts_service ON core_accounts;
CREATE POLICY core_accounts_service ON core_accounts
  USING (current_setting('app.role', TRUE) = 'service')
  WITH CHECK (current_setting('app.role', TRUE) = 'service');
DROP POLICY IF EXISTS core_accounts_guest_self ON core_accounts;
CREATE POLICY core_accounts_guest_self ON core_accounts FOR SELECT USING (
  current_setting('app.role', TRUE) = 'tenant-guest'
  AND id = current_setting('app.current_account_id', TRUE)
);

CREATE TABLE IF NOT EXISTS platform_tenants (
  id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  domain_created_at TIMESTAMPTZ,
  sync_at TIMESTAMPTZ,
  raw_sync TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS platform_support_tickets (
  id TEXT PRIMARY KEY, tenant_id TEXT REFERENCES core_tenants(id), payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0,
  domain_created_at TIMESTAMPTZ, domain_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS platform_integrations (
  id TEXT PRIMARY KEY, tenant_id TEXT REFERENCES core_tenants(id), payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0,
  last_sync_at TIMESTAMPTZ, raw_last_sync TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS platform_actions (
  id TEXT PRIMARY KEY, tenant_id TEXT REFERENCES core_tenants(id), payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0,
  domain_created_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS platform_audit_events (
  id TEXT PRIMARY KEY, tenant_id TEXT REFERENCES core_tenants(id), payload JSONB NOT NULL, position INTEGER NOT NULL DEFAULT 0,
  event_at TIMESTAMPTZ, raw_event_at TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES core_tenants(id),
  space_id TEXT REFERENCES spaces(id),
  event_type TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'workspace',
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES core_tenants(id),
  space_id TEXT REFERENCES spaces(id),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  created_by TEXT
);

CREATE OR REPLACE VIEW outbox_events AS
SELECT id, org_id AS tenant_id, event_type, aggregate_type, aggregate_id, actor,
  payload, status, attempts, available_at, created_at, processed_at
FROM events;

CREATE INDEX IF NOT EXISTS idx_workspace_meta_active ON workspace_store_meta (tenant_id, workspace_key) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_work_items_active ON work_items (org_id, position) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_daily_journals_active ON daily_journals (org_id, position) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_messenger_active ON messenger_conversations (org_id, position) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_messenger_messages_active ON messenger_messages (org_id, conversation_id, position) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_documents_active ON items (org_id, position) WHERE deleted_at IS NULL AND item_type = 'company-document';
CREATE INDEX IF NOT EXISTS idx_attendance_records_active ON attendance_records (org_id, position) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_personal_todos_active ON personal_todos (org_id, (payload->>'ownerId'), position) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_project_templates_active ON project_templates (org_id, (payload ->> 'origin'), position) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS notices_channel_idx ON notices (org_id, (payload ->> 'conversationId'), (payload ->> 'createdAt') DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS notices_project_idx ON notices (org_id, (payload ->> 'scope'), (payload ->> 'projectId')) WHERE deleted_at IS NULL;
-- 토큰 하나로 고객사를 역조회해야 하므로 org 없이 전역 유니크다.
CREATE UNIQUE INDEX IF NOT EXISTS webhook_endpoints_token_idx ON webhook_endpoints ((payload ->> 'tokenHash')) WHERE deleted_at IS NULL AND payload ->> 'tokenHash' IS NOT NULL;
CREATE INDEX IF NOT EXISTS webhook_deliveries_pending_idx ON webhook_deliveries (org_id, (payload ->> 'status'), (payload ->> 'nextAttemptAt')) WHERE deleted_at IS NULL;
-- 보기 목록은 언제나 '내 것 + 전사 공유'라 소유자로 먼저 좁힌다. 필드 정의는 표면(work…)별로 한 번에 읽는다.
CREATE INDEX IF NOT EXISTS idx_saved_views_active ON saved_views (org_id, (payload ->> 'ownerId'), position) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_custom_fields_active ON custom_fields (org_id, (payload ->> 'surface'), position) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ai_conversations_owner_idx ON ai_conversations (org_id, (payload ->> 'ownerId'), (payload ->> 'updatedAt') DESC);
CREATE INDEX IF NOT EXISTS ai_conversations_trash_idx ON ai_conversations (org_id, (payload ->> 'deletedAt'));
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON auth_sessions (expires_at) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON events (status, available_at, created_at);

INSERT INTO schema_migrations (id) VALUES ('20260820_normalized_store_v1') ON CONFLICT (id) DO NOTHING;

COMMIT;

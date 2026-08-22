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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_at TIMESTAMPTZ, created_by TEXT,
  PRIMARY KEY (org_id, id)
);
CREATE TABLE IF NOT EXISTS lenses (
  id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES core_tenants(id) ON DELETE CASCADE, space_id TEXT REFERENCES spaces(id),
  name TEXT NOT NULL, payload JSONB NOT NULL DEFAULT '{}'::JSONB,
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
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON auth_sessions (expires_at) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON events (status, available_at, created_at);

INSERT INTO schema_migrations (id) VALUES ('20260820_normalized_store_v1') ON CONFLICT (id) DO NOTHING;

COMMIT;

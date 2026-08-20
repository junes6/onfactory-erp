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

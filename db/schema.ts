export const appStateSchema = `
CREATE TABLE IF NOT EXISTS app_state (
  id TEXT PRIMARY KEY NOT NULL,
  payload TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
)
`

export const sitesRuntimeGuardSchema = `
CREATE TABLE IF NOT EXISTS request_locks (
  id TEXT PRIMARY KEY NOT NULL,
  owner TEXT,
  expires_at INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_rate_limits (
  key TEXT PRIMARY KEY NOT NULL,
  request_count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_rate_limits_expires_at
ON api_rate_limits (expires_at)
`

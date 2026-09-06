# OnFactory storage backends

`STORE_BACKEND=postgres|json` controls the local API storage layer. `postgres` is the default.

- Postgres requires `DATABASE_URL`. Apply `db/postgres-schema.sql` first, or set `STORE_AUTO_MIGRATE=true` only for controlled local development.
- If `DATABASE_URL` is absent or Postgres is unreachable, the server boots on the local JSON store in **read-write** mode (atomic file writes with a `.bak` copy). Set `STORE_ALLOW_JSON_FALLBACK=false` to fail startup instead.
- Read-only JSON mode is opt-in only: set `STORE_READ_ONLY=1`. (Legacy `STORE_JSON_READONLY=true` is still honoured; any other value means read-write.) When the store is read-only the app shows a fixed banner on every screen.
- Supabase CLI is a development dependency, but Docker and `psql` are not available on every workstation. A real Postgres E2E test therefore runs only against an explicitly supplied `DATABASE_URL`.

The application still receives its existing in-memory facade. Postgres reads and writes the allow-listed workspace domains (`server/store/constants.mjs` `WORKSPACE_TABLES`) through separate entity tables, stores document metadata in core `items`, and rejects unknown keys. Messenger messages use child rows with canonical `created_at`. Every committed domain diff and its `events` outbox rows share one transaction.

Some allow-listed keys are storage-only: they are in `WORKSPACE_TABLES` but **not** in `server/app.mjs` `WORKSPACE_STORE_KEYS`, so the generic `GET/PUT /api/workspace/:key` answers `404 STORE_KEY_NOT_FOUND` and a dedicated route is the only door. Today those are `ai-conversations`, `notices`, `webhook-endpoints`, `webhook-deliveries`, `saved-views` and `custom-fields` — each holds rows with a per-row owner, a per-row audience or a sealed secret, and the generic array PUT has no per-row ownership concept.

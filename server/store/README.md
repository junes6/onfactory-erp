# OnFactory storage backends

`STORE_BACKEND=postgres|json` controls the local API storage layer. `postgres` is the default.

- Postgres requires `DATABASE_URL`. Apply `db/postgres-schema.sql` first, or set `STORE_AUTO_MIGRATE=true` only for controlled local development.
- If `DATABASE_URL` is absent or Postgres is unreachable, the server boots on the local JSON store in **read-write** mode (atomic file writes with a `.bak` copy). Set `STORE_ALLOW_JSON_FALLBACK=false` to fail startup instead.
- Read-only JSON mode is opt-in only: set `STORE_READ_ONLY=1`. (Legacy `STORE_JSON_READONLY=true` is still honoured; any other value means read-write.) When the store is read-only the app shows a fixed banner on every screen.
- Supabase CLI is a development dependency, but Docker and `psql` are not available on every workstation. A real Postgres E2E test therefore runs only against an explicitly supplied `DATABASE_URL`.

The application still receives its existing in-memory facade. Postgres reads and writes the 20 allow-listed workspace domains (the original 18 plus performance settings and immutable performance report snapshots) through separate entity tables, stores document metadata in core `items`, and rejects unknown keys. Messenger messages use child rows with canonical `created_at`. Every committed domain diff and its `events` outbox rows share one transaction.

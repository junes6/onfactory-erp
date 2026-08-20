# OnFactory storage backends

`STORE_BACKEND=postgres|json` controls the local API storage layer. `postgres` is the default.

- Postgres requires `DATABASE_URL`. Apply `db/postgres-schema.sql` first, or set `STORE_AUTO_MIGRATE=true` only for controlled local development.
- If Postgres is unavailable, the server may load the existing JSON store as a read-only recovery view. Set `STORE_ALLOW_JSON_FALLBACK=false` to fail startup instead.
- JSON writes are disabled unless `STORE_BACKEND=json` and `STORE_JSON_READONLY=false` are both explicit.
- Supabase CLI is a development dependency, but Docker and `psql` are not available on every workstation. A real Postgres E2E test therefore runs only against an explicitly supplied `DATABASE_URL`.

The application still receives its existing in-memory facade. Postgres reads and writes the 20 allow-listed workspace domains (the original 18 plus performance settings and immutable performance report snapshots) through separate entity tables, stores document metadata in core `items`, and rejects unknown keys. Messenger messages use child rows with canonical `created_at`. Every committed domain diff and its `events` outbox rows share one transaction.

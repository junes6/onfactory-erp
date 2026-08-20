import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

const migration = readFileSync(new URL('../drizzle/0004_sites_admin_access.sql', import.meta.url), 'utf8')

test('Sites admin access migration replaces only the intended credential and preserves workspace data', () => {
  const database = new DatabaseSync(':memory:')
  database.exec(`CREATE TABLE app_state (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`)
  const original = {
    workspaceStore: {
      tenants: { 'TENANT-SUNSEA': { 'work-items': { data: [{ id: 'WK-KEEP', title: '보존 업무' }] } } },
      accountCredentials: {
        'USR-SUNSEA-ADMIN': { passwordHash: 'old', mustChangePassword: true },
        'USR-SUNSEA-OH': { passwordHash: 'member-hash', mustChangePassword: false },
      },
    },
    sessions: [['session-keep', { accountId: 'USR-SUNSEA-OH' }]],
  }
  database.prepare('INSERT INTO app_state (id,payload,revision,updated_at) VALUES (?,?,?,?)')
    .run('onfactory', JSON.stringify(original), 4, '2026-08-20T00:00:00.000Z')

  database.exec(migration)
  const row = database.prepare('SELECT payload,revision FROM app_state WHERE id=?').get('onfactory')
  const updated = JSON.parse(row.payload)
  assert.equal(row.revision, 5)
  assert.deepEqual(updated.workspaceStore.tenants, original.workspaceStore.tenants)
  assert.deepEqual(updated.sessions, original.sessions)
  assert.deepEqual(updated.workspaceStore.accountCredentials['USR-SUNSEA-OH'], original.workspaceStore.accountCredentials['USR-SUNSEA-OH'])
  assert.deepEqual(
    {
      passwordHash: updated.workspaceStore.accountCredentials['USR-SUNSEA-ADMIN'].passwordHash,
      mustChangePassword: updated.workspaceStore.accountCredentials['USR-SUNSEA-ADMIN'].mustChangePassword,
      temporaryPasswordExpiresAt: updated.workspaceStore.accountCredentials['USR-SUNSEA-ADMIN'].temporaryPasswordExpiresAt,
    },
    {
      passwordHash: 'a8ed52944ee3b217b18df8c275db17390bc4dd1bf124e2ef7d20ab5184f9bd13',
      mustChangePassword: false,
      temporaryPasswordExpiresAt: null,
    },
  )
  assert.doesNotMatch(migration, /Of!kOhUvC6mKJqhANDe/)
  database.close()
})

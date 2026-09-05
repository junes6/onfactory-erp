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
  // 임시 비밀번호 평문은 어디에도 적지 않는다 — 값을 적어 두고 '없는지' 검사하면 그 검사 자체가 유출이다.
  // 발급 형식(Of! + 무작위 12자)의 흔적만 없는지 본다.
  assert.doesNotMatch(migration, /Of![A-Za-z0-9_-]{8,}/)
  database.close()
})

const rotation = readFileSync(new URL('../drizzle/0005_rotate_exposed_sites_admin_credential.sql', import.meta.url), 'utf8')

/** 0004가 만든 상태를 그대로 재현한다. */
function seededDatabase(adminCredential) {
  const database = new DatabaseSync(':memory:')
  database.exec(`CREATE TABLE app_state (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`)
  const payload = {
    workspaceStore: {
      tenants: { 'TENANT-SUNSEA': { 'work-items': { data: [{ id: 'WK-KEEP', title: '보존 업무' }] } } },
      accountCredentials: {
        'USR-SUNSEA-ADMIN': adminCredential,
        'USR-SUNSEA-OH': { passwordHash: 'member-hash', mustChangePassword: false },
      },
    },
    sessions: [['session-keep', { accountId: 'USR-SUNSEA-OH' }]],
  }
  database.prepare('INSERT INTO app_state (id,payload,revision,updated_at) VALUES (?,?,?,?)')
    .run('onfactory', JSON.stringify(payload), 5, '2026-08-21T00:00:00.000Z')
  return { database, payload }
}

/** 0004가 심었던 해시. 두 곳에 따로 적지 않고 마이그레이션 원문에서 읽는다. */
const EXPOSED_HASH = /'([a-f0-9]{64})'/.exec(migration)[1]

test('0005는 노출된 해시가 그대로일 때만 아는 사람이 없는 값으로 바꾸고 재설정을 강제한다', () => {
  const { database, payload } = seededDatabase({ passwordHash: EXPOSED_HASH, mustChangePassword: false, temporaryPasswordExpiresAt: null })
  database.exec(rotation)
  const row = database.prepare('SELECT payload,revision FROM app_state WHERE id=?').get('onfactory')
  const updated = JSON.parse(row.payload)
  const admin = updated.workspaceStore.accountCredentials['USR-SUNSEA-ADMIN']
  assert.equal(row.revision, 6)
  assert.match(admin.passwordHash, /^[a-f0-9]{64}$/, '해시 자리에는 같은 길이의 무작위 값이 들어간다')
  assert.notEqual(admin.passwordHash, EXPOSED_HASH)
  assert.equal(admin.mustChangePassword, true, '다음 로그인은 재설정 경로를 타야 한다')
  assert.equal(admin.rotationReason, 'public-history-exposure')
  // 다른 사람과 업무 데이터는 그대로다.
  assert.deepEqual(updated.workspaceStore.tenants, payload.workspaceStore.tenants)
  assert.deepEqual(updated.workspaceStore.accountCredentials['USR-SUNSEA-OH'], payload.workspaceStore.accountCredentials['USR-SUNSEA-OH'])
  assert.deepEqual(updated.sessions, payload.sessions)
  database.close()
})

test('0005는 이미 스스로 비밀번호를 바꾼 배포의 관리자는 건드리지 않는다', () => {
  const changed = { passwordHash: 'c'.repeat(64), mustChangePassword: false, temporaryPasswordExpiresAt: null }
  const { database } = seededDatabase(changed)
  database.exec(rotation)
  const row = database.prepare('SELECT payload,revision FROM app_state WHERE id=?').get('onfactory')
  assert.equal(row.revision, 5, '조건에 맞지 않으면 아무것도 쓰지 않는다')
  assert.deepEqual(JSON.parse(row.payload).workspaceStore.accountCredentials['USR-SUNSEA-ADMIN'], changed)
  database.close()
})

test('0005 자체에도 비밀번호 평문 형식이 없다', () => {
  assert.doesNotMatch(rotation, /Of![A-Za-z0-9_-]{8,}/)
})

import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import test from 'node:test'

import {
  applyHostedAccountCredentialRecovery,
  HostedAccountRecoveryConfigurationError,
} from './account-credential-recovery.mjs'
import { createApp } from '../server/app.mjs'

const NOW = '2026-08-25T03:00:00.000Z'
const EXPIRES_AT = '2026-09-01T03:00:00.000Z'
const OPERATOR_PASSWORD = 'Operator-Recover!2026-A'
const MUSE_PASSWORD = 'Muse-Recover!2026-B'

function runtimeEnv(overrides = {}) {
  return {
    ERP_SEED_PASSWORD: 'Hosted-Seed!2026-Z',
    ERP_ACCOUNT_RECOVERY_VERSION: '2026-08-25-v1',
    ERP_OPERATOR_RECOVERY_PASSWORD: OPERATOR_PASSWORD,
    ERP_3DMUSE_RECOVERY_PASSWORD: MUSE_PASSWORD,
    ...overrides,
  }
}

function workspaceStore() {
  return {
    version: 2,
    tenants: {
      'TENANT-SUNSEA': {
        'work-items': { data: [{ id: 'WK-KEEP', title: '보존 업무' }] },
      },
      'TENANT-3DMUSE': {
        'it-projects': { data: [{ id: 'ITP-KEEP', name: '보존 프로젝트' }] },
      },
    },
    platform: {
      tenants: [{ id: 'TENANT-3DMUSE', adminAccount: { id: 'USR-3DMUSE-ADMIN' } }],
      auditEvents: [{ id: 'AUD-KEEP', event: '기존 감사' }],
    },
    accountCredentials: {
      'USR-ONFACTORY-OPS': { passwordHash: 'old-operator', mustChangePassword: false },
      'USR-3DMUSE-ADMIN': { passwordHash: 'old-muse', mustChangePassword: false },
      'USR-SUNSEA-ADMIN': { passwordHash: 'keep-sunsea', mustChangePassword: false },
    },
    passwordResetRequests: [
      { id: 'RESET-OPS', accountId: 'USR-ONFACTORY-OPS', status: 'pending' },
      { id: 'RESET-MUSE', accountId: 'USR-3DMUSE-ADMIN', status: 'pending' },
      { id: 'RESET-OTHER', accountId: 'USR-SUNSEA-ADMIN', status: 'pending' },
      { id: 'RESET-USED', accountId: 'USR-ONFACTORY-OPS', status: 'used', usedAt: '2026-08-24T00:00:00.000Z' },
      { id: 'RESET-REVOKED', accountId: 'USR-3DMUSE-ADMIN', status: 'revoked', revokedAt: '2026-08-24T00:00:00.000Z' },
    ],
  }
}

function sessions() {
  return new Map([
    ['session-operator', { accountId: 'USR-ONFACTORY-OPS', expiresAt: Date.now() + 10_000 }],
    ['session-muse', { accountId: 'USR-3DMUSE-ADMIN', expiresAt: Date.now() + 10_000 }],
    ['session-other', { accountId: 'USR-SUNSEA-ADMIN', expiresAt: Date.now() + 10_000 }],
  ])
}

function cloneMap(value) {
  return new Map([...value.entries()].map(([key, item]) => [key, structuredClone(item)]))
}

test('targeted hosted recovery replaces only two hashes and atomically revokes their sessions and pending reset tokens', () => {
  const store = workspaceStore()
  const activeSessions = sessions()
  const preservedTenants = structuredClone(store.tenants)
  const preservedOtherCredential = structuredClone(store.accountCredentials['USR-SUNSEA-ADMIN'])

  const result = applyHostedAccountCredentialRecovery(store, activeSessions, runtimeEnv(), { clock: () => new Date(NOW) })

  assert.deepEqual(result, {
    enabled: true,
    changed: true,
    version: '2026-08-25-v1',
    targetAccountIds: ['USR-ONFACTORY-OPS', 'USR-3DMUSE-ADMIN'],
    revokedSessionCount: 2,
    revokedResetRequestCount: 2,
    temporaryPasswordExpiresAt: EXPIRES_AT,
  })
  assert.deepEqual(store.tenants, preservedTenants)
  assert.deepEqual(store.accountCredentials['USR-SUNSEA-ADMIN'], preservedOtherCredential)
  assert.equal(store.accountCredentials['USR-ONFACTORY-OPS'].passwordHash, scryptSync(OPERATOR_PASSWORD, 'onfactory:USR-ONFACTORY-OPS', 32).toString('hex'))
  assert.equal(store.accountCredentials['USR-3DMUSE-ADMIN'].passwordHash, scryptSync(MUSE_PASSWORD, 'onfactory:USR-3DMUSE-ADMIN', 32).toString('hex'))
  for (const id of ['USR-ONFACTORY-OPS', 'USR-3DMUSE-ADMIN']) {
    assert.equal(store.accountCredentials[id].mustChangePassword, true)
    assert.equal(store.accountCredentials[id].temporaryPasswordExpiresAt, EXPIRES_AT)
    assert.equal(store.accountCredentials[id].recoveryVersion, '2026-08-25-v1')
  }
  assert.deepEqual([...activeSessions.keys()], ['session-other'])
  assert.equal(store.passwordResetRequests.find((item) => item.id === 'RESET-OPS').revokedReason, 'hosted-account-recovery')
  assert.equal(store.passwordResetRequests.find((item) => item.id === 'RESET-MUSE').revokedAt, NOW)
  assert.equal(store.passwordResetRequests.find((item) => item.id === 'RESET-OTHER').status, 'pending')
  assert.equal(store.passwordResetRequests.find((item) => item.id === 'RESET-USED').usedAt, '2026-08-24T00:00:00.000Z')
  assert.equal(store.passwordResetRequests.find((item) => item.id === 'RESET-REVOKED').revokedAt, '2026-08-24T00:00:00.000Z')
  assert.deepEqual(store.platform.accountCredentialRecovery, {
    version: '2026-08-25-v1',
    appliedAt: NOW,
    targetAccountIds: ['USR-ONFACTORY-OPS', 'USR-3DMUSE-ADMIN'],
    mustChangePassword: true,
    temporaryPasswordExpiresAt: EXPIRES_AT,
  })
  assert.equal(store.platform.auditEvents[0].event, '운영 계정 자격 증명 복구')
  assert.equal(store.platform.auditEvents[1].id, 'AUD-KEEP')

  const serialized = JSON.stringify(store)
  assert.equal(serialized.includes(OPERATOR_PASSWORD), false)
  assert.equal(serialized.includes(MUSE_PASSWORD), false)
})

test('the same recovery version is idempotent and a bumped version deliberately rotates credentials again', () => {
  const store = workspaceStore()
  const activeSessions = sessions()
  applyHostedAccountCredentialRecovery(store, activeSessions, runtimeEnv(), { clock: () => new Date(NOW) })
  const afterFirstStore = structuredClone(store)
  const afterFirstSessions = cloneMap(activeSessions)

  const repeated = applyHostedAccountCredentialRecovery(store, activeSessions, runtimeEnv({
    ERP_OPERATOR_RECOVERY_PASSWORD: 'Different-Operator!2027-C',
    ERP_3DMUSE_RECOVERY_PASSWORD: 'Different-Muse!2027-D',
  }), { clock: () => new Date('2026-08-26T03:00:00.000Z') })
  assert.equal(repeated.changed, false)
  assert.deepEqual(store, afterFirstStore)
  assert.deepEqual(activeSessions, afterFirstSessions)

  activeSessions.set('new-operator-session', { accountId: 'USR-ONFACTORY-OPS', expiresAt: Date.now() + 10_000 })
  const rotated = applyHostedAccountCredentialRecovery(store, activeSessions, runtimeEnv({
    ERP_ACCOUNT_RECOVERY_VERSION: '2026-08-26-v2',
    ERP_OPERATOR_RECOVERY_PASSWORD: 'Different-Operator!2027-C',
    ERP_3DMUSE_RECOVERY_PASSWORD: 'Different-Muse!2027-D',
  }), { clock: () => new Date('2026-08-26T03:00:00.000Z') })
  assert.equal(rotated.changed, true)
  assert.equal(rotated.revokedSessionCount, 1)
  assert.equal(activeSessions.has('new-operator-session'), false)
  assert.equal(store.platform.accountCredentialRecovery.version, '2026-08-26-v2')
  assert.notEqual(store.accountCredentials['USR-ONFACTORY-OPS'].passwordHash, afterFirstStore.accountCredentials['USR-ONFACTORY-OPS'].passwordHash)
  assert.equal(store.platform.auditEvents.filter((item) => item.event === '운영 계정 자격 증명 복구').length, 2)
})

test('recovery is disabled only when all three recovery settings are absent', () => {
  const store = workspaceStore()
  const activeSessions = sessions()
  const beforeStore = structuredClone(store)
  const beforeSessions = cloneMap(activeSessions)

  assert.deepEqual(applyHostedAccountCredentialRecovery(store, activeSessions, { ERP_SEED_PASSWORD: 'Hosted-Seed!2026-Z' }), {
    enabled: false,
    changed: false,
  })
  assert.deepEqual(store, beforeStore)
  assert.deepEqual(activeSessions, beforeSessions)
})

test('invalid or ambiguous recovery configuration fails before mutating state', () => {
  const invalidEnvironments = [
    { ERP_OPERATOR_RECOVERY_PASSWORD: OPERATOR_PASSWORD },
    runtimeEnv({ ERP_ACCOUNT_RECOVERY_VERSION: 'bad version' }),
    runtimeEnv({ ERP_OPERATOR_RECOVERY_PASSWORD: 'weak-password' }),
    runtimeEnv({ ERP_3DMUSE_RECOVERY_PASSWORD: OPERATOR_PASSWORD }),
    runtimeEnv({ ERP_OPERATOR_RECOVERY_PASSWORD: 'Hosted-Seed!2026-Z' }),
  ]

  for (const invalidEnv of invalidEnvironments) {
    const store = workspaceStore()
    const activeSessions = sessions()
    const beforeStore = structuredClone(store)
    const beforeSessions = cloneMap(activeSessions)
    assert.throws(
      () => applyHostedAccountCredentialRecovery(store, activeSessions, invalidEnv, { clock: () => new Date(NOW) }),
      HostedAccountRecoveryConfigurationError,
    )
    assert.deepEqual(store, beforeStore)
    assert.deepEqual(activeSessions, beforeSessions)
  }
})

test('invalid clock or malformed store shape fails without erasing state or revoking sessions', () => {
  const cases = [
    {
      mutate(store) { store.platform = 'legacy-platform-payload' },
      options: { clock: () => new Date(NOW) },
    },
    {
      mutate(store) { store.accountCredentials = [] },
      options: { clock: () => new Date(NOW) },
    },
    {
      mutate(store) { store.passwordResetRequests = { pending: [] } },
      options: { clock: () => new Date(NOW) },
    },
    {
      mutate() {},
      options: { clock: () => new Date('invalid') },
    },
  ]

  for (const item of cases) {
    const store = workspaceStore()
    item.mutate(store)
    const activeSessions = sessions()
    const beforeStore = structuredClone(store)
    const beforeSessions = cloneMap(activeSessions)
    assert.throws(
      () => applyHostedAccountCredentialRecovery(store, activeSessions, runtimeEnv(), item.options),
      HostedAccountRecoveryConfigurationError,
    )
    assert.deepEqual(store, beforeStore)
    assert.deepEqual(activeSessions, beforeSessions)
  }
})

test('recovered hashes authenticate both real app accounts, reject the previous seed password, and require a first-login change', async () => {
  const store = workspaceStore()
  const activeSessions = new Map()
  applyHostedAccountCredentialRecovery(store, activeSessions, runtimeEnv(), { clock: () => new Date() })
  const app = createApp({
    initialWorkspaceStore: store,
    sessions: activeSessions,
    seedPassword: 'Hosted-Seed!2026-Z',
    requireSeedPasswordChange: true,
    skipStartupMigrations: true,
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const address = server.address()
  const origin = `http://127.0.0.1:${address.port}`
  const login = (email, password, workspace) => fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, workspace }),
  })

  try {
    const operator = await login('operator@onfactory.co.kr', OPERATOR_PASSWORD, 'platform')
    assert.equal(operator.status, 200)
    assert.equal((await operator.json()).account.requiresPasswordChange, true)

    const muse = await login('admin@3dmuse.demo', MUSE_PASSWORD, 'tenant')
    assert.equal(muse.status, 200)
    const museBody = await muse.json()
    assert.equal(museBody.account.tenantId, 'TENANT-3DMUSE')
    assert.equal(museBody.account.requiresPasswordChange, true)

    assert.equal((await login('operator@onfactory.co.kr', 'Hosted-Seed!2026-Z', 'platform')).status, 401)
    assert.equal((await login('admin@3dmuse.demo', 'Hosted-Seed!2026-Z', 'tenant')).status, 401)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

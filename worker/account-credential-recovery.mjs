import { createHash, scryptSync } from 'node:crypto'

const RECOVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

export const HOSTED_ACCOUNT_RECOVERY_TARGETS = Object.freeze([
  Object.freeze({ id: 'USR-ONFACTORY-OPS', passwordEnvKey: 'ERP_OPERATOR_RECOVERY_PASSWORD' }),
  Object.freeze({ id: 'USR-3DMUSE-ADMIN', passwordEnvKey: 'ERP_3DMUSE_RECOVERY_PASSWORD' }),
])

export class HostedAccountRecoveryConfigurationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'HostedAccountRecoveryConfigurationError'
  }
}

function strongRecoveryPassword(value) {
  return typeof value === 'string'
    && value.length >= 12
    && value.length <= 72
    && !/\s/.test(value)
    && /[a-z]/.test(value)
    && /[A-Z]/.test(value)
    && /\d/.test(value)
    && /[^a-z0-9]/i.test(value)
    && value !== 'demo1234'
}

function passwordHash(password, accountId) {
  return scryptSync(password, `onfactory:${accountId}`, 32).toString('hex')
}

function recoveryConfiguration(runtimeEnv) {
  const versionValue = runtimeEnv?.ERP_ACCOUNT_RECOVERY_VERSION
  const version = typeof versionValue === 'string' ? versionValue.trim() : ''
  const configuredPasswords = HOSTED_ACCOUNT_RECOVERY_TARGETS.map((target) => ({
    ...target,
    password: runtimeEnv?.[target.passwordEnvKey],
  }))
  const hasAnyPassword = configuredPasswords.some((target) => typeof target.password === 'string' && target.password.length > 0)

  if (!version && !hasAnyPassword) return null
  if (!VERSION_PATTERN.test(version)) {
    throw new HostedAccountRecoveryConfigurationError('계정 복구 버전 설정이 올바르지 않습니다.')
  }
  for (const target of configuredPasswords) {
    if (!strongRecoveryPassword(target.password)) {
      throw new HostedAccountRecoveryConfigurationError(`${target.passwordEnvKey} 복구 secret이 안전한 형식으로 설정되지 않았습니다.`)
    }
  }
  const passwords = configuredPasswords.map((target) => target.password)
  if (new Set(passwords).size !== passwords.length) {
    throw new HostedAccountRecoveryConfigurationError('복구 대상 계정은 서로 다른 비밀번호를 사용해야 합니다.')
  }
  const seedPassword = typeof runtimeEnv?.ERP_SEED_PASSWORD === 'string' ? runtimeEnv.ERP_SEED_PASSWORD : ''
  if (seedPassword && passwords.includes(seedPassword)) {
    throw new HostedAccountRecoveryConfigurationError('복구 비밀번호는 공용 seed 비밀번호와 달라야 합니다.')
  }
  return { version, targets: configuredPasswords }
}

function recoveryClock(options) {
  const value = typeof options?.clock === 'function' ? options.clock() : new Date()
  const instant = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(instant.getTime())) {
    throw new HostedAccountRecoveryConfigurationError('계정 복구 시각을 확인할 수 없습니다.')
  }
  return instant
}

function isUnresolvedResetRequest(request, targetIds) {
  return targetIds.has(request?.accountId) && !request?.usedAt && !request?.revokedAt
}

/**
 * Replaces only the two explicitly named hosted demo credentials. The caller
 * must persist workspaceStore and sessions in the same CAS payload so the new
 * hashes, token revocation and session revocation are atomic.
 */
export function applyHostedAccountCredentialRecovery(workspaceStore, sessions, runtimeEnv, options = {}) {
  const configuration = recoveryConfiguration(runtimeEnv)
  if (!configuration) return { enabled: false, changed: false }
  if (!workspaceStore || typeof workspaceStore !== 'object' || Array.isArray(workspaceStore)) {
    throw new HostedAccountRecoveryConfigurationError('계정 복구 대상 저장소가 올바르지 않습니다.')
  }
  if (!(sessions instanceof Map)) {
    throw new HostedAccountRecoveryConfigurationError('계정 복구 세션 저장소가 올바르지 않습니다.')
  }
  if (workspaceStore.platform !== undefined && (!workspaceStore.platform || typeof workspaceStore.platform !== 'object' || Array.isArray(workspaceStore.platform))) {
    throw new HostedAccountRecoveryConfigurationError('계정 복구 플랫폼 저장소가 올바르지 않습니다.')
  }
  if (workspaceStore.accountCredentials !== undefined && (!workspaceStore.accountCredentials || typeof workspaceStore.accountCredentials !== 'object' || Array.isArray(workspaceStore.accountCredentials))) {
    throw new HostedAccountRecoveryConfigurationError('계정 자격 증명 저장소가 올바르지 않습니다.')
  }
  if (workspaceStore.passwordResetRequests !== undefined && !Array.isArray(workspaceStore.passwordResetRequests)) {
    throw new HostedAccountRecoveryConfigurationError('비밀번호 재설정 요청 저장소가 올바르지 않습니다.')
  }
  const platform = workspaceStore.platform ?? {}
  if (platform.auditEvents !== undefined && !Array.isArray(platform.auditEvents)) {
    throw new HostedAccountRecoveryConfigurationError('플랫폼 감사 저장소가 올바르지 않습니다.')
  }
  const previousMarker = platform.accountCredentialRecovery
  if (previousMarker?.version === configuration.version) {
    return {
      enabled: true,
      changed: false,
      version: configuration.version,
      targetAccountIds: HOSTED_ACCOUNT_RECOVERY_TARGETS.map((target) => target.id),
    }
  }

  const instant = recoveryClock(options)
  const appliedAt = instant.toISOString()
  const expiresAt = new Date(instant.getTime() + RECOVERY_WINDOW_MS).toISOString()
  const targetIds = new Set(HOSTED_ACCOUNT_RECOVERY_TARGETS.map((target) => target.id))
  const nextCredentials = {
    ...(workspaceStore.accountCredentials ?? {}),
  }

  for (const target of configuration.targets) {
    nextCredentials[target.id] = {
      passwordHash: passwordHash(target.password, target.id),
      mustChangePassword: true,
      temporaryPasswordExpiresAt: expiresAt,
      issuedAt: appliedAt,
      recoveryVersion: configuration.version,
    }
  }

  const revokedSessionTokens = []
  for (const [token, session] of sessions.entries()) {
    if (!targetIds.has(session?.accountId)) continue
    revokedSessionTokens.push(token)
  }

  const resetRequests = workspaceStore.passwordResetRequests ?? []
  let revokedResetRequestCount = 0
  const nextResetRequests = resetRequests.map((request) => {
    if (!isUnresolvedResetRequest(request, targetIds)) return request
    revokedResetRequestCount += 1
    return {
      ...request,
      status: 'revoked',
      revokedAt: appliedAt,
      revokedReason: 'hosted-account-recovery',
    }
  })

  const auditEvents = platform.auditEvents ?? []
  const auditId = createHash('sha256').update(configuration.version).digest('hex').slice(0, 16)
  workspaceStore.accountCredentials = nextCredentials
  workspaceStore.passwordResetRequests = nextResetRequests
  workspaceStore.platform = platform
  platform.auditEvents = [{
    id: `AUD-ACCOUNT-RECOVERY-${auditId}`,
    tenantId: null,
    at: appliedAt,
    event: '운영 계정 자격 증명 복구',
    scope: HOSTED_ACCOUNT_RECOVERY_TARGETS.map((target) => target.id).join(' · '),
    actor: 'system:deployment-recovery',
    result: '완료',
    reference: configuration.version,
  }, ...auditEvents].slice(0, 5_000)
  platform.accountCredentialRecovery = {
    version: configuration.version,
    appliedAt,
    targetAccountIds: HOSTED_ACCOUNT_RECOVERY_TARGETS.map((target) => target.id),
    mustChangePassword: true,
    temporaryPasswordExpiresAt: expiresAt,
  }
  for (const token of revokedSessionTokens) sessions.delete(token)

  return {
    enabled: true,
    changed: true,
    version: configuration.version,
    targetAccountIds: [...targetIds],
    revokedSessionCount: revokedSessionTokens.length,
    revokedResetRequestCount,
    temporaryPasswordExpiresAt: expiresAt,
  }
}

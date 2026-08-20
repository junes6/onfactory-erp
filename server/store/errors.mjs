export class StoreConfigurationError extends Error {
  constructor(message, code = 'STORE_CONFIGURATION_ERROR', cause) {
    super(message, cause ? { cause } : undefined)
    this.name = 'StoreConfigurationError'
    this.code = code
  }
}

export class UnknownWorkspaceKeyError extends Error {
  constructor(key, tenantId) {
    super(`지원하지 않는 workspace key가 감지되었습니다: ${key}${tenantId ? ` (${tenantId})` : ''}`)
    this.name = 'UnknownWorkspaceKeyError'
    this.code = 'UNKNOWN_WORKSPACE_KEY'
    this.key = key
    this.tenantId = tenantId
  }
}

export class ReadOnlyStoreError extends Error {
  constructor(message = '현재 저장소는 읽기 전용입니다. Postgres 연결을 복구하거나 STORE_JSON_READONLY=false를 명시해 주세요.') {
    super(message)
    this.name = 'ReadOnlyStoreError'
    this.code = 'STORE_READ_ONLY'
  }
}

export class StoreVerificationError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'StoreVerificationError'
    this.code = 'STORE_VERIFICATION_FAILED'
    this.details = details
  }
}


import path from 'node:path'

import { STORE_BACKENDS } from './constants.mjs'
import { StoreConfigurationError } from './errors.mjs'
import { JsonStoreAdapter } from './json-store.mjs'
import { PostgresStoreAdapter } from './postgres-store.mjs'

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (String(value).toLowerCase() === 'true') return true
  if (String(value).toLowerCase() === 'false') return false
  throw new StoreConfigurationError(`boolean 환경변수 값이 올바르지 않습니다: ${value}`)
}

// 읽기 전용은 STORE_READ_ONLY=1(또는 true)을 명시했을 때만이다. 환경변수가 없는
// 기본 기동은 항상 읽기·쓰기 JSON(원자적 저장)으로 동작해야 한다 — 과거에는 폴백이
// 읽기 전용으로 기동되어 모든 쓰기가 STORE_WRITE_FAILED로 실패하는 회귀가 있었다.
function explicitReadOnly(options) {
  if (options.jsonReadOnly !== undefined && options.jsonReadOnly !== null) return parseBoolean(options.jsonReadOnly, false)
  const flag = String(options.env.STORE_READ_ONLY ?? '').trim().toLowerCase()
  if (flag === '1' || flag === 'true') return true
  if (flag === '0' || flag === 'false') return false
  // 하위 호환: 예전 변수는 명시적으로 true일 때만 읽기 전용으로 존중한다.
  return String(options.env.STORE_JSON_READONLY ?? '').trim().toLowerCase() === 'true'
}

function jsonAdapter(options, fallbackReason = null) {
  const readOnly = explicitReadOnly(options)
  return new JsonStoreAdapter({ file: options.workspaceStoreFile, readOnly, fallbackReason })
}

export async function createStoreAdapter(options = {}) {
  const env = options.env ?? process.env
  const requestedBackend = String(options.backend ?? env.STORE_BACKEND ?? 'postgres').trim().toLowerCase()
  if (!STORE_BACKENDS.has(requestedBackend)) {
    throw new StoreConfigurationError(`STORE_BACKEND는 postgres 또는 json이어야 합니다: ${requestedBackend}`)
  }
  const normalizedOptions = {
    ...options,
    env,
    workspaceStoreFile: options.workspaceStoreFile
      ? path.resolve(options.workspaceStoreFile)
      : path.resolve(env.WORKSPACE_STORE_FILE?.trim() || 'server/data/workspace-state.json'),
  }

  if (requestedBackend === 'json') return jsonAdapter(normalizedOptions)

  const databaseUrl = options.databaseUrl ?? env.DATABASE_URL?.trim()
  if (!databaseUrl && !options.pool) {
    return jsonAdapter(normalizedOptions, 'DATABASE_URL이 없어 로컬 JSON 저장소(읽기·쓰기)를 사용합니다.')
  }

  const postgres = new PostgresStoreAdapter({
    databaseUrl,
    pool: options.pool,
    schemaPath: options.schemaPath,
    autoMigrate: options.autoMigrate ?? parseBoolean(env.STORE_AUTO_MIGRATE, false),
    logger: options.logger,
  })
  try {
    await postgres.connect()
    return postgres
  } catch (error) {
    try { await postgres.close() } catch { /* original connection failure wins */ }
    if (parseBoolean(options.allowJsonFallback ?? env.STORE_ALLOW_JSON_FALLBACK, true) === false) throw error
    return jsonAdapter(normalizedOptions, `Postgres 연결 실패로 로컬 JSON 저장소(읽기·쓰기)를 사용합니다: ${error.message}`)
  }
}

export async function initializeRuntimeStore(options = {}) {
  const adapter = await createStoreAdapter(options)
  const workspaceStore = await adapter.loadSnapshot()
  const sessions = await adapter.createSessionMap()
  return { adapter, workspaceStore, sessions }
}

export { JsonStoreAdapter } from './json-store.mjs'
export { PostgresStoreAdapter } from './postgres-store.mjs'
export { ReadOnlyStoreError, StoreConfigurationError, StoreVerificationError, UnknownWorkspaceKeyError } from './errors.mjs'
export { WORKSPACE_KEYS, WORKSPACE_TABLES } from './constants.mjs'


import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

import { emptyWorkspaceStore } from './constants.mjs'
import { ReadOnlyStoreError, StoreVerificationError } from './errors.mjs'
import { assertKnownWorkspaceKeys } from './workspace-codec.mjs'

function parseStore(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  if (!parsed || ![1, 2].includes(parsed.version) || !parsed.tenants || typeof parsed.tenants !== 'object') {
    throw new StoreVerificationError('지원하지 않는 JSON workspace 저장소 형식입니다.')
  }
  parsed.version = 2
  parsed.platform ??= { tenants: [], supportTickets: [], integrations: [], actions: [], auditEvents: [] }
  for (const key of ['tenants', 'supportTickets', 'integrations', 'actions', 'auditEvents']) parsed.platform[key] ??= []
  parsed.personal ??= {}
  parsed.accountApprovals ??= {}
  parsed.accountCredentials ??= {}
  parsed.invitedAccounts ??= []
  parsed.passwordResetRequests ??= []
  assertKnownWorkspaceKeys(parsed)
  return parsed
}

function readJsonWithBackup(file) {
  if (!file) return emptyWorkspaceStore()
  const backupFile = `${file}.bak`
  if (!existsSync(file)) return existsSync(backupFile) ? parseStore(backupFile) : emptyWorkspaceStore()
  try {
    return parseStore(file)
  } catch (primaryError) {
    if (!existsSync(backupFile)) throw primaryError
    try {
      return parseStore(backupFile)
    } catch (backupError) {
      throw new StoreVerificationError(`JSON 저장소와 백업이 모두 손상되었습니다: ${primaryError.message}; ${backupError.message}`)
    }
  }
}

function writeAndSync(file, contents) {
  writeFileSync(file, contents, { encoding: 'utf8', mode: 0o600 })
  const descriptor = openSync(file, 'r+')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function persistJson(file, store) {
  if (!file) return
  assertKnownWorkspaceKeys(store)
  mkdirSync(path.dirname(file), { recursive: true })
  const serialized = JSON.stringify(store, null, 2)
  const temporaryFile = `${file}.${process.pid}.${Date.now()}.tmp`
  const backupFile = `${file}.bak`
  const temporaryBackup = `${backupFile}.${process.pid}.tmp`
  try {
    writeAndSync(temporaryFile, serialized)
    if (existsSync(file)) {
      const previous = readFileSync(file, 'utf8')
      JSON.parse(previous)
      writeAndSync(temporaryBackup, previous)
      renameSync(temporaryBackup, backupFile)
    }
    renameSync(temporaryFile, file)
  } catch (error) {
    for (const candidate of [temporaryFile, temporaryBackup]) {
      try { if (existsSync(candidate)) unlinkSync(candidate) } catch { /* preserve original error */ }
    }
    throw error
  }
}

export class JsonStoreAdapter {
  constructor({ file, readOnly = true, fallbackReason = null } = {}) {
    this.kind = 'json'
    this.file = file || null
    this.readOnly = readOnly
    this.fallbackReason = fallbackReason
    this.snapshot = null
  }

  async loadSnapshot() {
    this.snapshot = readJsonWithBackup(this.file)
    return structuredClone(this.snapshot)
  }

  commitSnapshot(nextSnapshot) {
    if (this.readOnly) throw new ReadOnlyStoreError()
    assertKnownWorkspaceKeys(nextSnapshot)
    persistJson(this.file, nextSnapshot)
    this.snapshot = structuredClone(nextSnapshot)
  }

  async createSessionMap() {
    return new Map()
  }

  async close() {}
}

export { parseStore as parseJsonWorkspaceStore, persistJson as persistJsonWorkspaceStore, readJsonWithBackup }


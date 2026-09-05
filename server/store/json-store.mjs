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
  // 게스트 grant가 없는 옛 파일도 그대로 열린다(빈 배열로 채운다).
  parsed.guestGrants ??= []
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

  // 게스트 GET 라우트가 메모리 필터 결과 id를 넘겨 DB(RLS)와 교집합을 구하는 계약이다.
  // JSON 저장소에는 RLS가 없으므로 앱 필터 결과를 그대로 돌려준다 — 여기서 더 자르면
  // JSON 모드와 PG 모드의 응답이 달라진다.
  async guestVisibleIds({ candidateIds } = {}) {
    return Array.isArray(candidateIds) ? candidateIds.filter((id) => typeof id === 'string') : []
  }

  async close() {}
}

export { parseStore as parseJsonWorkspaceStore, persistJson as persistJsonWorkspaceStore, readJsonWithBackup }


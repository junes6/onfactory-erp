import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

import { emptyWorkspaceStore } from './constants.mjs'
import { ReadOnlyStoreError, StoreVerificationError } from './errors.mjs'
import { PersistentSessionMap } from './persistent-session-map.mjs'
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

/**
 * 본 파일 → 백업 순으로 읽고, **어디서 읽었는지**를 함께 돌려준다.
 * 백업으로 넘어갔다는 것은 한 세대를 되감았다는 뜻이다 — 운영 콘솔이 그 사실을 말할 수 있어야 한다.
 */
function readJsonDetailed(file) {
  if (!file) return { store: emptyWorkspaceStore(), source: 'empty', primaryError: null }
  const backupFile = `${file}.bak`
  if (!existsSync(file)) {
    if (!existsSync(backupFile)) return { store: emptyWorkspaceStore(), source: 'empty', primaryError: null }
    console.warn('[json-store] 기본 파일이 없어 마지막 백업으로 시작합니다.', { file })
    return { store: parseStore(backupFile), source: 'backup', primaryError: '기본 파일이 없습니다.' }
  }
  try {
    return { store: parseStore(file), source: 'main', primaryError: null }
  } catch (primaryError) {
    // 파일 잠금·중단된 쓰기·손상 중 무엇이었는지 다음에도 알 수 있게 한 줄은 남긴다.
    console.warn('[json-store] 기본 파일을 읽지 못해 백업으로 되감습니다.', { file, message: primaryError?.message })
    if (!existsSync(backupFile)) throw primaryError
    try {
      return { store: parseStore(backupFile), source: 'backup', primaryError: primaryError?.message ?? String(primaryError) }
    } catch (backupError) {
      throw new StoreVerificationError(`JSON 저장소와 백업이 모두 손상되었습니다: ${primaryError.message}; ${backupError.message}`)
    }
  }
}

function readJsonWithBackup(file) {
  return readJsonDetailed(file).store
}

function writeAndSync(file, contents) {
  writeFileSync(file, contents, { encoding: 'utf8', mode: 0o600 })
  // Windows는 FlushFileBuffers/fsync에 쓰기 가능한 핸들이 필요하다.
  const descriptor = openSync(file, 'r+')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

const corruptStamp = (now = new Date()) => now.toISOString().replace(/[:.]/g, '-')

/**
 * 원자적 저장 + 백업 회전 — JSON 저장소와 app.mjs의 파일 저장이 같이 쓰는 하나의 구현.
 *
 * 1) 새 내용을 임시 파일에 쓰고 fsync한다.
 * 2) 지금 본 파일을 `.bak`으로 **이름만 바꿔** 회전한다. 이 프로세스가 직접 쓴 본 파일은 이미 검증된 것이라
 *    다시 읽어 파싱하지 않는다(전에는 쓰기마다 본 파일 전체를 다시 읽고 파싱해 이벤트 루프를 수십~수백 ms 멈췄다).
 * 3) 이 프로세스가 쓴 적 없는 본 파일(기동 직후)은 한 번 검증한다. **깨져 있으면 `.corrupt-<시각>`으로 옮겨 보존하고
 *    `.bak`(마지막 정상본)은 건드리지 않는다.** 전에는 검증 실패가 쓰기 전체를 던져, 백업으로 기동한 뒤의
 *    모든 저장이 영구히 실패했다(2026-09-18 감사 data-core-03).
 * 4) 임시 파일을 본 파일 자리로 옮긴다. 2)와 4) 사이에 멈추면 본 파일이 없고 `.bak`이 직전 정상본이다 — 읽기가 그것으로 시작한다.
 *
 * @param {{ mainVerified?: boolean }} state 파일마다 하나. 이 프로세스가 본 파일을 썼거나 검증했으면 true.
 * @returns {{ quarantined: string | null }}
 */
export function writeJsonAtomically(file, serialized, state = {}, { now = new Date() } = {}) {
  mkdirSync(path.dirname(file), { recursive: true })
  const temporaryFile = `${file}.${process.pid}.${Date.now()}.tmp`
  const backupFile = `${file}.bak`
  let quarantined = null
  try {
    writeAndSync(temporaryFile, serialized)
    if (existsSync(file)) {
      // 파일이 아닌 것(폴더 등)은 "깨진 파일"로 치워 두지 않는다 — 저장 자체가 실패해야 부르는 쪽이 되돌린다.
      if (!statSync(file).isFile()) throw new Error(`저장 파일 자리에 파일이 아닌 것이 있습니다: ${path.basename(file)}`)
      let verified = state.mainVerified === true
      if (!verified) {
        try { JSON.parse(readFileSync(file, 'utf8')); verified = true } catch { verified = false }
      }
      if (verified) {
        renameSync(file, backupFile)
      } else {
        quarantined = `${file}.corrupt-${corruptStamp(now)}`
        renameSync(file, quarantined)
        console.error('[json-store] 깨진 본 파일을 보존하고 새로 씁니다. 마지막 정상 백업(.bak)은 그대로 둡니다.', { quarantined })
      }
    }
    renameSync(temporaryFile, file)
    state.mainVerified = true
    return { quarantined }
  } catch (error) {
    try { if (existsSync(temporaryFile)) unlinkSync(temporaryFile) } catch { /* 원래 오류를 남긴다 */ }
    throw error
  }
}

/**
 * 저장 도중 프로세스가 끊겨(강제 종료·정전) 남은 임시 파일을 치운다. 이름 모양이 정확히 우리 것
 * (`<파일>.<pid>.<시각>.tmp`)이고, 지금 프로세스의 것이 아니며, 한 시간 넘게 지난 것만. 본 파일과 .bak은 건드리지 않는다.
 */
export function cleanStaleTemporaryFiles(file, { now = Date.now(), maxAgeMs = 60 * 60 * 1_000 } = {}) {
  if (!file) return []
  const directory = path.dirname(file)
  const base = path.basename(file)
  const pattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d+)\\.(\\d+)\\.tmp$`)
  const removed = []
  let names = []
  try { names = readdirSync(directory) } catch { return removed }
  for (const name of names) {
    const match = pattern.exec(name)
    if (!match || Number(match[1]) === process.pid) continue
    const target = path.join(directory, name)
    try {
      if (now - statSync(target).mtimeMs < maxAgeMs) continue
      unlinkSync(target)
      removed.push(name)
    } catch { /* 지우지 못하면 다음 기동 때 다시 본다 */ }
  }
  if (removed.length) console.warn('[json-store] 끊긴 저장이 남긴 임시 파일을 치웠습니다.', { removed })
  return removed
}

function persistJson(file, store, state = {}) {
  if (!file) return { quarantined: null }
  assertKnownWorkspaceKeys(store)
  return writeJsonAtomically(file, JSON.stringify(store, null, 2), state)
}

/**
 * JSON 모드 세션 파일. **토큰 원문은 저장하지 않는다** — PersistentSessionMap이 키를 SHA-256 해시로 바꾼다.
 * 전에는 JSON 모드 세션이 메모리에만 있어 서버를 다시 켤 때마다(코드 반영마다) 전원이 로그아웃됐다.
 */
export function sessionsFileFor(workspaceFile) {
  return workspaceFile ? path.join(path.dirname(workspaceFile), 'sessions.json') : null
}

function readSessionEntries(file, now = Date.now()) {
  if (!file || !existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const sessions = parsed && typeof parsed.sessions === 'object' ? parsed.sessions : {}
    return Object.entries(sessions).filter(([hash, session]) => /^[0-9a-f]{64}$/.test(hash)
      && session && typeof session.accountId === 'string' && Number(session.expiresAt) > now)
  } catch (error) {
    // 세션 파일이 깨졌다고 서버가 못 뜨면 안 된다. 모두 다시 로그인하면 될 뿐이다.
    console.warn('[json-store] 세션 파일을 읽지 못해 빈 세션으로 시작합니다.', { message: error?.message })
    return []
  }
}

export class JsonStoreAdapter {
  constructor({ file, readOnly = true, fallbackReason = null } = {}) {
    this.kind = 'json'
    this.file = file || null
    this.readOnly = readOnly
    this.fallbackReason = fallbackReason
    this.writeState = { mainVerified: false }
    /** 운영 콘솔이 읽는 저장소 건강 상태. */
    this.health = { loadedFrom: 'empty', loadError: null, quarantined: [], lastCommitError: null, lastCommitAt: null }
  }

  async loadSnapshot() {
    if (!this.readOnly) cleanStaleTemporaryFiles(this.file)
    const { store, source, primaryError } = readJsonDetailed(this.file)
    this.health.loadedFrom = source
    this.health.loadError = primaryError
    // 본 파일에서 읽었으면 그 파일은 정상이다. 백업에서 읽었으면 본 파일은 다음 쓰기 때 검증(깨졌으면 보존)한다.
    this.writeState.mainVerified = source === 'main'
    return store
  }

  commitSnapshot(nextSnapshot) {
    if (this.readOnly) throw new ReadOnlyStoreError()
    try {
      const { quarantined } = persistJson(this.file, nextSnapshot, this.writeState)
      if (quarantined) this.health.quarantined = [...this.health.quarantined, quarantined].slice(-10)
      this.health.lastCommitError = null
      this.health.lastCommitAt = new Date().toISOString()
    } catch (error) {
      this.health.lastCommitError = { at: new Date().toISOString(), message: error?.message ?? String(error) }
      throw error
    }
  }

  async createSessionMap() {
    const file = sessionsFileFor(this.file)
    if (!file || this.readOnly) return new Map()
    const map = new PersistentSessionMap(readSessionEntries(file))
    const state = { mainVerified: false }
    // 세션은 수가 적고(로그인·운영자 진입·한 시간에 한 번의 연장) 로그인 응답이 flush를 기다린다 — 바로 쓴다.
    const write = () => {
      const now = Date.now()
      const sessions = {}
      for (const [hash, session] of Map.prototype.entries.call(map)) if (Number(session?.expiresAt) > now) sessions[hash] = session
      writeJsonAtomically(file, JSON.stringify({ version: 1, sessions }), state)
    }
    map.onSet = () => write()
    map.onDelete = () => write()
    return map
  }

  // 게스트 GET 라우트가 메모리 필터 결과 id를 넘겨 DB(RLS)와 교집합을 구하는 계약이다.
  // JSON 저장소에는 RLS가 없으므로 앱 필터 결과를 그대로 돌려준다 — 여기서 더 자르면
  // JSON 모드와 PG 모드의 응답이 달라진다.
  async guestVisibleIds({ candidateIds } = {}) {
    return Array.isArray(candidateIds) ? candidateIds.filter((id) => typeof id === 'string') : []
  }

  async close() {}
}

export { parseStore as parseJsonWorkspaceStore, persistJson as persistJsonWorkspaceStore, readJsonDetailed, readJsonWithBackup }

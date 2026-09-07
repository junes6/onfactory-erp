import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * 백업 이중화 — 교차 보관.
 *
 *   1차) 업무 데이터 덤프  → NAS 경로 (BACKUP_NAS_DIRECTORY)
 *   2차) 파일 원본 + 같은 덤프 → 클라우드 버킷 (S3 호환)
 *
 * 한쪽이 통째로 사라져도 반대편에 전일자까지 남는다. NAS가 죽으면 클라우드에 덤프와 파일이,
 * 클라우드가 죽으면 NAS에 덤프가 있고 파일 원본은 운영 스토리지에 그대로 있다.
 * 실행 주기·대상·보관 세대 수는 모두 환경변수로 정한다.
 */
export const BACKUP_STATUS_KEY = 'backupStatus'
const DEFAULT_RETENTION = 14
const DEFAULT_HOUR = 3
/**
 * 백업 세트가 **어느 데이터 디렉터리의 것인지** 적어 두는 표식. NAS 디렉터리 바로 아래에 둔다.
 *
 * 왜 필요한가: 개발·시험 실행이 ONFACTORY_DATA_DIRECTORY만 임시 폴더로 바꿔 놓고 .env의
 * BACKUP_ENABLED=1 · BACKUP_NAS_DIRECTORY는 그대로 물려받으면, **빈 임시 폴더의 덤프가 실제
 * 백업 세트에 세대로 들어가고** 보관 세대 수를 넘긴 진짜 백업이 그 자리에서 지워진다.
 * 실제로 이 저장소에서 14KB짜리 세대 두 개가 1.7MB짜리 진짜 세대들 위에 쌓였다.
 * 세대 안의 BACKUP_INFO.json에도 source가 적히지만 그것은 **쓰고 난 뒤의 기록**이라 아무것도 막지 못한다.
 */
export const BACKUP_SET_MARKER = 'BACKUP_SET.json'

export class BackupError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined)
    this.name = 'BackupError'
    this.code = code
  }
}

export function backupSettings(env = process.env) {
  const retention = Number.parseInt(String(env.BACKUP_RETENTION_GENERATIONS ?? ''), 10)
  const hour = Number.parseInt(String(env.BACKUP_SCHEDULE_HOUR ?? ''), 10)
  const intervalHours = Number.parseInt(String(env.BACKUP_INTERVAL_HOURS ?? ''), 10)
  return {
    enabled: String(env.BACKUP_ENABLED ?? '').trim() === '1',
    nasDirectory: String(env.BACKUP_NAS_DIRECTORY ?? '').trim(),
    cloudBucket: String(env.BACKUP_CLOUD_BUCKET ?? '').trim(),
    cloudPrefix: String(env.BACKUP_CLOUD_PREFIX ?? 'inthefield-backup').trim(),
    retention: Number.isFinite(retention) && retention > 0 ? Math.min(retention, 400) : DEFAULT_RETENTION,
    scheduleHour: Number.isFinite(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_HOUR,
    intervalHours: Number.isFinite(intervalHours) && intervalHours > 0 ? Math.min(intervalHours, 24 * 30) : 24,
  }
}

export function backupGenerationName(now = new Date()) {
  return `inthefield_${now.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')}`
}

function directorySize(target) {
  let total = 0
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name)
    total += entry.isDirectory() ? directorySize(child) : statSync(child).size
  }
  return total
}

function listFiles(root, base = root) {
  const files = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...listFiles(target, base))
    else files.push({ absolute: target, relative: path.relative(base, target).replaceAll('\\', '/') })
  }
  return files
}

/** 경로 비교용 정규화. 대소문자와 슬래시 방향, 뒤 슬래시가 달라도 같은 폴더는 같게 본다(윈도 NAS 마운트). */
const samePath = (left, right) => {
  const normalize = (value) => path.resolve(String(value ?? '')).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
  return normalize(left) === normalize(right)
}

/**
 * 이 백업 세트가 받아들이는 데이터 디렉터리를 정한다.
 *
 * - 표식이 없으면(첫 백업이거나 이 기능 이전의 세트) 지금 원본으로 세트를 연다.
 * - 표식이 있고 원본이 같으면 통과.
 * - 다르면 **아무것도 쓰지 않고 거절한다.** 여기서 통과시키면 진짜 백업이 보관 정리에 밀려 사라진다.
 *
 * 데이터 디렉터리를 정말로 옮겼다면 표식 파일을 지우거나 dataDirectory를 고쳐 다시 열면 된다 —
 * 오류 문구가 그 두 경로와 표식 파일 위치를 그대로 말해 준다.
 */
export function assertBackupSetSource(nasDirectory, dataDirectory, { now = new Date() } = {}) {
  const markerPath = path.join(nasDirectory, BACKUP_SET_MARKER)
  if (existsSync(markerPath)) {
    let recorded = null
    try { recorded = JSON.parse(readFileSync(markerPath, 'utf8')) } catch { recorded = null }
    const source = String(recorded?.dataDirectory ?? '').trim()
    // 읽지 못한 표식은 없는 것으로 보지 않는다 — 그렇게 하면 표식을 깨뜨리는 것이 곧 우회가 된다.
    if (!source) throw new BackupError('BACKUP_SET_MARKER_UNREADABLE', `백업 세트 표식을 읽지 못했습니다: ${markerPath}. 파일을 고치거나 지운 뒤 다시 실행해 주세요.`)
    if (!samePath(source, dataDirectory)) {
      throw new BackupError(
        'BACKUP_SET_SOURCE_MISMATCH',
        `이 백업 세트는 다른 데이터 디렉터리의 것입니다. 세트=${source} · 이번 실행=${path.resolve(dataDirectory)}. `
        + `시험용 데이터로 실제 백업을 덮어쓰지 않도록 중단했습니다. 정말 옮겼다면 ${markerPath} 를 지우고 다시 실행해 주세요.`,
      )
    }
    return { markerPath, opened: false }
  }
  mkdirSync(nasDirectory, { recursive: true })
  writeFileSync(markerPath, JSON.stringify({
    dataDirectory: path.resolve(dataDirectory),
    openedAt: now.toISOString(),
    note: '이 백업 세트는 위 데이터 디렉터리의 것입니다. 다른 원본의 백업은 거절됩니다.',
  }, null, 2))
  return { markerPath, opened: true }
}

/** 보관 세대 수를 넘긴 오래된 백업을 지운다. 지운 목록을 돌려준다. */
export function pruneGenerations(nasDirectory, retention) {
  if (!existsSync(nasDirectory)) return []
  const generations = readdirSync(nasDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('inthefield_'))
    .map((entry) => entry.name)
    .sort()
  const removable = generations.slice(0, Math.max(0, generations.length - retention))
  for (const name of removable) rmSync(path.join(nasDirectory, name), { recursive: true, force: true })
  return removable
}

/**
 * 한 번의 백업 사이클. 실패해도 예외를 밖으로 던지지 않고 결과 객체로 돌려주어,
 * 호출한 쪽이 콘솔 경고로 남길 수 있게 한다.
 */
export async function runBackupCycle({
  dataDirectory,
  settings,
  storage = null,
  now = new Date(),
  copyDirectory = cpSync,
} = {}) {
  const startedAt = now.toISOString()
  const result = {
    startedAt,
    finishedAt: '',
    ok: false,
    generation: backupGenerationName(now),
    nas: { ok: false, path: '', bytes: 0, error: '' },
    cloud: { ok: false, bucket: settings?.cloudBucket ?? '', objects: 0, error: '' },
    pruned: [],
    error: '',
  }
  try {
    if (!settings?.nasDirectory) throw new BackupError('BACKUP_NAS_NOT_CONFIGURED', 'BACKUP_NAS_DIRECTORY가 설정되지 않았습니다.')
    if (!dataDirectory || !existsSync(dataDirectory)) throw new BackupError('BACKUP_SOURCE_MISSING', `업무 데이터 디렉터리를 찾을 수 없습니다: ${dataDirectory}`)
    // 한 바이트도 쓰기 전에 본다. 세대 폴더를 만든 뒤에 걸리면 빈 세대가 남고 그것도 보관 정리에 센다.
    assertBackupSetSource(settings.nasDirectory, dataDirectory, { now })

    // 1차: 업무 데이터 덤프 → NAS
    const destination = path.join(settings.nasDirectory, result.generation)
    mkdirSync(destination, { recursive: true })
    copyDirectory(dataDirectory, destination, { recursive: true })
    const manifest = {
      generation: result.generation,
      createdAt: startedAt,
      source: dataDirectory,
      schemaVersion: 2,
      retention: settings.retention,
    }
    writeFileSync(path.join(destination, 'BACKUP_INFO.json'), JSON.stringify(manifest, null, 2))
    result.nas = { ok: true, path: destination, bytes: directorySize(destination), error: '' }
    result.pruned = pruneGenerations(settings.nasDirectory, settings.retention)
  } catch (error) {
    result.nas.error = error instanceof Error ? error.message : String(error)
    result.error = result.nas.error
    result.finishedAt = new Date(now.getTime()).toISOString()
    return result
  }

  // 2차: 같은 덤프를 클라우드 버킷에도 올린다 (교차 보관).
  if (!settings.cloudBucket || !storage) {
    result.cloud = { ok: false, bucket: settings.cloudBucket, objects: 0, error: settings.cloudBucket ? '클라우드 저장소 어댑터가 없습니다.' : '' }
  } else {
    try {
      let objects = 0
      for (const file of listFiles(result.nas.path)) {
        const body = readFileSync(file.absolute)
        await storage.put(`${settings.cloudPrefix}/${result.generation}/${file.relative}`, body, { contentType: 'application/octet-stream' })
        objects += 1
      }
      result.cloud = { ok: true, bucket: settings.cloudBucket, objects, error: '' }
    } catch (error) {
      result.cloud = { ok: false, bucket: settings.cloudBucket, objects: 0, error: error instanceof Error ? error.message : String(error) }
      result.error = result.cloud.error
    }
  }

  // NAS만 성공해도 "전일자까지 남는" 조건은 충족한다. 다만 미러 실패는 경고로 남긴다.
  result.ok = result.nas.ok
  result.finishedAt = new Date().toISOString()
  result.checksum = createHash('sha256').update(`${result.generation}:${result.nas.bytes}`).digest('hex').slice(0, 16)
  return result
}

/** 콘솔이 읽는 상태. 마지막 성공 시각과 마지막 실패 이유를 함께 남긴다. */
export function nextBackupStatus(previous, result) {
  const base = previous && typeof previous === 'object' ? previous : {}
  const warning = !result.ok
    ? `백업 실패 — ${result.error || '알 수 없는 오류'}`
    : result.cloud.error
      ? `클라우드 미러 실패 — ${result.cloud.error}`
      : ''
  return {
    lastAttemptAt: result.finishedAt || result.startedAt,
    lastSuccessAt: result.ok ? (result.finishedAt || result.startedAt) : (base.lastSuccessAt ?? ''),
    lastGeneration: result.ok ? result.generation : (base.lastGeneration ?? ''),
    lastError: result.ok ? '' : (result.error || '알 수 없는 오류'),
    warning,
    nas: result.nas,
    cloud: result.cloud,
    prunedCount: result.pruned.length,
    consecutiveFailures: result.ok ? 0 : (Number(base.consecutiveFailures) || 0) + 1,
  }
}

/** 다음 실행까지 남은 밀리초. 지정한 시각(KST)을 지나면 다음 날로 넘어간다. */
export function millisecondsUntilNextRun(settings, now = new Date()) {
  const seoulNow = new Date(now.getTime() + 9 * 60 * 60 * 1_000)
  const target = new Date(seoulNow)
  target.setUTCHours(settings.scheduleHour, 0, 0, 0)
  if (target <= seoulNow) target.setUTCDate(target.getUTCDate() + 1)
  return target.getTime() - seoulNow.getTime()
}

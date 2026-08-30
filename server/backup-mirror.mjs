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

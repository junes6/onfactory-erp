import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { backupSettings } from './backup-mirror.mjs'
import { parseJsonWorkspaceStore } from './store/json-store.mjs'

/**
 * 백업 한 세대를 업무 데이터 디렉터리로 되돌린다.
 *
 * **어디서 복원할 수 있는가**: 두 곳을 받는다.
 *   1) `server/backups/…`      — `backup:data`가 만드는 로컬 사본(클라우드에서 내려받은 세대도 여기에 둔다)
 *   2) `BACKUP_NAS_DIRECTORY/…` — 야간 배치가 쌓는 진짜 백업 세트(server/backup-mirror.mjs)
 *
 * **어떻게 되돌리는가**(2026-09-18 감사 data-core-12):
 *   - 서버가 켜져 있으면 거절한다. 켜진 서버는 메모리의 상태를 다음 쓰기 때 파일에 다시 써서 복원본을 덮는다.
 *     전에는 README의 "서버를 멈춥니다" 한 줄에만 기댔다.
 *   - 병합 복사가 아니라 **교체**다. 전에는 cpSync(force)로 덮어써, 백업 이후 생긴 파일(새 첨부 등)이 그대로 남았다.
 *     임시 폴더에 풀어 workspace-state.json을 검증한 뒤, 지금 폴더를 `.before-restore-<시각>`으로 옮기고
 *     임시 폴더를 제자리로 옮긴다. 옮겨 둔 폴더가 곧 **복원 직전 자동 백업**이다 — 되돌리려면 이름만 바꾸면 된다.
 */

/** 이 폴더가 업무 데이터 덤프인가. 백업 세대에는 언제나 이 파일이 있다. */
export const looksLikeBackup = (directory) => existsSync(path.join(directory, 'workspace-state.json'))

/** 서버가 데이터 디렉터리에 남기는 잠금 파일. 복원이 켜진 서버를 알아본다. */
export const SERVER_LOCK_FILE = 'server.lock'

/**
 * `--from=` 값을 판정한다. 되돌려 주는 것은 결정이지 부수효과가 아니다 — 그래서 시험할 수 있다.
 * @returns {{ ok: true, source: string, root: string } | { ok: false, reason: string, message: string }}
 */
export function resolveRestoreSource(from, { env = process.env, cwd = process.cwd() } = {}) {
  const roots = [
    { name: 'server/backups', directory: path.resolve(cwd, 'server/backups') },
    ...(backupSettings(env).nasDirectory ? [{ name: 'BACKUP_NAS_DIRECTORY', directory: path.resolve(backupSettings(env).nasDirectory) }] : []),
  ]
  const usage = `사용법: node server/restore-data.mjs --from=<백업 세대 폴더>\n`
    + `복원 소스는 다음 아래의 백업 세대여야 합니다:\n`
    + roots.map((root) => `  · ${root.name} → ${root.directory}`).join('\n')
    + (backupSettings(env).nasDirectory ? '' : '\n  (BACKUP_NAS_DIRECTORY가 설정되지 않아 NAS 경로는 받지 않습니다.)')
    + '\n클라우드 버킷에서 내려받은 세대는 server/backups 아래에 두고 지목하세요.'

  if (!from) return { ok: false, reason: 'MISSING', message: usage }
  const source = path.resolve(cwd, from)
  const root = roots.find((candidate) => {
    const relative = path.relative(candidate.directory, source)
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  })
  if (!root) return { ok: false, reason: 'OUTSIDE_ROOTS', message: `${usage}\n받은 경로: ${source}` }
  if (!existsSync(source)) return { ok: false, reason: 'NOT_FOUND', message: `그 백업 세대를 찾을 수 없습니다: ${source}` }
  if (!looksLikeBackup(source)) {
    const siblings = existsSync(root.directory) ? readdirSync(root.directory).filter((name) => /^(inthefield|onfactory)_/.test(name)).slice(-3) : []
    return {
      ok: false,
      reason: 'NOT_A_BACKUP',
      message: `${source} 안에 workspace-state.json이 없습니다 — 백업 세대 폴더가 아닙니다.`
        + (siblings.length ? `\n${root.name}의 최근 세대: ${siblings.join(', ')}` : ''),
    }
  }
  return { ok: true, source, root: root.name }
}

/** 복원 대상. 저장소가 읽는 것과 같은 환경변수를 본다. */
export const restoreDestination = ({ env = process.env, cwd = process.cwd() } = {}) => path.resolve(
  cwd,
  env.ONFACTORY_DATA_DIRECTORY?.trim()
  || (env.WORKSPACE_STORE_FILE?.trim() ? path.dirname(env.WORKSPACE_STORE_FILE.trim()) : 'server/data'),
)

const processAlive = (pid) => {
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

/** 데이터 디렉터리를 쓰는 서버가 켜져 있는가. 잠금 파일의 pid가 살아 있으면 켜져 있다. */
export function runningServer(destination, { alive = processAlive } = {}) {
  const lock = path.join(destination, SERVER_LOCK_FILE)
  if (!existsSync(lock)) return null
  try {
    const recorded = JSON.parse(readFileSync(lock, 'utf8'))
    const pid = Number(recorded?.pid)
    return Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid) ? { pid, port: recorded.port ?? null } : null
  } catch {
    return null
  }
}

const stampOf = (now) => now.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')

/**
 * 복원 한 번. 되돌려 주는 것은 결과이고, 실패하면 데이터 디렉터리는 손대지 않은 그대로다.
 * @returns {{ ok: true, destination: string, previous: string | null } | { ok: false, reason: string, message: string }}
 */
export function performRestore({ source, destination, now = new Date(), alive = processAlive, copyDirectory = cpSync }) {
  const running = runningServer(destination, { alive })
  if (running) {
    return { ok: false, reason: 'SERVER_RUNNING', message: `서버가 켜져 있습니다(pid ${running.pid}${running.port ? ` · 포트 ${running.port}` : ''}). 켜진 서버는 복원본을 다음 저장 때 덮어씁니다 — 서버를 먼저 멈춘 뒤 다시 실행하세요. 서버가 꺼져 있는데도 이 문구가 나오면 데이터 폴더의 ${SERVER_LOCK_FILE}을 지우고 다시 실행하세요.` }
  }
  const stamp = stampOf(now)
  const staging = `${destination}.restoring-${stamp}`
  const previous = existsSync(destination) ? `${destination}.before-restore-${stamp}` : null
  try {
    mkdirSync(path.dirname(destination), { recursive: true })
    copyDirectory(source, staging, {
      recursive: true,
      errorOnExist: true,
      filter: (file) => !['sessions.json', 'sessions.json.bak', SERVER_LOCK_FILE].includes(path.basename(file)) && !file.endsWith('.tmp'),
    })
    // 풀어 놓은 것이 정말 읽히는 저장소인가 — 교체하기 전에 본다.
    parseJsonWorkspaceStore(path.join(staging, 'workspace-state.json'))
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    return { ok: false, reason: 'STAGING_FAILED', message: `백업을 풀어 검증하지 못했습니다(데이터 디렉터리는 그대로입니다): ${error?.message ?? error}` }
  }
  try {
    if (previous) renameSync(destination, previous)
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    return { ok: false, reason: 'DESTINATION_LOCKED', message: `지금 데이터 디렉터리를 옮기지 못했습니다(다른 프로그램이 열고 있을 수 있습니다). 아무것도 바꾸지 않았습니다: ${error?.message ?? error}` }
  }
  try {
    renameSync(staging, destination)
  } catch (error) {
    // 제자리로 되돌린다 — 데이터 디렉터리가 비어 있는 상태로 끝내지 않는다.
    if (previous) renameSync(previous, destination)
    rmSync(staging, { recursive: true, force: true })
    return { ok: false, reason: 'SWAP_FAILED', message: `복원본을 제자리로 옮기지 못해 원래대로 되돌렸습니다: ${error?.message ?? error}` }
  }
  return { ok: true, destination, previous }
}

// 직접 실행했을 때만 움직인다. import는 아무것도 하지 않는다(시험이 이 파일을 읽을 수 있게).
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const from = process.argv.find((value) => value.startsWith('--from='))?.slice('--from='.length) ?? ''
  const resolved = resolveRestoreSource(from)
  const destination = restoreDestination()

  if (!resolved.ok) {
    console.error(resolved.message)
    process.exitCode = 1
  } else if (existsSync(destination) && process.env.CONFIRM_RESTORE !== 'YES') {
    console.error(`복원 대상 ${destination}에 기존 데이터가 있습니다.`)
    console.error('지금 데이터는 지우지 않고 옆 폴더(.before-restore-<시각>)로 옮겨 둡니다. 진행하려면 CONFIRM_RESTORE=YES를 명시하세요.')
    process.exitCode = 1
  } else {
    const result = performRestore({ source: resolved.source, destination })
    if (!result.ok) {
      console.error(`[restore] ${result.message}`)
      process.exitCode = 1
    } else {
      console.log(`[restore] completed (${resolved.root}): ${resolved.source} -> ${destination}`)
      if (result.previous) console.log(`[restore] 복원 전 데이터는 ${result.previous} 에 그대로 있습니다. 되돌리려면 두 폴더의 이름을 바꾸면 됩니다.`)
    }
  }
}

import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { backupSettings } from './backup-mirror.mjs'

/**
 * 백업 한 세대를 업무 데이터 디렉터리로 되돌린다.
 *
 * **어디서 복원할 수 있는가**가 이 파일의 전부다. 두 곳을 받는다:
 *   1) `server/backups/…`      — `backup:data`가 만드는 로컬 사본
 *   2) `BACKUP_NAS_DIRECTORY/…` — 야간 배치가 쌓는 진짜 백업 세트(server/backup-mirror.mjs)
 *
 * 두 번째가 빠져 있었다. README의 복구 절차 4단계는 NAS 경로를 `--from=`에 넣으라고 적어 두었는데
 * 이 스크립트가 `server/backups` 밖을 전부 거절해, **문서가 시키는 그대로 하면 언제나 실패했다.**
 * 야간 백업의 존재 이유가 그 복원인데 복원 도구가 그 경로를 받지 않았던 것이다.
 *
 * 폴더 위치만으로 판정하지 않는다. 그 폴더가 **정말 백업처럼 생겼는지**(workspace-state.json이 있는지)도 본다 —
 * 허용된 뿌리 아래의 아무 폴더나 데이터 디렉터리에 부어 버리는 일을 막는다.
 */

/** 이 폴더가 업무 데이터 덤프인가. 백업 세대에는 언제나 이 파일이 있다. */
export const looksLikeBackup = (directory) => existsSync(path.join(directory, 'workspace-state.json'))

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
    console.error('먼저 backup:data를 실행한 뒤 CONFIRM_RESTORE=YES를 명시해야 복원합니다.')
    process.exitCode = 1
  } else {
    mkdirSync(destination, { recursive: true })
    cpSync(resolved.source, destination, { recursive: true, force: true, errorOnExist: false })
    console.log(`[restore] completed (${resolved.root}): ${resolved.source} -> ${destination}`)
  }
}

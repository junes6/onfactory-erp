import { cpSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

// 백업 디렉터리를 통째로 되돌린다. workspace-state.json 안의 최상위 컬렉션(guestGrants 포함)은
// 파일 단위로 함께 돌아오고, 없는 컬렉션은 JSON 저장소가 열 때 빈 배열로 채운다(json-store.mjs).
const argument = process.argv.find((value) => value.startsWith('--from='))?.slice('--from='.length)
const backupsRoot = path.resolve('server/backups')
const source = argument ? path.resolve(argument) : ''
const destination = path.resolve(
  process.env.ONFACTORY_DATA_DIRECTORY?.trim()
  || (process.env.WORKSPACE_STORE_FILE?.trim() ? path.dirname(process.env.WORKSPACE_STORE_FILE.trim()) : 'server/data'),
)
const relative = source ? path.relative(backupsRoot, source) : '..'

if (!source || relative.startsWith('..') || path.isAbsolute(relative) || !existsSync(source)) {
  console.error('사용법: pnpm restore:data -- --from=server/backups/onfactory_YYYY-MM-DD_HH-MM-SS-sss')
  console.error('복원 소스는 server/backups 아래의 기존 백업이어야 합니다.')
  process.exitCode = 1
} else if (existsSync(destination) && process.env.CONFIRM_RESTORE !== 'YES') {
  console.error(`복원 대상 ${destination}에 기존 데이터가 있습니다.`)
  console.error('먼저 backup:data를 실행한 뒤 CONFIRM_RESTORE=YES를 명시해야 복원합니다.')
  process.exitCode = 1
} else {
  mkdirSync(destination, { recursive: true })
  cpSync(source, destination, { recursive: true, force: true, errorOnExist: false })
  console.log(`[restore] completed: ${source} -> ${destination}`)
}

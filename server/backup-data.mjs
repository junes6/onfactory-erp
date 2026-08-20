import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const source = path.resolve(
  process.env.ONFACTORY_DATA_DIRECTORY?.trim()
  || (process.env.WORKSPACE_STORE_FILE?.trim() ? path.dirname(process.env.WORKSPACE_STORE_FILE.trim()) : 'server/data'),
)
const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
const destination = path.resolve('server/backups', `onfactory_${stamp}`)

if (!existsSync(source)) {
  console.error(`[backup] data directory not found: ${source}`)
  process.exitCode = 1
} else {
  mkdirSync(path.dirname(destination), { recursive: true })
  cpSync(source, destination, { recursive: true, errorOnExist: true })
  writeFileSync(path.join(destination, 'BACKUP_INFO.json'), JSON.stringify({ createdAt: new Date().toISOString(), source, schemaVersion: 2 }, null, 2))
  console.log(`[backup] completed: ${destination}`)
}

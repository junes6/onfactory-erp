import { config } from 'dotenv'
import path from 'node:path'

import { createApp } from './app.mjs'
import { initializeRuntimeStore } from './store/index.mjs'

// .env.local is already covered by the project's *.local gitignore rule.
config({ path: '.env.local', quiet: true })

const rawPort = Number.parseInt(process.env.PORT ?? '8787', 10)
const port = Number.isInteger(rawPort) && rawPort > 0 ? rawPort : 8787
const host = process.env.HOST?.trim() || '127.0.0.1'
const dataDirectory = path.resolve(process.env.ONFACTORY_DATA_DIRECTORY?.trim() || 'server/data')
const workspaceStoreFile = path.resolve(process.env.WORKSPACE_STORE_FILE?.trim() || path.join(dataDirectory, 'workspace-state.json'))
const runtimeStore = await initializeRuntimeStore({ workspaceStoreFile })
if (runtimeStore.adapter.fallbackReason) console.warn(`[store] ${runtimeStore.adapter.fallbackReason}`)
const app = createApp({
  initialWorkspaceStore: runtimeStore.workspaceStore,
  sessions: runtimeStore.sessions,
  workspaceStoreFile,
  onWorkspaceStoreChange: (workspaceStore) => runtimeStore.adapter.commitSnapshot(workspaceStore),
  seedPlatformFixtures: runtimeStore.adapter.kind === 'json' && !runtimeStore.adapter.readOnly,
  seedDemoAccounts: runtimeStore.adapter.kind === 'json',
  skipStartupMigrations: runtimeStore.adapter.kind === 'postgres',
})

const server = app.listen(port, host, () => {
  const mode = process.env.ANTHROPIC_API_KEY?.trim() ? 'Claude' : 'demo'
  console.log(`[server] http://${host}:${port} (${mode} mode, ${runtimeStore.adapter.kind}${runtimeStore.adapter.readOnly ? ' read-only' : ''} store)`)
})

let shuttingDown = false
function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[server] ${signal} received; shutting down`)
  server.close(async () => {
    try {
      await runtimeStore.sessions.flush?.()
      await runtimeStore.adapter.close()
      process.exit(0)
    } catch (error) {
      console.error('[server] 저장소 종료 처리에 실패했습니다.', { message: error?.message })
      process.exit(1)
    }
  })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

import { config } from 'dotenv'
import path from 'node:path'

import { createApp } from './app.mjs'

// .env.local is already covered by the project's *.local gitignore rule.
config({ path: '.env.local', quiet: true })

const rawPort = Number.parseInt(process.env.PORT ?? '8787', 10)
const port = Number.isInteger(rawPort) && rawPort > 0 ? rawPort : 8787
const host = process.env.HOST?.trim() || '127.0.0.1'
const dataDirectory = path.resolve(process.env.ONFACTORY_DATA_DIRECTORY?.trim() || 'server/data')
const workspaceStoreFile = path.resolve(process.env.WORKSPACE_STORE_FILE?.trim() || path.join(dataDirectory, 'workspace-state.json'))
const app = createApp({ workspaceStoreFile })

const server = app.listen(port, host, () => {
  const mode = process.env.ANTHROPIC_API_KEY?.trim() ? 'Claude' : 'demo'
  console.log(`[server] http://${host}:${port} (${mode} mode)`)
})

function shutdown(signal) {
  console.log(`[server] ${signal} received; shutting down`)
  server.close(() => process.exit(0))
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

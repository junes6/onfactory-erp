import { spawn } from 'node:child_process'
import process from 'node:process'

if (!process.env.DATABASE_URL?.trim()) {
  console.error('[postgres-e2e] DATABASE_URL이 필요합니다. 전용 테스트 DB만 사용하세요.')
  process.exit(2)
}

const child = spawn(process.execPath, [
  '--test',
  'server/store/postgres-store.test.mjs',
  'server/store/postgres-app.integration.test.mjs',
], {
  stdio: 'inherit',
  env: { ...process.env, RUN_POSTGRES_E2E: 'true' },
})

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[postgres-e2e] ${signal} 신호로 종료되었습니다.`)
    process.exitCode = 1
    return
  }
  process.exitCode = code ?? 1
})

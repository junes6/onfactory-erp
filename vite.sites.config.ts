import { cloudflare } from '@cloudflare/vite-plugin'
import { sites } from '@openai/sites-vite-plugin'
import react from '@vitejs/plugin-react'
// The Vite config executes in Node; this project intentionally omits Node types
// from the browser-focused TypeScript configuration.
// @ts-expect-error Node built-in is available to the Vite config runtime.
import { cpSync, existsSync } from 'node:fs'
// @ts-expect-error Node built-in is available to the Vite config runtime.
import path from 'node:path'
import { defineConfig } from 'vite'

import hostingConfig from './.openai/hosting.json' with { type: 'json' }

const SITE_DATABASE_PLACEHOLDER = '00000000-0000-4000-8000-000000000000'

const stageD1Migrations = () => ({
  name: 'stage-onfactory-d1-migrations',
  apply: 'build' as const,
  writeBundle(options: { dir?: string }) {
    if (!options.dir || !existsSync(path.join(options.dir, 'index.js'))) return
    cpSync(path.resolve('drizzle'), path.join(options.dir, 'drizzle'), { recursive: true, force: true })
  },
})

export default defineConfig({
  define: {
    'import.meta.env.VITE_HOSTED_DEPLOYMENT': JSON.stringify('true'),
  },
  plugins: [
    react(),
    sites(),
    stageD1Migrations(),
    cloudflare({
      config: {
        main: './worker/index.mjs',
        compatibility_date: '2026-05-22',
        compatibility_flags: ['nodejs_compat', 'enable_nodejs_http_server_modules'],
        assets: {
          not_found_handling: 'single-page-application',
          run_worker_first: ['/api/*'],
        },
        d1_databases: hostingConfig.d1
          ? [{
              binding: hostingConfig.d1,
              database_name: 'onfactory-sites-d1',
              database_id: SITE_DATABASE_PLACEHOLDER,
              migrations_dir: 'drizzle',
            }]
          : [],
        r2_buckets: hostingConfig.r2
          ? [{ binding: hostingConfig.r2, bucket_name: 'onfactory-sites-files' }]
          : [],
      },
    }),
  ],
})

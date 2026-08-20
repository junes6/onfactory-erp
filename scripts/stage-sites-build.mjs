import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'

const distDirectory = path.resolve('dist')
const environments = existsSync(distDirectory)
  ? readdirSync(distDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'client' && entry.name !== 'server')
      .map((entry) => entry.name)
  : []

const workerEnvironment = environments.find((name) => existsSync(path.join(distDirectory, name, 'index.js')))
if (!workerEnvironment) throw new Error('Sites Worker 빌드 결과를 찾지 못했습니다.')

const source = path.join(distDirectory, workerEnvironment)
const target = path.join(distDirectory, 'server')
if (existsSync(target)) rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
cpSync(source, target, { recursive: true })

if (!existsSync(path.join(target, 'index.js'))) {
  throw new Error('dist/server/index.js 생성에 실패했습니다.')
}

console.log(`[sites] staged ${workerEnvironment} as dist/server`)

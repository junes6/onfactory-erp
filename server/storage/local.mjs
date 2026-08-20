import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

import { normalizeStorageKey } from './index.mjs'

function localPath(rootDirectory, key) {
  const normalized = normalizeStorageKey(key)
  const resolved = path.resolve(rootDirectory, ...normalized.split('/'))
  const rootWithSeparator = rootDirectory.endsWith(path.sep) ? rootDirectory : `${rootDirectory}${path.sep}`
  if (!resolved.startsWith(rootWithSeparator)) throw new TypeError('스토리지 루트 밖의 경로는 사용할 수 없습니다.')
  return resolved
}

async function durableWrite(target, body) {
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(body)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

export function createLocalStorage({ rootDirectory }) {
  const resolvedRoot = path.resolve(rootDirectory)
  return {
    backend: 'local',
    async put(key, body) {
      const value = Buffer.isBuffer(body) ? body : Buffer.from(body)
      await durableWrite(localPath(resolvedRoot, key), value)
      return { key: normalizeStorageKey(key), size: value.length }
    },
    async get(key) {
      try {
        return await readFile(localPath(resolvedRoot, key))
      } catch (error) {
        if (error?.code === 'ENOENT') {
          const notFound = new Error('파일을 찾을 수 없습니다.')
          notFound.code = 'STORAGE_NOT_FOUND'
          throw notFound
        }
        throw error
      }
    },
    async delete(key) {
      const target = localPath(resolvedRoot, key)
      try {
        await rm(target)
        return true
      } catch (error) {
        if (error?.code === 'ENOENT') return false
        throw error
      }
    },
    async getSignedUrl(_key, options = {}) {
      return options.fallbackUrl ?? null
    },
  }
}


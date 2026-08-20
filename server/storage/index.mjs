import path from 'node:path'

import { createLocalStorage } from './local.mjs'
import { createS3Storage } from './s3.mjs'

const STORAGE_BACKENDS = new Set(['local', 's3'])

function envBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}

export function normalizeStorageKey(value) {
  const normalized = String(value ?? '').replaceAll('\\', '/').replace(/^\/+/, '')
  const segments = normalized.split('/').filter(Boolean)
  if (!segments.length || segments.some((segment) => segment === '.' || segment === '..' || /[\0\r\n]/.test(segment))) {
    throw new TypeError('유효하지 않은 스토리지 키입니다.')
  }
  return segments.join('/')
}

export function tenantStorageKey(tenantId, id, namespace = '') {
  const safeTenant = String(tenantId ?? '').replace(/[^A-Za-z0-9_-]/g, '')
  const safeId = String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '')
  const safeNamespace = String(namespace ?? '').replace(/[^A-Za-z0-9_-]/g, '')
  if (!safeTenant || !safeId) throw new TypeError('스토리지 식별자가 비어 있습니다.')
  return normalizeStorageKey(`${safeNamespace ? `${safeNamespace}/` : ''}${safeTenant}/${safeId}.bin`)
}

export function platformStorageKey(id, namespace = '_platform') {
  const safeId = String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '')
  const safeNamespace = String(namespace ?? '').replace(/[^A-Za-z0-9_-]/g, '')
  if (!safeId || !safeNamespace) throw new TypeError('스토리지 식별자가 비어 있습니다.')
  return normalizeStorageKey(`${safeNamespace}/${safeId}.bin`)
}

export function createStorage(options = {}) {
  const environment = options.env ?? process.env
  const backend = String(options.backend ?? environment.FILE_STORAGE_BACKEND ?? 'local').toLowerCase()
  if (!STORAGE_BACKENDS.has(backend)) throw new TypeError(`지원하지 않는 FILE_STORAGE_BACKEND입니다: ${backend}`)

  if (backend === 's3') {
    return createS3Storage({
      bucket: options.bucket ?? environment.S3_BUCKET,
      endpoint: options.endpoint ?? environment.S3_ENDPOINT,
      region: options.region ?? environment.S3_REGION ?? 'us-east-1',
      accessKeyId: options.accessKeyId ?? environment.S3_ACCESS_KEY_ID,
      secretAccessKey: options.secretAccessKey ?? environment.S3_SECRET_ACCESS_KEY,
      forcePathStyle: options.forcePathStyle ?? envBoolean(environment.S3_FORCE_PATH_STYLE, true),
      signedUrlExpiresSeconds: Number(options.signedUrlExpiresSeconds ?? environment.S3_SIGNED_URL_EXPIRES_SECONDS ?? 300),
      client: options.client,
      signer: options.signer,
    })
  }

  const rootDirectory = options.rootDirectory
    ?? environment.FILE_STORAGE_LOCAL_DIRECTORY
    ?? options.documentUploadDirectory
  if (!rootDirectory) return null
  return createLocalStorage({ rootDirectory: path.resolve(rootDirectory) })
}

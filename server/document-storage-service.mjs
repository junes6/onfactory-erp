import { createHash } from 'node:crypto'

import { platformStorageKey, tenantStorageKey } from './storage/index.mjs'

export class DocumentStorageError extends Error {
  constructor(code, message, status = 500, cause) {
    super(message, cause ? { cause } : undefined)
    this.name = 'DocumentStorageError'
    this.code = code
    this.status = status
  }
}

function requireStorage(storage) {
  if (!storage) throw new DocumentStorageError('DOCUMENT_STORAGE_UNAVAILABLE', '파일 저장소가 설정되지 않았습니다.', 503)
  return storage
}

export function documentStorageKey(document, tenantId) {
  if (typeof document?.storageKey === 'string' && document.storageKey.trim()) return document.storageKey
  return tenantStorageKey(tenantId, document?.id)
}

export function evidenceStorageKey(evidence) {
  if (typeof evidence?.storageKey === 'string' && evidence.storageKey.trim()) return evidence.storageKey
  return platformStorageKey(evidence?.id)
}

export async function putTenantDocument(storage, { tenantId, id, body, contentType }) {
  const target = requireStorage(storage)
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body)
  const storageKey = tenantStorageKey(tenantId, id)
  await target.put(storageKey, bytes, { contentType })
  return {
    storageKey,
    storageBackend: target.backend,
    checksum: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  }
}

export async function getTenantDocument(storage, document, tenantId) {
  try {
    return await requireStorage(storage).get(documentStorageKey(document, tenantId))
  } catch (error) {
    if (error?.code === 'STORAGE_NOT_FOUND') {
      throw new DocumentStorageError('DOCUMENT_FILE_MISSING', '자료 메타데이터는 있지만 원본 파일을 찾을 수 없습니다.', 410, error)
    }
    throw error
  }
}

export async function deleteTenantDocument(storage, document, tenantId) {
  return requireStorage(storage).delete(documentStorageKey(document, tenantId))
}

export async function tenantDocumentSignedUrl(storage, document, tenantId, fallbackUrl) {
  return requireStorage(storage).getSignedUrl(documentStorageKey(document, tenantId), {
    contentType: document.mime || document.contentType || 'application/octet-stream',
    downloadName: document.name || document.originalName || 'download',
    fallbackUrl,
  })
}

export async function putPlatformEvidence(storage, { id, body, contentType }) {
  const target = requireStorage(storage)
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body)
  const storageKey = platformStorageKey(id)
  await target.put(storageKey, bytes, { contentType })
  return {
    storageKey,
    storageBackend: target.backend,
    checksum: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  }
}

export async function getPlatformEvidence(storage, evidence) {
  try {
    return await requireStorage(storage).get(evidenceStorageKey(evidence))
  } catch (error) {
    if (error?.code === 'STORAGE_NOT_FOUND') {
      throw new DocumentStorageError('PLATFORM_EVIDENCE_MISSING', 'CS 증빙 원본을 찾을 수 없습니다.', 410, error)
    }
    throw error
  }
}

export async function deletePlatformEvidence(storage, evidence) {
  return requireStorage(storage).delete(evidenceStorageKey(evidence))
}

export async function platformEvidenceSignedUrl(storage, evidence, fallbackUrl) {
  return requireStorage(storage).getSignedUrl(evidenceStorageKey(evidence), {
    contentType: evidence.mime || evidence.contentType || 'application/octet-stream',
    downloadName: evidence.originalName || evidence.name || 'evidence',
    fallbackUrl,
  })
}

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deletePlatformEvidence,
  deleteTenantDocument,
  getPlatformEvidence,
  getTenantDocument,
  putPlatformEvidence,
  putTenantDocument,
  tenantDocumentSignedUrl,
} from './document-storage-service.mjs'

function memoryStorage() {
  const values = new Map()
  return {
    backend: 'memory',
    values,
    async put(key, body) { values.set(key, Buffer.from(body)); return { key, size: body.length } },
    async get(key) { if (!values.has(key)) { const error = new Error('missing'); error.code = 'STORAGE_NOT_FOUND'; throw error } return values.get(key) },
    async delete(key) { return values.delete(key) },
    async getSignedUrl(key, options) { return options.fallbackUrl || `memory://${key}` },
  }
}

test('tenant documents use stable keys, checksums, signed URLs and reversible bytes', async () => {
  const storage = memoryStorage()
  const stored = await putTenantDocument(storage, { tenantId: 'TENANT-1', id: 'DOC-1', body: Buffer.from('document'), contentType: 'text/plain' })
  assert.equal(stored.storageKey, 'TENANT-1/DOC-1.bin')
  assert.equal(stored.checksum.length, 64)
  const document = { id: 'DOC-1', name: 'document.txt', mime: 'text/plain', ...stored }
  assert.equal((await getTenantDocument(storage, document, 'TENANT-1')).toString(), 'document')
  assert.equal(await tenantDocumentSignedUrl(storage, document, 'TENANT-1', '/api/documents/DOC-1/download'), '/api/documents/DOC-1/download')
  assert.equal(await deleteTenantDocument(storage, document, 'TENANT-1'), true)
  await assert.rejects(getTenantDocument(storage, document, 'TENANT-1'), { code: 'DOCUMENT_FILE_MISSING' })
})

test('platform evidence is isolated from tenant object keys', async () => {
  const storage = memoryStorage()
  const stored = await putPlatformEvidence(storage, { id: 'PFD-1', body: Buffer.from('evidence'), contentType: 'application/pdf' })
  assert.equal(stored.storageKey, '_platform/PFD-1.bin')
  const evidence = { id: 'PFD-1', ...stored }
  assert.equal((await getPlatformEvidence(storage, evidence)).toString(), 'evidence')
  assert.equal(await deletePlatformEvidence(storage, evidence), true)
})


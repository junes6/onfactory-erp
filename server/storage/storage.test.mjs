import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createStorage, normalizeStorageKey, tenantStorageKey } from './index.mjs'

test('local storage implements put/get/delete without escaping its root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'onfactory-storage-'))
  try {
    const storage = createStorage({ backend: 'local', rootDirectory: root })
    const key = tenantStorageKey('TENANT-1', 'DOC-1')
    await storage.put(key, Buffer.from('hello'))
    assert.equal((await storage.get(key)).toString(), 'hello')
    assert.equal(await storage.getSignedUrl(key, { fallbackUrl: '/api/documents/DOC-1/download' }), '/api/documents/DOC-1/download')
    assert.equal(await storage.delete(key), true)
    assert.equal(await storage.delete(key), false)
    await assert.rejects(storage.get(key), { code: 'STORAGE_NOT_FOUND' })
    assert.throws(() => normalizeStorageKey('../secret'), /유효하지 않은/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('s3 storage validates required configuration before creating a client', () => {
  assert.throws(() => createStorage({ backend: 's3', bucket: '' }), /S3_BUCKET/)
  assert.throws(() => createStorage({ backend: 's3', bucket: 'erp' }), /자격정보/)
})

test('s3 storage uses the same put/get/delete/signed-url contract', async () => {
  const commands = []
  const client = {
    async send(command) {
      commands.push(command.constructor.name)
      if (command.constructor.name === 'GetObjectCommand') {
        return { Body: { transformToByteArray: async () => new TextEncoder().encode('remote') } }
      }
      return {}
    },
  }
  const storage = createStorage({
    backend: 's3',
    bucket: 'erp',
    client,
    signer: async (_client, command, options) => `https://storage.test/${command.input.Key}?expires=${options.expiresIn}`,
  })
  await storage.put('documents/TENANT-1/DOC-1.bin', Buffer.from('remote'), { contentType: 'text/plain' })
  assert.equal((await storage.get('documents/TENANT-1/DOC-1.bin')).toString(), 'remote')
  assert.match(await storage.getSignedUrl('documents/TENANT-1/DOC-1.bin', { expiresIn: 120 }), /expires=120/)
  assert.equal(await storage.delete('documents/TENANT-1/DOC-1.bin'), true)
  assert.deepEqual(commands, ['PutObjectCommand', 'GetObjectCommand', 'DeleteObjectCommand'])
})

import assert from 'node:assert/strict'
import { mkdtemp, rm, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createApp } from './app.mjs'
import { buildTaxEvidenceArchive } from './tax-evidence-export.mjs'
import { withServer } from './test-server.mjs'

function parseStoredZip(buffer) {
  const entries = new Map()
  let offset = 0
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const size = buffer.readUInt32LE(offset + 18)
    const nameLength = buffer.readUInt16LE(offset + 26)
    const extraLength = buffer.readUInt16LE(offset + 28)
    const nameStart = offset + 30
    const bodyStart = nameStart + nameLength + extraLength
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8')
    entries.set(name, buffer.subarray(bodyStart, bodyStart + size))
    offset = bodyStart + size
  }
  assert.equal(buffer.readUInt32LE(offset), 0x02014b50, 'central directory must follow local entries')
  return entries
}

async function login(origin, email) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: 'tenant', email, password: 'demo1234' }),
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  return { cookie: response.headers.get('set-cookie').split(';')[0], account: body.account }
}

async function upload(origin, cookie, { name, year, bucket, body }) {
  const params = new URLSearchParams({
    name, category: '세무·회계', visibility: 'restricted', summary: `${year} ${bucket} 증빙`,
    tags: `tax-evidence,tax-year:${year},tax-bucket:${bucket}`,
  })
  const response = await fetch(`${origin}/api/documents?${params}`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-type': 'text/plain', 'x-file-name': encodeURIComponent(name) }, body,
  })
  const payload = await response.json()
  assert.equal(response.status, 201, JSON.stringify(payload))
  return payload.document
}

test('tax evidence archive sanitizes names, verifies checksums and contains a manifest', async () => {
  const body = Buffer.from('매출 증빙 원본')
  const result = await buildTaxEvidenceArchive({
    year: 2026,
    documents: [{ id: 'DOC-1', name: '../../매출.txt', originalName: '../../매출.txt', uploadedAt: '2026-08-24T00:00:00.000Z', uploadedByName: '=FORMULA', tags: ['tax-evidence', 'tax-year:2026', 'tax-bucket:매출'] }],
    getDocument: async () => body,
  })
  const entries = parseStoredZip(result.archive)
  assert.equal(result.fileCount, 1)
  assert.equal([...entries.keys()].some((name) => name.includes('..') || name.startsWith('/')), false)
  assert.deepEqual([...entries.values()].some((value) => value.equals(body)), true)
  assert.match(entries.get('manifest.csv').toString('utf8'), /'\=FORMULA/)
})

test('admin exports only the selected tenant/year while auth, stale identity and missing originals fail closed', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'onfactory-tax-export-'))
  const storeFile = path.join(directory, 'workspace-state.json')
  const documentDirectory = path.join(directory, 'documents')
  try {
    await withServer(createApp({ apiKey: '', workspaceStoreFile: storeFile, documentUploadDirectory: documentDirectory }), async (origin) => {
      const admin = await login(origin, 'admin@sunsea.co.kr')
      const member = await login(origin, 'taesik.oh@sunsea.co.kr')
      const otherTenant = await login(origin, 'admin@pohangcoop.co.kr')
      const current = await upload(origin, admin.cookie, { name: '2026 매출.txt', year: 2026, bucket: '매출', body: Buffer.from('2026-only') })
      await upload(origin, admin.cookie, { name: '2025 매입.txt', year: 2025, bucket: '매입', body: Buffer.from('2025-excluded') })

      assert.equal((await fetch(`${origin}/api/tax/evidence-export?year=2026`)).status, 401)
      assert.equal((await fetch(`${origin}/api/tax/evidence-export?year=2026`, { headers: { cookie: member.cookie } })).status, 403)
      const stale = await fetch(`${origin}/api/tax/evidence-export?year=2026`, { headers: { cookie: admin.cookie, 'x-workspace-identity': 'TENANT-OTHER:USR-OTHER' } })
      assert.equal(stale.status, 401)
      assert.equal((await stale.json()).error.code, 'WORKSPACE_IDENTITY_MISMATCH')
      const other = await fetch(`${origin}/api/tax/evidence-export?year=2026`, { headers: { cookie: otherTenant.cookie } })
      assert.equal(other.status, 404)
      assert.doesNotMatch(JSON.stringify(await other.json()), /2026 매출/)

      const response = await fetch(`${origin}/api/tax/evidence-export?year=2026`, {
        headers: { cookie: admin.cookie, 'x-workspace-identity': `${admin.account.tenantId}:${admin.account.id}` },
      })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-type'), 'application/zip')
      assert.equal(response.headers.get('cache-control'), 'private, no-store')
      assert.equal(response.headers.get('x-tax-evidence-files'), '1')
      const entries = parseStoredZip(Buffer.from(await response.arrayBuffer()))
      assert.deepEqual([...entries.values()].some((value) => value.toString() === '2026-only'), true)
      assert.deepEqual([...entries.values()].some((value) => value.toString() === '2025-excluded'), false)

      await unlink(path.join(documentDirectory, admin.account.tenantId, `${current.id}.bin`))
      const incomplete = await fetch(`${origin}/api/tax/evidence-export?year=2026`, { headers: { cookie: admin.cookie } })
      assert.equal(incomplete.status, 410)
      assert.equal((await incomplete.json()).error.code, 'TAX_EVIDENCE_FILE_MISSING')
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

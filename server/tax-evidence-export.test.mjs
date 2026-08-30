import assert from 'node:assert/strict'
import { mkdtemp, rm, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createApp } from './app.mjs'
import { buildTaxEvidenceArchive, resolveEvidencePeriod, selectTaxEvidence } from './tax-evidence-export.mjs'
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

async function upload(origin, cookie, { name, year, bucket, body, date }) {
  const params = new URLSearchParams({
    name, category: '세무·회계', visibility: 'restricted', summary: `${year} ${bucket} 증빙`,
    tags: [`tax-evidence`, `tax-year:${year}`, `tax-bucket:${bucket}`, ...(date ? [`tax-date:${date}`] : [])].join(','),
  })
  const response = await fetch(`${origin}/api/documents?${params}`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-type': 'text/plain', 'x-file-name': encodeURIComponent(name) }, body,
  })
  const payload = await response.json()
  assert.equal(response.status, 201, JSON.stringify(payload))
  return payload.document
}

const exportRequest = (origin, cookie, body, headers = {}) => fetch(`${origin}/api/tax/evidence-export`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
  body: JSON.stringify(body),
})

test('tax evidence archive sanitizes names, verifies checksums and contains a manifest with a summary', async () => {
  const body = Buffer.from('매출 증빙 원본')
  const result = await buildTaxEvidenceArchive({
    year: 2026,
    documents: [{ id: 'DOC-1', name: '../../매출.txt', originalName: '../../매출.txt', uploadedAt: '2026-08-24T00:00:00.000Z', uploadedByName: '=FORMULA', tags: ['tax-evidence', 'tax-year:2026', 'tax-bucket:매출'] }],
    getDocument: async () => body,
    label: '2026년 한 해 전체',
    preparedAt: '2026-08-30T01:00:00.000Z',
    preparedBy: '김서원',
  })
  const entries = parseStoredZip(result.archive)
  assert.equal(result.fileCount, 1)
  assert.equal(result.periodLabel, '2026년 한 해 전체')
  assert.match(result.archiveChecksum, /^[0-9a-f]{64}$/)
  assert.deepEqual(result.buckets, { 매출: 1 })
  assert.equal([...entries.keys()].some((name) => name.includes('..') || name.startsWith('/')), false)
  assert.deepEqual([...entries.values()].some((value) => value.equals(body)), true)
  assert.match(entries.get('manifest.csv').toString('utf8'), /'\=FORMULA/)
  assert.match(entries.get('manifest.csv').toString('utf8'), /증빙일자/)
  assert.match(entries.get('전달요약.txt').toString('utf8'), /대상 기간: 2026-01-01 ~ 2026-12-31/)
  assert.match(entries.get('전달요약.txt').toString('utf8'), /증빙 건수: 1건/)
})

test('one period choice selects exactly the evidence inside that range', () => {
  const documents = [
    { id: 'DOC-Q1', tags: ['tax-evidence', 'tax-date:2026-02-11'], uploadedAt: '2026-08-01T00:00:00.000Z' },
    { id: 'DOC-Q3', tags: ['tax-evidence', 'tax-date:2026-07-02'], uploadedAt: '2026-08-01T00:00:00.000Z' },
    { id: 'DOC-LAST-YEAR', tags: ['tax-evidence', 'tax-year:2025'], uploadedAt: '2026-01-04T00:00:00.000Z' },
    { id: 'DOC-NOT-TAX', tags: ['공용'], uploadedAt: '2026-07-02T00:00:00.000Z' },
  ]
  const half = selectTaxEvidence(documents, resolveEvidencePeriod({ from: '2026-07-01', to: '2026-12-31' }))
  assert.deepEqual(half.map((entry) => entry.document.id), ['DOC-Q3'])
  const wholeYear = selectTaxEvidence(documents, resolveEvidencePeriod({ year: 2026 }))
  assert.deepEqual(wholeYear.map((entry) => entry.document.id), ['DOC-Q1', 'DOC-Q3'])
  const lastYear = selectTaxEvidence(documents, resolveEvidencePeriod({ year: 2025 }))
  assert.deepEqual(lastYear.map((entry) => entry.document.id), ['DOC-LAST-YEAR'])
  assert.throws(() => resolveEvidencePeriod({ from: '2026-07-01', to: '2026-06-30' }), /시작일이 종료일보다/)
  assert.throws(() => resolveEvidencePeriod({ from: '2026-02-30', to: '2026-06-30' }), /달력에 없는 날짜/)
})

test('admin exports only the selected tenant/period, records a delivery log and fails closed', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'onfactory-tax-export-'))
  const storeFile = path.join(directory, 'workspace-state.json')
  const documentDirectory = path.join(directory, 'documents')
  try {
    await withServer(createApp({ apiKey: '', workspaceStoreFile: storeFile, documentUploadDirectory: documentDirectory }), async (origin) => {
      const admin = await login(origin, 'admin@sunsea.co.kr')
      const member = await login(origin, 'taesik.oh@sunsea.co.kr')
      const otherTenant = await login(origin, 'admin@pohangcoop.co.kr')
      const identity = { 'x-workspace-identity': `${admin.account.tenantId}:${admin.account.id}` }
      const current = await upload(origin, admin.cookie, { name: '2026 매출.txt', year: 2026, bucket: '매출', body: Buffer.from('2026-only'), date: '2026-03-11' })
      await upload(origin, admin.cookie, { name: '2025 매입.txt', year: 2025, bucket: '매입', body: Buffer.from('2025-excluded') })
      await upload(origin, admin.cookie, { name: '2026 하반기.txt', year: 2026, bucket: '경비', body: Buffer.from('2026-h2'), date: '2026-09-02' })

      assert.equal((await exportRequest(origin, null, { year: 2026 })).status, 401)
      assert.equal((await exportRequest(origin, member.cookie, { year: 2026 })).status, 403)
      const stale = await exportRequest(origin, admin.cookie, { year: 2026 }, { 'x-workspace-identity': 'TENANT-OTHER:USR-OTHER' })
      assert.equal(stale.status, 401)
      assert.equal((await stale.json()).error.code, 'WORKSPACE_IDENTITY_MISMATCH')
      const other = await exportRequest(origin, otherTenant.cookie, { year: 2026 })
      assert.equal(other.status, 404)
      assert.doesNotMatch(JSON.stringify(await other.json()), /2026 매출/)
      // 직접 쓰기로는 전달 이력을 만들 수 없다.
      const forged = await fetch(`${origin}/api/workspace/tax-deliveries`, {
        method: 'PUT', headers: { cookie: admin.cookie, 'content-type': 'application/json', ...identity }, body: JSON.stringify({ data: [{ id: 'FORGED' }] }),
      })
      assert.equal(forged.status, 403)
      assert.equal((await forged.json()).error.code, 'TAX_DELIVERY_LOG_READONLY')

      const half = await exportRequest(origin, admin.cookie, { from: '2026-01-01', to: '2026-06-30', label: '2026년 상반기 (1~6월)' }, identity)
      assert.equal(half.status, 200)
      assert.equal(half.headers.get('content-type'), 'application/zip')
      assert.equal(half.headers.get('cache-control'), 'private, no-store')
      assert.equal(half.headers.get('x-tax-evidence-files'), '1')
      assert.equal(half.headers.get('x-tax-period'), '2026-01-01/2026-06-30')
      const halfEntries = parseStoredZip(Buffer.from(await half.arrayBuffer()))
      assert.deepEqual([...halfEntries.values()].some((value) => value.toString() === '2026-only'), true)
      assert.deepEqual([...halfEntries.values()].some((value) => value.toString() === '2026-h2'), false)
      assert.deepEqual([...halfEntries.values()].some((value) => value.toString() === '2025-excluded'), false)

      const whole = await exportRequest(origin, admin.cookie, { year: 2026 }, identity)
      assert.equal(whole.status, 200)
      assert.equal(whole.headers.get('x-tax-evidence-files'), '2')

      const history = await fetch(`${origin}/api/tax/deliveries`, { headers: { cookie: admin.cookie, ...identity } })
      assert.equal(history.status, 200)
      const { deliveries } = await history.json()
      assert.equal(deliveries.length, 2)
      assert.equal(deliveries[0].periodStart, '2026-01-01')
      assert.equal(deliveries[0].periodEnd, '2026-12-31')
      assert.equal(deliveries[0].fileCount, 2)
      assert.equal(deliveries[0].deliveredByName, admin.account.name)
      assert.match(deliveries[0].archiveChecksum, /^[0-9a-f]{64}$/)
      assert.equal(deliveries[1].periodEnd, '2026-06-30')
      assert.equal(deliveries[1].periodLabel, '2026년 상반기 (1~6월)')
      // 다른 고객사는 우리 전달 이력을 볼 수 없다.
      const otherHistory = await fetch(`${origin}/api/tax/deliveries`, { headers: { cookie: otherTenant.cookie } })
      assert.deepEqual((await otherHistory.json()).deliveries, [])

      await unlink(path.join(documentDirectory, admin.account.tenantId, `${current.id}.bin`))
      const incomplete = await exportRequest(origin, admin.cookie, { year: 2026 }, identity)
      assert.equal(incomplete.status, 410)
      assert.equal((await incomplete.json()).error.code, 'TAX_EVIDENCE_FILE_MISSING')
      const unchanged = await fetch(`${origin}/api/tax/deliveries`, { headers: { cookie: admin.cookie, ...identity } })
      assert.equal((await unchanged.json()).deliveries.length, 2, '실패한 전달은 이력에 남기지 않는다')
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('delivery history survives a restart because the server persists it', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'onfactory-tax-delivery-'))
  const storeFile = path.join(directory, 'workspace-state.json')
  const documentDirectory = path.join(directory, 'documents')
  try {
    let tenantId = ''
    await withServer(createApp({ apiKey: '', workspaceStoreFile: storeFile, documentUploadDirectory: documentDirectory }), async (origin) => {
      const admin = await login(origin, 'admin@sunsea.co.kr')
      tenantId = admin.account.tenantId
      await upload(origin, admin.cookie, { name: '재기동 증빙.txt', year: 2026, bucket: '매출', body: Buffer.from('restart'), date: '2026-05-02' })
      const response = await exportRequest(origin, admin.cookie, { year: 2026, recipient: '가나세무회계', note: '5월 정기 전달' }, { 'x-workspace-identity': `${tenantId}:${admin.account.id}` })
      assert.equal(response.status, 200)
      await response.arrayBuffer()
    })
    await withServer(createApp({ apiKey: '', workspaceStoreFile: storeFile, documentUploadDirectory: documentDirectory }), async (origin) => {
      const admin = await login(origin, 'admin@sunsea.co.kr')
      const history = await fetch(`${origin}/api/tax/deliveries`, { headers: { cookie: admin.cookie, 'x-workspace-identity': `${tenantId}:${admin.account.id}` } })
      const { deliveries } = await history.json()
      assert.equal(deliveries.length, 1)
      assert.equal(deliveries[0].recipient, '가나세무회계')
      assert.equal(deliveries[0].note, '5월 정기 전달')
      assert.equal(deliveries[0].fileCount, 1)
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createApp } from './app.mjs'
import { normalizeDocumentExtraction } from './document-extraction.mjs'
import { withServer } from './test-server.mjs'

async function login(origin, email) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: 'tenant', email, password: 'demo1234' }),
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  return { cookie: response.headers.get('set-cookie').split(';')[0], account: body.account, identity: `${body.account.tenantId}:${body.account.id}` }
}

async function upload(origin, auth, { name, mime, bytes }) {
  const response = await fetch(`${origin}/api/documents?name=${encodeURIComponent(name)}&visibility=restricted`, {
    method: 'POST',
    headers: { cookie: auth.cookie, 'x-workspace-identity': auth.identity, 'content-type': 'application/octet-stream', 'x-file-type': mime, 'x-file-name': encodeURIComponent(name) },
    body: bytes,
  })
  assert.equal(response.status, 201)
  return (await response.json()).document
}

function billingSpy({ failLedger = false } = {}) {
  const calls = { reservations: [], events: [], pending: [], releases: [] }
  return {
    calls,
    service: {
      reserveUsage: async (_actor, input) => { calls.reservations.push(input); return { reservation: { ...input, status: 'pending' } } },
      recordUsageEvent: async (_actor, input) => { calls.events.push(input); if (failLedger) throw new Error('ledger unavailable'); return { event: input } },
      recordReconciliationPending: async (_actor, input) => { calls.pending.push(input); return { reconciliation: input } },
      releaseUsageReservation: async (_actor, input) => { calls.releases.push(input) },
    },
  }
}

const withEvidence = (values) => Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { value, evidence: `원문: ${value}` }]))

test('document extraction reads one tenant PDF/image, returns only a review draft and records fixed usage', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'onfactory-document-extraction-'))
  const captured = []
  const billing = billingSpy()
  const client = { messages: {
    countTokens: async () => ({ input_tokens: 31 }),
    create: async (input) => {
      captured.push(input)
      const properties = input.output_config?.format?.schema?.properties ?? {}
      const payload = properties.kind
        ? withEvidence({ kind: '특허', title: '저온 건조 방법', number: '10-2026-1234567', holder: '주식회사 온팩토리', issuer: '특허청', filedAt: '2025-01-02', registeredAt: '2026-03-04', expiresAt: '2046-03-04' })
        : properties.client
          ? withEvidence({ title: '유지보수 연간 계약', client: '○○주식회사', number: '2026-CT-014', startDate: '2026-01-01', endDate: '2026-12-31', amount: '12,000,000원' })
          : withEvidence({ category: 'HACCP', name: '식품안전관리인증', authority: '한국식품안전관리인증원', certificateNo: 'HACCP-2026-01', issuedAt: '2026-01-05', expiresAt: '2029-01-04' })
      return {
        id: `extract-${captured.length}`, model: 'claude-test', usage: { input_tokens: 27, output_tokens: 15 },
        content: [{ type: 'text', text: JSON.stringify({ ...payload, confidence: 0.94, warnings: [] }) }],
      }
    },
  } }
  try {
    await withServer(createApp({ apiKey: 'test-key', model: 'claude-test', client, billingService: billing.service, workspaceStoreFile: path.join(directory, 'state.json') }), async (origin) => {
      const admin = await login(origin, 'admin@sunsea.co.kr')
      const certificate = await upload(origin, admin, { name: 'HACCP.pdf', mime: 'application/pdf', bytes: Buffer.from('%PDF-1.4 certificate') })
      const patent = await upload(origin, admin, { name: '특허증.png', mime: 'image/png', bytes: Buffer.from('png-patent-bytes') })

      const beforeCompliance = await (await fetch(`${origin}/api/workspace/compliance-records`, { headers: { cookie: admin.cookie, 'x-workspace-identity': admin.identity } })).json()
      const beforeIp = await (await fetch(`${origin}/api/workspace/ip-rights`, { headers: { cookie: admin.cookie, 'x-workspace-identity': admin.identity } })).json()
      const cases = [[certificate, 'compliance'], [patent, 'ip-right'], [certificate, 'contract']]
      for (const [document, target] of cases) {
        const response = await fetch(`${origin}/api/documents/${document.id}/extract`, {
          method: 'POST', headers: { cookie: admin.cookie, 'x-workspace-identity': admin.identity, 'content-type': 'application/json' },
          body: JSON.stringify({ target, feature: 'forged', tenantId: 'TENANT-OTHER', model: 'forged' }),
        })
        assert.equal(response.status, 200)
        const body = await response.json()
        assert.equal(body.sourceDocumentId, document.id)
        assert.equal(body.target, target)
        assert.equal(body.requiresReview, true)
        assert.equal('raw' in body, false)
        assert.equal('tenantId' in body.draft, false)
        assert.equal('status' in body.draft, false)
        // 값마다 원문 근거가 함께 와야 확인 화면에서 대조할 수 있다.
        assert.ok(Object.keys(body.draft.fields).length > 0)
        assert.ok(Object.values(body.draft.fields).every((field) => field.value && field.evidence))
      }
      assert.equal(captured[0].messages.at(-1).content.some((block) => block.type === 'document'), true)
      assert.equal(captured[1].messages.at(-1).content.some((block) => block.type === 'image'), true)
      assert.equal(captured.every((input) => input.output_config.format.schema.additionalProperties === false), true)
      assert.deepEqual(billing.calls.reservations.map((entry) => entry.feature), ['document-extraction', 'document-extraction', 'document-extraction'])
      assert.deepEqual(billing.calls.events.map((entry) => entry.feature), ['document-extraction', 'document-extraction', 'document-extraction'])
      assert.equal(billing.calls.releases.length, 0)

      const afterCompliance = await (await fetch(`${origin}/api/workspace/compliance-records`, { headers: { cookie: admin.cookie, 'x-workspace-identity': admin.identity } })).json()
      const afterIp = await (await fetch(`${origin}/api/workspace/ip-rights`, { headers: { cookie: admin.cookie, 'x-workspace-identity': admin.identity } })).json()
      assert.deepEqual(afterCompliance.data, beforeCompliance.data)
      assert.deepEqual(afterIp.data, beforeIp.data)
      const original = await fetch(`${origin}/api/documents/${certificate.id}/download`, { headers: { cookie: admin.cookie, 'x-workspace-identity': admin.identity } })
      assert.equal(Buffer.from(await original.arrayBuffer()).toString(), '%PDF-1.4 certificate')
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('document extraction rejects auth, stale scope, other tenants and unsupported files before AI usage', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'onfactory-document-extraction-auth-'))
  let providerCalls = 0
  const billing = billingSpy()
  const client = { messages: { countTokens: async () => ({ input_tokens: 1 }), create: async () => { providerCalls += 1; throw new Error('must not run') } } }
  try {
    await withServer(createApp({ apiKey: 'test-key', client, billingService: billing.service, workspaceStoreFile: path.join(directory, 'state.json') }), async (origin) => {
      const admin = await login(origin, 'admin@sunsea.co.kr')
      const member = await login(origin, 'jihyun.park@sunsea.co.kr')
      const otherAdmin = await login(origin, 'admin@pohangcoop.co.kr')
      const document = await upload(origin, admin, { name: '인증서.pdf', mime: 'application/pdf', bytes: Buffer.from('%PDF auth') })
      const unsupported = await upload(origin, admin, { name: '인증정보.txt', mime: 'text/plain', bytes: Buffer.from('text') })
      const call = (id, auth, identity = auth?.identity) => fetch(`${origin}/api/documents/${id}/extract`, {
        method: 'POST', headers: { ...(auth ? { cookie: auth.cookie } : {}), ...(identity ? { 'x-workspace-identity': identity } : {}), 'content-type': 'application/json' }, body: JSON.stringify({ target: 'compliance' }),
      })
      assert.equal((await call(document.id, null)).status, 401)
      assert.equal((await call(document.id, member)).status, 403)
      assert.equal((await call(document.id, admin, 'TENANT-OTHER:USR-OTHER')).status, 401)
      const cross = await call(document.id, otherAdmin)
      assert.equal(cross.status, 404)
      assert.equal(JSON.stringify(await cross.json()).includes(document.name), false)
      assert.equal((await call(unsupported.id, admin)).status, 415)
      const invalidTarget = await fetch(`${origin}/api/documents/${document.id}/extract`, { method: 'POST', headers: { cookie: admin.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ target: 'all-documents' }) })
      assert.equal(invalidTarget.status, 400)
      assert.equal(providerCalls, 0)
      assert.equal(billing.calls.reservations.length, 0)
      assert.equal(billing.calls.events.length, 0)
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('malicious extraction output is sanitized, and provider-success parse failures remain billable', async () => {
  const evidence = (value) => ({ value, evidence: `원문: ${value}` })
  const malicious = normalizeDocumentExtraction(JSON.stringify({
    kind: evidence('특허'),
    title: { value: `<script>${'가'.repeat(250)}</script>`, evidence: `<b>${'나'.repeat(300)}</b>` },
    number: evidence('10-1'), holder: evidence('권리자\u0000'), issuer: { value: '특허청', evidence: '' },
    filedAt: evidence('2026-02-30'), registeredAt: evidence('2026-01-02'), expiresAt: evidence('2025-01-01'), confidence: 99,
    warnings: ['확인 필요', '<b>확인 필요</b>'], tenantId: 'TENANT-OTHER', documentId: 'DOC-FORGED', status: '등록', __proto__: { polluted: true },
  }), 'ip-right')
  assert.equal(malicious.fields.title.value.includes('<'), false)
  assert.equal(malicious.fields.title.value.length <= 200, true)
  assert.equal(malicious.fields.title.evidence.includes('<'), false)
  assert.equal(malicious.fields.title.evidence.length <= 240, true)
  assert.equal(malicious.fields.holder.value, '권리자')
  // 근거 없는 값은 채우지 않고 경고로만 남긴다.
  assert.equal('issuer' in malicious.fields, false)
  assert.ok(malicious.warnings.some((warning) => warning.includes('원문 근거가 없어')))
  assert.equal('filedAt' in malicious.fields, false)
  assert.equal('registeredAt' in malicious.fields, false)
  assert.equal('expiresAt' in malicious.fields, false)
  assert.equal(malicious.confidence, null)
  assert.equal('tenantId' in malicious, false)
  assert.equal('documentId' in malicious, false)
  assert.deepEqual(Object.keys(malicious), ['fields', 'confidence', 'warnings'])

  const directory = await mkdtemp(path.join(os.tmpdir(), 'onfactory-document-extraction-invalid-'))
  const billing = billingSpy({ failLedger: true })
  let providerCall = 0
  const client = { messages: {
    countTokens: async () => ({ input_tokens: 4 }),
    create: async () => {
      providerCall += 1
      if (providerCall === 1) return { id: 'invalid-json', model: 'claude-test', usage: { input_tokens: 4, output_tokens: 2 }, content: [{ type: 'text', text: 'not-json' }] }
      throw Object.assign(new Error('provider failed'), { status: 503 })
    },
  } }
  try {
    await withServer(createApp({ apiKey: 'test-key', client, billingService: billing.service, workspaceStoreFile: path.join(directory, 'state.json') }), async (origin) => {
      const admin = await login(origin, 'admin@sunsea.co.kr')
      const document = await upload(origin, admin, { name: '판독.pdf', mime: 'application/pdf', bytes: Buffer.from('%PDF invalid') })
      const headers = { cookie: admin.cookie, 'x-workspace-identity': admin.identity, 'content-type': 'application/json' }
      const invalid = await fetch(`${origin}/api/documents/${document.id}/extract`, { method: 'POST', headers, body: JSON.stringify({ target: 'ip-right' }) })
      assert.equal(invalid.status, 502)
      assert.equal((await invalid.json()).error.code, 'DOCUMENT_EXTRACTION_INVALID')
      assert.equal(billing.calls.events.length, 1)
      assert.equal(billing.calls.pending.length, 1)
      assert.equal(billing.calls.releases.length, 0)

      const failed = await fetch(`${origin}/api/documents/${document.id}/extract`, { method: 'POST', headers, body: JSON.stringify({ target: 'ip-right' }) })
      assert.equal(failed.status, 502)
      assert.equal(billing.calls.reservations.length, 2)
      assert.equal(billing.calls.releases.length, 1)
      const original = await fetch(`${origin}/api/documents/${document.id}/download`, { headers })
      assert.equal(Buffer.from(await original.arrayBuffer()).toString(), '%PDF invalid')
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

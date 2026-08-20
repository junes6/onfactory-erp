import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

async function loadWorkerFactory() {
  const sourcePath = new URL('./index.mjs', import.meta.url)
  let source = readFileSync(sourcePath, 'utf8')
  source = source
    .replace("import { env as cloudflareEnv } from 'cloudflare:workers'", 'const cloudflareEnv = {}')
    .replace("import { httpServerHandler as cloudflareHttpServerHandler } from 'cloudflare:node'", "const cloudflareHttpServerHandler = () => { throw new Error('test dependency required') }")
    .replace("import Anthropic from '@anthropic-ai/sdk'", 'class Anthropic {}')
    .replace(/import currentWorkspaceSeed from '[^']+' with \{ type: 'json' \}/, 'const currentWorkspaceSeed = {}')
    .replace(/import \{ createApp as createExpressApp \} from '[^']+'/, "const createExpressApp = () => { throw new Error('test dependency required') }")
    .replace(/import \{ createD1BillingRepository \} from '[^']+'/, 'const createD1BillingRepository = () => ({})')
    .replace(/import \{ createBillingService \} from '[^']+'/, 'const createBillingService = () => ({ reconcilePendingUsageBatch: async () => {}, recordDailyStorageSnapshot: async () => {}, createMonthlySnapshot: async () => {} })')
    .replace(/import \{ performanceMaintenanceErrors, runPerformanceMonthlyMaintenance \} from '[^']+'/, 'const performanceMaintenanceErrors = (results) => (results ?? []).filter((result) => result?.error).map((result) => result.error); const runPerformanceMonthlyMaintenance = async () => []')
  assert.equal(source.includes("from 'cloudflare:workers'"), false)
  assert.equal(source.includes("from '../server/app.mjs'"), false)
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  return (await import(url)).createSitesWorker
}

class FakeStatement {
  constructor(database, sql) {
    this.database = database
    this.sql = sql.replace(/\s+/g, ' ').trim()
    this.parameters = []
  }

  bind(...parameters) {
    this.parameters = parameters
    return this
  }

  run() {
    return this.database.execute(this.sql, this.parameters, false)
  }

  first() {
    return this.database.execute(this.sql, this.parameters, true)
  }
}

class FakeD1 {
  constructor() {
    this.appState = null
    this.lock = null
    this.rateLimits = new Map()
    this.failNextStateCas = false
  }

  prepare(sql) {
    return new FakeStatement(this, sql)
  }

  result(changes = 0) {
    return { success: true, meta: { changes } }
  }

  async execute(sql, parameters, first) {
    if (sql.startsWith('CREATE TABLE') || sql.startsWith('CREATE INDEX')) return first ? null : this.result()
    if (sql.startsWith('INSERT OR IGNORE INTO request_locks')) {
      if (!this.lock) this.lock = { id: parameters[0], owner: null, expires_at: 0 }
      return this.result(1)
    }
    if (sql.startsWith('UPDATE request_locks SET owner = ?, expires_at = ?')) {
      const [owner, expiresAt, , id, now] = parameters
      if (this.lock?.id === id && (this.lock.owner === null || this.lock.expires_at <= now)) {
        this.lock = { id, owner, expires_at: expiresAt }
        return this.result(1)
      }
      return this.result()
    }
    if (sql.startsWith('UPDATE request_locks SET expires_at = ?')) {
      const [expiresAt, , id, owner] = parameters
      if (this.lock?.id === id && this.lock.owner === owner) {
        this.lock.expires_at = expiresAt
        return this.result(1)
      }
      return this.result()
    }
    if (sql.startsWith('UPDATE request_locks SET owner = NULL')) {
      const [, id, owner] = parameters
      if (this.lock?.id === id && this.lock.owner === owner) {
        this.lock.owner = null
        this.lock.expires_at = 0
        return this.result(1)
      }
      return this.result()
    }
    if (sql.startsWith('SELECT owner, expires_at FROM request_locks')) {
      return this.lock ? { owner: this.lock.owner, expires_at: this.lock.expires_at } : null
    }
    if (sql.startsWith('SELECT payload, revision FROM app_state')) {
      return this.appState ? { payload: this.appState.payload, revision: this.appState.revision } : null
    }
    if (sql.startsWith('INSERT OR IGNORE INTO app_state')) {
      if (!this.appState) this.appState = { id: parameters[0], payload: parameters[1], revision: 1 }
      return this.result(1)
    }
    if (sql.startsWith('UPDATE app_state SET payload = ?, revision = revision + 1')) {
      const [payload, , id, expectedRevision] = parameters
      if (this.failNextStateCas) {
        this.failNextStateCas = false
        if (this.appState) this.appState.revision += 1
        return this.result()
      }
      if (this.appState?.id === id && this.appState.revision === expectedRevision) {
        this.appState.payload = payload
        this.appState.revision += 1
        return this.result(1)
      }
      return this.result()
    }
    if (sql.startsWith('SELECT request_count, expires_at FROM api_rate_limits')) {
      const row = this.rateLimits.get(parameters[0])
      return row ? { ...row } : null
    }
    if (sql.startsWith('INSERT INTO api_rate_limits')) {
      this.rateLimits.set(parameters[0], { request_count: 1, expires_at: parameters[1] })
      return this.result(1)
    }
    if (sql.startsWith('UPDATE api_rate_limits SET request_count = request_count + 1')) {
      const key = parameters[1]
      const row = this.rateLimits.get(key)
      if (row) row.request_count += 1
      return this.result(row ? 1 : 0)
    }
    if (sql.startsWith('DELETE FROM api_rate_limits WHERE expires_at <= ?')) {
      let removed = 0
      for (const [key, row] of this.rateLimits) {
        if (row.expires_at <= parameters[0]) { this.rateLimits.delete(key); removed += 1 }
      }
      return this.result(removed)
    }
    throw new Error(`Unsupported FakeD1 statement: ${sql}`)
  }

  payload() {
    return this.appState ? JSON.parse(this.appState.payload) : null
  }
}

class FakeR2 {
  constructor() {
    this.objects = new Map()
    this.failDeleteOnce = false
  }

  async get(key) {
    const object = this.objects.get(key)
    if (!object) return null
    return {
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata,
      arrayBuffer: async () => Buffer.from(object.bytes),
    }
  }

  async put(key, bytes, options = {}) {
    this.objects.set(key, { bytes: Buffer.from(bytes), ...options })
  }

  async delete(key) {
    this.objects.delete(key)
    if (this.failDeleteOnce) {
      this.failDeleteOnce = false
      throw new Error('simulated R2 delete failure')
    }
  }
}

function makeSeed(marker = 'seed-a') {
  return {
    version: 2,
    tenants: {
      'TENANT-SUNSEA': {
        marker,
        'inventory-locations': { data: [{ id: 'WH-KEEP', name: '정상 창고' }, { id: 'WH-77537', name: 'ㅇㅇ' }] },
        'inventory-movements': { data: [{ id: 'MOV-KEEP', product: '정상 품목', lot: 'LOT-KEEP' }, { id: 'MOV-QA', product: '통합 QA 테스트 품목', lot: 'LOT-QA-260820' }] },
      },
    },
    platform: { tenants: [] },
    accountApprovals: {},
    accountCredentials: {},
    invitedAccounts: [],
    passwordResetRequests: [],
  }
}

function createMockExpress(documentDirectory) {
  const contexts = new Map()
  let currentOptions
  let nextToken = 1
  return {
    contexts,
    createApp(options) {
      currentOptions = options
      return {
        listen(port) {
          contexts.set(port, options)
          return { close(callback) { contexts.delete(port); callback() } }
        },
      }
    },
    httpServerHandler({ port }) {
      const options = currentOptions
      assert.equal(contexts.get(port), options)
      return {
        async fetch(request) {
          const url = new URL(request.url)
          const store = options.initialWorkspaceStore
          if (url.pathname === '/api/test/read') {
            return Response.json({ counter: store.counter ?? 0, marker: store.tenants?.['TENANT-SUNSEA']?.marker })
          }
          if (url.pathname === '/api/test/increment') {
            await new Promise((resolve) => setTimeout(resolve, 5))
            store.counter = (store.counter ?? 0) + 1
            options.onWorkspaceStoreChange()
            return Response.json({ counter: store.counter })
          }
          if (url.pathname === '/api/auth/login') {
            const token = `token-${nextToken++}`
            options.sessions.set(token, { accountId: 'TEST', expiresAt: Date.now() + 60_000 })
            return Response.json({ ok: true }, { headers: { 'Set-Cookie': `onfactory_session=${token}; HttpOnly; Path=/` } })
          }
          if (url.pathname === '/api/auth/session') {
            const token = String(request.headers.get('cookie') ?? '').match(/onfactory_session=([^;]+)/)?.[1]
            return options.sessions.has(token) ? Response.json({ authenticated: true }) : Response.json({ authenticated: false }, { status: 401 })
          }
          if (url.pathname === '/api/auth/password-reset' || url.pathname === '/api/auth/password-reset/confirm') {
            return Response.json({ accepted: true }, { status: 202 })
          }
          if (request.method === 'POST' && url.pathname === '/api/documents') {
            const id = 'DOC-TEST-UPLOAD'
            const tenantId = 'TENANT-SUNSEA'
            const document = { id, tenantId, name: 'test.txt', originalName: 'test.txt', mime: 'text/plain' }
            const tenant = store.tenants[tenantId] ?? {}
            tenant['company-documents'] = { data: [document] }
            store.tenants[tenantId] = tenant
            const directory = path.join(documentDirectory, tenantId)
            mkdirSync(directory, { recursive: true })
            writeFileSync(path.join(directory, `${id}.bin`), 'binary-content')
            options.onWorkspaceStoreChange()
            return Response.json({ document }, { status: 201 })
          }
          if (request.method === 'DELETE' && url.pathname === '/api/documents/DOC-TEST-UPLOAD') {
            const record = store.tenants['TENANT-SUNSEA']?.['company-documents']
            if (record) record.data = record.data.filter((document) => document.id !== 'DOC-TEST-UPLOAD')
            options.onWorkspaceStoreChange()
            return Response.json({ deleted: true })
          }
          return Response.json({ ok: true })
        },
      }
    },
  }
}

function workerOptions(createSitesWorker, database, bucket, mock, seed, overrides = {}) {
  return createSitesWorker({
    env: { DB: database, FILES: bucket, ERP_SEED_PASSWORD: 'Hosted-Seed!2026' },
    createApp: mock.createApp,
    httpServerHandler: mock.httpServerHandler,
    initialWorkspaceSeed: seed,
    documentDirectory: mock.documentDirectory,
    lockOptions: { waitMs: 2_000, leaseMs: 500, heartbeatMs: 100 },
    ...overrides,
  })
}

const createSitesWorker = await loadWorkerFactory()

test('Sites Worker seeds current state once and preserves it across worker instances', async () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'onfactory-sites-seed-'))
  try {
    const database = new FakeD1()
    const bucket = new FakeR2()
    const mock = createMockExpress(temporaryDirectory)
    mock.documentDirectory = temporaryDirectory
    const first = workerOptions(createSitesWorker, database, bucket, mock, makeSeed('seed-a'))
    const second = workerOptions(createSitesWorker, database, bucket, mock, makeSeed('seed-b'))
    const firstRead = await first.fetch(new Request('https://erp.test/api/test/read'))
    const secondRead = await second.fetch(new Request('https://erp.test/api/test/read'))
    assert.equal((await firstRead.json()).marker, 'seed-a')
    assert.equal((await secondRead.json()).marker, 'seed-a')
    assert.equal(database.payload().workspaceStore.tenants['TENANT-SUNSEA'].marker, 'seed-a')
    const seededTenant = database.payload().workspaceStore.tenants['TENANT-SUNSEA']
    assert.deepEqual(seededTenant['inventory-locations'].data.map((item) => item.id), ['WH-KEEP'])
    assert.deepEqual(seededTenant['inventory-movements'].data.map((item) => item.id), ['MOV-KEEP'])
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

test('scheduled maintenance materializes performance and persists the resulting workspace snapshot', async () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'onfactory-sites-performance-'))
  try {
    const database = new FakeD1()
    const bucket = new FakeR2()
    const mock = createMockExpress(temporaryDirectory)
    mock.documentDirectory = temporaryDirectory
    const calls = []
    const worker = workerOptions(createSitesWorker, database, bucket, mock, makeSeed(), {
      billingService: { reconcilePendingUsageBatch: async () => {}, recordDailyStorageSnapshot: async () => {}, createMonthlySnapshot: async () => {} },
      runPerformanceMonthlyMaintenance: async ({ workspaceStore, tenantIds }) => {
        for (const tenantId of tenantIds) {
          calls.push(tenantId)
          workspaceStore.tenants[tenantId]['performance-reports'] = {
            data: [{ id: `PERFS-${tenantId}`, immutable: true }],
            updatedAt: '2026-08-21T00:00:00.000Z',
          }
        }
        return calls.map((tenantId) => ({ tenantId, created: true }))
      },
    })
    let scheduledTask
    await worker.scheduled({}, undefined, { waitUntil(task) { scheduledTask = task } })
    await scheduledTask

    assert.deepEqual(calls, ['TENANT-SUNSEA'])
    assert.equal(database.payload().workspaceStore.tenants['TENANT-SUNSEA']['performance-reports'].data[0].immutable, true)
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

test('scheduled billing reconciliation failure is isolated per tenant and does not skip snapshots or performance', async () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'onfactory-sites-billing-reconciliation-'))
  try {
    const database = new FakeD1()
    const bucket = new FakeR2()
    const mock = createMockExpress(temporaryDirectory)
    mock.documentDirectory = temporaryDirectory
    const seed = makeSeed()
    seed.tenants['TENANT-POHANG'] = {}
    const calls = { reconcile: [], storage: [], monthly: [], performance: [] }
    const worker = workerOptions(createSitesWorker, database, bucket, mock, seed, {
      billingService: {
        async reconcilePendingUsageBatch(_actor, { tenantId }) {
          calls.reconcile.push(tenantId)
          if (tenantId === 'TENANT-SUNSEA') throw new Error('simulated reconciliation outage')
        },
        async recordDailyStorageSnapshot(_actor, { tenantId }) { calls.storage.push(tenantId) },
        async createMonthlySnapshot(_actor, { tenantId }) { calls.monthly.push(tenantId) },
      },
      runPerformanceMonthlyMaintenance: async ({ tenantIds }) => {
        calls.performance.push(...tenantIds)
        return [...tenantIds].map((tenantId) => ({ tenantId, created: false }))
      },
    })
    let scheduledTask
    await worker.scheduled({}, undefined, { waitUntil(task) { scheduledTask = task } })
    await assert.rejects(scheduledTask, /정기 유지관리 일부 작업이 실패했습니다/)
    assert.deepEqual(calls.reconcile, ['TENANT-SUNSEA', 'TENANT-POHANG'])
    assert.deepEqual(calls.storage, ['TENANT-SUNSEA', 'TENANT-POHANG'])
    assert.deepEqual(calls.monthly, ['TENANT-SUNSEA', 'TENANT-POHANG'])
    assert.deepEqual(calls.performance, ['TENANT-SUNSEA', 'TENANT-POHANG'])
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

test('D1 request lock serializes worker instances and shares sessions from the latest snapshot', async () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'onfactory-sites-lock-'))
  try {
    const database = new FakeD1()
    const bucket = new FakeR2()
    const mock = createMockExpress(temporaryDirectory)
    mock.documentDirectory = temporaryDirectory
    const workers = [
      workerOptions(createSitesWorker, database, bucket, mock, makeSeed()),
      workerOptions(createSitesWorker, database, bucket, mock, makeSeed()),
    ]
    const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => workers[index % 2].fetch(new Request('https://erp.test/api/test/increment', { method: 'POST' }))))
    assert.deepEqual(responses.map((response) => response.status), Array(8).fill(200))
    assert.equal(database.payload().workspaceStore.counter, 8)

    const login = await workers[0].fetch(new Request('https://erp.test/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.10' },
      body: JSON.stringify({ email: 'worker@example.com', password: 'secret' }),
    }))
    const cookie = login.headers.get('set-cookie')
    const session = await workers[1].fetch(new Request('https://erp.test/api/auth/session', { headers: { cookie } }))
    assert.equal(session.status, 200)
    assert.equal((await session.json()).authenticated, true)
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

test('login, reset and reset confirmation use durable D1 rate limits', async () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'onfactory-sites-rate-'))
  try {
    const database = new FakeD1()
    const bucket = new FakeR2()
    const mock = createMockExpress(temporaryDirectory)
    mock.documentDirectory = temporaryDirectory
    const worker = workerOptions(createSitesWorker, database, bucket, mock, makeSeed())
    const scenarios = [
      ['/api/auth/login', 10, { email: 'rate@example.com', password: 'wrong' }],
      ['/api/auth/password-reset', 5, { email: 'rate@example.com' }],
      ['/api/auth/password-reset/confirm', 10, { token: 'a'.repeat(43), newPassword: 'Strong!Pass123' }],
    ]
    for (const [route, limit, body] of scenarios) {
      for (let attempt = 0; attempt < limit; attempt += 1) {
        const response = await worker.fetch(new Request(`https://erp.test${route}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.113.${limit}` },
          body: JSON.stringify(body),
        }))
        assert.notEqual(response.status, 429)
      }
      const limited = await worker.fetch(new Request(`https://erp.test${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.113.${limit}` },
        body: JSON.stringify(body),
      }))
      assert.equal(limited.status, 429)
      assert.equal((await limited.json()).error.code, 'AUTH_RATE_LIMITED')
      assert.ok(Number(limited.headers.get('retry-after')) > 0)
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

test('R2 upload is removed on CAS conflict and R2 delete failure restores D1 metadata', async () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'onfactory-sites-r2-'))
  try {
    const database = new FakeD1()
    const bucket = new FakeR2()
    const mock = createMockExpress(temporaryDirectory)
    mock.documentDirectory = temporaryDirectory
    const worker = workerOptions(createSitesWorker, database, bucket, mock, makeSeed())
    await worker.fetch(new Request('https://erp.test/api/test/read'))
    database.failNextStateCas = true
    const conflicted = await worker.fetch(new Request('https://erp.test/api/documents', { method: 'POST', body: 'binary-content' }))
    assert.equal(conflicted.status, 409)
    assert.equal(bucket.objects.has('documents/TENANT-SUNSEA/DOC-TEST-UPLOAD.bin'), false)
    assert.equal(database.payload().workspaceStore.tenants['TENANT-SUNSEA']['company-documents'], undefined)

    const uploaded = await worker.fetch(new Request('https://erp.test/api/documents', { method: 'POST', body: 'binary-content' }))
    assert.equal(uploaded.status, 201)
    assert.equal(bucket.objects.has('documents/TENANT-SUNSEA/DOC-TEST-UPLOAD.bin'), true)
    bucket.failDeleteOnce = true
    const deleted = await worker.fetch(new Request('https://erp.test/api/documents/DOC-TEST-UPLOAD', { method: 'DELETE' }))
    assert.equal(deleted.status, 500)
    assert.equal(bucket.objects.has('documents/TENANT-SUNSEA/DOC-TEST-UPLOAD.bin'), true)
    const documents = database.payload().workspaceStore.tenants['TENANT-SUNSEA']['company-documents'].data
    assert.equal(documents.some((document) => document.id === 'DOC-TEST-UPLOAD'), true)
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

test('hosted worker fails closed without a secure seed secret and never exposes reset tokens', async () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'onfactory-sites-auth-'))
  try {
    const database = new FakeD1()
    const bucket = new FakeR2()
    const mock = createMockExpress(temporaryDirectory)
    mock.documentDirectory = temporaryDirectory
    const unsafeWorker = createSitesWorker({
      env: { DB: database, FILES: bucket },
      createApp: mock.createApp,
      httpServerHandler: mock.httpServerHandler,
      initialWorkspaceSeed: makeSeed(),
      documentDirectory: temporaryDirectory,
    })
    const originalConsoleError = console.error
    console.error = () => {}
    let failed
    try { failed = await unsafeWorker.fetch(new Request('https://erp.test/api/test/read')) }
    finally { console.error = originalConsoleError }
    assert.equal(failed.status, 503)
    assert.equal((await failed.json()).error.code, 'SERVER_CONFIGURATION_ERROR')

    let capturedOptions
    const safeMock = createMockExpress(temporaryDirectory)
    const safeWorker = createSitesWorker({
      env: { DB: database, FILES: bucket, ERP_SEED_PASSWORD: 'Hosted-Seed!2026' },
      createApp(options) { capturedOptions = options; return safeMock.createApp(options) },
      httpServerHandler: safeMock.httpServerHandler,
      initialWorkspaceSeed: makeSeed(),
      documentDirectory: temporaryDirectory,
    })
    const response = await safeWorker.fetch(new Request('https://erp.test/api/test/read'))
    assert.equal(response.status, 200)
    assert.equal(capturedOptions.exposePasswordResetTokens, false)
    assert.equal(capturedOptions.requireSeedPasswordChange, true)
    assert.equal(capturedOptions.seedPassword, 'Hosted-Seed!2026')
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

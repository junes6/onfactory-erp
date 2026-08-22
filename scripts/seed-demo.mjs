import { scryptSync } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { DEMO_ACCOUNT_DEFINITIONS } from '../server/store/demo-seed.mjs'
import { StoreVerificationError } from '../server/store/errors.mjs'
import { PostgresStoreAdapter } from '../server/store/postgres-store.mjs'
import { assertKnownWorkspaceKeys } from '../server/store/workspace-codec.mjs'
import { prepareMigrationSnapshot, verifyNormalizedCounts } from './migrate-json-to-pg.mjs'

const REQUIRED_DEMO_TENANTS = new Set(['TENANT-SUNSEA', 'TENANT-POHANG', 'TENANT-3DMUSE'])
const PLATFORM_COLLECTIONS = ['tenants', 'supportTickets', 'integrations', 'actions', 'auditEvents']

function passwordHash(password, accountId) {
  return scryptSync(String(password), `onfactory:${accountId}`, 32).toString('hex')
}

function mergeById(existing, seeded) {
  const seededIds = new Set(seeded.map((item) => item?.id).filter(Boolean))
  return [...seeded.map((item) => structuredClone(item)), ...existing.filter((item) => !seededIds.has(item?.id))]
}

export function assertDemoTenantIsolation(snapshot) {
  assertKnownWorkspaceKeys(snapshot)
  for (const required of REQUIRED_DEMO_TENANTS) {
    if (!snapshot.tenants[required]) throw new StoreVerificationError(`데모 fixture에 ${required}가 없습니다.`)
  }
  const tenantIds = new Set(Object.keys(snapshot.tenants))
  for (const [tenantId, tenantStore] of Object.entries(snapshot.tenants)) {
    for (const [key, record] of Object.entries(tenantStore)) {
      const values = Array.isArray(record?.data) ? record.data : record?.data && typeof record.data === 'object' ? Object.values(record.data) : []
      for (const item of values) {
        if (item?.tenantId && item.tenantId !== tenantId) throw new StoreVerificationError(`${tenantId}/${key}에 다른 tenantId(${item.tenantId}) 데이터가 섞여 있습니다.`)
      }
    }
  }
  for (const collection of PLATFORM_COLLECTIONS.filter((key) => key !== 'tenants')) {
    for (const item of snapshot.platform?.[collection] ?? []) {
      if (item?.tenantId && !tenantIds.has(item.tenantId)) throw new StoreVerificationError(`platform.${collection}에 알 수 없는 tenantId가 있습니다: ${item.tenantId}`)
    }
  }
  return true
}

export function buildDemoSeedSnapshot(source, {
  password,
  requirePasswordChange = true,
  now = new Date(),
  referenceDate = now.toISOString().slice(0, 10),
} = {}) {
  if (typeof password !== 'string' || password.length < 12) throw new StoreVerificationError('데모 seed 비밀번호는 12자 이상이어야 합니다.')
  const { snapshot, rawDueByEntity } = prepareMigrationSnapshot(source, referenceDate)
  assertDemoTenantIsolation(snapshot)
  snapshot.tenantMetadata ??= {}
  const platformById = new Map((snapshot.platform?.tenants ?? []).map((tenant) => [tenant.id, tenant]))
  for (const tenantId of Object.keys(snapshot.tenants)) {
    const tenant = platformById.get(tenantId)
    snapshot.tenantMetadata[tenantId] = {
      ...(snapshot.tenantMetadata[tenantId] ?? {}),
      name: tenant?.name ?? tenantId,
      isDemo: true,
    }
    if (tenant) tenant.isDemo = true
  }
  snapshot.accounts = DEMO_ACCOUNT_DEFINITIONS.map((account) => structuredClone(account))
  snapshot.accountApprovals = Object.fromEntries(snapshot.accounts
    .filter((account) => account.approved)
    .map((account) => [account.id, 'approved']))
  const issuedAt = now.toISOString()
  const expiresAt = requirePasswordChange ? new Date(now.getTime() + 72 * 60 * 60 * 1_000).toISOString() : null
  snapshot.accountCredentials = Object.fromEntries(snapshot.accounts.map((account) => [account.id, {
    passwordHash: passwordHash(password, account.id),
    mustChangePassword: Boolean(requirePasswordChange),
    temporaryPasswordExpiresAt: expiresAt,
    issuedAt,
  }]))
  return { snapshot, rawDueByEntity }
}

export function mergeDemoSeed(existing, demo) {
  const merged = structuredClone(existing)
  merged.version = 2
  merged.tenants ??= {}
  for (const tenantId of REQUIRED_DEMO_TENANTS) merged.tenants[tenantId] = structuredClone(demo.tenants[tenantId])
  merged.tenantMetadata = { ...(merged.tenantMetadata ?? {}), ...(demo.tenantMetadata ?? {}) }
  merged.platform ??= { tenants: [], supportTickets: [], integrations: [], actions: [], auditEvents: [] }
  for (const collection of PLATFORM_COLLECTIONS) {
    merged.platform[collection] = mergeById(merged.platform[collection] ?? [], demo.platform?.[collection] ?? [])
  }
  merged.accounts = mergeById(merged.accounts ?? [], demo.accounts ?? [])
  merged.accountApprovals = { ...(merged.accountApprovals ?? {}), ...(demo.accountApprovals ?? {}) }
  merged.accountCredentials = { ...(merged.accountCredentials ?? {}), ...(demo.accountCredentials ?? {}) }
  merged.invitedAccounts ??= []
  merged.passwordResetRequests ??= []
  assertKnownWorkspaceKeys(merged)
  return merged
}

export async function seedDemo({
  fixturePath = 'worker/initial-workspace-state.json',
  databaseUrl,
  password,
  requirePasswordChange = true,
  referenceDate = new Date().toISOString().slice(0, 10),
  pool,
  applySchema = true,
} = {}) {
  const source = JSON.parse(await readFile(path.resolve(fixturePath), 'utf8'))
  const prepared = buildDemoSeedSnapshot(source, { password, requirePasswordChange, referenceDate })
  const adapter = new PostgresStoreAdapter({ databaseUrl, pool })
  try {
    if (applySchema) await adapter.applySchema()
    await adapter.connect()
    const existing = await adapter.loadSnapshot()
    const next = mergeDemoSeed(existing, prepared.snapshot)
    await adapter.commitSnapshot(next, {
      referenceDate,
      rawDueByEntity: prepared.rawDueByEntity,
      verify: verifyNormalizedCounts,
    })
    const restored = await adapter.loadSnapshot()
    assertDemoTenantIsolation(restored)
    return restored
  } finally {
    await adapter.close()
  }
}

function parseArgs(argv) {
  return Object.fromEntries(argv.map((argument) => {
    const [key, ...value] = argument.replace(/^--/, '').split('=')
    return [key, value.length ? value.join('=') : true]
  }))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const databaseUrl = String(args['database-url'] ?? process.env.DATABASE_URL ?? '').trim()
  const password = String(args.password ?? process.env.DEMO_SEED_PASSWORD ?? '')
  if (!databaseUrl) throw new StoreVerificationError('DATABASE_URL 또는 --database-url이 필요합니다.')
  const result = await seedDemo({
    fixturePath: args.fixture,
    databaseUrl,
    password,
    requirePasswordChange: args['require-password-change'] !== 'false',
    referenceDate: String(args['base-date'] ?? process.env.MIGRATION_BASE_DATE ?? new Date().toISOString().slice(0, 10)),
    applySchema: args['skip-schema'] !== true,
  })
  console.log(`[seed] 데모 tenant ${[...REQUIRED_DEMO_TENANTS].join(', ')}를 분리 적재했습니다. accounts=${result.accounts.length}, is_demo=true`)
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`[seed] 실패: ${error?.message}`)
    process.exitCode = 1
  })
}

import { copyFile, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { COMPANY_DOCUMENTS_KEY } from '../server/store/constants.mjs'
import { StoreVerificationError } from '../server/store/errors.mjs'
import { PostgresStoreAdapter } from '../server/store/postgres-store.mjs'
import { assertKnownWorkspaceKeys, encodeWorkspaceRecord, workspaceTableForKey } from '../server/store/workspace-codec.mjs'

const KOREA_OFFSET = '+09:00'

function calendarDate(baseDate, delta) {
  const [year, month, day] = baseDate.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + delta))
  return date.toISOString().slice(0, 10)
}

export function normalizeLegacyDue(value, referenceDate) {
  const raw = String(value ?? '').trim()
  if (!raw) return { due: raw, rawDue: null }
  const alreadyIso = new Date(raw)
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw) && !Number.isNaN(alreadyIso.getTime())) {
    return { due: alreadyIso.toISOString(), rawDue: null }
  }
  const relative = raw.match(/^(어제|오늘|내일|모레)(?:\s+(\d{1,2}):(\d{2}))?$/)
  if (relative) {
    const offsets = { 어제: -1, 오늘: 0, 내일: 1, 모레: 2 }
    const date = calendarDate(referenceDate, offsets[relative[1]])
    const hour = (relative[2] ?? '00').padStart(2, '0')
    const minute = relative[3] ?? '00'
    return { due: new Date(`${date}T${hour}:${minute}:00${KOREA_OFFSET}`).toISOString(), rawDue: raw }
  }
  const monthDay = raw.match(/^(?:(\d{4})년\s*)?(\d{1,2})월\s*(\d{1,2})일(?:\s+(\d{1,2}):(\d{2}))?$/)
  if (monthDay) {
    const year = monthDay[1] ?? referenceDate.slice(0, 4)
    const date = `${year}-${monthDay[2].padStart(2, '0')}-${monthDay[3].padStart(2, '0')}`
    const time = `${(monthDay[4] ?? '00').padStart(2, '0')}:${monthDay[5] ?? '00'}:00`
    const parsed = new Date(`${date}T${time}${KOREA_OFFSET}`)
    if (!Number.isNaN(parsed.getTime())) return { due: parsed.toISOString(), rawDue: raw }
  }
  const local = raw.match(/^(\d{4})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})(?:[T\s.]+(\d{1,2}):(\d{2}))?$/)
  if (local) {
    const date = `${local[1]}-${local[2].padStart(2, '0')}-${local[3].padStart(2, '0')}`
    const time = `${(local[4] ?? '00').padStart(2, '0')}:${local[5] ?? '00'}:00`
    const parsed = new Date(`${date}T${time}${KOREA_OFFSET}`)
    if (!Number.isNaN(parsed.getTime())) return { due: parsed.toISOString(), rawDue: raw }
  }
  return { due: raw, rawDue: raw }
}

export function prepareMigrationSnapshot(source, referenceDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(referenceDate)) throw new StoreVerificationError('기준일은 YYYY-MM-DD 형식이어야 합니다.')
  const snapshot = structuredClone(source)
  snapshot.version = 2
  snapshot.platform ??= { tenants: [], supportTickets: [], integrations: [], actions: [], auditEvents: [] }
  snapshot.accountApprovals ??= {}
  snapshot.accountCredentials ??= {}
  snapshot.invitedAccounts ??= []
  snapshot.passwordResetRequests ??= []
  assertKnownWorkspaceKeys(snapshot)
  const rawDueByEntity = {}
  for (const [tenantId, tenantStore] of Object.entries(snapshot.tenants)) {
    const record = tenantStore['work-items']
    if (!Array.isArray(record?.data)) continue
    record.data = record.data.map((item) => {
      if (!item?.id) throw new StoreVerificationError(`${tenantId}/work-items 항목에 id가 없습니다.`)
      const converted = normalizeLegacyDue(item.due, referenceDate)
      if (converted.rawDue) rawDueByEntity[`${tenantId}:${item.id}`] = converted.rawDue
      return { ...item, due: converted.due }
    })
  }
  return { snapshot, rawDueByEntity }
}

function expectedRows(snapshot) {
  const counts = []
  for (const [orgId, tenantStore] of Object.entries(snapshot.tenants)) {
    for (const [key, record] of Object.entries(tenantStore)) {
      counts.push({ orgId, key, table: workspaceTableForKey(key), count: encodeWorkspaceRecord(orgId, key, record).rows.length })
    }
  }
  return counts
}

export async function verifyNormalizedCounts(client, snapshot) {
  const mismatches = []
  const counts = []
  for (const expected of expectedRows(snapshot)) {
    const typeClause = expected.key === COMPANY_DOCUMENTS_KEY ? " AND item_type = 'company-document'" : ''
    const result = await client.query(`SELECT COUNT(*)::int AS count FROM ${expected.table} WHERE org_id = $1 AND deleted_at IS NULL${typeClause}`, [expected.orgId])
    const actual = Number(result.rows[0]?.count ?? 0)
    const row = {
      org: expected.orgId,
      key: expected.key,
      source: expected.count,
      loaded: actual,
      status: actual === expected.count ? 'OK' : 'MISMATCH',
    }
    counts.push(row)
    if (row.status !== 'OK') mismatches.push(`${expected.orgId}/${expected.key}: expected=${expected.count}, actual=${actual}`)
  }
  if (mismatches.length) {
    const error = new StoreVerificationError(`Postgres 이관 건수 검증 실패: ${mismatches.join('; ')}`)
    error.counts = counts
    throw error
  }
  return counts
}

export function migrationBackupPath(sourcePath, now = new Date()) {
  const stamp = now.toISOString().replaceAll(':', '').replaceAll('.', '-')
  return `${sourcePath}.${stamp}.bak`
}

function parseArgs(argv) {
  const options = {}
  for (const argument of argv) {
    const [key, ...rest] = argument.replace(/^--/, '').split('=')
    options[key] = rest.length ? rest.join('=') : true
  }
  return options
}

export async function migrateJsonToPostgres({
  sourcePath,
  databaseUrl,
  referenceDate,
  pool,
  applySchema = true,
  backup = true,
} = {}) {
  const resolvedSource = path.resolve(sourcePath ?? 'server/data/workspace-state.json')
  const original = await readFile(resolvedSource, 'utf8')
  const sourceStat = await stat(resolvedSource)
  const parsed = JSON.parse(original)
  const prepared = prepareMigrationSnapshot(parsed, referenceDate)
  const backupPath = backup ? migrationBackupPath(resolvedSource) : null
  if (backupPath) await copyFile(resolvedSource, backupPath, 0)

  const adapter = new PostgresStoreAdapter({ databaseUrl, pool })
  try {
    if (applySchema) await adapter.applySchema()
    await adapter.connect()
    await adapter.loadSnapshot()
    await adapter.commitSnapshot(prepared.snapshot, {
      referenceDate,
      rawDueByEntity: prepared.rawDueByEntity,
      verify: verifyNormalizedCounts,
    })
    const counts = await verifyNormalizedCounts(adapter.pool, prepared.snapshot)
    const restored = await adapter.loadSnapshot()
    const after = await readFile(resolvedSource, 'utf8')
    const afterStat = await stat(resolvedSource)
    if (after !== original || afterStat.size !== sourceStat.size || afterStat.mtimeMs !== sourceStat.mtimeMs) {
      throw new StoreVerificationError('원본 JSON이 이관 중 변경되었습니다.')
    }
    return { backupPath, sourcePath: resolvedSource, snapshot: restored, counts }
  } finally {
    await adapter.close()
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const databaseUrl = String(args['database-url'] ?? process.env.DATABASE_URL ?? '').trim()
  if (!databaseUrl) throw new StoreVerificationError('DATABASE_URL 또는 --database-url이 필요합니다.')
  const referenceDate = String(args['base-date'] ?? process.env.MIGRATION_BASE_DATE ?? '').trim()
  if (!referenceDate) throw new StoreVerificationError('상대 날짜 변환을 위한 --base-date=YYYY-MM-DD가 필요합니다.')
  const result = await migrateJsonToPostgres({
    sourcePath: args.source,
    databaseUrl,
    referenceDate,
    applySchema: args['skip-schema'] !== true,
    backup: args['skip-backup'] !== true,
  })
  console.table(result.counts)
  console.log(`[migrate] ${result.sourcePath} -> Postgres 완료 (${result.counts.length}개 tenant/key 검증)`)
  if (result.backupPath) console.log(`[migrate] 불변 원본 백업: ${result.backupPath}`)
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`[migrate] 실패: ${error?.message}`)
    process.exitCode = 1
  })
}

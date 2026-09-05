import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import pg from 'pg'

import { COMPANY_DOCUMENTS_KEY, emptyWorkspaceStore, GUEST_SCOPE_TABLES, WORKSPACE_KEY_SET, WORKSPACE_KEYS } from './constants.mjs'
import { StoreVerificationError } from './errors.mjs'
import { PersistentSessionMap } from './persistent-session-map.mjs'
import { canonicalIso, prepareTemporalRow } from './temporal-codec.mjs'
import {
  assertKnownWorkspaceKeys,
  decodeWorkspaceRecord,
  deriveOutboxEvents,
  diffWorkspaceRecords,
  encodeWorkspaceRecord,
  workspaceTableForKey,
} from './workspace-codec.mjs'

const { Pool } = pg
const platformCollections = Object.freeze({
  tenants: 'platform_tenants',
  supportTickets: 'platform_support_tickets',
  integrations: 'platform_integrations',
  actions: 'platform_actions',
  auditEvents: 'platform_audit_events',
})

const clone = (value) => structuredClone(value)
const json = (value) => JSON.stringify(value ?? {})
const schemaFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db/postgres-schema.sql')

// pg-mem은 RLS DDL·SQL 함수·DO 블록을 파싱하지 못한다. 실 Postgres에는 그대로 적용되고,
// 테스트용 메모리 엔진에만 이 구간을 걷어낸 스키마를 준다. 테이블·정책 이름을 박아 두면
// 정책을 추가할 때마다 정규식을 늘려야 하므로 구문 단위로 잡는다(정책 본문에는 ';'가 없다).
export function withoutPgMemUnsupportedRls(sql) {
  return sql
    // 함수·DO 블록을 먼저 지운다 — DO 블록 안에도 CREATE POLICY 문구가 들어 있기 때문이다.
    .replace(/CREATE OR REPLACE FUNCTION [\s\S]*?\$\$;\s*/g, '')
    .replace(/DO \$\$[\s\S]*?END \$\$;\s*/g, '')
    .replace(/ALTER TABLE \w+ (?:ENABLE|FORCE) ROW LEVEL SECURITY;\s*/g, '')
    .replace(/DROP POLICY IF EXISTS [^;]+;\s*/g, '')
    .replace(/CREATE POLICY [^;]+;\s*/g, '')
}

async function applyStoreSchema(pool, sql) {
  try {
    await pool.query(sql)
  } catch (error) {
    const message = `${error?.message ?? ''}\n${error?.data?.error ?? ''}`
    if (!message.includes('pg-mem')) throw error
    // pg-mem deliberately does not implement PostgreSQL RLS DDL. Production
    // Postgres/Supabase still receives the policies; the in-memory SQL engine
    // is used only to validate row normalization in isolated tests.
    await pool.query(withoutPgMemUnsupportedRls(sql))
  }
}

export async function applyPostgresServiceContext(client) {
  await client.query(
    "SELECT set_config('app.role', $1, TRUE), set_config('app.org_id', $2, TRUE)",
    ['service', '__service__'],
  )
}

function requireIdentifier(value, label) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new StoreVerificationError(`게스트 컨텍스트에 ${label}가 없습니다.`)
  return text
}

// app.guest_project_ids는 콤마로 이어 붙인 한 문자열이라, 콤마가 든 id는 범위를 조작할 수 있다.
// 그런 id는 우리 규칙('PRJ-…')에 없으므로 조용히 버리지 않고 실패시킨다.
function normalizeGuestProjectIds(projectIds) {
  const list = Array.isArray(projectIds) ? projectIds : []
  const result = []
  for (const value of list) {
    if (typeof value !== 'string' || !value.trim()) continue
    if (value.includes(',')) throw new StoreVerificationError(`프로젝트 id에 콤마를 쓸 수 없습니다: ${value}`)
    if (!result.includes(value.trim())) result.push(value.trim())
  }
  return result
}

// 게스트 세션 변수. 트랜잭션 로컬(TRUE)이라 COMMIT/ROLLBACK 뒤에는 풀의 다른 요청에 새지 않는다.
// 이 컨텍스트에는 쓰기 정책이 없으므로 SELECT 전용 트랜잭션 안에서만 부른다.
export async function applyPostgresGuestContext(client, { tenantId, accountId, projectIds } = {}) {
  const orgId = requireIdentifier(tenantId, 'tenantId')
  const currentAccountId = requireIdentifier(accountId, 'accountId')
  const scopedProjectIds = normalizeGuestProjectIds(projectIds)
  await client.query(
    "SELECT set_config('app.role', $1, TRUE), set_config('app.org_id', $2, TRUE), set_config('app.current_account_id', $3, TRUE), set_config('app.guest_project_ids', $4, TRUE)",
    ['tenant-guest', orgId, currentAccountId, scopedProjectIds.join(',')],
  )
}

// 게스트 범위 조회 대상은 워크스페이스 키('project-spaces', 'company-documents')로도, 테이블 이름으로도 받는다.
// 정책이 없는 테이블은 거절한다 — 정책 없는 테이블에 게스트 컨텍스트로 SELECT하면 전량이 보이기 때문이다.
function resolveGuestScopeTable(table) {
  const name = typeof table === 'string' ? table.trim() : ''
  const sqlTable = (WORKSPACE_KEY_SET.has(name) || name === COMPANY_DOCUMENTS_KEY) ? workspaceTableForKey(name) : name
  const scope = GUEST_SCOPE_TABLES[sqlTable]
  if (!scope) throw new StoreVerificationError(`게스트 범위 조회를 지원하지 않는 테이블입니다: ${table}`)
  return { table: sqlTable, itemType: scope.itemType ?? null }
}

function chunked(list, size) {
  const result = []
  for (let index = 0; index < list.length; index += size) result.push(list.slice(index, index + size))
  return result
}

function isoOrNull(value) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function koreaDate(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(value)
}

function platformTimestampIso(value, referenceDate) {
  const source = String(value ?? '').trim()
  if (!source || source === '—') return null
  const dotted = source.match(/^(\d{4})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})[.\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (dotted) {
    const [, year, month, day, hour, minute, second = '00'] = dotted
    return canonicalIso(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute}:${second}+09:00`)
  }
  if (/^\d{2}:\d{2}$/.test(source)) return canonicalIso(null, { date: referenceDate ?? koreaDate(), time: source })
  return canonicalIso(source)
}

function platformTimestampFacade(value, mode = 'iso') {
  if (!value) return null
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(value))
  const get = (type) => parts.find((part) => part.type === type)?.value
  if (mode === 'time') return `${get('hour')}:${get('minute')}`
  if (mode === 'display') return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
  return new Date(value).toISOString()
}

function preparePlatformItem(table, item, referenceDate) {
  const payload = stripSensitivePayload(item)
  const temporal = {}
  if (table === 'platform_tenants') {
    temporal.domainCreatedAt = platformTimestampIso(payload.createdAt, referenceDate)
    temporal.syncAt = platformTimestampIso(payload.sync, referenceDate)
    temporal.rawSync = temporal.syncAt ? null : payload.sync ?? null
    delete payload.createdAt
    delete payload.sync
  } else if (table === 'platform_support_tickets') {
    temporal.domainCreatedAt = platformTimestampIso(payload.createdAt, referenceDate)
    temporal.domainUpdatedAt = platformTimestampIso(payload.updatedAt, referenceDate)
    delete payload.createdAt
    delete payload.updatedAt
    if (Array.isArray(payload.history)) payload.history = payload.history.map((entry) => {
      const at = platformTimestampIso(entry?.at, referenceDate)
      return at ? { ...entry, at } : { ...entry, rawAt: entry?.at ?? null, at: undefined }
    })
  } else if (table === 'platform_integrations') {
    temporal.lastSyncAt = platformTimestampIso(payload.lastSync, referenceDate)
    temporal.rawLastSync = temporal.lastSyncAt ? null : payload.lastSync ?? null
    delete payload.lastSync
  } else if (table === 'platform_actions') {
    temporal.domainCreatedAt = platformTimestampIso(payload.createdAt, referenceDate)
    delete payload.createdAt
  } else if (table === 'platform_audit_events') {
    temporal.eventAt = platformTimestampIso(payload.at, referenceDate)
    temporal.rawEventAt = temporal.eventAt ? null : payload.at ?? null
    delete payload.at
  }
  return { payload, temporal }
}

function restorePlatformItem(table, row) {
  const payload = structuredClone(row.payload ?? {})
  if (table === 'platform_tenants') {
    if (row.domain_created_at) payload.createdAt = platformTimestampFacade(row.domain_created_at)
    payload.sync = row.raw_sync ?? platformTimestampFacade(row.sync_at, 'time') ?? '설정 대기'
  } else if (table === 'platform_support_tickets') {
    if (row.domain_created_at) payload.createdAt = platformTimestampFacade(row.domain_created_at)
    if (row.domain_updated_at) payload.updatedAt = platformTimestampFacade(row.domain_updated_at)
    if (Array.isArray(payload.history)) payload.history = payload.history.map((entry) => ({
      ...entry,
      at: entry.rawAt ?? (entry.at ? platformTimestampFacade(entry.at, 'display') : ''),
      rawAt: undefined,
    }))
  } else if (table === 'platform_integrations') {
    payload.lastSync = row.raw_last_sync ?? platformTimestampFacade(row.last_sync_at, 'time') ?? '—'
  } else if (table === 'platform_actions') {
    if (row.domain_created_at) payload.createdAt = platformTimestampFacade(row.domain_created_at)
  } else if (table === 'platform_audit_events') {
    payload.at = row.raw_event_at ?? platformTimestampFacade(row.event_at, 'display') ?? ''
  }
  return payload
}

function tenantName(snapshot, tenantId) {
  const metadata = snapshot.tenantMetadata?.[tenantId]
  if (metadata?.name) return metadata.name
  return snapshot.platform?.tenants?.find((tenant) => tenant?.id === tenantId)?.name ?? tenantId
}

function tenantIsDemo(snapshot, tenantId) {
  const metadata = snapshot.tenantMetadata?.[tenantId]
  if (typeof metadata?.isDemo === 'boolean') return metadata.isDemo
  const platformTenant = snapshot.platform?.tenants?.find((tenant) => tenant?.id === tenantId)
  return Boolean(platformTenant?.isDemo ?? platformTenant?.is_demo)
}

async function ensureTenant(client, snapshot, tenantId) {
  await client.query(`
    INSERT INTO core_tenants (id, name, is_demo, payload, deleted_at)
    VALUES ($1, $2, $3, $4::jsonb, NULL)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      is_demo = EXCLUDED.is_demo,
      payload = EXCLUDED.payload,
      updated_at = NOW(),
      deleted_at = NULL
  `, [tenantId, tenantName(snapshot, tenantId), tenantIsDemo(snapshot, tenantId), json(snapshot.tenantMetadata?.[tenantId] ?? {})])
}

async function activeIds(client, table, idColumn = 'id', tenantId = null, itemType = null) {
  const result = tenantId
    ? await client.query(`SELECT ${idColumn} AS id FROM ${table} WHERE org_id = $1 AND deleted_at IS NULL${itemType ? ' AND item_type = $2' : ''}`, itemType ? [tenantId, itemType] : [tenantId])
    : await client.query(`SELECT ${idColumn} AS id FROM ${table} WHERE deleted_at IS NULL`)
  return new Set(result.rows.map((row) => row.id))
}

async function softDeleteMissing(client, table, currentIds, { idColumn = 'id', tenantId = null, itemType = null } = {}) {
  const existing = await activeIds(client, table, idColumn, tenantId, itemType)
  for (const id of existing) {
    if (currentIds.has(id)) continue
    if (tenantId) await client.query(`UPDATE ${table} SET deleted_at = NOW(), updated_at = NOW() WHERE org_id = $1 AND ${idColumn} = $2${itemType ? ' AND item_type = $3' : ''}`, itemType ? [tenantId, id, itemType] : [tenantId, id])
    else await client.query(`UPDATE ${table} SET deleted_at = NOW(), updated_at = NOW() WHERE ${idColumn} = $1`, [id])
  }
}

function documentColumns(payload) {
  return {
    storageKey: payload?.storageKey ?? payload?.storage?.key ?? null,
    contentType: payload?.mime ?? payload?.type ?? payload?.contentType ?? null,
    sizeBytes: Number.isSafeInteger(payload?.size)
      ? payload.size
      : Number.isSafeInteger(payload?.sizeBytes) ? payload.sizeBytes : null,
    checksum: payload?.hash ?? payload?.checksum ?? null,
    aiPolicy: ['locked', 'indexed', 'active'].includes(payload?.aiPolicy) ? payload.aiPolicy : 'active',
    versionGroupId: payload?.versionGroupId ?? payload?.id ?? null,
    versionNo: Number.isSafeInteger(payload?.versionNo) && payload.versionNo > 0 ? payload.versionNo : 1,
    summary: typeof payload?.summary === 'string' ? payload.summary : null,
  }
}

const SECRET_ACCOUNT_FIELD = /(password|passphrase|secret|token|credential|authorization|api[-_]?key)/i

function stripSensitivePayload(value) {
  if (Array.isArray(value)) return value.map(stripSensitivePayload)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !SECRET_ACCOUNT_FIELD.test(key))
    .map(([key, child]) => [key, stripSensitivePayload(child)]))
}

function publicAccountPayload(account) {
  if (!account || typeof account !== 'object' || Array.isArray(account)) return {}
  return stripSensitivePayload(account)
}

function publicResetPayload(reset) {
  if (!reset || typeof reset !== 'object' || Array.isArray(reset)) return {}
  const allowed = new Set(['id', 'accountId', 'email'])
  return Object.fromEntries(Object.entries(reset).filter(([key]) => allowed.has(key)))
}

async function upsertWorkspaceRows(client, snapshot, change, options) {
  const { tenantId, key, after } = change
  const table = workspaceTableForKey(key)
  await ensureTenant(client, snapshot, tenantId)

  if (!after) {
    await client.query(`UPDATE workspace_store_meta SET deleted_at = NOW(), updated_at = NOW(), revision = revision + 1 WHERE tenant_id = $1 AND workspace_key = $2`, [tenantId, key])
    await client.query(`UPDATE ${table} SET deleted_at = NOW(), updated_at = NOW() WHERE org_id = $1 AND deleted_at IS NULL${table === 'items' ? " AND item_type = 'company-document'" : ''}`, [tenantId])
    if (table === 'messenger_conversations') await client.query('UPDATE messenger_messages SET deleted_at = NOW(), updated_at = NOW() WHERE org_id = $1 AND deleted_at IS NULL', [tenantId])
    return
  }

  const encoded = encodeWorkspaceRecord(tenantId, key, after)
  await client.query(`
    INSERT INTO workspace_store_meta (tenant_id, workspace_key, data_shape, source_updated_at, updated_by, deleted_at)
    VALUES ($1, $2, $3, $4, $5, NULL)
    ON CONFLICT (tenant_id, workspace_key) DO UPDATE SET
      data_shape = EXCLUDED.data_shape,
      source_updated_at = EXCLUDED.source_updated_at,
      updated_by = EXCLUDED.updated_by,
      revision = workspace_store_meta.revision + 1,
      updated_at = NOW(),
      deleted_at = NULL
  `, [tenantId, key, encoded.shape, isoOrNull(encoded.sourceUpdatedAt), encoded.updatedBy])

  const currentIds = new Set()
  for (const row of encoded.rows) {
    currentIds.add(row.entityId)
    const prepared = prepareTemporalRow(key, row.payload, {
      sourceUpdatedAt: row.sourceUpdatedAt,
      referenceDate: options?.referenceDate,
    })
    const actor = row.updatedBy ?? null
    if (table === 'work_items') {
      const rawDue = options?.rawDueByEntity?.[`${tenantId}:${row.entityId}`]
        ?? prepared.temporal.rawDue
      await client.query(`
        INSERT INTO work_items (org_id, id, payload, position, raw_due, due_at, source_updated_at, updated_by, created_by, deleted_at)
        VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $8, NULL)
        ON CONFLICT (org_id, id) DO UPDATE SET
          payload = EXCLUDED.payload, position = EXCLUDED.position, raw_due = COALESCE(EXCLUDED.raw_due, work_items.raw_due),
          due_at = EXCLUDED.due_at, source_updated_at = EXCLUDED.source_updated_at, updated_by = EXCLUDED.updated_by,
          updated_at = NOW(), deleted_at = NULL
      `, [tenantId, row.entityId, json(prepared.payload), row.position, rawDue, prepared.temporal.dueAt, isoOrNull(row.sourceUpdatedAt), actor])
    } else if (table === 'work_rules') {
      await client.query(`
        INSERT INTO work_rules (org_id, id, payload, position, source_updated_at, updated_by, created_by,
          next_run_at, raw_next_run, last_generated_at, raw_last_generated_at, domain_created_at, deleted_at)
        VALUES ($1, $2, $3::jsonb, $4, $5, $6, $6, $7, $8, $9, $10, $11, NULL)
        ON CONFLICT (org_id, id) DO UPDATE SET payload = EXCLUDED.payload, position = EXCLUDED.position,
          source_updated_at = EXCLUDED.source_updated_at, updated_by = EXCLUDED.updated_by,
          next_run_at = EXCLUDED.next_run_at, raw_next_run = EXCLUDED.raw_next_run,
          last_generated_at = EXCLUDED.last_generated_at, raw_last_generated_at = EXCLUDED.raw_last_generated_at,
          domain_created_at = COALESCE(work_rules.domain_created_at, EXCLUDED.domain_created_at), updated_at = NOW(), deleted_at = NULL
      `, [tenantId, row.entityId, json(prepared.payload), row.position, isoOrNull(row.sourceUpdatedAt), actor,
        prepared.temporal.nextRunAt, prepared.temporal.rawNextRun, prepared.temporal.lastGeneratedAt,
        prepared.temporal.rawLastGeneratedAt, prepared.temporal.domainCreatedAt])
    } else if (table === 'messenger_conversations') {
      const conversationPayload = structuredClone(prepared.payload)
      const messages = Array.isArray(conversationPayload.messages) ? conversationPayload.messages : []
      delete conversationPayload.messages
      await client.query(`
        INSERT INTO messenger_conversations (org_id, id, payload, position, source_updated_at, updated_by, created_by, last_message_at, deleted_at)
        VALUES ($1, $2, $3::jsonb, $4, $5, $6, $6, $7, NULL)
        ON CONFLICT (org_id, id) DO UPDATE SET payload = EXCLUDED.payload, position = EXCLUDED.position,
          source_updated_at = EXCLUDED.source_updated_at, updated_by = EXCLUDED.updated_by,
          last_message_at = EXCLUDED.last_message_at, updated_at = NOW(), deleted_at = NULL
      `, [tenantId, row.entityId, json(conversationPayload), row.position, isoOrNull(row.sourceUpdatedAt), actor,
        prepared.temporal.lastMessageAt])
      const currentMessageIds = new Set()
      for (const [messagePosition, message] of messages.entries()) {
        if (!message?.id) continue
        currentMessageIds.add(message.id)
        const messagePayload = structuredClone(message)
        const createdAt = isoOrNull(messagePayload.createdAt) ?? prepared.temporal.lastMessageAt ?? isoOrNull(row.sourceUpdatedAt) ?? new Date().toISOString()
        delete messagePayload.createdAt
        delete messagePayload.time
        await client.query(`
          INSERT INTO messenger_messages (org_id, id, conversation_id, payload, position, sender_id, created_at, created_by, deleted_at)
          VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $6, NULL)
          ON CONFLICT (org_id, id) DO UPDATE SET conversation_id = EXCLUDED.conversation_id,
            payload = EXCLUDED.payload, position = EXCLUDED.position, sender_id = EXCLUDED.sender_id,
            updated_at = NOW(), deleted_at = NULL
        `, [tenantId, message.id, row.entityId, json(messagePayload), messagePosition, message.senderId ?? null, createdAt])
      }
      const existingMessages = await client.query('SELECT id FROM messenger_messages WHERE org_id = $1 AND conversation_id = $2 AND deleted_at IS NULL', [tenantId, row.entityId])
      for (const message of existingMessages.rows) {
        if (!currentMessageIds.has(message.id)) await client.query('UPDATE messenger_messages SET deleted_at = NOW(), updated_at = NOW() WHERE org_id = $1 AND id = $2', [tenantId, message.id])
      }
    } else if (table === 'calendar_events') {
      await client.query(`
        INSERT INTO calendar_events (org_id, id, payload, position, source_updated_at, updated_by, created_by, starts_at, ends_at, deleted_at)
        VALUES ($1, $2, $3::jsonb, $4, $5, $6, $6, $7, $8, NULL)
        ON CONFLICT (org_id, id) DO UPDATE SET payload = EXCLUDED.payload, position = EXCLUDED.position,
          source_updated_at = EXCLUDED.source_updated_at, updated_by = EXCLUDED.updated_by,
          starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, updated_at = NOW(), deleted_at = NULL
      `, [tenantId, row.entityId, json(prepared.payload), row.position, isoOrNull(row.sourceUpdatedAt), actor,
        prepared.temporal.startsAt, prepared.temporal.endsAt])
    } else if (table === 'daily_journals') {
      await client.query(`
        INSERT INTO daily_journals (org_id, id, payload, position, source_updated_at, updated_by, created_by, entity_updated_at, submitted_at, deleted_at)
        VALUES ($1, $2, $3::jsonb, $4, $5, $6, $6, $7, $8, NULL)
        ON CONFLICT (org_id, id) DO UPDATE SET payload = EXCLUDED.payload, position = EXCLUDED.position,
          source_updated_at = EXCLUDED.source_updated_at, updated_by = EXCLUDED.updated_by,
          entity_updated_at = EXCLUDED.entity_updated_at, submitted_at = COALESCE(EXCLUDED.submitted_at, daily_journals.submitted_at),
          updated_at = NOW(), deleted_at = NULL
      `, [tenantId, row.entityId, json(prepared.payload), row.position, isoOrNull(row.sourceUpdatedAt), actor,
        prepared.temporal.entityUpdatedAt, prepared.temporal.submittedAt])
    } else if (table === 'leave_requests') {
      await client.query(`
        INSERT INTO leave_requests (org_id, id, payload, position, source_updated_at, updated_by, created_by,
          domain_created_at, starts_on, ends_on, raw_period, deleted_at)
        VALUES ($1, $2, $3::jsonb, $4, $5, $6, $6, $7, $8, $9, $10, NULL)
        ON CONFLICT (org_id, id) DO UPDATE SET payload = EXCLUDED.payload, position = EXCLUDED.position,
          source_updated_at = EXCLUDED.source_updated_at, updated_by = EXCLUDED.updated_by,
          domain_created_at = COALESCE(leave_requests.domain_created_at, EXCLUDED.domain_created_at),
          starts_on = EXCLUDED.starts_on, ends_on = EXCLUDED.ends_on, raw_period = EXCLUDED.raw_period,
          updated_at = NOW(), deleted_at = NULL
      `, [tenantId, row.entityId, json(prepared.payload), row.position, isoOrNull(row.sourceUpdatedAt), actor,
        prepared.temporal.domainCreatedAt, prepared.temporal.startsOn, prepared.temporal.endsOn, prepared.temporal.rawPeriod])
    } else if (table === 'items') {
      const columns = documentColumns(prepared.payload)
      await client.query(`
        INSERT INTO items (org_id, id, item_type, payload, position, storage_key, mime, size, hash, ai_policy, version_group_id, version_no, summary, source_updated_at, updated_by, created_by, deleted_at)
        VALUES ($1, $2, 'company-document', $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14, NULL)
        ON CONFLICT (org_id, id) DO UPDATE SET
          payload = EXCLUDED.payload, position = EXCLUDED.position, storage_key = EXCLUDED.storage_key,
          mime = EXCLUDED.mime, size = EXCLUDED.size, hash = EXCLUDED.hash, ai_policy = EXCLUDED.ai_policy,
          version_group_id = EXCLUDED.version_group_id, version_no = EXCLUDED.version_no, summary = EXCLUDED.summary,
          source_updated_at = EXCLUDED.source_updated_at, updated_by = EXCLUDED.updated_by, updated_at = NOW(), deleted_at = NULL
      `, [tenantId, row.entityId, json(prepared.payload), row.position, columns.storageKey, columns.contentType,
        columns.sizeBytes, columns.checksum, columns.aiPolicy, columns.versionGroupId, columns.versionNo,
        columns.summary, isoOrNull(row.sourceUpdatedAt), actor])
    } else if (table === 'proposals') {
      const payload = prepared.payload ?? {}
      await client.query(`
        INSERT INTO proposals (org_id, id, kind, payload, confidence, status, decision_diff, position, source_updated_at, updated_by, created_by, deleted_at)
        VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8, $9, $10, $10, NULL)
        ON CONFLICT (org_id, id) DO UPDATE SET
          kind = EXCLUDED.kind, payload = EXCLUDED.payload, confidence = EXCLUDED.confidence, status = EXCLUDED.status,
          decision_diff = EXCLUDED.decision_diff, position = EXCLUDED.position, source_updated_at = EXCLUDED.source_updated_at,
          updated_by = EXCLUDED.updated_by, updated_at = NOW(), deleted_at = NULL
      `, [tenantId, row.entityId, String(payload.kind ?? 'unknown'), json(payload),
        Number.isFinite(Number(payload.confidence)) ? Number(payload.confidence) : null, String(payload.status ?? 'pending'),
        payload.decisionDiff ? json(payload.decisionDiff) : null, row.position, isoOrNull(row.sourceUpdatedAt), actor])
    } else if (table === 'automation_policies') {
      const payload = prepared.payload ?? {}
      await client.query(`
        INSERT INTO automation_policies (org_id, id, enabled, payload, position, source_updated_at, updated_by, created_by, deleted_at)
        VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $7, NULL)
        ON CONFLICT (org_id, id) DO UPDATE SET
          enabled = EXCLUDED.enabled, payload = EXCLUDED.payload, position = EXCLUDED.position,
          source_updated_at = EXCLUDED.source_updated_at, updated_by = EXCLUDED.updated_by, updated_at = NOW(), deleted_at = NULL
      `, [tenantId, row.entityId, payload.autoApprove === true, json(payload), row.position, isoOrNull(row.sourceUpdatedAt), actor])
    } else {
      await client.query(`
        INSERT INTO ${table} (org_id, id, payload, position, source_updated_at, updated_by, created_by, deleted_at)
        VALUES ($1, $2, $3::jsonb, $4, $5, $6, $6, NULL)
        ON CONFLICT (org_id, id) DO UPDATE SET
          payload = EXCLUDED.payload, position = EXCLUDED.position, source_updated_at = EXCLUDED.source_updated_at,
          updated_by = EXCLUDED.updated_by, updated_at = NOW(), deleted_at = NULL
      `, [tenantId, row.entityId, json(prepared.payload), row.position, isoOrNull(row.sourceUpdatedAt), actor])
    }
  }
  await softDeleteMissing(client, table, currentIds, { tenantId, itemType: table === 'items' ? 'company-document' : null })
  if (table === 'messenger_conversations') {
    const inactive = await client.query('SELECT id FROM messenger_conversations WHERE org_id = $1 AND deleted_at IS NOT NULL', [tenantId])
    for (const conversation of inactive.rows) {
      await client.query('UPDATE messenger_messages SET deleted_at = NOW(), updated_at = NOW() WHERE org_id = $1 AND conversation_id = $2 AND deleted_at IS NULL', [tenantId, conversation.id])
    }
  }
}

async function insertOutbox(client, outboxEvent) {
  await client.query(`
    INSERT INTO events (id, org_id, event_type, aggregate_type, aggregate_id, actor, payload)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
  `, [outboxEvent.id, outboxEvent.tenantId, outboxEvent.eventType, outboxEvent.aggregateType, outboxEvent.aggregateId, outboxEvent.actor, json(outboxEvent.payload)])
}

async function syncPlatformCollection(client, table, items, options = {}) {
  const currentIds = new Set()
  for (const [position, item] of items.entries()) {
    if (!item?.id) continue
    currentIds.add(item.id)
    const tenantId = table === 'platform_tenants' ? null : item.tenantId ?? null
    const prepared = preparePlatformItem(table, item, options.referenceDate)
    if (table === 'platform_tenants') {
      await client.query(`
        INSERT INTO platform_tenants (id, payload, position, domain_created_at, sync_at, raw_sync, deleted_at)
        VALUES ($1, $2::jsonb, $3, $4, $5, $6, NULL)
        ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, position = EXCLUDED.position,
          domain_created_at = COALESCE(platform_tenants.domain_created_at, EXCLUDED.domain_created_at),
          sync_at = EXCLUDED.sync_at, raw_sync = EXCLUDED.raw_sync, updated_at = NOW(), deleted_at = NULL
      `, [item.id, json(prepared.payload), position, prepared.temporal.domainCreatedAt, prepared.temporal.syncAt, prepared.temporal.rawSync])
    } else if (table === 'platform_support_tickets') {
      await client.query(`
        INSERT INTO platform_support_tickets (id, tenant_id, payload, position, domain_created_at, domain_updated_at, deleted_at)
        VALUES ($1, $2, $3::jsonb, $4, $5, $6, NULL)
        ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, payload = EXCLUDED.payload, position = EXCLUDED.position,
          domain_created_at = COALESCE(platform_support_tickets.domain_created_at, EXCLUDED.domain_created_at),
          domain_updated_at = EXCLUDED.domain_updated_at, updated_at = NOW(), deleted_at = NULL
      `, [item.id, tenantId, json(prepared.payload), position, prepared.temporal.domainCreatedAt, prepared.temporal.domainUpdatedAt])
    } else if (table === 'platform_integrations') {
      await client.query(`
        INSERT INTO platform_integrations (id, tenant_id, payload, position, last_sync_at, raw_last_sync, deleted_at)
        VALUES ($1, $2, $3::jsonb, $4, $5, $6, NULL)
        ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, payload = EXCLUDED.payload, position = EXCLUDED.position,
          last_sync_at = EXCLUDED.last_sync_at, raw_last_sync = EXCLUDED.raw_last_sync, updated_at = NOW(), deleted_at = NULL
      `, [item.id, tenantId, json(prepared.payload), position, prepared.temporal.lastSyncAt, prepared.temporal.rawLastSync])
    } else if (table === 'platform_actions') {
      await client.query(`
        INSERT INTO platform_actions (id, tenant_id, payload, position, domain_created_at, deleted_at)
        VALUES ($1, $2, $3::jsonb, $4, $5, NULL)
        ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, payload = EXCLUDED.payload, position = EXCLUDED.position,
          domain_created_at = COALESCE(platform_actions.domain_created_at, EXCLUDED.domain_created_at), updated_at = NOW(), deleted_at = NULL
      `, [item.id, tenantId, json(prepared.payload), position, prepared.temporal.domainCreatedAt])
    } else if (table === 'platform_audit_events') {
      await client.query(`
        INSERT INTO platform_audit_events (id, tenant_id, payload, position, event_at, raw_event_at, deleted_at)
        VALUES ($1, $2, $3::jsonb, $4, $5, $6, NULL)
        ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, payload = EXCLUDED.payload, position = EXCLUDED.position,
          event_at = EXCLUDED.event_at, raw_event_at = EXCLUDED.raw_event_at, updated_at = NOW(), deleted_at = NULL
      `, [item.id, tenantId, json(prepared.payload), position, prepared.temporal.eventAt, prepared.temporal.rawEventAt])
    } else {
      await client.query(`
        INSERT INTO ${table} (id, tenant_id, payload, position, deleted_at) VALUES ($1, $2, $3::jsonb, $4, NULL)
        ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, payload = EXCLUDED.payload, position = EXCLUDED.position, updated_at = NOW(), deleted_at = NULL
      `, [item.id, tenantId, json(prepared.payload), position])
    }
  }
  await softDeleteMissing(client, table, currentIds, { idColumn: 'id' })
}

function accountRecords(snapshot) {
  const records = new Map()
  for (const account of snapshot.accounts ?? []) if (account?.id) records.set(account.id, account)
  for (const invited of snapshot.invitedAccounts ?? []) if (invited?.id) records.set(invited.id, { role: 'tenant-member', approvalStatus: 'pending', ...invited })
  for (const tenant of snapshot.platform?.tenants ?? []) {
    if (tenant?.adminAccount?.id) records.set(tenant.adminAccount.id, {
      role: 'tenant-admin', approvalStatus: 'approved', tenantId: tenant.id, tenantName: tenant.name, ...tenant.adminAccount,
    })
  }
  return records
}

async function ensureAccount(client, snapshot, accountId, fallback = {}) {
  const account = accountRecords(snapshot).get(accountId) ?? fallback
  const tenantId = account.tenantId ?? null
  if (tenantId) await ensureTenant(client, snapshot, tenantId)
  const email = account.email || `${accountId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}@unknown.invalid`
  await client.query(`
    INSERT INTO core_accounts (id, tenant_id, email, name, role, team, job_role, approval_status, payload, deleted_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NULL)
    ON CONFLICT (id) DO UPDATE SET
      tenant_id = EXCLUDED.tenant_id, email = EXCLUDED.email, name = EXCLUDED.name, role = EXCLUDED.role,
      team = EXCLUDED.team, job_role = EXCLUDED.job_role, approval_status = EXCLUDED.approval_status,
      payload = EXCLUDED.payload, updated_at = NOW(), deleted_at = NULL
  `, [accountId, tenantId, email, account.name || accountId, account.role || 'tenant-member', account.team ?? null, account.jobRole ?? null, account.approvalStatus || 'pending', json(publicAccountPayload(account))])
}

async function syncAccounts(client, snapshot) {
  const records = accountRecords(snapshot)
  for (const [accountId, account] of records) await ensureAccount(client, snapshot, accountId, account)
  const currentIds = new Set(records.keys())
  if (currentIds.size > 0) await softDeleteMissing(client, 'core_accounts', currentIds, { idColumn: 'id' })

  for (const [accountId, decision] of Object.entries(snapshot.accountApprovals ?? {})) {
    await ensureAccount(client, snapshot, accountId)
    await client.query(`INSERT INTO account_approvals (account_id, decision, decided_at) VALUES ($1, $2, NOW()) ON CONFLICT (account_id) DO UPDATE SET decision = EXCLUDED.decision, decided_at = NOW()`, [accountId, decision])
  }
  const approvalIds = Object.keys(snapshot.accountApprovals ?? {})
  await client.query('DELETE FROM account_approvals WHERE NOT (account_id = ANY($1::text[]))', [approvalIds])

  for (const [accountId, credential] of Object.entries(snapshot.accountCredentials ?? {})) {
    await ensureAccount(client, snapshot, accountId)
    await client.query(`
      INSERT INTO account_credentials (account_id, password_hash, must_change_password, temporary_password_expires_at, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (account_id) DO UPDATE SET password_hash = EXCLUDED.password_hash,
        must_change_password = EXCLUDED.must_change_password, temporary_password_expires_at = EXCLUDED.temporary_password_expires_at, updated_at = NOW()
    `, [accountId, credential.passwordHash, Boolean(credential.mustChangePassword), isoOrNull(credential.temporaryPasswordExpiresAt)])
  }
  const credentialIds = Object.keys(snapshot.accountCredentials ?? {})
  await client.query('DELETE FROM account_credentials WHERE NOT (account_id = ANY($1::text[]))', [credentialIds])

  const inviteIds = new Set()
  for (const invite of snapshot.invitedAccounts ?? []) {
    if (!invite?.id || !invite?.tenantId || !invite?.email) continue
    inviteIds.add(invite.id)
    await ensureAccount(client, snapshot, invite.id, invite)
    await client.query(`
      INSERT INTO account_invites (id, tenant_id, email, payload, deleted_at) VALUES ($1, $2, $3, $4::jsonb, NULL)
      ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, email = EXCLUDED.email, payload = EXCLUDED.payload, updated_at = NOW(), deleted_at = NULL
    `, [invite.id, invite.tenantId, invite.email, json(publicAccountPayload(invite))])
  }
  await softDeleteMissing(client, 'account_invites', inviteIds, { idColumn: 'id' })

  const resetIds = new Set()
  for (const reset of snapshot.passwordResetRequests ?? []) {
    if (!reset?.id || !reset?.accountId) continue
    resetIds.add(reset.id)
    await ensureAccount(client, snapshot, reset.accountId)
    await client.query(`
      INSERT INTO password_reset_requests (id, account_id, email, token_hash, status, payload, expires_at, used_at, revoked_at, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, NOW())
      ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, payload = EXCLUDED.payload,
        used_at = EXCLUDED.used_at, revoked_at = EXCLUDED.revoked_at, updated_at = NOW()
    `, [reset.id, reset.accountId, reset.email, reset.tokenHash, reset.status, json(publicResetPayload(reset)), isoOrNull(reset.expiresAt), isoOrNull(reset.usedAt), isoOrNull(reset.revokedAt), isoOrNull(reset.createdAt)])
  }
  const existingResets = await client.query('SELECT id FROM password_reset_requests')
  for (const row of existingResets.rows) if (!resetIds.has(row.id)) await client.query('DELETE FROM password_reset_requests WHERE id = $1', [row.id])

  await syncGuestGrants(client, snapshot)
}

function guestGrantRows(snapshot) {
  return (snapshot.guestGrants ?? []).filter((grant) => grant?.id && grant?.tenantId && grant?.accountId)
}

// 게스트 grant: payload가 진실이고 컬럼은 인덱스·RLS용 사본이다. 단 stripSensitivePayload가
// /token/에 걸리는 tokenHash·tokenIssuedAt·tokenExpiresAt을 지우므로 셋은 컬럼에만 두고
// load 때 되돌린다(password_reset_requests와 같은 방식).
async function syncGuestGrants(client, snapshot) {
  const grants = guestGrantRows(snapshot)
  const currentIds = new Set(grants.map((grant) => grant.id))
  // account_id 부분 유니크 인덱스(살아 있는 grant는 계정당 하나) 때문에, 사라진 grant를 먼저
  // 정리해야 같은 계정의 새 grant를 넣을 때 충돌하지 않는다.
  await softDeleteMissing(client, 'guest_grants', currentIds, { idColumn: 'id' })
  for (const grant of grants) {
    await ensureTenant(client, snapshot, grant.tenantId)
    await ensureAccount(client, snapshot, grant.accountId)
    const projectIds = (Array.isArray(grant.projectIds) ? grant.projectIds : []).filter((id) => typeof id === 'string' && id.trim())
    await client.query(`
      INSERT INTO guest_grants (id, tenant_id, account_id, email, status, project_ids, token_hash, token_issued_at, token_expires_at,
        access_expires_at, invited_by, payload, created_at, updated_at, deleted_at)
      VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9, $10, $11, $12::jsonb, COALESCE($13::timestamptz, NOW()), NOW(), NULL)
      ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, account_id = EXCLUDED.account_id, email = EXCLUDED.email,
        status = EXCLUDED.status, project_ids = EXCLUDED.project_ids, token_hash = EXCLUDED.token_hash,
        token_issued_at = EXCLUDED.token_issued_at, token_expires_at = EXCLUDED.token_expires_at,
        access_expires_at = EXCLUDED.access_expires_at, invited_by = EXCLUDED.invited_by, payload = EXCLUDED.payload,
        updated_at = NOW(), deleted_at = NULL
    `, [grant.id, grant.tenantId, grant.accountId, grant.email ?? '', String(grant.status ?? 'invited'), projectIds,
      grant.tokenHash ?? null, isoOrNull(grant.tokenIssuedAt), isoOrNull(grant.tokenExpiresAt), isoOrNull(grant.accessExpiresAt),
      grant.invitedById ?? null, json(stripSensitivePayload(grant)), isoOrNull(grant.createdAt)])
  }
}

async function loadGuestGrants(client, snapshot) {
  const grants = await client.query(`
    SELECT payload, token_hash, token_issued_at, token_expires_at
    FROM guest_grants WHERE deleted_at IS NULL ORDER BY created_at, id
  `)
  snapshot.guestGrants = grants.rows.map((row) => ({
    ...row.payload,
    tokenHash: row.token_hash ?? null,
    tokenIssuedAt: row.token_issued_at ? new Date(row.token_issued_at).toISOString() : null,
    tokenExpiresAt: row.token_expires_at ? new Date(row.token_expires_at).toISOString() : null,
  }))
}

async function loadPlatform(client, snapshot) {
  for (const [collection, table] of Object.entries(platformCollections)) {
    const result = await client.query(`SELECT * FROM ${table} WHERE deleted_at IS NULL ORDER BY position, id`)
    snapshot.platform[collection] = result.rows.map((row) => restorePlatformItem(table, row))
  }
}

async function loadAccounts(client, snapshot) {
  const accounts = await client.query('SELECT payload FROM core_accounts WHERE deleted_at IS NULL ORDER BY created_at, id')
  snapshot.accounts = accounts.rows.map((row) => row.payload)

  const approvals = await client.query('SELECT account_id, decision FROM account_approvals')
  snapshot.accountApprovals = Object.fromEntries(approvals.rows.map((row) => [row.account_id, row.decision]))

  const credentials = await client.query('SELECT account_id, password_hash, must_change_password, temporary_password_expires_at FROM account_credentials')
  snapshot.accountCredentials = Object.fromEntries(credentials.rows.map((row) => [row.account_id, {
    passwordHash: row.password_hash,
    mustChangePassword: row.must_change_password,
    temporaryPasswordExpiresAt: row.temporary_password_expires_at ? new Date(row.temporary_password_expires_at).toISOString() : null,
  }]))

  const invites = await client.query('SELECT payload FROM account_invites WHERE deleted_at IS NULL ORDER BY created_at, id')
  snapshot.invitedAccounts = invites.rows.map((row) => row.payload)

  const resets = await client.query(`
    SELECT payload, token_hash, status, expires_at, used_at, revoked_at, created_at
    FROM password_reset_requests ORDER BY created_at DESC, id
  `)
  snapshot.passwordResetRequests = resets.rows.map((row) => ({
    ...row.payload,
    tokenHash: row.token_hash,
    status: row.status,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    usedAt: row.used_at ? new Date(row.used_at).toISOString() : undefined,
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : undefined,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : row.payload?.createdAt,
  }))

  await loadGuestGrants(client, snapshot)
}

async function loadWorkspace(client, snapshot) {
  const tenants = await client.query('SELECT id, name, is_demo, payload FROM core_tenants WHERE deleted_at IS NULL ORDER BY id')
  snapshot.tenantMetadata = {}
  for (const tenant of tenants.rows) {
    snapshot.tenants[tenant.id] ??= {}
    snapshot.tenantMetadata[tenant.id] = { ...(tenant.payload ?? {}), name: tenant.name, isDemo: tenant.is_demo }
  }

  const metas = await client.query('SELECT * FROM workspace_store_meta WHERE deleted_at IS NULL ORDER BY tenant_id, workspace_key')
  const allowed = new Set([...WORKSPACE_KEYS, COMPANY_DOCUMENTS_KEY])
  for (const meta of metas.rows) {
    if (!allowed.has(meta.workspace_key)) throw new Error(`UNKNOWN_WORKSPACE_KEY: ${meta.workspace_key}`)
    const table = workspaceTableForKey(meta.workspace_key)
    const rows = await client.query(`SELECT *, id AS entity_id FROM ${table} WHERE org_id = $1${table === 'items' ? " AND item_type = 'company-document'" : ''} ORDER BY position, id`, [meta.tenant_id])
    if (table === 'messenger_conversations') {
      const messages = await client.query(`
        SELECT conversation_id, payload, created_at
        FROM messenger_messages
        WHERE org_id = $1 AND deleted_at IS NULL
        ORDER BY conversation_id, position, id
      `, [meta.tenant_id])
      const byConversation = new Map()
      for (const message of messages.rows) {
        const list = byConversation.get(message.conversation_id) ?? []
        list.push({ ...message.payload, createdAt: new Date(message.created_at).toISOString() })
        byConversation.set(message.conversation_id, list)
      }
      for (const row of rows.rows) row.payload = { ...row.payload, messages: byConversation.get(row.id) ?? [] }
    }
    const record = decodeWorkspaceRecord(meta, rows.rows, meta.workspace_key)
    if (record) {
      snapshot.tenants[meta.tenant_id] ??= {}
      snapshot.tenants[meta.tenant_id][meta.workspace_key] = record
    }
  }
}

export class PostgresStoreAdapter {
  constructor({ databaseUrl, pool, schemaPath = schemaFile, autoMigrate = false, logger = console, serviceContextApplier = applyPostgresServiceContext } = {}) {
    this.kind = 'postgres'
    this.readOnly = false
    this.logger = logger
    this.schemaPath = schemaPath
    this.autoMigrate = autoMigrate
    this.pool = pool ?? new Pool({ connectionString: databaseUrl, max: 10, idleTimeoutMillis: 30_000 })
    this.serviceContextApplier = serviceContextApplier
    this.ownsPool = !pool
    this.snapshot = emptyWorkspaceStore()
    this.commitTail = Promise.resolve()
  }

  async connect() {
    if (this.autoMigrate) {
      const sql = await readFile(this.schemaPath, 'utf8')
      await applyStoreSchema(this.pool, sql)
    }
    await this.pool.query('SELECT 1 AS ready')
    return this
  }

  async applySchema() {
    const sql = await readFile(this.schemaPath, 'utf8')
    await applyStoreSchema(this.pool, sql)
  }

  async loadSnapshot() {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await this.serviceContextApplier(client)
      const snapshot = emptyWorkspaceStore()
      await loadWorkspace(client, snapshot)
      await loadPlatform(client, snapshot)
      await loadAccounts(client, snapshot)
      assertKnownWorkspaceKeys(snapshot)
      await client.query('COMMIT')
      this.snapshot = clone(snapshot)
      return snapshot
    } catch (error) {
      try { await client.query('ROLLBACK') } catch { /* retain original failure */ }
      throw error
    } finally {
      client.release()
    }
  }

  commitSnapshot(nextSnapshot, options = {}) {
    const immutableNext = clone(nextSnapshot)
    assertKnownWorkspaceKeys(immutableNext)
    const operation = this.commitTail.then(() => this.#commitTransaction(immutableNext, options))
    this.commitTail = operation.catch(() => {})
    return operation
  }

  async #commitTransaction(nextSnapshot, options) {
    const previousSnapshot = this.snapshot
    const changes = diffWorkspaceRecords(previousSnapshot, nextSnapshot)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await this.serviceContextApplier(client)
      const tenantIds = new Set([
        ...Object.keys(nextSnapshot.tenants ?? {}),
        ...(nextSnapshot.platform?.tenants ?? []).map((tenant) => tenant?.id).filter(Boolean),
        ...Object.keys(nextSnapshot.tenantMetadata ?? {}),
      ])
      for (const tenantId of tenantIds) await ensureTenant(client, nextSnapshot, tenantId)

      for (const change of changes) {
        await upsertWorkspaceRows(client, nextSnapshot, change, options)
        for (const outboxEvent of deriveOutboxEvents(change)) await insertOutbox(client, outboxEvent)
      }

      for (const [collection, table] of Object.entries(platformCollections)) {
        await syncPlatformCollection(client, table, nextSnapshot.platform?.[collection] ?? [], options)
      }
      await syncAccounts(client, nextSnapshot)
      if (typeof options.verify === 'function') await options.verify(client, nextSnapshot)
      await client.query('COMMIT')
      this.snapshot = clone(nextSnapshot)
    } catch (error) {
      try { await client.query('ROLLBACK') } catch { /* retain original failure */ }
      throw error
    } finally {
      client.release()
    }
  }

  async createSessionMap() {
    const result = await this.pool.query(`
      SELECT token_hash, account_id, expires_at
      FROM auth_sessions
      WHERE revoked_at IS NULL AND expires_at > NOW()
    `)
    const entries = result.rows.map((row) => [row.token_hash, {
      accountId: row.account_id,
      expiresAt: new Date(row.expires_at).getTime(),
    }])
    return new PersistentSessionMap(entries, {
      onSet: (tokenHash, session) => this.#persistSession(tokenHash, session),
      onDelete: (tokenHash) => this.#revokeSession(tokenHash),
    })
  }

  async #persistSession(tokenHash, session) {
    await this.pool.query(`
      INSERT INTO auth_sessions (token_hash, account_id, expires_at, revoked_at)
      VALUES ($1, $2, $3, NULL)
      ON CONFLICT (token_hash) DO UPDATE SET account_id = EXCLUDED.account_id,
        expires_at = EXCLUDED.expires_at, updated_at = NOW(), revoked_at = NULL
    `, [tokenHash, session.accountId, new Date(session.expiresAt).toISOString()])
  }

  async #revokeSession(tokenHash) {
    await this.pool.query('UPDATE auth_sessions SET revoked_at = NOW(), updated_at = NOW() WHERE token_hash = $1', [tokenHash])
  }

  // 게스트 GET 라우트의 2차 방어. 앱이 메모리 필터로 고른 id(candidateIds)를 게스트 컨텍스트로
  // 한 번 더 SELECT해 RLS가 허락한 것만 돌려준다 — 앱 필터가 실수해도 DB가 한 번 더 자른다.
  // 반환은 candidateIds 순서를 유지한 부분집합이다. DB 오류는 그대로 던진다(조용히 전부 보여주지 않는다).
  async guestVisibleIds({ table, tenantId, accountId, projectIds, candidateIds } = {}) {
    const target = resolveGuestScopeTable(table)
    const candidates = [...new Set((Array.isArray(candidateIds) ? candidateIds : []).filter((id) => typeof id === 'string' && id))]
    if (candidates.length === 0) return []
    const orgId = requireIdentifier(tenantId, 'tenantId')
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await applyPostgresGuestContext(client, { tenantId: orgId, accountId, projectIds })
      const visible = new Set()
      // pg-mem이 `id = ANY($n::text[])`를 잘못 평가하므로 IN (…) 자리표시자로 쓴다. 실 Postgres에서도 같은 뜻이다.
      for (const chunk of chunked(candidates, 500)) {
        const fixed = target.itemType ? [orgId, target.itemType] : [orgId]
        const placeholders = chunk.map((_, index) => `$${fixed.length + index + 1}`).join(', ')
        const result = await client.query(
          `SELECT id FROM ${target.table} WHERE org_id = $1 AND deleted_at IS NULL${target.itemType ? ' AND item_type = $2' : ''} AND id IN (${placeholders})`,
          [...fixed, ...chunk],
        )
        for (const row of result.rows) visible.add(row.id)
      }
      await client.query('COMMIT')
      return candidates.filter((id) => visible.has(id))
    } catch (error) {
      try { await client.query('ROLLBACK') } catch { /* retain original failure */ }
      throw error
    } finally {
      client.release()
    }
  }

  async flush() { await this.commitTail }

  async close() {
    await this.flush()
    if (this.ownsPool) await this.pool.end()
  }
}

export { schemaFile as defaultPostgresSchemaFile }

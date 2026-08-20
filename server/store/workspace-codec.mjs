import { createHash, randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import {
  COMPANY_DOCUMENTS_KEY,
  WORKSPACE_KEY_SET,
  WORKSPACE_SHAPES,
  WORKSPACE_TABLES,
} from './constants.mjs'
import { StoreVerificationError, UnknownWorkspaceKeyError } from './errors.mjs'
import { restoreTemporalRow } from './temporal-codec.mjs'

const clone = (value) => value === undefined ? undefined : structuredClone(value)

export function assertKnownWorkspaceKeys(store) {
  if (!store || typeof store !== 'object' || Array.isArray(store)) {
    throw new StoreVerificationError('workspace store 최상위 형식이 올바르지 않습니다.')
  }
  if (!store.tenants || typeof store.tenants !== 'object' || Array.isArray(store.tenants)) {
    throw new StoreVerificationError('workspace store의 tenants 형식이 올바르지 않습니다.')
  }
  for (const [tenantId, tenantStore] of Object.entries(store.tenants)) {
    if (!tenantStore || typeof tenantStore !== 'object' || Array.isArray(tenantStore)) {
      throw new StoreVerificationError(`tenant store 형식이 올바르지 않습니다: ${tenantId}`)
    }
    for (const key of Object.keys(tenantStore)) {
      if (!WORKSPACE_KEY_SET.has(key) && key !== COMPANY_DOCUMENTS_KEY) {
        throw new UnknownWorkspaceKeyError(key, tenantId)
      }
    }
  }
  return true
}

function hashValue(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)
}

function entityId(item, position, key) {
  if (item && typeof item === 'object' && !Array.isArray(item) && typeof item.id === 'string' && item.id.trim()) {
    return item.id.trim()
  }
  return `${key}:${position}:${hashValue(item)}`
}

function normalizeRecord(record, tenantId, key) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || !Object.prototype.hasOwnProperty.call(record, 'data')) {
    throw new StoreVerificationError(`workspace record 형식이 올바르지 않습니다: ${tenantId}/${key}`)
  }
  return record
}

export function encodeWorkspaceRecord(tenantId, key, record) {
  if (!WORKSPACE_KEY_SET.has(key) && key !== COMPANY_DOCUMENTS_KEY) throw new UnknownWorkspaceKeyError(key, tenantId)
  const source = normalizeRecord(record, tenantId, key)
  const data = source.data
  const sourceUpdatedAt = typeof source.updatedAt === 'string' && source.updatedAt ? source.updatedAt : null
  const updatedBy = typeof source.updatedBy === 'string' && source.updatedBy ? source.updatedBy : null

  if (data === null || data === undefined) {
    return { shape: 'null', sourceUpdatedAt, updatedBy, rows: [] }
  }

  if (key === COMPANY_DOCUMENTS_KEY || Array.isArray(data)) {
    if (!Array.isArray(data)) throw new StoreVerificationError(`${tenantId}/${key} 데이터는 배열이어야 합니다.`)
    const ids = new Set()
    const rows = data.map((payload, position) => {
      const id = entityId(payload, position, key)
      if (ids.has(id)) throw new StoreVerificationError(`${tenantId}/${key}에 중복 entity id가 있습니다: ${id}`)
      ids.add(id)
      return { entityId: id, payload: clone(payload), position, sourceUpdatedAt, updatedBy }
    })
    return { shape: 'array', sourceUpdatedAt, updatedBy, rows }
  }

  if (WORKSPACE_SHAPES[key] === 'object-map') {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new StoreVerificationError(`${tenantId}/${key} 데이터는 객체 map이어야 합니다.`)
    }
    return {
      shape: 'object-map',
      sourceUpdatedAt,
      updatedBy,
      rows: Object.entries(data).map(([entityId, payload], position) => ({
        entityId,
        payload: clone(payload),
        position,
        sourceUpdatedAt,
        updatedBy,
      })),
    }
  }

  if (WORKSPACE_SHAPES[key] === 'singleton') {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new StoreVerificationError(`${tenantId}/${key} 데이터는 singleton 객체여야 합니다.`)
    }
    return {
      shape: 'singleton',
      sourceUpdatedAt,
      updatedBy,
      rows: [{ entityId: '__singleton__', payload: clone(data), position: 0, sourceUpdatedAt, updatedBy }],
    }
  }

  throw new StoreVerificationError(`${tenantId}/${key} 데이터 형식을 판별할 수 없습니다.`)
}

export function decodeWorkspaceRecord(meta, rows, key = meta?.workspace_key) {
  if (!meta || meta.deleted_at) return null
  const activeRows = rows
    .filter((row) => !row.deleted_at)
    .sort((left, right) => Number(left.position) - Number(right.position))
  let data
  if (meta.data_shape === 'null') data = null
  else if (meta.data_shape === 'array') data = activeRows.map((row) => restoreTemporalRow(key, row.payload, row))
  else if (meta.data_shape === 'object-map') data = Object.fromEntries(activeRows.map((row) => [row.entity_id, restoreTemporalRow(key, row.payload, row)]))
  else if (meta.data_shape === 'singleton') data = activeRows[0] ? restoreTemporalRow(key, activeRows[0].payload, activeRows[0]) : {}
  else throw new StoreVerificationError(`알 수 없는 workspace data_shape입니다: ${meta.data_shape}`)

  return {
    data,
    updatedAt: meta.source_updated_at ? new Date(meta.source_updated_at).toISOString() : null,
    ...(meta.updated_by ? { updatedBy: meta.updated_by } : {}),
  }
}

export function diffWorkspaceRecords(previousStore, nextStore) {
  assertKnownWorkspaceKeys(previousStore)
  assertKnownWorkspaceKeys(nextStore)
  const changes = []
  const tenantIds = new Set([...Object.keys(previousStore.tenants), ...Object.keys(nextStore.tenants)])
  for (const tenantId of tenantIds) {
    const previousTenant = previousStore.tenants[tenantId] ?? {}
    const nextTenant = nextStore.tenants[tenantId] ?? {}
    const keys = new Set([...Object.keys(previousTenant), ...Object.keys(nextTenant)])
    for (const key of keys) {
      const before = previousTenant[key] ?? null
      const after = nextTenant[key] ?? null
      if (!isDeepStrictEqual(before, after)) changes.push({ tenantId, key, before: clone(before), after: clone(after) })
    }
  }
  return changes
}

function arrayEntities(record) {
  if (!record || !Array.isArray(record.data)) return new Map()
  return new Map(record.data.map((item, position) => [entityId(item, position, 'event'), item]))
}

function safeActor(record, entity) {
  const candidates = [
    record?.updatedBy,
    entity?.updatedBy,
    entity?.review?.reviewerId,
    entity?.completion?.submittedById,
    entity?.decidedById,
    entity?.requesterId,
    entity?.authorId,
  ]
  return candidates.find((candidate) => typeof candidate === 'string' && candidate) ?? 'system'
}

function event(eventType, tenantId, key, entityIdValue, actor, beforeState, afterState) {
  return {
    id: `EVT-${Date.now()}-${randomBytes(6).toString('hex')}`,
    tenantId,
    eventType,
    aggregateType: key,
    aggregateId: entityIdValue,
    actor,
    payload: {
      entityId: entityIdValue,
      ...(beforeState !== undefined ? { beforeState } : {}),
      ...(afterState !== undefined ? { afterState } : {}),
      actor,
    },
  }
}

export function deriveOutboxEvents(change) {
  const { tenantId, key, before, after } = change
  const beforeEntities = arrayEntities(before)
  const afterEntities = arrayEntities(after)
  const events = []

  if (key === 'work-items') {
    for (const [id, item] of afterEntities) {
      const previous = beforeEntities.get(id)
      if (!previous) events.push(event('work.created', tenantId, key, id, safeActor(after, item), undefined, item.status))
      else if (previous.status !== item.status) events.push(event('work.transitioned', tenantId, key, id, safeActor(after, item), previous.status, item.status))
    }
  } else if (key === 'daily-journals') {
    for (const [id, journal] of afterEntities) {
      const previous = beforeEntities.get(id)
      if (journal.status === '결재요청' && previous?.status !== '결재요청') {
        events.push(event('journal.submitted', tenantId, key, id, safeActor(after, journal), previous?.status, journal.status))
      }
      if ((journal.reviews?.length ?? 0) > (previous?.reviews?.length ?? 0)) {
        events.push(event('journal.reviewed', tenantId, key, id, safeActor(after, journal), previous?.status, journal.status))
      }
    }
  } else if (key === 'leave-requests') {
    for (const [id, leave] of afterEntities) {
      const previous = beforeEntities.get(id)
      if (previous && previous.status !== leave.status && ['승인', '반려'].includes(leave.status)) {
        events.push(event('leave.decided', tenantId, key, id, safeActor(after, leave), previous.status, leave.status))
      }
    }
  } else if (key === 'messenger-conversations') {
    for (const [id, conversation] of afterEntities) {
      const previous = beforeEntities.get(id)
      const previousMessageIds = new Set((previous?.messages ?? []).map((message) => message.id))
      for (const message of conversation.messages ?? []) {
        if (previousMessageIds.has(message.id)) continue
        events.push(event('messenger.message_created', tenantId, key, message.id, message.senderId || safeActor(after, conversation), undefined, 'created'))
      }
    }
  } else if (key === COMPANY_DOCUMENTS_KEY) {
    for (const [id, document] of afterEntities) {
      if (!beforeEntities.has(id)) events.push(event('document.uploaded', tenantId, key, id, safeActor(after, document), undefined, 'available'))
    }
    for (const [id, document] of beforeEntities) {
      if (!afterEntities.has(id)) events.push(event('document.deleted', tenantId, key, id, safeActor(after, document), 'available', 'deleted'))
    }
  }

  if (events.length === 0) {
    events.push(event('workspace.changed', tenantId, key, `${tenantId}:${key}`, safeActor(after ?? before, null), before ? 'present' : 'absent', after ? 'present' : 'absent'))
  }
  return events
}

export function workspaceTableForKey(key) {
  if (key === COMPANY_DOCUMENTS_KEY) return 'items'
  const table = WORKSPACE_TABLES[key]
  if (!table) throw new UnknownWorkspaceKeyError(key)
  return table
}

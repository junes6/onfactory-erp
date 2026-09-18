import { isDeepStrictEqual } from 'node:util'

import { ArchiveError } from './archive.mjs'
import { WORK_ITEMS_FULL, prependWithinCap } from './work-item-tree.mjs'

/**
 * 끝난 업무의 보관함 — 진행 중 목록에 자리를 만드는 유일한 길이다.
 *
 * 진행 중 업무는 상한(1,000건)에서 **지우지 않고 거절한다**(work-item-tree.mjs). 자리는 여기서 만든다:
 * 결재완료된 업무를 파일 저장소의 보관 세그먼트로 먼저 쓰고, 쓰기가 성공한 뒤에만 목록에서 뺀다.
 * 매일 새벽 60일 지난 완료 업무를 옮기고, 관리자는 업무 화면의 [보관함]에서 지금 바로 옮기거나 하나씩 꺼낼 수 있다.
 */

export const WORK_ARCHIVE_COLLECTION = 'work-items'
/** 매일 옮기는 기준(완료 후 경과일). */
export const WORK_ARCHIVE_AFTER_DAYS = 60
/** 목록이 이만큼 차면 7일 지난 완료 업무까지 앞당겨 옮긴다. 상한에 닿기 전에 자리를 만든다. */
export const WORK_ARCHIVE_PRESSURE = 800

/** 업무가 끝난 시각 — 마지막 승인 시각, 없으면 완료 보고 시각, 그것도 없으면 마감. */
export function workCompletedAt(item) {
  const reviews = Array.isArray(item?.reviewHistory) ? item.reviewHistory : []
  const approved = [...reviews].reverse().find((review) => review?.decision === 'approved')
  return approved?.reviewedAt || item?.review?.reviewedAt || item?.completion?.submittedAt || item?.due || ''
}

/**
 * 옮겨도 되는 업무 id. 결재완료이고 기준일이 지났으며 — 트리가 깨지지 않게 —
 * 진행 중인 하위 업무가 남은 상위는 두고, 상위가 목록에 남는 하위만 따로 옮기지 않는다.
 */
export function archivableWorkItemIds(items, { now = new Date(), olderThanDays = WORK_ARCHIVE_AFTER_DAYS } = {}) {
  const list = Array.isArray(items) ? items : []
  const cutoff = now.getTime() - Math.max(0, Number(olderThanDays) || 0) * 24 * 60 * 60 * 1_000
  const candidates = new Set(list
    .filter((item) => item?.status === '결재완료')
    .filter((item) => {
      const at = Date.parse(workCompletedAt(item))
      return Number.isFinite(at) ? at <= cutoff : olderThanDays <= 0
    })
    .map((item) => item.id))
  const hot = new Set(list.map((item) => item?.id))
  let changed = true
  while (changed) {
    changed = false
    for (const item of list) {
      if (!candidates.has(item.id)) continue
      const childLeft = list.some((child) => child?.parentId === item.id && !candidates.has(child.id))
      const parentStays = item.parentId && hot.has(item.parentId) && !candidates.has(item.parentId)
      if (childLeft || parentStays) { candidates.delete(item.id); changed = true }
    }
  }
  return candidates
}

export function registerWorkArchiveRoutes({
  app,
  requireAuth,
  requireTenantAdmin,
  requireMatchingWorkspaceIdentity,
  workspaceStore,
  commitWorkspaceStore,
  archive,
  events,
  isMemberWorkItem,
}) {
  const tenantStoreOf = (tenantId) => (workspaceStore.tenants[tenantId] ??= {})

  /**
   * 끝난 업무를 옮긴다. 보관함에 먼저 쓰고, **그 사이 바뀌지 않은 행만** 최신 목록에서 뺀다.
   * 빼지 못한(그 사이 바뀐) 행과, 커밋이 실패했을 때의 행은 보관함에서 가린다 — 두 곳에 보이지 않게.
   */
  const archiveCompletedWorkItems = async (tenantId, { now = new Date(), olderThanDays = WORK_ARCHIVE_AFTER_DAYS, actor = 'system:archive', reason } = {}) => {
    const tenantStore = tenantStoreOf(tenantId)
    const current = Array.isArray(tenantStore['work-items']?.data) ? tenantStore['work-items'].data : []
    const ids = archivableWorkItemIds(current, { now, olderThanDays })
    if (!ids.size) return { archived: 0, remaining: current.length }
    const rows = current.filter((item) => ids.has(item.id))
    await archive.append(tenantId, WORK_ARCHIVE_COLLECTION, rows, {
      actor,
      reason: reason ?? (olderThanDays > 0 ? `완료 후 ${olderThanDays}일 지남` : '관리자가 지금 옮김'),
    })
    const latestRecord = tenantStore['work-items']
    const latest = Array.isArray(latestRecord?.data) ? latestRecord.data : []
    const archivedById = new Map(rows.map((row) => [row.id, row]))
    const moved = new Set(latest.filter((item) => archivedById.has(item.id) && isDeepStrictEqual(item, archivedById.get(item.id))).map((item) => item.id))
    const stale = [...ids].filter((id) => !moved.has(id))
    if (stale.length) await archive.forget(tenantId, WORK_ARCHIVE_COLLECTION, stale)
    if (!moved.size) return { archived: 0, remaining: latest.length }
    const next = latest.filter((item) => !moved.has(item.id))
    tenantStore['work-items'] = { data: next, updatedAt: now.toISOString(), updatedBy: actor }
    try {
      await commitWorkspaceStore()
    } catch (error) {
      tenantStore['work-items'] = latestRecord
      await archive.forget(tenantId, WORK_ARCHIVE_COLLECTION, [...moved]).catch(() => undefined)
      throw error
    }
    events?.publish(tenantId, 'work', { key: 'work-items' })
    return { archived: moved.size, remaining: next.length }
  }

  const refuse = (response, error, fallback = '보관함을 처리하지 못했습니다.') => {
    if (error instanceof ArchiveError) { response.status(error.status).json({ error: { code: error.code, message: error.message } }); return }
    console.error('[work-archive]', { message: error?.message })
    response.status(500).json({ error: { code: 'WORK_ARCHIVE_FAILED', message: fallback } })
  }

  /** 보관함 목록. 직원은 자기가 담당하거나 지시한 업무만 본다(진행 중 목록과 같은 잣대). */
  app.get('/api/work-items/archive', requireAuth, requireMatchingWorkspaceIdentity, async (request, response) => {
    if (!request.auth.tenantId) { response.status(403).json({ error: { code: 'TENANT_REQUIRED', message: '고객사 워크스페이스에서만 사용할 수 있습니다.' } }); return }
    try {
      const isAdmin = request.auth.role === 'tenant-admin'
      const page = await archive.list(request.auth.tenantId, WORK_ARCHIVE_COLLECTION, {
        offset: request.query.offset,
        limit: request.query.limit,
        query: String(request.query.q ?? ''),
        filter: isAdmin ? null : (row) => isMemberWorkItem(row, request.auth),
      })
      response.json({ ...page, canManage: isAdmin, archiveAfterDays: WORK_ARCHIVE_AFTER_DAYS })
    } catch (error) { refuse(response, error, '보관함을 읽지 못했습니다.') }
  })

  /** 끝난 업무를 지금 옮긴다(관리자). 기본은 기준일 없이 결재완료 전부. */
  app.post('/api/work-items/archive', requireAuth, requireTenantAdmin, requireMatchingWorkspaceIdentity, async (request, response) => {
    const days = Number(request.body?.olderThanDays ?? 0)
    const olderThanDays = Number.isFinite(days) ? Math.max(0, Math.min(365, Math.round(days))) : 0
    try {
      const result = await archiveCompletedWorkItems(request.auth.tenantId, { olderThanDays, actor: request.auth.id })
      response.json(result)
    } catch (error) { refuse(response, error, '끝난 업무를 보관함으로 옮기지 못했습니다.') }
  })

  /** 보관된 업무 하나를 진행 중 목록으로 꺼낸다(관리자). 목록이 가득하면 꺼내지 않는다. */
  app.post('/api/work-items/archive/:id/restore', requireAuth, requireTenantAdmin, requireMatchingWorkspaceIdentity, async (request, response) => {
    const tenantId = request.auth.tenantId
    const tenantStore = tenantStoreOf(tenantId)
    const current = Array.isArray(tenantStore['work-items']?.data) ? tenantStore['work-items'].data : []
    if (current.some((item) => item?.id === request.params.id)) { response.status(409).json({ error: { code: 'WORK_ITEM_ALREADY_ACTIVE', message: '이미 진행 중 목록에 있는 업무입니다.' } }); return }
    if (!prependWithinCap(current, {})) { response.status(409).json({ error: WORK_ITEMS_FULL }); return }
    let taken
    try {
      taken = await archive.take(tenantId, WORK_ARCHIVE_COLLECTION, String(request.params.id))
    } catch (error) { refuse(response, error, '보관된 업무를 꺼내지 못했습니다.'); return }
    const previousRecord = tenantStore['work-items']
    const latest = Array.isArray(previousRecord?.data) ? previousRecord.data : []
    const next = prependWithinCap(latest, taken.row)
    if (!next) { await taken.undo(); response.status(409).json({ error: WORK_ITEMS_FULL }); return }
    tenantStore['work-items'] = { data: next, updatedAt: new Date().toISOString(), updatedBy: request.auth.id }
    try {
      await commitWorkspaceStore()
    } catch {
      tenantStore['work-items'] = previousRecord
      await taken.undo().catch(() => undefined)
      response.status(500).json({ error: { code: 'WORK_ARCHIVE_RESTORE_FAILED', message: '보관된 업무를 꺼내지 못했습니다. 잠시 뒤 다시 시도해 주세요.' } })
      return
    }
    events?.publish(tenantId, 'work', { key: 'work-items' })
    response.json({ workItem: taken.row })
  })

  return { archiveCompletedWorkItems }
}

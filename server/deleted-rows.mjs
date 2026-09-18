import { randomBytes } from 'node:crypto'

/**
 * 지운 기록 되살리기(감사 business-admin-19 · data-core-05).
 *
 * 대장(계약·산출물·지원사업·거래처·프로젝트·자산·지식재산·인증·제품·일정 …)의 [삭제]는 generic PUT이
 * 배열에서 행을 빼는 것이었고, 뺀 행은 어디에도 남지 않았다 — window.confirm 한 번 뒤 영구히 사라졌다.
 * 이제 generic PUT이 뺀 행을 **커밋 전에** 보관함('deleted-rows')에 봉투로 담는다. 봉투 id는 지울 때마다 새로
 * 만들어, 같은 행을 지웠다 되살리고 다시 지워도 다시 되살릴 수 있다. 30일이 지나면 목록에서 사라진다.
 * 행에 붙은 첨부는 자료실 휴지통(30일)에 있으므로, 되살릴 때 함께 꺼낸다.
 */

export const DELETED_ROWS_COLLECTION = 'deleted-rows'
export const DELETED_ROW_DAYS = 30
const DAY_MS = 86_400_000

/** 지운 행을 보관하는 대장. 행 단위 기록이고, 한 번 지우면 다시 만들기 어려운 것들이다. */
export const DELETED_ROW_KEYS = Object.freeze(new Set([
  'it-projects', 'it-deliverables', 'it-contracts', 'it-clients', 'it-support-programs',
  'company-assets', 'ip-rights', 'compliance-records', 'product-catalog', 'sales-channels',
  'calendar-events', 'tax-events', 'inventory-locations', 'factory-locations', 'work-rules', 'project-templates',
]))

/** 목록에 보일 이름. 대장마다 이름 칸이 달라 흔한 순서로 찾는다. */
export function deletedRowLabel(row) {
  for (const field of ['title', 'name', 'client', 'clientName', 'productName', 'label']) {
    const value = row?.[field]
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 120)
  }
  return String(row?.id ?? '이름 없는 항목')
}

/** 이번 쓰기가 뺀 행(= 지운 행). id가 없는 행은 되살릴 수 없으므로 담지 않는다. */
export function removedRows(before, after) {
  const kept = new Set((Array.isArray(after) ? after : []).map((row) => row?.id).filter(Boolean))
  return (Array.isArray(before) ? before : []).filter((row) => row?.id && !kept.has(row.id))
}

export function envelopesFor(key, rows, auth, now = new Date()) {
  const at = now.toISOString()
  return rows.map((row) => ({
    id: `DEL-${now.getTime().toString(36).toUpperCase()}-${randomBytes(4).toString('hex').toUpperCase()}`,
    key,
    rowId: String(row.id),
    label: deletedRowLabel(row),
    row,
    deletedAt: at,
    createdAt: at,
    deletedById: String(auth?.id ?? ''),
    deletedByName: String(auth?.name ?? ''),
  }))
}

const freshEnough = (envelope, now) => Date.parse(envelope?.deletedAt ?? '') > now.getTime() - DELETED_ROW_DAYS * DAY_MS

export function registerDeletedRowRoutes({
  app, requireAuth, requireMatchingWorkspaceIdentity, archive, workspaceStore, commitWorkspaceStore,
  documentRecord, stageDocumentList, linkedDocumentIds, canWriteKey, clock = () => new Date(),
}) {
  const guards = [requireAuth, requireMatchingWorkspaceIdentity]
  const fail = (response, status, code, message) => response.status(status).json({ error: { code, message } })
  /** 관리자는 모두, 직원은 자기가 지운 것만. 되살리기도 같은 사람들이 한다. */
  const visibleTo = (envelope, auth) => auth.role === 'tenant-admin' || envelope.deletedById === auth.id

  const listFor = async (auth, key) => {
    const now = clock()
    const { rows } = await archive.list(auth.tenantId, DELETED_ROWS_COLLECTION, {
      limit: 200,
      filter: (envelope) => (!key || envelope?.key === key) && freshEnough(envelope, now) && visibleTo(envelope, auth),
    })
    return rows
  }

  app.get('/api/deleted-rows', ...guards, async (request, response) => {
    if (!request.auth.tenantId) { fail(response, 403, 'TENANT_REQUIRED', '고객사 워크스페이스에서만 사용할 수 있습니다.'); return }
    const key = String(request.query.key ?? '')
    if (key && !DELETED_ROW_KEYS.has(key)) { fail(response, 404, 'STORE_KEY_NOT_FOUND', '지운 기록을 보관하지 않는 영역입니다.'); return }
    try {
      const rows = await listFor(request.auth, key)
      response.json({
        days: DELETED_ROW_DAYS,
        items: rows.map((envelope) => ({
          id: envelope.id, key: envelope.key, rowId: envelope.rowId, label: envelope.label, row: envelope.row,
          deletedAt: envelope.deletedAt, deletedByName: envelope.deletedByName,
          purgeAt: new Date(Date.parse(envelope.deletedAt) + DELETED_ROW_DAYS * DAY_MS).toISOString(),
        })),
      })
    } catch {
      fail(response, 503, 'DELETED_ROWS_UNAVAILABLE', '지운 기록을 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.')
    }
  })

  const restore = async (request, response, pickEnvelope) => {
    const auth = request.auth
    if (!auth.tenantId) { fail(response, 403, 'TENANT_REQUIRED', '고객사 워크스페이스에서만 사용할 수 있습니다.'); return }
    let envelope
    try { envelope = await pickEnvelope() } catch { envelope = null }
    if (!envelope) { fail(response, 404, 'DELETED_ROW_NOT_FOUND', '되살릴 항목을 찾지 못했습니다. 이미 되살렸거나 30일이 지났을 수 있습니다.'); return }
    if (!canWriteKey(auth, envelope.key)) { fail(response, 403, 'STORE_WRITE_FORBIDDEN', '현재 직무 권한으로 이 기록을 되살릴 수 없습니다.'); return }
    const tenantStore = workspaceStore.tenants[auth.tenantId] ??= {}
    const current = Array.isArray(tenantStore[envelope.key]?.data) ? tenantStore[envelope.key].data : []
    if (current.some((row) => row?.id === envelope.rowId)) { fail(response, 409, 'DELETED_ROW_EXISTS', '같은 항목이 이미 목록에 있습니다.'); return }
    let taken
    try { taken = await archive.take(auth.tenantId, DELETED_ROWS_COLLECTION, envelope.id) }
    catch (error) { fail(response, error?.status ?? 409, error?.code ?? 'DELETED_ROW_NOT_FOUND', error?.message ?? '되살릴 항목을 찾지 못했습니다.'); return }

    const now = clock().toISOString()
    const previousRecord = tenantStore[envelope.key]
    tenantStore[envelope.key] = { data: [envelope.row, ...current], updatedAt: now, updatedBy: auth.id }
    // 행이 가리키던 첨부가 자료실 휴지통에 있으면 함께 꺼낸다 — 되살린 계약의 파일이 '찾을 수 없음'이 되지 않게.
    const attachmentIds = new Set(linkedDocumentIds([envelope.row]))
    const documents = Array.isArray(documentRecord(auth.tenantId)?.data) ? documentRecord(auth.tenantId).data : []
    let restoredFiles = 0
    let rollbackDocuments = null
    if (attachmentIds.size && documents.some((document) => attachmentIds.has(document?.id) && document?.trashedAt)) {
      const next = documents.map((document) => {
        if (!attachmentIds.has(document?.id) || !document?.trashedAt) return document
        restoredFiles += 1
        const { trashedAt: _trashedAt, trashedById: _trashedById, trashedByName: _trashedByName, ...rest } = document
        return rest
      })
      rollbackDocuments = stageDocumentList(auth.tenantId, next, auth.id)
    }
    try {
      await commitWorkspaceStore()
    } catch {
      if (previousRecord) tenantStore[envelope.key] = previousRecord
      else delete tenantStore[envelope.key]
      rollbackDocuments?.()
      await taken.undo().catch(() => undefined)
      fail(response, 500, 'DELETED_ROW_RESTORE_FAILED', '되살리지 못했습니다. 잠시 뒤 다시 시도해 주세요.')
      return
    }
    response.json({ key: envelope.key, row: envelope.row, label: envelope.label, restoredFiles })
  }

  app.post('/api/deleted-rows/:id/restore', ...guards, (request, response) => restore(request, response, async () => {
    const rows = await listFor(request.auth, '')
    return rows.find((envelope) => envelope.id === request.params.id) ?? null
  }))

  /** 알림 한 줄의 [되돌리기]: 이 대장에서 이 행을 가장 최근에 지운 봉투. */
  app.post('/api/deleted-rows/restore-latest', ...guards, (request, response) => restore(request, response, async () => {
    const key = String(request.body?.key ?? '')
    const rowId = String(request.body?.rowId ?? '')
    if (!DELETED_ROW_KEYS.has(key) || !rowId) return null
    const rows = await listFor(request.auth, key)
    return rows.filter((envelope) => envelope.rowId === rowId).sort((left, right) => right.deletedAt.localeCompare(left.deletedAt))[0] ?? null
  }))
}

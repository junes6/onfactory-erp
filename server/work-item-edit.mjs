import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import { GUEST_ROLE } from './guest-access.mjs'
import { appendWorkActivities, appendWorkActivity, WORK_COMMENT_LIMIT, WORK_COMMENT_MAX_LENGTH } from './work-activity.mjs'
import { WORK_ARCHIVE_COLLECTION } from './work-archive.mjs'

/**
 * 만든 업무를 고치고, 넘기고, 취소하고, 그 업무 안에서 이야기한다(P1-5).
 *
 * 전에는 업무를 만든 뒤 제목·담당자·우선순위·완료 기준을 고칠 길도, 취소할 길도, 업무 안에서 의견을 주고받을 곳도 없었다.
 * 지시한 사람이 퇴사·부재이면 결재대기 업무는 영원히 남았다(확인은 지시한 사람만 한다).
 *
 * 결재 상태머신(업무요청 → 수행중 → 결재대기 → 결재완료)은 건드리지 않는다:
 *   - 고치기는 상태가 아닌 칸만 바꾼다. 지시한 사람(requesterId)을 바꾸는 것은 관리자만 — 부재한 요청자의 확인을
 *     새 요청자가 **같은 확인 절차로** 하게 된다(확인 규칙 자체는 그대로다).
 *   - 취소는 새 상태가 아니라 보관함으로 옮기는 것이다(사유와 함께). 끝난 업무의 보관과 같은 자리이고, 되살릴 수 있다.
 */

const EDIT_LIMITS = { title: 120, description: 2_000, category: 20 }
const PRIORITIES = new Set(['긴급', '높음', '보통'])
const OPEN_STATUSES = new Set(['업무요청', '수행중'])

const workItemsOf = (tenantStore) => (Array.isArray(tenantStore?.['work-items']?.data) ? tenantStore['work-items'].data : [])
const clip = (value, max = 300) => String(value ?? '').slice(0, max)

export function registerWorkItemEditRoutes({
  app, requireAuth, requireMatchingWorkspaceIdentity, workspaceStore, commitWorkspaceStore,
  accounts, notify, events, archive, hasWorkItemShape, rebaseRowWrite, workspaceRecordVersion,
  bundleAssignmentDrafts, prependWithinCap, WORK_ITEMS_FULL, clock = () => new Date(),
}) {
  const tenantStoreOf = (tenantId) => (workspaceStore.tenants[tenantId] ??= {})
  const fail = (response, status, code, message) => response.status(status).json({ error: { code, message } })
  const isAdmin = (auth) => auth.role === 'tenant-admin'
  const activeAccount = (tenantId, id) => accounts.find((account) => account.id === id && account.tenantId === tenantId && account.approved !== false && account.approvalStatus !== 'inactive')

  /** 공통 머리: 테넌트·게스트·업무 찾기. 실패하면 응답을 보내고 null. */
  const loadTask = (request, response) => {
    if (!request.auth.tenantId) { fail(response, 403, 'TENANT_REQUIRED', '고객사 워크스페이스에서만 사용할 수 있습니다.'); return null }
    const tenantStore = tenantStoreOf(request.auth.tenantId)
    const previousRecord = tenantStore['work-items']
    const item = workItemsOf(tenantStore).find((row) => row?.id === request.params.id)
    if (!item) { fail(response, 404, 'WORK_ITEM_NOT_FOUND', '업무를 찾을 수 없습니다.'); return null }
    return { tenantStore, previousRecord, item }
  }

  /** 한 줄만 바꿔 저장한다(그 사이 목록이 바뀌었으면 최신 목록 위에, 이 업무가 바뀌었으면 409). */
  const commitRow = async (request, response, { tenantStore, previousRecord, item }, next) => {
    if (!hasWorkItemShape(next)) { fail(response, 400, 'INVALID_WORK_ITEM', '업무 데이터 형식을 확인해 주세요.'); return null }
    const nextData = rebaseRowWrite(tenantStore['work-items'], previousRecord, item, next)
    if (!nextData) { fail(response, 409, 'WORK_ITEM_CHANGED', '방금 다른 사람이 이 업무를 바꿨습니다. 화면을 새로 고친 뒤 다시 시도해 주세요.'); return null }
    const record = { data: nextData, updatedAt: clock().toISOString(), updatedBy: request.auth.id }
    const before = tenantStore['work-items']
    tenantStore['work-items'] = record
    try {
      await commitWorkspaceStore()
    } catch (error) {
      tenantStore['work-items'] = before
      console.error('[work-item-edit] 저장 실패', { message: error?.message })
      fail(response, 500, 'WORK_ITEM_WRITE_FAILED', '업무를 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.')
      return null
    }
    events?.publish(request.auth.tenantId, 'work', { key: 'work-items', taskId: next.id })
    return record
  }

  // ------------------------------------------------------------------ 고치기
  app.patch('/api/work-items/:id', requireAuth, requireMatchingWorkspaceIdentity, async (request, response) => {
    if (request.auth.role === GUEST_ROLE) { fail(response, 403, 'WORK_EDIT_FORBIDDEN', '외부 게스트는 업무를 고칠 수 없습니다.'); return }
    const loaded = loadTask(request, response)
    if (!loaded) return
    const { item } = loaded
    if (!isAdmin(request.auth) && item.requesterId !== request.auth.id) {
      fail(response, 403, 'WORK_EDIT_FORBIDDEN', '업무를 고칠 수 있는 사람은 지시한 사람과 관리자입니다.')
      return
    }
    if (item.status === '결재완료') { fail(response, 409, 'WORK_ITEM_FINISHED', '끝난 업무는 고치지 않습니다. 기록으로 남겨 둡니다.'); return }
    const body = request.body && typeof request.body === 'object' ? request.body : {}
    const now = clock().toISOString()
    const actor = { actorId: request.auth.id, actorName: request.auth.name, at: now }
    let next = { ...item }
    const entries = []

    for (const field of ['title', 'description', 'category']) {
      if (body[field] === undefined) continue
      const value = String(body[field] ?? '').trim()
      if ((field !== 'description' && !value) || value.length > EDIT_LIMITS[field]) {
        fail(response, 400, 'INVALID_WORK_EDIT', field === 'title' ? '업무 제목은 1~120자로 적어 주세요.' : field === 'category' ? '분류는 1~20자로 적어 주세요.' : '완료 기준은 2,000자까지 적을 수 있습니다.')
        return
      }
      if (value !== item[field]) { next[field] = value; entries.push({ kind: 'edit', field, from: clip(item[field]), to: clip(value), ...actor }) }
    }
    if (body.priority !== undefined) {
      if (!PRIORITIES.has(body.priority)) { fail(response, 400, 'INVALID_WORK_EDIT', '우선순위는 긴급·높음·보통 중 하나입니다.'); return }
      if (body.priority !== item.priority) { next.priority = body.priority; entries.push({ kind: 'edit', field: 'priority', from: item.priority, to: body.priority, ...actor }) }
    }
    let newOwner = null
    if (body.ownerId !== undefined && body.ownerId !== item.ownerId) {
      // 담당을 넘기는 것은 아직 일이 진행 중일 때만이다 — 결재대기에서 넘기면 남이 한 완료 보고를 새 담당이 떠안는다.
      if (!OPEN_STATUSES.has(item.status)) { fail(response, 409, 'WORK_OWNER_LOCKED', '확인을 기다리는 업무는 담당자를 바꿀 수 없습니다. 먼저 보완을 요청하거나 확인해 주세요.'); return }
      newOwner = activeAccount(request.auth.tenantId, String(body.ownerId ?? ''))
      if (!newOwner || newOwner.role === GUEST_ROLE && !item.projectId) { fail(response, 400, 'INVALID_WORK_OWNER', '이 회사의 활성 구성원 중에서 담당자를 골라 주세요.'); return }
      entries.push({ kind: 'owner', from: clip(item.owner, 80), to: clip(newOwner.name, 80), ...actor })
      next = { ...next, owner: newOwner.name, ownerId: newOwner.id }
    }
    let newRequester = null
    if (body.requesterId !== undefined && body.requesterId !== item.requesterId) {
      // 지시한 사람을 바꾸는 것은 관리자만 — 퇴사·부재한 요청자의 확인을 넘겨받을 사람을 정하는 일이다.
      if (!isAdmin(request.auth)) { fail(response, 403, 'WORK_REQUESTER_FORBIDDEN', '지시한 사람(확인하는 사람)은 관리자만 바꿀 수 있습니다.'); return }
      newRequester = activeAccount(request.auth.tenantId, String(body.requesterId ?? ''))
      if (!newRequester || newRequester.role === GUEST_ROLE) { fail(response, 400, 'INVALID_WORK_REQUESTER', '이 회사의 활성 구성원 중에서 확인할 사람을 골라 주세요.'); return }
      entries.push({ kind: 'requester', from: clip(item.requestedBy, 80), to: clip(newRequester.name, 80), ...actor })
      next = { ...next, requestedBy: newRequester.name, requesterId: newRequester.id }
    }
    if (!entries.length) { response.json({ item, version: workspaceRecordVersion(loaded.previousRecord) }); return }
    next = appendWorkActivities(next, entries)
    const record = await commitRow(request, response, loaded, next)
    if (!record) return
    // 새 담당자에게는 배정 알림, 그 밖의 변경은 담당자에게 한 줄(스스로 고친 것은 알리지 않는다).
    if (newOwner) notify(request.auth.tenantId, bundleAssignmentDrafts([next], { actorId: request.auth.id, actorName: request.auth.name }))
    if (newRequester && next.status === '결재대기') {
      notify(request.auth.tenantId, [{ type: 'approval-requested', recipientId: newRequester.id, actorId: request.auth.id, title: `확인할 업무가 넘어왔습니다: ${next.title}`, body: `${request.auth.name}님이 이 업무의 확인을 맡겼습니다.`, page: 'tasks', focusId: next.id, source: { kind: 'work-item', id: next.id, label: '업무' } }])
    }
    const noticeTo = [newOwner ? item.ownerId : next.ownerId].filter((id) => id && id !== request.auth.id)
    notify(request.auth.tenantId, noticeTo.map((recipientId) => ({
      type: 'task-updated', recipientId, actorId: request.auth.id,
      title: newOwner && recipientId === item.ownerId ? `업무가 ${newOwner.name}님에게 넘어갔습니다: ${next.title}` : `업무 내용이 바뀌었습니다: ${next.title}`,
      body: `${request.auth.name}님이 고쳤습니다.`, page: 'tasks', focusId: next.id, source: { kind: 'work-item', id: next.id, label: '업무' },
    })))
    response.json({ item: next, version: workspaceRecordVersion(record) })
  })

  // ------------------------------------------------------------------ 취소(보관함으로)
  app.post('/api/work-items/:id/cancel', requireAuth, requireMatchingWorkspaceIdentity, async (request, response) => {
    if (request.auth.role === GUEST_ROLE) { fail(response, 403, 'WORK_CANCEL_FORBIDDEN', '외부 게스트는 업무를 취소할 수 없습니다.'); return }
    const loaded = loadTask(request, response)
    if (!loaded) return
    const { tenantStore, previousRecord, item } = loaded
    if (!isAdmin(request.auth) && item.requesterId !== request.auth.id) { fail(response, 403, 'WORK_CANCEL_FORBIDDEN', '업무를 취소할 수 있는 사람은 지시한 사람과 관리자입니다.'); return }
    if (item.status === '결재완료') { fail(response, 409, 'WORK_ITEM_FINISHED', '끝난 업무는 취소하지 않습니다. 끝난 업무는 보관함으로 옮겨집니다.'); return }
    const reason = String(request.body?.reason ?? '').trim()
    if (reason.length < 2 || reason.length > 500) { fail(response, 400, 'WORK_CANCEL_REASON_REQUIRED', '취소하는 이유를 2자 이상 적어 주세요(담당자에게 전해집니다).'); return }
    const now = clock().toISOString()
    const cancelled = { at: now, by: request.auth.id, byName: request.auth.name, reason }
    // 하위 업무도 함께 옮긴다 — 상위가 없는 하위는 목록에서 고아가 된다.
    const originals = workItemsOf(tenantStore).filter((row) => row?.id === item.id || row?.parentId === item.id)
    const rows = originals.map((row) => appendWorkActivity({ ...row, cancelled: row.id === item.id ? cancelled : { ...cancelled, reason: clip(`상위 업무 취소 — ${reason}`, 500) } }, { kind: 'cancel', note: clip(reason, 500), actorId: request.auth.id, actorName: request.auth.name, at: now }))
    try {
      await archive.append(request.auth.tenantId, WORK_ARCHIVE_COLLECTION, rows, { actor: request.auth.id, reason: clip(`취소: ${reason}`, 200) })
    } catch (error) {
      console.error('[work-item-edit] 취소 보관 실패', { message: error?.message })
      fail(response, error?.status ?? 500, error?.code ?? 'WORK_CANCEL_FAILED', error?.status === 503 ? '보관함(파일 저장소)이 설정되지 않아 취소할 수 없습니다.' : '업무를 취소하지 못했습니다. 잠시 뒤 다시 시도해 주세요.')
      return
    }
    const ids = new Set(originals.map((row) => row.id))
    const latestRecord = tenantStore['work-items']
    const latest = workItemsOf(tenantStore)
    const unchanged = originals.every((row) => isDeepStrictEqual(latest.find((current) => current?.id === row.id), row))
    if (!unchanged) {
      await archive.forget(request.auth.tenantId, WORK_ARCHIVE_COLLECTION, [...ids]).catch(() => undefined)
      fail(response, 409, 'WORK_ITEM_CHANGED', '방금 다른 사람이 이 업무를 바꿨습니다. 화면을 새로 고친 뒤 다시 시도해 주세요.')
      return
    }
    tenantStore['work-items'] = { data: latest.filter((row) => !ids.has(row?.id)), updatedAt: now, updatedBy: request.auth.id }
    try {
      await commitWorkspaceStore()
    } catch (error) {
      tenantStore['work-items'] = latestRecord ?? previousRecord
      await archive.forget(request.auth.tenantId, WORK_ARCHIVE_COLLECTION, [...ids]).catch(() => undefined)
      fail(response, 500, 'WORK_CANCEL_FAILED', '업무를 취소하지 못했습니다. 잠시 뒤 다시 시도해 주세요.')
      return
    }
    events?.publish(request.auth.tenantId, 'work', { key: 'work-items' })
    const recipients = [...new Set(rows.map((row) => row.ownerId))].filter((id) => id && id !== request.auth.id)
    notify(request.auth.tenantId, recipients.map((recipientId) => ({
      type: 'task-updated', recipientId, actorId: request.auth.id,
      title: `업무가 취소됐습니다: ${item.title}`, body: clip(`${request.auth.name}님 · ${reason}`, 200),
      page: 'tasks', focusId: '', source: { kind: 'work-item', id: item.id, label: '업무' },
    })))
    response.json({ cancelled: [...ids], item: rows[0], version: workspaceRecordVersion(tenantStore['work-items']) })
  })

  // ------------------------------------------------------------------ 취소 되돌리기
  app.post('/api/work-items/cancelled/:id/restore', requireAuth, requireMatchingWorkspaceIdentity, async (request, response) => {
    if (!request.auth.tenantId || request.auth.role === GUEST_ROLE) { fail(response, 403, 'WORK_RESTORE_FORBIDDEN', '취소한 업무를 되살릴 수 없습니다.'); return }
    const tenantId = request.auth.tenantId
    const tenantStore = tenantStoreOf(tenantId)
    const current = workItemsOf(tenantStore)
    if (current.some((row) => row?.id === request.params.id)) { fail(response, 409, 'WORK_ITEM_ALREADY_ACTIVE', '이미 진행 중 목록에 있는 업무입니다.'); return }
    const takes = []
    const undoAll = async () => { for (const taken of takes.reverse()) await taken.undo().catch(() => undefined) }
    let root
    try {
      root = await archive.take(tenantId, WORK_ARCHIVE_COLLECTION, String(request.params.id))
      takes.push(root)
    } catch (error) {
      fail(response, error?.status ?? 404, error?.code ?? 'WORK_RESTORE_NOT_FOUND', '보관함에서 그 업무를 찾지 못했습니다.')
      return
    }
    const row = root.row
    if (!row?.cancelled || (!isAdmin(request.auth) && row.cancelled.by !== request.auth.id)) {
      await undoAll()
      fail(response, 403, 'WORK_RESTORE_FORBIDDEN', '취소한 사람과 관리자만 되살릴 수 있습니다.')
      return
    }
    if (row.parentId && !current.some((item) => item?.id === row.parentId)) {
      await undoAll()
      fail(response, 409, 'WORK_PARENT_NOT_ACTIVE', '상위 업무가 진행 중 목록에 없습니다. 상위 업무를 먼저 되살려 주세요.')
      return
    }
    // 함께 취소된 하위 업무도 함께 되살린다(같은 순간에 취소된 것만).
    try {
      const page = await archive.list(tenantId, WORK_ARCHIVE_COLLECTION, { limit: 200, filter: (child) => child?.parentId === row.id && child?.cancelled?.at === row.cancelled.at })
      for (const child of page.rows) takes.push(await archive.take(tenantId, WORK_ARCHIVE_COLLECTION, child.id))
    } catch (error) {
      await undoAll()
      fail(response, 500, 'WORK_RESTORE_FAILED', '함께 취소된 하위 업무를 꺼내지 못했습니다.')
      return
    }
    const now = clock().toISOString()
    const restored = takes.map(({ row: taken }) => {
      const { cancelled: _drop, archivedAt: _at, archiveReason: _reason, ...rest } = taken
      return appendWorkActivity(rest, { kind: 'restore', actorId: request.auth.id, actorName: request.auth.name, at: now })
    })
    let next = current
    for (const item of restored) {
      next = prependWithinCap(next, item)
      if (!next) { await undoAll(); response.status(409).json({ error: WORK_ITEMS_FULL }); return }
    }
    if (!restored.every((item) => hasWorkItemShape(item))) { await undoAll(); fail(response, 400, 'INVALID_WORK_ITEM', '되살린 업무의 형식을 확인하지 못했습니다.'); return }
    const previousRecord = tenantStore['work-items']
    tenantStore['work-items'] = { data: next, updatedAt: now, updatedBy: request.auth.id }
    try {
      await commitWorkspaceStore()
    } catch {
      tenantStore['work-items'] = previousRecord
      await undoAll()
      fail(response, 500, 'WORK_RESTORE_FAILED', '취소한 업무를 되살리지 못했습니다. 잠시 뒤 다시 시도해 주세요.')
      return
    }
    events?.publish(tenantId, 'work', { key: 'work-items' })
    response.json({ restored: restored.map((item) => item.id), items: restored, item: restored[0], version: workspaceRecordVersion(tenantStore['work-items']) })
  })

  // ------------------------------------------------------------------ 업무 댓글
  const canTalk = (auth, item) => isAdmin(auth) || item.ownerId === auth.id || item.requesterId === auth.id

  app.post('/api/work-items/:id/comments', requireAuth, requireMatchingWorkspaceIdentity, async (request, response) => {
    const loaded = loadTask(request, response)
    if (!loaded) return
    const { item } = loaded
    // 볼 수 없는 업무는 없는 업무다(목록에서 안 보이는 것과 같은 404).
    if (!canTalk(request.auth, item)) { fail(response, 404, 'WORK_ITEM_NOT_FOUND', '업무를 찾을 수 없습니다.'); return }
    const text = String(request.body?.text ?? '').trim()
    if (!text || text.length > WORK_COMMENT_MAX_LENGTH) { fail(response, 400, 'INVALID_WORK_COMMENT', '댓글은 1자 이상 2,000자 이하로 적어 주세요.'); return }
    const comments = Array.isArray(item.comments) ? item.comments : []
    if (comments.length >= WORK_COMMENT_LIMIT) { fail(response, 409, 'WORK_COMMENTS_FULL', `이 업무의 댓글이 ${WORK_COMMENT_LIMIT}건에 닿았습니다. 새 업무로 나눠 이어 가 주세요.`); return }
    const comment = { id: `wc-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`, authorId: request.auth.id, authorName: request.auth.name, authorRole: request.auth.role, text, createdAt: clock().toISOString() }
    const next = { ...item, comments: [...comments, comment] }
    const record = await commitRow(request, response, loaded, next)
    if (!record) return
    const recipients = [...new Set([item.ownerId, item.requesterId])].filter((id) => id && id !== request.auth.id)
    notify(request.auth.tenantId, recipients.map((recipientId) => ({
      type: 'task-comment', recipientId, actorId: request.auth.id,
      title: `${request.auth.name}님이 업무에 댓글을 남겼습니다: ${item.title}`, body: clip(text, 200),
      page: 'tasks', focusId: item.id, source: { kind: 'work-item', id: item.id, label: '업무' },
    })))
    response.status(201).json({ comment, item: next, version: workspaceRecordVersion(record) })
  })

  app.delete('/api/work-items/:id/comments/:commentId', requireAuth, requireMatchingWorkspaceIdentity, async (request, response) => {
    const loaded = loadTask(request, response)
    if (!loaded) return
    const { item } = loaded
    if (!canTalk(request.auth, item)) { fail(response, 404, 'WORK_ITEM_NOT_FOUND', '업무를 찾을 수 없습니다.'); return }
    const comments = Array.isArray(item.comments) ? item.comments : []
    const target = comments.find((comment) => comment.id === request.params.commentId)
    if (!target || target.deletedAt) { fail(response, 404, 'WORK_COMMENT_NOT_FOUND', '댓글을 찾을 수 없습니다.'); return }
    if (target.authorId !== request.auth.id && !isAdmin(request.auth)) { fail(response, 403, 'WORK_COMMENT_FORBIDDEN', '쓴 사람과 관리자만 지울 수 있습니다.'); return }
    // 자리는 남기고 본문만 지운다 — 뒤 댓글이 무엇에 답했는지 흐름이 깨지지 않게.
    const next = { ...item, comments: comments.map((comment) => comment.id === target.id ? { ...comment, text: '', deletedAt: clock().toISOString() } : comment) }
    const record = await commitRow(request, response, loaded, next)
    if (!record) return
    response.json({ item: next, version: workspaceRecordVersion(record) })
  })
}

import { GUEST_ROLE, GUEST_SCOPE_FORBIDDEN, guestWorkItemViolation } from './guest-access.mjs'

/**
 * 하위 업무 트리 — 업무 아래에 업무를 둔다(깊이 2단).
 *
 * 왜 별도 상태·별도 저장값이 없는가: 자식은 담당·마감·상태를 가진 정규 업무 행이고, 상위와의 관계는
 * `parentId` 한 필드다. 진행률·차단 건수·상위 제목은 저장하지 않고 자식 status에서 매번 파생한다.
 * 저장하면 두 곳이 어긋나는 순간이 반드시 오고, 어긋난 값은 사람을 잘못 안심시킨다.
 *
 * 불변식은 세 문에서만 강제한다 — 항목 shape(hasWorkItemShape: 자기참조·형식), 배열(workItemTreeViolation:
 * 고아·상위 없음·깊이·projectId·잠긴 상위), 상태머신 submit 분기(SUBTASKS_INCOMPLETE). 그 밖의 소비자
 * (브리핑·검색·알림·센티널)는 자식을 평면 행으로 그대로 읽는다.
 */

/** 깊이 상한. 화면에 보이는 문구가 이 값에서 나오게 두어, 상한만 고치고 문구가 낡는 일을 막는다. */
export const MAX_TREE_DEPTH = 2
/** 이 상태의 상위에는 자식을 새로 붙일 수 없다 — 결재대기 상위에 자식을 더하면 approve 시점에 '진행률 100% 미만인 완료'가 생긴다. */
export const CLOSED_STATUSES = Object.freeze(['결재대기', '결재완료'])
export const SUBTASK_ERRORS = Object.freeze({
  PARENT_NOT_FOUND: { code: 'SUBTASK_PARENT_NOT_FOUND', message: '상위 업무를 찾을 수 없습니다.' },
  ORPHANED: { code: 'SUBTASK_ORPHANED', message: '하위 업무가 남아 있는 상위 업무는 지울 수 없습니다. 하위 업무를 먼저 옮기거나 독립 업무로 승격해 주세요.' },
  DEPTH_EXCEEDED: { code: 'SUBTASK_DEPTH_EXCEEDED', message: `하위 업무는 ${MAX_TREE_DEPTH}단계까지만 둘 수 있습니다. 하위 업무 아래에는 다시 하위 업무를 둘 수 없습니다.` },
  PROJECT_MISMATCH: { code: 'SUBTASK_PROJECT_MISMATCH', message: '하위 업무는 상위 업무와 같은 프로젝트에 속해야 합니다.' },
  PARENT_LOCKED: { code: 'SUBTASK_PARENT_LOCKED', message: '완료 보고했거나 완료된 상위 업무에는 하위 업무를 붙일 수 없습니다.' },
})
const PARENT_INVALID = { code: 'SUBTASK_PARENT_INVALID', message: 'parentId는 상위 업무 id 또는 null이어야 합니다.' }
const MOVE_FORBIDDEN = { code: 'SUBTASK_MOVE_FORBIDDEN', message: '상위 업무는 지시한 사람이나 관리자만 바꿀 수 있습니다.' }

/** '' 와 undefined 를 같은 것으로 본다 — 레거시 행에 빈 문자열 projectId가 남아 있을 수 있다. */
export const projectKeyOf = (item) => item?.projectId || null
export const isSubtask = (item) => typeof item?.parentId === 'string' && item.parentId.length > 0
export const childrenOf = (items, parentId) => items.filter((item) => item?.parentId === parentId)
/** 자식 "완료"의 정의는 status === '결재완료' 하나. 결재대기는 아직 끝난 것이 아니다. */
export const openSubtaskCount = (items, parentId) => childrenOf(items, parentId).filter((child) => child?.status !== '결재완료').length

/**
 * 상한을 지키며 새 업무 한 건을 목록 앞에 붙인다.
 *
 * 왜 그냥 slice(0, cap)이 아닌가: 꼬리에서 잘린 행이 자식을 가진 상위였다면 그 자식들은 고아가 되고,
 * 그 뒤로는 관리자의 평범한 저장이 통째로 SUBTASK_PARENT_NOT_FOUND에 막힌다. 사람이 손댄 적 없는
 * 자리에서 막다른 길이 생기는 셈이라, 잘라야 한다면 자식이 없는 행부터 자른다.
 */
export function prependWithinCap(current, item, cap) {
  const next = [item, ...current]
  if (next.length <= cap) return next
  const parentIds = new Set(next.filter(isSubtask).map((row) => row.parentId))
  const kept = []
  let overflow = next.length - cap
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const row = next[index]
    if (overflow > 0 && index > 0 && !parentIds.has(row?.id)) { overflow -= 1; continue }
    kept.unshift(row)
  }
  // 꼬리가 전부 자식을 가진 상위라면(현실에선 거의 없다) 예전대로 뒤에서 자른다 — 새 업무는 지키고.
  return kept.length > cap ? kept.slice(0, cap) : kept
}

/** 진행률. 자식이 없으면 null — '0%'를 만들지 않는다(없는 것은 없다고 보인다). */
export function subtaskProgress(items, parentId) {
  const children = childrenOf(items, parentId)
  if (!children.length) return null
  const done = children.filter((child) => child.status === '결재완료').length
  return { total: children.length, done, percent: Math.round((done / children.length) * 100) }
}

/** 보이는 목록(visible) 안의 자식이 가리키는데 목록에 없는 상위. 제목만 준다 — 담당·상태·마감은 그 사람의 범위 밖이다. */
export function parentRefsFor(allItems, visible) {
  const visibleIds = new Set(visible.map((item) => item?.id))
  const refs = {}
  for (const item of visible) {
    if (!isSubtask(item) || visibleIds.has(item.parentId) || refs[item.parentId]) continue
    const parent = allItems.find((candidate) => candidate?.id === item.parentId)
    if (parent) refs[item.parentId] = { id: parent.id, title: String(parent.title ?? '') }
  }
  return refs
}

/** 배열 사본: child.parentId 설정/삭제 + projectId 상속(상위 projectId, 없으면 키 삭제). 승격(null)은 projectId를 그대로 둔다. */
export function withParent(items, childId, parent) {
  return items.map((item) => {
    if (item?.id !== childId) return item
    if (!parent) { const { parentId: _drop, ...rest } = item; return rest }
    const next = { ...item, parentId: parent.id }
    if (projectKeyOf(parent)) next.projectId = parent.projectId; else delete next.projectId
    return next
  })
}

/**
 * 배열 단위 트리 불변식. 통과하면 null, 아니면 { code, message, itemId }.
 * 검사 순서가 곧 우선순위: 고아 → 상위 없음 → 깊이 → projectId → 잠긴 상위.
 * 타 테넌트 상위: 검사 대상이 한 테넌트의 work-items 배열이므로 외부 id는 byId에 없다 → PARENT_NOT_FOUND(구조로 보장, 테스트로 고정).
 * 순환(A→B, B→A)은 isSubtask(parent)에서 DEPTH_EXCEEDED로 잡힌다.
 */
export function workItemTreeViolation(nextItems, previousItems = []) {
  const byId = new Map((nextItems ?? []).map((item) => [item?.id, item]))
  const previousById = new Map((previousItems ?? []).map((item) => [item?.id, item]))
  for (const item of nextItems ?? []) {
    if (!isSubtask(item)) continue
    const parent = byId.get(item.parentId)
    if (!parent) return { ...(previousById.has(item.parentId) ? SUBTASK_ERRORS.ORPHANED : SUBTASK_ERRORS.PARENT_NOT_FOUND), itemId: item.id }
    if (isSubtask(parent)) return { ...SUBTASK_ERRORS.DEPTH_EXCEEDED, itemId: item.id }
    if (projectKeyOf(item) !== projectKeyOf(parent)) return { ...SUBTASK_ERRORS.PROJECT_MISMATCH, itemId: item.id }
    // 이미 붙어 있던 자식은 상위가 결재대기로 넘어가도 그대로 저장된다. 막는 것은 "새로 붙이기"만.
    const before = previousById.get(item.id)
    const attachedNow = !before || before.parentId !== item.parentId
    if (attachedNow && CLOSED_STATUSES.includes(parent.status)) return { ...SUBTASK_ERRORS.PARENT_LOCKED, itemId: item.id }
  }
  return null
}

/**
 * POST /api/work-items/:id/parent — 하위 업무를 다른 상위로 옮기거나(parentId) 독립 업무로 승격한다(null).
 *
 * 왜 전용 라우트인가: 직원의 generic PUT은 status 외 변경을 전부 403으로 막는다(sameWorkItemExceptStatus).
 * 그 규칙을 열지 않고, 체크리스트 라우트처럼 단건 POST 하나로만 이 필드를 바꾼다.
 * 지시한 사람(requester)과 관리자만 — 담당자가 자기 업무를 남의 상위 아래로 옮기면 그 사람의 진행률이 바뀐다.
 * 게스트 allowlist에는 넣지 않았으므로 게이트가 먼저 403을 낸다(여기 role 검사는 이중 방어).
 */
export function registerWorkItemTreeRoutes({
  app, requireAuth, requireMatchingWorkspaceIdentity, workspaceStore, accounts, commitWorkspaceStore, events,
  guestGrantOf, hasWorkItemShape, isMemberWorkItem, workspaceRecordVersion,
}) {
  app.post('/api/work-items/:id/parent', requireAuth, requireMatchingWorkspaceIdentity, async (request, response) => {
    if (!request.auth.tenantId) {
      response.status(403).json({ error: { code: 'TENANT_REQUIRED', message: '고객사 워크스페이스에서만 사용할 수 있습니다.' } })
      return
    }
    if (request.auth.role === GUEST_ROLE) {
      response.status(403).json({ error: GUEST_SCOPE_FORBIDDEN })
      return
    }
    // 본문은 { parentId: string | null } 하나. ''·숫자·자기 id는 형식 오류 — 키를 빠뜨린 호출도 "승격"으로 해석하지 않는다.
    const body = request.body ?? {}
    const hasKey = Object.prototype.hasOwnProperty.call(body, 'parentId')
    const parentId = body.parentId
    const validParent = parentId === null || (typeof parentId === 'string' && parentId.length > 0 && parentId !== request.params.id)
    if (!hasKey || !validParent) {
      response.status(400).json({ error: PARENT_INVALID })
      return
    }
    const tenantStore = workspaceStore.tenants[request.auth.tenantId] ?? {}
    const previousRecord = tenantStore['work-items']
    const previousData = Array.isArray(previousRecord?.data) ? previousRecord.data : []
    const previous = previousData.find((item) => item?.id === request.params.id)
    if (!previous) {
      response.status(404).json({ error: { code: 'WORK_ITEM_NOT_FOUND', message: '업무를 찾을 수 없습니다.' } })
      return
    }
    if (request.auth.role !== 'tenant-admin' && previous.requesterId !== request.auth.id) {
      response.status(403).json({ error: MOVE_FORBIDDEN })
      return
    }
    // 자식을 가진 행은 다른 행의 자식이 될 수 없다(깊이 2).
    if (parentId !== null && childrenOf(previousData, previous.id).length > 0) {
      response.status(400).json({ error: SUBTASK_ERRORS.DEPTH_EXCEEDED })
      return
    }
    let parent = null
    if (parentId !== null) {
      parent = previousData.find((item) => item?.id === parentId) ?? null
      // 직원에게 남의 업무는 없는 업무다 — 존재 여부를 응답 코드로 알려 주지 않는다.
      if (!parent || (request.auth.role === 'tenant-member' && !isMemberWorkItem(parent, request.auth))) {
        response.status(400).json({ error: SUBTASK_ERRORS.PARENT_NOT_FOUND })
        return
      }
      if (isSubtask(parent)) {
        response.status(400).json({ error: SUBTASK_ERRORS.DEPTH_EXCEEDED })
        return
      }
      // 상태 충돌은 409 — 체크리스트 잠금(CHECKLIST_LOCKED)과 같은 관례. 관리자 PUT의 400과 다르다.
      if (CLOSED_STATUSES.includes(parent.status)) {
        response.status(409).json({ error: SUBTASK_ERRORS.PARENT_LOCKED })
        return
      }
    }
    if ((previous.parentId ?? null) === parentId) {
      // 같은 값이면 쓰지 않는다 — updatedAt·version이 그대로여야 화면이 헛된 재조회를 하지 않는다.
      response.json({ item: previous, updatedAt: previousRecord?.updatedAt ?? null, version: workspaceRecordVersion(previousRecord) })
      return
    }
    const nextData = withParent(previousData, previous.id, parent)
    const nextItem = nextData.find((item) => item?.id === previous.id)
    if (!hasWorkItemShape(nextItem)) {
      response.status(400).json({ error: { code: 'INVALID_WORK_ITEM', message: '업무 처리 데이터 형식을 확인해 주세요.' } })
      return
    }
    // 게스트 담당 자식이 projectId 없는 상위 아래로 가면 귀속을 잃는다 — 관리자 PUT과 같은 제약.
    const guestViolation = guestWorkItemViolation([nextItem], accounts, guestGrantOf)
    if (guestViolation) { response.status(400).json({ error: guestViolation }); return }
    const treeViolation = workItemTreeViolation(nextData, previousData)
    if (treeViolation) { response.status(400).json({ error: treeViolation }); return }

    const now = new Date().toISOString()
    const record = { data: nextData, updatedAt: now, updatedBy: request.auth.id }
    tenantStore['work-items'] = record
    workspaceStore.tenants[request.auth.tenantId] = tenantStore
    try {
      await commitWorkspaceStore()
    } catch (error) {
      if (previousRecord) tenantStore['work-items'] = previousRecord
      else delete tenantStore['work-items']
      console.error('[work-item-tree] Failed to persist parent change', { message: error?.message })
      response.status(500).json({ error: { code: 'SUBTASK_MOVE_WRITE_FAILED', message: '상위 업무 변경을 저장하지 못했습니다.' } })
      return
    }
    // 제목을 싣지 않는다 — 게스트 스트림은 key·version만 받는다. 배정이 아니므로 알림도 없다.
    events.publish(request.auth.tenantId, 'work', { key: 'work-items', taskId: nextItem.id })
    response.json({ item: nextItem, updatedAt: now, version: workspaceRecordVersion(record) })
  })
}

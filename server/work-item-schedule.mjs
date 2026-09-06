import { GUEST_ROLE, GUEST_SCOPE_FORBIDDEN } from './guest-access.mjs'

/**
 * 업무 기간 — 시작(startAt)과 마감(due).
 *
 * 왜 간트가 아닌가: 의존 관계·크리티컬 패스·리소스 할당을 만들지 않는다. 막대 하나는
 * '이 업무가 언제부터 언제까지인가' 한 문장이고, 그 문장을 바꾸는 문은 이 라우트 하나다.
 *
 * 왜 전용 라우트인가: startAt을 WORK_ITEM_OPTIONAL_FIELDS에 올리는 순간
 * sameWorkItemExceptStatus(server/app.mjs)가 직원의 generic PUT에서 이 필드 변경을 자동으로 403으로 만든다.
 * 그 규칙을 열지 않고 /parent, /checklist와 같은 단건 POST 하나로만 기간을 바꾼다.
 *
 * 왜 지시자와 관리자인가: 마감은 약속이다. 담당자가 자기 마감을 스스로 미룰 수 있으면 그것은 약속이 아니다.
 * (상위를 옮기는 /parent의 SUBTASK_MOVE_FORBIDDEN과 같은 인가 규칙.)
 *
 * 왜 별도 파일인가: work-item-tree.mjs의 독타는 parentId 불변식 하나를 설명하는 문서이고
 * work-item-tree-routes.test.mjs가 그 계약을 통째로 고정한다. 파일을 나누면 그 계약이 한 줄도 바뀌지 않는다.
 */

/** 저장 가능한 시각은 ISO UTC 한 형식뿐. personal-todo-routes.mjs의 validIsoUtc의 거울. */
export const isScheduleInstant = (value) => typeof value === 'string'
  && value.length <= 40
  && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value

/** 막대 하나가 2년을 넘으면 눈금이 무의미해지고, 대개는 연도 오타다. */
export const MAX_SCHEDULE_SPAN_DAYS = 730
export const SCHEDULE_MIN_ISO = '2000-01-01T00:00:00.000Z'
export const SCHEDULE_MAX_ISO = '2100-01-01T00:00:00.000Z'
/**
 * 이 상태에서는 기간을 바꾸지 않는다 — 끝난 업무의 기간을 고치면 기록이 아니라 각색이 된다.
 * 결재대기는 잠그지 않는다: 확인을 기다리는 동안 지시자가 마감을 미루는 것은 정상 업무다.
 */
export const SCHEDULE_CLOSED_STATUSES = Object.freeze(['결재완료'])

export const SCHEDULE_ERRORS = Object.freeze({
  INVALID: { code: 'SCHEDULE_INVALID', message: '시작일과 마감은 ISO 형식(예: 2026-10-08T09:00:00.000Z)으로 보내 주세요.' },
  ORDER: { code: 'SCHEDULE_ORDER_INVALID', message: '시작일은 마감일보다 뒤일 수 없습니다.' },
  SPAN: { code: 'SCHEDULE_SPAN_TOO_LONG', message: `한 업무의 기간은 ${MAX_SCHEDULE_SPAN_DAYS}일을 넘을 수 없습니다. 하위 업무로 나눠 주세요.` },
  RANGE: { code: 'SCHEDULE_OUT_OF_RANGE', message: '날짜가 다루는 범위를 벗어났습니다. 연도를 확인해 주세요.' },
  FORBIDDEN: { code: 'SCHEDULE_FORBIDDEN', message: '업무 기간은 지시한 사람이나 관리자만 바꿀 수 있습니다.' },
  LOCKED: { code: 'SCHEDULE_LOCKED', message: '완료된 업무의 기간은 바꿀 수 없습니다.' },
  WRITE_FAILED: { code: 'SCHEDULE_WRITE_FAILED', message: '업무 기간을 저장하지 못했습니다.' },
})

/** 통과하면 null, 아니면 { code, message }. 순수 — 라우트와 단위 테스트가 같이 쓴다. */
export function scheduleViolation({ startAt, due }) {
  if (!isScheduleInstant(due)) return SCHEDULE_ERRORS.INVALID
  if (startAt !== null && startAt !== undefined && !isScheduleInstant(startAt)) return SCHEDULE_ERRORS.INVALID
  const dueMs = Date.parse(due)
  if (dueMs < Date.parse(SCHEDULE_MIN_ISO) || dueMs > Date.parse(SCHEDULE_MAX_ISO)) return SCHEDULE_ERRORS.RANGE
  if (startAt == null) return null
  const startMs = Date.parse(startAt)
  // 마감과 같은 두 끝을 본다. 위쪽만 빠져 있었을 때 시작일 2200년은 ORDER('시작일은 마감일보다 뒤일 수 없습니다')로 거절됐다 —
  // date 칸의 네 자리 연도 오타에 대고 어디를 볼지 말해 주는 문장은 RANGE 쪽이다.
  if (startMs < Date.parse(SCHEDULE_MIN_ISO) || startMs > Date.parse(SCHEDULE_MAX_ISO)) return SCHEDULE_ERRORS.RANGE
  // 같은 시각 시작·마감은 정상(하루짜리 업무). 뒤집힌 것만 막는다.
  if (startMs > dueMs) return SCHEDULE_ERRORS.ORDER
  if (dueMs - startMs > MAX_SCHEDULE_SPAN_DAYS * 86_400_000) return SCHEDULE_ERRORS.SPAN
  return null
}

/**
 * 배열 저장(관리자 PUT)에서 /schedule이 거절할 기간을 미리 막는다. 통과하면 null.
 *
 * 왜 필요한가: 새 업무 지시 화면은 startAt과 due를 배열 PUT 하나로 보낸다. 이 문을 열어 두면
 * /schedule이 거절하는 짝이 들어와 앉는다 — 드로어는 '12.1 → 10.1'이라 적고,
 * 타임라인은 clamp해서 하루짜리 막대를 그리고, 마감만 고치려는 다음 요청은 400으로 막힌다.
 * 들어올 수는 있는데 나갈 수 없는 값이 된다. 뒤집힘(ORDER)만이 아니라 2년 초과(SPAN)와
 * 범위 밖 연도(RANGE)도 같다: 1500년으로 앉은 시작일은 그 막대의 모든 기간 변경을
 * '하위 업무로 나눠 주세요'로 막는데, 그것은 고치는 방법이 아니다.
 *
 * 왜 두 문이 같은 함수를 쓰는가: 규칙이 두 벌이면 주석으로만 일치하고 언젠가 갈린다(scheduleViolation 하나).
 *
 * 왜 hasWorkItemShape가 아닌가: 그 함수는 행 하나의 모양만 본다(이 규칙은 두 필드의 관계다).
 * 배열 검증 자리(workItemTreeViolation 옆)가 맞다 — 저장 직전, 정규화 뒤 한 번.
 *
 * 왜 바뀐 행만 보는가: 이미 저장돼 있던 어긋난 행 하나가 그 뒤의 모든 배열 저장을 막으면
 * 그 행을 고칠 화면조차 열리지 않는다(SUBTASK_PARENT_LOCKED의 attachedNow와 같은 규율).
 * 두 값이 모두 ISO로 읽힐 때만 판정한다 — 레거시 자유 문자열 마감('오늘 18:00')은 건드리지 않는다.
 */
export function scheduleArrayViolation(nextItems, previousItems = []) {
  const previousById = new Map((previousItems ?? []).map((item) => [item?.id, item]))
  for (const item of nextItems ?? []) {
    if (!isScheduleInstant(item?.startAt) || !isScheduleInstant(item?.due)) continue
    const before = previousById.get(item.id)
    if (before && before.startAt === item.startAt && before.due === item.due) continue
    const violation = scheduleViolation({ startAt: item.startAt, due: item.due })
    if (violation) return { ...violation, itemId: item.id }
  }
  return null
}

/**
 * 배열 사본: due 교체 + startAt 설정/삭제.
 * hasStartKey가 거짓이면 startAt은 손대지 않는다 — 값이 없으면 키도 없다는 이진성이
 * JSON 모드와 PG 모드를 같게 유지한다(빈 문자열을 남기면 두 모드가 갈린다).
 */
export function withSchedule(items, id, { startAt, due, hasStartKey }) {
  return items.map((item) => {
    if (item?.id !== id) return item
    const next = { ...item, due }
    if (hasStartKey) {
      if (startAt === null) delete next.startAt
      else next.startAt = startAt
    }
    return next
  })
}

/**
 * POST /api/work-items/:id/schedule — 업무 기간(시작·마감)을 한 번의 커밋으로 정한다.
 *
 * due는 필수다: 이동·왼쪽 리사이즈·오른쪽 리사이즈 세 조작이 전부 마감을 확정하므로,
 * 한 커밋으로 기간 전체가 정해져야 두 필드가 어긋나지 않는다.
 * startAt 키가 없으면 기존 값 유지, null이면 키 삭제, 문자열이면 설정(/parent와 같은 관례).
 *
 * due는 여기서 ISO만 받는다 — canonicalWorkDue의 '오늘 18:00' 문법을 받지 않는다.
 * 드래그·키보드가 만드는 값은 화면이 이미 계산한 날짜이고, 새 문법을 하나 더 열면 due 파서가 두 곳이 된다.
 * 레거시 자유 문자열 due를 가진 행은 첫 조작에서 ISO로 정규화된다 — 부작용이 아니라 이득이다.
 *
 * 자식·상위 기간 정합은 검사하지 않는다(표시만 한다): 상위 마감을 당기는 평범한 조작이
 * 이미 어긋난 자식 5건 때문에 막히면, 그 5건을 먼저 고칠 화면이 어디에도 없다.
 *
 * 게스트 allowlist에는 넣지 않았으므로 게이트가 먼저 403을 낸다(여기 role 검사는 이중 방어).
 */
export function registerWorkItemScheduleRoutes({
  app, requireAuth, requireMatchingWorkspaceIdentity, workspaceStore, commitWorkspaceStore, events,
  hasWorkItemShape, workspaceRecordVersion, scheduleSentinel,
}) {
  app.post('/api/work-items/:id/schedule', requireAuth, requireMatchingWorkspaceIdentity, async (request, response) => {
    if (!request.auth.tenantId) {
      response.status(403).json({ error: { code: 'TENANT_REQUIRED', message: '고객사 워크스페이스에서만 사용할 수 있습니다.' } })
      return
    }
    if (request.auth.role === GUEST_ROLE) {
      response.status(403).json({ error: GUEST_SCOPE_FORBIDDEN })
      return
    }
    const body = request.body
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      response.status(400).json({ error: SCHEDULE_ERRORS.INVALID })
      return
    }
    const hasStartKey = Object.prototype.hasOwnProperty.call(body, 'startAt')
    const startKeyValid = !hasStartKey || body.startAt === null || typeof body.startAt === 'string'
    if (!Object.prototype.hasOwnProperty.call(body, 'due') || !startKeyValid) {
      response.status(400).json({ error: SCHEDULE_ERRORS.INVALID })
      return
    }
    const due = body.due
    const tenantStore = workspaceStore.tenants[request.auth.tenantId] ?? {}
    const previousRecord = tenantStore['work-items']
    const previousData = Array.isArray(previousRecord?.data) ? previousRecord.data : []
    // 배열이 테넌트별이므로 타 테넌트 id는 구조적으로 여기서 없는 업무가 된다.
    const previous = previousData.find((item) => item?.id === request.params.id)
    if (!previous) {
      response.status(404).json({ error: { code: 'WORK_ITEM_NOT_FOUND', message: '업무를 찾을 수 없습니다.' } })
      return
    }
    if (request.auth.role !== 'tenant-admin' && previous.requesterId !== request.auth.id) {
      response.status(403).json({ error: SCHEDULE_ERRORS.FORBIDDEN })
      return
    }
    // 상태 충돌은 409 — CHECKLIST_LOCKED·SUBTASK_PARENT_LOCKED와 같은 관례.
    if (SCHEDULE_CLOSED_STATUSES.includes(previous.status)) {
      response.status(409).json({ error: SCHEDULE_ERRORS.LOCKED })
      return
    }
    const nextStartAt = hasStartKey ? (body.startAt === null ? null : body.startAt) : (previous.startAt ?? null)
    const violation = scheduleViolation({ startAt: nextStartAt, due })
    if (violation) {
      response.status(400).json({ error: violation })
      return
    }
    if (previous.due === due && (previous.startAt ?? null) === nextStartAt) {
      // 같은 값이면 쓰지 않는다 — updatedAt·version이 그대로여야 화면이 헛된 재조회를 하지 않는다.
      response.json({ item: previous, updatedAt: previousRecord?.updatedAt ?? null, version: workspaceRecordVersion(previousRecord) })
      return
    }
    const nextData = withSchedule(previousData, previous.id, { startAt: nextStartAt, due, hasStartKey })
    const nextItem = nextData.find((item) => item?.id === previous.id)
    if (!hasWorkItemShape(nextItem)) {
      response.status(400).json({ error: { code: 'INVALID_WORK_ITEM', message: '업무 처리 데이터 형식을 확인해 주세요.' } })
      return
    }

    const now = new Date().toISOString()
    const record = { data: nextData, updatedAt: now, updatedBy: request.auth.id }
    tenantStore['work-items'] = record
    workspaceStore.tenants[request.auth.tenantId] = tenantStore
    try {
      await commitWorkspaceStore()
    } catch (error) {
      if (previousRecord) tenantStore['work-items'] = previousRecord
      else delete tenantStore['work-items']
      console.error('[work-item-schedule] Failed to persist schedule change', { message: error?.message })
      response.status(500).json({ error: SCHEDULE_ERRORS.WRITE_FAILED })
      return
    }
    // 마감이 바뀌면 work-overdue 센티널의 판정이 즉시 달라진다. generic PUT이 SENTINEL_TRIGGER_KEYS로 하는 일을
    // 전용 라우트도 해야 두 경로가 같은 결론을 낸다(/parent가 부르지 않는 이유와 대비된다 — 상위 관계는 마감과 무관하다).
    scheduleSentinel(request.auth.tenantId)
    // 제목을 싣지 않는다 — 게스트 스트림은 key·id만 받는다. 배정이 아니므로 알림도 없다.
    events.publish(request.auth.tenantId, 'work', { key: 'work-items', taskId: nextItem.id })
    response.json({ item: nextItem, updatedAt: now, version: workspaceRecordVersion(record) })
  })
}

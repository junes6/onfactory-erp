import { randomBytes } from 'node:crypto'

const ATTENDANCE_KEY = 'attendance-records'
const DEFAULT_STANDARD_START_TIME = '09:00'
const MAX_ATTENDANCE_RECORDS = 20_000

const validStandardStartTime = (value) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value ?? ''))
const validClockTime = validStandardStartTime
const MAX_SHIFT_MS = 24 * 60 * 60 * 1_000
/** 본인이 적는 퇴근 시각은 출근 뒤 16시간 안 — 그보다 긴 근무는 거의 언제나 잘못 적은 것이다(관리자는 24시간까지). */
const MAX_SELF_SHIFT_MS = 16 * 60 * 60 * 1_000
const MAX_CORRECTIONS = 20
const CORRECTION_KINDS = new Set(['self-missed-clock-out', 'admin'])
const CORRECTION_FIELDS = new Set(['clockInAt', 'clockOutAt'])
const validIsoUtc = (value) => typeof value === 'string'
  && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value

function seoulParts(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value)
  const part = (type) => parts.find((entry) => entry.type === type)?.value ?? ''
  return { year: part('year'), month: part('month'), day: part('day') }
}

export function seoulAttendanceDate(value = new Date()) {
  const { year, month, day } = seoulParts(value)
  return `${year}-${month}-${day}`
}

/**
 * 정정 한 번. 근태는 급여·노무의 근거라 **누가·언제·무엇을·왜** 바꿨는지 기록에 남긴다(이전값 포함).
 * 전에는 기록을 고치는 길 자체가 없었다(감사 work-15).
 */
function normalizeCorrection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const at = String(value.at ?? '')
  const byId = String(value.byId ?? '').trim()
  const byName = String(value.byName ?? '').trim()
  const field = String(value.field ?? '')
  const before = value.before == null || value.before === '' ? null : String(value.before)
  const after = String(value.after ?? '')
  const reason = String(value.reason ?? '').trim()
  const kind = String(value.kind ?? '')
  if (!validIsoUtc(at) || !byId || byId.length > 120 || byName.length > 80 || !CORRECTION_FIELDS.has(field)
    || (before !== null && !validIsoUtc(before)) || !validIsoUtc(after) || reason.length > 200 || !CORRECTION_KINDS.has(kind)) return null
  return { at, byId, byName, field, before, after, reason, kind }
}

/**
 * 그 근무일의 'HH:MM'(서울)을 UTC로. 출근 시각보다 이르면 다음 날 새벽 퇴근(야간 근무)으로 읽는다.
 * 출근에서 maxShiftMs를 넘거나 지금보다 늦으면 거절한다(null).
 */
function clockOutOnWorkDate(record, time, now, maxShiftMs = MAX_SELF_SHIFT_MS) {
  if (!validClockTime(time)) return null
  let at = Date.parse(`${record.workDate}T${time}:00+09:00`)
  const started = Date.parse(record.clockInAt)
  if (at < started) at += MAX_SHIFT_MS
  if (at - started > maxShiftMs || at > now.getTime()) return null
  return new Date(at).toISOString()
}

/** 퇴근을 빠뜨린 날에 하는 말. 시각을 적었는데 받지 못했으면 왜인지까지 말한다. */
function missedClockOutMessage(record, typed) {
  const day = monthDayLabel(record.workDate)
  if (!typed) return `${day} 퇴근을 찍지 않았습니다. 그날 퇴근한 시각을 적어 주세요.`
  return `적은 퇴근 시각(${typed})은 ${day} 출근 뒤 16시간 안이어야 하고 지금보다 늦을 수 없습니다. 다시 적어 주세요. 더 긴 근무였다면 관리자에게 정정을 요청해 주세요.`
}

function monthDayLabel(workDate) {
  return `${Number(workDate.slice(5, 7))}월 ${Number(workDate.slice(8, 10))}일`
}

function normalizeAttendanceRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const id = String(value.id ?? '').trim()
  const accountId = String(value.accountId ?? '').trim()
  const employeeName = String(value.employeeName ?? '').trim()
  const team = String(value.team ?? '').trim()
  const workDate = String(value.workDate ?? '').trim()
  const clockInAt = String(value.clockInAt ?? '').trim()
  const clockOutAt = value.clockOutAt == null || value.clockOutAt === '' ? null : String(value.clockOutAt).trim()
  const standardStartTime = String(value.standardStartTime ?? '').trim()
  const createdAt = String(value.createdAt ?? '').trim()
  const updatedAt = String(value.updatedAt ?? '').trim()
  if (!id || id.length > 120 || !accountId || accountId.length > 120
    || !employeeName || employeeName.length > 80 || team.length > 80
    || !/^\d{4}-\d{2}-\d{2}$/.test(workDate) || !validIsoUtc(clockInAt)
    || (clockOutAt && (!validIsoUtc(clockOutAt) || Date.parse(clockOutAt) < Date.parse(clockInAt)))
    || !validStandardStartTime(standardStartTime) || !validIsoUtc(createdAt) || !validIsoUtc(updatedAt)) return null
  if (value.corrections !== undefined && (!Array.isArray(value.corrections) || value.corrections.length > MAX_CORRECTIONS)) return null
  const corrections = (value.corrections ?? []).map(normalizeCorrection)
  if (corrections.some((correction) => !correction)) return null
  return { id, accountId, employeeName, team, workDate, clockInAt, clockOutAt, standardStartTime, createdAt, updatedAt, ...(corrections.length ? { corrections } : {}) }
}

export function normalizeAttendanceState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const policy = value.policy && typeof value.policy === 'object' && !Array.isArray(value.policy) ? value.policy : {}
  const standardStartTime = String(policy.standardStartTime ?? DEFAULT_STANDARD_START_TIME).trim()
  const policyUpdatedAt = policy.updatedAt == null || policy.updatedAt === '' ? null : String(policy.updatedAt).trim()
  const policyUpdatedBy = policy.updatedBy == null || policy.updatedBy === '' ? null : String(policy.updatedBy).trim()
  if (!validStandardStartTime(standardStartTime)
    || (policyUpdatedAt && !validIsoUtc(policyUpdatedAt))
    || (policyUpdatedBy && policyUpdatedBy.length > 120)
    || !Array.isArray(value.records) || value.records.length > MAX_ATTENDANCE_RECORDS) return null
  const records = value.records.map(normalizeAttendanceRecord)
  if (records.some((record) => !record)) return null
  const ids = new Set(records.map((record) => record.id))
  const employeeDays = new Set(records.map((record) => `${record.accountId}:${record.workDate}`))
  if (ids.size !== records.length || employeeDays.size !== records.length) return null
  return {
    policy: {
      standardStartTime,
      ...(policyUpdatedAt ? { updatedAt: policyUpdatedAt } : {}),
      ...(policyUpdatedBy ? { updatedBy: policyUpdatedBy } : {}),
    },
    records,
  }
}

const emptyAttendanceState = () => ({ policy: { standardStartTime: DEFAULT_STANDARD_START_TIME }, records: [] })

export function registerAttendanceRoutes({
  app,
  requireAuth,
  requireTenantAdmin,
  requireMatchingWorkspaceIdentity,
  workspaceStore,
  accounts,
  commitWorkspaceStore,
  clock = () => new Date(),
}) {
  const attendanceAccount = (auth) => accounts.find((account) => account.id === auth.id
    && account.tenantId === auth.tenantId && account.approved && account.role !== 'platform-operator')

  const readState = (tenantId) => {
    const stored = workspaceStore.tenants?.[tenantId]?.[ATTENDANCE_KEY]?.data
    if (stored == null) return emptyAttendanceState()
    return normalizeAttendanceState(stored)
  }

  const publicState = (state, auth) => ({
    policy: state.policy,
    records: auth.role === 'tenant-admin'
      ? state.records
      : state.records.filter((record) => record.accountId === auth.id),
  })

  const requireTenantState = (request, response) => {
    if (!request.auth?.tenantId) {
      response.status(403).json({ error: { code: 'TENANT_REQUIRED', message: '고객사 워크스페이스에서만 사용할 수 있습니다.' } })
      return null
    }
    const state = readState(request.auth.tenantId)
    if (!state) {
      response.status(500).json({ error: { code: 'ATTENDANCE_DATA_INVALID', message: '출퇴근 기록 형식이 올바르지 않아 안전하게 처리하지 않았습니다.' } })
      return null
    }
    return state
  }

  const commitState = async (auth, nextState) => {
    const tenantStore = workspaceStore.tenants[auth.tenantId] ?? {}
    const previousRecord = tenantStore[ATTENDANCE_KEY]
    const now = clock().toISOString()
    const record = { data: nextState, updatedAt: now, updatedBy: auth.id }
    tenantStore[ATTENDANCE_KEY] = record
    workspaceStore.tenants[auth.tenantId] = tenantStore
    try {
      await commitWorkspaceStore()
    } catch (error) {
      if (previousRecord) tenantStore[ATTENDANCE_KEY] = previousRecord
      else delete tenantStore[ATTENDANCE_KEY]
      throw error
    }
    return record
  }

  const guards = [requireAuth, requireMatchingWorkspaceIdentity]

  app.get('/api/attendance', ...guards, (request, response) => {
    const state = requireTenantState(request, response)
    if (!state) return
    const employee = attendanceAccount(request.auth)
    response.json({
      data: publicState(state, request.auth),
      canClock: Boolean(employee),
      version: workspaceRecordVersion(workspaceStore.tenants[request.auth.tenantId]?.[ATTENDANCE_KEY]),
    })
  })

  app.post('/api/attendance/clock-in', ...guards, async (request, response) => {
    const state = requireTenantState(request, response)
    if (!state) return
    const employee = attendanceAccount(request.auth)
    if (!employee) {
      response.status(403).json({ error: { code: 'ATTENDANCE_EMPLOYEE_REQUIRED', message: '고객사 직원 계정만 출퇴근을 기록할 수 있습니다.' } })
      return
    }
    const occurredAt = clock()
    const workDate = seoulAttendanceDate(occurredAt)
    const existing = state.records.find((record) => record.accountId === employee.id && record.workDate === workDate)
    if (existing) {
      response.status(409).json({ error: { code: 'ATTENDANCE_ALREADY_CLOCKED_IN', message: existing.clockOutAt ? '오늘 출퇴근 기록이 이미 완료되었습니다.' : '이미 출근 처리되어 있습니다.' } })
      return
    }
    let records = state.records
    const previouslyOpen = state.records.find((record) => record.accountId === employee.id && !record.clockOutAt)
    if (previouslyOpen) {
      // 퇴근을 빠뜨린 날이 있다. 전에는 여기서 막히고, 누를 수 있는 단추는 그 날에 '지금'을 찍어 24시간 넘는 근무를
      // 만드는 [퇴근하기]뿐이었다(감사 work-15). 그날 퇴근한 시각을 함께 받으면 닫고 바로 출근한다.
      const typed = String(request.body?.previousClockOutTime ?? '').trim()
      const closedAt = clockOutOnWorkDate(previouslyOpen, typed, occurredAt)
      if (!closedAt) {
        response.status(409).json({ error: { code: 'ATTENDANCE_CLOCK_OUT_REQUIRED', message: missedClockOutMessage(previouslyOpen, typed), openRecord: { id: previouslyOpen.id, workDate: previouslyOpen.workDate, clockInAt: previouslyOpen.clockInAt } } })
        return
      }
      const correctedAt = occurredAt.toISOString()
      records = records.map((record) => record.id === previouslyOpen.id ? {
        ...record, clockOutAt: closedAt, updatedAt: correctedAt,
        corrections: [...(record.corrections ?? []), { at: correctedAt, byId: employee.id, byName: employee.name, field: 'clockOutAt', before: null, after: closedAt, reason: '퇴근 누락 — 다음 출근 때 본인이 시각을 적음', kind: 'self-missed-clock-out' }].slice(-MAX_CORRECTIONS),
      } : record)
    }
    const now = occurredAt.toISOString()
    const attendanceRecord = {
      id: `ATT-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`,
      accountId: employee.id,
      employeeName: employee.name,
      team: employee.team ?? '',
      workDate,
      clockInAt: now,
      clockOutAt: null,
      standardStartTime: state.policy.standardStartTime,
      createdAt: now,
      updatedAt: now,
    }
    const nextState = { ...state, records: [attendanceRecord, ...records] }
    try {
      const committed = await commitState(request.auth, nextState)
      response.status(201).json({ data: publicState(nextState, request.auth), record: attendanceRecord, version: workspaceRecordVersion(committed) })
    } catch {
      response.status(500).json({ error: { code: 'ATTENDANCE_WRITE_FAILED', message: '출근 시간을 저장하지 못했습니다.' } })
    }
  })

  app.post('/api/attendance/clock-out', ...guards, async (request, response) => {
    const state = requireTenantState(request, response)
    if (!state) return
    const employee = attendanceAccount(request.auth)
    if (!employee) {
      response.status(403).json({ error: { code: 'ATTENDANCE_EMPLOYEE_REQUIRED', message: '고객사 직원 계정만 출퇴근을 기록할 수 있습니다.' } })
      return
    }
    const openRecord = state.records
      .filter((record) => record.accountId === employee.id && !record.clockOutAt)
      .sort((left, right) => right.clockInAt.localeCompare(left.clockInAt))[0]
    if (!openRecord) {
      response.status(409).json({ error: { code: 'ATTENDANCE_CLOCK_IN_REQUIRED', message: '퇴근 처리할 열린 출근 기록이 없습니다.' } })
      return
    }
    const instant = clock()
    const now = instant.toISOString()
    if (Date.parse(now) < Date.parse(openRecord.clockInAt)) {
      response.status(409).json({ error: { code: 'ATTENDANCE_TIME_INVALID', message: '퇴근 시각은 출근 시각보다 빠를 수 없습니다.' } })
      return
    }
    // 지난 날의 열린 기록에 '지금'을 찍으면 20~30시간 근무가 된다. 그날 퇴근한 시각을 받는다.
    const missed = openRecord.workDate < seoulAttendanceDate(instant) && instant.getTime() - Date.parse(openRecord.clockInAt) > MAX_SHIFT_MS / 2
    let nextRecord = { ...openRecord, clockOutAt: now, updatedAt: now }
    if (missed) {
      const typed = String(request.body?.clockOutTime ?? '').trim()
      const closedAt = clockOutOnWorkDate(openRecord, typed, instant)
      if (!closedAt) {
        response.status(409).json({ error: { code: 'ATTENDANCE_MISSED_CLOCK_OUT', message: missedClockOutMessage(openRecord, typed), openRecord: { id: openRecord.id, workDate: openRecord.workDate, clockInAt: openRecord.clockInAt } } })
        return
      }
      nextRecord = {
        ...openRecord, clockOutAt: closedAt, updatedAt: now,
        corrections: [...(openRecord.corrections ?? []), { at: now, byId: employee.id, byName: employee.name, field: 'clockOutAt', before: null, after: closedAt, reason: '퇴근 누락 — 본인이 시각을 적음', kind: 'self-missed-clock-out' }].slice(-MAX_CORRECTIONS),
      }
    }
    const nextState = { ...state, records: state.records.map((record) => record.id === openRecord.id ? nextRecord : record) }
    try {
      const committed = await commitState(request.auth, nextState)
      response.json({ data: publicState(nextState, request.auth), record: nextRecord, version: workspaceRecordVersion(committed) })
    } catch {
      response.status(500).json({ error: { code: 'ATTENDANCE_WRITE_FAILED', message: '퇴근 시간을 저장하지 못했습니다.' } })
    }
  })

  /**
   * 관리자 정정. 사유는 필수이고, 바꾼 칸마다 이전값·새값·정정자·사유가 기록에 남는다 — 직원은 자기 기록에서 그 사실을 본다.
   */
  app.patch('/api/attendance/records/:id', requireAuth, requireTenantAdmin, requireMatchingWorkspaceIdentity, async (request, response) => {
    const state = requireTenantState(request, response)
    if (!state) return
    const target = state.records.find((record) => record.id === request.params.id)
    if (!target) { response.status(404).json({ error: { code: 'ATTENDANCE_RECORD_NOT_FOUND', message: '출퇴근 기록을 찾을 수 없습니다.' } }); return }
    const reason = String(request.body?.reason ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200)
    if (reason.length < 2) { response.status(400).json({ error: { code: 'ATTENDANCE_REASON_REQUIRED', message: '정정 사유를 적어 주세요. 사유는 직원의 기록에 함께 남습니다.' } }); return }
    const instant = clock()
    const clockInTime = String(request.body?.clockInTime ?? '').trim()
    const clockOutTime = String(request.body?.clockOutTime ?? '').trim()
    if (clockInTime && !validClockTime(clockInTime)) { response.status(400).json({ error: { code: 'ATTENDANCE_TIME_INVALID', message: '출근 시각을 00:00~23:59 형식으로 적어 주세요.' } }); return }
    const clockInAt = clockInTime ? new Date(Date.parse(`${target.workDate}T${clockInTime}:00+09:00`)).toISOString() : target.clockInAt
    if (Date.parse(clockInAt) > instant.getTime()) { response.status(400).json({ error: { code: 'ATTENDANCE_TIME_INVALID', message: '출근 시각이 지금보다 늦을 수 없습니다.' } }); return }
    const clockOutAt = clockOutTime ? clockOutOnWorkDate({ ...target, clockInAt }, clockOutTime, instant, MAX_SHIFT_MS) : target.clockOutAt
    if (clockOutTime && !clockOutAt) { response.status(400).json({ error: { code: 'ATTENDANCE_TIME_INVALID', message: '퇴근 시각은 출근 뒤 24시간 안이고 지금보다 이르게 적어 주세요.' } }); return }
    if (clockOutAt && Date.parse(clockOutAt) < Date.parse(clockInAt)) { response.status(400).json({ error: { code: 'ATTENDANCE_TIME_INVALID', message: '퇴근 시각은 출근 시각보다 빠를 수 없습니다.' } }); return }
    const at = instant.toISOString()
    const byName = accounts.find((account) => account.id === request.auth.id)?.name ?? request.auth.name ?? ''
    const changes = [
      clockInAt !== target.clockInAt ? { at, byId: request.auth.id, byName, field: 'clockInAt', before: target.clockInAt, after: clockInAt, reason, kind: 'admin' } : null,
      clockOutAt && clockOutAt !== target.clockOutAt ? { at, byId: request.auth.id, byName, field: 'clockOutAt', before: target.clockOutAt, after: clockOutAt, reason, kind: 'admin' } : null,
    ].filter(Boolean)
    if (!changes.length) { response.status(400).json({ error: { code: 'ATTENDANCE_NO_CHANGE', message: '바뀐 시각이 없습니다.' } }); return }
    const nextRecord = { ...target, clockInAt, clockOutAt, updatedAt: at, corrections: [...(target.corrections ?? []), ...changes].slice(-MAX_CORRECTIONS) }
    const nextState = { ...state, records: state.records.map((record) => record.id === target.id ? nextRecord : record) }
    try {
      const committed = await commitState(request.auth, nextState)
      response.json({ data: publicState(nextState, request.auth), record: nextRecord, version: workspaceRecordVersion(committed) })
    } catch {
      response.status(500).json({ error: { code: 'ATTENDANCE_WRITE_FAILED', message: '정정한 시각을 저장하지 못했습니다.' } })
    }
  })

  app.patch('/api/attendance/settings', requireAuth, requireTenantAdmin, requireMatchingWorkspaceIdentity, async (request, response) => {
    const state = requireTenantState(request, response)
    if (!state) return
    const standardStartTime = String(request.body?.standardStartTime ?? '').trim()
    if (!validStandardStartTime(standardStartTime)) {
      response.status(400).json({ error: { code: 'ATTENDANCE_STANDARD_TIME_INVALID', message: '기준 출근 시각을 00:00~23:59 형식으로 입력해 주세요.' } })
      return
    }
    const now = clock().toISOString()
    const nextState = { ...state, policy: { standardStartTime, updatedAt: now, updatedBy: request.auth.id } }
    try {
      const committed = await commitState(request.auth, nextState)
      response.json({ data: publicState(nextState, request.auth), version: workspaceRecordVersion(committed) })
    } catch {
      response.status(500).json({ error: { code: 'ATTENDANCE_WRITE_FAILED', message: '출근 기준 시각을 저장하지 못했습니다.' } })
    }
  })
}

function workspaceRecordVersion(record) {
  return (record?.updatedAt && record?.data)
    ? `${record.updatedAt}:${record.data.records?.length ?? 0}`
    : 'empty'
}

import { randomBytes } from 'node:crypto'

const ATTENDANCE_KEY = 'attendance-records'
const DEFAULT_STANDARD_START_TIME = '09:00'
const MAX_ATTENDANCE_RECORDS = 20_000

const validStandardStartTime = (value) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value ?? ''))
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
  return { id, accountId, employeeName, team, workDate, clockInAt, clockOutAt, standardStartTime, createdAt, updatedAt }
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
    const previouslyOpen = state.records.find((record) => record.accountId === employee.id && !record.clockOutAt)
    if (previouslyOpen) {
      response.status(409).json({ error: { code: 'ATTENDANCE_CLOCK_OUT_REQUIRED', message: `${previouslyOpen.workDate} 출근 기록의 퇴근을 먼저 처리해 주세요.` } })
      return
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
    const nextState = { ...state, records: [attendanceRecord, ...state.records] }
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
    const now = clock().toISOString()
    if (Date.parse(now) < Date.parse(openRecord.clockInAt)) {
      response.status(409).json({ error: { code: 'ATTENDANCE_TIME_INVALID', message: '퇴근 시각은 출근 시각보다 빠를 수 없습니다.' } })
      return
    }
    const nextRecord = { ...openRecord, clockOutAt: now, updatedAt: now }
    const nextState = { ...state, records: state.records.map((record) => record.id === openRecord.id ? nextRecord : record) }
    try {
      const committed = await commitState(request.auth, nextState)
      response.json({ data: publicState(nextState, request.auth), record: nextRecord, version: workspaceRecordVersion(committed) })
    } catch {
      response.status(500).json({ error: { code: 'ATTENDANCE_WRITE_FAILED', message: '퇴근 시간을 저장하지 못했습니다.' } })
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

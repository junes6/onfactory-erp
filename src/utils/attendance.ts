import { seoulDateInputValue, seoulDateTimeInputValue, toIsoUtc } from './dateTime.ts'

export type AttendanceRecord = {
  id: string
  accountId: string
  employeeName: string
  team: string
  workDate: string
  clockInAt: string
  clockOutAt: string | null
  standardStartTime: string
  createdAt: string
  updatedAt: string
}

export type AttendanceState = {
  policy: { standardStartTime: string; updatedAt?: string; updatedBy?: string }
  records: AttendanceRecord[]
}

export type AttendanceStatus = '정상' | '지각' | '근무중' | '미퇴근'

const isIsoUtc = (value: unknown): value is string => typeof value === 'string'
  && Boolean(toIsoUtc(value))
  && new Date(value).toISOString() === value

export function isAttendanceState(value: unknown): value is AttendanceState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const state = value as Partial<AttendanceState>
  if (!state.policy || typeof state.policy !== 'object'
    || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(state.policy.standardStartTime ?? '')
    || !Array.isArray(state.records)) return false
  return state.records.every((record) => record && typeof record.id === 'string'
    && typeof record.accountId === 'string' && typeof record.employeeName === 'string' && typeof record.team === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(record.workDate)
    && isIsoUtc(record.clockInAt) && (record.clockOutAt === null || isIsoUtc(record.clockOutAt))
    && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(record.standardStartTime)
    && isIsoUtc(record.createdAt) && isIsoUtc(record.updatedAt))
}

export function attendanceStatus(record: AttendanceRecord, now = new Date()): AttendanceStatus {
  const currentDate = seoulDateInputValue(now)
  if (!record.clockOutAt && record.workDate < currentDate) return '미퇴근'
  const clockInTime = seoulDateTimeInputValue(new Date(record.clockInAt)).slice(11, 16)
  const late = clockInTime > record.standardStartTime
  if (!record.clockOutAt) return late ? '지각' : '근무중'
  return late ? '지각' : '정상'
}

export function attendanceDurationMinutes(record: AttendanceRecord, now = new Date()) {
  const started = Date.parse(record.clockInAt)
  const ended = record.clockOutAt ? Date.parse(record.clockOutAt) : now.getTime()
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return 0
  return Math.floor((ended - started) / 60_000)
}

export function formatAttendanceDuration(minutes: number) {
  const safeMinutes = Math.max(0, Math.floor(minutes))
  const hours = Math.floor(safeMinutes / 60)
  const remainder = safeMinutes % 60
  return hours > 0 ? `${hours}시간 ${remainder}분` : `${remainder}분`
}

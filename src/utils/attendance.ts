import { seoulDateInputValue, seoulDateTimeInputValue, toIsoUtc } from './dateTime.ts'

/** 정정 한 번 — 누가·언제·무엇을(이전값→새값)·왜. 서버 attendance-routes.mjs의 normalizeCorrection과 같은 모양. */
export type AttendanceCorrection = {
  at: string
  byId: string
  byName: string
  field: 'clockInAt' | 'clockOutAt'
  before: string | null
  after: string
  reason: string
  kind: 'self-missed-clock-out' | 'admin'
}

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
  corrections?: AttendanceCorrection[]
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

/** 퇴근을 빠뜨렸다고 볼 시간. 전날 밤 출근·새벽 퇴근(야간 근무)은 '미퇴근'이 아니다 — 서버와 같은 기준. */
const MISSED_AFTER_MS = 12 * 60 * 60 * 1_000

export function attendanceStatus(record: AttendanceRecord, now = new Date()): AttendanceStatus {
  const currentDate = seoulDateInputValue(now)
  if (!record.clockOutAt && record.workDate < currentDate && now.getTime() - Date.parse(record.clockInAt) > MISSED_AFTER_MS) return '미퇴근'
  const clockInTime = seoulDateTimeInputValue(new Date(record.clockInAt)).slice(11, 16)
  const late = clockInTime > record.standardStartTime
  if (!record.clockOutAt) return late ? '지각' : '근무중'
  return late ? '지각' : '정상'
}

export function attendanceDurationMinutes(record: AttendanceRecord, now = new Date()) {
  // 퇴근을 빠뜨린 날은 근무시간을 '지금까지'로 세지 않는다 — 전에는 30시간, 40시간으로 불어나 월 누적까지 틀어졌다.
  if (attendanceStatus(record, now) === '미퇴근') return 0
  const started = Date.parse(record.clockInAt)
  const ended = record.clockOutAt ? Date.parse(record.clockOutAt) : now.getTime()
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return 0
  return Math.floor((ended - started) / 60_000)
}

/** ISO 시각의 서울 'HH:MM'. 정정 창의 시간 칸을 채울 때 쓴다. */
export function seoulClockTime(value: string | null) {
  return value ? seoulDateTimeInputValue(new Date(value)).slice(11, 16) : ''
}

export function formatAttendanceDuration(minutes: number) {
  const safeMinutes = Math.max(0, Math.floor(minutes))
  const hours = Math.floor(safeMinutes / 60)
  const remainder = safeMinutes % 60
  return hours > 0 ? `${hours}시간 ${remainder}분` : `${remainder}분`
}

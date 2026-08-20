const SEOUL_TIME_ZONE = 'Asia/Seoul'
const SEOUL_OFFSET = '+09:00'

type DateValue = string | number | Date | null | undefined

function seoulParts(value: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SEOUL_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value)
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') }
}

function seoulDateKey(value: Date) {
  const { year, month, day } = seoulParts(value)
  return `${year}-${month}-${day}`
}

function shiftDateKey(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, month - 1, day + days))
  return shifted.toISOString().slice(0, 10)
}

function legacyRelativeToIso(value: string, now: Date) {
  const match = /^(오늘|내일|어제)(?:\s+(\d{1,2}):(\d{2}))?$/.exec(value)
  if (!match) return null
  const offset = match[1] === '내일' ? 1 : match[1] === '어제' ? -1 : 0
  const date = shiftDateKey(seoulDateKey(now), offset)
  const hour = (match[2] ?? '00').padStart(2, '0')
  const minute = match[3] ?? '00'
  return new Date(`${date}T${hour}:${minute}:00${SEOUL_OFFSET}`).toISOString()
}

/**
 * Converts accepted UI and legacy date values to an ISO-8601 UTC timestamp.
 * Date-only and timezone-less values are interpreted as Korea Standard Time.
 */
export function toIsoUtc(value: DateValue, now = new Date()): string | null {
  if (value == null || value === '') return null
  if (value instanceof Date || typeof value === 'number') {
    const date = value instanceof Date ? value : new Date(value)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }

  const source = value.trim()
  if (!source) return null
  const legacy = legacyRelativeToIso(source, now)
  if (legacy) return legacy
  if (/^\d{4}-\d{2}-\d{2}$/.test(source)) {
    const parsed = new Date(`${source}T00:00:00${SEOUL_OFFSET}`)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
  }
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(source)) {
    const parsed = new Date(`${source.replace(' ', 'T')}${SEOUL_OFFSET}`)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
  }
  const parsed = new Date(source)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

export function seoulDateInputValue(value = new Date()) {
  return seoulDateKey(value)
}

export function seoulDateTimeInputValue(value = new Date()) {
  const { year, month, day, hour, minute } = seoulParts(value)
  return `${year}-${month}-${day}T${hour}:${minute}`
}

export function seoulLocalToUtcIso(date: string, time = '00:00') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null
  return toIsoUtc(`${date}T${time}:00`)
}

export function formatDateTime(value: DateValue, fallback = '일시 미정') {
  const iso = toIsoUtc(value)
  if (!iso) return typeof value === 'string' && value.trim() ? value : fallback
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: SEOUL_TIME_ZONE,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso))
}

export function formatShortDateTime(value: DateValue, fallback = '일시 미정') {
  const iso = toIsoUtc(value)
  if (!iso) return typeof value === 'string' && value.trim() ? value : fallback
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: SEOUL_TIME_ZONE,
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso))
}

export function formatDateLabel(value: DateValue, includeYear = true, includeWeekday = true, fallback = '날짜 미정') {
  const iso = toIsoUtc(value)
  if (!iso) return typeof value === 'string' && value.trim() ? value : fallback
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: SEOUL_TIME_ZONE,
    year: includeYear ? 'numeric' : undefined,
    month: 'long',
    day: 'numeric',
    weekday: includeWeekday ? 'long' : undefined,
  }).format(new Date(iso))
}

export function formatMonthLabel(value: DateValue, fallback = '날짜 미정') {
  const iso = toIsoUtc(value)
  if (!iso) return fallback
  return new Intl.DateTimeFormat('ko-KR', { timeZone: SEOUL_TIME_ZONE, month: 'long' }).format(new Date(iso))
}

export function formatYearMonthLabel(value: DateValue, fallback = '날짜 미정') {
  const iso = toIsoUtc(value)
  if (!iso) return fallback
  return new Intl.DateTimeFormat('ko-KR', { timeZone: SEOUL_TIME_ZONE, year: 'numeric', month: 'long' }).format(new Date(iso))
}

/** Compact, action-oriented due label while keeping legacy relative strings compatible. */
export function formatWorkDue(value: DateValue, now = new Date()) {
  const iso = toIsoUtc(value, now)
  if (!iso) return typeof value === 'string' && value.trim() ? value : '마감 미정'
  const target = new Date(iso)
  const targetKey = seoulDateKey(target)
  const todayKey = seoulDateKey(now)
  const daysFromToday = Math.round((new Date(`${targetKey}T00:00:00Z`).getTime() - new Date(`${todayKey}T00:00:00Z`).getTime()) / 86_400_000)
  const relative = targetKey === todayKey
    ? '오늘'
    : daysFromToday > 0 && daysFromToday < 7
      ? new Intl.DateTimeFormat('ko-KR', { timeZone: SEOUL_TIME_ZONE, weekday: 'long' }).format(target)
      : `${Number(targetKey.slice(5, 7))}.${Number(targetKey.slice(8, 10))}`
  const source = typeof value === 'string' ? value.trim() : ''
  const hasTime = value instanceof Date || typeof value === 'number' || /(?:T|\s)\d{1,2}:\d{2}|^(?:오늘|내일|어제)\s+\d{1,2}:\d{2}$/.test(source)
  if (!hasTime || targetKey !== todayKey) return relative
  const time = new Intl.DateTimeFormat('ko-KR', { timeZone: SEOUL_TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(target)
  return `${relative} ${time}`
}

export function formatWorkRuleRun(nextRun: string, dueTime: string) {
  return formatWorkDue(`${nextRun}T${dueTime || '00:00'}:00`)
}

const SEOUL_TIME_ZONE = 'Asia/Seoul'
const SEOUL_OFFSET = '+09:00'

type DateValue = string | number | Date | null | undefined

/**
 * 옵션이 상수이므로 포매터도 상수다.
 *
 * 왜 모듈 상수인가: seoulParts는 이 파일의 거의 모든 함수가 부르는 바닥이고,
 * 타임라인은 드래그 한 프레임에 이것을 수백 번 부른다. 호출마다 새 Intl.DateTimeFormat을
 * 만들면(실측 0.073ms/회 → 캐시 0.015ms/회) 그 비용이 그대로 프레임 시간이 된다.
 */
const SEOUL_PARTS_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: SEOUL_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

function seoulParts(value: Date) {
  const parts = SEOUL_PARTS_FORMAT.formatToParts(value)
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') }
}

// 파일 밖으로 내보내지 않는다 — 바깥이 부르는 같은 값은 seoulDateInputValue 하나다(내보내면 이름이 두 개가 된다).
function seoulDateKey(value: Date) {
  const { year, month, day } = seoulParts(value)
  return `${year}-${month}-${day}`
}

export function shiftDateKey(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, month - 1, day + days))
  return shifted.toISOString().slice(0, 10)
}

/**
 * 두 날짜 키 사이의 정수 일수(UTC 자정 기준).
 *
 * 타임라인 열 인덱스의 유일한 출처다. 화면에서 밀리초를 나누는 코드를 따로 쓰면
 * 서머타임 없는 KST에서도 날짜 키 파싱이 두 곳으로 갈린다.
 */
export function dayKeyDiff(fromKey: string, toKey: string) {
  const at = (key: string) => Date.parse(`${key}T00:00:00Z`)
  return Math.round((at(toKey) - at(fromKey)) / 86_400_000)
}

/**
 * 값에서 서울 기준 'HH:MM'만 뽑는다. 시각이 없던 값(날짜만·빈 값)은 fallback을 그대로 돌려준다.
 *
 * 왜 필요한가: 타임라인 드래그는 **날짜만** 바꾼다. 마감 18:00짜리 업무를 하루 미뤘더니
 * 00:00이 되어 있으면, 사람이 정한 적 없는 시각이 조용히 들어간 것이다.
 */
export function seoulTimeOf(value: DateValue, fallback = '18:00') {
  const iso = toIsoUtc(value)
  if (!iso) return fallback
  const source = typeof value === 'string' ? value.trim() : ''
  const hasTime = value instanceof Date || typeof value === 'number' || /(?:T|\s)\d{1,2}:\d{2}/.test(source)
  if (!hasTime) return fallback
  const { hour, minute } = seoulParts(new Date(iso))
  return `${hour}:${minute}`
}

/**
 * 일요일 시작 6주(42칸) 달력의 날짜 키 배열.
 *
 * CollaborationSuite.tsx의 `function monthCells`(일정 화면, 일요일 시작 42칸)와 **같은 규칙**이다.
 * 그쪽을 고치면 여기도 같이 고쳐야 한다 — 합치는 것은 일정 화면 회귀를 함께 끌고 오므로 별도 정리 대상이다.
 *
 * 같은 파일의 일지 격자(`const monthCells`)는 **다른 규칙**이다: 월요일 시작, 그 달만큼만 자라는 가변 길이,
 * 앞뒤 여백은 옆 달 날짜가 아니라 null. 셋이 같다고 적어 두면 다음 사람이 엉뚱한 격자를 고친다.
 */
export function monthGridKeys(year: number, monthIndex: number) {
  const first = new Date(Date.UTC(year, monthIndex, 1))
  const start = shiftDateKey(first.toISOString().slice(0, 10), -first.getUTCDay())
  return Array.from({ length: 42 }, (_, index) => shiftDateKey(start, index))
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

/**
 * 목록에서 쓰는 짧은 날짜.
 *
 * 사람은 "오늘 14:30"을 볼 때 날짜를 읽지 않는다. 그래서 오늘이면 시각만,
 * 어제면 "어제"를 붙이고, 그보다 오래되면 날짜만 남긴다. 해가 넘어가면
 * 연도를 붙인다 — 연도가 없으면 작년 8월 25일과 올해 8월 25일이 같아 보인다.
 *
 *   오늘      → 14:30
 *   어제      → 어제 14:30
 *   올해      → 8.25
 *   지난해    → 2025.8.25
 */
export function formatListDateTime(value: DateValue, now = new Date(), fallback = '—') {
  const iso = toIsoUtc(value, now)
  if (!iso) return typeof value === 'string' && value.trim() ? value : fallback
  const target = new Date(iso)
  const { year, month, day, hour, minute } = seoulParts(target)
  const todayKey = seoulDateKey(now)
  const targetKey = `${year}-${month}-${day}`

  if (targetKey === todayKey) return `${hour}:${minute}`
  if (targetKey === shiftDateKey(todayKey, -1)) return `어제 ${hour}:${minute}`

  const thisYear = todayKey.slice(0, 4)
  const shortMonth = String(Number(month))
  const shortDay = String(Number(day))
  return year === thisYear ? `${shortMonth}.${shortDay}` : `${year}.${shortMonth}.${shortDay}`
}

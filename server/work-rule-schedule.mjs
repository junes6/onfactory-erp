import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
/** 달력 화면과 같은 파일을 읽는다. 빨간 날 표시와 업무 생성이 어긋나면 둘 다 못 믿게 된다. */
const HOLIDAYS = require('../shared/korean-holidays.json').holidays

/**
 * 반복 업무의 일정 계산.
 *
 * 여기서 다루는 것은 "다음이 언제인가" 하나뿐이다. 업무를 만들거나 알림을 보내는 일은
 * 호출하는 쪽이 한다. 날짜 계산만 떼어 두면 달력을 눈으로 확인하는 테스트를 쓸 수 있다.
 *
 * 공휴일 규칙이 이 모듈의 핵심이다. "매월 말일 정산"이 추석에 걸렸을 때 앞당길지 미룰지
 * 건너뛸지는 회사마다 다르고, 우리가 대신 정할 수 없다. 규칙마다 고르게 한다.
 */

export const WORK_RULE_FREQUENCIES = Object.freeze(['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'])
export const WORK_RULE_MONTHLY_MODES = Object.freeze(['day-of-month', 'last-weekday', 'last-business-day'])
/** 공휴일과 겹쳤을 때: 그대로 / 앞당김 / 미룸 / 건너뜀 */
export const HOLIDAY_POLICIES = Object.freeze(['none', 'before', 'after', 'skip'])
export const ASSIGN_MODES = Object.freeze(['fixed', 'rotation'])

/** 이행률은 최근 12회로 본다. 그보다 짧으면 한 번 빠진 것이 과대하게 보인다. */
export const COMPLIANCE_WINDOW = 12

const pad = (value) => String(value).padStart(2, '0')
const isoOf = (date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
const parse = (dateKey) => new Date(`${dateKey}T00:00:00Z`)
const shiftDays = (dateKey, days) => {
  const date = parse(dateKey)
  date.setUTCDate(date.getUTCDate() + days)
  return isoOf(date)
}

export const holidayName = (dateKey) => HOLIDAYS[dateKey] ?? null
export const isWeekend = (dateKey) => [0, 6].includes(parse(dateKey).getUTCDay())
/** 쉬는 날 = 공휴일 또는 주말. 반복 업무는 근무일에 도는 것이 기본이다. */
export const isRestDay = (dateKey) => Boolean(HOLIDAYS[dateKey]) || isWeekend(dateKey)

/** 그 달의 마지막 날. */
export function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
}

/** 그 달의 마지막 특정 요일 (예: 마지막 금요일). */
export function lastWeekdayOfMonth(year, month, weekday) {
  const date = new Date(Date.UTC(year, month + 1, 0))
  while (date.getUTCDay() !== weekday) date.setUTCDate(date.getUTCDate() - 1)
  return isoOf(date)
}

/** 그 달의 마지막 영업일. 월말 정산·마감 보고가 실제로 걸리는 날이다. */
export function lastBusinessDayOfMonth(year, month) {
  const date = new Date(Date.UTC(year, month + 1, 0))
  while (isRestDay(isoOf(date))) date.setUTCDate(date.getUTCDate() - 1)
  return isoOf(date)
}

/**
 * 공휴일 정책을 적용한다.
 * @returns {{ date: string|null, moved: boolean, reason: string }} date가 null이면 이번 회차는 건너뛴다.
 */
export function applyHolidayPolicy(dateKey, policy = 'none') {
  if (policy === 'none' || !isRestDay(dateKey)) return { date: dateKey, moved: false, reason: '' }
  const label = holidayName(dateKey) ?? (isWeekend(dateKey) ? '주말' : '휴일')
  if (policy === 'skip') return { date: null, moved: false, reason: `${dateKey}이 ${label}이라 이번 회차를 건너뜁니다.` }

  const step = policy === 'before' ? -1 : 1
  let moved = dateKey
  // 연휴가 길어야 닷새다. 그보다 멀리 옮기면 원래 주기에서 벗어나므로 멈추고 그대로 둔다.
  for (let hop = 0; hop < 10; hop += 1) {
    moved = shiftDays(moved, step)
    if (!isRestDay(moved)) {
      return { date: moved, moved: true, reason: `${dateKey}이 ${label}이라 ${moved}로 ${policy === 'before' ? '앞당겼습니다' : '미뤘습니다'}.` }
    }
  }
  return { date: dateKey, moved: false, reason: `${dateKey} 앞뒤로 근무일을 찾지 못해 그대로 두었습니다.` }
}

/**
 * 다음 회차 날짜. 공휴일 정책은 여기서 보지 않는다 —
 * 주기는 원래 자리에서 세고, 옮기는 것은 만들 때 한 번만 한다.
 * 그래야 한 번 밀린 날짜가 다음 회차의 기준이 되어 주기가 통째로 밀리는 일이 없다.
 */
export function advanceRuleDate(rule, currentDate) {
  const interval = Number.isInteger(rule.interval) && rule.interval > 0 ? rule.interval : 1
  const date = parse(currentDate)

  switch (rule.frequency) {
    case 'daily':
      return shiftDays(currentDate, interval)
    case 'weekly':
      return shiftDays(currentDate, 7 * interval)
    case 'biweekly':
      return shiftDays(currentDate, 14 * interval)
    case 'quarterly':
    case 'yearly':
    case 'monthly': {
      const step = rule.frequency === 'quarterly' ? 3 * interval : rule.frequency === 'yearly' ? 12 * interval : interval
      const targetMonth = date.getUTCMonth() + step
      const year = date.getUTCFullYear() + Math.floor(targetMonth / 12)
      const month = ((targetMonth % 12) + 12) % 12
      const mode = rule.monthlyMode ?? 'day-of-month'
      if (mode === 'last-weekday') return lastWeekdayOfMonth(year, month, rule.weekday ?? 5)
      if (mode === 'last-business-day') return lastBusinessDayOfMonth(year, month)
      const day = Math.min(rule.monthDay ?? date.getUTCDate(), lastDayOfMonth(year, month))
      return `${year}-${pad(month + 1)}-${pad(day)}`
    }
    default:
      return shiftDays(currentDate, 1)
  }
}

/**
 * 이번 회차의 담당자. 고정이면 늘 같고, 순번이면 회차마다 돌아간다.
 * 순번 명단이 비면 고정 담당자로 되돌아간다 — 담당자 없는 업무를 만들지 않기 위해서다.
 */
export function ownerForOccurrence(rule, occurrenceIndex) {
  if (rule.assignMode !== 'rotation') return rule.ownerId
  const roster = Array.isArray(rule.rotation) ? rule.rotation.filter(Boolean) : []
  if (!roster.length) return rule.ownerId
  return roster[((occurrenceIndex % roster.length) + roster.length) % roster.length]
}

/**
 * 규칙의 이행률 (최근 COMPLIANCE_WINDOW회).
 *
 * 분모는 "생성된 회차 중 마감이 지난 것"이다. 아직 마감 전인 회차를 미이행으로 세면
 * 오늘 만든 규칙이 0%로 보인다.
 */
export function complianceRate(ruleId, tasks, { todayKey, window = COMPLIANCE_WINDOW } = {}) {
  const mine = (tasks ?? [])
    .filter((task) => task?.ruleId === ruleId && typeof task.ruleOccurrence === 'string')
    .sort((left, right) => right.ruleOccurrence.localeCompare(left.ruleOccurrence))
  const judged = mine.filter((task) => !todayKey || task.ruleOccurrence < todayKey).slice(0, window)
  if (!judged.length) return { rate: null, done: 0, total: 0, window }
  const done = judged.filter((task) => ['결재대기', '결재완료'].includes(task.status)).length
  return { rate: Math.round((done / judged.length) * 100) / 100, done, total: judged.length, window }
}

/** 체크리스트 정의를 업무에 붙일 항목으로 편다. */
export function expandChecklist(rule) {
  const items = Array.isArray(rule?.checklist) ? rule.checklist : []
  return items
    .map((item, index) => ({
      id: String(item?.id ?? `CK-${index + 1}`).slice(0, 40),
      label: String(item?.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
      done: false,
    }))
    .filter((item) => item.label)
    .slice(0, 30)
}

/** 체크리스트가 남아 있으면 완료 보고를 받지 않는다. 무엇이 남았는지도 함께 알려 준다. */
export function checklistBlockers(task) {
  const items = Array.isArray(task?.checklist) ? task.checklist : []
  return items.filter((item) => item?.done !== true).map((item) => item.label)
}

/**
 * 미착수 감시. 만든 지 얼마가 지났는데 아직 '업무요청'이면 담당자에게,
 * 더 지나면 관리자에게 올린다.
 * @returns 'none' | 'remind' | 'escalate'
 */
export function overdueStage(task, rule, nowMs) {
  if (!task || task.status !== '업무요청') return 'none'
  const createdMs = Date.parse(task.createdAt ?? '')
  if (!Number.isFinite(createdMs)) return 'none'
  const remindAfter = Number.isInteger(rule?.remindAfterMinutes) ? rule.remindAfterMinutes : 0
  const escalateAfter = Number.isInteger(rule?.escalateAfterMinutes) ? rule.escalateAfterMinutes : 0
  const elapsed = (nowMs - createdMs) / 60_000
  if (escalateAfter > 0 && elapsed >= escalateAfter) return 'escalate'
  if (remindAfter > 0 && elapsed >= remindAfter) return 'remind'
  return 'none'
}

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  advanceRuleDate,
  applyHolidayPolicy,
  checklistBlockers,
  complianceRate,
  expandChecklist,
  holidayName,
  isRestDay,
  lastBusinessDayOfMonth,
  lastWeekdayOfMonth,
  overdueStage,
  ownerForOccurrence,
} from './work-rule-schedule.mjs'

// ─────────────────────────── 주기 ───────────────────────────

test('일곱 가지 주기가 각각 다음 날짜를 낸다', () => {
  assert.equal(advanceRuleDate({ frequency: 'daily', interval: 1 }, '2026-09-04'), '2026-09-05')
  assert.equal(advanceRuleDate({ frequency: 'daily', interval: 3 }, '2026-09-04'), '2026-09-07')
  assert.equal(advanceRuleDate({ frequency: 'weekly', interval: 1 }, '2026-09-04'), '2026-09-11')
  assert.equal(advanceRuleDate({ frequency: 'biweekly', interval: 1 }, '2026-09-04'), '2026-09-18')
  assert.equal(advanceRuleDate({ frequency: 'monthly', interval: 1, monthDay: 10 }, '2026-09-10'), '2026-10-10')
  assert.equal(advanceRuleDate({ frequency: 'quarterly', interval: 1, monthDay: 1 }, '2026-01-01'), '2026-04-01')
  assert.equal(advanceRuleDate({ frequency: 'yearly', interval: 1, monthDay: 15 }, '2026-03-15'), '2027-03-15')
})

test('31일 규칙은 짧은 달에서 그 달 말일로 접힌다', () => {
  assert.equal(advanceRuleDate({ frequency: 'monthly', interval: 1, monthDay: 31 }, '2026-01-31'), '2026-02-28')
  assert.equal(advanceRuleDate({ frequency: 'monthly', interval: 1, monthDay: 31 }, '2026-03-31'), '2026-04-30')
})

test('매월 마지막 영업일은 주말·공휴일을 피해 앞으로 당겨진다', () => {
  // 2026-05-31은 일요일이라 마지막 영업일은 5-29(금).
  assert.equal(lastBusinessDayOfMonth(2026, 4), '2026-05-29')
  // 2026-08-31은 월요일 — 그대로 마지막 영업일.
  assert.equal(lastBusinessDayOfMonth(2026, 7), '2026-08-31')
  assert.equal(advanceRuleDate({ frequency: 'monthly', interval: 1, monthlyMode: 'last-business-day' }, '2026-05-29'), '2026-06-30')
})

test('매월 마지막 특정 요일을 찾는다', () => {
  assert.equal(lastWeekdayOfMonth(2026, 8, 5), '2026-09-25', '2026년 9월 마지막 금요일')
  assert.equal(advanceRuleDate({ frequency: 'monthly', interval: 1, monthlyMode: 'last-weekday', weekday: 5 }, '2026-09-25'), '2026-10-30')
})

// ─────────────────────────── 공휴일 ───────────────────────────

test('공휴일 데이터가 서버에서도 읽힌다', () => {
  assert.equal(holidayName('2026-09-25'), '추석')
  assert.equal(holidayName('2026-09-23'), null)
  assert.equal(isRestDay('2026-09-26'), true, '추석 연휴')
  assert.equal(isRestDay('2026-09-05'), true, '토요일도 쉬는 날이다')
  assert.equal(isRestDay('2026-09-04'), false)
})

test('공휴일 정책 — 그대로 / 앞당김 / 미룸 / 건너뜀', () => {
  const 추석 = '2026-09-25'
  assert.deepEqual(applyHolidayPolicy(추석, 'none'), { date: 추석, moved: false, reason: '' })

  const before = applyHolidayPolicy(추석, 'before')
  assert.equal(before.date, '2026-09-23', '추석 연휴 앞의 근무일까지 당긴다')
  assert.match(before.reason, /앞당겼습니다/)

  const after = applyHolidayPolicy(추석, 'after')
  assert.equal(after.date, '2026-09-28', '연휴와 주말을 모두 건너 다음 근무일로 미룬다')
  assert.match(after.reason, /미뤘습니다/)

  const skipped = applyHolidayPolicy(추석, 'skip')
  assert.equal(skipped.date, null)
  assert.match(skipped.reason, /건너뜁니다/)
})

test('평일이면 정책이 무엇이든 날짜를 건드리지 않는다', () => {
  for (const policy of ['none', 'before', 'after', 'skip']) {
    assert.equal(applyHolidayPolicy('2026-09-04', policy).date, '2026-09-04')
  }
})

test('밀린 날짜가 다음 회차의 기준이 되지 않는다', () => {
  // 매월 25일 규칙. 9월 25일은 추석이라 옮겨지지만, 10월 회차는 여전히 25일이어야 한다.
  const rule = { frequency: 'monthly', interval: 1, monthDay: 25, holidayPolicy: 'after' }
  const moved = applyHolidayPolicy('2026-09-25', rule.holidayPolicy)
  assert.equal(moved.date, '2026-09-28')
  assert.equal(advanceRuleDate(rule, '2026-09-25'), '2026-10-25', '주기는 원래 자리에서 센다')
})

// ─────────────────────────── 순번 배정 ───────────────────────────

test('순번 배정은 회차마다 담당자를 돌린다', () => {
  const rule = { assignMode: 'rotation', ownerId: 'A', rotation: ['A', 'B', 'C'] }
  assert.equal(ownerForOccurrence(rule, 0), 'A')
  assert.equal(ownerForOccurrence(rule, 1), 'B')
  assert.equal(ownerForOccurrence(rule, 2), 'C')
  assert.equal(ownerForOccurrence(rule, 3), 'A', '한 바퀴 돌면 처음으로')
})

test('순번 명단이 비면 고정 담당자로 되돌아간다 — 담당자 없는 업무를 만들지 않는다', () => {
  assert.equal(ownerForOccurrence({ assignMode: 'rotation', ownerId: 'A', rotation: [] }, 5), 'A')
  assert.equal(ownerForOccurrence({ assignMode: 'fixed', ownerId: 'A', rotation: ['B'] }, 5), 'A')
})

// ─────────────────────────── 체크리스트 ───────────────────────────

test('체크리스트는 규칙에서 펴지고, 남으면 완료 보고를 막는다', () => {
  const items = expandChecklist({ checklist: [{ label: '금속검출기 시험편 통과' }, { label: '기록지 서명' }, { label: '  ' }] })
  assert.equal(items.length, 2, '빈 항목은 버린다')
  assert.deepEqual(items.map((item) => item.done), [false, false])

  assert.deepEqual(checklistBlockers({ checklist: items }), ['금속검출기 시험편 통과', '기록지 서명'])
  assert.deepEqual(checklistBlockers({ checklist: items.map((item) => ({ ...item, done: true })) }), [])
  assert.deepEqual(checklistBlockers({}), [], '체크리스트가 없으면 막을 것도 없다')
})

// ─────────────────────────── 이행률 ───────────────────────────

test('이행률은 마감이 지난 회차만 센다 — 오늘 만든 규칙이 0%로 보이면 안 된다', () => {
  const tasks = [
    { ruleId: 'R1', ruleOccurrence: '2026-09-01', status: '결재완료' },
    { ruleId: 'R1', ruleOccurrence: '2026-09-02', status: '업무요청' },
    { ruleId: 'R1', ruleOccurrence: '2026-09-03', status: '결재대기' },
    { ruleId: 'R1', ruleOccurrence: '2026-09-10', status: '업무요청' },
    { ruleId: 'R2', ruleOccurrence: '2026-09-01', status: '업무요청' },
  ]
  const rate = complianceRate('R1', tasks, { todayKey: '2026-09-05' })
  assert.deepEqual({ done: rate.done, total: rate.total }, { done: 2, total: 3 }, '아직 마감 전인 9-10은 세지 않는다')
  assert.equal(rate.rate, 0.67)

  assert.equal(complianceRate('없는규칙', tasks, { todayKey: '2026-09-05' }).rate, null, '판단할 회차가 없으면 null이다')
})

test('이행률은 최근 12회만 본다', () => {
  const tasks = Array.from({ length: 20 }, (_, index) => ({
    ruleId: 'R1',
    ruleOccurrence: `2026-08-${String(index + 1).padStart(2, '0')}`,
    status: index < 8 ? '업무요청' : '결재완료',
  }))
  const rate = complianceRate('R1', tasks, { todayKey: '2026-09-05' })
  assert.equal(rate.total, 12)
  assert.equal(rate.done, 12, '최근 12회는 전부 완료된 구간이다')
})

// ─────────────────────────── 미이행 감시 ───────────────────────────

test('미착수는 담당자 알림 → 관리자 에스컬레이션 순으로 올라간다', () => {
  const rule = { remindAfterMinutes: 60, escalateAfterMinutes: 240 }
  const created = Date.parse('2026-09-04T00:00:00.000Z')
  const task = { status: '업무요청', createdAt: '2026-09-04T00:00:00.000Z' }

  assert.equal(overdueStage(task, rule, created + 30 * 60_000), 'none')
  assert.equal(overdueStage(task, rule, created + 90 * 60_000), 'remind')
  assert.equal(overdueStage(task, rule, created + 300 * 60_000), 'escalate')
  assert.equal(overdueStage({ ...task, status: '수행중' }, rule, created + 300 * 60_000), 'none', '착수했으면 감시를 멈춘다')
  assert.equal(overdueStage(task, {}, created + 999 * 60_000), 'none', '기준을 안 정한 규칙은 감시하지 않는다')
})

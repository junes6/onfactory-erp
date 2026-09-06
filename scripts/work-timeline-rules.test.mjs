import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { SCHEDULE_ERRORS } from '../server/work-item-schedule.mjs'
import { dayKeyDiff, monthGridKeys } from '../src/utils/dateTime.ts'
import {
  barAriaLabel, barDraftReadout, barRange, barTone, clampBar, clampBarEdge, followAnchor, groupBars, isWorkOverdue,
  previewBar, projectBarLabel, schedulePayload, scheduleBlockReason, shiftBar, timelineDays, workPeriodLabel,
  TIMELINE_LEAD_DAYS, TIMELINE_MAX_DAYS, SCHEDULE_ORDER_HINT,
} from '../src/utils/workTimeline.ts'

const timelineSource = await readFile(new URL('../src/components/WorkTimeline.tsx', import.meta.url), 'utf8')
const utilSource = await readFile(new URL('../src/utils/workTimeline.ts', import.meta.url), 'utf8')

/**
 * 타임라인 막대의 순수 규칙.
 *
 * 기준 시각은 한국 시간 2026년 9월 5일 오후 3시. 레거시 상대 문자열('오늘 18:00') 한 갈래를 빼면
 * 모든 단언이 시계와 무관하다 — 그 한 갈래도 now를 주입해 고정한다.
 */
const NOW = new Date('2026-09-05T06:00:00.000Z')
const TODAY = '2026-09-05'

const task = (overrides = {}) => ({
  id: 'W1', title: '냉장창고 점검', description: '', owner: '박지현', ownerId: 'U-PARK',
  requestedBy: '김서원', requesterId: 'U-ADMIN', due: '2026-09-10T09:00:00.000Z',
  priority: '보통', status: '수행중', category: '일반', ...overrides,
})

test('barRange: 시작일이 있으면 그대로, 없으면 만든 날에서 시작한다', () => {
  const explicit = barRange(task({ startAt: '2026-09-01T00:00:00.000Z' }), NOW)
  assert.deepEqual(explicit, { startKey: '2026-09-01', endKey: '2026-09-10', startUnset: false })

  const fromCreated = barRange(task({ createdAt: '2026-09-02T00:00:00.000Z' }), NOW)
  assert.deepEqual(fromCreated, { startKey: '2026-09-02', endKey: '2026-09-10', startUnset: true })

  // 만든 날이 마감보다 뒤면(옮겨 온 업무) 하루짜리 막대로 둔다 — 거꾸로 된 막대를 그리지 않는다.
  const createdLate = barRange(task({ createdAt: '2026-09-20T00:00:00.000Z' }), NOW)
  assert.deepEqual(createdLate, { startKey: '2026-09-09', endKey: '2026-09-10', startUnset: true })

  // 만든 날조차 없으면 마감 하루 전.
  assert.equal(barRange(task(), NOW).startKey, '2026-09-09')

  // 마감을 못 읽으면 막대를 지어내지 않는다.
  assert.equal(barRange(task({ due: '' }), NOW), null)

  // 레거시 상대 문자열도 같은 규칙으로 읽는다(now를 주입한다).
  assert.equal(barRange(task({ due: '오늘 18:00' }), NOW).endKey, TODAY)
})

test('barTone: 완료는 마감이 지나도 지연이 아니다', () => {
  assert.equal(barTone(task({ status: '결재완료', due: '2026-08-01T09:00:00.000Z' }), NOW), 'done')
  assert.equal(barTone(task({ due: '2026-09-04T09:00:00.000Z' }), NOW), 'overdue')
  assert.equal(barTone(task({ due: '2026-09-06T09:00:00.000Z' }), NOW), 'normal')
})

test('clampBar: 창 안이면 자리, 걸치면 잘린 표시, 완전히 밖이면 null', () => {
  const days = timelineDays(TODAY, 14)
  assert.deepEqual(clampBar({ startKey: '2026-09-07', endKey: '2026-09-09', startUnset: false }, days), { from: 2, span: 3, clippedStart: false, clippedEnd: false })
  const left = clampBar({ startKey: '2026-09-01', endKey: '2026-09-06', startUnset: false }, days)
  assert.equal(left.from, 0)
  assert.equal(left.span, 2)
  assert.equal(left.clippedStart, true)
  const right = clampBar({ startKey: '2026-09-17', endKey: '2026-09-30', startUnset: false }, days)
  assert.equal(right.clippedEnd, true)
  assert.equal(clampBar({ startKey: '2026-09-20', endKey: '2026-09-22', startUnset: false }, days), null)
})

test('shiftBar: 최소 길이 1일을 지키고, 없는 시작일은 끌리지 않는다', () => {
  const range = { startKey: '2026-09-07', endKey: '2026-09-09', startUnset: false }
  assert.deepEqual(shiftBar(range, 'move', 7), { startKey: '2026-09-14', endKey: '2026-09-16', startUnset: false })
  // 마감을 시작보다 앞으로 끌어도 하루는 남는다(서버 SCHEDULE_ORDER_INVALID의 거울).
  assert.deepEqual(shiftBar(range, 'end', -10), { startKey: '2026-09-07', endKey: '2026-09-07', startUnset: false })
  assert.deepEqual(shiftBar(range, 'start', 999), { startKey: '2026-09-09', endKey: '2026-09-09', startUnset: false })
  const assumed = { startKey: '2026-09-07', endKey: '2026-09-09', startUnset: true }
  assert.deepEqual(shiftBar(assumed, 'start', 3), assumed, '추론한 시작일은 끌어서 확정되지 않는다')
})

test('추론한 시작일은 마감을 막지 못한다 — 보내지도 않는 값이다', () => {
  // 실데이터에서 가장 흔한 모양(15건 중 10건): startAt도 createdAt도 없어 왼쪽 끝이 '마감 하루 전'이다.
  // 예전에는 마감 손잡이가 그 자리에서 얼어붙고 '시작일은 마감일보다 뒤일 수 없습니다'라고 말했다 —
  // 같은 막대가 '시작일 미정'이라 읽어 주는 그 날짜를 근거로. 서버에는 시작일이 없으므로
  // { due }만 담긴 그 요청은 그대로 저장된다(scheduleViolation({ startAt: null, due })은 null이다).
  const item = task({ due: '2026-09-15T09:00:00.000Z' })
  const stored = barRange(item, NOW)
  assert.deepEqual(stored, { startKey: '2026-09-14', endKey: '2026-09-15', startUnset: true })
  assert.equal(shiftBar(stored, 'end', -5).endKey, '2026-09-10')
  assert.equal(shiftBar(stored, 'end', -5).startKey, '2026-09-09', '왼쪽 끝은 막는 대신 barRange와 같은 규칙으로 다시 계산한다')

  // 누를 때마다 반드시 하루가 움직인다 — 멈추는 갈래가 있으면 그 자리에서 안내 문장이 나온다.
  let range = stored
  for (let press = 0; press < 6; press += 1) {
    for (const mode of ['end', 'move']) {
      const next = shiftBar(range, mode, -1)
      assert.notEqual(next.endKey, range.endKey, `${press + 1}번째 ←(${mode})에서 마감이 멈췄다`)
      assert.ok(next.startKey <= next.endKey, '거꾸로 된 범위를 만들지 않는다')
      range = next
    }
  }
  assert.equal(range.endKey, '2026-09-03')
  // 보내는 것은 마감뿐이다 — 애초에 클라이언트가 지킬 시작일이 없다.
  assert.deepEqual(schedulePayload(item, range), { due: '2026-09-03T09:00:00.000Z' })
})

test('미리보기 막대는 저장한 뒤에 남을 그 막대다', () => {
  // createdAt이 있는 업무: 왼쪽 끝은 그 자리에 남는다(회귀: 미리보기가 4일이라 말하고 저장은 5일이었다).
  const dated = task({ createdAt: '2026-09-14T00:00:00.000Z', due: '2026-09-17T09:00:00.000Z' })
  const storedDated = barRange(dated, NOW)
  const movedDated = previewBar(dated, storedDated, 'move', 1, NOW)
  assert.deepEqual(movedDated, { startKey: '2026-09-14', endKey: '2026-09-18', startUnset: true })
  assert.deepEqual(movedDated, barRange({ ...dated, due: schedulePayload(dated, movedDated).due }, NOW))

  // createdAt조차 없는 업무: 왼쪽 끝은 마감을 따라온다 — barRange가 저장 직후에 그렇게 다시 계산하기 때문이다.
  const bare = task({ due: '2026-09-15T09:00:00.000Z' })
  const storedBare = barRange(bare, NOW)
  for (const mode of ['move', 'end']) {
    for (const step of [1, 3, -1, -4]) {
      const next = previewBar(bare, storedBare, mode, step, NOW)
      assert.deepEqual(next, barRange({ ...bare, due: schedulePayload(bare, next).due }, NOW), `${mode} ${step}일 미리보기가 저장 결과와 다르다`)
    }
  }
  // 읽어 주는 '· N일'도 그래서 맞는 수를 말한다.
  assert.match(barDraftReadout(bare, previewBar(bare, storedBare, 'move', 1, NOW)), /시작일 미정, 마감 9\.16 · 2일/)

  // 사람이 정한 시작일에는 아무것도 더하지 않는다 — shiftBar 그대로다.
  const explicit = task({ startAt: '2026-09-07T00:00:00.000Z' })
  const storedExplicit = barRange(explicit, NOW)
  assert.deepEqual(previewBar(explicit, storedExplicit, 'move', 2, NOW), shiftBar(storedExplicit, 'move', 2))
  assert.deepEqual(previewBar(explicit, storedExplicit, 'end', -99, NOW), shiftBar(storedExplicit, 'end', -99))
})

test('schedulePayload: 날짜만 바꾸고 시각은 보존한다', () => {
  const item = task({ due: '2026-09-10T09:00:00.000Z' }) // KST 18:00
  const moved = schedulePayload(item, { startKey: '2026-09-13', endKey: '2026-09-14', startUnset: false })
  assert.equal(moved.due, '2026-09-14T09:00:00.000Z', '18:00 마감은 옮겨도 18:00이다')
  assert.equal(moved.startAt, '2026-09-13T00:00:00.000Z', '시각이 없던 시작일은 09:00에서 시작한다')

  // 날짜만 있던 레거시 마감은 '오늘까지'라는 사람 말에 맞춰 18:00을 얻는다.
  assert.equal(schedulePayload(task({ due: '2026-09-10' }), { startKey: '2026-09-13', endKey: '2026-09-14', startUnset: false }).due, '2026-09-14T09:00:00.000Z')

  // 추론한 시작일은 서버로 보내지 않는다 — 보내는 순간 사람이 정한 적 없는 날짜가 값이 된다.
  const assumed = schedulePayload(item, { startKey: '2026-09-13', endKey: '2026-09-14', startUnset: true })
  assert.equal('startAt' in assumed, false)
})

test('scheduleBlockReason: 화면의 사유와 서버의 거절 문장이 글자 그대로 같다', () => {
  assert.equal(scheduleBlockReason(task({ status: '결재완료' }), 'U-ADMIN', true), SCHEDULE_ERRORS.LOCKED.message)
  assert.equal(scheduleBlockReason(task(), 'U-PARK', false), SCHEDULE_ERRORS.FORBIDDEN.message)
  assert.equal(scheduleBlockReason(task(), 'U-ADMIN', false), '', '지시한 사람은 바꿀 수 있다')
  assert.equal(scheduleBlockReason(task(), 'U-PARK', true), '', '관리자는 바꿀 수 있다')
  // 두 사유가 겹치는 막대(남의, 완료된 업무)에서 화면과 서버가 같은 쪽을 먼저 말한다.
  // 라우트는 권한(403)을 먼저 보고 상태(409)를 나중에 본다 — 순서가 갈리면 같은 사실이 두 문장이 된다.
  assert.equal(scheduleBlockReason(task({ status: '결재완료' }), 'U-PARK', false), SCHEDULE_ERRORS.FORBIDDEN.message)
})

test('라우트도 권한을 먼저 보고 상태를 나중에 본다 — 순서가 화면과 같다', async () => {
  const routeSource = await readFile(new URL('../server/work-item-schedule.mjs', import.meta.url), 'utf8')
  const forbiddenAt = routeSource.indexOf('SCHEDULE_ERRORS.FORBIDDEN })')
  const lockedAt = routeSource.indexOf('SCHEDULE_ERRORS.LOCKED })')
  assert.ok(forbiddenAt > 0 && lockedAt > 0, '두 거절이 라우트에 있다')
  assert.ok(forbiddenAt < lockedAt, '권한(403)이 상태(409)보다 먼저다 — scheduleBlockReason과 같은 순서')
})

test('timelineDays: 요청한 만큼 주되 상한을 넘기지 않고 달 경계를 넘어간다', () => {
  const days = timelineDays(TODAY, 28)
  assert.equal(days.length, 28)
  assert.equal(days[0], TODAY)
  assert.equal(days.at(-1), '2026-10-02')
  assert.equal(timelineDays(TODAY, 9_999).length, TIMELINE_MAX_DAYS)
})

test('groupBars: 라벨 가나다순, 이름 없는 묶음은 맨 뒤', () => {
  const rows = [
    task({ id: 'A', owner: '오태식', ownerId: 'U-OH' }),
    task({ id: 'B', owner: '박지현', ownerId: 'U-PARK' }),
    task({ id: 'C', owner: '', ownerId: '' }),
  ]
  assert.deepEqual(groupBars(rows, 'owner').map((group) => group.label), ['박지현', '오태식', '담당자 미정'])

  const projectRows = [
    task({ id: 'P', projectId: 'PRJ-1' }),
    task({ id: 'C1', projectId: 'PRJ-1', parentId: 'P' }),
    task({ id: 'X' }),
  ]
  const grouped = groupBars(projectRows, 'project', { 'PRJ-1': '가공 라인 증설' })
  assert.deepEqual(grouped.map((group) => group.label), ['가공 라인 증설', '프로젝트 미지정'])
  assert.deepEqual(grouped[0].rows.map((row) => row.id), ['P', 'C1'], '자식은 상위 바로 아래에 붙는다')
  // 이름을 못 받은 프로젝트를 '미지정'으로 적으면 서로 다른 두 묶음이 같은 이름이 된다.
  assert.equal(groupBars([task({ id: 'P', projectId: 'PRJ-9' })], 'project').at(0).label, '프로젝트 PRJ-9')
})

test('프로젝트를 부르는 이름은 한 함수에서만 나온다 — 필터 select도 같은 말을 한다', () => {
  /*
   * 필터 바의 프로젝트 select가 이름 없는 프로젝트를 '프로젝트 미지정'이라 적던 자리를 고정한다.
   * 그 option의 값은 진짜 프로젝트 id라서, 고르면 '그 프로젝트의 업무만' 걸린다 — 라벨이 정반대를 말했다.
   * 두 사실은 서로 다른 이름을 가져야 한다: id가 없다(미지정) / id는 있는데 이름을 못 받았다(비공개 프로젝트).
   */
  assert.equal(projectBarLabel('', {}), '프로젝트 미지정')
  assert.equal(projectBarLabel('', { 'PRJ-1': '가공 라인 증설' }), '프로젝트 미지정')
  assert.equal(projectBarLabel('PRJ-1', { 'PRJ-1': '가공 라인 증설' }), '가공 라인 증설')
  assert.equal(projectBarLabel('PRJ-GHOST'), '프로젝트 PRJ-GHOST')
  assert.notEqual(projectBarLabel('PRJ-A'), projectBarLabel('PRJ-B'), '이름 없는 둘이 같은 줄로 겹치지 않는다')
})

test('읽어 주는 문장은 눈에 보이는 것과 같은 것을 말한다', () => {
  const item = task({ startAt: '2026-09-06T00:00:00.000Z' })
  const range = barRange(item, NOW)
  assert.equal(barAriaLabel(item, range), '냉장창고 점검, 박지현, 9.6부터 9.10까지, 진행 중')
  assert.match(barDraftReadout(item, range), /^냉장창고 점검 — 시작 9\.6, 마감 9\.10 · 5일\. 저장하려면 Enter, 되돌리려면 Esc\.$/)
  assert.match(barAriaLabel(task(), barRange(task(), NOW)), /시작일 미정, 9\.10 마감/)
})

test('SCHEDULE_ORDER_HINT도 서버 문장과 글자 그대로 같다', () => {
  // 형제 문장(LOCKED·FORBIDDEN)은 위에서 대조된다. 이 하나만 빠져 있으면 셋 중 하나가 조용히 갈린다.
  assert.equal(SCHEDULE_ORDER_HINT, SCHEDULE_ERRORS.ORDER.message)
})

test('마감 지연은 날짜가 아니라 순간으로 센다 — 요약줄·카드·막대가 한 판정을 쓴다', async () => {
  // 한국 시간 9월 7일 01:27, 마감은 같은 날 00:30. 날짜 키로만 보면 '오늘'이라 지연이 아닌데
  // 같은 화면 위 요약줄('N 마감 지연')과 보드 카드의 '지연' 딱지는 이미 지연으로 센다.
  // 그동안 머리말은 '1 마감 지연'인데 빨간 막대는 하나도 없는 화면이 만들어졌다.
  const now = new Date('2026-09-06T16:27:00.000Z')
  const justPassed = task({ due: '2026-09-06T15:30:00.000Z' })
  assert.equal(isWorkOverdue(justPassed, now), true)
  assert.equal(barTone(justPassed, now), 'overdue')
  // 오늘 저녁 마감은 아직 지연이 아니다.
  assert.equal(barTone(task({ due: '2026-09-07T09:00:00.000Z' }), now), 'normal')
  // 완료는 마감이 지나도 지연이 아니다 — 두 판정이 같은 예외를 쓴다.
  const closed = task({ status: '결재완료', due: '2026-08-01T09:00:00.000Z' })
  assert.equal(isWorkOverdue(closed, now), false)
  assert.equal(barTone(closed, now), 'done')
  // 읽을 수 없는 마감은 지연이 아니다(막대 자체가 없다).
  assert.equal(isWorkOverdue(task({ due: '' }), now), false)

  // 화면 쪽도 이 한 함수를 부른다 — 두 번째 판정을 옆에 적으면 다음 사람이 어느 쪽을 고칠지 알 수 없다.
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(app, /const isOverdue = \(item: WorkItem\) => isWorkOverdue\(item\)/)
  assert.doesNotMatch(app, /dueAt < Date\.now\(\)/, '요약줄이 자기만의 마감 판정을 다시 만들지 않는다')
})

test('clampBarEdge: 편집 중인 막대는 창 밖으로 나가도 창 끝에 남는다', () => {
  const days = timelineDays(TODAY, 14)
  const after = { startKey: '2026-09-25', endKey: '2026-09-27', startUnset: false }
  const before = { startKey: '2026-08-01', endKey: '2026-08-03', startUnset: false }
  // 저장된 막대는 여전히 사라진다 — '이 기간 이후' 한 줄로 말하는 편이 정확하다.
  assert.equal(clampBar(after, days), null)
  assert.deepEqual(clampBarEdge(after, days), { from: 13, span: 1, clippedStart: false, clippedEnd: true })
  assert.deepEqual(clampBarEdge(before, days), { from: 0, span: 1, clippedStart: true, clippedEnd: false })
  // 창 안이면 clampBar와 같은 답이다.
  const inside = { startKey: '2026-09-07', endKey: '2026-09-09', startUnset: false }
  assert.deepEqual(clampBarEdge(inside, days), clampBar(inside, days))
})

test('followAnchor: 방향키를 계속 눌러도 편집 중인 막대는 창 안에 남는다', () => {
  let anchor = TODAY
  let days = timelineDays(anchor, 28)
  // 창 마지막 열에 걸친 하루짜리 막대에서 Shift+→(7일)를 세 번. 창이 따라오지 않으면 두 번째에 이미 언마운트된다.
  let range = { startKey: days.at(-1), endKey: days.at(-1), startUnset: false }
  for (let press = 0; press < 3; press += 1) {
    range = shiftBar(range, 'move', 7)
    const next = followAnchor(range, days)
    if (next) { anchor = next; days = timelineDays(anchor, 28) }
    assert.notEqual(clampBar(range, days), null, `${press + 1}번째 누름에서 막대가 창 밖으로 나갔다`)
  }
  // 창 안이면 창을 움직이지 않는다 — 한 칸 옮길 때마다 화면이 흔들리면 읽을 수 없다.
  assert.equal(followAnchor({ startKey: days[3], endKey: days[4], startUnset: false }, days), '')
})

test('workPeriodLabel: 기간 한 줄의 두 끝은 같은 표기다', () => {
  assert.equal(workPeriodLabel(task({ startAt: '2026-09-06T00:00:00.000Z' }), NOW), '9.6 → 9.10')
  // 추론한 시작일을 값처럼 적지 않는다.
  assert.equal(workPeriodLabel(task({ createdAt: '2026-09-02T00:00:00.000Z' }), NOW), '시작일 미정 → 9.10')
  assert.equal(workPeriodLabel(task({ due: '' }), NOW), '기간 미정')
  // 가까운 날짜도 요일 이름으로 새지 않는다(formatWorkDue라면 '토요일'이 된다).
  assert.match(workPeriodLabel(task({ startAt: '2026-09-05T00:00:00.000Z', due: '2026-09-06T09:00:00.000Z' }), NOW), /^9\.5 → 9\.6$/)
  // 오늘 마감이면 시각까지 말한다 — 목록이 '오늘 18:00'이라고 아는 사실이 드로어에서만 사라지면
  // 오늘 안에 무엇이 먼저인지 정할 근거가 화면에서 없어진다.
  assert.equal(workPeriodLabel(task({ startAt: '2026-09-01T00:00:00.000Z', due: '2026-09-05T09:00:00.000Z' }), NOW), '9.1 → 9.5 18:00')
  // 시각이 없던 마감에 시각을 지어내지는 않는다.
  assert.equal(workPeriodLabel(task({ due: '2026-09-05' }), NOW), '시작일 미정 → 9.5')
})

test('monthGridKeys: 일요일에서 시작하는 42칸이고 그 달을 모두 담는다', () => {
  const keys = monthGridKeys(2026, 8) // 2026년 9월
  assert.equal(keys.length, 42, '6주 × 7일')
  assert.equal(new Date(`${keys[0]}T00:00:00Z`).getUTCDay(), 0, '첫 칸은 일요일')
  assert.equal(keys[0], '2026-08-30')
  assert.equal(keys.at(-1), '2026-10-10')
  assert.ok(keys.includes('2026-09-01') && keys.includes('2026-09-30'), '그 달의 첫날과 마지막 날이 들어 있다')
  // 칸 사이에 구멍이 없다 — 달력이 하루를 건너뛰면 그날 마감은 어디에도 그려지지 않는다.
  for (let index = 1; index < keys.length; index += 1) {
    assert.equal(dayKeyDiff(keys[index - 1], keys[index]), 1, `${keys[index - 1]} 다음이 ${keys[index]}가 아니다`)
  }
})

test('편집 미리보기는 그 막대를 떠나는 순간 끝난다', () => {
  // 왜 소스 대조인가: 이 저장소에는 React를 띄우는 시험 장치가 없다(scripts/workflow-ux.test.mjs와 같은 방식).
  // Esc를 누르지 않고 딴 데를 클릭하는 것은 평범한 취소다. 그때 미리보기가 남으면 캔버스는
  // 아무도 저장하지 않은 기간을 두 달 뒤 창에까지 창 끝 한 칸으로 계속 그린다.
  assert.equal((timelineSource.match(/onBlur=\{\(event\) => onBarBlur\(event, item, stored\)\}/g) ?? []).length, 3, '손잡이 둘과 몸통 셋 다 붙는다')
  assert.match(timelineSource, /if \(draft\?\.id !== item\.id \|\| pendingId === item\.id\) return/, '남의 행과 요청 중인 행은 건드리지 않는다')
  assert.match(timelineSource, /bar\.contains\(event\.relatedTarget\)/, '같은 막대 안의 이동은 취소가 아니다')
  // 창을 옮기는 조작도 편집을 접는다.
  assert.match(timelineSource, /const panBy = \(days: number\) => \{ cancelDraft\(\)/)
  assert.match(timelineSource, /const jumpTo = \(dateKey: string\) => \{ cancelDraft\(\)/)
  // 목록에서 그 행이 사라져도 접는다(범위 필터·SSE 갱신).
  assert.match(timelineSource, /if \(draft && !items\.some\(\(item\) => item\.id === draft\.id\)\)/)
})

test('한 행의 편집이 다른 행의 상세 열기를 막지 않는다', () => {
  // 좁은 화면·터치에서는 모든 막대가 dragEnabled=false다 — 컴포넌트 전체의 draft를 보면
  // 방향키 한 번이 그 표면의 유일한 길(탭해서 드로어)을 통째로 닫는다.
  assert.match(timelineSource, /if \(!dragEnabled && draft\?\.id !== item\.id\) onOpen\(item\.id\)/)
  assert.doesNotMatch(timelineSource, /!dragEnabled && !draft/)
})

test('한 행의 편집이 다른 행의 드래그도 막지 않는다', () => {
  // 마우스로 다른 행의 막대를 누르는 순서는 pointerdown → mousedown → 포커스 이동 → blur다.
  // blur가 컴포넌트 전체의 dragRef를 비우면 방금 시작한 그 드래그가 첫 프레임에 죽는다 —
  // 끌어도 막대가 안 움직이고, 놓아도 저장되지 않고, 상세조차 열리지 않는다(endDrag가 먼저 돌아간다).
  const start = timelineSource.indexOf('const onBarBlur =')
  const blur = timelineSource.slice(start, timelineSource.indexOf('useEffect(', start))
  assert.ok(start > 0 && blur.length > 0, 'onBarBlur를 찾았다')
  assert.match(blur, /if \(dragRef\.current\?\.id === item\.id\) dragRef\.current = null/, '자기 행의 드래그만 놓는다')
  assert.doesNotMatch(blur, /cancelDraft\(\)/, '컴포넌트 전체를 접는 취소를 부르지 않는다')
  assert.equal((blur.match(/dragRef\.current = null/g) ?? []).length, 1, '조건 없는 정리가 남아 있지 않다')
  // 창을 옮기는 두 조작에서는 지금도 통째로 접는다 — 그때는 시작 중인 드래그가 있을 수 없다.
  assert.match(timelineSource, /const panBy = \(days: number\) => \{ cancelDraft\(\)/)
})

test('손잡이를 그냥 한 번 누르는 것은 드로어를 열지 않는다', () => {
  // 손잡이의 평범한 클릭은 '←/→로 밀려고 잡는' 동작이다. 거기서 드로어가 열리면
  // 포커스가 대화상자로 끌려가 방금 잡은 그 막대가 뒤로 닫힌다 — 키보드 경로의 첫 걸음이 그 경로를 닫는다.
  assert.match(timelineSource, /if \(drag\.mode === 'move'\) onOpen\(item\.id\)/)
})

test('막대를 미는 두 길이 같은 미리보기를 쓴다', () => {
  // 드래그와 방향키가 서로 다른 함수로 갈리면 '· N일'과 왼쪽 끝이 한쪽에서만 맞는다.
  assert.match(timelineSource, /range: previewBar\(item, drag\.base, drag\.mode, Math\.round\(delta \/ drag\.cellPx\)\)/)
  assert.match(timelineSource, /const next = previewBar\(item, base, mode, step\)/)
  assert.doesNotMatch(timelineSource, /shiftBar\(/, '산술만 하는 함수로 되돌아가면 추론한 시작일이 다시 얼어붙는다')
  // 시작일 미정 막대는 '시작일은 마감일보다 뒤일 수 없습니다'를 말하지 않는다 — 그 막대에는 시작일이 없다.
  assert.match(timelineSource, /if \(!base\.startUnset\) setStatus\(SCHEDULE_ORDER_HINT\)/)
})

test('왼쪽 버튼만 기간을 옮기고, Space는 Enter와 같이 답한다', () => {
  // 가운데 버튼으로 끌면 실제로 저장됐고, 오른쪽 버튼은 컨텍스트 메뉴 뒤에서 드로어를 열었다.
  const startDrag = timelineSource.slice(timelineSource.indexOf('const startDrag ='), timelineSource.indexOf('const moveDrag ='))
  const guardAt = startDrag.indexOf('if (event.button !== 0) return')
  const captureAt = startDrag.indexOf('setPointerCapture')
  assert.ok(guardAt > 0 && captureAt > 0 && guardAt < captureAt, '캡처를 쥐기 전에 어떤 버튼인지 본다')
  // 같은 컨트롤이 좁은 화면에서는 Space에 열리고 넓은 화면에서는 조용히 무시하던 자리다.
  assert.match(timelineSource, /if \(event\.key === 'Enter' \|\| event\.key === ' '\)/)
  assert.match(timelineSource, /const KEY_SHORTCUTS = '[^']* Enter Space Escape'/, '답하는 키만, 답하는 키는 모두 적는다')
})

test('한 행의 저장이 다른 행의 편집을 지우지 않는다', () => {
  // A행을 놓아 요청이 도는 동안 B행을 방향키로 옮기면, A의 응답이 B의 미리보기와 진행 표시를 함께 지웠다.
  const cleanup = timelineSource.slice(timelineSource.indexOf('} finally {'), timelineSource.indexOf('const cancelDrag ='))
  assert.match(cleanup, /setPendingId\(\(current\) => current === item\.id \? '' : current\)/)
  assert.match(cleanup, /setDraft\(\(current\) => current\?\.id === item\.id \? null : current\)/)
})

test('쓰는 곳 없는 공개 표면을 남기지 않는다', () => {
  // 다른 R16 컴포넌트(SubtaskList·ThreadPanel·TemplatePicker·WebhookSettings)와 같은 모양 — 이름 있는 내보내기 하나.
  assert.doesNotMatch(timelineSource, /export default/)
  assert.doesNotMatch(utilSource, /export const PROJECT_UNASSIGNED_LABEL/)
  assert.doesNotMatch(utilSource, /export const barSpanDays/)
})

test('서버가 거절한 문장은 캔버스 안에서도 들린다', async () => {
  // 미리보기가 이유 없이 사라지면 캔버스 안에서 키보드로 옮기던 사람에게는 아무 일도 없었던 것과 같다.
  // 문장은 새로 짓지 않는다 — 토스트가 읽는 그 문장을 그대로 상태 줄에도 싣는다.
  assert.match(timelineSource, /setStatus\(saved\.ok \? changed : \(saved\.message \?\? ''\)\)/)
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(app, /const message = body\.error\?\.message \|\| '업무 기간을 바꾸지 못했습니다\.'/)
  assert.match(app, /return \{ ok: false, message \}/)
  // 드로어도 같은 문장을 받는다. 터치·좁은 화면에는 손잡이가 없어 이 칸이 기간을 바꾸는 유일한 길인데,
  // 사유가 토스트로만 지나가면 거절된 날짜가 그대로 든 칸 둘과 아무 말 없는 화면만 남는다.
  assert.match(app, /const saved = await onSchedule\(drawerItem\.id, \{ due, startAt \}\)\s*\n\s*if \(!saved\.ok\) setScheduleHint\(saved\.message \?\? ''\)/)
})

test('넓힐 범위가 없는 사람에게 넓히라고 하지 않는다', () => {
  // 전체 범위에서 0건인 사람에게 '범위를 넓히면'은 화면에 없는 버튼을 가리키는 말이 된다.
  const empty = timelineSource.slice(
    timelineSource.indexOf('{items.length === 0 && <div className="empty-state">'),
    timelineSource.indexOf('이 기간에 걸치는 업무가 없습니다'),
  )
  assert.ok(empty.length > 0, '빈 상태 블록을 찾지 못하면 아래 단언이 조용히 통과한다')
  /*
   * 제목도 본문과 같은 축으로 갈린다. 조건이 하나도 없는 화면에서 '이 조건에 맞는 업무가 없습니다'는
   * 있지도 않은 조건을 가리키고, 바로 아래 줄은 '업무를 지시하면…'이라 두 줄이 서로 다른 이야기를 한다.
   * 조건 때문에 빈 경우의 두 문장은 목록 보기와 **같은 상수**에서 나온다(한 절 안에서 두 표면이 한 말을 한다).
   */
  assert.match(empty, /filtered \? WORK_EMPTY_FILTERED_TITLE : '아직 기간이 있는 업무가 없습니다'/)
  assert.ok(empty.indexOf('{filtered') >= 0 && empty.indexOf('{filtered') < empty.indexOf('? <p>{WORK_EMPTY_FILTERED_HINT}'), '두 번째 줄도 버튼과 같은 조건을 본다')
  assert.match(empty, /업무를 지시하면 여기에 기간 막대로 나타납니다/)
})

test('시작일 칸의 알 수 없는 값은 조용히 지워지지 않는다', async () => {
  // date 칸은 다섯·여섯 자리 연도도 담는다. seoulLocalToUtcIso는 그런 값에 null을 주고,
  // 서버에서 startAt: null은 '시작일을 지워라'라는 뜻이다 — 오타 하나가 저장돼 있던 시작일을 지우고
  // 화면은 그것을 '업무 기간을 바꿨습니다'라고 부른다. 마감일 칸에는 이미 있던 문을 시작일에도 낸다.
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(app, /if \(startDraft && !startAt\) \{ setScheduleHint\('시작일을 확인해 주세요\.'\); return \}/)
  assert.match(app, /if \(startLocal && !startAt\) \{ setError\('시작일을 확인해 주세요\.'\); return \}/)
  // 없는 이름을 가리키는 주석을 남기지 않는다 — 배열 문은 scheduleArrayViolation이다.
  assert.doesNotMatch(app, /scheduleOrderViolation/)
  assert.match(app, /scheduleArrayViolation/)
})

test('가로로 밀어도 이름 칸과 묶음 이름은 남는다', async () => {
  const css = await readFile(new URL('../src/components/WorkViews.css', import.meta.url), 'utf8')
  // 그리드 상자가 열의 합만큼 넓지 않으면 sticky는 보이는 폭 안에서만 붙는다 —
  // 8주 창 실측(scrollWidth 2440 / clientWidth 1248)에서 끝까지 밀면 이름 칸이 화면 밖 −128px에 있었다.
  assert.match(css, /\.work-timeline-grid \{[^}]*min-width: max-content;/)
  // 담당자별로 볼 때 그 사람 이름은 묶음 제목 줄에만 있다. 그것까지 흘러 나가면 주인 없는 막대만 남는다.
  assert.match(css, /\.work-timeline-group > span \{[^}]*position: sticky;/)
  assert.match(timelineSource, /<h3 className="work-timeline-group"><span>/)
  // 읽어 주는 줄이 접히면서 조작 줄이 두 줄이 되면 캔버스가 통째로 밀린다(800px 실측 46 → 74px).
  // 그 밀림은 mousedown과 mouseup 사이에 일어나 그 클릭이 겨눈 막대를 빗나가게 만든다.
  assert.match(css, /\.work-timeline-readout \{[^}]*flex: 1 0 100%;[^}]*min-height: calc\(var\(--font-13\) \* 3\);/)
})

test('지연 막대는 공휴일 칸 위에서도 남고, 포커스는 첫 방향키 전에 보인다', async () => {
  const css = await readFile(new URL('../src/components/WorkViews.css', import.meta.url), 'utf8')
  // 공휴일 칸과 지연 막대가 같은 토큰으로 칠해진다(달력이 같은 출처를 쓰므로 그 토큰은 그대로 둔다).
  // 테두리가 없으면 추석 세 칸을 지나는 막대는 그 자리에서 배경과 같은 색이 되어 '마감 초과'가 사라졌다.
  assert.match(css, /\.work-timeline-day\.kind-holiday \{ background: var\(--color-danger-soft\); \}/)
  assert.match(css, /\.work-timeline-bar\.tone-overdue \{[^}]*border: var\(--hairline\) solid var\(--color-danger\);/)
  // 8px짜리 투명한 손잡이는 전역 포커스 링(8% 검정)으로는 어디에 있는지 보이지 않았다.
  assert.match(css, /\.work-timeline-handle:focus-visible, \.work-timeline-bar-body:focus-visible \{[^}]*outline: var\(--hairline\) solid var\(--color-primary\);/)
})

test('Enter·Esc는 진행 중인 마우스 드래그까지 끝낸다', () => {
  // 브라우저는 mousedown에서 버튼에 포커스를 준다 — 끌고 있는 손 위에서 Esc·Enter가 그대로 이 핸들러로 온다.
  // dragRef를 남기면 '취소했습니다'라고 읽어 준 뒤 pointerup이 저장하거나, Enter 저장 위에 두 번째 저장이 덮인다.
  const escape = timelineSource.slice(timelineSource.indexOf("if (event.key === 'Escape')"), timelineSource.indexOf("if (event.key !== 'ArrowLeft'"))
  assert.match(escape, /const dragging = Boolean\(dragRef\.current\)\s+dragRef\.current = null/, 'Esc는 미리보기 유무보다 먼저 드래그를 끝낸다')
  assert.ok(escape.indexOf('dragRef.current = null') < escape.indexOf('if (!current)'), '드래그 정리가 미리보기 없음 반환보다 앞에 있다')
  // Space도 같은 갈래를 타므로 여는 괄호까지만 찾는다(닫는 괄호로 찾으면 키가 하나 늘 때마다 조용히 -1이 된다).
  const enterAt = escape.indexOf("if (event.key === 'Enter'")
  assert.ok(enterAt > 0, 'Enter 갈래를 찾았다')
  const enter = escape.slice(enterAt)
  assert.ok(enter.indexOf('dragRef.current = null') < enter.indexOf('void commit('), 'Enter는 저장 전에 드래그를 끝낸다')
})

test('첫 창과 오늘 버튼은 같은 여백을 쓴다', () => {
  // 두 값이 갈리면, 아무 데도 가지 않은 사람이 '오늘'을 눌렀을 때 캔버스가 이유 없이 한 칸 민다.
  assert.equal(TIMELINE_LEAD_DAYS, 2)
  assert.match(timelineSource, /useState\(\(\) => shiftDateKey\(seoulDateInputValue\(\), -TIMELINE_LEAD_DAYS\)\)/)
  assert.match(timelineSource, /shiftDateKey\(dateKey, -TIMELINE_LEAD_DAYS\)/)
  assert.doesNotMatch(timelineSource, /shiftDateKey\((?:seoulDateInputValue\(\)|dateKey), -\d/, '여백을 숫자로 다시 적지 않는다')
})

test('막대에 붙이는 클래스는 스타일시트에 전부 있다', async () => {
  const css = await readFile(new URL('../src/components/WorkViews.css', import.meta.url), 'utf8')
  // 아무것도 그리지 않는 클래스는 '편집 불가'를 말한 척만 한다 — 손잡이는 투명하고 title은 마우스에게만 보인다.
  for (const name of ['is-assumed', 'is-draft', 'is-pending', 'is-locked', 'is-clipped-start', 'is-clipped-end']) {
    assert.match(timelineSource, new RegExp(`'${name}'`), `${name}을 붙이는 자리가 있다`)
    assert.match(css, new RegExp(`\\.work-timeline-bar\\.${name} \\{`), `${name}에 규칙이 없다`)
  }
})

test('타임라인 어디에도 간트라는 말이 없다 — 아이콘 이름까지', async () => {
  const files = [
    'src/components/WorkTimeline.tsx', 'src/components/ViewSwitcher.tsx',
    'src/components/WorkViews.css', 'src/utils/workTimeline.ts', 'server/work-item-schedule.mjs',
  ]
  for (const file of files) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /gantt/i, `${file}에 간트가 남아 있다`)
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { formatListDateTime } from '../src/utils/dateTime.ts'

/** 기준 시각은 한국 시간 2026년 9월 5일 오후 3시. */
const NOW = new Date('2026-09-05T06:00:00.000Z')
const seoul = (value) => new Date(`${value}+09:00`)

test('오늘이면 시각만 보여 준다', () => {
  // 목록에서 "오늘 14:30"의 날짜 부분은 아무도 읽지 않는다.
  assert.equal(formatListDateTime(seoul('2026-09-05T14:30:00'), NOW), '14:30')
  assert.equal(formatListDateTime(seoul('2026-09-05T00:05:00'), NOW), '00:05')
})

test('어제면 "어제"를 붙인다', () => {
  assert.equal(formatListDateTime(seoul('2026-09-04T14:30:00'), NOW), '어제 14:30')
  assert.equal(formatListDateTime(seoul('2026-09-04T23:59:00'), NOW), '어제 23:59')
})

test('그보다 오래됐지만 올해면 날짜만 남긴다', () => {
  assert.equal(formatListDateTime(seoul('2026-08-25T14:30:00'), NOW), '8.25')
  assert.equal(formatListDateTime(seoul('2026-09-03T09:00:00'), NOW), '9.3')
})

test('해가 다르면 연도를 붙인다', () => {
  // 연도가 없으면 작년 8월 25일과 올해 8월 25일이 같아 보인다.
  assert.equal(formatListDateTime(seoul('2025-08-25T14:30:00'), NOW), '2025.8.25')
  assert.equal(formatListDateTime(seoul('2027-01-02T08:00:00'), NOW), '2027.1.2')
})

test('한국 시간 기준으로 오늘을 센다', () => {
  // UTC로는 어제지만 서울에서는 오늘 아침이다.
  assert.equal(formatListDateTime('2026-09-04T22:00:00.000Z', NOW), '07:00')
})

test('값이 없으면 억지로 만들지 않는다', () => {
  assert.equal(formatListDateTime(null, NOW), '—')
  assert.equal(formatListDateTime('', NOW), '—')
  assert.equal(formatListDateTime('언젠가', NOW), '언젠가')
})

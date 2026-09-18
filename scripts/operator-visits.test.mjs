import assert from 'node:assert/strict'
import test from 'node:test'

import { groupOperatorVisits } from '../src/utils/operatorVisits.ts'

const row = (id, at, event = '운영자 조회', actor = '운영자 김서원') => ({ id, at, event, scope: `GET /api/${id}`, actor })

test('같은 운영자의 줄이 30분 안에 이어지면 한 방문으로 묶고, 변경 수를 따로 센다', () => {
  const visits = groupOperatorVisits([
    row('a', '2026-09-18T08:10:00.000Z', '운영자 변경'),
    row('b', '2026-09-18T08:05:00.000Z'),
    row('c', '2026-09-18T08:00:00.000Z'),
    // 45분 비었다 → 새 방문
    row('d', '2026-09-18T07:15:00.000Z'),
    // 다른 운영자 → 새 방문
    row('e', '2026-09-18T07:14:00.000Z', '운영자 조회', '운영자 이도윤'),
  ])
  assert.deepEqual(visits.map((visit) => visit.rows.map((item) => item.id)), [['a', 'b', 'c'], ['d'], ['e']])
  assert.equal(visits[0].writes, 1)
  assert.equal(visits[0].reads, 2)
  assert.equal(visits[0].startedAt, '2026-09-18T08:00:00.000Z')
  assert.equal(visits[0].endedAt, '2026-09-18T08:10:00.000Z')
})

test('줄을 버리지 않는다 — 묶어도 전체 수가 같다', () => {
  const rows = Array.from({ length: 120 }, (_, index) => row(`r${index}`, new Date(Date.UTC(2026, 8, 18, 9) - index * 7 * 60_000).toISOString()))
  const visits = groupOperatorVisits(rows)
  assert.equal(visits.reduce((sum, visit) => sum + visit.rows.length, 0), 120)
})

test('시각을 읽을 수 없는 줄은 앞뒤와 묶지 않는다', () => {
  const visits = groupOperatorVisits([row('a', '2026-09-18T08:10:00.000Z'), row('b', 'not-a-date'), row('c', '2026-09-18T08:09:00.000Z')])
  assert.equal(visits.length, 3)
})

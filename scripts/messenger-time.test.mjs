import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { byRecentActivity, dayDividerLabel, dividerBefore, lastActivityAt, listTimeLabel } from '../src/utils/messengerTime.ts'

// 2026-09-18(금) 21:00 서울 = 12:00 UTC
const NOW = new Date('2026-09-18T12:00:00.000Z')

test('날짜 구분선: 오늘·어제·요일 붙은 날짜·다른 해 — 서울 날짜로 가른다', () => {
  assert.equal(dayDividerLabel('2026-09-18T01:00:00.000Z', NOW), '오늘')
  // 서울 자정 직후(15:30 UTC 전날)도 서울 날짜로는 오늘이다.
  assert.equal(dayDividerLabel('2026-09-17T15:30:00.000Z', NOW), '오늘')
  assert.equal(dayDividerLabel('2026-09-17T03:00:00.000Z', NOW), '어제')
  assert.equal(dayDividerLabel('2026-09-15T03:00:00.000Z', NOW), '9월 15일 (화)')
  assert.equal(dayDividerLabel('2025-12-03T03:00:00.000Z', NOW), '2025년 12월 3일 (수)')
  assert.equal(dayDividerLabel(undefined, NOW), '')
})

test('목록 시각: 오늘은 시:분, 어제, 올해 날짜, 지난해 — 모르면 저장된 글자', () => {
  assert.equal(listTimeLabel('2026-09-18T05:05:00.000Z', '', NOW), '14:05')
  assert.equal(listTimeLabel('2026-09-17T05:05:00.000Z', '', NOW), '어제')
  assert.equal(listTimeLabel('2026-09-01T05:05:00.000Z', '', NOW), '9월 1일')
  assert.equal(listTimeLabel('2025-12-03T05:05:00.000Z', '', NOW), '2025. 12. 3.')
  assert.equal(listTimeLabel(undefined, '14:05', NOW), '14:05')
})

test('방 목록은 최근 활동순 — lastAt이 없는 예전 방은 본채널 마지막 말의 시각을 쓴다', () => {
  const rooms = [
    { id: 'old', messages: [{ createdAt: '2026-09-01T00:00:00.000Z' }] },
    { id: 'thread-only', messages: [{ createdAt: '2026-09-02T00:00:00.000Z' }, { createdAt: '2026-09-18T00:00:00.000Z', threadRootId: 'x' }] },
    { id: 'recent', lastAt: '2026-09-18T01:00:00.000Z', messages: [] },
    { id: 'unknown', messages: [] },
  ]
  assert.deepEqual(byRecentActivity(rooms).map((room) => room.id), ['recent', 'thread-only', 'old', 'unknown'])
  assert.equal(lastActivityAt(rooms[1]), '2026-09-02T00:00:00.000Z', '스레드 답글은 방의 마지막 말이 아니다')
})

test('구분선은 날짜가 바뀌는 자리에만, 화면에서 고정 "오늘"은 사라졌다', () => {
  const messages = [{ createdAt: '2026-09-16T01:00:00.000Z' }, { createdAt: '2026-09-16T02:00:00.000Z' }, { createdAt: '2026-09-18T01:00:00.000Z' }]
  assert.deepEqual(messages.map((_, index) => dividerBefore(messages, index, NOW)), ['9월 16일 (수)', '', '오늘'])
  const suite = readFileSync(new URL('../src/components/CollaborationSuite.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(suite, /<div className="messenger-date-divider"><span>오늘<\/span><\/div>/)
  assert.match(suite, /const divider = dividerBefore\(visibleMessages, index\)/)
  assert.match(suite, /const filteredConversations = orderedConversations\.filter/)
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(app, /if \(event\.kind === 'message' \|\| event\.kind === 'resync'\) messengerUnreadRefreshRef\.current\?\.\(\)/)
  assert.match(app, /fetch\('\/api\/messenger\/unread'/)
})

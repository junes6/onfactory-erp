import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildQuietDigest,
  collectQuietDigest,
  DEFAULT_QUIET_HOURS,
  inQuietHours,
  lastQuietWindow,
  normalizeNotificationSettings,
  normalizeRoomModes,
  pushDecision,
  settingsFor,
} from './notifications.mjs'

const ME = 'U-PARK'
const record = (settings) => ({ [ME]: settings })
const notice = (type, extra = {}) => ({ id: `N-${type}`, type, recipientId: ME, title: `${type} 알림`, createdAt: '2026-09-05T00:00:00.000Z', readAt: null, source: null, focusId: '', ...extra })

/** 서울 밤 11시. */
const NIGHT = new Date('2026-09-04T14:00:00.000Z')
/** 서울 오후 2시. */
const DAY = new Date('2026-09-05T05:00:00.000Z')

test('자정을 넘는 방해 금지 구간을 제대로 판정한다', () => {
  // 22:00–07:00은 단순 비교로는 "시작이 끝보다 크다"라 늘 거짓이 된다.
  const quiet = DEFAULT_QUIET_HOURS
  assert.equal(inQuietHours('23:30', quiet), true)
  assert.equal(inQuietHours('02:00', quiet), true)
  assert.equal(inQuietHours('06:59', quiet), true)
  assert.equal(inQuietHours('07:00', quiet), false)
  assert.equal(inQuietHours('21:59', quiet), false)
})

test('자정을 넘지 않는 구간도 된다', () => {
  const quiet = { enabled: true, start: '13:00', end: '15:00' }
  assert.equal(inQuietHours('14:00', quiet), true)
  assert.equal(inQuietHours('12:59', quiet), false)
  assert.equal(inQuietHours('15:00', quiet), false)
})

test('꺼 두면 언제나 울린다', () => {
  assert.equal(inQuietHours('03:00', { enabled: false, start: '22:00', end: '07:00' }), false)
})

test('낮에는 그대로 보내고 밤에는 참는다', () => {
  const settings = record(normalizeNotificationSettings({}))
  assert.equal(pushDecision(notice('task-assigned'), settings, DAY), 'send')
  assert.equal(pushDecision(notice('task-assigned'), settings, NIGHT), 'hold')
})

test('긴급으로 정한 유형은 밤에도 울린다', () => {
  const settings = record(normalizeNotificationSettings({}))
  // 기본 긴급: 보완 요청·결재 요청. 내 결재가 막혀 있다는 뜻이라 아침까지 미루면 하루가 밀린다.
  assert.equal(pushDecision(notice('changes-requested'), settings, NIGHT), 'send')
  assert.equal(pushDecision(notice('approval-requested'), settings, NIGHT), 'send')
})

test('끈 유형은 밤낮 없이 보내지 않는다', () => {
  const settings = record(normalizeNotificationSettings({ muted: ['task-assigned'] }))
  assert.equal(pushDecision(notice('task-assigned'), settings, DAY), 'skip')
})

test('방을 끄면 그 방 알림은 나가지 않는다', () => {
  const settings = record(normalizeNotificationSettings({ rooms: { 'CV-1': 'off' } }))
  const inRoom = notice('mention', { source: { kind: 'message', id: 'CV-1', label: '메신저' } })
  assert.equal(pushDecision(inRoom, settings, DAY), 'skip')
})

test('멘션만으로 두면 이름을 부를 때만 울린다', () => {
  const settings = record(normalizeNotificationSettings({ rooms: { 'CV-1': 'mention' }, push: ['mention', 'task-assigned'] }))
  const source = { kind: 'message', id: 'CV-1', label: '메신저' }
  assert.equal(pushDecision(notice('mention', { source }), settings, DAY), 'send')
  assert.equal(pushDecision(notice('task-assigned', { source }), settings, DAY), 'skip')
  // 다른 방은 영향을 받지 않는다.
  assert.equal(pushDecision(notice('mention', { source: { kind: 'message', id: 'CV-2', label: '메신저' } }), settings, DAY), 'send')
})

test('기본값인 방은 설정에 적어 두지 않는다', () => {
  // 모두 받기가 기본이라 굳이 적으면 설정만 커진다.
  assert.deepEqual(normalizeRoomModes({ 'CV-1': 'all', 'CV-2': 'off', 'CV-3': '아무거나' }), { 'CV-2': 'off' })
})

test('방금 끝난 방해 금지 구간을 돌려준다', () => {
  // 서울 9/5 오전 9시 → 9/4 22:00 ~ 9/5 07:00
  const window = lastQuietWindow(new Date('2026-09-05T00:00:00.000Z'), DEFAULT_QUIET_HOURS)
  assert.equal(window.start.toISOString(), '2026-09-04T13:00:00.000Z')
  assert.equal(window.end.toISOString(), '2026-09-04T22:00:00.000Z')
})

test('아직 방해 금지 시간 안이면 전날 구간을 본다', () => {
  // 서울 9/5 새벽 5시 — 오늘 아침은 아직 오지 않았다.
  const window = lastQuietWindow(new Date('2026-09-04T20:00:00.000Z'), DEFAULT_QUIET_HOURS)
  assert.equal(window.end.toISOString(), '2026-09-03T22:00:00.000Z')
})

test('아침 요약은 안 읽은 것만, 긴급은 빼고 센다', () => {
  const settings = settingsFor(record(normalizeNotificationSettings({})), ME)
  const rows = [
    notice('task-assigned', { id: 'A', createdAt: '2026-09-04T15:00:00.000Z' }),
    notice('mention', { id: 'B', createdAt: '2026-09-04T16:00:00.000Z' }),
    // 이미 읽음 — 아침에 다시 세면 열었을 때 아무것도 없다.
    notice('task-assigned', { id: 'C', createdAt: '2026-09-04T17:00:00.000Z', readAt: '2026-09-04T17:05:00.000Z' }),
    // 긴급이라 그때 이미 울렸다.
    notice('changes-requested', { id: 'D', createdAt: '2026-09-04T18:00:00.000Z' }),
    // 구간 밖.
    notice('task-assigned', { id: 'E', createdAt: '2026-09-05T02:00:00.000Z' }),
  ]
  const held = collectQuietDigest(rows, {
    recipientId: ME,
    settings,
    windowStart: new Date('2026-09-04T13:00:00.000Z'),
    windowEnd: new Date('2026-09-04T22:00:00.000Z'),
  })
  assert.deepEqual(held.map((row) => row.id), ['A', 'B'])

  const digest = buildQuietDigest({ held, recipientId: ME, now: new Date('2026-09-04T22:05:00.000Z') })
  assert.equal(digest.type, 'quiet-digest')
  assert.equal(digest.title, '밤사이 알림 2건')
  assert.match(digest.body, /업무 배정 1건/)
  assert.match(digest.body, /멘션 1건/)
})

test('참아 둔 것이 없으면 아침에 아무것도 보내지 않는다', () => {
  assert.equal(buildQuietDigest({ held: [], recipientId: ME }), null)
})

test('요약의 요약은 만들지 않는다', () => {
  const settings = settingsFor(record(normalizeNotificationSettings({})), ME)
  const rows = [notice('quiet-digest', { id: 'X', createdAt: '2026-09-04T16:00:00.000Z' })]
  const held = collectQuietDigest(rows, {
    recipientId: ME, settings,
    windowStart: new Date('2026-09-04T13:00:00.000Z'),
    windowEnd: new Date('2026-09-04T22:00:00.000Z'),
  })
  assert.equal(held.length, 0)
})

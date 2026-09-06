import assert from 'node:assert/strict'
import test from 'node:test'

import {
  NOTIFICATION_CHANNELS, NOTIFICATION_CHANNEL_IDS, createNotificationDelivery, maskEmail,
} from './notification-delivery.mjs'
import { createWebhookDispatch } from './webhook-dispatch.mjs'
import { DELIVERY_CHANNELS } from './webhook-routes.mjs'
import { createSecretBox } from './secret-box.mjs'
import {
  buildNotification, channelDecision, defaultNotificationSettings, normalizeNotificationSettings,
} from './notifications.mjs'

/**
 * 알림 채널 어댑터 — "채널 하나 늘리는 일은 어댑터 하나 + 환경변수 하나"라는 약속.
 *
 * 지키는 것 넷:
 *  1. 어댑터가 없으면 아무 행도 만들지 않는다 — 켤 수 없는 채널의 실패 기록을 쌓지 않는다.
 *  2. 사용자가 켠 유형만 나간다(기본은 꺼짐 — 건당 요금이 나가는 통로다).
 *  3. 밤에는 참는다. 푸시와 같은 규칙이고, 아침 요약이 대신 전한다.
 *  4. 어댑터가 던져도 알림 저장은 그대로다 — 못 보낸 것이 알림 센터를 지울 이유는 아니다.
 */

const TENANT = 'TENANT-T'
const ADMIN = { id: 'USR-A', tenantId: TENANT, name: '관리자', email: 'admin@example.com', role: 'tenant-admin', approved: true, approvalStatus: 'approved' }
const quiet = { warn: () => {}, log: () => {}, error: () => {} }

const draft = (overrides = {}) => buildNotification({ type: 'mention', recipientId: ADMIN.id, title: '지목', body: '내용', ...overrides })

/**
 * 2026-09-06 13:00 서울 — 기본 방해 금지(22:00~07:00) 밖의 한낮이다.
 *
 * 시계를 박지 않으면 queueChannelDeliveries가 실제 벽시계로 channelDecision을 부르고,
 * 서울 기준 밤 열 시부터 아침 일곱 시까지는 비긴급이 'hold'라 행이 하나도 생기지 않는다.
 * 낮에 돌린 테스트만 녹색인 파일이 되어 하루의 아홉 시간을 CI가 빨갛게 보낸다.
 * 밤의 동작은 아래 '방해 금지' 테스트가 시각을 직접 넘겨 따로 고정한다.
 */
const DAYTIME = '2026-09-06T04:00:00.000Z'

function harness({ env = {}, settings = {}, delivery = null, logger = quiet, now = DAYTIME } = {}) {
  const workspaceStore = {
    version: 2,
    tenants: { [TENANT]: { 'notification-settings': { data: settings }, notifications: { data: [] } } },
    platform: { auditEvents: [] },
  }
  const notificationDelivery = delivery ?? createNotificationDelivery({ env, logger })
  const dispatch = createWebhookDispatch({
    workspaceStore,
    accounts: [ADMIN],
    commitWorkspaceStore: async () => {},
    notify: () => [],
    notificationSettingsRecord: (tenantId) => workspaceStore.tenants[tenantId]?.['notification-settings']?.data ?? {},
    notificationsOf: (tenantId) => workspaceStore.tenants[tenantId]?.notifications?.data ?? [],
    secretBox: createSecretBox({ env: {}, logger: quiet }),
    notificationDelivery,
    clock: () => new Date(now),
    logger: quiet,
  })
  const publish = (notification) => {
    workspaceStore.tenants[TENANT].notifications.data = [notification, ...workspaceStore.tenants[TENANT].notifications.data]
    return dispatch.queueChannelDeliveries(TENANT, [notification])
  }
  const rowsOf = () => workspaceStore.tenants[TENANT]['webhook-deliveries']?.data ?? []
  return { workspaceStore, dispatch, notificationDelivery, publish, rowsOf }
}

/** 켠 유형만 나간다. 이 헬퍼가 "사용자가 알림톡을 켰다"는 설정 한 벌을 만든다. */
const optIn = (channel, types) => ({ [ADMIN.id]: { ...defaultNotificationSettings(), [channel]: types } })

test('환경변수가 없으면 채널이 없고, 알림이 와도 전달 행을 만들지 않는다', () => {
  const { notificationDelivery, publish, rowsOf } = harness({ env: {}, settings: optIn('kakao', ['mention']) })
  assert.deepEqual(notificationDelivery.channels, [])
  assert.equal(notificationDelivery.has('kakao'), false)
  assert.deepEqual(publish(draft()), [])
  assert.deepEqual(rowsOf(), [], '켤 수 없는 채널의 실패 기록을 쌓지 않는다')
})

test('KAKAO_TRANSPORT=console이면 채널이 하나 생긴다', () => {
  const delivery = createNotificationDelivery({ env: { KAKAO_TRANSPORT: 'console' }, logger: quiet })
  assert.deepEqual(delivery.channels, ['kakao'])
  assert.equal(delivery.transportOf('kakao'), 'console')
  assert.equal(delivery.has('email'), false)
})

test('알 수 없는 전송 수단은 경고를 남기고 그 채널만 빠진다 — 서버는 그대로 뜬다', () => {
  const warnings = []
  const delivery = createNotificationDelivery({
    env: { KAKAO_TRANSPORT: 'aligo', MAIL_TRANSPORT: 'console' },
    logger: { ...quiet, warn: (message) => warnings.push(String(message)) },
  })
  assert.deepEqual(delivery.channels, ['email'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /KAKAO_TRANSPORT='aligo'/)
})

test('켜지 않은 유형·끈 유형은 행이 생기지 않는다 — 기본은 꺼짐이다', () => {
  const base = { env: { KAKAO_TRANSPORT: 'console' } }
  // 기본 설정: kakao 목록이 비어 있다.
  assert.deepEqual(harness({ ...base, settings: {} }).publish(draft()), [])
  // 켰지만 다른 유형만 켰다.
  assert.deepEqual(harness({ ...base, settings: optIn('kakao', ['task-assigned']) }).publish(draft()), [])
  // 켰는데 그 유형을 아예 껐다(muted가 더 세다).
  const muted = { [ADMIN.id]: { ...defaultNotificationSettings(), kakao: ['mention'], muted: ['mention'] } }
  assert.deepEqual(harness({ ...base, settings: muted }).publish(draft()), [])
  // 켠 유형은 행이 하나 생긴다.
  const on = harness({ ...base, settings: optIn('kakao', ['mention']) })
  const created = on.publish(draft())
  assert.equal(created.length, 1)
  assert.equal(created[0].channel, 'kakao')
  assert.equal(created[0].eventType, 'notification.mention')
  assert.deepEqual(created[0].payload, {}, '알림 본문은 전달 행에 저장하지 않는다')
})

test('방해 금지 시간의 비긴급은 외부 채널로도 나가지 않는다 — 푸시와 같은 규칙이다', () => {
  const settings = { [ADMIN.id]: { ...defaultNotificationSettings(), kakao: ['mention', 'approval-requested'] } }
  const record = settings
  // 서울 자정. 기본 방해 금지(22:00~07:00) 안이다.
  const night = new Date('2026-09-06T15:00:00.000Z')
  const day = new Date('2026-09-06T04:00:00.000Z')
  assert.equal(channelDecision(draft(), record, 'kakao', night), 'hold')
  assert.equal(channelDecision(draft(), record, 'kakao', day), 'send')
  // 긴급 예외 유형은 밤에도 나간다(DEFAULT_URGENT_TYPES).
  assert.equal(channelDecision(draft({ type: 'approval-requested' }), record, 'kakao', night), 'send')
  // 켜지 않은 채널은 낮에도 'skip'이다 — 'hold'와 뜻이 다르다.
  assert.equal(channelDecision(draft(), {}, 'kakao', day), 'skip')
  // 적재 경로도 같은 결론을 낸다. 위 세 줄은 규칙 함수를 재고, 이 두 줄은 그 규칙이
  // queueChannelDeliveries의 시계를 타고 실제 행 생성까지 이어지는지를 잰다.
  const base = { env: { KAKAO_TRANSPORT: 'console' }, settings: optIn('kakao', ['mention']) }
  assert.deepEqual(harness({ ...base, now: night.toISOString() }).publish(draft()), [], '밤에는 행을 만들지 않는다')
  assert.equal(harness({ ...base, now: day.toISOString() }).publish(draft()).length, 1)
})

test('어댑터가 던져도 알림 저장은 그대로이고 전달 행만 재시도로 남는다', async () => {
  const throwing = {
    channels: ['kakao'],
    has: (channel) => channel === 'kakao',
    transportOf: () => 'console',
    targetFor: () => 'USR-A',
    send: async () => { throw new Error('발신 게이트웨이가 응답하지 않습니다') },
  }
  const scope = harness({ delivery: throwing, settings: { [ADMIN.id]: { ...defaultNotificationSettings(), kakao: ['mention'] } } })
  const created = scope.publish(draft())
  assert.equal(created.length, 1)
  await scope.dispatch.settle()
  const row = scope.rowsOf().find((item) => item.id === created[0].id)
  assert.equal(row.status, 'failed', '재시도 대상으로 남는다')
  assert.equal(row.attempts, 1)
  assert.match(row.lastError, /발신 게이트웨이/)
  assert.equal(scope.workspaceStore.tenants[TENANT].notifications.data.length, 1, '알림 저장은 그대로다')
})

test('전달 기록의 받는 곳은 주소 전체가 아니다', () => {
  assert.equal(maskEmail('jihyun.park@sunsea.co.kr'), 'ji*********@sunsea.co.kr')
  assert.equal(maskEmail(''), '')
  assert.equal(maskEmail('nodomain'), 'no***')
})

test('채널 목록은 등록부 한 벌에서 나온다 — shape 게이트도 설정 기본값도 여기서 파생된다', () => {
  // 채널을 하나 늘리는 일이 "어댑터 하나 + 환경변수 하나"이려면, 아래 셋이 전부 이 목록에서 나와야 한다.
  // 낱말을 어느 한 곳에 다시 적어 두면: shape 게이트는 그 채널의 행을 통째로 버리고(전달이 멈춘다),
  // 설정 정규화는 그 채널의 켬/끔을 저장할 때마다 지운다.
  for (const channel of NOTIFICATION_CHANNELS) {
    assert.equal(typeof channel.id, 'string')
    assert.ok(channel.label.trim(), `${channel.id}에는 사람이 읽을 이름표가 있다`)
    assert.equal(DELIVERY_CHANNELS.has(channel.id), true, `${channel.id} 행이 저장 게이트를 지난다`)
    assert.deepEqual(defaultNotificationSettings()[channel.id], [], `${channel.id}의 기본값은 꺼짐이다`)
    assert.deepEqual(
      normalizeNotificationSettings({ [channel.id]: ['mention', '없는유형'] })[channel.id],
      ['mention'],
      `${channel.id} 설정이 저장에서 살아남는다`,
    )
  }
  assert.deepEqual(NOTIFICATION_CHANNEL_IDS, NOTIFICATION_CHANNELS.map((channel) => channel.id))
  // 'webhook'은 알림 채널이 아니라 URL 전달이다 — 등록부에 넣지 않는다.
  assert.equal(NOTIFICATION_CHANNEL_IDS.includes('webhook'), false)
  assert.equal(DELIVERY_CHANNELS.has('webhook'), true)
})

test('화면이 그릴 목록에는 설정된 채널만, 이름표까지 함께 실린다', () => {
  assert.deepEqual(createNotificationDelivery({ env: {}, logger: quiet }).catalog, [])
  assert.deepEqual(
    createNotificationDelivery({ env: { KAKAO_TRANSPORT: 'console' }, logger: quiet }).catalog,
    [{ id: 'kakao', label: '알림톡' }],
  )
})

test('알림 채널 행만 보낸 드레인은 엔드포인트 레코드를 갈아 끼우지 않는다', async () => {
  // 갈아 끼우면 수신 토큰 색인이 매 드레인마다 통째로 다시 세워지고(신선도를 레코드 객체로 판정한다),
  // 바뀐 행이 없는 엔드포인트 테이블이 다시 동기화된다.
  const scope = harness({ env: { KAKAO_TRANSPORT: 'console' }, settings: optIn('kakao', ['mention']) })
  const created = scope.publish(draft())
  assert.equal(created.length, 1)
  await scope.dispatch.settle()
  assert.equal(scope.rowsOf().find((item) => item.id === created[0].id).status, 'delivered')
  assert.equal(
    scope.workspaceStore.tenants[TENANT]['webhook-endpoints'],
    undefined,
    '엔드포인트가 하나도 없는 고객사에 빈 레코드를 만들어 두지 않는다',
  )
})

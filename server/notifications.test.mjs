import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createApp } from './app.mjs'
import { withServer } from './test-server.mjs'
import {
  addNotifications,
  buildNotification,
  defaultNotificationSettings,
  markRead,
  MAX_NOTIFICATIONS_PER_RECIPIENT,
  normalizeNotifications,
  normalizeSubscription,
  NOTIFICATION_TYPE_IDS,
  shouldPush,
  unreadCount,
  upsertSubscription,
  visibleNotifications,
} from './notifications.mjs'

async function login(origin, email) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'demo1234' }),
  })
  assert.equal(response.status, 200)
  const account = (await response.json()).account
  return {
    account,
    headers: {
      cookie: response.headers.get('set-cookie'),
      'x-workspace-identity': `${account.tenantId}:${account.id}`,
      'content-type': 'application/json',
    },
  }
}

const draft = (overrides = {}) => buildNotification({ type: 'task-assigned', recipientId: 'U1', title: '새 업무', ...overrides })

test('only the four immediate types are pushed by default; the rest are opt-in', () => {
  const settings = defaultNotificationSettings()
  assert.deepEqual(settings.push.sort(), ['approval-requested', 'changes-requested', 'mention', 'task-assigned'].sort())
  assert.deepEqual(settings.muted, [])
  for (const type of ['proposal-pending', 'sentinel-warning', 'opportunity-new']) {
    assert.equal(shouldPush(draft({ type, recipientId: 'U1' }), {}), false, `${type}은 사용자가 직접 켜야 한다`)
  }
  assert.equal(shouldPush(draft({ type: 'mention' }), {}), true)
  // 켜면 푸시가 나가고, 끄면 아예 만들어지지도 않는다.
  assert.equal(shouldPush(draft({ type: 'sentinel-warning' }), { U1: { push: ['sentinel-warning'], muted: [] } }), true)
  assert.equal(shouldPush(draft({ type: 'mention' }), { U1: { push: ['mention'], muted: ['mention'] } }), false)
})

test('a muted type is never stored, so the unread count cannot creep up behind a hidden filter', () => {
  const settingsRecord = { U1: { muted: ['sentinel-warning'], push: [] } }
  const { rows, accepted } = addNotifications([], [
    draft({ type: 'sentinel-warning', recipientId: 'U1', title: '인증 만료' }),
    draft({ type: 'task-assigned', recipientId: 'U1', title: '새 업무' }),
    draft({ type: 'sentinel-warning', recipientId: 'U2', title: '다른 사람은 켜 둠' }),
  ], { settingsRecord })
  assert.equal(accepted.length, 2)
  assert.equal(unreadCount(rows, 'U1'), 1)
  assert.equal(unreadCount(rows, 'U2'), 1)
})

test('one noisy recipient cannot push another person notifications out of the store', () => {
  let rows = []
  const flood = Array.from({ length: MAX_NOTIFICATIONS_PER_RECIPIENT + 40 }, (_, index) => draft({ recipientId: 'LOUD', title: `업무 ${index}` }))
  rows = addNotifications(rows, [draft({ recipientId: 'QUIET', title: '조용한 사람의 알림' })]).rows
  rows = addNotifications(rows, flood).rows
  assert.equal(unreadCount(rows, 'LOUD'), MAX_NOTIFICATIONS_PER_RECIPIENT)
  assert.equal(unreadCount(rows, 'QUIET'), 1, '남의 폭주에 내 알림이 밀려나지 않는다')
})

test('reading marks only my rows, and marking all leaves other people untouched', () => {
  const now = new Date('2026-09-01T00:00:00.000Z')
  const rows = addNotifications([], [
    draft({ recipientId: 'U1', title: 'A' }),
    draft({ recipientId: 'U1', title: 'B' }),
    draft({ recipientId: 'U2', title: 'C' }),
  ]).rows
  const mine = visibleNotifications(rows, 'U1')
  const afterOne = markRead(rows, 'U1', [mine[0].id], now)
  assert.equal(unreadCount(afterOne, 'U1'), 1)
  assert.equal(unreadCount(afterOne, 'U2'), 1)
  const afterAll = markRead(afterOne, 'U1', [], now)
  assert.equal(unreadCount(afterAll, 'U1'), 0)
  assert.equal(unreadCount(afterAll, 'U2'), 1, '전체 읽음은 내 알림만 건드린다')
  assert.equal(afterAll.find((row) => row.recipientId === 'U2').readAt, null)
})

test('a corrupt stored row makes the whole set invalid instead of being silently dropped', () => {
  assert.equal(normalizeNotifications([{ id: 'x' }]), null)
  assert.equal(normalizeNotifications([{ ...draft(), type: 'unknown-type' }]), null)
  assert.equal(normalizeNotifications([{ ...draft(), createdAt: 'yesterday' }]), null)
  const good = normalizeNotifications([draft()])
  assert.equal(good.length, 1)
  assert.equal(good[0].page, 'tasks', '유형 기본 화면이 채워진다')
})

test('subscriptions are keyed by endpoint and capped per account', () => {
  const make = (endpoint) => normalizeSubscription({ endpoint, keys: { p256dh: 'p', auth: 'a' }, userAgent: 'Chrome' }, 'U1')
  assert.equal(normalizeSubscription({ endpoint: 'http://insecure/x', keys: { p256dh: 'p', auth: 'a' } }, 'U1'), null, 'https만 받는다')
  assert.equal(normalizeSubscription({ endpoint: 'https://push/x' }, 'U1'), null)

  let rows = []
  for (let index = 0; index < 8; index += 1) rows = upsertSubscription(rows, make(`https://push.example/${index}`))
  assert.equal(rows.filter((row) => row.accountId === 'U1').length, 5, '계정당 기기 수는 상한을 지킨다')
  // 같은 엔드포인트를 다시 등록해도 늘지 않는다.
  const before = rows.length
  rows = upsertSubscription(rows, make('https://push.example/7'))
  assert.equal(rows.length, before)
})

test('an assignment, a completion report and a rejection each notify the other person only', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inthefield-notify-'))
  try {
    await withServer(createApp({ apiKey: '', workspaceStoreFile: path.join(directory, 'state.json') }), async (origin) => {
      const admin = await login(origin, 'admin@sunsea.co.kr')
      const member = await login(origin, 'taesik.oh@sunsea.co.kr')
      const inbox = async (session) => (await (await fetch(`${origin}/api/notifications`, { headers: session.headers })).json())

      const existing = await (await fetch(`${origin}/api/workspace/work-items`, { headers: admin.headers })).json()
      const task = {
        id: 'WK-NOTIFY-1', title: '급식 납품 견적 회신', description: '완료 기준', category: '일반',
        owner: member.account.name, ownerId: member.account.id,
        requestedBy: admin.account.name, requesterId: admin.account.id,
        due: '2026-09-10T09:00:00.000Z', priority: '보통', status: '업무요청',
      }
      const before = Array.isArray(existing.data) ? existing.data : []
      assert.equal((await fetch(`${origin}/api/workspace/work-items`, { method: 'PUT', headers: admin.headers, body: JSON.stringify({ data: [task, ...before] }) })).status, 200)

      // 1) 배정받은 사람에게만 알림이 간다.
      const assigned = await inbox(member)
      assert.equal(assigned.unread, 1)
      assert.deepEqual(
        { type: assigned.items[0].type, page: assigned.items[0].page, focusId: assigned.items[0].focusId },
        { type: 'task-assigned', page: 'tasks', focusId: 'WK-NOTIFY-1' },
      )
      assert.match(assigned.items[0].title, /급식 납품 견적 회신/)
      assert.equal((await inbox(admin)).items.some((item) => item.type === 'task-assigned'), false, '지시한 사람은 자기 행동을 알림으로 받지 않는다')

      // 2) 완료 보고 → 지시자에게 결재 요청 알림.
      await fetch(`${origin}/api/work-items/WK-NOTIFY-1/transition`, { method: 'POST', headers: member.headers, body: JSON.stringify({ action: 'accept' }) })
      await fetch(`${origin}/api/work-items/WK-NOTIFY-1/transition`, {
        method: 'POST', headers: member.headers,
        body: JSON.stringify({ action: 'submit', completion: { summary: '견적서를 보냈습니다.', evidence: [] } }),
      })
      const requested = await inbox(admin)
      assert.equal(requested.items[0].type, 'approval-requested')
      assert.match(requested.items[0].body, new RegExp(member.account.name))

      // 3) 보완 요청 → 담당자에게.
      await fetch(`${origin}/api/work-items/WK-NOTIFY-1/transition`, {
        method: 'POST', headers: admin.headers,
        body: JSON.stringify({ action: 'request-changes', review: { comment: '', requestedChanges: '단가표를 붙여 주세요.' } }),
      })
      const changes = await inbox(member)
      assert.equal(changes.items[0].type, 'changes-requested')
      assert.match(changes.items[0].body, /단가표/)
      assert.equal(changes.unread, 2)

      // 4) 읽음 처리는 내 것만.
      const read = await (await fetch(`${origin}/api/notifications/read`, { method: 'POST', headers: member.headers, body: JSON.stringify({ ids: [] }) })).json()
      assert.equal(read.unread, 0)
      assert.ok((await inbox(admin)).unread > 0, '남의 읽음이 내 알림을 지우지 않는다')
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('notifications are private: the generic workspace route cannot read or forge them', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inthefield-notify-guard-'))
  try {
    await withServer(createApp({ apiKey: '', workspaceStoreFile: path.join(directory, 'state.json') }), async (origin) => {
      const member = await login(origin, 'taesik.oh@sunsea.co.kr')
      for (const key of ['notifications', 'notification-settings', 'push-subscriptions']) {
        const read = await fetch(`${origin}/api/workspace/${key}`, { headers: member.headers })
        assert.equal(read.status, 403)
        assert.equal((await read.json()).error.code, 'NOTIFICATION_ROUTE_REQUIRED')
        const write = await fetch(`${origin}/api/workspace/${key}`, { method: 'PUT', headers: member.headers, body: JSON.stringify({ data: [] }) })
        assert.equal(write.status, 403)
      }
      assert.equal((await fetch(`${origin}/api/notifications`)).status, 401)
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('per-type settings persist and push registration is refused until VAPID keys exist', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inthefield-notify-settings-'))
  try {
    await withServer(createApp({ apiKey: '', workspaceStoreFile: path.join(directory, 'state.json') }), async (origin) => {
      const member = await login(origin, 'taesik.oh@sunsea.co.kr')
      const initial = await (await fetch(`${origin}/api/notifications`, { headers: member.headers })).json()
      assert.deepEqual(initial.types.map((row) => row.id).sort(), [...NOTIFICATION_TYPE_IDS].sort())
      assert.equal(initial.push.configured, false)
      assert.equal(initial.push.publicKey, '')

      const saved = await (await fetch(`${origin}/api/notifications/settings`, {
        method: 'PUT', headers: member.headers,
        body: JSON.stringify({ settings: { muted: ['sentinel-warning'], push: ['mention', 'sentinel-warning'] } }),
      })).json()
      assert.deepEqual(saved.settings.muted, ['sentinel-warning'])
      assert.deepEqual(saved.settings.push.sort(), ['mention', 'sentinel-warning'])

      // VAPID 키가 없으면 구독 등록은 503으로 닫혀 있다.
      const subscribe = await fetch(`${origin}/api/notifications/subscribe`, {
        method: 'POST', headers: member.headers,
        body: JSON.stringify({ subscription: { endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } } }),
      })
      assert.equal(subscribe.status, 503)
      assert.equal((await subscribe.json()).error.code, 'PUSH_NOT_CONFIGURED')
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

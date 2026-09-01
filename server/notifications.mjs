import { randomBytes } from 'node:crypto'

/**
 * 알림 센터 — "무슨 일이 나에게 일어났는가"를 한곳에 모은다.
 *
 * 알림은 테넌트 배열에 담기고 각 행은 받는 사람(recipientId)을 갖는다. 개인 할 일과 같은 모양이다.
 * 사람이 읽어야 하는 사실만 남긴다. 시스템 상태(정기 작업·백업)는 여기가 아니라 콘솔에 남는다.
 */

export const NOTIFICATIONS_KEY = 'notifications'
export const NOTIFICATION_SETTINGS_KEY = 'notification-settings'
export const PUSH_SUBSCRIPTIONS_KEY = 'push-subscriptions'

export const MAX_NOTIFICATIONS_PER_TENANT = 5_000
export const MAX_NOTIFICATIONS_PER_RECIPIENT = 300
export const MAX_SUBSCRIPTIONS_PER_ACCOUNT = 5

/**
 * 알림 유형. pushByDefault가 true인 것만 처음부터 푸시가 켜져 있다.
 * 나머지는 사용자가 직접 켠다 — 처음부터 다 울리면 사람은 알림을 꺼 버린다.
 */
export const NOTIFICATION_TYPES = Object.freeze({
  'task-assigned': { label: '업무 배정', pushByDefault: true, page: 'tasks' },
  'approval-requested': { label: '결재 요청', pushByDefault: true, page: 'tasks' },
  'changes-requested': { label: '보완 요청', pushByDefault: true, page: 'tasks' },
  mention: { label: '멘션', pushByDefault: true, page: 'messenger' },
  'proposal-pending': { label: '승인 대기', pushByDefault: false, page: 'approvals' },
  'sentinel-warning': { label: '센티널 경고', pushByDefault: false, page: 'approvals' },
  'opportunity-new': { label: '새 기회', pushByDefault: false, page: 'approvals' },
})

export const NOTIFICATION_TYPE_IDS = Object.freeze(Object.keys(NOTIFICATION_TYPES))
const isType = (value) => NOTIFICATION_TYPE_IDS.includes(value)

const text = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const validIso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value

export function newNotificationId() {
  return `NTF-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
}

/**
 * 알림 한 건. link는 클릭했을 때 갈 곳이다.
 * page는 화면 id, focusId는 그 화면에서 열어야 할 항목이다.
 */
export function buildNotification({ type, recipientId, title, body = '', page = '', focusId = '', source = null, now = new Date() }) {
  if (!isType(type)) throw new Error(`알 수 없는 알림 유형입니다: ${type}`)
  const recipient = text(recipientId, 120)
  const heading = text(title, 160)
  if (!recipient || !heading) throw new Error('알림에는 받는 사람과 제목이 필요합니다.')
  return {
    id: newNotificationId(),
    type,
    recipientId: recipient,
    title: heading,
    body: text(body, 300),
    page: text(page, 40) || NOTIFICATION_TYPES[type].page,
    focusId: text(focusId, 120),
    source: source && typeof source === 'object'
      ? { kind: text(source.kind, 40), id: text(source.id, 120), label: text(source.label, 80) }
      : null,
    readAt: null,
    createdAt: now.toISOString(),
  }
}

export function normalizeNotification(value) {
  if (!value || typeof value !== 'object') return null
  const id = text(value.id, 120)
  const recipientId = text(value.recipientId, 120)
  const title = text(value.title, 160)
  if (!id || !recipientId || !title || !isType(value.type)) return null
  if (!validIso(value.createdAt)) return null
  if (value.readAt !== null && value.readAt !== undefined && !validIso(value.readAt)) return null
  return {
    id,
    type: value.type,
    recipientId,
    title,
    body: text(value.body, 300),
    page: text(value.page, 40) || NOTIFICATION_TYPES[value.type].page,
    focusId: text(value.focusId, 120),
    source: value.source && typeof value.source === 'object'
      ? { kind: text(value.source.kind, 40), id: text(value.source.id, 120), label: text(value.source.label, 80) }
      : null,
    readAt: value.readAt ?? null,
    createdAt: value.createdAt,
  }
}

export function normalizeNotifications(value) {
  if (!Array.isArray(value)) return null
  if (value.length > MAX_NOTIFICATIONS_PER_TENANT) return null
  const rows = []
  const seen = new Set()
  for (const item of value) {
    const row = normalizeNotification(item)
    if (!row || seen.has(row.id)) return null
    seen.add(row.id)
    rows.push(row)
  }
  return rows
}

/** 기본 설정: 모든 유형을 화면에 보여 주고, 푸시는 즉시성이 필요한 4가지만 켠다. */
export function defaultNotificationSettings() {
  return {
    muted: [],
    push: NOTIFICATION_TYPE_IDS.filter((id) => NOTIFICATION_TYPES[id].pushByDefault),
  }
}

export function normalizeNotificationSettings(value) {
  const base = defaultNotificationSettings()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return base
  const list = (input, fallback) => (Array.isArray(input) ? [...new Set(input.filter(isType))] : fallback)
  return {
    // 전부 끄는 것도 사용자의 선택이므로 빈 배열을 존중한다.
    muted: list(value.muted, base.muted),
    push: list(value.push, base.push),
  }
}

export function settingsFor(record, accountId) {
  const all = record && typeof record === 'object' && !Array.isArray(record) ? record : {}
  return normalizeNotificationSettings(all[accountId])
}

/** 내 알림만, 최신순으로. 다른 사람의 알림은 애초에 나가지 않는다. */
export function visibleNotifications(rows, accountId, { limit = 100 } = {}) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row?.recipientId === accountId)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
    .slice(0, limit)
}

export const unreadCount = (rows, accountId) =>
  (Array.isArray(rows) ? rows : []).filter((row) => row?.recipientId === accountId && !row.readAt).length

export function markRead(rows, accountId, ids, now = new Date()) {
  const target = new Set(ids ?? [])
  return (Array.isArray(rows) ? rows : []).map((row) => (
    row?.recipientId === accountId && !row.readAt && (target.size === 0 || target.has(row.id))
      ? { ...row, readAt: now.toISOString() }
      : row
  ))
}

/**
 * 새 알림을 붙이고 한도를 지킨다.
 * 꺼 둔 유형은 애초에 만들지 않는다 — 만들어 두고 숨기면 안 읽은 수가 계속 늘어난다.
 */
export function addNotifications(rows, incoming, { settingsRecord = {}, now = new Date() } = {}) {
  const existing = Array.isArray(rows) ? rows : []
  const accepted = []
  for (const candidate of incoming ?? []) {
    if (!candidate) continue
    if (settingsFor(settingsRecord, candidate.recipientId).muted.includes(candidate.type)) continue
    accepted.push(candidate)
  }
  if (!accepted.length) return { rows: existing, accepted: [] }

  const merged = [...accepted, ...existing]
  // 사람마다 상한을 따로 지켜, 한 사람의 폭주가 다른 사람의 알림을 밀어내지 않게 한다.
  const perRecipient = new Map()
  const kept = []
  for (const row of merged) {
    const count = perRecipient.get(row.recipientId) ?? 0
    if (count >= MAX_NOTIFICATIONS_PER_RECIPIENT) continue
    perRecipient.set(row.recipientId, count + 1)
    kept.push(row)
  }
  return { rows: kept.slice(0, MAX_NOTIFICATIONS_PER_TENANT), accepted }
}

/** 이 알림을 이 사람에게 푸시로 보내야 하는가. */
export function shouldPush(notification, settingsRecord) {
  const settings = settingsFor(settingsRecord, notification.recipientId)
  if (settings.muted.includes(notification.type)) return false
  return settings.push.includes(notification.type)
}

/** 푸시 본문. 서비스워커가 그대로 읽어 알림을 띄운다. */
export function pushPayload(notification) {
  return JSON.stringify({
    id: notification.id,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    page: notification.page,
    focusId: notification.focusId,
  })
}

export function normalizeSubscription(value, accountId, now = new Date()) {
  const endpoint = String(value?.endpoint ?? '').trim()
  const p256dh = String(value?.keys?.p256dh ?? '').trim()
  const auth = String(value?.keys?.auth ?? '').trim()
  if (!/^https:\/\/[^\s]+$/i.test(endpoint) || !p256dh || !auth) return null
  return {
    id: `PSH-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
    accountId: text(accountId, 120),
    endpoint: endpoint.slice(0, 500),
    keys: { p256dh: p256dh.slice(0, 200), auth: auth.slice(0, 100) },
    userAgent: text(value?.userAgent, 160),
    createdAt: now.toISOString(),
  }
}

/** 같은 엔드포인트는 하나만 둔다. 기기당 한 건, 계정당 상한을 지킨다. */
export function upsertSubscription(rows, subscription) {
  const existing = (Array.isArray(rows) ? rows : []).filter((row) => row?.endpoint !== subscription.endpoint)
  const mine = existing.filter((row) => row.accountId === subscription.accountId)
  const others = existing.filter((row) => row.accountId !== subscription.accountId)
  return [subscription, ...mine.slice(0, MAX_SUBSCRIPTIONS_PER_ACCOUNT - 1), ...others]
}

export const removeSubscriptions = (rows, endpoints) => {
  const gone = new Set(endpoints ?? [])
  return (Array.isArray(rows) ? rows : []).filter((row) => !gone.has(row?.endpoint))
}

export const subscriptionsFor = (rows, accountId) =>
  (Array.isArray(rows) ? rows : []).filter((row) => row?.accountId === accountId)

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
  // 방해 금지 시간에 참아 둔 알림을 아침에 한 건으로 묶어 전한다.
  'quiet-digest': { label: '아침 요약', pushByDefault: true, page: 'ai' },
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

/**
 * 한 번의 저장에서 새로 배정된 업무를 받는 사람마다 한 건으로 묶는다. 상위 업무가 있으면 그것을 대표(focusId)로 삼는다.
 * 1건이면 기존 문구 그대로 — 상위 하나에 자식 여럿을 한꺼번에 지시했을 때 같은 사람의 알림이 건수만큼 울리지 않게 한다.
 * 관리자 PUT과 템플릿 실체화가 같은 함수를 지나므로 두 경로의 문구가 갈라지지 않는다.
 */
export function bundleAssignmentDrafts(items, { actorId, actorName }) {
  const byOwner = new Map()
  for (const item of items) {
    if (!item?.id || !item.ownerId) continue
    if (!byOwner.has(item.ownerId)) byOwner.set(item.ownerId, [])
    byOwner.get(item.ownerId).push(item)
  }
  return [...byOwner.entries()].map(([recipientId, group]) => {
    const lead = group.find((item) => !item.parentId) ?? group[0]
    const firstDue = group.map((item) => item.due).filter(Boolean).sort()[0]
    const single = group.length === 1
    return {
      type: 'task-assigned', recipientId, actorId,
      title: single ? `새 업무: ${lead.title}` : `새 업무 ${group.length}건: ${lead.title} 외 ${group.length - 1}건`,
      body: `${lead.requestedBy || actorName}님이 지시했습니다.${firstDue ? ` ${single ? '마감' : '첫 마감'} ${String(firstDue).slice(0, 10)}` : ''}`,
      page: 'tasks', focusId: lead.id, source: { kind: 'work-item', id: lead.id, label: '업무' },
    }
  })
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
    // R15-I: 밤에는 울리지 않는다. 아침에 한 건으로 묶어 전한다.
    quietHours: { ...DEFAULT_QUIET_HOURS },
    urgentTypes: [...DEFAULT_URGENT_TYPES],
    rooms: {},
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
    quietHours: normalizeQuietHours(value.quietHours ?? base.quietHours),
    urgentTypes: list(value.urgentTypes, base.urgentTypes),
    rooms: normalizeRoomModes(value.rooms),
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

// ---------------------------------------------------------------------------
// R15-I: 방해 금지 시간 · 긴급 예외 · 방별 제어
// ---------------------------------------------------------------------------

/**
 * 밤에는 울리지 않는다.
 *
 * 기본은 22시부터 아침 7시까지다. 이 시간에 온 알림은 사라지지 않고 쌓였다가
 * 아침에 한 건으로 묶여 온다 — 밤새 온 것을 아침에 스무 번 울리게 하면
 * 방해 금지를 켠 의미가 없다.
 */
export const DEFAULT_QUIET_HOURS = Object.freeze({ enabled: true, start: '22:00', end: '07:00' })

/**
 * 방해 금지 시간에도 지나가는 유형.
 *
 * 사람을 깨울 만한 것만 남긴다. "보완 요청"은 내 결재가 막혀 있다는 뜻이고,
 * "결재 요청"은 남이 나를 기다린다는 뜻이라 아침까지 미루면 하루가 밀린다.
 */
export const DEFAULT_URGENT_TYPES = Object.freeze(['changes-requested', 'approval-requested'])

/** 방마다 정하는 알림 세기. */
export const ROOM_MODES = Object.freeze(['all', 'mention', 'off'])
export const ROOM_MODE_LABELS = Object.freeze({ all: '모든 메시지', mention: '멘션만', off: '끔' })

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/

export function normalizeTimeOfDay(value, fallback) {
  const text = String(value ?? '').trim()
  return TIME_PATTERN.test(text) ? text : fallback
}

export function normalizeQuietHours(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_QUIET_HOURS }
  return {
    enabled: value.enabled !== false,
    start: normalizeTimeOfDay(value.start, DEFAULT_QUIET_HOURS.start),
    end: normalizeTimeOfDay(value.end, DEFAULT_QUIET_HOURS.end),
  }
}

export function normalizeRoomModes(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  for (const [id, mode] of Object.entries(value).slice(0, 500)) {
    if (!ROOM_MODES.includes(mode)) continue
    // 'all'은 기본값이라 굳이 적어 두지 않는다. 설정이 쓸데없이 커진다.
    if (mode === 'all') continue
    out[String(id).slice(0, 120)] = mode
  }
  return out
}

/**
 * 서울 기준 시각 문자열(HH:MM). 알림 시간대는 사용자의 하루를 따라가야 한다.
 *
 * 읽을 수 없는 시각이면 빈 문자열을 돌려준다. 여기서 예외가 나면 알림 발송
 * 전체가 멈추는데, 시계가 이상하다고 알림을 못 보내는 편이 더 나쁘다.
 */
export function seoulTimeOfDay(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)
}

/**
 * 지금이 방해 금지 시간인가.
 *
 * 22:00–07:00처럼 자정을 넘는 구간이 기본이라, 단순 비교로는 판정할 수 없다.
 * 시작이 끝보다 늦으면 "밤을 넘는 구간"으로 본다.
 */
export function inQuietHours(now, quiet) {
  const settings = normalizeQuietHours(quiet)
  if (!settings.enabled) return false
  if (settings.start === settings.end) return false
  const at = typeof now === 'string' ? now : seoulTimeOfDay(now)
  // 시각을 읽지 못했으면 조용한 시간이 아니라고 본다 — 참았다가 아침에도 안 보내는 것보다 낫다.
  if (!TIME_PATTERN.test(at)) return false
  return settings.start > settings.end
    ? at >= settings.start || at < settings.end
    : at >= settings.start && at < settings.end
}

/** 방해 금지가 끝나는 순간(다음 아침). 요약을 언제 보낼지 정하는 데 쓴다. */
export function quietEndsAt(now, quiet) {
  const settings = normalizeQuietHours(quiet)
  if (!settings.enabled) return null
  const [hour, minute] = settings.end.split(':').map(Number)
  const seoulNow = new Date(now.getTime() + 9 * 60 * 60 * 1_000)
  const end = new Date(Date.UTC(seoulNow.getUTCFullYear(), seoulNow.getUTCMonth(), seoulNow.getUTCDate(), hour, minute) - 9 * 60 * 60 * 1_000)
  return end.getTime() > now.getTime() ? end : new Date(end.getTime() + 24 * 60 * 60 * 1_000)
}

/**
 * 이 알림을 지금 울려도 되는가.
 *
 * @returns {'send' | 'hold' | 'skip'} hold는 아침 요약으로 미룬다는 뜻이다.
 */
export function pushDecision(notification, settingsRecord, now = new Date()) {
  const settings = settingsFor(settingsRecord, notification.recipientId)
  if (settings.muted.includes(notification.type)) return 'skip'
  if (!settings.push.includes(notification.type)) return 'skip'

  // 방별 설정이 유형 설정보다 세다. 특정 방을 껐으면 그 방 것은 울리지 않는다.
  const roomId = notification.source?.kind === 'message' ? notification.source.id : ''
  const mode = roomId ? (settings.rooms?.[roomId] ?? 'all') : 'all'
  if (mode === 'off') return 'skip'
  if (mode === 'mention' && notification.type !== 'mention') return 'skip'

  if (!inQuietHours(now, settings.quietHours)) return 'send'
  return settings.urgentTypes.includes(notification.type) ? 'send' : 'hold'
}

/**
 * 아침 요약 한 건.
 *
 * 밤새 조용히 지나간 것을 유형별로 세어 한 줄로 만든다. 무엇을 셀지는
 * collectQuietDigest가 정한다 — "그 시간에 왔고 아직 안 읽은 것"이다.
 * 실제로 눌러 본 알림까지 아침에 다시 세면 요약이 부풀려진다.
 */
export function buildQuietDigest({ held, recipientId, now = new Date(), newNotificationId: makeId = newNotificationId }) {
  if (!held.length) return null
  const counts = new Map()
  for (const item of held) counts.set(item.type, (counts.get(item.type) ?? 0) + 1)
  const parts = [...counts.entries()].map(([type, count]) => `${NOTIFICATION_TYPES[type]?.label ?? type} ${count}건`)
  const newest = held.reduce((latest, item) => (String(item.createdAt) > String(latest.createdAt) ? item : latest), held[0])
  return {
    id: makeId(),
    type: 'quiet-digest',
    recipientId,
    actorId: '',
    title: `밤사이 알림 ${held.length}건`,
    body: `${parts.join(' · ')}. 가장 최근: ${String(newest.title ?? '').slice(0, 60)}`,
    page: NOTIFICATION_TYPES[newest.type]?.page ?? 'ai',
    focusId: String(newest.focusId ?? ''),
    source: null,
    readAt: null,
    createdAt: now.toISOString(),
  }
}

/**
 * 아침에 묶어 보낼 알림을 고른다.
 *
 * 방해 금지 시간 안에 왔고, 아직 읽지 않았고, 긴급 예외가 아닌 것. 이미 읽은
 * 알림까지 세면 "밤사이 12건"이라고 해 놓고 열면 아무것도 없는 일이 생긴다.
 * 요약 자체는 세지 않는다 — 요약의 요약이 쌓인다.
 */
export function collectQuietDigest(rows, { recipientId, settings, windowStart, windowEnd }) {
  const from = windowStart.toISOString()
  const to = windowEnd.toISOString()
  return (Array.isArray(rows) ? rows : []).filter((row) => row?.recipientId === recipientId
    && row.type !== 'quiet-digest'
    && !row.readAt
    && !settings.urgentTypes.includes(row.type)
    && String(row.createdAt) >= from
    && String(row.createdAt) < to)
}

/**
 * 이번 아침의 조용한 시간대는 언제부터 언제까지였나.
 *
 * 방금 끝난 구간을 돌려준다. 자정을 넘는 구간이 기본이라 시작은 대개 어제다.
 */
export function lastQuietWindow(now, quiet) {
  const settings = normalizeQuietHours(quiet)
  if (!settings.enabled) return null
  const [endHour, endMinute] = settings.end.split(':').map(Number)
  const [startHour, startMinute] = settings.start.split(':').map(Number)
  const seoulNow = new Date(now.getTime() + 9 * 60 * 60 * 1_000)
  const dayStart = Date.UTC(seoulNow.getUTCFullYear(), seoulNow.getUTCMonth(), seoulNow.getUTCDate()) - 9 * 60 * 60 * 1_000
  let end = new Date(dayStart + (endHour * 60 + endMinute) * 60_000)
  if (end.getTime() > now.getTime()) end = new Date(end.getTime() - 24 * 60 * 60 * 1_000)
  // 끝나는 날의 자정을 기준으로 센다. 자정을 넘는 구간이면 시작은 그 전날이다.
  const endMidnight = end.getTime() - (endHour * 60 + endMinute) * 60_000
  const startOffset = (startHour * 60 + startMinute) * 60_000
  const start = settings.start > settings.end
    ? new Date(endMidnight - 24 * 60 * 60 * 1_000 + startOffset)
    : new Date(endMidnight + startOffset)
  return { start, end }
}

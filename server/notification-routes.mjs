import {
  MAX_SUBSCRIPTIONS_PER_ACCOUNT,
  NOTIFICATIONS_KEY,
  NOTIFICATION_SETTINGS_KEY,
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_IDS,
  PUSH_SUBSCRIPTIONS_KEY,
  markRead,
  normalizeNotificationSettings,
  normalizeNotifications,
  normalizeSubscription,
  removeSubscriptions,
  settingsFor,
  subscriptionsFor,
  unreadCount,
  upsertSubscription,
  visibleNotifications,
} from './notifications.mjs'

/**
 * 알림 센터 라우트. 알림은 언제나 "내 것만" 나가고, 다른 사람의 알림은 조회할 방법이 없다.
 * 일반 워크스페이스 라우트로는 읽지도 쓰지도 못하게 app.mjs에서 막는다.
 */
export function registerNotificationRoutes({
  app,
  requireAuth,
  requireMatchingWorkspaceIdentity,
  workspaceStore,
  commitWorkspaceStore,
  vapid,
  clock = () => new Date(),
}) {
  const guards = [requireAuth, requireMatchingWorkspaceIdentity]

  const tenantStoreOf = (request, response) => {
    if (!request.auth?.tenantId) {
      response.status(403).json({ error: { code: 'TENANT_REQUIRED', message: '고객사 워크스페이스에서만 사용할 수 있습니다.' } })
      return null
    }
    const tenantStore = workspaceStore.tenants[request.auth.tenantId] ??= {}
    const rows = normalizeNotifications(tenantStore[NOTIFICATIONS_KEY]?.data ?? [])
    if (rows === null) {
      // 형식이 깨진 저장소를 덮어써서 되돌릴 수 없게 만들지 않는다.
      response.status(500).json({ error: { code: 'NOTIFICATION_DATA_INVALID', message: '알림 형식이 올바르지 않아 안전하게 처리하지 않았습니다.' } })
      return null
    }
    return { tenantStore, rows }
  }

  const payloadFor = (request, rows) => ({
    items: visibleNotifications(rows, request.auth.id),
    unread: unreadCount(rows, request.auth.id),
    settings: settingsFor(workspaceStore.tenants[request.auth.tenantId]?.[NOTIFICATION_SETTINGS_KEY]?.data, request.auth.id),
    types: NOTIFICATION_TYPE_IDS.map((id) => ({ id, label: NOTIFICATION_TYPES[id].label, pushByDefault: NOTIFICATION_TYPES[id].pushByDefault })),
    push: {
      // 공개키만 내려간다. 개인키는 서버 밖으로 나가지 않는다.
      configured: Boolean(vapid?.configured),
      publicKey: vapid?.configured ? vapid.publicKey : '',
      devices: subscriptionsFor(workspaceStore.tenants[request.auth.tenantId]?.[PUSH_SUBSCRIPTIONS_KEY]?.data, request.auth.id)
        .map((row) => ({ id: row.id, endpoint: row.endpoint.slice(0, 60), userAgent: row.userAgent, createdAt: row.createdAt })),
    },
  })

  const persist = async (tenantStore, key, data, actorId, previous) => {
    tenantStore[key] = { data, updatedAt: clock().toISOString(), updatedBy: actorId }
    try { await commitWorkspaceStore() }
    catch (error) {
      if (previous) tenantStore[key] = previous; else delete tenantStore[key]
      throw error
    }
  }

  app.get('/api/notifications', ...guards, (request, response) => {
    const scope = tenantStoreOf(request, response)
    if (!scope) return
    response.json(payloadFor(request, scope.rows))
  })

  app.post('/api/notifications/read', ...guards, async (request, response) => {
    const scope = tenantStoreOf(request, response)
    if (!scope) return
    const ids = Array.isArray(request.body?.ids) ? request.body.ids.map((id) => String(id)) : []
    const next = markRead(scope.rows, request.auth.id, ids, clock())
    const previous = scope.tenantStore[NOTIFICATIONS_KEY]
    try { await persist(scope.tenantStore, NOTIFICATIONS_KEY, next, request.auth.id, previous) }
    catch {
      response.status(500).json({ error: { code: 'NOTIFICATION_WRITE_FAILED', message: '알림을 읽음으로 표시하지 못했습니다.' } })
      return
    }
    response.json(payloadFor(request, next))
  })

  app.put('/api/notifications/settings', ...guards, async (request, response) => {
    const scope = tenantStoreOf(request, response)
    if (!scope) return
    const record = scope.tenantStore[NOTIFICATION_SETTINGS_KEY]?.data
    const all = record && typeof record === 'object' && !Array.isArray(record) ? { ...record } : {}
    all[request.auth.id] = normalizeNotificationSettings(request.body?.settings)
    const previous = scope.tenantStore[NOTIFICATION_SETTINGS_KEY]
    try { await persist(scope.tenantStore, NOTIFICATION_SETTINGS_KEY, all, request.auth.id, previous) }
    catch {
      response.status(500).json({ error: { code: 'NOTIFICATION_WRITE_FAILED', message: '알림 설정을 저장하지 못했습니다.' } })
      return
    }
    response.json(payloadFor(request, scope.rows))
  })

  app.post('/api/notifications/subscribe', ...guards, async (request, response) => {
    const scope = tenantStoreOf(request, response)
    if (!scope) return
    if (!vapid?.configured) {
      response.status(503).json({ error: { code: 'PUSH_NOT_CONFIGURED', message: '웹푸시 키(VAPID_PUBLIC_KEY·VAPID_PRIVATE_KEY·VAPID_SUBJECT)가 설정되지 않았습니다.' } })
      return
    }
    const subscription = normalizeSubscription(request.body?.subscription, request.auth.id, clock())
    if (!subscription) {
      response.status(400).json({ error: { code: 'PUSH_SUBSCRIPTION_INVALID', message: '브라우저가 보낸 구독 정보를 읽지 못했습니다.' } })
      return
    }
    const previous = scope.tenantStore[PUSH_SUBSCRIPTIONS_KEY]
    const next = upsertSubscription(previous?.data ?? [], subscription)
    try { await persist(scope.tenantStore, PUSH_SUBSCRIPTIONS_KEY, next, request.auth.id, previous) }
    catch {
      response.status(500).json({ error: { code: 'NOTIFICATION_WRITE_FAILED', message: '기기 등록을 저장하지 못했습니다.' } })
      return
    }
    response.status(201).json({ ...payloadFor(request, scope.rows), maxDevices: MAX_SUBSCRIPTIONS_PER_ACCOUNT })
  })

  app.post('/api/notifications/unsubscribe', ...guards, async (request, response) => {
    const scope = tenantStoreOf(request, response)
    if (!scope) return
    const endpoint = String(request.body?.endpoint ?? '').trim()
    const previous = scope.tenantStore[PUSH_SUBSCRIPTIONS_KEY]
    const mine = subscriptionsFor(previous?.data ?? [], request.auth.id)
    // 남의 기기 구독은 지울 수 없다.
    if (!mine.some((row) => row.endpoint === endpoint)) {
      response.status(404).json({ error: { code: 'PUSH_SUBSCRIPTION_NOT_FOUND', message: '내 기기 목록에서 해당 구독을 찾을 수 없습니다.' } })
      return
    }
    try { await persist(scope.tenantStore, PUSH_SUBSCRIPTIONS_KEY, removeSubscriptions(previous?.data ?? [], [endpoint]), request.auth.id, previous) }
    catch {
      response.status(500).json({ error: { code: 'NOTIFICATION_WRITE_FAILED', message: '기기 해제를 저장하지 못했습니다.' } })
      return
    }
    response.json(payloadFor(request, scope.rows))
  })
}

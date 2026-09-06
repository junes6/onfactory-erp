import { createHmac } from 'node:crypto'

import {
  BACKOFF_MS, DISABLE_AFTER_FAILURES, MAX_DELIVERIES_PER_TENANT,
  WEBHOOK_DELIVERIES_KEY, WEBHOOK_ENDPOINTS_KEY, WEBHOOK_EVENTS, WEBHOOK_TEST_EVENT,
  WEBHOOK_URL_MESSAGES, hasDeliveryShape, hasEndpointShape, isAssignableAccount, isPrivateAddress,
  newDeliveryId, readDeliveries, readEndpoints, webhookEventFields, webhookUrlViolation,
} from './webhook-routes.mjs'
import { channelDecision } from './notifications.mjs'

/**
 * 발신 — 적재·드레인·백오프·서명.
 *
 * 적재(queueWebhookDeliveries)는 **커밋하지 않는다**. 호출부는 이미 있는 commitWorkspaceStore() 바로
 * 앞에 한 줄을 넣는다 → 상태 변경과 배송 행이 한 트랜잭션이다. 커밋과 발행 사이에 프로세스가 죽어도
 * 이벤트를 잃지 않고, 반대로 커밋이 실패하면 '일어나지 않은 사건'의 배송 행도 함께 되돌아간다
 * (각 라우트의 복원 블록에 webhook-deliveries 한 줄이 함께 있어야 한다 — 테스트가 이를 잠근다).
 *
 * 재시도 판정은 sendPush의 계약을 복제한다 — 예외 대신 결과 객체다.
 *   2xx → delivered · 408·429·5xx·네트워크 → failed(재시도) · 그 밖의 4xx와 3xx → 즉시 gave-up.
 * 고칠 수 없는 요청을 여섯 번 더 두드려도 같다(dropSubscription이 404/410에서 하는 판단과 같은 태도).
 */

const CONTROL_CHARS = /[\x00-\x1f]/g
const errorText = (value) => String(value ?? '').replace(CONTROL_CHARS, ' ').trim().slice(0, 500) || '알 수 없는 오류'

/**
 * node:dns는 보내기 직전에 게으르게 부른다.
 *
 * 이 모듈은 server/app.mjs가 모듈 스코프에서 읽고, Cloudflare Sites 워커도 같은 app.mjs를 읽는다.
 * 정적 import로 두면 그 런타임이 node:dns/promises를 주지 않을 때 **API 워커 전체가 부팅에 실패한다** —
 * 웹훅 하나를 못 보내는 것과 API가 통째로 죽는 것은 다르다. 여기서 실패하면 그 배달만 사유를 남긴다.
 */
let dnsLookup = null
const resolveDnsLookup = async () => {
  dnsLookup ??= (await import('node:dns/promises')).lookup
  return dnsLookup
}

/** 바깥으로 나가는 값은 이벤트별 fields만, 그리고 문자열·숫자·불리언·null만. */
function allowlistedData(eventType, raw) {
  const fields = webhookEventFields(eventType)
  if (!fields) return null
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const out = {}
  for (const field of fields) {
    const value = source[field]
    out[field] = value === null || value === undefined ? null
      : typeof value === 'number' || typeof value === 'boolean' ? value
        : String(value).replace(CONTROL_CHARS, ' ').slice(0, 300)
  }
  return out
}

export function createWebhookDispatch({
  workspaceStore, accounts, commitWorkspaceStore, notify,
  notificationSettingsRecord, notificationsOf, secretBox, notificationDelivery = null,
  fetchImpl = (...args) => globalThis.fetch(...args),
  lookupImpl = null,
  logger = console,
  clock = () => new Date(),
}) {
  const nowIso = () => clock().toISOString()
  const tenantStoreOf = (tenantId) => (workspaceStore.tenants[tenantId] ??= {})
  const endpointsOf = (tenantId) => readEndpoints(workspaceStore.tenants[tenantId]?.[WEBHOOK_ENDPOINTS_KEY])
  const deliveriesOf = (tenantId) => readDeliveries(workspaceStore.tenants[tenantId]?.[WEBHOOK_DELIVERIES_KEY])
  /**
   * 상한을 지킬 때 끝난 행부터 버린다.
   *
   * 새것 우선으로 통째로 자르면, 잘려 나가는 꼬리는 '가장 오래된 행'이고 그 자리가 바로
   * 2시간·6시간 백오프 사다리 위에서 기다리던 행이 있는 곳이다. 그러면 그 사건은 보내지지도 않고
   * 실패 기록에도 남지 않아, 아무도 잃어버린 줄 모른다. 그래서 끝난 행(전달됨·포기)을 먼저 버린다.
   *
   * 대기 행만으로 상한을 넘는 극단에서는 상한 안으로 자른다. 넘친 것을 '포기'로 닫아 상한 위에 얹으면
   * '고객사당 2,000건'이라는 말 자체가 거짓이 되고, 닫힌 행은 다음 쓰기에서 끝난 행으로 가장 먼저
   * 밀려 나간다 — 곧 사라질 기록 한 줄을 위해 한도를 어기는 셈이다. 남길 곳은 저장소가 아니라 로그다.
   */
  const capDeliveries = (rows) => {
    if (rows.length <= MAX_DELIVERIES_PER_TENANT) return rows
    const isTerminal = (row) => row.status === 'delivered' || row.status === 'gave-up'
    const live = rows.filter((row) => !isTerminal(row))
    if (live.length > MAX_DELIVERIES_PER_TENANT) {
      const kept = live.slice(0, MAX_DELIVERIES_PER_TENANT)
      logger.error?.('[webhook] 보관 한도를 넘어 아직 못 보낸 전달을 버렸습니다.', { dropped: live.length - kept.length })
      return kept
    }
    const keep = new Set(live.map((row) => row.id))
    let room = MAX_DELIVERIES_PER_TENANT - live.length
    for (const row of rows) {
      if (room <= 0) break
      if (keep.has(row.id)) continue
      keep.add(row.id)
      room -= 1
    }
    return rows.filter((row) => keep.has(row.id))
  }
  const putDeliveries = (tenantId, rows, actorId) => {
    tenantStoreOf(tenantId)[WEBHOOK_DELIVERIES_KEY] = { data: capDeliveries(rows), updatedAt: nowIso(), updatedBy: actorId }
  }
  /** 같은 채널·엔드포인트·사건이 두 번 큐에 들어가지 않게 하는 열쇠. 재발행 멱등이 여기 하나에 걸린다. */
  const dedupeKey = (row) => `${row.channel}:${row.endpointId ?? ''}:${row.eventId}`

  const blankDelivery = (fields) => ({
    id: newDeliveryId(),
    endpointId: null,
    channel: 'webhook',
    eventType: '',
    eventId: '',
    aggregateId: '',
    target: '',
    status: 'pending',
    attempts: 0,
    nextAttemptAt: nowIso(),
    lastStatusCode: null,
    lastError: null,
    requestedAt: nowIso(),
    deliveredAt: null,
    payload: {},
    actor: null,
    ...fields,
  })

  const hostOf = (url) => { try { return new URL(String(url)).host.slice(0, 120) } catch { return '' } }

  /**
   * 이 사건을 구독한 살아 있는 엔드포인트마다 배송 행 하나. **커밋하지 않는다.**
   * 꺼졌거나 자동 중지된 엔드포인트는 행을 만들지 않는다 — 만들어 두면 되살아난 날 오래된 사건이 쏟아진다.
   */
  function queueWebhookDeliveries(tenantId, eventType, { aggregateId = '', data = {}, actor = null, occurredAt = null } = {}) {
    if (!tenantId || !WEBHOOK_EVENTS[eventType]) return []
    const payload = allowlistedData(eventType, data)
    if (!payload) return []
    const endpoints = endpointsOf(tenantId).rows.filter((endpoint) => endpoint.direction === 'outbound'
      && endpoint.enabled && !endpoint.disabledAt && endpoint.events.includes(eventType))
    if (!endpoints.length) return []
    const { rows, dropped } = deliveriesOf(tenantId)
    if (dropped > 0) return []
    const at = occurredAt ?? nowIso()
    const eventId = `${eventType}:${String(aggregateId)}:${at}`
    const known = new Set(rows.map(dedupeKey))
    const created = []
    for (const endpoint of endpoints) {
      const row = blankDelivery({
        endpointId: endpoint.id,
        channel: 'webhook',
        eventType,
        eventId,
        aggregateId: String(aggregateId).slice(0, 120),
        target: hostOf(endpoint.url),
        payload,
        actor: actor ? String(actor).slice(0, 120) : null,
        requestedAt: at,
        nextAttemptAt: at,
      })
      if (known.has(dedupeKey(row)) || !hasDeliveryShape(row)) continue
      known.add(dedupeKey(row))
      created.push(row)
    }
    if (!created.length) return []
    putDeliveries(tenantId, [...created, ...rows], 'system:webhook')
    return created
  }

  /** '테스트 보내기' 한 건. 목록 밖의 예약 사건이라 구독과 무관하게 그 엔드포인트에만 간다. */
  function queueTestDelivery(tenantId, endpoint) {
    const { rows, dropped } = deliveriesOf(tenantId)
    if (dropped > 0) return null
    const at = nowIso()
    const row = blankDelivery({
      endpointId: endpoint.id,
      eventType: WEBHOOK_TEST_EVENT,
      eventId: `${WEBHOOK_TEST_EVENT}:${endpoint.id}:${at}`,
      aggregateId: endpoint.id,
      target: hostOf(endpoint.url),
      payload: { endpointId: endpoint.id },
      requestedAt: at,
      nextAttemptAt: at,
    })
    if (!hasDeliveryShape(row)) return null
    putDeliveries(tenantId, [row, ...rows], 'system:webhook')
    return row
  }

  /**
   * 카카오 알림톡·메일. 채널이 없으면 아무 행도 만들지 않는다 —
   * 켤 수 없는 채널의 '실패한 전달 기록'을 쌓지 않기 위해서다.
   * 판정은 푸시와 같은 규칙이다: 밤에는 'hold'이므로 외부 채널로도 나가지 않는다.
   */
  function queueChannelDeliveries(tenantId, notifications) {
    const channels = notificationDelivery?.channels ?? []
    if (!tenantId || !channels.length || !notifications?.length) return []
    const { rows, dropped } = deliveriesOf(tenantId)
    if (dropped > 0) return []
    const settingsRecord = notificationSettingsRecord(tenantId)
    const now = clock()
    const known = new Set(rows.map(dedupeKey))
    const created = []
    for (const notification of notifications) {
      const recipient = accounts.find((item) => item?.id === notification.recipientId && item.tenantId === tenantId) ?? null
      for (const channel of channels) {
        if (channelDecision(notification, settingsRecord, channel, now) !== 'send') continue
        const row = blankDelivery({
          endpointId: null,
          channel,
          eventType: `notification.${notification.type}`.slice(0, 60),
          eventId: String(notification.id),
          aggregateId: String(notification.recipientId).slice(0, 120),
          target: notificationDelivery.targetFor(channel, notification, recipient),
          payload: {},
        })
        if (known.has(dedupeKey(row)) || !hasDeliveryShape(row)) continue
        known.add(dedupeKey(row))
        created.push(row)
      }
    }
    if (!created.length) return []
    putDeliveries(tenantId, [...created, ...rows], 'system:notify')
    kick(tenantId)
    return created
  }

  // ── 보내기 ─────────────────────────────────────────────────

  async function sendWebhook(tenantId, endpoint, row, now) {
    // 서명 없이 보내지 않는다. 키가 바뀌어 봉투를 못 열면 fetch를 부르지 않고 그 자리에서 포기한다.
    const secret = secretBox?.open(endpoint.signingSecretEnc, { aad: endpoint.id }) ?? null
    if (!secret) return { outcome: 'gave-up', error: '서명 비밀값을 열 수 없습니다(SECRET_BOX_KEY 변경).' }
    const violation = webhookUrlViolation(endpoint.url)
    if (violation) return { outcome: 'gave-up', error: WEBHOOK_URL_MESSAGES[violation] }
    const url = new URL(endpoint.url)
    // 등록 시점과 발신 시점 사이에 이름이 사설 주소를 가리키게 바뀔 수 있다(DNS 리바인딩).
    // 그래서 보내기 직전에 한 번 더 본다 — 사설이면 fetch를 부르지 않는다.
    let lookup = lookupImpl
    if (!lookup) {
      try { lookup = await resolveDnsLookup() }
      catch { return { outcome: 'failed', error: '이 실행 환경에서는 주소를 확인할 수 없어 보내지 않았습니다.' } }
    }
    // 한 이름이 여러 주소를 가질 수 있다. 하나만 읽고 통과시키면, 공인 A와 사설 A를 함께 올린 이름이
    // 검사에서는 공인으로 통과하고 fetch의 자체 해석에서는 사설로 나갈 수 있다 — 전부 보고 하나라도
    // 사내망이면 보내지 않는다.
    let addresses = []
    try {
      const found = await lookup(url.hostname, { all: true })
      addresses = (Array.isArray(found) ? found : [found])
        .map((item) => String(item?.address ?? '').trim())
        .filter(Boolean)
    } catch (error) { return { outcome: 'failed', error: `주소를 찾을 수 없습니다: ${errorText(error?.message ?? error)}` } }
    // 주소가 하나도 없는 것과 사내망인 것은 다른 사실이다. 한 문장으로 묶으면 DNS가 빈 답을 준 밤에
    // 관리자가 방화벽 설정을 뒤지게 된다.
    if (!addresses.length) return { outcome: 'failed', error: '이 주소의 IP를 찾지 못해 보내지 않았습니다.' }
    if (addresses.some(isPrivateAddress)) {
      return { outcome: 'failed', error: '사내망 주소로 확인되어 보내지 않았습니다.' }
    }
    const occurredAt = row.requestedAt
    const body = JSON.stringify({
      id: row.eventId,
      type: row.eventType,
      tenantId,
      aggregateId: row.aggregateId,
      occurredAt,
      actor: row.actor,
      data: row.payload,
    })
    const stamp = Math.floor(now.getTime() / 1_000)
    const signature = createHmac('sha256', secret).update(`${stamp}.${body}`).digest('hex')
    try {
      const response = await fetchImpl(endpoint.url, {
        method: 'POST',
        // 3xx는 따라가지 않는다 — 리다이렉트가 내부망으로 끌고 가는 고전적 우회를 막는다.
        redirect: 'manual',
        headers: {
          'content-type': 'application/json',
          'x-inthefield-event': row.eventType,
          'x-inthefield-delivery': row.id,
          'x-inthefield-signature': `t=${stamp},v1=${signature}`,
          'user-agent': 'inthefield-webhook/1',
        },
        body,
        signal: AbortSignal.timeout(10_000),
      })
      const status = Number(response?.status)
      // 100~599 밖의 값은 HTTP 상태가 아니다. 그대로 적으면 shape 게이트가 그 행을 통째로 버리고,
      // 다음 읽기에서 dropped > 0이 되어 이 고객사의 발신이 전부 멈춘다.
      if (!Number.isInteger(status) || status < 100 || status > 599) return { outcome: 'failed', error: '응답을 읽지 못했습니다.' }
      if (status >= 200 && status < 300) return { outcome: 'delivered', status }
      if (status >= 300 && status < 400) return { outcome: 'gave-up', status, error: '리다이렉트는 따라가지 않습니다.' }
      if (status === 408 || status === 429 || status >= 500) return { outcome: 'failed', status, error: `받는 쪽 응답 ${status}` }
      return { outcome: 'gave-up', status, error: `받는 쪽 응답 ${status}` }
    } catch (error) {
      return { outcome: 'failed', error: errorText(error?.message ?? error) }
    }
  }

  async function sendChannel(tenantId, row) {
    if (!notificationDelivery?.has(row.channel)) return { outcome: 'gave-up', error: '이 알림 채널이 더 이상 설정되어 있지 않습니다.' }
    const notification = (notificationsOf(tenantId) ?? []).find((item) => item?.id === row.eventId) ?? null
    if (!notification) return { outcome: 'gave-up', error: '보낼 알림을 찾을 수 없습니다.' }
    const recipient = accounts.find((item) => item?.id === notification.recipientId && item.tenantId === tenantId) ?? null
    try {
      await notificationDelivery.send(row.channel, { notification, recipient, tenantId })
      return { outcome: 'delivered' }
    } catch (error) {
      return { outcome: 'failed', error: errorText(error?.message ?? error) }
    }
  }

  /** 실패 한 번의 결과를 행에 적는다. 여섯 번째 실패에서 포기한다. */
  function applyOutcome(row, result, now) {
    const at = now.toISOString()
    const status = Number.isInteger(result.status) && result.status >= 100 && result.status <= 599 ? result.status : null
    if (result.outcome === 'delivered') {
      return { ...row, status: 'delivered', attempts: row.attempts + 1, nextAttemptAt: null, lastStatusCode: status, lastError: null, deliveredAt: at }
    }
    const attempts = row.attempts + 1
    const error = errorText(result.error)
    if (result.outcome === 'gave-up' || attempts > BACKOFF_MS.length) {
      return { ...row, status: 'gave-up', attempts, nextAttemptAt: null, lastStatusCode: status, lastError: error }
    }
    return { ...row, status: 'failed', attempts, nextAttemptAt: new Date(now.getTime() + BACKOFF_MS[attempts - 1]).toISOString(), lastStatusCode: status, lastError: error }
  }

  async function runDrain(tenantId, now, limit) {
    const { rows, dropped } = deliveriesOf(tenantId)
    if (dropped > 0) return { sent: 0, gaveUp: 0 }
    const at = now.toISOString()
    const stored = endpointsOf(tenantId)
    // 엔드포인트 쪽이 깨져 있으면 보내지 않는다. 아래에서 성한 행만으로 목록을 다시 쓰기 때문에,
    // 여기서 진행하면 읽기에서 걸러진 그 행이 영영 사라진다.
    if (stored.dropped > 0) return { sent: 0, gaveUp: 0 }
    const endpoints = new Map(stored.rows.map((endpoint) => [endpoint.id, endpoint]))
    const due = rows.filter((row) => (row.status === 'pending' || row.status === 'failed')
      && (!row.nextAttemptAt || String(row.nextAttemptAt) <= at)
      && (row.channel !== 'webhook' || (endpoints.get(row.endpointId)?.enabled && !endpoints.get(row.endpointId)?.disabledAt)))
      // 저장 순서는 새것이 앞이다(기록 화면이 그 순서를 원한다). 보내는 순서는 반대여야 한다 —
      // 받는 쪽이 한동안 죽어 있다가 살아나면 밀린 상태 변경이 최신부터 도착해, 상태를 그대로
      // 옮겨 두는 구독자는 가장 오래된 값으로 끝난다.
      .sort((left, right) => String(left.requestedAt).localeCompare(String(right.requestedAt)))
      .slice(0, limit)
    if (!due.length) return { sent: 0, gaveUp: 0 }

    const updates = new Map()
    const endpointState = new Map()
    let sent = 0
    let gaveUp = 0
    for (const row of due) {
      const endpoint = row.channel === 'webhook' ? endpoints.get(row.endpointId) : null
      const result = row.channel === 'webhook'
        ? await sendWebhook(tenantId, endpoint, row, now)
        : await sendChannel(tenantId, row)
      const next = applyOutcome(row, result, now)
      updates.set(row.id, next)
      if (next.status === 'delivered') sent += 1
      if (next.status === 'gave-up') gaveUp += 1
      if (!endpoint) continue
      const state = endpointState.get(endpoint.id) ?? { failures: endpoint.consecutiveFailures, deliveredAt: endpoint.lastDeliveredAt }
      if (next.status === 'delivered') { state.failures = 0; state.deliveredAt = at }
      else state.failures += 1
      endpointState.set(endpoint.id, state)
    }

    // 보낸 뒤에 한 번만 쓴다. 그 사이 다른 요청이 행을 늘렸을 수 있으므로 id로 겹쳐 쓴다.
    const current = deliveriesOf(tenantId)
    if (current.dropped > 0) return { sent, gaveUp }
    const nextRows = current.rows.map((row) => updates.get(row.id) ?? row)
    // 저장 직전 자체검사. 여기서 걸리면 코드 결함이므로 쓰지 않는다 — 깨진 행을 남기면
    // 다음 읽기에서 dropped > 0이 되어 이 고객사의 발신이 통째로 멈춘다.
    if (!nextRows.every(hasDeliveryShape)) {
      logger.error?.('[webhook] 전달 결과가 저장 모양을 벗어나 쓰지 않았습니다.', { tenantId })
      return { sent, gaveUp }
    }
    const tenantStore = tenantStoreOf(tenantId)
    const disabled = []
    /**
     * 엔드포인트 레코드는 **바뀐 것이 있을 때만** 다시 쓴다.
     *
     * 알림톡·메일 행만 보낸 판에서는 endpointState가 비어 있어 map이 같은 객체를 돌려주는데,
     * 그래도 레코드를 갈아 끼우면 두 가지가 따라온다. 수신 토큰 색인은 신선도를 레코드 객체의
     * 동일성으로 판정하므로 다음 POST /api/hooks/:token 한 건이 전 고객사 색인을 다시 세우고,
     * 엔드포인트 테이블은 바뀐 행이 없는데도 매 드레인마다 다시 동기화된다.
     */
    let previousEndpoints = null
    let replacedEndpoints = false
    if (endpointState.size) {
      const latestEndpoints = endpointsOf(tenantId)
      if (latestEndpoints.dropped > 0) return { sent, gaveUp }
      const nextEndpoints = latestEndpoints.rows.map((endpoint) => {
        const state = endpointState.get(endpoint.id)
        if (!state) return endpoint
        const shouldDisable = state.failures >= DISABLE_AFTER_FAILURES && endpoint.enabled
        if (shouldDisable) disabled.push(endpoint)
        return {
          ...endpoint,
          consecutiveFailures: state.failures,
          lastDeliveredAt: state.deliveredAt,
          ...(shouldDisable ? { enabled: false, disabledAt: at } : {}),
          updatedAt: at,
        }
      })
      if (!nextEndpoints.every(hasEndpointShape)) {
        logger.error?.('[webhook] 전달 결과가 저장 모양을 벗어나 쓰지 않았습니다.', { tenantId })
        return { sent, gaveUp }
      }
      previousEndpoints = tenantStore[WEBHOOK_ENDPOINTS_KEY]
      replacedEndpoints = true
      tenantStore[WEBHOOK_ENDPOINTS_KEY] = { data: nextEndpoints, updatedAt: at, updatedBy: 'system:webhook' }
    }
    const previousDeliveries = tenantStore[WEBHOOK_DELIVERIES_KEY]
    tenantStore[WEBHOOK_DELIVERIES_KEY] = { data: nextRows, updatedAt: at, updatedBy: 'system:webhook' }
    try {
      await commitWorkspaceStore()
    } catch (error) {
      if (previousDeliveries) tenantStore[WEBHOOK_DELIVERIES_KEY] = previousDeliveries
      else delete tenantStore[WEBHOOK_DELIVERIES_KEY]
      if (replacedEndpoints) {
        if (previousEndpoints) tenantStore[WEBHOOK_ENDPOINTS_KEY] = previousEndpoints
        else delete tenantStore[WEBHOOK_ENDPOINTS_KEY]
      }
      logger.error?.('[webhook] 전달 결과를 저장하지 못했습니다.', { message: error?.message })
      return { sent, gaveUp }
    }
    for (const endpoint of disabled) {
      // 자동 중지는 사람이 고쳐야 풀린다. 그 사실을 아무도 모르면 연동은 조용히 끊긴 채로 남는다.
      notify(tenantId, accounts
        // '쓸 수 있는 계정인가'는 webhook-routes.mjs 한 곳에서 판정한다. 여기서 더하는 차원은 역할 하나다.
        .filter((item) => isAssignableAccount(item, tenantId) && item.role === 'tenant-admin')
        .map((admin) => ({
          type: 'webhook-disabled', recipientId: admin.id, actorId: null,
          title: `외부 연동이 중지됐습니다: ${endpoint.label}`,
          body: `연속 ${DISABLE_AFTER_FAILURES}회 실패해 자동으로 껐습니다. 주소를 고친 뒤 다시 켜 주세요.`,
          page: 'people', focusId: endpoint.id,
          source: { kind: 'webhook', id: endpoint.id, label: '외부 연동' },
        })))
    }
    return { sent, gaveUp }
  }

  const draining = new Set()
  /**
   * 드레인 중에 들어온 요청은 버리지 않고 '한 번 더 돌아 달라'로 남긴다.
   *
   * 그냥 돌아가면, 드레인이 도는 동안 적재된 사건은 이번 판의 due 목록에 없으므로 다음 정시 쓸기
   * (최대 한 시간 뒤)까지 기다린다. 받는 쪽 하나가 느리면 그 창은 밀리초가 아니라 몇 분이고,
   * Sites 배포에서는 scheduled()가 스케줄러를 돌리지 않아 그 그물이 아예 없다.
   */
  const rerun = new Set()
  async function drainWebhookDeliveries(tenantId, { now = clock(), limit = 100 } = {}) {
    if (!tenantId) return { sent: 0, gaveUp: 0 }
    if (draining.has(tenantId)) { rerun.add(tenantId); return { sent: 0, gaveUp: 0 } }
    draining.add(tenantId)
    const total = { sent: 0, gaveUp: 0 }
    try {
      let at = now
      // 횟수를 묶는다 — 상태가 바뀌지 않는 행이 남아 있어도 한 번의 kick이 무한히 이어지지 않게.
      for (let pass = 0; pass < 10; pass += 1) {
        const result = await runDrain(tenantId, at, limit)
        total.sent += result.sent
        total.gaveUp += result.gaveUp
        if (!rerun.delete(tenantId)) break
        at = clock()
      }
      rerun.delete(tenantId)
    } finally { draining.delete(tenantId) }
    return total
  }

  // 즉시 드레인은 요청을 붙잡지 않는다. 대신 진행 중인 것을 셀 수 있게 두어, 테스트가 기다릴 수 있게 한다.
  const inflight = new Set()
  function kick(tenantId) {
    const task = drainWebhookDeliveries(tenantId)
      .catch((error) => { logger.error?.('[webhook] 즉시 전달에 실패했습니다.', { message: error?.message }) })
      .finally(() => inflight.delete(task))
    inflight.add(task)
    return task
  }
  const settle = async () => { while (inflight.size) await Promise.all([...inflight]) }

  /**
   * 이미 커밋을 마친 자리에서 부르는 한 줄(공지 게시가 그렇다).
   * 적재하고, 커밋하고, 보낸다 — 어느 단계에서 실패해도 부른 쪽의 응답을 바꾸지 않는다.
   */
  function emitWebhookEvent(tenantId, eventType, payload) {
    try {
      const created = queueWebhookDeliveries(tenantId, eventType, payload ?? {})
      if (!created.length) return
      const task = commitWorkspaceStore()
      Promise.resolve(task)
        .then(() => kick(tenantId))
        .catch((error) => logger.error?.('[webhook] 사건을 적재하지 못했습니다.', { message: error?.message }))
    } catch (error) {
      logger.error?.('[webhook] 사건 적재 중 오류', { message: error?.message })
    }
  }

  /** 매시 쓸기. 즉시 드레인이 1차, 이것이 2차 그물이다. */
  async function sweepDeliveries(now = clock(), { limit = 100 } = {}) {
    const total = { sent: 0, gaveUp: 0 }
    for (const tenantId of Object.keys(workspaceStore.tenants ?? {})) {
      const result = await drainWebhookDeliveries(tenantId, { now, limit })
      total.sent += result.sent
      total.gaveUp += result.gaveUp
    }
    return total
  }

  return {
    queueWebhookDeliveries,
    queueChannelDeliveries,
    queueTestDelivery,
    drainWebhookDeliveries,
    sweepDeliveries,
    emitWebhookEvent,
    kick,
    settle,
  }
}

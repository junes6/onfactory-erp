/**
 * 서버 이벤트 스트림(SSE) — 새로고침 없이 화면을 따라오게 한다.
 *
 * 폴링을 대체하는 것이 목적이다. 채팅 5초 폴링, 알림 45초 폴링, 승인 대기 수 재조회가
 * 모두 이 스트림 하나로 바뀐다.
 *
 * 끊긴 동안의 변경은 Last-Event-ID로 따라잡는다. 각 테넌트마다 최근 이벤트를 잠깐 들고 있다가,
 * 재연결한 클라이언트가 마지막으로 본 번호를 알려 주면 그 뒤부터 한 번에 보낸다.
 * 보관분을 넘어서 끊겼던 클라이언트에게는 "전부 다시 읽어라"를 한 번 보낸다.
 */

export const EVENT_BUFFER_PER_TENANT = 200
export const HEARTBEAT_MS = 25_000

/** 이벤트 종류. 클라이언트는 모르는 종류를 무시한다. */
export const EVENT_KINDS = Object.freeze([
  'notification',      // 새 알림 (받는 사람에게만)
  'proposal',          // 승인 큐 변화
  'work',              // 업무 생성·상태 변경
  'message',           // 메신저 새 메시지
  'activity',          // 활동 피드 한 줄
  'resync',            // 놓친 구간이 커서 전체 재조회가 필요함
])

export function createEventStream({ clock = () => new Date(), logger = console } = {}) {
  /** tenantId → Set<client> */
  const clientsByTenant = new Map()
  /** tenantId → { nextId, events: [{ id, kind, accountId, data, at }] } */
  const buffers = new Map()
  let heartbeat = null

  const bufferOf = (tenantId) => {
    let buffer = buffers.get(tenantId)
    if (!buffer) { buffer = { nextId: 1, events: [] }; buffers.set(tenantId, buffer) }
    return buffer
  }

  const write = (client, event) => {
    // 받는 사람이 지정된 이벤트는 그 사람에게만 간다.
    if (event.accountId && event.accountId !== client.accountId) return
    try {
      client.response.write(`id: ${event.id}\nevent: ${event.kind}\ndata: ${JSON.stringify(event.data)}\n\n`)
      client.lastSentId = event.id
    } catch (error) {
      logger.warn?.('[events] 전송 실패', { message: error?.message })
    }
  }

  /**
   * 이벤트 발행. accountId를 주면 그 사람에게만 간다.
   * 발행은 절대 던지지 않는다 — 알림을 못 보낸 것이 업무를 막을 이유는 없다.
   */
  const publish = (tenantId, kind, data, { accountId = null } = {}) => {
    if (!tenantId || !EVENT_KINDS.includes(kind)) return null
    const buffer = bufferOf(tenantId)
    const event = { id: buffer.nextId, kind, accountId, data, at: clock().toISOString() }
    buffer.nextId += 1
    buffer.events.push(event)
    if (buffer.events.length > EVENT_BUFFER_PER_TENANT) buffer.events.splice(0, buffer.events.length - EVENT_BUFFER_PER_TENANT)
    for (const client of clientsByTenant.get(tenantId) ?? []) write(client, event)
    return event.id
  }

  /**
   * 재연결한 클라이언트가 놓친 구간을 돌려준다.
   * 보관분보다 더 오래 끊겼으면 개별 이벤트 대신 resync 한 건을 준다.
   */
  const missedSince = (tenantId, lastEventId) => {
    const buffer = buffers.get(tenantId)
    if (!buffer || !Number.isInteger(lastEventId) || lastEventId <= 0) return { events: [], resync: false }
    const oldest = buffer.events[0]?.id ?? buffer.nextId
    if (lastEventId + 1 < oldest) return { events: [], resync: true }
    return { events: buffer.events.filter((event) => event.id > lastEventId), resync: false }
  }

  const connect = ({ request, response, tenantId, accountId }) => {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // 프록시가 버퍼링하면 스트림이 아니라 한 덩어리가 된다.
      'x-accel-buffering': 'no',
    })
    const client = { accountId, response, lastSentId: 0 }
    const clients = clientsByTenant.get(tenantId) ?? new Set()
    clients.add(client)
    clientsByTenant.set(tenantId, clients)

    const buffer = bufferOf(tenantId)
    // 재연결 신호: 헤더가 표준, 쿼리는 EventSource를 쓸 수 없는 환경을 위한 대비.
    const headerId = Number.parseInt(String(request.get?.('last-event-id') ?? request.headers?.['last-event-id'] ?? ''), 10)
    const queryId = Number.parseInt(String(request.query?.lastEventId ?? ''), 10)
    const lastEventId = Number.isInteger(headerId) ? headerId : queryId
    const missed = missedSince(tenantId, lastEventId)
    response.write(`retry: 3000\n\n`)
    if (missed.resync) {
      write(client, { id: buffer.nextId - 1, kind: 'resync', accountId: null, data: { reason: '연결이 오래 끊겨 전체를 다시 불러옵니다.' } })
    } else {
      for (const event of missed.events) write(client, event)
    }
    // 연결 직후 현재 번호를 알려 두면, 다음 재연결 때 이 번호부터 이어받는다.
    client.lastSentId = Math.max(client.lastSentId, buffer.nextId - 1)
    response.write(`event: ready\ndata: ${JSON.stringify({ lastEventId: client.lastSentId })}\n\n`)

    const close = () => {
      clients.delete(client)
      if (!clients.size) clientsByTenant.delete(tenantId)
    }
    request.on?.('close', close)
    return { close, client }
  }

  const start = () => {
    if (heartbeat) return
    // 주석 프레임. 프록시·브라우저가 유휴 연결을 끊는 것을 막는다.
    heartbeat = setInterval(() => {
      for (const clients of clientsByTenant.values()) {
        for (const client of clients) {
          try { client.response.write(': keep-alive\n\n') } catch { /* 다음 발행에서 정리된다 */ }
        }
      }
    }, HEARTBEAT_MS)
    heartbeat.unref?.()
  }

  const stop = () => {
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = null
    for (const clients of clientsByTenant.values()) {
      for (const client of clients) { try { client.response.end() } catch { /* 이미 닫힘 */ } }
    }
    clientsByTenant.clear()
  }

  return {
    publish,
    connect,
    missedSince,
    start,
    stop,
    clientCount: (tenantId) => (tenantId ? clientsByTenant.get(tenantId)?.size ?? 0 : [...clientsByTenant.values()].reduce((sum, set) => sum + set.size, 0)),
  }
}

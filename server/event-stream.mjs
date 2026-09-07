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
  // R16-E: 구글 캘린더 동기화가 일정 배열을 갈아 끼웠다. 아래 제한 분기의 허용 목록에는 넣지 않는다 —
  // 가져온 일정은 개인 범위라 외부 게스트에게 갈 이유가 없다.
  'calendar',          // 일정 배열이 서버 쪽에서 바뀜
  // R16-H: 문서 블록 변경·메타 변경·프레즌스. 프레즌스는 publishEphemeral로 나가 버퍼에 쌓이지 않는다.
  // 아래 제한 분기의 허용 목록에는 넣지 않는다 — 이번 절에서 게스트에게 문서를 열지 않는다.
  'wiki',              // 문서 블록 변경·프레즌스
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
    // 수신자 명단이 붙은 이벤트는 그 명단 안에서만 간다. 테넌트 전원이 읽을 수 없는 것(프로젝트
    // 문서 같은)의 신호는 id·이름만으로도 존재를 말하므로, 발행하는 쪽이 명단을 함께 준다.
    // 버퍼에 그대로 남으므로 재연결 재생에도 같은 걸음으로 걸린다.
    if (event.accountIds && !event.accountIds.includes(client.accountId)) return
    // 제한 클라이언트(외부 게스트): 본인 앞으로 온 것이 아니면 message·work 두 종류만, 내용은 key·version만 받는다.
    // 테넌트 전체에 뿌리는 work 이벤트에는 업무 제목이 실리는데, 그 제목은 게스트가 볼 수 없는 업무의 것일 수 있다.
    // resync는 "전부 다시 읽어라"라는 신호일 뿐 테넌트 데이터가 없으므로 그대로 보낸다 — 막으면 오래 끊긴 게스트 화면이 재조회 신호를 못 받는다.
    if (client.restricted && !event.accountId && event.kind !== 'resync') {
      if (!['message', 'work'].includes(event.kind)) return
      event = { ...event, data: { key: event.data?.key ?? null, version: event.data?.version ?? null } }
    }
    try {
      client.response.write(`id: ${event.id}\nevent: ${event.kind}\ndata: ${JSON.stringify(event.data)}\n\n`)
      client.lastSentId = event.id
    } catch (error) {
      logger.warn?.('[events] 전송 실패', { message: error?.message })
    }
  }

  /**
   * 이벤트 발행. accountId를 주면 그 사람에게만, accountIds를 주면 그 명단에게만 간다
   * (명단이 빈 배열이면 아무에게도 가지 않는다 — '지금 이것을 읽을 수 있는 사람이 없다'는 뜻이다).
   * 발행은 절대 던지지 않는다 — 알림을 못 보낸 것이 업무를 막을 이유는 없다.
   */
  const publish = (tenantId, kind, data, { accountId = null, accountIds = null } = {}) => {
    if (!tenantId || !EVENT_KINDS.includes(kind)) return null
    const buffer = bufferOf(tenantId)
    const event = { id: buffer.nextId, kind, accountId, accountIds, data, at: clock().toISOString() }
    buffer.nextId += 1
    buffer.events.push(event)
    if (buffer.events.length > EVENT_BUFFER_PER_TENANT) buffer.events.splice(0, buffer.events.length - EVENT_BUFFER_PER_TENANT)
    for (const client of clientsByTenant.get(tenantId) ?? []) write(client, event)
    return event.id
  }

  /**
   * 버퍼에 남기지 않고 지금 붙어 있는 사람에게만 보낸다.
   * 프레즌스처럼 '지난 것은 뜻이 없는' 신호 전용이다.
   *
   * 이것을 publish로 보내면 테넌트당 200칸 링버퍼가 몇 분 만에 밀려, 잠깐 끊겼던 다른 화면 전부가
   * resync를 받아 전체 재조회를 한다 — 업무·알림 신호가 편집 신호에 밀려나는 셈이다.
   *
   * id는 마지막 실제 이벤트 번호를 그대로 쓴다(connect의 resync 발행과 같은 관행) —
   * 번호를 앞당기면 재연결 커서가 진짜 이벤트를 건너뛴다.
   */
  const publishEphemeral = (tenantId, kind, data, { accountId = null, accountIds = null } = {}) => {
    if (!tenantId || !EVENT_KINDS.includes(kind)) return false
    const event = { id: bufferOf(tenantId).nextId - 1, kind, accountId, accountIds, data, at: clock().toISOString() }
    for (const client of clientsByTenant.get(tenantId) ?? []) write(client, event)
    return true
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

  const connect = ({ request, response, tenantId, accountId, restricted = false }) => {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // 프록시가 버퍼링하면 스트림이 아니라 한 덩어리가 된다.
      'x-accel-buffering': 'no',
    })
    const client = { accountId, response, lastSentId: 0, restricted: restricted === true }
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
    publishEphemeral,
    connect,
    missedSince,
    start,
    stop,
    clientCount: (tenantId) => (tenantId ? clientsByTenant.get(tenantId)?.size ?? 0 : [...clientsByTenant.values()].reduce((sum, set) => sum + set.size, 0)),
  }
}

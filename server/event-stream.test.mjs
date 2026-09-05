import assert from 'node:assert/strict'
import test from 'node:test'

import { createEventStream, EVENT_BUFFER_PER_TENANT } from './event-stream.mjs'

/** 실제 응답 대신 쓰기 내용을 모으는 가짜 소켓. */
function fakeClient() {
  const chunks = []
  const handlers = {}
  return {
    request: { get: () => undefined, headers: {}, query: {}, on: (name, fn) => { handlers[name] = fn } },
    response: { writeHead() {}, write: (chunk) => chunks.push(chunk), end() {} },
    chunks,
    fire: (name) => handlers[name]?.(),
    /** 보낸 프레임을 {id, kind, data}로 파싱한다 (하트비트·retry 제외). */
    frames() {
      return chunks.join('').split('\n\n').filter(Boolean).map((frame) => {
        const id = frame.match(/^id: (\d+)$/m)?.[1]
        const kind = frame.match(/^event: (\S+)$/m)?.[1]
        const data = frame.match(/^data: (.*)$/m)?.[1]
        return { id: id ? Number(id) : null, kind, data: data ? JSON.parse(data) : null }
      }).filter((frame) => frame.kind)
    },
  }
}

const connectClient = (stream, { tenantId = 'T1', accountId = 'U1', lastEventId = null } = {}) => {
  const fake = fakeClient()
  if (lastEventId !== null) fake.request.headers['last-event-id'] = String(lastEventId)
  const handle = stream.connect({ request: fake.request, response: fake.response, tenantId, accountId })
  return { ...fake, handle }
}

test('a connected client receives events for its tenant only', () => {
  const stream = createEventStream()
  const mine = connectClient(stream, { tenantId: 'T1' })
  const other = connectClient(stream, { tenantId: 'T2' })

  stream.publish('T1', 'work', { id: 'WK-1' })
  assert.deepEqual(mine.frames().filter((f) => f.kind === 'work').map((f) => f.data), [{ id: 'WK-1' }])
  assert.deepEqual(other.frames().filter((f) => f.kind === 'work'), [], '다른 고객사에는 새지 않는다')
})

test('an event addressed to one account is not delivered to a colleague', () => {
  const stream = createEventStream()
  const me = connectClient(stream, { accountId: 'U1' })
  const colleague = connectClient(stream, { accountId: 'U2' })

  stream.publish('T1', 'notification', { title: '내 알림' }, { accountId: 'U1' })
  stream.publish('T1', 'proposal', { pending: 3 })

  assert.deepEqual(me.frames().filter((f) => f.kind === 'notification').length, 1)
  assert.deepEqual(colleague.frames().filter((f) => f.kind === 'notification').length, 0)
  // 받는 사람이 없는 이벤트는 둘 다 받는다.
  assert.equal(me.frames().filter((f) => f.kind === 'proposal').length, 1)
  assert.equal(colleague.frames().filter((f) => f.kind === 'proposal').length, 1)
})

test('reconnecting with Last-Event-ID replays exactly what was missed, once', () => {
  const stream = createEventStream()
  const first = connectClient(stream)
  stream.publish('T1', 'work', { seq: 1 })
  stream.publish('T1', 'work', { seq: 2 })
  const lastSeen = Number(first.frames().at(-1).id)
  first.fire('close')

  // 끊긴 동안 두 건 더 발생.
  stream.publish('T1', 'work', { seq: 3 })
  stream.publish('T1', 'message', { seq: 4 })

  const resumed = connectClient(stream, { lastEventId: lastSeen })
  const replay = resumed.frames().filter((f) => f.kind !== 'ready')
  assert.deepEqual(replay.map((f) => f.data.seq), [3, 4], '놓친 것만, 순서대로')
  assert.equal(replay.filter((f) => f.kind === 'resync').length, 0)

  // 이어서 발행되는 것은 한 번만 온다.
  stream.publish('T1', 'work', { seq: 5 })
  const after = resumed.frames().filter((f) => f.kind !== 'ready')
  assert.deepEqual(after.map((f) => f.data.seq), [3, 4, 5])
})

test('a client gone longer than the buffer is told to reload everything instead of getting a gap', () => {
  const stream = createEventStream()
  const first = connectClient(stream)
  stream.publish('T1', 'work', { seq: 0 })
  const lastSeen = Number(first.frames().at(-1).id)
  first.fire('close')

  for (let index = 0; index < EVENT_BUFFER_PER_TENANT + 10; index += 1) stream.publish('T1', 'work', { seq: index + 1 })

  const resumed = connectClient(stream, { lastEventId: lastSeen })
  const frames = resumed.frames().filter((f) => f.kind !== 'ready')
  assert.equal(frames.length, 1)
  assert.equal(frames[0].kind, 'resync', '구간을 조용히 빠뜨리지 않는다')
  assert.match(frames[0].data.reason, /다시 불러옵니다/)
})

test('a first-time connection is not replayed the whole backlog', () => {
  const stream = createEventStream()
  for (let index = 0; index < 5; index += 1) stream.publish('T1', 'work', { seq: index })
  const fresh = connectClient(stream)
  const frames = fresh.frames()
  assert.deepEqual(frames.filter((f) => f.kind === 'work'), [], '처음 붙는 클라이언트에게 과거를 쏟아붓지 않는다')
  assert.equal(frames.at(-1).kind, 'ready')
  assert.equal(frames.at(-1).data.lastEventId, 5, '지금 번호를 알려 다음 재연결의 기준을 만든다')
})

test('the buffer is bounded and unknown event kinds are refused', () => {
  const stream = createEventStream()
  for (let index = 0; index < EVENT_BUFFER_PER_TENANT + 50; index += 1) stream.publish('T1', 'work', { seq: index })
  const missed = stream.missedSince('T1', 1)
  assert.equal(missed.resync, true)
  assert.equal(stream.publish('T1', 'unknown-kind', {}), null)
  assert.equal(stream.publish('', 'work', {}), null)
})

test('closing a connection stops delivery and frees the tenant entry', () => {
  const stream = createEventStream()
  const client = connectClient(stream)
  assert.equal(stream.clientCount('T1'), 1)
  const before = client.frames().length
  client.fire('close')
  assert.equal(stream.clientCount('T1'), 0)
  stream.publish('T1', 'work', { seq: 9 })
  assert.equal(client.frames().length, before, '끊긴 클라이언트에는 더 쓰지 않는다')
})

test('a restricted (guest) client gets only message/work kinds, stripped to key/version, unless the event is addressed to it', () => {
  const stream = createEventStream()
  const fake = fakeClient()
  const guest = { ...fake, handle: stream.connect({ request: fake.request, response: fake.response, tenantId: 'T1', accountId: 'G1', restricted: true }) }
  const employee = connectClient(stream, { accountId: 'U1' })

  stream.publish('T1', 'work', { id: 'WK-1', status: '수행중', title: '비밀 업무 제목' })
  stream.publish('T1', 'message', { key: 'messenger-conversations', version: 'v7', conversationId: 'grp-1' })
  stream.publish('T1', 'proposal', { pending: 3 })
  stream.publish('T1', 'activity', { title: '누군가 무엇을 했다' })
  stream.publish('T1', 'notification', { title: '게스트 본인 알림' }, { accountId: 'G1' })

  const kinds = guest.frames().map((frame) => frame.kind)
  assert.deepEqual(kinds.filter((kind) => kind !== 'ready'), ['work', 'message', 'notification'], '제안·활동은 게스트에게 가지 않는다')
  assert.deepEqual(guest.frames().find((frame) => frame.kind === 'work').data, { key: null, version: null }, '업무 제목이 벗겨진다')
  assert.deepEqual(guest.frames().find((frame) => frame.kind === 'message').data, { key: 'messenger-conversations', version: 'v7' }, '대화 id도 내려가지 않는다')
  assert.deepEqual(guest.frames().find((frame) => frame.kind === 'notification').data, { title: '게스트 본인 알림' }, '본인 앞으로 온 것은 그대로')
  assert.ok(!guest.chunks.join('').includes('비밀 업무 제목'))
  // 직원은 예전과 똑같이 전부 받는다.
  assert.equal(employee.frames().find((frame) => frame.kind === 'work').data.title, '비밀 업무 제목')
  assert.equal(employee.frames().filter((frame) => frame.kind === 'proposal').length, 1)

  // 보관분을 넘어 끊겼던 게스트에게는 resync가 그대로 간다 — 재조회 신호에는 테넌트 데이터가 없다.
  for (let index = 0; index < EVENT_BUFFER_PER_TENANT + 5; index += 1) stream.publish('T1', 'work', { key: 'work-items', version: `v${index}` })
  const late = fakeClient()
  late.request.headers['last-event-id'] = '1'
  stream.connect({ request: late.request, response: late.response, tenantId: 'T1', accountId: 'G2', restricted: true })
  const resync = late.frames().find((frame) => frame.kind === 'resync')
  assert.ok(resync, '제한 클라이언트도 resync를 받는다')
  assert.deepEqual(Object.keys(resync.data), ['reason'])
})

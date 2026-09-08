import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { scryptSync } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createApp } from './app.mjs'
import { pushDecision } from './notifications.mjs'
import { withServer } from './test-server.mjs'

/**
 * 스레드 라우트 — 본채널은 "답글 N개"만, 이야기는 옆 칸에서 이어진다.
 *
 * 이 시험이 지키는 문장 셋:
 *  1. 답글은 본채널의 어느 목록에도 새지 않는다(페이지·미리보기·고정).
 *  2. 스레드는 전용 라우트에서만 생긴다(일반 저장 경로는 네 필드를 거절한다).
 *  3. 스레드 답글 알림은 그 스레드에 있던 사람에게만 간다.
 */

const ADMIN = { email: 'admin@sunsea.co.kr', password: 'demo1234' }
const PARK = { email: 'jihyun.park@sunsea.co.kr', password: 'demo1234' }
const OH = { email: 'taesik.oh@sunsea.co.kr', password: 'demo1234' }

async function signIn(origin, who) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: 'tenant', ...who }),
  })
  assert.equal(response.status, 200, `${who.email} 로그인 실패`)
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

/** 각 시험은 자기 저장소를 쓴다. 방을 만들고 답글을 쌓는 시험이라 서로 간섭하면 안 된다. */
async function withApp(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'messenger-threads-'))
  try {
    const app = createApp({ apiKey: '', workspaceStoreFile: path.join(directory, 'state.json'), documentUploadDirectory: path.join(directory, 'documents') })
    await withServer(app, run)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** 저장소를 직접 심는다. 참여자 명단이 없는 옛 방처럼 라우트로는 만들 수 없는 모양이 있다. */
async function withStore(store, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'messenger-threads-store-'))
  try {
    const app = createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {}, documentUploadDirectory: path.join(directory, 'documents') })
    await withServer(app, run)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const json = async (response) => {
  const text = await response.text()
  try { return JSON.parse(text) } catch { return { raw: text } }
}

const send = async (origin, session, id, body) => {
  const response = await fetch(`${origin}/api/messenger/conversations/${id}/messages`, {
    method: 'POST', headers: session.headers, body: JSON.stringify(body),
  })
  return { status: response.status, body: await json(response) }
}

const get = async (origin, session, route) => {
  const response = await fetch(`${origin}${route}`, { headers: session.headers })
  return { status: response.status, body: await json(response) }
}

const post = async (origin, session, route, body) => {
  const response = await fetch(`${origin}${route}`, {
    method: 'POST', headers: session.headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: response.status, body: await json(response) }
}

async function makeRoom(origin, session, body) {
  const response = await fetch(`${origin}/api/messenger/conversations/group`, {
    method: 'POST', headers: session.headers, body: JSON.stringify(body),
  })
  assert.equal(response.status, 201, '그룹방 생성 실패')
  return (await response.json()).conversation
}

/** 루트 하나가 있는 방 하나. 대부분의 시험이 여기서 시작한다. */
async function roomWithRoot(origin, admin, participantIds) {
  const room = await makeRoom(origin, admin, { name: '스레드 방', participantIds })
  const first = await send(origin, admin, room.id, { text: '본채널 첫 말' })
  assert.equal(first.status, 201)
  return { room, root: first.body.message }
}

const rawConversations = async (origin, session) =>
  (await get(origin, session, '/api/workspace/messenger-conversations')).body.data

const notificationsOf = async (origin, session) => (await get(origin, session, '/api/notifications')).body.items ?? []

// ─────────────────────── 답글과 본채널의 분리 ───────────────────────

test('답글은 루트의 집계만 올리고 채널의 마지막 말은 건드리지 않는다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)
    const { room, root } = await roomWithRoot(origin, admin, [park.account.id])

    const reply = await send(origin, park, room.id, { text: '스레드 안의 말', threadRootId: root.id })
    assert.equal(reply.status, 201)
    assert.equal(reply.body.message.threadRootId, root.id)

    const updatedRoot = reply.body.conversation.messages.find((item) => item.id === root.id)
    assert.equal(updatedRoot.replyCount, 1)
    assert.equal(updatedRoot.lastReplyAt, reply.body.message.createdAt)
    assert.equal(reply.body.conversation.lastMessage, '본채널 첫 말', '채널 미리보기는 답글로 바뀌지 않는다')
    assert.equal(reply.body.conversation.lastTime, root.time)

    const second = await send(origin, admin, room.id, { text: '두 번째 답글', threadRootId: root.id })
    assert.equal(second.status, 201)
    assert.equal(second.body.conversation.messages.find((item) => item.id === root.id).replyCount, 2)
  })
})

test('본채널 페이지에는 답글이 없고 total·before 커서도 본채널 기준이다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const { room, root } = await roomWithRoot(origin, admin, [])
    await send(origin, admin, room.id, { text: '답글 1', threadRootId: root.id })
    const secondMain = await send(origin, admin, room.id, { text: '본채널 둘째 말' })
    await send(origin, admin, room.id, { text: '답글 2', threadRootId: root.id })

    const page = await get(origin, admin, `/api/messenger/conversations/${room.id}/messages`)
    assert.equal(page.status, 200)
    assert.deepEqual(page.body.messages.map((item) => item.text), ['본채널 첫 말', '본채널 둘째 말'])
    assert.equal(page.body.total, 2, 'total은 본채널 건수다')
    assert.equal(page.body.hasMore, false)
    assert.equal(Object.keys(page.body.readSummaries).length, 2)

    const before = await get(origin, admin, `/api/messenger/conversations/${room.id}/messages?before=${encodeURIComponent(secondMain.body.message.id)}`)
    assert.deepEqual(before.body.messages.map((item) => item.text), ['본채널 첫 말'], 'before 커서는 본채널 배열 위에서 센다')
  })
})

test('스레드 조회는 실제 배열에서 다시 세고, 화면이 읽지 않는 것은 싣지 않는다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)
    const { room, root } = await roomWithRoot(origin, admin, [park.account.id])
    await send(origin, park, room.id, { text: '답글 하나', threadRootId: root.id })
    await send(origin, park, room.id, { text: '답글 둘', threadRootId: root.id })

    const thread = await get(origin, admin, `/api/messenger/conversations/${room.id}/messages/${root.id}/thread`)
    assert.equal(thread.status, 200)
    assert.equal(thread.body.root.id, root.id)
    assert.equal(thread.body.replies.length, 2)
    assert.equal(thread.body.root.replyCount, 2, '저장된 집계와 실제 답글 수가 같다')
    assert.equal(thread.body.liveReplyCount, 2, '살아 있는 답글 수도 함께 준다 — 화면의 [채널에 공유]가 이 수로 켜진다')
    // 응답은 화면이 그리는 세 칸뿐이다. 참여자 명단은 공유·승격 403이 서버 안에서 쓰는 사실이고,
    // 읽음 요약은 본채널의 것이며, 답글 수·마지막 시각은 본채널 요약 줄이 대화 배열에서 직접 읽는 값이다 —
    // 아무도 읽지 않는 필드를 계약에 남기지 않는다.
    assert.deepEqual(
      Object.keys(thread.body).sort(),
      ['liveReplyCount', 'replies', 'root'],
    )

    const missing = await get(origin, admin, `/api/messenger/conversations/${room.id}/messages/m-none/thread`)
    assert.equal(missing.status, 404)
    assert.equal(missing.body.error.code, 'MESSAGE_NOT_FOUND')
  })
})

test('방을 여는 것은 본채널을 보는 일이다 — /read는 답글의 읽음을 찍지 않는다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)
    const { room, root } = await roomWithRoot(origin, admin, [park.account.id])
    const reply = await send(origin, admin, room.id, { text: '스레드 안의 말', threadRootId: root.id })

    // 박지현은 채널만 연다. 스레드는 열지 않았다.
    assert.equal((await post(origin, park, `/api/messenger/conversations/${room.id}/read`)).status, 200)

    const thread = await get(origin, admin, `/api/messenger/conversations/${room.id}/messages/${root.id}/thread`)
    assert.deepEqual(thread.body.root.readBy.includes(park.account.id), true, '본채널의 말은 읽은 것이 맞다')
    assert.deepEqual(
      thread.body.replies.find((item) => item.id === reply.body.message.id).readBy,
      [admin.account.id],
      '들어가 본 적 없는 사람이 읽었다고 말하지 않는다',
    )
  })
})

test('루트를 지워도 스레드는 열린다 — 답글은 다른 사람의 말이다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)
    const { room, root } = await roomWithRoot(origin, admin, [park.account.id])
    assert.equal((await send(origin, park, room.id, { text: '남의 답글', threadRootId: root.id })).status, 201)

    const removed = await fetch(`${origin}/api/messenger/conversations/${room.id}/messages/${root.id}`, { method: 'DELETE', headers: admin.headers })
    assert.equal(removed.status, 200)

    const thread = await get(origin, park, `/api/messenger/conversations/${room.id}/messages/${root.id}/thread`)
    assert.equal(thread.status, 200, '루트의 tombstone은 남고, 그 아래 답글도 남는다')
    assert.ok(thread.body.root.deletedAt, '루트는 삭제된 자리로 그려진다')
    assert.deepEqual(thread.body.replies.map((item) => item.text), ['남의 답글'])

    // 방 안 검색이 여전히 그 답글을 찾아 주므로(스레드 갈래), 열 수 없으면 누를 수 없는 결과가 된다.
    const search = await get(origin, park, `/api/messenger/conversations/${room.id}/search?q=${encodeURIComponent('남의')}`)
    assert.equal(search.body.matches[0].threadRootId, root.id)

    // 다만 새 답글은 붙이지 않는다 — 쓰기 판정은 여전히 삭제를 본다. 낱말은 '없다'가 아니라 '지워졌다'다:
    // 그 스레드는 지금 화면에 열려 있으므로 '찾을 수 없습니다'는 화면과 서버가 다른 말을 하는 문장이 된다.
    const late = await send(origin, park, room.id, { text: '지운 뒤의 답글', threadRootId: root.id })
    assert.equal(late.status, 400)
    assert.equal(late.body.error.code, 'THREAD_ROOT_DELETED')
    assert.match(late.body.error.message, /지워진 말에는 답글을 달 수 없습니다/)

    // 승격은 남아 있는 말만 옮겨 적는다. tombstone이 맨 앞에 오면 자동 제목이 '삭제된 메시지'가 되어
    // 아무도 읽을 수 없는 말의 이름을 단 업무가 승인 큐에 선다.
    const promoted = await post(origin, park, `/api/messenger/conversations/${room.id}/threads/${root.id}/promote`, { kind: 'task' })
    assert.equal(promoted.status, 201)
    const created = (await get(origin, admin, '/api/workspace/work-items')).body.data.find((item) => item.id === promoted.body.created.id)
    assert.equal(created.description, '남의 답글')
    assert.ok(!created.title.includes('삭제된 메시지'), '지워진 루트가 업무의 이름이 되지 않는다')
  })
})

test('스레드 루트가 될 수 없는 것은 전부 400이다 — 답글·삭제된 말·다른 방의 말', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const { room, root } = await roomWithRoot(origin, admin, [])
    const reply = await send(origin, admin, room.id, { text: '답글', threadRootId: root.id })
    const removable = await send(origin, admin, room.id, { text: '곧 지울 말' })
    const removed = await fetch(`${origin}/api/messenger/conversations/${room.id}/messages/${removable.body.message.id}`, {
      method: 'DELETE', headers: admin.headers,
    })
    assert.equal(removed.status, 200)

    const other = await roomWithRoot(origin, admin, [])

    for (const [label, target, code] of [
      ['답글의 답글', reply.body.message.id, 'INVALID_THREAD_ROOT'],
      // 지워진 말만 낱말이 다르다. 그 스레드는 읽기로는 열리므로(threadReadViolation) '없다'고 말하면
      // 눈앞에 열린 화면과 서버가 서로 다른 말을 한다.
      ['삭제된 말', removable.body.message.id, 'THREAD_ROOT_DELETED'],
      ['다른 방의 말', other.root.id, 'INVALID_THREAD_ROOT'],
      ['없는 말', 'm-nope', 'INVALID_THREAD_ROOT'],
    ]) {
      const attempt = await send(origin, admin, room.id, { text: '시도', threadRootId: target })
      assert.equal(attempt.status, 400, label)
      assert.equal(attempt.body.error.code, code, label)
    }
  })
})

test('스레드 안의 인용은 그 스레드 안만 가리킬 수 있다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const { room, root } = await roomWithRoot(origin, admin, [])
    const outside = await send(origin, admin, room.id, { text: '본채널의 다른 말' })
    const inside = await send(origin, admin, room.id, { text: '첫 답글', threadRootId: root.id })

    const toRoot = await send(origin, admin, room.id, { text: '루트 인용', threadRootId: root.id, replyTo: root.id })
    assert.equal(toRoot.status, 201, '루트 자신은 인용할 수 있다')
    const toSibling = await send(origin, admin, room.id, { text: '형제 인용', threadRootId: root.id, replyTo: inside.body.message.id })
    assert.equal(toSibling.status, 201)

    const toOutside = await send(origin, admin, room.id, { text: '바깥 인용', threadRootId: root.id, replyTo: outside.body.message.id })
    assert.equal(toOutside.status, 400)
    assert.equal(toOutside.body.error.code, 'INVALID_REPLY_TARGET')
  })
})

test('본채널 메시지는 답글을 인용할 수 없다 — 인용 줄로 답글 본문이 새어 나간다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const { room, root } = await roomWithRoot(origin, admin, [])
    const inside = await send(origin, admin, room.id, { text: '스레드 안에서만 한 말', threadRootId: root.id })

    const leak = await send(origin, admin, room.id, { text: '이거 맞나요?', replyTo: inside.body.message.id })
    assert.equal(leak.status, 400, '본채널에 남기기로 한 것은 답글 N개뿐이다')
    assert.equal(leak.body.error.code, 'INVALID_REPLY_TARGET')

    const page = await get(origin, admin, `/api/messenger/conversations/${room.id}/messages`)
    assert.deepEqual(page.body.messages.map((item) => item.text), ['본채널 첫 말'])

    const ok = await send(origin, admin, room.id, { text: '루트 인용은 된다', replyTo: root.id })
    assert.equal(ok.status, 201)
  })
})

test('개발운영진 지원 채널에는 스레드를 열 수 없다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const opened = await post(origin, admin, '/api/messenger/conversations/direct', { participantId: 'SYS-DEVELOPER-OPS' })
    assert.equal(opened.status, 201)
    const support = opened.body.conversation
    const first = await send(origin, admin, support.id, { text: '지원 요청합니다' })
    assert.equal(first.status, 201)

    const attempt = await send(origin, admin, support.id, { text: '스레드 시도', threadRootId: first.body.message.id })
    assert.equal(attempt.status, 403)
    assert.equal(attempt.body.error.code, 'SYSTEM_CONVERSATION_IMMUTABLE')
  })
})

test('스레드 답글은 고정할 수 없다 — 고정 스트립은 본채널 화면이다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const { room, root } = await roomWithRoot(origin, admin, [])
    const reply = await send(origin, admin, room.id, { text: '답글', threadRootId: root.id })

    const pinReply = await post(origin, admin, `/api/messenger/conversations/${room.id}/messages/${reply.body.message.id}/pin`, { pinned: true })
    assert.equal(pinReply.status, 409)
    assert.equal(pinReply.body.error.code, 'THREAD_REPLY_NOT_PINNABLE')

    const pinRoot = await post(origin, admin, `/api/messenger/conversations/${room.id}/messages/${root.id}/pin`, { pinned: true })
    assert.equal(pinRoot.status, 200)
    assert.deepEqual(pinRoot.body.pinnedMessageIds, [root.id])
  })
})

test('배열의 마지막이 답글이어도 그 답글을 고치거나 지우면 채널 미리보기는 그대로다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const { room, root } = await roomWithRoot(origin, admin, [])
    const reply = await send(origin, admin, room.id, { text: '마지막 원소인 답글', threadRootId: root.id })

    const edited = await fetch(`${origin}/api/messenger/conversations/${room.id}/messages/${reply.body.message.id}`, {
      method: 'PATCH', headers: admin.headers, body: JSON.stringify({ text: '고친 답글' }),
    })
    assert.equal(edited.status, 200)
    let room1 = (await rawConversations(origin, admin)).find((item) => item.id === room.id)
    assert.equal(room1.lastMessage, '본채널 첫 말', '답글 수정이 채널 미리보기를 갈아 끼우지 않는다')

    const deleted = await fetch(`${origin}/api/messenger/conversations/${room.id}/messages/${reply.body.message.id}`, {
      method: 'DELETE', headers: admin.headers,
    })
    assert.equal(deleted.status, 200)
    room1 = (await rawConversations(origin, admin)).find((item) => item.id === room.id)
    assert.equal(room1.lastMessage, '본채널 첫 말', '답글 삭제도 마찬가지다')
    const tombstone = room1.messages.find((item) => item.id === reply.body.message.id)
    assert.equal(tombstone.threadRootId, root.id, '삭제 흔적은 어느 스레드의 것이었는지를 잃지 않는다')
  })
})

// ─────────────────────────── 알림 ───────────────────────────

test('스레드 답글은 그 스레드에 있던 사람에게만 간다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)
    const oh = await signIn(origin, OH)
    const { room, root } = await roomWithRoot(origin, admin, [park.account.id, oh.account.id])

    // 박지현이 먼저 답한다 → 스레드 참여자는 관리자·박지현.
    assert.equal((await send(origin, park, room.id, { text: '첫 답글', threadRootId: root.id })).status, 201)
    assert.equal((await send(origin, admin, room.id, { text: `둘째 답글 @${park.account.name}`, threadRootId: root.id })).status, 201)

    const parkRows = await notificationsOf(origin, park)
    const threadRows = parkRows.filter((item) => item.type === 'thread-reply')
    assert.equal(threadRows.length, 1, '루트 작성자의 답글 한 건만 온다')
    assert.equal(threadRows[0].focusId, `${room.id}:thread:${root.id}`)
    assert.equal(threadRows[0].source.kind, 'message', '방별 무음이 그대로 적용되는 종류다')
    assert.equal(threadRows[0].source.id, room.id)
    assert.equal(parkRows.some((item) => item.type === 'mention'), true, '스레드 안의 @멘션은 mention도 함께 나간다')

    const ohRows = await notificationsOf(origin, oh)
    assert.equal(ohRows.filter((item) => item.type === 'thread-reply').length, 0, '방에 있어도 스레드에 없으면 오지 않는다')

    const adminRows = await notificationsOf(origin, admin)
    assert.equal(adminRows.filter((item) => item.type === 'thread-reply' && item.actorId === admin.account.id).length, 0, '자기 답글은 자기에게 알리지 않는다')
  })
})

test('스레드 안의 말은 멘션도 스레드를 가리키고, 지시 문형이어도 승인 큐를 만들지 않는다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)
    const oh = await signIn(origin, OH)
    const { room, root } = await roomWithRoot(origin, admin, [park.account.id, oh.account.id])

    const before = (await get(origin, admin, '/api/proposals')).body.proposals.length
    // 오태식은 이 스레드에 없다. 이름을 부르면 멘션은 가되, 그 말이 사는 자리를 가리켜야 한다 —
    // 방 id 하나만 실으면 눌러도 서랍만 열리고 그 말은 본채널 어디에도 없다.
    assert.equal((await send(origin, park, room.id, { text: `@${oh.account.name} 내일까지 견적서 보내주세요`, threadRootId: root.id })).status, 201)

    // 방 초대도 같은 type('mention')을 쓴다 — 말 안의 @는 source.kind가 'message'인 쪽이다.
    const mentionsOf = async (session) => (await notificationsOf(origin, session))
      .filter((item) => item.type === 'mention' && item.source?.kind === 'message')
    const mentions = await mentionsOf(oh)
    assert.equal(mentions.length, 1)
    assert.equal(mentions[0].focusId, `${room.id}:thread:${root.id}`)

    const afterThread = (await get(origin, admin, '/api/proposals')).body.proposals.length
    assert.equal(afterThread, before, '스레드는 조용한 곁방이다 — 승격은 [업무로] 단추가 한다')

    // 본채널의 같은 문장은 그대로 제안이 되고, 그 멘션의 focusId도 그대로 방 id다.
    // 스레드만 뺀 것이지 기존 갈래를 좁힌 것이 아니다.
    assert.equal((await send(origin, park, room.id, { text: `@${oh.account.name} 내일까지 견적서 보내주세요` })).status, 201)
    const afterChannel = (await get(origin, admin, '/api/proposals')).body.proposals.length
    assert.ok(afterChannel > afterThread, '본채널의 지시 문형은 여전히 제안이 된다')

    const both = await mentionsOf(oh)
    assert.equal(both.length, 2)
    assert.deepEqual(
      both.map((item) => item.focusId).sort(),
      [room.id, `${room.id}:thread:${root.id}`].sort(),
      '본채널 메시지의 focusId는 방 id 그대로다',
    )
  })
})

test('방을 나간 사람에게는 스레드 답글이 가지 않는다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)
    const { room, root } = await roomWithRoot(origin, admin, [park.account.id])
    assert.equal((await send(origin, park, room.id, { text: '답글 하나', threadRootId: root.id })).status, 201)
    const before = (await notificationsOf(origin, park)).filter((item) => item.type === 'thread-reply').length

    assert.equal((await post(origin, park, `/api/messenger/conversations/${room.id}/leave`)).status, 200)
    assert.equal((await send(origin, admin, room.id, { text: '나간 뒤의 답글', threadRootId: root.id })).status, 201)

    const after = (await notificationsOf(origin, park)).filter((item) => item.type === 'thread-reply').length
    assert.equal(after, before, '볼 수 없는 방의 본문을 알림으로 보내면 그게 유출이다')
  })
})

test('방을 나간 사람에게는 @멘션도 가지 않는다 — 알림 두 갈래가 한 술어를 쓴다', async () => {
  // leave는 participantIds에서 이름을 빼지 않고 hiddenFor에만 넣는다. 명단만 보는 술어는
  // 나간 사람을 여전히 방 사람으로 세고, mention은 본문 200자를 함께 싣는다(pushByDefault도 참이다).
  // 스레드 답글 알림이 막는 것과 똑같은 차원이므로 같은 함수(accountSeesConversation)가 판정해야 한다.
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)
    const { room, root } = await roomWithRoot(origin, admin, [park.account.id])
    assert.equal((await send(origin, park, room.id, { text: '답글 하나', threadRootId: root.id })).status, 201)

    assert.equal((await post(origin, park, `/api/messenger/conversations/${room.id}/leave`)).status, 200)
    assert.equal((await get(origin, park, `/api/messenger/conversations/${room.id}/messages`)).status, 404, '나간 방은 404다')

    const secret = `@${park.account.name} 내부 단가는 12,000원으로 갑니다`
    assert.equal((await send(origin, admin, room.id, { text: secret, threadRootId: root.id })).status, 201)
    // 본채널 쪽 @멘션도 같은 술어로 막힌다 — 새어 나가는 것은 스레드 본문만이 아니다.
    assert.equal((await send(origin, admin, room.id, { text: `@${park.account.name} 본채널에서도 부릅니다` })).status, 201)

    // 방 초대도 같은 type('mention')을 쓴다 — 말 안의 @는 source.kind가 'message'인 쪽이다.
    const rows = await notificationsOf(origin, park)
    assert.equal(
      rows.filter((item) => item.type === 'mention' && item.source?.kind === 'message').length,
      0,
      '나간 뒤의 말은 멘션으로도 닿지 않는다',
    )
    assert.equal(rows.some((item) => String(item.body ?? '').includes('12,000원')), false, '본문이 알림 센터로 새지 않는다')
  })
})

test('방을 조용히 해 둔 사람에게는 행만 남고 푸시는 나가지 않는다', () => {
  const notification = {
    type: 'thread-reply', recipientId: 'U1', createdAt: '2026-09-01T03:00:00.000Z',
    source: { kind: 'message', id: 'grp-1', label: '방' },
  }
  const on = { U1: { push: ['thread-reply'], muted: [], rooms: {}, quietHours: null, urgentTypes: [] } }
  const off = { U1: { push: ['thread-reply'], muted: [], rooms: { 'grp-1': 'off' }, quietHours: null, urgentTypes: [] } }
  assert.equal(pushDecision(notification, on, new Date('2026-09-01T03:00:00.000Z')), 'send')
  assert.equal(pushDecision(notification, off, new Date('2026-09-01T03:00:00.000Z')), 'skip')
})

// ─────────────────── 일반 저장 경로는 스레드를 만들지 못한다 ───────────────────

test('구성원 generic PUT은 스레드 네 필드를 하나도 받지 않는다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)
    const { room, root } = await roomWithRoot(origin, admin, [park.account.id])

    for (const extra of [
      { threadRootId: root.id },
      { replyCount: 3, lastReplyAt: '2026-09-01T00:00:00.000Z' },
      { lastReplyAt: '2026-09-01T00:00:00.000Z', replyCount: 0 },
      { sharedFromThreadId: root.id },
    ]) {
      const visible = await rawConversations(origin, park)
      const next = structuredClone(visible)
      const target = next.find((item) => item.id === room.id)
      target.messages.push({
        id: `m-forged-${Object.keys(extra).join('-')}`,
        senderId: park.account.id, senderName: park.account.name,
        text: '일반 저장 경로로 심는 답글', time: '09:00', ...extra,
      })
      const response = await fetch(`${origin}/api/workspace/messenger-conversations`, {
        method: 'PUT', headers: park.headers, body: JSON.stringify({ data: next }),
      })
      assert.equal(response.status, 403, `${Object.keys(extra).join('+')}는 일반 저장 경로로 들어올 수 없다`)
      assert.equal((await json(response)).error.code, 'MESSENGER_WRITE_FORBIDDEN')
    }
  })
})

// ─────────────────────────── 채널에 공유 ───────────────────────────

test('채널에 공유는 스레드에 있던 사람과 방장만 할 수 있고, 요약은 승인 큐를 만들지 않는다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)
    const oh = await signIn(origin, OH)
    const { room, root } = await roomWithRoot(origin, admin, [park.account.id, oh.account.id])

    const empty = await post(origin, admin, `/api/messenger/conversations/${room.id}/threads/${root.id}/share`, { text: '요약' })
    assert.equal(empty.status, 409)
    assert.equal(empty.body.error.code, 'THREAD_EMPTY', '답글이 없으면 공유할 결론도 없다')

    assert.equal((await send(origin, park, room.id, { text: '스레드 안의 결론', threadRootId: root.id })).status, 201)

    const outsider = await post(origin, admin, `/api/messenger/conversations/${room.id}/threads/${root.id}/share`, { text: '요약' })
    assert.equal(outsider.status, 201, '루트 작성자는 스레드 참여자다')

    const stranger = await post(origin, oh, `/api/messenger/conversations/${room.id}/threads/${root.id}/share`, { text: '남의 스레드 요약' })
    assert.equal(stranger.status, 403)
    assert.equal(stranger.body.error.code, 'THREAD_SHARE_FORBIDDEN')

    const before = (await get(origin, admin, '/api/proposals')).body.proposals.length
    const shared = await post(origin, park, `/api/messenger/conversations/${room.id}/threads/${root.id}/share`, { text: '내일까지 정리해 주세요.' })
    assert.equal(shared.status, 201)
    assert.equal(shared.body.message.replyTo, root.id)
    assert.equal(shared.body.message.sharedFromThreadId, root.id)
    assert.equal(shared.body.message.threadRootId, undefined, '공유 요약은 본채널의 말이다')
    assert.equal(shared.body.conversation.lastMessage, '내일까지 정리해 주세요.', '공유는 채널 미리보기를 바꾼다')
    const after = (await get(origin, admin, '/api/proposals')).body.proposals.length
    assert.equal(after, before, '방금 결론 낸 일이 승인 큐에 제안으로 다시 쌓이지 않는다')

    const blank = await post(origin, park, `/api/messenger/conversations/${room.id}/threads/${root.id}/share`, { text: '   ' })
    assert.equal(blank.status, 400)
    assert.equal(blank.body.error.code, 'INVALID_MESSAGE')
  })
})

test('방장은 자기가 없던 스레드도 채널에 공유할 수 있다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)
    const oh = await signIn(origin, OH)
    const room = await makeRoom(origin, park, { name: '박지현의 방', participantIds: [admin.account.id, oh.account.id] })
    const root = (await send(origin, oh, room.id, { text: '오태식의 루트' })).body.message
    assert.equal((await send(origin, oh, room.id, { text: '오태식의 답글', threadRootId: root.id })).status, 201)

    const byOwner = await post(origin, park, `/api/messenger/conversations/${room.id}/threads/${root.id}/share`, { text: '방장이 정리한 결론' })
    assert.equal(byOwner.status, 201, '방장은 방을 치울 사람이다')
  })
})

// ─────────────────────────── 승격 ───────────────────────────

test('스레드 승격은 업무·결정·자료 셋뿐이고, 같은 스레드를 두 번 결정으로 올리지 못한다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)
    const { room, root } = await roomWithRoot(origin, admin, [park.account.id])

    const beforeReply = await post(origin, admin, `/api/messenger/conversations/${room.id}/threads/${root.id}/promote`, { kind: 'task' })
    assert.equal(beforeReply.status, 409)
    assert.equal(beforeReply.body.error.code, 'THREAD_EMPTY')

    assert.equal((await send(origin, park, room.id, { text: '결론은 이렇게 갑니다', threadRootId: root.id })).status, 201)

    const wrong = await post(origin, admin, `/api/messenger/conversations/${room.id}/threads/${root.id}/promote`, { kind: 'meeting' })
    assert.equal(wrong.status, 400)
    assert.equal(wrong.body.error.code, 'UNSUPPORTED_PROMOTION')

    const task = await post(origin, admin, `/api/messenger/conversations/${room.id}/threads/${root.id}/promote`, { kind: 'task', title: '스레드 결론 정리' })
    assert.equal(task.status, 201)
    assert.equal(task.body.created.kind, 'work-item')
    const workItems = (await get(origin, admin, '/api/workspace/work-items')).body.data
    const created = workItems.find((item) => item.id === task.body.created.id)
    assert.equal(created.origin.kind, 'thread')
    assert.equal(created.origin.label, '스레드에서 승격')
    assert.equal(created.origin.page, 'messenger')
    assert.equal(created.origin.focusId, `${room.id}:thread:${root.id}`, '배지를 누르면 방이 아니라 그 스레드가 열린다')
    assert.ok(created.description.includes('본채널 첫 말') && created.description.includes('결론은 이렇게 갑니다'), '루트와 답글이 함께 본문이 된다')

    const decision = await post(origin, admin, `/api/messenger/conversations/${room.id}/threads/${root.id}/promote`, { kind: 'decision' })
    assert.equal(decision.status, 201)
    const proposals = (await get(origin, admin, '/api/proposals')).body.proposals
    const stored = proposals.find((item) => item.id === decision.body.created.id)
    assert.equal(stored.kind, 'thread-conclusion')
    assert.equal(stored.sourceKey, `thr:${room.id}:${root.id}`)

    // 두 번째 결정은 서버 고장이 아니라 업무 규칙 거절이다 — 이 파일의 다른 거절과 같은 409로 답하고,
    // 낱말도 이 화면의 것이다('답'은 AI 대화에서 어시스턴트가 준 답을 가리킨다).
    const again = await post(origin, admin, `/api/messenger/conversations/${room.id}/threads/${root.id}/promote`, { kind: 'decision' })
    assert.equal(again.status, 409)
    assert.equal(again.body.error.code, 'THREAD_ALREADY_PROMOTED')
    assert.equal(again.body.error.message, '이미 결정으로 올린 스레드입니다.')

    const document = await post(origin, admin, `/api/messenger/conversations/${room.id}/threads/${root.id}/promote`, { kind: 'document' })
    assert.equal(document.status, 201)
    const documents = (await get(origin, admin, '/api/documents')).body.documents
    const file = documents.find((item) => item.id === document.body.created.id)
    assert.deepEqual(file.tags, ['thread', `conversation:${room.id}`])
  })
})

test('자료로 올린 스레드는 그 방에 있던 사람에게만 열린다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)
    const oh = await signIn(origin, OH)
    const { room, root } = await roomWithRoot(origin, admin, [park.account.id])
    assert.equal((await send(origin, park, room.id, { text: '방 밖 사람은 몰라야 하는 결론입니다', threadRootId: root.id })).status, 201)

    const promoted = await post(origin, park, `/api/messenger/conversations/${room.id}/threads/${root.id}/promote`, { kind: 'document' })
    assert.equal(promoted.status, 201)

    // 오태식은 이 방의 참여자가 아니다 — 메시지도 못 읽는다.
    assert.equal((await get(origin, oh, `/api/messenger/conversations/${room.id}/messages`)).status, 404)
    const outsiderFiles = (await get(origin, oh, '/api/documents')).body.documents
    assert.equal(outsiderFiles.some((item) => item.id === promoted.body.created.id), false, '한 번의 클릭으로 회사 전체가 읽게 되면 그건 승격이 아니라 유출이다')

    const insiderFiles = (await get(origin, park, '/api/documents')).body.documents
    const file = insiderFiles.find((item) => item.id === promoted.body.created.id)
    assert.equal(file.visibility, 'restricted')
    assert.deepEqual([...file.allowedUserIds].sort(), [admin.account.id, park.account.id].sort())
  })
})

test('참여자 명단이 없는 옛 방에서도 자료는 그 말을 한 사람에게 열린다', async () => {
  // team-ops·direct-yoon처럼 participantIds가 없는 방이 지금도 있다. 명단을 그 한 갈래로만 세면
  // 열람 명단이 올린 사람 하나로 줄어, 정작 그 말을 한 사람이 자기 말로 만든 파일을 못 연다.
  const store = {
    version: 2,
    tenants: {
      'TENANT-SUNSEA': {
        'messenger-conversations': {
          data: [{
            id: 'team-ops', type: 'team', kind: 'group', name: '전사 운영', subtitle: '', unread: 0,
            lastMessage: '옛 방의 루트', lastTime: '09:00', ownerId: 'USR-SUNSEA-ADMIN',
            messages: [{
              id: 'm-root', senderId: 'USR-SUNSEA-ADMIN', senderName: '김서원', text: '옛 방의 루트',
              time: '09:00', createdAt: '2026-09-01T00:00:00.000Z', readBy: [],
            }],
          }],
          updatedAt: '2026-09-01T00:00:00.000Z',
        },
      },
    },
    platform: {},
  }
  await withStore(store, async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)
    assert.equal((await send(origin, park, 'team-ops', { text: '제가 정리한 결론입니다', threadRootId: 'm-root' })).status, 201)

    const promoted = await post(origin, admin, '/api/messenger/conversations/team-ops/threads/m-root/promote', { kind: 'document' })
    assert.equal(promoted.status, 201)

    const mine = (await get(origin, admin, '/api/documents')).body.documents.find((item) => item.id === promoted.body.created.id)
    assert.equal(mine.visibility, 'restricted')
    assert.ok(mine.allowedUserIds.includes(park.account.id), '그 말을 한 사람이 명단에 있다')

    const theirs = (await get(origin, park, '/api/documents')).body.documents
    assert.ok(theirs.some((item) => item.id === promoted.body.created.id), '자기 말로 만든 파일을 자기가 못 여는 일은 없다')
    const download = await get(origin, park, `/api/documents/${promoted.body.created.id}/download`)
    assert.notEqual(download.status, 404)
  })
})

test('방을 나간 사람은 나간 뒤에 오간 말로 만든 자료의 명단에 남지 않는다', async () => {
  // leave는 participantIds를 그대로 두고 hiddenFor에만 이름을 넣는다. 명단을 participantIds 한 갈래로만
  // 세면 방도 스레드도 404를 받는 사람이 그 뒤에 오간 말을 파일로 읽는다 —
  // 바로 옆 notifyThreadReply가 같은 상황을 이미 같은 술어로 막고 있다.
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)
    const oh = await signIn(origin, OH)
    const { room, root } = await roomWithRoot(origin, admin, [park.account.id, oh.account.id])
    assert.equal((await send(origin, park, room.id, { text: '나가기 전 한 마디', threadRootId: root.id })).status, 201)

    assert.equal((await post(origin, park, `/api/messenger/conversations/${room.id}/leave`, {})).status, 200)
    assert.equal((await get(origin, park, `/api/messenger/conversations/${room.id}/messages`)).status, 404, '나간 방은 더 보이지 않는다')

    assert.equal((await send(origin, oh, room.id, { text: '박지현이 나간 뒤의 비밀 답글', threadRootId: root.id })).status, 201)
    const promoted = await post(origin, admin, `/api/messenger/conversations/${room.id}/threads/${root.id}/promote`, { kind: 'document' })
    assert.equal(promoted.status, 201)

    const file = (await get(origin, admin, '/api/documents')).body.documents.find((item) => item.id === promoted.body.created.id)
    assert.ok(!file.allowedUserIds.includes(park.account.id), '나간 사람은 나간 뒤의 말을 읽지 않는다')
    assert.ok(file.allowedUserIds.includes(oh.account.id), '남아 있는 스레드 참여자는 그대로 연다')
    assert.equal(
      (await get(origin, park, '/api/documents')).body.documents.some((item) => item.id === promoted.body.created.id),
      false,
      'API 직접 호출로도 열리지 않는다',
    )
  })
})

test('승격은 공유와 같은 문이다 — 스레드에 없던 방 사람은 올릴 수 없다', async () => {
  await withApp(async (origin) => {
    const park = await signIn(origin, PARK)
    const admin = await signIn(origin, ADMIN)
    const oh = await signIn(origin, OH)
    // 방장은 박지현이다. 오태식은 방에는 있지만 스레드에는 없다.
    const room = await makeRoom(origin, park, { name: '박지현의 방', participantIds: [admin.account.id, oh.account.id] })
    const root = (await send(origin, admin, room.id, { text: '관리자의 루트' })).body.message
    assert.equal((await send(origin, admin, room.id, { text: '관리자의 답글', threadRootId: root.id })).status, 201)

    const stranger = await post(origin, oh, `/api/messenger/conversations/${room.id}/threads/${root.id}/promote`, { kind: 'task' })
    assert.equal(stranger.status, 403, '공유(403)보다 무거운 일에 문이 더 넓으면 안 된다')
    assert.equal(stranger.body.error.code, 'THREAD_PROMOTE_FORBIDDEN')

    const byOwner = await post(origin, park, `/api/messenger/conversations/${room.id}/threads/${root.id}/promote`, { kind: 'task' })
    assert.equal(byOwner.status, 201, '방장은 방을 치울 사람이다')
  })
})

test('지운 답글만 남은 스레드는 공유도 승격도 못 한다 — 두 라우트가 같은 것을 센다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const { room, root } = await roomWithRoot(origin, admin, [])
    const reply = await send(origin, admin, room.id, { text: '곧 지울 답글', threadRootId: root.id })
    const removed = await fetch(`${origin}/api/messenger/conversations/${room.id}/messages/${reply.body.message.id}`, {
      method: 'DELETE', headers: admin.headers,
    })
    assert.equal(removed.status, 200)

    const thread = await get(origin, admin, `/api/messenger/conversations/${room.id}/messages/${root.id}/thread`)
    assert.equal(thread.body.replies.length, 1, '지운 답글도 자리는 지킨다')
    assert.equal(thread.body.liveReplyCount, 0, '옮겨 적을 결론은 남아 있지 않다')

    for (const route of ['share', 'promote']) {
      const attempt = await post(
        origin, admin,
        `/api/messenger/conversations/${room.id}/threads/${root.id}/${route}`,
        route === 'share' ? { text: '요약' } : { kind: 'task' },
      )
      assert.equal(attempt.status, 409, route)
      assert.equal(attempt.body.error.code, 'THREAD_EMPTY', route)
    }
  })
})

// ─────────────────────────── 감독 열람 ───────────────────────────

test('감독 열람에는 스레드 답글도 포함된다 — 인라인 저장의 귀결이다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)
    const { room, root } = await roomWithRoot(origin, admin, [park.account.id])
    assert.equal((await send(origin, park, room.id, { text: '스레드에서만 오간 말', threadRootId: root.id })).status, 201)

    const seen = await get(origin, admin, `/api/oversight/rooms/${room.id}`)
    assert.equal(seen.status, 200)
    assert.deepEqual(seen.body.messages.map((item) => item.text), ['본채널 첫 말', '스레드에서만 오간 말'])
  })
})

// ─────────────────────────── 게스트 ───────────────────────────

const GUEST = { id: 'USR-TENANT-SUNSEA-GUEST01', name: '홍거래', email: 'guest@partner.example', password: 'Guest!Pass2026' }
const GUEST_TENANT = 'TENANT-SUNSEA'
const GUEST_ADMIN_ID = 'USR-SUNSEA-ADMIN'
const digestHex = (password, accountId) => scryptSync(String(password), `onfactory:${accountId}`, 32).toString('hex')

function guestSeededStore(messages) {
  return {
    version: 2,
    tenants: {
      [GUEST_TENANT]: {
        'project-spaces': { data: [{
          id: 'PRJ-A', name: '파트너 협업 A', description: '', visibility: 'members', status: 'active', stage: '진행 중',
          client: '파트너상사', amount: 0, ownerId: GUEST_ADMIN_ID, ownerName: '김서원',
          members: [{ id: GUEST_ADMIN_ID, name: '김서원', role: 'owner' }, { id: GUEST.id, name: GUEST.name, role: 'viewer', kind: 'guest' }],
          createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
        }], updatedAt: '2026-09-01T00:00:00.000Z' },
        'messenger-conversations': { data: [{
          id: 'grp-R1', type: 'team', kind: 'group', name: 'A 프로젝트 채널', subtitle: '', unread: 0,
          lastMessage: '루트', lastTime: '09:00', projectId: 'PRJ-A', ownerId: GUEST_ADMIN_ID,
          participantIds: [GUEST_ADMIN_ID, GUEST.id], messages,
        }], updatedAt: '2026-09-01T00:00:00.000Z' },
      },
      'TENANT-POHANG': {},
    },
    platform: {},
    accountApprovals: { [GUEST.id]: 'approved' },
    accountCredentials: { [GUEST.id]: { passwordHash: digestHex(GUEST.password, GUEST.id), mustChangePassword: false, temporaryPasswordExpiresAt: null } },
    invitedAccounts: [{ id: GUEST.id, email: GUEST.email, name: GUEST.name, tenantId: GUEST_TENANT, tenantName: '햇살바다', team: '파트너상사', jobRole: '외부 게스트', requested: '게스트 초대', role: 'tenant-guest', guestGrantId: 'GST-TENANT-SUNSEA-000001' }],
    passwordResetRequests: [],
    guestGrants: [{
      id: 'GST-TENANT-SUNSEA-000001', tenantId: GUEST_TENANT, accountId: GUEST.id, email: GUEST.email, name: GUEST.name,
      orgName: '파트너상사', projectIds: ['PRJ-A'], invitedById: GUEST_ADMIN_ID, invitedByName: '김서원', status: 'active',
      tokenHash: null, tokenIssuedAt: null, tokenExpiresAt: null, resendCount: 0, lastResentAt: null, accessExpiresAt: null,
      acceptedAt: '2026-09-01T00:00:00.000Z', revokedAt: null, revokedById: null, deactivatedAt: null,
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    }],
  }
}

const threadSeed = [
  { id: 'm-root', senderId: GUEST_ADMIN_ID, senderName: '김서원', text: '루트', time: '09:00', createdAt: '2026-09-01T00:00:00.000Z', readBy: [], replyCount: 1, lastReplyAt: '2026-09-01T01:00:00.000Z' },
  { id: 'm-reply', senderId: GUEST_ADMIN_ID, senderName: '김서원', text: '답글', time: '10:00', createdAt: '2026-09-01T01:00:00.000Z', readBy: [], threadRootId: 'm-root' },
]

async function withGuestApp(store, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'messenger-threads-guest-'))
  try {
    const app = createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {}, documentUploadDirectory: path.join(directory, 'documents') })
    await withServer(app, run)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('게스트는 자기 프로젝트 채널의 스레드를 읽을 수 있고, 공유·승격은 게이트가 막는다', async () => {
  await withGuestApp(guestSeededStore(threadSeed), async (origin) => {
    const guest = await signIn(origin, { email: GUEST.email, password: GUEST.password })
    const thread = await get(origin, guest, '/api/messenger/conversations/grp-R1/messages/m-root/thread')
    assert.equal(thread.status, 200)
    assert.equal(thread.body.replies.length, 1)

    const share = await post(origin, guest, '/api/messenger/conversations/grp-R1/threads/m-root/share', { text: '요약' })
    assert.equal(share.status, 403)
    assert.equal(share.body.error.code, 'GUEST_SCOPE_FORBIDDEN')

    const promote = await post(origin, guest, '/api/messenger/conversations/grp-R1/threads/m-root/promote', { kind: 'task' })
    assert.equal(promote.status, 403)
    assert.equal(promote.body.error.code, 'GUEST_SCOPE_FORBIDDEN')
  })
})

test('스레드에 답한 게스트도 참여자다 — 다음 답글 알림이 게스트에게 간다', async () => {
  await withGuestApp(guestSeededStore(threadSeed), async (origin) => {
    const guest = await signIn(origin, { email: GUEST.email, password: GUEST.password })
    const admin = await signIn(origin, ADMIN)
    assert.equal((await send(origin, guest, 'grp-R1', { text: '게스트의 답글', threadRootId: 'm-root' })).status, 201)

    assert.equal((await send(origin, admin, 'grp-R1', { text: '직원의 답글', threadRootId: 'm-root' })).status, 201)

    // 가시성 판정(isConversationVisibleToMember)은 게스트 갈래에서 guestScope를 읽는다. 그 값은 저장된
    // 계정이 아니라 요청 auth에만 붙으므로, 부르는 쪽이 실어 주지 않으면 게스트가 조용히 명단에서 빠진다.
    const rows = (await notificationsOf(origin, guest)).filter((item) => item.type === 'thread-reply')
    assert.equal(rows.length, 1, '참여자 명단에 있으면 게스트에게도 알림이 간다')
    assert.equal(rows[0].focusId, 'grp-R1:thread:m-root')
  })
})

test('로그인할 수 없는 계정에는 스레드 답글 알림이 쌓이지 않는다', async () => {
  // '누가 사람인가'(approved)와 '누가 이 방을 보는가'(hiddenFor·게스트 범위)는 한 함수가 함께 답한다
  // (app.mjs의 accountSeesConversation). 멘션·스레드 답글·승격 명단 셋이 그 함수만 부른다 —
  // 셋 중 하나라도 차원을 덜 읽으면, 못 읽는 계정이 수신자당 상한 300건을 나눠 갖거나 나간 사람이 본문을 받는다.
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)
    const oh = await signIn(origin, OH)
    const { room, root } = await roomWithRoot(origin, admin, [park.account.id, oh.account.id])
    assert.equal((await send(origin, park, room.id, { text: '퇴사 전 답글', threadRootId: root.id })).status, 201)

    assert.equal((await notificationsOf(origin, park)).filter((item) => item.type === 'thread-reply').length, 0)
    assert.equal((await post(origin, admin, `/api/admin/accounts/${park.account.id}/status`, { status: 'inactive' })).status, 200)
    assert.equal((await send(origin, oh, room.id, { text: '퇴사 뒤의 답글', threadRootId: root.id })).status, 201)
    // 관리자(루트 작성자)는 그대로 받는다 — 거르는 것은 '사람이 아닌 계정'뿐이다.
    assert.equal((await notificationsOf(origin, admin)).filter((item) => item.type === 'thread-reply').length, 2)

    // 되살려서 그 계정의 알림함을 직접 본다. 비활성 동안 쌓였는지 아닌지는 그 사람만 볼 수 있다.
    assert.equal((await post(origin, admin, `/api/admin/accounts/${park.account.id}/status`, { status: 'active' })).status, 200)
    const back = await signIn(origin, PARK)
    assert.equal(
      (await notificationsOf(origin, back)).filter((item) => item.type === 'thread-reply').length,
      0,
      '들어올 수 없던 동안의 답글은 그 계정 앞으로 쌓이지 않았다',
    )
  })
})

test('자료로 올린 스레드는 프로젝트에 귀속된다 — 게스트 범위를 좁히면 함께 회수된다', async () => {
  // 승격 문서에 projectId가 없으면 자료실의 회수 스윕(syncGuestMembership)이 '범위 축소' 갈래에서
  // 이 문서를 영영 보지 못한다 — 방과 스레드는 404가 되는데 그 말로 만든 파일만 열리는 상태가 남는다.
  const store = guestSeededStore(threadSeed)
  store.tenants[GUEST_TENANT]['project-spaces'].data.push({
    id: 'PRJ-B', name: '다른 프로젝트', description: '', visibility: 'members', status: 'active', stage: '진행 중',
    client: '다른상사', amount: 0, ownerId: GUEST_ADMIN_ID, ownerName: '김서원',
    members: [{ id: GUEST_ADMIN_ID, name: '김서원', role: 'owner' }],
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  })
  await withGuestApp(store, async (origin) => {
    const guest = await signIn(origin, { email: GUEST.email, password: GUEST.password })
    const admin = await signIn(origin, ADMIN)
    assert.equal((await send(origin, guest, 'grp-R1', { text: '게스트가 남긴 답글', threadRootId: 'm-root' })).status, 201)
    assert.equal((await send(origin, admin, 'grp-R1', { text: '내부 단가는 12,000원으로 갑니다', threadRootId: 'm-root' })).status, 201)

    const promoted = await post(origin, admin, '/api/messenger/conversations/grp-R1/threads/m-root/promote', { kind: 'document' })
    assert.equal(promoted.status, 201)
    const documentId = promoted.body.created.id

    const stamped = (await get(origin, admin, '/api/documents')).body.documents.find((item) => item.id === documentId)
    assert.equal(stamped.projectId, 'PRJ-A', '프로젝트 채널에서 나온 자료는 그 프로젝트의 것이다')
    assert.ok(
      (await get(origin, guest, '/api/documents')).body.documents.some((item) => item.id === documentId),
      '초대가 살아 있는 동안에는 자기가 답한 스레드의 자료가 열린다',
    )

    const moved = await fetch(`${origin}/api/admin/guests/GST-TENANT-SUNSEA-000001`, {
      method: 'PATCH', headers: admin.headers, body: JSON.stringify({ projectIds: ['PRJ-B'] }),
    })
    assert.equal(moved.status, 200)

    assert.equal(
      (await get(origin, guest, '/api/messenger/conversations/grp-R1/messages/m-root/thread')).status,
      404,
      '범위를 옮기면 방도 스레드도 보이지 않는다',
    )
    assert.equal(
      (await get(origin, guest, '/api/documents')).body.documents.some((item) => item.id === documentId),
      false,
      '자료도 함께 회수된다',
    )
    assert.equal((await get(origin, guest, `/api/documents/${documentId}/download`)).status, 404, 'API 직접 호출로도 열리지 않는다')
  })
})

// ─────────────────────────── 용량 ───────────────────────────

test('답글은 방의 5,000건 상한을 본문과 나눠 쓴다', async () => {
  const messages = [threadSeed[0]]
  for (let index = 1; index < 4_999; index += 1) {
    messages.push({
      id: `m-fill-${index}`, senderId: GUEST_ADMIN_ID, senderName: '김서원', text: `채움 ${index}`,
      time: '09:00', createdAt: '2026-09-01T00:00:00.000Z', readBy: [],
    })
  }
  await withGuestApp(guestSeededStore(messages), async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const first = await send(origin, admin, 'grp-R1', { text: '4,999번째 다음 답글', threadRootId: 'm-root' })
    assert.equal(first.status, 201, '4,999건일 때는 아직 들어간다')

    const overflow = await send(origin, admin, 'grp-R1', { text: '한 건 더', threadRootId: 'm-root' })
    assert.equal(overflow.status, 409)
    assert.equal(overflow.body.error.code, 'MESSENGER_MESSAGE_CAPACITY_REACHED')
    assert.match(overflow.body.error.message, /답글 포함/, '한도를 스레드와 나눠 쓴다는 사실이 문구에 있어야 한다')
  })
})

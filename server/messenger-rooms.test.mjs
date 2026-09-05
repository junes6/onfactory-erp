import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createApp } from './app.mjs'
import { withServer } from './test-server.mjs'
import { isSingleEmoji, readSummary, roomRole } from './messenger-rooms.mjs'

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

/** 각 테스트는 자기 저장소를 쓴다. 방을 만들고 지우는 시험이라 서로 간섭하면 안 된다. */
async function withApp(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'messenger-rooms-'))
  try {
    const app = createApp({ apiKey: '', workspaceStoreFile: path.join(directory, 'state.json'), documentUploadDirectory: path.join(directory, 'documents') })
    await withServer(app, run)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const send = (origin, headers, id, body) => fetch(`${origin}/api/messenger/conversations/${id}/messages`, {
  method: 'POST', headers, body: JSON.stringify(body),
})

async function makeRoom(origin, headers, body) {
  const response = await fetch(`${origin}/api/messenger/conversations/group`, {
    method: 'POST', headers, body: JSON.stringify(body),
  })
  assert.equal(response.status, 201, '그룹방 생성 실패')
  return (await response.json()).conversation
}

// ─────────────────────────── 순수 함수 ───────────────────────────

test('반응은 이모지 하나만 받는다 — 문자열을 받으면 그건 또 하나의 메시지다', () => {
  assert.equal(isSingleEmoji('👍'), true)
  assert.equal(isSingleEmoji('🇰🇷'), true, '여러 코드포인트가 결합된 국기도 하나로 센다')
  assert.equal(isSingleEmoji('👍👎'), false)
  assert.equal(isSingleEmoji('ㅋ'), false)
  assert.equal(isSingleEmoji('좋아요'), false)
  assert.equal(isSingleEmoji(''), false)
})

test('읽음은 "N명"으로 센다 — 누가 안 읽었는지는 펼치지 않는다', () => {
  const conversation = { participantIds: ['a', 'b', 'c', 'd'] }
  const message = { senderId: 'a', readBy: ['a', 'b', 'c'] }
  assert.deepEqual(readSummary(message, conversation), { count: 2, total: 3 }, '보낸 사람은 양쪽에서 뺀다')
  assert.deepEqual(readSummary({ senderId: 'a', readBy: ['a'] }, conversation), { count: 0, total: 3 })
})

test('방에서 할 수 있는 일은 방장·회사 관리자·참여자 순으로 넓어진다', () => {
  const room = { ownerId: 'owner', participantIds: ['owner', 'member'] }
  assert.equal(roomRole(room, { id: 'owner', role: 'tenant-member' }), 'owner')
  assert.equal(roomRole(room, { id: 'someone', role: 'tenant-admin' }), 'admin')
  assert.equal(roomRole(room, { id: 'member', role: 'tenant-member' }), 'member')
  assert.equal(roomRole(room, { id: 'outsider', role: 'tenant-member' }), 'none')
})

// ─────────────────────────── 그룹방 ───────────────────────────

test('그룹방을 만들면 초대한 사람만 볼 수 있고, 인원 상한은 없다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)
    const oh = await signIn(origin, OH)

    const room = await makeRoom(origin, admin.headers, {
      name: '금속검출기 점검', icon: '🔧', participantIds: [park.account.id],
    })
    assert.equal(room.kind, 'group')
    assert.equal(room.ownerId, admin.account.id)
    assert.deepEqual(room.participantIds.sort(), [admin.account.id, park.account.id].sort())
    assert.equal(room.subtitle, '2명')

    const seenByPark = await (await fetch(`${origin}/api/workspace/messenger-conversations`, { headers: park.headers })).json()
    assert.ok(seenByPark.data.some((item) => item.id === room.id), '초대받은 사람에게는 보인다')

    const seenByOh = await (await fetch(`${origin}/api/workspace/messenger-conversations`, { headers: oh.headers })).json()
    assert.ok(!seenByOh.data.some((item) => item.id === room.id), '초대받지 않은 사람에게는 보이지 않는다')
  })
})

test('다른 회사 사람은 초대할 수 없다 — 테넌트 격리는 방 만들기에서도 지켜진다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const response = await fetch(`${origin}/api/messenger/conversations/group`, {
      method: 'POST', headers: admin.headers,
      body: JSON.stringify({ name: '외부', participantIds: ['USR-POHANG-ADMIN'] }),
    })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, 'INVALID_PARTICIPANT')
  })
})

test('초대·내보내기·방장 위임이 동작하고, 방장은 위임 전에 내보낼 수 없다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)
    const oh = await signIn(origin, OH)
    const room = await makeRoom(origin, admin.headers, { name: '품질 점검', participantIds: [park.account.id] })

    const invited = await fetch(`${origin}/api/messenger/conversations/${room.id}/participants`, {
      method: 'POST', headers: admin.headers, body: JSON.stringify({ participantIds: [oh.account.id] }),
    })
    assert.equal(invited.status, 200)
    assert.equal((await invited.json()).conversation.subtitle, '3명')

    const removingOwner = await fetch(`${origin}/api/messenger/conversations/${room.id}/participants/${admin.account.id}`, {
      method: 'DELETE', headers: admin.headers,
    })
    assert.equal(removingOwner.status, 409, '방장을 그냥 빼면 주인 없는 방이 남는다')

    const handed = await fetch(`${origin}/api/messenger/conversations/${room.id}/owner`, {
      method: 'POST', headers: admin.headers, body: JSON.stringify({ ownerId: park.account.id }),
    })
    assert.equal(handed.status, 200)
    assert.equal((await handed.json()).conversation.ownerId, park.account.id)

    const outsiderRenames = await fetch(`${origin}/api/messenger/conversations/${room.id}`, {
      method: 'PATCH', headers: oh.headers, body: JSON.stringify({ name: '내 맘대로' }),
    })
    assert.equal(outsiderRenames.status, 403, '참여자라도 방장이 아니면 이름을 못 바꾼다')

    const ownerRenames = await fetch(`${origin}/api/messenger/conversations/${room.id}`, {
      method: 'PATCH', headers: park.headers, body: JSON.stringify({ name: '품질 점검 2팀', icon: '🧪' }),
    })
    assert.equal(ownerRenames.status, 200)
    const renamed = (await ownerRenames.json()).conversation
    assert.equal(renamed.name, '품질 점검 2팀')
    assert.equal(renamed.icon, '🧪')
  })
})

// ─────────────────────────── 메시지 조작 ───────────────────────────

test('답장은 같은 방의 살아 있는 메시지만 가리킬 수 있다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const room = await makeRoom(origin, admin.headers, { name: '답장 시험', participantIds: [] })
    const first = (await (await send(origin, admin.headers, room.id, { text: '원문입니다' })).json()).message

    const replied = await send(origin, admin.headers, room.id, { text: '답장입니다', replyTo: first.id })
    assert.equal(replied.status, 201)
    assert.equal((await replied.json()).message.replyTo, first.id)

    const dangling = await send(origin, admin.headers, room.id, { text: '없는 원문', replyTo: 'm-없음' })
    assert.equal(dangling.status, 400, '없는 id를 받아 두면 인용문이 빈 칸으로 뜬다')
    assert.equal((await dangling.json()).error.code, 'INVALID_REPLY_TARGET')
  })
})

test('수정은 본인만, 삭제는 흔적을 남긴다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)
    const room = await makeRoom(origin, admin.headers, { name: '수정 시험', participantIds: [park.account.id] })
    const mine = (await (await send(origin, admin.headers, room.id, { text: '처음 쓴 말' })).json()).message

    const byOther = await fetch(`${origin}/api/messenger/conversations/${room.id}/messages/${mine.id}`, {
      method: 'PATCH', headers: park.headers, body: JSON.stringify({ text: '남의 말 고치기' }),
    })
    assert.equal(byOther.status, 403, '고칠 수 있으면 그건 기록이 아니다')

    const edited = await fetch(`${origin}/api/messenger/conversations/${room.id}/messages/${mine.id}`, {
      method: 'PATCH', headers: admin.headers, body: JSON.stringify({ text: '고쳐 쓴 말' }),
    })
    assert.equal(edited.status, 200)
    const updated = (await edited.json()).message
    assert.equal(updated.text, '고쳐 쓴 말')
    assert.ok(updated.editedAt, '수정됨 표시가 남는다')

    const removed = await fetch(`${origin}/api/messenger/conversations/${room.id}/messages/${mine.id}`, {
      method: 'DELETE', headers: admin.headers,
    })
    assert.equal(removed.status, 200)
    const tombstone = (await removed.json()).message
    assert.equal(tombstone.text, '삭제된 메시지')
    assert.ok(tombstone.deletedAt)
    assert.equal(tombstone.deletedBy, admin.account.id)

    const stored = await (await fetch(`${origin}/api/workspace/messenger-conversations`, { headers: admin.headers })).json()
    const kept = stored.data.find((item) => item.id === room.id)
    assert.equal(kept.messages.length, 1, '삭제해도 자리는 남는다 — 무엇이 사라졌는지 보여야 한다')
    assert.equal(kept.messages[0].text, '삭제된 메시지')
  })
})

test('반응은 누르면 켜지고 다시 누르면 꺼진다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)
    const room = await makeRoom(origin, admin.headers, { name: '반응 시험', participantIds: [park.account.id] })
    const message = (await (await send(origin, admin.headers, room.id, { text: '반응해 주세요' })).json()).message
    const react = (headers, emoji) => fetch(`${origin}/api/messenger/conversations/${room.id}/messages/${message.id}/reactions`, {
      method: 'POST', headers, body: JSON.stringify({ emoji }),
    })

    assert.equal((await (await react(admin.headers, '👍')).json()).message.reactions[0].by.length, 1)
    const two = (await (await react(park.headers, '👍')).json()).message
    assert.equal(two.reactions[0].by.length, 2, '같은 이모지는 한 줄에 모인다')
    const off = (await (await react(park.headers, '👍')).json()).message
    assert.equal(off.reactions[0].by.length, 1, '다시 누르면 내 반응만 빠진다')

    const invalid = await react(admin.headers, '좋아요')
    assert.equal(invalid.status, 400)
  })
})

test('고정한 메시지는 방에 남고, 삭제하면 고정도 함께 풀린다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const room = await makeRoom(origin, admin.headers, { name: '공지 시험', participantIds: [] })
    const message = (await (await send(origin, admin.headers, room.id, { text: '이번 주 공지' })).json()).message

    const pinned = await fetch(`${origin}/api/messenger/conversations/${room.id}/messages/${message.id}/pin`, {
      method: 'POST', headers: admin.headers, body: JSON.stringify({ pinned: true }),
    })
    assert.equal(pinned.status, 200)
    assert.deepEqual((await pinned.json()).pinnedMessageIds, [message.id])

    await fetch(`${origin}/api/messenger/conversations/${room.id}/messages/${message.id}`, { method: 'DELETE', headers: admin.headers })
    const stored = await (await fetch(`${origin}/api/workspace/messenger-conversations`, { headers: admin.headers })).json()
    const kept = stored.data.find((item) => item.id === room.id)
    assert.equal(kept.pinnedMessageIds, undefined, '지워진 메시지가 공지로 남아 있으면 안 된다')
  })
})

test('방 안 검색과 메시지 페이지가 동작한다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const room = await makeRoom(origin, admin.headers, { name: '검색 시험', participantIds: [] })
    for (const text of ['첫째 줄', '금속검출기 점검 완료', '셋째 줄']) {
      await send(origin, admin.headers, room.id, { text })
    }

    const found = await (await fetch(`${origin}/api/messenger/conversations/${room.id}/search?q=${encodeURIComponent('금속검출기')}`, { headers: admin.headers })).json()
    assert.equal(found.total, 1)
    assert.match(found.matches[0].text, /금속검출기/)

    const short = await fetch(`${origin}/api/messenger/conversations/${room.id}/search?q=금`, { headers: admin.headers })
    assert.equal(short.status, 400, '한 글자로는 방 전체가 걸린다')

    const page = await (await fetch(`${origin}/api/messenger/conversations/${room.id}/messages?limit=2`, { headers: admin.headers })).json()
    assert.equal(page.messages.length, 2)
    assert.equal(page.total, 3)
    assert.equal(page.hasMore, true, '위로 더 올라갈 것이 있으면 알려 준다')
    assert.equal(page.messages[1].text, '셋째 줄', '최신 쪽부터 채운다')
    assert.ok(page.readSummaries[page.messages[0].id], '읽음 집계를 함께 준다')
  })
})

test('방별 알림 끄기가 저장된다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const room = await makeRoom(origin, admin.headers, { name: '알림 시험', participantIds: [] })
    const muted = await fetch(`${origin}/api/messenger/conversations/${room.id}/mute`, {
      method: 'POST', headers: admin.headers, body: JSON.stringify({ muted: true }),
    })
    assert.equal(muted.status, 200)
    assert.equal((await muted.json()).muted, true)

    const stored = await (await fetch(`${origin}/api/workspace/messenger-conversations`, { headers: admin.headers })).json()
    assert.deepEqual(stored.data.find((item) => item.id === room.id).mutedFor, [admin.account.id])
  })
})

test('메시지를 보내면 @멘션 알림이 실제로 나간다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)
    const room = await makeRoom(origin, admin.headers, { name: '멘션 시험', participantIds: [park.account.id] })
    await send(origin, admin.headers, room.id, { text: `@${park.account.name} 오늘 점검 부탁드립니다` })

    const inbox = await (await fetch(`${origin}/api/notifications`, { headers: park.headers })).json()
    const mention = (inbox.items ?? []).find((item) => item.type === 'mention')
    assert.ok(mention, '화면이 쓰는 전송 경로에서도 멘션 알림이 나가야 한다')
    assert.match(mention.title, /언급/)
  })
})

// ─────────────────────── 비활성(퇴사) 계정 ───────────────────────

test('비활성 계정은 로그인이 막히되 남긴 대화는 그대로 남고 목록에도 남는다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)
    const room = await makeRoom(origin, admin.headers, { name: '인수인계', participantIds: [park.account.id] })
    await send(origin, park.headers, room.id, { text: '제가 맡던 일 정리했습니다' })

    const deactivated = await fetch(`${origin}/api/admin/accounts/${park.account.id}/status`, {
      method: 'POST', headers: admin.headers, body: JSON.stringify({ status: 'inactive' }),
    })
    assert.equal(deactivated.status, 200)
    assert.equal((await deactivated.json()).account.status, '비활성')

    const blocked = await fetch(`${origin}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: 'tenant', ...PARK }),
    })
    assert.equal(blocked.status, 403)
    assert.equal((await blocked.json()).error.code, 'ACCOUNT_INACTIVE', '반려와 구분되는 사유를 알려 준다')

    const stored = await (await fetch(`${origin}/api/workspace/messenger-conversations`, { headers: admin.headers })).json()
    const kept = stored.data.find((item) => item.id === room.id)
    assert.equal(kept.messages.length, 1, '퇴사자의 메시지를 지우지 않는다')
    assert.equal(kept.messages[0].senderName, park.account.name)

    const directory = await (await fetch(`${origin}/api/directory`, { headers: admin.headers })).json()
    const listed = directory.members.find((member) => member.id === park.account.id)
    assert.ok(listed, '목록에서 지우면 그 사람의 말풍선이 이름 없는 기록이 된다')
    assert.equal(listed.active, false, '화면이 비활성 표시를 할 수 있어야 한다')
  })
})

test('비활성 계정은 새 그룹방에 초대되지 않는다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)
    await fetch(`${origin}/api/admin/accounts/${park.account.id}/status`, {
      method: 'POST', headers: admin.headers, body: JSON.stringify({ status: 'inactive' }),
    })
    const response = await fetch(`${origin}/api/messenger/conversations/group`, {
      method: 'POST', headers: admin.headers, body: JSON.stringify({ name: '새 방', participantIds: [park.account.id] }),
    })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, 'INVALID_PARTICIPANT')
  })
})

test('되살리면 다시 들어올 수 있고, 마지막 관리자와 본인은 비활성화할 수 없다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)

    const self = await fetch(`${origin}/api/admin/accounts/${admin.account.id}/status`, {
      method: 'POST', headers: admin.headers, body: JSON.stringify({ status: 'inactive' }),
    })
    assert.equal(self.status, 409, '스스로를 잠그면 들어올 사람이 없어진다')
    assert.equal((await self.json()).error.code, 'CANNOT_DEACTIVATE_SELF')

    await fetch(`${origin}/api/admin/accounts/${park.account.id}/status`, {
      method: 'POST', headers: admin.headers, body: JSON.stringify({ status: 'inactive' }),
    })
    const restored = await fetch(`${origin}/api/admin/accounts/${park.account.id}/status`, {
      method: 'POST', headers: admin.headers, body: JSON.stringify({ status: 'active' }),
    })
    assert.equal(restored.status, 200)
    assert.equal((await restored.json()).account.status, '활성')

    const back = await fetch(`${origin}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: 'tenant', ...PARK }),
    })
    assert.equal(back.status, 200, '다시 근무하면 그대로 되살아난다')
  })
})

test('비활성 처리는 감사 기록에 남는다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)
    await fetch(`${origin}/api/admin/accounts/${park.account.id}/status`, {
      method: 'POST', headers: admin.headers, body: JSON.stringify({ status: 'inactive' }),
    })
    const operator = await fetch(`${origin}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: 'platform', email: 'operator@onfactory.co.kr', password: 'demo1234' }),
    })
    const state = await (await fetch(`${origin}/api/platform/state`, { headers: { cookie: operator.headers.get('set-cookie') } })).json()
    const entry = (state.auditEvents ?? []).find((item) => item.event === '계정 비활성화')
    assert.ok(entry, '누가 누구를 언제 비활성화했는지 남아야 한다')
    assert.equal(entry.actor, admin.account.name)
    assert.match(entry.scope, new RegExp(park.account.name))
  })
})

// ─────────────────────────── 외부 게스트 ───────────────────────────

/** 게스트 계정·grant를 직접 심은 저장소. 초대 라우트는 guest-access.test가 다룬다. */
function guestSeededStore() {
  const guestId = 'USR-TENANT-SUNSEA-GUESTROOM'
  return {
    guestId,
    store: {
      version: 2,
      tenants: {
        'TENANT-SUNSEA': {
          'project-spaces': { data: [
            { id: 'PRJ-A', name: '파트너 협업 A', visibility: 'members', status: 'active', ownerId: 'USR-SUNSEA-ADMIN', ownerName: '김서원',
              members: [{ id: 'USR-SUNSEA-ADMIN', name: '김서원', role: 'owner' }, { id: 'USR-SUNSEA-PARK', name: '박지현', role: 'editor' }, { id: guestId, name: '홍거래', role: 'viewer', kind: 'guest' }], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
            { id: 'PRJ-C', name: '비공개 C', visibility: 'members', status: 'active', ownerId: 'USR-SUNSEA-ADMIN', ownerName: '김서원',
              members: [{ id: 'USR-SUNSEA-ADMIN', name: '김서원', role: 'owner' }], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
          ], updatedAt: '2026-09-01T00:00:00.000Z' },
        },
        'TENANT-POHANG': {},
      },
      platform: {},
      accountApprovals: { [guestId]: 'approved' },
      accountCredentials: {},
      invitedAccounts: [{ id: guestId, email: 'room.guest@partner.example', name: '홍거래', tenantId: 'TENANT-SUNSEA', tenantName: '햇살바다', team: '파트너상사', jobRole: '외부 게스트', requested: '게스트 초대', role: 'tenant-guest', guestGrantId: 'GST-ROOM' }],
      passwordResetRequests: [],
      guestGrants: [{ id: 'GST-ROOM', tenantId: 'TENANT-SUNSEA', accountId: guestId, email: 'room.guest@partner.example', name: '홍거래', orgName: '파트너상사', projectIds: ['PRJ-A'], invitedById: 'USR-SUNSEA-ADMIN', invitedByName: '김서원', status: 'active', tokenHash: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }],
    },
  }
}

test('게스트는 초대된 프로젝트의 채널(projectId 있는 방)에만 들어갈 수 있다', async () => {
  const { store, guestId } = guestSeededStore()
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {} }), async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)
    // projectId 없는 일반 그룹방에 게스트 → 400
    const plain = await fetch(`${origin}/api/messenger/conversations/group`, { method: 'POST', headers: admin.headers, body: JSON.stringify({ name: '내부 회의', participantIds: [park.account.id, guestId] }) })
    assert.equal(plain.status, 400)
    assert.equal((await plain.json()).error.code, 'GUEST_OUTSIDE_PROJECT')
    // 범위 밖 프로젝트(C) 채널에 게스트 → 400 (게스트는 C 멤버도 아니다)
    const outside = await fetch(`${origin}/api/messenger/conversations/group`, { method: 'POST', headers: admin.headers, body: JSON.stringify({ name: 'C 채널', projectId: 'PRJ-C', participantIds: [guestId] }) })
    assert.equal(outside.status, 400)
    // 범위 안 프로젝트(A) 채널 → 201, 방에 projectId가 남는다
    const channel = await makeRoom(origin, admin.headers, { name: 'A 채널', projectId: 'PRJ-A', participantIds: [park.account.id, guestId] })
    assert.equal(channel.projectId, 'PRJ-A')
    assert.ok(channel.participantIds.includes(guestId))
    // 기존 일반 방에 나중에 게스트를 초대해도 막힌다
    const room = await makeRoom(origin, admin.headers, { name: '일반방', participantIds: [park.account.id] })
    const invite = await fetch(`${origin}/api/messenger/conversations/${room.id}/participants`, { method: 'POST', headers: admin.headers, body: JSON.stringify({ participantIds: [guestId] }) })
    assert.equal(invite.status, 400)
    assert.equal((await invite.json()).error.code, 'GUEST_OUTSIDE_PROJECT')
    // A 채널에서는 나중 초대도 된다 — 먼저 내보낸 뒤 다시 부른다
    const kick = await fetch(`${origin}/api/messenger/conversations/${channel.id}/participants/${guestId}`, { method: 'DELETE', headers: admin.headers })
    assert.equal(kick.status, 200)
    const reinvite = await fetch(`${origin}/api/messenger/conversations/${channel.id}/participants`, { method: 'POST', headers: admin.headers, body: JSON.stringify({ participantIds: [guestId] }) })
    assert.equal(reinvite.status, 200, await reinvite.text())
    // 프로젝트 채널은 프로젝트 멤버만 초대할 수 있고, 프로젝트에 권한 없는 사람은 만들 수 없다
    const oh = await signIn(origin, OH)
    const nonMember = await fetch(`${origin}/api/messenger/conversations/group`, { method: 'POST', headers: admin.headers, body: JSON.stringify({ name: 'A 채널 2', projectId: 'PRJ-A', participantIds: [oh.account.id] }) })
    assert.equal(nonMember.status, 400)
    const forbidden = await fetch(`${origin}/api/messenger/conversations/group`, { method: 'POST', headers: oh.headers, body: JSON.stringify({ name: '남의 프로젝트 채널', projectId: 'PRJ-A', participantIds: [] }) })
    assert.equal(forbidden.status, 403)
    assert.equal((await forbidden.json()).error.code, 'PROJECT_EDITOR_REQUIRED')
  })
})

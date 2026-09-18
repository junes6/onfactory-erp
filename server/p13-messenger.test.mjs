import assert from 'node:assert/strict'
import test from 'node:test'

import { createApp } from './app.mjs'
import { addNotifications, buildNotification, normalizeNotifications } from './notifications.mjs'
import { withServer } from './test-server.mjs'

/**
 * P1-3a: 메신저를 닫아 둬도 1:1 말이 닿는다.
 *  - 1:1 새 메시지는 상대에게 알림(같은 대화의 읽지 않은 알림은 한 건으로 묶인다). 그룹방은 알리지 않는다.
 *  - 안 읽은 수는 서버가 센다(본문 없이). 대화를 읽으면 그 대화의 알림도 읽음이 된다.
 */

const json = (cookie) => ({ 'content-type': 'application/json', cookie })
const readJson = async (response) => { const text = await response.text(); try { return JSON.parse(text) } catch { return { raw: text } } }
async function login(origin, email) {
  const response = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: 'tenant', email, password: 'demo1234' }) })
  assert.equal(response.status, 200, email)
  return (response.headers.get('set-cookie') ?? '').split(';')[0]
}

test('묶기: 같은 대화의 읽지 않은 1:1 알림은 한 건으로 — id를 이어받고 건수가 붙는다', () => {
  const dm = (conversationId, text) => buildNotification({ type: 'direct-message', recipientId: 'U2', title: '김서원님의 새 메시지', body: text, source: { kind: 'message', id: conversationId, label: '김서원' } })
  let rows = addNotifications([], [dm('C1', '첫 말')]).rows
  const firstId = rows[0].id
  rows = addNotifications(rows, [dm('C1', '둘째 말')]).rows
  rows = addNotifications(rows, [dm('C1', '셋째 말')]).rows
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, firstId, '같은 id — 기기의 푸시도 새로 쌓이지 않고 바뀐다')
  assert.equal(rows[0].count, 3)
  assert.equal(rows[0].title, '김서원님의 새 메시지 3건')
  assert.equal(rows[0].body, '셋째 말', '가장 최근 말을 보인다')
  // 다른 대화는 따로, 읽은 알림은 묶지 않는다.
  rows = addNotifications(rows, [dm('C2', '다른 방')]).rows
  assert.equal(rows.length, 2)
  rows = rows.map((row) => ({ ...row, readAt: '2026-09-18T00:00:00.000Z' }))
  rows = addNotifications(rows, [dm('C1', '읽은 뒤 새 말')]).rows
  assert.equal(rows.length, 3)
  assert.equal(rows[0].count, undefined)
  // 건수는 저장·재적재를 지나도 남는다.
  assert.equal(normalizeNotifications([{ ...rows[1], count: 3 }])[0].count, 3)
})

test('1:1 새 말은 상대에게 알리고, 안 읽은 수는 서버가 세며, 읽으면 알림도 읽음 — 그룹방은 알리지 않는다', async () => {
  await withServer(createApp({ apiKey: '' }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const member = await login(origin, 'taesik.oh@sunsea.co.kr')
    const direct = await readJson(await fetch(`${origin}/api/messenger/conversations/direct`, { method: 'POST', headers: json(admin), body: JSON.stringify({ participantId: 'USR-SUNSEA-OH' }) }))
    const conversationId = direct.conversation.id
    const unreadBefore = (await readJson(await fetch(`${origin}/api/messenger/unread`, { headers: { cookie: member } }))).unread
    for (const text of ['오늘 입고 확인 부탁해요', '사진도 같이요']) {
      const sent = await fetch(`${origin}/api/messenger/conversations/${conversationId}/messages`, { method: 'POST', headers: json(admin), body: JSON.stringify({ text }) })
      assert.equal(sent.status, 201)
    }
    const inbox = await readJson(await fetch(`${origin}/api/notifications`, { headers: { cookie: member } }))
    const dms = inbox.items.filter((item) => item.type === 'direct-message')
    assert.equal(dms.length, 1, '연달아 온 두 말이 알림 한 건')
    assert.equal(dms[0].title, '김서원님의 새 메시지 2건')
    assert.equal(dms[0].body, '사진도 같이요')
    assert.match(dms[0].focusId, new RegExp(`^${conversationId}:message:`))
    const senderInbox = await readJson(await fetch(`${origin}/api/notifications`, { headers: { cookie: admin } }))
    assert.equal(senderInbox.items.filter((item) => item.type === 'direct-message').length, 0, '보낸 사람에게는 가지 않는다')

    const unread = await readJson(await fetch(`${origin}/api/messenger/unread`, { headers: { cookie: member } }))
    assert.equal(unread.unread, unreadBefore + 2)
    assert.deepEqual(Object.keys(unread), ['unread'], '본문은 내려보내지 않는다')

    assert.equal((await fetch(`${origin}/api/messenger/conversations/${conversationId}/read`, { method: 'POST', headers: json(member), body: '{}' })).status, 200)
    assert.equal((await readJson(await fetch(`${origin}/api/messenger/unread`, { headers: { cookie: member } }))).unread, unreadBefore)
    const afterRead = await readJson(await fetch(`${origin}/api/notifications`, { headers: { cookie: member } }))
    assert.ok(afterRead.items.filter((item) => item.type === 'direct-message').every((item) => item.readAt), '대화를 읽으면 그 알림도 읽음')

    // 그룹방의 말은 1:1 알림을 만들지 않는다(배지와 멘션이 맡는다).
    const room = await readJson(await fetch(`${origin}/api/messenger/conversations/group`, { method: 'POST', headers: json(admin), body: JSON.stringify({ name: '입고 점검', participantIds: ['USR-SUNSEA-OH'] }) }))
    await fetch(`${origin}/api/messenger/conversations/${room.conversation.id}/messages`, { method: 'POST', headers: json(admin), body: JSON.stringify({ text: '점검표 공유합니다' }) })
    const finalInbox = await readJson(await fetch(`${origin}/api/notifications`, { headers: { cookie: member } }))
    assert.equal(finalInbox.items.filter((item) => item.type === 'direct-message' && !item.readAt).length, 0)
    // 목록 정렬·날짜 표기용 시각이 대화에 남는다.
    const listed = await readJson(await fetch(`${origin}/api/workspace/messenger-conversations`, { headers: { cookie: member } }))
    const saved = listed.data.find((item) => item.id === room.conversation.id)
    assert.ok(Number.isFinite(Date.parse(saved.lastAt)))
  })
})

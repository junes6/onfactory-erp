import assert from 'node:assert/strict'
import test from 'node:test'

import {
  THREAD_ERRORS,
  isMainChannelMessage,
  liveThreadReplies,
  mainChannelMessages,
  rootAggregates,
  threadParticipantIds,
  threadReadViolation,
  threadReplies,
  threadRootViolation,
} from './messenger-threads.mjs'

const root = { id: 'm-1', senderId: 'a', text: '루트' }
const reply = (id, senderId, extra = {}) => ({ id, senderId, text: '답글', threadRootId: 'm-1', ...extra })

test('루트가 될 수 있는 메시지는 같은 방의, 삭제되지 않은, 그 자체가 답글이 아닌 것뿐이다', () => {
  const messages = [root, reply('m-2', 'b'), { id: 'm-3', senderId: 'c', text: '지운 말', deletedAt: '2026-09-01T00:00:00.000Z' }]
  assert.equal(threadRootViolation(messages, 'm-1'), null)
  assert.equal(threadRootViolation(messages, 'm-none'), THREAD_ERRORS.ROOT_NOT_FOUND, '없는 id는 루트가 될 수 없다')
  assert.equal(threadRootViolation(messages, 'm-3'), THREAD_ERRORS.ROOT_DELETED, '삭제된 말에는 답글을 붙이지 않는다 — 그러나 없는 말과 낱말이 다르다')
  assert.equal(threadRootViolation(messages, 'm-2'), THREAD_ERRORS.ROOT_NOT_FOUND, '답글은 스레드의 루트가 될 수 없다 — 깊이는 1단이다')
  assert.equal(threadRootViolation([], 'm-1'), THREAD_ERRORS.ROOT_NOT_FOUND)
})

test('읽기 판정은 지워진 루트도 연다 — 답글은 다른 사람의 말이다', () => {
  const messages = [
    { ...root, deletedAt: '2026-09-01T00:00:00.000Z', text: '삭제된 메시지' },
    reply('m-2', 'b'),
    { id: 'm-3', senderId: 'c', text: '본채널' },
  ]
  assert.equal(threadReadViolation(messages, 'm-1'), null, '지운 것은 루트의 본문뿐이고 스레드는 남는다')
  assert.equal(threadRootViolation(messages, 'm-1'), THREAD_ERRORS.ROOT_DELETED, '그래도 새 답글을 붙이지는 않는다')
  assert.match(THREAD_ERRORS.ROOT_DELETED.message, /지워진 말/, '눈앞에 열린 스레드를 두고 "찾을 수 없습니다"라고 말하지 않는다')
  assert.equal(threadReadViolation(messages, 'm-2'), THREAD_ERRORS.ROOT_NOT_FOUND, '답글은 여전히 루트가 아니다')
  assert.equal(threadReadViolation(messages, 'm-none'), THREAD_ERRORS.ROOT_NOT_FOUND)
})

test('공유·승격이 세는 답글과 화면이 세는 답글을 갈라 둔다', () => {
  const messages = [root, reply('m-2', 'b'), reply('m-3', 'c', { deletedAt: '2026-09-01T00:00:00.000Z', text: '삭제된 메시지' })]
  assert.deepEqual(threadReplies(messages, 'm-1').map((item) => item.id), ['m-2', 'm-3'], '자리는 지워도 남는다')
  assert.deepEqual(liveThreadReplies(messages, 'm-1').map((item) => item.id), ['m-2'], '결론의 근거가 되는 것은 남아 있는 말뿐이다')
  assert.deepEqual(liveThreadReplies(messages, 'm-none'), [])
  assert.deepEqual(threadReplies(undefined, 'm-1'), [])
})

test('스레드 참여자는 루트 작성자와 답한 사람들이고, 등장 순으로 한 번씩만 센다', () => {
  const messages = [
    root,
    { id: 'm-x', senderId: 'z', text: '본채널의 다른 말' },
    reply('m-2', 'b'),
    reply('m-3', 'a'),
    reply('m-4', 'b'),
    reply('m-5', 'c', { deletedAt: '2026-09-01T00:00:00.000Z' }),
  ]
  assert.deepEqual(threadParticipantIds(messages, 'm-1'), ['a', 'b', 'c'])
  assert.deepEqual(threadParticipantIds(messages, 'm-none'), [], '없는 스레드에는 참여자도 없다')
})

test('삭제된 답글의 작성자도 참여자다 — 말은 지웠어도 그 자리에 있었다', () => {
  const messages = [root, reply('m-2', 'b', { deletedAt: '2026-09-01T00:00:00.000Z', text: '삭제된 메시지' })]
  assert.deepEqual(threadParticipantIds(messages, 'm-1'), ['a', 'b'])
})

test('루트 집계는 이전 값에 1을 더하고 나머지 키는 그대로 둔다', () => {
  const first = rootAggregates({ ...root, readBy: ['a'] }, '2026-09-01T01:00:00.000Z')
  assert.equal(first.replyCount, 1, '집계가 없던 루트는 1에서 시작한다')
  assert.equal(first.lastReplyAt, '2026-09-01T01:00:00.000Z')
  assert.deepEqual(
    { ...first, replyCount: undefined, lastReplyAt: undefined },
    { ...root, readBy: ['a'], replyCount: undefined, lastReplyAt: undefined },
    '집계 두 개 말고는 아무것도 바뀌지 않는다',
  )
  const second = rootAggregates(first, '2026-09-01T02:00:00.000Z')
  assert.equal(second.replyCount, 2)
  assert.equal(second.lastReplyAt, '2026-09-01T02:00:00.000Z', '마지막 답글 시각은 교체된다')
  assert.equal(rootAggregates({ ...root, replyCount: '3' }, 'x').replyCount, 1, '정수가 아닌 저장값은 0으로 보고 다시 센다')
})

test('본채널에 보이는 것은 답글이 아닌 메시지뿐이고, 순서는 그대로다', () => {
  const messages = [root, reply('m-2', 'b'), { id: 'm-3', senderId: 'c', text: '본채널' }, reply('m-4', 'a'), reply('m-5', 'a')]
  assert.deepEqual(mainChannelMessages(messages).map((item) => item.id), ['m-1', 'm-3'])
  assert.equal(isMainChannelMessage(root), true)
  assert.equal(isMainChannelMessage(reply('m-2', 'b')), false)
  assert.deepEqual(mainChannelMessages(undefined), [], '배열이 아니면 빈 목록이다 — 여기서 throw하면 방 하나가 통째로 500이 된다')
})

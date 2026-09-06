/**
 * 스레드 — 본채널은 "답글 N개"만, 이야기는 옆 칸에서 이어진다.
 *
 * 저장 모양: 답글은 같은 방의 messages 배열에 그대로 들어가고 threadRootId 하나로 루트를 가리킨다.
 * 별도 저장소를 만들지 않는 이유는 감독 열람·백업·PG 왕복이 전부 이 배열 하나를 보고 있기 때문이다 —
 * 답글만 다른 곳에 두면 그 셋이 각각 답글을 놓친다.
 *
 * 그 대신 "본채널에 보이는 메시지"라는 술어가 필요해진다. 이 파일이 그 술어를 한 벌만 들고 있다.
 * 술어가 여러 벌이 되면 목록·페이지·검색·고정·미읽음 중 어딘가 한 곳으로 답글이 샌다.
 *
 * 깊이는 1단이다. 답글의 답글을 허용하면 본채널의 '답글 N개'가 무엇을 세는 숫자인지 알 수 없어진다.
 */

export const THREAD_ERRORS = Object.freeze({
  ROOT_NOT_FOUND: { code: 'INVALID_THREAD_ROOT', message: '스레드를 열 메시지를 찾을 수 없습니다.' },
  // 지워진 루트는 '없는 것'과 다르다. 그 스레드는 지금 화면에 열려 있고 남의 답글이 그대로 보인다 —
  // 눈앞에 열린 스레드를 두고 '찾을 수 없습니다'라고 말하면 화면과 서버가 서로 다른 말을 하는 것이 된다.
  // 화면의 사전 안내도 이 문장 하나에서 나온다(CollaborationSuite.tsx의 THREAD_ROOT_DELETED_NOTICE).
  ROOT_DELETED: { code: 'THREAD_ROOT_DELETED', message: '지워진 말에는 답글을 달 수 없습니다. 결론은 [채널에 공유]로 남길 수 있습니다.' },
  REPLY_NOT_PINNABLE: { code: 'THREAD_REPLY_NOT_PINNABLE', message: '스레드 답글은 고정할 수 없습니다. 채널에 공유한 뒤 고정해 주세요.' },
  THREAD_EMPTY: { code: 'THREAD_EMPTY', message: '아직 답글이 없는 스레드입니다.' },
})

/** 본채널에 보이는 메시지인가. 답글은 스레드 안에만 산다. 이 술어를 여러 벌 만들면 어딘가로 샌다. */
export const isMainChannelMessage = (message) => !message?.threadRootId

export const mainChannelMessages = (messages) => (Array.isArray(messages) ? messages : []).filter(isMainChannelMessage)

const messageById = (messages, id) => (Array.isArray(messages) ? messages : []).find((item) => item?.id === id) ?? null

/**
 * 새 답글을 붙일 수 있는 루트인가 — 같은 방의, 삭제되지 않은, 그 자체가 답글이 아닌 메시지.
 * 위반이면 에러 객체를, 괜찮으면 null을 돌려준다(호출부가 그대로 응답에 실어 쓴다).
 *
 * 이것은 **쓰기 쪽** 판정이다. 이미 지워진 말에 새 답글을 붙이지는 않는다.
 */
export function threadRootViolation(messages, rootId) {
  const root = messageById(messages, rootId)
  if (!root || root.threadRootId) return THREAD_ERRORS.ROOT_NOT_FOUND
  // 읽기(threadReadViolation)는 통과하는데 쓰기만 거절하는 유일한 갈래다. 그래서 낱말이 달라야 한다 —
  // '없다'가 아니라 '지워졌다'. 화면은 이 사실을 서버보다 먼저 말하고, 두 문장은 한 벌에서 나온다.
  if (root.deletedAt) return THREAD_ERRORS.ROOT_DELETED
  return null
}

/**
 * 열어 볼 수 있는 스레드인가 — **읽기 쪽** 판정이라 deletedAt을 보지 않는다.
 *
 * 루트를 지우면 그 사람의 말만 지워진다. 답글은 다른 사람의 말이고 배열에 그대로 남아 있으므로
 * (삭제 라우트가 tombstone만 남기는 이유가 그것이다), 여기서 루트의 tombstone을 404로 돌려주면
 * 남의 말이 화면 어디에서도 열리지 않는 채로 배열에만 남는다 — 방 안 검색은 여전히 그 말을 찾아 준다.
 */
export function threadReadViolation(messages, rootId) {
  const root = messageById(messages, rootId)
  if (!root || root.threadRootId) return THREAD_ERRORS.ROOT_NOT_FOUND
  return null
}

/** 이 스레드의 답글 전부(지워진 것 포함). 자리는 남으므로 '답글 N개'는 이 수를 센다. */
export const threadReplies = (messages, rootId) =>
  (Array.isArray(messages) ? messages : []).filter((item) => item?.threadRootId === rootId)

/**
 * 아직 남아 있는 답글. 공유·승격이 "빈 스레드인가"를 판정할 때 쓰는 것은 이쪽이다 —
 * 한쪽이 tombstone을 세고 다른 쪽이 안 세면, 같은 스레드에서 공유는 되고 승격은 409가 난다.
 */
export const liveThreadReplies = (messages, rootId) =>
  threadReplies(messages, rootId).filter((item) => !item.deletedAt)

/**
 * 이 스레드에 이미 말한 사람들. 루트 작성자 ∪ 답글 작성자.
 * 삭제된 답글의 작성자도 넣는다 — 말은 지웠어도 그 스레드에 참여한 사실은 남는다.
 * 등장 순으로 유일화한다(알림 순서가 매번 뒤집히면 같은 사건이 다르게 보인다).
 */
export function threadParticipantIds(messages, rootId) {
  const rows = Array.isArray(messages) ? messages : []
  const ids = []
  for (const message of rows) {
    if (!message?.senderId) continue
    if (message.id !== rootId && message.threadRootId !== rootId) continue
    if (ids.includes(message.senderId)) continue
    ids.push(message.senderId)
  }
  return ids
}

/**
 * 답글 하나가 붙었을 때 루트가 가져야 할 집계.
 * 배열을 다시 세지 않고 이전 값에 1을 더한다 — 5,000건 방에서 답글마다 전수 세기를 하면
 * 전송 한 번이 배열 전체를 훑는다. 사람이 보는 목록은 실제 배열에서 다시 세므로(스레드 조회),
 * 이 값이 어긋나도 화면이 거짓말을 하지는 않는다.
 */
export function rootAggregates(root, replyCreatedAt) {
  return {
    ...root,
    replyCount: (Number.isInteger(root?.replyCount) ? root.replyCount : 0) + 1,
    lastReplyAt: replyCreatedAt,
  }
}

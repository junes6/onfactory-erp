import assert from 'node:assert/strict'
import test from 'node:test'

import {
  autoTitle,
  buildContext,
  CONTEXT_TOKEN_BUDGET,
  daysLeftInTrash,
  estimateTokens,
  expiredTrash,
  extractiveSummary,
  KEEP_RECENT_MESSAGES,
  messagesToFold,
  normalizeScope,
  searchConversations,
  sortConversations,
} from './ai-conversations.mjs'

const message = (role, content, index = 0) => ({ id: `M${index}`, role, content, createdAt: '2026-09-05T00:00:00.000Z' })

test('자동 제목은 첫 질문의 첫 문장을 쓴다', () => {
  assert.equal(autoTitle('금속검출기 감도 기준이 어떻게 되나요? 그리고 기록은요?'), '금속검출기 감도 기준이 어떻게 되나요')
  assert.equal(autoTitle('안녕하세요, 원료 입고 검사 절차를 알려 주세요.'), '원료 입고 검사 절차를 알려 주세요.')
  assert.equal(autoTitle('   '), '새 대화')
})

test('제목이 길면 자르되 잘렸다는 것을 보여 준다', () => {
  const title = autoTitle('가'.repeat(200))
  assert.ok(title.length <= 60)
  assert.ok(title.endsWith('…'))
})

test('한국어는 글자당 토큰을 넉넉히 잡는다', () => {
  // 상한 판정용이므로 정확할 필요는 없지만, 한글을 영어와 같게 세면 상한을 넘긴 채로 보내게 된다.
  assert.ok(estimateTokens('가나다라마') > estimateTokens('abcde'))
})

test('상한을 넘겨도 최근 대화는 반드시 넣는다', () => {
  const long = '가'.repeat(20_000)
  const messages = Array.from({ length: 20 }, (_, index) => message(index % 2 === 0 ? 'user' : 'assistant', long, index))
  const context = buildContext({ messages, summary: '' }, CONTEXT_TOKEN_BUDGET)
  assert.equal(context.messages.length, KEEP_RECENT_MESSAGES, '마지막 질문이 상한에 밀려 빠지면 대화가 성립하지 않는다')
  assert.equal(context.messages.at(-1).content, long)
})

test('짧은 대화는 통째로 넣는다', () => {
  const messages = [message('user', '재고 마감일이 언제인가요', 0), message('assistant', '매월 마지막 영업일입니다', 1)]
  const context = buildContext({ messages, summary: '' })
  assert.equal(context.messages.length, 2)
  assert.equal(context.foldedCount, 0)
})

test('접힌 앞부분은 요약 한 줄로 대신 들어간다', () => {
  const long = '나'.repeat(20_000)
  const messages = Array.from({ length: 20 }, (_, index) => message(index % 2 === 0 ? 'user' : 'assistant', long, index))
  const context = buildContext({ messages, summary: '앞서 원료 입고 기준을 정했다.' })
  assert.equal(context.summaryUsed, true)
  assert.match(context.messages[0].content, /앞부분 12건 요약/)
  assert.match(context.messages[0].content, /원료 입고 기준/)
})

test('상한 안이면 접을 것이 없다', () => {
  const messages = [message('user', '짧은 질문', 0), message('assistant', '짧은 답', 1)]
  assert.equal(messagesToFold({ messages }), null)
})

test('상한을 넘기면 최근 것을 남기고 앞부분만 접는다', () => {
  const long = '다'.repeat(20_000)
  const messages = Array.from({ length: 20 }, (_, index) => message(index % 2 === 0 ? 'user' : 'assistant', long, index))
  const folded = messagesToFold({ messages })
  assert.equal(folded.length, 20 - KEEP_RECENT_MESSAGES)
  assert.equal(folded[0].id, 'M0')
})

test('모델 없이 만드는 요약은 오간 말에서만 뽑는다', () => {
  const summary = extractiveSummary([
    message('user', '금속검출기 시험편은 무엇을 쓰나요', 0),
    message('assistant', 'Fe 2.0mm, SUS 2.5mm를 씁니다.', 1),
  ])
  assert.match(summary, /금속검출기 시험편/)
  assert.match(summary, /Fe 2\.0mm/)
  assert.match(summary, /앞부분 2건/)
})

test('검색은 낱말이 모두 들어간 대화만 남긴다', () => {
  const conversations = [
    { id: 'A', title: '금속검출기 점검', summary: '', messages: [message('user', '금속검출기 감도 기준은?', 0)] },
    { id: 'B', title: '재고 마감', summary: '', messages: [message('user', '금속 자재 재고는?', 0)] },
  ]
  // "금속"만으로는 둘 다 걸린다. 낱말을 더하면 좁혀져야 한다.
  assert.equal(searchConversations(conversations, '금속').length, 2)
  const narrowed = searchConversations(conversations, '금속 감도')
  assert.equal(narrowed.length, 1)
  assert.equal(narrowed[0].conversation.id, 'A')
  assert.match(narrowed[0].excerpt, /금속검출기 감도/)
})

test('검색어가 없어도 결과 모양은 같다', () => {
  // 모양이 다르면 검색하지 않은 목록에서만 터지는 길이 생긴다.
  const conversations = [{ id: 'A', title: 'x', messages: [] }]
  const all = searchConversations(conversations, '')
  assert.equal(all.length, 1)
  assert.equal(all[0].conversation.id, 'A')
  assert.equal(all[0].excerpt, '')
})

test('고정한 대화가 위로 온다', () => {
  const sorted = sortConversations([
    { id: 'A', pinned: false, updatedAt: '2026-09-05T10:00:00.000Z' },
    { id: 'B', pinned: true, updatedAt: '2026-09-01T10:00:00.000Z' },
    { id: 'C', pinned: false, updatedAt: '2026-09-06T10:00:00.000Z' },
  ])
  assert.deepEqual(sorted.map((item) => item.id), ['B', 'C', 'A'])
})

test('휴지통은 30일을 센다', () => {
  const now = new Date('2026-09-05T00:00:00.000Z')
  assert.equal(daysLeftInTrash({ deletedAt: '2026-09-04T00:00:00.000Z' }, now), 29)
  assert.equal(daysLeftInTrash({ deletedAt: '2026-08-01T00:00:00.000Z' }, now), 0)
  assert.equal(daysLeftInTrash({ deletedAt: null }, now), null)
})

test('만료된 것만 완전히 지운다', () => {
  const now = new Date('2026-09-05T00:00:00.000Z')
  const gone = expiredTrash([
    { id: 'A', deletedAt: '2026-07-01T00:00:00.000Z' },
    { id: 'B', deletedAt: '2026-09-04T00:00:00.000Z' },
    { id: 'C', deletedAt: null },
  ], now)
  assert.deepEqual(gone.map((item) => item.id), ['A'])
})

test('범위는 아는 값만 받는다', () => {
  assert.deepEqual(normalizeScope({ kind: '아무거나' }), { kind: 'all', id: '', label: '전체' })
  assert.deepEqual(normalizeScope({ kind: 'file', id: 'DOC-1', label: '견적서.pdf' }), { kind: 'file', id: 'DOC-1', label: '견적서.pdf' })
  assert.equal(normalizeScope({ kind: 'project', id: 'P1' }).label, '프로젝트')
})

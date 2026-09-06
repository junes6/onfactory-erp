import assert from 'node:assert/strict'
import test from 'node:test'

import { createNoticeAckWatch } from './notice-ack-watch.mjs'
import { MAX_REMINDERS_PER_RUN, NOTICES_KEY, SUMMARY_NAME_LIMIT, hasNoticeShape } from './notices.mjs'

/**
 * 필독 공지 확인 챙기기 — 판정 4의 뒷문장('48시간 후 작성자에게 미확인 명단이 도착한다').
 *
 * 진짜 시간을 기다릴 수 없으므로 시계를 인자로 민다. 여기서 지키는 세 가지:
 *  1. 멱등은 저장된 데이터에서만 나온다 — 같은 now로 두 번 돌려도 두 번째는 0건이다.
 *  2. 먼저 커밋하고 그다음에 보낸다 — 커밋이 실패하면 알림은 한 건도 나가지 않는다.
 *  3. 깨진 행이 있는 테넌트는 통째로 건너뛴다 — 성한 행만 다시 써 넣으면 깨진 행이 조용히 사라진다.
 */

const HOUR = 60 * 60 * 1_000
const CREATED = '2026-09-01T00:00:00.000Z'
const at = (hours) => new Date(Date.parse(CREATED) + hours * HOUR)

const ACCOUNTS = [
  { id: 'U-ADMIN', tenantId: 'T1', name: '김서원' },
  { id: 'U-A', tenantId: 'T1', name: '가나다' },
  { id: 'U-B', tenantId: 'T1', name: '라마바' },
  { id: 'U-C', tenantId: 'T1', name: '사아자' },
  { id: 'U-T2', tenantId: 'T2', name: '다른회사' },
  { id: 'U-T2B', tenantId: 'T2', name: '다른회사둘' },
]

const notice = (overrides = {}) => ({
  id: 'NTC-seed-0011aa', scope: 'company', conversationId: null, projectId: null,
  title: '9월 안전교육', body: '9월 12일 09:00\n대강당', attachments: [],
  authorId: 'U-ADMIN', authorName: '김서원', mustRead: true,
  targetIds: ['U-A', 'U-B', 'U-C'], acknowledgements: [],
  reminders: { remindedAt: {}, summary48SentAt: null, lastManualRemindAt: null },
  archivedAt: null, createdAt: CREATED, updatedAt: CREATED,
  ...overrides,
})

/** 스토어·스텁 한 벌. commit은 기본으로 성공하고, notify는 받은 초안을 그대로 모은다. */
function harness({ rows = [notice()], tenants, commit = async () => {} } = {}) {
  const sent = []
  const workspaceStore = {
    tenants: tenants ?? { T1: { [NOTICES_KEY]: { data: rows, updatedAt: CREATED, updatedBy: 'U-ADMIN' } } },
  }
  const run = createNoticeAckWatch({
    workspaceStore,
    accounts: ACCOUNTS,
    commitWorkspaceStore: commit,
    notify: (tenantId, drafts) => { for (const draft of drafts) sent.push({ tenantId, ...draft }) },
  })
  const stored = (tenantId = 'T1') => workspaceStore.tenants[tenantId][NOTICES_KEY].data
  return { run, sent, workspaceStore, stored }
}

const typed = (sent, type) => sent.filter((item) => item.type === type)

test('1. 23시간에는 아무것도 보내지 않고, 25시간에 미확인자 수만큼 보내며 기록을 남긴다', async () => {
  const { run, sent, stored } = harness()
  assert.deepEqual(await run(at(23)), { reminded: 0, summaries: 0 })
  assert.equal(sent.length, 0)

  assert.deepEqual(await run(at(25)), { reminded: 3, summaries: 0 })
  assert.deepEqual(typed(sent, 'notice-reminder').map((item) => item.recipientId).sort(), ['U-A', 'U-B', 'U-C'])
  assert.equal(sent[0].title, '아직 확인하지 않은 공지: 9월 안전교육')
  assert.equal(sent[0].focusId, 'company:notice:NTC-seed-0011aa')
  assert.deepEqual(Object.keys(stored()[0].reminders.remindedAt).sort(), ['U-A', 'U-B', 'U-C'])
  assert.equal(stored()[0].reminders.remindedAt['U-A'], at(25).toISOString())
  assert.equal(hasNoticeShape(stored()[0]), true, '기록을 남긴 뒤에도 저장 문을 통과해야 다음 쓰기가 막히지 않는다')
})

test('2. 같은 now로 연달아 두 번 돌려도 두 번째는 0건이다 — 멱등은 저장된 데이터에서 나온다', async () => {
  const { run, sent } = harness()
  await run(at(25))
  assert.equal(sent.length, 3)
  assert.deepEqual(await run(at(25)), { reminded: 0, summaries: 0 })
  assert.equal(sent.length, 3, '모듈 수준 Map이 아니라 reminders.remindedAt이 판정한다')
})

test('3. 49시간에 작성자에게 미확인 명단이 한 번 간다 — 이름은 10명까지, 나머지는 외 N명', async () => {
  const { run, sent, stored } = harness()
  assert.deepEqual(await run(at(49)), { reminded: 3, summaries: 1 })
  const summary = typed(sent, 'notice-unconfirmed-summary')
  assert.equal(summary.length, 1)
  assert.equal(summary[0].recipientId, 'U-ADMIN')
  assert.equal(summary[0].title, '미확인 3명 · 9월 안전교육')
  assert.equal(summary[0].body, '가나다, 라마바, 사아자')
  assert.equal(stored()[0].reminders.summary48SentAt, at(49).toISOString())

  assert.deepEqual(await run(at(49)), { reminded: 0, summaries: 0 }, '요약도 공지당 한 번이다')
  assert.equal(typed(sent, 'notice-unconfirmed-summary').length, 1)
})

test('3-b. 11명이 남으면 열 명까지 적고 나머지는 외 1명으로 접는다', async () => {
  const many = Array.from({ length: SUMMARY_NAME_LIMIT + 1 }, (_, index) => `U-M${index}`)
  const accounts = many.map((id, index) => ({ id, tenantId: 'T1', name: `사람${index}` }))
  const sent = []
  const run = createNoticeAckWatch({
    workspaceStore: { tenants: { T1: { [NOTICES_KEY]: { data: [notice({ targetIds: many })], updatedAt: CREATED, updatedBy: 'U-ADMIN' } } } },
    accounts: [...ACCOUNTS, ...accounts],
    commitWorkspaceStore: async () => {},
    notify: (_tenantId, drafts) => { for (const draft of drafts) sent.push(draft) },
  })
  await run(at(49))
  const summary = typed(sent, 'notice-unconfirmed-summary')[0]
  assert.equal(summary.title, '미확인 11명 · 9월 안전교육')
  assert.match(summary.body, / 외 1명$/)
  assert.equal(summary.body.split(', ').length, SUMMARY_NAME_LIMIT, '이름은 열 명까지만 적는다')
})

test('3-c. 이름을 못 찾는 사람은 계정 id가 아니라 \'퇴사한 계정\'으로 적힌다', async () => {
  // 명단에서 빠진 계정(계정 삭제·이관)이 있어도 요약은 사람이 읽는 문장이어야 한다.
  const sent = []
  const run = createNoticeAckWatch({
    workspaceStore: { tenants: { T1: { [NOTICES_KEY]: { data: [notice({ targetIds: ['U-A', 'U-GONE'] })], updatedAt: CREATED, updatedBy: 'U-ADMIN' } } } },
    accounts: ACCOUNTS,
    commitWorkspaceStore: async () => {},
    notify: (_tenantId, drafts) => { for (const draft of drafts) sent.push(draft) },
  })
  await run(at(49))
  const summary = typed(sent, 'notice-unconfirmed-summary')[0]
  assert.equal(summary.body, '가나다, 퇴사한 계정')
  assert.doesNotMatch(summary.body, /U-GONE/)
})

test('4. 25시간 사이에 확인한 사람에게는 가지 않고, 작성자 자신은 대상이 아니다', async () => {
  const rows = [notice({
    targetIds: ['U-ADMIN', 'U-A', 'U-B'],
    acknowledgements: [{ accountId: 'U-A', at: at(2).toISOString() }],
  })]
  const { run, sent } = harness({ rows })
  assert.deepEqual(await run(at(25)), { reminded: 1, summaries: 0 })
  assert.deepEqual(typed(sent, 'notice-reminder').map((item) => item.recipientId), ['U-B'],
    '확인한 사람과 작성자 자신은 부르지 않는다')
})

test('5. 전원이 확인했으면 요약을 만들지 않고 summary48SentAt만 찍는다 — 미확인 0명은 소음이다', async () => {
  const rows = [notice({
    acknowledgements: ['U-A', 'U-B', 'U-C'].map((accountId) => ({ accountId, at: at(3).toISOString() })),
  })]
  const { run, sent, stored } = harness({ rows })
  assert.deepEqual(await run(at(49)), { reminded: 0, summaries: 0 })
  assert.equal(sent.length, 0)
  assert.equal(stored()[0].reminders.summary48SentAt, at(49).toISOString(), '다시 판정하지 않게 도장은 찍는다')
})

test('6. 보관됐거나 필독이 아닌 공지는 챙기지 않는다', async () => {
  for (const overrides of [{ archivedAt: at(1).toISOString() }, { mustRead: false }]) {
    const { run, sent } = harness({ rows: [notice(overrides)] })
    assert.deepEqual(await run(at(49)), { reminded: 0, summaries: 0 }, JSON.stringify(overrides))
    assert.equal(sent.length, 0)
  }
})

test('7. 깨진 행이 있는 테넌트는 통째로 건너뛰고 다른 테넌트는 정상 처리한다', async () => {
  const broken = { ...notice({ id: 'NTC-bad-0011bb' }), extraKey: 1 }
  const tenants = {
    T1: { [NOTICES_KEY]: { data: [notice(), broken], updatedAt: CREATED, updatedBy: 'U-ADMIN' } },
    T2: { [NOTICES_KEY]: { data: [notice({ id: 'NTC-two-0011cc', authorId: 'U-T2', authorName: '다른회사', targetIds: ['U-T2B'] })], updatedAt: CREATED, updatedBy: 'U-T2' } },
  }
  const { run, sent, stored } = harness({ tenants })
  assert.deepEqual(await run(at(49)), { reminded: 1, summaries: 1 })
  assert.deepEqual([...new Set(sent.map((item) => item.tenantId))], ['T2'], '성한 테넌트만 처리한다')
  assert.deepEqual(stored('T1')[1], broken, '깨진 행은 그대로 남는다 — 덮어쓰면 그 행의 확인 명단을 잃는다')
  assert.equal(stored('T1')[0].reminders.remindedAt['U-A'], undefined)
})

test('8. 커밋이 실패하면 알림은 한 건도 나가지 않고 기록도 되돌아간다 — 먼저 커밋, 나중 발송', async () => {
  const { run, sent, stored } = harness({ commit: async () => { throw new Error('disk full') } })
  assert.deepEqual(await run(at(49)), { reminded: 0, summaries: 0 })
  assert.equal(sent.length, 0, '커밋 전에 보내면 다음 시간에 또 보낸다 — 중복보다 누락이 낫다')
  assert.deepEqual(stored()[0].reminders, { remindedAt: {}, summary48SentAt: null, lastManualRemindAt: null })
})

test('9. 한 번에 보내는 양은 테넌트당 상한에서 잘리고 남은 것은 다음 실행에 나간다', async () => {
  const ids = (prefix, count) => Array.from({ length: count }, (_, index) => `${prefix}${index}`)
  const rows = [
    notice({ id: 'NTC-old-0011aa', createdAt: CREATED, targetIds: ids('U-OLD-', 300) }),
    notice({ id: 'NTC-new-0011bb', createdAt: at(1).toISOString(), targetIds: ids('U-NEW-', 300) }),
  ]
  const { run, sent, stored } = harness({ rows })
  assert.deepEqual(await run(at(25)), { reminded: MAX_REMINDERS_PER_RUN, summaries: 0 })
  assert.equal(sent.length, MAX_REMINDERS_PER_RUN)
  // 오래된 공지부터 채운다 — 먼저 올린 공지가 뒤로 밀리면 영영 못 나갈 수 있다.
  assert.equal(Object.keys(stored()[0].reminders.remindedAt).length, 300)
  assert.equal(Object.keys(stored()[1].reminders.remindedAt).length, 200)

  sent.length = 0
  assert.deepEqual(await run(at(26)), { reminded: 100, summaries: 0 }, '남은 것은 다음 실행에서 나간다')
  assert.equal(Object.keys(stored()[1].reminders.remindedAt).length, 300)
})

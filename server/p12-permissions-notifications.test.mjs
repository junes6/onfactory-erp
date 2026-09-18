import assert from 'node:assert/strict'
import test from 'node:test'

import { createApp } from './app.mjs'
import { principleProposal } from './personal-core.mjs'
import { withServer } from './test-server.mjs'

/**
 * P1-2: 권한과 알림의 틈.
 *  - 규범 제안은 그 주인만 보고 결정한다. 결정 요청의 payload로 주인을 바꿔 남의(다른 고객사 포함) 개인 코어에 쓸 수 없다.
 *  - [수정 후 승인]은 종류별로 정해진 칸만 고친다. 담당자 이름을 못 찾으면 승인자에게 조용히 배정하지 않는다.
 *  - 승인으로 생긴 업무·반복 업무·휴가·업무일지가 알려야 할 사람에게 알린다.
 */

const freshStore = () => ({ version: 2, tenants: { 'TENANT-SUNSEA': {}, 'TENANT-POHANG': {} }, platform: {}, accountApprovals: {}, accountCredentials: {}, invitedAccounts: [], passwordResetRequests: [], guestGrants: [] })
const json = (cookie) => ({ 'content-type': 'application/json', cookie })
const readJson = async (response) => { const text = await response.text(); try { return JSON.parse(text) } catch { return { raw: text } } }

async function login(origin, email) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: 'tenant', email, password: 'demo1234' }),
  })
  assert.equal(response.status, 200, email)
  return (response.headers.get('set-cookie') ?? '').split(';')[0]
}
const inbox = async (origin, cookie) => (await readJson(await fetch(`${origin}/api/notifications`, { headers: { cookie } }))).items ?? []

const principle = (id, ownerAccountId) => principleProposal({
  key: `document-classification:category:${id}`, statement: `문서 분류는 항상 ${id}(으)로 한다.`, kind: 'document-classification',
  field: 'category', value: id, confidence: 0.8, evidence: [{ proposalId: 'PRP-OLD', summary: '예전 결정', decidedAt: '2026-09-01T00:00:00.000Z' }],
}, { now: '2026-09-18T00:00:00.000Z', proposalId: id, ownerAccountId })

test('규범 제안은 주인만 보고 결정한다 — payload로 주인을 바꿔 남의 개인 코어에 쓸 수 없다', async () => {
  const store = freshStore()
  store.tenants['TENANT-SUNSEA']['ai-proposals'] = { data: [principle('PRP-MINE', 'USR-SUNSEA-ADMIN'), principle('PRP-THEIRS', 'USR-SUNSEA-SOMEONE')], updatedAt: '2026-09-18T00:00:00.000Z', updatedBy: 'personal-core' }
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {} }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const queue = await readJson(await fetch(`${origin}/api/proposals`, { headers: { cookie: admin } }))
    assert.deepEqual(queue.proposals.map((item) => item.id), ['PRP-MINE'], '남의 규범 제안은 목록에 없다')
    assert.equal(queue.pendingCount, 1)

    const theirs = await fetch(`${origin}/api/proposals/PRP-THEIRS/decide`, { method: 'POST', headers: json(admin), body: JSON.stringify({ decision: 'approve' }) })
    assert.equal(theirs.status, 404, '남의 규범 제안은 없는 것처럼 답한다')

    // 주인을 다른 직원·다른 고객사 관리자로 바꾸려 해도, 결정한 사람 자신의 코어에만 들어간다.
    const mine = await readJson(await fetch(`${origin}/api/proposals/PRP-MINE/decide`, {
      method: 'POST', headers: json(admin),
      body: JSON.stringify({ decision: 'edit', payload: { ownerAccountId: 'USR-POHANG-ADMIN', statement: '거래명세서는 항상 회계로 분류한다.', evidence: [{ proposalId: 'X' }] } }),
    }))
    assert.equal(mine.proposal.status, 'edited', JSON.stringify(mine))
    assert.equal(mine.proposal.payload.ownerAccountId, 'USR-SUNSEA-ADMIN', '주인 칸은 고칠 수 없다')
    assert.deepEqual(Object.keys(mine.proposal.decisionDiff ?? {}), ['statement'])
    assert.equal(store.personal['USR-SUNSEA-ADMIN'].principles[0].statement, '거래명세서는 항상 회계로 분류한다.')
    assert.equal(store.personal['USR-POHANG-ADMIN'], undefined, '다른 고객사 관리자의 개인 코어는 만들어지지도 않는다')
  })
})

test('수정 후 승인은 정해진 칸만 고치고, 못 찾은 담당자를 승인자에게 조용히 배정하지 않는다 — 승인된 업무는 담당자와 올린 사람에게 알린다', async () => {
  const store = freshStore()
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {} }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const member = await login(origin, 'jihyun.park@sunsea.co.kr')
    const taesik = await login(origin, 'taesik.oh@sunsea.co.kr')
    // 직원이 업무 채널에 지시 문형을 올리면 관리자 승인 큐에 업무 제안이 생긴다(올린 사람 = 직원).
    const room = await readJson(await fetch(`${origin}/api/messenger/conversations/group`, { method: 'POST', headers: json(admin), body: JSON.stringify({ name: '원가 점검', participantIds: ['USR-SUNSEA-PARK', 'USR-SUNSEA-OH'] }) }))
    const sent = await fetch(`${origin}/api/messenger/conversations/${room.conversation.id}/messages`, { method: 'POST', headers: json(member), body: JSON.stringify({ text: '내일까지 8월 원가표 정리해 주세요' }) })
    assert.equal(sent.status, 201)
    const queue = await readJson(await fetch(`${origin}/api/proposals`, { headers: { cookie: admin } }))
    const proposal = queue.proposals.find((item) => item.kind === 'task-from-message')
    assert.ok(proposal, JSON.stringify(queue.proposals.map((item) => item.kind)))
    assert.equal(proposal.payload.requesterId, 'USR-SUNSEA-PARK', '말한 사람이 올린 사람이다')

    const unmatched = await readJson(await fetch(`${origin}/api/proposals/${proposal.id}/decide`, { method: 'POST', headers: json(admin), body: JSON.stringify({ decision: 'edit', payload: { owner: '없는 사람' } }) }))
    assert.equal(unmatched.error?.code, 'PROPOSAL_OWNER_UNMATCHED')

    const decided = await readJson(await fetch(`${origin}/api/proposals/${proposal.id}/decide`, {
      method: 'POST', headers: json(admin),
      body: JSON.stringify({ decision: 'edit', payload: { owner: '오태식', ownerId: 'USR-SUNSEA-OH', title: '8월 원가표 정리', createdBy: 'USR-FORGED', sourceKey: 'forged' } }),
    }))
    assert.equal(decided.proposal.status, 'edited', JSON.stringify(decided))
    assert.equal(decided.proposal.createdBy, 'ai:messenger-instruction', '목록에 없는 칸은 고칠 수 없다')
    assert.ok(!('sourceKey' in (decided.proposal.decisionDiff ?? {})))
    const work = store.tenants['TENANT-SUNSEA']['work-items'].data.find((item) => item.id === decided.resultRef.id)
    assert.equal(work.ownerId, 'USR-SUNSEA-OH')

    const assigned = (await inbox(origin, taesik)).find((item) => item.type === 'task-assigned')
    assert.ok(assigned, '승인으로 생긴 업무의 담당자에게 알린다')
    assert.equal(assigned.focusId, work.id)
    const result = (await inbox(origin, member)).find((item) => item.type === 'proposal-decided')
    assert.ok(result, '제안을 올린 직원에게 결과를 알린다')
    assert.match(result.title, /수정 후 승인/)
  })
})

test('휴가: 신청하면 결재자에게, 결정하면 신청자에게 알린다 — 누르면 인사 화면의 알맞은 탭', async () => {
  await withServer(createApp({ apiKey: '' }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const member = await login(origin, 'taesik.oh@sunsea.co.kr')
    const created = await readJson(await fetch(`${origin}/api/leave-requests`, { method: 'POST', headers: json(member), body: JSON.stringify({ type: '병가', period: '2099-01-05', days: 1, reason: '병원 진료' }) }))
    assert.ok(created.leave?.id, JSON.stringify(created))
    const request = (await inbox(origin, admin)).find((item) => item.type === 'leave-requested')
    assert.ok(request, '결재자에게 휴가 결재 요청이 간다')
    assert.equal(request.page, 'people')
    assert.equal(request.focusId, `leave:${created.leave.id}`)

    const decided = await fetch(`${origin}/api/leave-requests/${encodeURIComponent(created.leave.id)}/decision`, { method: 'PATCH', headers: json(admin), body: JSON.stringify({ decision: 'reject' }) })
    assert.equal(decided.status, 200)
    const outcome = (await inbox(origin, member)).find((item) => item.type === 'leave-decided')
    assert.ok(outcome, '신청자에게 결과가 간다')
    assert.match(outcome.title, /반려/)
    assert.equal(outcome.focusId, `leave:${created.leave.id}`)
  })
})

test('업무일지: 결재 요청은 관리자에게, 결과는 작성자에게 알린다', async () => {
  const store = freshStore()
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {} }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const member = await login(origin, 'taesik.oh@sunsea.co.kr')
    const journal = { id: 'JR-NOTIFY', date: '2026-09-18', title: '2026-09-18_오태식_업무일지', author: '오태식', department: '생산 1팀', completed: '• 원료 LOT 확인', issue: '', nextPlan: '', approver: '관리자', status: '임시저장', updatedAt: '방금', feedback: '', attachments: [], reviews: [] }
    const draft = await readJson(await fetch(`${origin}/api/daily-journals/${journal.id}/draft`, { method: 'PUT', headers: json(member), body: JSON.stringify({ journal }) }))
    assert.ok(draft.journal, JSON.stringify(draft))
    const submit = await fetch(`${origin}/api/workspace/daily-journals`, { method: 'PUT', headers: json(member), body: JSON.stringify({ data: [{ ...draft.journal, status: '결재요청' }] }) })
    assert.equal(submit.status, 200)
    const submitted = (await inbox(origin, admin)).find((item) => item.type === 'journal-submitted')
    assert.ok(submitted, '관리자에게 결재 요청이 간다')
    assert.equal(submitted.focusId, 'JR-NOTIFY')

    const review = await fetch(`${origin}/api/daily-journals/JR-NOTIFY/review`, { method: 'POST', headers: json(admin), body: JSON.stringify({ decision: 'reject', comment: '측정값을 보완해 주세요' }) })
    assert.equal(review.status, 200, await review.clone().text())
    const reviewed = (await inbox(origin, member)).find((item) => item.type === 'journal-reviewed')
    assert.ok(reviewed, '작성자에게 결과가 간다')
    assert.match(reviewed.title, /반려/)
    assert.match(reviewed.body, /측정값을 보완/)
  })
})

test('반복 규칙이 만든 업무도 담당자에게 알린다 — 스케줄러가 제시간에 만든다', async () => {
  const store = freshStore()
  const app = createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {} })
  await withServer(app, async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const member = await login(origin, 'jihyun.park@sunsea.co.kr')
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1_000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' })
    const created = await readJson(await fetch(`${origin}/api/work-rules`, {
      method: 'POST', headers: json(admin),
      body: JSON.stringify({ title: '매일 위생 점검', description: '작업장 위생 점검표를 채웁니다.', ownerId: 'USR-SUNSEA-PARK', frequency: 'daily', interval: 1, startDate: yesterday, dueTime: '18:00', priority: '보통', category: '품질' }),
    }))
    assert.ok(created.rule, JSON.stringify(created))
    assert.ok(created.created.length >= 1)
    const notice = (await inbox(origin, member)).find((item) => item.type === 'task-assigned')
    assert.ok(notice, '반복 규칙이 찍어 낸 업무의 담당자에게 알린다')
    // 스케줄러 표에도 올라 있다 — 시간이 되면 누가 앱을 열지 않아도 만든다(매시 1분).
    const job = app.locals.scheduler.listJobs().find((item) => item.id === 'work-rules')
    assert.ok(job, '반복 업무 만들기가 정기 작업에 있다')
    assert.equal(job.disabled, false)
    assert.equal(new Date(job.nextRunAt).getUTCMinutes(), 1, '매시 1분')
  })
})

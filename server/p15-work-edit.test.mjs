import assert from 'node:assert/strict'
import test from 'node:test'

import { createApp } from './app.mjs'
import { withServer } from './test-server.mjs'

/**
 * P1-5: 만든 업무를 고치고·넘기고·취소하고(보관함으로), 그 업무 안에서 이야기한다.
 * 결재 상태머신(업무요청 → 수행중 → 결재대기 → 결재완료)은 그대로다 — 이 시험은 상태가 아니라 곁기록을 잰다.
 */

const TENANT = 'TENANT-SUNSEA'
const json = (cookie) => ({ 'content-type': 'application/json', cookie })
const readJson = async (response) => { const text = await response.text(); try { return JSON.parse(text) } catch { return { raw: text } } }
async function login(origin, email) {
  const response = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: 'tenant', email, password: 'demo1234' }) })
  assert.equal(response.status, 200, email)
  return (response.headers.get('set-cookie') ?? '').split(';')[0]
}
const inbox = async (origin, cookie) => (await readJson(await fetch(`${origin}/api/notifications`, { headers: { cookie } }))).items ?? []
function memoryStorage() {
  const files = new Map()
  return {
    files, backend: 'local',
    async put(key, body) { files.set(key, Buffer.from(body)); return { key, size: body.length } },
    async get(key) { const value = files.get(key); if (!value) { const error = new Error('없음'); error.code = 'STORAGE_NOT_FOUND'; throw error } return value },
    async delete(key) { return files.delete(key) },
    async getSignedUrl(_key, options = {}) { return options.fallbackUrl ?? null },
  }
}
const task = (id, extra = {}) => ({
  id, title: `업무 ${id}`, description: '완료 기준', category: '일반', owner: '오태식', ownerId: 'USR-SUNSEA-OH',
  requestedBy: '김서원', requesterId: 'USR-SUNSEA-ADMIN', due: '2026-10-01T09:00:00.000Z', priority: '보통', status: '업무요청', ...extra,
})
const seeded = (items) => ({ version: 2, tenants: { [TENANT]: { 'work-items': { data: items, updatedAt: '2026-09-18T00:00:00.000Z', updatedBy: 'seed' } } }, platform: {}, accountApprovals: {}, accountCredentials: {}, invitedAccounts: [], passwordResetRequests: [], guestGrants: [] })
const itemsOf = (store) => store.tenants[TENANT]['work-items'].data

test('고치기: 지시한 사람·관리자만, 담당을 넘기면 새 담당에게 배정 알림과 옛 담당에게 넘어간 사실 — 기록에 남는다', async () => {
  const store = seeded([task('WK-E1')])
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {} }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const owner = await login(origin, 'taesik.oh@sunsea.co.kr')
    const next = await login(origin, 'jihyun.park@sunsea.co.kr')
    const byOwner = await fetch(`${origin}/api/work-items/WK-E1`, { method: 'PATCH', headers: json(owner), body: JSON.stringify({ title: '담당이 고친 제목' }) })
    assert.equal(byOwner.status, 403, '담당자는 지시 내용을 고치지 않는다(완료 보고로 말한다)')

    const edited = await readJson(await fetch(`${origin}/api/work-items/WK-E1`, { method: 'PATCH', headers: json(admin), body: JSON.stringify({ title: '9월 원가표 정리', priority: '높음', ownerId: 'USR-SUNSEA-PARK' }) }))
    assert.equal(edited.item.title, '9월 원가표 정리')
    assert.equal(edited.item.ownerId, 'USR-SUNSEA-PARK')
    assert.equal(edited.item.owner, '박지현')
    assert.equal(edited.item.status, '업무요청', '상태는 그대로')
    assert.deepEqual(edited.item.activity.map((entry) => `${entry.kind}:${entry.field ?? ''}`), ['edit:title', 'edit:priority', 'owner:'])
    assert.equal(edited.item.activity[2].from, '오태식')
    assert.equal(edited.item.activity[2].to, '박지현')
    assert.ok((await inbox(origin, next)).some((item) => item.type === 'task-assigned' && item.focusId === 'WK-E1'), '새 담당에게 배정 알림')
    assert.ok((await inbox(origin, owner)).some((item) => item.type === 'task-updated' && /박지현님에게 넘어갔습니다/.test(item.title)), '옛 담당에게 넘어간 사실')
  })
})

test('지시한 사람을 바꾸면(관리자) 결재대기 업무의 확인을 새 사람이 같은 절차로 한다 — 부재한 요청자에 막히지 않는다', async () => {
  const store = seeded([task('WK-E2', { status: '결재대기', completion: { summary: '완료했습니다', evidence: [{ id: 'DOC-EVIDENCE-1', name: '현장사진.jpg', size: '120KB', type: 'image/jpeg' }], submittedAt: '2026-09-17T00:00:00.000Z', submittedById: 'USR-SUNSEA-OH', submittedByName: '오태식' } })])
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {} }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const lee = await login(origin, 'jungmin.lee@sunsea.co.kr')
    const owner = await login(origin, 'taesik.oh@sunsea.co.kr')
    const byMember = await fetch(`${origin}/api/work-items/WK-E2`, { method: 'PATCH', headers: json(owner), body: JSON.stringify({ requesterId: 'USR-SUNSEA-LEE' }) })
    assert.equal(byMember.status, 403)
    const ownerLocked = await fetch(`${origin}/api/work-items/WK-E2`, { method: 'PATCH', headers: json(admin), body: JSON.stringify({ ownerId: 'USR-SUNSEA-LEE' }) })
    assert.equal(ownerLocked.status, 409, '확인을 기다리는 업무는 담당을 넘기지 않는다')
    const handed = await readJson(await fetch(`${origin}/api/work-items/WK-E2`, { method: 'PATCH', headers: json(admin), body: JSON.stringify({ requesterId: 'USR-SUNSEA-LEE' }) }))
    assert.equal(handed.item.requesterId, 'USR-SUNSEA-LEE')
    assert.ok((await inbox(origin, lee)).some((item) => item.type === 'approval-requested' && item.focusId === 'WK-E2'))
    const approved = await fetch(`${origin}/api/work-items/WK-E2/transition`, { method: 'POST', headers: json(lee), body: JSON.stringify({ action: 'approve', review: { comment: '확인했습니다' } }) })
    assert.equal(approved.status, 200, '새 요청자가 같은 확인 절차로 끝낸다')
  })
})

test('업무 댓글: 담당·지시한 사람·관리자만 쓰고 읽으며, 상대에게 알린다 — 지우면 자리만 남는다', async () => {
  const store = seeded([task('WK-E3')])
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {} }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const owner = await login(origin, 'taesik.oh@sunsea.co.kr')
    const outsider = await login(origin, 'jihyun.park@sunsea.co.kr')
    const posted = await readJson(await fetch(`${origin}/api/work-items/WK-E3/comments`, { method: 'POST', headers: json(owner), body: JSON.stringify({ text: '견적서 양식은 작년 것으로 할까요?' }) }))
    assert.equal(posted.comment.authorName, '오태식')
    assert.ok((await inbox(origin, admin)).some((item) => item.type === 'task-comment' && item.focusId === 'WK-E3'), '지시한 사람에게 알린다')
    assert.equal((await fetch(`${origin}/api/work-items/WK-E3/comments`, { method: 'POST', headers: json(outsider), body: JSON.stringify({ text: '끼어들기' }) })).status, 404, '관계없는 사람에게 이 업무는 없다')
    assert.equal((await fetch(`${origin}/api/work-items/WK-E3/comments/${posted.comment.id}`, { method: 'DELETE', headers: json(outsider) })).status, 404)
    const removed = await readJson(await fetch(`${origin}/api/work-items/WK-E3/comments/${posted.comment.id}`, { method: 'DELETE', headers: json(owner) }))
    const kept = removed.item.comments.find((comment) => comment.id === posted.comment.id)
    assert.equal(kept.text, '', '원문은 남기지 않는다')
    assert.ok(kept.deletedAt)
    // 담당자는 일반 저장으로 댓글·기록을 바꿀 수 없다(직원 저장 규칙이 상태 말고는 같아야 한다고 본다).
    const forged = itemsOf(store).map((item) => item.id === 'WK-E3' ? { ...item, comments: [] } : item)
    assert.equal((await fetch(`${origin}/api/workspace/work-items`, { method: 'PUT', headers: json(owner), body: JSON.stringify({ data: forged }) })).status, 403)
  })
})

test('취소는 보관함으로(사유와 함께, 하위 업무도 함께) — 취소한 사람이 되살리면 기록과 함께 돌아온다', async () => {
  const store = seeded([task('WK-C1'), task('WK-C1-A', { parentId: 'WK-C1', title: '하위 업무' }), task('WK-OTHER')])
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {}, documentStorage: memoryStorage() }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const owner = await login(origin, 'taesik.oh@sunsea.co.kr')
    assert.equal((await fetch(`${origin}/api/work-items/WK-C1/cancel`, { method: 'POST', headers: json(owner), body: JSON.stringify({ reason: '필요 없어짐' }) })).status, 403, '담당자는 취소하지 않는다')
    assert.equal((await fetch(`${origin}/api/work-items/WK-C1/cancel`, { method: 'POST', headers: json(admin), body: JSON.stringify({ reason: '' }) })).status, 400, '이유가 있어야 한다')
    const cancelled = await readJson(await fetch(`${origin}/api/work-items/WK-C1/cancel`, { method: 'POST', headers: json(admin), body: JSON.stringify({ reason: '거래처가 발주를 철회함' }) }))
    assert.deepEqual(cancelled.cancelled.sort(), ['WK-C1', 'WK-C1-A'])
    assert.deepEqual(itemsOf(store).map((item) => item.id), ['WK-OTHER'], '진행 중 목록에서 빠진다(지워지지 않고 보관함으로)')
    const notice = (await inbox(origin, owner)).find((item) => item.type === 'task-updated' && /취소됐습니다/.test(item.title))
    assert.ok(notice, '담당자에게 이유와 함께 알린다')
    assert.match(notice.body, /거래처가 발주를 철회함/)
    const archived = await readJson(await fetch(`${origin}/api/work-items/archive`, { headers: { cookie: admin } }))
    assert.ok(archived.rows.some((row) => row.id === 'WK-C1' && row.cancelled.reason === '거래처가 발주를 철회함'))

    const restored = await readJson(await fetch(`${origin}/api/work-items/cancelled/WK-C1/restore`, { method: 'POST', headers: json(admin), body: '{}' }))
    assert.deepEqual(restored.restored.sort(), ['WK-C1', 'WK-C1-A'], '함께 취소된 하위 업무도 함께 돌아온다')
    const back = itemsOf(store).find((item) => item.id === 'WK-C1')
    assert.equal(back.cancelled, undefined, '취소 표시는 떼고')
    assert.deepEqual(back.activity.map((entry) => entry.kind), ['cancel', 'restore'], '취소와 되살림은 기록에 남는다')
    assert.equal(back.status, '업무요청')
  })
})

test('착수와 마감 변경이 기록에 남는다 — 전에는 값만 덮어썼다', async () => {
  const store = seeded([task('WK-A1')])
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {} }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const owner = await login(origin, 'taesik.oh@sunsea.co.kr')
    assert.equal((await fetch(`${origin}/api/work-items/WK-A1/transition`, { method: 'POST', headers: json(owner), body: JSON.stringify({ action: 'accept' }) })).status, 200)
    const scheduled = await fetch(`${origin}/api/work-items/WK-A1/schedule`, { method: 'POST', headers: json(admin), body: JSON.stringify({ due: '2026-10-05T09:00:00.000Z' }) })
    assert.equal(scheduled.status, 200, await scheduled.clone().text())
    const item = itemsOf(store).find((row) => row.id === 'WK-A1')
    assert.deepEqual(item.activity.map((entry) => entry.kind), ['accept', 'schedule'])
    assert.equal(item.activity[0].actorName, '오태식')
    assert.equal(item.activity[1].from, '2026-10-01T09:00:00.000Z')
    assert.equal(item.activity[1].to, '2026-10-05T09:00:00.000Z')
  })
})

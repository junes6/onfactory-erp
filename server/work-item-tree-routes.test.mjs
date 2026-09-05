import assert from 'node:assert/strict'
import test from 'node:test'

import { createApp } from './app.mjs'
import { buildDigest } from './daily-digest.mjs'
import { withServer } from './test-server.mjs'

/**
 * 하위 업무 트리 — HTTP 계약.
 *
 * 저장(관리자 PUT)·조회(직원 envelope)·완료 보고 차단(submit 409)·이동 라우트(/parent)·알림 묶음·롤백·검색·브리핑 회귀를
 * 실제 앱으로 한 번씩 밟는다. 모든 시험은 자기 store로 시작해 순서에 기대지 않는다.
 */

const TENANT = 'TENANT-SUNSEA'
const ADMIN = { id: 'USR-SUNSEA-ADMIN', name: '김서원', email: 'admin@sunsea.co.kr' }
const PARK = { id: 'USR-SUNSEA-PARK', name: '박지현', email: 'jihyun.park@sunsea.co.kr' }
const OH = { id: 'USR-SUNSEA-OH', name: '오태식', email: 'taesik.oh@sunsea.co.kr' }

// 다른 테넌트의 상위 후보. 이 id를 parentId로 저장하려는 시도가 "없는 상위"로 끝나고 저쪽 배열이 변하지 않아야 한다.
const POHANG_PARENT = { id: 'WK-POHANG-P', title: '포항 상위', description: '', owner: '박해진', ownerId: 'USR-POHANG-ADMIN', requestedBy: '박해진', requesterId: 'USR-POHANG-ADMIN', due: '2026-09-30T09:00:00.000Z', priority: '보통', status: '업무요청', category: '일반' }
const freshStore = () => ({
  version: 2,
  tenants: { [TENANT]: {}, 'TENANT-POHANG': { 'work-items': { data: [POHANG_PARENT], updatedAt: '2026-09-01T00:00:00.000Z' } } },
  platform: {}, accountApprovals: {}, accountCredentials: {}, invitedAccounts: [], passwordResetRequests: [], guestGrants: [],
})
const buildApp = (store, extra = {}) => createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {}, ...extra })
const readJson = async (response) => { const text = await response.text(); try { return JSON.parse(text) } catch { return { raw: text } } }

async function login(origin, email, password = 'demo1234') {
  const response = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: 'tenant', email, password }) })
  const body = await readJson(response)
  assert.equal(response.status, 200, JSON.stringify(body))
  const account = body.account
  return { account, headers: { 'content-type': 'application/json', cookie: response.headers.get('set-cookie') ?? '', 'x-workspace-identity': `${account.tenantId}:${account.id}` } }
}
const api = (origin, session) => async (method, route, body) => {
  const response = await fetch(`${origin}${route}`, { method, headers: session.headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return { status: response.status, body: await readJson(response) }
}

const item = (id, owner, overrides = {}) => ({
  id, title: `${id} 제목`, description: '', owner: owner.name, ownerId: owner.id, requestedBy: ADMIN.name, requesterId: ADMIN.id,
  due: '2026-09-10T09:00:00.000Z', priority: '보통', status: '업무요청', category: '일반', ...overrides,
})
const family = () => [item('P', PARK), item('C1', OH, { parentId: 'P' }), item('C2', PARK, { parentId: 'P' })]
const transition = (call, id, action, extra = {}) => call('POST', `/api/work-items/${id}/transition`, { action, ...extra })
const submitBody = { completion: { summary: '완료 보고 내용입니다.', evidence: [] } }

test('1. 저장·조회·상속: 관리자 PUT은 parentId를 보존하고, 자식만 보는 직원은 상위 제목만 받는다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const a = api(origin, await login(origin, ADMIN.email))
    const oh = api(origin, await login(origin, OH.email))
    const saved = await a('PUT', '/api/workspace/work-items', { data: family() })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))

    const adminList = await a('GET', '/api/workspace/work-items')
    assert.equal(adminList.status, 200)
    assert.deepEqual(adminList.body.data.map((row) => [row.id, row.parentId]), [['P', undefined], ['C1', 'P'], ['C2', 'P']])
    assert.equal('parents' in adminList.body, false, '관리자는 상위가 data에 있으므로 envelope가 없다')

    const ohList = await oh('GET', '/api/workspace/work-items')
    assert.deepEqual(ohList.body.data.map((row) => row.id), ['C1'], '직원은 자기 담당 자식만')
    assert.equal(ohList.body.parents.P.title, 'P 제목')
    assert.deepEqual(Object.keys(ohList.body.parents.P), ['id', 'title'], '상위의 담당·상태·마감은 주지 않는다')

    // projectId 상속: 상위만 프로젝트에 귀속되면 자식과 어긋난다.
    const project = await a('POST', '/api/projects', { name: '트리 프로젝트' })
    assert.equal(project.status, 201, JSON.stringify(project.body))
    const projectId = project.body.project.id
    const mismatch = await a('PUT', '/api/workspace/work-items', { data: [item('P', PARK, { projectId }), item('C1', OH, { parentId: 'P' }), item('C2', PARK, { parentId: 'P', projectId })] })
    assert.equal(mismatch.status, 400)
    assert.equal(mismatch.body.error.code, 'SUBTASK_PROJECT_MISMATCH')
    assert.equal(mismatch.body.error.itemId, 'C1')
    const aligned = await a('PUT', '/api/workspace/work-items', { data: family().map((row) => ({ ...row, projectId })) })
    assert.equal(aligned.status, 200, JSON.stringify(aligned.body))
  })
})

test('2. 관리자 PUT 음성 6종: 상위 없음·자기 참조·3단·고아·타 테넌트·잠긴 상위', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const a = api(origin, await login(origin, ADMIN.email))
    const expect = async (data, code) => {
      const result = await a('PUT', '/api/workspace/work-items', { data })
      assert.equal(result.status, 400, `${code}: ${JSON.stringify(result.body)}`)
      assert.equal(result.body.error.code, code)
    }
    await expect([item('C', PARK, { parentId: 'NOPE' })], 'SUBTASK_PARENT_NOT_FOUND')
    await expect([item('S', PARK, { parentId: 'S' })], 'INVALID_WORK_ITEMS')
    await expect([item('P', PARK), item('C', PARK, { parentId: 'P' }), item('G', PARK, { parentId: 'C' })], 'SUBTASK_DEPTH_EXCEEDED')
    // 고아: 상위와 자식을 먼저 저장한 뒤 상위만 빼고 다시 저장한다.
    assert.equal((await a('PUT', '/api/workspace/work-items', { data: [item('P', PARK), item('C', PARK, { parentId: 'P' })] })).status, 200)
    await expect([item('C', PARK, { parentId: 'P' })], 'SUBTASK_ORPHANED')
    // 타 테넌트 상위: 없는 상위와 같은 답이고, 저쪽 배열은 그대로다.
    const pohangBefore = store.tenants['TENANT-POHANG']['work-items'].data.length
    await expect([item('P', PARK), item('C', PARK, { parentId: 'P' }), item('X', PARK, { parentId: 'WK-POHANG-P' })], 'SUBTASK_PARENT_NOT_FOUND')
    assert.equal(store.tenants['TENANT-POHANG']['work-items'].data.length, pohangBefore)
    // 결재완료 상위에 새 자식.
    assert.equal((await a('PUT', '/api/workspace/work-items', { data: [item('DONE', PARK, { status: '결재완료' })] })).status, 200)
    await expect([item('DONE', PARK, { status: '결재완료' }), item('N', PARK, { parentId: 'DONE' })], 'SUBTASK_PARENT_LOCKED')
  })
})

test('3. 직원 PUT은 parentId를 바꿀 수 없고(403), 상태만 바꾸는 저장은 parentId를 보존한다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const a = api(origin, await login(origin, ADMIN.email))
    const park = api(origin, await login(origin, PARK.email))
    assert.equal((await a('PUT', '/api/workspace/work-items', { data: family() })).status, 200)
    const mine = (await park('GET', '/api/workspace/work-items')).body.data
    assert.deepEqual(mine.map((row) => row.id), ['P', 'C2'])
    const detached = await park('PUT', '/api/workspace/work-items', { data: mine.map((row) => { if (row.id !== 'C2') return row; const { parentId: _drop, ...rest } = row; return rest }) })
    assert.equal(detached.status, 403)
    assert.equal(detached.body.error.code, 'WORK_ITEM_TRANSITION_FORBIDDEN')
    const accepted = await park('PUT', '/api/workspace/work-items', { data: mine.map((row) => (row.id === 'C2' ? { ...row, status: '수행중' } : row)) })
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body))
    const stored = store.tenants[TENANT]['work-items'].data.find((row) => row.id === 'C2')
    assert.equal(stored.status, '수행중')
    assert.equal(stored.parentId, 'P')
  })
})

test('4. 판정 3: 하위가 남아 있으면 상위 완료 보고는 409이고 건수만 말한다; 전부 결재완료되면 통과하고 그 뒤에는 자식을 더 붙일 수 없다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const a = api(origin, await login(origin, ADMIN.email))
    const park = api(origin, await login(origin, PARK.email))
    const oh = api(origin, await login(origin, OH.email))
    assert.equal((await a('PUT', '/api/workspace/work-items', { data: family() })).status, 200)

    assert.equal((await transition(park, 'P', 'accept')).status, 200)
    const blocked = await transition(park, 'P', 'submit', submitBody)
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body))
    assert.equal(blocked.body.error.code, 'SUBTASKS_INCOMPLETE')
    assert.equal(blocked.body.error.count, 2)
    assert.doesNotMatch(blocked.body.error.message, /C1 제목|C2 제목/, '자식 제목은 메시지에 싣지 않는다')

    assert.equal((await transition(oh, 'C1', 'accept')).status, 200)
    assert.equal((await transition(oh, 'C1', 'submit', submitBody)).status, 200)
    assert.equal((await transition(a, 'C1', 'approve', { review: { comment: '' } })).status, 200)
    const oneLeft = await transition(park, 'P', 'submit', submitBody)
    assert.equal(oneLeft.status, 409)
    assert.equal(oneLeft.body.error.count, 1)

    assert.equal((await transition(park, 'C2', 'accept')).status, 200)
    assert.equal((await transition(park, 'C2', 'submit', submitBody)).status, 200)
    assert.equal((await transition(a, 'C2', 'approve', { review: { comment: '' } })).status, 200)
    const submitted = await transition(park, 'P', 'submit', submitBody)
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body))
    assert.equal(submitted.body.item.status, '결재대기')
    const approved = await transition(a, 'P', 'approve', { review: { comment: '' } })
    assert.equal(approved.status, 200)
    assert.equal(approved.body.item.status, '결재완료')

    const current = store.tenants[TENANT]['work-items'].data
    const late = await a('PUT', '/api/workspace/work-items', { data: [...current, item('C3', OH, { parentId: 'P' })] })
    assert.equal(late.status, 400)
    assert.equal(late.body.error.code, 'SUBTASK_PARENT_LOCKED')
  })
})

test('5. 자식은 상위 상태와 무관하게 자기 결재 흐름을 다 밟는다', async () => {
  await withServer(buildApp(freshStore()), async (origin) => {
    const a = api(origin, await login(origin, ADMIN.email))
    const oh = api(origin, await login(origin, OH.email))
    assert.equal((await a('PUT', '/api/workspace/work-items', { data: family() })).status, 200)
    assert.equal((await transition(oh, 'C1', 'accept')).status, 200)
    assert.equal((await transition(oh, 'C1', 'submit', submitBody)).status, 200)
    const approved = await transition(a, 'C1', 'approve', { review: { comment: '' } })
    assert.equal(approved.status, 200)
    assert.equal(approved.body.item.status, '결재완료')
    assert.equal(approved.body.item.parentId, 'P')
  })
})

test('6. /parent 라우트: 지시자·관리자만, 깊이·잠금·존재 비노출·형식·무쓰기', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const a = api(origin, await login(origin, ADMIN.email))
    const park = api(origin, await login(origin, PARK.email))
    const oh = api(origin, await login(origin, OH.email))
    const project = await a('POST', '/api/projects', { name: '이동 프로젝트' })
    const projectId = project.body.project.id
    // 가족 1(P·C1: 박지현이 볼 수 있다), 가족 2(Q·D: 지시자 박지현·담당 오태식), 박지현 담당 미완료 상위 P2(프로젝트 귀속),
    // 결재완료 상위 DONE, 관리자만 보는 상위 HIDDEN.
    const seed = [
      item('P', PARK), item('C1', PARK, { parentId: 'P' }),
      item('Q', OH, { requestedBy: PARK.name, requesterId: PARK.id }), item('D', OH, { parentId: 'Q', requestedBy: PARK.name, requesterId: PARK.id }),
      item('P2', PARK, { projectId }), item('DONE', PARK, { status: '결재완료' }), item('HIDDEN', ADMIN),
    ]
    assert.equal((await a('PUT', '/api/workspace/work-items', { data: seed })).status, 200)
    const move = (call, id, body) => call('POST', `/api/work-items/${id}/parent`, body)

    const byOwner = await move(oh, 'D', { parentId: 'P2' })
    assert.equal(byOwner.status, 403)
    assert.equal(byOwner.body.error.code, 'SUBTASK_MOVE_FORBIDDEN')

    const parentWithChildren = await move(park, 'Q', { parentId: 'P2' })
    assert.equal(parentWithChildren.status, 400)
    assert.equal(parentWithChildren.body.error.code, 'SUBTASK_DEPTH_EXCEEDED')

    const underChild = await move(park, 'D', { parentId: 'C1' })
    assert.equal(underChild.status, 400)
    assert.equal(underChild.body.error.code, 'SUBTASK_DEPTH_EXCEEDED')

    const locked = await move(park, 'D', { parentId: 'DONE' })
    assert.equal(locked.status, 409, '상태 충돌은 409')
    assert.equal(locked.body.error.code, 'SUBTASK_PARENT_LOCKED')

    const missing = await move(park, 'D', { parentId: 'NOPE' })
    assert.equal(missing.status, 400)
    assert.equal(missing.body.error.code, 'SUBTASK_PARENT_NOT_FOUND')

    for (const body of [{}, { parentId: '' }, { parentId: 123 }, { parentId: 'D' }]) {
      const invalid = await move(park, 'D', body)
      assert.equal(invalid.status, 400, JSON.stringify(body))
      assert.equal(invalid.body.error.code, 'SUBTASK_PARENT_INVALID', JSON.stringify(body))
    }

    const moved = await move(park, 'D', { parentId: 'P2' })
    assert.equal(moved.status, 200, JSON.stringify(moved.body))
    assert.equal(moved.body.item.parentId, 'P2')
    assert.equal(moved.body.item.projectId, projectId, '상위의 projectId를 상속한다')

    const before = await park('GET', '/api/workspace/work-items')
    const same = await move(park, 'D', { parentId: 'P2' })
    assert.equal(same.status, 200)
    assert.equal(same.body.updatedAt, before.body.updatedAt, '같은 상위로 다시 보내면 쓰지 않는다')
    assert.equal(same.body.version, before.body.version)

    const promoted = await move(park, 'D', { parentId: null })
    assert.equal(promoted.status, 200)
    assert.equal('parentId' in promoted.body.item, false)
    assert.equal(promoted.body.item.projectId, projectId, '승격은 projectId를 그대로 둔다')

    // 직원이 볼 수 없는 상위는 "없는 상위"와 같은 답이다 — 존재를 알려 주지 않는다.
    const hidden = await move(park, 'D', { parentId: 'HIDDEN' })
    assert.equal(hidden.status, 400)
    assert.equal(hidden.body.error.code, 'SUBTASK_PARENT_NOT_FOUND')
    const byAdmin = await move(a, 'D', { parentId: 'HIDDEN' })
    assert.equal(byAdmin.status, 200, JSON.stringify(byAdmin.body))
    assert.equal(byAdmin.body.item.parentId, 'HIDDEN')
    assert.equal('projectId' in byAdmin.body.item, false, '상위에 projectId가 없으면 자식도 잃는다')
  })
})

test('7. 알림 묶음: 한 저장에서 같은 사람에게 간 상위 1 + 자식 2는 알림 한 건', async () => {
  await withServer(buildApp(freshStore()), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const a = api(origin, admin)
    const oh = api(origin, await login(origin, OH.email))
    const rows = [item('P1', OH, { due: '2026-09-12T09:00:00.000Z' }), item('K1', OH, { parentId: 'P1', due: '2026-09-08T09:00:00.000Z' }), item('K2', OH, { parentId: 'P1', due: '2026-09-09T09:00:00.000Z' })]
    assert.equal((await a('PUT', '/api/workspace/work-items', { data: rows })).status, 200)
    const inbox = await oh('GET', '/api/notifications')
    const assigned = inbox.body.items.filter((entry) => entry.type === 'task-assigned')
    assert.equal(assigned.length, 1, JSON.stringify(inbox.body.items))
    assert.match(assigned[0].title, /새 업무 3건/)
    assert.equal(assigned[0].focusId, 'P1')
    assert.match(assigned[0].body, /첫 마감 2026-09-08/)
    const adminInbox = await a('GET', '/api/notifications')
    assert.equal(adminInbox.body.items.some((entry) => entry.type === 'task-assigned'), false, '지시한 사람은 받지 않는다')
  })
})

test('8. 커밋 실패 시 /parent는 500이고 메모리 값은 이전으로 돌아간다', async () => {
  const store = freshStore()
  let failNext = false
  const app = createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => { if (failNext) { failNext = false; throw new Error('disk full') } } })
  await withServer(app, async (origin) => {
    const a = api(origin, await login(origin, ADMIN.email))
    assert.equal((await a('PUT', '/api/workspace/work-items', { data: [item('P', PARK), item('Q', PARK), item('C', PARK, { parentId: 'P' })] })).status, 200)
    failNext = true
    const failed = await a('POST', '/api/work-items/C/parent', { parentId: 'Q' })
    assert.equal(failed.status, 500)
    assert.equal(failed.body.error.code, 'SUBTASK_MOVE_WRITE_FAILED')
    const after = await a('GET', '/api/workspace/work-items')
    assert.equal(after.body.data.find((row) => row.id === 'C').parentId, 'P')
  })
})

test('9. 검색: 자식 hit의 meta에 상위 제목이 붙되, 볼 수 있는 상위일 때만', async () => {
  await withServer(buildApp(freshStore()), async (origin) => {
    const a = api(origin, await login(origin, ADMIN.email))
    const oh = api(origin, await login(origin, OH.email))
    const rows = [
      item('P', PARK, { title: '상위 냉장창고 점검' }), item('C1', OH, { parentId: 'P', title: '하위 냉장창고 온도 기록' }),
      // 오태식이 상위의 담당인 짝 — '볼 수 있으면 붙는다'의 긍정 갈래도 함께 잠근다.
      item('P2', OH, { title: '상위 냉장창고 서류' }), item('C2', OH, { parentId: 'P2', title: '하위 냉장창고 서류 정리' }),
    ]
    assert.equal((await a('PUT', '/api/workspace/work-items', { data: rows })).status, 200)
    const taskHits = (result) => result.body.groups.find((group) => group.kind === 'task')?.items ?? []
    const adminHit = taskHits(await a('GET', `/api/search?q=${encodeURIComponent('하위 냉장창고')}`)).find((hit) => hit.id === 'C1')
    assert.ok(adminHit, '관리자 검색에 자식이 걸린다')
    assert.match(adminHit.meta, /상위: 상위 냉장창고 점검/)
    assert.ok(adminHit.meta.length <= 120)
    const ohHits = taskHits(await oh('GET', `/api/search?q=${encodeURIComponent('하위 냉장창고')}`))
    const ohHit = ohHits.find((hit) => hit.id === 'C1')
    assert.ok(ohHit, '담당자 검색에도 자식은 걸린다')
    assert.doesNotMatch(ohHit.meta, /상위:/, '볼 수 없는 상위의 제목은 검색 meta로도 새지 않는다')
    const ohOwnHit = ohHits.find((hit) => hit.id === 'C2')
    assert.ok(ohOwnHit, '자기가 상위까지 담당인 자식도 걸린다')
    assert.match(ohOwnHit.meta, /상위: 상위 냉장창고 서류/, '볼 수 있는 상위라면 직원에게도 제목이 붙는다')
  })
})

test('10. 브리핑 회귀: 상위와 자식은 각각 한 행으로 센다', () => {
  const morning = new Date('2026-08-31T00:30:00.000Z') // KST 09:30
  const digest = buildDigest({ 'work-items': { data: [
    item('P', PARK, { due: '2026-08-31T09:00:00.000Z' }),
    item('C1', OH, { parentId: 'P', due: '2026-08-31T09:00:00.000Z' }),
  ] } }, { now: morning })
  const dueToday = digest.lines.find((line) => line.id === 'due-today')
  assert.match(dueToday.text, /오늘 마감 업무 2건/)
})

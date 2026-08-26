import assert from 'node:assert/strict'
import test from 'node:test'

import { createApp } from './app.mjs'
import { withServer } from './test-server.mjs'

async function login(origin, email) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: 'tenant', email, password: 'demo1234' }),
  })
  assert.equal(response.status, 200, `${email} login`)
  const account = (await response.json()).account
  return { cookie: response.headers.get('set-cookie'), account, identity: `${account.tenantId}:${account.id}` }
}

const todoFetch = (origin, path, session, init = {}) => fetch(`${origin}${path}`, {
  ...init,
  headers: { cookie: session.cookie, 'x-workspace-identity': session.identity, ...init.headers },
})

const todo = (index, ownerId = 'USR-SUNSEA-OH') => ({
  id: `TODO-LIMIT-${index}`, ownerId, title: `할 일 ${index}`, status: 'open', origin: 'manual', priority: 'normal',
  dueAt: null, completedAt: null, createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z',
  source: null, reason: '', automationEnabled: false,
})

test('personal To-do CRUD is private, persistent, and AI sync is source-backed and idempotent', async () => {
  const initialWorkspaceStore = {
    version: 2,
    tenants: {
      'TENANT-SUNSEA': {
        'work-items': { data: [
          { id: 'WORK-OH-KEEP', title: '냉장고 점검', ownerId: 'USR-SUNSEA-OH', owner: '오태식', requesterId: 'USR-SUNSEA-ADMIN', requestedBy: '김서원', status: '업무요청', priority: '높음', due: '2026-08-26T09:00:00.000Z' },
          { id: 'WORK-OH-DISMISS', title: '포장 수량 확인', ownerId: 'USR-SUNSEA-OH', owner: '오태식', requesterId: 'USR-SUNSEA-ADMIN', requestedBy: '김서원', status: '수행중', priority: '보통', due: '2026-08-26T10:00:00.000Z' },
          { id: 'WORK-PARK', title: '품질 서류 검토', ownerId: 'USR-SUNSEA-PARK', owner: '박지현', requesterId: 'USR-SUNSEA-ADMIN', requestedBy: '김서원', status: '업무요청', priority: '보통', due: '2026-08-26T11:00:00.000Z' },
        ], updatedAt: '2026-08-26T00:00:00.000Z', updatedBy: 'seed' },
        'daily-journals': { data: [], updatedAt: '2026-08-26T00:00:00.000Z', updatedBy: 'seed' },
      },
    },
    platform: {}, accountApprovals: {}, accountCredentials: {}, invitedAccounts: [], passwordResetRequests: [],
  }
  let instant = '2026-08-26T00:10:00.000Z'
  const options = { apiKey: '', initialWorkspaceStore, personalTodoClock: () => new Date(instant) }

  await withServer(createApp(options), async (origin) => {
    const employee = await login(origin, 'taesik.oh@sunsea.co.kr')
    const colleague = await login(origin, 'jihyun.park@sunsea.co.kr')
    const admin = await login(origin, 'admin@sunsea.co.kr')

    assert.equal((await fetch(`${origin}/api/personal-todos`)).status, 401)
    const wrongIdentity = await todoFetch(origin, '/api/personal-todos', { ...employee, identity: colleague.identity })
    assert.equal(wrongIdentity.status, 401)

    const genericRead = await todoFetch(origin, '/api/workspace/personal-todos', employee)
    assert.equal(genericRead.status, 403)
    assert.equal((await genericRead.json()).error.code, 'PERSONAL_TODO_ROUTE_REQUIRED')
    const genericWrite = await todoFetch(origin, '/api/workspace/personal-todos', admin, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: [] }),
    })
    assert.equal(genericWrite.status, 403)

    const synced = await todoFetch(origin, '/api/personal-todos/ai-sync', employee, { method: 'POST' })
    const syncedBody = await synced.json()
    assert.equal(synced.status, 200, JSON.stringify(syncedBody))
    assert.equal(syncedBody.changes.created, 3, 'two assigned work items and today journal are materialized')
    assert.ok(syncedBody.items.every((item) => item.ownerId === employee.account.id))
    assert.ok(syncedBody.items.every((item) => item.origin === 'ai'))

    const repeated = await todoFetch(origin, '/api/personal-todos/ai-sync', employee, { method: 'POST' })
    const repeatedBody = await repeated.json()
    assert.deepEqual(repeatedBody.changes, { created: 0, completed: 0 })
    assert.equal(repeatedBody.items.length, 3)

    const created = await todoFetch(origin, '/api/personal-todos', employee, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '내가 직접 기획한 개선', priority: 'high', dueAt: '2026-08-27T14:59:59.999Z' }),
    })
    const createdBody = await created.json()
    assert.equal(created.status, 201, JSON.stringify(createdBody))
    const manualId = createdBody.item.id
    assert.equal(createdBody.item.origin, 'manual')

    const colleagueView = await todoFetch(origin, '/api/personal-todos', colleague)
    assert.deepEqual((await colleagueView.json()).items, [], 'a colleague cannot see personal items')
    const adminView = await todoFetch(origin, '/api/personal-todos', admin)
    assert.deepEqual((await adminView.json()).items, [], 'a tenant admin cannot see employee personal items')
    assert.equal((await todoFetch(origin, `/api/personal-todos/${manualId}`, colleague, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ completed: true }) })).status, 404)
    assert.equal((await todoFetch(origin, `/api/personal-todos/${manualId}`, admin, { method: 'DELETE' })).status, 404)

    const edited = await todoFetch(origin, `/api/personal-todos/${manualId}`, employee, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '내가 수정한 개선 계획', completed: true }),
    })
    assert.equal(edited.status, 200, await edited.text())
    const reopened = await todoFetch(origin, `/api/personal-todos/${manualId}`, employee, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ completed: false }),
    })
    assert.equal(reopened.status, 200, await reopened.text())

    const workTodo = syncedBody.items.find((item) => item.source?.id === 'WORK-OH-KEEP')
    const dismissedTodo = syncedBody.items.find((item) => item.source?.id === 'WORK-OH-DISMISS')
    assert.ok(workTodo && dismissedTodo)
    assert.equal((await todoFetch(origin, `/api/personal-todos/${dismissedTodo.id}`, employee, { method: 'DELETE' })).status, 200)
    const afterDismissSync = await todoFetch(origin, '/api/personal-todos/ai-sync', employee, { method: 'POST' })
    const afterDismissBody = await afterDismissSync.json()
    assert.equal(afterDismissBody.changes.created, 0, 'dismissed AI source remains tombstoned')
    assert.ok(!afterDismissBody.items.some((item) => item.id === dismissedTodo.id))

    const formalBefore = structuredClone(initialWorkspaceStore.tenants['TENANT-SUNSEA']['work-items'].data)
    initialWorkspaceStore.tenants['TENANT-SUNSEA']['work-items'].data = formalBefore.map((item) => item.id === 'WORK-OH-KEEP' ? { ...item, status: '결재완료' } : item)
    instant = '2026-08-26T02:00:00.000Z'
    const autoCompleted = await todoFetch(origin, '/api/personal-todos/ai-sync', employee, { method: 'POST' })
    const autoCompletedBody = await autoCompleted.json()
    assert.equal(autoCompletedBody.changes.completed, 1)
    assert.equal(autoCompletedBody.items.find((item) => item.id === workTodo.id).status, 'completed')
    assert.equal(initialWorkspaceStore.tenants['TENANT-SUNSEA']['work-items'].data.find((item) => item.id === 'WORK-OH-KEEP').status, '결재완료', 'AI sync never rewrites the formal state machine')

    const userReopen = await todoFetch(origin, `/api/personal-todos/${workTodo.id}`, employee, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ completed: false }),
    })
    assert.equal(userReopen.status, 200, await userReopen.text())
    const noForcedRecomplete = await todoFetch(origin, '/api/personal-todos/ai-sync', employee, { method: 'POST' })
    const noForcedRecompleteBody = await noForcedRecomplete.json()
    assert.equal(noForcedRecompleteBody.changes.completed, 0)
    assert.equal(noForcedRecompleteBody.items.find((item) => item.id === workTodo.id).status, 'open')

    assert.equal((await todoFetch(origin, `/api/personal-todos/${manualId}`, employee, { method: 'DELETE' })).status, 200)
  })

  await withServer(createApp(options), async (origin) => {
    const employee = await login(origin, 'taesik.oh@sunsea.co.kr')
    const persisted = await todoFetch(origin, '/api/personal-todos', employee)
    const body = await persisted.json()
    assert.equal(persisted.status, 200)
    assert.ok(body.items.some((item) => item.source?.id === 'WORK-OH-KEEP'), 'personal state remains after restart')
    assert.ok(!body.items.some((item) => item.source?.id === 'WORK-OH-DISMISS'), 'dismissed AI source stays hidden after restart')
  })
})

test('personal To-do owner cap rejects the next item without corrupting the store', async () => {
  const initialWorkspaceStore = {
    version: 2,
    tenants: { 'TENANT-SUNSEA': { 'personal-todos': { data: Array.from({ length: 500 }, (_, index) => todo(index)), updatedAt: '2026-08-26T00:00:00.000Z', updatedBy: 'seed' } } },
    platform: {}, accountApprovals: {}, accountCredentials: {}, invitedAccounts: [], passwordResetRequests: [],
  }
  await withServer(createApp({ apiKey: '', initialWorkspaceStore }), async (origin) => {
    const employee = await login(origin, 'taesik.oh@sunsea.co.kr')
    const response = await todoFetch(origin, '/api/personal-todos', employee, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '한도 초과' }),
    })
    assert.equal(response.status, 409)
    assert.equal((await response.json()).error.code, 'PERSONAL_TODO_LIMIT_REACHED')
    const stillReadable = await todoFetch(origin, '/api/personal-todos', employee)
    assert.equal((await stillReadable.json()).items.length, 500)
  })
})

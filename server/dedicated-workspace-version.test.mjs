import assert from 'node:assert/strict'
import test from 'node:test'

import { createApp } from './app.mjs'
import { withServer } from './test-server.mjs'

const TENANT_ID = 'TENANT-SUNSEA'
const ADMIN_ID = 'USR-SUNSEA-ADMIN'
const ADMIN_SCOPE = `${TENANT_ID}:${ADMIN_ID}`
const MEMBER_ID = 'USR-SUNSEA-OH'
const MEMBER_SCOPE = `${TENANT_ID}:${MEMBER_ID}`

function seoulDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

async function login(origin, email) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: 'tenant', email, password: 'demo1234' }),
  })
  assert.equal(response.status, 200)
  return response.headers.get('set-cookie')
}

function headers(cookie, scope, version) {
  return {
    cookie,
    'content-type': 'application/json',
    'x-workspace-identity': scope,
    ...(version ? { 'if-match': `"${version}"` } : {}),
  }
}

test('work-rule dedicated commit returns the exact version accepted by the next generic CRUD write and stores UTC due', async () => {
  await withServer(createApp({ apiKey: '' }), async (origin) => {
    const cookie = await login(origin, 'admin@sunsea.co.kr')
    const today = seoulDate()
    const weekday = new Date(`${today}T00:00:00Z`).getUTCDay()
    const create = await fetch(`${origin}/api/work-rules`, {
      method: 'POST', headers: headers(cookie, ADMIN_SCOPE),
      body: JSON.stringify({
        title: '전용 API 버전 동기화', description: '전용 저장 뒤 일반 저장의 ETag를 검증합니다.',
        ownerId: 'USR-SUNSEA-PARK', frequency: 'weekly', interval: 1,
        startDate: today, weekday, dueTime: '16:00', priority: '보통', category: '품질',
      }),
    })
    const created = await create.json()
    assert.equal(create.status, 201, JSON.stringify(created))
    assert.match(created.version, /^[A-Za-z0-9_-]{43}$/)
    assert.match(created.workItemsVersion, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(created.created.length, 1)
    assert.equal(created.created[0].due, new Date(`${today}T16:00:00+09:00`).toISOString())
    assert.match(created.created[0].due, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

    const genericDelete = await fetch(`${origin}/api/workspace/work-rules`, {
      method: 'PUT', headers: headers(cookie, ADMIN_SCOPE, created.version), body: JSON.stringify({ data: [] }),
    })
    const deleted = await genericDelete.json()
    assert.equal(genericDelete.status, 200, JSON.stringify(deleted))
    assert.match(deleted.version, /^[A-Za-z0-9_-]{43}$/)
  })
})

test('journal draft dedicated commit version lets the immediate approval-request write proceed without stale 409', async () => {
  await withServer(createApp({ apiKey: '' }), async (origin) => {
    const cookie = await login(origin, 'taesik.oh@sunsea.co.kr')
    const today = seoulDate()
    const draft = {
      id: 'J-ETAG-SEQUENCE', date: today, title: `${today}_오태식_업무일지`, authorId: MEMBER_ID,
      author: '오태식', department: '생산 1팀', completed: '작업장 위생 점검', issue: '', nextPlan: '',
      approver: '김서원', status: '임시저장', updatedAt: new Date().toISOString(), feedback: '',
      attachments: [], reviews: [], draftRevision: 1,
    }
    const autosave = await fetch(`${origin}/api/daily-journals/${draft.id}/draft`, {
      method: 'PUT', headers: headers(cookie, MEMBER_SCOPE), body: JSON.stringify({ journal: draft }),
    })
    const autosaved = await autosave.json()
    assert.equal(autosave.status, 200, JSON.stringify(autosaved))
    assert.match(autosaved.version, /^[A-Za-z0-9_-]{43}$/)

    const submit = await fetch(`${origin}/api/workspace/daily-journals`, {
      method: 'PUT', headers: headers(cookie, MEMBER_SCOPE, autosaved.version),
      body: JSON.stringify({ data: [{ ...autosaved.journal, status: '결재요청', completed: '작업장 위생 점검을 완료했습니다.' }] }),
    })
    const submitted = await submit.json()
    assert.equal(submit.status, 200, JSON.stringify(submitted))
    const reload = await fetch(`${origin}/api/workspace/daily-journals`, { headers: headers(cookie, MEMBER_SCOPE) })
    const reloaded = await reload.json()
    assert.equal(reload.status, 200, JSON.stringify(reloaded))
    assert.equal(reloaded.data.find((journal) => journal.id === draft.id)?.status, '결재요청')
  })
})

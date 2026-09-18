import assert from 'node:assert/strict'
import test from 'node:test'

import { createApp } from './app.mjs'
import { withServer } from './test-server.mjs'

/**
 * P1-7(감사 ai-08): 렌즈가 뽑은 할 일을 승인 큐로 보내는 문은 **읽을 수 있는 구성원 누구에게나** 열린다.
 * 결정은 여전히 관리자가 큐에서 한다. 문서(위키)에서 연 렌즈도 같은 문을 쓴다.
 * 1:1 대화에 붙은 파일은 보내지 않는다 — 파일 이름과 요약이 관리자 큐로 나간다.
 */

const json = (cookie) => ({ 'content-type': 'application/json', cookie })
const readJson = async (response) => { const text = await response.text(); try { return JSON.parse(text) } catch { return { raw: text } } }
async function login(origin, email) {
  const response = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: 'tenant', email, password: 'demo1234' }) })
  assert.equal(response.status, 200, email)
  return (response.headers.get('set-cookie') ?? '').split(';')[0]
}
function memoryStorage() {
  const files = new Map()
  return {
    files, backend: 'local',
    async put(key, body) { files.set(key, Buffer.from(body)); return { key, size: body.length } },
    async get(key) { const value = files.get(key); if (!value) { const error = new Error('없음'); error.code = 'STORAGE_NOT_FOUND'; throw error } return value },
    async delete(key) { return files.delete(key) },
    async exists(key) { return files.has(key) },
    async getSignedUrl(_key, options = {}) { return options.fallbackUrl ?? null },
  }
}
const emptyStore = () => ({ version: 2, tenants: {}, platform: {}, accountApprovals: {}, accountCredentials: {}, invitedAccounts: [], passwordResetRequests: [], guestGrants: [] })
async function upload(origin, cookie, name, tags = '') {
  const response = await fetch(`${origin}/api/documents?name=${encodeURIComponent(name)}&visibility=all${tags ? `&tags=${encodeURIComponent(tags)}` : ''}`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-type': 'application/pdf', 'x-file-name': encodeURIComponent(name) }, body: Buffer.from(`%PDF ${name}`),
  })
  assert.equal(response.status, 201, name)
  return (await response.json()).document
}
const TASKS = [{ title: '갱신 통보 발송', owner: '', due: '2026-10-01', reason: '제3조 자동 갱신' }]
const send = (origin, cookie, id, tasks = TASKS) => fetch(`${origin}/api/documents/${id}/lens/tasks`, {
  method: 'POST', headers: json(cookie), body: JSON.stringify({ lensId: 'LENS-BUILTIN-TASKS', lensName: '업무 추출', tasks }),
})

test('직원도 렌즈 할 일을 관리자 큐로 보낸다 — 큐 건수는 받지 않고, 결정되면 알림을 받는다', async () => {
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: emptyStore(), onWorkspaceStoreChange: () => {}, documentStorage: memoryStorage() }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const member = await login(origin, 'taesik.oh@sunsea.co.kr')
    const document = await upload(origin, member, '유지보수계약.pdf')

    const sent = await send(origin, member, document.id)
    assert.equal(sent.status, 201, '전에는 관리자 전용이라 403이었다')
    const body = await readJson(sent)
    assert.equal(body.queued, 1)
    assert.equal(body.pendingCount, undefined, '직원은 관리자 큐의 건수를 받지 않는다')

    const queue = await readJson(await fetch(`${origin}/api/proposals`, { headers: { cookie: admin } }))
    const proposal = queue.proposals.find((item) => item.kind === 'lens-task')
    assert.ok(proposal)
    assert.equal(proposal.createdBy, 'USR-SUNSEA-OH')
    const decided = await fetch(`${origin}/api/proposals/${proposal.id}/decide`, { method: 'POST', headers: json(admin), body: JSON.stringify({ decision: 'approve' }) })
    assert.equal(decided.status, 200)
    const { resultRef } = await readJson(decided)
    const created = (await readJson(await fetch(`${origin}/api/workspace/work-items`, { headers: { cookie: admin } }))).data.find((item) => item.id === resultRef.id)
    assert.equal(created.due, '2026-10-01T09:00:00.000Z', "날짜만 뽑힌 마감('2026-10-01')은 그날 서울 18:00")
    const inbox = (await readJson(await fetch(`${origin}/api/notifications`, { headers: { cookie: member } }))).items ?? []
    assert.ok(inbox.some((item) => item.type === 'proposal-decided' && /승인됐습니다: 갱신 통보 발송/.test(item.title)), '보낸 직원이 결과를 안다')
  })
})

test('문서(위키)에서 연 렌즈도 보낸다 — 승인된 업무의 출처는 그 문서로 되짚는다', async () => {
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: emptyStore(), onWorkspaceStoreChange: () => {}, documentStorage: memoryStorage() }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const member = await login(origin, 'taesik.oh@sunsea.co.kr')
    const created = await readJson(await fetch(`${origin}/api/wiki`, { method: 'POST', headers: json(member), body: JSON.stringify({ title: '9월 운영 회의' }) }))
    const wikiId = created.document?.id
    assert.match(String(wikiId), /^WDOC-/)

    const sent = await send(origin, member, wikiId)
    assert.equal(sent.status, 201, '전에는 자료실만 찾아 404였다')
    const queue = await readJson(await fetch(`${origin}/api/proposals`, { headers: { cookie: admin } }))
    const proposal = queue.proposals.find((item) => item.kind === 'lens-task')
    assert.match(proposal.evidence, /9월 운영 회의/)
    const decided = await readJson(await fetch(`${origin}/api/proposals/${proposal.id}/decide`, { method: 'POST', headers: json(admin), body: JSON.stringify({ decision: 'approve' }) }))
    const items = (await readJson(await fetch(`${origin}/api/workspace/work-items`, { headers: { cookie: admin } }))).data ?? []
    const task = items.find((item) => item.id === decided.resultRef.id)
    assert.deepEqual({ page: task.origin.page, focusId: task.origin.focusId }, { page: 'wiki', focusId: wikiId })

    assert.equal((await send(origin, member, 'WDOC-NOPE')).status, 404)
  })
})

test('1:1 대화에 붙은 파일은 보내지 않는다 — 대화 밖(관리자 큐)으로 이름·요약이 나가지 않게', async () => {
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: emptyStore(), onWorkspaceStoreChange: () => {}, documentStorage: memoryStorage() }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const member = await login(origin, 'taesik.oh@sunsea.co.kr')
    const attached = await upload(origin, member, '연봉계약_초안.pdf', 'conversation:DM-GONE')
    const refused = await send(origin, member, attached.id)
    assert.equal(refused.status, 409)
    assert.equal((await readJson(refused)).error.code, 'LENS_PRIVATE_CONVERSATION')
    const queue = await readJson(await fetch(`${origin}/api/proposals`, { headers: { cookie: admin } }))
    assert.equal(queue.proposals.filter((item) => item.kind === 'lens-task').length, 0)
  })
})

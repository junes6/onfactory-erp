import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { aiLevelOf, aiMayDerive, aiMayList, aiMayReadBody } from './ai-policy.mjs'
import { createApp } from './app.mjs'
import { withServer } from './test-server.mjs'

/**
 * 문서(위키) × 기존 AI 표면 — 렌즈·대화 컨텍스트·첨부 게이트·파생물 파기.
 *
 * 이 시험이 지키는 선: **본문은 명시 첨부(또는 렌즈)로만 모델에 간다.**
 * 목록 컨텍스트에는 제목·요약만 실린다 — 자료(`chat-document-integration.test.mjs`)에 이미 그어 둔 선이다.
 */

const readJson = async (response) => { const text = await response.text(); try { return JSON.parse(text) } catch { return { raw: text } } }

async function login(origin, email, password = 'demo1234') {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: 'tenant', email, password }),
  })
  assert.equal(response.status, 200)
  const body = await readJson(response)
  return {
    account: body.account,
    headers: {
      'content-type': 'application/json',
      cookie: response.headers.get('set-cookie') ?? '',
      'x-workspace-identity': `${body.account.tenantId}:${body.account.id}`,
    },
  }
}
const api = (origin, session) => async (method, route, body) => {
  const response = await fetch(`${origin}${route}`, {
    method, headers: session.headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: response.status, body: await readJson(response), response }
}

function billingSpy() {
  const calls = { reservations: [], events: [] }
  return {
    calls,
    service: {
      reserveUsage: async (_actor, input) => { calls.reservations.push(input); return { reservation: { ...input, status: 'pending' } } },
      recordUsageEvent: async (_actor, input) => { calls.events.push(input); return { event: input } },
      recordReconciliationPending: async (_actor, input) => ({ reconciliation: input }),
      releaseUsageReservation: async () => {},
    },
  }
}

const lensClient = (captured) => ({
  messages: {
    countTokens: async () => ({ input_tokens: 12 }),
    create: async (input) => {
      captured.push(input)
      return {
        id: `lens-${captured.length}`, model: 'claude-test', usage: { input_tokens: 12, output_tokens: 30 },
        content: [{ type: 'text', text: JSON.stringify({ headline: '요약', bullets: ['가', '나', '다'], decisions: [], evidence: [{ quote: '표준', where: '1문단' }], insufficient: false }) }],
      }
    },
  },
})

const withApp = async (options, run) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'onfactory-wiki-int-'))
  try {
    await withServer(createApp({ workspaceStoreFile: path.join(directory, 'state.json'), ...options }), run)
  } finally { await rm(directory, { recursive: true, force: true }) }
}

const seedDocument = async (call, { title, blocks = [], aiLevel = null, writeScope = null }) => {
  const created = await call('POST', '/api/wiki', { title })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  let document = created.body.document
  if (writeScope) {
    const opened = await call('PATCH', `/api/wiki/${document.id}`, { version: document.version, writeScope })
    assert.equal(opened.status, 200, JSON.stringify(opened.body))
    document = opened.body.document
  }
  if (blocks.length) {
    const ops = blocks.map((text, index) => ({
      opId: `OP-SEED${Date.now().toString(36).toUpperCase()}${index}`,
      kind: 'insert', after: null, block: { id: `BLK-SEED${Date.now().toString(36).toUpperCase()}${index}`, type: 'text', text },
    }))
    const written = await call('POST', `/api/wiki/${document.id}/ops`, { baseVersion: document.version, ops })
    assert.equal(written.status, 200, JSON.stringify(written.body))
    document = written.body.document
  }
  if (aiLevel) {
    const patched = await call('PATCH', `/api/wiki/${document.id}`, { version: document.version, aiLevel })
    assert.equal(patched.status, 200, JSON.stringify(patched.body))
    document = patched.body.document
  }
  return document
}

test('렌즈는 문서를 자료와 같은 라우트로 읽고, 그 문서를 한 글자도 고치지 않는다', async () => {
  const captured = []
  const billing = billingSpy()
  await withApp({ apiKey: 'test-key', model: 'claude-test', client: lensClient(captured), billingService: billing.service }, async (origin) => {
    const call = api(origin, await login(origin, 'admin@sunsea.co.kr'))
    const document = await seedDocument(call, { title: '품질 점검 표준', blocks: ['냉장 4도 이하를 유지한다.'] })

    const run = await call('POST', `/api/documents/${document.id}/lens`, { lensId: 'LENS-BUILTIN-CORE' })
    assert.equal(run.status, 200, JSON.stringify(run.body))
    assert.equal(run.body.source.mime, 'text/markdown')
    assert.equal(run.body.source.documentId, document.id)
    assert.deepEqual(billing.calls.reservations.map((entry) => entry.feature), ['document-lens'])
    assert.ok(JSON.stringify(captured[0].messages).includes('냉장 4도 이하'), '본문이 모델 입력에 실린다')

    // 렌즈 실행은 레코드를 쓰지 않는다 — 문서에도 같은 불변식이 걸린다.
    const after = await call('GET', `/api/wiki/${document.id}`)
    assert.equal(after.body.document.version, document.version)
    assert.equal(after.body.document.lastEditedAt, document.lastEditedAt)
  })
})

test('못 읽는 문서 id는 자료와 같은 404이고, 보관만 문서는 403으로 갈라 답한다', async () => {
  const captured = []
  await withApp({ apiKey: 'test-key', model: 'claude-test', client: lensClient(captured), billingService: billingSpy().service }, async (origin) => {
    const admin = api(origin, await login(origin, 'admin@sunsea.co.kr'))
    const member = api(origin, await login(origin, 'jihyun.park@sunsea.co.kr'))
    const secret = await seedDocument(admin, { title: '작성자만 보는 초안', blocks: ['인사 계획'] })
    // 프로젝트 없는 문서는 회사 전원이 읽는다 — 존재 비노출을 보려면 없는 id를 쓴다.
    const missing = await member('POST', '/api/documents/WDOC-NOSUCHDOC/lens', { lensId: 'LENS-BUILTIN-CORE' })
    assert.equal(missing.status, 404)
    assert.equal(missing.body.error.code, 'DOCUMENT_NOT_FOUND', '위키 전용 코드를 내면 그 자체가 존재 신호가 된다')

    const locked = await admin('PATCH', `/api/wiki/${secret.id}`, { version: secret.version, aiLevel: 'locked' })
    assert.equal(locked.status, 200, JSON.stringify(locked.body))
    const blocked = await admin('POST', `/api/documents/${secret.id}/lens`, { lensId: 'LENS-BUILTIN-CORE' })
    assert.equal(blocked.status, 403)
    assert.equal(blocked.body.error.code, 'WIKI_AI_LEVEL_BLOCKED')
    assert.equal(captured.length, 0, '막힌 요청은 모델에 닿지 않는다')
  })
})

test('AI 대화 컨텍스트에는 제목·요약만 가고 본문은 가지 않으며, 보관만 문서는 이름조차 없다', async () => {
  let capturedSystem = ''
  const client = {
    messages: {
      countTokens: async () => ({ input_tokens: 5 }),
      create: async ({ system }) => {
        capturedSystem = typeof system === 'string' ? system : JSON.stringify(system)
        return { id: 'chat-1', model: 'claude-test', usage: {}, content: [{ type: 'text', text: '확인했습니다.' }] }
      },
    },
  }
  await withApp({ apiKey: 'test-key', model: 'claude-test', client, billingService: billingSpy().service }, async (origin) => {
    const call = api(origin, await login(origin, 'admin@sunsea.co.kr'))
    await seedDocument(call, { title: '보이는 문서', blocks: ['본문에만 있는 비밀낱말 크레바스'] })
    const hidden = await seedDocument(call, { title: '숨은 문서', blocks: ['숨은 본문'] })
    const locked = await call('PATCH', `/api/wiki/${hidden.id}`, { version: hidden.version, aiLevel: 'locked' })
    assert.equal(locked.status, 200, JSON.stringify(locked.body))

    const chat = await call('POST', '/api/chat', { messages: [{ role: 'user', content: '문서 목록 알려줘' }] })
    assert.equal(chat.status, 200, JSON.stringify(chat.body))
    assert.ok(capturedSystem.includes('보이는 문서'), '정리 수준 문서는 제목이 실린다')
    assert.equal(capturedSystem.includes('숨은 문서'), false, '보관만 문서는 이름조차 나가지 않는다')
    assert.equal(capturedSystem.includes('크레바스'), false, '본문은 명시 첨부로만 모델에 간다')
    assert.ok(capturedSystem.includes('accessibleWikiDocuments'), '자료 목록과 섞지 않는다')
    assert.ok(capturedSystem.includes('accessibleDocuments'))
  })
})

test('요약에 남은 링크 라벨은 모델로도 나가지 않는다 — 컨텍스트도 렌더 시점에 재인가한다', async () => {
  let capturedSystem = ''
  const client = {
    messages: {
      countTokens: async () => ({ input_tokens: 5 }),
      create: async ({ system }) => {
        capturedSystem = typeof system === 'string' ? system : JSON.stringify(system)
        return { id: 'chat-2', model: 'claude-test', usage: {}, content: [{ type: 'text', text: '확인했습니다.' }] }
      },
    },
  }
  // 오태식·박지현은 이 업무의 담당자도 지시자도 아니라 제목을 볼 수 없다. 관리자는 볼 수 있으므로 링크를 쓸 수 있다.
  const store = {
    version: 2,
    tenants: {
      'TENANT-SUNSEA': {
        'work-items': {
          data: [{
            id: 'WK-ADMINONLY', title: '관리자만 보는 업무', description: '', owner: '김서원', ownerId: 'USR-SUNSEA-ADMIN',
            requestedBy: '김서원', requesterId: 'USR-SUNSEA-ADMIN', due: '2026-12-31', priority: '보통',
            status: '업무요청', category: '일반', createdAt: '2026-09-01T00:00:00.000Z',
          }],
          updatedAt: '2026-09-01T00:00:00.000Z',
        },
      },
    },
    platform: {},
  }
  await withServer(createApp({
    apiKey: 'test-key', model: 'claude-test', client, billingService: billingSpy().service,
    initialWorkspaceStore: store, onWorkspaceStoreChange: () => {},
  }), async (origin) => {
    const admin = api(origin, await login(origin, 'admin@sunsea.co.kr'))
    const member = api(origin, await login(origin, 'jihyun.park@sunsea.co.kr'))
    const document = await seedDocument(admin, { title: '요약에 링크' })
    const patched = await admin('PATCH', `/api/wiki/${document.id}`, {
      version: document.version, summary: '요약메모 [[task:WK-ADMINONLY|관리자만 보는 업무]] 끝',
    })
    assert.equal(patched.status, 200, JSON.stringify(patched.body))

    const chat = await member('POST', '/api/chat', { messages: [{ role: 'user', content: '문서 목록 알려줘' }] })
    assert.equal(chat.status, 200, JSON.stringify(chat.body))
    assert.ok(capturedSystem.includes('요약에 링크'), '문서 제목은 실린다')
    assert.equal(capturedSystem.includes('관리자만 보는 업무'), false, `요약을 통해 볼 수 없는 업무 제목이 모델로 갔다: ${capturedSystem.slice(0, 400)}`)
    assert.ok(capturedSystem.includes('접근 권한 없음'), '요약도 본문과 같이 재인가돼야 한다')
  })
})

test('AI 처리 수준을 낮추면 같은 커밋에서 파생물을 파기한다', async () => {
  await withApp({ apiKey: '' }, async (origin) => {
    const admin = api(origin, await login(origin, 'admin@sunsea.co.kr'))
    const member = api(origin, await login(origin, 'jihyun.park@sunsea.co.kr'))
    const document = await seedDocument(admin, { title: '파생물 파기', aiLevel: 'active', writeScope: 'tenant' })

    // 직원이 문단 둘을 승격해 pending 제안 둘을 만든다.
    const detail = await admin('GET', `/api/wiki/${document.id}`)
    const version = detail.body.document.version
    const ops = ['첫 할 일', '둘째 할 일'].map((text, index) => ({
      opId: `OP-TASKSEED${index}${Date.now().toString(36).toUpperCase()}`,
      kind: 'insert', after: null, block: { id: `BLK-TASKSEED${index}${Date.now().toString(36).toUpperCase()}`, type: 'todo', text, checked: false },
    }))
    const written = await member('POST', `/api/wiki/${document.id}/ops`, { baseVersion: version, ops })
    assert.equal(written.status, 200, JSON.stringify(written.body))
    const todos = written.body.document.blocks.filter((block) => block.type === 'todo')
    assert.equal(todos.length, 2)
    for (const todo of todos) {
      const queued = await member('POST', `/api/wiki/${document.id}/blocks/${todo.id}/task`, {})
      assert.equal(queued.status, 201, JSON.stringify(queued.body))
    }
    const before = await admin('GET', '/api/proposals')
    assert.equal(before.body.proposals.filter((row) => row.kind === 'wiki-task' && row.status === 'pending').length, 2)

    // 사람이 쓴 요약은 남기고 AI가 쓴 것만 지운다 — 여기서는 summarySource가 'manual'이라 유지된다.
    const summarised = await admin('PATCH', `/api/wiki/${document.id}`, { version: written.body.version, summary: '사람이 쓴 요약' })
    assert.equal(summarised.status, 200, JSON.stringify(summarised.body))

    const lowered = await admin('PATCH', `/api/wiki/${document.id}`, { version: summarised.body.version, aiLevel: 'locked' })
    assert.equal(lowered.status, 200, JSON.stringify(lowered.body))
    assert.equal(lowered.body.discarded.proposals, 2)
    assert.equal(lowered.body.discarded.summary, false)
    assert.equal(lowered.body.document.summary, '사람이 쓴 요약', '사람이 쓴 요약은 파기 대상이 아니다')

    const after = await admin('GET', '/api/proposals')
    assert.equal(after.body.proposals.filter((row) => row.kind === 'wiki-task' && row.status === 'pending').length, 0)
  })
})

test('승인된 문서 제안의 업무는 문서로 되돌아간다', async () => {
  await withApp({ apiKey: '' }, async (origin) => {
    const admin = api(origin, await login(origin, 'admin@sunsea.co.kr'))
    const member = api(origin, await login(origin, 'jihyun.park@sunsea.co.kr'))
    const document = await seedDocument(admin, { title: '승격 경로', aiLevel: 'active', writeScope: 'tenant' })
    const detail = await admin('GET', `/api/wiki/${document.id}`)
    const written = await member('POST', `/api/wiki/${document.id}/ops`, {
      baseVersion: detail.body.document.version,
      ops: [{ opId: `OP-APPROVE${Date.now().toString(36).toUpperCase()}`, kind: 'insert', after: null, block: { id: `BLK-APPROVE${Date.now().toString(36).toUpperCase()}`, type: 'todo', text: '설비 점검 예약', checked: false } }],
    })
    assert.equal(written.status, 200, JSON.stringify(written.body))
    const todo = written.body.document.blocks.find((block) => block.type === 'todo')
    assert.equal((await member('POST', `/api/wiki/${document.id}/blocks/${todo.id}/task`, {})).status, 201)

    const listed = await admin('GET', '/api/proposals')
    const proposal = listed.body.proposals.find((row) => row.kind === 'wiki-task')
    assert.ok(proposal)
    const decided = await admin('POST', `/api/proposals/${proposal.id}/decide`, { decision: 'approve' })
    assert.equal(decided.status, 200, JSON.stringify(decided.body))
    assert.equal(decided.body.resultRef.type, 'work-item')

    const workItems = await admin('GET', '/api/workspace/work-items')
    const created = workItems.body.data.find((row) => row.id === decided.body.resultRef.id)
    assert.ok(created, '승인 큐를 거쳐 업무가 만들어진다')
    assert.equal(created.origin.label, '문서에서 승격')
    assert.equal(created.origin.page, 'wiki', '승인 큐가 아니라 원본 문서로 되돌아가야 한다')
    assert.equal(created.origin.focusId, document.id)
  })
})

test('AI 처리 수준이 없던 레거시 자료는 오늘 그대로 동작한다', () => {
  // 이 값이 생기기 전에 올라간 행을 조용히 잠그면 어제까지 되던 기능이 오늘 403이 된다.
  assert.equal(aiLevelOf({ id: 'DOC-LEGACY' }), 'active')
  assert.equal(aiMayList('active'), true)
  assert.equal(aiMayReadBody('active'), true)
  assert.equal(aiMayDerive('active'), true)
  // 자료의 aiPolicy도 같은 어휘로 읽힌다 — 두 필드가 두 어휘가 되면 게이트가 갈라진다.
  assert.equal(aiLevelOf({ aiPolicy: 'locked' }), 'locked')
  assert.equal(aiLevelOf({ aiLevel: 'indexed', aiPolicy: 'locked' }), 'indexed')
})

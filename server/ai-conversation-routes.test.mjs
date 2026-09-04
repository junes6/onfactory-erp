import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createApp } from './app.mjs'
import { withServer } from './test-server.mjs'

const PARK = { email: 'jihyun.park@sunsea.co.kr', password: 'demo1234' }
const OH = { email: 'taesik.oh@sunsea.co.kr', password: 'demo1234' }

async function signIn(origin, who) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: 'tenant', ...who }),
  })
  assert.equal(response.status, 200, `${who.email} 로그인 실패`)
  const account = (await response.json()).account
  return {
    account,
    headers: {
      cookie: response.headers.get('set-cookie'),
      'x-workspace-identity': `${account.tenantId}:${account.id}`,
      'content-type': 'application/json',
    },
  }
}

async function withApp(run, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ai-conversations-'))
  try {
    // apiKey 없이 띄운다 — 데모 모드에서도 대화가 그대로 쌓여야 한다.
    const app = createApp({
      apiKey: '',
      workspaceStoreFile: path.join(directory, 'state.json'),
      documentUploadDirectory: path.join(directory, 'documents'),
      ...options,
    })
    await withServer(app, (origin) => run(origin, app))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const create = (origin, headers, body = {}) => fetch(`${origin}/api/ai/conversations`, { method: 'POST', headers, body: JSON.stringify(body) })
const list = (origin, headers, query = '') => fetch(`${origin}/api/ai/conversations${query}`, { headers })
const ask = (origin, headers, conversationId, prompt) => fetch(`${origin}/api/chat`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ conversationId, messages: [{ role: 'user', content: prompt }], context: {} }),
})

test('대화를 만들고 물어보면 서버에 그대로 남는다', async () => {
  await withApp(async (origin) => {
    const park = await signIn(origin, PARK)
    const created = await create(origin, park.headers).then((response) => response.json())
    assert.equal(created.conversation.title, '새 대화')
    assert.equal(created.conversation.messages.length, 0)

    const answered = await ask(origin, park.headers, created.conversation.id, '금속검출기 감도 기준을 알려 주세요').then((response) => response.json())
    assert.equal(answered.conversationSaved, true)
    // 첫 질문이 제목이 된다.
    assert.equal(answered.conversationTitle, '금속검출기 감도 기준을 알려 주세요')

    const stored = await fetch(`${origin}/api/ai/conversations/${created.conversation.id}`, { headers: park.headers }).then((response) => response.json())
    assert.equal(stored.conversation.messages.length, 2, '질문과 답이 한 쌍으로 남는다')
    assert.equal(stored.conversation.messages[0].role, 'user')
    assert.equal(stored.conversation.messages[1].role, 'assistant')
  })
})

test('남의 대화는 있는지조차 알 수 없다', async () => {
  await withApp(async (origin) => {
    const park = await signIn(origin, PARK)
    const oh = await signIn(origin, OH)
    const created = await create(origin, park.headers).then((response) => response.json())
    await ask(origin, park.headers, created.conversation.id, '내 대화입니다')

    const seen = await fetch(`${origin}/api/ai/conversations/${created.conversation.id}`, { headers: oh.headers })
    assert.equal(seen.status, 404, '같은 회사 사람이라도 남의 AI 대화는 열 수 없다')

    const mine = await list(origin, oh.headers).then((response) => response.json())
    assert.equal(mine.conversations.length, 0)

    // 남의 대화 id로 질문을 보내도 그 대화에 쌓이지 않는다.
    const hijack = await ask(origin, oh.headers, created.conversation.id, '끼어들기').then((response) => response.json())
    assert.equal(hijack.conversationSaved, undefined)
    const untouched = await fetch(`${origin}/api/ai/conversations/${created.conversation.id}`, { headers: park.headers }).then((response) => response.json())
    assert.equal(untouched.conversation.messages.length, 2)
  })
})

test('제목을 손으로 고치면 자동 제목이 덮어쓰지 않는다', async () => {
  await withApp(async (origin) => {
    const park = await signIn(origin, PARK)
    const created = await create(origin, park.headers).then((response) => response.json())
    await fetch(`${origin}/api/ai/conversations/${created.conversation.id}`, {
      method: 'PATCH', headers: park.headers, body: JSON.stringify({ title: '금속검출기 정리' }),
    })
    await ask(origin, park.headers, created.conversation.id, '전혀 다른 질문입니다')

    const stored = await fetch(`${origin}/api/ai/conversations/${created.conversation.id}`, { headers: park.headers }).then((response) => response.json())
    assert.equal(stored.conversation.title, '금속검출기 정리')
    assert.equal(stored.conversation.titleSource, 'manual')
  })
})

test('고정한 대화가 목록 위로 온다', async () => {
  await withApp(async (origin) => {
    const park = await signIn(origin, PARK)
    const first = await create(origin, park.headers).then((response) => response.json())
    await ask(origin, park.headers, first.conversation.id, '먼저 물어본 것')
    const second = await create(origin, park.headers).then((response) => response.json())
    await ask(origin, park.headers, second.conversation.id, '나중에 물어본 것')

    await fetch(`${origin}/api/ai/conversations/${first.conversation.id}`, {
      method: 'PATCH', headers: park.headers, body: JSON.stringify({ pinned: true }),
    })
    const listed = await list(origin, park.headers).then((response) => response.json())
    assert.equal(listed.conversations[0].id, first.conversation.id)
    assert.equal(listed.conversations[0].pinned, true)
  })
})

test('검색은 본문까지 뒤지고 걸린 자리를 보여 준다', async () => {
  await withApp(async (origin) => {
    const park = await signIn(origin, PARK)
    const target = await create(origin, park.headers).then((response) => response.json())
    await ask(origin, park.headers, target.conversation.id, '냉장창고 온도 기록 주기가 어떻게 되나요')
    const other = await create(origin, park.headers).then((response) => response.json())
    await ask(origin, park.headers, other.conversation.id, '출하 검사 항목을 알려 주세요')

    const found = await list(origin, park.headers, '?q=냉장창고').then((response) => response.json())
    assert.equal(found.conversations.length, 1)
    assert.equal(found.conversations[0].id, target.conversation.id)
    assert.match(found.conversations[0].excerpt, /냉장창고/)
  })
})

test('지운 대화는 휴지통에서 30일을 기다린다', async () => {
  await withApp(async (origin) => {
    const park = await signIn(origin, PARK)
    const created = await create(origin, park.headers).then((response) => response.json())
    await ask(origin, park.headers, created.conversation.id, '지울 대화')

    const deleted = await fetch(`${origin}/api/ai/conversations/${created.conversation.id}`, { method: 'DELETE', headers: park.headers })
      .then((response) => response.json())
    assert.equal(deleted.retentionDays, 30)

    const active = await list(origin, park.headers).then((response) => response.json())
    assert.equal(active.conversations.length, 0)
    assert.equal(active.trashCount, 1)

    const trash = await list(origin, park.headers, '?trash=1').then((response) => response.json())
    assert.equal(trash.conversations.length, 1)
    assert.equal(trash.conversations[0].daysLeft, 30)

    await fetch(`${origin}/api/ai/conversations/${created.conversation.id}/restore`, { method: 'POST', headers: park.headers })
    const back = await list(origin, park.headers).then((response) => response.json())
    assert.equal(back.conversations.length, 1, '되살리면 목록으로 돌아온다')
  })
})

test('휴지통 비우기는 만료된 것만 없앤다', async () => {
  // 30일을 실제로 기다릴 수는 없으니 대화 쪽 시계만 앞으로 돌린다.
  let now = new Date('2026-09-05T00:00:00.000Z')
  await withApp(async (origin, app) => {
    const park = await signIn(origin, PARK)
    const old = await create(origin, park.headers).then((response) => response.json())
    const recent = await create(origin, park.headers).then((response) => response.json())
    await ask(origin, park.headers, old.conversation.id, '오래 전에 지운 대화')
    await ask(origin, park.headers, recent.conversation.id, '방금 지운 대화')

    await fetch(`${origin}/api/ai/conversations/${old.conversation.id}`, { method: 'DELETE', headers: park.headers })
    now = new Date('2026-10-07T00:00:00.000Z') // 32일 뒤
    await fetch(`${origin}/api/ai/conversations/${recent.conversation.id}`, { method: 'DELETE', headers: park.headers })

    const swept = await app.locals.sweepConversationTrash(now)
    assert.equal(swept.removed, 1)
    const trash = await list(origin, park.headers, '?trash=1').then((response) => response.json())
    assert.deepEqual(trash.conversations.map((item) => item.id), [recent.conversation.id])
    assert.equal(trash.conversations[0].daysLeft, 30, '방금 지운 것은 30일이 그대로 남아 있다')
  }, { aiConversationClock: () => now })
})

test('결론을 업무·결정·자료로 올린다', async () => {
  await withApp(async (origin) => {
    const park = await signIn(origin, PARK)
    const created = await create(origin, park.headers).then((response) => response.json())
    await ask(origin, park.headers, created.conversation.id, '원료 입고 검사 절차를 정리해 주세요')
    const stored = await fetch(`${origin}/api/ai/conversations/${created.conversation.id}`, { headers: park.headers }).then((response) => response.json())
    const answer = stored.conversation.messages.find((item) => item.role === 'assistant')

    const promote = (kind, title) => fetch(`${origin}/api/ai/conversations/${created.conversation.id}/promote`, {
      method: 'POST', headers: park.headers, body: JSON.stringify({ kind, messageId: answer.id, title }),
    })

    const task = await promote('task', '원료 입고 검사 절차 정리').then((response) => response.json())
    assert.equal(task.created.kind, 'work-item')
    const tasks = await fetch(`${origin}/api/workspace/work-items`, { headers: park.headers }).then((response) => response.json())
    const madeTask = tasks.data.find((item) => item.id === task.created.id)
    assert.equal(madeTask.origin.kind, 'ai-conversation', '어디서 왔는지 업무에 남는다')

    const decision = await promote('decision', '입고 검사 기준 확정').then((response) => response.json())
    assert.equal(decision.created.kind, 'decision')

    const document = await promote('document', '원료 입고 검사 절차').then((response) => response.json())
    assert.equal(document.created.kind, 'document')
    const documents = await fetch(`${origin}/api/documents`, { headers: park.headers }).then((response) => response.json())
    assert.ok(documents.documents.some((item) => item.id === document.created.id && item.tags.includes('ai-conversation')))

    const after = await fetch(`${origin}/api/ai/conversations/${created.conversation.id}`, { headers: park.headers }).then((response) => response.json())
    assert.equal(after.conversation.promoted.length, 3, '무엇을 올렸는지 대화에 남는다')
  })
})

test('같은 답을 두 번 결정으로 올리지 않는다', async () => {
  await withApp(async (origin) => {
    const park = await signIn(origin, PARK)
    const created = await create(origin, park.headers).then((response) => response.json())
    await ask(origin, park.headers, created.conversation.id, '두 번 올려 볼 질문')
    const stored = await fetch(`${origin}/api/ai/conversations/${created.conversation.id}`, { headers: park.headers }).then((response) => response.json())
    const answer = stored.conversation.messages.find((item) => item.role === 'assistant')
    const body = JSON.stringify({ kind: 'decision', messageId: answer.id })

    const first = await fetch(`${origin}/api/ai/conversations/${created.conversation.id}/promote`, { method: 'POST', headers: park.headers, body })
    assert.equal(first.status, 201)
    const second = await fetch(`${origin}/api/ai/conversations/${created.conversation.id}/promote`, { method: 'POST', headers: park.headers, body })
    assert.equal(second.status, 500)
    assert.match((await second.json()).error.message, /이미 결정으로 올린/)
  })
})

test('대화를 지정하지 않으면 예전처럼 그냥 답한다', async () => {
  await withApp(async (origin) => {
    const park = await signIn(origin, PARK)
    const answered = await fetch(`${origin}/api/chat`, {
      method: 'POST', headers: park.headers,
      body: JSON.stringify({ messages: [{ role: 'user', content: '대화 없이 물어보기' }], context: {} }),
    })
    assert.equal(answered.status, 200)
    const body = await answered.json()
    assert.ok(body.text)
    assert.equal(body.conversationSaved, undefined)
  })
})

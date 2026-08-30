import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createApp } from './app.mjs'
import { BUILT_IN_LENSES, lensAppliesTo, normalizeLensList, normalizeLensResult, resolveLenses } from './document-lenses.mjs'
import { withServer } from './test-server.mjs'

async function login(origin, email) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: 'tenant', email, password: 'demo1234' }),
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  return { cookie: response.headers.get('set-cookie').split(';')[0], account: body.account, identity: `${body.account.tenantId}:${body.account.id}` }
}

async function upload(origin, auth, { name, mime, bytes }) {
  const response = await fetch(`${origin}/api/documents?name=${encodeURIComponent(name)}&visibility=all`, {
    method: 'POST',
    headers: { cookie: auth.cookie, 'x-workspace-identity': auth.identity, 'content-type': 'application/octet-stream', 'x-file-type': mime, 'x-file-name': encodeURIComponent(name) },
    body: bytes,
  })
  assert.equal(response.status, 201)
  return (await response.json()).document
}

function billingSpy() {
  const calls = { reservations: [], events: [], releases: [] }
  return {
    calls,
    service: {
      reserveUsage: async (_actor, input) => { calls.reservations.push(input); return { reservation: { ...input, status: 'pending' } } },
      recordUsageEvent: async (_actor, input) => { calls.events.push(input); return { event: input } },
      recordReconciliationPending: async (_actor, input) => ({ reconciliation: input }),
      releaseUsageReservation: async (_actor, input) => { calls.releases.push(input) },
    },
  }
}

test('a tenant that never configured lenses still gets the three built-in ones', () => {
  const lenses = resolveLenses(undefined)
  assert.deepEqual(lenses.map((lens) => lens.name), ['핵심만', '리스크 점검', '업무 추출'])
  assert.deepEqual(lenses.map((lens) => lens.outputFormat), ['summary', 'table', 'tasks'])
  assert.ok(lenses.every((lens) => lens.builtIn && lens.prompt))
  // 기본 렌즈를 지워도 되살아난다 (버튼이 통째로 사라지지 않게).
  const custom = resolveLenses([{ id: 'LENS-CUSTOM-1', name: '납품 조건', prompt: '납품 조건만 뽑는다', outputFormat: 'table' }])
  assert.equal(custom.length, BUILT_IN_LENSES.length + 1)
  assert.ok(custom.some((lens) => lens.id === 'LENS-CUSTOM-1' && lens.builtIn === false))
})

test('lens definitions are validated before they are stored', () => {
  assert.throws(() => normalizeLensList([{ id: 'LENS-AAAA', name: '', prompt: 'x' }]), /이름과 지시문/)
  assert.throws(() => normalizeLensList([{ id: 'bad-id', name: 'A', prompt: 'x' }]), /이름과 지시문/)
  assert.throws(() => normalizeLensList([{ id: 'LENS-AAAA', name: 'A', prompt: 'x' }, { id: 'LENS-AAAA', name: 'B', prompt: 'y' }]), /중복/)
  const saved = normalizeLensList([{ id: 'LENS-BUILTIN-CORE', name: '핵심만', prompt: '요약', outputFormat: 'summary', fileKinds: ['document', '몰라'] }])
  assert.equal(saved[0].builtIn, true, '기본 렌즈는 문구를 고쳐도 기본 표시를 유지한다')
  assert.deepEqual(saved[0].fileKinds, ['document'])
})

test('a lens only offers itself for the file kinds it declares', () => {
  const contractLens = { fileKinds: ['document'] }
  assert.equal(lensAppliesTo(contractLens, 'application/pdf'), true)
  assert.equal(lensAppliesTo(contractLens, 'image/png'), false)
  assert.equal(lensAppliesTo({ fileKinds: ['all'] }, 'image/png'), true)
  assert.equal(lensAppliesTo({}, 'text/plain'), true)
})

test('lens output is normalized and evidence survives, empty answers become insufficient', () => {
  const summary = normalizeLensResult(JSON.stringify({
    headline: '<b>연간 유지보수 계약</b>', bullets: ['1년 계약', '자동 갱신 조항 있음', ''], decisions: ['갱신 여부 통보'],
    evidence: [{ quote: '제3조 계약기간', where: '2쪽' }, { quote: '', where: '3쪽' }], insufficient: false,
  }), 'summary')
  assert.equal(summary.headline, '연간 유지보수 계약')
  assert.deepEqual(summary.bullets, ['1년 계약', '자동 갱신 조항 있음'])
  assert.equal(summary.evidence.length, 1)
  assert.equal(summary.insufficient, false)

  const tasks = normalizeLensResult(JSON.stringify({
    tasks: [{ title: '갱신 통보 발송', owner: '김담당', due: '2026-02-30', reason: '제3조' }, { title: '', owner: '', due: '', reason: '' }],
    evidence: [{ quote: '제3조', where: '2쪽' }], insufficient: false,
  }), 'tasks')
  assert.equal(tasks.tasks.length, 1)
  assert.equal(tasks.tasks[0].due, '', '달력에 없는 날짜는 버린다')

  const empty = normalizeLensResult(JSON.stringify({ rows: [], evidence: [], insufficient: false }), 'table')
  assert.equal(empty.insufficient, true, '내용이 없으면 근거 부족으로 표시한다')
  assert.throws(() => normalizeLensResult('not-json', 'summary'), /확인할 수 없습니다/)
})

test('lens run reads one tenant file, records usage and never writes the record itself', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inthefield-lens-'))
  const billing = billingSpy()
  const captured = []
  const client = { messages: {
    countTokens: async () => ({ input_tokens: 12 }),
    create: async (input) => {
      captured.push(input)
      return {
        id: `lens-${captured.length}`, model: 'claude-test', usage: { input_tokens: 12, output_tokens: 30 },
        content: [{ type: 'text', text: JSON.stringify({
          tasks: [{ title: '갱신 통보 발송', owner: '김서원', due: '2026-10-01', reason: '제3조 자동 갱신' }],
          evidence: [{ quote: '제3조 (계약기간) 자동 갱신', where: '2쪽' }],
          insufficient: false,
        }) }],
      }
    },
  } }
  try {
    await withServer(createApp({ apiKey: 'test-key', model: 'claude-test', client, billingService: billing.service, workspaceStoreFile: path.join(directory, 'state.json') }), async (origin) => {
      const admin = await login(origin, 'admin@sunsea.co.kr')
      const headers = { cookie: admin.cookie, 'x-workspace-identity': admin.identity, 'content-type': 'application/json' }
      const document = await upload(origin, admin, { name: '유지보수계약.pdf', mime: 'application/pdf', bytes: Buffer.from('%PDF contract') })

      const listed = await (await fetch(`${origin}/api/lenses`, { headers })).json()
      assert.equal(listed.lenses.length, 3)
      assert.equal(listed.canManage, true)

      const before = await (await fetch(`${origin}/api/proposals`, { headers })).json()
      const run = await fetch(`${origin}/api/documents/${document.id}/lens`, { method: 'POST', headers, body: JSON.stringify({ lensId: 'LENS-BUILTIN-TASKS' }) })
      assert.equal(run.status, 200)
      const body = await run.json()
      assert.equal(body.source.documentId, document.id)
      assert.equal(body.result.outputFormat, 'tasks')
      assert.equal(body.result.tasks.length, 1)
      assert.equal(body.result.evidence[0].where, '2쪽')
      assert.deepEqual(billing.calls.reservations.map((entry) => entry.feature), ['document-lens'])
      assert.deepEqual(billing.calls.events.map((entry) => entry.feature), ['document-lens'])
      assert.equal(captured[0].messages.at(-1).content.some((block) => block.type === 'document'), true)
      // 렌즈 실행만으로는 승인 큐가 늘지 않는다.
      const afterRun = await (await fetch(`${origin}/api/proposals`, { headers })).json()
      assert.equal(afterRun.pendingCount, before.pendingCount)

      const queued = await fetch(`${origin}/api/documents/${document.id}/lens/tasks`, {
        method: 'POST', headers,
        body: JSON.stringify({ lensId: 'LENS-BUILTIN-TASKS', lensName: '업무 추출', tasks: body.result.tasks }),
      })
      assert.equal(queued.status, 201)
      assert.equal((await queued.json()).queued, 1)
      const afterQueue = await (await fetch(`${origin}/api/proposals`, { headers })).json()
      const proposal = afterQueue.proposals.find((item) => item.kind === 'lens-task')
      assert.ok(proposal, '렌즈 업무는 기존 승인 큐에 제안으로 올라간다')
      assert.equal(proposal.status, 'pending')
      assert.match(proposal.evidence, /유지보수계약\.pdf/)
      // 같은 파일·같은 업무를 다시 보내도 중복되지 않는다.
      const again = await fetch(`${origin}/api/documents/${document.id}/lens/tasks`, {
        method: 'POST', headers,
        body: JSON.stringify({ lensId: 'LENS-BUILTIN-TASKS', lensName: '업무 추출', tasks: body.result.tasks }),
      })
      assert.equal((await again.json()).queued, 0)

      // 승인하면 업무가 만들어진다 (기존 결재 흐름 그대로).
      const decided = await fetch(`${origin}/api/proposals/${proposal.id}/decide`, { method: 'POST', headers, body: JSON.stringify({ decision: 'approve' }) })
      assert.equal(decided.status, 200)
      assert.equal((await decided.json()).resultRef.type, 'work-item')
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('lens routes fail closed for other tenants, unsupported files and unknown lenses', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inthefield-lens-auth-'))
  let providerCalls = 0
  const billing = billingSpy()
  const client = { messages: { countTokens: async () => ({ input_tokens: 1 }), create: async () => { providerCalls += 1; throw new Error('must not run') } } }
  try {
    await withServer(createApp({ apiKey: 'test-key', client, billingService: billing.service, workspaceStoreFile: path.join(directory, 'state.json') }), async (origin) => {
      const admin = await login(origin, 'admin@sunsea.co.kr')
      const member = await login(origin, 'taesik.oh@sunsea.co.kr')
      const other = await login(origin, 'admin@pohangcoop.co.kr')
      const headers = { cookie: admin.cookie, 'x-workspace-identity': admin.identity, 'content-type': 'application/json' }
      const document = await upload(origin, admin, { name: '계약.pdf', mime: 'application/pdf', bytes: Buffer.from('%PDF') })
      const zip = await upload(origin, admin, { name: '묶음.zip', mime: 'application/zip', bytes: Buffer.from('PK') })

      const run = (auth, id, lensId) => fetch(`${origin}/api/documents/${id}/lens`, {
        method: 'POST',
        headers: { ...(auth ? { cookie: auth.cookie, 'x-workspace-identity': auth.identity } : {}), 'content-type': 'application/json' },
        body: JSON.stringify({ lensId }),
      })
      assert.equal((await run(null, document.id, 'LENS-BUILTIN-CORE')).status, 401)
      assert.equal((await run(other, document.id, 'LENS-BUILTIN-CORE')).status, 404)
      assert.equal((await run(admin, zip.id, 'LENS-BUILTIN-CORE')).status, 415)
      assert.equal((await run(admin, document.id, 'LENS-NOPE')).status, 404)
      assert.equal(providerCalls, 0)
      assert.equal(billing.calls.reservations.length, 0)

      // 렌즈 정의는 관리자만 바꾼다. 일반 직원은 읽기만 된다.
      assert.equal((await fetch(`${origin}/api/lenses`, { headers: { cookie: member.cookie, 'x-workspace-identity': member.identity } })).status, 200)
      const memberWrite = await fetch(`${origin}/api/lenses`, {
        method: 'PUT', headers: { cookie: member.cookie, 'x-workspace-identity': member.identity, 'content-type': 'application/json' },
        body: JSON.stringify({ lenses: [] }),
      })
      assert.equal(memberWrite.status, 403)

      const saved = await fetch(`${origin}/api/lenses`, {
        method: 'PUT', headers,
        body: JSON.stringify({ lenses: [{ id: 'LENS-CUSTOM-DELIVERY', name: '납품 조건', prompt: '납품 기한과 위약 조항만 뽑는다', outputFormat: 'table', fileKinds: ['document'] }] }),
      })
      assert.equal(saved.status, 200)
      const listed = await (await fetch(`${origin}/api/lenses`, { headers })).json()
      assert.ok(listed.lenses.some((lens) => lens.id === 'LENS-CUSTOM-DELIVERY'))
      assert.equal(listed.lenses.length, 4, '기본 렌즈 3종은 사용자 정의와 함께 유지된다')
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

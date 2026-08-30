import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createApp } from './app.mjs'
import {
  assemblePersonalContext,
  personalCoreOf,
  principleCandidates,
  principleStatus,
  rejectionUntil,
  upsertGap,
} from './personal-core.mjs'
import { withServer } from './test-server.mjs'

const NOW = new Date('2026-08-31T00:00:00.000Z')

async function login(origin, email) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: 'tenant', email, password: 'demo1234' }),
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  return { cookie: response.headers.get('set-cookie').split(';')[0], account: body.account, identity: `${body.account.tenantId}:${body.account.id}` }
}

function editedDecision(id, after, decidedAt) {
  return {
    id, kind: 'document-classification', status: 'edited', summary: `‘${id}’ 문서 분류`,
    decisionDiff: { category: { before: '공통자료', after } }, decidedAt, decidedBy: 'USR-A',
  }
}

test('three same-direction edits become one principle candidate, two do not', () => {
  const two = principleCandidates([editedDecision('P1', '인사·노무', '2026-08-20T00:00:00.000Z'), editedDecision('P2', '인사·노무', '2026-08-21T00:00:00.000Z')], { now: NOW })
  assert.deepEqual(two, [])
  const three = principleCandidates([
    editedDecision('P1', '인사·노무', '2026-08-20T00:00:00.000Z'),
    editedDecision('P2', '인사·노무', '2026-08-21T00:00:00.000Z'),
    editedDecision('P3', '인사·노무', '2026-08-22T00:00:00.000Z'),
  ], { now: NOW })
  assert.equal(three.length, 1)
  assert.match(three[0].statement, /문서 분류에서 ‘category’은\(는\) 항상 ‘인사·노무’\(으\)로 한다\./)
  assert.equal(three[0].evidence.length, 3)
  assert.ok(three[0].confidence >= 0.6)
})

test('a rejected candidate stays blocked for 60 days and an active principle is not re-proposed', () => {
  const decisions = [
    editedDecision('P1', '인사·노무', '2026-08-20T00:00:00.000Z'),
    editedDecision('P2', '인사·노무', '2026-08-21T00:00:00.000Z'),
    editedDecision('P3', '인사·노무', '2026-08-22T00:00:00.000Z'),
  ]
  const key = 'document-classification:category:인사·노무'
  const blocked = principleCandidates(decisions, { now: NOW, rejections: [{ key, until: rejectionUntil(NOW) }] })
  assert.deepEqual(blocked, [])
  const afterCooldown = principleCandidates(decisions, { now: new Date('2026-11-01T00:00:00.000Z'), rejections: [{ key, until: rejectionUntil(NOW) }] })
  assert.equal(afterCooldown.length, 1)
  const already = principleCandidates(decisions, { now: NOW, existing: [{ statement: '문서 분류에서 ‘category’은(는) 항상 ‘인사·노무’(으)로 한다.', status: 'active' }] })
  assert.deepEqual(already, [])
})

test('principle validity is 180 days with a 30-day review warning, and retiring keeps history', () => {
  const confirmedAt = '2026-01-01T00:00:00.000Z'
  const expiresAt = new Date(Date.parse(confirmedAt) + 180 * 24 * 60 * 60 * 1_000).toISOString()
  assert.equal(principleStatus({ expiresAt }, new Date('2026-03-01T00:00:00.000Z')), 'active')
  assert.equal(principleStatus({ expiresAt }, new Date('2026-06-15T00:00:00.000Z')), 'review-due')
  assert.equal(principleStatus({ expiresAt }, new Date('2026-08-01T00:00:00.000Z')), 'expired')
  assert.equal(principleStatus({ expiresAt, status: 'retired' }, new Date('2026-03-01T00:00:00.000Z')), 'retired')
})

test('context assembler injects in priority order and drops the lowest layer over budget', () => {
  const principles = [{ id: 'PRN-1', statement: '항상 인사·노무로 분류한다', expiresAt: '2099-01-01T00:00:00.000Z' }]
  const decisions = [{ id: 'P1', summary: '문서 분류 제안', status: 'edited' }, { id: 'P2', summary: '두 번째', status: 'approved' }, { id: 'P3', summary: '세 번째', status: 'rejected' }, { id: 'P4', summary: '네 번째', status: 'approved' }]
  const notes = [{ id: 'NOTE-1', body: '급식 견적은 마감 3일 전 회신' }]
  const full = assemblePersonalContext({ principles, decisions, notes, screen: '화면 데이터', tokenBudget: 1_200 })
  assert.deepEqual(full.injected.map((layer) => layer.id), ['principles', 'decisions', 'notes', 'screen'])
  assert.equal(full.injected[1].count, 3, '최근 결정은 3건까지만 넣는다')
  assert.deepEqual(full.dropped, [])

  const tight = assemblePersonalContext({ principles, decisions, notes, screen: 'x'.repeat(3_000), tokenBudget: 60 })
  assert.ok(tight.injected.some((layer) => layer.id === 'principles'), '규범은 가장 먼저 남는다')
  assert.ok(tight.dropped.includes('screen'), '상한을 넘으면 낮은 층부터 뺀다')
})

test('the same unanswered question is counted, not duplicated', () => {
  const gap = { id: 'GAP-1', question: '이 분류는 무엇으로 봐야 하나요?', status: 'open', seenCount: 1 }
  const once = upsertGap([], gap)
  const twice = upsertGap(once, { ...gap, id: 'GAP-2' })
  assert.equal(twice.length, 1)
  assert.equal(twice[0].seenCount, 2)
})

test('personal core is owned by the account and invisible to everyone else', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inthefield-personal-'))
  try {
    await withServer(createApp({ apiKey: '', workspaceStoreFile: path.join(directory, 'state.json') }), async (origin) => {
      const admin = await login(origin, 'admin@sunsea.co.kr')
      const other = await login(origin, 'admin@pohangcoop.co.kr')
      const member = await login(origin, 'taesik.oh@sunsea.co.kr')
      const headers = { cookie: admin.cookie, 'x-workspace-identity': admin.identity, 'content-type': 'application/json' }

      // 일반 직원은 개인 코어 자체를 쓸 수 없다.
      assert.equal((await fetch(`${origin}/api/personal/core`, { headers: { cookie: member.cookie } })).status, 403)

      const created = await fetch(`${origin}/api/personal/notes`, { method: 'POST', headers, body: JSON.stringify({ body: '급식 견적은 마감 3일 전까지 회신한다' }) })
      assert.equal(created.status, 201)

      const mine = await (await fetch(`${origin}/api/personal/core`, { headers })).json()
      assert.equal(mine.notes.length, 1)
      assert.equal(mine.settings.confidenceThreshold, 0.6)

      // 다른 계정에서는 존재 자체가 보이지 않는다 (API 직접 호출 포함).
      const theirs = await (await fetch(`${origin}/api/personal/core`, { headers: { cookie: other.cookie, 'x-workspace-identity': other.identity } })).json()
      assert.deepEqual(theirs.notes, [])
      assert.deepEqual(theirs.principles, [])

      // 남의 메모 id를 알아도 지울 수 없다.
      const forged = await fetch(`${origin}/api/personal/notes/${mine.notes[0].id}`, { method: 'DELETE', headers: { cookie: other.cookie, 'x-workspace-identity': other.identity } })
      assert.equal(forged.status, 404)
      const stillThere = await (await fetch(`${origin}/api/personal/core`, { headers })).json()
      assert.equal(stillThere.notes.length, 1)

      const threshold = await fetch(`${origin}/api/personal/settings`, { method: 'PUT', headers, body: JSON.stringify({ settings: { confidenceThreshold: 0.8 } }) })
      assert.equal((await threshold.json()).settings.confidenceThreshold, 0.8)
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('editing three proposals the same way queues a principle, approving it confirms the card', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inthefield-principle-'))
  try {
    await withServer(createApp({ apiKey: '', workspaceStoreFile: path.join(directory, 'state.json') }), async (origin) => {
      const admin = await login(origin, 'admin@sunsea.co.kr')
      const headers = { cookie: admin.cookie, 'x-workspace-identity': admin.identity, 'content-type': 'application/json' }

      // 문서 3건을 올려 분류 제안을 만든 뒤, 모두 같은 방향으로 고친다.
      for (const name of ['9월 급여대장.txt', '10월 급여대장.txt', '11월 급여대장.txt']) {
        const upload = await fetch(`${origin}/api/documents?name=${encodeURIComponent(name)}&visibility=all`, {
          method: 'POST',
          headers: { cookie: admin.cookie, 'x-workspace-identity': admin.identity, 'content-type': 'application/octet-stream', 'x-file-type': 'text/plain', 'x-file-name': encodeURIComponent(name) },
          body: Buffer.from('급여 지급 내역'),
        })
        assert.equal(upload.status, 201)
      }
      const queue = await (await fetch(`${origin}/api/proposals`, { headers })).json()
      const classifications = queue.proposals.filter((item) => item.kind === 'document-classification' && item.status === 'pending')
      assert.ok(classifications.length >= 3, '문서 분류 제안 3건이 필요하다')

      let principleQueued = 0
      for (const proposal of classifications.slice(0, 3)) {
        const decided = await fetch(`${origin}/api/proposals/${proposal.id}/decide`, {
          method: 'POST', headers,
          body: JSON.stringify({ decision: 'edit', payload: { category: '경영지원 문서' }, reason: '급여 자료는 항상 경영지원 문서로 본다' }),
        })
        assert.equal(decided.status, 200)
        principleQueued += (await decided.json()).principleQueued ?? 0
      }
      assert.equal(principleQueued, 1, '세 번째 수정에서 규범 후보가 한 번만 올라온다')

      const core = await (await fetch(`${origin}/api/personal/core`, { headers })).json()
      assert.equal(core.corrections.length, 3, '"왜 고치셨나요?"가 교정 로그로 남는다')
      assert.match(core.corrections[0].reason, /경영지원 문서/)

      const withPrinciple = await (await fetch(`${origin}/api/proposals`, { headers })).json()
      const candidate = withPrinciple.proposals.find((item) => item.kind === 'principle' && item.status === 'pending')
      assert.ok(candidate, '규범 후보가 승인 큐에 올라간다')
      assert.match(candidate.evidence, /같은 방향으로 3번 고치셨습니다/)

      const confirmed = await fetch(`${origin}/api/proposals/${candidate.id}/decide`, { method: 'POST', headers, body: JSON.stringify({ decision: 'approve' }) })
      assert.equal(confirmed.status, 200)
      assert.equal((await confirmed.json()).resultRef.type, 'principle')

      const afterApproval = await (await fetch(`${origin}/api/personal/core`, { headers })).json()
      assert.equal(afterApproval.principles.length, 1)
      assert.equal(afterApproval.principles[0].state, 'active')
      assert.equal(afterApproval.principles[0].evidence.length, 3)

      // 폐기해도 이력은 남는다.
      const retired = await fetch(`${origin}/api/personal/principles/${afterApproval.principles[0].id}`, { method: 'PATCH', headers, body: JSON.stringify({ action: 'retire' }) })
      assert.equal(retired.status, 200)
      const afterRetire = await (await fetch(`${origin}/api/personal/core`, { headers })).json()
      assert.equal(afterRetire.principles.length, 1)
      assert.equal(afterRetire.principles[0].state, 'retired')
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('the personal layer never leaks tenant data — it only holds judgement records', () => {
  const store = { personal: {} }
  const core = personalCoreOf(store, 'USR-A')
  assert.deepEqual(Object.keys(core).sort(), ['corrections', 'gaps', 'notes', 'principles', 'settings'])
  const other = personalCoreOf(store, 'USR-B')
  assert.notEqual(core, other)
  core.notes.push({ id: 'NOTE-1', body: '내 메모' })
  assert.deepEqual(other.notes, [], '한 계정의 기록이 다른 계정에 새지 않는다')
})

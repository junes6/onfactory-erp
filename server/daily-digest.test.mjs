import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createApp } from './app.mjs'
import { buildDigest, editionFor, findDigest, upsertDigest } from './daily-digest.mjs'
import { withServer } from './test-server.mjs'

const MORNING = new Date('2026-08-31T00:30:00.000Z') // KST 09:30
const EVENING = new Date('2026-08-31T09:30:00.000Z') // KST 18:30

function storeWithWork() {
  return {
    'work-items': { data: [
      { id: 'WK-1', title: '급식 납품 견적 회신', owner: '오태식', status: '수행중', due: '2026-08-31T09:00:00.000Z' },
      { id: 'WK-2', title: '지난주 위생 점검 보고', owner: '박지현', status: '결재완료', completion: { submittedAt: '2026-08-30T02:00:00.000Z' }, review: { reviewedAt: '2026-08-30T05:00:00.000Z' } },
      { id: 'WK-3', title: '창고 재고 실사', owner: '오태식', status: '업무요청', due: '2026-09-01T09:00:00.000Z' },
      { id: 'WK-4', title: '기한 지난 라벨 검토', owner: '박지현', status: '수행중', due: '2026-08-20T09:00:00.000Z' },
    ] },
    'ai-proposals': { data: [
      { id: 'PRP-1', kind: 'sentinel-task', status: 'pending', summary: '자가품질검사 기한이 12일 남았습니다', createdAt: '2026-08-29T01:00:00.000Z' },
      { id: 'PRP-2', kind: 'document-classification', status: 'pending', summary: '‘9월 급여대장’ 문서를 [인사·노무]로 분류', createdAt: '2026-08-30T01:00:00.000Z' },
      { id: 'PRP-3', kind: 'lens-task', status: 'approved', summary: '이미 결정된 건', createdAt: '2026-08-28T01:00:00.000Z' },
    ] },
    opportunities: { data: [
      { id: 'OPP-1', title: '군부대 급식 수산물 납품', status: 'queued', score: 0.91, deadline: '2026-11-10', receivedAt: '2026-08-31T00:10:00.000Z' },
      { id: 'OPP-2', title: '보류된 건', status: 'below-threshold', score: 0.2, receivedAt: '2026-08-31T00:10:00.000Z' },
    ] },
  }
}

async function login(origin, email) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: 'tenant', email, password: 'demo1234' }),
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  return { cookie: response.headers.get('set-cookie').split(';')[0], account: body.account, identity: `${body.account.tenantId}:${body.account.id}` }
}

test('the edition follows Seoul time — evening starts at 17:00', () => {
  assert.equal(editionFor(MORNING), 'morning')
  assert.equal(editionFor(EVENING), 'evening')
  assert.equal(editionFor(new Date('2026-08-31T07:59:00.000Z')), 'morning') // KST 16:59
  assert.equal(editionFor(new Date('2026-08-31T08:00:00.000Z')), 'evening') // KST 17:00
})

test('the morning briefing shows what to look at first, each line with a link', () => {
  const digest = buildDigest(storeWithWork(), { now: MORNING, generatedBy: '김서원' })
  assert.equal(digest.edition, 'morning')
  assert.equal(digest.date, '2026-08-31')
  const byId = Object.fromEntries(digest.lines.map((line) => [line.id, line]))
  assert.match(byId.approval.text, /승인 대기 2건/)
  assert.equal(byId.approval.ref.page, 'approvals')
  assert.match(byId['due-today'].text, /오늘 마감 업무 1건 — 급식 납품 견적 회신/)
  assert.equal(byId['due-today'].ref.id, 'WK-1')
  assert.match(byId.sentinel.text, /생존 센티널 경고 1건/)
  assert.match(byId.yesterday.text, /어제 완료 1건 — 지난주 위생 점검 보고/)
  assert.match(byId.opportunity.text, /오늘의 기회 1건 — 군부대 급식 수산물 납품/)
  assert.ok(digest.lines.every((line) => line.ref), '모든 줄에 근거 링크가 붙는다')
})

test('the evening briefing shows what happened and tomorrow first action', () => {
  const digest = buildDigest(storeWithWork(), { now: EVENING })
  assert.equal(digest.edition, 'evening')
  const ids = digest.lines.map((line) => line.id)
  assert.deepEqual(ids, ['carry-over', 'pending-review', 'tomorrow-first'])
  const byId = Object.fromEntries(digest.lines.map((line) => [line.id, line]))
  assert.match(byId['carry-over'].text, /남은 업무 2건/)
  assert.match(byId['tomorrow-first'].text, /내일 마감 1건 — 먼저 창고 재고 실사/)
  assert.equal(byId['tomorrow-first'].ref.id, 'WK-3')
})

test('a tenant with no data gets no lines instead of empty placeholders', () => {
  const morning = buildDigest({}, { now: MORNING })
  assert.deepEqual(morning.lines, [])
  const evening = buildDigest({}, { now: EVENING })
  assert.deepEqual(evening.lines, [])
})

test('same day and edition keeps one snapshot, regenerating replaces it', () => {
  const first = buildDigest(storeWithWork(), { now: MORNING })
  const history = upsertDigest([], first)
  const again = buildDigest(storeWithWork(), { now: new Date('2026-08-31T02:00:00.000Z') })
  const merged = upsertDigest(history, again)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].generatedAt, again.generatedAt)
  const evening = upsertDigest(merged, buildDigest(storeWithWork(), { now: EVENING }))
  assert.equal(evening.length, 2, '아침판과 저녁판은 따로 남는다')
  assert.ok(findDigest(evening, '2026-08-31', 'morning'))
  assert.ok(findDigest(evening, '2026-08-31', 'evening'))
})

test('briefing is admin only, is persisted on first read and past days come from the snapshot', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inthefield-digest-'))
  try {
    await withServer(createApp({ apiKey: '', workspaceStoreFile: path.join(directory, 'state.json') }), async (origin) => {
      const admin = await login(origin, 'admin@sunsea.co.kr')
      const member = await login(origin, 'taesik.oh@sunsea.co.kr')
      const headers = { cookie: admin.cookie, 'x-workspace-identity': admin.identity, 'content-type': 'application/json' }

      assert.equal((await fetch(`${origin}/api/digest`, { headers: { cookie: member.cookie, 'x-workspace-identity': member.identity } })).status, 403)

      const first = await fetch(`${origin}/api/digest`, { headers })
      assert.equal(first.status, 200)
      const body = await first.json()
      assert.ok(body.digest, '첫 조회에서 그날 판이 만들어진다')
      assert.equal(body.isToday, true)
      assert.equal(body.digest.date, body.date)

      // 두 번째 조회는 같은 스냅샷을 돌려준다.
      const second = await (await fetch(`${origin}/api/digest`, { headers })).json()
      assert.equal(second.digest.generatedAt, body.digest.generatedAt)

      const regenerated = await fetch(`${origin}/api/digest/regenerate`, { method: 'POST', headers, body: JSON.stringify({}) })
      assert.equal(regenerated.status, 200)
      const regeneratedBody = await regenerated.json()
      assert.notEqual(regeneratedBody.digest.generatedAt, body.digest.generatedAt)
      assert.equal(regeneratedBody.history.length, 1, '같은 날 같은 판은 하나만 남는다')

      // 저장되지 않은 지난 날짜는 만들어 내지 않는다.
      const past = await (await fetch(`${origin}/api/digest?date=2026-01-02&edition=morning`, { headers })).json()
      assert.equal(past.digest, null)
      assert.equal(past.isToday, false)

      // 브리핑은 전용 라우트로만 저장된다.
      const forged = await fetch(`${origin}/api/workspace/digests`, { method: 'PUT', headers, body: JSON.stringify({ data: [{ id: 'FORGED' }] }) })
      assert.equal(forged.status, 403)
      assert.equal((await forged.json()).error.code, 'DIGEST_ROUTE_REQUIRED')
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

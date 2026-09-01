import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createApp } from './app.mjs'
import { withServer } from './test-server.mjs'
import { editionFor, seoulDateKey } from './daily-digest.mjs'

async function login(origin, email) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'demo1234' }),
  })
  assert.equal(response.status, 200)
  const account = (await response.json()).account
  return {
    account,
    headers: {
      cookie: response.headers.get('set-cookie'),
      'x-workspace-identity': account.tenantId ? `${account.tenantId}:${account.id}` : '',
      'content-type': 'application/json',
    },
  }
}

test('the scheduler registers the standing jobs and only the operator can see them', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inthefield-sched-'))
  try {
    await withServer(createApp({ apiKey: '', workspaceStoreFile: path.join(directory, 'state.json') }), async (origin) => {
      const admin = await login(origin, 'admin@sunsea.co.kr')
      assert.equal((await fetch(`${origin}/api/platform/scheduler`, { headers: admin.headers })).status, 403, '고객사 관리자는 정기 작업을 볼 수 없다')
      assert.equal((await fetch(`${origin}/api/platform/scheduler`)).status, 401)

      const operator = await login(origin, 'operator@onfactory.co.kr')
      const listed = await fetch(`${origin}/api/platform/scheduler`, { headers: operator.headers })
      assert.equal(listed.status, 200)
      const body = await listed.json()
      const byId = new Map(body.jobs.map((job) => [job.id, job]))
      for (const jobId of ['sentinel-sweep', 'work-deadline-watch', 'digest-morning', 'digest-evening', 'backup-mirror']) {
        assert.ok(byId.has(jobId), `${jobId}가 등록돼 있어야 한다`)
      }
      assert.equal(byId.get('digest-morning').schedule, '매일 07:00')
      assert.equal(byId.get('digest-evening').schedule, '매일 18:30')
      assert.equal(byId.get('backup-mirror').schedule, '매일 03:00')
      assert.equal(byId.get('sentinel-sweep').schedule, '매시 00분')
      // 아직 안 돌았으므로 마지막 실행은 비어 있고 다음 실행 시각은 정해져 있다.
      assert.equal(byId.get('digest-morning').lastRunAt, null)
      assert.ok(Date.parse(byId.get('digest-morning').nextRunAt) > Date.now())
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a manual run produces the briefing without anyone opening the screen, and is audited', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inthefield-sched-run-'))
  try {
    await withServer(createApp({ apiKey: '', workspaceStoreFile: path.join(directory, 'state.json') }), async (origin) => {
      const operator = await login(origin, 'operator@onfactory.co.kr')
      const admin = await login(origin, 'admin@sunsea.co.kr')

      // 아직 아무도 화면을 열지 않았다.
      const before = await (await fetch(`${origin}/api/workspace/digests`, { headers: admin.headers })).json()
      assert.equal(before.error?.code, 'DIGEST_ROUTE_REQUIRED', '브리핑은 전용 라우트로만 조회한다')

      const run = await fetch(`${origin}/api/platform/scheduler/digest-morning/run`, { method: 'POST', headers: operator.headers })
      assert.equal(run.status, 200)
      const result = await run.json()
      assert.equal(result.ok, true)
      assert.match(result.detail, /개 고객사 생성/)

      // 이력에 자동/수동 구분과 실행자가 남는다.
      const latest = result.runs[0]
      assert.deepEqual({ jobId: latest.jobId, trigger: latest.trigger, status: latest.status }, { jobId: 'digest-morning', trigger: 'manual', status: 'ok' })
      assert.equal(latest.actor, operator.account.name)
      assert.equal(result.jobs.find((job) => job.id === 'digest-morning').lastStatus, 'ok')

      // 관리자가 화면을 열면 계산이 아니라 미리 만들어 둔 스냅샷이 나온다.
      const digest = await (await fetch(`${origin}/api/digest?edition=morning`, { headers: admin.headers })).json()
      assert.equal(digest.digest.date, seoulDateKey(new Date()))
      assert.equal(digest.digest.generatedBy, '스케줄러', '접속 시점이 아니라 스케줄러가 만든 것이다')

      // 운영자 감사 로그에도 남는다.
      const state = await (await fetch(`${origin}/api/platform/state`, { headers: operator.headers })).json()
      assert.ok(state.auditEvents.some((event) => event.event === '정기 작업 수동 실행' && event.reference === 'digest-morning'))
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('an unknown job is a 404 and the sentinel job reports what it did', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inthefield-sched-404-'))
  try {
    await withServer(createApp({ apiKey: '', workspaceStoreFile: path.join(directory, 'state.json') }), async (origin) => {
      const operator = await login(origin, 'operator@onfactory.co.kr')
      const missing = await fetch(`${origin}/api/platform/scheduler/nope/run`, { method: 'POST', headers: operator.headers })
      assert.equal(missing.status, 404)
      assert.equal((await missing.json()).error.code, 'SCHEDULER_JOB_NOT_FOUND')

      const sentinel = await (await fetch(`${origin}/api/platform/scheduler/sentinel-sweep/run`, { method: 'POST', headers: operator.headers })).json()
      assert.equal(sentinel.ok, true)
      assert.match(sentinel.detail, /고객사 \d+곳 · 새 제안 \d+건 · 해소 \d+건/)

      const deadline = await (await fetch(`${origin}/api/platform/scheduler/work-deadline-watch/run`, { method: 'POST', headers: operator.headers })).json()
      assert.equal(deadline.ok, true)
      assert.match(deadline.detail, /마감 임박 \d+건 · 마감 초과 \d+건/)

      // 백업이 꺼져 있으면 실패가 아니라 "꺼져 있음"으로 남는다.
      const backup = await (await fetch(`${origin}/api/platform/scheduler/backup-mirror/run`, { method: 'POST', headers: operator.headers })).json()
      assert.equal(backup.ok, true)
      assert.match(backup.detail, /BACKUP_ENABLED/)
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('scheduler state survives a restart so a missed run is caught up, not repeated', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inthefield-sched-restart-'))
  const workspaceStoreFile = path.join(directory, 'state.json')
  try {
    let firstRunAt = ''
    await withServer(createApp({ apiKey: '', workspaceStoreFile }), async (origin) => {
      const operator = await login(origin, 'operator@onfactory.co.kr')
      const body = await (await fetch(`${origin}/api/platform/scheduler/digest-evening/run`, { method: 'POST', headers: operator.headers })).json()
      assert.equal(body.ok, true)
      firstRunAt = body.jobs.find((job) => job.id === 'digest-evening').lastRunAt
      assert.ok(firstRunAt)
    })

    // 같은 저장소로 다시 기동 — 마지막 실행 시각이 남아 있어야 오늘 몫을 두 번 돌지 않는다.
    await withServer(createApp({ apiKey: '', workspaceStoreFile }), async (origin) => {
      const operator = await login(origin, 'operator@onfactory.co.kr')
      const body = await (await fetch(`${origin}/api/platform/scheduler`, { headers: operator.headers })).json()
      assert.equal(body.jobs.find((job) => job.id === 'digest-evening').lastRunAt, firstRunAt, '재기동해도 실행 이력이 유지된다')
      assert.ok(body.runs.some((run) => run.jobId === 'digest-evening'))
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('the edition helper still decides morning vs evening on the Seoul clock', () => {
  assert.equal(editionFor(new Date('2026-08-31T00:00:00.000Z')), 'morning') // 09:00 KST
  assert.equal(editionFor(new Date('2026-08-31T09:00:00.000Z')), 'evening') // 18:00 KST
})

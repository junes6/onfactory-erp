import assert from 'node:assert/strict'
import test from 'node:test'

import {
  appendRun,
  createScheduler,
  describeSpec,
  jobIsDue,
  lastOccurrence,
  MAX_SCHEDULER_RUNS,
  nextOccurrence,
  seoulDateKey,
} from './scheduler.mjs'

// 2026-08-31 09:15 KST = 2026-08-31 00:15 UTC
const NOW = new Date('2026-08-31T00:15:00.000Z')

test('occurrences are computed on the Seoul calendar, not UTC', () => {
  assert.equal(seoulDateKey(NOW), '2026-08-31')

  // 매일 07:00 KST → 오늘 07:00은 이미 지났다.
  assert.equal(lastOccurrence({ every: 'day', hour: 7 }, NOW).toISOString(), '2026-08-30T22:00:00.000Z')
  assert.equal(nextOccurrence({ every: 'day', hour: 7 }, NOW).toISOString(), '2026-08-31T22:00:00.000Z')

  // 매일 18:30 KST → 아직 안 왔으므로 직전은 어제 18:30.
  assert.equal(lastOccurrence({ every: 'day', hour: 18, minute: 30 }, NOW).toISOString(), '2026-08-30T09:30:00.000Z')

  // 매시 정각 → 09:00 KST.
  assert.equal(lastOccurrence({ every: 'hour' }, NOW).toISOString(), '2026-08-31T00:00:00.000Z')

  // 매월 1일 04:00 KST → 8월 1일은 지났다.
  assert.equal(lastOccurrence({ every: 'month', day: 1, hour: 4 }, NOW).toISOString(), '2026-07-31T19:00:00.000Z')
})

test('a job whose scheduled time passed while the server was down is due on the next tick', () => {
  const spec = { every: 'day', hour: 7 }
  // 어제 07:00에 마지막으로 돌았고 지금은 오늘 09:15 → 오늘 07:00을 놓쳤으므로 due.
  assert.equal(jobIsDue({ spec }, { lastRunAt: '2026-08-29T22:00:00.000Z' }, NOW), true)
  // 오늘 07:00에 이미 돌았으면 due가 아니다.
  assert.equal(jobIsDue({ spec }, { lastRunAt: '2026-08-30T22:00:00.000Z' }, NOW), false)
  // 한 번도 돈 적 없으면 due.
  assert.equal(jobIsDue({ spec }, null, NOW), true)
  // 꺼 둔 작업은 절대 돌지 않는다.
  assert.equal(jobIsDue({ spec, disabled: true }, null, NOW), false)
})

test('a failed job stays due but backs off instead of hot-looping', async () => {
  let state = {}, runs = []
  let attempts = 0
  const clock = { value: new Date('2026-08-31T00:15:00.000Z') }
  const scheduler = createScheduler({
    clock: () => clock.value,
    readState: () => state, writeState: (next) => { state = next },
    readRuns: () => runs, writeRuns: (next) => { runs = next },
    logger: { warn() {} },
    retryMs: 10 * 60_000,
  })
  scheduler.register({
    id: 'flaky', label: '흔들리는 작업', spec: { every: 'hour' },
    run: () => { attempts += 1; if (attempts < 3) throw new Error('상류 장애'); return { detail: `성공 (${attempts}회차)` } },
  })

  await scheduler.tick(clock.value)
  assert.equal(attempts, 1)
  assert.equal(state.flaky.lastStatus, 'failed')
  assert.equal(state.flaky.lastRunAt, null, '실패는 성공 시각을 밀지 않는다')
  assert.equal(state.flaky.consecutiveFailures, 1)

  // 재시도 대기 중에는 다시 돌지 않는다.
  clock.value = new Date('2026-08-31T00:16:00.000Z')
  await scheduler.tick(clock.value)
  assert.equal(attempts, 1, '백오프 동안에는 재시도하지 않는다')

  // 대기가 끝나면 다시 시도한다.
  clock.value = new Date('2026-08-31T00:30:00.000Z')
  await scheduler.tick(clock.value)
  assert.equal(attempts, 2)
  assert.equal(state.flaky.consecutiveFailures, 2)

  clock.value = new Date('2026-08-31T00:45:00.000Z')
  await scheduler.tick(clock.value)
  assert.equal(attempts, 3)
  assert.equal(state.flaky.lastStatus, 'ok')
  assert.equal(state.flaky.consecutiveFailures, 0)
  assert.equal(state.flaky.lastRunAt, '2026-08-31T00:45:00.000Z')
  assert.match(state.flaky.lastDetail, /성공 \(3회차\)/)

  // 이력은 시도마다 한 줄씩, 최신이 위로.
  assert.deepEqual(runs.map((run) => run.status), ['ok', 'failed', 'failed'])
  assert.equal(runs[0].jobId, 'flaky')
  assert.equal(runs[0].trigger, 'schedule')
})

test('one job failing does not stop the others in the same tick', async () => {
  let state = {}, runs = []
  const done = []
  const scheduler = createScheduler({
    clock: () => NOW,
    readState: () => state, writeState: (next) => { state = next },
    readRuns: () => runs, writeRuns: (next) => { runs = next },
    logger: { warn() {} },
  })
  scheduler.register({ id: 'a', spec: { every: 'hour' }, run: () => { done.push('a'); throw new Error('실패') } })
  scheduler.register({ id: 'b', spec: { every: 'hour' }, run: () => { done.push('b'); return '완료' } })
  scheduler.register({ id: 'c', spec: { every: 'hour' }, run: () => { done.push('c'); return '완료' } })

  const results = await scheduler.tick(NOW)
  assert.deepEqual(done, ['a', 'b', 'c'])
  assert.deepEqual(results.map((result) => result.ok), [false, true, true])
})

test('a job already running is not started a second time', async () => {
  let state = {}, runs = []
  let started = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const scheduler = createScheduler({
    clock: () => NOW,
    readState: () => state, writeState: (next) => { state = next },
    readRuns: () => runs, writeRuns: (next) => { runs = next },
  })
  scheduler.register({ id: 'slow', spec: { every: 'hour' }, run: async () => { started += 1; await gate; return '완료' } })

  const first = scheduler.runJob('slow', { trigger: 'manual' })
  const second = await scheduler.runJob('slow', { trigger: 'manual' })
  assert.deepEqual({ ok: second.ok, skipped: second.skipped }, { ok: false, skipped: true })
  release()
  await first
  assert.equal(started, 1)
})

test('manual runs are recorded with who asked for them', async () => {
  let state = {}, runs = []
  const scheduler = createScheduler({
    clock: () => NOW,
    readState: () => state, writeState: (next) => { state = next },
    readRuns: () => runs, writeRuns: (next) => { runs = next },
  })
  scheduler.register({ id: 'digest', label: '아침 브리핑', spec: { every: 'day', hour: 7 }, run: () => ({ detail: '3개 고객사' }) })
  const result = await scheduler.runJob('digest', { trigger: 'manual', actor: '김서원' })
  assert.equal(result.ok, true)
  assert.deepEqual(
    { trigger: runs[0].trigger, actor: runs[0].actor, label: runs[0].label, detail: runs[0].detail },
    { trigger: 'manual', actor: '김서원', label: '아침 브리핑', detail: '3개 고객사' },
  )
  assert.equal(scheduler.runJob('없는작업', {}) instanceof Promise, true)
})

test('the console listing shows schedule, last result and next run', () => {
  let state = { hourly: { lastRunAt: '2026-08-31T00:00:00.000Z', lastStatus: 'ok', lastDurationMs: 12, lastDetail: '3곳', consecutiveFailures: 0 } }
  const scheduler = createScheduler({ clock: () => NOW, readState: () => state, writeState: () => {}, readRuns: () => [], writeRuns: () => {} })
  scheduler.register({ id: 'hourly', label: '센티널 평가', description: '전 규칙', spec: { every: 'hour' }, run: () => '' })
  scheduler.register({ id: 'monthly', label: '월간 정산', spec: { every: 'month', day: 1, hour: 4 }, run: () => '' })
  const [hourly, monthly] = scheduler.listJobs(NOW)
  assert.deepEqual(
    { id: hourly.id, schedule: hourly.schedule, lastStatus: hourly.lastStatus, nextRunAt: hourly.nextRunAt },
    { id: 'hourly', schedule: '매시 00분', lastStatus: 'ok', nextRunAt: '2026-08-31T01:00:00.000Z' },
  )
  assert.deepEqual(
    { schedule: monthly.schedule, lastStatus: monthly.lastStatus, nextRunAt: monthly.nextRunAt },
    { schedule: '매월 1일 04:00', lastStatus: null, nextRunAt: '2026-08-31T19:00:00.000Z' },
  )
  assert.equal(describeSpec({ every: 'day', hour: 18, minute: 30 }), '매일 18:30')
})

test('run history is capped so it cannot grow without bound', () => {
  let history = []
  for (let index = 0; index < MAX_SCHEDULER_RUNS + 25; index += 1) history = appendRun(history, { id: `SRUN-${index}` })
  assert.equal(history.length, MAX_SCHEDULER_RUNS)
  assert.equal(history[0].id, `SRUN-${MAX_SCHEDULER_RUNS + 24}`, '최신이 위로 온다')
})

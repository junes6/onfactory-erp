/**
 * 내장 스케줄러 — 사용자 접속과 무관하게 도는 정기 작업.
 *
 * 지금까지 센티널·백업·청구는 index.mjs에 흩어진 setTimeout/setInterval이었다.
 * 그 방식은 (1) 서버가 꺼져 있던 동안 지나간 실행을 따라잡지 못하고,
 * (2) 언제 무엇이 돌았는지 남지 않으며, (3) 손으로 다시 돌릴 방법이 없었다.
 *
 * 여기서는 "마지막 성공 시각"과 "직전 예정 시각"을 비교해 밀린 작업을 스스로 따라잡고,
 * 매 실행을 이력으로 남기며, 운영자가 콘솔에서 즉시 실행할 수 있게 한다.
 */

export const SCHEDULER_STATE_KEY = 'scheduler-state'
export const SCHEDULER_RUNS_KEY = 'scheduler-runs'
export const MAX_SCHEDULER_RUNS = 300
export const DEFAULT_TICK_MS = 60_000
/** 실패한 작업을 곧바로 다시 돌리면 상류 장애 때 폭주한다. 다음 주기에 재시도한다. */
export const DEFAULT_RETRY_MS = 10 * 60_000

const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1_000
const MINUTE_MS = 60_000

/** 서울 기준 달력 값. 저장·비교는 전부 UTC epoch로 하고, 사람이 정한 시각만 서울로 읽는다. */
function seoulParts(date) {
  const shifted = new Date(date.getTime() + SEOUL_OFFSET_MS)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  }
}

/** 서울 기준 달력 값 → UTC epoch(ms) */
function seoulEpoch({ year, month, day, hour = 0, minute = 0 }) {
  return Date.UTC(year, month, day, hour, minute) - SEOUL_OFFSET_MS
}

export function seoulDateKey(date) {
  const { year, month, day } = seoulParts(date)
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * now 시점에서 "이미 지나간 가장 최근 예정 시각".
 * 이 값이 마지막 성공 시각보다 뒤면 아직 안 돈 것이므로 지금 돌려야 한다.
 */
export function lastOccurrence(spec, now) {
  const parts = seoulParts(now)
  const minute = Number.isInteger(spec?.minute) ? spec.minute : 0
  if (spec?.every === 'hour') {
    let candidate = seoulEpoch({ ...parts, minute })
    if (candidate > now.getTime()) candidate -= 60 * MINUTE_MS
    return new Date(candidate)
  }
  if (spec?.every === 'day') {
    const hour = Number.isInteger(spec.hour) ? spec.hour : 0
    let candidate = seoulEpoch({ ...parts, hour, minute })
    if (candidate > now.getTime()) candidate = seoulEpoch({ ...parts, day: parts.day - 1, hour, minute })
    return new Date(candidate)
  }
  if (spec?.every === 'month') {
    const hour = Number.isInteger(spec.hour) ? spec.hour : 0
    const day = Number.isInteger(spec.day) ? spec.day : 1
    let candidate = seoulEpoch({ ...parts, day, hour, minute })
    if (candidate > now.getTime()) candidate = seoulEpoch({ ...parts, month: parts.month - 1, day, hour, minute })
    return new Date(candidate)
  }
  throw new Error(`알 수 없는 실행 주기입니다: ${JSON.stringify(spec)}`)
}

/** 다음 예정 시각. 콘솔에 "다음 실행"을 보여 주기 위한 값이다. */
export function nextOccurrence(spec, now) {
  const previous = lastOccurrence(spec, now)
  const parts = seoulParts(previous)
  if (spec.every === 'hour') return new Date(previous.getTime() + 60 * MINUTE_MS)
  if (spec.every === 'day') return new Date(seoulEpoch({ ...parts, day: parts.day + 1 }))
  return new Date(seoulEpoch({ ...parts, month: parts.month + 1 }))
}

export function describeSpec(spec) {
  const minute = String(Number.isInteger(spec?.minute) ? spec.minute : 0).padStart(2, '0')
  if (spec?.every === 'hour') return `매시 ${minute}분`
  if (spec?.every === 'day') return `매일 ${String(spec.hour ?? 0).padStart(2, '0')}:${minute}`
  if (spec?.every === 'month') return `매월 ${spec.day ?? 1}일 ${String(spec.hour ?? 0).padStart(2, '0')}:${minute}`
  return '주기 미정'
}

/**
 * 실행해야 하는가. 마지막 **성공** 시각만 예정 시각을 넘긴 것으로 친다.
 * 실패한 작업은 lastRunAt이 그대로 남아 계속 due 상태이므로 다음 주기에 다시 시도된다.
 */
export function jobIsDue(job, entry, now) {
  if (job.disabled) return false
  const nextAttemptAt = Date.parse(entry?.nextAttemptAt ?? '')
  if (Number.isFinite(nextAttemptAt) && nextAttemptAt > now.getTime()) return false
  const lastRunAt = Date.parse(entry?.lastRunAt ?? '')
  if (!Number.isFinite(lastRunAt)) return true
  return lastRunAt < lastOccurrence(job.spec, now).getTime()
}

export function appendRun(history, entry) {
  return [entry, ...(Array.isArray(history) ? history : [])].slice(0, MAX_SCHEDULER_RUNS)
}

/**
 * 스케줄러 본체.
 * readState/writeState는 저장소를 아는 쪽(app.mjs)이 주입한다. 이 모듈은 저장소를 모른다.
 */
export function createScheduler({
  clock = () => new Date(),
  readState,
  writeState,
  readRuns,
  writeRuns,
  commit = async () => {},
  logger = console,
  tickMs = DEFAULT_TICK_MS,
  retryMs = DEFAULT_RETRY_MS,
} = {}) {
  const jobs = new Map()
  /** 같은 작업이 겹쳐 도는 것을 막는 잠금. 한 프로세스 안에서만 유효하다. */
  const running = new Set()
  let timer = null
  let ticking = false

  const register = (job) => {
    if (!job?.id || typeof job.run !== 'function') throw new Error('스케줄 작업에는 id와 run이 필요합니다.')
    jobs.set(job.id, { minutesBudget: 10, ...job })
    return job.id
  }

  const stateOf = (jobId) => (readState?.() ?? {})[jobId] ?? null

  const persist = async (jobId, entry, run) => {
    const state = { ...(readState?.() ?? {}) }
    state[jobId] = entry
    writeState?.(state)
    if (run) writeRuns?.(appendRun(readRuns?.() ?? [], run))
    try { await commit() }
    catch (error) { logger.warn?.('[scheduler] 실행 이력을 저장하지 못했습니다.', { message: error?.message }) }
  }

  /**
   * 한 작업 실행. 예외는 삼키고 이력에 남긴다 — 한 작업의 실패가 다른 작업을 멈추지 않는다.
   * trigger: 'schedule' | 'manual'
   */
  const runJob = async (jobId, { trigger = 'schedule', actor = '스케줄러' } = {}) => {
    const job = jobs.get(jobId)
    if (!job) return { ok: false, skipped: true, reason: '등록되지 않은 작업입니다.' }
    if (running.has(jobId)) return { ok: false, skipped: true, reason: '이미 실행 중입니다.' }
    running.add(jobId)
    const startedAt = clock()
    const previous = stateOf(jobId)
    try {
      const summary = await job.run({ now: startedAt, trigger })
      const finishedAt = clock()
      const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime())
      const detail = typeof summary === 'string' ? summary : summary?.detail ?? ''
      const entry = {
        lastRunAt: startedAt.toISOString(),
        lastStatus: 'ok',
        lastDurationMs: durationMs,
        lastDetail: String(detail).slice(0, 400),
        consecutiveFailures: 0,
        nextAttemptAt: null,
      }
      await persist(jobId, entry, {
        id: `SRUN-${startedAt.getTime()}-${jobId}`,
        jobId, label: job.label ?? jobId, trigger, actor,
        at: startedAt.toISOString(), status: 'ok', durationMs,
        detail: entry.lastDetail,
      })
      return { ok: true, durationMs, detail: entry.lastDetail, summary }
    } catch (error) {
      const finishedAt = clock()
      const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime())
      const message = String(error?.message ?? error).slice(0, 400)
      const failures = Number(previous?.consecutiveFailures ?? 0) + 1
      const entry = {
        // 성공 시각은 밀지 않는다. 그래야 다음 주기에 다시 시도된다.
        lastRunAt: previous?.lastRunAt ?? null,
        lastStatus: 'failed',
        lastDurationMs: durationMs,
        lastDetail: message,
        lastFailedAt: startedAt.toISOString(),
        consecutiveFailures: failures,
        nextAttemptAt: new Date(finishedAt.getTime() + retryMs).toISOString(),
      }
      await persist(jobId, entry, {
        id: `SRUN-${startedAt.getTime()}-${jobId}`,
        jobId, label: job.label ?? jobId, trigger, actor,
        at: startedAt.toISOString(), status: 'failed', durationMs,
        detail: message,
      })
      logger.warn?.(`[scheduler] ${jobId} 실패`, { message })
      return { ok: false, error: message, durationMs }
    } finally {
      running.delete(jobId)
    }
  }

  const tick = async (now = clock()) => {
    if (ticking) return []
    ticking = true
    const results = []
    try {
      for (const job of jobs.values()) {
        if (!jobIsDue(job, stateOf(job.id), now)) continue
        results.push({ jobId: job.id, ...(await runJob(job.id, { trigger: 'schedule' })) })
      }
    } finally {
      ticking = false
    }
    return results
  }

  const listJobs = (now = clock()) => [...jobs.values()].map((job) => {
    const entry = stateOf(job.id)
    return {
      id: job.id,
      label: job.label ?? job.id,
      description: job.description ?? '',
      schedule: describeSpec(job.spec),
      disabled: Boolean(job.disabled),
      lastRunAt: entry?.lastRunAt ?? null,
      lastStatus: entry?.lastStatus ?? null,
      lastDurationMs: entry?.lastDurationMs ?? null,
      lastDetail: entry?.lastDetail ?? '',
      consecutiveFailures: Number(entry?.consecutiveFailures ?? 0),
      nextRunAt: job.disabled ? null : nextOccurrence(job.spec, now).toISOString(),
      running: running.has(job.id),
    }
  })

  return {
    register,
    runJob,
    tick,
    listJobs,
    has: (jobId) => jobs.has(jobId),
    start() {
      if (timer) return
      // 부팅 직후 한 번 돌려 서버가 꺼져 있던 동안 밀린 작업을 따라잡는다.
      const boot = setTimeout(() => { void tick() }, 5_000)
      boot.unref?.()
      timer = setInterval(() => { void tick() }, tickMs)
      timer.unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}

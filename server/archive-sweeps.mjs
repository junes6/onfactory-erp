import { isDeepStrictEqual } from 'node:util'

/**
 * 넘친 기록을 지우지 않고 보관함으로 옮기는 정리기(업무 외 모음).
 *
 * 전에는 배열 상한에서 `.slice(0, N)`으로 **가장 오래된 기록을 말없이 지웠다**(2026-09-18 감사):
 *   - 운영사 접속·감사 기록 5,000건(전 고객사가 한 배열을 나눠 쓴다) — 고객사에 "모든 기록"이라고 약속한 것
 *   - 결정된 AI 제안 2,000건 — 북극성(대표의 결정 데이터)의 원료
 *   - 휴가 신청 1,000건 · 휴가 원장 5,000건 · 프로젝트 글 5,000건(회사 전체 합) · 외부 기회 500건 · 운영 조치 5,000건
 * 이제 쓰는 자리는 자르지 않고, 이 정리기가 매일(그리고 크게 넘쳤을 때 곧바로) 오래된 쪽을 보관함에 먼저 쓴 뒤
 * 뜨거운 배열에서 뺀다. 커밋이 실패하면 배열을 되돌리고 보관분은 가린다 — 두 곳에도, 아무 곳에도 없는 상태를 만들지 않는다.
 */

/** 배열마다 뜨겁게 남기는 수. 이것을 넘은 오래된 쪽이 보관된다(쓰는 자리의 옛 상한보다 넉넉히 아래). */
export const HOT_LIMITS = Object.freeze({
  audit: 4_000,
  actions: 4_000,
  proposals: 1_500,
  posts: 4_000,
  leaveRequests: 800,
  leaveLedger: 4_000,
  opportunities: 400,
})
/**
 * 이만큼 넘치면 매일 정리를 기다리지 않고 곧바로 한 번 돈다.
 * 휴가 원장은 저장 검증이 5,000건에서 막으므로 그보다 먼저(4,500) 돈다.
 */
export const OVERFLOW_TRIGGERS = Object.freeze({ audit: 5_000, actions: 5_000, proposals: 2_000, posts: 5_000, leaveRequests: 1_000, leaveLedger: 4_500, opportunities: 500 })
/** 결정된 AI 제안은 이 날수가 지나면 보관한다(승률 통계 창 4주보다 넉넉히). */
export const PROPOSAL_ARCHIVE_AFTER_DAYS = 90
/** 휴가 신청은 끝난 지 1년이 지나면 보관한다(올해·지난해 잔여 계산에 쓰이는 것은 남긴다). */
export const LEAVE_ARCHIVE_AFTER_DAYS = 365
/** 외부 기회는 마감이 30일 지나면 보관한다(워커는 마감 지난 공고를 다시 보내지 않는다). */
export const OPPORTUNITY_ARCHIVE_AFTER_DAYS = 30

const DAY = 24 * 60 * 60 * 1_000
const timeOf = (value) => { const at = Date.parse(String(value ?? '')); return Number.isFinite(at) ? at : null }

/** 새것이 앞인 배열에서, 남길 수(keep)를 넘은 오래된 꼬리. */
export function overflowTail(rows, keep) {
  const list = Array.isArray(rows) ? rows : []
  return list.length > keep ? list.slice(keep) : []
}

/** 결정된 제안 중 보관할 것: 기준일이 지났거나, 뜨거운 수를 넘은 오래된 쪽. 대기 중인 제안은 절대 옮기지 않는다. */
export function proposalsToArchive(proposals, { now = new Date(), keep = HOT_LIMITS.proposals, afterDays = PROPOSAL_ARCHIVE_AFTER_DAYS } = {}) {
  const list = Array.isArray(proposals) ? proposals : []
  const cutoff = now.getTime() - afterDays * DAY
  const decided = list.filter((row) => row?.status && row.status !== 'pending')
  const old = new Set(decided.filter((row) => (timeOf(row.decidedAt ?? row.createdAt) ?? Infinity) <= cutoff).map((row) => row.id))
  // 넘친 수만큼, 결정된 것 중 오래된 쪽(배열 뒤)부터 더한다.
  let excess = list.length - keep
  for (let index = list.length - 1; index >= 0 && excess > 0; index -= 1) {
    const row = list[index]
    if (!row?.status || row.status === 'pending' || old.has(row.id)) continue
    old.add(row.id)
    excess -= 1
  }
  return list.filter((row) => old.has(row?.id))
}

/** 끝난 휴가 신청 중 기준일이 지났거나 뜨거운 수를 넘은 쪽. 결재대기는 옮기지 않는다. */
export function leaveRequestsToArchive(requests, { now = new Date(), keep = HOT_LIMITS.leaveRequests, afterDays = LEAVE_ARCHIVE_AFTER_DAYS } = {}) {
  const list = Array.isArray(requests) ? requests : []
  const cutoff = now.getTime() - afterDays * DAY
  const finished = (row) => row?.status && row.status !== '결재대기'
  const endOf = (row) => timeOf(row?.endDate ? `${row.endDate}T23:59:59+09:00` : row?.createdAt)
  const picked = new Set(list.filter((row) => finished(row) && (endOf(row) ?? Infinity) <= cutoff).map((row) => row.id))
  let excess = list.length - picked.size - keep
  for (let index = list.length - 1; index >= 0 && excess > 0; index -= 1) {
    const row = list[index]
    if (!finished(row) || picked.has(row.id)) continue
    picked.add(row.id)
    excess -= 1
  }
  return list.filter((row) => picked.has(row?.id))
}

/** 마감이 기준일 넘게 지난 기회, 그리고 뜨거운 수를 넘은 오래된 쪽. */
export function opportunitiesToArchive(rows, { now = new Date(), keep = HOT_LIMITS.opportunities, afterDays = OPPORTUNITY_ARCHIVE_AFTER_DAYS } = {}) {
  const list = Array.isArray(rows) ? rows : []
  const cutoff = now.getTime() - afterDays * DAY
  const stale = new Set(list.filter((row) => {
    const deadline = timeOf(row?.deadline ? `${row.deadline}T23:59:59+09:00` : '')
    return deadline !== null && deadline <= cutoff
  }).map((row) => row.id))
  let excess = list.length - stale.size - keep
  for (let index = list.length - 1; index >= 0 && excess > 0; index -= 1) {
    if (stale.has(list[index]?.id)) continue
    stale.add(list[index]?.id)
    excess -= 1
  }
  return list.filter((row) => stale.has(row?.id))
}

const groupBy = (rows, keyOf) => {
  const groups = new Map()
  for (const row of rows) {
    const key = keyOf(row)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  return groups
}

/** 플랫폼 수준 기록(테넌트 없는 감사·운영 조치)이 가는 보관 칸의 이름. */
export const PLATFORM_ARCHIVE_TENANT = '_platform'

/**
 * 정리기 한 벌. `run()`은 모든 모음을 한 번 훑고, `schedule()`은 크게 넘쳤을 때 쓰는 자리에서 부른다
 * (곧바로 돌지 않고 다음 틱에 한 번만 — 쓰기 경로를 느리게 하지 않는다).
 */
export function createOverflowSweeper({ workspaceStore, archive, commitWorkspaceStore, clock = () => new Date(), logger = console, publish = () => undefined }) {
  let running = null
  let scheduled = false
  let lastScheduledRunAt = 0

  const run = async (now = clock()) => {
    if (running) return running
    running = (async () => {
      const summary = { audit: 0, actions: 0, proposals: 0, posts: 0, leaveRequests: 0, leaveLedger: 0, opportunities: 0 }
      // 커밋이 실패하면: 뜨거운 자리가 아직 우리가 쓴 그대로면 되돌리고 보관분을 가린다.
      // 그 사이 누가 우리 결과 위에 또 썼다면 되돌리지 않는다(그 쓰기를 잃는다) — 행은 보관함에 있으므로 어디에도 없는 상태는 아니다.
      const rollbacks = []
      const touched = new Set()

      /**
       * 보관함에 먼저 쓰고, **그 사이 바뀌지 않은 행만** 최신 배열에서 뺀다(업무 보관과 같은 규칙).
       * 빼지 못한 행은 보관함에서 가린다 — 두 곳에 보이지 않게.
       */
      const settle = async (tenantId, collection, chosen, readLatest, reason) => {
        if (!chosen.length) return null
        await archive.append(tenantId, collection, chosen, { reason, actor: 'system:archive' })
        const byId = new Map(chosen.map((row) => [String(row.id), row]))
        const latest = readLatest()
        const moved = new Set(latest.filter((row) => byId.has(String(row?.id)) && isDeepStrictEqual(row, byId.get(String(row.id)))).map((row) => String(row.id)))
        const stale = [...byId.keys()].filter((id) => !moved.has(id))
        return { moved, stale }
      }

      // 1) 플랫폼 감사 기록 — 테넌트별 보관 칸으로 나눈다(고객사 관리자가 자기 칸만 읽는다).
      //    감사·운영 조치는 쓰고 나면 바뀌지 않는 기록이라, 앞에 새 기록이 붙어도 옮긴 것만 걸러 내면 된다.
      const platform = workspaceStore.platform ??= {}
      const platformArray = async (field, rows, tenantOf, collection, reason, counter) => {
        if (!rows.length) return
        const movedIds = new Set()
        for (const [tenantId, group] of groupBy(rows, tenantOf)) {
          const result = await settle(tenantId, collection, group, () => (Array.isArray(platform[field]) ? platform[field] : []), reason)
          if (result?.stale.length) await archive.forget(tenantId, collection, result.stale)
          for (const id of result?.moved ?? []) movedIds.add(id)
          if (result?.moved.size) rollbacks.push(async () => { await archive.forget(tenantId, collection, [...result.moved]) })
        }
        if (!movedIds.size) return
        const movedRows = rows.filter((row) => movedIds.has(String(row.id)))
        platform[field] = (platform[field] ?? []).filter((row) => !movedIds.has(String(row?.id)))
        // 되돌릴 때는 오래된 쪽(뒤)에 다시 붙인다 — 그 사이 앞에 붙은 새 기록을 잃지 않는다.
        rollbacks.push(() => { platform[field] = [...(platform[field] ?? []), ...movedRows] })
        summary[counter] = movedIds.size
      }
      await platformArray('auditEvents', overflowTail(platform.auditEvents, HOT_LIMITS.audit), (row) => row?.tenantId || PLATFORM_ARCHIVE_TENANT,
        'audit-events', `감사 기록 ${HOT_LIMITS.audit.toLocaleString('ko-KR')}건 초과분`, 'audit')
      await platformArray('actions', overflowTail(platform.actions, HOT_LIMITS.actions), () => PLATFORM_ARCHIVE_TENANT,
        'platform-actions', `운영 조치 ${HOT_LIMITS.actions.toLocaleString('ko-KR')}건 초과분`, 'actions')

      // 2) 테넌트별 모음.
      for (const [tenantId, tenantStore] of Object.entries(workspaceStore.tenants ?? {})) {
        if (!tenantStore || typeof tenantStore !== 'object') continue
        const sweepArray = async (key, collection, pick, reason, counter) => {
          const rows = Array.isArray(tenantStore[key]?.data) ? tenantStore[key].data : null
          if (!rows) return
          const result = await settle(tenantId, collection, pick(rows), () => (Array.isArray(tenantStore[key]?.data) ? tenantStore[key].data : []), reason)
          if (!result) return
          // 최신 기록을 읽고 바꾸는 사이에 await가 없다 — 다른 쓰기가 끼어들 수 없다.
          const latestRecord = tenantStore[key]
          if (result.moved.size) {
            const written = { ...latestRecord, data: latestRecord.data.filter((row) => !result.moved.has(String(row?.id))), updatedAt: now.toISOString(), updatedBy: 'system:archive' }
            tenantStore[key] = written
            touched.add(`${tenantId}\u0000${key}`)
            rollbacks.push(async () => {
              if (tenantStore[key] !== written) return
              tenantStore[key] = latestRecord
              await archive.forget(tenantId, collection, [...result.moved])
            })
            summary[counter] += result.moved.size
          }
          if (result.stale.length) await archive.forget(tenantId, collection, result.stale)
        }
        await sweepArray('ai-proposals', 'ai-proposals', (rows) => proposalsToArchive(rows, { now }), `결정 후 ${PROPOSAL_ARCHIVE_AFTER_DAYS}일 지남`, 'proposals')
        await sweepArray('project-posts', 'project-posts', (rows) => overflowTail(rows, HOT_LIMITS.posts), `프로젝트 글 ${HOT_LIMITS.posts.toLocaleString('ko-KR')}건 초과분`, 'posts')
        await sweepArray('leave-requests', 'leave-requests', (rows) => leaveRequestsToArchive(rows, { now }), '끝난 지 1년 지남', 'leaveRequests')
        await sweepArray('opportunities', 'opportunities', (rows) => opportunitiesToArchive(rows, { now }), `마감 후 ${OPPORTUNITY_ARCHIVE_AFTER_DAYS}일 지남`, 'opportunities')

        // 휴가 원장은 객체 안의 배열이다(policy·balances·ledger). 잔여는 balances가 들고 있어 원장을 옮겨도 바뀌지 않는다.
        const ledgerTail = overflowTail(tenantStore['leave-management']?.data?.ledger, HOT_LIMITS.leaveLedger).filter((row) => row?.id)
        const ledgerResult = await settle(tenantId, 'leave-ledger', ledgerTail,
          () => (Array.isArray(tenantStore['leave-management']?.data?.ledger) ? tenantStore['leave-management'].data.ledger : []),
          `휴가 원장 ${HOT_LIMITS.leaveLedger.toLocaleString('ko-KR')}건 초과분`)
        if (ledgerResult) {
          const management = tenantStore['leave-management']
          if (ledgerResult.moved.size) {
            const written = { ...management, data: { ...management.data, ledger: management.data.ledger.filter((row) => !ledgerResult.moved.has(String(row?.id))) }, updatedAt: now.toISOString(), updatedBy: 'system:archive' }
            tenantStore['leave-management'] = written
            touched.add(`${tenantId}\u0000leave-management`)
            rollbacks.push(async () => {
              if (tenantStore['leave-management'] !== written) return
              tenantStore['leave-management'] = management
              await archive.forget(tenantId, 'leave-ledger', [...ledgerResult.moved])
            })
            summary.leaveLedger = ledgerResult.moved.size
          }
          if (ledgerResult.stale.length) await archive.forget(tenantId, 'leave-ledger', ledgerResult.stale)
        }
      }

      if (!rollbacks.length) return summary
      try {
        await commitWorkspaceStore()
      } catch (error) {
        for (const undo of rollbacks.reverse()) await Promise.resolve(undo()).catch(() => undefined)
        throw error
      }
      // 열린 화면이 옮겨진 행을 들고 있지 않도록 바뀐 키를 알린다.
      for (const entry of touched) {
        const [tenantId, key] = entry.split('\u0000')
        publish(tenantId, key)
      }
      return summary
    })()
    try { return await running } finally { running = null }
  }

  /**
   * 쓰는 자리에서 부른다(가볍다 — 길이만 본다). 크게 넘쳤을 때만 다음 틱에 한 번 돈다.
   * 옮길 수 없는 것만 남아 넘친 경우(예: 대기 중 제안이 2,000건)에 쓰기마다 헛돌지 않도록 1분에 한 번으로 묶는다.
   */
  const schedule = () => {
    if (scheduled || running) return
    if (clock().getTime() - lastScheduledRunAt < 60_000) return
    const platform = workspaceStore.platform ?? {}
    const over = (platform.auditEvents?.length ?? 0) > OVERFLOW_TRIGGERS.audit
      || (platform.actions?.length ?? 0) > OVERFLOW_TRIGGERS.actions
      || Object.values(workspaceStore.tenants ?? {}).some((tenantStore) => (tenantStore?.['ai-proposals']?.data?.length ?? 0) > OVERFLOW_TRIGGERS.proposals
        || (tenantStore?.['project-posts']?.data?.length ?? 0) > OVERFLOW_TRIGGERS.posts
        || (tenantStore?.['leave-requests']?.data?.length ?? 0) > OVERFLOW_TRIGGERS.leaveRequests
        || (tenantStore?.['leave-management']?.data?.ledger?.length ?? 0) > OVERFLOW_TRIGGERS.leaveLedger
        || (tenantStore?.opportunities?.data?.length ?? 0) > OVERFLOW_TRIGGERS.opportunities)
    if (!over) return
    scheduled = true
    lastScheduledRunAt = clock().getTime()
    setImmediate(() => {
      scheduled = false
      run().catch((error) => logger.error?.('[archive-sweep] 넘친 기록을 보관하지 못했습니다', { message: error?.message }))
    })
  }

  return { run, schedule }
}

/**
 * 뜨거운 배열(새것이 앞)과 보관함을 한 목록처럼 넘겨 읽는다. 뜨거운 쪽을 먼저, 모자라면 보관함에서 잇는다.
 * 감사 기록을 읽는 화면(운영사 접속 이력·대화 열람 기록·게스트 기록)이 보관된 뒤에도 같은 약속("모든 기록")을 지키게 한다.
 * 보관함이 읽히지 않으면 뜨거운 쪽만 돌려주고 `archiveUnavailable`을 켠다 — 화면이 "더 있을 수 있음"을 말할 수 있게.
 */
export async function pageHotAndArchive({ hot, archive, tenantId, collection, filter = () => true, offset = 0, limit = 50 }) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50))
  const safeOffset = Math.max(0, Number(offset) || 0)
  const hotRows = (Array.isArray(hot) ? hot : []).filter(filter)
  const hotIds = new Set(hotRows.map((row) => String(row?.id ?? '')))
  const page = hotRows.slice(safeOffset, safeOffset + safeLimit)
  let archivedTotal = 0
  let archiveUnavailable = false
  try {
    const remaining = safeLimit - page.length
    const archived = !archive ? { rows: [], total: 0 } : await archive.list(tenantId, collection, {
      offset: Math.max(0, safeOffset - hotRows.length),
      limit: Math.max(1, remaining),
      // 커밋 실패 되돌림 사이에 두 곳에 잠깐 같이 있을 수 있다 — 뜨거운 쪽을 믿는다.
      filter: (row) => filter(row) && !hotIds.has(String(row?.id ?? '')),
    })
    archivedTotal = archived.total
    if (remaining > 0) page.push(...archived.rows.slice(0, remaining))
  } catch {
    archiveUnavailable = true
  }
  return { rows: page, total: hotRows.length + archivedTotal, archived: archivedTotal, offset: safeOffset, limit: safeLimit, archiveUnavailable }
}

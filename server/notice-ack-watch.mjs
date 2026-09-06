import {
  MAX_REMINDERS_PER_RUN,
  NOTICES_KEY,
  REMIND_AFTER_MS,
  SUMMARY_AFTER_MS,
  UNKNOWN_ACTOR_NAME,
  hasNoticeShape,
  noticeReminderDraft,
  noticeSummaryDraft,
  readNotices,
  unconfirmedTargets,
} from './notices.mjs'

/**
 * 필독 공지 확인 챙기기 — 24시간이 지나도 확인하지 않은 사람에게 한 번 더,
 * 48시간이 되면 작성자에게 미확인 명단을 보낸다.
 *
 * 멱등은 저장된 데이터로만 판정한다.
 *  - 24시간: reminders.remindedAt[accountId]가 없을 때만 보낸다(사람당 평생 한 번).
 *  - 48시간: reminders.summary48SentAt이 null일 때만 보낸다(공지당 한 번).
 * in-memory Map(app.mjs의 overdueNotified 방식)은 쓰지 않는다 — 재기동하면 모두 다시 울린다.
 *
 * 순서가 중요하다: 기록을 먼저 커밋하고 그다음에 발송한다.
 * 커밋이 실패했는데 이미 보냈다면 다음 시간에 또 보낸다(중복). 보내기 전에 커밋해 두면
 * 최악의 경우 리마인드 한 번을 잃는다 — 중복 알림보다 누락이 낫고, 48시간 요약과 '다시 알림'이 그 구멍을 덮는다.
 */
export function createNoticeAckWatch({ workspaceStore, accounts, commitWorkspaceStore, notify, clock = () => new Date() }) {
  const nameOf = (tenantId, accountId) =>
    accounts.find((item) => item?.id === accountId && item.tenantId === tenantId)?.name ?? UNKNOWN_ACTOR_NAME

  return async function runNoticeAckWatch(now = clock()) {
    const at = now instanceof Date ? now : new Date(now)
    const stamp = at.toISOString()
    let reminded = 0
    let summaries = 0

    for (const [tenantId, tenantStore] of Object.entries(workspaceStore.tenants ?? {})) {
      const { rows, dropped } = readNotices(tenantStore?.[NOTICES_KEY])
      // 깨진 행이 있는 테넌트는 통째로 건너뛴다. 성한 행만 다시 써 넣으면 깨진 행이 조용히 사라진다.
      if (dropped > 0 || rows.length === 0) continue

      const drafts = []
      let budget = MAX_REMINDERS_PER_RUN
      let changed = false
      const next = [...rows]

      const watched = rows
        .map((notice, index) => ({ notice, index }))
        .filter(({ notice }) => notice.mustRead && !notice.archivedAt)
        .sort((left, right) => String(left.notice.createdAt).localeCompare(String(right.notice.createdAt)))

      for (const { notice, index } of watched) {
        const age = at.getTime() - Date.parse(notice.createdAt)
        if (!Number.isFinite(age)) continue
        const pending = unconfirmedTargets(notice)
        let updated = notice
        // 이 공지의 초안은 따로 모은다. 기록을 남기지 못한 초안은 보내지 않기 위해서다.
        const noticeDrafts = []

        if (age >= REMIND_AFTER_MS && budget > 0) {
          const fresh = pending.filter((id) => !notice.reminders.remindedAt[id])
          const sending = fresh.slice(0, budget)
          if (sending.length) {
            budget -= sending.length
            updated = {
              ...updated,
              reminders: {
                ...updated.reminders,
                remindedAt: { ...updated.reminders.remindedAt, ...Object.fromEntries(sending.map((id) => [id, stamp])) },
              },
              updatedAt: stamp,
            }
            for (const recipientId of sending) noticeDrafts.push(noticeReminderDraft(notice, recipientId))
          }
        }

        if (age >= SUMMARY_AFTER_MS && updated.reminders.summary48SentAt === null) {
          updated = {
            ...updated,
            reminders: { ...updated.reminders, summary48SentAt: stamp },
            updatedAt: stamp,
          }
          // 다 확인했는데 "미확인 0명"을 보내면 알림이 아니라 소음이다.
          if (pending.length) noticeDrafts.push(noticeSummaryDraft(notice, pending.map((id) => nameOf(tenantId, id))))
        }

        if (updated === notice) continue
        // 저장 문을 통과하지 못하는 행은 쓰지 않고, 그 행의 초안도 버린다.
        // 보내 놓고 기록이 없으면 다음 시간에 같은 사람을 또 부른다.
        if (!hasNoticeShape(updated)) continue
        next[index] = updated
        changed = true
        drafts.push(...noticeDrafts)
      }

      if (!changed) continue
      const previous = tenantStore[NOTICES_KEY]
      tenantStore[NOTICES_KEY] = { data: next, updatedAt: stamp, updatedBy: 'system:notice-ack-watch' }
      try {
        await commitWorkspaceStore()
      } catch {
        tenantStore[NOTICES_KEY] = previous
        // 이번 테넌트는 보내지 않는다. 다음 시간에 같은 판정이 다시 선다.
        continue
      }
      // 센 것은 실제로 커밋되어 나간 것뿐이다 — 커밋 전에 세면 실패한 테넌트가 보고서에 남는다.
      notify(tenantId, drafts)
      reminded += drafts.filter((draft) => draft.type === 'notice-reminder').length
      summaries += drafts.filter((draft) => draft.type === 'notice-unconfirmed-summary').length
    }

    return { reminded, summaries }
  }
}

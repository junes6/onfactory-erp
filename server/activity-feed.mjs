/**
 * 활동 피드 — "회사에서 지금 무슨 일이 일어나고 있는가"를 시간순 한 줄씩.
 *
 * 별도의 활동 로그를 쌓지 않는다. 업무·일지·제안·기회에 이미 남아 있는 시각에서 파생한다.
 * 그래야 (1) 쓰기 경로가 늘지 않고, (2) 원본이 지워지면 줄도 함께 사라지며,
 * (3) PRODUCT.md §2의 "상태는 저장값이 아니라 파생 규칙"과 어긋나지 않는다.
 *
 * 권한은 여기서 끝난다. 일반 직원에게는 본인이 볼 수 있는 줄만 만든다.
 */

export const ACTIVITY_KINDS = Object.freeze([
  'work-created', 'work-submitted', 'work-approved', 'work-changes-requested',
  'journal-submitted', 'proposal-created', 'proposal-decided', 'sentinel-warning', 'opportunity-new',
])

const MAX_ROWS = 40
const text = (value, max = 120) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const at = (value) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null)
const rows = (tenantStore, key) => (Array.isArray(tenantStore?.[key]?.data) ? tenantStore[key].data : [])

/** 이 업무가 이 사람에게 보이는가. 관리자는 전부, 직원은 본인이 맡았거나 지시한 것만. */
const seesWorkItem = (item, auth) =>
  auth.role !== 'tenant-member' || item?.ownerId === auth.id || item?.requesterId === auth.id

const seesJournal = (journal, auth) =>
  auth.role !== 'tenant-member' || journal?.authorId === auth.id

export function buildActivityFeed(tenantStore, auth, { limit = 20, now = new Date() } = {}) {
  const isAdmin = auth?.role !== 'tenant-member'
  const entries = []
  const push = (entry) => { if (entry.at) entries.push(entry) }

  for (const item of rows(tenantStore, 'work-items')) {
    if (!item?.id || !seesWorkItem(item, auth)) continue
    const title = text(item.title, 80)
    push({
      id: `act:work-created:${item.id}`, kind: 'work-created', at: at(item.createdAt),
      title: `${title} 업무가 생성됐습니다`, detail: `${text(item.requestedBy, 30) || '지시자 미상'} → ${text(item.owner, 30) || '담당자 미정'}`,
      page: 'tasks', focusId: item.id,
    })
    push({
      id: `act:work-submitted:${item.id}`, kind: 'work-submitted', at: at(item.completion?.submittedAt),
      title: `${title} 완료 보고가 올라왔습니다`, detail: text(item.completion?.submittedByName, 30),
      page: 'tasks', focusId: item.id,
    })
    const review = item.review
    if (review?.decision === 'approved') {
      push({
        id: `act:work-approved:${item.id}`, kind: 'work-approved', at: at(review.reviewedAt),
        title: `${title} 결재가 승인됐습니다`, detail: text(review.reviewerName, 30),
        page: 'tasks', focusId: item.id,
      })
    } else if (review?.decision === 'changes-requested') {
      push({
        id: `act:work-changes:${item.id}`, kind: 'work-changes-requested', at: at(review.reviewedAt),
        title: `${title} 보완 요청이 있었습니다`, detail: text(review.requestedChanges, 60),
        page: 'tasks', focusId: item.id,
      })
    }
  }

  for (const journal of rows(tenantStore, 'daily-journals')) {
    if (!journal?.id || !seesJournal(journal, auth)) continue
    if (!['결재요청', '승인'].includes(journal.status)) continue
    push({
      id: `act:journal:${journal.id}`, kind: 'journal-submitted', at: at(journal.submittedAt ?? journal.updatedAt),
      title: `${text(journal.author, 30) || '직원'}님이 ${text(journal.date, 12)} 업무일지를 제출했습니다`,
      detail: journal.status === '승인' ? '승인 완료' : '결재 대기',
      page: 'journal', focusId: journal.id,
    })
  }

  // 승인 큐와 외부 기회는 일반 직원이 읽을 수 없는 자료다. 피드에도 넣지 않는다.
  if (isAdmin) {
    for (const proposal of rows(tenantStore, 'ai-proposals')) {
      if (!proposal?.id) continue
      const sentinel = proposal.kind === 'sentinel-task'
      // 제안 요약이 이미 "업무 생성:"으로 시작하면 접두어가 겹친다. 한 번만 붙인다.
      const summary = text(String(proposal.summary ?? '').replace(/^업무 생성:\s*/, ''), 80)
      push({
        id: `act:proposal:${proposal.id}`, kind: sentinel ? 'sentinel-warning' : 'proposal-created', at: at(proposal.createdAt),
        title: sentinel ? `센티널 경고: ${summary}` : `AI 제안: ${summary}`,
        detail: text(String(proposal.evidence ?? '').split('\n')[0], 60),
        page: 'approvals', focusId: proposal.id,
      })
      if (proposal.status && proposal.status !== 'pending') {
        const label = proposal.status === 'approved' ? '승인' : proposal.status === 'edited' ? '수정 승인' : proposal.status === 'rejected' ? '거절' : '만료'
        push({
          id: `act:proposal-decided:${proposal.id}`, kind: 'proposal-decided', at: at(proposal.decidedAt),
          title: `${text(proposal.summary, 70)} — ${label}`, detail: text(proposal.decidedByName, 30),
          page: 'approvals', focusId: proposal.id,
        })
      }
    }
    for (const opportunity of rows(tenantStore, 'opportunities')) {
      if (!opportunity?.id || opportunity.status !== 'queued') continue
      push({
        id: `act:opportunity:${opportunity.id}`, kind: 'opportunity-new', at: at(opportunity.receivedAt),
        title: `새 기회: ${text(opportunity.title, 80)}`,
        detail: [text(opportunity.source, 20), opportunity.deadline ? `마감 ${opportunity.deadline}` : ''].filter(Boolean).join(' · '),
        page: 'approvals', focusId: opportunity.id,
      })
    }
  }

  const horizon = now.getTime()
  return entries
    // 미래 시각은 데이터 오류다. 피드 맨 위를 차지하게 두지 않는다.
    .filter((entry) => Date.parse(entry.at) <= horizon)
    .sort((left, right) => String(right.at).localeCompare(String(left.at)))
    .slice(0, Math.min(Math.max(1, limit), MAX_ROWS))
}

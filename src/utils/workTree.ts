import type { WorkItem } from '../domainData'

/**
 * 하위 업무 트리 — 화면 쪽 규칙.
 *
 * 서버 `server/work-item-tree.mjs`와 같은 판단을 한다. 진행률·차단 건수는 저장하지 않고
 * 언제나 자식 status에서 파생한다 — 저장하면 두 값이 어긋나는 날이 온다.
 */

export type ParentRef = { id: string; title: string }

/** 이 행이 하위 업무인가. parentId를 직접 보는 곳이 없도록 판정은 여기 하나로 둔다. */
export const isSubtask = (item: WorkItem): item is WorkItem & { parentId: string } => Boolean(item.parentId)

export const childrenOf = (items: WorkItem[], parentId: string) => items.filter((item) => item.parentId === parentId)

/**
 * 그려지는 집합 안에서 최상위로 놓을 행인가.
 * '내가 담당' 필터로 상위가 빠져도 자식은 사라지지 않고 최상위 행이 되어 '상위:' 칩을 단다.
 */
export const isTopLevelIn = (item: WorkItem, visibleIds: Set<string>) => !isSubtask(item) || !visibleIds.has(item.parentId)

/**
 * 진행률. 자식이 없으면 null — 없는 것을 '0%'로 만들지 않는다.
 *
 * 세는 대상은 언제나 '내가 보고 있는 목록의 자식'이다. 남에게 배정돼 목록에 없는 자식은 셀 수 없고,
 * 그 경우 화면은 아무것도 주장하지 않는다 — 완료 보고가 되는지는 제출 시점에 서버가 정한다.
 */
export function subtaskProgress(items: WorkItem[], parentId: string): { total: number; done: number; percent: number } | null {
  const children = childrenOf(items, parentId)
  if (!children.length) return null
  const done = children.filter((child) => child.status === '결재완료').length
  return { total: children.length, done, percent: Math.round((done / children.length) * 100) }
}

const openSubtaskCount = (items: WorkItem[], parentId: string) => (
  childrenOf(items, parentId).filter((child) => child.status !== '결재완료').length
)

/**
 * 완료 보고가 막히는 이유 한 문장. 건수만 받는다 —
 * 화면이 미리 세어 만든 경고와 서버 409(SUBTASKS_INCOMPLETE)의 `count`로 다시 만든 토스트가
 * 같은 사실을 같은 말로 하게 하려면 문장을 만드는 곳이 하나여야 한다(R15-H).
 */
export const subtaskBlockMessage = (remaining: number) => `하위 업무 ${remaining}건이 끝나야 완료 보고를 할 수 있습니다.`

/** 막히지 않으면 빈 문자열 — 버튼 옆에 그대로 적는다. */
export const subtaskBlockReason = (items: WorkItem[], parentId: string) => {
  const remaining = openSubtaskCount(items, parentId)
  return remaining ? subtaskBlockMessage(remaining) : ''
}

/** 상위 제목을 줄 수 없을 때 쓰는 고정 문구. 게스트에게는 서버가 제목을 주지 않는다. */
export const UNKNOWN_PARENT_TITLE = '상위 업무'

/**
 * 상위 제목. 목록에 상위가 있으면 그 제목, 없으면 서버 envelope의 제목.
 * 둘 다 없으면 undefined — '모른다'를 고정 문구라는 값으로 감추면 제목이 '상위 업무'인 진짜 상위와 구별할 수 없다.
 */
export const parentTitleOf = (item: WorkItem, items: WorkItem[], refs: Record<string, ParentRef> = {}): string | undefined => (
  items.find((candidate) => candidate.id === item.parentId)?.title ?? refs[item.parentId ?? '']?.title
)

/**
 * 분모를 확신할 수 없는 표면(게스트)에서 쓰는 건수 문구.
 * 게스트에게는 서버가 자기 담당 행만 준다 — 남의 자식이 섞인 상위에서 퍼센트를 적으면
 * '진행률 100%' 옆에서 서버가 409로 거절하는 화면이 된다. 확실한 것(보이는 자식 수)만 말한다.
 */
export const subtaskCountLabel = (total: number) => `하위 ${total}건`

/** 상위 후보: 최상위·미완료(결재대기·결재완료 제외)·자기 자신 제외. 서버 CLOSED_STATUSES의 거울. */
export const parentCandidates = (items: WorkItem[], excludeId?: string) => items.filter((item) => (
  !isSubtask(item) && item.id !== excludeId && item.status !== '결재대기' && item.status !== '결재완료'
))

export const progressLabel = (progress: { total: number; percent: number }) => `하위 ${progress.total} · 진행률 ${progress.percent}%`

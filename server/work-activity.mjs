/**
 * 업무 한 건의 진행 기록과 댓글 — 모양과 덧붙이기 규칙.
 *
 * 전에는 드로어의 '진행 이력'이 완료 보고(completionHistory)와 검토(reviewHistory) 두 배열로만 그려져,
 * 착수·마감 변경·담당 변경·고치기·취소는 값을 덮어쓸 뿐 누가 언제 무엇을 바꿨는지 남지 않았다(2026-09-18 감사).
 * 이제 그런 사건은 activity[]에 **덧붙이기만** 한다(고치거나 지우지 않는다). 댓글은 comments[]에 쌓고,
 * 지울 때는 본문을 비우고 deletedAt만 남긴다 — 대화의 흐름(누가 무엇에 답했는지)이 깨지지 않게.
 *
 * 결재 상태머신(업무요청 → 수행중 → 결재대기 → 결재완료)은 건드리지 않는다. 이 기록은 상태와 나란히 가는 곁기록이다.
 */

/** 사건 기록 상한(업무 한 건). 넘으면 가장 오래된 것부터 뺀다 — 한 업무에 100번 넘게 손이 가는 일은 드물다. */
export const WORK_ACTIVITY_LIMIT = 100
/** 댓글 상한(업무 한 건). 넘치면 새 댓글을 받지 않는다(지우지 않는다). */
export const WORK_COMMENT_LIMIT = 200
export const WORK_COMMENT_MAX_LENGTH = 2_000

/** 기록하는 사건의 종류. 화면이 이 이름으로 문장을 고른다. */
export const WORK_ACTIVITY_KINDS = Object.freeze(['accept', 'edit', 'owner', 'requester', 'schedule', 'cancel', 'restore'])

const isIso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
const shortText = (value, max) => typeof value === 'string' && value.length <= max

export function hasWorkActivityShape(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
  if (!WORK_ACTIVITY_KINDS.includes(entry.kind)) return false
  if (!isIso(entry.at) || !shortText(entry.actorId, 120) || !entry.actorId || !shortText(entry.actorName, 80)) return false
  for (const key of ['field', 'from', 'to', 'note']) {
    if (entry[key] !== undefined && !shortText(entry[key], key === 'note' ? 500 : 300)) return false
  }
  const allowed = new Set(['kind', 'at', 'actorId', 'actorName', 'field', 'from', 'to', 'note'])
  return Object.keys(entry).every((key) => allowed.has(key))
}

export function hasWorkCommentShape(comment) {
  if (!comment || typeof comment !== 'object' || Array.isArray(comment)) return false
  if (!shortText(comment.id, 80) || !comment.id || !shortText(comment.authorId, 120) || !comment.authorId || !shortText(comment.authorName, 80)) return false
  if (!isIso(comment.createdAt) || typeof comment.text !== 'string' || comment.text.length > WORK_COMMENT_MAX_LENGTH) return false
  if (comment.deletedAt !== undefined && !isIso(comment.deletedAt)) return false
  if (comment.editedAt !== undefined && !isIso(comment.editedAt)) return false
  if (comment.authorRole !== undefined && !shortText(comment.authorRole, 40)) return false
  // 지우지 않은 댓글은 본문이 있어야 한다. 지운 댓글은 본문이 비어 있어야 한다(원문을 남기지 않는다).
  if (!comment.deletedAt && !comment.text.trim()) return false
  if (comment.deletedAt && comment.text !== '') return false
  const allowed = new Set(['id', 'authorId', 'authorName', 'authorRole', 'text', 'createdAt', 'editedAt', 'deletedAt'])
  return Object.keys(comment).every((key) => allowed.has(key))
}

/** 취소 표시 — 취소한 업무는 진행 중 목록이 아니라 보관함에 있다. 되살리면 이 표시를 뗀다. */
export function hasWorkCancelledShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (!isIso(value.at) || !shortText(value.by, 120) || !value.by || !shortText(value.byName, 80) || !shortText(value.reason, 500) || !value.reason.trim()) return false
  return Object.keys(value).every((key) => ['at', 'by', 'byName', 'reason'].includes(key))
}

/** 사건 하나를 덧붙인 새 업무(원본은 그대로). */
export function appendWorkActivity(item, entry) {
  const current = Array.isArray(item?.activity) ? item.activity : []
  const clean = Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined && value !== null && value !== ''))
  return { ...item, activity: [...current, clean].slice(-WORK_ACTIVITY_LIMIT) }
}

/** 여러 사건을 한 번에. 빈 목록이면 원본을 그대로 돌려준다. */
export function appendWorkActivities(item, entries) {
  return (entries ?? []).reduce((acc, entry) => appendWorkActivity(acc, entry), item)
}

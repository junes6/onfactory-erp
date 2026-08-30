import { randomBytes } from 'node:crypto'

/**
 * 대표 브리핑 — 그날 처음 들어왔을 때 "지금 무엇을 봐야 하는가"를 한 화면에 모은다.
 * 아침판은 앞으로 할 일, 저녁판은 오늘 있었던 일과 내일 첫 액션을 본다.
 * 규칙 하나: 데이터가 없는 항목은 줄을 만들지 않는다 (빈 줄로 화면을 채우지 않는다).
 */
export const DIGESTS_KEY = 'digests'
export const MAX_DIGESTS = 180
const DAY_MS = 24 * 60 * 60 * 1_000
const EVENING_HOUR = 17

export function seoulDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Date(date.getTime() + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10)
}

function seoulHour(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value)
  return new Date(date.getTime() + 9 * 60 * 60 * 1_000).getUTCHours()
}

export function editionFor(now = new Date()) {
  return seoulHour(now) >= EVENING_HOUR ? 'evening' : 'morning'
}

/** 값이 없으면 오늘로 착각하지 않도록 빈 문자열을 돌려준다 (seoulDateKey는 기본값이 오늘이다). */
const dateKeyOf = (value) => value ? seoulDateKey(value) : ''
const shiftKey = (dateKey, days) => new Date(Date.parse(`${dateKey}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
const rows = (tenantStore, key) => Array.isArray(tenantStore?.[key]?.data) ? tenantStore[key].data : []
const text = (value, max = 80) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

function line(id, kind, body, ref) {
  return { id, kind, text: body, ref: ref ?? null }
}

/**
 * 아침판: 승인 대기 상위 1건 / 오늘 마감 / 센티널 경고 / 어제 완료 / 오늘의 기회.
 */
function morningLines(tenantStore, todayKey) {
  const lines = []
  const proposals = rows(tenantStore, 'ai-proposals').filter((item) => item?.status === 'pending')
  const oldest = [...proposals].sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))[0]
  if (oldest) {
    lines.push(line('approval', '승인 대기', `승인 대기 ${proposals.length}건 — 가장 오래 기다린 건: ${text(oldest.summary, 60)}`, { type: 'page', page: 'approvals' }))
  }

  const workItems = rows(tenantStore, 'work-items')
  const dueToday = workItems.filter((item) => item?.status !== '결재완료' && dateKeyOf(item?.due) === todayKey)
  if (dueToday.length) {
    lines.push(line('due-today', '오늘 마감', `오늘 마감 업무 ${dueToday.length}건 — ${text(dueToday[0].title, 50)}${dueToday[0].owner ? ` (${text(dueToday[0].owner, 12)})` : ''}`, { type: 'work-item', id: dueToday[0].id }))
  }

  const sentinel = proposals.filter((item) => item?.kind === 'sentinel-task')
  if (sentinel.length) {
    lines.push(line('sentinel', '센티널 경고', `생존 센티널 경고 ${sentinel.length}건 — ${text(sentinel[0].summary, 55)}`, { type: 'page', page: 'approvals' }))
  }

  const yesterdayKey = shiftKey(todayKey, -1)
  const finishedYesterday = workItems.filter((item) => item?.status === '결재완료' && dateKeyOf(item?.review?.reviewedAt ?? item?.completion?.submittedAt) === yesterdayKey)
  if (finishedYesterday.length) {
    lines.push(line('yesterday', '어제 완료', `어제 완료 ${finishedYesterday.length}건 — ${text(finishedYesterday[0].title, 50)}${finishedYesterday.length > 1 ? ` 외 ${finishedYesterday.length - 1}건` : ''}`, { type: 'work-item', id: finishedYesterday[0].id }))
  }

  const opportunities = rows(tenantStore, 'opportunities').filter((item) => item?.status === 'queued')
  const todayOpportunities = opportunities.filter((item) => dateKeyOf(item?.receivedAt) === todayKey)
  const shown = todayOpportunities.length ? todayOpportunities : opportunities
  if (shown.length) {
    const top = [...shown].sort((left, right) => (right.score ?? 0) - (left.score ?? 0))[0]
    lines.push(line('opportunity', '외부 기회', `${todayOpportunities.length ? '오늘의' : '검토 대기'} 기회 ${shown.length}건 — ${text(top.title, 50)}${top.deadline ? ` (마감 ${top.deadline})` : ''}`, { type: 'page', page: 'approvals' }))
  }
  return lines
}

/**
 * 저녁판: 오늘 팀이 한 일 / 미결로 넘어가는 것 / 내일 첫 액션.
 */
function eveningLines(tenantStore, todayKey) {
  const lines = []
  const workItems = rows(tenantStore, 'work-items')

  const doneToday = workItems.filter((item) => dateKeyOf(item?.review?.reviewedAt ?? item?.completion?.submittedAt) === todayKey)
  if (doneToday.length) {
    const approved = doneToday.filter((item) => item.status === '결재완료').length
    lines.push(line('today-done', '오늘 한 일', `오늘 처리 ${doneToday.length}건 (결재완료 ${approved}건) — ${text(doneToday[0].title, 50)}`, { type: 'work-item', id: doneToday[0].id }))
  }

  const carryOver = workItems.filter((item) => item?.status !== '결재완료' && dateKeyOf(item?.due) && dateKeyOf(item.due) <= todayKey)
  if (carryOver.length) {
    lines.push(line('carry-over', '미결 이월', `기한이 지났거나 오늘까지인데 남은 업무 ${carryOver.length}건 — ${text(carryOver[0].title, 50)}`, { type: 'work-item', id: carryOver[0].id }))
  }

  const waitingReview = rows(tenantStore, 'ai-proposals').filter((item) => item?.status === 'pending')
  if (waitingReview.length) {
    lines.push(line('pending-review', '미결 이월', `내일로 넘어가는 AI 제안 ${waitingReview.length}건`, { type: 'page', page: 'approvals' }))
  }

  const tomorrowKey = shiftKey(todayKey, 1)
  const tomorrow = workItems
    .filter((item) => item?.status !== '결재완료' && dateKeyOf(item?.due) === tomorrowKey)
    .sort((left, right) => String(left.due).localeCompare(String(right.due)))
  if (tomorrow.length) {
    lines.push(line('tomorrow-first', '내일 첫 액션', `내일 마감 ${tomorrow.length}건 — 먼저 ${text(tomorrow[0].title, 50)}${tomorrow[0].owner ? ` (${text(tomorrow[0].owner, 12)})` : ''}`, { type: 'work-item', id: tomorrow[0].id }))
  }
  return lines
}

export function buildDigest(tenantStore, { now = new Date(), edition = editionFor(now), generatedBy = '' } = {}) {
  const todayKey = seoulDateKey(now)
  const lines = edition === 'evening' ? eveningLines(tenantStore, todayKey) : morningLines(tenantStore, todayKey)
  return {
    id: `DIG-${todayKey}-${edition}`,
    date: todayKey,
    edition,
    lines,
    generatedAt: now.toISOString(),
    generatedBy: text(generatedBy, 80),
  }
}

/** 같은 날·같은 판은 하나만 남긴다. 다시 생성하면 그 자리를 덮어쓴다. */
export function upsertDigest(existing, digest) {
  const rest = (Array.isArray(existing) ? existing : []).filter((item) => item?.id !== digest.id)
  return [digest, ...rest]
    .sort((left, right) => String(right.date).localeCompare(String(left.date)) || String(right.generatedAt).localeCompare(String(left.generatedAt)))
    .slice(0, MAX_DIGESTS)
}

export function findDigest(existing, date, edition) {
  return (Array.isArray(existing) ? existing : []).find((item) => item?.date === date && item?.edition === edition) ?? null
}

export function newDigestRequestId() {
  return `DIGREQ-${randomBytes(6).toString('hex')}`
}

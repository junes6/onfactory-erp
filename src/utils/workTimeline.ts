import type { WorkItem } from '../domainData'
// .ts 확장자를 붙인다 — Node가 이 파일을 직접 실행하는 테스트 경로(--experimental-strip-types)에서는 확장자 없는 값 import를 해석하지 못한다.
import { dayKeyDiff, seoulDateInputValue, seoulLocalToUtcIso, seoulTimeOf, shiftDateKey, toIsoUtc } from './dateTime.ts'
import { workStatusLabel } from './workStatus.ts'

/**
 * 업무 기간 막대의 규칙 — 서버 `server/work-item-schedule.mjs`의 거울.
 *
 * 간트가 아니다: 의존 관계·크리티컬 패스·리소스 할당을 계산하지 않는다. 막대 하나는
 * '이 업무가 언제부터 언제까지인가' 한 문장이고, 이 파일은 그 문장을 만드는 산술만 담는다.
 * 날짜 산술은 전부 utils/dateTime.ts를 통한다 — 화면에서 new Date로 날짜를 더하면
 * KST 단일 출처가 그 자리에서 깨진다(scripts/verify-architecture.mjs가 그 규칙을 지킨다).
 */

export type TimelineRangeId = 'weeks2' | 'weeks4' | 'weeks8'
export const TIMELINE_RANGES = [
  { id: 'weeks2', label: '2주', days: 14 },
  { id: 'weeks4', label: '4주', days: 28 },
  { id: 'weeks8', label: '8주', days: 56 },
] as const
/** 창 상한. 하루 = grid 1열이라 열 수가 무한이면 렌더 비용과 가로 스크롤이 함께 폭발한다. */
export const TIMELINE_MAX_DAYS = 180
/**
 * 창을 어떤 날짜에 맞출 때 그 날짜 앞에 두는 여백(일).
 *
 * 왜 상수인가: 첫 화면·'오늘' 버튼·'그 주로 이동'·편집 따라가기(followAnchor)가 모두 같은 여백을 써야 한다.
 * 첫 화면만 -3이고 '오늘'이 -2였을 때, 아무 데도 가지 않은 사람이 '오늘'을 누르면 캔버스가 이유 없이 한 칸 밀렸다.
 * 0이 아닌 이유: 막대를 창 맨 왼쪽에 붙이면 다음 ← 한 번에 다시 창 밖으로 나간다.
 */
export const TIMELINE_LEAD_DAYS = 2
export type TimelineGroupBy = 'owner' | 'project'
export type BarRange = { startKey: string; endKey: string; startUnset: boolean }
/**
 * 기간 저장의 결과. 실패했을 때의 문장은 서버가 준 그 문장 하나뿐이다.
 *
 * 왜 boolean이 아닌가: 거절 사유가 토스트에만 닿으면 캔버스 안에서 키보드로 옮기던 사람은
 * 미리보기가 이유 없이 사라지는 것만 본다. 토스트는 내용과 함께 생겨나는 live 영역이라
 * 그 순간의 낭독을 놓치기도 쉽다. 같은 문장을 타임라인의 상태 줄에도 넣되,
 * 문장은 여기서 새로 짓지 않고 서버 것을 그대로 실어 나른다.
 */
export type ScheduleResult = { ok: boolean; message?: string }

/** 기간을 바꿀 수 없는 이유. 서버 SCHEDULE_ERRORS의 문장과 글자 그대로 같아야 한다(계약 테스트가 대조한다). */
const SCHEDULE_LOCKED_REASON = '완료된 업무의 기간은 바꿀 수 없습니다.'
const SCHEDULE_FORBIDDEN_REASON = '업무 기간은 지시한 사람이나 관리자만 바꿀 수 있습니다.'
/** 클라이언트가 스스로 잘랐을 때의 안내. 서버 SCHEDULE_ORDER_INVALID의 거울이다. */
export const SCHEDULE_ORDER_HINT = '시작일은 마감일보다 뒤일 수 없습니다.'
const PROJECT_UNASSIGNED_LABEL = '프로젝트 미지정'

/**
 * 프로젝트 하나를 화면에 부르는 이름. 타임라인의 묶음 머리와 필터 바의 프로젝트 select가 함께 쓴다.
 *
 * 두 사실이 한 문자열로 겹치지 않게 하는 것이 이 함수의 전부다: '미지정'은 **projectId가 없는** 업무에만 쓰고,
 * id는 있는데 이름을 못 받았으면(비공개 프로젝트라 /api/projects에 안 나온다) id를 그대로 보인다.
 * 섞으면 서로 다른 두 프로젝트가 같은 이름의 줄 두 개가 되어 어느 쪽이 어느 쪽인지 알 수 없고,
 * 필터에서는 '미지정'이라 적힌 option이 실제로는 그 프로젝트의 업무만 걸러 라벨과 정반대로 동작한다.
 */
export function projectBarLabel(projectId: string, projectNames: Record<string, string> = {}): string {
  if (!projectId) return PROJECT_UNASSIGNED_LABEL
  return projectNames[projectId] ?? `프로젝트 ${projectId}`
}

/** 'YYYY-MM-DD' → '9.14'. 눈금·읽어 주는 문구가 같은 표기를 쓴다. */
export const barDayLabel = (dateKey: string) => `${Number(dateKey.slice(5, 7))}.${Number(dateKey.slice(8, 10))}`

/** 날짜 키는 언제나 'YYYY-MM-DD'라 변환은 실패하지 않는다. 그래도 빈 문자열을 만들지 않도록 자정으로 떨어뜨린다. */
const atSeoul = (dateKey: string, time: string) => seoulLocalToUtcIso(dateKey, time) ?? `${dateKey}T00:00:00.000Z`

/**
 * 막대의 양 끝. 마감을 못 읽으면 null — 지우지 않고 호출부가 '기간 없음' 묶음으로 보낸다.
 *
 * startAt이 없으면 createdAt에서 시작한다(없거나 마감보다 뒤면 마감 하루 전).
 * 그 값은 추론이므로 startUnset으로 표시하고, 왼쪽 손잡이를 주지 않는다 —
 * 사람이 정한 적 없는 날짜를 끌게 두면 그 순간 확정돼 버린다.
 */
export function barRange(item: WorkItem, now = new Date()): BarRange | null {
  const dueIso = toIsoUtc(item.due, now)
  if (!dueIso) return null
  const endKey = seoulDateInputValue(new Date(dueIso))
  if (item.startAt) {
    const startIso = toIsoUtc(item.startAt, now)
    if (startIso) {
      const startKey = seoulDateInputValue(new Date(startIso))
      return { startKey: startKey > endKey ? endKey : startKey, endKey, startUnset: false }
    }
  }
  const createdIso = toIsoUtc(item.createdAt, now)
  const createdKey = createdIso ? seoulDateInputValue(new Date(createdIso)) : ''
  const startKey = createdKey && createdKey <= endKey ? createdKey : shiftDateKey(endKey, -1)
  return { startKey, endKey, startUnset: true }
}

/**
 * 마감이 지났는가 — 이 화면의 모든 표면이 함께 쓰는 한 판정.
 *
 * 날짜가 아니라 순간으로 본다. 오늘 00:30 마감은 같은 날 오후에 이미 지난 것이고,
 * 요약줄('N 마감 지연')과 보드 카드의 '지연' 딱지는 처음부터 그렇게 세고 있었다.
 * 막대만 날짜 키로 보던 동안 머리말은 '1 마감 지연'인데 빨간 막대는 하나도 없는 화면이 나왔다 —
 * 같은 사실에 두 답이 있으면 사람은 둘 다 믿지 않는다.
 *
 * 완료된 업무는 마감이 지나도 지연이 아니다. 끝난 일이다.
 * now를 주입받는 이유: 시계를 읽는 테스트는 어느 밤에 저절로 실패한다.
 */
export function isWorkOverdue(item: WorkItem, now = new Date()): boolean {
  if (item.status === '결재완료') return false
  const dueMs = Date.parse(toIsoUtc(item.due, now) ?? '')
  return Number.isFinite(dueMs) && dueMs < now.getTime()
}

/** 지연=danger, 완료=무채색, 그 밖=상태 톤. 지연 여부는 isWorkOverdue 한 곳에서만 나온다. */
export function barTone(item: WorkItem, now = new Date()): 'done' | 'overdue' | 'normal' {
  if (item.status === '결재완료') return 'done'
  return isWorkOverdue(item, now) ? 'overdue' : 'normal'
}

/** 창에 그릴 날짜 키들. 상한을 넘겨 부르면 상한까지만 준다. */
export function timelineDays(anchorKey: string, count: number): string[] {
  const total = Math.max(1, Math.min(TIMELINE_MAX_DAYS, Math.floor(count)))
  return Array.from({ length: total }, (_, index) => shiftDateKey(anchorKey, index))
}

/** 창 안에서의 자리. 완전히 밖이면 null — 0칸짜리 막대를 그리지 않는다. */
export function clampBar(range: BarRange, days: string[]): { from: number; span: number; clippedStart: boolean; clippedEnd: boolean } | null {
  if (!days.length) return null
  const first = days[0]
  const last = days[days.length - 1]
  if (range.endKey < first || range.startKey > last) return null
  const from = Math.max(0, dayKeyDiff(first, range.startKey))
  const endIndex = Math.min(days.length - 1, dayKeyDiff(first, range.endKey))
  return { from, span: Math.max(1, endIndex - from + 1), clippedStart: range.startKey < first, clippedEnd: range.endKey > last }
}

/**
 * 편집 중인 막대의 자리. 창 밖으로 나가도 null을 주지 않고 창 끝 한 칸에 붙여 둔다.
 *
 * 왜: 끌고 있던 막대가 언마운트되면 그 버튼이 쥔 포인터 캡처와 포커스가 함께 사라져
 * pointerup·Enter·Esc가 닿을 곳을 잃는다. 저장도, 취소도, 실패 안내도 없이 편집이 증발한다.
 * 저장된 막대는 여전히 clampBar를 쓴다 — 창 밖 업무는 '이 기간 이후' 한 줄로 말하는 편이 정확하다.
 */
export function clampBarEdge(range: BarRange, days: string[]) {
  const box = clampBar(range, days)
  if (box || !days.length) return box
  const before = range.endKey < days[0]
  return { from: before ? 0 : days.length - 1, span: 1, clippedStart: before, clippedEnd: !before }
}

/**
 * 창 밖으로 나간 편집을 따라갈 새 창 시작일. 창 안이면 빈 문자열 — 창을 움직이지 않는다.
 *
 * 여백은 TIMELINE_LEAD_DAYS 하나에서 나온다 — '오늘' 버튼과 첫 화면이 쓰는 그 값이다.
 */
export function followAnchor(range: BarRange, days: string[]): string {
  if (!days.length || clampBar(range, days)) return ''
  return shiftDateKey(range.startKey, -TIMELINE_LEAD_DAYS)
}

/**
 * 막대를 하루 단위로 옮긴다. 'move'는 두 끝, 'end'는 마감만, 'start'는 시작만.
 * 최소 길이 1일을 강제한다(서버 SCHEDULE_ORDER_INVALID의 거울).
 * startUnset인 막대에 'start'를 주면 그대로 돌려준다 — 없는 값은 끌어서 만들지 않는다.
 *
 * 추론한 시작일은 마감을 막지 못한다. startUnset의 startKey는 데이터가 아니라 createdAt(없거나 마감보다
 * 뒤면 마감 하루 전)이고, schedulePayload는 그 값을 보내지도 않는다 — 서버에는 시작일이 아예 없어
 * 마감만 담긴 요청은 그대로 저장된다(scheduleViolation({ startAt: null, due })은 null이다).
 * 그 값으로 클라이언트가 막으면 화면은 스스로 '시작일 미정'이라 적은 날짜를 이유로 마감 이동을 거절하게 된다.
 * 그래서 자르지 않고 barRange와 같은 규칙으로 다시 계산한다 — 그냥 자르는 문을 없애면
 * 거꾸로 된 범위가 barSpanDays·clampBar로 흘러간다.
 */
export function shiftBar(range: BarRange, mode: 'move' | 'start' | 'end', days: number): BarRange {
  if (!days) return range
  if (mode === 'start') {
    if (range.startUnset) return range
    const startKey = shiftDateKey(range.startKey, days)
    return { ...range, startKey: startKey > range.endKey ? range.endKey : startKey }
  }
  const endKey = shiftDateKey(range.endKey, days)
  // startUnset이면 'move'도 'end'와 같은 일을 한다: 왼쪽 끝은 저장되지 않으므로 함께 밀어 보여 줄 것이 없다.
  if (range.startUnset) return { ...range, startKey: endKey < range.startKey ? shiftDateKey(endKey, -1) : range.startKey, endKey }
  if (mode === 'move') return { ...range, startKey: shiftDateKey(range.startKey, days), endKey }
  return { ...range, endKey: endKey < range.startKey ? range.startKey : endKey }
}

/**
 * 서버로 보낼 본문. 시각 보존이 핵심이다 — 드래그는 날짜만 바꾼다.
 * 시각이 없던 레거시 업무는 마감 18:00 · 시작 09:00을 얻는다('오늘까지'라는 사람 말과 맞는 기본값).
 * startUnset이면 startAt을 아예 보내지 않는다 — 추론값을 실제 값으로 굳히지 않는다.
 */
export function schedulePayload(item: WorkItem, range: BarRange): { due: string; startAt?: string | null } {
  const due = atSeoul(range.endKey, seoulTimeOf(item.due, '18:00'))
  if (range.startUnset) return { due }
  return { due, startAt: atSeoul(range.startKey, seoulTimeOf(item.startAt, '09:00')) }
}

/**
 * 미리보기 막대 — 저장한 뒤에 그 자리에 남을 바로 그 막대다.
 *
 * 왜 shiftBar만으로 부족한가: 추론한 시작일(startUnset)은 서버로 가지 않고, 마감이 바뀌면
 * barRange가 createdAt에서 다시 계산한다. 날짜 산술만으로 민 막대는 그 규칙을 모르므로
 * 저장되는 순간 왼쪽 끝이 하루 튀고, 읽어 주는 '· N일'도 그만큼 틀린 수를 말한다.
 * 규칙을 여기에 다시 적지 않는다 — 실제로 보낼 마감(schedulePayload)으로 barRange를 한 번 더 부른다.
 */
export function previewBar(item: WorkItem, range: BarRange, mode: 'move' | 'start' | 'end', days: number, now = new Date()): BarRange {
  const next = shiftBar(range, mode, days)
  if (!next.startUnset) return next
  // atSeoul은 언제나 ISO를 만들고 barRange는 그것을 반드시 읽으므로 뒤 갈래는 타입을 위한 자리다.
  return barRange({ ...item, due: schedulePayload(item, next).due }, now) ?? next
}

/**
 * 기간을 바꿀 수 없는 이유 한 문장. 빈 문자열이면 바꿀 수 있다.
 *
 * 두 사유가 동시에 참일 수 있다(남의 완료된 업무). 그때 어느 쪽을 먼저 말하는지는
 * 라우트(server/work-item-schedule.mjs)의 순서와 같아야 한다 — 권한(403) 먼저, 상태(409) 나중.
 * 순서가 갈리면 화면은 '완료돼서 못 바꾼다'고 하고 서버는 '남의 업무라 못 바꾼다'고 해
 * 같은 사실이 두 문장이 된다. 계약 테스트가 겹치는 경우까지 대조한다.
 */
export function scheduleBlockReason(item: WorkItem, currentUserId: string, canAssignTasks: boolean): string {
  if (!canAssignTasks && item.requesterId !== currentUserId) return SCHEDULE_FORBIDDEN_REASON
  if (item.status === '결재완료') return SCHEDULE_LOCKED_REASON
  return ''
}

/** 막대 몸통의 이름. 제목·담당·기간·상태 한 문장 — 눈으로 보는 것과 같은 것을 읽어 준다. */
export function barAriaLabel(item: WorkItem, range: BarRange): string {
  const period = range.startUnset
    ? `시작일 미정, ${barDayLabel(range.endKey)} 마감`
    : `${barDayLabel(range.startKey)}부터 ${barDayLabel(range.endKey)}까지`
  return `${item.title}, ${item.owner}, ${period}, ${workStatusLabel(item.status)}`
}

/** 읽어 주는 줄이 부르는 날 수. barDraftReadout 하나만 쓴다. */
const barSpanDays = (range: BarRange) => dayKeyDiff(range.startKey, range.endKey) + 1

/**
 * 드로어가 읽는 기간 한 줄. 두 끝을 같은 표기(M.D)로 말한다.
 *
 * 왜 formatWorkDue를 쓰지 않는가: 그 함수는 가까운 날짜를 요일 이름 하나로 돌려주므로
 * 한 문장이 '토요일 → 9.19'가 된다 — 왼쪽은 요일, 오른쪽은 날짜라 단위가 갈리고
 * '토요일'만으로는 어느 토요일인지 알 수 없다. 같은 화면의 막대가 부르는 이름과도 같아진다.
 *
 * 오늘 마감이면 시각까지 붙인다: 목록의 formatWorkDue가 '오늘 18:00'이라고 말하는 그 사실이
 * 드로어에서만 사라지면, 오늘 안에 무엇이 먼저인지 정할 근거가 화면에서 없어진다.
 * (그 시각을 고칠 칸은 드로어의 '업무 기간'이 아니라 마감 편집이므로, 여기서는 읽기만 한다.)
 */
export function workPeriodLabel(item: WorkItem, now = new Date()): string {
  const range = barRange(item, now)
  if (!range) return '기간 미정'
  const start = range.startUnset ? '시작일 미정' : barDayLabel(range.startKey)
  const time = range.endKey === seoulDateInputValue(now) ? seoulTimeOf(item.due, '') : ''
  return `${start} → ${barDayLabel(range.endKey)}${time ? ` ${time}` : ''}`
}

/** 키보드로 옮기는 동안 읽어 주는 문장. 다음에 무엇을 누르면 되는지까지 한 줄에 담는다. */
export function barDraftReadout(item: WorkItem, range: BarRange): string {
  const start = range.startUnset ? '시작일 미정' : `시작 ${barDayLabel(range.startKey)}`
  return `${item.title} — ${start}, 마감 ${barDayLabel(range.endKey)} · ${barSpanDays(range)}일. 저장하려면 Enter, 되돌리려면 Esc.`
}

/**
 * 행 묶기.
 *
 * 담당자별: 자식도 자기 담당자 묶음에 들어간다 — '이 사람이 무엇을 언제까지 하나'를 보는 화면에서
 * 자식을 남의 묶음에 숨기면 그 사람의 부하가 보이지 않는다.
 * 프로젝트별: 자식·상위의 projectId가 서버(SUBTASK_PROJECT_MISMATCH)에서 같도록 강제되므로
 * 이 모드에서만 자식을 상위 바로 아래에 들여쓴다.
 * 묶음 순서는 라벨 가나다순 — 개수순이면 사람 자리가 저장할 때마다 바뀌어 읽을 수 없다.
 */
export function groupBars(items: WorkItem[], by: TimelineGroupBy, projectNames: Record<string, string> = {}): { key: string; label: string; rows: WorkItem[] }[] {
  const buckets = new Map<string, { key: string; label: string; rows: WorkItem[] }>()
  for (const item of items) {
    const key = by === 'owner' ? (item.ownerId || item.owner || '') : (item.projectId || '')
    // 이름을 아직 못 받은 프로젝트는 id를 그대로 보인다 — '프로젝트 미지정'으로 적으면
    // 서로 다른 두 프로젝트가 같은 이름의 묶음 두 개로 보여 어느 쪽이 어느 쪽인지 알 수 없게 된다(projectBarLabel).
    const label = by === 'owner' ? (item.owner || '담당자 미정') : projectBarLabel(key, projectNames)
    const bucket = buckets.get(key) ?? { key, label, rows: [] }
    bucket.rows.push(item)
    buckets.set(key, bucket)
  }
  // 비교 함수 안에서 barRange를 부르면 N log N번 날짜를 파싱한다 — 행마다 한 번만 계산해 두고 그 값을 비교한다.
  const ranges = new Map(items.map((item) => [item.id, barRange(item)]))
  const rowOrder = (left: WorkItem, right: WorkItem) => {
    const leftRange = ranges.get(left.id)
    const rightRange = ranges.get(right.id)
    return (leftRange?.startKey ?? '').localeCompare(rightRange?.startKey ?? '')
      || (leftRange?.endKey ?? '').localeCompare(rightRange?.endKey ?? '')
      || left.title.localeCompare(right.title, 'ko')
  }
  const groups = [...buckets.values()].map((group) => ({ ...group, rows: [...group.rows].sort(rowOrder) }))
  // 프로젝트별에서만 자식을 상위 아래로 붙인다(같은 프로젝트임이 서버에서 보장된다).
  if (by === 'project') for (const group of groups) group.rows = indentChildrenUnderParents(group.rows)
  // 이름 없는 묶음(담당자 미정·프로젝트 미지정)은 언제나 맨 아래. 가나다순에 섞으면 자리가 매번 달라진다.
  return groups.sort((left, right) => (left.key ? 0 : 1) - (right.key ? 0 : 1) || left.label.localeCompare(right.label, 'ko'))
}

/** 상위 바로 아래에 자식을 붙인다. 상위가 이 묶음에 없으면 자식은 제자리(최상위 행)에 남는다. */
function indentChildrenUnderParents(rows: WorkItem[]): WorkItem[] {
  const ids = new Set(rows.map((row) => row.id))
  const ordered: WorkItem[] = []
  for (const row of rows) {
    if (row.parentId && ids.has(row.parentId)) continue
    ordered.push(row)
    for (const child of rows) if (child.parentId === row.id) ordered.push(child)
  }
  return ordered
}

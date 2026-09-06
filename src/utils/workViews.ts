import type { WorkItem } from '../domainData'
// .ts 확장자를 붙인다 — Node가 이 파일을 직접 실행하는 테스트 경로(--experimental-strip-types)에서는 확장자 없는 값 import를 해석하지 못한다.
import { seoulDateInputValue, shiftDateKey, toIsoUtc } from './dateTime.ts'
import { isWorkOverdue } from './workTimeline.ts'
import { workStatusLabel } from './workStatus.ts'

/**
 * 업무 목록의 필터·정렬 — 네 보기(목록·보드·캘린더·타임라인)가 함께 쓰는 한 벌.
 *
 * 왜 순수 함수인가: 같은 조건이 네 화면에서 같은 집합을 만들어야 한다. 보기마다 필터를 따로 쓰면
 * 보드에서 12건이던 것이 캘린더에서 9건이 되고, 사람은 둘 다 믿지 않게 된다.
 *
 * 왜 서버 saved-views.mjs와 축 이름이 같은가: 저장된 보기는 이 구조를 그대로 실어 나른다.
 * 이름이 갈리면 저장할 때와 적용할 때 조건 하나가 조용히 사라진다.
 */

export type WorkFieldFilter = string[] | { min?: number; max?: number } | { from?: string; to?: string }

export type WorkFilters = {
  scope: 'all' | 'mine' | 'requested'
  ownerIds: string[]
  statuses: WorkItem['status'][]
  priorities: WorkItem['priority'][]
  categories: string[]
  projectIds: string[]
  originKinds: string[]
  dueFrom: string | null
  dueTo: string | null
  dueWithinDays: number | null
  overdueOnly: boolean
  hasParent: boolean | null
  text: string
  fields: Record<string, WorkFieldFilter>
}

export const EMPTY_WORK_FILTERS: WorkFilters = {
  scope: 'all', ownerIds: [], statuses: [], priorities: [], categories: [], projectIds: [], originKinds: [],
  dueFrom: null, dueTo: null, dueWithinDays: null, overdueOnly: false, hasParent: null, text: '', fields: {},
}

/**
 * 0건 화면의 첫 두 줄 — **조건 때문에** 비었을 때만 쓴다.
 *
 * 네 보기가 같은 조건을 쓰므로 같은 사실을 같은 말로 적는다. 조건이 하나도 없는 화면에서 이 문장을 쓰면
 * 있지도 않은 조건을 가리키게 되므로, 부르는 쪽은 반드시 filtered로 갈라서 쓴다(목록·타임라인 둘 다 그렇게 한다).
 */
export const WORK_EMPTY_FILTERED_TITLE = '이 조건에 맞는 업무가 없습니다'
export const WORK_EMPTY_FILTERED_HINT = '범위를 넓히면 다른 담당자의 업무도 함께 보입니다.'

export type WorkSortField = 'due' | 'startAt' | 'priority' | 'title' | 'owner' | 'status' | 'createdAt' | `cf:${string}`
export type WorkSort = { field: WorkSortField; direction: 'asc' | 'desc' }
export const DEFAULT_WORK_SORT: WorkSort = { field: 'due', direction: 'asc' }

/**
 * 정렬 축의 이름. 키는 서버 saved-views.mjs의 SAVED_VIEW_SORT_FIELDS와 **한 글자도 다르면 안 된다** —
 * 화면에만 있는 축을 저장하면 400이 되고, 서버에만 있는 축은 아무도 고를 수 없다.
 * 커스텀 필드 축(`cf:<key>`)은 정의 목록에서 자라므로 여기 없다.
 */
export const WORK_SORT_FIELD_LABELS: Record<Exclude<WorkSortField, `cf:${string}`>, string> = {
  due: '마감', startAt: '시작일', priority: '우선순위', title: '제목', owner: '담당', status: '상태', createdAt: '등록일',
}

/**
 * 검색어 상한. 서버 saved-views.mjs의 MAX_TEXT_LENGTH와 같은 값이어야 한다(계약 시험이 소스에서 꺼내 대조한다).
 * 81자째부터는 그 조건을 담은 보기가 400으로 떨어지는데, 화면이 받는 것은 '보기 설정을 확인해 주세요.' 한 줄뿐이라
 * 이름 칸도 필터도 멀쩡해 보이는 채 저장만 안 되는 화면이 된다. 그래서 maxLength로 도달 자체를 막는다.
 */
export const WORK_FILTER_TEXT_MAX = 80

/** 마감 없는 업무를 정렬의 맨 뒤로 보내는 관례. App.tsx의 byDue와 같은 값이다. */
const NO_DUE_KEY = '9999-12-31'
const PRIORITY_ORDER: Record<WorkItem['priority'], number> = { 긴급: 0, 높음: 1, 보통: 2 }
const STATUS_ORDER: WorkItem['status'][] = ['업무요청', '수행중', '결재대기', '결재완료']
const CF_PREFIX = 'cf:'

/** 업무의 커스텀 필드 값 하나. 정의를 모르는 채로도 읽을 수 있어야 필터·정렬이 정의 로딩을 기다리지 않는다. */
export function customFieldValue(item: WorkItem, key: string): string | number | undefined {
  const value = item.fields?.[key]
  return typeof value === 'string' || typeof value === 'number' ? value : undefined
}

/** 마감의 KST 날짜 키. 없으면 빈 문자열 — '언제인지 모른다'와 '9999년'은 다른 사실이다. */
function dueKey(item: WorkItem, now: Date): string {
  const iso = toIsoUtc(item.due, now)
  return iso ? seoulDateInputValue(new Date(iso)) : ''
}

function matchesFieldFilter(value: string | number | undefined, filter: WorkFieldFilter): boolean {
  // select 다중값(OR) · number 범위 · date 범위 세 형태뿐이다. 서버 saved-views.mjs가 같은 셋만 받는다.
  if (Array.isArray(filter)) return filter.length === 0 || (typeof value === 'string' && filter.includes(value))
  const range = filter as { min?: number; max?: number; from?: string; to?: string }
  if (range.min !== undefined || range.max !== undefined) {
    if (typeof value !== 'number') return false
    if (range.min !== undefined && value < range.min) return false
    if (range.max !== undefined && value > range.max) return false
    return true
  }
  if (typeof value !== 'string') return false
  if (range.from !== undefined && value < range.from) return false
  if (range.to !== undefined && value > range.to) return false
  return true
}

/**
 * 필터 적용. 조건은 전부 AND다.
 *
 * 마감 관련 축이 하나라도 켜져 있으면 마감을 못 읽는 업무는 빠진다 — '9월에 걸리는 업무'를 물었는데
 * 언제인지 모르는 업무가 섞여 나오면 그 목록은 답이 아니다. 대신 화면이 그 건수를 따로 말한다.
 *
 * 날짜 경계는 KST 날짜 키의 문자열 비교다: '2026-10-08T14:59:59Z'(= KST 10/8 23:59)는
 * dueTo: '2026-10-08'에 들어가고, 한 시간 뒤인 15:00:00Z는 빠진다.
 *
 * 검색어는 변형하지 않는다(AGENTS.md: onChange에서 값을 바꾸면 한글 IME가 끊긴다).
 * toLowerCase는 비교하는 그 순간에만 한다.
 *
 * textFieldKeys는 **텍스트 타입 커스텀 필드의 key 목록**이다. 그 값들이 검색 haystack에 이어 붙는다 —
 * 그래야 '발주번호'·'메모' 같은 텍스트 항목이 어떤 방법으로든 걸러진다(필터 바에는 텍스트 축을 만들지 않으므로
 * 여기가 유일한 길이다). 숫자·날짜·사람 타입은 일부러 넣지 않는다: 사람 항목의 값은 계정 id 그 자체라
 * id 조각이 검색에 걸리는 순간 화면에 없던 식별자가 검색 결과의 근거가 된다.
 */
export function applyWorkFilters(items: WorkItem[], filters: WorkFilters, currentUserId: string, now = new Date(), textFieldKeys: string[] = []): WorkItem[] {
  const todayKey = seoulDateInputValue(now)
  // 절대 범위가 있으면 상대 범위(N일 안)는 무시한다 — 두 축이 함께 켜지면 더 좁은 쪽이 아니라
  // 사람이 직접 적은 쪽이 이겨야 '내가 고른 날짜가 안 먹는다'가 생기지 않는다.
  const hasAbsolute = Boolean(filters.dueFrom || filters.dueTo)
  const withinKey = !hasAbsolute && filters.dueWithinDays != null ? shiftDateKey(todayKey, filters.dueWithinDays) : ''
  const dueAxisOn = hasAbsolute || Boolean(withinKey) || filters.overdueOnly
  const needle = filters.text.trim().toLowerCase()

  return items.filter((item) => {
    if (filters.scope === 'mine' && item.ownerId !== currentUserId) return false
    if (filters.scope === 'requested' && item.requesterId !== currentUserId) return false
    if (filters.ownerIds.length && !filters.ownerIds.includes(item.ownerId ?? '')) return false
    if (filters.statuses.length && !filters.statuses.includes(item.status)) return false
    if (filters.priorities.length && !filters.priorities.includes(item.priority)) return false
    if (filters.categories.length && !filters.categories.includes(item.category)) return false
    if (filters.projectIds.length && !filters.projectIds.includes(item.projectId ?? '')) return false
    if (filters.originKinds.length && !filters.originKinds.includes(item.origin?.kind ?? '')) return false
    if (filters.hasParent !== null && Boolean(item.parentId) !== filters.hasParent) return false

    if (dueAxisOn) {
      const key = dueKey(item, now)
      if (!key) return false
      if (filters.dueFrom && key < filters.dueFrom) return false
      if (filters.dueTo && key > filters.dueTo) return false
      if (withinKey && (key < todayKey || key > withinKey)) return false
      if (filters.overdueOnly && !isWorkOverdue(item, now)) return false
    }

    for (const [key, filter] of Object.entries(filters.fields)) {
      if (!matchesFieldFilter(customFieldValue(item, key), filter)) return false
    }

    if (needle) {
      const extra = textFieldKeys.map((key) => customFieldValue(item, key) ?? '').filter(Boolean).join(' ')
      const haystack = `${item.title} ${item.owner} ${item.category} ${item.description} ${extra}`.toLowerCase()
      if (!haystack.includes(needle)) return false
    }
    return true
  })
}

/** 값이 없는 행은 asc·desc 어느 쪽에서도 뒤로 간다. '없음'이 '0'이나 'ㄱ'보다 앞에 오면 거짓말이다. */
function compareByField(left: WorkItem, right: WorkItem, field: WorkSortField, now: Date): number {
  if (field.startsWith(CF_PREFIX)) {
    const key = field.slice(CF_PREFIX.length)
    const leftValue = customFieldValue(left, key)
    const rightValue = customFieldValue(right, key)
    if (leftValue === undefined || rightValue === undefined) return 0
    if (typeof leftValue === 'number' && typeof rightValue === 'number') return leftValue - rightValue
    return String(leftValue).localeCompare(String(rightValue), 'ko')
  }
  if (field === 'due') return (dueKey(left, now) || NO_DUE_KEY).localeCompare(dueKey(right, now) || NO_DUE_KEY)
  if (field === 'startAt') return String(left.startAt ?? NO_DUE_KEY).localeCompare(String(right.startAt ?? NO_DUE_KEY))
  if (field === 'createdAt') return String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? ''))
  if (field === 'priority') return PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority]
  if (field === 'status') return STATUS_ORDER.indexOf(left.status) - STATUS_ORDER.indexOf(right.status)
  if (field === 'owner') return left.owner.localeCompare(right.owner, 'ko')
  return left.title.localeCompare(right.title, 'ko')
}

/** 값이 있는 행이 언제나 앞이다. 정렬 방향은 값이 있는 행들 사이에서만 뒤집힌다. */
function missingRank(item: WorkItem, field: WorkSortField, now: Date): number {
  if (field.startsWith(CF_PREFIX)) return customFieldValue(item, field.slice(CF_PREFIX.length)) === undefined ? 1 : 0
  // 마감도 같은 규율을 지난다 — 이것이 빠져 있으면 '마감 내림차순'에서 마감 미정이 전부 맨 위로 올라온다.
  if (field === 'due') return dueKey(item, now) ? 0 : 1
  if (field === 'startAt') return item.startAt ? 0 : 1
  if (field === 'createdAt') return item.createdAt ? 0 : 1
  return 0
}

export function sortWorkItems(items: WorkItem[], sort: WorkSort, now = new Date()): WorkItem[] {
  const factor = sort.direction === 'desc' ? -1 : 1
  return [...items].sort((left, right) => (
    (missingRank(left, sort.field, now) - missingRank(right, sort.field, now))
    || factor * compareByField(left, right, sort.field, now)
    // 동률이면 마감순, 그다음 id — 같은 조건에서 같은 순서가 나와야 화면이 새로 그릴 때 행이 뛰지 않는다.
    || (dueKey(left, now) || NO_DUE_KEY).localeCompare(dueKey(right, now) || NO_DUE_KEY)
    || left.id.localeCompare(right.id)
  ))
}

export type DueQuickId = 'today' | 'week' | 'overdue' | 'custom'

/**
 * 마감 빠른 버튼 중 지금 켜져 있는 것.
 *
 * '직접'은 값이 아니라 **화면 상태**다. 빈 문자열을 filters에 적어 두고 그것으로 판정하면
 * ''가 falsy라 버튼이 영영 켜지지 않는다(실측된 결함: 눌러도 aria-pressed가 false, 날짜 칸도 안 열렸다).
 * 그래서 '열려 있다'는 사실은 부르는 쪽이 들고 오고, 적어 둔 범위가 있으면 그 값이 이긴다.
 */
export function dueQuickId(filters: WorkFilters, customOpen = false): DueQuickId | '' {
  if (filters.dueFrom || filters.dueTo || customOpen) return 'custom'
  if (filters.overdueOnly) return 'overdue'
  if (filters.dueWithinDays === 0) return 'today'
  if (filters.dueWithinDays === 7) return 'week'
  return ''
}

/**
 * 버튼 하나를 눌렀을 때의 다음 필터. 같은 버튼을 다시 누르면 그 축을 통째로 끈다.
 *
 * '직접'은 이미 적어 둔 범위를 **지우지 않는다** — 얻는 것 없이 사람이 고른 조건만 사라지는 버튼을 만들지 않는다.
 * 빈 문자열을 넣지 않는 것도 규율이다: EMPTY_WORK_FILTERS가 null을 쓰므로 ''를 섞으면
 * 같은 '없음'이 두 가지가 되고 filtersEqual이 '변경됨'을 거짓으로 켠다.
 */
export function applyDueQuick(filters: WorkFilters, id: DueQuickId, current: DueQuickId | ''): WorkFilters {
  const cleared = { ...filters, dueWithinDays: null, overdueOnly: false, dueFrom: null, dueTo: null }
  if (id === current) return cleared
  if (id === 'today') return { ...cleared, dueWithinDays: 0 }
  if (id === 'week') return { ...cleared, dueWithinDays: 7 }
  if (id === 'overdue') return { ...cleared, overdueOnly: true }
  return { ...filters, dueWithinDays: null, overdueOnly: false }
}

/** 켜져 있는 축의 수. 0이면 숫자를 그리지 않는다(가짜 0을 만들지 않는다). */
export function activeFilterCount(filters: WorkFilters): number {
  let count = 0
  if (filters.scope !== 'all') count += 1
  for (const key of ['ownerIds', 'statuses', 'priorities', 'categories', 'projectIds', 'originKinds'] as const) {
    if (filters[key].length) count += 1
  }
  if (filters.dueFrom || filters.dueTo) count += 1
  if (filters.dueWithinDays != null) count += 1
  if (filters.overdueOnly) count += 1
  if (filters.hasParent !== null) count += 1
  if (filters.text.trim()) count += 1
  count += Object.keys(filters.fields).length
  return count
}

/** 키 순서와 무관하게 같은 조건인지. '변경됨' 배지의 유일한 판정이다. */
/**
 * 커스텀 필드 축 하나가 같은 조건인지. 목록은 순서를 보지 않고, 범위는 **글자가 아니라 값**으로 본다.
 *
 * JSON.stringify로 비교하던 때의 사고: 저장된 보기의 `{min,max}`에서 최소 칸을 지우고 같은 숫자를 다시 치면
 * WorkFilterBar의 writeNumberRange가 그 객체를 `{max,min}` 순서로 다시 짓는다. 뜻은 한 글자도 안 바뀌었는데
 * 직렬화한 글자가 달라져서 '변경됨' 배지와 되돌리기·변경 저장이 나타났다.
 *
 * 목록 비교는 filtersEqual의 sameList를 **그대로 받아 쓴다** — 여기에 하나 더 적으면 두 판정이 주석으로만 같아진다.
 */
function sameFieldFilter(left: WorkFieldFilter, right: WorkFieldFilter, sameList: (a: string[], b: string[]) => boolean): boolean {
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && sameList(left, right)
  const a = left as { min?: number; max?: number; from?: string; to?: string }
  const b = right as { min?: number; max?: number; from?: string; to?: string }
  return a.min === b.min && a.max === b.max && a.from === b.from && a.to === b.to
}

export function filtersEqual(left: WorkFilters, right: WorkFilters): boolean {
  const sameList = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000')
  if (left.scope !== right.scope || left.text !== right.text) return false
  for (const key of ['ownerIds', 'statuses', 'priorities', 'categories', 'projectIds', 'originKinds'] as const) {
    if (!sameList(left[key] as string[], right[key] as string[])) return false
  }
  if (left.dueFrom !== right.dueFrom || left.dueTo !== right.dueTo) return false
  if (left.dueWithinDays !== right.dueWithinDays) return false
  if (left.overdueOnly !== right.overdueOnly || left.hasParent !== right.hasParent) return false
  const leftKeys = Object.keys(left.fields).sort()
  const rightKeys = Object.keys(right.fields).sort()
  if (leftKeys.join('\u0000') !== rightKeys.join('\u0000')) return false
  return leftKeys.every((key) => sameFieldFilter(left.fields[key], right.fields[key], sameList))
}

export type FilterNames = { owners?: Record<string, string>; projects?: Record<string, string>; origins?: Record<string, string>; fields?: Record<string, string> }

/**
 * 조건을 사람 말로. 저장 대화상자의 이름 자동 제안에 쓴다.
 *
 * 이름 짓기는 저장의 가장 큰 마찰이다 — 지우고 쓰는 것이 백지에서 짓는 것보다 언제나 쉽다.
 * 빈 필터면 빈 문자열을 돌려준다(제안이 ' · '로 시작하지 않게).
 */
export function describeFilters(filters: WorkFilters, names: FilterNames = {}): string {
  const parts: string[] = []
  if (filters.scope === 'mine') parts.push('내가 담당')
  if (filters.scope === 'requested') parts.push('내가 지시')
  if (filters.ownerIds.length) parts.push(filters.ownerIds.map((id) => names.owners?.[id] ?? '담당자').join('·'))
  // 내부 enum('업무요청')이 아니라 화면이 쓰는 말('시작 전')로 부른다 — 제안된 이름이 화면 어디에도 없는
  // 단어로 시작하면, 사람은 자기가 고른 적 없는 조건이 걸린 줄 안다. 표는 workStatus.ts 하나뿐이다.
  if (filters.statuses.length) parts.push(filters.statuses.map(workStatusLabel).join('·'))
  if (filters.priorities.length) parts.push(filters.priorities.join('·'))
  if (filters.overdueOnly) parts.push('지연')
  if (filters.dueFrom || filters.dueTo) parts.push(`${filters.dueFrom ?? ''}~${filters.dueTo ?? ''} 마감`)
  else if (filters.dueWithinDays != null) parts.push(filters.dueWithinDays === 0 ? '오늘 마감' : `${filters.dueWithinDays}일 안 마감`)
  if (filters.projectIds.length) parts.push(filters.projectIds.map((id) => names.projects?.[id] ?? '프로젝트').join('·'))
  if (filters.categories.length) parts.push(filters.categories.join('·'))
  // 출처는 activeFilterCount가 세는 축이다. 여기서 빠지면 출처만으로 좁힌 보기의 이름 제안이
  // '목록' 한 단어가 되고, 그 옆에서 필터 바는 '필터 1개'라고 말한다 — 세는 축과 부르는 축은 같아야 한다.
  if (filters.originKinds.length) parts.push(filters.originKinds.map((kind) => names.origins?.[kind] ?? kind).join('·'))
  if (filters.hasParent !== null) parts.push(filters.hasParent ? '하위 업무만' : '최상위 업무만')
  for (const key of Object.keys(filters.fields)) parts.push(names.fields?.[key] ?? key)
  if (filters.text.trim()) parts.push(`'${filters.text.trim()}'`)
  return parts.join(' · ')
}

export type StoredWorkView = 'list' | 'board' | 'calendar' | 'timeline'
const STORED_VIEWS: StoredWorkView[] = ['list', 'board', 'calendar', 'timeline']
const storageKey = (scope: string) => `onfactory-work-view:${scope}`

/**
 * 마지막으로 보던 방식은 개인 취향이라 서버가 아니라 이 브라우저에 둔다
 * ('이름 붙여 공유하는 조건 묶음'은 서버의 saved-views다 — 둘은 다른 것이다).
 *
 * 기본값이 목록인 이유: 처음 여는 사람에게 가장 적은 것을 요구하는 화면이 목록이다.
 * 보드로 되돌리려면 이 한 줄만 바꾸면 된다.
 */
export function readStoredWorkView(scope: string): StoredWorkView {
  try {
    const stored = window.localStorage.getItem(storageKey(scope))
    return STORED_VIEWS.includes(stored as StoredWorkView) ? stored as StoredWorkView : 'list'
  } catch { return 'list' }
}

/** '반복 규칙'은 보기 방식이 아니라 다른 화면이므로 저장하지 않는다 — 저장하면 다음 방문이 규칙 탭에서 열린다. */
export function writeStoredWorkView(scope: string, mode: StoredWorkView | 'rules'): void {
  if (mode === 'rules') return
  try { window.localStorage.setItem(storageKey(scope), mode) } catch { /* 사생활 보호 모드에서는 저장하지 않는다 */ }
}

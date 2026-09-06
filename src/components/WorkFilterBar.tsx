import { useEffect, useRef, useState } from 'react'
import { Search, Settings2, SlidersHorizontal, X } from 'lucide-react'
import { Button } from './ui/Button'
import { UNKNOWN_ACCOUNT_LABEL, type CustomFieldDefinition } from './CustomFieldInputs'
import {
  activeFilterCount, applyDueQuick, dueQuickId, WORK_FILTER_TEXT_MAX, WORK_SORT_FIELD_LABELS,
  type DueQuickId, type WorkFieldFilter, type WorkFilters, type WorkSort, type WorkSortField,
} from '../utils/workViews'
import { workStatusLabel } from '../utils/workStatus'
import type { WorkItem } from '../domainData'

/**
 * 업무 목록을 좁히고 줄 세우는 한 줄 — 네 보기가 같은 조건을 쓴다.
 *
 * 상단 전역 검색(GlobalSearch, 일곱 갈래)과 역할이 다르다. 그쪽은 '어디에 있든 찾기'이고
 * 이 칸은 '지금 보고 있는 것에서 좁히기'다. placeholder가 그 차이를 말한다.
 *
 * 적용된 조건은 언제나 칩으로 보인다. 안 보이는 필터는 '데이터가 사라졌다'로 읽힌다 —
 * 0건일 때 숫자가 아니라 문장이 나오는 것도 같은 이유다(가짜 0을 만들지 않는다).
 * 그래서 조건이 0개에서 늘어나는 순간에는 접혀 있던 칸이 스스로 펼쳐진다(아래 useEffect).
 *
 * 정렬도 여기 있다. 저장된 보기가 mode·filters·sort·columns를 함께 실어 나르므로,
 * 화면에서 정렬을 고를 수 없으면 저장된 보기의 sort는 아무도 만들 수 없는 값이 된다.
 * 다만 정렬 컨트롤은 **그 순서가 실제로 화면에 나타나는 보기에서만** 그린다(hideSort) —
 * 보드는 단계 칼럼 안에서 '내 처리 필요'와 결재 순서가, 캘린더는 날짜 칸이, 타임라인은 막대 위치가
 * 이미 그 화면의 축이라 고른 정렬이 화면을 움직이지 않는다. 아무 일도 하지 않는 컨트롤은 고장으로 읽힌다.
 *
 * onChange 안에서 값을 변형하지 않는다(AGENTS.md 금지: 한글 IME가 끊긴다).
 * primary는 하나도 없다 — 화면의 primary는 헤더의 '새 업무 지시'와 드로어의 '지금 할 일' 둘뿐이다.
 */

export type FilterOption = { id: string; label: string }

/**
 * 상태 문구는 workStatus.ts 하나에서만 나온다. 여기에 짧은 표를 하나 더 두면 같은 업무가 한 화면에서
 * 두 이름으로 불린다 — 행 배지는 '확인 기다리는 중'인데 바로 위 필터 칩은 '확인 대기'였다.
 */
const STATUS_CHIPS: WorkItem['status'][] = ['업무요청', '수행중', '결재대기', '결재완료']
/** 우선순위와 상위 여부도 축이다 — activeFilterCount·describeFilters가 이미 세고 이름에도 넣는다.
 *  컨트롤과 칩이 없으면 '필터 N개'와 보이는 칩 수가 어긋나고, 개별 해제 버튼이 없는 조건이 생긴다. */
const PRIORITY_CHIPS: WorkItem['priority'][] = ['긴급', '높음', '보통']
const PARENT_CHOICES: [boolean, string][] = [[false, '최상위만'], [true, '하위만']]
const SORT_FIELDS = Object.keys(WORK_SORT_FIELD_LABELS) as Exclude<WorkSortField, `cf:${string}`>[]

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value]
}

/** 숫자 범위 칸의 글자 → 값. 아직 숫자가 아닌 중간 상태('-'·'0.')는 '값 없음'이다. */
function parseRangeValue(raw: string): number | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** 칩에 적을 조건 한 줄. 사람 항목은 이름으로 바꾼다 — 계정 id를 화면에 노출하지 않는다. */
function fieldFilterLabel(definition: CustomFieldDefinition | undefined, filter: WorkFieldFilter, people: { id: string; name: string }[]): string {
  // 정의가 아직 안 왔으면 값을 그리지 않는다 — 사람 항목이면 그 값이 계정 id 그 자체다.
  if (!definition) return ''
  if (Array.isArray(filter)) {
    if (definition.type !== 'person') return filter.join('·')
    return filter.map((id) => people.find((person) => person.id === id)?.name ?? UNKNOWN_ACCOUNT_LABEL).join('·')
  }
  const range = filter as { min?: number; max?: number; from?: string; to?: string }
  const left = range.min ?? range.from
  const right = range.max ?? range.to
  if (left === undefined && right === undefined) return ''
  return `${left ?? ''}~${right ?? ''}`
}

export function WorkFilterBar({
  filters, onChange, onClear, sort, onSortChange, visibleCount, assignees = [], categories = [], projects = [], originKinds = [],
  definitions = [], people = [], hideStatus = false, hideSort = false, canAssignTasks = false, onManageFields,
}: {
  filters: WorkFilters
  onChange: (next: WorkFilters) => void
  onClear: () => void
  sort: WorkSort
  onSortChange: (next: WorkSort) => void
  visibleCount: number
  assignees?: FilterOption[]
  categories?: string[]
  projects?: FilterOption[]
  originKinds?: FilterOption[]
  definitions?: CustomFieldDefinition[]
  /** 사람 항목 축의 후보. 값은 계정 id이고 보이는 것은 이름이다. */
  people?: { id: string; name: string }[]
  /** 보드 보기에서는 칼럼이 이미 상태축이므로 상태 칩을 그리지 않는다(같은 축이 두 벌이 된다). */
  hideStatus?: boolean
  /** 고른 순서가 그 화면에서 실제로 보이지 않으면 정렬 칸을 그리지 않는다(보드·캘린더·타임라인). */
  hideSort?: boolean
  canAssignTasks?: boolean
  onManageFields?: () => void
}) {
  const count = activeFilterCount(filters)
  // details는 한 곳에서만 열리고 닫힌다 — open만 주고 onToggle을 빼면 화면과 DOM이 갈린다.
  const [open, setOpen] = useState(count > 0)
  // '직접'은 값이 아니라 화면 상태다(workViews.dueQuickId의 주석).
  const [customOpen, setCustomOpen] = useState(Boolean(filters.dueFrom || filters.dueTo))
  // 숫자 범위 칸이 지금 화면에 담고 있는 글자. 값이 아니라 '치는 중인 글자'라서 따로 든다.
  const [rangeText, setRangeText] = useState<Record<string, string>>({})
  /**
   * 조건이 밖에서 들어오면(저장된 보기·범위 버튼) 접혀 있던 칸을 편다.
   *
   * 칩도 '업무 N건'도 '필터 지우기'도 전부 이 details 안에 있다 — 접힌 채로 조건만 늘면
   * 사람은 짧아진 목록만 보고 '데이터가 사라졌다'고 읽고, 되돌릴 버튼조차 보이지 않는다.
   * 0 → 양수로 올라가는 순간에만 편다. 조건을 켜 둔 채 일부러 접은 사람과 매 렌더 다투지 않는다.
   */
  const previousCount = useRef(count)
  useEffect(() => {
    if (count > 0 && previousCount.current === 0) setOpen(true)
    previousCount.current = count
  }, [count])

  const set = (patch: Partial<WorkFilters>) => onChange({ ...filters, ...patch })
  const setFieldFilter = (key: string, value: WorkFieldFilter | null) => {
    const next = { ...filters.fields }
    if (value === null) delete next[key]
    else next[key] = value
    set({ fields: next })
  }
  const quick = dueQuickId(filters, customOpen)
  const applyQuick = (id: DueQuickId) => {
    setCustomOpen(id === 'custom' && id !== quick)
    onChange(applyDueQuick(filters, id, quick))
  }

  /**
   * 커스텀 필드 축. 관리자가 만든 항목이 있으면 그 축이 여기에 저절로 생기고, 없는 축은 만들지 않는다.
   * 텍스트 타입만 축이 없다 — 위의 검색 칸(filters.text)이 제목·담당·분류·설명에 더해
   * **텍스트 항목의 값까지** 부분일치로 훑기 때문이다(applyWorkFilters의 textFieldKeys).
   * 텍스트 항목마다 칸을 하나씩 더 그리면 같은 일을 하는 입력이 화면에 여러 개가 된다.
   */
  const axisFields = definitions.filter((definition) => (
    !definition.archivedAt && (definition.type !== 'select' || definition.options.length) && definition.type !== 'text'
  ))
  const sortFields = definitions.filter((definition) => !definition.archivedAt)
  /**
   * 지금 정렬 축이 아래 목록에 없는 커스텀 필드일 때 그 자리에 적을 이름.
   *
   * 두 갈래로 온다: 관리자가 그 항목을 방금 보관했거나(정의 목록은 바로 줄지만 sort는 아무도 되돌리지 않는다),
   * 저장된 보기가 그 축을 실어 왔는데 /api/custom-fields가 아직 안 왔거나. 앞의 경우에만 '(보관됨)'이라고 말한다 —
   * 아직 못 받은 것을 보관됐다고 하면 화면이 모르는 것을 아는 척하게 된다.
   */
  const orphanSortField = sort.field.startsWith('cf:') && !sortFields.some((definition) => `cf:${definition.key}` === sort.field)
  const orphanLabel = definitions.find((definition) => `cf:${definition.key}` === sort.field)?.label
  const orphanSortLabel = !orphanSortField ? '' : orphanLabel ? `${orphanLabel} (보관됨)` : '추가 항목'
  const numberRange = (key: string) => {
    const current = filters.fields[key]
    return current && !Array.isArray(current) ? current as { min?: number; max?: number } : {}
  }
  const dateRange = (key: string) => {
    const current = filters.fields[key]
    return current && !Array.isArray(current) ? current as { from?: string; to?: string } : {}
  }
  /**
   * 숫자 칸에 그릴 글자. 사람이 친 글자를 그대로 두되 **그 글자가 지금 필터와 같은 값을 뜻할 때만**이다.
   * 그래서 '0.'·'-' 같은 중간 상태가 타이핑 중에 지워지지 않고, 저장된 보기가 다른 값을 넣으면 그 값이 이긴다.
   */
  const rangeShown = (key: string, side: 'min' | 'max', value: number | undefined) => {
    const raw = rangeText[`${key}:${side}`]
    if (raw !== undefined && parseRangeValue(raw) === value) return raw
    return value === undefined ? '' : String(value)
  }
  const writeNumberRange = (key: string, side: 'min' | 'max', raw: string) => {
    setRangeText((typed) => ({ ...typed, [`${key}:${side}`]: raw }))
    const next: { min?: number; max?: number } = { ...numberRange(key) }
    const value = parseRangeValue(raw)
    if (value === undefined) delete next[side]
    else next[side] = value
    setFieldFilter(key, next.min === undefined && next.max === undefined ? null : next)
  }
  const writeDateRange = (key: string, side: 'from' | 'to', raw: string) => {
    const next: { from?: string; to?: string } = { ...dateRange(key) }
    if (raw) next[side] = raw
    else delete next[side]
    setFieldFilter(key, next.from === undefined && next.to === undefined ? null : next)
  }

  const chips: { key: string; label: string; clear: () => void }[] = []
  if (filters.scope !== 'all') chips.push({ key: 'scope', label: filters.scope === 'mine' ? '내가 담당' : '내가 지시', clear: () => set({ scope: 'all' }) })
  for (const id of filters.ownerIds) chips.push({ key: `owner-${id}`, label: assignees.find((person) => person.id === id)?.label ?? '담당자', clear: () => set({ ownerIds: filters.ownerIds.filter((entry) => entry !== id) }) })
  for (const status of filters.statuses) chips.push({ key: `status-${status}`, label: workStatusLabel(status), clear: () => set({ statuses: filters.statuses.filter((entry) => entry !== status) }) })
  for (const priority of filters.priorities) chips.push({ key: `priority-${priority}`, label: priority, clear: () => set({ priorities: filters.priorities.filter((entry) => entry !== priority) }) })
  if (filters.hasParent !== null) chips.push({ key: 'parent', label: filters.hasParent ? '하위만' : '최상위만', clear: () => set({ hasParent: null }) })
  for (const category of filters.categories) chips.push({ key: `category-${category}`, label: category, clear: () => set({ categories: filters.categories.filter((entry) => entry !== category) }) })
  for (const id of filters.projectIds) chips.push({ key: `project-${id}`, label: projects.find((project) => project.id === id)?.label ?? '프로젝트', clear: () => set({ projectIds: filters.projectIds.filter((entry) => entry !== id) }) })
  for (const kind of filters.originKinds) chips.push({ key: `origin-${kind}`, label: originKinds.find((origin) => origin.id === kind)?.label ?? kind, clear: () => set({ originKinds: filters.originKinds.filter((entry) => entry !== kind) }) })
  if (filters.overdueOnly) chips.push({ key: 'overdue', label: '지연', clear: () => set({ overdueOnly: false }) })
  if (filters.dueWithinDays != null) chips.push({ key: 'within', label: filters.dueWithinDays === 0 ? '오늘 마감' : `${filters.dueWithinDays}일 안 마감`, clear: () => set({ dueWithinDays: null }) })
  if (filters.dueFrom || filters.dueTo) chips.push({ key: 'range', label: `${filters.dueFrom || '처음'} ~ ${filters.dueTo || '끝'}`, clear: () => set({ dueFrom: null, dueTo: null }) })
  for (const [key, value] of Object.entries(filters.fields)) {
    const definition = definitions.find((entry) => entry.key === key)
    const shown = fieldFilterLabel(definition, value, people)
    chips.push({ key: `field-${key}`, label: `${definition?.label ?? key}${shown ? ` ${shown}` : ''}`, clear: () => setFieldFilter(key, null) })
  }
  if (filters.text.trim()) chips.push({ key: 'text', label: `'${filters.text.trim()}'`, clear: () => set({ text: '' }) })

  return <details className="work-filter" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><SlidersHorizontal size={16} /> 필터{count ? ` ${count}` : ''}</summary>
    <div className="work-filter-body">
      <label className="work-filter-search">
        <span className="sr-only">이 화면에서 업무 찾기</span>
        <Search size={18} />
        {/* maxLength는 자르지 않고 막는다 — onChange에서 잘라 내면 한글 IME 조합이 끊긴다. */}
        <input value={filters.text} maxLength={WORK_FILTER_TEXT_MAX} onChange={(event) => set({ text: event.target.value })} placeholder="이 화면에서 좁히기 — 제목·담당·추가 항목" />
      </label>

      <label className="form-field work-filter-select"><span>담당</span>
        <select value={filters.ownerIds[0] ?? ''} onChange={(event) => set({ ownerIds: event.target.value ? [event.target.value] : [] })}>
          <option value="">전체</option>
          {assignees.map((person) => <option value={person.id} key={person.id}>{person.label}</option>)}
        </select></label>

      {!hideStatus && <div className="segmented work-filter-status" role="group" aria-label="상태로 좁히기">
        {STATUS_CHIPS.map((status) => <button
          type="button"
          key={status}
          aria-pressed={filters.statuses.includes(status)}
          onClick={() => set({ statuses: toggle(filters.statuses, status) })}
        >{workStatusLabel(status)}</button>)}
      </div>}

      <div className="segmented work-filter-priority" role="group" aria-label="우선순위로 좁히기">
        {PRIORITY_CHIPS.map((priority) => <button
          type="button"
          key={priority}
          aria-pressed={filters.priorities.includes(priority)}
          onClick={() => set({ priorities: toggle(filters.priorities, priority) })}
        >{priority}</button>)}
      </div>

      {/* 두 값짜리 축이라 같은 버튼을 다시 누르면 꺼진다 — '전체'라는 세 번째 값을 만들지 않는다(없음은 한 가지다). */}
      <div className="segmented work-filter-parent" role="group" aria-label="상위 업무로 좁히기">
        {PARENT_CHOICES.map(([value, label]) => <button
          type="button"
          key={label}
          aria-pressed={filters.hasParent === value}
          onClick={() => set({ hasParent: filters.hasParent === value ? null : value })}
        >{label}</button>)}
      </div>

      <div className="segmented work-filter-due" role="group" aria-label="마감으로 좁히기">
        {([['today', '오늘'], ['week', '이번 주'], ['overdue', '지연'], ['custom', '직접']] as [DueQuickId, string][]).map(([id, label]) => (
          <button type="button" key={id} aria-pressed={quick === id} onClick={() => applyQuick(id)}>{label}</button>
        ))}
      </div>
      {quick === 'custom' && <div className="work-filter-range">
        <label className="form-field"><span>마감 시작</span>
          <input type="date" value={filters.dueFrom ?? ''} onChange={(event) => set({ dueFrom: event.target.value || null })} /></label>
        <label className="form-field"><span>마감 끝</span>
          <input type="date" value={filters.dueTo ?? ''} onChange={(event) => set({ dueTo: event.target.value || null })} /></label>
      </div>}

      {projects.length > 0 && <label className="form-field work-filter-select"><span>프로젝트</span>
        <select value={filters.projectIds[0] ?? ''} onChange={(event) => set({ projectIds: event.target.value ? [event.target.value] : [] })}>
          <option value="">전체</option>
          {projects.map((project) => <option value={project.id} key={project.id}>{project.label}</option>)}
        </select></label>}

      {categories.length > 0 && <label className="form-field work-filter-select"><span>분류</span>
        <select value={filters.categories[0] ?? ''} onChange={(event) => set({ categories: event.target.value ? [event.target.value] : [] })}>
          <option value="">전체</option>
          {categories.map((category) => <option value={category} key={category}>{category}</option>)}
        </select></label>}

      {originKinds.length > 0 && <label className="form-field work-filter-select"><span>출처</span>
        <select value={filters.originKinds[0] ?? ''} onChange={(event) => set({ originKinds: event.target.value ? [event.target.value] : [] })}>
          <option value="">전체</option>
          {originKinds.map((origin) => <option value={origin.id} key={origin.id}>{origin.label}</option>)}
        </select></label>}

      {axisFields.map((definition) => {
        // key는 정의의 id다 — 이 칸이 스스로 고치는 값에서 key를 만들면 한 글자마다 입력이 새로 마운트된다.
        if (definition.type === 'select') {
          const current = filters.fields[definition.key]
          const selected = Array.isArray(current) ? current[0] ?? '' : ''
          return <label className="form-field work-filter-select" key={definition.id}><span>{definition.label}</span>
            <select value={selected} onChange={(event) => setFieldFilter(definition.key, event.target.value ? [event.target.value] : null)}>
              <option value="">전체</option>
              {definition.options.map((option) => <option value={option} key={option}>{option}</option>)}
            </select></label>
        }
        if (definition.type === 'person') {
          const current = filters.fields[definition.key]
          const selected = Array.isArray(current) ? current[0] ?? '' : ''
          return <label className="form-field work-filter-select" key={definition.id}><span>{definition.label}</span>
            <select value={selected} onChange={(event) => setFieldFilter(definition.key, event.target.value ? [event.target.value] : null)}>
              <option value="">전체</option>
              {/* 그 계정이 디렉터리에서 사라져도(퇴사·삭제) select가 빈 칸이 되지 않는다 — 값 입력의 사람 select와
                  정렬 select가 이미 쓰는 탈출구다. option이 없으면 목록은 그 축으로 걸린 채인데 컨트롤만 아무것도 안 고른 얼굴이 된다. */}
              {selected && !people.some((person) => person.id === selected) && <option value={selected}>{UNKNOWN_ACCOUNT_LABEL}</option>}
              {people.map((person) => <option value={person.id} key={person.id}>{person.name}</option>)}
            </select></label>
        }
        if (definition.type === 'date') {
          const range = dateRange(definition.key)
          return <div className="work-filter-range" key={definition.id}>
            <label className="form-field"><span>{definition.label} 시작</span>
              <input type="date" value={range.from ?? ''} onChange={(event) => writeDateRange(definition.key, 'from', event.target.value)} /></label>
            <label className="form-field"><span>{definition.label} 끝</span>
              <input type="date" value={range.to ?? ''} onChange={(event) => writeDateRange(definition.key, 'to', event.target.value)} /></label>
          </div>
        }
        // 숫자도 type="number"를 쓰지 않는다 — 휠이 지나가기만 해도 값이 바뀌고 IME 조합 중에 값이 튄다.
        const range = numberRange(definition.key)
        return <div className="work-filter-range" key={definition.id}>
          <label className="form-field"><span>{definition.label} 최소</span>
            <input type="text" inputMode="decimal" value={rangeShown(definition.key, 'min', range.min)} onChange={(event) => writeNumberRange(definition.key, 'min', event.target.value)} /></label>
          <label className="form-field"><span>{definition.label} 최대</span>
            <input type="text" inputMode="decimal" value={rangeShown(definition.key, 'max', range.max)} onChange={(event) => writeNumberRange(definition.key, 'max', event.target.value)} /></label>
        </div>
      })}

      {/* 정렬 축은 서버 SAVED_VIEW_SORT_FIELDS와 같은 일곱 개 + 관리자가 만든 항목이다.
          목록에서만 그린다 — 다른 세 보기는 각자의 축(단계·날짜 칸·막대 위치)이 순서를 이미 정한다. */}
      {!hideSort && <div className="work-filter-sort">
        <label className="form-field work-filter-select"><span>정렬</span>
          <select value={sort.field} onChange={(event) => onSortChange({ ...sort, field: event.target.value as WorkSortField })}>
            {SORT_FIELDS.map((field) => <option value={field} key={field}>{WORK_SORT_FIELD_LABELS[field]}</option>)}
            {/* 보관된(또는 아직 안 도착한) 항목으로 정렬 중이면 그 값의 option을 남긴다 — 사람 항목 select와 같은 탈출구다.
                option이 없으면 select만 빈 칸이 되고 목록은 여전히 그 축으로 줄 서서, 보이는 컨트롤과 실제 순서가 갈린다. */}
            {orphanSortLabel && <option value={sort.field}>{orphanSortLabel}</option>}
            {sortFields.length > 0 && <optgroup label="추가 항목">
              {sortFields.map((definition) => <option value={`cf:${definition.key}`} key={definition.id}>{definition.label}</option>)}
            </optgroup>}
          </select></label>
        <div className="segmented work-filter-direction" role="group" aria-label="정렬 방향">
          <button type="button" aria-pressed={sort.direction === 'asc'} onClick={() => onSortChange({ ...sort, direction: 'asc' })}>오름차순</button>
          <button type="button" aria-pressed={sort.direction === 'desc'} onClick={() => onSortChange({ ...sort, direction: 'desc' })}>내림차순</button>
        </div>
      </div>}

      {/* '이걸로 거르고 싶은데 축이 없다'가 커스텀 필드를 필요로 하는 유일한 순간이다 — 만드는 자리를 그 자리에 둔다. */}
      {canAssignTasks && onManageFields && <Button tone="quiet" size="sm" type="button" onClick={onManageFields}><Settings2 size={15} /> 항목 관리</Button>}
    </div>

    {chips.length > 0 && <ul className="work-filter-chips" aria-label="적용된 조건">
      {chips.map((chip) => <li key={chip.key}>
        <button type="button" onClick={chip.clear}>{chip.label} <X size={12} /></button>
      </li>)}
    </ul>}

    <p className="work-filter-result" role="status">
      {visibleCount ? `업무 ${visibleCount}건` : '조건에 맞는 업무가 없습니다'}
      {count ? ` · 필터 ${count}개` : ''}
      {count > 0 && <Button tone="quiet" size="sm" type="button" onClick={onClear}>필터 지우기</Button>}
    </p>
  </details>
}

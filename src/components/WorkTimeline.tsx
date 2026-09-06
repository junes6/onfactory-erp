import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, FocusEvent as ReactFocusEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { CalendarClock, ChevronLeft, ChevronRight } from 'lucide-react'

import { Button, IconButton } from './ui/Button'
import { ParentChip } from './SubtaskList'
import { StatusBadge } from './StatusBadge'
import { dayKeyDiff, seoulDateInputValue, shiftDateKey } from '../utils/dateTime'
import { dayKind, holidayName } from '../utils/koreanHolidays'
import { workStatusLabel, workStatusTone } from '../utils/workStatus'
import { isSubtask, parentTitleOf } from '../utils/workTree'
import type { ParentRef } from '../utils/workTree'
import {
  barAriaLabel, barDayLabel, barDraftReadout, barRange, barTone, clampBar, clampBarEdge, followAnchor, groupBars,
  previewBar, schedulePayload, scheduleBlockReason, timelineDays, TIMELINE_LEAD_DAYS, TIMELINE_RANGES, SCHEDULE_ORDER_HINT,
} from '../utils/workTimeline'
import type { BarRange, ScheduleResult, TimelineGroupBy, TimelineRangeId } from '../utils/workTimeline'
import { WORK_EMPTY_FILTERED_HINT, WORK_EMPTY_FILTERED_TITLE } from '../utils/workViews'
import type { WorkItem } from '../domainData'
import './WorkViews.css'

/**
 * 업무 기간 타임라인 — 가로 막대 하나와 오늘 선 하나.
 *
 * 간트차트가 아니다: 의존 관계·크리티컬 패스·리소스 할당이 없다. 막대는 '언제부터 언제까지'만 말한다.
 *
 * 드래그는 결코 유일한 길이 아니다. 막대 안의 포커스 가능한 버튼 세 개(시작·몸통·마감)가
 * 마우스 조작과 1:1로 대응한다(←/→ ±1일, Shift+ ±7일). 좁은 화면·터치에서는 손잡이를 아예 그리지 않는다 —
 * 22px 칸에서 손가락으로 하루를 정확히 집을 수 없고, 잘못 잡힌 드래그는 남의 마감을 바꾼다.
 * 그 표면의 정본 경로는 상세 드로어의 '업무 기간' 칸이다.
 *
 * 낙관적 갱신을 하지 않는다: 최종 판정은 서버다. 다만 요청이 도는 동안 끌어 놓은 자리를 유지하고(.is-pending),
 * 거절되면 즉시 제자리로 돌아간다. 거절 문장은 토스트(role="status")가 서버 문장 그대로 읽어 준다 —
 * 여기서 다른 문장을 하나 더 만들면 같은 사실을 두 가지로 말하게 된다.
 */

const DRAG_THRESHOLD_PX = 4
/** 이 컨트롤이 실제로 답하는 키만 적는다 — Space는 Enter와 같은 갈래를 탄다(onBarKeyDown). */
const KEY_SHORTCUTS = 'ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Enter Space Escape'
type BarMode = 'move' | 'start' | 'end'
type Draft = { id: string; mode: BarMode; range: BarRange }

export function WorkTimeline({
  items, allItems, parentRefs = {}, currentUserId, canAssignTasks, workspaceScope, filtered = false,
  onOpen, onSchedule, onClearFilter,
}: {
  /** 지금 보이는 집합(범위 필터를 지난 목록). */
  items: WorkItem[]
  /** 상위 제목을 찾기 위한 전체 목록. */
  allItems: WorkItem[]
  parentRefs?: Record<string, ParentRef>
  currentUserId: string
  canAssignTasks: boolean
  workspaceScope?: string
  filtered?: boolean
  onOpen: (id: string) => void
  onSchedule?: (id: string, next: { due: string; startAt?: string | null }) => Promise<ScheduleResult>
  onClearFilter?: () => void
}) {
  const todayKey = seoulDateInputValue()
  const [groupBy, setGroupBy] = useState<TimelineGroupBy>('owner')
  const [rangeId, setRangeId] = useState<TimelineRangeId>('weeks4')
  // 첫 창도 '오늘' 버튼과 같은 여백에서 시작한다 — 다르면, 아무 데도 가지 않은 사람이 '오늘'을 눌렀을 때 캔버스가 한 칸 민다.
  const [anchorKey, setAnchorKey] = useState(() => shiftDateKey(seoulDateInputValue(), -TIMELINE_LEAD_DAYS))
  const [draft, setDraft] = useState<Draft | null>(null)
  const [pendingId, setPendingId] = useState('')
  const [status, setStatus] = useState('')
  const [projectNames, setProjectNames] = useState<Record<string, string>>({})
  const [projectsLoaded, setProjectsLoaded] = useState(false)
  // (pointer: coarse)까지 함께 본다 — 768~1024px 터치 태블릿에서 잡히지 않는 손잡이가 생기는 구멍을 막는다.
  const [coarse, setCoarse] = useState(false)
  const dragRef = useRef<{ id: string; mode: BarMode; originX: number; cellPx: number; base: BarRange; moved: boolean } | null>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const projectsBusy = useRef(false)

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(max-width: 760px), (pointer: coarse)')
    const sync = () => setCoarse(query.matches)
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])

  useEffect(() => {
    // 프로젝트 이름은 그 묶음을 실제로 볼 때만 읽는다. 담당자별로 보는 사람에게는 필요 없는 요청이다.
    // 실패해도 projectsLoaded를 세우지 않는다: 세우면 500 한 번에 세션 내내 모든 묶음이 id 라벨로 굳고
    // 다시 고르는 것조차 재시도가 되지 못한다. 대신 진행 중 중복 요청만 ref로 막는다.
    if (groupBy !== 'project' || projectsLoaded || projectsBusy.current) return
    let active = true
    projectsBusy.current = true
    fetch('/api/projects', { headers: workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined })
      .then(async (response) => {
        if (!response.ok) throw new Error('projects')
        const body = await response.json() as { projects?: { id: string; name: string }[] }
        if (!active) return
        setProjectNames(Object.fromEntries((body.projects ?? []).map((project) => [project.id, project.name])))
        setProjectsLoaded(true)
      })
      .catch(() => {})
      .finally(() => { projectsBusy.current = false })
    // 정리에서도 잠금을 푼다 — 요청이 도는 중에 묶음을 바꿨다 돌아오면 그 선택이 재시도가 되어야 한다.
    return () => { active = false; projectsBusy.current = false }
  }, [groupBy, projectsLoaded, workspaceScope])

  const days = useMemo(() => timelineDays(anchorKey, TIMELINE_RANGES.find((range) => range.id === rangeId)?.days ?? 28), [anchorKey, rangeId])
  // 막대 범위는 목록당 한 번만 계산한다. renderRow가 행마다 다시 부르면 드래그 한 프레임이 전 행의 날짜 파싱이 된다.
  const rows = useMemo(() => items.map((item) => ({ item, range: barRange(item) })), [items])
  const dated = useMemo(() => rows.filter((row): row is { item: WorkItem; range: BarRange } => Boolean(row.range)), [rows])
  const undated = useMemo(() => rows.filter((row) => !row.range).map((row) => row.item), [rows])
  const ranges = useMemo(() => new Map(dated.map((row) => [row.item.id, row.range])), [dated])
  // 편집 중인 행은 저장된 범위가 창 밖이어도 '보이는' 것으로 센다 — 창이 막대를 따라가면
  // 저장된 자리는 창 뒤로 남는다. 그때 캔버스가 통째로 사라지면 따라간 보람 없이 포커스도 함께 사라진다.
  const visible = useMemo(() => dated.filter((row) => clampBar(row.range, days) || row.item.id === draft?.id), [dated, days, draft])
  // 묶음에는 마감이 있는 업무를 전부 넣는다 — 창 밖으로 나간 업무를 목록에서 지우면 '있는데 안 보이는' 화면이 된다.
  const groups = useMemo(() => groupBars(dated.map((row) => row.item), groupBy, projectNames), [dated, groupBy, projectNames])
  const todayIndex = days.indexOf(todayKey)
  const windowLabel = `${barDayLabel(days[0])} → ${barDayLabel(days[days.length - 1])} · ${days.length}일`
  const draftItem = draft ? items.find((item) => item.id === draft.id) : null

  /** 창 밖 업무 중 가장 가까운 것. 빈 캔버스만 보여 주고 끝내지 않기 위한 값이다. */
  const nearest = useMemo(() => {
    if (visible.length || !dated.length) return null
    const first = days[0]
    const last = days[days.length - 1]
    return dated
      .map((row) => ({ row, distance: row.range.endKey < first ? dayKeyDiff(row.range.endKey, first) : dayKeyDiff(last, row.range.startKey) }))
      .sort((left, right) => left.distance - right.distance)[0]?.row ?? null
  }, [visible, dated, days])

  /**
   * 편집을 접었을 때 저장된 자리로 창을 되돌린다.
   * 왜: 창이 막대를 따라간 뒤 취소·거절되면 되돌아간 막대는 창 뒤에 남는다.
   * 그 자리에 빈 캔버스만 남기면 무엇이 되돌아왔는지 볼 수 없고 포커스도 함께 사라진다.
   */
  const followBack = (range: BarRange | null) => {
    const back = range ? followAnchor(range, days) : ''
    if (back) setAnchorKey(back)
  }

  const commit = async (item: WorkItem, range: BarRange) => {
    if (!onSchedule) return
    setPendingId(item.id)
    try {
      const saved = await onSchedule(item.id, schedulePayload(item, range))
      // startUnset이면 schedulePayload가 startAt을 보내지 않는다 — 보내지 않은 값을 바꿨다고 읽어 주지 않는다
      // (barDraftReadout과 같은 갈래를 쓴다. 저장 직후 왼쪽 끝은 화면에서 곧바로 제자리로 돌아간다).
      const changed = range.startUnset
        ? `${item.title} 마감을 ${barDayLabel(range.endKey)}로 바꿨습니다.`
        : `${item.title} 기간을 ${barDayLabel(range.startKey)}부터 ${barDayLabel(range.endKey)}까지로 바꿨습니다.`
      // 거절 문장은 서버가 준 그것을 그대로 옮긴다 — 토스트와 이 줄이 같은 한 문장을 말한다.
      // 여기서 두 번째 문장을 짓지 않고, 빈 줄로 두지도 않는다: 미리보기가 이유 없이 사라지면
      // 캔버스 안에서 키보드로 옮기던 사람에게는 아무 일도 일어나지 않은 것과 같다.
      setStatus(saved.ok ? changed : (saved.message ?? ''))
      if (!saved.ok) followBack(barRange(item))
    } catch {
      setStatus('')
      followBack(barRange(item))
    } finally {
      // 이 행의 것만 치운다. 요청이 도는 동안 다른 행을 방향키로 옮기던 사람이 있으면
      // 먼저 떠난 요청의 정리가 그 사람의 미리보기와 .is-pending 표시를 함께 지운다(onBarBlur와 같은 규율).
      setPendingId((current) => current === item.id ? '' : current)
      setDraft((current) => current?.id === item.id ? null : current)
    }
  }

  /** 드래그가 살아 있을 때만 정리한다 — pointerup이 이미 넘긴 뒤에 lostpointercapture가 드래프트를 지우면 요청 중 막대가 튄다. */
  const cancelDrag = () => {
    if (!dragRef.current) return
    dragRef.current = null
    setDraft(null)
  }

  /**
   * 편집을 조용히 접는다(문장 없이).
   *
   * 왜: 다른 기간을 보러 가는 조작은 그 자체로 '지금 이 편집은 그만'이다. 남겨 두면 두 달 뒤 창에
   * 아무도 저장하지 않은 기간이 창 끝 한 칸으로 계속 붙어 있고(clampBarEdge), 읽어 주는 줄은
   * 그대로 '저장하려면 Enter'라고 말한다. 문장을 따로 만들지 않는 이유는 읽어 주는 줄이
   * 곧바로 창 라벨로 돌아가며 그 사실을 이미 말하기 때문이다.
   */
  const cancelDraft = () => {
    dragRef.current = null
    setDraft(null)
  }

  /**
   * 포커스가 막대를 떠나면 편집을 접는다.
   *
   * 왜: Esc를 누르지 않고 다른 곳을 클릭하는 것은 평범한 취소 방법이다. 그때 미리보기가 남으면
   * 캔버스는 아무도 저장하지 않은 기간을 계속 그리고, 그 뒤로는 그 행의 막대를 눌러도 상세가 열리지 않는다.
   * 같은 막대의 세 버튼(시작·몸통·마감) 사이 이동은 취소가 아니다 — 같은 막대 안이면 그대로 둔다.
   * 저장 요청이 도는 중(pendingId)에도 그대로 둔다 — 끌어 놓은 자리는 판정이 올 때까지 남아야 한다.
   * 문장은 Esc와 같은 하나다(같은 일이므로 두 가지로 말하지 않는다).
   */
  const onBarBlur = (event: ReactFocusEvent<HTMLButtonElement>, item: WorkItem, stored: BarRange) => {
    if (draft?.id !== item.id || pendingId === item.id) return
    const bar = event.currentTarget.parentElement
    if (bar && event.relatedTarget instanceof Node && bar.contains(event.relatedTarget)) return
    // 이 행이 쥐고 있던 드래그만 놓는다(cancelDraft를 부르지 않는 이유).
    // 마우스로 다른 행의 막대를 누르는 순간의 순서는 pointerdown → mousedown → 포커스 이동 → blur다.
    // 여기서 dragRef를 통째로 비우면 방금 시작한 그 행의 드래그가 첫 프레임에 죽어
    // 끌어도 막대가 움직이지 않고, 놓아도 저장되지 않고, 상세조차 열리지 않는다(endDrag가 먼저 돌아간다).
    if (dragRef.current?.id === item.id) dragRef.current = null
    setDraft(null)
    followBack(stored)
    setStatus('기간 변경을 취소했습니다.')
  }

  useEffect(() => {
    // 안전망: 캡처를 쥔 요소가 어떤 이유로든(목록 갱신 등) 사라져 pointerup이 닿지 못하면
    // 드래프트가 영원히 서서 사라진 막대의 기간을 계속 읽어 준다. 창까지 올라온 pointerup에서 지운다.
    // (요소가 살아 있으면 React 루트가 먼저 endDrag를 부르고 dragRef가 이미 비어 여기서는 아무 일도 하지 않는다.)
    const stop = () => { if (dragRef.current) { dragRef.current = null; setDraft(null) } }
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => { window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop) }
  }, [])

  // 보기가 바뀌면 편집 중이던 미리보기는 버린다 — 다른 창·다른 묶음에서 살아남은 드래프트는 주인 없는 안내가 된다.
  useEffect(() => { dragRef.current = null; setDraft(null) }, [rangeId, groupBy])

  // 편집하던 행이 목록에서 사라져도 버린다(범위 필터 변경·SSE 갱신). 화면은 이 컴포넌트를 그대로 두고 items만 바꾼다 —
  // 주인이 사라진 미리보기는 Esc로도 지울 수 없다(onBarKeyDown이 그 행을 찾지 못해 먼저 돌아간다).
  useEffect(() => {
    if (draft && !items.some((item) => item.id === draft.id)) { dragRef.current = null; setDraft(null) }
  }, [items, draft])

  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>, item: WorkItem, range: BarRange, mode: BarMode) => {
    // 왼쪽 버튼만 기간을 옮긴다. 가운데 버튼으로 누른 채 밀면 실제로 저장되고(실측),
    // 오른쪽 버튼은 컨텍스트 메뉴 뒤에서 상세 드로어를 연다 — 둘 다 아무도 시킨 적 없는 조작이다.
    if (event.button !== 0) return
    const width = headRef.current?.getBoundingClientRect().width ?? 0
    const cellPx = width / Math.max(1, days.length)
    if (!cellPx) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { id: item.id, mode, originX: event.clientX, cellPx, base: range, moved: false }
  }

  const moveDrag = (event: ReactPointerEvent<HTMLButtonElement>, item: WorkItem) => {
    const drag = dragRef.current
    if (!drag) return
    const delta = event.clientX - drag.originX
    // 4px보다 적게 움직였으면 드래그가 아니라 클릭이다 — 상세가 열려야 한다.
    if (!drag.moved && Math.abs(delta) < DRAG_THRESHOLD_PX) return
    drag.moved = true
    // previewBar를 쓰는 이유: 미리보기는 저장 뒤에 남을 그 막대여야 한다(추론한 시작일은 마감을 따라 다시 계산된다).
    setDraft({ id: drag.id, mode: drag.mode, range: previewBar(item, drag.base, drag.mode, Math.round(delta / drag.cellPx)) })
  }

  const endDrag = (item: WorkItem) => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    const next = drag.moved && draft?.id === item.id ? draft.range : null
    // 문턱(4px)은 넘었어도 반 칸을 못 넘었으면 하루도 옮기지 않은 것이다.
    // 그대로 commit하면 서버는 무쓰기 200을 주고 화면은 '바꿨습니다'라고 읽어 준다 — 바뀐 것이 없는데.
    if (!next || (next.startKey === drag.base.startKey && next.endKey === drag.base.endKey)) {
      setDraft(null)
      // 상세는 몸통을 눌렀을 때만 열린다. 손잡이를 그냥 한 번 누르는 것은 '←/→로 밀려고 잡는' 동작이고,
      // 거기서 드로어가 열리면 포커스가 대화상자로 끌려가 방금 잡은 그 막대가 뒤로 닫힌다.
      if (drag.mode === 'move') onOpen(item.id)
      return
    }
    void commit(item, next)
  }

  const onBarKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, item: WorkItem, range: BarRange, mode: BarMode, blocked: string) => {
    const current = draft?.id === item.id ? draft : null
    // 마우스로 끄는 중에도 이 키가 온다(브라우저는 mousedown에서 버튼에 포커스를 준다). 그래서 두 갈래 모두
    // 미리보기보다 먼저 드래그부터 끝낸다 — dragRef를 남기면 '취소했습니다'라고 읽어 준 뒤
    // 다음 pointermove가 미리보기를 되살리고 pointerup이 그대로 저장하거나(Esc),
    // Enter가 저장한 위에 pointerup이 두 번째 저장을 덮어쓴다(한 동작에 두 번의 쓰기).
    if (event.key === 'Escape') {
      const dragging = Boolean(dragRef.current)
      dragRef.current = null
      // 문턱(4px) 전에 눌렀으면 미리보기가 없다 — 되돌린 것이 없으므로 되돌렸다고 말하지 않는다.
      if (!current) { if (dragging) event.preventDefault(); return }
      event.preventDefault()
      setDraft(null)
      followBack(range)
      setStatus('기간 변경을 취소했습니다.')
      return
    }
    // Space도 Enter와 같이 답한다. 막대 몸통은 진짜 <button>이라 Space는 클릭을 만들어 내는데,
    // 그 클릭은 편집 가능한 표면에서 onClick의 문지기에 걸려 아무 일도 하지 않았다 —
    // 같은 컨트롤이 좁은 화면에서는 열리고 넓은 화면에서는 조용히 무시하는 화면이 됐다.
    // preventDefault가 이 갈래의 첫 문장이라 그 합성 클릭과 페이지 스크롤도 함께 막힌다.
    if (event.key === 'Enter' || event.key === ' ') {
      // 미리보기가 서 있으면 저장, 없으면 상세 열기 — 같은 키가 화면 상태에 따라 한 가지 일만 한다.
      event.preventDefault()
      dragRef.current = null
      if (current) void commit(item, current.range)
      else if (mode === 'move') onOpen(item.id)
      return
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    // 못 바꾸는 막대에서도 이유는 말한다 — title은 마우스에게만 보인다. 문장은 scheduleBlockReason 한 곳에서 나온다.
    if (blocked || !onSchedule) { if (blocked) setStatus(blocked); return }
    event.preventDefault()
    const base = current?.range ?? range
    const step = (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 7 : 1)
    const next = previewBar(item, base, mode, step)
    // 아무것도 움직이지 않았다면 그 이유는 하나뿐이다: 사람이 정한 시작일과 마감이 서로를 막았다.
    // 시작일 미정 막대는 여기서 문장을 얻지 못한다 — 그 막대의 왼쪽 끝은 값이 아니어서
    // '시작일은 마감일보다 뒤일 수 없습니다'는 화면이 스스로 '미정'이라 적은 날짜를 근거로 대는 말이 된다.
    if (next.startKey === base.startKey && next.endKey === base.endKey) { if (!base.startUnset) setStatus(SCHEDULE_ORDER_HINT); return }
    // 창이 막대를 따라간다(설계 F2.5). 막대가 창 밖으로 나가 언마운트되면 Enter·Esc가 닿을 곳을 잃는다.
    const anchor = followAnchor(next, days)
    if (anchor) setAnchorKey(anchor)
    setStatus('')
    setDraft({ id: item.id, mode, range: next })
  }

  const renderRow = (item: WorkItem, indented: boolean) => {
    const stored = ranges.get(item.id)
    if (!stored) return null
    const isDraft = draft?.id === item.id
    const range = isDraft ? draft.range : stored
    // 편집 중인 막대는 창 밖으로 나가도 그린다(창 끝 한 칸). 언마운트되면 pointerup·Enter·Esc가 갈 곳을 잃는다.
    const box = isDraft ? clampBarEdge(range, days) : clampBar(range, days)
    const blocked = scheduleBlockReason(item, currentUserId, canAssignTasks)
    const keyEditable = !blocked && Boolean(onSchedule)
    // 좁은 화면·터치에서는 손잡이와 포인터 조작만 사라진다. 막대·오늘 선·묶음은 그대로 보인다.
    const dragEnabled = keyEditable && !coarse
    const showParent = isSubtask(item) && !indented
    const barClass = [
      'work-timeline-bar', `tone-${barTone(item)}`,
      range.startUnset ? 'is-assumed' : '',
      isDraft ? 'is-draft' : '',
      pendingId === item.id ? 'is-pending' : '',
      blocked ? 'is-locked' : '',
      box?.clippedStart ? 'is-clipped-start' : '',
      box?.clippedEnd ? 'is-clipped-end' : '',
    ].filter(Boolean).join(' ')
    const pointerProps = dragEnabled ? {
      onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => moveDrag(event, item),
      onPointerUp: () => endDrag(item),
      onPointerCancel: cancelDrag,
      onLostPointerCapture: cancelDrag,
    } : {}
    return <Fragment key={item.id}>
      <div className={`work-timeline-name${indented ? ' is-child' : ''}`}>
        <StatusBadge className="status-pill" dot tone={workStatusTone(item.status)}>{workStatusLabel(item.status)}</StatusBadge>
        <button type="button" className="work-timeline-open" aria-haspopup="dialog" onClick={() => onOpen(item.id)}><strong title={item.title}>{item.title}</strong></button>
        {showParent && <ParentChip title={parentTitleOf(item, allItems, parentRefs)} />}
      </div>
      {box
        ? <div className="work-timeline-track">
          <div className={barClass} style={{ gridColumnStart: box.from + 1, gridColumnEnd: `span ${box.span}` }} aria-busy={pendingId === item.id || undefined}>
            {dragEnabled && !range.startUnset && <button
              type="button"
              className="work-timeline-handle is-start"
              aria-label={`${item.title} 시작일 조정`}
              aria-keyshortcuts={KEY_SHORTCUTS}
              aria-describedby="work-timeline-help"
              onPointerDown={(event) => startDrag(event, item, range, 'start')}
              onKeyDown={(event) => onBarKeyDown(event, item, stored, 'start', blocked)}
              onBlur={(event) => onBarBlur(event, item, stored)}
              {...pointerProps}
            />}
            <button
              type="button"
              className="work-timeline-bar-body"
              aria-label={barAriaLabel(item, range)}
              aria-keyshortcuts={KEY_SHORTCUTS}
              aria-describedby="work-timeline-help"
              title={blocked || undefined}
              // 이 행에 미리보기가 서 있을 때만 클릭을 삼킨다(그때는 Enter가 저장, Esc가 취소다).
              // 컴포넌트 전체의 draft를 보면 한 행의 편집이 나머지 모든 행의 상세 열기를 막는다 —
              // 손잡이가 없는 표면(좁은 화면·터치)에서는 그것이 유일한 길이다.
              onClick={() => { if (!dragEnabled && draft?.id !== item.id) onOpen(item.id) }}
              onPointerDown={dragEnabled ? (event) => startDrag(event, item, range, 'move') : undefined}
              onKeyDown={(event) => onBarKeyDown(event, item, stored, 'move', blocked)}
              onBlur={(event) => onBarBlur(event, item, stored)}
              {...pointerProps}
            />
            {dragEnabled && <button
              type="button"
              className="work-timeline-handle is-end"
              aria-label={`${item.title} 마감일 조정`}
              aria-keyshortcuts={KEY_SHORTCUTS}
              aria-describedby="work-timeline-help"
              onPointerDown={(event) => startDrag(event, item, range, 'end')}
              onKeyDown={(event) => onBarKeyDown(event, item, stored, 'end', blocked)}
              onBlur={(event) => onBarBlur(event, item, stored)}
              {...pointerProps}
            />}
          </div>
        </div>
        : <span className="work-timeline-offscreen">{range.endKey < days[0] ? '이 기간 이전' : '이 기간 이후'} · {barDayLabel(range.endKey)} 마감</span>}
    </Fragment>
  }

  // 창을 옮기는 세 조작(이전·다음·오늘/그 주로)은 '지금 이 편집은 그만'이라는 뜻이다 — 미리보기를 함께 접는다.
  const panBy = (days: number) => { cancelDraft(); setAnchorKey((current) => shiftDateKey(current, days)) }
  const jumpTo = (dateKey: string) => { cancelDraft(); setAnchorKey(shiftDateKey(dateKey, -TIMELINE_LEAD_DAYS)) }

  return <section className="work-timeline" aria-label="업무 기간 타임라인">
    <div className="work-timeline-controls">
      <div className="segmented" role="group" aria-label="타임라인 묶음 기준">
        <button type="button" aria-pressed={groupBy === 'owner'} onClick={() => setGroupBy('owner')}>담당자별</button>
        <button type="button" aria-pressed={groupBy === 'project'} onClick={() => setGroupBy('project')}>프로젝트별</button>
      </div>
      <div className="segmented" role="group" aria-label="보이는 기간">
        {TIMELINE_RANGES.map((range) => <button type="button" key={range.id} aria-pressed={rangeId === range.id} onClick={() => setRangeId(range.id)}>{range.label}</button>)}
      </div>
      <IconButton tone="quiet" size="sm" aria-label="이전 기간" onClick={() => panBy(-days.length)}><ChevronLeft size={17} /></IconButton>
      <IconButton tone="quiet" size="sm" aria-label="다음 기간" onClick={() => panBy(days.length)}><ChevronRight size={17} /></IconButton>
      <Button tone="quiet" size="sm" type="button" onClick={() => jumpTo(todayKey)}>오늘</Button>
      <p className="work-timeline-readout" role="status" aria-live="polite">{draft && draftItem ? barDraftReadout(draftItem, draft.range) : windowLabel}</p>
    </div>
    <p className="work-timeline-help" id="work-timeline-help">
      막대에서 <b>←</b>·<b>→</b>로 하루씩, <b>Shift</b>와 함께 누르면 일주일씩 옮깁니다. <b>Enter</b>로 저장, <b>Esc</b>로 되돌립니다.
      기간은 지시한 사람과 관리자만 바꿀 수 있습니다.
    </p>

    {visible.length > 0 && <div className="work-timeline-scroll">
      <div className="work-timeline-grid" style={{ '--timeline-days': days.length } as CSSProperties}>
        <span className="work-timeline-corner" />
        <div className="work-timeline-head" ref={headRef}>
          {days.map((key, index) => <span
            className={`work-timeline-tick kind-${dayKind(key)}${key === todayKey ? ' is-today' : ''}`}
            key={key}
            title={holidayName(key) ?? undefined}
          >
            {(index === 0 || key.slice(8, 10) === '01') && <em>{Number(key.slice(5, 7))}월</em>}
            <b>{Number(key.slice(8, 10))}</b>
          </span>)}
        </div>
        <div className="work-timeline-rule" aria-hidden="true">
          {days.map((key) => <i className={`work-timeline-day kind-${dayKind(key)}`} key={key} />)}
          {todayIndex >= 0 && <span className="work-timeline-now" style={{ left: `calc(var(--timeline-cell) * ${todayIndex})` }} />}
        </div>
        {groups.map((group) => <Fragment key={`${groupBy}-${group.key}`}>
          {/* 제목이 아니라 그 안의 span이 왼쪽에 붙는다 — h3은 행 전체를 덮어야 붙을 자리가 캔버스 폭만큼 넓다.
              담당자별로 볼 때 그 사람 이름은 이 줄에만 있으므로, 가로로 밀면 사라지는 이름이어서는 안 된다. */}
          <h3 className="work-timeline-group"><span>{group.label} <small>{group.rows.length}건</small></span></h3>
          {group.rows.map((item) => renderRow(item, groupBy === 'project' && isSubtask(item) && group.rows.some((row) => row.id === item.parentId)))}
        </Fragment>)}
      </div>
    </div>}

    {items.length === 0 && <div className="empty-state">
      <CalendarClock size={30} />
      {/* 제목도 본문과 같은 축으로 가른다 — 조건이 하나도 없는 화면에서 '이 조건에 맞는'은 있지도 않은 조건을 가리킨다. */}
      <h3>{filtered ? WORK_EMPTY_FILTERED_TITLE : '아직 기간이 있는 업무가 없습니다'}</h3>
      {/* 넓힐 범위가 있을 때만 넓히라고 한다 — 전체 범위에서 0건인 사람에게 '범위를 넓히면'은
          화면에 없는 버튼을 가리키는 말이 된다. 지우기 버튼과 같은 조건을 본다. */}
      {filtered
        ? <p>{WORK_EMPTY_FILTERED_HINT}</p>
        : <p>업무를 지시하면 여기에 기간 막대로 나타납니다.</p>}
      {filtered && onClearFilter && <Button tone="quiet" size="sm" type="button" onClick={onClearFilter}>필터 지우기</Button>}
    </div>}
    {items.length > 0 && visible.length === 0 && <div className="empty-state">
      <CalendarClock size={30} />
      <h3>이 기간에 걸치는 업무가 없습니다</h3>
      {nearest
        ? <>
          <p>가장 가까운 업무는 {barDayLabel(nearest.range.endKey)}에 있습니다.</p>
          <Button tone="secondary" size="sm" type="button" onClick={() => jumpTo(nearest.range.startKey)}>그 주로 이동</Button>
        </>
        : <p>마감이 정해진 업무가 아직 없습니다.</p>}
    </div>}

    {undated.length > 0 && <details className="work-timeline-undated">
      <summary>기간 없는 업무 {undated.length}건</summary>
      <ul>
        {undated.map((item) => <li key={item.id}>
          <StatusBadge className="status-pill" dot tone={workStatusTone(item.status)}>{workStatusLabel(item.status)}</StatusBadge>
          <strong title={item.title}>{item.title}</strong>
          <Button tone="quiet" size="sm" type="button" onClick={() => onOpen(item.id)}>기간 정하기</Button>
        </li>)}
      </ul>
    </details>}

    <p className="sr-only" role="status" aria-live="polite" id="work-timeline-status">{status}</p>
  </section>
}

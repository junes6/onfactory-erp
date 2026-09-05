import { Bell, CalendarDays, ChevronDown, ChevronRight, ClipboardList, FileText, Home, ListChecks, MessageCircle, MoreHorizontal, Settings2, Timer, X } from 'lucide-react'
import type { WorkItem } from '../domainData'
import { Button } from './ui/Button'
import { ParentChip, SubtaskRows } from './SubtaskList'
import { workStatusLabel } from '../utils/workStatus'
import { childrenOf, isSubtask, isTopLevelIn, parentTitleOf, progressLabel, subtaskProgress, type ParentRef } from '../utils/workTree'

/**
 * 휴대폰 화면.
 *
 * 데스크톱 메뉴를 그대로 줄이면 열여덟 갈래가 햄버거 안에 숨는다. 손에 들고
 * 쓰는 화면에서는 그날 할 일이 바로 보여야 하므로, 아래 네 칸으로 줄이고
 * 나머지는 "더보기"에 넣는다.
 *
 * 처음 들어오는 곳은 채팅이다. 현장에서 앱을 여는 이유가 대개 "누가 뭐라고
 * 했나"이기 때문이다.
 */

export type MobileTab = 'today' | 'tasks' | 'chat' | 'more'

export const MOBILE_TABS: { id: MobileTab; label: string; icon: typeof Home }[] = [
  { id: 'today', label: '오늘', icon: Home },
  { id: 'tasks', label: '업무', icon: ListChecks },
  { id: 'chat', label: '채팅', icon: MessageCircle },
  { id: 'more', label: '더보기', icon: MoreHorizontal },
]

/** 오늘 화면에 올리는 업무 수. 더 많으면 목록을 훑게 되고, 그러면 "오늘"이 아니다. */
export const TODAY_TASK_LIMIT = 5

export function MobileTabBar({ active, onChange, taskCount, chatUnread, alertCount }: {
  active: MobileTab
  onChange: (tab: MobileTab) => void
  taskCount: number
  chatUnread: number
  alertCount: number
}) {
  const badgeFor = (tab: MobileTab) => (tab === 'tasks' ? taskCount : tab === 'chat' ? chatUnread : tab === 'more' ? 0 : alertCount)
  return (
    <nav className="mobile-tabbar" aria-label="주요 화면">
      {MOBILE_TABS.map((tab) => {
        const Icon = tab.icon
        const badge = badgeFor(tab.id)
        return (
          <button
            key={tab.id}
            type="button"
            className={active === tab.id ? 'is-active' : undefined}
            aria-current={active === tab.id ? 'page' : undefined}
            onClick={() => onChange(tab.id)}
          >
            <span className="mobile-tab-icon">
              <Icon size={22} />
              {badge > 0 && <em aria-hidden="true">{badge > 99 ? '99+' : badge}</em>}
            </span>
            <span className="mobile-tab-label">{tab.label}</span>
            {badge > 0 && <span className="sr-only">{`알림 ${badge}건`}</span>}
          </button>
        )
      })}
    </nav>
  )
}

/** 상태마다 다음 행동은 하나뿐이다. 그 하나만 버튼으로 낸다. */
export function nextActionLabel(status: WorkItem['status']) {
  if (status === '업무요청') return '착수'
  if (status === '수행중') return '완료 보고'
  if (status === '결재대기') return '결재 보기'
  return '보기'
}

export function MobileToday({ tasks, allTasks, events, alerts, userName, onOpenTask, onGoTasks, onOpenAlerts }: {
  tasks: WorkItem[]
  /** 진행률·건수를 셀 때 쓰는 전체 목록. tasks는 이미 최상위만 남겨 자식이 빠져 있다. */
  allTasks?: WorkItem[]
  events: { id: string; title: string; date: string; owner?: string }[]
  alerts: { id: string; title: string; createdAt?: string }[]
  userName: string
  onOpenTask: (task: WorkItem) => void
  onGoTasks: () => void
  onOpenAlerts: () => void
}) {
  const shown = tasks.slice(0, TODAY_TASK_LIMIT)
  // 제목의 건수는 자식까지 센다 — 목록에서 접었다고 맡은 일이 줄지는 않는다.
  const openCount = (allTasks ?? tasks).filter((task) => task.status !== '결재완료').length
  // 버튼이 말하는 '나머지'는 5줄 제한이 자른 줄이다. 접힌 자식까지 세면 다 보이는 화면에서도 '나머지 1건 보기'가 뜬다.
  const hidden = Math.max(0, tasks.length - shown.length)
  return (
    <div className="mobile-today">
      <h1 className="mobile-today-greeting">{userName}님, 오늘 할 일입니다</h1>

      <section className="mobile-card" aria-label="오늘 업무">
        <h2><ListChecks size={17} /> 내 업무 {openCount}건</h2>
        {shown.length === 0 && <p className="mobile-empty">지금 맡은 업무가 없습니다.</p>}
        <ul className="mobile-line-list">
          {shown.map((task) => {
            const progress = subtaskProgress(allTasks ?? tasks, task.id)
            return <li key={task.id}>
              <button type="button" className="mobile-line-open" onClick={() => onOpenTask(task)}>
                <strong>{task.title}</strong>
                <small>{workStatusLabel(task.status)} · {task.due ? task.due.slice(5, 10).replace('-', '.') : '기한 없음'}{progress ? ` · ${progressLabel(progress)}` : ''}</small>
              </button>
              <ChevronRight size={18} aria-hidden="true" />
            </li>
          })}
        </ul>
        {hidden > 0 && <Button tone="quiet" size="sm" full onClick={onGoTasks}>나머지 {hidden}건 보기</Button>}
      </section>

      <section className="mobile-card" aria-label="오늘 일정">
        <h2><CalendarDays size={17} /> 오늘 일정 {events.length}건</h2>
        {events.length === 0 && <p className="mobile-empty">오늘 공유 일정이 없습니다.</p>}
        <ul className="mobile-line-list">
          {events.slice(0, 5).map((event) => (
            <li key={event.id}>
              <span className="mobile-line-open">
                <strong>{event.title}</strong>
                <small>{event.date.slice(11, 16) || '종일'}{event.owner ? ` · ${event.owner}` : ''}</small>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mobile-card" aria-label="알림">
        <h2><Bell size={17} /> 알림 {alerts.length}건</h2>
        {alerts.length === 0 && <p className="mobile-empty">읽지 않은 알림이 없습니다.</p>}
        <ul className="mobile-line-list">
          {alerts.slice(0, 3).map((alert) => (
            <li key={alert.id}><span className="mobile-line-open"><strong>{alert.title}</strong></span></li>
          ))}
        </ul>
        {alerts.length > 0 && <Button tone="quiet" size="sm" full onClick={onOpenAlerts}>알림 모두 보기</Button>}
      </section>
    </div>
  )
}

/**
 * 업무 한 줄 목록.
 *
 * 한 행에 제목·상태·기한만 두고 버튼은 하나다. 손가락으로 누르는 화면에서
 * 행마다 버튼이 서넛이면 어느 것을 눌렀는지 모른 채 눌리게 된다.
 */
export function MobileTaskList({ tasks, parentRefs, onAdvance, onOpenTask, busyId }: {
  tasks: WorkItem[]
  /** 상위가 목록 밖에 있는 자식에게 붙일 제목(서버 응답 봉투). */
  parentRefs?: Record<string, ParentRef>
  onAdvance: (task: WorkItem) => void
  onOpenTask: (task: WorkItem) => void
  busyId?: string
}) {
  // 목록에는 상위만 한 줄로 세우고, 자식은 그 아래 접힌 채로 둔다.
  const ids = new Set(tasks.map((task) => task.id))
  const openTotal = tasks.filter((task) => task.status !== '결재완료').length
  // 진행 중 목록에서 접는 기준은 '진행 중인 상위'다. 끝난 상위 아래 남은 자식까지 접으면
  // 그 자식은 '끝난 업무' 안에서만 닿을 수 있게 되어, 제목은 '업무 1건'인데 목록은 비어 보인다.
  const openIds = new Set(tasks.filter((task) => task.status !== '결재완료').map((task) => task.id))
  const open = tasks.filter((task) => task.status !== '결재완료' && isTopLevelIn(task, openIds))
  const done = tasks.filter((task) => task.status === '결재완료' && isTopLevelIn(task, ids))
  // 끌어올린 자식은 상위 행 안에서 또 그리지 않는다 — 한 업무가 한 화면에 두 줄이 되면 어느 쪽을 눌러야 하는지 모른다.
  const promoted = new Set(open.map((task) => task.id))
  /**
   * 한 줄. 최상위로 올릴지 정한 집합(foldIds)을 그대로 받아서 상위 칩도 같은 집합으로 판정한다 —
   * 두 집합이 다르면 상위가 끝나서 최상위로 올라온 자식이 칩 없이 독립 업무처럼 보인다.
   */
  const row = (task: WorkItem, foldIds: Set<string>) => {
    const children = childrenOf(tasks, task.id).filter((child) => !promoted.has(child.id))
    const progress = subtaskProgress(tasks, task.id)
    return <li key={task.id} className={progress ? 'has-children' : undefined}>
      <button type="button" className="mobile-line-open" onClick={() => onOpenTask(task)}>
        <strong>{task.title}</strong>
        <small>{workStatusLabel(task.status)} · {task.owner} · {task.due ? task.due.slice(5, 10).replace('-', '.') : '기한 없음'}{progress ? ` · ${progressLabel(progress)}` : ''}</small>
        {isSubtask(task) && !foldIds.has(task.parentId) && <ParentChip title={parentTitleOf(task, tasks, parentRefs)} />}
      </button>
      {task.status !== '결재완료' && (
        <Button tone="secondary" size="sm" disabled={busyId === task.id} onClick={() => onAdvance(task)}>
          {nextActionLabel(task.status)}
        </Button>
      )}
      {progress && <details className="mobile-line-children">
        <summary><ChevronDown size={14} /> {progressLabel(progress)}</summary>
        {children.length > 0 && <SubtaskRows items={children} onOpen={onOpenTask} actionFor={(child) => child.status === '결재완료' ? null : { label: nextActionLabel(child.status), run: () => onAdvance(child) }} busyId={busyId} />}
        {/* 센 것과 그린 것이 다르면 그 차이를 말한다 — 끝난 상위 아래 남은 자식은 위쪽에 한 줄로 올라가 있다. */}
        {progress.total > children.length && <p className="workflow-subtask-note">하위 업무 {progress.total - children.length}건은 이 목록 위쪽에 한 줄로 나와 있습니다.</p>}
      </details>}
    </li>
  }
  return (
    <div className="mobile-task-page">
      {/* 줄은 상위만 세우지만 건수는 자식까지 센다 — '업무 1건'이라고 말해 놓고 안에 세 건이 있으면 안 된다. */}
      <h1 className="mobile-page-title">업무 {openTotal}건</h1>
      {open.length === 0 && <p className="mobile-empty">진행 중인 업무가 없습니다.</p>}
      <ul className="mobile-line-list">{open.map((task) => row(task, openIds))}</ul>
      {done.length > 0 && (
        <details className="mobile-done">
          <summary>끝난 업무 {done.length}건</summary>
          <ul className="mobile-line-list">{done.slice(0, 20).map((task) => row(task, ids))}</ul>
        </details>
      )}
    </div>
  )
}

/**
 * 더보기.
 *
 * 네 가지만 둔다. 휴대폰에서 재고를 조정하거나 공장 도면을 편집하는 일은
 * 실제로 일어나지 않고, 관리자 화면을 작은 화면에 욱여넣으면 잘못 누르기만 한다.
 */
export const MOBILE_MORE_ITEMS: { id: string; label: string; hint: string; icon: typeof FileText }[] = [
  { id: 'journal', label: '일일업무일지', hint: '오늘 한 일을 적습니다', icon: ClipboardList },
  { id: 'people', label: '근태', hint: '출퇴근과 휴가를 봅니다', icon: Timer },
  { id: 'documents', label: '자료실', hint: '회사 문서를 찾습니다', icon: FileText },
  { id: 'settings', label: '설정', hint: '알림과 계정을 바꿉니다', icon: Settings2 },
]

export function MobileMoreSheet({ open, onClose, onPick, userName, userRole }: {
  open: boolean
  onClose: () => void
  onPick: (id: string) => void
  userName: string
  userRole: string
}) {
  if (!open) return null
  return (
    <div className="mobile-sheet" role="dialog" aria-modal="true" aria-label="더보기">
      <div className="mobile-sheet-head">
        <div><strong>{userName}</strong><small>{userRole}</small></div>
        <button type="button" className="mobile-sheet-close" aria-label="더보기 닫기" onClick={onClose}><X size={22} /></button>
      </div>
      <ul className="mobile-sheet-list">
        {MOBILE_MORE_ITEMS.map((item) => {
          const Icon = item.icon
          return (
            <li key={item.id}>
              <button type="button" onClick={() => onPick(item.id)}>
                <span className="mobile-sheet-icon"><Icon size={20} /></span>
                <span className="mobile-sheet-copy"><strong>{item.label}</strong><small>{item.hint}</small></span>
                <ChevronRight size={18} aria-hidden="true" />
              </button>
            </li>
          )
        })}
      </ul>
      <p className="mobile-sheet-note">관리 화면은 컴퓨터에서 열어 주세요. 작은 화면에서 잘못 눌러 생기는 사고를 막기 위해 숨겨 두었습니다.</p>
      <div className="mobile-sheet-spacer" aria-hidden="true" />
    </div>
  )
}

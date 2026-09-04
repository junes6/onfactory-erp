import { Bell, CalendarDays, ChevronRight, ClipboardList, FileText, Home, ListChecks, MessageCircle, MoreHorizontal, Settings2, Timer, X } from 'lucide-react'
import type { WorkItem } from '../domainData'
import { Button } from './ui/Button'

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

export function MobileToday({ tasks, events, alerts, userName, onOpenTask, onGoTasks, onOpenAlerts }: {
  tasks: WorkItem[]
  events: { id: string; title: string; date: string; owner?: string }[]
  alerts: { id: string; title: string; createdAt?: string }[]
  userName: string
  onOpenTask: (task: WorkItem) => void
  onGoTasks: () => void
  onOpenAlerts: () => void
}) {
  const shown = tasks.slice(0, TODAY_TASK_LIMIT)
  const hidden = Math.max(0, tasks.length - shown.length)
  return (
    <div className="mobile-today">
      <h1 className="mobile-today-greeting">{userName}님, 오늘 할 일입니다</h1>

      <section className="mobile-card" aria-label="오늘 업무">
        <h2><ListChecks size={17} /> 내 업무 {tasks.length}건</h2>
        {shown.length === 0 && <p className="mobile-empty">지금 맡은 업무가 없습니다.</p>}
        <ul className="mobile-line-list">
          {shown.map((task) => (
            <li key={task.id}>
              <button type="button" className="mobile-line-open" onClick={() => onOpenTask(task)}>
                <strong>{task.title}</strong>
                <small>{task.status} · {task.due ? task.due.slice(5, 10).replace('-', '.') : '기한 없음'}</small>
              </button>
              <ChevronRight size={18} aria-hidden="true" />
            </li>
          ))}
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
export function MobileTaskList({ tasks, onAdvance, onOpenTask, busyId }: {
  tasks: WorkItem[]
  onAdvance: (task: WorkItem) => void
  onOpenTask: (task: WorkItem) => void
  busyId?: string
}) {
  const open = tasks.filter((task) => task.status !== '결재완료')
  const done = tasks.filter((task) => task.status === '결재완료')
  const row = (task: WorkItem) => (
    <li key={task.id}>
      <button type="button" className="mobile-line-open" onClick={() => onOpenTask(task)}>
        <strong>{task.title}</strong>
        <small>{task.status} · {task.owner} · {task.due ? task.due.slice(5, 10).replace('-', '.') : '기한 없음'}</small>
      </button>
      {task.status !== '결재완료' && (
        <Button tone="secondary" size="sm" disabled={busyId === task.id} onClick={() => onAdvance(task)}>
          {nextActionLabel(task.status)}
        </Button>
      )}
    </li>
  )
  return (
    <div className="mobile-task-page">
      <h1 className="mobile-page-title">업무 {open.length}건</h1>
      {open.length === 0 && <p className="mobile-empty">진행 중인 업무가 없습니다.</p>}
      <ul className="mobile-line-list">{open.map(row)}</ul>
      {done.length > 0 && (
        <details className="mobile-done">
          <summary>끝난 업무 {done.length}건</summary>
          <ul className="mobile-line-list">{done.slice(0, 20).map(row)}</ul>
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

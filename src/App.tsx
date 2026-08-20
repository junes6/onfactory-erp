import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  AlertTriangle, ArrowDownToLine, ArrowRight, ArrowUpFromLine, BarChart3, Boxes, Building2, Check,
  CalendarDays, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, ClipboardCheck, Clock3,
  Database, Factory, FileClock, FileText, Headphones, Home, Layers3, ListChecks, LockKeyhole, Menu,
  NotebookPen, Package, Paperclip, PauseCircle, PlayCircle, Plus, Repeat2, Search, Settings2, ShieldCheck, ShoppingCart,
  Sparkles, Store, Upload, Users, Warehouse, X, GripVertical, EyeOff, RotateCcw,
} from 'lucide-react'
import AIChat from './components/AIChat'
import { ChatBubbleIcon, NotificationBellIcon, OnFactoryMark } from './components/AppIcons'
import { LoginPage, PasswordChangePage, SettingsDrawer, type DensityChoice, type FontChoice, type ThemeChoice } from './components/AccessExperience'
import { ProductManagement, SalesChannels } from './components/BusinessPages'
import { CompanyLibrary } from './components/CompanyLibrary'
import { DailyJournalPage, MessengerDrawer, SchedulePage } from './components/CollaborationSuite'
import { ComplianceCenter } from './components/ComplianceCenter'
import {
  DashboardLayoutButton, QuickLinksWidget, defaultDashboardWidgets,
  useDashboardPreferences, widgetClass, type DashboardWidgetPreference,
} from './components/DashboardWorkspace'
import { FactoryManagement } from './components/FactoryManagement'
import './components/InventoryEnhancements.css'
import { PeopleOperationsPage } from './components/PeopleOperations'
import PlatformConsole, { type PlatformSection } from './components/PlatformConsole'
import { WorkspaceNavigationEditButton, WorkspaceNavigationEditor, usePersonalNavigation } from './components/WorkspaceNavigation'
import { useWorkspaceState } from './hooks/useWorkspaceState'
import { deleteDocumentAttachment, deleteDocumentAttachments } from './utils/documentAttachments'
import {
  channelMetrics, initialWorkItems, initialWorkRules, seaProducts,
  type Tenant, type WorkEvidence, type WorkItem, type WorkRule,
} from './domainData'

type TenantPage = 'ai' | 'schedule' | 'tasks' | 'journal' | 'products' | 'inventory' | 'factory' | 'sales' | 'people' | 'documents' | 'compliance'
type PageId = TenantPage | PlatformSection
type AppMode = 'tenant' | 'platform'
type NavItem = { id: PageId; label: string; icon: typeof Sparkles; badge?: number }
type AuthAccount = { id: string; name: string; email: string; role: 'tenant-admin' | 'tenant-member' | 'platform-operator'; tenantId: string | null; tenantName: string | null; approved: boolean; team?: string; jobRole?: string; requiresPasswordChange?: boolean }
type AuthStatus = 'checking' | 'signed-out' | 'signed-in'
type PlatformTicketSummary = { id: string; tenantId: string; tenant: string; title: string; priority: string; status: string; sla: string; owner: string }
type PlatformDirectoryState = { tenants: Tenant[]; supportTickets: PlatformTicketSummary[] }
type SupportSessionRequest = { tenantId: string; ticketId: string; scope: string; duration: string; reason: string }

const tenantMemberPages = new Set<PageId>(['ai', 'schedule', 'tasks', 'journal', 'products', 'inventory', 'factory', 'people', 'documents', 'compliance'])
const SUNSEA_TENANT_ID = 'TENANT-SUNSEA'
const AUTH_SYNC_KEY = 'onfactory-auth-sync'
const emptyWorkItems: WorkItem[] = []
const emptyWorkRules: WorkRule[] = []
const emptyInventoryLocations: WarehouseLocation[] = []

function sessionIdentity(account: AuthAccount) {
  return `${account.tenantId ?? 'platform'}:${account.id}:${account.role}`
}

function publishSessionChange(identity: string | null) {
  try {
    window.localStorage.setItem(AUTH_SYNC_KEY, JSON.stringify({ identity, changedAt: Date.now() }))
  } catch { /* cross-tab sync is an additional safety layer */ }
}

function isSunseaFixtureWorkItem(item: WorkItem) {
  return Boolean(initialWorkItems.find((fixture) => fixture.id === item.id && fixture.title === item.title))
    || item.ownerId?.startsWith('USR-SUNSEA-')
    || item.requesterId?.startsWith('USR-SUNSEA-')
}

const people = [
  { name: '김서원', role: '운영 관리자', team: '경영지원', shift: '주간', work: 'G마켓 SKU 확인', state: '업무중' },
  { name: '박지현', role: '품질 책임자', team: '품질관리', shift: '주간', work: '멍게젓 표시사항 검토', state: '확인중' },
  { name: '오태식', role: '생산 반장', team: '생산 1팀', shift: '주간', work: '내일 생산계획 확정', state: '업무중' },
  { name: '서동현', role: '재고 담당', team: '물류팀', shift: '주간', work: '냉장 2창고 FEFO 피킹', state: '업무중' },
  { name: '윤서진', role: '온라인 MD', team: '판매운영', shift: '주간', work: '채널별 상품정보 확인', state: '완료' },
]

type WarehouseLocation = { id: string; name: string; type: string; temperature: string; condition: string; items: string; utilization: number; alert: string }
type InventoryMovement = {
  id: string
  direction: '입고' | '출고' | '재고조정'
  product: string
  lot: string
  quantity: number
  unit: string
  warehouseId: string
  occurredAt: string
  reason: string
  evidence?: string
  evidenceId?: string
}

type WarehouseLotSummary = {
  key: string
  product: string
  lot: string
  quantity: number | null
  unreconciledDelta: number
  unit: string
  lastDirection: InventoryMovement['direction']
  lastAt: string
  movementCount: number
}

const initialInventoryLocations: WarehouseLocation[] = [
  { id: 'WH-C01', name: '냉장 1창고', type: '냉장', temperature: '3.1℃', condition: '3.1℃ · 정상', items: '젓갈류 202개', utilization: 74, alert: '멍게젓 안전재고 이하' },
  { id: 'WH-R01', name: '실온 원료창고', type: '실온', temperature: '22.4℃', condition: '22.4℃ · 정상', items: '원재료 1,840kg', utilization: 61, alert: '이상 없음' },
  { id: 'WH-F01', name: '완제품 창고', type: '실온', temperature: '19.8℃', condition: '19.8℃ · 정상', items: '완제품 5,068개', utilization: 82, alert: '선물세트 피킹 예정' },
  { id: 'WH-FZ2', name: '냉동 2창고', type: '냉동', temperature: '-19.2℃', condition: '-19.2℃ · 정상', items: '냉동제품 180개', utilization: 48, alert: '볶음밥 출고가능 0개' },
]

const initialInventoryMovements: InventoryMovement[] = [
  { id: 'MOV-260819-004', direction: '출고', product: '멍게젓 400g', lot: 'LOT-MG-0812', quantity: 24, unit: 'EA', warehouseId: 'WH-C01', occurredAt: '2026-08-19 10:20', reason: '네이버 오늘 출고' },
  { id: 'MOV-260819-003', direction: '입고', product: '국내산 냉동 멍게', lot: 'LOT-RAW-0819', quantity: 180, unit: 'KG', warehouseId: 'WH-R01', occurredAt: '2026-08-19 09:10', reason: '원료 검수 완료', evidence: '입고검수서_0819.pdf' },
]

function isSunseaFixtureWarehouse(location: WarehouseLocation) {
  return Boolean(initialInventoryLocations.find((fixture) => fixture.id === location.id && fixture.name === location.name && fixture.items === location.items))
}

const pageTitles: Record<PageId, string> = {
  ai: 'AI 업무허브', schedule: '일정관리', tasks: '업무지시 · 결재', journal: '일일업무일지',
  products: '제품관리', inventory: '재고 · LOT', factory: '공장관리',
  sales: '판매채널', people: '인사 · 조직', documents: '기업 자료실', compliance: '식품안전 · 인증',
  platform: '플랫폼 운영 개요', tenants: '고객사 관리', support: 'CS 지원센터',
  integrations: '연동 상태', audit: '지원 세션 · 감사로그',
}

function StatusPill({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) {
  return <span className={'status-pill ' + tone}><i />{children}</span>
}

function PageHeader({ eyebrow, title, description, action }: {
  eyebrow?: string; title: string; description: string; action?: ReactNode
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action && <div className="page-header-actions">{action}</div>}
    </header>
  )
}

function useDialogFocus(active = true) {
  const dialogRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!active) return
    const dialog = dialogRef.current
    if (!dialog) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const selector = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(selector))
    const initialFocus = dialog.querySelector<HTMLElement>('[data-autofocus], [autofocus]') ?? focusables[0]
    window.setTimeout(() => initialFocus?.focus(), 0)

    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const currentFocusables = Array.from(dialog.querySelectorAll<HTMLElement>(selector))
      if (currentFocusables.length === 0) return
      const first = currentFocusables[0]
      const last = currentFocusables[currentFocusables.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    dialog.addEventListener('keydown', trapFocus)
    return () => {
      dialog.removeEventListener('keydown', trapFocus)
      previousFocus?.focus()
    }
  }, [active])

  return dialogRef
}

function SharedCalendarPreview({ onOpen, hasDemoData }: { onOpen: () => void; hasDemoData: boolean }) {
  const days: Array<{ day: number; event?: string; today?: boolean }> = hasDemoData ? [
    { day: 17 }, { day: 18, event: 'quality' }, { day: 19, today: true, event: 'production' },
    { day: 20, event: 'company' }, { day: 21 }, { day: 22, event: 'personal' }, { day: 23 },
  ] : [{ day: 17 }, { day: 18 }, { day: 19, today: true }, { day: 20 }, { day: 21 }, { day: 22 }, { day: 23 }]
  return <section className="home-calendar-card" aria-labelledby="home-calendar-title">
    <header><div><span className="eyebrow">SHARED SCHEDULE</span><h2 id="home-calendar-title">8월 일정</h2></div><button className="text-button" type="button" onClick={onOpen}>전체 보기 <ArrowRight size={16} /></button></header>
    <div className="mini-weekdays" aria-hidden="true">{['월', '화', '수', '목', '금', '토', '일'].map((day) => <span key={day}>{day}</span>)}</div>
    <div className="mini-calendar-days">{days.map((item) => <button type="button" className={item.today ? 'today' : ''} key={item.day} onClick={onOpen}><span>{item.day}</span>{item.event && <i className={item.event} />}</button>)}</div>
    {hasDemoData ? <div className="today-agenda">
      <article><time>14:30</time><span className="agenda-color production" /><div><strong>생산계획 확정 회의</strong><p>생산팀 · 회의실 A</p></div></article>
      <article><time>16:00</time><span className="agenda-color quality" /><div><strong>멍게젓 제품정보 최종 검토</strong><p>품질관리 · 온라인</p></div></article>
    </div> : <div className="empty-state"><CalendarDays size={25} /><h3>등록된 일정이 없습니다</h3><p>첫 전사 일정을 등록하면 직원들과 바로 공유됩니다.</p></div>}
    <button className="button secondary full" type="button" onClick={onOpen}><CalendarDays size={17} /> 일정 등록</button>
  </section>
}

const dashboardWidgetLabels: Record<DashboardWidgetPreference['id'], string> = {
  summary: '오늘 핵심 현황',
  ai: 'AI 업무 대화',
  schedule: '공유 일정',
  work: '다음 업무',
  links: '업무 바로가기',
  alert: '중요 알림',
}

type DashboardDropTarget = {
  id: DashboardWidgetPreference['id'] | 'end'
  edge: 'before' | 'after'
}

function AIHome({ workItems, currentUserName, currentUserId, companyName, canAssignTasks, hasDemoData, onAdvanceTask, onCreateTask, onNavigate, onToast }: {
  workItems: WorkItem[]
  currentUserName: string
  currentUserId: string
  companyName: string
  canAssignTasks: boolean
  hasDemoData: boolean
  onAdvanceTask: (item: WorkItem) => void
  onCreateTask: (text?: string) => void
  onNavigate: (page: PageId) => void
  onToast: (message: string) => void
}) {
  const openWork = workItems.filter((item) => item.status !== '결재완료')
  const myWork = openWork.filter((item) => item.ownerId === currentUserId || (item.requesterId === currentUserId && item.status === '결재대기'))
  const today = new Date()
  const todayIso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(today)
  const todayLabel = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  }).format(today)
  const [layoutOpen, setLayoutOpen] = useState(false)
  const [widgetPreferences, setWidgetPreferences] = useDashboardPreferences(`${companyName}:${currentUserId}`)
  const [draggingWidgetId, setDraggingWidgetId] = useState<DashboardWidgetPreference['id'] | null>(null)
  const [keyboardWidgetId, setKeyboardWidgetId] = useState<DashboardWidgetPreference['id'] | null>(null)
  const [dropTarget, setDropTarget] = useState<DashboardDropTarget | null>(null)
  const [layoutAnnouncement, setLayoutAnnouncement] = useState('')
  const aiContext = {
    date: todayIso,
    company: companyName,
    salesChannels: canAssignTasks && hasDemoData ? channelMetrics : undefined,
    products: (hasDemoData ? seaProducts : []).map(({ name, stock, available, safetyStock, labelStatus, status }) => ({
      name, stock, available, safetyStock, labelStatus, status,
    })),
    openWork: canAssignTasks ? openWork : myWork,
  }

  const visibleWidgets = widgetPreferences.filter((item) => item.visible)
  const hiddenWidgets = widgetPreferences.filter((item) => !item.visible)

  const updateWidget = (id: DashboardWidgetPreference['id'], patch: Partial<DashboardWidgetPreference>) => {
    setWidgetPreferences((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item))
  }

  const moveWidgetBy = (id: DashboardWidgetPreference['id'], direction: -1 | 1) => {
    setWidgetPreferences((current) => {
      const visible = current.filter((item) => item.visible)
      const sourceIndex = visible.findIndex((item) => item.id === id)
      const targetIndex = sourceIndex + direction
      if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= visible.length) return current
      const ordered = [...visible]
      ;[ordered[sourceIndex], ordered[targetIndex]] = [ordered[targetIndex], ordered[sourceIndex]]
      let visibleIndex = 0
      return current.map((item) => item.visible ? ordered[visibleIndex++] : item)
    })
    setLayoutAnnouncement(`${dashboardWidgetLabels[id]} 위젯을 ${direction < 0 ? '앞' : '뒤'} 칸으로 이동했습니다.`)
  }

  const moveWidgetRelative = (sourceId: DashboardWidgetPreference['id'], targetId: DashboardWidgetPreference['id'], edge: 'before' | 'after') => {
    if (sourceId === targetId) return
    setWidgetPreferences((current) => {
      const visible = current.filter((item) => item.visible)
      const moving = visible.find((item) => item.id === sourceId)
      if (!moving || !visible.some((item) => item.id === targetId)) return current
      const ordered = visible.filter((item) => item.id !== sourceId)
      const targetIndex = ordered.findIndex((item) => item.id === targetId)
      ordered.splice(targetIndex + (edge === 'after' ? 1 : 0), 0, moving)
      let visibleIndex = 0
      return current.map((item) => item.visible ? ordered[visibleIndex++] : item)
    })
    setLayoutAnnouncement(`${dashboardWidgetLabels[sourceId]} 위젯이 빈 슬롯에 맞춰 정렬되었습니다.`)
  }

  const moveWidgetToEnd = (sourceId: DashboardWidgetPreference['id']) => {
    setWidgetPreferences((current) => {
      const visible = current.filter((item) => item.visible)
      const moving = visible.find((item) => item.id === sourceId)
      if (!moving || visible.at(-1)?.id === sourceId) return current
      const ordered = [...visible.filter((item) => item.id !== sourceId), moving]
      let visibleIndex = 0
      return current.map((item) => item.visible ? ordered[visibleIndex++] : item)
    })
    setLayoutAnnouncement(`${dashboardWidgetLabels[sourceId]} 위젯을 마지막 슬롯으로 이동했습니다.`)
  }

  const finishLayoutEdit = () => {
    setLayoutOpen(false)
    setDraggingWidgetId(null)
    setKeyboardWidgetId(null)
    setDropTarget(null)
    setLayoutAnnouncement('개인 대시보드 배치를 저장했습니다.')
  }

  const renderWidget = (preference: DashboardWidgetPreference) => {
    if (!preference.visible) return null
    let content: ReactNode
    if (preference.id === 'summary') {
      content = <section className="home-action-strip compact" aria-label="오늘 핵심 현황">
        {canAssignTasks
          ? <button type="button" onClick={() => onNavigate('sales')}><span className="quick-icon green"><ShoppingCart size={19} /></span><div><span>오늘 온라인 주문</span><strong>{hasDemoData ? '293' : '0'}<small>건</small></strong><em>{hasDemoData ? '+10.8%' : '연결 필요'}</em></div></button>
          : <button type="button" onClick={() => onNavigate('schedule')}><span className="quick-icon green"><CalendarDays size={19} /></span><div><span>오늘 공유 일정</span><strong>2<small>건</small></strong><em>일정 확인</em></div></button>}
        <button type="button" onClick={() => onNavigate('tasks')}><span className="quick-icon blue"><ListChecks size={19} /></span><div><span>내가 확인할 업무</span><strong>{myWork.length}<small>건</small></strong><em>결재 {myWork.filter((item) => item.status === '결재대기').length}</em></div></button>
        <button type="button" onClick={() => onNavigate(hasDemoData ? 'inventory' : 'products')}><span className="quick-icon amber"><Sparkles size={19} /></span><div><span>AI 선제 알림</span><strong>{hasDemoData ? '3' : '0'}<small>건</small></strong><em>{hasDemoData ? '긴급 1' : '설정 대기'}</em></div></button>
      </section>
    } else if (preference.id === 'ai') {
      content = <AIChat companyName={companyName} canCreateTask={canAssignTasks} canViewCommercial={canAssignTasks} hasDemoData={hasDemoData} onCreateTask={(text) => onCreateTask(text)} context={aiContext} />
    } else if (preference.id === 'schedule') {
      content = <SharedCalendarPreview hasDemoData={hasDemoData} onOpen={() => onNavigate('schedule')} />
    } else if (preference.id === 'links') {
      content = <QuickLinksWidget scope={`${companyName}:${currentUserId}`} onToast={onToast} />
    } else if (preference.id === 'work') {
      content = <section className="my-work-card">
        <div className="section-title-row"><div><span className="eyebrow">MY WORK</span><h2>다음 업무</h2></div><button type="button" className="text-button" onClick={() => onNavigate('tasks')}>전체 보기 <ArrowRight size={16} /></button></div>
        <div className="work-mini-list">
          {myWork.length === 0 && <div className="empty-state compact"><CheckCircle2 size={26} /><h3>지금 처리할 업무가 없습니다</h3><p>새 업무가 배정되면 여기에 표시됩니다.</p></div>}
          {myWork.slice(0, 2).map((item) => <article className="work-mini" key={item.id}>
            <div className="work-mini-top"><StatusPill tone={item.priority === '긴급' ? 'danger' : item.priority === '높음' ? 'warning' : 'neutral'}>{item.priority}</StatusPill><StatusPill tone={item.status === '결재대기' ? 'blue' : 'neutral'}>{item.status}</StatusPill></div>
            <h3>{item.title}</h3><p>{item.owner} · {item.due}</p>
            <button type="button" disabled={item.status === '결재대기' && item.requesterId !== currentUserId} onClick={() => onAdvanceTask(item)}>{item.status === '업무요청' ? '업무 수락' : item.status === '수행중' ? '결재 요청' : item.requesterId === currentUserId ? '결재 승인' : '승인 대기'} <ArrowRight size={15} /></button>
          </article>)}
        </div>
      </section>
    } else {
      content = <section className={'priority-alert-bar ' + (!hasDemoData ? 'setup' : !canAssignTasks ? 'neutral' : '')}>
        <span className="priority-alert-icon"><AlertTriangle size={20} /></span>
        <div><strong>{!hasDemoData ? '운영 데이터를 먼저 연결해 주세요' : canAssignTasks ? 'G마켓 SKU 매핑 2건이 끊겼어요' : '내 업무 마감을 확인해 주세요'}</strong><p>{!hasDemoData ? '제품·창고·판매채널을 등록하면 AI 선제 알림이 시작됩니다.' : canAssignTasks ? '오늘 주문 7건이 ERP로 수집되지 않을 수 있습니다.' : '오늘 수행할 업무와 공유 일정을 확인하세요.'}</p></div>
        <button className="small-button" type="button" onClick={() => !hasDemoData ? onNavigate('products') : canAssignTasks ? onCreateTask('G마켓 SKU 매핑 오류 2건 확인') : onNavigate('tasks')}>{!hasDemoData ? '초기 설정' : canAssignTasks ? '업무 만들기' : '내 업무 보기'} <ArrowRight size={15} /></button>
      </section>
    }
    const visibleIndex = visibleWidgets.findIndex((item) => item.id === preference.id)
    const targetEdge = dropTarget?.id === preference.id ? dropTarget.edge : null
    return <div
      className={`${widgetClass(preference)} dashboard-editable-widget${layoutOpen ? ' is-editing' : ''}${draggingWidgetId === preference.id ? ' is-dragging' : ''}${keyboardWidgetId === preference.id ? ' is-keyboard-moving' : ''}${targetEdge ? ` is-drop-${targetEdge}` : ''}`}
      data-widget-id={preference.id}
      key={preference.id}
      onDragOver={(event) => {
        if (!layoutOpen || !draggingWidgetId || draggingWidgetId === preference.id) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        const rect = event.currentTarget.getBoundingClientRect()
        const y = (event.clientY - rect.top) / Math.max(rect.height, 1)
        const x = (event.clientX - rect.left) / Math.max(rect.width, 1)
        const edge: 'before' | 'after' = y < .28 ? 'before' : y > .72 ? 'after' : x < .5 ? 'before' : 'after'
        setDropTarget((current) => current?.id === preference.id && current.edge === edge ? current : { id: preference.id, edge })
      }}
      onDrop={(event) => {
        if (!layoutOpen) return
        event.preventDefault()
        const sourceId = (draggingWidgetId || event.dataTransfer.getData('text/plain')) as DashboardWidgetPreference['id']
        const edge = dropTarget?.id === preference.id ? dropTarget.edge : 'before'
        if (widgetPreferences.some((item) => item.id === sourceId)) moveWidgetRelative(sourceId, preference.id, edge)
        setDraggingWidgetId(null)
        setDropTarget(null)
      }}
    >
      {layoutOpen && <div className="dashboard-widget-editbar">
        <button
          className="dashboard-drag-handle"
          type="button"
          draggable
          aria-label={`${dashboardWidgetLabels[preference.id]} 이동 모드. 누른 뒤 방향키 또는 옆 이동 버튼으로 위치를 바꿉니다.`}
          aria-pressed={keyboardWidgetId === preference.id}
          aria-keyshortcuts="ArrowLeft ArrowUp ArrowRight ArrowDown"
          title={keyboardWidgetId === preference.id ? '이동 모드 선택됨' : '잡아서 이동하거나 눌러 이동 모드 선택'}
          onDragStart={(event) => {
            setDraggingWidgetId(preference.id)
            setKeyboardWidgetId(preference.id)
            setDropTarget(null)
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('text/plain', preference.id)
          }}
          onDragEnd={() => { setDraggingWidgetId(null); setDropTarget(null) }}
          onClick={() => {
            setKeyboardWidgetId((current) => current === preference.id ? null : preference.id)
            setLayoutAnnouncement(keyboardWidgetId === preference.id ? `${dashboardWidgetLabels[preference.id]} 이동 모드를 해제했습니다.` : `${dashboardWidgetLabels[preference.id]} 이동 모드를 선택했습니다. 방향키 또는 앞·뒤 이동 버튼을 사용하세요.`)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); moveWidgetBy(preference.id, -1) }
            if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); moveWidgetBy(preference.id, 1) }
            if (event.key === 'Escape') { event.preventDefault(); setKeyboardWidgetId(null); setLayoutAnnouncement(`${dashboardWidgetLabels[preference.id]} 이동 모드를 해제했습니다.`) }
          }}
        ><GripVertical size={17} /></button>
        <span className="dashboard-widget-order" aria-hidden="true">{visibleIndex + 1}</span>
        <strong>{dashboardWidgetLabels[preference.id]}</strong>
        <label><span className="sr-only">{dashboardWidgetLabels[preference.id]} 너비</span><select value={preference.size} onChange={(event) => updateWidget(preference.id, { size: event.target.value as DashboardWidgetPreference['size'] })}><option value="half">컴팩트 · 1/3</option><option value="wide">넓게 · 2/3</option><option value="full">전체 너비</option></select></label>
        <button type="button" aria-label={`${dashboardWidgetLabels[preference.id]} 앞 칸으로 이동`} disabled={visibleIndex === 0} onClick={() => moveWidgetBy(preference.id, -1)}><ChevronLeft size={17} /></button>
        <button type="button" aria-label={`${dashboardWidgetLabels[preference.id]} 뒤 칸으로 이동`} disabled={visibleIndex === visibleWidgets.length - 1} onClick={() => moveWidgetBy(preference.id, 1)}><ChevronRight size={17} /></button>
        <button type="button" aria-label={`${dashboardWidgetLabels[preference.id]} 숨기기`} onClick={() => { updateWidget(preference.id, { visible: false }); if (keyboardWidgetId === preference.id) setKeyboardWidgetId(null); setLayoutAnnouncement(`${dashboardWidgetLabels[preference.id]} 위젯을 숨겼습니다.`) }}><EyeOff size={17} /></button>
      </div>}
      <div className="dashboard-widget-preview">{content}</div>
    </div>
  }

  return (
    <div className="home-page">
      <PageHeader
        eyebrow={`${todayLabel} · ${companyName}`}
        title={`안녕하세요, ${currentUserName}님`}
        description="AI에게 업무 정보를 묻거나, 오늘 처리할 일정과 결재를 확인하세요."
        action={<>{layoutOpen ? <button className="button primary" type="button" onClick={finishLayoutEdit}><Check size={18} /> 편집 완료</button> : <DashboardLayoutButton onClick={() => setLayoutOpen(true)} />}{canAssignTasks ? <button className="button primary" type="button" onClick={() => onCreateTask()}><Plus size={18} /> 새 업무 지시</button> : <StatusPill tone="neutral">직원용 업무 화면</StatusPill>}</>}
      />
      {layoutOpen && <section className="dashboard-layout-workbench" aria-labelledby="dashboard-layout-workbench-title">
        <div className="dashboard-layout-guide"><span className="dashboard-layout-guide-icon"><GripVertical size={19} /></span><div><h2 id="dashboard-layout-workbench-title">블록을 잡아 원하는 빈 슬롯에 놓으세요</h2><p>블록은 자동으로 격자에 맞춰지고 순서와 너비는 이 계정에 바로 저장됩니다. 핸들을 누른 뒤 방향키·이동 버튼으로도 조정할 수 있습니다.</p></div><span className="dashboard-layout-saved"><Check size={15} /> 개인 저장</span><button type="button" className="small-button" onClick={() => { setWidgetPreferences(defaultDashboardWidgets.map((item) => ({ ...item }))); setKeyboardWidgetId(null); setLayoutAnnouncement('기본 위젯 배치로 되돌렸습니다.') }}><RotateCcw size={15} /> 기본 배치</button></div>
        <div className="dashboard-hidden-widgets"><strong>숨긴 위젯</strong>{hiddenWidgets.length === 0 ? <span>모든 위젯이 표시 중입니다.</span> : hiddenWidgets.map((item) => <button type="button" key={item.id} onClick={() => { updateWidget(item.id, { visible: true }); setLayoutAnnouncement(`${dashboardWidgetLabels[item.id]} 위젯을 다시 표시했습니다.`) }}><Plus size={14} /> {dashboardWidgetLabels[item.id]}</button>)}</div>
      </section>}
      <div className={`dashboard-widget-grid${layoutOpen ? ' is-layout-editing' : ''}`}>
        {widgetPreferences.map(renderWidget)}
        {layoutOpen && <div
          className={`dashboard-grid-end-drop${dropTarget?.id === 'end' ? ' is-active' : ''}`}
          onDragOver={(event) => { if (!draggingWidgetId) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget({ id: 'end', edge: 'after' }) }}
          onDrop={(event) => { event.preventDefault(); const sourceId = (draggingWidgetId || event.dataTransfer.getData('text/plain')) as DashboardWidgetPreference['id']; if (widgetPreferences.some((item) => item.id === sourceId)) moveWidgetToEnd(sourceId); setDraggingWidgetId(null); setDropTarget(null) }}
        ><GripVertical size={16} /><span>마지막 빈 슬롯</span><small>여기에 놓으면 자동 정렬됩니다</small></div>}
      </div>
      <p className="sr-only" role="status" aria-live="polite">{layoutAnnouncement}</p>
    </div>
  )
}

type WorkTransitionAction = 'accept' | 'submit' | 'approve' | 'request-changes'
type WorkAssignee = { id: string; name: string }
const workWeekdayNames = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일']

function workRuleScheduleLabel(rule: WorkRule) {
  const interval = rule.frequency === 'weekly'
    ? (rule.interval === 1 ? '매주' : `${rule.interval}주마다`)
    : (rule.interval === 1 ? '매월' : `${rule.interval}개월마다`)
  if (rule.frequency === 'weekly') return `${interval} ${workWeekdayNames[rule.weekday ?? 0]}`
  if (rule.monthlyMode === 'last-weekday') return `${interval} 마지막 주 ${workWeekdayNames[rule.weekday ?? 1]}`
  return `${interval} ${rule.monthDay ?? 1}일`
}

function fileSizeLabel(size: number) {
  return size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`
}

async function downloadStoredDocument(id: string, name: string, workspaceScope?: string) {
  if (!id.startsWith('DOC-')) return false
  const response = await fetch(`/api/documents/${encodeURIComponent(id)}/download`, { headers: workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined })
  if (!response.ok) return false
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const anchor = window.document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  return true
}

async function downloadWorkEvidence(file: WorkEvidence, workspaceScope?: string) {
  return downloadStoredDocument(file.id, file.name, workspaceScope)
}

function CompletionModal({ item, workspaceScope, onToast, onClose, onSubmit }: { item: WorkItem; workspaceScope?: string; onToast: (message: string) => void; onClose: () => void; onSubmit: (summary: string, evidence: WorkEvidence[]) => Promise<boolean> }) {
  const dialogRef = useDialogFocus()
  const inputRef = useRef<HTMLInputElement>(null)
  const [summary, setSummary] = useState(item.completion?.summary ?? '')
  const [evidence, setEvidence] = useState<WorkEvidence[]>(() => item.completion?.evidence.map((file) => ({ ...file })) ?? [])
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const uploadedIdsRef = useRef(new Set<string>())
  const removedIdsRef = useRef(new Set<string>())
  const discardAndClose = async () => {
    if (busy || uploading) return
    setBusy(true)
    const cleanup = await deleteDocumentAttachments(uploadedIdsRef.current, workspaceScope)
    for (const id of cleanup.deleted) uploadedIdsRef.current.delete(id)
    if (cleanup.deleted.length) {
      const deleted = new Set(cleanup.deleted)
      setEvidence((current) => current.filter((file) => !deleted.has(file.id)))
    }
    if (cleanup.failed.length) {
      const message = `저장하지 않은 증빙 ${cleanup.failed.length}개를 정리하지 못했습니다. 다시 시도해 주세요.`
      setUploadError(message)
      onToast(message)
      setBusy(false)
      return
    }
    onClose()
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (summary.trim().length < 3) return
    setBusy(true)
    if (await onSubmit(summary.trim(), evidence)) {
      uploadedIdsRef.current.clear()
      const cleanup = await deleteDocumentAttachments(removedIdsRef.current, workspaceScope)
      if (cleanup.failed.length) onToast(`업무는 제출했지만 제거한 증빙 ${cleanup.failed.length}개의 원본 정리에 실패했습니다.`)
      onClose()
    } else setBusy(false)
  }
  const removeEvidence = async (file: WorkEvidence) => {
    if (busy || uploading) return
    if (file.id.startsWith('DOC-') && uploadedIdsRef.current.has(file.id)) {
      setUploading(true)
      try {
        await deleteDocumentAttachment(file.id, workspaceScope)
        uploadedIdsRef.current.delete(file.id)
      } catch (error) {
        const message = error instanceof Error ? error.message : '증빙 파일을 삭제하지 못했습니다.'
        setUploadError(message)
        onToast(message)
        setUploading(false)
        return
      }
      setUploading(false)
    } else if (file.id.startsWith('DOC-')) removedIdsRef.current.add(file.id)
    setEvidence((current) => current.filter((item) => item.id !== file.id))
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) void discardAndClose() }}>
    <section ref={dialogRef} className="modal-card workflow-modal" role="dialog" aria-modal="true" aria-labelledby="completion-modal-title">
      <header><div><span className="eyebrow">SUBMIT RESULT</span><h2 id="completion-modal-title">완료내용 · 증빙 제출</h2><p>{item.title}</p></div><button type="button" className="icon-button" aria-label="닫기" disabled={busy || uploading} onClick={() => void discardAndClose()}><X size={21} /></button></header>
      <form onSubmit={submit}>
        {item.review?.decision === 'changes-requested' && <div className="workflow-feedback danger"><strong>수정 요청 내용</strong><p>{item.review.requestedChanges || item.review.comment}</p></div>}
        <label className="form-field full"><span>완료 내용 <em>필수</em></span><textarea autoFocus data-autofocus rows={6} value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="무엇을 어떻게 완료했고 결과가 무엇인지 작성하세요." required /></label>
        <section className="workflow-upload" aria-labelledby="work-evidence-title"><div><h3 id="work-evidence-title">증빙자료</h3><p>선택한 파일은 고객사 자료 저장소에 실제 업로드되며 담당자와 결재자만 열람합니다.</p></div><input ref={inputRef} className="sr-only" type="file" multiple onChange={async (event) => {
          const files = Array.from(event.target.files ?? []).slice(0, Math.max(0, 10 - evidence.length)); event.target.value = ''
          if (!workspaceScope || files.length === 0) return
          setUploading(true); setUploadError('')
          const uploaded: WorkEvidence[] = []
          for (const file of files) {
            if (file.size > 10 * 1024 * 1024) { setUploadError(`${file.name}: 한 파일은 10MB까지 첨부할 수 있습니다.`); continue }
            try {
              const params = new URLSearchParams({ name: file.name, category: '회의·업무일지', visibility: 'restricted', allowedUserIds: [item.ownerId, item.requesterId].filter(Boolean).join(','), tags: `업무증빙,${item.id}`, summary: `${item.title} 완료 증빙자료` })
              const response = await fetch(`/api/documents?${params}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name), 'x-workspace-identity': workspaceScope }, body: file })
              const body = await response.json() as { document?: { id: string }; error?: { message?: string } }
              if (!response.ok || !body.document) throw new Error(body.error?.message || '업로드 실패')
              uploaded.push({ id: body.document.id, name: file.name, size: fileSizeLabel(file.size), type: file.type || 'application/octet-stream' })
              uploadedIdsRef.current.add(body.document.id)
            } catch (error) { setUploadError(`${file.name}: ${error instanceof Error ? error.message : '업로드 실패'}`) }
          }
          setEvidence((current) => [...current, ...uploaded].slice(0, 10)); setUploading(false)
        }} /><button className="button secondary" type="button" disabled={uploading || evidence.length >= 10} onClick={() => inputRef.current?.click()}><Upload size={17} /> {uploading ? '업로드 중…' : '파일 선택'}</button></section>
        {uploadError && <p className="workflow-upload-error" role="alert">{uploadError}</p>}
        <div className="workflow-evidence-list">{evidence.map((file) => <div key={file.id}><FileText size={18} /><span><strong>{file.name}</strong><small>{file.size} · 원본 저장됨</small></span><button type="button" aria-label={`${file.name} 삭제`} disabled={busy || uploading} onClick={() => void removeEvidence(file)}><X size={16} /></button></div>)}{evidence.length === 0 && <p>첨부 없이 완료내용만 제출할 수도 있습니다.</p>}</div>
        <footer><button type="button" className="button ghost" disabled={busy || uploading} onClick={() => void discardAndClose()}>취소</button><button type="submit" className="button primary" disabled={busy || uploading || summary.trim().length < 3}><ClipboardCheck size={18} /> 결재 요청</button></footer>
      </form>
    </section>
  </div>
}

function WorkReviewModal({ item, mode, workspaceScope, onToast, onClose, onSubmit }: { item: WorkItem; mode: 'approve' | 'request-changes'; workspaceScope?: string; onToast: (message: string) => void; onClose: () => void; onSubmit: (comment: string, requestedChanges?: string) => Promise<boolean> }) {
  const dialogRef = useDialogFocus()
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const valid = comment.trim().length >= 2
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={dialogRef} className="modal-card workflow-modal" role="dialog" aria-modal="true" aria-labelledby="review-modal-title">
      <header><div><span className="eyebrow">WORK REVIEW</span><h2 id="review-modal-title">{mode === 'approve' ? '결재 승인' : '수정 요청'}</h2><p>{item.title}</p></div><button type="button" className="icon-button" aria-label="닫기" onClick={onClose}><X size={21} /></button></header>
      <form onSubmit={async (event) => { event.preventDefault(); if (!valid) return; setBusy(true); const message = comment.trim(); if (await onSubmit(message, mode === 'request-changes' ? message : undefined)) onClose(); else setBusy(false) }}>
        <div className="workflow-submission-preview"><strong>담당자 완료 보고</strong><p>{item.completion?.summary || '레거시 업무로 완료내용이 등록되지 않았습니다.'}</p>{item.completion?.evidence.map((file) => file.id.startsWith('DOC-') ? <button className="workflow-evidence-link" type="button" key={file.id} onClick={async () => { if (!await downloadWorkEvidence(file, workspaceScope)) onToast('증빙 파일을 다운로드하지 못했습니다.') }}><Paperclip size={14} /> {file.name} · {file.size}</button> : <span key={file.id}><Paperclip size={14} /> {file.name} · {file.size}</span>)}</div>
        <label className="form-field full"><span>{mode === 'approve' ? '승인 코멘트' : '수정 요청 내용'} <em>필수</em></span><textarea autoFocus data-autofocus rows={4} value={comment} onChange={(event) => setComment(event.target.value)} placeholder={mode === 'approve' ? '검토한 내용과 승인 근거를 남겨 주세요.' : '무엇을 왜, 어떻게 보완해야 하는지 한 번에 작성해 주세요. 예: LOT 번호와 조치 전·후 사진을 보완해 주세요.'} required /></label>
        <footer><button type="button" className="button ghost" onClick={onClose}>취소</button><button type="submit" className={`button ${mode === 'approve' ? 'primary' : 'danger'}`} disabled={busy || !valid}>{mode === 'approve' && <Check size={18} />}{mode === 'approve' ? ' 승인 완료' : '수정 요청 보내기'}</button></footer>
      </form>
    </section>
  </div>
}

function WorkRuleModal({ assignees, onClose, onSubmit }: { assignees: WorkAssignee[]; onClose: () => void; onSubmit: (input: Record<string, unknown>) => Promise<boolean> }) {
  const dialogRef = useDialogFocus()
  const [frequency, setFrequency] = useState<'weekly' | 'monthly'>('weekly')
  const [monthlyMode, setMonthlyMode] = useState<'day-of-month' | 'last-weekday'>('day-of-month')
  const [weekday, setWeekday] = useState(3)
  const [monthDay, setMonthDay] = useState(1)
  const [busy, setBusy] = useState(false)
  const today = new Date().toISOString().slice(0, 10)
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={dialogRef} className="modal-card workflow-modal" role="dialog" aria-modal="true" aria-labelledby="rule-modal-title">
      <header><div><span className="eyebrow">RECURRING WORK</span><h2 id="rule-modal-title">반복 업무 규칙 만들기</h2><p>매주 또는 매월 자동으로 업무를 생성합니다.</p></div><button type="button" className="icon-button" aria-label="닫기" onClick={onClose}><X size={21} /></button></header>
      <form onSubmit={async (event) => {
        event.preventDefault()
        const input: Record<string, unknown> = Object.fromEntries(new FormData(event.currentTarget).entries())
        input.frequency = frequency
        input.interval = Number(input.interval)
        if (frequency === 'weekly') input.weekday = weekday
        else {
          input.monthlyMode = monthlyMode
          if (monthlyMode === 'last-weekday') input.weekday = weekday
          else input.monthDay = monthDay
        }
        setBusy(true)
        if (await onSubmit(input)) onClose()
        else setBusy(false)
      }}>
        <div className="form-grid">
          <label className="form-field full"><span>업무 제목</span><input autoFocus data-autofocus name="title" required placeholder="예: 주간 HACCP 기록 점검" /></label>
          <label className="form-field full"><span>업무 설명</span><textarea name="description" rows={3} required placeholder="담당자가 매회 확인할 완료 기준" /></label>
          <label className="form-field"><span>담당자</span><select name="ownerId" required>{assignees.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
          <label className="form-field"><span>업무 구분</span><select name="category" defaultValue="일반"><option>제품</option><option>생산</option><option>재고</option><option>품질</option><option>일반</option></select></label>
          <label className="form-field"><span>반복 주기</span><select value={frequency} onChange={(event) => setFrequency(event.target.value as 'weekly' | 'monthly')}><option value="weekly">주간</option><option value="monthly">월간</option></select></label>
          <label className="form-field"><span>반복 간격</span><select name="interval" defaultValue="1"><option value="1">{frequency === 'weekly' ? '매주' : '매월'}</option><option value="2">{frequency === 'weekly' ? '2주마다' : '2개월마다'}</option><option value="3">{frequency === 'weekly' ? '3주마다' : '3개월마다'}</option></select></label>
          {frequency === 'monthly' && <label className="form-field full"><span>월간 실행 방식</span><select value={monthlyMode} onChange={(event) => setMonthlyMode(event.target.value as 'day-of-month' | 'last-weekday')}><option value="day-of-month">매월 특정일</option><option value="last-weekday">매월 마지막 주 특정 요일</option></select></label>}
          {(frequency === 'weekly' || monthlyMode === 'last-weekday') && <label className="form-field"><span>{frequency === 'weekly' ? '실행 요일' : '마지막 주 실행 요일'}</span><select value={weekday} onChange={(event) => setWeekday(Number(event.target.value))}>{workWeekdayNames.map((day, index) => <option value={index} key={day}>{day}</option>)}</select></label>}
          {frequency === 'monthly' && monthlyMode === 'day-of-month' && <label className="form-field"><span>실행일</span><input type="number" min={1} max={31} value={monthDay} onChange={(event) => setMonthDay(Number(event.target.value))} required /></label>}
          <label className="form-field"><span>적용 시작일</span><input name="startDate" type="date" min={today} defaultValue={today} required /></label>
          <label className="form-field"><span>마감 시간</span><input name="dueTime" type="time" defaultValue="17:00" required /></label>
          <label className="form-field"><span>우선순위</span><select name="priority" defaultValue="보통"><option>긴급</option><option>높음</option><option>보통</option></select></label>
          <p className="workflow-rule-hint full"><CalendarDays size={16} /> 시작일 이후 첫 {frequency === 'weekly' ? workWeekdayNames[weekday] : monthlyMode === 'last-weekday' ? `마지막 주 ${workWeekdayNames[weekday]}` : `${monthDay}일`}부터 자동 생성됩니다.</p>
        </div>
        <footer><button type="button" className="button ghost" onClick={onClose}>취소</button><button type="submit" className="button primary" disabled={busy || assignees.length === 0}><Repeat2 size={18} /> 규칙 생성</button></footer>
      </form>
    </section>
  </div>
}

function WorkPage({ items, rules, currentUserId, canAssignTasks, assignees, workspaceScope, onToast, onCreate, onTransition, onCreateRule, onToggleRule }: {
  items: WorkItem[]; rules: WorkRule[]; currentUserId: string; canAssignTasks: boolean; assignees: WorkAssignee[]
  workspaceScope?: string
  onToast: (message: string) => void
  onCreate: () => void
  onTransition: (id: string, action: WorkTransitionAction, input?: Record<string, unknown>) => Promise<boolean>
  onCreateRule: (input: Record<string, unknown>) => Promise<boolean>
  onToggleRule: (rule: WorkRule) => Promise<boolean>
}) {
  const [tab, setTab] = useState<'mine' | 'requested' | 'approval' | 'done'>('mine')
  const [dialog, setDialog] = useState<{ type: 'completion' | 'approve' | 'changes'; item: WorkItem } | { type: 'rule' } | null>(null)
  const visible = items.filter((item) => tab === 'done' ? item.status === '결재완료' : tab === 'approval' ? item.requesterId === currentUserId && item.status === '결재대기' : tab === 'requested' ? item.requesterId === currentUserId && item.status !== '결재완료' : item.ownerId === currentUserId && item.status !== '결재완료')
  const stages: WorkItem['status'][] = ['업무요청', '수행중', '결재대기', '결재완료']
  return <div className="content-page">
    <PageHeader eyebrow="WORKFLOW" title="업무지시 · 결재" description="수행 결과와 증빙, 결재 코멘트를 한 흐름에서 확인합니다." action={canAssignTasks ? <div className="page-action-row"><button className="button secondary" type="button" onClick={() => setDialog({ type: 'rule' })}><Repeat2 size={18} /> 반복 업무</button><button className="button primary" type="button" onClick={onCreate}><Plus size={18} /> 새 업무 지시</button></div> : <StatusPill tone="neutral">내 업무 수행</StatusPill>} />
    <section className="workflow-summary-strip" aria-label="업무 상태 요약">{stages.map((status, index) => <div className={status === '결재대기' ? 'attention' : ''} key={status}><span>{status}</span><strong>{items.filter((item) => item.status === status).length}</strong>{index < stages.length - 1 && <ArrowRight size={17} />}</div>)}</section>
    <section className="panel work-panel workflow-board"><div className="segmented-tabs" role="tablist" aria-label="업무 구분"><button type="button" role="tab" aria-selected={tab === 'mine'} onClick={() => setTab('mine')}>내 업무</button>{canAssignTasks && <button type="button" role="tab" aria-selected={tab === 'requested'} onClick={() => setTab('requested')}>지시한 업무</button>}{canAssignTasks && <button type="button" role="tab" aria-selected={tab === 'approval'} onClick={() => setTab('approval')}>결재 대기 <em>{items.filter((item) => item.requesterId === currentUserId && item.status === '결재대기').length}</em></button>}<button type="button" role="tab" aria-selected={tab === 'done'} onClick={() => setTab('done')}>완료</button></div>
      <div className="workflow-card-list">{visible.length === 0 && <div className="empty-state"><CheckCircle2 size={34} /><h3>이 구간의 업무가 없습니다</h3><p>다른 상태 탭을 확인해 보세요.</p></div>}{visible.map((item) => {
        const step = stages.indexOf(item.status)
        const ownerAction = item.ownerId === currentUserId
        const reviewerAction = item.requesterId === currentUserId
        const reviewAction = reviewerAction && item.status === '결재대기'
        const actionContext = reviewAction ? '검토 업무 · 다음 행동' : ownerAction ? '내 업무 · 다음 행동' : '현재 상태'
        const actionHint = reviewAction
          ? '제출 결과를 검토하고 승인 또는 수정을 요청하세요'
          : ownerAction
          ? item.status === '업무요청' ? '수락 후 바로 수행 시작' : item.status === '수행중' ? item.review?.decision === 'changes-requested' ? '요청사항 보완 후 재제출' : '완료 결과와 증빙 제출' : item.status === '결재대기' ? '요청자 검토를 기다리는 중' : '업무 처리 완료'
          : item.status === '결재완료' ? '승인과 업무 처리 완료' : '진행 상태 확인'
        return <article className={`workflow-task-card task-focused status-${step}`} key={item.id}>
          <div className="workflow-task-progress" aria-hidden="true"><span style={{ width: `${Math.max(0, step) / (stages.length - 1) * 100}%` }} /></div>
          <header className="workflow-card-head"><div className="work-row-meta"><StatusPill tone={item.priority === '긴급' ? 'danger' : item.priority === '높음' ? 'warning' : 'neutral'}>{item.priority}</StatusPill><span>{item.category}</span>{item.ruleId && <span><Repeat2 size={13} /> 반복</span>}<span>{item.id}</span></div><StatusPill tone={item.status === '결재완료' ? 'good' : item.status === '결재대기' ? 'blue' : item.status === '수행중' ? 'warning' : 'neutral'}>{item.status}</StatusPill></header>
          <div className="workflow-task-core">
            <div className="workflow-task-title"><span className={`workflow-state-icon ${item.status}`} aria-hidden="true">{step + 1}</span><div><h3>{item.title}</h3><p>{item.description}</p></div></div>
            <dl className="workflow-task-meta"><div><dt>담당</dt><dd>{item.owner}</dd></div><div><dt>요청</dt><dd>{item.requestedBy}</dd></div><div><dt>마감</dt><dd><Clock3 size={14} /> {item.due}</dd></div></dl>
            <ol className="workflow-compact-stepper" aria-label={`업무 단계. 현재 ${item.status}`}>{stages.map((status, index) => <li className={index < step ? 'done' : index === step ? 'current' : ''} aria-current={index === step ? 'step' : undefined} key={status}><i>{index < step ? <Check size={11} /> : index + 1}</i><span>{status}</span></li>)}</ol>
            <aside className="workflow-current-action"><span>{actionContext}</span><strong>{actionHint}</strong><div>{ownerAction && item.status === '업무요청' && <button className="button primary compact-action" type="button" onClick={() => void onTransition(item.id, 'accept')}><PlayCircle size={16} /> 업무 수락</button>}{ownerAction && item.status === '수행중' && <button className="button primary compact-action" type="button" onClick={() => setDialog({ type: 'completion', item })}><Upload size={16} /> {item.review?.decision === 'changes-requested' ? '보완 재제출' : '완료 제출'}</button>}{reviewAction && <><button className="button danger compact-action" type="button" onClick={() => setDialog({ type: 'changes', item })}>수정 요청</button><button className="button primary compact-action" type="button" onClick={() => setDialog({ type: 'approve', item })}><Check size={16} /> 승인</button></>}</div></aside>
          </div>
          {(item.completion || item.review) && <div className="workflow-record-stack">
            {item.completion && <div className="workflow-record"><ClipboardCheck size={17} /><div><strong>완료 보고</strong><p>{item.completion.summary}</p><div className="workflow-record-files">{item.completion.evidence.map((file) => file.id.startsWith('DOC-') ? <button className="workflow-evidence-link" type="button" key={file.id} onClick={async () => { if (!await downloadWorkEvidence(file, workspaceScope)) onToast('증빙 파일을 다운로드하지 못했습니다.') }}><Paperclip size={12} /> {file.name} · {file.size}</button> : <span key={file.id}><Paperclip size={12} /> {file.name} · {file.size}</span>)}</div></div></div>}
            {item.review && <div className={`workflow-record ${item.review.decision === 'approved' ? 'approved' : 'changes'}`}><ShieldCheck size={17} /><div><strong>{item.review.decision === 'approved' ? '승인 코멘트' : '수정 요청'}</strong><p>{item.review.requestedChanges || item.review.comment}</p></div></div>}
          </div>}
        </article>
      })}</div>
    </section>
    {canAssignTasks && <section className="panel recurring-work-panel"><header><div><span className="eyebrow">RECURRING RULES</span><h2>반복 업무 규칙</h2><p>도래한 규칙은 공유 업무로 자동 생성됩니다.</p></div><button className="button secondary" type="button" onClick={() => setDialog({ type: 'rule' })}><Plus size={17} /> 규칙 추가</button></header><div className="recurring-rule-grid">{rules.map((rule) => <article key={rule.id}><div><span className={`rule-state ${rule.active ? 'active' : 'paused'}`}>{rule.active ? '활성' : '중지'}</span><strong>{rule.title}</strong><p>{rule.description}</p></div><dl><div><dt>주기</dt><dd>{workRuleScheduleLabel(rule)}</dd></div><div><dt>담당자</dt><dd>{rule.owner}</dd></div><div><dt>다음 실행</dt><dd>{rule.nextRun} {rule.dueTime}</dd></div></dl><button className="button ghost" type="button" onClick={() => void onToggleRule(rule)}>{rule.active ? <PauseCircle size={17} /> : <PlayCircle size={17} />}{rule.active ? ' 일시 중지' : ' 다시 활성화'}</button></article>)}{rules.length === 0 && <div className="empty-state"><Repeat2 size={30} /><h3>반복 규칙이 없습니다</h3><p>매주·매월 반복되는 점검을 자동화해 보세요.</p></div>}</div></section>}
    {dialog?.type === 'completion' && <CompletionModal item={dialog.item} workspaceScope={workspaceScope} onToast={onToast} onClose={() => setDialog(null)} onSubmit={(summary, evidence) => onTransition(dialog.item.id, 'submit', { completion: { summary, evidence } })} />}
    {(dialog?.type === 'approve' || dialog?.type === 'changes') && <WorkReviewModal item={dialog.item} mode={dialog.type === 'approve' ? 'approve' : 'request-changes'} workspaceScope={workspaceScope} onToast={onToast} onClose={() => setDialog(null)} onSubmit={(comment, requestedChanges) => onTransition(dialog.item.id, dialog.type === 'approve' ? 'approve' : 'request-changes', { review: { comment, requestedChanges } })} />}
    {dialog?.type === 'rule' && <WorkRuleModal assignees={assignees} onClose={() => setDialog(null)} onSubmit={onCreateRule} />}
  </div>
}

function InventoryPage({ onToast, canManage, workspaceScope, seedDemoData }: { onToast: (message: string) => void; canManage: boolean; workspaceScope?: string; seedDemoData: boolean }) {
  const [storedLocations, setLocations] = useWorkspaceState<WarehouseLocation[]>('inventory-locations', seedDemoData ? initialInventoryLocations : emptyInventoryLocations, { scope: workspaceScope, seedWhenEmpty: canManage })
  const [movements, setMovements] = useWorkspaceState<InventoryMovement[]>('inventory-movements', seedDemoData ? initialInventoryMovements : [], { scope: workspaceScope, seedWhenEmpty: canManage })
  const locations = seedDemoData ? storedLocations : storedLocations.filter((location) => !isSunseaFixtureWarehouse(location))
  const [editing, setEditing] = useState<WarehouseLocation | 'new' | null>(null)
  const [movementOpen, setMovementOpen] = useState(false)
  const [showAllLots, setShowAllLots] = useState(false)
  const [showAllMovements, setShowAllMovements] = useState(false)
  const [expandedWarehouseIds, setExpandedWarehouseIds] = useState<Set<string>>(() => new Set())
  const defaultMovementTime = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 16)
  const warehouseDialogRef = useDialogFocus(Boolean(editing))
  const movementDialogRef = useDialogFocus(movementOpen)
  const lotsByWarehouse = useMemo(() => {
    const grouped = new Map<string, WarehouseLotSummary & { warehouseId: string }>()
    ;[...movements].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)).forEach((movement) => {
      const key = `${movement.warehouseId}:${movement.product}:${movement.lot}:${movement.unit}`
      const previous = grouped.get(key)
      const signedDelta = movement.direction === '입고' ? movement.quantity : -movement.quantity
      const quantity = movement.direction === '재고조정'
        ? movement.quantity
        : previous
          ? previous.quantity === null ? null : previous.quantity + signedDelta
          : movement.direction === '입고' ? movement.quantity : null
      const unreconciledDelta = movement.direction === '재고조정'
        ? 0
        : previous?.quantity === null || (!previous && movement.direction === '출고')
          ? (previous?.unreconciledDelta ?? 0) + signedDelta
          : 0
      grouped.set(key, {
        key,
        warehouseId: movement.warehouseId,
        product: movement.product,
        lot: movement.lot,
        quantity,
        unreconciledDelta,
        unit: movement.unit,
        lastDirection: movement.direction,
        lastAt: movement.occurredAt,
        movementCount: (previous?.movementCount ?? 0) + 1,
      })
    })
    const byWarehouse: Record<string, WarehouseLotSummary[]> = {}
    grouped.forEach(({ warehouseId, ...lot }) => {
      byWarehouse[warehouseId] = [...(byWarehouse[warehouseId] ?? []), lot]
    })
    Object.values(byWarehouse).forEach((lots) => lots.sort((a, b) => b.lastAt.localeCompare(a.lastAt)))
    return byWarehouse
  }, [movements])

  useEffect(() => {
    if (seedDemoData || !storedLocations.some(isSunseaFixtureWarehouse)) return
    setLocations((current) => current.filter((location) => !isSunseaFixtureWarehouse(location)))
  }, [seedDemoData, setLocations, storedLocations])

  useEffect(() => {
    if (!movements.some((movement) => movement.product === '햄게젓 400g')) return
    setMovements((current) => current.map((movement) => movement.product === '햄게젓 400g' ? { ...movement, product: '멍게젓 400g' } : movement))
  }, [movements, setMovements])

  useEffect(() => {
    if (!editing && !movementOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setEditing(null); setMovementOpen(false) }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [editing, movementOpen])

  const saveWarehouse = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canManage) {
      setEditing(null)
      onToast('창고 정보 변경은 고객사 관리자만 할 수 있습니다.')
      return
    }
    const form = new FormData(event.currentTarget)
    const name = String(form.get('name') || '').trim()
    const type = String(form.get('type') || '실온')
    const temperature = String(form.get('temperature') || '20℃')
    const utilization = Math.min(100, Math.max(0, Number(form.get('utilization') || 0)))
    if (!name) return
    if (editing === 'new') {
      const result = await setLocations((current) => [...current, { id: 'WH-' + Date.now().toString().slice(-5), name, type, temperature, condition: temperature + ' · 정상', items: '등록 재고 0개', utilization, alert: '이상 없음' }])
      if (!result.ok) return
      onToast(name + '를 새 창고로 등록했습니다.')
    } else if (editing) {
      const result = await setLocations((current) => current.map((item) => item.id === editing.id ? { ...item, name, type, temperature, condition: temperature + ' · 정상', utilization } : item))
      if (!result.ok) return
      onToast(name + ' 창고 정보를 변경했습니다.')
    }
    setEditing(null)
  }

  const saveMovement = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canManage) { setMovementOpen(false); onToast('입출고 등록은 고객사 관리자만 할 수 있습니다.'); return }
    const form = new FormData(event.currentTarget)
    const direction = String(form.get('direction') || '입고') as InventoryMovement['direction']
    const product = String(form.get('product') || '').trim()
    const lot = String(form.get('lot') || '').trim()
    const quantity = Number(form.get('quantity') || 0)
    const unit = String(form.get('unit') || 'EA')
    const warehouseId = String(form.get('warehouseId') || '')
    const occurredAt = String(form.get('occurredAt') || '').replace('T', ' ')
    const reason = String(form.get('reason') || '').trim()
    const evidenceFile = form.get('evidence') instanceof File ? form.get('evidence') as File : null
    const validQuantity = direction === '재고조정' ? quantity >= 0 : quantity > 0
    if (!product || !lot || !warehouseId || !reason || !Number.isFinite(quantity) || !validQuantity) {
      onToast('품목·LOT·수량·창고·사유를 정확히 입력해 주세요.')
      return
    }
    if (direction === '출고') {
      const currentLot = (lotsByWarehouse[warehouseId] ?? []).find((item) => item.product === product && item.lot === lot && item.unit === unit)
      if (!currentLot || currentLot.quantity === null) {
        onToast('현재고가 확정되지 않은 LOT입니다. 먼저 재고조정으로 실사 현재고를 등록해 주세요.')
        return
      }
      if (quantity > currentLot.quantity) {
        onToast(`출고 수량이 현재고 ${currentLot.quantity.toLocaleString('ko-KR', { maximumFractionDigits: 3 })}${unit}보다 많습니다.`)
        return
      }
    }
    let evidenceId: string | undefined
    if (evidenceFile && evidenceFile.size > 0) {
      if (!workspaceScope || evidenceFile.size > 10 * 1024 * 1024) { onToast('증빙자료는 한 파일당 10MB까지 업로드할 수 있습니다.'); return }
      try {
        const params = new URLSearchParams({ name: evidenceFile.name, category: '재고·물류', visibility: 'all', tags: `입출고증빙,${lot}`, summary: `${product} ${direction} ${lot} 증빙자료` })
        const upload = await fetch(`/api/documents?${params}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-type': evidenceFile.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(evidenceFile.name), 'x-workspace-identity': workspaceScope }, body: evidenceFile })
        const body = await upload.json() as { document?: { id: string }; error?: { message?: string } }
        if (!upload.ok || !body.document) throw new Error(body.error?.message || '증빙 업로드 실패')
        evidenceId = body.document.id
      } catch (error) { onToast(error instanceof Error ? error.message : '증빙자료를 업로드하지 못했습니다.'); return }
    }
    const movement: InventoryMovement = {
      id: `MOV-${Date.now().toString().slice(-10)}`,
      direction, product, lot, quantity, unit, warehouseId,
      occurredAt: occurredAt || new Date().toISOString().slice(0, 16).replace('T', ' '),
      reason,
      evidence: evidenceFile && evidenceFile.size > 0 ? evidenceFile.name : undefined,
      evidenceId,
    }
    const result = await setMovements((current) => [movement, ...current])
    if (!result.ok) { if (evidenceId) void fetch(`/api/documents/${encodeURIComponent(evidenceId)}`, { method: 'DELETE', headers: workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined }); return }
    setMovementOpen(false)
    onToast(`${product} ${quantity}${unit} ${direction} 내역을 등록했습니다.`)
  }

  const removeMovement = async (movement: InventoryMovement) => {
    if (!window.confirm(`${movement.product} ${movement.quantity}${movement.unit} ${movement.direction} 내역을 삭제할까요?`)) return
    const result = await setMovements((current) => current.filter((item) => item.id !== movement.id))
    if (!result.ok) return
    if (movement.evidenceId) {
      const cleanup = await fetch(`/api/documents/${encodeURIComponent(movement.evidenceId)}`, { method: 'DELETE', headers: workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined }).catch(() => null)
      if (!cleanup?.ok) { onToast('입출고 내역은 삭제했지만 증빙 원본 정리에 실패했습니다. 기업자료실을 확인해 주세요.'); return }
    }
    onToast('입출고 내역과 연결된 증빙을 삭제했습니다.')
  }

  return (
    <div className="content-page">
      <PageHeader eyebrow="INVENTORY & LOT" title="재고 · LOT" description="창고 환경과 유통기한, 출고 가능 수량을 제품 흐름에 맞춰 관리합니다." action={canManage ? <><button className="button ghost" type="button" onClick={() => setMovementOpen(true)}><Boxes size={18} /> 입출고 등록</button><button className="button primary" type="button" onClick={() => setEditing('new')}><Plus size={18} /> 창고 등록</button></> : <StatusPill tone="neutral">조회 전용</StatusPill>} />
      <section className="warehouse-grid">
        {locations.length === 0 && <div className="empty-state"><Warehouse size={30} /><h3>등록된 창고가 없습니다</h3><p>창고를 등록하면 보관 조건과 공간 사용률을 이곳에서 관리할 수 있습니다.</p>{canManage && <button className="button primary" type="button" onClick={() => setEditing('new')}><Plus size={17} /> 첫 창고 등록</button>}</div>}
        {locations.map((location) => {
          const lots = lotsByWarehouse[location.id] ?? []
          const unresolvedCount = lots.filter((lot) => lot.quantity === null).length
          const quantityByUnit = lots.reduce<Record<string, number>>((totals, lot) => {
            if (lot.quantity !== null) totals[lot.unit] = (totals[lot.unit] ?? 0) + lot.quantity
            return totals
          }, {})
          const stockTotals = Object.entries(quantityByUnit).map(([unit, quantity]) => `${quantity.toLocaleString('ko-KR', { maximumFractionDigits: 3 })}${unit}`)
          const stockSummary = stockTotals.length > 0 ? stockTotals.join(' · ') : unresolvedCount > 0 ? '현재고 확인 필요' : '재고 원장 미등록'
          const expanded = expandedWarehouseIds.has(location.id)
          const visibleLots = expanded ? lots : lots.slice(0, 4)
          return <article className="warehouse-card warehouse-inventory-block" key={location.id}>
            <div className="warehouse-card-top"><span className="warehouse-icon"><Warehouse size={21} /></span><div><StatusPill tone={location.alert === '이상 없음' ? 'good' : 'warning'}>{location.condition}</StatusPill>{canManage && <button type="button" className="warehouse-edit" onClick={() => setEditing(location)}>변경</button>}</div></div>
            <div className="warehouse-card-heading"><div><h2>{location.name}</h2><span className="warehouse-code">{location.id} · {location.type}</span></div><strong className={unresolvedCount > 0 ? 'needs-reconcile' : ''}>{stockSummary}{unresolvedCount > 0 && stockTotals.length > 0 ? ` · 미확정 ${unresolvedCount}` : ''}</strong></div>
            <div className="warehouse-utilization"><div className="progress-head"><span>공간 사용률</span><strong>{location.utilization}%</strong></div><div className="progress-track"><span style={{ width: location.utilization + '%' }} /></div></div>
            <section className="warehouse-lot-block" aria-label={`${location.name} 품목 및 LOT 수량`}>
              <header><div><strong>품목 · LOT 현재고</strong><small>입고·출고 누계, 재고조정 시 실사 수량으로 확정</small></div><span>{lots.length} LOT</span></header>
              {lots.length === 0 ? <div className="warehouse-lot-empty"><Package size={18} /><span>이 창고에 등록된 LOT 원장이 없습니다.</span></div> : <div className="warehouse-lot-list">{visibleLots.map((lot) => <article key={lot.key}>
                <span className="warehouse-lot-icon"><Package size={17} /></span>
                <div><strong>{lot.product}</strong><small>{lot.lot} · {lot.lastDirection} {lot.lastAt.slice(5)}{lot.movementCount > 1 ? ` · ${lot.movementCount}회 반영` : ''}</small></div>
                {lot.quantity === null
                  ? <strong className="warehouse-lot-quantity is-unreconciled" title="기초재고가 없어 현재고를 확정할 수 없습니다. 재고조정을 등록해 주세요.">확인 필요<small>{lot.unreconciledDelta > 0 ? '+' : ''}{lot.unreconciledDelta.toLocaleString('ko-KR', { maximumFractionDigits: 3 })}{lot.unit} 변동</small></strong>
                  : <strong className={`warehouse-lot-quantity${lot.quantity < 0 ? ' is-negative' : lot.quantity === 0 ? ' is-zero' : ''}`} title="입고·출고 누계 및 최근 재고조정으로 계산한 현재고">{lot.quantity.toLocaleString('ko-KR', { maximumFractionDigits: 3 })}<small>{lot.unit}</small></strong>}
              </article>)}</div>}
              {lots.length > 4 && <button className="warehouse-lot-more" type="button" aria-expanded={expanded} onClick={() => setExpandedWarehouseIds((current) => { const next = new Set(current); if (next.has(location.id)) next.delete(location.id); else next.add(location.id); return next })}>{expanded ? 'LOT 목록 접기' : `전체 ${lots.length}개 LOT 보기`} <ChevronDown size={16} /></button>}
            </section>
            <div className={`warehouse-alert${location.alert === '이상 없음' ? ' is-normal' : ''}`}><AlertTriangle size={15} /> <span>{location.alert}</span></div>
          </article>
        })}
      </section>
      <section className="panel table-panel inventory-movement-panel">
        <div className="panel-heading"><div><h2>{showAllMovements ? '전체 입출고 원장' : '최근 입출고'}</h2><p>LOT별 수량, 등록 사유와 증빙자료를 확인합니다.</p></div><div className="inventory-panel-actions">{movements.length > 8 && <button type="button" className="small-button" aria-pressed={showAllMovements} onClick={() => setShowAllMovements((value) => !value)}>{showAllMovements ? '최근 8건만' : `전체 ${movements.length}건`}</button>}{canManage && <button type="button" className="small-button" onClick={() => setMovementOpen(true)}><Plus size={16} /> 내역 등록</button>}</div></div>
        {movements.length === 0 ? <div className="empty-state compact"><Boxes size={28} /><h3>등록된 입출고가 없습니다</h3><p>첫 입고, 출고 또는 재고조정 내역을 등록해 보세요.</p></div> : <div className="responsive-table"><table><thead><tr><th>구분 · 품목</th><th>LOT</th><th>수량</th><th>창고</th><th>일시 · 사유</th><th>증빙</th>{canManage && <th>관리</th>}</tr></thead><tbody>{(showAllMovements ? movements : movements.slice(0, 8)).map((movement) => <tr key={movement.id}><td><div className={'movement-direction ' + movement.direction}>{movement.direction === '입고' ? <ArrowDownToLine size={17} /> : <ArrowUpFromLine size={17} />}<span><strong>{movement.product}</strong><small>{movement.id}</small></span></div></td><td><strong>{movement.lot}</strong></td><td><strong>{movement.quantity.toLocaleString()}{movement.unit}</strong></td><td>{locations.find((location) => location.id === movement.warehouseId)?.name ?? movement.warehouseId}</td><td><strong>{movement.occurredAt}</strong><span>{movement.reason}</span></td><td>{movement.evidence ? movement.evidenceId ? <button type="button" className="movement-evidence download" onClick={async () => { if (!await downloadStoredDocument(movement.evidenceId!, movement.evidence!, workspaceScope)) onToast('증빙 파일을 다운로드하지 못했습니다.') }}><Paperclip size={15} /> {movement.evidence}</button> : <span className="movement-evidence"><Paperclip size={15} /> {movement.evidence}</span> : '—'}</td>{canManage && <td><button type="button" className="movement-delete" onClick={() => void removeMovement(movement)}>삭제</button></td>}</tr>)}</tbody></table></div>}
      </section>
      {seedDemoData && <section className="panel table-panel">
        <div className="panel-heading"><div><h2>{showAllLots ? '전체 제품 재고' : '주의 재고'}</h2><p>안전재고와 출고 가능 수량 기준입니다.</p></div><button type="button" className="text-button" aria-pressed={showAllLots} onClick={() => setShowAllLots((value) => !value)}>{showAllLots ? '주의 재고만 보기' : '전체 제품 보기'} <ArrowRight size={16} /></button></div>
        <div className="responsive-table">
          <table>
            <thead><tr><th>제품</th><th>현재고</th><th>출고가능</th><th>안전재고</th><th>보관</th><th>상태</th></tr></thead>
            <tbody>{seaProducts.filter((product) => showAllLots || product.status !== '정상').map((product) => <tr key={product.id}><td><strong>{product.name}</strong><span>{product.code}</span></td><td>{product.stock.toLocaleString()}개</td><td><strong>{product.available.toLocaleString()}개</strong></td><td>{product.safetyStock.toLocaleString()}개</td><td>{product.storage}</td><td><StatusPill tone={product.status === '정상' ? 'good' : product.status === '품절' ? 'danger' : 'warning'}>{product.status}</StatusPill></td></tr>)}</tbody>
          </table>
        </div>
      </section>}
      {movementOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setMovementOpen(false)}>
        <section ref={movementDialogRef} className="modal-card inventory-movement-modal" role="dialog" aria-modal="true" aria-labelledby="inventory-movement-title">
          <header><div><span className="eyebrow">STOCK MOVEMENT</span><h2 id="inventory-movement-title">입출고 등록</h2><p>LOT와 수량, 이동 사유를 남겨 재고 변동 이력을 관리합니다.</p></div><button className="icon-button" type="button" aria-label="닫기" onClick={() => setMovementOpen(false)}><X size={21} /></button></header>
          <form onSubmit={saveMovement}>
            <div className="form-grid"><label className="form-field"><span>구분</span><select name="direction" defaultValue="입고"><option>입고</option><option>출고</option><option>재고조정</option></select></label><label className="form-field"><span>처리 일시</span><input name="occurredAt" type="datetime-local" defaultValue={defaultMovementTime} /></label></div>
            <p className="inventory-ledger-note"><Database size={16} /><span><strong>현재고 계산 기준</strong> 입고·출고는 확정 현재고에 더하고 빼며, 재고조정은 입력 수량을 해당 LOT의 실사 현재고로 확정합니다. 기존 출고만 있는 LOT은 먼저 재고조정을 등록해 주세요.</span></p>
            <div className="form-grid"><label className="form-field"><span>품목명</span><input name="product" autoFocus data-autofocus placeholder="예: 멍게젓 400g" required /></label><label className="form-field"><span>LOT 번호</span><input name="lot" placeholder="LOT-260819-01" required /></label></div>
            <div className="form-grid three"><label className="form-field"><span>수량</span><input name="quantity" type="number" min="0" step="0.001" required /></label><label className="form-field"><span>단위</span><select name="unit" defaultValue="EA"><option>EA</option><option>BOX</option><option>KG</option><option>G</option><option>ROLL</option></select></label><label className="form-field"><span>창고</span><select name="warehouseId" required defaultValue={locations[0]?.id ?? ''}><option value="" disabled>창고 선택</option>{locations.map((location) => <option value={location.id} key={location.id}>{location.name}</option>)}</select></label></div>
            <label className="form-field full"><span>처리 사유</span><textarea name="reason" rows={3} placeholder="예: 오늘 자사몰 주문 출고" required /></label>
            <label className="form-field full"><span>증빙자료 (선택)</span><input name="evidence" type="file" accept="image/*,.pdf,.xlsx,.xls,.csv" /><small>파일 원본을 고객사 자료 저장소에 보관하고 입출고 이력에서 다시 다운로드할 수 있습니다.</small></label>
            <footer><button type="button" className="button ghost" onClick={() => setMovementOpen(false)}>취소</button><button type="submit" className="button primary"><Check size={18} /> 입출고 저장</button></footer>
          </form>
        </section>
      </div>}
      {editing && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setEditing(null)}>
        <section ref={warehouseDialogRef} className="modal-card warehouse-modal" role="dialog" aria-modal="true" aria-labelledby="warehouse-modal-title">
          <header><div><span className="eyebrow">WAREHOUSE SETUP</span><h2 id="warehouse-modal-title">{editing === 'new' ? '새 창고 등록' : '창고 정보 변경'}</h2><p>보관 조건과 공간 사용 기준을 설정합니다.</p></div><button className="icon-button" type="button" aria-label="닫기" onClick={() => setEditing(null)}><X size={21} /></button></header>
          <form onSubmit={saveWarehouse}>
            <label className="form-field full"><span>창고명</span><input name="name" autoFocus data-autofocus defaultValue={editing === 'new' ? '' : editing.name} placeholder="예: 냉장 3창고" required /></label>
            <div className="form-grid"><label className="form-field"><span>보관 유형</span><select name="type" defaultValue={editing === 'new' ? '냉장' : editing.type}><option>실온</option><option>냉장</option><option>냉동</option><option>포장재</option></select></label><label className="form-field"><span>현재 온도</span><input name="temperature" defaultValue={editing === 'new' ? '3.0℃' : editing.temperature} /></label></div>
            <label className="form-field full"><span>현재 공간 사용률 (%)</span><input name="utilization" type="number" min="0" max="100" defaultValue={editing === 'new' ? 0 : editing.utilization} /></label>
            <div className="modal-note"><ShieldCheck size={18} /><p><strong>등록 후 로케이션을 세분화할 수 있습니다.</strong><span>공장관리 도면의 재고 위치에도 이 창고가 연결됩니다.</span></p></div>
            <footer><button type="button" className="button ghost" onClick={() => setEditing(null)}>취소</button><button type="submit" className="button primary"><Check size={18} /> {editing === 'new' ? '창고 등록' : '변경 저장'}</button></footer>
          </form>
        </section>
      </div>}
    </div>
  )
}

function TenantModuleOnboarding({ title, description, actionLabel, onAction }: {
  title: string; description: string; actionLabel: string; onAction: () => void
}) {
  return <div className="content-page">
    <PageHeader eyebrow="WORKSPACE SETUP" title={title} description={description} />
    <section className="panel empty-state"><Database size={34} /><h2>아직 연결된 운영 데이터가 없습니다</h2><p>이 고객사의 제품·창고·조직 정보를 등록하면 대시보드와 AI 분석이 자동으로 활성화됩니다.</p><button className="button primary" type="button" onClick={onAction}><Plus size={17} /> {actionLabel}</button></section>
  </div>
}

const seededWorkAccountIds: Record<string, string> = {
  김서원: 'USR-SUNSEA-ADMIN', 박지현: 'USR-SUNSEA-PARK', 오태식: 'USR-SUNSEA-OH',
  서동현: 'USR-SUNSEA-SEO', 윤서진: 'USR-SUNSEA-YOON',
}

function TaskModal({ initialText, requesterName, requesterId, assigneeNames, onClose, onSave }: {
  initialText: string; requesterName: string; requesterId: string; assigneeNames: string[]; onClose: () => void; onSave: (item: WorkItem) => void
}) {
  const [title, setTitle] = useState(initialText)
  const [description, setDescription] = useState('')
  const dialogRef = useDialogFocus()
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!title.trim()) return
    const form = new FormData(event.currentTarget)
    const owner = String(form.get('owner') || requesterName)
    onSave({
      id: 'WK-' + new Date().getTime().toString().slice(-8),
      title: title.trim(),
      description: description.trim() || '담당자가 업무 내용을 확인하고 완료 결과를 남깁니다.',
      owner,
      ownerId: owner === requesterName ? requesterId : seededWorkAccountIds[owner],
      requestedBy: requesterName,
      requesterId,
      due: String(form.get('due') || '오늘 18:00'),
      priority: String(form.get('priority') || '보통') as WorkItem['priority'],
      status: '업무요청',
      category: String(form.get('category') || '일반'),
    })
  }
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="modal-card task-modal" role="dialog" aria-modal="true" aria-labelledby="task-modal-title">
        <header><div><span className="eyebrow">NEW WORK COMMAND</span><h2 id="task-modal-title">새 업무 지시</h2><p>담당자, 마감, 완료 기준을 명확하게 입력하세요.</p></div><button type="button" className="icon-button" aria-label="닫기" onClick={onClose}><X size={21} /></button></header>
        <form onSubmit={submit}>
          <label className="form-field full"><span>업무 제목</span><input autoFocus data-autofocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="예: 신규 제품 표시사항 최종 검토" required /></label>
          <label className="form-field full"><span>완료 기준 · 상세 내용</span><textarea rows={4} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="완료한 것으로 판단할 수 있는 기준을 구체적으로 입력하세요." /></label>
          <div className="form-grid">
            <label className="form-field"><span>담당자</span><select name="owner" defaultValue={requesterName}>{Array.from(new Set([requesterName, ...assigneeNames])).map((name) => <option key={name}>{name}</option>)}</select></label>
            <label className="form-field"><span>업무 구분</span><select name="category" defaultValue="제품"><option>제품</option><option>생산</option><option>재고</option><option>판매채널</option><option>일반</option></select></label>
            <label className="form-field"><span>우선순위</span><select name="priority" defaultValue="높음"><option>긴급</option><option>높음</option><option>보통</option></select></label>
            <label className="form-field"><span>마감</span><input name="due" defaultValue="오늘 18:00" /></label>
          </div>
          <div className="modal-note"><ShieldCheck size={18} /><p><strong>담당자가 ‘업무 수락’ 후 수행을 시작합니다.</strong><span>수행 결과는 결재 요청과 승인 단계를 거쳐 완료됩니다.</span></p></div>
          <footer><button type="button" className="button ghost" onClick={onClose}>취소</button><button type="submit" className="button primary"><Check size={18} /> 업무 요청 보내기</button></footer>
        </form>
      </section>
    </div>
  )
}

function SupportSessionModal({ tenant, tickets, onClose, onCreate }: {
  tenant: Tenant; tickets: PlatformTicketSummary[]; onClose: () => void; onCreate: (request: SupportSessionRequest) => Promise<void>
}) {
  const dialogRef = useDialogFocus()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const tenantTickets = tickets.filter((ticket) => ticket.tenantId === tenant.id)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setBusy(true)
    setError('')
    try {
      await onCreate({
        tenantId: tenant.id,
        ticketId: String(form.get('ticket') ?? 'new'),
        scope: String(form.get('scope') ?? '연동 로그 · 읽기 전용'),
        duration: String(form.get('duration') ?? '15분'),
        reason: String(form.get('reason') ?? '').trim(),
      })
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '지원 세션 요청을 저장하지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="modal-card support-modal" role="dialog" aria-modal="true" aria-labelledby="support-title">
        <header><div><span className="eyebrow">SECURE SUPPORT</span><h2 id="support-title">{tenant.name} 지원 세션 요청</h2><p>고객사 동의 후 제한된 범위에서만 확인합니다.</p></div><button type="button" className="icon-button" aria-label="닫기" onClick={onClose}><X size={21} /></button></header>
        <form onSubmit={submit}>
          <label className="form-field full"><span>연결할 CS 티켓</span><select name="ticket">{tenantTickets.map((ticket) => <option key={ticket.id} value={ticket.id}>{ticket.id} · {ticket.title}</option>)}<option value="new">새 지원 요청</option></select></label>
          <label className="form-field full"><span>지원 사유</span><textarea name="reason" required rows={3} defaultValue="고객사가 보고한 판매채널 동기화 오류를 확인합니다." /></label>
          <div className="form-grid"><label className="form-field"><span>접근 범위</span><select name="scope"><option>연동 로그 · 읽기 전용</option><option>설정 정보 · 읽기 전용</option><option>고객 화면 공동 보기</option></select></label><label className="form-field"><span>유효 시간</span><select name="duration"><option>15분</option><option>30분</option></select></label></div>
          <div className="modal-note secure"><ShieldCheck size={19} /><p><strong>고객으로 가장하지 않습니다.</strong><span>운영자 실명과 수행 작업이 감사로그에 기록되며, 원본 데이터는 수정할 수 없습니다.</span></p></div>
          {error && <div className="modal-note"><AlertTriangle size={18} /><p><strong>저장하지 못했습니다.</strong><span>{error}</span></p></div>}
          <footer><button type="button" className="button ghost" onClick={onClose} disabled={busy}>취소</button><button type="submit" className="button primary" disabled={busy}><Headphones size={18} /> {busy ? '저장 중…' : '승인 요청 저장'}</button></footer>
        </form>
      </section>
    </div>
  )
}

export default function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus>('checking')
  const [account, setAccount] = useState<AuthAccount | null>(null)
  const isSunseaDemo = account?.tenantId === SUNSEA_TENANT_ID
  // The API scopes workspace data by the authenticated tenant and account role.
  // Match that boundary in the optimistic cache so switching accounts in the
  // same browser can never reuse another employee's filtered response.
  const workspaceScope = account?.tenantId && account.id ? `${account.tenantId}:${account.id}` : undefined
  const currentSessionIdentity = account ? sessionIdentity(account) : null
  const [mode, setMode] = useState<AppMode>('tenant')
  const [page, setPage] = useState<PageId>('ai')
  const [mobileNav, setMobileNav] = useState(false)
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 1024)
  const [messengerOpen, setMessengerOpen] = useState(false)
  const [messengerUnread, setMessengerUnread] = useState(4)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [navEditorOpen, setNavEditorOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [unread, setUnread] = useState(3)
  const [query, setQuery] = useState('')
  const [workItems, setWorkItems] = useWorkspaceState<WorkItem[]>('work-items', isSunseaDemo ? initialWorkItems : emptyWorkItems, {
    enabled: authStatus === 'signed-in' && mode === 'tenant' && !account?.requiresPasswordChange,
    scope: workspaceScope,
    seedWhenEmpty: account?.role === 'tenant-admin',
  })
  const [workRules, setWorkRules] = useWorkspaceState<WorkRule[]>('work-rules', isSunseaDemo ? initialWorkRules : emptyWorkRules, {
    enabled: authStatus === 'signed-in' && mode === 'tenant' && !account?.requiresPasswordChange,
    scope: workspaceScope,
    seedWhenEmpty: account?.role === 'tenant-admin',
  })
  const [directoryAssignees, setDirectoryAssignees] = useState<WorkAssignee[]>([])
  const [taskDraft, setTaskDraft] = useState<string | null>(null)
  const [supportTenant, setSupportTenant] = useState<Tenant | null>(null)
  const [platformFocusId, setPlatformFocusId] = useState<string>()
  const [platformDirectory, setPlatformDirectory] = useState<PlatformDirectoryState>({ tenants: [], supportTickets: [] })
  const [platformRefreshToken, setPlatformRefreshToken] = useState(0)
  const [toast, setToast] = useState('')
  const [theme, setTheme] = useState<ThemeChoice>(() => (window.localStorage.getItem('onfactory-theme') as ThemeChoice | null) ?? 'light')
  const [fontSize, setFontSize] = useState<FontChoice>(() => (window.localStorage.getItem('onfactory-font') as FontChoice | null) ?? 'standard')
  const [density, setDensity] = useState<DensityChoice>(() => (window.localStorage.getItem('onfactory-density') as DensityChoice | null) ?? 'comfortable')

  useEffect(() => {
    const resize = () => setIsMobile(window.innerWidth <= 1024)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  useEffect(() => {
    const handleSessionChange = (event: StorageEvent) => {
      if (event.key !== AUTH_SYNC_KEY || !event.newValue || authStatus !== 'signed-in') return
      try {
        const message = JSON.parse(event.newValue) as { identity?: string | null }
        if (message.identity === currentSessionIdentity) return
        setToast(message.identity
          ? '다른 탭에서 로그인 계정이 변경되었습니다. 다시 로그인해 주세요.'
          : '다른 탭에서 로그아웃했습니다. 다시 로그인해 주세요.')
        setSettingsOpen(false)
        setNavEditorOpen(false)
        setMobileNav(false)
        setMessengerOpen(false)
        setNotificationsOpen(false)
        setQuery('')
        setTaskDraft(null)
        setSupportTenant(null)
        setPlatformFocusId(undefined)
        setAccount(null)
        setMode('tenant')
        setPage('ai')
        setAuthStatus('signed-out')
      } catch { /* ignore unrelated or corrupted storage values */ }
    }
    window.addEventListener('storage', handleSessionChange)
    return () => window.removeEventListener('storage', handleSessionChange)
  }, [authStatus, currentSessionIdentity])

  useEffect(() => {
    const handleWorkspaceError = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail
      setToast(detail?.message || '공유 데이터를 저장하지 못했습니다. 다시 시도해 주세요.')
    }
    const handleAuthExpired = () => {
      setSettingsOpen(false)
      setNavEditorOpen(false)
      setMobileNav(false)
      setMessengerOpen(false)
      setNotificationsOpen(false)
      setQuery('')
      setTaskDraft(null)
      setSupportTenant(null)
      setPlatformFocusId(undefined)
      setAccount(null)
      setMode('tenant')
      setPage('ai')
      setAuthStatus('signed-out')
    }
    window.addEventListener('onfactory:workspace-error', handleWorkspaceError)
    window.addEventListener('onfactory:auth-expired', handleAuthExpired)
    return () => {
      window.removeEventListener('onfactory:workspace-error', handleWorkspaceError)
      window.removeEventListener('onfactory:auth-expired', handleAuthExpired)
    }
  }, [])

  useEffect(() => {
    let active = true
    fetch('/api/auth/session')
      .then(async (response) => {
        if (!response.ok) throw new Error('no-session')
        return response.json() as Promise<{ account: AuthAccount }>
      })
      .then(({ account: sessionAccount }) => {
        if (!active) return
        setAccount(sessionAccount)
        setAuthStatus('signed-in')
        publishSessionChange(sessionIdentity(sessionAccount))
        if (sessionAccount.role === 'platform-operator') { setMode('platform'); setPage('platform') }
      })
      .catch(() => { if (active) { setAccount(null); setAuthStatus('signed-out') } })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (authStatus !== 'signed-in' || account?.role !== 'platform-operator') {
      setPlatformDirectory({ tenants: [], supportTickets: [] })
      return
    }
    let active = true
    fetch('/api/platform/state')
      .then(async (response) => {
        const body = await response.json() as PlatformDirectoryState & { error?: { message?: string } }
        if (!response.ok) throw new Error(body.error?.message || '플랫폼 운영 데이터를 불러오지 못했습니다.')
        return body
      })
      .then((body) => { if (active) setPlatformDirectory({ tenants: body.tenants ?? [], supportTickets: body.supportTickets ?? [] }) })
      .catch((reason) => { if (active) setToast(reason instanceof Error ? reason.message : '플랫폼 운영 데이터를 불러오지 못했습니다.') })
    return () => { active = false }
  }, [account?.role, authStatus, platformRefreshToken])

  useEffect(() => {
    if (authStatus !== 'signed-in' || account?.requiresPasswordChange || mode !== 'tenant' || !workspaceScope || workRules.length === 0) return
    let active = true
    const timer = window.setTimeout(() => {
      fetch('/api/work-rules/materialize', { method: 'POST', headers: { 'x-workspace-identity': workspaceScope } })
        .then(async (response) => {
          const body = await response.json() as { created?: WorkItem[]; rules?: WorkRule[] }
          if (!response.ok) throw new Error('materialize')
          if (!active) return
          if (body.rules) void setWorkRules(body.rules, { persist: false })
          if (body.created?.length) void setWorkItems((current) => [...body.created!.filter((created) => !current.some((item) => item.id === created.id)), ...current], { persist: false })
        })
        .catch(() => { /* the next workspace read retries materialization */ })
    }, 800)
    return () => { active = false; window.clearTimeout(timer) }
  }, [account?.requiresPasswordChange, authStatus, mode, setWorkItems, setWorkRules, workRules.length, workspaceScope])

  useEffect(() => {
    if (authStatus !== 'signed-in' || account?.requiresPasswordChange || mode !== 'tenant' || !account?.tenantId) {
      setDirectoryAssignees([])
      return
    }
    let active = true
    fetch('/api/directory')
      .then(async (response) => {
        if (!response.ok) throw new Error('directory-load')
        return response.json() as Promise<{ members?: Array<{ id: string; name: string }> }>
      })
      .then(({ members }) => {
        if (!active || !Array.isArray(members)) return
        setDirectoryAssignees(members
          .filter((member) => member.id && member.name)
          .map((member) => ({ id: member.id, name: member.name })))
      })
      .catch(() => {
        if (active) setDirectoryAssignees([{ id: account.id, name: account.name }])
      })
    return () => { active = false }
  }, [account?.id, account?.name, account?.requiresPasswordChange, account?.tenantId, authStatus, mode, page])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setMobileNav(false)
      setMessengerOpen(false)
      setSettingsOpen(false)
      setNavEditorOpen(false)
      setNotificationsOpen(false)
      setTaskDraft(null)
      setSupportTenant(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 3200)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    document.body.classList.toggle('no-scroll', Boolean(taskDraft || supportTenant || messengerOpen || settingsOpen || navEditorOpen || (isMobile && mobileNav)))
    return () => document.body.classList.remove('no-scroll')
  }, [taskDraft, supportTenant, messengerOpen, settingsOpen, navEditorOpen, isMobile, mobileNav])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const applyPreferences = () => {
      const resolvedTheme = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme
      document.documentElement.dataset.theme = resolvedTheme
      document.documentElement.dataset.fontSize = fontSize
      document.documentElement.dataset.density = density
    }
    applyPreferences()
    media.addEventListener('change', applyPreferences)
    window.localStorage.setItem('onfactory-theme', theme)
    window.localStorage.setItem('onfactory-font', fontSize)
    window.localStorage.setItem('onfactory-density', density)
    return () => media.removeEventListener('change', applyPreferences)
  }, [theme, fontSize, density])

  useEffect(() => {
    if (authStatus === 'signed-in' && mode === 'platform' && account?.role !== 'platform-operator') {
      setMode('tenant')
      setPage('ai')
    }
  }, [account, authStatus, mode])

  useEffect(() => {
    if (account?.requiresPasswordChange || isSunseaDemo || !workItems.some(isSunseaFixtureWorkItem)) return
    setWorkItems((current) => current.filter((item) => !isSunseaFixtureWorkItem(item)))
  }, [account?.requiresPasswordChange, isSunseaDemo, setWorkItems, workItems])

  const tenantName = account?.tenantName ?? '고객사'
  const collaborationIdentity = {
    currentUserId: account?.id ?? '',
    currentUserName: account?.name ?? '사용자',
    currentUserTeam: account?.team ?? '미지정',
    canManage: account?.role === 'tenant-admin',
  }
  const isTenantMember = account?.role === 'tenant-member'
  const primaryTenantNotice = !isSunseaDemo
    ? { title: '워크스페이스 초기 설정을 시작해 주세요', detail: '제품·창고·판매채널을 연결하면 AI 알림이 활성화됩니다.', page: 'products' as PageId }
    : isTenantMember
    ? { title: '담당 업무 마감 시간을 확인해 주세요', detail: '내 업무 1건이 오늘 17:00에 마감됩니다.', page: 'tasks' as PageId }
    : { title: 'G마켓 SKU 오류를 확인해 주세요', detail: '주문 7건 수집에 영향을 줄 수 있습니다.', page: 'tasks' as PageId }
  const secondaryTenantNotice = !isSunseaDemo
    ? { title: '첫 공유 일정을 등록해 보세요', detail: `${tenantName} 구성원에게 일정을 공유할 수 있습니다.`, page: 'schedule' as PageId }
    : isTenantMember
    ? { title: '생산 일정이 새로 공유됐습니다', detail: '내 소속 부서의 일정을 확인해 주세요.', page: 'schedule' as PageId }
    : { title: '멍게젓 제품정보 결재 요청', detail: '박지현님이 결재 승인을 요청했습니다.', page: 'products' as PageId }

  const tenantWorkItems = isSunseaDemo ? workItems : workItems.filter((item) => !isSunseaFixtureWorkItem(item))
  const scopedWorkItems = account?.role === 'tenant-member'
    ? tenantWorkItems.filter((item) => item.ownerId === account.id || item.requesterId === account.id)
    : tenantWorkItems
  const workAssignees: WorkAssignee[] = directoryAssignees.length > 0
    ? directoryAssignees
    : isSunseaDemo
      ? Object.entries(seededWorkAccountIds).map(([name, id]) => ({ name, id }))
      : account?.tenantId ? [{ id: account.id, name: account.name }] : []
  const tenantNavAll: NavItem[] = [
    { id: 'ai', label: 'AI 업무허브', icon: Sparkles },
    { id: 'schedule', label: '일정관리', icon: CalendarDays },
    { id: 'tasks', label: '업무지시 · 결재', icon: ListChecks, badge: scopedWorkItems.filter((x) => x.status !== '결재완료').length },
    { id: 'journal', label: '일일업무일지', icon: NotebookPen },
    { id: 'products', label: '제품관리', icon: Package },
    { id: 'inventory', label: '재고 · LOT', icon: Boxes },
    { id: 'factory', label: '공장관리', icon: Factory },
    { id: 'sales', label: '판매채널', icon: Store },
    { id: 'people', label: '인사 · 조직', icon: Users },
    { id: 'documents', label: '기업 자료실', icon: FileText },
    { id: 'compliance', label: '식품안전 · 인증', icon: ShieldCheck },
  ]
  const tenantNav = account?.role === 'tenant-member' ? tenantNavAll.filter((item) => tenantMemberPages.has(item.id)) : tenantNavAll
  const tenantNavSource = tenantNav.map(({ id, label }) => ({ id, label }))
  const [tenantNavPreferences, setTenantNavPreferences] = usePersonalNavigation(tenantNavSource, `${account?.tenantId ?? 'tenant'}:${account?.id ?? 'anonymous'}`)
  const personalizedTenantNav = tenantNavPreferences.flatMap((preference) => {
    if (!preference.visible) return []
    const item = tenantNav.find((candidate) => candidate.id === preference.id)
    return item ? [{ ...item, label: preference.label || item.label }] : []
  })
  const platformTenants = platformDirectory.tenants
  const platformTickets = platformDirectory.supportTickets
  const openPlatformTickets = platformTickets.filter((ticket) => !['해결', '종료'].includes(ticket.status))
  const platformNav: NavItem[] = [
    { id: 'platform', label: '운영 개요', icon: Home },
    { id: 'tenants', label: '고객사 관리', icon: Building2, badge: platformTenants.length },
    { id: 'support', label: 'CS 지원센터', icon: Headphones, badge: openPlatformTickets.length },
    { id: 'integrations', label: '연동 상태', icon: Layers3 },
    { id: 'audit', label: '지원 세션 · 감사', icon: ShieldCheck },
  ]
  const nav = mode === 'tenant' ? personalizedTenantNav : platformNav

  const searchResults = useMemo(() => {
    const value = query.trim().toLowerCase()
    if (!value) return []
    if (mode === 'platform') {
      const tenantResults = platformTenants
        .filter((tenant) => (tenant.name + ' ' + tenant.id + ' ' + tenant.industry).toLowerCase().includes(value))
        .map((tenant) => ({ id: tenant.id, title: tenant.name, meta: tenant.id + ' · ' + tenant.service, page: 'tenants' as PageId, icon: Building2 }))
      const ticketResults = platformTickets
        .filter((ticket) => (ticket.id + ' ' + ticket.tenant + ' ' + ticket.title).toLowerCase().includes(value))
        .slice(0, 4)
        .map((ticket) => ({ id: ticket.id, title: ticket.title, meta: ticket.id + ' · ' + ticket.tenant, page: 'support' as PageId, icon: Headphones }))
      return [...tenantResults, ...ticketResults]
    }
    const products = (isSunseaDemo ? seaProducts : []).filter((product) => (product.name + ' ' + product.code + ' ' + product.category).toLowerCase().includes(value)).slice(0, 4).map((product) => ({ id: product.id, title: product.name, meta: product.code + ' · ' + product.category, page: 'products' as PageId, icon: Package }))
    const taskScope = account?.role === 'tenant-member'
      ? scopedWorkItems
      : tenantWorkItems
    const tasks = taskScope.filter((work) => (work.title + ' ' + work.owner + ' ' + work.id).toLowerCase().includes(value)).slice(0, 3).map((work) => ({ id: work.id, title: work.title, meta: work.owner + ' · ' + work.status, page: 'tasks' as PageId, icon: ListChecks }))
    return [...products, ...tasks]
  }, [account, isSunseaDemo, mode, platformTenants, platformTickets, query, scopedWorkItems, tenantWorkItems])

  const navigate = (nextPage: PageId) => {
    if (mode === 'tenant' && account?.role === 'tenant-member' && !tenantMemberPages.has(nextPage)) {
      setToast('현재 직무 권한에서는 이 메뉴에 접근할 수 없습니다.')
      setMobileNav(false)
      return
    }
    setPage(nextPage)
    setMobileNav(false)
    setQuery('')
    window.scrollTo({ top: 0, behavior: 'auto' })
  }
  const enterPlatform = () => {
    if (account?.role !== 'platform-operator') { setToast('통합 관리자는 온팩토리 운영자 계정으로만 접근할 수 있습니다.'); return }
    setMode('platform'); navigate('platform')
  }
  const requestTenantSupportAccess = () => {
    const targetTenant = platformTenants.find((tenant) => tenant.id === SUNSEA_TENANT_ID) ?? platformTenants[0]
    if (!targetTenant) { setToast('지원 세션을 요청할 고객사를 찾을 수 없습니다.'); return }
    setSupportTenant(targetTenant)
  }
  const createPlatformSupportSession = async (request: SupportSessionRequest) => {
    const tenant = platformTenants.find((item) => item.id === request.tenantId)
    if (!tenant) throw new Error('지원 세션을 요청할 고객사를 찾을 수 없습니다.')
    const response = await fetch('/api/platform/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tenantId: tenant.id,
        kind: '지원 세션 요청',
        target: `${tenant.name} · ${request.scope}`,
        message: `${request.reason} · 유효 시간 ${request.duration}`,
        reference: request.ticketId === 'new' ? '' : request.ticketId,
      }),
    })
    let body: { action?: { id: string }; error?: { message?: string } } = {}
    try { body = await response.json() as typeof body } catch { /* handled by status */ }
    if (!response.ok || !body.action) throw new Error(body.error?.message || '지원 세션 요청을 공유 운영 기록에 저장하지 못했습니다.')
    setPlatformRefreshToken((current) => current + 1)
    setToast(`${tenant.name} 지원 세션 승인 요청을 공유 감사기록에 저장했습니다.`)
  }
  const transitionTask = async (id: string, action: WorkTransitionAction, input: Record<string, unknown> = {}) => {
    if (!workspaceScope) return false
    try {
      const response = await fetch(`/api/work-items/${encodeURIComponent(id)}/transition`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-identity': workspaceScope },
        body: JSON.stringify({ action, ...input }),
      })
      const body = await response.json() as { item?: WorkItem; error?: { message?: string } }
      if (!response.ok || !body.item) { setToast(body.error?.message || '업무 상태를 변경하지 못했습니다.'); return false }
      await setWorkItems((current) => current.map((item) => item.id === id ? body.item! : item), { persist: false })
      setToast({ accept: '업무를 수락했습니다.', submit: '완료내용과 증빙을 결재 요청했습니다.', approve: '코멘트와 함께 결재 승인했습니다.', 'request-changes': '수정 요청 내용을 담당자에게 전달했습니다.' }[action])
      return true
    } catch { setToast('업무 처리 서버에 연결할 수 없습니다.'); return false }
  }
  const advanceTask = (item: WorkItem) => {
    if (item.status === '업무요청') void transitionTask(item.id, 'accept')
    else { navigate('tasks'); setToast(item.status === '수행중' ? '완료내용과 증빙자료를 입력해 결재 요청해 주세요.' : '결재 코멘트를 확인하고 승인 또는 수정 요청을 선택해 주세요.') }
  }
  const saveTask = async (item: WorkItem) => {
    const result = await setWorkItems((current) => [item, ...current])
    if (!result.ok) return
    setTaskDraft(null)
    setToast(item.owner + '님에게 업무를 지시했습니다.')
    navigate('tasks')
  }
  const createWorkRule = async (input: Record<string, unknown>) => {
    if (!workspaceScope) return false
    try {
      const response = await fetch('/api/work-rules', { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-identity': workspaceScope }, body: JSON.stringify(input) })
      const body = await response.json() as { rule?: WorkRule; created?: WorkItem[]; error?: { message?: string } }
      if (!response.ok || !body.rule) { setToast(body.error?.message || '반복 업무 규칙을 만들지 못했습니다.'); return false }
      await setWorkRules((current) => [body.rule!, ...current.filter((rule) => rule.id !== body.rule!.id)], { persist: false })
      if (body.created?.length) await setWorkItems((current) => [...body.created!.filter((created) => !current.some((item) => item.id === created.id)), ...current], { persist: false })
      setToast(body.created?.length ? `규칙을 만들고 도래 업무 ${body.created.length}건을 생성했습니다.` : '반복 업무 규칙을 만들었습니다.')
      return true
    } catch { setToast('반복 업무 서버에 연결할 수 없습니다.'); return false }
  }
  const toggleWorkRule = async (rule: WorkRule) => {
    if (!workspaceScope) return false
    try {
      const response = await fetch(`/api/work-rules/${encodeURIComponent(rule.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-workspace-identity': workspaceScope }, body: JSON.stringify({ active: !rule.active }) })
      const body = await response.json() as { rule?: WorkRule; created?: WorkItem[]; error?: { message?: string } }
      if (!response.ok || !body.rule) { setToast(body.error?.message || '반복 규칙 상태를 바꾸지 못했습니다.'); return false }
      await setWorkRules((current) => current.map((item) => item.id === rule.id ? body.rule! : item), { persist: false })
      if (body.created?.length) await setWorkItems((current) => [...body.created!.filter((created) => !current.some((item) => item.id === created.id)), ...current], { persist: false })
      setToast(body.rule.active ? '반복 업무를 다시 활성화했습니다.' : '반복 업무를 일시 중지했습니다.')
      return true
    } catch { setToast('반복 업무 서버에 연결할 수 없습니다.'); return false }
  }

  const login = async (credentials: { workspace: 'tenant' | 'platform'; email: string; password: string; remember: boolean }) => {
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(credentials),
      })
      const body = await response.json() as { account?: AuthAccount; error?: { message?: string } }
      if (!response.ok || !body.account) return { ok: false, message: body.error?.message || '로그인에 실패했습니다.' }
      setAccount(body.account)
      setAuthStatus('signed-in')
      publishSessionChange(sessionIdentity(body.account))
      if (body.account.role === 'platform-operator') { setMode('platform'); setPage('platform') }
      else { setMode('tenant'); setPage('ai') }
      setToast(`${body.account.tenantName ?? '온팩토리'} 워크스페이스에 로그인했습니다.`)
      return { ok: true, message: '로그인했습니다.' }
    } catch {
      return { ok: false, message: '인증 서버에 연결할 수 없습니다. 서버 실행 상태를 확인해 주세요.' }
    }
  }

  const logout = async () => {
    try { await fetch('/api/auth/logout', { method: 'POST' }) } catch { /* local session is cleared below */ }
    publishSessionChange(null)
    setSettingsOpen(false)
    setNavEditorOpen(false)
    setMobileNav(false)
    setMessengerOpen(false)
    setNotificationsOpen(false)
    setQuery('')
    setTaskDraft(null)
    setSupportTenant(null)
    setPlatformFocusId(undefined)
    setUnread(3)
    setMessengerUnread(4)
    setToast('')
    setAccount(null)
    setMode('tenant')
    setPage('ai')
    setAuthStatus('signed-out')
  }

  const changeInitialPassword = async (newPassword: string) => {
    try {
      const response = await fetch('/api/auth/password/change', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ newPassword }),
      })
      const body = await response.json() as { account?: AuthAccount; error?: { message?: string } }
      if (!response.ok || !body.account) return { ok: false, message: body.error?.message || '새 비밀번호를 저장하지 못했습니다.' }
      setAccount(body.account)
      publishSessionChange(sessionIdentity(body.account))
      setToast('새 비밀번호를 저장했습니다. 회사 워크스페이스를 시작합니다.')
      return { ok: true, message: '비밀번호를 변경했습니다.' }
    } catch {
      return { ok: false, message: '인증 서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.' }
    }
  }

  const renderPage = () => {
    if (mode === 'platform' && account?.role === 'platform-operator') {
      return <PlatformConsole section={page as PlatformSection} focusId={platformFocusId} refreshToken={platformRefreshToken} onSectionChange={(section) => navigate(section)} onReturnTenant={requestTenantSupportAccess} onRequestSupport={setSupportTenant} onDataChanged={() => setPlatformRefreshToken((current) => current + 1)} onToast={setToast} />
    }
    if (account?.role === 'tenant-member' && !tenantMemberPages.has(page)) {
      return <AIHome workItems={scopedWorkItems} currentUserName={account.name} currentUserId={account.id} companyName={tenantName} canAssignTasks={false} hasDemoData={isSunseaDemo} onAdvanceTask={advanceTask} onCreateTask={(text = '') => setTaskDraft(text)} onNavigate={navigate} onToast={setToast} />
    }
    switch (page) {
      case 'schedule': return <SchedulePage {...collaborationIdentity} workspaceScope={workspaceScope} seedDemoData={isSunseaDemo} onToast={setToast} />
      case 'tasks': return <WorkPage items={scopedWorkItems} rules={workRules} currentUserId={account?.id ?? ''} canAssignTasks={account?.role === 'tenant-admin'} assignees={workAssignees} workspaceScope={workspaceScope} onToast={setToast} onCreate={() => setTaskDraft('')} onTransition={transitionTask} onCreateRule={createWorkRule} onToggleRule={toggleWorkRule} />
      case 'journal': return <DailyJournalPage {...collaborationIdentity} workspaceScope={workspaceScope} seedDemoData={isSunseaDemo} onToast={setToast} />
      case 'products': return <ProductManagement onToast={setToast} canManage={account?.role === 'tenant-admin'} seedDemoData={isSunseaDemo} companyName={tenantName} workspaceScope={workspaceScope} />
      case 'inventory': return <InventoryPage onToast={setToast} canManage={account?.role === 'tenant-admin'} workspaceScope={workspaceScope} seedDemoData={isSunseaDemo} />
      case 'factory': return <FactoryManagement onToast={setToast} canManage={account?.role === 'tenant-admin'} companyName={tenantName} workspaceScope={workspaceScope} seedDemoData={isSunseaDemo} />
      case 'sales': return <SalesChannels onToast={setToast} workspaceScope={workspaceScope} seedDemoData={isSunseaDemo} companyName={tenantName} canManage={account?.role === 'tenant-admin'} />
      case 'people': return <PeopleOperationsPage onToast={setToast} canManage={account?.role === 'tenant-admin'} currentUserId={account?.id} currentUserName={account?.name ?? ''} currentUserTeam={account?.team ?? '미지정'} workspaceScope={workspaceScope} seedDemoData={isSunseaDemo} />
      case 'documents': return <CompanyLibrary workspaceScope={workspaceScope} canManage={account?.role === 'tenant-admin'} currentUserId={account?.id ?? ''} companyName={tenantName} onToast={setToast} />
      case 'compliance': return <ComplianceCenter workspaceScope={workspaceScope} seedDemoData={isSunseaDemo} canManage={account?.role === 'tenant-admin'} companyName={tenantName} onToast={setToast} />
      default: return <AIHome workItems={scopedWorkItems} currentUserName={account?.name ?? ''} currentUserId={account?.id ?? ''} companyName={tenantName} canAssignTasks={account?.role === 'tenant-admin'} hasDemoData={isSunseaDemo} onAdvanceTask={advanceTask} onCreateTask={(text = '') => setTaskDraft(text)} onNavigate={navigate} onToast={setToast} />
    }
  }

  if (authStatus === 'checking') return <main className="auth-loading" aria-live="polite"><OnFactoryMark size={48} /><strong>온팩토리</strong><span>안전한 세션을 확인하고 있습니다…</span></main>
  if (authStatus === 'signed-out') return <LoginPage onLogin={login} initialError={toast} />
  if (account?.requiresPasswordChange) return <PasswordChangePage name={account.name} email={account.email} onChange={changeInitialPassword} onLogout={logout} />

  return (
    <div className={'app-shell ' + mode + ' density-' + density}>
      <a className="skip-link" href="#main-content">본문으로 바로가기</a>
      {isMobile && mobileNav && <button type="button" className="nav-scrim" aria-label="메뉴 닫기" onClick={() => setMobileNav(false)} />}
      <aside id="main-navigation" className={'sidebar ' + (mobileNav ? 'open' : '')} aria-label={mode === 'platform' ? '플랫폼 운영 메뉴' : `${tenantName} 업무 메뉴`} aria-hidden={isMobile && !mobileNav} inert={isMobile && !mobileNav ? true : undefined}>
        <div className="brand"><OnFactoryMark /><div><strong>온팩토리</strong><span>{mode === 'platform' ? 'PLATFORM OPS' : 'FOOD ERP'}</span></div><button type="button" className="sidebar-close" aria-label="메뉴 닫기" onClick={() => setMobileNav(false)}><X size={21} /></button></div>
        {mode === 'tenant' ? (
          <button type="button" className="company-switcher" aria-label={`현재 고객사 ${tenantName}`} onClick={() => setToast(`현재 고객사는 ${tenantName}입니다.`)}><span className="company-logo">{tenantName.slice(0, 1)}</span><span><small>현재 고객사</small><strong>{tenantName}</strong></span><ChevronDown size={17} /></button>
        ) : (
          <div className="operator-badge"><span><ShieldCheck size={18} /></span><div><small>운영자 전용</small><strong>온팩토리 플랫폼</strong></div></div>
        )}
        <nav className="nav-list">
          <div className="nav-caption-row"><span className="nav-caption">{mode === 'platform' ? 'PLATFORM CONTROL' : 'WORKSPACE'}</span>{mode === 'tenant' && <WorkspaceNavigationEditButton onClick={() => setNavEditorOpen(true)} />}</div>
          {nav.map((item) => {
            const Icon = item.icon
            return <button type="button" key={item.id} className={page === item.id ? 'active' : ''} aria-label={item.label} aria-current={page === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}><Icon size={20} /><span>{item.label}</span>{item.badge !== undefined && <em>{item.badge}</em>}</button>
          })}
        </nav>
        <div className="sidebar-bottom">
          {mode === 'tenant' ? (
            account?.role === 'platform-operator' ? <button type="button" className="platform-entry" onClick={enterPlatform}><span><Building2 size={18} /></span><div><small>판매사 운영</small><strong>통합 관리자</strong></div><ArrowRight size={17} /></button> : <div className="tenant-scope-note"><ShieldCheck size={17} /><span>{tenantName} 전용 공간</span></div>
          ) : (
            <button type="button" className="platform-entry return" onClick={requestTenantSupportAccess}><span><LockKeyhole size={18} /></span><div><small>고객사 접근 · 승인 필요</small><strong>지원 세션 요청</strong></div></button>
          )}
          <div className="user-card"><span className="person-avatar">{account?.name.slice(0,1) ?? '사'}</span><div><strong>{account?.name ?? '사용자'}</strong><small>{account?.jobRole ?? (account?.role === 'platform-operator' ? 'Platform Operator' : account?.role === 'tenant-admin' ? '고객사 관리자' : '일반 직원')}</small></div><button type="button" aria-label="내 설정" onClick={() => setSettingsOpen(true)}><Settings2 size={17} /></button></div>
        </div>
      </aside>

      <div className="app-body">
        <header className="topbar">
          <div className="topbar-left"><button className="menu-button" type="button" aria-label="메뉴 열기" aria-controls="main-navigation" aria-expanded={mobileNav} onClick={() => setMobileNav(true)}><Menu size={22} /></button><div className="breadcrumb"><span>{mode === 'platform' ? '온팩토리 운영자' : tenantName}</span><strong>{pageTitles[page]}</strong></div></div>
          <div className="topbar-actions">
            <div className="global-search">
              <Search size={19} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={mode === 'platform' ? '고객사·CS 티켓 검색' : '제품·업무·LOT 통합 검색'} role="combobox" aria-expanded={searchResults.length > 0} aria-controls="search-results" aria-autocomplete="list" />
              {query && <button type="button" aria-label="검색어 지우기" onClick={() => setQuery('')}><X size={16} /></button>}
              {searchResults.length > 0 && <div className="search-popover" id="search-results" role="listbox">{searchResults.map((result) => {
                const Icon = result.icon
                return <button role="option" aria-selected="false" type="button" key={result.id} onClick={() => { setPlatformFocusId(result.id); navigate(result.page) }}><span><Icon size={17} /></span><div><strong>{result.title}</strong><small>{result.meta}</small></div><ArrowRight size={15} /></button>
              })}</div>}
            </div>
            {mode === 'tenant' && <button type="button" className={'top-icon-button messenger-trigger ' + (messengerOpen ? 'active' : '')} aria-label={`사내 메신저 열기, 읽지 않은 대화 ${messengerUnread}개`} aria-controls="company-messenger" aria-expanded={messengerOpen} onClick={() => { setMessengerOpen((value) => !value); setNotificationsOpen(false) }}><ChatBubbleIcon />{messengerUnread > 0 && <span>{messengerUnread}</span>}</button>}
            <div className="notification-wrap">
              <button type="button" className={'top-icon-button ' + (notificationsOpen ? 'active' : '')} aria-label={'알림 ' + unread + '개'} aria-controls="notification-panel" aria-expanded={notificationsOpen} onClick={() => { setNotificationsOpen((value) => !value); setMessengerOpen(false) }}><NotificationBellIcon />{unread > 0 && <span>{unread}</span>}</button>
              {notificationsOpen && <section className="notification-panel" id="notification-panel">
                <header><div><h2>알림</h2><p>업무와 시스템 변화를 알려드려요.</p></div><button type="button" onClick={() => setUnread(0)}>모두 읽음</button></header>
                <div className="notification-list">
                  <button type="button" onClick={() => { navigate(mode === 'tenant' ? primaryTenantNotice.page : 'support'); setNotificationsOpen(false) }}><span className="notice-icon red"><AlertTriangle size={17} /></span><div><strong>{mode === 'tenant' ? primaryTenantNotice.title : 'P1 CS 티켓의 SLA가 37분 남았습니다'}</strong><p>{mode === 'tenant' ? primaryTenantNotice.detail : '포항시수산가공협동조합 · 연동 오류'}</p><small>5분 전</small></div></button>
                  <button type="button" onClick={() => { navigate(mode === 'tenant' ? secondaryTenantNotice.page : 'integrations'); setNotificationsOpen(false) }}><span className="notice-icon amber"><Package size={17} /></span><div><strong>{mode === 'tenant' ? secondaryTenantNotice.title : 'G마켓 연동 1개가 주의 상태입니다'}</strong><p>{mode === 'tenant' ? secondaryTenantNotice.detail : 'SKU 27개를 다시 매핑해야 합니다.'}</p><small>18분 전</small></div></button>
                  <button type="button" onClick={() => setNotificationsOpen(false)}><span className="notice-icon green"><CheckCircle2 size={17} /></span><div><strong>{mode === 'tenant' && !isSunseaDemo ? '초기 데이터 연결을 기다리고 있습니다' : '오늘 자동 동기화가 완료됐습니다'}</strong><p>{mode === 'tenant' && !isSunseaDemo ? '제품·창고·판매채널을 등록하면 자동 동기화가 시작됩니다.' : '판매·재고 데이터가 최신 상태입니다.'}</p><small>42분 전</small></div></button>
                </div>
              </section>}
            </div>
          </div>
        </header>
        <main id="main-content" className="main-content" tabIndex={-1}>{renderPage()}</main>
      </div>

      <MessengerDrawer {...collaborationIdentity} workspaceScope={workspaceScope} seedDemoData={isSunseaDemo} open={messengerOpen} onClose={() => setMessengerOpen(false)} onToast={setToast} onUnreadChange={setMessengerUnread} />
      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} profileName={account?.name ?? '사용자'} profileRole={account?.jobRole ?? '사용자'} companyName={account?.tenantName ?? '온팩토리'} theme={theme} fontSize={fontSize} density={density} onThemeChange={setTheme} onFontSizeChange={setFontSize} onDensityChange={setDensity} onLogout={logout} />
      <WorkspaceNavigationEditor open={navEditorOpen} source={tenantNavSource} preferences={tenantNavPreferences} onChange={setTenantNavPreferences} onClose={() => setNavEditorOpen(false)} />
      {taskDraft !== null && <TaskModal initialText={taskDraft} requesterName={account?.name ?? '사용자'} requesterId={account?.id ?? ''} assigneeNames={isSunseaDemo ? ['김서원', '박지현', '오태식', '서동현', '윤서진'] : []} onClose={() => setTaskDraft(null)} onSave={saveTask} />}
      {supportTenant && <SupportSessionModal tenant={supportTenant} tickets={platformTickets} onClose={() => setSupportTenant(null)} onCreate={createPlatformSupportSession} />}
      {toast && <div className="toast" role="status"><CheckCircle2 size={19} /><span>{toast}</span><button type="button" aria-label="알림 닫기" onClick={() => setToast('')}><X size={16} /></button></div>}
    </div>
  )
}

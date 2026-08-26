import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  AlertTriangle, ArrowDownToLine, ArrowRight, ArrowUpFromLine, BarChart3, Boxes, Building2, Check,
  CalendarDays, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, ClipboardCheck, Clock3,
  Database, Factory, FileClock, FileText, Headphones, Home, Layers3, ListChecks, LockKeyhole, Menu,
  NotebookPen, Package, Paperclip, PauseCircle, PlayCircle, Plus, Repeat2, Search, Settings2, ShieldCheck, ShoppingCart,
  Sparkles, Store, Trash2, Upload, Users, Warehouse, X, GripVertical, EyeOff, RotateCcw,
  Briefcase, FileStack, FileSignature, FolderKanban, Landmark, Award, ExternalLink,
} from 'lucide-react'
import AIChat from './components/AIChat'
import { ChatBubbleIcon, NotificationBellIcon, OnFactoryMark } from './components/AppIcons'
import { LoginPage, PasswordChangePage, ProfileEditor, SettingsDrawer, type AccentChoice, type EasyModeChoice, type FontChoice, type ThemeChoice } from './components/AccessExperience'
import { ProjectSpacesPage } from './components/ProjectSpaces'
import { TaxAssetsPage } from './components/TaxAssets'
import { IpRightsPage } from './components/IpRights'
import { ProductManagement, SalesChannels } from './components/BusinessPages'
import { BillingDashboard } from './components/BillingDashboard'
import { CompanyLibrary } from './components/CompanyLibrary'
import { DailyJournalPage, MessengerDrawer, SchedulePage } from './components/CollaborationSuite'
import { ComplianceCenter } from './components/ComplianceCenter'
import {
  DashboardLayoutButton, FrequentFilesWidget, QuickLinksWidget, defaultDashboardWidgets,
  useDashboardPreferences, widgetClass, type DashboardWidgetPreference,
} from './components/DashboardWorkspace'
import { FactoryManagement } from './components/FactoryManagement'
import './components/InventoryEnhancements.css'
import { PeopleOperationsPage } from './components/PeopleOperations'
import { ItServicesPage, type ItServicesView } from './components/ItServices'
import { ApprovalQueue } from './components/ApprovalQueue'
import { SupportProgramsWidget } from './components/SupportProgramsWidget'
import { PersonalTodoWidget } from './components/PersonalTodoWidget'
import { brandLabelForIndustry, navigationForIndustry, routeLabel, routesForIndustry, type TenantRouteId } from './modules/registry'
import PlatformConsole, { type PlatformSection } from './components/PlatformConsole'
import { StatusBadge } from './components/StatusBadge'
import { WorkspaceNavigationEditButton, WorkspaceNavigationEditor, usePersonalNavigation } from './components/WorkspaceNavigation'
import { useWorkspaceState } from './hooks/useWorkspaceState'
import { deleteDocumentAttachment, deleteDocumentAttachments, uploadDocumentAttachments } from './utils/documentAttachments'
import { formatDateLabel, formatDateTime, formatMonthLabel, formatWorkDue, formatWorkRuleRun, seoulDateInputValue, seoulDateTimeInputValue, seoulLocalToUtcIso, toIsoUtc } from './utils/dateTime'
import { dayKind, holidayName } from './utils/koreanHolidays'
import {
  type Tenant, type WorkEvidence, type WorkItem, type WorkRule,
} from './domainData'

type TenantPage = 'ai' | 'schedule' | 'tasks' | 'approvals' | 'journal' | 'projects' | 'finance' | 'ip' | 'products' | 'inventory' | 'factory' | 'sales' | 'people' | 'documents' | 'compliance' | 'it-projects' | 'it-deliverables' | 'it-contracts'
type PageId = TenantPage | PlatformSection | 'billing'
type AppMode = 'tenant' | 'platform'
type NavItem = { id: PageId; label: string; icon: typeof Sparkles; badge?: number }
type OperatorMode = { operatorId: string; operatorName: string; tenantId: string; tenantName: string; enteredAt: string | null }
type AuthAccount = { id: string; name: string; email: string; role: 'tenant-admin' | 'tenant-member' | 'platform-operator'; tenantId: string | null; tenantName: string | null; approved: boolean; team?: string; jobRole?: string; requiresPasswordChange?: boolean; industryType?: string; operatorMode?: OperatorMode }
type AuthStatus = 'checking' | 'signed-out' | 'signed-in'
type PlatformTicketSummary = { id: string; tenantId: string; tenant: string; title: string; priority: string; status: string; sla: string; owner: string }
type PlatformDirectoryState = { tenants: Tenant[]; supportTickets: PlatformTicketSummary[] }
type SupportSessionRequest = { tenantId: string; ticketId: string; scope: string; duration: string; reason: string }

const tenantMemberPages = new Set<PageId>(['ai', 'schedule', 'tasks', 'journal', 'projects', 'finance', 'ip', 'products', 'inventory', 'factory', 'people', 'documents', 'compliance', 'it-projects', 'it-deliverables', 'it-contracts'])
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

type DashboardProduct = {
  id: string
  name: string
  code: string
  category: string
  stock: number
  available: number
  safetyStock: number
  labelStatus: string
  status: string
}

type DashboardSalesChannel = {
  id: string
  name: string
  orders: number
  units: number
  revenue: number
  status: string
  connectionStatus?: string
}

type DashboardCalendarEvent = {
  id: string
  title: string
  date: string
  start: string
  end: string
  scope: 'company' | 'department' | 'personal'
  department: string
  location: string
}

const platformPageTitles: Record<PlatformSection | 'billing', string> = {
  billing: '비용 · 포인트',
  platform: '플랫폼 운영 개요', tenants: '고객사 관리', support: 'CS 지원센터',
  integrations: '연동 상태', audit: '지원 세션 · 감사로그',
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

function SharedCalendarPreview({ onOpen, events }: { onOpen: () => void; events: DashboardCalendarEvent[] }) {
  const todayKey = seoulDateInputValue()
  const todayDate = new Date(`${todayKey}T00:00:00Z`)
  const mondayOffset = (todayDate.getUTCDay() + 6) % 7
  const weekStart = new Date(todayDate)
  weekStart.setUTCDate(weekStart.getUTCDate() - mondayOffset)
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(weekStart)
    date.setUTCDate(date.getUTCDate() + index)
    const key = date.toISOString().slice(0, 10)
    const dayEvents = events.filter((event) => event.date.slice(0, 10) === key)
    return { key, day: date.getUTCDate(), today: key === todayKey, kind: dayKind(key), holiday: holidayName(key), event: dayEvents[0]?.scope }
  })
  const todayEvents = events
    .filter((event) => event.date.slice(0, 10) === todayKey)
    .sort((a, b) => a.start.localeCompare(b.start))
  const monthLabel = formatMonthLabel(todayDate)
  const todayHoliday = holidayName(todayKey)
  return <section className="home-calendar-card dashboard-section-card" aria-labelledby="home-calendar-title">
    <header className="dashboard-section-header"><div className="dashboard-section-title"><span className="dashboard-section-icon"><CalendarDays size={18} /></span><h2 id="home-calendar-title">공유 일정</h2></div><button className="text-button" type="button" onClick={onOpen}>전체 보기 <ArrowRight size={16} /></button></header>
    <div className="dashboard-section-body"><p className="home-calendar-month">{monthLabel}{todayHoliday && <em className="home-calendar-holiday">오늘 · {todayHoliday}</em>}</p>
      <div className="mini-weekdays" aria-hidden="true">{['월', '화', '수', '목', '금', '토', '일'].map((day) => <span className={day === '일' ? 'is-sun' : day === '토' ? 'is-sat' : ''} key={day}>{day}</span>)}</div>
      <div className="mini-calendar-days">{days.map((item) => <button type="button" className={`${item.today ? 'today' : ''}${item.kind === 'holiday' || item.kind === 'sunday' ? ' is-holiday-day' : item.kind === 'saturday' ? ' is-saturday' : ''}`} title={item.holiday ?? undefined} key={item.key} onClick={onOpen}><span>{item.day}</span>{item.event && <i className={item.event} />}</button>)}</div>
      {todayEvents.length > 0 ? <div className="today-agenda">{todayEvents.slice(0, 2).map((event) => <article key={event.id}><time>{event.start}</time><span className={`agenda-color ${event.scope === 'department' ? 'quality' : event.scope}`} /><div><strong>{event.title}</strong><p>{event.department} · {event.location || '장소 미정'}</p></div></article>)}</div> : <div className="empty-state"><CalendarDays size={25} /><h3>오늘 공유 일정이 없습니다</h3><p>일정을 등록하면 권한이 있는 직원에게 바로 공유됩니다.</p></div>}
      <button className="button secondary full" type="button" onClick={onOpen}><CalendarDays size={17} /> 일정 등록</button>
    </div>
  </section>
}

const dashboardWidgetLabels: Record<DashboardWidgetPreference['id'], string> = {
  summary: '오늘 핵심 현황',
  ai: 'AI 업무 대화',
  files: '자주 찾는 파일',
  schedule: '공유 일정',
  todo: '내 To-do',
  work: '다음 업무',
  links: '업무 바로가기',
  alert: '중요 알림',
  support: '정부 지원사업',
}

type DashboardDropTarget = {
  id: DashboardWidgetPreference['id'] | 'end'
  edge: 'before' | 'after'
}

function AIHome({ workItems, products, salesChannels, calendarEvents, currentUserName, currentUserId, companyName, canAssignTasks, workspaceScope, easyMode = false, industryType, pendingProposals = 0, onAdvanceTask, onCreateTask, onNavigate, onOpenAlerts, onToast }: {
  pendingProposals?: number
  workItems: WorkItem[]
  products: DashboardProduct[]
  salesChannels: DashboardSalesChannel[]
  calendarEvents: DashboardCalendarEvent[]
  currentUserName: string
  currentUserId: string
  companyName: string
  canAssignTasks: boolean
  workspaceScope?: string
  easyMode?: boolean
  industryType?: string
  onAdvanceTask: (item: WorkItem) => void
  onCreateTask: (text?: string, completionCriteria?: string) => void
  onNavigate: (page: PageId) => void
  onOpenAlerts: () => void
  onToast: (message: string) => void
}) {
  const openWork = workItems.filter((item) => item.status !== '결재완료')
  const myWork = openWork.filter((item) => item.ownerId === currentUserId || (item.requesterId === currentUserId && item.status === '결재대기'))
  const today = new Date()
  const todayIso = seoulDateInputValue(today)
  const todayLabel = formatDateLabel(today)
  const todayEvents = calendarEvents.filter((event) => event.date.slice(0, 10) === todayIso)
  const totalOrders = salesChannels.reduce((sum, channel) => sum + (Number.isFinite(channel.orders) ? channel.orders : 0), 0)
  const productAlerts = products.filter((product) => product.status !== '정상' || !['승인', '정상'].includes(product.labelStatus))
  const channelAlerts = salesChannels.filter((channel) => ['주의', '오류'].includes(channel.status))
  const urgentWork = openWork.filter((item) => item.priority === '긴급')
  const attentionCount = productAlerts.length + channelAlerts.length + urgentWork.length
  const operatingDataAvailable = products.length > 0 || salesChannels.length > 0 || calendarEvents.length > 0 || workItems.length > 0
  const dashboardAlert = productAlerts[0]
    ? { title: `${productAlerts[0].name} 점검이 필요해요`, detail: `제품 상태 ${productAlerts[0].status} · 표시정보 ${productAlerts[0].labelStatus}`, page: 'products' as PageId }
    : channelAlerts[0]
      ? { title: `${channelAlerts[0].name} 연결 상태를 확인해 주세요`, detail: `현재 채널 상태가 ${channelAlerts[0].status}로 보고됐습니다.`, page: 'sales' as PageId }
      : urgentWork[0]
        ? { title: urgentWork[0].title, detail: `${formatWorkDue(urgentWork[0].due)} 마감 · ${workStatusLabel(urgentWork[0].status)}`, page: 'tasks' as PageId }
        : operatingDataAvailable
          ? { title: '현재 긴급 점검 항목이 없습니다', detail: '등록된 제품·채널·업무에서 긴급 상태가 발견되지 않았습니다.', page: 'tasks' as PageId }
          : { title: '운영 데이터를 먼저 연결해 주세요', detail: '제품·창고·판매채널을 등록하면 AI 선제 알림이 시작됩니다.', page: 'products' as PageId }
  const [layoutOpen, setLayoutOpen] = useState(false)
  const [widgetPreferences, setWidgetPreferences] = useDashboardPreferences(`${companyName}:${currentUserId}`)
  const [draggingWidgetId, setDraggingWidgetId] = useState<DashboardWidgetPreference['id'] | null>(null)
  const [keyboardWidgetId, setKeyboardWidgetId] = useState<DashboardWidgetPreference['id'] | null>(null)
  const [dropTarget, setDropTarget] = useState<DashboardDropTarget | null>(null)
  const [layoutAnnouncement, setLayoutAnnouncement] = useState('')
  const aiContext = {
    date: todayIso,
    company: companyName,
    salesChannels: salesChannels.map(({ name, orders, units, revenue, status }) => canAssignTasks
      ? { name, orders, units, revenue, status }
      : { name, status }),
    products: products.map(({ name, stock, available, safetyStock, labelStatus, status }) => ({
      name, stock, available, safetyStock, labelStatus, status,
    })),
    sharedSchedule: calendarEvents,
    openWork: canAssignTasks ? openWork : myWork,
  }

  const visibleWidgets = widgetPreferences.filter((item) => item.id !== 'summary' && item.visible)
  const hiddenWidgets = widgetPreferences.filter((item) => item.id !== 'summary' && !item.visible)

  const updateWidget = (id: DashboardWidgetPreference['id'], patch: Partial<DashboardWidgetPreference>) => {
    setWidgetPreferences((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item))
  }

  const moveWidgetBy = (id: DashboardWidgetPreference['id'], direction: -1 | 1) => {
    setWidgetPreferences((current) => {
      const visible = current.filter((item) => item.id !== 'summary' && item.visible)
      const sourceIndex = visible.findIndex((item) => item.id === id)
      const targetIndex = sourceIndex + direction
      if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= visible.length) return current
      const ordered = [...visible]
      ;[ordered[sourceIndex], ordered[targetIndex]] = [ordered[targetIndex], ordered[sourceIndex]]
      let visibleIndex = 0
      return current.map((item) => item.id !== 'summary' && item.visible ? ordered[visibleIndex++] : item)
    })
    setLayoutAnnouncement(`${dashboardWidgetLabels[id]} 위젯을 ${direction < 0 ? '앞' : '뒤'} 칸으로 이동했습니다.`)
  }

  const moveWidgetRelative = (sourceId: DashboardWidgetPreference['id'], targetId: DashboardWidgetPreference['id'], edge: 'before' | 'after') => {
    if (sourceId === targetId) return
    setWidgetPreferences((current) => {
      const visible = current.filter((item) => item.id !== 'summary' && item.visible)
      const moving = visible.find((item) => item.id === sourceId)
      if (!moving || !visible.some((item) => item.id === targetId)) return current
      const ordered = visible.filter((item) => item.id !== sourceId)
      const targetIndex = ordered.findIndex((item) => item.id === targetId)
      ordered.splice(targetIndex + (edge === 'after' ? 1 : 0), 0, moving)
      let visibleIndex = 0
      return current.map((item) => item.id !== 'summary' && item.visible ? ordered[visibleIndex++] : item)
    })
    setLayoutAnnouncement(`${dashboardWidgetLabels[sourceId]} 위젯이 빈 슬롯에 맞춰 정렬되었습니다.`)
  }

  const moveWidgetToEnd = (sourceId: DashboardWidgetPreference['id']) => {
    setWidgetPreferences((current) => {
      const visible = current.filter((item) => item.id !== 'summary' && item.visible)
      const moving = visible.find((item) => item.id === sourceId)
      if (!moving || visible.at(-1)?.id === sourceId) return current
      const ordered = [...visible.filter((item) => item.id !== sourceId), moving]
      let visibleIndex = 0
      return current.map((item) => item.id !== 'summary' && item.visible ? ordered[visibleIndex++] : item)
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
    if (!preference.visible || preference.id === 'summary') return null
    let content: ReactNode
    if (preference.id === 'ai') {
      content = <AIChat companyName={companyName} canCreateTask={canAssignTasks} canViewCommercial={canAssignTasks} operatingDataAvailable={operatingDataAvailable} workspaceScope={workspaceScope} industryType={industryType} onCreateTask={(text) => onCreateTask(text)} context={aiContext} />
    } else if (preference.id === 'schedule') {
      content = <SharedCalendarPreview events={calendarEvents} onOpen={() => onNavigate('schedule')} />
    } else if (preference.id === 'todo') {
      content = <PersonalTodoWidget workspaceScope={workspaceScope} onNavigate={onNavigate} onToast={onToast} />
    } else if (preference.id === 'links') {
      content = <QuickLinksWidget scope={`${companyName}:${currentUserId}`} onToast={onToast} />
    } else if (preference.id === 'files') {
      content = <FrequentFilesWidget workspaceScope={workspaceScope} onOpenLibrary={() => onNavigate('documents')} onToast={onToast} />
    } else if (preference.id === 'support') {
      content = <SupportProgramsWidget workspaceScope={workspaceScope} />
    } else if (preference.id === 'work') {
      content = <section className="my-work-card dashboard-section-card">
        <header className="dashboard-section-header"><div className="dashboard-section-title"><span className="dashboard-section-icon"><ListChecks size={18} /></span><h2>다음 업무</h2></div><button type="button" className="text-button" onClick={() => onNavigate('tasks')}>전체 보기 <ArrowRight size={16} /></button></header>
        <div className="work-mini-list dashboard-section-body">
          {myWork.length === 0 && <div className="empty-state compact"><CheckCircle2 size={26} /><h3>지금 처리할 업무가 없습니다</h3><p>새 업무가 배정되면 여기에 표시됩니다.</p></div>}
          {myWork.slice(0, 2).map((item) => <article className="work-mini" key={item.id}>
            <div className="work-mini-top"><StatusBadge className="status-pill" dot tone={item.priority === '긴급' ? 'danger' : item.priority === '높음' ? 'warning' : 'neutral'}>{item.priority}</StatusBadge><StatusBadge className="status-pill" dot tone={item.status === '결재대기' ? 'info' : 'neutral'}>{workStatusLabel(item.status)}</StatusBadge></div>
            <h3>{item.title}</h3><p>{item.owner} · {formatWorkDue(item.due)}</p>
            <button type="button" disabled={item.status === '결재대기' && item.requesterId !== currentUserId} onClick={() => onAdvanceTask(item)}>{item.status === '업무요청' ? '시작하기' : item.status === '수행중' ? (item.review?.decision === 'changes-requested' ? '고쳐서 다시 내기' : '완료 보고하기') : item.requesterId === currentUserId ? '확인하기' : '기다리는 중'} <ArrowRight size={15} /></button>
          </article>)}
        </div>
      </section>
    } else {
      content = <section className={'priority-alert-bar dashboard-section-card ' + (!operatingDataAvailable ? 'setup' : attentionCount === 0 || !canAssignTasks ? 'neutral' : '')}>
        <header className="dashboard-section-header"><div className="dashboard-section-title"><span className="dashboard-section-icon"><AlertTriangle size={18} /></span><h2>중요 알림</h2></div><button className="text-button" type="button" onClick={onOpenAlerts}>전체 보기 <ArrowRight size={15} /></button></header>
        <div className="priority-alert-content"><span className="priority-alert-icon"><AlertTriangle size={20} /></span><div><strong>{dashboardAlert.title}</strong><p>{dashboardAlert.detail}</p></div><button className="small-button" type="button" onClick={() => onNavigate(dashboardAlert.page)}>{!operatingDataAvailable ? '초기 설정' : '상세 확인'} <ArrowRight size={15} /></button></div>
      </section>
    }
    const visibleIndex = visibleWidgets.findIndex((item) => item.id === preference.id)
    const targetEdge = dropTarget?.id === preference.id ? dropTarget.edge : null
    return <div
      className={`${widgetClass(preference)} dashboard-editable-widget${layoutOpen ? ' is-editing' : ''}${draggingWidgetId === preference.id ? ' is-dragging' : ''}${keyboardWidgetId === preference.id ? ' is-keyboard-moving' : ''}${targetEdge ? ` is-drop-${targetEdge}` : ''}`}
      data-widget-id={preference.id}
      key={preference.id}
      draggable={layoutOpen}
      onDragStart={(event) => {
        if (!layoutOpen) return
        setDraggingWidgetId(preference.id)
        setDropTarget(null)
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', preference.id)
      }}
      onDragEnd={() => { setDraggingWidgetId(null); setDropTarget(null) }}
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

  // 쉬운 화면: 위젯 대시보드 대신, 큰 타일 4개와 "지금 처리할 업무"만 보여주는
  // 단순 홈으로 완전히 전환한다. 정보를 줄이는 것이 핵심이다.
  if (easyMode) {
    const todayHoliday = holidayName(todayIso)
    return <div className="easy-home">
      <header className="easy-home-head">
        <h1>안녕하세요, {currentUserName}님</h1>
        <p>{todayLabel}{todayHoliday ? ` · ${todayHoliday}` : ''} · {companyName}</p>
      </header>
      <div className="easy-tiles">
        <button type="button" className="tile-blue" onClick={() => onNavigate('tasks')}><ListChecks size={30} /><strong>내 업무</strong><em>{myWork.length}건</em><span>확인하고 처리하기</span></button>
        <button type="button" className="tile-teal" onClick={() => onNavigate('schedule')}><CalendarDays size={30} /><strong>오늘 일정</strong><em>{todayEvents.length}건</em><span>달력에서 보기</span></button>
        <button type="button" className="tile-violet" onClick={() => onNavigate('journal')}><NotebookPen size={30} /><strong>업무일지</strong><span>오늘 일지 쓰기</span></button>
        <button type="button" className="tile-green" onClick={() => onNavigate('people')}><Users size={30} /><strong>휴가 · 인사</strong><span>휴가 신청하기</span></button>
      </div>
      <PersonalTodoWidget workspaceScope={workspaceScope} onNavigate={onNavigate} onToast={onToast} />
      <section className="easy-work-list" aria-label="지금 처리할 업무">
        <h2>지금 처리할 업무</h2>
        {myWork.length === 0
          ? <p className="easy-empty">지금 처리할 업무가 없습니다.<br />새 업무가 배정되면 여기에 표시됩니다.</p>
          : <>
            {myWork.slice(0, 3).map((item) => <article key={item.id}>
              <div><strong>{item.title}</strong><span>{formatWorkDue(item.due)}까지 · {item.requestedBy} 요청</span></div>
              <button type="button" onClick={() => onAdvanceTask(item)}>{item.status === '업무요청' ? '시작하기' : item.status === '수행중' ? '완료 보고' : '확인하기'}</button>
            </article>)}
            {myWork.length > 3 && <button className="easy-more" type="button" onClick={() => onNavigate('tasks')}>업무 {myWork.length}건 모두 보기</button>}
          </>}
      </section>
    </div>
  }

  return (
    <div className="home-page ai-home-page">
      <PageHeader
        eyebrow={`${todayLabel} · ${companyName}`}
        title={`안녕하세요, ${currentUserName}님`}
        description="AI에게 업무 정보를 묻거나, 오늘 처리할 일정과 결재를 확인하세요."
        action={<><div className="home-header-chips" aria-label="오늘 핵심 현황">
          {canAssignTasks
            ? <button className={totalOrders === 0 ? 'is-neutral' : ''} type="button" aria-label={`온라인 주문 ${totalOrders}건`} onClick={() => onNavigate('sales')}><ShoppingCart size={15} /><span>온라인 주문</span><strong>{totalOrders.toLocaleString('ko-KR')}</strong></button>
            : <button className={todayEvents.length === 0 ? 'is-neutral' : ''} type="button" aria-label={`오늘 일정 ${todayEvents.length}건`} onClick={() => onNavigate('schedule')}><CalendarDays size={15} /><span>오늘 일정</span><strong>{todayEvents.length}</strong></button>}
          <button className={myWork.length === 0 ? 'is-neutral' : ''} type="button" aria-label={`확인할 업무 ${myWork.length}건`} onClick={() => onNavigate('tasks')}><ListChecks size={15} /><span>확인 업무</span><strong>{myWork.length}</strong></button>
          <button className={attentionCount === 0 ? 'is-neutral' : ''} type="button" aria-label={`AI 알림 ${attentionCount}건`} onClick={onOpenAlerts}><Sparkles size={15} /><span>AI 알림</span><strong>{attentionCount}</strong></button>
          {canAssignTasks && <button className={pendingProposals === 0 ? 'is-neutral' : 'is-attention'} type="button" aria-label={`검토할 AI 제안 ${pendingProposals}건`} onClick={() => onNavigate('approvals')}><ClipboardCheck size={15} /><span>AI 제안</span><strong>{pendingProposals}</strong></button>}
        </div>{layoutOpen ? <button className="button primary" type="button" onClick={finishLayoutEdit}><Check size={18} /> 편집 완료</button> : <DashboardLayoutButton onClick={() => setLayoutOpen(true)} />}{canAssignTasks ? <button className="button primary" type="button" onClick={() => onCreateTask()}><Plus size={18} /> 새 업무 지시</button> : <StatusBadge className="status-pill" tone="neutral">직원용 업무 화면</StatusBadge>}</>}
      />
      {layoutOpen && <section className="dashboard-layout-workbench" aria-labelledby="dashboard-layout-workbench-title">
        <div className="dashboard-layout-guide"><span className="dashboard-layout-guide-icon"><GripVertical size={19} /></span><div><h2 id="dashboard-layout-workbench-title">블록을 끌면 놓을 수 있는 슬롯 가이드가 나타납니다</h2><p>블록 아무 곳이나 잡아 끌어 보세요. 파란 가이드가 표시된 슬롯에 놓으면 자동으로 격자에 맞춰지고, 순서와 너비는 이 계정에 바로 저장됩니다. 핸들을 누르면 방향키로도 이동할 수 있습니다.</p></div><span className="dashboard-layout-saved"><Check size={15} /> 개인 저장</span><button type="button" className="small-button" onClick={() => { setWidgetPreferences(defaultDashboardWidgets.map((item) => ({ ...item }))); setKeyboardWidgetId(null); setLayoutAnnouncement('기본 위젯 배치로 되돌렸습니다.') }}><RotateCcw size={15} /> 기본 배치</button></div>
        <div className="dashboard-hidden-widgets"><strong>숨긴 위젯</strong>{hiddenWidgets.length === 0 ? <span>모든 위젯이 표시 중입니다.</span> : hiddenWidgets.map((item) => <button type="button" key={item.id} onClick={() => { updateWidget(item.id, { visible: true }); setLayoutAnnouncement(`${dashboardWidgetLabels[item.id]} 위젯을 다시 표시했습니다.`) }}><Plus size={14} /> {dashboardWidgetLabels[item.id]}</button>)}</div>
      </section>}
      <div className={`dashboard-widget-grid${layoutOpen ? ' is-layout-editing' : ''}${draggingWidgetId ? ' is-drag-active' : ''}`}>
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
const workStatusLabels: Record<WorkItem['status'], string> = {
  '업무요청': '시작 전',
  '수행중': '진행 중',
  '결재대기': '확인 기다리는 중',
  '결재완료': '완료',
}
const legacyCompletionCriteria = '담당자가 업무 내용을 확인하고 완료 결과를 남깁니다.'
const workStatusLabel = (status: WorkItem['status']) => workStatusLabels[status]
const explicitCompletionCriteria = (item: WorkItem) => {
  const value = item.description?.trim() ?? ''
  return value && value !== legacyCompletionCriteria ? value : ''
}
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
  return <div className="modal-backdrop workflow-sheet-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) void discardAndClose() }}>
    <section ref={dialogRef} className="modal-card workflow-modal workflow-completion-sheet" role="dialog" aria-modal="true" aria-labelledby="completion-modal-title">
      <header><div><span className="eyebrow">COMPLETE WORK</span><h2 id="completion-modal-title">완료 보고하기</h2><p>{item.title}</p></div><button type="button" className="icon-button" aria-label="닫기" disabled={busy || uploading} onClick={() => void discardAndClose()}><X size={21} /></button></header>
      <form onSubmit={submit}>
        <label className="form-field full"><span>무엇을 했나요? <em>필수</em></span><textarea autoFocus data-autofocus rows={3} value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="완료한 내용과 결과를 짧게 적어 주세요." required /></label>
        <section className="workflow-upload workflow-upload-compact" aria-labelledby="work-evidence-title"><div><h3 id="work-evidence-title">사진·파일 첨부 <small>선택</small></h3><p>필요한 경우에만 사진이나 증빙 파일을 추가하세요.</p></div><input ref={inputRef} className="sr-only" type="file" multiple onChange={async (event) => {
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
        }} /><button className="button secondary" type="button" disabled={uploading || evidence.length >= 10} onClick={() => inputRef.current?.click()}><Paperclip size={17} /> {uploading ? '업로드 중…' : '파일 추가'}</button></section>
        {uploadError && <p className="workflow-upload-error" role="alert">{uploadError}</p>}
        {evidence.length > 0 && <div className="workflow-evidence-list">{evidence.map((file) => <div key={file.id}><FileText size={18} /><span><strong>{file.name}</strong><small>{file.size} · 원본 저장됨</small></span><button type="button" aria-label={`${file.name} 삭제`} disabled={busy || uploading} onClick={() => void removeEvidence(file)}><X size={16} /></button></div>)}</div>}
        <p className="workflow-submit-guide"><ShieldCheck size={17} /> 제출하면 {item.requestedBy}님에게 확인 요청이 갑니다.</p>
        <footer><button type="button" className="button ghost" disabled={busy || uploading} onClick={() => void discardAndClose()}>취소</button><button type="submit" className="button primary" disabled={busy || uploading || summary.trim().length < 3}><Check size={18} /> 제출</button></footer>
      </form>
    </section>
  </div>
}

function WorkReviewModal({ item, workspaceScope, onToast, onClose, onSubmit }: { item: WorkItem; workspaceScope?: string; onToast: (message: string) => void; onClose: () => void; onSubmit: (decision: 'approve' | 'request-changes', comment: string, requestedChanges?: string) => Promise<boolean> }) {
  const dialogRef = useDialogFocus()
  const [mode, setMode] = useState<'approve' | 'request-changes'>('approve')
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const valid = mode === 'approve' || comment.trim().length >= 2
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={dialogRef} className="modal-card workflow-modal" role="dialog" aria-modal="true" aria-labelledby="review-modal-title">
      <header><div><span className="eyebrow">WORK REVIEW</span><h2 id="review-modal-title">{mode === 'approve' ? '결재 승인' : '수정 요청'}</h2><p>{item.title}</p></div><button type="button" className="icon-button" aria-label="닫기" onClick={onClose}><X size={21} /></button></header>
      <form onSubmit={async (event) => { event.preventDefault(); if (!valid) return; setBusy(true); const message = comment.trim(); if (await onSubmit(mode, message, mode === 'request-changes' ? message : undefined)) onClose(); else setBusy(false) }}>
        <div className="workflow-submission-preview"><strong>담당자 완료 보고</strong><p>{item.completion?.summary || '레거시 업무로 완료내용이 등록되지 않았습니다.'}</p>{item.completion?.evidence.map((file) => file.id.startsWith('DOC-') ? <button className="workflow-evidence-link" type="button" key={file.id} onClick={async () => { if (!await downloadWorkEvidence(file, workspaceScope)) onToast('증빙 파일을 다운로드하지 못했습니다.') }}><Paperclip size={14} /> {file.name} · {file.size}</button> : <span key={file.id}><Paperclip size={14} /> {file.name} · {file.size}</span>)}</div>
        <div className="workflow-review-decision" role="radiogroup" aria-label="검토 결정"><button type="button" role="radio" aria-checked={mode === 'approve'} onClick={() => { setMode('approve'); setComment('') }}><Check size={16} /> 승인</button><button type="button" role="radio" aria-checked={mode === 'request-changes'} onClick={() => { setMode('request-changes'); setComment('') }}>수정 요청</button></div>
        <label className="form-field full"><span>{mode === 'approve' ? '승인 메모' : '수정 요청 내용'} <em>{mode === 'approve' ? '선택' : '필수'}</em></span><textarea autoFocus data-autofocus rows={mode === 'approve' ? 3 : 4} value={comment} onChange={(event) => setComment(event.target.value)} placeholder={mode === 'approve' ? '필요할 때만 남기세요. 비워 두고 바로 승인할 수 있습니다.' : '무엇을 왜, 어떻게 보완해야 하는지 한 번에 작성해 주세요. 예: LOT 번호와 조치 전·후 사진을 보완해 주세요.'} required={mode !== 'approve'} /></label>
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
  const today = seoulDateInputValue()
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={dialogRef} className="modal-card workflow-modal" role="dialog" aria-modal="true" aria-labelledby="rule-modal-title">
      <header><div><span className="eyebrow">RECURRING WORK</span><h2 id="rule-modal-title">반복 업무 규칙 만들기</h2><p>매주 또는 매월 자동으로 업무를 생성합니다.</p></div><button type="button" className="icon-button" aria-label="닫기" onClick={onClose}><X size={21} /></button></header>
      <form onSubmit={async (event) => {
        event.preventDefault()
        const input: Record<string, unknown> = Object.fromEntries(new FormData(event.currentTarget).entries())
        input.frequency = frequency
        input.interval = Number(input.interval)
        input.startAt = seoulLocalToUtcIso(String(input.startDate ?? ''), String(input.dueTime ?? '00:00'))
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

function WorkPage({ items, rules, currentUserId, canAssignTasks, assignees, workspaceScope, focusId, onToast, onCreate, onTransition, onCreateRule, onToggleRule, onDeleteRule }: {
  items: WorkItem[]; rules: WorkRule[]; currentUserId: string; canAssignTasks: boolean; assignees: WorkAssignee[]
  workspaceScope?: string
  focusId?: string
  onToast: (message: string) => void
  onCreate: () => void
  onTransition: (id: string, action: WorkTransitionAction, input?: Record<string, unknown>) => Promise<boolean>
  onCreateRule: (input: Record<string, unknown>) => Promise<boolean>
  onToggleRule: (rule: WorkRule) => Promise<boolean>
  onDeleteRule: (rule: WorkRule) => Promise<boolean>
}) {
  const [boardTab, setBoardTab] = useState<'board' | 'rules'>('board')
  const [scopeFilter, setScopeFilter] = useState<'all' | 'mine' | 'requested'>('all')
  const [drawerId, setDrawerId] = useState<string | null>(null)
  const [dialog, setDialog] = useState<{ type: 'completion' | 'review'; item: WorkItem } | { type: 'rule' } | null>(null)
  const [showAllDone, setShowAllDone] = useState(false)
  const stages: WorkItem['status'][] = ['업무요청', '수행중', '결재대기', '결재완료']
  const drawerRef = useDialogFocus(Boolean(drawerId))
  const handledFocusRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (!focusId || handledFocusRef.current === focusId) return
    const focused = items.find((item) => item.id === focusId)
    if (!focused) return
    handledFocusRef.current = focusId
    setBoardTab('board')
    setScopeFilter('all')
    setDrawerId(focused.id)
  }, [focusId, items])

  useEffect(() => {
    if (!drawerId) return
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setDrawerId(null) }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [drawerId])

  const needsMyAction = (item: WorkItem) => (
    (item.ownerId === currentUserId && (item.status === '업무요청' || item.status === '수행중'))
    || (item.requesterId === currentUserId && item.status === '결재대기')
  )
  const isOverdue = (item: WorkItem) => {
    const dueAt = Date.parse(toIsoUtc(item.due) ?? '')
    return Number.isFinite(dueAt) && dueAt < Date.now() && item.status !== '결재완료'
  }
  const byDue = (left: WorkItem, right: WorkItem) => {
    const leftTime = new Date(toIsoUtc(left.due) ?? '9999-12-31').getTime()
    const rightTime = new Date(toIsoUtc(right.due) ?? '9999-12-31').getTime()
    return leftTime - rightTime
  }
  const scoped = items.filter((item) => scopeFilter === 'mine'
    ? item.ownerId === currentUserId
    : scopeFilter === 'requested' ? item.requesterId === currentUserId : true)
  const columns: Array<{ status: WorkItem['status']; label: string; hint: string; tone: string; icon: typeof ListChecks }> = [
    { status: '업무요청', label: '요청됨', hint: '담당자 수락 대기', tone: 'request', icon: ClipboardCheck },
    { status: '수행중', label: '진행 중', hint: '수행 후 완료 보고', tone: 'progress', icon: PlayCircle },
    { status: '결재대기', label: '결재 대기', hint: '요청자 검토·승인', tone: 'review', icon: ShieldCheck },
    { status: '결재완료', label: '완료', hint: '승인 후 기록 보관', tone: 'done', icon: CheckCircle2 },
  ]
  const columnItems = (status: WorkItem['status']) => {
    const list = scoped.filter((item) => item.status === status)
    if (status === '결재완료') {
      return [...list].sort((a, b) => (b.review?.reviewedAt ?? b.createdAt ?? '').localeCompare(a.review?.reviewedAt ?? a.createdAt ?? ''))
    }
    return [...list].sort((a, b) => Number(needsMyAction(b)) - Number(needsMyAction(a)) || byDue(a, b))
  }
  const myActionCount = scoped.filter(needsMyAction).length
  const overdueCount = scoped.filter(isOverdue).length
  const activeRuleCount = rules.filter((rule) => rule.active).length

  const primaryAction = (item: WorkItem): { label: string; run: () => void } | null => {
    if (item.requesterId === currentUserId && item.status === '결재대기') return { label: '검토하기', run: () => setDialog({ type: 'review', item }) }
    if (item.ownerId === currentUserId && item.status === '업무요청') return { label: '업무 시작', run: () => void onTransition(item.id, 'accept') }
    if (item.ownerId === currentUserId && item.status === '수행중') {
      return { label: item.review?.decision === 'changes-requested' ? '보완 후 재제출' : '완료 보고', run: () => setDialog({ type: 'completion', item }) }
    }
    return null
  }

  const drawerItem = drawerId ? items.find((item) => item.id === drawerId) ?? null : null
  const drawerStep = drawerItem ? stages.indexOf(drawerItem.status) : -1
  const drawerChangeRequested = drawerItem?.review?.decision === 'changes-requested' && drawerItem.status !== '결재완료'
  const drawerReviewHistory = drawerItem
    ? (drawerItem.reviewHistory?.length ? drawerItem.reviewHistory : drawerItem.review ? [drawerItem.review] : [])
      .slice().sort((left, right) => left.reviewedAt.localeCompare(right.reviewedAt))
    : []
  const drawerCompletionHistory = drawerItem
    ? (drawerItem.completionHistory?.length ? drawerItem.completionHistory : drawerItem.completion ? [drawerItem.completion] : [])
    : []
  const drawerTimeline = [
    ...drawerCompletionHistory.map((completion) => ({ kind: 'completion' as const, at: completion.submittedAt, completion })),
    ...drawerReviewHistory.map((review) => ({ kind: 'review' as const, at: review.reviewedAt, review })),
  ].sort((left, right) => left.at.localeCompare(right.at))
  const drawerAction = drawerItem ? primaryAction(drawerItem) : null
  const drawerGuide = !drawerItem ? ''
    : drawerItem.status === '결재완료' ? '이 업무는 승인까지 끝났습니다.'
      : drawerItem.requesterId === currentUserId && drawerItem.status === '결재대기' ? '담당자의 완료 보고를 확인하고 승인하거나 보완을 요청하세요.'
        : drawerItem.ownerId === currentUserId
          ? drawerItem.status === '업무요청' ? '업무 시작을 누르면 진행 중으로 이동합니다.'
            : drawerItem.status === '수행중'
              ? drawerChangeRequested ? '보완 요청을 반영한 뒤 다시 제출해 주세요.' : '업무를 마쳤다면 완료 보고를 제출하세요.'
              : '요청자의 검토 결과를 기다리고 있습니다.'
          : drawerItem.status === '결재대기' ? '요청자가 완료 보고를 검토하고 있습니다.' : '담당자의 처리를 기다리고 있습니다.'

  const renderCard = (item: WorkItem) => {
    const action = primaryAction(item)
    const priorityTone = item.priority === '긴급' ? 'danger' : item.priority === '높음' ? 'warning' : 'neutral'
    return <article
      className={`workflow-card priority-${priorityTone}${needsMyAction(item) ? ' is-actionable' : ''}${drawerId === item.id ? ' is-open' : ''}${item.status === '결재완료' ? ' is-done' : ''}`}
      role="button"
      tabIndex={0}
      aria-haspopup="dialog"
      key={item.id}
      onClick={() => setDrawerId(item.id)}
      onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); setDrawerId(item.id) } }}
    >
      <div className="workflow-card-top">
        <StatusBadge className="status-pill" dot tone={priorityTone}>{item.priority}</StatusBadge>
        {item.ruleId && <span className="workflow-card-flag"><Repeat2 size={12} /> 반복</span>}
        {item.review?.decision === 'changes-requested' && item.status !== '결재완료' && <span className="workflow-card-flag revision">보완 요청</span>}
        {isOverdue(item) && <span className="workflow-card-flag overdue">지연</span>}
      </div>
      <h3>{item.title}</h3>
      <div className="workflow-card-meta">
        <span className="workflow-card-person"><i aria-hidden="true">{item.owner.slice(0, 1)}</i>{item.owner}</span>
        <time className={isOverdue(item) ? 'is-overdue' : ''} dateTime={toIsoUtc(item.due) ?? item.due}>{item.status === '결재완료' ? '완료됨' : formatWorkDue(item.due)}</time>
      </div>
      {action && <button className="workflow-card-action" type="button" onClick={(event) => { event.stopPropagation(); action.run() }}>{action.label} <ArrowRight size={14} /></button>}
    </article>
  }

  return <div className="content-page workflow-page">
    <PageHeader eyebrow="WORKFLOW" title="업무지시 · 결재" description="지시부터 수행·검토·승인까지, 업무가 어느 단계에 있는지 보드에서 바로 확인합니다." action={canAssignTasks ? <div className="page-action-row"><button className="button secondary" type="button" onClick={() => setDialog({ type: 'rule' })}><Repeat2 size={18} /> 반복 업무</button><button className="button primary" type="button" onClick={onCreate}><Plus size={18} /> 새 업무 지시</button></div> : <StatusBadge className="status-pill" tone="neutral">내 업무 수행</StatusBadge>} />

    <div className="workflow-board-toolbar">
      <div className="workflow-board-tabs" role="tablist" aria-label="업무 화면 전환">
        <button type="button" role="tab" aria-selected={boardTab === 'board'} onClick={() => setBoardTab('board')}><ListChecks size={17} /> 결재 보드</button>
        {canAssignTasks && <button type="button" role="tab" aria-selected={boardTab === 'rules'} onClick={() => setBoardTab('rules')}><Repeat2 size={17} /> 반복 규칙 <em>{activeRuleCount}</em></button>}
      </div>
      {boardTab === 'board' && <div className="workflow-scope-filter" role="group" aria-label="업무 범위 필터">
        <button type="button" className={scopeFilter === 'all' ? 'active' : ''} aria-pressed={scopeFilter === 'all'} onClick={() => setScopeFilter('all')}>전체</button>
        <button type="button" className={scopeFilter === 'mine' ? 'active' : ''} aria-pressed={scopeFilter === 'mine'} onClick={() => setScopeFilter('mine')}>내가 담당</button>
        {canAssignTasks && <button type="button" className={scopeFilter === 'requested' ? 'active' : ''} aria-pressed={scopeFilter === 'requested'} onClick={() => setScopeFilter('requested')}>내가 지시</button>}
      </div>}
      {boardTab === 'board' && <div className="workflow-board-summary" aria-label="업무 요약">
        <span className={myActionCount > 0 ? 'is-attention' : ''}><strong>{myActionCount}</strong> 내 처리 필요</span>
        <span className={overdueCount > 0 ? 'is-danger' : ''}><strong>{overdueCount}</strong> 마감 지연</span>
      </div>}
    </div>

    {boardTab === 'board' && <div className="workflow-board" role="list" aria-label="업무 단계 보드">
      {columns.map((column) => {
        const Icon = column.icon
        const list = columnItems(column.status)
        const isDone = column.status === '결재완료'
        const visibleList = isDone && !showAllDone ? list.slice(0, 6) : list
        return <section className={`workflow-column tone-${column.tone}`} role="listitem" aria-label={`${column.label} ${list.length}건`} key={column.status}>
          <header className="workflow-column-head">
            <span className="workflow-column-icon"><Icon size={16} /></span>
            <div><strong>{column.label}</strong><small>{column.hint}</small></div>
            <em>{list.length}</em>
          </header>
          <div className="workflow-column-body">
            {visibleList.map(renderCard)}
            {list.length === 0 && <div className="workflow-column-empty"><CheckCircle2 size={17} /><span>{isDone ? '완료된 업무가 없습니다' : '이 단계의 업무가 없습니다'}</span></div>}
            {isDone && list.length > 6 && <button className="workflow-column-more" type="button" onClick={() => setShowAllDone((value) => !value)}>{showAllDone ? '최근 6건만 보기' : `완료 ${list.length}건 모두 보기`}</button>}
          </div>
        </section>
      })}
    </div>}

    {boardTab === 'rules' && canAssignTasks && <section className="panel recurring-work-panel"><header><div><span className="eyebrow">RECURRING RULES</span><h2>반복 업무 규칙</h2><p>도래한 규칙은 요청됨 단계에 자동 생성됩니다.</p></div><button className="button secondary" type="button" onClick={() => setDialog({ type: 'rule' })}><Plus size={17} /> 규칙 추가</button></header><div className="recurring-rule-grid">{rules.map((rule) => <article key={rule.id}><div><span className={`rule-state ${rule.active ? 'active' : 'paused'}`}>{rule.active ? '활성' : '중지'}</span><strong>{rule.title}</strong><p>{rule.description}</p></div><dl><div><dt>주기</dt><dd>{workRuleScheduleLabel(rule)}</dd></div><div><dt>담당자</dt><dd>{rule.owner}</dd></div><div><dt>다음 실행</dt><dd>{formatWorkRuleRun(rule.nextRun, rule.dueTime)}</dd></div></dl><div className="recurring-rule-actions"><button className="button ghost" type="button" onClick={() => void onToggleRule(rule)}>{rule.active ? <PauseCircle size={17} /> : <PlayCircle size={17} />}{rule.active ? ' 일시 중지' : ' 다시 활성화'}</button><button className="button danger" type="button" onClick={() => void onDeleteRule(rule)}><Trash2 size={17} /> 삭제</button></div></article>)}{rules.length === 0 && <div className="empty-state"><Repeat2 size={30} /><h3>반복 규칙이 없습니다</h3><p>매주·매월 반복되는 점검을 자동화해 보세요.</p></div>}</div></section>}

    {drawerItem && <div className="workflow-drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDrawerId(null) }}>
      <aside ref={drawerRef} className="workflow-drawer" role="dialog" aria-modal="true" aria-labelledby="workflow-drawer-title">
        <header className="workflow-drawer-head">
          <div>
            <div className="workflow-drawer-badges">
              <StatusBadge className="status-pill" dot tone={drawerItem.status === '결재완료' ? 'success' : drawerItem.status === '결재대기' ? 'info' : drawerItem.status === '수행중' ? 'warning' : 'neutral'}>{workStatusLabel(drawerItem.status)}</StatusBadge>
              <StatusBadge className="status-pill" dot tone={drawerItem.priority === '긴급' ? 'danger' : drawerItem.priority === '높음' ? 'warning' : 'neutral'}>{drawerItem.priority}</StatusBadge>
              <span>{drawerItem.category}</span>
              {drawerItem.ruleId && <span><Repeat2 size={13} /> 반복</span>}
            </div>
            <h2 id="workflow-drawer-title">{drawerItem.title}</h2>
          </div>
          <button type="button" className="icon-button" aria-label="상세 닫기" onClick={() => setDrawerId(null)}><X size={21} /></button>
        </header>
        <ol className="workflow-drawer-stepper" aria-label={`업무 단계, 현재 ${workStatusLabel(drawerItem.status)}`}>{stages.map((status, index) => <li className={index < drawerStep ? 'done' : index === drawerStep ? 'current' : ''} aria-current={index === drawerStep ? 'step' : undefined} key={status}><i>{index < drawerStep ? <Check size={11} /> : index + 1}</i><span>{workStatusLabel(status)}</span></li>)}</ol>
        <div className="workflow-drawer-body">
          <section className={`workflow-drawer-action${drawerChangeRequested ? ' is-revision' : ''}${drawerAction ? ' has-action' : ''}`} aria-label="지금 할 일">
            <div><span>지금 할 일</span><strong>{drawerGuide}</strong></div>
            {drawerChangeRequested && <p className="workflow-drawer-revision"><AlertTriangle size={15} /> {drawerItem.review?.requestedChanges || drawerItem.review?.comment || '요청자가 보완 내용을 남기지 않았습니다.'}</p>}
            {drawerAction && <button className="button primary" type="button" onClick={drawerAction.run}>{drawerAction.label} <ArrowRight size={16} /></button>}
          </section>
          {explicitCompletionCriteria(drawerItem) && <section className="workflow-drawer-block" aria-label="완료 기준"><span>완료 기준</span><p>{explicitCompletionCriteria(drawerItem)}</p></section>}
          {drawerItem.attachments?.length ? <section className="workflow-drawer-block" aria-label="지시 첨부"><span>지시 첨부</span><div className="workflow-drawer-files">{drawerItem.attachments.map((file) => <button className="workflow-evidence-link" type="button" key={file.id} onClick={async () => { if (!await downloadWorkEvidence(file, workspaceScope)) onToast('첨부 파일을 다운로드하지 못했습니다.') }}><Paperclip size={13} /> {file.name} · {file.size}</button>)}</div></section> : null}
          <section className="workflow-drawer-block" aria-label="진행 이력">
            <span>진행 이력 <small>{drawerTimeline.length}</small></span>
            {drawerTimeline.length === 0 ? <p className="workflow-drawer-timeline-empty">아직 제출되거나 검토된 이력이 없습니다.</p> : <div className="workflow-drawer-timeline">
              {drawerTimeline.map((entry, index) => entry.kind === 'completion'
                ? <div className="workflow-record" key={`completion-${entry.at}-${index}`}><ClipboardCheck size={17} /><div><strong>결과 제출 <time dateTime={entry.completion.submittedAt}>{formatDateTime(entry.completion.submittedAt)}</time></strong><p>{entry.completion.summary}</p><div className="workflow-record-files">{entry.completion.evidence.length === 0 && <span>첨부 증빙 없음</span>}{entry.completion.evidence.map((file) => file.id.startsWith('DOC-') ? <button className="workflow-evidence-link" type="button" key={file.id} onClick={async () => { if (!await downloadWorkEvidence(file, workspaceScope)) onToast('증빙 파일을 다운로드하지 못했습니다.') }}><Paperclip size={12} /> {file.name} · {file.size}</button> : <span key={file.id}><Paperclip size={12} /> {file.name} · {file.size}</span>)}</div></div></div>
                : <div className={`workflow-record ${entry.review.decision === 'approved' ? 'approved' : 'changes'}`} key={`review-${entry.at}-${index}`}><ShieldCheck size={17} /><div><strong>{entry.review.decision === 'approved' ? '승인' : '보완 요청'} <time dateTime={entry.review.reviewedAt}>{formatDateTime(entry.review.reviewedAt)}</time></strong><p>{entry.review.requestedChanges || entry.review.comment}</p></div></div>)}
            </div>}
          </section>
          <dl className="workflow-drawer-meta"><div><dt>마감</dt><dd><Clock3 size={15} /> {formatWorkDue(drawerItem.due)}</dd></div><div><dt>담당</dt><dd>{drawerItem.owner}</dd></div><div><dt>요청</dt><dd>{drawerItem.requestedBy}</dd></div></dl>
        </div>
      </aside>
    </div>}

    {dialog?.type === 'completion' && <CompletionModal item={dialog.item} workspaceScope={workspaceScope} onToast={onToast} onClose={() => setDialog(null)} onSubmit={(summary, evidence) => onTransition(dialog.item.id, 'submit', { completion: { summary, evidence } })} />}
    {dialog?.type === 'review' && <WorkReviewModal item={dialog.item} workspaceScope={workspaceScope} onToast={onToast} onClose={() => setDialog(null)} onSubmit={(decision, comment, requestedChanges) => onTransition(dialog.item.id, decision, { review: { comment, requestedChanges } })} />}
    {dialog?.type === 'rule' && <WorkRuleModal assignees={assignees} onClose={() => setDialog(null)} onSubmit={onCreateRule} />}
  </div>
}

function InventoryPage({ onToast, canManage, workspaceScope }: { onToast: (message: string) => void; canManage: boolean; workspaceScope?: string }) {
  const [locations, setLocations] = useWorkspaceState<WarehouseLocation[]>('inventory-locations', emptyInventoryLocations, { scope: workspaceScope, seedWhenEmpty: false })
  const [movements, setMovements] = useWorkspaceState<InventoryMovement[]>('inventory-movements', [], { scope: workspaceScope, seedWhenEmpty: false })
  const [editing, setEditing] = useState<WarehouseLocation | 'new' | null>(null)
  const [movementOpen, setMovementOpen] = useState(false)
  const [movementPreset, setMovementPreset] = useState<{ warehouseId: string; direction: '입고' | '출고' } | null>(null)
  const [warehouseView, setWarehouseView] = useState<'compact' | 'large'>('compact')
  const [showAllMovements, setShowAllMovements] = useState(false)
  const [expandedWarehouseIds, setExpandedWarehouseIds] = useState<Set<string>>(() => new Set())
  const defaultMovementTime = seoulDateTimeInputValue()
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
    if (!editing && !movementOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setEditing(null); setMovementOpen(false); setMovementPreset(null) }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [editing, movementOpen])

  const openWarehouseMovement = (warehouseId?: string, direction: '입고' | '출고' = '입고') => {
    setMovementPreset(warehouseId ? { warehouseId, direction } : null)
    setMovementOpen(true)
  }

  const closeWarehouseMovement = () => {
    setMovementOpen(false)
    setMovementPreset(null)
  }

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
      const result = await setLocations((current) => [...current, { id: `WH-${crypto.randomUUID().slice(0, 8).toUpperCase()}`, name, type, temperature, condition: temperature + ' · 정상', items: '등록 재고 0개', utilization, alert: '이상 없음' }])
      if (!result.ok) { onToast(result.message ?? '창고를 등록하지 못했습니다.'); return }
      onToast(name + '를 새 창고로 등록했습니다.')
    } else if (editing) {
      const result = await setLocations((current) => current.map((item) => item.id === editing.id ? { ...item, name, type, temperature, condition: temperature + ' · 정상', utilization } : item))
      if (!result.ok) { onToast(result.message ?? '창고 정보를 변경하지 못했습니다.'); return }
      onToast(name + ' 창고 정보를 변경했습니다.')
    }
    setEditing(null)
  }

  const removeWarehouse = async () => {
    if (!canManage || !editing || editing === 'new') return
    if (movements.some((movement) => movement.warehouseId === editing.id)) {
      onToast('입출고 이력이 연결된 창고는 삭제할 수 없습니다. 이력을 먼저 정리해 주세요.')
      return
    }
    if (!window.confirm(`${editing.name} 창고를 삭제할까요?`)) return
    const result = await setLocations((current) => current.filter((item) => item.id !== editing.id))
    if (!result.ok) { onToast(result.message ?? '창고를 삭제하지 못했습니다.'); return }
    const deletedName = editing.name
    setEditing(null)
    onToast(`${deletedName} 창고를 삭제했습니다.`)
  }

  const saveMovement = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canManage) { closeWarehouseMovement(); onToast('입출고 등록은 고객사 관리자만 할 수 있습니다.'); return }
    const form = new FormData(event.currentTarget)
    const direction = String(form.get('direction') || '입고') as InventoryMovement['direction']
    const product = String(form.get('product') || '').trim()
    const lot = String(form.get('lot') || '').trim()
    const quantity = Number(form.get('quantity') || 0)
    const unit = String(form.get('unit') || 'EA')
    const warehouseId = String(form.get('warehouseId') || '')
    const occurredAtInput = String(form.get('occurredAt') || '')
    const [occurredDate, occurredTime] = occurredAtInput.split('T')
    const occurredAt = occurredDate && occurredTime ? seoulLocalToUtcIso(occurredDate, occurredTime) : null
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
      occurredAt: occurredAt || new Date().toISOString(),
      reason,
      evidence: evidenceFile && evidenceFile.size > 0 ? evidenceFile.name : undefined,
      evidenceId,
    }
    const result = await setMovements((current) => [movement, ...current])
    if (!result.ok) { if (evidenceId) void fetch(`/api/documents/${encodeURIComponent(evidenceId)}`, { method: 'DELETE', headers: workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined }); return }
    closeWarehouseMovement()
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
      <PageHeader eyebrow="INVENTORY & LOT" title="재고 · LOT" description="창고 환경과 유통기한, 출고 가능 수량을 제품 흐름에 맞춰 관리합니다." action={<><button className="button ghost" type="button" aria-pressed={warehouseView === 'large'} onClick={() => setWarehouseView((view) => view === 'compact' ? 'large' : 'compact')}><Layers3 size={18} /> {warehouseView === 'compact' ? '크게 보기' : '컴팩트 보기'}</button>{canManage ? <><button className="button ghost" type="button" onClick={() => openWarehouseMovement()}><Boxes size={18} /> 입출고 등록</button><button className="button primary" type="button" onClick={() => setEditing('new')}><Plus size={18} /> 창고 등록</button></> : <StatusBadge className="status-pill" tone="neutral">조회 전용</StatusBadge>}</>} />
      <section className={`warehouse-grid is-${warehouseView}`}>
        {locations.length === 0 && <div className="empty-state"><Warehouse size={30} /><h3>아직 등록된 항목이 없습니다</h3><p>첫 창고를 등록하면 보관 조건과 공간 사용률을 이곳에서 관리할 수 있습니다.</p>{canManage && <button className="button primary" type="button" onClick={() => setEditing('new')}><Plus size={17} /> 첫 창고 등록</button>}</div>}
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
          const recentMovements = [...movements].filter((movement) => movement.warehouseId === location.id).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, 2)
          const typeClass = location.type === '냉장' ? 'chilled' : location.type === '냉동' ? 'frozen' : location.type === '포장재' ? 'packaging' : 'ambient'
          return <article className={`warehouse-card warehouse-inventory-block warehouse-type-${typeClass}`} key={location.id}>
            <div className="warehouse-card-top"><span className="warehouse-icon"><Warehouse size={21} /></span><div><StatusBadge className="status-pill" dot tone={location.alert === '이상 없음' ? 'success' : 'warning'}>{location.condition}</StatusBadge>{canManage && <button type="button" className="warehouse-edit" onClick={() => setEditing(location)}>변경</button>}</div></div>
            <div className="warehouse-card-heading"><div><h2>{location.name}</h2><span className="warehouse-code"><b className="warehouse-type-chip">{location.type}</b> {location.id}</span></div><strong className={unresolvedCount > 0 ? 'needs-reconcile' : ''}>{stockSummary}{unresolvedCount > 0 && stockTotals.length > 0 ? ` · 미확정 ${unresolvedCount}` : ''}</strong></div>
            <div className="warehouse-utilization"><div className="progress-head"><span>공간 사용률</span><strong>{location.utilization}%</strong></div><div className="progress-track"><span style={{ width: location.utilization + '%' }} /></div></div>
            {canManage && <div className="warehouse-quick-actions"><button type="button" onClick={() => openWarehouseMovement(location.id, '입고')}><ArrowDownToLine size={15} /> 재고 추가</button><button type="button" onClick={() => openWarehouseMovement(location.id, '출고')}><ArrowUpFromLine size={15} /> 재고 차감</button></div>}
            {warehouseView === 'compact' ? <section className="warehouse-recent-block" aria-label={`${location.name} 최근 입출고`}><header><strong>최근 입출고</strong><span>{recentMovements.length}건</span></header>{recentMovements.length === 0 ? <p>아직 입출고 내역이 없습니다.</p> : <ul>{recentMovements.map((movement) => <li key={movement.id}><span className={`movement-mini-direction is-${movement.direction === '입고' ? 'in' : movement.direction === '출고' ? 'out' : 'adjust'}`}>{movement.direction}</span><div><strong>{movement.product}</strong><small>{movement.lot} · {formatDateTime(movement.occurredAt)}</small></div><b>{movement.direction === '출고' ? '−' : movement.direction === '입고' ? '+' : ''}{movement.quantity.toLocaleString('ko-KR', { maximumFractionDigits: 3 })}{movement.unit}</b></li>)}</ul>}</section> : <><section className="warehouse-lot-block" aria-label={`${location.name} 품목 및 LOT 수량`}>
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
            <div className={`warehouse-alert${location.alert === '이상 없음' ? ' is-normal' : ''}`}><AlertTriangle size={15} /> <span>{location.alert}</span></div></>}
          </article>
        })}
      </section>
      <section className="panel table-panel inventory-movement-panel">
        <div className="panel-heading"><div><h2>{showAllMovements ? '전체 입출고 원장' : '최근 입출고'}</h2><p>LOT별 수량, 등록 사유와 증빙자료를 확인합니다.</p></div><div className="inventory-panel-actions">{movements.length > 8 && <button type="button" className="small-button" aria-pressed={showAllMovements} onClick={() => setShowAllMovements((value) => !value)}>{showAllMovements ? '최근 8건만' : `전체 ${movements.length}건`}</button>}{canManage && <button type="button" className="small-button" onClick={() => openWarehouseMovement()}><Plus size={16} /> 내역 등록</button>}</div></div>
        {movements.length === 0 ? <div className="empty-state compact"><Boxes size={28} /><h3>등록된 입출고가 없습니다</h3><p>첫 입고, 출고 또는 재고조정 내역을 등록해 보세요.</p></div> : <div className="responsive-table"><table><thead><tr><th>구분 · 품목</th><th>LOT</th><th>수량</th><th>창고</th><th>일시 · 사유</th><th>증빙</th>{canManage && <th>관리</th>}</tr></thead><tbody>{(showAllMovements ? movements : movements.slice(0, 8)).map((movement) => <tr key={movement.id}><td><div className={'movement-direction ' + movement.direction}>{movement.direction === '입고' ? <ArrowDownToLine size={17} /> : <ArrowUpFromLine size={17} />}<span><strong>{movement.product}</strong><small>{movement.id}</small></span></div></td><td><strong>{movement.lot}</strong></td><td><strong>{movement.quantity.toLocaleString()}{movement.unit}</strong></td><td>{locations.find((location) => location.id === movement.warehouseId)?.name ?? movement.warehouseId}</td><td><strong>{formatDateTime(movement.occurredAt)}</strong><span>{movement.reason}</span></td><td>{movement.evidence ? movement.evidenceId ? <button type="button" className="movement-evidence download" onClick={async () => { if (!await downloadStoredDocument(movement.evidenceId!, movement.evidence!, workspaceScope)) onToast('증빙 파일을 다운로드하지 못했습니다.') }}><Paperclip size={15} /> {movement.evidence}</button> : <span className="movement-evidence"><Paperclip size={15} /> {movement.evidence}</span> : '—'}</td>{canManage && <td><button type="button" className="movement-delete" onClick={() => void removeMovement(movement)}>삭제</button></td>}</tr>)}</tbody></table></div>}
      </section>
      {movementOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeWarehouseMovement()}>
        <section ref={movementDialogRef} className="modal-card inventory-movement-modal" role="dialog" aria-modal="true" aria-labelledby="inventory-movement-title">
          <header><div><span className="eyebrow">STOCK MOVEMENT</span><h2 id="inventory-movement-title">{movementPreset ? `${movementPreset.direction === '입고' ? '재고 추가' : '재고 차감'} · ${locations.find((location) => location.id === movementPreset.warehouseId)?.name ?? '선택 창고'}` : '입출고 등록'}</h2><p>LOT와 수량, 이동 사유를 남겨 재고 변동 이력을 관리합니다.</p></div><button className="icon-button" type="button" aria-label="닫기" onClick={closeWarehouseMovement}><X size={21} /></button></header>
          <form onSubmit={saveMovement}>
            <div className="form-grid"><label className="form-field"><span>구분</span><select name="direction" defaultValue={movementPreset?.direction ?? '입고'}><option>입고</option><option>출고</option><option>재고조정</option></select></label><label className="form-field"><span>처리 일시</span><input name="occurredAt" type="datetime-local" defaultValue={defaultMovementTime} /></label></div>
            <p className="inventory-ledger-note"><Database size={16} /><span><strong>현재고 계산 기준</strong> 입고·출고는 확정 현재고에 더하고 빼며, 재고조정은 입력 수량을 해당 LOT의 실사 현재고로 확정합니다. 기존 출고만 있는 LOT은 먼저 재고조정을 등록해 주세요.</span></p>
            <div className="form-grid"><label className="form-field"><span>품목명</span><input name="product" autoFocus data-autofocus placeholder="예: 완제품 A 400g" required /></label><label className="form-field"><span>LOT 번호</span><input name="lot" placeholder="LOT-YYYYMMDD-01" required /></label></div>
            <div className="form-grid three"><label className="form-field"><span>수량</span><input name="quantity" type="number" min="0" step="0.001" required /></label><label className="form-field"><span>단위</span><select name="unit" defaultValue="EA"><option>EA</option><option>BOX</option><option>KG</option><option>G</option><option>ROLL</option></select></label><label className="form-field"><span>창고</span><select name="warehouseId" required defaultValue={movementPreset?.warehouseId ?? locations[0]?.id ?? ''}><option value="" disabled>창고 선택</option>{locations.map((location) => <option value={location.id} key={location.id}>{location.name}</option>)}</select></label></div>
            <label className="form-field full"><span>처리 사유</span><textarea name="reason" rows={3} placeholder="예: 온라인 주문 출고" required /></label>
            <label className="form-field full"><span>증빙자료 (선택)</span><input name="evidence" type="file" accept="image/*,.pdf,.xlsx,.xls,.csv" /><small>파일 원본을 고객사 자료 저장소에 보관하고 입출고 이력에서 다시 다운로드할 수 있습니다.</small></label>
            <footer><button type="button" className="button ghost" onClick={closeWarehouseMovement}>취소</button><button type="submit" className="button primary"><Check size={18} /> 입출고 저장</button></footer>
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
            <footer>{editing !== 'new' && <button type="button" className="danger-text-button" onClick={() => void removeWarehouse()}><Trash2 size={17} /> 창고 삭제</button>}<span className="modal-footer-spacer" /><button type="button" className="button ghost" onClick={() => setEditing(null)}>취소</button><button type="submit" className="button primary"><Check size={18} /> {editing === 'new' ? '창고 등록' : '변경 저장'}</button></footer>
          </form>
        </section>
      </div>}
    </div>
  )
}

function TaskModal({ initialText, initialDescription = '', requesterName, requesterId, assignees, workspaceScope, onClose, onSave }: {
  initialText: string; initialDescription?: string; requesterName: string; requesterId: string; assignees: WorkAssignee[]; workspaceScope?: string; onClose: () => void; onSave: (item: WorkItem) => Promise<boolean>
}) {
  const [title, setTitle] = useState(initialText)
  const [description, setDescription] = useState(initialDescription)
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useDialogFocus()
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!title.trim() || busy) return
    const form = new FormData(event.currentTarget)
    const ownerId = String(form.get('ownerId') || '')
    const owner = assignees.find((assignee) => assignee.id === ownerId)
    if (!owner) return
    const dueLocal = String(form.get('due') || '')
    const due = seoulLocalToUtcIso(dueLocal.slice(0, 10), dueLocal.slice(11, 16)) ?? dueLocal
    setBusy(true)
    setError('')
    let uploadedIds: string[] = []
    try {
      const uploaded = pendingFiles.length > 0
        ? await uploadDocumentAttachments(pendingFiles, {
          workspaceScope,
          category: '회의·업무일지',
          summary: `${title.trim()} 업무 지시 첨부`,
          tags: ['업무지시'],
          allowedUserIds: [requesterId, owner.id],
        })
        : []
      const attachments: WorkEvidence[] = uploaded.map((file, index) => ({ ...file, type: pendingFiles[index]?.type || 'application/octet-stream' }))
      uploadedIds = attachments.map((file) => file.id)
      const saved = await onSave({
        id: 'WK-' + new Date().getTime().toString().slice(-8),
        title: title.trim(),
        description: description.trim(),
        owner: owner.name,
        ownerId: owner.id,
        requestedBy: requesterName,
        requesterId,
        due,
        priority: String(form.get('priority') || '보통') as WorkItem['priority'],
        status: '업무요청',
        category: '일반',
        ...(attachments.length ? { attachments } : {}),
        createdAt: new Date().toISOString(),
      })
      if (!saved && attachments.length) {
        const cleanup = await deleteDocumentAttachments(uploadedIds, workspaceScope)
        uploadedIds = cleanup.failed.map((failure) => failure.id)
        if (cleanup.failed.length) throw new Error(`업무 저장에 실패했고 첨부 ${cleanup.failed.length}개를 정리하지 못했습니다.`)
      }
      if (!saved) setBusy(false)
    } catch (uploadError) {
      const cleanup = uploadedIds.length ? await deleteDocumentAttachments(uploadedIds, workspaceScope) : { failed: [] }
      const message = uploadError instanceof Error ? uploadError.message : '업무 지시를 저장하지 못했습니다.'
      setError(cleanup.failed.length ? `${message} 첨부 ${cleanup.failed.length}개도 정리하지 못했습니다.` : message)
      setBusy(false)
    }
  }
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section ref={dialogRef} className="modal-card task-modal" role="dialog" aria-modal="true" aria-labelledby="task-modal-title">
        <header><div><span className="eyebrow">NEW WORK</span><h2 id="task-modal-title">새 업무 지시</h2><p>무엇을, 누가, 언제까지 할지만 정하면 바로 지시할 수 있습니다.</p></div><button type="button" className="icon-button" aria-label="닫기" disabled={busy} onClick={onClose}><X size={21} /></button></header>
        <form onSubmit={submit}>
          <div className="task-required-fields">
            <label className="form-field full"><span>무엇을 <em>필수</em></span><input autoFocus data-autofocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="예: 신규 제품 표시사항 최종 검토" required /></label>
            <label className="form-field"><span>누가 <em>필수</em></span><select name="ownerId" defaultValue={assignees.find((item) => item.id === requesterId)?.id ?? assignees[0]?.id ?? ''} required><option value="" disabled>직원 선택</option>{assignees.map((assignee) => <option value={assignee.id} key={assignee.id}>{assignee.name}</option>)}</select></label>
            <label className="form-field"><span>언제까지 <em>필수</em></span><input name="due" type="datetime-local" defaultValue={`${seoulDateInputValue()}T18:00`} required /></label>
          </div>
          <details className="task-optional-fields" open={Boolean(initialDescription)}>
            <summary><ChevronDown size={17} /> 선택 항목 <span>우선순위 · 완료 기준 · 첨부</span></summary>
            <div className="task-optional-fields-body">
              <label className="form-field"><span>우선순위</span><select name="priority" defaultValue="보통"><option>긴급</option><option>높음</option><option>보통</option></select></label>
              <label className="form-field full"><span>완료 기준</span><textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="필요할 때만 완료 조건을 적어 주세요." /></label>
              <section className="task-attachment-picker" aria-labelledby="task-attachment-title"><div><strong id="task-attachment-title">사진·파일</strong><small>선택 · 파일당 10MB 이하</small></div><input ref={inputRef} className="sr-only" type="file" multiple onChange={(event) => { setPendingFiles(Array.from(event.target.files ?? []).slice(0, 10)); event.target.value = '' }} /><button className="button secondary" type="button" disabled={busy} onClick={() => inputRef.current?.click()}><Paperclip size={17} /> 파일 선택</button></section>
              {pendingFiles.length > 0 && <div className="task-pending-files">{pendingFiles.map((file, index) => <span key={`${file.name}-${file.lastModified}`}><FileText size={15} /> {file.name}<button type="button" aria-label={`${file.name} 제외`} onClick={() => setPendingFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={14} /></button></span>)}</div>}
            </div>
          </details>
          {error && <p className="workflow-upload-error" role="alert">{error}</p>}
          {assignees.length === 0 && <div className="modal-note"><AlertTriangle size={18} /><p><strong>배정 가능한 직원 정보를 불러오지 못했습니다.</strong><span>직원 계정이 승인됐는지 확인한 뒤 다시 열어 주세요.</span></p></div>}
          <footer><button type="button" className="button ghost" disabled={busy} onClick={onClose}>취소</button><button type="submit" className="button primary" disabled={busy || assignees.length === 0 || !title.trim()}><Check size={18} /> {busy ? '저장 중…' : '업무 지시하기'}</button></footer>
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
  // The API scopes workspace data by the authenticated tenant and account role.
  // Match that boundary in the optimistic cache so switching accounts in the
  // same browser can never reuse another employee's filtered response.
  const workspaceScope = account?.tenantId && account.id ? `${account.tenantId}:${account.id}` : undefined
  const [pendingProposals, setPendingProposals] = useState(0)
  const [profileOpen, setProfileOpen] = useState(false)
  const [peopleInitialTab, setPeopleInitialTab] = useState<'members' | 'accounts' | 'performance'>('members')
  const isTenantAdmin = account?.role === 'tenant-admin' && Boolean(account.tenantId)
  useEffect(() => {
    if (!isTenantAdmin || !workspaceScope) { setPendingProposals(0); return }
    let active = true
    const headers = { 'x-workspace-identity': workspaceScope }
    const loadPending = () => fetch('/api/proposals', { headers })
      .then(async (response) => response.ok ? response.json() as Promise<{ pendingCount?: number }> : { pendingCount: 0 })
      .then((body) => { if (active) setPendingProposals(Number(body.pendingCount ?? 0)) })
      .catch(() => {})
    void loadPending()
    const timer = window.setInterval(() => { void loadPending() }, 60_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [isTenantAdmin, workspaceScope])
  const currentSessionIdentity = account ? sessionIdentity(account) : null
  const [mode, setMode] = useState<AppMode>('tenant')
  const [page, setPage] = useState<PageId>('ai')
  const [mobileNav, setMobileNav] = useState(false)
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 1024)
  const [messengerOpen, setMessengerOpen] = useState(false)
  const [messengerUnread, setMessengerUnread] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [navEditorOpen, setNavEditorOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const noticeIds = ['primary', 'secondary', 'tertiary'] as const
  const [readNoticeIds, setReadNoticeIds] = useState<string[]>([])
  const unread = noticeIds.filter((id) => !readNoticeIds.includes(id)).length
  const notificationWrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!notificationsOpen) return
    const onPointerDown = (event: PointerEvent) => { if (!notificationWrapRef.current?.contains(event.target as Node)) setNotificationsOpen(false) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setNotificationsOpen(false) }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onPointerDown); document.removeEventListener('keydown', onKey) }
  }, [notificationsOpen])
  const [query, setQuery] = useState('')
  const [workItems, setWorkItems] = useWorkspaceState<WorkItem[]>('work-items', emptyWorkItems, {
    enabled: authStatus === 'signed-in' && mode === 'tenant' && !account?.requiresPasswordChange,
    scope: workspaceScope,
    seedWhenEmpty: false,
  })
  const [workRules, setWorkRules] = useWorkspaceState<WorkRule[]>('work-rules', emptyWorkRules, {
    enabled: authStatus === 'signed-in' && mode === 'tenant' && !account?.requiresPasswordChange,
    scope: workspaceScope,
    seedWhenEmpty: false,
  })
  const [dashboardProducts] = useWorkspaceState<DashboardProduct[]>('product-catalog', [], {
    enabled: authStatus === 'signed-in' && mode === 'tenant' && !account?.requiresPasswordChange,
    scope: workspaceScope,
    seedWhenEmpty: false,
  })
  const [dashboardSalesChannels] = useWorkspaceState<DashboardSalesChannel[]>('sales-channels', [], {
    enabled: authStatus === 'signed-in' && mode === 'tenant' && account?.role === 'tenant-admin' && !account?.requiresPasswordChange,
    scope: workspaceScope,
    seedWhenEmpty: false,
  })
  const [dashboardCalendarEvents] = useWorkspaceState<DashboardCalendarEvent[]>('calendar-events', [], {
    enabled: authStatus === 'signed-in' && mode === 'tenant' && !account?.requiresPasswordChange,
    scope: workspaceScope,
    seedWhenEmpty: false,
  })
  const [directoryAssignees, setDirectoryAssignees] = useState<WorkAssignee[]>([])
  const [taskDraft, setTaskDraft] = useState<{ title: string; completionCriteria: string } | null>(null)
  const [supportTenant, setSupportTenant] = useState<Tenant | null>(null)
  const [platformFocusId, setPlatformFocusId] = useState<string>()
  const [workFocusId, setWorkFocusId] = useState<string>()
  const [platformDirectory, setPlatformDirectory] = useState<PlatformDirectoryState>({ tenants: [], supportTickets: [] })
  const [platformRefreshToken, setPlatformRefreshToken] = useState(0)
  const [toast, setToast] = useState('')
  // 저장소가 읽기 전용으로 기동됐는지(STORE_READ_ONLY) — 모든 화면 상단에 고정 배너로 알린다.
  const [storeStatus, setStoreStatus] = useState<{ kind: string; readOnly: boolean; fallbackReason: string | null } | null>(null)
  const [theme, setTheme] = useState<ThemeChoice>(() => (window.localStorage.getItem('onfactory-theme') as ThemeChoice | null) ?? 'light')
  const [fontSize, setFontSize] = useState<FontChoice>(() => (window.localStorage.getItem('onfactory-font') as FontChoice | null) ?? 'standard')
  const [accent, setAccent] = useState<AccentChoice>(() => (window.localStorage.getItem('onfactory-accent') as AccentChoice | null) ?? 'blue')
  const [easyMode, setEasyMode] = useState<EasyModeChoice>(() => (window.localStorage.getItem('onfactory-easy-mode') as EasyModeChoice | null) ?? 'standard')
  const easyHomeActive = mode === 'tenant' && page === 'ai' && easyMode === 'easy'

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
    fetch('/api/health')
      .then(async (response) => response.ok ? response.json() as Promise<{ store?: { kind: string; readOnly: boolean; fallbackReason: string | null } }> : null)
      .then((body) => { if (active && body?.store) setStoreStatus(body.store) })
      .catch(() => { /* health is informational */ })
    return () => { active = false }
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
          const body = await response.json() as { created?: WorkItem[]; rules?: WorkRule[]; version?: string; workItemsVersion?: string }
          if (!response.ok) throw new Error('materialize')
          if (!active) return
          if (body.rules) void setWorkRules(body.rules, { persist: false, serverVersion: body.version })
          if (body.created?.length) void setWorkItems((current) => [...body.created!.filter((created) => !current.some((item) => item.id === created.id)), ...current], { persist: false, serverVersion: body.workItemsVersion })
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
        if (active) setDirectoryAssignees([])
      })
    return () => { active = false }
  }, [account?.requiresPasswordChange, account?.tenantId, authStatus, mode])

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
      document.documentElement.dataset.accent = accent
      // 쉬운 화면은 정보 구조가 따로 설계된 AI 업무허브에서만 활성화한다.
      // 다른 업무 화면의 글자·버튼·그리드를 일괄 확대하면 기능과 맥락이
      // 화면 아래로 밀리므로 기본 배치를 그대로 유지한다.
      document.documentElement.dataset.easyMode = easyHomeActive ? 'on' : 'off'
    }
    applyPreferences()
    media.addEventListener('change', applyPreferences)
    window.localStorage.setItem('onfactory-theme', theme)
    window.localStorage.setItem('onfactory-font', fontSize)
    window.localStorage.setItem('onfactory-accent', accent)
    window.localStorage.setItem('onfactory-easy-mode', easyMode)
    return () => media.removeEventListener('change', applyPreferences)
  }, [theme, fontSize, accent, easyMode, easyHomeActive])

  useEffect(() => {
    if (authStatus === 'signed-in' && mode === 'platform' && account?.role !== 'platform-operator') {
      setMode('tenant')
      setPage('ai')
    }
  }, [account, authStatus, mode])

  const tenantName = account?.tenantName ?? '고객사'
  const collaborationIdentity = {
    currentUserId: account?.id ?? '',
    currentUserName: account?.name ?? '사용자',
    currentUserTeam: account?.team ?? '미지정',
    canManage: account?.role === 'tenant-admin',
  }
  const tenantWorkItems = workItems
  const scopedWorkItems = account?.role === 'tenant-member'
    ? tenantWorkItems.filter((item) => item.ownerId === account.id || item.requesterId === account.id)
    : tenantWorkItems
  const nextWorkNotice = scopedWorkItems
    .filter((item) => item.status !== '결재완료')
    .sort((a, b) => (a.priority === b.priority ? formatWorkDue(a.due).localeCompare(formatWorkDue(b.due)) : ['긴급', '높음', '보통'].indexOf(a.priority) - ['긴급', '높음', '보통'].indexOf(b.priority)))[0]
  const todayKey = seoulDateInputValue()
  const nextSharedEvent = [...dashboardCalendarEvents]
    .filter((event) => event.date.slice(0, 10) >= todayKey)
    .sort((a, b) => `${a.date}T${a.start}`.localeCompare(`${b.date}T${b.start}`))[0]
  const channelAttention = dashboardSalesChannels.find((channel) => ['주의', '오류'].includes(channel.status) || channel.connectionStatus === 'setup-required')
  const workspaceHasOperatingData = workItems.length > 0 || dashboardProducts.length > 0 || dashboardSalesChannels.length > 0 || dashboardCalendarEvents.length > 0
  const primaryTenantNotice = nextWorkNotice
    ? { title: nextWorkNotice.title, detail: `${formatWorkDue(nextWorkNotice.due)} · ${workStatusLabel(nextWorkNotice.status)}`, page: 'tasks' as PageId }
    : workspaceHasOperatingData
      ? { title: '현재 확인할 미완료 업무가 없습니다', detail: '새 업무가 배정되면 알림과 업무 화면에 표시됩니다.', page: 'tasks' as PageId }
      : { title: '워크스페이스 초기 설정을 시작해 주세요', detail: '제품·창고·판매채널을 연결하면 AI 알림이 활성화됩니다.', page: 'products' as PageId }
  const secondaryTenantNotice = channelAttention
    ? { title: `${channelAttention.name} 연결 상태를 확인해 주세요`, detail: `현재 상태 · ${channelAttention.status}`, page: 'sales' as PageId }
    : nextSharedEvent
      ? { title: nextSharedEvent.title, detail: `${formatWorkDue(`${nextSharedEvent.date}T${nextSharedEvent.start}:00`)} · ${nextSharedEvent.location || '장소 미정'}`, page: 'schedule' as PageId }
      : { title: '첫 공유 일정을 등록해 보세요', detail: `${tenantName} 구성원에게 일정을 공유할 수 있습니다.`, page: 'schedule' as PageId }
  const workAssignees: WorkAssignee[] = directoryAssignees
  const industryRoutes = new Set<string>(routesForIndustry(account?.industryType))
  // 메뉴 라벨·아이콘·업종 경로는 레지스트리만이 결정한다. App은 실데이터 배지만 결합한다.
  const tenantNavByIndustry: NavItem[] = navigationForIndustry(account?.industryType).map((item) => ({
    ...item,
    badge: item.id === 'tasks'
      ? scopedWorkItems.filter((workItem) => workItem.status !== '결재완료').length
      : item.id === 'approvals' ? pendingProposals : undefined,
  }))
  const tenantNav = account?.role === 'tenant-member' ? tenantNavByIndustry.filter((item) => tenantMemberPages.has(item.id)) : tenantNavByIndustry
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
  const platformServiceAttention = platformTenants.find((tenant) => tenant.service === '주의')
  const primaryPlatformNotice = openPlatformTickets[0]
    ? { title: openPlatformTickets[0].title, detail: `${openPlatformTickets[0].tenant} · ${openPlatformTickets[0].priority} · SLA ${openPlatformTickets[0].sla}` }
    : { title: '열린 CS 티켓이 없습니다', detail: '새 고객사 요청이 접수되면 여기에 표시됩니다.' }
  const secondaryPlatformNotice = platformServiceAttention
    ? { title: `${platformServiceAttention.name} 서비스 상태를 확인해 주세요`, detail: `미처리 티켓 ${platformServiceAttention.metrics.openTickets}건 · 마지막 활동 ${platformServiceAttention.metrics.lastActivityAt ? formatDateTime(platformServiceAttention.metrics.lastActivityAt) : '아직 데이터 없음'}` }
    : { title: '고객사 서비스가 정상 상태입니다', detail: `현재 관리 중인 고객사 ${platformTenants.length}곳 기준입니다.` }
  const platformNav: NavItem[] = [
    { id: 'platform', label: '운영 개요', icon: Home },
    { id: 'tenants', label: '고객사 관리', icon: Building2, badge: platformTenants.length },
    { id: 'support', label: 'CS 지원센터', icon: Headphones, badge: openPlatformTickets.length },
    { id: 'integrations', label: '연동 상태', icon: Layers3 },
    { id: 'billing', label: '비용 · 포인트', icon: BarChart3 },
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
    const products = dashboardProducts.filter((product) => (product.name + ' ' + product.code + ' ' + product.category).toLowerCase().includes(value)).slice(0, 4).map((product) => ({ id: product.id, title: product.name, meta: product.code + ' · ' + product.category, page: 'products' as PageId, icon: Package }))
    const taskScope = account?.role === 'tenant-member'
      ? scopedWorkItems
      : tenantWorkItems
    const tasks = taskScope.filter((work) => (work.title + ' ' + work.owner + ' ' + work.id + ' ' + workStatusLabel(work.status)).toLowerCase().includes(value)).slice(0, 3).map((work) => ({ id: work.id, title: work.title, meta: work.owner + ' · ' + workStatusLabel(work.status), page: 'tasks' as PageId, icon: ListChecks }))
    return [...products, ...tasks]
  }, [account, dashboardProducts, mode, platformTenants, platformTickets, query, scopedWorkItems, tenantWorkItems])

  const navigate = (nextPage: PageId) => {
    if (mode === 'tenant' && account?.role === 'tenant-member' && !tenantMemberPages.has(nextPage)) {
      setToast('현재 직무 권한에서는 이 메뉴에 접근할 수 없습니다.')
      setMobileNav(false)
      return
    }
    if (mode === 'tenant' && !industryRoutes.has(nextPage)) {
      setToast('이 회사의 업종 모듈에 없는 메뉴입니다.')
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
    setMode('platform')
    setPage('platform')
    setMobileNav(false)
    setQuery('')
    window.scrollTo({ top: 0, behavior: 'auto' })
  }
  // 운영자 모드: 콘솔의 [접속]으로 고객사 워크스페이스 전체를 관리자 권한으로 사용한다.
  const enterTenant = async (tenantId: string) => {
    try {
      const response = await fetch(`/api/platform/tenants/${encodeURIComponent(tenantId)}/enter`, { method: 'POST' })
      const body = await response.json() as { account?: AuthAccount; error?: { message?: string } }
      if (!response.ok || !body.account) { setToast(body.error?.message || '고객사 워크스페이스에 접속하지 못했습니다.'); return }
      setAccount(body.account)
      publishSessionChange(sessionIdentity(body.account))
      setPlatformFocusId(undefined)
      setMode('tenant')
      setPage('ai')
      setToast(`운영자 모드로 ${body.account.tenantName ?? '고객사'} 워크스페이스에 접속했습니다. 모든 행위가 감사 기록에 남습니다.`)
    } catch { setToast('플랫폼 서버에 연결할 수 없습니다.') }
  }
  const exitTenant = async () => {
    try {
      const response = await fetch('/api/platform/exit', { method: 'POST' })
      const body = await response.json() as { account?: AuthAccount; error?: { message?: string } }
      if (!response.ok || !body.account) { setToast(body.error?.message || '운영자 모드를 종료하지 못했습니다.'); return }
      setAccount(body.account)
      publishSessionChange(sessionIdentity(body.account))
      setTaskDraft(null)
      setMessengerOpen(false)
      setMode('platform')
      setPage('platform')
      setToast('운영자 모드를 종료하고 플랫폼 콘솔로 돌아왔습니다.')
    } catch { setToast('플랫폼 서버에 연결할 수 없습니다.') }
  }
  const requestTenantSupportAccess = () => {
    const targetTenant = platformTenants[0]
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
      const body = await response.json() as { item?: WorkItem; version?: string; error?: { message?: string } }
      if (!response.ok || !body.item) { setToast(body.error?.message || '업무 상태를 변경하지 못했습니다.'); return false }
      await setWorkItems((current) => current.map((item) => item.id === id ? body.item! : item), { persist: false, serverVersion: body.version })
      setToast({ accept: '업무를 시작했습니다.', submit: '완료 보고를 제출했습니다. 이제 확인 결과를 기다리면 됩니다.', approve: '확인을 마치고 업무를 완료했습니다.', 'request-changes': '보완 요청을 담당자에게 전달했습니다.' }[action])
      return true
    } catch { setToast('업무 처리 서버에 연결할 수 없습니다.'); return false }
  }
  const advanceTask = (item: WorkItem) => {
    if (item.status === '업무요청') void transitionTask(item.id, 'accept')
    else { navigate('tasks'); setToast(item.status === '수행중' ? '업무 행의 ‘완료 보고하기’를 눌러 결과를 제출해 주세요.' : '업무 행의 ‘확인하기’를 눌러 완료 보고를 검토해 주세요.') }
  }
  const saveTask = async (item: WorkItem) => {
    const result = await setWorkItems((current) => [item, ...current])
    if (!result.ok) return false
    setTaskDraft(null)
    setToast(item.owner + '님에게 업무를 지시했습니다.')
    navigate('tasks')
    return true
  }
  const createWorkRule = async (input: Record<string, unknown>) => {
    if (!workspaceScope) return false
    try {
      const response = await fetch('/api/work-rules', { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-identity': workspaceScope }, body: JSON.stringify(input) })
      const body = await response.json() as { rule?: WorkRule; created?: WorkItem[]; version?: string; workItemsVersion?: string; error?: { message?: string } }
      if (!response.ok || !body.rule) { setToast(body.error?.message || '반복 업무 규칙을 만들지 못했습니다.'); return false }
      await setWorkRules((current) => [body.rule!, ...current.filter((rule) => rule.id !== body.rule!.id)], { persist: false, serverVersion: body.version })
      if (body.created?.length) await setWorkItems((current) => [...body.created!.filter((created) => !current.some((item) => item.id === created.id)), ...current], { persist: false, serverVersion: body.workItemsVersion })
      setToast(body.created?.length ? `규칙을 만들고 도래 업무 ${body.created.length}건을 생성했습니다.` : '반복 업무 규칙을 만들었습니다.')
      return true
    } catch { setToast('반복 업무 서버에 연결할 수 없습니다.'); return false }
  }
  const toggleWorkRule = async (rule: WorkRule) => {
    if (!workspaceScope) return false
    try {
      const response = await fetch(`/api/work-rules/${encodeURIComponent(rule.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-workspace-identity': workspaceScope }, body: JSON.stringify({ active: !rule.active }) })
      const body = await response.json() as { rule?: WorkRule; created?: WorkItem[]; version?: string; workItemsVersion?: string; error?: { message?: string } }
      if (!response.ok || !body.rule) { setToast(body.error?.message || '반복 규칙 상태를 바꾸지 못했습니다.'); return false }
      await setWorkRules((current) => current.map((item) => item.id === rule.id ? body.rule! : item), { persist: false, serverVersion: body.version })
      if (body.created?.length) await setWorkItems((current) => [...body.created!.filter((created) => !current.some((item) => item.id === created.id)), ...current], { persist: false, serverVersion: body.workItemsVersion })
      setToast(body.rule.active ? '반복 업무를 다시 활성화했습니다.' : '반복 업무를 일시 중지했습니다.')
      return true
    } catch { setToast('반복 업무 서버에 연결할 수 없습니다.'); return false }
  }
  const deleteWorkRule = async (rule: WorkRule) => {
    if (!window.confirm(`‘${rule.title}’ 반복 규칙을 삭제할까요? 이미 생성된 업무와 결재 기록은 유지됩니다.`)) return false
    const result = await setWorkRules((current) => current.filter((item) => item.id !== rule.id))
    if (!result.ok) { setToast(result.message || '반복 업무 규칙을 삭제하지 못했습니다.'); return false }
    setToast('반복 업무 규칙을 삭제했습니다. 이미 생성된 업무는 그대로 유지됩니다.')
    return true
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
    setReadNoticeIds([])
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
      if (page === 'billing') return <BillingDashboard mode="platform" tenantOptions={platformTenants.map((tenant) => ({ id: tenant.id, name: tenant.name }))} onToast={setToast} />
      return <PlatformConsole section={page as PlatformSection} focusId={platformFocusId} refreshToken={platformRefreshToken} onSectionChange={(section) => navigate(section)} onReturnTenant={requestTenantSupportAccess} onRequestSupport={setSupportTenant} onEnterTenant={(tenantId) => void enterTenant(tenantId)} onDataChanged={() => setPlatformRefreshToken((current) => current + 1)} onToast={setToast} />
    }
    if (account?.role === 'tenant-member' && !tenantMemberPages.has(page)) {
      return <AIHome workItems={scopedWorkItems} products={dashboardProducts} salesChannels={dashboardSalesChannels} calendarEvents={dashboardCalendarEvents} currentUserName={account.name} currentUserId={account.id} companyName={tenantName} canAssignTasks={false} workspaceScope={workspaceScope} easyMode={easyHomeActive} industryType={account?.industryType ?? 'food_manufacturing'} onAdvanceTask={advanceTask} onCreateTask={(text = '', completionCriteria = '') => setTaskDraft({ title: text, completionCriteria })} onNavigate={navigate} onOpenAlerts={() => { setNotificationsOpen(true); setMessengerOpen(false) }} onToast={setToast} />
    }
    switch (page) {
      case 'schedule': return <SchedulePage {...collaborationIdentity} workspaceScope={workspaceScope} onToast={setToast} />
      case 'tasks': return <WorkPage items={scopedWorkItems} rules={workRules} currentUserId={account?.id ?? ''} canAssignTasks={account?.role === 'tenant-admin'} assignees={workAssignees} workspaceScope={workspaceScope} focusId={workFocusId} onToast={setToast} onCreate={() => setTaskDraft({ title: '', completionCriteria: '' })} onTransition={transitionTask} onCreateRule={createWorkRule} onToggleRule={toggleWorkRule} onDeleteRule={deleteWorkRule} />
      case 'journal': return <DailyJournalPage {...collaborationIdentity} workspaceScope={workspaceScope} onToast={setToast} />
      case 'projects': return <ProjectSpacesPage workspaceScope={workspaceScope} currentUserId={account?.id ?? ''} currentUserName={account?.name ?? ''} canManage={account?.role === 'tenant-admin'} onToast={setToast} />
      case 'finance': return <TaxAssetsPage workspaceScope={workspaceScope} canManage={account?.role === 'tenant-admin'} currentUserId={account?.id ?? ''} currentUserName={account?.name ?? ''} onToast={setToast} />
      case 'ip': return <IpRightsPage workspaceScope={workspaceScope} canManage={account?.role === 'tenant-admin'} currentUserName={account?.name ?? ''} onToast={setToast} />
      case 'products': return <ProductManagement onToast={setToast} canManage={account?.role === 'tenant-admin'} companyName={tenantName} workspaceScope={workspaceScope} />
      case 'inventory': return <InventoryPage onToast={setToast} canManage={account?.role === 'tenant-admin'} workspaceScope={workspaceScope} />
      case 'factory': return <FactoryManagement onToast={setToast} canManage={account?.role === 'tenant-admin'} companyName={tenantName} workspaceScope={workspaceScope} />
      case 'sales': return <SalesChannels onToast={setToast} workspaceScope={workspaceScope} companyName={tenantName} canManage={account?.role === 'tenant-admin'} />
      case 'people': return <PeopleOperationsPage initialTab={peopleInitialTab} onOpenTask={(taskId) => { setWorkFocusId(taskId); navigate('tasks') }} onToast={setToast} canManage={account?.role === 'tenant-admin'} currentUserId={account?.id} currentUserName={account?.name ?? ''} currentUserTeam={account?.team ?? '미지정'} workspaceScope={workspaceScope} />
      case 'approvals': return <ApprovalQueue workspaceScope={workspaceScope} onToast={setToast} onOpenTask={(taskId) => { setWorkFocusId(taskId); navigate('tasks') }} onPendingChange={setPendingProposals} />
      case 'documents': return <CompanyLibrary workspaceScope={workspaceScope} canManage={account?.role === 'tenant-admin'} currentUserId={account?.id ?? ''} companyName={tenantName} industryType={account?.industryType ?? 'food_manufacturing'} onToast={setToast} />
      case 'compliance': return <ComplianceCenter workspaceScope={workspaceScope} canManage={account?.role === 'tenant-admin'} currentUserName={account?.name ?? ''} companyName={tenantName} onToast={setToast} />
      case 'it-projects': return <ProjectSpacesPage workspaceScope={workspaceScope} currentUserId={account?.id ?? ''} currentUserName={account?.name ?? ''} canManage={account?.role === 'tenant-admin'} onToast={setToast} />
      case 'it-deliverables':
      case 'it-contracts': return <ItServicesPage view={page as ItServicesView} workspaceScope={workspaceScope} canManage={account?.role === 'tenant-admin'} currentUserId={account?.id ?? ''} currentUserName={account?.name ?? ''} onToast={setToast} />
      default: return <AIHome workItems={scopedWorkItems} products={dashboardProducts} salesChannels={dashboardSalesChannels} calendarEvents={dashboardCalendarEvents} currentUserName={account?.name ?? ''} currentUserId={account?.id ?? ''} companyName={tenantName} canAssignTasks={account?.role === 'tenant-admin'} workspaceScope={workspaceScope} easyMode={easyHomeActive} industryType={account?.industryType ?? 'food_manufacturing'} pendingProposals={pendingProposals} onAdvanceTask={advanceTask} onCreateTask={(text = '', completionCriteria = '') => setTaskDraft({ title: text, completionCriteria })} onNavigate={navigate} onOpenAlerts={() => { setNotificationsOpen(true); setMessengerOpen(false) }} onToast={setToast} />
    }
  }

  if (authStatus === 'checking') return <main className="auth-loading" aria-live="polite"><OnFactoryMark size={48} /><strong>온팩토리</strong><span>안전한 세션을 확인하고 있습니다…</span></main>
  if (authStatus === 'signed-out') return <LoginPage onLogin={login} initialError={toast} />
  if (account?.requiresPasswordChange) return <PasswordChangePage name={account.name} email={account.email} onChange={changeInitialPassword} onLogout={logout} />

  return (
    <div className={'app-shell ' + mode + (storeStatus?.readOnly ? ' has-store-banner' : '') + (account?.operatorMode ? ' has-operator-banner' : '')}>
      <a className="skip-link" href="#main-content">본문으로 바로가기</a>
      {account?.operatorMode && <div className="operator-mode-banner" role="status"><ShieldCheck size={17} /><span><strong>운영자 모드</strong> — {account.operatorMode.tenantName} 접속 중 · 모든 조회·변경이 운영자 {account.operatorMode.operatorName} 이름으로 감사 기록에 남습니다.</span><button type="button" onClick={() => void exitTenant()}>나가기</button></div>}
      {storeStatus?.readOnly && <div className="store-readonly-banner" role="alert"><AlertTriangle size={17} /><span><strong>읽기 전용 모드</strong> — 저장소가 읽기 전용(STORE_READ_ONLY)으로 기동되어 모든 변경이 저장되지 않습니다.{storeStatus.fallbackReason ? ` ${storeStatus.fallbackReason}` : ''}</span></div>}
      {isMobile && mobileNav && <button type="button" className="nav-scrim" aria-label="메뉴 닫기" onClick={() => setMobileNav(false)} />}
      <aside id="main-navigation" className={'sidebar ' + (mobileNav ? 'open' : '')} aria-label={mode === 'platform' ? '플랫폼 운영 메뉴' : `${tenantName} 업무 메뉴`} aria-hidden={isMobile && !mobileNav} inert={isMobile && !mobileNav ? true : undefined}>
        <div className="brand"><OnFactoryMark /><div><strong>온팩토리</strong><span>{mode === 'platform' ? 'PLATFORM OPS' : brandLabelForIndustry(account?.industryType)}</span></div><button type="button" className="sidebar-close" aria-label="메뉴 닫기" onClick={() => setMobileNav(false)}><X size={21} /></button></div>
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
          <div className="topbar-left"><button className="menu-button" type="button" aria-label="메뉴 열기" aria-controls="main-navigation" aria-expanded={mobileNav} onClick={() => setMobileNav(true)}><Menu size={22} /></button><div className="breadcrumb"><span>{mode === 'platform' ? '온팩토리 운영자' : tenantName}</span><strong>{mode === 'platform' ? platformPageTitles[page as PlatformSection | 'billing'] : routeLabel(page as TenantRouteId)}</strong></div></div>
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
            <div className="notification-wrap" ref={notificationWrapRef}>
              <button type="button" className={'top-icon-button ' + (notificationsOpen ? 'active' : '')} aria-label={'알림 ' + unread + '개'} aria-controls="notification-panel" aria-expanded={notificationsOpen} onClick={() => { setNotificationsOpen((value) => !value); setMessengerOpen(false) }}><NotificationBellIcon />{unread > 0 && <span>{unread}</span>}</button>
              {notificationsOpen && <section className="notification-panel" id="notification-panel">
                <header><div><h2>알림</h2><p>{unread > 0 ? `읽지 않은 알림 ${unread}개` : '모든 알림을 읽었습니다.'}</p></div><button type="button" disabled={unread === 0} onClick={() => setReadNoticeIds([...noticeIds])}>모두 읽음</button></header>
                <div className="notification-list">
                  {([
                    { id: 'primary', tone: 'red', icon: <AlertTriangle size={17} />, title: mode === 'tenant' ? primaryTenantNotice.title : primaryPlatformNotice.title, detail: mode === 'tenant' ? primaryTenantNotice.detail : primaryPlatformNotice.detail, open: () => navigate(mode === 'tenant' ? primaryTenantNotice.page : 'support') },
                    { id: 'secondary', tone: 'amber', icon: <Package size={17} />, title: mode === 'tenant' ? secondaryTenantNotice.title : secondaryPlatformNotice.title, detail: mode === 'tenant' ? secondaryTenantNotice.detail : secondaryPlatformNotice.detail, open: () => navigate(mode === 'tenant' ? secondaryTenantNotice.page : 'integrations') },
                    { id: 'tertiary', tone: 'green', icon: <CheckCircle2 size={17} />, title: mode === 'tenant' && dashboardSalesChannels.length === 0 ? '판매채널 연결을 기다리고 있습니다' : mode === 'tenant' ? `판매채널 ${dashboardSalesChannels.length}개의 상태를 불러왔습니다` : '플랫폼 운영 데이터를 불러왔습니다', detail: mode === 'tenant' && dashboardSalesChannels.length === 0 ? '판매채널을 연결하면 주문과 재고 동기화 상태가 표시됩니다.' : '표시된 값은 현재 워크스페이스에서 받은 데이터 기준입니다.', open: undefined as (() => void) | undefined },
                  ]).map((notice) => {
                    const isRead = readNoticeIds.includes(notice.id)
                    return <button type="button" key={notice.id} className={isRead ? 'is-read' : 'is-unread'} aria-label={`${isRead ? '읽음' : '읽지 않음'} · ${notice.title}`} onClick={() => { setReadNoticeIds((current) => current.includes(notice.id) ? current : [...current, notice.id]); notice.open?.(); setNotificationsOpen(false) }}><span className={`notice-icon ${notice.tone}`}>{notice.icon}</span><div><strong>{notice.title}</strong><p>{notice.detail}</p><small>{isRead ? '읽음' : '읽지 않음 · 현재 상태'}</small></div><i className="notice-state" aria-hidden="true" /></button>
                  })}
                </div>
              </section>}
            </div>
          </div>
        </header>
        <main id="main-content" className="main-content" tabIndex={-1}>{renderPage()}</main>
      </div>

      <MessengerDrawer {...collaborationIdentity} workspaceScope={workspaceScope} open={messengerOpen} onClose={() => setMessengerOpen(false)} onToast={setToast} onUnreadChange={setMessengerUnread} />
      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} profileName={account?.name ?? '사용자'} profileRole={account?.jobRole ?? '사용자'} companyName={account?.tenantName ?? '온팩토리'} theme={theme} fontSize={fontSize} accent={accent} easyMode={easyMode} onThemeChange={setTheme} onFontSizeChange={setFontSize} onAccentChange={setAccent} onEasyModeChange={setEasyMode} onLogout={logout} onEditProfile={() => { setSettingsOpen(false); setProfileOpen(true) }} />
      {profileOpen && account && <ProfileEditor account={account} onClose={() => setProfileOpen(false)} onToast={setToast} onSaved={(next) => { setAccount((current) => current ? { ...current, ...next } as AuthAccount : current) }} />}
      <WorkspaceNavigationEditor open={navEditorOpen} source={tenantNavSource} preferences={tenantNavPreferences} onChange={setTenantNavPreferences} onClose={() => setNavEditorOpen(false)} />
      {taskDraft !== null && <TaskModal initialText={taskDraft.title} initialDescription={taskDraft.completionCriteria} requesterName={account?.name ?? '사용자'} requesterId={account?.id ?? ''} assignees={workAssignees} workspaceScope={workspaceScope} onClose={() => setTaskDraft(null)} onSave={saveTask} />}
      {supportTenant && <SupportSessionModal tenant={supportTenant} tickets={platformTickets} onClose={() => setSupportTenant(null)} onCreate={createPlatformSupportSession} />}
      {toast && <div className="toast" role="status"><CheckCircle2 size={19} /><span>{toast}</span><button type="button" aria-label="알림 닫기" onClick={() => setToast('')}><X size={16} /></button></div>}
    </div>
  )
}

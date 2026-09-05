import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Bell, CheckCircle2, ChevronDown, ClipboardCheck, Clock3, Download, FileText, FolderKanban, ListChecks, LogIn, MessageCircle, Paperclip, Settings2, ShieldCheck } from 'lucide-react'
import { BrandMark } from './AppIcons'
import { Button, IconButton } from './ui/Button'
import { StatusBadge } from './StatusBadge'
import { CompletionModal } from './CompletionModal'
import { NotificationCenter, type NotificationFeed } from './NotificationCenter'
import { MessengerDrawer, type MessengerRosterEntry } from './CollaborationSuite'
import { ProjectSpacesPage } from './ProjectSpaces'
import { ParentChip, SubtaskRows } from './SubtaskList'
import { IndustryProvider } from '../modules/IndustryContext'
import { useEventStream } from '../hooks/useEventStream'
import { formatDateLabel, formatDateTime, formatWorkDue } from '../utils/dateTime'
import { workStatusLabel, workStatusTone } from '../utils/workStatus'
import { childrenOf, isSubtask, isTopLevelIn, subtaskBlockMessage, subtaskBlockReason, subtaskCountLabel } from '../utils/workTree'
import type { WorkEvidence, WorkItem } from '../domainData'
import { BRAND } from '../brand'
import './GuestWorkspace.css'

/**
 * 외부 게스트 전용 화면.
 *
 * 게스트는 사이드바·탑바·휴대폰 탭 막대를 보지 않는다. 이 컴포넌트가 셸이고, 안에는
 * 초대된 프로젝트의 업무·채널·자료·게시판 네 탭만 있다. 서버 게이트(guestRouteGate)가
 * 나머지 API를 전부 403으로 끊으므로 여기서는 허용 목록(§3-2)에 있는 라우트만 부른다.
 */

type GuestAccount = {
  id: string
  name: string
  email: string
  tenantId: string | null
  tenantName: string | null
  team?: string
  industryType?: string
  guestScope?: { grantId: string; projectIds: string[]; orgName: string; accessExpiresAt: string | null; invitedByName: string }
}

type GuestScopeProject = { id: string; name: string; stage?: string; status?: string }
type GuestMe = {
  account: GuestAccount
  scope: { projects: GuestScopeProject[]; orgName: string; accessExpiresAt: string | null; invitedByName: string; tenantName: string }
}

type GuestDocument = {
  id: string
  name: string
  size: number
  category?: string
  summary?: string
  uploadedAt: string
  uploadedByName?: string
  uploadedByRole?: string
  projectId?: string
}

type GuestTab = 'tasks' | 'channels' | 'files' | 'board'
type ScopeState = 'loading' | 'ready' | 'ended' | 'error'

const TABS: Array<{ id: GuestTab; label: string; icon: typeof ListChecks }> = [
  { id: 'tasks', label: '업무', icon: ListChecks },
  { id: 'channels', label: '채널', icon: MessageCircle },
  { id: 'files', label: '자료', icon: FileText },
  { id: 'board', label: '게시판', icon: FolderKanban },
]

// 상태 문구·색은 src/utils/workStatus.ts 한 곳에서만 정한다 — 게스트가 보는 말이 직원 화면과 달라서는 안 된다.

function humanSize(size: number) {
  return size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`
}

async function readJson<T>(response: Response): Promise<T & { error?: { code?: string; message?: string; count?: number } }> {
  const text = await response.text()
  try { return JSON.parse(text) } catch { return { error: { message: text } } as T & { error?: { code?: string; message?: string } } }
}

export function GuestWorkspace({ account, workspaceScope, notificationFeed, onReloadNotifications, onLogout, onToast, onOpenSettings }: {
  account: GuestAccount
  workspaceScope?: string
  /** 알림은 App이 한 번만 읽어 내려 준다(멘션·업무 배정·보완 요청). 게스트에게도 알림 표면이 있어야 그 요청에 답할 수 있다. */
  notificationFeed: NotificationFeed | null
  onReloadNotifications: () => Promise<void> | void
  onLogout: () => void
  onToast: (message: string) => void
  onOpenSettings: () => void
}) {
  const headers = useMemo(() => {
    const value: Record<string, string> = {}
    if (workspaceScope) value['x-workspace-identity'] = workspaceScope
    return value
  }, [workspaceScope])
  const [me, setMe] = useState<GuestMe | null>(null)
  const [scopeState, setScopeState] = useState<ScopeState>('loading')
  const [tab, setTab] = useState<GuestTab>('tasks')
  const [projectId, setProjectId] = useState('')
  const [workItems, setWorkItems] = useState<WorkItem[]>([])
  const [workState, setWorkState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  /** 하위 목록을 펼쳐 둔 상위. 자식을 닫았다고 목록까지 접히면 형제 행을 훑던 자리를 잃는다. */
  const [openChildLists, setOpenChildLists] = useState<Set<string>>(() => new Set())
  const [completionItem, setCompletionItem] = useState<WorkItem | null>(null)
  const [busyTaskId, setBusyTaskId] = useState('')
  const [documents, setDocuments] = useState<GuestDocument[]>([])
  const [documentsState, setDocumentsState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [roster, setRoster] = useState<MessengerRosterEntry[]>([])
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const notificationWrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!notificationsOpen) return
    const onPointerDown = (event: PointerEvent) => { if (!notificationWrapRef.current?.contains(event.target as Node)) setNotificationsOpen(false) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setNotificationsOpen(false) }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onPointerDown); document.removeEventListener('keydown', onKey) }
  }, [notificationsOpen])
  const unread = notificationFeed?.unread ?? 0

  const projects = me?.scope.projects ?? []
  const orgName = me?.scope.orgName || account.guestScope?.orgName || account.team || '외부 거래처'
  const tenantName = me?.scope.tenantName || account.tenantName || BRAND.name
  const accessExpiresAt = me?.scope.accessExpiresAt ?? account.guestScope?.accessExpiresAt ?? null
  const selectedProject = projects.find((project) => project.id === projectId) ?? projects[0]

  // 진입 시 범위 조회. 403 GUEST_ACCESS_ENDED는 "끝났다"는 화면으로, 그 밖의 실패는 재시도 안내로 나눈다.
  useEffect(() => {
    let active = true
    setScopeState('loading')
    fetch('/api/guest/me', { headers })
      .then(async (response) => {
        const body = await readJson<GuestMe>(response)
        if (!active) return
        if (response.status === 403 && body.error?.code === 'GUEST_ACCESS_ENDED') { setScopeState('ended'); return }
        if (!response.ok || !body.scope) { setScopeState('error'); return }
        setMe(body)
        setScopeState('ready')
        setProjectId((current) => current && body.scope.projects.some((project) => project.id === current) ? current : body.scope.projects[0]?.id ?? '')
      })
      .catch(() => { if (active) setScopeState('error') })
    return () => { active = false }
  }, [headers])

  const loadWorkItems = useCallback(async () => {
    try {
      const response = await fetch('/api/workspace/work-items', { headers })
      const body = await readJson<{ data?: WorkItem[] | null }>(response)
      if (!response.ok) throw new Error(body.error?.message || '업무를 불러오지 못했습니다.')
      setWorkItems(Array.isArray(body.data) ? body.data : [])
      setWorkState('ready')
    } catch { setWorkState('error') }
  }, [headers])

  const loadDocuments = useCallback(async () => {
    try {
      const response = await fetch('/api/documents', { headers })
      const body = await readJson<{ documents?: GuestDocument[] }>(response)
      if (!response.ok) throw new Error(body.error?.message || '자료를 불러오지 못했습니다.')
      setDocuments(Array.isArray(body.documents) ? body.documents : [])
      setDocumentsState('ready')
    } catch { setDocumentsState('error') }
  }, [headers])

  useEffect(() => {
    if (scopeState !== 'ready') return
    void loadWorkItems()
    void loadDocuments()
    // 채널 로스터는 프로젝트 멤버만. 전 직원 명단 라우트는 게스트에게 닫혀 있고, 열려 있더라도 외부인에게 줄 이유가 없다.
    let active = true
    fetch('/api/projects', { headers })
      .then(async (response) => response.ok ? readJson<{ directory?: MessengerRosterEntry[] }>(response) : { directory: [] })
      .then((body) => { if (active) setRoster(Array.isArray(body.directory) ? body.directory : []) })
      .catch(() => { if (active) setRoster([]) })
    return () => { active = false }
  }, [scopeState, headers, loadWorkItems, loadDocuments])

  // 게스트 스트림은 제목 없이 {key, version}만 온다. 무엇이 바뀌었는지는 다시 읽어서 안다.
  // App은 게스트 세션에서 자기 스트림을 열지 않으므로 알림 갱신도 이 한 구독이 맡는다(연결 수를 줄인다).
  useEventStream(scopeState === 'ready', (event) => {
    if (event.kind === 'work' || event.kind === 'resync') void loadWorkItems()
    if (event.kind === 'notification' || event.kind === 'resync') void onReloadNotifications()
  })

  /**
   * 하위 목록의 펼침은 이 집합 하나가 정한다.
   * <details>의 open을 계산식(`집합 || 행이 열림 || 자식이 열림`)으로 두면, 값이 true에 머무는 동안
   * React가 DOM에 다시 쓰지 않아 한 번 접힌 목록을 코드로는 두 번 다시 펼 수 없다. 그래서 '펼쳐야 하는 사건'마다 집합에 넣는다.
   */
  const openChildList = (parentId: string) => setOpenChildLists((current) => current.has(parentId) ? current : new Set(current).add(parentId))
  /** 연 업무가 자식이면 그 상위의 목록을, 상위면 자기 목록을 펼친다. */
  const openChildListOf = (taskId: string) => {
    const parentId = workItems.find((entry) => entry.id === taskId)?.parentId
    openChildList(parentId ?? taskId)
  }

  // 알림에서 넘어오기: 업무 알림은 업무 탭에서 그 업무를 펼치고, 멘션은 채널 탭으로. 그 밖(승인 큐·AI)은 게스트 화면에 없다.
  const openFromNotification = (page: string, focusId: string) => {
    // 하위 업무 알림이면 그 자식을 품은 상위의 목록도 함께 펼친다 — 접힌 <details> 안에서 상세를 열면 화면에는 아무 일도 일어나지 않는다.
    if (page === 'tasks') { setTab('tasks'); if (focusId) { setOpenTaskId(focusId); openChildListOf(focusId) } return }
    if (page === 'messenger') { setTab('channels'); return }
    setTab('tasks')
  }

  const transition = async (item: WorkItem, action: 'accept' | 'submit', input: Record<string, unknown> = {}) => {
    setBusyTaskId(item.id)
    try {
      const response = await fetch(`/api/work-items/${encodeURIComponent(item.id)}/transition`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ action, ...input }),
      })
      const body = await readJson<{ item?: WorkItem }>(response)
      if (!response.ok || !body.item) {
        // 버튼에 붙은 경고와 거절 토스트가 같은 말이어야 한다 — 서버 문장을 그대로 쓰면 같은 사실이 두 문장이 되고, 내부 상태어('결재완료')도 새어 나온다.
        const blocked = body.error?.code === 'SUBTASKS_INCOMPLETE' && typeof body.error.count === 'number' ? subtaskBlockMessage(body.error.count) : ''
        onToast(blocked || body.error?.message || '업무 상태를 변경하지 못했습니다.')
        return false
      }
      setWorkItems((current) => current.map((entry) => entry.id === item.id ? body.item! : entry))
      onToast(action === 'accept' ? '업무를 시작했습니다.' : '완료 보고를 제출했습니다. 요청한 담당자가 확인합니다.')
      return true
    } catch { onToast('업무 처리 서버에 연결할 수 없습니다.'); return false }
    finally { setBusyTaskId('') }
  }

  const toggleChecklist = async (item: WorkItem, itemId: string, done: boolean) => {
    try {
      const response = await fetch(`/api/work-items/${encodeURIComponent(item.id)}/checklist`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ itemId, done }),
      })
      const body = await readJson<{ task?: WorkItem }>(response)
      if (!response.ok || !body.task) { onToast(body.error?.message || '점검 항목을 저장하지 못했습니다.'); return }
      setWorkItems((current) => current.map((entry) => entry.id === item.id ? body.task! : entry))
    } catch { onToast('업무 처리 서버에 연결할 수 없습니다.') }
  }

  const download = async (document: GuestDocument) => {
    try {
      const response = await fetch(`/api/documents/${encodeURIComponent(document.id)}/download`, { headers })
      if (!response.ok) { const body = await readJson<Record<string, never>>(response); throw new Error(body.error?.message || '파일을 내려받지 못했습니다.') }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const anchor = window.document.createElement('a')
      anchor.href = url
      anchor.download = document.name
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (reason) { onToast(reason instanceof Error ? reason.message : '파일을 내려받지 못했습니다.') }
  }

  // 업무는 서버가 이미 "내 담당"으로 잘라 준다. 여기서는 고른 프로젝트로 한 번 더 좁힌다.
  // 상위가 보이는 자식은 목록에서 빼고 상위 행 안에서만 그린다. 상위를 못 보면 그 자식이 최상위 행이 된다.
  const visibleIds = new Set(workItems.map((item) => item.id))
  const scopedWork = workItems
    .filter((item) => !selectedProject || !item.projectId || item.projectId === selectedProject.id)
    .filter((item) => isTopLevelIn(item, visibleIds))
    .sort((left, right) => Number(right.status !== '결재완료') - Number(left.status !== '결재완료') || String(left.due).localeCompare(String(right.due)))
  // 탭 배지는 '내가 처리할 건수'다. 목록에서 자식을 상위 아래로 접었다고 해서 건수를 줄이면 맡은 일이 적어 보인다.
  const openWorkCount = workItems.filter((item) => (
    (!selectedProject || !item.projectId || item.projectId === selectedProject.id) && item.status !== '결재완료'
  )).length
  const projectNameOf = (id?: string) => projects.find((project) => project.id === id)?.name

  // 행 버튼은 하나. '완료 보고'가 핵심 행동(primary 후보)이지만, 실제 primary 톤은 펼친 행 한 곳에만 준다 —
  // 진행 중 업무가 여럿이면 화면에 primary가 여러 개 생기기 때문이다(한 화면 기본 버튼 하나).
  const taskAction = (item: WorkItem): { label: string; primary: boolean; blocked?: string; run: () => void } | null => {
    if (item.status === '업무요청') return { label: '업무 시작', primary: false, run: () => void transition(item, 'accept') }
    if (item.status === '수행중') {
      const subtaskReason = subtaskBlockReason(workItems, item.id)
      // 막힌 이유는 눌러 보기 전에 버튼에 붙는다. 게스트 목록은 스트림으로 다시 읽으므로 이 판정은 오래되지 않는다.
      const reason = subtaskReason || ((item.checklist ?? []).some((entry) => !entry.done) ? '점검 항목을 모두 마쳐야 완료 보고를 할 수 있습니다.' : '')
      const blocked = Boolean(reason)
      return { label: item.review?.decision === 'changes-requested' ? '보완 후 재제출' : '완료 보고', blocked: reason || undefined, primary: true, run: () => { if (blocked) { onToast(reason); setOpenTaskId(item.id); return } setCompletionItem(item) } }
    }
    return null
  }

  const submitCompletion = async (summary: string, evidence: WorkEvidence[]) => {
    if (!completionItem) return false
    return transition(completionItem, 'submit', { completion: { summary, evidence } })
  }

  /** 업무 상세 한 벌. 상위 행과 하위 행이 같은 것을 쓴다 — 자식이라고 설명·점검 항목·완료 이력을 못 보면 안 된다. */
  const taskDetail = (item: WorkItem) => {
    const checklist = item.checklist ?? []
    const history = item.completionHistory?.length ? item.completionHistory : item.completion ? [item.completion] : []
    return <div className="guest-task-detail">
      {item.description && <p className="guest-task-description">{item.description}</p>}
      {item.review?.decision === 'changes-requested' && item.status !== '결재완료' && <p className="guest-task-revision"><ClipboardCheck size={14} /> {item.review.requestedChanges || item.review.comment || '요청자가 보완 내용을 남기지 않았습니다.'}</p>}
      {checklist.length > 0 && <ul className="guest-task-checklist" aria-label="점검 항목">
        {checklist.map((entry) => <li key={entry.id}><label><input type="checkbox" checked={entry.done} disabled={item.status !== '수행중' && item.status !== '업무요청'} onChange={() => void toggleChecklist(item, entry.id, !entry.done)} /><span className={entry.done ? 'is-done' : ''}>{entry.label}</span></label></li>)}
      </ul>}
      {history.length > 0 && <div className="guest-task-history">{history.map((completion, index) => <p key={`${completion.submittedAt}-${index}`}><ClipboardCheck size={14} /> <span>{formatDateTime(completion.submittedAt)} 제출 · {completion.summary}</span></p>)}</div>}
      <dl className="guest-task-meta"><div><dt>마감</dt><dd>{formatDateTime(item.due)}</dd></div><div><dt>요청</dt><dd>{item.requestedBy}</dd></div><div><dt>우선순위</dt><dd>{item.priority}</dd></div></dl>
    </div>
  }

  const header = <header className="guest-header">
    <div className="guest-header-brand"><BrandMark size={30} /><div><small>{tenantName}</small><strong>{selectedProject?.name ?? '초대된 프로젝트'}</strong></div></div>
    <div className="guest-header-tools">
      {projects.length > 1 && <label className="guest-project-select"><span className="sr-only">프로젝트 선택</span><select value={selectedProject?.id ?? ''} onChange={(event) => { setProjectId(event.target.value); setOpenTaskId(null) }}>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label>}
      <StatusBadge className="status-pill" tone="warning" icon={<ShieldCheck size={13} />}>게스트 · {orgName}</StatusBadge>
      {accessExpiresAt && <span className="guest-access-until"><Clock3 size={14} /> {formatDateLabel(accessExpiresAt, true, false)}까지</span>}
      <div className="notification-wrap guest-notification-wrap" ref={notificationWrapRef}>
        <IconButton tone="quiet" aria-label={`알림 ${unread}개`} aria-controls="notification-panel" aria-expanded={notificationsOpen} onClick={() => setNotificationsOpen((value) => !value)}><Bell size={18} />{unread > 0 && <em className="guest-unread">{unread}</em>}</IconButton>
        {notificationsOpen && notificationFeed && <NotificationCenter workspaceScope={workspaceScope} feed={notificationFeed} onReload={onReloadNotifications} onNavigate={openFromNotification} onToast={onToast} onClose={() => setNotificationsOpen(false)} />}
      </div>
      <IconButton tone="quiet" aria-label="내 설정" onClick={onOpenSettings}><Settings2 size={18} /></IconButton>
      <Button tone="ghost" size="sm" type="button" onClick={onLogout}><LogIn size={16} /> 로그아웃</Button>
    </div>
  </header>

  if (scopeState === 'ended') {
    return <div className="guest-shell">
      {header}
      <main className="guest-main"><div className="empty-state"><ShieldCheck size={30} /><h2>초대 기간이 끝났거나 접근이 해지되었습니다</h2><p>다시 참여해야 한다면 초대한 회사에 문의해 주세요.</p><Button tone="ghost" type="button" onClick={onLogout}>로그아웃</Button></div></main>
    </div>
  }
  if (scopeState === 'error') {
    return <div className="guest-shell">
      {header}
      <main className="guest-main"><div className="empty-state"><FolderKanban size={30} /><h2>초대 범위를 불러오지 못했습니다</h2><p>네트워크를 확인한 뒤 새로고침해 주세요.</p></div></main>
    </div>
  }

  return <IndustryProvider industryType={account.industryType}>
    <div className="guest-shell">
      <a className="skip-link" href="#guest-main">본문으로 바로가기</a>
      {header}
      <main id="guest-main" className="guest-main" tabIndex={-1}>
        {scopeState === 'loading'
          ? <div className="empty-state compact"><FolderKanban size={26} /><h3>초대된 프로젝트를 불러오는 중</h3></div>
          : projects.length === 0
            ? <div className="empty-state"><FolderKanban size={30} /><h2>아직 지정된 프로젝트가 없습니다</h2><p>{me?.scope.invitedByName ? `${me.scope.invitedByName}님이` : '초대한 회사가'} 프로젝트를 지정하면 업무·채널·자료·게시판이 여기에 열립니다.</p></div>
            : <section className="guest-panel" aria-label="게스트 작업 공간">
              <div className="segmented-tabs guest-tabs" role="tablist" aria-label="게스트 작업 공간 탭">
                {TABS.map((entry) => {
                  const Icon = entry.icon
                  return <button type="button" role="tab" key={entry.id} aria-selected={tab === entry.id} onClick={() => setTab(entry.id)}><Icon size={16} /> {entry.label}{entry.id === 'tasks' && openWorkCount > 0 && <em>{openWorkCount}</em>}</button>
                })}
              </div>

              {tab === 'tasks' && <div className="guest-tab-body" role="tabpanel" aria-label="내 업무">
                {workState === 'loading' && <div className="empty-state compact"><ListChecks size={26} /><h3>업무를 불러오는 중</h3></div>}
                {workState === 'error' && <div className="empty-state compact"><ListChecks size={26} /><h3>업무를 불러오지 못했습니다</h3><Button tone="ghost" type="button" onClick={() => void loadWorkItems()}>다시 시도</Button></div>}
                {workState === 'ready' && scopedWork.length === 0 && <div className="empty-state compact"><CheckCircle2 size={26} /><h3>배정된 업무가 없습니다</h3><p>{tenantName}가 업무를 지시하면 여기에 나타납니다.</p></div>}
                {workState === 'ready' && scopedWork.length > 0 && <ul className="guest-task-list" aria-label="배정된 업무">
                  {scopedWork.map((item) => {
                    const action = taskAction(item)
                    const open = openTaskId === item.id
                    const children = childrenOf(workItems, item.id)
                    // 자식을 열면 상위 목록도 함께 펼쳐진 채로 둔다 — 열자마자 접히면 어디에도 갈 수 없다.
                    const openChild = children.find((child) => child.id === openTaskId)
                    return <li key={item.id} className={`guest-task-row${open ? ' is-open' : ''}${item.status === '결재완료' ? ' is-done' : ''}`}>
                      <button type="button" className="guest-task-summary" aria-expanded={open} onClick={() => { setOpenTaskId(open ? null : item.id); if (!open) openChildList(item.id) }}>
                        <StatusBadge className="status-pill" dot tone={workStatusTone(item.status)}>{workStatusLabel(item.status)}</StatusBadge>
                        {/* 상위 업무의 제목은 게스트에게 주지 않는다 — 범위 밖 업무의 이름이 새면 안 된다. 있다는 사실만 밝힌다. */}
                        {/* 진행률(퍼센트)도 적지 않는다. 서버가 내 담당 행만 주므로 분모를 모른다 — 남의 자식이 섞이면 '100%' 옆에서 서버가 거절한다. 보이는 건수만 말한다. */}
                        <span className="guest-task-title"><strong>{item.title}</strong><small>{item.requestedBy} 요청{item.projectId && projectNameOf(item.projectId) ? ` · ${projectNameOf(item.projectId)}` : ''}{item.review?.decision === 'changes-requested' && item.status !== '결재완료' ? ' · 보완 요청' : ''}{children.length > 0 ? ` · ${subtaskCountLabel(children.length)}` : ''}</small>{isSubtask(item) && <ParentChip />}</span>
                        <time dateTime={item.due}>{item.status === '결재완료' ? '완료됨' : formatWorkDue(item.due)}</time>
                      </button>
                      <div className="guest-task-action">{action && <Button tone={open && action.primary ? 'primary' : 'secondary'} size="sm" type="button" disabled={busyTaskId === item.id} aria-disabled={action.blocked ? true : undefined} title={action.blocked} onClick={action.run}>{action.label} <ArrowRight size={15} /></Button>}</div>
                      {/* 펼침은 집합 하나가 정한다(위 openChildList). 자식을 닫는 것과 목록을 접는 것은 다른 일이라 summary는 언제나 접을 수 있다. */}
                      {children.length > 0 && <details className="guest-task-children" open={openChildLists.has(item.id)} onToggle={(event) => setOpenChildLists((current) => { const next = new Set(current); if (event.currentTarget.open) next.add(item.id); else next.delete(item.id); return next })}>
                        <summary><ChevronDown size={14} /> {subtaskCountLabel(children.length)}</summary>
                        <SubtaskRows items={children} onOpen={(child) => { setOpenTaskId(openTaskId === child.id ? null : child.id); openChildList(item.id) }} actionFor={(child) => { const childAction = taskAction(child); return childAction ? { label: childAction.label, blocked: childAction.blocked, stops: Boolean(childAction.blocked), run: childAction.run } : null }} busyId={busyTaskId} />
                        {/* 자식에게도 점검 항목·보완 사유·완료 이력이 있다. 상위와 같은 상세를 그 자리에서 연다. */}
                        {openChild && taskDetail(openChild)}
                      </details>}
                      {open && taskDetail(item)}
                    </li>
                  })}
                </ul>}
              </div>}

              {tab === 'channels' && <div className="guest-tab-body guest-channels" role="tabpanel" aria-label="프로젝트 채널">
                <MessengerDrawer embedded readOnlyRooms open rosterOverride={roster} currentUserId={account.id} currentUserName={account.name} currentUserTeam={orgName} canManage={false} workspaceScope={workspaceScope} onClose={() => undefined} onToast={onToast} />
              </div>}

              {tab === 'files' && <div className="guest-tab-body" role="tabpanel" aria-label="공유 자료">
                {documentsState === 'loading' && <div className="empty-state compact"><FileText size={26} /><h3>자료를 불러오는 중</h3></div>}
                {documentsState === 'error' && <div className="empty-state compact"><FileText size={26} /><h3>자료를 불러오지 못했습니다</h3><Button tone="ghost" type="button" onClick={() => void loadDocuments()}>다시 시도</Button></div>}
                {documentsState === 'ready' && documents.length === 0 && <div className="empty-state compact"><Paperclip size={26} /><h3>공유된 자료가 없습니다</h3><p>댓글이나 완료 보고에 첨부한 파일, 멤버가 공유한 자료가 여기에 모입니다.</p></div>}
                {documentsState === 'ready' && documents.length > 0 && <ul className="guest-file-list" aria-label="공유 자료">
                  {documents.map((document) => <li key={document.id} className="guest-file-row">
                    <span className="guest-file-icon"><FileText size={17} /></span>
                    <span className="guest-file-copy"><strong>{document.name}</strong><small>{humanSize(document.size)} · {document.uploadedByName ?? '업로더 미상'}{document.uploadedByRole === 'tenant-guest' ? ' (게스트)' : ''} · {formatDateTime(document.uploadedAt)}{projectNameOf(document.projectId) ? ` · ${projectNameOf(document.projectId)}` : ''}</small></span>
                    <Button tone="quiet" size="sm" type="button" onClick={() => void download(document)}><Download size={15} /> 내려받기</Button>
                  </li>)}
                </ul>}
              </div>}

              {tab === 'board' && <div className="guest-tab-body guest-board" role="tabpanel" aria-label="프로젝트 게시판">
                <ProjectSpacesPage guestMode focusProjectId={selectedProject?.id} workspaceScope={workspaceScope} currentUserId={account.id} currentUserName={account.name} canManage={false} onToast={onToast} />
              </div>}
            </section>}
      </main>
      {completionItem && <CompletionModal item={completionItem} workspaceScope={workspaceScope} onToast={onToast} onClose={() => setCompletionItem(null)} onSubmit={submitCompletion} />}
    </div>
  </IndustryProvider>
}

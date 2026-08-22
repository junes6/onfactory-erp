import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, FormEvent, ReactNode } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Building2,
  CheckCircle2,
  ChevronRight,
  Download,
  ExternalLink,
  FileClock,
  Filter,
  Headphones,
  Home,
  KeyRound,
  Layers3,
  LifeBuoy,
  LockKeyhole,
  MessageCircle,
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  UserCheck,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Tenant } from '../domainData'
import { formatDateTime } from '../utils/dateTime'
import { StatusBadge } from './StatusBadge'
import './PlatformConsole.css'

export type PlatformSection = 'platform' | 'tenants' | 'support' | 'integrations' | 'audit'

type PlatformConsoleProps = {
  section: PlatformSection
  focusId?: string
  refreshToken?: number
  onSectionChange: (section: PlatformSection) => void
  onReturnTenant: () => void
  onRequestSupport: (tenant: Tenant) => void
  onEnterTenant: (tenantId: string) => void
  onDataChanged?: () => void
  onToast: (message: string) => void
}

type TenantScope = 'all' | Tenant['id']
type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral'

type IntegrationState = {
  id: string
  tenantId: Tenant['id']
  name: string
  short: string
  kind: '판매채널' | '물류' | 'AI'
  status: '정상' | '주의' | '설정중'
  lastSync: string
  result: string
  successRate: string
}

type AuditEvent = {
  id: string
  tenantId: Tenant['id']
  at: string
  event: string
  scope: string
  actor: string
  result: '완료' | '검토필요'
  reference: string
}

type SupportTicket = {
  id: string
  tenantId: string
  tenant: string
  title: string
  priority: string
  status: string
  sla: string
  owner: string
  description?: string
  evidence?: { id: string; name: string; mime: string; size: number }
  history: { id: string; at: string; title: string; detail: string; actor: string }[]
  createdAt: string
  updatedAt: string
  source?: 'developer-support'
  conversationId?: string
  requesterId?: string
  requesterName?: string
  messageCount?: number
  attachmentCount?: number
  newRequest?: boolean
  unanswered?: boolean
  lastCustomerMessageAt?: string
  lastOperatorReplyAt?: string | null
}

type SupportAttachment = { id: string; name: string; size: string }

type SupportConversation = {
  id: string
  name: string
  systemChannel?: 'developer-support'
  supportTicketId?: string
  messages: Array<{
    id: string
    senderId: string
    senderName: string
    text: string
    time: string
    createdAt?: string
    readBy?: string[]
    attachments?: SupportAttachment[]
  }>
}

type PlatformTenant = Tenant & {
  adminEmail?: string
  targetDate?: string
  createdAt?: string
}

type OnboardingInput = {
  companyName: string
  industry: string
  plan: string
  adminName: string
  adminEmail: string
  targetDate: string
}

type PlatformAction = {
  id: string
  tenantId: string
  kind: '담당자 알림' | '재연결 요청' | '지원 세션 요청'
  target: string
  message: string
  createdAt: string
  actor: string
  reference?: string
}

type PlatformState = {
  tenants: PlatformTenant[]
  supportTickets: SupportTicket[]
  integrations: IntegrationState[]
  actions: PlatformAction[]
  auditEvents: AuditEvent[]
  newSupportRequestCount?: number
  unansweredSupportCount?: number
}

type PlatformContextValue = PlatformState & {
  loading: boolean
  error: string
  refresh: (silent?: boolean) => Promise<void>
  createTenant: (input: OnboardingInput) => Promise<{ tenant: PlatformTenant; onboarding: { temporaryPassword: string; expiresAt: string } }>
  createTicket: (input: { tenantId: string; title: string; priority: string; owner: string; description: string }, evidence?: File) => Promise<SupportTicket>
  updateTicket: (id: string, input: { status?: string; priority?: string; owner?: string }) => Promise<SupportTicket>
  createAction: (input: { tenantId: string; kind: PlatformAction['kind']; target: string; message: string; reference?: string }) => Promise<PlatformAction>
  downloadEvidence: (ticket: SupportTicket) => Promise<void>
  loadSupportConversation: (ticketId: string) => Promise<{ conversation: SupportConversation; ticket: SupportTicket }>
  replySupportConversation: (ticketId: string, text: string, attachments?: SupportAttachment[]) => Promise<{ conversation: SupportConversation; ticket: SupportTicket }>
  uploadSupportAttachments: (ticketId: string, files: File[]) => Promise<SupportAttachment[]>
  deleteSupportAttachment: (ticketId: string, attachmentId: string) => Promise<void>
  downloadSupportAttachment: (ticketId: string, attachment: SupportAttachment) => Promise<void>
}

const emptyPlatformState: PlatformState = { tenants: [], supportTickets: [], integrations: [], actions: [], auditEvents: [] }
const PlatformDataContext = createContext<PlatformContextValue | null>(null)

function usePlatformData() {
  const value = useContext(PlatformDataContext)
  if (!value) throw new Error('PlatformDataContext is unavailable')
  return value
}

async function platformJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  let body: (T & { error?: { message?: string } }) | null = null
  try { body = await response.json() as T & { error?: { message?: string } } } catch { /* handled by status below */ }
  if (!response.ok) throw new Error(body?.error?.message || '플랫폼 운영 서버 요청을 처리하지 못했습니다.')
  if (!body) throw new Error('플랫폼 운영 서버 응답 형식이 올바르지 않습니다.')
  return body
}

type PlatformDialogState =
  | { kind: 'onboarding' }
  | { kind: 'new-ticket' }
  | { kind: 'timeline'; ticket: SupportTicket }
  | { kind: 'audit-record'; event: AuditEvent }
  | { kind: 'owner-notice'; ticket: SupportTicket }
  | { kind: 'diagnostic'; item?: IntegrationState }
  | { kind: 'reconnect'; item: IntegrationState }


const sectionMeta: Record<PlatformSection, { label: string; title: string; description: string; icon: LucideIcon }> = {
  platform: { label: '운영 개요', title: '플랫폼 운영 현황', description: '서비스 이상과 고객 지원 우선순위만 확인합니다.', icon: Home },
  tenants: { label: '고객사', title: '고객사 관리', description: '계약·활성도·사용량을 고객사 단위로 관리합니다.', icon: Building2 },
  support: { label: 'CS 지원', title: 'CS 지원센터', description: 'SLA와 다음 행동을 기준으로 티켓을 처리합니다.', icon: Headphones },
  integrations: { label: '연동 상태', title: '연동 모니터링', description: '판매채널·물류·AI의 동기화 상태를 진단합니다.', icon: Layers3 },
  audit: { label: '지원 세션', title: '지원 세션 · 감사', description: '승인형 접근과 운영자 활동을 추적합니다.', icon: ShieldCheck },
}

function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return <StatusBadge className="pc-badge" tone={tone}>{children}</StatusBadge>
}

function Button({ children, onClick, primary = false, small = false, disabled = false, title }: { children: ReactNode; onClick: () => void; primary?: boolean; small?: boolean; disabled?: boolean; title?: string }) {
  return <button type="button" className={`pc-button${primary ? ' primary' : ''}${small ? ' small' : ''}`} onClick={onClick} disabled={disabled} title={title}>{children}</button>
}

function toneForService(value: string): Tone {
  if (['정상', '운영중', '완료', '해결', '종료'].includes(value)) return 'success'
  if (['주의', '설정중', '온보딩', '검토필요'].includes(value)) return 'warning'
  if (value === 'P1') return 'danger'
  if (value === 'P2') return 'warning'
  return 'neutral'
}

function tenantForTicket(ticket: SupportTicket, tenants: PlatformTenant[]) {
  return tenants.find((tenant) => tenant.id === ticket.tenantId)
    ?? tenants.find((tenant) => tenant.name === ticket.tenant)
}

function integrationSummaryForTenant(tenantId: Tenant['id'], integrationStates: IntegrationState[]) {
  const items = integrationStates.filter((item) => item.tenantId === tenantId)
  return `${items.filter((item) => item.status === '정상').length} / ${items.length}`
}

function ScopeBar({ scope, onScope }: { scope: TenantScope; onScope: (scope: TenantScope) => void }) {
  const { tenants } = usePlatformData()
  return (
    <div className="pc-context">
      <label className="pc-scope">
        <Filter size={16} aria-hidden="true" />
        <strong>데이터 범위</strong>
        <select className="pc-select" value={scope} onChange={(event) => onScope(event.target.value as TenantScope)}>
          <option value="all">전체 고객사</option>
          {tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}
        </select>
      </label>
      <div className="pc-privacy"><LockKeyhole size={15} aria-hidden="true" /> 서비스 메타데이터만 표시 · 고객사 업무 원문 비공개</div>
    </div>
  )
}

function Metric({ icon: Icon, label, value, note, warning = false }: { icon: LucideIcon; label: string; value: string; note?: string; warning?: boolean }) {
  return (
    <article className={`pc-metric${warning ? ' warning' : ''}`}>
      <span className="pc-metric-icon"><Icon size={17} aria-hidden="true" /></span>
      <div>
        <span className="pc-metric-label">{label}</span>
        <strong className="pc-metric-value">{value}{note && <span className="pc-metric-note">{note}</span>}</strong>
      </div>
    </article>
  )
}

function Panel({ title, subtitle, tools, children, footer }: { title: string; subtitle?: string; tools?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="pc-panel">
      <div className="pc-panel-head">
        <div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
        {tools && <div className="pc-panel-tools">{tools}</div>}
      </div>
      {children}
      {footer && <div className="pc-footnote">{footer}</div>}
    </section>
  )
}

function EmptyState({ label }: { label: string }) {
  return <div className="pc-empty"><Search size={22} aria-hidden="true" />{label}</div>
}

function PlatformDialog({
  dialog,
  scope,
  onClose,
  onScope,
  onSectionChange,
  onToast,
}: {
  dialog: PlatformDialogState
  scope: TenantScope
  onClose: () => void
  onScope: (scope: TenantScope) => void
  onSectionChange: PlatformConsoleProps['onSectionChange']
  onToast: PlatformConsoleProps['onToast']
}) {
  const { tenants, integrations, auditEvents, createTenant, createTicket, createAction, downloadEvidence } = usePlatformData()
  const dialogRef = useRef<HTMLElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [provisioned, setProvisioned] = useState<{ tenant: PlatformTenant; onboarding: { temporaryPassword: string; expiresAt: string } } | null>(null)

  useEffect(() => {
    const panel = dialogRef.current
    if (!panel) return
    const selector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    const focusable = () => Array.from(panel.querySelectorAll<HTMLElement>(selector))
    ;(panel.querySelector<HTMLElement>('[data-autofocus]') ?? focusable()[0] ?? panel).focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
      if (event.key !== 'Tab') return
      const items = focusable()
      if (!items.length) { event.preventDefault(); panel.focus(); return }
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [dialog, onClose])

  const submitOnboarding = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const companyName = String(form.get('companyName') ?? '').trim()
    const adminEmail = String(form.get('adminEmail') ?? '').trim()
    if (!companyName || !adminEmail) return
    setBusy(true); setError('')
    try {
      const result = await createTenant({ companyName, industry: String(form.get('industry') ?? '').trim(), plan: String(form.get('plan') ?? 'Growth'), adminName: String(form.get('adminName') ?? '').trim(), adminEmail, targetDate: String(form.get('targetDate') ?? '') })
      setProvisioned(result)
      onScope(result.tenant.id)
      onSectionChange('tenants')
      onToast(`${result.tenant.name} 테넌트와 최초 관리자 계정을 생성했습니다.`)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '고객사를 생성하지 못했습니다.') }
    finally { setBusy(false) }
  }

  const submitTicket = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const tenant = tenants.find((item) => item.id === String(form.get('tenantId') ?? ''))
    const title = String(form.get('title') ?? '').trim()
    const description = String(form.get('description') ?? '').trim()
    if (!tenant || !title || !description) return
    const evidence = form.get('evidence')
    setBusy(true); setError('')
    try {
      const ticket = await createTicket({ tenantId: tenant.id, title, priority: String(form.get('priority') ?? 'P3'), owner: String(form.get('owner') ?? '미배정'), description }, evidence instanceof File && evidence.size > 0 ? evidence : undefined)
      onScope(tenant.id); onSectionChange('support'); onClose()
      onToast(`${ticket.id}을 등록하고 SLA 추적을 시작했습니다.`)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'CS 티켓을 등록하지 못했습니다.') }
    finally { setBusy(false) }
  }

  const submitAction = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (dialog.kind !== 'owner-notice' && dialog.kind !== 'reconnect') return
    const form = new FormData(event.currentTarget)
    const message = String(form.get('message') ?? '').trim()
    if (!message) return
    const isNotice = dialog.kind === 'owner-notice'
    const target = isNotice ? `${dialog.ticket.owner} · ${dialog.ticket.id}` : `${tenants.find((tenant) => tenant.id === dialog.item.tenantId)?.name ?? dialog.item.tenantId} · ${dialog.item.name}`
    const tenantId = isNotice ? dialog.ticket.tenantId : dialog.item.tenantId
    setBusy(true); setError('')
    try {
      await createAction({ tenantId, kind: isNotice ? '담당자 알림' : '재연결 요청', target, message, reference: isNotice ? dialog.ticket.id : dialog.item.id })
      onClose()
      onToast(`${isNotice ? '담당자 알림' : '재연결 요청'}을 공유 운영 기록에 저장했습니다.`)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '운영 액션을 저장하지 못했습니다.') }
    finally { setBusy(false) }
  }

  const timeline = dialog.kind === 'timeline' ? dialog.ticket.history : []
  const auditRecords = dialog.kind === 'audit-record'
    ? auditEvents.filter((event) => event.tenantId === dialog.event.tenantId || event.reference === dialog.event.reference)
    : []

  const header = dialog.kind === 'onboarding'
    ? ['TENANT PROVISIONING', '고객사 온보딩', '격리된 테넌트와 최초 관리자 계정을 즉시 생성합니다.']
    : dialog.kind === 'new-ticket'
      ? ['SUPPORT TICKET', '새 CS 등록', '문제 상황과 증빙을 공유 지원센터에 등록합니다.']
      : dialog.kind === 'timeline'
        ? ['TICKET HISTORY', `${dialog.ticket.id} 처리 이력`, '상태 변화와 다음 행동을 시간순으로 확인합니다.']
        : dialog.kind === 'audit-record'
          ? ['AUDIT TRAIL', `${dialog.event.id} 전체 기록`, '같은 고객사와 참조 건의 감사 이벤트를 함께 확인합니다.']
          : dialog.kind === 'owner-notice'
            ? ['OPERATION ACTION', '담당자 알림 작성', '담당자 조치와 메시지를 감사 가능한 운영 기록으로 저장합니다.']
            : dialog.kind === 'reconnect'
              ? ['RECONNECT ACTION', '고객사 재연결 요청', '고객사 관리자에게 전달할 인증 안내와 조치를 기록합니다.']
              : ['DIAGNOSTIC SNAPSHOT', dialog.item ? `${dialog.item.name} 진단 상세` : '연동 상태 점검', '현재 화면의 메타데이터 스냅샷을 해석합니다.']

  return <div className="pc-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={dialogRef} className={`pc-modal${dialog.kind === 'audit-record' ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="pc-modal-title" tabIndex={-1}>
      <header className="pc-modal-head"><div><span className="pc-modal-kicker">{header[0]}</span><h2 id="pc-modal-title">{header[1]}</h2><p>{header[2]}</p></div><button type="button" className="pc-modal-close" aria-label="닫기" onClick={onClose}><X size={19} /></button></header>
      {dialog.kind === 'onboarding' && (provisioned ? <div className="pc-modal-body"><div className="pc-safe-note"><ShieldCheck size={18} /><span><strong>{provisioned.tenant.name}</strong> 테넌트와 관리자 계정이 생성되었습니다.</span></div><div className="pc-detail-grid"><DetailStat label="테넌트 ID" value={provisioned.tenant.id} /><DetailStat label="관리자 이메일" value={provisioned.tenant.adminEmail ?? '—'} /><DetailStat label="초기 비밀번호" value={<span className="pc-code">{provisioned.onboarding.temporaryPassword}</span>} /><DetailStat label="만료 시각" value={formatDateTime(provisioned.onboarding.expiresAt)} /></div><div className="pc-form-note"><AlertTriangle size={17} /><span>초기 비밀번호는 다시 표시되지 않습니다. 관리자에게 안전하게 전달하고 첫 로그인에서 새 비밀번호로 변경하게 하세요.</span></div><div className="pc-modal-actions"><Button primary onClick={onClose}>확인</Button></div></div> : <form className="pc-modal-body" onSubmit={submitOnboarding}>
        <div className="pc-form-grid"><label className="pc-field"><span>고객사명</span><input name="companyName" data-autofocus required minLength={2} maxLength={80} placeholder="예: 동해식품" /></label><label className="pc-field"><span>업종</span><input name="industry" required maxLength={120} placeholder="예: 수산가공 · 온라인 유통" /></label><label className="pc-field"><span>요금제</span><select name="plan"><option>Growth</option><option>Enterprise</option><option>Starter</option></select></label><label className="pc-field"><span>목표 오픈일</span><input name="targetDate" type="date" required /></label><label className="pc-field"><span>최초 관리자 이름</span><input name="adminName" required minLength={2} maxLength={40} placeholder="예: 홍길동" /></label><label className="pc-field"><span>최초 관리자 이메일</span><input name="adminEmail" type="email" required placeholder="admin@company.co.kr" /></label></div>
        <div className="pc-form-note"><ShieldCheck size={17} /><span>고객사별 격리 저장소와 승인된 최초 관리자 계정을 생성합니다. 초기 비밀번호는 72시간 후 만료됩니다.</span></div>
        {error && <div className="pc-form-note"><AlertTriangle size={17} /><span>{error}</span></div>}
        <div className="pc-modal-actions"><Button onClick={onClose} disabled={busy}>취소</Button><button type="submit" className="pc-button primary" disabled={busy}><Plus size={15} /> {busy ? '생성 중…' : '고객사 · 관리자 생성'}</button></div>
      </form>)}
      {dialog.kind === 'new-ticket' && <form className="pc-modal-body" onSubmit={submitTicket}>
        <div className="pc-form-grid"><label className="pc-field"><span>고객사</span><select name="tenantId" defaultValue={scope === 'all' ? tenants[0]?.id : scope} data-autofocus>{tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}</select></label><label className="pc-field"><span>우선순위</span><select name="priority"><option>P3</option><option>P2</option><option>P1</option></select></label><label className="pc-field full"><span>제목</span><input name="title" required minLength={4} placeholder="문의 또는 장애 현상을 요약하세요." /></label><label className="pc-field full"><span>상세 내용</span><textarea name="description" required placeholder="재현 절차, 발생 시각, 영향 범위를 입력하세요." /></label><label className="pc-field"><span>담당자</span><select name="owner"><option>이민지</option><option>박하늘</option><option>김도윤</option><option>미배정</option></select></label><label className="pc-field"><span>증빙 파일</span><input name="evidence" type="file" accept="image/*,.pdf,.txt,.csv" /></label></div>
        <div className="pc-form-note"><ShieldCheck size={17} /><span>증빙은 플랫폼 운영자 전용 저장소에 최대 10MB까지 보관되며 고객사 계정에서는 열람할 수 없습니다.</span></div>
        {error && <div className="pc-form-note"><AlertTriangle size={17} /><span>{error}</span></div>}
        <div className="pc-modal-actions"><Button onClick={onClose} disabled={busy}>취소</Button><button type="submit" className="pc-button primary" disabled={busy}><Plus size={15} /> {busy ? '등록 중…' : 'CS 등록'}</button></div>
      </form>}
      {dialog.kind === 'timeline' && <div className="pc-modal-body"><div className="pc-detail-grid"><DetailStat label="고객사" value={dialog.ticket.tenant} /><DetailStat label="현재 상태" value={dialog.ticket.status} /><DetailStat label="담당" value={dialog.ticket.owner} /><DetailStat label="SLA" value={dialog.ticket.sla} /></div>{dialog.ticket.evidence && <button type="button" className="pc-button" onClick={() => void downloadEvidence(dialog.ticket).catch((reason) => onToast(reason instanceof Error ? reason.message : 'CS 증빙을 다운로드하지 못했습니다.'))}><FileClock size={16} /> 증빙 다운로드 · {dialog.ticket.evidence.name}</button>}<div className="pc-timeline">{timeline.map((item) => <article key={item.id}><i /><div><strong>{item.at} · {item.title}</strong><span>{item.detail} · {item.actor}</span></div></article>)}</div><div className="pc-modal-actions"><Button primary onClick={onClose}>확인</Button></div></div>}
      {dialog.kind === 'audit-record' && <div className="pc-modal-body"><div className="pc-safe-note"><ShieldCheck size={16} /> 고객사 원문이나 인증 토큰 없이 운영 메타데이터만 표시합니다.</div><div className="pc-audit-records">{auditRecords.map((event) => <article key={event.id}><span className="pc-code">{event.at}</span><div><strong>{event.event}</strong><span>{event.actor} · {event.scope} · 참조 {event.reference}</span></div><Badge tone={toneForService(event.result)}>{event.result}</Badge></article>)}</div><div className="pc-modal-actions"><Button primary onClick={onClose}>닫기</Button></div></div>}
      {(dialog.kind === 'owner-notice' || dialog.kind === 'reconnect') && <form className="pc-modal-body" onSubmit={submitAction}><label className="pc-field"><span>전달 대상</span><input readOnly value={dialog.kind === 'owner-notice' ? `${dialog.ticket.owner} · ${dialog.ticket.id}` : `${tenants.find((tenant) => tenant.id === dialog.item.tenantId)?.name ?? ''} 관리자 · ${dialog.item.name}`} /></label><label className="pc-field"><span>전달 내용</span><textarea name="message" data-autofocus required defaultValue={dialog.kind === 'owner-notice' ? `${dialog.ticket.title} 건의 현재 상태(${dialog.ticket.status})를 확인하고 다음 조치를 기록해 주세요.` : `${dialog.item.name} 인증 상태(${dialog.item.status})를 확인하고 판매자센터에서 권한을 다시 승인해 주세요.`} /></label><div className="pc-form-note"><ShieldCheck size={17} /><span>운영자 신원·대상·내용·참조 건을 공유 저장소와 감사로그에 함께 기록합니다.</span></div>{error && <div className="pc-form-note"><AlertTriangle size={17} /><span>{error}</span></div>}<div className="pc-modal-actions"><Button onClick={onClose} disabled={busy}>취소</Button><button type="submit" className="pc-button primary" disabled={busy}>{busy ? '저장 중…' : '운영 액션 저장'}</button></div></form>}
      {dialog.kind === 'diagnostic' && <div className="pc-modal-body">{dialog.item ? <><div className="pc-detail-grid"><DetailStat label="상태" value={dialog.item.status} /><DetailStat label="최근 동기화" value={dialog.item.lastSync} /><DetailStat label="성공률" value={dialog.item.successRate} /><DetailStat label="화면 진단" value={dialog.item.result} /></div><div className="pc-form-note"><AlertTriangle size={17} /><span>현재 저장된 운영 메타데이터입니다. 외부 API의 최신 토큰 유효성 검사는 채널 커넥터에서 수행해야 합니다.</span></div></> : <><div className="pc-detail-grid"><DetailStat label="표시 연동" value={`${integrations.length}개`} /><DetailStat label="정상" value={`${integrations.filter((item) => item.status === '정상').length}개`} /><DetailStat label="점검 필요" value={`${integrations.filter((item) => item.status !== '정상').length}개`} /><DetailStat label="점검 시각" value={formatDateTime(new Date())} /></div></>}<div className="pc-modal-actions"><Button primary onClick={onClose}>확인</Button></div></div>}
    </section>
  </div>
}

function TenantIdentity({ tenant }: { tenant: Tenant }) {
  return (
    <div className="pc-cell-main">
      <span className="pc-logo">{tenant.name.replace(/\s+/g, '').slice(0, 2)}</span>
      <span className="pc-cell-copy"><strong>{tenant.name}</strong><span>{tenant.id}</span></span>
    </div>
  )
}

function industryLabel(tenant: Pick<Tenant, 'industryType' | 'industry'>) {
  if (tenant.industryType === 'it_services') return 'IT 서비스'
  if (tenant.industryType === 'food_manufacturing') return '식품제조'
  return tenant.industry
}

function formatBytes(bytes: number) {
  if (!bytes) return '0 MB'
  const mb = bytes / (1024 * 1024)
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return mb < 10 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`
}

function relativeActivity(at: string | null) {
  if (!at) return '아직 데이터 없음'
  const diff = Date.now() - Date.parse(at)
  if (!Number.isFinite(diff)) return '아직 데이터 없음'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return '방금 전'
  if (minutes < 60) return `${minutes}분 전`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}시간 전`
  return `${Math.floor(hours / 24)}일 전`
}

/** 이상 신호: 미처리 티켓(빨강) > 24시간 무활동(주황) > 활동 없음(회색) > 정상(초록) */
function tenantSignal(tenant: Tenant): { tone: Tone; label: string } {
  const metrics = tenant.metrics
  if (metrics.openTickets > 0) return { tone: 'danger', label: `미처리 티켓 ${metrics.openTickets}건` }
  if (!metrics.lastActivityAt) return { tone: 'neutral', label: '아직 활동 데이터 없음' }
  if (Date.now() - Date.parse(metrics.lastActivityAt) > 24 * 60 * 60 * 1_000) return { tone: 'warning', label: '24시간 무활동' }
  return { tone: 'success', label: '정상 활동 중' }
}

function pointsLabel(points: number | null) {
  return points === null ? '아직 데이터 없음' : `${Math.round(points).toLocaleString('ko-KR')} P`
}

function DetailStat({ label, value }: { label: string; value: ReactNode }) {
  return <div className="pc-detail-stat"><span>{label}</span><strong>{value}</strong></div>
}

function TenantCard({ tenant, selected, onSelect, onEnter }: { tenant: Tenant; selected: boolean; onSelect: () => void; onEnter: () => void }) {
  const signal = tenantSignal(tenant)
  const metrics = tenant.metrics
  return (
    <article className={`pc-tenant-card${selected ? ' selected' : ''}`}>
      <button type="button" className="pc-tenant-card-main" aria-pressed={selected} onClick={onSelect}>
        <div className="pc-tenant-card-head">
          <span className="pc-logo">{tenant.name.replace(/\s+/g, '').slice(0, 2)}</span>
          <div className="pc-tenant-card-title"><strong>{tenant.name}</strong><span><Badge tone="info">{industryLabel(tenant)}</Badge><Badge tone={toneForService(tenant.contract)}>{tenant.contract}</Badge></span></div>
          <i className={`pc-signal-dot ${signal.tone}`} role="img" aria-label={signal.label} title={signal.label} />
        </div>
        <dl className="pc-tenant-metrics">
          <div><dt>멤버</dt><dd>{metrics.members}명</dd></div>
          <div><dt>오늘 활동</dt><dd>{metrics.todayActivity}건</dd></div>
          <div><dt>미처리 티켓</dt><dd className={metrics.openTickets ? 'is-warn' : ''}>{metrics.openTickets}건</dd></div>
          <div><dt>마지막 활동</dt><dd>{relativeActivity(metrics.lastActivityAt)}</dd></div>
          <div><dt>이번 달 포인트</dt><dd>{pointsLabel(metrics.pointsUsed)}</dd></div>
        </dl>
      </button>
      <div className="pc-tenant-card-actions"><span className={`pc-signal-text ${signal.tone}`}>{signal.label}</span><Button primary small onClick={onEnter}><ArrowRight size={14} /> 접속</Button></div>
    </article>
  )
}

function TenantBoard({ tenants, selectedTenantId, onSelectTenant, onEnterTenant }: { tenants: Tenant[]; selectedTenantId?: string; onSelectTenant: (id: string) => void; onEnterTenant: (id: string) => void }) {
  if (!tenants.length) return <EmptyState label="아직 데이터 없음 — 등록된 고객사가 없습니다." />
  return (
    <div className="pc-tenant-board">
      {tenants.map((tenant) => <TenantCard key={tenant.id} tenant={tenant} selected={tenant.id === selectedTenantId} onSelect={() => onSelectTenant(tenant.id)} onEnter={() => onEnterTenant(tenant.id)} />)}
    </div>
  )
}

function TenantDetail({ tenant, onSectionChange, onRequestSupport, onScope, onEnterTenant }: { tenant?: Tenant; onSectionChange: PlatformConsoleProps['onSectionChange']; onRequestSupport: PlatformConsoleProps['onRequestSupport']; onScope: (scope: TenantScope) => void; onEnterTenant: PlatformConsoleProps['onEnterTenant'] }) {
  if (!tenant) return <aside className="pc-detail"><EmptyState label="고객사를 선택해 주세요." /></aside>
  const signal = tenantSignal(tenant)
  return (
    <aside className="pc-detail" aria-label={`${tenant.name} 상세`}>
      <div className="pc-detail-head">
        <div className="pc-detail-eyebrow"><span>{tenant.id}</span><Badge tone={signal.tone}>{signal.label}</Badge></div>
        <h2>{tenant.name}</h2>
        <p>{industryLabel(tenant)} · {tenant.industry}</p>
      </div>
      <div className="pc-detail-body">
        <div>
          <div className="pc-detail-grid">
            <DetailStat label="계약" value={tenant.contract} />
            <DetailStat label="요금제" value={tenant.plan} />
            <DetailStat label="멤버" value={`${tenant.metrics.members}명`} />
            <DetailStat label="오늘 활동" value={`${tenant.metrics.todayActivity}건`} />
            <DetailStat label="미처리 티켓" value={`${tenant.metrics.openTickets}건`} />
            <DetailStat label="마지막 활동" value={relativeActivity(tenant.metrics.lastActivityAt)} />
          </div>
          <div className="pc-detail-section">
            <strong>사용량 (실시간 집계)</strong>
            <p>이번 달 포인트 {pointsLabel(tenant.metrics.pointsUsed)}<br />저장 용량 {formatBytes(tenant.metrics.storageBytes)}</p>
          </div>
        </div>
        <div className="pc-detail-actions">
          <Button onClick={() => { onScope(tenant.id); onSectionChange('support') }}><LifeBuoy size={15} /> 관련 CS 보기</Button>
          <Button onClick={() => onRequestSupport(tenant)}><LockKeyhole size={15} /> 지원 세션 요청</Button>
          <Button primary onClick={() => onEnterTenant(tenant.id)}><ArrowRight size={15} /> 워크스페이스 접속</Button>
        </div>
      </div>
    </aside>
  )
}

function Overview({ scope, scopedTenants, scopedTickets, scopedIntegrations, selectedTenantId, onSelectTenant, onScope, props }: SectionProps) {
  const { tenants } = usePlatformData()
  const selectedTenant = scopedTenants.find((tenant) => tenant.id === selectedTenantId) ?? scopedTenants[0]
  const exceptionTickets = scopedTickets.filter((ticket) => ticket.priority === 'P1' || ticket.status.includes('대기')).slice(0, 3)
  const exceptionIntegrations = scopedIntegrations.filter((item) => item.status !== '정상')
  return (
    <div className="pc-workspace">
      <div className="pc-overview-stack">
        <Panel title="사업체 보드" subtitle="실제 스토어 집계 · 30초마다 자동 갱신" footer={`${scopedTenants.length}개 고객사 · 범위: ${scope === 'all' ? '전체' : selectedTenant?.name ?? ''}`}>
          <TenantBoard tenants={scopedTenants} selectedTenantId={selectedTenant?.id} onSelectTenant={onSelectTenant} onEnterTenant={props.onEnterTenant} />
        </Panel>
        <Panel title="지금 확인할 항목" subtitle="장애·SLA·인증 문제만 표시" tools={<button type="button" className="pc-button ghost" onClick={() => props.onSectionChange('support')}>CS 전체 <ArrowRight size={14} /></button>}>
          <div className="pc-alert-list">
            {exceptionTickets.map((ticket) => (
              <div className="pc-alert" key={ticket.id}>
                <span className="pc-alert-icon"><AlertTriangle size={16} /></span>
                <div><strong>{ticket.title}</strong><span>{ticket.tenant} · {ticket.id}</span></div>
                <Badge tone={toneForService(ticket.priority)}>{ticket.priority} · {ticket.sla}</Badge>
              </div>
            ))}
            {exceptionIntegrations.map((item) => {
              const tenant = tenants.find((value) => value.id === item.tenantId)
              return <div className="pc-alert" key={item.id}><span className="pc-alert-icon"><KeyRound size={16} /></span><div><strong>{item.name} · {item.result}</strong><span>{tenant?.name} · 연동 메타데이터</span></div><Badge tone={toneForService(item.status)}>{item.status}</Badge></div>
            })}
            {exceptionTickets.length === 0 && exceptionIntegrations.length === 0 && <EmptyState label="현재 우선 확인할 항목이 없습니다." />}
          </div>
        </Panel>
      </div>
      <TenantDetail tenant={selectedTenant} onSectionChange={props.onSectionChange} onRequestSupport={props.onRequestSupport} onScope={onScope} onEnterTenant={props.onEnterTenant} />
    </div>
  )
}

type SectionProps = {
  scope: TenantScope
  scopedTenants: PlatformTenant[]
  scopedTickets: SupportTicket[]
  scopedIntegrations: IntegrationState[]
  selectedTenantId: Tenant['id']
  onSelectTenant: (id: Tenant['id']) => void
  onScope: (scope: TenantScope) => void
  onOpenDialog: (dialog: PlatformDialogState) => void
  props: PlatformConsoleProps
}

function TenantsView({ scope, scopedTenants, selectedTenantId, onSelectTenant, onScope, props }: SectionProps) {
  const [query, setQuery] = useState('')
  const normalized = query.trim().toLowerCase()
  const results = scopedTenants.filter((tenant) => !normalized || `${tenant.name} ${tenant.id} ${tenant.industry} ${industryLabel(tenant)} ${tenant.plan}`.toLowerCase().includes(normalized))
  const selectedTenant = results.find((tenant) => tenant.id === selectedTenantId) ?? results[0]
  return (
    <div className="pc-workspace">
      <Panel title="사업체 보드" subtitle="회사명·업종·핵심 지표 5개 — 카드를 누르면 상세, [접속]으로 워크스페이스 진입" tools={<div className="pc-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="회사명·업종·테넌트 ID 검색" aria-label="고객사 검색" /></div>} footer={`${results.length}개 결과 · ${scope === 'all' ? '전체 고객사' : '선택 고객사'}`}>
        <TenantBoard tenants={results} selectedTenantId={selectedTenant?.id} onSelectTenant={onSelectTenant} onEnterTenant={props.onEnterTenant} />
      </Panel>
      <TenantDetail tenant={selectedTenant} onSectionChange={props.onSectionChange} onRequestSupport={props.onRequestSupport} onScope={onScope} onEnterTenant={props.onEnterTenant} />
    </div>
  )
}

function TicketDetail({ ticket, props, onOpenDialog }: { ticket?: SupportTicket; props: PlatformConsoleProps; onOpenDialog: (dialog: PlatformDialogState) => void }) {
  const { tenants, updateTicket, downloadEvidence, loadSupportConversation, replySupportConversation, uploadSupportAttachments, deleteSupportAttachment, downloadSupportAttachment } = usePlatformData()
  const tenant = ticket ? tenantForTicket(ticket, tenants) : undefined
  const [statusDraft, setStatusDraft] = useState(ticket?.status ?? '접수')
  const [ownerDraft, setOwnerDraft] = useState(ticket?.owner ?? '미배정')
  const [saving, setSaving] = useState(false)
  const [supportConversation, setSupportConversation] = useState<SupportConversation | null>(null)
  const [conversationLoading, setConversationLoading] = useState(false)
  const [conversationError, setConversationError] = useState('')
  const [reply, setReply] = useState('')
  const [replySending, setReplySending] = useState(false)
  const [replyAttachmentUploading, setReplyAttachmentUploading] = useState(false)
  const [replyAttachmentsByTicket, setReplyAttachmentsByTicket] = useState<Record<string, SupportAttachment[]>>({})
  const replyAttachmentInputRef = useRef<HTMLInputElement>(null)
  const replyAttachments = ticket ? replyAttachmentsByTicket[ticket.id] ?? [] : []
  useEffect(() => { setStatusDraft(ticket?.status ?? '접수'); setOwnerDraft(ticket?.owner ?? '미배정') }, [ticket?.id, ticket?.owner, ticket?.status])
  useEffect(() => {
    if (!ticket || ticket.source !== 'developer-support') {
      setSupportConversation(null)
      setConversationError('')
      return
    }
    let active = true
    setConversationLoading(true)
    setConversationError('')
    void loadSupportConversation(ticket.id)
      .then((result) => { if (active) setSupportConversation(result.conversation) })
      .catch((reason) => { if (active) setConversationError(reason instanceof Error ? reason.message : '지원 대화를 불러오지 못했습니다.') })
      .finally(() => { if (active) setConversationLoading(false) })
    return () => { active = false }
  }, [loadSupportConversation, ticket?.id, ticket?.source, ticket?.updatedAt])
  if (!ticket) return <aside className="pc-detail"><EmptyState label="조건에 맞는 CS 티켓이 없습니다." /></aside>
  const saveAssignment = async () => {
    setSaving(true)
    try { await updateTicket(ticket.id, { status: statusDraft, owner: ownerDraft }); props.onToast(`${ticket.id} 상태와 담당자를 저장했습니다.`) }
    catch (reason) { props.onToast(reason instanceof Error ? reason.message : '티켓 상태를 저장하지 못했습니다.') }
    finally { setSaving(false) }
  }
  const sendSupportReply = async (event: FormEvent) => {
    event.preventDefault()
    const text = reply.trim()
    if (!text || replySending) return
    setReplySending(true)
    try {
      const result = await replySupportConversation(ticket.id, text, replyAttachments)
      setSupportConversation(result.conversation)
      setReply('')
      setReplyAttachmentsByTicket((current) => {
        const next = { ...current }
        delete next[ticket.id]
        return next
      })
      props.onToast(`${ticket.id} 고객사 메신저로 답변을 보냈습니다.`)
    } catch (reason) {
      props.onToast(reason instanceof Error ? reason.message : '고객사 메신저로 답변을 보내지 못했습니다.')
    } finally {
      setReplySending(false)
    }
  }
  const chooseReplyAttachments = async (files: File[]) => {
    if (!files.length || replyAttachmentUploading || replySending) return
    if (replyAttachments.length + files.length > 10) { props.onToast('한 답장에는 파일을 최대 10개까지 첨부할 수 있습니다.'); return }
    setReplyAttachmentUploading(true)
    try {
      const additions = await uploadSupportAttachments(ticket.id, files)
      setReplyAttachmentsByTicket((current) => ({ ...current, [ticket.id]: [...(current[ticket.id] ?? []), ...additions] }))
      props.onToast(`${additions.length}개 지원 파일을 업로드했습니다. 답장을 보내면 고객사 메신저에 연결됩니다.`)
    } catch (reason) {
      props.onToast(reason instanceof Error ? reason.message : '지원 첨부파일을 업로드하지 못했습니다.')
    } finally {
      setReplyAttachmentUploading(false)
    }
  }
  const removeReplyAttachment = async (attachment: SupportAttachment) => {
    if (replyAttachmentUploading || replySending) return
    setReplyAttachmentUploading(true)
    try {
      await deleteSupportAttachment(ticket.id, attachment.id)
      setReplyAttachmentsByTicket((current) => ({ ...current, [ticket.id]: (current[ticket.id] ?? []).filter((item) => item.id !== attachment.id) }))
    } catch (reason) {
      props.onToast(reason instanceof Error ? reason.message : '지원 첨부파일을 제거하지 못했습니다.')
    } finally {
      setReplyAttachmentUploading(false)
    }
  }
  return <aside className="pc-detail" aria-label={`${ticket.id} 상세`}>
    <div className="pc-detail-head"><div className="pc-detail-eyebrow"><span>{ticket.id}</span><div className="pc-actions">{ticket.newRequest && <Badge tone="danger">새 요청</Badge>}{ticket.unanswered && !ticket.newRequest && <Badge tone="warning">미답변</Badge>}<Badge tone={toneForService(ticket.priority)}>{ticket.priority}</Badge></div></div><h2>{ticket.title}</h2></div>
    <div className="pc-detail-body">
      <div>
        <div className="pc-detail-grid"><DetailStat label="고객사" value={ticket.tenant} /><DetailStat label="SLA" value={ticket.sla} /><DetailStat label="상태" value={ticket.status} /><DetailStat label={ticket.requesterName ? '요청자' : '담당'} value={ticket.requesterName || ticket.owner} /></div>
        <div className="pc-detail-section"><strong>접수 내용</strong><p>{ticket.description || '상세 내용이 없습니다.'}</p></div>
        {ticket.evidence && <button type="button" className="pc-button small" onClick={() => void downloadEvidence(ticket).catch((reason) => props.onToast(reason instanceof Error ? reason.message : 'CS 증빙을 다운로드하지 못했습니다.'))}><FileClock size={15} /> {ticket.evidence.name} 다운로드</button>}
        {ticket.source === 'developer-support' && (
          <section className="pc-support-thread" aria-label="고객사 개발 지원 대화">
            <div className="pc-support-thread-head"><div><MessageCircle size={16} /><strong>고객사 메신저</strong></div><span>{ticket.messageCount ?? supportConversation?.messages.length ?? 0}개 메시지</span></div>
            {conversationLoading && <div className="pc-support-thread-state">지원 대화를 불러오는 중입니다.</div>}
            {conversationError && <div className="pc-support-thread-state error">{conversationError}</div>}
            {!conversationLoading && !conversationError && supportConversation && (
              <div className="pc-support-messages">
                {supportConversation.messages.map((message) => {
                  const fromOperator = message.senderId === 'SYS-DEVELOPER-OPS'
                  return <article key={message.id} className={fromOperator ? 'operator' : 'customer'}>
                    <header><strong>{message.senderName}</strong><time>{message.createdAt ? formatDateTime(message.createdAt) : message.time}</time></header>
                    <p>{message.text}</p>
                    {message.attachments?.map((attachment) => <button type="button" key={attachment.id} onClick={() => void downloadSupportAttachment(ticket.id, attachment).catch((reason) => props.onToast(reason instanceof Error ? reason.message : '지원 첨부파일을 내려받지 못했습니다.'))}><Download size={14} /><span>{attachment.name}</span><small>{attachment.size}</small></button>)}
                  </article>
                })}
              </div>
            )}
            <form className="pc-support-reply" onSubmit={sendSupportReply}>
              <label><span>개발운영진 답장</span><textarea rows={3} value={reply} maxLength={4_000} onChange={(event) => setReply(event.target.value)} placeholder="고객사 메신저로 전송할 답변을 입력하세요." /></label>
              {replyAttachments.length > 0 && <div className="pc-support-pending-files">{replyAttachments.map((attachment) => <span key={attachment.id}><Paperclip size={13} /><span>{attachment.name} · {attachment.size}</span><button type="button" aria-label={`${attachment.name} 첨부 취소`} onClick={() => void removeReplyAttachment(attachment)} disabled={replyAttachmentUploading || replySending}><X size={13} /></button></span>)}</div>}
              <div className="pc-support-reply-actions">
                <input ref={replyAttachmentInputRef} className="pc-visually-hidden" type="file" multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt" onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void chooseReplyAttachments(files) }} />
                <button className="pc-button" type="button" disabled={replyAttachmentUploading || replySending || conversationLoading || Boolean(conversationError)} onClick={() => replyAttachmentInputRef.current?.click()}><Paperclip size={15} /> {replyAttachmentUploading ? '업로드 중…' : '파일 첨부'}</button>
                <button className="pc-button primary" type="submit" disabled={!reply.trim() || replySending || replyAttachmentUploading || conversationLoading || Boolean(conversationError)}><Send size={15} /> {replySending ? '전송 중…' : '메신저 답장'}</button>
              </div>
            </form>
          </section>
        )}
        <div className="pc-safe-note"><LockKeyhole size={16} /> 티켓만으로 고객사 화면에 접근할 수 없습니다. 별도 승인형 지원 세션이 필요합니다.</div>
      </div>
      <div className="pc-detail-actions">
        <label className="pc-field"><span>상태</span><select value={statusDraft} onChange={(event) => setStatusDraft(event.target.value)}><option>접수</option><option>기술팀 처리중</option><option>고객 회신 대기</option><option>수정본 검증중</option><option>해결</option><option>종료</option></select></label>
        <label className="pc-field"><span>담당자</span><select value={ownerDraft} onChange={(event) => setOwnerDraft(event.target.value)}><option>개발운영진</option><option>이민지</option><option>박하늘</option><option>김도윤</option><option>미배정</option></select></label>
        <Button primary disabled={saving || (statusDraft === ticket.status && ownerDraft === ticket.owner)} onClick={() => void saveAssignment()}><CheckCircle2 size={15} /> {saving ? '저장 중…' : '상태 저장'}</Button>
        <Button onClick={() => onOpenDialog({ kind: 'timeline', ticket })}><FileClock size={15} /> 처리 이력</Button>
        <Button onClick={() => onOpenDialog({ kind: 'owner-notice', ticket })}><UserCheck size={15} /> 담당자 알림</Button>
        <Button primary disabled={!tenant} onClick={() => tenant && props.onRequestSupport(tenant)}><LockKeyhole size={15} /> 지원 세션 요청</Button>
      </div>
    </div>
  </aside>
}

function SupportView({ scopedTickets, onOpenDialog, props }: SectionProps) {
  const [priority, setPriority] = useState<'all' | 'P1' | 'P2' | 'P3'>('all')
  const [selectedTicketId, setSelectedTicketId] = useState(scopedTickets[0]?.id ?? '')
  const tickets = scopedTickets
    .filter((ticket) => priority === 'all' || ticket.priority === priority)
    .sort((left, right) => Number(Boolean(right.unanswered)) - Number(Boolean(left.unanswered))
      || (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0))
  const selectedTicket = tickets.find((ticket) => ticket.id === selectedTicketId) ?? tickets[0]
  useEffect(() => {
    if (props.focusId && scopedTickets.some((ticket) => ticket.id === props.focusId)) {
      setPriority('all')
      setSelectedTicketId(props.focusId)
    }
  }, [props.focusId, scopedTickets])
  return <div className="pc-workspace">
    <Panel title="CS 티켓" subtitle="미답변 고객 요청을 먼저 보여주고, 그 안에서 최근 요청 순으로 정렬합니다." tools={<div className="pc-toolbar">{(['all', 'P1', 'P2', 'P3'] as const).map((value) => <button type="button" key={value} className={`pc-filter-button${priority === value ? ' active' : ''}`} onClick={() => setPriority(value)}>{value === 'all' ? '전체' : value}</button>)}</div>} footer={`${tickets.length}개 티켓 · 미답변 우선`}>
      {tickets.length ? <div className="pc-table-wrap"><table className="pc-table">
        <thead><tr><th>티켓</th><th>고객사</th><th>우선순위</th><th>상태</th><th>담당</th><th>SLA</th><th aria-label="상세" /></tr></thead>
        <tbody>{tickets.map((ticket) => <tr key={ticket.id} className={selectedTicket?.id === ticket.id ? 'selected' : undefined}>
          <td><span className="pc-cell-copy"><strong>{ticket.title}</strong><span>{ticket.id}{ticket.newRequest && <Badge tone="danger">새 요청</Badge>}{ticket.unanswered && !ticket.newRequest && <Badge tone="warning">미답변</Badge>}</span></span></td><td>{ticket.tenant}</td><td><Badge tone={toneForService(ticket.priority)}>{ticket.priority}</Badge></td><td><Badge tone={ticket.status.includes('대기') ? 'warning' : 'info'}>{ticket.status}</Badge></td><td>{ticket.owner}</td><td className="pc-code"><strong>{ticket.sla}</strong></td><td><button type="button" className="pc-row-button" aria-label={`${ticket.id} 상세 보기`} onClick={() => setSelectedTicketId(ticket.id)}><ChevronRight size={17} /></button></td>
        </tr>)}</tbody>
      </table></div> : <EmptyState label="선택한 조건의 티켓이 없습니다." />}
    </Panel>
    <TicketDetail ticket={selectedTicket} props={props} onOpenDialog={onOpenDialog} />
  </div>
}

function IntegrationDetail({ item, props, onScope, onOpenDialog }: { item?: IntegrationState; props: PlatformConsoleProps; onScope: (scope: TenantScope) => void; onOpenDialog: (dialog: PlatformDialogState) => void }) {
  const { tenants } = usePlatformData()
  const tenant = item ? tenants.find((value) => value.id === item.tenantId) : undefined
  if (!item || !tenant) return <aside className="pc-detail"><EmptyState label="연동을 선택해 주세요." /></aside>
  return <aside className="pc-detail" aria-label={`${item.name} 연동 상세`}>
    <div className="pc-detail-head"><div className="pc-detail-eyebrow"><span>{tenant.name}</span><Badge tone={toneForService(item.status)}>{item.status}</Badge></div><h2>{item.name}</h2></div>
    <div className="pc-detail-body">
      <div>
        <div className="pc-detail-grid"><DetailStat label="구분" value={item.kind} /><DetailStat label="최근 동기화" value={item.lastSync} /><DetailStat label="성공률" value={item.successRate} /><DetailStat label="진단" value={item.result} /></div>
        <div className="pc-detail-section"><strong>데이터 격리</strong><p>{item.kind === 'AI' ? '프롬프트와 답변 원문은 운영자에게 공개되지 않습니다.' : '인증 토큰과 주문 원문은 표시하지 않습니다.'}</p></div>
      </div>
      <div className="pc-detail-actions">
        <Button onClick={() => onOpenDialog({ kind: 'diagnostic', item })}><Activity size={15} /> 진단 상세</Button>
        {item.status !== '정상' && <Button primary onClick={() => onOpenDialog({ kind: 'reconnect', item })}><KeyRound size={15} /> 고객사 재연결 요청</Button>}
        <Button onClick={() => { onScope(tenant.id); props.onSectionChange('support') }}><LifeBuoy size={15} /> 관련 CS 보기</Button>
      </div>
    </div>
  </aside>
}

function IntegrationsView({ scopedIntegrations, onScope, onOpenDialog, props }: SectionProps) {
  const { tenants } = usePlatformData()
  const [status, setStatus] = useState<'all' | IntegrationState['status']>('all')
  const [selectedId, setSelectedId] = useState(scopedIntegrations[0]?.id ?? '')
  const items = scopedIntegrations.filter((item) => status === 'all' || item.status === status)
  const selected = items.find((item) => item.id === selectedId) ?? items[0]
  return <div className="pc-workspace">
    <Panel title="연동 목록" subtitle="토큰·주문 원문 없이 상태 메타데이터만 조회" tools={<div className="pc-toolbar">{(['all', '정상', '주의', '설정중'] as const).map((value) => <button type="button" key={value} className={`pc-filter-button${status === value ? ' active' : ''}`} onClick={() => setStatus(value)}>{value === 'all' ? '전체' : value}</button>)}</div>} footer={`${items.length}개 연동 · 최근 상태 진단 기준`}>
      {items.length ? <div className="pc-table-wrap"><table className="pc-table">
        <thead><tr><th>서비스</th><th>고객사</th><th>구분</th><th>상태</th><th>최근 동기화</th><th>성공률</th><th>진단</th><th aria-label="상세" /></tr></thead>
        <tbody>{items.map((item) => { const tenant = tenants.find((value) => value.id === item.tenantId); return <tr key={item.id} className={selected?.id === item.id ? 'selected' : undefined}>
          <td><div className="pc-cell-main"><span className="pc-logo channel">{item.short}</span><span className="pc-cell-copy"><strong>{item.name}</strong><span>{item.id}</span></span></div></td><td>{tenant?.name}</td><td>{item.kind}</td><td><Badge tone={toneForService(item.status)}>{item.status}</Badge></td><td className="pc-code">{item.lastSync}</td><td>{item.successRate}</td><td>{item.result}</td><td><button type="button" className="pc-row-button" aria-label={`${item.name} 상세 보기`} onClick={() => setSelectedId(item.id)}><ChevronRight size={17} /></button></td>
        </tr> })}</tbody>
      </table></div> : <EmptyState label="선택한 조건의 연동이 없습니다." />}
    </Panel>
    <IntegrationDetail item={selected} props={props} onScope={onScope} onOpenDialog={onOpenDialog} />
  </div>
}

function AuditDetail({ event, props, onOpenDialog }: { event?: AuditEvent; props: PlatformConsoleProps; onOpenDialog: (dialog: PlatformDialogState) => void }) {
  const { tenants } = usePlatformData()
  const tenant = event ? tenants.find((value) => value.id === event.tenantId) : undefined
  if (!event || !tenant) return <aside className="pc-detail"><EmptyState label="감사 이벤트를 선택해 주세요." /></aside>
  return <aside className="pc-detail" aria-label={`${event.id} 감사 상세`}>
    <div className="pc-detail-head"><div className="pc-detail-eyebrow"><span>{event.id}</span><Badge tone={toneForService(event.result)}>{event.result}</Badge></div><h2>{event.event}</h2></div>
    <div className="pc-detail-body">
      <div>
        <div className="pc-detail-grid"><DetailStat label="고객사" value={tenant.name} /><DetailStat label="시간" value={event.at} /><DetailStat label="운영자" value={event.actor} /><DetailStat label="참조" value={event.reference} /></div>
        <div className="pc-detail-section"><strong>허용 범위</strong><p>{event.scope}</p></div>
        <div className="pc-safe-note"><ShieldCheck size={16} /> 실제 운영자 신원으로 기록되며 고객사 사용자를 가장하지 않습니다.</div>
      </div>
      <div className="pc-detail-actions"><Button onClick={() => onOpenDialog({ kind: 'audit-record', event })}><ExternalLink size={15} /> 전체 기록</Button><Button primary onClick={() => props.onRequestSupport(tenant)}><LockKeyhole size={15} /> 새 지원 세션 요청</Button></div>
    </div>
  </aside>
}

function AuditView({ scope, scopedTenants, onOpenDialog, props }: SectionProps) {
  const { tenants, auditEvents } = usePlatformData()
  const events = auditEvents.filter((event) => scope === 'all' || event.tenantId === scope)
  const [selectedId, setSelectedId] = useState(auditEvents[0]?.id ?? '')
  const selected = events.find((event) => event.id === selectedId) ?? events[0]
  const scopedTenant = scope === 'all' ? undefined : scopedTenants[0]
  return <div className="pc-workspace">
    <Panel title="접근 감사로그" subtitle="조회·진단·지원 세션 활동을 실제 운영자 신원으로 기록" tools={<Button small primary={Boolean(scopedTenant)} disabled={!scopedTenant} title={!scopedTenant ? '상단에서 고객사를 선택해 주세요.' : undefined} onClick={() => scopedTenant ? props.onRequestSupport(scopedTenant) : props.onToast('지원 세션을 요청할 고객사를 먼저 선택해 주세요.')}><Plus size={15} /> 지원 세션 요청</Button>} footer="보존기간 365일 · 진행중 지원 세션 0건">
      {events.length ? <div className="pc-table-wrap"><table className="pc-table">
        <thead><tr><th>시간</th><th>이벤트</th><th>고객사</th><th>운영자</th><th>허용 범위</th><th>결과</th><th>참조</th><th aria-label="상세" /></tr></thead>
        <tbody>{events.map((event) => { const tenant = tenants.find((value) => value.id === event.tenantId); return <tr key={event.id} className={selected?.id === event.id ? 'selected' : undefined}>
          <td className="pc-code">{event.at}</td><td><span className="pc-cell-copy"><strong>{event.event}</strong><span>{event.id}</span></span></td><td>{tenant?.name}</td><td>{event.actor}</td><td>{event.scope}</td><td><Badge tone={toneForService(event.result)}>{event.result}</Badge></td><td className="pc-code">{event.reference}</td><td><button type="button" className="pc-row-button" aria-label={`${event.id} 상세 보기`} onClick={() => setSelectedId(event.id)}><ChevronRight size={17} /></button></td>
        </tr> })}</tbody>
      </table></div> : <EmptyState label="선택한 고객사의 감사 이벤트가 없습니다." />}
    </Panel>
    <AuditDetail event={selected} props={props} onOpenDialog={onOpenDialog} />
  </div>
}

export function PlatformConsole(props: PlatformConsoleProps) {
  const [scope, setScope] = useState<TenantScope>('all')
  const [selectedTenantId, setSelectedTenantId] = useState<Tenant['id']>('')
  const [dialog, setDialog] = useState<PlatformDialogState | null>(null)
  const [platformState, setPlatformState] = useState<PlatformState>(emptyPlatformState)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setLoadError('')
    try {
      const state = await platformJson<PlatformState>('/api/platform/state')
      setPlatformState(state)
      setSelectedTenantId((current) => state.tenants.some((tenant) => tenant.id === current) ? current : state.tenants[0]?.id ?? '')
    } catch (reason) { setLoadError(reason instanceof Error ? reason.message : '플랫폼 운영 데이터를 불러오지 못했습니다.') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void refresh() }, [props.refreshToken, refresh])
  // 사업체 보드는 30초마다 조용히 갱신한다 (로딩 표시 없이).
  useEffect(() => {
    const timer = window.setInterval(() => { void refresh(true) }, 30_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const createTenant = useCallback(async (input: OnboardingInput) => {
    const result = await platformJson<{ tenant: PlatformTenant; onboarding: { temporaryPassword: string; expiresAt: string } }>('/api/platform/tenants', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
    await refresh()
    props.onDataChanged?.()
    return result
  }, [props.onDataChanged, refresh])

  const createTicket = useCallback(async (input: { tenantId: string; title: string; priority: string; owner: string; description: string }, evidence?: File) => {
    const params = new URLSearchParams(input)
    let init: RequestInit
    if (evidence) {
      if (evidence.size > 10 * 1024 * 1024) throw new Error('CS 증빙은 10MB 이하만 업로드할 수 있습니다.')
      params.set('evidenceName', evidence.name)
      init = { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(evidence.name), 'x-file-type': evidence.type || 'application/octet-stream' }, body: evidence }
    } else {
      init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }
    }
    const result = await platformJson<{ ticket: SupportTicket }>(`/api/platform/tickets?${params}`, init)
    await refresh()
    props.onDataChanged?.()
    return result.ticket
  }, [props.onDataChanged, refresh])

  const updateTicket = useCallback(async (id: string, input: { status?: string; priority?: string; owner?: string }) => {
    const result = await platformJson<{ ticket: SupportTicket }>(`/api/platform/tickets/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
    await refresh()
    props.onDataChanged?.()
    return result.ticket
  }, [props.onDataChanged, refresh])

  const createAction = useCallback(async (input: { tenantId: string; kind: PlatformAction['kind']; target: string; message: string; reference?: string }) => {
    const result = await platformJson<{ action: PlatformAction }>('/api/platform/actions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
    await refresh()
    props.onDataChanged?.()
    return result.action
  }, [props.onDataChanged, refresh])

  const downloadEvidence = useCallback(async (ticket: SupportTicket) => {
    if (!ticket.evidence) return
    const response = await fetch(`/api/platform/tickets/${encodeURIComponent(ticket.id)}/evidence`)
    if (!response.ok) {
      let message = 'CS 증빙을 다운로드하지 못했습니다.'
      try { message = (await response.json() as { error?: { message?: string } }).error?.message || message } catch { /* keep generic message */ }
      throw new Error(message)
    }
    const url = URL.createObjectURL(await response.blob())
    const anchor = document.createElement('a')
    anchor.href = url; anchor.download = ticket.evidence.name; anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
  }, [])

  const loadSupportConversation = useCallback(async (ticketId: string) => {
    let result = await platformJson<{ conversation: SupportConversation; ticket: SupportTicket }>(`/api/platform/tickets/${encodeURIComponent(ticketId)}/conversation`)
    if (result.ticket.newRequest) {
      result = await platformJson<{ conversation: SupportConversation; ticket: SupportTicket }>(`/api/platform/tickets/${encodeURIComponent(ticketId)}/conversation/read`, { method: 'POST' })
      await refresh()
    }
    return result
  }, [refresh])

  const replySupportConversation = useCallback(async (ticketId: string, text: string, attachments: SupportAttachment[] = []) => {
    const result = await platformJson<{ conversation: SupportConversation; ticket: SupportTicket }>(`/api/platform/tickets/${encodeURIComponent(ticketId)}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, attachments }),
    })
    await refresh()
    props.onDataChanged?.()
    return result
  }, [props.onDataChanged, refresh])

  const deleteSupportAttachment = useCallback(async (ticketId: string, attachmentId: string) => {
    await platformJson<{ deleted: boolean }>(`/api/platform/tickets/${encodeURIComponent(ticketId)}/attachments/${encodeURIComponent(attachmentId)}`, { method: 'DELETE' })
  }, [])

  const uploadSupportAttachments = useCallback(async (ticketId: string, files: File[]) => {
    const uploaded: SupportAttachment[] = []
    try {
      for (const file of files) {
        if (!file.size) throw new Error(`${file.name}: 비어 있는 파일은 업로드할 수 없습니다.`)
        if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name}: 파일은 10MB 이하만 첨부할 수 있습니다.`)
        const result = await platformJson<{ attachment: SupportAttachment }>(`/api/platform/tickets/${encodeURIComponent(ticketId)}/attachments`, {
          method: 'POST',
          headers: {
            'content-type': 'application/octet-stream',
            'x-file-name': encodeURIComponent(file.name),
            'x-file-type': file.type || 'application/octet-stream',
          },
          body: file,
        })
        uploaded.push(result.attachment)
      }
      return uploaded
    } catch (reason) {
      const rollback = await Promise.allSettled(uploaded.map((attachment) => deleteSupportAttachment(ticketId, attachment.id)))
      const failedRollback = rollback.filter((result) => result.status === 'rejected').length
      const message = reason instanceof Error ? reason.message : '지원 첨부파일을 업로드하지 못했습니다.'
      throw new Error(failedRollback ? `${message} 업로드 롤백 중 ${failedRollback}개 파일을 정리하지 못했습니다.` : `${message} 이번에 선택한 파일은 모두 롤백했습니다.`)
    }
  }, [deleteSupportAttachment])

  const downloadSupportAttachment = useCallback(async (ticketId: string, attachment: SupportAttachment) => {
    const response = await fetch(`/api/platform/tickets/${encodeURIComponent(ticketId)}/attachments/${encodeURIComponent(attachment.id)}`)
    if (!response.ok) {
      let message = '지원 첨부파일을 다운로드하지 못했습니다.'
      try { message = (await response.json() as { error?: { message?: string } }).error?.message || message } catch { /* keep generic message */ }
      throw new Error(message)
    }
    const url = URL.createObjectURL(await response.blob())
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = attachment.name
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
  }, [])

  const { tenants, supportTickets, integrations, actions, auditEvents } = platformState
  const scopedTenants = useMemo(() => scope === 'all' ? tenants : tenants.filter((tenant) => tenant.id === scope), [scope, tenants])
  const scopedTickets = useMemo(() => supportTickets.filter((ticket) => scope === 'all' || ticket.tenantId === scope), [scope, supportTickets])
  const scopedIntegrations = useMemo(() => integrations.filter((item) => scope === 'all' || item.tenantId === scope), [integrations, scope])

  const activeTenantCount = scopedTenants.filter((tenant) => tenant.metrics.lastActivityAt && Date.now() - Date.parse(tenant.metrics.lastActivityAt) < 24 * 60 * 60 * 1_000).length
  const unresolvedTicketTotal = scopedTenants.reduce((sum, tenant) => sum + tenant.metrics.openTickets, 0)
  const healthyIntegrations = scopedIntegrations.filter((item) => item.status === '정상').length
  const openTickets = scopedTickets.filter((ticket) => !['해결', '종료'].includes(ticket.status))
  const p1Count = openTickets.filter((ticket) => ticket.priority === 'P1').length
  const newRequestCount = scopedTickets.filter((ticket) => ticket.newRequest).length
  const unansweredCount = scopedTickets.filter((ticket) => ticket.unanswered).length
  const meta = sectionMeta[props.section]
  const HeadIcon = meta.icon

  useEffect(() => {
    if (!props.focusId) return
    const focusedTenant = tenants.find((tenant) => tenant.id === props.focusId)
    const focusedTicket = supportTickets.find((ticket) => ticket.id === props.focusId)
    const tenant = focusedTenant ?? (focusedTicket ? tenantForTicket(focusedTicket, tenants) : undefined)
    if (tenant) {
      setScope(tenant.id)
      setSelectedTenantId(tenant.id)
    }
  }, [props.focusId, supportTickets, tenants])

  const changeScope = (next: TenantScope) => {
    setScope(next)
    if (next !== 'all') setSelectedTenantId(next)
  }

  const sectionProps: SectionProps = {
    scope,
    scopedTenants,
    scopedTickets,
    scopedIntegrations,
    selectedTenantId,
    onSelectTenant: setSelectedTenantId,
    onScope: changeScope,
    onOpenDialog: setDialog,
    props,
  }

  const contextValue = useMemo<PlatformContextValue>(() => ({
    ...platformState,
    loading,
    error: loadError,
    refresh,
    createTenant,
    createTicket,
    updateTicket,
    createAction,
    downloadEvidence,
    loadSupportConversation,
    replySupportConversation,
    uploadSupportAttachments,
    deleteSupportAttachment,
    downloadSupportAttachment,
  }), [createAction, createTenant, createTicket, deleteSupportAttachment, downloadEvidence, downloadSupportAttachment, loadError, loading, loadSupportConversation, platformState, refresh, replySupportConversation, updateTicket, uploadSupportAttachments])

  return (
    <PlatformDataContext.Provider value={contextValue}><div className="pc-root">
      <div className="pc-shell">
        <header className="pc-head">
          <div className="pc-head-copy">
            <div className="pc-eyebrow"><HeadIcon size={16} aria-hidden="true" /> ONFACTORY PLATFORM</div>
            <h1>{meta.title}</h1>
            <p>{meta.description}</p>
          </div>
          <div className="pc-actions">
            {props.section === 'tenants' && <Button onClick={() => setDialog({ kind: 'onboarding' })}><Plus size={15} /> 고객사 온보딩</Button>}
            {props.section === 'support' && <Button primary onClick={() => setDialog({ kind: 'new-ticket' })}><Plus size={15} /> 새 CS 등록</Button>}
            {props.section === 'integrations' && <Button onClick={() => setDialog({ kind: 'diagnostic' })}><RefreshCw size={15} /> 상태 점검</Button>}
            <Button onClick={props.onReturnTenant}><LockKeyhole size={15} /> 승인 후 고객사 접근</Button>
          </div>
        </header>

        <nav className="pc-section-nav" aria-label="플랫폼 운영 섹션">
          {(Object.keys(sectionMeta) as PlatformSection[]).map((id) => {
            const item = sectionMeta[id]
            const Icon = item.icon
            return <button key={id} type="button" className={`pc-section-tab${props.section === id ? ' active' : ''}`} aria-current={props.section === id ? 'page' : undefined} onClick={() => props.onSectionChange(id)}><Icon size={16} />{item.label}{id === 'support' && <Badge tone={newRequestCount || p1Count ? 'danger' : unansweredCount ? 'warning' : 'neutral'}>{newRequestCount ? `신규 ${newRequestCount}` : unansweredCount ? `미답변 ${unansweredCount}` : openTickets.length}</Badge>}</button>
          })}
        </nav>

        <section className="pc-summary" aria-label="선택 범위 핵심 지표">
          <Metric icon={Building2} label="관리 고객사" value={`${scopedTenants.length}곳`} note={scope === 'all' ? '전체' : '선택'} />
          <Metric icon={Activity} label="24시간 활동 고객사" value={`${activeTenantCount}/${scopedTenants.length}곳`} note={unresolvedTicketTotal ? `미처리 티켓 ${unresolvedTicketTotal}건` : '미처리 티켓 없음'} warning={unresolvedTicketTotal > 0 || activeTenantCount < scopedTenants.length} />
          <Metric icon={LifeBuoy} label="열린 CS" value={`${openTickets.length}건`} note={newRequestCount ? `새 요청 ${newRequestCount}` : unansweredCount ? `미답변 ${unansweredCount}` : p1Count ? `P1 ${p1Count}` : '대기 없음'} warning={newRequestCount > 0 || p1Count > 0} />
          <Metric icon={CheckCircle2} label="정상 연동" value={`${healthyIntegrations}/${scopedIntegrations.length}`} note={healthyIntegrations === scopedIntegrations.length ? '전체 정상' : '점검 필요'} warning={healthyIntegrations < scopedIntegrations.length} />
        </section>

        <ScopeBar scope={scope} onScope={changeScope} />

        {(loading || loadError || actions.length > 0) && <section className="pc-draft-status" aria-live="polite"><div><FileClock size={17} /><strong>{loading ? '플랫폼 운영 데이터 동기화 중' : loadError ? '플랫폼 운영 데이터 오류' : '공유 운영 기록'}</strong><span>{loading ? '고객사·CS·감사 이력을 불러오고 있습니다.' : loadError || `영속화된 운영 액션 ${actions.length}건 · 모든 운영자에게 공유됩니다.`}</span></div>{loadError ? <Button small onClick={() => void refresh()}>다시 시도</Button> : <Badge tone={loading ? 'neutral' : 'success'}>{loading ? '동기화' : '저장 완료'}</Badge>}</section>}

        {props.section === 'platform' && <Overview {...sectionProps} />}
        {props.section === 'tenants' && <TenantsView {...sectionProps} />}
        {props.section === 'support' && <SupportView {...sectionProps} />}
        {props.section === 'integrations' && <IntegrationsView {...sectionProps} />}
        {props.section === 'audit' && <AuditView {...sectionProps} />}
      </div>
      {dialog && <PlatformDialog dialog={dialog} scope={scope} onClose={() => setDialog(null)} onScope={changeScope} onSectionChange={props.onSectionChange} onToast={props.onToast} />}
    </div></PlatformDataContext.Provider>
  )
}

export default PlatformConsole

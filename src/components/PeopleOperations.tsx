import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  AlertTriangle, CalendarDays, Check, CheckCircle2, ChevronRight, Clock3,
  Copy, FileCheck2, History, KeyRound, Mail, Pencil, Plus, RefreshCw, Send, Settings2,
  ShieldCheck, Trash2, UserCheck, UserPlus, Users, X, XCircle,
} from 'lucide-react'
import { useWorkspaceState } from '../hooks/useWorkspaceState'
import { PerformanceReports } from './PerformanceReports'
import { AttendancePanel } from './AttendancePanel'
import { BarChart3 } from 'lucide-react'
import { formatDateLabel, formatDateTime, seoulDateInputValue } from '../utils/dateTime'
import './PeopleOperations.css'
import { Button, IconButton } from './ui/Button'
import { StatusBadge, type StatusBadgeTone } from './StatusBadge'
import { OversightPanel } from './OversightPanel'
import { BRAND } from '../brand'


type PeopleOperationsProps = {
  onToast: (message: string) => void
  canManage: boolean
  initialTab?: PeopleTab
  onOpenTask?: (taskId: string) => void
  currentUserId?: string
  currentUserName: string
  currentUserTeam: string
  workspaceScope?: string
  /** 업무 채널 감독 열람 권한. 관리자가 아니어도 지정받으면 켜진다. */
  canOversee?: boolean
}
type PeopleTab = 'members' | 'attendance' | 'leave' | 'leave-admin' | 'accounts' | 'performance' | 'oversight'
type LeaveStatus = '결재대기' | '승인' | '반려'
type AccountStatus = '승인대기' | '활성' | '반려'

type LeaveRequest = {
  id: string
  requesterId?: string
  name: string
  team: string
  type: string
  period: string
  startDate?: string
  endDate?: string
  days: number
  reason: string
  approverId?: string
  approverName?: string
  status: LeaveStatus
  decidedAt?: string
  decidedById?: string
  decidedByName?: string
  calendarVisibility?: 'pending' | 'company' | 'none'
}

type LeaveApprover = { id: string; name: string; team: string; role: string }

type AccountRequest = {
  id: string; name: string; email: string; team: string; role: string; requested: string; status: AccountStatus
  onboardingStatus?: '승인대기' | '초기설정대기' | '초기암호만료' | '설정완료'
  temporaryPasswordExpiresAt?: string | null
}

type IssuedCredential = { accountId: string; email: string; temporaryPassword: string; expiresAt: string }

type LeaveAccrualMode = 'monthly' | 'yearly' | 'manual'
type LeaveLedgerType = '발생' | '사용' | '부여' | '차감' | '리뉴얼'

type LeavePolicy = {
  mode: LeaveAccrualMode
  annualDays: number
  monthlyDays: number
  carryOverLimit: number
  renewalDate: string
}

type LeaveBalance = {
  accountId?: string
  name: string
  team: string
  total: number
  used: number
  updatedAt: string
}

type LeaveLedgerEntry = {
  id: string
  accountId?: string
  name: string
  team: string
  type: LeaveLedgerType
  days: number
  balanceAfter: number
  memo: string
  actor: string
  createdAt: string
}

type LeaveManagementState = {
  policy: LeavePolicy
  balances: LeaveBalance[]
  ledger: LeaveLedgerEntry[]
}

type MemberProfile = {
  accountId?: string
  name: string
  role: string
  team: string
  work: string
  attendance: string
  permission: string
  email?: string
}

type PeopleModal = 'leave' | 'invite' | 'adjust' | 'profile' | 'credential' | 'guest-invite' | 'guest-scope'

/** 외부 게스트 grant — GET /api/admin/guests 한 행. projects는 서버가 이름을 조인해 준 것이고, 없으면 projectIds로 그린다. */
type GuestStatus = 'invited' | 'active' | 'inactive' | 'revoked' | 'expired'
type GuestGrant = {
  id: string
  accountId: string
  email: string
  name: string
  orgName: string
  projectIds: string[]
  projects?: Array<{ id: string; name: string }>
  status: GuestStatus
  tokenExpiresAt?: string | null
  accessExpiresAt?: string | null
  invitedByName?: string
  lastActivityAt?: string | null
  commentCount?: number
  attachmentCount?: number
  resendCount?: number
  createdAt?: string
  acceptedAt?: string | null
}
/** 초대 결과. delivery가 'link-only'면 메일 어댑터가 없어 관리자가 링크를 직접 전달해야 한다. */
type GuestInvitation = { url: string; expiresAt: string; delivery: 'sent' | 'link-only' }
type GuestProjectOption = { id: string; name: string; status?: string }

const guestStatusLabel: Record<GuestStatus, string> = { invited: '초대 대기', active: '활성', inactive: '비활성', revoked: '해지', expired: '만료' }
const guestStatusTone: Record<GuestStatus, StatusBadgeTone> = { invited: 'warning', active: 'success', inactive: 'neutral', revoked: 'danger', expired: 'danger' }

const emptyLeaveManagement: LeaveManagementState = {
  policy: { mode: 'yearly', annualDays: 15, monthlyDays: 1, carryOverLimit: 5, renewalDate: '01-01' },
  balances: [],
  ledger: [],
}

function isLeaveManagementState(value: unknown): value is LeaveManagementState {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<LeaveManagementState>
  if (!state.policy || typeof state.policy !== 'object' || !['monthly', 'yearly', 'manual'].includes(state.policy.mode ?? '')) return false
  if (!Array.isArray(state.balances) || !Array.isArray(state.ledger)) return false
  return state.balances.every((balance) => balance && (balance.accountId === undefined || typeof balance.accountId === 'string') && typeof balance.name === 'string' && typeof balance.team === 'string'
    && typeof balance.total === 'number' && typeof balance.used === 'number' && typeof balance.updatedAt === 'string')
    && state.ledger.every((entry) => entry && typeof entry.id === 'string' && (entry.accountId === undefined || typeof entry.accountId === 'string') && typeof entry.name === 'string'
      && ['발생', '사용', '부여', '차감', '리뉴얼'].includes(entry.type ?? '') && typeof entry.days === 'number'
      && typeof entry.balanceAfter === 'number' && typeof entry.memo === 'string' && typeof entry.actor === 'string' && typeof entry.createdAt === 'string')
}

function isLeaveRequest(value: unknown): value is LeaveRequest {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<LeaveRequest>
  return typeof item.id === 'string' && typeof item.name === 'string' && typeof item.team === 'string'
    && (item.requesterId === undefined || typeof item.requesterId === 'string')
    && (item.startDate === undefined || typeof item.startDate === 'string')
    && (item.endDate === undefined || typeof item.endDate === 'string')
    && (item.approverId === undefined || typeof item.approverId === 'string')
    && (item.approverName === undefined || typeof item.approverName === 'string')
    && (item.decidedAt === undefined || typeof item.decidedAt === 'string')
    && (item.decidedById === undefined || typeof item.decidedById === 'string')
    && (item.decidedByName === undefined || typeof item.decidedByName === 'string')
    && (item.calendarVisibility === undefined || ['pending', 'company', 'none'].includes(item.calendarVisibility))
    && typeof item.type === 'string' && typeof item.period === 'string' && typeof item.days === 'number'
    && typeof item.reason === 'string' && ['결재대기', '승인', '반려'].includes(item.status ?? '')
}

const isLeaveRequestList = (value: unknown): value is LeaveRequest[] => Array.isArray(value) && value.every(isLeaveRequest)

function calculateLeaveDays(startDate: string, endDate: string, type: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || endDate < startDate) return 0
  if (type === '반차') return startDate === endDate ? .5 : 0
  const start = new Date(`${startDate}T00:00:00Z`)
  const end = new Date(`${endDate}T00:00:00Z`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0
  let days = 0
  for (const cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const weekday = cursor.getUTCDay()
    if (weekday !== 0 && weekday !== 6) days += 1
  }
  return days
}

function StateBadge({ children, tone = 'neutral' }: { children: string; tone?: string }) {
  return <span className={'people-state-badge ' + tone}><i />{children}</span>
}

export function PeopleOperationsPage({ onToast, canManage, currentUserId, currentUserName, currentUserTeam, workspaceScope, initialTab, onOpenTask, canOversee = false }: PeopleOperationsProps) {
  const [tab, setTab] = useState<PeopleTab>(initialTab && canManage ? initialTab : canManage ? 'members' : 'leave')
  useEffect(() => { if (initialTab && canManage) setTab(initialTab) }, [initialTab, canManage])
  const [leaves, setLeaves] = useWorkspaceState<LeaveRequest[]>('leave-requests', [], { scope: workspaceScope, seedWhenEmpty: false, validate: isLeaveRequestList })
  // '현재 업무'는 고정 문구가 아니라 실제 배정 업무에서 센다.
  const [assignedWork] = useWorkspaceState<Array<{ id: string; ownerId?: string; owner?: string; status?: string }>>('work-items', [], { scope: workspaceScope, seedWhenEmpty: false })
  const [leaveManagement, setLeaveManagement] = useWorkspaceState<LeaveManagementState>('leave-management', emptyLeaveManagement, { scope: workspaceScope, seedWhenEmpty: false, validate: isLeaveManagementState })
  const [managedAccounts, setManagedAccounts] = useState<AccountRequest[]>([])
  const [directoryMembers, setDirectoryMembers] = useState<LeaveApprover[]>([])
  const [isInviting, setIsInviting] = useState(false)
  const [credentialIssuingId, setCredentialIssuingId] = useState<string | null>(null)
  const [issuedCredential, setIssuedCredential] = useState<IssuedCredential | null>(null)
  const [isSubmittingLeave, setIsSubmittingLeave] = useState(false)
  const [leaveApprovers, setLeaveApprovers] = useState<LeaveApprover[]>([])
  const [leaveType, setLeaveType] = useState('연차')
  const [leaveStartDate, setLeaveStartDate] = useState(seoulDateInputValue)
  const [leaveEndDate, setLeaveEndDate] = useState(seoulDateInputValue)
  const [leaveApproverId, setLeaveApproverId] = useState('')
  const [editingLeaveId, setEditingLeaveId] = useState<string | null>(null)
  const [modal, setModal] = useState<PeopleModal | null>(null)
  const [selectedProfile, setSelectedProfile] = useState<MemberProfile | null>(null)
  const [operatorAccessLog, setOperatorAccessLog] = useState<Array<{ id: string; at: string; event: string; scope: string; actor: string; reference?: string }>>([])
  // 외부 게스트 — 목록·진행 중인 행·초대 결과 카드·범위 변경 대상. 프로젝트 목록은 모달을 열 때 한 번만 읽는다.
  const [guests, setGuests] = useState<GuestGrant[]>([])
  const [guestsState, setGuestsState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [guestBusyId, setGuestBusyId] = useState('')
  const [guestInviting, setGuestInviting] = useState(false)
  const [guestInvitation, setGuestInvitation] = useState<{ guest: GuestGrant; invitation: GuestInvitation } | null>(null)
  const [guestScopeTarget, setGuestScopeTarget] = useState<GuestGrant | null>(null)
  const [guestProjectOptions, setGuestProjectOptions] = useState<GuestProjectOption[] | null>(null)
  const [guestProjectPick, setGuestProjectPick] = useState<string[]>([])
  const modalRef = useRef<HTMLElement>(null)
  const modalTriggerRef = useRef<HTMLButtonElement | null>(null)

  const openModal = (nextModal: PeopleModal, trigger: HTMLButtonElement, profile?: MemberProfile, leave?: LeaveRequest) => {
    modalTriggerRef.current = trigger
    if (nextModal === 'profile') setSelectedProfile(profile ?? null)
    if (nextModal === 'leave') {
      const today = seoulDateInputValue()
      setEditingLeaveId(leave?.id ?? null)
      setLeaveType(leave?.type ?? '연차')
      setLeaveStartDate(leave?.startDate ?? (/^\d{4}-\d{2}-\d{2}$/.test(leave?.period ?? '') ? leave!.period : today))
      setLeaveEndDate(leave?.endDate ?? leave?.startDate ?? (/^\d{4}-\d{2}-\d{2}$/.test(leave?.period ?? '') ? leave!.period : today))
      setLeaveApproverId(leave?.approverId ?? leaveApprovers[0]?.id ?? '')
    }
    setModal(nextModal)
  }

  const closeModal = () => {
    setModal(null)
    setEditingLeaveId(null)
    setSelectedProfile(null)
    setIssuedCredential(null)
    setGuestInvitation(null)
    setGuestScopeTarget(null)
  }

  useEffect(() => {
    if (!modal) return
    const dialog = modalRef.current
    if (!dialog) return
    const selector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(selector)).filter((element) => !element.hasAttribute('hidden'))
    const initialFocus = dialog.querySelector<HTMLElement>('[data-autofocus]') ?? focusable()[0] ?? dialog
    initialFocus.focus()

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setModal(null)
        return
      }
      if (event.key !== 'Tab') return
      const elements = focusable()
      if (elements.length === 0) { event.preventDefault(); dialog.focus(); return }
      const first = elements[0]
      const last = elements[elements.length - 1]
      if (!dialog.contains(document.activeElement)) { event.preventDefault(); first.focus(); return }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }

    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('keydown', handleKey)
      const trigger = modalTriggerRef.current
      modalTriggerRef.current = null
      window.requestAnimationFrame(() => { if (trigger?.isConnected) trigger.focus() })
    }
  }, [modal])

  useEffect(() => {
    if (!canManage || tab !== 'accounts') return
    let active = true
    fetch('/api/operator-access-log')
      .then(async (response) => response.ok ? response.json() as Promise<{ events?: Array<{ id: string; at: string; event: string; scope: string; actor: string; reference?: string }> }> : { events: [] })
      .then((body) => { if (active) setOperatorAccessLog(Array.isArray(body.events) ? body.events : []) })
      .catch(() => { if (active) setOperatorAccessLog([]) })
    return () => { active = false }
  }, [canManage, tab])

  const loadGuests = async () => {
    setGuestsState((current) => current === 'ready' ? current : 'loading')
    try {
      const response = await fetch('/api/admin/guests', { headers: workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined })
      const body = await response.json() as { guests?: GuestGrant[]; error?: { message?: string } }
      if (!response.ok) throw new Error(body.error?.message || '게스트 목록을 불러오지 못했습니다.')
      setGuests(Array.isArray(body.guests) ? body.guests : [])
      setGuestsState('ready')
    } catch { setGuestsState('error') }
  }

  useEffect(() => {
    if (!canManage || tab !== 'accounts') return
    void loadGuests()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage, tab, workspaceScope])

  useEffect(() => {
    // 프로젝트 다중 선택지는 게스트 모달을 열 때만 필요하다. 인사 화면 진입마다 읽지 않는다.
    if ((modal !== 'guest-invite' && modal !== 'guest-scope') || guestProjectOptions !== null) return
    let active = true
    fetch('/api/projects', { headers: workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined })
      .then(async (response) => response.ok ? response.json() as Promise<{ projects?: GuestProjectOption[] }> : { projects: [] })
      .then((body) => { if (active) setGuestProjectOptions((body.projects ?? []).filter((project) => project.status !== 'archived').map((project) => ({ id: project.id, name: project.name }))) })
      .catch(() => { if (active) setGuestProjectOptions([]) })
    return () => { active = false }
  }, [modal, guestProjectOptions, workspaceScope])

  useEffect(() => {
    if (!canManage) {
      setTab('leave')
      setManagedAccounts([])
      return
    }
    let active = true
    fetch('/api/admin/accounts')
      .then(async (response) => {
        if (!response.ok) throw new Error('account-list')
        return response.json() as Promise<{ accounts: AccountRequest[] }>
      })
      .then(({ accounts: serverAccounts }) => { if (active && Array.isArray(serverAccounts)) setManagedAccounts(serverAccounts) })
      .catch(() => undefined)
    return () => { active = false }
  }, [canManage])

  useEffect(() => {
    let active = true
    fetch('/api/directory')
      .then(async (response) => {
        if (!response.ok) throw new Error('directory-list')
        return response.json() as Promise<{ members?: LeaveApprover[] }>
      })
      .then(({ members }) => { if (active) setDirectoryMembers(Array.isArray(members) ? members : []) })
      .catch(() => { if (active) setDirectoryMembers([]) })
    return () => { active = false }
  }, [workspaceScope])

  useEffect(() => {
    let active = true
    fetch('/api/leave-approvers')
      .then(async (response) => {
        const body = await response.json() as { approvers?: LeaveApprover[]; error?: { message?: string } }
        if (!response.ok || !Array.isArray(body.approvers)) throw new Error(body.error?.message || '결재자 목록을 불러오지 못했습니다.')
        if (active) {
          setLeaveApprovers(body.approvers)
          setLeaveApproverId((current) => body.approvers!.some((approver) => approver.id === current) ? current : body.approvers![0]?.id ?? '')
        }
      })
      .catch(() => {
        if (!active || !canManage || !currentUserId) return
        const fallback = { id: currentUserId, name: currentUserName, team: currentUserTeam, role: '운영 관리자' }
        setLeaveApprovers([fallback])
        setLeaveApproverId(fallback.id)
      })
    return () => { active = false }
  }, [canManage, currentUserId, currentUserName, currentUserTeam])

  const visibleLeaves = useMemo(
    () => canManage ? leaves : leaves.filter((item) => item.requesterId === currentUserId),
    [canManage, currentUserId, leaves],
  )
  const isOwnLeave = (request: LeaveRequest) => request.requesterId === currentUserId
  const pendingLeaves = useMemo(() => visibleLeaves.filter((item) => item.status === '결재대기').length, [visibleLeaves])
  const pendingAccounts = useMemo(() => managedAccounts.filter((item) => item.status === '승인대기').length, [managedAccounts])
  const myBalance = leaveManagement.balances.find((balance) => balance.accountId ? balance.accountId === currentUserId : balance.name === currentUserName)
    ?? { accountId: currentUserId, name: currentUserName, team: currentUserTeam, total: 0, used: 0, updatedAt: '미등록' }
  const myRemaining = Math.max(0, myBalance.total - myBalance.used)
  const myLedger = leaveManagement.ledger.filter((entry) => entry.name === '전 구성원' || (entry.accountId ? entry.accountId === currentUserId : entry.name === currentUserName))
  const todayKey = seoulDateInputValue()
  const leaveRangeOf = (leave: LeaveRequest): [string, string] => {
    const start = leave.startDate ?? (/^\d{4}-\d{2}-\d{2}/.test(leave.period) ? leave.period.slice(0, 10) : '')
    const end = leave.endDate ?? (leave.period.includes('~') ? leave.period.slice(-10).trim() : start)
    return [start, end || start]
  }
  /** 담당자에게 아직 안 끝난 업무가 몇 건인지. 업무 데이터가 아예 없으면 셌다고 말하지 않는다. */
  const openWorkLabel = (accountId: string | undefined, name: string) => {
    if (assignedWork.length === 0) return '아직 데이터 없음'
    const open = assignedWork.filter((item) => item?.status !== '결재완료'
      && (accountId && item?.ownerId ? item.ownerId === accountId : item?.owner === name))
    return open.length === 0 ? '배정된 업무 없음' : `진행 중 ${open.length}건`
  }
  const approvedLeaveToday = (accountId: string | undefined, name: string) => leaves.find((leave) => {
    if (leave.status !== '승인') return false
    if (accountId && leave.requesterId ? leave.requesterId !== accountId : leave.name !== name) return false
    const [start, end] = leaveRangeOf(leave)
    return Boolean(start) && start <= todayKey && todayKey <= end
  })
  const upcomingLeaves = useMemo(() => visibleLeaves
    .filter((leave) => {
      if (leave.status !== '승인') return false
      const [, end] = leaveRangeOf(leave)
      return end >= todayKey
    })
    .sort((left, right) => leaveRangeOf(left)[0].localeCompare(leaveRangeOf(right)[0]))
    .slice(0, 12), [visibleLeaves, todayKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const peopleRows = useMemo<MemberProfile[]>(() => {
    const members = directoryMembers.map((member) => ({
      accountId: member.id,
      name: member.name,
      email: managedAccounts.find((account) => account.id === member.id)?.email,
      role: member.role,
      team: member.team,
      work: openWorkLabel(member.id, member.name),
      attendance: approvedLeaveToday(member.id, member.name) ? '휴가중' : member.id === currentUserId ? '현재 로그인' : '근무 상태 미연동',
      permission: member.role,
    }))
    if (members.some((person) => person.accountId === currentUserId || person.name === currentUserName)) return members
    const current: MemberProfile = { accountId: currentUserId, name: currentUserName, role: canManage ? '운영 관리자' : '일반 사용자', team: currentUserTeam, work: openWorkLabel(currentUserId, currentUserName), attendance: approvedLeaveToday(currentUserId, currentUserName) ? '휴가중' : '현재 로그인', permission: canManage ? '관리 권한' : '일반 사용자' }
    return [current, ...members]
  }, [canManage, currentUserId, currentUserName, currentUserTeam, directoryMembers, managedAccounts, leaves]) // eslint-disable-line react-hooks/exhaustive-deps
  const selectedProfileAccountId = selectedProfile?.accountId
  const selectedProfileBalance = selectedProfile ? leaveManagement.balances.find((balance) => selectedProfileAccountId && balance.accountId ? balance.accountId === selectedProfileAccountId : balance.name === selectedProfile.name) : undefined
  const selectedProfileLeaves = selectedProfile ? leaves.filter((leave) => selectedProfileAccountId && leave.requesterId ? leave.requesterId === selectedProfileAccountId : leave.name === selectedProfile.name) : []

  const setPolicyMode = async (mode: LeaveAccrualMode) => {
    if (!canManage) return
    const result = await setLeaveManagement((current) => ({ ...current, policy: { ...current.policy, mode } }))
    if (!result.ok) { if (result.message) onToast(result.message); return }
    onToast(mode === 'monthly' ? '월별 발생 방식으로 변경했습니다.' : mode === 'yearly' ? '연초 일괄 발생 방식으로 변경했습니다.' : '수동 부여 방식으로 변경했습니다.')
  }

  const updatePolicyNumber = async (key: 'annualDays' | 'monthlyDays' | 'carryOverLimit', value: number) => {
    if (!canManage || !Number.isFinite(value) || value < 0) return
    const result = await setLeaveManagement((current) => ({ ...current, policy: { ...current.policy, [key]: value } }))
    if (!result.ok && result.message) onToast(result.message)
  }

  const updatePolicyDate = async (value: string) => {
    if (!canManage || !/^\d{2}-\d{2}$/.test(value)) { onToast('리뉴얼 기준일은 MM-DD 형식으로 입력해 주세요.'); return }
    const [month, day] = value.split('-').map(Number)
    const reference = new Date(Date.UTC(2024, month - 1, day))
    if (reference.getUTCMonth() !== month - 1 || reference.getUTCDate() !== day) { onToast('유효한 월과 일을 입력해 주세요.'); return }
    const result = await setLeaveManagement((current) => ({ ...current, policy: { ...current.policy, renewalDate: value } }))
    if (!result.ok) { if (result.message) onToast(result.message); return }
    onToast(`연차 리뉴얼 기준일을 ${value}로 변경했습니다.`)
  }

  const submitAdjustment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canManage) return
    const form = new FormData(event.currentTarget)
    const name = String(form.get('employee') || '').trim()
    const team = String(form.get('team') || '미지정').trim()
    const action = String(form.get('action')) === 'deduct' ? '차감' : '부여'
    const requestedDays = Math.max(0, Number(form.get('days') || 0))
    const memo = String(form.get('memo') || '').trim()
    if (!name || requestedDays <= 0 || !memo) { onToast('대상 직원, 일수와 조정 사유를 입력해 주세요.'); return }
    const matchingAccount = managedAccounts.find((account) => account.name === name)
    const matchingMember = directoryMembers.find((member) => member.name === name)
    const accountId = matchingAccount?.id ?? matchingMember?.id ?? (name === currentUserName ? currentUserId : undefined)
    const knownBalance = leaveManagement.balances.find((balance) => accountId && balance.accountId ? balance.accountId === accountId : balance.name === name)
    if (action === '차감' && (!knownBalance || knownBalance.total - knownBalance.used <= 0)) { onToast(`${name}님의 차감 가능한 휴가가 없습니다.`); return }

    const result = await setLeaveManagement((current) => {
      const existing = current.balances.find((balance) => accountId && balance.accountId ? balance.accountId === accountId : balance.name === name)
      const today = new Date().toISOString().slice(0, 10)
      const base = existing ?? { accountId, name, team, total: 0, used: 0, updatedAt: today }
      const signed = action === '부여' ? requestedDays : -Math.min(requestedDays, Math.max(0, base.total - base.used))
      const nextBalance = { ...base, team: team || base.team, total: Math.max(base.used, base.total + signed), updatedAt: today }
      const entry: LeaveLedgerEntry = {
        id: `LED-${Date.now()}`,
        accountId,
        name,
        team: nextBalance.team,
        type: action,
        days: signed,
        balanceAfter: Math.max(0, nextBalance.total - nextBalance.used),
        memo,
        actor: currentUserName,
        createdAt: new Date().toISOString(),
      }
      return {
        ...current,
        balances: existing ? current.balances.map((balance) => (accountId && balance.accountId ? balance.accountId === accountId : balance.name === name) ? nextBalance : balance) : [nextBalance, ...current.balances],
        ledger: [entry, ...current.ledger].slice(0, 500),
      }
    })
    if (!result.ok) { if (result.message) onToast(result.message); return }
    closeModal()
    setTab('leave-admin')
    onToast(`${name}님 휴가를 ${action === '부여' ? `${requestedDays}일 부여` : '차감'}했습니다.`)
  }

  const runAccrual = async () => {
    if (!canManage || leaveManagement.balances.length === 0) { onToast('휴가 원장에 등록된 직원이 없습니다. 먼저 휴가를 부여해 주세요.'); return }
    const mode = leaveManagement.policy.mode
    if (mode === 'manual') { onToast('수동 방식은 직원별 부여·차감 기능을 이용해 주세요.'); return }
    const today = new Date().toISOString().slice(0, 10)
    const periodKey = mode === 'monthly' ? today.slice(0, 7) : today.slice(0, 4)
    const ledgerType: LeaveLedgerType = mode === 'monthly' ? '발생' : '리뉴얼'
    if (leaveManagement.ledger.some((entry) => entry.type === ledgerType && entry.memo.startsWith(periodKey))) {
      onToast(mode === 'monthly' ? '이번 달 연차는 이미 발생 처리했습니다.' : '올해 연차는 이미 리뉴얼했습니다.')
      return
    }
    // 전 직원의 잔여 휴가를 한 번에 바꾸는 작업이다. "한 번 더 누르기"로는 무엇이 몇 명에게
    // 일어나는지 알 수 없고, 4초가 지나면 조용히 풀려 사람을 헷갈리게 한다. 내용을 적어 확인받는다.
    const affected = leaveManagement.balances.length
    if (affected === 0) { onToast('휴가 원장에 등록된 직원이 없습니다.'); return }
    const summary = mode === 'monthly'
      ? `직원 ${affected}명에게 이번 달 연차 ${leaveManagement.policy.monthlyDays}일을 각각 더합니다.`
      : `직원 ${affected}명의 연차를 ${leaveManagement.policy.annualDays}일로 다시 부여하고, 사용일수를 0으로 되돌립니다.\n이월은 최대 ${leaveManagement.policy.carryOverLimit}일까지만 남습니다.`
    if (!window.confirm(`${mode === 'monthly' ? '이번 달 연차를 발생시킬까요?' : '연차를 리뉴얼할까요?'}\n\n${summary}\n\n실행하면 되돌릴 수 없습니다.`)) return

    const result = await setLeaveManagement((current) => {
      const now = new Date().toISOString()
      const nextBalances = current.balances.map((balance) => {
        if (mode === 'monthly') return { ...balance, total: balance.total + current.policy.monthlyDays, updatedAt: today }
        const carry = Math.min(current.policy.carryOverLimit, Math.max(0, balance.total - balance.used))
        return { ...balance, total: current.policy.annualDays + carry, used: 0, updatedAt: today }
      })
      const entries = nextBalances.map((balance, index): LeaveLedgerEntry => ({
        id: `LED-${Date.now()}-${index}`,
        accountId: balance.accountId,
        name: balance.name,
        team: balance.team,
        type: mode === 'monthly' ? '발생' : '리뉴얼',
        days: mode === 'monthly' ? current.policy.monthlyDays : current.policy.annualDays,
        balanceAfter: Math.max(0, balance.total - balance.used),
        memo: mode === 'monthly' ? `${periodKey} 월별 연차 정기 발생` : `${periodKey}년 연차 일괄 리뉴얼`,
        actor: currentUserName,
        createdAt: now,
      }))
      return { ...current, balances: nextBalances, ledger: [...entries, ...current.ledger].slice(0, 500) }
    })
    if (!result.ok) { if (result.message) onToast(result.message); return }
    onToast(mode === 'monthly' ? '전 직원의 이번 달 연차를 발생시켰습니다.' : '전 직원의 연차를 리뉴얼했습니다.')
  }

  const decideLeave = async (id: string, status: LeaveStatus) => {
    if (!canManage) return
    const target = leaves.find((leave) => leave.id === id)
    if (status === '승인' && target && (target.type === '연차' || target.type === '반차')) {
      const balance = leaveManagement.balances.find((item) => item.accountId && target.requesterId ? item.accountId === target.requesterId : item.name === target.name)
      if (!balance || balance.total - balance.used < target.days) {
        onToast(`${target.name}님의 남은 휴가가 부족합니다. 휴가를 먼저 부여해 주세요.`)
        return
      }
    }
    try {
      const response = await fetch(`/api/leave-requests/${encodeURIComponent(id)}/decision`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: status === '승인' ? 'approve' : 'reject' }),
      })
      const result = await response.json() as { leave?: LeaveRequest; leaveManagement?: LeaveManagementState; version?: string; leaveManagementVersion?: string; error?: { message?: string } }
      if (!response.ok || !result.leave) throw new Error(result.error?.message || '휴가 결재 상태를 저장하지 못했습니다.')
      void setLeaves((current) => current.map((item) => item.id === id ? result.leave! : item), { persist: false, serverVersion: result.version })
      if (result.leaveManagement) void setLeaveManagement(result.leaveManagement, { persist: false, serverVersion: result.leaveManagementVersion })
    } catch (error) {
      onToast(error instanceof Error ? error.message : '휴가 결재 상태를 저장하지 못했습니다. 다시 시도해 주세요.')
      return
    }
    onToast(status === '승인' ? '휴가 신청을 승인하고 근무표에 반영했습니다.' : '휴가 신청을 반려했습니다.')
  }
  const cancelLeave = async (request: LeaveRequest) => {
    const isRequester = isOwnLeave(request)
    if (!isRequester || request.status !== '결재대기') {
      onToast('본인이 신청한 결재 대기 휴가만 취소할 수 있습니다.')
      return false
    }
    if (!window.confirm(`${request.type} ${request.period} 신청을 취소할까요?`)) return false
    try {
      const response = await fetch(`/api/leave-requests/${encodeURIComponent(request.id)}`, { method: 'DELETE' })
      const result = await response.json() as { deleted?: boolean; version?: string; error?: { message?: string } }
      if (!response.ok || !result.deleted) throw new Error(result.error?.message || '휴가 신청을 취소하지 못했습니다.')
      await setLeaves((current) => current.filter((item) => item.id !== request.id), { persist: false, serverVersion: result.version })
      onToast('휴가 신청을 취소했습니다.')
      return true
    } catch (error) {
      onToast(error instanceof Error ? error.message : '휴가 신청을 취소하지 못했습니다.')
      return false
    }
  }
  const decideAccount = async (id: string, status: AccountStatus, trigger?: HTMLButtonElement) => {
    if (!canManage) return
    if (trigger) modalTriggerRef.current = trigger
    try {
      const response = await fetch(`/api/admin/accounts/${encodeURIComponent(id)}/decision`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: status === '활성' ? 'approve' : 'reject' }),
      })
      const result = await response.json() as {
        account?: { status?: AccountStatus; onboardingStatus?: AccountRequest['onboardingStatus']; temporaryPasswordExpiresAt?: string | null }
        onboarding?: { temporaryPassword?: string; expiresAt?: string }
        error?: { message?: string }
      }
      if (!response.ok || !result.account) throw new Error(result.error?.message || '계정 승인 상태를 저장하지 못했습니다.')
      setManagedAccounts((current) => current.map((item) => item.id === id ? {
        ...item,
        status,
        onboardingStatus: result.account?.onboardingStatus,
        temporaryPasswordExpiresAt: result.account?.temporaryPasswordExpiresAt,
      } : item))
      const target = managedAccounts.find((item) => item.id === id)
      if (status === '활성' && target && result.onboarding?.temporaryPassword && result.onboarding.expiresAt) {
        setIssuedCredential({ accountId: id, email: target.email, temporaryPassword: result.onboarding.temporaryPassword, expiresAt: result.onboarding.expiresAt })
        setModal('credential')
      }
    } catch (error) {
      onToast(error instanceof Error ? error.message : '계정 승인 상태를 저장하지 못했습니다. 다시 시도해 주세요.')
      return
    }
    onToast(status === '활성' ? '계정을 승인했습니다. 1회용 초기 비밀번호를 직원에게 안전하게 전달해 주세요.' : '계정 신청을 반려했습니다.')
  }

  const reissueCredential = async (request: AccountRequest, trigger: HTMLButtonElement) => {
    if (!canManage || credentialIssuingId) return
    modalTriggerRef.current = trigger
    setCredentialIssuingId(request.id)
    try {
      const response = await fetch(`/api/admin/accounts/${encodeURIComponent(request.id)}/onboarding-credential`, { method: 'POST' })
      const result = await response.json() as {
        account?: { onboardingStatus?: AccountRequest['onboardingStatus']; temporaryPasswordExpiresAt?: string | null }
        onboarding?: { temporaryPassword?: string; expiresAt?: string }
        error?: { message?: string }
      }
      if (!response.ok || !result.onboarding?.temporaryPassword || !result.onboarding.expiresAt) throw new Error(result.error?.message || '초기 비밀번호를 발급하지 못했습니다.')
      setManagedAccounts((current) => current.map((item) => item.id === request.id ? { ...item, onboardingStatus: result.account?.onboardingStatus, temporaryPasswordExpiresAt: result.account?.temporaryPasswordExpiresAt } : item))
      setIssuedCredential({ accountId: request.id, email: request.email, temporaryPassword: result.onboarding.temporaryPassword, expiresAt: result.onboarding.expiresAt })
      setModal('credential')
      onToast('기존 로그인 세션을 종료하고 새 1회용 초기 비밀번호를 발급했습니다.')
    } catch (error) {
      onToast(error instanceof Error ? error.message : '초기 비밀번호를 발급하지 못했습니다.')
    } finally {
      setCredentialIssuingId(null)
    }
  }

  const submitLeave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (isSubmittingLeave) return
    const form = new FormData(event.currentTarget)
    const requestedDays = calculateLeaveDays(leaveStartDate, leaveEndDate, leaveType)
    const approverId = leaveApproverId
    if (requestedDays <= 0) {
      onToast(leaveEndDate < leaveStartDate ? '종료일은 시작일보다 빠를 수 없습니다.' : '신청 기간에 평일이 없습니다. 휴가 기간을 다시 선택해 주세요.')
      return
    }
    if (!approverId) { onToast('휴가 결재자를 선택해 주세요.'); return }
    setIsSubmittingLeave(true)
    try {
      const response = await fetch(editingLeaveId ? `/api/leave-requests/${encodeURIComponent(editingLeaveId)}` : '/api/leave-requests', {
        method: editingLeaveId ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: leaveType,
          startDate: leaveStartDate,
          endDate: leaveType === '반차' ? leaveStartDate : leaveEndDate,
          approverId,
          reason: String(form.get('reason')),
        }),
      })
      const result = await response.json() as { leave?: LeaveRequest; version?: string; error?: { message?: string } }
      if (!response.ok || !result.leave) throw new Error(result.error?.message || '휴가 신청을 저장하지 못했습니다.')
      void setLeaves((current) => editingLeaveId
        ? current.map((item) => item.id === result.leave!.id ? result.leave! : item)
        : [result.leave!, ...current.filter((item) => item.id !== result.leave!.id)], { persist: false, serverVersion: result.version })
    } catch (error) {
      onToast(error instanceof Error ? error.message : '휴가 신청을 저장하지 못했습니다. 다시 시도해 주세요.')
      return
    } finally {
      setIsSubmittingLeave(false)
    }
    closeModal()
    setTab('leave')
    onToast(editingLeaveId ? '휴가 신청 내용을 수정했습니다.' : '휴가 신청을 결재 요청했습니다.')
  }

  const submitInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canManage || isInviting) return
    const form = new FormData(event.currentTarget)
    const email = String(form.get('email'))
    setIsInviting(true)
    try {
      const response = await fetch('/api/admin/accounts/invite', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: String(form.get('name')), email, position: String(form.get('position')) }),
      })
      const result = await response.json() as {
        account?: AccountRequest
        error?: { message?: string }
      }
      if (!response.ok || !result.account) throw new Error(result.error?.message || '구성원 초대를 저장하지 못했습니다.')
      setManagedAccounts((current) => [result.account!, ...current.filter((item) => item.id !== result.account!.id)])
      closeModal()
      setTab('accounts')
      onToast(`${email} 계정을 등록했습니다. 관리자 승인 시 72시간 유효한 초기 비밀번호가 한 번만 표시됩니다.`)
    } catch (error) {
      onToast(error instanceof Error ? error.message : '구성원 초대를 저장하지 못했습니다. 다시 시도해 주세요.')
    } finally {
      setIsInviting(false)
    }
  }

  /** 게스트 라우트 호출 공통. 성공하면 목록을 다시 읽어 서버가 계산한 상태를 그대로 보여 준다. */
  const callGuestRoute = async <T,>(path: string, init: RequestInit, failure: string): Promise<T | null> => {
    try {
      const response = await fetch(`/api/admin/guests${path}`, {
        ...init,
        headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}) },
      })
      const body = await response.json().catch(() => null) as (T & { error?: { message?: string } }) | null
      if (!response.ok) { onToast(body?.error?.message ?? failure); return null }
      await loadGuests()
      return body
    } catch { onToast('서버에 연결하지 못했습니다.'); return null }
  }

  const openGuestInvite = (trigger: HTMLButtonElement) => {
    setGuestInvitation(null)
    setGuestProjectPick([])
    openModal('guest-invite', trigger)
  }
  const openGuestScope = (guest: GuestGrant, trigger: HTMLButtonElement) => {
    setGuestScopeTarget(guest)
    setGuestProjectPick(guest.projectIds ?? [])
    openModal('guest-scope', trigger)
  }
  const toggleGuestProject = (id: string) => setGuestProjectPick((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id])

  const submitGuestInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canManage || guestInviting) return
    if (guestProjectPick.length === 0) { onToast('게스트가 볼 프로젝트를 하나 이상 골라 주세요.'); return }
    const form = new FormData(event.currentTarget)
    const accessExpiresAt = String(form.get('accessExpiresAt') || '')
    setGuestInviting(true)
    const body = await callGuestRoute<{ guest?: GuestGrant; invitation?: GuestInvitation }>('', {
      method: 'POST',
      body: JSON.stringify({
        name: String(form.get('name') || '').trim(),
        email: String(form.get('email') || '').trim(),
        orgName: String(form.get('orgName') || '').trim(),
        projectIds: guestProjectPick,
        inviteExpiresInDays: Math.min(30, Math.max(1, Number(form.get('inviteExpiresInDays') || 7))),
        ...(accessExpiresAt ? { accessExpiresAt: new Date(`${accessExpiresAt}T23:59:59+09:00`).toISOString() } : {}),
      }),
    }, '게스트 초대를 저장하지 못했습니다.')
    setGuestInviting(false)
    if (!body?.guest || !body.invitation) return
    // 모달을 닫지 않는다 — 링크를 복사해 전달하는 일이 아직 남았다.
    setGuestInvitation({ guest: body.guest, invitation: body.invitation })
    onToast(body.invitation.delivery === 'sent' ? '초대 메일을 보냈습니다.' : '초대를 만들었습니다. 링크를 복사해 전달해 주세요.')
  }

  const resendGuestInvite = async (guest: GuestGrant, trigger: HTMLButtonElement) => {
    if (guestBusyId) return
    setGuestBusyId(guest.id)
    const body = await callGuestRoute<{ guest?: GuestGrant; invitation?: GuestInvitation }>(`/${encodeURIComponent(guest.id)}/resend`, { method: 'POST' }, '초대를 재발송하지 못했습니다.')
    setGuestBusyId('')
    if (!body?.invitation) return
    setGuestInvitation({ guest: body.guest ?? guest, invitation: body.invitation })
    setGuestProjectPick(guest.projectIds ?? [])
    openModal('guest-invite', trigger)
    onToast(body.invitation.delivery === 'sent' ? '초대 메일을 다시 보냈습니다. 이전 링크는 더 쓸 수 없습니다.' : '새 초대 링크를 만들었습니다. 이전 링크는 더 쓸 수 없습니다.')
  }

  const revokeGuestInvitation = async (guest: GuestGrant) => {
    if (guestBusyId || !window.confirm(`${guest.name}님에게 보낸 초대 링크를 회수할까요? 링크로 더 들어올 수 없게 됩니다.`)) return
    setGuestBusyId(guest.id)
    const body = await callGuestRoute<{ guest?: GuestGrant }>(`/${encodeURIComponent(guest.id)}/revoke-invitation`, { method: 'POST' }, '초대 링크를 회수하지 못했습니다.')
    setGuestBusyId('')
    if (body) onToast('초대 링크를 회수했습니다.')
  }

  const submitGuestScope = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!guestScopeTarget || guestBusyId) return
    if (guestProjectPick.length === 0) { onToast('프로젝트를 하나 이상 남겨 두어야 합니다. 전부 빼려면 해지를 사용하세요.'); return }
    const form = new FormData(event.currentTarget)
    const accessExpiresAt = String(form.get('accessExpiresAt') || '')
    setGuestBusyId(guestScopeTarget.id)
    const body = await callGuestRoute<{ guest?: GuestGrant }>(`/${encodeURIComponent(guestScopeTarget.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        projectIds: guestProjectPick,
        accessExpiresAt: accessExpiresAt ? new Date(`${accessExpiresAt}T23:59:59+09:00`).toISOString() : null,
        orgName: String(form.get('orgName') || '').trim(),
        name: String(form.get('name') || '').trim(),
      }),
    }, '게스트 범위를 저장하지 못했습니다.')
    setGuestBusyId('')
    if (!body) return
    closeModal()
    onToast('게스트 범위를 바꿨습니다. 빠진 프로젝트의 멤버·채널에서도 제외됩니다.')
  }

  const setGuestStatus = async (guest: GuestGrant, status: 'inactive' | 'active') => {
    if (guestBusyId) return
    if (status === 'inactive' && !window.confirm(`${guest.name}님의 접근을 비활성화할까요? 로그인 세션이 모두 끊기고, 재활성하기 전까지 들어올 수 없습니다.`)) return
    setGuestBusyId(guest.id)
    const body = await callGuestRoute<{ guest?: GuestGrant }>(`/${encodeURIComponent(guest.id)}/status`, { method: 'POST', body: JSON.stringify({ status }) }, '게스트 상태를 바꾸지 못했습니다.')
    setGuestBusyId('')
    if (body) onToast(status === 'inactive' ? '게스트를 비활성화했습니다.' : '게스트를 다시 활성화했습니다.')
  }

  const revokeGuest = async (guest: GuestGrant) => {
    if (guestBusyId || !window.confirm(`${guest.name}님(${guest.orgName})의 게스트 접근을 해지할까요?\n\n모든 프로젝트 멤버·채널에서 빠지고 다시 로그인할 수 없습니다. 댓글·첨부 기록은 감사 추적을 위해 남습니다. 되돌릴 수 없습니다.`)) return
    setGuestBusyId(guest.id)
    const body = await callGuestRoute<{ guest?: GuestGrant; ok?: boolean }>(`/${encodeURIComponent(guest.id)}`, { method: 'DELETE' }, '게스트를 해지하지 못했습니다.')
    setGuestBusyId('')
    if (body) onToast('게스트 접근을 해지했습니다.')
  }

  const copyInviteLink = (url: string) => {
    void navigator.clipboard.writeText(url)
      .then(() => onToast('초대 링크를 클립보드에 복사했습니다.'))
      .catch(() => onToast('자동 복사에 실패했습니다. 화면의 링크를 직접 복사해 주세요.'))
  }

  const guestProjectNames = (guest: GuestGrant) => guest.projects?.length
    ? guest.projects.map((project) => project.name)
    : (guest.projectIds ?? []).map((id) => guestProjectOptions?.find((project) => project.id === id)?.name ?? id)

  return <div className="content-page people-operations-page">
    <header className="page-header">
      <div><span className="eyebrow">PEOPLE & ACCESS</span><h1>{canManage ? '인사 · 조직' : '내 휴가 · 근태'}</h1><p>{canManage ? '구성원, 휴가, 계정 권한을 같은 승인 흐름으로 안전하게 관리합니다.' : `${currentUserTeam} 소속 내 휴가 신청과 결재 상태만 안전하게 확인합니다.`}</p></div>
      <div className="page-header-actions"><Button tone="ghost" type="button" onClick={(event) => openModal('leave', event.currentTarget)}><CalendarDays size={18} /> 휴가 신청</Button>{canManage && <Button tone="ghost" type="button" onClick={(event) => openModal('adjust', event.currentTarget)}><Plus size={18} /> 휴가 부여·차감</Button>}{canManage && <Button tone="primary" type="button" onClick={(event) => openModal('invite', event.currentTarget)}><UserPlus size={18} /> 구성원 초대</Button>}</div>
    </header>

    <section className="leave-balance-summary" aria-label={`${currentUserName} 휴가 잔여 현황`}>
      <article className="remaining"><span><CalendarDays size={22} /></span><div><small>내 남은 휴가</small><strong>{myRemaining.toFixed(1)}일</strong><p>{myBalance.updatedAt === '미등록' ? '관리자 부여 대기' : `${formatDateLabel(myBalance.updatedAt, true, false)} 기준`}</p></div></article>
      <article><span><CheckCircle2 size={22} /></span><div><small>올해 사용</small><strong>{myBalance.used.toFixed(1)}일</strong><p>승인 완료 기준</p></div></article>
      <article><span><History size={22} /></span><div><small>올해 총량</small><strong>{myBalance.total.toFixed(1)}일</strong><p>이월·관리자 부여 포함</p></div></article>
      <article className="policy"><span><Settings2 size={22} /></span><div><small>연차 발생 방식</small><strong>{leaveManagement.policy.mode === 'monthly' ? '월별 발생' : leaveManagement.policy.mode === 'yearly' ? '연초 일괄' : '수동 부여'}</strong><p>{leaveManagement.policy.mode === 'monthly' ? `매월 ${leaveManagement.policy.monthlyDays}일` : leaveManagement.policy.mode === 'yearly' ? `매년 ${leaveManagement.policy.annualDays}일` : '관리자 직접 조정'}</p></div></article>
    </section>

    <section className={`people-overview-strip${canManage ? '' : ' self-service'}`} aria-label="인사 요약">
      {canManage ? <>
        <div><span className="people-overview-icon green"><Users size={21} /></span><p><span>등록 구성원</span><strong>{peopleRows.length}명</strong><small>승인된 회사 계정</small></p></div>
        <button type="button" onClick={() => setTab('leave')}><span className="people-overview-icon amber"><CalendarDays size={21} /></span><p><span>휴가 결재</span><strong>{pendingLeaves}건</strong><small>확인하기 <ChevronRight size={14} /></small></p></button>
        <button type="button" onClick={() => setTab('accounts')}><span className="people-overview-icon blue"><UserCheck size={21} /></span><p><span>계정 승인</span><strong>{pendingAccounts}건</strong><small>확인하기 <ChevronRight size={14} /></small></p></button>
        <div><span className="people-overview-icon violet"><ShieldCheck size={21} /></span><p><span>계정 승인</span><strong>{pendingAccounts}명</strong><small>관리자 확인 대기</small></p></div>
      </> : <>
        <div><span className="people-overview-icon green"><CalendarDays size={21} /></span><p><span>내 휴가 신청</span><strong>{visibleLeaves.length}건</strong><small>전체 신청 내역</small></p></div>
        <button type="button" onClick={() => setTab('leave')}><span className="people-overview-icon amber"><Clock3 size={21} /></span><p><span>승인 대기</span><strong>{pendingLeaves}건</strong><small>결재 상태 확인 <ChevronRight size={14} /></small></p></button>
      </>}
    </section>

    <div className="people-tabs" role="tablist" aria-label="인사 관리 메뉴">
      {canManage && <button type="button" role="tab" aria-selected={tab === 'members'} onClick={() => setTab('members')}><Users size={18} /> 구성원</button>}
      <button type="button" role="tab" aria-selected={tab === 'attendance'} onClick={() => setTab('attendance')}><Clock3 size={18} /> 출퇴근 관리</button>
      <button type="button" role="tab" aria-selected={tab === 'leave'} onClick={() => setTab('leave')}><CalendarDays size={18} /> 휴가 {pendingLeaves > 0 && <em>{pendingLeaves}</em>}</button>
      {canManage && <button type="button" role="tab" aria-selected={tab === 'leave-admin'} onClick={() => setTab('leave-admin')}><Settings2 size={18} /> 휴가 정책 · 원장</button>}
      {canManage && <button type="button" role="tab" aria-selected={tab === 'accounts'} onClick={() => setTab('accounts')}><KeyRound size={18} /> 계정 · 권한 {pendingAccounts > 0 && <em>{pendingAccounts}</em>}</button>}
      {canOversee && <button type="button" role="tab" aria-selected={tab === 'oversight'} onClick={() => setTab('oversight')}><ShieldCheck size={18} /> 대화 열람</button>}
      <button type="button" role="tab" aria-selected={tab === 'performance'} onClick={() => setTab('performance')}><BarChart3 size={18} /> {canManage ? '직원 성과' : '내 성과'}</button>
    </div>

    {canManage && tab === 'members' && <section className="people-content-card" role="tabpanel">
      <header><div><h2>구성원 현황</h2><p>근무 상태와 현재 업무, 권한을 함께 확인합니다. 승인된 휴가는 자동으로 근무 상태에 반영됩니다.</p></div></header>
      <div className="people-directory-list">{peopleRows.length === 0 && <div className="people-empty-state"><Users size={22} /><strong>등록된 구성원 프로필이 없습니다.</strong><span>구성원 초대에서 실제 로그인 계정을 먼저 생성하세요.</span></div>}{peopleRows.map((person) => <article key={person.accountId ?? person.name}>
        <span className="person-avatar large">{person.name.slice(0, 1)}</span>
        <div className="people-directory-name"><strong>{person.name}</strong><span>{person.role} · {person.team}</span></div>
        <div><small>현재 업무</small><strong>{person.work}</strong></div>
        <div><small>접근 권한</small><strong>{person.permission}</strong></div>
        <StateBadge tone={person.attendance === '휴가중' ? 'warning' : person.attendance === '근무중' || person.attendance === '현재 로그인' ? 'good' : 'neutral'}>{person.attendance}</StateBadge>
        <Button tone="ghost" size="sm" type="button" onClick={(event) => openModal('profile', event.currentTarget, person)}>프로필</Button>
      </article>)}</div>
    </section>}

    {tab === 'attendance' && <section className="people-content-card" role="tabpanel"><AttendancePanel canManage={canManage} currentUserId={currentUserId} currentUserName={currentUserName} currentUserTeam={currentUserTeam} workspaceScope={workspaceScope} onToast={onToast} /></section>}

    {tab === 'leave' && <section className="people-content-card" role="tabpanel">
      <header><div><h2>{canManage ? '휴가 신청 · 결재' : '내 휴가 신청'}</h2><p>{canManage ? '승인되면 공유 일정과 근무 상태에 자동 반영됩니다.' : '내 신청 내역만 표시되며, 승인 상태가 변경되면 즉시 확인할 수 있습니다.'}</p></div><Button tone="primary" type="button" onClick={(event) => openModal('leave', event.currentTarget)}><Plus size={17} /> 휴가 신청</Button></header>
      {upcomingLeaves.length > 0 && <div className="leave-upcoming-strip" aria-label="오늘과 예정된 승인 휴가">
        <div className="leave-upcoming-head"><CalendarDays size={17} /><strong>{canManage ? '오늘·예정 휴가' : '내 예정 휴가'}</strong><span>{upcomingLeaves.length}건</span></div>
        <div className="leave-upcoming-list">{upcomingLeaves.map((leave) => {
          const [start, end] = leaveRangeOf(leave)
          const onLeaveNow = start <= todayKey && todayKey <= end
          return <article className={onLeaveNow ? 'is-active' : ''} key={leave.id}>
            <span className="person-avatar">{leave.name.slice(0, 1)}</span>
            <div><strong>{leave.name}</strong><small>{leave.type} · {leave.period} · {leave.days}일</small></div>
            <em>{onLeaveNow ? '휴가중' : `${Math.max(0, Math.ceil((new Date(`${start}T00:00:00Z`).getTime() - new Date(`${todayKey}T00:00:00Z`).getTime()) / 86_400_000))}일 후`}</em>
          </article>
        })}</div>
      </div>}
      <div className="approval-list">{visibleLeaves.length === 0 && <div className="people-empty-state"><CalendarDays size={22} /><strong>아직 휴가 신청 내역이 없습니다.</strong><span>휴가 신청 버튼을 눌러 첫 신청을 등록하세요.</span></div>}{visibleLeaves.map((request) => <article key={request.id}>
        <div className="approval-avatar">{request.name.slice(0, 1)}</div>
        <div className="approval-main"><div><strong>{request.name}</strong><span>{request.team} · {request.id}</span></div><h3>{request.type} · {request.period}</h3><p>{request.reason} · {request.days}일 · 결재자 {request.approverName ?? '소속 관리자'}{request.status === '승인' && request.calendarVisibility === 'company' ? ' · 전사 일정 공유' : ''}</p></div>
        <StateBadge tone={request.status === '승인' ? 'good' : request.status === '반려' ? 'danger' : 'warning'}>{request.status}</StateBadge>
        {request.status === '결재대기' && (canManage || isOwnLeave(request)) ? <div className="approval-actions">{isOwnLeave(request) && <><Button tone="ghost" size="sm" type="button" onClick={(event) => openModal('leave', event.currentTarget, undefined, request)}><Pencil size={16} /> 수정</Button><Button tone="danger" size="sm" type="button" onClick={() => void cancelLeave(request)}><Trash2 size={16} /> 신청 취소</Button></>}{canManage && <><Button tone="danger" size="sm" type="button" onClick={() => decideLeave(request.id, '반려')}><XCircle size={16} /> 반려</Button><Button tone="primary" size="sm" type="button" onClick={() => decideLeave(request.id, '승인')}><Check size={16} /> 승인</Button></>}</div> : <span className="approval-result"><FileCheck2 size={17} /> {request.status === '결재대기' ? '결재 진행 중' : '처리 완료'}</span>}
      </article>)}</div>
      {!canManage && <div className="my-leave-ledger"><div className="people-subsection-head"><div><h3>내 휴가 원장</h3><p>발생·사용·관리자 조정 이력을 확인합니다.</p></div></div>{myLedger.length === 0 ? <div className="people-empty-state"><History size={22} /><strong>휴가 변동 이력이 없습니다.</strong><span>관리자가 휴가를 부여하면 이곳에 기록됩니다.</span></div> : <div className="leave-ledger-list">{myLedger.slice(0, 12).map((entry) => <article key={entry.id}><span className={entry.days >= 0 ? 'plus' : 'minus'}>{entry.days >= 0 ? '+' : ''}{entry.days}일</span><div><strong>{entry.type} · {entry.memo}</strong><small>{formatDateTime(entry.createdAt)} · 처리 {entry.actor}</small></div><em>잔여 {entry.balanceAfter.toFixed(1)}일</em></article>)}</div>}</div>}
    </section>}

    {canManage && tab === 'leave-admin' && <section className="people-content-card leave-admin-panel" role="tabpanel">
      <header><div><h2>휴가 정책 · 원장</h2><p>연차 발생 기준을 설정하고 직원별 부여·차감·리뉴얼 이력을 관리합니다.</p></div><div><Button tone="ghost" type="button" onClick={(event) => openModal('adjust', event.currentTarget)}><Plus size={17} /> 부여·차감</Button><Button tone="primary" type="button" onClick={runAccrual}><RefreshCw size={17} /> {leaveManagement.policy.mode === 'monthly' ? '이번 달 발생' : leaveManagement.policy.mode === 'yearly' ? '연차 리뉴얼' : '수동 조정 사용'}</Button></div></header>
      <div className="leave-policy-modes" role="radiogroup" aria-label="연차 발생 방식">
        <button type="button" role="radio" aria-checked={leaveManagement.policy.mode === 'monthly'} className={leaveManagement.policy.mode === 'monthly' ? 'active' : ''} onClick={() => setPolicyMode('monthly')}><span><CalendarDays size={20} /></span><strong>월별 발생</strong><p>매월 정해진 일수를 자동 부여</p><em>월 {leaveManagement.policy.monthlyDays}일</em></button>
        <button type="button" role="radio" aria-checked={leaveManagement.policy.mode === 'yearly'} className={leaveManagement.policy.mode === 'yearly' ? 'active' : ''} onClick={() => setPolicyMode('yearly')}><span><RefreshCw size={20} /></span><strong>연초 일괄</strong><p>지정일에 연차와 이월분을 리뉴얼</p><em>연 {leaveManagement.policy.annualDays}일</em></button>
        <button type="button" role="radio" aria-checked={leaveManagement.policy.mode === 'manual'} className={leaveManagement.policy.mode === 'manual' ? 'active' : ''} onClick={() => setPolicyMode('manual')}><span><Settings2 size={20} /></span><strong>수동 부여</strong><p>관리자가 직원별로 직접 조정</p><em>승인 즉시 반영</em></button>
      </div>
      <div className="leave-policy-settings">
        <label><span>연초 기본 부여</span><input key={`annual-${leaveManagement.policy.annualDays}`} type="number" min="0" step="0.5" defaultValue={leaveManagement.policy.annualDays} onBlur={(event) => updatePolicyNumber('annualDays', Number(event.target.value))} /><small>일</small></label>
        <label><span>월별 발생량</span><input key={`monthly-${leaveManagement.policy.monthlyDays}`} type="number" min="0" step="0.5" defaultValue={leaveManagement.policy.monthlyDays} onBlur={(event) => updatePolicyNumber('monthlyDays', Number(event.target.value))} /><small>일</small></label>
        <label><span>이월 한도</span><input key={`carry-${leaveManagement.policy.carryOverLimit}`} type="number" min="0" step="0.5" defaultValue={leaveManagement.policy.carryOverLimit} onBlur={(event) => updatePolicyNumber('carryOverLimit', Number(event.target.value))} /><small>일</small></label>
        <label><span>리뉴얼 기준일</span><input key={`renewal-${leaveManagement.policy.renewalDate}`} type="text" inputMode="numeric" pattern="\d{2}-\d{2}" defaultValue={leaveManagement.policy.renewalDate} onBlur={(event) => updatePolicyDate(event.target.value.trim())} aria-label="리뉴얼 기준일 MM-DD" /><small>MM-DD</small></label>
      </div>
      <div className="leave-admin-grid">
        <section><div className="people-subsection-head"><div><h3>직원별 휴가 잔여</h3><p>총량에서 승인 사용분을 차감한 현재 기준입니다.</p></div><strong>{leaveManagement.balances.length}명</strong></div><div className="leave-balance-list">{leaveManagement.balances.length === 0 && <div className="people-empty-state"><CalendarDays size={22} /><strong>휴가 원장이 비어 있습니다.</strong><span>부여·차감 버튼으로 첫 직원 휴가를 등록하세요.</span></div>}{leaveManagement.balances.map((balance) => <article key={balance.name}><span className="person-avatar">{balance.name.slice(0, 1)}</span><div><strong>{balance.name}</strong><small>{balance.team} · {formatDateLabel(balance.updatedAt, true, false)}</small></div><span><small>총량</small><strong>{balance.total.toFixed(1)}일</strong></span><span><small>사용</small><strong>{balance.used.toFixed(1)}일</strong></span><em>잔여 {(balance.total - balance.used).toFixed(1)}일</em></article>)}</div></section>
        <section><div className="people-subsection-head"><div><h3>부여·차감·리뉴얼 이력</h3><p>관리자와 시스템의 모든 조정을 추적합니다.</p></div><History size={20} /></div><div className="leave-ledger-list admin">{leaveManagement.ledger.length === 0 && <div className="people-empty-state"><History size={22} /><strong>조정 이력이 없습니다.</strong><span>휴가 조정 시 자동으로 기록됩니다.</span></div>}{leaveManagement.ledger.slice(0, 30).map((entry) => <article key={entry.id}><span className={entry.days >= 0 ? 'plus' : 'minus'}>{entry.days >= 0 ? '+' : ''}{entry.days}일</span><div><strong>{entry.name} · {entry.type}</strong><small>{entry.memo} · {formatDateTime(entry.createdAt)}</small></div><em>잔여 {entry.balanceAfter.toFixed(1)}일</em></article>)}</div></section>
      </div>
    </section>}

    {canOversee && tab === 'oversight' && <section className="people-content-card" role="tabpanel"><OversightPanel canManageGrants={canManage} workspaceScope={workspaceScope} onToast={onToast} /></section>}
    {tab === 'performance' && <section className="people-content-card people-performance" role="tabpanel"><PerformanceReports workspaceScope={workspaceScope ?? ''} canManage={canManage} onToast={onToast} onOpenTask={(taskId) => onOpenTask?.(taskId)} /></section>}
    {canManage && tab === 'accounts' && <section className="people-content-card" role="tabpanel">
      <header><div><h2>신규 계정 · 접근 권한</h2><p>초대 → 관리자 승인 → 1회용 초기 비밀번호 → 본인 비밀번호 설정 순서로 활성화됩니다.</p></div><Button tone="primary" type="button" onClick={(event) => openModal('invite', event.currentTarget)}><Send size={17} /> 초대 보내기</Button></header>
      <div className="access-flow"><span className="done"><Check size={15} /> 계정 생성</span><i /><span className="active">관리자 승인</span><i /><span>72시간 초기 암호</span><i /><span>첫 로그인 변경</span></div>
      <div className="approval-list account">{managedAccounts.length === 0 && <div className="people-empty-state"><UserCheck size={22} /><strong>등록된 일반 직원 계정이 없습니다.</strong><span>구성원 초대로 실제 로그인 계정을 생성할 수 있습니다.</span></div>}{managedAccounts.map((request) => <article key={request.id}>
        <div className="approval-avatar account"><Mail size={18} /></div>
        <div className="approval-main"><div><strong>{request.name}</strong><span>{request.id} · {formatDateTime(request.requested)}</span></div><h3>{request.email}</h3><p>{request.team} · 요청 역할: {request.role}</p>{request.onboardingStatus && <small className={`account-onboarding ${request.onboardingStatus === '초기암호만료' ? 'expired' : ''}`}>{request.onboardingStatus}{request.temporaryPasswordExpiresAt && request.onboardingStatus !== '설정완료' ? ` · ${formatDateTime(request.temporaryPasswordExpiresAt)} 만료` : ''}</small>}</div>
        <StateBadge tone={request.status === '활성' ? 'good' : request.status === '반려' ? 'danger' : 'warning'}>{request.status}</StateBadge>
        {request.status === '승인대기' ? <div className="approval-actions"><Button tone="danger" size="sm" type="button" onClick={(event) => void decideAccount(request.id, '반려', event.currentTarget)}>반려</Button><Button tone="primary" size="sm" type="button" onClick={(event) => void decideAccount(request.id, '활성', event.currentTarget)}><UserCheck size={16} /> 승인</Button></div> : request.status === '활성' ? <div className="account-credential-actions"><span className="approval-result"><ShieldCheck size={17} />{request.onboardingStatus === '설정완료' ? '로그인 가능' : '초기 설정 대기'}</span><Button tone="ghost" size="sm" type="button" disabled={credentialIssuingId === request.id} onClick={(event) => void reissueCredential(request, event.currentTarget)}><RefreshCw size={15} />{credentialIssuingId === request.id ? '발급 중…' : '비밀번호 재설정 발급'}</Button></div> : <span className="approval-result"><ShieldCheck size={17} />접근 불가</span>}
      </article>)}</div>
      <div className="account-safety-note"><AlertTriangle size={19} /><div><strong>초기 비밀번호는 승인 또는 재발급 직후 한 번만 표시됩니다.</strong><p>72시간 후 만료되며 첫 로그인에서 새 비밀번호를 설정하기 전에는 업무 데이터에 접근할 수 없습니다.</p></div></div>
      {/*
        외부 게스트는 직원 계정 목록(/api/admin/accounts)에 섞지 않는다. 승인 흐름이 다르고(링크로 스스로 비밀번호 설정),
        보이는 범위가 프로젝트 단위라서 같은 줄에 두면 "직원 한 명"으로 읽힌다.
      */}
      <section className="guest-admin-section" aria-labelledby="guest-admin-title">
        <div className="people-subsection-head"><div><h3 id="guest-admin-title">외부 게스트</h3><p>거래처 담당자를 초대된 프로젝트의 업무·채널·자료·게시판에만 들여보냅니다. 그 밖의 회사 데이터는 존재조차 보이지 않습니다.</p></div><Button tone="secondary" type="button" onClick={(event) => openGuestInvite(event.currentTarget)}><UserPlus size={17} /> 게스트 초대</Button></div>
        {guestsState === 'loading' && <div className="people-empty-state"><Users size={22} /><strong>게스트 목록을 불러오는 중</strong></div>}
        {guestsState === 'error' && <div className="people-empty-state"><AlertTriangle size={22} /><strong>게스트 목록을 불러오지 못했습니다.</strong><span>서버가 준비되면 다시 시도해 주세요.</span><Button tone="ghost" size="sm" type="button" onClick={() => void loadGuests()}>다시 시도</Button></div>}
        {guestsState === 'ready' && guests.length === 0 && <div className="people-empty-state"><Users size={22} /><strong>초대한 게스트가 없습니다</strong><span>게스트 초대에서 거래처 담당자에게 프로젝트 범위를 정해 링크를 보낼 수 있습니다.</span></div>}
        {guestsState === 'ready' && guests.length > 0 && <div className="guest-admin-list" role="list">{guests.map((guest) => {
          const busy = guestBusyId === guest.id
          const names = guestProjectNames(guest)
          return <article className="guest-admin-row" role="listitem" key={guest.id}>
            <span className="person-avatar">{guest.name.slice(0, 1)}</span>
            <div className="guest-admin-main">
              <div><strong>{guest.name}</strong><span>{guest.orgName || '거래처 미입력'} · {guest.email}</span></div>
              <div className="guest-project-chips">{names.length === 0 ? <StatusBadge className="status-pill" tone="neutral">프로젝트 없음</StatusBadge> : names.map((name) => <StatusBadge className="status-pill" tone="info" key={name}>{name}</StatusBadge>)}</div>
              <small>{guest.lastActivityAt ? `마지막 활동 ${formatDateTime(guest.lastActivityAt)}` : '아직 활동 없음'}{guest.accessExpiresAt ? ` · ${formatDateLabel(guest.accessExpiresAt, true, false)}까지` : ''}{typeof guest.commentCount === 'number' ? ` · 댓글 ${guest.commentCount}` : ''}{typeof guest.attachmentCount === 'number' ? ` · 첨부 ${guest.attachmentCount}` : ''}</small>
            </div>
            <StatusBadge className="status-pill" dot tone={guestStatusTone[guest.status] ?? 'neutral'}>{guestStatusLabel[guest.status] ?? guest.status}</StatusBadge>
            <div className="guest-actions">
              {guest.status === 'invited' && <><Button tone="quiet" size="sm" type="button" disabled={busy} onClick={(event) => void resendGuestInvite(guest, event.currentTarget)}><RefreshCw size={15} /> 재발송·링크</Button><Button tone="quiet" size="sm" type="button" disabled={busy} onClick={() => void revokeGuestInvitation(guest)}><XCircle size={15} /> 초대 회수</Button></>}
              {guest.status !== 'revoked' && <Button tone="quiet" size="sm" type="button" disabled={busy} onClick={(event) => openGuestScope(guest, event.currentTarget)}><Settings2 size={15} /> 범위 변경</Button>}
              {guest.status === 'active' && <Button tone="quiet" size="sm" type="button" disabled={busy} onClick={() => void setGuestStatus(guest, 'inactive')}>비활성</Button>}
              {(guest.status === 'inactive' || guest.status === 'expired') && <Button tone="quiet" size="sm" type="button" disabled={busy} onClick={() => void setGuestStatus(guest, 'active')}>재활성</Button>}
              {guest.status !== 'revoked' && <Button tone="danger" size="sm" type="button" disabled={busy} onClick={() => void revokeGuest(guest)}><Trash2 size={15} /> 해지</Button>}
              {guest.status === 'revoked' && <span className="approval-result"><ShieldCheck size={17} /> 해지됨{guest.acceptedAt ? '' : ' · 미수락'}</span>}
            </div>
          </article>
        })}</div>}
      </section>
      <section className="operator-access-log" aria-labelledby="operator-access-log-title">
        <div className="people-subsection-head"><div><h3 id="operator-access-log-title">{`운영사(${BRAND.name}) 접속 이력`}</h3><p>플랫폼 운영자가 우리 회사 워크스페이스에 접속·조회·변경한 모든 기록입니다.</p></div><strong>{operatorAccessLog.length}건</strong></div>
        {operatorAccessLog.length === 0
          ? <div className="people-empty-state"><ShieldCheck size={22} /><strong>운영사 접속 기록이 없습니다.</strong><span>운영자가 접속하면 시각·행위·운영자 이름이 여기에 남습니다.</span></div>
          : <div className="operator-access-list">{operatorAccessLog.slice(0, 50).map((event) => <article key={event.id}><time>{event.at}</time><div><strong>{event.event}</strong><small>{event.scope}</small></div><span>{event.actor}</span></article>)}</div>}
      </section>
    </section>}

    {modal && (modal === 'leave' || canManage) && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeModal()}>
      <section ref={modalRef} className="modal-card people-modal" role="dialog" aria-modal="true" aria-labelledby="people-modal-title" tabIndex={-1}>
        <header><div><span className="eyebrow">{modal === 'leave' ? 'LEAVE REQUEST' : modal === 'adjust' ? 'LEAVE LEDGER' : modal === 'profile' ? 'MEMBER PROFILE' : modal === 'credential' ? 'ONE-TIME CREDENTIAL' : modal === 'guest-invite' ? 'INVITE GUEST' : modal === 'guest-scope' ? 'GUEST SCOPE' : 'INVITE MEMBER'}</span><h2 id="people-modal-title">{modal === 'leave' ? editingLeaveId ? '휴가 신청 수정' : '휴가 신청' : modal === 'adjust' ? '휴가 부여 · 차감' : modal === 'profile' ? `${selectedProfile?.name ?? '구성원'} 프로필` : modal === 'credential' ? '초기 비밀번호 전달' : modal === 'guest-invite' ? guestInvitation ? '초대 링크 전달' : '외부 게스트 초대' : modal === 'guest-scope' ? `${guestScopeTarget?.name ?? '게스트'} 범위 변경` : '새 구성원 초대'}</h2><p>{modal === 'leave' ? '결재 승인 후 근무표와 휴가 사용량에 반영됩니다.' : modal === 'adjust' ? '직원별 휴가 총량을 조정하고 원장에 사유를 남깁니다.' : modal === 'profile' ? '소속, 접근 권한, 근무 상태와 휴가 현황을 한곳에서 확인합니다.' : modal === 'credential' ? '이 화면을 닫으면 초기 비밀번호를 다시 확인할 수 없습니다.' : modal === 'guest-invite' ? guestInvitation ? '게스트는 이 링크에서 비밀번호를 정하고 바로 시작합니다.' : '거래처 담당자에게 지정한 프로젝트만 열어 줍니다. 결재·직원 목록·다른 화면은 보이지 않습니다.' : modal === 'guest-scope' ? '프로젝트를 빼면 그 프로젝트의 멤버·채널에서도 즉시 제외됩니다.' : '가입 후 관리자가 소속과 권한을 최종 승인합니다.'}</p></div><IconButton tone="ghost" type="button" aria-label="닫기" onClick={closeModal}><X size={21} /></IconButton></header>
        {modal === 'leave' ? <form onSubmit={submitLeave}>
          <div className="form-grid"><label className="form-field"><span>휴가 유형</span><select name="type" value={leaveType} data-autofocus onChange={(event) => { const next = event.target.value; setLeaveType(next); if (next === '반차') setLeaveEndDate(leaveStartDate) }}><option>연차</option><option>반차</option><option>공가</option><option>병가</option><option>경조휴가</option><option>기타</option></select></label><label className="form-field"><span>결재자</span><select name="approverId" required value={leaveApproverId} onChange={(event) => setLeaveApproverId(event.target.value)}><option value="" disabled>{leaveApprovers.length ? '결재자 선택' : '결재자 불러오는 중…'}</option>{leaveApprovers.map((approver) => <option value={approver.id} key={approver.id}>{approver.name} · {approver.team}</option>)}</select></label></div>
          <div className="form-grid"><label className="form-field"><span>시작일</span><input type="date" value={leaveStartDate} required onChange={(event) => { const next = event.target.value; setLeaveStartDate(next); if (leaveType === '반차' || leaveEndDate < next) setLeaveEndDate(next) }} /></label><label className="form-field"><span>종료일</span><input type="date" value={leaveType === '반차' ? leaveStartDate : leaveEndDate} min={leaveStartDate} disabled={leaveType === '반차'} required onChange={(event) => setLeaveEndDate(event.target.value)} /></label></div>
          <div className={`leave-duration-preview${calculateLeaveDays(leaveStartDate, leaveEndDate, leaveType) <= 0 ? ' invalid' : ''}`} role="status"><CalendarDays size={19} /><div><strong>사용 일수 {calculateLeaveDays(leaveStartDate, leaveEndDate, leaveType).toFixed(1)}일</strong><span>{leaveType === '반차' ? '반차는 선택한 날짜의 0.5일로 계산됩니다.' : '시작일과 종료일 사이의 주말을 제외해 자동 계산합니다.'}</span></div><em>잔여 {myRemaining.toFixed(1)}일</em></div>
          {(leaveType === '연차' || leaveType === '반차') && calculateLeaveDays(leaveStartDate, leaveEndDate, leaveType) > myRemaining && <div className="leave-balance-warning" role="status"><AlertTriangle size={17} /><span>남은 휴가보다 많은 일수입니다. 신청은 가능하지만, 승인 전에 관리자가 휴가를 부여해야 결재가 완료됩니다.</span></div>}
          <label className="form-field full"><span>사유</span><textarea name="reason" rows={3} defaultValue={editingLeaveId ? leaves.find((leave) => leave.id === editingLeaveId)?.reason : ''} placeholder="결재자가 확인할 수 있도록 간단히 입력하세요." required /></label>
          <footer><Button tone="ghost" type="button" onClick={closeModal}>취소</Button><Button tone="primary" type="submit" disabled={isSubmittingLeave || leaveApprovers.length === 0 || calculateLeaveDays(leaveStartDate, leaveEndDate, leaveType) <= 0}><CheckCircle2 size={18} /> {isSubmittingLeave ? '저장 중…' : editingLeaveId ? '수정 저장' : '결재 요청'}</Button></footer>
        </form> : modal === 'adjust' ? <form onSubmit={submitAdjustment}>
          <div className="form-grid"><label className="form-field"><span>대상 직원</span><input name="employee" list="leave-employee-options" placeholder="이름 입력 또는 선택" data-autofocus required /><datalist id="leave-employee-options">{Array.from(new Set([currentUserName, ...leaveManagement.balances.map((balance) => balance.name), ...directoryMembers.map((member) => member.name), ...managedAccounts.map((account) => account.name)])).map((name) => <option value={name} key={name} />)}</datalist></label><label className="form-field"><span>소속</span><input name="team" defaultValue={currentUserTeam} placeholder="예: 생산 1팀" required /></label></div>
          <div className="form-grid"><label className="form-field"><span>조정 유형</span><select name="action"><option value="grant">휴가 부여</option><option value="deduct">휴가 차감</option></select></label><label className="form-field"><span>조정 일수</span><input name="days" type="number" min="0.5" step="0.5" defaultValue="1" required /></label></div>
          <label className="form-field full"><span>조정 사유</span><textarea name="memo" rows={3} placeholder="예: 장기근속 특별 연차, 오등록 정정" required /></label>
          <div className="modal-note secure"><History size={18} /><p><strong>저장 후 휴가 원장에 영구 이력이 남습니다.</strong><span>차감은 현재 잔여 휴가보다 크게 적용되지 않습니다.</span></p></div>
          <footer><Button tone="ghost" type="button" onClick={closeModal}>취소</Button><Button tone="primary" type="submit"><CheckCircle2 size={18} /> 조정 저장</Button></footer>
        </form> : modal === 'profile' && selectedProfile ? <div className="people-profile-detail">
          <section className="people-profile-identity"><span className="person-avatar large">{selectedProfile.name.slice(0, 1)}</span><div><strong>{selectedProfile.name}</strong><p>{selectedProfile.role} · {selectedProfile.team}</p><small>{selectedProfile.email ?? selectedProfileAccountId ?? '로그인 계정 미연결'}</small></div><StateBadge tone={selectedProfile.attendance === '근무중' || selectedProfile.attendance === '현재 로그인' ? 'good' : 'neutral'}>{selectedProfile.attendance}</StateBadge></section>
          <div className="people-profile-grid"><article><small>현재 업무</small><strong>{selectedProfile.work}</strong></article><article><small>접근 권한</small><strong>{selectedProfile.permission}</strong></article><article><small>휴가 총량</small><strong>{selectedProfileBalance ? `${selectedProfileBalance.total.toFixed(1)}일` : '미등록'}</strong></article><article><small>남은 휴가</small><strong>{selectedProfileBalance ? `${Math.max(0, selectedProfileBalance.total - selectedProfileBalance.used).toFixed(1)}일` : '미등록'}</strong></article></div>
          <section className="people-profile-leaves"><div className="people-subsection-head"><div><h3>최근 휴가 신청</h3><p>결재 상태까지 포함한 최근 3건입니다.</p></div><strong>{selectedProfileLeaves.length}건</strong></div>{selectedProfileLeaves.length ? selectedProfileLeaves.slice(0, 3).map((leave) => <article key={leave.id}><div><strong>{leave.type} · {leave.period}</strong><small>{leave.reason} · {leave.days}일</small></div><StateBadge tone={leave.status === '승인' ? 'good' : leave.status === '반려' ? 'danger' : 'warning'}>{leave.status}</StateBadge></article>) : <div className="people-profile-empty">휴가 신청 이력이 없습니다.</div>}</section>
          <div className="modal-note secure"><ShieldCheck size={18} /><p><strong>표시 데이터 범위</strong><span>이 화면은 ERP 계정·휴가 원장·업무 요약을 조합합니다. 외부 근태 단말 정보는 연동 전까지 표시하지 않습니다.</span></p></div>
          <footer><Button tone="primary" type="button" onClick={closeModal}>확인</Button></footer>
        </div> : modal === 'credential' && issuedCredential ? <div className="people-credential-panel">
          <div className="credential-warning"><AlertTriangle size={19} /><div><strong>직원에게 안전한 사내 채널로 전달하세요.</strong><span>서버에는 원문이 저장되지 않으며 재확인이 필요하면 새로 발급해야 합니다.</span></div></div>
          <label><span>로그인 이메일</span><strong>{issuedCredential.email}</strong></label>
          <label><span>1회용 초기 비밀번호</span><div className="credential-code"><code>{issuedCredential.temporaryPassword}</code><button type="button" onClick={() => { void navigator.clipboard.writeText(issuedCredential.temporaryPassword).then(() => onToast('초기 비밀번호를 클립보드에 복사했습니다.')).catch(() => onToast('자동 복사에 실패했습니다. 화면의 비밀번호를 직접 복사해 주세요.')) }}><Copy size={17} /> 복사</button></div></label>
          <p><Clock3 size={17} /> {formatDateTime(issuedCredential.expiresAt)}까지 유효 · 첫 로그인 후 즉시 폐기</p>
          <footer><Button tone="primary" type="button" onClick={closeModal}>전달 완료</Button></footer>
        </div> : modal === 'guest-invite' && guestInvitation ? <div className="people-credential-panel guest-invite-result">
          <div className={guestInvitation.invitation.delivery === 'sent' ? 'credential-warning is-sent' : 'credential-warning'}>{guestInvitation.invitation.delivery === 'sent' ? <CheckCircle2 size={19} /> : <AlertTriangle size={19} />}<div><strong>{guestInvitation.invitation.delivery === 'sent' ? `${guestInvitation.guest.email}로 초대 메일을 보냈습니다.` : '메일 발송 어댑터가 없어 링크를 직접 전달해 주세요.'}</strong><span>{guestInvitation.guest.name} · {guestInvitation.guest.orgName} · {guestProjectNames(guestInvitation.guest).join(', ') || '프로젝트 미지정'}</span></div></div>
          <label><span>초대 링크</span><div className="credential-code"><input readOnly value={guestInvitation.invitation.url} aria-label="초대 링크" onFocus={(event) => event.currentTarget.select()} /></div></label>
          <div className="guest-invite-copy"><Button tone="secondary" type="button" onClick={() => copyInviteLink(guestInvitation.invitation.url)}><Copy size={16} /> 링크 복사</Button></div>
          <p><Clock3 size={17} /> {formatDateTime(guestInvitation.invitation.expiresAt)}까지 유효 · 수락하면 링크는 폐기됩니다</p>
          <footer><Button tone="primary" type="button" onClick={closeModal}>전달 완료</Button></footer>
        </div> : modal === 'guest-invite' ? <form onSubmit={submitGuestInvite}>
          <div className="form-grid"><label className="form-field"><span>이름</span><input name="name" type="text" placeholder="예: 김거래" minLength={2} maxLength={40} data-autofocus required /></label><label className="form-field"><span>이메일</span><input name="email" type="email" placeholder="name@partner.co.kr" required /></label></div>
          <label className="form-field full"><span>거래처명</span><input name="orgName" type="text" placeholder="예: 한국도로공사" maxLength={80} required /></label>
          <fieldset className="guest-project-picker"><legend>볼 수 있는 프로젝트 <em>필수</em></legend>
            {guestProjectOptions === null && <p className="guest-project-picker-note">프로젝트를 불러오는 중…</p>}
            {guestProjectOptions?.length === 0 && <p className="guest-project-picker-note">진행 중인 프로젝트가 없습니다. 프로젝트를 먼저 만들어 주세요.</p>}
            {(guestProjectOptions ?? []).map((project) => <label key={project.id}><input type="checkbox" checked={guestProjectPick.includes(project.id)} onChange={() => toggleGuestProject(project.id)} /><span>{project.name}</span></label>)}
          </fieldset>
          <div className="form-grid"><label className="form-field"><span>초대 링크 유효기간</span><input name="inviteExpiresInDays" type="number" min={1} max={30} defaultValue={7} required /><small className="guest-field-note">1~30일 · 기본 7일</small></label><label className="form-field"><span>접속 종료일 <em>선택</em></span><input name="accessExpiresAt" type="date" min={seoulDateInputValue()} /><small className="guest-field-note">비우면 해지할 때까지</small></label></div>
          <div className="modal-note secure"><ShieldCheck size={18} /><p><strong>게스트는 고른 프로젝트 안에서만 움직입니다.</strong><span>업무는 본인 담당 건만, 채널은 참여 중인 방만, 자료는 공유받은 파일만 봅니다. 모든 행위는 "게스트"로 감사 기록에 남습니다.</span></p></div>
          <footer><Button tone="ghost" type="button" onClick={closeModal} disabled={guestInviting}>취소</Button><Button tone="primary" type="submit" disabled={guestInviting || guestProjectPick.length === 0}><Send size={18} /> {guestInviting ? '초대 만드는 중…' : '초대 보내기'}</Button></footer>
        </form> : modal === 'guest-scope' && guestScopeTarget ? <form onSubmit={submitGuestScope}>
          <div className="form-grid"><label className="form-field"><span>이름</span><input name="name" type="text" defaultValue={guestScopeTarget.name} minLength={2} maxLength={40} required /></label><label className="form-field"><span>거래처명</span><input name="orgName" type="text" defaultValue={guestScopeTarget.orgName} maxLength={80} required /></label></div>
          <fieldset className="guest-project-picker"><legend>볼 수 있는 프로젝트 <em>필수</em></legend>
            {guestProjectOptions === null && <p className="guest-project-picker-note">프로젝트를 불러오는 중…</p>}
            {(guestProjectOptions ?? []).map((project) => <label key={project.id}><input type="checkbox" checked={guestProjectPick.includes(project.id)} onChange={() => toggleGuestProject(project.id)} /><span>{project.name}</span></label>)}
          </fieldset>
          <label className="form-field full"><span>접속 종료일 <em>선택</em></span><input name="accessExpiresAt" type="date" defaultValue={guestScopeTarget.accessExpiresAt ? seoulDateInputValue(new Date(guestScopeTarget.accessExpiresAt)) : ''} /><small className="guest-field-note">비우면 해지할 때까지 · 지나면 자동으로 만료됩니다</small></label>
          <footer><Button tone="ghost" type="button" onClick={closeModal} disabled={guestBusyId === guestScopeTarget.id}>취소</Button><Button tone="primary" type="submit" disabled={guestBusyId === guestScopeTarget.id || guestProjectPick.length === 0}><CheckCircle2 size={18} /> {guestBusyId === guestScopeTarget.id ? '저장 중…' : '범위 저장'}</Button></footer>
        </form> : <form onSubmit={submitInvite}>
          <div className="form-grid"><label className="form-field"><span>이름</span><input name="name" type="text" placeholder="예: 이하늘" minLength={2} maxLength={40} data-autofocus required /></label><label className="form-field"><span>회사 이메일</span><input name="email" type="email" placeholder="name@company.co.kr" required /></label></div>
          <label className="form-field full"><span>직위 <em>선택</em></span><input name="position" type="text" placeholder="예: 대리, 팀장, 연구원" maxLength={40} /></label>
          <div className="modal-note secure"><ShieldCheck size={18} /><p><strong>승인 전에는 업무 데이터에 접근할 수 없습니다.</strong><span>승인 시 72시간 유효한 초기 비밀번호가 한 번 표시되고, 직원은 첫 로그인에서 직접 변경합니다.</span></p></div>
          <footer><Button tone="ghost" type="button" onClick={closeModal}>취소</Button><Button tone="primary" type="submit" disabled={isInviting}><Send size={18} /> {isInviting ? '생성 중…' : '계정 생성'}</Button></footer>
        </form>}
      </section>
    </div>}
  </div>
}

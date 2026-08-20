import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  AlertTriangle, CalendarDays, Check, CheckCircle2, ChevronRight, Clock3,
  Copy, FileCheck2, History, KeyRound, Mail, Plus, RefreshCw, Send, Settings2,
  ShieldCheck, UserCheck, UserPlus, Users, X, XCircle,
} from 'lucide-react'
import { useWorkspaceState } from '../hooks/useWorkspaceState'
import { formatDateLabel, formatDateTime, seoulDateInputValue } from '../utils/dateTime'
import './PeopleOperations.css'

type PeopleOperationsProps = {
  onToast: (message: string) => void
  canManage: boolean
  currentUserId?: string
  currentUserName: string
  currentUserTeam: string
  workspaceScope?: string
}
type PeopleTab = 'members' | 'leave' | 'leave-admin' | 'accounts'
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

type PeopleModal = 'leave' | 'invite' | 'adjust' | 'profile' | 'credential'

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

export function PeopleOperationsPage({ onToast, canManage, currentUserId, currentUserName, currentUserTeam, workspaceScope }: PeopleOperationsProps) {
  const [tab, setTab] = useState<PeopleTab>(canManage ? 'members' : 'leave')
  const [leaves, setLeaves] = useWorkspaceState<LeaveRequest[]>('leave-requests', [], { scope: workspaceScope, seedWhenEmpty: false, validate: isLeaveRequestList })
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
  const [modal, setModal] = useState<PeopleModal | null>(null)
  const [selectedProfile, setSelectedProfile] = useState<MemberProfile | null>(null)
  const [scheduleSnapshot, setScheduleSnapshot] = useState<{ checkedAt: string; activeAccounts: number; approvedLeaves: number } | null>(null)
  const [confirmAccrual, setConfirmAccrual] = useState(false)
  const modalRef = useRef<HTMLElement>(null)
  const modalTriggerRef = useRef<HTMLButtonElement | null>(null)

  const openModal = (nextModal: PeopleModal, trigger: HTMLButtonElement, profile?: MemberProfile) => {
    modalTriggerRef.current = trigger
    if (nextModal === 'profile') setSelectedProfile(profile ?? null)
    if (nextModal === 'leave') {
      const today = seoulDateInputValue()
      setLeaveType('연차')
      setLeaveStartDate(today)
      setLeaveEndDate(today)
      setLeaveApproverId(leaveApprovers[0]?.id ?? '')
    }
    setModal(nextModal)
  }

  const closeModal = () => {
    setModal(null)
    setSelectedProfile(null)
    setIssuedCredential(null)
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
    () => canManage ? leaves : leaves.filter((item) => item.name === currentUserName),
    [canManage, currentUserName, leaves],
  )
  const pendingLeaves = useMemo(() => visibleLeaves.filter((item) => item.status === '결재대기').length, [visibleLeaves])
  const pendingAccounts = useMemo(() => managedAccounts.filter((item) => item.status === '승인대기').length, [managedAccounts])
  const myBalance = leaveManagement.balances.find((balance) => balance.accountId ? balance.accountId === currentUserId : balance.name === currentUserName)
    ?? { accountId: currentUserId, name: currentUserName, team: currentUserTeam, total: 0, used: 0, updatedAt: '미등록' }
  const myRemaining = Math.max(0, myBalance.total - myBalance.used)
  const myLedger = leaveManagement.ledger.filter((entry) => entry.name === '전 구성원' || (entry.accountId ? entry.accountId === currentUserId : entry.name === currentUserName))
  const peopleRows = useMemo<MemberProfile[]>(() => {
    const members = directoryMembers.map((member) => ({
      accountId: member.id,
      name: member.name,
      email: managedAccounts.find((account) => account.id === member.id)?.email,
      role: member.role,
      team: member.team,
      work: '현재 배정 업무 없음',
      attendance: member.id === currentUserId ? '현재 로그인' : '근무 상태 미연동',
      permission: member.role,
    }))
    if (members.some((person) => person.accountId === currentUserId || person.name === currentUserName)) return members
    const current: MemberProfile = { accountId: currentUserId, name: currentUserName, role: canManage ? '운영 관리자' : '일반 사용자', team: currentUserTeam, work: '현재 배정 업무 없음', attendance: '현재 로그인', permission: canManage ? '관리 권한' : '일반 사용자' }
    return [current, ...members]
  }, [canManage, currentUserId, currentUserName, currentUserTeam, directoryMembers, managedAccounts])
  const selectedProfileAccountId = selectedProfile?.accountId
  const selectedProfileBalance = selectedProfile ? leaveManagement.balances.find((balance) => selectedProfileAccountId && balance.accountId ? balance.accountId === selectedProfileAccountId : balance.name === selectedProfile.name) : undefined
  const selectedProfileLeaves = selectedProfile ? leaves.filter((leave) => selectedProfileAccountId && leave.requesterId ? leave.requesterId === selectedProfileAccountId : leave.name === selectedProfile.name) : []

  const refreshScheduleSnapshot = () => {
    const next = {
      checkedAt: new Date().toISOString(),
      activeAccounts: peopleRows.filter((person) => person.attendance !== '휴가').length,
      approvedLeaves: leaves.filter((leave) => leave.status === '승인').length,
    }
    setScheduleSnapshot(next)
    onToast('승인 휴가와 활성 계정으로 근무표 화면을 다시 계산했습니다. 외부 근태 단말·공유 일정 연동은 별도 설정이 필요합니다.')
  }

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
    if (!confirmAccrual) { setConfirmAccrual(true); window.setTimeout(() => setConfirmAccrual(false), 4000); return }

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
    setConfirmAccrual(false)
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
      const result = await response.json() as { leave?: LeaveRequest; leaveManagement?: LeaveManagementState; error?: { message?: string } }
      if (!response.ok || !result.leave) throw new Error(result.error?.message || '휴가 결재 상태를 저장하지 못했습니다.')
      void setLeaves((current) => current.map((item) => item.id === id ? result.leave! : item), { persist: false })
      if (result.leaveManagement) void setLeaveManagement(result.leaveManagement, { persist: false })
    } catch (error) {
      onToast(error instanceof Error ? error.message : '휴가 결재 상태를 저장하지 못했습니다. 다시 시도해 주세요.')
      return
    }
    onToast(status === '승인' ? '휴가 신청을 승인하고 근무표에 반영했습니다.' : '휴가 신청을 반려했습니다.')
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
    if ((leaveType === '연차' || leaveType === '반차') && requestedDays > myRemaining) {
      onToast(`남은 휴가 ${myRemaining.toFixed(1)}일보다 많이 신청할 수 없습니다.`)
      return
    }
    setIsSubmittingLeave(true)
    try {
      const response = await fetch('/api/leave-requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: leaveType,
          startDate: leaveStartDate,
          endDate: leaveType === '반차' ? leaveStartDate : leaveEndDate,
          approverId,
          reason: String(form.get('reason')),
        }),
      })
      const result = await response.json() as { leave?: LeaveRequest; error?: { message?: string } }
      if (!response.ok || !result.leave) throw new Error(result.error?.message || '휴가 신청을 저장하지 못했습니다.')
      void setLeaves((current) => [result.leave!, ...current.filter((item) => item.id !== result.leave!.id)], { persist: false })
    } catch (error) {
      onToast(error instanceof Error ? error.message : '휴가 신청을 저장하지 못했습니다. 다시 시도해 주세요.')
      return
    } finally {
      setIsSubmittingLeave(false)
    }
    closeModal()
    setTab('leave')
    onToast('휴가 신청을 결재 요청했습니다.')
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
        body: JSON.stringify({ name: String(form.get('name')), email, team: String(form.get('team')), role: String(form.get('role')) }),
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

  return <div className="content-page people-operations-page">
    <header className="page-header">
      <div><span className="eyebrow">PEOPLE & ACCESS</span><h1>{canManage ? '인사 · 조직' : '내 휴가 · 근태'}</h1><p>{canManage ? '구성원, 휴가, 계정 권한을 같은 승인 흐름으로 안전하게 관리합니다.' : `${currentUserTeam} 소속 내 휴가 신청과 결재 상태만 안전하게 확인합니다.`}</p></div>
      <div className="page-header-actions"><button className="button ghost" type="button" onClick={(event) => openModal('leave', event.currentTarget)}><CalendarDays size={18} /> 휴가 신청</button>{canManage && <button className="button ghost" type="button" onClick={(event) => openModal('adjust', event.currentTarget)}><Plus size={18} /> 휴가 부여·차감</button>}{canManage && <button className="button primary" type="button" onClick={(event) => openModal('invite', event.currentTarget)}><UserPlus size={18} /> 구성원 초대</button>}</div>
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
      <button type="button" role="tab" aria-selected={tab === 'leave'} onClick={() => setTab('leave')}><CalendarDays size={18} /> 휴가 · 근태 {pendingLeaves > 0 && <em>{pendingLeaves}</em>}</button>
      {canManage && <button type="button" role="tab" aria-selected={tab === 'leave-admin'} onClick={() => setTab('leave-admin')}><Settings2 size={18} /> 휴가 정책 · 원장</button>}
      {canManage && <button type="button" role="tab" aria-selected={tab === 'accounts'} onClick={() => setTab('accounts')}><KeyRound size={18} /> 계정 · 권한 {pendingAccounts > 0 && <em>{pendingAccounts}</em>}</button>}
    </div>

    {canManage && tab === 'members' && <section className="people-content-card" role="tabpanel">
      <header><div><h2>구성원 현황</h2><p>근무 상태와 현재 업무, 권한을 함께 확인합니다.</p></div><button className="button ghost" type="button" onClick={refreshScheduleSnapshot}><Clock3 size={17} /> 근무표 동기화</button></header>
      {scheduleSnapshot && <div className="people-sync-status" role="status"><span><RefreshCw size={18} /></span><div><strong>로컬 근무표 재계산 완료</strong><p>{formatDateTime(scheduleSnapshot.checkedAt)} · 근무 계정 {scheduleSnapshot.activeAccounts}명 · 승인 휴가 {scheduleSnapshot.approvedLeaves}건 반영</p></div><em>외부 근태·공유 일정 API 미연결</em></div>}
      <div className="people-directory-list">{peopleRows.length === 0 && <div className="people-empty-state"><Users size={22} /><strong>등록된 구성원 프로필이 없습니다.</strong><span>구성원 초대에서 실제 로그인 계정을 먼저 생성하세요.</span></div>}{peopleRows.map((person) => <article key={person.accountId ?? person.name}>
        <span className="person-avatar large">{person.name.slice(0, 1)}</span>
        <div className="people-directory-name"><strong>{person.name}</strong><span>{person.role} · {person.team}</span></div>
        <div><small>현재 업무</small><strong>{person.work}</strong></div>
        <div><small>접근 권한</small><strong>{person.permission}</strong></div>
        <StateBadge tone={person.attendance === '근무중' ? 'good' : 'neutral'}>{person.attendance}</StateBadge>
        <button className="small-button" type="button" onClick={(event) => openModal('profile', event.currentTarget, person)}>프로필</button>
      </article>)}</div>
    </section>}

    {tab === 'leave' && <section className="people-content-card" role="tabpanel">
      <header><div><h2>{canManage ? '휴가 신청 · 결재' : '내 휴가 신청'}</h2><p>{canManage ? '승인되면 공유 일정과 근무표에 자동 반영됩니다.' : '내 신청 내역만 표시되며, 승인 상태가 변경되면 즉시 확인할 수 있습니다.'}</p></div><button className="button primary" type="button" onClick={(event) => openModal('leave', event.currentTarget)}><Plus size={17} /> 휴가 신청</button></header>
      <div className="approval-list">{visibleLeaves.length === 0 && <div className="people-empty-state"><CalendarDays size={22} /><strong>아직 휴가 신청 내역이 없습니다.</strong><span>휴가 신청 버튼을 눌러 첫 신청을 등록하세요.</span></div>}{visibleLeaves.map((request) => <article key={request.id}>
        <div className="approval-avatar">{request.name.slice(0, 1)}</div>
        <div className="approval-main"><div><strong>{request.name}</strong><span>{request.team} · {request.id}</span></div><h3>{request.type} · {request.period}</h3><p>{request.reason} · {request.days}일 · 결재자 {request.approverName ?? '소속 관리자'}{request.status === '승인' && request.calendarVisibility === 'company' ? ' · 전사 일정 공유' : ''}</p></div>
        <StateBadge tone={request.status === '승인' ? 'good' : request.status === '반려' ? 'danger' : 'warning'}>{request.status}</StateBadge>
        {canManage && request.status === '결재대기' ? <div className="approval-actions"><button type="button" className="small-button reject" onClick={() => decideLeave(request.id, '반려')}><XCircle size={16} /> 반려</button><button type="button" className="small-button approve" onClick={() => decideLeave(request.id, '승인')}><Check size={16} /> 승인</button></div> : <span className="approval-result"><FileCheck2 size={17} /> {request.status === '결재대기' ? '결재 진행 중' : '처리 완료'}</span>}
      </article>)}</div>
      {!canManage && <div className="my-leave-ledger"><div className="people-subsection-head"><div><h3>내 휴가 원장</h3><p>발생·사용·관리자 조정 이력을 확인합니다.</p></div></div>{myLedger.length === 0 ? <div className="people-empty-state"><History size={22} /><strong>휴가 변동 이력이 없습니다.</strong><span>관리자가 휴가를 부여하면 이곳에 기록됩니다.</span></div> : <div className="leave-ledger-list">{myLedger.slice(0, 12).map((entry) => <article key={entry.id}><span className={entry.days >= 0 ? 'plus' : 'minus'}>{entry.days >= 0 ? '+' : ''}{entry.days}일</span><div><strong>{entry.type} · {entry.memo}</strong><small>{formatDateTime(entry.createdAt)} · 처리 {entry.actor}</small></div><em>잔여 {entry.balanceAfter.toFixed(1)}일</em></article>)}</div>}</div>}
    </section>}

    {canManage && tab === 'leave-admin' && <section className="people-content-card leave-admin-panel" role="tabpanel">
      <header><div><h2>휴가 정책 · 원장</h2><p>연차 발생 기준을 설정하고 직원별 부여·차감·리뉴얼 이력을 관리합니다.</p></div><div><button className="button ghost" type="button" onClick={(event) => openModal('adjust', event.currentTarget)}><Plus size={17} /> 부여·차감</button><button className={`button primary${confirmAccrual ? ' danger-confirm' : ''}`} type="button" onClick={runAccrual}><RefreshCw size={17} /> {confirmAccrual ? '한 번 더 눌러 실행' : leaveManagement.policy.mode === 'monthly' ? '이번 달 발생' : leaveManagement.policy.mode === 'yearly' ? '연차 리뉴얼' : '수동 조정 사용'}</button></div></header>
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

    {canManage && tab === 'accounts' && <section className="people-content-card" role="tabpanel">
      <header><div><h2>신규 계정 · 접근 권한</h2><p>초대 → 관리자 승인 → 1회용 초기 비밀번호 → 본인 비밀번호 설정 순서로 활성화됩니다.</p></div><button className="button primary" type="button" onClick={(event) => openModal('invite', event.currentTarget)}><Send size={17} /> 초대 보내기</button></header>
      <div className="access-flow"><span className="done"><Check size={15} /> 계정 생성</span><i /><span className="active">관리자 승인</span><i /><span>72시간 초기 암호</span><i /><span>첫 로그인 변경</span></div>
      <div className="approval-list account">{managedAccounts.length === 0 && <div className="people-empty-state"><UserCheck size={22} /><strong>등록된 일반 직원 계정이 없습니다.</strong><span>구성원 초대로 실제 로그인 계정을 생성할 수 있습니다.</span></div>}{managedAccounts.map((request) => <article key={request.id}>
        <div className="approval-avatar account"><Mail size={18} /></div>
        <div className="approval-main"><div><strong>{request.name}</strong><span>{request.id} · {formatDateTime(request.requested)}</span></div><h3>{request.email}</h3><p>{request.team} · 요청 역할: {request.role}</p>{request.onboardingStatus && <small className={`account-onboarding ${request.onboardingStatus === '초기암호만료' ? 'expired' : ''}`}>{request.onboardingStatus}{request.temporaryPasswordExpiresAt && request.onboardingStatus !== '설정완료' ? ` · ${formatDateTime(request.temporaryPasswordExpiresAt)} 만료` : ''}</small>}</div>
        <StateBadge tone={request.status === '활성' ? 'good' : request.status === '반려' ? 'danger' : 'warning'}>{request.status}</StateBadge>
        {request.status === '승인대기' ? <div className="approval-actions"><button type="button" className="small-button reject" onClick={(event) => void decideAccount(request.id, '반려', event.currentTarget)}>반려</button><button type="button" className="small-button approve" onClick={(event) => void decideAccount(request.id, '활성', event.currentTarget)}><UserCheck size={16} /> 승인</button></div> : request.status === '활성' ? <div className="account-credential-actions"><span className="approval-result"><ShieldCheck size={17} />{request.onboardingStatus === '설정완료' ? '로그인 가능' : '초기 설정 대기'}</span><button type="button" className="small-button" disabled={credentialIssuingId === request.id} onClick={(event) => void reissueCredential(request, event.currentTarget)}><RefreshCw size={15} />{credentialIssuingId === request.id ? '발급 중…' : '비밀번호 재설정 발급'}</button></div> : <span className="approval-result"><ShieldCheck size={17} />접근 불가</span>}
      </article>)}</div>
      <div className="account-safety-note"><AlertTriangle size={19} /><div><strong>초기 비밀번호는 승인 또는 재발급 직후 한 번만 표시됩니다.</strong><p>72시간 후 만료되며 첫 로그인에서 새 비밀번호를 설정하기 전에는 업무 데이터에 접근할 수 없습니다.</p></div></div>
    </section>}

    {modal && (modal === 'leave' || canManage) && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeModal()}>
      <section ref={modalRef} className="modal-card people-modal" role="dialog" aria-modal="true" aria-labelledby="people-modal-title" tabIndex={-1}>
        <header><div><span className="eyebrow">{modal === 'leave' ? 'LEAVE REQUEST' : modal === 'adjust' ? 'LEAVE LEDGER' : modal === 'profile' ? 'MEMBER PROFILE' : modal === 'credential' ? 'ONE-TIME CREDENTIAL' : 'INVITE MEMBER'}</span><h2 id="people-modal-title">{modal === 'leave' ? '휴가 신청' : modal === 'adjust' ? '휴가 부여 · 차감' : modal === 'profile' ? `${selectedProfile?.name ?? '구성원'} 프로필` : modal === 'credential' ? '초기 비밀번호 전달' : '새 구성원 초대'}</h2><p>{modal === 'leave' ? '결재 승인 후 근무표와 휴가 사용량에 반영됩니다.' : modal === 'adjust' ? '직원별 휴가 총량을 조정하고 원장에 사유를 남깁니다.' : modal === 'profile' ? '소속, 접근 권한, 근무 상태와 휴가 현황을 한곳에서 확인합니다.' : modal === 'credential' ? '이 화면을 닫으면 초기 비밀번호를 다시 확인할 수 없습니다.' : '가입 후 관리자가 소속과 권한을 최종 승인합니다.'}</p></div><button className="icon-button" type="button" aria-label="닫기" onClick={closeModal}><X size={21} /></button></header>
        {modal === 'leave' ? <form onSubmit={submitLeave}>
          <div className="form-grid"><label className="form-field"><span>휴가 유형</span><select name="type" value={leaveType} data-autofocus onChange={(event) => { const next = event.target.value; setLeaveType(next); if (next === '반차') setLeaveEndDate(leaveStartDate) }}><option>연차</option><option>반차</option><option>공가</option><option>병가</option><option>경조휴가</option><option>기타</option></select></label><label className="form-field"><span>결재자</span><select name="approverId" required value={leaveApproverId} onChange={(event) => setLeaveApproverId(event.target.value)}><option value="" disabled>{leaveApprovers.length ? '결재자 선택' : '결재자 불러오는 중…'}</option>{leaveApprovers.map((approver) => <option value={approver.id} key={approver.id}>{approver.name} · {approver.team}</option>)}</select></label></div>
          <div className="form-grid"><label className="form-field"><span>시작일</span><input type="date" value={leaveStartDate} required onChange={(event) => { const next = event.target.value; setLeaveStartDate(next); if (leaveType === '반차' || leaveEndDate < next) setLeaveEndDate(next) }} /></label><label className="form-field"><span>종료일</span><input type="date" value={leaveType === '반차' ? leaveStartDate : leaveEndDate} min={leaveStartDate} disabled={leaveType === '반차'} required onChange={(event) => setLeaveEndDate(event.target.value)} /></label></div>
          <div className={`leave-duration-preview${calculateLeaveDays(leaveStartDate, leaveEndDate, leaveType) <= 0 ? ' invalid' : ''}`} role="status"><CalendarDays size={19} /><div><strong>사용 일수 {calculateLeaveDays(leaveStartDate, leaveEndDate, leaveType).toFixed(1)}일</strong><span>{leaveType === '반차' ? '반차는 선택한 날짜의 0.5일로 계산됩니다.' : '시작일과 종료일 사이의 주말을 제외해 자동 계산합니다.'}</span></div><em>잔여 {myRemaining.toFixed(1)}일</em></div>
          <label className="form-field full"><span>사유</span><textarea name="reason" rows={3} placeholder="결재자가 확인할 수 있도록 간단히 입력하세요." required /></label>
          <footer><button type="button" className="button ghost" onClick={closeModal}>취소</button><button type="submit" className="button primary" disabled={isSubmittingLeave || leaveApprovers.length === 0 || calculateLeaveDays(leaveStartDate, leaveEndDate, leaveType) <= 0}><CheckCircle2 size={18} /> {isSubmittingLeave ? '요청 중…' : '결재 요청'}</button></footer>
        </form> : modal === 'adjust' ? <form onSubmit={submitAdjustment}>
          <div className="form-grid"><label className="form-field"><span>대상 직원</span><input name="employee" list="leave-employee-options" placeholder="이름 입력 또는 선택" data-autofocus required /><datalist id="leave-employee-options">{Array.from(new Set([currentUserName, ...leaveManagement.balances.map((balance) => balance.name), ...directoryMembers.map((member) => member.name), ...managedAccounts.map((account) => account.name)])).map((name) => <option value={name} key={name} />)}</datalist></label><label className="form-field"><span>소속</span><input name="team" defaultValue={currentUserTeam} placeholder="예: 생산 1팀" required /></label></div>
          <div className="form-grid"><label className="form-field"><span>조정 유형</span><select name="action"><option value="grant">휴가 부여</option><option value="deduct">휴가 차감</option></select></label><label className="form-field"><span>조정 일수</span><input name="days" type="number" min="0.5" step="0.5" defaultValue="1" required /></label></div>
          <label className="form-field full"><span>조정 사유</span><textarea name="memo" rows={3} placeholder="예: 장기근속 특별 연차, 오등록 정정" required /></label>
          <div className="modal-note secure"><History size={18} /><p><strong>저장 후 휴가 원장에 영구 이력이 남습니다.</strong><span>차감은 현재 잔여 휴가보다 크게 적용되지 않습니다.</span></p></div>
          <footer><button type="button" className="button ghost" onClick={closeModal}>취소</button><button type="submit" className="button primary"><CheckCircle2 size={18} /> 조정 저장</button></footer>
        </form> : modal === 'profile' && selectedProfile ? <div className="people-profile-detail">
          <section className="people-profile-identity"><span className="person-avatar large">{selectedProfile.name.slice(0, 1)}</span><div><strong>{selectedProfile.name}</strong><p>{selectedProfile.role} · {selectedProfile.team}</p><small>{selectedProfile.email ?? selectedProfileAccountId ?? '로그인 계정 미연결'}</small></div><StateBadge tone={selectedProfile.attendance === '근무중' || selectedProfile.attendance === '현재 로그인' ? 'good' : 'neutral'}>{selectedProfile.attendance}</StateBadge></section>
          <div className="people-profile-grid"><article><small>현재 업무</small><strong>{selectedProfile.work}</strong></article><article><small>접근 권한</small><strong>{selectedProfile.permission}</strong></article><article><small>휴가 총량</small><strong>{selectedProfileBalance ? `${selectedProfileBalance.total.toFixed(1)}일` : '미등록'}</strong></article><article><small>남은 휴가</small><strong>{selectedProfileBalance ? `${Math.max(0, selectedProfileBalance.total - selectedProfileBalance.used).toFixed(1)}일` : '미등록'}</strong></article></div>
          <section className="people-profile-leaves"><div className="people-subsection-head"><div><h3>최근 휴가 신청</h3><p>결재 상태까지 포함한 최근 3건입니다.</p></div><strong>{selectedProfileLeaves.length}건</strong></div>{selectedProfileLeaves.length ? selectedProfileLeaves.slice(0, 3).map((leave) => <article key={leave.id}><div><strong>{leave.type} · {leave.period}</strong><small>{leave.reason} · {leave.days}일</small></div><StateBadge tone={leave.status === '승인' ? 'good' : leave.status === '반려' ? 'danger' : 'warning'}>{leave.status}</StateBadge></article>) : <div className="people-profile-empty">휴가 신청 이력이 없습니다.</div>}</section>
          <div className="modal-note secure"><ShieldCheck size={18} /><p><strong>표시 데이터 범위</strong><span>이 화면은 ERP 계정·휴가 원장·업무 요약을 조합합니다. 외부 근태 단말 정보는 연동 전까지 표시하지 않습니다.</span></p></div>
          <footer><button type="button" className="button primary" onClick={closeModal}>확인</button></footer>
        </div> : modal === 'credential' && issuedCredential ? <div className="people-credential-panel">
          <div className="credential-warning"><AlertTriangle size={19} /><div><strong>직원에게 안전한 사내 채널로 전달하세요.</strong><span>서버에는 원문이 저장되지 않으며 재확인이 필요하면 새로 발급해야 합니다.</span></div></div>
          <label><span>로그인 이메일</span><strong>{issuedCredential.email}</strong></label>
          <label><span>1회용 초기 비밀번호</span><div className="credential-code"><code>{issuedCredential.temporaryPassword}</code><button type="button" onClick={() => { void navigator.clipboard.writeText(issuedCredential.temporaryPassword).then(() => onToast('초기 비밀번호를 클립보드에 복사했습니다.')).catch(() => onToast('자동 복사에 실패했습니다. 화면의 비밀번호를 직접 복사해 주세요.')) }}><Copy size={17} /> 복사</button></div></label>
          <p><Clock3 size={17} /> {formatDateTime(issuedCredential.expiresAt)}까지 유효 · 첫 로그인 후 즉시 폐기</p>
          <footer><button type="button" className="button primary" onClick={closeModal}>전달 완료</button></footer>
        </div> : <form onSubmit={submitInvite}>
          <div className="form-grid"><label className="form-field"><span>이름</span><input name="name" type="text" placeholder="예: 이하늘" minLength={2} maxLength={40} data-autofocus required /></label><label className="form-field"><span>회사 이메일</span><input name="email" type="email" placeholder="name@company.co.kr" required /></label></div>
          <div className="form-grid"><label className="form-field"><span>소속</span><select name="team"><option>생산 1팀</option><option>품질관리</option><option>물류팀</option><option>판매운영</option><option>경영지원</option></select></label><label className="form-field"><span>직무 권한</span><select name="role"><option>생산 작업자</option><option>품질 담당</option><option>재고 담당</option><option>판매 담당</option><option>일반 사용자</option></select></label></div>
          <div className="modal-note secure"><ShieldCheck size={18} /><p><strong>승인 전에는 업무 데이터에 접근할 수 없습니다.</strong><span>승인 시 72시간 유효한 초기 비밀번호가 한 번 표시되고, 직원은 첫 로그인에서 직접 변경합니다.</span></p></div>
          <footer><button type="button" className="button ghost" onClick={closeModal}>취소</button><button type="submit" className="button primary" disabled={isInviting}><Send size={18} /> {isInviting ? '생성 중…' : '계정 생성'}</button></footer>
        </form>}
      </section>
    </div>}
  </div>
}

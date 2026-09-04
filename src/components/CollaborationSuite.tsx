import {
  AlertCircle,
  ArrowLeft,
  BookOpenCheck,
  Building2,
  CalendarDays,
  Camera,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  Edit3,
  FileText,
  Hash,
  MapPin,
  MessageCircle,
  LogOut,
  MoreHorizontal,
  Paperclip,
  Plus,
  Save,
  Search,
  Send,
  ShieldCheck,
  Trash2,
  Upload,
  UserPlus,
  UserRound,
  Users,
  WandSparkles,
  Bell,
  BellOff,
  CornerUpLeft,
  Pin,
  PinOff,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent, ReactNode } from 'react'
import { useWorkspaceState } from '../hooks/useWorkspaceState'
import { formatDateLabel, formatDateTime, formatShortDateTime, formatYearMonthLabel, seoulDateInputValue } from '../utils/dateTime'
import { dayKind, holidayName, type DayKind } from '../utils/koreanHolidays'
import {
  canApplyGeneratedJournalDraft,
  canApplyJournalAutosaveToEditor,
  canFlushJournalDraftOnExit,
  nextJournalRevisionAfterConflict,
} from '../utils/journalAutosaveRevision'
import {
  deleteDocumentAttachment,
  deleteDocumentAttachments,
  downloadDocumentAttachment,
  isStoredDocumentAttachment,
  type StoredDocumentAttachment,
  uploadDocumentAttachments,
} from '../utils/documentAttachments'
import './CollaborationSuite.css'
import { Button, IconButton } from './ui/Button'
import { GroupRoomDialog, MentionSuggestions, MessageActionBar, QuotedMessage, ReactionRow, RoomSearchPanel } from './MessengerExtras'
import { useIndustrySurface } from '../modules/IndustryContext'
import { useEventStream } from '../hooks/useEventStream'


type ToastHandler = (message: string) => void

type OverlayProps = {
  open?: boolean
  onClose: () => void
  onToast: ToastHandler
  onUnreadChange?: (count: number) => void
}

type CurrentUserProps = {
  currentUserId: string
  currentUserName: string
  currentUserTeam: string
  canManage: boolean
  workspaceScope?: string
}

type MessengerDrawerProps = OverlayProps & CurrentUserProps

type PageProps = CurrentUserProps & {
  onToast: ToastHandler
}

function useOverlayFocus(open: boolean, onClose: () => void) {
  const overlayRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) return

    const overlay = overlayRef.current
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const bodyAlreadyLocked = document.body.classList.contains('no-scroll')
    document.body.classList.add('no-scroll')

    const selector = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    const focusInitial = window.setTimeout(() => {
      const autofocus = overlay?.querySelector<HTMLElement>('[data-autofocus]')
      const first = overlay?.querySelector<HTMLElement>(selector)
      ;(autofocus ?? first)?.focus()
    }, 0)

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab' || !overlay) return
      const focusables = Array.from(overlay.querySelectorAll<HTMLElement>(selector))
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.clearTimeout(focusInitial)
      document.removeEventListener('keydown', handleKeyDown)
      if (!bodyAlreadyLocked) document.body.classList.remove('no-scroll')
      previousFocus?.focus()
    }
  }, [open])

  return overlayRef
}

function Avatar({ name, status, compact = false }: { name: string; status?: 'online' | 'away' | 'offline'; compact?: boolean }) {
  return (
    <span className={'collab-avatar' + (compact ? ' compact' : '')} aria-hidden="true">
      {name.slice(0, 1)}
      {status && <i className={'collab-presence ' + status} />}
    </span>
  )
}

function StatusChip({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'green' | 'blue' | 'amber' | 'red' }) {
  return <span className={'collab-status-chip ' + tone}>{children}</span>
}

function CollabPageHeader({
  kicker,
  title,
  description,
  actions,
}: {
  kicker: string
  title: string
  description: string
  actions?: ReactNode
}) {
  return (
    <header className="collab-page-header">
      <div>
        <span className="collab-kicker">{kicker}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions && <div className="collab-page-actions">{actions}</div>}
    </header>
  )
}

type Person = {
  id: string
  accountId?: string
  name: string
  team: string
  role: string
  status: 'online' | 'away' | 'offline'
  system?: boolean
  /** 비활성(퇴사) 계정. 기록은 남기되 새 대화 상대로는 고르지 않는다. */
  active?: boolean
}

type ChatMessage = {
  id: string
  senderId: string
  senderName: string
  text: string
  time: string
  readBy?: string[]
  createdAt?: string
  attachments?: StoredDocumentAttachment[]
  replyTo?: string
  reactions?: { emoji: string; by: string[] }[]
  editedAt?: string
  deletedAt?: string
  deletedBy?: string
}

type Conversation = {
  id: string
  type: 'team' | 'direct'
  name: string
  subtitle: string
  memberId?: string
  participantIds?: string[]
  unread: number
  lastMessage: string
  lastTime: string
  messages: ChatMessage[]
  hiddenFor?: string[]
  lineageId?: string
  generation?: number
  lifecycle?: 'active' | 'closed' | 'deleted'
  closedAt?: string
  deletedAt?: string
  systemChannel?: 'developer-support'
  supportRequesterId?: string
  supportTicketId?: string
  /** 자유 생성 그룹방. 이 표시가 있어야 이름 변경·초대·방장 위임이 열린다. */
  kind?: 'group'
  icon?: string
  ownerId?: string
  createdBy?: string
  createdAt?: string
  pinnedMessageIds?: string[]
  mutedFor?: string[]
}

type MessengerListMode = 'recent' | 'teams' | 'people'

/**
 * 한 번에 그리는 메시지 수. 방 하나에 5,000건까지 쌓일 수 있어 전부 그리면 화면이 멈춘다.
 * 위로 올라가면 이만큼씩 더 편다.
 */
const MESSAGE_WINDOW = 60

function legacyParticipantIds(conversation: Conversation): string[] {
  if (Array.isArray(conversation.participantIds) && conversation.participantIds.length > 0) return conversation.participantIds
  if (conversation.type === 'direct' && conversation.memberId) return [conversation.memberId]
  return []
}

export function MessengerDrawer({
  open = true,
  onClose,
  onToast,
  onUnreadChange,
  currentUserId,
  currentUserName,
  currentUserTeam,
  canManage,
  workspaceScope,
}: MessengerDrawerProps) {
  const overlayRef = useOverlayFocus(open, onClose)
  const [conversations, setConversations] = useWorkspaceState<Conversation[]>('messenger-conversations', [], { scope: workspaceScope, seedWhenEmpty: false })
  const [directory, setDirectory] = useState<Person[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [query, setQuery] = useState('')
  const [message, setMessage] = useState('')
  const [messageSending, setMessageSending] = useState(false)
  const [attachmentUploading, setAttachmentUploading] = useState(false)
  const [pendingAttachments, setPendingAttachments] = useState<Record<string, StoredDocumentAttachment[]>>({})
  const attachmentInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const [listMode, setListMode] = useState<MessengerListMode>('recent')
  const [mobilePane, setMobilePane] = useState<'list' | 'chat'>('list')
  const [showConversationMenu, setShowConversationMenu] = useState(false)
  const [conversationAction, setConversationAction] = useState<'leave' | 'delete' | null>(null)
  const [conversationActionPending, setConversationActionPending] = useState(false)
  const messageEndRef = useRef<HTMLDivElement>(null)
  // ── A절 확장 ──
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null)
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [roomSearchOpen, setRoomSearchOpen] = useState(false)
  const [roomSearchQuery, setRoomSearchQuery] = useState('')
  const [groupDialog, setGroupDialog] = useState<'create' | 'manage' | null>(null)
  const [groupPending, setGroupPending] = useState(false)
  const [mentionState, setMentionState] = useState<{ query: string; index: number } | null>(null)
  // 방이 길어지면 전부 그리지 않는다. 위로 올라가면 한 페이지씩 더 편다.
  const [visibleCount, setVisibleCount] = useState(MESSAGE_WINDOW)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const messageRefs = useRef<Record<string, HTMLElement | null>>({})

  const directoryIdentity = directory.find((person) => person.accountId === currentUserId || person.id === currentUserId)
    ?? directory.find((person) => person.name === currentUserName && sameDepartment(person.team, currentUserTeam))
    ?? directory.find((person) => person.name === currentUserName)
  const currentIdentityIds = Array.from(new Set([currentUserId, directoryIdentity?.id, directoryIdentity?.accountId].filter((value): value is string => Boolean(value))))
  const conversationPeer = (conversation: Conversation) => {
    if (conversation.type !== 'direct') return undefined
    const otherId = legacyParticipantIds(conversation).find((participantId) => !currentIdentityIds.includes(participantId))
    return directory.find((person) => person.id === otherId || person.accountId === otherId)
  }
  const conversationName = (conversation: Conversation) => conversationPeer(conversation)?.name ?? conversation.name
  const conversationSubtitle = (conversation: Conversation) => {
    const peer = conversationPeer(conversation)
    return peer ? `${peer.team} · ${peer.role}` : conversation.subtitle
  }
  const myConversations = conversations.filter((item) => {
    if (item.lifecycle && item.lifecycle !== 'active') return false
    if (item.hiddenFor?.some((participantId) => currentIdentityIds.includes(participantId))) return false
    if (item.type === 'team' && (!item.participantIds || item.participantIds.length === 0)) return true
    return legacyParticipantIds(item).some((participantId) => currentIdentityIds.includes(participantId))
  })
  const activeConversation = myConversations.find((item) => item.id === selectedId) ?? myConversations[0]
  const activePendingAttachments = activeConversation ? pendingAttachments[activeConversation.id] ?? [] : []
  const selectedConversation: Conversation = activeConversation ?? {
    id: '',
    type: 'direct',
    name: '대화를 선택하세요',
    subtitle: currentUserTeam + ' · ' + (canManage ? '관리자' : '직원'),
    participantIds: [currentUserId],
    unread: 0,
    lastMessage: '',
    lastTime: '',
    messages: [],
  }
  const unreadForConversation = (conversation: Conversation) => {
    const hasReceipts = conversation.messages.some((item) => Array.isArray(item.readBy))
    if (!hasReceipts) return conversation.unread
    return conversation.messages.filter((item) => {
      const mine = currentIdentityIds.includes(item.senderId) || item.senderId === 'me'
      return !mine && !item.readBy?.some((readerId) => currentIdentityIds.includes(readerId))
    }).length
  }
  const unreadTotal = myConversations.reduce((sum, item) => sum + unreadForConversation(item), 0)
  const normalizedQuery = query.trim().toLowerCase()

  /**
   * 내가 보낸 메시지를 몇 명이 읽었는가.
   * 1:1은 읽음/안 읽음으로 충분하지만 여러 명인 방에서는 그 표기가 늘 "안 읽음"으로 굳는다.
   * 인원이 많은 방에서 "누가 안 읽었나"까지 펼치면 그 자체가 압박이 되므로 수만 센다.
   */
  const readCountFor = (item: ChatMessage) => {
    const others = (item.readBy ?? []).filter((readerId) => !currentIdentityIds.includes(readerId))
    if (selectedConversation.type === 'direct') return others.length > 0 ? '읽음' : '안 읽음'
    return others.length > 0 ? `${others.length}명 읽음` : '안 읽음'
  }

  const roomMuted = (selectedConversation.mutedFor ?? []).some((id) => currentIdentityIds.includes(id))

  const pinnedMessages = (selectedConversation.pinnedMessageIds ?? [])
    .map((id) => selectedConversation.messages.find((item) => item.id === id))
    .filter((item): item is ChatMessage => Boolean(item) && !item!.deletedAt)

  const visibleMessages = selectedConversation.messages.slice(Math.max(0, selectedConversation.messages.length - visibleCount))
  const hiddenMessageCount = Math.max(0, selectedConversation.messages.length - visibleMessages.length)

  const roomSearchMatches = roomSearchQuery.trim().length >= 2
    ? selectedConversation.messages
      .filter((item) => !item.deletedAt && item.text.toLowerCase().includes(roomSearchQuery.trim().toLowerCase()))
      .slice(-100)
      .reverse()
    : []

  /** 방에 있는 사람 중 @로 부를 수 있는 후보. 비활성 계정은 부르지 않는다. */
  const mentionCandidates = mentionState
    ? directory
      .filter((person) => !person.system && person.active !== false && person.id !== currentUserId)
      .filter((person) => !mentionState.query || person.name.toLowerCase().includes(mentionState.query.toLowerCase()))
      .slice(0, 6)
    : []

  const jumpToMessage = (messageId: string) => {
    // 창 밖에 있으면 먼저 그 지점까지 펼친다. 안 그러면 눌러도 아무 일도 안 일어난다.
    const index = selectedConversation.messages.findIndex((item) => item.id === messageId)
    if (index >= 0) {
      const needed = selectedConversation.messages.length - index
      if (needed > visibleCount) setVisibleCount(needed + 10)
    }
    setRoomSearchOpen(false)
    window.setTimeout(() => {
      const node = messageRefs.current[messageId]
      node?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      node?.classList.add('is-jumped')
      window.setTimeout(() => node?.classList.remove('is-jumped'), 1_600)
    }, 60)
  }

  const filteredConversations = myConversations.filter((item) => {
    if (listMode === 'teams' && item.type !== 'team') return false
    if (listMode === 'people' && item.type !== 'direct') return false
    if (!normalizedQuery) return true
    return (conversationName(item) + ' ' + conversationSubtitle(item) + ' ' + item.lastMessage).toLowerCase().includes(normalizedQuery)
  })

  const filteredPeople = directory.filter((person) => {
    if (person.id === currentUserId || person.accountId === currentUserId || person.name === currentUserName) return false
    if (!normalizedQuery) return true
    return (person.name + ' ' + person.team + ' ' + person.role).toLowerCase().includes(normalizedQuery)
  })

  useEffect(() => {
    if (!open) return
    messageEndRef.current?.scrollIntoView({ block: 'nearest' })
  }, [open, selectedId, selectedConversation?.messages.length])

  useEffect(() => {
    if (!open) return
    let active = true
    fetch('/api/directory')
      .then(async (response) => {
        if (!response.ok) throw new Error('directory-load')
        return response.json() as Promise<{ members?: Array<{ id: string; name: string; team: string; role: string; status: Person['status']; system?: boolean }> }>
      })
      .then(({ members }) => {
        if (!active || !Array.isArray(members)) return
        setDirectory(members.map((member) => ({ ...member, accountId: member.id })))
      })
      .catch(() => undefined)
    return () => { active = false }
  }, [open])

  const messengerRefreshRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    if (!open) return
    let active = true
    const refresh = () => {
      fetch('/api/workspace/messenger-conversations', {
        headers: workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error('messenger-refresh')
          return response.json() as Promise<{ data?: Conversation[] }>
        })
        .then(({ data }) => {
          if (active && Array.isArray(data)) void setConversations(data, { persist: false })
        })
        .catch(() => undefined)
    }
    refresh()
    // 5초 폴링을 서버 이벤트 스트림으로 대체했다. 새 메시지가 있을 때만 다시 읽는다.
    messengerRefreshRef.current = refresh
    return () => { active = false; messengerRefreshRef.current = null }
  }, [open, setConversations, workspaceScope])

  useEventStream(open, (event) => {
    if (event.kind === 'message' || event.kind === 'resync') messengerRefreshRef.current?.()
  })

  useEffect(() => {
    onUnreadChange?.(unreadTotal)
  }, [onUnreadChange, unreadTotal])

  useEffect(() => {
    if (activeConversation || myConversations.length === 0) return
    setSelectedId(myConversations[0].id)
  }, [activeConversation, myConversations])

  if (!open) return null

  const replaceConversationLocally = (next: Conversation) => setConversations((current) => {
    const exists = current.some((item) => item.id === next.id)
    return exists ? current.map((item) => item.id === next.id ? next : item) : [next, ...current]
  }, { persist: false })

  const chooseConversation = async (id: string) => {
    if (!myConversations.some((item) => item.id === id)) return
    setSelectedId(id)
    setShowConversationMenu(false)
    setMobilePane('chat')
    try {
      const response = await fetch(`/api/messenger/conversations/${encodeURIComponent(id)}/read`, {
        method: 'POST',
        headers: workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined,
      })
      if (!response.ok) return
      const body = await response.json() as { conversation?: Conversation }
      if (body.conversation) await replaceConversationLocally(body.conversation)
    } catch { /* cached conversations stay readable while the API is offline */ }
  }

  const startDirectConversation = async (person: Person) => {
    try {
      const response = await fetch('/api/messenger/conversations/direct', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}),
        },
        body: JSON.stringify({ participantId: person.accountId ?? person.id }),
      })
      const body = await response.json().catch(() => null) as { conversation?: Conversation; created?: boolean; closedConversationIds?: string[]; error?: { message?: string } } | null
      if (!response.ok || !body?.conversation) {
        onToast(body?.error?.message ?? '새 대화를 시작하지 못했습니다.')
        return
      }
      const closedIds = new Set(body.closedConversationIds ?? [])
      await setConversations((current) => {
        const remaining = current.filter((item) => !closedIds.has(item.id) && item.id !== body.conversation!.id)
        return [body.conversation!, ...remaining]
      }, { persist: false })
      setSelectedId(body.conversation.id)
      setListMode('recent')
      setQuery('')
      setMobilePane('chat')
      onToast(body.created ? person.name + '님과 새 대화를 시작했습니다.' : person.name + '님과 진행 중인 대화를 열었습니다.')
    } catch {
      onToast('메신저 서버에 연결하지 못했습니다.')
    }
  }

  const sendMessage = async (event: FormEvent) => {
    event.preventDefault()
    const text = message.trim()
    if (!text || !activeConversation || messageSending || attachmentUploading) return
    setMessageSending(true)
    try {
      const response = await fetch(`/api/messenger/conversations/${encodeURIComponent(activeConversation.id)}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}),
        },
        body: JSON.stringify({ text, attachments: activePendingAttachments, ...(replyTo ? { replyTo: replyTo.id } : {}) }),
      })
      const body = await response.json().catch(() => null) as { conversation?: Conversation; error?: { message?: string } } | null
      if (!response.ok || !body?.conversation) {
        onToast(body?.error?.message ?? '메시지를 보내지 못했습니다.')
        return
      }
      await replaceConversationLocally(body.conversation)
      setMessage('')
      setReplyTo(null)
      setMentionState(null)
      setPendingAttachments((current) => {
        const next = { ...current }
        delete next[activeConversation.id]
        return next
      })
    } catch {
      onToast('메신저 서버에 연결하지 못해 메시지를 보내지 않았습니다.')
    } finally {
      setMessageSending(false)
    }
  }

  /** 메신저 전용 라우트 호출. 성공하면 서버가 돌려준 대화로 화면을 맞춘다. */
  const callRoom = async (path: string, init: RequestInit, failure: string) => {
    try {
      const response = await fetch(`/api/messenger/conversations/${encodeURIComponent(activeConversation?.id ?? '')}${path}`, {
        ...init,
        headers: {
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}),
        },
      })
      const body = await response.json().catch(() => null) as { conversation?: Conversation; error?: { message?: string } } | null
      if (!response.ok) {
        onToast(body?.error?.message ?? failure)
        return null
      }
      if (body?.conversation) await replaceConversationLocally(body.conversation)
      else messengerRefreshRef.current?.()
      return body
    } catch {
      onToast('메신저 서버에 연결하지 못했습니다.')
      return null
    }
  }

  const toggleReaction = (messageId: string, emoji: string) =>
    void callRoom(`/messages/${encodeURIComponent(messageId)}/reactions`, { method: 'POST', body: JSON.stringify({ emoji }) }, '반응을 남기지 못했습니다.')

  const togglePin = (messageId: string, pinned: boolean) =>
    void callRoom(`/messages/${encodeURIComponent(messageId)}/pin`, { method: 'POST', body: JSON.stringify({ pinned }) }, '고정을 바꾸지 못했습니다.')
      .then((body) => { if (body) onToast(pinned ? '공지로 고정했습니다.' : '고정을 해제했습니다.') })

  const removeMessage = (messageId: string) =>
    void callRoom(`/messages/${encodeURIComponent(messageId)}`, { method: 'DELETE' }, '메시지를 삭제하지 못했습니다.')
      .then((body) => { if (body) onToast('메시지를 삭제했습니다. 자리는 "삭제된 메시지"로 남습니다.') })

  const submitEdit = async () => {
    if (!editing?.text.trim()) return
    const body = await callRoom(`/messages/${encodeURIComponent(editing.id)}`, { method: 'PATCH', body: JSON.stringify({ text: editing.text.trim() }) }, '메시지를 수정하지 못했습니다.')
    if (body) { setEditing(null); onToast('메시지를 수정했습니다.') }
  }

  const createGroupRoom = async (payload: { name: string; icon: string; participantIds: string[] }) => {
    setGroupPending(true)
    try {
      const response = await fetch('/api/messenger/conversations/group', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}) },
        body: JSON.stringify(payload),
      })
      const body = await response.json().catch(() => null) as { conversation?: Conversation; error?: { message?: string } } | null
      if (!response.ok || !body?.conversation) {
        onToast(body?.error?.message ?? '대화방을 만들지 못했습니다.')
        return
      }
      await replaceConversationLocally(body.conversation)
      setSelectedId(body.conversation.id)
      setListMode('recent')
      setGroupDialog(null)
      setMobilePane('chat')
      onToast(`"${body.conversation.name}" 방을 만들었습니다.`)
    } catch {
      onToast('메신저 서버에 연결하지 못했습니다.')
    } finally {
      setGroupPending(false)
    }
  }

  const performConversationAction = async () => {
    if (!activeConversation || !conversationAction || conversationActionPending) return
    const action = conversationAction
    const directConversation = activeConversation.type === 'direct'
    setConversationActionPending(true)
    try {
      const response = await fetch(`/api/messenger/conversations/${encodeURIComponent(activeConversation.id)}${action === 'leave' ? '/leave' : ''}`, {
        method: action === 'leave' ? 'POST' : 'DELETE',
        headers: workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined,
      })
      const body = await response.json().catch(() => null) as { error?: { message?: string } } | null
      if (!response.ok) {
        onToast(body?.error?.message ?? (action === 'leave' ? '대화방에서 나가지 못했습니다.' : '대화방을 삭제하지 못했습니다.'))
        return
      }
      const removedId = activeConversation.id
      await setConversations((current) => action === 'delete'
        ? current.filter((item) => item.id !== removedId)
        : current.map((item) => item.id === removedId
          ? { ...item, hiddenFor: [...new Set([...(item.hiddenFor ?? []), currentUserId])] }
          : item), { persist: false })
      const remaining = myConversations.filter((item) => item.id !== removedId)
      setSelectedId(remaining[0]?.id ?? '')
      setMobilePane('list')
      setConversationAction(null)
      setShowConversationMenu(false)
      onToast(action === 'leave'
        ? directConversation ? '대화방에서 나갔습니다. 다시 대화하면 이전 기록과 분리된 새 방이 열립니다.' : '팀 대화방에서 나갔습니다. 다시 참여하려면 관리자에게 초대를 요청해 주세요.'
        : '대화방과 대화 기록을 삭제했습니다.')
    } catch {
      onToast('메신저 서버에 연결하지 못했습니다.')
    } finally {
      setConversationActionPending(false)
    }
  }

  const chooseAttachment = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (!files.length || !activeConversation || attachmentUploading) return
    if (activePendingAttachments.length + files.length > 10) { onToast('한 메시지에는 파일을 최대 10개까지 첨부할 수 있습니다.'); return }
    setAttachmentUploading(true)
    try {
      const additions = await uploadDocumentAttachments(files, {
        workspaceScope,
        category: activeConversation.systemChannel === 'developer-support' ? '개발운영지원' : '사내메신저',
        summary: `${conversationName(activeConversation)} 대화 첨부`,
        tags: [activeConversation.systemChannel ?? 'messenger', `conversation:${activeConversation.id}`],
      })
      setPendingAttachments((current) => ({
        ...current,
        [activeConversation.id]: [...(current[activeConversation.id] ?? []), ...additions],
      }))
      onToast(`${additions.length}개 파일을 안전하게 업로드했습니다. 메시지를 보내면 대화에 연결됩니다.`)
    } catch (reason) {
      onToast(reason instanceof Error ? reason.message : '첨부파일을 업로드하지 못했습니다.')
    } finally {
      setAttachmentUploading(false)
    }
  }

  const removePendingAttachment = async (attachment: StoredDocumentAttachment) => {
    if (!activeConversation || attachmentUploading) return
    setAttachmentUploading(true)
    try {
      await deleteDocumentAttachment(attachment.id, workspaceScope)
      setPendingAttachments((current) => ({
        ...current,
        [activeConversation.id]: (current[activeConversation.id] ?? []).filter((item) => item.id !== attachment.id),
      }))
    } catch (reason) {
      onToast(reason instanceof Error ? reason.message : '첨부파일을 제거하지 못했습니다.')
    } finally {
      setAttachmentUploading(false)
    }
  }

  return (
    <div className="collab-overlay messenger-overlay">
      <button className="collab-overlay-backdrop" type="button" aria-label="메신저 닫기" onClick={onClose} />
      <div
        id="company-messenger"
        ref={overlayRef}
        className={'messenger-drawer ' + (mobilePane === 'list' ? 'show-list' : 'show-chat')}
        role="dialog"
        aria-modal="true"
        aria-labelledby="messenger-title"
      >
        <header className="messenger-header">
          <div>
            <span className="collab-kicker">INTERNAL MESSENGER</span>
            <h2 id="messenger-title">사내 메신저</h2>
          </div>
          <div className="messenger-header-actions">
            <span className="messenger-unread-summary">{currentUserTeam} · {canManage ? '관리자' : '직원'} · 읽지 않음 {unreadTotal}개</span>
            <button type="button" aria-label="메신저 닫기" onClick={onClose}><X size={22} /></button>
          </div>
        </header>

        <div className="messenger-layout">
          <aside className="messenger-sidebar" aria-label="대화 목록">
            <div className="messenger-sidebar-tools">
              <Button tone="primary" full
                type="button"
                onClick={() => { setListMode('people'); setQuery('') }}
              >
                <UserPlus size={18} /> 새 대화
              </Button>
              <label className="collab-search messenger-search">
                <Search size={18} aria-hidden="true" />
                <span className="sr-only">대화 또는 직원 검색</span>
                <input
                  data-autofocus
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="대화·팀·직원 검색"
                />
              </label>
            </div>

            <div className="messenger-list-tabs" role="tablist" aria-label="대화 목록 구분">
              <button type="button" role="tab" aria-selected={listMode === 'recent'} onClick={() => setListMode('recent')}>최근</button>
              <button type="button" role="tab" aria-selected={listMode === 'teams'} onClick={() => setListMode('teams')}>팀</button>
              <button type="button" role="tab" aria-selected={listMode === 'people'} onClick={() => setListMode('people')}>직원</button>
            </div>

            <div className="messenger-conversation-list">
              {listMode === 'people' ? (
                <>
                  <div className="messenger-list-label">직원 {filteredPeople.length}명</div>
                  {filteredPeople.map((person) => (
                    <button className="messenger-person-row" type="button" onClick={() => startDirectConversation(person)} key={person.id}>
                      <Avatar name={person.name} status={person.status} />
                      <span><strong>{person.name}{person.system && <em className="messenger-system-label">공식 지원</em>}</strong><small>{person.team} · {person.role}</small></span>
                      <MessageCircle size={18} aria-hidden="true" />
                    </button>
                  ))}
                </>
              ) : (
                <>
                  <div className="messenger-list-label">
                    <span>{listMode === 'teams' ? '팀 대화' : '최근 대화'} {filteredConversations.length}개</span>
                    <Button tone="quiet" size="sm" onClick={() => setGroupDialog('create')}><Plus size={15} /> 새 그룹방</Button>
                  </div>
                  {filteredConversations.map((conversation) => (
                    <button
                      className={'messenger-conversation-row' + (conversation.id === selectedId ? ' active' : '')}
                      type="button"
                      aria-current={conversation.id === selectedId ? 'true' : undefined}
                      onClick={() => chooseConversation(conversation.id)}
                      key={conversation.id}
                    >
                      {conversation.type === 'team'
                        ? <span className="messenger-team-icon"><Hash size={20} /></span>
                        : <Avatar name={conversationName(conversation)} status={conversationPeer(conversation)?.status} />}
                      <span className="messenger-conversation-copy">
                        <span><strong>{conversationName(conversation)}</strong><time>{conversation.lastTime}</time></span>
                        <small>{conversation.lastMessage}</small>
                      </span>
                      {unreadForConversation(conversation) > 0 && <em aria-label={'읽지 않은 메시지 ' + unreadForConversation(conversation) + '개'}>{unreadForConversation(conversation)}</em>}
                    </button>
                  ))}
                </>
              )}
              {(listMode === 'people' ? filteredPeople.length === 0 : filteredConversations.length === 0) && (
                <div className="collab-empty compact"><Search size={26} /><strong>검색 결과가 없습니다</strong><span>다른 이름이나 팀을 검색해 보세요.</span></div>
              )}
            </div>
          </aside>

          <section className="messenger-chat" aria-label={conversationName(selectedConversation) + ' 대화'}>
            <header className="messenger-chat-header">
              <button className="messenger-back-button" type="button" aria-label="대화 목록으로" onClick={() => setMobilePane('list')}>
                <ArrowLeft size={21} />
              </button>
              {selectedConversation.type === 'team'
                ? <span className="messenger-team-icon"><Hash size={20} /></span>
                : <Avatar name={conversationName(selectedConversation)} status={conversationPeer(selectedConversation)?.status} compact />}
              <div><strong>{conversationName(selectedConversation)}</strong><span>{selectedConversation.systemChannel === 'developer-support' ? '요청자와 개발운영진만 보는 공식 1:1 지원 채널' : conversationSubtitle(selectedConversation)}</span></div>
              {activeConversation && activeConversation.systemChannel !== 'developer-support' && (
                <div className="messenger-room-actions">
                  <IconButton tone="quiet" aria-label="이 방에서 검색" onClick={() => { setRoomSearchOpen((open) => !open); setRoomSearchQuery('') }}><Search size={19} /></IconButton>
                  <button type="button" aria-label="대화방 관리" aria-expanded={showConversationMenu} onClick={() => setShowConversationMenu((current) => !current)}><MoreHorizontal size={20} /></button>
                  {showConversationMenu && (
                    <div className="messenger-room-menu">
                      {activeConversation.kind === 'group' && (activeConversation.ownerId === currentUserId || canManage) && (
                        <button type="button" onClick={() => { setGroupDialog('manage'); setShowConversationMenu(false) }}><Users size={17} /> 방 이름·참여자 관리</button>
                      )}
                      <button type="button" onClick={() => { void callRoom('/mute', { method: 'POST', body: JSON.stringify({ muted: !roomMuted }) }, '알림 설정을 바꾸지 못했습니다.'); setShowConversationMenu(false) }}>
                        {roomMuted ? <Bell size={17} /> : <BellOff size={17} />} {roomMuted ? '이 방 알림 켜기' : '이 방 알림 끄기'}
                      </button>
                      <button type="button" onClick={() => { setConversationAction('leave'); setShowConversationMenu(false) }}><LogOut size={17} /> 대화방 나가기</button>
                      {canManage && <button className="danger" type="button" onClick={() => { setConversationAction('delete'); setShowConversationMenu(false) }}><Trash2 size={17} /> 대화방 삭제</button>}
                    </div>
                  )}
                </div>
              )}
            </header>

            {roomSearchOpen && activeConversation && (
              <RoomSearchPanel
                query={roomSearchQuery}
                matches={roomSearchMatches}
                onQueryChange={setRoomSearchQuery}
                onJump={jumpToMessage}
                onClose={() => { setRoomSearchOpen(false); setRoomSearchQuery('') }}
              />
            )}

            {pinnedMessages.length > 0 && (
              <div className="messenger-pinned" aria-label="고정된 공지">
                <Pin size={15} aria-hidden="true" />
                <ul>
                  {pinnedMessages.map((item) => (
                    <li key={item.id}>
                      <button type="button" onClick={() => jumpToMessage(item.id)}>
                        <strong>{item.senderName}</strong>
                        <span>{item.text.length > 70 ? `${item.text.slice(0, 69)}…` : item.text}</span>
                      </button>
                      <IconButton tone="quiet" size="sm" aria-label="고정 해제" onClick={() => togglePin(item.id, false)}><PinOff size={14} /></IconButton>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="messenger-messages" aria-live="polite">
              {hiddenMessageCount > 0 && (
                <div className="messenger-load-older">
                  <Button tone="quiet" size="sm" onClick={() => setVisibleCount((count) => count + MESSAGE_WINDOW)}>
                    이전 메시지 {hiddenMessageCount}건 더 보기
                  </Button>
                </div>
              )}
              <div className="messenger-date-divider"><span>오늘</span></div>
              {selectedConversation.messages.length === 0 && (
                <div className="collab-empty"><MessageCircle size={32} /><strong>첫 메시지를 보내세요</strong><span>업무 내용과 파일을 안전하게 공유할 수 있습니다.</span></div>
              )}
              {visibleMessages.map((item) => {
                const mine = currentIdentityIds.includes(item.senderId) || item.senderId === 'me'
                const quoted = item.replyTo ? selectedConversation.messages.find((candidate) => candidate.id === item.replyTo) : undefined
                const senderInactive = !mine && directory.find((person) => person.id === item.senderId || person.accountId === item.senderId)?.active === false
                const receipts = readCountFor(item)
                const pinned = (selectedConversation.pinnedMessageIds ?? []).includes(item.id)
                const removed = Boolean(item.deletedAt)
                return (
                  <article
                    className={'messenger-message' + (mine ? ' mine' : '') + (removed ? ' removed' : '')}
                    key={item.id}
                    ref={(node) => { messageRefs.current[item.id] = node }}
                  >
                    {!mine && <Avatar name={item.senderName} compact />}
                    <div>
                      {!mine && <strong>{item.senderName}{senderInactive && <span className="messenger-inactive-tag">비활성</span>}</strong>}
                      {quoted && <QuotedMessage senderName={quoted.senderName} text={quoted.deletedAt ? '삭제된 메시지' : quoted.text} onJump={() => jumpToMessage(quoted.id)} />}
                      <div className="messenger-bubble-row">
                        {mine && (
                          <span className="messenger-message-meta">
                            <small>{receipts}</small>
                            <time>{item.time}</time>
                          </span>
                        )}
                        {editing?.id === item.id ? (
                          <span className="messenger-edit-box">
                            <label>
                              <span className="sr-only">메시지 수정</span>
                              <textarea
                                rows={2}
                                value={editing.text}
                                autoFocus
                                onChange={(event) => setEditing({ id: item.id, text: event.target.value })}
                                onKeyDown={(event) => {
                                  if (event.nativeEvent.isComposing) return
                                  if (event.key === 'Escape') setEditing(null)
                                  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submitEdit() }
                                }}
                              />
                            </label>
                            <span className="messenger-edit-actions">
                              <Button tone="quiet" size="sm" onClick={() => setEditing(null)}>취소</Button>
                              <Button tone="primary" size="sm" onClick={() => void submitEdit()}>저장</Button>
                            </span>
                          </span>
                        ) : (
                          <p>{item.text}{item.editedAt && !removed && <span className="messenger-edited">수정됨</span>}</p>
                        )}
                        {!mine && <time>{item.time}</time>}
                      </div>
                      {!removed && editing?.id !== item.id && (
                        <MessageActionBar
                          canEdit={mine}
                          canDelete={mine || canManage || selectedConversation.ownerId === currentUserId}
                          pinned={pinned}
                          onReply={() => { setReplyTo(item); composerRef.current?.focus() }}
                          onReact={(emoji) => toggleReaction(item.id, emoji)}
                          onPin={() => togglePin(item.id, !pinned)}
                          onEdit={() => setEditing({ id: item.id, text: item.text })}
                          onDelete={() => removeMessage(item.id)}
                        />
                      )}
                      <ReactionRow reactions={item.reactions} currentIdentityIds={currentIdentityIds} onToggle={(emoji) => toggleReaction(item.id, emoji)} />
                      {item.attachments && item.attachments.length > 0 && (
                        <div className="messenger-message-attachments" aria-label="메시지 첨부파일">
                          {item.attachments.map((attachment) => (
                            <button
                              type="button"
                              key={attachment.id}
                              onClick={() => void downloadDocumentAttachment(attachment, workspaceScope)
                                .catch((reason) => onToast(reason instanceof Error ? reason.message : '첨부파일을 내려받지 못했습니다.'))}
                            >
                              <Download size={15} aria-hidden="true" />
                              <span><strong>{attachment.name}</strong><small>{attachment.size}</small></span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </article>
                )
              })}
              <div ref={messageEndRef} />
            </div>

            <form className="messenger-composer" onSubmit={sendMessage}>
              {replyTo && (
                <div className="messenger-reply-strip">
                  <CornerUpLeft size={15} aria-hidden="true" />
                  <span><strong>{replyTo.senderName}</strong>에게 답장 · {replyTo.text.length > 50 ? `${replyTo.text.slice(0, 49)}…` : replyTo.text}</span>
                  <IconButton tone="quiet" size="sm" aria-label="답장 취소" onClick={() => setReplyTo(null)}><X size={15} /></IconButton>
                </div>
              )}
              {mentionState && mentionCandidates.length > 0 && (
                <MentionSuggestions
                  people={mentionCandidates}
                  query={mentionState.query}
                  activeIndex={mentionState.index}
                  onPick={(person) => {
                    // 서버는 본문의 `@이름` 문자열로 알림 대상을 찾는다. 그 형태를 정확히 만들어 준다.
                    setMessage((current) => current.replace(/@([^\s@]*)$/, `@${person.name} `))
                    setMentionState(null)
                    composerRef.current?.focus()
                  }}
                />
              )}
              {activePendingAttachments.length > 0 && (
                <div className="messenger-pending-attachments" aria-label="전송 대기 첨부파일">
                  {activePendingAttachments.map((attachment) => (
                    <span key={attachment.id}>
                      <Paperclip size={14} aria-hidden="true" />
                      <span>{attachment.name} · {attachment.size}</span>
                      <button type="button" aria-label={`${attachment.name} 첨부 취소`} disabled={attachmentUploading || messageSending} onClick={() => void removePendingAttachment(attachment)}><X size={14} /></button>
                    </span>
                  ))}
                </div>
              )}
              <input ref={attachmentInputRef} className="sr-only" type="file" multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt" onChange={(event) => void chooseAttachment(event)} />
              {/*
                현장에서 올리는 것은 거의 사진이다. 파일 선택창을 먼저 띄우면 앨범을 뒤져야 하니
                휴대폰에서는 카메라 단추를 앞에 둔다. capture는 이 입력에만 붙인다 —
                파일 입력에 붙이면 앨범과 문서를 아예 고를 수 없게 된다.
              */}
              <input ref={cameraInputRef} className="sr-only" type="file" accept="image/*" capture="environment" onChange={(event) => void chooseAttachment(event)} />
              <button type="button" className="composer-camera" aria-label="사진 찍어 보내기" disabled={!activeConversation || attachmentUploading || messageSending} onClick={() => cameraInputRef.current?.click()}><Camera size={20} /></button>
              <button type="button" aria-label="파일 첨부" disabled={!activeConversation || attachmentUploading || messageSending} onClick={() => attachmentInputRef.current?.click()}>{attachmentUploading ? <Upload size={20} /> : <Paperclip size={20} />}</button>
              <label>
                  <span className="sr-only">{conversationName(selectedConversation)}에게 메시지 작성</span>
                <textarea
                  ref={composerRef}
                  rows={1}
                  disabled={!activeConversation}
                  value={message}
                  onChange={(event) => {
                    const value = event.target.value
                    setMessage(value)
                    // 마지막 @ 뒤에 공백이 없으면 아직 이름을 고르는 중이다.
                    const trailing = value.match(/@([^\s@]*)$/)
                    setMentionState(trailing ? { query: trailing[1], index: 0 } : null)
                  }}
                  onKeyDown={(event) => {
                    // 한글 조합 중의 Enter는 글자 확정용이다. 막지 않으면 조합 중인 낱말이 그대로 전송된다.
                    if (event.nativeEvent.isComposing) return
                    if (mentionState && mentionCandidates.length > 0) {
                      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                        event.preventDefault()
                        const step = event.key === 'ArrowDown' ? 1 : -1
                        setMentionState({ ...mentionState, index: (mentionState.index + step + mentionCandidates.length) % mentionCandidates.length })
                        return
                      }
                      if (event.key === 'Enter' || event.key === 'Tab') {
                        event.preventDefault()
                        const picked = mentionCandidates[mentionState.index]
                        if (picked) {
                          setMessage((current) => current.replace(/@([^\s@]*)$/, `@${picked.name} `))
                          setMentionState(null)
                        }
                        return
                      }
                      if (event.key === 'Escape') { setMentionState(null); return }
                    }
                    if (event.key === 'Escape' && replyTo) { setReplyTo(null); return }
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      event.currentTarget.form?.requestSubmit()
                    }
                  }}
                  placeholder={activeConversation ? '메시지를 입력하세요 (@로 사람을 부를 수 있습니다)' : '직원 목록에서 새 대화를 시작하세요'}
                />
              </label>
              <button className="send" type="submit" aria-label="메시지 보내기" disabled={!activeConversation || !message.trim() || messageSending || attachmentUploading}><Send size={20} /></button>
            </form>
          </section>
        </div>
      </div>
      {groupDialog && (
        <GroupRoomDialog
          mode={groupDialog}
          people={directory}
          currentUserId={currentUserId}
          room={groupDialog === 'manage' && activeConversation ? activeConversation : undefined}
          pending={groupPending}
          onSubmit={(payload) => {
            if (groupDialog === 'create') { void createGroupRoom(payload); return }
            void callRoom('', { method: 'PATCH', body: JSON.stringify({ name: payload.name, icon: payload.icon }) }, '방 정보를 저장하지 못했습니다.')
              .then((body) => { if (body) { setGroupDialog(null); onToast('방 정보를 저장했습니다.') } })
          }}
          onInvite={(ids) => void callRoom('/participants', { method: 'POST', body: JSON.stringify({ participantIds: ids }) }, '초대하지 못했습니다.')
            .then((body) => { if (body) onToast(`${ids.length}명을 초대했습니다.`) })}
          onRemove={(id) => void callRoom(`/participants/${encodeURIComponent(id)}`, { method: 'DELETE' }, '내보내지 못했습니다.')
            .then((body) => { if (body) onToast('참여자를 내보냈습니다.') })}
          onTransfer={(id) => void callRoom('/owner', { method: 'POST', body: JSON.stringify({ ownerId: id }) }, '방장을 위임하지 못했습니다.')
            .then((body) => { if (body) onToast('방장을 위임했습니다.') })}
          onClose={() => setGroupDialog(null)}
        />
      )}
      {conversationAction && activeConversation && (
        <ConversationActionDialog
          action={conversationAction}
          conversationName={conversationName(activeConversation)}
          directConversation={activeConversation.type === 'direct'}
          pending={conversationActionPending}
          onConfirm={() => void performConversationAction()}
          onClose={() => { if (!conversationActionPending) setConversationAction(null) }}
        />
      )}
    </div>
  )
}

function ConversationActionDialog({
  action,
  conversationName,
  directConversation,
  pending,
  onConfirm,
  onClose,
}: {
  action: 'leave' | 'delete'
  conversationName: string
  directConversation: boolean
  pending: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const dialogRef = useOverlayFocus(true, onClose)
  const deleting = action === 'delete'
  return (
    <div className="collab-overlay messenger-confirm-overlay">
      <button className="collab-overlay-backdrop" type="button" aria-label="확인 창 닫기" onClick={onClose} disabled={pending} />
      <div ref={dialogRef} className="collab-dialog messenger-action-dialog" role="alertdialog" aria-modal="true" aria-labelledby="messenger-action-title">
        <header className="collab-dialog-header">
          <div><span className="collab-kicker">CONVERSATION</span><h2 id="messenger-action-title">대화방 {deleting ? '삭제' : '나가기'}</h2></div>
          <button type="button" aria-label="닫기" onClick={onClose} disabled={pending}><X size={21} /></button>
        </header>
        <div className="collab-dialog-body messenger-action-copy">
          <span className={deleting ? 'danger' : ''}>{deleting ? <Trash2 size={24} /> : <LogOut size={24} />}</span>
          <div>
            <strong>{conversationName}</strong>
            <p>{deleting
              ? '모든 참여자에게서 대화와 메시지 기록이 삭제됩니다. 이 작업은 되돌릴 수 없습니다.'
              : directConversation
                ? '내 대화 목록에서 숨겨집니다. 해당 직원과 다시 대화하면 이전 기록과 분리된 빈 새 방이 열립니다.'
                : '내 대화 목록에서 숨겨집니다. 다시 참여하려면 대화방 관리자에게 초대를 요청해 주세요.'}</p>
          </div>
        </div>
        <footer className="collab-dialog-footer">
          <span />
          <div>
            <Button tone="ghost" type="button" onClick={onClose} disabled={pending}>취소</Button>
            <Button tone={deleting ? 'danger' : 'primary'} type="button" data-autofocus onClick={onConfirm} disabled={pending}>{pending ? '처리 중…' : deleting ? '삭제 확정' : '나가기'}</Button>
          </div>
        </footer>
      </div>
    </div>
  )
}

type CalendarScope = 'company' | 'department' | 'personal'
type CalendarFilter = 'all' | CalendarScope

type CalendarEvent = {
  id: string
  title: string
  date: string
  start: string
  end: string
  scope: CalendarScope
  department: string
  location: string
  ownerId?: string
  owner: string
  note: string
  source?: 'leave'
}

type CalendarEventDraft = Omit<CalendarEvent, 'id'>

const scopeCopy: Record<CalendarScope, { label: string; description: string }> = {
  company: { label: '전사', description: '모든 직원에게 공개' },
  department: { label: '부서', description: '선택한 부서에 공개' },
  personal: { label: '개인', description: '나에게만 공개' },
}

const scheduleToday = seoulDateInputValue()

function monthCells(viewMonth: Date) {
  const year = viewMonth.getFullYear()
  const month = viewMonth.getMonth()
  const first = new Date(year, month, 1)
  const start = new Date(year, month, 1 - first.getDay())
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    return date
  })
}

function koreanDateLabel(value: string, includeYear = false) {
  return formatDateLabel(value, includeYear, true)
}

function emptyEventDraft(date: string, currentUserId: string, currentUserName: string, currentUserTeam: string, canManage: boolean): CalendarEventDraft {
  return {
    title: '',
    date,
    start: '09:00',
    end: '10:00',
    scope: canManage ? 'company' : 'department',
    department: canManage ? '전사' : currentUserTeam,
    location: '',
    ownerId: currentUserId,
    owner: currentUserName,
    note: '',
  }
}

function sameDepartment(left: string, right: string) {
  const normalize = (value: string) => value.replace(/\s+/g, '').replace(/팀$/, '')
  return normalize(left) === normalize(right)
}

export function SchedulePage({ onToast, currentUserId, currentUserName, currentUserTeam, canManage, workspaceScope }: PageProps) {
  const [events, setEvents] = useWorkspaceState<CalendarEvent[]>('calendar-events', [], { scope: workspaceScope, seedWhenEmpty: false })
  const [departments, setDepartments] = useWorkspaceState<string[]>('calendar-departments', [], { scope: workspaceScope, seedWhenEmpty: false })
  const [leaveEvents, setLeaveEvents] = useState<CalendarEvent[]>([])
  const [viewMonth, setViewMonth] = useState(() => {
    const today = new Date(scheduleToday + 'T00:00:00')
    return new Date(today.getFullYear(), today.getMonth(), 1)
  })
  const [selectedDate, setSelectedDate] = useState(scheduleToday)
  const [scopeFilter, setScopeFilter] = useState<CalendarFilter>('all')
  const [eventDraft, setEventDraft] = useState<CalendarEventDraft | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    fetch('/api/calendar/approved-leaves', {
      headers: workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('leave-calendar-load')
        return response.json() as Promise<{ events?: CalendarEvent[] }>
      })
      .then(({ events: approvedLeaveEvents }) => {
        if (active && Array.isArray(approvedLeaveEvents)) setLeaveEvents(approvedLeaveEvents)
      })
      .catch(() => { if (active) setLeaveEvents([]) })
    return () => { active = false }
  }, [workspaceScope])

  const cells = useMemo(() => monthCells(viewMonth), [viewMonth])
  const currentOwnerIds = [currentUserId]
  const isEventOwner = (event: Pick<CalendarEvent, 'ownerId' | 'owner'>) => Boolean(event.ownerId && currentOwnerIds.includes(event.ownerId)) || (!event.ownerId && event.owner === currentUserName)
  const accessibleEvents = [...events, ...leaveEvents].filter((event) => canManage || event.scope === 'company' || isEventOwner(event) || (event.scope === 'department' && sameDepartment(event.department, currentUserTeam)))
  const visibleEvents = accessibleEvents.filter((event) => scopeFilter === 'all' || event.scope === scopeFilter)
  const selectedEvents = visibleEvents
    .filter((event) => event.date === selectedDate)
    .sort((a, b) => a.start.localeCompare(b.start))
  const todayEvents = accessibleEvents.filter((event) => event.date === scheduleToday)

  const openCreate = (date = selectedDate) => {
    setSelectedDate(date)
    setEditingId(null)
    setEventDraft(emptyEventDraft(date, currentUserId, currentUserName, currentUserTeam, canManage))
  }

  const openEdit = (event: CalendarEvent) => {
    const { id, ...draft } = event
    setEditingId(id)
    setEventDraft(draft)
  }

  const closeEditor = () => {
    setEventDraft(null)
    setEditingId(null)
  }

  const saveEvent = async (draft: CalendarEventDraft) => {
    if (draft.source === 'leave') {
      onToast('승인 휴가 일정은 인사·조직에서 휴가 결재를 변경해 주세요.')
      return
    }
    if (!draft.title.trim()) {
      onToast('일정 제목을 입력해 주세요.')
      return
    }
    if (draft.end <= draft.start) {
      onToast('종료 시간은 시작 시간보다 늦어야 합니다.')
      return
    }
    if (editingId) {
      const original = events.find((event) => event.id === editingId)
      if (!original || (!canManage && !isEventOwner(original))) {
        onToast('일정 작성자와 관리자만 수정할 수 있습니다.')
        return
      }
      const result = await setEvents((current) => current.map((event) => event.id === editingId ? { ...draft, id: editingId } : event))
      if (!result.ok) { onToast(result.message ?? '일정 수정 내용을 저장하지 못했습니다.'); return }
      onToast('일정을 수정했습니다.')
    } else {
      const ownedDraft = { ...draft, ownerId: currentUserId, owner: currentUserName }
      const result = await setEvents((current) => [...current, { ...ownedDraft, id: 'EV-' + Date.now() }])
      if (!result.ok) { onToast(result.message ?? '새 일정을 저장하지 못했습니다.'); return }
      onToast('공유 일정에 새 일정을 등록했습니다.')
    }
    setSelectedDate(draft.date)
    closeEditor()
  }

  const deleteEvent = async () => {
    if (!editingId) return
    if (editingId.startsWith('LEAVE-')) {
      onToast('승인 휴가 일정은 인사·조직에서만 변경할 수 있습니다.')
      return
    }
    const original = events.find((event) => event.id === editingId)
    if (!original || (!canManage && !isEventOwner(original))) {
      onToast('일정 작성자와 관리자만 삭제할 수 있습니다.')
      return
    }
    // 회사 전체가 보는 일정이다. 되돌릴 수 없으므로 지우기 전에 무엇을 지우는지 밝힌다.
    if (!window.confirm(`‘${original.title}’ 일정을 삭제할까요?\n같은 일정을 보고 있는 다른 직원에게서도 사라집니다.`)) return
    const result = await setEvents((current) => current.filter((event) => event.id !== editingId))
    if (!result.ok) { onToast(result.message ?? '일정을 삭제하지 못했습니다.'); return }
    onToast('일정을 삭제했습니다.')
    closeEditor()
  }

  const moveMonth = (delta: number) => {
    setViewMonth((current) => new Date(current.getFullYear(), current.getMonth() + delta, 1))
  }

  const addDepartment = async (name: string) => {
    const normalized = name.trim().replace(/\s+/g, ' ')
    if (normalized.length < 2 || normalized.length > 30) {
      onToast('담당 부서명은 2자 이상 30자 이하로 입력해 주세요.')
      return null
    }
    const existingDepartment = departments.find((department) => department.toLowerCase() === normalized.toLowerCase())
    if (existingDepartment) {
      onToast('이미 등록된 담당 부서입니다.')
      return existingDepartment
    }
    const result = await setDepartments((current) => [...current, normalized])
    if (!result.ok) {
      onToast(result.message ?? '담당 부서를 등록하지 못했습니다.')
      return null
    }
    onToast(normalized + '을(를) 담당 부서에 등록했습니다.')
    return normalized
  }

  return (
    <div className="collab-page schedule-page">
      <CollabPageHeader
        kicker="SHARED SCHEDULE"
        title="공유 일정"
        description="전사 행사, 부서 일정과 개인 업무를 한 달 흐름에서 함께 확인합니다. 날짜를 고른 뒤 달력 옆 버튼으로 바로 등록하세요."
      />

      <section className="schedule-toolbar" aria-label="일정 보기 설정">
        <div className="schedule-month-nav">
          <button type="button" aria-label="이전 달" onClick={() => moveMonth(-1)}><ChevronLeft size={21} /></button>
          <h2>{formatYearMonthLabel(viewMonth)}</h2>
          <button type="button" aria-label="다음 달" onClick={() => moveMonth(1)}><ChevronRight size={21} /></button>
        </div>
        <div className="schedule-scope-filter" role="group" aria-label="일정 공개 범위 필터">
          {([
            ['all', '전체'],
            ['company', '전사'],
            ['department', '부서'],
            ['personal', '개인'],
          ] as Array<[CalendarFilter, string]>).map(([id, label]) => (
            <button
              type="button"
              className={scopeFilter === id ? 'active' : ''}
              aria-pressed={scopeFilter === id}
              onClick={() => setScopeFilter(id)}
              key={id}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="schedule-create-group"><span className="schedule-selected-hint">{selectedDate === scheduleToday ? '오늘' : selectedDate.slice(5).replace('-', '/')} 선택됨</span><Button tone="primary" className="schedule-create-button" type="button" onClick={() => openCreate()}><Plus size={18} /> 일정 등록</Button></div>
      </section>

      <div className="schedule-workspace">
        <section className="collab-panel calendar-panel" aria-label="월간 달력">
          <div className="calendar-weekdays" aria-hidden="true">
            {['일', '월', '화', '수', '목', '금', '토'].map((day) => <span className={day === '일' ? 'is-sun' : day === '토' ? 'is-sat' : ''} key={day}>{day}</span>)}
          </div>
          <div className="calendar-grid" role="grid" aria-label={formatYearMonthLabel(viewMonth) + ' 일정'}>
            {cells.map((cell) => {
              const key = seoulDateInputValue(cell)
              const cellEvents = visibleEvents.filter((event) => event.date === key)
              const outside = cell.getMonth() !== viewMonth.getMonth()
              const selected = key === selectedDate
              const today = key === scheduleToday
              const kind: DayKind = dayKind(key)
              const holiday = holidayName(key)
              return (
                <div
                  className={'calendar-day' + (outside ? ' outside' : '') + (selected ? ' selected' : '') + (today ? ' today' : '') + (kind === 'holiday' || kind === 'sunday' ? ' is-holiday-day' : kind === 'saturday' ? ' is-saturday' : '')}
                  role="gridcell"
                  aria-selected={selected}
                  key={key}
                >
                  <button
                    className="calendar-day-number"
                    type="button"
                    aria-label={koreanDateLabel(key, true) + (holiday ? `, ${holiday}` : '') + ', 일정 ' + cellEvents.length + '개'}
                    onClick={() => setSelectedDate(key)}
                  >
                    <span>{cell.getDate()}</span>
                    {today && <em>오늘</em>}
                  </button>
                  {holiday && <span className="calendar-holiday-name" title={holiday}>{holiday}</span>}
                  <div className="calendar-day-events">
                    {cellEvents.slice(0, 3).map((event) => (
                      <button className={'calendar-event ' + (event.source === 'leave' ? 'leave' : event.scope)} type="button" onClick={() => openEdit(event)} key={event.id}>
                        <span>{event.source === 'leave' ? '휴가' : event.start}</span> {event.title}
                      </button>
                    ))}
                    {cellEvents.length > 3 && <button className="calendar-more" type="button" onClick={() => setSelectedDate(key)}>+{cellEvents.length - 3}개 더보기</button>}
                  </div>
                </div>
              )
            })}
          </div>
        </section>

        <aside className="collab-panel schedule-day-panel" aria-labelledby="selected-day-title">
          <div className="schedule-day-head">
            <div>
              <span>{selectedDate === scheduleToday ? 'TODAY' : 'SELECTED DAY'}</span>
              <h2 id="selected-day-title">{koreanDateLabel(selectedDate)}</h2>
              <p>{holidayName(selectedDate) ? <em className="schedule-day-holiday">{holidayName(selectedDate)}</em> : null}{selectedEvents.length}개의 일정</p>
            </div>
            <button type="button" className="schedule-day-add" aria-label="선택한 날짜에 일정 추가" onClick={() => openCreate(selectedDate)}><Plus size={18} /> 이 날짜에 등록</button>
          </div>
          <div className="schedule-day-list">
            {selectedEvents.map((event) => (
              <button className={'schedule-agenda-item ' + (event.source === 'leave' ? 'leave' : event.scope)} type="button" onClick={() => openEdit(event)} key={event.id}>
                <span className="schedule-agenda-time">{event.source === 'leave' ? '휴가' : event.start}<i />{event.source === 'leave' ? '종일' : event.end}</span>
                <span className="schedule-agenda-copy">
                  <strong>{event.title}</strong>
                  <span>{event.location || '장소 미정'} · {event.owner}</span>
                  <StatusChip tone={event.source === 'leave' ? 'amber' : event.scope === 'company' ? 'green' : event.scope === 'department' ? 'blue' : 'amber'}>{event.source === 'leave' ? '승인 휴가' : scopeCopy[event.scope].label}</StatusChip>
                </span>
                <ChevronRight size={18} aria-hidden="true" />
              </button>
            ))}
            {selectedEvents.length === 0 && (
              <div className="collab-empty">
                <CalendarDays size={32} />
                <strong>등록된 일정이 없습니다</strong>
                <span>선택한 날짜에 새 일정을 추가해 보세요.</span>
                <Button tone="ghost" type="button" onClick={() => openCreate(selectedDate)}><Plus size={17} /> 일정 추가</Button>
              </div>
            )}
          </div>
          <div className="schedule-day-summary">
            <CalendarDays size={20} />
            <div><strong>오늘 일정 {todayEvents.length}개</strong><span>전사 {todayEvents.filter((event) => event.scope === 'company').length} · 부서 {todayEvents.filter((event) => event.scope === 'department').length} · 개인 {todayEvents.filter((event) => event.scope === 'personal').length}</span></div>
          </div>
        </aside>
      </div>

      {eventDraft && (
        <ScheduleEventDialog
          draft={eventDraft}
          editing={Boolean(editingId)}
          canEdit={eventDraft.source !== 'leave' && (!editingId || canManage || isEventOwner(eventDraft))}
          canShareCompany={canManage}
          availableDepartments={canManage ? Array.from(new Set(['전사', currentUserTeam, ...departments, ...events.map((event) => event.department)])) : [currentUserTeam]}
          canManageDepartments={canManage}
          onAddDepartment={addDepartment}
          onChange={setEventDraft}
          onSave={saveEvent}
          onDelete={deleteEvent}
          onClose={closeEditor}
        />
      )}
    </div>
  )
}

function ScheduleEventDialog({
  draft,
  editing,
  canEdit,
  canShareCompany,
  availableDepartments,
  canManageDepartments,
  onAddDepartment,
  onChange,
  onSave,
  onDelete,
  onClose,
}: {
  draft: CalendarEventDraft
  editing: boolean
  canEdit: boolean
  canShareCompany: boolean
  availableDepartments: string[]
  canManageDepartments: boolean
  onAddDepartment: (name: string) => Promise<string | null>
  onChange: (draft: CalendarEventDraft) => void
  onSave: (draft: CalendarEventDraft) => Promise<void>
  onDelete: () => Promise<void>
  onClose: () => void
}) {
  const industry = useIndustrySurface()
  const dialogRef = useOverlayFocus(true, onClose)
  const [showDepartmentCreator, setShowDepartmentCreator] = useState(false)
  const [newDepartment, setNewDepartment] = useState('')
  const [addingDepartment, setAddingDepartment] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const update = <Key extends keyof CalendarEventDraft>(key: Key, value: CalendarEventDraft[Key]) => {
    onChange({ ...draft, [key]: value })
  }
  const addDepartment = async () => {
    if (addingDepartment) return
    setAddingDepartment(true)
    const added = await onAddDepartment(newDepartment)
    setAddingDepartment(false)
    if (!added) return
    update('department', added)
    setNewDepartment('')
    setShowDepartmentCreator(false)
  }

  return (
    <div className="collab-overlay">
      <button className="collab-overlay-backdrop" type="button" aria-label="일정 편집 닫기" onClick={onClose} />
      <div ref={dialogRef} className="collab-dialog schedule-event-dialog" role="dialog" aria-modal="true" aria-labelledby="schedule-dialog-title">
        <header className="collab-dialog-header">
          <div><span className="collab-kicker">SCHEDULE</span><h2 id="schedule-dialog-title">{editing ? (canEdit ? '일정 수정' : '일정 상세') : '새 일정 등록'}</h2></div>
          <button type="button" aria-label="닫기" onClick={onClose}><X size={21} /></button>
        </header>
        <form onSubmit={(event) => {
          event.preventDefault()
          if (!canEdit || submitting) return
          setSubmitting(true)
          void onSave(draft).finally(() => setSubmitting(false))
        }}>
          <div className="collab-dialog-body collab-form-grid">
            <label className="collab-field wide"><span>일정 제목</span><input data-autofocus value={draft.title} disabled={!canEdit} onChange={(event) => update('title', event.target.value)} placeholder={industry.examples.scheduleTitle} /></label>
            <label className="collab-field"><span>날짜</span><input type="date" value={draft.date} disabled={!canEdit} onChange={(event) => update('date', event.target.value)} /></label>
            <div className="collab-time-fields">
              <label className="collab-field"><span>시작</span><input type="time" value={draft.start} disabled={!canEdit} onChange={(event) => update('start', event.target.value)} /></label>
              <label className="collab-field"><span>종료</span><input type="time" value={draft.end} disabled={!canEdit} onChange={(event) => update('end', event.target.value)} /></label>
            </div>
            <fieldset className="collab-scope-options wide">
              <legend>공개 범위</legend>
              {(Object.keys(scopeCopy) as CalendarScope[]).map((scope) => (
                <label className={draft.scope === scope ? 'selected' : ''} key={scope}>
                  <input
                    type="radio"
                    name="event-scope"
                    value={scope}
                    checked={draft.scope === scope}
                    disabled={!canEdit || (scope === 'company' && !canShareCompany)}
                    onChange={() => update('scope', scope)}
                  />
                  {scope === 'company' ? <Users size={19} /> : scope === 'department' ? <Building2 size={19} /> : <UserRound size={19} />}
                  <span><strong>{scopeCopy[scope].label}</strong><small>{scopeCopy[scope].description}</small></span>
                </label>
              ))}
            </fieldset>
            <div className="schedule-department-field">
              <label className="collab-field">
                <span>담당 부서</span>
                <select value={draft.department} disabled={!canEdit} onChange={(event) => update('department', event.target.value)}>
                  {(availableDepartments.includes(draft.department) ? availableDepartments : [draft.department, ...availableDepartments]).map((team) => <option key={team}>{team}</option>)}
                </select>
              </label>
              {canEdit && canManageDepartments && (
                showDepartmentCreator ? (
                  <div className="schedule-department-create">
                    <input aria-label="새 담당 부서명" value={newDepartment} onChange={(event) => setNewDepartment(event.target.value)} placeholder="예: 연구개발팀" />
                    <button type="button" onClick={() => void addDepartment()} disabled={newDepartment.trim().length < 2 || addingDepartment}>{addingDepartment ? '등록 중…' : '등록'}</button>
                    <button type="button" aria-label="담당 부서 등록 취소" onClick={() => { setShowDepartmentCreator(false); setNewDepartment('') }}><X size={16} /></button>
                  </div>
                ) : <button className="schedule-add-department" type="button" onClick={() => setShowDepartmentCreator(true)}><Plus size={15} /> 담당 부서 등록</button>
              )}
            </div>
            <label className="collab-field"><span>장소</span><input value={draft.location} disabled={!canEdit} onChange={(event) => update('location', event.target.value)} placeholder="회의실 또는 온라인" /></label>
            <label className="collab-field wide"><span>메모</span><textarea rows={3} value={draft.note} disabled={!canEdit} onChange={(event) => update('note', event.target.value)} placeholder="참석자가 알아야 할 내용을 입력하세요." /></label>
          </div>
          <footer className="collab-dialog-footer">
            {editing && canEdit ? <Button tone="danger" type="button" disabled={submitting} onClick={() => { if (submitting) return; setSubmitting(true); void onDelete().finally(() => setSubmitting(false)) }}><Trash2 size={17} /> 삭제</Button> : <span />}
            <div><Button tone="ghost" type="button" onClick={onClose} disabled={submitting}>{canEdit ? '취소' : '닫기'}</Button>{canEdit && <Button tone="primary" type="submit" disabled={submitting}><Check size={18} /> {submitting ? '저장 중…' : editing ? '수정 저장' : '일정 등록'}</Button>}</div>
          </footer>
        </form>
      </div>
    </div>
  )
}

type JournalStatus = '임시저장' | '결재요청' | '승인' | '반려'

type JournalAttachment = {
  id: string
  name: string
  size: string
}

type JournalComment = {
  id: string
  authorId: string
  author: string
  text: string
  attachments: JournalAttachment[]
  createdAt: string
}

type JournalReview = {
  id: string
  decision: '승인' | '반려'
  comment: string
  reviewedAt: string
  reviewerId: string
  reviewerName: string
}

type Journal = {
  id: string
  date: string
  title: string
  authorId?: string
  author: string
  department: string
  completed: string
  issue: string
  nextPlan: string
  approver: string
  status: JournalStatus
  updatedAt: string
  submittedAt?: string
  draftRevision?: number
  feedback: string
  attachments: JournalAttachment[]
  reviews?: JournalReview[]
  comments?: JournalComment[]
}

type JournalFilter = '전체' | JournalStatus

function journalTone(status: JournalStatus): 'neutral' | 'green' | 'blue' | 'amber' | 'red' {
  if (status === '승인') return 'green'
  if (status === '결재요청') return 'blue'
  if (status === '반려') return 'red'
  return 'amber'
}

function cloneJournal(journal: Journal): Journal {
  return {
    ...journal,
    attachments: journal.attachments.map((attachment) => ({ ...attachment })),
    reviews: (journal.reviews ?? []).map((review) => ({ ...review })),
    ...(journal.comments ? { comments: journal.comments.map((comment) => ({ ...comment, attachments: comment.attachments.map((attachment) => ({ ...attachment })) })) } : {}),
  }
}

function newJournalDraft(currentUserId: string, currentUserName: string, currentUserTeam: string): Journal {
  return {
    id: 'JR-' + Date.now(),
    date: scheduleToday,
    title: `${scheduleToday}_${currentUserName}_업무일지`,
    authorId: currentUserId,
    author: currentUserName,
    department: currentUserTeam,
    completed: '',
    issue: '',
    nextPlan: '',
    approver: '소속 관리자',
    status: '임시저장',
    updatedAt: new Date().toISOString(),
    feedback: '',
    attachments: [],
    reviews: [],
  }
}

function formatJournalReviewTime(value: string) {
  return formatShortDateTime(value)
}

function formatJournalTimestamp(value: string) {
  return formatDateTime(value)
}

function normalizeJournalBullets(value: string) {
  return value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const content = line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trimEnd()
      return content.trim() ? `• ${content.trimStart()}` : ''
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, 10_000)
}

function journalSummaryLine(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .find(Boolean) || '아직 작성된 업무 내용이 없습니다.'
}

/** 저장된 불릿 텍스트를 블록 배열로 변환한다. 편집 중에는 블록 배열이 원본이고,
 *  저장 시에만 '• ' 접두사를 붙여 직렬화하므로 IME(한글 조합) 입력이 끊기지 않는다. */
function parseJournalBlocks(value: string): string[] {
  return value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, ''))
    .filter((line) => line.trim() !== '')
}

function serializeJournalBlocks(blocks: string[]): string {
  return blocks
    .map((block) => block.replace(/\s+$/, ''))
    .filter((block) => block.trim() !== '')
    .map((block) => `• ${block}`)
    .join('\n')
}

function JournalReviewDialog({
  decision,
  submitting,
  onSubmit,
  onClose,
}: {
  decision: '승인' | '반려'
  submitting: boolean
  onSubmit: (comment: string) => void
  onClose: () => void
}) {
  const industry = useIndustrySurface()
  const [comment, setComment] = useState('')
  const dialogRef = useOverlayFocus(true, onClose)
  const isReject = decision === '반려'
  const commentOptional = !isReject
  const valid = commentOptional || comment.trim().length >= 2

  return (
    <div className="collab-overlay">
      <button className="collab-overlay-backdrop" type="button" aria-label="결재 창 닫기" onClick={onClose} disabled={submitting} />
      <div ref={dialogRef} className="collab-dialog journal-review-dialog" role="dialog" aria-modal="true" aria-labelledby="journal-review-dialog-title">
        <header className="collab-dialog-header">
          <div>
            <span className="collab-kicker">APPROVAL COMMENT</span>
            <h2 id="journal-review-dialog-title">업무일지 {decision}</h2>
          </div>
          <button type="button" aria-label="닫기" onClick={onClose} disabled={submitting}><X size={21} /></button>
        </header>
        <form onSubmit={(event) => { event.preventDefault(); if (valid && !submitting) onSubmit(comment.trim()) }}>
          <div className="collab-dialog-body">
            <div className={'journal-review-dialog-guide ' + (isReject ? 'red' : 'green')}>
              {isReject ? <AlertCircle size={21} /> : <ShieldCheck size={21} />}
              <div>
                <strong>{isReject ? '작성자가 보완할 내용을 구체적으로 남겨 주세요.' : '확인했다면 바로 승인할 수 있습니다.'}</strong>
                <p>{isReject ? '보완 코멘트는 작성자에게 공유되고 결재 이력에 보관됩니다.' : '메모는 선택 사항이며, 남기면 작성자에게 공유되고 결재 이력에 보관됩니다.'}</p>
              </div>
            </div>
            <label className="collab-field journal-review-comment">
              <span>{isReject ? '보완 코멘트' : '승인 메모'} <em>{isReject ? '필수' : '선택'}</em></span>
              <textarea
                data-autofocus
                rows={6}
                maxLength={1000}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                placeholder={isReject ? industry.examples.reviewComment : '필요할 때만 남기세요. 예: 다음 주 계획까지 확인했습니다.'}
              />
              <small>{comment.length}/1000{isReject ? ' · 2자 이상 입력' : ' · 비워 두어도 승인됩니다'}</small>
            </label>
          </div>
          <footer className="collab-dialog-footer">
            <span />
            <div>
              <Button tone="ghost" type="button" onClick={onClose} disabled={submitting}>취소</Button>
              <Button tone={isReject ? 'danger' : 'primary'} type="submit" disabled={!valid || submitting}>
                {isReject ? <X size={18} /> : <Check size={18} />} {submitting ? '처리 중…' : decision + ' 확정'}
              </Button>
            </div>
          </footer>
        </form>
      </div>
    </div>
  )
}

export function DailyJournalPage({ onToast, currentUserId, currentUserName, currentUserTeam, canManage, workspaceScope }: PageProps) {
  const [journals, setJournals] = useWorkspaceState<Journal[]>('daily-journals', [], { scope: workspaceScope, seedWhenEmpty: false })
  const isJournalOwner = (journal: Pick<Journal, 'authorId'>) => journal.authorId === currentUserId
  const initialJournal = journals.find(isJournalOwner) ?? (canManage ? journals[0] : undefined) ?? newJournalDraft(currentUserId, currentUserName, currentUserTeam)
  const [selectedId, setSelectedId] = useState(initialJournal.id)
  const [editor, setEditor] = useState<Journal>(() => cloneJournal(initialJournal))
  const [viewMode, setViewMode] = useState<'list' | 'editor'>('list')
  const [browseMode, setBrowseMode] = useState<'week' | 'all'>('week')
  const [weekAnchor, setWeekAnchor] = useState(scheduleToday)
  const [monthAnchor, setMonthAnchor] = useState(scheduleToday.slice(0, 7))
  const [authorFilter, setAuthorFilter] = useState('전체')
  const [journalEditorMode, setJournalEditorMode] = useState<'view' | 'edit'>('view')
  const [filter, setFilter] = useState<JournalFilter>('전체')
  const [query, setQuery] = useState('')
  const [journalSaving, setJournalSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [reviewDecision, setReviewDecision] = useState<'승인' | '반려' | null>(null)
  const [reviewSubmitting, setReviewSubmitting] = useState(false)
  const [attachmentBusy, setAttachmentBusy] = useState(false)
  const [downloadingAttachmentId, setDownloadingAttachmentId] = useState('')
  const [aiDraftBusy, setAiDraftBusy] = useState(false)
  const [autoSaveMessage, setAutoSaveMessage] = useState('30초마다 변경사항을 자동 임시저장합니다.')
  const [journalManualSaving, setJournalManualSaving] = useState(false)
  const [completedBlocks, setCompletedBlocks] = useState<string[]>([''])
  const [issueBlocks, setIssueBlocks] = useState<string[]>([])
  const blocksSyncRef = useRef({ id: '', completed: '', issue: '' })
  const fileInputRef = useRef<HTMLInputElement>(null)
  const editorDirtyRef = useRef(false)
  const editorStateRef = useRef(editor)
  const journalRevisionRef = useRef(0)
  const journalSavingRef = useRef(false)
  const journalManualSavingRef = useRef(false)
  const autoSaveActionRef = useRef<(() => Promise<boolean>) | null>(null)
  const autoSaveRetryTimerRef = useRef<number | null>(null)
  const flushJournalDraftRef = useRef<(() => void) | null>(null)
  const journalModeRef = useRef({ viewMode, journalEditorMode })
  const [journalDirty, setJournalDirty] = useState(false)
  const uploadedAttachmentIdsRef = useRef(new Set<string>())
  const removedAttachmentIdsRef = useRef(new Set<string>())
  const accessibleJournals = journals.filter((journal) => canManage || isJournalOwner(journal))
  editorStateRef.current = editor
  journalModeRef.current = { viewMode, journalEditorMode }
  const markJournalDirty = (dirty: boolean) => {
    if (dirty) journalRevisionRef.current = Math.max(journalRevisionRef.current, editorStateRef.current.draftRevision ?? 0) + 1
    editorDirtyRef.current = dirty
    setJournalDirty(dirty)
  }

  useEffect(() => {
    if (viewMode !== 'editor' || !journalDirty) return
    const preventAccidentalUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', preventAccidentalUnload)
    return () => window.removeEventListener('beforeunload', preventAccidentalUnload)
  }, [journalDirty, viewMode])

  useEffect(() => {
    if (editorDirtyRef.current) return
    const selectedJournal = accessibleJournals.find((journal) => journal.id === selectedId) ?? accessibleJournals[0]
    if (!selectedJournal) return
    if (selectedJournal.id !== selectedId) setSelectedId(selectedJournal.id)
    setEditor((current) => JSON.stringify(current) === JSON.stringify(selectedJournal) ? current : cloneJournal(selectedJournal))
  }, [accessibleJournals, selectedId])

  const browseFiltered = accessibleJournals.filter((journal) => {
    const matchesFilter = filter === '전체' || journal.status === filter
    const normalized = query.trim().toLowerCase()
    const matchesQuery = !normalized || (journal.title + ' ' + journal.date + ' ' + journal.author + ' ' + journal.department + ' ' + journal.completed).toLowerCase().includes(normalized)
    const matchesAuthor = authorFilter === '전체' || journal.author === authorFilter
    return matchesFilter && matchesQuery && matchesAuthor
  })
  const monthJournals = browseFiltered.filter((journal) => journal.date.startsWith(monthAnchor))
  const monthCells = (() => {
    const [year, month] = monthAnchor.split('-').map(Number)
    const first = new Date(Date.UTC(year, month - 1, 1))
    const lead = (first.getUTCDay() + 6) % 7 // 월요일 시작
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
    const cells: Array<{ key: string; day: number; kind: DayKind; holiday: string | null } | null> = Array.from({ length: lead }, () => null)
    for (let day = 1; day <= daysInMonth; day += 1) {
      const key = `${monthAnchor}-${String(day).padStart(2, '0')}`
      cells.push({ key, day, kind: dayKind(key), holiday: holidayName(key) })
    }
    while (cells.length % 7 !== 0) cells.push(null)
    return cells
  })()
  const monthLabel = `${monthAnchor.slice(0, 4)}년 ${Number(monthAnchor.slice(5, 7))}월`
  const moveMonth = (delta: number) => {
    const [year, month] = monthAnchor.split('-').map(Number)
    const date = new Date(Date.UTC(year, month - 1 + delta, 1))
    setMonthAnchor(date.toISOString().slice(0, 7))
  }
  const sortedJournals = [...monthJournals].sort((left, right) => {
    const byDate = right.date.localeCompare(left.date)
    return byDate || right.updatedAt.localeCompare(left.updatedAt)
  })
  const journalAuthors = Array.from(new Set(accessibleJournals.map((journal) => journal.author))).sort((left, right) => left.localeCompare(right, 'ko'))
  const weekDays = (() => {
    const start = new Date(`${weekAnchor}T00:00:00Z`)
    const day = start.getUTCDay()
    start.setUTCDate(start.getUTCDate() - (day === 0 ? 6 : day - 1))
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(start)
      date.setUTCDate(date.getUTCDate() + index)
      const key = date.toISOString().slice(0, 10)
      return {
        key,
        kind: dayKind(key),
        holiday: holidayName(key),
        label: `${date.getUTCMonth() + 1}/${date.getUTCDate()}`,
        weekdayName: ['일', '월', '화', '수', '목', '금', '토'][date.getUTCDay()],
      }
    })
  })()
  const weekLabel = `${weekDays[0].label} ~ ${weekDays[6].label}`
  const moveWeek = (delta: number) => {
    const date = new Date(`${weekAnchor}T00:00:00Z`)
    date.setUTCDate(date.getUTCDate() + delta * 7)
    setWeekAnchor(date.toISOString().slice(0, 10))
  }
  const canModifyJournal = isJournalOwner(editor) && (editor.status === '임시저장' || editor.status === '반려')
  const canEdit = journalEditorMode === 'edit' && canModifyJournal

  const updateEditor = <Key extends keyof Journal>(key: Key, value: Journal[Key]) => {
    if (!canEdit || journalManualSavingRef.current) return
    markJournalDirty(true)
    setEditor((current) => ({ ...current, [key]: value }))
  }

  // 블록 배열은 편집 화면의 원본이다. 외부 변경(AI 초안·자동저장 반영·일지 전환)일 때만
  // 저장된 텍스트에서 블록을 다시 만든다. 입력값 자체는 절대 변형하지 않는다(IME 보호).
  useEffect(() => {
    const sync = blocksSyncRef.current
    if (sync.id !== editor.id || sync.completed !== editor.completed) {
      sync.completed = editor.completed
      const parsed = parseJournalBlocks(editor.completed)
      setCompletedBlocks(parsed.length ? parsed : [''])
    }
    if (sync.id !== editor.id || sync.issue !== editor.issue) {
      sync.issue = editor.issue
      setIssueBlocks(parseJournalBlocks(editor.issue))
    }
    sync.id = editor.id
  }, [editor.id, editor.completed, editor.issue])

  const applyBlocks = (key: 'completed' | 'issue', next: string[]) => {
    if (!canEdit || journalManualSavingRef.current) return
    if (key === 'completed') setCompletedBlocks(next)
    else setIssueBlocks(next)
    const serialized = serializeJournalBlocks(next)
    blocksSyncRef.current[key] = serialized
    updateEditor(key, serialized)
  }

  const focusJournalBlock = (key: 'completed' | 'issue', index: number) => {
    window.setTimeout(() => {
      document.querySelector<HTMLInputElement>(`input[data-journal-block="${key}-${index}"]`)?.focus()
    }, 0)
  }

  const renderBlockEditor = (key: 'completed' | 'issue', blocks: string[], placeholder: string, addLabel: string, minBlocks: number) => (
    <div className="journal-block-editor">
      {blocks.map((block, index) => (
        <div className="journal-block-item" key={`${key}-${index}`}>
          <span className="journal-block-index" aria-hidden="true">{index + 1}</span>
          <input
            value={block}
            disabled={journalManualSaving}
            placeholder={placeholder}
            data-journal-block={`${key}-${index}`}
            aria-label={`${index + 1}번 항목`}
            onChange={(event) => { const next = [...blocks]; next[index] = event.target.value; applyBlocks(key, next) }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'Enter') {
                event.preventDefault()
                const next = [...blocks]
                next.splice(index + 1, 0, '')
                applyBlocks(key, next)
                focusJournalBlock(key, index + 1)
              } else if (event.key === 'Backspace' && block === '' && blocks.length > minBlocks) {
                event.preventDefault()
                applyBlocks(key, blocks.filter((_, itemIndex) => itemIndex !== index))
                focusJournalBlock(key, Math.max(0, index - 1))
              }
            }}
          />
          <button
            type="button"
            className="journal-block-remove"
            aria-label={`${index + 1}번 항목 삭제`}
            disabled={journalManualSaving || (blocks.length <= minBlocks && block === '')}
            onClick={() => {
              const next = blocks.filter((_, itemIndex) => itemIndex !== index)
              applyBlocks(key, next.length >= minBlocks ? next : [''])
            }}
          ><X size={15} /></button>
        </div>
      ))}
      <button className="journal-block-add" type="button" disabled={journalManualSaving} onClick={() => { applyBlocks(key, [...blocks, '']); focusJournalBlock(key, blocks.length) }}>
        <Plus size={15} /> {addLabel}
      </button>
    </div>
  )

  const cleanupUnsavedUploads = async () => {
    const ids = [...uploadedAttachmentIdsRef.current]
    if (!ids.length) {
      removedAttachmentIdsRef.current.clear()
      return true
    }
    setAttachmentBusy(true)
    const cleanup = await deleteDocumentAttachments(ids, workspaceScope)
    setAttachmentBusy(false)
    for (const id of cleanup.deleted) uploadedAttachmentIdsRef.current.delete(id)
    if (cleanup.deleted.length) {
      const deleted = new Set(cleanup.deleted)
      setEditor((current) => ({ ...current, attachments: current.attachments.filter((attachment) => !deleted.has(attachment.id)) }))
    }
    if (cleanup.failed.length) {
      const message = `저장하지 않은 첨부 ${cleanup.failed.length}개를 정리하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요.`
      setSaveError(message)
      onToast(message)
      return false
    }
    removedAttachmentIdsRef.current.clear()
    return true
  }

  const chooseJournal = (journal: Journal) => {
    uploadedAttachmentIdsRef.current.clear()
    removedAttachmentIdsRef.current.clear()
    markJournalDirty(false)
    setSelectedId(journal.id)
    setEditor(cloneJournal(journal))
    setSaveError('')
    setJournalEditorMode('view')
    setViewMode('editor')
  }

  const createJournal = async () => {
    if (journalSavingRef.current) return
    if (journalDirty && !window.confirm('저장하지 않은 업무일지 변경사항이 있습니다. 변경사항을 버리고 새 일지를 작성할까요?')) return
    if (attachmentBusy || !(await cleanupUnsavedUploads())) return
    const todayMine = accessibleJournals.find((journal) => journal.date === scheduleToday && isJournalOwner(journal))
    if (todayMine) {
      chooseJournal(todayMine)
      if (todayMine.status === '임시저장' || todayMine.status === '반려') setJournalEditorMode('edit')
      onToast(todayMine.status === '임시저장' ? '오늘 작성 중인 임시저장 일지를 불러왔습니다. 이어서 작성하세요.' : `오늘 일지는 이미 ${todayMine.status === '결재요청' ? '결재 요청' : todayMine.status} 상태입니다. 같은 날짜에는 한 건만 작성할 수 있어 기존 일지를 열었습니다.`)
      return
    }
    const next = newJournalDraft(currentUserId, currentUserName, currentUserTeam)
    uploadedAttachmentIdsRef.current.clear()
    removedAttachmentIdsRef.current.clear()
    markJournalDirty(true)
    setSelectedId(next.id)
    setEditor(cloneJournal(next))
    setSaveError('')
    setJournalEditorMode('edit')
    setViewMode('editor')
    onToast('새 업무일지 작성 화면을 열었습니다.')
  }

  const returnToJournalList = async () => {
    if (journalSavingRef.current) return
    if (journalDirty && !window.confirm('저장하지 않은 업무일지 변경사항이 있습니다. 변경사항을 버리고 목록으로 돌아갈까요?')) return
    if (attachmentBusy || !(await cleanupUnsavedUploads())) return
    const stored = accessibleJournals.find((journal) => journal.id === selectedId)
    markJournalDirty(false)
    if (stored) setEditor(cloneJournal(stored))
    setSaveError('')
    setReviewDecision(null)
    setJournalEditorMode('view')
    setViewMode('list')
  }

  const persistJournal = async (status: JournalStatus, message: string, silent = false) => {
    if (!canEdit) {
      onToast('본인의 임시저장 또는 반려 일지만 수정할 수 있습니다.')
      return false
    }
    if (journalSavingRef.current || attachmentBusy) return false
    journalSavingRef.current = true
    journalManualSavingRef.current = true
    setJournalManualSaving(true)
    setJournalSaving(true)
    setSaveError('')
    const now = new Date().toISOString()
    const saved = { ...editor, status, updatedAt: now, ...(status === '결재요청' ? { submittedAt: now } : {}) }
    const newlyUploadedIds = [...uploadedAttachmentIdsRef.current]
    const removedDocumentIds = [...removedAttachmentIdsRef.current]
    const result = await setJournals((current) => {
      const exists = current.some((journal) => journal.id === saved.id)
      return exists ? current.map((journal) => journal.id === saved.id ? saved : journal) : [saved, ...current]
    })
    if (!result.ok) {
      const rollback = await deleteDocumentAttachments(newlyUploadedIds, workspaceScope)
      for (const id of rollback.deleted) uploadedAttachmentIdsRef.current.delete(id)
      if (rollback.deleted.length) {
        const deleted = new Set(rollback.deleted)
        setEditor((current) => ({ ...current, attachments: current.attachments.filter((attachment) => !deleted.has(attachment.id)) }))
      }
      const cleanupMessage = rollback.failed.length ? ` 첨부 ${rollback.failed.length}개 롤백에도 실패해 화면에 유지했습니다.` : ' 새로 올린 첨부는 롤백했습니다.'
      const errorMessage = (result.message ?? '업무일지를 저장하지 못했습니다. 다시 시도해 주세요.') + (newlyUploadedIds.length ? cleanupMessage : '')
      setSaveError(errorMessage)
      onToast(errorMessage)
      journalSavingRef.current = false
      journalManualSavingRef.current = false
      setJournalManualSaving(false)
      setJournalSaving(false)
      return false
    }
    uploadedAttachmentIdsRef.current.clear()
    removedAttachmentIdsRef.current.clear()
    const cleanup = await deleteDocumentAttachments(removedDocumentIds, workspaceScope)
    markJournalDirty(false)
    setEditor(cloneJournal(saved))
    journalSavingRef.current = false
    journalManualSavingRef.current = false
    setJournalManualSaving(false)
    setJournalSaving(false)
    if (cleanup.failed.length) {
      const warning = `${message} 다만 제거한 첨부 ${cleanup.failed.length}개의 원본 정리에 실패했습니다.`
      setSaveError(warning)
      onToast(warning)
    } else if (!silent) {
      onToast(message)
    }
    return true
  }

  const deleteJournalDraft = async () => {
    if (journalSavingRef.current) return false
    if (!isJournalOwner(editor) || editor.status !== '임시저장') {
      onToast('본인의 임시저장 일지만 삭제할 수 있습니다.')
      return false
    }
    if (!window.confirm(`‘${editor.title}’ 초안을 삭제할까요? 결재요청한 일지는 삭제할 수 없습니다.`)) return false
    if (attachmentBusy || !(await cleanupUnsavedUploads())) return false
    const stored = journals.find((journal) => journal.id === editor.id)
    if (stored) {
      const result = await setJournals((current) => current.filter((journal) => journal.id !== editor.id))
      if (!result.ok) {
        const message = result.message ?? '업무일지 초안을 삭제하지 못했습니다.'
        setSaveError(message)
        onToast(message)
        return false
      }
      const storedAttachmentIds = stored.attachments.filter(isStoredDocumentAttachment).map((attachment) => attachment.id)
      const cleanup = await deleteDocumentAttachments(storedAttachmentIds, workspaceScope)
      if (cleanup.failed.length) onToast(`초안은 삭제했지만 첨부 ${cleanup.failed.length}개의 원본 정리가 필요합니다.`)
      else onToast('업무일지 초안을 삭제했습니다.')
    } else {
      onToast('작성 중이던 새 초안을 닫았습니다.')
    }
    uploadedAttachmentIdsRef.current.clear()
    removedAttachmentIdsRef.current.clear()
    markJournalDirty(false)
    const remaining = journals.filter((journal) => journal.id !== editor.id && (canManage || isJournalOwner(journal)))
    const next = remaining[0] ?? newJournalDraft(currentUserId, currentUserName, currentUserTeam)
    setSelectedId(next.id)
    setEditor(cloneJournal(next))
    setSaveError('')
    setJournalEditorMode('view')
    setViewMode('list')
    return true
  }

  const draftPayload = () => {
    const current = editorStateRef.current
    return {
    ...current,
    status: '임시저장' as const,
    updatedAt: new Date().toISOString(),
    draftRevision: Math.max(journalRevisionRef.current, current.draftRevision ?? 0),
    }
  }

  const persistAutoDraft = async () => {
    if (!canEdit || journalSavingRef.current || attachmentBusy) return false
    const requestedRevision = journalRevisionRef.current
    const requestedJournalId = editor.id
    const requestedDraft = draftPayload()
    let retryAfterConflict = false
    journalSavingRef.current = true
    setJournalSaving(true)
    setAutoSaveMessage('변경사항을 자동 저장하는 중…')
    const removedDocumentIds = [...removedAttachmentIdsRef.current]
    try {
      const response = await fetch(`/api/daily-journals/${encodeURIComponent(requestedJournalId)}/draft`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}),
        },
        body: JSON.stringify({ journal: requestedDraft }),
      })
      const body = await response.json().catch(() => null) as {
        journal?: Journal
        version?: string
        draftRevision?: number
        stale?: boolean
        error?: { message?: string }
      } | null
      if (!response.ok || !body?.journal) throw new Error(body?.error?.message || '업무일지 자동 저장에 실패했습니다.')
      const saved = cloneJournal(body.journal)
      await setJournals((current) => current.some((journal) => journal.id === saved.id)
        ? current.map((journal) => journal.id === saved.id ? saved : journal)
        : [saved, ...current], { persist: false, serverVersion: body.version })
      const responseRevision = body.draftRevision ?? saved.draftRevision ?? requestedRevision
      if (body.stale) {
        journalRevisionRef.current = nextJournalRevisionAfterConflict({
          requestedRevision,
          responseRevision,
          currentRevision: journalRevisionRef.current,
        })
        retryAfterConflict = true
        setAutoSaveMessage('다른 탭의 저장을 감지했습니다. 현재 입력은 유지하고 잠시 후 다시 저장합니다.')
        return true
      }
      const canApplyToEditor = canApplyJournalAutosaveToEditor({
        requestedRevision,
        responseRevision,
        currentRevision: journalRevisionRef.current,
        requestedJournalId,
        currentJournalId: editorStateRef.current.id,
        dirty: editorDirtyRef.current,
        stale: body.stale,
      })
      if (!canApplyToEditor) {
        setAutoSaveMessage('이전 변경은 저장됐고, 새 변경사항은 다음 자동 저장을 기다립니다.')
        return true
      }
      uploadedAttachmentIdsRef.current.clear()
      removedAttachmentIdsRef.current.clear()
      markJournalDirty(false)
      setEditor(saved)
      setAutoSaveMessage(`${formatShortDateTime(saved.updatedAt)} 자동 저장됨`)
      const cleanup = await deleteDocumentAttachments(removedDocumentIds, workspaceScope)
      if (cleanup.failed.length) setSaveError(`자동 저장은 완료했지만 제거한 첨부 ${cleanup.failed.length}개의 원본 정리가 필요합니다.`)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : '업무일지 자동 저장에 실패했습니다.'
      setSaveError(message)
      setAutoSaveMessage('자동 저장에 실패했습니다. 변경사항은 화면에 남아 있습니다.')
      return false
    } finally {
      journalSavingRef.current = false
      setJournalSaving(false)
      if (retryAfterConflict) {
        if (autoSaveRetryTimerRef.current !== null) window.clearTimeout(autoSaveRetryTimerRef.current)
        autoSaveRetryTimerRef.current = window.setTimeout(() => {
          autoSaveRetryTimerRef.current = null
          if (!editorDirtyRef.current || journalSavingRef.current) return
          void autoSaveActionRef.current?.()
        }, 1_000)
      }
    }
  }

  autoSaveActionRef.current = persistAutoDraft
  flushJournalDraftRef.current = () => {
    if (!canFlushJournalDraftOnExit({
      dirty: editorDirtyRef.current,
      editable: canEdit,
      attachmentBusy,
      manualSaving: journalManualSavingRef.current,
    })) return
    const latestDraft = draftPayload()
    void fetch(`/api/daily-journals/${encodeURIComponent(latestDraft.id)}/draft`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}),
      },
      body: JSON.stringify({ journal: latestDraft }),
      keepalive: true,
    }).catch(() => { /* the 30-second saver retries while the page remains open */ })
  }

  useEffect(() => {
    if (viewMode !== 'editor' || journalEditorMode !== 'edit' || !canModifyJournal) return
    const timer = window.setInterval(() => {
      if (!editorDirtyRef.current || journalSavingRef.current) return
      void autoSaveActionRef.current?.()
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [canModifyJournal, editor.id, journalEditorMode, viewMode])

  useEffect(() => {
    const flush = () => flushJournalDraftRef.current?.()
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      if (autoSaveRetryTimerRef.current !== null) window.clearTimeout(autoSaveRetryTimerRef.current)
      flush()
    }
  }, [])

  const saveDraft = () => {
    void persistJournal('임시저장', '업무일지를 임시저장했습니다.')
  }

  const requestApproval = async () => {
    if (!journalSummaryLine(editor.completed).trim() || !editor.completed.replace(/[•\s]/g, '').trim()) {
      onToast('오늘 한 일을 한 줄 이상 입력해 주세요.')
      return
    }
    const saved = await persistJournal('결재요청', editor.approver + '님에게 결재를 요청했습니다.')
    if (saved) {
      setJournalEditorMode('view')
      setViewMode('list')
    }
  }

  const generateTodayDraft = async () => {
    if (!canEdit || aiDraftBusy || journalManualSavingRef.current) return
    if (editor.completed.replace(/[•\s]/g, '').trim() && !window.confirm('작성 중인 오늘 한 일을 오늘 기록 기반 초안으로 바꿀까요?')) return
    const requestedRevision = journalRevisionRef.current
    const requestedJournalId = editor.id
    setAiDraftBusy(true)
    setSaveError('')
    try {
      const response = await fetch('/api/daily-journals/draft', {
        method: 'POST',
        headers: workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined,
      })
      const body = await response.json().catch(() => null) as {
        draft?: string
        sourceCount?: number
        mode?: 'claude' | 'grounded-fallback' | 'grounded-empty'
        message?: string
        error?: { message?: string }
      } | null
      if (!response.ok) throw new Error(body?.error?.message || '오늘 기록 초안을 만들지 못했습니다.')
      if (!body?.draft || !body.sourceCount) {
        onToast(body?.message || '오늘 완료 보고하거나 결재한 업무가 없어 초안을 만들지 않았습니다.')
        return
      }
      const modes = journalModeRef.current
      if (!canApplyGeneratedJournalDraft({
        requestedRevision,
        currentRevision: journalRevisionRef.current,
        requestedJournalId,
        currentJournalId: editorStateRef.current.id,
        currentStatus: editorStateRef.current.status,
        viewMode: modes.viewMode,
        editorMode: modes.journalEditorMode,
        manualSaving: journalManualSavingRef.current,
      })) {
        onToast('AI 초안을 만드는 동안 입력이 변경되어 현재 내용을 유지했습니다. 필요하면 다시 초안을 만들어 주세요.')
        return
      }
      updateEditor('completed', normalizeJournalBullets(body.draft))
      const sourceLabel = `${body.sourceCount}건의 오늘 기록`
      onToast(body.mode === 'claude' ? `${sourceLabel}으로 AI 초안을 만들었습니다.` : `${sourceLabel}으로 근거 기반 초안을 만들었습니다.`)
    } catch (error) {
      const message = error instanceof Error ? error.message : '오늘 기록 초안을 만들지 못했습니다.'
      setSaveError(message)
      onToast(message)
    } finally {
      setAiDraftBusy(false)
    }
  }

  const handleApproval = async (status: '승인' | '반려', comment: string) => {
    if (!canManage || editor.status !== '결재요청') {
      onToast('관리자만 결재 대기 일지를 승인하거나 반려할 수 있습니다.')
      return
    }
    if (comment.trim().length < 2 || reviewSubmitting) return
    setReviewSubmitting(true)
    try {
      const response = await fetch(`/api/daily-journals/${encodeURIComponent(editor.id)}/review`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}),
        },
        body: JSON.stringify({ decision: status === '승인' ? 'approve' : 'reject', comment: comment.trim() }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { message?: string } } | null
        onToast(body?.error?.message ?? '업무일지 결재를 처리하지 못했습니다.')
        return
      }
      const body = await response.json() as { journal: Journal; version?: string }
      const next = cloneJournal(body.journal)
      await setJournals((current) => current.map((journal) => journal.id === next.id ? next : journal), { persist: false, serverVersion: body.version })
      markJournalDirty(false)
      setEditor(next)
      setReviewDecision(null)
      setJournalEditorMode('view')
      setViewMode('list')
      onToast(status === '승인' ? (comment.trim() ? '메모와 함께 업무일지를 승인했습니다.' : '업무일지를 승인했습니다.') : '보완 코멘트와 함께 업무일지를 반려했습니다.')
    } catch {
      onToast('업무일지 결재 서버에 연결하지 못했습니다.')
    } finally {
      setReviewSubmitting(false)
    }
  }

  const [attachmentDropActive, setAttachmentDropActive] = useState(false)
  const [commentText, setCommentText] = useState('')
  const [commentAttachments, setCommentAttachments] = useState<JournalAttachment[]>([])
  const [commentBusy, setCommentBusy] = useState(false)
  const [commentUploading, setCommentUploading] = useState(false)
  const commentFileRef = useRef<HTMLInputElement>(null)
  const isNewUnsavedJournal = !journals.some((journal) => journal.id === editor.id)
  const attachCommentFiles = async (files: File[]) => {
    if (commentAttachments.length + files.length > 10) { onToast('댓글에는 파일을 최대 10개까지 첨부할 수 있습니다.'); return }
    setCommentUploading(true)
    try {
      const added = await uploadDocumentAttachments(files, { workspaceScope, category: '일일업무일지', summary: `${editor.date} ${editor.author} 업무일지 댓글 첨부`, tags: ['업무일지', '댓글'] })
      setCommentAttachments((current) => [...current, ...added])
    } catch (error) { onToast(error instanceof Error ? error.message : '파일을 업로드하지 못했습니다.') }
    finally { setCommentUploading(false) }
  }
  const submitJournalComment = async () => {
    if (commentBusy || (!commentText.trim() && commentAttachments.length === 0)) return
    setCommentBusy(true)
    try {
      const response = await fetch(`/api/daily-journals/${encodeURIComponent(editor.id)}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}) },
        body: JSON.stringify({ text: commentText.trim(), attachments: commentAttachments }),
      })
      const body = await response.json().catch(() => null) as { journal?: Journal; version?: string; error?: { message?: string } } | null
      if (!response.ok || !body?.journal) { onToast(body?.error?.message ?? '댓글을 남기지 못했습니다.'); return }
      const next = cloneJournal(body.journal)
      await setJournals((current) => current.map((journal) => journal.id === next.id ? next : journal), { persist: false, serverVersion: body.version })
      setEditor((current) => ({ ...current, comments: next.comments ?? [] }))
      setCommentText('')
      setCommentAttachments([])
      onToast('댓글을 남겼습니다.')
    } catch { onToast('댓글 서버에 연결하지 못했습니다.') }
    finally { setCommentBusy(false) }
  }
  const deleteJournalComment = async (comment: JournalComment) => {
    if (!window.confirm('이 댓글을 삭제할까요?')) return
    setCommentBusy(true)
    try {
      const response = await fetch(`/api/daily-journals/${encodeURIComponent(editor.id)}/comments/${encodeURIComponent(comment.id)}`, { method: 'DELETE', headers: workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined })
      const body = await response.json().catch(() => null) as { journal?: Journal; version?: string; error?: { message?: string } } | null
      if (!response.ok || !body?.journal) { onToast(body?.error?.message ?? '댓글을 삭제하지 못했습니다.'); return }
      const next = cloneJournal(body.journal)
      await setJournals((current) => current.map((journal) => journal.id === next.id ? next : journal), { persist: false, serverVersion: body.version })
      setEditor((current) => ({ ...current, comments: next.comments ?? [] }))
    } catch { onToast('댓글 서버에 연결하지 못했습니다.') }
    finally { setCommentBusy(false) }
  }
  const attachFileList = async (files: File[]) => {
    if (!canEdit || attachmentBusy || journalManualSavingRef.current || files.length === 0) return
    if (editor.attachments.length + files.length > 20) {
      const message = '업무일지에는 첨부파일을 최대 20개까지 등록할 수 있습니다.'
      setSaveError(message)
      onToast(message)
      return
    }
    setAttachmentBusy(true)
    setSaveError('')
    try {
      const additions = await uploadDocumentAttachments(files, { workspaceScope, category: '일일업무일지', summary: `${editor.date} ${editor.author} 업무일지 첨부`, tags: ['업무일지', editor.department] })
      for (const attachment of additions) uploadedAttachmentIdsRef.current.add(attachment.id)
      markJournalDirty(true)
      setEditor((current) => ({ ...current, attachments: [...current.attachments, ...additions] }))
    } catch (error) {
      const message = error instanceof Error ? error.message : '파일을 업로드하지 못했습니다.'
      setSaveError(message)
      onToast(message)
    } finally { setAttachmentBusy(false) }
  }
  const attachFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    if (!canEdit || attachmentBusy || journalManualSavingRef.current) return
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (files.length === 0) return
    if (editor.attachments.length + files.length > 20) {
      const message = '업무일지에는 첨부파일을 최대 20개까지 등록할 수 있습니다.'
      setSaveError(message)
      onToast(message)
      return
    }
    setAttachmentBusy(true)
    setSaveError('')
    try {
      const additions = await uploadDocumentAttachments(files, {
        workspaceScope,
        category: '일일업무일지',
        summary: `${editor.date} ${editor.author} 업무일지 첨부`,
        tags: ['업무일지', editor.department],
      })
      for (const attachment of additions) uploadedAttachmentIdsRef.current.add(attachment.id)
      markJournalDirty(true)
      setEditor((current) => ({ ...current, attachments: [...current.attachments, ...additions] }))
      onToast(`${additions.length}개 파일 원본을 안전하게 첨부했습니다.`)
    } catch (error) {
      const message = error instanceof Error ? error.message : '첨부파일을 업로드하지 못했습니다.'
      setSaveError(message)
      onToast(message)
    } finally {
      setAttachmentBusy(false)
    }
  }

  const removeAttachment = async (attachment: JournalAttachment) => {
    if (!canEdit || attachmentBusy || journalManualSavingRef.current) return
    if (isStoredDocumentAttachment(attachment) && uploadedAttachmentIdsRef.current.has(attachment.id)) {
      setAttachmentBusy(true)
      try {
        await deleteDocumentAttachment(attachment.id, workspaceScope)
        uploadedAttachmentIdsRef.current.delete(attachment.id)
      } catch (error) {
        const message = error instanceof Error ? error.message : '첨부파일을 삭제하지 못했습니다.'
        setSaveError(message)
        onToast(message)
        setAttachmentBusy(false)
        return
      }
      setAttachmentBusy(false)
    } else if (isStoredDocumentAttachment(attachment)) {
      removedAttachmentIdsRef.current.add(attachment.id)
    }
    markJournalDirty(true)
    setEditor((current) => ({ ...current, attachments: current.attachments.filter((item) => item.id !== attachment.id) }))
  }

  const downloadAttachment = async (attachment: JournalAttachment) => {
    if (downloadingAttachmentId) return
    setDownloadingAttachmentId(attachment.id)
    try {
      await downloadDocumentAttachment(attachment, workspaceScope)
    } catch (error) {
      const message = error instanceof Error ? error.message : '첨부파일을 내려받지 못했습니다.'
      setSaveError(message)
      onToast(message)
    } finally {
      setDownloadingAttachmentId('')
    }
  }

  const statusCount = (status: JournalStatus) => accessibleJournals.filter((journal) => journal.status === status).length
  const journalWeekStart = (() => {
    const date = new Date(`${scheduleToday}T00:00:00+09:00`)
    const day = date.getDay()
    date.setDate(date.getDate() - (day === 0 ? 6 : day - 1))
    return seoulDateInputValue(date)
  })()
  const weeklyApprovalCount = accessibleJournals.filter((journal) => journal.status === '승인' && journal.date >= journalWeekStart && journal.date <= scheduleToday).length
  const reviewHistory: JournalReview[] = editor.reviews?.length
    ? editor.reviews
    : editor.feedback && (editor.status === '승인' || editor.status === '반려')
      ? [{ id: `legacy-${editor.id}`, decision: editor.status, comment: editor.feedback, reviewedAt: editor.updatedAt, reviewerId: '', reviewerName: editor.approver }]
      : []

  return (
    <div className="collab-page journal-page">
      <CollabPageHeader
        kicker="DAILY WORK JOURNAL"
        title="일일업무일지"
        description={canManage ? '직원 일지를 검토·결재하고 나의 업무 기록도 함께 관리합니다.' : '나의 업무 결과와 이슈를 기록하고 관리자에게 결재를 요청합니다.'}
        actions={(
          <div className="journal-header-actions">
            <div className="journal-summary-chips" aria-label="업무일지 현황">
              {([
                ['임시저장', '임시저장', statusCount('임시저장'), 'amber'],
                ['결재요청', '결재 대기', statusCount('결재요청'), 'blue'],
                ['승인', '이번 주 승인', weeklyApprovalCount, 'green'],
                ['반려', '보완 필요', statusCount('반려'), 'red'],
              ] as Array<[JournalStatus, string, number, string]>).map(([status, label, count, tone]) => (
                <button key={status} className={`journal-summary-chip ${tone}`} type="button" disabled={journalSaving} onClick={() => { setFilter(status); setViewMode('list') }}>
                  <span>{label}</span><strong>{count}</strong>
                </button>
              ))}
            </div>
            <Button tone="primary" type="button" onClick={() => void createJournal()} disabled={attachmentBusy || journalSaving}><Plus size={18} /> 새 일지</Button>
          </div>
        )}
      />

      <div className={'journal-workspace ' + (viewMode === 'list' ? 'list-only' : 'editor-only')}>
        {viewMode === 'list' && <section className="collab-panel journal-browse-panel" aria-label="업무일지 조회">
          <div className="journal-browse-toolbar">
            <div className="journal-browse-tabs" role="tablist" aria-label="일지 보기 방식">
              <button type="button" role="tab" aria-selected={browseMode === 'week'} onClick={() => setBrowseMode('week')}><CalendarDays size={17} /> 주간 보드</button>
              <button type="button" role="tab" aria-selected={browseMode === 'all'} onClick={() => setBrowseMode('all')}><CalendarDays size={17} /> 월간 달력</button>
            </div>
            {browseMode === 'week' ? (
              <div className="journal-week-nav">
                <button type="button" aria-label="이전 주" onClick={() => moveWeek(-1)}><ChevronLeft size={19} /></button>
                <strong>{weekLabel}</strong>
                <button type="button" aria-label="다음 주" onClick={() => moveWeek(1)}><ChevronRight size={19} /></button>
                {weekAnchor !== scheduleToday && <button className="journal-week-today" type="button" onClick={() => setWeekAnchor(scheduleToday)}>이번 주</button>}
              </div>
            ) : (
              <div className="journal-search-controls">
                <div className="journal-week-nav">
                  <button type="button" aria-label="이전 달" onClick={() => moveMonth(-1)}><ChevronLeft size={19} /></button>
                  <strong>{monthLabel}</strong>
                  <button type="button" aria-label="다음 달" onClick={() => moveMonth(1)}><ChevronRight size={19} /></button>
                  {monthAnchor !== scheduleToday.slice(0, 7) && <button className="journal-week-today" type="button" onClick={() => setMonthAnchor(scheduleToday.slice(0, 7))}>이번 달</button>}
                </div>
                <label className="collab-search">
                  <Search size={18} />
                  <span className="sr-only">업무일지 검색</span>
                  <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="작성자·업무 내용 검색" />
                </label>
                {canManage && journalAuthors.length > 1 && <label className="journal-range-field"><span>작성자</span><select value={authorFilter} onChange={(event) => setAuthorFilter(event.target.value)}><option>전체</option>{journalAuthors.map((name) => <option key={name}>{name}</option>)}</select></label>}
              </div>
            )}
            <div className="journal-filter" role="group" aria-label="업무일지 상태">
              {(['전체', '임시저장', '결재요청', '승인', '반려'] as JournalFilter[]).map((item) => (
                <button type="button" className={filter === item ? 'active' : ''} aria-pressed={filter === item} onClick={() => setFilter(item)} key={item}>{item}</button>
              ))}
            </div>
          </div>

          {browseMode === 'week' ? (
            <div className="journal-week-board" role="grid" aria-label={`${weekLabel} 주간 업무일지 보드`}>
              {weekDays.map((day) => {
                const dayJournals = browseFiltered
                  .filter((journal) => journal.date === day.key)
                  .sort((left, right) => left.author.localeCompare(right.author, 'ko') || left.updatedAt.localeCompare(right.updatedAt))
                const isToday = day.key === scheduleToday
                return <div className={`journal-week-day${isToday ? ' is-today' : ''}${day.kind === 'holiday' || day.kind === 'sunday' ? ' is-holiday-day' : day.kind === 'saturday' ? ' is-saturday' : ''}`} role="gridcell" key={day.key}>
                  <header>
                    <span className="journal-week-dayname">{day.weekdayName}</span>
                    <strong>{day.label}</strong>
                    {isToday && <em>오늘</em>}
                    {day.holiday && <small className="journal-week-holiday" title={day.holiday}>{day.holiday}</small>}
                  </header>
                  <div className="journal-week-blocks">
                    {dayJournals.map((journal) => (
                      <button className={`journal-week-block tone-${journalTone(journal.status)}`} type="button" key={journal.id} onClick={() => chooseJournal(journal)} aria-label={`${journal.author}님의 ${day.key} ${journal.status} 업무일지 열기`}>
                        <span className="journal-week-block-head"><i aria-hidden="true">{journal.author.slice(0, 1)}</i><strong>{journal.author}</strong><em className={`journal-block-status ${journalTone(journal.status)}`}>{journal.status}</em></span>
                        <span className="journal-week-block-summary">{journalSummaryLine(journal.completed)}</span>
                        <time dateTime={journal.updatedAt}>{formatShortDateTime(journal.updatedAt)} 저장</time>
                      </button>
                    ))}
                    {dayJournals.length === 0 && <span className="journal-week-empty">{day.kind === 'weekday' ? '일지 없음' : '휴무'}</span>}
                  </div>
                </div>
              })}
            </div>
          ) : (
            <div className="journal-month" aria-label={`${monthLabel} 업무일지 달력`}>
              <div className="journal-month-weekdays" aria-hidden="true">{['월', '화', '수', '목', '금', '토', '일'].map((name, index) => <span key={name} className={index === 5 ? 'is-saturday' : index === 6 ? 'is-holiday-day' : ''}>{name}</span>)}</div>
              <div className="journal-month-grid" role="grid">
                {monthCells.map((cell, index) => {
                  if (!cell) return <div className="journal-month-cell is-blank" key={`blank-${index}`} aria-hidden="true" />
                  const dayJournals = sortedJournals.filter((journal) => journal.date === cell.key)
                  const isToday = cell.key === scheduleToday
                  const toneClass = cell.kind === 'holiday' || cell.kind === 'sunday' ? ' is-holiday-day' : cell.kind === 'saturday' ? ' is-saturday' : ''
                  return <div className={`journal-month-cell${isToday ? ' is-today' : ''}${toneClass}`} role="gridcell" key={cell.key}>
                    <header><strong>{cell.day}</strong>{isToday && <em>오늘</em>}{cell.holiday && <small title={cell.holiday}>{cell.holiday}</small>}</header>
                    <div className="journal-month-blocks">
                      {dayJournals.slice(0, 4).map((journal) => (
                        <button className={`journal-month-block tone-${journalTone(journal.status)}`} type="button" key={journal.id} onClick={() => chooseJournal(journal)} title={`${journal.author} · ${journal.status} · ${journalSummaryLine(journal.completed)}`} aria-label={`${journal.author}님의 ${cell.key} ${journal.status} 업무일지 열기`}>
                          <i aria-hidden="true">{journal.author.slice(0, 1)}</i><strong>{journal.author}</strong><em>{journal.status}</em>
                        </button>
                      ))}
                      {dayJournals.length > 4 && <button type="button" className="journal-month-more" onClick={() => { setWeekAnchor(cell.key); setBrowseMode('week') }}>+{dayJournals.length - 4}건 더 보기</button>}
                    </div>
                  </div>
                })}
              </div>
              {sortedJournals.length === 0 && <div className="collab-empty compact"><BookOpenCheck size={28} /><strong>{monthLabel}에 해당 일지가 없습니다</strong><span>달을 이동하거나 검색어·상태 필터를 바꿔 보세요.</span></div>}
            </div>
          )}
        </section>}

        {viewMode === 'editor' && <section className="collab-panel journal-editor-panel" aria-labelledby="journal-editor-title">
          <header className="journal-editor-header">
            <div>
              <div className="journal-editor-meta"><StatusChip tone={journalTone(editor.status)}>{editor.status}</StatusChip><span>{editor.id}</span><span>{formatJournalTimestamp(editor.updatedAt)} 저장</span></div>
              <h2 id="journal-editor-title">{editor.title}</h2>
              <p>{editor.author} · {editor.department} · 결재자 {editor.approver}</p>
            </div>
            <div className="journal-editor-header-actions">
              {canModifyJournal && !canEdit && <Button tone="ghost" size="sm" type="button" onClick={() => setJournalEditorMode('edit')}><Edit3 size={17} /> 수정하기</Button>}
              <Button tone="ghost" size="sm" type="button" onClick={() => void returnToJournalList()} disabled={attachmentBusy || journalSaving}><ArrowLeft size={17} /> 목록으로</Button>
            </div>
          </header>

          {saveError && <div className="journal-save-error" role="alert"><AlertCircle size={19} /><span>{saveError}</span></div>}

          {(editor.status === '반려' || (editor.status === '임시저장' && editor.feedback && reviewHistory.at(-1)?.decision === '반려')) && (
            <div className="journal-feedback red">
              <AlertCircle size={21} />
              <div><strong>결재자가 보완을 요청했습니다</strong><p>{editor.feedback}</p></div>
            </div>
          )}
          {editor.status === '승인' && (
            <div className="journal-feedback green">
              <ShieldCheck size={21} />
              <div><strong>{editor.approver} 승인 완료</strong><p>{editor.feedback}</p></div>
            </div>
          )}
          {editor.status === '결재요청' && (
            <div className="journal-feedback blue">
              <Clock3 size={21} />
              <div><strong>{editor.approver} 결재 대기 중</strong><p>결재 요청 후 내용은 승인 또는 반려 전까지 읽기 전용입니다.</p></div>
            </div>
          )}

          {reviewHistory.length > 0 && (
            <section className="journal-review-history" aria-labelledby="journal-review-history-title">
              <div className="journal-review-history-head">
                <div><span className="collab-kicker">APPROVAL HISTORY</span><h3 id="journal-review-history-title">결재 코멘트 이력</h3></div>
                <span>{reviewHistory.length}건</span>
              </div>
              <ol>
                {[...reviewHistory].reverse().map((review) => (
                  <li key={review.id}>
                    <span className={'journal-review-marker ' + (review.decision === '승인' ? 'green' : 'red')}>
                      {review.decision === '승인' ? <Check size={16} /> : <X size={16} />}
                    </span>
                    <div>
                      <div><StatusChip tone={review.decision === '승인' ? 'green' : 'red'}>{review.decision}</StatusChip><strong>{review.reviewerName}</strong><time>{formatJournalReviewTime(review.reviewedAt)}</time></div>
                      <p>{review.comment}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <div className="journal-editor-body">
            <section className="journal-entry-section" aria-labelledby="journal-completed-title">
              <div className="journal-entry-section-head">
                <div><strong id="journal-completed-title">1. 오늘 한 일 <em>필수</em></strong><span>한 일을 블록으로 쌓으세요. Enter로 다음 블록이 추가됩니다.</span></div>
                {canEdit && <Button tone="ghost" size="sm" type="button" onClick={() => void generateTodayDraft()} disabled={aiDraftBusy || journalSaving}><WandSparkles size={17} /> {aiDraftBusy ? '초안 만드는 중…' : '오늘 기록으로 초안 만들기'}</Button>}
              </div>
              {canEdit ? renderBlockEditor('completed', completedBlocks, '완료한 업무를 결과 중심으로 입력', '한 일 추가', 1) : (
                <div className="journal-entry-readonly">
                  {editor.completed.split(/\r?\n/).map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean).map((line, index) => <p key={`${line}-${index}`}><span>{index + 1}</span>{line}</p>)}
                  {!editor.completed.trim() && <span>기록된 업무가 없습니다.</span>}
                </div>
              )}
            </section>

            <section className="journal-entry-section" aria-labelledby="journal-issue-title">
              <div className="journal-entry-section-head"><div><strong id="journal-issue-title">2. 특이사항·막힌 것 <em>선택</em></strong><span>도움이나 공유가 필요한 내용만 블록으로 추가하세요.</span></div></div>
              {canEdit
                ? renderBlockEditor('issue', issueBlocks, '공유할 특이사항 또는 막힌 일', '특이사항 추가', 0)
                : <div className="journal-entry-readonly">
                  {editor.issue.split(/\r?\n/).map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean).map((line, index) => <p key={`${line}-${index}`}><span>{index + 1}</span>{line}</p>)}
                  {!editor.issue.trim() && <span>등록된 특이사항이 없습니다.</span>}
                </div>}
            </section>

            <section className={`journal-attachments journal-entry-section${attachmentDropActive ? ' is-drop-active' : ''}`} aria-labelledby="journal-attachment-title"
              onDragOver={(event) => { if (!canEdit) return; event.preventDefault(); setAttachmentDropActive(true) }}
              onDragLeave={() => setAttachmentDropActive(false)}
              onDrop={(event) => { if (!canEdit) return; event.preventDefault(); setAttachmentDropActive(false); const files = Array.from(event.dataTransfer?.files ?? []); if (files.length) void attachFileList(files) }}>
              <div className="journal-attachment-head">
                <div><h3 id="journal-attachment-title">3. 사진·파일 <em>선택</em></h3><p>파일을 블록으로 쌓습니다. 여러 개를 한 번에 고르거나 이 영역에 끌어다 놓으세요.</p></div>
                {canEdit && <input ref={fileInputRef} className="sr-only" type="file" aria-labelledby="journal-attachment-title" multiple disabled={journalManualSaving} onChange={attachFiles} />}
              </div>
              <div className="journal-block-list journal-file-blocks">
                {editor.attachments.map((attachment, index) => (
                  <div className="journal-block-item journal-file-block" key={attachment.id}>
                    <span className="journal-block-index"><FileText size={14} /></span>
                    <div className="journal-file-block-body"><strong>{attachment.name}</strong><small>{index + 1}번 파일 · {attachment.size} · {isStoredDocumentAttachment(attachment) ? '원본 저장됨' : '이전 파일 정보'}</small></div>
                    <div className="journal-attachment-actions">
                      {isStoredDocumentAttachment(attachment) && <button type="button" aria-label={attachment.name + ' 다운로드'} disabled={Boolean(downloadingAttachmentId)} onClick={() => void downloadAttachment(attachment)}><Download size={18} /></button>}
                      {canEdit && <button type="button" aria-label={attachment.name + ' 삭제'} disabled={attachmentBusy || journalManualSaving} onClick={() => void removeAttachment(attachment)}><X size={18} /></button>}
                    </div>
                  </div>
                ))}
                {canEdit
                  ? <button className="journal-block-add" type="button" onClick={() => fileInputRef.current?.click()} disabled={attachmentBusy || journalManualSaving}><Plus size={16} /> {attachmentBusy ? '업로드 중…' : editor.attachments.length ? '파일 블록 추가' : '파일 블록 추가 (여러 개 가능)'}</button>
                  : editor.attachments.length === 0 && <div className="journal-no-attachment"><Paperclip size={20} /><span>첨부된 파일이 없습니다.</span></div>}
              </div>
            </section>

            {!isNewUnsavedJournal && <section className="journal-comments journal-entry-section" aria-labelledby="journal-comments-title">
              <div className="journal-attachment-head">
                <div><h3 id="journal-comments-title">4. 댓글 <em>{editor.comments?.length ? `${editor.comments.length}개` : '선택'}</em></h3><p>{canManage ? '작성자와 결재자가 글과 파일로 이야기를 이어갑니다.' : '결재자에게 묻거나 보충 자료를 댓글로 남기세요.'}</p></div>
              </div>
              <div className="journal-comment-list">
                {(editor.comments ?? []).map((comment) => <article className="journal-comment" key={comment.id}>
                  <i className="journal-comment-avatar">{comment.author.slice(0, 1)}</i>
                  <div>
                    <span className="journal-comment-head"><strong>{comment.author}</strong><time dateTime={comment.createdAt}>{formatShortDateTime(comment.createdAt)}</time>{(comment.authorId === currentUserId || canManage) && <button type="button" aria-label="댓글 삭제" disabled={commentBusy} onClick={() => void deleteJournalComment(comment)}><X size={14} /></button>}</span>
                    {comment.text && <p>{comment.text}</p>}
                    {comment.attachments.length > 0 && <span className="journal-comment-files">{comment.attachments.map((attachment) => <button type="button" key={attachment.id} onClick={() => void downloadAttachment(attachment)}><Download size={13} /> {attachment.name} <small>{attachment.size}</small></button>)}</span>}
                  </div>
                </article>)}
                {(editor.comments ?? []).length === 0 && <p className="journal-comment-empty">아직 댓글이 없습니다.</p>}
              </div>
              <form className="journal-comment-composer" onSubmit={(event) => { event.preventDefault(); void submitJournalComment() }}>
                <textarea rows={2} value={commentText} maxLength={2000} onChange={(event) => setCommentText(event.target.value)} placeholder="댓글을 남기거나 파일을 첨부하세요 (Enter는 줄바꿈)" disabled={commentBusy} />
                <div className="journal-comment-tools">
                  <input ref={commentFileRef} className="sr-only" type="file" multiple onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; if (files.length) void attachCommentFiles(files) }} />
                  <div className="journal-comment-attachments">
                    {commentAttachments.map((attachment) => <span key={attachment.id}><Paperclip size={13} /> {attachment.name}<button type="button" aria-label={attachment.name + ' 제외'} onClick={() => setCommentAttachments((current) => current.filter((item) => item.id !== attachment.id))}><X size={12} /></button></span>)}
                    <button type="button" className="journal-comment-attach" disabled={commentBusy || commentUploading} onClick={() => commentFileRef.current?.click()}><Upload size={14} /> {commentUploading ? '업로드 중…' : '파일'}</button>
                  </div>
                  <Button tone="primary" size="sm" type="submit" disabled={commentBusy || commentUploading || (!commentText.trim() && commentAttachments.length === 0)}><Send size={15} /> {commentBusy ? '남기는 중…' : '댓글 남기기'}</Button>
                </div>
              </form>
            </section>}
          </div>

          <footer className="journal-editor-footer">
            {canEdit ? (
              <>
                <span>{autoSaveMessage}</span>
                <div>
                  {editor.status === '임시저장' && <Button tone="danger" type="button" onClick={() => void deleteJournalDraft()} disabled={journalSaving || attachmentBusy}><Trash2 size={18} /> 초안 삭제</Button>}
                  <Button tone="ghost" type="button" onClick={saveDraft} disabled={journalSaving || attachmentBusy}><Save size={18} /> {journalSaving ? '저장 중…' : '임시저장'}</Button>
                  <Button tone="primary" type="button" onClick={() => void requestApproval()} disabled={journalSaving || attachmentBusy}><Send size={18} /> {journalSaving ? '저장 중…' : editor.status === '반려' ? '보완 후 재결재 요청' : '결재요청'}</Button>
                </div>
              </>
            ) : canModifyJournal ? (
              <>
                <span>현재 조회 화면입니다. 내용을 변경하려면 수정하기를 선택하세요.</span>
                <Button tone="primary" type="button" onClick={() => setJournalEditorMode('edit')}><Edit3 size={18} /> 수정하기</Button>
              </>
            ) : editor.status === '결재요청' && canManage ? (
              <>
                <span>관리자 결재 처리</span>
                <div>
                  <Button tone="danger" type="button" onClick={() => setReviewDecision('반려')}><X size={18} /> 코멘트 후 반려</Button>
                  <Button tone="primary" type="button" onClick={() => setReviewDecision('승인')}><Check size={18} /> 코멘트 후 승인</Button>
                </div>
              </>
            ) : (
              <><span>{editor.status === '결재요청' ? '관리자 결재를 기다리고 있습니다.' : editor.status === '승인' ? '승인된 업무일지는 수정할 수 없습니다.' : '업무일지 처리 완료'}</span><StatusChip tone={journalTone(editor.status)}>{editor.status}</StatusChip></>
            )}
          </footer>
        </section>}
      </div>
      {reviewDecision && (
        <JournalReviewDialog
          decision={reviewDecision}
          submitting={reviewSubmitting}
          onSubmit={(comment) => void handleApproval(reviewDecision, comment)}
          onClose={() => { if (!reviewSubmitting) setReviewDecision(null) }}
        />
      )}
    </div>
  )
}

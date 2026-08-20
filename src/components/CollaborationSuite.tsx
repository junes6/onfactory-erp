import {
  AlertCircle,
  ArrowLeft,
  BookOpenCheck,
  Building2,
  CalendarDays,
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
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent, ReactNode } from 'react'
import { useWorkspaceState } from '../hooks/useWorkspaceState'
import { formatDateLabel, formatDateTime, formatShortDateTime, formatYearMonthLabel, seoulDateInputValue } from '../utils/dateTime'
import {
  deleteDocumentAttachment,
  deleteDocumentAttachments,
  downloadDocumentAttachment,
  isStoredDocumentAttachment,
  uploadDocumentAttachments,
} from '../utils/documentAttachments'
import './CollaborationSuite.css'

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
}

type ChatMessage = {
  id: string
  senderId: string
  senderName: string
  text: string
  time: string
  readBy?: string[]
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
}

type MessengerListMode = 'recent' | 'teams' | 'people'

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
  const attachmentInputRef = useRef<HTMLInputElement>(null)
  const [listMode, setListMode] = useState<MessengerListMode>('recent')
  const [mobilePane, setMobilePane] = useState<'list' | 'chat'>('list')
  const [showConversationMenu, setShowConversationMenu] = useState(false)
  const [conversationAction, setConversationAction] = useState<'leave' | 'delete' | null>(null)
  const [conversationActionPending, setConversationActionPending] = useState(false)
  const messageEndRef = useRef<HTMLDivElement>(null)

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
        return response.json() as Promise<{ members?: Array<{ id: string; name: string; team: string; role: string; status: Person['status'] }> }>
      })
      .then(({ members }) => {
        if (!active || !Array.isArray(members)) return
        setDirectory(members.map((member) => ({ ...member, accountId: member.id })))
      })
      .catch(() => undefined)
    return () => { active = false }
  }, [open])

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
    const interval = window.setInterval(refresh, 5_000)
    return () => { active = false; window.clearInterval(interval) }
  }, [open, setConversations, workspaceScope])

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
    if (!text || !activeConversation || messageSending) return
    setMessageSending(true)
    try {
      const response = await fetch(`/api/messenger/conversations/${encodeURIComponent(activeConversation.id)}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}),
        },
        body: JSON.stringify({ text }),
      })
      const body = await response.json().catch(() => null) as { conversation?: Conversation; error?: { message?: string } } | null
      if (!response.ok || !body?.conversation) {
        onToast(body?.error?.message ?? '메시지를 보내지 못했습니다.')
        return
      }
      await replaceConversationLocally(body.conversation)
      setMessage('')
    } catch {
      onToast('메신저 서버에 연결하지 못해 메시지를 보내지 않았습니다.')
    } finally {
      setMessageSending(false)
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

  const chooseAttachment = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > 10 * 1024 * 1024) { onToast('첨부파일은 10MB 이하로 선택해 주세요.'); return }
    const size = file.size >= 1024 * 1024 ? `${(file.size / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(file.size / 1024))}KB`
    setMessage((current) => `${current}${current.trim() ? '\n' : ''}📎 ${file.name} (${size})`)
    onToast('첨부파일을 메시지에 추가했습니다. 로컬 버전은 파일 메타데이터를 기록합니다.')
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
              <button
                className="collab-button primary full"
                type="button"
                onClick={() => { setListMode('people'); setQuery('') }}
              >
                <UserPlus size={18} /> 새 대화
              </button>
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
                      <span><strong>{person.name}</strong><small>{person.team} · {person.role}</small></span>
                      <MessageCircle size={18} aria-hidden="true" />
                    </button>
                  ))}
                </>
              ) : (
                <>
                  <div className="messenger-list-label">{listMode === 'teams' ? '팀 대화' : '최근 대화'} {filteredConversations.length}개</div>
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
              <div><strong>{conversationName(selectedConversation)}</strong><span>{conversationSubtitle(selectedConversation)}</span></div>
              {activeConversation && (
                <div className="messenger-room-actions">
                  <button type="button" aria-label="대화방 관리" aria-expanded={showConversationMenu} onClick={() => setShowConversationMenu((current) => !current)}><MoreHorizontal size={20} /></button>
                  {showConversationMenu && (
                    <div className="messenger-room-menu">
                      <button type="button" onClick={() => { setConversationAction('leave'); setShowConversationMenu(false) }}><LogOut size={17} /> 대화방 나가기</button>
                      {canManage && <button className="danger" type="button" onClick={() => { setConversationAction('delete'); setShowConversationMenu(false) }}><Trash2 size={17} /> 대화방 삭제</button>}
                    </div>
                  )}
                </div>
              )}
            </header>

            <div className="messenger-messages" aria-live="polite">
              <div className="messenger-date-divider"><span>오늘</span></div>
              {selectedConversation.messages.length === 0 && (
                <div className="collab-empty"><MessageCircle size={32} /><strong>첫 메시지를 보내세요</strong><span>업무 내용과 파일을 안전하게 공유할 수 있습니다.</span></div>
              )}
              {selectedConversation.messages.map((item) => {
                const mine = currentIdentityIds.includes(item.senderId) || item.senderId === 'me'
                return (
                  <article className={'messenger-message' + (mine ? ' mine' : '')} key={item.id}>
                    {!mine && <Avatar name={item.senderName} compact />}
                    <div>
                      {!mine && <strong>{item.senderName}</strong>}
                      <div className="messenger-bubble-row">
                        {mine && <span className="messenger-message-meta"><small>{selectedConversation.type === 'direct' && item.readBy?.some((readerId) => !currentIdentityIds.includes(readerId)) ? '읽음' : '안 읽음'}</small><time>{item.time}</time></span>}
                        <p>{item.text}</p>
                        {!mine && <time>{item.time}</time>}
                      </div>
                    </div>
                  </article>
                )
              })}
              <div ref={messageEndRef} />
            </div>

            <form className="messenger-composer" onSubmit={sendMessage}>
              <input ref={attachmentInputRef} className="sr-only" type="file" accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt" onChange={chooseAttachment} />
              <button type="button" aria-label="파일 첨부" disabled={!activeConversation} onClick={() => attachmentInputRef.current?.click()}><Paperclip size={20} /></button>
              <label>
                  <span className="sr-only">{conversationName(selectedConversation)}에게 메시지 작성</span>
                <textarea
                  rows={1}
                  disabled={!activeConversation}
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      event.currentTarget.form?.requestSubmit()
                    }
                  }}
                  placeholder={activeConversation ? '메시지를 입력하세요' : '직원 목록에서 새 대화를 시작하세요'}
                />
              </label>
              <button className="send" type="submit" aria-label="메시지 보내기" disabled={!activeConversation || !message.trim() || messageSending}><Send size={20} /></button>
            </form>
          </section>
        </div>
      </div>
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
            <button className="collab-button secondary" type="button" onClick={onClose} disabled={pending}>취소</button>
            <button className={deleting ? 'collab-button danger' : 'collab-button primary'} type="button" data-autofocus onClick={onConfirm} disabled={pending}>{pending ? '처리 중…' : deleting ? '삭제 확정' : '나가기'}</button>
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
        description="전사 행사, 부서 일정과 개인 업무를 한 달 흐름에서 함께 확인합니다."
        actions={<button className="collab-button primary" type="button" onClick={() => openCreate()}><Plus size={18} /> 일정 등록</button>}
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
      </section>

      <div className="schedule-workspace">
        <section className="collab-panel calendar-panel" aria-label="월간 달력">
          <div className="calendar-weekdays" aria-hidden="true">
            {['일', '월', '화', '수', '목', '금', '토'].map((day) => <span key={day}>{day}</span>)}
          </div>
          <div className="calendar-grid" role="grid" aria-label={formatYearMonthLabel(viewMonth) + ' 일정'}>
            {cells.map((cell) => {
              const key = seoulDateInputValue(cell)
              const cellEvents = visibleEvents.filter((event) => event.date === key)
              const outside = cell.getMonth() !== viewMonth.getMonth()
              const selected = key === selectedDate
              const today = key === scheduleToday
              return (
                <div
                  className={'calendar-day' + (outside ? ' outside' : '') + (selected ? ' selected' : '') + (today ? ' today' : '')}
                  role="gridcell"
                  aria-selected={selected}
                  key={key}
                >
                  <button
                    className="calendar-day-number"
                    type="button"
                    aria-label={koreanDateLabel(key, true) + ', 일정 ' + cellEvents.length + '개'}
                    onClick={() => setSelectedDate(key)}
                  >
                    <span>{cell.getDate()}</span>
                    {today && <em>오늘</em>}
                  </button>
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
              <p>{selectedEvents.length}개의 일정</p>
            </div>
            <button type="button" aria-label="선택한 날짜에 일정 추가" onClick={() => openCreate(selectedDate)}><Plus size={20} /></button>
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
                <button className="collab-button secondary" type="button" onClick={() => openCreate(selectedDate)}><Plus size={17} /> 일정 추가</button>
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
            <label className="collab-field wide"><span>일정 제목</span><input data-autofocus value={draft.title} disabled={!canEdit} onChange={(event) => update('title', event.target.value)} placeholder="예: 월간 생산계획 회의" /></label>
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
            {editing && canEdit ? <button className="collab-button danger" type="button" disabled={submitting} onClick={() => { if (submitting) return; setSubmitting(true); void onDelete().finally(() => setSubmitting(false)) }}><Trash2 size={17} /> 삭제</button> : <span />}
            <div><button className="collab-button secondary" type="button" onClick={onClose} disabled={submitting}>{canEdit ? '취소' : '닫기'}</button>{canEdit && <button className="collab-button primary" type="submit" disabled={submitting}><Check size={18} /> {submitting ? '저장 중…' : editing ? '수정 저장' : '일정 등록'}</button>}</div>
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
  feedback: string
  attachments: JournalAttachment[]
  reviews?: JournalReview[]
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

function formatJournalGroupDate(value: string) {
  return formatDateLabel(value)
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
  const [comment, setComment] = useState('')
  const dialogRef = useOverlayFocus(true, onClose)
  const isReject = decision === '반려'
  const valid = comment.trim().length >= 2

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
                <strong>{isReject ? '작성자가 보완할 내용을 구체적으로 남겨 주세요.' : '확인한 결과와 승인 근거를 남겨 주세요.'}</strong>
                <p>코멘트는 작성자에게 공유되고 결재 이력에 보관됩니다.</p>
              </div>
            </div>
            <label className="collab-field journal-review-comment">
              <span>결재 코멘트 <em>필수</em></span>
              <textarea
                data-autofocus
                rows={6}
                maxLength={1000}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                placeholder={isReject ? '예: 냉동창고 LOT별 실사 수량과 조치 결과를 보완해 주세요.' : '예: 업무 결과와 다음 계획을 확인했습니다.'}
              />
              <small>{comment.length}/1000 · 2자 이상 입력</small>
            </label>
          </div>
          <footer className="collab-dialog-footer">
            <span />
            <div>
              <button className="collab-button secondary" type="button" onClick={onClose} disabled={submitting}>취소</button>
              <button className={isReject ? 'collab-button danger' : 'collab-button primary'} type="submit" disabled={!valid || submitting}>
                {isReject ? <X size={18} /> : <Check size={18} />} {submitting ? '처리 중…' : decision + ' 확정'}
              </button>
            </div>
          </footer>
        </form>
      </div>
    </div>
  )
}

export function DailyJournalPage({ onToast, currentUserId, currentUserName, currentUserTeam, canManage, workspaceScope }: PageProps) {
  const [journals, setJournals] = useWorkspaceState<Journal[]>('daily-journals', [], { scope: workspaceScope, seedWhenEmpty: false })
  const isJournalOwner = (journal: Pick<Journal, 'authorId' | 'author'>) => journal.authorId === currentUserId || (!journal.authorId && journal.author === currentUserName)
  const initialJournal = journals.find(isJournalOwner) ?? (canManage ? journals[0] : undefined) ?? newJournalDraft(currentUserId, currentUserName, currentUserTeam)
  const [selectedId, setSelectedId] = useState(initialJournal.id)
  const [editor, setEditor] = useState<Journal>(() => cloneJournal(initialJournal))
  const [viewMode, setViewMode] = useState<'list' | 'editor'>('list')
  const [journalEditorMode, setJournalEditorMode] = useState<'view' | 'edit'>('view')
  const [filter, setFilter] = useState<JournalFilter>('전체')
  const [query, setQuery] = useState('')
  const [journalSaving, setJournalSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [reviewDecision, setReviewDecision] = useState<'승인' | '반려' | null>(null)
  const [reviewSubmitting, setReviewSubmitting] = useState(false)
  const [attachmentBusy, setAttachmentBusy] = useState(false)
  const [downloadingAttachmentId, setDownloadingAttachmentId] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const editorDirtyRef = useRef(false)
  const [journalDirty, setJournalDirty] = useState(false)
  const uploadedAttachmentIdsRef = useRef(new Set<string>())
  const removedAttachmentIdsRef = useRef(new Set<string>())
  const accessibleJournals = journals.filter((journal) => canManage || isJournalOwner(journal))
  const markJournalDirty = (dirty: boolean) => {
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

  const filteredJournals = accessibleJournals.filter((journal) => {
    const matchesFilter = filter === '전체' || journal.status === filter
    const normalized = query.trim().toLowerCase()
    const matchesQuery = !normalized || (journal.title + ' ' + journal.date + ' ' + journal.author + ' ' + journal.department + ' ' + journal.completed).toLowerCase().includes(normalized)
    return matchesFilter && matchesQuery
  })
  const journalGroups = Array.from(filteredJournals.reduce((groups, journal) => {
    const group = groups.get(journal.date) ?? []
    group.push(journal)
    groups.set(journal.date, group)
    return groups
  }, new Map<string, Journal[]>()).entries())
    .sort(([left], [right]) => right.localeCompare(left))
  const canModifyJournal = isJournalOwner(editor) && (editor.status === '임시저장' || editor.status === '반려')
  const canEdit = journalEditorMode === 'edit' && canModifyJournal

  const updateEditor = <Key extends keyof Journal>(key: Key, value: Journal[Key]) => {
    if (!canEdit) return
    markJournalDirty(true)
    setEditor((current) => ({ ...current, [key]: value }))
  }

  const updateJournalDate = (date: string) => {
    if (!canEdit) return
    markJournalDirty(true)
    setEditor((current) => ({
      ...current,
      date,
      title: /^\d{4}-\d{2}-\d{2}_.+_업무일지$/.test(current.title) ? `${date}_${current.author}_업무일지` : current.title,
    }))
  }

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
    if (journalDirty && !window.confirm('저장하지 않은 업무일지 변경사항이 있습니다. 변경사항을 버리고 새 일지를 작성할까요?')) return
    if (attachmentBusy || !(await cleanupUnsavedUploads())) return
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

  const persistJournal = async (status: JournalStatus, message: string) => {
    if (!canEdit) {
      onToast('본인의 임시저장 또는 반려 일지만 수정할 수 있습니다.')
      return false
    }
    if (journalSaving || attachmentBusy) return false
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
      setJournalSaving(false)
      return false
    }
    uploadedAttachmentIdsRef.current.clear()
    removedAttachmentIdsRef.current.clear()
    const cleanup = await deleteDocumentAttachments(removedDocumentIds, workspaceScope)
    markJournalDirty(false)
    setEditor(cloneJournal(saved))
    setJournalSaving(false)
    if (cleanup.failed.length) {
      const warning = `${message} 다만 제거한 첨부 ${cleanup.failed.length}개의 원본 정리에 실패했습니다.`
      setSaveError(warning)
      onToast(warning)
    } else {
      onToast(message)
    }
    return true
  }

  const saveDraft = () => {
    void persistJournal('임시저장', '업무일지를 임시저장했습니다.')
  }

  const requestApproval = async () => {
    if (!editor.completed.trim() || !editor.nextPlan.trim()) {
      onToast('오늘 한 일과 다음 업무 계획을 입력해 주세요.')
      return
    }
    const saved = await persistJournal('결재요청', editor.approver + '님에게 결재를 요청했습니다.')
    if (saved) {
      setJournalEditorMode('view')
      setViewMode('list')
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
      const body = await response.json() as { journal: Journal }
      const next = cloneJournal(body.journal)
      await setJournals((current) => current.map((journal) => journal.id === next.id ? next : journal), { persist: false })
      markJournalDirty(false)
      setEditor(next)
      setReviewDecision(null)
      setJournalEditorMode('view')
      setViewMode('list')
      onToast(status === '승인' ? '코멘트와 함께 업무일지를 승인했습니다.' : '보완 코멘트와 함께 업무일지를 반려했습니다.')
    } catch {
      onToast('업무일지 결재 서버에 연결하지 못했습니다.')
    } finally {
      setReviewSubmitting(false)
    }
  }

  const attachFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    if (!canEdit || attachmentBusy) return
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
    if (!canEdit || attachmentBusy) return
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
        actions={<button className="collab-button primary" type="button" onClick={() => void createJournal()} disabled={attachmentBusy}><Plus size={18} /> 새 일지</button>}
      />

      <section className="journal-summary" aria-label="업무일지 현황">
        <div><span className="journal-summary-icon amber"><Save size={20} /></span><span>임시저장<strong>{statusCount('임시저장')}건</strong></span></div>
        <div><span className="journal-summary-icon blue"><Clock3 size={20} /></span><span>결재 대기<strong>{statusCount('결재요청')}건</strong></span></div>
        <div><span className="journal-summary-icon green"><CheckCircle2 size={20} /></span><span>이번 주 승인<strong>{statusCount('승인')}건</strong></span></div>
        <div><span className="journal-summary-icon red"><AlertCircle size={20} /></span><span>보완 필요<strong>{statusCount('반려')}건</strong></span></div>
      </section>

      <div className={'journal-workspace ' + (viewMode === 'list' ? 'list-only' : 'editor-only')}>
        {viewMode === 'list' && <aside className="collab-panel journal-list-panel" aria-label="직원별 업무일지 제출 목록">
          <div className="journal-list-tools">
            <div className="journal-list-heading"><div><span className="collab-kicker">SUBMISSIONS</span><h2>직원별 업무일지</h2><p>작성자와 제출일, 결재 상태를 먼저 확인하고 필요한 일지를 선택하세요.</p></div><strong>{filteredJournals.length}건</strong></div>
            <label className="collab-search">
              <Search size={18} />
              <span className="sr-only">업무일지 검색</span>
              <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="날짜 또는 업무 검색" />
            </label>
            <div className="journal-filter" role="group" aria-label="업무일지 상태">
              {(['전체', '임시저장', '결재요청', '승인', '반려'] as JournalFilter[]).map((item) => (
                <button type="button" className={filter === item ? 'active' : ''} aria-pressed={filter === item} onClick={() => setFilter(item)} key={item}>{item}</button>
              ))}
            </div>
          </div>
          <div className="journal-list">
            {journalGroups.map(([date, dateJournals]) => (
              <section className="journal-date-group" aria-labelledby={`journal-date-${date}`} key={date}>
                <header className="journal-date-group-header">
                  <h3 id={`journal-date-${date}`}>{formatJournalGroupDate(date)}</h3>
                  <span>{dateJournals.length}건</span>
                </header>
                <div className="journal-date-group-list">
                  {dateJournals.map((journal) => (
                    <article className={'journal-list-item' + (journal.id === selectedId ? ' active' : '')} key={journal.id}>
                      <Avatar name={journal.author} compact />
                      <div className="journal-list-person">
                        <strong>{journal.author}</strong>
                        <span>{journal.department}</span>
                      </div>
                      <div className="journal-list-copy">
                        <strong>{journal.title}</strong>
                        <small>{journal.completed.trim() || '아직 작성된 업무 내용이 없습니다.'}</small>
                      </div>
                      <StatusChip tone={journalTone(journal.status)}>{journal.status}</StatusChip>
                      <time dateTime={journal.status === '임시저장' ? journal.updatedAt : (journal.submittedAt ?? journal.updatedAt)}>
                        {journal.status === '임시저장' ? '저장' : '제출'} {formatJournalTimestamp(journal.status === '임시저장' ? journal.updatedAt : (journal.submittedAt ?? journal.updatedAt))}
                      </time>
                      <button
                        className="journal-view-button"
                        type="button"
                        aria-label={`${journal.author}님의 ${journal.title} 조회`}
                        onClick={() => chooseJournal(journal)}
                      >
                        조회 <ChevronRight size={16} />
                      </button>
                    </article>
                  ))}
                </div>
              </section>
            ))}
            {filteredJournals.length === 0 && <div className="collab-empty compact"><BookOpenCheck size={28} /><strong>해당 일지가 없습니다</strong><span>검색어나 상태 필터를 변경해 보세요.</span></div>}
          </div>
        </aside>}

        {viewMode === 'editor' && <section className="collab-panel journal-editor-panel" aria-labelledby="journal-editor-title">
          <header className="journal-editor-header">
            <div>
              <div className="journal-editor-meta"><StatusChip tone={journalTone(editor.status)}>{editor.status}</StatusChip><span>{editor.id}</span><span>{formatJournalTimestamp(editor.updatedAt)} 저장</span></div>
              <h2 id="journal-editor-title">{editor.title}</h2>
              <p>{editor.author} · {editor.department} · 결재자 {editor.approver}</p>
            </div>
            <div className="journal-editor-header-actions">
              {canEdit && <button className="collab-icon-button" type="button" aria-label="제목 편집" onClick={() => titleInputRef.current?.focus()}><Edit3 size={19} /></button>}
              {canModifyJournal && !canEdit && <button className="collab-button secondary compact" type="button" onClick={() => setJournalEditorMode('edit')}><Edit3 size={17} /> 수정하기</button>}
              <button className="collab-button secondary compact" type="button" onClick={() => void returnToJournalList()} disabled={attachmentBusy}><ArrowLeft size={17} /> 목록으로</button>
            </div>
          </header>

          {saveError && <div className="journal-save-error" role="alert"><AlertCircle size={19} /><span>{saveError}</span></div>}

          {editor.status === '반려' && (
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
            <div className="journal-title-fields">
              <label className="collab-field"><span>업무일</span><input type="date" value={editor.date} disabled={!canEdit} onChange={(event) => updateJournalDate(event.target.value)} /></label>
              <label className="collab-field"><span>일지 제목</span><input ref={titleInputRef} value={editor.title} disabled={!canEdit} onChange={(event) => updateEditor('title', event.target.value)} /></label>
              <label className="collab-field"><span>결재자</span><select value={editor.approver} disabled={!canEdit} onChange={(event) => updateEditor('approver', event.target.value)}><option>{editor.approver}</option>{editor.approver !== '소속 관리자' && <option>소속 관리자</option>}<option>공장장</option><option>품질 책임자</option></select></label>
            </div>
            <label className="collab-field journal-textarea"><span>오늘 한 일 <em>필수</em></span><textarea rows={7} value={editor.completed} disabled={!canEdit} onChange={(event) => updateEditor('completed', event.target.value)} placeholder="완료한 업무를 결과 중심으로 작성하세요." /></label>
            <div className="journal-two-columns">
              <label className="collab-field journal-textarea"><span>이슈 · 지원 요청</span><textarea rows={5} value={editor.issue} disabled={!canEdit} onChange={(event) => updateEditor('issue', event.target.value)} placeholder="협의나 지원이 필요한 내용을 작성하세요." /></label>
              <label className="collab-field journal-textarea"><span>다음 업무 계획 <em>필수</em></span><textarea rows={5} value={editor.nextPlan} disabled={!canEdit} onChange={(event) => updateEditor('nextPlan', event.target.value)} placeholder="내일 또는 다음 근무일의 계획을 작성하세요." /></label>
            </div>

            <section className="journal-attachments" aria-labelledby="journal-attachment-title">
              <div className="journal-attachment-head">
                <div><h3 id="journal-attachment-title">첨부파일</h3><p>관련 보고서, 사진 또는 작업 결과를 첨부합니다.</p></div>
                {canEdit && (
                  <>
                    <input ref={fileInputRef} className="sr-only" type="file" multiple onChange={attachFiles} />
                    <button className="collab-button secondary" type="button" onClick={() => fileInputRef.current?.click()} disabled={attachmentBusy}><Upload size={17} /> {attachmentBusy ? '처리 중…' : '파일 첨부'}</button>
                  </>
                )}
              </div>
              <div className="journal-attachment-list">
                {editor.attachments.map((attachment) => (
                  <div className="journal-attachment-item" key={attachment.id}>
                    <span><FileText size={20} /></span>
                    <div><strong>{attachment.name}</strong><small>{attachment.size} · {isStoredDocumentAttachment(attachment) ? '원본 저장됨' : '이전 파일 정보'}</small></div>
                    <div className="journal-attachment-actions">
                      {isStoredDocumentAttachment(attachment) && <button type="button" aria-label={attachment.name + ' 다운로드'} disabled={Boolean(downloadingAttachmentId)} onClick={() => void downloadAttachment(attachment)}><Download size={18} /></button>}
                      {canEdit && <button type="button" aria-label={attachment.name + ' 삭제'} disabled={attachmentBusy} onClick={() => void removeAttachment(attachment)}><X size={18} /></button>}
                    </div>
                  </div>
                ))}
                {editor.attachments.length === 0 && <div className="journal-no-attachment"><Paperclip size={20} /><span>첨부된 파일이 없습니다.</span></div>}
              </div>
            </section>
          </div>

          <footer className="journal-editor-footer">
            {canEdit ? (
              <>
                <span>{editor.status === '반려' ? '결재 코멘트를 반영한 뒤 다시 결재를 요청하세요.' : '임시저장 후에도 자유롭게 수정할 수 있습니다.'}</span>
                <div>
                  <button className="collab-button secondary" type="button" onClick={saveDraft} disabled={journalSaving || attachmentBusy}><Save size={18} /> {journalSaving ? '저장 중…' : '임시저장'}</button>
                  <button className="collab-button primary" type="button" onClick={() => void requestApproval()} disabled={journalSaving || attachmentBusy}><Send size={18} /> {journalSaving ? '저장 중…' : editor.status === '반려' ? '보완 후 재결재 요청' : '결재요청'}</button>
                </div>
              </>
            ) : canModifyJournal ? (
              <>
                <span>현재 조회 화면입니다. 내용을 변경하려면 수정하기를 선택하세요.</span>
                <button className="collab-button primary" type="button" onClick={() => setJournalEditorMode('edit')}><Edit3 size={18} /> 수정하기</button>
              </>
            ) : editor.status === '결재요청' && canManage ? (
              <>
                <span>관리자 결재 처리</span>
                <div>
                  <button className="collab-button danger" type="button" onClick={() => setReviewDecision('반려')}><X size={18} /> 코멘트 후 반려</button>
                  <button className="collab-button primary" type="button" onClick={() => setReviewDecision('승인')}><Check size={18} /> 코멘트 후 승인</button>
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

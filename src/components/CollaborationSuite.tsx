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
  Megaphone,
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
import { SaveState } from './ui/States'
import { formatDateLabel, formatDateTime, formatListDateTime, formatShortDateTime, formatYearMonthLabel, seoulDateInputValue } from '../utils/dateTime'
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
import { GroupRoomDialog, MentionSuggestions, MessageActionBar, QuotedMessage, ReactionRow, RoomSearchPanel, ThreadShareDialog } from './MessengerExtras'
import { ThreadEmpty, ThreadOriginButton, ThreadReplyDivider, ThreadSummaryButton, type ThreadData } from './ThreadPanel'
import {
  NoticeAckDialog, NoticeBoard, NoticeComposerDialog, NoticeStrip, parseMessengerFocus, useNotices,
  type MessengerFocus, type Notice, type NoticeAckList, type NoticeDraft,
} from './NoticeCenter'
import { BRAND } from '../brand'
import { CalendarConnectionCard, OverwriteHistoryDetails, type OverwriteHistory } from './CalendarConnection'
import { canJudgeMissingNotice } from '../utils/noticeFocus'
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

/** 게스트 화면이 넘겨 주는 로스터 항목. /api/projects 응답의 directory(보이는 프로젝트 멤버만)와 같은 모양이다. */
export type MessengerRosterEntry = { id: string; name: string; team?: string; jobRole?: string; kind?: 'employee' | 'guest' }

type MessengerDrawerProps = OverlayProps & CurrentUserProps & {
  /**
   * 있으면 /api/directory를 부르지 않고 이 목록을 쓴다. 게스트 세션에서는 전 직원 목록 조회가
   * 서버 게이트에 막히고, 막히지 않더라도 외부인에게 직원 명단을 내려 줄 이유가 없다.
   */
  rosterOverride?: MessengerRosterEntry[]
  /** 새 대화·그룹방 만들기·참여자 관리·나가기·삭제·수정·고정을 감춘다. 게스트는 참여 중인 방에서 읽고 쓰기만 한다. */
  readOnlyRooms?: boolean
  /** 오버레이가 아니라 화면 안에 그대로 그린다(게스트 채널 탭). 배경 스크림·닫기 버튼·초점 가두기가 빠진다. */
  embedded?: boolean
  /** 알림·전역 검색이 가리킨 자리. focusId 문자열 하나에 종류가 실려 있다(parseMessengerFocus). */
  focus?: MessengerFocus | null
  onFocusHandled?: () => void
}

/** 공지·스레드·메시지 딥링크를 이 컴포넌트 밖에서도 만들 수 있게 그대로 다시 내보낸다. */
export { parseMessengerFocus }
export type { MessengerFocus, Notice }

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
  /** 접속 상태. 프로젝트 로스터(rosterOverride)에서 온 사람은 상태를 모르므로 비워 두고, 점도 그리지 않는다. */
  status?: 'online' | 'away' | 'offline'
  system?: boolean
  /** 비활성(퇴사) 계정. 기록은 남기되 새 대화 상대로는 고르지 않는다. */
  active?: boolean
  /** 외부 게스트는 회사 전체 공지의 대상이 아니다. 서버 roster 판정과 같은 구분이다. */
  kind?: 'employee' | 'guest'
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
  /** 이 말이 붙은 스레드의 루트. 있으면 본채널의 어느 목록에도 나오지 않는다. */
  threadRootId?: string
  /** 루트에만 붙는 집계. 본채널은 이 둘로 '답글 N개 · 시각' 한 줄만 그린다. */
  replyCount?: number
  lastReplyAt?: string
  /** [채널에 공유]로 올라온 요약이 어느 스레드에서 왔는지. */
  sharedFromThreadId?: string
  /** 보낸 사람의 신원 종류. 'system'은 수신 웹훅이 올린 말이다(R16-L). */
  senderRole?: string
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
  /** 프로젝트 채널. 공지를 올릴 수 있는 방인지가 이 값 하나로 갈린다. */
  projectId?: string
}

type MessengerListMode = 'recent' | 'teams' | 'people'

/** 좁은 화면에서 지금 무엇을 보여 주는가. 스레드는 채널 위가 아니라 채널 옆이다. */
type MessengerPane = 'list' | 'chat' | 'thread'

/**
 * 한 번에 그리는 메시지 수. 방 하나에 5,000건까지 쌓일 수 있어 전부 그리면 화면이 멈춘다.
 * 위로 올라가면 이만큼씩 더 편다.
 */
const MESSAGE_WINDOW = 60

/**
 * 스레드를 방 밖으로 옮기는 세 갈래. 무엇이 되는지는 서버가 정하고 화면은 이름만 안다.
 * '올림' 문구를 함께 두는 이유: 올리기 전과 후가 똑같이 보이면 사람은 한 번 더 누르고,
 * 업무·자료는 서버가 두 번을 막지 않으므로 같은 결론이 두 벌 생긴다.
 */
type ThreadPromotionKind = 'task' | 'decision' | 'document'
/** duplicates: 같은 스레드를 두 번 올리면 두 건이 생기는가. 결정만 서버가 sourceKey로 409를 낸다 —
 *  그 사실이 여기 한 곳에 있어야 화면의 사전 안내가 서버가 실제로 하는 일과 어긋나지 않는다. */
const THREAD_PROMOTIONS: { kind: ThreadPromotionKind; label: string; doneLabel: string; duplicates: boolean }[] = [
  { kind: 'task', label: '업무로', doneLabel: '업무로 올림', duplicates: true },
  { kind: 'decision', label: '결정으로', doneLabel: '결정으로 올림', duplicates: false },
  { kind: 'document', label: '자료로', doneLabel: '자료로 올림', duplicates: true },
]

/**
 * 지워진 루트에 답글을 붙이려 할 때의 한 문장.
 *
 * server/messenger-threads.mjs의 THREAD_ERRORS.ROOT_DELETED.message와 **글자 그대로 같아야 한다**
 * (scripts/thread-ui-contract.test.mjs가 두 문자열을 맞대어 본다). 화면의 사전 안내와 서버의 거절 문구가
 * 갈라지면 같은 사실이 자리마다 다르게 보인다 — 한 사실에 한 문장이다.
 */
const THREAD_ROOT_DELETED_NOTICE = '지워진 말에는 답글을 달 수 없습니다. 결론은 [채널에 공유]로 남길 수 있습니다.'

/**
 * 답글이 전부 지워졌을 때의 한 문장.
 *
 * 헤더의 '답글 N개'는 tombstone까지 센다(본채널 요약 줄의 수와 같아야 하므로). [채널에 공유]와 승격
 * 세 단추는 살아 있는 답글(liveReplyCount)로 켜고 끈다 — 서버의 THREAD_EMPTY와 같은 수다.
 * 그래서 답글 하나를 지우고 나면 화면이 '답글 1개'라고 적어 놓고 네 단추를 모두 꺼 버리는 순간이 생긴다.
 * 수를 적었으면 왜 거절하는지도 같은 화면에서 말해야 한다.
 */
const THREAD_ALL_REPLIES_DELETED_NOTICE = '남아 있는 답글이 없어 채널에 공유하거나 업무·결정·자료로 올릴 수 없습니다.'

/**
 * 승격 세 갈래의 공개 범위. 나란히 선 세 단추가 같은 범위처럼 보이므로, 그 사실을 화면이 한 줄로 말한다.
 * 확인 대화상자를 세우지는 않는다.
 *
 * 서버에서 실제로 읽히는 사람(코드에서 확인한 것만 적는다 — 추측을 적으면 사람이 그 문장을 믿고 누른다):
 *  - 업무: createTaskFromConclusion이 ownerId·requesterId를 둘 다 올린 사람으로 적고(app.mjs),
 *    GET /api/workspace/work-items는 tenant-member에게 isMemberWorkItem(= 담당 ∪ 요청자)만 내준다.
 *    관리자는 필터가 없어 전부 본다 → **올린 사람 + 관리자**. '회사 구성원 전체'가 아니다.
 *  - 결정: /api/proposals의 가드가 requireTenantAdmin이다 → **관리자만**. 셋 중 가장 좁다.
 *  - 자료: visibility 'restricted' + allowedUserIds(지금 이 방을 볼 수 있는 사람 ∪ 올린 사람)이지만
 *    canReadDocument가 tenant-admin에게는 방 여부와 무관하게 true를 준다
 *    → **이 방의 사람들(초대된 외부 게스트 포함) + 관리자**. 셋 중 가장 넓다.
 *
 * 즉 넓이 순서는 자료 > 업무 > 결정이다. 예전 문장은 이 순서를 정확히 뒤집어 적어서, 내용을 방 안에
 * 두고 싶은 사람을 가장 넓은 갈래로 안내했다.
 */
const THREAD_PROMOTION_SCOPE_NOTICE = '업무로 올리면 나와 관리자에게, 결정으로 올리면 관리자에게 보입니다. 자료로 올리면 이 방의 사람들(외부 게스트 포함)과 관리자에게 열립니다.'

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
  rosterOverride,
  readOnlyRooms = false,
  embedded = false,
  focus = null,
  onFocusHandled,
}: MessengerDrawerProps) {
  // 화면 안에 박힌 채널 탭은 대화상자가 아니다. 초점을 가두면 위의 탭 버튼으로 나갈 수 없다.
  const overlayRef = useOverlayFocus(open && !embedded, onClose)
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
  const [mobilePane, setMobilePane] = useState<MessengerPane>('list')
  const [showConversationMenu, setShowConversationMenu] = useState(false)
  /** 방별 알림 세기와 그 밖의 알림 설정. 저장은 알림 설정 한 곳에서만 한다. */
  const [roomAlertModes, setRoomAlertModes] = useState<Record<string, 'all' | 'mention' | 'off'>>({})
  const [notificationSettings, setNotificationSettings] = useState<Record<string, unknown>>({})
  useEffect(() => {
    if (!workspaceScope) return
    let alive = true
    fetch('/api/notifications', { headers: { 'x-workspace-identity': workspaceScope } })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { settings?: Record<string, unknown> } | null) => {
        if (!alive || !body?.settings) return
        setNotificationSettings(body.settings)
        setRoomAlertModes((body.settings.rooms as Record<string, 'all' | 'mention' | 'off'>) ?? {})
      })
      .catch(() => undefined)
    return () => { alive = false }
  }, [workspaceScope])
  const [conversationAction, setConversationAction] = useState<'leave' | 'delete' | null>(null)
  const [conversationActionPending, setConversationActionPending] = useState(false)
  const messageEndRef = useRef<HTMLDivElement>(null)
  // ── A절 확장 ──
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null)
  // 같은 루트가 본채널과 스레드 패널 양쪽에 그려진다. 수정 상태에 어느 칸인지가 없으면 두 벌이 함께
  // 편집 상자로 바뀌어 autoFocus 둘이 초점을 다투고 '저장'(primary)이 한 화면에 두 개 선다.
  const [editing, setEditing] = useState<{ id: string; text: string; inThread: boolean } | null>(null)
  const [roomSearchOpen, setRoomSearchOpen] = useState(false)
  const [roomSearchQuery, setRoomSearchQuery] = useState('')
  const [groupDialog, setGroupDialog] = useState<'create' | 'manage' | null>(null)
  const [groupPending, setGroupPending] = useState(false)
  const [mentionState, setMentionState] = useState<{ query: string; index: number } | null>(null)
  // 방이 길어지면 전부 그리지 않는다. 위로 올라가면 한 페이지씩 더 편다.
  const [visibleCount, setVisibleCount] = useState(MESSAGE_WINDOW)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const messageRefs = useRef<Record<string, HTMLElement | null>>({})
  // ── R16-J: 스레드 ──
  // 방을 바꾸면 닫는다(selectConversation). 열려 있는 동안은 이 방의 배열이 아니라 서버가 준 스레드를 그린다 —
  // 답글 수는 언제나 실제 배열에서 나와야 하고, 그 배열은 서버가 들고 있다.
  const [threadRootId, setThreadRootId] = useState<string | null>(null)
  const [thread, setThread] = useState<ThreadData<ChatMessage> | null>(null)
  const [threadMessage, setThreadMessage] = useState('')
  // 스레드 안의 '답장'은 스레드 안에만 머문다. 본채널의 replyTo와 한 칸을 나눠 쓰면 옆 칸에서 누른 답장이
  // 본채널 컴포저를 무장시켜, 답글 본문이 본채널의 인용 줄로 새어 나간다(서버도 그 방향을 400으로 막는다).
  const [threadReplyTo, setThreadReplyTo] = useState<ChatMessage | null>(null)
  const [threadSending, setThreadSending] = useState(false)
  const [threadPending, setThreadPending] = useState(false)
  // 이 스레드를 열어 둔 동안 무엇으로 올렸는지. 업무·자료는 서버가 두 번을 막지 않으므로(결정만 sourceKey로 막는다)
  // 화면이 기억하지 않으면 같은 결론이 조용히 두 벌 생기고, 단추는 올리기 전후가 똑같이 보인다.
  // 이 기억은 단추의 낱말만 바꾼다 — 막지는 않는다. 새로고침으로 되살릴 수 없는 값으로 서버가 허용하는
  // 행동을 막으면, 두 건이 필요한 사람은 패널을 닫았다 여는 우회로를 배운다.
  const [threadPromoted, setThreadPromoted] = useState<Record<string, ThreadPromotionKind[]>>({})
  // 이미 올린 갈래를 한 번 더 눌렀는가. 막는 대신 한 번 되묻기 위한 자리다 —
  // 되물은 다음 누름은 그대로 올라가고, 판정하는 쪽은 여전히 서버다.
  const [threadPromoteAgain, setThreadPromoteAgain] = useState<ThreadPromotionKind | null>(null)
  const [shareOpen, setShareOpen] = useState(false)
  const threadComposerRef = useRef<HTMLTextAreaElement>(null)
  // 지금 열려 있어야 하는 루트. 상태는 다음 렌더에야 바뀌므로 openThread가 바로 이어서 부르는
  // refreshThread는 state로 자기 자신을 판정할 수 없다 — 늦게 온 응답을 가려내는 것은 이 ref다.
  const threadRootIdRef = useRef<string | null>(null)
  // ── R16-D: 공지 ──
  // '회사 공지'를 selectedId에 넣지 않는다. selectedConversation에서 파생되는 자리가 많아
  // (컴포저 disabled, /read, callRoom, unreadForConversation, 방 메뉴, roomSearch, pendingAttachments)
  // 한 곳만 새면 /api/messenger/conversations/company-notices/... 로 404가 난다. 대신 pane 상태를 둔다.
  const [pane, setPane] = useState<'chat' | 'notices'>('chat')
  const { notices, state: noticesState, loadedAt: noticesLoadedAt, reload: reloadNotices } = useNotices(open, workspaceScope)
  const [openNoticeId, setOpenNoticeId] = useState<string | null>(null)
  const [noticeDialog, setNoticeDialog] = useState<
    | { mode: 'create' | 'edit'; conversationId: string | null; notice?: Notice }
    | { mode: 'acks'; notice: Notice }
    | null>(null)
  const [noticeAcks, setNoticeAcks] = useState<NoticeAckList>({ confirmed: [], unconfirmed: [] })
  const [noticeAcksState, setNoticeAcksState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [noticeBusyId, setNoticeBusyId] = useState('')
  const [noticePending, setNoticePending] = useState(false)
  const [noticeRefreshToken, setNoticeRefreshToken] = useState(0)
  /** 딥링크가 가리킨 공지. 카드가 아직 화면에 없을 수 있으므로 '언제 스크롤할지'를 시간이 아니라 이 값이 정한다. */
  const pendingNoticeScrollRef = useRef('')
  /** 목록을 다시 읽어 본 딥링크의 클릭 시각. 한 번의 클릭이 다시 읽기를 한 번만 부르게 막는다. */
  const focusReloadRef = useRef(0)
  /** 방 목록 요청이 한 번은 답했는가(성공·실패 모두). 딥링크가 '들어갈 수 있는 방인가'를 판정할 자격이다. */
  const [conversationsSettled, setConversationsSettled] = useState(false)

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
    // 미읽음도 본채널의 것만 센다. 스레드 답글까지 세면 목록 배지가 "내가 들어가지 않은 스레드"의
    // 활동을 알려 주게 되고, 방을 열어도 그 숫자를 지울 방법이 없어 배지가 남아 있는다.
    const rows = conversation.messages.filter((item) => !item.threadRootId)
    const hasReceipts = rows.some((item) => Array.isArray(item.readBy))
    if (!hasReceipts) return conversation.unread
    return rows.filter((item) => {
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

  /**
   * 이 방의 알림 세기.
   *
   * 값은 알림 설정(rooms)에 있다. 방 데이터의 mutedFor는 예전 방식이라,
   * 아직 설정으로 옮기지 않은 방은 그것을 '끔'으로 읽어 준다 — 껐던 방이
   * 갑자기 울리기 시작하는 일이 없어야 한다.
   */
  const legacyMuted = (selectedConversation.mutedFor ?? []).some((id) => currentIdentityIds.includes(id))
  const roomAlertMode: 'all' | 'mention' | 'off' = roomAlertModes[selectedConversation.id] ?? (legacyMuted ? 'off' : 'all')

  const setRoomAlertMode = async (conversationId: string, mode: 'all' | 'mention' | 'off') => {
    setRoomAlertModes((current) => ({ ...current, [conversationId]: mode }))
    setShowConversationMenu(false)
    try {
      const response = await fetch('/api/notifications/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}) },
        body: JSON.stringify({ settings: { ...notificationSettings, rooms: { ...roomAlertModes, [conversationId]: mode } } }),
      })
      if (!response.ok) throw new Error('저장 실패')
      const body = await response.json() as { settings?: { rooms?: Record<string, 'all' | 'mention' | 'off'> } }
      setRoomAlertModes(body.settings?.rooms ?? {})
      onToast(mode === 'off' ? '이 방 알림을 껐습니다.' : mode === 'mention' ? '이 방은 멘션만 알립니다.' : '이 방 알림을 모두 받습니다.')
    } catch {
      onToast('알림 설정을 바꾸지 못했습니다.')
    }
  }

  /**
   * 스레드를 닫는다. 나가는 길은 이 하나뿐이라 여기만 맞으면 어디서 닫아도 같은 상태가 된다.
   * 휴대폰에서는 패널이 화면 전체를 덮으므로 pane도 함께 되돌린다 — 안 그러면 빈 화면에 갇힌다.
   */
  const closeThread = () => {
    threadRootIdRef.current = null
    setThreadRootId(null)
    setThread(null)
    setThreadMessage('')
    setThreadReplyTo(null)
    setThreadPromoted({})
    setThreadPromoteAgain(null)
    setShareOpen(false)
    setMobilePane((current) => (current === 'thread' ? 'chat' : current))
  }

  /**
   * 열려 있는 스레드를 서버에서 다시 읽는다.
   *
   * 방 목록(conversations)에도 답글이 들어 있지만 그 배열을 그대로 그리지 않는다 —
   * 게스트의 SSE는 방 id 없이 축약돼 오므로, 어느 방이 바뀌었는지 모르는 채로 스레드만 다시 물어야 한다.
   * 한 곳(서버)에서만 세면 본채널 요약과 패널이 어긋날 자리가 없다.
   *
   * closeOnFailure는 여는 순간에만 참이다. 여는 중의 404는 '그런 스레드가 없다'라서 패널을 닫는 것이
   * 맞지만, 이미 열려 있는 스레드를 다시 읽다 실패한 것은 서버가 잠깐 흔들린 것이다 —
   * SSE 틱마다 도는 이 함수가 500 한 번에 패널을 닫으면 쓰던 답글이 함께 사라진다.
   * 본채널 컴포저는 전송이 실패해도 message를 비우지 않는다. 초안은 사람의 것이지 fetch의 것이 아니다.
   */
  const refreshThread = async (rootId: string, conversationId = selectedConversation.id, { closeOnFailure = false } = {}) => {
    if (!rootId || !conversationId) return
    // 실패했을 때 무엇을 할지도 한 곳에서만 정한다 — 두 갈래(응답 실패·연결 실패)가 갈라지면
    // 한쪽만 초안을 지키는 상태가 생긴다.
    const fail = (text: string) => {
      if (closeOnFailure) closeThread()
      onToast(text)
    }
    try {
      const response = await fetch(
        `/api/messenger/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(rootId)}/thread`,
        { headers: workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined },
      )
      // 늦게 온 응답이 지금 열려 있는 스레드를 덮어쓰지 않게 한다. SSE의 refreshThread는 그 렌더가
      // 붙잡은 rootId로 떠나므로, openThread(B) 직전에 떠난 A의 응답이 B보다 늦게 오면 패널은 A를
      // 그리면서 컴포저는 B에 쓴다. 실패 갈래도 같다 — A의 404가 방금 연 B를 닫아 버리면 안 된다.
      if (threadRootIdRef.current !== rootId) return
      if (!response.ok) {
        fail('스레드를 불러오지 못했습니다.')
        return
      }
      const data = await response.json() as ThreadData<ChatMessage>
      if (data?.root?.id !== rootId || threadRootIdRef.current !== rootId) return
      setThread(data)
    } catch {
      if (threadRootIdRef.current !== rootId) return
      fail('메신저 서버에 연결하지 못했습니다.')
    }
  }

  // conversationId를 받는 이유: 딥링크는 방을 고른 바로 그 순간에 스레드를 연다. 그때
  // selectedConversation은 아직 이전 방이라(상태 갱신은 다음 렌더다) 여기서 물어보면 남의 방을 읽는다.
  const openThread = async (rootId: string, conversationId = selectedConversation.id) => {
    threadRootIdRef.current = rootId
    setThreadRootId(rootId)
    setThread(null)
    setMobilePane('thread')
    setRoomSearchOpen(false)
    // 여는 중의 실패만 패널을 닫는다. 아직 잃을 초안이 없고, 404는 '그런 스레드가 없다'는 뜻이다.
    await refreshThread(rootId, conversationId, { closeOnFailure: true })
    window.setTimeout(() => threadComposerRef.current?.focus(), 60)
  }

  /** 본채널에 보이는 메시지. 답글은 스레드 안에만 산다 — 서버 isMainChannelMessage와 같은 규칙이다. */
  const channelMessages = selectedConversation.messages.filter((item) => !item.threadRootId)

  const pinnedMessages = (selectedConversation.pinnedMessageIds ?? [])
    .map((id) => channelMessages.find((item) => item.id === id))
    .filter((item): item is ChatMessage => Boolean(item) && !item!.deletedAt)

  const visibleMessages = channelMessages.slice(Math.max(0, channelMessages.length - visibleCount))
  const hiddenMessageCount = Math.max(0, channelMessages.length - visibleMessages.length)

  const roomSearchMatches = roomSearchQuery.trim().length >= 2
    ? channelMessages
      .filter((item) => !item.deletedAt && item.text.toLowerCase().includes(roomSearchQuery.trim().toLowerCase()))
      .slice(-100)
      .reverse()
    : []

  /** 스레드 안에서 걸린 것. 본채널에는 그 말이 없으므로 점프 대신 스레드를 연다. */
  const threadSearchMatches = roomSearchQuery.trim().length >= 2
    ? selectedConversation.messages
      .filter((item) => item.threadRootId && !item.deletedAt && item.text.toLowerCase().includes(roomSearchQuery.trim().toLowerCase()))
      .slice(-50)
      .reverse()
    : []

  // 이 채널의 공지 / 회사 공지 / 내가 아직 확인하지 않은 필독 건수.
  // 채널 스트립은 방 하나만 서버에 물어본다 — 전체 목록은 200건에서 잘리므로 그것을 화면에서
  // 다시 거르면 공지가 쌓인 테넌트에서 스트립이 조용히 비어 버린다.
  const { notices: channelNoticeRows } = useNotices(
    open && pane === 'chat' && Boolean(activeConversation?.id),
    workspaceScope,
    { conversationId: activeConversation?.id ?? '', refreshToken: noticeRefreshToken },
  )
  const channelNotices = channelNoticeRows.filter((item) => !item.archivedAt && item.conversationId === selectedConversation.id)
  // 사이드바 '회사 공지' 행도 자기 몫을 따로 물어본다. 전체 목록에서 걸러 쓰면 공지가 200건을 넘긴 순간
  // 회사 공지가 있는데도 '아직 공지가 없습니다'라고 말한다(가짜 0). 게스트에게는 이 행이 없으므로 부르지도 않는다.
  // state도 함께 받는다 — 아직 안 온 목록(또는 못 받은 목록)으로 '아직 공지가 없습니다'라고 말하면
  // 그것도 가짜 0이다. 보드는 같은 훅에서 세 상태를 갈라 말한다(NoticeCenter.tsx).
  const { notices: companyNoticeRows, state: companyNoticesState } = useNotices(open && !readOnlyRooms, workspaceScope, { scope: 'company', refreshToken: noticeRefreshToken })
  const companyNotices = companyNoticeRows.filter((item) => !item.archivedAt)
  // 행에 적는 시각·제목은 '가장 새것' 한 건이다. 서버 정렬은 필독을 앞세우므로(notices.mjs) 그대로 [0]을 쓰면
  // 어제 올린 필독이 오늘 올린 일반 공지 자리에 앉는다.
  const latestCompanyNotice = [...companyNotices].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0]
  // 미확인 배지는 전체 목록에서 센다. 서버가 필독을 앞세워 200건에서 자르므로, 미확인 필독이 200건을
  // 넘기 전까지 이 수는 정확하다. 그 너머는 세 번째 요청 대신 창(200건)을 받아들인다.
  const myUnconfirmed = notices.filter((item) => item.canAck).length
  /** 공지를 올릴 수 있는 후보 채널. 최종 판정은 서버가 한다(403) — 화면은 프로젝트 채널만 골라 보여 준다. */
  const noticeChannels = myConversations
    .filter((item) => Boolean(item.projectId) && item.systemChannel !== 'developer-support')
    .map((item) => ({ id: item.id, name: conversationName(item), participantIds: legacyParticipantIds(item) }))
  const noticeRoster = directory
    .filter((person) => !person.system && person.active !== false)
    .map((person) => ({ id: person.accountId ?? person.id, name: person.name, team: person.team, kind: person.kind }))
  const canComposeNotice = !readOnlyRooms && (canManage || noticeChannels.length > 0)

  /** 방에 있는 사람 중 @로 부를 수 있는 후보. 비활성 계정은 부르지 않는다. */
  const mentionCandidates = mentionState
    ? directory
      .filter((person) => !person.system && person.active !== false && person.id !== currentUserId)
      .filter((person) => !mentionState.query || person.name.toLowerCase().includes(mentionState.query.toLowerCase()))
      .slice(0, 6)
    : []

  const jumpToMessage = (messageId: string) => {
    // 답글은 본채널에 없다. 스크롤할 자리가 없으므로 그 말이 사는 스레드를 연다.
    const target = selectedConversation.messages.find((item) => item.id === messageId)
    if (target?.threadRootId) { void openThread(target.threadRootId); setRoomSearchOpen(false); return }
    // 여기부터는 본채널로 가는 길이다. 휴대폰에서 스레드 패널이 화면을 덮고 있으면 본채널은
    // display:none이라 scrollIntoView가 아무 일도 하지 않는다 — 갈 자리를 먼저 화면에 세운다.
    // (스레드 루트가 본채널 말을 인용한 경우가 그 길이다. closeThread와 같은 한 줄이다.)
    setMobilePane((current) => (current === 'thread' ? 'chat' : current))
    // 창 밖에 있으면 먼저 그 지점까지 펼친다. 안 그러면 눌러도 아무 일도 안 일어난다.
    const index = channelMessages.findIndex((item) => item.id === messageId)
    if (index >= 0) {
      const needed = channelMessages.length - index
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

  // 맨 아래로 따라 내려가는 것도 본채널의 일이다. 배열 전체 길이를 보면 옆 칸에 답글이 붙을 때마다
  // 본채널이 아무것도 나타나지 않은 채로 바닥까지 끌려 내려간다.
  useEffect(() => {
    if (!open) return
    messageEndRef.current?.scrollIntoView({ block: 'nearest' })
  }, [open, selectedId, channelMessages.length])

  useEffect(() => {
    if (!open) return
    if (rosterOverride) {
      // 게스트: 보이는 프로젝트의 멤버만. 상태 점은 모르니 비워 두고, 게스트 자신은 역할 라벨로 구분한다.
      setDirectory(rosterOverride.map((entry) => ({ id: entry.id, accountId: entry.id, name: entry.name, team: entry.team || '', role: entry.kind === 'guest' ? '게스트' : entry.jobRole || '' })))
      return
    }
    let active = true
    fetch('/api/directory')
      .then(async (response) => {
        if (!response.ok) throw new Error('directory-load')
        // kind와 active를 타입에 적는다. 둘 다 서버가 실제로 내려보내고(app.mjs의 /api/directory)
        // 아래 스프레드로 흘러 노티스 컴포저의 회사 갈래가 게스트를 빼는 근거가 된다. 타입이 이 사실을
        // 말하지 않으면, 매핑을 명시적으로 바꾸는 순간 게스트가 '확인 대상'에 되돌아온다.
        return response.json() as Promise<{ members?: Array<{ id: string; name: string; team: string; role: string; status: Person['status']; system?: boolean; kind?: 'employee' | 'guest'; active?: boolean }> }>
      })
      .then(({ members }) => {
        if (!active || !Array.isArray(members)) return
        setDirectory(members.map((member) => ({ ...member, accountId: member.id })))
      })
      .catch(() => undefined)
    return () => { active = false }
  }, [open, rosterOverride])

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
        // 성공이든 실패든 '방 목록 요청이 한 번은 답했다'를 남긴다. 딥링크가 '들어갈 수 있는 방인가'를
        // 판정하려면 이 사실이 필요하고, 실패에도 켜야 기다림에 끝이 있다(영영 안 열리는 딥링크를 만들지 않는다).
        .finally(() => { if (active) setConversationsSettled(true) })
    }
    refresh()
    // 5초 폴링을 서버 이벤트 스트림으로 대체했다. 새 메시지가 있을 때만 다시 읽는다.
    messengerRefreshRef.current = refresh
    return () => { active = false; messengerRefreshRef.current = null }
  }, [open, setConversations, workspaceScope])

  useEventStream(open, (event) => {
    if (event.kind !== 'message' && event.kind !== 'resync') return
    messengerRefreshRef.current?.()
    // 게스트의 이벤트는 {key, version}으로 축약돼 방 id를 싣지 못한다. 어느 방이 바뀌었는지 모르므로
    // 열려 있는 스레드는 무조건 다시 읽는다 — 남의 방 때문에 한 번 더 읽는 편이, 내 스레드가 멈춰 있는 것보다 낫다.
    if (threadRootId) void refreshThread(threadRootId)
    // 공지도 같은 'message' 이벤트를 탄다. 새 SSE 종류를 만들면 게스트 축약 규약까지 손대야 한다.
    reloadNotices()
    setNoticeRefreshToken((token) => token + 1)
  })

  useEffect(() => {
    onUnreadChange?.(unreadTotal)
  }, [onUnreadChange, unreadTotal])

  useEffect(() => {
    if (activeConversation || myConversations.length === 0) return
    setSelectedId(myConversations[0].id)
  }, [activeConversation, myConversations])

  /**
   * 방을 고르는 모든 길이 지나는 한 곳.
   *
   * pane까지 되돌리지 않으면 공지 보드가 열린 채 선택만 바뀌어, 데스크톱에서는 아무 반응이 없고
   * 휴대폰에서는 사이드바만 사라져 보드에 갇힌다. 네 번째 경로가 생겨도 여기만 부르면 새지 않는다.
   */
  const selectConversation = (id: string) => {
    setPane('chat')
    setSelectedId(id)
    setMobilePane('chat')
    // 스레드는 방에 매여 있다. 방을 바꾸고도 열어 두면 옆 칸이 다른 방의 대화를 그린 채 남는다.
    closeThread()
  }

  /**
   * 알림·전역 검색이 가리킨 자리를 연다. 클릭보다 나중에 도착한 목록에서만 "그런 공지 없다"를
   * 판정하고, 그 전에는 focus를 소비하지 않은 채 목록이 도착할 때 다시 시도한다.
   * 다 읽고도 목록에 없으면(권한이 없거나 보관됨) 화면을 갈아 끼우지 않고 공지 보드만 연다 —
   * "그 공지는 없습니다"를 빈 화면으로 말하는 것보다 목록을 보여 주는 편이 낫다.
   */
  useEffect(() => {
    if (!focus?.at) return
    if (focus.noticeId) {
      const target = notices.find((item) => item.id === focus.noticeId)
      if (!target) {
        // 판정 자격은 시각이 정한다(utils/noticeFocus). 클릭보다 먼저 받은 목록으로 "없다"고 말하면
        // focus가 소비되어 재시도가 영영 오지 않고, 사용자는 공지 대신 공지 보드에 떨어진다.
        if (!canJudgeMissingNotice(noticesState, noticesLoadedAt, focus.at) && focusReloadRef.current !== focus.at) {
          // 기다리기만 하면 목록을 다시 읽을 계기가 없을 수도 있다(서랍이 이미 열려 있고 SSE가 끊긴 경우).
          // 클릭 한 번에 딱 한 번만 다시 읽는다: 그 응답이 성공이든 실패든 이 effect가 한 번 더 돌고,
          // 그때는 이 가지를 지나 아래로 내려간다 — 기다리다 영영 아무 일도 안 하는 자리를 남기지 않는다.
          focusReloadRef.current = focus.at
          reloadNotices()
          return
        }
        // 게스트에게는 회사 공지도 공지 보드도 존재하지 않는다 — 없는 화면으로 보내지 않는다.
        // 열려 있던 스레드도 함께 닫는다 — 공지 보드 옆에 다른 방의 스레드가 서 있으면 안 된다.
        if (!readOnlyRooms) { setPane('notices'); setMobilePane('chat'); closeThread() }
        onFocusHandled?.()
        return
      }
      // 볼 수는 있어도 들어갈 수 없는 방이 있다. 프로젝트 공지는 프로젝트 멤버 전원에게 보이지만
      // (notices.mjs의 noticeVisibleTo는 내부 구성원에게 projectRoleOf만 본다) 채널 참여자가 아니면
      // 그 방은 내 목록에 없다 — 그대로 고르면 activeConversation이 사라져 '대화를 선택하세요'로
      // 떨어지고 공지는 어디에도 뜨지 않는다. 그런 공지는 회사 공지와 같은 자리(공지 보드)에서 연다.
      const room = target.conversationId && myConversations.some((item) => item.id === target.conversationId)
        ? target.conversationId
        : null
      // '못 들어가는 방'이라는 판정에만 자격이 필요하다. 목록에 이미 있으면 증거가 손안에 있으니 바로 간다.
      // 없다고 말하려면 방 목록이 한 번은 답해야 한다 — conversations는 localStorage 캐시에서 동기로
      // 시작하지만(useWorkspaceState) 처음 여는 브라우저·캐시를 지운 경우·방금 초대된 방이면 공지 응답이
      // 방 목록보다 먼저 도착한다. 그때 판정하면 내부 구성원은 방 대신 보드로 떨어지고, 게스트는 아래
      // !readOnlyRooms 때문에 아무 갈래도 타지 못한 채 focus만 소비된다 — 딥링크가 아무 일도 하지 않는다.
      // 목록 요청은 성공·실패 모두 conversationsSettled를 켜므로 이 기다림에는 끝이 있다.
      if (target.conversationId && !room && !conversationsSettled) return
      setOpenNoticeId(target.id)
      if (room) {
        // 스트립은 방마다 따로 물어보므로 방을 바꾸는 이 순간에는 카드가 아직 없다.
        // 몇 밀리초를 세는 대신 '카드가 붙으면'을 기다린다(noticeCardRef).
        pendingNoticeScrollRef.current = target.id
        selectConversation(room)
      } else if (!readOnlyRooms) {
        // 게스트에게는 공지 보드가 없다 — 없는 화면으로 보내지 않는다(위 갈래와 같은 가드).
        pendingNoticeScrollRef.current = target.id
        setPane('notices')
        setMobilePane('chat')
        closeThread()
      }
      onFocusHandled?.()
      return
    }
    if (focus.conversationId) {
      selectConversation(focus.conversationId)
      // 스레드 딥링크는 방을 연 다음 옆 칸을 연다. selectConversation이 방금 스레드를 닫았으므로
      // 여는 것은 그 뒤여야 한다 — 순서가 뒤집히면 열자마자 닫힌다.
      if (focus.threadRootId) void openThread(focus.threadRootId, focus.conversationId)
      if (focus.messageId) {
        // 찾아갈 말이 창 밖이면 먼저 그 지점까지 펼친다. jumpToMessage는 지금 열려 있는 방을 보므로
        // 방을 막 바꾼 이 순간에는 대상 방을 직접 찾아 세어야 한다.
        // 세는 배열은 여기서도 본채널이다 — visibleCount는 channelMessages 위에서 잘리는 수이므로,
        // 답글이 섞인 배열로 세면 그리지도 않을 말을 창 크기에 넣어 창이 필요 이상으로 넓어진다.
        const room = conversations.find((item) => item.id === focus.conversationId)
        const mainMessages = (room?.messages ?? []).filter((item) => !item.threadRootId)
        const index = mainMessages.findIndex((item) => item.id === focus.messageId)
        if (index >= 0) setVisibleCount((current) => Math.max(current, mainMessages.length - index + 10))
        window.setTimeout(() => jumpToMessage(focus.messageId!), 120)
      }
    }
    onFocusHandled?.()
    // 목록이 늦게 도착하는 경우를 위해 도착 시각과 적재 상태도 함께 본다. focus.at은 클릭마다 새로 찍힌다.
    // 방 목록도 같은 이유로 deps에 있다 — 물러난 뒤 목록이 도착하면 이 effect가 한 번 더 돌아야 한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.at, notices.length, noticesState, noticesLoadedAt, conversationsSettled])

  if (!open) return null

  const replaceConversationLocally = (next: Conversation) => setConversations((current) => {
    const exists = current.some((item) => item.id === next.id)
    return exists ? current.map((item) => item.id === next.id ? next : item) : [next, ...current]
  }, { persist: false })

  const chooseConversation = async (id: string) => {
    if (!myConversations.some((item) => item.id === id)) return
    // 공지 보드를 보는 중일 수 있다. pane까지 되돌리지 않으면 읽음 처리만 하고 화면은 그대로다.
    selectConversation(id)
    setShowConversationMenu(false)
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
      selectConversation(body.conversation.id)
      setListMode('recent')
      setQuery('')
      onToast(body.created ? person.name + '님과 새 대화를 시작했습니다.' : person.name + '님과 진행 중인 대화를 열었습니다.')
    } catch {
      onToast('메신저 서버에 연결하지 못했습니다.')
    }
  }

  /**
   * 메시지 한 건 보내기. 스레드 답글이면 threadRootId를 함께 싣는다 —
   * 서버가 답글 append와 루트 집계를 같은 커밋에서 갱신하므로, 돌려받은 대화 하나로
   * 본채널 요약과 스레드가 동시에 맞는다.
   */
  const sendMessage = async (event: FormEvent, target?: { threadRootId: string }) => {
    event.preventDefault()
    const inThread = Boolean(target?.threadRootId)
    const text = (inThread ? threadMessage : message).trim()
    // 두 컴포저는 서로를 막지 않는다. 한쪽이 보내는 중이라고 다른 쪽 단추가 조용히 아무 일도 하지 않으면,
    // 사람은 눌린 단추가 왜 반응하지 않는지 알 길이 없다 — 막을 것이면 그 단추를 disabled로 적는다.
    if (!text || !activeConversation) return
    if (inThread ? threadSending : (messageSending || attachmentUploading)) return
    // 첨부는 본채널 컴포저에만 있다. 스레드 답글이 방의 첨부 대기줄을 함께 비우면
    // 본채널에 올리려던 파일이 말없이 사라진다.
    const attachments = inThread ? [] : activePendingAttachments
    const setSending = inThread ? setThreadSending : setMessageSending
    setSending(true)
    try {
      const response = await fetch(`/api/messenger/conversations/${encodeURIComponent(activeConversation.id)}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}),
        },
        body: JSON.stringify({
          text,
          attachments,
          // 인용 대상은 컴포저마다 따로다. 스레드에서 고른 말은 그 스레드 안만 가리킬 수 있고
          // (서버가 다시 판정한다), 본채널에서 고른 말은 답글일 수 없다.
          ...((inThread ? threadReplyTo : replyTo) ? { replyTo: (inThread ? threadReplyTo : replyTo)!.id } : {}),
          ...(target?.threadRootId ? { threadRootId: target.threadRootId } : {}),
        }),
      })
      const body = await response.json().catch(() => null) as { conversation?: Conversation; error?: { message?: string } } | null
      if (!response.ok || !body?.conversation) {
        onToast(body?.error?.message ?? '메시지를 보내지 못했습니다.')
        return
      }
      await replaceConversationLocally(body.conversation)
      if (inThread) {
        setThreadMessage('')
        setThreadReplyTo(null)
        await refreshThread(target!.threadRootId)
        return
      }
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
      setSending(false)
    }
  }

  /** 스레드 결론을 본채널에 올린다. 성공하면 채널 미리보기가 그 요약으로 바뀐다. */
  const shareThread = async (text: string) => {
    if (!activeConversation || !threadRootId || threadPending) return
    setThreadPending(true)
    try {
      const response = await fetch(
        `/api/messenger/conversations/${encodeURIComponent(activeConversation.id)}/threads/${encodeURIComponent(threadRootId)}/share`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}) },
          body: JSON.stringify({ text }),
        },
      )
      const body = await response.json().catch(() => null) as { conversation?: Conversation; error?: { message?: string } } | null
      if (!response.ok || !body?.conversation) {
        onToast(body?.error?.message ?? '채널에 공유하지 못했습니다.')
        return
      }
      await replaceConversationLocally(body.conversation)
      setShareOpen(false)
      onToast('스레드 내용을 채널에 공유했습니다.')
    } catch {
      onToast('메신저 서버에 연결하지 못했습니다.')
    } finally {
      setThreadPending(false)
    }
  }

  /** 스레드를 업무·결정·자료로 올린다. 무엇이 되는지는 서버가 정하고, 화면은 결과만 말한다. */
  const promoteThread = async (kind: ThreadPromotionKind) => {
    if (!activeConversation || !threadRootId || threadPending) return
    const rootId = threadRootId
    // 이미 올린 갈래면 막지 않고 한 번 되묻는다. 업무·자료는 서버가 두 번을 허용하므로 화면이 영영 막으면
    // 서버가 허락한 일을 화면이 금지하게 된다(HARD-WON RULE 1) — 대신 무슨 일이 생기는지 먼저 말한다.
    // 결정은 되묻지 않는다. 서버가 409로 답하므로 '한 건 더 생긴다'는 말은 거짓이 되고,
    // 그 거절 문장은 서버가 자기 낱말로 이미 가지고 있다.
    const promotion = THREAD_PROMOTIONS.find((item) => item.kind === kind)
    if (promotion?.duplicates && (threadPromoted[rootId] ?? []).includes(kind) && threadPromoteAgain !== kind) {
      setThreadPromoteAgain(kind)
      onToast(`이미 ${promotion.label} 올렸습니다. 한 번 더 누르면 같은 내용으로 한 건 더 생깁니다.`)
      return
    }
    setThreadPending(true)
    try {
      const response = await fetch(
        `/api/messenger/conversations/${encodeURIComponent(activeConversation.id)}/threads/${encodeURIComponent(threadRootId)}/promote`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}) },
          body: JSON.stringify({ kind }),
        },
      )
      const body = await response.json().catch(() => null) as { created?: { label?: string }; error?: { message?: string } } | null
      if (!response.ok || !body?.created) {
        onToast(body?.error?.message ?? '올리지 못했습니다.')
        return
      }
      // 올린 사실을 단추가 기억한다. 업무·자료는 서버가 두 번을 막지 않으므로, 화면이 말하지 않으면
      // 같은 결론이 조용히 두 벌 생긴다. 스레드를 닫으면 이 기억도 사라진다 — 판정하는 쪽은 여전히 서버다.
      setThreadPromoted((current) => ({ ...current, [rootId]: [...(current[rootId] ?? []), kind] }))
      setThreadPromoteAgain(null)
      onToast(`${kind === 'task' ? '업무' : kind === 'decision' ? '결정' : '자료'}로 올렸습니다: ${body.created.label ?? ''}`.trim())
    } catch {
      onToast('메신저 서버에 연결하지 못했습니다.')
    } finally {
      setThreadPending(false)
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
      .then((body) => { if (body) onToast(pinned ? '고정했습니다.' : '고정을 해제했습니다.') })

  // ── 공지 호출 한 벌 ──────────────────────────────────────────
  // 모든 네트워크 호출을 try/catch로 감싼다. 거절된 fetch가 버튼을 영영 잠그면 안 된다.
  const refreshNotices = () => { reloadNotices(); setNoticeRefreshToken((token) => token + 1) }
  const callNotice = async (path: string, init: RequestInit, failure: string) => {
    try {
      const response = await fetch(`/api/notices${path}`, {
        ...init,
        headers: {
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}),
        },
      })
      // 화면은 error.message만 읽는다. code로 갈라지는 자리가 하나도 없으므로 타입에도 두지 않는다 —
      // 남겨 두면 다음 사람이 '어딘가 code로 분기하는 곳이 있나 보다'라고 읽는다.
      const body = await response.json().catch(() => null) as { notice?: Notice; reminded?: number; error?: { message?: string } } | null
      if (!response.ok) {
        // 문구는 서버가 짓는다. 쿨다운의 남은 분까지 서버 message에 들어 있으므로 여기서 다시 짓지 않는다 —
        // 같은 사실에 대한 문장이 두 파일에 있으면 한쪽만 고쳐도 갈라진다.
        onToast(body?.error?.message ?? failure)
        return null
      }
      refreshNotices()
      return body ?? {}
    } catch {
      onToast('서버에 연결하지 못했습니다.')
      return null
    }
  }

  const ackNotice = async (notice: Notice) => {
    setNoticeBusyId(notice.id)
    try { if (await callNotice(`/${encodeURIComponent(notice.id)}/ack`, { method: 'POST' }, '확인을 기록하지 못했습니다.')) onToast('확인했습니다.') }
    finally { setNoticeBusyId('') }
  }

  const archiveNotice = async (notice: Notice, archived: boolean) => {
    setNoticeBusyId(notice.id)
    try {
      const body = await callNotice(`/${encodeURIComponent(notice.id)}/archive`, { method: 'POST', body: JSON.stringify({ archived }) }, '보관 상태를 바꾸지 못했습니다.')
      if (body) onToast(archived ? '공지를 보관했습니다. 보관함에서 되살릴 수 있습니다.' : '공지를 다시 올렸습니다.')
    } finally { setNoticeBusyId('') }
  }

  const loadNoticeAcks = async (notice: Notice) => {
    setNoticeAcksState('loading')
    try {
      const response = await fetch(`/api/notices/${encodeURIComponent(notice.id)}`, { headers: workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined })
      if (!response.ok) throw new Error('notice-acks')
      const body = await response.json() as NoticeAckList
      setNoticeAcks({ confirmed: body.confirmed ?? [], unconfirmed: body.unconfirmed ?? [] })
      setNoticeAcksState('ready')
    } catch {
      setNoticeAcksState('error')
    }
  }

  const remindNotice = async (notice: Notice) => {
    setNoticeBusyId(notice.id)
    setNoticePending(true)
    try {
      const body = await callNotice(`/${encodeURIComponent(notice.id)}/remind`, { method: 'POST' }, '다시 알리지 못했습니다.')
      if (body) { onToast(`미확인 ${body.reminded ?? 0}명에게 다시 알렸습니다.`); void loadNoticeAcks(notice) }
    } finally { setNoticeBusyId(''); setNoticePending(false) }
  }

  const openNoticeAcks = (notice: Notice) => {
    setNoticeAcks({ confirmed: [], unconfirmed: [] })
    setNoticeDialog({ mode: 'acks', notice })
    void loadNoticeAcks(notice)
  }

  const saveNotice = async (draft: NoticeDraft) => {
    const editing = noticeDialog && noticeDialog.mode === 'edit' ? noticeDialog.notice : undefined
    setNoticePending(true)
    try {
      const payload = editing
        ? { title: draft.title, body: draft.body, attachments: draft.attachments, mustRead: draft.mustRead, ...(draft.targetIds ? { targetIds: draft.targetIds } : {}) }
        : { scope: draft.conversationId ? 'project' : 'company', ...(draft.conversationId ? { conversationId: draft.conversationId } : {}), title: draft.title, body: draft.body, attachments: draft.attachments, mustRead: draft.mustRead, ...(draft.targetIds ? { targetIds: draft.targetIds } : {}) }
      const body = await callNotice(
        editing ? `/${encodeURIComponent(editing.id)}` : '',
        { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(payload) },
        editing ? '공지를 저장하지 못했습니다.' : '공지를 올리지 못했습니다.',
      )
      if (!body) return
      setNoticeDialog(null)
      if (body.notice) setOpenNoticeId(body.notice.id)
      onToast(editing ? '공지를 저장했습니다.' : '공지를 올렸습니다.')
    } finally { setNoticePending(false) }
  }

  const openNoticeBoard = () => {
    setPane('notices')
    setShowConversationMenu(false)
    setMobilePane('chat')
    // 스레드는 방에 매여 있다(selectConversation과 같은 이유). 보드로 갈아 끼운 가운데 칸 옆에
    // 남의 방 스레드가 그대로 서 있으면, 화면 하나가 서로 다른 두 자리를 동시에 말한다.
    closeThread()
  }

  const noticeHandlers = (notice: Notice) => ({
    readOnly: readOnlyRooms,
    workspaceScope,
    onAck: () => void ackNotice(notice),
    onOpenAcks: () => openNoticeAcks(notice),
    onRemind: () => void remindNotice(notice),
    onEdit: () => setNoticeDialog({ mode: 'edit', conversationId: notice.conversationId, notice }),
    onArchive: (archived: boolean) => void archiveNotice(notice, archived),
    onToast,
  })
  /**
   * 딥링크가 가리킨 카드로 데려간다 — 시간이 아니라 '그 카드가 화면에 붙었는가'가 신호다.
   *
   * 판정을 effect가 아니라 이 ref 콜백에서 하는 이유: 스트립과 보드는 서로 다른 목록을 따로
   * 물어보고(보드는 NoticeBoard 안에서 useNotices를 돌린다), effect의 deps로는 보드의 목록이
   * 도착한 순간을 알 길이 없다. 카드를 그리는 쪽이 알려 주게 하면 두 화면이 한 벌을 쓴다.
   * (이 콜백은 렌더마다 새로 만들어지므로 React가 매번 떼었다 붙인다 — 카드가 이미 붙어 있는
   *  방에서 딥링크를 눌러도 이 자리를 지난다.)
   * 손으로 펼친 카드는 대상이 아니다 — pendingNoticeScrollRef에 적힌 한 건만 본다.
   * 타이머는 effect 정리에 매달지 않는다. 매달면 옆방 메시지 한 건에 목록이 다시 읽히는 순간
   * 정리가 돌아 타이머만 죽고 강조가 카드에 그대로 굳는다.
   */
  const noticeCardRef = (id: string) => (node: HTMLElement | null) => {
    if (!node || pendingNoticeScrollRef.current !== id) return
    pendingNoticeScrollRef.current = ''
    node.scrollIntoView({ block: 'center', behavior: 'smooth' })
    node.classList.add('is-focused')
    window.setTimeout(() => node.classList.remove('is-focused'), 1_600)
  }

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
      selectConversation(body.conversation.id)
      setListMode('recent')
      setGroupDialog(null)
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

  /**
   * 말풍선 하나. 본채널과 스레드 패널이 같은 함수를 쓴다 — 인용·반응·첨부·수정/삭제가
   * 두 벌이 되면 한쪽에만 고쳐지고, 사람은 같은 말이 자리마다 다르게 보이는 화면을 얻는다.
   *
   * inThread일 때 다른 것: 고정 단추가 없고(고정 스트립은 본채널 화면이다), 스레드 열기 단추가 없으며
   * (이미 그 안이다), 답글 요약 줄을 그리지 않고(같은 말을 두 번 한다), '답장'이 스레드 컴포저를 겨눈다.
   *
   * 루트는 본채널과 패널 양쪽에 그려지므로 수정 상태도 칸까지 함께 본다 — 아니면 두 벌이 동시에 편집 상자가 된다.
   */
  const renderMessage = (item: ChatMessage, { inThread = false }: { inThread?: boolean } = {}) => {
    const mine = currentIdentityIds.includes(item.senderId) || item.senderId === 'me'
    const quoted = item.replyTo ? selectedConversation.messages.find((candidate) => candidate.id === item.replyTo) : undefined
    const senderInactive = !mine && directory.find((person) => person.id === item.senderId || person.accountId === item.senderId)?.active === false
    // 읽음 표시는 본채널의 것이다. /read는 본채널 메시지만 찍으므로 답글의 readBy에는 보낸 사람뿐이고,
    // 그 수를 '안 읽음'으로 그리면 아무도 안 읽었다는 거짓말이 된다.
    const receipts = item.threadRootId ? '' : readCountFor(item)
    // 인용을 눌렀을 때 갈 곳이 있는가. 패널 안 말풍선은 ref를 달지 않으므로(점프의 목적지는 언제나 본채널이다)
    // 같은 스레드 안을 가리키는 인용은 스크롤할 자리가 없다 — 375px show-thread에서는 본채널 열이 아예 display:none이다.
    // 비교 대상은 지금 열려 있는 스레드의 루트다. item.threadRootId로 재면 패널에 그려지는 루트에서
    // undefined === undefined가 참이 되어, 본채널에 멀쩡히 있는 인용까지 갈 곳 없는 문장으로 바뀐다.
    const quotedInThread = inThread && Boolean(quoted) && (quoted!.threadRootId === threadRootId || quoted!.id === threadRootId)
    const pinned = (selectedConversation.pinnedMessageIds ?? []).includes(item.id)
    const removed = Boolean(item.deletedAt)
    const isEditing = editing?.id === item.id && editing.inThread === inThread
    return (
      <article
        className={'messenger-message' + (mine ? ' mine' : '') + (removed ? ' removed' : '')}
        key={item.id}
        // 스레드 패널에도 같은 루트가 그려진다. 두 곳이 같은 ref 칸을 쓰면 나중에 그려진 쪽이 이겨서
        // 본채널 점프가 옆 칸으로 간다 — 점프의 목적지는 언제나 본채널이다.
        ref={inThread ? undefined : (node) => { messageRefs.current[item.id] = node }}
      >
        {!mine && <Avatar name={item.senderName} compact />}
        <div>
          {/* R16-L: 수신 웹훅이 올린 말풍선. 사람이 쓴 말과 기계가 보낸 말을 눈으로 갈라 놓는다. */}
          {!mine && <strong>{item.senderName}{item.senderRole === 'system' && <em className="messenger-system-label">외부</em>}{senderInactive && <span className="messenger-inactive-tag">비활성</span>}</strong>}
          {quoted && <QuotedMessage senderName={quoted.senderName} text={quoted.deletedAt ? '삭제된 메시지' : quoted.text} onJump={quotedInThread ? undefined : () => jumpToMessage(quoted.id)} />}
          <div className="messenger-bubble-row">
            {mine && (
              <span className="messenger-message-meta">
                {receipts && <small>{receipts}</small>}
                <time>{item.time}</time>
              </span>
            )}
            {isEditing ? (
              <span className="messenger-edit-box">
                <label>
                  <span className="sr-only">메시지 수정</span>
                  <textarea
                    rows={2}
                    value={editing.text}
                    autoFocus
                    onChange={(event) => setEditing({ id: item.id, text: event.target.value, inThread })}
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
          {/* 루트가 지워져도 요약 줄은 남는다 — 답글은 다른 사람의 말이고, 여기가 그 스레드로 가는 유일한 문이다. */}
          {!inThread && !item.threadRootId && (item.replyCount ?? 0) > 0 && (
            <ThreadSummaryButton
              replyCount={item.replyCount ?? 0}
              lastReplyAt={item.lastReplyAt}
              open={threadRootId === item.id}
              onOpen={() => void openThread(item.id)}
            />
          )}
          {!inThread && item.sharedFromThreadId && (
            <ThreadOriginButton onOpen={() => void openThread(item.sharedFromThreadId!)} />
          )}
          {!removed && !isEditing && (
            <MessageActionBar
              canEdit={mine && !readOnlyRooms}
              canDelete={(mine || canManage || selectedConversation.ownerId === currentUserId) && !readOnlyRooms}
              canPin={!readOnlyRooms}
              // 고정 스트립은 본채널 화면이다. 답글은 서버가 언제나 409로 되돌리므로
              // (THREAD_REPLY_NOT_PINNABLE), 눌러도 오류 토스트만 나는 단추를 답글마다 세우지 않는다.
              pinnable={!item.threadRootId}
              onOpenThread={inThread || item.threadRootId ? undefined : () => void openThread(item.id)}
              pinned={pinned}
              // 답장도 칸을 따라간다. 스레드에서 누른 답장이 본채널 컴포저를 겨누면, 휴대폰에서는
              // 그 컴포저가 display:none이라 아무 일도 일어나지 않고, 데스크톱에서는 답글 본문이
              // 본채널 인용 줄로 새어 나간다.
              onReply={inThread
                ? () => { setThreadReplyTo(item); threadComposerRef.current?.focus() }
                : () => { setReplyTo(item); composerRef.current?.focus() }}
              onReact={(emoji) => toggleReaction(item.id, emoji)}
              onPin={() => togglePin(item.id, !pinned)}
              onEdit={() => setEditing({ id: item.id, text: item.text, inThread })}
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
  }

  return (
    <div className={'collab-overlay messenger-overlay' + (embedded ? ' is-embedded' : '')}>
      {!embedded && <button className="collab-overlay-backdrop" type="button" aria-label="메신저 닫기" onClick={onClose} />}
      <div
        id="company-messenger"
        ref={overlayRef}
        className={['messenger-drawer',
          mobilePane === 'list' ? 'show-list' : mobilePane === 'thread' ? 'show-thread' : 'show-chat',
          threadRootId ? 'has-thread' : '',
          embedded ? 'is-embedded' : ''].filter(Boolean).join(' ')}
        role={embedded ? 'region' : 'dialog'}
        aria-modal={embedded ? undefined : true}
        aria-labelledby="messenger-title"
      >
        <header className="messenger-header">
          <div>
            <span className="collab-kicker">{readOnlyRooms ? 'PROJECT CHANNELS' : 'INTERNAL MESSENGER'}</span>
            <h2 id="messenger-title">{readOnlyRooms ? '프로젝트 채널' : '사내 메신저'}</h2>
          </div>
          <div className="messenger-header-actions">
            <span className="messenger-unread-summary">{currentUserTeam} · {readOnlyRooms ? '게스트' : canManage ? '관리자' : '직원'} · 읽지 않음 {unreadTotal}개</span>
            {!embedded && <button type="button" aria-label="메신저 닫기" onClick={onClose}><X size={22} /></button>}
          </div>
        </header>

        <div className="messenger-layout">
          <aside className="messenger-sidebar" aria-label="대화 목록">
            <div className="messenger-sidebar-tools">
              {!readOnlyRooms && <Button tone="primary" full
                type="button"
                onClick={() => { setListMode('people'); setQuery('') }}
              >
                <UserPlus size={18} /> 새 대화
              </Button>}
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
              <button type="button" role="tab" aria-selected={listMode === 'teams'} onClick={() => setListMode('teams')}>{readOnlyRooms ? '채널' : '팀'}</button>
              {!readOnlyRooms && <button type="button" role="tab" aria-selected={listMode === 'people'} onClick={() => setListMode('people')}>직원</button>}
            </div>

            <div className="messenger-conversation-list">
              {/* 전사 채널(team-ops)이 없는 새 테넌트에도 늘 있는 자리다. 게스트는 회사 공지가 존재하지 않으므로
                  이 행도 보드도 없다 — 게스트의 공지는 자기 채널 스트립에만 뜬다. */}
              {!readOnlyRooms && (
                <button
                  type="button"
                  className={'messenger-conversation-row messenger-notice-home' + (pane === 'notices' ? ' active' : '')}
                  aria-current={pane === 'notices' ? 'true' : undefined}
                  onClick={openNoticeBoard}
                >
                  <span className="messenger-team-icon"><Megaphone size={20} aria-hidden="true" /></span>
                  <span className="messenger-conversation-copy">
                    <span><strong>회사 공지</strong><time>{latestCompanyNotice ? formatListDateTime(latestCompanyNotice.createdAt) : ''}</time></span>
                    {/* 목록이 도착한 뒤에만 '없다'고 말한다. 오는 중이거나 못 받았으면 아무 말도 하지 않는다. */}
                    <small>{latestCompanyNotice?.title ?? (companyNoticesState === 'ready' ? '아직 공지가 없습니다' : '')}</small>
                  </span>
                  {myUnconfirmed > 0 && <em aria-label={`확인하지 않은 필독 공지 ${myUnconfirmed}개`}>{myUnconfirmed}</em>}
                </button>
              )}
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
                    <span>{listMode === 'teams' ? readOnlyRooms ? '프로젝트 채널' : '팀 대화' : '최근 대화'} {filteredConversations.length}개</span>
                    {!readOnlyRooms && <Button tone="quiet" size="sm" onClick={() => setGroupDialog('create')}><Plus size={15} /> 새 그룹방</Button>}
                  </div>
                  {/* 공지 보드를 보는 중에는 대화 행이 '지금 이 화면'이 아니다. 두 행이 동시에
                      현재로 표시되면 화면 낭독기가 현재 항목을 둘이라고 말한다. */}
                  {filteredConversations.map((conversation) => (
                    <button
                      className={'messenger-conversation-row' + (pane === 'chat' && conversation.id === selectedId ? ' active' : '')}
                      type="button"
                      aria-current={pane === 'chat' && conversation.id === selectedId ? 'true' : undefined}
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

          {pane === 'notices' ? (
            <NoticeBoard
              workspaceScope={workspaceScope}
              channels={noticeChannels}
              canCompose={canComposeNotice}
              openId={openNoticeId}
              busyId={noticeBusyId}
              refreshToken={noticeRefreshToken}
              onOpenChange={setOpenNoticeId}
              onBack={() => setPane('chat')}
              onBackToList={() => { setPane('chat'); setMobilePane('list') }}
              onCompose={() => setNoticeDialog({ mode: 'create', conversationId: null })}
              handlers={noticeHandlers}
              cardRef={noticeCardRef}
            />
          ) : (
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
                      {!readOnlyRooms && activeConversation.kind === 'group' && (activeConversation.ownerId === currentUserId || canManage) && (
                        <button type="button" onClick={() => { setGroupDialog('manage'); setShowConversationMenu(false) }}><Users size={17} /> 방 이름·참여자 관리</button>
                      )}
                      {/* 프로젝트 채널에만 공지를 올릴 수 있다. 권한 최종 판정은 서버가 한다(403). */}
                      {!readOnlyRooms && Boolean(activeConversation.projectId) && (
                        <button type="button" onClick={() => { setNoticeDialog({ mode: 'create', conversationId: activeConversation.id }); setShowConversationMenu(false) }}><Megaphone size={17} /> 공지 올리기</button>
                      )}
                      {/*
                        R15-I: 방마다 알림 세기를 셋 중에서 고른다. 끄기만 있으면
                        "시끄럽지만 내 이름 부르면 봐야 하는 방"을 다룰 방법이 없다.
                        고른 값은 알림 설정 한 곳에 저장되고, 푸시 판정이 그것만 본다.
                      */}
                      <div className="messenger-room-alert" role="group" aria-label="이 방 알림">
                        <span>{roomAlertMode === 'off' ? <BellOff size={17} /> : <Bell size={17} />} 이 방 알림</span>
                        <div>
                          {(['all', 'mention', 'off'] as const).map((mode) => (
                            <button
                              key={mode}
                              type="button"
                              className={roomAlertMode === mode ? 'is-active' : undefined}
                              aria-pressed={roomAlertMode === mode}
                              onClick={() => { void setRoomAlertMode(activeConversation.id, mode) }}
                            >
                              {mode === 'all' ? '모두' : mode === 'mention' ? '멘션만' : '끔'}
                            </button>
                          ))}
                        </div>
                      </div>
                      {/* 게스트의 참여는 초대한 회사가 범위로 정한다. 스스로 나가거나 방을 지우는 길은 두지 않는다. */}
                      {!readOnlyRooms && <button type="button" onClick={() => { setConversationAction('leave'); setShowConversationMenu(false) }}><LogOut size={17} /> 대화방 나가기</button>}
                      {!readOnlyRooms && canManage && <button className="danger" type="button" onClick={() => { setConversationAction('delete'); setShowConversationMenu(false) }}><Trash2 size={17} /> 대화방 삭제</button>}
                    </div>
                  )}
                </div>
              )}
            </header>

            {roomSearchOpen && activeConversation && (
              <RoomSearchPanel
                query={roomSearchQuery}
                matches={roomSearchMatches}
                threadMatches={threadSearchMatches}
                onQueryChange={setRoomSearchQuery}
                onJump={jumpToMessage}
                onOpenThread={(rootId) => void openThread(rootId)}
                onClose={() => { setRoomSearchOpen(false); setRoomSearchQuery('') }}
              />
            )}

            <NoticeStrip
              notices={channelNotices}
              openId={openNoticeId}
              busyId={noticeBusyId}
              onOpenChange={setOpenNoticeId}
              handlers={noticeHandlers}
              cardRef={noticeCardRef}
            />

            {pinnedMessages.length > 0 && (
              <div className="messenger-pinned" aria-label="고정된 메시지">
                <Pin size={15} aria-hidden="true" />
                <ul>
                  {pinnedMessages.map((item) => (
                    <li key={item.id}>
                      <button type="button" onClick={() => jumpToMessage(item.id)}>
                        <strong>{item.senderName}</strong>
                        <span>{item.text.length > 70 ? `${item.text.slice(0, 69)}…` : item.text}</span>
                      </button>
                      {!readOnlyRooms && <IconButton tone="quiet" size="sm" aria-label="고정 해제" onClick={() => togglePin(item.id, false)}><PinOff size={14} /></IconButton>}
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
              {channelMessages.length === 0 && (
                <div className="collab-empty"><MessageCircle size={32} /><strong>첫 메시지를 보내세요</strong><span>업무 내용과 파일을 안전하게 공유할 수 있습니다.</span></div>
              )}
              {visibleMessages.map((item) => renderMessage(item))}
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
          )}

          {/* 패널이 서는 조건과 has-thread·show-thread가 붙는 조건은 하나다(threadRootId). 둘로 나뉘면
              휴대폰에서 목록·채널이 숨겨진 채 패널만 아직 없는 순간이 생겨 빈 서랍에 갇힌다. */}
          {threadRootId && (
            <aside className="messenger-thread" aria-label="스레드">
              {/* 헤더는 늘 보인다(flex: 0 0 auto). 스크롤을 내렸다고 '스레드 닫기'가 사라지면 나갈 길이 없다. */}
              <header className="messenger-thread-header">
                <button type="button" className="messenger-back-button" aria-label="대화로" onClick={() => setMobilePane('chat')}><ArrowLeft size={21} /></button>
                <div>
                  <strong>스레드</strong>
                  {/* 답글이 0이면 수를 적지 않는다. 바로 아래 '아직 답글이 없습니다'가 같은 말을 이미 한다. */}
                  <span>{conversationName(selectedConversation)}{thread && thread.replies.length > 0 ? ` · 답글 ${thread.replies.length}개` : ''}</span>
                </div>
                {!readOnlyRooms && thread && (
                  <div className="messenger-thread-promotions">
                    {/* [채널에 공유]와 같은 조건으로 켜고 끈다 — 서버는 넷 모두를 살아 있는 답글 수로 판정한다
                        (THREAD_EMPTY). 이 수는 SSE마다 서버에서 다시 오므로 화면이 영영 막는 자리가 아니다.
                        올린 뒤에도 단추는 켜져 있다. 서버가 업무·자료의 두 번째를 허용하므로 화면이 막을 자리가
                        아니고(HARD-WON RULE 1), 바뀌는 것은 낱말뿐이다 — 다시 누르면 promoteThread가 한 번 되묻는다. */}
                    {THREAD_PROMOTIONS.map(({ kind, label, doneLabel }) => {
                      const done = (threadPromoted[threadRootId] ?? []).includes(kind)
                      return (
                        <Button
                          key={kind}
                          tone="quiet"
                          size="sm"
                          disabled={!thread || thread.liveReplyCount === 0 || threadPending}
                          onClick={() => void promoteThread(kind)}
                        >
                          {done ? doneLabel : label}
                        </Button>
                      )
                    })}
                  </div>
                )}
                <IconButton tone="quiet" size="sm" aria-label="스레드 닫기" onClick={closeThread}><X size={16} /></IconButton>
              </header>

              {/* 세 단추가 나란히 서 있으면 같은 범위처럼 보인다. 승격 줄이 서는 곳에서만 그 사실을 말한다.
                  남은 답글이 하나도 없으면 그 자리에 다른 문장이 선다 — 지금 할 수 없는 일의 공개 범위를
                  설명하는 것은 안내가 아니라 소음이고, 거절의 이유가 그 자리에 없으면 화면은 '답글 1개'를
                  적어 놓고 말없이 네 단추를 끈다. 두 문장은 같은 자리를 나눠 쓰지 함께 서지 않는다. */}
              {!readOnlyRooms && thread && (
                <p className="messenger-thread-note">
                  {thread.liveReplyCount === 0 && thread.replies.length > 0
                    ? THREAD_ALL_REPLIES_DELETED_NOTICE
                    : THREAD_PROMOTION_SCOPE_NOTICE}
                </p>
              )}

              <div className="messenger-thread-messages" aria-live="polite">
                {thread ? (
                  <>
                    {renderMessage(thread.root, { inThread: true })}
                    {thread.replies.length === 0
                      ? <ThreadEmpty />
                      : <ThreadReplyDivider count={thread.replies.length} />}
                    {thread.replies.map((item) => renderMessage(item, { inThread: true }))}
                  </>
                ) : (
                  <p className="messenger-thread-loading">스레드를 불러오는 중입니다…</p>
                )}
              </div>

              {/* 읽기는 열리는데 쓰기만 거절되는 유일한 갈래다(server/messenger-threads.mjs의 threadRootViolation).
                  컴포저를 켜 둔 채로는 사람이 눈앞에 열린 스레드를 두고 거절 문장을 받는다 — 켜진 컴포저 대신
                  그 자리에 같은 문장을 그린다. 문장은 서버와 한 벌이다(THREAD_ROOT_DELETED_NOTICE). */}
              {thread?.root.deletedAt ? (
                <p className="messenger-thread-note is-blocked">{THREAD_ROOT_DELETED_NOTICE}</p>
              ) : (
              <form className="messenger-composer messenger-thread-composer" onSubmit={(event) => void sendMessage(event, { threadRootId })}>
                {threadReplyTo && (
                  <div className="messenger-reply-strip">
                    <CornerUpLeft size={15} aria-hidden="true" />
                    <span><strong>{threadReplyTo.senderName}</strong>에게 답장 · {threadReplyTo.text.length > 50 ? `${threadReplyTo.text.slice(0, 49)}…` : threadReplyTo.text}</span>
                    <IconButton tone="quiet" size="sm" aria-label="답장 취소" onClick={() => setThreadReplyTo(null)}><X size={15} /></IconButton>
                  </div>
                )}
                <label>
                  <span className="sr-only">스레드에 답글 작성</span>
                  <textarea
                    ref={threadComposerRef}
                    rows={1}
                    value={threadMessage}
                    onChange={(event) => setThreadMessage(event.target.value)}
                    onKeyDown={(event) => {
                      // 한글 조합 중의 Enter는 글자 확정용이다. 막지 않으면 조합 중인 낱말이 그대로 전송된다.
                      if (event.nativeEvent.isComposing) return
                      if (event.key === 'Escape') {
                        // 서랍의 Escape(useOverlayFocus)까지 올라가면 메신저가 통째로 닫힌다.
                        event.stopPropagation()
                        if (threadReplyTo) { setThreadReplyTo(null); return }
                        if (!threadMessage.trim()) closeThread()
                        return
                      }
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault()
                        event.currentTarget.form?.requestSubmit()
                      }
                    }}
                    placeholder="이 스레드에 답글 쓰기"
                  />
                </label>
                {/* 본채널 컴포저와 같은 문장을 쓴다. sendMessage가 !activeConversation에서 조용히 되돌아가므로
                    (딥링크가 방 목록보다 먼저 도착한 순간이 그렇다) 그 사실을 disabled로 적어야 한다. */}
                <button className="send" type="submit" aria-label="답글 보내기" disabled={!activeConversation || !threadMessage.trim() || threadSending}><Send size={20} /></button>
              </form>
              )}

              {!readOnlyRooms && (
                <div className="messenger-thread-share">
                  {/* 서버가 THREAD_EMPTY를 판정하는 것과 같은 수(살아 있는 답글)로 켜고 끈다. */}
                  <Button tone="secondary" size="sm" disabled={!thread || thread.liveReplyCount === 0 || threadPending} onClick={() => setShareOpen(true)}>채널에 공유</Button>
                </div>
              )}
            </aside>
          )}
        </div>
      </div>
      {shareOpen && thread && (
        <ThreadShareDialog
          rootSenderName={thread.root.senderName}
          rootText={thread.root.deletedAt ? '삭제된 메시지' : thread.root.text}
          replyCount={thread.replies.length}
          pending={threadPending}
          onSubmit={(text) => void shareThread(text)}
          onClose={() => { if (!threadPending) setShareOpen(false) }}
        />
      )}
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
      {noticeDialog && noticeDialog.mode !== 'acks' && (
        <NoticeComposerDialog
          mode={noticeDialog.mode}
          notice={noticeDialog.notice}
          channels={noticeChannels}
          roster={noticeRoster}
          currentUserId={currentUserId}
          canCompany={canManage}
          lockedConversationId={noticeDialog.conversationId}
          pending={noticePending}
          workspaceScope={workspaceScope}
          onSubmit={(draft) => void saveNotice(draft)}
          onToast={onToast}
          onClose={() => { if (!noticePending) setNoticeDialog(null) }}
        />
      )}
      {noticeDialog && noticeDialog.mode === 'acks' && (
        <NoticeAckDialog
          notice={noticeDialog.notice}
          list={noticeAcks}
          state={noticeAcksState}
          pending={noticePending}
          onRemind={() => void remindNotice(noticeDialog.notice)}
          onClose={() => setNoticeDialog(null)}
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

/** 일요일 시작 42칸. utils/dateTime.ts의 monthGridKeys와 같은 규칙이다 — 한쪽을 고치면 다른 쪽도 같이 고친다. */
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

export function SchedulePage({ onToast, currentUserId, currentUserName, currentUserTeam, canManage, workspaceScope, calendarCallbackFlag = '', onCalendarCallbackHandled }: PageProps & { calendarCallbackFlag?: string; onCalendarCallbackHandled?: () => void }) {
  // R16-E: 동기화가 끝나면 서버가 일정 배열을 통째로 갈아 끼운다. 화면이 그 사실을 모르면
  // 다음 저장이 409로 튕겨 사용자가 방금 쓴 내용이 사라진다 — 그래서 다시 읽는다.
  const [calendarReload, setCalendarReload] = useState(0)
  // 내가 누른 동기화만이 아니라 스케줄러·다른 기기가 갈아 끼운 경우에도 같은 토큰을 올린다.
  // 이 구독이 없으면 서버가 보내는 'calendar' 프레임은 아무도 받지 않는 죽은 배선이 된다.
  useEventStream(true, (event) => {
    if (event.kind === 'calendar' || event.kind === 'resync') setCalendarReload((current) => current + 1)
  })
  const [externalEventIds, setExternalEventIds] = useState<string[]>([])
  const externalIdSet = useMemo(() => new Set(externalEventIds), [externalEventIds])
  const [events, setEvents] = useWorkspaceState<CalendarEvent[]>('calendar-events', [], { scope: workspaceScope, seedWhenEmpty: false, reloadToken: calendarReload })
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

      <CalendarConnectionCard
        workspaceScope={workspaceScope}
        canManage={canManage}
        justConnected={calendarCallbackFlag === 'connected'}
        onToast={onToast}
        onExternalIds={setExternalEventIds}
        onSynced={() => setCalendarReload((current) => current + 1)}
        onCallbackHandled={onCalendarCallbackHandled}
        // 일정 배열을 다시 읽게 만든 그 신호로 연결 카드도 다시 읽는다 — 스케줄러가 돌린 통과 뒤에도
        // 새 일정에 연결 표식이 붙고 마지막 동기화 시각이 따라간다.
        reloadToken={calendarReload}
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
                      <button className={'calendar-event ' + (event.source === 'leave' ? 'leave' : event.scope) + (externalIdSet.has(event.id) ? ' external' : '')} type="button" onClick={() => openEdit(event)} key={event.id}>
                        <span>{event.source === 'leave' ? '휴가' : event.start}</span> {event.title}
                        {externalIdSet.has(event.id) && <span className="sr-only"> (구글 캘린더와 연결된 일정)</span>}
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
              <button className={'schedule-agenda-item ' + (event.source === 'leave' ? 'leave' : event.scope) + (externalIdSet.has(event.id) ? ' external' : '')} type="button" onClick={() => openEdit(event)} key={event.id} title={externalIdSet.has(event.id) ? '구글 캘린더와 연결된 일정' : undefined}>
                <span className="schedule-agenda-time">{event.source === 'leave' ? '휴가' : event.start}<i />{event.source === 'leave' ? '종일' : event.end}</span>
                <span className="schedule-agenda-copy">
                  <strong>{event.title}{externalIdSet.has(event.id) && <span className="sr-only"> (구글 캘린더와 연결된 일정)</span>}</strong>
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
          eventId={editingId}
          workspaceScope={workspaceScope}
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
  eventId,
  workspaceScope,
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
  eventId: string | null
  workspaceScope?: string
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
  // R16-E: 덮어쓴 내역은 편집 모드에서만, 다이얼로그가 열릴 때만 읽는다.
  // 목록 응답에 실으면 GET /api/workspace/calendar-events의 payload와 version 계산이 바뀐다.
  const [overwrites, setOverwrites] = useState<OverwriteHistory | null>(null)
  useEffect(() => {
    if (!editing || !eventId) { setOverwrites(null); return }
    let active = true
    fetch(`/api/calendar/events/${encodeURIComponent(eventId)}/overwrites`, {
      headers: workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined,
    })
      .then(async (response) => (response.ok ? response.json() as Promise<OverwriteHistory> : null))
      .then((body) => { if (active) setOverwrites(body) })
      // 연결되지 않은 일정은 404다 — 정상이고, 아무것도 그리지 않는다.
      .catch(() => { if (active) setOverwrites(null) })
    return () => { active = false }
  }, [editing, eventId, workspaceScope])
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
          {/* 손실 안내 다섯 갈래. **전부 같은 한 마디로 끝난다** — 삭제 버튼이 이 문장 바로 아래에 있고,
              서버는 이 링크들에 대해 수정도 삭제도 구글로 내보내지 않는다. '고친 내용'만 적으면
              사람은 하루짜리로 보이는 줄을 지우고 구글의 사흘짜리 원본이 남는 것을 예상하지 못한다. */}
          {overwrites?.truncated === 'multi-day' && (
            <p className="schedule-sync-note" role="status">여러 날에 걸친 구글 일정입니다. {BRAND.name}에서는 첫날만 보이고, 여기서 고치거나 지운 내용은 구글로 보내지 않습니다.</p>
          )}
          {overwrites?.readOnly && (
            <p className="schedule-sync-note" role="status">구글의 반복 일정입니다. 여기서 고치거나 지운 내용은 구글로 보내지 않습니다. 반복 규칙은 구글에서 수정해 주세요.</p>
          )}
          {overwrites?.sourceBlocked === 'read-only' && (
            <p className="schedule-sync-note" role="status">읽기 전용 구글 캘린더에서 가져온 일정입니다. 여기서 고치거나 지운 내용은 구글로 보내지 않습니다.</p>
          )}
          {overwrites?.sourceBlocked === 'unselected' && (
            <p className="schedule-sync-note" role="status">동기화 대상에서 뺀 구글 캘린더의 일정입니다. 여기서 고치거나 지운 내용은 구글로 보내지 않습니다.</p>
          )}
          {overwrites?.sourceBlocked === 'unknown' && (
            <p className="schedule-sync-note" role="status">구글 계정에서 사라진 캘린더의 일정입니다. 여기서 고치거나 지운 내용은 구글로 보내지 않습니다.</p>
          )}
          <OverwriteHistoryDetails
            history={overwrites}
            current={{ title: draft.title, date: draft.date, start: draft.start, end: draft.end, location: draft.location, note: draft.note }}
          />
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
  /** 마지막으로 저장된 시각. 자동 저장이 조용하기만 하면 사용자가 창을 닫지 못한다. */
  const [lastSavedAt, setLastSavedAt] = useState('')
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
      setLastSavedAt(formatListDateTime(saved.updatedAt))
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
                <span className="journal-save-line">
                  <SaveState status={journalSaving ? 'saving' : journalDirty ? 'dirty' : lastSavedAt ? 'saved' : 'idle'} savedAt={lastSavedAt} />
                  <small>{autoSaveMessage}</small>
                </span>
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

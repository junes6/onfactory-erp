import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { Check, ChevronDown, Download, ListChecks, Megaphone, Paperclip, Search, X } from 'lucide-react'

import { Button, IconButton } from './ui/Button'
import { formatListDateTime } from '../utils/dateTime'
import { downloadDocumentAttachment, uploadDocumentAttachments, type StoredDocumentAttachment } from '../utils/documentAttachments'
import type { NoticeListState } from '../utils/noticeFocus'
import './NoticeCenter.css'

/**
 * 공지 — 채널 맨 위에 붙는 긴 글과, 필독일 때의 확인 기록.
 *
 * 말풍선 고정('고정')과는 다른 기능이다. 고정은 "이 방에서 늘 보이게 두는 일"이고,
 * 공지는 제목·본문·첨부를 가진 글이며 대상자마다 확인 여부가 남는다.
 *
 * 스트립(채널 상단)과 보드(공지 목록)가 같은 NoticeCard 한 벌을 쓴다. 두 벌이면
 * '확인했습니다'가 한쪽에서만 사라지는 표류가 생긴다.
 */

export type NoticeAttachment = StoredDocumentAttachment
export type NoticeAcknowledgement = { accountId: string; at: string }

export type Notice = {
  id: string
  scope: 'company' | 'project'
  conversationId: string | null
  projectId: string | null
  title: string
  body: string
  /** 열 수 있는 첨부만 실려 온다. 대상자가 아니면 빈 배열이고 개수만 attachmentCount로 온다. */
  attachments: NoticeAttachment[]
  attachmentCount: number
  authorId: string
  authorName: string
  mustRead: boolean
  archivedAt: string | null
  createdAt: string
  updatedAt: string
  acknowledgedAt: string | null
  canAck: boolean
  canManage: boolean
  /** 관리 권한이 있을 때만 실린다 — 아니면 다른 사람의 미확인 사실이 전 직원에게 샌다.
   *  인원수도 마찬가지다: 이름이 없어도 '아직 N명이 안 눌렀다'는 남의 근태를 짐작하게 한다. */
  targetCount?: number
  confirmedCount?: number
  targetIds?: string[]
  acknowledgements?: NoticeAcknowledgement[]
  lastRemindAt?: string | null
}

export type NoticeRoster = { id: string; name: string; team?: string; kind?: 'employee' | 'guest' }
export type NoticeChannel = { id: string; name: string; participantIds?: string[] }
export type NoticeAckList = { confirmed: { accountId: string; name: string; at: string }[]; unconfirmed: { accountId: string; name: string }[] }

/** 화면이 쓰는 유일한 공지 상한. 서버(notices.mjs)의 같은 이름과 숫자가 맞는지는 계약 테스트가 본다.
 *  제목 상한은 화면에 소비자가 없어 두 번째 사본을 두지 않는다 — 판정은 서버 한 곳(NOTICE_TITLE_INVALID)에서만 한다. */
export const MAX_NOTICE_BODY = 20_000
/** 사람을 못 찾았을 때. 서버(notices.mjs의 UNKNOWN_ACTOR_NAME)와 같은 낱말을 쓴다 — id를 그대로 노출하지 않는다. */
export const UNKNOWN_PERSON_NAME = '퇴사한 계정'

// ---------------------------------------------------------------------------
// 딥링크 — focusId 문자열 하나에 종류를 싣는다
// ---------------------------------------------------------------------------

export type MessengerFocus = {
  conversationId: string | null
  noticeId?: string
  threadRootId?: string
  messageId?: string
  at: number
}

/** 알림·전역 검색·웹푸시가 공유하는 focusId 규약: '<conversationId|company>:<notice|thread|message>:<id>'.
 *  buildNotification이 focusId를 120자로 자르므로 NTC-<base36>-<hex6>도 여유 있게 들어간다.
 *  이 한 벌 덕분에 onNavigate 시그니처도 pushPayload도 sw.js도 손대지 않는다. */
export function parseMessengerFocus(focusId: string): MessengerFocus | null {
  const parts = String(focusId ?? '').split(':')
  if (parts.length !== 3) return null
  const [room, kind, id] = parts
  if (!id) return null
  const conversationId = room === 'company' ? null : room || null
  if (kind === 'notice') return { conversationId, noticeId: id, at: Date.now() }
  if (kind === 'thread') return { conversationId, threadRootId: id, at: Date.now() }
  if (kind === 'message') return { conversationId, messageId: id, at: Date.now() }
  return null
}

// ---------------------------------------------------------------------------
// 데이터
// ---------------------------------------------------------------------------


const workspaceHeaders = (workspaceScope?: string) => (workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined)

/**
 * 공지 목록을 읽는다. 검색어는 서버로 보낸다 — 권한 판정을 하는 쪽에서 찾아야
 * 목록과 검색이 어긋나지 않는다. 2자 미만이면 붙이지 않는다(타이핑 중에 목록이 깜빡이면 안 된다).
 *
 * 방·범위도 서버로 보낸다. 서버는 정렬한 뒤 200건에서 자르므로, 화면에서 다시 거르면
 * 공지가 200건을 넘긴 순간 채널 스트립의 공지가 조용히 사라진다(테넌트 상한은 2,000건이다).
 */
export function useNotices(
  open: boolean,
  workspaceScope?: string,
  options: { query?: string; archived?: boolean; refreshToken?: number; conversationId?: string; scope?: 'company' | 'project' } = {},
) {
  const { query = '', archived = false, refreshToken = 0, conversationId = '', scope } = options
  /**
   * 목록과 '그 목록이 어떤 파라미터로 받아온 것인가'를 한 상태로 함께 든다.
   *
   * 왜 필요한가: 보드의 탭은 클라이언트 필터가 아니라 서버 파라미터다(200건 상한 때문에). 손에 든
   * 행을 그대로 둔 채 새 요청을 보내면 한 왕복 동안 '보관함' 아래에 보관되지 않은 공지가, 채널 탭
   * 아래에 회사 공지가 그 탭의 것인 양 앉는다. 파라미터가 다른 행은 이 탭의 답이 아니다.
   *
   * load 첫 줄에서 setState('loading')을 하는 방법은 쓰지 않는다 — SSE 재적재(refreshToken)마다
   * 보드가 '공지를 불러오는 중입니다'로 깜빡이고, 딥링크 판정(canJudgeMissingNotice)이 보는 state도
   * 함께 흔들린다. 그래서 같은 파라미터의 다시 읽기는 손에 든 행을 그대로 둔다.
   */
  const [result, setResult] = useState<{ key: string; rows: Notice[]; state: NoticeListState; loadedAt: number }>(
    { key: '', rows: [], state: 'loading', loadedAt: 0 },
  )
  const [debounced, setDebounced] = useState(query)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query), 250)
    return () => window.clearTimeout(timer)
  }, [query])

  /** 이 요청을 무엇으로 물었는가. refreshToken은 들어가지 않는다 — 같은 질문을 다시 묻는 것뿐이다. */
  const key = useMemo(
    () => JSON.stringify([debounced.trim().length >= 2 ? debounced.trim() : '', archived, conversationId, scope ?? '']),
    [debounced, archived, conversationId, scope],
  )

  const load = useCallback(async (signal?: AbortSignal) => {
    const params = new URLSearchParams()
    if (debounced.trim().length >= 2) params.set('q', debounced.trim())
    if (archived) params.set('archived', '1')
    if (conversationId) params.set('conversationId', conversationId)
    if (scope) params.set('scope', scope)
    try {
      const response = await fetch(`/api/notices${params.toString() ? `?${params}` : ''}`, { headers: workspaceHeaders(workspaceScope), signal })
      if (!response.ok) throw new Error('notice-load')
      const body = await response.json() as { notices?: Notice[] }
      if (signal?.aborted) return
      setResult({ key, rows: Array.isArray(body.notices) ? body.notices : [], state: 'ready', loadedAt: Date.now() })
    } catch (reason) {
      if ((reason as { name?: string })?.name === 'AbortError') return
      // 못 받았어도 '무엇을 묻다 실패했는지'는 적어 둔다. 안 그러면 새 탭이 영원히 '불러오는 중'에 머문다.
      // 같은 질문의 재시도가 실패한 경우에만 손에 든 행을 남긴다(다른 질문의 행은 이 탭의 답이 아니다).
      setResult((current) => ({ key, rows: current.key === key ? current.rows : [], state: 'error', loadedAt: 0 }))
    }
  }, [workspaceScope, debounced, archived, conversationId, scope, key])

  useEffect(() => {
    if (!open) return undefined
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [open, load, refreshToken])

  const reload = useCallback(() => { void load() }, [load])
  /**
   * 지금 물어본 것과 다른 파라미터로 받아온 행은 내보내지 않는다.
   *
   * loadedAt은 '이 목록이 언제 도착했는가'(0이면 아직 한 번도 못 받았다)다. state만으로는
   * "지금 열린 화면에 맞는 목록인가"를 답할 수 없다 — 서랍은 닫혀도 마운트된 채 남으므로
   * (MessengerDrawer의 `if (!open) return null`이 훅 뒤에 있다) 지난 목록이 'ready'로 살아 있고,
   * 닫힌 사이에 올라온 공지의 딥링크가 그 목록을 보고 "그런 공지 없다"고 판정한다. 딥링크에는 클릭
   * 시각(focus.at)이 실려 오므로, 그보다 나중에 도착한 목록만 그 판정을 할 수 있다(canJudgeMissingNotice).
   * 파라미터가 바뀐 사이에도 같은 이유로 0을 내보낸다 — 아직 이 질문의 답은 도착하지 않았다.
   */
  const answered = result.key === key
  const notices = answered ? result.rows : []
  const state: NoticeListState = answered ? result.state : 'loading'
  const loadedAt = answered ? result.loadedAt : 0
  return { notices, state, loadedAt, reload }
}

// ---------------------------------------------------------------------------
// 카드 — 스트립과 보드가 같은 것을 쓴다
// ---------------------------------------------------------------------------

export function NoticeCard({
  notice,
  expanded,
  busy,
  readOnly = false,
  workspaceScope,
  onToggle,
  onAck,
  onOpenAcks,
  onRemind,
  onEdit,
  onArchive,
  onToast,
  cardRef,
}: {
  notice: Notice
  expanded: boolean
  busy: boolean
  readOnly?: boolean
  workspaceScope?: string
  onToggle: () => void
  onAck: () => void
  onOpenAcks: () => void
  onRemind: () => void
  onEdit: () => void
  onArchive: (archived: boolean) => void
  onToast: (message: string) => void
  cardRef?: (node: HTMLElement | null) => void
}) {
  const bodyId = `notice-body-${notice.id}`
  return (
    <article
      id={`notice-${notice.id}`}
      ref={cardRef}
      className={'messenger-notice' + (notice.mustRead ? ' is-must-read' : '')}
    >
      <div className="messenger-notice-row">
        <button
          type="button"
          className="messenger-notice-open"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <Megaphone size={15} aria-hidden="true" />
          <strong>{notice.title}</strong>
          {notice.mustRead && (
            <span className={'messenger-notice-badge' + (notice.acknowledgedAt ? ' is-done' : '')}>
              {notice.acknowledgedAt ? '확인함' : '필독'}
            </span>
          )}
          <time dateTime={notice.createdAt}>{formatListDateTime(notice.createdAt)}</time>
        </button>
        {notice.canAck && (
          <Button tone="secondary" size="sm" disabled={busy} onClick={onAck}>확인했습니다</Button>
        )}
        {notice.mustRead && !notice.canAck && notice.acknowledgedAt && (
          <span className="messenger-notice-acked">확인함 · {formatListDateTime(notice.acknowledgedAt)}</span>
        )}
      </div>

      <div className="messenger-notice-body" id={bodyId} hidden={!expanded}>
        {/* 본문은 텍스트 노드로만 그린다. 줄바꿈은 CSS white-space: pre-wrap이 살린다. */}
        <p>{notice.body}</p>
        {/* 서버가 열 수 있는 첨부만 실어 준다. 못 여는 사람에게 버튼을 그리면 눌러도 404가 난다. */}
        {notice.attachments.length === 0 && notice.attachmentCount > 0 && (
          <p className="messenger-notice-restricted">첨부 {notice.attachmentCount}개 · 확인 대상자만 열 수 있습니다</p>
        )}
        {notice.attachments.length > 0 && (
          <ul className="messenger-notice-attachments" aria-label="공지 첨부파일">
            {notice.attachments.map((attachment) => (
              <li key={attachment.id}>
                <button
                  type="button"
                  onClick={() => void downloadDocumentAttachment(attachment, workspaceScope)
                    .catch((reason) => onToast(reason instanceof Error ? reason.message : '첨부파일을 내려받지 못했습니다.'))}
                >
                  <Download size={14} aria-hidden="true" />
                  <span><strong>{attachment.name}</strong><small>{attachment.size}</small></span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="messenger-notice-meta">
          <span>{notice.authorName}</span>
          {notice.mustRead && notice.canManage && (
            <span>{(notice.targetCount ?? 0) > 0 ? `확인 ${notice.confirmedCount ?? 0}/${notice.targetCount}명` : '대상이 없습니다'}</span>
          )}
          {notice.lastRemindAt && <span>마지막 재알림 {formatListDateTime(notice.lastRemindAt)}</span>}
          {notice.archivedAt && <span>보관됨</span>}
        </div>
        {notice.canManage && !readOnly && (
          <div className="messenger-notice-actions">
            {/* 보관한 공지에는 두 버튼을 그리지 않는다 — 서버가 409 NOTICE_ARCHIVED로 거절하는 자리다.
                (보관함 탭에서도 카드는 그대로 그려지므로 mustRead만 보면 눌리는 버튼이 남는다.) */}
            {notice.mustRead && !notice.archivedAt && <Button tone="quiet" size="sm" onClick={onOpenAcks}><ListChecks size={14} /> 확인 명단</Button>}
            {notice.mustRead && !notice.archivedAt && <Button tone="quiet" size="sm" disabled={busy} onClick={onRemind}>다시 알림</Button>}
            <Button tone="quiet" size="sm" onClick={onEdit}>수정</Button>
            <Button tone="quiet" size="sm" disabled={busy} onClick={() => onArchive(!notice.archivedAt)}>
              {notice.archivedAt ? '보관 해제' : '보관'}
            </Button>
          </div>
        )}
      </div>
    </article>
  )
}

type CardHandlers = Omit<Parameters<typeof NoticeCard>[0], 'notice' | 'expanded' | 'busy' | 'onToggle' | 'cardRef'>

/** 채널 상단 스트립. 이 방의 공지만, 접힌 채로 얹힌다. */
export function NoticeStrip({
  notices,
  openId,
  busyId,
  onOpenChange,
  handlers,
  cardRef,
}: {
  notices: Notice[]
  openId: string | null
  busyId: string
  onOpenChange: (id: string | null) => void
  handlers: (notice: Notice) => CardHandlers
  cardRef: (id: string) => (node: HTMLElement | null) => void
}) {
  if (notices.length === 0) return null
  return (
    <div
      className="messenger-notices"
      aria-label="이 채널의 공지"
      onKeyDown={(event) => {
        // 자기 자리에서 멈춘다. 여기서 올려 보내면 Escape 한 번에 메신저가 통째로 닫힌다.
        if (event.key !== 'Escape' || !openId) return
        event.stopPropagation()
        onOpenChange(null)
      }}
    >
      {notices.map((notice) => (
        <NoticeCard
          key={notice.id}
          notice={notice}
          expanded={openId === notice.id}
          busy={busyId === notice.id}
          onToggle={() => onOpenChange(openId === notice.id ? null : notice.id)}
          cardRef={cardRef(notice.id)}
          {...handlers(notice)}
        />
      ))}
    </div>
  )
}

/** 공지 목록 화면. 채팅 자리를 대신한다. */
export function NoticeBoard({
  workspaceScope,
  channels,
  canCompose,
  openId,
  busyId,
  refreshToken,
  onOpenChange,
  onBack,
  onBackToList,
  onCompose,
  handlers,
  cardRef,
}: {
  workspaceScope?: string
  channels: NoticeChannel[]
  canCompose: boolean
  openId: string | null
  busyId: string
  refreshToken: number
  onOpenChange: (id: string | null) => void
  onBack: () => void
  onBackToList: () => void
  onCompose: () => void
  handlers: (notice: Notice) => CardHandlers
  cardRef: (id: string) => (node: HTMLElement | null) => void
}) {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<'all' | 'company' | 'archived' | string>('all')
  const searchRef = useRef<HTMLInputElement>(null)
  // 범위는 서버 파라미터로 좁힌다 — 200건에서 잘린 목록을 화면에서 다시 거르면 채널 탭이 비어 보인다.
  const { notices: shown, state } = useNotices(true, workspaceScope, {
    query,
    archived: scope === 'archived',
    refreshToken,
    ...(scope === 'company' ? { scope: 'company' as const } : {}),
    ...(scope === 'all' || scope === 'company' || scope === 'archived' ? {} : { conversationId: scope }),
  })

  useEffect(() => { searchRef.current?.focus() }, [])

  return (
    <section className="messenger-notice-board" aria-label="공지 목록">
      <header className="messenger-chat-header">
        {/* 휴대폰 폭에서만 보인다. 이름 그대로 대화 목록으로 간다 — 오른쪽 X는 보던 대화로 간다. */}
        <button className="messenger-back-button" type="button" aria-label="대화 목록으로" onClick={onBackToList}>
          <ChevronDown size={21} />
        </button>
        <span className="messenger-team-icon"><Megaphone size={20} /></span>
        <div><strong>공지</strong><span>회사 전체와 프로젝트 채널의 공지를 한곳에서 봅니다</span></div>
        <div className="messenger-room-actions">
          {canCompose && <Button tone="secondary" size="sm" onClick={onCompose}>공지 쓰기</Button>}
          <IconButton tone="quiet" aria-label="대화로" onClick={onBack}><X size={19} /></IconButton>
        </div>
      </header>

      <div className="messenger-notice-filters">
        <label className="collab-search">
          <Search size={16} aria-hidden="true" />
          <span className="sr-only">공지 검색</span>
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder="공지 검색 (2자 이상)"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div role="group" aria-label="공지 범위">
          <button type="button" aria-pressed={scope === 'all'} className={scope === 'all' ? 'is-active' : undefined} onClick={() => setScope('all')}>전체</button>
          <button type="button" aria-pressed={scope === 'company'} className={scope === 'company' ? 'is-active' : undefined} onClick={() => setScope('company')}>회사</button>
          {channels.map((channel) => (
            <button key={channel.id} type="button" aria-pressed={scope === channel.id} className={scope === channel.id ? 'is-active' : undefined} onClick={() => setScope(channel.id)}>{channel.name}</button>
          ))}
          {/* 보관함이 있어야 보관한 공지를 되살릴 길이 화면에 남는다. */}
          <button type="button" aria-pressed={scope === 'archived'} className={scope === 'archived' ? 'is-active' : undefined} onClick={() => setScope('archived')}>보관함</button>
        </div>
      </div>

      <div className="messenger-notice-list">
        {state === 'loading' && <p className="messenger-notice-empty">공지를 불러오는 중입니다.</p>}
        {state === 'error' && <p className="messenger-notice-empty">공지를 불러오지 못했습니다. 잠시 뒤 다시 열어 주세요.</p>}
        {state === 'ready' && shown.length === 0 && (
          <p className="messenger-notice-empty">{query.trim().length >= 2 ? '다른 낱말로 찾아보세요.' : '아직 공지가 없습니다'}</p>
        )}
        {shown.map((notice) => (
          <NoticeCard
            key={notice.id}
            notice={notice}
            expanded={openId === notice.id}
            busy={busyId === notice.id}
            onToggle={() => onOpenChange(openId === notice.id ? null : notice.id)}
            cardRef={cardRef(notice.id)}
            {...handlers(notice)}
          />
        ))}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// 대화상자 두 개
// ---------------------------------------------------------------------------

/** 중첩 대화상자의 Escape는 capture 단계에서 잡고 더 올라가지 않게 한다.
 *  그러지 않으면 Escape 한 번에 대화상자와 메신저 서랍이 함께 닫힌다. */
function useDialogEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key !== 'Escape') return; event.stopImmediatePropagation(); onClose() }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])
}

export type NoticeDraft = {
  conversationId: string | null
  title: string
  body: string
  attachments: NoticeAttachment[]
  mustRead: boolean
  targetIds?: string[]
}

export function NoticeComposerDialog({
  mode,
  notice,
  channels,
  roster,
  currentUserId,
  canCompany,
  lockedConversationId,
  pending,
  workspaceScope,
  onSubmit,
  onToast,
  onClose,
}: {
  mode: 'create' | 'edit'
  notice?: Notice
  channels: NoticeChannel[]
  roster: NoticeRoster[]
  /** 작성자 본인. 서버가 기본 대상에서 빼는 사람이라 화면도 같은 사람을 뺀다. */
  currentUserId: string
  canCompany: boolean
  lockedConversationId?: string | null
  pending: boolean
  workspaceScope?: string
  onSubmit: (draft: NoticeDraft) => void
  onToast: (message: string) => void
  onClose: () => void
}) {
  useDialogEscape(onClose)
  const [target, setTarget] = useState<string>(() => {
    if (notice) return notice.conversationId ?? 'company'
    if (lockedConversationId) return lockedConversationId
    return canCompany ? 'company' : channels[0]?.id ?? 'company'
  })
  const [title, setTitle] = useState(notice?.title ?? '')
  const [body, setBody] = useState(notice?.body ?? '')
  const [mustRead, setMustRead] = useState(notice?.mustRead ?? false)
  const [attachments, setAttachments] = useState<NoticeAttachment[]>(notice?.attachments ?? [])
  const [uploading, setUploading] = useState(false)
  const [excluded, setExcluded] = useState<string[]>([])
  const fileRef = useRef<HTMLInputElement>(null)
  const locked = mode === 'edit' || Boolean(lockedConversationId)

  const conversationId = target === 'company' ? null : target
  const channel = channels.find((item) => item.id === target)
  const audience = useMemo(() => {
    // 수정 모드의 대상은 저장된 targetIds다 — 거기엔 작성자가 이미 빠져 있다.
    // 이름을 못 찾아도 id를 그대로 노출하지 않는다(서버가 쓰는 낱말과 같은 것을 쓴다).
    if (mode === 'edit') return (notice?.targetIds ?? []).map((id) => roster.find((person) => person.id === id) ?? { id, name: UNKNOWN_PERSON_NAME })
    // 작성자 본인은 뺀다. 서버도 audience에서 작성자를 빼므로(notices.mjs), 여기에 남겨 두면
    // 한 명만 체크 해제해도 "기본 대상자 밖"이 되어 올리기가 400으로 되돌아온다.
    const others = roster.filter((person) => person.id !== currentUserId)
    // 회사 전체 공지는 내부 구성원만 받는다 — 서버의 roster 판정과 같은 구분이다.
    if (target === 'company') return others.filter((person) => person.kind !== 'guest')
    const participants = new Set(channel?.participantIds ?? [])
    return others.filter((person) => participants.has(person.id))
  }, [mode, notice, target, channel, roster, currentUserId])

  const chooseFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (!files.length || uploading) return
    setUploading(true)
    try {
      const additions = await uploadDocumentAttachments(files, {
        workspaceScope,
        category: '사내공지',
        summary: `${title || '공지'} 첨부`,
        tags: ['notice', conversationId ? `conversation:${conversationId}` : 'company'],
      })
      setAttachments((current) => [...current, ...additions])
    } catch (reason) {
      onToast(reason instanceof Error ? reason.message : '첨부파일을 업로드하지 못했습니다.')
    } finally {
      setUploading(false)
    }
  }

  const overLimit = body.length > MAX_NOTICE_BODY
  const canSubmit = !pending && !uploading && Boolean(title.trim()) && Boolean(body.trim()) && !overLimit

  const submit = () => {
    if (!canSubmit) return
    const picked = audience.filter((person) => !excluded.includes(person.id)).map((person) => person.id)
    onSubmit({
      conversationId,
      title: title.trim(),
      body,
      attachments,
      mustRead,
      // 좁히지 않았으면 목록 자체를 보내지 않는다 — 서버가 자기 기준으로 대상자를 정하게 두어야
      // 화면이 아는 명단과 서버가 아는 명단이 어긋나도 400이 나지 않는다.
      ...(excluded.length ? { targetIds: picked } : {}),
    })
  }

  return (
    <div className="messenger-dialog-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="messenger-dialog" role="dialog" aria-modal="true" aria-label={mode === 'create' ? '공지 올리기' : '공지 수정'}>
        <header>
          <span className="messenger-team-icon"><Megaphone size={18} /></span>
          <strong>{mode === 'create' ? '공지 올리기' : '공지 수정'}</strong>
          <IconButton tone="quiet" size="sm" aria-label="닫기" onClick={onClose}><X size={18} /></IconButton>
        </header>

        <div className="messenger-dialog-body">
          <label className="messenger-field">
            <span>올릴 곳</span>
            <select value={target} disabled={locked} onChange={(event) => { setTarget(event.target.value); setExcluded([]) }}>
              {canCompany && <option value="company">회사 전체</option>}
              {channels.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>

          <label className="messenger-field">
            <span>제목</span>
            {/* maxLength로 자르면 한글 조합이 끊긴다. 길이는 제출할 때 검사한다. */}
            <input value={title} placeholder="예: 9월 정기 안전교육 안내" onChange={(event) => setTitle(event.target.value)} />
          </label>

          <label className="messenger-field">
            <span>본문</span>
            <textarea
              rows={10}
              value={body}
              placeholder="공지 내용을 적어 주세요. 줄바꿈은 그대로 보입니다."
              onChange={(event) => setBody(event.target.value)}
              onKeyDown={(event) => {
                // 한글 조합 중의 Enter는 글자 확정용이다. 본문의 Enter는 언제나 줄바꿈이고 제출이 아니다.
                if (event.nativeEvent.isComposing) return
                // 긴 글에서 바닥의 버튼까지 내려가지 않아도 되게 한다.
                // Escape는 useDialogEscape가 capture 단계에서 먼저 받는다 — 여기서 또 받으면 죽은 가지가 된다.
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); submit() }
              }}
            />
            {/* 상한 초과는 숫자로만 알린다. 서버 문구를 여기서 다시 짓지 않는다 — 같은 사실은 한 번만 말한다. */}
            <small className={'messenger-notice-count' + (overLimit ? ' is-over' : '')}>{body.length.toLocaleString('ko-KR')} / {MAX_NOTICE_BODY.toLocaleString('ko-KR')}자</small>
          </label>

          <div className="messenger-field">
            <span>첨부</span>
            <input ref={fileRef} className="sr-only" type="file" multiple onChange={(event) => void chooseFiles(event)} />
            <Button tone="ghost" size="sm" disabled={uploading} onClick={() => fileRef.current?.click()}>
              <Paperclip size={15} /> {uploading ? '올리는 중' : '파일 고르기'}
            </Button>
            {attachments.length > 0 && (
              <ul className="messenger-notice-attachments">
                {attachments.map((attachment) => (
                  <li key={attachment.id}>
                    <span><strong>{attachment.name}</strong><small>{attachment.size}</small></span>
                    <IconButton tone="quiet" size="sm" aria-label={`${attachment.name} 첨부 빼기`} onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}><X size={14} /></IconButton>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <label className="messenger-notice-mustread">
            {/* 필독을 끄면 아래 목록이 사라진다. 그때 excluded를 그대로 두면 화면이 더는 보여 주지 않는
                좁힘을 그대로 보내게 되고, 첨부는 그 명단만 열 수 있게 된다 — 작성자는 그 사실을 볼 길이 없다. */}
            <input type="checkbox" checked={mustRead} onChange={(event) => { setMustRead(event.target.checked); if (!event.target.checked) setExcluded([]) }} />
            <span>필독 — 대상자가 [확인했습니다]를 눌러야 합니다</span>
          </label>

          {mustRead && (
            <details className="messenger-notice-targets" open>
              <summary>확인 대상 {audience.length - excluded.length}명 / {audience.length}명</summary>
              {/* 아직 받을 사람이 없는 회사(첫날의 워크스페이스)도 공지를 올릴 수 있다 — 서버가 201로 답한다.
                  그때 '아래 사람에게만 갑니다'라고 빈 목록을 가리키면 없는 명단을 가리키는 문장이 된다.
                  카드가 쓰는 낱말('대상이 없습니다')을 그대로 이어 쓴다. */}
              {audience.length === 0 ? (
                <p className="messenger-notice-targets-note">확인 대상이 없습니다. 지금 올리면 확인 기록 없이 게시됩니다.</p>
              ) : (
                <>
                  {/* 낱말을 실제와 맞춘다: 이 목록은 '볼 수 있는 사람'이 아니라 '확인 기록을 남길 사람'이다.
                      공지 자체는 회사 전원(프로젝트 공지는 프로젝트 참여자)이 본다. */}
                  <p className="messenger-notice-targets-note">
                    {target === 'company' ? '공지 자체는 회사 전원이 봅니다.' : '공지 자체는 프로젝트 참여자가 봅니다.'} 확인 기록과 첨부 열람은 아래 사람에게만 갑니다.
                  </p>
                  {/* 넓히는 UI는 두지 않는다 — 서버가 기본 대상자 밖을 400으로 거절한다. */}
                  <ul>
                    {audience.map((person) => {
                      const on = !excluded.includes(person.id)
                      return (
                        <li key={person.id}>
                          <button type="button" role="checkbox" aria-checked={on} onClick={() => setExcluded((current) => (on ? [...current, person.id] : current.filter((id) => id !== person.id)))}>
                            <span className={'messenger-check' + (on ? ' on' : '')} aria-hidden="true">{on && <Check size={13} />}</span>
                            <span><strong>{person.name}</strong><small>{person.team ?? ''}</small></span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </>
              )}
            </details>
          )}
        </div>

        <footer>
          <Button tone="quiet" onClick={onClose}>닫기</Button>
          <Button tone="primary" disabled={!canSubmit} onClick={submit}>
            {mode === 'create' ? '올리기' : '저장'}
          </Button>
        </footer>
      </div>
    </div>
  )
}

export function NoticeAckDialog({
  notice,
  list,
  state,
  pending,
  onRemind,
  onClose,
}: {
  notice: Notice
  list: NoticeAckList
  state: 'loading' | 'ready' | 'error'
  pending: boolean
  onRemind: () => void
  onClose: () => void
}) {
  useDialogEscape(onClose)
  return (
    <div className="messenger-dialog-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="messenger-dialog" role="dialog" aria-modal="true" aria-label="확인 명단">
        <header>
          <span className="messenger-team-icon"><ListChecks size={18} /></span>
          <strong>확인 명단 · {notice.title}</strong>
          <IconButton tone="quiet" size="sm" aria-label="닫기" onClick={onClose}><X size={18} /></IconButton>
        </header>

        <div className="messenger-dialog-body">
          {state === 'loading' && <p className="messenger-notice-empty">명단을 불러오는 중입니다.</p>}
          {state === 'error' && <p className="messenger-notice-empty">명단을 불러오지 못했습니다.</p>}
          {state === 'ready' && (
            <>
              <section className="messenger-dialog-section">
                <h4>확인 {list.confirmed.length}명</h4>
                <ul className="messenger-member-list">
                  {list.confirmed.length === 0 && <li className="empty">아직 아무도 확인하지 않았습니다.</li>}
                  {list.confirmed.map((row) => (
                    <li key={row.accountId}><span><strong>{row.name}</strong><small>{formatListDateTime(row.at)}</small></span></li>
                  ))}
                </ul>
              </section>
              <section className="messenger-dialog-section">
                <h4>미확인 {list.unconfirmed.length}명</h4>
                <ul className="messenger-member-list">
                  {list.unconfirmed.length === 0 && <li className="empty">모두 확인했습니다.</li>}
                  {list.unconfirmed.map((row) => (
                    <li key={row.accountId}><span><strong>{row.name}</strong></span></li>
                  ))}
                </ul>
              </section>
            </>
          )}
        </div>

        <footer>
          {/* 바닥도 몸통과 같은 state를 지난다. 열 때마다 명단이 {confirmed:[], unconfirmed:[]}로 비워지므로
              여기서 길이만 보면 아직 오지 않은 명단으로 '모두 확인했습니다'라고 단언하게 되고,
              불러오지 못했을 때는 그 문장이 '명단을 불러오지 못했습니다.' 아래에 그대로 남는다(가짜 0). */}
          <Button tone="quiet" onClick={onClose}>닫기</Button>
          {state === 'ready' && (list.unconfirmed.length === 0
            ? <p className="messenger-notice-allclear">모두 확인했습니다.</p>
            : <Button tone="primary" disabled={pending} onClick={onRemind}>미확인 {list.unconfirmed.length}명에게 다시 알림</Button>)}
        </footer>
      </div>
    </div>
  )
}

import { useCallback, useEffect, useState } from 'react'
import { Check, MessageSquarePlus, Pin, RotateCcw, Search, Trash2, X } from 'lucide-react'
import { Button } from './ui/Button'
import { EmptyState, ErrorState, Skeleton } from './ui/States'

/**
 * AI 대화 목록.
 *
 * 대화는 계정 소유라 서버에서 이미 내 것만 내려온다. 화면은 고르고, 이름을 바꾸고,
 * 고정하고, 버리는 일만 한다.
 */

export type ConversationScope = { kind: 'all' | 'project' | 'file'; id: string; label: string }

export type ConversationSummary = {
  id: string
  title: string
  pinned: boolean
  scope: ConversationScope
  messageCount: number
  preview: string
  excerpt: string
  updatedAt: string
  deletedAt: string | null
  daysLeft: number | null
  promotedCount: number
}

type Props = {
  workspaceScope?: string
  activeId: string
  onSelect: (id: string) => void
  onCreated: (id: string) => void
  /** 대화가 한 턴 오갈 때마다 올라간다. 목록의 제목·미리보기를 다시 읽는다. */
  refreshKey: number
}

const SCOPE_TONE: Record<ConversationScope['kind'], string> = { all: 'scope-all', project: 'scope-project', file: 'scope-file' }

export default function AIConversationList({ workspaceScope, activeId, onSelect, onCreated, refreshKey }: Props) {
  const [items, setItems] = useState<ConversationSummary[]>([])
  const [trashCount, setTrashCount] = useState(0)
  const [query, setQuery] = useState('')
  const [showTrash, setShowTrash] = useState(false)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [renaming, setRenaming] = useState('')
  const [draftTitle, setDraftTitle] = useState('')
  const [busy, setBusy] = useState(false)

  const headers = workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined

  const load = useCallback(async () => {
    if (!workspaceScope) return
    const params = new URLSearchParams()
    if (query.trim()) params.set('q', query.trim())
    if (showTrash) params.set('trash', '1')
    try {
      const response = await fetch(`/api/ai/conversations?${params}`, { headers })
      if (!response.ok) { setLoadState('error'); return }
      const body = await response.json() as { conversations: ConversationSummary[]; trashCount: number }
      setItems(body.conversations ?? [])
      setTrashCount(body.trashCount ?? 0)
      setLoadState('ready')
    } catch {
      // 목록을 못 읽어도 대화 자체는 계속할 수 있다. 다만 왜 비었는지는 말해 준다.
      setLoadState('error')
    }
  }, [workspaceScope, query, showTrash, refreshKey])

  useEffect(() => {
    // 검색어는 치는 대로 보내지 않는다. 글자마다 서버를 부르면 목록이 깜빡인다.
    const timer = setTimeout(() => { void load() }, query ? 250 : 0)
    return () => clearTimeout(timer)
  }, [load, query])

  const call = async (path: string, init: RequestInit) => {
    setBusy(true)
    try {
      await fetch(path, { ...init, headers: { ...(headers ?? {}), 'content-type': 'application/json', ...(init.headers ?? {}) } })
      await load()
    } finally {
      setBusy(false)
    }
  }

  const createNew = async () => {
    if (!workspaceScope) return
    setBusy(true)
    try {
      const response = await fetch('/api/ai/conversations', {
        method: 'POST',
        headers: { ...(headers ?? {}), 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!response.ok) return
      const body = await response.json() as { conversation: { id: string } }
      onCreated(body.conversation.id)
      setShowTrash(false)
      await load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="ai-conversation-list" aria-label="AI 대화 목록">
      <div className="ai-conversation-head">
        <Button tone="primary" size="sm" onClick={() => void createNew()} disabled={busy || !workspaceScope}>
          <MessageSquarePlus size={15} /> 새 대화
        </Button>
        <label className="ai-conversation-search">
          <Search size={14} />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="대화 내용까지 검색"
            aria-label="AI 대화 검색"
          />
        </label>
      </div>

      {(trashCount > 0 || showTrash) && (
        <Button tone="quiet" size="sm" onClick={() => setShowTrash((current) => !current)}>
          <Trash2 size={14} /> {showTrash ? '대화 목록으로' : `휴지통 ${trashCount}건`}
        </Button>
      )}

      {loadState === 'loading' && items.length === 0 && <Skeleton rows={3} label="지난 대화를 불러오는 중" />}
      {loadState === 'error' && (
        <ErrorState title="지난 대화를 불러오지 못했습니다" detail="연결이 끊겼을 수 있습니다. 지금 나누는 대화는 그대로 이어집니다." onRetry={() => { setLoadState('loading'); void load() }} />
      )}
      <ul className="ai-conversation-items">
        {loadState === 'ready' && items.length === 0 && (
          <li>
            <EmptyState
              title={showTrash ? '휴지통이 비어 있습니다' : query ? '찾는 대화가 없습니다' : '아직 대화가 없습니다'}
              description={showTrash ? '지운 대화는 30일 동안 여기 머뭅니다.' : query ? '낱말을 줄이면 더 넓게 찾습니다.' : '새 대화를 눌러 시작하세요. 물어본 것은 이 계정에 그대로 남습니다.'}
            />
          </li>
        )}
        {items.map((item) => (
          <li key={item.id} className={item.id === activeId ? 'is-active' : undefined}>
            {renaming === item.id ? (
              <form
                className="ai-conversation-rename"
                onSubmit={(event) => {
                  event.preventDefault()
                  const title = draftTitle.trim()
                  if (!title) return
                  setRenaming('')
                  void call(`/api/ai/conversations/${item.id}`, { method: 'PATCH', body: JSON.stringify({ title }) })
                }}
              >
                <input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} aria-label="대화 이름" autoFocus />
                <Button tone="primary" size="sm" type="submit" aria-label="이름 저장"><Check size={14} /></Button>
                <Button tone="quiet" size="sm" onClick={() => setRenaming('')} aria-label="이름 변경 취소"><X size={14} /></Button>
              </form>
            ) : (
              <button type="button" className="ai-conversation-open" onClick={() => onSelect(item.id)}>
                <span className="ai-conversation-title">
                  {item.pinned && <Pin size={12} aria-label="고정됨" />}
                  <strong>{item.title}</strong>
                </span>
                <span className="ai-conversation-meta">
                  <em className={SCOPE_TONE[item.scope?.kind ?? 'all']}>{item.scope?.label ?? '전체'}</em>
                  <small>{item.messageCount}개</small>
                  {item.promotedCount > 0 && <small>올린 것 {item.promotedCount}</small>}
                  {item.daysLeft !== null && <small>{item.daysLeft}일 남음</small>}
                </span>
                <span className="ai-conversation-preview">{item.excerpt || item.preview}</span>
              </button>
            )}

            <div className="ai-conversation-actions">
              {showTrash ? (
                <>
                  <Button tone="quiet" size="sm" disabled={busy} onClick={() => void call(`/api/ai/conversations/${item.id}/restore`, { method: 'POST' })}>
                    <RotateCcw size={13} /> 되살리기
                  </Button>
                  <Button tone="danger" size="sm" disabled={busy} onClick={() => void call(`/api/ai/conversations/${item.id}?purge=1`, { method: 'DELETE' })}>
                    완전 삭제
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    tone="quiet"
                    size="sm"
                    disabled={busy}
                    aria-label={item.pinned ? '고정 해제' : '위에 고정'}
                    onClick={() => void call(`/api/ai/conversations/${item.id}`, { method: 'PATCH', body: JSON.stringify({ pinned: !item.pinned }) })}
                  >
                    <Pin size={13} /> {item.pinned ? '고정 해제' : '고정'}
                  </Button>
                  <Button tone="quiet" size="sm" disabled={busy} onClick={() => { setRenaming(item.id); setDraftTitle(item.title) }}>
                    이름 변경
                  </Button>
                  <Button tone="quiet" size="sm" disabled={busy} onClick={() => void call(`/api/ai/conversations/${item.id}`, { method: 'DELETE' })}>
                    <Trash2 size={13} /> 삭제
                  </Button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>

      {showTrash && <p className="ai-conversation-note">휴지통의 대화는 30일 뒤 완전히 사라집니다.</p>}
    </aside>
  )
}

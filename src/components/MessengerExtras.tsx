import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, CornerUpLeft, Hash, Pencil, Pin, PinOff, Search, SmilePlus, Trash2, UserMinus, UserPlus, X } from 'lucide-react'

import { Button, IconButton } from './ui/Button'

/**
 * 메신저의 확장 조작 — 답장·반응·고정·수정·삭제·그룹방 관리·멘션.
 *
 * 대화 화면 본체(CollaborationSuite)는 이미 충분히 크다. 여기서는 "말풍선 하나를
 * 어떻게 다루는가"와 "방을 어떻게 만들고 관리하는가"만 다루고, 데이터는 전부
 * 위에서 내려받아 쓴다. 이 파일은 서버를 직접 부르지 않는다.
 */

export type RoomPerson = {
  id: string
  accountId?: string
  name: string
  team: string
  role: string
  active?: boolean
  system?: boolean
}

/** 자주 쓰는 반응. 더 많은 이모지가 필요하면 키보드로 직접 입력한다. */
const QUICK_REACTIONS = ['👍', '✅', '👀', '🙏', '🎉', '❗'] as const

export function ReactionRow({
  reactions,
  currentIdentityIds,
  onToggle,
}: {
  reactions?: { emoji: string; by: string[] }[]
  currentIdentityIds: string[]
  onToggle: (emoji: string) => void
}) {
  if (!reactions?.length) return null
  return (
    <div className="messenger-reactions" aria-label="이 메시지의 반응">
      {reactions.map((reaction) => {
        const mine = reaction.by.some((id) => currentIdentityIds.includes(id))
        return (
          <button
            key={reaction.emoji}
            type="button"
            className={'messenger-reaction' + (mine ? ' mine' : '')}
            aria-pressed={mine}
            aria-label={`${reaction.emoji} ${reaction.by.length}명${mine ? ' · 내 반응 취소' : ''}`}
            onClick={() => onToggle(reaction.emoji)}
          >
            <span aria-hidden="true">{reaction.emoji}</span>
            <small>{reaction.by.length}</small>
          </button>
        )
      })}
    </div>
  )
}

/**
 * 말풍선에 붙는 조작 줄. 평소에는 숨어 있고 마우스를 올리거나 초점이 가면 나타난다.
 * 모바일에서는 hover가 없으므로 CSS에서 항상 보이게 둔다.
 */
export function MessageActionBar({
  canEdit,
  canDelete,
  canPin = true,
  pinned,
  onReply,
  onReact,
  onPin,
  onEdit,
  onDelete,
}: {
  canEdit: boolean
  canDelete: boolean
  /** 고정은 방 공지를 바꾸는 일이다. 게스트처럼 방을 관리할 수 없는 사람에게는 버튼을 두지 않는다. */
  canPin?: boolean
  pinned: boolean
  onReply: () => void
  onReact: (emoji: string) => void
  onPin: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!pickerOpen) return undefined
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return
      if (event.type === 'pointerdown' && pickerRef.current?.contains(event.target as Node)) return
      setPickerOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', close)
    }
  }, [pickerOpen])

  return (
    <div className="messenger-message-actions" ref={pickerRef}>
      <IconButton tone="quiet" size="sm" aria-label="답장" onClick={onReply}><CornerUpLeft size={15} /></IconButton>
      <IconButton tone="quiet" size="sm" aria-label="반응 남기기" aria-expanded={pickerOpen} onClick={() => setPickerOpen((open) => !open)}><SmilePlus size={15} /></IconButton>
      {canPin && <IconButton tone="quiet" size="sm" aria-label={pinned ? '고정 해제' : '공지로 고정'} onClick={onPin}>{pinned ? <PinOff size={15} /> : <Pin size={15} />}</IconButton>}
      {canEdit && <IconButton tone="quiet" size="sm" aria-label="메시지 수정" onClick={onEdit}><Pencil size={15} /></IconButton>}
      {canDelete && <IconButton tone="quiet" size="sm" aria-label="메시지 삭제" onClick={onDelete}><Trash2 size={15} /></IconButton>}
      {pickerOpen && (
        <div className="messenger-reaction-picker" role="menu" aria-label="반응 고르기">
          {QUICK_REACTIONS.map((emoji) => (
            <button key={emoji} type="button" role="menuitem" aria-label={`${emoji} 반응`} onClick={() => { onReact(emoji); setPickerOpen(false) }}>
              <span aria-hidden="true">{emoji}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** 답장 대상 인용. 말풍선 위에 한 줄로 접어 두고 누르면 원문으로 간다. */
export function QuotedMessage({
  senderName,
  text,
  onJump,
}: {
  senderName: string
  text: string
  onJump?: () => void
}) {
  return (
    <button className="messenger-quote" type="button" onClick={onJump} aria-label={`${senderName}님의 원문으로 이동`}>
      <strong>{senderName}</strong>
      <span>{text.length > 80 ? `${text.slice(0, 79)}…` : text}</span>
    </button>
  )
}

/**
 * @멘션 자동완성. 이름을 정확히 타이핑하게 두면 동명이인과 공백 있는 이름에서 어긋난다.
 * 서버는 본문의 `@이름` 문자열로 알림을 보내므로, 고를 때 그 형태를 정확히 만들어 준다.
 */
export function MentionSuggestions({
  people,
  query,
  activeIndex,
  onPick,
}: {
  people: RoomPerson[]
  query: string
  activeIndex: number
  onPick: (person: RoomPerson) => void
}) {
  if (!people.length) return null
  return (
    <ul className="messenger-mention-list" role="listbox" aria-label={`"${query}" 멘션 후보`}>
      {people.map((person, index) => (
        <li key={person.id}>
          <button
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            className={index === activeIndex ? 'active' : undefined}
            onMouseDown={(event) => { event.preventDefault(); onPick(person) }}
          >
            <strong>{person.name}</strong>
            <small>{person.team}{person.active === false ? ' · 비활성' : ''}</small>
          </button>
        </li>
      ))}
    </ul>
  )
}

/** 방 안 검색 결과. 누르면 그 메시지로 이동한다. */
export function RoomSearchPanel({
  query,
  matches,
  onQueryChange,
  onJump,
  onClose,
}: {
  query: string
  matches: { id: string; text: string; senderName: string; time: string }[]
  onQueryChange: (value: string) => void
  onJump: (messageId: string) => void
  onClose: () => void
}) {
  return (
    <div className="messenger-room-search" role="search">
      <label>
        <Search size={16} aria-hidden="true" />
        <span className="sr-only">이 대화방에서 검색</span>
        <input value={query} autoFocus placeholder="이 방에서 검색 (2자 이상)" onChange={(event) => onQueryChange(event.target.value)} />
      </label>
      <IconButton tone="quiet" size="sm" aria-label="방 검색 닫기" onClick={onClose}><X size={16} /></IconButton>
      {query.trim().length >= 2 && (
        <ul className="messenger-room-search-results">
          {matches.length === 0 && <li className="empty">일치하는 메시지가 없습니다.</li>}
          {matches.map((match) => (
            <li key={match.id}>
              <button type="button" onClick={() => onJump(match.id)}>
                <strong>{match.senderName}</strong>
                <span>{match.text.length > 90 ? `${match.text.slice(0, 89)}…` : match.text}</span>
                <time>{match.time}</time>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * 그룹방 만들기·관리.
 *
 * 인원 상한을 두지 않는다. 테넌트 전원이 들어오는 공지방이 정상적인 쓰임이고,
 * 사람이 많아질 때를 대비해 목록은 검색으로 좁힌다.
 */
export function GroupRoomDialog({
  mode,
  people,
  currentUserId,
  room,
  pending,
  onSubmit,
  onInvite,
  onRemove,
  onTransfer,
  onClose,
}: {
  mode: 'create' | 'manage'
  people: RoomPerson[]
  currentUserId: string
  room?: { id: string; name: string; icon?: string; ownerId?: string; participantIds?: string[] }
  pending: boolean
  onSubmit: (payload: { name: string; icon: string; participantIds: string[] }) => void
  onInvite?: (ids: string[]) => void
  onRemove?: (id: string) => void
  onTransfer?: (id: string) => void
  onClose: () => void
}) {
  const [name, setName] = useState(room?.name ?? '')
  const [icon, setIcon] = useState(room?.icon ?? '')
  const [picked, setPicked] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const dialogRef = useRef<HTMLDivElement>(null)

  const members = room?.participantIds ?? []
  const invitable = useMemo(() => {
    const term = search.trim().toLowerCase()
    return people.filter((person) => {
      if (person.system || person.id === currentUserId) return false
      if (person.active === false) return false
      if (mode === 'manage' && members.includes(person.accountId ?? person.id)) return false
      if (!term) return true
      return `${person.name} ${person.team} ${person.role}`.toLowerCase().includes(term)
    })
  }, [people, search, mode, members, currentUserId])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    dialogRef.current?.querySelector('input')?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const toggle = (id: string) => setPicked((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])

  return (
    <div className="messenger-dialog-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="messenger-dialog" role="dialog" aria-modal="true" aria-label={mode === 'create' ? '그룹 대화방 만들기' : '대화방 관리'} ref={dialogRef}>
        <header>
          <span className="messenger-team-icon">{icon ? <span aria-hidden="true">{icon}</span> : <Hash size={18} />}</span>
          <strong>{mode === 'create' ? '그룹 대화방 만들기' : '대화방 관리'}</strong>
          <IconButton tone="quiet" size="sm" aria-label="닫기" onClick={onClose}><X size={18} /></IconButton>
        </header>

        <div className="messenger-dialog-body">
          <label className="messenger-field">
            <span>방 이름</span>
            <input value={name} maxLength={60} placeholder="예: 금속검출기 점검" onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="messenger-field">
            <span>아이콘 (이모지, 선택)</span>
            <input value={icon} maxLength={8} placeholder="🔧" onChange={(event) => setIcon(event.target.value)} />
          </label>

          {mode === 'manage' && members.length > 0 && (
            <section className="messenger-dialog-section">
              <h4>참여 중 {members.length}명</h4>
              <ul className="messenger-member-list">
                {members.map((memberId) => {
                  const person = people.find((item) => item.id === memberId || item.accountId === memberId)
                  const isOwner = room?.ownerId === memberId
                  return (
                    <li key={memberId}>
                      <span>
                        <strong>{person?.name ?? memberId}</strong>
                        <small>{isOwner ? '방장' : person?.team ?? ''}{person?.active === false ? ' · 비활성' : ''}</small>
                      </span>
                      {!isOwner && (
                        <span className="messenger-member-actions">
                          <Button tone="quiet" size="sm" onClick={() => onTransfer?.(memberId)}>방장 위임</Button>
                          <IconButton tone="quiet" size="sm" aria-label={`${person?.name ?? memberId} 내보내기`} onClick={() => onRemove?.(memberId)}><UserMinus size={15} /></IconButton>
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            </section>
          )}

          <section className="messenger-dialog-section">
            <h4>{mode === 'create' ? '초대할 사람' : '초대 추가'}</h4>
            <label className="messenger-field">
              <span className="sr-only">구성원 검색</span>
              <input value={search} placeholder="이름·팀으로 찾기" onChange={(event) => setSearch(event.target.value)} />
            </label>
            <ul className="messenger-member-list picker">
              {invitable.length === 0 && <li className="empty">초대할 수 있는 사람이 없습니다.</li>}
              {invitable.map((person) => {
                const id = person.accountId ?? person.id
                const checked = picked.includes(id)
                return (
                  <li key={person.id}>
                    <button type="button" role="checkbox" aria-checked={checked} onClick={() => toggle(id)}>
                      <span className={'messenger-check' + (checked ? ' on' : '')} aria-hidden="true">{checked && <Check size={13} />}</span>
                      <span><strong>{person.name}</strong><small>{person.team} · {person.role}</small></span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        </div>

        <footer>
          <Button tone="quiet" onClick={onClose}>닫기</Button>
          {mode === 'create'
            ? <Button tone="primary" disabled={!name.trim() || pending} onClick={() => onSubmit({ name: name.trim(), icon: icon.trim(), participantIds: picked })}>만들기</Button>
            : (
              <>
                <Button tone="quiet" disabled={pending || !picked.length} onClick={() => { onInvite?.(picked); setPicked([]) }}><UserPlus size={16} /> 초대</Button>
                <Button tone="primary" disabled={pending || !name.trim()} onClick={() => onSubmit({ name: name.trim(), icon: icon.trim(), participantIds: [] })}>저장</Button>
              </>
            )}
        </footer>
      </div>
    </div>
  )
}

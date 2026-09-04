import { useCallback, useEffect, useState } from 'react'
import { Eye, Hash, Lock, ShieldCheck, UserCheck, UserX } from 'lucide-react'

import { Button } from './ui/Button'
import './OversightPanel.css'

/**
 * 감독 열람 — 업무 채널과 그룹방의 대화를 관리자가 확인하는 화면.
 *
 * 화면이 지켜야 할 것 두 가지:
 *  1. **1:1 개인 대화는 여기 없다.** 서버가 목록에서 빼지만, 화면도 그 사실을 눈에 보이게
 *     적는다. "안 보이는 것이 있다"를 숨기면 사용자는 전부 보고 있다고 믿는다.
 *  2. **열람은 기록된다는 것을 열람자 본인에게 알린다.** 자기 행동이 남는다는 사실을
 *     아는 것과 모르는 것은 행동을 다르게 만든다.
 */

type Room = {
  id: string
  name: string
  kind: string
  icon: string
  participantCount: number
  messageCount: number
  lastMessage: string
  lastTime: string
}

type OversightMessage = { id: string; senderName: string; text: string; time: string; deletedAt?: string }
type AuditEvent = { id: string; at: string; event: string; scope: string; actor: string; reference: string }
type Member = { id: string; name: string; email: string; accountRole?: string; oversight?: boolean; status?: string }

export function OversightPanel({
  canManageGrants,
  workspaceScope,
  onToast,
}: {
  canManageGrants: boolean
  workspaceScope?: string
  onToast: (message: string) => void
}) {
  const [rooms, setRooms] = useState<Room[]>([])
  const [excludedDirect, setExcludedDirect] = useState(0)
  const [selected, setSelected] = useState<{ room: Room; messages: OversightMessage[]; participants: { id: string; name: string; team: string; active: boolean }[] } | null>(null)
  const [audit, setAudit] = useState<AuditEvent[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const headers = workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const response = await fetch('/api/oversight/rooms', { headers })
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { message?: string } } | null
        setError(body?.error?.message ?? '열람 목록을 불러오지 못했습니다.')
        return
      }
      const body = await response.json() as { rooms: Room[]; excludedDirectCount: number }
      setRooms(body.rooms)
      setExcludedDirect(body.excludedDirectCount)
      if (canManageGrants) {
        const [auditBody, memberBody] = await Promise.all([
          fetch('/api/oversight/audit', { headers }).then((item) => item.ok ? item.json() : { events: [] }),
          fetch('/api/admin/accounts', { headers }).then((item) => item.ok ? item.json() : { accounts: [] }),
        ])
        setAudit(auditBody.events ?? [])
        setMembers(memberBody.accounts ?? [])
      }
    } catch {
      setError('서버에 연결하지 못했습니다.')
    } finally {
      setLoading(false)
    }
  }, [canManageGrants, workspaceScope])

  useEffect(() => { void load() }, [load])

  const openRoom = async (room: Room) => {
    try {
      const response = await fetch(`/api/oversight/rooms/${encodeURIComponent(room.id)}`, { headers })
      const body = await response.json().catch(() => null)
      if (!response.ok) {
        onToast(body?.error?.message ?? '대화를 열지 못했습니다.')
        return
      }
      setSelected({ room: body.room, messages: body.messages, participants: body.participants })
      onToast('열람 기록을 남겼습니다.')
      if (canManageGrants) {
        const auditBody = await fetch('/api/oversight/audit', { headers }).then((item) => item.ok ? item.json() : { events: [] })
        setAudit(auditBody.events ?? [])
      }
    } catch {
      onToast('서버에 연결하지 못했습니다.')
    }
  }

  const toggleGrant = async (member: Member) => {
    try {
      const response = await fetch(`/api/admin/accounts/${encodeURIComponent(member.id)}/oversight`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(headers ?? {}) },
        body: JSON.stringify({ granted: !member.oversight }),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok) {
        onToast(body?.error?.message ?? '열람 권한을 바꾸지 못했습니다.')
        return
      }
      onToast(`${member.name}님의 열람 권한을 ${member.oversight ? '회수' : '부여'}했습니다.`)
      await load()
    } catch {
      onToast('서버에 연결하지 못했습니다.')
    }
  }

  if (loading) {
    return (
      <section className="oversight" aria-busy="true">
        <div className="oversight-skeleton" aria-hidden="true">
          {Array.from({ length: 4 }, (_, index) => <span key={index} />)}
        </div>
        <p className="sr-only">대화 열람 목록을 불러오는 중입니다.</p>
      </section>
    )
  }

  if (error) {
    return (
      <section className="oversight">
        <div className="oversight-error" role="alert">
          <Lock size={26} aria-hidden="true" />
          <strong>{error}</strong>
          <Button tone="ghost" onClick={() => void load()}>다시 시도</Button>
        </div>
      </section>
    )
  }

  return (
    <section className="oversight">
      <header className="oversight-head">
        <span className="oversight-icon"><ShieldCheck size={20} /></span>
        <div>
          <strong>업무 대화 열람</strong>
          <span>업무용 채널과 그룹방만 볼 수 있습니다. 1:1 개인 대화 {excludedDirect}개는 열람 대상이 아닙니다.</span>
        </div>
      </header>

      <p className="oversight-notice">
        <Eye size={15} aria-hidden="true" />
        여는 순간 <strong>열람자·대상 방·시각</strong>이 기록됩니다. 대화 참여자에게 개별 알림은 가지 않습니다.
      </p>

      <div className="oversight-body">
        <div className="oversight-rooms">
          <h4>열람 가능한 방 {rooms.length}개</h4>
          {rooms.length === 0 && <p className="oversight-empty">아직 업무 채널이나 그룹방이 없습니다.</p>}
          <ul>
            {rooms.map((room) => (
              <li key={room.id}>
                <button type="button" className={selected?.room.id === room.id ? 'active' : undefined} onClick={() => void openRoom(room)}>
                  <span className="oversight-room-icon">{room.icon ? <span aria-hidden="true">{room.icon}</span> : <Hash size={16} />}</span>
                  <span>
                    <strong>{room.name}</strong>
                    <small>{room.participantCount}명 · 메시지 {room.messageCount}건</small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="oversight-reader">
          {!selected && <p className="oversight-empty">왼쪽에서 방을 고르면 대화가 열립니다.</p>}
          {selected && (
            <>
              <h4>{selected.room.name}</h4>
              <p className="oversight-participants">
                {selected.participants.map((person) => `${person.name}${person.active ? '' : '(비활성)'}`).join(', ') || '참여자 정보 없음'}
              </p>
              <ol className="oversight-messages">
                {selected.messages.map((message) => (
                  <li key={message.id} className={message.deletedAt ? 'removed' : undefined}>
                    <strong>{message.senderName}</strong>
                    <p>{message.text}</p>
                    <time>{message.time}</time>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      </div>

      {canManageGrants && (
        <>
          <section className="oversight-grants">
            <h4>열람 권한</h4>
            <p className="oversight-empty">회사 관리자는 별도 지정 없이 열람할 수 있습니다. 아래에서 구성원에게 권한을 주거나 거둘 수 있고, 그 변경도 기록에 남습니다.</p>
            <ul>
              {members.filter((member) => member.accountRole !== 'tenant-admin').map((member) => (
                <li key={member.id}>
                  <span><strong>{member.name}</strong><small>{member.email} · {member.status}</small></span>
                  <Button tone={member.oversight ? 'quiet' : 'secondary'} size="sm" onClick={() => void toggleGrant(member)}>
                    {member.oversight ? <><UserX size={15} /> 권한 회수</> : <><UserCheck size={15} /> 권한 부여</>}
                  </Button>
                </li>
              ))}
            </ul>
          </section>

          <section className="oversight-audit">
            <h4>열람 기록 {audit.length}건</h4>
            {audit.length === 0 && <p className="oversight-empty">아직 열람 기록이 없습니다.</p>}
            <ul>
              {audit.map((event) => (
                <li key={event.id}>
                  <span className="oversight-audit-event">{event.event}</span>
                  <span><strong>{event.actor}</strong><small>{event.scope}</small></span>
                  <time>{event.at}</time>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </section>
  )
}

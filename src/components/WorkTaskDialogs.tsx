import { useState, type FormEvent, type KeyboardEvent } from 'react'
import { Ban, Check, MessageSquare, Pencil, Trash2, X } from 'lucide-react'

import type { WorkActivity, WorkComment, WorkItem } from '../domainData'
import { formatDateTime, formatWorkDue } from '../utils/dateTime'
import { useDialogFocus } from './CompletionModal'
import { Button, IconButton } from './ui/Button'

/**
 * 만든 업무를 고치고·넘기고·취소하고, 그 업무 안에서 이야기하는 화면 조각(P1-5).
 * 결재 상태(업무요청 → 수행중 → 결재대기 → 결재완료)는 이 조각들이 바꾸지 않는다 — 상태는 드로어의 '지금 할 일'만 바꾼다.
 */

type Person = { id: string; name: string; kind?: 'employee' | 'guest' }

const FIELD_LABELS: Record<string, string> = { title: '제목', description: '완료 기준', priority: '우선순위', category: '분류', due: '마감' }

/** 기록 한 줄의 문장. 누가 무엇을 무엇에서 무엇으로 — 없는 값을 지어내지 않는다. */
export function activityText(entry: WorkActivity): string {
  const who = `${entry.actorName}님이`
  if (entry.kind === 'accept') return `${who} 업무를 시작했습니다.`
  if (entry.kind === 'owner') return `${who} 담당을 ${entry.from || '(없음)'}에서 ${entry.to || '(없음)'}(으)로 넘겼습니다.`
  if (entry.kind === 'requester') return `${who} 확인할 사람을 ${entry.from || '(없음)'}에서 ${entry.to || '(없음)'}(으)로 바꿨습니다.`
  if (entry.kind === 'schedule') return `${who} 마감을 ${entry.from ? formatWorkDue(entry.from) : '(없음)'} → ${entry.to ? formatWorkDue(entry.to) : '(없음)'}(으)로 바꿨습니다.`
  if (entry.kind === 'cancel') return `${who} 업무를 취소했습니다${entry.note ? ` — ${entry.note}` : '.'}`
  if (entry.kind === 'restore') return `${who} 취소한 업무를 되살렸습니다.`
  const label = FIELD_LABELS[entry.field ?? ''] ?? '내용'
  // 완료 기준처럼 긴 글은 전후를 다 적지 않는다 — 바뀌었다는 사실만.
  if (entry.field === 'description') return `${who} ${label}을 고쳤습니다.`
  return `${who} ${label}을(를) ‘${entry.from ?? ''}’에서 ‘${entry.to ?? ''}’(으)로 바꿨습니다.`
}

/** [고치기] — 지시한 사람·관리자. 담당은 진행 전·진행 중일 때만, 확인할 사람(요청자)은 관리자만 바꾼다. */
export function TaskEditDialog({ item, people, canChangeRequester, onClose, onSave }: {
  item: WorkItem
  people: Person[]
  canChangeRequester: boolean
  onClose: () => void
  onSave: (patch: Record<string, string>) => Promise<boolean>
}) {
  const dialogRef = useDialogFocus(true)
  const [title, setTitle] = useState(item.title)
  const [description, setDescription] = useState(item.description)
  const [priority, setPriority] = useState(item.priority)
  const [ownerId, setOwnerId] = useState(item.ownerId ?? '')
  const [requesterId, setRequesterId] = useState(item.requesterId ?? '')
  const [busy, setBusy] = useState(false)
  const ownerLocked = !['업무요청', '수행중'].includes(item.status)
  const employees = people.filter((person) => person.kind !== 'guest')
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const patch: Record<string, string> = {}
    if (title.trim() !== item.title) patch.title = title.trim()
    if (description.trim() !== item.description) patch.description = description.trim()
    if (priority !== item.priority) patch.priority = priority
    if (!ownerLocked && ownerId && ownerId !== item.ownerId) patch.ownerId = ownerId
    if (canChangeRequester && requesterId && requesterId !== item.requesterId) patch.requesterId = requesterId
    if (!Object.keys(patch).length) { onClose(); return }
    setBusy(true)
    const ok = await onSave(patch)
    setBusy(false)
    if (ok) onClose()
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section ref={dialogRef} className="modal-card workflow-modal" role="dialog" aria-modal="true" aria-labelledby="task-edit-title">
      <header><div><span className="eyebrow">EDIT TASK</span><h2 id="task-edit-title">업무 고치기</h2><p>바꾼 내용은 진행 이력에 남고, 담당자에게 알려집니다.</p></div><IconButton tone="ghost" type="button" aria-label="닫기" disabled={busy} onClick={onClose}><X size={21} /></IconButton></header>
      <form onSubmit={(event) => void submit(event)}>
        <label className="form-field full"><span>업무 제목</span><input value={title} maxLength={120} required autoFocus onChange={(event) => setTitle(event.target.value)} /></label>
        <label className="form-field full"><span>완료 기준</span><textarea value={description} rows={4} maxLength={2_000} onChange={(event) => setDescription(event.target.value)} /></label>
        <div className="form-grid">
          <label className="form-field"><span>우선순위</span><select value={priority} onChange={(event) => setPriority(event.target.value as WorkItem['priority'])}><option>긴급</option><option>높음</option><option>보통</option></select></label>
          <label className="form-field"><span>담당자</span>
            <select value={ownerId} disabled={ownerLocked} onChange={(event) => setOwnerId(event.target.value)}>
              {!people.some((person) => person.id === ownerId) && <option value={ownerId}>{item.owner}</option>}
              {people.map((person) => <option key={person.id} value={person.id}>{person.name}{person.kind === 'guest' ? ' (외부)' : ''}</option>)}
            </select>
          </label>
        </div>
        {ownerLocked && <p className="approval-edit-note">확인을 기다리는 업무라 담당자는 바꿀 수 없습니다. 보완을 요청하면 다시 바꿀 수 있습니다.</p>}
        {canChangeRequester && <label className="form-field full"><span>확인할 사람(지시한 사람)</span>
          <select value={requesterId} onChange={(event) => setRequesterId(event.target.value)}>
            {!employees.some((person) => person.id === requesterId) && <option value={requesterId}>{item.requestedBy}</option>}
            {employees.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
          </select>
          <small className="field-hint">지시한 사람이 자리를 비웠거나 퇴사했을 때, 완료 보고를 확인할 사람을 넘깁니다.</small>
        </label>}
        <footer><Button tone="ghost" type="button" disabled={busy} onClick={onClose}>취소</Button><Button tone="primary" type="submit" disabled={busy || !title.trim()}><Check size={18} /> {busy ? '저장 중…' : '고친 내용 저장'}</Button></footer>
      </form>
    </section>
  </div>
}

/** [업무 취소] — 사유를 받아 보관함으로 옮긴다. 하위 업무도 함께 옮겨지고, 되살릴 수 있다. */
export function TaskCancelDialog({ item, childCount, onClose, onConfirm }: {
  item: WorkItem
  childCount: number
  onClose: () => void
  onConfirm: (reason: string) => Promise<boolean>
}) {
  const dialogRef = useDialogFocus(true)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const valid = reason.trim().length >= 2
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section ref={dialogRef} className="modal-card workflow-modal" role="alertdialog" aria-modal="true" aria-labelledby="task-cancel-title">
      <header><div><span className="eyebrow">CANCEL TASK</span><h2 id="task-cancel-title">업무 취소</h2><p>{item.title}</p></div><IconButton tone="ghost" type="button" aria-label="닫기" disabled={busy} onClick={onClose}><X size={21} /></IconButton></header>
      <form onSubmit={(event) => { event.preventDefault(); if (!valid) return; setBusy(true); void onConfirm(reason.trim()).then((ok) => { setBusy(false); if (ok) onClose() }) }}>
        <p className="modal-note-plain">진행 중 목록에서 빠지고 <strong>보관함</strong>으로 옮겨집니다(지우지 않습니다). {childCount > 0 ? `하위 업무 ${childCount}건도 함께 옮겨집니다. ` : ''}이유는 담당자 {item.owner}님에게 전해집니다. 나중에 되살릴 수 있습니다.</p>
        <label className="form-field full"><span>취소하는 이유 <em>필수</em></span><textarea value={reason} rows={3} maxLength={500} autoFocus placeholder="예: 거래처가 발주를 철회했습니다" onChange={(event) => setReason(event.target.value)} /></label>
        <footer><Button tone="ghost" type="button" disabled={busy} onClick={onClose}>돌아가기</Button><Button tone="danger" type="submit" disabled={busy || !valid}><Ban size={17} /> {busy ? '처리 중…' : '업무 취소'}</Button></footer>
      </form>
    </section>
  </div>
}

/** 업무 안의 댓글. 담당·지시한 사람·관리자만 보고 쓴다(서버가 판정한다). 지우면 자리만 남는다. */
export function TaskComments({ comments, currentUserId, canModerate, onPost, onDelete }: {
  comments: WorkComment[]
  currentUserId: string
  canModerate: boolean
  onPost: (text: string) => Promise<boolean>
  onDelete: (commentId: string) => Promise<boolean>
}) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const post = async () => {
    if (!draft.trim() || busy) return
    setBusy(true)
    const ok = await onPost(draft.trim())
    setBusy(false)
    if (ok) setDraft('')
  }
  // 한글 조합 중 Enter는 글자를 확정하는 키다 — 보내지 않는다. 보내기는 Ctrl/⌘+Enter 또는 단추.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void post() }
  }
  return <section className="workflow-drawer-block workflow-comments" aria-label="댓글">
    <span><MessageSquare size={15} /> 댓글 <small>{comments.filter((comment) => !comment.deletedAt).length}</small></span>
    {comments.length === 0 ? <p className="workflow-drawer-timeline-empty">이 업무를 두고 묻거나 알릴 것이 있으면 여기에 남기세요. 담당자와 지시한 사람에게 알림이 갑니다.</p> : <ol className="workflow-comment-list">
      {comments.map((comment) => <li key={comment.id} className={comment.deletedAt ? 'is-deleted' : undefined}>
        <div className="workflow-comment-head"><strong>{comment.authorName}</strong><time dateTime={comment.createdAt}>{formatDateTime(comment.createdAt)}</time>
          {!comment.deletedAt && (comment.authorId === currentUserId || canModerate) && <IconButton tone="quiet" size="sm" aria-label="댓글 지우기" onClick={() => { if (window.confirm('이 댓글을 지울까요? 자리에는 "지운 댓글"만 남습니다.')) void onDelete(comment.id) }}><Trash2 size={14} /></IconButton>}
        </div>
        <p>{comment.deletedAt ? '지운 댓글입니다.' : comment.text}</p>
      </li>)}
    </ol>}
    <div className="workflow-comment-compose">
      <label className="sr-only" htmlFor="workflow-comment-input">댓글</label>
      <textarea id="workflow-comment-input" value={draft} rows={2} maxLength={2_000} placeholder="댓글을 적으세요 (Ctrl+Enter로 보내기)" onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} />
      <Button tone="secondary" size="sm" type="button" disabled={busy || !draft.trim()} onClick={() => void post()}>{busy ? '보내는 중…' : '댓글 남기기'}</Button>
    </div>
  </section>
}

/** 드로어 머리의 [고치기]·[업무 취소]. 지시한 사람·관리자에게만, 끝난 업무에는 없다. */
export function TaskManageActions({ onEdit, onCancel }: { onEdit: () => void; onCancel: () => void }) {
  return <div className="workflow-drawer-manage">
    <Button tone="ghost" size="sm" type="button" onClick={onEdit}><Pencil size={15} /> 고치기</Button>
    <Button tone="ghost" size="sm" type="button" onClick={onCancel}><Ban size={15} /> 업무 취소</Button>
  </div>
}

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { ArrowRight, Check, ChevronDown, Circle, Pencil, Plus, RefreshCw, Sparkles, Trash2, X } from 'lucide-react'
import { seoulDateInputValue } from '../utils/dateTime'
import type { WorkItem } from '../domainData'
import './PersonalTodoWidget.css'
import { Button } from './ui/Button'

type PersonalTodo = {
  id: string
  ownerId: string
  title: string
  status: 'open' | 'completed'
  origin: 'manual' | 'ai'
  priority: 'low' | 'normal' | 'high'
  dueAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
  source: { kind: 'work-item' | 'daily-journal'; id: string; action: string } | null
  reason: string
}

type TodoResponse = {
  items: PersonalTodo[]
  changes?: { created: number; completed: number }
  error?: { message?: string }
}

type TodoEditor = { id: string; title: string; dueDate: string; priority: PersonalTodo['priority'] }

function toDueAt(value: string) {
  if (!value) return null
  const due = new Date(`${value}T23:59:59.999+09:00`)
  return Number.isFinite(due.getTime()) ? due.toISOString() : null
}

function dueInputValue(value: string | null) {
  if (!value) return ''
  return seoulDateInputValue(new Date(value))
}

function isOverdue(value: string | null) {
  if (!value) return false
  return dueInputValue(value) < dueInputValue(new Date().toISOString())
}

/**
 * 업무에서 온 줄의 다음 행동. 홈의 '다음 업무' 칸이 하던 일을 이 목록이 한다 — 같은 업무가 홈에 네 번 나오던
 * 것(내 할 일·다음 업무·지금 회사에서·머리 칩)을 줄였다(감사 live-ui-06). 문구는 업무 화면과 같다.
 */
function workAction(item: WorkItem, currentUserId: string): string {
  if (item.status === '업무요청') return '시작하기'
  if (item.status === '수행중') return item.review?.decision === 'changes-requested' ? '고쳐서 다시 내기' : '완료 보고하기'
  if (item.status === '결재대기' && item.requesterId === currentUserId) return '확인하기'
  return ''
}

/** 마감이 지난 것 → 마감이 가까운 것 → 마감 없는 것. 같은 자리면 먼저 만든 것이 위. */
function byUrgency(left: PersonalTodo, right: PersonalTodo) {
  const leftDue = left.dueAt ? Date.parse(left.dueAt) : Number.POSITIVE_INFINITY
  const rightDue = right.dueAt ? Date.parse(right.dueAt) : Number.POSITIVE_INFINITY
  return leftDue - rightDue || left.createdAt.localeCompare(right.createdAt)
}

function dueLabel(value: string | null) {
  if (!value) return ''
  const today = dueInputValue(new Date().toISOString())
  const due = dueInputValue(value)
  const days = Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)
  if (days < 0) return `${Math.abs(days)}일 지남`
  if (days === 0) return '오늘까지'
  if (days === 1) return '내일까지'
  return `${due.slice(5).replace('-', '.')}까지`
}

export function PersonalTodoWidget({ workspaceScope, onNavigate, onToast, workItems, currentUserId = '', onOpenTask, onAdvanceTask, hideWorkItems = false }: {
  workspaceScope?: string
  onNavigate: (page: 'tasks' | 'journal') => void
  onToast: (message: string) => void
  /** 넘기면 업무에서 온 줄에 그 업무의 다음 행동(시작·완료 보고·확인)을 단다. */
  workItems?: WorkItem[]
  currentUserId?: string
  onOpenTask?: (taskId: string) => void
  onAdvanceTask?: (item: WorkItem) => void
  /** 쉬운 화면처럼 업무 목록을 따로 크게 보여 주는 자리에서는 업무 줄을 빼 같은 일을 두 번 보이지 않는다. */
  hideWorkItems?: boolean
}) {
  const [items, setItems] = useState<PersonalTodo[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [showCompleted, setShowCompleted] = useState(false)
  const [editor, setEditor] = useState<TodoEditor | null>(null)
  const [error, setError] = useState('')

  const headers = useMemo(() => ({
    'content-type': 'application/json',
    ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}),
  }), [workspaceScope])

  const request = useCallback(async (path: string, init: RequestInit = {}) => {
    const response = await fetch(path, { ...init, headers: { ...headers, ...(init.headers ?? {}) } })
    const body = await response.json() as TodoResponse
    if (!response.ok || !Array.isArray(body.items)) throw new Error(body.error?.message || '내 할 일을 처리하지 못했습니다.')
    setItems(body.items)
    setError('')
    return body
  }, [headers])

  const sync = useCallback(async (announce = false) => {
    setSyncing(true)
    try {
      const body = await request('/api/personal-todos/ai-sync', { method: 'POST', body: '{}' })
      if (announce || body.changes?.created || body.changes?.completed) {
        const pieces = []
        if (body.changes?.created) pieces.push(`${body.changes.created}건 추가`)
        if (body.changes?.completed) pieces.push(`${body.changes.completed}건 완료`)
        onToast(pieces.length ? `AI가 내 할 일을 정리했습니다 · ${pieces.join(' · ')}` : 'AI 자동 정리가 최신 상태입니다.')
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'AI 자동 정리를 실행하지 못했습니다.')
    } finally {
      setLoading(false)
      setSyncing(false)
    }
  }, [onToast, request])

  useEffect(() => {
    void sync(false)
    const timer = window.setInterval(() => { void sync(false) }, 5 * 60_000)
    const onFocus = () => { void sync(false) }
    window.addEventListener('focus', onFocus)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', onFocus) }
  }, [sync])

  const createTodo = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    // currentTarget은 핸들러가 끝나면 null이 된다. await 뒤에 쓰려면 미리 잡아 둬야 한다.
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const title = String(form.get('title') ?? '').trim()
    const dueDate = String(form.get('dueDate') ?? '')
    if (!title) return
    setSaving(true)
    try {
      await request('/api/personal-todos', { method: 'POST', body: JSON.stringify({ title, dueAt: toDueAt(dueDate), priority: 'normal' }) })
      formElement.reset()
      onToast('할 일을 추가했습니다.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '할 일을 추가하지 못했습니다.')
    } finally { setSaving(false) }
  }

  const updateTodo = async (id: string, patch: Record<string, unknown>, successMessage?: string) => {
    setUpdatingId(id)
    try {
      await request(`/api/personal-todos/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) })
      if (successMessage) onToast(successMessage)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '할 일을 수정하지 못했습니다.')
    } finally { setUpdatingId(null) }
  }

  const saveEditor = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!editor) return
    await updateTodo(editor.id, { title: editor.title, dueAt: toDueAt(editor.dueDate), priority: editor.priority }, '할 일을 수정했습니다.')
    setEditor(null)
  }

  const removeTodo = async (todo: PersonalTodo) => {
    if (!window.confirm(`‘${todo.title}’ 할 일을 삭제할까요?`)) return
    setUpdatingId(todo.id)
    try {
      await request(`/api/personal-todos/${encodeURIComponent(todo.id)}`, { method: 'DELETE' })
      onToast('할 일을 삭제했습니다.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '할 일을 삭제하지 못했습니다.')
    } finally { setUpdatingId(null) }
  }

  const shown = hideWorkItems ? items.filter((item) => item.source?.kind !== 'work-item') : items
  const openItems = shown.filter((item) => item.status === 'open').sort(byUrgency)
  const completedItems = shown.filter((item) => item.status === 'completed')
  const workOf = (todo: PersonalTodo) => todo.source?.kind === 'work-item' ? workItems?.find((item) => item.id === todo.source?.id) : undefined
  const sourcePage = (todo: PersonalTodo) => todo.source?.kind === 'daily-journal' ? 'journal' : 'tasks'

  const todoRow = (todo: PersonalTodo) => {
    const work = workOf(todo)
    // 업무에서 온 줄은 업무가 주인이다: 체크 대신 그 업무의 다음 행동을 달고, 고치기·지우기는 업무 화면에서.
    // (체크로 닫으면 업무는 그대로인데 내 목록에서만 사라졌다.)
    if (work && todo.status === 'open') {
      const action = workAction(work, currentUserId)
      return <article className={`personal-todo-row is-work${todo.priority === 'high' ? ' is-high' : ''}`} key={todo.id}>
        <span className="personal-todo-work-dot" aria-hidden="true"><Circle size={16} /></span>
        <div className="personal-todo-copy">
          <strong>{todo.title}</strong>
          <span>업무{todo.dueAt ? <> · <em className={isOverdue(todo.dueAt) ? 'is-overdue' : ''}>{dueLabel(todo.dueAt)}</em></> : ''}</span>
        </div>
        {action && onAdvanceTask
          ? <Button tone={isOverdue(todo.dueAt) ? 'primary' : 'secondary'} size="sm" type="button" onClick={() => onAdvanceTask(work)}>{action}</Button>
          : <Button tone="quiet" size="sm" type="button" onClick={() => onOpenTask ? onOpenTask(work.id) : onNavigate('tasks')}>열기 <ArrowRight size={13} /></Button>}
      </article>
    }
    return <article className={`personal-todo-row${todo.status === 'completed' ? ' is-completed' : ''}${todo.priority === 'high' ? ' is-high' : ''}`} key={todo.id}>
    <button
      className="personal-todo-check"
      type="button"
      role="checkbox"
      aria-checked={todo.status === 'completed'}
      aria-label={`${todo.title} ${todo.status === 'completed' ? '다시 열기' : '완료 처리'}`}
      disabled={updatingId === todo.id}
      onClick={() => void updateTodo(todo.id, { completed: todo.status !== 'completed' }, todo.status === 'completed' ? '할 일을 다시 열었습니다.' : '완료했습니다.')}
    >{todo.status === 'completed' ? <Check size={15} /> : <Circle size={16} />}</button>
    <div className="personal-todo-copy">
      <strong>{todo.title}</strong>
      <span>{todo.origin === 'ai' ? <><Sparkles size={12} /> AI 자동</> : '직접 등록'}{todo.dueAt ? <> · <em className={todo.status === 'open' && isOverdue(todo.dueAt) ? 'is-overdue' : ''}>{dueLabel(todo.dueAt)}</em></> : ''}</span>
    </div>
    {todo.source && <button className="personal-todo-source" type="button" title={todo.reason} onClick={() => onNavigate(sourcePage(todo))}>원본 <ArrowRight size={13} /></button>}
    <button className="personal-todo-icon" type="button" aria-label={`${todo.title} 수정`} onClick={() => setEditor({ id: todo.id, title: todo.title, dueDate: dueInputValue(todo.dueAt), priority: todo.priority })}><Pencil size={14} /></button>
    <button className="personal-todo-icon is-danger" type="button" aria-label={`${todo.title} 삭제`} onClick={() => void removeTodo(todo)}><Trash2 size={14} /></button>
  </article>
  }

  return <section className="personal-todo-widget dashboard-section-card" aria-labelledby="personal-todo-title">
    <header className="dashboard-section-header"><div className="dashboard-section-title"><span className="dashboard-section-icon"><Check size={18} /></span><h2 id="personal-todo-title">내 할 일</h2></div><Button tone="quiet" type="button" disabled={syncing} onClick={() => void sync(true)}><Sparkles size={15} /> {syncing ? '정리 중' : 'AI 정리'}</Button></header>
    <div className="personal-todo-body dashboard-section-body">
      <form className="personal-todo-add" onSubmit={createTodo}>
        <label className="personal-todo-field" htmlFor="personal-todo-input"><span>할 일</span>
          <input id="personal-todo-input" name="title" maxLength={180} placeholder="할 일을 바로 입력하세요" autoComplete="off" required />
        </label>
        {/* 마감일은 서버에서도 선택 항목이다. 비워 둔 채로 추가되는 것이 정상임을 라벨에서 바로 알린다. */}
        <label className="personal-todo-field" htmlFor="personal-todo-due"><span>마감일 <em>선택</em></span>
          <input id="personal-todo-due" name="dueDate" type="date" title="마감일 · 비워 두어도 됩니다" />
        </label>
        <button type="submit" disabled={saving}><Plus size={16} /> 추가</button>
      </form>
      {error && <p className="personal-todo-error" role="alert">{error}</p>}
      {loading && <div className="personal-todo-loading"><RefreshCw size={17} /> 내 할 일을 정리하는 중입니다</div>}
      {!loading && openItems.length === 0 && <div className="personal-todo-empty"><Check size={22} /><strong>지금 남은 할 일이 없습니다</strong><span>직접 적거나 AI가 배정 업무를 찾아 자동으로 추가합니다.</span></div>}
      {!loading && openItems.length > 0 && <div className="personal-todo-list">{openItems.slice(0, 8).map(todoRow)}</div>}
      {editor && <form className="personal-todo-editor" onSubmit={saveEditor}>
        <input aria-label="할 일 수정" value={editor.title} maxLength={180} onChange={(event) => setEditor((current) => current ? { ...current, title: event.target.value } : current)} required autoFocus />
        <input aria-label="마감일 수정 · 비워 두면 기한 없는 할 일이 됩니다" title="마감일 · 비워 두어도 됩니다" type="date" value={editor.dueDate} onChange={(event) => setEditor((current) => current ? { ...current, dueDate: event.target.value } : current)} />
        <select aria-label="우선순위 수정" value={editor.priority} onChange={(event) => setEditor((current) => current ? { ...current, priority: event.target.value as PersonalTodo['priority'] } : current)}><option value="high">높음</option><option value="normal">보통</option><option value="low">낮음</option></select>
        <button type="submit" disabled={updatingId === editor.id}><Check size={15} /> 저장</button>
        <button type="button" aria-label="수정 취소" onClick={() => setEditor(null)}><X size={15} /></button>
      </form>}
      {completedItems.length > 0 && <div className="personal-todo-completed"><button type="button" aria-expanded={showCompleted} onClick={() => setShowCompleted((value) => !value)}>완료 {completedItems.length}건 <ChevronDown size={15} /></button>{showCompleted && <div className="personal-todo-list">{completedItems.slice(0, 5).map(todoRow)}</div>}</div>}
      <p className="personal-todo-ai-note"><Sparkles size={13} /> {hideWorkItems ? 'AI는 오늘 일지를 근거로 항목을 추가하고, 끝나면 자동 체크합니다.' : 'AI가 나에게 온 업무와 오늘 일지를 여기에 모읍니다. 마감이 지난 것이 맨 위이고, 업무가 끝나면 저절로 체크됩니다.'}</p>
    </div>
  </section>
}

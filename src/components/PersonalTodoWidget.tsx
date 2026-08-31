import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { ArrowRight, Check, ChevronDown, Circle, Pencil, Plus, RefreshCw, Sparkles, Trash2, X } from 'lucide-react'
import { seoulDateInputValue } from '../utils/dateTime'
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

export function PersonalTodoWidget({ workspaceScope, onNavigate, onToast }: {
  workspaceScope?: string
  onNavigate: (page: 'tasks' | 'journal') => void
  onToast: (message: string) => void
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

  const openItems = items.filter((item) => item.status === 'open')
  const completedItems = items.filter((item) => item.status === 'completed')
  const sourcePage = (todo: PersonalTodo) => todo.source?.kind === 'daily-journal' ? 'journal' : 'tasks'

  const todoRow = (todo: PersonalTodo) => <article className={`personal-todo-row${todo.status === 'completed' ? ' is-completed' : ''}${todo.priority === 'high' ? ' is-high' : ''}`} key={todo.id}>
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
      <span>{todo.origin === 'ai' ? <><Sparkles size={12} /> AI 자동</> : '직접 등록'}{todo.dueAt ? ` · ${dueLabel(todo.dueAt)}` : ''}</span>
    </div>
    {todo.source && <button className="personal-todo-source" type="button" title={todo.reason} onClick={() => onNavigate(sourcePage(todo))}>원본 <ArrowRight size={13} /></button>}
    <button className="personal-todo-icon" type="button" aria-label={`${todo.title} 수정`} onClick={() => setEditor({ id: todo.id, title: todo.title, dueDate: dueInputValue(todo.dueAt), priority: todo.priority })}><Pencil size={14} /></button>
    <button className="personal-todo-icon is-danger" type="button" aria-label={`${todo.title} 삭제`} onClick={() => void removeTodo(todo)}><Trash2 size={14} /></button>
  </article>

  return <section className="personal-todo-widget dashboard-section-card" aria-labelledby="personal-todo-title">
    <header className="dashboard-section-header"><div className="dashboard-section-title"><span className="dashboard-section-icon"><Check size={18} /></span><h2 id="personal-todo-title">To Do List</h2></div><Button tone="quiet" type="button" disabled={syncing} onClick={() => void sync(true)}><Sparkles size={15} /> {syncing ? '정리 중' : 'AI 정리'}</Button></header>
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
      <p className="personal-todo-ai-note"><Sparkles size={13} /> AI는 배정 업무와 오늘 일지를 근거로 항목을 추가하고, 원본이 완료되면 자동 체크합니다.</p>
    </div>
  </section>
}

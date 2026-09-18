import { useCallback, useEffect, useState } from 'react'
import { Archive, RotateCcw, Search, X } from 'lucide-react'
import { formatDateLabel } from '../utils/dateTime'
import { Button, IconButton } from './ui/Button'

/**
 * 끝난 업무의 보관함.
 *
 * 진행 중 목록은 1,000건에서 **지우지 않고 거절한다**. 끝난 업무는 매일 새벽 60일이 지나면 여기로 옮겨지고,
 * 관리자는 지금 바로 옮기거나 하나씩 꺼낼 수 있다. 직원은 자기가 담당했거나 지시한 업무만 본다(서버가 거른다).
 * 목록은 한 줄 원칙: 제목 · 담당 · 끝난 날 · (관리자) 꺼내기.
 */
type ArchivedWorkItem = {
  id: string
  title: string
  owner: string
  requestedBy: string
  status: string
  due: string
  review?: { reviewedAt?: string }
  completion?: { submittedAt?: string }
  archivedAt?: string
}

type ArchivePage = { rows: ArchivedWorkItem[]; total: number; offset: number; limit: number; canManage: boolean; archiveAfterDays: number }

const PAGE = 30

export function WorkArchiveDialog({ workspaceScope, onClose, onToast }: {
  workspaceScope?: string
  onClose: () => void
  onToast: (message: string) => void
}) {
  const [query, setQuery] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [rows, setRows] = useState<ArchivedWorkItem[]>([])
  const [total, setTotal] = useState(0)
  const [canManage, setCanManage] = useState(false)
  const [afterDays, setAfterDays] = useState(60)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [busy, setBusy] = useState('')
  const headers = workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined

  const load = useCallback(async (offset: number, search: string) => {
    setState('loading')
    try {
      const params = new URLSearchParams({ offset: String(offset), limit: String(PAGE), q: search })
      const response = await fetch(`/api/work-items/archive?${params}`, { headers })
      const body = await response.json() as ArchivePage & { error?: { message?: string } }
      if (!response.ok) throw new Error(body.error?.message || '보관함을 읽지 못했습니다.')
      setRows((current) => (offset === 0 ? body.rows : [...current, ...body.rows]))
      setTotal(body.total)
      setCanManage(Boolean(body.canManage))
      setAfterDays(body.archiveAfterDays || 60)
      setState('ready')
    } catch (cause) {
      setState('error')
      onToast(cause instanceof Error ? cause.message : '보관함을 읽지 못했습니다.')
    }
  }, [workspaceScope]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void load(0, appliedQuery) }, [appliedQuery, load])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const post = async (url: string, key: string) => {
    setBusy(key)
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(headers ?? {}) }, body: '{}' })
      const body = await response.json().catch(() => ({})) as { archived?: number; remaining?: number; workItem?: { title?: string }; error?: { message?: string } }
      if (!response.ok) throw new Error(body.error?.message || '처리하지 못했습니다.')
      return body
    } finally {
      setBusy('')
    }
  }

  const archiveNow = async () => {
    try {
      const body = await post('/api/work-items/archive', 'archive-now')
      onToast(body.archived ? `끝난 업무 ${body.archived}건을 보관함으로 옮겼습니다. 진행 중 업무는 ${body.remaining}건입니다.` : '옮길 끝난 업무가 없습니다.')
      await load(0, appliedQuery)
    } catch (cause) { onToast(cause instanceof Error ? cause.message : '옮기지 못했습니다.') }
  }

  const restore = async (row: ArchivedWorkItem) => {
    try {
      await post(`/api/work-items/archive/${encodeURIComponent(row.id)}/restore`, row.id)
      onToast(`「${row.title}」을(를) 진행 중 목록으로 꺼냈습니다.`)
      setRows((current) => current.filter((item) => item.id !== row.id))
      setTotal((current) => Math.max(0, current - 1))
    } catch (cause) { onToast(cause instanceof Error ? cause.message : '꺼내지 못했습니다.') }
  }

  const finishedOn = (row: ArchivedWorkItem) => row.review?.reviewedAt || row.completion?.submittedAt || row.due

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
      <section className="modal-card work-archive-modal" role="dialog" aria-modal="true" aria-labelledby="work-archive-title">
        <header>
          <div>
            <span className="eyebrow">ARCHIVE</span>
            <h2 id="work-archive-title"><Archive size={20} aria-hidden="true" /> 업무 보관함</h2>
            <p>끝난 업무는 {afterDays}일이 지나면 매일 새벽 이곳으로 옮겨집니다. 지워지지 않습니다.</p>
          </div>
          <IconButton tone="ghost" type="button" aria-label="닫기" disabled={Boolean(busy)} onClick={onClose}><X size={21} /></IconButton>
        </header>
        <div className="work-archive-body">
          <form className="work-archive-search" role="search" onSubmit={(event) => { event.preventDefault(); setAppliedQuery(query.trim()) }}>
            <label>
              <span className="sr-only">보관된 업무 찾기</span>
              <Search size={17} aria-hidden="true" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="제목·담당자로 찾기" />
            </label>
            <Button tone="secondary" size="sm" type="submit">찾기</Button>
          </form>
          <p className="work-archive-count" aria-live="polite">
            {state === 'loading' && !rows.length ? '불러오는 중…' : `보관된 업무 ${total.toLocaleString('ko-KR')}건${appliedQuery ? ` · 「${appliedQuery}」` : ''}`}
          </p>
          {state === 'ready' && rows.length === 0 && <p className="work-archive-empty">{appliedQuery ? '찾는 업무가 보관함에 없습니다.' : '아직 보관된 업무가 없습니다.'}</p>}
          <ul className="work-archive-list">
            {rows.map((row) => (
              <li key={row.id}>
                <span>
                  <strong>{row.title}</strong>
                  <small>{row.owner} · {finishedOn(row) ? `${formatDateLabel(finishedOn(row), true, false)} 끝남` : '끝난 날 기록 없음'}</small>
                </span>
                {canManage && (
                  <Button tone="quiet" size="sm" type="button" disabled={Boolean(busy)} onClick={() => void restore(row)}>
                    <RotateCcw size={15} aria-hidden="true" /> 꺼내기
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {rows.length < total && (
            <Button tone="ghost" type="button" disabled={state === 'loading'} onClick={() => void load(rows.length, appliedQuery)}>
              {state === 'loading' ? '불러오는 중…' : `더 보기 (남은 ${(total - rows.length).toLocaleString('ko-KR')}건)`}
            </Button>
          )}
        </div>
        {canManage && (
          <footer>
            <Button tone="secondary" type="button" disabled={Boolean(busy)} onClick={() => void archiveNow()}>
              {busy === 'archive-now' ? '옮기는 중…' : '끝난 업무 지금 옮기기'}
            </Button>
          </footer>
        )}
      </section>
    </div>
  )
}

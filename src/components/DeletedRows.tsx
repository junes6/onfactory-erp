import { useEffect, useState } from 'react'
import { History, RotateCcw, X } from 'lucide-react'
import { formatShortDateTime } from '../utils/dateTime'
import { DELETED_ROWS_EVENT, listDeletedRows, restoreDeletedRow, type DeletedRow } from '../utils/deletedRows'
import { Button, IconButton } from './ui/Button'
import './DeletedRows.css'

const daysUntil = (iso: string) => Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000))

/**
 * 대장 머리에 붙는 [지운 항목 N]. 지운 것이 없으면 그리지 않는다.
 * 전에는 대장의 [삭제]가 영구 삭제였고 되살릴 길이 없었다(감사 business-admin-19).
 * `refreshToken`이 바뀌면(보통 목록 길이) 다시 센다.
 */
export function DeletedRowsButton({ storeKey, title, workspaceScope, refreshToken, onRestored, onToast }: {
  storeKey: string
  /** 창 제목에 쓸 대장 이름(예: '계약'). */
  title: string
  workspaceScope?: string
  refreshToken?: unknown
  onRestored: () => void
  onToast: (message: string) => void
}) {
  const [items, setItems] = useState<DeletedRow[]>([])
  const [open, setOpen] = useState(false)
  const [busyId, setBusyId] = useState('')
  const load = async () => {
    try { setItems((await listDeletedRows(storeKey, workspaceScope)).items) } catch { setItems([]) }
  }
  useEffect(() => { void load() }, [storeKey, workspaceScope, refreshToken]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onDeleted = (event: Event) => { if ((event as CustomEvent<{ key?: string }>).detail?.key === storeKey) void load() }
    window.addEventListener(DELETED_ROWS_EVENT, onDeleted)
    return () => window.removeEventListener(DELETED_ROWS_EVENT, onDeleted)
  }, [storeKey, workspaceScope]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const restore = async (item: DeletedRow) => {
    setBusyId(item.id)
    try {
      const restored = await restoreDeletedRow(item.id, workspaceScope)
      onRestored()
      onToast(`‘${restored.label}’을(를) 되살렸습니다.${restored.restoredFiles ? ` 첨부 ${restored.restoredFiles}개도 함께 돌아왔습니다.` : ''}`)
      await load()
    } catch (error) { onToast(error instanceof Error ? error.message : '되살리지 못했습니다.') }
    finally { setBusyId('') }
  }

  if (!items.length) return null
  return <>
    <Button tone="quiet" size="sm" type="button" className="deleted-rows-open" onClick={() => { setOpen(true); void load() }}><History size={15} /> 지운 항목 {items.length}</Button>
    {open && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
      <section className="modal-card deleted-rows-dialog" role="dialog" aria-modal="true" aria-labelledby="deleted-rows-title">
        <header><div><h2 id="deleted-rows-title">지운 {title}</h2><p>지운 지 30일이 지나면 목록에서 사라집니다. 되살리면 첨부 파일도 함께 돌아옵니다.</p></div><IconButton aria-label="닫기" onClick={() => setOpen(false)}><X size={18} /></IconButton></header>
        <ul>{items.map((item) => <li key={item.id}>
          <div><strong>{item.label}</strong><span>{item.deletedByName || '알 수 없는 사람'} · {formatShortDateTime(item.deletedAt)}에 지움 · {daysUntil(item.purgeAt)}일 남음</span></div>
          <Button tone="secondary" size="sm" type="button" disabled={busyId === item.id} onClick={() => void restore(item)}><RotateCcw size={15} /> {busyId === item.id ? '되살리는 중…' : '되살리기'}</Button>
        </li>)}</ul>
      </section>
    </div>}
  </>
}

import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Check, Eye, EyeOff, RotateCcw, Settings2, X } from 'lucide-react'
import './WorkspaceNavigation.css'
import { Button } from './ui/Button'

export type WorkspaceNavSource<Id extends string> = {
  id: Id
  label: string
}

type WorkspaceNavPreference<Id extends string> = {
  id: Id
  label: string
  visible: boolean
}

function normalize<Id extends string>(source: WorkspaceNavSource<Id>[], value: unknown) {
  const saved = Array.isArray(value) ? value : []
  const byId = new Map(saved.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const candidate = item as Partial<WorkspaceNavPreference<Id>>
    return typeof candidate.id === 'string' ? [[candidate.id, candidate] as const] : []
  }))
  const sourceIds = new Set(source.map((item) => item.id))
  const orderedIds = [
    ...saved.flatMap((item) => item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string'
      ? [(item as { id: Id }).id]
      : []).filter((id) => sourceIds.has(id)),
    ...source.map((item) => item.id).filter((id) => !byId.has(id)),
  ]
  return orderedIds.map((id) => {
    const base = source.find((item) => item.id === id)!
    const preference = byId.get(id)
    return {
      id,
      label: typeof preference?.label === 'string' && preference.label.trim() ? preference.label.trim().slice(0, 22) : base.label,
      visible: preference?.visible !== false || id === source[0]?.id,
    }
  })
}

export function usePersonalNavigation<Id extends string>(source: WorkspaceNavSource<Id>[], scope: string) {
  const storageKey = `onfactory-personal-navigation:${scope}`
  const sourceSignature = source.map((item) => `${item.id}:${item.label}`).join('|')
  const sourceSnapshot = useMemo(() => source, [sourceSignature]) // eslint-disable-line react-hooks/exhaustive-deps
  const read = () => {
    try { return normalize(sourceSnapshot, JSON.parse(window.localStorage.getItem(storageKey) ?? 'null')) }
    catch { return normalize(sourceSnapshot, null) }
  }
  const [preferences, setPreferences] = useState<WorkspaceNavPreference<Id>[]>(read)

  useEffect(() => setPreferences(read()), [storageKey, sourceSignature]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    try { window.localStorage.setItem(storageKey, JSON.stringify(preferences)) } catch { /* personal setting is optional */ }
  }, [preferences, storageKey])

  return [preferences, setPreferences] as const
}

function useModalFocus(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    if (!open || !ref.current) return
    const dialog = ref.current
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const selector = 'button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])'
    const focusables = () => Array.from(dialog.querySelectorAll<HTMLElement>(selector))
    window.setTimeout(() => focusables()[0]?.focus(), 0)
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return }
      if (event.key !== 'Tab') return
      const items = focusables()
      if (!items.length) return
      const first = items[0]
      const last = items.at(-1)!
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    dialog.addEventListener('keydown', keydown)
    return () => { dialog.removeEventListener('keydown', keydown); previous?.focus() }
  }, [open])
  return ref
}

export function WorkspaceNavigationEditor<Id extends string>({ open, source, preferences, onChange, onClose }: {
  open: boolean
  source: WorkspaceNavSource<Id>[]
  preferences: WorkspaceNavPreference<Id>[]
  onChange: (value: WorkspaceNavPreference<Id>[]) => void
  onClose: () => void
}) {
  const ref = useModalFocus(open, onClose)
  if (!open) return null
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= preferences.length) return
    const next = [...preferences]
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange(next)
  }
  const update = (id: Id, patch: Partial<WorkspaceNavPreference<Id>>) => onChange(preferences.map((item) => item.id === id ? { ...item, ...patch } : item))
  const reset = () => onChange(source.map((item) => ({ ...item, visible: true })))

  return <div className="workspace-nav-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={ref} className="workspace-nav-editor" role="dialog" aria-modal="true" aria-labelledby="workspace-nav-title">
      <header><div><span>MY WORKSPACE</span><h2 id="workspace-nav-title">왼쪽 메뉴 편집</h2><p>내 계정에서만 메뉴 이름, 표시 여부와 순서를 바꿉니다.</p></div><button type="button" aria-label="닫기" onClick={onClose}><X size={20} /></button></header>
      <div className="workspace-nav-editor-list">
        {preferences.map((item, index) => <article key={item.id}>
          <button type="button" className="workspace-nav-visibility" aria-label={`${item.label} ${item.visible ? '숨기기' : '표시하기'}`} disabled={index === 0} onClick={() => update(item.id, { visible: !item.visible })}>{item.visible ? <Eye size={18} /> : <EyeOff size={18} />}</button>
          <label><span>표시 이름</span><input value={item.label} maxLength={22} onChange={(event) => update(item.id, { label: event.target.value })} /></label>
          <div><button type="button" aria-label={`${item.label} 위로 이동`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={18} /></button><button type="button" aria-label={`${item.label} 아래로 이동`} disabled={index === preferences.length - 1} onClick={() => move(index, 1)}><ArrowDown size={18} /></button></div>
        </article>)}
      </div>
      <footer><Button tone="ghost" type="button" onClick={reset}><RotateCcw size={17} /> 기본값 복원</Button><Button tone="primary" type="button" onClick={onClose}><Check size={18} /> 편집 완료</Button></footer>
    </section>
  </div>
}

export function WorkspaceNavigationEditButton({ onClick }: { onClick: () => void }) {
  return <button className="workspace-nav-edit-button" type="button" onClick={onClick} aria-label="왼쪽 메뉴 편집"><Settings2 size={15} /><span>편집</span></button>
}

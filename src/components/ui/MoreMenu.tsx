import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { Button } from './Button'
import './MoreMenu.css'

/**
 * [더 보기] 메뉴 — 자주 쓰지 않는 행동을 한 곳에 접어 둔다. 머리글 버튼이 여섯 개를 넘으면
 * 사람은 무엇을 먼저 눌러야 할지 모른다(특히 나이 드신 분). 자주 쓰는 두세 개만 밖에 둔다.
 * 키보드: Enter/Space로 열고, 위·아래 화살표로 옮기고, Esc로 닫는다. 바깥을 누르면 닫힌다.
 */
export type MoreMenuItem = { id: string; label: string; icon?: ReactNode; onSelect: () => void; hidden?: boolean; tone?: 'danger' }

export function MoreMenu({ items, label = '더 보기' }: { items: MoreMenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const menuId = useId()
  const visible = items.filter((item) => !item.hidden)

  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false) }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); rootRef.current?.querySelector<HTMLButtonElement>('[aria-haspopup]')?.focus(); return }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const buttons = [...(rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
      if (!buttons.length) return
      event.preventDefault()
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length : (index - 1 + buttons.length) % buttons.length
      buttons[next]?.focus()
    }
    window.addEventListener('mousedown', onPointer)
    window.addEventListener('keydown', onKey)
    window.requestAnimationFrame(() => rootRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus())
    return () => { window.removeEventListener('mousedown', onPointer); window.removeEventListener('keydown', onKey) }
  }, [open])

  if (!visible.length) return null
  return (
    <div className="more-menu" ref={rootRef}>
      <Button tone="ghost" type="button" aria-haspopup="menu" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen((value) => !value)}>
        <MoreHorizontal size={17} aria-hidden="true" /> {label}
      </Button>
      {open && (
        <div className="more-menu-list" role="menu" id={menuId} aria-label={label}>
          {visible.map((item) => (
            <button key={item.id} type="button" role="menuitem" className={`more-menu-item${item.tone === 'danger' ? ' is-danger' : ''}`} onClick={() => { setOpen(false); item.onSelect() }}>
              {item.icon}<span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

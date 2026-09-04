import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, RotateCcw, X } from 'lucide-react'
import { Button } from './Button'

/**
 * 알림 한 줄.
 *
 * 되돌리기 어려운 동작에는 5초짜리 "실행 취소"를 붙인다. "정말 하시겠습니까?"를
 * 먼저 묻는 방식은 대부분 그냥 눌리고, 정작 잘못 눌렀을 때는 아무 도움이 안 된다.
 * 먼저 실행하고 잠깐 물릴 기회를 주는 편이 실제로 더 안전하다.
 *
 * 남은 시간을 눈에 보이게 둔다. 몇 초인지 모르면 되돌릴 수 있다는 것을 알아도
 * 손이 늦는다.
 */

export type ToastUndo = { label?: string; run: () => void | Promise<void> }
export type ToastMessage = { text: string; tone?: 'info' | 'error'; undo?: ToastUndo }

export const UNDO_SECONDS = 5

export default function Toast({ message, onClose }: { message: ToastMessage; onClose: () => void }) {
  const [left, setLeft] = useState(UNDO_SECONDS)
  const [busy, setBusy] = useState(false)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    setLeft(UNDO_SECONDS)
    if (!message.undo) return
    const timer = setInterval(() => {
      setLeft((current) => {
        if (current <= 1) { clearInterval(timer); closeRef.current(); return 0 }
        return current - 1
      })
    }, 1_000)
    return () => clearInterval(timer)
  }, [message])

  return (
    <div className={message.tone === 'error' ? 'toast is-error' : 'toast'} role="status">
      <CheckCircle2 size={19} />
      <span>{message.text}</span>
      {message.undo && (
        <Button
          tone="ghost"
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try { await message.undo?.run() } finally { closeRef.current() }
          }}
        >
          <RotateCcw size={14} /> {message.undo.label ?? '실행 취소'} {left}
        </Button>
      )}
      <button type="button" aria-label="알림 닫기" onClick={onClose}><X size={16} /></button>
    </div>
  )
}

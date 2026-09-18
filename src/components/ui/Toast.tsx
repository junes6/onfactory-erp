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

/**
 * 문자열로만 넘어오는 알림 중 실패를 알리는 것. 화면 60여 곳과 서버 오류 문장이 모두 이 말투다
 * ("…하지 못했습니다", "…할 수 없습니다", "…실패했습니다"). 실패는 저절로 닫지 않고 빨간 줄로 보인다.
 */
const FAILURE_TEXT = /(못했|실패|할 수 없|수 없습니다|오류가)/u
export const toastFromText = (text: string): ToastMessage | null => (text ? { text, tone: FAILURE_TEXT.test(text) ? 'error' : 'info' } : null)
export type ToastMessage = { text: string; tone?: 'info' | 'error'; undo?: ToastUndo }

/**
 * 되돌리기를 누를 수 있는 시간. 5초였다 — 알림을 읽고 손을 옮기기엔 짧았다(나이 든 사용자·휴대폰).
 * 마우스를 올리거나 초점이 들어가 있는 동안은 세지 않는다.
 */
export const UNDO_SECONDS = 10
/**
 * 되돌리기가 없는 알림은 이만큼 뒤 스스로 닫힌다. 전에는 닫기를 누를 때까지 남아
 * 휴대폰에서 화면 아래를 계속 가렸다. 읽는 속도가 느린 사람을 위해 짧게 잡지 않고,
 * 마우스를 올리거나 초점이 들어가 있는 동안은 멈춘다. 오류는 저절로 닫지 않는다 — 읽고 대응해야 한다.
 */
export const AUTO_CLOSE_SECONDS = 7

export default function Toast({ message, onClose }: { message: ToastMessage; onClose: () => void }) {
  const [left, setLeft] = useState(UNDO_SECONDS)
  const [busy, setBusy] = useState(false)
  const [paused, setPaused] = useState(false)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const pausedRef = useRef(false)
  pausedRef.current = paused

  useEffect(() => {
    if (message.undo || message.tone === 'error' || paused) return
    const timer = setTimeout(() => closeRef.current(), AUTO_CLOSE_SECONDS * 1_000)
    return () => clearTimeout(timer)
  }, [message, paused])

  useEffect(() => {
    setLeft(UNDO_SECONDS)
    if (!message.undo) return
    const timer = setInterval(() => {
      setLeft((current) => {
        if (pausedRef.current) return current
        if (current <= 1) { clearInterval(timer); closeRef.current(); return 0 }
        return current - 1
      })
    }, 1_000)
    return () => clearInterval(timer)
  }, [message])

  return (
    <div
      className={message.tone === 'error' ? 'toast is-error' : 'toast'}
      role={message.tone === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
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
      <button type="button" className="toast-close" aria-label="알림 닫기" onClick={onClose}><X size={16} /></button>
    </div>
  )
}

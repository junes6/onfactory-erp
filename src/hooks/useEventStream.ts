import { useEffect, useRef } from 'react'

export type StreamEventKind = 'notification' | 'proposal' | 'work' | 'message' | 'activity' | 'resync'
export type StreamEvent = { kind: StreamEventKind; data: Record<string, unknown> }

/**
 * 서버 이벤트 스트림 구독.
 *
 * 폴링을 대체한다. EventSource가 끊기면 브라우저가 알아서 재연결하고, 그때 Last-Event-ID를
 * 함께 보내므로 끊긴 동안의 변경은 서버가 한 번에 되돌려 준다. 보관분을 넘어선 경우에는
 * 서버가 resync를 보내고, 화면은 전체를 다시 읽는다.
 *
 * onEvent는 매 렌더 새로 만들어져도 되도록 ref에 담아 둔다. 그래야 구독이 재생성되지 않는다.
 */
export function useEventStream(enabled: boolean, onEvent: (event: StreamEvent) => void) {
  const handlerRef = useRef(onEvent)
  handlerRef.current = onEvent

  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || !('EventSource' in window)) return
    let source: EventSource | null = null
    let closed = false

    const kinds: StreamEventKind[] = ['notification', 'proposal', 'work', 'message', 'activity', 'resync']
    const open = () => {
      if (closed) return
      // withCredentials로 세션 쿠키를 함께 보낸다.
      source = new EventSource('/api/events', { withCredentials: true })
      for (const kind of kinds) {
        source.addEventListener(kind, (event) => {
          try { handlerRef.current({ kind, data: JSON.parse((event as MessageEvent).data) }) }
          catch { /* 형식이 깨진 프레임 한 건은 건너뛴다 */ }
        })
      }
      source.onerror = () => {
        // EventSource는 스스로 재연결한다. 서버가 닫아 버린 경우에만 우리가 다시 연다.
        if (closed || source?.readyState !== EventSource.CLOSED) return
        source.close()
        window.setTimeout(open, 3_000)
      }
    }
    open()

    return () => { closed = true; source?.close() }
  }, [enabled])
}

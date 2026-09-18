import { useEffect, useRef, useState } from 'react'
import { ExternalLink, X } from 'lucide-react'
import { Button, IconButton } from '../ui/Button'
import { fetchMaterialAsset, fetchMaterialFrame } from './materialsApi'

/**
 * 검토 자료 원본을 **격리된 칸**에 그린다.
 *
 * - `sandbox="allow-scripts"`만 준다: 자료의 스크립트(탭·필터·시안 불러오기)는 돌지만, 출처가 'null'이라
 *   앱의 쿠키·저장소·API에 닿지 못하고 새 창·폼 전송·최상위 이동도 못 한다.
 * - 떼어 둔 그림은 자료가 요청하면(브리지 `itf:asset`) **앱이 대신 받아** 넘긴다. 자료는 앱 주소를 모른다.
 * - 밖으로 나가는 링크는 앱이 먼저 묻는다.
 * 메시지는 이 iframe이 보낸 것만 받는다(`event.source` 확인). 메시지로는 아무것도 저장하지 않는다.
 */
type BridgeMessage =
  | { itf: 'ready'; anchors?: number; width?: number; nativeControls?: number }
  | { itf: 'asset'; sha: string }
  | { itf: 'link'; href: string }
  | { itf: 'visible'; a: string[] }

const SHA = /^[a-f0-9]{64}$/
const MAX_PARALLEL_ASSETS = 6

export function MaterialFrame({ workspaceScope, materialId, version, showNative, focusAnchorId, onVisible, onReady, onError }: {
  workspaceScope?: string
  materialId: string
  version: number
  showNative: boolean
  focusAnchorId?: string | null
  onVisible?: (anchorIds: string[]) => void
  onReady?: (info: { anchors: number; nativeControls: number }) => void
  onError?: (message: string) => void
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const [srcDoc, setSrcDoc] = useState<string | null>(null)
  const [loadError, setLoadError] = useState('')
  const [pendingLink, setPendingLink] = useState('')
  const queueRef = useRef<{ running: number; waiting: string[]; seen: Set<string> }>({ running: 0, waiting: [], seen: new Set() })
  const readyRef = useRef(false)
  const callbacks = useRef({ onVisible, onReady, onError })
  callbacks.current = { onVisible, onReady, onError }

  useEffect(() => {
    let active = true
    setSrcDoc(null)
    setLoadError('')
    readyRef.current = false
    queueRef.current = { running: 0, waiting: [], seen: new Set() }
    fetchMaterialFrame(workspaceScope, materialId, version, { native: showNative })
      .then((text) => { if (active) setSrcDoc(text) })
      .catch((error: unknown) => {
        if (!active) return
        const message = error instanceof Error ? error.message : '자료를 그리지 못했습니다.'
        setLoadError(message)
        callbacks.current.onError?.(message)
      })
    return () => { active = false }
  }, [workspaceScope, materialId, version, showNative])

  useEffect(() => {
    const post = (message: unknown, transfer?: Transferable[]) => {
      // 격리된 칸의 출처는 'null'이라 대상 출처를 적을 수 없다. 받는 창을 이 iframe으로 정확히 지정한다.
      frameRef.current?.contentWindow?.postMessage(message, '*', transfer ?? [])
    }
    const pump = () => {
      const queue = queueRef.current
      while (queue.running < MAX_PARALLEL_ASSETS && queue.waiting.length) {
        const sha = queue.waiting.shift() as string
        queue.running += 1
        fetchMaterialAsset(workspaceScope, materialId, version, sha)
          .then(async ({ mime, bytes }) => {
            if (/^text\/html/i.test(mime)) post({ itf: 'asset-data', sha, mime, text: new TextDecoder('utf-8').decode(bytes) })
            else post({ itf: 'asset-data', sha, mime, buffer: bytes }, [bytes])
          })
          .catch(() => { /* 그림 하나가 없어도 자료는 읽힌다 */ })
          .finally(() => { queue.running -= 1; pump() })
      }
    }
    const onMessage = (event: MessageEvent) => {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return
      const data = event.data as BridgeMessage | null
      if (!data || typeof data !== 'object' || typeof (data as { itf?: unknown }).itf !== 'string') return
      if (data.itf === 'asset') {
        if (!SHA.test(String(data.sha)) || queueRef.current.seen.has(data.sha)) return
        queueRef.current.seen.add(data.sha)
        queueRef.current.waiting.push(data.sha)
        pump()
      } else if (data.itf === 'link') {
        const href = String(data.href ?? '')
        if (/^(https?:|mailto:|tel:)/i.test(href)) setPendingLink(href.slice(0, 2_000))
      } else if (data.itf === 'visible') {
        if (Array.isArray(data.a)) callbacks.current.onVisible?.(data.a.filter((id) => typeof id === 'string').slice(0, 12))
      } else if (data.itf === 'ready') {
        readyRef.current = true
        const frame = frameRef.current
        // 넓은 화면용으로 만든 자료가 좁은 칸에 들어오면 칸에 맞춰 줄인다(가로 스크롤 대신).
        const designWidth = Number(data.width ?? 0)
        if (frame && designWidth > frame.clientWidth + 8) post({ itf: 'zoom', factor: Math.max(0.45, frame.clientWidth / designWidth) })
        callbacks.current.onReady?.({ anchors: Number(data.anchors ?? 0), nativeControls: Number(data.nativeControls ?? 0) })
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [workspaceScope, materialId, version])

  useEffect(() => {
    if (!focusAnchorId || !readyRef.current) return
    frameRef.current?.contentWindow?.postMessage({ itf: 'scroll', a: focusAnchorId, smooth: true }, '*')
  }, [focusAnchorId])

  return (
    <div className="material-frame-wrap">
      {loadError ? <p className="material-error" role="alert">{loadError}</p> : !srcDoc ? <p className="material-loading" aria-live="polite">자료를 여는 중입니다…</p> : null}
      {srcDoc && (
        <iframe
          ref={frameRef}
          className="material-frame"
          title="검토 자료 원본"
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={srcDoc}
        />
      )}
      {pendingLink && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPendingLink('') }}>
          <section className="modal-card material-link-modal" role="dialog" aria-modal="true" aria-labelledby="material-link-title">
            <header>
              <div><h2 id="material-link-title">외부 사이트를 열까요?</h2><p>자료 안의 링크가 앱 밖의 주소로 연결됩니다. 새 창에서 열립니다.</p></div>
              <IconButton tone="ghost" type="button" aria-label="닫기" onClick={() => setPendingLink('')}><X size={21} /></IconButton>
            </header>
            <p className="material-link-address">{pendingLink}</p>
            <footer>
              <Button tone="ghost" type="button" onClick={() => setPendingLink('')}>열지 않기</Button>
              <Button tone="primary" type="button" onClick={() => { window.open(pendingLink, '_blank', 'noopener,noreferrer'); setPendingLink('') }}><ExternalLink size={17} aria-hidden="true" /> 새 창에서 열기</Button>
            </footer>
          </section>
        </div>
      )}
    </div>
  )
}

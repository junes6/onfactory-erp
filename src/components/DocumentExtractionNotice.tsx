import { Bot, RefreshCw } from 'lucide-react'
import './DocumentExtractionNotice.css'

export type DocumentExtractionState = {
  status: 'idle' | 'extracting' | 'ready' | 'failed'
  sourceId?: string
  sourceName?: string
  appliedFields?: number
  confidence?: number | null
  warnings?: string[]
  message?: string
}

export function DocumentExtractionNotice({ state, disabled, onRetry }: { state: DocumentExtractionState; disabled?: boolean; onRetry?: () => void }) {
  if (state.status === 'idle') return null
  const ready = state.status === 'ready'
  const title = state.status === 'extracting'
    ? 'AI가 문서를 읽는 중입니다'
    : ready
      ? 'AI가 빈 입력칸에 임시 입력했습니다'
      : '파일은 보관했고, 직접 입력할 수 있습니다'
  const detail = state.status === 'extracting'
    ? `${state.sourceName ?? '선택한 파일'}에서 번호·기관·날짜를 확인하고 있습니다.`
    : ready
      ? `${state.appliedFields ?? 0}개 항목을 채웠습니다${typeof state.confidence === 'number' ? ` · 문서 판독 신뢰도 ${Math.round(state.confidence * 100)}%` : ''}. 원본과 비교해 확인한 뒤 저장하세요.`
      : state.message ?? 'AI 문서 읽기에 실패했지만 원본 파일은 그대로 보관했습니다.'
  return <section className={`document-extraction-notice is-${state.status}`} role="status" aria-live="polite">
    <Bot size={19} />
    <div><strong>{title}</strong><p>{detail}</p>{ready && Boolean(state.warnings?.length) && <ul>{state.warnings!.map((warning) => <li key={warning}>{warning}</li>)}</ul>}</div>
    {state.status !== 'extracting' && onRetry && <button className="text-button" type="button" disabled={disabled} onClick={onRetry}><RefreshCw size={15} /> 다시 읽기</button>}
  </section>
}

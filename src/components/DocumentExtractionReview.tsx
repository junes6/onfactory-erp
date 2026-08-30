import { useEffect, useState } from 'react'
import { Bot, Check, Quote, RefreshCw } from 'lucide-react'
import { DOCUMENT_EXTRACTION_FIELDS, type DocumentDraft, type ExtractionKind } from '../utils/documentExtraction'
import './DocumentExtractionReview.css'
import { Button } from './ui/Button'

export type DocumentExtractionState =
  | { status: 'idle'; sourceId?: undefined; sourceName?: undefined }
  | { status: 'extracting'; sourceId: string; sourceName: string }
  | { status: 'review'; sourceId: string; sourceName: string; draft: DocumentDraft }
  | { status: 'applied'; sourceId: string; sourceName: string; appliedFields: number; confidence: number | null; warnings: string[] }
  | { status: 'failed'; sourceId?: string; sourceName?: string; message: string }

/**
 * 판독 결과 확인 화면. 값은 자동 확정하지 않고 원문 근거와 나란히 보여 준 뒤,
 * 사람이 고치거나 항목을 빼고 승인해야 폼에 들어간다.
 */
export function DocumentExtractionReview({ kind, state, disabled, onApprove, onDismiss, onRetry }: {
  kind: ExtractionKind
  state: DocumentExtractionState
  disabled?: boolean
  onApprove: (values: Record<string, string>) => void
  onDismiss: () => void
  onRetry?: () => void
}) {
  const reviewing = state.status === 'review' ? state : null
  const [values, setValues] = useState<Record<string, string>>({})
  const [excluded, setExcluded] = useState<Record<string, boolean>>({})
  useEffect(() => {
    if (!reviewing) return
    setValues(Object.fromEntries(Object.entries(reviewing.draft.fields).map(([name, field]) => [name, field.value])))
    setExcluded({})
  }, [reviewing?.sourceId, reviewing?.draft])

  if (state.status === 'idle') return null

  if (state.status === 'extracting') {
    return <section className="extraction-panel is-working" role="status" aria-live="polite">
      <Bot size={19} />
      <div><strong>업로드한 문서를 읽는 중입니다</strong><p>{state.sourceName}에서 명칭·번호·발급일·만료일을 찾고 있습니다.</p></div>
    </section>
  }

  if (state.status === 'failed') {
    return <section className="extraction-panel is-failed" role="status" aria-live="polite">
      <Bot size={19} />
      <div><strong>파일은 보관했고, 아래에서 직접 입력할 수 있습니다</strong><p>{state.message}</p></div>
      {onRetry && <Button tone="ghost" type="button" disabled={disabled} onClick={onRetry}><RefreshCw size={15} /> 다시 읽기</Button>}
    </section>
  }

  if (state.status === 'applied') {
    return <section className="extraction-panel is-applied" role="status" aria-live="polite">
      <Check size={19} />
      <div>
        <strong>확인한 {state.appliedFields}개 항목을 입력했습니다</strong>
        <p>{state.sourceName} 기준{typeof state.confidence === 'number' ? ` · 문서 판독 신뢰도 ${Math.round(state.confidence * 100)}%` : ''}. 저장 전에 아래 내용을 마지막으로 확인하세요.</p>
        {state.warnings.length > 0 && <ul>{state.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
      </div>
      {onRetry && <Button tone="ghost" type="button" disabled={disabled} onClick={onRetry}><RefreshCw size={15} /> 다시 읽기</Button>}
    </section>
  }

  const specs = DOCUMENT_EXTRACTION_FIELDS[kind].filter((spec) => reviewing!.draft.fields[spec.name])
  const approve = () => {
    onApprove(Object.fromEntries(specs
      .filter((spec) => !excluded[spec.name] && (values[spec.name] ?? '').trim())
      .map((spec) => [spec.name, (values[spec.name] ?? '').trim()])))
  }
  const acceptedCount = specs.filter((spec) => !excluded[spec.name] && (values[spec.name] ?? '').trim()).length

  return <section className="extraction-review" aria-labelledby="extraction-review-title">
    <header>
      <Bot size={19} />
      <div>
        <strong id="extraction-review-title">문서에서 읽은 값을 확인해 주세요</strong>
        <p>{reviewing!.sourceName}에서 {specs.length}개 항목을 찾았습니다{typeof reviewing!.draft.confidence === 'number' ? ` · 판독 신뢰도 ${Math.round(reviewing!.draft.confidence * 100)}%` : ''}. 원문과 다르면 바로 고치고, 필요 없는 항목은 빼세요.</p>
      </div>
    </header>
    {reviewing!.draft.warnings.length > 0 && <ul className="extraction-warnings">{reviewing!.draft.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
    <ol className="extraction-field-list">
      {specs.map((spec) => {
        const field = reviewing!.draft.fields[spec.name]
        const off = Boolean(excluded[spec.name])
        return <li key={spec.name} className={off ? 'is-excluded' : ''}>
          <label>
            <span>{spec.label}</span>
            {spec.type === 'enum'
              ? <select value={values[spec.name] ?? ''} disabled={off || disabled} onChange={(event) => setValues((current) => ({ ...current, [spec.name]: event.target.value }))}>
                {(spec.values ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
              : <input
                type={spec.type === 'date' ? 'date' : spec.type === 'amount' ? 'number' : 'text'}
                value={values[spec.name] ?? ''}
                disabled={off || disabled}
                onChange={(event) => setValues((current) => ({ ...current, [spec.name]: event.target.value }))}
              />}
          </label>
          <p className="extraction-evidence"><Quote size={12} /> <span>{field.evidence}</span></p>
          <button type="button" className="extraction-exclude" aria-pressed={off} disabled={disabled} onClick={() => setExcluded((current) => ({ ...current, [spec.name]: !current[spec.name] }))}>{off ? '다시 사용' : '이 항목 빼기'}</button>
        </li>
      })}
    </ol>
    <footer>
      <Button tone="ghost" type="button" disabled={disabled} onClick={onDismiss}>직접 입력할게요</Button>
      <Button tone="primary" type="button" disabled={disabled || acceptedCount === 0} onClick={approve}><Check size={17} /> 확인한 {acceptedCount}개 입력하기</Button>
    </footer>
  </section>
}

import { useEffect, useState, type ReactNode } from 'react'
import { ClipboardCheck, HelpCircle, MessageSquareOff, Scale, Sparkles, X } from 'lucide-react'
import { formatDateTime } from '../../utils/dateTime'
import { Button, IconButton } from '../ui/Button'
import { STANCE_LABELS, fetchOverview, type AiOutput, type MaterialDetail, type Overview } from './materialsApi'

/**
 * 정리 — 회의 준비표(규칙, AI 없이)와 항목별 AI 정리(초안).
 * AI의 정리는 **초안**이다. 근거 의견 수를 함께 보이고, 결정은 사람이 [이대로 결정]을 눌러야 된다.
 */
export function OverviewDialog({ workspaceScope, material, onClose, onPick, onToast }: {
  workspaceScope?: string
  material: MaterialDetail
  onClose: () => void
  onPick: (lineageId: string) => void
  onToast: (message: string) => void
}) {
  const [overview, setOverview] = useState<Overview | null>(null)
  useEffect(() => {
    let active = true
    fetchOverview(workspaceScope, material.id).then((body) => { if (active) setOverview(body) }).catch((cause: unknown) => onToast(cause instanceof Error ? cause.message : '회의 준비표를 만들지 못했습니다.'))
    return () => { active = false }
  }, [workspaceScope, material.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const pick = (lineageId: string) => { onPick(lineageId); onClose() }
  const section = (title: string, icon: ReactNode, hint: string, rows: Array<{ lineageId: string; key: string; title: string; extra?: string }>) => (
    <section className="material-overview-section">
      <h3>{icon} {title} <small>{rows.length}</small></h3>
      <p>{hint}</p>
      {rows.length ? (
        <ul>
          {rows.map((row, index) => (
            <li key={`${row.lineageId}:${index}`}>
              <button type="button" className="material-overview-row" onClick={() => pick(row.lineageId)}>
                <strong>{row.title}</strong>{row.extra && <small>{row.extra}</small>}
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="material-overview-empty">없습니다.</p>}
    </section>
  )
  const tally = (stances: Record<string, number>) => Object.entries(stances).filter(([, count]) => count > 0).map(([stance, count]) => `${STANCE_LABELS[stance as keyof typeof STANCE_LABELS]} ${count}`).join(' · ')
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="modal-card material-dialog is-wide" role="dialog" aria-modal="true" aria-labelledby="material-overview-title">
        <header>
          <div>
            <span className="eyebrow">MEETING PREP</span>
            <h2 id="material-overview-title">회의 준비</h2>
            <p>회의에서 먼저 이야기할 것을 모았습니다. 이 표는 AI가 아니라 <strong>찬반·의견을 세는 규칙</strong>으로 만듭니다. 항목을 누르면 그 자리로 갑니다.</p>
          </div>
          <IconButton tone="ghost" type="button" aria-label="닫기" onClick={onClose}><X size={21} /></IconButton>
        </header>
        <div className="material-dialog-body">
          {!overview ? <p className="material-loading">만드는 중입니다…</p> : (
            <div className="material-overview">
              {section('의견이 갈린 항목', <Scale size={18} aria-hidden="true" />, '찬성과 반대(또는 수정 요청)가 함께 있습니다. 회의에서 먼저 다룰 쟁점입니다.', overview.split.map((row) => ({ ...row, extra: tally(row.stances) })))}
              {section('답이 없는 질문', <HelpCircle size={18} aria-hidden="true" />, '질문으로 남겼는데 아직 답글이 없습니다.', overview.openQuestions.map((row) => ({ ...row, extra: `${row.authorName}: ${row.body}` })))}
              {section('결정 준비된 항목', <ClipboardCheck size={18} aria-hidden="true" />, '반응이 한쪽으로 모인 항목입니다. 괄호 안은 규칙이 고른 제안일 뿐, 결정은 결정권자가 합니다.', overview.ready.map((row) => ({ ...row, extra: `(규칙 제안: ${row.suggestion}) ${tally(row.stances)}` })))}
              {section('아무도 반응하지 않은 결정 항목', <MessageSquareOff size={18} aria-hidden="true" />, '검토 요청을 다시 보내거나 회의에서 짚어 주세요.', overview.silent)}
            </div>
          )}
        </div>
        <footer><Button tone="primary" type="button" onClick={onClose}>닫기</Button></footer>
      </section>
    </div>
  )
}

export function AiDraftCard({ aiOutput, canRun, canDecide, readOnly, busy, onRun, onAdopt }: {
  aiOutput: AiOutput | null
  canRun: boolean
  canDecide: boolean
  readOnly: boolean
  busy: boolean
  onRun: () => void
  onAdopt: (draft: AiOutput) => void
}) {
  if (!aiOutput && !canRun) return null
  return (
    <div className="material-ai">
      <div className="material-ai-head">
        <Sparkles size={16} aria-hidden="true" />
        <strong>AI 정리</strong>
        <span className="material-ai-badge">초안</span>
        {aiOutput && <small>{aiOutput.runByName}님이 실행 · {formatDateTime(aiOutput.createdAt)}</small>}
        {canRun && !readOnly && <Button tone="quiet" size="sm" type="button" disabled={busy} onClick={onRun}>{busy ? '정리하는 중…' : aiOutput ? '다시 정리' : 'AI로 정리'}</Button>}
      </div>
      {aiOutput && (
        <>
          {aiOutput.output.summary && <p className="material-ai-summary">{aiOutput.output.summary}</p>}
          {aiOutput.output.positions.map((position) => (
            <div key={position.stance} className="material-ai-position">
              <em className={`stance-dot is-${position.stance}`}>{STANCE_LABELS[position.stance]}</em>
              <ul>{position.points.map((point, index) => <li key={index}>{point.text} <small>(근거 의견 {point.feedbackIds.length}개)</small></li>)}</ul>
            </div>
          ))}
          {aiOutput.output.questions.length > 0 && (
            <div className="material-ai-position"><em>남은 질문</em><ul>{aiOutput.output.questions.map((question, index) => <li key={index}>{question.text}</li>)}</ul></div>
          )}
          {aiOutput.output.draftDecision && (
            <div className="material-ai-draft">
              <span>결정 초안: <strong>{aiOutput.output.draftDecision.status}</strong>{aiOutput.output.draftDecision.note ? ` — ${aiOutput.output.draftDecision.note}` : ''}</span>
              {canDecide && !readOnly && <Button tone="secondary" size="sm" type="button" onClick={() => onAdopt(aiOutput)}>이대로 결정</Button>}
            </div>
          )}
          {aiOutput.output.dropped > 0 && <p className="material-ai-note">근거를 대지 못한 문장 {aiOutput.output.dropped}개는 버렸습니다.</p>}
        </>
      )}
    </div>
  )
}

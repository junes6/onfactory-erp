import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { BookOpen, Check, HelpCircle, Lightbulb, RefreshCw, ScrollText, Trash2 } from 'lucide-react'
import { formatDateLabel, formatShortDateTime } from '../utils/dateTime'
import { StatusBadge, type StatusBadgeTone } from './StatusBadge'
import { Button, IconButton } from './ui/Button'
import './PersonalCorePage.css'

/**
 * 내 판단 기록 — 계정 소유 계층. 이 화면의 모든 데이터는 로그인한 계정의 것이며
 * 서버가 소유자를 세션에서만 읽으므로 다른 계정의 기록은 조회 자체가 되지 않는다.
 */
type PrincipleState = 'active' | 'review-due' | 'expired' | 'retired'
type Principle = {
  id: string
  statement: string
  kind: string
  confidence: number | null
  evidence: { proposalId: string; summary: string; decidedAt: string; tenantId: string }[]
  confirmedAt: string
  expiresAt: string
  status: 'active' | 'retired'
  state: PrincipleState
}
type PersonalNote = { id: string; body: string; topic: string; source: string; gapId: string; createdAt: string }
type Correction = { id: string; proposalId: string; kind: string; reason: string; createdAt: string }
type KnowledgeGap = { id: string; question: string; topic: string; reference: string; confidence: number | null; status: 'open' | 'resolved'; seenCount: number; createdAt: string }
type PersonalCore = { principles: Principle[]; notes: PersonalNote[]; corrections: Correction[]; gaps: KnowledgeGap[]; settings: { confidenceThreshold: number } }

const STATE_META: Record<PrincipleState, { label: string; tone: StatusBadgeTone }> = {
  active: { label: '적용 중', tone: 'success' },
  'review-due': { label: '재검토 필요', tone: 'warning' },
  expired: { label: '기간 만료', tone: 'danger' },
  retired: { label: '폐기', tone: 'neutral' },
}

export function PersonalCorePage({ workspaceScope, onToast }: { workspaceScope?: string; onToast: (message: string) => void }) {
  const [core, setCore] = useState<PersonalCore | null>(null)
  const [loading, setLoading] = useState(true)
  const [answering, setAnswering] = useState<string | null>(null)
  const [answer, setAnswer] = useState('')
  const [noteDraft, setNoteDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const headers = workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/personal/core', { headers })
      if (!response.ok) throw new Error('내 판단 기록을 불러오지 못했습니다.')
      setCore(await response.json() as PersonalCore)
    } catch (error) { onToast(error instanceof Error ? error.message : '내 판단 기록을 불러오지 못했습니다.') }
    finally { setLoading(false) }
  }, [workspaceScope]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load() }, [load])

  const post = async (url: string, body: unknown, method = 'POST') => {
    const response = await fetch(url, { method, headers: { 'content-type': 'application/json', ...(headers ?? {}) }, body: JSON.stringify(body) })
    const payload = await response.json() as { core?: PersonalCore; error?: { message?: string } }
    if (!response.ok) throw new Error(payload.error?.message || '저장하지 못했습니다.')
    if (payload.core) setCore(payload.core)
    else await load()
  }

  const teachNow = async (gapId: string) => {
    if (!answer.trim()) return
    setBusy(true)
    try {
      await post('/api/personal/notes', { body: answer, gapId, source: 'gap-answer' })
      setAnswering(null)
      setAnswer('')
      onToast('알려주신 내용을 기록했습니다. 다음 답변부터 참고합니다.')
    } catch (error) { onToast(error instanceof Error ? error.message : '저장하지 못했습니다.') }
    finally { setBusy(false) }
  }

  const addNote = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!noteDraft.trim()) return
    setBusy(true)
    try {
      await post('/api/personal/notes', { body: noteDraft })
      setNoteDraft('')
      onToast('메모를 저장했습니다.')
    } catch (error) { onToast(error instanceof Error ? error.message : '저장하지 못했습니다.') }
    finally { setBusy(false) }
  }

  const changePrinciple = async (id: string, action: 'retire' | 'renew') => {
    setBusy(true)
    try {
      await post(`/api/personal/principles/${encodeURIComponent(id)}`, { action }, 'PATCH')
      onToast(action === 'retire' ? '규범을 폐기했습니다. 이력은 그대로 남습니다.' : '규범을 다시 확정했습니다.')
    } catch (error) { onToast(error instanceof Error ? error.message : '저장하지 못했습니다.') }
    finally { setBusy(false) }
  }

  const saveThreshold = async (value: number) => {
    setBusy(true)
    try {
      await post('/api/personal/settings', { settings: { confidenceThreshold: value / 100 } }, 'PUT')
      onToast(`확신도 기준을 ${value}%로 바꿨습니다.`)
    } catch (error) { onToast(error instanceof Error ? error.message : '저장하지 못했습니다.') }
    finally { setBusy(false) }
  }

  if (loading && !core) return <div className="content-page"><div className="empty-state compact"><RefreshCw size={22} /><h3>내 판단 기록을 불러오는 중</h3></div></div>
  if (!core) return null

  const openGaps = core.gaps.filter((gap) => gap.status === 'open')
  const activePrinciples = core.principles.filter((item) => item.state !== 'retired')
  const retired = core.principles.filter((item) => item.state === 'retired')

  return <div className="content-page personal-core-page">
    <header className="page-header">
      <div>
        <span className="eyebrow">MY JUDGEMENT</span>
        <h1>내 판단 기록</h1>
        <p>내가 내린 결정에서 만들어진 규범과, AI가 아직 모르는 것을 모아 둡니다. 이 기록은 내 계정의 것이며 다른 사람에게는 보이지 않습니다.</p>
      </div>
    </header>

    <section className="panel personal-core-section" aria-labelledby="personal-principles-title">
      <header className="personal-core-head">
        <div><BookOpen size={18} /><div><h2 id="personal-principles-title">규범 카드 {activePrinciples.length}장</h2><span>같은 방향으로 세 번 이상 고친 결정이 규범 후보가 되고, 승인 큐에서 확정합니다.</span></div></div>
      </header>
      {activePrinciples.length === 0
        ? <p className="personal-core-empty">아직 확정된 규범이 없습니다. 승인 큐에서 제안을 같은 방향으로 세 번 고치면 규범 후보가 올라옵니다.</p>
        : <ul className="principle-list">{activePrinciples.map((principle) => <li key={principle.id}>
          <div className="principle-head">
            <StatusBadge dot tone={STATE_META[principle.state].tone}>{STATE_META[principle.state].label}</StatusBadge>
            <strong>{principle.statement}</strong>
          </div>
          <small>
            확정 {formatDateLabel(principle.confirmedAt, true, false)} · 유효기간 {formatDateLabel(principle.expiresAt, true, false)}까지
            {typeof principle.confidence === 'number' ? ` · 신뢰도 ${Math.round(principle.confidence * 100)}%` : ''}
          </small>
          {principle.evidence.length > 0 && <details className="principle-evidence">
            <summary>근거 결정 {principle.evidence.length}건</summary>
            <ul>{principle.evidence.map((entry) => <li key={entry.proposalId}><span>{formatDateLabel(entry.decidedAt, true, false)}</span> {entry.summary}</li>)}</ul>
          </details>}
          <div className="principle-actions">
            {principle.state === 'review-due' || principle.state === 'expired'
              ? <Button tone="secondary" size="sm" disabled={busy} onClick={() => void changePrinciple(principle.id, 'renew')}><Check size={14} /> 다시 확정</Button>
              : null}
            <Button tone="ghost" size="sm" disabled={busy} onClick={() => void changePrinciple(principle.id, 'retire')}>폐기</Button>
          </div>
        </li>)}</ul>}
      {retired.length > 0 && <details className="personal-core-retired"><summary>폐기한 규범 {retired.length}장 (이력 보존)</summary>
        <ul>{retired.map((item) => <li key={item.id}>{item.statement}</li>)}</ul>
      </details>}
    </section>

    <section className="panel personal-core-section" aria-labelledby="personal-gaps-title">
      <header className="personal-core-head">
        <div><HelpCircle size={18} /><div><h2 id="personal-gaps-title">AI가 모르는 것 {openGaps.length}건</h2><span>확신도가 기준({Math.round(core.settings.confidenceThreshold * 100)}%)보다 낮아 추측하지 않고 남겨 둔 질문입니다.</span></div></div>
        <label className="personal-core-threshold">
          <span>확신도 기준</span>
          <input
            type="range" min="0" max="100" step="5"
            defaultValue={Math.round(core.settings.confidenceThreshold * 100)}
            disabled={busy}
            onMouseUp={(event) => void saveThreshold(Number((event.target as HTMLInputElement).value))}
            onTouchEnd={(event) => void saveThreshold(Number((event.target as HTMLInputElement).value))}
          />
        </label>
      </header>
      {openGaps.length === 0
        ? <p className="personal-core-empty">지금은 AI가 막힌 지점이 없습니다.</p>
        : <ul className="gap-list">{openGaps.map((gap) => <li key={gap.id}>
          <div>
            <strong>{gap.question}</strong>
            <small>{[gap.topic, gap.reference, gap.seenCount > 1 ? `${gap.seenCount}번 반복` : '', formatShortDateTime(gap.createdAt)].filter(Boolean).join(' · ')}</small>
          </div>
          {answering === gap.id
            ? <div className="gap-answer">
              <input value={answer} maxLength={1000} autoFocus placeholder="한 줄로 알려주세요" onChange={(event) => setAnswer(event.target.value)} />
              <Button tone="primary" size="sm" disabled={busy || !answer.trim()} onClick={() => void teachNow(gap.id)}>저장</Button>
              <Button tone="ghost" size="sm" onClick={() => { setAnswering(null); setAnswer('') }}>취소</Button>
            </div>
            : <Button tone="secondary" size="sm" onClick={() => { setAnswering(gap.id); setAnswer('') }}><Lightbulb size={14} /> 지금 알려주기</Button>}
        </li>)}</ul>}
    </section>

    <section className="panel personal-core-section" aria-labelledby="personal-notes-title">
      <header className="personal-core-head">
        <div><ScrollText size={18} /><div><h2 id="personal-notes-title">내 메모 {core.notes.length}개</h2><span>여기 적은 내용은 이후 AI 답변에 컨텍스트로 들어갑니다.</span></div></div>
      </header>
      <form className="note-form" onSubmit={addNote}>
        <input value={noteDraft} maxLength={1000} placeholder="예: 급식 납품 견적은 항상 마감 3일 전까지 회신한다" onChange={(event) => setNoteDraft(event.target.value)} />
        <Button tone="primary" size="sm" type="submit" disabled={busy || !noteDraft.trim()}>추가</Button>
      </form>
      {core.notes.length > 0 && <ul className="note-list">{core.notes.map((note) => <li key={note.id}>
        <div><strong>{note.body}</strong><small>{formatShortDateTime(note.createdAt)}{note.source === 'gap-answer' ? ' · AI 질문에 답함' : ''}</small></div>
        <IconButton tone="danger" size="sm" aria-label="메모 삭제" disabled={busy} onClick={async () => {
          try { await post(`/api/personal/notes/${encodeURIComponent(note.id)}`, {}, 'DELETE'); onToast('메모를 지웠습니다.') }
          catch (error) { onToast(error instanceof Error ? error.message : '지우지 못했습니다.') }
        }}><Trash2 size={14} /></IconButton>
      </li>)}</ul>}
    </section>

    {core.corrections.length > 0 && <section className="panel personal-core-section" aria-labelledby="personal-corrections-title">
      <header className="personal-core-head"><div><RefreshCw size={18} /><div><h2 id="personal-corrections-title">교정 이력 {core.corrections.length}건</h2><span>승인 큐에서 제안을 고칠 때 남긴 이유입니다. 규범 후보의 1순위 근거로 씁니다.</span></div></div></header>
      <ul className="correction-list">{core.corrections.slice(0, 10).map((correction) => <li key={correction.id}>
        <strong>{correction.reason || '이유를 적지 않은 수정'}</strong>
        <small>{formatShortDateTime(correction.createdAt)}</small>
      </li>)}</ul>
    </section>}
  </div>
}

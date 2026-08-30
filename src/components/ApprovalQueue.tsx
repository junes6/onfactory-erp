import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ClipboardCheck, FileText, Keyboard, MessageCircle, Pencil, Radar, RefreshCw, ShieldAlert, Sparkles, X } from 'lucide-react'
import { formatDateTime } from '../utils/dateTime'
import { StatusBadge, type StatusBadgeTone } from './StatusBadge'
import './ApprovalQueue.css'
import { Button, IconButton } from './ui/Button'
import { OpportunityWatch } from './OpportunityWatch'

type ProposalKind = 'document-classification' | 'task-from-message' | 'sentinel-task' | 'lens-task' | 'opportunity'
type ProposalStatus = 'pending' | 'approved' | 'edited' | 'rejected' | 'expired'

type Proposal = {
  id: string
  kind: ProposalKind
  status: ProposalStatus
  confidence: number | null
  sourceKey: string
  summary: string
  evidence: string
  payload: Record<string, unknown>
  createdAt: string
  createdBy: string
  decidedAt?: string
  decidedByName?: string
  decisionDiff?: Record<string, { before: unknown; after: unknown }> | null
  comment?: string
  resultRef?: { type: 'work-item' | 'document'; id: string } | null
}

type PolicyStat = { kind: ProposalKind; approved: number; edited: number; rejected: number; total: number; approvalRate: number | null; windowDays: number }

type QueueResponse = { proposals: Proposal[]; stats: PolicyStat[]; pendingCount: number; windowDays: number }

const kindMeta: Record<ProposalKind, { label: string; tone: StatusBadgeTone; icon: typeof FileText }> = {
  'document-classification': { label: '문서 분류', tone: 'info', icon: FileText },
  'task-from-message': { label: '업무 제안', tone: 'success', icon: MessageCircle },
  'sentinel-task': { label: '생존 센티널', tone: 'warning', icon: ShieldAlert },
  'lens-task': { label: '문서 렌즈', tone: 'info', icon: Sparkles },
  opportunity: { label: '외부 기회', tone: 'success', icon: Radar },
}

function confidenceLabel(value: number | null) {
  if (value === null || !Number.isFinite(value)) return null
  const percent = Math.round(value * 100)
  return { text: `확신도 ${percent}%${value >= .85 ? ' · 높음' : ''}`, high: value >= .85 }
}

export function ApprovalQueue({ workspaceScope, onToast, onOpenTask, onPendingChange }: {
  workspaceScope?: string
  onToast: (message: string) => void
  onOpenTask: (taskId: string) => void
  onPendingChange?: (count: number) => void
}) {
  const [data, setData] = useState<QueueResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<'pending' | 'all'>('pending')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editing, setEditing] = useState<Proposal | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const headers = useMemo(() => (workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined), [workspaceScope])

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError('')
    try {
      const response = await fetch('/api/proposals', { headers })
      const body = await response.json() as QueueResponse & { error?: { message?: string } }
      if (!response.ok) throw new Error(body.error?.message || 'AI 제안을 불러오지 못했습니다.')
      setData(body)
      onPendingChange?.(body.pendingCount)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'AI 제안을 불러오지 못했습니다.')
    } finally {
      setLoading(false)
    }
  }, [headers, onPendingChange])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const timer = window.setInterval(() => { void load(true) }, 30_000)
    return () => window.clearInterval(timer)
  }, [load])

  const visible = useMemo(() => (data?.proposals ?? []).filter((item) => filter === 'all' || item.status === 'pending'), [data, filter])
  const selected = visible.find((item) => item.id === selectedId) ?? visible[0] ?? null

  const decide = useCallback(async (proposal: Proposal, decision: 'approve' | 'edit' | 'reject', payload?: Record<string, unknown>, reason?: string) => {
    if (busyId) return
    setBusyId(proposal.id)
    try {
      const response = await fetch(`/api/proposals/${encodeURIComponent(proposal.id)}/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(headers ?? {}) },
        body: JSON.stringify({ decision, payload, reason }),
      })
      const body = await response.json() as { proposal?: Proposal; resultRef?: Proposal['resultRef']; pendingCount?: number; error?: { message?: string } }
      if (!response.ok || !body.proposal) throw new Error(body.error?.message || '결정을 저장하지 못했습니다.')
      onToast(decision === 'reject' ? '제안을 거절했습니다.' : decision === 'edit' ? '수정한 내용으로 승인해 실행했습니다.' : body.resultRef?.type === 'work-item' ? '승인 — 업무를 생성했습니다.' : '승인 — 문서 분류를 반영했습니다.')
      setEditing(null)
      await load(true)
      // 다음 항목으로 포커스 이동
      const remaining = visible.filter((item) => item.id !== proposal.id)
      setSelectedId(remaining[0]?.id ?? null)
    } catch (reason) {
      onToast(reason instanceof Error ? reason.message : '결정을 저장하지 못했습니다.')
    } finally {
      setBusyId(null)
    }
  }, [busyId, headers, load, onToast, visible])

  const evaluateNow = async () => {
    try {
      const response = await fetch('/api/proposals/evaluate', { method: 'POST', headers })
      const body = await response.json() as { created?: number; expired?: number; error?: { message?: string } }
      if (!response.ok) throw new Error(body.error?.message || '센티널 평가에 실패했습니다.')
      onToast(`센티널 평가 완료 · 새 제안 ${body.created ?? 0}건 · 해소 ${body.expired ?? 0}건`)
      await load(true)
    } catch (reason) { onToast(reason instanceof Error ? reason.message : '센티널 평가에 실패했습니다.') }
  }

  // 키보드: ↑↓ 이동, Enter/A 승인, E 수정, X 거절
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (editing) return
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (!selected) return
      const index = visible.findIndex((item) => item.id === selected.id)
      if (event.key === 'ArrowDown') { event.preventDefault(); setSelectedId(visible[Math.min(visible.length - 1, index + 1)]?.id ?? selected.id) }
      else if (event.key === 'ArrowUp') { event.preventDefault(); setSelectedId(visible[Math.max(0, index - 1)]?.id ?? selected.id) }
      else if (selected.status === 'pending' && (event.key === 'Enter' || event.key.toLowerCase() === 'a')) { event.preventDefault(); void decide(selected, 'approve') }
      else if (selected.status === 'pending' && event.key.toLowerCase() === 'e') { event.preventDefault(); setEditing(selected) }
      else if (selected.status === 'pending' && event.key.toLowerCase() === 'x') { event.preventDefault(); void decide(selected, 'reject') }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [decide, editing, selected, visible])

  const pendingCount = data?.pendingCount ?? 0
  const stats = data?.stats ?? []

  return <div className="content-page approval-page">
    <header className="page-header">
      <div><span className="eyebrow">AI REVIEW</span><h1>AI 제안 검토</h1><p>AI가 "이렇게 할까요?"라고 올린 제안을 사람이 결정합니다. 승인하기 전에는 아무것도 실행되지 않습니다.</p></div>
      <div className="page-header-actions"><Button tone="secondary" type="button" onClick={() => void evaluateNow()}><RefreshCw size={17} /> 지금 점검</Button></div>
    </header>

    <section className="approval-stats" aria-label="유형별 최근 4주 승인률">
      {stats.map((stat) => <article key={stat.kind}>
        <StatusBadge className="status-pill" tone={kindMeta[stat.kind].tone}>{kindMeta[stat.kind].label}</StatusBadge>
        <strong>{stat.approvalRate === null ? '아직 데이터 없음' : `${stat.approvalRate}%`}</strong>
        <small>{stat.total ? `최근 ${stat.windowDays}일 승인 ${stat.approved + stat.edited} · 거절 ${stat.rejected}` : `최근 ${stat.windowDays}일 결정 없음`}</small>
      </article>)}
    </section>

    <section className="panel approval-panel">
      <div className="approval-toolbar">
        <div className="approval-tabs" role="tablist"><button type="button" role="tab" aria-selected={filter === 'pending'} onClick={() => setFilter('pending')}>검토 대기 <em>{pendingCount}</em></button><button type="button" role="tab" aria-selected={filter === 'all'} onClick={() => setFilter('all')}>전체 이력</button></div>
        <span className="approval-keys"><Keyboard size={15} /> ↑↓ 이동 · Enter/A 승인 · E 수정 · X 거절</span>
      </div>
      {loading ? <div className="empty-state compact"><RefreshCw size={22} /><h3>AI 제안을 불러오는 중</h3></div>
        : error ? <div className="empty-state compact"><ShieldAlert size={22} /><h3>{error}</h3><Button tone="secondary" type="button" onClick={() => void load()}>다시 시도</Button></div>
          : visible.length === 0 ? <div className="empty-state compact"><ClipboardCheck size={26} /><h3>{filter === 'pending' ? '검토할 AI 제안이 없습니다' : '아직 제안 이력이 없습니다'}</h3><p>문서를 올리거나 메신저에서 “~해주세요”라고 지시하면, 센티널이 위험 신호를 찾으면 여기에 제안이 쌓입니다.</p></div>
            : <div className="approval-list" role="list" ref={listRef}>
              {visible.map((item) => {
                const meta = kindMeta[item.kind]
                const Icon = meta.icon
                const confidence = confidenceLabel(item.confidence)
                const isSelected = selected?.id === item.id
                const pending = item.status === 'pending'
                return <article key={item.id} role="listitem" className={`approval-row${isSelected ? ' is-selected' : ''}${pending ? '' : ' is-decided'}`} tabIndex={0} aria-current={isSelected ? 'true' : undefined} onClick={() => setSelectedId(item.id)} onFocus={() => setSelectedId(item.id)}>
                  <StatusBadge className="status-pill approval-kind" tone={meta.tone} icon={<Icon size={13} />}>{meta.label}</StatusBadge>
                  <div className="approval-row-main">
                    <strong>{item.summary}</strong>
                    <small>{item.evidence}{confidence ? <> · <em className={confidence.high ? 'is-high' : ''}>{confidence.text}</em></> : null}{!pending && <> · {item.status === 'approved' ? '승인' : item.status === 'edited' ? '수정 승인' : item.status === 'rejected' ? '거절' : '해소됨'} {item.decidedByName ? `· ${item.decidedByName}` : ''} {item.decidedAt ? formatDateTime(item.decidedAt) : ''}</>}</small>
                    {!pending && item.decisionDiff && <span className="approval-diff">수정: {Object.entries(item.decisionDiff).map(([key, change]) => `${key}: ${String(change.before ?? '—')} → ${String(change.after ?? '—')}`).join(' / ')}</span>}
                  </div>
                  {pending ? <div className="approval-actions">
                    <button type="button" className="approve" aria-label="승인" disabled={busyId === item.id} onClick={(event) => { event.stopPropagation(); void decide(item, 'approve') }}><Check size={16} /> 승인</button>
                    <button type="button" className="edit" aria-label="수정 후 승인" disabled={busyId === item.id} onClick={(event) => { event.stopPropagation(); setEditing(item) }}><Pencil size={15} /> 수정</button>
                    <button type="button" className="reject" aria-label="거절" disabled={busyId === item.id} onClick={(event) => { event.stopPropagation(); void decide(item, 'reject') }}><X size={16} /> 거절</button>
                  </div> : item.resultRef?.type === 'work-item' ? <button type="button" className="approval-link" onClick={(event) => { event.stopPropagation(); onOpenTask(item.resultRef!.id) }}>생성된 업무 보기</button> : <span className="approval-link muted">{item.status === 'expired' ? '조건 해소로 종료' : '—'}</span>}
                </article>
              })}
            </div>}
    </section>

    <OpportunityWatch workspaceScope={workspaceScope} onToast={onToast} />

    {editing && <ProposalEditDialog proposal={editing} busy={busyId === editing.id} onClose={() => setEditing(null)} onSubmit={(payload, reason) => void decide(editing, 'edit', payload, reason)} />}
  </div>
}

function ProposalEditDialog({ proposal, busy, onClose, onSubmit }: { proposal: Proposal; busy: boolean; onClose: () => void; onSubmit: (payload: Record<string, unknown>, reason?: string) => void }) {
  const [reason, setReason] = useState('')
  const isDocument = proposal.kind === 'document-classification'
  const payload = proposal.payload as Record<string, string>
  const [title, setTitle] = useState(String(payload.title ?? ''))
  const [owner, setOwner] = useState(String(payload.owner ?? ''))
  const [due, setDue] = useState(() => {
    const value = String(payload.due ?? '')
    return Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value) + 9 * 60 * 60 * 1_000).toISOString().slice(0, 16) : ''
  })
  const [priority, setPriority] = useState(String(payload.priority ?? '보통'))
  const [category, setCategory] = useState(String(payload.category ?? ''))
  const [tags, setTags] = useState(Array.isArray(proposal.payload.tags) ? (proposal.payload.tags as string[]).join(', ') : '')
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="modal-card approval-edit-modal" role="dialog" aria-modal="true" aria-labelledby="approval-edit-title">
      <header><div><span className="eyebrow">EDIT & APPROVE</span><h2 id="approval-edit-title">수정 후 승인</h2><p>{proposal.summary}</p></div><IconButton tone="ghost" type="button" aria-label="닫기" onClick={onClose}><X size={21} /></IconButton></header>
      <form onSubmit={(event) => {
        event.preventDefault()
        if (isDocument) { onSubmit({ category: category.trim(), tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean) }, reason.trim()); return }
        onSubmit({
          title: title.trim(),
          owner: owner.trim(),
          ownerId: owner.trim() === String(payload.owner ?? '') ? payload.ownerId ?? null : null,
          due: due ? new Date(Date.parse(`${due}:00+09:00`)).toISOString() : payload.due,
          priority,
        }, reason.trim())
      }}>
        <p className="approval-edit-evidence"><ShieldAlert size={15} /> 근거: {proposal.evidence}</p>
        {isDocument ? <>
          <label className="form-field full"><span>분류</span><input value={category} onChange={(event) => setCategory(event.target.value)} autoFocus required /></label>
          <label className="form-field full"><span>태그 (쉼표로 구분)</span><input value={tags} onChange={(event) => setTags(event.target.value)} /></label>
        </> : <>
          <label className="form-field full"><span>업무 제목</span><input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus required /></label>
          <div className="form-grid"><label className="form-field"><span>담당자 이름</span><input value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="비우면 승인자 본인" /></label><label className="form-field"><span>우선순위</span><select value={priority} onChange={(event) => setPriority(event.target.value)}><option>긴급</option><option>높음</option><option>보통</option></select></label></div>
          <label className="form-field full"><span>마감</span><input type="datetime-local" value={due} onChange={(event) => setDue(event.target.value)} /></label>
        </>}
        <label className="form-field full"><span>왜 고치셨나요? <em className="field-optional">선택</em></span><input value={reason} maxLength={300} placeholder="예: 이 분류는 항상 인사·노무로 본다" onChange={(event) => setReason(event.target.value)} /></label>
        <p className="approval-edit-note">무엇을 고쳤는지는 diff로 저장되어 자동화 승급 판단에 쓰입니다. 이유를 적으면 내 판단 기록의 규범 후보 근거가 됩니다.</p>
        <footer><Button tone="ghost" type="button" disabled={busy} onClick={onClose}>취소</Button><Button tone="primary" type="submit" disabled={busy}><Check size={18} /> {busy ? '실행 중…' : '수정한 내용으로 승인'}</Button></footer>
      </form>
    </section>
  </div>
}

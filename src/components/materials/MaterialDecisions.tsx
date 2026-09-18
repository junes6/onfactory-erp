import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Check, ClipboardCopy, Download, FileText, Gavel, Printer, Send, X } from 'lucide-react'
import { formatDateTime, seoulDateInputValue } from '../../utils/dateTime'
import { Button, IconButton } from '../ui/Button'
import {
  DECISION_OPTIONS, approveProposal, createDecisionRecord, fetchDecisionSummary, fetchDirectory, importOpinions, proposeMaterialTask, requestReview, setDeciders,
  type DecisionStatus, type MaterialDecision, type MaterialDetail, type MaterialTask,
} from './materialsApi'

/**
 * 검토 자료의 결정 — 사람이 결정권을 쥔다. 결정은 지우지 않고 새 줄로만 덮으므로, 여기 보이는 이력이 그대로 기록이다.
 */
const DECISION_TONE: Record<DecisionStatus, string> = { 반영: 'is-apply', '수정 후 반영': 'is-amend', 보류: 'is-hold', 미반영: 'is-drop' }

export function DecisionBox({ decisions, canDecide, readOnly, currentVersion, onDecide }: {
  decisions: MaterialDecision[]
  canDecide: boolean
  readOnly: boolean
  currentVersion: number
  onDecide: (status: DecisionStatus, note: string) => Promise<void>
}) {
  const current = decisions.at(-1) ?? null
  const [status, setStatus] = useState<DecisionStatus | null>(current?.status ?? null)
  const [note, setNote] = useState(current?.note ?? '')
  const [busy, setBusy] = useState(false)
  useEffect(() => { setStatus(current?.status ?? null); setNote(current?.note ?? '') }, [current?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const changed = status !== null && (status !== current?.status || note.trim() !== (current?.note ?? ''))

  return (
    <div className="material-decision">
      <div className="material-decision-current">
        <Gavel size={16} aria-hidden="true" />
        {current ? (
          <span>
            결정: <strong className={`material-decision-chip ${DECISION_TONE[current.status]}`}>{current.status}</strong>
            {current.note ? ` — ${current.note}` : ''}
            <small> · {current.decidedByName} · {formatDateTime(current.decidedAt)}{current.version !== currentVersion ? ` · ${current.version}판 기준` : ''}</small>
          </span>
        ) : <span>아직 결정하지 않았습니다.</span>}
      </div>
      {canDecide && !readOnly && (
        <div className="material-decision-form">
          <div className="material-decision-options" role="radiogroup" aria-label="결정">
            {DECISION_OPTIONS.map((option) => (
              <button key={option} type="button" role="radio" aria-checked={status === option} className={`material-decision-option ${DECISION_TONE[option]}`} onClick={() => setStatus(option)}>
                {status === option && <Check size={15} aria-hidden="true" />} {option}
              </button>
            ))}
          </div>
          <label className="material-decision-note">
            <span>결정 메모 (선택)</span>
            <input value={note} maxLength={500} placeholder="예: 다음 스프린트 · 예산 확인 후" onChange={(event) => setNote(event.target.value)} />
          </label>
          <Button tone="primary" size="sm" type="button" disabled={!changed || busy} onClick={() => { if (!status) return; setBusy(true); void onDecide(status, note.trim()).finally(() => setBusy(false)) }}>
            {busy ? '남기는 중…' : current ? '결정 바꾸기' : '결정 남기기'}
          </Button>
        </div>
      )}
      {decisions.length > 1 && (
        <details className="material-decision-history">
          <summary>결정 이력 {decisions.length}개</summary>
          <ol>
            {[...decisions].reverse().map((row) => (
              <li key={row.id}><strong>{row.status}</strong>{row.note ? ` — ${row.note}` : ''} <small>· {row.decidedByName} · {formatDateTime(row.decidedAt)} · {row.version}판</small></li>
            ))}
          </ol>
        </details>
      )}
    </div>
  )
}

const TASK_STATUS: Record<MaterialTask['status'], string> = { pending: '승인 대기', approved: '업무로 생성', edited: '고쳐서 생성', rejected: '거절됨', expired: '만료됨' }

/**
 * 결정한 항목을 업무로 — 승인 큐로 올라간다(길은 하나). 관리자면 그 자리에서 [바로 승인]할 수 있다.
 * 이미 올린 업무는 상태 칩으로 보인다(승인 대기 · 업무로 생성 · 진행 상태).
 */
export function TaskFromDecision({ workspaceScope, materialId, lineageId, defaultTitle, tasks, canApprove, onChanged, onToast }: {
  workspaceScope?: string
  materialId: string
  lineageId: string
  defaultTitle: string
  tasks: MaterialTask[]
  canApprove: boolean
  onChanged: () => void
  onToast: (message: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState(defaultTitle.slice(0, 120))
  const [ownerId, setOwnerId] = useState('')
  const [due, setDue] = useState('')
  const [members, setMembers] = useState<Array<{ id: string; name: string; team?: string }>>([])
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<string | null>(null)
  useEffect(() => {
    if (!open || members.length) return
    fetchDirectory(workspaceScope).then(setMembers).catch(() => onToast('구성원 목록을 불러오지 못했습니다.'))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const pending = tasks.some((task) => task.status === 'pending')
  const submit = async () => {
    setBusy(true)
    try {
      const result = await proposeMaterialTask(workspaceScope, materialId, { lineageId, title: title.trim(), ownerId, due: due ? new Date(`${due}T18:00:00+09:00`).toISOString() : null })
      setCreated(result.proposalId)
      onToast(result.canApprove ? '업무 제안을 올렸습니다. 바로 승인하면 업무가 만들어집니다.' : '업무 제안을 승인 큐에 올렸습니다. 관리자가 승인하면 업무가 만들어집니다.')
      setOpen(false)
      onChanged()
    } catch (cause) { onToast(cause instanceof Error ? cause.message : '업무 제안을 올리지 못했습니다.') } finally { setBusy(false) }
  }
  const approve = async (proposalId: string) => {
    setBusy(true)
    try { await approveProposal(workspaceScope, proposalId); onToast('승인했습니다. 업무가 만들어졌습니다.'); setCreated(null); onChanged() } catch (cause) { onToast(cause instanceof Error ? cause.message : '승인하지 못했습니다.') } finally { setBusy(false) }
  }
  return (
    <div className="material-task">
      {tasks.length > 0 && (
        <ul className="material-task-list">
          {tasks.map((task) => (
            <li key={task.proposalId}>
              <span className={`material-task-chip is-${task.status}`}>{TASK_STATUS[task.status]}{task.workStatus ? ` · ${task.workStatus}` : ''}</span>
              <span>{task.title} <small>· {task.owner}</small></span>
              {canApprove && task.status === 'pending' && <Button tone="secondary" size="sm" type="button" disabled={busy} onClick={() => void approve(task.proposalId)}>바로 승인</Button>}
            </li>
          ))}
        </ul>
      )}
      {created && canApprove && !tasks.some((task) => task.proposalId === created) && <Button tone="secondary" size="sm" type="button" disabled={busy} onClick={() => void approve(created)}>바로 승인</Button>}
      {!pending && !open && <Button tone="ghost" size="sm" type="button" onClick={() => setOpen(true)}>업무로 만들기</Button>}
      {open && (
        <div className="material-task-form">
          <label className="form-field"><span>업무 제목</span><input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} /></label>
          <div className="form-grid">
            <label className="form-field"><span>담당</span><select value={ownerId} onChange={(event) => setOwnerId(event.target.value)}><option value="">나</option>{members.map((member) => <option key={member.id} value={member.id}>{member.name}{member.team ? ` · ${member.team}` : ''}</option>)}</select></label>
            <label className="form-field"><span>기한 (선택)</span><input type="date" value={due} min={seoulDateInputValue()} onChange={(event) => setDue(event.target.value)} /></label>
          </div>
          <div className="material-task-actions">
            <Button tone="ghost" size="sm" type="button" disabled={busy} onClick={() => setOpen(false)}>취소</Button>
            <Button tone="primary" size="sm" type="button" disabled={busy || title.trim().length < 2} onClick={() => void submit()}>{busy ? '올리는 중…' : '승인 큐에 올리기'}</Button>
          </div>
        </div>
      )}
    </div>
  )
}

function Dialog({ title, eyebrow, description, onClose, children, footer, busy = false }: {
  title: string
  eyebrow: string
  description: string
  onClose: () => void
  children: ReactNode
  footer: ReactNode
  busy?: boolean
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
      <section className="modal-card material-dialog" role="dialog" aria-modal="true" aria-labelledby="material-dialog-title">
        <header>
          <div><span className="eyebrow">{eyebrow}</span><h2 id="material-dialog-title">{title}</h2><p>{description}</p></div>
          <IconButton tone="ghost" type="button" aria-label="닫기" disabled={busy} onClick={onClose}><X size={21} /></IconButton>
        </header>
        <div className="material-dialog-body">{children}</div>
        <footer>{footer}</footer>
      </section>
    </div>
  )
}

export function RequestReviewDialog({ workspaceScope, material, onClose, onSent, onToast }: {
  workspaceScope?: string
  material: MaterialDetail
  onClose: () => void
  onSent: (material: MaterialDetail) => void
  onToast: (message: string) => void
}) {
  const defaultDue = material.dueAt ? material.dueAt.slice(0, 10) : seoulDateInputValue(new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000))
  const [due, setDue] = useState(defaultDue)
  const [withDue, setWithDue] = useState(true)
  const [busy, setBusy] = useState(false)
  const send = async () => {
    setBusy(true)
    try {
      // 마감은 그날 저녁 6시(서울)로 둔다 — 날짜만 고른 사람은 "그날 안에"를 뜻한다.
      const result = await requestReview(workspaceScope, material.id, withDue && due ? new Date(`${due}T18:00:00+09:00`).toISOString() : null)
      onToast(result.notified ? `${result.notified}명에게 검토 요청을 보냈습니다.` : '보낼 사람이 없었습니다. 이 자료를 볼 수 있는 사람이 나뿐입니다.')
      onSent(result.material)
      onClose()
    } catch (cause) { onToast(cause instanceof Error ? cause.message : '검토 요청을 보내지 못했습니다.') } finally { setBusy(false) }
  }
  return (
    <Dialog
      eyebrow="REQUEST REVIEW"
      title="검토 요청 보내기"
      description={`이 자료를 볼 수 있는 사람${material.projectName ? `(${material.projectName} 구성원)` : '(회사 전원)'}에게 알림이 한 번 갑니다. 마감 하루 전에는 아직 의견을 남기지 않은 사람에게만 한 번 더 알립니다.`}
      onClose={onClose}
      busy={busy}
      footer={<><Button tone="ghost" type="button" disabled={busy} onClick={onClose}>취소</Button><Button tone="primary" type="button" disabled={busy || (withDue && !due)} onClick={() => void send()}><Send size={17} aria-hidden="true" /> {busy ? '보내는 중…' : '요청 보내기'}</Button></>}
    >
      <label className="material-dialog-check"><input type="checkbox" checked={withDue} onChange={(event) => setWithDue(event.target.checked)} /> 의견 마감 정하기</label>
      {withDue && <label className="form-field"><span>의견 마감일 (그날 저녁 6시까지)</span><input type="date" value={due} min={seoulDateInputValue()} onChange={(event) => setDue(event.target.value)} /></label>}
    </Dialog>
  )
}

export function ImportOpinionsDialog({ workspaceScope, materialId, onClose, onImported, onToast }: {
  workspaceScope?: string
  materialId: string
  onClose: () => void
  onImported: () => void
  onToast: (message: string) => void
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string>('')
  const run = async () => {
    setBusy(true)
    try {
      const body = await importOpinions(workspaceScope, materialId, text)
      const total = body.imported.stances + body.imported.comments + body.imported.decisions
      setResult(total
        ? `찬반 ${body.imported.stances}개 · 의견 ${body.imported.comments}개 · 결정 ${body.imported.decisions}개를 가져왔습니다 (${body.people.join(', ')}).${body.unmatchedKeys.length ? ` 이번 판에 없는 항목 ${body.unmatchedKeys.join(', ')}은 건너뛰었습니다.` : ''}`
        : '새로 가져올 것이 없었습니다. 이미 가져온 글입니다.')
      if (total) onImported()
    } catch (cause) { onToast(cause instanceof Error ? cause.message : '의견을 가져오지 못했습니다.') } finally { setBusy(false) }
  }
  return (
    <Dialog
      eyebrow="IMPORT"
      title="자료 속 의견 가져오기"
      description="자료 안의 자체 검토 기능에서 [내 의견 복사]·[요약 복사]로 만든 글을 그대로 붙여 넣으세요. 여러 사람의 글을 한꺼번에 붙여 넣어도 됩니다. 같은 글은 한 번만 들어갑니다."
      onClose={onClose}
      busy={busy}
      footer={<><Button tone="ghost" type="button" disabled={busy} onClick={onClose}>닫기</Button><Button tone="primary" type="button" disabled={busy || !text.trim()} onClick={() => void run()}>{busy ? '가져오는 중…' : '가져오기'}</Button></>}
    >
      <label className="form-field full"><span>붙여 넣을 글</span><textarea rows={8} value={text} onChange={(event) => setText(event.target.value)} placeholder={'[온리북 개편 리뷰 — 홍길동 의견]\n…\n--- 가져오기용 데이터 ---\n{"type":"…-review", …}'} /></label>
      {result && <p className="material-dialog-result" role="status">{result}</p>}
    </Dialog>
  )
}

export function DecisionSummaryDialog({ workspaceScope, material, onClose, onOpenDocument, onToast }: {
  workspaceScope?: string
  material: MaterialDetail
  onClose: () => void
  onOpenDocument?: (documentId: string) => void
  onToast: (message: string) => void
}) {
  const [markdown, setMarkdown] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    fetchDecisionSummary(workspaceScope, material.id)
      .then((body) => { if (active) setMarkdown(body.markdown) })
      .catch((cause: unknown) => onToast(cause instanceof Error ? cause.message : '결정 요약을 만들지 못했습니다.'))
    return () => { active = false }
  }, [workspaceScope, material.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const fileName = `${material.title} 결정 요약 ${material.currentVersion}판.md`
  const copy = async () => {
    try { await navigator.clipboard.writeText(markdown); onToast('결정 요약을 복사했습니다.') } catch { onToast('복사하지 못했습니다. 글을 직접 선택해 복사해 주세요.') }
  }
  const download = () => {
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }))
    const anchor = window.document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
  }
  /** 큰 글씨로 인쇄 — 우리가 만든 글만 담은 빈 칸에서 인쇄한다(자료의 스크립트와 섞지 않는다). */
  const print = () => {
    const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const frame = window.document.createElement('iframe')
    frame.setAttribute('aria-hidden', 'true')
    frame.style.position = 'fixed'
    frame.style.width = '0'
    frame.style.height = '0'
    frame.style.border = '0'
    frame.srcdoc = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${escape(fileName)}</title><style>body{font:18px/1.7 system-ui,sans-serif;margin:24px;color:black}pre{white-space:pre-wrap;font:inherit}</style></head><body><pre>${escape(markdown)}</pre></body></html>`
    frame.onload = () => { frame.contentWindow?.print(); window.setTimeout(() => frame.remove(), 60_000) }
    window.document.body.appendChild(frame)
  }
  const record = async () => {
    setBusy(true)
    try {
      const result = await createDecisionRecord(workspaceScope, material.id)
      onToast(result.replayed ? '결정이 그대로라 이미 만든 결정 기록 문서를 엽니다.' : `결정 ${result.decidedCount}건을 결정 기록 문서로 남겼습니다.`)
      onOpenDocument?.(result.documentId)
    } catch (cause) { onToast(cause instanceof Error ? cause.message : '결정 기록 문서를 만들지 못했습니다.') } finally { setBusy(false) }
  }
  return (
    <Dialog
      eyebrow="DECISIONS"
      title="결정 요약"
      description={`${material.currentVersion}판 기준으로 결정별로 묶었습니다. 결정은 ${material.deciders.join(', ')}님이 합니다.`}
      onClose={onClose}
      busy={busy}
      footer={<>
        <Button tone="ghost" type="button" disabled={!markdown} onClick={() => void copy()}><ClipboardCopy size={17} aria-hidden="true" /> 복사</Button>
        <Button tone="ghost" type="button" disabled={!markdown} onClick={download}><Download size={17} aria-hidden="true" /> 내려받기</Button>
        <Button tone="ghost" type="button" disabled={!markdown} onClick={print}><Printer size={17} aria-hidden="true" /> 인쇄</Button>
        {material.canDecide && <Button tone="primary" type="button" disabled={busy || !markdown} onClick={() => void record()}><FileText size={17} aria-hidden="true" /> {busy ? '만드는 중…' : '결정 기록 문서로 남기기'}</Button>}
      </>}
    >
      {markdown ? <pre className="material-summary-text">{markdown}</pre> : <p className="material-loading">결정 요약을 만드는 중입니다…</p>}
    </Dialog>
  )
}

export function DecidersDialog({ workspaceScope, material, onClose, onSaved, onToast }: {
  workspaceScope?: string
  material: MaterialDetail
  onClose: () => void
  onSaved: (material: MaterialDetail) => void
  onToast: (message: string) => void
}) {
  const [members, setMembers] = useState<Array<{ id: string; name: string; team?: string }>>([])
  const [picked, setPicked] = useState<Set<string>>(new Set(material.deciderIds))
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    fetchDirectory(workspaceScope).then((rows) => { if (active) setMembers(rows) }).catch(() => onToast('구성원 목록을 불러오지 못했습니다.'))
    return () => { active = false }
  }, [workspaceScope]) // eslint-disable-line react-hooks/exhaustive-deps
  const candidates = useMemo(() => members.filter((member) => member.id !== material.ownerId), [members, material.ownerId])
  const save = async () => {
    setBusy(true)
    try { onSaved(await setDeciders(workspaceScope, material.id, [...picked])); onToast('결정권자를 바꿨습니다.'); onClose() } catch (cause) { onToast(cause instanceof Error ? cause.message : '결정권자를 바꾸지 못했습니다.') } finally { setBusy(false) }
  }
  return (
    <Dialog
      eyebrow="DECIDERS"
      title="결정권자 지정"
      description={`올린 사람(${material.ownerName})과 회사 관리자는 언제나 결정할 수 있습니다. 함께 결정할 사람을 더 고르세요.`}
      onClose={onClose}
      busy={busy}
      footer={<><Button tone="ghost" type="button" disabled={busy} onClick={onClose}>취소</Button><Button tone="primary" type="button" disabled={busy} onClick={() => void save()}>{busy ? '저장 중…' : '저장'}</Button></>}
    >
      <ul className="material-picker">
        {candidates.map((member) => (
          <li key={member.id}>
            <label>
              <input type="checkbox" checked={picked.has(member.id)} onChange={(event) => setPicked((current) => { const next = new Set(current); if (event.target.checked) next.add(member.id); else next.delete(member.id); return next })} />
              <span>{member.name}</span>{member.team && <small>{member.team}</small>}
            </label>
          </li>
        ))}
        {!candidates.length && <li className="material-loading">구성원을 불러오는 중입니다…</li>}
      </ul>
    </Dialog>
  )
}

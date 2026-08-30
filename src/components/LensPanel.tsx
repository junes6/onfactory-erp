import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Bot, ClipboardCheck, Quote, RefreshCw, Send, Settings2, Sparkles, Trash2, X } from 'lucide-react'
import {
  canRunLensOn,
  fetchLenses,
  LENS_FILE_KIND_LABELS,
  LENS_OUTPUT_LABELS,
  runLens,
  saveLenses,
  sendLensTasksToQueue,
  type Lens,
  type LensFileKind,
  type LensOutputFormat,
  type LensRun,
} from '../utils/documentLenses'
import { StatusBadge } from './StatusBadge'
import { Button, IconButton } from './ui/Button'
import './LensPanel.css'

/** 렌즈 패널이 물고 있는 파일. 어느 화면에서 열든 이 모양으로 넘긴다. */
export type LensTarget = { id: string; name: string; mime?: string; context?: string }

const FILE_KINDS: LensFileKind[] = ['all', 'document', 'image', 'text']
const OUTPUT_FORMATS: LensOutputFormat[] = ['summary', 'table', 'tasks']

export function LensPanel({ target, workspaceScope, canManage, onClose, onToast, onPendingChange }: {
  target: LensTarget
  workspaceScope?: string
  canManage: boolean
  onClose: () => void
  onToast: (message: string) => void
  onPendingChange?: (count: number) => void
}) {
  const [lenses, setLenses] = useState<Lens[]>([])
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState('')
  const [run, setRun] = useState<LensRun | null>(null)
  const [sending, setSending] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const readable = canRunLensOn(target.mime)

  const load = useCallback(async () => {
    setLoading(true)
    try { setLenses((await fetchLenses(workspaceScope)).lenses) }
    catch (error) { onToast(error instanceof Error ? error.message : '렌즈 목록을 불러오지 못했습니다.') }
    finally { setLoading(false) }
  }, [workspaceScope, onToast])
  useEffect(() => { void load() }, [load])
  useEffect(() => { setRun(null) }, [target.id])
  useEffect(() => () => abortRef.current?.abort(), [])

  const available = useMemo(() => lenses.filter((lens) => lens.enabled !== false), [lenses])

  const execute = async (lens: Lens) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setRunning(lens.id)
    setRun(null)
    try {
      const result = await runLens(target.id, lens.id, workspaceScope, controller.signal)
      if (!controller.signal.aborted) setRun(result)
    } catch (error) {
      if (controller.signal.aborted) return
      onToast(error instanceof Error ? error.message : 'AI가 파일을 읽지 못했습니다.')
    } finally {
      if (!controller.signal.aborted) setRunning('')
    }
  }

  const sendTasks = async () => {
    if (!run || run.result.outputFormat !== 'tasks' || !run.result.tasks.length) return
    setSending(true)
    try {
      const body = await sendLensTasksToQueue(target.id, run.lens, run.result.tasks, workspaceScope)
      onPendingChange?.(body.pendingCount)
      onToast(body.queued
        ? `승인 큐로 ${body.queued}건을 보냈습니다${body.skipped ? ` · 이미 올라간 ${body.skipped}건은 건너뛰었습니다` : ''}. 검토 후 승인하면 업무가 생성됩니다.`
        : '이미 승인 큐에 올라간 업무입니다.')
    } catch (error) { onToast(error instanceof Error ? error.message : '승인 큐로 보내지 못했습니다.') }
    finally { setSending(false) }
  }

  return <aside className="lens-panel" role="complementary" aria-labelledby="lens-panel-title">
    <header className="lens-panel-head">
      <div>
        <span className="lens-panel-kicker"><Sparkles size={14} /> AI에게 물어보기</span>
        <strong id="lens-panel-title">{target.name}</strong>
        {target.context && <small>{target.context}</small>}
      </div>
      <div className="lens-panel-head-actions">
        {canManage && <IconButton tone="quiet" aria-label="렌즈 관리" onClick={() => setSettingsOpen(true)}><Settings2 size={18} /></IconButton>}
        <IconButton tone="quiet" aria-label="닫기" onClick={onClose}><X size={20} /></IconButton>
      </div>
    </header>

    {!readable
      ? <p className="lens-panel-empty">이 파일 형식은 AI가 읽을 수 없습니다. PDF · 이미지 · 텍스트 파일에서 사용해 주세요.</p>
      : <>
        <div className="lens-panel-buttons">
          {loading
            ? <span className="lens-panel-empty">렌즈를 불러오는 중…</span>
            : available.map((lens) => <Button
              key={lens.id}
              tone={run?.lens.id === lens.id ? 'secondary' : 'ghost'}
              size="sm"
              disabled={Boolean(running)}
              onClick={() => void execute(lens)}
            >
              {running === lens.id ? <RefreshCw size={14} className="lens-spin" /> : <Bot size={14} />}
              {lens.name}
            </Button>)}
        </div>
        {available.some((lens) => lens.description) && !run && !running && <ul className="lens-panel-hints">
          {available.filter((lens) => lens.description).slice(0, 4).map((lens) => <li key={lens.id}><strong>{lens.name}</strong> · {lens.description}</li>)}
        </ul>}
        {running && <p className="lens-panel-empty" role="status">파일을 읽는 중입니다…</p>}
        {run && <LensAnswer run={run} sending={sending} onSendTasks={() => void sendTasks()} />}
      </>}

    {settingsOpen && <LensSettings
      lenses={lenses}
      workspaceScope={workspaceScope}
      onClose={() => setSettingsOpen(false)}
      onSaved={(next) => { setLenses(next); onToast('렌즈 설정을 저장했습니다.') }}
      onToast={onToast}
    />}
  </aside>
}

function LensAnswer({ run, sending, onSendTasks }: { run: LensRun; sending: boolean; onSendTasks: () => void }) {
  const { result } = run
  if (result.insufficient) {
    return <section className="lens-answer">
      <p className="lens-insufficient">판단 근거가 부족합니다. 이 파일에서는 <strong>{run.lens.name}</strong> 관점으로 확인할 내용을 찾지 못했습니다.</p>
    </section>
  }
  return <section className="lens-answer" aria-label={`${run.lens.name} 결과`}>
    {result.outputFormat === 'summary' && <>
      {result.headline && <strong className="lens-headline">{result.headline}</strong>}
      <ul className="lens-bullets">{result.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}</ul>
      {result.decisions.length > 0 && <div className="lens-decisions">
        <h4>지금 결정할 것</h4>
        <ul>{result.decisions.map((decision) => <li key={decision}>{decision}</li>)}</ul>
      </div>}
    </>}

    {result.outputFormat === 'table' && <div className="lens-table-wrap">
      <table className="lens-table">
        <thead><tr><th>항목</th><th>내용</th><th>주의도</th></tr></thead>
        <tbody>{result.rows.map((row) => <tr key={`${row.item}-${row.detail}`}>
          <td>{row.item}</td>
          <td>{row.detail}</td>
          <td><StatusBadge dot tone={row.level === '높음' ? 'danger' : row.level === '보통' ? 'warning' : 'neutral'}>{row.level}</StatusBadge></td>
        </tr>)}</tbody>
      </table>
    </div>}

    {result.outputFormat === 'tasks' && <>
      <ol className="lens-tasks">{result.tasks.map((task) => <li key={task.title}>
        <strong>{task.title}</strong>
        <small>{[task.owner || '담당 미정', task.due || '마감 미정'].join(' · ')}</small>
        {task.reason && <p>{task.reason}</p>}
      </li>)}</ol>
      <div className="lens-answer-actions">
        <Button tone="primary" size="sm" disabled={sending} onClick={onSendTasks}>
          <ClipboardCheck size={15} /> {sending ? '보내는 중…' : `승인 큐로 보내기 (${result.tasks.length}건)`}
        </Button>
      </div>
    </>}

    {result.evidence.length > 0 && <details className="lens-evidence">
      <summary><Quote size={12} /> 근거 {result.evidence.length}곳 · {run.source.name}</summary>
      <ul>{result.evidence.map((entry) => <li key={`${entry.where}-${entry.quote}`}><span>{entry.where || '위치 미표시'}</span><q>{entry.quote}</q></li>)}</ul>
    </details>}
  </section>
}

function LensSettings({ lenses, workspaceScope, onClose, onSaved, onToast }: {
  lenses: Lens[]
  workspaceScope?: string
  onClose: () => void
  onSaved: (lenses: Lens[]) => void
  onToast: (message: string) => void
}) {
  const [draft, setDraft] = useState<Lens[]>(lenses)
  const [busy, setBusy] = useState(false)

  const update = (id: string, patch: Partial<Lens>) => setDraft((current) => current.map((lens) => lens.id === id ? { ...lens, ...patch } : lens))
  const addLens = () => setDraft((current) => [...current, {
    id: `LENS-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    name: '새 렌즈',
    description: '',
    outputFormat: 'summary',
    fileKinds: ['all'],
    prompt: '',
    builtIn: false,
    enabled: true,
  }])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    try {
      onSaved(await saveLenses(draft, workspaceScope))
      onClose()
    } catch (error) { onToast(error instanceof Error ? error.message : '렌즈 설정을 저장하지 못했습니다.'); setBusy(false) }
  }

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="modal-card lens-settings-modal" role="dialog" aria-modal="true" aria-labelledby="lens-settings-title">
      <header>
        <div>
          <span className="eyebrow">LENSES</span>
          <h2 id="lens-settings-title">렌즈 관리</h2>
          <p>렌즈는 파일을 어떤 관점으로 읽을지 정한 지시문입니다. 우리 회사가 자주 보는 관점을 직접 추가하세요.</p>
        </div>
        <IconButton aria-label="닫기" onClick={onClose}><X size={21} /></IconButton>
      </header>
      <form onSubmit={submit}>
        <div className="lens-settings-list">{draft.map((lens) => <article key={lens.id} className="lens-settings-row">
          <div className="lens-settings-row-head">
            <label className="form-field"><span>이름</span><input value={lens.name} maxLength={40} required onChange={(event) => update(lens.id, { name: event.target.value })} /></label>
            <label className="form-field"><span>출력 형식</span><select value={lens.outputFormat} onChange={(event) => update(lens.id, { outputFormat: event.target.value as LensOutputFormat })}>
              {OUTPUT_FORMATS.map((format) => <option key={format} value={format}>{LENS_OUTPUT_LABELS[format]}</option>)}
            </select></label>
            {lens.builtIn
              ? <StatusBadge tone="info">기본</StatusBadge>
              : <IconButton tone="danger" size="sm" aria-label={`${lens.name} 삭제`} onClick={() => setDraft((current) => current.filter((item) => item.id !== lens.id))}><Trash2 size={15} /></IconButton>}
          </div>
          <label className="form-field full"><span>한 줄 설명</span><input value={lens.description} maxLength={80} placeholder="버튼 아래에 보이는 안내" onChange={(event) => update(lens.id, { description: event.target.value })} /></label>
          <label className="form-field full"><span>지시문</span><textarea value={lens.prompt} rows={3} maxLength={1200} required placeholder="이 파일에서 무엇을 어떻게 찾을지 사람에게 말하듯 적습니다." onChange={(event) => update(lens.id, { prompt: event.target.value })} /></label>
          <fieldset className="lens-settings-kinds">
            <legend>대상 파일</legend>
            {FILE_KINDS.map((kind) => <label key={kind}>
              <input
                type="checkbox"
                checked={lens.fileKinds.includes(kind)}
                onChange={(event) => update(lens.id, {
                  fileKinds: event.target.checked
                    ? [...new Set([...lens.fileKinds, kind])] as LensFileKind[]
                    : lens.fileKinds.filter((item) => item !== kind),
                })}
              />
              {LENS_FILE_KIND_LABELS[kind]}
            </label>)}
          </fieldset>
        </article>)}</div>
        <footer>
          <Button tone="ghost" onClick={addLens}><Send size={16} /> 렌즈 추가</Button>
          <div>
            <Button tone="ghost" onClick={onClose}>취소</Button>
            <Button tone="primary" type="submit" disabled={busy}>{busy ? '저장 중…' : '저장'}</Button>
          </div>
        </footer>
      </form>
    </section>
  </div>
}

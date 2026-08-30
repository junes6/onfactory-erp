import { useEffect, useState, type FormEvent } from 'react'
import { ExternalLink, Radar, Settings2 } from 'lucide-react'
import { formatDateLabel } from '../utils/dateTime'
import { StatusBadge } from './StatusBadge'
import { Button, ButtonLink, IconButton } from './ui/Button'
import './OpportunityWatch.css'

/**
 * 외부 기회 신호. 수집·판정은 저장소 밖의 워커가 하고, 여기서는 결과만 보여 준다.
 * 임계값을 넘은 건은 승인 큐에 제안으로 올라가므로 이 목록에는 "임계 미만"만 남는다.
 */
export type Opportunity = {
  id: string
  key: string
  source: string
  noticeNo: string
  title: string
  agency: string
  deadline: string
  amount: number
  link: string
  score: number | null
  rationale: string
  status: 'queued' | 'below-threshold'
  receivedAt: string
}

export type OpportunitySettings = {
  keywords: string[]
  regions: string[]
  minAmount: number
  scoreThreshold: number
  updatedAt?: string
  updatedBy?: string
}

type WatchState = {
  opportunities: Opportunity[]
  settings: OpportunitySettings
  queuedCount: number
  ingestConfigured: boolean
  canManage: boolean
}

const money = (value: number) => value > 0 ? `${Math.round(value).toLocaleString('ko-KR')}원` : '금액 미표시'

export function OpportunityWatch({ workspaceScope, onToast }: { workspaceScope?: string; onToast: (message: string) => void }) {
  const [state, setState] = useState<WatchState | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const headers = workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined

  const load = async () => {
    try {
      const response = await fetch('/api/opportunities', { headers })
      if (!response.ok) return
      setState(await response.json() as WatchState)
    } catch { /* 기회 목록은 보조 정보다. 실패해도 승인 큐를 막지 않는다. */ }
  }
  useEffect(() => { void load() }, [workspaceScope]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!state) return null
  const belowThreshold = state.opportunities.filter((item) => item.status === 'below-threshold')

  return <section className="opportunity-watch" aria-labelledby="opportunity-watch-title">
    <header>
      <div>
        <h2 id="opportunity-watch-title"><Radar size={16} /> 외부 기회 감시</h2>
        <p>
          {state.ingestConfigured
            ? `감시 키워드 ${state.settings.keywords.length}개 · 판정 점수 ${Math.round(state.settings.scoreThreshold * 100)}% 이상만 승인 큐로 올립니다.`
            : '수집 워커가 아직 연결되지 않았습니다. 배포 환경에 OPPORTUNITY_INGEST_TOKEN을 설정하면 외부 워커가 기회 건을 밀어넣습니다.'}
        </p>
      </div>
      {state.canManage && <IconButton tone="quiet" aria-label="기회 감시 설정" onClick={() => setSettingsOpen(true)}><Settings2 size={18} /></IconButton>}
    </header>

    {belowThreshold.length > 0 && <details className="opportunity-below">
      <summary>임계 미만으로 보류한 기회 {belowThreshold.length}건 — 승인 큐에는 올리지 않았습니다</summary>
      <ul>{belowThreshold.slice(0, 20).map((item) => <li key={item.id}>
        <div>
          <strong>{item.title}</strong>
          <small>{[item.source, item.agency, item.deadline ? `마감 ${formatDateLabel(item.deadline, false, false)}` : '', money(item.amount)].filter(Boolean).join(' · ')}</small>
          {item.rationale && <p>{item.rationale}</p>}
        </div>
        <div className="opportunity-below-side">
          <StatusBadge tone="neutral">{item.score === null ? '점수 없음' : `${Math.round(item.score * 100)}%`}</StatusBadge>
          {item.link && <ButtonLink tone="quiet" size="sm" href={item.link} target="_blank" rel="noreferrer">공고 <ExternalLink size={12} /></ButtonLink>}
        </div>
      </li>)}</ul>
    </details>}

    {settingsOpen && <OpportunitySettingsDialog
      settings={state.settings}
      workspaceScope={workspaceScope}
      onClose={() => setSettingsOpen(false)}
      onSaved={(settings) => { setState((current) => current ? { ...current, settings } : current); onToast('기회 감시 설정을 저장했습니다.') }}
      onToast={onToast}
    />}
  </section>
}

function OpportunitySettingsDialog({ settings, workspaceScope, onClose, onSaved, onToast }: {
  settings: OpportunitySettings
  workspaceScope?: string
  onClose: () => void
  onSaved: (settings: OpportunitySettings) => void
  onToast: (message: string) => void
}) {
  const [keywords, setKeywords] = useState(settings.keywords.join(', '))
  const [regions, setRegions] = useState(settings.regions.join(', '))
  const [minAmount, setMinAmount] = useState(String(settings.minAmount))
  const [threshold, setThreshold] = useState(Math.round(settings.scoreThreshold * 100))
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    try {
      const response = await fetch('/api/opportunities/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}) },
        body: JSON.stringify({
          settings: {
            keywords: keywords.split(',').map((item) => item.trim()).filter(Boolean),
            regions: regions.split(',').map((item) => item.trim()).filter(Boolean),
            minAmount: Number(minAmount) || 0,
            scoreThreshold: threshold / 100,
          },
        }),
      })
      const body = await response.json() as { settings?: OpportunitySettings; error?: { message?: string } }
      if (!response.ok || !body.settings) throw new Error(body.error?.message || '기회 감시 설정을 저장하지 못했습니다.')
      onSaved(body.settings)
      onClose()
    } catch (error) { onToast(error instanceof Error ? error.message : '기회 감시 설정을 저장하지 못했습니다.'); setBusy(false) }
  }

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="modal-card opportunity-settings-modal" role="dialog" aria-modal="true" aria-labelledby="opportunity-settings-title">
      <header>
        <div>
          <span className="eyebrow">OPPORTUNITY WATCH</span>
          <h2 id="opportunity-settings-title">기회 감시 설정</h2>
          <p>외부 워커가 이 조건으로 공고를 걸러 보냅니다. 판정 점수가 기준 미만이면 승인 큐에 올리지 않고 목록에만 남깁니다.</p>
        </div>
        <IconButton aria-label="닫기" onClick={onClose}>✕</IconButton>
      </header>
      <form onSubmit={submit}>
        <label className="form-field full"><span>감시 키워드 <em className="field-required">쉼표로 구분</em></span><input value={keywords} maxLength={600} placeholder="예: 급식, 수산물 납품, 식품 R&D" onChange={(event) => setKeywords(event.target.value)} /></label>
        <label className="form-field full"><span>지역</span><input value={regions} maxLength={300} placeholder="예: 경북, 전국" onChange={(event) => setRegions(event.target.value)} /></label>
        <div className="form-grid">
          <label className="form-field"><span>금액 하한 (원)</span><input type="number" min="0" step="1000000" value={minAmount} onChange={(event) => setMinAmount(event.target.value)} /></label>
          <label className="form-field"><span>승인 큐 상정 기준 · {threshold}%</span><input type="range" min="0" max="100" step="5" value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} /></label>
        </div>
        <footer>
          <Button tone="ghost" onClick={onClose}>취소</Button>
          <Button tone="primary" type="submit" disabled={busy}>{busy ? '저장 중…' : '저장'}</Button>
        </footer>
      </form>
    </section>
  </div>
}

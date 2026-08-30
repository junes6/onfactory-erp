import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BarChart3, CalendarRange, CheckCircle2, Clock3, FileCheck2, Gauge, LockKeyhole, RefreshCw, Settings2, Sparkles, TrendingUp, UserRoundCheck, X } from 'lucide-react'

import { formatDateTime, formatYearMonthLabel, seoulDateInputValue } from '../utils/dateTime'
import './PerformanceReports.css'import { Button, IconButton } from './ui/Button'


type MetricKey = 'completedTasks' | 'dueCompliance' | 'revisionRate' | 'averageCycleHours' | 'journalSubmission' | 'approvalResponseHours'

type PerformanceMetrics = {
  completedTasks: number | null
  dueCompliance: number | null
  revisionRate: number | null
  averageCycleHours: number | null
  journalSubmission: number | null
  approvalResponseHours: number | null
}

type EvidenceLink = { id: string; title: string; kind?: 'work' | 'journal' }

type PerformanceNarrative = {
  strengths: [string, string]
  improvement: string
  suggestion: string
  conflictNote?: string
  evidence: EvidenceLink[]
  mode: 'ai' | 'rule-based'
}

export type EmployeePerformanceReport = {
  id: string
  employeeId: string
  employeeName: string
  team: string
  jobRole: string
  periodType: 'month' | 'quarter'
  periodStart: string
  periodEnd: string
  score: number | null
  metrics: PerformanceMetrics
  narrative: PerformanceNarrative
  generatedAt: string
  snapshot: boolean
}

type PerformanceSettings = {
  weights: Record<MetricKey, number>
  employeeVisible: boolean
}

type PerformanceResponse = {
  reports: EmployeePerformanceReport[]
  settings: PerformanceSettings
  period: { type: 'month' | 'quarter'; start: string; end: string; label: string }
  generatedAt: string | null
}

const metricDefinitions: Array<{ key: MetricKey; label: string; unit: string; icon: typeof CheckCircle2; inverse?: boolean }> = [
  { key: 'completedTasks', label: '완료 업무', unit: '건', icon: CheckCircle2 },
  { key: 'dueCompliance', label: '기한 준수율', unit: '%', icon: CalendarRange },
  { key: 'revisionRate', label: '보완 재제출', unit: '%', icon: RefreshCw, inverse: true },
  { key: 'averageCycleHours', label: '평균 처리', unit: '시간', icon: Clock3, inverse: true },
  { key: 'journalSubmission', label: '업무일지 제출', unit: '%', icon: FileCheck2 },
  { key: 'approvalResponseHours', label: '결재 응답', unit: '시간', icon: UserRoundCheck, inverse: true },
]

const emptySettings: PerformanceSettings = {
  weights: { completedTasks: 20, dueCompliance: 25, revisionRate: 15, averageCycleHours: 15, journalSubmission: 15, approvalResponseHours: 10 },
  employeeVisible: false,
}

function normalizeSettings(value: unknown): PerformanceSettings {
  if (!value || typeof value !== 'object') return emptySettings
  const candidate = value as Partial<PerformanceSettings>
  const weights = { ...emptySettings.weights, ...(candidate.weights ?? {}) }
  return { weights, employeeVisible: candidate.employeeVisible === true }
}

function metricValue(metrics: PerformanceMetrics, key: MetricKey) {
  const value = metrics[key]
  return value === null || !Number.isFinite(value) ? '해당 없음' : `${Math.round(value * 10) / 10}${metricDefinitions.find((item) => item.key === key)?.unit ?? ''}`
}

function scoreTone(score: number | null) {
  if (score === null || !Number.isFinite(score)) return 'unavailable'
  if (score >= 80) return 'strong'
  if (score >= 60) return 'steady'
  return 'attention'
}

function scoreValue(score: number | null) {
  return score === null || !Number.isFinite(score) ? 'N/A' : Math.round(score)
}

function usePerformanceDialog(open: boolean, onClose: () => void) {
  const dialogRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!open) return
    const dialog = dialogRef.current
    if (!dialog) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const selector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(selector)).filter((element) => !element.hidden)
    focusable()[0]?.focus()
    document.body.classList.add('no-scroll')
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
      if (event.key !== 'Tab') return
      const elements = focusable()
      if (!elements.length) { event.preventDefault(); return }
      const first = elements[0]
      const last = elements[elements.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.classList.remove('no-scroll')
      previousFocus?.focus()
    }
  }, [onClose, open])
  return dialogRef
}

export function PerformanceReports({ workspaceScope, canManage, onToast, onOpenTask }: {
  workspaceScope: string
  canManage: boolean
  onToast: (message: string) => void
  onOpenTask: (taskId: string) => void
}) {
  const [periodType, setPeriodType] = useState<'month' | 'quarter'>('month')
  const [anchor, setAnchor] = useState(() => seoulDateInputValue())
  const [response, setResponse] = useState<PerformanceResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [privateReport, setPrivateReport] = useState(false)
  const [query, setQuery] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsDraft, setSettingsDraft] = useState<PerformanceSettings>(emptySettings)
  const [saving, setSaving] = useState(false)
  const closeSettings = useCallback(() => setSettingsOpen(false), [])
  const settingsDialogRef = usePerformanceDialog(settingsOpen, closeSettings)

  const requestHeaders = useMemo(() => ({ 'x-workspace-identity': workspaceScope }), [workspaceScope])
  const loadReports = useCallback(async () => {
    setLoading(true)
    setError('')
    setPrivateReport(false)
    try {
      const params = new URLSearchParams({ periodType, anchor })
      const endpoint = canManage ? '/api/performance/reports' : '/api/performance/me'
      const request = await fetch(`${endpoint}?${params}`, { headers: requestHeaders })
      const body = await request.json() as Partial<PerformanceResponse> & { error?: { code?: string; message?: string } }
      if (!request.ok && !canManage && body.error?.code === 'PERFORMANCE_PRIVATE') {
        setResponse(null)
        setPrivateReport(true)
        return
      }
      if (!request.ok) throw new Error(body.error?.message || '성과 리포트를 불러오지 못했습니다.')
      const normalized = { ...body, settings: normalizeSettings(body.settings), reports: body.reports ?? [] } as PerformanceResponse
      setResponse(normalized)
      if (canManage) setSettingsDraft(normalized.settings)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '성과 리포트를 불러오지 못했습니다.')
    } finally {
      setLoading(false)
    }
  }, [anchor, canManage, periodType, requestHeaders])

  useEffect(() => { void loadReports() }, [loadReports])

  const reports = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('ko-KR')
    if (!normalizedQuery) return response?.reports ?? []
    return (response?.reports ?? []).filter((report) => `${report.employeeName} ${report.team} ${report.jobRole}`.toLocaleLowerCase('ko-KR').includes(normalizedQuery))
  }, [query, response?.reports])

  const summary = useMemo(() => {
    const scored = reports.filter((report) => report.score !== null && Number.isFinite(report.score))
    const averageScore = scored.length ? Math.round(scored.reduce((sum, report) => sum + (report.score ?? 0), 0) / scored.length) : null
    const totalCompleted = reports.reduce((sum, report) => sum + (report.metrics.completedTasks ?? 0), 0)
    const complianceReports = reports.filter((report) => report.metrics.dueCompliance !== null && Number.isFinite(report.metrics.dueCompliance))
    const averageCompliance = complianceReports.length ? Math.round(complianceReports.reduce((sum, report) => sum + (report.metrics.dueCompliance ?? 0), 0) / complianceReports.length) : null
    const top = [...scored].sort((left, right) => (right.score ?? 0) - (left.score ?? 0))[0] ?? null
    return { averageScore, totalCompleted, averageCompliance, top, scoredCount: scored.length }
  }, [reports])

  // 기록 없는 직원은 카드를 만들지 않는다 — 이름만 한 줄로 모아 화면 소음을 없앤다.
  const reportHasData = useCallback((report: EmployeePerformanceReport) => (
    (report.score !== null && Number.isFinite(report.score))
    || metricDefinitions.some((metric) => {
      const raw = report.metrics[metric.key]
      return raw !== null && Number.isFinite(raw)
    })
  ), [])
  const activeReports = useMemo(() => reports.filter(reportHasData), [reportHasData, reports])
  const idleReports = useMemo(() => reports.filter((report) => !reportHasData(report)), [reportHasData, reports])

  const generate = async () => {
    if (!canManage) return
    setSaving(true)
    try {
      const request = await fetch('/api/performance/reports/generate', {
        method: 'POST', headers: { 'content-type': 'application/json', ...requestHeaders }, body: JSON.stringify({ periodType, anchor }),
      })
      const body = await request.json() as { error?: { message?: string } }
      if (!request.ok) throw new Error(body.error?.message || '리포트를 다시 생성하지 못했습니다.')
      onToast('현재 업무·일지 데이터를 기준으로 성과 리포트를 다시 생성했습니다.')
      await loadReports()
    } catch (reason) {
      onToast(reason instanceof Error ? reason.message : '리포트를 다시 생성하지 못했습니다.')
    } finally { setSaving(false) }
  }

  const saveSettings = async () => {
    if (!canManage) return
    const total = Object.values(settingsDraft.weights).reduce((sum, weight) => sum + Number(weight || 0), 0)
    if (total !== 100) { onToast('지표 가중치 합계를 100%로 맞춰 주세요.'); return }
    setSaving(true)
    try {
      const request = await fetch('/api/performance/settings', {
        method: 'PATCH', headers: { 'content-type': 'application/json', ...requestHeaders }, body: JSON.stringify(settingsDraft),
      })
      const body = await request.json() as { settings?: PerformanceSettings; error?: { message?: string } }
      if (!request.ok) throw new Error(body.error?.message || '성과 설정을 저장하지 못했습니다.')
      setResponse((current) => current ? { ...current, settings: normalizeSettings(body.settings) } : current)
      closeSettings()
      onToast('성과 지표 가중치와 직원 공개 설정을 저장했습니다.')
    } catch (reason) { onToast(reason instanceof Error ? reason.message : '성과 설정을 저장하지 못했습니다.') }
    finally { setSaving(false) }
  }

  const periodLabel = response?.period.label || (periodType === 'month' ? formatYearMonthLabel(anchor) : `${new Date(`${anchor}T00:00:00`).getFullYear()}년 ${Math.floor(new Date(`${anchor}T00:00:00`).getMonth() / 3) + 1}분기`)

  return <div className="performance-page">
    <aside className="performance-caution" role="note"><Gauge size={18} /><strong>이 리포트는 인사 결정의 참고 자료입니다.</strong><span>정량 지표와 AI 요약은 업무 맥락을 대신하지 않습니다.</span></aside>

    <header className="performance-header">
      <div><span className="eyebrow">PEOPLE INSIGHT</span><h1>{canManage ? '직원 성과' : '내 성과'}</h1><p>{canManage ? '기존 업무·결재·업무일지 기록만으로 기간별 흐름을 확인합니다.' : '관리자가 공개한 내 업무·결재·업무일지 기반 리포트만 확인합니다.'}</p></div>
      {canManage && <div className="performance-actions">
        <Button tone="secondary" type="button" onClick={() => setSettingsOpen(true)}><Settings2 size={17} /> 지표 설정</Button>
        <Button tone="primary" type="button" disabled={saving} onClick={() => void generate()}><RefreshCw size={17} /> {saving ? '생성 중' : '수동 재생성'}</Button>
      </div>}
    </header>

    <section className="performance-toolbar" aria-label="성과 조회 조건">
      <div className="segmented performance-period" role="group" aria-label="조회 기간 단위">
        <button type="button" className={periodType === 'month' ? 'active' : ''} aria-pressed={periodType === 'month'} onClick={() => setPeriodType('month')}>월간</button>
        <button type="button" className={periodType === 'quarter' ? 'active' : ''} aria-pressed={periodType === 'quarter'} onClick={() => setPeriodType('quarter')}>분기</button>
      </div>
      <label><span>기준일</span><input type="date" value={anchor} onChange={(event) => setAnchor(event.target.value)} /></label>
      {canManage && <label className="performance-search"><span>직원 검색</span><input type="search" value={query} placeholder="이름·부서·직무" onChange={(event) => setQuery(event.target.value)} /></label>}
      <div className="performance-period-copy"><CalendarRange size={17} /><div><strong>{periodLabel}</strong><small>{response?.generatedAt ? `${formatDateTime(response.generatedAt)} 생성` : '생성 전'}</small></div></div>
    </section>

    {loading ? <div className="performance-empty"><RefreshCw className="spin" size={24} /><strong>성과 기록을 계산하고 있습니다</strong></div>
      : privateReport ? <div className="performance-empty performance-private"><LockKeyhole size={28} /><strong>내 성과 리포트는 현재 비공개입니다</strong><p>관리자가 직원 공개를 켜면 이곳에서 본인 리포트만 확인할 수 있습니다.</p></div>
      : error ? <div className="performance-empty"><strong>{error}</strong><Button tone="secondary" type="button" onClick={() => void loadReports()}>다시 시도</Button></div>
        : reports.length === 0 ? <div className="performance-empty"><BarChart3 size={28} /><strong>이 기간에 산출할 기록이 없습니다</strong><p>업무 완료와 일지 제출 기록이 쌓이면 자동으로 생성됩니다.{canManage ? ' 업무지시·결재와 일일업무일지를 사용하면 다음 조회부터 리포트가 채워집니다.' : ''}</p></div>
          : <>
          {activeReports.length > 0 && <section className="performance-summary-strip" aria-label={`${periodLabel} 성과 요약`}>
            <article><span className="performance-summary-icon blue"><BarChart3 size={19} /></span><div><small>평균 가중 점수</small><strong>{summary.averageScore ?? 'N/A'}</strong><p>{summary.scoredCount}명 산출 기준</p></div></article>
            <article><span className="performance-summary-icon green"><CheckCircle2 size={19} /></span><div><small>완료 업무 합계</small><strong>{summary.totalCompleted}건</strong><p>{periodLabel} 승인 완료</p></div></article>
            <article><span className="performance-summary-icon teal"><CalendarRange size={19} /></span><div><small>평균 기한 준수율</small><strong>{summary.averageCompliance === null ? 'N/A' : `${summary.averageCompliance}%`}</strong><p>마감 내 완료 비율</p></div></article>
            {canManage && <article><span className="performance-summary-icon violet"><UserRoundCheck size={19} /></span><div><small>기간 최고 점수</small><strong>{summary.top ? summary.top.employeeName : '—'}</strong><p>{summary.top ? `${scoreValue(summary.top.score)}점 · ${summary.top.team}` : '산출된 점수 없음'}</p></div></article>}
          </section>}
          {activeReports.length === 0 && <div className="performance-empty"><BarChart3 size={28} /><strong>{periodLabel}에는 아직 산출된 성과 기록이 없습니다</strong><p>업무를 완료하고 결재·업무일지가 쌓이면 직원별 리포트가 여기에 생깁니다.</p></div>}
          <section className="performance-grid" aria-label={`${periodLabel} 직원별 성과 리포트`}>
            {activeReports.map((report) => <article className="performance-card" key={report.id}>
              <header>
                <div className="performance-person"><span aria-hidden="true">{report.employeeName.slice(0, 1)}</span><div><h2>{report.employeeName}</h2><p>{report.team} · {report.jobRole || '직무 미지정'}</p></div></div>
                <div className={`performance-score ${scoreTone(report.score)}`}><small>가중 점수</small><strong>{scoreValue(report.score)}</strong></div>
              </header>
              {(() => {
                const filled = metricDefinitions.filter((metric) => {
                  const raw = report.metrics[metric.key]
                  return raw !== null && Number.isFinite(raw)
                })
                if (filled.length === 0) return <p className="performance-no-metrics">이 기간에는 집계된 업무·일지 기록이 없습니다.</p>
                return <dl className="performance-metrics">
                  {filled.map((metric) => {
                    const Icon = metric.icon
                    const raw = report.metrics[metric.key] as number
                    const showBar = metric.unit === '%'
                    return <div key={metric.key}><dt><Icon size={15} />{metric.label}</dt><dd>{metricValue(report.metrics, metric.key)}</dd>{showBar && <progress className={metric.inverse ? 'is-inverse' : ''} max={100} value={Math.max(0, Math.min(100, raw))} aria-hidden="true" />}</div>
                  })}
                </dl>
              })()}
              <p className="performance-lead"><Sparkles size={15} /> {report.narrative.strengths[0]}</p>
              <details className="performance-narrative">
                <summary>{report.narrative.mode === 'ai' ? 'AI 요약·제안 자세히 보기' : '요약·제안 자세히 보기'}</summary>
                <ol>
                  <li><span>{report.score === null ? '근거 상태' : '확인 사실'}</span>{report.narrative.strengths[1]}</li>
                  <li><span>{report.score === null ? '평가 안내' : '개선 제안'}</span>{report.narrative.improvement}</li>
                  <li><span>다음 제안</span>{report.narrative.suggestion}</li>
                </ol>
                {report.narrative.conflictNote && <p className="performance-conflict"><TrendingUp size={15} />{report.narrative.conflictNote}</p>}
              </details>
              {report.narrative.evidence.length > 0 && <footer><span>평가 근거</span><div>{report.narrative.evidence.slice(0, 4).map((evidence) => evidence.kind === 'journal'
                ? <span className="performance-evidence-label" key={evidence.id}>{evidence.title}</span>
                : <button type="button" key={evidence.id} onClick={() => onOpenTask(evidence.id)}>{evidence.title}</button>)}</div></footer>}
            </article>)}
          </section>
          {idleReports.length > 0 && <section className="performance-idle-strip" aria-label="이번 기간 기록이 없는 직원">
            <div><strong>기록 없는 직원</strong><span>{idleReports.length}명 · 업무·일지 기록이 쌓이면 카드가 생깁니다</span></div>
            <div className="performance-idle-names">{idleReports.map((report) => <span key={report.id}><i aria-hidden="true">{report.employeeName.slice(0, 1)}</i>{report.employeeName}</span>)}</div>
          </section>}
          </>}

    {canManage && settingsOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeSettings() }}>
      <section ref={settingsDialogRef} className="modal-card performance-settings" role="dialog" aria-modal="true" aria-labelledby="performance-settings-title" tabIndex={-1}>
        <header><div><span className="eyebrow">SCORING POLICY</span><h2 id="performance-settings-title">성과 지표 설정</h2></div><IconButton tone="ghost" type="button" aria-label="성과 설정 닫기" onClick={closeSettings}><X size={19} /></IconButton></header>
        <p>각 지표의 가중치 합계는 100%여야 합니다. 변경 후 과거 월별 스냅샷은 바뀌지 않습니다.</p>
        <div className="performance-weight-list">
          {metricDefinitions.map((metric) => <label key={metric.key}><span>{metric.label}</span><div><input type="number" min="0" max="100" value={settingsDraft.weights[metric.key]} onChange={(event) => setSettingsDraft((current) => ({ ...current, weights: { ...current.weights, [metric.key]: Number(event.target.value) } }))} /><span>%</span></div></label>)}
        </div>
        <label className="performance-visibility"><input type="checkbox" checked={settingsDraft.employeeVisible} onChange={(event) => setSettingsDraft((current) => ({ ...current, employeeVisible: event.target.checked }))} /><span><strong>직원 본인에게 공개</strong><small>활성화해도 각 직원은 자기 리포트만 볼 수 있습니다. 기본값은 비공개입니다.</small></span></label>
        <footer><span>현재 합계 <strong>{Object.values(settingsDraft.weights).reduce((sum, value) => sum + Number(value || 0), 0)}%</strong></span><div><Button tone="secondary" type="button" onClick={closeSettings}>취소</Button><Button tone="primary" type="button" disabled={saving} onClick={() => void saveSettings()}>설정 저장</Button></div></footer>
      </section>
    </div>}
  </div>
}

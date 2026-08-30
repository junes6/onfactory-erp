import { useEffect, useState } from 'react'
import { BriefcaseBusiness, CalendarClock, ExternalLink, RefreshCw } from 'lucide-react'
import { formatShortDateTime, seoulDateInputValue } from '../utils/dateTime'
import './SupportProgramsWidget.css'
import { Button } from './ui/Button'

type SupportProgram = {
  id: string
  source: 'kstartup' | 'bizinfo'
  sourceLabel: string
  title: string
  agency: string
  operator: string
  category: string
  target: string
  region: string
  summary: string
  startsOn: string | null
  endsOn: string | null
  periodRaw: string | null
  publishedAt: string | null
  detailUrl: string
}

type SourceState = { state: 'live' | 'public' | 'stale' | 'unconfigured' | 'permission-required' | 'error' | 'not-requested'; syncedAt: string | null }
type SupportProgramsResponse = {
  items: SupportProgram[]
  syncedAt: string | null
  stale: boolean
  sources: { kstartup: SourceState; bizinfo: SourceState }
  officialLinks: Array<{ source: string; label: string; url: string }>
}

function deadlineLabel(endsOn: string | null) {
  if (!endsOn) return '기간 확인'
  const today = seoulDateInputValue()
  const [todayYear, todayMonth, todayDay] = today.split('-').map(Number)
  const [endYear, endMonth, endDay] = endsOn.split('-').map(Number)
  const days = Math.round((Date.UTC(endYear, endMonth - 1, endDay) - Date.UTC(todayYear, todayMonth - 1, todayDay)) / 86_400_000)
  if (days < 0) return '마감'
  if (days === 0) return '오늘 마감'
  return `D-${days}`
}

function syncLabel(value: string | null) {
  if (!value) return ''
  return formatShortDateTime(value, '')
}

export function SupportProgramsWidget({ workspaceScope }: { workspaceScope?: string }) {
  const [feed, setFeed] = useState<SupportProgramsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    fetch('/api/support-programs?source=all&limit=4', {
      headers: workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined,
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json() as SupportProgramsResponse & { error?: { message?: string } }
        if (!response.ok || !Array.isArray(body.items) || !Array.isArray(body.officialLinks)) throw new Error(body.error?.message || '지원사업 공고를 불러오지 못했습니다.')
        setFeed(body)
      })
      .catch((reason) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        setFeed(null)
        setError(reason instanceof Error ? reason.message : '지원사업 공고를 불러오지 못했습니다.')
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [reloadKey, workspaceScope])

  const connected = feed && Object.values(feed.sources).some((source) => ['live', 'public', 'stale'].includes(source.state))

  return <section className="support-program-widget dashboard-section-card" aria-labelledby="support-program-title">
    <header className="dashboard-section-header"><div className="dashboard-section-title"><span className="dashboard-section-icon"><BriefcaseBusiness size={18} /></span><h2 id="support-program-title">정부 지원사업 공고</h2></div><Button tone="quiet" type="button" disabled={loading} onClick={() => setReloadKey((value) => value + 1)}><RefreshCw size={15} /> 새로고침</Button></header>
    <div className="support-program-body dashboard-section-body">
      {loading && <div className="support-program-state"><RefreshCw size={20} /><strong>공식 공고를 확인하는 중입니다</strong></div>}
      {!loading && error && <div className="support-program-state is-error"><BriefcaseBusiness size={20} /><strong>{error}</strong><span>아래 공식 공고 페이지에서 바로 확인할 수 있습니다.</span></div>}
      {!loading && feed?.stale && <p className="support-program-stale">마지막 동기화 자료입니다. 지원 전 공식 공고에서 마감 여부를 다시 확인해 주세요.</p>}
      {!loading && feed && feed.items.length > 0 && <div className="support-program-list">{feed.items.map((program) => <a href={program.detailUrl} target="_blank" rel="noreferrer noopener" key={program.id}>
        <span className={`support-source is-${program.source}`}>{program.sourceLabel}</span>
        <div><strong>{program.title}</strong><small>{program.agency || program.operator || '주관기관 확인'} · {program.endsOn ? `${program.endsOn.slice(5).replace('-', '.')} 마감` : program.periodRaw || '접수기간 확인'}</small></div>
        <span className="support-deadline"><CalendarClock size={14} /> {deadlineLabel(program.endsOn)}</span>
        <ExternalLink size={14} />
      </a>)}</div>}
      {!loading && feed?.sources.kstartup.state === 'public' && <p className="support-program-source-note">K-Startup 공식 페이지에서 모집 공고 제목을 간단히 가져왔습니다.</p>}
      {!loading && feed?.sources.bizinfo.state === 'permission-required' && <p className="support-program-source-note">기업마당은 이용 허가 확인 후 공고 제목까지 연동됩니다.</p>}
      {!loading && feed && feed.items.length === 0 && <div className="support-program-state"><BriefcaseBusiness size={20} /><strong>{connected ? '현재 표시할 모집 공고가 없습니다' : '공공데이터 연동 전입니다'}</strong><span>{connected ? '공식 사이트에서 전체 공고를 확인해 주세요.' : '연동키 설정 전에도 공식 모집 페이지는 바로 열 수 있습니다.'}</span></div>}
      {!loading && feed?.syncedAt && <p className="support-program-synced">마지막 동기화 {syncLabel(feed.syncedAt)}</p>}
      {!loading && <div className="support-official-links">{(feed?.officialLinks ?? [
        { source: 'kstartup', label: 'K-Startup 모집중 공고', url: 'https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do' },
        { source: 'bizinfo', label: '기업마당 지원사업 공고', url: 'https://www.bizinfo.go.kr/sii/siia/selectSIIA200View.do' },
      ]).map((link) => <a href={link.url} target="_blank" rel="noreferrer noopener" key={link.source}>{link.label} <ExternalLink size={13} /></a>)}</div>}
    </div>
  </section>
}

import { useEffect, useMemo, useState } from 'react'
import { BriefcaseBusiness, CalendarClock, ChevronDown, ExternalLink, RefreshCw, Sparkles, Target } from 'lucide-react'
import { formatShortDateTime, seoulDateInputValue } from '../utils/dateTime'
import './SupportProgramsWidget.css'
import { Button } from './ui/Button'
import { StatusBadge } from './StatusBadge'

type SupportProgramSource = 'kstartup' | 'bizinfo' | 'g2b' | 'ulsan'

type Relevance = {
  score: number
  reasons: string[]
  matchedKeywords: string[]
  daysToDeadline: number | null
  closed: boolean
}

type SupportProgram = {
  id: string
  source: SupportProgramSource
  sourceLabel: string
  title: string
  agency: string
  operator: string
  category: string
  target: string
  region: string
  summary: string
  amount?: number
  noticeNo?: string
  startsOn: string | null
  endsOn: string | null
  periodRaw: string | null
  publishedAt: string | null
  detailUrl: string
  relevance: Relevance
}

type SourceState = { state: 'live' | 'public' | 'stale' | 'unconfigured' | 'permission-required' | 'error' | 'not-requested'; syncedAt: string | null }
type SupportProgramsResponse = {
  items: SupportProgram[]
  syncedAt: string | null
  stale: boolean
  sort: 'recommended' | 'deadline'
  summary: { total: number; open: number; closed: number; closingSoon: number; recommended: number; top: SupportProgram | null }
  profile: { keywords: string[]; regions: string[]; minAmount: number }
  sources: Record<SupportProgramSource, SourceState>
  officialLinks: Array<{ source: string; label: string; url: string }>
}

const CONNECTED_STATES = ['live', 'public', 'stale']

function deadlineLabel(program: SupportProgram) {
  const days = program.relevance.daysToDeadline
  if (days === null) return '기간 확인'
  if (days < 0) return '마감'
  if (days === 0) return '오늘 마감'
  return `D-${days}`
}

const amountLabel = (amount?: number) => (amount && amount > 0 ? `${Math.round(amount / 10_000).toLocaleString('ko-KR')}만원` : '')

const syncLabel = (value: string | null) => (value ? formatShortDateTime(value, '') : '')

/** 관련성 점수를 쉬운 말로. 숫자만 보여 주면 무엇을 뜻하는지 알 수 없다. */
function relevanceTone(score: number): { label: string; tone: 'success' | 'info' | 'neutral' } {
  if (score >= 0.6) return { label: '적합', tone: 'success' }
  if (score >= 0.4) return { label: '검토', tone: 'info' }
  return { label: '참고', tone: 'neutral' }
}

export function SupportProgramsWidget({ workspaceScope }: { workspaceScope?: string }) {
  const [feed, setFeed] = useState<SupportProgramsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [sort, setSort] = useState<'recommended' | 'deadline'>('recommended')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    fetch(`/api/support-programs?source=all&limit=8&sort=${sort}`, {
      headers: workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined,
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json() as SupportProgramsResponse & { error?: { message?: string } }
        if (!response.ok || !Array.isArray(body.items) || !Array.isArray(body.officialLinks)) throw new Error(body.error?.message || '공고를 불러오지 못했습니다.')
        setFeed(body)
      })
      .catch((reason) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        setFeed(null)
        setError(reason instanceof Error ? reason.message : '공고를 불러오지 못했습니다.')
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [reloadKey, sort, workspaceScope])

  const connected = useMemo(
    () => Boolean(feed && Object.values(feed.sources).some((source) => CONNECTED_STATES.includes(source.state))),
    [feed],
  )
  const watchSummary = feed?.profile.keywords.length
    ? `감시 키워드 ${feed.profile.keywords.slice(0, 3).join(' · ')}${feed.profile.keywords.length > 3 ? ` 외 ${feed.profile.keywords.length - 3}개` : ''} 기준`
    : '감시 키워드를 등록하면 추천 정확도가 올라갑니다'

  return <section className="support-program-widget dashboard-section-card" aria-labelledby="support-program-title">
    <header className="dashboard-section-header">
      <div className="dashboard-section-title"><span className="dashboard-section-icon"><BriefcaseBusiness size={18} /></span><h2 id="support-program-title">지원사업 · 입찰 공고</h2></div>
      <Button tone="quiet" type="button" disabled={loading} onClick={() => setReloadKey((value) => value + 1)}><RefreshCw size={15} /> 새로고침</Button>
    </header>
    <div className="support-program-body dashboard-section-body">
      {loading && <div className="support-program-state"><RefreshCw size={20} /><strong>공식 공고를 확인하는 중입니다</strong></div>}
      {!loading && error && <div className="support-program-state is-error"><BriefcaseBusiness size={20} /><strong>{error}</strong><span>아래 공식 공고 페이지에서 바로 확인할 수 있습니다.</span></div>}

      {!loading && feed && feed.summary.total > 0 && <>
        {/* 목록을 열지 않고도 "지금 무엇이 급한가"를 먼저 읽는다. */}
        <dl className="support-program-summary" aria-label="공고 요약">
          <div><dt>모집 중</dt><dd>{feed.summary.open}건</dd></div>
          <div className={feed.summary.recommended > 0 ? 'is-highlight' : ''}><dt>우리와 맞는 건</dt><dd>{feed.summary.recommended}건</dd></div>
          <div className={feed.summary.closingSoon > 0 ? 'is-urgent' : ''}><dt>7일 내 마감</dt><dd>{feed.summary.closingSoon}건</dd></div>
        </dl>
        <div className="support-program-controls">
          <div className="support-program-sort" role="group" aria-label="정렬 기준">
            <button type="button" aria-pressed={sort === 'recommended'} onClick={() => setSort('recommended')}>추천순</button>
            <button type="button" aria-pressed={sort === 'deadline'} onClick={() => setSort('deadline')}>마감순</button>
          </div>
          <p className="support-program-watch"><Target size={13} /> {watchSummary}</p>
        </div>
      </>}

      {!loading && feed?.stale && <p className="support-program-stale">마지막 동기화 자료입니다. 지원 전 공식 공고에서 마감 여부를 다시 확인해 주세요.</p>}

      {!loading && feed && feed.items.length > 0 && <ul className="support-program-list">{feed.items.map((program) => {
        const expanded = expandedId === program.id
        const fit = relevanceTone(program.relevance.score)
        return <li key={program.id} className={`support-program-row${expanded ? ' is-open' : ''}${program.relevance.closed ? ' is-closed' : ''}`}>
          <button type="button" className="support-program-head" aria-expanded={expanded} onClick={() => setExpandedId(expanded ? null : program.id)}>
            <span className={`support-source is-${program.source}`}>{program.sourceLabel}</span>
            <span className="support-program-heading">
              <strong>{program.title}</strong>
              <small>{program.agency || program.operator || '주관기관 확인'}{program.region ? ` · ${program.region}` : ''}{amountLabel(program.amount) ? ` · ${amountLabel(program.amount)}` : ''}</small>
            </span>
            <StatusBadge className="status-pill" tone={fit.tone}>{fit.label}</StatusBadge>
            <span className="support-deadline"><CalendarClock size={14} /> {deadlineLabel(program)}</span>
            <ChevronDown size={16} className="support-program-caret" />
          </button>
          {expanded && <div className="support-program-detail">
            {/* 왜 이 순서로 보이는지 먼저 밝힌다. 근거 없는 추천은 신뢰할 수 없다. */}
            <p className="support-program-why"><Sparkles size={13} /> {program.relevance.reasons.join(' · ')}</p>
            {program.summary && <p className="support-program-abstract">{program.summary}</p>}
            <dl className="support-program-facts">
              {program.category && <div><dt>분야</dt><dd>{program.category}</dd></div>}
              {program.target && <div><dt>지원대상</dt><dd>{program.target}</dd></div>}
              {(program.periodRaw || program.endsOn) && <div><dt>접수기간</dt><dd>{program.periodRaw || `${program.startsOn ?? ''} ~ ${program.endsOn ?? ''}`}</dd></div>}
              {amountLabel(program.amount) && <div><dt>사업 규모</dt><dd>{amountLabel(program.amount)}</dd></div>}
              {program.noticeNo && <div><dt>공고번호</dt><dd>{program.noticeNo}</dd></div>}
              {program.publishedAt && <div><dt>공고일</dt><dd>{program.publishedAt}</dd></div>}
            </dl>
            {!program.summary && !program.target && !program.category && <p className="support-program-abstract is-empty">이 공고는 제목과 기간만 공개돼 있습니다. 상세 내용은 공식 공고에서 확인하세요.</p>}
            <a className="support-program-open" href={program.detailUrl} target="_blank" rel="noreferrer noopener">공식 공고 열기 <ExternalLink size={13} /></a>
          </div>}
        </li>
      })}</ul>}

      {!loading && feed?.sources.kstartup.state === 'public' && <p className="support-program-source-note">K-Startup 공식 페이지에서 모집 공고 제목을 간단히 가져왔습니다.</p>}
      {!loading && feed?.sources.bizinfo.state === 'permission-required' && <p className="support-program-source-note">기업마당은 이용 허가 확인 후 공고 제목까지 연동됩니다.</p>}
      {!loading && feed && (feed.sources.g2b.state === 'unconfigured' || feed.sources.ulsan.state === 'unconfigured') && <p className="support-program-source-note">나라장터·울산광역시 공고는 연동키 설정 후 같은 목록에 함께 표시됩니다.</p>}
      {!loading && feed && feed.items.length === 0 && <div className="support-program-state"><BriefcaseBusiness size={20} /><strong>{connected ? '현재 표시할 공고가 없습니다' : '공공데이터 연동 전입니다'}</strong><span>{connected ? '공식 사이트에서 전체 공고를 확인해 주세요.' : '연동키 설정 전에도 공식 모집 페이지는 바로 열 수 있습니다.'}</span></div>}
      {!loading && feed?.syncedAt && <p className="support-program-synced">마지막 동기화 {syncLabel(feed.syncedAt)}</p>}
      {!loading && <div className="support-official-links">{(feed?.officialLinks ?? [
        { source: 'kstartup', label: 'K-Startup 모집중 공고', url: 'https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do' },
        { source: 'bizinfo', label: '기업마당 지원사업 공고', url: 'https://www.bizinfo.go.kr/sii/siia/selectSIIA200View.do' },
      ]).map((link) => <a href={link.url} target="_blank" rel="noreferrer noopener" key={link.source}>{link.label} <ExternalLink size={13} /></a>)}</div>}
    </div>
  </section>
}

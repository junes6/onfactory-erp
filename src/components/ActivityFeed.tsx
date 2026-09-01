import { useCallback, useEffect, useState } from 'react'
import { Activity, ArrowRight, CheckCircle2, ClipboardCheck, FileSignature, NotebookPen, Radar, RefreshCw, ShieldAlert } from 'lucide-react'
import { formatShortDateTime } from '../utils/dateTime'
import { useEventStream } from '../hooks/useEventStream'
import { Button } from './ui/Button'
import './ActivityFeed.css'

type ActivityKind =
  | 'work-created' | 'work-submitted' | 'work-approved' | 'work-changes-requested'
  | 'journal-submitted' | 'proposal-created' | 'proposal-decided' | 'sentinel-warning' | 'opportunity-new'

type ActivityRow = { id: string; kind: ActivityKind; at: string; title: string; detail: string; page: string; focusId: string }

const kindIcon: Record<ActivityKind, typeof Activity> = {
  'work-created': ClipboardCheck,
  'work-submitted': FileSignature,
  'work-approved': CheckCircle2,
  'work-changes-requested': ShieldAlert,
  'journal-submitted': NotebookPen,
  'proposal-created': Activity,
  'proposal-decided': CheckCircle2,
  'sentinel-warning': ShieldAlert,
  'opportunity-new': Radar,
}

const kindTone: Record<ActivityKind, string> = {
  'work-created': 'blue',
  'work-submitted': 'blue',
  'work-approved': 'green',
  'work-changes-requested': 'amber',
  'journal-submitted': 'violet',
  'proposal-created': 'blue',
  'proposal-decided': 'green',
  'sentinel-warning': 'amber',
  'opportunity-new': 'green',
}

/**
 * 회사에서 지금 일어나는 일. 서버가 기존 기록에서 파생해 주므로 별도의 활동 로그가 없다.
 * 권한 필터는 서버에서 끝나 있어, 여기서 숨기는 항목은 없다.
 */
export function ActivityFeed({ workspaceScope, onOpen }: {
  workspaceScope?: string
  onOpen: (page: string, focusId: string) => void
}) {
  const [rows, setRows] = useState<ActivityRow[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/activity?limit=12', {
        headers: workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined,
      })
      if (!response.ok) return
      const body = await response.json() as { items: ActivityRow[] }
      setRows(Array.isArray(body.items) ? body.items : [])
    } catch { /* 다음 이벤트에서 다시 읽는다 */ } finally { setLoading(false) }
  }, [workspaceScope])

  useEffect(() => { void load() }, [load])
  // 폴링하지 않는다. 무언가 바뀌었다는 신호가 올 때만 다시 읽는다.
  useEventStream(true, (event) => {
    if (['work', 'proposal', 'message', 'activity', 'resync'].includes(event.kind)) void load()
  })

  return <section className="activity-feed dashboard-section-card" aria-labelledby="activity-feed-title">
    <header className="dashboard-section-header">
      <div className="dashboard-section-title"><span className="dashboard-section-icon"><Activity size={18} /></span><h2 id="activity-feed-title">지금 회사에서</h2></div>
      <Button tone="quiet" type="button" onClick={() => void load()}><RefreshCw size={15} /> 새로고침</Button>
    </header>
    <div className="activity-feed-body dashboard-section-body">
      {loading && <p className="activity-feed-empty">활동을 불러오는 중입니다.</p>}
      {!loading && rows.length === 0 && <div className="activity-feed-empty-state">
        <Activity size={22} />
        <strong>아직 오늘의 활동이 없습니다</strong>
        <span>업무·일지·결재가 오가면 여기에 시간순으로 쌓입니다.</span>
      </div>}
      {!loading && rows.length > 0 && <ol className="activity-feed-list">{rows.map((row) => {
        const Icon = kindIcon[row.kind] ?? Activity
        return <li key={row.id}>
          <button type="button" onClick={() => onOpen(row.page, row.focusId)}>
            <span className={`activity-dot ${kindTone[row.kind] ?? 'blue'}`}><Icon size={14} /></span>
            <span className="activity-copy">
              <strong>{row.title}</strong>
              {row.detail && <small>{row.detail}</small>}
            </span>
            <time dateTime={row.at}>{formatShortDateTime(row.at, '')}</time>
            <ArrowRight size={14} />
          </button>
        </li>
      })}</ol>}
    </div>
  </section>
}

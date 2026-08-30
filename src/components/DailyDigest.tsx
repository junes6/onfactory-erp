import { useCallback, useEffect, useState } from 'react'
import { ArrowRight, RefreshCw, Sunrise, Sunset } from 'lucide-react'
import { formatDateLabel, formatShortDateTime } from '../utils/dateTime'
import { Button } from './ui/Button'
import './DailyDigest.css'

export type DigestEdition = 'morning' | 'evening'
export type DigestRef = { type: 'work-item' | 'page'; id?: string; page?: string } | null
export type DigestLine = { id: string; kind: string; text: string; ref: DigestRef }
export type Digest = { id: string; date: string; edition: DigestEdition; lines: DigestLine[]; generatedAt: string; generatedBy: string }
type DigestSummary = { id: string; date: string; edition: DigestEdition; lineCount: number }
type DigestResponse = { digest: Digest | null; edition: DigestEdition; date: string; isToday: boolean; history: DigestSummary[] }

const EDITION_LABEL: Record<DigestEdition, string> = { morning: '아침 브리핑', evening: '저녁 브리핑' }

/**
 * 대표 브리핑. 그날 첫 접속에 아침판, 17시 이후 첫 접속에 저녁판을 만든다.
 * 데이터가 없는 항목은 줄을 만들지 않으므로, 줄이 하나도 없으면 "오늘은 짚을 것이 없다"고만 말한다.
 */
export function DailyDigest({ workspaceScope, onToast, onOpenTask, onNavigate }: {
  workspaceScope?: string
  onToast: (message: string) => void
  onOpenTask: (taskId: string) => void
  onNavigate: (page: string) => void
}) {
  const [state, setState] = useState<DigestResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [viewingDate, setViewingDate] = useState('')

  const headers = workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined

  const load = useCallback(async (date?: string, edition?: DigestEdition) => {
    setLoading(true)
    try {
      const query = new URLSearchParams()
      if (date) query.set('date', date)
      if (edition) query.set('edition', edition)
      const response = await fetch(`/api/digest${query.size ? `?${query}` : ''}`, { headers })
      if (!response.ok) return
      setState(await response.json() as DigestResponse)
    } catch { /* 브리핑은 보조 카드다. 실패해도 허브를 막지 않는다. */ }
    finally { setLoading(false) }
  }, [workspaceScope]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void load() }, [load])

  const regenerate = async () => {
    setBusy(true)
    try {
      const response = await fetch('/api/digest/regenerate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(headers ?? {}) },
        body: JSON.stringify({ edition: state?.edition }),
      })
      const body = await response.json() as DigestResponse & { error?: { message?: string } }
      if (!response.ok) throw new Error(body.error?.message || '브리핑을 다시 만들지 못했습니다.')
      setState(body)
      setViewingDate('')
      onToast('브리핑을 다시 만들었습니다.')
    } catch (error) { onToast(error instanceof Error ? error.message : '브리핑을 다시 만들지 못했습니다.') }
    finally { setBusy(false) }
  }

  if (loading && !state) return null
  if (!state) return null

  const digest = state.digest
  const Icon = state.edition === 'evening' ? Sunset : Sunrise
  const past = state.history.filter((item) => item.date !== state.date)

  return <section className="daily-digest" aria-labelledby="daily-digest-title">
    <header>
      <div>
        <span className="daily-digest-kicker"><Icon size={14} /> {EDITION_LABEL[state.edition]}</span>
        <h2 id="daily-digest-title">{formatDateLabel(state.date, true, true)}</h2>
        {digest && <small>{formatShortDateTime(digest.generatedAt)} 기준</small>}
      </div>
      <div className="daily-digest-actions">
        {past.length > 0 && <label>
          <span className="sr-only">지난 브리핑</span>
          <select
            value={viewingDate}
            onChange={(event) => {
              const value = event.target.value
              setViewingDate(value)
              const entry = past.find((item) => `${item.date}:${item.edition}` === value)
              void (entry ? load(entry.date, entry.edition) : load())
            }}
          >
            <option value="">오늘</option>
            {past.slice(0, 30).map((item) => <option key={item.id} value={`${item.date}:${item.edition}`}>{item.date} {EDITION_LABEL[item.edition]}</option>)}
          </select>
        </label>}
        {state.isToday && <Button tone="ghost" size="sm" disabled={busy} onClick={() => void regenerate()}><RefreshCw size={14} /> {busy ? '만드는 중…' : '다시 생성'}</Button>}
      </div>
    </header>

    {!digest
      ? <p className="daily-digest-empty">그날 저장된 브리핑이 없습니다.</p>
      : digest.lines.length === 0
        ? <p className="daily-digest-empty">{state.edition === 'evening' ? '오늘 넘길 일도, 내일 급한 일도 없습니다.' : '지금 먼저 볼 것이 없습니다. 새 업무나 제안이 생기면 여기에 모아 드립니다.'}</p>
        : <ol className="daily-digest-lines">{digest.lines.map((line) => <li key={line.id}>
          <span className="daily-digest-kind">{line.kind}</span>
          <span className="daily-digest-text">{line.text}</span>
          {line.ref?.type === 'work-item' && line.ref.id && <button type="button" onClick={() => onOpenTask(line.ref!.id!)}>업무 보기 <ArrowRight size={13} /></button>}
          {line.ref?.type === 'page' && line.ref.page && <button type="button" onClick={() => onNavigate(line.ref!.page!)}>{line.ref.page === 'approvals' ? '승인 큐' : '바로가기'} <ArrowRight size={13} /></button>}
        </li>)}</ol>}
  </section>
}

import { useEffect, useState } from 'react'
import { Clock3, LogIn, LogOut } from 'lucide-react'
import { seoulDateInputValue } from '../utils/dateTime'
import { attendanceStatus, isAttendanceState, seoulClockTime, type AttendanceRecord } from '../utils/attendance'
import { Button } from './ui/Button'

type Response = { data?: unknown; canClock?: boolean; error?: { message?: string } }
const monthDay = (workDate: string) => `${Number(workDate.slice(5, 7))}월 ${Number(workDate.slice(8, 10))}일`

/**
 * 휴대폰 '오늘' 맨 위의 출퇴근 한 줄. 전에는 더보기 › 인사 › 출퇴근 탭까지 세 번 들어가야 출근을 찍었다
 * (감사 business-admin-16 — 현장에서 휴대폰으로 찍는 사람이 가장 많다). 퇴근을 빠뜨린 날은 여기서 그 시각을 적고 출근한다.
 */
export function MobileAttendanceCard({ workspaceScope, currentUserId, onToast }: { workspaceScope?: string; currentUserId: string; onToast: (message: string) => void }) {
  const [records, setRecords] = useState<AttendanceRecord[] | null>(null)
  const [canClock, setCanClock] = useState(false)
  const [busy, setBusy] = useState(false)
  const [missedTime, setMissedTime] = useState('18:00')
  const headers = { 'content-type': 'application/json', ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}) }

  useEffect(() => {
    let active = true
    fetch('/api/attendance', { headers })
      .then(async (response) => ({ ok: response.ok, body: await response.json() as Response }))
      .then(({ ok, body }) => { if (!active || !ok || !isAttendanceState(body.data)) return; setRecords(body.data.records); setCanClock(Boolean(body.canClock)) })
      .catch(() => undefined)
    return () => { active = false }
  }, [workspaceScope]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!records || !canClock) return null
  const now = new Date()
  const today = seoulDateInputValue(now)
  const mine = records.filter((record) => record.accountId === currentUserId)
  const open = mine.find((record) => !record.clockOutAt)
  const missed = open && attendanceStatus(open, now) === '미퇴근' ? open : undefined
  const todayRecord = mine.find((record) => record.workDate === today)

  const run = async (action: 'clock-in' | 'clock-out', payload: Record<string, string>, message: string) => {
    setBusy(true)
    try {
      const response = await fetch(`/api/attendance/${action}`, { method: 'POST', headers, body: JSON.stringify(payload) })
      const body = await response.json() as Response
      if (!response.ok || !isAttendanceState(body.data)) throw new Error(body.error?.message || '출퇴근 시간을 저장하지 못했습니다.')
      setRecords(body.data.records)
      onToast(message)
    } catch (error) { onToast(error instanceof Error ? error.message : '출퇴근 시간을 저장하지 못했습니다.') }
    finally { setBusy(false) }
  }

  return <section className="mobile-card mobile-attendance" aria-label="출퇴근">
    {missed ? <>
      <h2><Clock3 size={17} /> {monthDay(missed.workDate)} 퇴근을 찍지 않았습니다</h2>
      <label className="mobile-attendance-missed"><span>그날 퇴근한 시각</span><input type="time" value={missedTime} onChange={(event) => setMissedTime(event.target.value)} /></label>
      <Button tone="primary" full disabled={busy || !missedTime || Boolean(todayRecord)} onClick={() => void run('clock-in', { previousClockOutTime: missedTime }, `${monthDay(missed.workDate)} 퇴근 ${missedTime}을 적고 오늘 출근을 기록했습니다.`)}><LogIn size={18} /> 저장하고 오늘 출근</Button>
    </> : open ? <>
      <h2><Clock3 size={17} /> 근무 중 · {seoulClockTime(open.clockInAt)} 출근</h2>
      <Button tone="primary" full disabled={busy} onClick={() => void run('clock-out', {}, '퇴근 시간을 기록했습니다.')}><LogOut size={18} /> {busy ? '저장 중…' : '퇴근하기'}</Button>
    </> : todayRecord ? <h2><Clock3 size={17} /> 오늘 {seoulClockTime(todayRecord.clockInAt)}–{seoulClockTime(todayRecord.clockOutAt)} 근무를 마쳤습니다</h2>
      : <>
        <h2><Clock3 size={17} /> 아직 출근 전입니다</h2>
        <Button tone="primary" full disabled={busy} onClick={() => void run('clock-in', {}, '출근 시간을 기록했습니다.')}><LogIn size={18} /> {busy ? '저장 중…' : '출근하기'}</Button>
      </>}
  </section>
}

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { AlertTriangle, CalendarDays, Clock3, LogIn, LogOut, Pencil, RefreshCw, Save, Users } from 'lucide-react'
import { formatShortDateTime, seoulDateInputValue } from '../utils/dateTime'
import {
  attendanceDurationMinutes,
  attendanceStatus,
  formatAttendanceDuration,
  isAttendanceState,
  seoulClockTime,
  type AttendanceRecord,
  type AttendanceState,
  type AttendanceStatus,
} from '../utils/attendance'
import { StatusBadge, type StatusBadgeTone } from './StatusBadge'
import './AttendancePanel.css'
import { Button } from './ui/Button'

type AttendancePanelProps = {
  canManage: boolean
  currentUserId?: string
  currentUserName: string
  currentUserTeam: string
  workspaceScope?: string
  onToast: (message: string) => void
}

type AttendanceResponse = { data?: unknown; canClock?: boolean; version?: string; error?: { message?: string } }

const emptyState: AttendanceState = { policy: { standardStartTime: '09:00' }, records: [] }

function statusTone(status: AttendanceStatus): StatusBadgeTone {
  if (status === '정상') return 'success'
  if (status === '근무중') return 'info'
  if (status === '지각') return 'warning'
  return 'danger'
}

const monthDay = (workDate: string) => `${Number(workDate.slice(5, 7))}월 ${Number(workDate.slice(8, 10))}일`

/** 정정 기록 한 줄. 직원·관리자 모두 같은 문장으로 읽는다. */
function correctionLine(entry: NonNullable<AttendanceRecord['corrections']>[number]) {
  const field = entry.field === 'clockInAt' ? '출근' : '퇴근'
  const who = entry.kind === 'admin' ? `관리자 ${entry.byName}` : `본인(${entry.byName})`
  return `${formatShortDateTime(entry.at)} · ${who} · ${field} ${entry.before ? seoulClockTime(entry.before) : '없음'} → ${seoulClockTime(entry.after)} · ${entry.reason}`
}

/**
 * 관리자 정정 창. 사유는 필수이고 직원의 기록에 함께 남는다(근태는 급여·노무의 근거).
 * 전에는 기록을 고치는 길이 없었다(감사 work-15).
 */
function AttendanceCorrectionDialog({ record, headers, onClose, onSaved }: {
  record: AttendanceRecord
  headers?: Record<string, string>
  onClose: () => void
  onSaved: (state: AttendanceState, message: string) => void
}) {
  const [clockIn, setClockIn] = useState(seoulClockTime(record.clockInAt))
  const [clockOut, setClockOut] = useState(seoulClockTime(record.clockOutAt))
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true); setError('')
    try {
      const response = await fetch(`/api/attendance/records/${encodeURIComponent(record.id)}`, {
        method: 'PATCH',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ clockInTime: clockIn !== seoulClockTime(record.clockInAt) ? clockIn : '', clockOutTime: clockOut !== seoulClockTime(record.clockOutAt) ? clockOut : '', reason }),
      })
      const body = await response.json() as AttendanceResponse
      if (!response.ok || !isAttendanceState(body.data)) throw new Error(body.error?.message || '정정한 시각을 저장하지 못했습니다.')
      onSaved(body.data, `${record.employeeName}님의 ${monthDay(record.workDate)} 기록을 고쳤습니다.`)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '정정한 시각을 저장하지 못했습니다.'); setBusy(false) }
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()} onKeyDown={(event) => { if (event.key === 'Escape') onClose() }}>
    <section className="modal-card attendance-correction" role="dialog" aria-modal="true" aria-labelledby="attendance-correction-title">
      <header><div><h2 id="attendance-correction-title">{record.employeeName} · {monthDay(record.workDate)} 기록 고치기</h2><p>바꾼 시각과 사유는 직원의 기록에 함께 남습니다.</p></div></header>
      <form onSubmit={submit}>
        <div className="attendance-correction-times">
          <label><span>출근 시각</span><input type="time" value={clockIn} onChange={(event) => setClockIn(event.target.value)} required autoFocus /></label>
          <label><span>퇴근 시각</span><input type="time" value={clockOut} onChange={(event) => setClockOut(event.target.value)} /></label>
        </div>
        <label className="attendance-correction-reason"><span>사유 · 필수</span><textarea rows={2} value={reason} maxLength={200} onChange={(event) => setReason(event.target.value)} placeholder="예: 출입 카드 기록으로 확인 — 단말 오류" required /></label>
        {record.corrections?.length ? <details className="attendance-correction-history"><summary>지난 정정 {record.corrections.length}건</summary><ul>{record.corrections.map((entry) => <li key={`${entry.at}-${entry.field}`}>{correctionLine(entry)}</li>)}</ul></details> : null}
        {error && <p className="attendance-correction-error" role="alert">{error}</p>}
        <footer><Button tone="ghost" type="button" onClick={onClose}>취소</Button><Button tone="primary" type="submit" disabled={busy || reason.trim().length < 2}><Save size={17} /> {busy ? '저장 중…' : '고친 시각 저장'}</Button></footer>
      </form>
    </section>
  </div>
}

function timeLabel(value: string | null) {
  if (!value) return '미기록'
  return formatShortDateTime(value).split(' ').slice(-1)[0] ?? formatShortDateTime(value)
}

export function AttendancePanel({
  canManage,
  currentUserId,
  currentUserName,
  currentUserTeam,
  workspaceScope,
  onToast,
}: AttendancePanelProps) {
  const [state, setState] = useState<AttendanceState>(emptyState)
  const [canClock, setCanClock] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<'clock-in' | 'clock-out' | 'settings' | null>(null)
  const [standardStartTime, setStandardStartTime] = useState(emptyState.policy.standardStartTime)
  const [employeeFilter, setEmployeeFilter] = useState('all')
  const [monthFilter, setMonthFilter] = useState(() => seoulDateInputValue().slice(0, 7))
  const [clockTick, setClockTick] = useState(() => new Date())
  /** 퇴근을 빠뜨린 날의 퇴근 시각. 비워 두지 않고 흔한 퇴근 시각으로 시작한다(고치기만 하면 된다). */
  const [missedTime, setMissedTime] = useState('18:00')
  const [correcting, setCorrecting] = useState<AttendanceRecord | null>(null)

  const headers = useMemo(() => workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined, [workspaceScope])

  const loadAttendance = async (signal?: AbortSignal) => {
    const response = await fetch('/api/attendance', { headers, signal })
    const body = await response.json() as AttendanceResponse
    if (!response.ok || !isAttendanceState(body.data)) throw new Error(body.error?.message || '출퇴근 기록을 불러오지 못했습니다.')
    setState(body.data)
    setStandardStartTime(body.data.policy.standardStartTime)
    setCanClock(Boolean(body.canClock))
  }

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    loadAttendance(controller.signal)
      .catch((error) => { if (!(error instanceof DOMException && error.name === 'AbortError')) onToast(error instanceof Error ? error.message : '출퇴근 기록을 불러오지 못했습니다.') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [headers]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const timer = window.setInterval(() => setClockTick(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const today = seoulDateInputValue(clockTick)
  const myRecords = state.records.filter((record) => record.accountId === currentUserId)
  const openRecord = myRecords.find((record) => !record.clockOutAt)
  const todayRecord = myRecords.find((record) => record.workDate === today)
  // 퇴근을 빠뜨린 지난 날. 이 날은 '오늘 근태'로 보이지 않고, 그날 퇴근 시각을 묻는 칸으로 보인다.
  const missedRecord = openRecord && attendanceStatus(openRecord, clockTick) === '미퇴근' ? openRecord : undefined
  const currentRecord = missedRecord ? todayRecord : openRecord ?? todayRecord
  const employees = useMemo(() => Array.from(new Map(state.records.map((record) => [record.accountId, record])).values())
    .sort((left, right) => left.employeeName.localeCompare(right.employeeName, 'ko')), [state.records])
  const visibleRecords = useMemo(() => state.records
    .filter((record) => record.workDate.startsWith(monthFilter))
    .filter((record) => employeeFilter === 'all' || record.accountId === employeeFilter)
    .sort((left, right) => right.workDate.localeCompare(left.workDate) || right.clockInAt.localeCompare(left.clockInAt)), [employeeFilter, monthFilter, state.records])

  const runAction = async (action: 'clock-in' | 'clock-out', payload?: Record<string, string>, successMessage?: string) => {
    setSaving(action)
    try {
      const response = await fetch(`/api/attendance/${action}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(payload ?? {}) })
      const body = await response.json() as AttendanceResponse
      if (!response.ok || !isAttendanceState(body.data)) throw new Error(body.error?.message || '출퇴근 시간을 저장하지 못했습니다.')
      setState(body.data)
      onToast(successMessage ?? (action === 'clock-in' ? '출근 시간을 기록했습니다.' : '퇴근 시간을 기록했습니다.'))
    } catch (error) {
      onToast(error instanceof Error ? error.message : '출퇴근 시간을 저장하지 못했습니다.')
    } finally {
      setSaving(null)
    }
  }

  const saveSettings = async () => {
    setSaving('settings')
    try {
      const response = await fetch('/api/attendance/settings', {
        method: 'PATCH',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ standardStartTime }),
      })
      const body = await response.json() as AttendanceResponse
      if (!response.ok || !isAttendanceState(body.data)) throw new Error(body.error?.message || '기준 출근 시각을 저장하지 못했습니다.')
      setState(body.data)
      onToast(`기준 출근 시각을 ${body.data.policy.standardStartTime}로 저장했습니다.`)
    } catch (error) {
      onToast(error instanceof Error ? error.message : '기준 출근 시각을 저장하지 못했습니다.')
    } finally {
      setSaving(null)
    }
  }

  const summaryStatus = currentRecord ? attendanceStatus(currentRecord, clockTick) : null
  const monthTotalMinutes = myRecords
    .filter((record) => record.workDate.startsWith(monthFilter))
    .reduce((total, record) => total + attendanceDurationMinutes(record, clockTick), 0)

  return <section className="attendance-panel" aria-labelledby="attendance-title">
    <header className="attendance-panel-head">
      <div><h2 id="attendance-title">출퇴근 관리</h2><p>{canManage ? '직원별 출퇴근과 근무시간을 날짜별로 확인합니다.' : '내 출근·퇴근을 직접 기록하고 월 근무시간을 확인합니다.'}</p></div>
      <Button tone="ghost" type="button" disabled={loading} onClick={() => { setLoading(true); void loadAttendance().catch((error) => onToast(error instanceof Error ? error.message : '새로고침하지 못했습니다.')).finally(() => setLoading(false)) }}><RefreshCw size={17} /> 새로고침</Button>
    </header>

    <div className="attendance-today-card">
      <div className="attendance-identity"><span><Clock3 size={22} /></span><div><small>{today} · {currentUserTeam}</small><strong>{currentUserName}님의 오늘 근태</strong><p>기준 출근 {state.policy.standardStartTime}</p></div></div>
      <div className="attendance-today-times"><div><small>출근</small><strong>{timeLabel(currentRecord?.clockInAt ?? null)}</strong></div><div><small>퇴근</small><strong>{timeLabel(currentRecord?.clockOutAt ?? null)}</strong></div><div><small>총 근무</small><strong>{currentRecord ? formatAttendanceDuration(attendanceDurationMinutes(currentRecord, clockTick)) : '0분'}</strong></div>{summaryStatus && <StatusBadge tone={statusTone(summaryStatus)} dot>{summaryStatus}</StatusBadge>}</div>
      <div className="attendance-actions">
        {!canClock ? <p>운영자 모드에서는 직원 출퇴근을 대신 기록하지 않습니다.</p> : missedRecord ? null : openRecord ? <Button tone="primary" type="button" disabled={saving !== null} onClick={() => void runAction('clock-out')}><LogOut size={18} /> {saving === 'clock-out' ? '저장 중…' : '퇴근하기'}</Button> : todayRecord ? <span className="attendance-complete"><CalendarDays size={17} /> 오늘 출퇴근 완료</span> : <Button tone="primary" type="button" disabled={saving !== null} onClick={() => void runAction('clock-in')}><LogIn size={18} /> {saving === 'clock-in' ? '저장 중…' : '출근하기'}</Button>}
      </div>
    </div>

    {/* 퇴근을 빠뜨린 날: 전에는 출근이 막히고, 누를 수 있는 단추는 그날에 '지금'을 찍어 24시간 넘는 근무를 만드는 것뿐이었다. */}
    {canClock && missedRecord && <div className="attendance-missed" role="alert">
      <span className="attendance-missed-icon"><AlertTriangle size={20} /></span>
      <div><strong>{monthDay(missedRecord.workDate)} 퇴근을 찍지 않았습니다</strong><p>그날 퇴근한 시각을 적어 주세요. 기록에 '본인이 적은 시각'으로 남고, 더 긴 근무였다면 관리자가 고칠 수 있습니다.</p></div>
      <label><span>{monthDay(missedRecord.workDate)} 퇴근 시각</span><input type="time" value={missedTime} onChange={(event) => setMissedTime(event.target.value)} /></label>
      <div className="attendance-missed-actions">
        {!todayRecord && <Button tone="primary" type="button" disabled={saving !== null || !missedTime} onClick={() => void runAction('clock-in', { previousClockOutTime: missedTime }, `${monthDay(missedRecord.workDate)} 퇴근 ${missedTime}을 적고 오늘 출근을 기록했습니다.`)}><LogIn size={18} /> {saving === 'clock-in' ? '저장 중…' : '저장하고 오늘 출근'}</Button>}
        <Button tone={todayRecord ? 'primary' : 'secondary'} type="button" disabled={saving !== null || !missedTime} onClick={() => void runAction('clock-out', { clockOutTime: missedTime }, `${monthDay(missedRecord.workDate)} 퇴근을 ${missedTime}으로 적었습니다.`)}><LogOut size={18} /> {saving === 'clock-out' ? '저장 중…' : '퇴근 시각만 저장'}</Button>
      </div>
    </div>}

    <div className="attendance-summary-row">
      <article><span><CalendarDays size={19} /></span><div><small>조회 월</small><strong>{monthFilter.replace('-', '년 ')}월</strong></div></article>
      <article><span><Clock3 size={19} /></span><div><small>내 월 누적 근무</small><strong>{formatAttendanceDuration(monthTotalMinutes)}</strong></div></article>
      <article><span><Users size={19} /></span><div><small>{canManage ? '조회 직원' : '내 기록'}</small><strong>{canManage ? `${employees.length}명` : `${visibleRecords.length}일`}</strong></div></article>
    </div>

    <div className="attendance-records-head">
      <div><h3>{canManage ? '직원별 일일 기록' : '내 출퇴근 기록'}</h3><p>모든 시각은 한국 시간입니다. 고친 기록에는 '정정' 표시가 붙고, 눌러 보면 누가 왜 고쳤는지 나옵니다.</p></div>
      <div className="attendance-filters"><label><span>조회 월</span><input type="month" value={monthFilter} onChange={(event) => setMonthFilter(event.target.value)} /></label>{canManage && <label><span>직원</span><select value={employeeFilter} onChange={(event) => setEmployeeFilter(event.target.value)}><option value="all">전체 직원</option>{employees.map((employee) => <option key={employee.accountId} value={employee.accountId}>{employee.employeeName} · {employee.team || '소속 미지정'}</option>)}</select></label>}</div>
    </div>

    {loading ? <div className="attendance-empty"><RefreshCw size={20} /><strong>출퇴근 기록을 불러오는 중입니다.</strong></div> : visibleRecords.length === 0 ? <div className="attendance-empty"><Clock3 size={20} /><strong>이 기간에 등록된 출퇴근 기록이 없습니다.</strong><span>출근하기 버튼으로 첫 기록을 남겨 보세요.</span></div> : <div className="attendance-table" role="table" aria-label="직원별 출퇴근 기록">
      <div className="attendance-table-row attendance-table-header" role="row"><span role="columnheader">직원</span><span role="columnheader">근무일</span><span role="columnheader">출근</span><span role="columnheader">퇴근</span><span role="columnheader">총시간</span><span role="columnheader">상태</span></div>
      {visibleRecords.map((record) => {
        const status = attendanceStatus(record, clockTick)
        return <article className="attendance-table-row" role="row" key={record.id}>
          <span className="attendance-employee-cell" role="cell"><strong>{record.employeeName}</strong><small>{record.team || '소속 미지정'}</small></span>
          <span className="attendance-date-cell" role="cell" aria-label={`근무일 ${record.workDate}`}>{record.workDate}</span>
          <span className="attendance-time-cell attendance-check-in-cell" role="cell" data-label="출근" aria-label={`출근 ${timeLabel(record.clockInAt)}`}>{timeLabel(record.clockInAt)}</span>
          <span className="attendance-time-cell attendance-check-out-cell" role="cell" data-label="퇴근" aria-label={`퇴근 ${timeLabel(record.clockOutAt)}`}>{timeLabel(record.clockOutAt)}</span>
          <span className="attendance-time-cell attendance-total-cell" role="cell" data-label="총시간" aria-label={`총시간 ${status === '미퇴근' ? '퇴근 미기록' : formatAttendanceDuration(attendanceDurationMinutes(record, clockTick))}`}>{status === '미퇴근' ? '퇴근 미기록' : formatAttendanceDuration(attendanceDurationMinutes(record, clockTick))}</span>
          <span className="attendance-status-cell" role="cell" aria-label={`근태 상태 ${status}`}>
            <StatusBadge tone={statusTone(status)} dot>{status}</StatusBadge>
            {record.corrections?.length ? <span className="attendance-corrected" title={record.corrections.map(correctionLine).join('\n')}>정정 {record.corrections.length}</span> : null}
            {canManage && <Button tone="quiet" size="sm" type="button" aria-label={`${record.employeeName} ${record.workDate} 기록 고치기`} onClick={() => setCorrecting(record)}><Pencil size={14} /> 고치기</Button>}
          </span>
        </article>
      })}
    </div>}

    {correcting && <AttendanceCorrectionDialog record={correcting} headers={headers} onClose={() => setCorrecting(null)} onSaved={(next, message) => { setState(next); setCorrecting(null); onToast(message) }} />}

    {canManage && <div className="attendance-policy">
      <div><strong>회사 기준 출근 시각</strong><p>이 시각 이후 출근하면 해당 날짜가 지각으로 표시됩니다. 변경 전 기록은 당시 기준을 유지합니다.</p></div>
      <label><span>기준 시각</span><input type="time" value={standardStartTime} onChange={(event) => setStandardStartTime(event.target.value)} /></label>
      <Button tone="ghost" type="button" disabled={saving !== null || standardStartTime === state.policy.standardStartTime} onClick={() => void saveSettings()}><Save size={17} /> {saving === 'settings' ? '저장 중…' : '기준 저장'}</Button>
    </div>}
  </section>
}

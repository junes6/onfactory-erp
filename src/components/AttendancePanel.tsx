import { useEffect, useMemo, useState } from 'react'
import { CalendarDays, Clock3, LogIn, LogOut, RefreshCw, Save, Users } from 'lucide-react'
import { formatShortDateTime, seoulDateInputValue } from '../utils/dateTime'
import {
  attendanceDurationMinutes,
  attendanceStatus,
  formatAttendanceDuration,
  isAttendanceState,
  type AttendanceRecord,
  type AttendanceState,
  type AttendanceStatus,
} from '../utils/attendance'
import { StatusBadge, type StatusBadgeTone } from './StatusBadge'
import './AttendancePanel.css'

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
  const currentRecord = openRecord ?? todayRecord
  const employees = useMemo(() => Array.from(new Map(state.records.map((record) => [record.accountId, record])).values())
    .sort((left, right) => left.employeeName.localeCompare(right.employeeName, 'ko')), [state.records])
  const visibleRecords = useMemo(() => state.records
    .filter((record) => record.workDate.startsWith(monthFilter))
    .filter((record) => employeeFilter === 'all' || record.accountId === employeeFilter)
    .sort((left, right) => right.workDate.localeCompare(left.workDate) || right.clockInAt.localeCompare(left.clockInAt)), [employeeFilter, monthFilter, state.records])

  const runAction = async (action: 'clock-in' | 'clock-out') => {
    setSaving(action)
    try {
      const response = await fetch(`/api/attendance/${action}`, { method: 'POST', headers })
      const body = await response.json() as AttendanceResponse
      if (!response.ok || !isAttendanceState(body.data)) throw new Error(body.error?.message || '출퇴근 시간을 저장하지 못했습니다.')
      setState(body.data)
      onToast(action === 'clock-in' ? '출근 시간을 기록했습니다.' : '퇴근 시간을 기록했습니다.')
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
      <button className="button ghost" type="button" disabled={loading} onClick={() => { setLoading(true); void loadAttendance().catch((error) => onToast(error instanceof Error ? error.message : '새로고침하지 못했습니다.')).finally(() => setLoading(false)) }}><RefreshCw size={17} /> 새로고침</button>
    </header>

    <div className="attendance-today-card">
      <div className="attendance-identity"><span><Clock3 size={22} /></span><div><small>{today} · {currentUserTeam}</small><strong>{currentUserName}님의 오늘 근태</strong><p>기준 출근 {state.policy.standardStartTime}</p></div></div>
      <div className="attendance-today-times"><div><small>출근</small><strong>{timeLabel(currentRecord?.clockInAt ?? null)}</strong></div><div><small>퇴근</small><strong>{timeLabel(currentRecord?.clockOutAt ?? null)}</strong></div><div><small>총 근무</small><strong>{currentRecord ? formatAttendanceDuration(attendanceDurationMinutes(currentRecord, clockTick)) : '0분'}</strong></div>{summaryStatus && <StatusBadge tone={statusTone(summaryStatus)} dot>{summaryStatus}</StatusBadge>}</div>
      <div className="attendance-actions">
        {!canClock ? <p>운영자 모드에서는 직원 출퇴근을 대신 기록하지 않습니다.</p> : openRecord ? <button className="button primary" type="button" disabled={saving !== null} onClick={() => void runAction('clock-out')}><LogOut size={18} /> {saving === 'clock-out' ? '저장 중…' : '퇴근하기'}</button> : todayRecord ? <span className="attendance-complete"><CalendarDays size={17} /> 오늘 출퇴근 완료</span> : <button className="button primary" type="button" disabled={saving !== null} onClick={() => void runAction('clock-in')}><LogIn size={18} /> {saving === 'clock-in' ? '저장 중…' : '출근하기'}</button>}
      </div>
    </div>

    <div className="attendance-summary-row">
      <article><span><CalendarDays size={19} /></span><div><small>조회 월</small><strong>{monthFilter.replace('-', '년 ')}월</strong></div></article>
      <article><span><Clock3 size={19} /></span><div><small>내 월 누적 근무</small><strong>{formatAttendanceDuration(monthTotalMinutes)}</strong></div></article>
      <article><span><Users size={19} /></span><div><small>{canManage ? '조회 직원' : '내 기록'}</small><strong>{canManage ? `${employees.length}명` : `${visibleRecords.length}일`}</strong></div></article>
    </div>

    <div className="attendance-records-head">
      <div><h3>{canManage ? '직원별 일일 기록' : '내 출퇴근 기록'}</h3><p>출퇴근 시각은 ISO UTC로 저장되고 화면에서 한국 시간으로 표시됩니다.</p></div>
      <div className="attendance-filters"><label><span>조회 월</span><input type="month" value={monthFilter} onChange={(event) => setMonthFilter(event.target.value)} /></label>{canManage && <label><span>직원</span><select value={employeeFilter} onChange={(event) => setEmployeeFilter(event.target.value)}><option value="all">전체 직원</option>{employees.map((employee) => <option key={employee.accountId} value={employee.accountId}>{employee.employeeName} · {employee.team || '소속 미지정'}</option>)}</select></label>}</div>
    </div>

    {loading ? <div className="attendance-empty"><RefreshCw size={20} /><strong>출퇴근 기록을 불러오는 중입니다.</strong></div> : visibleRecords.length === 0 ? <div className="attendance-empty"><Clock3 size={20} /><strong>이 기간에 등록된 출퇴근 기록이 없습니다.</strong><span>출근하기 버튼으로 첫 기록을 남겨 보세요.</span></div> : <div className="attendance-table" role="table" aria-label="직원별 출퇴근 기록">
      <div className="attendance-table-row attendance-table-header" role="row"><span role="columnheader">직원</span><span role="columnheader">근무일</span><span role="columnheader">출근</span><span role="columnheader">퇴근</span><span role="columnheader">총시간</span><span role="columnheader">상태</span></div>
      {visibleRecords.map((record) => {
        const status = attendanceStatus(record, clockTick)
        return <article className="attendance-table-row" role="row" key={record.id}><span role="cell"><strong>{record.employeeName}</strong><small>{record.team || '소속 미지정'}</small></span><span role="cell">{record.workDate}</span><span role="cell">{timeLabel(record.clockInAt)}</span><span role="cell">{timeLabel(record.clockOutAt)}</span><span role="cell">{formatAttendanceDuration(attendanceDurationMinutes(record, clockTick))}</span><span role="cell"><StatusBadge tone={statusTone(status)} dot>{status}</StatusBadge></span></article>
      })}
    </div>}

    {canManage && <div className="attendance-policy">
      <div><strong>회사 기준 출근 시각</strong><p>이 시각 이후 출근하면 해당 날짜가 지각으로 표시됩니다. 변경 전 기록은 당시 기준을 유지합니다.</p></div>
      <label><span>기준 시각</span><input type="time" value={standardStartTime} onChange={(event) => setStandardStartTime(event.target.value)} /></label>
      <button className="button ghost" type="button" disabled={saving !== null || standardStartTime === state.policy.standardStartTime} onClick={() => void saveSettings()}><Save size={17} /> {saving === 'settings' ? '저장 중…' : '기준 저장'}</button>
    </div>}
  </section>
}


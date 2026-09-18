import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { attendanceDurationMinutes, attendanceStatus, formatAttendanceDuration } from '../src/utils/attendance.ts'

const peopleSource = await readFile(new URL('../src/components/PeopleOperations.tsx', import.meta.url), 'utf8')
const panelSource = await readFile(new URL('../src/components/AttendancePanel.tsx', import.meta.url), 'utf8')
const panelStyles = await readFile(new URL('../src/components/AttendancePanel.css', import.meta.url), 'utf8')
const utilitySource = await readFile(new URL('../src/utils/attendance.ts', import.meta.url), 'utf8')

test('attendance status and duration use ISO timestamps and the frozen daily start policy', () => {
  const base = {
    id: 'ATT-1', accountId: 'ACCOUNT-1', employeeName: '직원', team: '팀', workDate: '2026-08-25',
    clockInAt: '2026-08-25T00:05:00.000Z', clockOutAt: '2026-08-25T09:00:00.000Z',
    standardStartTime: '09:00', createdAt: '2026-08-25T00:05:00.000Z', updatedAt: '2026-08-25T09:00:00.000Z',
  }
  assert.equal(attendanceStatus(base, new Date('2026-08-25T10:00:00.000Z')), '지각')
  assert.equal(attendanceDurationMinutes(base), 535)
  assert.equal(formatAttendanceDuration(535), '8시간 55분')
  assert.equal(attendanceStatus({ ...base, clockInAt: '2026-08-24T23:50:00.000Z' }, new Date('2026-08-25T10:00:00.000Z')), '정상')
  assert.equal(attendanceStatus({ ...base, workDate: '2026-08-24', clockInAt: '2026-08-24T00:00:00.000Z', clockOutAt: null }, new Date('2026-08-25T01:00:00.000Z')), '미퇴근')
})

test('People Operations exposes employee clock actions, admin policy, and account-id filtering contracts', () => {
  assert.match(peopleSource, /tab === 'attendance'/)
  for (const label of ['출근하기', '퇴근하기', '총 근무', '회사 기준 출근 시각']) {
    assert.match(panelSource, new RegExp(label))
  }
  for (const status of ['정상', '지각', '미퇴근']) assert.match(utilitySource, new RegExp(status))
  assert.match(panelSource, /record\.accountId === currentUserId/)
  assert.match(panelSource, /\/api\/attendance\/\$\{action\}/)
  assert.match(panelSource, /\/api\/attendance\/settings/)
  assert.doesNotMatch(panelSource, /record\.employeeName === currentUserName/)
})

test('mobile attendance records use compact cards without horizontal table overflow', () => {
  assert.match(panelSource, /className="attendance-employee-cell"/)
  assert.match(panelSource, /className="attendance-date-cell"/)
  assert.match(panelSource, /data-label="출근"/)
  assert.match(panelSource, /data-label="퇴근"/)
  assert.match(panelSource, /data-label="총시간"/)
  assert.match(panelStyles, /@media \(max-width: 720px\)/)
  assert.match(panelStyles, /"employee date status"\s*"check-in check-out total"/)
  assert.match(panelStyles, /\.attendance-time-cell::before/)
  assert.doesNotMatch(panelStyles, /min-width:\s*720px/)
  assert.doesNotMatch(panelStyles, /\.attendance-table\s*\{[^}]*overflow-x:\s*auto/)
})

test('퇴근을 빠뜨린 날: 그날 퇴근 시각을 적고 바로 출근, 근무시간은 불어나지 않고, 관리자는 사유와 함께 고친다(감사 work-15)', async () => {
  const { readFile } = await import('node:fs/promises')
  const panel = await readFile(new URL('../src/components/AttendancePanel.tsx', import.meta.url), 'utf8')
  const util = await readFile(new URL('../src/utils/attendance.ts', import.meta.url), 'utf8')
  assert.match(panel, /runAction\('clock-in', \{ previousClockOutTime: missedTime \}/)
  assert.match(panel, /runAction\('clock-out', \{ clockOutTime: missedTime \}/)
  assert.match(panel, /퇴근을 찍지 않았습니다<\/strong>/)
  assert.match(panel, /status === '미퇴근' \? '퇴근 미기록'/)
  assert.match(panel, /fetch\(`\/api\/attendance\/records\/\$\{encodeURIComponent\(record\.id\)\}`/)
  assert.match(panel, /<span>사유 · 필수<\/span>/)
  assert.match(util, /if \(attendanceStatus\(record, now\) === '미퇴근'\) return 0/)
  // 야간 근무(전날 밤 출근·새벽 퇴근)는 '미퇴근'이 아니다.
  const base = { id: 'A', accountId: 'U', employeeName: '가', team: '', standardStartTime: '09:00', createdAt: '2026-09-17T13:00:00.000Z', updatedAt: '2026-09-17T13:00:00.000Z' }
  assert.equal(attendanceStatus({ ...base, workDate: '2026-09-17', clockInAt: '2026-09-17T13:00:00.000Z', clockOutAt: null }, new Date('2026-09-17T18:00:00.000Z')), '지각')
  assert.equal(attendanceDurationMinutes({ ...base, workDate: '2026-09-16', clockInAt: '2026-09-16T00:00:00.000Z', clockOutAt: null }, new Date('2026-09-17T09:00:00.000Z')), 0)
})

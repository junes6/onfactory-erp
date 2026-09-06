import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button, IconButton } from './ui/Button'
import { ParentChip } from './SubtaskList'
import { formatWorkDue, monthGridKeys, seoulDateInputValue, toIsoUtc } from '../utils/dateTime'
import { dayKind, holidayName } from '../utils/koreanHolidays'
import { barTone } from '../utils/workTimeline'
import { isSubtask, parentTitleOf, type ParentRef } from '../utils/workTree'
import type { WorkItem } from '../domainData'

/**
 * 캘린더 보기 — 마감일 기준.
 *
 * 달력은 "그날 무엇이 걸려 있나"이지 계층이 아니다. 그래서 목록·타임라인과 달리 자식도 자기 마감일 칸에
 * 독립적으로 놓고, 대신 상위 칩을 단다.
 *
 * 공휴일은 필수다. 색과 이름은 koreanHolidays.ts 한 출처에서만 나온다 —
 * 서버의 반복 업무 일정도 같은 파일을 읽으므로, 달력이 빨간 날이라 표시한 날에 서버가 업무를 만들면
 * 두 화면이 서로를 반박한다.
 *
 * CollaborationSuite.css의 .calendar-*를 재사용하지 않는다: 일정 화면 셀은 '이벤트 칩 3개'라는
 * 고유 구조이고 업무 셀은 '마감 N건'이라는 다른 구조다. 같은 클래스를 나누면 한쪽을 고칠 때 다른 쪽이 흔들린다.
 */

const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토']
const VISIBLE_PER_DAY = 3

export function WorkCalendarView({ items, allItems, parentRefs = {}, onOpen, now = new Date() }: {
  items: WorkItem[]
  allItems: WorkItem[]
  parentRefs?: Record<string, ParentRef>
  onOpen: (id: string) => void
  now?: Date
}) {
  const todayKey = seoulDateInputValue(now)
  const [cursor, setCursor] = useState(() => ({ year: Number(todayKey.slice(0, 4)), month: Number(todayKey.slice(5, 7)) - 1 }))
  const [expanded, setExpanded] = useState('')

  const days = useMemo(() => monthGridKeys(cursor.year, cursor.month), [cursor.year, cursor.month])
  /** 주 단위로 끊는다. 격자는 셀만으로 이루어지지 않는다 — columnheader·gridcell은 row가 소유해야 한다. */
  const weeks = useMemo(() => {
    const rows: string[][] = []
    for (let index = 0; index < days.length; index += 7) rows.push(days.slice(index, index + 7))
    return rows
  }, [days])
  /** 마감을 못 읽는 업무는 칸이 없다 — 버리지 않고 달력 아래 접어 둔다. */
  const { byDay, undated } = useMemo(() => {
    const map = new Map<string, WorkItem[]>()
    const missing: WorkItem[] = []
    for (const item of items) {
      const iso = toIsoUtc(item.due, now)
      if (!iso) { missing.push(item); continue }
      const key = seoulDateInputValue(new Date(iso))
      const bucket = map.get(key) ?? []
      bucket.push(item)
      map.set(key, bucket)
    }
    for (const bucket of map.values()) bucket.sort((left, right) => left.title.localeCompare(right.title, 'ko'))
    return { byDay: map, undated: missing }
  }, [items, now])

  const monthLabel = `${cursor.year}년 ${cursor.month + 1}월`
  const shiftMonth = (delta: number) => setCursor((current) => {
    const next = current.month + delta
    return { year: current.year + Math.floor(next / 12), month: ((next % 12) + 12) % 12 }
  })

  return <section className="work-calendar" aria-label="업무 마감 달력">
    <div className="work-calendar-controls">
      <IconButton tone="quiet" type="button" aria-label="이전 달" onClick={() => shiftMonth(-1)}><ChevronLeft size={18} /></IconButton>
      <strong aria-live="polite">{monthLabel}</strong>
      <IconButton tone="quiet" type="button" aria-label="다음 달" onClick={() => shiftMonth(1)}><ChevronRight size={18} /></IconButton>
      <Button tone="quiet" size="sm" type="button" onClick={() => setCursor({ year: Number(todayKey.slice(0, 4)), month: Number(todayKey.slice(5, 7)) - 1 })}>이번 달</Button>
    </div>
    <div className="work-calendar-grid" role="grid" aria-label={`${monthLabel} 업무 마감`}>
      <div className="work-calendar-row" role="row">
        {WEEKDAY_LABELS.map((label, index) => (
          <span className={`work-calendar-weekday${index === 0 ? ' is-sunday' : index === 6 ? ' is-saturday' : ''}`} role="columnheader" key={label}>{label}</span>
        ))}
      </div>
      {weeks.map((week) => <div className="work-calendar-row" role="row" key={week[0]}>
        {week.map((key) => {
          const kind = dayKind(key)
          const holiday = holidayName(key)
          const outside = Number(key.slice(5, 7)) - 1 !== cursor.month
          const bucket = byDay.get(key) ?? []
          const open = expanded === key
          const shown = open ? bucket : bucket.slice(0, VISIBLE_PER_DAY)
          return <div
            className={`work-calendar-day kind-${kind}${key === todayKey ? ' is-today' : ''}${outside ? ' is-outside' : ''}`}
            role="gridcell"
            aria-label={`${Number(key.slice(5, 7))}월 ${Number(key.slice(8, 10))}일${holiday ? ` ${holiday}` : ''}, 마감 ${bucket.length}건`}
            key={key}
          >
            <span className="work-calendar-date">
              <b>{Number(key.slice(8, 10))}</b>
              {/* 칸이 좁아 이름은 잘릴 수 있다 — title로 전체를 남긴다. */}
              {holiday && <span className="work-calendar-holiday" title={holiday}>{holiday}</span>}
            </span>
            {shown.map((item) => <button
              type="button"
              className={`work-calendar-item tone-${barTone(item, now)}`}
              aria-haspopup="dialog"
              key={item.id}
              onClick={() => onOpen(item.id)}
            >
              <span title={item.title}>{item.title}</span>
              {isSubtask(item) && <ParentChip title={parentTitleOf(item, allItems, parentRefs)} />}
            </button>)}
            {bucket.length > VISIBLE_PER_DAY && <button
              type="button"
              className="work-calendar-more"
              aria-expanded={open}
              onClick={() => setExpanded(open ? '' : key)}
            >{open ? '접기' : `+${bucket.length - VISIBLE_PER_DAY}건`}</button>}
          </div>
        })}
      </div>)}
    </div>
    {undated.length > 0 && <details className="work-calendar-undated">
      <summary>마감 없는 업무 {undated.length}건</summary>
      <ul>
        {undated.map((item) => <li key={item.id}>
          <strong title={item.title}>{item.title}</strong>
          <span>{formatWorkDue(item.due)}</span>
          <Button tone="quiet" size="sm" type="button" onClick={() => onOpen(item.id)}>기간 정하기</Button>
        </li>)}
      </ul>
    </details>}
  </section>
}

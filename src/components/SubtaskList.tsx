import { CornerLeftUp } from 'lucide-react'
import { Button } from './ui/Button'
import { StatusBadge } from './StatusBadge'
import { formatWorkDue, toIsoUtc } from '../utils/dateTime'
import { workStatusLabel, workStatusTone } from '../utils/workStatus'
import { UNKNOWN_PARENT_TITLE } from '../utils/workTree'
import type { WorkItem } from '../domainData'
import './SubtaskList.css'

/**
 * 하위 업무 공용 렌더러.
 *
 * 데스크톱 카드·휴대폰 목록·게스트 화면이 같은 한 줄을 쓴다. 세 곳에서 따로 그리면
 * '펼치면 들여쓰기로 나온다'가 화면마다 다른 말이 된다.
 * 한 줄 원칙은 자식에도 그대로다 — 상태 점 · 제목 · 마감 · 버튼 1개. 카드 안에 카드(article)를 두지 않는다.
 */

/** 상위를 볼 수 있으면 눌러서 그리로 가고, 못 보면(게스트·휴대폰) 제목 없이 '상위 업무'만 밝힌다. */
export function ParentChip({ title, onOpen }: { title?: string; onOpen?: () => void }) {
  // 제목이 없다(=모른다)는 것과 제목이 '상위 업무'인 것은 다른 일이다. 그래서 없음은 값이 아니라 title 자체로 온다.
  const label = title ? `상위: ${title}` : UNKNOWN_PARENT_TITLE
  if (!onOpen) return <span className="workflow-parent-chip"><CornerLeftUp size={12} /> {label}</span>
  return <button
    type="button"
    className="workflow-parent-chip"
    onClick={(event) => { event.stopPropagation(); onOpen() }}
  ><CornerLeftUp size={12} /> {label}</button>
}

/** 진행률 막대. 값은 저장하지 않고 자식 status에서 세어 만든다. */
export function SubtaskProgressBar({ progress }: { progress: { total: number; done: number; percent: number } }) {
  return <i
    className="workflow-progress"
    role="progressbar"
    aria-valuenow={progress.percent}
    aria-valuemin={0}
    aria-valuemax={100}
    aria-label={`하위 업무 ${progress.done}/${progress.total} 완료`}
  ><b style={{ width: `${progress.percent}%` }} /></i>
}

/**
 * 자식 행의 행동 하나.
 * `blocked`는 눌러 보기 전에 보여 줄 사유이고, `stops`는 그 사유가 실제로 길을 막는가다.
 * 둘을 나눈 이유: aria-disabled는 '조작할 수 없다'는 뜻이라 눌리는 버튼에 붙이면 거짓말이 된다.
 * 사유만 적고 서버가 판정하는 표면(데스크톱)은 stops를 주지 않는다.
 */
type SubtaskAction = { label: string; run: () => void; blocked?: string; stops?: boolean }

export function SubtaskRows({ items, className, label = '하위 업무', onOpen, actionFor, busyId }: {
  items: WorkItem[]
  className?: string
  /** 목록 이름. 이미 '하위 업무'라는 이름을 가진 구역 안에 들어갈 때만 바꾼다 — 같은 이름을 두 번 읽어 주지 않게. */
  label?: string
  onOpen?: (item: WorkItem) => void
  actionFor: (item: WorkItem) => SubtaskAction | null
  busyId?: string
}) {
  return <ul className={['workflow-subtask-list', className].filter(Boolean).join(' ')} aria-label={label}>
    {items.map((child) => {
      const action = actionFor(child)
      const summary = <>
        <StatusBadge className="status-pill" dot tone={workStatusTone(child.status)}>{workStatusLabel(child.status)}</StatusBadge>
        <strong title={`${child.title} · ${child.owner}`}>{child.title}</strong>
        <time dateTime={toIsoUtc(child.due) ?? child.due}>{child.status === '결재완료' ? '완료됨' : formatWorkDue(child.due)}</time>
      </>
      return <li key={child.id} className={`workflow-subtask-row${child.status === '결재완료' ? ' is-done' : ''}`}>
        {/* 상위 카드가 role="button"이라 안쪽 클릭은 전부 여기서 멈춘다 — 자식을 누르려다 상위 상세가 열리면 안 된다. */}
        {onOpen
          ? <button type="button" className="workflow-subtask-open" onClick={(event) => { event.stopPropagation(); onOpen(child) }}>{summary}</button>
          : <span className="workflow-subtask-open">{summary}</span>}
        {action && <Button
          tone="quiet"
          size="sm"
          type="button"
          disabled={busyId === child.id}
          aria-disabled={action.stops ? true : undefined}
          title={action.blocked}
          onClick={(event) => { event.stopPropagation(); action.run() }}
        >{action.label}</Button>}
      </li>
    })}
  </ul>
}

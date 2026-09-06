import { ChevronDown, ListChecks } from 'lucide-react'
import { Button } from './ui/Button'
import { StatusBadge } from './StatusBadge'
import { ParentChip, SubtaskProgressBar, SubtaskRows } from './SubtaskList'
import { customFieldDisplay, type CustomFieldDefinition } from './CustomFieldInputs'
import { formatWorkDue, toIsoUtc } from '../utils/dateTime'
import { workStatusLabel, workStatusTone } from '../utils/workStatus'
import { childrenOf, isSubtask, isTopLevelIn, parentTitleOf, progressLabel, subtaskProgress, type ParentRef } from '../utils/workTree'
import { isWorkOverdue } from '../utils/workTimeline'
import { WORK_EMPTY_FILTERED_HINT, WORK_EMPTY_FILTERED_TITLE } from '../utils/workViews'
import type { WorkItem } from '../domainData'

/**
 * 목록 보기 — 게스트·휴대폰·하위 업무가 이미 쓰는 한 줄 어휘의 네 번째 표면.
 *
 * 한 줄 원칙: 상태 점 · 제목 · 마감 · 버튼 1개. 카드(article)를 만들지 않는다.
 * 죽은 CSS 이름(.workflow-row-list·.workflow-card-list·.workflow-card-body·.workflow-summary-strip·
 * .workflow-stepper)을 한 글자도 재사용하지 않는다 — 그 이름을 쓰면 styles.css에 남아 있는
 * 옛 세대 규칙이 조용히 적용되고, 다음 사람은 어느 세대를 고쳐야 할지 알 수 없게 된다.
 *
 * 보조 1줄(columns)은 표의 열이 아니라 ' · '로 잇는 한 줄이다(DECISIONS.md 한 줄 원칙).
 * 커스텀 필드는 **값이 있을 때만** 붙는다 — 빈 값이 '—'를 만들면 없는 것이 있는 것처럼 보인다.
 */

export type WorkListColumn = string

type PrimaryAction = { label: string; run: () => void; blocked?: string }

function secondaryLine(item: WorkItem, columns: WorkListColumn[], context: {
  definitions: CustomFieldDefinition[]
  people: Record<string, string>
  projectNames: Record<string, string>
  parentTitle?: string
}): string {
  const parts: string[] = []
  for (const column of columns) {
    if (column.startsWith('cf:')) {
      const definition = context.definitions.find((entry) => entry.key === column.slice(3))
      const shown = definition ? customFieldDisplay(item, definition, context.people) : ''
      if (shown) parts.push(`${definition?.label ?? ''} ${shown}`.trim())
      continue
    }
    if (column === 'owner') parts.push(item.owner)
    if (column === 'project') { const name = item.projectId ? context.projectNames[item.projectId] : ''; if (name) parts.push(name) }
    if (column === 'parent' && context.parentTitle) parts.push(`상위: ${context.parentTitle}`)
    if (column === 'category' && item.category) parts.push(item.category)
    if (column === 'priority') parts.push(item.priority)
    if (column === 'startAt' && item.startAt) parts.push(`시작 ${formatWorkDue(item.startAt)}`)
    if (column === 'origin' && item.origin?.label) parts.push(item.origin.label)
  }
  return parts.join(' · ')
}

export function WorkListView({ items, allItems, scopedIds, parentRefs = {}, definitions = [], people = {}, projectNames = {}, columns = ['owner'], filtered = false, canAssignTasks = false, onOpen, onClearFilter, onCreate, actionFor }: {
  items: WorkItem[]
  /** 진행률·하위 차단은 필터와 무관한 사실이므로 언제나 전체로 센다. */
  allItems: WorkItem[]
  scopedIds: Set<string>
  parentRefs?: Record<string, ParentRef>
  definitions?: CustomFieldDefinition[]
  people?: Record<string, string>
  projectNames?: Record<string, string>
  columns?: WorkListColumn[]
  /** 조건이 하나라도 켜져 있는가. 빈 화면의 이유를 가르는 유일한 축이다(타임라인과 같은 prop). */
  filtered?: boolean
  canAssignTasks?: boolean
  onOpen: (id: string) => void
  onClearFilter?: () => void
  onCreate?: () => void
  actionFor: (item: WorkItem) => PrimaryAction | null
}) {
  const topLevel = items.filter((item) => isTopLevelIn(item, scopedIds))

  /*
   * 빈 캔버스는 고장으로 읽힌다(설계 §F2.6). 목록은 이 절이 정한 **기본 보기**라서, 업무가 아직 없는 회사가
   * 화면을 처음 여는 순간이 정확히 이 상태다 — 그때 툴바 아래가 통째로 비면 사람은 데이터가 사라졌다고 읽는다.
   * 조건 때문에 0건인 경우의 문장은 접힌 필터 칸 안(.work-filter-result)에도 있지만, 접혀 있으면 보이지 않는다.
   * 첫 줄은 타임라인과 **같은 상수**에서 나온다 — 한 절 안에서 두 표면이 다른 말을 하지 않게.
   */
  if (topLevel.length === 0) return <div className="empty-state">
    <ListChecks size={30} />
    <h3>{filtered ? WORK_EMPTY_FILTERED_TITLE : '아직 지시된 업무가 없습니다'}</h3>
    <p>{filtered ? WORK_EMPTY_FILTERED_HINT : '업무를 지시하면 여기에 한 줄로 나타납니다.'}</p>
    {filtered && onClearFilter && <Button tone="quiet" size="sm" type="button" onClick={onClearFilter}>필터 지우기</Button>}
    {/* 지시할 수 있는 사람에게만 그 길을 낸다 — 누를 수 없는 버튼을 빈 화면에 놓지 않는다. */}
    {!filtered && canAssignTasks && onCreate && <Button tone="secondary" size="sm" type="button" onClick={onCreate}>새 업무 지시</Button>}
  </div>

  return <ul className="work-list" aria-label="업무 목록">
    {topLevel.map((item) => {
      const action = actionFor(item)
      const overdue = isWorkOverdue(item)
      const progress = subtaskProgress(allItems, item.id)
      const visibleChildren = childrenOf(items, item.id)
      const parentTitle = isSubtask(item) ? parentTitleOf(item, allItems, parentRefs) : undefined
      const secondary = secondaryLine(item, columns, { definitions, people, projectNames, parentTitle })
      return <li className={`work-list-row${item.status === '결재완료' ? ' is-done' : ''}`} key={item.id}>
        <div className="work-list-main">
          <button type="button" className="work-list-open" aria-haspopup="dialog" onClick={() => onOpen(item.id)}>
            <StatusBadge className="status-pill" dot tone={workStatusTone(item.status)}>{workStatusLabel(item.status)}</StatusBadge>
            <span className="work-list-text">
              <strong title={item.title}>{item.title}</strong>
              {secondary && <small>{secondary}</small>}
            </span>
          </button>
          {/* 상위 칩은 버튼 밖에 둔다 — 버튼 안에 버튼을 넣지 않는다. */}
          {isSubtask(item) && <ParentChip title={parentTitle} onOpen={allItems.some((candidate) => candidate.id === item.parentId) ? () => onOpen(item.parentId) : undefined} />}
          <time className={overdue ? 'is-overdue' : undefined} dateTime={toIsoUtc(item.due) ?? item.due}>
            {item.status === '결재완료' ? '완료됨' : formatWorkDue(item.due)}
          </time>
          {/* 사유는 미리 보여 주되 문은 잠그지 않는다 — 남았는지는 제출 시점에 서버가 판정한다(보드 카드와 같은 규율). */}
          {action && <Button
            tone="quiet"
            size="sm"
            type="button"
            aria-describedby={action.blocked ? `work-list-blocked-${item.id}` : undefined}
            onClick={action.run}
          >{action.label}</Button>}
        </div>
        {action?.blocked && <p className="work-list-blocked" id={`work-list-blocked-${item.id}`}>{action.blocked}</p>}
        {/* 자식이 없으면 줄 자체가 없다 — 아직 없는 진행률을 영 퍼센트로 적지 않는다. */}
        {progress && <details className="work-list-children">
          <summary className={progress.done === progress.total ? 'is-complete' : undefined}>
            <ChevronDown size={14} /> {progressLabel(progress)} <SubtaskProgressBar progress={progress} />
          </summary>
          {visibleChildren.length > 0 && <SubtaskRows items={visibleChildren} label={`${item.title} 하위 업무`} onOpen={(child) => onOpen(child.id)} actionFor={actionFor} />}
          {/* 센 것과 그린 것이 다르면 그 차이를 말한다 — '데이터가 사라졌다'로 읽히지 않게. */}
          {progress.total > visibleChildren.length && <p className="work-list-note">하위 업무 {progress.total - visibleChildren.length}건은 지금 고른 조건 밖에 있습니다.</p>}
        </details>}
      </li>
    })}
  </ul>
}

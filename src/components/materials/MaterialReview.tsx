import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { BookOpenText, ChevronLeft, ChevronRight, CircleHelp, Crosshair, MessageSquare, MonitorPlay, PencilLine, Presentation, Reply, ThumbsDown, ThumbsUp, Trash2 } from 'lucide-react'
import { formatDateTime } from '../../utils/dateTime'
import { Button } from '../ui/Button'
import { MaterialFrame } from './MaterialFrame'
import { DecisionBox, TaskFromDecision } from './MaterialDecisions'
import { AiDraftCard } from './MaterialSynthesis'
import {
  STANCE_LABELS, decideFromDraft, decideItem, deleteComment, editComment, fetchFeedback, fetchMaterialAnchors, fetchMaterialTasks, newClientRequestId, postComment, runAiSynthesis, setStance,
  type DecisionStatus, type FeedbackBundle, type MaterialTask, type LineageSummary, type MaterialAnchor, type MaterialComment, type MaterialDecision, type MaterialDetail, type Stance,
} from './materialsApi'

/**
 * 검토 자료 한 판을 읽고 반응하는 자리.
 *
 * - **원본 보기**(PC 기본): 왼쪽은 격리된 원본, 오른쪽은 "항목과 의견". 원본을 내리면 옆 칸이 보고 있는 항목을 따라온다.
 * - **읽기 모드**(휴대폰·큰 글자 기본): 서버가 뽑은 항목 글을 앱의 글꼴·글자 크기로 한 줄씩. 원본을 받지 않아 데이터도 아낀다.
 * 사람이 하는 일은 두 가지뿐이다: 항목마다 네 버튼 중 하나(찬성·수정해서·반대·질문)를 누르고, 필요하면 한 줄 남긴다.
 */
type Mode = 'original' | 'reading' | 'meeting'
type FilterId = 'all' | 'decision' | 'mine-missing' | 'undecided' | 'split' | 'questions'

const STANCE_ORDER: Stance[] = ['agree', 'amend', 'oppose', 'question']
const STANCE_ICONS = { agree: ThumbsUp, amend: PencilLine, oppose: ThumbsDown, question: CircleHelp } as const
const EMPTY_SUMMARY: LineageSummary = { comments: 0, openQuestions: 0, stances: { agree: 0, amend: 0, oppose: 0, question: 0 }, myStance: null, lastActivityAt: null }

const draftKey = (materialId: string, lineageId: string | null) => `itf-material-draft:${materialId}:${lineageId ?? 'all'}`
const readDraft = (key: string) => { try { return window.localStorage.getItem(key) ?? '' } catch { return '' } }
const writeDraft = (key: string, value: string) => { try { if (value) window.localStorage.setItem(key, value); else window.localStorage.removeItem(key) } catch { /* 저장소가 막혀도 입력은 된다 */ } }

/** 읽기 모드의 본문. 제목이 본문 앞쪽에 한 번 더 들어 있으면(자료의 머리글) 빼고 보여 준다 — 같은 줄을 두 번 읽지 않게. */
const readingBody = (anchor: MaterialAnchor) => {
  const index = anchor.title ? anchor.text.indexOf(anchor.title) : -1
  return index >= 0 && index < 200 ? `${anchor.text.slice(0, index)} ${anchor.text.slice(index + anchor.title.length)}`.trim() : anchor.text
}

/** 찬반이 갈렸는가 — 찬성과 반대(또는 수정 요청)가 함께 있으면 쟁점이다. AI 없이 규칙으로 센다. */
const isSplit = (summary: LineageSummary) => summary.stances.agree > 0 && (summary.stances.oppose > 0 || summary.stances.amend > 0)

export function MaterialReview({ workspaceScope, material, version, showNative, preferReading, currentUserId, isAdmin, focusRequest = null, onNativeControls, onToast }: {
  workspaceScope?: string
  /** 회의 준비표 같은 바깥에서 "이 항목으로 가라"는 부탁. at이 바뀔 때마다 한 번. */
  focusRequest?: { lineageId: string; at: number } | null
  material: MaterialDetail
  version: number
  showNative: boolean
  preferReading: boolean
  currentUserId: string
  isAdmin: boolean
  onNativeControls: (count: number) => void
  onToast: (message: string) => void
}) {
  const [mode, setMode] = useState<Mode>(() => (preferReading || window.innerWidth <= 768 ? 'reading' : 'original'))
  const [anchors, setAnchors] = useState<MaterialAnchor[]>([])
  const [feedback, setFeedback] = useState<FeedbackBundle | null>(null)
  const [selectedLineage, setSelectedLineage] = useState<string | null>(null)
  const [follow, setFollow] = useState(true)
  const [visible, setVisible] = useState<string[]>([])
  const [filter, setFilter] = useState<FilterId>('all')
  const [scrollTarget, setScrollTarget] = useState<string | null>(null)
  const [aiBusy, setAiBusy] = useState('')
  const [tasks, setTasks] = useState<{ rows: MaterialTask[]; canApprove: boolean }>({ rows: [], canApprove: false })
  const archived = material.status === 'archived'
  const isLatest = version === material.currentVersion

  useEffect(() => {
    let active = true
    setAnchors([])
    fetchMaterialAnchors(workspaceScope, material.id, version)
      .then((rows) => { if (active) setAnchors(rows) })
      .catch((cause: unknown) => onToast(cause instanceof Error ? cause.message : '항목을 불러오지 못했습니다.'))
    return () => { active = false }
  }, [workspaceScope, material.id, version]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadFeedback = useCallback(async () => {
    try { setFeedback(await fetchFeedback(workspaceScope, material.id)) } catch (cause) { onToast(cause instanceof Error ? cause.message : '의견을 불러오지 못했습니다.') }
  }, [workspaceScope, material.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void loadFeedback() }, [loadFeedback])
  const loadTasks = useCallback(async () => {
    try { const body = await fetchMaterialTasks(workspaceScope, material.id); setTasks({ rows: body.tasks, canApprove: body.canApprove }) } catch { /* 업무 칩이 없어도 검토는 된다 */ }
  }, [workspaceScope, material.id])
  useEffect(() => { void loadTasks() }, [loadTasks])

  // 다른 사람이 남긴 의견·찬반은 새로고침 없이 들어온다(App의 실시간 스트림이 'itf:material'로 알린다).
  useEffect(() => {
    let timer = 0
    const onEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ materialId?: string; what?: string }>).detail
      if (detail?.materialId !== material.id || detail.what === 'version' || detail.what === 'meta') return
      window.clearTimeout(timer)
      timer = window.setTimeout(() => { void loadFeedback(); if (detail.what === 'task') void loadTasks() }, 250)
    }
    window.addEventListener('itf:material', onEvent)
    return () => { window.removeEventListener('itf:material', onEvent); window.clearTimeout(timer) }
  }, [material.id, loadFeedback, loadTasks])

  const summaryOf = useCallback((lineageId: string | null) => feedback?.summary[lineageId ?? '_material'] ?? EMPTY_SUMMARY, [feedback])
  /** 계보별 결정 이력(오래된 것부터). 마지막 줄이 지금 결정이다. */
  const decisionsByLineage = useMemo(() => {
    const map = new Map<string, MaterialDecision[]>()
    for (const row of feedback?.decisions ?? []) { const list = map.get(row.lineageId) ?? []; list.push(row); map.set(row.lineageId, list) }
    return map
  }, [feedback])
  const decisionOf = (lineageId: string) => decisionsByLineage.get(lineageId)?.at(-1) ?? null
  const parentIds = useMemo(() => new Set(anchors.map((anchor) => anchor.parentId).filter(Boolean) as string[]), [anchors])
  const decisionAnchors = useMemo(() => anchors.filter((anchor) => anchor.decisionEnabled), [anchors])
  const missingMine = decisionAnchors.filter((anchor) => !summaryOf(anchor.lineageId).myStance)
  const filtered = useMemo(() => anchors.filter((anchor) => {
    const summary = summaryOf(anchor.lineageId)
    if (filter === 'decision') return anchor.decisionEnabled
    if (filter === 'mine-missing') return anchor.decisionEnabled && !summary.myStance
    if (filter === 'undecided') return anchor.decisionEnabled && !decisionsByLineage.has(anchor.lineageId)
    if (filter === 'split') return isSplit(summary)
    if (filter === 'questions') return summary.openQuestions > 0 || summary.stances.question > 0
    return true
  }), [anchors, filter, summaryOf, decisionsByLineage])

  // 원본을 내리면 옆 칸이 따라온다 — 사람이 항목을 직접 골랐으면 [보는 곳 따라가기]를 다시 누를 때까지 멈춘다.
  const anchorById = useMemo(() => new Map(anchors.map((anchor) => [anchor.id, anchor])), [anchors])
  useEffect(() => {
    if (!follow || mode !== 'original') return
    const first = visible.map((id) => anchorById.get(id)).find((anchor) => anchor && !parentIds.has(anchor.id)) ?? visible.map((id) => anchorById.get(id)).find(Boolean)
    if (first) setSelectedLineage(first.lineageId)
  }, [visible, follow, mode, anchorById, parentIds])

  const selectedAnchor = anchors.find((anchor) => anchor.lineageId === selectedLineage) ?? null

  useEffect(() => {
    if (!focusRequest) return
    const anchor = anchors.find((row) => row.lineageId === focusRequest.lineageId)
    if (!anchor) return
    setFilter('all')
    setSelectedLineage(anchor.lineageId)
    setFollow(false)
    setScrollTarget(`${anchor.id}:${focusRequest.at}`)
  }, [focusRequest, anchors])

  const runAi = async (anchor: MaterialAnchor) => {
    setAiBusy(anchor.lineageId)
    try {
      await runAiSynthesis(workspaceScope, material.id, anchor.lineageId)
      onToast('AI 정리(초안)를 받았습니다. 근거 의견이 없는 문장은 버렸습니다.')
      await loadFeedback()
    } catch (cause) { onToast(cause instanceof Error ? cause.message : 'AI 정리를 받지 못했습니다.') } finally { setAiBusy('') }
  }
  const adoptDraft = async (anchor: MaterialAnchor, draft: NonNullable<FeedbackBundle['aiOutputs'][string]>) => {
    try {
      await decideFromDraft(workspaceScope, material.id, anchor.lineageId, draft)
      onToast(`AI 초안대로 ${draft.output.draftDecision?.status}(으)로 결정했습니다. 결정한 사람은 나로 남습니다.`)
      await loadFeedback()
    } catch (cause) { onToast(cause instanceof Error ? cause.message : '결정을 남기지 못했습니다.') }
  }

  const pick = (anchor: MaterialAnchor, { scroll = true } = {}) => {
    setSelectedLineage(anchor.lineageId)
    setFollow(false)
    if (scroll && mode === 'original') setScrollTarget(`${anchor.id}:${Date.now()}`)
  }

  const applyStance = async (anchor: MaterialAnchor, next: Stance) => {
    if (archived) { onToast('보관한 자료에는 의견을 남길 수 없습니다.'); return }
    const current = summaryOf(anchor.lineageId).myStance
    const target = current === next ? null : next
    try {
      const result = await setStance(workspaceScope, material.id, anchor.lineageId, target)
      setFeedback((bundle) => (bundle ? { ...bundle, summary: result.summary } : bundle))
      onToast(target ? `「${anchor.title}」에 ${STANCE_LABELS[target]}(으)로 남겼습니다. 다시 누르면 거둡니다.` : '내 생각을 거뒀습니다.')
    } catch (cause) { onToast(cause instanceof Error ? cause.message : '내 생각을 남기지 못했습니다.') }
  }

  const applyDecision = async (anchor: MaterialAnchor, status: DecisionStatus, note: string) => {
    try {
      const result = await decideItem(workspaceScope, material.id, anchor.lineageId, status, note)
      onToast(result.unchanged ? '같은 결정이 이미 남아 있습니다.' : `「${anchor.title}」을(를) ${status}(으)로 결정했습니다. 이력은 지워지지 않습니다.`)
      await loadFeedback()
    } catch (cause) { onToast(cause instanceof Error ? cause.message : '결정을 남기지 못했습니다.') }
  }

  const filterChips: Array<{ id: FilterId; label: string; count?: number }> = [
    { id: 'all', label: '전체', count: anchors.length },
    ...(decisionAnchors.length ? [
      { id: 'decision' as const, label: '결정 받을 항목', count: decisionAnchors.length },
      { id: 'mine-missing' as const, label: '내가 아직 안 본 것', count: missingMine.length },
      { id: 'undecided' as const, label: '결정 안 된 것', count: decisionAnchors.filter((anchor) => !decisionsByLineage.has(anchor.lineageId)).length },
    ] : []),
    { id: 'split', label: '의견이 갈린 것' },
    { id: 'questions', label: '질문이 있는 것' },
  ]

  const progress = decisionAnchors.length > 0 && isLatest && !archived && (
    <div className="material-progress" role="status">
      <span>
        항목마다 <strong>찬성 · 수정해서 · 반대 · 질문</strong> 중 하나를 누르고, 필요하면 한 줄 남겨 주세요.
        {' '}결정 받을 항목 {decisionAnchors.length}개 중 <strong>{missingMine.length}개</strong> 남았습니다.
        {material.dueAt ? ` 의견 마감 ${formatDateTime(material.dueAt)}.` : ''}
      </span>
      {missingMine.length > 0 && <Button tone="secondary" size="sm" type="button" onClick={() => { setFilter('all'); pick(missingMine[0]); if (mode === 'reading') setScrollTarget(`${missingMine[0].id}:${Date.now()}`) }}>이어서 보기</Button>}
    </div>
  )

  const modeSwitch = (
    <div className="material-mode" role="group" aria-label="보는 방법">
      <Button tone={mode === 'original' ? 'secondary' : 'quiet'} size="sm" type="button" aria-pressed={mode === 'original'} onClick={() => setMode('original')}><MonitorPlay size={16} aria-hidden="true" /> 원본 보기</Button>
      <Button tone={mode === 'reading' ? 'secondary' : 'quiet'} size="sm" type="button" aria-pressed={mode === 'reading'} onClick={() => setMode('reading')}><BookOpenText size={16} aria-hidden="true" /> 읽기 모드</Button>
      {decisionAnchors.length > 0 && <Button tone={mode === 'meeting' ? 'secondary' : 'quiet'} size="sm" type="button" aria-pressed={mode === 'meeting'} onClick={() => setMode('meeting')}><Presentation size={16} aria-hidden="true" /> 회의 진행</Button>}
    </div>
  )

  const chips = (
    <div className="material-filters" role="group" aria-label="항목 거르기">
      {filterChips.map((chip) => (
        <button key={chip.id} type="button" className="material-chip" aria-pressed={filter === chip.id} onClick={() => setFilter(chip.id)}>
          {chip.label}{typeof chip.count === 'number' ? ` ${chip.count}` : ''}
        </button>
      ))}
    </div>
  )

  const thread = (anchor: MaterialAnchor | null) => (
    <ItemThread
      workspaceScope={workspaceScope}
      materialId={material.id}
      anchor={anchor}
      summary={summaryOf(anchor?.lineageId ?? null)}
      comments={(feedback?.comments ?? []).filter((comment) => comment.lineageId === (anchor?.lineageId ?? null))}
      currentUserId={currentUserId}
      isAdmin={isAdmin}
      readOnly={archived}
      onStance={(stance) => { if (anchor) void applyStance(anchor, stance) }}
      onChanged={() => void loadFeedback()}
      onToast={onToast}
      aiSlot={anchor ? (
        <AiDraftCard
          aiOutput={feedback?.aiOutputs?.[anchor.lineageId] ?? null}
          canRun={material.aiAvailable && material.canDecide && summaryOf(anchor.lineageId).comments > 0}
          canDecide={material.canDecide}
          readOnly={archived}
          busy={aiBusy === anchor.lineageId}
          onRun={() => void runAi(anchor)}
          onAdopt={(draft) => void adoptDraft(anchor, draft)}
        />
      ) : null}
      decisionSlot={anchor && (anchor.decisionEnabled || decisionsByLineage.has(anchor.lineageId)) ? (
        <DecisionBox
          decisions={decisionsByLineage.get(anchor.lineageId) ?? []}
          canDecide={material.canDecide}
          readOnly={archived}
          currentVersion={material.currentVersion}
          onDecide={(status, note) => applyDecision(anchor, status, note)}
        />
      ) : null}
      taskSlot={anchor && (tasks.rows.some((task) => task.lineageId === anchor.lineageId) || (material.canDecide && !archived && ['반영', '수정 후 반영'].includes(decisionOf(anchor.lineageId)?.status ?? ''))) ? (
        <TaskFromDecision
          workspaceScope={workspaceScope}
          materialId={material.id}
          lineageId={anchor.lineageId}
          defaultTitle={anchor.title}
          tasks={tasks.rows.filter((task) => task.lineageId === anchor.lineageId)}
          canApprove={tasks.canApprove}
          onChanged={() => void loadTasks()}
          onToast={onToast}
        />
      ) : null}
    />
  )

  if (mode === 'meeting') {
    return (
      <div className="material-review is-meeting">
        <div className="material-review-bar">{modeSwitch}</div>
        <MeetingMode
          anchors={decisionAnchors}
          decisionOf={decisionOf}
          summaryOf={summaryOf}
          renderPanel={(anchor) => thread(anchor)}
        />
      </div>
    )
  }

  if (mode === 'reading') {
    return (
      <div className="material-review is-reading">
        <div className="material-review-bar">{modeSwitch}{chips}</div>
        {progress}
        <ReadingList
          anchors={filtered}
          parentIds={parentIds}
          summaryOf={summaryOf}
          decisionLabel={(lineageId) => decisionOf(lineageId)?.status ?? null}
          selectedLineage={selectedLineage}
          scrollTarget={scrollTarget}
          readOnly={archived}
          onStance={(anchor, stance) => void applyStance(anchor, stance)}
          onOpenThread={(anchor) => setSelectedLineage((current) => (current === anchor.lineageId ? null : anchor.lineageId))}
          renderThread={(anchor) => thread(anchor)}
          onShowOriginal={(anchor) => { setMode('original'); setSelectedLineage(anchor.lineageId); setFollow(false); setScrollTarget(`${anchor.id}:${Date.now()}`) }}
        />
      </div>
    )
  }

  return (
    <div className="material-review is-original">
      <div className="material-review-bar">{modeSwitch}</div>
      {progress}
      <div className="material-review-grid">
        <MaterialFrame
          workspaceScope={workspaceScope}
          materialId={material.id}
          version={version}
          showNative={showNative}
          focusAnchorId={scrollTarget ? scrollTarget.split(':')[0] : null}
          onVisible={setVisible}
          onReady={(info) => onNativeControls(info.nativeControls)}
          onError={onToast}
        />
        <aside className="material-side" aria-label="항목과 의견">
          <div className="material-side-head">
            <h2>항목과 의견</h2>
            {!follow && <Button tone="quiet" size="sm" type="button" onClick={() => setFollow(true)}><Crosshair size={15} aria-hidden="true" /> 보는 곳 따라가기</Button>}
          </div>
          {chips}
          <ul className="material-items" aria-label="항목">
            {filtered.map((anchor) => {
              const summary = summaryOf(anchor.lineageId)
              return (
                <li key={anchor.id}>
                  <button
                    type="button"
                    className={`material-item depth-${Math.min(anchor.depth, 3)}${anchor.lineageId === selectedLineage ? ' is-selected' : ''}${visible.includes(anchor.id) ? ' is-visible' : ''}`}
                    aria-current={anchor.lineageId === selectedLineage ? 'true' : undefined}
                    onClick={() => pick(anchor)}
                  >
                    <span className="material-item-title">{anchor.title}</span>
                    <span className="material-item-meta">
                      {decisionOf(anchor.lineageId) ? <em className="is-decided">{decisionOf(anchor.lineageId)?.status}</em> : anchor.decisionEnabled && <em>결정 전</em>}
                      {summary.myStance && <span className={`stance-dot is-${summary.myStance}`}>내 생각: {STANCE_LABELS[summary.myStance]}</span>}
                      {summary.comments > 0 && <span><MessageSquare size={13} aria-hidden="true" /> {summary.comments}</span>}
                      {isSplit(summary) && <span className="material-split">의견 갈림</span>}
                    </span>
                  </button>
                </li>
              )
            })}
            {!filtered.length && <li className="material-items-empty">{anchors.length ? '이 조건에 맞는 항목이 없습니다.' : '항목을 불러오는 중입니다…'}</li>}
          </ul>
          <div className="material-thread-slot">{thread(selectedAnchor)}</div>
        </aside>
      </div>
    </div>
  )
}

/**
 * 회의 진행 모드 — 프로젝터·태블릿용. 결정 받을 항목을 한 장씩 크게 띄우고, 그 자리에서 반응·결정한다.
 * 기본은 "아직 결정하지 않은 항목"만. ←·→ 키로 넘긴다.
 */
function MeetingMode({ anchors, decisionOf, summaryOf, renderPanel }: {
  anchors: MaterialAnchor[]
  decisionOf: (lineageId: string) => MaterialDecision | null
  summaryOf: (lineageId: string | null) => LineageSummary
  renderPanel: (anchor: MaterialAnchor) => ReactNode
}) {
  const [includeDecided, setIncludeDecided] = useState(false)
  const list = anchors.filter((anchor) => includeDecided || !decisionOf(anchor.lineageId))
  const [index, setIndex] = useState(0)
  const current = list[Math.min(index, Math.max(0, list.length - 1))] ?? null
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      if (event.key === 'ArrowRight') setIndex((value) => Math.min(value + 1, Math.max(0, list.length - 1)))
      if (event.key === 'ArrowLeft') setIndex((value) => Math.max(0, value - 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [list.length])
  if (!current) {
    return (
      <div className="material-meeting-empty">
        <strong>결정할 항목이 남지 않았습니다.</strong>
        <Button tone="ghost" type="button" onClick={() => setIncludeDecided(true)}>결정한 항목도 다시 보기</Button>
      </div>
    )
  }
  const tally = summaryOf(current.lineageId).stances
  const position = Math.min(index, list.length - 1)
  return (
    <section className="material-meeting" aria-label="회의 진행">
      <div className="material-meeting-nav">
        <Button tone="ghost" type="button" disabled={position === 0} onClick={() => setIndex(position - 1)}><ChevronLeft size={20} aria-hidden="true" /> 이전</Button>
        <span aria-live="polite">{position + 1} / {list.length}{includeDecided ? '' : ' · 결정 전 항목'}</span>
        <Button tone="ghost" type="button" disabled={position >= list.length - 1} onClick={() => setIndex(position + 1)}>다음 <ChevronRight size={20} aria-hidden="true" /></Button>
      </div>
      <label className="material-dialog-check"><input type="checkbox" checked={includeDecided} onChange={(event) => { setIncludeDecided(event.target.checked); setIndex(0) }} /> 결정한 항목도 보기</label>
      <div className="material-meeting-grid">
        <article className="material-meeting-card">
          <h2>{current.title}</h2>
          <div className="material-meeting-tally" aria-label="찬반">
            {STANCE_ORDER.map((stance) => <span key={stance} className={`is-${stance}`}><strong>{tally[stance]}</strong>{STANCE_LABELS[stance]}</span>)}
          </div>
          <p className="material-reading-text">{readingBody(current).slice(0, 1_500)}{readingBody(current).length > 1_500 ? '…' : ''}</p>
        </article>
        <div className="material-meeting-panel">{renderPanel(current)}</div>
      </div>
    </section>
  )
}

function StanceBar({ summary, readOnly, onStance }: { summary: LineageSummary; readOnly: boolean; onStance: (stance: Stance) => void }) {
  return (
    <div className="stance-bar" role="group" aria-label="내 생각">
      {STANCE_ORDER.map((stance) => {
        const Icon = STANCE_ICONS[stance]
        const pressed = summary.myStance === stance
        return (
          <button key={stance} type="button" className={`stance-button is-${stance}`} aria-pressed={pressed} disabled={readOnly} onClick={() => onStance(stance)}>
            <Icon size={18} aria-hidden="true" />
            <span>{STANCE_LABELS[stance]}</span>
            <small aria-label={`${summary.stances[stance]}명`}>{summary.stances[stance]}</small>
          </button>
        )
      })}
    </div>
  )
}

function ItemThread({ workspaceScope, materialId, anchor, summary, comments, currentUserId, isAdmin, readOnly, onStance, onChanged, onToast, decisionSlot, aiSlot, taskSlot }: {
  workspaceScope?: string
  materialId: string
  anchor: MaterialAnchor | null
  summary: LineageSummary
  comments: MaterialComment[]
  currentUserId: string
  isAdmin: boolean
  readOnly: boolean
  onStance: (stance: Stance) => void
  onChanged: () => void
  onToast: (message: string) => void
  decisionSlot?: ReactNode
  aiSlot?: ReactNode
  taskSlot?: ReactNode
}) {
  const key = draftKey(materialId, anchor?.lineageId ?? null)
  const [body, setBody] = useState(() => readDraft(key))
  const [question, setQuestion] = useState(false)
  const [replyTo, setReplyTo] = useState<MaterialComment | null>(null)
  const [editing, setEditing] = useState<MaterialComment | null>(null)
  const [busy, setBusy] = useState(false)
  const requestIdRef = useRef(newClientRequestId())

  useEffect(() => { setBody(readDraft(key)); setReplyTo(null); setEditing(null); setQuestion(false); requestIdRef.current = newClientRequestId() }, [key])

  const roots = comments.filter((comment) => !comment.parentId)
  const repliesOf = (id: string) => comments.filter((comment) => comment.parentId === id)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const text = body.trim()
    if (!text || busy) return
    setBusy(true)
    try {
      if (editing) {
        await editComment(workspaceScope, materialId, editing.id, text)
        onToast('의견을 고쳤습니다. 이전 글은 기록으로 남습니다.')
      } else {
        await postComment(workspaceScope, materialId, { lineageId: anchor?.lineageId ?? null, body: text, parentId: replyTo?.id ?? null, question, clientRequestId: requestIdRef.current })
        onToast(replyTo ? '답글을 남겼습니다.' : question ? '질문을 남겼습니다. 답이 달리면 해결된 것으로 셉니다.' : '의견을 남겼습니다.')
      }
      setBody('')
      writeDraft(key, '')
      setReplyTo(null)
      setEditing(null)
      setQuestion(false)
      requestIdRef.current = newClientRequestId()
      onChanged()
    } catch (cause) {
      // 보내지 못한 글은 이 기기에 남겨 둔다 — 다시 누르면 같은 요청 번호로 한 번만 저장된다.
      writeDraft(key, text)
      onToast(cause instanceof Error ? cause.message : '의견을 남기지 못했습니다. 글은 이 기기에 남겨 두었습니다.')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (comment: MaterialComment) => {
    try { await deleteComment(workspaceScope, materialId, comment.id); onToast('의견을 지웠습니다. 지웠다는 흔적은 남습니다.'); onChanged() } catch (cause) { onToast(cause instanceof Error ? cause.message : '의견을 지우지 못했습니다.') }
  }

  const commentView = (comment: MaterialComment, reply = false) => (
    <article key={comment.id} className={`material-comment${reply ? ' is-reply' : ''}${comment.deleted ? ' is-deleted' : ''}`}>
      <header>
        <strong>{comment.authorName}</strong>
        {comment.question && !comment.deleted && <span className="material-question-tag">질문</span>}
        <time dateTime={comment.createdAt}>{formatDateTime(comment.createdAt)}</time>
        {comment.editedAt && !comment.deleted && <span className="material-edited" title={comment.editHistory.map((row) => row.body).join('\n—\n')}>수정됨</span>}
        {comment.version && <span className="material-version-tag">{comment.version}판</span>}
      </header>
      <p>{comment.deleted ? '지운 의견입니다.' : comment.body}</p>
      {!comment.deleted && !readOnly && (
        <div className="material-comment-actions">
          {!reply && <Button tone="quiet" size="sm" type="button" onClick={() => { setReplyTo(comment); setEditing(null) }}><Reply size={14} aria-hidden="true" /> 답글</Button>}
          {comment.authorId === currentUserId && <Button tone="quiet" size="sm" type="button" onClick={() => { setEditing(comment); setReplyTo(null); setBody(comment.body) }}><PencilLine size={14} aria-hidden="true" /> 고치기</Button>}
          {(comment.authorId === currentUserId || isAdmin) && <Button tone="quiet" size="sm" type="button" onClick={() => void remove(comment)}><Trash2 size={14} aria-hidden="true" /> 지우기</Button>}
        </div>
      )}
    </article>
  )

  return (
    <section className="material-thread" aria-label={anchor ? `${anchor.title} 의견` : '자료 전체 의견'}>
      <h3>{anchor ? anchor.title : '자료 전체에 대한 의견'}</h3>
      {decisionSlot}
      {taskSlot}
      {anchor && <StanceBar summary={summary} readOnly={readOnly} onStance={onStance} />}
      {aiSlot}
      <div className="material-comments">
        {roots.length === 0 && <p className="material-comments-empty">{anchor ? '아직 의견이 없습니다. 첫 의견을 남겨 주세요.' : '항목을 고르면 그 항목의 의견이 여기에 보입니다. 자료 전체에 대한 의견은 바로 남겨도 됩니다.'}</p>}
        {roots.map((comment) => (
          <div key={comment.id} className="material-comment-group">
            {commentView(comment)}
            {repliesOf(comment.id).map((reply) => commentView(reply, true))}
          </div>
        ))}
      </div>
      {!readOnly && (
        <form className="material-composer" onSubmit={(event) => void submit(event)}>
          {(replyTo || editing) && (
            <p className="material-composer-context">
              {editing ? '내 의견을 고치는 중' : `${replyTo?.authorName}님 의견에 답하는 중`}
              <Button tone="quiet" size="sm" type="button" onClick={() => { setReplyTo(null); setEditing(null); setBody(readDraft(key)) }}>그만두기</Button>
            </p>
          )}
          <label className="sr-only" htmlFor={`material-composer-${anchor?.id ?? 'all'}`}>의견</label>
          <textarea
            id={`material-composer-${anchor?.id ?? 'all'}`}
            value={body}
            rows={3}
            maxLength={2_000}
            placeholder={anchor ? '이 항목에 대한 생각을 한두 줄로 남겨 주세요.' : '자료 전체에 대한 의견을 남겨 주세요.'}
            onChange={(event) => { setBody(event.target.value); if (!editing) writeDraft(key, event.target.value) }}
          />
          <div className="material-composer-actions">
            {!replyTo && !editing && <label className="material-question-toggle"><input type="checkbox" checked={question} onChange={(event) => setQuestion(event.target.checked)} /> 질문으로 남기기</label>}
            <Button tone="primary" type="submit" disabled={busy || !body.trim()}>{busy ? '남기는 중…' : editing ? '고친 글 저장' : replyTo ? '답글 남기기' : '의견 남기기'}</Button>
          </div>
        </form>
      )}
    </section>
  )
}

function ReadingList({ anchors, parentIds, summaryOf, decisionLabel, selectedLineage, scrollTarget, readOnly, onStance, onOpenThread, renderThread, onShowOriginal }: {
  anchors: MaterialAnchor[]
  parentIds: Set<string>
  summaryOf: (lineageId: string | null) => LineageSummary
  decisionLabel: (lineageId: string) => string | null
  selectedLineage: string | null
  scrollTarget: string | null
  readOnly: boolean
  onStance: (anchor: MaterialAnchor, stance: Stance) => void
  onOpenThread: (anchor: MaterialAnchor) => void
  renderThread: (anchor: MaterialAnchor) => ReactNode
  onShowOriginal: (anchor: MaterialAnchor) => void
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (!scrollTarget) return
    const id = scrollTarget.split(':')[0]
    window.requestAnimationFrame(() => document.getElementById(`reading-${id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }))
  }, [scrollTarget])
  if (!anchors.length) return <p className="material-items-empty">이 조건에 맞는 항목이 없습니다.</p>
  return (
    <ol className="material-reading">
      {anchors.map((anchor) => {
        const summary = summaryOf(anchor.lineageId)
        const heading = parentIds.has(anchor.id)
        const body = readingBody(anchor)
        const long = body.length > 600
        const open = expanded.has(anchor.id)
        return (
          <li key={anchor.id} id={`reading-${anchor.id}`} className={`material-reading-item depth-${Math.min(anchor.depth, 3)}${heading ? ' is-heading' : ''}`}>
            {heading ? <h3>{anchor.title}</h3> : (
              <article>
                <header>
                  <h3>{anchor.title}</h3>
                  {decisionLabel(anchor.lineageId) ? <em className="material-decision-tag is-decided">결정: {decisionLabel(anchor.lineageId)}</em> : anchor.decisionEnabled && <em className="material-decision-tag">결정 받을 항목</em>}
                  {Object.entries(anchor.attributes ?? {}).slice(0, 3).map(([name, value]) => <span key={name} className="material-attr">{value}</span>)}
                </header>
                <p className="material-reading-text">{long && !open ? `${body.slice(0, 600)}…` : body}</p>
                <div className="material-reading-actions">
                  {long && <Button tone="quiet" size="sm" type="button" onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(anchor.id)) next.delete(anchor.id); else next.add(anchor.id); return next })}>{open ? '접기' : '더 보기'}</Button>}
                  <Button tone="quiet" size="sm" type="button" onClick={() => onShowOriginal(anchor)}><MonitorPlay size={15} aria-hidden="true" /> 원본에서 보기</Button>
                </div>
                <StanceBar summary={summary} readOnly={readOnly} onStance={(stance) => onStance(anchor, stance)} />
                <Button tone={selectedLineage === anchor.lineageId ? 'secondary' : 'ghost'} full type="button" aria-expanded={selectedLineage === anchor.lineageId} onClick={() => onOpenThread(anchor)}>
                  <MessageSquare size={17} aria-hidden="true" /> {selectedLineage === anchor.lineageId ? '의견 닫기' : summary.comments ? `의견 ${summary.comments}개 보기 · 남기기` : '의견 남기기'}
                </Button>
                {selectedLineage === anchor.lineageId && renderThread(anchor)}
              </article>
            )}
          </li>
        )
      })}
    </ol>
  )
}

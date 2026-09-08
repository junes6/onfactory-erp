import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileSignature, RefreshCw, ShieldAlert, UserCheck } from 'lucide-react'
import { formatDateTime } from '../../utils/dateTime'
import {
  approvalListEmptyText,
  approvalSeenAt,
  canDecideNow,
  canEditDraft,
  canRecall,
  formatKrw,
  lineProgress,
  markApprovalSeen,
  stepLabel,
  stepState,
} from '../../utils/approvalLine'
import { StatusBadge } from '../StatusBadge'
import { Button } from '../ui/Button'
import { ApprovalDetailDialog } from './ApprovalDetailDialog'
import { ApprovalDraftDialog } from './ApprovalDraftDialog'
import { ApprovalFormAdmin } from './ApprovalFormAdmin'
import {
  APPROVAL_STATUS_SLUG,
  APPROVAL_STATUS_TONE,
  type ApprovalAccount,
  type ApprovalDelegate,
  type ApprovalDocument,
  type ApprovalForm,
  type ApprovalMember,
  type ApprovalStatus,
  type ApprovalSummary,
} from './approvalTypes'
import './approval.css'

type Tab = 'waiting' | 'drafted' | 'cc' | 'all'
/** 서버 `APPROVAL_STATUS_SET` 과 같은 어휘. 빈 문자열은 「전부」다(서버도 빈 값을 그렇게 읽는다). */
type StatusFilter = '' | ApprovalStatus

const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: '', label: '모든 상태' },
  { id: '기안', label: '기안' },
  { id: '결재중', label: '결재중' },
  { id: '승인', label: '승인' },
  { id: '반려', label: '반려' },
  { id: '회수', label: '회수' },
]

const TABS: { id: Tab; label: string }[] = [
  { id: 'waiting', label: '내 결재' },
  { id: 'drafted', label: '내가 올린 것' },
  { id: 'cc', label: '참조' },
  { id: 'all', label: '전체' },
]

const EMPTY_SUMMARY: ApprovalSummary = { waitingOnMe: 0, drafted: 0, cc: 0, decidedUnread: 0 }

/**
 * 한 번에 받아 오는 줄 수. 서버 `MAX_LIST_LIMIT` 과 같은 값이어야 한다 —
 * 이 수보다 크게 부르면 서버가 조용히 100 으로 자르고, 다음 묶음의 offset 이 어긋난다.
 * (`scripts/approval-ui-contract.test.mjs` 가 두 수를 맞대 본다.)
 */
const PAGE_SIZE = 100

type ListResponse = {
  documents?: ApprovalDocument[]
  summary?: ApprovalSummary
  total?: number
  error?: { message?: string }
}

/**
 * 승인 큐 화면 **안**에 사는 전자결재 섹션. 별도의 결재 목록 화면을 만들지 않는다 —
 * 결재 대기와 AI 제안은 「사람이 결정해야 하는 것」이라는 같은 일이고, 두 곳에 나눠 두면
 * 어느 쪽도 「오늘 내가 결정할 것 전부」를 말하지 못한다.
 *
 * 갱신은 이 섹션이 스스로 한다(60초 + 탭이 앞으로 돌아올 때 1회). `ApprovalQueue`의 30초 폴링은
 * `/api/proposals`(관리자 전용)라 직원에게는 도달하지 않기 때문이다.
 */
export function ApprovalDocumentSection({
  account, workspaceScope, focusId, draftOpen, formAdminOpen,
  onCloseDraft, onCloseFormAdmin, onToast, onWaitingChange, onModalChange,
}: {
  account: ApprovalAccount
  workspaceScope?: string
  focusId?: string
  draftOpen: boolean
  formAdminOpen: boolean
  onCloseDraft: () => void
  onCloseFormAdmin: () => void
  onToast: (message: string) => void
  /** 결재 대기와 결과 확인은 **다른 사실**이다. 하나로 합쳐 올리면 부르는 쪽이 둘을 갈라 말할 수 없다. */
  onWaitingChange?: (summary: { waiting: number; decided: number }) => void
  /** 이 섹션이 대화상자를 그리고 있는가. 승인 큐의 한 글자 단축키가 그 위에서 살면 안 된다. */
  onModalChange?: (open: boolean) => void
}) {
  const [tab, setTab] = useState<Tab>('waiting')
  const [status, setStatus] = useState<StatusFilter>('')
  const [documents, setDocuments] = useState<ApprovalDocument[]>([])
  /**
   * 지금까지 「더 보기」로 펼친 묶음 수. 탭·상태를 바꾸면 1로 돌아간다.
   * 60초 폴링도 이 수만큼 다시 읽는다 — 첫 묶음만 다시 읽으면 사람이 펼쳐 둔 줄이 조용히 사라진다.
   */
  const [pages, setPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [summary, setSummary] = useState<ApprovalSummary>(EMPTY_SUMMARY)
  const [forms, setForms] = useState<ApprovalForm[]>([])
  const [delegate, setDelegate] = useState<ApprovalDelegate | null>(null)
  const [members, setMembers] = useState<ApprovalMember[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [detailId, setDetailId] = useState('')
  const [editing, setEditing] = useState<ApprovalDocument | null>(null)
  const [busyId, setBusyId] = useState('')

  const headers = useMemo(() => (workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined), [workspaceScope])
  const jsonHeaders = useMemo(() => ({ 'content-type': 'application/json', ...(headers ?? {}) }), [headers])
  const isAdmin = account.role === 'tenant-admin'

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const seenAt = approvalSeenAt(account.id)
      // 펼쳐 둔 묶음을 한꺼번에 다시 읽는다. 목록은 그 사이에 순서가 바뀔 수 있으므로
      // 이어 붙일 때 id 로 중복을 걷어낸다 — 같은 줄이 두 번 그려지면 React key 가 부딪힌다.
      const responses = await Promise.all(Array.from({ length: pages }, async (_unused, index) => {
        const params = new URLSearchParams({ scope: tab, seenAt, limit: String(PAGE_SIZE) })
        if (status) params.set('status', status)
        if (index > 0) params.set('offset', String(index * PAGE_SIZE))
        const response = await fetch(`/api/approval-documents?${params}`, { headers })
        const body = await response.json() as ListResponse
        if (!response.ok) throw new Error(body.error?.message || '결재 문서를 불러오지 못했습니다.')
        return body
      }))
      const seen = new Set<string>()
      const rows: ApprovalDocument[] = []
      for (const body of responses) {
        for (const row of Array.isArray(body.documents) ? body.documents : []) {
          if (!row?.id || seen.has(row.id)) continue
          seen.add(row.id)
          rows.push(row)
        }
      }
      setDocuments(rows)
      // 서버는 한 묶음 100건에서 자르고 `total` 에 **자르기 전** 개수를 담는다. 그 둘이 다르면
      // 화면이 그 사실을 적고 나머지에 닿는 길(더 보기)을 함께 준다 — 탭에 「105」라 써 놓고
      // 100줄만 그리면 세는 수와 보여 주는 수가 화면에서 갈린다(규칙 11·13).
      const first = responses[0]
      setTotal(Number.isFinite(first?.total) ? Number(first?.total) : rows.length)
      const next = first?.summary ?? EMPTY_SUMMARY
      setSummary(next)
      onWaitingChange?.({ waiting: next.waitingOnMe, decided: next.decidedUnread })
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '결재 문서를 불러오지 못했습니다.')
    } finally {
      setLoading(false)
    }
  }, [account.id, headers, onWaitingChange, pages, status, tab])

  const loadForms = useCallback(async () => {
    try {
      // 관리자에게는 **내려둔 양식까지** 달라고 한다(서버가 `&& isAdmin`으로 이미 막고 있다).
      // 이 한 글자가 없으면 「내리기」를 누른 양식이 그 자리에서 목록에서 사라져, 같은 화면의
      // 「다시 쓰기」 버튼에 도달할 길이 없다 — 실수로 내린 양식을 되살릴 방법이 UI에 남지 않는다.
      // 기안 대화상자는 `form.active !== false`로 고를 수 있는 것만 추리므로 기안에는 영향이 없다.
      const response = await fetch(`/api/approval-forms${isAdmin ? '?all=1' : ''}`, { headers })
      const body = await response.json() as { forms?: ApprovalForm[]; delegate?: ApprovalDelegate | null; error?: { message?: string } }
      if (!response.ok) return
      setForms(Array.isArray(body.forms) ? body.forms : [])
      setDelegate(body.delegate ?? null)
    } catch {
      /* 양식을 못 읽어도 목록은 그대로 돈다. 기안 대화상자가 그때 사유를 말한다. */
    }
  }, [headers, isAdmin])

  useEffect(() => { void load() }, [load])
  useEffect(() => { void loadForms() }, [loadForms])

  useEffect(() => {
    let active = true
    fetch('/api/directory', { headers })
      .then(async (response) => (response.ok ? response.json() as Promise<{ members?: (ApprovalMember & { kind?: string; system?: boolean })[] }> : { members: [] }))
      .then((body) => {
        if (!active) return
        setMembers((body.members ?? [])
          .filter((member) => member.id && member.name && !member.system && member.kind === 'employee')
          .map((member) => ({ id: member.id, name: member.name, team: member.team, active: member.active !== false })))
      })
      .catch(() => { if (active) setMembers([]) })
    return () => { active = false }
  }, [headers])

  useEffect(() => {
    const timer = window.setInterval(() => { void load(true) }, 60_000)
    const onVisible = () => { if (window.document.visibilityState === 'visible') void load(true) }
    window.document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      window.document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load])

  /**
   * 대화상자가 열려 있는지를 답하는 곳은 그것을 실제로 그리는 이 컴포넌트 하나다.
   * 승인 큐의 전역 한 글자 단축키(Enter/A·E·X)가 이 대화상자 위에서 계속 살면, 결재 상세의
   * 「승인」에 포커스를 두고 Enter 를 누르는 순간 그 기본 동작이 삼켜지고 무관한 AI 제안의
   * 확인 대화상자가 그 위에 겹쳐 뜬다.
   */
  const modalOpen = Boolean(draftOpen || editing || detailId || (formAdminOpen && isAdmin))
  useEffect(() => { onModalChange?.(modalOpen) }, [modalOpen, onModalChange])

  // 알림·푸시가 지목한 문서를 마운트하자마자 연다. 한 번 연 뒤에는 스스로 다시 열지 않는다.
  const consumedFocus = useRef('')
  useEffect(() => {
    if (!focusId || consumedFocus.current === focusId) return
    consumedFocus.current = focusId
    setDetailId(focusId)
  }, [focusId])

  /**
   * 「내가 올린 것」을 펼치는 순간이 곧 결과를 본 순간이다. 그때 확인 시각을 남겨
   * 승인·반려가 끝난 문서의 점이 꺼진다. 저장소가 막힌 브라우저에서는 점이 켜진 채로 남을 뿐이다.
   */
  const openTab = (next: Tab) => {
    if (next === 'drafted') markApprovalSeen(account.id, new Date().toISOString())
    setTab(next)
    // 펼쳐 둔 묶음은 이 탭의 사실이었다. 다른 탭에서 그대로 들고 있으면 첫 화면부터
    // 서너 번의 요청이 나가고, 그 탭에서 아무도 「더 보기」를 누른 적이 없다.
    setPages(1)
  }

  const chooseStatus = (next: StatusFilter) => {
    setStatus(next)
    setPages(1)
  }

  const recall = async (target: ApprovalDocument) => {
    if (busyId) return
    setBusyId(target.id)
    try {
      const response = await fetch(`/api/approval-documents/${encodeURIComponent(target.id)}/recall`, {
        method: 'POST', headers: jsonHeaders, body: JSON.stringify({ version: target.version }),
      })
      const body = await response.json() as { error?: { message?: string } }
      if (!response.ok) throw new Error(body.error?.message || '결재를 회수하지 못했습니다.')
      onToast('결재를 회수했습니다.')
      await load(true)
    } catch (reason) {
      onToast(reason instanceof Error ? reason.message : '결재를 회수하지 못했습니다.')
    } finally {
      setBusyId('')
    }
  }

  /**
   * 이 줄이 지금 내 차례인가. `waiting` 탭의 목록은 서버가 자기 술어(`canDecide`)로 이미 걸러 준 것이라
   * 그대로 믿는다. 다른 탭에서는 거울 함수로 짐작하는데, 화면은 「내가 누구의 대결자인가」를 알 수 없어
   * (양식 라우트는 **내 대결자**만 알려 준다) 대결 자리를 놓칠 수 있다. 그때도 줄을 눌러 상세를 열면
   * 서버가 준 `permissions.canDecide` 로 그대로 결재할 수 있다 — 화면이 막다른 길을 만들지 않는다(규칙 1).
   */
  const isMyTurn = (item: ApprovalDocument) => tab === 'waiting' || canDecideNow(item, account.id)

  /**
   * 행 버튼은 언제나 최대 한 개다. 「이 줄에서 지금 할 수 있는 가장 중요한 일」 하나만 남기고,
   * 승인·반려처럼 사유가 필요한 결정은 상세 대화상자 안에 둔다.
   */
  const actionFor = (item: ApprovalDocument): { label: string; run: () => void } | null => {
    if (isMyTurn(item)) return { label: '결재하기', run: () => setDetailId(item.id) }
    if (canEditDraft(item, account.id)) return { label: '이어서 작성', run: () => setEditing(item) }
    if (canRecall(item, account.id)) return { label: '회수', run: () => { void recall(item) } }
    return null
  }

  const countFor = (id: Tab) => (id === 'waiting' ? summary.waitingOnMe : id === 'drafted' ? summary.drafted : id === 'cc' ? summary.cc : null)

  return <>
    <section className="panel approval-doc-section" aria-label="전자결재">
      <div className="approval-doc-toolbar">
        <div className="approval-doc-tabs" role="tablist" aria-label="결재 문서 범위">
          {TABS.map((entry) => {
            const count = countFor(entry.id)
            return <button key={entry.id} type="button" role="tab" aria-selected={tab === entry.id} onClick={() => openTab(entry.id)}>
              {entry.label}
              {count === null ? null : <em>{count}</em>}
              {entry.id === 'drafted' && summary.decidedUnread > 0
                ? <i className="approval-doc-dot" role="img" aria-label={`결과가 나온 문서 ${summary.decidedUnread}건`} />
                : null}
            </button>
          })}
        </div>
        <div className="approval-doc-toolbar-end">
          {/* 목록은 100건에서 잘린다. 잘렸다는 사실만 적고 좁힐 길을 주지 않으면 그 문장이 막다른 길이다. */}
          <label className="approval-doc-filter">
            <span className="sr-only">결재 상태로 좁히기</span>
            <select aria-label="결재 상태로 좁히기" value={status} onChange={(event) => chooseStatus(event.target.value as StatusFilter)}>
              {STATUS_FILTERS.map((entry) => <option key={entry.id || 'all'} value={entry.id}>{entry.label}</option>)}
            </select>
          </label>
          {delegate
            ? <span className="approval-doc-delegate"><UserCheck size={14} /> {delegate.delegateName}님이 {delegate.from}~{delegate.to} 대결</span>
            : null}
        </div>
      </div>

      {error
        ? <div className="approval-doc-error"><span><ShieldAlert size={15} /> {error}</span><Button tone="ghost" size="sm" type="button" onClick={() => void load()}>다시 시도</Button></div>
        : null}

      {loading
        ? <p className="approval-doc-empty"><RefreshCw size={16} /> 결재 문서를 불러오는 중</p>
        : documents.length === 0
          ? <p className="approval-doc-empty">
            {approvalListEmptyText(tab, status)}
            {/* 필터가 걸려 있으면 그것을 푸는 길을 그 자리에서 준다 — 탭 숫자와 본문이 서로를
                부정하는 화면에서 사람이 「고장났다」로 읽지 않도록. */}
            {status
              ? <Button tone="ghost" size="sm" type="button" onClick={() => chooseStatus('')}>모든 상태 보기</Button>
              : null}
          </p>
          : <ul className="approval-doc-list" role="list" aria-label="결재 문서">
            {documents.map((item) => {
              const progress = lineProgress(item)
              const action = actionFor(item)
              return <li key={item.id} className={`approval-doc-row is-${APPROVAL_STATUS_SLUG[item.status] ?? 'draft'}${item.id === detailId ? ' is-selected' : ''}`}>
                <StatusBadge className="status-pill approval-doc-kind" tone={APPROVAL_STATUS_TONE[item.status] ?? 'neutral'} icon={<FileSignature size={13} />}>{item.kind}</StatusBadge>
                <button type="button" className="approval-doc-main" onClick={() => setDetailId(item.id)}>
                  <strong>{item.title}</strong>
                  <small>
                    {item.drafterName} · {formatDateTime(item.submittedAt ?? item.createdAt)}
                    {item.posting ? <> · <b className="approval-doc-amount">{formatKrw(item.posting.amount)}</b></> : null}
                    {item.status === '반려' && item.rejectionReason ? <> · 사유 {item.rejectionReason}</> : null}
                  </small>
                  <span className="approval-doc-line" aria-label={`결재 진행 ${progress.done}/${progress.total}단계`}>
                    {item.line.map((step) => <i key={step.step} className={`approval-doc-step${stepState(step, item)}`} />)}
                    <em>{stepLabel(item)}</em>
                  </span>
                </button>
                {action
                  ? <Button tone="secondary" size="sm" type="button" disabled={busyId === item.id}
                    onClick={(event) => { event.stopPropagation(); action.run() }}>{action.label}</Button>
                  : <span className="approval-doc-quiet">{item.status}</span>}
              </li>
            })}
            {/* 「남은 N건」을 말했으면 그 N건에 닿는 길이 실제로 있어야 한다(규칙 11).
                상태 좁히기는 「내 결재」 탭에서 갈래를 만들지 못한다 — 그 탭은 서버가 canDecide 로
                거르고 canDecide 는 '결재중'만 통과시키므로 여섯 갈래 중 다섯이 0건이다. */}
            {documents.length < total
              ? <li className="approval-doc-more">
                <span>{`${documents.length}건을 보여 주고 있습니다 · 남은 ${total - documents.length}건`}</span>
                <Button tone="ghost" size="sm" type="button" disabled={loading} onClick={() => setPages((current) => current + 1)}>더 보기</Button>
              </li>
              : null}
          </ul>}
    </section>

    {draftOpen || editing
      ? <ApprovalDraftDialog
        account={account}
        workspaceScope={workspaceScope}
        forms={forms}
        members={members}
        draft={editing}
        onToast={onToast}
        onClose={() => { setEditing(null); onCloseDraft() }}
        onSaved={() => { setEditing(null); onCloseDraft(); void load(true) }}
        onRefresh={() => { void load(true) }}
      />
      : null}

    {detailId
      ? <ApprovalDetailDialog
        documentId={detailId}
        workspaceScope={workspaceScope}
        onToast={onToast}
        onClose={() => setDetailId('')}
        onChanged={() => { void load(true) }}
      />
      : null}

    {formAdminOpen && isAdmin
      ? <ApprovalFormAdmin
        workspaceScope={workspaceScope}
        forms={forms}
        members={members}
        onToast={onToast}
        onClose={onCloseFormAdmin}
        onSaved={() => { void loadForms(); void load(true) }}
      />
      : null}
  </>
}

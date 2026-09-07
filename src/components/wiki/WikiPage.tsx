import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Archive, ArchiveRestore, History, Pencil, Send, Sparkles } from 'lucide-react'
import { Button } from '../ui/Button'
import { ErrorState, SaveState, Skeleton } from '../ui/States'
import { StatusBadge } from '../StatusBadge'
import { WikiTree, type WikiTreeItem } from './WikiTree'
import { WikiEditor } from './WikiEditor'
import { WikiOutline } from './WikiOutline'
import { WikiRevisions } from './WikiRevisions'
import type { BlockAttachment, BlockNotice } from './WikiBlock'
import type { WikiLinkTarget } from './WikiLinkText'
import { PRESENCE_HEARTBEAT_MS, MAX_TITLE, clientBlockPayload, newBlockId, type WikiBlock } from './wikiBlocks'
import { createWikiOpQueue, mergeServerBlocks, newInsertOp, rejectionNotice, type SaveStatus, type WikiOp, type WikiOpsResponse, type WikiPresenceEntry } from './wikiOps'
import { uploadDocumentAttachments } from '../../utils/documentAttachments'
import { formatDateTime } from '../../utils/dateTime'
import type { LensTarget } from '../LensPanel'
import type { StreamEvent } from '../../hooks/useEventStream'
import './Wiki.css'

/**
 * 문서 화면의 셸.
 *
 * 이 화면은 `/api/events` 연결을 새로 만들지 않는다. 계정당 열려 있는 연결이 이미 둘이라, 세 번째를
 * 만들면 브라우저의 오리진당 연결 상한에 걸려 **다른 화면의 실시간 갱신이 먼저 죽는다.** 대신 App이
 * 이미 열어 둔 스트림에서 `wiki` 프레임만 여기로 넘겨받는다(`streamRef`).
 *
 * 스트림은 **재조회 트리거로만** 쓴다. 프레임에는 본문도 제목도 실리지 않는다 — `/api/events`에는
 * 신원 핀이 없어서(EventSource가 커스텀 헤더를 못 싣는다) 본문을 실으면 권한 판정이 한 겹 얇아진다.
 */

type WikiListResponse = { documents: WikiTreeItem[]; templates: WikiTreeItem[]; aiLevels: Record<string, string> }
type WikiDocument = {
  id: string; title: string; icon: string; parentId: string | null; projectId: string | null
  blocks: WikiBlock[]; version: number; summary: string; aiLevel: string; writeScope: string
  archivedAt: string | null; lastEditedAt: string | null; lastEditedByName: string
}
type WikiDetail = {
  document: WikiDocument
  permissions: { canWrite: boolean; canManage: boolean }
  breadcrumb: { id: string; title: string; icon: string }[]
  attachments: BlockAttachment[]
  presence: WikiPresenceEntry[]
  toc: { id: string; level: number; text: string }[]
  revisionCount: number
}

const readJson = async <T,>(response: Response) => {
  try { return await response.json() as T & { error?: { message?: string; code?: string } } }
  catch { return {} as T & { error?: { message?: string; code?: string } } }
}

export function WikiPage({ workspaceScope, currentUserId, currentUserName, canManage, focusDocumentId, focusProjectId, onFocusHandled, streamRef, onAskLens, onOpenTask, onToast }: {
  workspaceScope?: string
  currentUserId: string
  currentUserName: string
  canManage: boolean
  focusDocumentId?: string
  /** 프로젝트 상세의 ‘문서 N건’이 지목한 프로젝트. 목록을 그 프로젝트로 좁혀 연다. */
  focusProjectId?: string
  /** 지목된 문서를 한 번 열었다고 알린다. 부모가 여기서 지워야 다음에 이 메뉴로 올 때 목록에 닿는다. */
  onFocusHandled?: () => void
  /** App의 스트림 핸들러가 여기에 자기를 꽂는다. 마운트 동안만 채워 두고 나갈 때 비운다. */
  streamRef: RefObject<((event: StreamEvent) => void) | null>
  onAskLens: (target: LensTarget) => void
  onOpenTask: (taskId: string) => void
  onToast: (message: string) => void
}) {
  const headers = useMemo(() => ({ 'content-type': 'application/json', ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}) }), [workspaceScope])
  const [list, setList] = useState<WikiListResponse | null>(null)
  const [listError, setListError] = useState('')
  const [query, setQuery] = useState('')
  const [archivedMode, setArchivedMode] = useState(false)
  const [projectFilter, setProjectFilter] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | null>(focusDocumentId ?? null)
  const [detail, setDetail] = useState<WikiDetail | null>(null)
  const [blocks, setBlocks] = useState<WikiBlock[]>([])
  const [detailError, setDetailError] = useState('')
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [statusDetail, setStatusDetail] = useState('')
  const [savedAt, setSavedAt] = useState('')
  const [notices, setNotices] = useState<Map<string, BlockNotice>>(() => new Map())
  const [presence, setPresence] = useState<WikiPresenceEntry[]>([])
  const [changedIds, setChangedIds] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [readMode, setReadMode] = useState(true)
  const [narrow, setNarrow] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyFocus, setHistoryFocus] = useState<number | null>(null)
  const [titleDraft, setTitleDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const queueRef = useRef<ReturnType<typeof createWikiOpQueue> | null>(null)
  const focusedBlockRef = useRef<string | null>(null)
  const composingRef = useRef(false)
  const pendingRef = useRef<string[]>([])
  const reloadTimerRef = useRef<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const attachTargetRef = useRef<{ kind: 'image' | 'file'; afterBlockId: string } | null>(null)
  const clientId = useRef(`WCL-${Math.random().toString(36).slice(2, 10).toUpperCase()}`)

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(max-width: 768px)')
    const apply = () => setNarrow(media.matches)
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [])

  const loadList = useCallback(async (silent = false) => {
    if (!silent) setListError('')
    try {
      const params = new URLSearchParams()
      if (archivedMode) params.set('archived', '1')
      if (query.trim()) params.set('q', query.trim())
      if (projectFilter) params.set('projectId', projectFilter)
      const response = await fetch(`/api/wiki${params.toString() ? `?${params}` : ''}`, { headers })
      const body = await readJson<WikiListResponse>(response)
      if (!response.ok) throw new Error(body.error?.message || '문서 목록을 불러오지 못했습니다.')
      setList({ documents: body.documents ?? [], templates: body.templates ?? [], aiLevels: body.aiLevels ?? {} })
    } catch (cause) {
      setList({ documents: [], templates: [], aiLevels: {} })
      setListError(cause instanceof Error ? cause.message : '문서 목록을 불러오지 못했습니다.')
    }
  }, [archivedMode, headers, projectFilter, query])

  useEffect(() => { void loadList() }, [loadList])

  useEffect(() => {
    if (!focusDocumentId && !focusProjectId) return
    if (focusProjectId) { setProjectFilter(focusProjectId); setActiveId(null) }
    if (focusDocumentId) setActiveId(focusDocumentId)
    onFocusHandled?.()
  }, [focusDocumentId, focusProjectId, onFocusHandled])

  /** 서버 문서를 화면에 얹는다. 조합 중이거나 포커스가 있는 문단의 본문은 로컬 값을 지킨다. */
  const applyServerDocument = useCallback((document: WikiDocument) => {
    setBlocks((current) => mergeServerBlocks(current, document.blocks ?? [], {
      focusedBlockId: focusedBlockRef.current,
      composing: composingRef.current,
      pendingBlockIds: pendingRef.current,
    }))
  }, [])

  const loadDocument = useCallback(async (id: string, options: { keepBlocks?: boolean } = {}) => {
    setDetailError('')
    try {
      const response = await fetch(`/api/wiki/${encodeURIComponent(id)}`, { headers })
      const body = await readJson<WikiDetail>(response)
      if (!response.ok) throw new Error(body.error?.message || '문서를 불러오지 못했습니다.')
      setDetail(body)
      setPresence(body.presence ?? [])
      queueRef.current?.setBaseVersion(Number(body.document.version))
      if (options.keepBlocks) applyServerDocument(body.document)
      else setBlocks(body.document.blocks ?? [])
      setChangedIds((current) => { const next = new Set(current); next.delete(id); return next })
    } catch (cause) {
      setDetail(null)
      setDetailError(cause instanceof Error ? cause.message : '문서를 불러오지 못했습니다.')
    }
  }, [applyServerDocument, headers])

  // 문서를 바꾸면 큐도 새로 만든다. 남은 조각은 앞 문서의 것이라 새 문서로 넘어가면 안 된다.
  useEffect(() => {
    setNotices(new Map())
    setStatus('idle')
    setStatusDetail('')
    if (!activeId) { setDetail(null); setBlocks([]); return }
    const queue = createWikiOpQueue({
      documentId: activeId,
      clientId: clientId.current,
      // 서버가 돌려준 seq가 **내가 올린 것인지** 가리는 데 쓴다 — 아니면 내 편집이 나를 밀어낸 것으로 기록된다.
      accountId: currentUserId,
      headers: () => headers,
      handlers: {
        onStatus: (next, message) => {
          setStatus(next)
          setStatusDetail(message ?? '')
          if (next === 'saved') setSavedAt(formatDateTime(new Date().toISOString()))
        },
        onApplied: (result) => onServerResult(result),
        onPending: (ids) => { pendingRef.current = ids },
      },
    })
    queueRef.current = queue
    void loadDocument(activeId)
    return () => {
      // **정리가 새 효과 본문보다 먼저 돈다.** 그래서 못 보낸 편집을 보내는 자리는 여기뿐이다 —
      // 본문 첫 줄에 두면 이미 dispose된 큐에 닿아 아무 일도 하지 않는 죽은 코드가 되고,
      // 문서를 바꾸거나 화면을 떠날 때마다 사람이 방금 친 문장이 통째로 사라진다.
      // 응답을 기다릴 수 없으므로 keepalive 한 방으로 보낸다(들어갔는지는 다음에 그 문서를 열 때
      // 서버 버전이 말해 준다 — `flushBeacon` 주석).
      queue.flushBeacon()
      queue.dispose()
    }
    // onServerResult는 매 렌더 새로 만들어지므로 의존성에 넣지 않는다 — 넣으면 큐가 매번 다시 생긴다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, currentUserId, headers, loadDocument])

  const onServerResult = (result: WikiOpsResponse) => {
    applyServerDocument(result.document as unknown as WikiDocument)
    setDetail((current) => (current ? { ...current, document: { ...current.document, ...result.document } as WikiDocument } : current))
    setPresence(result.presence ?? [])
    if (!result.overwrites.length && !result.rejected.length) return
    setNotices((current) => {
      const next = new Map(current)
      for (const overwrite of result.overwrites) {
        next.set(overwrite.blockId, {
          code: 'overwrite',
          message: `${overwrite.previousByName || '다른 사람'}님이 이 문단을 먼저 고쳤습니다. 밀린 문장은 이력에 있습니다.`,
          version: Number(result.version),
        })
      }
      // 문장은 `rejectionNotice` 한 자리에서 고른다 — 서버가 `lostTextDropped`로 "이력에도 없다"고
      // 답한 거절에 화면이 "이력에 있습니다"라고 말하면, 그 문장은 어디에도 없는데 사람만 있는 줄 안다.
      for (const rejection of result.rejected) {
        if (!rejection.blockId) continue
        const notice = rejectionNotice(rejection, Number(result.version))
        if (notice) next.set(rejection.blockId, notice)
      }
      return next
    })
  }

  const applyOps = (nextBlocks: WikiBlock[], ops: WikiOp[]) => {
    setBlocks(nextBlocks)
    // 사람이 **스스로** 지운 문단의 안내는 남기지 않는다. 남기면 '지워진 문단' 목록으로 올라가
    // 방금 자기가 한 일을 다른 사람이 한 것처럼 말한다.
    const removed = ops.filter((op) => op.kind === 'delete').map((op) => op.blockId)
    if (removed.length) {
      setNotices((current) => {
        const next = new Map(current)
        for (const id of removed) next.delete(id)
        return next
      })
    }
    queueRef.current?.push(...ops)
  }

  // ── 스트림 ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const handle = (event: StreamEvent) => {
      const data = event.data as { change?: string; documentId?: string; byId?: string; roster?: WikiPresenceEntry[] }
      if (event.kind === 'resync') { void loadList(true); if (activeId) void loadDocument(activeId, { keepBlocks: true }); return }
      if (event.kind !== 'wiki') return
      const documentId = String(data.documentId ?? '')
      if (data.change === 'presence') {
        if (documentId === activeId) setPresence(data.roster ?? [])
        return
      }
      if (documentId !== activeId) {
        if (documentId) setChangedIds((current) => new Set([...current, documentId]))
        void loadList(true)
        return
      }
      if (data.byId === currentUserId) return
      // 400ms 트레일링 디바운스. 남이 한 글자씩 칠 때마다 200KB를 다시 받아 오지 않는다.
      if (reloadTimerRef.current !== null) window.clearTimeout(reloadTimerRef.current)
      reloadTimerRef.current = window.setTimeout(() => {
        reloadTimerRef.current = null
        void loadDocument(activeId, { keepBlocks: true })
      }, 400)
    }
    streamRef.current = handle
    return () => {
      streamRef.current = null
      if (reloadTimerRef.current !== null) window.clearTimeout(reloadTimerRef.current)
    }
  }, [activeId, currentUserId, loadDocument, loadList, streamRef])

  // ── 프레즌스 ──────────────────────────────────────────────────────────────
  const beat = useCallback(async (blockId: string | null, leaving = false) => {
    if (!activeId) return
    // 서버는 **그 문서에 실제로 있는 문단 id**만 받는다(없으면 400). 방금 만든 문단은 조각이 아직
    // 큐에 있어 서버가 모르므로, 그 사이에는 문단을 말하지 않고 '이 문서에 있다'만 알린다.
    // 조각이 올라간 다음 박자에 자연히 그 문단이 실린다.
    const known = blockId && !pendingRef.current.includes(blockId) ? blockId : null
    try {
      const response = await fetch(`/api/wiki/${encodeURIComponent(activeId)}/presence`, {
        method: 'POST', headers, body: JSON.stringify({ blockId: known, leaving }),
      })
      if (!response.ok) return
      const body = await readJson<{ roster: WikiPresenceEntry[] }>(response)
      setPresence(body.roster ?? [])
    } catch { /* 다음 박자에 다시 알린다 */ }
  }, [activeId, headers])

  useEffect(() => {
    if (!activeId) return
    void beat(null)
    const timer = window.setInterval(() => { void beat(focusedBlockRef.current) }, PRESENCE_HEARTBEAT_MS)
    return () => {
      window.clearInterval(timer)
      void beat(null, true)
    }
  }, [activeId, beat])

  // ── 저장 손잡이 ───────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return
      event.preventDefault()
      void queueRef.current?.flush()
      onToast('저장했습니다.')
    }
    const onHide = () => { if (document.visibilityState === 'hidden') queueRef.current?.flushBeacon() }
    window.addEventListener('keydown', onKey)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('visibilitychange', onHide)
    }
  }, [onToast])

  // ── 문서 만들기·보관 ──────────────────────────────────────────────────────
  const createDocument = async (templateId?: string) => {
    setBusy(true)
    try {
      const response = await fetch('/api/wiki', {
        method: 'POST', headers,
        body: JSON.stringify({ clientRequestId: `WNEW-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, ...(templateId ? { templateId } : {}) }),
      })
      const body = await readJson<{ document: WikiDocument }>(response)
      if (!response.ok) throw new Error(body.error?.message || '문서를 만들지 못했습니다.')
      await loadList(true)
      setArchivedMode(false)
      setActiveId(body.document.id)
      setReadMode(false)
      onToast('새 문서를 만들었습니다.')
    } catch (cause) {
      onToast(cause instanceof Error ? cause.message : '문서를 만들지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  /**
   * 메타데이터 수정. **본문 편집을 먼저 올린다** — PATCH는 버전이 정확히 맞아야 통과하는데,
   * 큐에 남은 조각이 나중에 들어가면 그 버전이 어긋나 다음 PATCH가 통째로 튕긴다.
   */
  const patchDocument = async (patch: Record<string, unknown>, done?: string) => {
    if (!activeId) return
    setBusy(true)
    try {
      await queueRef.current?.flush()
      const version = queueRef.current?.baseVersion() ?? Number(detail?.document.version ?? 1)
      const response = await fetch(`/api/wiki/${encodeURIComponent(activeId)}`, { method: 'PATCH', headers, body: JSON.stringify({ ...patch, version }) })
      const body = await readJson<{ document: WikiDocument; movedIds?: string[] }>(response)
      if (!response.ok) throw new Error(body.error?.message || '문서를 고치지 못했습니다.')
      setDetail((current) => (current ? { ...current, document: body.document } : current))
      queueRef.current?.setBaseVersion(Number(body.document.version))
      await loadList(true)
      if (body.movedIds?.length) onToast(`하위 문서 ${body.movedIds.length}건도 함께 옮겼습니다.`)
      else if (done) onToast(done)
    } catch (cause) {
      onToast(cause instanceof Error ? cause.message : '문서를 고치지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  const archiveDocument = async (restore: boolean) => {
    if (!activeId) return
    if (restore) { await patchDocument({ archived: false }, '보관을 풀었습니다.'); return }
    setBusy(true)
    try {
      const response = await fetch(`/api/wiki/${encodeURIComponent(activeId)}`, { method: 'DELETE', headers })
      const body = await readJson<{ reparentedIds?: string[] }>(response)
      if (!response.ok) throw new Error(body.error?.message || '문서를 보관하지 못했습니다.')
      onToast(body.reparentedIds?.length
        ? `문서를 보관했습니다. 하위 문서 ${body.reparentedIds.length}건은 상위 문서 없이 목록에 남습니다. 30일 뒤 완전히 지워집니다.`
        : '문서를 보관했습니다. 30일 뒤 완전히 지워집니다.')
      setActiveId(null)
      await loadList(true)
    } catch (cause) {
      onToast(cause instanceof Error ? cause.message : '문서를 보관하지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  // ── 첨부 ──────────────────────────────────────────────────────────────────
  const requestAttach = (kind: 'image' | 'file', afterBlockId: string) => {
    attachTargetRef.current = { kind, afterBlockId }
    fileInputRef.current?.click()
  }

  const onFilesPicked = async (files: FileList | null) => {
    const target = attachTargetRef.current
    attachTargetRef.current = null
    if (!files?.length || !target || !activeId) return
    setBusy(true)
    try {
      const uploaded = await uploadDocumentAttachments([...files], {
        workspaceScope, category: '문서', tags: ['wiki', activeId],
      })
      let anchor = target.afterBlockId
      const made: WikiBlock[] = []
      const ops: WikiOp[] = []
      for (const file of uploaded) {
        const block = clientBlockPayload({ id: newBlockId(), type: target.kind, attachmentId: file.id, text: file.name })
        ops.push(newInsertOp(block, anchor))
        made.push(block)
        anchor = block.id
      }
      const at = blocks.findIndex((block) => block.id === target.afterBlockId)
      const next = [...blocks]
      next.splice(at + 1, 0, ...made)
      applyOps(next, ops)
      await queueRef.current?.flush()
      await loadDocument(activeId, { keepBlocks: true })
    } catch (cause) {
      onToast(cause instanceof Error ? cause.message : '파일을 올리지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  const promoteTask = async (block: WikiBlock) => {
    if (!activeId) return
    setBusy(true)
    try {
      await queueRef.current?.flush()
      const response = await fetch(`/api/wiki/${encodeURIComponent(activeId)}/blocks/${encodeURIComponent(block.id)}/task`, {
        method: 'POST', headers, body: JSON.stringify({}),
      })
      const body = await readJson<{ mode: string }>(response)
      if (!response.ok) throw new Error(body.error?.message || '업무로 만들지 못했습니다.')
      onToast(body.mode === 'queued' ? '업무 제안을 승인 큐에 올렸습니다.' : '업무를 만들고 이 문단에 연결했습니다.')
      await loadDocument(activeId, { keepBlocks: true })
    } catch (cause) {
      onToast(cause instanceof Error ? cause.message : '업무로 만들지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  const openLink = (target: WikiLinkTarget) => {
    if (target.kind === 'doc') { setActiveId(target.id); return }
    if (target.kind === 'task') { onOpenTask(target.id); return }
    onToast(`${target.label}님은 인사·조직에서 확인할 수 있습니다.`)
  }

  const attachmentMap = useMemo(() => new Map((detail?.attachments ?? []).map((row) => [row.id, row])), [detail])
  const others = useMemo(() => presence.filter((entry) => entry.accountId !== currentUserId), [presence, currentUserId])
  const roster = presence
  const canWrite = Boolean(detail?.permissions.canWrite)
  const editable = canWrite && !narrow
  const document0 = detail?.document ?? null

  return (
    <div className="content-page wiki-page">
      <div className="page-header">
        <div>
          <h1>문서</h1>
          <p>회의 기록·절차·기준을 한곳에 모아 함께 고칩니다. 같은 문단을 동시에 고쳐도 밀린 글은 이력에 남습니다.</p>
        </div>
        <div className="page-header-actions">
          {canManage && list?.templates?.length ? (
            <label className="wiki-template-pick">
              <span className="sr-only">템플릿으로 새 문서 만들기</span>
              <select
                value=""
                disabled={busy}
                onChange={(event) => { if (event.target.value) void createDocument(event.target.value) }}
              >
                <option value="">템플릿으로 시작</option>
                {list.templates.map((template) => <option value={template.id} key={template.id}>{template.title}</option>)}
              </select>
            </label>
          ) : null}
          <Button tone="primary" disabled={busy} onClick={() => void createDocument()}>새 문서</Button>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => { void onFilesPicked(event.target.files); event.target.value = '' }}
      />

      <div className="panel wiki-main">
        <WikiTree
          items={list?.documents ?? []}
          activeId={activeId}
          archivedMode={archivedMode}
          changedIds={changedIds}
          query={query}
          onQuery={setQuery}
          onSelect={(id) => { setActiveId(id); setHistoryOpen(false) }}
          onToggleArchived={() => { setArchivedMode((current) => !current); setActiveId(null) }}
          onCreate={() => void createDocument()}
          canCreate={!archivedMode}
          loading={list === null}
        />

        <section className="wiki-body" aria-label="문서 본문">
          {listError && <ErrorState detail={listError} onRetry={() => { void loadList() }} />}
          {projectFilter && (
            <p className="wiki-filter-note">
              한 프로젝트의 문서만 보고 있습니다.
              <Button tone="quiet" size="sm" onClick={() => setProjectFilter(null)}>모든 문서 보기</Button>
            </p>
          )}
          {!activeId && !listError && (
            <p className="wiki-placeholder">왼쪽에서 문서를 고르거나 새 문서를 만들어 주세요.</p>
          )}
          {activeId && detailError && <ErrorState detail={detailError} onRetry={() => { void loadDocument(activeId) }} />}
          {activeId && !detail && !detailError && <Skeleton rows={5} variant="text" />}
          {activeId && document0 && (
            <>
              <div className="wiki-doc-head">
                {detail?.breadcrumb?.length ? (
                  <nav className="wiki-breadcrumb" aria-label="상위 문서">
                    {detail.breadcrumb.map((crumb) => (
                      <button type="button" key={crumb.id} onClick={() => setActiveId(crumb.id)}>{crumb.title || '제목 없는 문서'}</button>
                    ))}
                  </nav>
                ) : null}
                {titleDraft === null ? (
                  <h2>
                    {document0.title || '제목 없는 문서'}
                    {canWrite && (
                      <Button tone="quiet" size="sm" onClick={() => setTitleDraft(document0.title)}><Pencil size={14} /> 제목 고치기</Button>
                    )}
                  </h2>
                ) : (
                  <form
                    className="wiki-title-form"
                    onSubmit={(event) => { event.preventDefault(); void patchDocument({ title: titleDraft }, '제목을 바꿨습니다.'); setTitleDraft(null) }}
                  >
                    <label>
                      <span className="sr-only">문서 제목</span>
                      <input value={titleDraft} maxLength={MAX_TITLE} autoFocus onChange={(event) => setTitleDraft(event.target.value)} />
                    </label>
                    <Button tone="secondary" size="sm" type="submit" disabled={busy}>저장</Button>
                    <Button tone="ghost" size="sm" onClick={() => setTitleDraft(null)}>취소</Button>
                  </form>
                )}
                <div className="wiki-doc-meta">
                  <StatusBadge tone={document0.projectId ? 'info' : 'neutral'}>{document0.projectId ? '프로젝트 멤버만' : '회사 전체'}</StatusBadge>
                  {document0.archivedAt && <StatusBadge tone="warning">보관됨</StatusBadge>}
                  <span>{document0.lastEditedByName ? `${document0.lastEditedByName} · ` : ''}{formatDateTime(document0.lastEditedAt)}</span>
                  <span>버전 {document0.version}</span>
                  <SaveState status={status} savedAt={savedAt} error={statusDetail} />
                  {status === 'error' && (
                    <Button tone="secondary" size="sm" onClick={() => void queueRef.current?.flush()}>다시 저장</Button>
                  )}
                </div>
                {roster.length > 1 && (
                  <p className="wiki-roster">
                    지금 함께 보고 있는 사람: {others.map((entry) => entry.name || '이름 없음').join(', ')}
                  </p>
                )}
                <div className="wiki-doc-actions">
                  {canWrite && !narrow && (
                    <Button tone="quiet" size="sm" onClick={() => setReadMode((current) => !current)}>
                      {readMode ? '편집하기' : '읽기 모드'}
                    </Button>
                  )}
                  <Button tone="quiet" size="sm" onClick={() => { setHistoryFocus(null); setHistoryOpen((current) => !current) }}>
                    <History size={14} /> 이력{detail && detail.revisionCount > 1 ? ` ${detail.revisionCount}` : ''}
                  </Button>
                  <Button tone="quiet" size="sm" onClick={() => onAskLens({ id: document0.id, name: document0.title || '제목 없는 문서', mime: 'text/markdown', context: '문서' })}>
                    <Sparkles size={14} /> AI로 살펴보기
                  </Button>
                  {canManage && !document0.archivedAt && (
                    <Button tone="quiet" size="sm" disabled={busy} onClick={() => void archiveDocument(false)}><Archive size={14} /> 보관</Button>
                  )}
                  {canManage && document0.archivedAt && (
                    <Button tone="quiet" size="sm" disabled={busy} onClick={() => void archiveDocument(true)}><ArchiveRestore size={14} /> 보관 풀기</Button>
                  )}
                  {canWrite && (
                    <Button tone="quiet" size="sm" disabled={busy} onClick={() => void patchDocument({ writeScope: document0.writeScope === 'tenant' ? 'author' : 'tenant' }, '고칠 수 있는 사람을 바꿨습니다.')}>
                      <Send size={14} /> {document0.writeScope === 'tenant' ? '나만 고치게' : '모두 고치게'}
                    </Button>
                  )}
                </div>
                {narrow && <p className="wiki-narrow-note">휴대폰에서는 읽기만 됩니다. 편집은 컴퓨터에서 열어 주세요.</p>}
              </div>

              <WikiEditor
                blocks={blocks}
                editable={editable}
                readMode={readMode || !editable}
                attachments={attachmentMap}
                presence={presence}
                notices={notices}
                currentUserId={currentUserId}
                headers={headers}
                onApply={applyOps}
                onFlushBefore={() => { void queueRef.current?.flush() }}
                onFocusedBlock={(blockId) => {
                  focusedBlockRef.current = blockId
                  if (blockId) { void beat(blockId); return }
                  // 문단에서 캐럿이 빠지면 그 자리에서 보낸다(설계 §6-4.4의 네 flush 시점 중 하나).
                  // 700ms 디바운스만 믿으면, 마지막 글자를 치고 곧바로 다른 화면으로 넘어간 사람의
                  // 편집이 타이머가 울리기 전에 큐째 사라진다.
                  void queueRef.current?.flush()
                }}
                onComposing={(composing) => { composingRef.current = composing }}
                onPromoteTask={(block) => void promoteTask(block)}
                onOpenTask={onOpenTask}
                onOpenLink={openLink}
                onOpenNotice={(version) => { setHistoryFocus(version); setHistoryOpen(true) }}
                onAttach={requestAttach}
              />
            </>
          )}
        </section>

        <aside className="wiki-rail" aria-label="문서 보조">
          {detail && <WikiOutline entries={detail.toc} activeId={null} onJump={(blockId) => {
            window.setTimeout(() => {
              const box = window.document.querySelector<HTMLElement>(`[data-wiki-block="${blockId}"]`)
              box?.scrollIntoView({ block: 'center' })
              box?.focus()
            }, 0)
          }} />}
          {currentUserName && <p className="sr-only">{currentUserName}님으로 보고 있습니다.</p>}
        </aside>
      </div>

      {historyOpen && activeId && document0 && (
        <WikiRevisions
          documentId={activeId}
          currentVersion={Number(document0.version)}
          canWrite={canWrite}
          headers={headers}
          focusVersion={historyFocus}
          onClose={() => setHistoryOpen(false)}
          onRestored={() => { void loadDocument(activeId); void loadList(true) }}
          onToast={onToast}
        />
      )}
    </div>
  )
}

export default WikiPage

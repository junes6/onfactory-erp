import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { FolderUp, RefreshCw, X } from 'lucide-react'

import { Button, IconButton } from './ui/Button'
import './BulkImport.css'
import {
  ABANDONED_MESSAGE, AI_POLICY_LABELS, AI_POLICY_ORDER, ENTRY_LIMIT_CODE, ENTRY_SETTLED_CODE, MAPPING_FULL_MESSAGE, MAX_BULK_FILE_LABEL,
  MAX_CONSECUTIVE_FAILURES, MAX_MAPPING_ROWS, NO_SUBTLE_MESSAGE, PLAN_MISSING_MESSAGE, PROGRESS_BATCH, PROGRESS_INTERVAL_MS,
  REPICK_MESSAGE, UNFINISHED_MESSAGE, UNMAPPED_MESSAGE, UNREADABLE_MESSAGE,
  appendUncoveredRows, childFolders, collectDroppedFiles, collectFiles, countByMapping, detectFolders, folderDepth, humanBytes, manifestPages,
  newRowId, remainingLabel, sha256File, splitSendable, splitTags, subtleAvailable, totalBytes, withRowIds,
  type BulkAiLevel, type BulkFile, type EntryStatus, type MappingRow, type ProgressResult,
} from '../utils/bulkImport'

/**
 * 폴더 통째로 올리기 — 한 스크롤 안의 네 단계.
 *
 * 마법사가 아니라 한 스크롤인 이유: 뒤 단계로 가도 앞 단계의 결과(몇 개를 골랐고 몇 개가 중복인지)를
 * 계속 보여 줘야 사람이 매핑을 판단할 수 있다. 뒤로 가기가 있는 마법사는 그 사실을 숨긴다.
 *
 * **롤백하지 않는다.** utils/documentAttachments의 업로드는 한 건 실패 시 전량을 DELETE로 되돌리는데,
 * 200개짜리 이관에서 그 동작은 재앙이다(190개 성공 뒤 하나 실패하면 190개를 지운다).
 * 벌크는 부분 성공이 정상이고, 실패는 보고서에 남아 다시 시도된다.
 */

type Phase = 'pick' | 'scan' | 'map' | 'upload' | 'report'
type SessionView = { id: string; name: string; status: string; totals: { files: number; bytes: number; uploaded: number; skippedDuplicate: number; failed: number }; mapping: MappingRow[]; chunks: number }
type ReportView = {
  files: number; uploaded: number; skippedDuplicate: number; failed: number; bytes: number; pending: number
  failures: Array<{ path: string; name: string; error: string }>
  failuresTruncated: boolean
  folders: Array<{ folderPrefix: string; projectId: string | null; aiLevel: BulkAiLevel; files: number; uploaded: number; skippedDuplicate: number; failed: number }>
}
type ProjectOption = { id: string; name: string; role: string | null }
type RuleView = { id: string; name: string; mapping: MappingRow[] }
type PlannedEntry = { path: string; name: string; size: number; sha256: string; status: EntryStatus; resumeDocumentId?: string | null }

const STEPS = ['고르기', '확인', '매핑', '올리기']
/**
 * 세션 id를 sessionStorage에 두지 않는 이유: 재개의 진실은 서버 목록(GET /api/bulk-imports)이고,
 * 자료실의 '지난 이관' 줄이 그 목록으로 문을 연다. 읽는 곳 없는 저장은 '복구 경로가 있다'는 인상만 남긴다.
 */

const errorMessage = (body: unknown, fallback: string) => {
  const message = (body as { error?: { message?: string } } | null)?.error?.message
  return message && typeof message === 'string' ? message : fallback
}
const errorCode = (body: unknown) => String((body as { error?: { code?: string } } | null)?.error?.code ?? '')
/**
 * 범위를 넓혔다는 사실은 두 화면(확인·보고서)에 뜬다 — 문장은 한 곳에서만 쓴다.
 * 넓히면 그 프로젝트에 초대된 외부 게스트도 함께 본다: 절반만 말하면 사람이 모르는 채로 승인한다.
 */
const widenedSentence = (count: number) => `이미 있는 자료 ${count}건은 다시 올리지 않고, 대상 프로젝트 구성원(초대된 외부 게스트 포함)이 열람할 수 있도록 범위를 넓혔습니다.`
/** 매핑이 마지막 판정 이후 바뀌었는가를 보는 서명. 중복 판정에 실제로 쓰이는 두 칸만 담는다. */
const mappingSignature = (rows: MappingRow[]) => rows
  .map((row) => JSON.stringify([row.folderPrefix, row.projectId ?? '']))
  .sort()
  .join('|')

function useDrawer(onClose: () => void) {
  const ref = useRef<HTMLElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const selector = 'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
    const focusables = () => Array.from(dialog.querySelectorAll<HTMLElement>(selector))
    window.setTimeout(() => dialog.querySelector<HTMLElement>('[autofocus]')?.focus() ?? focusables()[0]?.focus(), 0)
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return }
      if (event.key !== 'Tab') return
      const items = focusables()
      if (!items.length) return
      const first = items[0]
      const last = items.at(-1)!
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    dialog.addEventListener('keydown', keydown)
    return () => { dialog.removeEventListener('keydown', keydown); previous?.focus() }
  }, [])
  return ref
}

export function BulkImportDialog({ workspaceScope, canChooseLibrary, resumeSessionId, onClose, onFinished, onToast }: {
  workspaceScope?: string
  /** 관리자만 '자료실(프로젝트 없음)'을 고를 수 있다. 서버가 다시 판정하지만 화면이 먼저 알려 준다. */
  canChooseLibrary: boolean
  resumeSessionId?: string | null
  onClose: () => void
  onFinished: () => Promise<void> | void
  onToast: (message: string) => void
}) {
  const folderInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [phase, setPhase] = useState<Phase>('pick')
  const [files, setFiles] = useState<BulkFile[]>([])
  /** 고르긴 했으나 보내지 않는 파일과 그 이유(10MB 초과·경로 400자 초과). 화면 어디에도 없는 파일을 만들지 않는다. */
  const [notSent, setNotSent] = useState<Array<BulkFile & { reason: string }>>([])
  const [mapping, setMapping] = useState<MappingRow[]>([])
  const [tagDrafts, setTagDrafts] = useState<Record<string, string>>({})
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [rules, setRules] = useState<RuleView[]>([])
  const [ruleName, setRuleName] = useState('')
  const [session, setSession] = useState<SessionView | null>(null)
  const [planned, setPlanned] = useState<PlannedEntry[]>([])
  const [scanned, setScanned] = useState(0)
  const [uploaded, setUploaded] = useState(0)
  const [skipped, setSkipped] = useState(0)
  const [failed, setFailed] = useState(0)
  const [current, setCurrent] = useState('')
  const [recent, setRecent] = useState<number[]>([])
  const [paused, setPaused] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [problem, setProblem] = useState('')
  const [report, setReport] = useState<ReportView | null>(null)
  /**
   * 되돌릴 수 없는 거절(세션 엔트리 상한)을 만난 상태. 그때는 이 세션으로 무엇을 다시 보내도 같은 답이라
   * 문제 문장 옆에 **화면 안에서 할 수 있는 일**을 함께 그린다 — 드로어를 닫았다 여는 방법을
   * 사람이 스스로 알아내게 두지 않는다.
   */
  const [deadEnd, setDeadEnd] = useState(false)
  const [missing, setMissing] = useState<string[]>([])
  /** 이번에 실제로 올릴 대상의 수(아직 안 끝난 엔트리). '몇 개를 찾았습니다'는 이 수에서 뺀다. */
  const [queueSize, setQueueSize] = useState(0)
  /** 이번 폴더에서 이미 끝난(올라갔거나 건너뛴) 파일 수. 재개 화면이 '몇 개를 건너뛰는지' 말할 근거다. */
  const [settled, setSettled] = useState(0)
  /** 중복이라 새로 올리지 않는 대신 **기존 자료의 열람 범위를 넓힌** 건수. 조용히 바꾸지 않는다. */
  const [widened, setWidened] = useState(0)
  /**
   * 수준을 올린 폴더. 보고서의 aiLevel은 '이 이관이 어떤 수준으로 넣었나'라서 올린 뒤에도 그대로다 —
   * 그 자리에 버튼을 계속 두면 다시 눌렀을 때 '0건'이 돌아오고, 사람은 그것을 실패로 읽는다.
   */
  const [raisedFolders, setRaisedFolders] = useState<Record<string, boolean>>({})

  // 멈춤·취소·세션은 실행 중인 루프가 곧바로 읽어야 한다. 상태만으로는 다음 렌더까지 옛 값을 본다.
  const pausedRef = useRef(false)
  const cancelledRef = useRef(false)
  const sessionRef = useRef<SessionView | null>(null)
  const rememberSession = (next: SessionView | null) => { sessionRef.current = next; setSession(next) }
  /**
   * 올릴 목록의 진실. **매니페스트 판정을 그대로 두고 다시 걸으면 이미 올린 파일을 또 보낸다** —
   * 서버는 그것을 409로 거절하고, 클라이언트가 그 409를 실패로 세면 세 번 만에 스스로 멈춰
   * 다시는 재개하지 못한다. 그래서 한 건이 끝날 때마다 이 배열을 갈아 끼운다.
   */
  const plannedRef = useRef<PlannedEntry[]>([])
  const rememberPlanned = (next: PlannedEntry[]) => { plannedRef.current = next; setPlanned(next) }
  /**
   * 마지막 판정에 **서버가 쓴 매핑**의 서명. 첫 매니페스트는 언제나 자동 감지 매핑(대상 프로젝트 없음)으로
   * 가고, 사람이 표에서 프로젝트를 고르는 것은 그 뒤다 — 그 뒤에 다시 판정하지 않으면 '이미 있는 자료의
   * 열람 범위를 넓혔습니다'는 관리자의 정상 흐름에서 한 번도 일어나지 않는다(직원은 403 때문에 우연히 동작한다).
   */
  const judgedMappingRef = useRef('')
  /** 이번 실행에서 성공적으로 끝난 경로. 실패는 넣지 않는다 — '실패한 파일부터 다시 시도'가 사실이어야 한다. */
  const settledRef = useRef(new Set<string>())
  /**
   * 이 화면을 닫는 문은 넷(Esc · 배경 클릭 · 머리말 X · 바닥의 '취소')이고 **한 handler를 함께 쓴다**.
   * 각자 닫으면 Esc로 닫은 화면 뒤에서 1.4GB를 계속 해싱하거나(확인 단계), 업로드 루프가 끝까지 굴러
   * 이관이 저 혼자 마감된다(올리는 중) — 바닥 버튼의 주석이 약속한 것과 반대되는 일이다.
   * 확인은 그 자리에서 끝내고, 올리는 중이면 **일시 중지**로 세운다: 닫았다는 이유로 종료시키면
   * 재개할 길이 사라진다.
   */
  const closeDrawer = () => {
    if (phase === 'scan') cancelledRef.current = true
    if (phase === 'upload') { pausedRef.current = true; setPaused(true) }
    onClose()
  }
  const dialogRef = useDrawer(closeDrawer)
  /** 한 건의 결과를 목록에 반영한다. 루프는 ref를, 화면은 state를 본다. */
  const settle = (path: string, status: EntryStatus) => {
    if (status === 'uploaded' || status === 'duplicate') settledRef.current.add(path)
    rememberPlanned(plannedRef.current.map((entry) => (entry.path === path ? { ...entry, status } : entry)))
  }

  /** 모든 네트워크 호출이 지나는 한 곳. **여기서 던지지 않는다** — 버튼이 영원히 잠기지 않게. */
  const call = useCallback(async (method: string, route: string, body?: unknown) => {
    try {
      const response = await fetch(route, {
        method,
        headers: { 'content-type': 'application/json', ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      let parsed: unknown = null
      try { parsed = await response.json() } catch { parsed = null }
      return { ok: response.ok, status: response.status, body: parsed as Record<string, unknown> | null }
    } catch {
      return { ok: false, status: 0, body: null as Record<string, unknown> | null }
    }
  }, [workspaceScope])

  // 프로젝트 목록과 저장한 매핑은 드로어가 스스로 읽는다 — 자료실 화면이 알 필요가 없는 값이다.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const projectResult = await call('GET', '/api/projects')
      if (cancelled) return
      const list = (projectResult.body?.projects ?? []) as Array<{ id: string; name: string; role?: string | null }>
      setProjects(list.map((project) => ({ id: project.id, name: project.name, role: project.role ?? null })))
      const ruleResult = await call('GET', '/api/bulk-import-rules')
      if (cancelled) return
      setRules((ruleResult.body?.rules ?? []) as RuleView[])
    }
    void load()
    return () => { cancelled = true }
  }, [call])

  // 탭을 닫았다 다시 연 경우. 매니페스트는 서버에 있고 브라우저는 파일 핸들만 잃었다.
  useEffect(() => {
    if (!resumeSessionId) return
    let cancelled = false
    const load = async () => {
      const result = await call('GET', `/api/bulk-imports/${encodeURIComponent(resumeSessionId)}`)
      if (cancelled || !result.ok) return
      const loaded = result.body?.session as SessionView | undefined
      if (!loaded) return
      rememberSession(loaded)
      // 서버가 돌려준 행에는 화면용 키가 없다 — 표를 그리기 전에 채운다.
      setMapping(withRowIds(loaded.mapping ?? []))
      // 끝난 이관은 보고서를 다시 펼친다. '보고서 열기'가 빈 화면을 여는 것이 이 화면의 가장 쉬운 거짓말이다.
      if (loaded.status === 'done' || loaded.status === 'failed') {
        setReport(result.body?.report as ReportView)
        setUploaded(loaded.totals?.uploaded ?? 0)
        setSkipped(loaded.totals?.skippedDuplicate ?? 0)
        setFailed(loaded.totals?.failed ?? 0)
        setPhase('report')
        return
      }
      setNotice(REPICK_MESSAGE)
    }
    void load()
    return () => { cancelled = true }
  }, [call, resumeSessionId])

  const depth = useMemo(() => folderDepth(files), [files])
  /** 미리보기의 파일 수. 서버와 같은 규칙(가장 긴 접두가 이긴다)으로 세어 표의 합이 고른 수와 맞는다. */
  const mappingCounts = useMemo(() => countByMapping(files, mapping), [files, mapping])
  /**
   * 행마다 '나눌 수 있는 하위 폴더'. 이미 행이 있는 폴더는 빼 둔다 — 같은 접두를 두 번 만들면
   * 서버 normalizeMapping이 표 전체를 400으로 거절한다.
   */
  const splitOptions = useMemo(
    () => mapping.map((row) => childFolders(files, row.folderPrefix).filter((child) => !mapping.some((other) => other.folderPrefix === child.folderPrefix))),
    [files, mapping],
  )
  const projectNames = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects])
  const writableProjects = useMemo(() => projects.filter((project) => project.role === 'owner' || project.role === 'editor'), [projects])

  /** 이번에 올릴 대상과 그중 이 폴더에 없는 것. 두 숫자는 **같은 목록**에서 나와야 합이 맞는다. */
  const noteQueue = (queue: PlannedEntry[], list: BulkFile[]) => {
    const byPath = new Set(list.map((item) => item.path))
    setQueueSize(queue.length)
    setMissing(queue.filter((entry) => !byPath.has(entry.path)).map((entry) => entry.path))
  }

  const acceptFiles = (picked: BulkFile[]) => {
    /**
     * 실행 중에는 목록을 갈지 않는다. rememberPlanned([])는 진행 중인 루프가 숫자를 세는 근거를
     * 비우는 일이라, 화면은 '0개'에서 멈춘 채 파일은 계속 올라가고, 그 뒤 '이어서 올리기'는
     * 빈 목록을 걸은 뒤 마감을 불러 **시도조차 하지 않은 파일들을 실패로 닫는다**.
     */
    if (busy || phase === 'scan' || phase === 'upload') return
    // 끝난 이관 위에 새 폴더를 고르면 새 이관이다 — 끝난 세션에 매니페스트를 보내면 409만 돌아온다.
    if (phase === 'report') startOver()
    const { sendable: withinLimit, notSent: skipped } = splitSendable(picked)
    setFiles(withinLimit)
    setNotSent(skipped)
    setProblem('')
    // 안내 문장도 함께 지운다 — '같은 폴더를 다시 선택해 주세요'가 그렇게 한 뒤에도 남아 있으면
    // 화면이 이미 한 일을 계속 시키는 셈이 된다.
    setNotice('')
    rememberPlanned([])
    judgedMappingRef.current = ''
    settledRef.current = new Set()
    setScanned(0)
    setMissing([])
    setQueueSize(0)
    setWidened(0)
    if (!sessionRef.current) {
      const folders = detectFolders(withinLimit)
      setMapping(withRowIds(folders.map((folder) => ({ folderPrefix: folder, projectId: null, tags: [], aiLevel: 'locked' as BulkAiLevel }))))
      setTagDrafts({})
    } else {
      // 세션이 있으면 매핑을 통째로 갈지 않는다 — 이미 올라간 파일의 판정 근거다.
      // 다만 새로 고른 파일 중 어느 행에도 걸리지 않는 것이 있으면 고칠 자리를 만들어 준다.
      setMapping((previous) => appendUncoveredRows(previous, withinLimit))
    }
    if (!subtleAvailable()) setNotice(NO_SUBTLE_MESSAGE)
  }

  const onDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    // 실행 중에는 폴더를 훑지도 않는다 — 버튼과 드롭 영역이 **같은 방식으로** 거절해야 한다.
    if (busy || phase === 'scan' || phase === 'upload') return
    try { acceptFiles(await collectDroppedFiles(event.dataTransfer.items)) }
    catch { setProblem('끌어놓은 폴더를 읽지 못했습니다. 폴더 선택 버튼을 사용해 주세요.') }
  }

  // React 타입에는 webkitdirectory가 없다. JSX 속성으로 적으면 타입 오류이거나 조용히 무시된다 — ref로 켠다.
  useEffect(() => {
    const input = folderInputRef.current
    if (input) input.setAttribute('webkitdirectory', '')
  }, [])

  /**
   * 세션을 만든다. 직원이 대상 프로젝트를 고르지 않은 채 시작하면 서버가 403을 내는데,
   * 그때는 **서버의 문장 그대로** 보여 주고 매핑 표로 데려간다. 화면이 규칙을 다시 쓰지 않는다.
   */
  const ensureSession = async (rows: MappingRow[]): Promise<SessionView | null> => {
    if (sessionRef.current) return sessionRef.current
    const name = `Flow 이관 ${new Date().toISOString().slice(0, 10)}`
    const created = await call('POST', '/api/bulk-imports', { name, mapping: rows })
    if (!created.ok) {
      setProblem(errorMessage(created.body, '이관을 시작하지 못했습니다.'))
      setPhase('map')
      return null
    }
    const next = created.body?.session as SessionView
    rememberSession(next)
    return next
  }

  /**
   * 재개할 때 서버에서 두 가지를 되찾는다.
   * (1) marks — 이미 저장된 문서가 있는 pending 엔트리(파일은 올라갔는데 상태 기록 전에 브라우저가 죽은 창).
   * (2) pending — **아직 안 올린 엔트리 전부**. 이번 매니페스트 판정만으로 큐를 만들면 다시 고르지 않은
   *     파일이 목록에 아예 없어서, 화면은 '나머지 M개는 이 폴더에 없습니다'를 말할 수 없고 그 파일들은
   *     아무 말 없이 마감까지 끌려간다. 큐에 담아 두면 그 자리에서 이유가 적힌다.
   */
  const loadResumeState = async (active: SessionView) => {
    const marks = new Map<string, string>()
    const pending = new Map<string, PlannedEntry>()
    for (let chunk = 0; chunk < Math.max(1, active.chunks); chunk += 1) {
      let cursor: number | null = 0
      for (let guard = 0; guard < 60 && cursor !== null; guard += 1) {
        const page: { ok: boolean; body: Record<string, unknown> | null } = await call('GET', `/api/bulk-imports/${active.id}?chunk=${chunk}&cursor=${cursor}`)
        if (!page.ok) return { marks, pending }
        for (const entry of ((page.body?.chunk as { entries?: PlannedEntry[] } | undefined)?.entries ?? [])) {
          if (entry.resumeDocumentId) marks.set(entry.path, entry.resumeDocumentId)
          if (entry.status === 'pending') {
            pending.set(entry.path, {
              path: entry.path, name: entry.name, size: entry.size, sha256: entry.sha256, status: 'pending',
              ...(entry.resumeDocumentId ? { resumeDocumentId: entry.resumeDocumentId } : {}),
            })
          }
        }
        cursor = (page.body?.nextCursor as number | null) ?? null
      }
    }
    return { marks, pending }
  }

  /**
   * 매니페스트 한 벌을 보내고 판정을 목록에 받아 적는다. 두 곳이 부른다 —
   * 지문을 새로 만든 '파일 확인'과, **매핑이 바뀐 뒤의 다시 판정**(그때는 지문을 다시 만들지 않는다:
   * 같은 파일을 1.4GB어치 다시 읽는 일이라 화면이 멈춘 것처럼 보인다).
   */
  const submitManifest = async (active: SessionView, entries: Array<{ path: string; name: string; size: number; sha256: string }>, { resuming, list }: { resuming: boolean; list: BulkFile[] }) => {
    const verdicts: PlannedEntry[] = []
    let accessWidened = 0
    for (const [pageIndex, page] of manifestPages(entries).entries()) {
      if (cancelledRef.current) return false
      const result = await call('POST', `/api/bulk-imports/${active.id}/manifest`, {
        clientRequestId: `${active.id}-p${pageIndex}-${entries.length}`, pageIndex, entries: page,
      })
      if (!result.ok) {
        // 서버는 몇 번째 항목이 문제인지 알려 준다. 그 경로를 함께 적지 않으면 '폴더를 다시 선택해
        // 주세요'가 시키는 대로 해도 결과가 같고, 사람은 어느 파일 때문인지 끝내 알 수 없다.
        const index = Number((result.body as { error?: { index?: number } } | null)?.error?.index)
        const culprit = Number.isSafeInteger(index) ? page[index]?.path : ''
        setProblem([errorMessage(result.body, '파일 목록을 서버가 받지 못했습니다. 폴더를 다시 선택해 주세요.'), culprit ? `(${culprit})` : ''].filter(Boolean).join(' '))
        // 이 세션으로는 무엇을 다시 보내도 같은 답이다 — 나가는 문을 함께 그린다.
        if (errorCode(result.body) === ENTRY_LIMIT_CODE) setDeadEnd(true)
        setPhase('map')
        return false
      }
      accessWidened += Number(result.body?.accessWidened ?? 0)
      for (const verdict of (result.body?.verdicts ?? []) as PlannedEntry[]) verdicts.push(verdict)
    }
    /**
     * 더한다, 갈아 끼우지 않는다. grantDocumentAccess는 멱등이라 **정말 바뀐 행만** 센다 —
     * 두 번째 판정은 0을 돌려주고, 그때 덮어써 버리면 방금 사람에게 알린 범위 변경의 기록이
     * 같은 화면에서 사라진다. 세션이 바뀔 때(새 폴더·처음부터·실패분 재시도)만 0으로 되돌린다.
     */
    setWidened((previous) => previous + accessWidened)
    // 재개: 이미 저장된 문서가 있는 pending 엔트리를 서버에서 되찾아 업로드를 건너뛴다(크래시 창).
    const resumed = resuming ? await loadResumeState(active) : { marks: new Map<string, string>(), pending: new Map<string, PlannedEntry>() }
    const previous = new Map(plannedRef.current.map((entry) => [entry.path, entry]))
    const judged = new Set(verdicts.map((entry) => entry.path))
    const next = [
      ...verdicts.map((entry) => {
        const mark = resumed.marks.get(entry.path) ?? previous.get(entry.path)?.resumeDocumentId ?? null
        return mark ? { ...entry, resumeDocumentId: mark } : entry
      }),
      // 다시 고르지 않은 파일도 목록에 있어야 화면이 그 수를 말하고 보고서가 이유를 적는다.
      ...[...resumed.pending.values()].filter((entry) => !judged.has(entry.path)),
    ]
    settledRef.current = new Set(next.filter((entry) => entry.status === 'uploaded' || entry.status === 'duplicate').map((entry) => entry.path))
    rememberPlanned(next)
    // 판정에 실제로 쓰인 매핑은 **서버가 가진 것**이다 — 화면의 표가 아니라 그 값으로 서명을 남긴다.
    judgedMappingRef.current = mappingSignature(sessionRef.current?.mapping ?? active.mapping ?? [])
    setUploaded(next.filter((entry) => entry.status === 'uploaded').length)
    setSkipped(next.filter((entry) => entry.status === 'duplicate').length)
    setFailed(next.filter((entry) => entry.status === 'failed').length)
    setSettled(settledRef.current.size)
    // 재개 문장은 **올릴 대상**에서 센다. 세션 전체에서 세면 이미 끝난 파일까지 '찾았습니다'가 된다.
    noteQueue(next.filter((entry) => !settledRef.current.has(entry.path)), list)
    return true
  }

  /** 2단계 — 파일 지문을 만들고 매니페스트를 나눠 보낸다. 여기서 취소해도 올라간 파일은 하나도 없다. */
  const scanFiles = async (list: BulkFile[], rows: MappingRow[]) => {
    if (!list.length) { setProblem('먼저 폴더를 선택해 주세요.'); return }
    setBusy(true)
    setProblem('')
    setScanned(0)
    const resuming = Boolean(sessionRef.current)
    // 확인 단계에서 드로어를 닫으면 여기서 멈춘다 — 닫힌 화면 뒤에서 1.4GB를 계속 해싱하지 않는다.
    cancelledRef.current = false
    try {
      const active = await ensureSession(rows)
      if (!active) return
      setPhase('scan')
      const fingerprinted = subtleAvailable()
      const entries: Array<{ path: string; name: string; size: number; sha256: string }> = []
      let unreadable = 0
      for (const [index, item] of list.entries()) {
        /**
         * 지문을 만들 수 없는 주소에서는 빈 지문으로 보내고 서버 백스톱(dedupe=1)으로 간다.
         * arrayBuffer()는 고른 뒤 파일이 옮겨지거나 이름이 바뀌면 거절한다 — 1.4GB짜리 네트워크
         * 폴더에서는 흔한 일이다. 잡지 않으면 처리되지 않은 거절로 새어 나가 화면이 그 자리에 멈춘다.
         */
        if (cancelledRef.current) return
        let sha256 = ''
        if (fingerprinted) {
          try { sha256 = await sha256File(item.file) } catch { unreadable += 1 }
        }
        entries.push({ path: item.path, name: item.name, size: item.size, sha256 })
        setScanned(index + 1)
      }
      if (unreadable > 0) setNotice(UNREADABLE_MESSAGE)
      // 지문이 없어도 매니페스트는 보낸다 — 매핑·재개·보고서는 세션 엔트리가 있어야 성립한다.
      // 서버는 빈 지문을 받아들이고, 중복은 업로드 시점의 dedupe=1이 대신 잡는다.
      if (!await submitManifest(active, entries, { resuming, list })) return
      setPhase('map')
    } finally {
      setBusy(false)
    }
  }

  /**
   * 지문을 다시 만들지 않고 **판정만 다시 받는다**. 매니페스트는 아는 경로에 엔트리를 늘리지 않으므로
   * 멱등이고, 서버는 이번 매핑으로 중복을 다시 판정한다(넓힐 수 있으면 넓히고, 그 프로젝트에서
   * 열리지 않는 자료라면 다시 올릴 대상으로 되돌린다).
   */
  const rejudge = async (active: SessionView) => {
    const entries = plannedRef.current.map((entry) => ({ path: entry.path, name: entry.name, size: entry.size, sha256: entry.sha256 }))
    if (!entries.length) return true
    return submitManifest(active, entries, { resuming: false, list: files })
  }

  /** 표에서 행을 가리키는 키. 행이 끼어들어도 그 아래 입력들이 다시 마운트되지 않게 한다. */
  const rowKey = (row: MappingRow, index: number) => row.rowId ?? `map-${index}`

  /**
   * 이 행 아래의 폴더 하나를 **따로 정할 수 있게** 행을 하나 더 만든다.
   *
   * 새 행은 부모의 값을 그대로 물려받는다 — 나누는 것만으로는 어떤 파일의 목적지도 바뀌지 않고
   * (가장 긴 접두가 이기지만 값이 같다), 사람은 그 뒤에 이 행만 다르게 고른다.
   */
  const splitRow = (index: number, folderPrefix: string) => {
    const parent = mapping[index]
    if (!parent || !folderPrefix || mapping.some((row) => row.folderPrefix === folderPrefix)) return
    if (mapping.length >= MAX_MAPPING_ROWS) { setProblem(MAPPING_FULL_MESSAGE); return }
    const next = [...mapping]
    next.splice(index + 1, 0, { rowId: newRowId(), folderPrefix, projectId: parent.projectId, tags: [...parent.tags], aiLevel: parent.aiLevel })
    setMapping(next)
  }

  const saveMapping = async (): Promise<boolean> => {
    const active = sessionRef.current
    if (!active) return false
    const result = await call('PATCH', `/api/bulk-imports/${active.id}`, { mapping })
    if (!result.ok) { setProblem(errorMessage(result.body, '폴더 매핑을 저장하지 못했습니다.')); return false }
    rememberSession(result.body?.session as SessionView)
    return true
  }

  const saveRule = async () => {
    const name = ruleName.trim()
    if (!name) { setProblem('저장할 매핑 이름을 적어 주세요.'); return }
    const result = await call('POST', '/api/bulk-import-rules', { name, mapping })
    if (!result.ok) { setProblem(errorMessage(result.body, '매핑을 저장하지 못했습니다.')); return }
    setRules((result.body?.rules ?? []) as RuleView[])
    setRuleName('')
    onToast(`‘${name}’ 매핑을 저장했습니다.`)
  }

  /**
   * 마감 한 번. 업로드 루프의 꼬리와 '이관 중단' 버튼이 **같은 함수**를 쓴다 — 두 곳이 각자 마감하면
   * 한쪽만 고쳐질 때 버튼이 아무것도 끝내지 못한다(일시 중지 뒤의 '이관 중단'이 실제로 그랬다).
   */
  const finishImport = async (active: SessionView) => {
    const finished = await call('POST', `/api/bulk-imports/${active.id}/finish`)
    if (!finished.ok) {
      setProblem(errorMessage(finished.body, '이관을 마감하지 못했습니다. 진행 상황은 서버에 남아 있습니다.'))
      return false
    }
    rememberSession(finished.body?.session as SessionView)
    setReport(finished.body?.report as ReportView)
    // 끝난 이관에는 '이어서 올리기'가 없다 — 멈춤 표시를 남겨 두면 보고서 위에 그 버튼이 다시 뜬다.
    setPaused(false)
    pausedRef.current = false
    setCurrent('')
    setPhase('report')
    await onFinished()
    return true
  }

  /**
   * '이관 중단'을 **일시 중지 뒤에** 눌렀을 때. 그때는 표시를 읽어 줄 루프가 없어서, 표시만 세우면
   * 아무 일도 일어나지 않는다 — 확인 문장('다시 이어서 올릴 수 없습니다')이 거짓이 되고 세션은
   * paused로 남아 자료실 목록에 '이어서 올리기'로 되살아난다. 여기서 직접 마감으로 데려간다.
   */
  const abortImport = async () => {
    const active = sessionRef.current
    if (!active) return
    setBusy(true)
    try { await finishImport(active) } finally { setBusy(false) }
  }

  /** 4단계 — **동시성 1, 순차**. 서버가 파일 전체를 힙 Buffer로 받으므로 벌크가 서버를 밀어내면 안 된다. */
  const runUpload = async () => {
    /**
     * 표에서 고른 값을 **다시 훑기 전에** 저장한다. 매니페스트의 판정(중복이면 기존 자료의 열람 범위를
     * 넓히는 일까지)은 서버가 가진 매핑으로 하는데, 그 저장이 나중이면 서버는 사람이 방금 고른
     * 대상 프로젝트를 모른 채 판정한다 — 화면과 서버가 다른 표를 보고 있는 창이다.
     */
    if (sessionRef.current && !await saveMapping()) return
    /**
     * 여기서 스스로 다시 훑는 세 갈래.
     * (1) 세션이 없다: 직원이 대상 프로젝트를 고르지 않아 세션 생성이 403이 났을 때다. 그때 화면은
     *     매핑 표로 데려가는데 거기 있는 버튼은 이 함수뿐이라, 되돌려 보내면 사람은 시킨 대로 고치고도
     *     영원히 같은 문장을 본다.
     * (2) 매니페스트 한 페이지가 실패해 목록이 비었다(서버 재시작·순간 끊김) — 그대로 진행하면
     *     아무것도 올리지 않은 채 마감이 불려 서버가 전량을 '실패'로 닫는다.
     * (3) 매핑 표에서 폴더를 더 골랐다 — 그 파일들에는 아직 엔트리가 없어서, 화면은 '2개'라고
     *     적어 두고 하나만 올린다. 다시 훑는 것은 멱등이다(아는 경로는 엔트리를 늘리지 않는다).
     */
    const plannedPaths = new Set(plannedRef.current.map((entry) => entry.path))
    const planIncomplete = files.some((item) => !plannedPaths.has(item.path))
    if (!sessionRef.current || planIncomplete) await scanFiles(files, mapping)
    const active = sessionRef.current
    if (!active) return
    /**
     * (4) 표에서 대상 프로젝트를 고친 뒤다. 첫 판정은 자동 감지 매핑(프로젝트 없음)으로 갔으므로
     *     그대로 두면 '이미 있는 자료의 열람 범위를 넓혔습니다'가 관리자에게는 영영 일어나지 않고,
     *     그 프로젝트에서 열리지 않는 중복은 건너뛴 채로 남는다. 지문은 다시 만들지 않는다.
     */
    if (mappingSignature(active.mapping ?? []) !== judgedMappingRef.current) {
      setBusy(true)
      try { if (!await rejudge(active)) return }
      finally { setBusy(false) }
    }
    // 다시 훑고도 목록이 없으면 여기서 멈춘다. 마감은 되돌릴 수 없는 동작이다(세션이 종료 상태가 된다).
    if (!plannedRef.current.length && files.length > 0) { setProblem((previous) => previous || PLAN_MISSING_MESSAGE); return }
    setBusy(true)
    setProblem('')
    setPaused(false)
    pausedRef.current = false
    cancelledRef.current = false
    try {
      if (!await saveMapping()) return
      const started = await call('PATCH', `/api/bulk-imports/${active.id}`, { status: 'uploading' })
      if (!started.ok) { setProblem(errorMessage(started.body, '이관을 시작하지 못했습니다.')); return }
      setPhase('upload')

      const byPath = new Map(files.map((item) => [item.path, item]))
      /**
       * 이번 실행에서 끝난 것을 뺀다. 매니페스트 판정만 보고 걸으면 일시 중지 뒤 '이어서 올리기'가
       * 이미 올린 파일부터 다시 걷는다. failed는 남긴다 — 화면이 '실패한 파일부터 다시 시도합니다'라고
       * 적어 두었고, 실패한 엔트리에는 문서가 없어 다시 올리는 것이 맞다.
       */
      const queue = plannedRef.current.filter((entry) => (
        (entry.status === 'pending' || entry.status === 'failed') && !settledRef.current.has(entry.path)
      ))
      noteQueue(queue, files)

      let batch: ProgressResult[] = []
      let lastFlush = Date.now()
      let consecutiveFailures = 0
      /**
       * 서버가 **답한** 거절은 연결 문제가 아니다(매핑에 없는 폴더·해시 불일치처럼 다시 보내도 같은 답이다).
       * 두 가지를 한 counter로 세면 화면이 '연결이 불안정해 잠시 멈췄습니다'라고 거짓말을 한다 —
       * 브라우저에서 실제로 그렇게 나왔다. 같은 이유가 연달아 나오면 **그 이유를 그대로** 말하고 멈춘다.
       */
      let consecutiveRefusals = 0
      let lastRefusal = ''
      const clearStreak = () => { consecutiveFailures = 0; consecutiveRefusals = 0; lastRefusal = '' }

      /**
       * 화면의 세 숫자는 목록 하나에서 다시 센다. 각자 누적하면 '실패했다가 다시 시도해 성공한 파일'이
       * 실패와 성공 양쪽에 남아 합이 파일 수를 넘는다 — 서버가 totals를 매번 다시 세는 것과 같은 이유다.
       */
      const record = (path: string, status: EntryStatus, result: ProgressResult | null) => {
        if (result) batch.push(result)
        settle(path, status)
        setUploaded(plannedRef.current.filter((entry) => entry.status === 'uploaded').length)
        setSkipped(plannedRef.current.filter((entry) => entry.status === 'duplicate').length)
        setFailed(plannedRef.current.filter((entry) => entry.status === 'failed').length)
      }

      const flush = async () => {
        if (!batch.length) return
        const results = batch
        batch = []
        lastFlush = Date.now()
        // 보고 실패가 업로드를 멈추지 않는다. 다음 묶음이 같은 사실을 다시 싣고, 진실은 서버가 다시 센다.
        await call('POST', `/api/bulk-imports/${active.id}/progress`, { results })
      }

      for (const entry of queue) {
        if (cancelledRef.current || pausedRef.current) break
        const item = byPath.get(entry.path)
        if (!item) {
          // 재개할 때 다시 고르지 않은 파일. 조용히 두지 않고 실패로 적는다 — 영원히 멈춰 있지 않는다.
          // 문장은 서버 마감 라우트와 **같은 상수**다(한 사실을 두 곳이 각자 쓰지 않는다).
          record(entry.path, 'failed', { path: entry.path, status: 'failed', error: ABANDONED_MESSAGE })
          continue
        }
        if (entry.resumeDocumentId) {
          // 크래시 복구: 파일은 이미 저장돼 있다. 업로드를 건너뛰고 상태만 맞춘다.
          record(entry.path, 'uploaded', { path: entry.path, status: 'uploaded', documentId: entry.resumeDocumentId })
          continue
        }
        setCurrent(entry.path)
        const startedAt = Date.now()
        // 분류·태그·권한·AI 수준은 보내지 않는다 — 서버가 세션 매핑에서 정한다.
        const query = new URLSearchParams({ importId: active.id, sourcePath: entry.path, name: item.name })
        if (!entry.sha256) query.set('dedupe', '1')
        let response: Response | null = null
        let parsed: Record<string, unknown> | null = null
        try {
          response = await fetch(`/api/documents?${query}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/octet-stream',
              'x-file-name': encodeURIComponent(item.name),
              'x-file-type': item.file.type || 'application/octet-stream',
              // 지문 헤더는 보내지 않는다. 서버는 매니페스트에 적힌 해시(bulk.entry.sha256)와 본문을
              // 대조하고 클라이언트가 이번에 주장하는 값은 읽지 않는다 — 읽지 않는 값을 보내면
              // 나중에 누군가 '검사하고 있다'고 믿는다.
              ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}),
            },
            body: item.file,
          })
          try { parsed = await response.json() as Record<string, unknown> } catch { parsed = null }
        } catch {
          response = null
        }
        const code = (parsed as { error?: { code?: string } } | null)?.error?.code
        if (response?.ok && parsed?.duplicateOf) {
          record(entry.path, 'duplicate', { path: entry.path, status: 'duplicate' })
          clearStreak()
        } else if (response?.ok) {
          record(entry.path, 'uploaded', { path: entry.path, status: 'uploaded', documentId: String((parsed?.document as { id?: string } | undefined)?.id ?? '') })
          clearStreak()
        } else if (code === ENTRY_SETTLED_CODE) {
          /**
           * 서버가 '이 파일은 이미 끝났다'고 답한 경우(다른 탭이 먼저 올렸거나 목록이 늦었다).
           * 연결 실패가 아니므로 연속 실패로 세지 않는다 — 세면 세 번 만에 스스로 멈춘다.
           * 진행 보고를 보내지 않는 이유: 서버가 이미 아는 사실이고, 우리가 어느 쪽으로 끝났는지 모른다.
           */
          record(entry.path, 'duplicate', null)
          clearStreak()
        } else {
          const refusal = response ? errorMessage(parsed, '파일을 올리지 못했습니다.') : ''
          record(entry.path, 'failed', { path: entry.path, status: 'failed', error: refusal || '연결이 끊겨 올리지 못했습니다.' })
          if (refusal) {
            consecutiveRefusals = refusal === lastRefusal ? consecutiveRefusals + 1 : 1
            lastRefusal = refusal
            consecutiveFailures = 0
          } else {
            consecutiveFailures += 1
            consecutiveRefusals = 0
          }
        }
        setRecent((previous) => [...previous.slice(-9), Date.now() - startedAt])
        if (batch.length >= PROGRESS_BATCH || Date.now() - lastFlush >= PROGRESS_INTERVAL_MS) await flush()
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          setPaused(true)
          pausedRef.current = true
          setProblem('연결이 불안정해 잠시 멈췄습니다. 이어서 올리기를 누르면 실패한 파일부터 다시 시도합니다.')
          break
        }
        if (consecutiveRefusals >= MAX_CONSECUTIVE_FAILURES) {
          // 서버의 문장을 그대로 싣는다. 화면이 이유를 다시 쓰면 보고서와 다른 말을 하게 된다.
          setPaused(true)
          pausedRef.current = true
          setProblem(`같은 이유로 ${MAX_CONSECUTIVE_FAILURES}건이 연달아 거절되어 멈췄습니다. ${lastRefusal}`)
          break
        }
      }
      await flush()
      setCurrent('')
      /**
       * 멈춤과 중단은 **다른 일**이다. 멈춤은 세션을 paused로 두고 '이어서 올리기'를 남긴다.
       * 중단은 마감으로 간다 — 두 버튼이 같은 결과를 내면 '이관 중단'을 누른 사람이 닫은 줄 알았던
       * 이관이 목록에 '이어서 올리기'로 남고, 다음에 누군가 그것을 이어 올린다.
       */
      if (pausedRef.current && !cancelledRef.current) {
        await call('PATCH', `/api/bulk-imports/${active.id}`, { status: 'paused' })
        setPaused(true)
        return
      }
      if (!plannedRef.current.length && files.length > 0) { setProblem(PLAN_MISSING_MESSAGE); return }
      await finishImport(active)
    } finally {
      setBusy(false)
    }
  }

  const raiseFolder = async (folderPrefix: string) => {
    const active = sessionRef.current
    if (!active) return
    const result = await call('POST', `/api/bulk-imports/${active.id}/ai-level`, { folderPrefix, level: 'indexed' })
    if (!result.ok) { setProblem(errorMessage(result.body, 'AI 처리 수준을 올리지 못했습니다.')); return }
    setRaisedFolders((previous) => ({ ...previous, [folderPrefix]: true }))
    // 올린 것이 0건인 경우는 실패가 아니라 '이미 그 수준'이라는 사실이다. 같은 문장으로 답하면 실패로 읽힌다.
    const updated = Number(result.body?.updated ?? 0)
    onToast(updated > 0
      ? `${folderPrefix || '최상위'} 폴더의 자료 ${updated}건을 ‘정리’ 수준으로 올렸습니다.`
      : `${folderPrefix || '최상위'} 폴더의 자료는 이미 ‘정리’ 이상입니다.`)
    await onFinished()
  }

  /**
   * 실패한 파일만 다시 시도한다. 끝난 세션은 다시 열지 않고(종료 상태에서 나가는 전이는 없다)
   * 실패분만 담은 새 세션을 만든다 — 그래야 보고서가 두 번 덮이지 않고 이력이 남는다.
   */
  /** 끝난 세션을 닫고 처음(고르기)으로 돌아간다. 보고서 화면이 막다른 길이 되지 않게 하는 문이다. */
  const startOver = (message = '') => {
    rememberSession(null)
    settledRef.current = new Set()
    rememberPlanned([])
    judgedMappingRef.current = ''
    setDeadEnd(false)
    setReport(null)
    setFiles([])
    setNotSent([])
    setMapping([])
    setTagDrafts({})
    setUploaded(0)
    setSkipped(0)
    setFailed(0)
    setSettled(0)
    setQueueSize(0)
    setWidened(0)
    setMissing([])
    setRaisedFolders({})
    setPaused(false)
    pausedRef.current = false
    setCurrent('')
    setRecent([])
    setScanned(0)
    setProblem(message)
    setNotice('')
    setPhase('pick')
  }

  const retryFailed = () => {
    if (!report) return
    const failedPaths = new Set(report.failures.map((failure) => failure.path))
    const retryFiles = files.filter((item) => failedPaths.has(item.path))
    // 끝난 세션을 먼저 놓는다. 놓지 않고 돌아가면 다음 매니페스트가 그 세션으로 가서 409가 된다.
    rememberSession(null)
    if (!retryFiles.length) { startOver(REPICK_MESSAGE); return }
    settledRef.current = new Set()
    setFiles(retryFiles)
    setNotSent([])
    rememberPlanned([])
    judgedMappingRef.current = ''
    setReport(null)
    setUploaded(0)
    setSkipped(0)
    setFailed(0)
    setSettled(0)
    setQueueSize(0)
    setWidened(0)
    setMissing([])
    setProblem('')
    void scanFiles(retryFiles, mapping)
  }

  const copyReport = async () => {
    if (!report) return
    const lines = [
      `올린 파일 ${report.uploaded}개 · ${humanBytes(report.bytes)} · 건너뜀 ${report.skippedDuplicate}개 · 실패 ${report.failed}개`,
      ...report.failures.map((failure) => `${failure.path} — ${failure.error}`),
      // 동료에게 붙여 넣는 글에도 '보내지 않은 파일'이 들어가야 목록이 화면과 같아진다.
      ...notSent.map((item) => `${item.path} — ${item.reason}`),
    ]
    try { await navigator.clipboard.writeText(lines.join('\n')); onToast('이관 보고서를 복사했습니다.') }
    catch { onToast('보고서를 복사하지 못했습니다. 화면의 내용을 직접 복사해 주세요.') }
  }

  const total = planned.length || files.length
  const processed = uploaded + skipped + failed
  const stepIndex = phase === 'pick' ? 0 : phase === 'scan' ? 1 : phase === 'map' ? 2 : 3
  const counting = phase === 'scan'
  const counterValue = counting ? scanned : processed
  const counterLabel = counting
    ? `파일 확인 중 ${total}개 중 ${scanned}개`
    : `올리는 중 ${total}개 중 ${processed}개 · 건너뜀 ${skipped} · 실패 ${failed}`

  return <div className="bulk-import-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeDrawer()}>
    <section ref={dialogRef} className="bulk-import-drawer" role="dialog" aria-modal="true" aria-labelledby="bulk-import-title">
      <header>
        <div>
          <span>BULK IMPORT</span>
          <h2 id="bulk-import-title">폴더 통째로 올리기</h2>
          <p>폴더 구조는 프로젝트·태그로 바꾸고, 원본 경로는 그대로 보존합니다.</p>
        </div>
        <IconButton aria-label="닫기" onClick={closeDrawer}><X size={20} /></IconButton>
      </header>

      <ol className="bulk-import-steps" aria-label="이관 단계">
        {STEPS.map((label, index) => <li key={label} {...(index === stepIndex ? { 'aria-current': 'step' as const } : {})}>{label}</li>)}
      </ol>

      {(notice || problem) && <section className="bulk-import-messages">
        {notice && <p className="bulk-import-notice">{notice}</p>}
        {problem && <p className="bulk-import-problem" role="alert">{problem}</p>}
        {/* 되돌릴 수 없는 거절에는 나가는 문을 함께 그린다 — 화면이 시키는 일은 화면 안에서 할 수 있어야 한다. */}
        {deadEnd && <Button tone="secondary" onClick={() => startOver()}>새 폴더 고르기</Button>}
      </section>}

      <section className="bulk-import-picker">
        <div
          className="bulk-import-dropzone"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => { void onDrop(event) }}
        >
          <FolderUp size={26} />
          <div>
            <strong>{files.length ? `${files.length}개 파일 · ${humanBytes(totalBytes(files))} · 폴더 ${depth}단계` : '폴더를 이곳에 끌어놓거나 아래에서 선택하세요'}</strong>
            {/* 상한을 두 이름으로 적지 않는다 — 아래 건너뜀 문장(서버와 같은 상수)이 '10MB'라고 말한다. */}
            <span>한 파일은 {MAX_BULK_FILE_LABEL}까지 올릴 수 있습니다.</span>
          </div>
          {/* 실행 중에는 두 버튼도 거절한다 — 드롭 영역과 같은 규칙이어야 무엇이 막혔는지 알 수 있다. */}
          <Button tone="secondary" disabled={busy} onClick={() => folderInputRef.current?.click()}>폴더 선택</Button>
          <Button tone="ghost" disabled={busy} onClick={() => fileInputRef.current?.click()}>파일 선택</Button>
          {/*
            읽은 뒤 값을 비운다. 비우지 않으면 **같은 폴더를 다시 고를 때 change가 아예 발생하지 않아**
            버튼이 죽은 것처럼 보인다 — '같은 폴더를 다시 선택해 주세요'라고 적어 둔 화면에서 그렇다.
          */}
          <input ref={folderInputRef} className="sr-only" type="file" multiple onChange={(event) => { acceptFiles(collectFiles(event.target.files)); event.target.value = '' }} />
          <input ref={fileInputRef} className="sr-only" type="file" multiple onChange={(event) => { acceptFiles(collectFiles(event.target.files)); event.target.value = '' }} />
        </div>
        {/* 이유는 파일마다 다르다(크기·경로 길이) — 한 줄로 뭉뚱그리면 어느 파일이 왜 빠졌는지 알 수 없다. */}
        {notSent.length > 0 && <details className="bulk-import-oversize">
          <summary>{notSent.length}개는 건너뜁니다</summary>
          <ul>{notSent.map((item) => <li key={item.path}>{item.path} · {humanBytes(item.size)} · {item.reason}</li>)}</ul>
        </details>}
      </section>

      {(phase === 'scan' || phase === 'upload') && <section className="bulk-import-progress">
        <p aria-live="polite">{counterLabel}</p>
        <div className="bulk-import-progress-bar" role="progressbar" aria-label={counting ? '파일 확인 진행률' : '이관 진행률'} aria-valuemin={0} aria-valuemax={total} aria-valuenow={counterValue}>
          <span style={{ inlineSize: `${total ? Math.round((counterValue / total) * 100) : 0}%` }} />
        </div>
        {/* 파일명은 읽어 주지 않는다 — 200줄이 스크린리더로 쏟아진다. 숫자 줄 하나만 polite다. */}
        <p className="bulk-import-current" aria-live="off">{[current ? `현재: ${current}` : '', remainingLabel(recent, total - processed)].filter(Boolean).join(' · ')}</p>
        {/* 이 줄의 두 버튼은 드로어를 닫지 않는다 — 바닥의 '취소'와 이름이 같으면 무엇이 멈추는지 알 수 없다. */}
        {phase === 'upload' && <div>
          <Button tone="ghost" onClick={() => { setPaused(true); pausedRef.current = true }}>일시 중지</Button>
          {/*
            중단은 멈춤이 아니다 — 여기서 세운 이관은 마감으로 가고 보고서가 뜬다(재개 버튼이 남지 않는다).
            되돌릴 수 없으므로 한 번 묻는다(자료실의 삭제와 같은 관례). 확인 문장이 말하는 결과는
            서버가 그 파일들에 실제로 새기는 문장 그대로다.
          */}
          <Button tone="ghost" onClick={() => {
            if (!window.confirm(`이관을 중단할까요? 아직 올리지 않은 파일은 실패로 남고 이 이관은 다시 이어서 올릴 수 없습니다. (${UNFINISHED_MESSAGE})`)) return
            cancelledRef.current = true
            // 루프가 돌고 있으면 그 루프가 이 표시를 읽고 마감까지 간다. 멈춰 있을 때는 읽어 줄 루프가
            // 없으므로 여기서 직접 마감한다 — 그러지 않으면 이 버튼은 확인만 묻고 아무 일도 하지 않는다.
            if (!busy) void abortImport()
          }}>이관 중단</Button>
        </div>}
      </section>}

      {/*
        보고서 화면에는 매핑 표를 그리지 않는다. 다시 연 보고서에는 파일 목록이 없어서 모든 행이
        '0개'로 그려지는데, 바로 아래 보고서 표는 같은 폴더에 110개·108개라고 적는다 — 두 표가
        같은 화면에서 다른 말을 한다. 무엇으로 올렸는지는 보고서 표(폴더 · 프로젝트 · AI 수준)가 말한다.
      */}
      {(phase === 'map' || phase === 'upload') && <section className="bulk-import-mapping">
        <p className="bulk-import-hint">매핑은 폴더 접두 기준이고, 가장 깊은 행이 이깁니다. 하위 폴더로 나누면 그 폴더만 다르게 정할 수 있습니다. 그 아래 폴더 구조는 원본 경로로 그대로 남습니다.</p>
        {settled > 0 && <p className="bulk-import-hint">이미 끝난 파일 {settled}개는 건너뜁니다.</p>}
        {/* 두 숫자는 **올릴 대상 하나**에서 나온다 — 세션 전체에서 세면 이미 끝난 파일까지 '찾았습니다'가 된다. */}
        {missing.length > 0 && <p className="bulk-import-hint">선택한 폴더에서 {queueSize - missing.length}개를 찾았습니다. 나머지 {missing.length}개는 이 폴더에 없습니다.</p>}
        {/* 범위를 넓히면 그 프로젝트에 초대된 외부 게스트도 함께 본다 — 화면이 절반만 말하면 안 된다. */}
        {widened > 0 && <p className="bulk-import-hint">{widenedSentence(widened)}</p>}
        <table>
          <thead><tr><th scope="col">폴더</th><th scope="col">파일</th><th scope="col">대상 프로젝트</th><th scope="col">태그</th><th scope="col">AI 처리 수준</th></tr></thead>
          <tbody>
            {mapping.map((row, index) => {
              const count = mappingCounts.counts[index] ?? 0
              const children = splitOptions[index] ?? []
              return <tr key={rowKey(row, index)}>
                <th scope="row">
                  {row.folderPrefix || '(최상위)'}
                  {/* 하위 폴더를 따로 정할 자리. 첫 단계 이름만으로는 계약과 설계를 갈라 놓을 수 없다. */}
                  {children.length > 0 && <label className="bulk-import-split">
                    <span className="sr-only">{row.folderPrefix || '최상위'} 폴더를 하위 폴더로 나누기</span>
                    <select value="" onChange={(event) => splitRow(index, event.target.value)}>
                      <option value="">하위 폴더로 나누기</option>
                      {children.map((child) => <option key={child.folderPrefix} value={child.folderPrefix}>{child.folderPrefix} · {child.files}개</option>)}
                    </select>
                  </label>}
                </th>
                <td>{count}개</td>
                <td>
                  <label>
                    <span className="sr-only">{row.folderPrefix || '최상위'} 폴더의 대상 프로젝트</span>
                    <select
                      value={row.projectId ?? ''}
                      onChange={(event) => {
                        const value = event.target.value
                        setMapping((previous) => previous.map((entry, position) => (position === index ? { ...entry, projectId: value || null } : entry)))
                      }}
                    >
                      <option value="">{canChooseLibrary ? '자료실(프로젝트 없음)' : '프로젝트를 골라 주세요'}</option>
                      {writableProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                    </select>
                  </label>
                </td>
                <td>
                  <label>
                    <span className="sr-only">{row.folderPrefix || '최상위'} 폴더의 태그</span>
                    {/* IME 규칙: onChange는 값을 그대로 담기만 한다. 쉼표 분해는 blur에서 한다. */}
                    <input
                      value={tagDrafts[rowKey(row, index)] ?? row.tags.join(', ')}
                      placeholder="쉼표로 구분"
                      onChange={(event) => {
                        const draft = event.target.value
                        setTagDrafts((previous) => ({ ...previous, [rowKey(row, index)]: draft }))
                      }}
                      onBlur={(event) => {
                        const tags = splitTags(event.target.value)
                        setMapping((previous) => previous.map((entry, position) => (position === index ? { ...entry, tags } : entry)))
                        // 임시 값을 지워 칸이 정규화 결과를 보이게 한다 — 'a, a, '라고 친 사람이
                        // 실제로 보낼 값('a')과 다른 것을 계속 보고 있으면 표가 거짓말을 한다.
                        setTagDrafts((previous) => { const next = { ...previous }; delete next[rowKey(row, index)]; return next })
                      }}
                    />
                  </label>
                </td>
                <td>
                  <label>
                    <span className="sr-only">{row.folderPrefix || '최상위'} 폴더의 AI 처리 수준</span>
                    <select
                      value={row.aiLevel}
                      onChange={(event) => {
                        const value = event.target.value as BulkAiLevel
                        setMapping((previous) => previous.map((entry, position) => (position === index ? { ...entry, aiLevel: value } : entry)))
                      }}
                    >
                      {AI_POLICY_ORDER.map((level) => <option key={level} value={level}>{AI_POLICY_LABELS[level]}</option>)}
                    </select>
                  </label>
                </td>
              </tr>
            })}
            {/*
              어느 행에도 걸리지 않는 파일이 있으면 그 사실을 한 줄로 적는다.
              적지 않으면 표의 합이 고른 파일 수보다 적고, 사람은 '이 표대로 간다'고 읽은 뒤
              전 직원이 보는 자료실로 파일이 가는 것을 보게 된다. 문장은 서버의 거절과 같은 상수다.
            */}
            {mappingCounts.unmapped > 0 && <tr key="bulk-map-unmapped">
              <th scope="row">(매핑 없음)</th>
              <td>{mappingCounts.unmapped}개</td>
              <td colSpan={3}>{canChooseLibrary ? '자료실(전 직원)로 올라갑니다.' : UNMAPPED_MESSAGE}</td>
            </tr>}
          </tbody>
        </table>
        <small>보관만: AI가 열지 않습니다(이름·태그도 보내지 않습니다). 나중에 폴더 단위로 올릴 수 있습니다.</small>
        <div className="bulk-import-rules">
          <label>
            <span className="sr-only">저장할 매핑 이름</span>
            <input value={ruleName} onChange={(event) => setRuleName(event.target.value)} placeholder="이 매핑의 이름" />
          </label>
          <Button tone="quiet" onClick={() => { void saveRule() }}>이 매핑 저장</Button>
          <label>
            <span className="sr-only">저장한 매핑 불러오기</span>
            <select
              value=""
              onChange={(event) => {
                const rule = rules.find((item) => item.id === event.target.value)
                if (!rule) return
                // 작년 매핑은 올해 폴더 이름을 모른다 — 규칙의 행은 그대로 두고, 설명되지 않는 폴더의 행을 더한다.
                setMapping(appendUncoveredRows(rule.mapping, files))
                setTagDrafts({})
              }}
            >
              <option value="">저장한 매핑 불러오기</option>
              {rules.map((rule) => <option key={rule.id} value={rule.id}>{rule.name}</option>)}
            </select>
          </label>
        </div>
      </section>}

      {phase === 'report' && report && <section className="bulk-import-report">
        {/* 범위를 넓힌 일은 보고서에도 남는다 — 매핑 표와 함께 사라지면 그 사실을 알린 화면이 없어진다. */}
        {widened > 0 && <p className="bulk-import-hint">{widenedSentence(widened)}</p>}
        {/* 올린 것이 없으면 용량을 적지 않는다 — 0을 굳이 적으면 무언가 올라간 것처럼 읽힌다. */}
        <p>올린 파일 {report.uploaded}개{report.uploaded > 0 ? ` · ${humanBytes(report.bytes)}` : ''} · 건너뜀 {report.skippedDuplicate}개{report.failed > 0 ? ` · 실패 ${report.failed}개` : ''}</p>
        <table>
          <thead><tr><th scope="col">폴더</th><th scope="col">올림</th><th scope="col">건너뜀</th><th scope="col">실패</th><th scope="col">AI 처리 수준</th></tr></thead>
          <tbody>
            {report.folders.map((folder) => <tr key={folder.folderPrefix || 'bulk-report-root'}>
              <th scope="row">{folder.folderPrefix || '(최상위)'}{folder.projectId ? ` · ${projectNames.get(folder.projectId) ?? '프로젝트'}` : ''}</th>
              <td>{folder.uploaded}</td>
              <td>{folder.skippedDuplicate}</td>
              <td>{folder.failed}</td>
              <td>
                {AI_POLICY_LABELS[raisedFolders[folder.folderPrefix] ? 'indexed' : folder.aiLevel]}
                {canChooseLibrary && folder.aiLevel === 'locked' && folder.uploaded > 0 && !raisedFolders[folder.folderPrefix] && <Button tone="quiet" size="sm" onClick={() => { void raiseFolder(folder.folderPrefix) }}>정리 수준으로 올리기</Button>}
              </td>
            </tr>)}
          </tbody>
        </table>
        {/*
          10MB를 넘는 파일은 매니페스트에 담지 않으므로 서버의 실패 목록에 없다. 그 목록만 그리면
          '올라가지 않은 파일'의 일부가 보고서 어디에도 없게 된다 — 숫자는 서버의 것을 그대로 두고,
          보내지 않은 파일은 따로 세어 같은 목록에 적는다.
        */}
        {(report.failed > 0 || notSent.length > 0) && <details className="bulk-import-failures">
          {/* 없는 것을 '0개'로 적지 않는다 — 실패가 없는 보고서가 실패를 말하는 줄로 시작하면 안 된다. */}
          <summary>{[
            report.failed > 0 ? `실패한 파일 ${report.failed}개${report.failuresTruncated ? ' (앞 200개만 보관)' : ''}` : '',
            notSent.length > 0 ? `보내지 않은 파일 ${notSent.length}개` : '',
          ].filter(Boolean).join(' · ')}</summary>
          <ul>
            {report.failures.map((failure) => <li key={failure.path}>{failure.path} — {failure.error}</li>)}
            {notSent.map((item) => <li key={`not-sent-${item.path}`}>{item.path} — {item.reason}</li>)}
          </ul>
        </details>}
      </section>}

      <footer>
        {phase === 'report'
          ? <>
            {report && report.failed > 0 && <Button tone="secondary" onClick={retryFailed}>실패한 파일만 다시 시도</Button>}
            {/* 끝난 보고서에서 나가는 문. 없으면 이 드로어는 지난 보고서만 보여 주는 화면이 된다. */}
            <Button tone="secondary" onClick={() => startOver()}>새 폴더 고르기</Button>
            <Button tone="quiet" onClick={() => { void copyReport() }}>보고서 복사</Button>
            <Button tone="ghost" onClick={closeDrawer}>닫기</Button>
          </>
          : <>
            {/*
              드로어를 닫으면 이 화면이 시작한 일도 멈춘다 — 'cancel'이라고 적힌 버튼이 아무것도
              멈추지 않으면 안 된다. Esc·배경 클릭·머리말 X도 같은 handler(closeDrawer)를 쓴다.
            */}
            <Button tone="ghost" onClick={closeDrawer}>취소</Button>
            {(phase === 'pick' || phase === 'scan') && <Button tone="secondary" disabled={busy || !files.length} onClick={() => { void scanFiles(files, mapping) }}><RefreshCw size={18} /> {busy ? '확인 중…' : '파일 확인'}</Button>}
            {(phase === 'map' || phase === 'upload') && <Button tone="primary" disabled={busy} onClick={() => { void runUpload() }}>{paused ? '이어서 올리기' : '이관 시작'}</Button>}
          </>}
      </footer>
    </section>
  </div>
}

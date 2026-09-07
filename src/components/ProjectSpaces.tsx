import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, Building2, CalendarDays, Coins, Download, ExternalLink, FileText, FolderKanban, LayoutTemplate, Lock, MessageCircle, Paperclip, Pencil, Pin, Plus, Send, Settings2, Tag, Trash2, Upload, Users, X } from 'lucide-react'
import { formatDateLabel, formatDateTime, seoulDateInputValue } from '../utils/dateTime'
import { downloadDocumentAttachment, uploadDocumentAttachments, type StoredDocumentAttachment } from '../utils/documentAttachments'
import { StatusBadge, type StatusBadgeTone } from './StatusBadge'
import './ProjectSpaces.css'
import { Button, ButtonLink, IconButton } from './ui/Button'
import { useIndustrySurface } from '../modules/IndustryContext'
import { ProjectOriginBadge, TemplateManagerDrawer, TemplatePicker, TemplateRoleMapper, TemplateSaveDialog, useProjectTemplates, type ProjectOrigin, type ProjectTemplate } from './TemplatePicker'

type ProjectRole = 'owner' | 'editor' | 'viewer'
/** kind는 서버가 붙인다. 'guest'는 외부 거래처 계정 — 역할은 항상 viewer로 고정되고 화면은 배지를 단다. */
type MemberKind = 'employee' | 'guest'
type ProjectMember = { id: string; name: string; team?: string; role: ProjectRole; kind?: MemberKind }
type Project = {
  id: string
  legacyId?: string
  name: string
  description: string
  visibility: 'members' | 'company'
  status: 'active' | 'archived'
  stage?: string
  client?: string
  link?: string
  category?: string
  startDate?: string
  endDate?: string
  amount?: number
  ownerId: string
  ownerName: string
  members: ProjectMember[]
  /** 템플릿으로 만든 프로젝트만 가진다. 게스트 응답에서는 서버가 지운다 — 템플릿 이름은 내부 프로세스명이다. */
  origin?: ProjectOrigin | null
  /** 템플릿이 정해 준 자료 분류. 상세 헤더 칩이자 글·댓글 첨부의 기본 분류가 된다. */
  documentCategories?: string[]
  createdAt: string
  updatedAt: string
  role: ProjectRole | null
  postCount: number
  fileCount: number
  lastActivityAt: string
}
type ProjectComment = { id: string; authorId: string; author: string; authorRole?: string; text: string; attachments: StoredDocumentAttachment[]; createdAt: string }
type ProjectPost = { id: string; projectId: string; title: string; body: string; attachments: StoredDocumentAttachment[]; authorId: string; author: string; pinned: boolean; comments: ProjectComment[]; createdAt: string; updatedAt: string }
/** projectIds는 게스트 항목에만 올 수 있다(초대 범위). 있으면 범위 밖 프로젝트의 후보 목록에서 그 게스트를 뺀다. */
type DirectoryEntry = { id: string; name: string; team: string; jobRole: string; kind?: MemberKind; projectIds?: string[] }

/** 외부 게스트 배지 — 로스터·댓글·멤버 아바타에 같은 모양으로 붙인다. */
function GuestBadge() {
  return <StatusBadge className="status-pill project-guest-badge" tone="warning">게스트</StatusBadge>
}

/** 자료 분류를 따로 정하지 않은 프로젝트의 첨부 분류. 지금까지의 동작이 그대로 기본값이다. */
const PROJECT_DOCUMENT_CATEGORY = '프로젝트'
const roleLabel: Record<ProjectRole, string> = { owner: '소유자', editor: '편집', viewer: '열람' }
const roleTone: Record<ProjectRole, StatusBadgeTone> = { owner: 'info', editor: 'success', viewer: 'neutral' }
const PROJECT_STAGES = ['준비', '수주 검토', '수주 확정', '진행 중', '검수', '완료', '보류'] as const
function stageTone(stage: string): StatusBadgeTone {
  return stage === '진행 중' || stage === '수주 확정' ? 'success' : stage === '검수' ? 'warning' : stage === '완료' ? 'info' : stage === '보류' ? 'danger' : 'neutral'
}
function money(value?: number) {
  return value ? `${Math.round(value).toLocaleString('ko-KR')}원` : ''
}

/**
 * 서버 오류는 code·message에 더해 실패한 역할 목록·역할 이름·막힌 자리처럼 사실을 담고 온다.
 * 화면은 그 사실로 문장을 다시 만든다 — '같은 회사 직원만 배정할 수 있습니다'만으로는 어느 역할인지 알 수 없다.
 */
type ApiError = { code?: string; message?: string; roles?: string[]; role?: string; path?: string }

async function readJson<T>(response: Response): Promise<T & { error?: ApiError }> {
  const text = await response.text()
  try { return JSON.parse(text) } catch { return { error: { message: text } } as T & { error?: ApiError } }
}

export function ProjectSpacesPage({ workspaceScope, currentUserId, currentUserName, canManage, onToast, onNavigate, onOpenWiki, guestMode = false, focusProjectId, onFocusHandled }: {
  workspaceScope?: string
  currentUserId: string
  currentUserName: string
  canManage: boolean
  onToast: (message: string) => void
  /** 다른 화면으로 보내는 통로. 멤버 편집기의 "외부 게스트 초대는 인사·조직에서" 링크가 쓴다. */
  onNavigate?: (page: string) => void
  /**
   * 외부 게스트 화면. 새 프로젝트·설정·삭제·글쓰기·필터를 그리지 않고,
   * focusProjectId가 가리키는 프로젝트 상세로 바로 들어간다(목록 화면 없음).
   */
  guestMode?: boolean
  /** 이 프로젝트의 문서를 문서 화면에서 연다. 넘겨받지 않으면 칩 자체를 그리지 않는다. */
  onOpenWiki?: (projectId: string) => void
  focusProjectId?: string
  /**
   * 지목된 프로젝트를 한 번 열었다고 알린다. 부모가 여기서 focusProjectId를 지운다 —
   * 지우지 않으면 다음에 프로젝트 메뉴로 들어올 때마다 같은 상세가 다시 열려 목록에 닿을 수 없다.
   */
  onFocusHandled?: () => void
}) {
  const industry = useIndustrySurface()
  const headers = useMemo(() => ({ 'content-type': 'application/json', ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}) }), [workspaceScope])
  const [projects, setProjects] = useState<Project[]>([])
  const [directory, setDirectory] = useState<DirectoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [posts, setPosts] = useState<ProjectPost[]>([])
  const [detail, setDetail] = useState<Project | null>(null)
  const [editorOpen, setEditorOpen] = useState<'create' | 'settings' | null>(null)
  const [composerOpen, setComposerOpen] = useState(false)
  const [filter, setFilter] = useState<'active' | 'archived'>('active')
  const [detailTab, setDetailTab] = useState<'feed' | 'files'>('feed')
  /** 이 프로젝트에 달린 문서 수. 세어 보기 전에는 null이라 칩을 그리지 않는다. */
  const [wikiCount, setWikiCount] = useState<number | null>(null)
  // 템플릿 드로어와 프로젝트 편집기는 같은 화면의 기본 버튼을 각각 하나씩 가진다. 그래서 둘은 동시에 열리지 않는다.
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [templateInitialId, setTemplateInitialId] = useState<string>()
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false)
  const [presetTemplateId, setPresetTemplateId] = useState('')

  const loadProjects = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const response = await fetch('/api/projects', { headers })
      const body = await readJson<{ projects?: Project[]; directory?: DirectoryEntry[] }>(response)
      if (!response.ok) throw new Error(body.error?.message || '프로젝트를 불러오지 못했습니다.')
      setProjects(body.projects ?? [])
      setDirectory(body.directory ?? [])
    } catch (reason) { onToast(reason instanceof Error ? reason.message : '프로젝트를 불러오지 못했습니다.') }
    finally { setLoading(false) }
  }, [headers, onToast])

  const loadDetail = useCallback(async (projectId: string) => {
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, { headers })
      const body = await readJson<{ project?: Project; posts?: ProjectPost[] }>(response)
      if (!response.ok || !body.project) throw new Error(body.error?.message || '프로젝트를 열지 못했습니다.')
      setDetail(body.project)
      setPosts(body.posts ?? [])
    } catch (reason) { onToast(reason instanceof Error ? reason.message : '프로젝트를 열지 못했습니다.'); setSelectedId(null) }
  }, [headers, onToast])

  useEffect(() => { void loadProjects() }, [loadProjects])
  useEffect(() => { if (selectedId) { setDetailTab('feed'); void loadDetail(selectedId) } }, [selectedId, loadDetail])
  // 게스트는 헤더의 프로젝트 셀렉트가 목록 역할을 한다. 고른 프로젝트 상세를 바로 연다.
  // 직원·관리자는 업무 드로어의 출처 배지로 들어오므로, 지목된 프로젝트가 있으면 목록이 아니라 그 상세를 연다(막다른 길 금지).
  // 지목은 한 번만 쓴다. 남겨 두면 이 화면에 올 때마다 같은 상세가 열려 '프로젝트 목록'이 사라진 것처럼 보인다.
  useEffect(() => {
    if (guestMode) { setSelectedId(focusProjectId || null); return }
    if (focusProjectId) { setSelectedId(focusProjectId); onFocusHandled?.() }
  }, [guestMode, focusProjectId, onFocusHandled])

  const [categoryFilter, setCategoryFilter] = useState('전체')
  const categories = ['전체', ...new Set(projects.map((project) => project.category).filter((value): value is string => Boolean(value)))]
  const visibleProjects = projects
    .filter((project) => filter === 'archived' ? project.status === 'archived' : project.status !== 'archived')
    .filter((project) => categoryFilter === '전체' || project.category === categoryFilter)
  const role = detail?.role ?? null
  // 게스트는 서버가 viewer로 고정하지만, 화면도 같은 규칙을 한 번 더 말한다 — 응답이 어긋나도 글쓰기·설정 버튼이 생기지 않게.
  const canPost = !guestMode && (role === 'owner' || role === 'editor')
  const isOwner = !guestMode && role === 'owner'

  const saveProject = async (input: Record<string, unknown>, projectId?: string) => {
    try {
      const response = await fetch(projectId ? `/api/projects/${encodeURIComponent(projectId)}` : '/api/projects', { method: projectId ? 'PATCH' : 'POST', headers, body: JSON.stringify(input) })
      const body = await readJson<{ project?: Project }>(response)
      if (!response.ok || !body.project) { onToast(body.error?.message || '프로젝트를 저장하지 못했습니다.'); return false }
      onToast(projectId ? '프로젝트 설정을 저장했습니다.' : `‘${body.project.name}’ 프로젝트를 만들었습니다.`)
      await loadProjects(true)
      if (projectId) setDetail(body.project); else setSelectedId(body.project.id)
      setEditorOpen(null)
      return true
    } catch { onToast('서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.'); return false }
  }

  /**
   * 템플릿으로 프로젝트를 만든다. 서버가 프로젝트·업무·채널·반복 규칙을 한 번의 커밋으로 함께 만들고,
   * 실패하면 아무것도 남기지 않는다. 재시도(clientRequestId 같음)는 200으로 같은 프로젝트를 돌려주므로 성공 경로다.
   */
  const instantiateProject = async (templateId: string, input: Record<string, unknown>) => {
    try {
      const response = await fetch(`/api/project-templates/${encodeURIComponent(templateId)}/instantiate`, { method: 'POST', headers, body: JSON.stringify(input) })
      const body = await readJson<{ project?: Project; workItems?: unknown[]; channels?: unknown[]; rules?: unknown[]; replayed?: boolean }>(response)
      if (!response.ok || !body.project) {
        // 서버가 어느 역할이 비었는지·어느 역할에서 막혔는지 알려 주므로 그 이름을 그대로 되읽어 준다 — '역할을 정하세요'로 끝내지 않는다.
        const error = body.error
        onToast(error?.code === 'TEMPLATE_ROLE_UNMAPPED' && error.roles?.length
          ? `역할(${error.roles.join(', ')})에 사람을 정해 주세요.`
          : error?.role
            ? `역할 ‘${error.role}’ — ${error.message || '사람을 다시 골라 주세요.'}`
            : error?.message || '템플릿으로 프로젝트를 만들지 못했습니다.')
        return false
      }
      // 재시도 응답(replayed)에는 채널·규칙이 실려 오지 않는다. 실린 것만 말한다 — 있는 것을 0개라고 부르지 않는다.
      onToast(body.replayed
        ? `‘${body.project.name}’ 프로젝트는 이미 만들어져 있습니다. 업무 ${body.workItems?.length ?? 0}건`
        : `‘${body.project.name}’ 프로젝트를 템플릿으로 만들었습니다. 업무 ${body.workItems?.length ?? 0}건 · 채널 ${body.channels?.length ?? 0}개 · 반복 규칙 ${body.rules?.length ?? 0}개`)
      await loadProjects(true)
      setSelectedId(body.project.id)
      setEditorOpen(null)
      setPresetTemplateId('')
      return true
    } catch {
      // 응답을 받지 못했으면 false를 돌려 편집기를 열어 둔다. 요청 id(clientRequestId)가 그대로라
      // 다시 눌러도 프로젝트가 둘 생기지 않는다 — 닫아 버리면 이름·역할 매핑을 처음부터 다시 적어야 한다.
      onToast('템플릿 서버에 연결할 수 없습니다. 잠시 후 ‘프로젝트 만들기’를 다시 눌러 주세요.')
      return false
    }
  }

  /** 드로어에서 '이 템플릿으로' 를 누르면 목록으로 돌아가 만들기 편집기를 연다 — 상세 화면에는 편집기가 없다. */
  const startFromTemplate = (templateId: string) => {
    setTemplatesOpen(false)
    // 처음 열 템플릿 지목은 여기서 쓰고 버린다. 남겨 두면 다음에 '템플릿' 버튼을 눌렀을 때 목록이 아니라 그 템플릿 편집으로 바로 들어간다.
    setTemplateInitialId(undefined)
    setPresetTemplateId(templateId)
    setSelectedId(null)
    setDetail(null)
    setEditorOpen('create')
  }
  const templateDrawer = templatesOpen ? <TemplateManagerDrawer
    workspaceScope={workspaceScope}
    canManage={canManage}
    initialId={templateInitialId}
    onToast={onToast}
    onClose={() => { setTemplatesOpen(false); setTemplateInitialId(undefined) }}
    onInstantiate={startFromTemplate}
  /> : null

  // 상세를 열 때 그 프로젝트의 문서 수를 센다. 문서 화면과 같은 목록 라우트를 쓰므로 권한 판정이 한 벌이다.
  useEffect(() => {
    if (!selectedId || guestMode) { setWikiCount(null); return }
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch(`/api/wiki?projectId=${encodeURIComponent(selectedId)}`, { headers })
        if (!response.ok) { if (!cancelled) setWikiCount(null); return }
        const body = await readJson<{ documents?: unknown[] }>(response)
        if (!cancelled) setWikiCount((body.documents ?? []).length)
      } catch { if (!cancelled) setWikiCount(null) }
    })()
    return () => { cancelled = true }
  }, [guestMode, headers, selectedId])

  const deleteProject = async () => {
    if (!detail || !window.confirm(`‘${detail.name}’ 프로젝트를 삭제할까요? 글·댓글 기록이 함께 삭제됩니다. 기록을 남기려면 대신 '보관'을 선택하세요.`)) return
    const response = await fetch(`/api/projects/${encodeURIComponent(detail.id)}`, { method: 'DELETE', headers })
    const body = await readJson<{ ok?: boolean }>(response)
    if (!response.ok) { onToast(body.error?.message || '프로젝트를 삭제하지 못했습니다.'); return }
    onToast('프로젝트를 삭제했습니다.')
    setSelectedId(null); setDetail(null)
    void loadProjects(true)
  }
  const createPost = async (input: { title: string; body: string; attachments: StoredDocumentAttachment[] }) => {
    if (!detail) return false
    const response = await fetch(`/api/projects/${encodeURIComponent(detail.id)}/posts`, { method: 'POST', headers, body: JSON.stringify(input) })
    const body = await readJson<{ post?: ProjectPost }>(response)
    if (!response.ok || !body.post) { onToast(body.error?.message || '글을 올리지 못했습니다.'); return false }
    setPosts((current) => [body.post!, ...current])
    onToast('글을 올렸습니다.')
    setComposerOpen(false)
    void loadProjects(true)
    return true
  }
  const updatePost = async (post: ProjectPost, input: { title: string; body: string; attachments: StoredDocumentAttachment[] }) => {
    if (!detail) return false
    const response = await fetch(`/api/projects/${encodeURIComponent(detail.id)}/posts/${encodeURIComponent(post.id)}`, { method: 'PATCH', headers, body: JSON.stringify(input) })
    const body = await readJson<{ post?: ProjectPost }>(response)
    if (!response.ok || !body.post) { onToast(body.error?.message || '글을 수정하지 못했습니다.'); return false }
    setPosts((current) => current.map((item) => item.id === post.id ? body.post! : item))
    onToast('글을 수정했습니다.')
    return true
  }
  const deletePost = async (post: ProjectPost) => {
    if (!detail || !window.confirm(`‘${post.title}’ 글을 삭제할까요? 댓글도 함께 삭제됩니다.`)) return
    const response = await fetch(`/api/projects/${encodeURIComponent(detail.id)}/posts/${encodeURIComponent(post.id)}`, { method: 'DELETE', headers })
    const body = await readJson<{ ok?: boolean }>(response)
    if (!response.ok) { onToast(body.error?.message || '글을 삭제하지 못했습니다.'); return }
    setPosts((current) => current.filter((item) => item.id !== post.id))
    onToast('글을 삭제했습니다.')
  }
  const togglePin = async (post: ProjectPost) => {
    if (!detail) return
    const response = await fetch(`/api/projects/${encodeURIComponent(detail.id)}/posts/${encodeURIComponent(post.id)}`, { method: 'PATCH', headers, body: JSON.stringify({ pinned: !post.pinned }) })
    const body = await readJson<{ post?: ProjectPost }>(response)
    if (!response.ok || !body.post) { onToast(body.error?.message || '고정 상태를 바꾸지 못했습니다.'); return }
    setPosts((current) => current.map((item) => item.id === post.id ? body.post! : item).sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.createdAt.localeCompare(left.createdAt)))
  }
  const addComment = async (post: ProjectPost, input: { text: string; attachments: StoredDocumentAttachment[] }) => {
    if (!detail) return false
    const response = await fetch(`/api/projects/${encodeURIComponent(detail.id)}/posts/${encodeURIComponent(post.id)}/comments`, { method: 'POST', headers, body: JSON.stringify(input) })
    const body = await readJson<{ post?: ProjectPost }>(response)
    if (!response.ok || !body.post) { onToast(body.error?.message || '댓글을 남기지 못했습니다.'); return false }
    setPosts((current) => current.map((item) => item.id === post.id ? body.post! : item))
    return true
  }
  const deleteComment = async (post: ProjectPost, comment: ProjectComment) => {
    if (!detail) return
    const response = await fetch(`/api/projects/${encodeURIComponent(detail.id)}/posts/${encodeURIComponent(post.id)}/comments/${encodeURIComponent(comment.id)}`, { method: 'DELETE', headers })
    const body = await readJson<{ post?: ProjectPost }>(response)
    if (!response.ok || !body.post) { onToast(body.error?.message || '댓글을 삭제하지 못했습니다.'); return }
    setPosts((current) => current.map((item) => item.id === post.id ? body.post! : item))
  }
  const download = async (attachment: StoredDocumentAttachment) => {
    try { await downloadDocumentAttachment(attachment, workspaceScope) } catch (reason) { onToast(reason instanceof Error ? reason.message : '파일을 내려받지 못했습니다.') }
  }

  if (detail && selectedId) {
    const allFiles = posts.flatMap((post) => [
      ...post.attachments.map((attachment) => ({ attachment, source: post.title, author: post.author, at: post.createdAt })),
      ...post.comments.flatMap((comment) => comment.attachments.map((attachment) => ({ attachment, source: `${post.title} 댓글`, author: comment.author, at: comment.createdAt }))),
    ])
    const period = [detail.startDate, detail.endDate].some(Boolean) ? `${detail.startDate ? formatDateLabel(detail.startDate) : '?'} ~ ${detail.endDate ? formatDateLabel(detail.endDate) : '?'}` : ''
    const guestMemberCount = detail.members.filter((member) => member.kind === 'guest').length
    return <div className="content-page project-page">
      <header className="page-header project-detail-header">
        <div>
          {!guestMode && <button type="button" className="project-back" onClick={() => { setSelectedId(null); setDetail(null); void loadProjects(true) }}><ArrowLeft size={16} /> 프로젝트 목록</button>}
          <h1>{detail.name} {detail.category && <StatusBadge className="status-pill" tone="info">{detail.category}</StatusBadge>}{detail.stage && <StatusBadge className="status-pill" dot tone={stageTone(detail.stage)}>{detail.stage}</StatusBadge>}{detail.status === 'archived' && <StatusBadge className="status-pill" tone="neutral">보관됨</StatusBadge>}<ProjectOriginBadge origin={detail.origin} /></h1>
          {detail.description && <p>{detail.description}</p>}
          <div className="project-meta">
            <span className="project-members" title={detail.members.map((member) => `${member.name} (${member.kind === 'guest' ? '게스트' : roleLabel[member.role]})`).join(', ')}><Users size={15} /> {detail.members.slice(0, 6).map((member) => <i key={member.id} className={`project-avatar role-${member.role}${member.kind === 'guest' ? ' is-guest' : ''}`}>{member.name.slice(0, 1)}</i>)}{detail.members.length > 6 && <em>+{detail.members.length - 6}</em>} {detail.members.length}명{guestMemberCount > 0 && <> <StatusBadge className="status-pill project-guest-badge" tone="warning">게스트 {guestMemberCount}명</StatusBadge></>}</span>
            {detail.client && <span><Building2 size={14} /> {detail.client}</span>}
            {period && <span><CalendarDays size={14} /> {period}</span>}
            {money(detail.amount) && <span><Coins size={14} /> {money(detail.amount)}</span>}
            <span>{detail.visibility === 'company' ? <><Users size={14} /> 회사 전체 열람</> : <><Lock size={14} /> 멤버만</>}</span>
            {detail.documentCategories?.length ? <span className="project-doc-categories" title="자료 분류"><FolderKanban size={14} /> {detail.documentCategories.join(' · ')}</span> : null}
            {role && <StatusBadge className="status-pill" tone={guestMode ? 'warning' : roleTone[role]}>내 권한 · {guestMode ? '게스트 (보기와 댓글)' : roleLabel[role]}</StatusBadge>}
            {/* R16-H: 문서는 세 번째 탭을 만들지 않는다 — 이 화면의 기본 버튼은 헤더의 하나뿐이어야 한다. */}
            {!guestMode && onOpenWiki && wikiCount !== null && wikiCount > 0 && (
              <Button tone="quiet" size="sm" type="button" onClick={() => onOpenWiki(detail.id)}>문서 {wikiCount}건</Button>
            )}
          </div>
        </div>
        <div className="page-header-actions">
          {detail.link && <ButtonLink tone="secondary" className="project-link-button" href={detail.link} target="_blank" rel="noreferrer noopener"><ExternalLink size={16} /> 프로젝트 링크 열기</ButtonLink>}
          {isOwner && <Button tone="secondary" type="button" onClick={() => setEditorOpen('settings')}><Settings2 size={17} /> 멤버·설정</Button>}
          {isOwner && canManage && <Button tone="secondary" type="button" onClick={() => setSaveTemplateOpen(true)}><LayoutTemplate size={17} /> 템플릿으로 저장</Button>}
          {isOwner && <Button tone="ghost" className="project-delete" type="button" onClick={() => void deleteProject()}><Trash2 size={16} /> 삭제</Button>}
          {canPost && detail.status !== 'archived' && <Button tone="primary" type="button" onClick={() => { setDetailTab('feed'); setComposerOpen(true) }}><Plus size={18} /> 글 · 파일 올리기</Button>}
        </div>
      </header>

      <div className="segmented project-detail-tabs" role="tablist" aria-label="프로젝트 보기">
        <button type="button" role="tab" aria-selected={detailTab === 'feed'} className={detailTab === 'feed' ? 'active' : ''} onClick={() => setDetailTab('feed')}><MessageCircle size={15} /> 글 피드 {posts.length}</button>
        <button type="button" role="tab" aria-selected={detailTab === 'files'} className={detailTab === 'files' ? 'active' : ''} onClick={() => setDetailTab('files')}><Paperclip size={15} /> 파일 모아보기 {allFiles.length}</button>
      </div>

      {detailTab === 'files'
        ? <section className="panel project-files-panel" aria-label="프로젝트 파일">
          {allFiles.length === 0
            ? <div className="empty-state compact"><Paperclip size={26} /><h3>아직 공유된 파일이 없습니다</h3><p>글이나 댓글에 파일을 첨부하면 여기에 모두 모입니다.</p></div>
            : <div className="project-file-rows" role="list">{allFiles.map(({ attachment, source, author, at }) => <article className="project-file-row" role="listitem" key={`${attachment.id}-${at}`}>
              <span className="project-file-icon"><FileText size={17} /></span>
              <div><strong>{attachment.name}</strong><small>{attachment.size} · {source} · {author} · {formatDateTime(at)}</small></div>
              <button type="button" className="project-file-download" onClick={() => void download(attachment)}><Download size={15} /> 내려받기</button>
            </article>)}</div>}
        </section>
        : <>
          {composerOpen && <PostComposer workspaceScope={workspaceScope} projectName={detail.name} defaultCategory={detail.documentCategories?.[0] ?? PROJECT_DOCUMENT_CATEGORY} onToast={onToast} onClose={() => setComposerOpen(false)} onSubmit={createPost} />}
          <section className="project-feed">
            {/* 빈 상태에는 버튼을 두지 않는다 — 이 화면의 기본 버튼은 헤더의 '글 · 파일 올리기' 하나다(DECISIONS.md:61). */}
            {posts.length === 0 && !composerOpen && <div className="empty-state compact"><FolderKanban size={28} /><h3>아직 올린 글이 없습니다</h3><p>{canPost && detail.status === 'archived' ? '보관된 프로젝트에는 글을 올릴 수 없습니다.' : canPost ? '위 ‘글 · 파일 올리기’로 회의록·자료·진행 상황을 멤버와 공유하세요.' : '편집 권한이 있는 멤버가 글을 올리면 여기에 표시됩니다.'}</p></div>}
            {posts.map((post) => <PostCard key={post.id} post={post} currentUserId={currentUserId} isOwner={isOwner} canComment={Boolean(role)} workspaceScope={workspaceScope} defaultCategory={detail.documentCategories?.[0] ?? PROJECT_DOCUMENT_CATEGORY} onToast={onToast} onDownload={download} onDelete={() => void deletePost(post)} onPin={() => void togglePin(post)} onUpdate={(input) => updatePost(post, input)} onComment={(input) => addComment(post, input)} onDeleteComment={(comment) => void deleteComment(post, comment)} />)}
          </section>
        </>}

      {editorOpen === 'settings' && <ProjectEditor project={detail} directory={directory} currentUserId={currentUserId} onClose={() => setEditorOpen(null)} onSave={(input) => saveProject(input, detail.id)} onNavigate={onNavigate} />}
      {saveTemplateOpen && <TemplateSaveDialog
        project={detail}
        workspaceScope={workspaceScope}
        onToast={onToast}
        onClose={() => setSaveTemplateOpen(false)}
        onSaved={(templateId) => { setSaveTemplateOpen(false); setTemplateInitialId(templateId); setTemplatesOpen(true) }}
      />}
      {templateDrawer}
    </div>
  }

  if (guestMode) {
    // 게스트에게 목록 화면은 없다. 상세를 열지 못한 상태(불러오는 중·범위 밖)만 짧게 말한다.
    // loadDetail이 실패하면 selectedId를 비우므로, selectedId가 남아 있는 동안만 "불러오는 중"이다.
    return <div className="content-page project-page">
      {loading || (selectedId && !detail)
        ? <div className="empty-state compact"><FolderKanban size={26} /><h3>프로젝트를 불러오는 중</h3></div>
        : <div className="empty-state compact"><FolderKanban size={26} /><h3>볼 수 있는 프로젝트가 없습니다</h3><p>초대한 회사가 프로젝트를 지정하면 여기에 게시판이 열립니다. 방금 열리지 않았다면 위에서 프로젝트를 다시 골라 주세요.</p></div>}
    </div>
  }

  return <div className="content-page project-page">
    <header className="page-header">
      <div><span className="eyebrow">PROJECTS</span><h1>프로젝트</h1><p>프로젝트마다 단계·기간·거래처를 관리하고, 같은 공간에서 글·파일·댓글로 협업합니다. 멤버 권한(소유자·편집·열람)별로 공유됩니다.</p></div>
      <div className="page-header-actions">{canManage && <Button tone="secondary" type="button" onClick={() => { setEditorOpen(null); setTemplatesOpen(true) }}><LayoutTemplate size={17} /> 템플릿</Button>}<Button tone="primary" type="button" onClick={() => { setTemplatesOpen(false); setEditorOpen('create') }}><Plus size={18} /> 새 프로젝트</Button></div>
    </header>
    <div className="project-toolbar">
      <div className="segmented" role="group" aria-label="프로젝트 상태"><button type="button" className={filter === 'active' ? 'active' : ''} aria-pressed={filter === 'active'} onClick={() => setFilter('active')}>진행 중 {projects.filter((p) => p.status !== 'archived').length}</button><button type="button" className={filter === 'archived' ? 'active' : ''} aria-pressed={filter === 'archived'} onClick={() => setFilter('archived')}>보관 {projects.filter((p) => p.status === 'archived').length}</button></div>
      {categories.length > 1 && <div className="segmented" role="group" aria-label="프로젝트 구분">{categories.map((category) => <button type="button" key={category} className={categoryFilter === category ? 'active' : ''} aria-pressed={categoryFilter === category} onClick={() => setCategoryFilter(category)}>{category}</button>)}</div>}
      {canManage && <span className="project-toolbar-note">관리자는 모든 프로젝트를 볼 수 있습니다. 직원은 참여 중이거나 회사 전체 공개인 프로젝트만 봅니다.</span>}
    </div>
    {loading ? <div className="empty-state compact"><FolderKanban size={26} /><h3>프로젝트를 불러오는 중</h3></div>
      // 빈 상태에는 버튼을 두지 않는다 — 만들기 버튼은 헤더의 '새 프로젝트' 하나뿐이다(화면당 기본 버튼 1개).
      : visibleProjects.length === 0 ? <div className="empty-state"><FolderKanban size={30} /><h3>{filter === 'archived' ? '보관된 프로젝트가 없습니다' : '아직 프로젝트가 없습니다'}</h3><p>{industry.examples.projectSpace}</p>{canManage && <small className="project-toolbar-note">템플릿을 고르면 업무·하위 업무·채널이 함께 만들어집니다.</small>}</div>
        : <div className="project-grid">
          {visibleProjects.map((project) => <button type="button" className={`project-card${project.status === 'archived' ? ' is-archived' : ''}`} key={project.id} onClick={() => setSelectedId(project.id)}>
            <div className="project-card-head"><span className="project-card-icon"><FolderKanban size={20} /></span><span className="project-card-badges">{project.category && <StatusBadge className="status-pill" tone="info">{project.category}</StatusBadge>}{project.stage && <StatusBadge className="status-pill" dot tone={stageTone(project.stage)}>{project.stage}</StatusBadge>}{project.role && <StatusBadge className="status-pill" tone={roleTone[project.role]}>{roleLabel[project.role]}</StatusBadge>}<ProjectOriginBadge origin={project.origin} /></span></div>
            <strong>{project.name}</strong>
            <p>{[project.client, project.endDate ? `${formatDateLabel(project.endDate)}까지` : '', money(project.amount)].filter(Boolean).join(' · ') || project.description || '설명 없음'}</p>
            <div className="project-card-meta"><span><Users size={14} /> {project.members.length}명</span><span><MessageCircle size={14} /> 글 {project.postCount}</span><span><Paperclip size={14} /> 파일 {project.fileCount}</span></div>
            <small>{project.visibility === 'company' ? '회사 전체 열람' : '멤버만'} · 최근 {formatDateTime(project.lastActivityAt)}</small>
          </button>)}
        </div>}
    {editorOpen === 'create' && <ProjectEditor directory={directory} currentUserId={currentUserId} currentUserName={currentUserName} workspaceScope={workspaceScope} canManage={canManage} initialTemplateId={presetTemplateId || undefined} onInstantiate={instantiateProject} onClose={() => { setEditorOpen(null); setPresetTemplateId('') }} onSave={(input) => saveProject(input)} onNavigate={onNavigate} />}
    {templateDrawer}
  </div>
}

function ProjectEditor({ project, directory, currentUserId, currentUserName, workspaceScope, canManage, initialTemplateId, onInstantiate, onClose, onSave, onNavigate }: {
  project?: Project
  directory: DirectoryEntry[]
  currentUserId: string
  currentUserName?: string
  workspaceScope?: string
  canManage?: boolean
  /** 관리 드로어에서 '이 템플릿으로'를 눌러 들어온 경우 미리 골라 둔 템플릿. */
  initialTemplateId?: string
  onInstantiate?: (templateId: string, input: Record<string, unknown>) => Promise<boolean>
  onClose: () => void
  onSave: (input: Record<string, unknown>) => Promise<boolean>
  onNavigate?: (page: string) => void
}) {
  const [name, setName] = useState(project?.name ?? '')
  const [description, setDescription] = useState(project?.description ?? '')
  const [visibility, setVisibility] = useState<'members' | 'company'>(project?.visibility ?? 'members')
  const [status, setStatus] = useState<'active' | 'archived'>(project?.status ?? 'active')
  const [stage, setStage] = useState(project?.stage ?? '')
  const [client, setClient] = useState(project?.client ?? '')
  const [link, setLink] = useState(project?.link ?? '')
  const [category, setCategory] = useState(project?.category ?? '')
  // 템플릿을 미리 고른 채로 열렸으면 시작일도 함께 채운다 — 마감의 기준일이라 말해 놓고 빈 칸을 보여 줄 수는 없다(라디오를 누른 경로와 같은 값).
  const [startDate, setStartDate] = useState(project?.startDate ?? (initialTemplateId ? seoulDateInputValue() : ''))
  const [endDate, setEndDate] = useState(project?.endDate ?? '')
  const [amount, setAmount] = useState(project?.amount ?? 0)
  const [members, setMembers] = useState<Array<{ id: string; role: ProjectRole }>>(() => (project?.members ?? []).filter((member) => member.role !== 'owner').map((member) => ({ id: member.id, role: member.role })))
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  // 템플릿은 새로 만들 때만 고른다(설정 모드에서는 이미 만들어진 프로젝트다). 관리자가 아니면 목록을 아예 부르지 않는다.
  const { templates, reload: reloadTemplates, error: templatesError } = useProjectTemplates(workspaceScope, !project && Boolean(canManage))
  const [templateId, setTemplateId] = useState(initialTemplateId ?? '')
  const [roleMap, setRoleMap] = useState<Record<string, string>>({})
  // 역할 매핑으로 들어온 사람과 손으로 고른 사람을 갈라 둔다 — 템플릿을 바꾸면 앞의 사람들만 걷어낸다.
  const roleAddedRef = useRef(new Set<string>())
  // 같은 편집기에서 여러 번 눌러도 프로젝트가 여러 개 생기지 않게, 만들기 요청 id는 편집기 한 번에 하나다.
  const clientRequestId = useRef(crypto.randomUUID())
  const template: ProjectTemplate | null = templates?.find((item) => item.id === templateId) ?? null
  const mappedCount = template ? template.roles.filter((role) => roleMap[role]).length : 0
  // 고른 템플릿을 아직 손에 넣지 못한 상태. 이대로 만들면 템플릿 없는 빈 프로젝트가 생기므로 만들기를 미룬다.
  const templatePending = templateId !== '' && template === null
  const ownerId = project?.ownerId ?? currentUserId
  const ownerName = project?.ownerName ?? currentUserName ?? ''
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey) }, [onClose])
  const nameOf = (id: string) => directory.find((entry) => entry.id === id)?.name ?? project?.members.find((member) => member.id === id)?.name ?? id
  const memberRole = (id: string) => members.find((member) => member.id === id)?.role ?? null
  const isGuestEntry = (id: string) => directory.find((entry) => entry.id === id)?.kind === 'guest' || project?.members.find((member) => member.id === id)?.kind === 'guest'
  /**
   * 게스트가 이 프로젝트의 후보가 되는가. 게스트는 인사·조직에서 초대할 때 정한 프로젝트 범위 안에서만 멤버가 된다.
   * 새 프로젝트(아직 id 없음)에는 범위가 있을 수 없으니 전부 뺀다. 범위(projectIds)를 모르는 항목은 서버 400에 맡긴다.
   */
  const guestAllowedHere = (entry: DirectoryEntry) => {
    if (entry.kind !== 'guest') return true
    if (!project) return false
    return !Array.isArray(entry.projectIds) || entry.projectIds.includes(project.id)
  }
  // 회사 구성원 전체 목록 — 검색은 필터일 뿐, 항상 모두 보이고 눌러서 넣고 뺀다.
  const normalizedQuery = query.trim().toLowerCase()
  const roster = directory
    .filter((entry) => entry.id !== ownerId)
    .filter(guestAllowedHere)
    .filter((entry) => !normalizedQuery || `${entry.name} ${entry.team} ${entry.jobRole}`.toLowerCase().includes(normalizedQuery))
    .sort((left, right) => Number(Boolean(memberRole(right.id))) - Number(Boolean(memberRole(left.id))) || (left.team || '').localeCompare(right.team || '', 'ko') || left.name.localeCompare(right.name, 'ko'))
  // 게스트는 viewer로만 들어간다. 편집 권한을 줘도 서버가 viewer로 되돌리므로 화면에서 처음부터 그렇게 넣는다.
  const toggleMember = (id: string) => {
    // 뺀 사람이 역할 매핑에 남아 있으면 서버가 그 사람을 편집 멤버로 되살린다 — '제외'가 아무 일도 안 한 것처럼 보인다.
    // 매핑에서도 빼면 역할 한 자리가 비고, 이미 있는 규칙이 만들기를 막으며 그 까닭을 화면이 말한다.
    if (members.some((member) => member.id === id)) {
      setRoleMap((current) => Object.fromEntries(Object.entries(current).filter(([, value]) => value !== id)))
      roleAddedRef.current.delete(id)
    }
    setMembers((current) => current.some((member) => member.id === id) ? current.filter((member) => member.id !== id) : [...current, { id, role: isGuestEntry(id) ? 'viewer' : 'editor' }])
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="modal-card project-editor" role="dialog" aria-modal="true" aria-labelledby="project-editor-title">
      <header><div><span className="eyebrow">{project ? 'PROJECT SETTINGS' : 'NEW PROJECT'}</span><h2 id="project-editor-title">{project ? '멤버 · 설정' : '새 프로젝트'}</h2><p>{project ? '멤버 권한·관리 정보·공개 범위를 바꿉니다.' : '이름만 정하면 시작됩니다. 멤버·관리 정보는 나중에도 바꿀 수 있습니다.'}</p></div><IconButton tone="ghost" type="button" aria-label="닫기" onClick={onClose}><X size={21} /></IconButton></header>
      <form onSubmit={async (event: FormEvent) => {
        event.preventDefault()
        if (name.trim().length < 2) return
        setBusy(true)
        // 무슨 일이 있어도 busy는 풀린다 — 풀리지 않으면 '저장 중…'과 disabled된 취소만 남아 화면이 굳는다.
        try {
          // 템플릿을 골랐으면 프로젝트만 만드는 저장이 아니라 실체화다 — 업무·채널·규칙이 함께 만들어진다.
          // 비어 있는 관리 정보는 보내지 않는다. 보내면 서버가 정해 둔 시작 단계('준비')를 빈 값으로 덮어쓴다.
          const ok = template && onInstantiate
            ? await onInstantiate(template.id, {
              name: name.trim(), description: description.trim(), visibility, members, client: client.trim(),
              startDate: startDate || undefined, roleMap, clientRequestId: clientRequestId.current,
              ...(stage ? { stage } : {}), ...(endDate ? { endDate } : {}), ...(amount ? { amount } : {}),
              ...(link.trim() ? { link: link.trim() } : {}), ...(category.trim() ? { category: category.trim() } : {}),
            })
            : await onSave({ name: name.trim(), description: description.trim(), visibility, members, stage, client: client.trim(), startDate, endDate, amount, link: link.trim(), category: category.trim(), ...(project ? { status } : {}) })
          if (ok) onClose()
        } finally { setBusy(false) }
      }}>
        {!project && canManage && <TemplatePicker
          templates={templates}
          selectedId={templateId}
          error={templatesError}
          onRetry={() => void reloadTemplates()}
          onSelect={(id) => {
            // 걷어낼 명단을 먼저 손에 쥔다. setMembers의 함수는 지금이 아니라 다음 렌더에서 실행되므로,
            // ref를 비운 뒤에 읽게 두면 빈 집합을 보고 아무도 걷어내지 못한다.
            const seeded = roleAddedRef.current
            roleAddedRef.current = new Set()
            setTemplateId(id)
            setRoleMap({})
            // 앞 템플릿이 채워 넣은 사람은 함께 걷어낸다 — 남겨 두면 고르지도 않은 사람이 새 프로젝트의 편집 멤버가 된다.
            setMembers((current) => current.filter((member) => !seeded.has(member.id)))
            if (id && !startDate) setStartDate(seoulDateInputValue())
          }}
        />}
        {/* 만들기가 멈춘 까닭은 세 가지뿐이고, 셋을 한 문장씩 갈라 말한다 — 지워진 템플릿을 '불러오는 중'이라 하지 않는다. */}
        {templatePending && <p className="project-template-note" id="project-template-pending">{templatesError
          ? '고른 템플릿을 아직 확인하지 못했습니다. 위에서 템플릿을 다시 불러온 뒤에 만들 수 있습니다.'
          : templates === null
            ? '고른 템플릿을 불러오는 중입니다.'
            : '고른 템플릿이 목록에 없습니다. 위에서 템플릿을 다시 골라 주세요.'}</p>}
        <label className="form-field full"><span>프로젝트 이름 <em>필수</em></span><input value={name} onChange={(event) => setName(event.target.value)} autoFocus required minLength={2} maxLength={80} placeholder="예: 한국도로공사 시뮬레이션" /></label>
        {template && <TemplateRoleMapper
          template={template}
          directory={directory}
          roleMap={roleMap}
          onChange={(role, id) => {
            setRoleMap((current) => ({ ...current, [role]: id }))
            // 소유자는 멤버 목록에 다시 넣지 않는다. 서버가 걸러 내므로(normalizeProjectMembers), 넣으면 '멤버 N명'만 한 명 부풀고
            // 그 줄은 로스터(소유자 제외)에 없어 지울 수도 없다. 소유자를 역할에 앉히는 것 자체는 그대로 된다.
            if (id === ownerId) return
            roleAddedRef.current.add(id)
            setMembers((current) => current.some((member) => member.id === id) ? current : [...current, { id, role: 'editor' }])
          }}
        />}
        <label className="form-field full"><span>설명 <em>선택</em></span><input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} placeholder="무엇을 위한 프로젝트인지 한 줄로" /></label>
        <div className="form-grid">
          <label className="form-field"><span>구분</span><input value={category} onChange={(event) => setCategory(event.target.value)} list="project-category-options" maxLength={20} placeholder="예: 웹, 앱, 시스템" /><datalist id="project-category-options"><option>웹</option><option>앱</option><option>시스템</option><option>디자인</option><option>유지보수</option><option>연구개발</option><option>인증</option><option>기타</option></datalist></label>
          <label className="form-field"><span>진행 단계</span><select value={stage} onChange={(event) => setStage(event.target.value)}><option value="">미지정</option>{PROJECT_STAGES.map((item) => <option key={item}>{item}</option>)}</select></label>
        </div>
        <div className="form-grid">
          <label className="form-field"><span>발주처 · 거래처</span><input value={client} onChange={(event) => setClient(event.target.value)} maxLength={80} placeholder="예: 한국도로공사" /></label>
          <label className="form-field"><span>프로젝트 링크 <em>선택</em></span><input value={link} onChange={(event) => setLink(event.target.value)} maxLength={300} placeholder="예: https://github.com/..., 피그마·노션 주소" /></label>
        </div>
        <div className="form-grid">
          <label className="form-field"><span>시작일</span><input type="date" value={startDate} max={endDate || undefined} onChange={(event) => setStartDate(event.target.value)} />{template && <small className="project-template-note">업무 마감의 기준일입니다.</small>}</label>
          <label className="form-field"><span>종료 예정일</span><input type="date" value={endDate} min={startDate || undefined} onChange={(event) => setEndDate(event.target.value)} /></label>
        </div>
        <div className="form-grid">
          <label className="form-field"><span>계약 금액 (원)</span><input type="number" min={0} step={10000} value={amount || ''} onChange={(event) => setAmount(Math.max(0, Number(event.target.value) || 0))} placeholder="0" /></label>
          <label className="form-field"><span>공개 범위</span><select value={visibility} onChange={(event) => setVisibility(event.target.value as 'members' | 'company')}><option value="members">멤버만 (초대된 사람)</option><option value="company">회사 전체 열람 (글쓰기는 멤버만)</option></select></label>
        </div>
        {project && <label className="form-field full"><span>상태</span><select value={status} onChange={(event) => setStatus(event.target.value as 'active' | 'archived')}><option value="active">진행 중</option><option value="archived">보관 (읽기 전용)</option></select></label>}
        <div className="project-member-editor">
          <div className="project-member-head"><strong><Users size={16} /> 멤버 {members.length + 1}명 / 전체 {directory.length}명</strong><span>소유자: {ownerName || nameOf(ownerId)}</span></div>
          <label className="project-member-search"><span className="sr-only">구성원 검색</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="이름·부서로 검색 (비워 두면 전체 표시)" /></label>
          <ul className="project-roster" aria-label="회사 구성원 — 눌러서 추가·제외">
            <li className="is-owner-row"><i className="project-avatar role-owner">{(ownerName || nameOf(ownerId)).slice(0, 1)}</i><div><span>{ownerName || nameOf(ownerId)}</span><small>프로젝트 소유자</small></div><em>소유자</em></li>
            {roster.map((entry) => {
              const currentRole = memberRole(entry.id)
              const guest = entry.kind === 'guest'
              return <li key={entry.id} className={`${currentRole ? 'is-member' : ''}${guest ? ' is-guest' : ''}`}>
                <i className={`project-avatar role-${currentRole ?? 'viewer'}${guest ? ' is-guest' : ''}`}>{entry.name.slice(0, 1)}</i>
                <div><span>{entry.name}{guest && <> <GuestBadge /></>}</span><small>{[entry.team, guest ? '외부 게스트' : entry.jobRole].filter(Boolean).join(' · ') || '소속 미지정'}</small></div>
                {currentRole && <select value={guest ? 'viewer' : currentRole} disabled={guest} aria-label={`${entry.name} 권한${guest ? ' (게스트는 열람 고정)' : ''}`} onClick={(event) => event.stopPropagation()} onChange={(event) => setMembers((current) => current.map((member) => member.id === entry.id ? { ...member, role: event.target.value as ProjectRole } : member))}><option value="editor">편집</option><option value="viewer">열람</option></select>}
                <button type="button" className={currentRole ? 'project-roster-remove' : 'project-roster-add'} onClick={() => toggleMember(entry.id)}>{currentRole ? <><X size={14} /> 제외</> : <><Plus size={14} /> 추가</>}</button>
              </li>
            })}
            {roster.length === 0 && <li className="project-roster-empty">일치하는 구성원이 없습니다.</li>}
          </ul>
          <p className="project-member-hint">편집: 글·파일 올리기 가능 · 열람: 보기와 댓글만 · 회사 전체 공개여도 글쓰기는 멤버만 가능합니다. 게스트는 열람으로 고정됩니다.</p>
          {onNavigate && <div className="project-member-guest-link"><Button tone="quiet" size="sm" type="button" onClick={() => { onClose(); onNavigate('people') }}>외부 게스트 초대는 인사·조직 → 계정·권한에서</Button></div>}
        </div>
        <footer><Button tone="ghost" type="button" onClick={onClose} disabled={busy}>취소</Button><Button tone="primary" type="submit" aria-describedby={templatePending ? 'project-template-pending' : undefined} disabled={busy || name.trim().length < 2 || templatePending || (template !== null && mappedCount < template.roles.length)}>{busy ? '저장 중…' : project ? '설정 저장' : '프로젝트 만들기'}</Button></footer>
      </form>
    </section>
  </div>
}

function AttachmentPicker({ attachments, busy, onPick, onRemove, label = '파일 첨부' }: { attachments: StoredDocumentAttachment[]; busy: boolean; onPick: (files: File[]) => void; onRemove: (attachment: StoredDocumentAttachment) => void; label?: string }) {
  const inputRef = useRef<HTMLInputElement>(null)
  return <div className="project-attachments">
    <input ref={inputRef} type="file" className="sr-only" multiple onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; if (files.length) onPick(files) }} />
    <div className="project-attachment-list">
      {attachments.map((attachment) => <span className="project-attachment-chip" key={attachment.id}><Paperclip size={13} /> {attachment.name} <small>{attachment.size}</small><button type="button" aria-label={`${attachment.name} 제거`} onClick={() => onRemove(attachment)}><X size={13} /></button></span>)}
      <button type="button" className="project-attachment-add" disabled={busy} onClick={() => inputRef.current?.click()}><Upload size={14} /> {busy ? '업로드 중…' : label}</button>
    </div>
  </div>
}

function PostForm({ workspaceScope, projectName, defaultCategory = PROJECT_DOCUMENT_CATEGORY, initial, submitLabel, busyLabel, onToast, onCancel, onSubmit }: {
  workspaceScope?: string; projectName: string
  /** 템플릿이 정해 준 첫 자료 분류. 없으면 지금까지처럼 '프로젝트'로 올린다. */
  defaultCategory?: string
  initial?: { title: string; body: string; attachments: StoredDocumentAttachment[] }
  submitLabel: string; busyLabel: string
  onToast: (message: string) => void; onCancel: () => void
  onSubmit: (input: { title: string; body: string; attachments: StoredDocumentAttachment[] }) => Promise<boolean>
}) {
  const [title, setTitle] = useState(initial?.title ?? '')
  const [body, setBody] = useState(initial?.body ?? '')
  const [attachments, setAttachments] = useState<StoredDocumentAttachment[]>(initial?.attachments ?? [])
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const pick = async (files: File[]) => {
    setUploading(true)
    try { const added = await uploadDocumentAttachments(files, { workspaceScope, category: defaultCategory, summary: `${projectName} 프로젝트 게시글 첨부`, tags: [PROJECT_DOCUMENT_CATEGORY, projectName] }); setAttachments((current) => [...current, ...added]) }
    catch (reason) { onToast(reason instanceof Error ? reason.message : '파일을 업로드하지 못했습니다.') }
    finally { setUploading(false) }
  }
  return <form className="project-post-form" onSubmit={async (event) => { event.preventDefault(); if (!title.trim() && !body.trim() && attachments.length === 0) return; setBusy(true); const ok = await onSubmit({ title: title.trim(), body: body.trim(), attachments }); setBusy(false); if (ok && !initial) { setTitle(''); setBody(''); setAttachments([]) } }}>
    <input className="project-post-form-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} placeholder="제목 (비우면 첫 줄이 제목이 됩니다)" autoFocus aria-label="제목" />
    <textarea className="project-post-form-body" rows={3} value={body} onChange={(event) => setBody(event.target.value)} maxLength={8000} placeholder="내용을 적거나 파일만 올려도 됩니다." aria-label="내용" />
    <div className="project-post-form-foot">
      <AttachmentPicker attachments={attachments} busy={uploading} onPick={(files) => void pick(files)} onRemove={(attachment) => setAttachments((current) => current.filter((item) => item.id !== attachment.id))} />
      <div className="project-post-form-actions">
        <Button tone="ghost" type="button" onClick={onCancel} disabled={busy}>취소</Button>
        <Button tone="primary" type="submit" disabled={busy || uploading || (!title.trim() && !body.trim() && attachments.length === 0)}><Send size={15} /> {busy ? busyLabel : submitLabel}</Button>
      </div>
    </div>
  </form>
}

function PostComposer(props: { workspaceScope?: string; projectName: string; defaultCategory?: string; onToast: (message: string) => void; onClose: () => void; onSubmit: (input: { title: string; body: string; attachments: StoredDocumentAttachment[] }) => Promise<boolean> }) {
  return <section className="panel project-composer" aria-label="새 글 작성">
    <div className="project-composer-head"><strong><Pencil size={15} /> 새 글 · 파일</strong><IconButton tone="ghost" type="button" aria-label="닫기" onClick={props.onClose}><X size={17} /></IconButton></div>
    <PostForm workspaceScope={props.workspaceScope} projectName={props.projectName} defaultCategory={props.defaultCategory} submitLabel="올리기" busyLabel="올리는 중…" onToast={props.onToast} onCancel={props.onClose} onSubmit={props.onSubmit} />
  </section>
}

function PostCard({ post, currentUserId, isOwner, canComment, workspaceScope, defaultCategory = PROJECT_DOCUMENT_CATEGORY, onToast, onDownload, onDelete, onPin, onUpdate, onComment, onDeleteComment }: {
  post: ProjectPost; currentUserId: string; isOwner: boolean; canComment: boolean; workspaceScope?: string; defaultCategory?: string; onToast: (message: string) => void
  onDownload: (attachment: StoredDocumentAttachment) => void; onDelete: () => void; onPin: () => void
  onUpdate: (input: { title: string; body: string; attachments: StoredDocumentAttachment[] }) => Promise<boolean>
  onComment: (input: { text: string; attachments: StoredDocumentAttachment[] }) => Promise<boolean>; onDeleteComment: (comment: ProjectComment) => void
}) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<StoredDocumentAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [showComposer, setShowComposer] = useState(false)
  const [editing, setEditing] = useState(false)
  const mine = post.authorId === currentUserId
  const pick = async (files: File[]) => {
    setUploading(true)
    try { const added = await uploadDocumentAttachments(files, { workspaceScope, category: defaultCategory, summary: `${post.title} 댓글 첨부`, tags: [PROJECT_DOCUMENT_CATEGORY, '댓글'] }); setAttachments((current) => [...current, ...added]) }
    catch (reason) { onToast(reason instanceof Error ? reason.message : '파일을 업로드하지 못했습니다.') }
    finally { setUploading(false) }
  }
  if (editing) {
    return <article className="project-post is-editing">
      <div className="project-composer-head"><strong><Pencil size={15} /> 글 수정</strong></div>
      <PostForm workspaceScope={workspaceScope} projectName={post.title} defaultCategory={defaultCategory} initial={{ title: post.title, body: post.body, attachments: post.attachments }} submitLabel="수정 저장" busyLabel="저장 중…" onToast={onToast} onCancel={() => setEditing(false)} onSubmit={async (input) => { const ok = await onUpdate(input); if (ok) setEditing(false); return ok }} />
    </article>
  }
  return <article className={`project-post${post.pinned ? ' is-pinned' : ''}`}>
    <header>
      <i className="project-avatar role-editor">{post.author.slice(0, 1)}</i>
      <div><strong>{post.title}</strong><small>{post.author} · {formatDateTime(post.createdAt)}{post.updatedAt !== post.createdAt && ' · 수정됨'}{post.pinned && <em className="project-pin-label"><Pin size={12} /> 고정</em>}</small></div>
      <div className="project-post-actions">
        {isOwner && <button type="button" aria-label={post.pinned ? '고정 해제' : '상단 고정'} title={post.pinned ? '고정 해제' : '상단 고정'} onClick={onPin}><Pin size={15} /></button>}
        {(mine || isOwner) && <button type="button" aria-label="글 수정" title="수정" onClick={() => setEditing(true)}><Pencil size={15} /></button>}
        {(mine || isOwner) && <button type="button" aria-label="글 삭제" title="삭제" onClick={onDelete}><Trash2 size={15} /></button>}
      </div>
    </header>
    {post.body && <p className="project-post-body">{post.body}</p>}
    {post.attachments.length > 0 && <div className="project-post-files">{post.attachments.map((attachment) => <button type="button" key={attachment.id} onClick={() => onDownload(attachment)}><Download size={14} /> {attachment.name} <small>{attachment.size}</small></button>)}</div>}
    <div className="project-comments">
      {post.comments.map((comment) => <div className="project-comment" key={comment.id}>
        <i className={`project-avatar role-viewer${comment.authorRole === 'tenant-guest' ? ' is-guest' : ''}`}>{comment.author.slice(0, 1)}</i>
        <div><span className="project-comment-head"><strong>{comment.author}</strong>{comment.authorRole === 'tenant-guest' && <GuestBadge />}<time dateTime={comment.createdAt}>{formatDateTime(comment.createdAt)}</time>{(comment.authorId === currentUserId || isOwner) && <button type="button" aria-label="댓글 삭제" onClick={() => onDeleteComment(comment)}><X size={13} /></button>}</span>{comment.text && <p>{comment.text}</p>}{comment.attachments.length > 0 && <span className="project-comment-files">{comment.attachments.map((attachment) => <button type="button" key={attachment.id} onClick={() => onDownload(attachment)}><Download size={12} /> {attachment.name}</button>)}</span>}</div>
      </div>)}
      {canComment && (showComposer
        ? <form className="project-comment-composer" onSubmit={async (event) => { event.preventDefault(); if (!text.trim() && attachments.length === 0) return; setBusy(true); const ok = await onComment({ text: text.trim(), attachments }); setBusy(false); if (ok) { setText(''); setAttachments([]); setShowComposer(false) } }}>
          <textarea rows={2} value={text} onChange={(event) => setText(event.target.value)} maxLength={2000} placeholder="댓글을 남기거나 파일을 첨부하세요" autoFocus />
          <div className="project-comment-composer-tools">
            <AttachmentPicker attachments={attachments} busy={uploading} label="파일" onPick={(files) => void pick(files)} onRemove={(attachment) => setAttachments((current) => current.filter((item) => item.id !== attachment.id))} />
            <div className="project-post-form-actions"><Button tone="ghost" type="button" onClick={() => setShowComposer(false)} disabled={busy}>취소</Button><Button tone="primary" size="sm" type="submit" disabled={busy || uploading || (!text.trim() && attachments.length === 0)}><MessageCircle size={14} /> {busy ? '남기는 중…' : '댓글'}</Button></div>
          </div>
        </form>
        : <button type="button" className="project-comment-open" onClick={() => setShowComposer(true)}><MessageCircle size={14} /> 댓글 남기기{post.comments.length ? ` (${post.comments.length})` : ''}</button>)}
    </div>
  </article>
}

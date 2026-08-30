import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, Building2, CalendarDays, Coins, Download, ExternalLink, FileText, FolderKanban, Lock, MessageCircle, Paperclip, Pencil, Pin, Plus, Send, Settings2, Tag, Trash2, Upload, Users, X } from 'lucide-react'
import { formatDateLabel, formatDateTime } from '../utils/dateTime'
import { downloadDocumentAttachment, uploadDocumentAttachments, type StoredDocumentAttachment } from '../utils/documentAttachments'
import { StatusBadge, type StatusBadgeTone } from './StatusBadge'
import './ProjectSpaces.css'
import { Button, ButtonLink, IconButton } from './ui/Button'

type ProjectRole = 'owner' | 'editor' | 'viewer'
type ProjectMember = { id: string; name: string; team?: string; role: ProjectRole }
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
  createdAt: string
  updatedAt: string
  role: ProjectRole | null
  postCount: number
  fileCount: number
  lastActivityAt: string
}
type ProjectComment = { id: string; authorId: string; author: string; text: string; attachments: StoredDocumentAttachment[]; createdAt: string }
type ProjectPost = { id: string; projectId: string; title: string; body: string; attachments: StoredDocumentAttachment[]; authorId: string; author: string; pinned: boolean; comments: ProjectComment[]; createdAt: string; updatedAt: string }
type DirectoryEntry = { id: string; name: string; team: string; jobRole: string }

const roleLabel: Record<ProjectRole, string> = { owner: '소유자', editor: '편집', viewer: '열람' }
const roleTone: Record<ProjectRole, StatusBadgeTone> = { owner: 'info', editor: 'success', viewer: 'neutral' }
const PROJECT_STAGES = ['준비', '수주 검토', '수주 확정', '진행 중', '검수', '완료', '보류'] as const
function stageTone(stage: string): StatusBadgeTone {
  return stage === '진행 중' || stage === '수주 확정' ? 'success' : stage === '검수' ? 'warning' : stage === '완료' ? 'info' : stage === '보류' ? 'danger' : 'neutral'
}
function money(value?: number) {
  return value ? `${Math.round(value).toLocaleString('ko-KR')}원` : ''
}

async function readJson<T>(response: Response): Promise<T & { error?: { message?: string } }> {
  const text = await response.text()
  try { return JSON.parse(text) } catch { return { error: { message: text } } as T & { error?: { message?: string } } }
}

export function ProjectSpacesPage({ workspaceScope, currentUserId, currentUserName, canManage, onToast }: {
  workspaceScope?: string
  currentUserId: string
  currentUserName: string
  canManage: boolean
  onToast: (message: string) => void
}) {
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

  const [categoryFilter, setCategoryFilter] = useState('전체')
  const categories = ['전체', ...new Set(projects.map((project) => project.category).filter((value): value is string => Boolean(value)))]
  const visibleProjects = projects
    .filter((project) => filter === 'archived' ? project.status === 'archived' : project.status !== 'archived')
    .filter((project) => categoryFilter === '전체' || project.category === categoryFilter)
  const role = detail?.role ?? null
  const canPost = role === 'owner' || role === 'editor'
  const isOwner = role === 'owner'

  const saveProject = async (input: Record<string, unknown>, projectId?: string) => {
    const response = await fetch(projectId ? `/api/projects/${encodeURIComponent(projectId)}` : '/api/projects', { method: projectId ? 'PATCH' : 'POST', headers, body: JSON.stringify(input) })
    const body = await readJson<{ project?: Project }>(response)
    if (!response.ok || !body.project) { onToast(body.error?.message || '프로젝트를 저장하지 못했습니다.'); return false }
    onToast(projectId ? '프로젝트 설정을 저장했습니다.' : `‘${body.project.name}’ 프로젝트를 만들었습니다.`)
    await loadProjects(true)
    if (projectId) setDetail(body.project); else setSelectedId(body.project.id)
    setEditorOpen(null)
    return true
  }

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
    return <div className="content-page project-page">
      <header className="page-header project-detail-header">
        <div>
          <button type="button" className="project-back" onClick={() => { setSelectedId(null); setDetail(null); void loadProjects(true) }}><ArrowLeft size={16} /> 프로젝트 목록</button>
          <h1>{detail.name} {detail.category && <StatusBadge className="status-pill" tone="info">{detail.category}</StatusBadge>}{detail.stage && <StatusBadge className="status-pill" dot tone={stageTone(detail.stage)}>{detail.stage}</StatusBadge>}{detail.status === 'archived' && <StatusBadge className="status-pill" tone="neutral">보관됨</StatusBadge>}</h1>
          {detail.description && <p>{detail.description}</p>}
          <div className="project-meta">
            <span className="project-members" title={detail.members.map((member) => `${member.name} (${roleLabel[member.role]})`).join(', ')}><Users size={15} /> {detail.members.slice(0, 6).map((member) => <i key={member.id} className={`project-avatar role-${member.role}`}>{member.name.slice(0, 1)}</i>)}{detail.members.length > 6 && <em>+{detail.members.length - 6}</em>} {detail.members.length}명</span>
            {detail.client && <span><Building2 size={14} /> {detail.client}</span>}
            {period && <span><CalendarDays size={14} /> {period}</span>}
            {money(detail.amount) && <span><Coins size={14} /> {money(detail.amount)}</span>}
            <span>{detail.visibility === 'company' ? <><Users size={14} /> 회사 전체 열람</> : <><Lock size={14} /> 멤버만</>}</span>
            {role && <StatusBadge className="status-pill" tone={roleTone[role]}>내 권한 · {roleLabel[role]}</StatusBadge>}
          </div>
        </div>
        <div className="page-header-actions">
          {detail.link && <ButtonLink tone="secondary" className="project-link-button" href={detail.link} target="_blank" rel="noreferrer noopener"><ExternalLink size={16} /> 프로젝트 링크 열기</ButtonLink>}
          {isOwner && <Button tone="secondary" type="button" onClick={() => setEditorOpen('settings')}><Settings2 size={17} /> 멤버·설정</Button>}
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
          {composerOpen && <PostComposer workspaceScope={workspaceScope} projectName={detail.name} onToast={onToast} onClose={() => setComposerOpen(false)} onSubmit={createPost} />}
          <section className="project-feed">
            {posts.length === 0 && !composerOpen && <div className="empty-state compact"><FolderKanban size={28} /><h3>아직 올린 글이 없습니다</h3><p>{canPost ? '회의록·자료·진행 상황을 글이나 파일로 올려 멤버와 공유하세요.' : '편집 권한이 있는 멤버가 글을 올리면 여기에 표시됩니다.'}</p>{canPost && <Button tone="primary" type="button" onClick={() => setComposerOpen(true)}><Plus size={17} /> 첫 글 올리기</Button>}</div>}
            {posts.map((post) => <PostCard key={post.id} post={post} currentUserId={currentUserId} isOwner={isOwner} canComment={Boolean(role)} workspaceScope={workspaceScope} onToast={onToast} onDownload={download} onDelete={() => void deletePost(post)} onPin={() => void togglePin(post)} onUpdate={(input) => updatePost(post, input)} onComment={(input) => addComment(post, input)} onDeleteComment={(comment) => void deleteComment(post, comment)} />)}
          </section>
        </>}

      {editorOpen === 'settings' && <ProjectEditor project={detail} directory={directory} currentUserId={currentUserId} onClose={() => setEditorOpen(null)} onSave={(input) => saveProject(input, detail.id)} />}
    </div>
  }

  return <div className="content-page project-page">
    <header className="page-header">
      <div><span className="eyebrow">PROJECTS</span><h1>프로젝트</h1><p>프로젝트마다 단계·기간·거래처를 관리하고, 같은 공간에서 글·파일·댓글로 협업합니다. 멤버 권한(소유자·편집·열람)별로 공유됩니다.</p></div>
      <div className="page-header-actions"><Button tone="primary" type="button" onClick={() => setEditorOpen('create')}><Plus size={18} /> 새 프로젝트</Button></div>
    </header>
    <div className="project-toolbar">
      <div className="segmented" role="group" aria-label="프로젝트 상태"><button type="button" className={filter === 'active' ? 'active' : ''} aria-pressed={filter === 'active'} onClick={() => setFilter('active')}>진행 중 {projects.filter((p) => p.status !== 'archived').length}</button><button type="button" className={filter === 'archived' ? 'active' : ''} aria-pressed={filter === 'archived'} onClick={() => setFilter('archived')}>보관 {projects.filter((p) => p.status === 'archived').length}</button></div>
      {categories.length > 1 && <div className="segmented" role="group" aria-label="프로젝트 구분">{categories.map((category) => <button type="button" key={category} className={categoryFilter === category ? 'active' : ''} aria-pressed={categoryFilter === category} onClick={() => setCategoryFilter(category)}>{category}</button>)}</div>}
      {canManage && <span className="project-toolbar-note">관리자는 모든 프로젝트를 볼 수 있습니다. 직원은 참여 중이거나 회사 전체 공개인 프로젝트만 봅니다.</span>}
    </div>
    {loading ? <div className="empty-state compact"><FolderKanban size={26} /><h3>프로젝트를 불러오는 중</h3></div>
      : visibleProjects.length === 0 ? <div className="empty-state"><FolderKanban size={30} /><h3>{filter === 'archived' ? '보관된 프로젝트가 없습니다' : '아직 프로젝트가 없습니다'}</h3><p>신제품 개발, 인증 갱신, 수주 건처럼 함께 일하는 단위로 만들고 멤버를 초대하세요.</p><Button tone="primary" type="button" onClick={() => setEditorOpen('create')}><Plus size={18} /> 첫 프로젝트 만들기</Button></div>
        : <div className="project-grid">
          {visibleProjects.map((project) => <button type="button" className={`project-card${project.status === 'archived' ? ' is-archived' : ''}`} key={project.id} onClick={() => setSelectedId(project.id)}>
            <div className="project-card-head"><span className="project-card-icon"><FolderKanban size={20} /></span><span className="project-card-badges">{project.category && <StatusBadge className="status-pill" tone="info">{project.category}</StatusBadge>}{project.stage && <StatusBadge className="status-pill" dot tone={stageTone(project.stage)}>{project.stage}</StatusBadge>}{project.role && <StatusBadge className="status-pill" tone={roleTone[project.role]}>{roleLabel[project.role]}</StatusBadge>}</span></div>
            <strong>{project.name}</strong>
            <p>{[project.client, project.endDate ? `${formatDateLabel(project.endDate)}까지` : '', money(project.amount)].filter(Boolean).join(' · ') || project.description || '설명 없음'}</p>
            <div className="project-card-meta"><span><Users size={14} /> {project.members.length}명</span><span><MessageCircle size={14} /> 글 {project.postCount}</span><span><Paperclip size={14} /> 파일 {project.fileCount}</span></div>
            <small>{project.visibility === 'company' ? '회사 전체 열람' : '멤버만'} · 최근 {formatDateTime(project.lastActivityAt)}</small>
          </button>)}
        </div>}
    {editorOpen === 'create' && <ProjectEditor directory={directory} currentUserId={currentUserId} currentUserName={currentUserName} onClose={() => setEditorOpen(null)} onSave={(input) => saveProject(input)} />}
  </div>
}

function ProjectEditor({ project, directory, currentUserId, currentUserName, onClose, onSave }: { project?: Project; directory: DirectoryEntry[]; currentUserId: string; currentUserName?: string; onClose: () => void; onSave: (input: Record<string, unknown>) => Promise<boolean> }) {
  const [name, setName] = useState(project?.name ?? '')
  const [description, setDescription] = useState(project?.description ?? '')
  const [visibility, setVisibility] = useState<'members' | 'company'>(project?.visibility ?? 'members')
  const [status, setStatus] = useState<'active' | 'archived'>(project?.status ?? 'active')
  const [stage, setStage] = useState(project?.stage ?? '')
  const [client, setClient] = useState(project?.client ?? '')
  const [link, setLink] = useState(project?.link ?? '')
  const [category, setCategory] = useState(project?.category ?? '')
  const [startDate, setStartDate] = useState(project?.startDate ?? '')
  const [endDate, setEndDate] = useState(project?.endDate ?? '')
  const [amount, setAmount] = useState(project?.amount ?? 0)
  const [members, setMembers] = useState<Array<{ id: string; role: ProjectRole }>>(() => (project?.members ?? []).filter((member) => member.role !== 'owner').map((member) => ({ id: member.id, role: member.role })))
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const ownerId = project?.ownerId ?? currentUserId
  const ownerName = project?.ownerName ?? currentUserName ?? ''
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey) }, [onClose])
  const nameOf = (id: string) => directory.find((entry) => entry.id === id)?.name ?? project?.members.find((member) => member.id === id)?.name ?? id
  const memberRole = (id: string) => members.find((member) => member.id === id)?.role ?? null
  // 회사 구성원 전체 목록 — 검색은 필터일 뿐, 항상 모두 보이고 눌러서 넣고 뺀다.
  const normalizedQuery = query.trim().toLowerCase()
  const roster = directory
    .filter((entry) => entry.id !== ownerId)
    .filter((entry) => !normalizedQuery || `${entry.name} ${entry.team} ${entry.jobRole}`.toLowerCase().includes(normalizedQuery))
    .sort((left, right) => Number(Boolean(memberRole(right.id))) - Number(Boolean(memberRole(left.id))) || (left.team || '').localeCompare(right.team || '', 'ko') || left.name.localeCompare(right.name, 'ko'))
  const toggleMember = (id: string) => setMembers((current) => current.some((member) => member.id === id) ? current.filter((member) => member.id !== id) : [...current, { id, role: 'editor' }])
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="modal-card project-editor" role="dialog" aria-modal="true" aria-labelledby="project-editor-title">
      <header><div><span className="eyebrow">{project ? 'PROJECT SETTINGS' : 'NEW PROJECT'}</span><h2 id="project-editor-title">{project ? '멤버 · 설정' : '새 프로젝트'}</h2><p>{project ? '멤버 권한·관리 정보·공개 범위를 바꿉니다.' : '이름만 정하면 시작됩니다. 멤버·관리 정보는 나중에도 바꿀 수 있습니다.'}</p></div><IconButton tone="ghost" type="button" aria-label="닫기" onClick={onClose}><X size={21} /></IconButton></header>
      <form onSubmit={async (event: FormEvent) => { event.preventDefault(); if (name.trim().length < 2) return; setBusy(true); const ok = await onSave({ name: name.trim(), description: description.trim(), visibility, members, stage, client: client.trim(), startDate, endDate, amount, link: link.trim(), category: category.trim(), ...(project ? { status } : {}) }); setBusy(false); if (ok) onClose() }}>
        <label className="form-field full"><span>프로젝트 이름 <em>필수</em></span><input value={name} onChange={(event) => setName(event.target.value)} autoFocus required minLength={2} maxLength={80} placeholder="예: 한국도로공사 시뮬레이션" /></label>
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
          <label className="form-field"><span>시작일</span><input type="date" value={startDate} max={endDate || undefined} onChange={(event) => setStartDate(event.target.value)} /></label>
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
              return <li key={entry.id} className={currentRole ? 'is-member' : ''}>
                <i className={`project-avatar role-${currentRole ?? 'viewer'}`}>{entry.name.slice(0, 1)}</i>
                <div><span>{entry.name}</span><small>{[entry.team, entry.jobRole].filter(Boolean).join(' · ') || '소속 미지정'}</small></div>
                {currentRole && <select value={currentRole} aria-label={`${entry.name} 권한`} onClick={(event) => event.stopPropagation()} onChange={(event) => setMembers((current) => current.map((member) => member.id === entry.id ? { ...member, role: event.target.value as ProjectRole } : member))}><option value="editor">편집</option><option value="viewer">열람</option></select>}
                <button type="button" className={currentRole ? 'project-roster-remove' : 'project-roster-add'} onClick={() => toggleMember(entry.id)}>{currentRole ? <><X size={14} /> 제외</> : <><Plus size={14} /> 추가</>}</button>
              </li>
            })}
            {roster.length === 0 && <li className="project-roster-empty">일치하는 구성원이 없습니다.</li>}
          </ul>
          <p className="project-member-hint">편집: 글·파일 올리기 가능 · 열람: 보기와 댓글만 · 회사 전체 공개여도 글쓰기는 멤버만 가능합니다.</p>
        </div>
        <footer><Button tone="ghost" type="button" onClick={onClose} disabled={busy}>취소</Button><Button tone="primary" type="submit" disabled={busy || name.trim().length < 2}>{busy ? '저장 중…' : project ? '설정 저장' : '프로젝트 만들기'}</Button></footer>
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

function PostForm({ workspaceScope, projectName, initial, submitLabel, busyLabel, onToast, onCancel, onSubmit }: {
  workspaceScope?: string; projectName: string
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
    try { const added = await uploadDocumentAttachments(files, { workspaceScope, category: '프로젝트', summary: `${projectName} 프로젝트 게시글 첨부`, tags: ['프로젝트', projectName] }); setAttachments((current) => [...current, ...added]) }
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

function PostComposer(props: { workspaceScope?: string; projectName: string; onToast: (message: string) => void; onClose: () => void; onSubmit: (input: { title: string; body: string; attachments: StoredDocumentAttachment[] }) => Promise<boolean> }) {
  return <section className="panel project-composer" aria-label="새 글 작성">
    <div className="project-composer-head"><strong><Pencil size={15} /> 새 글 · 파일</strong><IconButton tone="ghost" type="button" aria-label="닫기" onClick={props.onClose}><X size={17} /></IconButton></div>
    <PostForm workspaceScope={props.workspaceScope} projectName={props.projectName} submitLabel="올리기" busyLabel="올리는 중…" onToast={props.onToast} onCancel={props.onClose} onSubmit={props.onSubmit} />
  </section>
}

function PostCard({ post, currentUserId, isOwner, canComment, workspaceScope, onToast, onDownload, onDelete, onPin, onUpdate, onComment, onDeleteComment }: {
  post: ProjectPost; currentUserId: string; isOwner: boolean; canComment: boolean; workspaceScope?: string; onToast: (message: string) => void
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
    try { const added = await uploadDocumentAttachments(files, { workspaceScope, category: '프로젝트', summary: `${post.title} 댓글 첨부`, tags: ['프로젝트', '댓글'] }); setAttachments((current) => [...current, ...added]) }
    catch (reason) { onToast(reason instanceof Error ? reason.message : '파일을 업로드하지 못했습니다.') }
    finally { setUploading(false) }
  }
  if (editing) {
    return <article className="project-post is-editing">
      <div className="project-composer-head"><strong><Pencil size={15} /> 글 수정</strong></div>
      <PostForm workspaceScope={workspaceScope} projectName={post.title} initial={{ title: post.title, body: post.body, attachments: post.attachments }} submitLabel="수정 저장" busyLabel="저장 중…" onToast={onToast} onCancel={() => setEditing(false)} onSubmit={async (input) => { const ok = await onUpdate(input); if (ok) setEditing(false); return ok }} />
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
        <i className="project-avatar role-viewer">{comment.author.slice(0, 1)}</i>
        <div><span className="project-comment-head"><strong>{comment.author}</strong><time dateTime={comment.createdAt}>{formatDateTime(comment.createdAt)}</time>{(comment.authorId === currentUserId || isOwner) && <button type="button" aria-label="댓글 삭제" onClick={() => onDeleteComment(comment)}><X size={13} /></button>}</span>{comment.text && <p>{comment.text}</p>}{comment.attachments.length > 0 && <span className="project-comment-files">{comment.attachments.map((attachment) => <button type="button" key={attachment.id} onClick={() => onDownload(attachment)}><Download size={12} /> {attachment.name}</button>)}</span>}</div>
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

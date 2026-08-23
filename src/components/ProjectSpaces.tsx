import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, Download, FolderKanban, Lock, MessageCircle, Paperclip, Pencil, Pin, Plus, Send, Settings2, Trash2, Upload, Users, X } from 'lucide-react'
import { formatDateTime } from '../utils/dateTime'
import { downloadDocumentAttachment, uploadDocumentAttachments, type StoredDocumentAttachment } from '../utils/documentAttachments'
import { StatusBadge, type StatusBadgeTone } from './StatusBadge'
import './ProjectSpaces.css'

type ProjectRole = 'owner' | 'editor' | 'viewer'
type ProjectMember = { id: string; name: string; team?: string; role: ProjectRole }
type Project = {
  id: string
  name: string
  description: string
  visibility: 'members' | 'company'
  status: 'active' | 'archived'
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
  useEffect(() => { if (selectedId) void loadDetail(selectedId) }, [selectedId, loadDetail])

  const visibleProjects = projects.filter((project) => filter === 'archived' ? project.status === 'archived' : project.status !== 'archived')
  const role = detail?.role ?? null
  const canPost = role === 'owner' || role === 'editor'
  const isOwner = role === 'owner'

  const saveProject = async (input: { name: string; description: string; visibility: 'members' | 'company'; members: Array<{ id: string; role: ProjectRole }>; status?: 'active' | 'archived' }, projectId?: string) => {
    const response = await fetch(projectId ? `/api/projects/${encodeURIComponent(projectId)}` : '/api/projects', { method: projectId ? 'PATCH' : 'POST', headers, body: JSON.stringify(input) })
    const body = await readJson<{ project?: Project }>(response)
    if (!response.ok || !body.project) { onToast(body.error?.message || '프로젝트를 저장하지 못했습니다.'); return false }
    onToast(projectId ? '프로젝트 설정을 저장했습니다.' : `‘${body.project.name}’ 프로젝트 공간을 만들었습니다.`)
    await loadProjects(true)
    if (projectId) setDetail(body.project); else setSelectedId(body.project.id)
    setEditorOpen(null)
    return true
  }

  const deleteProject = async () => {
    if (!detail || !window.confirm(`‘${detail.name}’ 프로젝트 공간을 삭제할까요? 글·댓글 기록이 함께 삭제됩니다. 기록을 남기려면 대신 '보관'을 선택하세요.`)) return
    const response = await fetch(`/api/projects/${encodeURIComponent(detail.id)}`, { method: 'DELETE', headers })
    const body = await readJson<{ ok?: boolean }>(response)
    if (!response.ok) { onToast(body.error?.message || '프로젝트를 삭제하지 못했습니다.'); return }
    onToast('프로젝트 공간을 삭제했습니다.')
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
    return <div className="content-page project-page">
      <header className="page-header project-detail-header">
        <div>
          <button type="button" className="project-back" onClick={() => { setSelectedId(null); setDetail(null); void loadProjects(true) }}><ArrowLeft size={16} /> 프로젝트 목록</button>
          <h1>{detail.name} {detail.status === 'archived' && <StatusBadge className="status-pill" tone="neutral">보관됨</StatusBadge>}</h1>
          <p>{detail.description || '설명이 없습니다.'}</p>
          <div className="project-meta">
            <span className="project-members" title={detail.members.map((member) => `${member.name} (${roleLabel[member.role]})`).join(', ')}><Users size={15} /> {detail.members.slice(0, 6).map((member) => <i key={member.id} className={`project-avatar role-${member.role}`}>{member.name.slice(0, 1)}</i>)}{detail.members.length > 6 && <em>+{detail.members.length - 6}</em>} {detail.members.length}명</span>
            <span>{detail.visibility === 'company' ? <><Users size={14} /> 회사 전체 열람</> : <><Lock size={14} /> 멤버만</>}</span>
            <span>글 {detail.postCount} · 파일 {detail.fileCount}</span>
            {role && <StatusBadge className="status-pill" tone={roleTone[role]}>내 권한 · {roleLabel[role]}</StatusBadge>}
          </div>
        </div>
        <div className="page-header-actions">
          {isOwner && <button className="button secondary" type="button" onClick={() => setEditorOpen('settings')}><Settings2 size={17} /> 멤버·설정</button>}
          {isOwner && <button className="button ghost project-delete" type="button" onClick={() => void deleteProject()}><Trash2 size={16} /> 삭제</button>}
          {canPost && detail.status !== 'archived' && <button className="button primary" type="button" onClick={() => setComposerOpen(true)}><Plus size={18} /> 글 · 파일 올리기</button>}
        </div>
      </header>

      {composerOpen && <PostComposer workspaceScope={workspaceScope} projectName={detail.name} onToast={onToast} onClose={() => setComposerOpen(false)} onSubmit={createPost} />}

      <section className="project-feed">
        {posts.length === 0 && <div className="empty-state compact"><FolderKanban size={28} /><h3>아직 올린 글이 없습니다</h3><p>{canPost ? '회의록·자료·진행 상황을 글이나 파일로 올려 멤버와 공유하세요.' : '편집 권한이 있는 멤버가 글을 올리면 여기에 표시됩니다.'}</p></div>}
        {posts.map((post) => <PostCard key={post.id} post={post} currentUserId={currentUserId} isOwner={isOwner} canComment={Boolean(role)} workspaceScope={workspaceScope} onToast={onToast} onDownload={download} onDelete={() => void deletePost(post)} onPin={() => void togglePin(post)} onComment={(input) => addComment(post, input)} onDeleteComment={(comment) => void deleteComment(post, comment)} />)}
      </section>

      {editorOpen === 'settings' && <ProjectEditor project={detail} directory={directory} currentUserId={currentUserId} onClose={() => setEditorOpen(null)} onSave={(input) => saveProject(input, detail.id)} />}
    </div>
  }

  return <div className="content-page project-page">
    <header className="page-header">
      <div><span className="eyebrow">PROJECT SPACES</span><h1>프로젝트 공간</h1><p>프로젝트 단위로 글과 파일을 올리고, 댓글로 논의하고, 멤버 권한(소유자·편집·열람)별로 공유합니다.</p></div>
      <div className="page-header-actions"><button className="button primary" type="button" onClick={() => setEditorOpen('create')}><Plus size={18} /> 새 프로젝트 공간</button></div>
    </header>
    <div className="project-toolbar">
      <div className="segmented" role="group" aria-label="프로젝트 상태"><button type="button" className={filter === 'active' ? 'active' : ''} aria-pressed={filter === 'active'} onClick={() => setFilter('active')}>진행 중 {projects.filter((p) => p.status !== 'archived').length}</button><button type="button" className={filter === 'archived' ? 'active' : ''} aria-pressed={filter === 'archived'} onClick={() => setFilter('archived')}>보관 {projects.filter((p) => p.status === 'archived').length}</button></div>
      {canManage && <span className="project-toolbar-note">관리자는 모든 프로젝트를 볼 수 있습니다. 직원은 참여 중이거나 회사 전체 공개인 프로젝트만 봅니다.</span>}
    </div>
    {loading ? <div className="empty-state compact"><FolderKanban size={26} /><h3>프로젝트를 불러오는 중</h3></div>
      : visibleProjects.length === 0 ? <div className="empty-state"><FolderKanban size={30} /><h3>{filter === 'archived' ? '보관된 프로젝트가 없습니다' : '아직 프로젝트 공간이 없습니다'}</h3><p>신제품 개발, 인증 갱신, 설비 교체처럼 함께 일하는 단위로 공간을 만들고 멤버를 초대하세요.</p><button className="button primary" type="button" onClick={() => setEditorOpen('create')}><Plus size={18} /> 첫 프로젝트 만들기</button></div>
        : <div className="project-grid">
          {visibleProjects.map((project) => <button type="button" className={`project-card${project.status === 'archived' ? ' is-archived' : ''}`} key={project.id} onClick={() => setSelectedId(project.id)}>
            <div className="project-card-head"><span className="project-card-icon"><FolderKanban size={20} /></span>{project.role && <StatusBadge className="status-pill" tone={roleTone[project.role]}>{roleLabel[project.role]}</StatusBadge>}</div>
            <strong>{project.name}</strong>
            <p>{project.description || '설명 없음'}</p>
            <div className="project-card-meta"><span><Users size={14} /> {project.members.length}명</span><span><MessageCircle size={14} /> 글 {project.postCount}</span><span><Paperclip size={14} /> 파일 {project.fileCount}</span></div>
            <small>{project.visibility === 'company' ? '회사 전체 열람' : '멤버만'} · 최근 {formatDateTime(project.lastActivityAt)}</small>
          </button>)}
        </div>}
    {editorOpen === 'create' && <ProjectEditor directory={directory} currentUserId={currentUserId} currentUserName={currentUserName} onClose={() => setEditorOpen(null)} onSave={(input) => saveProject(input)} />}
  </div>
}

function ProjectEditor({ project, directory, currentUserId, currentUserName, onClose, onSave }: { project?: Project; directory: DirectoryEntry[]; currentUserId: string; currentUserName?: string; onClose: () => void; onSave: (input: { name: string; description: string; visibility: 'members' | 'company'; members: Array<{ id: string; role: ProjectRole }>; status?: 'active' | 'archived' }) => Promise<boolean> }) {
  const [name, setName] = useState(project?.name ?? '')
  const [description, setDescription] = useState(project?.description ?? '')
  const [visibility, setVisibility] = useState<'members' | 'company'>(project?.visibility ?? 'members')
  const [status, setStatus] = useState<'active' | 'archived'>(project?.status ?? 'active')
  const [members, setMembers] = useState<Array<{ id: string; role: ProjectRole }>>(() => (project?.members ?? []).filter((member) => member.role !== 'owner').map((member) => ({ id: member.id, role: member.role })))
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const ownerId = project?.ownerId ?? currentUserId
  const ownerName = project?.ownerName ?? currentUserName ?? ''
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey) }, [onClose])
  const candidates = directory.filter((entry) => entry.id !== ownerId && !members.some((member) => member.id === entry.id) && (!query.trim() || `${entry.name} ${entry.team} ${entry.jobRole}`.toLowerCase().includes(query.trim().toLowerCase())))
  const nameOf = (id: string) => directory.find((entry) => entry.id === id)?.name ?? project?.members.find((member) => member.id === id)?.name ?? id
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="modal-card project-editor" role="dialog" aria-modal="true" aria-labelledby="project-editor-title">
      <header><div><span className="eyebrow">{project ? 'PROJECT SETTINGS' : 'NEW PROJECT'}</span><h2 id="project-editor-title">{project ? '멤버 · 설정' : '새 프로젝트 공간'}</h2><p>{project ? '멤버 권한과 공개 범위를 바꿉니다.' : '함께 일할 멤버를 초대하고 권한을 정하세요.'}</p></div><button className="icon-button" type="button" aria-label="닫기" onClick={onClose}><X size={21} /></button></header>
      <form onSubmit={async (event: FormEvent) => { event.preventDefault(); if (name.trim().length < 2) return; setBusy(true); const ok = await onSave({ name: name.trim(), description: description.trim(), visibility, members, ...(project ? { status } : {}) }); setBusy(false); if (ok) onClose() }}>
        <label className="form-field full"><span>프로젝트 이름</span><input value={name} onChange={(event) => setName(event.target.value)} autoFocus required minLength={2} maxLength={80} placeholder="예: 2026 HACCP 갱신" /></label>
        <label className="form-field full"><span>설명 <em>선택</em></span><textarea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} placeholder="무엇을 위한 공간인지 한두 줄로" /></label>
        <div className="form-grid">
          <label className="form-field"><span>공개 범위</span><select value={visibility} onChange={(event) => setVisibility(event.target.value as 'members' | 'company')}><option value="members">멤버만 (초대된 사람)</option><option value="company">회사 전체 열람 (글쓰기는 멤버만)</option></select></label>
          {project && <label className="form-field"><span>상태</span><select value={status} onChange={(event) => setStatus(event.target.value as 'active' | 'archived')}><option value="active">진행 중</option><option value="archived">보관 (읽기 전용)</option></select></label>}
        </div>
        <div className="project-member-editor">
          <div className="project-member-head"><strong><Users size={16} /> 멤버 {members.length + 1}명</strong><span>소유자: {ownerName || nameOf(ownerId)}</span></div>
          <ul className="project-member-list">
            <li><i className="project-avatar role-owner">{(ownerName || nameOf(ownerId)).slice(0, 1)}</i><span>{ownerName || nameOf(ownerId)}</span><em>소유자</em></li>
            {members.map((member) => <li key={member.id}><i className={`project-avatar role-${member.role}`}>{nameOf(member.id).slice(0, 1)}</i><span>{nameOf(member.id)}</span><select value={member.role} aria-label={`${nameOf(member.id)} 권한`} onChange={(event) => setMembers((current) => current.map((item) => item.id === member.id ? { ...item, role: event.target.value as ProjectRole } : item))}><option value="editor">편집 (글·파일 올리기)</option><option value="viewer">열람 (보기·댓글)</option></select><button type="button" aria-label={`${nameOf(member.id)} 제외`} onClick={() => setMembers((current) => current.filter((item) => item.id !== member.id))}><X size={15} /></button></li>)}
          </ul>
          <label className="project-member-search"><span className="sr-only">멤버 검색</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="이름·부서로 검색해 멤버 추가" /></label>
          {query.trim() && <div className="project-member-candidates">{candidates.slice(0, 8).map((entry) => <button type="button" key={entry.id} onClick={() => { setMembers((current) => [...current, { id: entry.id, role: 'editor' }]); setQuery('') }}><i className="project-avatar role-editor">{entry.name.slice(0, 1)}</i><span>{entry.name}</span><small>{entry.team} · {entry.jobRole}</small><Plus size={15} /></button>)}{candidates.length === 0 && <small className="project-member-empty">일치하는 구성원이 없습니다.</small>}</div>}
        </div>
        <footer><button type="button" className="button ghost" onClick={onClose} disabled={busy}>취소</button><button type="submit" className="button primary" disabled={busy || name.trim().length < 2}>{busy ? '저장 중…' : project ? '설정 저장' : '프로젝트 만들기'}</button></footer>
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

function PostComposer({ workspaceScope, projectName, onToast, onClose, onSubmit }: { workspaceScope?: string; projectName: string; onToast: (message: string) => void; onClose: () => void; onSubmit: (input: { title: string; body: string; attachments: StoredDocumentAttachment[] }) => Promise<boolean> }) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [attachments, setAttachments] = useState<StoredDocumentAttachment[]>([])
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const pick = async (files: File[]) => {
    setUploading(true)
    try { const added = await uploadDocumentAttachments(files, { workspaceScope, category: '프로젝트', summary: `${projectName} 프로젝트 게시글 첨부`, tags: ['프로젝트', projectName] }); setAttachments((current) => [...current, ...added]) }
    catch (reason) { onToast(reason instanceof Error ? reason.message : '파일을 업로드하지 못했습니다.') }
    finally { setUploading(false) }
  }
  return <section className="panel project-composer" aria-label="새 글 작성">
    <div className="project-composer-head"><strong><Pencil size={16} /> 새 글 · 파일</strong><button type="button" className="icon-button" aria-label="닫기" onClick={onClose}><X size={18} /></button></div>
    <label className="form-field full"><span className="sr-only">제목</span><input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} placeholder="제목 (비우면 첫 줄이 제목이 됩니다)" autoFocus /></label>
    <label className="form-field full"><span className="sr-only">내용</span><textarea rows={4} value={body} onChange={(event) => setBody(event.target.value)} maxLength={8000} placeholder="내용을 적거나 파일만 올려도 됩니다." /></label>
    <AttachmentPicker attachments={attachments} busy={uploading} onPick={(files) => void pick(files)} onRemove={(attachment) => setAttachments((current) => current.filter((item) => item.id !== attachment.id))} />
    <footer><button type="button" className="button ghost" onClick={onClose} disabled={busy}>취소</button><button type="button" className="button primary" disabled={busy || uploading || (!title.trim() && !body.trim() && attachments.length === 0)} onClick={async () => { setBusy(true); const ok = await onSubmit({ title: title.trim(), body: body.trim(), attachments }); setBusy(false); if (ok) { setTitle(''); setBody(''); setAttachments([]) } }}><Send size={16} /> {busy ? '올리는 중…' : '올리기'}</button></footer>
  </section>
}

function PostCard({ post, currentUserId, isOwner, canComment, workspaceScope, onToast, onDownload, onDelete, onPin, onComment, onDeleteComment }: {
  post: ProjectPost; currentUserId: string; isOwner: boolean; canComment: boolean; workspaceScope?: string; onToast: (message: string) => void
  onDownload: (attachment: StoredDocumentAttachment) => void; onDelete: () => void; onPin: () => void
  onComment: (input: { text: string; attachments: StoredDocumentAttachment[] }) => Promise<boolean>; onDeleteComment: (comment: ProjectComment) => void
}) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<StoredDocumentAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [showComposer, setShowComposer] = useState(false)
  const mine = post.authorId === currentUserId
  const pick = async (files: File[]) => {
    setUploading(true)
    try { const added = await uploadDocumentAttachments(files, { workspaceScope, category: '프로젝트', summary: `${post.title} 댓글 첨부`, tags: ['프로젝트', '댓글'] }); setAttachments((current) => [...current, ...added]) }
    catch (reason) { onToast(reason instanceof Error ? reason.message : '파일을 업로드하지 못했습니다.') }
    finally { setUploading(false) }
  }
  return <article className={`project-post${post.pinned ? ' is-pinned' : ''}`}>
    <header>
      <i className="project-avatar role-editor">{post.author.slice(0, 1)}</i>
      <div><strong>{post.title}</strong><small>{post.author} · {formatDateTime(post.createdAt)}{post.pinned && <em className="project-pin-label"><Pin size={12} /> 고정</em>}</small></div>
      <div className="project-post-actions">
        {isOwner && <button type="button" aria-label={post.pinned ? '고정 해제' : '상단 고정'} title={post.pinned ? '고정 해제' : '상단 고정'} onClick={onPin}><Pin size={15} /></button>}
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
      {canComment && (showComposer || post.comments.length === 0
        ? <form className="project-comment-composer" onSubmit={async (event) => { event.preventDefault(); if (!text.trim() && attachments.length === 0) return; setBusy(true); const ok = await onComment({ text: text.trim(), attachments }); setBusy(false); if (ok) { setText(''); setAttachments([]); setShowComposer(false) } }}>
          <textarea rows={2} value={text} onChange={(event) => setText(event.target.value)} maxLength={2000} placeholder="댓글을 남기거나 파일을 첨부하세요" />
          <div className="project-comment-composer-tools">
            <AttachmentPicker attachments={attachments} busy={uploading} label="파일" onPick={(files) => void pick(files)} onRemove={(attachment) => setAttachments((current) => current.filter((item) => item.id !== attachment.id))} />
            <button type="submit" className="button primary small" disabled={busy || uploading || (!text.trim() && attachments.length === 0)}><MessageCircle size={14} /> {busy ? '남기는 중…' : '댓글'}</button>
          </div>
        </form>
        : <button type="button" className="project-comment-open" onClick={() => setShowComposer(true)}><MessageCircle size={14} /> 댓글 남기기 ({post.comments.length})</button>)}
    </div>
  </article>
}


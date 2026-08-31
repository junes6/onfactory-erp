import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Bot, CheckCircle2, Cloud, Database, Download, FileArchive, FileText, FolderSearch, HardDrive, LockKeyhole, Pencil, Plus, Search, Server, Sparkles, Trash2, Upload, Users, X } from 'lucide-react'
import { useWorkspaceState } from '../hooks/useWorkspaceState'
import { librarySearchPlaceholderForIndustry } from '../modules/registry'
import './CompanyLibrary.css'
import { Button } from './ui/Button'
import { BRAND } from '../brand'
import type { LensTarget } from './LensPanel'
import { canRunLensOn } from '../utils/documentLenses'
import { useIndustrySurface } from '../modules/IndustryContext'

type DocumentVisibility = 'all' | 'department' | 'restricted'
type CompanyDocument = {
  id: string
  name: string
  mime: string
  size: number
  category: string
  visibility: DocumentVisibility
  departments: string[]
  allowedUserIds: string[]
  tags: string[]
  summary: string
  uploadedAt: string
  uploadedById: string
  uploadedByName: string
  storage: 'local' | 'nas'
}
type NasSettings = {
  provider: 'webdav' | 'smb' | 's3'
  endpoint: string
  share: string
  basePath: string
  account: string
  status: '설정 필요' | '연결 준비됨'
  verifiedAt?: string
}

const initialNas: NasSettings = { provider: 'webdav', endpoint: '', share: '', basePath: BRAND.nasBasePath, account: '', status: '설정 필요' }
function validNas(value: unknown): value is NasSettings { return Boolean(value && typeof value === 'object' && typeof (value as NasSettings).provider === 'string' && typeof (value as NasSettings).endpoint === 'string') }
function humanSize(size: number) { return size === 0 ? '0 KB' : size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB` }

function libraryFetch(path: string, workspaceScope?: string, init: RequestInit = {}) {
  return fetch(path, { ...init, headers: { ...(init.headers ?? {}), ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}) } })
}

function useLibraryModal(onClose: () => void) {
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
      const items = focusables(); if (!items.length) return
      const first = items[0]; const last = items.at(-1)!
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    dialog.addEventListener('keydown', keydown)
    return () => { dialog.removeEventListener('keydown', keydown); previous?.focus() }
  }, [])
  return ref
}

function DocumentModal({ document, workspaceScope, onClose, onSaved }: { document?: CompanyDocument; workspaceScope?: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const industry = useIndustrySurface()
  const dialogRef = useLibraryModal(onClose)
  const fileRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <div className="library-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={dialogRef} className="library-modal" role="dialog" aria-modal="true" aria-labelledby="library-modal-title">
      <header><div><span>SECURE DOCUMENT</span><h2 id="library-modal-title">{document ? '자료 정보·권한 수정' : '기업 자료 업로드'}</h2><p>파일과 검색용 설명, 열람 범위를 함께 저장합니다.</p></div><button type="button" aria-label="닫기" onClick={onClose}><X size={20} /></button></header>
      <form onSubmit={async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault(); setError('')
        const form = new FormData(event.currentTarget)
        const metadata = {
          name: String(form.get('name')).trim(), category: String(form.get('category')),
          visibility: String(form.get('visibility')), departments: String(form.get('departments')).split(',').map((item) => item.trim()).filter(Boolean),
          allowedUserIds: String(form.get('allowedUserIds')).split(',').map((item) => item.trim()).filter(Boolean),
          tags: String(form.get('tags')).split(',').map((item) => item.trim()).filter(Boolean), summary: String(form.get('summary')).trim(),
          storage: String(form.get('storage')),
        }
        setBusy(true)
        try {
          let response: Response
          if (document) {
            response = await libraryFetch(`/api/documents/${encodeURIComponent(document.id)}`, workspaceScope, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(metadata) })
          } else {
            if (!file) throw new Error('업로드할 파일을 선택해 주세요.')
            if (file.size > 10 * 1024 * 1024) throw new Error('한 파일은 10MB까지 업로드할 수 있습니다.')
            const params = new URLSearchParams({ ...metadata, departments: metadata.departments.join(','), allowedUserIds: metadata.allowedUserIds.join(','), tags: metadata.tags.join(',') })
            response = await libraryFetch(`/api/documents?${params}`, workspaceScope, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name), 'x-file-type': file.type || 'application/octet-stream' }, body: file })
          }
          const body = await response.json() as { error?: { message?: string } }
          if (!response.ok) throw new Error(body.error?.message || '자료를 저장하지 못했습니다.')
          await onSaved(); onClose()
        } catch (reason) { setError(reason instanceof Error ? reason.message : '자료를 저장하지 못했습니다.'); setBusy(false) }
      }}>
        {!document && <section className="library-dropzone"><input ref={fileRef} className="sr-only" type="file" onChange={(event) => { const selected = event.target.files?.[0] ?? null; setFile(selected); if (selected) { const nameInput = event.currentTarget.form?.elements.namedItem('name') as HTMLInputElement | null; if (nameInput && !nameInput.value) nameInput.value = selected.name } }} /><Upload size={26} /><div><strong>{file?.name ?? '파일을 선택해 주세요'}</strong><span>{file ? humanSize(file.size) : 'PDF, 문서, 이미지, 압축파일 · 최대 10MB'}</span></div><Button tone="secondary" type="button" onClick={() => fileRef.current?.click()}>파일 선택</Button></section>}
        <div className="library-form-grid">
          <label className="full"><span>자료 이름</span><input name="name" defaultValue={document?.name} required autoFocus={Boolean(document)} /></label>
          <label><span>분류</span><select name="category" defaultValue={document?.category ?? '공통자료'}>{industry.documentCategories.map((category) => <option key={category}>{category}</option>)}{document?.category && !industry.documentCategories.includes(document.category) && <option>{document.category}</option>}</select></label>
          <label><span>저장 위치</span><select name="storage" defaultValue={document?.storage ?? 'local'}><option value="local">{BRAND.storageLabel}</option><option value="nas" disabled>NAS 동기화 · 자격증명 연결 후 사용</option></select></label>
          <label><span>열람 권한</span><select name="visibility" defaultValue={document?.visibility ?? 'all'}><option value="all">전 직원</option><option value="department">지정 부서</option><option value="restricted">지정 계정</option></select></label>
          <label><span>허용 부서 · 쉼표 구분</span><input name="departments" defaultValue={document?.departments.join(', ')} placeholder={industry.examples.departments} /></label>
          <label className="full"><span>허용 계정 ID · 제한자료일 때</span><input name="allowedUserIds" defaultValue={document?.allowedUserIds.join(', ')} placeholder="예: 회사 구성원 계정 ID" /></label>
          <label className="full"><span>AI 검색 태그 · 쉼표 구분</span><input name="tags" defaultValue={document?.tags.join(', ')} placeholder={industry.examples.libraryTags} /></label>
          <label className="full"><span>자료 요약</span><textarea name="summary" rows={4} defaultValue={document?.summary} placeholder="AI가 파일을 찾고 설명할 때 사용할 핵심 내용을 적어 주세요." required /></label>
        </div>
        {error && <p className="library-error" role="alert">{error}</p>}
        <footer><Button tone="ghost" type="button" onClick={onClose}>취소</Button><Button tone="primary" type="submit" disabled={busy}><CheckCircle2 size={18} /> {busy ? '저장 중…' : document ? '변경사항 저장' : '안전하게 업로드'}</Button></footer>
      </form>
    </section>
  </div>
}

function NasModal({ settings, onClose, onSave }: { settings: NasSettings; onClose: () => void; onSave: (settings: NasSettings) => Promise<boolean> }) {
  const dialogRef = useLibraryModal(onClose)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  return <div className="library-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section ref={dialogRef} className="library-modal nas-modal" role="dialog" aria-modal="true" aria-labelledby="nas-modal-title"><header><div><span>EXTERNAL STORAGE</span><h2 id="nas-modal-title">회사 NAS 연결 준비</h2><p>서버 주소와 기본 폴더만 보관하며 비밀번호·접근키는 브라우저에 저장하지 않습니다.</p></div><button type="button" aria-label="닫기" onClick={onClose}><X size={20} /></button></header><form onSubmit={async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); const endpoint = String(form.get('endpoint')).trim(); if (!endpoint) { setMessage('NAS 주소를 입력해 주세요.'); return } const next: NasSettings = { provider: String(form.get('provider')) as NasSettings['provider'], endpoint, share: String(form.get('share')).trim(), basePath: String(form.get('basePath')).trim(), account: String(form.get('account')).trim(), status: '연결 준비됨', verifiedAt: new Date().toISOString() }; setBusy(true); if (await onSave(next)) onClose(); else { setBusy(false); setMessage('설정을 저장하지 못했습니다.') } }}><div className="library-form-grid"><label><span>연결 방식</span><select name="provider" defaultValue={settings.provider}><option value="webdav">WebDAV · 권장</option><option value="smb">SMB · 사내 에이전트</option><option value="s3">S3 호환 스토리지</option></select></label><label><span>서버·엔드포인트</span><input name="endpoint" defaultValue={settings.endpoint} placeholder="https://nas.company.co.kr:5006" required autoFocus /></label><label><span>공유 이름·버킷</span><input name="share" defaultValue={settings.share} placeholder="company-data" /></label><label><span>기본 폴더</span><input name="basePath" defaultValue={settings.basePath} placeholder={BRAND.nasBasePath} /></label><label className="full"><span>연결 계정명</span><input name="account" defaultValue={settings.account} autoComplete="off" placeholder="inthefield-service" /></label></div><div className="nas-security-note"><LockKeyhole size={19} /><div><strong>자격증명 분리 원칙</strong><p>비밀번호와 접근키는 운영 배포 시 환경변수 또는 Secret Vault에 등록해야 실제 동기화가 켜집니다. 여기서는 연결 위치와 권한 구조만 준비합니다.</p></div></div>{message && <p className="library-error">{message}</p>}<footer><Button tone="ghost" type="button" onClick={onClose}>취소</Button><Button tone="primary" type="submit" disabled={busy}><Server size={18} /> 연결 설정 저장</Button></footer></form></section></div>
}

export function CompanyLibrary({ workspaceScope, canManage, currentUserId, companyName, industryType = 'food_manufacturing', onAskLens, onToast }: { workspaceScope?: string; canManage: boolean; currentUserId: string; companyName: string; industryType?: string; onAskLens?: (target: LensTarget) => void; onToast: (message: string) => void }) {
  const [documents, setDocuments] = useState<CompanyDocument[]>([])
  const [nas, setNas] = useWorkspaceState<NasSettings>('document-storage-settings', initialNas, { enabled: canManage, scope: workspaceScope, seedWhenEmpty: canManage, validate: validNas })
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('전체')
  const [editing, setEditing] = useState<CompanyDocument | 'new' | null>(null)
  const [nasOpen, setNasOpen] = useState(false)
  const [aiQuery, setAiQuery] = useState('')
  const [aiAnswer, setAiAnswer] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const load = async () => {
    setLoading(true)
    try { const response = await libraryFetch('/api/documents', workspaceScope); const body = await response.json() as { documents?: CompanyDocument[]; error?: { message?: string } }; if (!response.ok) throw new Error(body.error?.message); setDocuments(body.documents ?? []) }
    catch (error) { onToast(error instanceof Error && error.message ? error.message : '기업 자료를 불러오지 못했습니다.') }
    finally { setLoading(false) }
  }
  useEffect(() => { if (workspaceScope) void load() }, [workspaceScope]) // eslint-disable-line react-hooks/exhaustive-deps
  const categories = ['전체', ...new Set(documents.map((item) => item.category))]
  const visible = useMemo(() => documents.filter((document) => (category === '전체' || document.category === category) && `${document.name} ${document.summary} ${document.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase().trim())), [category, documents, query])
  const download = async (document: CompanyDocument) => {
    try { const response = await libraryFetch(`/api/documents/${encodeURIComponent(document.id)}/download`, workspaceScope); if (!response.ok) { const body = await response.json() as { error?: { message?: string } }; throw new Error(body.error?.message) } const blob = await response.blob(); const url = URL.createObjectURL(blob); const anchor = window.document.createElement('a'); anchor.href = url; anchor.download = document.name; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); onToast(`${document.name} 다운로드를 시작했습니다.`) } catch (error) { onToast(error instanceof Error && error.message ? error.message : '파일을 다운로드하지 못했습니다.') }
  }
  const remove = async (document: CompanyDocument) => {
    if (!window.confirm(`${document.name} 파일을 자료실에서 삭제할까요? 이 작업은 되돌릴 수 없습니다.`)) return
    const response = await libraryFetch(`/api/documents/${encodeURIComponent(document.id)}`, workspaceScope, { method: 'DELETE' })
    const body = await response.json() as { error?: { message?: string } }
    if (!response.ok) { onToast(body.error?.message || '자료를 삭제하지 못했습니다.'); return }
    await load(); onToast(`${document.name} 파일을 삭제했습니다.`)
  }
  const askAi = async (event: FormEvent) => {
    event.preventDefault(); if (!aiQuery.trim()) return; setAiBusy(true); setAiAnswer('')
    try { const response = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json', ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}) }, body: JSON.stringify({ feature: 'document-search', messages: [{ role: 'user', content: `기업 자료실에서 다음 요청에 맞는 자료를 찾아 주세요: ${aiQuery.trim()}` }], context: { company: companyName, accessibleDocuments: documents.map(({ id, name, category: documentCategory, tags, summary, uploadedAt }) => ({ id, name, category: documentCategory, tags, summary, uploadedAt })) } }) }); const body = await response.json() as { text?: string; error?: { message?: string } }; if (!response.ok || !body.text) throw new Error(body.error?.message || 'AI 검색에 실패했습니다.'); setAiAnswer(body.text) } catch (error) { setAiAnswer(error instanceof Error ? error.message : 'AI 검색에 실패했습니다.') } finally { setAiBusy(false) }
  }
  return <div className="library-page"><header className="library-page-head"><div><span>COMPANY KNOWLEDGE</span><h1>기업 자료실</h1><p>권한에 맞는 회사 자료를 안전하게 보관하고, AI에게 필요한 문서를 바로 찾도록 요청하세요.</p></div><div>{canManage && <Button tone="secondary" type="button" onClick={() => setNasOpen(true)}><Database size={18} /> NAS 설정</Button>}<Button tone="primary" type="button" onClick={() => setEditing('new')}><Upload size={18} /> 자료 업로드</Button></div></header>
    <section className="library-ai-search"><span><Bot size={24} /></span><form onSubmit={askAi}><label htmlFor="library-ai-query">AI 자료 찾기</label><div><input id="library-ai-query" value={aiQuery} onChange={(event) => setAiQuery(event.target.value)} placeholder={librarySearchPlaceholderForIndustry(industryType)} /><button type="submit" disabled={aiBusy || !aiQuery.trim()}>{aiBusy ? '찾는 중…' : 'AI에게 찾기'}</button></div></form>{aiAnswer && <div className="library-ai-answer"><strong>검색 결과</strong><p>{aiAnswer}</p><button type="button" aria-label="검색 결과 닫기" onClick={() => setAiAnswer('')}><X size={16} /></button></div>}</section>
    <section className="library-storage-strip"><div><HardDrive size={19} /><span>{BRAND.storageLabel}</span><strong>{documents.filter((item) => item.storage === 'local').length}개</strong></div><div><Cloud size={19} /><span>NAS 연결</span><strong>{nas.status}</strong></div><div><Users size={19} /><span>내 열람 가능</span><strong>{documents.length}개</strong></div><div><FileArchive size={19} /><span>총 용량</span><strong>{humanSize(documents.reduce((sum, item) => sum + item.size, 0))}</strong></div></section>
    <section className="library-toolbar"><label><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="자료명·설명·태그 검색" /></label><div>{categories.map((item) => <button type="button" className={category === item ? 'active' : ''} key={item} onClick={() => setCategory(item)}>{item}</button>)}</div></section>
    <section className="library-list" aria-busy={loading}>{loading ? <div className="library-empty"><FolderSearch size={32} /><h2>권한에 맞는 자료를 불러오고 있습니다</h2></div> : visible.map((document) => <article key={document.id}><span className="library-file-icon"><FileText size={22} /></span><div className="library-file-main"><span>{document.category}</span><h2>{document.name}</h2><p>{document.summary}</p><div>{document.tags.map((tag) => <small key={tag}>#{tag}</small>)}</div></div><dl><div><dt>업로드</dt><dd>{document.uploadedByName}</dd></div><div><dt>날짜</dt><dd>{document.uploadedAt.slice(0, 10)}</dd></div><div><dt>크기</dt><dd>{humanSize(document.size)}</dd></div></dl><span className="library-permission"><LockKeyhole size={14} /> {document.visibility === 'all' ? '전 직원' : document.visibility === 'department' ? '부서 제한' : '계정 제한'}</span><div className="library-file-actions">{onAskLens && canRunLensOn(document.mime) && <button type="button" onClick={() => onAskLens({ id: document.id, name: document.name, mime: document.mime, context: `기업 자료실 · ${document.category}` })}><Sparkles size={16} /> AI에게 물어보기</button>}<button type="button" onClick={() => download(document)}><Download size={16} /> 다운로드</button>{canManage && <button type="button" onClick={() => setEditing(document)}><Pencil size={16} /> 권한</button>}{(canManage || document.uploadedById === currentUserId) && <button className="danger" type="button" onClick={() => remove(document)}><Trash2 size={16} /> 삭제</button>}</div></article>)}{!loading && visible.length === 0 && <div className="library-empty"><FolderSearch size={32} /><h2>조건에 맞는 자료가 없습니다</h2><p>첫 자료를 업로드하거나 다른 검색어를 입력해 보세요.</p></div>}</section>
    {editing && <DocumentModal document={editing === 'new' ? undefined : editing} workspaceScope={workspaceScope} onClose={() => setEditing(null)} onSaved={async () => { await load(); onToast(editing === 'new' ? '기업 자료를 업로드했습니다.' : '자료 정보와 권한을 저장했습니다.') }} />}
    {nasOpen && <NasModal settings={nas} onClose={() => setNasOpen(false)} onSave={async (next) => { const result = await setNas(next); if (result.ok) onToast('NAS 연결 설정을 안전하게 저장했습니다. 자격증명을 연결하면 동기화를 시작할 수 있습니다.'); return result.ok }} />}
  </div>
}

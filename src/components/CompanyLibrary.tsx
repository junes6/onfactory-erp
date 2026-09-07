import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Bot, CheckCircle2, Cloud, Database, Download, FileArchive, FileText, FolderSearch, FolderUp, HardDrive, LockKeyhole, Pencil, Plus, Search, Server, Sparkles, Trash2, Upload, Users, X } from 'lucide-react'
import { useWorkspaceState } from '../hooks/useWorkspaceState'
import { BulkImportDialog } from './BulkImport'
import { AI_POLICY_LABELS, AI_POLICY_ORDER, type BulkAiLevel } from '../utils/bulkImport'
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
  /** R16-G: 벌크 이관으로 들어온 자료만 갖는다 — 원본 폴더 경로와 AI 처리 수준. */
  sourcePath?: string
  aiPolicy?: BulkAiLevel
}
/** 이 값이 생기기 전에 올라간 문서는 aiPolicy 칸이 없다 — 그때의 실효값은 '활용'이다. */
const aiLevelOf = (document: Pick<CompanyDocument, 'aiPolicy'>): BulkAiLevel => (
  document.aiPolicy && AI_POLICY_ORDER.includes(document.aiPolicy) ? document.aiPolicy : 'active'
)
type BulkSessionSummary = { id: string; name: string; status: string; totals: { uploaded: number; failed: number; skippedDuplicate: number } }
const BULK_STATUS_LABEL: Record<string, string> = { draft: '준비 중', mapping: '매핑 중', uploading: '올리는 중', paused: '중단됨', done: '완료', failed: '실패' }
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
          // R16-G: 수준은 자료 정보에서만 내릴 수 있다(폴더 단위로 내리면 사람이 올려 둔 문서까지 잠긴다).
          ...(document ? { aiPolicy: String(form.get('aiPolicy')) } : {}),
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
          {document && <label><span>AI 처리 수준</span><select name="aiPolicy" defaultValue={aiLevelOf(document)}>{AI_POLICY_ORDER.map((level) => <option key={level} value={level}>{AI_POLICY_LABELS[level]}</option>)}</select></label>}
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
  const [sort, setSort] = useState<'recent' | 'name' | 'size' | 'category'>('recent')
  const [nasOpen, setNasOpen] = useState(false)
  const [aiQuery, setAiQuery] = useState('')
  const [aiAnswer, setAiAnswer] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [bulkOpen, setBulkOpen] = useState(false)
  /**
   * 드로어를 여는 문이 둘이라 무엇을 열지도 둘이다.
   * '폴더 통째로 올리기'는 **새 이관**(null), 지난 이관 줄의 버튼은 **그 세션**을 연다.
   * 하나로 묶어 언제나 마지막 세션을 넘기면, 이관을 한 번 끝낸 워크스페이스에서는
   * 새 이관을 영영 시작할 수 없다 — 드로어가 끝난 보고서를 펼친 채 열리기 때문이다.
   */
  const [bulkResumeId, setBulkResumeId] = useState<string | null>(null)
  const [bulkSessions, setBulkSessions] = useState<BulkSessionSummary[]>([])
  // 마지막 이관 한 줄. 끝나지 않은 이관이 있으면 '이어서 올리기'로 들어가는 문이 된다.
  const lastImport = bulkSessions[0] ?? null
  /**
   * 그 앞의 이관들은 접어 둔다. 접힌 채로라도 **목록에 있어야** 한다 —
   * 폴더 단위 '정리' 승격은 보고서 화면에만 있어서, 마지막 이관만 열 수 있으면 두 번째 이관이
   * 끝나는 순간 첫 이관의 폴더는 다시 올릴 길이 없다(자료 하나씩 PATCH만 남는다). 그리고
   * '끝난 이관 기록을 지워 주세요'라는 상한 문구는 맨 위가 아직 올리는 중인 테넌트에서 막다른 길이 된다.
   */
  const olderImports = bulkSessions.slice(1)
  const openBulk = (resumeId: string | null) => { setBulkResumeId(resumeId); setBulkOpen(true) }
  const loadImports = async () => {
    try {
      const response = await libraryFetch('/api/bulk-imports', workspaceScope)
      if (!response.ok) { setBulkSessions([]); return }
      const body = await response.json() as { sessions?: BulkSessionSummary[] }
      setBulkSessions(body.sessions ?? [])
    } catch { setBulkSessions([]) }
  }
  /**
   * 끝난 이관 기록을 지우는 문. 서버는 상한에 닿으면 '끝난 이관 기록을 지워 주세요'라고 답하는데,
   * 그 일을 할 수 있는 곳이 화면 어디에도 없으면 그 문장은 막다른 길이다.
   * 자료는 지우지 않는다 — 그 사실도 서버가 돌려주는 문장이 말한다.
   */
  const removeImport = async (session: BulkSessionSummary) => {
    if (!window.confirm(`‘${session.name}’ 이관 기록을 지울까요? 올라간 자료는 자료실에 그대로 있습니다.`)) return
    try {
      const response = await libraryFetch(`/api/bulk-imports/${encodeURIComponent(session.id)}`, workspaceScope, { method: 'DELETE' })
      const body = await response.json() as { message?: string; error?: { message?: string } }
      if (!response.ok) { onToast(body.error?.message || '이관 기록을 지우지 못했습니다.'); return }
      await loadImports()
      onToast(body.message || '이관 기록을 지웠습니다.')
    } catch { onToast('이관 기록을 지우지 못했습니다.') }
  }
  /**
   * 이관 한 줄. 목록의 **어느 줄이든 같은 두 문**을 갖는다 — 보고서(폴더 단위 승격이 있는 유일한 화면)와,
   * 끝난 기록이면 기록 지우기. 끝난 이관도 id를 넘긴다: 드로어가 그 보고서를 다시 펼친다
   * ('보고서 열기'가 빈 화면을 여는 것이 이 화면의 가장 쉬운 거짓말이다).
   */
  const importRow = (session: BulkSessionSummary) => {
    const unfinished = session.status !== 'done' && session.status !== 'failed'
    return <>{session.name} · {BULK_STATUS_LABEL[session.status] ?? session.status} · 올림 {session.totals.uploaded} · 건너뜀 {session.totals.skippedDuplicate} · 실패 {session.totals.failed}<Button tone="quiet" size="sm" type="button" onClick={() => openBulk(session.id)}>{unfinished ? '이어서 올리기' : '보고서 열기'}</Button>{!unfinished && <Button tone="quiet" size="sm" type="button" onClick={() => { void removeImport(session) }}>이관 기록 지우기</Button>}</>
  }
  const load = async () => {
    setLoading(true)
    try { const response = await libraryFetch('/api/documents', workspaceScope); const body = await response.json() as { documents?: CompanyDocument[]; error?: { message?: string } }; if (!response.ok) throw new Error(body.error?.message); setDocuments(body.documents ?? []) }
    catch (error) { onToast(error instanceof Error && error.message ? error.message : '기업 자료를 불러오지 못했습니다.') }
    finally { setLoading(false) }
  }
  useEffect(() => { if (workspaceScope) void load() }, [workspaceScope]) // eslint-disable-line react-hooks/exhaustive-deps
  // 이관 기록은 따로 읽는다 — 자료 목록의 재조회 계약(menu-ui-write-contract)을 건드리지 않기 위해서다.
  useEffect(() => { if (workspaceScope) void loadImports() }, [workspaceScope]) // eslint-disable-line react-hooks/exhaustive-deps
  const categories = ['전체', ...new Set(documents.map((item) => item.category))]
  const visible = useMemo(() => documents.filter((document) => (category === '전체' || document.category === category) && `${document.name} ${document.summary} ${document.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase().trim())), [category, documents, query])
  /**
   * R16-K: 자료실에는 정렬만 붙인다.
   *
   * 보기 전환(보드·캘린더)을 만들지 않는 이유는 데이터에 있다: CompanyDocument에는 status가 없어
   * 사람이 끌어 옮길 축이 없고(상태축이 없는 목록에 보드를 만들지 않는다), 유일한 날짜 uploadedAt은
   * '언제 올렸나'라서 달력에서 찾을 일이 아니다. 모드가 하나뿐인 화면에 스위처를 그리면 그 스위처가 거짓말이 된다.
   */
  const sorted = useMemo(() => {
    const list = [...visible]
    if (sort === 'name') return list.sort((left, right) => left.name.localeCompare(right.name, 'ko'))
    if (sort === 'size') return list.sort((left, right) => right.size - left.size)
    if (sort === 'category') return list.sort((left, right) => left.category.localeCompare(right.category, 'ko') || left.name.localeCompare(right.name, 'ko'))
    return list.sort((left, right) => right.uploadedAt.localeCompare(left.uploadedAt))
  }, [visible, sort])
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
  /**
   * '보관만'인 자료는 목록에서도 뺀다 — 이 배열은 모델에게 그대로 전달되는 후보 목록이고,
   * 이름·태그·요약만으로도 계약 상대와 금액이 드러난다. 서버도 같은 술어로 한 번 더 거른다.
   */
  const askAi = async (event: FormEvent) => {
    event.preventDefault(); if (!aiQuery.trim()) return; setAiBusy(true); setAiAnswer('')
    try { const response = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json', ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}) }, body: JSON.stringify({ feature: 'document-search', messages: [{ role: 'user', content: `기업 자료실에서 다음 요청에 맞는 자료를 찾아 주세요: ${aiQuery.trim()}` }], context: { company: companyName, accessibleDocuments: documents.filter((item) => aiLevelOf(item) !== 'locked').map(({ id, name, category: documentCategory, tags, summary, uploadedAt }) => ({ id, name, category: documentCategory, tags, summary, uploadedAt })) } }) }); const body = await response.json() as { text?: string; error?: { message?: string } }; if (!response.ok || !body.text) throw new Error(body.error?.message || 'AI 검색에 실패했습니다.'); setAiAnswer(body.text) } catch (error) { setAiAnswer(error instanceof Error ? error.message : 'AI 검색에 실패했습니다.') } finally { setAiBusy(false) }
  }
  return <div className="library-page"><header className="library-page-head"><div><span>COMPANY KNOWLEDGE</span><h1>기업 자료실</h1><p>권한에 맞는 회사 자료를 안전하게 보관하고, AI에게 필요한 문서를 바로 찾도록 요청하세요.</p></div><div>{canManage && <Button tone="secondary" type="button" onClick={() => setNasOpen(true)}><Database size={18} /> NAS 설정</Button>}<Button tone="secondary" type="button" onClick={() => openBulk(null)}><FolderUp size={18} /> 폴더 통째로 올리기</Button><Button tone="primary" type="button" onClick={() => setEditing('new')}><Upload size={18} /> 자료 업로드</Button></div></header>
    {lastImport && <div className="library-import-strip"><p className="library-import-row">지난 이관: {importRow(lastImport)}</p>
      {olderImports.length > 0 && <details className="library-import-history"><summary>그 앞의 이관 {olderImports.length}개</summary><ul>{olderImports.map((session) => <li key={session.id} className="library-import-row">{importRow(session)}</li>)}</ul></details>}
    </div>}
    <section className="library-ai-search"><span><Bot size={24} /></span><form onSubmit={askAi}><label htmlFor="library-ai-query">AI 자료 찾기</label><div><input id="library-ai-query" value={aiQuery} onChange={(event) => setAiQuery(event.target.value)} placeholder={librarySearchPlaceholderForIndustry(industryType)} /><button type="submit" disabled={aiBusy || !aiQuery.trim()}>{aiBusy ? '찾는 중…' : 'AI에게 찾기'}</button></div></form>{aiAnswer && <div className="library-ai-answer"><strong>검색 결과</strong><p>{aiAnswer}</p><button type="button" aria-label="검색 결과 닫기" onClick={() => setAiAnswer('')}><X size={16} /></button></div>}</section>
    <section className="library-storage-strip"><div><HardDrive size={19} /><span>{BRAND.storageLabel}</span><strong>{documents.filter((item) => item.storage === 'local').length}개</strong></div><div><Cloud size={19} /><span>NAS 연결</span><strong>{nas.status}</strong></div><div><Users size={19} /><span>내 열람 가능</span><strong>{documents.length}개</strong></div><div><FileArchive size={19} /><span>총 용량</span><strong>{humanSize(documents.reduce((sum, item) => sum + item.size, 0))}</strong></div></section>
    <section className="library-toolbar"><label><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="자료명·설명·태그 검색" /></label><div>{categories.map((item) => <button type="button" className={category === item ? 'active' : ''} key={item} onClick={() => setCategory(item)}>{item}</button>)}</div><label className="library-sort"><span className="sr-only">자료 정렬</span><select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="recent">최근 업로드</option><option value="name">이름</option><option value="size">크기</option><option value="category">분류</option></select></label></section>
    <section className="library-list" aria-busy={loading}>{loading ? <div className="library-empty"><FolderSearch size={32} /><h2>권한에 맞는 자료를 불러오고 있습니다</h2></div> : sorted.map((document) => <article key={document.id}><span className="library-file-icon"><FileText size={22} /></span><div className="library-file-main"><span>{document.category}</span><h2>{document.name}</h2>{document.sourcePath && <small className="library-source-path" title={document.sourcePath}>{document.sourcePath}</small>}<p>{document.summary}</p><div>{document.tags.map((tag) => <small key={tag}>#{tag}</small>)}{aiLevelOf(document) === 'locked' && <small className="library-ai-locked">{AI_POLICY_LABELS.locked}</small>}</div></div><dl><div><dt>업로드</dt><dd>{document.uploadedByName}</dd></div><div><dt>날짜</dt><dd>{document.uploadedAt.slice(0, 10)}</dd></div><div><dt>크기</dt><dd>{humanSize(document.size)}</dd></div></dl><span className="library-permission"><LockKeyhole size={14} /> {document.visibility === 'all' ? '전 직원' : document.visibility === 'department' ? '부서 제한' : '계정 제한'}</span><div className="library-file-actions">{/* '보관만'인 자료에는 버튼을 그리지 않는다 — 눌렀다가 409를 받는 대신 애초에 없다. */}
      {onAskLens && canRunLensOn(document.mime) && aiLevelOf(document) !== 'locked' && <button type="button" onClick={() => onAskLens({ id: document.id, name: document.name, mime: document.mime, context: `기업 자료실 · ${document.category}` })}><Sparkles size={16} /> AI에게 물어보기</button>}<button type="button" onClick={() => download(document)}><Download size={16} /> 다운로드</button>{canManage && <button type="button" onClick={() => setEditing(document)}><Pencil size={16} /> 권한</button>}{(canManage || document.uploadedById === currentUserId) && <button className="danger" type="button" onClick={() => remove(document)}><Trash2 size={16} /> 삭제</button>}</div></article>)}{!loading && visible.length === 0 && <div className="library-empty"><FolderSearch size={32} /><h2>조건에 맞는 자료가 없습니다</h2><p>첫 자료를 업로드하거나 다른 검색어를 입력해 보세요.</p></div>}</section>
    {editing && <DocumentModal document={editing === 'new' ? undefined : editing} workspaceScope={workspaceScope} onClose={() => setEditing(null)} onSaved={async () => { await load(); onToast(editing === 'new' ? '기업 자료를 업로드했습니다.' : '자료 정보와 권한을 저장했습니다.') }} />}
    {bulkOpen && <BulkImportDialog workspaceScope={workspaceScope} canChooseLibrary={canManage} resumeSessionId={bulkResumeId} onClose={() => { setBulkOpen(false); setBulkResumeId(null); void loadImports() }} onFinished={async () => { await load(); await loadImports() }} onToast={onToast} />}
    {nasOpen && <NasModal settings={nas} onClose={() => setNasOpen(false)} onSave={async (next) => { const result = await setNas(next); if (result.ok) onToast('NAS 연결 설정을 안전하게 저장했습니다. 자격증명을 연결하면 동기화를 시작할 수 있습니다.'); return result.ok }} />}
  </div>
}

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Bot, CheckCircle2, Cloud, Database, Download, FileArchive, FileText, FolderSearch, FolderUp, HardDrive, Layers, LockKeyhole, Pencil, RotateCcw, Search, Server, Sparkles, Trash2, Upload, Users, X } from 'lucide-react'
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
import { materialFromDocument } from './materials/materialsApi'
import type { ToastMessage } from './ui/Toast'
import { seoulDateInputValue } from '../utils/dateTime'

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
/** 휴지통의 자료. purgeAt이 지나면 매일 도는 일이 파일과 기록을 함께 지운다. */
type TrashedDocument = CompanyDocument & { trashedAt: string; trashedById?: string; trashedByName?: string; purgeAt: string }
const daysUntil = (iso: string) => Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000))
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

type DirectoryMember = { id: string; name: string; team?: string; kind?: 'employee' | 'guest'; active?: boolean; system?: boolean }
/** 열람 범위를 사람이 읽는 말로. 전에는 '지정 부서'·'지정 계정'이었고, 그 아래 칸에 부서 이름과 계정 ID를 쉼표로 쳐 넣어야 했다. */
const VISIBILITY_LABEL: Record<DocumentVisibility, string> = { all: '회사 전체', department: '정한 부서만', restricted: '정한 사람만' }
const toggled = (list: string[], value: string) => list.includes(value) ? list.filter((item) => item !== value) : [...list, value]

/** 회사 구성원 목록(이름·부서). 대화상자를 열 때 한 번 읽는다. 시스템 계정·외부 게스트는 고를 대상이 아니다. */
function useDirectoryMembers(workspaceScope?: string) {
  const [members, setMembers] = useState<DirectoryMember[] | null>(null)
  useEffect(() => {
    let active = true
    libraryFetch('/api/directory', workspaceScope)
      .then(async (response) => {
        if (!response.ok) throw new Error('directory')
        const body = await response.json() as { members?: DirectoryMember[] }
        if (active) setMembers((body.members ?? []).filter((member) => !member.system && member.kind === 'employee'))
      })
      .catch(() => { if (active) setMembers([]) })
    return () => { active = false }
  }, [workspaceScope])
  return members
}

/**
 * 누가 볼 수 있는가 — 고르는 것만 남기고 쳐 넣는 칸을 없앴다.
 * 부서 이름은 구성원의 부서와 **글자 하나까지** 같아야 열리는데(서버가 그대로 비교한다), 손으로 치면 한 글자만
 * 달라도 아무도 못 보는 자료가 됐다. 계정 ID는 화면 어디에도 보이지 않는 값이었다(감사).
 * 직원이 올릴 때는 서버가 범위를 '내 부서'·'나'로 고정하므로 고를 것 없이 그 사실만 말한다.
 */
function AudiencePicker({ visibility, canManage, currentUserId, members, departments, onDepartments, allowedUserIds, onAllowedUserIds }: {
  visibility: DocumentVisibility; canManage: boolean; currentUserId: string; members: DirectoryMember[] | null
  departments: string[]; onDepartments: (next: string[]) => void; allowedUserIds: string[]; onAllowedUserIds: (next: string[]) => void
}) {
  const [search, setSearch] = useState('')
  if (visibility === 'all') return <p className="library-audience-note full">회사 구성원 모두가 볼 수 있습니다.</p>
  if (!canManage) {
    const myTeam = members?.find((member) => member.id === currentUserId)?.team
    return <p className="library-audience-note full">{visibility === 'department' ? `내 부서(${myTeam && myTeam !== '미지정' ? myTeam : '부서 미지정'}) 사람만 볼 수 있습니다.` : '나만 볼 수 있습니다.'} 회사 관리자는 회사의 모든 자료를 볼 수 있습니다.</p>
  }
  if (!members) return <p className="library-audience-note full">구성원 목록을 불러오는 중…</p>
  if (visibility === 'department') {
    const teams = [...new Set([...members.filter((member) => member.active !== false).map((member) => member.team ?? '').filter((team) => team && team !== '미지정'), ...departments])].sort((left, right) => left.localeCompare(right, 'ko'))
    return <fieldset className="library-audience full"><legend>볼 수 있는 부서</legend>
      {teams.length ? <div className="library-choice-grid">{teams.map((team) => <label key={team} className={departments.includes(team) ? 'is-checked' : ''}><input type="checkbox" checked={departments.includes(team)} onChange={() => onDepartments(toggled(departments, team))} /> {team}</label>)}</div>
        : <p>구성원에게 부서가 정해져 있지 않습니다. 사람 › 구성원에서 부서를 먼저 정해 주세요.</p>}
      <small>{departments.length ? `${departments.join(', ')} 사람과 회사 관리자가 봅니다.` : '부서를 고르지 않으면 올린 사람과 회사 관리자만 봅니다.'}</small>
    </fieldset>
  }
  const choosable = members.filter((member) => member.active !== false || allowedUserIds.includes(member.id))
  const needle = search.trim().toLowerCase()
  const shown = needle ? choosable.filter((member) => `${member.name} ${member.team ?? ''}`.toLowerCase().includes(needle)) : choosable
  const nameOf = (id: string) => members.find((member) => member.id === id)?.name ?? '알 수 없는 계정'
  return <fieldset className="library-audience full"><legend>볼 수 있는 사람</legend>
    {/* 목록이 길어 찾기 칸이 뜰 때만, 고른 사람을 위에 모아 보인다(짧은 목록은 체크 표시로 충분하다). */}
    {choosable.length > 8 && allowedUserIds.length > 0 && <div className="library-picked">{allowedUserIds.map((id) => <Button key={id} tone="secondary" size="sm" type="button" aria-label={`${nameOf(id)} 빼기`} onClick={() => onAllowedUserIds(allowedUserIds.filter((item) => item !== id))}>{nameOf(id)} <X size={14} /></Button>)}</div>}
    {choosable.length > 8 && <input className="library-people-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="이름·부서로 찾기" aria-label="볼 수 있는 사람 찾기" />}
    <div className="library-choice-grid is-people">{shown.map((member) => <label key={member.id} className={allowedUserIds.includes(member.id) ? 'is-checked' : ''}><input type="checkbox" checked={allowedUserIds.includes(member.id)} onChange={() => onAllowedUserIds(toggled(allowedUserIds, member.id))} /> <span>{member.name}</span>{member.team && member.team !== '미지정' && <small>{member.team}</small>}</label>)}</div>
    <small>{allowedUserIds.length ? `고른 ${allowedUserIds.length}명과 회사 관리자가 봅니다.` : '아무도 고르지 않으면 올린 사람과 회사 관리자만 봅니다.'}</small>
  </fieldset>
}

function DocumentModal({ document, workspaceScope, canManage, currentUserId, onClose, onSaved }: { document?: CompanyDocument; workspaceScope?: string; canManage: boolean; currentUserId: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const industry = useIndustrySurface()
  const dialogRef = useLibraryModal(onClose)
  const fileRef = useRef<HTMLInputElement>(null)
  const members = useDirectoryMembers(workspaceScope)
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [visibility, setVisibility] = useState<DocumentVisibility>(document?.visibility ?? 'all')
  const [departments, setDepartments] = useState<string[]>(document?.departments ?? [])
  const [allowedUserIds, setAllowedUserIds] = useState<string[]>(document?.allowedUserIds ?? [])
  return <div className="library-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={dialogRef} className="library-modal" role="dialog" aria-modal="true" aria-labelledby="library-modal-title">
      <header><div><span>SECURE DOCUMENT</span><h2 id="library-modal-title">{document ? '자료 정보·볼 사람 고치기' : '자료 올리기'}</h2><p>{document ? '이름·분류와 볼 수 있는 사람을 고칩니다.' : '파일을 고르고, 누가 볼 수 있는지만 정하면 됩니다.'}</p></div><button type="button" aria-label="닫기" onClick={onClose}><X size={20} /></button></header>
      <form onSubmit={async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault(); setError('')
        const form = new FormData(event.currentTarget)
        const metadata = {
          name: String(form.get('name')).trim(), category: String(form.get('category')),
          visibility, departments: visibility === 'department' ? departments : [],
          allowedUserIds: visibility === 'restricted' ? allowedUserIds : [],
          tags: String(form.get('tags') ?? '').split(',').map((item) => item.trim()).filter(Boolean), summary: String(form.get('summary') ?? '').trim(),
          storage: String(form.get('storage') ?? 'local'),
          // R16-G: 수준은 자료 정보에서만 내릴 수 있다(폴더 단위로 내리면 사람이 올려 둔 문서까지 잠긴다).
          ...(document ? { aiPolicy: String(form.get('aiPolicy')) } : {}),
        }
        setBusy(true)
        try {
          let response: Response
          if (document) {
            response = await libraryFetch(`/api/documents/${encodeURIComponent(document.id)}`, workspaceScope, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(metadata) })
          } else {
            if (!file) throw new Error('올릴 파일을 먼저 골라 주세요.')
            if (file.size > 10 * 1024 * 1024) throw new Error('한 파일은 10MB까지 올릴 수 있습니다. 더 큰 파일은 [폴더 통째로 올리기]를 써 주세요.')
            const params = new URLSearchParams({ ...metadata, departments: metadata.departments.join(','), allowedUserIds: metadata.allowedUserIds.join(','), tags: metadata.tags.join(',') })
            response = await libraryFetch(`/api/documents?${params}`, workspaceScope, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name), 'x-file-type': file.type || 'application/octet-stream' }, body: file })
          }
          const body = await response.json() as { error?: { message?: string } }
          if (!response.ok) throw new Error(body.error?.message || '자료를 저장하지 못했습니다.')
          await onSaved(); onClose()
        } catch (reason) { setError(reason instanceof Error ? reason.message : '자료를 저장하지 못했습니다.'); setBusy(false) }
      }}>
        {!document && <section className="library-dropzone"><input ref={fileRef} className="sr-only" type="file" onChange={(event) => { const selected = event.target.files?.[0] ?? null; setFile(selected); if (selected) { const nameInput = event.currentTarget.form?.elements.namedItem('name') as HTMLInputElement | null; if (nameInput && !nameInput.value) nameInput.value = selected.name } }} /><Upload size={26} /><div><strong>{file?.name ?? '파일을 골라 주세요'}</strong><span>{file ? humanSize(file.size) : 'PDF, 문서, 이미지, 압축파일 · 최대 10MB'}</span></div><Button tone="secondary" type="button" onClick={() => fileRef.current?.click()}>파일 고르기</Button></section>}
        <div className="library-form-grid">
          <label className="full"><span>자료 이름</span><input name="name" defaultValue={document?.name} required autoFocus={Boolean(document)} /></label>
          <label><span>분류</span><select name="category" defaultValue={document?.category ?? '공통자료'}>{industry.documentCategories.map((category) => <option key={category}>{category}</option>)}{document?.category && !industry.documentCategories.includes(document.category) && <option>{document.category}</option>}</select></label>
          <label><span>누가 볼 수 있나요</span><select name="visibility" value={visibility} onChange={(event) => setVisibility(event.target.value as DocumentVisibility)}>{(['all', 'department', 'restricted'] as const).map((value) => <option key={value} value={value}>{VISIBILITY_LABEL[value]}</option>)}</select></label>
          <AudiencePicker visibility={visibility} canManage={canManage} currentUserId={currentUserId} members={members} departments={departments} onDepartments={setDepartments} allowedUserIds={allowedUserIds} onAllowedUserIds={setAllowedUserIds} />
          <label className="full"><span>설명 · 선택</span><textarea name="summary" rows={3} defaultValue={document?.summary} placeholder="어떤 자료인지 한두 줄. 적어 두면 AI가 이 자료를 더 잘 찾습니다." /></label>
        </div>
        {/* 자주 쓰지 않는 칸은 접어 둔다 — 올릴 때마다 여섯 칸을 채우라고 보이던 것을 줄였다(감사). */}
        <details className="library-more-fields" open={Boolean(document && (document.tags.length || document.aiPolicy))}>
          <summary>더 자세히 (선택)</summary>
          <div className="library-form-grid">
            <label className="full"><span>검색 태그 · 쉼표로 나눠 적기</span><input name="tags" defaultValue={document?.tags.join(', ')} placeholder={industry.examples.libraryTags} /></label>
            <label><span>저장 위치</span><select name="storage" defaultValue={document?.storage ?? 'local'}><option value="local">{BRAND.storageLabel}</option><option value="nas" disabled>NAS 동기화 · 자격증명 연결 후 사용</option></select></label>
            {document && <label><span>AI 처리 수준</span><select name="aiPolicy" defaultValue={aiLevelOf(document)}>{AI_POLICY_ORDER.map((level) => <option key={level} value={level}>{AI_POLICY_LABELS[level]}</option>)}</select></label>}
          </div>
        </details>
        {error && <p className="library-error" role="alert">{error}</p>}
        <footer><Button tone="ghost" type="button" onClick={onClose}>취소</Button><Button tone="primary" type="submit" disabled={busy}><CheckCircle2 size={18} /> {busy ? '저장 중…' : document ? '고친 내용 저장' : '올리기'}</Button></footer>
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

export function CompanyLibrary({ workspaceScope, canManage, currentUserId, companyName, industryType = 'food_manufacturing', onAskLens, onReviewMaterial, onToast }: { workspaceScope?: string; canManage: boolean; currentUserId: string; companyName: string; industryType?: string; onAskLens?: (target: LensTarget) => void; /** HTML 자료를 검토 자료로 열었을 때 그 자료로 옮겨 간다. */ onReviewMaterial?: (materialId: string) => void; onToast: (message: string | ToastMessage) => void }) {
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
  /** 자료 목록과 휴지통. 휴지통은 따로 읽는다 — 목록의 재조회 계약을 건드리지 않고, 지운 자료가 검색·AI 후보에 섞이지 않게. */
  const [view, setView] = useState<'files' | 'trash'>('files')
  const [trash, setTrash] = useState<TrashedDocument[]>([])
  const [trashDays, setTrashDays] = useState(30)
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
  const loadTrash = async () => {
    try {
      const response = await libraryFetch('/api/documents?trash=1', workspaceScope)
      if (!response.ok) { setTrash([]); return }
      const body = await response.json() as { documents?: TrashedDocument[]; trashDays?: number }
      setTrash(body.documents ?? [])
      if (body.trashDays) setTrashDays(body.trashDays)
    } catch { setTrash([]) }
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
  useEffect(() => { if (workspaceScope) void loadTrash() }, [workspaceScope]) // eslint-disable-line react-hooks/exhaustive-deps
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
  const [reviewingId, setReviewingId] = useState('')
  /** HTML 자료는 검토 자료로 열 수 있다. 서버가 한 번 더 파일 내용을 보고 HTML이 아니면 거절한다. */
  const isHtmlDocument = (document: CompanyDocument) => /html/i.test(document.mime) || /\.html?$/i.test(document.name)
  const reviewTogether = async (document: CompanyDocument) => {
    setReviewingId(document.id)
    try {
      const { material, existing } = await materialFromDocument(workspaceScope, document.id)
      onToast(existing ? '이미 검토 자료로 열려 있는 파일입니다. 그 자료로 옮겨 갑니다.' : '검토 자료를 만들었습니다. 이제 항목마다 의견을 남길 수 있습니다.')
      onReviewMaterial?.(material.id)
    } catch (error) { onToast(error instanceof Error ? error.message : '검토 자료를 만들지 못했습니다.') } finally { setReviewingId('') }
  }
  const download = async (document: CompanyDocument) => {
    try { const response = await libraryFetch(`/api/documents/${encodeURIComponent(document.id)}/download`, workspaceScope); if (!response.ok) { const body = await response.json() as { error?: { message?: string } }; throw new Error(body.error?.message) } const blob = await response.blob(); const url = URL.createObjectURL(blob); const anchor = window.document.createElement('a'); anchor.href = url; anchor.download = document.name; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); onToast(`${document.name} 다운로드를 시작했습니다.`) } catch (error) { onToast(error instanceof Error && error.message ? error.message : '파일을 다운로드하지 못했습니다.') }
  }
  /**
   * [삭제]는 휴지통으로 옮긴다 — 되살릴 수 있으니 묻지 않고, 알림 한 줄에 [되돌리기]를 단다.
   * 전에는 '되돌릴 수 없습니다'라고 물은 뒤 파일까지 곧바로 지웠다(감사: 데이터 보호).
   */
  const remove = async (document: CompanyDocument) => {
    const response = await libraryFetch(`/api/documents/${encodeURIComponent(document.id)}`, workspaceScope, { method: 'DELETE' })
    const body = await response.json() as { trashDays?: number; error?: { message?: string } }
    if (!response.ok) { onToast(body.error?.message || '자료를 삭제하지 못했습니다.'); return }
    await load(); void loadTrash()
    onToast({ text: `‘${document.name}’ 자료를 휴지통으로 옮겼습니다. ${body.trashDays ?? trashDays}일 안에는 되살릴 수 있습니다.`, undo: { label: '되돌리기', run: () => restore(document) } })
  }
  const restore = async (document: CompanyDocument) => {
    try {
      const response = await libraryFetch(`/api/documents/${encodeURIComponent(document.id)}/restore`, workspaceScope, { method: 'POST' })
      const body = await response.json() as { error?: { message?: string } }
      if (!response.ok) { onToast(body.error?.message || '자료를 되살리지 못했습니다.'); return }
      await load(); await loadTrash()
      onToast(`‘${document.name}’ 자료를 되살렸습니다.`)
    } catch { onToast('자료를 되살리지 못했습니다.') }
  }
  /** 완전히 지우기는 되돌릴 수 없으니 한 번 묻는다. 회사 관리자만(서버가 한 번 더 막는다). */
  const purge = async (document: TrashedDocument) => {
    if (!window.confirm(`‘${document.name}’ 자료를 완전히 지울까요? 파일까지 지워져 다시 되살릴 수 없습니다.`)) return
    try {
      const response = await libraryFetch(`/api/documents/${encodeURIComponent(document.id)}?permanent=1`, workspaceScope, { method: 'DELETE' })
      const body = await response.json() as { error?: { message?: string } }
      if (!response.ok) { onToast(body.error?.message || '자료를 지우지 못했습니다.'); return }
      await loadTrash()
      onToast(`‘${document.name}’ 자료를 완전히 지웠습니다.`)
    } catch { onToast('자료를 지우지 못했습니다.') }
  }
  /**
   * '보관만'인 자료는 목록에서도 뺀다 — 이 배열은 모델에게 그대로 전달되는 후보 목록이고,
   * 이름·태그·요약만으로도 계약 상대와 금액이 드러난다. 서버도 같은 술어로 한 번 더 거른다.
   */
  const askAi = async (event: FormEvent) => {
    event.preventDefault(); if (!aiQuery.trim()) return; setAiBusy(true); setAiAnswer('')
    try { const response = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json', ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}) }, body: JSON.stringify({ feature: 'document-search', messages: [{ role: 'user', content: `기업 자료실에서 다음 요청에 맞는 자료를 찾아 주세요: ${aiQuery.trim()}` }], context: { company: companyName, accessibleDocuments: documents.filter((item) => aiLevelOf(item) !== 'locked').map(({ id, name, category: documentCategory, tags, summary, uploadedAt }) => ({ id, name, category: documentCategory, tags, summary, uploadedAt })) } }) }); const body = await response.json() as { text?: string; error?: { message?: string } }; if (!response.ok || !body.text) throw new Error(body.error?.message || 'AI 검색에 실패했습니다.'); setAiAnswer(body.text) } catch (error) { setAiAnswer(error instanceof Error ? error.message : 'AI 검색에 실패했습니다.') } finally { setAiBusy(false) }
  }
  return <div className="library-page"><header className="library-page-head"><div><span>COMPANY KNOWLEDGE</span><h1>기업 자료실</h1><p>권한에 맞는 회사 자료를 안전하게 보관하고, AI에게 필요한 문서를 바로 찾도록 요청하세요.</p></div><div>{canManage && <Button tone="secondary" type="button" onClick={() => setNasOpen(true)}><Database size={18} /> NAS 설정</Button>}<Button tone="secondary" type="button" onClick={() => openBulk(null)}><FolderUp size={18} /> 폴더 통째로 올리기</Button><Button tone="primary" type="button" onClick={() => setEditing('new')}><Upload size={18} /> 자료 올리기</Button></div></header>
    {lastImport && <div className="library-import-strip"><p className="library-import-row">지난 이관: {importRow(lastImport)}</p>
      {olderImports.length > 0 && <details className="library-import-history"><summary>그 앞의 이관 {olderImports.length}개</summary><ul>{olderImports.map((session) => <li key={session.id} className="library-import-row">{importRow(session)}</li>)}</ul></details>}
    </div>}
    <section className="library-ai-search"><span><Bot size={24} /></span><form onSubmit={askAi}><label htmlFor="library-ai-query">AI 자료 찾기</label><div><input id="library-ai-query" value={aiQuery} onChange={(event) => setAiQuery(event.target.value)} placeholder={librarySearchPlaceholderForIndustry(industryType)} /><button type="submit" disabled={aiBusy || !aiQuery.trim()}>{aiBusy ? '찾는 중…' : 'AI에게 찾기'}</button></div></form>{aiAnswer && <div className="library-ai-answer"><strong>검색 결과</strong><p>{aiAnswer}</p><button type="button" aria-label="검색 결과 닫기" onClick={() => setAiAnswer('')}><X size={16} /></button></div>}</section>
    <section className="library-storage-strip"><div><HardDrive size={19} /><span>{BRAND.storageLabel}</span><strong>{documents.filter((item) => item.storage === 'local').length}개</strong></div><div><Cloud size={19} /><span>NAS 연결</span><strong>{nas.status}</strong></div><div><Users size={19} /><span>내 열람 가능</span><strong>{documents.length}개</strong></div><div><FileArchive size={19} /><span>총 용량</span><strong>{humanSize(documents.reduce((sum, item) => sum + item.size, 0))}</strong></div></section>
    {view === 'trash' ? <section className="library-trash" aria-labelledby="library-trash-title">
      <header><div><h2 id="library-trash-title">휴지통</h2><p>지운 자료는 {trashDays}일 동안 여기 있다가 저절로 완전히 지워집니다. 그동안은 저장 용량에 포함됩니다. {canManage ? '완전히 지우기는 회사 관리자만 할 수 있습니다.' : '내가 올렸거나 지운 자료만 보입니다.'}</p></div><Button tone="secondary" type="button" onClick={() => setView('files')}>자료 목록으로</Button></header>
      {trash.length === 0 ? <div className="library-empty"><Trash2 size={32} /><h2>휴지통이 비어 있습니다</h2><p>자료를 지우면 여기에 {trashDays}일 동안 남습니다.</p></div>
        : <ul>{trash.map((document) => <li key={document.id}><span className="library-file-icon"><FileText size={20} /></span><div><strong>{document.name}</strong><span>{document.category} · {document.trashedByName || '알 수 없는 사람'} · {seoulDateInputValue(new Date(document.trashedAt))}에 지움</span><small className={daysUntil(document.purgeAt) <= 7 ? 'is-soon' : ''}>{daysUntil(document.purgeAt)}일 뒤 완전히 지워집니다</small></div><div className="library-trash-actions"><Button tone="secondary" size="sm" type="button" onClick={() => void restore(document)}><RotateCcw size={16} /> 되살리기</Button>{canManage && <Button tone="danger" size="sm" type="button" onClick={() => void purge(document)}><Trash2 size={16} /> 완전히 지우기</Button>}</div></li>)}</ul>}
    </section> : <>
    <section className="library-toolbar"><label><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="자료명·설명·태그 검색" /></label><div>{categories.map((item) => <button type="button" className={category === item ? 'active' : ''} key={item} onClick={() => setCategory(item)}>{item}</button>)}</div><label className="library-sort"><span className="sr-only">자료 정렬</span><select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="recent">최근 업로드</option><option value="name">이름</option><option value="size">크기</option><option value="category">분류</option></select></label><Button tone="quiet" size="sm" type="button" className="library-trash-open" onClick={() => { setView('trash'); void loadTrash() }}><Trash2 size={16} /> 휴지통{trash.length ? ` ${trash.length}` : ''}</Button></section>
    <section className="library-list" aria-busy={loading}>{loading ? <div className="library-empty"><FolderSearch size={32} /><h2>권한에 맞는 자료를 불러오고 있습니다</h2></div> : sorted.map((document) => <article key={document.id}><span className="library-file-icon"><FileText size={22} /></span><div className="library-file-main"><span>{document.category}</span><h2>{document.name}</h2>{document.sourcePath && <small className="library-source-path" title={document.sourcePath}>{document.sourcePath}</small>}<p>{document.summary}</p><div>{document.tags.map((tag) => <small key={tag}>#{tag}</small>)}{aiLevelOf(document) === 'locked' && <small className="library-ai-locked">{AI_POLICY_LABELS.locked}</small>}</div></div><dl><div><dt>업로드</dt><dd>{document.uploadedByName}</dd></div><div><dt>날짜</dt><dd>{document.uploadedAt.slice(0, 10)}</dd></div><div><dt>크기</dt><dd>{humanSize(document.size)}</dd></div></dl><span className="library-permission"><LockKeyhole size={14} /> {document.visibility === 'all' ? '전 직원' : document.visibility === 'department' ? '부서 제한' : '계정 제한'}</span><div className="library-file-actions">{/* '보관만'인 자료에는 버튼을 그리지 않는다 — 눌렀다가 409를 받는 대신 애초에 없다. */}
      {onAskLens && canRunLensOn(document.mime) && aiLevelOf(document) !== 'locked' && <button type="button" onClick={() => onAskLens({ id: document.id, name: document.name, mime: document.mime, context: `기업 자료실 · ${document.category}` })}><Sparkles size={16} /> AI에게 물어보기</button>}{onReviewMaterial && isHtmlDocument(document) && <button type="button" disabled={reviewingId === document.id} onClick={() => void reviewTogether(document)}><Layers size={16} /> {reviewingId === document.id ? '여는 중…' : '함께 검토하기'}</button>}<button type="button" onClick={() => download(document)}><Download size={16} /> 다운로드</button>{canManage && <button type="button" onClick={() => setEditing(document)}><Pencil size={16} /> 고치기</button>}{(canManage || document.uploadedById === currentUserId) && <button className="danger" type="button" onClick={() => remove(document)}><Trash2 size={16} /> 휴지통으로</button>}</div></article>)}{!loading && visible.length === 0 && <div className="library-empty"><FolderSearch size={32} /><h2>조건에 맞는 자료가 없습니다</h2><p>첫 자료를 올리거나 다른 검색어를 넣어 보세요.</p></div>}</section>
    </>}
    {editing && <DocumentModal document={editing === 'new' ? undefined : editing} workspaceScope={workspaceScope} canManage={canManage} currentUserId={currentUserId} onClose={() => setEditing(null)} onSaved={async () => { await load(); onToast(editing === 'new' ? '자료를 올렸습니다.' : '자료 정보와 볼 사람을 저장했습니다.') }} />}
    {bulkOpen && <BulkImportDialog workspaceScope={workspaceScope} canChooseLibrary={canManage} resumeSessionId={bulkResumeId} onClose={() => { setBulkOpen(false); setBulkResumeId(null); void loadImports() }} onFinished={async () => { await load(); await loadImports() }} onToast={onToast} />}
    {nasOpen && <NasModal settings={nas} onClose={() => setNasOpen(false)} onSave={async (next) => { const result = await setNas(next); if (result.ok) onToast('NAS 연결 설정을 안전하게 저장했습니다. 자격증명을 연결하면 동기화를 시작할 수 있습니다.'); return result.ok }} />}
  </div>
}

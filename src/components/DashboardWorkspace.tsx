import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  ArrowDown, ArrowUp, Check, ExternalLink, Globe2, LayoutDashboard,
  Link2, Pencil, Plus, Settings2, Trash2, X,
} from 'lucide-react'
import { quickLinksStorageKey, readQuickLinks, writeQuickLinks, type QuickLink } from '../utils/quickLinksStorage'
import { downloadDocumentAttachment } from '../utils/documentAttachments'
import { FileText, FolderSearch, Download } from 'lucide-react'
import './DashboardWorkspace.css'

export type DashboardWidgetId = 'summary' | 'ai' | 'schedule' | 'work' | 'links' | 'alert' | 'files'
export type DashboardWidgetSize = 'half' | 'wide' | 'full'

export type DashboardWidgetPreference = {
  id: DashboardWidgetId
  visible: boolean
  size: DashboardWidgetSize
}

const widgetLabels: Record<DashboardWidgetId, { title: string; description: string }> = {
  summary: { title: '오늘 핵심 현황', description: '주문·확인 업무·AI 알림을 한 줄로 봅니다.' },
  ai: { title: 'AI 업무 대화', description: '질문과 업무 지시를 처리합니다.' },
  schedule: { title: '공유 일정', description: '오늘 일정과 월간 달력을 봅니다.' },
  work: { title: '다음 업무', description: '내가 수행하거나 결재할 업무입니다.' },
  links: { title: '업무 바로가기', description: '자주 쓰는 외부 사이트를 엽니다.' },
  files: { title: '자주 찾는 파일', description: '자주 내려받는 회사 자료를 바로 엽니다.' },
  alert: { title: '중요 알림', description: '확인이 필요한 운영 문제입니다.' },
}

export const defaultDashboardWidgets: DashboardWidgetPreference[] = [
  { id: 'summary', visible: true, size: 'full' },
  { id: 'ai', visible: true, size: 'wide' },
  { id: 'schedule', visible: true, size: 'half' },
  { id: 'links', visible: true, size: 'half' },
  { id: 'files', visible: true, size: 'half' },
  { id: 'work', visible: true, size: 'half' },
  { id: 'alert', visible: true, size: 'half' },
]

function normalizePreferences(value: unknown): DashboardWidgetPreference[] {
  if (!Array.isArray(value)) return defaultDashboardWidgets.map((item) => ({ ...item }))
  const ids = new Set<DashboardWidgetId>()
  const valid: DashboardWidgetPreference[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const candidate = item as Partial<DashboardWidgetPreference>
    if (!candidate.id || !(candidate.id in widgetLabels) || typeof candidate.visible !== 'boolean') continue
    if (!candidate.size || !['half', 'wide', 'full'].includes(candidate.size) || ids.has(candidate.id)) continue
    ids.add(candidate.id)
    valid.push(candidate as DashboardWidgetPreference)
  }
  for (const fallback of defaultDashboardWidgets) {
    if (!ids.has(fallback.id)) {
      if (fallback.id === 'summary') valid.unshift({ ...fallback })
      else valid.push({ ...fallback })
    }
  }
  return valid
}

export function useDashboardPreferences(scope: string) {
  const storageKey = `onfactory-dashboard-layout:${scope}`
  const versionKey = `onfactory-dashboard-layout-version:${scope}`
  const read = () => {
    try {
      const parsed: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? 'null')
      const normalized = normalizePreferences(parsed)
      if (Number(window.localStorage.getItem(versionKey) ?? 0) < 2) {
        const summary = normalized.find((item) => item.id === 'summary')
        return summary ? [summary, ...normalized.filter((item) => item.id !== 'summary')] : normalized
      }
      return normalized
    } catch { return defaultDashboardWidgets.map((item) => ({ ...item })) }
  }
  const [preferences, setPreferences] = useState<DashboardWidgetPreference[]>(read)

  useEffect(() => setPreferences(read()), [storageKey])
  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(preferences))
      window.localStorage.setItem(versionKey, '2')
    } catch { /* personal preference storage is optional */ }
  }, [preferences, storageKey, versionKey])

  return [preferences, setPreferences] as const
}

function useDialogFocus(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    if (!open || !ref.current) return
    const dialog = ref.current
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const selector = 'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[href],[tabindex]:not([tabindex="-1"])'
    const focusables = () => Array.from(dialog.querySelectorAll<HTMLElement>(selector))
    window.setTimeout(() => focusables()[0]?.focus(), 0)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); return }
      if (event.key !== 'Tab') return
      const items = focusables()
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    dialog.addEventListener('keydown', onKey)
    return () => { dialog.removeEventListener('keydown', onKey); previous?.focus() }
  }, [open])
  return ref
}

export function DashboardLayoutButton({ onClick }: { onClick: () => void }) {
  return <button className="button ghost dashboard-layout-trigger" type="button" onClick={onClick}><LayoutDashboard size={18} /> 위젯 편집</button>
}

export function DashboardLayoutModal({ open, preferences, onChange, onClose }: {
  open: boolean
  preferences: DashboardWidgetPreference[]
  onChange: (value: DashboardWidgetPreference[]) => void
  onClose: () => void
}) {
  const dialogRef = useDialogFocus(open, onClose)
  if (!open) return null

  const update = (id: DashboardWidgetId, patch: Partial<DashboardWidgetPreference>) => {
    onChange(preferences.map((item) => item.id === id ? { ...item, ...patch } : item))
  }
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= preferences.length) return
    const next = [...preferences]
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange(next)
  }

  return <div className="dashboard-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={dialogRef} className="dashboard-layout-modal" role="dialog" aria-modal="true" aria-labelledby="dashboard-layout-title">
      <header><div><span>PERSONAL DASHBOARD</span><h2 id="dashboard-layout-title">첫 화면 위젯 편집</h2><p>표시 여부, 순서와 너비를 내 계정에 맞게 조정합니다.</p></div><button type="button" aria-label="닫기" onClick={onClose}><X size={21} /></button></header>
      <div className="dashboard-widget-settings">
        {preferences.map((item, index) => <article key={item.id}>
          <label><input type="checkbox" checked={item.visible} onChange={(event) => update(item.id, { visible: event.target.checked })} /><span><strong>{widgetLabels[item.id].title}</strong><small>{widgetLabels[item.id].description}</small></span></label>
          <div className="dashboard-widget-setting-actions">
            <select aria-label={`${widgetLabels[item.id].title} 너비`} value={item.size} onChange={(event) => update(item.id, { size: event.target.value as DashboardWidgetSize })}><option value="half">보통</option><option value="wide">넓게</option><option value="full">전체</option></select>
            <button type="button" aria-label={`${widgetLabels[item.id].title} 위로 이동`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={17} /></button>
            <button type="button" aria-label={`${widgetLabels[item.id].title} 아래로 이동`} disabled={index === preferences.length - 1} onClick={() => move(index, 1)}><ArrowDown size={17} /></button>
          </div>
        </article>)}
      </div>
      <footer><button className="button ghost" type="button" onClick={() => onChange(defaultDashboardWidgets)}>기본 배치로</button><button className="button primary" type="button" onClick={onClose}><Check size={18} /> 적용 완료</button></footer>
    </section>
  </div>
}

export function QuickLinksWidget({ scope, onToast }: { scope: string; onToast: (message: string) => void }) {
  const storageKey = quickLinksStorageKey(scope)
  const [links, setLinks] = useState<QuickLink[]>(() => readQuickLinks(window.localStorage, storageKey))
  const [adding, setAdding] = useState(false)
  const [managing, setManaging] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const editingLink = links.find((link) => link.id === editingId) ?? null

  useEffect(() => setLinks(readQuickLinks(window.localStorage, storageKey)), [storageKey])
  useEffect(() => {
    try { writeQuickLinks(window.localStorage, storageKey, links) } catch { /* personal preference storage is optional */ }
  }, [links, storageKey])

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const name = String(form.get('name') ?? '').trim()
    const rawUrl = String(form.get('url') ?? '').trim()
    try {
      const url = new URL(rawUrl)
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid protocol')
      if (!name) { setError('바로가기 이름을 입력해 주세요.'); return }
      const nextLink = { name, url: url.toString(), color: String(form.get('color') ?? 'green') as QuickLink['color'] }
      setLinks((current) => editingId
        ? current.map((link) => link.id === editingId ? { ...link, ...nextLink } : link)
        : [...current, { id: `LINK-${Date.now()}`, ...nextLink }])
      setAdding(false)
      setEditingId(null)
      setError('')
      onToast(`${name} 바로가기를 ${editingId ? '수정' : '추가'}했습니다.`)
    } catch { setError('https:// 로 시작하는 올바른 주소를 입력해 주세요.') }
  }

  return <section className="dashboard-quick-links dashboard-section-card" aria-labelledby="quick-links-title">
    <header className="dashboard-section-header"><div className="dashboard-section-title"><span className="dashboard-section-icon"><Globe2 size={18} /></span><h2 id="quick-links-title">업무 바로가기</h2></div><div><button type="button" onClick={() => { setManaging((value) => !value); setAdding(false); setEditingId(null) }}><Settings2 size={16} /> {managing ? '완료' : '관리'}</button><button type="button" onClick={() => { setAdding(true); setManaging(false); setEditingId(null) }}><Plus size={17} /> 추가</button></div></header>
    <div className="dashboard-section-body"><div className="dashboard-link-grid">
      {links.map((link) => <div className="dashboard-link-item" key={link.id}>
        <a href={link.url} target="_blank" rel="noreferrer noopener" aria-label={`${link.name} 새 창에서 열기`}><span className={link.color}>{link.name.slice(0, 1)}</span><strong>{link.name}</strong><ExternalLink size={15} /></a>
        {managing && <div className="dashboard-link-manage-actions"><button type="button" aria-label={`${link.name} 수정`} onClick={() => { setEditingId(link.id); setAdding(true); setManaging(false); setError('') }}><Pencil size={16} /></button><button type="button" aria-label={`${link.name} 삭제`} onClick={() => setLinks((current) => current.filter((item) => item.id !== link.id))}><Trash2 size={16} /></button></div>}
      </div>)}
      {links.length === 0 && <button className="dashboard-link-empty" type="button" onClick={() => setAdding(true)}><Globe2 size={22} /><span>첫 바로가기 추가</span></button>}
    </div>
    {adding && <form className="dashboard-link-form" onSubmit={submit}>
      <div><Link2 size={18} /><strong>{editingLink ? '바로가기 수정' : '새 바로가기'}</strong><button type="button" aria-label="편집 취소" onClick={() => { setAdding(false); setEditingId(null); setError('') }}><X size={17} /></button></div>
      <label><span>이름</span><input name="name" key={`name-${editingLink?.id ?? 'new'}`} defaultValue={editingLink?.name ?? ''} autoFocus placeholder="예: 식품안전나라" required /></label>
      <label><span>웹 주소</span><input name="url" key={`url-${editingLink?.id ?? 'new'}`} defaultValue={editingLink?.url ?? ''} type="url" placeholder="https://www.example.com" required /></label>
      <label><span>아이콘 색상</span><select name="color" key={`color-${editingLink?.id ?? 'new'}`} defaultValue={editingLink?.color ?? 'green'}><option value="green">초록</option><option value="blue">파랑</option><option value="amber">주황</option><option value="violet">보라</option></select></label>
      {error && <p role="alert">{error}</p>}
      <button className="button primary" type="submit">{editingLink ? <Pencil size={17} /> : <Plus size={17} />} 바로가기 저장</button>
    </form>}</div>
  </section>
}

export function widgetClass(preference: DashboardWidgetPreference) {
  return `dashboard-widget dashboard-widget-${preference.id} dashboard-widget-${preference.size}`
}

type FrequentFileRow = { id: string; name: string; category: string; size: number; accessCount?: number; lastAccessedAt?: string; uploadedAt?: string; updatedAt?: string }

/** 자주 찾는 파일: 다운로드 횟수 기준 상위 자료. 기록이 없으면 최근 자료를 보여준다. */
export function FrequentFilesWidget({ workspaceScope, onOpenLibrary, onToast }: { workspaceScope?: string; onOpenLibrary: () => void; onToast: (message: string) => void }) {
  const [files, setFiles] = useState<FrequentFileRow[] | null>(null)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    fetch('/api/documents', { headers: workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined })
      .then(async (response) => response.ok ? response.json() as Promise<{ documents?: FrequentFileRow[] }> : { documents: [] })
      .then((body) => {
        if (!active) return
        const rows = (body.documents ?? []).filter((row) => !row.category?.includes('개발운영지원'))
        rows.sort((left, right) => (Number(right.accessCount) || 0) - (Number(left.accessCount) || 0)
          || String(right.lastAccessedAt ?? right.updatedAt ?? right.uploadedAt ?? '').localeCompare(String(left.lastAccessedAt ?? left.updatedAt ?? left.uploadedAt ?? '')))
        setFiles(rows.slice(0, 5))
      })
      .catch(() => { if (active) setFiles([]) })
    return () => { active = false }
  }, [workspaceScope])
  const formatSize = (size: number) => !Number.isFinite(size) || size <= 0 ? '' : size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))}KB` : `${(size / 1024 / 1024).toFixed(1)}MB`
  const open = async (row: FrequentFileRow) => {
    setDownloadingId(row.id)
    try { await downloadDocumentAttachment({ id: row.id, name: row.name, size: formatSize(row.size) }, workspaceScope) }
    catch (error) { onToast(error instanceof Error ? error.message : '파일을 내려받지 못했습니다.') }
    finally { setDownloadingId(null) }
  }
  return <section className="frequent-files-card dashboard-section-card">
    <header className="dashboard-section-header"><div className="dashboard-section-title"><span className="dashboard-section-icon"><FileText size={18} /></span><h2>자주 찾는 파일</h2></div><button type="button" onClick={onOpenLibrary}>자료실 열기</button></header>
    <div className="frequent-files-body dashboard-section-body">
      {files === null && <p className="frequent-files-empty">자료를 불러오는 중…</p>}
      {files !== null && files.length === 0 && <div className="empty-state compact"><FolderSearch size={24} /><h3>아직 내려받은 자료가 없습니다</h3><p>기업 자료실에서 파일을 내려받으면 자주 쓰는 순서로 여기에 모입니다.</p></div>}
      {files !== null && files.map((row) => <button type="button" className="frequent-file-row" key={row.id} disabled={downloadingId === row.id} onClick={() => void open(row)}>
        <span className="frequent-file-icon"><FileText size={16} /></span>
        <span className="frequent-file-name">{row.name}</span>
        <span className="frequent-file-meta">{row.accessCount ? `${row.accessCount}회` : '새 자료'}{formatSize(row.size) ? ` · ${formatSize(row.size)}` : ''}</span>
        <Download size={14} />
      </button>)}
    </div>
  </section>
}

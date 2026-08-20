import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { AlertTriangle, Bot, CalendarClock, CheckCircle2, ChevronRight, ClipboardCheck, Download, FileCheck2, FileText, Gauge, GraduationCap, Microscope, Pencil, Plus, Search, ShieldCheck, Tags, Trash2, Upload, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useWorkspaceState } from '../hooks/useWorkspaceState'
import { formatDateTime } from '../utils/dateTime'
import {
  deleteDocumentAttachment,
  deleteDocumentAttachments,
  downloadDocumentAttachment,
  isStoredDocumentAttachment,
  uploadDocumentAttachments,
} from '../utils/documentAttachments'
import { StatusBadge, type StatusBadgeTone } from './StatusBadge'
import './ComplianceCenter.css'

type ComplianceStatus = '유효' | '갱신예정' | '보완필요' | '만료'
type ComplianceRecord = {
  id: string
  category: string
  name: string
  authority: string
  certificateNo: string
  issuedAt: string
  expiresAt: string
  owner: string
  status: ComplianceStatus
  checklist: string[]
  attachments: { id: string; name: string; size: string }[]
  note: string
  updatedAt: string
}

type ComplianceCategoryMeta = { id: string; label: string; icon: LucideIcon; tone: 'forest' | 'blue' | 'violet' | 'amber' | 'slate' }

function complianceStatusTone(status: ComplianceStatus): StatusBadgeTone {
  if (status === '유효') return 'success'
  if (status === '갱신예정') return 'warning'
  if (status === '보완필요' || status === '만료') return 'danger'
  return 'neutral'
}

const complianceCategories: ComplianceCategoryMeta[] = [
  { id: 'HACCP', label: 'HACCP', icon: ShieldCheck, tone: 'forest' },
  { id: '자가품질검사', label: '자가품질', icon: Microscope, tone: 'blue' },
  { id: '식품표시 검토', label: '표시 검토', icon: Tags, tone: 'violet' },
  { id: '위생교육', label: '위생교육', icon: GraduationCap, tone: 'amber' },
  { id: '검교정', label: '검교정', icon: Gauge, tone: 'slate' },
]

function categoryMeta(category: string): ComplianceCategoryMeta {
  if (/HACCP/i.test(category)) return complianceCategories[0]
  if (category.includes('자가품질')) return complianceCategories[1]
  if (category.includes('표시')) return complianceCategories[2]
  if (category.includes('교육')) return complianceCategories[3]
  if (category.includes('검교정')) return complianceCategories[4]
  return { id: category, label: category, icon: FileCheck2, tone: 'slate' }
}

function isRecordArray(value: unknown): value is ComplianceRecord[] {
  return Array.isArray(value) && value.every((item) => Boolean(item && typeof item === 'object' && typeof item.id === 'string' && typeof item.name === 'string' && Array.isArray(item.attachments)))
}

function deriveStatus(expiresAt: string, attachments: ComplianceRecord['attachments']): ComplianceStatus {
  if (!attachments.length) return '보완필요'
  const remaining = Math.ceil((new Date(`${expiresAt}T23:59:59`).getTime() - Date.now()) / 86_400_000)
  if (remaining < 0) return '만료'
  if (remaining <= 90) return '갱신예정'
  return '유효'
}

function useComplianceDialog(onClose: () => void) {
  const ref = useRef<HTMLElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const selector = 'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])'
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

function RecordModal({ record, workspaceScope, onClose, onSave, onToast }: { record?: ComplianceRecord; workspaceScope?: string; onClose: () => void; onSave: (record: ComplianceRecord) => Promise<boolean>; onToast: (message: string) => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [attachments, setAttachments] = useState(record?.attachments ?? [])
  const [busy, setBusy] = useState(false)
  const [attachmentBusy, setAttachmentBusy] = useState(false)
  const [downloadingId, setDownloadingId] = useState('')
  const uploadedIdsRef = useRef(new Set<string>())
  const removedIdsRef = useRef(new Set<string>())

  const requestClose = async () => {
    if (busy || attachmentBusy) return
    setBusy(true)
    const cleanup = await deleteDocumentAttachments(uploadedIdsRef.current, workspaceScope)
    for (const id of cleanup.deleted) uploadedIdsRef.current.delete(id)
    if (cleanup.deleted.length) {
      const deleted = new Set(cleanup.deleted)
      setAttachments((current) => current.filter((attachment) => !deleted.has(attachment.id)))
    }
    if (cleanup.failed.length) {
      onToast(`저장하지 않은 증빙 ${cleanup.failed.length}개를 정리하지 못했습니다. 다시 시도해 주세요.`)
      setBusy(false)
      return
    }
    removedIdsRef.current.clear()
    onClose()
  }
  const dialogRef = useComplianceDialog(() => { void requestClose() })

  const attachFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (!files.length || busy || attachmentBusy) return
    if (attachments.length + files.length > 20) {
      onToast('인증 항목에는 증빙자료를 최대 20개까지 등록할 수 있습니다.')
      return
    }
    setAttachmentBusy(true)
    try {
      const additions = await uploadDocumentAttachments(files, {
        workspaceScope,
        category: '식품안전·인증',
        summary: `${record?.name ?? '신규 인증·검토사항'} 증빙자료`,
        tags: ['식품안전', '인증', record?.category ?? '신규'],
      })
      for (const attachment of additions) uploadedIdsRef.current.add(attachment.id)
      setAttachments((current) => [...current, ...additions])
      onToast(`${additions.length}개 증빙 원본을 안전하게 업로드했습니다.`)
    } catch (error) {
      onToast(error instanceof Error ? error.message : '증빙자료를 업로드하지 못했습니다.')
    } finally {
      setAttachmentBusy(false)
    }
  }

  const removeAttachment = async (attachment: ComplianceRecord['attachments'][number]) => {
    if (busy || attachmentBusy) return
    if (isStoredDocumentAttachment(attachment) && uploadedIdsRef.current.has(attachment.id)) {
      setAttachmentBusy(true)
      try {
        await deleteDocumentAttachment(attachment.id, workspaceScope)
        uploadedIdsRef.current.delete(attachment.id)
      } catch (error) {
        onToast(error instanceof Error ? error.message : '증빙자료를 삭제하지 못했습니다.')
        setAttachmentBusy(false)
        return
      }
      setAttachmentBusy(false)
    } else if (isStoredDocumentAttachment(attachment)) {
      removedIdsRef.current.add(attachment.id)
    }
    setAttachments((current) => current.filter((item) => item.id !== attachment.id))
  }

  const downloadAttachment = async (attachment: ComplianceRecord['attachments'][number]) => {
    if (downloadingId) return
    setDownloadingId(attachment.id)
    try {
      await downloadDocumentAttachment(attachment, workspaceScope)
    } catch (error) {
      onToast(error instanceof Error ? error.message : '증빙자료를 내려받지 못했습니다.')
    } finally {
      setDownloadingId('')
    }
  }

  return <div className="compliance-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) void requestClose() }}>
    <section ref={dialogRef} className="compliance-modal" role="dialog" aria-modal="true" aria-labelledby="compliance-modal-title">
      <header><div><span>COMPLIANCE RECORD</span><h2 id="compliance-modal-title">{record ? '인증·검토사항 수정' : '인증·검토사항 등록'}</h2></div><button type="button" aria-label="닫기" disabled={busy || attachmentBusy} onClick={() => void requestClose()}><X size={20} /></button></header>
      <form onSubmit={async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        if (busy || attachmentBusy) return
        const form = new FormData(event.currentTarget)
        const expiresAt = String(form.get('expiresAt'))
        const next: ComplianceRecord = {
          id: record?.id ?? `CERT-${Date.now()}`,
          category: String(form.get('category')),
          name: String(form.get('name')).trim(),
          authority: String(form.get('authority')).trim(),
          certificateNo: String(form.get('certificateNo')).trim(),
          issuedAt: String(form.get('issuedAt')),
          expiresAt,
          owner: String(form.get('owner')).trim(),
          status: deriveStatus(expiresAt, attachments),
          checklist: String(form.get('checklist')).split('\n').map((item) => item.trim()).filter(Boolean),
          attachments,
          note: String(form.get('note')).trim(),
          updatedAt: new Date().toISOString(),
        }
        setBusy(true)
        if (!(await onSave(next))) {
          const rollback = await deleteDocumentAttachments(uploadedIdsRef.current, workspaceScope)
          for (const id of rollback.deleted) uploadedIdsRef.current.delete(id)
          if (rollback.deleted.length) {
            const deleted = new Set(rollback.deleted)
            setAttachments((current) => current.filter((attachment) => !deleted.has(attachment.id)))
          }
          if (rollback.failed.length) onToast(`저장 실패 후 증빙 ${rollback.failed.length}개 롤백에도 실패했습니다. 화면에 유지했으니 다시 저장하거나 제거해 주세요.`)
          setBusy(false)
          return
        }
        uploadedIdsRef.current.clear()
        const cleanup = await deleteDocumentAttachments(removedIdsRef.current, workspaceScope)
        removedIdsRef.current.clear()
        if (cleanup.failed.length) onToast(`항목은 저장했지만 제거한 증빙 ${cleanup.failed.length}개의 원본 정리에 실패했습니다.`)
        onClose()
      }}>
        <div className="compliance-form-grid">
          <label><span>관리 분류</span><select name="category" defaultValue={record?.category ?? 'HACCP'}><option>HACCP</option><option>품목제조보고</option><option>자가품질검사</option><option>식품표시 검토</option><option>위생교육</option><option>검교정</option><option>ISO 22000</option><option>FSSC 22000</option><option>기타 인증</option></select></label>
          <label><span>담당자</span><input name="owner" defaultValue={record?.owner} required /></label>
          <label className="full"><span>인증·검토 명칭</span><input name="name" defaultValue={record?.name} required autoFocus /></label>
          <label><span>발급·검토 기관</span><input name="authority" defaultValue={record?.authority} required /></label>
          <label><span>인증·보고 번호</span><input name="certificateNo" defaultValue={record?.certificateNo} placeholder="없으면 내부 관리번호" required /></label>
          <label><span>발급·확인일</span><input name="issuedAt" type="date" defaultValue={record?.issuedAt ?? new Date().toISOString().slice(0, 10)} required /></label>
          <label><span>유효·다음 검토일</span><input name="expiresAt" type="date" defaultValue={record?.expiresAt} required /></label>
          <label className="full"><span>필수 확인 항목 · 한 줄에 하나</span><textarea name="checklist" rows={4} defaultValue={record?.checklist.join('\n')} placeholder={'예: 인증서 원본 확인\n갱신 신청 일정 등록'} /></label>
          <label className="full"><span>메모</span><textarea name="note" rows={3} defaultValue={record?.note} /></label>
        </div>
        <section className="compliance-attachments"><input ref={fileRef} className="sr-only" type="file" multiple onChange={(event) => void attachFiles(event)} /><div><strong>증빙자료</strong><span>인증서·성적서·교육 수료증 원본을 권한이 제한된 기업 자료로 저장합니다.</span></div><button className="button secondary" type="button" disabled={busy || attachmentBusy} onClick={() => fileRef.current?.click()}><Upload size={17} /> {attachmentBusy ? '처리 중…' : '파일 선택'}</button></section>
        <div className="compliance-file-list">{attachments.map((file) => <span key={file.id}><FileText size={15} /><span>{file.name} · {file.size}<small>{isStoredDocumentAttachment(file) ? '원본 저장됨' : '이전 파일 정보 · 원본 없음'}</small></span>{isStoredDocumentAttachment(file) && <button type="button" aria-label={`${file.name} 다운로드`} disabled={Boolean(downloadingId)} onClick={() => void downloadAttachment(file)}><Download size={14} /></button>}<button type="button" aria-label={`${file.name} 제거`} disabled={busy || attachmentBusy} onClick={() => void removeAttachment(file)}><X size={14} /></button></span>)}</div>
        <footer><button className="button ghost" type="button" disabled={busy || attachmentBusy} onClick={() => void requestClose()}>취소</button><button className="button primary" type="submit" disabled={busy || attachmentBusy}><FileCheck2 size={18} /> {busy ? '저장 중…' : '변경사항 저장'}</button></footer>
      </form>
    </section>
  </div>
}

export function ComplianceCenter({ workspaceScope, canManage, companyName, onToast }: { workspaceScope?: string; canManage: boolean; companyName: string; onToast: (message: string) => void }) {
  const [records, setRecords] = useWorkspaceState<ComplianceRecord[]>('compliance-records', [], { scope: workspaceScope, seedWhenEmpty: false, validate: isRecordArray })
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('전체')
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null)
  const [editing, setEditing] = useState<ComplianceRecord | 'new' | null>(null)
  const [aiResult, setAiResult] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [downloadingId, setDownloadingId] = useState('')
  const visible = useMemo(() => records.filter((record) => (category === '전체' || categoryMeta(record.category).id === category) && `${record.name} ${record.category} ${record.authority} ${record.owner}`.toLowerCase().includes(query.trim().toLowerCase())), [category, query, records])
  const selectedRecord = visible.find((record) => record.id === selectedRecordId) ?? visible[0] ?? null
  const needsAction = records.filter((record) => record.status !== '유효')
  const selectCategory = (nextCategory: string) => {
    setCategory(nextCategory)
    const first = records.find((record) => nextCategory === '전체' || categoryMeta(record.category).id === nextCategory)
    setSelectedRecordId(first?.id ?? null)
  }
  const runAiReview = async () => {
    setAiBusy(true)
    try {
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: `${companyName}의 식품안전 인증·검토 일정을 검토하고 지금 해야 할 조치를 우선순위 3개로 제안해 주세요.` }], context: { records: records.map(({ name, category: recordCategory, expiresAt, status, checklist, attachments }) => ({ name, category: recordCategory, expiresAt, status, checklist, attachmentCount: attachments.length })) } }) })
      const body = await response.json() as { text?: string; error?: { message?: string } }
      if (!response.ok || !body.text) throw new Error(body.error?.message || 'AI 검토에 실패했습니다.')
      setAiResult(body.text)
    } catch (error) { setAiResult(error instanceof Error ? error.message : 'AI 검토에 실패했습니다.') }
    finally { setAiBusy(false) }
  }
  const save = async (record: ComplianceRecord) => {
    const result = await setRecords((current) => current.some((item) => item.id === record.id) ? current.map((item) => item.id === record.id ? record : item) : [record, ...current])
    if (result.ok) {
      setSelectedRecordId(record.id)
      onToast(`${record.name} 정보를 저장했습니다.`)
    }
    else onToast(result.message ?? `${record.name} 정보를 저장하지 못했습니다. 새로 업로드한 증빙은 자동 롤백합니다.`)
    return result.ok
  }
  const remove = async (record: ComplianceRecord) => {
    if (!window.confirm(`${record.name} 항목과 연결된 증빙 원본을 함께 삭제할까요?`)) return
    const result = await setRecords((current) => current.filter((item) => item.id !== record.id))
    if (!result.ok) {
      onToast(result.message ?? `${record.name} 항목을 삭제하지 못했습니다. 증빙 원본은 그대로 보존했습니다.`)
      return
    }
    const cleanup = await deleteDocumentAttachments(record.attachments.filter(isStoredDocumentAttachment).map((attachment) => attachment.id), workspaceScope)
    if (selectedRecordId === record.id) setSelectedRecordId(null)
    onToast(cleanup.failed.length
      ? `${record.name} 항목은 삭제했지만 증빙 ${cleanup.failed.length}개의 원본 정리에 실패했습니다.`
      : `${record.name} 항목과 연결된 증빙 원본을 삭제했습니다.`)
  }
  const downloadAttachment = async (attachment: ComplianceRecord['attachments'][number]) => {
    if (!isStoredDocumentAttachment(attachment) || downloadingId) return
    setDownloadingId(attachment.id)
    try { await downloadDocumentAttachment(attachment, workspaceScope) }
    catch (error) { onToast(error instanceof Error ? error.message : '증빙자료를 내려받지 못했습니다.') }
    finally { setDownloadingId('') }
  }
  return <div className="compliance-page">
    <header className="compliance-page-head"><div><span>FOOD SAFETY & CERTIFICATION</span><h1>식품안전 · 인증</h1><p>인증·검사·교육·검교정 일정과 증빙을 항목별로 빠르게 확인합니다.</p></div>{canManage && <button className="button primary" type="button" onClick={() => setEditing('new')}><Plus size={18} /> 새 항목 등록</button>}</header>
    <section className="compliance-overview" aria-label="인증 현황">
      <div className="compliance-overview-stat"><ShieldCheck size={18} /><span>전체</span><strong>{records.length}</strong></div>
      <div className="compliance-overview-stat"><CheckCircle2 size={18} /><span>유효</span><strong>{records.filter((item) => item.status === '유효').length}</strong></div>
      <div className="compliance-overview-stat warning"><CalendarClock size={18} /><span>조치 필요</span><strong>{needsAction.length}</strong></div>
      <button className="compliance-ai-button" type="button" onClick={runAiReview} disabled={aiBusy}><Bot size={18} /><span><strong>{aiBusy ? '분석 중…' : 'AI 우선 조치'}</strong><small>일정·증빙 검토</small></span></button>
    </section>
    {aiResult && <section className="compliance-ai-result"><div><Bot size={21} /><strong>AI 검토 결과</strong></div><p>{aiResult}</p><button type="button" aria-label="AI 검토 결과 닫기" onClick={() => setAiResult('')}><X size={17} /></button></section>}
    <section className="compliance-category-grid" aria-label="관리 분야">
      {complianceCategories.map((item) => {
        const Icon = item.icon
        const count = records.filter((record) => categoryMeta(record.category).id === item.id).length
        return <button type="button" className={`${item.tone}${category === item.id ? ' active' : ''}`} aria-pressed={category === item.id} onClick={() => selectCategory(item.id)} key={item.id}><span><Icon size={18} /></span><div><strong>{item.label}</strong><small>{count}건</small></div><ChevronRight size={15} /></button>
      })}
    </section>
    <section className="compliance-workspace">
      <div className="compliance-list-panel">
        <div className="compliance-toolbar"><label><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="인증·검사·담당자 검색" /></label><button type="button" className={category === '전체' ? 'active' : ''} onClick={() => selectCategory('전체')}>전체 {records.length}</button></div>
        <div className="compliance-list" aria-label="인증·검토 항목">
          {visible.map((record) => {
            const meta = categoryMeta(record.category)
            const Icon = meta.icon
            const selected = selectedRecord?.id === record.id
            return <article className={selected ? 'selected' : ''} key={record.id}>
              <button className="compliance-record-select" type="button" aria-pressed={selected} onClick={() => setSelectedRecordId(record.id)}>
                <span className={`compliance-record-icon ${meta.tone}`}><Icon size={19} /></span>
                <span className="compliance-record-main"><small>{record.category}</small><strong>{record.name}</strong><em>{record.owner} · {record.expiresAt}</em></span>
                <StatusBadge className="compliance-status" tone={complianceStatusTone(record.status)} icon={record.status === '갱신예정' || record.status === '보완필요' ? <AlertTriangle size={13} /> : <CheckCircle2 size={13} />}>{record.status}</StatusBadge>
                <ChevronRight className="compliance-row-chevron" size={17} />
              </button>
              {canManage && <div className="compliance-row-actions"><button type="button" aria-label={`${record.name} 수정`} onClick={() => setEditing(record)}><Pencil size={15} /></button><button className="danger" type="button" aria-label={`${record.name} 삭제`} onClick={() => void remove(record)}><Trash2 size={15} /></button></div>}
            </article>
          })}
          {visible.length === 0 && <div className="compliance-empty compact"><ShieldCheck size={28} /><h2>조건에 맞는 항목이 없습니다</h2><p>검색어나 관리 분야를 바꿔 보세요.</p></div>}
        </div>
      </div>
      <aside className="compliance-detail" aria-label="선택한 인증 상세">
        {selectedRecord ? (() => {
          const meta = categoryMeta(selectedRecord.category)
          const Icon = meta.icon
          return <>
            <header><span className={`compliance-record-icon ${meta.tone}`}><Icon size={21} /></span><div><small>{selectedRecord.category}</small><h2>{selectedRecord.name}</h2></div><StatusBadge className="compliance-status" tone={complianceStatusTone(selectedRecord.status)}>{selectedRecord.status}</StatusBadge></header>
            <dl className="compliance-detail-meta"><div><dt>발급·검토 기관</dt><dd>{selectedRecord.authority}</dd></div><div><dt>관리번호</dt><dd>{selectedRecord.certificateNo}</dd></div><div><dt>담당자</dt><dd>{selectedRecord.owner}</dd></div><div><dt>다음 검토일</dt><dd>{selectedRecord.expiresAt}</dd></div></dl>
            <section><div className="compliance-detail-section-title"><ClipboardCheck size={16} /><strong>필수 확인 항목</strong><span>{selectedRecord.checklist.length}</span></div><ul className="compliance-checklist">{selectedRecord.checklist.map((item) => <li key={item}><CheckCircle2 size={15} />{item}</li>)}{selectedRecord.checklist.length === 0 && <li className="empty">등록된 확인 항목이 없습니다.</li>}</ul></section>
            <section><div className="compliance-detail-section-title"><FileText size={16} /><strong>증빙자료</strong><span>{selectedRecord.attachments.length}</span></div><div className="compliance-detail-files">{selectedRecord.attachments.map((attachment) => <button type="button" disabled={!isStoredDocumentAttachment(attachment) || Boolean(downloadingId)} onClick={() => void downloadAttachment(attachment)} key={attachment.id}><FileText size={15} /><span><strong>{attachment.name}</strong><small>{attachment.size}{!isStoredDocumentAttachment(attachment) ? ' · 원본 없음' : ''}</small></span>{isStoredDocumentAttachment(attachment) && <Download size={15} />}</button>)}{selectedRecord.attachments.length === 0 && <p>등록된 증빙자료가 없습니다.</p>}</div></section>
            {selectedRecord.note && <section className="compliance-detail-note"><strong>관리 메모</strong><p>{selectedRecord.note}</p></section>}
            <footer><span>최근 수정 {formatDateTime(selectedRecord.updatedAt)}</span>{canManage && <div><button className="button secondary" type="button" onClick={() => setEditing(selectedRecord)}><Pencil size={16} /> 수정</button><button className="button ghost danger" type="button" onClick={() => void remove(selectedRecord)}><Trash2 size={16} /> 삭제</button></div>}</footer>
          </>
        })() : <div className="compliance-detail-empty"><FileCheck2 size={30} /><h2>항목을 선택하세요</h2><p>왼쪽 목록에서 인증·검토 항목을 선택하면 상세 정보와 증빙을 확인할 수 있습니다.</p></div>}
      </aside>
    </section>
    {editing && <RecordModal record={editing === 'new' ? undefined : editing} workspaceScope={workspaceScope} onClose={() => setEditing(null)} onSave={save} onToast={onToast} />}
  </div>
}

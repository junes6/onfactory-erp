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
import { applyApprovedValues, canExtractDocumentFile, DOCUMENT_EXTRACTION_FIELDS, readFormValues, requestDocumentExtraction } from '../utils/documentExtraction'
import { DocumentExtractionReview, type DocumentExtractionState } from './DocumentExtractionReview'
import { StatusBadge, type StatusBadgeTone } from './StatusBadge'
import './ComplianceCenter.css'
import { Button } from './ui/Button'

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

/** 내부 상태값을 누구나 이해할 수 있는 표현으로 바꾼다. */
function complianceStatusLabel(status: ComplianceStatus) {
  if (status === '유효') return '정상'
  if (status === '갱신예정') return '갱신 준비'
  if (status === '보완필요') return '증빙 필요'
  return '만료됨'
}

function complianceNextStep(status: ComplianceStatus) {
  if (status === '보완필요') return '인증서·성적서 파일을 첨부하면 정상으로 바뀝니다. 아래 수정 버튼을 눌러 증빙자료를 올려 주세요.'
  if (status === '갱신예정') return '다음 검토일이 90일 이내로 다가왔습니다. 발급 기관에 갱신 신청을 미리 준비하세요.'
  if (status === '만료') return '유효기간이 지났습니다. 재발급 받은 뒤 새 인증서와 검토일을 등록해 주세요.'
  return '지금 필요한 조치가 없습니다. 다음 검토일까지 그대로 두면 됩니다.'
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
    window.setTimeout(() => dialog.querySelector<HTMLElement>('[data-initial-focus]')?.focus() ?? dialog.querySelector<HTMLElement>('[autofocus]')?.focus() ?? focusables()[0]?.focus(), 0)
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

function RecordModal({ record, workspaceScope, currentUserName, onClose, onSave, onToast }: { record?: ComplianceRecord; workspaceScope?: string; currentUserName: string; onClose: () => void; onSave: (record: ComplianceRecord) => Promise<boolean>; onToast: (message: string) => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const uploadButtonRef = useRef<HTMLButtonElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const [attachments, setAttachments] = useState(record?.attachments ?? [])
  const [busy, setBusy] = useState(false)
  const [attachmentBusy, setAttachmentBusy] = useState(false)
  const [downloadingId, setDownloadingId] = useState('')
  const [extraction, setExtraction] = useState<DocumentExtractionState>({ status: 'idle' })
  // 등록은 인증서 파일부터 시작한다. 확인 화면을 마치거나 "직접 입력"을 고른 뒤에만 입력칸이 열린다.
  const [showForm, setShowForm] = useState(Boolean(record))
  const [approved, setApproved] = useState<Record<string, string>>({})
  const uploadedIdsRef = useRef(new Set<string>())
  const removedIdsRef = useRef(new Set<string>())
  const extractionAbortRef = useRef<AbortController | null>(null)
  const extracting = extraction.status === 'extracting'

  const requestClose = async () => {
    extractionAbortRef.current?.abort()
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
  useEffect(() => {
    if (!record) window.setTimeout(() => uploadButtonRef.current?.focus(), 0)
  }, [record])

  const extract = async (attachment: ComplianceRecord['attachments'][number]) => {
    if (!isStoredDocumentAttachment(attachment)) return
    extractionAbortRef.current?.abort()
    const controller = new AbortController()
    extractionAbortRef.current = controller
    setExtraction({ status: 'extracting', sourceId: attachment.id, sourceName: attachment.name })
    try {
      const draft = await requestDocumentExtraction(attachment.id, 'compliance', workspaceScope, controller.signal)
      if (controller.signal.aborted) return
      setExtraction({ status: 'review', sourceId: attachment.id, sourceName: attachment.name, draft })
    } catch (error) {
      if (controller.signal.aborted) return
      setShowForm(true)
      setExtraction({ status: 'failed', sourceId: attachment.id, sourceName: attachment.name, message: error instanceof Error ? error.message : 'AI가 파일을 읽지 못했습니다.' })
    }
  }

  /** 확인 화면에서 승인한 값만 입력칸에 넣는다. 자동 확정하지 않는다. */
  const approveExtraction = (values: Record<string, string>) => {
    if (extraction.status !== 'review') return
    const typed = readFormValues(formRef.current, DOCUMENT_EXTRACTION_FIELDS.compliance.map((field) => field.name))
    setApproved((current) => ({ ...current, ...typed, ...values }))
    applyApprovedValues(formRef.current, values)
    setShowForm(true)
    setExtraction({
      status: 'applied', sourceId: extraction.sourceId, sourceName: extraction.sourceName,
      appliedFields: Object.keys(values).length, confidence: extraction.draft.confidence, warnings: extraction.draft.warnings,
    })
  }

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
      const sourceIndex = files.findIndex(canExtractDocumentFile)
      if (sourceIndex >= 0 && additions[sourceIndex]) void extract(additions[sourceIndex])
    } catch (error) {
      onToast(error instanceof Error ? error.message : '증빙자료를 업로드하지 못했습니다.')
    } finally {
      setAttachmentBusy(false)
    }
  }

  const removeAttachment = async (attachment: ComplianceRecord['attachments'][number]) => {
    if (busy || attachmentBusy) return
    if (extraction.sourceId === attachment.id) { extractionAbortRef.current?.abort(); setExtraction({ status: 'idle' }) }
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
      <form ref={formRef} onSubmit={async (event: FormEvent<HTMLFormElement>) => {
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
        <section className="compliance-attachments"><input ref={fileRef} className="sr-only" type="file" multiple onChange={(event) => void attachFiles(event)} /><div><strong>인증서 원본부터 올려 주세요</strong><span>PDF·이미지는 AI가 번호·기관·날짜를 읽고, 원문 근거와 함께 확인 화면에 보여 드립니다.</span></div><Button tone="secondary" ref={uploadButtonRef} type="button" data-initial-focus={!record ? 'true' : undefined} disabled={busy || attachmentBusy} onClick={() => fileRef.current?.click()}><Upload size={17} /> {attachmentBusy ? '처리 중…' : '파일 선택'}</Button></section>
        <div className="compliance-file-list">{attachments.map((file) => <span key={file.id}><FileText size={15} /><span>{file.name} · {file.size}<small>{isStoredDocumentAttachment(file) ? '원본 저장됨' : '이전 파일 정보 · 원본 없음'}</small></span>{isStoredDocumentAttachment(file) && <button type="button" aria-label={`${file.name} 원본 보기`} disabled={Boolean(downloadingId)} onClick={() => void downloadAttachment(file)}><Download size={14} /></button>}<button type="button" aria-label={`${file.name} 제거`} disabled={busy || attachmentBusy} onClick={() => void removeAttachment(file)}><X size={14} /></button></span>)}</div>
        <DocumentExtractionReview
          kind="compliance"
          state={extraction}
          disabled={busy || attachmentBusy}
          onApprove={approveExtraction}
          onDismiss={() => { setShowForm(true); setExtraction({ status: 'idle' }) }}
          onRetry={extraction.status !== 'review' && extraction.sourceId ? () => { const source = attachments.find((attachment) => attachment.id === extraction.sourceId); if (source) void extract(source) } : undefined}
        />
        {!showForm
          ? <section className="compliance-manual-entry"><p>파일이 없거나 AI 없이 등록하려면 직접 입력할 수 있습니다.</p><div><Button tone="ghost" type="button" disabled={busy || attachmentBusy} onClick={() => void requestClose()}>취소</Button><Button tone="secondary" type="button" disabled={busy || attachmentBusy || extracting} onClick={() => setShowForm(true)}>파일 없이 직접 입력</Button></div></section>
          : <>
        <div className="compliance-form-grid">
          <label><span>관리 분류</span><select name="category" defaultValue={approved.category ?? record?.category ?? ''} required><option value="" disabled>분류 선택</option><option>HACCP</option><option>품목제조보고</option><option>자가품질검사</option><option>식품표시 검토</option><option>위생교육</option><option>검교정</option><option>ISO 22000</option><option>FSSC 22000</option><option>기타 인증</option></select></label>
          <label><span>담당자</span><input name="owner" defaultValue={record?.owner ?? currentUserName} required /></label>
          <label className="full"><span>인증·검토 명칭</span><input name="name" defaultValue={approved.name ?? record?.name} required autoFocus /></label>
          <label><span>발급·검토 기관</span><input name="authority" defaultValue={approved.authority ?? record?.authority} required /></label>
          <label><span>인증·보고 번호</span><input name="certificateNo" defaultValue={approved.certificateNo ?? record?.certificateNo} placeholder="없으면 내부 관리번호" required /></label>
          <label><span>발급·확인일</span><input name="issuedAt" type="date" defaultValue={approved.issuedAt ?? record?.issuedAt ?? ''} required /></label>
          <label><span>유효·다음 검토일</span><input name="expiresAt" type="date" defaultValue={approved.expiresAt ?? record?.expiresAt} required /></label>
          <label className="full"><span>필수 확인 항목 · 한 줄에 하나</span><textarea name="checklist" rows={4} defaultValue={record?.checklist.join('\n')} placeholder={'예: 인증서 원본 확인\n갱신 신청 일정 등록'} /></label>
          <label className="full"><span>메모</span><textarea name="note" rows={3} defaultValue={record?.note} /></label>
        </div>
        <footer><Button tone="ghost" type="button" disabled={busy || attachmentBusy} onClick={() => void requestClose()}>취소</Button><Button tone="primary" type="submit" disabled={busy || attachmentBusy || extracting}><FileCheck2 size={18} /> {busy ? '저장 중…' : extracting ? 'AI 읽는 중…' : '확인 후 저장'}</Button></footer>
          </>}
      </form>
    </section>
  </div>
}

export function ComplianceCenter({ workspaceScope, canManage, currentUserName, companyName, onToast }: { workspaceScope?: string; canManage: boolean; currentUserName: string; companyName: string; onToast: (message: string) => void }) {
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
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ feature: 'compliance-review', messages: [{ role: 'user', content: `${companyName}의 식품안전 인증·검토 일정을 검토하고 지금 해야 할 조치를 우선순위 3개로 제안해 주세요.` }], context: { records: records.map(({ name, category: recordCategory, expiresAt, status, checklist, attachments }) => ({ name, category: recordCategory, expiresAt, status, checklist, attachmentCount: attachments.length })) } }) })
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
    <header className="compliance-page-head"><div><span>FOOD SAFETY & CERTIFICATION</span><h1>식품안전 · 인증</h1><p>인증·검사·교육·검교정 일정과 증빙을 항목별로 빠르게 확인합니다.</p></div>{canManage && <Button tone="primary" type="button" onClick={() => setEditing('new')}><Plus size={18} /> 새 항목 등록</Button>}</header>

    <section className="compliance-topline" aria-label="인증 현황 요약">
      <span><ShieldCheck size={16} /> 전체 <strong>{records.length}</strong></span>
      <i aria-hidden="true" />
      <span className="is-good"><CheckCircle2 size={16} /> 정상 <strong>{records.filter((item) => item.status === '유효').length}</strong></span>
      <i aria-hidden="true" />
      <span className={needsAction.length ? 'is-warn' : ''}><CalendarClock size={16} /> 조치 필요 <strong>{needsAction.length}</strong></span>
      <button type="button" onClick={runAiReview} disabled={aiBusy}><Bot size={16} /> {aiBusy ? '분석 중…' : 'AI 우선 조치'}</button>
    </section>

    {needsAction.length > 0 && <section className="compliance-action-strip" aria-label="지금 조치가 필요한 항목">
      <div className="compliance-action-head"><AlertTriangle size={17} /><strong>지금 조치가 필요한 항목</strong><span>{needsAction.length}건</span></div>
      <div className="compliance-action-list">
        {needsAction.slice(0, 4).map((record) => <button type="button" key={record.id} onClick={() => { setCategory('전체'); setSelectedRecordId(record.id) }}>
          <StatusBadge className="compliance-status" tone={complianceStatusTone(record.status)}>{complianceStatusLabel(record.status)}</StatusBadge>
          <strong>{record.name}</strong>
          <small>{record.status === '만료' ? '유효기간 지남' : record.status === '보완필요' ? '증빙자료 첨부 필요' : `다음 검토일 ${record.expiresAt}`}</small>
          <ChevronRight size={15} />
        </button>)}
      </div>
    </section>}

    {aiResult && <section className="compliance-ai-result"><div><Bot size={21} /><strong>AI 검토 결과</strong></div><p>{aiResult}</p><button type="button" aria-label="AI 검토 결과 닫기" onClick={() => setAiResult('')}><X size={17} /></button></section>}

    <section className="compliance-workspace">
      <div className="compliance-list-panel">
        <div className="compliance-toolbar"><label><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="인증·검사·담당자 검색" /></label></div>
        <div className="compliance-category-chips" role="group" aria-label="관리 분야 필터">
          <button type="button" className={category === '전체' ? 'active' : ''} aria-pressed={category === '전체'} onClick={() => selectCategory('전체')}>전체 <em>{records.length}</em></button>
          {complianceCategories.map((item) => {
            const count = records.filter((record) => categoryMeta(record.category).id === item.id).length
            return <button type="button" className={category === item.id ? 'active' : ''} aria-pressed={category === item.id} onClick={() => selectCategory(item.id)} key={item.id}>{item.label} <em>{count}</em></button>
          })}
        </div>
        <div className="compliance-list" aria-label="인증·검토 항목">
          {visible.map((record) => {
            const meta = categoryMeta(record.category)
            const Icon = meta.icon
            const selected = selectedRecord?.id === record.id
            return <article className={`status-${complianceStatusTone(record.status)}${selected ? ' selected' : ''}`} key={record.id}>
              <button className="compliance-record-select" type="button" aria-pressed={selected} onClick={() => setSelectedRecordId(record.id)}>
                <span className={`compliance-record-icon ${meta.tone}`}><Icon size={19} /></span>
                <span className="compliance-record-main"><small>{record.category}</small><strong>{record.name}</strong><em>{record.owner} · 다음 검토 {record.expiresAt}</em></span>
                <StatusBadge className="compliance-status" tone={complianceStatusTone(record.status)} icon={record.status === '갱신예정' || record.status === '보완필요' ? <AlertTriangle size={13} /> : <CheckCircle2 size={13} />}>{complianceStatusLabel(record.status)}</StatusBadge>
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
            <header><span className={`compliance-record-icon ${meta.tone}`}><Icon size={21} /></span><div><small>{selectedRecord.category}</small><h2>{selectedRecord.name}</h2></div><StatusBadge className="compliance-status" tone={complianceStatusTone(selectedRecord.status)}>{complianceStatusLabel(selectedRecord.status)}</StatusBadge></header>
            <div className={`compliance-next-step tone-${complianceStatusTone(selectedRecord.status)}`}><ClipboardCheck size={17} /><div><strong>지금 할 일</strong><p>{complianceNextStep(selectedRecord.status)}</p></div></div>
            <dl className="compliance-detail-meta"><div><dt>발급·검토 기관</dt><dd>{selectedRecord.authority}</dd></div><div><dt>관리번호</dt><dd>{selectedRecord.certificateNo}</dd></div><div><dt>담당자</dt><dd>{selectedRecord.owner}</dd></div><div><dt>다음 검토일</dt><dd>{selectedRecord.expiresAt}</dd></div></dl>
            <section><div className="compliance-detail-section-title"><ClipboardCheck size={16} /><strong>필수 확인 항목</strong><span>{selectedRecord.checklist.length}</span></div><ul className="compliance-checklist">{selectedRecord.checklist.map((item) => <li key={item}><CheckCircle2 size={15} />{item}</li>)}{selectedRecord.checklist.length === 0 && <li className="empty">등록된 확인 항목이 없습니다.</li>}</ul></section>
            <section><div className="compliance-detail-section-title"><FileText size={16} /><strong>증빙자료</strong><span>{selectedRecord.attachments.length}</span></div><div className="compliance-detail-files">{selectedRecord.attachments.map((attachment) => <button type="button" disabled={!isStoredDocumentAttachment(attachment) || Boolean(downloadingId)} onClick={() => void downloadAttachment(attachment)} key={attachment.id}><FileText size={15} /><span><strong>{attachment.name}</strong><small>{attachment.size}{!isStoredDocumentAttachment(attachment) ? ' · 원본 없음' : ''}</small></span>{isStoredDocumentAttachment(attachment) && <Download size={15} />}</button>)}{selectedRecord.attachments.length === 0 && <p>등록된 증빙자료가 없습니다.</p>}</div></section>
            {selectedRecord.note && <section className="compliance-detail-note"><strong>관리 메모</strong><p>{selectedRecord.note}</p></section>}
            <footer><span>최근 수정 {formatDateTime(selectedRecord.updatedAt)}</span>{canManage && <div><Button tone="secondary" size="sm" type="button" onClick={() => setEditing(selectedRecord)}><Pencil size={16} /> 수정</Button><Button tone="danger" size="sm" type="button" onClick={() => void remove(selectedRecord)}><Trash2 size={16} /> 삭제</Button></div>}</footer>
          </>
        })() : <div className="compliance-detail-empty"><FileCheck2 size={30} /><h2>항목을 선택하세요</h2><p>왼쪽 목록에서 인증·검토 항목을 선택하면 상세 정보와 증빙을 확인할 수 있습니다.</p></div>}
      </aside>
    </section>
    {editing && <RecordModal record={editing === 'new' ? undefined : editing} workspaceScope={workspaceScope} currentUserName={currentUserName} onClose={() => setEditing(null)} onSave={save} onToast={onToast} />}
  </div>
}

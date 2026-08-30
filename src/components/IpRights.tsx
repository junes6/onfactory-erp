import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Award, BadgeCheck, Check, Copyright, Download, FileBadge, Paperclip, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useWorkspaceState } from '../hooks/useWorkspaceState'
import { formatDateLabel, seoulDateInputValue } from '../utils/dateTime'
import {
  deleteDocumentAttachments,
  downloadDocumentAttachment,
  isStoredDocumentAttachment,
  uploadDocumentAttachments,
  type StoredDocumentAttachment,
} from '../utils/documentAttachments'
import { applyApprovedValues, canExtractDocumentFile, DOCUMENT_EXTRACTION_FIELDS, readFormValues, requestDocumentExtraction } from '../utils/documentExtraction'
import { DocumentExtractionReview, type DocumentExtractionState } from './DocumentExtractionReview'
import { StatusBadge, type StatusBadgeTone } from './StatusBadge'
import './IpRights.css'

// 지식재산권·인증서: 등록증 원본 파일을 업로드해 두고 만료를 관리한다.
type IpKind = '특허' | '실용신안' | '상표' | '디자인' | '저작권' | '인증서' | '등록증' | '기타'
type IpStatus = '준비' | '출원' | '심사 중' | '등록' | '갱신 필요' | '만료'
type IpRight = {
  id: string
  kind: IpKind
  title: string
  number: string
  holder: string
  issuer?: string
  filedAt: string
  registeredAt: string
  expiresAt: string
  status: IpStatus
  owner: string
  note: string
  attachments: StoredDocumentAttachment[]
  updatedAt: string
}

const IP_KINDS: IpKind[] = ['특허', '실용신안', '상표', '디자인', '저작권', '인증서', '등록증', '기타']
const IP_STATUSES: IpStatus[] = ['준비', '출원', '심사 중', '등록', '갱신 필요', '만료']
const isIpRights = (value: unknown): value is IpRight[] => Array.isArray(value) && value.every((item) => item && typeof item.id === 'string' && typeof item.title === 'string' && Array.isArray(item.attachments))

function useIpDialog(onClose: () => void, locked: boolean, initialFocus?: () => HTMLElement | null) {
  const ref = useRef<HTMLElement>(null)
  const closeRef = useRef(onClose)
  const lockedRef = useRef(locked)
  const initialFocusRef = useRef(initialFocus)
  closeRef.current = onClose
  lockedRef.current = locked
  initialFocusRef.current = initialFocus
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const selector = 'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])'
    const focusables = () => Array.from(dialog.querySelectorAll<HTMLElement>(selector))
    const focusTimer = window.setTimeout(() => initialFocusRef.current?.()?.focus() ?? dialog.querySelector<HTMLElement>('[data-initial-focus]')?.focus() ?? focusables()[0]?.focus(), 0)
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (!lockedRef.current) closeRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const controls = focusables()
      if (!controls.length) return
      const first = controls[0]
      const last = controls.at(-1)!
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    dialog.addEventListener('keydown', keydown)
    return () => { window.clearTimeout(focusTimer); dialog.removeEventListener('keydown', keydown); previous?.focus() }
  }, [])
  return ref
}

function ipTone(status: IpStatus): StatusBadgeTone {
  return status === '등록' ? 'success' : status === '심사 중' || status === '출원' ? 'info' : status === '갱신 필요' ? 'warning' : status === '만료' ? 'danger' : 'neutral'
}
function kindIcon(kind: IpKind) {
  return kind === '특허' || kind === '실용신안' ? Award : kind === '저작권' ? Copyright : kind === '인증서' || kind === '등록증' ? BadgeCheck : FileBadge
}

export function IpRightsPage({ workspaceScope, canManage, currentUserName, onToast }: { workspaceScope?: string; canManage: boolean; currentUserName: string; onToast: (message: string) => void }) {
  const [rights, setRights] = useWorkspaceState<IpRight[]>('ip-rights', [], { scope: workspaceScope, seedWhenEmpty: false, validate: isIpRights })
  const [editor, setEditor] = useState<{ item?: IpRight } | null>(null)
  const [kindFilter, setKindFilter] = useState<'전체' | IpKind>('전체')
  const today = seoulDateInputValue()

  const sorted = useMemo(() => [...rights].sort((left, right) => (left.expiresAt || '9999').localeCompare(right.expiresAt || '9999')), [rights])
  const visible = sorted.filter((right) => kindFilter === '전체' || right.kind === kindFilter)
  const expiring = rights.filter((right) => right.expiresAt && right.status !== '만료' && Math.ceil((Date.parse(right.expiresAt) - Date.parse(today)) / 86_400_000) <= 60)
  const registered = rights.filter((right) => right.status === '등록').length
  const kinds = ['전체', ...new Set(rights.map((right) => right.kind))] as Array<'전체' | IpKind>

  const download = async (attachment: StoredDocumentAttachment) => {
    try { await downloadDocumentAttachment(attachment, workspaceScope) } catch (error) { onToast(error instanceof Error ? error.message : '파일을 내려받지 못했습니다.') }
  }
  const dday = (expiresAt: string) => {
    if (!expiresAt) return null
    const days = Math.ceil((Date.parse(expiresAt) - Date.parse(today)) / 86_400_000)
    return { label: days < 0 ? `만료 ${Math.abs(days)}일 지남` : `만료 D-${days}`, urgent: days <= 60 }
  }
  const remove = async (right: IpRight) => {
    if (!window.confirm(`‘${right.title}’을(를) 삭제할까요? 첨부한 등록증 파일도 함께 삭제됩니다.`)) return
    const result = await setRights((current) => current.filter((item) => item.id !== right.id))
    if (!result.ok) { onToast(result.message ?? '삭제하지 못했습니다.'); return }
    await deleteDocumentAttachments(right.attachments.filter(isStoredDocumentAttachment).map((item) => item.id), workspaceScope)
    onToast('삭제했습니다.')
  }

  return <div className="content-page ip-page">
    <header className="page-header">
      <div><span className="eyebrow">IP & CERTIFICATES</span><h1>지식재산 · 인증</h1><p>특허·상표·저작권과 인증서·등록증을 한 대장에서 관리합니다. 원본 파일을 올려 두면 언제든 내려받을 수 있고, 만료 60일 전부터 강조됩니다.</p></div>
      <div className="page-header-actions">{canManage && <button className="button primary" type="button" onClick={() => setEditor({})}><Plus size={18} /> 권리 · 인증 등록</button>}</div>
    </header>
    <section className="ip-summary" aria-label="지식재산 요약">
      <article><span><Award size={18} /></span><div><small>전체 권리·인증</small><strong>{rights.length}건</strong></div></article>
      <article><span><BadgeCheck size={18} /></span><div><small>등록 완료</small><strong>{registered}건</strong></div></article>
      <article className={expiring.length ? 'is-warn' : ''}><span><FileBadge size={18} /></span><div><small>60일 내 만료</small><strong>{expiring.length}건</strong></div></article>
    </section>
    {kinds.length > 2 && <div className="segmented ip-filter" role="group" aria-label="유형 필터">{kinds.map((kind) => <button type="button" key={kind} className={kindFilter === kind ? 'active' : ''} aria-pressed={kindFilter === kind} onClick={() => setKindFilter(kind)}>{kind}</button>)}</div>}
    <section className="panel it-list-panel">
      {visible.length === 0
        ? <div className="empty-state"><Award size={30} /><h3>등록된 권리·인증이 없습니다</h3><p>특허·상표 출원부터 ISO 인증서, 각종 등록증까지 — 명칭과 파일만으로 시작하세요.</p>{canManage && <button className="button primary" type="button" onClick={() => setEditor({})}><Plus size={18} /> 첫 항목 등록</button>}</div>
        : <div className="it-rows" role="list">{visible.map((right) => { const due = dday(right.expiresAt); const Icon = kindIcon(right.kind); return <article className="it-row" role="listitem" key={right.id}>
          <span className="ip-kind-mark"><Icon size={17} /></span>
          <StatusBadge className="status-pill" dot tone={ipTone(right.status)}>{right.status}</StatusBadge>
          <div className="it-row-main"><strong>{right.title}</strong><small>{right.kind}{right.number ? ` · ${right.number}` : ''}{right.holder ? ` · 권리자 ${right.holder}` : ''}{right.issuer ? ` · ${right.issuer}` : ''}{right.registeredAt ? ` · 등록 ${formatDateLabel(right.registeredAt)}` : right.filedAt ? ` · 출원 ${formatDateLabel(right.filedAt)}` : ''}</small></div>
          {due && right.status !== '만료' && <span className={`it-row-meta${due.urgent ? ' is-urgent' : ''}`}>{due.label}</span>}
          <div className="it-row-files">{right.attachments.length === 0 ? <span className="it-row-meta">파일 없음</span> : right.attachments.map((file) => <button type="button" key={file.id} onClick={() => void download(file)}><Download size={13} /> {file.name}</button>)}</div>
          {canManage && <div className="it-row-actions"><button type="button" aria-label={`${right.title} 수정`} onClick={() => setEditor({ item: right })}><Pencil size={15} /></button><button type="button" aria-label={`${right.title} 삭제`} onClick={() => void remove(right)}><Trash2 size={15} /></button></div>}
        </article> })}</div>}
    </section>
    {editor && <IpEditor item={editor.item} workspaceScope={workspaceScope} currentUserName={currentUserName} onToast={onToast} onClose={() => setEditor(null)} onSave={async (next) => {
      const result = await setRights((current) => current.some((item) => item.id === next.id) ? current.map((item) => item.id === next.id ? next : item) : [next, ...current])
      if (!result.ok) { onToast(result.message ?? '저장하지 못했습니다.'); return false }
      onToast(`${next.title}을(를) 저장했습니다.`)
      return true
    }} />}
  </div>
}

function IpEditor({ item, workspaceScope, currentUserName, onToast, onClose, onSave }: { item?: IpRight; workspaceScope?: string; currentUserName: string; onToast: (message: string) => void; onClose: () => void; onSave: (next: IpRight) => Promise<boolean> }) {
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [closing, setClosing] = useState(false)
  const [attachments, setAttachments] = useState<StoredDocumentAttachment[]>(item?.attachments ?? [])
  const [extraction, setExtraction] = useState<DocumentExtractionState>({ status: 'idle' })
  // 등록은 파일 업로드부터 시작한다. 확인 화면을 마치거나 "직접 입력"을 고른 뒤에만 폼이 열린다.
  const [showForm, setShowForm] = useState(Boolean(item))
  const [approved, setApproved] = useState<Record<string, string>>({})
  const fileRef = useRef<HTMLInputElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const uploadedRef = useRef(new Set<string>())
  const removedRef = useRef(new Set<string>())
  const extractionAbortRef = useRef<AbortController | null>(null)
  const closingRef = useRef(false)
  const uploadButtonRef = useRef<HTMLButtonElement>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const extracting = extraction.status === 'extracting'
  const locked = busy || uploading || closing

  const extract = async (attachment: StoredDocumentAttachment) => {
    extractionAbortRef.current?.abort()
    const controller = new AbortController()
    extractionAbortRef.current = controller
    setExtraction({ status: 'extracting', sourceId: attachment.id, sourceName: attachment.name })
    try {
      const draft = await requestDocumentExtraction(attachment.id, 'ip-right', workspaceScope, controller.signal)
      if (controller.signal.aborted) return
      setExtraction({ status: 'review', sourceId: attachment.id, sourceName: attachment.name, draft })
    } catch (error) {
      if (controller.signal.aborted) return
      setShowForm(true)
      setExtraction({ status: 'failed', sourceId: attachment.id, sourceName: attachment.name, message: error instanceof Error ? error.message : 'AI가 파일을 읽지 못했습니다.' })
    }
  }

  /** 확인 화면에서 승인한 값만 폼에 넣는다. 사용자가 이미 손으로 친 값은 지우지 않는다. */
  const approveExtraction = (values: Record<string, string>) => {
    if (extraction.status !== 'review') return
    const typed = readFormValues(formRef.current, DOCUMENT_EXTRACTION_FIELDS['ip-right'].map((field) => field.name))
    setApproved((current) => ({ ...current, ...typed, ...values }))
    applyApprovedValues(formRef.current, values)
    setShowForm(true)
    setExtraction({
      status: 'applied', sourceId: extraction.sourceId, sourceName: extraction.sourceName,
      appliedFields: Object.keys(values).length, confidence: extraction.draft.confidence, warnings: extraction.draft.warnings,
    })
  }

  const cancel = async () => {
    if (busy || uploading || closingRef.current) return
    closingRef.current = true
    setClosing(true)
    extractionAbortRef.current?.abort()
    if (uploadedRef.current.size) {
      const cleanup = await deleteDocumentAttachments([...uploadedRef.current], workspaceScope)
      for (const id of cleanup.deleted) uploadedRef.current.delete(id)
      if (cleanup.deleted.length) {
        const deleted = new Set(cleanup.deleted)
        setAttachments((current) => current.filter((attachment) => !deleted.has(attachment.id)))
      }
      if (cleanup.failed.length) {
        closingRef.current = false
        setClosing(false)
        onToast(`저장하지 않은 원본 ${cleanup.failed.length}개를 정리하지 못했습니다. 실패한 파일만 다시 정리해 주세요.`)
        return
      }
    }
    onClose()
  }
  const removeAttachment = async (attachment: StoredDocumentAttachment) => {
    if (locked) return
    if (extraction.sourceId === attachment.id) { extractionAbortRef.current?.abort(); setExtraction({ status: 'idle' }) }
    if (isStoredDocumentAttachment(attachment) && uploadedRef.current.has(attachment.id)) {
      setUploading(true)
      const cleanup = await deleteDocumentAttachments([attachment.id], workspaceScope)
      if (cleanup.failed.length) { onToast(cleanup.failed[0].message); setUploading(false); return }
      uploadedRef.current.delete(attachment.id)
      setUploading(false)
    } else if (isStoredDocumentAttachment(attachment)) removedRef.current.add(attachment.id)
    setAttachments((current) => current.filter((entry) => entry.id !== attachment.id))
  }
  const download = async (attachment: StoredDocumentAttachment) => {
    try { await downloadDocumentAttachment(attachment, workspaceScope) }
    catch (error) { onToast(error instanceof Error ? error.message : '원본 파일을 내려받지 못했습니다.') }
  }
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (locked || extracting) return
    const data = new FormData(event.currentTarget)
    const field = (name: string) => String(data.get(name) ?? '').trim()
    if (!field('title')) return
    const next: IpRight = {
      id: item?.id ?? `IP-${Date.now()}`,
      kind: IP_KINDS.includes(field('kind') as IpKind) ? field('kind') as IpKind : '기타',
      title: field('title'),
      number: field('number'),
      holder: field('holder'),
      issuer: field('issuer'),
      filedAt: field('filedAt'),
      registeredAt: field('registeredAt'),
      expiresAt: field('expiresAt'),
      status: IP_STATUSES.includes(field('status') as IpStatus) ? field('status') as IpStatus : '준비',
      owner: field('owner'),
      note: field('note'),
      attachments,
      updatedAt: new Date().toISOString(),
    }
    setBusy(true)
    if (await onSave(next)) {
      uploadedRef.current.clear()
      const cleanup = await deleteDocumentAttachments(removedRef.current, workspaceScope)
      removedRef.current.clear()
      if (cleanup.failed.length) onToast(`항목은 저장했지만 제외한 원본 ${cleanup.failed.length}개를 정리하지 못했습니다.`)
      onClose()
      return
    }
    const rollback = await deleteDocumentAttachments(uploadedRef.current, workspaceScope)
    for (const id of rollback.deleted) uploadedRef.current.delete(id)
    if (rollback.deleted.length) {
      const deleted = new Set(rollback.deleted)
      setAttachments((current) => current.filter((attachment) => !deleted.has(attachment.id)))
    }
    if (rollback.failed.length) onToast(`저장 실패 후 새 원본 ${rollback.failed.length}개를 정리하지 못했습니다.`)
    setBusy(false)
  }
  const dialogRef = useIpDialog(() => { void cancel() }, locked, () => item ? titleInputRef.current : uploadButtonRef.current)
  useEffect(() => {
    const focusTimer = window.setTimeout(() => (item ? titleInputRef.current : uploadButtonRef.current)?.focus(), 0)
    return () => window.clearTimeout(focusTimer)
  }, [item])
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (!locked && event.target === event.currentTarget) void cancel() }}>
    <section ref={dialogRef} className="modal-card it-modal" role="dialog" aria-modal="true" aria-labelledby="ip-editor-title" aria-busy={locked}>
      <header><div><span className="eyebrow">IP RIGHT</span><h2 id="ip-editor-title">{item ? '권리 · 인증 수정' : '권리 · 인증 등록'}</h2><p>{item ? '등록증·인증서 원본을 다시 올리면 값을 새로 읽어 드립니다.' : '특허증·등록증·인증서 파일을 올리면 명칭·번호·날짜를 읽어 확인 화면에 보여 드립니다.'}</p></div><button className="icon-button" type="button" aria-label="닫기" disabled={locked} onClick={() => void cancel()}><X size={21} /></button></header>
      <form ref={formRef} onSubmit={submit}>
        <section className="it-upload"><div><strong>등록증 · 인증서 파일 <small>PDF·이미지는 AI 자동 입력</small></strong></div>
          <input ref={fileRef} className="sr-only" type="file" multiple accept="application/pdf,image/jpeg,image/png,image/gif,image/webp" onChange={async (event) => {
            const files = Array.from(event.target.files ?? []); event.target.value = ''
            if (!files.length) return
            setUploading(true)
            try {
              const added = await uploadDocumentAttachments(files, { workspaceScope, category: '지식재산·인증', summary: '지식재산·인증 문서', tags: ['지식재산', 'AI-판독대상'] })
              for (const file of added) uploadedRef.current.add(file.id)
              setAttachments((current) => [...current, ...added])
              const sourceIndex = files.findIndex(canExtractDocumentFile)
              if (sourceIndex >= 0 && added[sourceIndex]) void extract(added[sourceIndex])
            } catch (error) { onToast(error instanceof Error ? error.message : '파일을 업로드하지 못했습니다.') }
            finally { setUploading(false) }
          }} />
          <button ref={uploadButtonRef} className="button secondary" type="button" data-initial-focus={!item ? 'true' : undefined} disabled={locked} onClick={() => fileRef.current?.click()}><Paperclip size={17} /> {uploading ? '업로드 중…' : '파일 추가'}</button>
        </section>
        {attachments.length > 0 && <div className="it-file-list">{attachments.map((file) => <span key={file.id}><Paperclip size={14} /> {file.name} · {file.size}<button type="button" aria-label={`${file.name} 원본 보기`} disabled={locked} onClick={() => void download(file)}><Download size={13} /></button><button type="button" aria-label={`${file.name} 제외`} disabled={locked} onClick={() => void removeAttachment(file)}><X size={13} /></button></span>)}</div>}
        <DocumentExtractionReview
          kind="ip-right"
          state={extraction}
          disabled={locked}
          onApprove={approveExtraction}
          onDismiss={() => { setShowForm(true); setExtraction({ status: 'idle' }) }}
          onRetry={extraction.status !== 'review' && extraction.sourceId ? () => { const source = attachments.find((attachment) => attachment.id === extraction.sourceId); if (source) void extract(source) } : undefined}
        />
        {!showForm
          ? <section className="it-manual-entry"><p>파일이 없거나 AI 없이 등록하려면 직접 입력할 수 있습니다.</p><div><button type="button" className="button ghost" disabled={locked} onClick={() => void cancel()}>{closing ? '정리 중…' : '취소'}</button><button type="button" className="button secondary" disabled={locked || extracting} onClick={() => setShowForm(true)}>파일 없이 직접 입력</button></div></section>
          : <>
        <div className="form-grid"><label className="form-field"><span>명칭 <em className="field-required">필수</em></span><input ref={titleInputRef} name="title" data-initial-focus={item ? 'true' : undefined} defaultValue={approved.title ?? item?.title ?? ''} required placeholder="예: 3D 시뮬레이션 렌더링 방법 특허" /></label><label className="form-field"><span>유형</span><select name="kind" defaultValue={approved.kind ?? item?.kind ?? ''} required><option value="" disabled>유형 선택</option>{IP_KINDS.map((kind) => <option key={kind}>{kind}</option>)}</select></label></div>
        <div className="form-grid"><label className="form-field"><span>출원 · 등록번호</span><input name="number" defaultValue={approved.number ?? item?.number ?? ''} placeholder="예: 10-2026-0012345" /></label><label className="form-field"><span>권리자</span><input name="holder" defaultValue={approved.holder ?? item?.holder ?? ''} placeholder="예: 주식회사 3D뮤즈" /></label></div>
        <label className="form-field full"><span>발급 · 관할 기관</span><input name="issuer" defaultValue={approved.issuer ?? item?.issuer ?? ''} placeholder="예: 특허청" /></label>
        <div className="form-grid"><label className="form-field"><span>출원일</span><input name="filedAt" type="date" defaultValue={approved.filedAt ?? item?.filedAt ?? ''} /></label><label className="form-field"><span>등록일</span><input name="registeredAt" type="date" defaultValue={approved.registeredAt ?? item?.registeredAt ?? ''} /></label></div>
        <div className="form-grid"><label className="form-field"><span>만료 · 갱신일</span><input name="expiresAt" type="date" defaultValue={approved.expiresAt ?? item?.expiresAt ?? ''} /></label><label className="form-field"><span>상태</span><select name="status" defaultValue={item?.status ?? '등록'}>{IP_STATUSES.map((status) => <option key={status}>{status}</option>)}</select></label></div>
        <label className="form-field full"><span>담당자</span><input name="owner" defaultValue={item?.owner ?? currentUserName} /></label>
        <label className="form-field full"><span>메모</span><textarea name="note" rows={2} defaultValue={item?.note ?? ''} placeholder="연차료 납부·갱신 절차 등" /></label>
        <footer><button type="button" className="button ghost" disabled={locked} onClick={() => void cancel()}>{closing ? '정리 중…' : '취소'}</button><button type="submit" className="button primary" disabled={locked || extracting}><Check size={18} /> {busy ? '저장 중…' : extracting ? 'AI 읽는 중…' : '확인 후 저장'}</button></footer>
          </>}
      </form>
    </section>
  </div>
}

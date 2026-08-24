import { useMemo, useRef, useState, type FormEvent } from 'react'
import { Banknote, Boxes, Check, Coins, Download, Landmark, Paperclip, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useWorkspaceState } from '../hooks/useWorkspaceState'
import { formatDateLabel, seoulDateInputValue } from '../utils/dateTime'
import {
  deleteDocumentAttachments,
  downloadDocumentAttachment,
  isStoredDocumentAttachment,
  uploadDocumentAttachments,
  type StoredDocumentAttachment,
} from '../utils/documentAttachments'
import { StatusBadge, type StatusBadgeTone } from './StatusBadge'
import './TaxAssets.css'

// 자산: 취득가·상태·담당과 증빙 파일을 관리한다.
type AssetKind = '비품' | '장비' | '차량' | '소프트웨어' | '부동산' | '기타'
type AssetStatus = '사용 중' | '수리 중' | '보관' | '폐기'
type CompanyAsset = {
  id: string
  name: string
  kind: AssetKind
  serial: string
  acquiredAt: string
  price: number
  status: AssetStatus
  owner: string
  location: string
  note: string
  attachments: StoredDocumentAttachment[]
  updatedAt: string
}
// 세무 일정: 신고·납부 기한과 증빙을 관리한다.
type TaxKind = '부가가치세' | '원천세' | '법인세' | '종합소득세' | '지방세' | '4대보험' | '기타'
type TaxStatus = '예정' | '신고 완료' | '납부 완료'
type TaxEvent = {
  id: string
  kind: TaxKind
  title: string
  dueDate: string
  amount: number
  status: TaxStatus
  owner: string
  note: string
  attachments: StoredDocumentAttachment[]
  updatedAt: string
}

const ASSET_KINDS: AssetKind[] = ['비품', '장비', '차량', '소프트웨어', '부동산', '기타']
const ASSET_STATUSES: AssetStatus[] = ['사용 중', '수리 중', '보관', '폐기']
const TAX_KINDS: TaxKind[] = ['부가가치세', '원천세', '법인세', '종합소득세', '지방세', '4대보험', '기타']
const TAX_STATUSES: TaxStatus[] = ['예정', '신고 완료', '납부 완료']
const isAssets = (value: unknown): value is CompanyAsset[] => Array.isArray(value) && value.every((item) => item && typeof item.id === 'string' && typeof item.name === 'string' && Array.isArray(item.attachments))
const isTaxEvents = (value: unknown): value is TaxEvent[] => Array.isArray(value) && value.every((item) => item && typeof item.id === 'string' && typeof item.title === 'string' && Array.isArray(item.attachments))

function money(value: number) {
  return value ? `${Math.round(value).toLocaleString('ko-KR')}원` : '—'
}
function assetTone(status: AssetStatus): StatusBadgeTone {
  return status === '사용 중' ? 'success' : status === '수리 중' ? 'warning' : status === '폐기' ? 'danger' : 'neutral'
}
function taxTone(event: TaxEvent, today: string): StatusBadgeTone {
  if (event.status === '납부 완료') return 'success'
  if (event.status === '신고 완료') return 'info'
  return event.dueDate && event.dueDate < today ? 'danger' : 'warning'
}

export function TaxAssetsPage({ workspaceScope, canManage, currentUserName, onToast }: { workspaceScope?: string; canManage: boolean; currentUserName: string; onToast: (message: string) => void }) {
  const [assets, setAssets] = useWorkspaceState<CompanyAsset[]>('company-assets', [], { scope: workspaceScope, seedWhenEmpty: false, validate: isAssets })
  const [taxEvents, setTaxEvents] = useWorkspaceState<TaxEvent[]>('tax-events', [], { scope: workspaceScope, seedWhenEmpty: false, validate: isTaxEvents })
  const [tab, setTab] = useState<'tax' | 'assets'>('tax')
  const [editor, setEditor] = useState<{ kind: 'asset'; item?: CompanyAsset } | { kind: 'tax'; item?: TaxEvent } | null>(null)
  const today = seoulDateInputValue()

  const sortedTax = useMemo(() => [...taxEvents].sort((left, right) => Number(left.status !== '예정') - Number(right.status !== '예정') || (left.dueDate || '9999').localeCompare(right.dueDate || '9999')), [taxEvents])
  const sortedAssets = useMemo(() => [...assets].sort((left, right) => (right.acquiredAt || '').localeCompare(left.acquiredAt || '')), [assets])
  const upcoming = sortedTax.filter((event) => event.status === '예정')
  const overdue = upcoming.filter((event) => event.dueDate && event.dueDate < today)
  const assetTotal = assets.filter((asset) => asset.status !== '폐기').reduce((sum, asset) => sum + (asset.price || 0), 0)

  const download = async (attachment: StoredDocumentAttachment) => {
    try { await downloadDocumentAttachment(attachment, workspaceScope) } catch (error) { onToast(error instanceof Error ? error.message : '파일을 내려받지 못했습니다.') }
  }
  const dday = (dueDate: string) => {
    if (!dueDate) return null
    const days = Math.ceil((Date.parse(dueDate) - Date.parse(today)) / 86_400_000)
    return { label: days < 0 ? `${Math.abs(days)}일 지남` : days === 0 ? '오늘 마감' : `D-${days}`, urgent: days <= 7 }
  }
  const removeAsset = async (asset: CompanyAsset) => {
    if (!window.confirm(`‘${asset.name}’ 자산을 삭제할까요?`)) return
    const result = await setAssets((current) => current.filter((item) => item.id !== asset.id))
    if (!result.ok) { onToast(result.message ?? '자산을 삭제하지 못했습니다.'); return }
    await deleteDocumentAttachments(asset.attachments.filter(isStoredDocumentAttachment).map((item) => item.id), workspaceScope)
    onToast('자산을 삭제했습니다.')
  }
  const removeTax = async (event: TaxEvent) => {
    if (!window.confirm(`‘${event.title}’ 세무 일정을 삭제할까요?`)) return
    const result = await setTaxEvents((current) => current.filter((item) => item.id !== event.id))
    if (!result.ok) { onToast(result.message ?? '세무 일정을 삭제하지 못했습니다.'); return }
    await deleteDocumentAttachments(event.attachments.filter(isStoredDocumentAttachment).map((item) => item.id), workspaceScope)
    onToast('세무 일정을 삭제했습니다.')
  }
  const markTax = async (event: TaxEvent, status: TaxStatus) => {
    const result = await setTaxEvents((current) => current.map((item) => item.id === event.id ? { ...item, status, updatedAt: new Date().toISOString() } : item))
    if (!result.ok) { onToast(result.message ?? '상태를 저장하지 못했습니다.'); return }
    onToast(`‘${event.title}’ → ${status}`)
  }

  return <div className="content-page tax-page">
    <header className="page-header">
      <div><span className="eyebrow">TAX & ASSETS</span><h1>세무 · 자산</h1><p>세금 신고·납부 기한을 놓치지 않게 관리하고, 회사 자산과 증빙 서류를 한곳에 보관합니다.</p></div>
      <div className="page-header-actions">{canManage && <button className="button primary" type="button" onClick={() => setEditor(tab === 'tax' ? { kind: 'tax' } : { kind: 'asset' })}><Plus size={18} /> {tab === 'tax' ? '세무 일정 등록' : '자산 등록'}</button>}</div>
    </header>
    <section className="tax-summary" aria-label="세무·자산 요약">
      <article className={overdue.length ? 'is-danger' : ''}><span><Landmark size={18} /></span><div><small>기한 지난 신고</small><strong>{overdue.length}건</strong></div></article>
      <article><span><Banknote size={18} /></span><div><small>예정 세무 일정</small><strong>{upcoming.length}건</strong></div></article>
      <article><span><Boxes size={18} /></span><div><small>보유 자산</small><strong>{assets.filter((asset) => asset.status !== '폐기').length}개</strong></div></article>
      <article><span><Coins size={18} /></span><div><small>자산 취득가 합계</small><strong>{money(assetTotal)}</strong></div></article>
    </section>
    <div className="segmented tax-tabs" role="tablist" aria-label="세무·자산 보기">
      <button type="button" role="tab" aria-selected={tab === 'tax'} className={tab === 'tax' ? 'active' : ''} onClick={() => setTab('tax')}><Landmark size={15} /> 세무 일정 {taxEvents.length}</button>
      <button type="button" role="tab" aria-selected={tab === 'assets'} className={tab === 'assets' ? 'active' : ''} onClick={() => setTab('assets')}><Boxes size={15} /> 자산 대장 {assets.length}</button>
    </div>

    {tab === 'tax' ? <section className="panel it-list-panel">
      {sortedTax.length === 0
        ? <div className="empty-state"><Landmark size={30} /><h3>등록된 세무 일정이 없습니다</h3><p>부가세·원천세·법인세 등의 신고 기한과 금액, 신고서 파일을 등록하세요.</p>{canManage && <button className="button primary" type="button" onClick={() => setEditor({ kind: 'tax' })}><Plus size={18} /> 첫 세무 일정 등록</button>}</div>
        : <div className="it-rows" role="list">{sortedTax.map((event) => { const due = dday(event.dueDate); return <article className="it-row" role="listitem" key={event.id}>
          <StatusBadge className="status-pill" dot tone={taxTone(event, today)}>{event.status}</StatusBadge>
          <div className="it-row-main"><strong>{event.title}</strong><small>{event.kind}{event.owner ? ` · 담당 ${event.owner}` : ''}{event.dueDate ? ` · 기한 ${formatDateLabel(event.dueDate)}` : ''}</small></div>
          {event.status === '예정' && due && <span className={`it-row-meta${due.urgent ? ' is-urgent' : ''}`}>{due.label}</span>}
          <span className="it-row-meta">{money(event.amount)}</span>
          <div className="it-row-files">{event.attachments.length === 0 ? <span className="it-row-meta">증빙 없음</span> : event.attachments.map((file) => <button type="button" key={file.id} onClick={() => void download(file)}><Download size={13} /> {file.name}</button>)}</div>
          {canManage && <div className="it-row-actions">
            {event.status !== '납부 완료' && <button type="button" className="tax-advance" onClick={() => void markTax(event, event.status === '예정' ? '신고 완료' : '납부 완료')}>{event.status === '예정' ? '신고 완료로' : '납부 완료로'}</button>}
            <button type="button" aria-label={`${event.title} 수정`} onClick={() => setEditor({ kind: 'tax', item: event })}><Pencil size={15} /></button>
            <button type="button" aria-label={`${event.title} 삭제`} onClick={() => void removeTax(event)}><Trash2 size={15} /></button>
          </div>}
        </article> })}</div>}
    </section>
      : <section className="panel it-list-panel">
        {sortedAssets.length === 0
          ? <div className="empty-state"><Boxes size={30} /><h3>등록된 자산이 없습니다</h3><p>장비·차량·소프트웨어 등 회사 자산과 구매 증빙을 등록하면 취득가 합계가 자동 집계됩니다.</p>{canManage && <button className="button primary" type="button" onClick={() => setEditor({ kind: 'asset' })}><Plus size={18} /> 첫 자산 등록</button>}</div>
          : <div className="it-rows" role="list">{sortedAssets.map((asset) => <article className="it-row" role="listitem" key={asset.id}>
            <StatusBadge className="status-pill" dot tone={assetTone(asset.status)}>{asset.status}</StatusBadge>
            <div className="it-row-main"><strong>{asset.name}</strong><small>{asset.kind}{asset.serial ? ` · ${asset.serial}` : ''}{asset.acquiredAt ? ` · 취득 ${formatDateLabel(asset.acquiredAt)}` : ''}{asset.owner ? ` · 담당 ${asset.owner}` : ''}{asset.location ? ` · ${asset.location}` : ''}</small></div>
            <span className="it-row-meta">{money(asset.price)}</span>
            <div className="it-row-files">{asset.attachments.length === 0 ? <span className="it-row-meta">증빙 없음</span> : asset.attachments.map((file) => <button type="button" key={file.id} onClick={() => void download(file)}><Download size={13} /> {file.name}</button>)}</div>
            {canManage && <div className="it-row-actions"><button type="button" aria-label={`${asset.name} 수정`} onClick={() => setEditor({ kind: 'asset', item: asset })}><Pencil size={15} /></button><button type="button" aria-label={`${asset.name} 삭제`} onClick={() => void removeAsset(asset)}><Trash2 size={15} /></button></div>}
          </article>)}</div>}
      </section>}

    {editor?.kind === 'tax' && <TaxEditor item={editor.item} workspaceScope={workspaceScope} currentUserName={currentUserName} onToast={onToast} onClose={() => setEditor(null)} onSave={async (next) => {
      const result = await setTaxEvents((current) => current.some((item) => item.id === next.id) ? current.map((item) => item.id === next.id ? next : item) : [next, ...current])
      if (!result.ok) { onToast(result.message ?? '세무 일정을 저장하지 못했습니다.'); return false }
      onToast(`${next.title} 일정을 저장했습니다.`)
      return true
    }} />}
    {editor?.kind === 'asset' && <AssetEditor item={editor.item} workspaceScope={workspaceScope} currentUserName={currentUserName} onToast={onToast} onClose={() => setEditor(null)} onSave={async (next) => {
      const result = await setAssets((current) => current.some((item) => item.id === next.id) ? current.map((item) => item.id === next.id ? next : item) : [next, ...current])
      if (!result.ok) { onToast(result.message ?? '자산을 저장하지 못했습니다.'); return false }
      onToast(`${next.name} 자산을 저장했습니다.`)
      return true
    }} />}
  </div>
}

function useUploadSection(workspaceScope: string | undefined, category: string, onToast: (message: string) => void, initial: StoredDocumentAttachment[]) {
  const [attachments, setAttachments] = useState<StoredDocumentAttachment[]>(initial)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const uploadedRef = useRef(new Set<string>())
  const onFiles = async (files: File[]) => {
    if (!files.length) return
    setUploading(true)
    try {
      const added = await uploadDocumentAttachments(files, { workspaceScope, category, summary: `${category} 증빙`, tags: [category] })
      for (const file of added) uploadedRef.current.add(file.id)
      setAttachments((current) => [...current, ...added])
    } catch (error) { onToast(error instanceof Error ? error.message : '파일을 업로드하지 못했습니다.') }
    finally { setUploading(false) }
  }
  const cancel = async (onClose: () => void) => {
    if (uploadedRef.current.size) await deleteDocumentAttachments([...uploadedRef.current], workspaceScope)
    onClose()
  }
  const section = <>
    <section className="it-upload"><div><strong>증빙 · 문서 <small>선택</small></strong></div>
      <input ref={fileRef} className="sr-only" type="file" multiple onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void onFiles(files) }} />
      <button className="button secondary" type="button" disabled={uploading} onClick={() => fileRef.current?.click()}><Paperclip size={17} /> {uploading ? '업로드 중…' : '파일 추가'}</button>
    </section>
    {attachments.length > 0 && <div className="it-file-list">{attachments.map((file) => <span key={file.id}><Paperclip size={14} /> {file.name} · {file.size}<button type="button" aria-label={`${file.name} 제외`} onClick={() => setAttachments((current) => current.filter((entry) => entry.id !== file.id))}><X size={13} /></button></span>)}</div>}
  </>
  return { attachments, uploading, section, cancel, clearTracked: () => uploadedRef.current.clear() }
}

function TaxEditor({ item, workspaceScope, currentUserName, onToast, onClose, onSave }: { item?: TaxEvent; workspaceScope?: string; currentUserName: string; onToast: (message: string) => void; onClose: () => void; onSave: (next: TaxEvent) => Promise<boolean> }) {
  const [busy, setBusy] = useState(false)
  const upload = useUploadSection(workspaceScope, '세무', onToast, item?.attachments ?? [])
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const field = (name: string) => String(data.get(name) ?? '').trim()
    if (!field('title')) return
    const next: TaxEvent = {
      id: item?.id ?? `TAX-${Date.now()}`,
      kind: TAX_KINDS.includes(field('kind') as TaxKind) ? field('kind') as TaxKind : '기타',
      title: field('title'),
      dueDate: field('dueDate'),
      amount: Math.max(0, Number(data.get('amount') || 0)),
      status: TAX_STATUSES.includes(field('status') as TaxStatus) ? field('status') as TaxStatus : '예정',
      owner: field('owner'),
      note: field('note'),
      attachments: upload.attachments,
      updatedAt: new Date().toISOString(),
    }
    setBusy(true)
    if (await onSave(next)) { upload.clearTracked(); onClose() } else setBusy(false)
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && void upload.cancel(onClose)}>
    <section className="modal-card it-modal" role="dialog" aria-modal="true" aria-labelledby="tax-editor-title">
      <header><div><span className="eyebrow">TAX SCHEDULE</span><h2 id="tax-editor-title">{item ? '세무 일정 수정' : '세무 일정 등록'}</h2><p>제목과 기한만 있으면 등록됩니다. 신고서·납부 영수증을 함께 보관하세요.</p></div><button className="icon-button" type="button" aria-label="닫기" onClick={() => void upload.cancel(onClose)}><X size={21} /></button></header>
      <form onSubmit={submit}>
        <div className="form-grid"><label className="form-field"><span>제목 <em className="field-required">필수</em></span><input name="title" autoFocus defaultValue={item?.title ?? ''} required placeholder="예: 2026년 2기 부가세 예정신고" /></label><label className="form-field"><span>세목</span><select name="kind" defaultValue={item?.kind ?? '부가가치세'}>{TAX_KINDS.map((kind) => <option key={kind}>{kind}</option>)}</select></label></div>
        <div className="form-grid"><label className="form-field"><span>신고 · 납부 기한</span><input name="dueDate" type="date" defaultValue={item?.dueDate ?? ''} /></label><label className="form-field"><span>금액 (원)</span><input name="amount" type="number" min="0" step="1000" defaultValue={item?.amount ?? 0} /></label></div>
        <div className="form-grid"><label className="form-field"><span>상태</span><select name="status" defaultValue={item?.status ?? '예정'}>{TAX_STATUSES.map((status) => <option key={status}>{status}</option>)}</select></label><label className="form-field"><span>담당자</span><input name="owner" defaultValue={item?.owner ?? currentUserName} /></label></div>
        <label className="form-field full"><span>메모</span><textarea name="note" rows={2} defaultValue={item?.note ?? ''} placeholder="세무사 연락처·유의사항" /></label>
        {upload.section}
        <footer><button type="button" className="button ghost" disabled={busy || upload.uploading} onClick={() => void upload.cancel(onClose)}>취소</button><button type="submit" className="button primary" disabled={busy || upload.uploading}><Check size={18} /> {busy ? '저장 중…' : '저장'}</button></footer>
      </form>
    </section>
  </div>
}

function AssetEditor({ item, workspaceScope, currentUserName, onToast, onClose, onSave }: { item?: CompanyAsset; workspaceScope?: string; currentUserName: string; onToast: (message: string) => void; onClose: () => void; onSave: (next: CompanyAsset) => Promise<boolean> }) {
  const [busy, setBusy] = useState(false)
  const upload = useUploadSection(workspaceScope, '자산', onToast, item?.attachments ?? [])
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const field = (name: string) => String(data.get(name) ?? '').trim()
    if (!field('name')) return
    const next: CompanyAsset = {
      id: item?.id ?? `AST-${Date.now()}`,
      name: field('name'),
      kind: ASSET_KINDS.includes(field('kind') as AssetKind) ? field('kind') as AssetKind : '기타',
      serial: field('serial'),
      acquiredAt: field('acquiredAt'),
      price: Math.max(0, Number(data.get('price') || 0)),
      status: ASSET_STATUSES.includes(field('status') as AssetStatus) ? field('status') as AssetStatus : '사용 중',
      owner: field('owner'),
      location: field('location'),
      note: field('note'),
      attachments: upload.attachments,
      updatedAt: new Date().toISOString(),
    }
    setBusy(true)
    if (await onSave(next)) { upload.clearTracked(); onClose() } else setBusy(false)
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && void upload.cancel(onClose)}>
    <section className="modal-card it-modal" role="dialog" aria-modal="true" aria-labelledby="asset-editor-title">
      <header><div><span className="eyebrow">COMPANY ASSET</span><h2 id="asset-editor-title">{item ? '자산 수정' : '자산 등록'}</h2><p>자산명만 있으면 등록됩니다. 구매 영수증·보증서를 함께 보관하세요.</p></div><button className="icon-button" type="button" aria-label="닫기" onClick={() => void upload.cancel(onClose)}><X size={21} /></button></header>
      <form onSubmit={submit}>
        <div className="form-grid"><label className="form-field"><span>자산명 <em className="field-required">필수</em></span><input name="name" autoFocus defaultValue={item?.name ?? ''} required placeholder="예: 렌더링 워크스테이션" /></label><label className="form-field"><span>종류</span><select name="kind" defaultValue={item?.kind ?? '장비'}>{ASSET_KINDS.map((kind) => <option key={kind}>{kind}</option>)}</select></label></div>
        <div className="form-grid"><label className="form-field"><span>시리얼 · 관리번호</span><input name="serial" defaultValue={item?.serial ?? ''} placeholder="예: WS-2026-01" /></label><label className="form-field"><span>취득일</span><input name="acquiredAt" type="date" defaultValue={item?.acquiredAt ?? ''} /></label></div>
        <div className="form-grid"><label className="form-field"><span>취득가 (원)</span><input name="price" type="number" min="0" step="10000" defaultValue={item?.price ?? 0} /></label><label className="form-field"><span>상태</span><select name="status" defaultValue={item?.status ?? '사용 중'}>{ASSET_STATUSES.map((status) => <option key={status}>{status}</option>)}</select></label></div>
        <div className="form-grid"><label className="form-field"><span>담당자</span><input name="owner" defaultValue={item?.owner ?? currentUserName} /></label><label className="form-field"><span>위치</span><input name="location" defaultValue={item?.location ?? ''} placeholder="예: 본사 3층" /></label></div>
        <label className="form-field full"><span>메모</span><textarea name="note" rows={2} defaultValue={item?.note ?? ''} placeholder="보증 기간·계약 정보" /></label>
        {upload.section}
        <footer><button type="button" className="button ghost" disabled={busy || upload.uploading} onClick={() => void upload.cancel(onClose)}>취소</button><button type="submit" className="button primary" disabled={busy || upload.uploading}><Check size={18} /> {busy ? '저장 중…' : '저장'}</button></footer>
      </form>
    </section>
  </div>
}

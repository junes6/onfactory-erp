import { useMemo, useRef, useState, type FormEvent } from 'react'
import { Boxes, Check, Coins, Download, Landmark, Paperclip, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useWorkspaceState } from '../hooks/useWorkspaceState'
import { formatDateLabel } from '../utils/dateTime'
import {
  deleteDocumentAttachments,
  downloadDocumentAttachment,
  isStoredDocumentAttachment,
  uploadDocumentAttachments,
  type StoredDocumentAttachment,
} from '../utils/documentAttachments'
import { StatusBadge, type StatusBadgeTone } from './StatusBadge'
import { TaxWorkspace } from './TaxWorkspace'
import './TaxAssets.css'

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

const ASSET_KINDS: AssetKind[] = ['비품', '장비', '차량', '소프트웨어', '부동산', '기타']
const ASSET_STATUSES: AssetStatus[] = ['사용 중', '수리 중', '보관', '폐기']
const isAssets = (value: unknown): value is CompanyAsset[] => Array.isArray(value) && value.every((item) => Boolean(item && typeof item.id === 'string' && typeof item.name === 'string' && Array.isArray(item.attachments)))

function money(value: number) { return value ? `${Math.round(value).toLocaleString('ko-KR')}원` : '—' }
function assetTone(status: AssetStatus): StatusBadgeTone { return status === '사용 중' ? 'success' : status === '수리 중' ? 'warning' : status === '폐기' ? 'danger' : 'neutral' }

export function TaxAssetsPage({ workspaceScope, canManage, currentUserId, currentUserName, industryType, onToast }: { workspaceScope?: string; canManage: boolean; currentUserId: string; currentUserName: string; industryType?: string; onToast: (message: string) => void }) {
  const [assets, setAssets] = useWorkspaceState<CompanyAsset[]>('company-assets', [], { scope: workspaceScope, seedWhenEmpty: false, validate: isAssets })
  const [tab, setTab] = useState<'tax' | 'assets'>('tax')
  const [editingAsset, setEditingAsset] = useState<CompanyAsset | 'new' | null>(null)
  const sortedAssets = useMemo(() => [...assets].sort((left, right) => (right.acquiredAt || '').localeCompare(left.acquiredAt || '')), [assets])
  const activeAssets = assets.filter((asset) => asset.status !== '폐기')
  const assetTotal = activeAssets.reduce((sum, asset) => sum + (asset.price || 0), 0)

  const download = async (attachment: StoredDocumentAttachment) => {
    try { await downloadDocumentAttachment(attachment, workspaceScope) }
    catch (error) { onToast(error instanceof Error ? error.message : '파일을 내려받지 못했습니다.') }
  }
  const removeAsset = async (asset: CompanyAsset) => {
    if (!window.confirm(`‘${asset.name}’ 자산을 삭제할까요?`)) return
    const result = await setAssets((current) => current.filter((item) => item.id !== asset.id))
    if (!result.ok) { onToast(result.message ?? '자산을 삭제하지 못했습니다.'); return }
    await deleteDocumentAttachments(asset.attachments.filter(isStoredDocumentAttachment).map((item) => item.id), workspaceScope)
    onToast('자산을 삭제했습니다.')
  }

  return <div className="content-page tax-page">
    <header className="page-header">
      <div><span className="eyebrow">TAX & ASSETS</span><h1>세무 · 자산</h1><p>회사에 적용되는 세무 일정을 확인하고, 당해연도 증빙과 회사 자산을 실제 파일로 보관합니다.</p></div>
      <div className="page-header-actions">{tab === 'assets' && canManage && <button className="button primary" type="button" onClick={() => setEditingAsset('new')}><Plus size={18} /> 자산 등록</button>}</div>
    </header>
    <div className="segmented tax-tabs" role="tablist" aria-label="세무·자산 보기">
      <button type="button" role="tab" aria-selected={tab === 'tax'} className={tab === 'tax' ? 'active' : ''} onClick={() => setTab('tax')}><Landmark size={15} /> 세무 일정 · 증빙</button>
      <button type="button" role="tab" aria-selected={tab === 'assets'} className={tab === 'assets' ? 'active' : ''} onClick={() => setTab('assets')}><Boxes size={15} /> 자산 대장 {assets.length}</button>
    </div>

    {tab === 'tax' ? <TaxWorkspace workspaceScope={workspaceScope} canManage={canManage} currentUserId={currentUserId} currentUserName={currentUserName} industryType={industryType} onToast={onToast} /> : <>
      <section className="tax-summary" aria-label="자산 요약">
        <article><span><Boxes size={18} /></span><div><small>사용 중인 자산</small><strong>{activeAssets.length}개</strong></div></article>
        <article><span><Coins size={18} /></span><div><small>자산 취득가 합계</small><strong>{money(assetTotal)}</strong></div></article>
      </section>
      <section className="panel it-list-panel">
        {sortedAssets.length === 0
          ? <div className="empty-state"><Boxes size={30} /><h3>아직 등록된 자산이 없습니다</h3><p>장비·차량·소프트웨어 등 회사 자산과 구매 증빙을 함께 관리할 수 있습니다.</p>{canManage && <button className="button primary" type="button" onClick={() => setEditingAsset('new')}><Plus size={18} /> 첫 자산 등록</button>}</div>
          : <div className="it-rows" role="list">{sortedAssets.map((asset) => <article className="it-row" role="listitem" key={asset.id}>
            <StatusBadge className="status-pill" dot tone={assetTone(asset.status)}>{asset.status}</StatusBadge>
            <div className="it-row-main"><strong>{asset.name}</strong><small>{asset.kind}{asset.serial ? ` · ${asset.serial}` : ''}{asset.acquiredAt ? ` · 취득 ${formatDateLabel(asset.acquiredAt)}` : ''}{asset.owner ? ` · 담당 ${asset.owner}` : ''}{asset.location ? ` · ${asset.location}` : ''}</small></div>
            <span className="it-row-meta">{money(asset.price)}</span>
            <div className="it-row-files">{asset.attachments.length === 0 ? <span className="it-row-meta">증빙 없음</span> : asset.attachments.map((file) => <button type="button" key={file.id} onClick={() => void download(file)}><Download size={13} /> {file.name}</button>)}</div>
            {canManage && <div className="it-row-actions"><button type="button" aria-label={`${asset.name} 수정`} onClick={() => setEditingAsset(asset)}><Pencil size={15} /></button><button type="button" aria-label={`${asset.name} 삭제`} onClick={() => void removeAsset(asset)}><Trash2 size={15} /></button></div>}
          </article>)}</div>}
      </section>
    </>}

    {editingAsset && <AssetEditor item={editingAsset === 'new' ? undefined : editingAsset} workspaceScope={workspaceScope} currentUserName={currentUserName} onToast={onToast} onClose={() => setEditingAsset(null)} onSave={async (next) => {
      const result = await setAssets((current) => current.some((item) => item.id === next.id) ? current.map((item) => item.id === next.id ? next : item) : [next, ...current])
      if (!result.ok) { onToast(result.message ?? '자산을 저장하지 못했습니다.'); return false }
      onToast(`${next.name} 자산을 저장했습니다.`); return true
    }} />}
  </div>
}

function useAssetUpload(workspaceScope: string | undefined, onToast: (message: string) => void, initial: StoredDocumentAttachment[]) {
  const [attachments, setAttachments] = useState<StoredDocumentAttachment[]>(initial)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const uploadedRef = useRef(new Set<string>())
  const onFiles = async (files: File[]) => {
    if (!files.length) return
    setUploading(true)
    try {
      const added = await uploadDocumentAttachments(files, { workspaceScope, category: '자산', summary: '회사 자산 증빙', tags: ['자산'] })
      for (const file of added) uploadedRef.current.add(file.id)
      setAttachments((current) => [...current, ...added])
    } catch (error) { onToast(error instanceof Error ? error.message : '파일을 업로드하지 못했습니다.') }
    finally { setUploading(false) }
  }
  const remove = async (file: StoredDocumentAttachment) => {
    setAttachments((current) => current.filter((entry) => entry.id !== file.id))
    if (uploadedRef.current.delete(file.id)) await deleteDocumentAttachments([file.id], workspaceScope)
  }
  const cancel = async (onClose: () => void) => {
    if (uploadedRef.current.size) await deleteDocumentAttachments([...uploadedRef.current], workspaceScope)
    onClose()
  }
  const section = <><section className="it-upload"><div><strong>구매 증빙 · 보증서 <small>선택</small></strong></div><input ref={fileRef} className="sr-only" type="file" multiple onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void onFiles(files) }} /><button className="button secondary" type="button" disabled={uploading} onClick={() => fileRef.current?.click()}><Paperclip size={17} /> {uploading ? '업로드 중…' : '파일 추가'}</button></section>{attachments.length > 0 && <div className="it-file-list">{attachments.map((file) => <span key={file.id}><Paperclip size={14} /> {file.name} · {file.size}<button type="button" aria-label={`${file.name} 제외`} onClick={() => void remove(file)}><X size={13} /></button></span>)}</div>}</>
  return { attachments, uploading, section, cancel, clearTracked: () => uploadedRef.current.clear() }
}

function AssetEditor({ item, workspaceScope, currentUserName, onToast, onClose, onSave }: { item?: CompanyAsset; workspaceScope?: string; currentUserName: string; onToast: (message: string) => void; onClose: () => void; onSave: (next: CompanyAsset) => Promise<boolean> }) {
  const [busy, setBusy] = useState(false)
  const upload = useAssetUpload(workspaceScope, onToast, item?.attachments ?? [])
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const field = (name: string) => String(data.get(name) ?? '').trim()
    if (!field('name')) return
    const next: CompanyAsset = { id: item?.id ?? `AST-${Date.now()}`, name: field('name'), kind: ASSET_KINDS.includes(field('kind') as AssetKind) ? field('kind') as AssetKind : '기타', serial: field('serial'), acquiredAt: field('acquiredAt'), price: Math.max(0, Number(data.get('price') || 0)), status: ASSET_STATUSES.includes(field('status') as AssetStatus) ? field('status') as AssetStatus : '사용 중', owner: field('owner'), location: field('location'), note: field('note'), attachments: upload.attachments, updatedAt: new Date().toISOString() }
    setBusy(true)
    if (await onSave(next)) { upload.clearTracked(); onClose() } else setBusy(false)
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && void upload.cancel(onClose)}><section className="modal-card it-modal" role="dialog" aria-modal="true" aria-labelledby="asset-editor-title"><header><div><span className="eyebrow">COMPANY ASSET</span><h2 id="asset-editor-title">{item ? '자산 수정' : '자산 등록'}</h2><p>자산명만 있으면 등록됩니다. 구매 영수증·보증서를 함께 보관하세요.</p></div><button className="icon-button" type="button" aria-label="닫기" onClick={() => void upload.cancel(onClose)}><X size={21} /></button></header><form onSubmit={submit}>
    <div className="form-grid"><label className="form-field"><span>자산명 <em className="field-required">필수</em></span><input name="name" autoFocus defaultValue={item?.name ?? ''} required placeholder="예: 렌더링 워크스테이션" /></label><label className="form-field"><span>종류</span><select name="kind" defaultValue={item?.kind ?? '장비'}>{ASSET_KINDS.map((kind) => <option key={kind}>{kind}</option>)}</select></label></div>
    <div className="form-grid"><label className="form-field"><span>시리얼 · 관리번호</span><input name="serial" defaultValue={item?.serial ?? ''} placeholder="예: WS-2026-01" /></label><label className="form-field"><span>취득일</span><input name="acquiredAt" type="date" defaultValue={item?.acquiredAt ?? ''} /></label></div>
    <div className="form-grid"><label className="form-field"><span>취득가 (원)</span><input name="price" type="number" min="0" step="10000" defaultValue={item?.price ?? 0} /></label><label className="form-field"><span>상태</span><select name="status" defaultValue={item?.status ?? '사용 중'}>{ASSET_STATUSES.map((status) => <option key={status}>{status}</option>)}</select></label></div>
    <div className="form-grid"><label className="form-field"><span>담당자</span><input name="owner" defaultValue={item?.owner ?? currentUserName} /></label><label className="form-field"><span>위치</span><input name="location" defaultValue={item?.location ?? ''} placeholder="예: 본사 3층" /></label></div>
    <label className="form-field full"><span>메모</span><textarea name="note" rows={2} defaultValue={item?.note ?? ''} placeholder="보증 기간·계약 정보" /></label>{upload.section}<footer><button type="button" className="button ghost" disabled={busy || upload.uploading} onClick={() => void upload.cancel(onClose)}>취소</button><button type="submit" className="button primary" disabled={busy || upload.uploading}><Check size={18} /> {busy ? '저장 중…' : '저장'}</button></footer>
  </form></section></div>
}

import { useMemo, useRef, useState, type FormEvent } from 'react'
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
          <div className="it-row-main"><strong>{right.title}</strong><small>{right.kind}{right.number ? ` · ${right.number}` : ''}{right.holder ? ` · 권리자 ${right.holder}` : ''}{right.registeredAt ? ` · 등록 ${formatDateLabel(right.registeredAt)}` : right.filedAt ? ` · 출원 ${formatDateLabel(right.filedAt)}` : ''}</small></div>
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
  const [attachments, setAttachments] = useState<StoredDocumentAttachment[]>(item?.attachments ?? [])
  const fileRef = useRef<HTMLInputElement>(null)
  const uploadedRef = useRef(new Set<string>())
  const cancel = async () => {
    if (uploadedRef.current.size) await deleteDocumentAttachments([...uploadedRef.current], workspaceScope)
    onClose()
  }
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const field = (name: string) => String(data.get(name) ?? '').trim()
    if (!field('title')) return
    const next: IpRight = {
      id: item?.id ?? `IP-${Date.now()}`,
      kind: IP_KINDS.includes(field('kind') as IpKind) ? field('kind') as IpKind : '기타',
      title: field('title'),
      number: field('number'),
      holder: field('holder'),
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
    if (await onSave(next)) { uploadedRef.current.clear(); onClose() } else setBusy(false)
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && void cancel()}>
    <section className="modal-card it-modal" role="dialog" aria-modal="true" aria-labelledby="ip-editor-title">
      <header><div><span className="eyebrow">IP RIGHT</span><h2 id="ip-editor-title">{item ? '권리 · 인증 수정' : '권리 · 인증 등록'}</h2><p>명칭만 있으면 등록됩니다. 등록증·인증서 원본 파일을 함께 올려 두세요.</p></div><button className="icon-button" type="button" aria-label="닫기" onClick={() => void cancel()}><X size={21} /></button></header>
      <form onSubmit={submit}>
        <div className="form-grid"><label className="form-field"><span>명칭 <em className="field-required">필수</em></span><input name="title" autoFocus defaultValue={item?.title ?? ''} required placeholder="예: 3D 시뮬레이션 렌더링 방법 특허" /></label><label className="form-field"><span>유형</span><select name="kind" defaultValue={item?.kind ?? '특허'}>{IP_KINDS.map((kind) => <option key={kind}>{kind}</option>)}</select></label></div>
        <div className="form-grid"><label className="form-field"><span>출원 · 등록번호</span><input name="number" defaultValue={item?.number ?? ''} placeholder="예: 10-2026-0012345" /></label><label className="form-field"><span>권리자</span><input name="holder" defaultValue={item?.holder ?? ''} placeholder="예: 주식회사 3D뮤즈" /></label></div>
        <div className="form-grid"><label className="form-field"><span>출원일</span><input name="filedAt" type="date" defaultValue={item?.filedAt ?? ''} /></label><label className="form-field"><span>등록일</span><input name="registeredAt" type="date" defaultValue={item?.registeredAt ?? ''} /></label></div>
        <div className="form-grid"><label className="form-field"><span>만료 · 갱신일</span><input name="expiresAt" type="date" defaultValue={item?.expiresAt ?? ''} /></label><label className="form-field"><span>상태</span><select name="status" defaultValue={item?.status ?? '등록'}>{IP_STATUSES.map((status) => <option key={status}>{status}</option>)}</select></label></div>
        <label className="form-field full"><span>담당자</span><input name="owner" defaultValue={item?.owner ?? currentUserName} /></label>
        <label className="form-field full"><span>메모</span><textarea name="note" rows={2} defaultValue={item?.note ?? ''} placeholder="연차료 납부·갱신 절차 등" /></label>
        <section className="it-upload"><div><strong>등록증 · 인증서 파일 <small>선택</small></strong></div>
          <input ref={fileRef} className="sr-only" type="file" multiple onChange={async (event) => {
            const files = Array.from(event.target.files ?? []); event.target.value = ''
            if (!files.length) return
            setUploading(true)
            try {
              const added = await uploadDocumentAttachments(files, { workspaceScope, category: '지식재산', summary: '지식재산·인증 문서', tags: ['지식재산'] })
              for (const file of added) uploadedRef.current.add(file.id)
              setAttachments((current) => [...current, ...added])
            } catch (error) { onToast(error instanceof Error ? error.message : '파일을 업로드하지 못했습니다.') }
            finally { setUploading(false) }
          }} />
          <button className="button secondary" type="button" disabled={uploading || busy} onClick={() => fileRef.current?.click()}><Paperclip size={17} /> {uploading ? '업로드 중…' : '파일 추가'}</button>
        </section>
        {attachments.length > 0 && <div className="it-file-list">{attachments.map((file) => <span key={file.id}><Paperclip size={14} /> {file.name} · {file.size}<button type="button" aria-label={`${file.name} 제외`} onClick={() => setAttachments((current) => current.filter((entry) => entry.id !== file.id))}><X size={13} /></button></span>)}</div>}
        <footer><button type="button" className="button ghost" disabled={busy || uploading} onClick={() => void cancel()}>취소</button><button type="submit" className="button primary" disabled={busy || uploading}><Check size={18} /> {busy ? '저장 중…' : '저장'}</button></footer>
      </form>
    </section>
  </div>
}

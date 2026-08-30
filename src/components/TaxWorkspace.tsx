import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Check, ChevronDown, ExternalLink, FileArchive, FileCheck2, FolderOpen, History, Landmark, Paperclip, Pencil, SendHorizontal, Trash2, Upload, X } from 'lucide-react'
import { useWorkspaceState } from '../hooks/useWorkspaceState'
import { formatDateLabel, formatShortDateTime, seoulDateInputValue, toIsoUtc } from '../utils/dateTime'
import {
  deleteDocumentAttachment,
  downloadDocumentAttachment,
  formatDocumentSize,
  uploadDocumentAttachments,
  type StoredDocumentAttachment,
} from '../utils/documentAttachments'
import {
  buildProvidedTaxSchedule,
  defaultTaxProfile,
  NTS_YEAR_CALENDAR_URL,
  type EvidenceBucket,
  type ProvidedTaxSchedule,
  type TaxEntityType,
  type TaxProfile,
  type VatType,
  type WithholdingCycle,
} from '../utils/taxSchedule'
import { evidenceDateOf, isTaxPeriodPreset, taxPeriodOptions, taxPeriodRange, type TaxPeriodPreset } from '../utils/taxEvidencePeriod'
import { StatusBadge, type StatusBadgeTone } from './StatusBadge'

type TaxStatus = '예정' | '신고 완료' | '납부 완료'
type TaxRecord = {
  id: string
  recordType?: 'profile' | 'schedule'
  title: string
  kind: string
  dueDate: string
  amount: number
  status: TaxStatus
  owner: string
  note: string
  attachments: StoredDocumentAttachment[]
  updatedAt: string
  year?: number
  ruleId?: string
  entityType?: TaxEntityType
  fiscalYearEndMonth?: number
  vatType?: VatType
  hasPayroll?: boolean
  withholdingCycle?: WithholdingCycle
  description?: string
  appliesTo?: string
  sourceLabel?: string
  sourceUrl?: string
  checkedAt?: string
}

type TaxDocument = {
  id: string
  name: string
  originalName?: string
  mime: string
  size: number
  category: string
  visibility: 'all' | 'department' | 'restricted'
  tags: string[]
  summary: string
  uploadedAt: string
  uploadedById: string
  uploadedByName: string
}

type TaxDelivery = {
  id: string
  periodStart: string
  periodEnd: string
  periodLabel: string
  fileCount: number
  totalBytes: number
  buckets?: Record<string, number>
  archiveChecksum: string
  recipient?: string
  note?: string
  deliveredAt: string
  deliveredById: string
  deliveredByName: string
}

const EVIDENCE_BUCKETS: Array<{ id: EvidenceBucket; description: string }> = [
  { id: '매출', description: '세금계산서·카드·현금영수증 매출' },
  { id: '매입', description: '매입 세금계산서·거래명세서' },
  { id: '급여', description: '급여대장·원천징수·지급명세' },
  { id: '경비', description: '임차료·수수료·사업 관련 지출' },
  { id: '신고·납부', description: '신고서·접수증·납부확인서' },
  { id: '기타', description: '분류 전 자료와 세무사 요청 자료' },
]

const PROFILE_ID = 'TAX-PROFILE'
const isTaxRecords = (value: unknown): value is TaxRecord[] => Array.isArray(value) && value.every((item) => Boolean(item && typeof item.id === 'string' && typeof item.title === 'string' && Array.isArray(item.attachments)))
const profileFromRecord = (record?: TaxRecord): TaxProfile | null => record?.recordType === 'profile' ? {
  entityType: record.entityType === 'individual' ? 'individual' : 'corporation',
  fiscalYearEndMonth: Number(record.fiscalYearEndMonth) || 12,
  vatType: record.vatType === 'simplified' || record.vatType === 'exempt' ? record.vatType : 'general',
  hasPayroll: Boolean(record.hasPayroll),
  withholdingCycle: record.withholdingCycle === 'semiannual' ? 'semiannual' : 'monthly',
} : null

const ENTITY_LABEL: Record<TaxEntityType, string> = { corporation: '법인사업자', individual: '개인사업자' }
const VAT_LABEL: Record<VatType, string> = { general: '일반과세', simplified: '간이과세', exempt: '면세' }

function workspaceHeaders(workspaceScope?: string): Record<string, string> {
  return workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}
}

async function responseMessage(response: Response, fallback: string) {
  try { return ((await response.json()) as { error?: { message?: string } }).error?.message || fallback }
  catch { return fallback }
}

function taxStatusTone(status: TaxStatus, dueDate: string, today: string): StatusBadgeTone {
  if (status === '납부 완료') return 'success'
  if (status === '신고 완료') return 'info'
  return dueDate < today ? 'danger' : 'warning'
}

function taxStatusLabel(status: TaxStatus, dueDate: string, today: string) {
  return status === '예정' && dueDate < today ? '기한 지남' : status
}

function nextStatus(status: TaxStatus): TaxStatus {
  return status === '예정' ? '신고 완료' : status === '신고 완료' ? '납부 완료' : '예정'
}

function nextStatusLabel(status: TaxStatus) {
  return status === '예정' ? '신고 완료' : status === '신고 완료' ? '납부 완료' : '완료 취소'
}

function evidenceBucket(document: TaxDocument): EvidenceBucket {
  const value = document.tags.find((tag) => tag.startsWith('tax-bucket:'))?.slice('tax-bucket:'.length)
  return EVIDENCE_BUCKETS.some((bucket) => bucket.id === value) ? value as EvidenceBucket : '기타'
}

function bytesLabel(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function TaxWorkspace({ workspaceScope, canManage, currentUserId, currentUserName, industryType, onToast }: { workspaceScope?: string; canManage: boolean; currentUserId: string; currentUserName: string; industryType?: string; onToast: (message: string) => void }) {
  const today = seoulDateInputValue()
  const currentYear = Number(today.slice(0, 4))
  const [records, setRecords] = useWorkspaceState<TaxRecord[]>('tax-events', [], { scope: workspaceScope, seedWhenEmpty: false, validate: isTaxRecords })
  const [year, setYear] = useState(currentYear)
  const [profileOpen, setProfileOpen] = useState(false)
  const [documents, setDocuments] = useState<TaxDocument[]>([])
  const [documentsLoading, setDocumentsLoading] = useState(true)
  const [deliveries, setDeliveries] = useState<TaxDelivery[]>([])
  const [uploadBucket, setUploadBucket] = useState<EvidenceBucket>('기타')
  const [evidenceDate, setEvidenceDate] = useState(today)
  const [periodPreset, setPeriodPreset] = useState<TaxPeriodPreset>('year')
  const [uploading, setUploading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [showPast, setShowPast] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const profileRecord = records.find((record) => record.id === PROFILE_ID && record.recordType === 'profile')
  const savedProfile = profileFromRecord(profileRecord)
  // 신규 고객사가 아무것도 등록하지 않아도 업종·법인 구분 기본값으로 올해 일정을 먼저 보여준다.
  const profile = savedProfile ?? defaultTaxProfile()
  const usingDefaultProfile = !savedProfile
  const provided = useMemo(() => buildProvidedTaxSchedule(profile, year, industryType), [profile.entityType, profile.fiscalYearEndMonth, profile.vatType, profile.hasPayroll, profile.withholdingCycle, year, industryType]) // eslint-disable-line react-hooks/exhaustive-deps
  const scheduleRecords = records.filter((record) => record.recordType === 'schedule')
  const legacyRecords = records.filter((record) => !record.recordType)
  const statusFor = (schedule: ProvidedTaxSchedule) => scheduleRecords.find((record) => record.ruleId === schedule.ruleId && record.year === year)?.status ?? '예정'
  const remaining = provided.filter((schedule) => schedule.dueDate >= today)
  const past = provided.filter((schedule) => schedule.dueDate < today)
  const periodOptions = useMemo(() => taxPeriodOptions(year), [year])
  const selectedPeriod = useMemo(() => taxPeriodRange(periodPreset, year), [periodPreset, year])

  const datedDocuments = useMemo(() => documents
    .filter((document) => document.tags.includes('tax-evidence'))
    .map((document) => {
      const uploaded = new Date(document.uploadedAt)
      return { document, date: evidenceDateOf(document, Number.isNaN(uploaded.getTime()) ? today : seoulDateInputValue(uploaded)) }
    }), [documents, today])
  const yearDocuments = datedDocuments.filter(({ date }) => date.slice(0, 4) === String(year)).map(({ document }) => document)
  const periodDocumentCount = datedDocuments.filter(({ date }) => date >= selectedPeriod.from && date <= selectedPeriod.to).length

  const loadDocuments = async () => {
    setDocumentsLoading(true)
    try {
      const response = await fetch('/api/documents', { headers: workspaceHeaders(workspaceScope) })
      if (!response.ok) throw new Error(await responseMessage(response, '증빙 파일을 불러오지 못했습니다.'))
      const body = await response.json() as { documents?: TaxDocument[] }
      setDocuments((body.documents ?? []).filter((document) => Array.isArray(document.tags)))
    } catch (error) { onToast(error instanceof Error ? error.message : '증빙 파일을 불러오지 못했습니다.') }
    finally { setDocumentsLoading(false) }
  }
  const loadDeliveries = async () => {
    try {
      const response = await fetch('/api/tax/deliveries', { headers: workspaceHeaders(workspaceScope) })
      if (!response.ok) throw new Error(await responseMessage(response, '전달 이력을 불러오지 못했습니다.'))
      const body = await response.json() as { deliveries?: TaxDelivery[] }
      setDeliveries(Array.isArray(body.deliveries) ? body.deliveries : [])
    } catch (error) { onToast(error instanceof Error ? error.message : '전달 이력을 불러오지 못했습니다.') }
  }
  useEffect(() => { if (workspaceScope) { void loadDocuments(); void loadDeliveries() } }, [workspaceScope]) // eslint-disable-line react-hooks/exhaustive-deps

  const persistScheduleStatus = async (schedule: ProvidedTaxSchedule, status: TaxStatus) => {
    const previous = scheduleRecords.find((record) => record.ruleId === schedule.ruleId && record.year === schedule.year)
    const next: TaxRecord = {
      ...(previous ?? {}), id: schedule.id, recordType: 'schedule', ruleId: schedule.ruleId, year: schedule.year,
      title: schedule.title, kind: schedule.kind, dueDate: toIsoUtc(schedule.dueDate) ?? '', amount: previous?.amount ?? 0,
      status, owner: previous?.owner || currentUserName, note: previous?.note ?? '', attachments: previous?.attachments ?? [],
      description: schedule.description, appliesTo: schedule.appliesTo, sourceLabel: schedule.sourceLabel,
      sourceUrl: schedule.sourceUrl, checkedAt: schedule.checkedAt, updatedAt: new Date().toISOString(),
    }
    const result = await setRecords((current) => current.some((record) => record.id === next.id)
      ? current.map((record) => record.id === next.id ? next : record)
      : [next, ...current])
    if (!result.ok) { onToast(result.message ?? '세무 진행 상태를 저장하지 못했습니다.'); return }
    onToast(`‘${schedule.title}’을 ${status} 상태로 저장했습니다.`)
  }

  const pickEvidenceFiles = (bucket: EvidenceBucket) => { setUploadBucket(bucket); fileInputRef.current?.click() }

  const uploadEvidence = async (files: File[]) => {
    if (!files.length) return
    setUploading(true)
    try {
      await uploadDocumentAttachments(files, {
        workspaceScope,
        category: '세무·회계',
        summary: `${evidenceDate} ${uploadBucket} 세무 증빙`,
        tags: ['tax-evidence', `tax-year:${evidenceDate.slice(0, 4)}`, `tax-bucket:${uploadBucket}`, `tax-date:${evidenceDate}`],
      })
      await loadDocuments()
      onToast(`${evidenceDate} 기준 ${uploadBucket} 증빙 ${files.length}개를 보관했습니다.`)
    } catch (error) { onToast(error instanceof Error ? error.message : '증빙 파일을 보관하지 못했습니다.') }
    finally { setUploading(false) }
  }

  const removeEvidence = async (document: TaxDocument) => {
    if (!window.confirm(`‘${document.name}’ 증빙을 삭제할까요? 이 작업은 되돌릴 수 없습니다.`)) return
    try { await deleteDocumentAttachment(document.id, workspaceScope); await loadDocuments(); onToast('증빙 파일을 삭제했습니다.') }
    catch (error) { onToast(error instanceof Error ? error.message : '증빙 파일을 삭제하지 못했습니다.') }
  }
  const downloadEvidence = async (file: TaxDocument) => {
    try { await downloadDocumentAttachment({ id: file.id, name: file.name, size: formatDocumentSize(file.size) }, workspaceScope) }
    catch (error) { onToast(error instanceof Error ? error.message : '증빙 파일을 내려받지 못했습니다.') }
  }

  const exportEvidence = async () => {
    setExporting(true)
    try {
      const response = await fetch('/api/tax/evidence-export', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...workspaceHeaders(workspaceScope) },
        body: JSON.stringify({ from: selectedPeriod.from, to: selectedPeriod.to, label: selectedPeriod.label }),
      })
      if (!response.ok) throw new Error(await responseMessage(response, '세무사 전달 묶음을 만들지 못했습니다.'))
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      try {
        const anchor = document.createElement('a')
        anchor.href = url; anchor.download = `${selectedPeriod.from}_${selectedPeriod.to}_세무사_전달자료.zip`; document.body.appendChild(anchor); anchor.click(); anchor.remove()
      } finally { window.setTimeout(() => URL.revokeObjectURL(url), 0) }
      await loadDeliveries()
      onToast(`${selectedPeriod.label} 증빙 ${response.headers.get('x-tax-evidence-files') ?? periodDocumentCount}개를 묶고 전달 이력에 기록했습니다.`)
    } catch (error) { onToast(error instanceof Error ? error.message : '세무사 전달 묶음을 만들지 못했습니다.') }
    finally { setExporting(false) }
  }

  const years = Array.from({ length: 5 }, (_, index) => currentYear - 2 + index)
  const completeCount = provided.filter((schedule) => statusFor(schedule) === '납부 완료').length
  const pendingCount = remaining.filter((schedule) => statusFor(schedule) !== '납부 완료').length

  const scheduleRow = (schedule: ProvidedTaxSchedule) => {
    const status = statusFor(schedule)
    return <article className="tax-schedule-row" key={schedule.id}>
      <time dateTime={schedule.dueDate}><strong>{schedule.dueDate.slice(5).replace('-', '.')}</strong><span>{formatDateLabel(schedule.dueDate, false, true)}</span></time>
      <div className="tax-schedule-main">
        <div><StatusBadge dot tone={taxStatusTone(status, schedule.dueDate, today)}>{taxStatusLabel(status, schedule.dueDate, today)}</StatusBadge><strong>{schedule.title}</strong></div>
        <p>{schedule.description}</p>
        <ul className="tax-preparation" aria-label={`${schedule.title} 준비물`}>{schedule.preparation.map((item) => canManage
          ? <li key={item}><button type="button" disabled={uploading} onClick={() => pickEvidenceFiles(schedule.evidenceBucket)}><Paperclip size={12} /> {item}</button></li>
          : <li key={item}><span>{item}</span></li>)}</ul>
        <small>{schedule.appliesTo} · <a href={schedule.sourceUrl} target="_blank" rel="noreferrer">{schedule.sourceLabel} <ExternalLink size={11} /></a></small>
      </div>
      {canManage && <button className="button secondary tax-status-action" type="button" onClick={() => void persistScheduleStatus(schedule, nextStatus(status))}>{status === '납부 완료' ? <X size={15} /> : <Check size={15} />} {nextStatusLabel(status)}</button>}
    </article>
  }

  return <div className="tax-workspace">
    <section className="tax-workspace-toolbar" aria-label="세무 연도와 회사 설정">
      <div><strong>우리 회사 세무 캘린더</strong><span>{ENTITY_LABEL[profile.entityType]} · {VAT_LABEL[profile.vatType]} · {profile.fiscalYearEndMonth}월 결산 기준{usingDefaultProfile ? ' (기본값으로 자동 적용 중)' : ''}</span></div>
      <div className="tax-toolbar-actions">
        <label><span className="sr-only">조회 연도</span><select value={year} onChange={(event) => setYear(Number(event.target.value))}>{years.map((item) => <option key={item} value={item}>{item}년</option>)}</select></label>
        <a className="button ghost" href={NTS_YEAR_CALENDAR_URL(year)} target="_blank" rel="noreferrer">국세청 원문 <ExternalLink size={15} /></a>
        {canManage && <button className="button secondary" type="button" onClick={() => setProfileOpen(true)}><Pencil size={16} /> 회사 조건 {usingDefaultProfile ? '확인' : '수정'}</button>}
      </div>
    </section>

    {usingDefaultProfile && <p className="tax-default-notice" role="note">아직 회사 조건을 저장하지 않아 <strong>{ENTITY_LABEL[profile.entityType]} · {VAT_LABEL[profile.vatType]} · {profile.fiscalYearEndMonth}월 결산 · 급여 지급</strong> 기준으로 일정을 만들었습니다. 우리 회사와 다르면 “회사 조건 확인”에서 한 번만 고쳐 주세요.</p>}

    <section className="tax-progress-strip" aria-label={`${year}년 세무 준비 현황`}>
      <div><Landmark size={18} /><span>남은 일정</span><strong>{pendingCount}건</strong></div>
      <div><FileCheck2 size={18} /><span>납부까지 완료</span><strong>{completeCount}건</strong></div>
      <div><FolderOpen size={18} /><span>보관 증빙</span><strong>{yearDocuments.length}개</strong></div>
      <div><History size={18} /><span>세무사 전달</span><strong>{deliveries.length}회</strong></div>
    </section>

    <div className="tax-workspace-grid">
      <section className="tax-section-panel" aria-labelledby="tax-schedule-title">
        <header className="tax-section-head"><div><Landmark size={18} /><div><h2 id="tax-schedule-title">{year}년 챙길 세무 일정</h2><span>국세청 공식 안내를 회사 조건·업종에 맞춰 적용</span></div></div><small>기준 확인 {formatDateLabel(provided[0]?.checkedAt, true, false)}</small></header>
        <div className="tax-schedule-list">
          {remaining.length === 0
            ? <p className="tax-evidence-empty">{year}년에 남은 신고 일정이 없습니다. 지난 일정은 아래에서 확인하세요.</p>
            : remaining.map(scheduleRow)}
        </div>
        {past.length > 0 && <div className="tax-past-block">
          <button className="tax-past-toggle" type="button" aria-expanded={showPast} onClick={() => setShowPast((current) => !current)}><ChevronDown size={15} /> 지난 일정 {past.length}건 {showPast ? '접기' : '보기'}</button>
          {showPast && <div className="tax-schedule-list">{past.map(scheduleRow)}</div>}
        </div>}
      </section>

      <section className="tax-section-panel" aria-labelledby="tax-evidence-title">
        <header className="tax-section-head"><div><FileArchive size={18} /><div><h2 id="tax-evidence-title">{year}년 증빙 파일함</h2><span>상시 모아 두고, 기간만 골라 세무사에게 한 번에 전달</span></div></div></header>
        {canManage && <div className="tax-delivery-bar">
          <label><span className="sr-only">전달 기간</span><select value={periodPreset} onChange={(event) => { if (isTaxPeriodPreset(event.target.value)) setPeriodPreset(event.target.value) }}>{periodOptions.map((option) => <option key={option.preset} value={option.preset}>{option.label}</option>)}</select></label>
          <span className="tax-delivery-count">{periodDocumentCount}개 대상</span>
          <button className="button primary" type="button" disabled={exporting || periodDocumentCount === 0} onClick={() => void exportEvidence()}><SendHorizontal size={16} /> {exporting ? '묶는 중…' : '세무사에게 전달'}</button>
        </div>}
        <div className="tax-evidence-upload-bar">
          <label className="tax-evidence-date"><span>증빙 일자</span><input type="date" value={evidenceDate} max="2100-12-31" onChange={(event) => setEvidenceDate(event.target.value || today)} /></label>
          <span>선택한 날짜 기준으로 분류·연도가 자동 저장됩니다.</span>
        </div>
        <input ref={fileInputRef} className="sr-only" type="file" multiple onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void uploadEvidence(files) }} />
        <div className="tax-evidence-list" aria-busy={documentsLoading || uploading}>{EVIDENCE_BUCKETS.map((bucket) => { const files = yearDocuments.filter((document) => evidenceBucket(document) === bucket.id); return <article className="tax-evidence-row" key={bucket.id}>
          <div className="tax-evidence-main"><strong>{bucket.id}</strong><span>{bucket.description}</span></div><span className="tax-evidence-count">{files.length}개</span>
          <div className="tax-evidence-files">{files.map((file) => <span key={file.id}><button type="button" onClick={() => void downloadEvidence(file)}><Paperclip size={13} /> {file.name}</button>{(canManage || file.uploadedById === currentUserId) && <button type="button" aria-label={`${file.name} 삭제`} onClick={() => void removeEvidence(file)}><Trash2 size={13} /></button>}</span>)}</div>
          <button className="button ghost tax-upload-button" type="button" aria-label={`${bucket.id} 증빙 파일 넣기`} disabled={uploading} onClick={() => pickEvidenceFiles(bucket.id)}><Upload size={15} /> 추가</button>
        </article> })}</div>
        {!documentsLoading && yearDocuments.length === 0 && <p className="tax-evidence-empty">아직 {year}년 증빙이 없습니다. 매출·매입·급여 등 알맞은 칸에 파일을 넣으면 증빙 일자와 분류가 함께 저장됩니다.</p>}

        <div className="tax-delivery-history">
          <h3><History size={16} /> 세무사 전달 이력</h3>
          {deliveries.length === 0
            ? <p>아직 전달한 기록이 없습니다. 기간을 고르고 <strong>세무사에게 전달</strong>을 누르면 압축본·목록표를 만들고 이 자리에 기록이 남습니다.</p>
            : <ul>{deliveries.slice(0, 12).map((delivery) => <li key={delivery.id}>
              <div><strong>{delivery.periodLabel || `${delivery.periodStart} ~ ${delivery.periodEnd}`}</strong><span>{delivery.fileCount}개 · {bytesLabel(delivery.totalBytes)}</span></div>
              <small>{formatShortDateTime(delivery.deliveredAt)} · {delivery.deliveredByName}{delivery.recipient ? ` → ${delivery.recipient}` : ''}</small>
              <code title="묶음 SHA-256">{delivery.archiveChecksum.slice(0, 12)}</code>
            </li>)}</ul>}
        </div>
      </section>
    </div>

    {legacyRecords.length > 0 && <details className="tax-legacy"><summary>이전에 직접 등록한 회사 일정 {legacyRecords.length}건 (보관용)</summary><div>{legacyRecords.map((record) => <span key={record.id}><strong>{record.title}</strong><small>{record.dueDate ? formatDateLabel(record.dueDate) : '기한 미정'} · {record.status}</small></span>)}</div></details>}
    {profileOpen && <TaxProfileEditor record={profileRecord} profile={profile} currentUserName={currentUserName} onClose={() => setProfileOpen(false)} onSave={async (next) => {
      const result = await setRecords((current) => current.some((record) => record.id === PROFILE_ID) ? current.map((record) => record.id === PROFILE_ID ? next : record) : [next, ...current])
      if (!result.ok) { onToast(result.message ?? '회사 세무 조건을 저장하지 못했습니다.'); return false }
      onToast('회사 세무 조건을 저장하고 일정을 다시 계산했습니다.'); return true
    }} />}
  </div>
}

function TaxProfileEditor({ record, profile, currentUserName, onClose, onSave }: { record?: TaxRecord; profile: TaxProfile; currentUserName: string; onClose: () => void; onSave: (next: TaxRecord) => Promise<boolean> }) {
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const next: TaxRecord = {
      id: PROFILE_ID, recordType: 'profile', title: '회사 세무 조건', kind: '기타', dueDate: '', amount: 0, status: '예정',
      owner: currentUserName, note: '', attachments: [], updatedAt: new Date().toISOString(),
      entityType: data.get('entityType') === 'individual' ? 'individual' : 'corporation',
      fiscalYearEndMonth: Math.min(12, Math.max(1, Number(data.get('fiscalYearEndMonth')) || 12)),
      vatType: data.get('vatType') === 'simplified' || data.get('vatType') === 'exempt' ? data.get('vatType') as VatType : 'general',
      hasPayroll: data.get('hasPayroll') === 'yes',
      withholdingCycle: data.get('withholdingCycle') === 'semiannual' ? 'semiannual' : 'monthly',
    }
    setBusy(true)
    if (await onSave(next)) onClose(); else setBusy(false)
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="modal-card it-modal tax-profile-modal" role="dialog" aria-modal="true" aria-labelledby="tax-profile-title">
    <header><div><span className="eyebrow">TAX PROFILE</span><h2 id="tax-profile-title">회사 세무 조건</h2><p>{record ? '저장된 조건입니다.' : '지금은 기본값으로 일정을 만들고 있습니다.'} 일정 적용에 필요한 조건만 저장합니다. 실제 신고 전에는 담당 세무사와 적용 여부를 확인해 주세요.</p></div><button className="icon-button" type="button" aria-label="닫기" onClick={onClose}><X size={21} /></button></header>
    <form onSubmit={submit}><div className="form-grid"><label className="form-field"><span>사업자 유형</span><select name="entityType" defaultValue={profile.entityType}><option value="corporation">법인사업자</option><option value="individual">개인사업자</option></select></label><label className="form-field"><span>부가가치세 유형</span><select name="vatType" defaultValue={profile.vatType}><option value="general">일반과세</option><option value="simplified">간이과세</option><option value="exempt">면세</option></select></label></div>
      <div className="form-grid"><label className="form-field"><span>결산월</span><select name="fiscalYearEndMonth" defaultValue={profile.fiscalYearEndMonth}>{Array.from({ length: 12 }, (_, index) => index + 1).map((month) => <option key={month} value={month}>{month}월</option>)}</select></label><label className="form-field"><span>급여·원천징수 여부</span><select name="hasPayroll" defaultValue={profile.hasPayroll ? 'yes' : 'no'}><option value="yes">있음</option><option value="no">없음</option></select></label></div>
      <label className="form-field full"><span>원천세 납부 주기</span><select name="withholdingCycle" defaultValue={profile.withholdingCycle}><option value="monthly">매월 납부</option><option value="semiannual">반기납부 승인받음</option></select></label>
      <footer><button className="button ghost" type="button" onClick={onClose}>취소</button><button className="button primary" type="submit" disabled={busy}><Check size={17} /> {busy ? '계산 중…' : '저장하고 일정 계산'}</button></footer></form>
  </section></div>
}

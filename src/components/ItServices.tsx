import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Briefcase, Building2, Check, Download, FileSignature, FileStack, Landmark, Paperclip, Pencil, Plus, Trash2, X } from 'lucide-react'
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
import './ItServices.css'
import { Button, IconButton } from './ui/Button'

export type ItServicesView = 'it-projects' | 'it-deliverables' | 'it-contracts'

type ItProjectStatus = '수주 검토' | '수주 확정' | '진행 중' | '검수' | '완료' | '보류'
const projectStatuses: ItProjectStatus[] = ['수주 검토', '수주 확정', '진행 중', '검수', '완료', '보류']

type ItProject = {
  id: string
  name: string
  client: string
  status: ItProjectStatus
  owner: string
  ownerId?: string
  startDate: string
  dueDate: string
  amount: number
  note: string
  createdAt: string
  updatedAt: string
}

type ItDeliverable = {
  id: string
  projectId: string
  name: string
  version: string
  attachments: StoredDocumentAttachment[]
  note: string
  createdBy: string
  createdAt: string
  updatedAt: string
}

type ItContract = {
  id: string
  client: string
  title: string
  number?: string
  startDate: string
  endDate: string
  amount: number
  attachments: StoredDocumentAttachment[]
  note: string
  updatedAt: string
}

// 거래처: 계약 없이도 정보만 먼저 등록해 둘 수 있다.
type ItClient = {
  id: string
  name: string
  businessNo: string
  contactName: string
  phone: string
  email: string
  address: string
  industry: string
  note: string
  updatedAt: string
}
type SupportProgramStatus = '준비' | '신청' | '선정' | '진행' | '완료' | '탈락'
// 지원사업: 정부·지자체·기관 지원사업의 신청~종료 관리
type ItSupportProgram = {
  id: string
  title: string
  agency: string
  status: SupportProgramStatus
  amount: number
  applyStart: string
  applyEnd: string
  startDate: string
  endDate: string
  owner: string
  attachments: StoredDocumentAttachment[]
  note: string
  updatedAt: string
}
const SUPPORT_PROGRAM_STATUSES: SupportProgramStatus[] = ['준비', '신청', '선정', '진행', '완료', '탈락']
const isClients = (value: unknown): value is ItClient[] => Array.isArray(value) && value.every((item) => item && typeof item.id === 'string' && typeof item.name === 'string')
const isPrograms = (value: unknown): value is ItSupportProgram[] => Array.isArray(value) && value.every((item) => item && typeof item.id === 'string' && typeof item.title === 'string' && Array.isArray(item.attachments))
function programTone(status: SupportProgramStatus): StatusBadgeTone {
  return status === '선정' || status === '진행' ? 'success' : status === '완료' ? 'info' : status === '탈락' ? 'danger' : status === '신청' ? 'warning' : 'neutral'
}

type Props = {
  view: ItServicesView
  workspaceScope?: string
  canManage: boolean
  currentUserId: string
  currentUserName: string
  onToast: (message: string) => void
}

const isProjects = (value: unknown): value is ItProject[] => Array.isArray(value) && value.every((item) => item && typeof item.id === 'string' && typeof item.name === 'string')
const isDeliverables = (value: unknown): value is ItDeliverable[] => Array.isArray(value) && value.every((item) => item && typeof item.id === 'string' && typeof item.projectId === 'string' && Array.isArray(item.attachments))
const isContracts = (value: unknown): value is ItContract[] => Array.isArray(value) && value.every((item) => item && typeof item.id === 'string' && typeof item.client === 'string' && Array.isArray(item.attachments))

function projectTone(status: ItProjectStatus): StatusBadgeTone {
  if (status === '완료') return 'success'
  if (status === '진행 중' || status === '검수') return 'info'
  if (status === '보류') return 'danger'
  return 'neutral'
}

/** 계약 상태는 저장하지 않고 종료일에서 파생한다 — 고정 샘플 값을 두지 않는 원칙. */
function contractStatus(contract: ItContract): { label: string; tone: StatusBadgeTone } {
  const today = seoulDateInputValue()
  if (contract.endDate && contract.endDate < today) return { label: '만료', tone: 'danger' }
  if (contract.endDate) {
    const days = Math.ceil((new Date(`${contract.endDate}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86_400_000)
    if (days <= 60) return { label: `갱신 준비 · ${days}일 남음`, tone: 'warning' }
  }
  return { label: '진행 중', tone: 'success' }
}

function money(value: number) {
  return value > 0 ? `${value.toLocaleString('ko-KR')}원` : '미정'
}

function dueLabel(dueDate: string) {
  if (!dueDate) return '마감 미정'
  const today = seoulDateInputValue()
  const days = Math.ceil((new Date(`${dueDate}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86_400_000)
  if (days < 0) return `${formatDateLabel(dueDate)} · ${Math.abs(days)}일 지남`
  if (days === 0) return '오늘 마감'
  return `${formatDateLabel(dueDate)} · ${days}일 남음`
}

type UnifiedProjectRef = { id: string; legacyId?: string; name: string }

export function ItServicesPage({ view, workspaceScope, canManage, currentUserId, currentUserName, onToast }: Props) {
  // 통합 프로젝트(프로젝트 공간) — 산출물의 프로젝트 연결에 사용한다. 기존 it-projects는 이름 해석용으로만 남긴다.
  const [spaces, setSpaces] = useState<UnifiedProjectRef[]>([])
  useEffect(() => {
    let active = true
    fetch('/api/projects', { headers: workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined })
      .then(async (response) => response.ok ? response.json() as Promise<{ projects?: UnifiedProjectRef[] }> : { projects: [] })
      .then((body) => { if (active) setSpaces((body.projects ?? []).map((item) => ({ id: item.id, legacyId: item.legacyId, name: item.name }))) })
      .catch(() => {})
    return () => { active = false }
  }, [workspaceScope])
  const [projects, setProjects] = useWorkspaceState<ItProject[]>('it-projects', [], { scope: workspaceScope, seedWhenEmpty: false, validate: isProjects })
  const [deliverables, setDeliverables] = useWorkspaceState<ItDeliverable[]>('it-deliverables', [], { scope: workspaceScope, seedWhenEmpty: false, validate: isDeliverables })
  const [contracts, setContracts] = useWorkspaceState<ItContract[]>('it-contracts', [], { scope: workspaceScope, seedWhenEmpty: false, validate: isContracts })
  const [clients, setClients] = useWorkspaceState<ItClient[]>('it-clients', [], { scope: workspaceScope, seedWhenEmpty: false, validate: isClients })
  const [programs, setPrograms] = useWorkspaceState<ItSupportProgram[]>('it-support-programs', [], { scope: workspaceScope, seedWhenEmpty: false, validate: isPrograms })
  const [contractTab, setContractTab] = useState<'contracts' | 'clients' | 'programs'>('contracts')
  const [editor, setEditor] = useState<{ kind: 'project'; item?: ItProject } | { kind: 'deliverable'; item?: ItDeliverable } | { kind: 'contract'; item?: ItContract } | { kind: 'client'; item?: ItClient } | { kind: 'program'; item?: ItSupportProgram } | null>(null)
  const [projectFilter, setProjectFilter] = useState<string>('all')

  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects])
  const projectNameOf = (id: string) => spaces.find((space) => space.id === id || space.legacyId === id)?.name ?? projectById.get(id)?.name ?? '삭제된 프로젝트'
  const deliverableProjectOptions = spaces.length ? spaces : projects.map((project) => ({ id: project.id, name: project.name }))
  const today = seoulDateInputValue()

  const removeProject = async (project: ItProject) => {
    if (!window.confirm(`‘${project.name}’ 프로젝트를 삭제할까요? 연결된 산출물 기록은 남습니다.`)) return
    const result = await setProjects((current) => current.filter((item) => item.id !== project.id))
    if (!result.ok) { onToast(result.message ?? '프로젝트를 삭제하지 못했습니다.'); return }
    onToast('프로젝트를 삭제했습니다.')
  }
  const removeDeliverable = async (deliverable: ItDeliverable) => {
    if (!window.confirm(`‘${deliverable.name} ${deliverable.version}’ 산출물과 첨부 파일을 삭제할까요?`)) return
    const result = await setDeliverables((current) => current.filter((item) => item.id !== deliverable.id))
    if (!result.ok) { onToast(result.message ?? '산출물을 삭제하지 못했습니다.'); return }
    const cleanup = await deleteDocumentAttachments(deliverable.attachments.filter(isStoredDocumentAttachment).map((item) => item.id), workspaceScope)
    onToast(cleanup.failed.length ? `산출물은 삭제했지만 파일 ${cleanup.failed.length}개 정리에 실패했습니다.` : '산출물을 삭제했습니다.')
  }
  const removeClient = async (client: ItClient) => {
    const linked = contracts.filter((contract) => contract.client === client.name).length
    if (!window.confirm(`‘${client.name}’ 거래처를 삭제할까요?${linked ? ` 연결된 계약 ${linked}건의 거래처명은 그대로 남습니다.` : ''}`)) return
    const result = await setClients((current) => current.filter((item) => item.id !== client.id))
    if (!result.ok) { onToast(result.message ?? '거래처를 삭제하지 못했습니다.'); return }
    onToast('거래처를 삭제했습니다.')
  }
  const removeProgram = async (program: ItSupportProgram) => {
    if (!window.confirm(`‘${program.title}’ 지원사업을 삭제할까요?`)) return
    const result = await setPrograms((current) => current.filter((item) => item.id !== program.id))
    if (!result.ok) { onToast(result.message ?? '지원사업을 삭제하지 못했습니다.'); return }
    const cleanup = await deleteDocumentAttachments(program.attachments.filter(isStoredDocumentAttachment).map((item) => item.id), workspaceScope)
    onToast(cleanup.failed.length ? `지원사업은 삭제했지만 문서 ${cleanup.failed.length}개 정리에 실패했습니다.` : '지원사업을 삭제했습니다.')
  }
  const removeContract = async (contract: ItContract) => {
    if (!window.confirm(`‘${contract.title}’ 계약을 삭제할까요?`)) return
    const result = await setContracts((current) => current.filter((item) => item.id !== contract.id))
    if (!result.ok) { onToast(result.message ?? '계약을 삭제하지 못했습니다.'); return }
    const cleanup = await deleteDocumentAttachments(contract.attachments.filter(isStoredDocumentAttachment).map((item) => item.id), workspaceScope)
    onToast(cleanup.failed.length ? `계약은 삭제했지만 문서 ${cleanup.failed.length}개 정리에 실패했습니다.` : '계약을 삭제했습니다.')
  }

  const download = async (attachment: StoredDocumentAttachment) => {
    try { await downloadDocumentAttachment(attachment, workspaceScope) } catch (error) { onToast(error instanceof Error ? error.message : '파일을 내려받지 못했습니다.') }
  }

  // ---------------- 프로젝트 ----------------
  if (view === 'it-projects') {
    const active = projects.filter((project) => !['완료', '보류'].includes(project.status))
    const dueSoon = active.filter((project) => project.dueDate && project.dueDate >= today && (new Date(`${project.dueDate}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86_400_000 <= 7)
    const overdue = active.filter((project) => project.dueDate && project.dueDate < today)
    const sorted = [...projects].sort((left, right) => (left.dueDate || '9999').localeCompare(right.dueDate || '9999'))
    return <div className="content-page it-page">
      <header className="page-header"><div><span className="eyebrow">IT PROJECTS</span><h1>프로젝트</h1><p>수주부터 완료까지 상태·마감·담당을 한 줄로 관리합니다.</p></div><div className="page-header-actions"><Button tone="primary" type="button" onClick={() => setEditor({ kind: 'project' })}><Plus size={18} /> 프로젝트 등록</Button></div></header>
      <section className="it-summary-strip" aria-label="프로젝트 요약">
        <article><span className="tone-blue"><Briefcase size={18} /></span><div><small>진행 중</small><strong>{active.length}건</strong></div></article>
        <article className={dueSoon.length ? 'is-warn' : ''}><span className="tone-warn"><Briefcase size={18} /></span><div><small>7일 내 마감</small><strong>{dueSoon.length}건</strong></div></article>
        <article className={overdue.length ? 'is-danger' : ''}><span className="tone-danger"><Briefcase size={18} /></span><div><small>마감 지남</small><strong>{overdue.length}건</strong></div></article>
        <article><span className="tone-green"><Check size={18} /></span><div><small>완료</small><strong>{projects.filter((project) => project.status === '완료').length}건</strong></div></article>
      </section>
      <section className="panel it-list-panel">
        {sorted.length === 0
          ? <div className="empty-state"><Briefcase size={30} /><h3>아직 등록된 프로젝트가 없습니다</h3><p>첫 프로젝트를 등록하면 마감과 담당이 여기에 한 줄씩 표시됩니다.</p><Button tone="primary" type="button" onClick={() => setEditor({ kind: 'project' })}><Plus size={17} /> 첫 프로젝트 등록</Button></div>
          : <div className="it-rows" role="list">{sorted.map((project) => <article className={`it-row${project.dueDate && project.dueDate < today && !['완료', '보류'].includes(project.status) ? ' is-overdue' : ''}`} role="listitem" key={project.id}>
            <StatusBadge className="status-pill" dot tone={projectTone(project.status)}>{project.status}</StatusBadge>
            <div className="it-row-main"><strong>{project.name}</strong><small>{project.client || '거래처 미지정'} · 담당 {project.owner || '미지정'}</small></div>
            <span className="it-row-meta">{dueLabel(project.dueDate)}</span>
            <span className="it-row-meta">{money(project.amount)}</span>
            <div className="it-row-actions"><button type="button" aria-label={`${project.name} 수정`} onClick={() => setEditor({ kind: 'project', item: project })}><Pencil size={15} /></button>{canManage && <button type="button" aria-label={`${project.name} 삭제`} onClick={() => void removeProject(project)}><Trash2 size={15} /></button>}</div>
          </article>)}</div>}
      </section>
      {editor?.kind === 'project' && <ProjectEditor item={editor.item} currentUserName={currentUserName} currentUserId={currentUserId} onClose={() => setEditor(null)} onSave={async (next) => {
        const result = await setProjects((current) => current.some((item) => item.id === next.id) ? current.map((item) => item.id === next.id ? next : item) : [next, ...current])
        if (!result.ok) { onToast(result.message ?? '프로젝트를 저장하지 못했습니다.'); return false }
        onToast(`${next.name} 프로젝트를 저장했습니다.`)
        return true
      }} />}
    </div>
  }

  // ---------------- 산출물 ----------------
  if (view === 'it-deliverables') {
    const visible = deliverables.filter((item) => projectFilter === 'all' || item.projectId === projectFilter).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    return <div className="content-page it-page">
      <header className="page-header"><div><span className="eyebrow">DELIVERABLES</span><h1>산출물</h1><p>프로젝트별 파일을 버전과 함께 보관합니다.</p></div><div className="page-header-actions"><Button tone="primary" type="button" disabled={projects.length === 0} onClick={() => setEditor({ kind: 'deliverable' })}><Plus size={18} /> 산출물 등록</Button></div></header>
      <section className="panel it-list-panel">
        <div className="it-toolbar"><label><span>프로젝트</span><select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}><option value="all">전체 프로젝트</option>{deliverableProjectOptions.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><span className="it-toolbar-count">{visible.length}건</span></div>
        {projects.length === 0
          ? <div className="empty-state"><FileStack size={30} /><h3>먼저 프로젝트를 등록하세요</h3><p>산출물은 프로젝트에 연결해 보관합니다.</p></div>
          : visible.length === 0
            ? <div className="empty-state"><FileStack size={30} /><h3>등록된 산출물이 없습니다</h3><p>설계서·소스 압축본·보고서 등을 버전과 함께 올려 두세요.</p></div>
            : <div className="it-rows" role="list">{visible.map((deliverable) => <article className="it-row" role="listitem" key={deliverable.id}>
              <span className="it-version">{deliverable.version}</span>
              <div className="it-row-main"><strong>{deliverable.name}</strong><small>{projectNameOf(deliverable.projectId)} · {deliverable.createdBy} · {formatDateLabel(deliverable.updatedAt.slice(0, 10))}</small></div>
              <div className="it-row-files">{deliverable.attachments.length === 0 ? <span className="it-row-meta">파일 없음</span> : deliverable.attachments.map((file) => <button type="button" key={file.id} onClick={() => void download(file)}><Download size={13} /> {file.name}</button>)}</div>
              <div className="it-row-actions"><button type="button" aria-label={`${deliverable.name} 수정`} onClick={() => setEditor({ kind: 'deliverable', item: deliverable })}><Pencil size={15} /></button>{(canManage || deliverable.createdBy === currentUserName) && <button type="button" aria-label={`${deliverable.name} 삭제`} onClick={() => void removeDeliverable(deliverable)}><Trash2 size={15} /></button>}</div>
            </article>)}</div>}
      </section>
      {editor?.kind === 'deliverable' && <DeliverableEditor item={editor.item} projects={deliverableProjectOptions} defaultProjectId={projectFilter === 'all' ? deliverableProjectOptions[0]?.id ?? '' : projectFilter} workspaceScope={workspaceScope} currentUserName={currentUserName} onToast={onToast} onClose={() => setEditor(null)} onSave={async (next) => {
        const result = await setDeliverables((current) => current.some((item) => item.id === next.id) ? current.map((item) => item.id === next.id ? next : item) : [next, ...current])
        if (!result.ok) { onToast(result.message ?? '산출물을 저장하지 못했습니다.'); return false }
        onToast(`${next.name} ${next.version} 산출물을 저장했습니다.`)
        return true
      }} />}
    </div>
  }

  // ---------------- 계약 · 거래처 · 지원사업 ----------------
  const sortedContracts = [...contracts].sort((left, right) => (left.endDate || '9999').localeCompare(right.endDate || '9999'))
  const sortedClients = [...clients].sort((left, right) => left.name.localeCompare(right.name, 'ko'))
  const sortedPrograms = [...programs].sort((left, right) => (left.applyEnd || left.endDate || '9999').localeCompare(right.applyEnd || right.endDate || '9999'))
  const clientContractCount = (name: string) => contracts.filter((contract) => contract.client === name).length
  const programDue = (program: ItSupportProgram) => {
    const target = program.status === '준비' || program.status === '신청' ? program.applyEnd : program.endDate
    if (!target) return null
    const days = Math.ceil((Date.parse(target) - Date.parse(today)) / 86_400_000)
    return { label: program.status === '준비' || program.status === '신청' ? (days < 0 ? `접수 마감 ${Math.abs(days)}일 지남` : `접수 마감 D-${days}`) : (days < 0 ? '사업 종료' : `종료 D-${days}`), urgent: days >= 0 && days <= 7 }
  }
  const contractTabs = <div className="segmented it-subtabs" role="tablist" aria-label="계약·거래처·지원사업 신청관리">
    <button type="button" role="tab" aria-selected={contractTab === 'contracts'} className={contractTab === 'contracts' ? 'active' : ''} onClick={() => setContractTab('contracts')}><FileSignature size={15} /> 계약 {contracts.length}</button>
    <button type="button" role="tab" aria-selected={contractTab === 'clients'} className={contractTab === 'clients' ? 'active' : ''} onClick={() => setContractTab('clients')}><Building2 size={15} /> 거래처 {clients.length}</button>
    <button type="button" role="tab" aria-selected={contractTab === 'programs'} className={contractTab === 'programs' ? 'active' : ''} onClick={() => setContractTab('programs')}><Landmark size={15} /> 지원사업 신청관리 {programs.length}</button>
  </div>
  if (contractTab === 'clients') {
    return <div className="content-page it-page">
      <header className="page-header"><div><span className="eyebrow">CLIENTS</span><h1>계약 · 거래처</h1><p>거래처 정보는 계약 없이도 먼저 등록해 둘 수 있습니다. 계약을 만들 때 거래처를 골라 연결하세요.</p></div><div className="page-header-actions">{canManage && <Button tone="primary" type="button" onClick={() => setEditor({ kind: 'client' })}><Plus size={18} /> 거래처 등록</Button>}</div></header>
      {contractTabs}
      <section className="panel it-list-panel">
        {sortedClients.length === 0
          ? <div className="empty-state"><Building2 size={30} /><h3>등록된 거래처가 없습니다</h3><p>회사명·담당자·연락처만으로 먼저 등록하고, 계약은 나중에 연결하세요.</p>{canManage && <Button tone="primary" type="button" onClick={() => setEditor({ kind: 'client' })}><Plus size={18} /> 첫 거래처 등록</Button>}</div>
          : <div className="it-rows" role="list">{sortedClients.map((client) => <article className="it-row" role="listitem" key={client.id}>
            <span className="it-client-mark"><Building2 size={17} /></span>
            <div className="it-row-main"><strong>{client.name}</strong><small>{[client.industry, client.businessNo ? `사업자 ${client.businessNo}` : '', client.address].filter(Boolean).join(' · ') || '상세 정보 미입력'}</small></div>
            <div className="it-row-main it-client-contact"><strong>{client.contactName || '담당자 미지정'}</strong><small>{[client.phone, client.email].filter(Boolean).join(' · ') || '연락처 미입력'}</small></div>
            <span className="it-row-meta">{clientContractCount(client.name) ? `계약 ${clientContractCount(client.name)}건` : '계약 없음'}</span>
            {canManage && <div className="it-row-actions"><button type="button" aria-label={`${client.name} 수정`} onClick={() => setEditor({ kind: 'client', item: client })}><Pencil size={15} /></button><button type="button" aria-label={`${client.name} 삭제`} onClick={() => void removeClient(client)}><Trash2 size={15} /></button></div>}
          </article>)}</div>}
      </section>
      {editor?.kind === 'client' && <ClientEditor item={editor.item} onClose={() => setEditor(null)} onSave={async (next) => {
        const result = await setClients((current) => current.some((item) => item.id === next.id) ? current.map((item) => item.id === next.id ? next : item) : [next, ...current])
        if (!result.ok) { onToast(result.message ?? '거래처를 저장하지 못했습니다.'); return false }
        onToast(`${next.name} 거래처를 저장했습니다.`)
        return true
      }} />}
    </div>
  }
  if (contractTab === 'programs') {
    return <div className="content-page it-page">
      <header className="page-header"><div><span className="eyebrow">SUPPORT PROGRAMS</span><h1>지원사업 신청관리</h1><p>메인에서 발견한 공고를 준비부터 신청·선정·진행·완료까지 관리합니다. 접수 마감 7일 전부터 강조됩니다.</p></div><div className="page-header-actions">{canManage && <Button tone="primary" type="button" onClick={() => setEditor({ kind: 'program' })}><Plus size={18} /> 지원사업 등록</Button>}</div></header>
      {contractTabs}
      <section className="panel it-list-panel">
        {sortedPrograms.length === 0
          ? <div className="empty-state"><Landmark size={30} /><h3>등록된 지원사업이 없습니다</h3><p>사업명·주관기관·접수 기간을 등록하면 마감 일정을 놓치지 않게 표시합니다.</p>{canManage && <Button tone="primary" type="button" onClick={() => setEditor({ kind: 'program' })}><Plus size={18} /> 첫 지원사업 등록</Button>}</div>
          : <div className="it-rows" role="list">{sortedPrograms.map((program) => { const due = programDue(program); return <article className="it-row" role="listitem" key={program.id}>
            <StatusBadge className="status-pill" dot tone={programTone(program.status)}>{program.status}</StatusBadge>
            <div className="it-row-main"><strong>{program.title}</strong><small>{program.agency || '주관기관 미입력'}{program.owner ? ` · 담당 ${program.owner}` : ''}{program.applyStart || program.applyEnd ? ` · 접수 ${program.applyStart ? formatDateLabel(program.applyStart) : '?'} ~ ${program.applyEnd ? formatDateLabel(program.applyEnd) : '?'}` : ''}{program.startDate || program.endDate ? ` · 사업 ${program.startDate ? formatDateLabel(program.startDate) : '?'} ~ ${program.endDate ? formatDateLabel(program.endDate) : '?'}` : ''}</small></div>
            <span className={`it-row-meta${due?.urgent ? ' is-urgent' : ''}`}>{due?.label ?? (program.amount ? money(program.amount) : '기간 미정')}</span>
            <span className="it-row-meta">{program.amount ? money(program.amount) : '—'}</span>
            <div className="it-row-files">{program.attachments.length === 0 ? <span className="it-row-meta">문서 없음</span> : program.attachments.map((file) => <button type="button" key={file.id} onClick={() => void download(file)}><Download size={13} /> {file.name}</button>)}</div>
            {canManage && <div className="it-row-actions"><button type="button" aria-label={`${program.title} 수정`} onClick={() => setEditor({ kind: 'program', item: program })}><Pencil size={15} /></button><button type="button" aria-label={`${program.title} 삭제`} onClick={() => void removeProgram(program)}><Trash2 size={15} /></button></div>}
          </article> })}</div>}
      </section>
      {editor?.kind === 'program' && <ProgramEditor item={editor.item} workspaceScope={workspaceScope} currentUserName={currentUserName} onToast={onToast} onClose={() => setEditor(null)} onSave={async (next) => {
        const result = await setPrograms((current) => current.some((item) => item.id === next.id) ? current.map((item) => item.id === next.id ? next : item) : [next, ...current])
        if (!result.ok) { onToast(result.message ?? '지원사업을 저장하지 못했습니다.'); return false }
        onToast(`${next.title} 지원사업을 저장했습니다.`)
        return true
      }} />}
    </div>
  }
  return <div className="content-page it-page">
    <header className="page-header"><div><span className="eyebrow">CONTRACTS</span><h1>계약 · 거래처</h1><p>계약 기간·금액·문서를 거래처별로 관리합니다. 만료 60일 전부터 갱신 준비로 표시됩니다. 거래처 정보와 지원사업은 탭에서 따로 관리합니다.</p></div><div className="page-header-actions">{canManage ? <Button tone="primary" type="button" onClick={() => setEditor({ kind: 'contract' })}><Plus size={18} /> 계약 등록</Button> : <StatusBadge className="status-pill" tone="neutral">조회 전용</StatusBadge>}</div></header>
    {contractTabs}
    <section className="panel it-list-panel">
      {sortedContracts.length === 0
        ? <div className="empty-state"><FileSignature size={30} /><h3>등록된 계약이 없습니다</h3><p>거래처·기간·금액과 계약서 파일을 등록하세요.</p>{canManage && <Button tone="primary" type="button" onClick={() => setEditor({ kind: 'contract' })}><Plus size={17} /> 첫 계약 등록</Button>}</div>
        : <div className="it-rows" role="list">{sortedContracts.map((contract) => { const status = contractStatus(contract); return <article className="it-row" role="listitem" key={contract.id}>
          <StatusBadge className="status-pill" dot tone={status.tone}>{status.label}</StatusBadge>
          <div className="it-row-main"><strong>{contract.title}</strong><small>{contract.client}{contract.number ? ` · ${contract.number}` : ''} · {contract.startDate ? formatDateLabel(contract.startDate) : '시작 미정'} ~ {contract.endDate ? formatDateLabel(contract.endDate) : '종료 미정'}</small></div>
          <span className="it-row-meta">{money(contract.amount)}</span>
          <div className="it-row-files">{contract.attachments.length === 0 ? <span className="it-row-meta">문서 없음</span> : contract.attachments.map((file) => <button type="button" key={file.id} onClick={() => void download(file)}><Download size={13} /> {file.name}</button>)}</div>
          {canManage && <div className="it-row-actions"><button type="button" aria-label={`${contract.title} 수정`} onClick={() => setEditor({ kind: 'contract', item: contract })}><Pencil size={15} /></button><button type="button" aria-label={`${contract.title} 삭제`} onClick={() => void removeContract(contract)}><Trash2 size={15} /></button></div>}
        </article> })}</div>}
    </section>
    {editor?.kind === 'contract' && <ContractEditor item={editor.item} clients={sortedClients} workspaceScope={workspaceScope} onToast={onToast} onClose={() => setEditor(null)} onSave={async (next) => {
      const result = await setContracts((current) => current.some((item) => item.id === next.id) ? current.map((item) => item.id === next.id ? next : item) : [next, ...current])
      if (!result.ok) { onToast(result.message ?? '계약을 저장하지 못했습니다.'); return false }
      onToast(`${next.title} 계약을 저장했습니다.`)
      return true
    }} />}
  </div>
}

function useEscape(onClose: () => void) {
  const ref = useRef(onClose)
  ref.current = onClose
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === 'Escape') ref.current() }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])
}

function ProjectEditor({ item, currentUserId, currentUserName, onClose, onSave }: { item?: ItProject; currentUserId: string; currentUserName: string; onClose: () => void; onSave: (next: ItProject) => Promise<boolean> }) {
  useEscape(onClose)
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const text = (name: string) => String(form.get(name) ?? '').trim()
    if (!text('name')) return
    const now = new Date().toISOString()
    const next: ItProject = {
      id: item?.id ?? `PRJ-${Date.now()}`,
      name: text('name'),
      client: text('client'),
      status: (text('status') as ItProjectStatus) || '수주 검토',
      owner: text('owner') || currentUserName,
      ownerId: item?.ownerId ?? currentUserId,
      startDate: text('startDate'),
      dueDate: text('dueDate'),
      amount: Math.max(0, Number(form.get('amount') || 0)),
      note: text('note'),
      createdAt: item?.createdAt ?? now,
      updatedAt: now,
    }
    setBusy(true)
    if (await onSave(next)) onClose()
    else setBusy(false)
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="modal-card it-modal" role="dialog" aria-modal="true" aria-labelledby="it-project-title">
      <header><div><span className="eyebrow">PROJECT</span><h2 id="it-project-title">{item ? '프로젝트 수정' : '프로젝트 등록'}</h2><p>이름만 입력해도 등록됩니다. 나머지는 나중에 채워도 됩니다.</p></div><IconButton tone="ghost" type="button" aria-label="닫기" onClick={onClose}><X size={21} /></IconButton></header>
      <form onSubmit={submit}>
        <label className="form-field full"><span>프로젝트명 <em className="field-required">필수</em></span><input name="name" autoFocus defaultValue={item?.name ?? ''} required placeholder="예: 3D 전시 콘텐츠 제작" /></label>
        <div className="form-grid"><label className="form-field"><span>거래처</span><input name="client" defaultValue={item?.client ?? ''} placeholder="예: ○○박물관" /></label><label className="form-field"><span>상태</span><select name="status" defaultValue={item?.status ?? '수주 검토'}>{projectStatuses.map((status) => <option key={status}>{status}</option>)}</select></label></div>
        <div className="form-grid"><label className="form-field"><span>시작일</span><input name="startDate" type="date" defaultValue={item?.startDate ?? seoulDateInputValue()} /></label><label className="form-field"><span>마감일</span><input name="dueDate" type="date" defaultValue={item?.dueDate ?? ''} /></label></div>
        <div className="form-grid"><label className="form-field"><span>담당자</span><input name="owner" defaultValue={item?.owner ?? currentUserName} /></label><label className="form-field"><span>계약 금액 (원)</span><input name="amount" type="number" min="0" step="1000" defaultValue={item?.amount ?? 0} /></label></div>
        <label className="form-field full"><span>메모</span><textarea name="note" rows={3} defaultValue={item?.note ?? ''} placeholder="범위·특이사항" /></label>
        <footer><Button tone="ghost" type="button" disabled={busy} onClick={onClose}>취소</Button><Button tone="primary" type="submit" disabled={busy}><Check size={18} /> {busy ? '저장 중…' : '저장'}</Button></footer>
      </form>
    </section>
  </div>
}

function DeliverableEditor({ item, projects, defaultProjectId, workspaceScope, currentUserName, onToast, onClose, onSave }: { item?: ItDeliverable; projects: Array<{ id: string; name: string }>; defaultProjectId: string; workspaceScope?: string; currentUserName: string; onToast: (message: string) => void; onClose: () => void; onSave: (next: ItDeliverable) => Promise<boolean> }) {
  useEscape(onClose)
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
    const form = new FormData(event.currentTarget)
    const text = (name: string) => String(form.get(name) ?? '').trim()
    if (!text('name') || !text('projectId')) return
    const now = new Date().toISOString()
    const next: ItDeliverable = {
      id: item?.id ?? `DLV-${Date.now()}`,
      projectId: text('projectId'),
      name: text('name'),
      version: text('version') || 'v1.0',
      attachments,
      note: text('note'),
      createdBy: item?.createdBy ?? currentUserName,
      createdAt: item?.createdAt ?? now,
      updatedAt: now,
    }
    setBusy(true)
    if (await onSave(next)) { uploadedRef.current.clear(); onClose() } else setBusy(false)
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && void cancel()}>
    <section className="modal-card it-modal" role="dialog" aria-modal="true" aria-labelledby="it-deliverable-title">
      <header><div><span className="eyebrow">DELIVERABLE</span><h2 id="it-deliverable-title">{item ? '산출물 수정' : '산출물 등록'}</h2><p>프로젝트와 버전을 정하고 파일을 올립니다.</p></div><IconButton tone="ghost" type="button" aria-label="닫기" disabled={busy || uploading} onClick={() => void cancel()}><X size={21} /></IconButton></header>
      <form onSubmit={submit}>
        <div className="form-grid"><label className="form-field"><span>프로젝트 <em className="field-required">필수</em></span><select name="projectId" defaultValue={item?.projectId ?? defaultProjectId} required>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><label className="form-field"><span>버전</span><input name="version" defaultValue={item?.version ?? 'v1.0'} placeholder="v1.0" /></label></div>
        <label className="form-field full"><span>산출물명 <em className="field-required">필수</em></span><input name="name" autoFocus defaultValue={item?.name ?? ''} required placeholder="예: 화면 설계서" /></label>
        <label className="form-field full"><span>메모</span><textarea name="note" rows={2} defaultValue={item?.note ?? ''} placeholder="변경 요약" /></label>
        <section className="it-upload"><div><strong>파일 <small>선택 · 파일당 10MB</small></strong></div><input ref={fileRef} className="sr-only" type="file" multiple onChange={async (event) => {
          const files = Array.from(event.target.files ?? []); event.target.value = ''
          if (!files.length) return
          setUploading(true)
          try {
            const added = await uploadDocumentAttachments(files, { workspaceScope, category: '프로젝트 산출물', summary: `${text(form(event), 'name') || '산출물'} 파일`, tags: ['it-deliverable'] })
            for (const file of added) uploadedRef.current.add(file.id)
            setAttachments((current) => [...current, ...added])
          } catch (error) { onToast(error instanceof Error ? error.message : '파일을 업로드하지 못했습니다.') }
          finally { setUploading(false) }
        }} /><Button tone="secondary" type="button" disabled={uploading || busy} onClick={() => fileRef.current?.click()}><Paperclip size={17} /> {uploading ? '업로드 중…' : '파일 추가'}</Button></section>
        {attachments.length > 0 && <div className="it-file-list">{attachments.map((file) => <span key={file.id}><Paperclip size={14} /> {file.name} · {file.size}<button type="button" aria-label={`${file.name} 제외`} onClick={() => setAttachments((current) => current.filter((entry) => entry.id !== file.id))}><X size={14} /></button></span>)}</div>}
        <footer><Button tone="ghost" type="button" disabled={busy || uploading} onClick={() => void cancel()}>취소</Button><Button tone="primary" type="submit" disabled={busy || uploading}><Check size={18} /> {busy ? '저장 중…' : '저장'}</Button></footer>
      </form>
    </section>
  </div>
}

function ContractEditor({ item, clients, workspaceScope, onToast, onClose, onSave }: { item?: ItContract; clients: ItClient[]; workspaceScope?: string; onToast: (message: string) => void; onClose: () => void; onSave: (next: ItContract) => Promise<boolean> }) {
  useEscape(onClose)
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [attachments, setAttachments] = useState<StoredDocumentAttachment[]>(item?.attachments ?? [])
  const [extraction, setExtraction] = useState<DocumentExtractionState>({ status: 'idle' })
  // 계약 등록도 계약서 파일부터 시작한다. 확인 화면을 마치거나 "직접 입력"을 고른 뒤에 입력칸이 열린다.
  const [showForm, setShowForm] = useState(Boolean(item))
  const [approved, setApproved] = useState<Record<string, string>>({})
  const fileRef = useRef<HTMLInputElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const uploadedRef = useRef(new Set<string>())
  const extractionAbortRef = useRef<AbortController | null>(null)
  const extracting = extraction.status === 'extracting'
  const cancel = async () => {
    extractionAbortRef.current?.abort()
    if (uploadedRef.current.size) await deleteDocumentAttachments([...uploadedRef.current], workspaceScope)
    onClose()
  }
  const extract = async (attachment: StoredDocumentAttachment) => {
    extractionAbortRef.current?.abort()
    const controller = new AbortController()
    extractionAbortRef.current = controller
    setExtraction({ status: 'extracting', sourceId: attachment.id, sourceName: attachment.name })
    try {
      const draft = await requestDocumentExtraction(attachment.id, 'contract', workspaceScope, controller.signal)
      if (controller.signal.aborted) return
      setExtraction({ status: 'review', sourceId: attachment.id, sourceName: attachment.name, draft })
    } catch (error) {
      if (controller.signal.aborted) return
      setShowForm(true)
      setExtraction({ status: 'failed', sourceId: attachment.id, sourceName: attachment.name, message: error instanceof Error ? error.message : 'AI가 계약서를 읽지 못했습니다.' })
    }
  }
  const approveExtraction = (values: Record<string, string>) => {
    if (extraction.status !== 'review') return
    const typed = readFormValues(formRef.current, DOCUMENT_EXTRACTION_FIELDS.contract.map((field) => field.name))
    setApproved((current) => ({ ...current, ...typed, ...values }))
    applyApprovedValues(formRef.current, values)
    setShowForm(true)
    setExtraction({
      status: 'applied', sourceId: extraction.sourceId, sourceName: extraction.sourceName,
      appliedFields: Object.keys(values).length, confidence: extraction.draft.confidence, warnings: extraction.draft.warnings,
    })
  }
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const text = (name: string) => String(form.get(name) ?? '').trim()
    if (!text('client') || !text('title')) return
    const next: ItContract = {
      id: item?.id ?? `CTR-${Date.now()}`,
      client: text('client'),
      title: text('title'),
      number: text('number'),
      startDate: text('startDate'),
      endDate: text('endDate'),
      amount: Math.max(0, Number(form.get('amount') || 0)),
      attachments,
      note: text('note'),
      updatedAt: new Date().toISOString(),
    }
    setBusy(true)
    if (await onSave(next)) { uploadedRef.current.clear(); onClose() } else setBusy(false)
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && void cancel()}>
    <section className="modal-card it-modal" role="dialog" aria-modal="true" aria-labelledby="it-contract-title">
      <header><div><span className="eyebrow">CONTRACT</span><h2 id="it-contract-title">{item ? '계약 수정' : '계약 등록'}</h2><p>{item ? '계약서를 다시 올리면 값을 새로 읽어 드립니다.' : '계약서 파일을 올리면 계약명·거래처·기간·금액을 읽어 확인 화면에 보여 드립니다.'}</p></div><IconButton tone="ghost" type="button" aria-label="닫기" disabled={busy || uploading} onClick={() => void cancel()}><X size={21} /></IconButton></header>
      <form ref={formRef} onSubmit={submit}>
        <section className="it-upload"><div><strong>계약서 파일 <small>PDF·이미지는 AI 자동 입력</small></strong></div><input ref={fileRef} className="sr-only" type="file" multiple accept="application/pdf,image/jpeg,image/png,image/gif,image/webp" onChange={async (event) => {
          const files = Array.from(event.target.files ?? []); event.target.value = ''
          if (!files.length) return
          setUploading(true)
          try {
            const added = await uploadDocumentAttachments(files, { workspaceScope, category: '계약 · 거래처', summary: '계약 문서', tags: ['it-contract', 'AI-판독대상'] })
            for (const file of added) uploadedRef.current.add(file.id)
            setAttachments((current) => [...current, ...added])
            const sourceIndex = files.findIndex(canExtractDocumentFile)
            if (sourceIndex >= 0 && added[sourceIndex]) void extract(added[sourceIndex])
          } catch (error) { onToast(error instanceof Error ? error.message : '문서를 업로드하지 못했습니다.') }
          finally { setUploading(false) }
        }} /><Button tone="secondary" type="button" data-initial-focus={!item ? 'true' : undefined} disabled={uploading || busy} onClick={() => fileRef.current?.click()}><Paperclip size={17} /> {uploading ? '업로드 중…' : '계약서 올리기'}</Button></section>
        {attachments.length > 0 && <div className="it-file-list">{attachments.map((file) => <span key={file.id}><Paperclip size={14} /> {file.name} · {file.size}<button type="button" aria-label={`${file.name} 제외`} onClick={() => setAttachments((current) => current.filter((entry) => entry.id !== file.id))}><X size={14} /></button></span>)}</div>}
        <DocumentExtractionReview
          kind="contract"
          state={extraction}
          disabled={busy || uploading}
          onApprove={approveExtraction}
          onDismiss={() => { setShowForm(true); setExtraction({ status: 'idle' }) }}
          onRetry={extraction.status !== 'review' && extraction.sourceId ? () => { const source = attachments.find((attachment) => attachment.id === extraction.sourceId); if (source) void extract(source) } : undefined}
        />
        {!showForm
          ? <section className="it-manual-entry"><p>파일이 없거나 AI 없이 등록하려면 직접 입력할 수 있습니다.</p><div><Button tone="ghost" type="button" disabled={busy || uploading} onClick={() => void cancel()}>취소</Button><Button tone="secondary" type="button" disabled={busy || uploading || extracting} onClick={() => setShowForm(true)}>파일 없이 직접 입력</Button></div></section>
          : <>
        <div className="form-grid"><label className="form-field"><span>거래처 <em className="field-required">필수</em></span><input name="client" list="it-client-options" autoFocus defaultValue={approved.client ?? item?.client ?? ''} required placeholder={clients.length ? '등록된 거래처에서 고르거나 직접 입력' : '예: ○○주식회사'} /><datalist id="it-client-options">{clients.map((client) => <option key={client.id} value={client.name}>{[client.contactName, client.phone].filter(Boolean).join(' · ')}</option>)}</datalist></label><label className="form-field"><span>계약명 <em className="field-required">필수</em></span><input name="title" defaultValue={approved.title ?? item?.title ?? ''} required placeholder="예: 유지보수 연간 계약" /></label></div>
        <label className="form-field full"><span>계약번호</span><input name="number" defaultValue={approved.number ?? item?.number ?? ''} placeholder="예: 2026-CT-014" /></label>
        <div className="form-grid"><label className="form-field"><span>계약 시작일</span><input name="startDate" type="date" defaultValue={approved.startDate ?? item?.startDate ?? seoulDateInputValue()} /></label><label className="form-field"><span>계약 종료일</span><input name="endDate" type="date" defaultValue={approved.endDate ?? item?.endDate ?? ''} /></label></div>
        <label className="form-field full"><span>계약 금액 (원)</span><input name="amount" type="number" min="0" step="1000" defaultValue={approved.amount ?? item?.amount ?? 0} /></label>
        <label className="form-field full"><span>메모</span><textarea name="note" rows={2} defaultValue={item?.note ?? ''} placeholder="결제 조건·특약" /></label>
        <footer><Button tone="ghost" type="button" disabled={busy || uploading} onClick={() => void cancel()}>취소</Button><Button tone="primary" type="submit" disabled={busy || uploading || extracting}><Check size={18} /> {busy ? '저장 중…' : extracting ? 'AI 읽는 중…' : '확인 후 저장'}</Button></footer>
          </>}
      </form>
    </section>
  </div>
}

// 파일 업로드 시 폼의 현재 입력값을 읽기 위한 작은 도우미
function form(event: { target: EventTarget | null }) {
  return (event.target as HTMLInputElement | null)?.form ?? null
}
function text(formElement: HTMLFormElement | null, name: string) {
  if (!formElement) return ''
  return String(new FormData(formElement).get(name) ?? '').trim()
}

function ClientEditor({ item, onClose, onSave }: { item?: ItClient; onClose: () => void; onSave: (next: ItClient) => Promise<boolean> }) {
  useEscape(onClose)
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const field = (name: string) => String(data.get(name) ?? '').trim()
    if (!field('name')) return
    const next: ItClient = {
      id: item?.id ?? `CLI-${Date.now()}`,
      name: field('name'),
      businessNo: field('businessNo'),
      contactName: field('contactName'),
      phone: field('phone'),
      email: field('email'),
      address: field('address'),
      industry: field('industry'),
      note: field('note'),
      updatedAt: new Date().toISOString(),
    }
    setBusy(true)
    if (await onSave(next)) onClose(); else setBusy(false)
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="modal-card it-modal" role="dialog" aria-modal="true" aria-labelledby="it-client-title">
      <header><div><span className="eyebrow">CLIENT</span><h2 id="it-client-title">{item ? '거래처 수정' : '거래처 등록'}</h2><p>회사명만 있으면 등록됩니다. 나머지는 알게 될 때 채우세요.</p></div><IconButton tone="ghost" type="button" aria-label="닫기" onClick={onClose}><X size={21} /></IconButton></header>
      <form onSubmit={submit}>
        <div className="form-grid"><label className="form-field"><span>회사명 <em className="field-required">필수</em></span><input name="name" autoFocus defaultValue={item?.name ?? ''} required placeholder="예: ○○주식회사" /></label><label className="form-field"><span>사업자등록번호</span><input name="businessNo" defaultValue={item?.businessNo ?? ''} placeholder="000-00-00000" /></label></div>
        <div className="form-grid"><label className="form-field"><span>담당자</span><input name="contactName" defaultValue={item?.contactName ?? ''} placeholder="이름 · 직책" /></label><label className="form-field"><span>연락처</span><input name="phone" defaultValue={item?.phone ?? ''} placeholder="010-0000-0000" /></label></div>
        <div className="form-grid"><label className="form-field"><span>이메일</span><input name="email" type="email" defaultValue={item?.email ?? ''} placeholder="contact@company.co.kr" /></label><label className="form-field"><span>업종 · 분야</span><input name="industry" defaultValue={item?.industry ?? ''} placeholder="예: 제조 · 유통" /></label></div>
        <label className="form-field full"><span>주소</span><input name="address" defaultValue={item?.address ?? ''} placeholder="도로명 주소" /></label>
        <label className="form-field full"><span>메모</span><textarea name="note" rows={2} defaultValue={item?.note ?? ''} placeholder="거래 이력·특이사항" /></label>
        <footer><Button tone="ghost" type="button" disabled={busy} onClick={onClose}>취소</Button><Button tone="primary" type="submit" disabled={busy}><Check size={18} /> {busy ? '저장 중…' : '저장'}</Button></footer>
      </form>
    </section>
  </div>
}

function ProgramEditor({ item, workspaceScope, currentUserName, onToast, onClose, onSave }: { item?: ItSupportProgram; workspaceScope?: string; currentUserName: string; onToast: (message: string) => void; onClose: () => void; onSave: (next: ItSupportProgram) => Promise<boolean> }) {
  useEscape(onClose)
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
    const status = SUPPORT_PROGRAM_STATUSES.includes(field('status') as SupportProgramStatus) ? field('status') as SupportProgramStatus : '준비'
    const next: ItSupportProgram = {
      id: item?.id ?? `SUP-${Date.now()}`,
      title: field('title'),
      agency: field('agency'),
      status,
      amount: Math.max(0, Number(data.get('amount') || 0)),
      applyStart: field('applyStart'),
      applyEnd: field('applyEnd'),
      startDate: field('startDate'),
      endDate: field('endDate'),
      owner: field('owner'),
      attachments,
      note: field('note'),
      updatedAt: new Date().toISOString(),
    }
    setBusy(true)
    if (await onSave(next)) { uploadedRef.current.clear(); onClose() } else setBusy(false)
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && void cancel()}>
    <section className="modal-card it-modal" role="dialog" aria-modal="true" aria-labelledby="it-program-title">
      <header><div><span className="eyebrow">SUPPORT PROGRAM</span><h2 id="it-program-title">{item ? '지원사업 수정' : '지원사업 등록'}</h2><p>사업명만 있으면 등록됩니다. 접수·사업 기간을 넣으면 마감을 알려 드립니다.</p></div><IconButton tone="ghost" type="button" aria-label="닫기" onClick={() => void cancel()}><X size={21} /></IconButton></header>
      <form onSubmit={submit}>
        <div className="form-grid"><label className="form-field"><span>사업명 <em className="field-required">필수</em></span><input name="title" autoFocus defaultValue={item?.title ?? ''} required placeholder="예: 2026 스마트공장 구축 지원" /></label><label className="form-field"><span>주관기관</span><input name="agency" defaultValue={item?.agency ?? ''} placeholder="예: 중소벤처기업부 · 테크노파크" /></label></div>
        <div className="form-grid"><label className="form-field"><span>진행 상태</span><select name="status" defaultValue={item?.status ?? '준비'}>{SUPPORT_PROGRAM_STATUSES.map((status) => <option key={status}>{status}</option>)}</select></label><label className="form-field"><span>지원 금액 (원)</span><input name="amount" type="number" min="0" step="10000" defaultValue={item?.amount ?? 0} /></label></div>
        <div className="form-grid"><label className="form-field"><span>접수 시작</span><input name="applyStart" type="date" defaultValue={item?.applyStart ?? ''} /></label><label className="form-field"><span>접수 마감</span><input name="applyEnd" type="date" defaultValue={item?.applyEnd ?? ''} /></label></div>
        <div className="form-grid"><label className="form-field"><span>사업 시작</span><input name="startDate" type="date" defaultValue={item?.startDate ?? ''} /></label><label className="form-field"><span>사업 종료</span><input name="endDate" type="date" defaultValue={item?.endDate ?? ''} /></label></div>
        <label className="form-field full"><span>담당자</span><input name="owner" defaultValue={item?.owner ?? currentUserName} /></label>
        <label className="form-field full"><span>메모</span><textarea name="note" rows={2} defaultValue={item?.note ?? ''} placeholder="신청 요건·제출 서류·후속 일정" /></label>
        <section className="it-upload"><div><strong>공고문 · 신청서 <small>선택</small></strong></div><input ref={fileRef} className="sr-only" type="file" multiple onChange={async (event) => {
          const files = Array.from(event.target.files ?? []); event.target.value = ''
          if (!files.length) return
          setUploading(true)
          try {
            const added = await uploadDocumentAttachments(files, { workspaceScope, category: '지원사업', summary: '지원사업 문서', tags: ['support-program'] })
            for (const file of added) uploadedRef.current.add(file.id)
            setAttachments((current) => [...current, ...added])
          } catch (error) { onToast(error instanceof Error ? error.message : '문서를 업로드하지 못했습니다.') }
          finally { setUploading(false) }
        }} /><Button tone="secondary" type="button" disabled={uploading || busy} onClick={() => fileRef.current?.click()}><Paperclip size={17} /> {uploading ? '업로드 중…' : '문서 추가'}</Button></section>
        {attachments.length > 0 && <div className="it-file-list">{attachments.map((file) => <span key={file.id}><Paperclip size={14} /> {file.name} · {file.size}<button type="button" aria-label={`${file.name} 제외`} onClick={() => setAttachments((current) => current.filter((entry) => entry.id !== file.id))}><X size={13} /></button></span>)}</div>}
        <footer><Button tone="ghost" type="button" disabled={busy || uploading} onClick={() => void cancel()}>취소</Button><Button tone="primary" type="submit" disabled={busy || uploading}><Check size={18} /> {busy ? '저장 중…' : '저장'}</Button></footer>
      </form>
    </section>
  </div>
}

import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { Archive, ArrowLeft, ClipboardList, Download, Eye, EyeOff, FileArchive, FileUp, GitCompare, Layers, Link2, ListChecks, MessageSquareQuote, RefreshCw, RotateCcw, Send, ShieldCheck, UserCheck, X } from 'lucide-react'
import { formatDateTime } from '../../utils/dateTime'
import { Button, IconButton } from '../ui/Button'
import { MaterialReview } from './MaterialReview'
import { DecidersDialog, DecisionSummaryDialog, ImportOpinionsDialog, RequestReviewDialog } from './MaterialDecisions'
import { CompareDialog, LinksDialog, NextVersionDialog } from './MaterialVersions'
import { MoreMenu } from '../ui/MoreMenu'
import { OverviewDialog } from './MaterialSynthesis'
import {
  MaterialApiError, archiveMaterial, downloadMaterialExport, downloadMaterialSource, formatBytes, getMaterial, importMaterial, listMaterials,
  type MaterialDetail, type MaterialSummary,
} from './materialsApi'
import './Materials.css'

/**
 * 문서 › 검토 자료. AI가 만든 HTML 회의 자료를 올려 모두가 같은 화면에서 읽는다.
 * 한 화면에 한 가지: 목록(올리기 포함) 또는 자료 하나. 버튼 글자는 "무엇이 일어나는가"를 말한다.
 */
type PendingUpload = { file: File; materialId?: string; candidate?: { id: string; title: string; currentVersion: number } }

export function MaterialsPage({ workspaceScope, focusMaterialId, onFocusHandled, preferReading = false, currentUserId, isAdmin, onOpenDocument, onToast }: {
  workspaceScope?: string
  /** 결정 기록 문서(위키)를 연다. */
  onOpenDocument?: (documentId: string) => void
  /** 큰 글자·쉬운 화면을 쓰는 사람은 읽기 모드로 연다. */
  preferReading?: boolean
  currentUserId: string
  isAdmin: boolean
  focusMaterialId?: string | null
  onFocusHandled?: () => void
  onToast: (message: string) => void
}) {
  const [materials, setMaterials] = useState<MaterialSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [openId, setOpenId] = useState<string | null>(focusMaterialId ?? null)
  const [uploading, setUploading] = useState('')
  const [askNewVersion, setAskNewVersion] = useState<PendingUpload | null>(null)
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const versionTargetRef = useRef<string | undefined>(undefined)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const body = await listMaterials(workspaceScope, { archived: showArchived })
      setMaterials(body.materials)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '검토 자료 목록을 불러오지 못했습니다.')
    } finally {
      setLoading(false)
    }
  }, [workspaceScope, showArchived])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!focusMaterialId) return
    setOpenId(focusMaterialId)
    onFocusHandled?.()
  }, [focusMaterialId, onFocusHandled])

  const upload = async (pending: PendingUpload, { newMaterial = false } = {}) => {
    setAskNewVersion(null)
    setUploading(pending.materialId ? '새 판을 올리는 중입니다… 큰 자료는 30초까지 걸려요.' : '자료를 올리고 항목을 읽는 중입니다… 큰 자료는 30초까지 걸려요.')
    try {
      const material = await importMaterial(workspaceScope, pending.file, { materialId: pending.materialId, newMaterial })
      onToast(pending.materialId ? `「${material.title}」 ${material.currentVersion}판을 올렸습니다.` : `「${material.title}」을(를) 올렸습니다. 항목 ${material.versions[0]?.anchorCount ?? 0}개를 찾았습니다.`)
      setOpenId(material.id)
      void load()
    } catch (cause) {
      if (cause instanceof MaterialApiError && cause.code === 'MATERIAL_KEY_EXISTS' && cause.candidate) {
        setAskNewVersion({ file: pending.file, candidate: cause.candidate })
      } else {
        onToast(cause instanceof Error ? cause.message : '자료를 올리지 못했습니다.')
      }
    } finally {
      setUploading('')
    }
  }

  const pickFile = (materialId?: string) => {
    versionTargetRef.current = materialId
    fileInputRef.current?.click()
  }

  const onFiles = (files: FileList | null) => {
    const file = files?.[0]
    if (!file) return
    const materialId = versionTargetRef.current
    versionTargetRef.current = undefined
    void upload({ file, materialId })
  }

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    setDragging(false)
    onFiles(event.dataTransfer?.files ?? null)
  }

  const fileInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept=".html,.htm,text/html"
      hidden
      onChange={(event) => { onFiles(event.currentTarget.files); event.currentTarget.value = '' }}
    />
  )

  const askDialog = askNewVersion?.candidate && (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setAskNewVersion(null) }}>
      <section className="modal-card material-ask-modal" role="dialog" aria-modal="true" aria-labelledby="material-ask-title">
        <header>
          <div>
            <span className="eyebrow">NEW VERSION?</span>
            <h2 id="material-ask-title">같은 자료의 새 판인가요?</h2>
            <p>「{askNewVersion.candidate.title}」 {askNewVersion.candidate.currentVersion}판이 이미 있습니다. 새 판으로 올리면 지난 판의 의견이 같은 항목을 따라옵니다.</p>
          </div>
          <IconButton tone="ghost" type="button" aria-label="닫기" onClick={() => setAskNewVersion(null)}><X size={21} /></IconButton>
        </header>
        <footer>
          <Button tone="ghost" type="button" onClick={() => void upload({ file: askNewVersion.file }, { newMaterial: true })}>별도 자료로 올리기</Button>
          <Button tone="primary" type="button" onClick={() => void upload({ file: askNewVersion.file, materialId: askNewVersion.candidate?.id })}>{askNewVersion.candidate.currentVersion + 1}판으로 올리기</Button>
        </footer>
      </section>
    </div>
  )

  if (openId) {
    return (
      <>
        {fileInput}
        {askDialog}
        {uploading && <p className="material-uploading" role="status">{uploading}</p>}
        <MaterialDetailView
          workspaceScope={workspaceScope}
          materialId={openId}
          onBack={() => { setOpenId(null); void load() }}
          onNewVersion={(id) => pickFile(id)}
          busy={Boolean(uploading)}
          preferReading={preferReading}
          currentUserId={currentUserId}
          isAdmin={isAdmin}
          onOpenDocument={onOpenDocument}
          onToast={onToast}
        />
      </>
    )
  }

  return (
    <div className="content-page material-page">
      {fileInput}
      {askDialog}
      <header className="page-header">
        <div>
          <span className="eyebrow">REVIEW</span>
          <h1>검토 자료</h1>
          <p>AI가 만든 HTML 회의 자료를 올리면 모두가 같은 화면에서 읽고, 판이 바뀌어도 이력이 이어집니다.</p>
        </div>
        <div className="page-header-actions">
          <Button tone="primary" type="button" disabled={Boolean(uploading)} onClick={() => pickFile()}><FileUp size={17} aria-hidden="true" /> 자료 올리기</Button>
          <Button tone="quiet" type="button" onClick={() => void load()}><RefreshCw size={17} aria-hidden="true" /> 새로고침</Button>
        </div>
      </header>

      <section
        className={`material-drop${dragging ? ' is-dragging' : ''}`}
        aria-label="자료 올리기"
        onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <FileUp size={22} aria-hidden="true" />
        <div>
          <strong>{uploading || 'HTML 파일을 여기에 끌어다 놓거나 [자료 올리기]를 누르세요.'}</strong>
          <span>30MB까지 · 원본은 그대로 보관하고, 자료는 앱과 분리된 안전한 칸에서 열립니다.</span>
        </div>
      </section>

      {error && <p className="material-error" role="alert">{error}</p>}

      <div className="material-list-head">
        <h2>{showArchived ? '보관한 자료' : '진행 중인 자료'}</h2>
        <Button tone="quiet" size="sm" type="button" onClick={() => setShowArchived((value) => !value)}>
          {showArchived ? '진행 중인 자료 보기' : '보관한 자료 보기'}
        </Button>
      </div>
      {loading ? <p className="material-empty">검토 자료를 불러오는 중입니다…</p> : materials.length === 0 ? (
        <div className="material-empty">
          <Layers size={26} aria-hidden="true" />
          <h3>{showArchived ? '보관한 자료가 없습니다.' : '아직 올린 검토 자료가 없습니다.'}</h3>
          {!showArchived && <p>Claude 같은 AI로 만든 회의 자료(HTML)를 올려 보세요. 기업 자료실의 HTML 파일에서 [함께 검토하기]를 눌러도 됩니다.</p>}
        </div>
      ) : (
        <ul className="material-list">
          {materials.map((material) => (
            <li key={material.id}>
              <button type="button" className="material-row" onClick={() => setOpenId(material.id)}>
                <strong>{material.title}</strong>
                <small>
                  {material.currentVersion}판 · 항목 {material.anchorCount.toLocaleString('ko-KR')}개
                  {material.decisionAnchorCount ? ` · 결정 받을 항목 ${material.decisionAnchorCount}개` : ''}
                  {material.projectName ? ` · ${material.projectName}` : ''}
                </small>
                <small>{material.ownerName} · {formatDateTime(material.updatedAt)}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

type DetailDialog = 'request' | 'summary' | 'import' | 'deciders' | 'links' | 'compare' | 'overview' | 'next' | null

function MaterialDetailView({ workspaceScope, materialId, onBack, onNewVersion, busy, preferReading, currentUserId, isAdmin, onOpenDocument, onToast }: {
  workspaceScope?: string
  materialId: string
  onBack: () => void
  onNewVersion: (materialId: string) => void
  busy: boolean
  preferReading: boolean
  currentUserId: string
  isAdmin: boolean
  onOpenDocument?: (documentId: string) => void
  onToast: (message: string) => void
}) {
  const [material, setMaterial] = useState<MaterialDetail | null>(null)
  const [dialog, setDialog] = useState<DetailDialog>(null)
  const [reviewKey, setReviewKey] = useState(0)
  const [focusRequest, setFocusRequest] = useState<{ lineageId: string; at: number } | null>(null)
  const [error, setError] = useState('')
  const [version, setVersion] = useState<number | null>(null)
  const [showNative, setShowNative] = useState(false)
  const [nativeControls, setNativeControls] = useState(0)

  const load = useCallback(async () => {
    try {
      const next = await getMaterial(workspaceScope, materialId)
      setMaterial(next)
      setVersion((current) => (current && next.versions.some((row) => row.version === current) ? current : next.currentVersion))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '검토 자료를 불러오지 못했습니다.')
    }
  }, [workspaceScope, materialId])

  // 새 판을 올리면(부모의 busy가 끝나면) 판 목록을 다시 읽고 가장 새 판을 연다.
  const wasBusy = useRef(busy)
  useEffect(() => {
    if (wasBusy.current && !busy) { setVersion(null); void load() }
    wasBusy.current = busy
  }, [busy, load])
  useEffect(() => { void load() }, [load])

  if (error) {
    return (
      <div className="content-page material-page">
        <Button tone="quiet" type="button" onClick={onBack}><ArrowLeft size={17} aria-hidden="true" /> 검토 자료 목록</Button>
        <p className="material-error" role="alert">{error}</p>
      </div>
    )
  }
  if (!material || version === null) return <div className="content-page material-page"><p className="material-loading">검토 자료를 불러오는 중입니다…</p></div>

  const current = material.versions.find((row) => row.version === version) ?? material.versions[0]
  const report = current?.report ?? {}
  const archived = material.status === 'archived'

  const toggleArchive = async () => {
    try {
      const next = await archiveMaterial(workspaceScope, material.id, archived)
      setMaterial(next)
      onToast(archived ? '자료를 다시 진행 중으로 돌렸습니다.' : '자료를 보관했습니다. 원본·의견은 지워지지 않습니다.')
    } catch (cause) { onToast(cause instanceof Error ? cause.message : '처리하지 못했습니다.') }
  }

  return (
    <div className="content-page material-page material-detail">
      <div className="material-detail-top">
        <Button tone="quiet" type="button" onClick={onBack}><ArrowLeft size={17} aria-hidden="true" /> 검토 자료 목록</Button>
      </div>
      <header className="page-header material-detail-head">
        <div>
          <span className="eyebrow">{archived ? 'ARCHIVED' : 'REVIEW'}</span>
          <h1>{material.title}</h1>
          <p>
            {current.version}판 · 항목 {current.anchorCount.toLocaleString('ko-KR')}개
            {material.decisionAnchorCount ? ` · 결정 받을 항목 ${material.decisionAnchorCount}개` : ''}
            {' · '}{current.importedByName} · {formatDateTime(current.importedAt)}
          </p>
          {current.versionNote && <p className="material-version-note">이번 판: {current.versionNote}</p>}
          <p className="material-deciders">
            결정은 <strong>{material.deciders.join(', ')}</strong>님과 회사 관리자가 합니다.
            {material.dueAt && <> · 의견 마감 <strong>{formatDateTime(material.dueAt)}</strong></>}
            {material.canManage && !archived && <Button tone="quiet" size="sm" type="button" onClick={() => setDialog('deciders')}><UserCheck size={15} aria-hidden="true" /> 결정권자 지정</Button>}
          </p>
        </div>
        <div className="page-header-actions">
          {material.versions.length > 1 && (
            <label className="material-version-picker">
              <span>판</span>
              <select value={version} onChange={(event) => setVersion(Number(event.target.value))}>
                {material.versions.map((row) => <option key={row.version} value={row.version}>{row.version}판 · {formatDateTime(row.importedAt)}</option>)}
              </select>
            </label>
          )}
          {/* 자주 쓰는 셋만 밖에 두고 나머지는 [더 보기]에 접는다 — 버튼이 많으면 무엇을 먼저 눌러야 할지 모른다. */}
          {material.canManage && !archived && <Button tone={material.reviewRequestedAt ? 'secondary' : 'primary'} type="button" onClick={() => setDialog('request')}><Send size={17} aria-hidden="true" /> {material.reviewRequestedAt ? '검토 요청 다시 보내기' : '검토 요청 보내기'}</Button>}
          <Button tone="secondary" type="button" onClick={() => setDialog('overview')}><ListChecks size={17} aria-hidden="true" /> 회의 준비</Button>
          <Button tone="secondary" type="button" onClick={() => setDialog('summary')}><ClipboardList size={17} aria-hidden="true" /> 결정 요약</Button>
          <MoreMenu items={[
            { id: 'compare', label: '판 비교', icon: <GitCompare size={18} aria-hidden="true" />, hidden: material.versions.length < 2, onSelect: () => setDialog('compare') },
            { id: 'new-version', label: '새 판 올리기', icon: <FileUp size={18} aria-hidden="true" />, hidden: !material.canManage || archived || busy, onSelect: () => onNewVersion(material.id) },
            { id: 'next', label: '다음 판 요청서 (AI에 줄 글)', icon: <MessageSquareQuote size={18} aria-hidden="true" />, onSelect: () => setDialog('next') },
            { id: 'source', label: '원본 내려받기', icon: <Download size={18} aria-hidden="true" />, onSelect: () => { void downloadMaterialSource(workspaceScope, current.sourceDocumentId, `${material.title} ${current.version}판.html`).catch((cause: unknown) => onToast(cause instanceof Error ? cause.message : '원본을 내려받지 못했습니다.')) } },
            { id: 'export', label: '전체 기록 내려받기 (ZIP)', icon: <FileArchive size={18} aria-hidden="true" />, onSelect: () => { void downloadMaterialExport(workspaceScope, material.id, material.title).catch((cause: unknown) => onToast(cause instanceof Error ? cause.message : '기록을 묶지 못했습니다.')) } },
            { id: 'archive', label: archived ? '다시 진행으로' : '보관 (목록에서 내리기)', icon: archived ? <RotateCcw size={18} aria-hidden="true" /> : <Archive size={18} aria-hidden="true" />, hidden: !material.canManage, onSelect: () => void toggleArchive() },
          ]} />
        </div>
      </header>

      <ul className="material-report" aria-label="가져오기 결과">
        <li><ShieldCheck size={16} aria-hidden="true" /> 앱과 분리된 안전한 칸에서 열립니다{report.scripts ? ` · 자료 속 스크립트 ${report.scripts}개도 그 칸 안에서만 돕니다` : ''}.</li>
        {Boolean(report.externalRefs) && <li>밖으로 나가는 연결 {report.externalRefs}곳(글꼴·외부 그림 등)은 막았습니다. 모양이 조금 다를 수 있습니다.</li>}
        {current.links && <li>지난 판과 비교: 그대로 {current.links.same ?? 0} · 바뀜 {current.links.changed ?? 0} · 옮김 {current.links.moved ?? 0} · 새 항목 {current.links.added ?? 0} · 빠진 항목 {current.links.removed ?? 0}</li>}
        {Boolean(current.links?.proposals) && material.canManage && !archived && (
          <li className="material-report-warn">
            <Link2 size={16} aria-hidden="true" /> 지난 판과 짝이 애매한 항목이 {current.links?.proposals}개 있습니다. 확인하기 전까지는 다른 항목으로 둡니다.
            <Button tone="secondary" size="sm" type="button" onClick={() => setDialog('links')}>짝 확인하기</Button>
          </li>
        )}
        {Boolean(report.truncatedAnchors) && <li>항목이 너무 많아 앞쪽 2,000개만 의견을 받을 수 있게 했습니다.</li>}
        {nativeControls > 0 && (
          <li>
            자료 안의 자체 의견·결정 칸 {nativeControls}개를 {showNative ? '보이고 있습니다' : '숨겼습니다'} — 의견은 앱에서 남기면 판이 바뀌어도 이어집니다.
            <Button tone="quiet" size="sm" type="button" onClick={() => setShowNative((value) => !value)}>
              {showNative ? <><EyeOff size={15} aria-hidden="true" /> 다시 숨기기</> : <><Eye size={15} aria-hidden="true" /> 보이기</>}
            </Button>
          </li>
        )}
        {material.canManage && !archived && (nativeControls > 0 || Boolean(report.hasEmbeddedFeedback)) && (
          <li>
            자료 속 검토 기능으로 이미 모은 의견이 있다면 앱으로 옮길 수 있습니다.
            <Button tone="quiet" size="sm" type="button" onClick={() => setDialog('import')}>자료 속 의견 가져오기</Button>
          </li>
        )}
        <li className="material-report-size">원본 {formatBytes(current.size)} · 화면용 {formatBytes(current.renderBytes)} · 그림 {current.assetCount}장</li>
      </ul>

      {dialog === 'request' && <RequestReviewDialog workspaceScope={workspaceScope} material={material} onClose={() => setDialog(null)} onSent={setMaterial} onToast={onToast} />}
      {dialog === 'summary' && <DecisionSummaryDialog workspaceScope={workspaceScope} material={material} onClose={() => setDialog(null)} onOpenDocument={onOpenDocument} onToast={onToast} />}
      {dialog === 'import' && <ImportOpinionsDialog workspaceScope={workspaceScope} materialId={material.id} onClose={() => setDialog(null)} onImported={() => setReviewKey((value) => value + 1)} onToast={onToast} />}
      {dialog === 'deciders' && <DecidersDialog workspaceScope={workspaceScope} material={material} onClose={() => setDialog(null)} onSaved={setMaterial} onToast={onToast} />}
      {dialog === 'links' && <LinksDialog workspaceScope={workspaceScope} material={material} version={current.version} onClose={() => setDialog(null)} onSaved={(next) => { setMaterial(next); setReviewKey((value) => value + 1) }} onToast={onToast} />}
      {dialog === 'compare' && <CompareDialog workspaceScope={workspaceScope} material={material} onClose={() => setDialog(null)} onToast={onToast} />}
      {dialog === 'next' && <NextVersionDialog workspaceScope={workspaceScope} material={material} onClose={() => setDialog(null)} onToast={onToast} />}
      {dialog === 'overview' && <OverviewDialog workspaceScope={workspaceScope} material={material} onClose={() => setDialog(null)} onPick={(lineageId) => { setVersion(material.currentVersion); setFocusRequest({ lineageId, at: Date.now() }) }} onToast={onToast} />}
      <MaterialReview
        key={`${current.version}:${reviewKey}`}
        workspaceScope={workspaceScope}
        material={material}
        version={current.version}
        showNative={showNative}
        preferReading={preferReading}
        focusRequest={focusRequest}
        currentUserId={currentUserId}
        isAdmin={isAdmin}
        onNativeControls={setNativeControls}
        onToast={onToast}
      />
    </div>
  )
}

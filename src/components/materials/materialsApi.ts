/**
 * 검토 자료 API의 모양과 호출. 화면 컴포넌트는 이 파일만 부른다.
 * 서버: server/review-materials.mjs
 */
export type MaterialSummary = {
  id: string
  title: string
  projectId: string | null
  projectName: string | null
  materialKey: string
  ownerId: string
  ownerName: string
  status: 'open' | 'archived'
  currentVersion: number
  versionCount: number
  anchorCount: number
  decisionAnchorCount: number
  dueAt: string | null
  createdAt: string
  updatedAt: string
  archivedAt: string | null
  canManage: boolean
  canDecide: boolean
  deciders: string[]
  deciderIds: string[]
  reviewRequestedAt: string | null
  decisionDocId: string | null
  aiAvailable: boolean
}

export type MaterialReport = {
  scripts?: number
  externalRefs?: number
  nativeReviewControls?: number
  truncatedAnchors?: boolean
  skippedDataUris?: number
  hasEmbeddedFeedback?: boolean
}

export type MaterialVersion = {
  version: number
  sourceDocumentId: string
  size: number
  anchorCount: number
  assetCount: number
  renderBytes: number
  versionNote: string
  report: MaterialReport
  links: { same?: number; changed?: number; moved?: number; added?: number; removed?: number; proposals?: number } | null
  importedAt: string
  importedByName: string
}

export type MaterialLineage = {
  id: string
  key: string
  kind: string
  title: string
  decisionEnabled: boolean
  firstVersion: number
  lastVersion: number
}

export type MaterialDetail = MaterialSummary & { versions: MaterialVersion[]; lineages: MaterialLineage[] }

export type MaterialAnchor = {
  id: string
  key: string
  kind: string
  title: string
  text: string
  depth: number
  parentId: string | null
  decisionEnabled: boolean
  relations: string[]
  attributes: Record<string, string>
  assetShas: string[]
  order: number
  lineageId: string
}

export class MaterialApiError extends Error {
  code: string
  status: number
  candidate?: { id: string; title: string; currentVersion: number }
  constructor(message: string, code: string, status: number, candidate?: MaterialApiError['candidate']) {
    super(message)
    this.code = code
    this.status = status
    this.candidate = candidate
  }
}

const scopeHeaders = (workspaceScope?: string): Record<string, string> => (workspaceScope ? { 'x-workspace-identity': workspaceScope } : {})

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: { code?: string; message?: string }; candidate?: MaterialApiError['candidate'] }
  if (!response.ok) throw new MaterialApiError(body.error?.message || fallback, body.error?.code || 'MATERIAL_ERROR', response.status, body.candidate)
  return body
}

export async function listMaterials(workspaceScope?: string, { archived = false } = {}) {
  const response = await fetch(`/api/materials${archived ? '?archived=1' : ''}`, { headers: scopeHeaders(workspaceScope) })
  return readJson<{ materials: MaterialSummary[]; uploadLimitBytes: number }>(response, '검토 자료 목록을 불러오지 못했습니다.')
}

export async function getMaterial(workspaceScope: string | undefined, id: string) {
  const response = await fetch(`/api/materials/${encodeURIComponent(id)}`, { headers: scopeHeaders(workspaceScope) })
  return (await readJson<{ material: MaterialDetail }>(response, '검토 자료를 불러오지 못했습니다.')).material
}

/**
 * HTML 파일을 올린다. `materialId`가 있으면 그 자료의 새 판이다.
 * 같은 자료의 이전 판이 이미 있으면 서버가 409(MATERIAL_KEY_EXISTS)와 후보를 돌려준다 — 부르는 쪽이 사람에게 묻는다.
 */
export async function importMaterial(workspaceScope: string | undefined, file: File, { materialId, newMaterial = false, projectId, title }: { materialId?: string; newMaterial?: boolean; projectId?: string; title?: string } = {}) {
  const params = new URLSearchParams()
  if (materialId) params.set('materialId', materialId)
  if (newMaterial) params.set('newMaterial', '1')
  if (projectId) params.set('projectId', projectId)
  if (title) params.set('title', title)
  const response = await fetch(`/api/materials/import${params.size ? `?${params}` : ''}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name), ...scopeHeaders(workspaceScope) },
    body: file,
  })
  return (await readJson<{ material: MaterialDetail }>(response, '자료를 올리지 못했습니다.')).material
}

export async function materialFromDocument(workspaceScope: string | undefined, documentId: string) {
  const response = await fetch(`/api/materials/from-document/${encodeURIComponent(documentId)}`, { method: 'POST', headers: { 'content-type': 'application/json', ...scopeHeaders(workspaceScope) }, body: '{}' })
  return (await readJson<{ material: MaterialDetail; existing?: boolean }>(response, '검토 자료를 만들지 못했습니다.'))
}

export async function fetchMaterialFrame(workspaceScope: string | undefined, id: string, version: number, { native = false } = {}) {
  const response = await fetch(`/api/materials/${encodeURIComponent(id)}/versions/${version}/frame${native ? '?native=1' : ''}`, { headers: scopeHeaders(workspaceScope) })
  if (!response.ok) await readJson(response, '자료를 그리지 못했습니다.')
  return response.text()
}

export async function fetchMaterialAsset(workspaceScope: string | undefined, id: string, version: number, sha: string) {
  const response = await fetch(`/api/materials/${encodeURIComponent(id)}/versions/${version}/assets/${sha}`, { headers: scopeHeaders(workspaceScope) })
  if (!response.ok) throw new MaterialApiError('그림을 불러오지 못했습니다.', 'MATERIAL_ASSET_NOT_FOUND', response.status)
  return { mime: response.headers.get('content-type') || 'application/octet-stream', bytes: await response.arrayBuffer() }
}

export async function fetchMaterialAnchors(workspaceScope: string | undefined, id: string, version: number) {
  const response = await fetch(`/api/materials/${encodeURIComponent(id)}/versions/${version}/anchors`, { headers: scopeHeaders(workspaceScope) })
  return (await readJson<{ version: number; anchors: MaterialAnchor[] }>(response, '항목을 불러오지 못했습니다.')).anchors
}

export async function archiveMaterial(workspaceScope: string | undefined, id: string, restore = false) {
  const response = await fetch(`/api/materials/${encodeURIComponent(id)}/archive`, { method: 'POST', headers: { 'content-type': 'application/json', ...scopeHeaders(workspaceScope) }, body: JSON.stringify({ restore }) })
  return (await readJson<{ material: MaterialDetail }>(response, restore ? '자료를 되살리지 못했습니다.' : '자료를 보관하지 못했습니다.')).material
}

export async function downloadMaterialSource(workspaceScope: string | undefined, documentId: string, fileName: string) {
  const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}/download`, { headers: scopeHeaders(workspaceScope) })
  if (!response.ok) await readJson(response, '원본을 내려받지 못했습니다.')
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const anchor = window.document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

export type Stance = 'agree' | 'amend' | 'oppose' | 'question'
export const STANCE_LABELS: Record<Stance, string> = { agree: '찬성', amend: '수정해서', oppose: '반대', question: '질문' }

export type MaterialComment = {
  id: string
  lineageId: string | null
  version: number
  type: 'comment'
  authorId: string
  authorName: string
  body: string
  question: boolean
  parentId: string | null
  createdAt: string
  editedAt: string | null
  editHistory: Array<{ body: string; until: string }>
  deleted: boolean
}

export type LineageSummary = {
  comments: number
  openQuestions: number
  stances: Record<Stance, number>
  myStance: Stance | null
  lastActivityAt: string | null
}

export type AiSynthesis = {
  summary: string
  positions: Array<{ stance: Stance; points: Array<{ text: string; feedbackIds: string[] }> }>
  questions: Array<{ text: string; feedbackIds: string[] }>
  draftDecision: { status: DecisionStatus; note: string; feedbackIds: string[] } | null
  dropped: number
}
export type AiOutput = { id: string; output: AiSynthesis; model: string; runByName: string; createdAt: string; version: number }
export type FeedbackBundle = { comments: MaterialComment[]; decisions: MaterialDecision[]; aiOutputs: Record<string, AiOutput>; summary: Record<string, LineageSummary>; currentVersion: number }

export async function fetchFeedback(workspaceScope: string | undefined, id: string) {
  const response = await fetch(`/api/materials/${encodeURIComponent(id)}/feedback`, { headers: scopeHeaders(workspaceScope) })
  return readJson<FeedbackBundle>(response, '의견을 불러오지 못했습니다.')
}

export async function postComment(workspaceScope: string | undefined, id: string, input: { lineageId: string | null; body: string; parentId?: string | null; question?: boolean; clientRequestId: string }) {
  const response = await fetch(`/api/materials/${encodeURIComponent(id)}/feedback`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...scopeHeaders(workspaceScope) }, body: JSON.stringify(input),
  })
  return readJson<{ comment: MaterialComment; summary?: Record<string, LineageSummary> }>(response, '의견을 남기지 못했습니다.')
}

export async function setStance(workspaceScope: string | undefined, id: string, lineageId: string, stance: Stance | null) {
  const response = await fetch(`/api/materials/${encodeURIComponent(id)}/stance`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...scopeHeaders(workspaceScope) }, body: JSON.stringify({ lineageId, stance }),
  })
  return readJson<{ stance: Stance | null; summary: Record<string, LineageSummary> }>(response, '내 생각을 남기지 못했습니다.')
}

export async function editComment(workspaceScope: string | undefined, id: string, commentId: string, body: string) {
  const response = await fetch(`/api/materials/${encodeURIComponent(id)}/feedback/${encodeURIComponent(commentId)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', ...scopeHeaders(workspaceScope) }, body: JSON.stringify({ body }),
  })
  return readJson<{ comment: MaterialComment }>(response, '의견을 고치지 못했습니다.')
}

export async function deleteComment(workspaceScope: string | undefined, id: string, commentId: string) {
  const response = await fetch(`/api/materials/${encodeURIComponent(id)}/feedback/${encodeURIComponent(commentId)}`, { method: 'DELETE', headers: scopeHeaders(workspaceScope) })
  return readJson<{ comment: MaterialComment }>(response, '의견을 지우지 못했습니다.')
}

export const DECISION_OPTIONS = ['반영', '수정 후 반영', '보류', '미반영'] as const
export type DecisionStatus = typeof DECISION_OPTIONS[number]
export type MaterialDecision = {
  id: string
  lineageId: string
  version: number
  status: DecisionStatus
  note: string
  decidedById: string
  decidedByName: string
  decidedAt: string
  imported: boolean
}

export async function decideItem(workspaceScope: string | undefined, id: string, lineageId: string, status: DecisionStatus, note: string) {
  const response = await fetch(`/api/materials/${encodeURIComponent(id)}/decision`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...scopeHeaders(workspaceScope) }, body: JSON.stringify({ lineageId, status, note }),
  })
  return readJson<{ decision: MaterialDecision; unchanged?: boolean }>(response, '결정을 남기지 못했습니다.')
}

export async function setDeciders(workspaceScope: string | undefined, id: string, deciderIds: string[]) {
  const response = await fetch(`/api/materials/${encodeURIComponent(id)}/deciders`, {
    method: 'PUT', headers: { 'content-type': 'application/json', ...scopeHeaders(workspaceScope) }, body: JSON.stringify({ deciderIds }),
  })
  return (await readJson<{ material: MaterialDetail }>(response, '결정권자를 바꾸지 못했습니다.')).material
}

export async function requestReview(workspaceScope: string | undefined, id: string, dueAt: string | null) {
  const response = await fetch(`/api/materials/${encodeURIComponent(id)}/request-review`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...scopeHeaders(workspaceScope) }, body: JSON.stringify({ dueAt }),
  })
  return readJson<{ material: MaterialDetail; notified: number }>(response, '검토 요청을 보내지 못했습니다.')
}

export async function importOpinions(workspaceScope: string | undefined, id: string, text: string) {
  const response = await fetch(`/api/materials/${encodeURIComponent(id)}/import-opinions`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...scopeHeaders(workspaceScope) }, body: JSON.stringify({ text }),
  })
  return readJson<{ imported: { stances: number; comments: number; decisions: number }; people: string[]; unmatchedKeys: string[] }>(response, '의견을 가져오지 못했습니다.')
}

export async function fetchDecisionSummary(workspaceScope: string | undefined, id: string) {
  const response = await fetch(`/api/materials/${encodeURIComponent(id)}/decision-summary`, { headers: scopeHeaders(workspaceScope) })
  return readJson<{ markdown: string }>(response, '결정 요약을 만들지 못했습니다.')
}

export async function createDecisionRecord(workspaceScope: string | undefined, id: string) {
  const response = await fetch(`/api/materials/${encodeURIComponent(id)}/decision-record`, { method: 'POST', headers: { 'content-type': 'application/json', ...scopeHeaders(workspaceScope) }, body: '{}' })
  return readJson<{ documentId: string; decidedCount: number; replayed: boolean }>(response, '결정 기록 문서를 만들지 못했습니다.')
}

export async function fetchDirectory(workspaceScope: string | undefined) {
  const response = await fetch('/api/directory', { headers: scopeHeaders(workspaceScope) })
  const body = await readJson<{ members?: Array<{ id: string; name: string; team?: string; active?: boolean }> }>(response, '구성원 목록을 불러오지 못했습니다.')
  return (body.members ?? []).filter((member) => member.active !== false && (member as { kind?: string }).kind !== 'guest' && !member.id.startsWith('SYS-'))
}

export type LinkProposal = { nextId: string; lineageId: string; status: 'uncertain' | 'key-reused'; score: number; nextKey: string; nextTitle: string; previousKey: string; previousTitle: string; before?: string; after?: string }

export async function fetchLinkProposals(workspaceScope: string | undefined, id: string, version: number) {
  const response = await fetch(`/api/materials/${encodeURIComponent(id)}/versions/${version}/links`, { headers: scopeHeaders(workspaceScope) })
  return (await readJson<{ proposals: LinkProposal[] }>(response, '확인할 짝을 불러오지 못했습니다.')).proposals
}

export async function confirmLinks(workspaceScope: string | undefined, id: string, version: number, choices: Array<{ nextId: string; same: boolean }>) {
  const response = await fetch(`/api/materials/${encodeURIComponent(id)}/versions/${version}/links`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...scopeHeaders(workspaceScope) }, body: JSON.stringify({ choices }),
  })
  return readJson<{ joined: number; separate: number; remaining: number; material: MaterialDetail }>(response, '짝 확인을 저장하지 못했습니다.')
}

export type DiffPart = { op: 'equal' | 'insert' | 'delete'; text: string }
export type CompareItem = { lineageId: string; status: 'changed' | 'added' | 'removed'; key: string; title: string; previousTitle?: string; diff?: DiffPart[]; before?: string; after?: string }
export type CompareResult = {
  from: number
  to: number
  summary: { same: number; changed: number; added: number; removed: number }
  items: CompareItem[]
  truncated: boolean
  reflection: { decided: number; reflected: number; unchanged: Array<{ lineageId: string; title: string }> }
}

export async function fetchCompare(workspaceScope: string | undefined, id: string, from: number, to: number) {
  const response = await fetch(`/api/materials/${encodeURIComponent(id)}/compare?from=${from}&to=${to}`, { headers: scopeHeaders(workspaceScope) })
  return readJson<CompareResult>(response, '두 판을 비교하지 못했습니다.')
}

export type Overview = {
  split: Array<{ lineageId: string; key: string; title: string; stances: Record<Stance, number> }>
  openQuestions: Array<{ lineageId: string; key: string; title: string; commentId: string; body: string; authorName: string }>
  silent: Array<{ lineageId: string; key: string; title: string }>
  ready: Array<{ lineageId: string; key: string; title: string; suggestion: DecisionStatus; stances: Record<Stance, number> }>
  aiAvailable: boolean
}

export async function fetchOverview(workspaceScope: string | undefined, id: string) {
  const response = await fetch(`/api/materials/${encodeURIComponent(id)}/overview`, { headers: scopeHeaders(workspaceScope) })
  return readJson<Overview>(response, '회의 준비표를 만들지 못했습니다.')
}

export async function runAiSynthesis(workspaceScope: string | undefined, id: string, lineageId: string) {
  const response = await fetch(`/api/materials/${encodeURIComponent(id)}/ai-synthesis`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...scopeHeaders(workspaceScope) }, body: JSON.stringify({ lineageId }),
  })
  return (await readJson<{ aiOutput: AiOutput }>(response, 'AI 정리를 받지 못했습니다.')).aiOutput
}

export async function decideFromDraft(workspaceScope: string | undefined, id: string, lineageId: string, draft: AiOutput) {
  const decision = draft.output.draftDecision
  if (!decision) throw new MaterialApiError('결정 초안이 없습니다.', 'MATERIAL_AI_NO_DRAFT', 400)
  const response = await fetch(`/api/materials/${encodeURIComponent(id)}/decision`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...scopeHeaders(workspaceScope) }, body: JSON.stringify({ lineageId, status: decision.status, note: decision.note, draftedBy: draft.id }),
  })
  return readJson<{ decision: MaterialDecision }>(response, '결정을 남기지 못했습니다.')
}

export type MaterialTask = { proposalId: string; lineageId: string; title: string; owner: string; status: 'pending' | 'approved' | 'edited' | 'rejected' | 'expired'; workItemId: string | null; workStatus: string | null; createdAt: string }

export async function fetchMaterialTasks(workspaceScope: string | undefined, id: string) {
  const response = await fetch(`/api/materials/${encodeURIComponent(id)}/tasks`, { headers: scopeHeaders(workspaceScope) })
  return readJson<{ tasks: MaterialTask[]; canApprove: boolean }>(response, '업무 제안을 불러오지 못했습니다.')
}

export async function proposeMaterialTask(workspaceScope: string | undefined, id: string, input: { lineageId: string; title: string; ownerId: string; due: string | null; description?: string }) {
  const response = await fetch(`/api/materials/${encodeURIComponent(id)}/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...scopeHeaders(workspaceScope) }, body: JSON.stringify(input),
  })
  return readJson<{ proposalId: string; canApprove: boolean }>(response, '업무 제안을 올리지 못했습니다.')
}

/** 관리자의 [바로 승인] — 새 승인 문이 아니라 승인 큐의 기존 결정 라우트를 부른다. */
export async function approveProposal(workspaceScope: string | undefined, proposalId: string) {
  const response = await fetch(`/api/proposals/${encodeURIComponent(proposalId)}/decide`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...scopeHeaders(workspaceScope) }, body: JSON.stringify({ decision: 'approve' }),
  })
  return readJson<Record<string, unknown>>(response, '승인하지 못했습니다.')
}

export async function fetchNextVersionRequest(workspaceScope: string | undefined, id: string) {
  const response = await fetch(`/api/materials/${encodeURIComponent(id)}/next-version-request`, { headers: scopeHeaders(workspaceScope) })
  return readJson<{ markdown: string; rules: string[] }>(response, '다음 판 요청서를 만들지 못했습니다.')
}

export async function downloadMaterialExport(workspaceScope: string | undefined, id: string, title: string) {
  const response = await fetch(`/api/materials/${encodeURIComponent(id)}/export`, { headers: scopeHeaders(workspaceScope) })
  if (!response.ok) await readJson(response, '기록을 묶지 못했습니다.')
  const url = URL.createObjectURL(await response.blob())
  const anchor = window.document.createElement('a')
  anchor.href = url
  anchor.download = `${title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)} 검토기록.zip`
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

export const newClientRequestId = () => `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

export const formatBytes =(bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`)

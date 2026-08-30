export type LensOutputFormat = 'summary' | 'table' | 'tasks'
export type LensFileKind = 'all' | 'document' | 'image' | 'text'

export type Lens = {
  id: string
  name: string
  description: string
  outputFormat: LensOutputFormat
  fileKinds: LensFileKind[]
  prompt: string
  builtIn: boolean
  enabled: boolean
  createdAt?: string
  updatedAt?: string
  createdBy?: string
}

export type LensEvidence = { quote: string; where: string }
export type LensTask = { title: string; owner: string; due: string; reason: string }
export type LensTableRow = { item: string; detail: string; level: '높음' | '보통' | '낮음' }

export type LensResult =
  | { outputFormat: 'summary'; headline: string; bullets: string[]; decisions: string[]; evidence: LensEvidence[]; insufficient: boolean }
  | { outputFormat: 'table'; rows: LensTableRow[]; evidence: LensEvidence[]; insufficient: boolean }
  | { outputFormat: 'tasks'; tasks: LensTask[]; evidence: LensEvidence[]; insufficient: boolean }

export type LensRun = {
  lens: { id: string; name: string; outputFormat: LensOutputFormat }
  source: { documentId: string; name: string; mime: string }
  result: LensResult
  model?: string
}

/** 렌즈가 읽을 수 있는 원본. server/document-lenses.mjs의 LENS_MIME_TYPES와 같은 목록이다. */
export const LENS_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'text/plain', 'text/csv', 'text/markdown']
export const LENS_FILE_KIND_LABELS: Record<LensFileKind, string> = {
  all: '모든 파일',
  document: 'PDF 문서',
  image: '이미지 · 스캔본',
  text: '텍스트 · CSV',
}
export const LENS_OUTPUT_LABELS: Record<LensOutputFormat, string> = {
  summary: '요약 + 결정 사항',
  table: '표 (항목 · 내용 · 주의도)',
  tasks: '할 일 목록',
}

export function canRunLensOn(mime: string | undefined) {
  return LENS_MIME_TYPES.includes(String(mime ?? '').toLowerCase())
}

function workspaceHeaders(workspaceScope?: string): Record<string, string> {
  return workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}
}

async function readError(response: Response, fallback: string) {
  try { return ((await response.json()) as { error?: { message?: string } }).error?.message || fallback }
  catch { return fallback }
}

export async function fetchLenses(workspaceScope?: string, signal?: AbortSignal) {
  const response = await fetch('/api/lenses', { headers: workspaceHeaders(workspaceScope), signal })
  if (!response.ok) throw new Error(await readError(response, '렌즈 목록을 불러오지 못했습니다.'))
  const body = await response.json() as { lenses?: Lens[]; canManage?: boolean }
  return { lenses: Array.isArray(body.lenses) ? body.lenses : [], canManage: body.canManage === true }
}

export async function saveLenses(lenses: Lens[], workspaceScope?: string) {
  const response = await fetch('/api/lenses', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...workspaceHeaders(workspaceScope) },
    body: JSON.stringify({ lenses }),
  })
  if (!response.ok) throw new Error(await readError(response, '렌즈 설정을 저장하지 못했습니다.'))
  const body = await response.json() as { lenses?: Lens[] }
  return Array.isArray(body.lenses) ? body.lenses : []
}

export async function runLens(documentId: string, lensId: string, workspaceScope?: string, signal?: AbortSignal): Promise<LensRun> {
  const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}/lens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...workspaceHeaders(workspaceScope) },
    body: JSON.stringify({ lensId }),
    signal,
  })
  if (!response.ok) throw new Error(await readError(response, 'AI가 파일을 읽지 못했습니다.'))
  const body = await response.json() as LensRun & { error?: { message?: string } }
  if (body.source?.documentId !== documentId || !body.result) throw new Error('AI 분석 결과의 출처를 확인할 수 없습니다.')
  return body
}

export async function sendLensTasksToQueue(documentId: string, lens: { id: string; name: string }, tasks: LensTask[], workspaceScope?: string) {
  const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}/lens/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...workspaceHeaders(workspaceScope) },
    body: JSON.stringify({ lensId: lens.id, lensName: lens.name, tasks }),
  })
  if (!response.ok) throw new Error(await readError(response, '승인 큐로 보내지 못했습니다.'))
  return await response.json() as { queued: number; skipped: number; pendingCount: number }
}

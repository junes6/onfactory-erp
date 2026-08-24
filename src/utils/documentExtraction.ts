export type ExtractionKind = 'ip-right' | 'compliance'

export type DocumentExtractionBase = {
  confidence: number | null
  warnings: string[]
}

export type IpDocumentDraft = DocumentExtractionBase & {
  kind: '특허' | '실용신안' | '상표' | '디자인' | '저작권' | '인증서' | '등록증' | '기타'
  title: string
  number: string
  holder: string
  issuer: string
  filedAt: string
  registeredAt: string
  expiresAt: string
}

export type ComplianceDocumentDraft = DocumentExtractionBase & {
  category: string
  name: string
  authority: string
  certificateNo: string
  issuedAt: string
  expiresAt: string
}

const IP_KINDS = new Set<IpDocumentDraft['kind']>(['특허', '실용신안', '상표', '디자인', '저작권', '인증서', '등록증', '기타'])
const COMPLIANCE_CATEGORIES = ['HACCP', '품목제조보고', '자가품질검사', '식품표시 검토', '위생교육', '검교정', 'ISO 22000', 'FSSC 22000', '기타 인증']
const EXTRACTABLE_MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp'])

export function canExtractDocumentFile(file: Pick<File, 'type'>) {
  return EXTRACTABLE_MIME_TYPES.has(String(file.type || '').toLowerCase())
}

export function applyBlankFormValues(form: HTMLFormElement, values: Record<string, unknown>) {
  let applied = 0
  for (const [name, rawValue] of Object.entries(values)) {
    if (typeof rawValue !== 'string' || !rawValue) continue
    const control = form.elements.namedItem(name)
    if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement)) continue
    if (control.value.trim()) continue
    control.value = rawValue
    control.dispatchEvent(new Event('input', { bubbles: true }))
    control.dispatchEvent(new Event('change', { bubbles: true }))
    applied += 1
  }
  return applied
}

function plainText(value: unknown, maxLength = 200) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

function isoDate(value: unknown) {
  const candidate = plainText(value, 10)
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(candidate)
  if (!match) return ''
  const [, year, month, day] = match
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  if (parsed.getUTCFullYear() !== Number(year) || parsed.getUTCMonth() !== Number(month) - 1 || parsed.getUTCDate() !== Number(day)) return ''
  if (Number(year) < 1900 || Number(year) > 2200) return ''
  return candidate
}

function confidence(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null
}

function warnings(value: unknown) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((item) => plainText(item, 180)).filter(Boolean))].slice(0, 6)
}

function parseObject(text: string) {
  const source = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  if (!source.startsWith('{') || !source.endsWith('}')) throw new Error('AI가 문서에서 입력값을 찾지 못했습니다.')
  let parsed: unknown
  try { parsed = JSON.parse(source) }
  catch { throw new Error('AI가 반환한 문서 입력 형식을 확인할 수 없습니다. 다시 시도해 주세요.') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('AI 문서 입력 결과가 한 건의 항목이 아닙니다.')
  return parsed as Record<string, unknown>
}

function validDateOrder(values: string[], resultWarnings: string[]) {
  const dates = values.filter(Boolean)
  for (let index = 1; index < dates.length; index += 1) {
    if (dates[index - 1] > dates[index]) {
      resultWarnings.push('문서의 날짜 순서가 맞지 않아 날짜를 자동 입력하지 않았습니다.')
      return false
    }
  }
  return true
}

function normalizeComplianceCategory(value: unknown) {
  const candidate = plainText(value, 40)
  if (!candidate) return '기타 인증'
  if (/HACCP/i.test(candidate)) return 'HACCP'
  if (/FSSC\s*22000/i.test(candidate)) return 'FSSC 22000'
  if (/ISO\s*22000/i.test(candidate)) return 'ISO 22000'
  return COMPLIANCE_CATEGORIES.includes(candidate) ? candidate : '기타 인증'
}

export function parseIpDocumentDraft(text: string): IpDocumentDraft {
  const parsed = parseObject(text)
  const resultWarnings = warnings(parsed.warnings)
  const rawDates = [isoDate(parsed.filedAt), isoDate(parsed.registeredAt), isoDate(parsed.expiresAt)]
  const orderedDates = validDateOrder(rawDates, resultWarnings) ? rawDates : ['', '', '']
  const kind = IP_KINDS.has(plainText(parsed.kind, 20) as IpDocumentDraft['kind'])
    ? plainText(parsed.kind, 20) as IpDocumentDraft['kind']
    : '기타'
  const draft: IpDocumentDraft = {
    kind,
    title: plainText(parsed.title),
    number: plainText(parsed.number, 120),
    holder: plainText(parsed.holder),
    issuer: plainText(parsed.issuer),
    filedAt: orderedDates[0],
    registeredAt: orderedDates[1],
    expiresAt: orderedDates[2],
    confidence: confidence(parsed.confidence),
    warnings: resultWarnings,
  }
  if (!draft.title && !draft.number) throw new Error('문서에서 권리·인증 명칭이나 등록번호를 찾지 못했습니다.')
  return draft
}

export function parseComplianceDocumentDraft(text: string): ComplianceDocumentDraft {
  const parsed = parseObject(text)
  const resultWarnings = warnings(parsed.warnings)
  const rawDates = [isoDate(parsed.issuedAt), isoDate(parsed.expiresAt)]
  const orderedDates = validDateOrder(rawDates, resultWarnings) ? rawDates : ['', '']
  const draft: ComplianceDocumentDraft = {
    category: normalizeComplianceCategory(parsed.category),
    name: plainText(parsed.name),
    authority: plainText(parsed.authority),
    certificateNo: plainText(parsed.certificateNo, 120),
    issuedAt: orderedDates[0],
    expiresAt: orderedDates[1],
    confidence: confidence(parsed.confidence),
    warnings: resultWarnings,
  }
  if (!draft.name && !draft.certificateNo) throw new Error('문서에서 인증 명칭이나 인증번호를 찾지 못했습니다.')
  return draft
}

export async function requestDocumentExtraction(documentId: string, kind: 'ip-right', workspaceScope?: string, signal?: AbortSignal): Promise<IpDocumentDraft>
export async function requestDocumentExtraction(documentId: string, kind: 'compliance', workspaceScope?: string, signal?: AbortSignal): Promise<ComplianceDocumentDraft>
export async function requestDocumentExtraction(documentId: string, kind: ExtractionKind, workspaceScope?: string, signal?: AbortSignal) {
  const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}/extract`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}) },
    body: JSON.stringify({ target: kind }),
    signal,
  })
  let body: { draft?: unknown; sourceDocumentId?: string; requiresReview?: boolean; error?: { message?: string } }
  try { body = await response.json() as typeof body } catch { throw new Error('AI 문서 읽기 응답을 확인할 수 없습니다.') }
  if (!response.ok) throw new Error(body.error?.message || 'AI가 파일을 읽지 못했습니다.')
  if (body.sourceDocumentId !== documentId || body.requiresReview !== true || !body.draft) throw new Error('AI 문서 입력 초안의 출처를 확인할 수 없습니다.')
  const draftText = JSON.stringify(body.draft)
  return kind === 'ip-right' ? parseIpDocumentDraft(draftText) : parseComplianceDocumentDraft(draftText)
}

export type ExtractionKind = 'ip-right' | 'compliance' | 'contract'

export type ExtractionFieldType = 'text' | 'date' | 'amount' | 'enum'
export type ExtractionFieldSpec = {
  name: string
  label: string
  type: ExtractionFieldType
  values?: readonly string[]
  maxLength?: number
}

/** 항목마다 값과 함께 원문 근거를 받는다. 근거 없는 값은 화면에 올리지 않는다. */
export type ExtractedField = { value: string; evidence: string }
export type DocumentDraft = {
  fields: Record<string, ExtractedField>
  confidence: number | null
  warnings: string[]
}

const IP_KINDS = ['특허', '실용신안', '상표', '디자인', '저작권', '인증서', '등록증', '기타'] as const
const COMPLIANCE_CATEGORIES = ['HACCP', '품목제조보고', '자가품질검사', '식품표시 검토', '위생교육', '검교정', 'ISO 22000', 'FSSC 22000', '기타 인증'] as const

/** 확인 화면이 그대로 그리는 항목 정의. server/document-extraction.mjs와 같은 순서·이름을 유지한다. */
export const DOCUMENT_EXTRACTION_FIELDS: Readonly<Record<ExtractionKind, readonly ExtractionFieldSpec[]>> = {
  'ip-right': [
    { name: 'kind', label: '권리 유형', type: 'enum', values: IP_KINDS },
    { name: 'title', label: '명칭', type: 'text', maxLength: 200 },
    { name: 'number', label: '출원 · 등록번호', type: 'text', maxLength: 120 },
    { name: 'holder', label: '권리자', type: 'text', maxLength: 200 },
    { name: 'issuer', label: '발급 · 관할 기관', type: 'text', maxLength: 200 },
    { name: 'filedAt', label: '출원일', type: 'date' },
    { name: 'registeredAt', label: '등록일', type: 'date' },
    { name: 'expiresAt', label: '만료 · 갱신일', type: 'date' },
  ],
  compliance: [
    { name: 'category', label: '인증 분류', type: 'enum', values: COMPLIANCE_CATEGORIES },
    { name: 'name', label: '인증 · 검토 명칭', type: 'text', maxLength: 200 },
    { name: 'authority', label: '발급 · 검토 기관', type: 'text', maxLength: 200 },
    { name: 'certificateNo', label: '인증 · 보고 번호', type: 'text', maxLength: 120 },
    { name: 'issuedAt', label: '발급 · 확인일', type: 'date' },
    { name: 'expiresAt', label: '유효 · 다음 검토일', type: 'date' },
  ],
  contract: [
    { name: 'title', label: '계약명', type: 'text', maxLength: 200 },
    { name: 'client', label: '거래처 (계약 상대방)', type: 'text', maxLength: 200 },
    { name: 'number', label: '계약번호', type: 'text', maxLength: 120 },
    { name: 'startDate', label: '계약 시작일', type: 'date' },
    { name: 'endDate', label: '계약 종료일', type: 'date' },
    { name: 'amount', label: '계약 금액 (원)', type: 'amount' },
  ],
}

const ORDERED_DATES: Readonly<Record<ExtractionKind, readonly string[]>> = {
  'ip-right': ['filedAt', 'registeredAt', 'expiresAt'],
  compliance: ['issuedAt', 'expiresAt'],
  contract: ['startDate', 'endDate'],
}

const REQUIRED_ANY: Readonly<Record<ExtractionKind, { fields: readonly string[]; message: string }>> = {
  'ip-right': { fields: ['title', 'number'], message: '문서에서 권리·인증 명칭이나 등록번호를 찾지 못했습니다.' },
  compliance: { fields: ['name', 'certificateNo'], message: '문서에서 인증 명칭이나 인증번호를 찾지 못했습니다.' },
  contract: { fields: ['title', 'client'], message: '문서에서 계약명이나 거래처를 찾지 못했습니다.' },
}

const EXTRACTABLE_MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const MAX_EVIDENCE_LENGTH = 240

export function canExtractDocumentFile(file: Pick<File, 'type'>) {
  return EXTRACTABLE_MIME_TYPES.has(String(file.type || '').toLowerCase())
}

/**
 * 사람이 확인 화면에서 승인한 값만 폼에 넣는다. 자동 확정이 아니므로 이미 입력된 값도 덮어쓴다.
 */
export function applyApprovedValues(form: HTMLFormElement | null, values: Record<string, string>) {
  if (!form) return 0
  let applied = 0
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== 'string' || !value) continue
    const control = form.elements.namedItem(name)
    if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement)) continue
    control.value = value
    control.dispatchEvent(new Event('input', { bubbles: true }))
    control.dispatchEvent(new Event('change', { bubbles: true }))
    applied += 1
  }
  return applied
}

/** 승인 직전 사용자가 손으로 친 값을 잃지 않도록, 현재 폼 값을 읽어 둔다. */
export function readFormValues(form: HTMLFormElement | null, names: readonly string[]) {
  if (!form) return {}
  const data = new FormData(form)
  const values: Record<string, string> = {}
  for (const name of names) {
    const value = data.get(name)
    if (typeof value === 'string' && value.trim()) values[name] = value
  }
  return values
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

function amountValue(value: unknown) {
  const digits = plainText(value, 40).replace(/[^\d]/g, '')
  if (!digits || digits.length > 15) return ''
  return String(Number(digits))
}

function enumValue(spec: ExtractionFieldSpec, value: unknown) {
  const candidate = plainText(value, 40)
  if (spec.name === 'category') {
    if (/HACCP/i.test(candidate)) return 'HACCP'
    if (/FSSC\s*22000/i.test(candidate)) return 'FSSC 22000'
    if (/ISO\s*22000/i.test(candidate)) return 'ISO 22000'
  }
  return spec.values?.includes(candidate) ? candidate : ''
}

function fieldValue(spec: ExtractionFieldSpec, value: unknown) {
  if (spec.type === 'date') return isoDate(value)
  if (spec.type === 'amount') return amountValue(value)
  if (spec.type === 'enum') return enumValue(spec, value)
  return plainText(value, spec.maxLength ?? 200)
}

function confidenceValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null
}

function warningList(value: unknown) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((item) => plainText(item, 180)).filter(Boolean))].slice(0, 8)
}

/** 서버가 보낸 초안을 화면 규칙으로 한 번 더 검증한다 (서버 응답을 그대로 믿지 않는다). */
export function parseDocumentDraft(payload: unknown, kind: ExtractionKind): DocumentDraft {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('AI 문서 입력 결과가 한 건의 항목이 아닙니다.')
  const source = payload as { fields?: unknown; confidence?: unknown; warnings?: unknown }
  const rawFields = source.fields && typeof source.fields === 'object' && !Array.isArray(source.fields)
    ? source.fields as Record<string, unknown>
    : {}
  const warnings = warningList(source.warnings)
  const fields: Record<string, ExtractedField> = {}
  for (const spec of DOCUMENT_EXTRACTION_FIELDS[kind]) {
    const entry = rawFields[spec.name]
    const raw = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as { value?: unknown; evidence?: unknown } : {}
    const value = fieldValue(spec, raw.value)
    const evidence = plainText(raw.evidence, MAX_EVIDENCE_LENGTH)
    if (!value || !evidence) continue
    fields[spec.name] = { value, evidence }
  }
  const ordered = ORDERED_DATES[kind].map((name) => fields[name]?.value).filter(Boolean)
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index - 1] > ordered[index]) {
      for (const name of ORDERED_DATES[kind]) delete fields[name]
      warnings.push('문서의 날짜 순서가 맞지 않아 날짜를 자동 입력하지 않았습니다.')
      break
    }
  }
  if (!REQUIRED_ANY[kind].fields.some((name) => fields[name]?.value)) throw new Error(REQUIRED_ANY[kind].message)
  return { fields, confidence: confidenceValue(source.confidence), warnings: [...new Set(warnings)].slice(0, 8) }
}

export async function requestDocumentExtraction(documentId: string, kind: ExtractionKind, workspaceScope?: string, signal?: AbortSignal): Promise<DocumentDraft> {
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
  return parseDocumentDraft(body.draft, kind)
}

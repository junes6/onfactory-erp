import { createHash } from 'node:crypto'

import { createStoredZip, safeArchiveSegment } from './stored-zip.mjs'

const TAX_BUCKETS = new Set(['매출', '매입', '급여', '경비', '신고·납부', '기타'])
const MAX_EXPORT_FILES = 100
const MAX_EXPORT_BYTES = 50 * 1024 * 1024

export class TaxEvidenceExportError extends Error {
  constructor(code, message, status = 400, cause) {
    super(message, cause ? { cause } : undefined)
    this.name = 'TaxEvidenceExportError'
    this.code = code
    this.status = status
  }
}

function tagValue(tags, prefix) {
  const value = Array.isArray(tags) ? tags.find((tag) => typeof tag === 'string' && tag.startsWith(prefix)) : null
  return value ? value.slice(prefix.length) : ''
}

function uniqueArchiveName(name, used) {
  if (!used.has(name)) { used.add(name); return name }
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  for (let copy = 2; copy <= 999; copy += 1) {
    const candidate = `${stem} (${copy})${extension}`
    if (!used.has(candidate)) { used.add(candidate); return candidate }
  }
  throw new TaxEvidenceExportError('TAX_EVIDENCE_DUPLICATE_NAMES', '같은 이름의 증빙이 너무 많아 묶음을 만들 수 없습니다.', 409)
}

function safeCsvCell(value) {
  let text = String(value ?? '').replace(/[\r\n]+/g, ' ').trim()
  if (/^[=+\-@]/.test(text)) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}

export async function buildTaxEvidenceArchive({ year, documents, getDocument }) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new TaxEvidenceExportError('INVALID_TAX_YEAR', '증빙 연도는 2000년부터 2100년 사이여야 합니다.')
  }
  if (typeof getDocument !== 'function') throw new TypeError('문서 원본 조회 함수가 필요합니다.')
  const selected = (Array.isArray(documents) ? documents : [])
    .filter((document) => Array.isArray(document?.tags)
      && document.tags.includes('tax-evidence')
      && document.tags.includes(`tax-year:${year}`))
    .filter((document, index, list) => document?.id && list.findIndex((candidate) => candidate?.id === document.id) === index)
    .sort((left, right) => String(left.uploadedAt ?? '').localeCompare(String(right.uploadedAt ?? '')) || String(left.id).localeCompare(String(right.id)))
  if (!selected.length) throw new TaxEvidenceExportError('TAX_EVIDENCE_EMPTY', `${year}년에 보관된 세무 증빙이 없습니다.`, 404)
  if (selected.length > MAX_EXPORT_FILES) throw new TaxEvidenceExportError('TAX_EVIDENCE_TOO_MANY_FILES', `한 번에 ${MAX_EXPORT_FILES}개까지 묶을 수 있습니다.`, 413)

  const usedPaths = new Set()
  const entries = []
  const manifest = [['분류', '파일명', '업로드일시', '업로더', '크기(byte)', 'SHA-256']]
  let totalBytes = 0
  for (const document of selected) {
    let body
    try { body = await getDocument(document) }
    catch (error) { throw new TaxEvidenceExportError('TAX_EVIDENCE_FILE_MISSING', `‘${document.name || '이름 없는 증빙'}’ 원본을 읽지 못해 묶음을 만들지 않았습니다.`, 410, error) }
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '')
    totalBytes += bytes.length
    if (totalBytes > MAX_EXPORT_BYTES) throw new TaxEvidenceExportError('TAX_EVIDENCE_TOO_LARGE', '전달 묶음은 총 50MB까지 만들 수 있습니다.', 413)
    const checksum = createHash('sha256').update(bytes).digest('hex')
    if (document.checksum && document.checksum !== checksum) {
      throw new TaxEvidenceExportError('TAX_EVIDENCE_CHECKSUM_MISMATCH', `‘${document.name || '이름 없는 증빙'}’ 원본 검증에 실패해 묶음을 만들지 않았습니다.`, 409)
    }
    const taggedBucket = tagValue(document.tags, 'tax-bucket:')
    const bucket = TAX_BUCKETS.has(taggedBucket) ? taggedBucket : '기타'
    const fileName = safeArchiveSegment(document.originalName || document.name, '증빙파일')
    const archivePath = uniqueArchiveName(`${safeArchiveSegment(bucket, '기타')}/${fileName}`, usedPaths)
    entries.push({ name: archivePath, body: bytes, modifiedAt: document.uploadedAt })
    manifest.push([bucket, document.name || fileName, document.uploadedAt || '', document.uploadedByName || '', bytes.length, checksum])
  }

  const manifestCsv = Buffer.from(`\uFEFF${manifest.map((row) => row.map(safeCsvCell).join(',')).join('\r\n')}\r\n`, 'utf8')
  entries.push({ name: 'manifest.csv', body: manifestCsv })
  return { archive: createStoredZip(entries), fileCount: selected.length, totalBytes }
}

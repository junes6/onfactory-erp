import { createHash } from 'node:crypto'

import { createStoredZip, safeArchiveSegment } from './stored-zip.mjs'

const TAX_BUCKETS = new Set(['매출', '매입', '급여', '경비', '신고·납부', '기타'])
const MAX_EXPORT_FILES = 200
const MAX_EXPORT_BYTES = 100 * 1024 * 1024
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

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

function seoulDateKey(value) {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return ''
  return new Date(parsed.getTime() + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10)
}

/**
 * 증빙 파일의 귀속일. 업로드할 때 붙인 tax-date 태그가 우선이고, 없으면 연도 태그로 보정한 업로드일을 쓴다.
 * src/utils/taxEvidencePeriod.ts의 evidenceDateOf와 같은 규칙이다.
 */
export function evidenceDate(document) {
  const tags = Array.isArray(document?.tags) ? document.tags : []
  const tagged = tagValue(tags, 'tax-date:')
  if (DATE_PATTERN.test(tagged)) return tagged
  const uploaded = seoulDateKey(document?.uploadedAt) || ''
  const taggedYear = tagValue(tags, 'tax-year:')
  if (/^\d{4}$/.test(taggedYear) && uploaded.slice(0, 4) !== taggedYear) return `${taggedYear}-12-31`
  return uploaded
}

function validDate(value, field) {
  const candidate = String(value ?? '').trim()
  if (!DATE_PATTERN.test(candidate)) throw new TaxEvidenceExportError('INVALID_TAX_PERIOD', `${field}를 YYYY-MM-DD 형식으로 선택해 주세요.`)
  const [year, month, day] = candidate.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (year < 2000 || year > 2100 || parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new TaxEvidenceExportError('INVALID_TAX_PERIOD', `${field}가 실제 달력에 없는 날짜입니다.`)
  }
  return candidate
}

/** year 하나만 주면 그 해 전체를, from/to를 주면 선택한 기간을 쓴다. */
export function resolveEvidencePeriod({ year, from, to }) {
  if (from || to) {
    const start = validDate(from, '시작일')
    const end = validDate(to, '종료일')
    if (start > end) throw new TaxEvidenceExportError('INVALID_TAX_PERIOD', '기간의 시작일이 종료일보다 늦습니다.')
    return { from: start, to: end }
  }
  const numeric = Number(year)
  if (!Number.isInteger(numeric) || numeric < 2000 || numeric > 2100) {
    throw new TaxEvidenceExportError('INVALID_TAX_YEAR', '증빙 연도는 2000년부터 2100년 사이여야 합니다.')
  }
  return { from: `${numeric}-01-01`, to: `${numeric}-12-31` }
}

export function periodLabel({ from, to }) {
  if (from.slice(0, 4) === to.slice(0, 4) && from.endsWith('-01-01') && to.endsWith('-12-31')) return `${from.slice(0, 4)}년 전체`
  return `${from} ~ ${to}`
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

export function selectTaxEvidence(documents, period) {
  return (Array.isArray(documents) ? documents : [])
    .filter((document) => Array.isArray(document?.tags) && document.tags.includes('tax-evidence'))
    .map((document) => ({ document, date: evidenceDate(document) }))
    .filter(({ date }) => date && date >= period.from && date <= period.to)
    .filter(({ document }, index, list) => document?.id && list.findIndex((candidate) => candidate.document?.id === document.id) === index)
    .sort((left, right) => left.date.localeCompare(right.date)
      || String(left.document.uploadedAt ?? '').localeCompare(String(right.document.uploadedAt ?? ''))
      || String(left.document.id).localeCompare(String(right.document.id)))
}

export async function buildTaxEvidenceArchive({ year, from, to, documents, getDocument, label: chosenLabel, preparedAt, preparedBy }) {
  const period = resolveEvidencePeriod({ year, from, to })
  if (typeof getDocument !== 'function') throw new TypeError('문서 원본 조회 함수가 필요합니다.')
  const selected = selectTaxEvidence(documents, period)
  const label = String(chosenLabel ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 60) || periodLabel(period)
  if (!selected.length) throw new TaxEvidenceExportError('TAX_EVIDENCE_EMPTY', `${label} 기간에 보관된 세무 증빙이 없습니다.`, 404)
  if (selected.length > MAX_EXPORT_FILES) throw new TaxEvidenceExportError('TAX_EVIDENCE_TOO_MANY_FILES', `한 번에 ${MAX_EXPORT_FILES}개까지 묶을 수 있습니다. 기간을 나눠 전달해 주세요.`, 413)

  const usedPaths = new Set()
  const entries = []
  const manifest = [['분류', '파일명', '증빙일자', '업로드일시', '업로더', '크기(byte)', 'SHA-256']]
  const bucketCounts = new Map()
  let totalBytes = 0
  for (const { document, date } of selected) {
    let body
    try { body = await getDocument(document) }
    catch (error) { throw new TaxEvidenceExportError('TAX_EVIDENCE_FILE_MISSING', `‘${document.name || '이름 없는 증빙'}’ 원본을 읽지 못해 묶음을 만들지 않았습니다.`, 410, error) }
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '')
    totalBytes += bytes.length
    if (totalBytes > MAX_EXPORT_BYTES) throw new TaxEvidenceExportError('TAX_EVIDENCE_TOO_LARGE', '전달 묶음은 총 100MB까지 만들 수 있습니다. 기간을 나눠 전달해 주세요.', 413)
    const checksum = createHash('sha256').update(bytes).digest('hex')
    if (document.checksum && document.checksum !== checksum) {
      throw new TaxEvidenceExportError('TAX_EVIDENCE_CHECKSUM_MISMATCH', `‘${document.name || '이름 없는 증빙'}’ 원본 검증에 실패해 묶음을 만들지 않았습니다.`, 409)
    }
    const taggedBucket = tagValue(document.tags, 'tax-bucket:')
    const bucket = TAX_BUCKETS.has(taggedBucket) ? taggedBucket : '기타'
    bucketCounts.set(bucket, (bucketCounts.get(bucket) ?? 0) + 1)
    const fileName = safeArchiveSegment(document.originalName || document.name, '증빙파일')
    const archivePath = uniqueArchiveName(`${safeArchiveSegment(bucket, '기타')}/${fileName}`, usedPaths)
    entries.push({ name: archivePath, body: bytes, modifiedAt: document.uploadedAt })
    manifest.push([bucket, document.name || fileName, date, document.uploadedAt || '', document.uploadedByName || '', bytes.length, checksum])
  }

  const manifestCsv = Buffer.from(`\uFEFF${manifest.map((row) => row.map(safeCsvCell).join(',')).join('\r\n')}\r\n`, 'utf8')
  entries.push({ name: 'manifest.csv', body: manifestCsv })
  const summaryLines = [
    '세무사 전달 자료 요약',
    `대상 기간: ${period.from} ~ ${period.to} (${label})`,
    `증빙 건수: ${selected.length}건`,
    `총 용량: ${totalBytes} byte`,
    ...[...bucketCounts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([bucket, count]) => `  · ${bucket}: ${count}건`),
    `묶음 생성: ${String(preparedAt ?? '').trim() || '기록 없음'}`,
    `전달 준비: ${String(preparedBy ?? '').replace(/[\r\n]+/g, ' ').trim() || '기록 없음'}`,
    '',
    '파일별 분류·증빙일자·해시는 manifest.csv를 확인하세요.',
  ]
  entries.push({ name: '전달요약.txt', body: Buffer.from(`\uFEFF${summaryLines.join('\r\n')}\r\n`, 'utf8') })

  const archive = createStoredZip(entries)
  return {
    archive,
    fileCount: selected.length,
    totalBytes,
    period,
    periodLabel: label,
    archiveChecksum: createHash('sha256').update(archive).digest('hex'),
    buckets: Object.fromEntries([...bucketCounts.entries()].sort(([left], [right]) => left.localeCompare(right))),
  }
}

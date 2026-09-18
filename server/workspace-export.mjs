import { createHash } from 'node:crypto'

import { privateConversationOfDocument } from './messenger-privacy.mjs'
import { createZipWriter, safeArchiveSegment } from './stored-zip.mjs'

/**
 * 고객사 전체 내보내기(감사 data-core-13 · DECISIONS G5).
 *
 * 전에는 내보내기가 세무 증빙 묶음 하나뿐이고 나머지는 자료를 한 건씩 내려받는 것만 됐다 — 회사가 떠나거나
 * 백업을 직접 갖고 싶어도 자기 데이터를 통째로 가져갈 길이 없었다.
 * 관리자가 한 번에 받는 ZIP: 영역마다 JSON(원본 그대로)과 표로 읽히는 영역은 CSV(엑셀용), 자료실 원본 파일,
 * 그리고 무엇이 들었는지·무엇을 뺐는지·각 파일의 SHA-256을 적은 manifest.json.
 *
 * **담지 않는 것** — 관리자라도 볼 수 없거나 회사 기록이 아닌 것:
 *   - 1:1 대화와 그 첨부(가입 동의: 1:1 DM은 열람 대상이 아니다)
 *   - 한 사람의 것: AI 대화·내 할 일·알림·알림 설정·푸시 구독·저장한 보기
 *   - 규범 제안(그 사람의 판단 기록)
 *   - 연결 자격·내부 상태: 캘린더 연결(OAuth 토큰), 동기화 연결표, 예약 작업 상태
 *   - 휴지통의 자료
 * 그리고 어느 영역이든 이름에 secret·token·password·credential·apiKey가 든 칸은 값을 가린다.
 */

export const EXPORT_SCHEMA_VERSION = 1
const PERSONAL_KEYS = new Set(['ai-conversations', 'personal-todos', 'notifications', 'notification-settings', 'push-subscriptions', 'saved-views'])
const SYSTEM_KEYS = new Set(['calendar-connections', 'calendar-sync-links', 'scheduler-state', 'scheduler-runs'])
const SECRET_FIELD = /secret|token|password|credential|api[-_]?key|signing/i
const BOM = String.fromCharCode(0xfeff)

export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, SECRET_FIELD.test(key) && entry != null && entry !== '' ? '[가림]' : redactSecrets(entry)]))
}

/** 엑셀이 수식으로 읽지 않게 = + - @ 로 시작하는 칸 앞에 '를 붙인다(CSV 수식 주입). */
function csvCell(value) {
  if (value == null) return ''
  let text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 행이 모두 평평한 객체인 목록만 CSV로. 칸은 처음 나온 순서, 60칸까지. 엑셀이 한글을 읽도록 BOM을 붙인다. */
export function toCsv(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) return null
  const columns = []
  for (const row of rows) for (const key of Object.keys(row)) if (!columns.includes(key) && columns.length < 60) columns.push(key)
  const lines = [columns.map(csvCell).join(','), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(','))]
  return BOM + lines.join('\r\n') + '\r\n'
}

/** 무엇을 담고 무엇을 뺄지. 저장소를 바꾸지 않는다. */
export function planWorkspaceExport(tenantStore) {
  const store = tenantStore && typeof tenantStore === 'object' ? tenantStore : {}
  const conversations = Array.isArray(store['messenger-conversations']?.data) ? store['messenger-conversations'].data : []
  const keys = []
  const skipped = []
  let documents = []
  for (const key of Object.keys(store).sort()) {
    if (PERSONAL_KEYS.has(key)) { skipped.push({ key, reason: '한 사람의 것(회사 기록이 아님)' }); continue }
    if (SYSTEM_KEYS.has(key)) { skipped.push({ key, reason: '연결 자격·내부 상태' }); continue }
    let data = store[key]?.data
    if (data === undefined) continue
    if (key === 'messenger-conversations' && Array.isArray(data)) {
      const direct = data.filter((conversation) => conversation?.type === 'direct').length
      data = data.filter((conversation) => conversation?.type !== 'direct')
      if (direct) skipped.push({ key, reason: `1:1 대화 ${direct}개(가입 동의상 열람 대상이 아님)` })
    }
    if (key === 'ai-proposals' && Array.isArray(data)) data = data.filter((proposal) => proposal?.kind !== 'principle')
    if (key === 'company-documents' && Array.isArray(data)) {
      const before = data.length
      data = data.filter((document) => document && !document.trashedAt && !privateConversationOfDocument(document, conversations))
      documents = data
      if (before !== data.length) skipped.push({ key, reason: `휴지통 자료와 1:1 대화 첨부 ${before - data.length}개` })
    }
    keys.push({ key, data: redactSecrets(data) })
  }
  return { keys, documents, skipped }
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

/**
 * ZIP을 흘려 쓴다. `getDocument(document)`는 원본 바이트를 돌려준다. 원본이 없는 자료는 건너뛰고 manifest에 적는다.
 * @returns {Promise<{ keys: number, files: number, missing: number, bytes: number }>}
 */
export async function streamWorkspaceExport({ write, tenantStore, tenantName, exportedBy, now = new Date(), getDocument }) {
  const zip = createZipWriter(write)
  const at = now.toISOString()
  const plan = planWorkspaceExport(tenantStore)
  await zip.add('README.txt', [
    `${tenantName} 전체 자료 — ${at.slice(0, 10)} 내보냄 (${exportedBy})`,
    '',
    'data/  영역마다 원본 JSON과, 표로 읽히는 영역은 엑셀용 CSV가 함께 들어 있습니다.',
    'files/ 자료실에 올린 원본 파일입니다(분류별 폴더).',
    'manifest.json  들어 있는 것, 뺀 것과 그 까닭, 파일마다 SHA-256 지문.',
    '',
    '뺀 것: 1:1 대화와 그 첨부, 한 사람의 것(AI 대화·내 할 일·알림 등), 판단 기록, 연결 자격, 휴지통의 자료.',
    '비밀번호·토큰 같은 칸은 [가림]으로 바꿨습니다.',
  ].join('\r\n'), at)
  const manifest = { schemaVersion: EXPORT_SCHEMA_VERSION, tenant: tenantName, exportedAt: at, exportedBy, keys: [], files: [], missingFiles: [], skipped: plan.skipped }
  for (const { key, data } of plan.keys) {
    const json = Buffer.from(JSON.stringify(data, null, 2), 'utf8')
    await zip.add(`data/${key}.json`, json, at)
    const csv = toCsv(data)
    if (csv) await zip.add(`data/${key}.csv`, Buffer.from(csv, 'utf8'), at)
    manifest.keys.push({ key, rows: Array.isArray(data) ? data.length : null, file: `data/${key}.json`, sha256: sha256(json), ...(csv ? { csv: `data/${key}.csv` } : {}) })
  }
  const used = new Set()
  for (const document of plan.documents) {
    let bytes
    try { bytes = await getDocument(document) } catch { manifest.missingFiles.push({ id: document.id, name: document.name }); continue }
    const folder = safeArchiveSegment(document.category, '분류없음')
    let path = `files/${folder}/${safeArchiveSegment(`${document.id}_${document.name ?? document.originalName ?? 'file'}`)}`
    while (used.has(path)) path = `${path}_`
    used.add(path)
    const body = Buffer.from(bytes)
    await zip.add(path, body, document.uploadedAt)
    manifest.files.push({ id: document.id, name: document.name, category: document.category ?? '', path, bytes: body.length, sha256: sha256(body) })
  }
  await zip.add('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), at)
  const bytes = await zip.finish()
  return { keys: manifest.keys.length, files: manifest.files.length, missing: manifest.missingFiles.length, bytes }
}

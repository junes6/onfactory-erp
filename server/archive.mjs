import { randomBytes } from 'node:crypto'

import { tenantStorageKey } from './storage/index.mjs'

/**
 * 보관(아카이브) — 지우는 대신 옮긴다.
 *
 * 2026-09-18 감사에서 저장소 곳곳이 상한에 닿으면 **가장 오래된 기록을 말없이 지우고** 있었다:
 * 업무 1,000건(AI 제안 하나를 승인하면 최근 반복 업무가 사라졌다) · 결정된 AI 제안 2,000건(북극성의 원료) ·
 * 운영사 접속 기록 5,000건(고객사에 "모든 기록"이라고 약속한 것) · 휴가 1,000/원장 5,000건 · 프로젝트 글 5,000건 ·
 * 외부 기회 500건 · 운영 조치 5,000건.
 *
 * 이 모듈은 넘친 행을 **파일 저장소(로컬·NAS 또는 S3)의 보관 세그먼트**로 옮긴다. 업무 데이터 저장소(JSON·PG)의
 * 스키마를 건드리지 않으므로 두 모드에서 같게 돈다. 백업은 자료실 원본과 같은 자리를 복사하므로 보관분도 함께 간다.
 *
 * 규칙:
 *   - 옮기기는 "보관 세그먼트를 먼저 쓰고, 성공한 뒤에만 뜨거운 배열에서 뺀다". 쓰다 실패하면 아무것도 빼지 않는다.
 *   - 세그먼트는 한 번 쓰면 바꾸지 않는다(append-only). 꺼내기(복원)는 행을 다시 뜨거운 배열로 돌려놓고,
 *     그 사실을 색인에 적는다(세그먼트는 그대로 두고 "꺼낸 id"만 표시).
 *   - 고객사 경계는 저장 키가 지킨다: archive/<테넌트>/… — 다른 테넌트 id로는 다른 파일이 된다.
 */

export const ARCHIVE_NAMESPACE = 'archive'
/** 세그먼트 하나의 행 수 상한. 너무 크면 한 번 읽을 때 무겁고, 너무 작으면 파일이 많아진다. */
export const ARCHIVE_SEGMENT_ROWS = 500
/** 조회 한 번에 돌려주는 최대 행 수. */
export const ARCHIVE_PAGE_LIMIT = 200

/** 보관 대상 모음의 이름표. 저장 키 이름과 같게 둔다(무엇이 어디서 왔는지 한 이름으로 읽힌다). */
export const ARCHIVE_COLLECTIONS = Object.freeze({
  'work-items': '완료 업무',
  'ai-proposals': '결정된 AI 제안',
  'audit-events': '접속·감사 기록',
  'leave-requests': '휴가 신청',
  'leave-ledger': '휴가 원장',
  'project-posts': '프로젝트 글',
  opportunities: '외부 기회',
  'platform-actions': '운영 조치',
  // P1-3b: 5,000건에 닿은 대화방의 가장 오래된 말(과 그 스레드 답글). 행마다 conversationId가 붙어 있다.
  'messenger-messages': '메신저 옛 대화',
  // P1-10: 대장에서 지운 행(봉투째). 30일 동안 되살릴 수 있다(server/deleted-rows.mjs).
  'deleted-rows': '지운 기록',
})

export class ArchiveError extends Error {
  constructor(code, message, status = 500) {
    super(message)
    this.name = 'ArchiveError'
    this.code = code
    this.status = status
  }
}

const safeCollection = (collection) => {
  if (!Object.prototype.hasOwnProperty.call(ARCHIVE_COLLECTIONS, collection)) {
    throw new ArchiveError('ARCHIVE_COLLECTION_UNKNOWN', `보관할 수 없는 모음입니다: ${collection}`, 400)
  }
  return collection
}

const indexKey = (tenantId, collection) => tenantStorageKey(tenantId, `index-${collection}`, ARCHIVE_NAMESPACE)
const segmentKey = (tenantId, segmentId) => tenantStorageKey(tenantId, segmentId, ARCHIVE_NAMESPACE)

/** 행이 가진 가장 이른·늦은 시각(보관 목록에 기간을 보여 준다). 시각이 없으면 빈 문자열. */
function timeOf(row) {
  const candidates = [row?.createdAt, row?.at, row?.submittedAt, row?.receivedAt, row?.updatedAt, row?.decidedAt, row?.review?.reviewedAt]
  const found = candidates.find((value) => typeof value === 'string' && !Number.isNaN(Date.parse(value)))
  return found ?? ''
}

/**
 * 보관소 하나. `storage`는 자료실과 같은 저장 어댑터(put/get)다.
 * 같은 테넌트·모음의 쓰기는 프로세스 안에서 한 줄로 세운다 — 색인은 읽고-고치고-쓰는 파일이다.
 */
export function createArchive({ storage, clock = () => new Date() }) {
  const queues = new Map()
  const serialize = (key, run) => {
    const previous = queues.get(key) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(run)
    queues.set(key, next.catch(() => undefined))
    return next
  }

  const readJson = async (key, fallback) => {
    try {
      const bytes = await storage.get(key)
      return JSON.parse(Buffer.from(bytes).toString('utf8'))
    } catch (error) {
      if (error?.code === 'STORAGE_NOT_FOUND') return fallback
      throw error
    }
  }
  const writeJson = (key, value) => storage.put(key, Buffer.from(JSON.stringify(value), 'utf8'), { contentType: 'application/json' })

  const readIndex = async (tenantId, collection) => {
    const index = await readJson(indexKey(tenantId, collection), null)
    return index && Array.isArray(index.segments) ? index : { collection, segments: [], restoredIds: [] }
  }

  /**
   * 행을 보관한다. 세그먼트를 쓰고 색인을 고친 뒤에야 성공을 돌려준다 — 부르는 쪽은 **그 다음에** 뜨거운 배열에서 뺀다.
   * @returns {Promise<{ archived: number, segments: string[] }>}
   */
  const append = (tenantId, collection, rows, { reason = '', actor = 'system' } = {}) => {
    safeCollection(collection)
    const list = (Array.isArray(rows) ? rows : []).filter((row) => row && typeof row === 'object')
    if (!list.length) return Promise.resolve({ archived: 0, segments: [] })
    if (!storage) return Promise.reject(new ArchiveError('ARCHIVE_STORAGE_UNAVAILABLE', '보관할 파일 저장소가 설정되지 않았습니다.', 503))
    return serialize(`${tenantId}:${collection}`, async () => {
      const index = await readIndex(tenantId, collection)
      const now = clock().toISOString()
      const written = []
      for (let offset = 0; offset < list.length; offset += ARCHIVE_SEGMENT_ROWS) {
        const chunk = list.slice(offset, offset + ARCHIVE_SEGMENT_ROWS)
        const segmentId = `${collection}-${now.replace(/[^0-9]/g, '').slice(0, 14)}-${randomBytes(4).toString('hex')}`
        await writeJson(segmentKey(tenantId, segmentId), { collection, tenantId, archivedAt: now, reason, actor, rows: chunk })
        const times = chunk.map(timeOf).filter(Boolean).sort()
        index.segments.unshift({
          id: segmentId,
          count: chunk.length,
          archivedAt: now,
          reason,
          actor,
          firstAt: times[0] ?? '',
          lastAt: times.at(-1) ?? '',
          ids: chunk.map((row) => String(row.id ?? '')).filter(Boolean),
        })
        written.push(segmentId)
      }
      await writeJson(indexKey(tenantId, collection), index)
      return { archived: list.length, segments: written }
    })
  }

  /** 보관 요약(목록 머리에 "보관 N건"을 쓴다). 파일을 열지 않고 색인만 읽는다. */
  const summary = async (tenantId, collection) => {
    safeCollection(collection)
    if (!storage) return { collection, label: ARCHIVE_COLLECTIONS[collection], total: 0, segments: 0, restored: 0 }
    const index = await readIndex(tenantId, collection)
    const restored = new Set(index.restoredIds ?? [])
    const total = index.segments.reduce((sum, segment) => sum + segment.ids.filter((id) => !restored.has(id)).length, 0)
    return { collection, label: ARCHIVE_COLLECTIONS[collection], total, segments: index.segments.length, restored: restored.size }
  }

  /**
   * 보관된 행을 새것부터 읽는다. `query`가 있으면 행의 글자 안에서 찾는다(작은 회사 규모라 세그먼트를 훑는다).
   * 꺼낸(복원한) 행은 건너뛴다 — 뜨거운 배열에 이미 돌아가 있다.
   * @returns {Promise<{ rows: object[], total: number, offset: number, limit: number }>}
   */
  const list = async (tenantId, collection, { offset = 0, limit = 50, query = '', filter = null } = {}) => {
    safeCollection(collection)
    if (!storage) return { rows: [], total: 0, offset: 0, limit }
    const safeLimit = Math.max(1, Math.min(ARCHIVE_PAGE_LIMIT, Number(limit) || 50))
    const safeOffset = Math.max(0, Number(offset) || 0)
    const index = await readIndex(tenantId, collection)
    const restored = new Set(index.restoredIds ?? [])
    const needle = String(query ?? '').trim().toLowerCase()
    const matched = []
    for (const segment of index.segments) {
      const body = await readJson(segmentKey(tenantId, segment.id), null)
      for (const row of Array.isArray(body?.rows) ? body.rows : []) {
        if (restored.has(String(row?.id ?? ''))) continue
        if (filter && !filter(row)) continue
        if (needle && !JSON.stringify(row).toLowerCase().includes(needle)) continue
        matched.push({ ...row, archivedAt: segment.archivedAt, archiveReason: segment.reason })
      }
    }
    return { rows: matched.slice(safeOffset, safeOffset + safeLimit), total: matched.length, offset: safeOffset, limit: safeLimit }
  }

  /**
   * 보관된 행 하나를 꺼낸다(복원). 행을 돌려주고 색인에 "꺼냄"을 적는다. 부르는 쪽이 뜨거운 배열에 넣고 커밋한다.
   * 넣기가 실패하면 `undo()`로 "꺼냄" 표시를 되돌린다 — 행이 어디에도 없는 상태를 만들지 않는다.
   */
  const take = (tenantId, collection, id) => {
    safeCollection(collection)
    if (!storage) return Promise.reject(new ArchiveError('ARCHIVE_STORAGE_UNAVAILABLE', '보관할 파일 저장소가 설정되지 않았습니다.', 503))
    return serialize(`${tenantId}:${collection}`, async () => {
      const index = await readIndex(tenantId, collection)
      const restored = new Set(index.restoredIds ?? [])
      if (restored.has(id)) throw new ArchiveError('ARCHIVE_ALREADY_RESTORED', '이미 꺼낸 항목입니다.', 409)
      const segment = index.segments.find((item) => item.ids.includes(id))
      if (!segment) throw new ArchiveError('ARCHIVE_ROW_NOT_FOUND', '보관함에서 찾을 수 없습니다.', 404)
      const body = await readJson(segmentKey(tenantId, segment.id), null)
      const row = (body?.rows ?? []).find((item) => String(item?.id ?? '') === id)
      if (!row) throw new ArchiveError('ARCHIVE_ROW_NOT_FOUND', '보관함에서 찾을 수 없습니다.', 404)
      index.restoredIds = [...restored, id]
      await writeJson(indexKey(tenantId, collection), index)
      const undo = () => serialize(`${tenantId}:${collection}`, async () => {
        const latest = await readIndex(tenantId, collection)
        latest.restoredIds = (latest.restoredIds ?? []).filter((value) => value !== id)
        await writeJson(indexKey(tenantId, collection), latest)
      })
      return { row, undo }
    })
  }

  /**
   * 보관함에 쓴 행을 "없던 것"으로 가린다(꺼냄 표시와 같은 자리). 보관은 됐는데 뜨거운 배열에서 빼는 커밋이
   * 실패했거나, 그 사이 행이 바뀌어 빼지 않은 경우에 쓴다 — 같은 행이 두 곳에 보이지 않게.
   */
  const forget = (tenantId, collection, ids) => {
    safeCollection(collection)
    const list = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))]
    if (!list.length || !storage) return Promise.resolve({ hidden: 0 })
    return serialize(`${tenantId}:${collection}`, async () => {
      const index = await readIndex(tenantId, collection)
      index.restoredIds = [...new Set([...(index.restoredIds ?? []), ...list])]
      await writeJson(indexKey(tenantId, collection), index)
      return { hidden: list.length }
    })
  }

  return { append, summary, list, take, forget, readIndex }
}

/**
 * 뜨거운 배열에서 보관할 행을 고르고 남길 행을 가른다. 순서는 그대로 둔다.
 * `pick(row, index)`가 참인 행 중 `limit`개까지(배열 끝, 곧 오래된 쪽부터)를 옮긴다.
 * @returns {{ keep: object[], move: object[] }}
 */
export function splitForArchive(rows, pick, limit = Infinity) {
  const list = Array.isArray(rows) ? rows : []
  const moveIndexes = new Set()
  for (let index = list.length - 1; index >= 0 && moveIndexes.size < limit; index -= 1) {
    if (pick(list[index], index)) moveIndexes.add(index)
  }
  return {
    keep: list.filter((_, index) => !moveIndexes.has(index)),
    move: list.filter((_, index) => moveIndexes.has(index)),
  }
}

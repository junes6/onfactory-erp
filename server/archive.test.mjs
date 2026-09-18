import assert from 'node:assert/strict'
import test from 'node:test'

import { ARCHIVE_SEGMENT_ROWS, ArchiveError, createArchive, splitForArchive } from './archive.mjs'

function memoryStorage({ failPutAfter = Infinity } = {}) {
  const files = new Map()
  let puts = 0
  return {
    files,
    backend: 'local',
    async put(key, body) {
      puts += 1
      if (puts > failPutAfter) throw new Error('디스크 고장')
      files.set(key, Buffer.from(body))
      return { key, size: body.length }
    },
    async get(key) {
      const value = files.get(key)
      if (!value) { const error = new Error('없음'); error.code = 'STORAGE_NOT_FOUND'; throw error }
      return value
    },
    async delete(key) { return files.delete(key) },
  }
}

const rows = (count, prefix = 'WK') => Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${String(index).padStart(4, '0')}`, title: `업무 ${index}`, createdAt: `2026-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z` }))

test('보관은 세그먼트에 쓰고 색인에 적는다 — 요약·목록·검색이 그 색인으로 읽는다', async () => {
  const storage = memoryStorage()
  const archive = createArchive({ storage, clock: () => new Date('2026-09-18T00:00:00.000Z') })
  const result = await archive.append('TENANT-A', 'work-items', rows(ARCHIVE_SEGMENT_ROWS + 20), { reason: '완료 후 60일' })
  assert.equal(result.archived, ARCHIVE_SEGMENT_ROWS + 20)
  assert.equal(result.segments.length, 2, '세그먼트 상한을 넘으면 나눠 쓴다')
  assert.deepEqual(await archive.summary('TENANT-A', 'work-items'), { collection: 'work-items', label: '완료 업무', total: ARCHIVE_SEGMENT_ROWS + 20, segments: 2, restored: 0 })
  const page = await archive.list('TENANT-A', 'work-items', { limit: 10 })
  assert.equal(page.rows.length, 10)
  assert.equal(page.total, ARCHIVE_SEGMENT_ROWS + 20)
  assert.equal(page.rows[0].archiveReason, '완료 후 60일')
  const found = await archive.list('TENANT-A', 'work-items', { query: '업무 7' })
  assert.ok(found.rows.every((row) => row.title.includes('업무 7')))
  assert.ok(found.total > 0)
})

test('고객사 경계는 저장 키가 지킨다 — 다른 고객사의 보관함은 비어 있다', async () => {
  const storage = memoryStorage()
  const archive = createArchive({ storage })
  await archive.append('TENANT-A', 'work-items', rows(3))
  assert.equal((await archive.summary('TENANT-B', 'work-items')).total, 0)
  assert.equal((await archive.list('TENANT-B', 'work-items')).rows.length, 0)
  assert.ok([...storage.files.keys()].every((key) => key.startsWith('archive/TENANT-A/')))
})

test('꺼내기는 행을 돌려주고 목록에서 뺀다 — 넣기가 실패하면 되돌린다', async () => {
  const archive = createArchive({ storage: memoryStorage() })
  await archive.append('TENANT-A', 'work-items', rows(3))
  const { row, undo } = await archive.take('TENANT-A', 'work-items', 'WK-0001')
  assert.equal(row.id, 'WK-0001')
  assert.equal((await archive.list('TENANT-A', 'work-items')).total, 2)
  await assert.rejects(() => archive.take('TENANT-A', 'work-items', 'WK-0001'), (error) => error instanceof ArchiveError && error.status === 409)
  await undo()
  assert.equal((await archive.list('TENANT-A', 'work-items')).total, 3, '넣기에 실패했으면 다시 보관함에 있다')
  await assert.rejects(() => archive.take('TENANT-A', 'work-items', 'NOPE'), (error) => error.status === 404)
})

test('세그먼트 쓰기가 실패하면 성공을 말하지 않는다 — 부르는 쪽은 뜨거운 배열에서 빼지 않는다', async () => {
  const archive = createArchive({ storage: memoryStorage({ failPutAfter: 0 }) })
  await assert.rejects(() => archive.append('TENANT-A', 'work-items', rows(2)), /디스크 고장/)
})

test('모르는 모음은 받지 않는다', async () => {
  const archive = createArchive({ storage: memoryStorage() })
  assert.throws(() => archive.append('TENANT-A', 'passwords', rows(1)), (error) => error instanceof ArchiveError && error.code === 'ARCHIVE_COLLECTION_UNKNOWN')
})

test('보관할 행 고르기는 배열 끝(오래된 쪽)부터 상한까지만 옮기고 순서를 지킨다', () => {
  const list = [{ id: 'n', done: false }, { id: 'c', done: true }, { id: 'b', done: true }, { id: 'a', done: true }]
  const { keep, move } = splitForArchive(list, (row) => row.done, 2)
  assert.deepEqual(move.map((row) => row.id), ['b', 'a'])
  assert.deepEqual(keep.map((row) => row.id), ['n', 'c'])
})

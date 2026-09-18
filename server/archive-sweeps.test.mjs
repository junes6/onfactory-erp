import assert from 'node:assert/strict'
import test from 'node:test'

import { createArchive } from './archive.mjs'
import {
  HOT_LIMITS,
  PLATFORM_ARCHIVE_TENANT,
  createOverflowSweeper,
  leaveRequestsToArchive,
  opportunitiesToArchive,
  overflowTail,
  proposalsToArchive,
} from './archive-sweeps.mjs'

function memoryStorage() {
  const files = new Map()
  return {
    files,
    async put(key, body) { files.set(key, Buffer.from(body)); return { key, size: body.length } },
    async get(key) {
      const value = files.get(key)
      if (!value) { const error = new Error('없음'); error.code = 'STORAGE_NOT_FOUND'; throw error }
      return value
    },
  }
}

const NOW = new Date('2026-09-18T00:00:00.000Z')

test('넘친 꼬리는 새것이 앞인 배열의 뒤쪽이다', () => {
  assert.deepEqual(overflowTail([1, 2, 3, 4, 5], 3), [4, 5])
  assert.deepEqual(overflowTail([1, 2], 3), [])
})

test('결정된 제안만, 기준일이 지났거나 넘친 오래된 쪽부터 — 대기 중인 제안은 절대 옮기지 않는다', () => {
  const rows = [
    { id: 'P-pending-old', status: 'pending', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'P-new', status: 'approved', decidedAt: '2026-09-10T00:00:00.000Z' },
    { id: 'P-old', status: 'rejected', decidedAt: '2026-05-01T00:00:00.000Z' },
  ]
  assert.deepEqual(proposalsToArchive(rows, { now: NOW }).map((row) => row.id), ['P-old'])
  // 뜨거운 수를 넘기면 결정된 것 중 오래된 쪽(배열 뒤)부터 더 옮긴다.
  assert.deepEqual(proposalsToArchive(rows, { now: NOW, keep: 1 }).map((row) => row.id).sort(), ['P-new', 'P-old'])
})

test('휴가: 결재대기는 두고, 끝난 지 1년 지난 것부터', () => {
  const rows = [
    { id: 'L-wait', status: '결재대기', endDate: '2024-01-01' },
    { id: 'L-recent', status: '승인', endDate: '2026-08-01' },
    { id: 'L-old', status: '승인', endDate: '2025-01-10' },
  ]
  assert.deepEqual(leaveRequestsToArchive(rows, { now: NOW }).map((row) => row.id), ['L-old'])
})

test('외부 기회: 마감이 30일 넘게 지난 것부터', () => {
  const rows = [
    { id: 'O-open', deadline: '2026-10-01' },
    { id: 'O-stale', deadline: '2026-07-01' },
    { id: 'O-none' },
  ]
  assert.deepEqual(opportunitiesToArchive(rows, { now: NOW }).map((row) => row.id), ['O-stale'])
})

test('정리기: 감사 기록은 테넌트별 보관 칸으로 나눠 옮기고, 뜨거운 배열에서는 옮긴 것만 뺀다', async () => {
  const audit = Array.from({ length: HOT_LIMITS.audit + 3 }, (_, index) => ({
    id: `AUD-${index}`, tenantId: index % 2 ? 'TENANT-A' : null, at: '2026-01-01T00:00:00.000Z', event: '운영자 조회',
  }))
  const store = { platform: { auditEvents: audit, actions: [] }, tenants: {} }
  const archive = createArchive({ storage: memoryStorage() })
  let commits = 0
  const sweeper = createOverflowSweeper({ workspaceStore: store, archive, commitWorkspaceStore: async () => { commits += 1 } })
  const summary = await sweeper.run(NOW)
  assert.equal(summary.audit, 3)
  assert.equal(store.platform.auditEvents.length, HOT_LIMITS.audit)
  assert.equal(commits, 1)
  const tenantArchived = await archive.list('TENANT-A', 'audit-events')
  const platformArchived = await archive.list(PLATFORM_ARCHIVE_TENANT, 'audit-events')
  assert.equal(tenantArchived.total + platformArchived.total, 3, '넘친 3건이 빠짐없이 보관됐다')
  // 두 번째는 할 일이 없다.
  assert.equal((await sweeper.run(NOW)).audit, 0)
})

test('정리기: 커밋이 실패하면 뜨거운 배열을 되돌리고 보관분은 가린다 — 두 곳에도 아무 곳에도 없는 상태를 만들지 않는다', async () => {
  const proposals = [
    { id: 'P-1', status: 'approved', decidedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'P-2', status: 'pending', createdAt: '2026-09-01T00:00:00.000Z' },
  ]
  const record = { data: proposals, updatedAt: '', updatedBy: '' }
  const store = { platform: { auditEvents: [], actions: [] }, tenants: { 'TENANT-A': { 'ai-proposals': record } } }
  const archive = createArchive({ storage: memoryStorage() })
  const sweeper = createOverflowSweeper({ workspaceStore: store, archive, commitWorkspaceStore: async () => { throw new Error('디스크 고장') } })
  await assert.rejects(() => sweeper.run(NOW), /디스크 고장/)
  assert.equal(store.tenants['TENANT-A']['ai-proposals'], record, '뜨거운 배열은 그대로')
  assert.equal((await archive.list('TENANT-A', 'ai-proposals')).total, 0, '보관분은 가려졌다')
})

test('정리기: 보관함에 쓰는 사이 바뀐 행은 빼지 않고 보관분에서 가린다 — 앞에 붙은 새 감사 기록도 잃지 않는다', async () => {
  const proposals = [
    { id: 'P-new', status: 'pending', createdAt: '2026-09-17T00:00:00.000Z' },
    { id: 'P-a', status: 'approved', decidedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'P-b', status: 'rejected', decidedAt: '2026-01-02T00:00:00.000Z' },
  ]
  const audit = Array.from({ length: HOT_LIMITS.audit + 2 }, (_, index) => ({ id: `AUD-${index}`, tenantId: 'TENANT-A', event: '운영자 조회' }))
  const store = { platform: { auditEvents: audit, actions: [] }, tenants: { 'TENANT-A': { 'ai-proposals': { data: proposals, updatedAt: '', updatedBy: '' } } } }
  const inner = createArchive({ storage: memoryStorage() })
  // 보관함에 쓰는 동안(await 사이) 다른 요청이 P-a를 고치고, 감사 기록 한 건을 앞에 붙인다.
  const archive = {
    ...inner,
    async append(tenantId, collection, rows, meta) {
      const result = await inner.append(tenantId, collection, rows, meta)
      if (collection === 'ai-proposals') {
        const record = store.tenants['TENANT-A']['ai-proposals']
        store.tenants['TENANT-A']['ai-proposals'] = { ...record, data: record.data.map((row) => (row.id === 'P-a' ? { ...row, note: '고침' } : row)) }
      }
      if (collection === 'audit-events') store.platform.auditEvents = [{ id: 'AUD-LATE', tenantId: 'TENANT-A', event: '운영자 변경' }, ...store.platform.auditEvents]
      return result
    },
  }
  const published = []
  const sweeper = createOverflowSweeper({ workspaceStore: store, archive, commitWorkspaceStore: async () => undefined, publish: (tenantId, key) => published.push(`${tenantId}:${key}`) })
  const summary = await sweeper.run(NOW)
  assert.equal(summary.proposals, 1, 'P-b만 옮겨졌다')
  assert.deepEqual(store.tenants['TENANT-A']['ai-proposals'].data.map((row) => row.id), ['P-new', 'P-a'])
  assert.equal(store.tenants['TENANT-A']['ai-proposals'].data[1].note, '고침', '그 사이의 수정은 살아 있다')
  const archivedProposals = await inner.list('TENANT-A', 'ai-proposals')
  assert.deepEqual(archivedProposals.rows.map((row) => row.id), ['P-b'], 'P-a는 보관함에서 가려졌다')
  assert.equal(store.platform.auditEvents[0].id, 'AUD-LATE', '앞에 붙은 새 감사 기록을 잃지 않았다')
  assert.equal(store.platform.auditEvents.length, HOT_LIMITS.audit + 1)
  assert.deepEqual(published, ['TENANT-A:ai-proposals'])
})

test('정리기 예약: 옮길 것이 없는 넘침에서는 1분에 한 번만 헛돈다', async () => {
  const pending = Array.from({ length: 2_001 }, (_, index) => ({ id: `P-${index}`, status: 'pending', createdAt: '2026-09-01T00:00:00.000Z' }))
  const store = { platform: { auditEvents: [], actions: [] }, tenants: { 'TENANT-A': { 'ai-proposals': { data: pending, updatedAt: '', updatedBy: '' } } } }
  let appends = 0
  const inner = createArchive({ storage: memoryStorage() })
  const archive = { ...inner, async append(...args) { appends += 1; return inner.append(...args) } }
  let clockAt = NOW.getTime()
  const sweeper = createOverflowSweeper({ workspaceStore: store, archive, commitWorkspaceStore: async () => undefined, clock: () => new Date(clockAt) })
  sweeper.schedule()
  sweeper.schedule()
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  sweeper.schedule()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(appends, 0, '대기 중 제안은 옮기지 않는다')
  assert.equal(store.tenants['TENANT-A']['ai-proposals'].data.length, 2_001, '아무것도 지우지 않았다')
  clockAt += 61_000
  sweeper.schedule()
  await new Promise((resolve) => setImmediate(resolve))
})

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_ANY_BLOCK_TEXT, MAX_BLOCK_TEXT, MAX_DOCUMENT_TEXT, MAX_OPS_PER_BATCH, MAX_RECENT_OP_IDS, MAX_TITLE, blockPayload,
} from './wiki-blocks.mjs'
import {
  REJECT_CODES, WIKI_BLOCK_INVALID, WIKI_BLOCK_LIMIT, WIKI_DOCUMENT_TOO_LARGE, WIKI_OPS_INVALID,
  blockWins, mergeOps, resolveAnchor,
} from './wiki-merge.mjs'
import {
  MAX_LOST_TEXT_PER_BATCH, MAX_REVISIONS_PER_DOCUMENT, MAX_REVISION_DETAIL, REVISION_BUDGET_CHARS,
  buildRevision, diffBlocks, diffToOps, pruneRevisions, pruneTenantRevisions, reconstructBlocks, reinstateSource,
  revisionCost, revisionHeaderAt, revisionListItem, revisionSummary,
} from './wiki-revisions.mjs'

/**
 * 병합과 이력의 순수 규칙 — 이 절의 중심이다.
 *
 * 잠그는 다섯 계약:
 *  1. 다른 블록은 절대 부딪히지 않는다 — 도착 순서를 뒤집어도 최종 문서가 같다(6·17).
 *  2. 같은 블록은 한 값으로 모이고 밀린 문장은 이력에 남는다 — 어느 방향이든(7).
 *  3. ops는 낡았다는 이유로 거절하지 않는다 — baseSeq는 충돌 판정 기준선이지 거절 근거가 아니다(6·7).
 *  4. 되돌리기는 이력을 다시 쓰지 않는다 — 새 버전을 만들고 그 사이 버전은 남는다(24).
 *  5. 재전송은 버전을 태우지 않고, 거절됐던 op은 재전송에서도 거절로 남는다(10).
 */

const bid = (suffix) => `BLK-TEST${String(suffix).padStart(4, '0')}`
const opId = (suffix) => `OP-TEST${String(suffix).padStart(4, '0')}`

const A = { actorId: 'USR-A', actorName: '박지현' }
const B = { actorId: 'USR-B', actorName: '오태식' }
const NAMES = { 'USR-A': '박지현', 'USR-B': '오태식' }
const nameOf = (id) => NAMES[id] ?? ''

const at = (minute) => new Date(Date.UTC(2026, 2, 1, 9, minute, 0)).toISOString()

const stamped = (id, text, seq, by = 'USR-A', minute = 0) => ({
  id, type: 'text', text, seq, editedById: by, editedAt: at(minute),
})

const documentOf = (blocks, overrides = {}) => ({
  id: 'WDOC-TEST',
  tenantId: 'TENANT-A',
  title: '운영 문서',
  icon: '',
  parentId: null,
  projectId: null,
  spaceId: null,
  blocks,
  version: 1,
  blockSeq: blocks.reduce((max, block) => Math.max(max, Number(block.seq ?? 0)), 0),
  tombstones: [],
  recentOpIds: [],
  searchText: '',
  aiLevel: 'indexed',
  summary: '',
  summarySource: 'manual',
  writeScope: 'author',
  isTemplate: false,
  templateId: null,
  origin: null,
  createdById: 'USR-A',
  createdByName: '박지현',
  createdAt: at(0),
  lastEditedById: 'USR-A',
  lastEditedByName: '박지현',
  lastEditedAt: at(0),
  archivedAt: null,
  ...overrides,
})

const apply = (document, ops, actor, minute) => mergeOps(document, ops, { ...actor, now: at(minute), nameOf })

/**
 * 변화가 없는 배치의 계약: 버전·블록·검색 색인·역패치는 그대로이고, '적용됨'으로 답한 opId만 멱등 창에 실린다.
 *
 * 문서 참조 동일성으로 재지 않는 이유: 그러면 창 갱신까지 금지하게 되고, C7(재전송 멱등)이 "그 사이 문서가
 * 바뀌지 않았을 때만" 성립한다. 이미 없는 블록의 delete는 '적용됨'으로 답하는데, 복원이 같은 블록 id를
 * 되살린 뒤 오프라인 큐가 그 op을 재전송하면 처음에는 아무 일도 없던 op이 이번에는 진짜로 지운다.
 */
const assertNoVersionBurn = (result, before) => {
  assert.equal(result.error, undefined)
  assert.equal(result.changedCount, 0)
  assert.equal(result.versionBumped, false)
  assert.equal(result.document.version, before.version, '버전을 태웠다')
  assert.equal(result.document.blocks, before.blocks, '블록 배열이 새로 만들어졌다')
  assert.equal(result.document.searchText, before.searchText, '파생 색인을 다시 만들었다')
  assert.deepEqual(result.inverse, [])
  for (const id of result.applied) {
    assert.ok(result.document.recentOpIds.includes(id), `${id}가 멱등 창에 남지 않았다`)
  }
}
const idsOf = (blocks) => blocks.map((block) => block.id)
const textsOf = (blocks) => blocks.map((block) => block.text)

/** 문서를 만든 순간의 리비전. v1은 언제나 스냅샷이라 이력의 출발점이 된다. */
const creationRevision = (document, actor, minute) => buildRevision({
  document,
  result: {
    changed: { inserted: idsOf(document.blocks), updated: [], deleted: [], moved: [] },
    changedCount: document.blocks.length,
    inverse: [],
  },
  actorId: actor.actorId,
  actorName: actor.actorName,
  now: at(minute),
})

// ── 1..5 앵커 ───────────────────────────────────────────────────────────────

test('1. 빈 배치는 문서·버전·역패치를 하나도 건드리지 않는다(참조 동일성)', () => {
  const document = documentOf([stamped(bid(1), '가', 1)])
  const result = apply(document, [], A, 1)
  assert.equal(result.document, document)
  assert.equal(result.document.version, 1)
  assert.equal(result.changedCount, 0)
  assert.deepEqual(result.inverse, [])
  assert.deepEqual(result.applied, [])
})

test('2. insert 앵커: null은 맨 앞, 마지막 블록은 맨 뒤, 모르는 id는 맨 뒤이고 거절하지 않는다', () => {
  const document = documentOf([stamped(bid(1), '가', 1), stamped(bid(2), '나', 2)])
  const insert = (suffix, after, id) => ({ opId: opId(suffix), kind: 'insert', after, block: { id, type: 'text', text: 'X' } })

  assert.deepEqual(idsOf(apply(document, [insert(1, null, bid(9))], A, 1).document.blocks), [bid(9), bid(1), bid(2)])
  assert.deepEqual(idsOf(apply(document, [insert(2, bid(2), bid(9))], A, 1).document.blocks), [bid(1), bid(2), bid(9)])

  const unknown = apply(document, [insert(3, bid(77), bid(9))], A, 1)
  assert.deepEqual(idsOf(unknown.document.blocks), [bid(1), bid(2), bid(9)])
  assert.deepEqual(unknown.rejected, [])
})

test('3. 툼스톤 앵커 — 지워진 문단 뒤에 쓰던 글이 문서 끝으로 순간이동하지 않는다', () => {
  const document = documentOf([stamped(bid(1), 'A', 1), stamped(bid(2), 'B', 2), stamped(bid(3), 'C', 3)])
  const afterDelete = apply(document, [{ opId: opId(1), kind: 'delete', blockId: bid(2) }], B, 1).document
  assert.deepEqual(afterDelete.tombstones, [{ id: bid(2), after: bid(1), at: at(1) }])

  const inserted = apply(afterDelete, [{ opId: opId(2), kind: 'insert', after: bid(2), block: { id: bid(9), type: 'text', text: 'X' } }], A, 2)
  assert.deepEqual(idsOf(inserted.document.blocks), [bid(1), bid(9), bid(3)])
})

test('4. 툼스톤 사슬 — 앞 블록까지 전부 지워졌으면 머리로 되돌아간다', () => {
  const document = documentOf([stamped(bid(1), 'A', 1), stamped(bid(2), 'B', 2), stamped(bid(3), 'C', 3)])
  const result = apply(document, [
    { opId: opId(1), kind: 'delete', blockId: bid(1) },
    { opId: opId(2), kind: 'delete', blockId: bid(2) },
    { opId: opId(3), kind: 'delete', blockId: bid(3) },
    { opId: opId(4), kind: 'insert', after: bid(3), block: { id: bid(9), type: 'text', text: 'X' } },
  ], A, 1)
  assert.deepEqual(idsOf(result.document.blocks), [bid(9)])
})

test('5. 툼스톤이 순환해도 예외 없이 맨 뒤로 떨어진다(무한루프 없음)', () => {
  const blocks = [stamped(bid(1), 'A', 1), stamped(bid(2), 'B', 2)]
  const tombstones = [{ id: bid(50), after: bid(51), at: at(0) }, { id: bid(51), after: bid(50), at: at(0) }]
  assert.equal(resolveAnchor(blocks, tombstones, bid(50)), 1)

  const document = documentOf(blocks, { tombstones })
  const result = apply(document, [{ opId: opId(1), kind: 'insert', after: bid(50), block: { id: bid(9), type: 'text', text: 'X' } }], A, 1)
  assert.deepEqual(idsOf(result.document.blocks), [bid(1), bid(2), bid(9)])
})

// ── 6..9 동시 편집 ──────────────────────────────────────────────────────────

test('6. 다른 블록은 절대 부딪히지 않는다 — 도착 순서를 뒤집어도 최종 문서가 같다', () => {
  const base = documentOf([stamped(bid(1), '가', 1), stamped(bid(2), '나', 2)])
  const opA = { opId: opId(1), kind: 'update', blockId: bid(1), baseSeq: 1, block: { text: '가가' } }
  const opB = { opId: opId(2), kind: 'update', blockId: bid(2), baseSeq: 2, block: { text: '나나' } }

  const run = (first, firstActor, second, secondActor) => {
    const revisions = [creationRevision(base, A, 0)]
    let document = base
    for (const [op, actor, minute] of [[first, firstActor, 1], [second, secondActor, 2]]) {
      const result = mergeOps(document, [op], { ...actor, now: at(minute), nameOf })
      assert.equal(result.error, undefined)
      document = result.document
      revisions.push(buildRevision({ document, result, actorId: actor.actorId, actorName: actor.actorName, now: at(minute) }))
    }
    return { document, revisions }
  }

  const forward = run(opA, A, opB, B)
  const backward = run(opB, B, opA, A)
  assert.deepEqual(textsOf(forward.document.blocks), ['가가', '나나'])
  assert.deepEqual(textsOf(backward.document.blocks), ['가가', '나나'])
  assert.deepEqual(idsOf(forward.document.blocks), idsOf(backward.document.blocks))
  assert.equal(forward.document.version, 3)
  assert.equal(backward.document.version, 3)
  // 리비전은 창작 1 + 배치 2 = 3줄이고, 배치 2줄 어디에도 밀린 글이 없다.
  assert.equal(forward.revisions.length, 3)
  assert.equal(backward.revisions.length, 3)
  for (const revision of [...forward.revisions.slice(1), ...backward.revisions.slice(1)]) {
    assert.deepEqual(revision.overwrites, [])
    assert.deepEqual(revision.lostEdits, [])
  }
})

test('7. 같은 블록은 뒤가 이기고 진 글은 어느 방향이든 이력에 남는다', () => {
  const base = documentOf([stamped(bid(1), '원문', 1)])
  const opA = { opId: opId(1), kind: 'update', blockId: bid(1), baseSeq: 1, block: { text: '박지현 안' } }
  const opB = { opId: opId(2), kind: 'update', blockId: bid(1), baseSeq: 1, block: { text: '오태식 안' } }

  const run = (first, firstActor, second, secondActor) => {
    const revisions = [creationRevision(base, A, 0)]
    let document = base
    for (const [op, actor, minute] of [[first, firstActor, 1], [second, secondActor, 2]]) {
      const result = mergeOps(document, [op], { ...actor, now: at(minute), nameOf })
      document = result.document
      revisions.push(buildRevision({ document, result, actorId: actor.actorId, actorName: actor.actorName, now: at(minute) }))
    }
    return { document, revisions }
  }

  const forward = run(opA, A, opB, B)
  assert.deepEqual(textsOf(forward.document.blocks), ['오태식 안'])
  assert.equal(forward.document.version, 3)
  const forwardLast = forward.revisions.at(-1)
  assert.equal(forwardLast.version, 3)
  assert.equal(forwardLast.overwrites.length, 1)
  assert.equal(forwardLast.overwrites[0].blockId, bid(1))
  assert.equal(forwardLast.overwrites[0].previousText, '박지현 안')
  assert.equal(forwardLast.overwrites[0].previousByName, '박지현')
  assert.equal(forwardLast.overwrites[0].previousSeq, 2)
  assert.equal(JSON.stringify(forward.revisions).includes('박지현 안'), true)

  const backward = run(opB, B, opA, A)
  assert.deepEqual(textsOf(backward.document.blocks), ['박지현 안'])
  assert.equal(backward.revisions.at(-1).overwrites[0].previousText, '오태식 안')
  assert.equal(backward.revisions.at(-1).overwrites[0].previousByName, '오태식')
  assert.equal(JSON.stringify(backward.revisions).includes('오태식 안'), true)

  // 첫 배치는 기준선과 seq가 같으므로 밀어낸 것이 없다 — 경고를 남발하지 않는다.
  assert.deepEqual(forward.revisions[1].overwrites, [])

  // 계약 3: 낡은 baseSeq는 거절 근거가 아니라 충돌 판정 기준선이다 — 사람이 방금 친 글자는 버려지지 않는다.
  const stale = mergeOps(
    mergeOps(base, [opA], { ...A, now: at(1), nameOf }).document,
    [opB], { ...B, now: at(2), nameOf },
  )
  assert.deepEqual(stale.rejected, [])
  assert.deepEqual(stale.applied, [opId(2)])
})

test('8. 삭제가 이긴다 — 되살리지 않고 쓰던 문장을 lostEdits로 남기고, 뒤이은 삽입은 툼스톤을 따라간다', () => {
  const base = documentOf([stamped(bid(1), 'A', 1), stamped(bid(2), 'B', 2), stamped(bid(3), 'C', 3)])
  const afterDelete = apply(base, [{ opId: opId(1), kind: 'delete', blockId: bid(2) }], B, 1).document

  const result = apply(afterDelete, [
    { opId: opId(2), kind: 'update', blockId: bid(2), baseSeq: 2, block: { text: '되살리고 싶은 문장' } },
    { opId: opId(3), kind: 'insert', after: bid(2), block: { id: bid(9), type: 'text', text: 'X' } },
  ], A, 2)

  assert.deepEqual(result.rejected, [{ opId: opId(2), blockId: bid(2), code: REJECT_CODES.BLOCK_DELETED }])
  assert.equal(result.lostEdits.length, 1)
  assert.deepEqual(result.lostEdits[0], { blockId: bid(2), text: '되살리고 싶은 문장', by: 'USR-A', byName: '박지현' })
  assert.deepEqual(idsOf(result.document.blocks), [bid(1), bid(9), bid(3)])
  assert.deepEqual(result.applied, [opId(3)])
})

test('9. 지워진 블록으로의 이동은 거절되고 나머지 배열은 그대로다', () => {
  const base = documentOf([stamped(bid(1), 'A', 1), stamped(bid(2), 'B', 2), stamped(bid(3), 'C', 3)])
  const afterDelete = apply(base, [{ opId: opId(1), kind: 'delete', blockId: bid(2) }], B, 1).document

  const result = apply(afterDelete, [{ opId: opId(2), kind: 'move', blockId: bid(2), after: bid(3) }], A, 2)
  assert.deepEqual(result.rejected, [{ opId: opId(2), blockId: bid(2), code: REJECT_CODES.BLOCK_DELETED }])
  assert.equal(result.changedCount, 0)
  assert.equal(result.document, afterDelete)
  assert.deepEqual(idsOf(result.document.blocks), [bid(1), bid(3)])
})

// ── 10..15 멱등·모양 ────────────────────────────────────────────────────────

test('10. 재전송은 버전을 태우지 않고, 거절됐던 op은 재전송에서도 거절로 남는다', () => {
  const base = documentOf([stamped(bid(1), '가', 1)])
  const batch = [
    { opId: opId(1), kind: 'update', blockId: bid(1), baseSeq: 1, block: { text: '나' } },
    { opId: opId(2), kind: 'update', blockId: bid(2), baseSeq: 1, block: { text: '없는 블록' } },
  ]

  const first = apply(base, batch, A, 1)
  assert.deepEqual(first.applied, [opId(1)])
  assert.equal(first.rejected.length, 1)
  assert.equal(first.document.version, 2)

  const second = apply(first.document, batch, A, 2)
  // D2·D3: 문서·버전·역패치가 전부 그대로이고, 응답은 같은 것을 말한다.
  assert.equal(second.document, first.document)
  assert.equal(second.document.version, 2)
  assert.deepEqual(second.inverse, [])
  assert.equal(second.changedCount, 0)
  assert.deepEqual(second.applied, first.applied)
  assert.deepEqual(second.rejected, first.rejected)
  // 거절된 opId는 recentOpIds에 들어가지 않는다 — 들어가면 다음 재전송이 '적용됨'으로 거짓말한다.
  assert.deepEqual(first.document.recentOpIds, [opId(1)])
})

test('11. 이미 있는 id로 삽입하면 수정으로 강등된다 — 재시도가 블록을 둘로 만들지 않는다', () => {
  const base = documentOf([stamped(bid(1), '가', 1)])
  const result = apply(base, [{ opId: opId(1), kind: 'insert', after: null, block: { id: bid(1), type: 'text', text: '가가' } }], A, 1)
  assert.equal(result.document.blocks.length, 1)
  assert.deepEqual(textsOf(result.document.blocks), ['가가'])
  assert.deepEqual(result.changed.updated, [bid(1)])
  assert.deepEqual(result.changed.inserted, [])

  // 강등된 삽입도 남의 글을 덮어썼으면 overwrites 한 줄을 남긴다 — 그 op을 만든 클라이언트는 이 블록이
  // 있다는 사실 자체를 몰랐으므로 기준선은 0이다. 여기가 꺼지면 "…님이 먼저 고쳤습니다"가 이 갈래에서만
  // 조용히 사라지고, 사람은 자기 글이 남의 글을 밀어낸 것을 끝내 모른다.
  const pushed = apply(base, [{ opId: opId(2), kind: 'insert', after: null, block: { id: bid(1), type: 'text', text: '오태식 안' } }], B, 2)
  assert.equal(pushed.overwrites.length, 1)
  assert.deepEqual(pushed.overwrites[0], {
    blockId: bid(1), previousText: '가', previousBy: 'USR-A', previousByName: '박지현', previousSeq: 1,
  })

  // 대조: 내용이 같은 재시도(C5의 실제 시나리오)는 sameBlockContent에서 빠져나가므로 한 줄도 안 남는다.
  const retry = apply(base, [{ opId: opId(3), kind: 'insert', after: null, block: { id: bid(1), type: 'text', text: '가' } }], B, 2)
  assert.deepEqual(retry.overwrites, [])
  assertNoVersionBurn(retry, base)
})

test('12. 없는 블록의 삭제는 성공이다 — 문서는 그대로고 op은 적용됨으로 답한다', () => {
  const base = documentOf([stamped(bid(1), '가', 1)])
  const result = apply(base, [{ opId: opId(1), kind: 'delete', blockId: bid(7) }], A, 1)
  assert.deepEqual(result.applied, [opId(1)])
  assertNoVersionBurn(result, base)
})

test('13. 마지막 블록을 지우면 빈 문단 하나가 들어선다 — 커서 둘 곳 없는 문서를 만들지 않는다', () => {
  const base = documentOf([stamped(bid(1), '가', 1)])
  const result = apply(base, [{ opId: opId(1), kind: 'delete', blockId: bid(1) }], A, 1)
  assert.equal(result.document.blocks.length, 1)
  assert.equal(result.document.blocks[0].text, '')
  assert.equal(result.document.blocks[0].type, 'text')
  assert.notEqual(result.document.blocks[0].id, bid(1))
  assert.equal(result.changed.inserted.length, 1)
  assert.deepEqual(result.changed.deleted, [bid(1)])
})

test('14. 자기 자신 뒤로의 이동은 거절되고, 이동은 seq를 올리지 않는다', () => {
  const base = documentOf([stamped(bid(1), 'A', 1), stamped(bid(2), 'B', 2)])
  const invalid = apply(base, [{ opId: opId(1), kind: 'move', blockId: bid(1), after: bid(1) }], A, 1)
  assert.deepEqual(invalid.rejected, [{ opId: opId(1), blockId: bid(1), code: REJECT_CODES.INVALID_ANCHOR }])
  assert.equal(invalid.changedCount, 0)

  const moved = apply(base, [{ opId: opId(2), kind: 'move', blockId: bid(1), after: bid(2) }], A, 1)
  assert.deepEqual(idsOf(moved.document.blocks), [bid(2), bid(1)])
  assert.equal(moved.document.blocks[1].seq, 1)
  assert.equal(moved.document.blockSeq, 2)
  assert.deepEqual(moved.changed.moved, [bid(1)])
})

test('15. update에 baseSeq가 없으면 배치 전체가 WIKI_OPS_INVALID다', () => {
  const base = documentOf([stamped(bid(1), '가', 1)])
  assert.equal(apply(base, [{ opId: opId(1), kind: 'update', blockId: bid(1), block: { text: '나' } }], A, 1).error, WIKI_OPS_INVALID)
  assert.equal(apply(base, [{ opId: opId(1), kind: 'update', blockId: bid(1), baseSeq: '1', block: { text: '나' } }], A, 1).error, WIKI_OPS_INVALID)
  assert.equal(apply(base, [{ opId: 'nope', kind: 'update', blockId: bid(1), baseSeq: 1, block: {} }], A, 1).error, WIKI_OPS_INVALID)
  assert.equal(apply(base, [{ opId: opId(1), kind: 'rename', blockId: bid(1) }], A, 1).error, WIKI_OPS_INVALID)
  assert.equal(apply(base, [{ opId: opId(1), kind: 'delete', blockId: '아무거나' }], A, 1).error, WIKI_OPS_INVALID)
})

test('16. blockWins는 전순서다 — seq → editedAt → editedById 세 축이 언제나 한쪽만 고른다', () => {
  const block = (seq, minute, by) => ({ id: bid(1), type: 'text', text: '가', seq, editedAt: at(minute), editedById: by })
  const bySeq = [block(2, 0, 'USR-A'), block(1, 9, 'USR-Z')]
  const byTime = [block(1, 5, 'USR-A'), block(1, 1, 'USR-Z')]
  const byId = [block(1, 1, 'USR-B'), block(1, 1, 'USR-A')]

  for (const [winner, loser] of [bySeq, byTime, byId]) {
    assert.equal(blockWins(winner, loser), true)
    assert.equal(blockWins(loser, winner), false)
  }
  const same = block(1, 1, 'USR-A')
  assert.equal(blockWins(same, same), false)

  // D6: 비교 축 밖의 필드만 다른 쌍에서는 '정확히 한쪽'을 요구하지 않는다 — 둘 다 false일 수 있다.
  const twins = [block(1, 1, 'USR-A'), { ...block(1, 1, 'USR-A'), text: '다른 본문' }]
  assert.equal(blockWins(twins[0], twins[1]) && blockWins(twins[1], twins[0]), false)
  const pool = [block(1, 0, 'USR-A'), block(1, 0, 'USR-B'), block(2, 0, 'USR-A'), block(2, 5, 'USR-B'), block(3, 1, 'USR-C')]
  for (const left of pool) {
    for (const right of pool) {
      assert.equal(blockWins(left, right) && blockWins(right, left), false)
    }
  }
})

// ── 17..20 이력 ─────────────────────────────────────────────────────────────

/** 결정론 난수 — 벽시계도 Math.random도 읽지 않는다. 실패하면 시드로 그대로 재현된다. */
const mulberry32 = (seed) => () => {
  seed = (seed + 0x6D2B79F5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

test('17. 역패치 왕복 — 무작위 30배치를 적용한 뒤 모든 버전이 그때 그 블록으로 정확히 되살아난다', () => {
  for (const seed of [1, 7, 20260907]) {
    const random = mulberry32(seed)
    let counter = 0
    const nextBlockId = () => bid(1000 + (counter += 1))
    const nextOpId = () => opId(1000 + (counter += 1))

    let document = documentOf([stamped(bid(1), 'A', 1), stamped(bid(2), 'B', 2), stamped(bid(3), 'C', 3)])
    const revisions = [creationRevision(document, A, 0)]
    const seen = { 1: document.blocks }

    for (let batch = 0; batch < 29; batch += 1) {
      const actor = random() < 0.5 ? A : B
      const minute = batch + 1
      const current = document.blocks
      // 첫 op은 언제나 '지금 있는 블록의 수정'이라 배치가 반드시 무언가를 바꾼다.
      const ops = [{
        opId: nextOpId(),
        kind: 'update',
        blockId: current[Math.floor(random() * current.length)].id,
        baseSeq: 0,
        block: { text: `수정 ${batch}` },
      }]
      const extra = Math.floor(random() * 4)
      for (let index = 0; index < extra; index += 1) {
        const blocks = document.blocks
        const pick = () => blocks[Math.floor(random() * blocks.length)].id
        const roll = random()
        if (roll < 0.4) ops.push({ opId: nextOpId(), kind: 'insert', after: random() < 0.2 ? null : pick(), block: { id: nextBlockId(), type: 'text', text: `추가 ${batch}-${index}` } })
        else if (roll < 0.6) ops.push({ opId: nextOpId(), kind: 'delete', blockId: pick() })
        else if (roll < 0.8) ops.push({ opId: nextOpId(), kind: 'move', blockId: pick(), after: random() < 0.3 ? null : pick() })
        else ops.push({ opId: nextOpId(), kind: 'update', blockId: pick(), baseSeq: 0, block: { text: `덧칠 ${batch}-${index}` } })
      }

      const result = mergeOps(document, ops, { ...actor, now: at(minute), nameOf, newBlockId: nextBlockId })
      assert.equal(result.error, undefined, `시드 ${seed} 배치 ${batch}에서 ${result.error}`)
      assert.ok(result.changedCount > 0, `시드 ${seed} 배치 ${batch}가 아무것도 바꾸지 않았다`)
      document = result.document
      revisions.push(buildRevision({ document, result, actorId: actor.actorId, actorName: actor.actorName, now: at(minute) }))
      seen[document.version] = document.blocks
    }

    assert.equal(document.version, 30)
    for (let version = 1; version <= 30; version += 1) {
      assert.deepEqual(reconstructBlocks(document, revisions, version), seen[version], `시드 ${seed} 버전 ${version} 복원 불일치`)
    }
    assert.equal(reconstructBlocks(document, revisions, 31), null)
    assert.equal(reconstructBlocks(document, revisions, 0), null)
  }
})

test('18. 스냅샷은 v1·20의 배수·11곳 이상 바뀐 배치에만 있고, 역패치는 모든 리비전에 있다', () => {
  let document = documentOf(Array.from({ length: 12 }, (_, index) => stamped(bid(index + 1), `블록 ${index}`, index + 1)))
  const revisions = [creationRevision(document, A, 0)]

  for (let batch = 0; batch < 39; batch += 1) {
    const result = mergeOps(document, [{ opId: opId(100 + batch), kind: 'update', blockId: bid(1), baseSeq: 1, block: { text: `수정 ${batch}` } }], { ...A, now: at(batch + 1), nameOf })
    document = result.document
    revisions.push(buildRevision({ document, result, actorId: A.actorId, actorName: A.actorName, now: at(batch + 1) }))
  }
  assert.equal(document.version, 40)

  const wide = mergeOps(document, Array.from({ length: 11 }, (_, index) => ({
    opId: opId(200 + index), kind: 'update', blockId: bid(index + 1), baseSeq: 1, block: { text: `한꺼번에 ${index}` },
  })), { ...A, now: at(60), nameOf })
  document = wide.document
  revisions.push(buildRevision({ document, result: wide, actorId: A.actorId, actorName: A.actorName, now: at(60) }))

  const snapshotVersions = revisions.filter((revision) => Array.isArray(revision.snapshot)).map((revision) => revision.version)
  assert.deepEqual(snapshotVersions, [1, 20, 40, 41])
  for (const revision of revisions) {
    assert.equal(Array.isArray(revision.inverse), true, `버전 ${revision.version}에 역패치가 없다`)
    assert.equal(revision.kind, Array.isArray(revision.snapshot) ? 'snapshot' : 'patch')
  }
  assert.equal(revisions.at(-1).changed.updated.length, 11)
  assert.equal(revisions.at(-1).summary, '문단 11개를 고쳤습니다')
})

test('19. 잘라내기는 오래된 쪽부터만 자르고, 목록에 남은 가장 오래된 버전은 반드시 복원된다', () => {
  let document = documentOf([stamped(bid(1), '가', 1)])
  const revisions = [creationRevision(document, A, 0)]
  for (let batch = 0; batch < 249; batch += 1) {
    const result = mergeOps(document, [{ opId: opId(1000 + batch), kind: 'update', blockId: bid(1), baseSeq: 1, block: { text: `수정 ${batch}` } }], { ...A, now: at(batch + 1), nameOf })
    document = result.document
    revisions.push(buildRevision({ document, result, actorId: A.actorId, actorName: A.actorName, now: at(batch + 1) }))
  }
  assert.equal(revisions.length, 250)
  assert.equal(document.version, 250)

  const kept = pruneRevisions(revisions)
  assert.equal(kept.length, MAX_REVISIONS_PER_DOCUMENT)
  assert.equal(kept[0].version, 51)
  assert.equal(kept.at(-1).version, 250)
  assert.ok(reconstructBlocks(document, kept, 51))
  // 버전 2가 첫 배치(`수정 0`)이므로 버전 51은 `수정 49`다.
  assert.equal(reconstructBlocks(document, kept, 51)[0].text, '수정 49')
  assert.equal(reconstructBlocks(document, kept, 50), null)
})

test('20. 예산 잘라내기 — 개수 상한에 닿기 전에 문자 예산에서 먼저 잘리고, 남은 버전은 전부 복원된다', () => {
  const long = (marker) => marker.repeat(4_000).slice(0, 4_000)
  let document = documentOf(Array.from({ length: 11 }, (_, index) => stamped(bid(index + 1), long(`${index}`), index + 1)))
  const revisions = [creationRevision(document, A, 0)]

  for (let batch = 0; batch < 30; batch += 1) {
    const ops = Array.from({ length: 11 }, (_, index) => ({
      opId: opId(2000 + batch * 20 + index), kind: 'update', blockId: bid(index + 1), baseSeq: 1, block: { text: long(`${batch}${index}`) },
    }))
    const result = mergeOps(document, ops, { ...A, now: at(batch + 1), nameOf })
    assert.equal(result.error, undefined)
    document = result.document
    revisions.push(buildRevision({ document, result, actorId: A.actorId, actorName: A.actorName, now: at(batch + 1) }))
  }

  const kept = pruneRevisions(revisions)
  assert.ok(kept.length < MAX_REVISIONS_PER_DOCUMENT, '개수 상한이 아니라 예산에서 잘려야 한다')
  assert.ok(kept.length > 1)
  assert.ok(kept.reduce((sum, revision) => sum + revisionCost(revision), 0) <= REVISION_BUDGET_CHARS)
  for (let version = kept[0].version; version <= document.version; version += 1) {
    assert.ok(reconstructBlocks(document, kept, version), `버전 ${version}이 목록에 있는데 복원되지 않는다`)
  }
  assert.equal(reconstructBlocks(document, kept, kept[0].version - 1), null)
})

// ── 21..23 무변형·상한·diff ─────────────────────────────────────────────────

test('21. mergeOps는 입력 배열을 변형하지 않는다', () => {
  const blocks = [stamped(bid(1), '가', 1), stamped(bid(2), '나', 2)]
  const document = documentOf(blocks)
  const ops = [
    { opId: opId(1), kind: 'update', blockId: bid(1), baseSeq: 1, block: { text: '가가' } },
    { opId: opId(2), kind: 'delete', blockId: bid(2) },
    { opId: opId(3), kind: 'insert', after: bid(1), block: { id: bid(9), type: 'text', text: 'X' } },
  ]
  const opsBefore = JSON.stringify(ops)
  const blocksBefore = JSON.stringify(blocks)

  const result = mergeOps(document, ops, { ...A, now: at(1), nameOf })
  assert.equal(result.error, undefined)
  assert.equal(document.blocks, blocks)
  assert.equal(JSON.stringify(ops), opsBefore)
  assert.equal(JSON.stringify(blocks), blocksBefore)
  assert.deepEqual(document.tombstones, [])
  assert.deepEqual(document.recentOpIds, [])
  assert.equal(document.version, 1)
})

test('22. 블록 상한을 넘기면 배치 전체가 거절되고 반쪽 적용이 남지 않는다', () => {
  const blocks = Array.from({ length: 500 }, (_, index) => stamped(bid(index + 1), `블록 ${index}`, index + 1))
  const document = documentOf(blocks)
  const ops = [
    { opId: opId(1), kind: 'update', blockId: bid(1), baseSeq: 1, block: { text: '먼저 통과할 수정' } },
    { opId: opId(2), kind: 'insert', after: null, block: { id: bid(900), type: 'text', text: '한 칸 넘긴다' } },
  ]
  const opsBefore = JSON.stringify(ops)
  const blocksBefore = JSON.stringify(blocks)

  const result = mergeOps(document, ops, { ...A, now: at(1), nameOf })
  assert.equal(result.error, WIKI_BLOCK_LIMIT)
  assert.equal(result.document, undefined)
  assert.equal(document.blocks.length, 500)
  assert.equal(document.blocks[0].text, '블록 0')
  assert.equal(JSON.stringify(ops), opsBefore)
  assert.equal(JSON.stringify(blocks), blocksBefore)
})

test('23. diffBlocks는 추가·삭제·수정·이동을 나누고, 순서만 바뀐 블록은 수정이 아니다', () => {
  const before = [stamped(bid(1), 'A', 1), stamped(bid(2), 'B', 2), stamped(bid(3), 'C', 3)]
  assert.deepEqual(diffBlocks(before, before), { added: [], removed: [], changed: [], moved: [] })

  const after = [
    stamped(bid(3), 'C', 3),
    stamped(bid(1), 'A 고침', 4),
    { id: bid(9), type: 'heading', text: '새 제목', level: 2, seq: 5, editedById: 'USR-A', editedAt: at(1) },
  ]
  const diff = diffBlocks(before, after)
  assert.deepEqual(diff.added, [{ id: bid(9), type: 'heading', preview: '새 제목' }])
  assert.deepEqual(diff.removed, [{ id: bid(2), type: 'text', preview: 'B' }])
  assert.deepEqual(diff.changed, [{ id: bid(1), type: 'text', beforePreview: 'A', afterPreview: 'A 고침' }])
  // 최장 공통 부분수열이 '제자리'를 고른다 — [A,C]가 [C,A]가 되면 옮긴 것은 둘 중 하나뿐이고,
  // 어느 쪽을 고르든 최소 집합이다. 결정론적으로 앞쪽(A)을 고른다는 사실을 여기서 고정한다.
  assert.deepEqual(diff.moved, [bid(1)])

  // 순서만 바뀌면 changed는 비고 moved만 찬다.
  const reordered = [stamped(bid(2), 'B', 2), stamped(bid(1), 'A', 1), stamped(bid(3), 'C', 3)]
  const orderOnly = diffBlocks(before, reordered)
  assert.deepEqual(orderOnly.changed, [])
  assert.deepEqual(orderOnly.added, [])
  assert.deepEqual(orderOnly.removed, [])
  assert.equal(orderOnly.moved.length, 1)

  // diff의 미리보기도 렌더 시점 인가를 통과한다.
  const linked = [{ ...stamped(bid(1), '[[task:WK-1|비밀 업무]]', 4) }]
  assert.equal(diffBlocks(before.slice(0, 1), linked, () => 'hidden').changed[0].afterPreview.includes('비밀 업무'), false)
})

// ── 24..26 복원·문장 되살리기 ───────────────────────────────────────────────

test('24. 복원은 이력을 다시 쓰지 않는다 — 새 버전을 만들고 그 사이 버전은 목록에 남는다', () => {
  let document = documentOf([stamped(bid(1), '처음', 1), stamped(bid(2), '둘째', 2)])
  const revisions = [creationRevision(document, A, 0)]
  const push = (result, minute, extra = {}) => {
    document = result.document
    revisions.push(buildRevision({ document, result, actorId: A.actorId, actorName: A.actorName, now: at(minute), ...extra }))
  }
  push(mergeOps(document, [{ opId: opId(1), kind: 'update', blockId: bid(1), baseSeq: 1, block: { text: '고침' } }], { ...A, now: at(1), nameOf }), 1)
  push(mergeOps(document, [{ opId: opId(2), kind: 'delete', blockId: bid(2) }], { ...A, now: at(2), nameOf }), 2)
  assert.equal(document.version, 3)

  const target = reconstructBlocks(document, revisions, 1)
  assert.deepEqual(textsOf(target), ['처음', '둘째'])

  let opCounter = 0
  const ops = diffToOps(document.blocks, target, { newOpId: () => opId(500 + (opCounter += 1)) })
  const restored = mergeOps(document, ops, { ...A, now: at(3), nameOf })
  assert.equal(restored.error, undefined)
  assert.deepEqual(textsOf(restored.document.blocks), ['처음', '둘째'])
  assert.deepEqual(idsOf(restored.document.blocks), [bid(1), bid(2)])
  // 되살린 블록의 seq는 복원 전 문서의 모든 seq보다 크다 — 진행 중인 편집이 복원을 즉시 되돌리지 못한다.
  for (const block of restored.document.blocks) assert.ok(block.seq > document.blockSeq)

  push(restored, 3, { restoredFrom: 1 })
  assert.equal(document.version, 4)
  assert.deepEqual(revisions.map((revision) => revision.version), [1, 2, 3, 4])
  assert.equal(revisions.at(-1).summary, '버전 1으로 되돌렸습니다')
  assert.equal(revisions.at(-1).restoredFrom, 1)
  assert.equal(Array.isArray(revisions.at(-1).snapshot), true)
  // 되돌린 뒤에도 그 사이 버전이 그대로 되살아난다 — 이력을 다시 쓰지 않았다는 증거다.
  assert.deepEqual(textsOf(reconstructBlocks(document, revisions, 3)), ['고침'])
  assert.deepEqual(textsOf(reconstructBlocks(document, revisions, 2)), ['고침', '둘째'])
})

test('25. diffToOps는 타입이 규격을 넘어 달라진 블록을 지우고 다시 넣는다', () => {
  const current = [stamped(bid(1), '문단', 1)]
  const target = [{ id: bid(1), type: 'table', rows: [['가', '나']], seq: 9, editedById: 'USR-A', editedAt: at(0) }]
  let counter = 0
  const ops = diffToOps(current, target, { newOpId: () => opId(600 + (counter += 1)) })
  assert.deepEqual(ops.map((op) => op.kind), ['delete', 'insert', 'move'])

  const document = documentOf(current)
  const result = mergeOps(document, ops, { ...A, now: at(1), nameOf })
  assert.equal(result.error, undefined)
  assert.equal(result.document.blocks.length, 1)
  assert.equal(result.document.blocks[0].type, 'table')
  assert.deepEqual(result.document.blocks[0].rows, [['가', '나']])
  // 되돌린 ops는 순수 병합기를 그대로 통과한다 — 복원만 통과하는 우회 검증이 없다.
  assert.deepEqual(blockPayload(result.document.blocks[0]), { type: 'table', rows: [['가', '나']] })
})

test('26. 문장 하나만 되살리기 — 밀린 텍스트를 overwrites → lostEdits → 역패치 순으로 찾는다', () => {
  const base = documentOf([stamped(bid(1), '원문', 1)])
  const first = mergeOps(base, [{ opId: opId(1), kind: 'update', blockId: bid(1), baseSeq: 1, block: { text: '박지현 안' } }], { ...A, now: at(1), nameOf })
  const second = mergeOps(first.document, [{ opId: opId(2), kind: 'update', blockId: bid(1), baseSeq: 1, block: { text: '오태식 안' } }], { ...B, now: at(2), nameOf })
  const revision = buildRevision({ document: second.document, result: second, actorId: B.actorId, actorName: B.actorName, now: at(2) })

  assert.deepEqual(reinstateSource(revision, bid(1)), { text: '박지현 안', from: 'overwrites', block: null })
  assert.equal(reinstateSource(revision, bid(7)), null)

  // 삭제된 블록에 대한 수정은 lostEdits에서 나온다.
  const afterDelete = mergeOps(second.document, [{ opId: opId(3), kind: 'delete', blockId: bid(1) }], { ...A, now: at(3), nameOf }).document
  const lost = mergeOps(afterDelete, [
    { opId: opId(4), kind: 'update', blockId: bid(1), baseSeq: 1, block: { text: '지워진 뒤에 쓴 문장' } },
    { opId: opId(5), kind: 'insert', after: null, block: { id: bid(8), type: 'text', text: '무언가' } },
  ], { ...B, now: at(4), nameOf })
  const lostRevision = buildRevision({ document: lost.document, result: lost, actorId: B.actorId, actorName: B.actorName, now: at(4) })
  assert.deepEqual(reinstateSource(lostRevision, bid(1)), { text: '지워진 뒤에 쓴 문장', from: 'lostEdits', block: null })

  // 어느 쪽도 없으면 역패치의 이전 블록 전체에서 찾는다.
  const plain = mergeOps(second.document, [{ opId: opId(6), kind: 'update', blockId: bid(1), baseSeq: 3, block: { text: '조용한 수정' } }], { ...A, now: at(5), nameOf })
  const plainRevision = buildRevision({ document: plain.document, result: plain, actorId: A.actorId, actorName: A.actorName, now: at(5) })
  assert.deepEqual(plainRevision.overwrites, [])
  assert.equal(reinstateSource(plainRevision, bid(1)).text, '오태식 안')
  assert.equal(reinstateSource(plainRevision, bid(1)).from, 'inverse')
})

test('27. 무작위 순열 — 다른 블록을 건드리는 배치는 도착 순서가 어떻든 같은 문서로 모인다(계약 1)', () => {
  const base = documentOf(Array.from({ length: 6 }, (_, index) => stamped(bid(index + 1), `블록 ${index}`, index + 1)))
  // 여섯 배치가 서로 다른 블록을 건드리고, 삽입 앵커도 서로 다르며 지워지지 않는 블록이다.
  const batches = [
    [{ opId: opId(1), kind: 'update', blockId: bid(1), baseSeq: 1, block: { text: '첫 문단 고침' } }],
    [{ opId: opId(2), kind: 'update', blockId: bid(2), baseSeq: 2, block: { type: 'todo', text: '할 일', checked: true } }],
    [{ opId: opId(3), kind: 'delete', blockId: bid(3) }],
    [{ opId: opId(4), kind: 'insert', after: bid(4), block: { id: bid(20), type: 'text', text: '새 문단' } }],
    [{ opId: opId(5), kind: 'insert', after: bid(5), block: { id: bid(21), type: 'bulleted', text: '항목', indent: 1 } }],
    [{ opId: opId(6), kind: 'update', blockId: bid(6), baseSeq: 6, block: { type: 'heading', text: '마지막 제목', level: 3 } }],
  ]
  const shape = (document) => document.blocks.map((block) => JSON.stringify({ id: block.id, ...blockPayload(block) }))

  const random = mulberry32(4242)
  let expected = null
  let expectedSearchText = null
  const orders = new Set()

  for (let trial = 0; trial < 40; trial += 1) {
    const order = [...batches]
    for (let index = order.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(random() * (index + 1))
      const held = order[index]
      order[index] = order[swap]
      order[swap] = held
    }
    orders.add(order.map((ops) => ops[0].opId).join('>'))

    let document = base
    let overwriteCount = 0
    let rejectedCount = 0
    order.forEach((ops, index) => {
      const result = mergeOps(document, ops, { ...(index % 2 ? A : B), now: at(index + 1), nameOf })
      assert.equal(result.error, undefined)
      overwriteCount += result.overwrites.length
      rejectedCount += result.rejected.length
      document = result.document
    })

    assert.equal(overwriteCount, 0, '다른 블록끼리는 밀어내는 일이 없어야 한다')
    assert.equal(rejectedCount, 0, '낡았다는 이유로 거절하지 않는다')
    assert.equal(document.version, 1 + batches.length)

    const current = shape(document)
    if (expected === null) { expected = current; expectedSearchText = document.searchText } else {
      assert.deepEqual(current, expected, `순열 ${trial}에서 최종 문서가 달라졌다`)
      assert.equal(document.searchText, expectedSearchText, `순열 ${trial}에서 파생 색인이 달라졌다`)
    }
  }
  assert.ok(orders.size >= 20, `순열이 충분히 섞이지 않았다(${orders.size}종)`)
  assert.deepEqual(JSON.parse(expected[2]), { id: bid(4), type: 'text', text: '블록 3' })
  assert.equal(expected.length, 7)
})

test('28. 리비전 한 줄 요약은 한 곳에서만 계산된다 — 메타 변경도 사람이 읽는 문장을 남긴다', () => {
  const none = { inserted: [], updated: [], deleted: [], moved: [] }
  assert.equal(revisionSummary({ changed: { ...none, updated: ['a', 'b'] } }), '문단 2개를 고쳤습니다')
  assert.equal(revisionSummary({ changed: { ...none, inserted: ['a'] } }), '문단 1개를 추가했습니다')
  assert.equal(revisionSummary({ changed: { ...none, deleted: ['a'] } }), '문단 1개를 지웠습니다')
  assert.equal(revisionSummary({ changed: { ...none, moved: ['a'] } }), '문단 1개를 옮겼습니다')
  assert.equal(revisionSummary({ changed: { ...none, inserted: ['a'], deleted: ['b'] } }), '문단 2곳을 바꿨습니다')
  assert.equal(revisionSummary({ changed: none, restoredFrom: 7 }), '버전 7으로 되돌렸습니다')

  assert.equal(revisionSummary({ changed: none, meta: { field: 'title', before: '가', after: '나' } }), '제목을 「나」로 바꿨습니다')
  assert.equal(revisionSummary({ changed: none, meta: { field: 'aiLevel', before: 'active', after: 'indexed' } }), 'AI 처리 수준을 정리로 바꿨습니다')
  assert.equal(revisionSummary({ changed: none, meta: { field: 'archivedAt', before: null, after: at(0) } }), '보관함으로 옮겼습니다')
  assert.equal(revisionSummary({ changed: none, meta: { field: 'archivedAt', before: at(0), after: null } }), '보관함에서 꺼냈습니다')
  assert.equal(revisionSummary({ changed: none, meta: { field: 'writeScope', before: 'author', after: 'tenant' } }), '편집 범위를 회사 전체로 바꿨습니다')
  assert.ok(revisionSummary({ changed: none, meta: { field: 'title', before: '', after: '가'.repeat(300) } }).length <= 120)

  // 목록 응답에는 본문도 역패치도 싣지 않는다 — 200줄이면 응답이 메가바이트가 된다.
  const base = documentOf([stamped(bid(1), '가', 1)])
  const result = mergeOps(base, [{ opId: opId(1), kind: 'update', blockId: bid(1), baseSeq: 1, block: { text: '나' } }], { ...A, now: at(1), nameOf })
  const revision = buildRevision({ document: result.document, result, actorId: A.actorId, actorName: A.actorName, now: at(1) })
  const item = revisionListItem(revision)
  assert.deepEqual(Object.keys(item).sort(), ['at', 'byId', 'byName', 'changed', 'hasLost', 'hasSnapshot', 'id', 'overwriteCount', 'restoredFrom', 'summary', 'version'])
  assert.equal(JSON.stringify(item).includes('inverse'), false)
  assert.equal(revision.id, 'WREV-TEST-2')
  assert.deepEqual(revisionHeaderAt([revision], 2), { title: '운영 문서', icon: '' })
  assert.equal(revisionHeaderAt([revision], 3), null)
})

test('29. 테넌트 이력 정리는 문서마다 최신 한 줄을 반드시 남긴다 — 출발점까지 지우지 않는다', () => {
  const row = (documentId, version, dayOffset) => ({
    id: `WREV-${documentId}-${version}`,
    documentId,
    version,
    at: new Date(Date.UTC(2026, 2, 1) + dayOffset * 24 * 60 * 60 * 1000).toISOString(),
    inverse: [],
    snapshot: null,
    overwrites: [],
    lostEdits: [],
  })
  // 보관 기준선(365일)이 D1-1·D1-2·D2-1보다 뒤에 오도록 시계를 주입한다.
  const now = new Date(Date.UTC(2027, 5, 1)).toISOString()
  const rows = [row('D1', 1, 0), row('D1', 2, 1), row('D1', 3, 360), row('D2', 1, 0)]

  const aged = pruneTenantRevisions(rows, { now })
  assert.deepEqual(aged.kept.map((entry) => entry.id), ['WREV-D1-3', 'WREV-D2-1'])
  assert.equal(aged.removed, 2)

  // 상한을 넘겨도 문서별 최신 줄은 살아남는다.
  const capped = pruneTenantRevisions(rows, { now: rows[0].at, maxRows: 2 })
  assert.equal(capped.kept.length, 2)
  assert.deepEqual(capped.kept.map((entry) => entry.id).sort(), ['WREV-D1-3', 'WREV-D2-1'])
})

// ── 30..35 검증 회차에서 잡힌 것 ────────────────────────────────────────────

test('30. 재전송은 멱등 창을 갉아먹지 않는다 — 200칸이 같은 opId로 채워지지 않는다', () => {
  const base = documentOf([stamped(bid(1), '원문', 1)])
  const queue = Array.from({ length: 50 }, (_, index) => ({
    opId: opId(index + 1), kind: 'update', blockId: bid(1), baseSeq: 1, block: { text: `문장 ${index}` },
  }))

  let document = apply(base, queue, A, 1).document
  const appliedIds = new Set(queue.map((op) => op.opId))
  // 오프라인 큐가 같은 배치를 네 번 재전송하며 매번 새 op을 하나씩 덧붙인다.
  for (let round = 0; round < 4; round += 1) {
    const fresh = { opId: opId(100 + round), kind: 'update', blockId: bid(1), baseSeq: 1, block: { text: `새 문장 ${round}` } }
    appliedIds.add(fresh.opId)
    document = apply(document, [...queue, fresh], A, round + 2).document
  }

  assert.equal(document.recentOpIds.length, new Set(document.recentOpIds).size, '같은 opId가 창을 두 번 차지했다')
  assert.deepEqual([...document.recentOpIds].sort(), [...appliedIds].sort())
  assert.ok(document.recentOpIds.length <= MAX_RECENT_OP_IDS)
  // 실효 창이 줄지 않았으므로 맨 처음 op도 아직 창 안에 있다 — 재전송해도 낡은 문장이 되살아나지 않는다.
  const resent = apply(document, [queue[0]], B, 9)
  assert.deepEqual(resent.applied, [queue[0].opId])
  assert.equal(resent.changedCount, 0)
  assert.equal(resent.document, document)
})

test('31. 삭제된 문단에 쓰던 문장만 담긴 배치도 이력에 실린다 — 그리고 재전송은 버전을 태우지 않는다', () => {
  const base = documentOf([stamped(bid(1), '가', 1), stamped(bid(2), '나', 2)])
  const afterDelete = apply(base, [{ opId: opId(1), kind: 'delete', blockId: bid(2) }], B, 1).document
  assert.equal(afterDelete.version, 2)

  const late = [{ opId: opId(2), kind: 'update', blockId: bid(2), baseSeq: 2, block: { text: '되살리고 싶은 문장' } }]
  const result = apply(afterDelete, late, A, 2)

  // 본문은 하나도 안 바뀌지만(계약 2: 삭제가 이긴다) 밀린 문장은 어디에도 버려지지 않는다(원칙 3).
  assert.equal(result.changedCount, 0)
  assert.deepEqual(idsOf(result.document.blocks), [bid(1)])
  assert.equal(result.document.version, 3)
  assert.deepEqual(result.rejected, [{ opId: opId(2), blockId: bid(2), code: REJECT_CODES.BLOCK_DELETED }])

  const revision = buildRevision({ document: result.document, result, actorId: A.actorId, actorName: A.actorName, now: at(2) })
  assert.equal(revision.version, 3)
  assert.equal(revision.lostEdits[0].text, '되살리고 싶은 문장')
  assert.equal(revision.summary, '저장하지 못한 내용 1건을 보관했습니다')
  assert.equal(revisionListItem(revision).hasLost, true)
  assert.deepEqual(reinstateSource(revision, bid(2)), { text: '되살리고 싶은 문장', from: 'lostEdits', block: null })

  // 재전송: 같은 문장을 두 번 싣지도, 버전을 다시 태우지도 않는다.
  const resent = apply(result.document, late, A, 3)
  assert.equal(resent.document, result.document)
  assert.equal(resent.document.version, 3)
  assert.deepEqual(resent.lostEdits, [])
  assert.deepEqual(resent.rejected, result.rejected)
  assert.equal(resent.changedCount, 0)
  // 거절된 op은 재전송에서도 '적용됨'으로 답하지 않는다(D3).
  assert.deepEqual(resent.applied, [])
})

test('32. lostEdits는 자르지 않는다 — 거절된 op에는 역패치라는 대체 보관처가 없다', () => {
  const blocks = Array.from({ length: 13 }, (_, index) => stamped(bid(index + 1), `문장 ${index + 1}`, index + 1))
  const base = documentOf(blocks)
  const removed = apply(base, blocks.slice(0, 12).map((block, index) => ({
    opId: opId(index + 1), kind: 'delete', blockId: block.id,
  })), B, 1).document

  const late = [
    ...Array.from({ length: 12 }, (_, index) => ({
      opId: opId(50 + index), kind: 'update', blockId: bid(index + 1), baseSeq: index + 1, block: { text: `지키고 싶은 문장 ${index}` },
    })),
    { opId: opId(80), kind: 'update', blockId: bid(13), baseSeq: 13, block: { text: '살아 있는 문단' } },
  ]
  const result = apply(removed, late, A, 2)
  const revision = buildRevision({ document: result.document, result, actorId: A.actorId, actorName: A.actorName, now: at(2) })

  assert.equal(result.lostEdits.length, 12)
  assert.equal(revision.lostEdits.length, 12)
  for (let index = 0; index < 12; index += 1) {
    assert.equal(revision.lostEdits[index].text, `지키고 싶은 문장 ${index}`)
  }

  // 대조: overwrites는 계속 10건에서 자른다. 잘려도 이전 블록 전체가 inverse에 남아 글자는 사라지지 않는다.
  const wide = documentOf(Array.from({ length: 12 }, (_, index) => stamped(bid(index + 1), `앞선 원문 ${index}`, index + 1)))
  const mine = apply(wide, Array.from({ length: 12 }, (_, index) => ({
    opId: opId(200 + index), kind: 'update', blockId: bid(index + 1), baseSeq: index + 1, block: { text: `내 문장 ${index}` },
  })), B, 1)
  const pushed = apply(mine.document, Array.from({ length: 12 }, (_, index) => ({
    opId: opId(300 + index), kind: 'update', blockId: bid(index + 1), baseSeq: index + 1, block: { text: `나중 문장 ${index}` },
  })), A, 2)
  const wideRevision = buildRevision({ document: pushed.document, result: pushed, actorId: A.actorId, actorName: A.actorName, now: at(2) })
  assert.equal(pushed.overwrites.length, 12)
  assert.equal(wideRevision.overwrites.length, MAX_REVISION_DETAIL)
  assert.equal(JSON.stringify(wideRevision.inverse).includes('내 문장 11'), true, '잘린 overwrites의 원문이 역패치에도 없다')
})

test('33. block 없는 update는 거절되고, 아무것도 바꾸지 않는 update는 버전도 overwrites도 만들지 않는다', () => {
  const base = documentOf([stamped(bid(1), '원문', 1)])
  const mine = apply(base, [{ opId: opId(1), kind: 'update', blockId: bid(1), baseSeq: 1, block: { text: '박지현 안' } }], A, 1).document

  // block이 없으면 통과시키지 않는다 — 통과시키면 본문은 그대로인 채 버전과 거짓 overwrites가 생긴다.
  const missing = apply(mine, [{ opId: opId(2), kind: 'update', blockId: bid(1), baseSeq: 1 }], B, 2)
  assert.equal(missing.error, WIKI_BLOCK_INVALID)
  assert.equal(missing.document, undefined)

  // 빈 패치·같은 값 패치는 성공이되 변경이 아니다.
  for (const patch of [{}, { text: '박지현 안' }]) {
    const noop = apply(mine, [{ opId: opId(3), kind: 'update', blockId: bid(1), baseSeq: 1, block: patch }], B, 3)
    assertNoVersionBurn(noop, mine)
    assert.equal(noop.document.version, 2)
    assert.deepEqual(noop.overwrites, [], '일어나지 않은 밀어내기를 이력에 적었다')
    assert.deepEqual(noop.applied, [opId(3)])
  }
})

test('34. 이미 상한을 넘긴 문서도 줄이는 배치는 통과한다 — 늘리는 배치만 막는다', () => {
  const blocks = Array.from({ length: 52 }, (_, index) => stamped(bid(index + 1), 'ㅁ'.repeat(4_000), index + 1))
  const base = documentOf(blocks)
  assert.ok(52 * 4_000 > MAX_DOCUMENT_TEXT)

  // 한 배치에 충분히 많이 지워야만 잠금이 풀린다면, 사람은 문서를 정상 범위로 되돌릴 길이 없다.
  const shrink = apply(base, [{ opId: opId(1), kind: 'delete', blockId: bid(1) }], B, 1)
  assert.equal(shrink.error, undefined)
  assert.equal(shrink.document.blocks.length, 51)

  const grow = apply(base, [{ opId: opId(2), kind: 'insert', after: null, block: { id: bid(90), type: 'text', text: '한 글자' } }], B, 1)
  assert.equal(grow.error, WIKI_DOCUMENT_TOO_LARGE)

  // 상한 아래 문서에서는 상한이 그대로 걸린다 — 늘어나는 쪽만 막는 것이지 상한을 푼 것이 아니다.
  const atLimit = documentOf(Array.from({ length: 50 }, (_, index) => stamped(bid(index + 1), 'ㅁ'.repeat(4_000), index + 1)))
  assert.equal(50 * 4_000, MAX_DOCUMENT_TEXT)
  const overflow = apply(atLimit, [{ opId: opId(3), kind: 'insert', after: null, block: { id: bid(90), type: 'text', text: 'ㅁ' } }], B, 1)
  assert.equal(overflow.error, WIKI_DOCUMENT_TOO_LARGE)
  const stillFits = apply(atLimit, [{ opId: opId(4), kind: 'update', blockId: bid(1), baseSeq: 1, block: { text: 'ㅁ'.repeat(3_999) } }], B, 1)
  assert.equal(stillFits.error, undefined)
})

test('35. 되감기 사슬은 documentId·tenantId를 무조건 비교한다 — 빈 값이 통과하지 않는다', () => {
  const document = documentOf([stamped(bid(1), '내 문서', 2)], { id: 'WDOC-AAAA', version: 2 })
  const own = (version, overrides) => ({
    id: `WREV-AAAA-${version}`, tenantId: 'TENANT-A', documentId: 'WDOC-AAAA', version, at: at(version), ...overrides,
  })
  const mineV1 = own(1, { snapshot: [stamped(bid(1), '내 문서 v1', 1)], inverse: [] })
  const mineV2 = own(2, { snapshot: null, inverse: [{ kind: 'update', blockId: bid(1), block: stamped(bid(1), '내 문서 v1', 1) }] })
  const foreign = (overrides) => ({
    id: 'WREV-X-1', version: 1, at: at(0), inverse: [],
    snapshot: [stamped(bid(99), '남의 테넌트 문장', 1)],
    ...overrides,
  })

  // 정상 사슬은 그대로 되감긴다.
  assert.deepEqual(textsOf(reconstructBlocks(document, [mineV1, mineV2], 1)), ['내 문서 v1'])

  // documentId·tenantId가 비었거나 다른 행은 어느 쪽도 사슬에 섞이지 않는다.
  for (const row of [
    foreign({ documentId: '', tenantId: 'TENANT-A' }),
    foreign({ documentId: null, tenantId: null }),
    foreign({ documentId: 'WDOC-AAAA', tenantId: 'TENANT-POHANG' }),
    foreign({ documentId: 'WDOC-BBBB', tenantId: 'TENANT-A' }),
  ]) {
    const label = `${row.documentId}/${row.tenantId}`
    // 내 v1이 잘려 없을 때: 남의 행이 그 자리를 메우는 것이 아니라 닫힌다(라우트가 410으로 답한다).
    assert.equal(reconstructBlocks(document, [row, mineV2], 1), null, `${label} 행이 v1 자리를 메웠다`)
    // 내 v1이 있을 때: 같은 버전이어도 남의 스냅샷이 채택되지 않는다.
    assert.deepEqual(textsOf(reconstructBlocks(document, [row, mineV1, mineV2], 1)), ['내 문서 v1'], `${label} 행이 사슬에 섞였다`)
  }
})

// ── 36..40 검증 2회차에서 잡힌 것 ───────────────────────────────────────────

test('36. 남이 먼저 모양을 바꾼 블록의 낡은 op은 그 op만 거절된다 — 같은 배치의 멀쩡한 편집을 죽이지 않는다', () => {
  const base = documentOf([
    { id: bid(1), type: 'todo', text: '할 일', checked: false, indent: 0, seq: 1, editedById: 'USR-A', editedAt: at(0) },
    stamped(bid(2), '옆 문단', 2),
  ])
  // 박지현이 슬래시 메뉴로 할 일을 문단으로 바꾼다.
  const converted = apply(base, [{ opId: opId(1), kind: 'update', blockId: bid(1), baseSeq: 1, block: { type: 'text' } }], A, 1).document
  assert.equal(converted.blocks[0].type, 'text')

  // 오태식의 큐에는 그 전에 만든 체크박스 op이 남아 있고, 같은 배치에 옆 문단 편집도 들어 있다.
  const batch = [
    { opId: opId(2), kind: 'update', blockId: bid(1), baseSeq: 1, block: { checked: true, text: '지키고 싶은 문장' } },
    { opId: opId(3), kind: 'update', blockId: bid(2), baseSeq: 2, block: { text: '오태식이 옆 문단에 쓴 글' } },
  ]
  const result = apply(converted, batch, B, 2)

  assert.equal(result.error, undefined, '배치 전체가 400으로 되돌아갔다')
  assert.deepEqual(result.rejected, [{ opId: opId(2), blockId: bid(1), code: REJECT_CODES.BLOCK_SHAPE_CHANGED }])
  assert.deepEqual(result.applied, [opId(3)])
  assert.equal(result.document.blocks[1].text, '오태식이 옆 문단에 쓴 글')
  assert.equal(result.document.version, 3)
  // 밀린 문장은 삭제 경로와 같은 자리에 실린다(§4-1 원칙 3).
  assert.equal(result.lostEdits.length, 1)
  assert.equal(result.lostEdits[0].text, '지키고 싶은 문장')
  assert.equal(result.lostEdits[0].blockId, bid(1))
  const revision = buildRevision({ document: result.document, result, actorId: B.actorId, actorName: B.actorName, now: at(2) })
  assert.deepEqual(reinstateSource(revision, bid(1)), { text: '지키고 싶은 문장', from: 'lostEdits', block: null })

  // 재전송해도 같은 결과이고 버전을 다시 태우지 않는다 — 거절은 영구하지만 배치는 살아 있다.
  const resent = apply(result.document, batch, B, 3)
  assert.equal(resent.error, undefined)
  assert.equal(resent.document, result.document)
  assert.deepEqual(resent.rejected, result.rejected)
  assert.deepEqual(resent.lostEdits, [])

  // TEXTUAL 울타리를 넘어간 경우도 같다(문단이 표가 됐고, 낡은 op은 여전히 목록 변환을 요청한다).
  const table = documentOf([
    { id: bid(1), type: 'table', rows: [['가']], seq: 3, editedById: 'USR-A', editedAt: at(0) },
    stamped(bid(2), '옆 문단', 2),
  ])
  const fenced = apply(table, [
    { opId: opId(4), kind: 'update', blockId: bid(1), baseSeq: 1, block: { type: 'bulleted', text: '내 목록' } },
    { opId: opId(5), kind: 'update', blockId: bid(2), baseSeq: 2, block: { text: '살아남아야 하는 글' } },
  ], B, 4)
  assert.equal(fenced.error, undefined)
  assert.deepEqual(fenced.rejected, [{ opId: opId(4), blockId: bid(1), code: REJECT_CODES.BLOCK_SHAPE_CHANGED }])
  assert.equal(fenced.document.blocks[1].text, '살아남아야 하는 글')
  assert.equal(fenced.lostEdits[0].text, '내 목록')

  // 반대쪽 문은 그대로다 — 클라이언트가 보낸 모양 자체가 틀리면 여전히 배치 전체 400이다.
  for (const patch of [{ 아무거나: 1 }, { seq: 9 }, { text: 'ㅁ'.repeat(MAX_ANY_BLOCK_TEXT + 1) }]) {
    const wrong = apply(converted, [
      { opId: opId(6), kind: 'update', blockId: bid(1), baseSeq: 1, block: patch },
      { opId: opId(7), kind: 'update', blockId: bid(2), baseSeq: 2, block: { text: '이건 저장되면 안 된다' } },
    ], B, 5)
    assert.equal(wrong.error, WIKI_BLOCK_INVALID, `${JSON.stringify(Object.keys(patch))}가 통과했다`)
    assert.equal(wrong.document, undefined)
  }
})

test('37. 이력으로만 가는 본문도 선언된 상한을 넘지 못한다 — 한 줄이 이력 예산을 혼자 삼키지 않는다', () => {
  const base = documentOf([stamped(bid(1), '가', 1), stamped(bid(2), '나', 2)])
  const afterDelete = apply(base, [{ opId: opId(1), kind: 'delete', blockId: bid(2) }], B, 1).document

  // 살아 있는 블록에서 400인 길이가 지워진 블록으로 가면 검사 없이 리비전에 실렸다(applyPatch를 지나지 않는다).
  const huge = { opId: opId(2), kind: 'update', blockId: bid(2), baseSeq: 2, block: { text: 'ㅁ'.repeat(MAX_ANY_BLOCK_TEXT + 1) } }
  const rejectedBatch = apply(afterDelete, [huge], A, 2)
  assert.equal(rejectedBatch.error, WIKI_BLOCK_INVALID)
  assert.equal(rejectedBatch.field, 'text')
  assert.equal(rejectedBatch.blockId, bid(2))

  // 상한 안이면 한 글자도 자르지 않고 그대로 보관한다(D17).
  const fits = 'ㅁ'.repeat(MAX_ANY_BLOCK_TEXT)
  const kept = apply(afterDelete, [{ opId: opId(3), kind: 'update', blockId: bid(2), baseSeq: 2, block: { text: fits } }], A, 2)
  assert.equal(kept.error, undefined)
  assert.equal(kept.lostEdits[0].text.length, MAX_ANY_BLOCK_TEXT)

  // 배치 상한(라우트가 막는 50) 안에서 만들 수 있는 가장 무거운 리비전도 이력 예산 안에 든다 —
  // 넘으면 pruneRevisions가 그 문서의 이력을 한 줄로 밀어내 목록에 보이던 버전이 곧장 410이 된다.
  const worst = Array.from({ length: MAX_OPS_PER_BATCH }, (_, index) => ({
    opId: opId(100 + index), kind: 'update', blockId: bid(2), baseSeq: 2, block: { text: fits },
  }))
  const heavy = apply(afterDelete, worst, A, 3)
  const revision = buildRevision({ document: heavy.document, result: heavy, actorId: A.actorId, actorName: A.actorName, now: at(3) })
  // '예산 안'만으로는 부족하다 — 예산의 절반을 먹는 한 줄은 예산 안에 있으면서도 FIFO로 그 문서의 이력
  // 전체를 밀어낸다(42). 어떤 한 배치도 예산의 한 조각(1/20 이하)에 머물러야 한다.
  assert.ok(revisionCost(revision) * 20 <= REVISION_BUDGET_CHARS, `가장 무거운 배치 한 줄이 예산의 1/20을 넘는다: ${revisionCost(revision)}`)
})

test('38. 제자리 move는 버전을 태우지 않는다 — 일어나지 않은 「옮겼습니다」를 이력에 적지 않는다', () => {
  const base = documentOf([stamped(bid(1), 'A', 1), stamped(bid(2), 'B', 2), stamped(bid(3), 'C', 3)])
  for (const op of [
    { opId: opId(1), kind: 'move', blockId: bid(2), after: bid(1) },   // 이미 A 바로 뒤다
    { opId: opId(2), kind: 'move', blockId: bid(1), after: null },     // 이미 맨 앞이다
    { opId: opId(3), kind: 'move', blockId: bid(3), after: bid(2) },   // 이미 맨 뒤다
  ]) {
    const result = apply(base, [op], B, 1)
    assert.deepEqual(result.changed.moved, [], `${op.blockId} 제자리 이동이 변경으로 셌다`)
    assertNoVersionBurn(result, base)
    assert.deepEqual(result.applied, [op.opId])
    assert.deepEqual(result.rejected, [])
  }
  // 진짜 이동은 그대로 한 줄이다.
  const moved = apply(base, [{ opId: opId(4), kind: 'move', blockId: bid(1), after: bid(3) }], B, 1)
  assert.deepEqual(idsOf(moved.document.blocks), [bid(2), bid(3), bid(1)])
  assert.deepEqual(moved.changed.moved, [bid(1)])
  assert.equal(moved.document.version, 2)
  assert.equal(revisionSummary({ changed: moved.changed }), '문단 1개를 옮겼습니다')
})

test('39. 삭제 뒤 복원해도 업무 역링크가 남는다 — 그리고 클라이언트 문맥에서는 심어지지 않는다', () => {
  const linked = { id: bid(1), type: 'todo', text: '할 일', checked: false, indent: 0, seq: 1, editedById: 'USR-A', editedAt: at(0), workItemId: 'WK-REAL' }
  const base = documentOf([linked, stamped(bid(2), '옆 문단', 2)])
  const revisions = [creationRevision(base, A, 0)]

  const edited = apply(base, [{ opId: opId(1), kind: 'update', blockId: bid(1), baseSeq: 1, block: { type: 'text' } }], A, 1)
  revisions.push(buildRevision({ document: edited.document, result: edited, actorId: A.actorId, actorName: A.actorName, now: at(1) }))
  // 타입을 바꿔도 링크는 끊기지 않는다(applyPatch가 지킨다).
  assert.equal(edited.document.blocks[0].workItemId, 'WK-REAL')

  const removed = apply(edited.document, [{ opId: opId(2), kind: 'delete', blockId: bid(1) }], B, 2)
  revisions.push(buildRevision({ document: removed.document, result: removed, actorId: B.actorId, actorName: B.actorName, now: at(2) }))

  const target = reconstructBlocks(removed.document, revisions, 2)
  assert.equal(target[0].workItemId, 'WK-REAL')

  // 복원은 서버가 내는 ops다 — 지웠던 블록을 되살릴 때 승인 큐가 가리키던 자리를 끊지 않는다.
  const restored = mergeOps(removed.document, diffToOps(removed.document.blocks, target), { ...B, now: at(3), nameOf, restore: true })
  assert.equal(restored.error, undefined)
  assert.equal(restored.document.blocks.find((block) => block.id === bid(1)).workItemId, 'WK-REAL')

  // 같은 ops를 클라이언트 문맥으로 흘리면 심어지지 않는다(승인 큐 우회 금지).
  const asClient = mergeOps(removed.document, diffToOps(removed.document.blocks, target), { ...B, now: at(3), nameOf })
  assert.equal(asClient.document.blocks.find((block) => block.id === bid(1)).workItemId, undefined)

  // 클라이언트가 스스로 심는 세 경로는 어느 문맥에서도 막힌다.
  const live = documentOf([stamped(bid(3), '문단', 1)])
  for (const op of [
    { opId: opId(5), kind: 'insert', after: null, block: { id: bid(4), type: 'text', text: '가', workItemId: 'WK-FAKE' } },
    { opId: opId(6), kind: 'update', blockId: bid(3), baseSeq: 1, block: { text: '가', workItemId: 'WK-FAKE' } },
    { opId: opId(7), kind: 'insert', after: null, block: { id: bid(3), type: 'text', text: '가', workItemId: 'WK-FAKE' } },
  ]) {
    for (const context of [{ ...B, now: at(4), nameOf }, { ...B, now: at(4), nameOf, restore: true }]) {
      assert.equal(mergeOps(live, [op], context).error, WIKI_BLOCK_INVALID, `${op.opId}가 workItemId를 심었다`)
    }
  }
})

test('40. 테넌트 이력 정리는 시계가 아니라 버전으로 자른다 — at이 엄격 증가하지 않아도 사슬이 뚫리지 않는다', () => {
  // 진짜 리비전 사슬을 만든다: v2..v13. `stamps`가 각 배치의 at을 정한다.
  const chainOf = (stamps) => {
    let document = documentOf([stamped(bid(1), '가', 1)])
    const revisions = []
    stamps.forEach((now, index) => {
      const result = mergeOps(document, [{ opId: opId(index + 1), kind: 'update', blockId: bid(1), baseSeq: 1, block: { text: `v${index}` } }], { ...A, now, nameOf })
      document = result.document
      revisions.push(buildRevision({ document, result, actorId: A.actorId, actorName: A.actorName, now }))
    })
    return { document, revisions }
  }
  const day = (offset) => new Date(Date.UTC(2026, 2, 1) + offset * 24 * 60 * 60 * 1000).toISOString()
  const unreachableIn = (chain, order, options) => {
    const rows = order === 'newest-first' ? chain.revisions.slice().reverse() : chain.revisions.slice()
    const { kept } = pruneTenantRevisions(rows, options)
    return kept.map((row) => row.version).sort((left, right) => left - right)
      .filter((version) => reconstructBlocks(chain.document, kept, version) === null)
  }

  // (1) 같은 밀리초에 들어온 배치들 + 저장소가 최신순으로 준 경우.
  const tied = chainOf(Array.from({ length: 12 }, () => day(1)))
  assert.deepEqual(unreachableIn(tied, 'newest-first', { now: day(1), maxRows: 5 }), [])

  // (2) NTP가 시계를 한 번 되돌린 경우.
  const stepped = Array.from({ length: 12 }, (_, index) => day(index + 10))
  stepped[8] = day(2)
  stepped[9] = day(3)
  assert.deepEqual(unreachableIn(chainOf(stepped), 'oldest-first', { now: day(30), maxRows: 5 }), [])

  // (3) 보관 기간 갈래만으로도 뚫렸다 — 사슬 한가운데의 낡은 한 줄이 그 아래 전부를 못 쓰게 만들었다.
  const aged = Array.from({ length: 12 }, (_, index) => day(index))
  aged[5] = new Date(Date.UTC(2024, 0, 1)).toISOString()
  assert.deepEqual(unreachableIn(chainOf(aged), 'oldest-first', { now: day(19), retentionDays: 30, maxRows: 10_000 }), [])

  // 자를 것은 여전히 자른다 — 상한 5면 가장 오래된 쪽부터 사라지고 남는 쪽은 언제나 접미다.
  const plain = chainOf(Array.from({ length: 12 }, (_, index) => day(index + 1)))
  const { kept, removed } = pruneTenantRevisions(plain.revisions, { now: day(20), maxRows: 5 })
  assert.deepEqual(kept.map((row) => row.version), [9, 10, 11, 12, 13])
  assert.equal(removed, 7)

  // now가 날짜로 파싱되지 않으면 RangeError로 스케줄러 잡이 죽지 않고, 뜻한 메시지가 나온다.
  assert.throws(() => pruneTenantRevisions([], { now: '어제' }), { name: 'TypeError', message: /now\(ISO 문자열\)/ })
  assert.throws(() => pruneTenantRevisions([], { now: null }), { name: 'TypeError' })
})

// ── 41..46 검증 3회차에서 잡힌 것 ───────────────────────────────────────────

test('41. 좁은 타입에서만 긴 본문은 op 하나만 거절한다 — 슬래시 메뉴 변환이 배치를 죽이지 않는다', () => {
  // (a) 남이 문단을 제목으로 바꾼 뒤, 문단 시절에 쓴 1_000자 op이 그 위에 얹힌다.
  //     1_000은 문단(4_000)에서는 적법하고 제목(200)에서만 불법이다 — 클라이언트가 고칠 수 없는 이유다.
  const base = documentOf([stamped(bid(1), '원래 문단', 1), stamped(bid(2), '옆 문단', 2)])
  const converted = apply(base, [{ opId: opId(1), kind: 'update', blockId: bid(1), baseSeq: 1, block: { type: 'heading' } }], A, 1).document
  assert.equal(converted.blocks[0].type, 'heading')

  const stale = apply(converted, [
    { opId: opId(2), kind: 'update', blockId: bid(1), baseSeq: 1, block: { text: 'ㄱ'.repeat(1_000) } },
    { opId: opId(3), kind: 'update', blockId: bid(2), baseSeq: 2, block: { text: '오태식이 옆 문단에 쓴 글' } },
  ], B, 2)
  assert.equal(stale.error, undefined, '배치 전체가 400으로 되돌아갔다')
  assert.deepEqual(stale.rejected, [{ opId: opId(2), blockId: bid(1), code: REJECT_CODES.BLOCK_TOO_LONG_FOR_TYPE }])
  assert.deepEqual(stale.applied, [opId(3)])
  assert.equal(stale.document.blocks[1].text, '오태식이 옆 문단에 쓴 글')
  // 밀린 문장은 삭제·모양변경 경로와 같은 자리에 실린다(§4-1 원칙 3).
  assert.equal(stale.lostEdits[0].text.length, 1_000)
  const revision = buildRevision({ document: stale.document, result: stale, actorId: B.actorId, actorName: B.actorName, now: at(2) })
  assert.equal(reinstateSource(revision, bid(1)).from, 'lostEdits')

  // (b) 아무도 경쟁하지 않아도 같다 — 300자 문단을 스스로 제목으로 바꾸는 것은 슬래시 메뉴의 평범한 조작이다.
  assert.ok(MAX_TITLE < 300)
  const long = documentOf([stamped(bid(1), '가'.repeat(300), 1), stamped(bid(2), '옆 문단', 2)])
  const convert = apply(long, [
    { opId: opId(4), kind: 'update', blockId: bid(2), baseSeq: 2, block: { text: '방금 친 소중한 문장' } },
    { opId: opId(5), kind: 'update', blockId: bid(1), baseSeq: 1, block: { type: 'heading' } },
  ], B, 3)
  assert.equal(convert.error, undefined)
  assert.deepEqual(convert.rejected, [{ opId: opId(5), blockId: bid(1), code: REJECT_CODES.BLOCK_TOO_LONG_FOR_TYPE }])
  assert.equal(convert.document.blocks[1].text, '방금 친 소중한 문장')
  assert.equal(convert.document.blocks[0].type, 'text', '변환이 절반만 일어났다')

  // (c) 반대 축도 같다 — 코드(20_000)로 알던 블록이 문단(4_000)이 됐다.
  assert.ok(MAX_BLOCK_TEXT < 5_000)
  const code = documentOf([
    { id: bid(1), type: 'code', text: 'x'.repeat(5_000), language: 'javascript', seq: 1, editedById: 'USR-A', editedAt: at(0) },
    stamped(bid(2), '옆 문단', 2),
  ])
  const shrink = apply(code, [
    { opId: opId(6), kind: 'update', blockId: bid(2), baseSeq: 2, block: { text: '살아남아야 할 문장' } },
    { opId: opId(7), kind: 'update', blockId: bid(1), baseSeq: 1, block: { type: 'text' } },
  ], B, 4)
  assert.equal(shrink.error, undefined)
  assert.equal(shrink.rejected[0].code, REJECT_CODES.BLOCK_TOO_LONG_FOR_TYPE)
  assert.equal(shrink.document.blocks[1].text, '살아남아야 할 문장')

  // (d) 반대쪽 문은 그대로다 — 어떤 타입에도 얹힐 수 없는 길이는 진짜 클라 버그라 배치 전체 400이다.
  const wrong = apply(converted, [
    { opId: opId(8), kind: 'update', blockId: bid(1), baseSeq: 1, block: { text: 'ㅁ'.repeat(MAX_ANY_BLOCK_TEXT + 1) } },
    { opId: opId(9), kind: 'update', blockId: bid(2), baseSeq: 2, block: { text: '이건 저장되면 안 된다' } },
  ], B, 5)
  assert.equal(wrong.error, WIKI_BLOCK_INVALID)
  assert.equal(wrong.document, undefined)
})

test('42. 한 배치가 이력에 실을 수 있는 밀린 문장에는 총량 상한이 있다 — 요청 두 번이 이력을 지우지 못한다', () => {
  // 사람들이 정성껏 쌓은 이력 32줄.
  let document = documentOf([stamped(bid(1), '문서 시작', 1)])
  const revisions = []
  const commit = (result, minute) => {
    assert.equal(result.error, undefined)
    document = result.document
    revisions.push(buildRevision({ document, result, actorId: A.actorId, actorName: A.actorName, now: at(minute) }))
  }
  for (let index = 0; index < 30; index += 1) {
    commit(apply(document, [{
      opId: opId(index + 1), kind: 'update', blockId: bid(1), baseSeq: document.blockSeq, block: { text: `정성껏 쓴 ${index}번째 문장` },
    }], A, index + 1), index + 1)
  }
  commit(apply(document, [{ opId: opId(90), kind: 'insert', after: null, block: { id: bid(9), type: 'text', text: 'x' } }], A, 40), 40)
  commit(apply(document, [{ opId: opId(91), kind: 'delete', blockId: bid(9) }], A, 41), 41)

  // 공격: 지워진 블록을 겨냥한 20_000자 update 50건(= 라우트 배치 상한)을 두 번. 총량 상한이 없으면 배치
  // 하나가 리비전 예산의 절반을 먹고, 그 두 줄이 FIFO로 그 문서의 이력 전체를 밀어낸다.
  for (let round = 0; round < 2; round += 1) {
    const ops = Array.from({ length: MAX_OPS_PER_BATCH }, (_, index) => ({
      opId: opId(200 + round * MAX_OPS_PER_BATCH + index),
      kind: 'update',
      blockId: bid(9),
      baseSeq: 0,
      block: { text: 'z'.repeat(MAX_ANY_BLOCK_TEXT) },
    }))
    const attack = apply(document, ops, B, 50 + round)
    const archived = attack.lostEdits.reduce((sum, row) => sum + row.text.length, 0)
    assert.ok(archived <= MAX_LOST_TEXT_PER_BATCH, `한 배치가 ${archived}자를 실었다`)
    // 넘긴 몫은 자르지 않는다 — 그 op을 거절하고 그 사실을 응답에 적어, 문장이 클라이언트 큐에 남게 한다.
    const dropped = attack.rejected.filter((row) => row.lostTextDropped === true)
    assert.equal(dropped.length, MAX_OPS_PER_BATCH - attack.lostEdits.length)
    for (const row of attack.rejected) assert.equal(row.code, REJECT_CODES.BLOCK_DELETED)
    commit(attack, 50 + round)
  }

  const kept = pruneRevisions(revisions)
  assert.ok(kept.some((row) => JSON.stringify(row).includes('정성껏 쓴')), '사람이 쓴 옛 문장이 이력에서 사라졌다')
  assert.equal(kept.length, revisions.length, `이력이 ${kept.length}줄로 줄었다`)
  for (const row of kept) assert.ok(reconstructBlocks(document, kept, row.version), `v${row.version} 복원 불가`)

  // 상한 안이면 한 글자도 자르지 않는다 — D17은 그대로다.
  const exact = 'ㅁ'.repeat(MAX_ANY_BLOCK_TEXT)
  const fits = apply(document, [
    { opId: opId(400), kind: 'update', blockId: bid(9), baseSeq: 0, block: { text: exact } },
    { opId: opId(401), kind: 'update', blockId: bid(9), baseSeq: 0, block: { text: exact } },
  ], B, 60)
  assert.equal(fits.lostEdits.length, 2)
  assert.equal(fits.lostEdits[1].text, exact)
  assert.deepEqual(fits.rejected.filter((row) => row.lostTextDropped), [])
})

test('43. 한 문단을 고치고 옮기면 이력은 「1곳」이라고 말한다 — 세는 단위는 op이 아니라 문단이다', () => {
  const base = documentOf([stamped(bid(1), '가', 1), stamped(bid(2), '나', 2)])
  const result = apply(base, [
    { opId: opId(1), kind: 'update', blockId: bid(2), baseSeq: 2, block: { text: '고친 문장' } },
    { opId: opId(2), kind: 'move', blockId: bid(2), after: null },
  ], A, 1)
  // 화면은 어느 블록이 어떻게 바뀌었는지 알아야 하므로 배열에는 양쪽에 남는다 — 틀린 것은 세는 방식이었다.
  assert.deepEqual(result.changed.updated, [bid(2)])
  assert.deepEqual(result.changed.moved, [bid(2)])
  assert.equal(revisionSummary({ changed: result.changed }), '문단 1곳을 바꿨습니다')
  const revision = buildRevision({ document: result.document, result, actorId: A.actorId, actorName: A.actorName, now: at(1) })
  assert.equal(revision.summary, '문단 1곳을 바꿨습니다')

  // 서로 다른 블록이면 그대로 둘이다.
  const two = apply(base, [
    { opId: opId(3), kind: 'update', blockId: bid(1), baseSeq: 1, block: { text: '앞 문단' } },
    { opId: opId(4), kind: 'move', blockId: bid(2), after: null },
  ], A, 2)
  assert.equal(revisionSummary({ changed: two.changed }), '문단 2곳을 바꿨습니다')
})

test('44. 변화 0 배치도 「적용됨」으로 답한 opId를 멱등 창에 남긴다 — 나중 재전송이 파괴적이 되지 않는다', () => {
  const base = documentOf([stamped(bid(1), '살아 있는 문단', 1)])
  // 이미 없는 블록의 delete는 C6대로 성공이다. 문서는 한 글자도 바뀌지 않는다.
  const deleteOp = { opId: opId(1), kind: 'delete', blockId: bid(9) }
  const first = apply(base, [deleteOp], A, 1)
  assert.deepEqual(first.applied, [deleteOp.opId])
  assertNoVersionBurn(first, base)

  // 그 사이 복원이 같은 블록 id를 되살린다(복원은 옛 id를 그대로 되살리는 것이 §4-5의 설계다).
  const restored = mergeOps(first.document, [
    { opId: opId(2), kind: 'insert', after: null, block: { id: bid(9), type: 'text', text: '복원으로 되살아난 문단' } },
  ], { ...A, now: at(2), nameOf, restore: true }).document
  assert.ok(restored.blocks.some((block) => block.id === bid(9)))

  // 오프라인 큐가 응답을 못 받아 같은 op을 재전송한다 — 멱등 창이 없으면 이번에는 진짜로 지운다.
  const retry = apply(restored, [deleteOp], A, 3)
  assert.deepEqual(retry.changed.deleted, [], '재전송이 되살린 블록을 지웠다')
  assert.equal(retry.document.blocks.find((block) => block.id === bid(9)).text, '복원으로 되살아난 문단')
  assert.deepEqual(retry.applied, [deleteOp.opId])

  // 이미 창에 있는 op만 든 배치는 문서를 **참조 그대로** 돌려준다 — 라우트가 쓸 것이 없다는 뜻이다.
  const again = apply(retry.document, [deleteOp], A, 4)
  assert.equal(again.document, retry.document)

  // 그래서 "리비전을 만들 차례인가"는 참조 동일성이 아니라 versionBumped가 정한다. 참조로 재는 호출부는
  // 같은 version의 행을 둘 만들어 사슬을 뒤튼다 — 조용히 두면 몇 배치 뒤 복원이 엉뚱한 블록을 돌려준다.
  assert.throws(
    () => buildRevision({ document: first.document, result: first, actorId: A.actorId, actorName: A.actorName, now: at(1) }),
    { name: 'TypeError', message: /versionBumped/ },
  )
})

test('45. 서버가 낸 적 없는 baseSeq는 400이다 — 「…님이 먼저 고쳤습니다」를 끌 수 없다', () => {
  const base = documentOf([stamped(bid(1), '박지현이 방금 쓴 문장', 7)])
  const update = (suffix, baseSeq) => ({ opId: opId(suffix), kind: 'update', blockId: bid(1), baseSeq, block: { text: '오태식 안' } })

  // 정직한 기준선이면 밀린 원문이 이력에 남고 사람에게 알림이 간다.
  const honest = apply(base, [update(1, 1)], B, 1)
  assert.equal(honest.overwrites[0].previousText, '박지현이 방금 쓴 문장')

  // 서버 blockSeq보다 큰 값은 그 알림을 통째로 끄는 유일한 수단이었다 — baseVersion과 같은 태도로 막는다.
  for (const baseSeq of [base.blockSeq + 1, 999_999, -1]) {
    const bogus = apply(base, [update(2, baseSeq)], B, 1)
    assert.equal(bogus.error, WIKI_OPS_INVALID, `baseSeq ${baseSeq}가 통과했다`)
    assert.equal(bogus.reason, 'baseSeq')
    assert.equal(bogus.document, undefined)
  }
  // 경계는 열려 있다 — blockSeq 자신은 서버가 낸 값이다.
  assert.equal(apply(base, [update(3, base.blockSeq)], B, 1).error, undefined)
})

test('46. 계약 1의 실제 범위 — 수정은 도착 순서와 무관하고, 같은 앵커 뒤 삽입은 나중 도착이 앵커에 더 가깝다', () => {
  const base = documentOf([stamped(bid(1), 'A', 1)])
  const insert = (suffix, id, text) => ({ opId: opId(suffix), kind: 'insert', after: bid(1), block: { id, type: 'text', text } })

  // 두 사람이 같은 문단 뒤에서 동시에 Enter를 친다. 순서는 도착 순서가 정하고, 둘 다 살아남는다.
  const forward = apply(apply(base, [insert(1, bid(2), 'X')], A, 1).document, [insert(2, bid(3), 'Y')], B, 2)
  const backward = apply(apply(base, [insert(2, bid(3), 'Y')], B, 1).document, [insert(1, bid(2), 'X')], A, 2)
  assert.deepEqual(textsOf(forward.document.blocks), ['A', 'Y', 'X'])
  assert.deepEqual(textsOf(backward.document.blocks), ['A', 'X', 'Y'])
  for (const result of [forward, backward]) {
    assert.deepEqual(result.rejected, [])
    assert.equal(result.document.blocks.length, 3, '삽입 하나가 사라졌다')
  }

  // 대조: 같은 블록을 건드리지 않는 **수정**은 순서를 뒤집어도 최종 문서가 같다(6·27이 잠그는 계약 1).
  const pair = documentOf([stamped(bid(1), '가', 1), stamped(bid(2), '나', 2)])
  const opA = { opId: opId(5), kind: 'update', blockId: bid(1), baseSeq: 1, block: { text: '가가' } }
  const opB = { opId: opId(6), kind: 'update', blockId: bid(2), baseSeq: 2, block: { text: '나나' } }
  const one = apply(apply(pair, [opA], A, 1).document, [opB], B, 2)
  const other = apply(apply(pair, [opB], B, 1).document, [opA], A, 2)
  assert.deepEqual(textsOf(one.document.blocks), textsOf(other.document.blocks))
})

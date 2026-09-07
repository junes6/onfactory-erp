import assert from 'node:assert/strict'
import test from 'node:test'

import { BLOCK_TYPES, TEXTUAL_TYPES, fieldsOf } from '../src/components/wiki/wikiBlocks.ts'
import {
  canApplyServerDocument, coalesceOps, createWikiOpQueue, mergeServerBlocks, newInsertOp, newUpdateOp,
  orphanNotices, ownSeqsFrom, pendingBlockIdsOf, rejectionNotice, withOwnBaseSeq,
} from '../src/components/wiki/wikiOps.ts'

/**
 * 문서(위키) 편집 큐의 순수 함수 — **값만 넣어 재는** 시험.
 *
 * 설계 §6-4.5가 `canApplyServerDocument`를 순수 함수로 뺀 이유가 여기에 있다: 이 판정이 틀리면
 * 증상이 "가끔 한글이 깨진다"로만 나타나 브라우저에서 재현할 수 없다. 그런데 판정 함수만 옳고
 * **그 판정을 쓰는 호출부**가 틀려도 증상은 똑같다. 그래서 판정과 호출부를 함께 잰다.
 *
 * `coalesceOps`도 같은 종류의 자리다. 접힌 조각은 화면에 보이지 않고 네트워크로만 나가므로,
 * 틀린 모양이 만들어져도 사람 눈에는 "저장이 안 됐다"로만 보인다. 서버 규격표(`fieldsOf`)에
 * 대고 재는 것이 유일하게 확실한 방법이다.
 */

const updateOp = (opId, blockId, baseSeq, block) => ({ opId, kind: 'update', blockId, baseSeq, block })
const insertOp = (opId, block, after = null) => ({ opId, kind: 'insert', block, after })

// ── canApplyServerDocument ─────────────────────────────────────────────────
test('덮어도 되는지 판정 — 포커스·조합·대기 큐·무관 블록·빈 id 다섯 갈래', () => {
  assert.equal(canApplyServerDocument({ blockId: 'BLK-A', focusedBlockId: 'BLK-A' }), false, '캐럿이 놓인 블록은 덮지 않는다')
  assert.equal(canApplyServerDocument({ blockId: 'BLK-A', composing: true, focusedBlockId: null }), false, '조합 중인데 어디인지 모르면 아무것도 덮지 않는다')
  assert.equal(canApplyServerDocument({ blockId: 'BLK-A', pendingBlockIds: ['BLK-B', 'BLK-A'] }), false, '아직 못 보낸 편집이 있는 블록은 덮지 않는다')
  assert.equal(canApplyServerDocument({ blockId: 'BLK-A', focusedBlockId: 'BLK-B', pendingBlockIds: ['BLK-C'] }), true, '무관한 블록은 서버 값이 이긴다')
  assert.equal(canApplyServerDocument({ blockId: '', focusedBlockId: '' }), true, '빈 id는 판정할 것이 없다')
})

// ── mergeServerBlocks ──────────────────────────────────────────────────────
test('판정이 덮지 말라고 하면 종류가 바뀌었어도 지금 치던 글자는 남는다', () => {
  const guard = { focusedBlockId: 'BLK-A', composing: true }
  const local = [{ id: 'BLK-A', type: 'text', text: '내가 지금 조합 중인 한글' }]

  const same = mergeServerBlocks(local, [{ id: 'BLK-A', type: 'text', text: '서버 값' }], guard)
  assert.equal(same[0].text, '내가 지금 조합 중인 한글', '타입이 같을 때는 원래도 지켰다')

  // 남이 슬래시 메뉴로 그 문단의 종류를 바꾼 순간이다. 타입은 서버가 정하고, 글자는 사람이 정한다.
  const changed = mergeServerBlocks(local, [{ id: 'BLK-A', type: 'quote', text: '서버 값' }], guard)
  assert.equal(changed[0].type, 'quote', '타입·순서·삭제는 서버가 정한다')
  assert.equal(changed[0].text, '내가 지금 조합 중인 한글', '판정이 false인데 본문이 서버 값으로 덮였다(§6-4.5 위반)')

  const cells = mergeServerBlocks(
    [{ id: 'BLK-T', type: 'table', rows: [['치던', '셀']] }],
    [{ id: 'BLK-T', type: 'table', rows: [['서버', '셀']] }],
    { focusedBlockId: 'BLK-T' },
  )
  assert.deepEqual(cells[0].rows, [['치던', '셀']], '표 셀도 같은 규칙이다')
})

test('덮어도 되는 블록은 서버 값을 그대로 받고, 서버에 없는 블록은 사라진다', () => {
  const merged = mergeServerBlocks(
    [{ id: 'BLK-A', type: 'text', text: '옛 값' }, { id: 'BLK-GONE', type: 'text', text: '남이 지운 문단' }],
    [{ id: 'BLK-A', type: 'heading', text: '서버 값', level: 2 }, { id: 'BLK-NEW', type: 'text', text: '남이 쓴 문단' }],
    { focusedBlockId: 'BLK-OTHER' },
  )
  assert.deepEqual(merged.map((block) => block.id), ['BLK-A', 'BLK-NEW'])
  assert.equal(merged[0].text, '서버 값')
  assert.equal(merged[0].type, 'heading')
})

// ── coalesceOps ────────────────────────────────────────────────────────────
test('연속 수정을 접을 때 옛 타입의 필드를 데리고 가지 않는다', () => {
  // 저장이 비행 중이면 changeType의 flush가 no-op이라 종류 변경 두 개가 큐에 나란히 남는다.
  const folded = coalesceOps([
    updateOp('OP-1', 'BLK-A', 3, { type: 'code', language: '' }),
    updateOp('OP-2', 'BLK-A', 3, { type: 'text' }),
  ])
  assert.equal(folded.length, 1, '같은 블록의 연속 수정은 하나로 접힌다')
  assert.equal(folded[0].opId, 'OP-2', '멱등 id는 최신 것')
  assert.equal(folded[0].baseSeq, 3, 'baseSeq는 사람이 보고 고치기 시작한 값을 지킨다')
  assert.deepEqual(folded[0].block, { type: 'text' }, `옛 타입의 필드가 남았다: ${JSON.stringify(folded[0].block)}`)
})

test('삽입에 종류 변경을 접어도 새 타입의 규격만 남는다', () => {
  const folded = coalesceOps([
    insertOp('OP-1', { id: 'BLK-N', type: 'bulleted', text: '', indent: 0 }, 'BLK-P'),
    updateOp('OP-2', 'BLK-N', 0, { type: 'text' }),
  ])
  assert.equal(folded.length, 1)
  assert.equal(folded[0].kind, 'insert', '삽입 직후의 수정은 삽입에 접힌다')
  assert.equal(folded[0].after, 'BLK-P', '앵커를 잃지 않는다')
  assert.deepEqual(folded[0].block, { id: 'BLK-N', type: 'text', text: '' }, `새 타입에 없는 필드가 남았다: ${JSON.stringify(folded[0].block)}`)
})

test('글자 계열 7종 사이의 어떤 종류 변경도 규격을 벗어난 조각을 만들지 않는다', () => {
  const seedOf = (type) => {
    const block = { id: 'BLK-S', type }
    for (const field of fieldsOf(type)) block[field] = field === 'text' ? '내용' : field === 'level' ? 2 : field === 'checked' ? false : field === 'indent' ? 0 : ''
    return block
  }
  const broken = []
  for (const from of TEXTUAL_TYPES) {
    for (const to of TEXTUAL_TYPES) {
      if (from === to) continue
      const allowed = new Set(['id', 'type', ...fieldsOf(to)])
      const patch = { type: to }
      if (to === 'heading') patch.level = 2
      if (to === 'todo') patch.checked = false
      if (to === 'code') patch.language = ''
      if (to === 'bulleted' || to === 'numbered' || to === 'todo') patch.indent = 0

      const [asInsert] = coalesceOps([insertOp('OP-1', seedOf(from), null), updateOp('OP-2', 'BLK-S', 0, patch)])
      const strayInsert = Object.keys(asInsert.block).filter((key) => !allowed.has(key))
      if (strayInsert.length) broken.push(`insert ${from}→${to}: ${strayInsert.join(',')}`)

      const [asUpdate] = coalesceOps([updateOp('OP-1', 'BLK-S', 0, { ...seedOf(from), id: undefined }), updateOp('OP-2', 'BLK-S', 0, patch)])
      const strayUpdate = Object.keys(asUpdate.block).filter((key) => asUpdate.block[key] !== undefined && !allowed.has(key))
      if (strayUpdate.length) broken.push(`update ${from}→${to}: ${strayUpdate.join(',')}`)
    }
  }
  assert.deepEqual(broken, [], `종류를 바꾸는 접기가 옛 타입의 필드를 남긴다: ${broken.join(' / ')}`)
})

test('접기는 다른 블록·다른 종류의 조각을 건드리지 않는다', () => {
  const queue = [
    updateOp('OP-1', 'BLK-A', 1, { text: '가' }),
    updateOp('OP-2', 'BLK-B', 2, { text: '나' }),
    updateOp('OP-3', 'BLK-A', 1, { text: '다' }),
    { opId: 'OP-4', kind: 'delete', blockId: 'BLK-A' },
  ]
  const folded = coalesceOps(queue)
  assert.deepEqual(folded.map((op) => op.opId), ['OP-1', 'OP-2', 'OP-3', 'OP-4'], '사이에 낀 다른 블록은 접기를 끊는다')
  assert.deepEqual(pendingBlockIdsOf(queue), ['BLK-A', 'BLK-B'], '손대고 있는 블록은 중복 없이 알린다')
})

test('블록 타입 표는 서버 규격과 같은 열쇠로 묻는다', () => {
  for (const type of BLOCK_TYPES) assert.ok(Array.isArray(fieldsOf(type)), `${type}의 필드 표가 없다`)
  assert.deepEqual([...fieldsOf('todo')].sort(), ['checked', 'indent', 'text'])
  assert.deepEqual([...fieldsOf('text')], ['text'])
})

// ── createWikiOpQueue — 진짜 큐가 네트워크로 무엇을 내보내는가 ───────────────
/**
 * `fetch`를 갈아 끼우고 나간 요청을 모은다. 상대 경로(`/api/wiki/...`)라 node의 진짜 fetch로는
 * 부를 수 없고, 무엇보다 **무엇이 나갔는지**가 이 시험의 전부다.
 */
function captureFetch(reply = () => new Response(JSON.stringify({
  document: { id: 'WDOC-QUEUE', version: 2, blocks: [], title: '' },
  version: 2, applied: [], rejected: [], overwrites: [], lostEditCount: 0, presence: [],
}), { status: 200, headers: { 'content-type': 'application/json' } })) {
  const sent = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    sent.push({ url, keepalive: Boolean(init.keepalive), body: JSON.parse(String(init.body ?? '{}')) })
    return reply()
  }
  return { sent, restore: () => { globalThis.fetch = original } }
}

const buildQueue = (events = []) => createWikiOpQueue({
  documentId: 'WDOC-QUEUE', clientId: 'WCL-TEST', headers: () => ({ 'content-type': 'application/json' }),
  handlers: {
    onStatus: (status, detail) => { events.push([status, detail ?? null]) },
    onApplied: () => {},
    onPending: () => {},
  },
  setTimeoutFn: setTimeout, clearTimeoutFn: clearTimeout,
})

test('문서를 바꿀 때 못 보낸 편집은 정리 단계에서 나간다 — dispose 뒤의 flush는 한 글자도 못 보낸다', async () => {
  const capture = captureFetch()
  try {
    // ① WikiPage 효과의 **정리**가 하는 그대로: 보내고 나서 버린다.
    const queue = buildQueue()
    queue.push(newUpdateOp('BLK-A', 0, { text: '사람이 방금 친 문장' }))
    queue.flushBeacon()
    queue.dispose()
    assert.equal(capture.sent.length, 1, '문서를 바꾸는 순간 못 보낸 편집이 통째로 사라졌다')
    assert.equal(capture.sent[0].body.ops[0].block.text, '사람이 방금 친 문장')
    assert.equal(capture.sent[0].keepalive, true, '응답을 기다릴 수 없는 자리다 — keepalive가 아니면 화면 전환에 잘린다')

    // ② 순서를 뒤집으면(버린 뒤에 보내면) 아무 일도 일어나지 않는다.
    //    효과 **본문** 첫 줄에 flush를 두는 모양이 죽은 코드인 이유가 이것이다(React는 정리를 먼저 돌린다).
    capture.sent.length = 0
    const stale = buildQueue()
    stale.push(newUpdateOp('BLK-B', 0, { text: '이 문장은 사라진다' }))
    stale.dispose()
    await stale.flush()
    stale.flushBeacon()
    assert.equal(capture.sent.length, 0, '버려진 큐가 요청을 보냈다면 이 시험의 전제가 틀렸다')
  } finally { capture.restore() }
})

test('413 문장은 서버가 정한다 — 화면이 그 자리에 다른 처방을 지어내지 않는다', async () => {
  const message = '문서가 너무 큽니다. 일부를 다른 문서로 옮겨 주세요.'
  const capture = captureFetch(() => new Response(
    JSON.stringify({ error: { code: 'WIKI_DOCUMENT_TOO_LARGE', message } }),
    { status: 413, headers: { 'content-type': 'application/json' } },
  ))
  try {
    const events = []
    const queue = buildQueue(events)
    queue.push(newUpdateOp('BLK-A', 0, { text: '너무 긴 본문' }))
    await queue.flush()
    assert.deepEqual(
      events.at(-1), ['error', message],
      `같은 사실('문서가 너무 큽니다')이 화면 두 곳에서 서로 다른 처방을 말한다: ${JSON.stringify(events)}`,
    )
    assert.equal(queue.size(), 0, '413은 재시도하지 않는다 — 같은 조각은 다음에도 같은 이유로 거절당한다')
    assert.equal(capture.sent.length, 1, '413을 받고 다시 보냈다')
  } finally { capture.restore() }
})

// ── 3회차 검증에서 잡힌 것 ─────────────────────────────────────────────────
/**
 * 진짜 서버 한 대를 흉내 낸다 — 블록마다 seq를 들고, `baseSeq < seq`면 "누가 먼저 고쳤다"를 한 줄 남긴다.
 * (서버 `wiki-merge.mjs`의 overwrites 판정 그대로다: `const baseSeq = op.kind === 'update' ? op.baseSeq : 0`.)
 */
function fakeWikiServer({ me = 'USR-ME' } = {}) {
  const blocks = new Map()
  const overwrites = []
  let seq = 0
  let version = 1
  return {
    overwrites,
    seed(id, editedById = me) { seq += 1; blocks.set(id, { id, type: 'text', text: '', seq, editedById }); return seq },
    seqOf(id) { return blocks.get(id)?.seq ?? null },
    /** 남이 그 문단을 고친다 — 내 큐를 지나지 않는다. */
    foreignEdit(id, byId) { seq += 1; blocks.set(id, { ...blocks.get(id), seq, editedById: byId }) },
    handle(body) {
      const applied = []
      for (const op of body.ops ?? []) {
        const id = op.kind === 'insert' ? op.block.id : op.blockId
        const before = blocks.get(id) ?? null
        if (before && (op.kind === 'update' ? op.baseSeq : 0) < before.seq) {
          overwrites.push({ blockId: id, previousBy: before.editedById, baseSeq: op.baseSeq ?? null, seq: before.seq })
        }
        seq += 1
        blocks.set(id, { id, type: 'text', text: String(op.block?.text ?? before?.text ?? ''), seq, editedById: me })
        applied.push(op.opId)
      }
      version += 1
      return {
        document: { id: 'WDOC-QUEUE', version, title: '', blocks: [...blocks.values()] },
        version, applied, rejected: [], overwrites: [], lostEditCount: 0, presence: [],
      }
    },
  }
}

test('비행 중인 내 배치가 올릴 seq를 기준선이 안다 — 아무도 건드리지 않은 문단에 내 이름으로 안내가 뜨지 않는다', async () => {
  const server = fakeWikiServer()
  const staleSeq = server.seed('BLK-A')
  let capture
  capture = captureFetch(() => new Response(
    JSON.stringify(server.handle(capture.sent.at(-1).body)),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ))
  try {
    const queue = createWikiOpQueue({
      documentId: 'WDOC-QUEUE', clientId: 'WCL-TEST', accountId: 'USR-ME',
      headers: () => ({ 'content-type': 'application/json' }),
      handlers: { onStatus: () => {}, onApplied: () => {}, onPending: () => {} },
      setTimeoutFn: setTimeout, clearTimeoutFn: clearTimeout,
    })

    // ① 사람이 치는 동안 디바운스가 한 번 나간다.
    queue.push(newUpdateOp('BLK-A', staleSeq, { text: '첫 문장' }))
    await queue.flush()
    // ② 응답이 오기 전에 만들어진 조각은 **화면의 낡은 seq**를 들고 있다(구조 변경의 onFlushBefore도 같다).
    queue.push(newUpdateOp('BLK-A', staleSeq, { text: '첫 문장 이어서' }))
    await queue.flush()

    assert.deepEqual(
      server.overwrites, [],
      `내가 방금 올린 편집이 나를 밀어낸 것으로 기록됐다(이력에 가짜 '밀린 문장'이 남는다): ${JSON.stringify(server.overwrites)}`,
    )
    assert.equal(capture.sent.length, 2)
    assert.equal(capture.sent[1].body.ops[0].baseSeq, server.seqOf('BLK-A') - 1, '두 번째 조각의 기준선이 내 첫 조각이 올린 seq여야 한다')

    // ③ 남이 진짜로 먼저 고쳤을 때는 안내가 그대로 나온다 — 신호를 죽이지 않았는지 잰다.
    server.foreignEdit('BLK-A', 'USR-OTHER')
    queue.push(newUpdateOp('BLK-A', staleSeq, { text: '남이 고친 뒤 내 문장' }))
    await queue.flush()
    assert.equal(server.overwrites.length, 1, '진짜 충돌이 조용해졌다')
    assert.equal(server.overwrites[0].previousBy, 'USR-OTHER')
  } finally { capture.restore() }
})

test('막 만든 문단에 이어 친 글도 내 것이다 — 삽입이 받은 seq가 다음 조각의 기준선이 된다', async () => {
  const server = fakeWikiServer()
  let capture
  capture = captureFetch(() => new Response(
    JSON.stringify(server.handle(capture.sent.at(-1).body)),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ))
  try {
    const queue = createWikiOpQueue({
      documentId: 'WDOC-QUEUE', clientId: 'WCL-TEST', accountId: 'USR-ME',
      headers: () => ({ 'content-type': 'application/json' }),
      handlers: { onStatus: () => {}, onApplied: () => {}, onPending: () => {} },
      setTimeoutFn: setTimeout, clearTimeoutFn: clearTimeout,
    })
    // Enter로 문단을 만들고 곧바로 내보낸다(구조를 바꾸는 편집의 onFlushBefore).
    queue.push(newInsertOp({ id: 'BLK-NEW', type: 'text', text: '' }, null))
    await queue.flush()
    // 새 문단에는 아직 seq가 없다 — 화면이 그대로 만들면 기준선이 0이다.
    queue.push(newUpdateOp('BLK-NEW', 0, { text: '방금 만든 문단에 쓴다' }))
    await queue.flush()
    assert.deepEqual(server.overwrites, [], `내가 만든 문단이 나를 밀어냈다고 기록됐다: ${JSON.stringify(server.overwrites)}`)
  } finally { capture.restore() }
})

test('되돌릴 수 없는 4xx는 보낸 배치만 버린다 — 서버를 본 적 없는 조각까지 지우지 않는다', async () => {
  const capture = captureFetch(() => new Response(
    JSON.stringify({ error: { code: 'WIKI_LINK_FORBIDDEN', message: '연결한 대상을 찾을 수 없거나 열람 권한이 없습니다.' } }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  ))
  try {
    const events = []
    const queue = buildQueue(events)
    // 한 배치 상한(50)보다 여섯 개 많이 쌓는다. 여섯은 이 요청에 실리지도 않았다.
    const ops = []
    for (let index = 0; index < 56; index += 1) ops.push(newUpdateOp(`BLK-${index}`, 0, { text: `문장 ${index}` }))
    queue.push(...ops)   // 큐 상한(20)을 넘기므로 push가 곧바로 첫 배치를 내보낸다
    await new Promise((resolve) => { setTimeout(resolve, 5) })

    assert.equal(queue.size(), 6, '보내지도 않은 조각이 함께 버려졌다 — 낙관 반영된 문단이 눈앞에서 지워진다')
    assert.equal(capture.sent[0].body.ops.length, 50)
    const [status, detail] = events.at(-1)
    assert.equal(status, 'error')
    assert.match(detail, /6건/, `남은 건수를 말하지 않으면 사람은 무엇을 잃었는지 모른다: ${detail}`)

    // '다시 저장'을 누르면 남은 조각이 실제로 나간다.
    await queue.flush()
    assert.equal(capture.sent.length, 2)
    assert.equal(capture.sent[1].body.ops.length, 6)
  } finally { capture.restore() }
})

test('내 seq 표는 순수 함수로 잰다 — 적용된 조각·마지막 편집자 둘 다 맞을 때만 기억한다', () => {
  const result = {
    document: {
      id: 'WDOC-1', version: 3, title: '', blocks: [
        { id: 'BLK-A', type: 'text', text: 'a', seq: 9, editedById: 'USR-ME' },
        { id: 'BLK-B', type: 'text', text: 'b', seq: 10, editedById: 'USR-OTHER' },
      ],
    },
    version: 3, applied: ['OP-1'], rejected: [], overwrites: [], lostEditCount: 0, presence: [],
  }
  const batch = [
    { opId: 'OP-1', kind: 'update', blockId: 'BLK-A', baseSeq: 4, block: { text: 'a' } },
    { opId: 'OP-2', kind: 'update', blockId: 'BLK-B', baseSeq: 4, block: { text: 'b' } },
  ]
  const own = ownSeqsFrom(batch, result, 'USR-ME')
  assert.deepEqual([...own], [['BLK-A', 9]], '거절된 조각이나 남이 마지막으로 고친 블록까지 내 것으로 세면 안 된다')
  assert.equal(ownSeqsFrom(batch, result, '').size, 0, '내가 누구인지 모르면 아무것도 내 것이 아니다')

  const raised = withOwnBaseSeq(batch, own)
  assert.equal(raised[0].baseSeq, 9)
  assert.equal(raised[1].baseSeq, 4, '남이 올린 seq로는 기준선을 끌어올리지 않는다')
  assert.deepEqual(
    withOwnBaseSeq([{ opId: 'OP-3', kind: 'delete', blockId: 'BLK-A' }], own),
    [{ opId: 'OP-3', kind: 'delete', blockId: 'BLK-A' }],
    'update가 아닌 조각에는 기준선이 없다',
  )
  assert.equal(withOwnBaseSeq(batch, new Map([['BLK-A', 2]]))[0].baseSeq, 4, '내 seq가 더 낮으면 기준선을 내리지 않는다')
})

test('지워진 문단의 안내는 문단 목록 밖에서 사람에게 닿는다 — 붙을 자리가 없다고 문장을 버리지 않는다', () => {
  const rejection = { opId: 'OP-1', blockId: 'BLK-GONE', code: 'BLOCK_DELETED' }
  const notice = rejectionNotice(rejection, 7)
  assert.ok(notice, '서버가 갈래를 말했는데 화면이 할 말을 못 골랐다')
  const notices = new Map([[rejection.blockId, notice]])

  // 같은 응답의 문서에는 그 문단이 이미 없다 — 화면이 실제로 쓰는 갱신 함수로 그 사실을 만든다.
  const drawn = mergeServerBlocks(
    [{ id: 'BLK-GONE', type: 'text', text: '사람이 방금 친 문장' }],
    [{ id: 'BLK-A', type: 'text', text: '' }],
    {},
  )
  assert.equal(drawn.some((block) => block.id === 'BLK-GONE'), false, '이 시험의 전제: 그 문단은 목록에 없다')
  assert.deepEqual(
    orphanNotices(notices, drawn), [{ blockId: 'BLK-GONE', notice }],
    '안내가 붙을 문단이 사라지면 그 문장은 어디에도 그려지지 않는다',
  )
  assert.deepEqual(orphanNotices(notices, [{ id: 'BLK-GONE' }]), [], '문단이 살아 있으면 목록 밖으로 올리지 않는다')
})

test('서버가 이력에도 싣지 못했다고 답하면 화면 문장도 달라진다 — 없는 이력을 가리키지 않는다', () => {
  const kept = rejectionNotice({ opId: 'OP-1', blockId: 'BLK-A', code: 'BLOCK_DELETED' }, 7)
  const dropped = rejectionNotice({ opId: 'OP-2', blockId: 'BLK-A', code: 'BLOCK_DELETED', lostTextDropped: true }, 7)
  assert.match(kept.message, /이력에 있습니다/)
  assert.equal(kept.version, 7, '이력에 있으면 그리로 가는 길을 준다')
  assert.equal(
    /이력에 있습니다/.test(dropped.message), false,
    `이력에도 싣지 못한 문장을 '이력에 있습니다'라고 말한다 — 그 문장은 어디에도 없다: ${dropped.message}`,
  )
  assert.equal(dropped.version, null, '가서 볼 이력이 없으므로 이력으로 가는 길도 주지 않는다')
  assert.equal(dropped.code, 'dropped')
  assert.equal(rejectionNotice({ opId: 'OP-3', blockId: 'BLK-A', code: 'WHAT_IS_THIS' }, 7), null, '모르는 갈래에는 문장을 지어내지 않는다')
})

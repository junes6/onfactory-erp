import {
  BLOCK_ID_RE, MAX_ANY_BLOCK_TEXT, MAX_BLOCKS_PER_DOCUMENT, MAX_DOCUMENT_TEXT, MAX_RECENT_OP_IDS, MAX_TOMBSTONES, OP_ID_RE,
  WIKI_BLOCK_TOO_LONG_FOR_TYPE,
  applyPatch, buildSearchText, documentTextLength, newBlockId as defaultNewBlockId, sameBlockContent, validateNewBlock,
} from './wiki-blocks.mjs'
// 밀린 문장의 배치 총량 상한만 이력 쪽에서 가져온다 — 그 숫자의 근거가 리비전 예산이기 때문이다.
// 여기 손으로 옮겨 적으면 예산이 바뀌는 날 한쪽만 낡는다.
import { MAX_LOST_TEXT_PER_BATCH } from './wiki-revisions.mjs'

/**
 * 문서 병합 — 같은 블록을 동시에 고쳐도 진 글이 사라지지 않는다.
 *
 * 이 파일이 지키는 다섯 계약:
 *  1. 같은 블록을 건드리지 않는 **수정**은 도착 순서와 무관하다 — 순서를 뒤집어도 최종 문서가 같다.
 *     (삽입은 다르다: 같은 앵커 뒤로 들어오는 두 삽입은 **나중에 도착한 쪽이 앵커에 더 가깝다**.
 *      순서 자체가 결정적이려면 블록마다 자기 앵커를 들고 다녀야 하고, 그것은 저장 모양을 바꾸는 일이다.
 *      대신 어느 순서든 두 삽입이 **모두 살아남는다** — 잃어버리는 글자는 없다. `resolveAnchor` 위 주석 참고.)
 *  2. 같은 블록은 한 값으로 모이고, 밀린 문장은 `overwrites`로 이력에 실린다.
 *  3. ops는 낡았다는 이유로 거절하지 않는다. `baseVersion`은 거절 근거가 아니라 충돌 판정 기준선이다.
 *  4. 되돌리기는 이력을 다시 쓰지 않는다(그 일은 `wiki-revisions.mjs`가 새 버전으로 한다).
 *  5. 볼 수 없는 것의 이름은 어떤 경로로도 나가지 않는다(그 일은 `wiki-blocks.mjs`의 redactLinks가 한다).
 *
 * **순수·동기다.** 라우트는 이 함수 호출 전후에 `await`를 두지 않는다 — 그래서 읽기→병합→대입 구간이
 * 원자적이고, 두 요청 사이에 잃어버린 갱신이 구조적으로 생기지 않는다. 입력 배열은 변형하지 않는다.
 *
 * 배치 op 개수 상한은 여기서 보지 않는다 — 라우트가 요청 본문에 대해 1..50으로 막고, 복원은 문서 전체를
 * 한 배치로 밀어 넣기 때문에 그 상한 밖이다. 여기서 막으면 복원이 문서 크기에 따라 실패한다.
 */

export const WIKI_OPS_INVALID = 'WIKI_OPS_INVALID'
export const WIKI_BLOCK_INVALID = 'WIKI_BLOCK_INVALID'
export const WIKI_BLOCK_LIMIT = 'WIKI_BLOCK_LIMIT'
export const WIKI_DOCUMENT_TOO_LARGE = 'WIKI_DOCUMENT_TOO_LARGE'

export const OP_KINDS = Object.freeze(['insert', 'update', 'delete', 'move'])
/** 거절 사유. 화면이 그대로 문구로 바꾸므로 이름이 바뀌면 안 된다. */
export const REJECT_CODES = Object.freeze({
  BLOCK_DELETED: 'BLOCK_DELETED',
  /** 남이 먼저 그 블록의 타입을 바꿨다 — 낡은 op 하나만 거절하고 배치의 나머지는 살린다. */
  BLOCK_SHAPE_CHANGED: 'BLOCK_SHAPE_CHANGED',
  /**
   * 본문이 **지금(또는 바꾸려는) 타입에서만** 너무 길다 — 다른 타입에서는 적법한 길이다.
   * 모양이 바뀐 것과 갈라 두는 이유: 화면이 "제목은 200자까지입니다"라고 정확히 말할 수 있어야 한다.
   */
  BLOCK_TOO_LONG_FOR_TYPE: 'BLOCK_TOO_LONG_FOR_TYPE',
  INVALID_ANCHOR: 'INVALID_ANCHOR',
  BLOCK_ORDER_CORRUPT: 'BLOCK_ORDER_CORRUPT',
})

/**
 * 블록 두 개의 전순서(total order). 정상 경로에서는 첫 축만으로 결정되고
 * "나중에 서버에 도착한 쪽이 이긴다"로 붕괴한다.
 *
 * seq는 서버가 `++blockSeq`로만 발급한다(클라이언트가 보낸 seq는 400으로 거절된다) — 클라 시계로
 * 순서를 오염시킬 수 없다. 나머지 두 축은 (a) 복원이 옛 블록을 되살릴 때, (b) 백업 복구·JSON 손상으로
 * seq가 겹칠 때 비교가 총순서로 남게 하는 안전장치다.
 */
export function blockWins(a, b) {
  const aSeq = Number(a?.seq ?? 0)
  const bSeq = Number(b?.seq ?? 0)
  if (aSeq !== bSeq) return aSeq > bSeq
  const aAt = String(a?.editedAt ?? '')
  const bAt = String(b?.editedAt ?? '')
  if (aAt !== bAt) return aAt > bAt
  return String(a?.editedById ?? '') > String(b?.editedById ?? '')
}

/**
 * 삭제된 앵커를 따라간다 — "지워진 문단 뒤에 쓰던 글"이 문서 끝으로 순간이동하지 않게.
 * 반환은 삽입 기준 인덱스이고 -1은 맨 앞이다. `seen`이 순환을 끊는다(손상 데이터에서도 무한루프 없음).
 */
export function resolveAnchor(blocks, tombstones, afterId) {
  if (afterId === null || afterId === undefined) return -1
  const direct = blocks.findIndex((block) => block?.id === afterId)
  if (direct >= 0) return direct
  const seen = new Set()
  let cursor = afterId
  while (cursor !== null && cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor)
    const tomb = (tombstones ?? []).find((entry) => entry?.id === cursor)
    if (!tomb) return blocks.length - 1
    cursor = tomb.after ?? null
    if (cursor === null) return -1
    const found = blocks.findIndex((block) => block?.id === cursor)
    if (found >= 0) return found
  }
  return blocks.length - 1
}

/** 서버 소유 필드를 찍는다. 이 셋은 클라이언트가 보낼 수 없다. */
const stamp = (block, seq, context) => ({ ...block, seq, editedById: context.actorId, editedAt: context.now })

const pushUnique = (list, id) => { if (!list.includes(id)) list.push(id) }

/**
 * `mergeOps(document, ops, { actorId, actorName, now, nameOf?, newBlockId?, restore? })`
 *  → `{ document, applied, rejected, overwrites, lostEdits, changed, inverse, changedCount, versionBumped }`
 *  또는 배치 전체 거절 시 `{ error, ... }`.
 *
 * `now`·`actorId`는 필수다. 기본값을 두면 주입을 잊은 자리가 조용히 벽시계를 읽고, 그 테스트는 밤에만 깨진다.
 *
 * **라우트가 읽는 두 신호.** `document !== 입력 문서`면 그 행을 저장한다. `versionBumped`가 참일 때만
 * 리비전 한 줄을 만들고 SSE를 발행한다 — 변화 없는 배치가 멱등 창만 갱신하는 갈래가 있기 때문이다.
 * `changedCount === 0`이면 보통 입력 문서를 **참조 그대로** 돌려준다(재전송이 버전을 태우지 않는다).
 * 예외 둘: 밀린 문장(`lostEdits`)은 리비전이 필요하므로 버전을 올리고, '적용됨'으로 답한 opId는
 * 버전 없이 멱등 창에만 실린다.
 */
export function mergeOps(document, ops, context) {
  if (!context || typeof context.actorId !== 'string' || typeof context.now !== 'string') {
    throw new TypeError('mergeOps: actorId와 now(ISO 문자열)는 필수 인자입니다.')
  }
  if (!Array.isArray(ops)) return { error: WIKI_OPS_INVALID, reason: 'ops' }
  const actor = { actorId: context.actorId, actorName: String(context.actorName ?? ''), now: context.now }
  const makeBlockId = typeof context.newBlockId === 'function' ? context.newBlockId : defaultNewBlockId
  // 블록에는 편집자 id만 남는다(이름을 블록마다 복사하면 개명이 문서 전체를 낡게 만든다).
  // 이력에 사람 이름을 적어야 하는 자리에서만 계정 목록을 주입받아 푼다.
  const nameOf = typeof context.nameOf === 'function' ? context.nameOf : () => ''
  // 복원 문맥인가. 라우트가 세우고 요청 본문은 절대 세울 수 없다 — 세울 수 있으면 클라이언트가
  // 업무 역링크를 스스로 심어 승인 큐를 우회한다. 기본값은 '아니오'다.
  const restoring = context.restore === true

  const next = [...(document.blocks ?? [])]
  const tombs = [...(document.tombstones ?? [])]
  const recent = new Set(document.recentOpIds ?? [])
  // 거절됐지만 **쓰던 문장은 이력에 실은** opId. `recentOpIds`와 섞으면 재전송이 '적용됨'으로 답해
  // 클라이언트가 큐에서 지워버린다(D3) — 그래서 창이 두 개다. 여기 있는 op은 재전송돼도
  // 다시 거절로 답하되 같은 문장을 이력에 두 번 싣지 않는다.
  const recentLost = new Set(document.recentLostOpIds ?? [])
  let seq = Number(document.blockSeq ?? 0)

  const applied = []
  const rejected = []
  const overwrites = []
  const lostEdits = []
  const lostOpIds = []
  const inverse = []
  const changed = { inserted: [], updated: [], deleted: [], moved: [] }

  const indexOf = (blockId) => next.findIndex((block) => block?.id === blockId)

  // 이 배치가 지금까지 이력에 실은 밀린 문장의 총 글자 수. 상한의 근거는 `MAX_LOST_TEXT_PER_BATCH` 주석에 있다.
  let lostChars = 0

  /**
   * 거절된 op이 들고 있던 문장을 이력에 싣는다(§4-1 원칙 3). `recentLost`가 재전송에서 같은 문장을
   * 두 번 싣는 것을 막는다 — 거절된 op을 `recentOpIds`에 넣으면 재전송이 '적용됨'으로 답한다(D3).
   *
   * 배치 합계가 상한을 넘으면 **자르지 않고 싣지 않는다**: 자른 문장은 어디에도 남지 않지만(D17),
   * 싣지 않은 문장은 거절된 op과 함께 아직 클라이언트 큐에 있다. 그 사실을 돌려주어(`true`) 거절 줄이
   * "이력에 있습니다"라고 거짓말하지 않게 한다. 이 상한이 없으면 배치 한 번이 리비전 예산의 절반을 먹고
   * 그 한 줄이 문서의 이력 전체를 축출한다.
   */
  const archiveLostText = (op, blockId) => {
    if (typeof op.block?.text !== 'string' || recentLost.has(op.opId)) return false
    if (lostChars + op.block.text.length > MAX_LOST_TEXT_PER_BATCH) return true
    lostChars += op.block.text.length
    lostEdits.push({ blockId: blockId ?? null, text: op.block.text, by: actor.actorId, byName: actor.actorName })
    lostOpIds.push(op.opId)
    return false
  }

  /** 거절 한 줄 + 밀린 문장 보관을 한 자리에서 한다 — 둘이 갈라지면 "이력에 있다"는 문장이 사실과 어긋난다. */
  const rejectOp = (op, blockId, code) => {
    const dropped = archiveLostText(op, blockId)
    rejected.push(dropped
      ? { opId: op.opId, blockId: blockId ?? null, code, lostTextDropped: true }
      : { opId: op.opId, blockId: blockId ?? null, code })
  }

  for (const op of ops) {
    if (!op || typeof op !== 'object' || typeof op.opId !== 'string' || !OP_ID_RE.test(op.opId)) {
      return { error: WIKI_OPS_INVALID, reason: 'opId' }
    }
    if (!OP_KINDS.includes(op.kind)) return { error: WIKI_OPS_INVALID, reason: 'kind', opId: op.opId }
    if (op.kind !== 'insert' && (typeof op.blockId !== 'string' || !BLOCK_ID_RE.test(op.blockId))) {
      return { error: WIKI_OPS_INVALID, reason: 'blockId', opId: op.opId }
    }
    if (op.kind === 'insert' || op.kind === 'move') {
      const after = op.after ?? null
      if (after !== null && (typeof after !== 'string' || !BLOCK_ID_RE.test(after))) {
        return { error: WIKI_OPS_INVALID, reason: 'after', opId: op.opId }
      }
    }
    // 본문 길이는 **목적지와 무관하게** 여기서 한 번 본다. 아래로 내려가면 '지워진 블록에 대한 수정'과
    // '남이 모양을 바꾼 블록에 대한 수정'은 applyPatch를 지나지 않고 곧장 이력(lostEdits)으로 가므로
    // 어떤 상한도 만나지 못한다 — 그 한 줄이 이력 예산(2_000_000자)을 혼자 넘겨 그 문서의 이력을
    // 통째로 밀어낸다. 어떤 타입에도 얹힐 수 없는 길이는 목적지가 무엇이든 클라이언트 버그다.
    if (typeof op.block?.text === 'string' && op.block.text.length > MAX_ANY_BLOCK_TEXT) {
      return { error: WIKI_BLOCK_INVALID, blockId: op.blockId ?? op.block?.id ?? null, field: 'text' }
    }
    // C7 재전송 멱등 — 여기 있는 것은 '실제로 적용된' opId뿐이다(거절된 것은 들어오지 않는다).
    if (recent.has(op.opId)) { applied.push(op.opId); continue }

    let kind = op.kind
    if (kind === 'insert' && indexOf(op.block?.id) >= 0) kind = 'update'   // C5 재시도 안전: 같은 id의 삽입은 수정이다

    if (kind === 'insert') {
      if (next.length >= MAX_BLOCKS_PER_DOCUMENT) return { error: WIKI_BLOCK_LIMIT }
      const validated = validateNewBlock(op.block)
      if (!validated.ok) return { error: validated.code ?? WIKI_BLOCK_INVALID, blockId: op.block?.id ?? null, field: validated.field }
      const block = stamp(validated.block, seq += 1, actor)
      // 업무 역링크는 서버 소유라 `block`에 실려 올 수 없다(실으면 400이다) — 승인 큐를 우회할 길이 없다.
      // 그런데 복원은 **서버가 내는 ops**이고, 지웠던 블록을 되살릴 때 이 링크까지 끊으면 승인 큐가
      // 가리키던 자리가 사라진다(applyPatch가 205행에서 굳이 지키는 그 링크다). 복원 문맥에서만,
      // 그리고 요청 본문이 아니라 라우트가 세우는 `context.restore`가 참일 때만 되살린다(규칙 7).
      if (restoring && typeof op.restoreWorkItemId === 'string' && op.restoreWorkItemId) {
        block.workItemId = op.restoreWorkItemId
      }
      // 언제나 앵커 **바로 뒤**다. 같은 앵커 뒤로 두 사람이 동시에 삽입하면 나중에 도착한 쪽이 앵커에
      // 더 가깝고, 순서는 도착 순서에 달린다(계약 1이 수정에 대해서만 성립한다고 말하는 이유다).
      // 그 순서까지 결정적으로 만들려면 블록마다 자기 앵커를 들고 다녀야 한다 — 저장 모양을 바꾸는 일이고,
      // 얻는 것은 "둘 중 누가 위인가"뿐이다. 어느 순서든 두 삽입이 모두 살아남으므로 글자는 잃지 않는다.
      const at = resolveAnchor(next, tombs, op.after ?? null)
      next.splice(at + 1, 0, block)
      inverse.unshift({ kind: 'delete', blockId: block.id })
      pushUnique(changed.inserted, block.id)
      applied.push(op.opId)
      continue
    }

    if (kind === 'update') {
      const blockId = op.kind === 'insert' ? op.block?.id : op.blockId
      // D4: 강등된 삽입에는 baseSeq가 없다(있을 수 없다). 클라이언트가 보낸 진짜 update에만 요구한다.
      //
      // 상한도 함께 본다. `seq`는 이 문서에 대해 **서버가 지금까지 낸 가장 큰 seq**이므로 그보다 큰
      // baseSeq는 서버가 낸 적 없는 값이다 — baseVersion의 `WIKI_BASE_VERSION_AHEAD`와 같은 태도다(계약 3).
      // 막지 않으면 "…님이 먼저 고쳤습니다"를 알리는 유일한 경로(:228 overwrites)가 조용히 꺼진다:
      // 아래 판정이 `baseSeq < before.seq` 하나뿐이라 baseSeq를 키우면 절대 참이 되지 않는다. 현실적
      // 오작동은 클라이언트가 `block.seq` 대신 `document.blockSeq`를 실어 보내는 흔한 혼동이고,
      // 그러면 모든 사용자에게서 그 알림이 영구히 사라진다.
      if (op.kind === 'update' && (!Number.isInteger(op.baseSeq) || op.baseSeq < 0 || op.baseSeq > seq)) {
        return { error: WIKI_OPS_INVALID, reason: 'baseSeq', opId: op.opId }
      }
      const at = indexOf(blockId)
      if (at < 0) {
        // C2 삭제가 이긴다. 되살리지 않는 이유: 맥락 없이 부활한 블록은 "지웠는데 다시 생겼다"를 만들고,
        // 그러면 삭제라는 조작 자체를 믿을 수 없게 된다. 대신 쓰던 문장을 이력에 싣는다.
        rejectOp(op, blockId, REJECT_CODES.BLOCK_DELETED)
        continue
      }
      const before = next[at]
      // `?? {}`를 두면 block 없는 update가 통과해, 본문은 그대로인 채 버전과 "남이 먼저 고쳤습니다"를
      // 만들어낸다 — 일어나지 않은 일을 이력과 화면이 함께 말하게 된다. 모양 검사는 applyPatch 한 벌뿐이다.
      const patched = applyPatch(before, op.block)
      if (!patched.ok && !patched.staleShape) {
        // 클라이언트가 보낸 모양 자체가 틀렸다(미지 키·서버 소유 필드·길이·값). 그것만이 클라 버그다.
        return { error: patched.code ?? WIKI_BLOCK_INVALID, blockId: before.id, field: patched.field }
      }
      if (!patched.ok) {
        // 튕긴 이유가 클라이언트가 보낸 값이 아니라 이 블록의 지금 모양이다 — 남이 먼저 타입을 바꿨거나,
        // 이 op이 바꾸려는 타입의 본문 상한이 기존 본문보다 좁다(300자 문단 → 제목). 낡았다는 이유로
        // 배치 전체를 죽이지 않는다(계약 3): 되돌리면 같은 배치의 멀쩡한 편집까지 사라지고 재전송해도
        // 같은 400이라 사람이 쓴 글자가 돌아올 길이 영영 없다. 삭제 경로와 **같은 모양**으로 op 하나만 거절한다.
        // 사유를 둘로 갈라 주는 이유는 화면이 "제목은 200자까지입니다"라고 정확히 말할 수 있어야 해서다.
        rejectOp(op, before.id, patched.code === WIKI_BLOCK_TOO_LONG_FOR_TYPE
          ? REJECT_CODES.BLOCK_TOO_LONG_FOR_TYPE
          : REJECT_CODES.BLOCK_SHAPE_CHANGED)
        continue
      }
      // 어떤 필드도 실제로 바뀌지 않는 수정은 성공이되 변경이 아니다(D2와 같은 취지) —
      // 버전도, 리비전도, '밀어냈다'는 overwrites 한 줄도 만들지 않는다.
      if (sameBlockContent(before, patched.block)) { applied.push(op.opId); continue }
      const merged = stamp(patched.block, seq += 1, actor)
      if (!blockWins(merged, before)) {
        // 정상 경로에서는 도달할 수 없다(merged.seq는 언제나 ++seq). 손상 데이터 감지용 분기다.
        rejected.push({ opId: op.opId, blockId: before.id, code: REJECT_CODES.BLOCK_ORDER_CORRUPT })
        continue
      }
      // C3 남이 먼저 고쳤다 — 뒤가 이기되 앞의 원문을 통째로 이력에 남긴다.
      // 적용이 확정된 뒤에 적는다: 거절된 op의 '밀어냈다' 기록은 일어나지 않은 일을 이력에 남기는 것이다.
      //
      // 강등된 insert(C5)의 기준선은 0이다 — 그 op을 만든 클라이언트는 이 블록이 있다는 사실 자체를
      // 몰랐으므로 남의 글을 본 적이 없다. `op.kind === 'update'`로 좁혀 두면 "같은 블록을 …님이 먼저
      // 고쳤습니다"라는 **사람에게 알리는 유일한 경로**가 그 갈래에서만 조용히 꺼진다.
      // (내용이 같은 재시도는 위 sameBlockContent에서 이미 빠져나가므로 이 줄까지 오지 않는다.)
      const baseSeq = op.kind === 'update' ? op.baseSeq : 0
      if (baseSeq < Number(before.seq ?? 0)) {
        overwrites.push({
          blockId: before.id,
          previousText: typeof before.text === 'string' ? before.text : '',
          previousBy: String(before.editedById ?? ''),
          previousByName: String(nameOf(before.editedById) ?? ''),
          previousSeq: Number(before.seq ?? 0),
        })
      }
      next[at] = merged
      inverse.unshift({ kind: 'update', blockId: before.id, block: before })
      if (!changed.inserted.includes(before.id)) pushUnique(changed.updated, before.id)
      applied.push(op.opId)
      continue
    }

    if (kind === 'delete') {
      const at = indexOf(op.blockId)
      if (at < 0) { applied.push(op.opId); continue }        // C6 멱등: 이미 없는 것을 지우는 것은 성공이다
      const removed = next[at]
      const anchor = at > 0 ? next[at - 1].id : null
      tombs.unshift({ id: removed.id, after: anchor, at: actor.now })
      inverse.unshift({ kind: 'insert', block: removed, after: anchor })
      next.splice(at, 1)
      pushUnique(changed.deleted, removed.id)
      applied.push(op.opId)
      continue
    }

    // move — 순서 변경은 내용 변경이 아니므로 seq를 올리지 않는다.
    const at = indexOf(op.blockId)
    if (at < 0) { rejectOp(op, op.blockId, REJECT_CODES.BLOCK_DELETED); continue }
    if (op.after === op.blockId) { rejectOp(op, op.blockId, REJECT_CODES.INVALID_ANCHOR); continue }
    const from = at > 0 ? next[at - 1].id : null
    const [moved] = next.splice(at, 1)
    const to = resolveAnchor(next, tombs, op.after ?? null)
    if (to + 1 === at) {
      // 제자리 이동 — 배치가 실제로 바뀌지 않았다. update 쪽 sameBlockContent와 같은 규칙이다(§4-1 원칙 2):
      // 성공이되 변경이 아니므로 버전도, 리비전도, "문단 1개를 옮겼습니다"라는 일어나지 않은 문장도 만들지 않는다.
      next.splice(at, 0, moved)
      applied.push(op.opId)
      continue
    }
    next.splice(to + 1, 0, moved)
    inverse.unshift({ kind: 'move', blockId: moved.id, after: from })
    if (!changed.inserted.includes(moved.id)) pushUnique(changed.moved, moved.id)
    applied.push(op.opId)
  }

  // C8 문서는 언제나 블록 ≥1 — 빈 문서는 커서를 둘 곳이 없어 화면이 막다른 길이 된다.
  if (next.length === 0) {
    const filler = stamp({ id: makeBlockId(), type: 'text', text: '' }, seq += 1, actor)
    next.push(filler)
    inverse.unshift({ kind: 'delete', blockId: filler.id })
    pushUnique(changed.inserted, filler.id)
  }

  const changedCount = changed.inserted.length + changed.updated.length + changed.deleted.length + changed.moved.length

  // D2 아무것도 바뀌지 않았으면 버전·블록·검색 색인·리비전 전부 그대로다 — 재전송이 버전을 태우지 않는다.
  // 예외는 `lostEdits`뿐이다: 남이 지운 문단에 쓰던 문장은 리비전에만 남고, 리비전은 버전 없이 존재할 수 없다.
  // 여기서 빠져나가면 그 문장은 어디에도 실리지 않는다(§4-1 원칙 3). 재전송 멱등은 `recentLost`가 지킨다 —
  // 이미 이력에 실은 op은 위에서 lostEdits에 다시 담기지 않으므로 두 번째 배치는 이 문을 그대로 통과한다.
  //
  // 단 **멱등 창은 갱신한다**. 변화가 없어도 '적용됨'으로 답한 op(이미 없는 블록의 delete, 아무것도
  // 바꾸지 않는 update, 제자리 move)이 창에 남지 않으면 C7이 "그 사이 문서가 안 바뀌었을 때만" 성립한다:
  // 복원이 같은 블록 id를 되살린 뒤 오프라인 큐가 그 delete를 재전송하면, 처음에는 아무 일도 없던 op이
  // 이번에는 진짜로 지운다. 창 말고는 아무것도 건드리지 않으므로 D2가 약속한 '버전·리비전 불변'은 그대로다.
  if (changedCount === 0 && lostEdits.length === 0) {
    const recentOpIds = [...new Set([...applied, ...(document.recentOpIds ?? [])])].slice(0, MAX_RECENT_OP_IDS)
    const previous = document.recentOpIds ?? []
    const sameWindow = recentOpIds.length === previous.length && recentOpIds.every((id, index) => id === previous[index])
    // 창이 그대로면 입력 문서를 **참조 그대로** 돌려준다 — 라우트가 쓸 것이 없다는 뜻이 된다.
    return {
      document: sameWindow ? document : { ...document, recentOpIds },
      applied, rejected, overwrites, lostEdits, changed, inverse: [], changedCount: 0, versionBumped: false,
    }
  }

  // 상한은 '늘어나는 방향'에만 건다. 최종 길이만 보면 어쩌다 상한을 넘긴 문서는 지우는 배치조차 거절돼
  // 사람이 스스로 문서를 정상 범위로 되돌릴 수 없다.
  const nextLength = documentTextLength(next)
  if (nextLength > MAX_DOCUMENT_TEXT && nextLength > documentTextLength(document.blocks ?? [])) {
    return { error: WIKI_DOCUMENT_TOO_LARGE }
  }

  const merged = {
    ...document,
    blocks: next,
    blockSeq: seq,
    tombstones: tombs.slice(0, MAX_TOMBSTONES),
    // D3 실제로 들어간 opId만 — 거절된 op이 재전송 때 '적용됨'으로 답하면 사람이 쓴 글이 조용히 사라진다.
    // 중복을 걸러 넣는다: 재전송된 opId가 창을 다시 태우면 200칸이 같은 값으로 채워지고,
    // 밀려난 옛 opId가 재전송될 때 낡은 문장이 새 문장을 덮어쓴다(Set은 삽입 순서를 지키므로 FIFO는 그대로다).
    recentOpIds: [...new Set([...applied, ...(document.recentOpIds ?? [])])].slice(0, MAX_RECENT_OP_IDS),
    recentLostOpIds: [...new Set([...lostOpIds, ...(document.recentLostOpIds ?? [])])].slice(0, MAX_RECENT_OP_IDS),
    version: Number(document.version ?? 0) + 1,
    searchText: buildSearchText(next),
    lastEditedById: actor.actorId,
    lastEditedByName: actor.actorName,
    lastEditedAt: actor.now,
  }
  return { document: merged, applied, rejected, overwrites, lostEdits, changed, inverse, changedCount, versionBumped: true }
}

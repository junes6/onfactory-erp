// 확장자를 적는다 — 이 파일의 순수 함수는 `scripts/wiki-ops.test.mjs`가 node로 그대로 불러 시험한다
// (`src/utils/*.ts`가 이미 쓰는 관례다). 확장자가 없으면 node ESM이 해석하지 못해 시험 자체가 불가능하다.
import { clientBlockPayload, fieldsOf, newOpId, type WikiBlock } from './wikiBlocks.ts'

/**
 * 편집 큐.
 *
 * 문서 편집은 `PUT` 한 번으로 배열을 통째로 덮는 다른 화면들과 다르다. 두 사람이 같은 문서를 열고
 * 서로 다른 문단을 고치는 일이 정상이기 때문이다. 그래서 화면은 **바뀐 문단만** 조각(op)으로 보내고,
 * 서버가 병합한다.
 *
 * 이 파일이 지키는 약속 하나: **낡았다는 이유로 거절당하지 않는다.** 기준 버전(baseVersion)은
 * 거절 근거가 아니라 "누가 먼저 고쳤는가"를 가리는 기준선이다. 그래서 여기에는 편집 충돌을 뜻하는
 * 상태 코드를 다루는 갈래가 아예 없다 — 있으면 언젠가 사람이 방금 친 문장을 화면이 되돌린다.
 *
 * 큐는 어떤 실패에서도 버려지지 않는다. 보내지 못한 조각은 큐 앞으로 되돌아가고, 화면은 저장 상태를
 * '실패'로 바꾸고 '다시 저장'을 준다.
 */

export type WikiOp =
  | { opId: string; kind: 'insert'; block: WikiBlock; after: string | null }
  | { opId: string; kind: 'update'; blockId: string; baseSeq: number; block: Partial<WikiBlock> }
  | { opId: string; kind: 'delete'; blockId: string }
  | { opId: string; kind: 'move'; blockId: string; after: string | null }

export type WikiRejection = { opId: string; blockId: string | null; code: string; lostTextDropped?: boolean }
export type WikiOverwrite = { blockId: string; previousText: string; previousBy: string; previousByName: string; previousSeq: number }
export type WikiPresenceEntry = { accountId: string; name: string; blockId: string | null; at: string }

export type WikiOpsResponse = {
  document: { id: string; version: number; blocks: WikiBlock[]; title: string; [key: string]: unknown }
  version: number
  applied: string[]
  rejected: WikiRejection[]
  overwrites: WikiOverwrite[]
  lostEditCount: number
  presence: WikiPresenceEntry[]
}

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'dirty' | 'error'

/** 문단 하나에 붙는 안내 한 줄. `version`이 있으면 그 버전의 이력으로 갈 수 있다. */
export type WikiNotice = { code: 'overwrite' | 'deleted' | 'shape' | 'dropped'; message: string; version: number | null }

/**
 * 거절 한 건이 사람에게 할 말.
 *
 * **서버가 말한 사실과 화면 문장은 한 자리에서 짝을 이룬다.** 서버가 `lostTextDropped`로
 * "이 문장은 이력에 싣지 않았다"고 답했는데 화면이 그대로 "쓰던 내용은 이력에 있습니다"라고 하면,
 * 그 문장은 이력에도 없고 큐에도 없어 **어디에도 없는데** 사람만 있는 줄 안다. 처방도 달라진다 —
 * 이력에 있으면 가서 꺼내면 되고, 없으면 지금 나눠 다시 저장하는 수밖에 없다.
 */
export function rejectionNotice(rejection: WikiRejection, version: number | null): WikiNotice | null {
  if (rejection.lostTextDropped) {
    return { code: 'dropped', message: '한 번에 보낸 양이 너무 많아 이 문장은 이력에도 담기지 못했습니다. 문단을 나눠 다시 저장해 주세요.', version: null }
  }
  if (rejection.code === 'BLOCK_DELETED') {
    return { code: 'deleted', message: '다른 사람이 이 문단을 지웠습니다. 쓰던 내용은 이력에 있습니다.', version }
  }
  if (rejection.code === 'BLOCK_SHAPE_CHANGED') {
    return { code: 'shape', message: '다른 사람이 이 문단의 종류를 바꿨습니다. 쓰던 내용은 이력에 있습니다.', version }
  }
  if (rejection.code === 'BLOCK_TOO_LONG_FOR_TYPE') {
    return { code: 'shape', message: '이 종류의 문단에는 담을 수 없는 길이입니다. 문단을 나눠 주세요.', version: null }
  }
  return null
}

/**
 * 붙을 문단이 화면에 없는 안내들.
 *
 * `BLOCK_DELETED`는 **그 문단이 사라졌다는 사실 자체**가 거절 사유라, 같은 응답의 문서에는 그 문단이
 * 이미 없다. 안내를 blockId로만 찾아 그리면 그 문장은 어떤 경로로도 렌더되지 않고, 사람이 방금 친
 * 문장은 소리 없이 사라진다 — 아무 말도 없이. 그래서 목록 밖에서 한 번 더 그린다.
 */
export function orphanNotices<T>(notices: ReadonlyMap<string, T>, blocks: readonly { id: string }[]) {
  const present = new Set(blocks.map((block) => block.id))
  return [...notices].filter(([blockId]) => !present.has(blockId)).map(([blockId, notice]) => ({ blockId, notice }))
}

/** 저장 큐가 바깥에 알리는 것 전부. 화면은 이 셋만 보고 그린다. */
export type OpQueueHandlers = {
  onStatus: (status: SaveStatus, detail?: string) => void
  onApplied: (result: WikiOpsResponse) => void
  onPending: (blockIds: string[]) => void
}

export const OP_FLUSH_DEBOUNCE_MS = 700
export const OP_FLUSH_QUEUE_SIZE = 20
/** 한 요청에 실을 수 있는 조각 수. 서버 `MAX_OPS_PER_BATCH`와 같은 값이다. */
export const MAX_OPS_PER_BATCH = 50
/** 재시도 간격. 세 번 실패하면 사람에게 넘긴다 — 무한히 다시 보내면 화면은 조용한데 글은 안 올라간다. */
export const OP_RETRY_DELAYS_MS = [1_000, 3_000, 9_000] as const

/**
 * 서버가 준 값으로 이 블록을 덮어도 되는가.
 *
 * **조합 중이거나 포커스가 있는 블록은 절대 덮지 않는다.** 한글은 조합이 끝나기 전까지 글자가 완성되지
 * 않으므로, 그 순간 값을 갈아 끼우면 캐럿이 튀고 쓰던 음절이 깨진다. 아직 서버에 못 보낸 편집이 큐에
 * 남아 있는 블록도 마찬가지다 — 서버는 그 편집을 아직 모른다.
 *
 * 순수 함수로 빼 둔 이유: 이 판정이 틀리면 증상이 "가끔 한글이 깨진다"로만 나타나 화면에서 재현하기가
 * 어렵다. 값만 넣어 시험할 수 있어야 한다.
 */
export function canApplyServerDocument({ blockId, focusedBlockId = null, composing = false, pendingBlockIds = [] }: {
  blockId: string
  focusedBlockId?: string | null
  composing?: boolean
  pendingBlockIds?: readonly string[]
}) {
  if (!blockId) return true
  // 포커스가 있는 블록은 조합 중이 아니어도 덮지 않는다 — 사람이 지금 그 안에 캐럿을 두고 있다.
  if (blockId === focusedBlockId) return false
  // 조합 중인데 어느 블록인지 모르면 아무것도 덮지 않는다. 모를 때는 덜 하는 쪽이 안전하다.
  if (composing && focusedBlockId === null) return false
  return !pendingBlockIds.includes(blockId)
}

/**
 * 서버 문서를 로컬에 얹는다. 덮으면 안 되는 블록의 본문·표만 로컬 값을 지킨다 —
 * 타입·순서·삭제는 서버가 정한다(그것이 병합의 결과다).
 */
export function mergeServerBlocks(localBlocks: readonly WikiBlock[], serverBlocks: readonly WikiBlock[], guard: {
  focusedBlockId?: string | null
  composing?: boolean
  pendingBlockIds?: readonly string[]
}) {
  const localById = new Map(localBlocks.map((block) => [block.id, block]))
  return serverBlocks.map((block) => {
    const local = localById.get(block.id)
    if (!local) return block
    if (canApplyServerDocument({ blockId: block.id, ...guard })) return block
    // 판정이 '덮지 마라'면 **타입이 바뀌었더라도** 지금 치고 있는 글자는 그대로 둔다.
    // 여기에 `local.type === block.type` 같은 조건을 달면, 남이 그 문단의 종류를 바꾼 순간
    // 조합 중이던 한글이 서버 값으로 갈아 끼워진다 — 판정 함수는 옳은데 호출부가 판정을 무시하는 꼴이다.
    const kept: WikiBlock = { ...block }
    if (typeof local.text === 'string') kept.text = local.text
    if (Array.isArray(local.rows)) kept.rows = local.rows
    return kept
  })
}

/**
 * 접힌 수정 조각 하나. **종류가 바뀌는 접기에서는 옛 타입의 필드를 데리고 가지 않는다.**
 *
 * 얕은 병합만 하면 `{type:'code', language:''}` 뒤에 온 `{type:'text'}`가 `{type:'text', language:''}`가
 * 된다. 서버는 그 `language`를 '다른 타입에는 있는 필드'로 읽어 그 조각 하나를 `BLOCK_SHAPE_CHANGED`로
 * 거절하고(D22), 화면은 아무도 건드리지 않은 문단에 대고 "다른 사람이 종류를 바꿨습니다"라는 거짓말을
 * 한다. 규격표(`fieldsOf`)를 한 벌만 두고 그 표에 묻는다.
 */
function foldPatch(before: Partial<WikiBlock>, after: Partial<WikiBlock>): Partial<WikiBlock> {
  const merged = { ...before, ...after }
  if (!after.type || after.type === before.type) return merged
  const allowed = new Set<string>(fieldsOf(after.type) as readonly string[])
  const pruned: Record<string, unknown> = { type: after.type }
  for (const [key, value] of Object.entries(merged)) if (allowed.has(key)) pruned[key] = value
  return pruned as Partial<WikiBlock>
}

/** 큐에서 같은 블록을 연달아 건드리는 조각을 하나로 접는다. 접지 않으면 한 글자마다 op이 하나씩 쌓인다. */
export function coalesceOps(queue: readonly WikiOp[]) {
  const folded: WikiOp[] = []
  for (const op of queue) {
    const last = folded[folded.length - 1]
    if (op.kind === 'update' && last) {
      // 삽입 직후의 수정은 삽입 자체에 접는다 — 서버가 볼 때 그 블록은 처음부터 그 내용이었다.
      // 삽입은 완전한 블록이어야 하므로 규격표로 한 번 거른다(옛 타입의 필드를 남기면 배치 전체가 400이고,
      // 그 400은 재시도하지 않는 갈래라 그 배치의 편집이 통째로 사라진다).
      if (last.kind === 'insert' && last.block.id === op.blockId) {
        const next = { ...last.block, ...op.block, id: last.block.id }
        folded[folded.length - 1] = { ...last, block: clientBlockPayload(next) }
        continue
      }
      // 연속 수정은 최신 하나로. baseSeq는 **먼저 것**을 지킨다 — 사람이 실제로 보고 고치기 시작한 값이다.
      if (last.kind === 'update' && last.blockId === op.blockId) {
        folded[folded.length - 1] = { ...last, opId: op.opId, block: foldPatch(last.block, op.block) }
        continue
      }
    }
    folded.push(op)
  }
  return folded
}

/** 큐 안에서 손대고 있는 블록 id. 서버 값으로 덮으면 안 되는 자리를 화면에 알려 준다. */
export function pendingBlockIdsOf(queue: readonly WikiOp[]) {
  return [...new Set(queue.map((op) => (op.kind === 'insert' ? op.block.id : op.blockId)))]
}

const blockIdOf = (op: WikiOp) => (op.kind === 'insert' ? op.block.id : op.blockId)

/**
 * 방금 보낸 배치가 **내 이름으로** 올려 놓은 블록별 seq.
 *
 * 왜 필요한가: `baseSeq`는 "내가 보고 고치기 시작한 값"이고, 서버는 `baseSeq < 그 블록의 지금 seq`일 때
 * "누가 먼저 고쳤다"고 판정해 `overwrites` 한 줄을 이력에 남긴다. 그런데 화면이 든 `block.seq`는
 * **비행 중인 내 배치가 올릴 seq를 모른다** — 700ms 디바운스가 한 번 나가고 사람이 계속 타자하면,
 * 그 다음 조각은 응답이 오기 전까지 낡은 seq를 기준선으로 들고 나간다. 구조를 바꾸는 편집은 한술 더
 * 떠서 `onFlushBefore()`로 배치를 **일부러 먼저** 내보낸 뒤 같은 렌더의 낡은 seq로 조각을 만든다.
 * 그러면 아무도 건드리지 않은 문단에 자기 이름으로 "○○님이 이 문단을 먼저 고쳤습니다"가 뜨고,
 * 이력에는 일어나지 않은 '밀린 문장'이 영구히 남는다.
 *
 * 판정 규칙 한 줄: **이번 배치에 실렸고, 서버 문서에서 그 블록의 마지막 편집자가 나이면, 그 seq는 내가 올린 것이다.**
 * 남이 그 사이에 고쳤다면 `editedById`가 내가 아니므로 기준선은 그대로 낡아 있고, 그때는 안내가 옳다.
 */
export function ownSeqsFrom(batch: readonly WikiOp[], result: WikiOpsResponse, accountId: string): Map<string, number> {
  const own = new Map<string, number>()
  if (!accountId) return own
  const applied = new Set(result.applied ?? [])
  const byId = new Map((result.document?.blocks ?? []).map((block) => [block.id, block]))
  for (const op of batch) {
    if (!applied.has(op.opId)) continue
    const block = byId.get(blockIdOf(op))
    if (!block || block.editedById !== accountId) continue
    const seq = Number(block.seq)
    if (Number.isInteger(seq)) own.set(block.id, seq)
  }
  return own
}

/** 보낼 조각의 기준선을 **내가 이미 올려 둔 seq**까지 끌어올린다. 남이 올린 seq는 건드리지 않는다. */
export function withOwnBaseSeq(ops: readonly WikiOp[], own: ReadonlyMap<string, number>): WikiOp[] {
  return ops.map((op) => {
    if (op.kind !== 'update') return op
    const mine = own.get(op.blockId)
    return mine !== undefined && mine > op.baseSeq ? { ...op, baseSeq: mine } : op
  })
}

export const newUpdateOp = (blockId: string, baseSeq: number, block: Partial<WikiBlock>): WikiOp => (
  { opId: newOpId(), kind: 'update', blockId, baseSeq, block }
)
export const newInsertOp = (block: WikiBlock, after: string | null): WikiOp => (
  { opId: newOpId(), kind: 'insert', block, after }
)
export const newDeleteOp = (blockId: string): WikiOp => ({ opId: newOpId(), kind: 'delete', blockId })
export const newMoveOp = (blockId: string, after: string | null): WikiOp => ({ opId: newOpId(), kind: 'move', blockId, after })

/** 서버가 보내는 편집 오류 봉투. 코드가 있으면 화면이 그 자리에 맞는 문장을 고른다. */
type OpsError = { error?: { code?: string; message?: string; currentVersion?: number } }

export type WikiOpQueue = ReturnType<typeof createWikiOpQueue>

export function createWikiOpQueue({ documentId, clientId, accountId = '', headers, handlers, setTimeoutFn = window.setTimeout, clearTimeoutFn = window.clearTimeout }: {
  documentId: string
  clientId: string
  /** 지금 편집하는 사람의 계정 id. 서버가 돌려준 seq가 **내가 올린 것인지** 가리는 데만 쓴다. */
  accountId?: string
  headers: () => Record<string, string>
  handlers: OpQueueHandlers
  setTimeoutFn?: typeof window.setTimeout
  clearTimeoutFn?: typeof window.clearTimeout
}) {
  let queue: WikiOp[] = []
  let inFlight = false
  let attempt = 0
  let timer: number | null = null
  let baseVersion = 1
  let disposed = false
  /** 내가 올려 둔 블록별 seq. 서버 문서에 없는 블록은 매 응답에서 걷어 내 문서 크기 안에 묶어 둔다. */
  let ownSeq = new Map<string, number>()

  const url = `/api/wiki/${encodeURIComponent(documentId)}/ops`
  const announcePending = () => handlers.onPending(pendingBlockIdsOf(queue))

  const clearTimer = () => { if (timer !== null) { clearTimeoutFn(timer); timer = null } }

  const schedule = (delay = OP_FLUSH_DEBOUNCE_MS) => {
    clearTimer()
    if (disposed || !queue.length) return
    timer = setTimeoutFn(() => { timer = null; void flush() }, delay)
  }

  const bodyOf = (ops: WikiOp[]) => JSON.stringify({ baseVersion, ops, clientId })

  const failFatal = (message: string) => {
    // **방금 보낸 배치만** 버린다. 같은 조각을 다시 보내면 같은 이유로 또 거절당하고, 그 사이 사람은
    // "저장 중"만 보다가 창을 닫는다. 하지만 아직 보내지도 않은 조각까지 버리지는 않는다 —
    // 그 조각들은 서버를 본 적이 없고(같은 이유로 거절당한다는 근거가 없다), 이미 낙관 반영돼
    // 화면에 보이던 문단이라 여기서 비우면 다음 서버 문서 적용에서 눈앞에서 지워진다.
    // (`queue`는 이 시점에 이미 `folded.slice(batch.length)` — 미전송분만 남아 있다.)
    attempt = 0
    announcePending()
    const waiting = queue.length
    handlers.onStatus('error', waiting
      ? `${message} 아직 보내지 못한 편집 ${waiting}건이 남아 있습니다 · ‘다시 저장’을 눌러 주세요.`
      : message)
  }

  async function flush(): Promise<void> {
    clearTimer()
    if (disposed || inFlight || !queue.length) return
    const folded = withOwnBaseSeq(coalesceOps(queue), ownSeq)
    const batch = folded.slice(0, MAX_OPS_PER_BATCH)
    queue = folded.slice(batch.length)
    inFlight = true
    announcePending()
    handlers.onStatus('saving')
    let response: Response
    try {
      response = await fetch(url, { method: 'POST', headers: headers(), body: bodyOf(batch) })
    } catch {
      // 네트워크가 끊겼다. 조각을 큐 **앞으로** 되돌린다 — 순서가 뒤바뀌면 삽입 앵커가 어긋난다.
      inFlight = false
      queue = [...batch, ...queue]
      announcePending()
      attempt += 1
      const delay = OP_RETRY_DELAYS_MS[attempt - 1]
      if (delay === undefined) { attempt = 0; handlers.onStatus('error', '연결이 끊겨 저장하지 못했습니다. 다시 저장을 눌러 주세요.'); return }
      handlers.onStatus('dirty')
      schedule(delay)
      return
    }
    inFlight = false
    if (response.status === 413) {
      // 재시도하지 않는 것만 이 갈래의 몫이다(같은 조각은 다음에도 같은 이유로 거절당한다).
      // **문장은 서버가 정한다** — 여기서 따로 적으면 같은 사실이 화면 두 곳에서 서로 다른 처방을 말한다
      // (이력 서랍의 '되살리기'는 이미 서버 문장을 그대로 쓴다). 폴백은 body가 JSON이 아닐 때만 쓰이고,
      // `scripts/wiki-ui-contract.test.mjs`가 서버 문장과 한 글자까지 같은지 잠근다.
      const body = await response.json().catch(() => ({})) as OpsError
      failFatal(body.error?.message || '문서가 너무 큽니다. 일부를 다른 문서로 옮겨 주세요.')
      return
    }
    if (response.status >= 500) {
      // 서버가 저장에 실패한 것이라 같은 조각이 다음번에 들어갈 수 있다. 네트워크 실패와 같은 리듬으로 다시 보낸다.
      queue = [...batch, ...queue]
      announcePending()
      attempt += 1
      const delay = OP_RETRY_DELAYS_MS[attempt - 1]
      if (delay === undefined) { attempt = 0; handlers.onStatus('error', '서버가 편집 내용을 저장하지 못했습니다. 다시 저장을 눌러 주세요.'); return }
      handlers.onStatus('dirty')
      schedule(delay)
      return
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as OpsError
      failFatal(body.error?.message || '편집 내용을 저장하지 못했습니다.')
      return
    }
    const result = await response.json().catch(() => null) as WikiOpsResponse | null
    if (!result) { failFatal('저장 응답을 읽지 못했습니다. 다시 저장을 눌러 주세요.'); return }
    attempt = 0
    baseVersion = Number(result.version) || baseVersion
    // 이번 배치가 내 이름으로 올려 둔 seq를 기억한다. 서버 문서에서 사라진 블록은 함께 걷어 낸다.
    const alive = new Set((result.document?.blocks ?? []).map((block) => block.id))
    ownSeq = new Map([...ownSeq, ...ownSeqsFrom(batch, result, accountId)].filter(([id]) => alive.has(id)))
    announcePending()
    handlers.onApplied(result)
    handlers.onStatus(queue.length ? 'dirty' : 'saved')
    if (queue.length) schedule(0)
  }

  return {
    /** 서버가 준 버전으로 기준선을 맞춘다. 문서를 다시 읽을 때마다 부른다. */
    setBaseVersion(version: number) { if (Number.isInteger(version) && version >= 1) baseVersion = version },
    baseVersion() { return baseVersion },
    size() { return queue.length },
    pendingBlockIds() { return pendingBlockIdsOf(queue) },
    push(...ops: WikiOp[]) {
      if (disposed || !ops.length) return
      queue = coalesceOps([...queue, ...ops])
      announcePending()
      handlers.onStatus('dirty')
      if (queue.length >= OP_FLUSH_QUEUE_SIZE) { void flush(); return }
      schedule()
    },
    flush,
    /**
     * 탭을 닫거나 숨길 때의 마지막 한 번. 응답을 기다릴 수 없으므로 `keepalive: true`로 보내고
     * 큐는 그대로 둔다 — 정말 들어갔는지는 다음에 문서를 열 때 서버 버전이 말해 준다.
     */
    flushBeacon() {
      if (disposed || inFlight || !queue.length) return
      const batch = withOwnBaseSeq(coalesceOps(queue), ownSeq).slice(0, MAX_OPS_PER_BATCH)
      try {
        void fetch(url, { method: 'POST', headers: headers(), body: bodyOf(batch), keepalive: true })
      } catch { /* 닫히는 중이라 알릴 곳이 없다 */ }
    },
    dispose() { disposed = true; clearTimer() },
  }
}

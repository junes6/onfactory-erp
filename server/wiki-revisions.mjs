import { AI_LEVEL_LABELS } from './ai-policy.mjs'
import {
  TEXTUAL_TYPES, blockPayload, blockPreview, newOpId as defaultNewOpId, sameBlockContent,
} from './wiki-blocks.mjs'

/**
 * 개정 이력 · 복원 — 순수 모듈.
 *
 * 원칙 셋:
 *  1. **이력은 절대 다시 쓰지 않는다.** 되돌리기는 새 버전을 만드는 것이다. 그 사이 버전은 목록에 남는다.
 *  2. **실제로 바뀐 배치 하나 = 리비전 한 줄.** 메타데이터 변경도 버전을 올리고 한 줄을 남긴다 —
 *     그래야 복원이 제목·아이콘·부모까지 되살린다.
 *  3. **밀린 글자는 어디에도 버려지지 않는다.** `overwrites`(같은 블록 경쟁에서 진 텍스트)와
 *     `lostEdits`(거절된 수정 — 남이 지운 블록·남이 타입을 바꾼 블록에 쓰던 문장)가 그 버전에 실리고,
 *     `inverse`에 이전 블록 전체가 또 들어 있다.
 *
 * **역패치는 모든 리비전에 저장한다**(스냅샷 리비전에도). 그래서 되감기가 한 갈래로 끝나고, 오래된
 * 스냅샷을 잘라도 새 시점 복원이 깨지지 않는다. `snapshot XOR inverse`로 두면 스냅샷 아래로 못 내려간다.
 */

export const SNAPSHOT_EVERY = 20
export const SNAPSHOT_CHANGE_THRESHOLD = 10
export const MAX_REVISIONS_PER_DOCUMENT = 200
export const REVISION_BUDGET_CHARS = 2_000_000
export const REVISION_RETENTION_DAYS = 365
export const MAX_REVISION_ROWS_PER_TENANT = 20_000
/**
 * `overwrites`는 사람이 읽는 목록이다 — 한 배치에서 50건이 밀렸어도 앞 10건만 싣는다.
 * 잘려도 **이전 블록 전체가 `inverse`에 그대로** 있으므로 글자가 사라지지는 않는다.
 *
 * `lostEdits`에는 같은 상한을 걸지 않는다: 거절된 op이라 `inverse` 항목이 없어 대체 보관처가 아예 없고,
 * 자르는 순간 사람이 친 문장이 어디에도 남지 않는다(§4-1 원칙 3). 크기는 배치 op 수(라우트가 50으로 막는다)로
 * 묶이고, `revisionCost`가 그 무게를 세므로 예산 잘라내기는 정직하게 돌아간다.
 */
export const MAX_REVISION_DETAIL = 10
export const MAX_CHANGED_IDS = 50
export const MAX_REVISION_SUMMARY = 120

/**
 * 한 배치가 이력에 실을 수 있는 '밀린 문장'의 **총** 글자 수. `mergeOps`가 읽는다.
 *
 * 왜 총량인가: op 하나는 `MAX_ANY_BLOCK_TEXT`(20_000)로 막혀 있지만 한 배치는 50 op까지라(라우트 상한)
 * 합계가 1_000_000자, 곧 예산의 절반이 된다. 그런 리비전 한 줄이 아래 `pruneRevisions`의 FIFO를 통째로
 * 밀어내, 쓰기 권한이 있는 누구나 요청 두 번으로 그 문서의 이력 전체를 지울 수 있다. 그때 사라지는 것은
 * 이미 커밋된 남들의 이력이고 지켜지는 것은 문서에 들어간 적조차 없는 글자다 — 균형이 뒤집힌다.
 *
 * 예산의 1/50로 둔다: 어떤 배치도 이력의 2%를 넘게 먹지 못하니 한 요청이 이력을 축출할 수 없고,
 * 정상 편집(가장 긴 코드 블록 두 개 몫)은 한 글자도 잘리지 않는다. 넘긴 몫은 **자르지 않는다** —
 * 그 op을 거절하고 `lostTextDropped`로 그 사실을 응답에 적어 클라이언트가 문장을 쥔 채 나눠 보내게 한다.
 * (자르면 D17이 말한 대로 그 문장이 어디에도 남지 않는다. 거절하면 적어도 클라이언트 큐에는 남는다.)
 */
export const MAX_LOST_TEXT_PER_BATCH = REVISION_BUDGET_CHARS / 50

export const WIKI_REVISION_UNAVAILABLE = 'WIKI_REVISION_UNAVAILABLE'

/** 결정론적 id — 같은 배치를 두 번 처리해도 행이 둘이 되지 않는다. */
export const revisionId = (documentId, version) => `WREV-${String(documentId ?? '').slice(5)}-${version}`

/**
 * 스냅샷을 남길 버전인가.
 * v1은 출발점이라 언제나, 20의 배수는 되감기 걸음을 20 이하로 묶기 위해,
 * 11곳 이상 바뀐 배치는 역패치가 크기 때문에, 복원은 그 자체가 새 출발점이라 남긴다.
 */
export const shouldSnapshot = ({ version, changedCount = 0, restoredFrom = null }) => (
  version === 1 || version % SNAPSHOT_EVERY === 0 || changedCount > SNAPSHOT_CHANGE_THRESHOLD || restoredFrom !== null
)

/** 합계 상한을 지키며 네 갈래 id를 자른다. 잘려도 `inverse`는 온전하므로 복원은 영향받지 않는다. */
function cappedChanged(changed) {
  const result = { inserted: [], updated: [], deleted: [], moved: [] }
  let budget = MAX_CHANGED_IDS
  for (const key of ['inserted', 'updated', 'deleted', 'moved']) {
    for (const id of changed?.[key] ?? []) {
      if (budget <= 0) return result
      result[key].push(id)
      budget -= 1
    }
  }
  return result
}

const clip = (value, limit) => {
  const text = String(value ?? '')
  return text.length <= limit ? text : text.slice(0, limit)
}

const META_SUMMARY = Object.freeze({
  title: (meta) => `제목을 「${clip(meta.after, 40)}」로 바꿨습니다`,
  icon: () => '아이콘을 바꿨습니다',
  parentId: (meta) => (meta.after ? '상위 문서를 바꿨습니다' : '최상위로 옮겼습니다'),
  projectId: (meta) => (meta.after ? '프로젝트를 바꿨습니다' : '프로젝트 연결을 풀었습니다'),
  aiLevel: (meta) => `AI 처리 수준을 ${AI_LEVEL_LABELS[meta.after] ?? meta.after}로 바꿨습니다`,
  writeScope: (meta) => `편집 범위를 ${meta.after === 'tenant' ? '회사 전체' : '작성자'}로 바꿨습니다`,
  archivedAt: (meta) => (meta.after ? '보관함으로 옮겼습니다' : '보관함에서 꺼냈습니다'),
})

/**
 * 사람이 읽는 한 줄. **계산은 이 함수 한 곳**이고 저장은 그 결과다 —
 * 목록 화면이 따로 문장을 만들면 저장된 줄과 화면이 어긋난다.
 */
export function revisionSummary({ changed, meta = null, restoredFrom = null, lostCount = 0 } = {}) {
  if (restoredFrom !== null && restoredFrom !== undefined) return clip(`버전 ${restoredFrom}으로 되돌렸습니다`, MAX_REVISION_SUMMARY)
  const counts = {
    inserted: changed?.inserted?.length ?? 0,
    updated: changed?.updated?.length ?? 0,
    deleted: changed?.deleted?.length ?? 0,
    moved: changed?.moved?.length ?? 0,
  }
  // 네 배열의 **합집합** 크기다. 한 블록을 같은 배치에서 고치고 옮기면 그 id가 updated와 moved에 함께
  // 들어가는데(화면은 어느 블록인지 알아야 하므로 배열은 그대로 둔다), 더하면 "문단 2곳을 바꿨습니다"가
  // 되어 실제로 바뀐 블록 하나를 둘로 셌다고 말하게 된다. 세는 단위는 op이 아니라 문단이다.
  const total = new Set([
    ...(changed?.inserted ?? []), ...(changed?.updated ?? []), ...(changed?.deleted ?? []), ...(changed?.moved ?? []),
  ]).size
  const kinds = Object.values(counts).filter((count) => count > 0).length
  if (kinds > 1) return clip(`문단 ${total}곳을 바꿨습니다`, MAX_REVISION_SUMMARY)
  if (counts.inserted) return `문단 ${counts.inserted}개를 추가했습니다`
  if (counts.updated) return `문단 ${counts.updated}개를 고쳤습니다`
  if (counts.deleted) return `문단 ${counts.deleted}개를 지웠습니다`
  if (counts.moved) return `문단 ${counts.moved}개를 옮겼습니다`
  if (meta && META_SUMMARY[meta.field]) return clip(META_SUMMARY[meta.field](meta), MAX_REVISION_SUMMARY)
  // 본문은 하나도 안 바뀌었지만 밀린 문장만 보관한 버전. '바뀐 내용이 없습니다'로 두면
  // 목록이 실제로 일어난 일과 다른 말을 한다. 사유는 둘(남이 지웠다 / 남이 타입을 바꿨다)이지만
  // 사람이 할 일은 하나라, 한 문장으로 적고 어느 문단이었는지는 상세가 말한다.
  if (lostCount > 0) return `저장하지 못한 내용 ${lostCount}건을 보관했습니다`
  return '바뀐 내용이 없습니다'
}

/**
 * 리비전 한 줄을 만든다. `document`는 **바뀐 뒤**의 문서, `result`는 `mergeOps`의 결과다.
 * 메타데이터만 바뀐 배치는 `result.changed`가 비고 `meta`가 채워진다.
 *
 * `icon`을 함께 저장하는 이유: 복원은 "그 버전의 제목·아이콘까지" 되살린다. 제목만 저장하면
 * 아이콘은 meta 사슬을 거슬러 올라가 계산해야 하고, 그 계산은 meta가 잘리는 날 조용히 틀린다.
 */
export function buildRevision({ document, result = {}, actorId, actorName = '', now, restoredFrom = null, meta = null }) {
  if (typeof actorId !== 'string' || typeof now !== 'string') {
    throw new TypeError('buildRevision: actorId와 now(ISO 문자열)는 필수 인자입니다.')
  }
  // 버전을 올리지 않은 배치로 리비전을 만들면 같은 version의 행이 둘이 되어 사슬이 조용히 뒤틀린다.
  // `mergeOps`는 변화 0 배치에서도 **멱등 창만 갱신한 새 문서 객체**를 돌려줄 수 있으므로(C7),
  // "리비전을 만들 차례인가"의 신호는 참조 동일성이 아니라 `versionBumped`다. 틀리면 여기서 시끄럽게 죽는다 —
  // 조용히 만들어진 중복 행은 몇 배치 뒤 `reconstructBlocks`가 엉뚱한 블록을 돌려줄 때야 드러난다.
  if (result.versionBumped === false) {
    throw new TypeError('buildRevision: versionBumped가 거짓인 배치로는 리비전을 만들 수 없습니다(버전이 오르지 않았습니다).')
  }
  const version = Number(document?.version ?? 0)
  const changed = cappedChanged(result.changed)
  const changedCount = Number(result.changedCount ?? 0)
  const snapshot = shouldSnapshot({ version, changedCount, restoredFrom })
  return {
    id: revisionId(document?.id, version),
    tenantId: document?.tenantId ?? null,
    documentId: document?.id ?? null,
    version,
    at: now,
    byId: actorId,
    byName: String(actorName ?? ''),
    title: String(document?.title ?? ''),
    icon: String(document?.icon ?? ''),
    kind: snapshot ? 'snapshot' : 'patch',
    changed,
    summary: revisionSummary({ changed: result.changed, meta, restoredFrom, lostCount: (result.lostEdits ?? []).length }),
    // 역패치는 잘리지 않는다 — 여기를 자르면 그 버전 아래로 되감을 길이 사라진다.
    inverse: [...(result.inverse ?? [])],
    snapshot: snapshot ? [...(document?.blocks ?? [])] : null,
    overwrites: (result.overwrites ?? []).slice(0, MAX_REVISION_DETAIL),
    // 자르지 않는다 — 여기가 이 문장들의 유일한 보관처다(위 MAX_REVISION_DETAIL 주석).
    lostEdits: [...(result.lostEdits ?? [])],
    restoredFrom,
    meta,
  }
}

/**
 * 역패치·순패치를 LWW 없이 그대로 적용한다. 좌→우 단순 fold다
 * (`mergeOps`가 `inverse.unshift`로 이미 역순 저장했다).
 */
export function applyRawOps(blocks, entries) {
  let next = [...(blocks ?? [])]
  const placeAt = (after) => {
    if (after === null || after === undefined) return 0
    const at = next.findIndex((block) => block?.id === after)
    return at < 0 ? next.length : at + 1
  }
  for (const entry of entries ?? []) {
    if (!entry) continue
    if (entry.kind === 'delete') { next = next.filter((block) => block?.id !== entry.blockId); continue }
    if (entry.kind === 'insert') {
      if (!entry.block) continue
      next.splice(placeAt(entry.after ?? null), 0, entry.block)
      continue
    }
    if (entry.kind === 'update') {
      const at = next.findIndex((block) => block?.id === entry.blockId)
      if (at >= 0 && entry.block) next[at] = entry.block
      continue
    }
    if (entry.kind === 'move') {
      const at = next.findIndex((block) => block?.id === entry.blockId)
      if (at < 0) continue
      const [moved] = next.splice(at, 1)
      next.splice(placeAt(entry.after ?? null), 0, moved)
    }
  }
  return next
}

export const applyInverse = applyRawOps

export const oldestRevisionVersion = (revisions) => {
  let oldest = null
  for (const row of revisions ?? []) {
    const version = Number(row?.version ?? 0)
    if (!version) continue
    if (oldest === null || version < oldest) oldest = version
  }
  return oldest
}

/**
 * 어떤 버전의 블록 배열을 되살린다. 도달할 수 없으면 null(라우트가 410으로 답한다).
 *
 * 스냅샷이 하나도 없어도 **현재 문서에서 역패치를 거슬러 올라가면 도달한다** —
 * 스냅샷은 걸음 수를 줄이는 장치일 뿐이고, 이력 잘라내기가 목록에 보이는 버전을
 * "되돌릴 수 없음"으로 만들지 않는 근거가 이것이다.
 */
export function reconstructBlocks(document, revisions, target) {
  const version = Number(target)
  const current = Number(document?.version ?? 0)
  if (!Number.isInteger(version) || version < 1 || version > current) return null
  const rows = (revisions ?? [])
    // 무조건 비교다(D12). `!row.documentId ||`로 단락하면 documentId가 빈 행이 **어느 문서의 사슬에도**
    // 섞여 남의 블록이 스냅샷으로 채택된다. document에 id·tenantId가 없다면 그건 호출부 버그이므로
    // 빈 배열이 나와 410으로 떨어지는 편이 맞다 — 열리는 쪽이 아니라 닫히는 쪽으로 넘어진다.
    .filter((row) => row && row.documentId === document?.id && row.tenantId === document?.tenantId)
    .slice()
    .sort((a, b) => Number(a.version) - Number(b.version))
  const oldest = oldestRevisionVersion(rows)
  if (oldest !== null && version < oldest) return null

  const byVersion = new Map(rows.map((row) => [Number(row.version), row]))
  const anchor = rows.find((row) => Array.isArray(row.snapshot) && Number(row.version) >= version && Number(row.version) <= current)
  let blocks = anchor ? [...anchor.snapshot] : [...(document?.blocks ?? [])]
  let cursor = anchor ? Number(anchor.version) : current
  while (cursor > version) {
    const row = byVersion.get(cursor)
    if (!row || !Array.isArray(row.inverse)) return null      // 사슬에 구멍 → 되살릴 수 없다
    blocks = applyInverse(blocks, row.inverse)
    cursor -= 1
  }
  return blocks
}

/** 그 버전의 제목·아이콘. 복원이 본문만 되살리고 제목은 지금 것으로 두면 문서가 반쪽만 돌아온다. */
export function revisionHeaderAt(revisions, version) {
  const row = (revisions ?? []).find((entry) => Number(entry?.version) === Number(version))
  return row ? { title: String(row.title ?? ''), icon: String(row.icon ?? '') } : null
}

export const revisionCost = (revision) => (
  JSON.stringify(revision?.snapshot ?? null).length
  + JSON.stringify(revision?.inverse ?? []).length
  + JSON.stringify(revision?.overwrites ?? []).length
  + JSON.stringify(revision?.lostEdits ?? []).length
)

/**
 * 두 축 FIFO 잘라내기 — 개수 200, 문자 2_000_000.
 *
 * **언제나 가장 오래된 쪽부터만** 자른다. 재구성이 현재 문서에서 출발할 수 있으므로
 * `[min(kept.version) .. document.version]` 사슬에는 구멍이 생기지 않고,
 * 목록에 보이는 어떤 버전도 "되돌릴 수 없음"이 되지 않는다.
 */
export function pruneRevisions(rows) {
  const sorted = (rows ?? []).filter(Boolean).slice().sort((a, b) => Number(a.version) - Number(b.version))
  const kept = sorted.slice(-MAX_REVISIONS_PER_DOCUMENT)
  let cost = kept.reduce((sum, row) => sum + revisionCost(row), 0)
  while (kept.length > 1 && cost > REVISION_BUDGET_CHARS) cost -= revisionCost(kept.shift())
  return kept
}

/**
 * 테넌트 전체 이력 정리(스케줄러용). 보관 기간이 지난 줄과 테넌트 상한을 넘긴 줄을
 * **문서별로 최신 한 줄은 남기고** 오래된 것부터 버린다 — 마지막 줄까지 버리면 그 문서의 이력이
 * 통째로 사라져 "지금 문서"에서 되감을 출발점도 없어진다.
 *
 * **무엇을 버릴지는 시계가 아니라 버전이 정한다.** `pruneRevisions`와 같은 규칙 한 벌을 문서마다 돌린다:
 * version 오름차순으로 세운 사슬의 **앞에서만** 자르므로 남는 쪽은 언제나 접미(suffix)다. `at`으로 고르면
 * 문서 안에서 `at`이 엄격 증가하지 않는 순간 — 같은 밀리초에 두 배치가 들어오거나 NTP가 시계를 한 번
 * 되돌리거나, 그저 오래된 줄 하나가 사슬 한가운데 앉아 있거나 — 사슬 중간이 뚫리고 그 아래 버전들이
 * 목록에는 남은 채 `reconstructBlocks`가 null이 된다(§4-4 불변식 R 위반). `at`은 이제 "어느 문서부터
 * 줄일까"를 고르는 힌트로만 쓰이고, 고른 결과는 문서별 '앞에서 몇 줄'로 환산돼 적용된다.
 */
export function pruneTenantRevisions(rows, { now, retentionDays = REVISION_RETENTION_DAYS, maxRows = MAX_REVISION_ROWS_PER_TENANT } = {}) {
  // 날짜로 파싱되지 않는 문자열은 아래 toISOString()에서 RangeError가 되어 스케줄러 잡을 죽인다.
  // 뜻한 메시지가 나오도록 여기서 함께 막는다(mergeOps·buildRevision의 now 가드와 같은 계약).
  if (typeof now !== 'string' || !Number.isFinite(new Date(now).getTime())) {
    throw new TypeError('pruneTenantRevisions: now(ISO 문자열)는 필수 인자입니다.')
  }
  const cutoff = new Date(new Date(now).getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString()
  const list = (rows ?? []).filter(Boolean)

  const chains = new Map()
  for (const row of list) {
    const key = String(row.documentId ?? '')
    if (!chains.has(key)) chains.set(key, [])
    chains.get(key).push(row)
  }
  for (const chain of chains.values()) chain.sort((a, b) => Number(a.version) - Number(b.version))

  // 축 1: 보관 기간. 문서마다 '앞에서 몇 줄을 버리는가'만 정한다. 기간이 남은 줄을 하나라도 만나면
  // 거기서 멈춘다 — 그 뒤에 낡은 줄이 섞여 있어도 남긴다. 사슬이 절약보다 먼저다.
  const dropCount = new Map()
  let keptCount = 0
  for (const [key, chain] of chains) {
    let drop = 0
    while (drop < chain.length - 1 && String(chain[drop].at ?? '') < cutoff) drop += 1
    dropCount.set(key, drop)
    keptCount += chain.length - drop
  }

  // 축 2: 테넌트 상한. 어느 문서부터 줄일지는 여전히 오래된 순서로 고르되, 고른 줄을 곧장 지우지 않고
  // 그 문서의 '버릴 앞줄 수'를 하나 늘린다 — 무엇이 뽑히든 남는 쪽이 접미라는 것이 구조로 보장된다.
  if (keptCount > maxRows) {
    const candidates = []
    for (const [key, chain] of chains) {
      for (let index = dropCount.get(key); index < chain.length - 1; index += 1) candidates.push({ key, row: chain[index] })
    }
    candidates.sort((a, b) => (
      String(a.row.at ?? '').localeCompare(String(b.row.at ?? ''))
      || Number(a.row.version) - Number(b.row.version)
      || a.key.localeCompare(b.key)
    ))
    for (const candidate of candidates) {
      if (keptCount <= maxRows) break
      dropCount.set(candidate.key, dropCount.get(candidate.key) + 1)
      keptCount -= 1
    }
  }

  const doomed = new Set()
  for (const [key, chain] of chains) {
    for (let index = 0; index < dropCount.get(key); index += 1) doomed.add(chain[index])
  }
  const kept = list.filter((row) => !doomed.has(row))
  return { kept, removed: (rows ?? []).length - kept.length }
}

/** 목록 응답 한 줄(§4-7). 본문·역패치는 목록에 싣지 않는다 — 200줄이면 응답이 메가바이트가 된다. */
export const revisionListItem = (revision) => ({
  id: revision.id,
  version: revision.version,
  at: revision.at,
  byId: revision.byId,
  byName: revision.byName,
  summary: revision.summary,
  changed: revision.changed,
  restoredFrom: revision.restoredFrom ?? null,
  hasSnapshot: Array.isArray(revision.snapshot),
  overwriteCount: (revision.overwrites ?? []).length,
  hasLost: (revision.lostEdits ?? []).length > 0,
})

export const revisionRetention = () => ({ maxRevisions: MAX_REVISIONS_PER_DOCUMENT, budgetChars: REVISION_BUDGET_CHARS })

// ── diff ────────────────────────────────────────────────────────────────────

/** 두 id 열의 최장 공통 부분수열. 여기 남은 것이 '제자리', 빠진 것이 '옮겨진 것'이다. */
function longestCommonSubsequence(left, right) {
  const rows = left.length
  const columns = right.length
  if (!rows || !columns) return []
  const table = Array.from({ length: rows + 1 }, () => new Uint16Array(columns + 1))
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const result = []
  let i = 0
  let j = 0
  while (i < rows && j < columns) {
    if (left[i] === right[j]) { result.push(left[i]); i += 1; j += 1 }
    else if (table[i + 1][j] >= table[i][j + 1]) i += 1
    else j += 1
  }
  return result
}

/**
 * 블록 단위 diff. 문자 단위로 하지 않는 이유는 병합 모델이 블록 단위이기 때문이다 —
 * 표현이 모델과 어긋나면 "여기가 충돌했다"는 화면 문장이 실제 충돌 단위와 다른 것을 가리킨다.
 *
 * before/after 미리보기도 `redactLinks`를 통과한다 — 옛 버전이라고 인가가 느슨해지지 않는다.
 */
export function diffBlocks(before, after, resolve) {
  const beforeList = (before ?? []).filter(Boolean)
  const afterList = (after ?? []).filter(Boolean)
  const beforeById = new Map(beforeList.map((block) => [block.id, block]))
  const afterById = new Map(afterList.map((block) => [block.id, block]))

  const added = afterList.filter((block) => !beforeById.has(block.id))
    .map((block) => ({ id: block.id, type: block.type, preview: blockPreview(block, resolve) }))
  const removed = beforeList.filter((block) => !afterById.has(block.id))
    .map((block) => ({ id: block.id, type: block.type, preview: blockPreview(block, resolve) }))
  const changed = []
  for (const block of afterList) {
    const previous = beforeById.get(block.id)
    if (!previous || sameBlockContent(previous, block)) continue
    changed.push({
      id: block.id,
      type: block.type,
      beforePreview: blockPreview(previous, resolve),
      afterPreview: blockPreview(block, resolve),
    })
  }
  const survivorsBefore = beforeList.filter((block) => afterById.has(block.id)).map((block) => block.id)
  const survivorsAfter = afterList.filter((block) => beforeById.has(block.id)).map((block) => block.id)
  const stable = new Set(longestCommonSubsequence(survivorsBefore, survivorsAfter))
  const moved = survivorsAfter.filter((id) => !stable.has(id))
  return { added, removed, changed, moved }
}

// ── 복원 ────────────────────────────────────────────────────────────────────

const recreateNeeded = (current, target) => (
  current.type !== target.type && !(TEXTUAL_TYPES.includes(current.type) && TEXTUAL_TYPES.includes(target.type))
)

/**
 * 현재 블록에서 목표 블록으로 가는 ops. **복원도 `mergeOps`를 통과한다** —
 * 상한·모양 검증을 두 벌로 두면 복원만 통과하는 손상 블록이 생긴다.
 *
 * seq를 손으로 올리지 않아도 된다: `mergeOps`가 insert·update마다 `++blockSeq`를 찍으므로
 * 되살린 블록은 언제나 현재 문서의 모든 블록보다 큰 seq를 받는다. 그래서 진행 중인 다른 편집자의
 * op이 복원을 즉시 되돌리지 못한다.
 *
 * 순서 pass를 통째로 다시 내는 이유: 삽입 앵커가 툼스톤을 따라갈 수 있어서 삽입 후의 자리를
 * 여기서 정확히 예측할 수 없다. 목표 순서대로 move를 한 벌 더 내면 최종 순서가 목표와 같아지는 것이
 * 구조로 보장된다. 복원은 드물고 그 리비전은 언제나 스냅샷이라, 이 여분은 값싸다.
 */
export function diffToOps(current, target, options = {}) {
  const makeOpId = typeof options.newOpId === 'function' ? options.newOpId : defaultNewOpId
  const currentList = (current ?? []).filter(Boolean)
  const targetList = (target ?? []).filter(Boolean)
  const currentById = new Map(currentList.map((block) => [block.id, block]))
  const targetIds = new Set(targetList.map((block) => block.id))

  const recreate = new Set()
  for (const block of targetList) {
    const existing = currentById.get(block.id)
    if (existing && recreateNeeded(existing, block)) recreate.add(block.id)
  }

  const ops = []
  for (const block of currentList) {
    if (targetIds.has(block.id) && !recreate.has(block.id)) continue
    ops.push({ opId: makeOpId(), kind: 'delete', blockId: block.id })
  }

  let inserted = false
  let anchor = null
  for (const block of targetList) {
    const existing = recreate.has(block.id) ? null : currentById.get(block.id)
    const payload = blockPayload(block)
    if (!payload) continue
    if (!existing) {
      // `blockPayload`는 서버 소유 필드를 뺀 모양이라 업무 역링크를 싣지 않고, `validateNewBlock`은
      // 그 필드를 `block` 안에서 거절한다 — 그래서 지웠다 되살린 블록만 역링크를 잃는다. 복원은
      // 서버가 하는 일이므로 되살릴 자격이 있고, `block` 밖의 자리에 실어 mergeOps가 `restore` 문맥에서만
      // 읽게 한다(클라이언트가 보내는 ops는 이 필드를 실어도 무시된다).
      // 지금 블록이 링크를 갖고 있으면 그것을 우선한다 — 그래야 `applyPatch`가 update 경로에서 지키는
      // 규칙("현재 링크는 끊지 않는다")과 삭제·재생성 경로가 같은 말을 한다.
      const restoreWorkItemId = currentById.get(block.id)?.workItemId ?? block.workItemId ?? null
      ops.push({ opId: makeOpId(), kind: 'insert', after: anchor, block: { id: block.id, ...payload }, restoreWorkItemId })
      inserted = true
    } else if (!sameBlockContent(existing, block)) {
      ops.push({ opId: makeOpId(), kind: 'update', blockId: block.id, baseSeq: Number(existing.seq ?? 0), block: payload })
    }
    anchor = block.id
  }

  const survivorsBefore = currentList.filter((block) => targetIds.has(block.id) && !recreate.has(block.id)).map((block) => block.id)
  const survivorsAfter = targetList.filter((block) => currentById.has(block.id) && !recreate.has(block.id)).map((block) => block.id)
  // 두 열을 이어 붙여 비교하지 않는다 — 구분자를 고르는 순간 "그 글자가 id에 들어갈 수 있는가"를
  // 매번 다시 따져야 하고, 그 답으로 골랐던 NUL이 이 파일을 grep에게 바이너리로 보이게 했다.
  const orderChanged = survivorsBefore.length !== survivorsAfter.length
    || survivorsBefore.some((id, index) => id !== survivorsAfter[index])
  if (inserted || orderChanged) {
    let previous = null
    for (const block of targetList) {
      ops.push({ opId: makeOpId(), kind: 'move', blockId: block.id, after: previous })
      previous = block.id
    }
  }
  return ops
}

/**
 * 문장 하나만 되살리기(§4-6). 그 리비전의 `overwrites` → `lostEdits` → `inverse` 순으로
 * 그 블록의 밀린 텍스트를 찾는다. 스냅샷은 보지 않는다 — 스냅샷은 그 배치가 **끝난 뒤**의 모습이라
 * 밀린 텍스트가 아니라 이긴 텍스트가 들어 있다.
 */
export function reinstateSource(revision, blockId) {
  const overwrite = (revision?.overwrites ?? []).find((row) => row?.blockId === blockId)
  if (overwrite) return { text: String(overwrite.previousText ?? ''), from: 'overwrites', block: null }
  const lost = (revision?.lostEdits ?? []).find((row) => row?.blockId === blockId)
  if (lost) return { text: String(lost.text ?? ''), from: 'lostEdits', block: null }
  for (const entry of revision?.inverse ?? []) {
    if (!entry) continue
    const id = entry.blockId ?? entry.block?.id
    if (id !== blockId) continue
    if (entry.kind === 'update' || entry.kind === 'insert') {
      const block = entry.block ?? null
      return { text: typeof block?.text === 'string' ? block.text : '', from: 'inverse', block }
    }
  }
  return null
}

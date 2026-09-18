/**
 * 판 사이 항목 연결(계보) — 설계서 §7·§8·§9.
 *
 * AI가 만든 검토 자료는 새 판이 올 때마다 번호를 다시 매기거나, 제목을 고치거나, 항목을 쪼갠다.
 * 의견·결정은 항목 번호가 아니라 **계보 id**에 붙는다. 그래서 새 판의 항목마다 지난 판의 어느 계보를
 * 잇는지 정해야 의견이 엉뚱한 항목으로 옮겨 가지 않는다.
 *
 * links 안의 줄은 두 부류다.
 *   - 진짜 연결: 'same'(그대로) · 'changed'(같은 번호, 내용 바뀜) · 'moved'(다른 번호로 옮김·이름 바뀜)
 *   - 사람에게 물을 제안: 'uncertain'(확인 필요) · 'key-reused'(번호 재사용 의심)
 * 제안은 아직 연결이 아니다. 확인하지 않은 제안은 "다른 항목"으로 처리한다(§7-5) — 의견이 엉뚱한 항목으로
 * 가는 것보다 새 항목으로 시작하는 편이 덜 해롭고, 나중에 다시 이을 수 있기 때문이다. finalizeLinks가 그렇게 정리한다.
 * 한 새 항목이나 한 계보에 진짜 연결은 많아야 하나다. 제안은 여러 줄이 같은 쪽을 가리킬 수 있다.
 *
 * 저장소·네트워크를 모르는 순수 계산이다. 같은 입력이면 같은 결과가 나온다.
 */

const SAME_KEY_THRESHOLD = 0.5
const MOVED_THRESHOLD = 0.75
const UNCERTAIN_THRESHOLD = 0.45
const CROSS_KIND_PENALTY = 0.1
const TITLE_WEIGHT = 0.4
const TEXT_WEIGHT = 0.6

/** 후보 줄이기: 본문 조각 해시 중 가장 작은 64개(bottom-k 스케치)가 겹치는 정도로 Jaccard를 싸게 어림한다. */
const SKETCH_SIZE = 64
/**
 * 스케치 어림값은 ±0.06 안팎으로 흔들린다(표준편차, 64개일 때 최대). 어림값에 0.3을 더해도 0.45에 못 미치는 쌍만
 * 정밀 계산을 건너뛴다 — 4.8 표준편차라 경계에서 놓칠 일은 사실상 없고, 긴 글끼리의 정밀 계산을 대부분 줄인다.
 */
const SKETCH_MARGIN = 0.3
/** 새 항목 하나당 정밀 계산할 후보 수. 2000×2000에서도 정밀 계산이 4만 번 안쪽으로 묶인다. */
const DEFAULT_CANDIDATE_LIMIT = 20
/** "비슷한 새 항목" 알림용으로 이미 이어진 옛 항목도 몇 개는 본다(쪼개진 항목의 나머지 반쪽을 잡는다). */
const LINKED_CANDIDATE_LIMIT = 3
/** 남은 쌍이 이만큼 이하면 줄이지 않고 전부 정밀 계산한다. 흔한 경우(남은 항목 몇 개)는 근사 없이 끝난다. */
const DEFAULT_EXACT_PAIR_LIMIT = 20000
/**
 * 전부 정밀 계산할 때 조각 배열을 맞대 보는 걸음 수의 상한(약 0.3초). 쌍이 2만 개 아래여도 항목마다 2만 자짜리
 * 원문이면 걸음이 수억이 되어 몇 초씩 걸린다 — 그럴 때는 색인으로 후보를 줄인다.
 */
const DEFAULT_EXACT_WORK_LIMIT = 50_000_000

const REAL_STATUSES = new Set(['same', 'changed', 'moved'])
const PROPOSAL_STATUSES = new Set(['uncertain', 'key-reused'])
/** 요약에 세는 상태. 밖에서 들어온 결과에 'added'·'removed' 같은 상태가 섞여도 요약 칸이 부풀지 않게 정해 둔다. */
const SUMMARY_FIELDS = new Map([['same', 'same'], ['changed', 'changed'], ['moved', 'moved'], ['uncertain', 'uncertain'], ['key-reused', 'keyReused']])

/**
 * 비교용 정규화. AI가 고쳐 쓸 때 잘 바뀌는 것(전각·반각, 대소문자, 따옴표·가운뎃점·화살표 같은 문장부호와 기호,
 * 띄어쓰기 폭)을 지워서 "내용이 같은데 모양만 다른" 글이 같게 보이게 한다.
 */
export function normalizeForCompare(text) {
  if (text === null || text === undefined) return ''
  return String(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\p{C}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * 조각을 만들 글. 한국어는 AI가 띄어쓰기를 자주 바꾸므로 공백은 빼고 글자만 잇는다.
 * normalizeForCompare(text)에서 공백을 뺀 것과 같다 — 큰 자료에서 정규식을 세 번 돌리지 않으려고 한 번에 지운다.
 */
const compactForShingles = (text) => (text === null || text === undefined
  ? ''
  : String(text).normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\p{C}\s]+/gu, ''))

/**
 * 글자 n개 단위 조각 모음. 어절이 아니라 글자로 자르므로 조사·어미가 바뀌어도 대부분의 조각이 남는다.
 * 글자가 n개보다 적으면 글 전체가 조각 하나가 된다.
 */
export function shingles(text, size = 3) {
  const compact = compactForShingles(text)
  const width = Math.max(1, Math.floor(Number(size) || 3))
  const result = new Set()
  if (!compact) return result
  if (compact.length <= width) {
    result.add(compact)
    return result
  }
  for (let index = 0; index + width <= compact.length; index += 1) result.add(compact.slice(index, index + width))
  return result
}

// 내부 계산은 조각을 숫자 하나로 바꿔 정렬 배열로 다룬다(문자열 Set보다 몇 배 빠르다).
// 글자 = UTF-16 코드 → 3글자는 c1·2^32 + c2·2^16 + c3(2^48 미만), 2글자는 c1·2^16 + c2.
// 조각 크기보다 짧은 글의 표지는 2^48·2^49 위로 올려 겹치지 않게 한다.
// shingles(text, 2|3)의 문자열 조각과 1:1로 대응하므로 similarity() 결과가 문자열로 셌을 때와 같다.
const TWO_16 = 65536
const TWO_32 = 4294967296
const SHORT_TWO = 2 ** 48
const SHORT_ONE = 2 ** 49
const EMPTY_KEYS = new Float64Array(0)
const TITLE_SHINGLE = 2
const TEXT_SHINGLE = 3

function shingleKeys(compact, size) {
  const length = compact.length
  if (length === 0) return EMPTY_KEYS
  if (length === 1) return Float64Array.of(SHORT_ONE + compact.charCodeAt(0))
  if (size === 3 && length === 2) return Float64Array.of(SHORT_TWO + compact.charCodeAt(0) * TWO_16 + compact.charCodeAt(1))
  const keys = new Float64Array(length - size + 1)
  let first = compact.charCodeAt(0)
  let second = compact.charCodeAt(1)
  if (size === 2) {
    keys[0] = first * TWO_16 + second
    for (let index = 2; index < length; index += 1) {
      first = second
      second = compact.charCodeAt(index)
      keys[index - 1] = first * TWO_16 + second
    }
  } else {
    for (let index = 2; index < length; index += 1) {
      const third = compact.charCodeAt(index)
      keys[index - 2] = first * TWO_32 + second * TWO_16 + third
      first = second
      second = third
    }
  }
  keys.sort()
  let unique = 1
  for (let index = 1; index < keys.length; index += 1) {
    if (keys[index] !== keys[unique - 1]) {
      keys[unique] = keys[index]
      unique += 1
    }
  }
  return keys.slice(0, unique)
}

/**
 * 제목은 글자 2개 조각, 본문은 글자 3개 조각.
 * 제목은 대여섯 글자라 3글자 조각이 몇 개 안 된다. "결제 실패 안내" → "결제 실패 시 안내"처럼 한 글자만 끼워도
 * 3글자 조각 Jaccard는 0.29로 떨어져, 본문이 똑같아도 0.75(자동 연결)에 못 미친다. 짧은 글에는 2글자 조각이 맞다.
 */
const featuresOf = (anchor) => ({
  title: shingleKeys(compactForShingles(anchor?.title), TITLE_SHINGLE),
  text: shingleKeys(compactForShingles(anchor?.text), TEXT_SHINGLE),
  sketch: null,
})

function sharedCount(left, right) {
  let i = 0
  let j = 0
  let shared = 0
  while (i < left.length && j < right.length) {
    const a = left[i]
    const b = right[j]
    if (a === b) {
      shared += 1
      i += 1
      j += 1
    } else if (a < b) i += 1
    else j += 1
  }
  return shared
}

/** 본문: 정렬된 두 조각 배열의 Jaccard. 둘 다 비었으면 비교할 것이 없다는 뜻으로 null. */
function jaccardSorted(left, right) {
  if (left.length === 0 && right.length === 0) return null
  if (left.length === 0 || right.length === 0) return 0
  const shared = sharedCount(left, right)
  return shared / (left.length + right.length - shared)
}

/** 제목: Dice(2·겹침 ÷ 두 크기 합). 짧은 글에서 한두 조각 차이를 Jaccard보다 덜 무겁게 친다. */
function diceSorted(left, right) {
  if (left.length === 0 && right.length === 0) return null
  if (left.length === 0 || right.length === 0) return 0
  return (2 * sharedCount(left, right)) / (left.length + right.length)
}

/** 크기만 보고 낼 수 있는 상한(작은 쪽이 큰 쪽에 다 들어가도 이 값을 못 넘는다). */
const ceiling = (left, right, dice) => {
  if (left.length === 0 && right.length === 0) return null
  if (left.length === 0 || right.length === 0) return 0
  const small = Math.min(left.length, right.length)
  return dice ? (2 * small) / (left.length + right.length) : small / Math.max(left.length, right.length)
}

/**
 * 제목×0.4 + 본문×0.6. 제목이 양쪽 다 없으면 본문만, 본문이 양쪽 다 없으면 제목만 본다
 * (없는 것을 0점으로 치면 제목 없는 표 행끼리는 아무리 같아도 0.6을 못 넘는다).
 * 양쪽 다 비었으면 0 — 빈 것끼리 자동으로 잇지 않는다.
 */
function combine(title, text) {
  if (title === null && text === null) return 0
  if (title === null) return text
  if (text === null) return title
  return title * TITLE_WEIGHT + text * TEXT_WEIGHT
}

/** floor를 넘을 수 없는 쌍은 정밀 계산 전에 버린다(-1). */
function scoreFeatures(left, right, floor = -Infinity) {
  if (floor > 0 && combine(ceiling(left.title, right.title, true), ceiling(left.text, right.text, false)) < floor) return -1
  return combine(diceSorted(left.title, right.title), jaccardSorted(left.text, right.text))
}

const asAnchor = (value) => (typeof value === 'string' ? { title: '', text: value } : value ?? {})

/**
 * 두 항목의 유사도 0..1 = 제목 Dice(shingles(title, 2))×0.4 + 본문 Jaccard(shingles(text, 3))×0.6.
 * 문자열을 주면 제목 없는 본문으로 본다.
 */
export function similarity(a, b) {
  return scoreFeatures(featuresOf(asAnchor(a)), featuresOf(asAnchor(b)))
}

function mix32(value) {
  let h = value | 0
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

const hashKey = (key) => {
  const low = key % TWO_32
  const high = (key - low) / TWO_32
  return mix32(mix32(low) ^ Math.imul(high, 0x9e3779b1))
}

function sketchOf(features) {
  if (features.sketch) return features.sketch
  const keys = features.text
  // 긴 글은 전부 정렬하지 않는다: 평균 2배쯤 남는 문턱 아래 해시만 모아 정렬한다.
  // 문턱 아래가 64개 이상이면 가장 작은 64개는 모두 그 안에 있으므로 전부 정렬한 것과 결과가 같다.
  if (keys.length > SKETCH_SIZE * 4) {
    const threshold = (TWO_32 / keys.length) * SKETCH_SIZE * 2
    const picked = []
    for (let index = 0; index < keys.length; index += 1) {
      const hash = hashKey(keys[index])
      if (hash < threshold) picked.push(hash)
    }
    if (picked.length >= SKETCH_SIZE) {
      features.sketch = Uint32Array.from(picked).sort().slice(0, SKETCH_SIZE)
      return features.sketch
    }
  }
  const hashes = new Uint32Array(keys.length)
  for (let index = 0; index < hashes.length; index += 1) hashes[index] = hashKey(keys[index])
  hashes.sort()
  features.sketch = hashes.slice(0, Math.min(SKETCH_SIZE, hashes.length))
  return features.sketch
}

/**
 * 두 스케치로 Jaccard를 어림한다: 합집합의 가장 작은 64개 중 양쪽에 다 있는 비율.
 * 스케치가 덜 찼으면(짧은 글) 어림하지 않는다(null) — 짧은 글은 정밀 계산도 싸다.
 */
function sketchJaccard(left, right) {
  if (left.length < SKETCH_SIZE || right.length < SKETCH_SIZE) return null
  let i = 0
  let j = 0
  let taken = 0
  let shared = 0
  while (taken < SKETCH_SIZE && i < left.length && j < right.length) {
    const a = left[i]
    const b = right[j]
    if (a === b) {
      shared += 1
      i += 1
      j += 1
    } else if (a < b) i += 1
    else j += 1
    taken += 1
  }
  return shared / taken
}

/** 색인 경로에서 정밀 계산 전에 거르는 값: 제목은 정확히(짧아서 싸다), 본문은 어림값+여유로 본 점수의 상한 추정. */
function roughCeiling(left, right) {
  const estimate = sketchJaccard(sketchOf(left), sketchOf(right))
  if (estimate === null) return Infinity
  return combine(diceSorted(left.title, right.title), Math.min(1, estimate + SKETCH_MARGIN))
}

const hasId = (anchor) => anchor && typeof anchor === 'object' && anchor.id !== undefined && anchor.id !== null && anchor.id !== ''
const keyOf = (anchor) => (anchor.key === undefined || anchor.key === null || anchor.key === '' ? '' : String(anchor.key))
const kindOf = (anchor) => String(anchor.kind ?? '')
const lineageOf = (anchor) => anchor.lineageId ?? anchor.id

/**
 * 같은 id(새 판)나 같은 계보(지난 판)가 두 번 나오면 앞의 것만 본다. 둘 다 두면 한 계보에 진짜 연결이 둘 생기거나,
 * 이어진 새 항목이 added에도 들어가 결과가 서로 어긋난다.
 */
function uniqueBy(list, identity) {
  const seen = new Set()
  return list.filter((item) => {
    const value = identity(item)
    if (seen.has(value)) return false
    seen.add(value)
    return true
  })
}

/** 내용 해시가 같은가. 해시가 빠진 옛 자료는 NFKC 전문 비교로 대신한다. */
function sameText(left, right) {
  if (left.textHash && right.textHash) return left.textHash === right.textHash
  return String(left.text ?? '').normalize('NFKC') === String(right.text ?? '').normalize('NFKC')
}

/** 점수 높은 순으로 cap개만 남기는 작은 목록. 후보가 수천이어도 대부분은 맨 끝 점수와 한 번 비교하고 끝난다. */
function pushTop(list, cap, prevIndex, score) {
  if (list.length === cap && score <= list[cap - 1].score) return
  let position = list.length === cap ? cap - 1 : list.length
  if (list.length < cap) list.push(null)
  while (position > 0 && list[position - 1].score < score) {
    list[position] = list[position - 1]
    position -= 1
  }
  list[position] = { prevIndex, score }
}

/**
 * 후보 색인. 옛 항목의 본문 스케치 해시와 제목 조각으로 역색인을 만들어, 새 항목마다 겹치는 옛 항목만 센다.
 * 거의 모든 항목에 들어 있는 조각(표 머리글, "개요" 같은 제목)은 아무것도 구별하지 못하고 비용만 키우므로 뺀다.
 * 그렇게 빼다 보면 내용이 똑같은 항목끼리도 못 찾을 수 있어서, 내용 해시가 같은 옛 항목은 따로 색인해 반드시 본다.
 */
function buildCandidateIndex(prev, previousFeatures, isFree) {
  const sketchPostings = new Map()
  const titlePostings = new Map()
  const hashPostings = new Map()
  const add = (map, key, index) => {
    const list = map.get(key)
    if (list) {
      if (list[list.length - 1] !== index) list.push(index)
    } else map.set(key, [index])
  }
  for (let index = 0; index < prev.length; index += 1) {
    const features = previousFeatures(index)
    for (const hash of sketchOf(features)) add(sketchPostings, hash, index)
    for (const key of features.title) add(titlePostings, key, index)
    if (prev[index].textHash && isFree(index)) add(hashPostings, prev[index].textHash, index)
  }
  return {
    sketchPostings,
    titlePostings,
    hashPostings,
    hashRank: new Map(),
    frequencyCap: Math.max(64, Math.ceil(prev.length * 0.05)),
    sketchHits: new Int32Array(prev.length),
    titleHits: new Int32Array(prev.length),
  }
}

/** 똑같은 내용이 여럿이면 순서가 맞는 쪽 근처(앞뒤 2개)만 본다 — r번째 새 항목은 r번째 옛 항목과 짝이 되기 쉽다. */
function sameTextCandidates(index, textHash) {
  const postings = textHash ? index.hashPostings.get(textHash) : null
  if (!postings) return []
  const rank = index.hashRank.get(textHash) ?? 0
  index.hashRank.set(textHash, rank + 1)
  return postings.slice(Math.max(0, rank - 2), rank + 3)
}

function indexedCandidates(index, nextAnchor, features, previousFeatures, isFree, candidateLimit) {
  const { sketchPostings, titlePostings, frequencyCap, sketchHits, titleHits } = index
  const touched = []
  const sketch = sketchOf(features)
  for (const hash of sketch) {
    const postings = sketchPostings.get(hash)
    if (!postings || postings.length > frequencyCap) continue
    for (const prevIndex of postings) {
      if (sketchHits[prevIndex] === 0 && titleHits[prevIndex] === 0) touched.push(prevIndex)
      sketchHits[prevIndex] += 1
    }
  }
  for (const key of features.title) {
    const postings = titlePostings.get(key)
    if (!postings || postings.length > frequencyCap) continue
    for (const prevIndex of postings) {
      if (sketchHits[prevIndex] === 0 && titleHits[prevIndex] === 0) touched.push(prevIndex)
      titleHits[prevIndex] += 1
    }
  }
  const free = []
  const linked = []
  for (const prevIndex of touched) {
    const other = previousFeatures(prevIndex)
    const sketchSize = Math.max(sketch.length, sketchOf(other).length, 1)
    const titleSize = Math.max(features.title.length, other.title.length, 1)
    const estimate = TEXT_WEIGHT * (sketchHits[prevIndex] / sketchSize) + TITLE_WEIGHT * (titleHits[prevIndex] / titleSize)
    sketchHits[prevIndex] = 0
    titleHits[prevIndex] = 0
    if (isFree(prevIndex)) pushTop(free, candidateLimit, prevIndex, estimate)
    else pushTop(linked, LINKED_CANDIDATE_LIMIT, prevIndex, estimate)
  }
  const result = [...free, ...linked].map((entry) => entry.prevIndex)
  const seen = new Set(result)
  for (const prevIndex of sameTextCandidates(index, nextAnchor.textHash)) if (!seen.has(prevIndex)) result.push(prevIndex)
  return result
}

const summarize = (links, added, removed) => {
  const summary = { same: 0, changed: 0, moved: 0, uncertain: 0, keyReused: 0, added: added.length, removed: removed.length }
  for (const link of links) {
    const field = SUMMARY_FIELDS.get(link.status)
    if (field) summary[field] += 1
  }
  return summary
}

/**
 * 지난 판(previous, 항목마다 lineageId)과 새 판(next)의 항목을 잇는다. 규칙은 설계서 §7.
 *
 * 1. 키와 종류가 같으면: 내용 해시가 같으면 'same', 유사도 0.5 이상이면 'changed',
 *    그 아래면 'key-reused' 제안(AI가 번호를 다시 매겨 A1 자리에 다른 내용을 넣은 경우). 이 쌍은 잇지 않는다.
 * 2. 남은 것끼리 점수(다른 종류는 0.1 감점)가 높은 쌍부터 1:1로: 0.75 이상 'moved', 0.45~0.75 'uncertain' 제안.
 * 3. 남은 새 항목은 새 계보(added), 남은 옛 계보는 빠짐(removed).
 * 4. 옛 항목 하나에 새 항목 둘이 비슷하면 나은 쪽이 잇고, 다른 쪽에는 같은 계보를 가리키는
 *    'uncertain' 제안(similar: true, 화면 문구 "비슷한 새 항목")을 붙인다. 번호를 지킨 반쪽(1단계에서 이어진 옛 항목)도 본다.
 *
 * 돌려주는 links 줄: { nextId, lineageId, status, score, textChanged, similar? }
 *   textChanged — 내용 해시가 다른가. 'moved'는 내용이 그대로일 수도 있어 §8·§9 화면이 이 값으로 "바뀜"을 가린다.
 * added·removed는 제안을 아무도 확인하지 않았을 때의 결과다(제안 쪽 새 항목은 added, 옛 계보는 removed에 들어 있다).
 * nextIds·lineageIds는 두 판의 전체 순서다 — applyHumanChoices가 다시 셀 때 문서 순서를 지키는 데 쓴다.
 *
 * options.candidateLimit(기본 20): 큰 자료에서 새 항목 하나당 정밀 계산할 후보 수.
 * options.exactPairLimit(기본 20000): 남은 쌍이 이 이하이면 후보를 줄이지 않고 전부 계산한다.
 * options.exactWorkLimit(기본 5천만): 쌍이 적어도 글이 길어 전부 계산하는 일이 이보다 크면 색인으로 줄인다.
 * id가 겹치는 새 항목, 계보가 겹치는 옛 항목은 앞의 것만 본다.
 */
export function matchAnchors(previous, next, options = {}) {
  const prev = uniqueBy(Array.isArray(previous) ? previous.filter(hasId) : [], lineageOf)
  const nxt = uniqueBy(Array.isArray(next) ? next.filter(hasId) : [], (anchor) => anchor.id)
  const { candidateLimit: wantedCandidates, exactPairLimit: wantedPairs, exactWorkLimit: wantedWork } = options ?? {}
  const candidateLimit = Number.isInteger(wantedCandidates) && wantedCandidates > 0 ? wantedCandidates : DEFAULT_CANDIDATE_LIMIT
  const exactPairLimit = typeof wantedPairs === 'number' && wantedPairs >= 0 ? wantedPairs : DEFAULT_EXACT_PAIR_LIMIT
  const exactWorkLimit = typeof wantedWork === 'number' && wantedWork >= 0 ? wantedWork : DEFAULT_EXACT_WORK_LIMIT

  // 조각은 항목마다 한 번만 만든다(쌍마다 다시 만들면 2000×2000에서 끝나지 않는다).
  const prevCache = new Array(prev.length)
  const nextCache = new Array(nxt.length)
  const prevFeatures = (index) => prevCache[index] ?? (prevCache[index] = featuresOf(prev[index]))
  const nextFeatures = (index) => nextCache[index] ?? (nextCache[index] = featuresOf(nxt[index]))

  const prevLinkedBy = new Int32Array(prev.length).fill(-1)
  const nextLinkedTo = new Int32Array(nxt.length).fill(-1)
  const real = [] // { prevIndex, nextIndex, status, score }
  const proposals = [] // { prevIndex, nextIndex, status, score, similar? }
  const link = (prevIndex, nextIndex, status, score) => {
    prevLinkedBy[prevIndex] = nextIndex
    nextLinkedTo[nextIndex] = prevIndex
    real.push({ prevIndex, nextIndex, status, score })
  }

  // 1단계: 같은 키·같은 종류. 한 판 안에 키가 겹치면(같은 id가 두 번) 나온 순서대로 짝짓는다.
  const buckets = new Map()
  prev.forEach((anchor, index) => {
    const key = keyOf(anchor)
    if (!key) return
    const bucketKey = `${kindOf(anchor)}\u0000${key}`
    const bucket = buckets.get(bucketKey)
    if (bucket) bucket.items.push(index)
    else buckets.set(bucketKey, { items: [index], cursor: 0 })
  })
  const keyReused = []
  nxt.forEach((anchor, nextIndex) => {
    const key = keyOf(anchor)
    if (!key) return
    const bucket = buckets.get(`${kindOf(anchor)}\u0000${key}`)
    if (!bucket || bucket.cursor >= bucket.items.length) return
    const prevIndex = bucket.items[bucket.cursor]
    bucket.cursor += 1
    if (sameText(prev[prevIndex], anchor)) {
      link(prevIndex, nextIndex, 'same', 1)
      return
    }
    const score = scoreFeatures(prevFeatures(prevIndex), nextFeatures(nextIndex))
    if (score >= SAME_KEY_THRESHOLD) link(prevIndex, nextIndex, 'changed', score)
    else keyReused.push({ prevIndex, nextIndex, status: 'key-reused', score })
  })

  // 2단계: 내용으로 찾기.
  const freeNext = []
  for (let index = 0; index < nxt.length; index += 1) if (nextLinkedTo[index] === -1) freeNext.push(index)
  const pairKey = (prevIndex, nextIndex) => prevIndex * nxt.length + nextIndex
  const keyReusedPairs = new Set(keyReused.map((pair) => pairKey(pair.prevIndex, pair.nextIndex)))

  // 전부 계산하는 일 = 쌍마다 두 조각 배열 길이의 합. 쌍이 적어도 글이 길면 이 값이 커진다.
  const exactWork = () => {
    let prevSize = 0
    for (let index = 0; index < prev.length; index += 1) prevSize += prevFeatures(index).text.length
    let nextSize = 0
    for (const index of freeNext) nextSize += nextFeatures(index).text.length
    return prevSize * freeNext.length + nextSize * prev.length
  }

  if (freeNext.length > 0 && prev.length > 0) {
    const exact = freeNext.length * prev.length <= exactPairLimit && exactWork() <= exactWorkLimit
    const allPrev = exact ? Array.from({ length: prev.length }, (_, index) => index) : null
    const isFree = (prevIndex) => prevLinkedBy[prevIndex] === -1
    const index = exact ? null : buildCandidateIndex(prev, prevFeatures, isFree)
    const scored = new Map() // nextIndex → [{ prevIndex, score }] 점수 높은 순, 0.45 이상만
    const pairs = []
    for (const nextIndex of freeNext) {
      const features = nextFeatures(nextIndex)
      const kind = kindOf(nxt[nextIndex])
      const candidates = exact ? allPrev : indexedCandidates(index, nxt[nextIndex], features, prevFeatures, isFree, candidateLimit)
      const list = []
      for (const prevIndex of candidates) {
        const penalty = kindOf(prev[prevIndex]) === kind ? 0 : CROSS_KIND_PENALTY
        if (!exact && roughCeiling(prevFeatures(prevIndex), features) < UNCERTAIN_THRESHOLD + penalty) continue
        const raw = scoreFeatures(prevFeatures(prevIndex), features, UNCERTAIN_THRESHOLD + penalty)
        if (raw < 0) continue
        const score = Math.max(0, raw - penalty)
        if (score < UNCERTAIN_THRESHOLD) continue
        list.push({ prevIndex, score })
        if (isFree(prevIndex) && !keyReusedPairs.has(pairKey(prevIndex, nextIndex))) pairs.push({ prevIndex, nextIndex, score })
      }
      list.sort((a, b) => b.score - a.score || a.prevIndex - b.prevIndex)
      scored.set(nextIndex, list)
    }

    // 점수 높은 쌍부터 1:1. 점수가 같으면 문서 앞쪽끼리 먼저 — 똑같은 항목이 둘이면 순서대로 짝이 된다.
    pairs.sort((a, b) => b.score - a.score || a.prevIndex - b.prevIndex || a.nextIndex - b.nextIndex)
    const prevTaken = new Uint8Array(prev.length)
    const nextTaken = new Uint8Array(nxt.length)
    for (const pair of pairs) {
      if (prevTaken[pair.prevIndex] || nextTaken[pair.nextIndex]) continue
      prevTaken[pair.prevIndex] = 1
      nextTaken[pair.nextIndex] = 1
      if (pair.score >= MOVED_THRESHOLD) link(pair.prevIndex, pair.nextIndex, 'moved', pair.score)
      else proposals.push({ prevIndex: pair.prevIndex, nextIndex: pair.nextIndex, status: 'uncertain', score: pair.score })
    }

    // 4: 짝을 못 찾았는데 이미 다른 새 항목이 가져간 옛 항목과 비슷하면 "비슷한 새 항목"으로 알린다.
    for (const nextIndex of freeNext) {
      if (nextTaken[nextIndex]) continue
      const best = scored.get(nextIndex).find((candidate) => !keyReusedPairs.has(pairKey(candidate.prevIndex, nextIndex)))
      if (best) proposals.push({ prevIndex: best.prevIndex, nextIndex, status: 'uncertain', score: best.score, similar: true })
    }
  }

  // 번호 재사용 의심은 양쪽 다 끝내 이어지지 않았을 때만 사람에게 묻는다.
  // 새 항목이 다른 계보와 이어졌거나 옛 계보가 다른 곳에서 발견됐다면 물을 것이 없다.
  for (const pair of keyReused) {
    if (nextLinkedTo[pair.nextIndex] === -1 && prevLinkedBy[pair.prevIndex] === -1) proposals.push(pair)
  }

  const toLink = (entry) => {
    const result = {
      nextId: nxt[entry.nextIndex].id,
      lineageId: lineageOf(prev[entry.prevIndex]),
      status: entry.status,
      score: entry.score,
      textChanged: entry.status === 'same' ? false : !sameText(prev[entry.prevIndex], nxt[entry.nextIndex]),
    }
    if (entry.similar) result.similar = true
    return result
  }
  const byNext = new Map()
  for (const entry of [...real, ...proposals.sort((a, b) => b.score - a.score)]) {
    const list = byNext.get(entry.nextIndex)
    if (list) list.push(entry)
    else byNext.set(entry.nextIndex, [entry])
  }
  const links = []
  for (let nextIndex = 0; nextIndex < nxt.length; nextIndex += 1) {
    for (const entry of byNext.get(nextIndex) ?? []) links.push(toLink(entry))
  }
  const nextIds = nxt.map((anchor) => anchor.id)
  const lineageIds = prev.map(lineageOf)
  const added = nextIds.filter((_, index) => nextLinkedTo[index] === -1)
  const removed = lineageIds.filter((_, index) => prevLinkedBy[index] === -1)
  return { links, added, removed, summary: summarize(links, added, removed), nextIds, lineageIds }
}

/** links·added·removed에서 두 판의 전체 순서를 되살린다. matchAnchors 결과면 nextIds·lineageIds를 그대로 쓴다. */
function universeOf(result) {
  // 저장했다 다시 읽은 결과에 깨진 줄(null 등)이 섞여도 멈추지 않게 객체인 줄만 본다.
  const links = Array.isArray(result?.links) ? result.links.filter((entry) => entry && typeof entry === 'object') : []
  const nextIds = Array.isArray(result?.nextIds)
    ? result.nextIds
    : [...new Set([...links.map((entry) => entry.nextId), ...(result?.added ?? [])])]
  const lineageIds = Array.isArray(result?.lineageIds)
    ? result.lineageIds
    : [...new Set([...links.map((entry) => entry.lineageId), ...(result?.removed ?? [])])]
  return { links, nextIds, lineageIds }
}

function rebuild(nextIds, lineageIds, links) {
  const order = new Map(nextIds.map((id, index) => [id, index]))
  const rank = (entry) => (REAL_STATUSES.has(entry.status) ? 0 : 1)
  const sorted = links
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (order.get(a.entry.nextId) ?? Infinity) - (order.get(b.entry.nextId) ?? Infinity)
      || rank(a.entry) - rank(b.entry)
      || a.index - b.index)
    .map(({ entry }) => entry)
  const realNext = new Set()
  const realLineage = new Set()
  for (const entry of sorted) {
    if (!REAL_STATUSES.has(entry.status)) continue
    realNext.add(entry.nextId)
    realLineage.add(entry.lineageId)
  }
  const added = nextIds.filter((id) => !realNext.has(id))
  const removed = lineageIds.filter((id) => !realLineage.has(id))
  return { links: sorted, added, removed, summary: summarize(sorted, added, removed), nextIds, lineageIds }
}

/**
 * 판 연결 확인 화면(§7-5)의 [같은 항목]·[다른 항목] 선택을 반영한다. 원래 결과는 바꾸지 않고 새 결과를 돌려준다.
 *
 * choices: [{ nextId, lineageId, same }]
 *   same: true  — 제안을 진짜 연결로. 같은 키였던 'key-reused'는 'changed', 다른 키였던 'uncertain'은 'moved'가 된다.
 *                 사람의 선택이 이긴다: 이 새 항목의 다른 제안은 답이 된 것이므로 지우고, 이 계보를 쥐고 있던
 *                 다른 새 항목은 연결을 내려놓고 "비슷한 새 항목" 제안으로 남는다(되돌릴 수 있게).
 *   same: false — 그 줄을 지운다. 제안이면 새 항목은 새 계보로 남고, 진짜 연결이어도 사람이 아니라고 했으면 끊는다.
 * 목록에 없는 쌍을 가리키는 선택은 무시한다. 선택을 받지 못한 제안은 제안으로 남는다. 선택은 순서대로 적용된다.
 */
export function applyHumanChoices(result, choices) {
  const { links: original, nextIds, lineageIds } = universeOf(result)
  let links = original.map((entry) => ({ ...entry }))
  for (const choice of Array.isArray(choices) ? choices : []) {
    if (!choice || (choice.same !== true && choice.same !== false)) continue
    const entry = links.find((candidate) => candidate.nextId === choice.nextId && candidate.lineageId === choice.lineageId)
    if (!entry) continue
    if (choice.same === false) {
      links = links.filter((candidate) => candidate !== entry)
      continue
    }
    // 진짜 연결로 올릴 수 있는 것은 제안뿐이다. 깨진 결과의 모르는 상태('added' 등)를 연결로 만들지 않는다.
    if (!PROPOSAL_STATUSES.has(entry.status)) continue
    links = links
      .filter((candidate) => candidate === entry || candidate.nextId !== entry.nextId)
      .map((candidate) => {
        if (candidate === entry || candidate.lineageId !== entry.lineageId || !REAL_STATUSES.has(candidate.status)) return candidate
        return { ...candidate, status: 'uncertain', similar: true }
      })
    entry.status = entry.status === 'key-reused' ? 'changed' : 'moved'
    entry.confirmed = true
    delete entry.similar
  }
  return rebuild(nextIds, lineageIds, links)
}

/**
 * 게시할 때 쓰는 최종 연결. 진짜 연결(same·changed·moved)만 남기고, 확인받지 못한 제안은
 * "다른 항목"으로 본다(§7-5): 새 항목은 새 계보(added), 옛 계보는 빠짐(removed).
 * byNextId 값: { lineageId, status, score, textChanged }
 */
export function finalizeLinks(result) {
  const { links, nextIds, lineageIds } = universeOf(result)
  const byNextId = new Map()
  const linkedLineages = new Set()
  for (const entry of links) {
    if (!REAL_STATUSES.has(entry.status) || byNextId.has(entry.nextId) || linkedLineages.has(entry.lineageId)) continue
    byNextId.set(entry.nextId, { lineageId: entry.lineageId, status: entry.status, score: entry.score, textChanged: entry.textChanged !== false && entry.status !== 'same' })
    linkedLineages.add(entry.lineageId)
  }
  return {
    byNextId,
    added: nextIds.filter((id) => !byNextId.has(id)),
    removed: lineageIds.filter((id) => !linkedLineages.has(id)),
  }
}

// ── 글자 비교(§9) ─────────────────────────────────────────────

const WORD_LIMIT = 3000
const MAX_WORD_EDITS = 2000
const MAX_PARAGRAPH_EDITS = 1000

/**
 * Myers O((N+M)·D) 차이 계산. 편집 수가 maxEdits를 넘으면 null(메모리 D², 시간 (N+M)·D를 묶는다).
 * 돌려주는 것: [['equal'|'delete'|'insert', 토큰], ...]
 */
function myers(before, after, maxEdits) {
  const n = before.length
  const m = after.length
  const max = n + m
  const offset = max + 1
  const frontier = new Int32Array(2 * max + 3)
  const trace = []
  const limit = Math.min(max, maxEdits)
  for (let d = 0; d <= limit; d += 1) {
    trace.push(frontier.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && frontier[offset + k - 1] < frontier[offset + k + 1])
        ? frontier[offset + k + 1]
        : frontier[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && before[x] === after[y]) {
        x += 1
        y += 1
      }
      frontier[offset + k] = x
      if (x >= n && y >= m) return backtrack(trace, before, after)
    }
  }
  return null
}

function backtrack(trace, before, after) {
  const steps = []
  let x = before.length
  let y = after.length
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const snapshot = trace[d]
    const at = (k) => snapshot[k + d + 1]
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      steps.push(['equal', before[x - 1]])
      x -= 1
      y -= 1
    }
    if (d > 0) {
      if (x === prevX) steps.push(['insert', after[y - 1]])
      else steps.push(['delete', before[x - 1]])
    }
    x = prevX
    y = prevY
  }
  return steps.reverse()
}

/**
 * 앞뒤 같은 부분을 떼고 가운데만 비교한다. 긴 글에서 한 곳만 고친 흔한 경우를 싸게 끝낸다.
 * 가운데가 한쪽이라도 maxMiddle을 넘거나 편집이 maxEdits를 넘으면 null — 부르는 쪽이 더 거칠게 비교한다.
 */
function diffUnits(before, after, { maxEdits, maxMiddle = Infinity }) {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1
  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1
    endAfter -= 1
  }
  if (endBefore - start > maxMiddle || endAfter - start > maxMiddle) return null
  const middle = myers(before.slice(start, endBefore), after.slice(start, endAfter), maxEdits)
  if (!middle) return null
  return [
    ...before.slice(0, start).map((unit) => ['equal', unit]),
    ...middle,
    ...before.slice(endBefore).map((unit) => ['equal', unit]),
  ]
}

/** 바뀐 덩어리 안에서는 삭제를 먼저, 추가를 나중에 모아 읽기 쉽게 한다. */
function groupSteps(steps, separator, coarse) {
  const ops = []
  const push = (op, units) => {
    if (units.length === 0) return
    const entry = { op, text: units.join(separator) }
    if (coarse) entry.coarse = true
    ops.push(entry)
  }
  let equal = []
  let deleted = []
  let inserted = []
  const flushChanges = () => {
    push('delete', deleted)
    push('insert', inserted)
    deleted = []
    inserted = []
  }
  for (const [op, unit] of steps) {
    if (op === 'equal') {
      if (deleted.length || inserted.length) flushChanges()
      equal.push(unit)
      continue
    }
    if (equal.length) {
      push('equal', equal)
      equal = []
    }
    if (op === 'delete') deleted.push(unit)
    else inserted.push(unit)
  }
  push('equal', equal)
  flushChanges()
  return ops
}

/** room 글자(말줄임표 포함)로 자른다. 이모지 같은 두 칸짜리 글자를 반으로 자르면 깨진 글자가 되므로 앞 반쪽은 버린다. */
function cutEntry(entry, room) {
  let text = entry.text.slice(0, room - 1)
  const last = text.charCodeAt(text.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1)
  return { ...entry, text: `${text}…`, truncated: true }
}

function truncateOps(ops, maxChars) {
  const result = []
  let used = 0
  for (let index = 0; index < ops.length; index += 1) {
    const entry = ops[index]
    if (used + entry.text.length <= maxChars) {
      result.push(entry)
      used += entry.text.length
      continue
    }
    const room = maxChars - used
    const partner = entry.op === 'delete' && ops[index + 1]?.op === 'insert' ? ops[index + 1] : null
    if (partner && room >= 4) {
      // 바뀐 덩어리(삭제 다음 추가)에서 자리가 모자라면 둘이 나눠 쓴다. 삭제만 남기면 새 글이 통째로 사라져
      // 화면이 "지웠다"로 읽힌다 — 긴 글을 통째로 고쳐 쓴 경우(문단 비교로 넘어간 경우)가 늘 그렇다.
      const insertRoom = Math.min(partner.text.length, Math.floor(room / 2))
      result.push(cutEntry(entry, room - insertRoom))
      result.push(partner.text.length <= insertRoom ? { ...partner, truncated: true } : cutEntry(partner, insertRoom))
    } else if (room > 1 || (room === 1 && result.length === 0)) result.push(cutEntry(entry, room))
    else if (result.length > 0) result[result.length - 1] = { ...result[result.length - 1], truncated: true }
    break
  }
  return result
}

const paragraphsOf = (text) => String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)

/**
 * 어절 단위 비교(§9: 4,000자까지). 공백으로만 자르므로 한국어 어절("회의는", "10시에")이 쪼개지지 않는다.
 *
 * 돌려주는 것: [{ op: 'equal'|'insert'|'delete', text }]
 *   - text는 어절을 공백 하나로 이은 것이다. equal+delete 조각을 공백으로 이으면 앞 글, equal+insert 조각을 이으면 뒤 글이 된다.
 *   - 앞뒤 같은 부분을 뗀 가운데가 한쪽이라도 3,000어절을 넘거나 편집이 너무 많으면 문단 단위로 거칠게 비교한다.
 *     이때 조각마다 coarse: true가 붙고, text는 문단을 줄바꿈으로 이은 것이다(조각 사이도 줄바꿈).
 *   - 조각 글자 수 합이 maxChars를 넘으면 거기서 자르고 마지막 조각에 truncated: true를 붙인다.
 *     바뀐 덩어리(삭제 다음 추가)에서 잘리면 둘이 자리를 나눠 써서 새 글이 적어도 일부는 보이게 한다.
 */
export function wordDiff(beforeText, afterText, options = {}) {
  const before = String(beforeText ?? '').split(/\s+/).filter(Boolean)
  const after = String(afterText ?? '').split(/\s+/).filter(Boolean)
  const maxChars = options?.maxChars ?? 4000
  // 1보다 작은 값(0.5 등)을 0으로 내리면 아무것도 안 보여 "바뀐 곳 없음"과 구별되지 않는다.
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.max(1, Math.floor(maxChars)) : 4000

  const words = diffUnits(before, after, { maxEdits: MAX_WORD_EDITS, maxMiddle: WORD_LIMIT })
  if (words) return truncateOps(groupSteps(words, ' ', false), limit)

  const beforeParagraphs = paragraphsOf(beforeText)
  const afterParagraphs = paragraphsOf(afterText)
  const paragraphs = diffUnits(beforeParagraphs, afterParagraphs, { maxEdits: MAX_PARAGRAPH_EDITS })
    ?? [...beforeParagraphs.map((unit) => ['delete', unit]), ...afterParagraphs.map((unit) => ['insert', unit])]
  return truncateOps(groupSteps(paragraphs, '\n', true), limit)
}

// ── 반영 확인(§9) ─────────────────────────────────────────────

const APPLIED_DECISIONS = new Set(['반영', '수정 후 반영'])

/**
 * "지난 판에서 '반영'으로 결정한 12건 중 10건은 내용이 바뀌었고, 2건은 그대로예요" — AI 없이 계산한다.
 *
 * decisions: 지난 판의 결정 [{ lineageId, status }]. 한 계보에 여러 줄이면 배열의 마지막 줄을 현재 결정으로 본다.
 * links: matchAnchors·applyHumanChoices의 links 배열, 또는 finalizeLinks의 byNextId(Map). 제안은 "다른 항목"이므로 세지 않는다.
 *
 * reflected: 반영·수정 후 반영으로 결정했고 새 판에서 내용이 바뀐 계보 수('changed', 또는 내용이 바뀐 'moved').
 * unchangedAfterDecision: 반영하기로 했는데 내용이 그대로인 계보('same', 또는 자리만 옮긴 'moved') — 한 바퀴가 안 닫힌 곳.
 * decided: 반영·수정 후 반영으로 결정한 계보 수("12건 중"의 12). 빠졌거나 확인 대기인 계보는 두 목록 어디에도 없다.
 */
export function carryOverSummary(input = {}) {
  const { decisions, links } = input ?? {}
  const latest = new Map()
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    if (!decision || decision.lineageId === undefined || decision.lineageId === null) continue
    latest.set(decision.lineageId, decision.status)
  }
  const entries = links instanceof Map ? [...links.values()] : Array.isArray(links) ? links : []
  const byLineage = new Map()
  for (const entry of entries) {
    if (!entry || !REAL_STATUSES.has(entry.status) || byLineage.has(entry.lineageId)) continue
    byLineage.set(entry.lineageId, entry)
  }
  let decided = 0
  let reflected = 0
  const unchangedAfterDecision = []
  for (const [lineageId, status] of latest) {
    if (!APPLIED_DECISIONS.has(status)) continue
    decided += 1
    const entry = byLineage.get(lineageId)
    if (!entry) continue
    const unchanged = entry.status === 'same' || (entry.status === 'moved' && entry.textChanged === false)
    if (unchanged) unchangedAfterDecision.push(lineageId)
    else reflected += 1
  }
  return { reflected, unchangedAfterDecision, decided }
}

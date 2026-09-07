/**
 * 문서(위키) 블록의 모양 — 화면 쪽 한 벌.
 *
 * 서버 `server/wiki-blocks.mjs`와 **같은 문자열**이어야 한다. 두 벌이 어긋나면 화면이 만들 수 있는
 * 블록을 서버가 400으로 거절하거나, 반대로 서버가 받아 준 타입을 화면이 못 그린다. 계약 테스트
 * (`scripts/wiki-ui-contract.test.mjs`)가 두 소스에서 배열 리터럴을 뽑아 그대로 비교한다.
 *
 * 여기에는 특정 업무 어휘를 두지 않는다 — 이 파일은 회의 기록에도, 신청서 초안에도, 매뉴얼에도
 * 똑같이 쓰인다. 문서 종류의 이름은 서버 템플릿 데이터(`server/wiki-templates.mjs`)에만 있다.
 */

export const BLOCK_TYPES = ['heading', 'text', 'bulleted', 'numbered', 'todo', 'table', 'image', 'file', 'code', 'quote', 'divider'] as const
/** 슬래시 메뉴가 서로 바꿀 수 있는 타입. 이 울타리 밖의 변경은 삭제 + 삽입이지 변경이 아니다. */
export const TEXTUAL_TYPES = ['text', 'heading', 'bulleted', 'numbered', 'todo', 'quote', 'code'] as const
export const LIST_TYPES = ['bulleted', 'numbered', 'todo'] as const

export type BlockType = (typeof BLOCK_TYPES)[number]

/** 상한도 서버 규격과 같은 값이다 — 화면이 먼저 말해 주면 사람이 400을 받고서야 알지 않는다. */
export const MAX_BLOCK_TEXT = 4_000
export const MAX_CODE_TEXT = 20_000
export const MAX_HEADING_TEXT = 200
export const MAX_CAPTION = 200
export const MAX_TITLE = 200
export const MAX_TABLE_ROWS = 30
export const MAX_TABLE_COLS = 8
export const MAX_CELL = 200
export const MAX_INDENT = 3
export const MAX_TREE_DEPTH_UI = 3
export const PRESENCE_HEARTBEAT_MS = 15_000

export type WikiBlock = {
  id: string
  type: BlockType
  text?: string
  level?: number
  indent?: number
  checked?: boolean
  language?: string
  rows?: string[][]
  attachmentId?: string
  seq?: number
  editedById?: string
  editedAt?: string
  workItemId?: string
}

/** 타입별로 본문이 넘을 수 없는 길이. 서버 `BLOCK_SPEC.maxText`와 같은 표다. */
export function maxTextOf(type: BlockType) {
  if (type === 'code') return MAX_CODE_TEXT
  if (type === 'heading') return MAX_HEADING_TEXT
  if (type === 'image' || type === 'file') return MAX_CAPTION
  return MAX_BLOCK_TEXT
}

export const isTextual = (type: BlockType) => (TEXTUAL_TYPES as readonly string[]).includes(type)
export const isList = (type: BlockType) => (LIST_TYPES as readonly string[]).includes(type)

/**
 * 새 블록 id. 서버 `BLOCK_ID_RE`(`^BLK-[A-Za-z0-9_-]{8,40}$`)를 만족해야 한다 —
 * 여기서 어긋나면 삽입이 통째로 `WIKI_BLOCK_INVALID`로 튕긴다.
 */
export function newBlockId() {
  const stamp = Date.now().toString(36).toUpperCase()
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()
    : Math.random().toString(36).slice(2, 12).toUpperCase().padEnd(10, '0')
  return `BLK-${stamp}-${random}`
}

/** 편집 배치 하나를 가리키는 id. 서버 `OP_ID_RE`(`^OP-[A-Za-z0-9_-]{6,40}$`)와 짝이다. */
export function newOpId() {
  const stamp = Date.now().toString(36).toUpperCase()
  const random = Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, '0')
  return `OP-${stamp}-${random}`
}

/**
 * 캐럿 자리에서 본문을 둘로 가른다.
 * 순수 함수로 두는 이유: Enter가 한글 조합 중에 눌렸는지, 캐럿이 어디인지는 호출부가 이미 판정했고
 * 여기서 다시 판정하면 두 벌이 된다.
 */
export function splitAt(text: string, caret: number): [string, string] {
  const at = Math.max(0, Math.min(text.length, caret))
  return [text.slice(0, at), text.slice(at)]
}

/**
 * 앞 블록에 붙인다. 돌려주는 `caret`이 이음매이며, 호출부가 그 자리에 캐럿을 놓는다 —
 * 붙이고 나서 캐럿이 맨 앞이나 맨 뒤로 튀면 사람은 방금 무엇이 합쳐졌는지 알 수 없다.
 */
export function mergeIntoPrevious(previousText: string, currentText: string) {
  return { text: `${previousText}${currentText}`, caret: previousText.length }
}

/**
 * 들여쓰기 한 칸. 0..MAX_INDENT 안이고, **앞 형제보다 2 이상 깊어질 수 없다** —
 * 그렇게 되면 화면에는 들어가지만 어떤 목록에도 속하지 않는 유령 단계가 생긴다.
 * 움직일 수 없으면 지금 값을 그대로 돌려준다(호출부가 `preventDefault`만 하고 op을 만들지 않게).
 */
export function indentDelta(current: number, delta: number, previousIndent: number | null) {
  const base = Math.max(0, Math.min(MAX_INDENT, Math.trunc(current) || 0))
  const wanted = Math.max(0, Math.min(MAX_INDENT, base + delta))
  if (previousIndent === null) return delta > 0 ? base : wanted
  return wanted > previousIndent + 1 ? base : wanted
}

/** 타입별로 반드시 있어야 하는 필드. 서버 `BLOCK_SPEC.required`와 같은 표다. */
const REQUIRED_FIELDS: Record<BlockType, readonly (keyof WikiBlock)[]> = {
  heading: ['text'], text: ['text'], quote: ['text'],
  bulleted: ['text'], numbered: ['text'], todo: ['text', 'checked'],
  code: ['text'], divider: [], table: ['rows'], image: ['attachmentId'], file: ['attachmentId'],
}
const OPTIONAL_FIELDS: Record<BlockType, readonly (keyof WikiBlock)[]> = {
  heading: ['level'], text: [], quote: [],
  bulleted: ['indent'], numbered: ['indent'], todo: ['indent'],
  code: ['language'], divider: [], table: [], image: ['text'], file: ['text'],
}
const FIELD_DEFAULT: Record<string, unknown> = { text: '', level: 2, indent: 0, checked: false, language: '', rows: [], attachmentId: '' }

/**
 * 그 타입이 가질 수 있는 필드 전부(서버 소유 필드는 없다).
 *
 * 조각을 접을 때 옛 타입의 필드가 남으면 서버가 그 조각을 거절한다 — 표를 한 벌만 두고 그 표에 묻는다.
 */
export function fieldsOf(type: BlockType): readonly (keyof WikiBlock)[] {
  return [...REQUIRED_FIELDS[type], ...OPTIONAL_FIELDS[type]]
}

/**
 * 서버가 받아 주는 모양만 남긴 새 블록.
 *
 * 서버 소유 필드(`seq`·`editedById`·`editedAt`·`workItemId`)를 실으면 삽입이 통째로 400이다 —
 * 무시하지 않고 거절하는 것이 서버의 태도라, 복제·붙여넣기가 그 필드를 흘리면 배치 전체가 죽는다.
 * 타입에 없는 필드도 같은 이유로 떨군다.
 */
export function clientBlockPayload(source: Partial<WikiBlock> & { type: BlockType; id: string }): WikiBlock {
  const block: WikiBlock = { id: source.id, type: source.type }
  for (const field of [...REQUIRED_FIELDS[source.type], ...OPTIONAL_FIELDS[source.type]]) {
    const value = source[field] ?? FIELD_DEFAULT[field as string]
    // 표만 배열이라 얕은 복사가 필요하다. 그대로 넘기면 원본 블록과 셀 배열을 공유한다.
    ;(block as Record<string, unknown>)[field as string] = field === 'rows'
      ? (value as string[][] | undefined ?? []).map((row) => [...row])
      : value
  }
  return block
}

/** 읽기 모드에서 같은 종류의 이웃 목록을 한 덩어리로 묶는다. 묶지 않으면 항목마다 `<ul>`이 새로 열린다. */
export function groupBlocksForRead(blocks: WikiBlock[]) {
  const groups: { type: BlockType | 'single'; items: WikiBlock[] }[] = []
  for (const block of blocks) {
    const last = groups[groups.length - 1]
    if (isList(block.type) && last && last.type === block.type) { last.items.push(block); continue }
    groups.push({ type: isList(block.type) ? block.type : 'single', items: [block] })
  }
  return groups
}

/** 엑셀에서 붙여 넣은 한 덩어리를 표 격자로 편다. 상한을 넘는 부분은 버린다(표는 자를 수밖에 없다). */
export function parseTsv(text: string) {
  return text.replace(/\r\n?/gu, '\n').split('\n')
    .filter((line, index, all) => line.length > 0 || index < all.length - 1)
    .slice(0, MAX_TABLE_ROWS)
    .map((line) => line.split('\t').slice(0, MAX_TABLE_COLS).map((cell) => cell.slice(0, MAX_CELL)))
}

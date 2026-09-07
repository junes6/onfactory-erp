/**
 * Flow 파일함 벌크 이관 — 브라우저 쪽 규칙.
 *
 * 서버와 겹치는 상수는 **같은 값**이어야 한다(계약 시험이 서버 소스에서 뽑아 비교한다).
 * 다르면 화면이 200건을 보냈는데 서버가 413을 내거나, 10MB짜리를 올렸다가 500을 받는다.
 */

/** 서버 express.raw({ limit: '10mb' })와 같은 값. */
export const MAX_BULK_FILE_BYTES = 10 * 1024 * 1024
/** 서버 MAX_MANIFEST_PAGE와 같은 값. */
export const MANIFEST_CHUNK = 200
/** 서버 MAX_MAPPING_ROWS와 같은 값. 폴더를 나누다 이 수를 넘으면 매핑 저장이 통째로 400이 된다. */
export const MAX_MAPPING_ROWS = 100
/**
 * 서버 MAX_USER_TAGS_PER_MAPPING과 같은 값. 서버는 예약 태그 두 칸('bulk-import'·'import:<세션>')을
 * 남겨 두므로 20개를 보내면 매핑 저장이 통째로 400이 된다.
 */
export const MAX_MAPPING_TAGS = 18
/** 서버 MAX_PATH_LENGTH와 같은 값. 넘는 경로가 한 건이라도 섞이면 그 페이지 200건이 통째로 400이 된다. */
export const MAX_PATH_LENGTH = 400
/** 진행 보고는 묶어 보낸다 — 파일마다 보내면 세션 행을 200번 다시 쓴다. */
export const PROGRESS_BATCH = 10
export const PROGRESS_INTERVAL_MS = 3_000
/** 연속 실패가 이만큼이면 스스로 멈춘다. 100건을 더 갈아 넣지 않는다. */
export const MAX_CONSECUTIVE_FAILURES = 3
/** 드롭 폴더를 훑는 한계. 사람이 실수로 홈 디렉터리를 끌어놓아도 탭이 멈추지 않는다. */
export const MAX_DROP_DEPTH = 10
export const MAX_DROP_ENTRIES = 10_000

export type BulkAiLevel = 'locked' | 'indexed' | 'active'
/** 서버 document-ai-policy.mjs의 AI_POLICY_LABELS와 같은 표. */
export const AI_POLICY_LABELS: Record<BulkAiLevel, string> = { locked: '보관만', indexed: '정리', active: '활용' }
export const AI_POLICY_ORDER: BulkAiLevel[] = ['locked', 'indexed', 'active']

export type BulkFile = { file: File; path: string; name: string; size: number }
/**
 * rowId는 화면에서만 쓰는 값이다(서버 normalizeMapping이 버린다). 서버가 돌려준 매핑에는 없으므로
 * 선택 값이고, 상태에 들어가는 자리마다 withRowIds가 채운다.
 */
export type MappingRow = { rowId?: string; folderPrefix: string; projectId: string | null; tags: string[]; aiLevel: BulkAiLevel }
export type EntryStatus = 'pending' | 'uploaded' | 'duplicate' | 'failed'
export type ProgressResult = { path: string; status: 'uploaded' | 'duplicate' | 'failed'; documentId?: string; error?: string; changed?: boolean }

/**
 * 보안 컨텍스트에서만 crypto.subtle이 존재한다. http://localhost는 통과하지만
 * http://192.168.0.x는 undefined다 — 사내 LAN에서 열어 본 사람에게만 화면이 깨지는 종류의 결함이라
 * 기능을 죽이지 않고 정직하게 말한 뒤 서버 백스톱(dedupe=1)으로 계속 간다.
 */
export const subtleAvailable = () => Boolean(globalThis.crypto?.subtle)

export const NO_SUBTLE_MESSAGE = '이 주소(http)에서는 브라우저가 파일 지문을 만들 수 없습니다. https로 접속하면 중복 건너뛰기를 쓸 수 있습니다. 지금 계속하면 서버가 업로드 시점에 중복을 걸러냅니다.'
export const REPICK_MESSAGE = '같은 폴더를 다시 선택해 주세요. 이미 올라간 파일은 건너뜁니다.'
export const UNREADABLE_MESSAGE = '일부 파일을 읽지 못해 지문을 만들지 못했습니다. 그 파일은 올릴 때 서버가 중복을 확인합니다.'
/**
 * 매니페스트가 한 페이지라도 실패하면 올릴 목록이 비어 있다. 그 상태로 마감을 부르면 서버가
 * 남은 pending을 전부 실패로 닫고 세션은 종료 상태가 된다 — 화면에는 파일이 그대로 보이는데
 * 보고서는 '실패 200개'가 된다. 그래서 마감 대신 이 문장을 띄우고 멈춘다.
 */
export const PLAN_MISSING_MESSAGE = '파일 목록을 서버가 아직 받지 못했습니다. ‘파일 확인’을 다시 눌러 주세요.'
/** 서버 상한(MAX_MAPPING_ROWS)을 넘겨 보내면 매핑 저장이 통째로 거절된다 — 넘기기 전에 말한다. */
export const MAPPING_FULL_MESSAGE = `폴더 매핑은 ${MAX_MAPPING_ROWS}행까지 만들 수 있습니다. 더 나누려면 폴더를 나눠 올려 주세요.`

/**
 * 아래 세 문장은 **서버 소스에서 글자 그대로 가져온 것**이고 계약 시험이 동치를 잠근다.
 * 한 사실을 두 곳이 각자 쓰면, 사람이 미리 본 문장과 나중에 듣는 이유가 달라진다.
 */
/** 서버 bulk-import.mjs의 ABANDONED_MESSAGE. */
export const ABANDONED_MESSAGE = '재개할 때 이 파일을 다시 선택하지 않았습니다.'
/** 서버 bulk-import.mjs의 OVERSIZE_MESSAGE. */
export const OVERSIZE_MESSAGE = '10MB를 넘는 파일은 아직 올릴 수 없습니다.'
/**
 * 서버 bulk-import.mjs의 UNFINISHED_MESSAGE. 마감 라우트가 남은 pending에 새기는 문장이고,
 * '이관 중단' 확인 창이 **그 결과를 미리 말할 때** 같은 문장을 인용한다.
 */
export const UNFINISHED_MESSAGE = '이관을 마칠 때까지 올리지 않은 파일입니다.'
/**
 * 경로가 너무 긴 파일. 서버는 그 한 건 때문에 **페이지 200건을 통째로** 400으로 거절하고,
 * 그 문장은 '폴더를 다시 선택해 주세요'라 시키는 대로 해도 결과가 같다 — 보내기 전에 골라낸다.
 */
export const PATH_TOO_LONG_MESSAGE = `원본 경로가 ${MAX_PATH_LENGTH}자를 넘어 보내지 않았습니다.`
/** 서버 bulk-import.mjs의 UNMAPPED_MESSAGE. 매핑 표 어디에도 걸리지 않은 폴더의 파일. */
export const UNMAPPED_MESSAGE = '매핑 표에 없는 폴더의 파일입니다. 대상 프로젝트가 없는 파일은 회사 전체가 보는 자료가 되므로 회사 관리자만 올릴 수 있습니다. 매핑 표에 이 폴더를 추가해 주세요.'
/** 위 문장이 말하는 상한의 표기. 화면의 다른 줄이 '10.0 MB'로 적으면 같은 값이 두 이름을 갖는다. */
export const MAX_BULK_FILE_LABEL = '10MB'
/**
 * 서버 BULK_IMPORT_ERRORS.ENTRY_SETTLED의 코드. 재개가 이미 끝난 파일을 다시 보냈을 때의 답이고,
 * 연결 실패가 아니라 '건너뜀'으로 세야 한다 — 실패로 세면 세 번 만에 스스로 멈춘다.
 */
export const ENTRY_SETTLED_CODE = 'BULK_IMPORT_ENTRY_SETTLED'
/**
 * 서버 BULK_IMPORT_ERRORS.ENTRY_LIMIT의 코드. 이 거절은 **같은 세션으로는 되돌릴 수 없다** —
 * 더 작은 폴더를 다시 골라도 매니페스트는 같은 세션으로 가서 또 409가 된다.
 */
export const ENTRY_LIMIT_CODE = 'BULK_IMPORT_ENTRY_LIMIT'

/** 파일 하나의 sha-256. 10MB 상한이 이미 메모리를 묶어 두므로 조각내 읽지 않는다. */
export async function sha256File(file: File): Promise<string> {
  const buffer = await file.arrayBuffer()
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const normalizePath = (value: string) => value.replaceAll('\\', '/').split('/').map((segment) => segment.trim()).filter(Boolean).join('/')

/** 폴더 선택(webkitdirectory)·파일 선택 공통. 경로는 webkitRelativePath가 있으면 그것, 없으면 이름이다. */
export function collectFiles(list: FileList | File[] | null | undefined): BulkFile[] {
  const files: BulkFile[] = []
  for (const file of Array.from(list ?? [])) {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    const path = normalizePath(relative)
    if (!path) continue
    files.push({ file, path, name: file.name, size: file.size })
  }
  return files
}

/**
 * 행의 고유 키. **폴더 이름으로 키를 만들지 않는다** — 행을 사이에 끼워 넣는 순간 그 아래 행들이
 * 통째로 다시 마운트되고, 그때 태그 입력의 조합 중인 글자가 사라진다.
 * crypto.randomUUID는 보안 컨텍스트에만 있다(사내 http 주소에서는 없다) — 세어서 만든다.
 */
let rowSeed = 0
export const newRowId = () => `map-${(rowSeed += 1)}-${Math.random().toString(36).slice(2, 8)}`
/** 서버에서 온 매핑처럼 rowId가 없는 행에 키를 채운다. 이미 있는 키는 그대로 둔다(행이 다시 마운트되지 않게). */
export const withRowIds = (rows: MappingRow[]): MappingRow[] => rows.map((row) => (row.rowId ? row : { ...row, rowId: newRowId() }))

/** 첫 번째 단계의 폴더 이름들. 매핑 표의 첫 행이 된다(사람이 더 깊은 행을 더할 수 있다). */
export function detectFolders(files: BulkFile[]): string[] {
  const folders = new Set<string>()
  for (const item of files) {
    const segments = item.path.split('/')
    folders.add(segments.length > 1 ? segments[0] : '')
  }
  return [...folders].sort((left, right) => left.localeCompare(right, 'ko'))
}

/** 서버 underPrefix와 같은 규칙. 'Flow/계약'이 'Flow/계약서/x.pdf'를 삼키지 않게 경계를 본다. */
export const matchesPrefix = (path: string, prefix: string) => !prefix || path === prefix || path.startsWith(`${prefix}/`)

/**
 * 미리보기의 파일 수. 서버 resolveMapping과 **같은 규칙**(가장 긴 접두가 이긴다)으로 센다.
 *
 * 행마다 startsWith로 세면 어느 행에도 걸리지 않은 파일이 어디에도 나타나지 않아
 * 표의 합이 고른 파일 수와 달라진다 — 그 파일들이 곧 '자료실(전 직원)'로 갈 파일이라
 * 정확히 그 사실이 보이지 않는 표가 된다. 남은 수를 unmapped로 돌려준다.
 */
export function countByMapping(files: BulkFile[], mapping: MappingRow[]): { counts: number[]; unmapped: number } {
  const counts = mapping.map(() => 0)
  let unmapped = 0
  for (const item of files) {
    let best = -1
    for (const [index, row] of mapping.entries()) {
      if (!matchesPrefix(item.path, row.folderPrefix)) continue
      if (best < 0 || row.folderPrefix.length > mapping[best].folderPrefix.length) best = index
    }
    if (best < 0) unmapped += 1
    else counts[best] += 1
  }
  return { counts, unmapped }
}

/**
 * 어느 행에도 걸리지 않는 파일이 있으면 그 첫 단계 폴더의 행을 **더한다**(기존 행은 그대로).
 *
 * 저장한 매핑을 불러오면 작년 폴더 이름이 담긴 행이 올해 폴더를 설명하지 못한다.
 * 그때 표를 그대로 두면 사람은 '이 표대로 간다'고 읽은 뒤 표에 없던 파일이 전 직원 자료실로
 * 가는 것을 보게 된다. 행을 더해 두면 적어도 **고칠 수 있는 자리**가 화면에 생긴다.
 */
export function appendUncoveredRows(mapping: MappingRow[], files: BulkFile[]): MappingRow[] {
  const uncovered = files.filter((item) => !mapping.some((row) => matchesPrefix(item.path, row.folderPrefix)))
  if (!uncovered.length) return withRowIds(mapping)
  const folders = detectFolders(uncovered).filter((folder) => !mapping.some((row) => row.folderPrefix === folder))
  return withRowIds([...mapping, ...folders.map((folder) => ({ folderPrefix: folder, projectId: null, tags: [], aiLevel: 'locked' as BulkAiLevel }))])
}

/**
 * 이 행 **바로 아래**의 하위 폴더들과 그 안의 파일 수.
 *
 * 왜 필요한가: webkitdirectory로 폴더를 고르면 모든 경로가 같은 첫 단계('Flow/…')를 갖는다.
 * 첫 단계만으로 표를 만들면 행이 하나뿐이라 'Flow/계약 → 프로젝트A, Flow/설계 → 프로젝트B'를
 * 화면에서 만들 수 없다 — 서버는 그 매핑을 이미 이해하는데(가장 긴 접두가 이긴다) 화면이 못 만들었다.
 * 파일만 있고 하위 폴더가 없는 행은 빈 배열을 돌려준다(나눌 것이 없으면 나누기 칸도 없다).
 */
export function childFolders(files: BulkFile[], prefix: string): Array<{ folderPrefix: string; files: number }> {
  const counts = new Map<string, number>()
  for (const item of files) {
    if (!matchesPrefix(item.path, prefix)) continue
    const rest = prefix ? item.path.slice(prefix.length + 1) : item.path
    const segments = rest.split('/').filter(Boolean)
    // 세그먼트가 하나면 이 폴더 **바로 아래의 파일**이다 — 하위 폴더가 아니다.
    if (segments.length < 2) continue
    const child = prefix ? `${prefix}/${segments[0]}` : segments[0]
    counts.set(child, (counts.get(child) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([folderPrefix, count]) => ({ folderPrefix, files: count }))
    .sort((left, right) => left.folderPrefix.localeCompare(right.folderPrefix, 'ko'))
}

/** 폴더 깊이(가장 깊은 파일 기준). '폴더 3단계'를 화면이 사실로 말할 수 있게 한다. */
export function folderDepth(files: BulkFile[]): number {
  let depth = 0
  for (const item of files) depth = Math.max(depth, item.path.split('/').length - 1)
  return depth
}

export const totalBytes = (files: BulkFile[]) => files.reduce((sum, item) => sum + item.size, 0)

export function humanBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '크기 확인 불가'
  // 0을 '1 KB'로 올려 적으면 아무것도 올리지 않은 보고서가 무언가를 올린 것처럼 보인다.
  if (size === 0) return '0 KB'
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`
}

/** 남은 시간. 최근 표본이 모자라면 **아예 말하지 않는다** — 틀린 숫자는 없느니만 못하다. */
export function remainingLabel(recentMs: number[], remaining: number): string {
  if (recentMs.length < 3 || remaining <= 0) return ''
  const average = recentMs.reduce((sum, value) => sum + value, 0) / recentMs.length
  const seconds = Math.round((average * remaining) / 1_000)
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  if (seconds < 60) return `남은 시간 약 ${seconds}초`
  return `남은 시간 약 ${Math.max(1, Math.round(seconds / 60))}분`
}

/** 매니페스트 한 묶음씩 끊어 준다. 서버 상한과 같은 값이라 413이 나지 않는다. */
export function manifestPages<T>(entries: T[]): T[][] {
  const pages: T[][] = []
  for (let index = 0; index < entries.length; index += MANIFEST_CHUNK) pages.push(entries.slice(index, index + MANIFEST_CHUNK))
  return pages
}

/** 쉼표로 나눈 태그. **제출·blur 시점에만 부른다** — onChange에서 쪼개면 한글 조합이 끊긴다(IME). */
export function splitTags(value: string): string[] {
  return [...new Set(value.split(',').map((tag) => tag.trim()).filter(Boolean))].slice(0, MAX_MAPPING_TAGS)
}

/**
 * 보내지 않을 파일을 미리 가른다 — 10MB 초과와 400자 초과.
 *
 * 왜 미리 가르는가: 둘 다 서버가 거절하는데, 크기는 그 파일 하나만 500이 되고 경로는 **그 페이지
 * 200건이 통째로** 400이 된다. 미리 빼면 나머지 199건은 정상으로 올라가고, 빠진 파일은 보고서의
 * '보내지 않은 파일' 목록에 이유와 함께 남는다(화면 어디에도 없는 파일을 만들지 않는다).
 */
export function splitSendable(files: BulkFile[]): { sendable: BulkFile[]; notSent: Array<BulkFile & { reason: string }> } {
  const sendable: BulkFile[] = []
  const notSent: Array<BulkFile & { reason: string }> = []
  for (const item of files) {
    if (item.size > MAX_BULK_FILE_BYTES) notSent.push({ ...item, reason: OVERSIZE_MESSAGE })
    else if (item.path.length > MAX_PATH_LENGTH) notSent.push({ ...item, reason: PATH_TOO_LONG_MESSAGE })
    else sendable.push(item)
  }
  return { sendable, notSent }
}

type DroppedEntry = {
  isFile: boolean
  isDirectory: boolean
  fullPath?: string
  name: string
  file?: (resolve: (file: File) => void, reject: (error: unknown) => void) => void
  createReader?: () => { readEntries: (resolve: (entries: DroppedEntry[]) => void, reject: (error: unknown) => void) => void }
}

const readEntriesOnce = (reader: ReturnType<NonNullable<DroppedEntry['createReader']>>) => (
  new Promise<DroppedEntry[]>((resolve) => { reader.readEntries((entries) => resolve(entries), () => resolve([])) })
)

/**
 * 끌어놓은 폴더를 훑는다.
 * readEntries는 **한 번에 100개만** 주므로 빈 배열이 올 때까지 반복해야 한다 —
 * 한 번만 부르고 끝내는 것이 이 API의 가장 흔한 버그이고, 증상은 '101번째 파일부터 조용히 사라짐'이다.
 */
export async function collectDroppedFiles(items: DataTransferItemList): Promise<BulkFile[]> {
  const roots: DroppedEntry[] = []
  for (const item of Array.from(items)) {
    const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => DroppedEntry | null }).webkitGetAsEntry?.()
    if (entry) roots.push(entry)
  }
  const files: BulkFile[] = []
  const walk = async (entry: DroppedEntry, prefix: string, depth: number): Promise<void> => {
    if (files.length >= MAX_DROP_ENTRIES || depth > MAX_DROP_DEPTH) return
    const path = normalizePath(prefix ? `${prefix}/${entry.name}` : entry.name)
    if (entry.isFile && entry.file) {
      const file = await new Promise<File | null>((resolve) => { entry.file?.((value) => resolve(value), () => resolve(null)) })
      if (file && path) files.push({ file, path, name: file.name, size: file.size })
      return
    }
    if (!entry.isDirectory || !entry.createReader) return
    const reader = entry.createReader()
    for (let guard = 0; guard < 200; guard += 1) {
      const batch = await readEntriesOnce(reader)
      if (!batch.length) break
      for (const child of batch) await walk(child, path, depth + 1)
      if (files.length >= MAX_DROP_ENTRIES) break
    }
  }
  for (const root of roots) await walk(root, '', 1)
  return files
}

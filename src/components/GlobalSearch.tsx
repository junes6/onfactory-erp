import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Clock3, FileText, HelpCircle, Lightbulb, ListChecks, MessageCircle, NotebookPen, Search, Sparkles, User, X } from 'lucide-react'

/**
 * 전역 검색.
 *
 * 찾는 것이 업무인지 문서인지 대화인지 미리 고르게 하지 않는다. 사람은 "그
 * 계약서"를 찾지 "문서 메뉴의 계약서"를 찾지 않는다. 결과는 유형별로 묶어
 * 배지를 달고, 누구 것인지 함께 보여 준다.
 *
 * 찾은 것을 다시 찾는 일이 잦으므로, 창을 열면 최근 검색어와 최근 연 항목부터 보여 준다.
 */

/** 서버 SEARCH_TYPES의 id와 같은 낱말. 여기 없는 값은 '기타'로 묶어 눈에 띄게 한다. */
export type SearchKind = 'task' | 'document' | 'journal' | 'message' | 'conversation' | 'opportunity' | 'person'

export type SearchHit = {
  /**
   * 유형. 서버가 `kind`로 내려보낸다.
   * 'other'는 서버 응답에는 없고, 화면이 모르는 값·빈 값을 옮겨 담을 때만 생긴다.
   * 타입에 정직하게 넣어 두어야 `as SearchKind`로 거짓말할 일이 없다.
   */
  kind: SearchKind | typeof OTHER_KIND
  /**
   * 옛 이름. 한 릴리스 동안 서버가 `kind`와 같은 값으로 함께 내려보낸다.
   * 화면은 더 이상 읽지 않고, localStorage에 남은 "최근 연 항목"을 옮길 때만 쓴다.
   */
  type?: string
  id: string
  title: string
  meta: string
  owner: string
  page: string
  focusId: string
  snippet: string
}

type SearchGroup = { kind: SearchKind | typeof OTHER_KIND; type?: string; label: string; items: SearchHit[] }

/**
 * kind가 비었거나 모르는 값인 항목을 모으는 그룹.
 *
 * 조용히 다른 유형에 섞거나 버리면 서버·화면이 어긋난 걸 아무도 못 알아챈다.
 * 화면에 '기타'로 드러나야 고칠 수 있다.
 */
const OTHER_KIND = 'other'
const OTHER_LABEL = '기타'

/**
 * 갈래별 한국어 이름. 서버 SEARCH_TYPES의 label과 같은 말이다.
 *
 * 그룹 이름은 서버가 준 label을 그대로 쓰지만, 그룹 kind와 항목 kind가 어긋나
 * 항목이 다른 그룹으로 옮겨 가면 그 그룹은 이름이 없다. 그때 'journal' 같은
 * 영문 id가 사용자에게 보이지 않도록 여기서 이름을 댄다.
 * 서버에 갈래를 더하고 여기를 잊으면 server/global-search.test.mjs 가 잡는다.
 */
const KIND_LABEL: Record<SearchKind, string> = {
  task: '업무',
  document: '문서',
  journal: '일지',
  message: '메신저',
  conversation: 'AI 대화',
  opportunity: '기회',
  person: '인물',
}

const KIND_ICON: Record<string, typeof ListChecks> = {
  task: ListChecks,
  document: FileText,
  journal: NotebookPen,
  message: MessageCircle,
  conversation: Sparkles,
  opportunity: Lightbulb,
  person: User,
  [OTHER_KIND]: HelpCircle,
}

const KNOWN_KINDS: ReadonlySet<string> = new Set(Object.keys(KIND_ICON).filter((kind) => kind !== OTHER_KIND))

/** 서버 갈래로 알려진 값인지. 타입 단언 대신 좁히기로 확인해야 낯선 값이 조용히 통과하지 않는다. */
function isSearchKind(value: unknown): value is SearchKind {
  return typeof value === 'string' && KNOWN_KINDS.has(value)
}

/**
 * 항목의 유형. `kind`만 본다 — 비어 있거나 모르는 값이면 '기타'로 돌린다.
 * 여기서 옛 `type`으로 슬쩍 대신하면 서버가 kind를 빼먹은 걸 아무도 못 알아챈다.
 */
function kindOf(hit: Pick<SearchHit, 'kind'>): SearchKind | typeof OTHER_KIND {
  return isSearchKind(hit.kind) ? hit.kind : OTHER_KIND
}

/** 지난 릴리스가 localStorage에 `type`으로 남긴 항목만 `kind`로 옮긴다. 서버 응답에는 쓰지 않는다. */
function migrateStoredHit(item: SearchHit): SearchHit {
  // localStorage에서 온 값이라 타입을 믿을 수 없다 — 좁히기로 걸러 낯선 값은 '기타'로 보낸다.
  const legacy: unknown = item.kind ?? item.type
  return { ...item, kind: isSearchKind(legacy) ? legacy : OTHER_KIND }
}

/**
 * 서버가 준 그룹을 kind 기준으로 다시 묶는다.
 *
 * 그룹의 kind와 항목의 kind가 어긋나거나 항목의 kind가 비었으면 그 항목은 '기타'
 * 그룹으로 빠진다. 서버를 믿고 그대로 그리면 어긋난 항목이 남의 배지를 달고 나온다.
 */
function regroup(groups: SearchGroup[]): SearchGroup[] {
  const buckets = new Map<string, SearchGroup>()
  for (const group of groups) {
    for (const item of group.items ?? []) {
      const kind = kindOf(item)
      // 서버가 준 label이 우선. 그룹과 어긋나 옮겨 온 항목은 사전에서 이름을 대고, 그마저 없으면 '기타'.
      const label = kind === OTHER_KIND ? OTHER_LABEL : (group.kind === kind ? group.label : undefined) ?? KIND_LABEL[kind] ?? OTHER_LABEL
      const bucket = buckets.get(kind) ?? { kind, label, items: [] }
      bucket.items.push(item)
      buckets.set(kind, bucket)
    }
  }
  // '기타'는 맨 뒤. 정상 갈래 사이에 끼면 무엇이 잘못됐는지 오히려 덜 보인다.
  return [...buckets.values()].sort((a, b) => Number(a.kind === OTHER_KIND) - Number(b.kind === OTHER_KIND))
}

const RECENT_QUERY_KEY = 'inthefield.search.queries'
const RECENT_OPEN_KEY = 'inthefield.search.opens'
const RECENT_LIMIT = 6

function readRecent<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.slice(0, RECENT_LIMIT) : []
  } catch {
    // 저장소를 막아 둔 브라우저에서도 검색 자체는 되어야 한다.
    return []
  }
}

function writeRecent<T>(key: string, next: T[]) {
  try { localStorage.setItem(key, JSON.stringify(next.slice(0, RECENT_LIMIT))) } catch { /* 못 적어도 그만이다 */ }
}

type Props = {
  workspaceScope?: string
  placeholder: string
  onOpen: (hit: SearchHit) => void
}

export default function GlobalSearch({ workspaceScope, placeholder, onOpen }: Props) {
  const [query, setQuery] = useState('')
  const [groups, setGroups] = useState<SearchGroup[]>([])
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(-1)
  const [loading, setLoading] = useState(false)
  const [recentQueries, setRecentQueries] = useState<string[]>(() => readRecent<string>(RECENT_QUERY_KEY))
  // 지난 릴리스가 저장한 "최근 연 항목"은 `type`만 들고 있다. 읽을 때 `kind`로 옮겨 준다.
  const [recentOpens, setRecentOpens] = useState<SearchHit[]>(() => readRecent<SearchHit>(RECENT_OPEN_KEY).map(migrateStoredHit))
  const inputRef = useRef<HTMLInputElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  // 슬래시 하나로 검색창에 간다. 글을 쓰는 중일 때는 가로채지 않는다.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if ((event.key === 'k' || event.key === 'K') && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        inputRef.current?.focus()
        return
      }
      if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const onClickAway = (event: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickAway)
    return () => document.removeEventListener('mousedown', onClickAway)
  }, [])

  const run = useCallback(async (value: string) => {
    if (!workspaceScope || value.trim().length < 2) { setGroups([]); return }
    setLoading(true)
    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(value.trim())}`, { headers: { 'x-workspace-identity': workspaceScope } })
      if (!response.ok) { setGroups([]); return }
      const body = await response.json() as { groups: SearchGroup[] }
      setGroups(regroup(body.groups ?? []))
    } catch {
      setGroups([])
    } finally {
      setLoading(false)
    }
  }, [workspaceScope])

  useEffect(() => {
    // 글자마다 서버를 부르면 결과가 깜빡이고 서버도 헛돈다.
    const timer = setTimeout(() => { void run(query) }, 220)
    return () => clearTimeout(timer)
  }, [query, run])

  /** 화살표로 훑을 수 있게 그룹을 한 줄로 편다. */
  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups])
  useEffect(() => { setCursor(flat.length ? 0 : -1) }, [flat.length])

  const remember = (hit: SearchHit) => {
    const nextOpens = [hit, ...recentOpens.filter((item) => item.id !== hit.id)].slice(0, RECENT_LIMIT)
    setRecentOpens(nextOpens)
    writeRecent(RECENT_OPEN_KEY, nextOpens)
    if (query.trim()) {
      const nextQueries = [query.trim(), ...recentQueries.filter((item) => item !== query.trim())].slice(0, RECENT_LIMIT)
      setRecentQueries(nextQueries)
      writeRecent(RECENT_QUERY_KEY, nextQueries)
    }
  }

  const choose = (hit: SearchHit) => {
    remember(hit)
    setOpen(false)
    setQuery('')
    setGroups([])
    onOpen(hit)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') { setOpen(false); inputRef.current?.blur(); return }
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown') { event.preventDefault(); setCursor((current) => (flat.length ? (current + 1) % flat.length : -1)); return }
    if (event.key === 'ArrowUp') { event.preventDefault(); setCursor((current) => (flat.length ? (current - 1 + flat.length) % flat.length : -1)); return }
    if (event.key === 'Enter' && cursor >= 0 && flat[cursor]) { event.preventDefault(); choose(flat[cursor]) }
  }

  const showRecent = open && query.trim().length < 2 && (recentQueries.length > 0 || recentOpens.length > 0)
  const showResults = open && query.trim().length >= 2
  let rowIndex = -1

  return (
    <div className="global-search" ref={boxRef}>
      <Search size={19} />
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => { setQuery(event.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={showResults || showRecent}
        aria-controls="search-results"
        aria-autocomplete="list"
        aria-activedescendant={cursor >= 0 && flat[cursor] ? `search-hit-${cursor}` : undefined}
      />
      {query && <button type="button" aria-label="검색어 지우기" onClick={() => { setQuery(''); inputRef.current?.focus() }}><X size={16} /></button>}

      {showRecent && (
        <div className="search-popover" id="search-results" role="listbox">
          {recentQueries.length > 0 && (
            <div className="search-group">
              <p className="search-group-head"><Clock3 size={13} /> 최근 검색어</p>
              <div className="search-chips">
                {recentQueries.map((item) => (
                  <button type="button" key={item} className="search-chip" onClick={() => { setQuery(item); inputRef.current?.focus() }}>{item}</button>
                ))}
              </div>
            </div>
          )}
          {recentOpens.length > 0 && (
            <div className="search-group">
              <p className="search-group-head"><Clock3 size={13} /> 최근 연 항목</p>
              {recentOpens.map((item) => {
                const Icon = KIND_ICON[kindOf(item)]
                return (
                  <button type="button" role="option" aria-selected="false" key={item.id} onClick={() => choose(item)}>
                    <span><Icon size={17} /></span>
                    <div><strong>{item.title}</strong><small>{item.meta}</small></div>
                    <ArrowRight size={15} />
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}

      {showResults && (
        <div className="search-popover" id="search-results" role="listbox">
          {loading && flat.length === 0 && <p className="search-empty">찾는 중…</p>}
          {!loading && flat.length === 0 && <p className="search-empty">“{query.trim()}”에 걸리는 것이 없습니다. 낱말을 줄여 보세요.</p>}
          {groups.map((group) => (
            <div className="search-group" key={group.kind}>
              <p className="search-group-head"><span className={`search-badge kind-${group.kind}`}>{group.label}</span> {group.items.length}건</p>
              {group.items.map((item) => {
                rowIndex += 1
                const index = rowIndex
                const Icon = KIND_ICON[kindOf(item)]
                return (
                  <button
                    type="button"
                    role="option"
                    id={`search-hit-${index}`}
                    aria-selected={cursor === index}
                    className={cursor === index ? 'is-cursor' : undefined}
                    key={item.id}
                    onMouseEnter={() => setCursor(index)}
                    onClick={() => choose(item)}
                  >
                    <span><Icon size={17} /></span>
                    <div>
                      <strong>{item.title}</strong>
                      <small>{[item.meta, item.owner].filter(Boolean).join(' · ')}</small>
                      {item.snippet && <em className="search-snippet">{item.snippet}</em>}
                    </div>
                    <ArrowRight size={15} />
                  </button>
                )
              })}
            </div>
          ))}
          <p className="search-hint">↑↓ 이동 · Enter 열기 · Esc 닫기</p>
        </div>
      )}
    </div>
  )
}

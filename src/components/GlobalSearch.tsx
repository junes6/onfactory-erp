import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Clock3, FileText, Lightbulb, ListChecks, MessageCircle, NotebookPen, Search, Sparkles, User, X } from 'lucide-react'

/**
 * 전역 검색.
 *
 * 찾는 것이 업무인지 문서인지 대화인지 미리 고르게 하지 않는다. 사람은 "그
 * 계약서"를 찾지 "문서 메뉴의 계약서"를 찾지 않는다. 결과는 유형별로 묶어
 * 배지를 달고, 누구 것인지 함께 보여 준다.
 *
 * 찾은 것을 다시 찾는 일이 잦으므로, 창을 열면 최근 검색어와 최근 연 항목부터 보여 준다.
 */

export type SearchHit = {
  type: string
  id: string
  title: string
  meta: string
  owner: string
  page: string
  focusId: string
  snippet: string
}

type SearchGroup = { type: string; label: string; items: SearchHit[] }

const TYPE_ICON: Record<string, typeof ListChecks> = {
  task: ListChecks,
  document: FileText,
  journal: NotebookPen,
  message: MessageCircle,
  conversation: Sparkles,
  opportunity: Lightbulb,
  person: User,
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
  const [recentOpens, setRecentOpens] = useState<SearchHit[]>(() => readRecent<SearchHit>(RECENT_OPEN_KEY))
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
      setGroups(body.groups ?? [])
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
                const Icon = TYPE_ICON[item.type] ?? FileText
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
            <div className="search-group" key={group.type}>
              <p className="search-group-head"><span className={`search-badge type-${group.type}`}>{group.label}</span> {group.items.length}건</p>
              {group.items.map((item) => {
                rowIndex += 1
                const index = rowIndex
                const Icon = TYPE_ICON[item.type] ?? FileText
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

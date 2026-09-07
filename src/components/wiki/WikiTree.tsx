import { useMemo, useState } from 'react'
import { Archive, ChevronRight, FileText, Search } from 'lucide-react'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/States'
import { MAX_TREE_DEPTH_UI } from './wikiBlocks'

/**
 * 왼쪽 문서 목록.
 *
 * `role="tree"`를 쓰지 않는다. 진짜 트리 롤은 roving tabindex와 타입어헤드를 함께 요구하는데,
 * 그것 없이 롤만 붙이면 스크린리더에게 지키지 못할 약속을 하는 셈이다. 대신 평범한
 * `nav > ul > li > button`과 `<details>`로 그린다 — 브라우저가 이미 잘 하는 것을 다시 만들지 않는다.
 *
 * 3단까지만 접었다 폈다 하고 그보다 깊은 문서는 부모 본문 아래의 '하위 문서'와 검색에서 나온다.
 * 무한히 중첩하면 왼쪽 260px 안에서 제목이 두 글자만 남는다.
 */

export type WikiTreeItem = {
  id: string
  title: string
  icon: string
  parentId: string | null
  projectId: string | null
  childCount: number
  version: number
  blockCount: number
  lastEditedAt: string | null
  lastEditedByName: string
  archivedAt: string | null
  excerpt: string
}

export function WikiTree({ items, activeId, archivedMode, changedIds, query, onQuery, onSelect, onToggleArchived, onCreate, canCreate, loading }: {
  items: readonly WikiTreeItem[]
  activeId: string | null
  archivedMode: boolean
  /** 남이 방금 고친 문서. 지금 열지 않은 문서는 본문을 다시 읽지 않고 점만 찍는다. */
  changedIds: ReadonlySet<string>
  query: string
  onQuery: (value: string) => void
  onSelect: (id: string) => void
  onToggleArchived: () => void
  onCreate: () => void
  canCreate: boolean
  loading: boolean
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>())
  const byParent = useMemo(() => {
    const grouped = new Map<string, WikiTreeItem[]>()
    const known = new Set(items.map((item) => item.id))
    for (const item of items) {
      // 부모가 이 목록에 없으면(권한 밖이거나 보관됨) 뿌리로 올린다 — 안 그러면 통째로 사라진다.
      const key = item.parentId && known.has(item.parentId) ? item.parentId : ''
      grouped.set(key, [...(grouped.get(key) ?? []), item])
    }
    return grouped
  }, [items])

  const toggle = (id: string) => setCollapsed((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const renderLevel = (parentId: string, depth: number) => {
    const rows = byParent.get(parentId) ?? []
    if (!rows.length) return null
    return (
      <ul className="wiki-tree-list" data-depth={depth}>
        {rows.map((item) => {
          const children = byParent.get(item.id) ?? []
          const deeper = depth + 1 < MAX_TREE_DEPTH_UI && children.length > 0
          const open = deeper && !collapsed.has(item.id)
          return (
            <li key={item.id}>
              <div className="wiki-tree-row">
                {deeper ? (
                  <button
                    type="button"
                    className={open ? 'wiki-tree-twist is-open' : 'wiki-tree-twist'}
                    aria-label={`${item.title || '제목 없는 문서'} 하위 ${open ? '접기' : '펼치기'}`}
                    aria-expanded={open}
                    onClick={() => toggle(item.id)}
                  ><ChevronRight size={14} /></button>
                ) : <span className="wiki-tree-twist is-empty" aria-hidden="true" />}
                <button
                  type="button"
                  className="wiki-tree-link"
                  aria-current={item.id === activeId ? 'page' : undefined}
                  onClick={() => onSelect(item.id)}
                >
                  <span className="wiki-tree-icon" aria-hidden="true">{item.icon || <FileText size={14} />}</span>
                  <span className="wiki-tree-title">{item.title || '제목 없는 문서'}</span>
                  {changedIds.has(item.id) && item.id !== activeId && (
                    <span className="wiki-tree-dot" title="방금 바뀌었습니다"><span className="sr-only">방금 바뀜</span></span>
                  )}
                </button>
              </div>
              {open && renderLevel(item.id, depth + 1)}
            </li>
          )
        })}
      </ul>
    )
  }

  return (
    <nav className="wiki-tree" aria-label="문서 목록">
      <div className="wiki-tree-head">
        <label className="wiki-tree-search">
          <Search size={15} aria-hidden="true" />
          <span className="sr-only">문서 제목·본문 검색</span>
          <input value={query} placeholder="문서 찾기" onChange={(event) => onQuery(event.target.value)} />
        </label>
        {canCreate && <Button tone="quiet" size="sm" onClick={onCreate}>새 문서</Button>}
      </div>
      {loading ? <p className="wiki-tree-note" role="status">불러오는 중…</p>
        : items.length === 0
          ? <EmptyState
              title={archivedMode ? '보관한 문서가 없습니다' : query ? '찾는 문서가 없습니다' : '아직 문서가 없습니다'}
              description={archivedMode ? '보관하면 여기로 옵니다.' : query ? '다른 낱말로 찾아 보세요.' : '회의 기록·절차·기준을 한곳에 모아 두는 자리입니다.'}
            />
          : renderLevel('', 0)}
      <button type="button" className="wiki-tree-archive" onClick={onToggleArchived}>
        <Archive size={14} aria-hidden="true" /> {archivedMode ? '문서 목록으로' : '보관함 보기'}
      </button>
    </nav>
  )
}

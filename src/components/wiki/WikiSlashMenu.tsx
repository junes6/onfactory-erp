import { CheckSquare, Code2, FileUp, Hash, Image, List, ListOrdered, Minus, Quote, Table, Type } from 'lucide-react'
import type { BlockType } from './wikiBlocks'

/**
 * `/` 블록 메뉴와 `@` 연결 자동완성.
 *
 * 목록 DOM은 메신저의 멘션 목록과 같은 모양(`ul[role=listbox] > li > button[role=option]`)이다.
 * 일부러 복제했다 — 공용 훅으로 뽑으면 메신저 쪽 문자열을 건드리게 되고, 그 문자열은 다른 계약이
 * 고정하고 있다. 뽑는 일은 뒤로 미룬다.
 *
 * `onMouseDown`에서 `preventDefault`를 부르는 것이 이 두 목록의 핵심이다. 그러지 않으면 누르는
 * 순간 편집 상자가 초점을 잃고, 조합 중이던 한글이 확정되지 않은 채 사라진다.
 */

export type SlashItem = { type: BlockType; label: string; hint: string; icon: typeof Type }

/**
 * 블록 종류의 이름. 특정 업무 어휘를 쓰지 않는다 — 이 메뉴는 어떤 종류의 문서에서도 같다.
 */
export const SLASH_ITEMS: readonly SlashItem[] = [
  { type: 'text', label: '본문', hint: '보통 문단', icon: Type },
  { type: 'heading', label: '제목', hint: '구획을 나눈다', icon: Hash },
  { type: 'bulleted', label: '글머리 목록', hint: '순서 없는 목록', icon: List },
  { type: 'numbered', label: '번호 목록', hint: '순서 있는 목록', icon: ListOrdered },
  { type: 'todo', label: '체크 목록', hint: '해야 할 일', icon: CheckSquare },
  { type: 'quote', label: '인용', hint: '옮겨 적은 말', icon: Quote },
  { type: 'code', label: '코드', hint: '고정폭 여러 줄', icon: Code2 },
  { type: 'table', label: '표', hint: '행과 열', icon: Table },
  { type: 'image', label: '이미지', hint: '자료실에 올려 붙인다', icon: Image },
  { type: 'file', label: '파일', hint: '자료실에 올려 붙인다', icon: FileUp },
  { type: 'divider', label: '구분선', hint: '가로 줄', icon: Minus },
]

export function slashMatches(query: string) {
  const word = query.trim().toLowerCase()
  if (!word) return SLASH_ITEMS
  return SLASH_ITEMS.filter((item) => `${item.label} ${item.hint} ${item.type}`.toLowerCase().includes(word))
}

export function WikiSlashMenu({ items, activeIndex, onPick, label }: {
  items: readonly SlashItem[]
  activeIndex: number
  onPick: (item: SlashItem) => void
  label: string
}) {
  if (!items.length) return null
  return (
    <ul className="wiki-menu" role="listbox" aria-label={label}>
      {items.map((item, index) => (
        <li key={item.type}>
          <button
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            className={index === activeIndex ? 'is-active' : undefined}
            onMouseDown={(event) => { event.preventDefault(); onPick(item) }}
          >
            <span className="wiki-menu-icon" aria-hidden="true"><item.icon size={15} /></span>
            <strong>{item.label}</strong>
            <small>{item.hint}</small>
          </button>
        </li>
      ))}
    </ul>
  )
}

export type LinkCandidate = { kind: 'doc' | 'task' | 'person'; id: string; title: string; meta: string }

/**
 * `@`로 부르는 연결 후보. 문서·업무·사람 세 구획을 한 목록에 담되 구획 이름을 붙여 준다 —
 * 이름이 겹치는 업무와 사람을 가릴 방법이 그것뿐이다.
 */
export function WikiLinkMenu({ candidates, activeIndex, onPick, query, loading }: {
  candidates: readonly LinkCandidate[]
  activeIndex: number
  onPick: (candidate: LinkCandidate) => void
  query: string
  loading: boolean
}) {
  if (loading) return <p className="wiki-menu-empty" role="status">찾는 중…</p>
  if (!candidates.length) return <p className="wiki-menu-empty" role="status">{`"${query}"와 연결할 것을 찾지 못했습니다.`}</p>
  const kindLabel = (kind: LinkCandidate['kind']) => (kind === 'doc' ? '문서' : kind === 'task' ? '업무' : '사람')
  return (
    <ul className="wiki-menu" role="listbox" aria-label={`"${query}" 연결 후보`}>
      {candidates.map((candidate, index) => (
        <li key={`${candidate.kind}:${candidate.id}`}>
          <button
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            className={index === activeIndex ? 'is-active' : undefined}
            onMouseDown={(event) => { event.preventDefault(); onPick(candidate) }}
          >
            <span className="wiki-menu-kind" aria-hidden="true">{kindLabel(candidate.kind)}</span>
            <strong>{candidate.title}</strong>
            <small>{candidate.meta}</small>
          </button>
        </li>
      ))}
    </ul>
  )
}

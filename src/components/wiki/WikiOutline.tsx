/**
 * 목차. 본문의 제목 블록에서 그때그때 파생한다 — 저장하지 않는다.
 *
 * 저장하면 본문과 목차가 두 개의 진실이 되고, 병합이 본문만 고친 순간 목차가 낡는다.
 * 제목이 하나도 없으면 아무것도 그리지 않는다(빈 상자는 "여기 뭔가 있어야 하는데"라는 인상만 준다).
 */

export type OutlineEntry = { id: string; level: number; text: string }

export function WikiOutline({ entries, activeId, onJump }: {
  entries: readonly OutlineEntry[]
  activeId: string | null
  onJump: (blockId: string) => void
}) {
  if (entries.length < 2) return null
  return (
    <nav className="wiki-outline" aria-label="문서 목차">
      <h3>목차</h3>
      <ul>
        {entries.map((entry) => (
          <li key={entry.id} data-level={Math.min(3, Math.max(1, entry.level))}>
            <button
              type="button"
              aria-current={entry.id === activeId ? 'true' : undefined}
              onClick={() => onJump(entry.id)}
            >{entry.text || '제목 없음'}</button>
          </li>
        ))}
      </ul>
    </nav>
  )
}

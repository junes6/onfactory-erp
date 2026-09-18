import type { ReactNode } from 'react'
import { BookOpen, Layers, Mic } from 'lucide-react'
import './materials/Materials.css'

/**
 * 문서 메뉴 하나에 세 갈래를 탭으로 둔다: 문서 · 회의록 · 검토 자료.
 * 전에는 "문서"와 "회의록"이 따로 메뉴였다 — 회의록도 결국 문서를 만들고 문서 화면으로 보냈으므로
 * 사람은 "회의 내용이 어디 있지?"를 두 곳에서 찾아야 했다. 옛 회의록 주소는 이 허브의 회의록 탭으로 온다.
 */
export type DocumentsTab = 'docs' | 'meetings' | 'materials'

const TABS: ReadonlyArray<{ id: DocumentsTab; label: string; icon: typeof BookOpen }> = [
  { id: 'docs', label: '문서', icon: BookOpen },
  { id: 'meetings', label: '회의록', icon: Mic },
  { id: 'materials', label: '검토 자료', icon: Layers },
]

export function DocumentsHub({ tab, onTabChange, docs, meetings, materials }: {
  tab: DocumentsTab
  onTabChange: (tab: DocumentsTab) => void
  docs: ReactNode
  meetings: ReactNode
  materials: ReactNode
}) {
  return (
    <div className="documents-hub">
      <div className="documents-hub-tabs" role="tablist" aria-label="문서 종류">
        {TABS.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`documents-tab-${item.id}`}
              aria-selected={tab === item.id}
              aria-controls={`documents-panel-${item.id}`}
              onClick={() => onTabChange(item.id)}
            >
              <Icon size={18} aria-hidden="true" /> {item.label}
            </button>
          )
        })}
      </div>
      <div role="tabpanel" id={`documents-panel-${tab}`} aria-labelledby={`documents-tab-${tab}`}>
        {tab === 'docs' ? docs : tab === 'meetings' ? meetings : materials}
      </div>
    </div>
  )
}

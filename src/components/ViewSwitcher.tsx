import { CalendarDays, Columns3, List, Rows3 } from 'lucide-react'

/**
 * 같은 목록을 어떻게 볼 것인가 — 공용 보기 스위처.
 *
 * 왜 role="tablist"가 아닌가: 탭은 '무엇을 보는가'(업무 vs 반복 규칙)이고 이것은 '어떻게 보는가'다.
 * 두 축을 같은 역할로 그리면 스크린리더에서 탭 두 벌이 겹쳐 읽힌다. 공용 .segmented가
 * [aria-pressed='true']에도 활성 스타일을 주므로 새 CSS는 배치 한 줄뿐이다.
 *
 * 왜 lucide의 간트 아이콘을 쓰지 않는가: 지시가 '간트차트를 만들지 마라'이므로
 * 아이콘 이름조차 피한다. 타임라인은 Rows3다.
 */

export type WorkViewMode = 'list' | 'board' | 'calendar' | 'timeline'

const LABEL: Record<WorkViewMode, string> = { list: '목록', board: '보드', calendar: '캘린더', timeline: '타임라인' }
const ICON: Record<WorkViewMode, typeof List> = { list: List, board: Columns3, calendar: CalendarDays, timeline: Rows3 }

export function ViewSwitcher({ modes, value, onChange, label = '보기 방식' }: {
  modes: readonly WorkViewMode[]
  value: WorkViewMode
  onChange: (mode: WorkViewMode) => void
  label?: string
}) {
  return <div className="segmented view-switcher" role="group" aria-label={label}>
    {modes.map((mode) => {
      const Icon = ICON[mode]
      return <button type="button" key={mode} aria-pressed={value === mode} onClick={() => onChange(mode)}>
        <Icon size={16} /> {LABEL[mode]}
      </button>
    })}
  </div>
}

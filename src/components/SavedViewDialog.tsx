import { useState } from 'react'
import { X } from 'lucide-react'
import { Button, IconButton } from './ui/Button'
import { useDialogFocus } from './CompletionModal'
import type { CustomFieldDefinition } from './CustomFieldInputs'
import type { WorkViewMode } from './ViewSwitcher'
import { describeFilters, type FilterNames, type WorkFilters } from '../utils/workViews'

/**
 * 보기를 이름으로 남기는 대화상자.
 *
 * 이름 자동 제안: 대화상자를 열면 이름 칸에 조건을 사람 말로 적은 기본값이 들어 있다.
 * 이름 짓기는 저장의 가장 큰 마찰이고, 지우고 쓰는 것이 백지에서 짓는 것보다 언제나 쉽다.
 *
 * 전사 공유 라디오에 disabled를 쓰지 않는 이유: disabled는 포커스도 사유도 함께 지운다.
 * aria-disabled로 '지금은 고를 수 없다'만 말하고, 왜 그런지는 바로 아래 한 줄이 적는다.
 * 실제로 눌러도 값이 바뀌지 않는다 — aria-disabled는 정말로 거절하는 컨트롤에만 붙는다.
 */

export const SAVED_VIEW_COLUMN_LABELS: Record<string, string> = {
  owner: '담당', project: '프로젝트', parent: '상위 업무', category: '분류', priority: '우선순위', startAt: '시작일', origin: '출처',
}
const MAX_COLUMNS = 3
/**
 * 서버 saved-views.mjs의 MAX_NAME_LENGTH와 같은 값이다.
 * maxLength는 사람이 치는 글자만 막는다 — 화면이 스스로 넣은 제안 이름은 여기서 함께 자르지 않으면
 * 축이 네댓 개인 조건에서 40자를 넘겨 저장이 400으로 떨어진다(사람은 이름 칸이 멀쩡해 보여 이유를 알 수 없다).
 */
export const SAVED_VIEW_NAME_MAX = 40

const MODE_LABEL: Record<WorkViewMode, string> = { list: '목록', board: '보드', calendar: '캘린더', timeline: '타임라인' }

export function SavedViewDialog({ mode, filters, columns, definitions = [], names = {}, canShare, busy = false, initialName, initialVisibility = 'private', title = '이 보기 저장', onClose, onSubmit }: {
  mode: WorkViewMode
  filters: WorkFilters
  columns: string[]
  definitions?: CustomFieldDefinition[]
  names?: FilterNames
  /** 전사 공유는 관리자 행위다. 서버도 같은 말(SAVED_VIEW_SHARE_FORBIDDEN)을 한다. */
  canShare: boolean
  busy?: boolean
  initialName?: string
  initialVisibility?: 'private' | 'tenant'
  title?: string
  onClose: () => void
  onSubmit: (input: { name: string; visibility: 'private' | 'tenant'; columns: string[] }) => void
}) {
  const dialogRef = useDialogFocus()
  const suggestion = (initialName ?? [describeFilters(filters, names), MODE_LABEL[mode]].filter(Boolean).join(' · ')).slice(0, SAVED_VIEW_NAME_MAX)
  const [name, setName] = useState(suggestion)
  const [visibility, setVisibility] = useState<'private' | 'tenant'>(initialVisibility)
  const [picked, setPicked] = useState<string[]>(columns)

  const available = [
    ...Object.keys(SAVED_VIEW_COLUMN_LABELS).map((key) => ({ key, label: SAVED_VIEW_COLUMN_LABELS[key] })),
    ...definitions.filter((definition) => !definition.archivedAt).map((definition) => ({ key: `cf:${definition.key}`, label: definition.label })),
  ]
  /**
   * 화면에 그려지지 않는 칸은 세지 않는다. 보관된 항목을 실어 온 보기를 열면 체크된 칸은 하나뿐인데
   * 나머지가 전부 '최대 3개'로 거절당하는 화면이 됐다(보이지 않는 두 키가 자리를 차지하고 있었다).
   *
   * 다만 **보관된 것만** 덜어 낸다: 정의 목록이 아직 도착하지 않았을 때(useCustomFields는 빈 배열로 시작한다)
   * 모든 cf: 키가 '안 보이는 것'이 되므로, 거기서 함께 지우면 사람이 손대지도 않은 보조줄이 저장 한 번에 사라진다.
   * 세는 곳·거절하는 곳·저장하는 곳이 이 한 함수를 함께 쓴다.
   */
  const archived = (key: string) => key.startsWith('cf:') && definitions.some((definition) => definition.key === key.slice(3) && definition.archivedAt)
  const livePicked = (list: string[]) => list.filter((key) => !archived(key))
  const full = livePicked(picked).length >= MAX_COLUMNS
  const toggleColumn = (key: string) => setPicked((current) => {
    if (current.includes(key)) return current.filter((entry) => entry !== key)
    // 정말로 거절한다 — 위의 aria-disabled가 거짓말이 되지 않게.
    if (livePicked(current).length >= MAX_COLUMNS) return current
    return [...current, key]
  })

  const submit = () => {
    // 다듬는 것은 제출하는 이 순간에만. onChange에서 자르면 한글 IME가 끊긴다.
    const trimmed = name.trim()
    if (!trimmed || busy) return
    // 보관된 항목의 키는 저장하지 않는다 — 서버는 패턴만 보고 받아 주지만 목록의 보조줄은 그 키를 조용히 건너뛰어,
    // 고른 것보다 적게 그려지는 보기가 남는다.
    onSubmit({ name: trimmed, visibility, columns: livePicked(picked) })
  }

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section ref={dialogRef} className="modal-card workflow-modal" role="dialog" aria-modal="true" aria-labelledby="saved-view-title">
      <header>
        <div><span className="eyebrow">SAVED VIEW</span><h2 id="saved-view-title">{title}</h2><p>지금의 보기 방식·필터·정렬·보조줄을 한 이름으로 묶습니다.</p></div>
        <IconButton tone="ghost" type="button" aria-label="닫기" onClick={onClose}><X size={21} /></IconButton>
      </header>
      <div className="saved-view-form">
        <label className="form-field"><span>이름 <em>필수</em></span>
          <input
            type="text"
            data-autofocus
            value={name}
            maxLength={SAVED_VIEW_NAME_MAX}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              // 한글 조합 중의 Enter는 글자를 확정하는 키다 — 그때 저장하면 마지막 글자가 잘린다.
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); submit() }
            }}
          /></label>

        <fieldset className="saved-view-visibility">
          <legend>공개 범위</legend>
          <label>
            <input type="radio" name="saved-view-visibility" checked={visibility === 'private'} onChange={() => setVisibility('private')} />
            <span>나만 봅니다</span>
          </label>
          <label aria-disabled={!canShare}>
            <input
              type="radio"
              name="saved-view-visibility"
              checked={visibility === 'tenant'}
              aria-disabled={!canShare}
              onChange={() => { if (canShare) setVisibility('tenant') }}
            />
            <span>회사 전체가 봅니다</span>
          </label>
          {!canShare && <small>회사 전체 공유는 관리자가 만듭니다.</small>}
        </fieldset>

        <fieldset className="saved-view-columns">
          <legend>보조 1줄에 넣을 것 <small>최대 {MAX_COLUMNS}개</small></legend>
          {available.map((column) => {
            const checked = picked.includes(column.key)
            return <label key={column.key} aria-disabled={!checked && full}>
              <input type="checkbox" checked={checked} aria-disabled={!checked && full} onChange={() => toggleColumn(column.key)} />
              <span>{column.label}</span>
            </label>
          })}
        </fieldset>
      </div>
      <footer>
        <Button tone="ghost" type="button" onClick={onClose}>취소</Button>
        <Button tone="primary" type="button" disabled={busy || !name.trim()} onClick={submit}>저장</Button>
      </footer>
    </section>
  </div>
}

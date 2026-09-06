import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Archive, ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react'
import { Button, IconButton } from './ui/Button'
import { StatusBadge } from './StatusBadge'
import { useDialogFocus } from './CompletionModal'
import { customFieldValue } from '../utils/workViews'
import type { WorkItem } from '../domainData'

/**
 * 업무 커스텀 필드 — 관리자가 정의하고, 담당자·지시자가 값을 채운다.
 *
 * 세 자리에 나타난다: 필터 바의 '항목 관리'(정의), 새 업무 지시의 접힌 선택 항목(값),
 * 상세 드로어의 '추가 정보'(값). 정의 관리 입구를 필터 바에 둔 이유는 하나다 —
 * '이걸로 거르고 싶은데 축이 없다'가 커스텀 필드를 필요로 하는 유일한 순간이기 때문이다.
 *
 * 값 타입은 string | number 둘뿐이다. number를 type="number"로 받지 않는 이유:
 * 한글 IME 조합 중 값이 튀고, 마우스 휠이 지나가기만 해도 값이 바뀐다. inputMode로 키패드만 바꾸고
 * 파싱은 저장하는 순간 한 번 한다.
 */

export type CustomFieldType = 'text' | 'number' | 'select' | 'date' | 'person'

export type CustomFieldDefinition = {
  id: string
  surface: string
  key: string
  label: string
  type: CustomFieldType
  options: string[]
  required: boolean
  archivedAt: string | null
  position: number
  createdAt: string
  updatedAt: string
}

export const CUSTOM_FIELD_TYPE_LABEL: Record<CustomFieldType, string> = {
  text: '텍스트', number: '숫자', select: '선택', date: '날짜', person: '사람',
}
/** 계정이 사라져 이름을 못 찾을 때. 값을 지우지 않는다 — 지우면 '누가 검토했는지'가 없던 일이 된다. */
export const UNKNOWN_ACCOUNT_LABEL = '알 수 없는 계정'

/**
 * 서버 custom-fields.mjs의 상한과 **같은 값**이다(계약 시험이 서버 소스에서 숫자를 꺼내 대조한다).
 *
 * 서버는 이 셋을 전부 한 문장('추가 정보 형식을 확인해 주세요.'·'항목 정의 형식을 확인해 주세요.')으로 답하거나
 * 어느 칸인지를 말하지 못한다. 그래서 화면이 먼저 막는다 — 저장된 보기 이름을 SAVED_VIEW_NAME_MAX로
 * 도달 불가로 만든 것과 같은 처방이다.
 */
export const WORK_FIELD_TEXT_MAX = 200
export const CUSTOM_FIELD_LABEL_MAX = 20
export const CUSTOM_FIELD_OPTION_MAX = 40

export type WorkFieldValues = Record<string, string | number | null>
/** 값 저장의 결과. key는 서버가 거절한 그 항목이다 — 문장은 서버 것 그대로 두고 라벨만 덧붙인다. */
export type WorkFieldSaveResult = { ok: boolean; message?: string; key?: string }

const activeOnly = (definitions: CustomFieldDefinition[]) => definitions.filter((definition) => !definition.archivedAt)

/**
 * 정의 목록을 읽는 훅. App 최상위가 아니라 쓰는 컴포넌트 안에서 부른다 —
 * useWorkspaceState를 하나 더 붙이면 게스트 계약 테스트가 고정한 `enabled: tenantDataEnabled,` 3회가 깨진다.
 */
export function useCustomFields(workspaceScope: string | undefined, enabled: boolean) {
  const [definitions, setDefinitions] = useState<CustomFieldDefinition[]>([])
  const [token, setToken] = useState(0)
  useEffect(() => {
    if (!enabled || !workspaceScope) return
    let active = true
    fetch('/api/custom-fields?surface=work', { headers: { 'x-workspace-identity': workspaceScope } })
      .then((response) => response.ok ? response.json() : null)
      .then((body: { items?: CustomFieldDefinition[] } | null) => { if (active && body?.items) setDefinitions(body.items) })
      // 정의를 못 읽어도 화면은 죽지 않는다 — 커스텀 필드 축이 없는 평소 화면이 된다.
      .catch(() => undefined)
    return () => { active = false }
  }, [workspaceScope, enabled, token])
  const reload = useCallback(() => setToken((current) => current + 1), [])
  // setDefinitions를 함께 돌려준다: 정의를 바꾸는 응답이 이미 '바뀐 목록'을 싣고 오는데
  // 그것을 버리고 재조회만 걸면, 응답과 재조회 사이에 누른 두 번째 버튼이 옛 자리 번호로 판단한다.
  return { definitions, setDefinitions, reload }
}

/** 값 하나를 사람이 읽는 문자열로. 값이 없으면 빈 문자열 — 부르는 쪽이 줄 자체를 그리지 않는다. */
export function customFieldDisplay(item: WorkItem, definition: CustomFieldDefinition, people: Record<string, string> = {}): string {
  const value = customFieldValue(item, definition.key)
  if (value == null) return ''
  if (definition.type === 'person') return people[String(value)] ?? UNKNOWN_ACCOUNT_LABEL
  return String(value)
}

function FieldInput({ definition, value, people, disabled, onChange }: {
  definition: CustomFieldDefinition
  value: string
  people: { id: string; name: string }[]
  disabled?: boolean
  onChange: (next: string) => void
}) {
  // onChange에서 값을 변형하지 않는다(AGENTS.md 금지: 한글 IME가 끊긴다). 다듬는 것은 저장하는 순간에만.
  if (definition.type === 'select') {
    return <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      <option value="">선택 안 함</option>
      {definition.options.map((option) => <option value={option} key={option}>{option}</option>)}
    </select>
  }
  if (definition.type === 'person') {
    return <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      <option value="">선택 안 함</option>
      {/* 값은 계정 id이고 보이는 것은 이름이다 — id를 화면에 노출하지 않는다. */}
      {people.map((person) => <option value={person.id} key={person.id}>{person.name}</option>)}
      {value && !people.some((person) => person.id === value) && <option value={value}>{UNKNOWN_ACCOUNT_LABEL}</option>}
    </select>
  }
  if (definition.type === 'date') {
    return <input type="date" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
  }
  // maxLength로 먼저 막는다 — 서버의 길이 거절은 400 한 줄이고, 자르는 것은 IME를 끊는다.
  return <input
    type="text"
    inputMode={definition.type === 'number' ? 'decimal' : undefined}
    maxLength={WORK_FIELD_TEXT_MAX}
    value={value}
    disabled={disabled}
    onChange={(event) => onChange(event.target.value)}
  />
}

/** 화면의 문자열 → 서버로 보낼 값. 빈 값은 null(지우기)이고, 숫자는 여기서 한 번만 파싱한다. */
export function toFieldValue(definition: CustomFieldDefinition, raw: string): string | number | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (definition.type !== 'number') return trimmed
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : raw
}

/**
 * 상세 드로어의 '추가 정보' 칸.
 *
 * select를 바꾸는 것만으로 서버를 부르지 않는다 — 훑다 실수로 남의 업무 값이 바뀌지 않게
 * '추가 정보 저장' 하나가 유일한 호출 지점이다(상위 바꾸기·업무 기간 칸과 같은 규율).
 */
export function CustomFieldEditor({ item, definitions, people, locked, onSave }: {
  item: WorkItem
  definitions: CustomFieldDefinition[]
  people: { id: string; name: string }[]
  /** 완료 보고가 올라간 뒤에는 읽기 전용. 서버 409 WORK_FIELD_LOCKED의 거울이다. */
  locked: boolean
  onSave: (values: WorkFieldValues) => Promise<WorkFieldSaveResult>
}) {
  const peopleNames = useMemo(() => Object.fromEntries(people.map((person) => [person.id, person.name])), [people])
  // 보관된 정의라도 이 업무에 값이 있으면 그린다 — 옛 값을 화면에서 지우면 '없던 일'이 된다.
  const visible = definitions.filter((definition) => !definition.archivedAt || customFieldValue(item, definition.key) != null)
  const initial = useCallback(() => Object.fromEntries(visible.map((definition) => {
    const value = customFieldValue(item, definition.key)
    return [definition.key, value == null ? '' : String(value)]
  })), [item, definitions])
  const [draft, setDraft] = useState<Record<string, string>>(initial)
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  // 다른 업무를 열면 값도 그 업무의 것에서 다시 시작한다. items 갱신에는 따라 움직이지 않는다(입력 중에 값이 튄다).
  useEffect(() => {
    setDraft(initial())
    setHint('')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id])
  /**
   * 정의 목록이 드로어보다 **늦게** 도착하는 경우가 있다 — 알림·전역검색으로 들어오면 결정적으로 그렇다
   * (focusId가 그 커밋에서 드로어를 열고, /api/custom-fields는 아직 돌아오지 않았다).
   * 그때 씨앗을 다시 뿌리지 않으면 값이 있는 칸까지 전부 빈 칸으로 그려지고,
   * '추가 정보 저장'을 한 번 누르는 순간 그 빈 칸들이 null(= 지우기)로 서버에 간다.
   * 통째로 갈아끼우지 않고 **draft에 없던 키만** 채우는 이유는, 정의 재조회가 입력 중인 칸을 되돌리지 않게 하기 위해서다.
   */
  useEffect(() => {
    setDraft((current) => {
      const seeded = initial()
      let changed = false
      const next = { ...current }
      for (const key of Object.keys(seeded)) {
        if (key in current) continue
        next[key] = seeded[key]
        changed = true
      }
      return changed ? next : current
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [definitions])

  if (!visible.length) return null
  /**
   * 잠긴 업무에 그릴 값이 하나도 없으면 이 블록 자체를 그리지 않는다.
   * 잠글 것이 없는 자리에 '바꿀 수 없습니다'만 남으면, 사람은 자기가 못 보는 무언가가 있다고 읽는다.
   */
  const readable = locked ? visible.filter((definition) => customFieldDisplay(item, definition, peopleNames)) : visible
  if (locked && !readable.length) return null

  const apply = async () => {
    const values: WorkFieldValues = {}
    for (const definition of visible) {
      // 화면에 그려진 적이 없는 칸은 보내지 않는다. 씨앗을 못 받은 칸을 '빈 값'으로 읽으면
      // 사람이 손대지도 않은 값이 지워진다(위 effect의 두 번째 방어선).
      if (!Object.prototype.hasOwnProperty.call(draft, definition.key)) continue
      const next = toFieldValue(definition, draft[definition.key] ?? '')
      // 보관된 항목에는 새 값을 넣지 않는다. 다만 남은 값을 **지우는 것**은 보낸다 —
      // 서버도 그 한 가지만 받는다(custom-fields.mjs의 /fields). 지울 길이 없으면 그 정의는 영영 삭제되지 않는다.
      if (definition.archivedAt && next !== null) continue
      const current = customFieldValue(item, definition.key) ?? null
      if (next !== current) values[definition.key] = next
    }
    if (!Object.keys(values).length) { setHint('바뀐 값이 없습니다.'); return }
    setBusy(true)
    setHint('')
    try {
      const saved = await onSave(values)
      // 문장은 서버가 준 그 하나다. 서버가 함께 보낸 key만 라벨로 바꿔 괄호로 덧붙인다 —
      // 칸이 서너 개 그려진 화면에서 '항목 형식에 맞지 않는 값입니다.'만 뜨면 어느 칸인지 알 길이 없다.
      // (409의 건수·선택지를 괄호로 덧붙이는 CustomFieldAdmin.call과 같은 형태다.)
      if (!saved.ok) {
        const label = saved.key ? definitions.find((definition) => definition.key === saved.key)?.label : ''
        setHint(`${saved.message ?? ''}${label ? ` (${label})` : ''}`.trim())
      }
    } finally { setBusy(false) }
  }

  return <section className="workflow-drawer-block" aria-label="추가 정보">
    <span>추가 정보</span>
    {/* dl의 자식은 dt·dd·div뿐이다 — 안내 문장은 dl 밖, section 직계로 둔다. */}
    {locked
      ? <>
        <dl className="work-field-readonly">
          {readable.map((definition) => (
            <div key={definition.id}><dt>{definition.label}</dt><dd>{customFieldDisplay(item, definition, peopleNames)}</dd></div>
          ))}
        </dl>
        <p className="workflow-drawer-blocked"><AlertTriangle size={15} /> 완료 보고한 업무의 추가 정보는 바꿀 수 없습니다.</p>
      </>
      : <div className="work-field-grid">
        {visible.map((definition) => <Fragment key={definition.id}>
        <label className="form-field">
          <span>
            {/* 공백 한 칸을 명시한다 — JSX는 줄바꿈만 있는 공백을 지워서 '발주번호보관됨'이 된다.
                바로 위의 기본 칸들이 '시작일 <em>선택</em>'으로 띄어 쓰고 있어 한 화면에 두 표기가 섞였다. */}
            {definition.label}{' '}
            {definition.archivedAt
              ? <em>보관됨</em>
              // 서버가 저장을 막지 않으므로 '필수'라고 쓰면 거짓말이 된다 — 아직 안 채웠다는 사실만 말한다.
              : definition.required && !customFieldValue(item, definition.key)
                ? <StatusBadge className="status-pill" tone="warning">입력 필요</StatusBadge>
                : null}
          </span>
          <FieldInput
            definition={definition}
            value={draft[definition.key] ?? ''}
            people={people}
            disabled={busy || Boolean(definition.archivedAt)}
            onChange={(next) => setDraft((current) => ({ ...current, [definition.key]: next }))}
          />
        </label>
        {/* 보관된 항목의 칸은 잠겨 있다(새 값을 넣을 수 없다). 그래도 남은 값을 비울 길은 있어야 한다 —
            그 길이 없으면 관리자에게는 보이는 값이 있는데 정의는 영영 지워지지 않는다.
            label 밖의 형제로 둔다: 잠긴 입력을 가리키는 label 안에 버튼을 넣지 않는다.
            서버를 여기서 부르지 않는 것도 규율이다 — 호출 지점은 '추가 정보 저장' 하나뿐이다. */}
        {definition.archivedAt && (draft[definition.key] ?? '') !== '' && <Button
          tone="quiet"
          size="sm"
          type="button"
          disabled={busy}
          aria-label={`${definition.label} 값 비우기`}
          onClick={() => setDraft((current) => ({ ...current, [definition.key]: '' }))}
        >값 비우기</Button>}
        </Fragment>)}
        <Button tone="secondary" size="sm" type="button" disabled={busy} onClick={() => void apply()}>추가 정보 저장</Button>
      </div>}
    {hint && <p className="workflow-drawer-blocked">{hint}</p>}
  </section>
}

/**
 * 새 업무 지시 모달의 접힌 선택 항목 안. 필수 3칸('무엇을'·'누가'·'언제까지')은 늘리지 않는다.
 * 값은 name 속성으로 FormData에 실린다 — 조립은 부모가 한다.
 */
export function CustomFieldCreateInputs({ definitions, people }: { definitions: CustomFieldDefinition[]; people: { id: string; name: string }[] }) {
  const [draft, setDraft] = useState<Record<string, string>>({})
  const visible = activeOnly(definitions)
  if (!visible.length) return null
  return <>
    {visible.map((definition) => <label className="form-field" key={definition.id}>
      <span>
        {/* 위 드로어 라벨과 같은 이유의 공백 한 칸 — 없으면 '금액선택'으로 한 단어처럼 읽힌다. */}
        {definition.label}{' '}
        {definition.required
          ? <StatusBadge className="status-pill" tone="warning">입력 필요</StatusBadge>
          : <em>선택</em>}
      </span>
      <FieldInput
        definition={definition}
        value={draft[definition.key] ?? ''}
        people={people}
        onChange={(next) => setDraft((current) => ({ ...current, [definition.key]: next }))}
      />
      <input type="hidden" name={`cf:${definition.key}`} value={draft[definition.key] ?? ''} />
    </label>)}
  </>
}

/** 새 업무 본문에 실을 fields 조각. 빈 값은 키 자체를 만들지 않는다('값 없음'은 한 가지뿐이다). */
export function collectCreateFields(form: FormData, definitions: CustomFieldDefinition[]): Record<string, string | number> {
  const fields: Record<string, string | number> = {}
  for (const definition of activeOnly(definitions)) {
    const value = toFieldValue(definition, String(form.get(`cf:${definition.key}`) ?? ''))
    if (value !== null) fields[definition.key] = value
  }
  return fields
}

/**
 * 정의 관리 모달(관리자).
 *
 * boardTab에 세 번째 탭을 만들지 않는다 — 직원에게 탭이 늘었다 줄었다 하면 화면이 매번 다른 것이 된다.
 * 삭제가 409로 막히면 건수를 그대로 문장에 넣고 '보관'을 권한다. 보관은 되돌릴 수 있고 삭제는 아니다.
 */
export function CustomFieldAdmin({ definitions, workspaceScope, onClose, onChanged, onItems }: {
  definitions: CustomFieldDefinition[]
  workspaceScope?: string
  onClose: () => void
  onChanged: () => void
  /** 응답이 실어 온 목록을 그대로 반영한다(아래 call의 주석). 없으면 재조회로 떨어진다. */
  onItems?: (items: CustomFieldDefinition[]) => void
}) {
  const dialogRef = useDialogFocus()
  const [label, setLabel] = useState('')
  const [key, setKey] = useState('')
  const [type, setType] = useState<CustomFieldType>('text')
  const [options, setOptions] = useState('')
  const [required, setRequired] = useState(false)
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')

  const call = async (method: string, path: string, body?: unknown) => {
    if (!workspaceScope) return null
    setBusy(true)
    setHint('')
    try {
      const response = await fetch(path, {
        method,
        headers: { 'content-type': 'application/json', 'x-workspace-identity': workspaceScope },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      const payload = await response.json() as { items?: CustomFieldDefinition[]; error?: { message?: string; count?: number; option?: string } }
      if (!response.ok) {
        // 문장은 서버가 준 그 하나다. 숫자와 선택지 이름만 괄호로 덧붙인다 —
        // '몇 건을 정리해야 하는지'를 버리면 사람은 삭제와 보관 중 무엇을 고를지 알 수 없다.
        const detail = [payload.error?.option ? `'${payload.error.option}'` : '', payload.error?.count != null ? `${payload.error.count}건` : '']
          .filter(Boolean).join(' · ')
        setHint(`${payload.error?.message ?? '항목을 저장하지 못했습니다.'}${detail ? ` (${detail})` : ''}`)
        return null
      }
      // 응답이 이미 '바뀐 목록'을 싣고 온다. 그것을 바로 쓴다 — 재조회를 기다리는 사이에 ↑를 한 번 더 누르면
      // 옛 자리 번호로 이웃을 읽고, 서버가 이미 0..n-1로 다시 매긴 뒤라 그 PATCH는 같은 자리를 가리켜
      // 목록이 한 칸도 움직이지 않는다(빠르게 두 번 누르면 두 번째 클릭이 사라진다).
      if (onItems && Array.isArray(payload.items)) onItems(payload.items)
      else onChanged()
      return payload
    } catch {
      setHint('항목 관리 서버에 연결할 수 없습니다.')
      return null
    } finally { setBusy(false) }
  }

  /** 쉼표로 나눈 선택지. 저장 조건과 화면에 그리는 조건이 같은 한 곳에서 나온다. */
  const selectOptions = options.split(',').map((option) => option.trim()).filter(Boolean)
  const add = async () => {
    const created = await call('POST', '/api/custom-fields', {
      surface: 'work', key: key.trim(), label: label.trim(), type, required,
      ...(type === 'select' ? { options: selectOptions } : {}),
    })
    if (created) { setLabel(''); setKey(''); setOptions(''); setRequired(false) }
  }

  const active = definitions.filter((definition) => !definition.archivedAt)
  const archived = definitions.filter((definition) => definition.archivedAt)
  /**
   * '한 칸 위'는 **이웃의 자리 번호**로 말한다. position ± 1을 보내면 보관된 항목이 사이에 끼어 있을 때
   * 한 칸이 아닌 곳으로 가고, 이웃과 번호가 같아지면 서버의 다음 기준(createdAt)이 이겨 목록이 움직이지 않는다.
   * 자리 번호를 0..n-1로 다시 매기는 일은 서버가 한 커밋에서 한다(server/custom-fields.mjs의 PATCH).
   */
  const move = (list: CustomFieldDefinition[], index: number, delta: number) => {
    const neighbour = list[index + delta]
    if (!neighbour) return
    void call('PATCH', `/api/custom-fields/${encodeURIComponent(list[index].id)}`, { position: neighbour.position })
  }

  const row = (definition: CustomFieldDefinition, index: number, list: CustomFieldDefinition[]) => <li key={definition.id} className="work-field-admin-row">
    <span><strong>{definition.label}</strong> <small>{CUSTOM_FIELD_TYPE_LABEL[definition.type]} · {definition.key}{definition.required ? ' · 입력 필요' : ''}</small></span>
    {!definition.archivedAt && <>
      <IconButton tone="quiet" type="button" aria-label={`${definition.label} 위로`} disabled={busy || index === 0} onClick={() => move(list, index, -1)}><ArrowUp size={15} /></IconButton>
      <IconButton tone="quiet" type="button" aria-label={`${definition.label} 아래로`} disabled={busy || index === list.length - 1} onClick={() => move(list, index, 1)}><ArrowDown size={15} /></IconButton>
    </>}
    <Button tone="quiet" size="sm" type="button" disabled={busy} onClick={() => void call('PATCH', `/api/custom-fields/${encodeURIComponent(definition.id)}`, { archivedAt: definition.archivedAt ? null : new Date().toISOString() })}>
      <Archive size={15} /> {definition.archivedAt ? '되살리기' : '보관'}
    </Button>
    <Button tone="danger" size="sm" type="button" disabled={busy} onClick={() => void call('DELETE', `/api/custom-fields/${encodeURIComponent(definition.id)}`)}>
      <Trash2 size={15} /> 삭제
    </Button>
  </li>

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section ref={dialogRef} className="modal-card workflow-modal" role="dialog" aria-modal="true" aria-labelledby="custom-field-admin-title">
      <header>
        <div><span className="eyebrow">CUSTOM FIELDS</span><h2 id="custom-field-admin-title">업무 추가 항목 관리</h2><p>이 회사의 업무에 붙는 항목을 정합니다. 항목 키와 형식은 만든 뒤 바꿀 수 없습니다.</p></div>
        <IconButton tone="ghost" type="button" aria-label="닫기" onClick={onClose}><X size={21} /></IconButton>
      </header>
      <div className="work-field-admin">
        <ul className="work-field-admin-list" aria-label="사용 중인 항목">
          {active.map((definition, index) => row(definition, index, active))}
          {active.length === 0 && <li className="work-field-admin-empty">아직 만든 항목이 없습니다.</li>}
        </ul>
        {archived.length > 0 && <details className="work-field-admin-archived">
          <summary>보관된 항목 {archived.length}개</summary>
          <ul className="work-field-admin-list" aria-label="보관된 항목">{archived.map((definition, index) => row(definition, index, archived))}</ul>
        </details>}
        <div className="work-field-admin-form">
          {/* 서버는 이름 길이·선택지 길이·선택지 없음을 전부 '항목 정의 형식을 확인해 주세요.' 하나로 답한다.
              무엇이 길거나 빠졌는지 화면이 먼저 말해야 관리자가 고칠 수 있다. */}
          <label className="form-field"><span>이름 <em>필수 · {CUSTOM_FIELD_LABEL_MAX}자까지</em></span>
            <input type="text" value={label} maxLength={CUSTOM_FIELD_LABEL_MAX} onChange={(event) => setLabel(event.target.value)} placeholder="거래처" /></label>
          <label className="form-field"><span>항목 키 <em>영문 소문자</em></span>
            <input type="text" value={key} onChange={(event) => setKey(event.target.value)} placeholder="vendor" /></label>
          <label className="form-field"><span>형식 <em>바꿀 수 없음</em></span>
            <select value={type} onChange={(event) => setType(event.target.value as CustomFieldType)}>
              {(Object.keys(CUSTOM_FIELD_TYPE_LABEL) as CustomFieldType[]).map((value) => <option value={value} key={value}>{CUSTOM_FIELD_TYPE_LABEL[value]}</option>)}
            </select></label>
          {type === 'select' && <label className="form-field"><span>선택지 <em>쉼표로 구분 · 하나 이상, 각 {CUSTOM_FIELD_OPTION_MAX}자까지</em></span>
            <input type="text" value={options} onChange={(event) => setOptions(event.target.value)} placeholder="A, B, C" /></label>}
          <label className="work-field-admin-required">
            <input type="checkbox" checked={required} onChange={(event) => setRequired(event.target.checked)} />
            <span>입력 필요로 표시 <small>저장을 막지는 않습니다 — 화면이 배지로 알립니다.</small></span>
          </label>
          <Button
            tone="secondary"
            size="sm"
            type="button"
            disabled={busy || !label.trim() || !key.trim() || (type === 'select' && (selectOptions.length === 0 || selectOptions.some((option) => option.length > CUSTOM_FIELD_OPTION_MAX)))}
            onClick={() => void add()}
          ><Plus size={15} /> 항목 추가</Button>
        </div>
        {hint && <p className="workflow-drawer-blocked"><AlertTriangle size={15} /> {hint}</p>}
      </div>
    </section>
  </div>
}

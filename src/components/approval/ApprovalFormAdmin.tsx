import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Plus, Save, Trash2, X } from 'lucide-react'
import { Button, IconButton } from '../ui/Button'
import {
  APPROVAL_FIELD_TYPES,
  APPROVAL_FIELD_TYPE_LABEL,
  APPROVAL_FORM_KINDS,
  TAX_EVIDENCE_CATEGORIES,
  type ApprovalField,
  type ApprovalFieldType,
  type ApprovalForm,
  type ApprovalMember,
} from './approvalTypes'
import './approval.css'

/** 서버 `FIELD_KEY_RE`와 같은 모양. 어긋나면 그 자리에서 사유를 말한다. */
const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,29}$/
const FIELD_KEY_HINT = '항목 키는 영문 소문자로 시작하고, 영문 소문자·숫자·밑줄만 30자까지 쓸 수 있습니다.'

type DraftField = { key: string; label: string; type: ApprovalFieldType; required: boolean; options: string; help: string }

const emptyField = (): DraftField => ({ key: '', label: '', type: 'text', required: false, options: '', help: '' })

const toDraft = (field: ApprovalField): DraftField => ({
  key: field.key,
  label: field.label,
  type: field.type,
  required: field.required,
  options: field.options.join(', '),
  help: field.help,
})

/**
 * 라벨에서 항목 키를 만든다. 한글 라벨은 영문 키가 나오지 않으므로 순번으로 떨어진다 —
 * 사람이 그 자리에서 고칠 수 있고, 고치지 않아도 서버가 받아 주는 모양이다.
 * **입력 중에는 부르지 않는다**(IME): 「항목 추가」를 눌러 새 줄을 만들 때 한 번만 쓴다.
 */
const keyFrom = (label: string, position: number) => {
  const slug = label.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30)
  return FIELD_KEY_RE.test(slug) ? slug : `field_${position + 1}`
}

/**
 * 양식 관리 + 대결자 지정(관리자 전용).
 *
 * 대결자를 관리자도 지정할 수 있는 이유: 휴가로 갑자기 빠진 사람 때문에 결재가 멈추면
 * 본인이 아니고는 아무도 그 줄을 풀 수 없다.
 */
export function ApprovalFormAdmin({ workspaceScope, forms, members, onToast, onClose, onSaved }: {
  workspaceScope?: string
  forms: ApprovalForm[]
  members: ApprovalMember[]
  onToast: (message: string) => void
  onClose: () => void
  onSaved: () => void
}) {
  const [editingId, setEditingId] = useState('')
  const [name, setName] = useState('')
  const [kind, setKind] = useState<string>(APPROVAL_FORM_KINDS[0])
  const [description, setDescription] = useState('')
  const [fields, setFields] = useState<DraftField[]>([emptyField()])
  const [amountFieldKey, setAmountFieldKey] = useState('')
  const [evidenceCategory, setEvidenceCategory] = useState('')
  const [busy, setBusy] = useState(false)

  const [delegateAccountId, setDelegateAccountId] = useState('')
  const [delegateId, setDelegateId] = useState('')
  const [delegateFrom, setDelegateFrom] = useState('')
  const [delegateTo, setDelegateTo] = useState('')

  const headers = useMemo(
    () => ({ 'content-type': 'application/json', ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}) }),
    [workspaceScope],
  )
  const editing = forms.find((form) => form.id === editingId) ?? null
  /**
   * 「무엇이 이 항목의 키인가」에 답하는 곳은 하나다. 여기서 `field.key` 만 보면, 라벨에 「금액」만
   * 적고 키 칸을 비워 둔 money 항목이 금액 집계 후보에서 사라진다 — 저장은 되는데(`bodyOf` 가
   * 같은 자리에서 `field_N` 을 만들어 보낸다) 그 자리에서는 고를 수 없어, 관리자가 그대로 저장하면
   * `amountFieldKey: null` 인 양식이 되어 승인돼도 「승인된 지출」에 아무것도 쌓이지 않는다.
   */
  const keyOf = (field: DraftField, position: number) => (FIELD_KEY_RE.test(field.key) ? field.key : keyFrom(field.label, position))
  const withKeys = () => fields.map((field, position) => ({ ...field, key: keyOf(field, position) }))
  const moneyFields = withKeys().filter((field) => field.type === 'money')

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const openNew = () => {
    setEditingId('')
    setName('')
    setKind(APPROVAL_FORM_KINDS[0])
    setDescription('')
    setFields([emptyField()])
    setAmountFieldKey('')
    setEvidenceCategory('')
  }

  const openForm = (form: ApprovalForm) => {
    setEditingId(form.id)
    setName(form.name)
    setKind(form.kind)
    setDescription(form.description)
    setFields(form.fields.length ? form.fields.map(toDraft) : [emptyField()])
    setAmountFieldKey(form.amountFieldKey ?? '')
    setEvidenceCategory(form.evidenceCategory ?? '')
  }

  const setField = (index: number, patch: Partial<DraftField>) => setFields((current) => current.map((field, position) => (
    position === index ? { ...field, ...patch } : field
  )))
  const addField = () => setFields((current) => [...current, emptyField()])
  const removeField = (index: number) => setFields((current) => (current.length <= 1 ? current : current.filter((_field, position) => position !== index)))
  /**
   * 항목을 위·아래로 옮긴다. 서버가 `position` 을 배열 순서로 다시 매기므로 순서는 뜻이 있는 값이고,
   * 이 컨트롤이 없으면 가운데 항목 하나를 빠뜨렸을 때 뒤의 항목을 전부 지웠다 다시 만드는 수밖에 없다.
   */
  const moveField = (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= fields.length) return
    const chosen = withKeys().findIndex((field) => field.key === amountFieldKey && field.type === 'money')
    const next = [...fields]
    ;[next[index], next[target]] = [next[target], next[index]]
    setFields(next)
    // 순서가 바뀌면 라벨에서 자동으로 만든 키(`field_N`)도 함께 바뀐다. 고른 금액 항목이 그 자리에
    // 있었다면 새 자리의 키로 따라가야, 사람이 손대지 않은 선택이 조용히 「집계하지 않음」이 되지 않는다.
    if (chosen < 0) return
    const movedTo = chosen === index ? target : chosen === target ? index : chosen
    setAmountFieldKey(keyOf(next[movedTo], movedTo))
  }

  const bodyOf = () => {
    const keyed = withKeys()
    return {
      name,
      kind,
      description,
      fields: keyed.map((field) => ({
        key: field.key,
        label: field.label,
        type: field.type,
        required: field.required,
        // 「고르기」 항목만 선택지를 갖는다. 쉼표로 나누는 일은 제출 시점에만 한다(IME).
        ...(field.type === 'select' ? { options: field.options.split(',').map((option) => option.trim()).filter(Boolean) } : {}),
        help: field.help,
      })),
      defaultLine: [],
      ccIds: [],
      // 라벨을 고쳐 키가 달라졌다면 그 선택은 이미 화면에서도 「집계하지 않음」으로 보인다.
      // 없는 키를 보내면 서버가 AMOUNT_FIELD_INVALID 로 양식 저장 자체를 거절한다.
      amountFieldKey: keyed.some((field) => field.key === amountFieldKey && field.type === 'money') ? amountFieldKey : null,
      evidenceCategory: evidenceCategory || null,
    }
  }

  const saveForm = async () => {
    if (busy) return
    setBusy(true)
    try {
      const response = editing
        ? await fetch(`/api/approval-forms/${encodeURIComponent(editing.id)}`, {
          method: 'PATCH', headers, body: JSON.stringify({ ...bodyOf(), version: editing.version, active: editing.active !== false }),
        })
        : await fetch('/api/approval-forms', { method: 'POST', headers, body: JSON.stringify(bodyOf()) })
      const body = await response.json() as { form?: ApprovalForm; error?: { message?: string } }
      if (!response.ok || !body.form) throw new Error(body.error?.message || '양식을 저장하지 못했습니다.')
      onToast(editing ? '양식을 고쳤습니다.' : '양식을 만들었습니다.')
      setEditingId(body.form.id)
      onSaved()
    } catch (reason) {
      onToast(reason instanceof Error ? reason.message : '양식을 저장하지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  /** 양식은 지우지 않고 내린다. 이미 돌고 있는 결재가 이 양식의 이름과 항목 라벨을 가리키고 있다. */
  const toggleActive = async (form: ApprovalForm) => {
    if (busy) return
    setBusy(true)
    try {
      const response = form.active === false
        ? await fetch(`/api/approval-forms/${encodeURIComponent(form.id)}`, {
          method: 'PATCH', headers, body: JSON.stringify({
            name: form.name, kind: form.kind, description: form.description,
            fields: form.fields, defaultLine: form.defaultLine, ccIds: form.ccIds,
            amountFieldKey: form.amountFieldKey, evidenceCategory: form.evidenceCategory,
            active: true, version: form.version,
          }),
        })
        : await fetch(`/api/approval-forms/${encodeURIComponent(form.id)}`, { method: 'DELETE', headers })
      const body = await response.json() as { error?: { message?: string } }
      if (!response.ok) throw new Error(body.error?.message || '양식 상태를 바꾸지 못했습니다.')
      onToast(form.active === false ? '양식을 다시 씁니다.' : '양식을 내렸습니다. 이미 돌고 있는 결재는 그대로 진행됩니다.')
      onSaved()
    } catch (reason) {
      onToast(reason instanceof Error ? reason.message : '양식 상태를 바꾸지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  const saveDelegate = async () => {
    if (busy || !delegateAccountId) return
    setBusy(true)
    try {
      const response = await fetch(`/api/approval-delegates/${encodeURIComponent(delegateAccountId)}`, {
        method: 'PUT', headers,
        body: JSON.stringify({ delegateId: delegateId || null, from: delegateFrom, to: delegateTo }),
      })
      const body = await response.json() as { error?: { message?: string } }
      if (!response.ok) throw new Error(body.error?.message || '대결자를 저장하지 못했습니다.')
      onToast(delegateId ? '대결자를 지정했습니다.' : '대결자 지정을 지웠습니다.')
      onSaved()
    } catch (reason) {
      onToast(reason instanceof Error ? reason.message : '대결자를 저장하지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section className="modal-card approval-form-admin" role="dialog" aria-modal="true" aria-labelledby="approval-form-admin-title">
      <header>
        <div>
          <span className="eyebrow">FORMS</span>
          <h2 id="approval-form-admin-title">결재 양식 관리</h2>
          <p>양식은 「무엇을 적어야 하는가」를 정합니다. 결재선은 기안하는 사람이 그때그때 고릅니다.</p>
        </div>
        <IconButton tone="ghost" type="button" aria-label="닫기" onClick={onClose}><X size={21} /></IconButton>
      </header>

      <form onSubmit={(event) => { event.preventDefault(); void saveForm() }}>
        <div>
          {forms.map((form) => <div key={form.id} className="approval-form-row">
            <strong>{form.name}</strong>
            <span>
              <Button tone="quiet" size="sm" type="button" onClick={() => openForm(form)}>고치기</Button>
              <Button tone="ghost" size="sm" type="button" disabled={busy} onClick={() => void toggleActive(form)}>{form.active === false ? '다시 쓰기' : '내리기'}</Button>
            </span>
            <small>
              {form.kind} · 항목 {form.fields.length}개 · 기본 결재선 {form.defaultLine.length}단계
              {form.evidenceCategory ? ` · 증빙 ${form.evidenceCategory}` : ' · 증빙 없음'}
              {form.amountFieldKey ? ` · 금액 항목 ${form.amountFieldKey}` : ' · 금액 집계 없음'}
              {form.active === false ? ' · 내려둠' : ''}
            </small>
          </div>)}
          <Button tone="ghost" size="sm" type="button" onClick={openNew}><Plus size={14} /> 새 양식</Button>
        </div>

        <label className="form-field full">
          <span>양식 이름</span>
          <input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
        </label>
        <div className="form-grid">
          <label className="form-field">
            <span>종류</span>
            <select value={kind} onChange={(event) => setKind(event.target.value)}>
              {APPROVAL_FORM_KINDS.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
            </select>
          </label>
          <label className="form-field">
            <span>증빙 분류 <em className="field-optional">승인되면 세무 증빙함으로 갑니다</em></span>
            <select value={evidenceCategory} onChange={(event) => setEvidenceCategory(event.target.value)}>
              <option value="">증빙으로 쌓지 않음</option>
              {TAX_EVIDENCE_CATEGORIES.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
            </select>
          </label>
        </div>
        <label className="form-field full">
          <span>설명 <em className="field-optional">선택</em></span>
          <input value={description} maxLength={120} onChange={(event) => setDescription(event.target.value)} />
        </label>

        <div className="form-field full">
          <span>항목</span>
          <div className="approval-form-fields">
            {fields.map((field, index) => <div key={`field-${index + 1}`} className="approval-form-field">
              <label className="form-field">
                <span>이름</span>
                <input value={field.label} maxLength={20} onChange={(event) => setField(index, { label: event.target.value })} />
              </label>
              <label className="form-field">
                <span>키</span>
                <input value={field.key} maxLength={30} placeholder={keyFrom(field.label, index)} onChange={(event) => setField(index, { key: event.target.value })} />
                {field.key && !FIELD_KEY_RE.test(field.key) ? <em className="approval-form-error">{FIELD_KEY_HINT}</em> : null}
              </label>
              <label className="form-field">
                <span>종류</span>
                <select value={field.type} onChange={(event) => setField(index, { type: (APPROVAL_FIELD_TYPES.find((entry) => entry === event.target.value) ?? 'text') })}>
                  {APPROVAL_FIELD_TYPES.map((entry) => <option key={entry} value={entry}>{APPROVAL_FIELD_TYPE_LABEL[entry]}</option>)}
                </select>
              </label>
              <label className="form-field">
                <span>필수 여부</span>
                <select value={field.required ? 'required' : 'optional'} onChange={(event) => setField(index, { required: event.target.value === 'required' })}>
                  <option value="optional">선택</option>
                  <option value="required">필수</option>
                </select>
              </label>
              {field.type === 'select'
                ? <label className="form-field">
                  <span>선택지 <em className="field-optional">쉼표로 구분</em></span>
                  <input value={field.options} onChange={(event) => setField(index, { options: event.target.value })} />
                </label>
                : null}
              <div className="approval-form-field-actions">
                <IconButton tone="quiet" size="sm" type="button" aria-label={`항목 ${index + 1} 위로`} disabled={index === 0} onClick={() => moveField(index, -1)}><ChevronUp size={15} /></IconButton>
                <IconButton tone="quiet" size="sm" type="button" aria-label={`항목 ${index + 1} 아래로`} disabled={index === fields.length - 1} onClick={() => moveField(index, 1)}><ChevronDown size={15} /></IconButton>
                <Button tone="ghost" size="sm" type="button" disabled={fields.length <= 1} onClick={() => removeField(index)}><Trash2 size={13} /> 항목 삭제</Button>
              </div>
            </div>)}
            <Button tone="ghost" size="sm" type="button" onClick={addField}><Plus size={14} /> 항목 추가</Button>
          </div>
        </div>

        <label className="form-field full">
          <span>금액 집계 항목 <em className="field-optional">「승인된 지출」에 이 값이 쌓입니다</em></span>
          <select value={amountFieldKey} onChange={(event) => setAmountFieldKey(event.target.value)}>
            <option value="">집계하지 않음</option>
            {moneyFields.map((field) => <option key={field.key} value={field.key}>{field.label || field.key}</option>)}
          </select>
          {moneyFields.length === 0 ? <em className="field-optional">금액 항목을 하나 만들면 여기서 고를 수 있습니다.</em> : null}
        </label>

        <div className="form-field full">
          <span>대결자 지정</span>
          <p className="approval-field-note">휴가·출장으로 결재가 멈추면 관리자가 대신 풀 수 있습니다. 대결의 대결은 없습니다.</p>
          <div className="approval-delegate-form">
            <label className="form-field">
              <span>누구의 결재를</span>
              <select value={delegateAccountId} onChange={(event) => setDelegateAccountId(event.target.value)}>
                <option value="">사람을 고르세요</option>
                {members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
              </select>
            </label>
            <label className="form-field">
              <span>누가 대신</span>
              <select value={delegateId} onChange={(event) => setDelegateId(event.target.value)}>
                <option value="">지정 지우기</option>
                {members.filter((member) => member.id !== delegateAccountId).map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
              </select>
            </label>
            <label className="form-field">
              <span>시작</span>
              <input type="date" max="2100-12-31" value={delegateFrom} onChange={(event) => setDelegateFrom(event.target.value)} />
            </label>
            <label className="form-field">
              <span>끝</span>
              <input type="date" max="2100-12-31" value={delegateTo} onChange={(event) => setDelegateTo(event.target.value)} />
            </label>
            <Button tone="ghost" size="sm" type="button" disabled={busy || !delegateAccountId} onClick={() => void saveDelegate()}>대결자 저장</Button>
          </div>
        </div>

        <footer>
          <Button tone="ghost" type="button" onClick={onClose}>닫기</Button>
          <Button tone="primary" type="submit" disabled={busy}><Save size={17} /> {busy ? '저장 중…' : editing ? '양식 고치기' : '양식 만들기'}</Button>
        </footer>
      </form>
    </section>
  </div>
}

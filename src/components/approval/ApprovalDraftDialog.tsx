import { useEffect, useMemo, useRef, useState } from 'react'
import { Paperclip, Plus, SendHorizontal, Trash2, X } from 'lucide-react'
import { saveApprovalDraft, type ApprovalDraftCall } from '../../utils/approvalDraft'
import { filledLineSteps } from '../../utils/approvalLine'
import { uploadDocumentAttachment } from '../../utils/documentAttachments'
import { Button, IconButton } from '../ui/Button'
import {
  APPROVAL_LINE_REQUIRED_MESSAGE,
  type ApprovalAccount,
  type ApprovalDocument,
  type ApprovalField,
  type ApprovalForm,
  type ApprovalMember,
  type ApprovalStepMode,
  type ApprovalValue,
} from './approvalTypes'
import './approval.css'

/** 화면이 편집하는 결재선 한 단계. 서버가 돌려주는 결재선에서 사람 id 만 뽑아 쓴다. */
type DraftStep = { mode: ApprovalStepMode; approverIds: string[] }

const MAX_LINE_STEPS = 8
const MAX_APPROVERS_PER_STEP = 5

/**
 * 금액·숫자 칸의 글자를 수로 옮긴다. **제출할 때만** 부른다 —
 * 입력 중에 콤마를 넣거나 지우면 한글 입력(IME) 조합이 끊기고, 커서가 칸 끝으로 튄다.
 * 수로 읽히지 않는 글자는 그대로 보낸다: 서버가 「항목 값을 확인해 주세요」로 답해야
 * 사람이 무엇이 틀렸는지 알 수 있고, 조용히 빈 값으로 떨어뜨리면 「안 적었다」로 뒤집힌다.
 */
function toNumberValue(raw: string): ApprovalValue {
  const text = raw.trim()
  if (!text) return ''
  const parsed = Number(text.replace(/,/g, ''))
  return Number.isFinite(parsed) ? parsed : text
}

const stepsOf = (source: ApprovalDocument | null): DraftStep[] => (source?.line ?? []).map((step) => ({
  mode: step.mode,
  approverIds: step.approvers.map((approver) => approver.accountId),
}))

const valuesOf = (source: ApprovalDocument | null): Record<string, string> => Object.fromEntries(
  Object.entries(source?.values ?? {}).map(([key, value]) => [key, String(value ?? '')]),
)

/**
 * 기안 대화상자 — 양식 고르기 → 항목 → 결재선 → 첨부.
 *
 * 여기서 지키는 것 둘:
 * 1) **모든 `onChange`는 받은 값을 그대로 state 에 넣는다.** 콤마·trim·대문자 변환은 제출 시점에만 한다.
 *    입력 중에 값을 고치면 한글 조합이 끊긴다.
 * 2) **결재선이 비었을 때 상신 버튼을 `disabled` 로 만들지 않는다.** `aria-disabled` 로 사유를 남기고,
 *    눌리면 서버와 **같은 한 문장**을 토스트로 말한다(규칙 2·3).
 */
export function ApprovalDraftDialog({ account, workspaceScope, forms, members, draft, onToast, onClose, onSaved, onRefresh }: {
  account: ApprovalAccount
  workspaceScope?: string
  forms: ApprovalForm[]
  members: ApprovalMember[]
  draft: ApprovalDocument | null
  onToast: (message: string) => void
  onClose: () => void
  onSaved: () => void
  /** 저장이 실패했을 때 목록을 다시 읽는다 — 대화상자를 닫지 않는다(고치던 내용이 사라진다). */
  onRefresh?: () => void
}) {
  const selectable = useMemo(() => forms.filter((form) => form.active !== false), [forms])
  const [formId, setFormId] = useState(() => draft?.formId ?? selectable[0]?.id ?? '')
  const [title, setTitle] = useState(() => draft?.title ?? '')
  const [values, setValues] = useState<Record<string, string>>(() => valuesOf(draft))
  const [attachments, setAttachments] = useState<string[]>(() => draft?.attachments ?? [])
  const [names, setNames] = useState<Record<string, string>>({})
  const [line, setLine] = useState<DraftStep[]>(() => stepsOf(draft))
  const [ccIds, setCcIds] = useState<string[]>(() => draft?.ccIds ?? [])
  const [ccPick, setCcPick] = useState('')
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState('')
  /**
   * 서버가 아는 지금 version. **프롭 스냅샷(`draft.version`)을 다시 쓰지 않는다** — PATCH 한 번이
   * 그 값을 낡게 만들고, 그 뒤의 모든 요청이 「다른 곳에서 먼저 저장되었습니다」로 튕긴다.
   */
  const [version, setVersion] = useState(() => draft?.version ?? 0)
  // 재시도가 두 번째 문서를 만들지 않게 하는 멱등 키. 이 대화상자가 열려 있는 동안 하나다.
  const [clientRequestId] = useState(() => `ADR-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)

  const form = selectable.find((entry) => entry.id === formId) ?? null
  const candidates = useMemo(
    () => members.filter((member) => member.active !== false && member.id !== account.id),
    [account.id, members],
  )
  const nameOf = (id: string) => names[id] ?? id
  const headers = useMemo(
    () => ({ 'content-type': 'application/json', ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}) }),
    [workspaceScope],
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  // 이어서 작성하는 기안에는 이미 붙은 자료가 있다. 이름을 모르면 화면이 DOC-… 를 그대로 보여 준다.
  useEffect(() => {
    let active = true
    fetch('/api/documents', { headers: workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined })
      .then(async (response) => (response.ok ? response.json() as Promise<{ documents?: { id: string; name: string }[] }> : { documents: [] }))
      .then((body) => {
        if (!active) return
        setNames((current) => ({
          ...Object.fromEntries((body.documents ?? []).map((entry) => [entry.id, entry.name])),
          ...current,
        }))
      })
      .catch(() => { /* 이름을 못 읽으면 id 를 그대로 보여 준다 — 기안 자체는 막히지 않는다 */ })
    return () => { active = false }
  }, [workspaceScope])

  // 양식 목록은 이 대화상자보다 늦게 도착할 수 있다. 딱 한 번만 첫 양식을 골라 준다 —
  // 사람이 「양식을 고르세요」로 되돌려 놓은 것을 화면이 다시 덮어쓰면 고를 수 없는 칸이 된다.
  const autoPicked = useRef(false)
  useEffect(() => {
    if (autoPicked.current || draft || formId || selectable.length === 0) return
    autoPicked.current = true
    setFormId(selectable[0].id)
  }, [draft, formId, selectable])

  // 양식을 바꾸면 항목이 통째로 달라진다. 이전 양식의 키를 남겨 보내면 서버가 「모르는 항목」으로 거절한다.
  const chooseForm = (nextId: string) => {
    setFormId(nextId)
    setValues({})
  }

  const setValue = (key: string, next: string) => setValues((current) => ({ ...current, [key]: next }))

  const addStep = () => setLine((current) => (current.length >= MAX_LINE_STEPS ? current : [...current, { mode: 'sequential', approverIds: [''] }]))
  const removeStep = (index: number) => setLine((current) => current.filter((_step, position) => position !== index))
  const setStepMode = (index: number, mode: ApprovalStepMode) => setLine((current) => current.map((step, position) => {
    if (position !== index) return step
    // 순차는 결재자 1명, 병렬은 2명 이상. 모드를 바꾸면 자리 수도 그 규칙으로 맞춘다.
    if (mode === 'sequential') return { mode, approverIds: step.approverIds.slice(0, 1) }
    return { mode, approverIds: step.approverIds.length >= 2 ? step.approverIds : [...step.approverIds, ''] }
  }))
  const setApprover = (index: number, slot: number, accountId: string) => setLine((current) => current.map((step, position) => (
    position === index ? { ...step, approverIds: step.approverIds.map((id, at) => (at === slot ? accountId : id)) } : step
  )))
  const addApprover = (index: number) => setLine((current) => current.map((step, position) => (
    position === index && step.approverIds.length < MAX_APPROVERS_PER_STEP ? { ...step, approverIds: [...step.approverIds, ''] } : step
  )))
  const removeApprover = (index: number, slot: number) => setLine((current) => current.map((step, position) => (
    position === index ? { ...step, approverIds: step.approverIds.filter((_id, at) => at !== slot) } : step
  )))

  const store = async (file: File, label: string) => uploadDocumentAttachment(file, {
    workspaceScope,
    category: '결재증빙',
    summary: `${title || '전자결재'} · ${label}`,
    tags: ['approval-attachment'],
  })

  const pickAttachment = async (field: ApprovalField, file: File | null) => {
    if (!file) return
    setUploading(field.key)
    try {
      const stored = await store(file, field.label)
      setValue(field.key, stored.id)
      setNames((current) => ({ ...current, [stored.id]: stored.name }))
    } catch (reason) {
      onToast(reason instanceof Error ? reason.message : '첨부 파일을 저장하지 못했습니다.')
    } finally {
      setUploading('')
    }
  }

  const addAttachment = async (file: File | null) => {
    if (!file) return
    setUploading('attachments')
    try {
      const stored = await store(file, '첨부')
      setAttachments((current) => (current.includes(stored.id) ? current : [...current, stored.id]))
      setNames((current) => ({ ...current, [stored.id]: stored.name }))
    } catch (reason) {
      onToast(reason instanceof Error ? reason.message : '첨부 파일을 저장하지 못했습니다.')
    } finally {
      setUploading('')
    }
  }

  const addCc = (id: string) => {
    setCcPick('')
    if (!id) return
    setCcIds((current) => (current.includes(id) ? current : [...current, id]))
  }

  /**
   * 보낼 본문. 양식을 읽지 못했을 때는 `values` 를 아예 보내지 않는다 — 빈 객체를 보내면 PATCH 가
   * 이미 적어 둔 값을 통째로 지운다(양식이 내려간 사이에 기안 내용이 사라지는 길).
   *
   * 결재자를 아직 고르지 않은 단계는 **걷어내고** 보낸다. 그대로 보내면 서버가 구조로 거절해
   * 「단계 추가」를 누른 뒤의 임시저장이 통째로 400 이 되고, 적어 둔 것이 한 글자도 남지 않는다.
   */
  const bodyOf = () => ({
    formId,
    title,
    ...(form ? {
      values: Object.fromEntries(form.fields.map((field) => [
        field.key,
        field.type === 'money' || field.type === 'number' ? toNumberValue(values[field.key] ?? '') : (values[field.key] ?? ''),
      ])),
    } : {}),
    attachments,
    line: filledLineSteps(line).map((step) => ({ mode: step.mode, approvers: step.approverIds.filter(Boolean) })),
    ccIds,
  })

  /**
   * 「상신할 수 있는 결재선인가」를 답하는 곳은 여기 하나다. 단계를 하나 추가만 하고 결재자를
   * 고르지 않은 상태도 **비어 있는 것**이다 — 그렇게 보내면 서버가 거절하므로, aria-disabled 와
   * 핸들러의 거절과 안내 문구가 같은 잣대를 써야 한다(규칙 2·3).
   */
  const lineEmpty = filledLineSteps(line).length === 0

  /** 이 대화상자가 쓰는 HTTP 한 번. 실패도 응답이다 — 던지지 않아야 절차가 version 을 돌려줄 수 있다. */
  const call: ApprovalDraftCall = async (method, path, body) => {
    const response = await fetch(path, { method, headers, body: JSON.stringify(body) })
    const parsed = await response.json().catch(() => ({})) as { document?: { version?: number }; error?: { message?: string; currentVersion?: number | null } }
    return { ok: response.ok, body: parsed }
  }

  const save = async (submit: boolean) => {
    if (busy) return
    if (submit && lineEmpty) { onToast(APPROVAL_LINE_REQUIRED_MESSAGE); return }
    setBusy(true)
    try {
      const body = bodyOf()
      if (draft) {
        const outcome = await saveApprovalDraft({ id: draft.id, version, payload: body, submit, call })
        // 실패했더라도 서버가 아는 지금 version 을 받아 적는다 — 그래야 다음 시도가 이어진다.
        setVersion(outcome.version)
        if (!outcome.ok) {
          onToast(outcome.message)
          // 목록의 그 줄도 낡았다. 닫지는 않는다 — 사람이 고치던 내용이 이 대화상자 안에 있다.
          onRefresh?.()
          return
        }
        onToast(outcome.submitted ? '상신했습니다. 결재선의 첫 단계로 넘어갑니다.' : '임시저장했습니다.')
        onSaved()
        return
      }
      const created = await fetch('/api/approval-documents', {
        method: 'POST', headers, body: JSON.stringify({ ...body, submit, clientRequestId }),
      })
      const result = await created.json() as { document?: ApprovalDocument; error?: { message?: string } }
      if (!created.ok || !result.document) throw new Error(result.error?.message || '결재를 올리지 못했습니다.')
      onToast(submit ? '상신했습니다. 결재선의 첫 단계로 넘어갑니다.' : '임시저장했습니다.')
      onSaved()
    } catch (reason) {
      onToast(reason instanceof Error ? reason.message : '결재를 올리지 못했습니다.')
      onRefresh?.()
    } finally {
      setBusy(false)
    }
  }

  /** 잘못 시작한 기안을 지우는 길. 상신한 뒤에는 서버가 409로 막고, 그때는 회수·반려로만 끝난다. */
  const removeDraft = async () => {
    if (busy || !draft) return
    setBusy(true)
    try {
      const response = await fetch(`/api/approval-documents/${encodeURIComponent(draft.id)}`, {
        method: 'DELETE', headers: workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined,
      })
      const body = await response.json() as { error?: { message?: string } }
      if (!response.ok) throw new Error(body.error?.message || '기안을 지우지 못했습니다.')
      onToast('기안을 지웠습니다. 첨부한 자료는 자료실에 그대로 남습니다.')
      onSaved()
    } catch (reason) {
      onToast(reason instanceof Error ? reason.message : '기안을 지우지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section className="modal-card approval-draft-modal" role="dialog" aria-modal="true" aria-labelledby="approval-draft-title">
      <header>
        <div>
          <span className="eyebrow">NEW APPROVAL</span>
          <h2 id="approval-draft-title">{draft ? '기안 이어서 작성' : '새 기안'}</h2>
          <p>양식을 고르고 내용을 적은 뒤, 누구에게 어떤 순서로 갈지 정합니다.</p>
        </div>
        <IconButton tone="ghost" type="button" aria-label="닫기" onClick={onClose}><X size={21} /></IconButton>
      </header>

      <form onSubmit={(event) => { event.preventDefault(); void save(true) }}>
        <label className="form-field full">
          <span>양식</span>
          <select value={formId} disabled={Boolean(draft)} onChange={(event) => chooseForm(event.target.value)}>
            <option value="">양식을 고르세요</option>
            {selectable.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} · {entry.kind}</option>)}
          </select>
        </label>
        {draft ? <p className="approval-field-note">이미 만든 기안의 양식은 바꿀 수 없습니다. 다른 양식으로 올리려면 새로 기안해 주세요.</p> : null}
        {form?.description ? <p className="approval-field-note">{form.description}</p> : null}

        <label className="form-field full">
          <span>제목</span>
          <input value={title} maxLength={120} placeholder="예: 3월 거래처 접대비 지출결의" onChange={(event) => setTitle(event.target.value)} />
        </label>

        {form
          ? <div className="approval-field-grid">
            {form.fields.map((field) => <label key={field.key} className="form-field">
              <span>{field.label} {field.required ? null : <em className="field-optional">선택</em>}</span>
              {field.type === 'select'
                ? <select value={values[field.key] ?? ''} onChange={(event) => setValue(field.key, event.target.value)}>
                  <option value="">고르세요</option>
                  {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
                : field.type === 'date'
                  ? <input type="date" max="2100-12-31" value={values[field.key] ?? ''} onChange={(event) => setValue(field.key, event.target.value)} />
                  : field.type === 'attachment'
                    ? <input type="file" disabled={uploading === field.key} onChange={(event) => void pickAttachment(field, event.target.files?.[0] ?? null)} />
                    : <input
                      type="text"
                      inputMode={field.type === 'money' || field.type === 'number' ? 'numeric' : undefined}
                      value={values[field.key] ?? ''}
                      onChange={(event) => setValue(field.key, event.target.value)}
                    />}
              {field.help ? <em className="field-optional">{field.help}</em> : null}
              {field.type === 'attachment' && values[field.key] ? <em className="field-optional">{nameOf(values[field.key])}</em> : null}
            </label>)}
          </div>
          : <p className="approval-field-note">{draft
            ? '이 기안이 쓰던 양식이 더 이상 쓰이지 않아 항목을 보여 줄 수 없습니다. 적어 둔 값은 그대로 남아 있고, 제목·첨부·결재선은 고칠 수 있습니다.'
            : '쓸 수 있는 양식이 없습니다. 관리자가 「양식 관리」에서 하나 만들어야 기안할 수 있습니다.'}</p>}

        <div className="form-field full">
          <span>첨부 자료</span>
          <input type="file" disabled={uploading === 'attachments'} onChange={(event) => void addAttachment(event.target.files?.[0] ?? null)} />
          <ul className="approval-attach-list">
            {attachments.map((id) => <li key={id}>
              <Paperclip size={12} /> {nameOf(id)}
              <IconButton tone="quiet" size="sm" type="button" aria-label={`${nameOf(id)} 첨부 빼기`} onClick={() => setAttachments((current) => current.filter((entry) => entry !== id))}><X size={13} /></IconButton>
            </li>)}
          </ul>
          <em className="field-optional">올린 파일은 기업 자료실에도 함께 보관됩니다.</em>
        </div>

        <div className="form-field full">
          <span>결재선</span>
          <div className="approval-line-editor">
            {line.map((step, index) => <div key={`step-${index + 1}`} className="approval-line-step">
              <strong>{index + 1}단계</strong>
              <div>
                <div className="approval-line-modes">
                  <label>
                    <input type="radio" name={`approval-step-mode-${index}`} value="sequential" checked={step.mode === 'sequential'} onChange={(event) => setStepMode(index, event.target.value === 'parallel' ? 'parallel' : 'sequential')} />
                    순차(1명)
                  </label>
                  <label>
                    <input type="radio" name={`approval-step-mode-${index}`} value="parallel" checked={step.mode === 'parallel'} onChange={(event) => setStepMode(index, event.target.value === 'parallel' ? 'parallel' : 'sequential')} />
                    병렬(전원 승인)
                  </label>
                </div>
                <div className="approval-line-approvers">
                  {step.approverIds.map((approverId, slot) => <span key={`${index + 1}-${slot + 1}`}>
                    <select value={approverId} onChange={(event) => setApprover(index, slot, event.target.value)}>
                      <option value="">결재자를 고르세요</option>
                      {candidates.map((member) => <option key={member.id} value={member.id}>{member.name}{member.team ? ` · ${member.team}` : ''}</option>)}
                    </select>
                    {step.mode === 'parallel' && step.approverIds.length > 2
                      ? <IconButton tone="quiet" size="sm" type="button" aria-label={`${index + 1}단계 결재자 빼기`} onClick={() => removeApprover(index, slot)}><X size={13} /></IconButton>
                      : null}
                  </span>)}
                  {step.mode === 'parallel' && step.approverIds.length < MAX_APPROVERS_PER_STEP
                    ? <Button tone="ghost" size="sm" type="button" onClick={() => addApprover(index)}><Plus size={13} /> 결재자 추가</Button>
                    : null}
                </div>
              </div>
              <Button tone="ghost" size="sm" type="button" onClick={() => removeStep(index)}><Trash2 size={13} /> 단계 삭제</Button>
            </div>)}
            <div className="approval-line-actions">
              <Button tone="ghost" size="sm" type="button" disabled={line.length >= MAX_LINE_STEPS} onClick={addStep}><Plus size={14} /> 단계 추가</Button>
              {lineEmpty ? <span className="approval-field-note">{APPROVAL_LINE_REQUIRED_MESSAGE}</span> : null}
            </div>
          </div>
        </div>

        <label className="form-field full">
          <span>참조 <em className="field-optional">선택</em></span>
          <select value={ccPick} onChange={(event) => addCc(event.target.value)}>
            <option value="">참조로 넣을 사람을 고르세요</option>
            {candidates.filter((member) => !ccIds.includes(member.id)).map((member) => <option key={member.id} value={member.id}>{member.name}{member.team ? ` · ${member.team}` : ''}</option>)}
          </select>
          <ul className="approval-attach-list">
            {ccIds.map((id) => <li key={id}>
              {candidates.find((member) => member.id === id)?.name ?? id}
              <IconButton tone="quiet" size="sm" type="button" aria-label="참조에서 빼기" onClick={() => setCcIds((current) => current.filter((entry) => entry !== id))}><X size={13} /></IconButton>
            </li>)}
          </ul>
        </label>

        <footer>
          {draft ? <Button tone="danger" type="button" disabled={busy} onClick={() => void removeDraft()}><Trash2 size={16} /> 기안 삭제</Button> : null}
          <Button tone="ghost" type="button" disabled={busy} onClick={() => void save(false)}>임시저장</Button>
          <Button
            tone="primary"
            type="submit"
            aria-disabled={lineEmpty || busy}
            title={lineEmpty ? APPROVAL_LINE_REQUIRED_MESSAGE : undefined}
          ><SendHorizontal size={17} /> {busy ? '보내는 중…' : '상신'}</Button>
        </footer>
      </form>
    </section>
  </div>
}

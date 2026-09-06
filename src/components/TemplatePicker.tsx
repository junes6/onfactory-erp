import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { ChevronLeft, Copy, LayoutTemplate, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import { StatusBadge } from './StatusBadge'
import { Button, IconButton } from './ui/Button'
import { useDialogFocus } from './CompletionModal'
import { useIndustrySurface } from '../modules/IndustryContext'
import { formatDateTime } from '../utils/dateTime'
import './TemplatePicker.css'

/**
 * 프로젝트 템플릿 화면 조각 모음(설계서 B절 §4).
 *
 * 한 파일에 모아 둔 이유: 템플릿 타입·목록 호출·역할 매핑·저장·관리가 모두 같은 서버 계약
 * (`/api/project-templates`)을 읽는다. 흩어 놓으면 응답 모양이 바뀔 때 고쳐야 할 곳이 늘어난다.
 * ProjectSpaces는 여기서 컴포넌트를 가져다 붙이기만 하고, App은 이 파일을 모른다.
 */

export type TemplatePriority = '긴급' | '높음' | '보통'
export type ProjectTemplateChild = { key: string; title: string; role: string; dueOffsetDays: number; priority?: TemplatePriority; category?: string }
export type ProjectTemplateTask = { key: string; title: string; role: string; dueOffsetDays: number; priority: TemplatePriority; category: string; checklist?: string[]; children: ProjectTemplateChild[] }
export type ProjectTemplateChannel = { name: string; purpose?: string }
export type ProjectTemplateRule = { key: string; title: string; description: string; role: string; frequency: string; interval: number; dueTime: string; priority: string; category: string }
export type ProjectTemplateHistory = { version: number; at: string; byId: string; byName: string; summary: string }
export type ProjectTemplate = {
  id: string
  name: string
  description: string
  industryType: string | null
  origin: 'system' | 'custom'
  version: number
  roles: string[]
  tasks: ProjectTemplateTask[]
  channels: ProjectTemplateChannel[]
  documentCategories: string[]
  rules: ProjectTemplateRule[]
  history?: ProjectTemplateHistory[]
  taskCount?: number
  childCount?: number
  sourceProjectId?: string
  sourceTemplateId?: string
  createdAt: string
  updatedAt: string
}
/** 프로젝트가 어디서 비롯됐는지. 템플릿에서 만든 프로젝트만 이 값을 가진다(게스트에게는 서버가 지운다). */
export type ProjectOrigin = { kind: string; templateId?: string; templateName?: string; templateVersion?: number }
/** 역할에 사람을 붙일 때 쓰는 최소 정보. ProjectSpaces의 DirectoryEntry가 그대로 들어온다. */
export type TemplateDirectoryEntry = { id: string; name: string; team?: string; jobRole?: string; kind?: string }
type TemplateDraftPerson = { accountId: string; name: string; jobRole: string; team: string; suggestedRole: string; taskCount: number }

const TEMPLATE_PRIORITIES: TemplatePriority[] = ['긴급', '높음', '보통']
/**
 * 반복 주기 문구. App.tsx의 RULE_FREQUENCY_LABELS와 글자까지 같아야 한다 —
 * 같은 규칙을 업무 화면과 템플릿 화면이 다른 말로 부르면 같은 것인지 알 수 없다.
 */
const RULE_FREQUENCY_LABEL: Record<string, string> = {
  daily: '매일', weekly: '매주', biweekly: '격주', monthly: '매월', quarterly: '분기', yearly: '연 1회',
}
const MAX_DUE_OFFSET_DAYS = 3650

/** 서버 오류는 code·message에 더해 막힌 자리(path)나 역할 이름 같은 사실을 담고 온다. 화면은 그 사실로 문장을 다시 만든다. */
type TemplateApiError = { code?: string; message?: string; path?: string; role?: string }

async function readJson<T>(response: Response): Promise<T & { error?: TemplateApiError }> {
  const text = await response.text()
  try { return JSON.parse(text) } catch { return { error: { message: text } } as T & { error?: TemplateApiError } }
}

/**
 * 오류 한 줄. 서버가 어느 줄에서 막혔는지(path: `tasks[3].category`) 알려 주면 그 자리를 함께 말한다 —
 * 업무가 다섯 줄인데 '업무 분류를 입력해 주세요'만 띄우면 어느 줄을 고쳐야 할지 알 수 없다.
 */
const errorLine = (error: TemplateApiError | undefined, fallback: string) => {
  const message = error?.message || fallback
  return error?.path ? `${message} (${error.path})` : message
}
/**
 * 요청이 서버에 닿지 못했을 때. 응답이 없으니 서버의 말을 지어내지 않고, 다시 해 볼 수 있다고만 말한다.
 * 이 문장이 없으면 busy만 켜진 채로 화면이 굳는다 — 눌린 버튼이 영영 '저장 중…'에 머문다.
 */
const NETWORK_ERROR = '서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.'

const childCountOf = (template: ProjectTemplate) => template.childCount ?? template.tasks.reduce((sum, task) => sum + task.children.length, 0)
const taskCountOf = (template: ProjectTemplate) => template.taskCount ?? template.tasks.length
const templateSummaryLine = (template: ProjectTemplate) => [
  `업무 ${taskCountOf(template)}`,
  `하위 ${childCountOf(template)}`,
  `채널 ${template.channels.length}`,
  template.roles.length ? `역할 ${template.roles.join('·')}` : '',
  `v${template.version}`,
].filter(Boolean).join(' · ')

/** 템플릿 목록. 관리자가 아니거나 만들기 화면이 아니면 아예 부르지 않는다(enabled=false). */
export function useProjectTemplates(workspaceScope?: string, enabled = true) {
  const headers = useMemo(() => (workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined), [workspaceScope])
  const [templates, setTemplates] = useState<ProjectTemplate[] | null>(null)
  const [error, setError] = useState('')
  const reload = useCallback(async () => {
    if (!enabled) return
    try {
      const response = await fetch('/api/project-templates', { headers })
      const body = await readJson<{ templates?: ProjectTemplate[] }>(response)
      if (!response.ok) throw new Error(body.error?.message || '템플릿을 불러오지 못했습니다.')
      setTemplates(body.templates ?? [])
      setError('')
    } catch (reason) {
      // 실패를 빈 목록으로 바꾸지 않는다 — 빈 배열은 '이 회사에 템플릿이 없다'는 사실이고, 우리는 그것을 알지 못한다.
      setError(reason instanceof Error ? reason.message : '템플릿을 불러오지 못했습니다.')
    }
  }, [enabled, headers])
  useEffect(() => { void reload() }, [reload])
  return { templates, reload, error }
}

/** 템플릿에서 만든 프로젝트임을 밝히는 배지. 출처가 없으면 아무것도 그리지 않는다 — 없는 근거를 지어내지 않는다. */
export function ProjectOriginBadge({ origin }: { origin?: ProjectOrigin | null }) {
  const fromTemplate = origin?.kind === 'template'
  if (!fromTemplate || !origin) return null
  return <StatusBadge className="status-pill project-origin-badge" tone="neutral" icon={<LayoutTemplate size={12} />}>
    템플릿 · {origin.templateName || '이름 없음'}{origin.templateVersion ? ` v${origin.templateVersion}` : ''}
  </StatusBadge>
}

/**
 * 새 프로젝트 편집기 맨 위의 템플릿 선택. 라디오만 두고 버튼을 두지 않는다 —
 * 이 화면의 기본 버튼은 편집기 바닥의 '프로젝트 만들기' 하나여야 한다.
 */
export function TemplatePicker({ templates, selectedId, error, onSelect, onRetry }: {
  templates: ProjectTemplate[] | null
  selectedId: string
  /** 목록을 불러오지 못한 사정. 이때는 '없습니다'라고 말하지 않는다 — 없는지 아닌지 모른다. */
  error?: string
  onSelect: (templateId: string) => void
  onRetry?: () => void
}) {
  // 펼침 상태의 출처는 하나다. 처음 열릴 때만 선택 여부로 정하고, 그 뒤에는 사용자의 토글만 따른다
  // (open을 선택값으로 계산하면 사용자가 접어도 다음 렌더에서 다시 펼쳐진다).
  const [open, setOpen] = useState(() => Boolean(selectedId))
  return <details className="project-template-picker" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><LayoutTemplate size={16} /> 템플릿에서 시작 <span>선택 · 업무·하위 업무·채널·반복 규칙·자료 분류가 함께 만들어집니다</span></summary>
    {error
      ? <div className="project-template-options">
        <p className="workflow-upload-error" role="alert">{error}</p>
        {/* 이 갈래에는 '템플릿 없이' 라디오가 없다 — 고른 것을 되돌릴 길까지 없으면 만들기 버튼이 막힌 채 빠져나갈 수 없다. */}
        <div className="project-template-retry">
          {onRetry && <Button tone="quiet" size="sm" type="button" onClick={onRetry}><RotateCcw size={15} /> 다시 불러오기</Button>}
          {selectedId !== '' && <Button tone="quiet" size="sm" type="button" onClick={() => onSelect('')}>템플릿 없이 만들기</Button>}
        </div>
      </div>
      : templates === null
        ? <p className="project-template-note">템플릿을 불러오는 중…</p>
        : templates.length === 0
          ? <p className="project-template-note">아직 템플릿이 없습니다.</p>
          : <div className="project-template-options" role="radiogroup" aria-label="프로젝트 템플릿">
            <label className="project-template-option">
              <input type="radio" name="template" value="" checked={!selectedId} onChange={() => onSelect('')} />
              <span><strong>템플릿 없이</strong><small>빈 프로젝트</small></span>
            </label>
            {templates.map((template) => <label className={`project-template-option${selectedId === template.id ? ' is-selected' : ''}`} key={template.id}>
              <input type="radio" name="template" value={template.id} checked={selectedId === template.id} onChange={() => onSelect(template.id)} />
              <span>
                <strong>{template.name} {template.origin === 'system' && <StatusBadge className="status-pill" tone="info">기본</StatusBadge>}</strong>
                <small>{templateSummaryLine(template)}</small>
              </span>
            </label>)}
          </div>}
  </details>
}

/**
 * 역할에 사람을 정한다. 역할 이름과 사람의 직무가 겹치면 한 번만 미리 채워 주고,
 * 겹치는 사람이 없으면 비워 둔다 — 아무나 배정하지 않는다.
 */
export function TemplateRoleMapper({ template, directory, roleMap, onChange }: {
  template: ProjectTemplate
  directory: TemplateDirectoryEntry[]
  roleMap: Record<string, string>
  onChange: (role: string, accountId: string) => void
}) {
  const staff = directory.filter((entry) => entry.kind !== 'guest')
  const seededRef = useRef('')
  useEffect(() => {
    if (seededRef.current === template.id) return
    // 명부가 아직 오지 않았으면 '채웠다'고 표시하지 않는다 — 표시해 두면 명부가 도착한 뒤에도 영영 채워지지 않는다.
    if (!staff.length) return
    seededRef.current = template.id
    for (const role of template.roles) {
      if (roleMap[role]) continue
      const suggested = staff.find((entry) => entry.jobRole && (entry.jobRole.includes(role) || role.includes(entry.jobRole)))
      if (suggested) onChange(role, suggested.id)
    }
  })
  // role="group"이 없으면 이 div는 generic이라 이름을 가질 수 없다 — 화면 낭독기가 aria-label을 버린다.
  return <div className="project-template-roles" role="group" aria-label="역할별 담당자">
    <strong>역할에 사람을 정해 주세요</strong>
    {template.roles.map((role) => <label className="form-field" key={role}>
      <span>{role} <em>필수</em></span>
      <select value={roleMap[role] ?? ''} onChange={(event) => onChange(role, event.target.value)}>
        <option value="" disabled>직원 선택</option>
        {staff.map((entry) => <option value={entry.id} key={entry.id}>{entry.name}{entry.jobRole ? ` · ${entry.jobRole}` : ''}</option>)}
      </select>
    </label>)}
    <small className="project-template-note">이 사람들은 편집 멤버로 함께 들어갑니다. 업무 마감은 시작일 기준 D+n입니다.</small>
  </div>
}

/**
 * 지금 프로젝트를 템플릿으로 저장한다. 실명은 저장하지 않고, 사람마다 역할 이름을 직접 고쳐서 남긴다.
 * 저장할 수 없는 사정(업무 없음 등)은 서버가 준 문장을 그대로 보여 준다 — 같은 사실을 두 문장으로 말하지 않는다.
 */
export function TemplateSaveDialog({ project, workspaceScope, onClose, onSaved, onToast }: {
  project: { id: string; name: string }
  workspaceScope?: string
  onClose: () => void
  onSaved: (templateId: string) => void
  onToast: (message: string) => void
}) {
  const dialogRef = useDialogFocus()
  const headers = useMemo(() => ({ 'content-type': 'application/json', ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}) }), [workspaceScope])
  const [name, setName] = useState(() => `${project.name} 템플릿`.slice(0, 80))
  const [description, setDescription] = useState('')
  const [draft, setDraft] = useState<ProjectTemplate | null>(null)
  const [people, setPeople] = useState<TemplateDraftPerson[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [roleNames, setRoleNames] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey) }, [onClose])
  // 초안 불러오기는 다시 부를 수 있어야 한다 — 한 번 실패하면 기본 버튼이 !draft로 막혀 대화상자가 막다른 길이 된다.
  const reloadDraft = useCallback(async () => {
    setError('')
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}/template-draft`, { headers })
      const body = await readJson<{ draft?: ProjectTemplate; people?: TemplateDraftPerson[]; warnings?: string[] }>(response)
      if (!response.ok || !body.draft) { setError(errorLine(body.error, '템플릿 초안을 불러오지 못했습니다.')); return }
      setDraft(body.draft)
      setPeople(body.people ?? [])
      setWarnings(body.warnings ?? [])
      setRoleNames(Object.fromEntries((body.people ?? []).map((person) => [person.accountId, person.suggestedRole])))
    } catch { setError(NETWORK_ERROR) }
  }, [headers, project.id])
  useEffect(() => { void reloadDraft() }, [reloadDraft])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || name.trim().length < 2) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}/save-as-template`, {
        method: 'POST', headers, body: JSON.stringify({ name: name.trim(), description: description.trim(), roleMap: roleNames }),
      })
      const body = await readJson<{ template?: ProjectTemplate; warnings?: string[] }>(response)
      if (!response.ok || !body.template) { setBusy(false); setError(errorLine(body.error, '템플릿으로 저장하지 못했습니다.')); return }
      const saved = body.template
      const note = body.warnings?.[0] ? ` ${body.warnings[0]}` : ''
      onToast(`‘${saved.name}’ 템플릿을 저장했습니다 (역할 ${saved.roles.length}개, 업무 ${saved.tasks.length}건)${note}`)
      onSaved(saved.id)
    } catch {
      // 응답을 받지 못했으니 대화상자를 닫지 않는다 — 적어 둔 이름·역할 이름을 그대로 두고 다시 누를 수 있게 한다.
      setBusy(false)
      setError(NETWORK_ERROR)
    }
  }

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={dialogRef} className="modal-card project-template-save" role="dialog" aria-modal="true" aria-labelledby="project-template-save-title">
      <header>
        <div><span className="eyebrow">SAVE AS TEMPLATE</span><h2 id="project-template-save-title">템플릿으로 저장</h2><p>지금 프로젝트의 업무·하위 업무·채널·자료 분류를 다음 프로젝트에서 다시 씁니다.</p></div>
        <IconButton tone="ghost" type="button" aria-label="닫기" onClick={onClose}><X size={21} /></IconButton>
      </header>
      <form onSubmit={submit}>
        <label className="form-field full"><span>템플릿 이름 <em>필수</em></span><input value={name} onChange={(event) => setName(event.target.value)} autoFocus data-autofocus required minLength={2} maxLength={80} /></label>
        <label className="form-field full"><span>설명 <em>선택</em></span><input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} placeholder="어떤 일에 쓰는 템플릿인지 한 줄로" /></label>
        {draft && <p className="project-template-note">업무 {draft.tasks.length}건 · 하위 {childCountOf(draft)}건 · 채널 {draft.channels.length}개 · 자료 분류 {draft.documentCategories.length}개 — 담당자 실명은 저장하지 않고 역할만 남깁니다.</p>}
        {warnings.map((warning) => <p className="project-template-note" key={warning}>{warning}</p>)}
        {people.length > 0 && <ul className="project-role-map" aria-label="사람별 역할 이름">
          {people.map((person) => <li key={person.accountId}>
            <i className="project-avatar role-editor">{person.name.slice(0, 1)}</i>
            <span>{[person.name, person.jobRole, `업무 ${person.taskCount}건`].filter(Boolean).join(' · ')}</span>
            <input
              value={roleNames[person.accountId] ?? ''}
              maxLength={30}
              aria-label={`${person.name}의 역할 이름`}
              onChange={(event) => setRoleNames((current) => ({ ...current, [person.accountId]: event.target.value }))}
            />
          </li>)}
        </ul>}
        {error && <p className="workflow-upload-error" role="alert" id="project-template-save-error">{error}</p>}
        {error && !draft && <div className="project-template-retry"><Button tone="quiet" size="sm" type="button" onClick={() => void reloadDraft()}><RotateCcw size={15} /> 다시 불러오기</Button></div>}
        <footer>
          <Button tone="ghost" type="button" onClick={onClose} disabled={busy}>취소</Button>
          <Button tone="primary" type="submit" aria-describedby={!draft && error ? 'project-template-save-error' : undefined} disabled={busy || !draft || name.trim().length < 2}>{busy ? '저장 중…' : '템플릿으로 저장'}</Button>
        </footer>
      </form>
    </section>
  </div>
}

/** 서버가 받는 key 길이(24자)에서 일련번호 자리를 뺀 만큼만 앞자리로 쓴다 — 프로젝트에서 저장한 템플릿의 key는 이미 24자다. */
const KEY_PREFIX_MAX = 18
const nextKey = (used: Set<string>, prefix: string) => {
  for (let index = 1; index <= 999; index += 1) {
    const candidate = `${prefix}${index}`
    if (!used.has(candidate)) { used.add(candidate); return candidate }
  }
  return `${prefix}${used.size + 1}`
}
const usedKeysOf = (template: ProjectTemplate) => new Set([
  ...template.tasks.map((task) => task.key),
  ...template.tasks.flatMap((task) => task.children.map((child) => child.key)),
  ...template.rules.map((rule) => rule.key),
])
const emptyTemplate = (): ProjectTemplate => ({
  id: '', name: '', description: '', industryType: null, origin: 'custom', version: 0,
  roles: [], tasks: [], channels: [], documentCategories: [], rules: [], history: [],
  createdAt: '', updatedAt: '',
})

/**
 * 템플릿 관리 드로어. 목록에서는 기본 버튼이 없고(행마다 '열기' 하나),
 * 상세로 들어가야 '저장' 하나가 생긴다 — 한 화면의 기본 버튼은 언제나 하나다.
 */
export function TemplateManagerDrawer({ workspaceScope, canManage, initialId, onClose, onToast, onInstantiate }: {
  workspaceScope?: string
  canManage: boolean
  initialId?: string
  onClose: () => void
  onToast: (message: string) => void
  onInstantiate: (templateId: string) => void
}) {
  const industry = useIndustrySurface()
  const drawerRef = useDialogFocus()
  const headers = useMemo(() => ({ 'content-type': 'application/json', ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}) }), [workspaceScope])
  const { templates, reload, error: listError } = useProjectTemplates(workspaceScope)
  const [draft, setDraft] = useState<ProjectTemplate | null>(null)
  const [summary, setSummary] = useState('')
  const [roleInput, setRoleInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const openedRef = useRef(false)
  const readOnly = !canManage || draft?.origin === 'system'

  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey) }, [onClose])

  const openTemplate = useCallback(async (templateId: string) => {
    setError('')
    try {
      const response = await fetch(`/api/project-templates/${encodeURIComponent(templateId)}`, { headers })
      const body = await readJson<{ template?: ProjectTemplate }>(response)
      if (!response.ok || !body.template) { setError(errorLine(body.error, '템플릿을 열지 못했습니다.')); return }
      setDraft(body.template)
      setSummary('')
    } catch { setError(NETWORK_ERROR) }
  }, [headers])

  useEffect(() => {
    if (openedRef.current || !initialId) return
    openedRef.current = true
    void openTemplate(initialId)
  }, [initialId, openTemplate])

  const patchDraft = (change: Partial<ProjectTemplate>) => setDraft((current) => current ? { ...current, ...change } : current)
  const patchTask = (index: number, change: Partial<ProjectTemplateTask>) => setDraft((current) => current
    ? { ...current, tasks: current.tasks.map((task, position) => position === index ? { ...task, ...change } : task) }
    : current)
  // 자식은 언제나 최신 draft에서 꺼낸다 — 바깥 변수로 계산하면 연달아 고칠 때 직전 값이 되살아난다.
  const patchChild = (taskIndex: number, childIndex: number, change: Partial<ProjectTemplateChild>) => setDraft((current) => current
    ? {
      ...current,
      tasks: current.tasks.map((task, position) => position === taskIndex
        ? { ...task, children: task.children.map((child, childPosition) => childPosition === childIndex ? { ...child, ...change } : child) }
        : task),
    }
    : current)

  const save = async () => {
    if (!draft || busy) return
    setBusy(true)
    setError('')
    const payload = {
      name: draft.name.trim(), description: draft.description.trim(), industryType: draft.industryType,
      roles: draft.roles, tasks: draft.tasks, channels: draft.channels, documentCategories: draft.documentCategories, rules: draft.rules,
    }
    try {
      const response = draft.id
        ? await fetch(`/api/project-templates/${encodeURIComponent(draft.id)}`, { method: 'PATCH', headers, body: JSON.stringify({ ...payload, version: draft.version, summary: summary.trim() }) })
        : await fetch('/api/project-templates', { method: 'POST', headers, body: JSON.stringify(payload) })
      const body = await readJson<{ template?: ProjectTemplate }>(response)
      setBusy(false)
      if (!response.ok || !body.template) {
        if (body.error?.code === 'TEMPLATE_VERSION_CONFLICT' && draft.id) {
          onToast('다른 관리자가 먼저 바꿨습니다. 최신 내용을 불러옵니다.')
          await openTemplate(draft.id)
          await reload()
          return
        }
        setError(errorLine(body.error, '템플릿을 저장하지 못했습니다.'))
        return
      }
      onToast(`‘${body.template.name}’ 템플릿을 저장했습니다.`)
      setDraft(body.template)
      setSummary('')
      await reload()
    } catch {
      // 고쳐 둔 draft는 그대로 둔다 — 서버에 닿지 못했을 뿐이라 다시 누르면 같은 내용이 그대로 올라간다.
      setBusy(false)
      setError(NETWORK_ERROR)
    }
  }

  const duplicate = async () => {
    if (!draft?.id || busy) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/project-templates/${encodeURIComponent(draft.id)}/duplicate`, { method: 'POST', headers })
      const body = await readJson<{ template?: ProjectTemplate }>(response)
      setBusy(false)
      if (!response.ok || !body.template) { setError(errorLine(body.error, '템플릿을 복제하지 못했습니다.')); return }
      onToast(`‘${body.template.name}’ 템플릿을 만들었습니다. 이제 고칠 수 있습니다.`)
      setDraft(body.template)
      await reload()
    } catch { setBusy(false); setError(NETWORK_ERROR) }
  }

  const remove = async () => {
    if (!draft?.id || busy || !window.confirm(`‘${draft.name}’ 템플릿을 삭제할까요? 이 템플릿으로 이미 만든 프로젝트는 그대로 남습니다.`)) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/project-templates/${encodeURIComponent(draft.id)}`, { method: 'DELETE', headers })
      const body = await readJson<{ ok?: boolean }>(response)
      setBusy(false)
      if (!response.ok) { setError(errorLine(body.error, '템플릿을 삭제하지 못했습니다.')); return }
      onToast('템플릿을 삭제했습니다.')
      setDraft(null)
      await reload()
    } catch { setBusy(false); setError(NETWORK_ERROR) }
  }

  const addRole = (value: string) => {
    const role = value.trim().slice(0, 30)
    if (!draft || !role || draft.roles.includes(role)) return
    patchDraft({ roles: [...draft.roles, role] })
    setRoleInput('')
  }
  const addTask = () => {
    if (!draft) return
    const used = usedKeysOf(draft)
    patchDraft({ tasks: [...draft.tasks, { key: nextKey(used, 't'), title: '', role: draft.roles[0] ?? '', dueOffsetDays: 7, priority: '보통', category: '', children: [] }] })
  }
  const addChild = (taskIndex: number) => {
    if (!draft) return
    const task = draft.tasks[taskIndex]
    const used = usedKeysOf(draft)
    // 상위 key를 그대로 앞에 붙이면 24자를 넘겨 저장이 400으로 막힌다 — 화면에 없는 필드를 두고 사과하게 되므로 여기서 자른다.
    patchTask(taskIndex, { children: [...task.children, { key: nextKey(used, `${task.key.slice(0, KEY_PREFIX_MAX)}-c`), title: '', role: task.role, dueOffsetDays: task.dueOffsetDays }] })
  }

  const rows = templates ?? []

  return <div className="workflow-drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <aside ref={drawerRef} className="workflow-drawer project-template-drawer" role="dialog" aria-modal="true" aria-labelledby="project-template-drawer-title">
      <header className="workflow-drawer-head">
        <div>
          {draft && <button type="button" className="project-back" onClick={() => { setDraft(null); setError('') }}><ChevronLeft size={16} /> 템플릿 목록</button>}
          <h2 id="project-template-drawer-title">{draft ? (draft.name || '새 템플릿') : '프로젝트 템플릿'}</h2>
          {draft
            ? <div className="workflow-drawer-badges">
              <StatusBadge className="status-pill" tone={draft.origin === 'system' ? 'info' : 'neutral'}>{draft.origin === 'system' ? '기본' : '사용자'}</StatusBadge>
              {draft.id && <StatusBadge className="status-pill" tone="neutral">v{draft.version}</StatusBadge>}
              {draft.roles.length > 0 && <span>{draft.roles.join(' · ')}</span>}
            </div>
            : <p className="project-template-note">템플릿을 고르면 업무·하위 업무·채널·반복 규칙·자료 분류가 함께 만들어집니다.</p>}
        </div>
        <IconButton tone="ghost" type="button" aria-label="닫기" onClick={onClose}><X size={21} /></IconButton>
      </header>

      {!draft && <div className="workflow-drawer-body">
        {canManage && <div><Button tone="secondary" size="sm" type="button" onClick={() => { setDraft(emptyTemplate()); setSummary('') }}><Plus size={16} /> 새 템플릿</Button></div>}
        {/* 불러오지 못했으면 '불러오는 중'도 '없습니다'도 말하지 않는다 — 아래 한 줄이 사정을 말하고, 다시 불러올 길을 준다. */}
        {templates === null
          ? listError
            ? <div><Button tone="quiet" size="sm" type="button" onClick={() => void reload()}><RotateCcw size={15} /> 다시 불러오기</Button></div>
            : <p className="project-template-note">템플릿을 불러오는 중…</p>
          : rows.length === 0
            ? <div className="empty-state compact"><LayoutTemplate size={26} /><h3>아직 템플릿이 없습니다</h3><p>업무가 있는 프로젝트에서 ‘템플릿으로 저장’을 누르면 여기에 쌓입니다.</p></div>
            : <ul className="project-template-rows" aria-label="템플릿 목록">
              {rows.map((template) => <li className="project-template-row" key={template.id}>
                <StatusBadge className="status-pill" tone={template.origin === 'system' ? 'info' : 'neutral'}>{template.origin === 'system' ? '기본' : '사용자'}</StatusBadge>
                <div>
                  <strong>{template.name}</strong>
                  <small>{templateSummaryLine(template)} · {formatDateTime(template.updatedAt)}</small>
                </div>
                <Button tone="quiet" size="sm" type="button" onClick={() => void openTemplate(template.id)}>열기</Button>
              </li>)}
            </ul>}
        {(error || listError) && <p className="workflow-upload-error" role="alert">{error || listError}</p>}
      </div>}

      {draft && <>
        <div className="workflow-drawer-body">
          {draft.origin === 'system' && canManage && <div><Button tone="secondary" size="sm" type="button" disabled={busy} onClick={() => void duplicate()}><Copy size={16} /> 복제해서 고치기</Button></div>}
          <label className="form-field full"><span>템플릿 이름 <em>필수</em></span><input value={draft.name} disabled={readOnly} maxLength={80} onChange={(event) => patchDraft({ name: event.target.value })} /></label>
          <label className="form-field full"><span>설명 <em>선택</em></span><input value={draft.description} disabled={readOnly} maxLength={500} onChange={(event) => patchDraft({ description: event.target.value })} /></label>

          <section className="workflow-drawer-block" aria-label="역할">
            <span>ROLES</span>
            <div className="project-template-chips">
              {draft.roles.map((role) => <span className="project-template-chip" key={role}>{role}
                {!readOnly && <IconButton tone="quiet" size="sm" aria-label={`역할 ${role} 제외`} onClick={() => patchDraft({ roles: draft.roles.filter((item) => item !== role) })}><X size={13} /></IconButton>}
              </span>)}
            </div>
            {!readOnly && <label className="form-field full"><span>역할 추가</span><input
              value={roleInput}
              maxLength={30}
              placeholder="예: PM (Enter로 추가)"
              onChange={(event) => setRoleInput(event.target.value)}
              onKeyDown={(event) => { if (event.key !== 'Enter' || event.nativeEvent.isComposing) return; event.preventDefault(); addRole(roleInput) }}
            /></label>}
          </section>

          <section className="workflow-drawer-block" aria-label="업무 구성">
            <span>TASKS <small>{draft.tasks.length}</small></span>
            <ol className="project-template-tree">
              {draft.tasks.map((task, taskIndex) => <li key={task.key}>
                <div className="project-template-task-row">
                  <input value={task.title} disabled={readOnly} maxLength={120} aria-label={`업무 ${taskIndex + 1} 제목`} onChange={(event) => patchTask(taskIndex, { title: event.target.value })} />
                  <select value={task.role} disabled={readOnly} aria-label={`업무 ${taskIndex + 1} 역할`} onChange={(event) => patchTask(taskIndex, { role: event.target.value })}>
                    <option value="">역할 선택</option>
                    {draft.roles.map((role) => <option value={role} key={role}>{role}</option>)}
                  </select>
                  <input type="number" min={0} max={MAX_DUE_OFFSET_DAYS} value={task.dueOffsetDays} disabled={readOnly} aria-label={`업무 ${taskIndex + 1} 시작 후 며칠`} onChange={(event) => patchTask(taskIndex, { dueOffsetDays: Math.max(0, Math.min(MAX_DUE_OFFSET_DAYS, Number(event.target.value) || 0)) })} />
                  <select value={task.priority} disabled={readOnly} aria-label={`업무 ${taskIndex + 1} 중요도`} onChange={(event) => patchTask(taskIndex, { priority: event.target.value as TemplatePriority })}>
                    {TEMPLATE_PRIORITIES.map((priority) => <option value={priority} key={priority}>{priority}</option>)}
                  </select>
                  <input value={task.category} disabled={readOnly} maxLength={20} aria-label={`업무 ${taskIndex + 1} 구분`} list="project-template-work-categories" onChange={(event) => patchTask(taskIndex, { category: event.target.value })} />
                  {!readOnly && <IconButton tone="quiet" aria-label={`업무 ${task.title || taskIndex + 1} 제외`} onClick={() => patchDraft({ tasks: draft.tasks.filter((_item, position) => position !== taskIndex) })}><Trash2 size={15} /></IconButton>}
                </div>
                <ol className="project-template-children">
                  {task.children.map((child, childIndex) => <li className="is-child" key={child.key}>
                    <div className="project-template-task-row">
                      <input value={child.title} disabled={readOnly} maxLength={120} aria-label={`하위 업무 ${childIndex + 1} 제목`} onChange={(event) => patchChild(taskIndex, childIndex, { title: event.target.value })} />
                      <select value={child.role} disabled={readOnly} aria-label={`하위 업무 ${childIndex + 1} 역할`} onChange={(event) => patchChild(taskIndex, childIndex, { role: event.target.value })}>
                        <option value="">역할 선택</option>
                        {draft.roles.map((role) => <option value={role} key={role}>{role}</option>)}
                      </select>
                      <input type="number" min={0} max={MAX_DUE_OFFSET_DAYS} value={child.dueOffsetDays} disabled={readOnly} aria-label={`하위 업무 ${childIndex + 1} 시작 후 며칠`} onChange={(event) => patchChild(taskIndex, childIndex, { dueOffsetDays: Math.max(0, Math.min(MAX_DUE_OFFSET_DAYS, Number(event.target.value) || 0)) })} />
                      {!readOnly && <IconButton tone="quiet" aria-label={`하위 업무 ${child.title || childIndex + 1} 제외`} onClick={() => patchTask(taskIndex, { children: task.children.filter((_item, position) => position !== childIndex) })}><Trash2 size={15} /></IconButton>}
                    </div>
                  </li>)}
                </ol>
                {!readOnly && <Button tone="quiet" size="sm" type="button" onClick={() => addChild(taskIndex)}><Plus size={15} /> 하위 추가</Button>}
              </li>)}
            </ol>
            {!readOnly && <Button tone="quiet" size="sm" type="button" onClick={addTask}><Plus size={15} /> 업무 추가</Button>}
            <datalist id="project-template-work-categories">{industry.workCategories.map((category) => <option value={category} key={category} />)}</datalist>
          </section>

          <section className="workflow-drawer-block" aria-label="채널">
            <span>CHANNELS <small>{draft.channels.length}</small></span>
            {/* key는 자리다. 입력값을 key에 넣으면 한 글자 칠 때마다 React가 input을 새로 만들어 커서와 한글 조합이 끊긴다. */}
            {draft.channels.map((channel, index) => <div className="project-template-line" key={`channel-${index}`}>
              <input value={channel.name} disabled={readOnly} maxLength={60} aria-label={`채널 ${index + 1} 이름`} onChange={(event) => patchDraft({ channels: draft.channels.map((item, position) => position === index ? { ...item, name: event.target.value } : item) })} />
              <input value={channel.purpose ?? ''} disabled={readOnly} maxLength={120} aria-label={`채널 ${index + 1} 쓰임`} placeholder="무엇을 나누는 방인지" onChange={(event) => patchDraft({ channels: draft.channels.map((item, position) => position === index ? { ...item, purpose: event.target.value } : item) })} />
              {!readOnly && <IconButton tone="quiet" aria-label={`채널 ${channel.name || index + 1} 제외`} onClick={() => patchDraft({ channels: draft.channels.filter((_item, position) => position !== index) })}><Trash2 size={15} /></IconButton>}
            </div>)}
            {!readOnly && <Button tone="quiet" size="sm" type="button" onClick={() => patchDraft({ channels: [...draft.channels, { name: '', purpose: '' }] })}><Plus size={15} /> 채널 추가</Button>}
          </section>

          <section className="workflow-drawer-block" aria-label="자료 분류">
            <span>DOCUMENT CATEGORIES <small>{draft.documentCategories.length}</small></span>
            {/* 여기도 같다 — 분류 이름은 편집 대상이라 key가 될 수 없다. 줄은 끝에 붙고 가운데서 빠지므로 자리로 맞춘다. */}
            {draft.documentCategories.map((category, index) => <div className="project-template-line is-single" key={`doc-category-${index}`}>
              <input value={category} disabled={readOnly} maxLength={60} list="project-template-doc-categories" aria-label={`자료 분류 ${index + 1}`} onChange={(event) => patchDraft({ documentCategories: draft.documentCategories.map((item, position) => position === index ? event.target.value : item) })} />
              {!readOnly && <IconButton tone="quiet" aria-label={`자료 분류 ${category || index + 1} 제외`} onClick={() => patchDraft({ documentCategories: draft.documentCategories.filter((_item, position) => position !== index) })}><Trash2 size={15} /></IconButton>}
            </div>)}
            {!readOnly && <Button tone="quiet" size="sm" type="button" onClick={() => patchDraft({ documentCategories: [...draft.documentCategories, ''] })}><Plus size={15} /> 자료 분류 추가</Button>}
            <datalist id="project-template-doc-categories">{industry.documentCategories.map((category) => <option value={category} key={category} />)}</datalist>
          </section>

          <section className="workflow-drawer-block" aria-label="반복 규칙">
            <span>RECURRING RULES <small>{draft.rules.length}</small></span>
            {draft.rules.map((rule, index) => <div className="project-template-rule" key={rule.key}>
              <span>{rule.title} · {RULE_FREQUENCY_LABEL[rule.frequency] ?? rule.frequency} · {rule.role}</span>
              {!readOnly && <IconButton tone="quiet" aria-label={`반복 규칙 ${rule.title} 제외`} onClick={() => patchDraft({ rules: draft.rules.filter((_item, position) => position !== index) })}><Trash2 size={15} /></IconButton>}
            </div>)}
            {draft.rules.length === 0 && <p className="project-template-note">반복 규칙이 없습니다. 규칙은 업무 화면에서 만들고, 템플릿에는 저장된 것만 보여 줍니다.</p>}
          </section>

          {!readOnly && draft.id !== '' && <label className="form-field full"><span>수정 메모 <em>선택</em></span><input value={summary} maxLength={120} placeholder="무엇을 왜 고쳤는지 (비우면 ‘내용 수정’)" onChange={(event) => setSummary(event.target.value)} /></label>}

          <details className="project-template-history">
            <summary>수정 이력 {draft.history?.length ?? 0}</summary>
            {draft.history?.length
              ? <ol>{draft.history.map((entry) => <li key={`${entry.version}-${entry.at}`}>v{entry.version} · {formatDateTime(entry.at)} · {entry.byName} · {entry.summary}</li>)}</ol>
              : <p className="project-template-note">아직 수정 이력이 없습니다.</p>}
          </details>

          {error && <p className="workflow-upload-error" role="alert">{error}</p>}
        </div>
        <div className="project-template-foot">
          <Button tone="ghost" type="button" onClick={onClose}>닫기</Button>
          {canManage && draft.id !== '' && draft.origin !== 'system' && <Button tone="danger" type="button" disabled={busy} onClick={() => void remove()}><Trash2 size={16} /> 삭제</Button>}
          {canManage && draft.id !== '' && <Button tone="secondary" type="button" onClick={() => onInstantiate(draft.id)}><LayoutTemplate size={16} /> 이 템플릿으로 프로젝트 만들기</Button>}
          {!readOnly && <Button tone="primary" type="button" disabled={busy || draft.name.trim().length < 2} onClick={() => void save()}>{busy ? '저장 중…' : '저장'}</Button>}
        </div>
      </>}
    </aside>
  </div>
}

import { useCallback, useEffect, useState } from 'react'
import { BookmarkPlus, RotateCcw, Trash2 } from 'lucide-react'
import { Button, IconButton } from './ui/Button'
import { StatusBadge } from './StatusBadge'
import { SavedViewDialog, SAVED_VIEW_NAME_MAX } from './SavedViewDialog'
import type { CustomFieldDefinition } from './CustomFieldInputs'
import type { WorkViewMode } from './ViewSwitcher'
import { filtersEqual, type FilterNames, type WorkFilters, type WorkSort } from '../utils/workViews'

/**
 * 저장된 보기 — 조건 묶음에 이름을 붙이고, 관리자는 회사 전체에 나눈다.
 *
 * 훅을 App 최상위가 아니라 이 파일 안에서 부른다: src/hooks에 useWorkspaceState를 하나 더 붙이면
 * 게스트 계약 테스트가 고정한 `enabled: tenantDataEnabled,` 3회가 깨진다
 * (선례: WorkPage가 /api/work-rules/compliance를 이미 같은 방식으로 부른다).
 *
 * URL 쿼리스트링을 만들지 않는다 — 공유는 '회사 전체 보기' 하나뿐이다.
 * 링크로 나누기 시작하면 그 링크가 남의 권한 밖 조건을 담고, 열어 본 사람은 빈 목록을 보고
 * '데이터가 사라졌다'고 읽는다.
 */

export type SavedView = {
  id: string
  surface: string
  name: string
  mode: WorkViewMode
  filters: WorkFilters
  sort: WorkSort
  columns: string[]
  visibility: 'private' | 'tenant'
  ownerId: string
  ownerName: string
  createdAt: string
  updatedAt: string
}

export function useSavedViews(workspaceScope: string | undefined, enabled: boolean, surface = 'work') {
  const [views, setViews] = useState<SavedView[]>([])
  /**
   * 서버가 준 목록을 한 번이라도 받았는가. '아직 안 왔다'와 '보기가 하나도 없다'는 다른 사실이다 —
   * 둘을 같게 읽으면, 목록이 도착하기 전의 빈 배열이 고른 보기를 '지워진 보기'로 만들어 선택을 풀어 버린다.
   */
  const [loaded, setLoaded] = useState(false)
  const [token, setToken] = useState(0)
  useEffect(() => {
    if (!enabled || !workspaceScope) return
    let active = true
    fetch(`/api/saved-views?surface=${encodeURIComponent(surface)}`, { headers: { 'x-workspace-identity': workspaceScope } })
      .then((response) => response.ok ? response.json() : null)
      .then((body: { items?: SavedView[] } | null) => { if (active && body?.items) { setViews(body.items); setLoaded(true) } })
      // 못 읽어도 화면은 죽지 않는다 — 저장된 보기가 없는 평소 화면이 된다.
      .catch(() => undefined)
    return () => { active = false }
  }, [workspaceScope, enabled, surface, token])
  const reload = useCallback(() => setToken((current) => current + 1), [])
  /** 쓰기 응답이 실어 온 목록도 '서버가 준 목록'이다 — 재조회를 기다리지 않는다. */
  const applyItems = useCallback((items: SavedView[]) => { setViews(items); setLoaded(true) }, [])
  return { views, loaded, setViews: applyItems, reload }
}

export function SavedViewMenu({
  workspaceScope, enabled, canShare, currentUserId, surface = 'work',
  mode, filters, sort, columns, definitions = [], names = {}, activeId, onActiveIdChange, onApply, onToast,
}: {
  workspaceScope?: string
  enabled: boolean
  canShare: boolean
  currentUserId: string
  surface?: string
  mode: WorkViewMode
  filters: WorkFilters
  sort: WorkSort
  columns: string[]
  definitions?: CustomFieldDefinition[]
  names?: FilterNames
  /**
   * 고른 보기의 id는 **부모가 든다**(filters·sort·columns와 같은 자리).
   *
   * 이 안에 두었을 때 두 가지가 깨졌다: (1) 알림·전역검색으로 들어오면 앱이 스스로 필터를 지우는데
   * 그 id는 남아 있어서, 사람이 손대지 않은 조건 삭제가 '변경됨'이 되고 '변경 저장'이 그 보기를
   * 빈 조건으로 덮어썼다. (2) '반복 규칙' 탭에서 이 메뉴가 언마운트되면 조건은 살아 있는데 이름만 사라져,
   * select가 '기본 보기'라고 말하면서 저장된 보기의 조건이 걸린 화면이 됐다.
   * 조건을 떼는 것과 이름을 떼는 것은 한 동작이다 — 그래서 두 값이 한 자리에 산다.
   */
  activeId: string
  onActiveIdChange: (id: string) => void
  onApply: (view: { mode: WorkViewMode; filters: WorkFilters; sort: WorkSort; columns: string[] }) => void
  onToast: (message: string) => void
}) {
  const { views, loaded, setViews, reload } = useSavedViews(workspaceScope, enabled, surface)
  const [saveOpen, setSaveOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const setActiveId = onActiveIdChange

  const active = views.find((view) => view.id === activeId) ?? null
  // 고른 보기가 지워지거나 남에게서 회수되면 선택도 함께 사라진다 — 없는 보기의 '변경됨'을 말하지 않는다.
  // 목록이 아직 도착하지 않았을 때는 아무 판단도 하지 않는다(loaded) — 규칙 탭에서 돌아온 첫 렌더의
  // 빈 배열이 사람이 고른 보기를 지워 버리면, 위에서 id를 올린 이유가 그 자리에서 무효가 된다.
  useEffect(() => {
    if (loaded && activeId && !views.some((view) => view.id === activeId)) setActiveId('')
  }, [views, loaded, activeId, setActiveId])

  const sameAsActive = Boolean(active)
    && active!.mode === mode
    && active!.sort.field === sort.field && active!.sort.direction === sort.direction
    && active!.columns.join(' ') === columns.join(' ')
    && filtersEqual(active!.filters, filters)
  const dirty = Boolean(active) && !sameAsActive
  const isOwner = active?.ownerId === currentUserId

  const applyView = (id: string) => {
    setActiveId(id)
    const view = views.find((candidate) => candidate.id === id)
    // '기본 보기'로 돌아가는 것은 조건을 지우는 것이 아니라 이름을 떼는 것이다 — 지금 보고 있는 것은 그대로 둔다.
    if (view) onApply({ mode: view.mode, filters: view.filters, sort: view.sort, columns: view.columns })
  }
  const revert = () => { if (active) onApply({ mode: active.mode, filters: active.filters, sort: active.sort, columns: active.columns }) }

  const call = async (method: string, path: string, body?: unknown) => {
    if (!workspaceScope) return null
    setBusy(true)
    try {
      const response = await fetch(path, {
        method,
        headers: { 'content-type': 'application/json', 'x-workspace-identity': workspaceScope },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      const payload = await response.json() as { item?: SavedView; items?: SavedView[]; error?: { message?: string } }
      // 거절 사유는 서버가 준 그 문장 하나다 — 화면이 다시 지어 적으면 같은 사실이 두 문장이 된다.
      if (!response.ok) { onToast(payload.error?.message ?? '저장된 보기를 저장하지 못했습니다.'); return null }
      // 응답이 이미 '내가 볼 수 있는 목록'을 싣고 온다. 그것을 바로 쓴다 —
      // 재조회를 기다리는 사이에는 방금 만든 보기가 목록에 없어서, 아래 정리 effect가
      // 그 선택을 '지워진 보기'로 보고 '기본 보기'로 되돌린다(실측: 저장 직후 선택이 풀렸다).
      if (Array.isArray(payload.items)) setViews(payload.items)
      else reload()
      return payload
    } catch {
      onToast('저장된 보기 서버에 연결할 수 없습니다.')
      return null
    } finally { setBusy(false) }
  }

  const save = async (input: { name: string; visibility: 'private' | 'tenant'; columns: string[] }) => {
    const body = { surface, name: input.name, mode, filters, sort, columns: input.columns, visibility: input.visibility }
    const result = dirty && isOwner && active
      ? await call('PATCH', `/api/saved-views/${encodeURIComponent(active.id)}`, body)
      : await call('POST', '/api/saved-views', body)
    if (!result?.item) return
    setActiveId(result.item.id)
    onApply({ mode: result.item.mode, filters: result.item.filters, sort: result.item.sort, columns: result.item.columns })
    setSaveOpen(false)
    onToast(dirty && isOwner ? '저장된 보기를 바꿨습니다.' : '이 조건을 보기로 저장했습니다.')
  }

  const remove = async () => {
    if (!active) return
    const result = await call('DELETE', `/api/saved-views/${encodeURIComponent(active.id)}`)
    if (result) { setActiveId(''); onToast('저장된 보기를 지웠습니다.') }
  }

  const mine = views.filter((view) => view.visibility !== 'tenant')
  const shared = views.filter((view) => view.visibility === 'tenant')
  // 남의 공유 보기를 바꿨으면 덮어쓰기가 아니라 복사다 — 403 막다른 길을 만들지 않는다.
  const saveLabel = dirty && isOwner ? '변경 저장' : dirty ? '내 보기로 복사' : '이 보기 저장'
  const canRemove = Boolean(active) && (isOwner || (active!.visibility === 'tenant' && canShare))

  return <div className="work-saved-view">
    <label>
      <span className="sr-only">저장된 보기</span>
      <select value={activeId} disabled={busy} onChange={(event) => applyView(event.target.value)}>
        <option value="">기본 보기</option>
        {mine.length > 0 && <optgroup label="내 보기">
          {mine.map((view) => <option value={view.id} key={view.id}>{view.name}</option>)}
        </optgroup>}
        {shared.length > 0 && <optgroup label="회사 공유 보기">
          {shared.map((view) => <option value={view.id} key={view.id}>{view.name}</option>)}
        </optgroup>}
      </select>
    </label>
    {dirty && <StatusBadge className="status-pill" tone="warning">변경됨</StatusBadge>}
    {dirty && <Button tone="quiet" size="sm" type="button" onClick={revert}><RotateCcw size={15} /> 되돌리기</Button>}
    <Button tone="secondary" size="sm" type="button" disabled={busy} onClick={() => setSaveOpen(true)}><BookmarkPlus size={15} /> {saveLabel}</Button>
    {canRemove && <IconButton tone="quiet" type="button" aria-label={`${active!.name} 보기 삭제`} disabled={busy} onClick={() => void remove()}><Trash2 size={16} /></IconButton>}

    {saveOpen && <SavedViewDialog
      mode={mode}
      filters={filters}
      columns={columns}
      definitions={definitions}
      names={names}
      canShare={canShare}
      busy={busy}
      title={dirty && isOwner ? '보기 바꾸기' : '이 보기 저장'}
      // 사본 이름도 상한을 지난다 — 40자짜리 이름에 ' 사본'을 붙이면 서버가 400으로 답한다.
      initialName={dirty && isOwner ? active?.name : dirty ? `${active?.name ?? ''} 사본`.trim().slice(0, SAVED_VIEW_NAME_MAX) : undefined}
      initialVisibility={dirty && isOwner && active ? active.visibility : 'private'}
      onClose={() => setSaveOpen(false)}
      onSubmit={(input) => void save(input)}
    />}
  </div>
}

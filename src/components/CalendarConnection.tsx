import { AlertTriangle, CalendarSync, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from './ui/Button'
import { BRAND } from '../brand'
import { formatListDateTime } from '../utils/dateTime'
import './CalendarConnection.css'

/**
 * 구글 캘린더 연결 — 일정 화면 안에서 끝낸다.
 *
 * 새 메뉴를 만들지 않는다. 연결·해제·캘린더 선택·재연결 안내가 전부 일정 화면 한 블록 안에 있다.
 *
 * 왜 useWorkspaceState를 쓰지 않는가: 이 화면의 최상위 훅 수는 계약으로 고정돼 있고(guest-ui-contract),
 * 연결 상태는 테넌트 공유 배열이 아니라 '내 계정의 연결 한 건'이다. 자료실의 load() 관례를 따라
 * 컴포넌트 안에서 fetch로 읽는다.
 *
 * 모든 네트워크 호출은 try/catch로 감싸고 finally에서 진행 상태를 푼다 —
 * 실패 한 번이 버튼을 영영 눌리지 않게 만들면 사용자는 화면을 새로 고칠 수밖에 없다.
 */

export type CalendarConnectionCalendar = {
  id: string
  summary: string
  selected: boolean
  primary: boolean
  accessRole: string
}

export type CalendarConnectionInfo = {
  id: string
  email: string
  status: 'connected' | 'needs-reauth' | 'revoked'
  calendars: CalendarConnectionCalendar[]
  writeCalendarId: string
  pushWorkDue: boolean
  lastSyncAt: string | null
  lastError: string
  counts: { linked: number; workDue: number; truncated: number; readOnly: number }
}

/**
 * 한 상태를 부르는 한 이름.
 * 카드의 칩과 관리자 개관이 각자 문자열을 적으면 같은 사실을 두 사람이 다른 말로 읽는다
 * ('연결 안 됨'과 '해제됨'은 같은 revoked였다).
 */
export const CALENDAR_STATUS_LABELS: Record<string, string> = {
  connected: '연결됨',
  'needs-reauth': '재연결 필요',
  revoked: '연결 안 됨',
}

export type CalendarConnectionStatus = {
  configured: boolean
  secretBoxReady: boolean
  secretBoxMessage: string
  connection: CalendarConnectionInfo | null
  externalEventIds: string[]
  externalEventIdsTruncated: boolean
  syncing: boolean
  autoSyncStaleMs: number
}

/**
 * 콜백이 돌려보낸 이유값을 문장으로 바꾼다.
 * reason 문자열을 그대로 보여 주지 않는다 — 'norefresh'는 사용자에게 아무 뜻도 아니다.
 */
export const CALENDAR_CALLBACK_MESSAGES: Record<string, string> = {
  session: '로그인이 풀려 연결을 마치지 못했습니다. 다시 로그인한 뒤 시도해 주세요.',
  forbidden: '외부 게스트 계정은 구글 캘린더를 연결할 수 없습니다.',
  tenant: '고객사 워크스페이스에서만 구글 캘린더를 연결할 수 있습니다.',
  state: '연결 요청이 만료되었습니다. 다시 시도해 주세요.',
  scope: '구글에서 캘린더 권한을 허용하지 않았습니다. 동의 화면에서 캘린더 항목을 모두 체크해 주세요.',
  exchange: '구글과 토큰을 주고받지 못했습니다. 잠시 후 다시 시도해 주세요.',
  norefresh: '구글이 갱신 권한을 주지 않았습니다. 구글 계정 설정에서 이 앱의 권한을 지운 뒤 다시 연결해 주세요.',
  key: '서버에 비밀 보관 키가 없어 연결을 저장하지 못했습니다. 운영 담당자에게 문의해 주세요.',
  upstream: '구글에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.',
}

const STATUS_ENDPOINT = '/api/integrations/google/calendar'
const canWrite = (calendar: CalendarConnectionCalendar) => calendar.accessRole === 'owner' || calendar.accessRole === 'writer'

/**
 * 우리가 구글 쪽 허가를 거두지 못한 채 연결을 끊었을 때만 덧붙인다.
 * 서버는 암호문을 지우기 전에 한 번만 거둘 수 있어서 두 번째 기회가 없다 — 아무 말도 하지 않으면
 * 사용자는 구글 계정에 살아 있는 캘린더 쓰기 권한을 남긴 채 '해제했습니다'만 읽는다.
 * 해제와 기록 삭제가 같은 한 문장을 쓴다.
 */
export const CALENDAR_MANUAL_REVOKE_MESSAGE = '구글에서 이 앱의 권한을 거두지 못했습니다. 구글 계정 설정(myaccount.google.com/permissions)에서 직접 해제해 주세요.'
const withRevokeNote = (message: string, body: { hadToken?: boolean; revoked?: boolean }) => (
  body.hadToken && !body.revoked ? `${message} ${CALENDAR_MANUAL_REVOKE_MESSAGE}` : message
)

/**
 * 서버의 MAX_SELECTED_CALENDARS·CALENDAR_TOO_MANY_MESSAGE(server/calendar-sync.mjs)와 같은 값·같은 문장이다.
 * 미리 알리는 문장과 서버가 거절할 때의 문장이 하나여야 사람이 같은 말을 두 번 듣지 않는다 —
 * 계약 시험(scripts/calendar-connection-ui-contract.test.mjs)이 두 파일을 맞춰 둔다.
 */
const MAX_SELECTED_CALENDARS = 10
const CALENDAR_TOO_MANY_MESSAGE = `동기화할 캘린더는 최대 ${MAX_SELECTED_CALENDARS}개까지 고를 수 있습니다.`

type OverwriteEntry = {
  at: string
  source: 'google' | 'inthefield'
  byName: string
  before: { title: string; date: string; start: string; end: string; location: string; note: string }
}

export type OverwriteHistory = {
  overwrites: OverwriteEntry[]
  truncated: string
  readOnly: boolean
  /**
   * 이 일정의 변경이 구글로 못 나가는 이유. **서버가 실제로 한 판정을 그대로 받는다** —
   * 'read-only' | 'unselected' | 'unknown'(구글 계정에서 사라진 캘린더) | ''.
   * 화면이 accessRole을 보고 스스로 판단하면 서버가 한 일과 어긋난다.
   */
  sourceBlocked?: string
  externalId: string
}

const FIELD_LABELS: Record<string, string> = {
  title: '제목', date: '날짜', start: '시작', end: '종료', location: '장소', note: '메모',
}

/**
 * 덮어쓴 내역. 0건이면 아예 그리지 않는다 — '0건'이라는 줄은 아무것도 알려 주지 않는다.
 * 다이얼로그가 열릴 때만 지연 로드하므로 일정 목록 응답에는 이력이 실리지 않는다.
 */
export function OverwriteHistoryDetails({ history, current }: {
  history: OverwriteHistory | null
  current: Record<string, string>
}) {
  if (!history || history.overwrites.length === 0) return null
  return (
    <details className="schedule-overwrite-history">
      <summary>덮어쓴 내역 {history.overwrites.length}건</summary>
      <ol>
        {history.overwrites.map((entry) => (
          <li className="schedule-overwrite-entry" key={`${entry.at}-${entry.source}`}>
            <span className="schedule-overwrite-when">
              {formatListDateTime(entry.at)} · {entry.source === 'google' ? '구글 캘린더' : `${entry.byName}님`}의 수정으로 덮어썼습니다
            </span>
            <dl>
              {Object.keys(FIELD_LABELS)
                .filter((field) => (entry.before[field as keyof OverwriteEntry['before']] ?? '') !== (current[field] ?? ''))
                .map((field) => (
                  <div key={field}>
                    <dt>{FIELD_LABELS[field]}</dt>
                    <dd>
                      <s>{entry.before[field as keyof OverwriteEntry['before']] || '(비어 있음)'}</s>
                      <span aria-hidden="true"> → </span>
                      <span>{current[field] || '(비어 있음)'}</span>
                    </dd>
                  </div>
                ))}
            </dl>
          </li>
        ))}
      </ol>
    </details>
  )
}

/**
 * 재연결 배너. 토스트가 아니라 배너인 이유: 토스트는 사라지고, 재연결은 사람이 마음먹어야 하는 일이다.
 */
export function CalendarReauthBanner({ lastSyncAt, onReconnect, busy }: {
  lastSyncAt: string | null
  onReconnect: () => void
  busy: boolean
}) {
  return (
    <div className="schedule-reauth-banner" role="alert">
      <AlertTriangle size={18} aria-hidden="true" />
      <span>
        구글 캘린더 연결이 끊어졌습니다.
        {lastSyncAt ? ` ${formatListDateTime(lastSyncAt)} 이후의 변경은 아직 오가지 않았습니다.` : ' 아직 한 번도 동기화하지 않았습니다.'}
      </span>
      <Button tone="secondary" size="sm" type="button" onClick={onReconnect} disabled={busy}>다시 연결</Button>
    </div>
  )
}

export function CalendarConnectionCard({
  workspaceScope,
  canManage,
  justConnected,
  onToast,
  onExternalIds,
  onSynced,
  onCallbackHandled,
  reloadToken = 0,
}: {
  workspaceScope?: string
  canManage: boolean
  /**
   * 일정 배열이 서버에서 갈아 끼워졌다는 신호. 스케줄러가 돌린 통과도 여기로 온다 —
   * 이 값을 다시 읽지 않으면 새로 들어온 일정에 '구글 캘린더와 연결된 일정' 표식이 붙지 않고
   * 마지막 동기화 시각도 화면을 다시 열 때까지 낡은 채로 남는다.
   */
  reloadToken?: number
  /** ?calendar=connected 로 막 돌아왔는가. 그렇다면 첫 동기화를 바로 한 번 돌린다. */
  justConnected: boolean
  onToast: (message: string) => void
  onExternalIds: (ids: string[]) => void
  /** 동기화가 끝났다 — 화면은 일정 배열을 서버에서 다시 읽는다. */
  onSynced: () => void
  /** 콜백 플래그를 썼다. 비워 두지 않으면 그 세션 동안 일정 화면에 들어올 때마다 구글 왕복이 한 번씩 더 돈다. */
  onCallbackHandled?: () => void
}) {
  const [status, setStatus] = useState<CalendarConnectionStatus | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState<'' | 'connect' | 'sync' | 'select' | 'refresh' | 'disconnect' | 'forget'>('')
  const [selection, setSelection] = useState<string[] | null>(null)
  const [overview, setOverview] = useState<Array<{ accountId: string; name: string; email: string; status: string; lastSyncAt: string | null; calendarCount: number }> | null>(null)
  const autoSyncedRef = useRef(false)

  const headers = workspaceScope ? { 'x-workspace-identity': workspaceScope } : undefined

  const load = useCallback(async () => {
    try {
      const response = await fetch(STATUS_ENDPOINT, { headers })
      if (!response.ok) throw new Error('calendar-status')
      const body = await response.json() as CalendarConnectionStatus
      setStatus(body)
      setLoadFailed(false)
      /**
       * **여기서 selection을 비우지 않는다.** load는 reloadToken이 오를 때마다 다시 돈다 —
       * 그 토큰은 같은 회사 누군가의 동기화(스케줄러 포함)로도 오른다. 비우면 지금 체크박스를
       * 만지던 사람의 선택이 아무 말 없이 서버 값으로 되돌아가고, '선택 적용'은 그대로 눌려
       * 본인이 고르지 않은 조합이 저장된다. 선택이 정해지는 자리는 applySelection의 성공 뒤 하나뿐이다.
       */
      onExternalIds(body.externalEventIds ?? [])
    } catch {
      setLoadFailed(true)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceScope, reloadToken])

  useEffect(() => { void load() }, [load])

  const syncNow = useCallback(async (automatic: boolean) => {
    setBusy('sync')
    try {
      const response = await fetch(`${STATUS_ENDPOINT}/sync`, { method: 'POST', headers })
      const body = await response.json().catch(() => ({})) as { error?: { message?: string }; result?: { pulled: number; pushed: number; conflicts: number } }
      if (!response.ok) {
        // 자동 1회 동기화의 실패는 사람이 시킨 일이 아니다. 조용히 상태만 다시 읽는다.
        if (!automatic) onToast(body.error?.message ?? '구글 캘린더와 동기화하지 못했습니다.')
        return
      }
      if (!automatic && body.result) {
        onToast(`가져옴 ${body.result.pulled}건 · 내보냄 ${body.result.pushed}건${body.result.conflicts ? ` · 덮어쓴 내역 ${body.result.conflicts}건` : ''}`)
      }
      onSynced()
    } catch {
      if (!automatic) onToast('구글 캘린더와 동기화하지 못했습니다. 잠시 후 다시 시도해 주세요.')
    } finally {
      setBusy('')
      await load()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, onSynced, onToast, workspaceScope])

  // 화면에 들어왔는데 오래 안 돌았으면 한 번 돌린다. 배포에 폴링이 없어 이것이 유일한 자동 경로다.
  useEffect(() => {
    if (autoSyncedRef.current || !status?.connection || status.connection.status !== 'connected') return
    const age = status.connection.lastSyncAt ? Date.now() - Date.parse(status.connection.lastSyncAt) : Number.POSITIVE_INFINITY
    if (!justConnected && age < status.autoSyncStaleMs) return
    autoSyncedRef.current = true
    // 플래그는 한 번 쓰고 비운다. 남겨 두면 화면을 드나들 때마다 '방금 연결했다'로 읽혀 60분 규칙을 매번 건너뛴다.
    if (justConnected) onCallbackHandled?.()
    void syncNow(true)
  }, [justConnected, onCallbackHandled, status, syncNow])

  const connect = async () => {
    setBusy('connect')
    try {
      const response = await fetch(`${STATUS_ENDPOINT}/authorize`, { headers })
      const body = await response.json().catch(() => ({})) as { authorizeUrl?: string; error?: { message?: string } }
      if (!response.ok || !body.authorizeUrl) {
        onToast(body.error?.message ?? '구글 캘린더 연결을 시작하지 못했습니다.')
        setBusy('')
        return
      }
      // top-level 이동이어야 SameSite=Lax 세션 쿠키가 콜백에 실린다. fetch나 팝업으로 대체하지 않는다.
      window.location.assign(body.authorizeUrl)
    } catch {
      onToast('구글 캘린더 연결을 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.')
      setBusy('')
    }
  }

  const applySelection = async () => {
    if (!status?.connection) return
    setBusy('select')
    try {
      const response = await fetch(`${STATUS_ENDPOINT}/calendars`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...(headers ?? {}) },
        body: JSON.stringify({
          selected: selection ?? status.connection.calendars.filter((calendar) => calendar.selected).map((calendar) => calendar.id),
          writeCalendarId: status.connection.writeCalendarId,
          pushWorkDue: status.connection.pushWorkDue,
        }),
      })
      const body = await response.json().catch(() => ({})) as { error?: { message?: string } }
      if (!response.ok) { onToast(body.error?.message ?? '캘린더 선택을 저장하지 못했습니다.'); return }
      // 저장이 끝난 이 자리에서만 선택을 놓는다 — 아래 load()가 서버가 가진 값을 다시 그린다.
      setSelection(null)
      onToast('동기화할 캘린더를 저장했습니다.')
    } catch {
      onToast('캘린더 선택을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.')
    } finally {
      setBusy('')
      await load()
    }
  }

  /**
   * 구글에서 새로 만들거나 공유받은 캘린더를 데려온다.
   * 이것이 없으면 목록은 연결 시점에 얼어붙고, 되돌리는 길은 '연결 해제 → 다시 연결'뿐이다.
   */
  const refreshCalendars = async () => {
    setBusy('refresh')
    try {
      const response = await fetch(`${STATUS_ENDPOINT}/calendars/refresh`, { method: 'POST', headers })
      const body = await response.json().catch(() => ({})) as { error?: { message?: string } }
      if (!response.ok) { onToast(body.error?.message ?? '캘린더 목록을 새로 가져오지 못했습니다.'); return }
      onToast('구글에서 캘린더 목록을 새로 가져왔습니다.')
      onSynced()
    } catch {
      onToast('캘린더 목록을 새로 가져오지 못했습니다. 잠시 후 다시 시도해 주세요.')
    } finally {
      setBusy('')
      await load()
    }
  }

  const patchConnection = async (patch: Record<string, unknown>, message: string) => {
    setBusy('select')
    try {
      const response = await fetch(`${STATUS_ENDPOINT}/calendars`, {
        method: 'PATCH', headers: { 'content-type': 'application/json', ...(headers ?? {}) }, body: JSON.stringify(patch),
      })
      const body = await response.json().catch(() => ({})) as { error?: { message?: string } }
      if (!response.ok) { onToast(body.error?.message ?? message); return }
    } catch {
      onToast(message)
    } finally {
      setBusy('')
      await load()
    }
  }

  const disconnect = async () => {
    if (!window.confirm(`구글 캘린더 연결을 해제할까요?\n지금까지 가져온 일정은 ${BRAND.name}에 그대로 남고, 앞으로는 서로 오가지 않습니다.`)) return
    setBusy('disconnect')
    try {
      const response = await fetch(`${STATUS_ENDPOINT}/disconnect`, { method: 'POST', headers })
      const body = await response.json().catch(() => ({})) as { error?: { message?: string }; keptEvents?: number; hadToken?: boolean; revoked?: boolean }
      if (!response.ok) { onToast(body.error?.message ?? '연결을 해제하지 못했습니다.'); return }
      setSelection(null)
      onToast(withRevokeNote(`구글 캘린더 연결을 해제했습니다. 가져온 일정 ${body.keptEvents ?? 0}건은 그대로 남아 있습니다.`, body))
    } catch {
      onToast('연결을 해제하지 못했습니다. 잠시 후 다시 시도해 주세요.')
    } finally {
      setBusy('')
      await load()
    }
  }

  const forget = async () => {
    if (!window.confirm('연결 기록을 완전히 지울까요?\n덮어쓴 내역도 함께 사라집니다. 일정 자체는 남습니다.')) return
    setBusy('forget')
    try {
      const response = await fetch(STATUS_ENDPOINT, { method: 'DELETE', headers })
      const body = await response.json().catch(() => ({})) as { error?: { message?: string }; hadToken?: boolean; revoked?: boolean }
      if (!response.ok) { onToast(body.error?.message ?? '연결 기록을 지우지 못했습니다.'); return }
      setSelection(null)
      onToast(withRevokeNote('연결 기록을 지웠습니다.', body))
      onExternalIds([])
    } catch {
      onToast('연결 기록을 지우지 못했습니다. 잠시 후 다시 시도해 주세요.')
    } finally {
      setBusy('')
      await load()
    }
  }

  const loadOverview = async () => {
    if (overview) return
    try {
      const response = await fetch(`${STATUS_ENDPOINT}/overview`, { headers })
      if (!response.ok) throw new Error('overview')
      const body = await response.json() as { rows: Array<{ accountId: string; name: string; email: string; status: string; lastSyncAt: string | null; calendarCount: number }> }
      setOverview(body.rows ?? [])
    } catch {
      setOverview([])
    }
  }

  if (loadFailed) {
    return (
      <div className="calendar-connection is-flat" role="status">
        <span>구글 캘린더 연결 상태를 불러오지 못했습니다.</span>
        <Button tone="quiet" size="sm" type="button" onClick={() => { void load() }}>다시 시도</Button>
      </div>
    )
  }
  if (!status) return null

  const connection = status.connection
  // 내가 누른 동기화만이 아니라 스케줄러가 돌리는 통과도 '동기화 중'이다 — 서버가 아는 사실을 그대로 쓴다.
  const syncing = busy === 'sync' || status.syncing
  const selected = selection ?? connection?.calendars.filter((calendar) => calendar.selected).map((calendar) => calendar.id) ?? []
  const chip = !status.configured || !status.secretBoxReady
    ? { tone: 'neutral', label: '사용 불가' }
    : !connection || connection.status === 'revoked'
      ? { tone: 'neutral', label: CALENDAR_STATUS_LABELS.revoked }
      : connection.status === 'needs-reauth'
        ? { tone: 'amber', label: CALENDAR_STATUS_LABELS['needs-reauth'] }
        : { tone: 'green', label: CALENDAR_STATUS_LABELS.connected }

  return (
    <>
      <details className="calendar-connection">
        <summary>
          <CalendarSync size={17} aria-hidden="true" />
          <span>구글 캘린더</span>
          <span className={`calendar-connection-chip ${chip.tone}`}>{chip.label}</span>
        </summary>

        <div className="calendar-connection-body">
          {!status.configured && (
            <p className="calendar-connection-note">연동키 설정 후 사용할 수 있습니다. 운영 담당자가 구글 연동키를 등록하면 여기에서 연결할 수 있습니다.</p>
          )}
          {status.configured && !status.secretBoxReady && (
            <p className="calendar-connection-note">{status.secretBoxMessage}</p>
          )}

          {status.configured && status.secretBoxReady && (!connection || connection.status === 'revoked') && (
            <div className="calendar-connection-row">
              <p>구글 캘린더와 연결하면 {BRAND.name} 일정과 내 업무 마감이 구글에도 보입니다.</p>
              <Button tone="secondary" type="button" onClick={connect} disabled={busy === 'connect'}>
                {busy === 'connect' ? '구글로 이동 중…' : '구글 캘린더 연결'}
              </Button>
            </div>
          )}

          {status.configured && status.secretBoxReady && connection && connection.status !== 'revoked' && (
            <>
              <div className="calendar-connection-row">
                <p>
                  {connection.email || '구글 계정'} ·{' '}
                  {connection.lastSyncAt ? `마지막 동기화 ${formatListDateTime(connection.lastSyncAt)}` : '아직 동기화하지 않았습니다.'}
                </p>
                <div className="calendar-connection-actions">
                  <Button tone="quiet" size="sm" type="button" onClick={() => { void syncNow(false) }} disabled={busy !== ''} aria-busy={syncing}>
                    <RefreshCw size={15} aria-hidden="true" /> {syncing ? '동기화 중…' : '지금 동기화'}
                  </Button>
                  <Button tone="quiet" size="sm" type="button" onClick={disconnect} disabled={busy !== ''}>연결 해제</Button>
                </div>
              </div>
              {connection.lastError && <p className="calendar-connection-error" role="status">{connection.lastError}</p>}
              {/* 0건은 적지 않는다 — '연결된 일정 0건'은 아무것도 알려 주지 않는다.
                  업무 마감 표식은 일정 행이 아니므로 따로 센다. 한 수에 합치면 화면에 한 건뿐인데
                  '연결된 일정 4건'이라고 적히는 일이 생긴다. */}
              {(connection.counts.linked > 0 || connection.counts.workDue > 0) && (
                <p className="calendar-connection-note">
                  {connection.counts.linked > 0 && `연결된 일정 ${connection.counts.linked}건`}
                  {connection.counts.linked > 0 && connection.counts.workDue > 0 && ' · '}
                  {connection.counts.workDue > 0 && `내보낸 업무 마감 ${connection.counts.workDue}건`}
                  {connection.counts.truncated > 0 && ` · 여러 날 일정 ${connection.counts.truncated}건`}
                  {connection.counts.readOnly > 0 && ` · 읽기 전용 ${connection.counts.readOnly}건`}
                </p>
              )}

              <fieldset className="calendar-select">
                <legend>동기화할 캘린더</legend>
                {connection.calendars.map((calendar) => (
                  <label key={calendar.id}>
                    <input
                      type="checkbox"
                      checked={selected.includes(calendar.id)}
                      onChange={(event) => setSelection(event.target.checked
                        ? [...selected, calendar.id]
                        : selected.filter((id) => id !== calendar.id))}
                    />
                    <span>{calendar.summary}</span>
                    {calendar.primary && <em>기본</em>}
                    {!canWrite(calendar) && <em>읽기 전용</em>}
                  </label>
                ))}
                {/* 서버가 실제로 하는 일 그대로 적는다(remoteWriteBlockOf): 안 고른 캘린더는 읽지 않고,
                    그 캘린더의 일정은 여기서 고치거나 지워도 구글로 되돌려 보내지 않는다.
                    예외는 하나, 바로 아래에서 고른 '내보낼 캘린더'다 — 그 한 곳에는 안 골라도 쓴다. */}
                <small>선택하지 않은 캘린더는 읽지 않고, 내보낼 캘린더가 아닌 한 쓰지도 않습니다.</small>
                {/* 미리 알리되 막지는 않는다 — 거절은 서버가 하고, 문장은 서버의 400과 같은 한 벌이다. */}
                {selected.length > MAX_SELECTED_CALENDARS && (
                  <p className="calendar-connection-error" role="status">{CALENDAR_TOO_MANY_MESSAGE}</p>
                )}
                {/* 체크박스 onChange는 즉시 저장하지 않는다 — 키보드로 목록을 지나가는 동안 매번 저장되면 안 된다. */}
                <div className="calendar-connection-actions">
                  <Button tone="quiet" size="sm" type="button" onClick={applySelection} disabled={busy !== ''}>선택 적용</Button>
                  {/* 목록은 연결 시점의 사본이다. 구글에서 방금 만든 캘린더를 여기서 데려온다 —
                      이 버튼이 없으면 되돌리는 길은 '연결 해제 → 다시 연결'뿐이다. */}
                  <Button tone="quiet" size="sm" type="button" onClick={() => { void refreshCalendars() }} disabled={busy !== ''}>
                    {busy === 'refresh' ? '가져오는 중…' : '캘린더 목록 새로 고침'}
                  </Button>
                </div>
              </fieldset>

              <label className="calendar-connection-field">
                <span>내보낼 캘린더</span>
                <select
                  value={connection.writeCalendarId}
                  onChange={(event) => { void patchConnection({ writeCalendarId: event.target.value }, '내보낼 캘린더를 저장하지 못했습니다.') }}
                  disabled={busy !== ''}
                >
                  <option value="">내보내지 않음</option>
                  {connection.calendars.map((calendar) => (
                    <option value={calendar.id} disabled={!canWrite(calendar)} key={calendar.id}>
                      {calendar.summary}{canWrite(calendar) ? '' : ' (내보내기 불가)'}
                    </option>
                  ))}
                </select>
              </label>

              <label className="calendar-connection-check">
                <input
                  type="checkbox"
                  checked={connection.pushWorkDue}
                  onChange={(event) => { void patchConnection({ pushWorkDue: event.target.checked }, '업무 마감 내보내기 설정을 저장하지 못했습니다.') }}
                  disabled={busy !== ''}
                />
                <span>내 업무 마감도 보내기</span>
              </label>

              <p className="calendar-connection-note">
                가져온 구글 일정은 &lsquo;개인&rsquo; 범위로 저장됩니다. 회사 관리자는 일정 관리 화면에서 전 직원 일정을 볼 수 있습니다.
              </p>
              {status.externalEventIdsTruncated && (
                <p className="calendar-connection-note">연결된 일정이 {status.externalEventIds.length}건을 넘어 일부 일정에는 연결 표시가 붙지 않습니다.</p>
              )}
            </>
          )}

          {/* 연동키가 빠졌거나 비밀 보관 키가 사라져도 **끊을 수는 있어야 한다.**
              서버는 이 두 라우트에 그 조건을 걸지 않는다 — 화면만 버튼을 감추면 사용자는
              '사용 불가' 한 줄 앞에서 살아 있는 연결을 끊을 방법이 없다(연결 시작은 그대로 막힌다). */}
          {(!status.configured || !status.secretBoxReady) && connection && connection.status !== 'revoked' && (
            <div className="calendar-connection-row">
              <p>{connection.email || '구글 계정'} · 지금은 동기화할 수 없지만 연결을 해제할 수는 있습니다.</p>
              <Button tone="quiet" size="sm" type="button" onClick={disconnect} disabled={busy !== ''}>연결 해제</Button>
            </div>
          )}

          {connection && connection.status === 'revoked' && (
            <Button tone="quiet" size="sm" type="button" onClick={forget} disabled={busy !== ''}>연결 기록 완전히 지우기</Button>
          )}

          {canManage && (
            <details className="calendar-connection-overview" onToggle={() => { void loadOverview() }}>
              <summary>우리 회사 연결 {overview ? `${overview.length}명` : '보기'}</summary>
              {overview && overview.length === 0 && <p>연결한 사람이 아직 없습니다.</p>}
              {overview && overview.length > 0 && (
                <ul>
                  {overview.map((row) => (
                    <li key={row.accountId}>
                      <strong>{row.name || row.accountId}</strong>
                      {/* 동의를 마치지 않은 행에는 주소가 없다. 빈 값을 가려 놓으면 '숨긴 주소'로 읽힌다. */}
                      <span>{row.email || '계정 없음'}</span>
                      <span>{CALENDAR_STATUS_LABELS[row.status] ?? CALENDAR_STATUS_LABELS.revoked}</span>
                      <span>{row.lastSyncAt ? formatListDateTime(row.lastSyncAt) : '동기화 기록 없음'}</span>
                      <span>캘린더 {row.calendarCount}개</span>
                    </li>
                  ))}
                </ul>
              )}
            </details>
          )}
        </div>
      </details>

      {connection?.status === 'needs-reauth' && (
        <CalendarReauthBanner lastSyncAt={connection.lastSyncAt} onReconnect={connect} busy={busy === 'connect'} />
      )}
    </>
  )
}

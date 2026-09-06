import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Copy, Link2, Plus, RefreshCw, Send, Trash2, Webhook, X } from 'lucide-react'
import { Button, IconButton } from './ui/Button'
import { formatListDateTime } from '../utils/dateTime'
import './WebhookSettings.css'

/**
 * 외부 연동 — 다른 시스템이 보낸 요청을 채널·업무로 받고, 우리 쪽 사건을 지정한 주소로 내보낸다.
 *
 * 이 화면이 절대 보지 않는 것 두 가지: 수신 토큰의 해시와 발신 서명키의 봉투다.
 * 서버는 있다/없다(hasToken·hasSecret)만 내려보내고, 평문은 발급 응답에서 딱 한 번 나타난다.
 * 그래서 '토큰 발급' 대화상자는 닫히는 순간 그 값을 잃는다 — localStorage에도 쓰지 않는다.
 */

type WebhookDirection = 'inbound' | 'outbound'

export type WebhookEndpoint = {
  id: string
  direction: WebhookDirection
  label: string
  conversationId: string | null
  defaultOwnerId: string | null
  url: string | null
  events: string[]
  enabled: boolean
  consecutiveFailures: number
  disabledAt: string | null
  createdAt: string
  updatedAt: string
  lastDeliveredAt: string | null
  lastReceivedAt: string | null
  receivedCount: number
  hasToken: boolean
  tokenIssuedAt: string | null
  hasSecret: boolean
}

export type WebhookDelivery = {
  id: string
  endpointId: string | null
  channel: 'webhook' | 'kakao' | 'email'
  eventType: string
  aggregateId: string
  target: string
  status: 'pending' | 'delivered' | 'failed' | 'gave-up'
  attempts: number
  nextAttemptAt: string | null
  lastStatusCode: number | null
  lastError: string | null
  requestedAt: string
  deliveredAt: string | null
}

type WebhookFeed = {
  endpoints: WebhookEndpoint[]
  deliveries: WebhookDelivery[]
  events: { id: string; label: string }[]
  secretBoxAvailable: boolean
  secretBoxMessage: string
  /** 걸러 낸 행이 있을 때 서버가 실어 보내는 문장. 비어 있으면 아무 일도 없었다는 뜻이다. */
  dataIssueMessage: string
  /** 서버에 어댑터가 있는 알림 채널만. 이름표까지 서버가 정한다. */
  channels: { id: string; label: string }[]
}

type RoomOption = { id: string; name: string }
type MemberOption = { id: string; name: string; team: string }

type FormState = {
  id: string | null
  direction: WebhookDirection
  label: string
  conversationId: string
  defaultOwnerId: string
  url: string
  events: string[]
  enabled: boolean
}

/** 영문 사건 id를 화면에 그대로 쓰지 않는다. 서버가 준 label을 먼저 쓰고, 없을 때만 이 사전을 본다. */
const EVENT_LABELS: Record<string, string> = {
  'work.created': '업무 생성',
  'work.transitioned': '업무 상태 변경',
  'work.approved': '업무 결재 완료',
  'approval.completed': '결재 완료',
  'sentinel.alert': '센티널 경고',
  'notice.posted': '공지 게시',
  'webhook.test': '테스트',
}
const DELIVERY_STATUS_LABELS: Record<string, string> = { pending: '대기', delivered: '전달됨', failed: '실패', 'gave-up': '포기' }
/** 상태로 거를 때 서버에서 읽어 오는 건수. 화면의 '최근 N건' 문장이 이 값을 그대로 말한다. */
const DELIVERY_PAGE = 200
/** 사건 이름과 같은 규칙이다: 서버가 준 label을 먼저 쓰고, 없을 때만 이 사전을 본다.
 *  (꺼진 채널의 옛 기록은 서버 목록에 없으므로 사전이 그 자리를 메운다.) */
const CHANNEL_LABELS: Record<string, string> = { webhook: 'URL', kakao: '알림톡', email: '메일' }

const emptyForm = (direction: WebhookDirection): FormState => ({
  id: null, direction, label: '', conversationId: '', defaultOwnerId: '', url: '', events: [], enabled: true,
})

const hostOf = (url: string | null) => {
  if (!url) return ''
  try { return new URL(url).host } catch { return url }
}

const stateOf = (endpoint: WebhookEndpoint) => (
  endpoint.disabledAt ? 'failing' : endpoint.enabled ? 'on' : 'off'
)
const stateLabel = (endpoint: WebhookEndpoint) => (
  endpoint.disabledAt ? `중지됨 · 연속 실패 ${endpoint.consecutiveFailures}회` : endpoint.enabled ? '사용 중' : '꺼짐'
)

export function WebhookSettings({ workspaceScope, onToast }: {
  workspaceScope?: string
  onToast: (message: string) => void
}) {
  const [feed, setFeed] = useState<WebhookFeed | null>(null)
  const [loadError, setLoadError] = useState('')
  const [filter, setFilter] = useState<'all' | WebhookDirection>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | WebhookDelivery['status']>('all')
  const [form, setForm] = useState<FormState | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [revealed, setRevealed] = useState<{ title: string; value: string; hint: string } | null>(null)
  const [busy, setBusy] = useState('')
  const [rooms, setRooms] = useState<RoomOption[]>([])
  const [members, setMembers] = useState<MemberOption[]>([])
  /** 채널·구성원 목록을 이미 한 번 읽었는가. 목록의 길이로 판정하면 방이 하나도 없는 회사에서
   *  글자를 칠 때마다(=form이 바뀔 때마다) 같은 요청이 다시 나간다. */
  const [optionsLoaded, setOptionsLoaded] = useState(false)
  /** 그 목록이 실제로 도착했는가. 위의 값은 '요청했다'는 뜻이라, 그것만 보고 판정하면
   *  아직 오지 않은 목록을 근거로 '채널이 지워졌다'고 말하게 된다. */
  const [optionsReady, setOptionsReady] = useState(false)
  /** 그 목록을 읽지 못했는가. optionsLoaded를 되돌려 재시도하면 이 효과가 스스로를 다시 부르며
   *  같은 요청을 무한히 반복한다 — 다시 읽는 자리는 대화상자를 여는 순간 하나뿐이다. */
  const [optionsError, setOptionsError] = useState(false)
  /** 상태로 거른 전달 기록. 목록 응답에 실려 오는 최근 100건이 아니라 서버가 그 상태만 200건까지 찾아 준다. */
  const [statusRows, setStatusRows] = useState<WebhookDelivery[] | null>(null)
  const [logNote, setLogNote] = useState('')
  /** 기록을 다시 읽을 때가 되었다는 신호. 다시 보내기가 행의 상태를 바꾸면 거른 목록도 함께 새로 읽어야 한다. */
  const [logTick, setLogTick] = useState(0)
  const [testResult, setTestResult] = useState('')
  const dialogRef = useRef<HTMLElement>(null)
  /** 대화상자를 연 버튼. 닫을 때 초점을 여기로 돌려주지 않으면 키보드 사용자는 문서 맨 위로 떨어진다. */
  const triggerRef = useRef<HTMLElement | null>(null)

  const headers = useMemo(() => ({
    'content-type': 'application/json',
    ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}),
  }), [workspaceScope])

  const reload = useCallback(async () => {
    try {
      const response = await fetch('/api/webhooks', { headers })
      if (!response.ok) throw new Error((await response.json())?.error?.message ?? '외부 연동을 불러오지 못했습니다.')
      setFeed(await response.json())
      setLoadError('')
      setLogTick((tick) => tick + 1)
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : '외부 연동을 불러오지 못했습니다.')
    }
  }, [headers])

  useEffect(() => { void reload() }, [reload])

  /** 지금 채널·구성원 목록이 필요한가. form 객체를 의존성에 두면 글자 하나에 이 효과가 정리되면서
   *  방금 띄운 요청의 결과를 버리고, optionsLoaded는 이미 true라 다시 읽지도 않는다 — 고르개가 빈 채로 남는다. */
  const needsOptions = Boolean(form && form.direction === 'inbound')

  // 대화상자가 열릴 때만 채널·구성원 목록을 읽는다. 목록 화면에는 필요 없는 데이터다.
  useEffect(() => {
    if (!needsOptions || optionsLoaded) return
    let alive = true
    setOptionsLoaded(true)
    void (async () => {
      try {
        const [roomResponse, memberResponse] = await Promise.all([
          fetch('/api/workspace/messenger-conversations', { headers }),
          fetch('/api/directory', { headers }),
        ])
        if (!alive) return
        // 못 읽은 것을 빈 목록으로 바꾸지 않는다. 빈 목록으로 접으면 아래 optionsReady가 서고,
        // 화면은 도착한 적 없는 데이터를 근거로 '이 채널이 지워졌습니다'라고 말한다 —
        // 고르개는 비어 있어 다시 고를 것도 없고, 다시 열어도 재시도하지 않는다.
        if (!roomResponse.ok || !memberResponse.ok) throw new Error('options')
        const roomBody = await roomResponse.json()
        const memberBody = await memberResponse.json()
        // 고르개는 서버가 받아 주는 것과 정확히 같아야 한다. 지워진 방도 type 'team'과 이름을 그대로
        // 갖고 목록에 남으므로(tombstone), lifecycle을 함께 보지 않으면 고를 수는 있는데 저장은 404가 된다.
        setRooms((roomBody.data ?? [])
          .filter((room: { type?: string; systemChannel?: string; lifecycle?: string }) => room?.type === 'team'
            && !room.systemChannel && (room.lifecycle ?? 'active') === 'active')
          .map((room: { id: string; name: string }) => ({ id: room.id, name: room.name })))
        setMembers((memberBody.members ?? [])
          .filter((member: { system?: boolean; active?: boolean; kind?: string }) => !member.system && member.active !== false && member.kind !== 'guest')
          .map((member: { id: string; name: string; team: string }) => ({ id: member.id, name: member.name, team: member.team })))
        setOptionsReady(true)
      } catch {
        if (!alive) return
        // 다시 열면 다시 읽는다(refreshOptions). 여기서 optionsLoaded를 되돌리지 않는 이유는
        // 그것이 이 효과의 의존성이라, 실패할 때마다 곧바로 같은 요청을 다시 띄우기 때문이다.
        setOptionsError(true)
        onToast('채널과 구성원 목록을 불러오지 못했습니다.')
      }
    })()
    return () => { alive = false }
  }, [needsOptions, optionsLoaded, headers, onToast])

  /**
   * 상태를 고르면 그 상태만 서버에서 다시 읽는다.
   *
   * 목록 응답의 deliveries는 최근 100건이다. 그 100건을 화면에서 걸러 '없습니다'라고 말하면,
   * 성공 100건 뒤에 있는 실패는 없는 것이 된다 — 실패를 남기라고 만든 기록이 정반대를 말한다.
   */
  useEffect(() => {
    // 앞 상태의 행을 지우고 시작한다. 남겨 두면 '포기'를 고른 순간 표에는 '실패' 행이 그대로 서 있고
    // 위의 범위 문장은 200건을 말한다 — 새 답이 올 때까지 화면이 자기가 보는 것을 잘못 말한다.
    setStatusRows(null)
    setLogNote('')
    if (statusFilter === 'all') return
    let alive = true
    void (async () => {
      try {
        const response = await fetch(`/api/webhooks/deliveries?status=${encodeURIComponent(statusFilter)}&limit=${DELIVERY_PAGE}`, { headers })
        if (!alive) return
        if (!response.ok) throw new Error('deliveries')
        const body = await response.json()
        if (!alive) return
        setStatusRows(Array.isArray(body?.deliveries) ? body.deliveries : [])
        setLogNote('')
      } catch {
        if (!alive) return
        // 못 읽은 것을 빈 목록으로 바꾸지 않는다. 아래 화면은 최근 100건을 걸러 보여 주고,
        // 그 사실을 이 문장이 말한다 — 무엇을 재고 있는지 화면이 스스로 밝힌다.
        setStatusRows(null)
        setLogNote('전달 기록을 다시 읽지 못해 최근 100건만 보고 있습니다.')
      }
    })()
    return () => { alive = false }
  }, [statusFilter, headers, logTick])

  /** 어떤 대화상자가 열려 있는가. form 객체 자체를 의존성에 두면 글자를 칠 때마다 아래 효과가 다시 돌아
   *  입력칸에서 초점을 빼앗는다 — 한 글자를 치면 그다음 글자가 들어가지 않는다. */
  const dialogKey = revealed ? `reveal:${revealed.title}` : form ? `form:${form.id ?? 'new'}:${form.direction}` : ''

  useEffect(() => {
    if (!dialogKey) return
    const node = dialogRef.current
    node?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      // Tab은 대화상자 안을 돈다. aria-modal이라고 적어 두고 초점이 뒤 화면으로 새면 그 말이 거짓이 된다.
      if (event.key === 'Tab' && node) {
        const focusable = [...node.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')]
          .filter((item) => !item.hasAttribute('disabled') && item.tabIndex !== -1)
        if (!focusable.length) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        const active = document.activeElement
        if (event.shiftKey && (active === first || active === node)) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus() }
        return
      }
      // Escape는 맨 위의 것 하나만 닫는다. 한 번에 둘을 닫으면 방금 발급한 값을 확인하려던 사람이
      // 설정 화면까지 잃는다.
      if (event.key !== 'Escape') return
      if (dialogKey.startsWith('reveal:')) { setRevealed(null); return }
      setForm(null)
      setConfirmDelete(false)
      setTestResult('')
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [dialogKey])

  // 둘 다 닫혔을 때만 초점을 돌려준다 — 발급 값 창이 설정 창 위에 겹쳐 뜨는 동안은 돌려주지 않는다.
  useEffect(() => {
    if (dialogKey) return
    const trigger = triggerRef.current
    triggerRef.current = null
    trigger?.focus()
  }, [dialogKey])

  /**
   * 모든 호출이 이 문을 지난다 — 실패해도 busy가 남지 않고, 사유는 서버 문장 그대로 전한다.
   *
   * busy 표식은 경로가 아니라 'create'로 시작한다. 만들기의 경로는 빈 문자열이고 그것이 곧
   * 놀고 있음의 값이라, 그대로 쓰면 만드는 동안에만 잠금이 풀린다 — [저장]의 aria-disabled가
   * false로 남고 save()의 `busy !== ''` 거절도 통과해, Enter 두 번이 연동 둘을 만든다.
   * 보내는 연동에서는 두 번째의 서명 비밀키를 아무도 본 적이 없으므로 검증할 수 없는 유령이 남는다.
   */
  const call = async (path: string, init: RequestInit, fallback: string) => {
    setBusy(path || 'create')
    try {
      const response = await fetch(`/api/webhooks${path}`, { headers, ...init })
      if (response.status === 204) { await reload(); return {} }
      const body = await response.json().catch(() => null)
      if (!response.ok) { onToast(body?.error?.message ?? fallback); return null }
      await reload()
      return body ?? {}
    } catch {
      onToast(fallback)
      return null
    } finally { setBusy('') }
  }

  /**
   * 대화상자를 열 때마다 채널·구성원 목록을 다시 읽는다.
   *
   * 외부 연동 패널은 메신저 서랍 아래에 계속 떠 있다. 그동안 채널이 지워져도 한 번 읽어 둔 목록은
   * 그대로라, 고르개는 없는 채널을 계속 권하고 '지워진 채널' 안내는 뜨지 않는다. 그러면 [저장]이
   * 서버의 고정된 404('대화를 찾을 수 없습니다.')로 끝나고 — 그 문장은 일부러 어느 채널인지 말하지
   * 않으므로 — 관리자는 무엇이 없어졌는지 알 길이 없다. reload()에 두지 않는 이유는 저장할 때마다
   * 목록이 다시 오면서 그 안내가 읽는 중에 사라지기 때문이다.
   */
  const refreshOptions = () => { setOptionsLoaded(false); setOptionsReady(false); setOptionsError(false) }
  const openCreate = (direction: WebhookDirection, trigger: HTMLElement | null) => {
    triggerRef.current = trigger
    refreshOptions()
    setForm(emptyForm(direction))
    setConfirmDelete(false)
    setTestResult('')
  }
  const openEdit = (endpoint: WebhookEndpoint, trigger: HTMLElement | null) => {
    triggerRef.current = trigger
    refreshOptions()
    setConfirmDelete(false)
    setTestResult('')
    setForm({
      id: endpoint.id,
      direction: endpoint.direction,
      label: endpoint.label,
      conversationId: endpoint.conversationId ?? '',
      defaultOwnerId: endpoint.defaultOwnerId ?? '',
      url: endpoint.url ?? '',
      events: [...endpoint.events],
      enabled: endpoint.enabled,
    })
  }

  const current = form?.id ? feed?.endpoints.find((item) => item.id === form.id) ?? null : null
  const blockedByKey = Boolean(form && form.direction === 'outbound' && !form.id && feed && !feed.secretBoxAvailable)

  const save = async () => {
    if (!form) return
    // aria-disabled로 막아 둔 두 조건이다. 실제로 거절하는 곳도 여기여야 초점과 사유가 함께 남는다.
    if (busy !== '') return
    if (blockedByKey) { onToast(feed?.secretBoxMessage || '보내는 연동을 만들 수 없습니다.'); return }
    // 이름이 비었다는 사실의 문장은 서버 한 벌이다(readLabel의 '이름은 1~60자로 적어 주세요.').
    // 여기서 먼저 거절하면 그 서버 문장이 이 화면에서 영영 닿지 않는 자리가 되고, 두 문장이
    // 조용히 갈라진다. 왕복 한 번을 더 하는 대신 한 사실을 한 문장으로 지킨다.
    const label = form.label.trim()
    const payload = form.direction === 'inbound'
      ? { label, conversationId: form.conversationId, defaultOwnerId: form.defaultOwnerId, enabled: form.enabled }
      : { label, url: form.url.trim(), events: form.events, enabled: form.enabled }
    const result = form.id
      ? await call(`/${form.id}`, { method: 'PATCH', body: JSON.stringify(payload) }, '외부 연동을 저장하지 못했습니다.')
      : await call('', { method: 'POST', body: JSON.stringify({ direction: form.direction, ...payload }) }, '외부 연동을 만들지 못했습니다.')
    if (!result) return
    if (result.endpoint && !form.id) setForm({ ...form, id: result.endpoint.id })
    else setForm(null)
    // 만들 때 함께 생긴 서명 비밀키의 평문은 이 응답에서 딱 한 번 나온다. 여기서 보여 주지 않으면
    // 받는 쪽은 열쇠를 가진 적이 없고, 첫 배달부터 검증할 수 없는 서명이 붙는다.
    if (!form.id && typeof result.secret === 'string' && result.secret) {
      setRevealed({ title: '서명 비밀키', value: result.secret, hint: '받는 쪽에서 X-Inthefield-Signature를 검증할 때 씁니다.' })
      return
    }
    onToast('외부 연동을 저장했습니다.')
  }

  const issueToken = async () => {
    if (!form?.id) return
    const result = await call(`/${form.id}/token`, { method: 'POST' }, '토큰을 발급하지 못했습니다.')
    if (!result?.token) return
    // 발급은 사용 스위치를 건드리지 않는다. 꺼진 연동에 '도착합니다'라고 적으면 그 문장이 거짓이 된다.
    setRevealed({
      title: '수신 주소',
      value: result.hookUrl ?? result.token,
      hint: result.endpoint?.enabled
        ? '이 주소로 POST하면 지정한 곳에 도착합니다.'
        : '이 연동은 지금 꺼져 있어 받지 않습니다. [사용]을 켜고 저장하면 이 주소로 받습니다.',
    })
  }

  const revokeToken = async () => {
    if (!form?.id) return
    const result = await call(`/${form.id}/token`, { method: 'DELETE' }, '토큰을 회수하지 못했습니다.')
    if (!result) return
    // 서버가 이 연동을 껐다. 대화상자의 '사용'은 열 때 담아 둔 값 그대로라, 접어 넣지 않으면
    // 화면은 켜졌다고 보여 주고 그다음 [저장]이 아무도 부탁하지 않은 재가동을 보낸다.
    setForm((current) => (current ? { ...current, enabled: result.endpoint?.enabled === true } : current))
    onToast('토큰을 회수했습니다. 이 연동은 꺼졌습니다.')
  }

  const rotateSecret = async () => {
    if (!form?.id) return
    const result = await call(`/${form.id}/secret`, { method: 'POST' }, '서명 비밀키를 발급하지 못했습니다.')
    if (result?.secret) setRevealed({ title: '서명 비밀키', value: result.secret, hint: '받는 쪽에서 X-Inthefield-Signature를 검증할 때 씁니다.' })
  }

  const sendTest = async () => {
    if (!form?.id) return
    const result = await call(`/${form.id}/test`, { method: 'POST' }, '테스트를 보내지 못했습니다.')
    if (!result?.delivery) return
    const delivery = result.delivery as WebhookDelivery
    // 서버가 queued를 실어 보내면 이 요청이 아직 보내지 않았다는 뜻이다. 그 행의 상태를 그대로 옮기면
    // '대기 · 사유 없음'이 되는데, 사유가 없는 것이 아니라 아직 결과가 없는 것이다.
    if (result.queued) { setTestResult('보내는 중입니다. 잠시 뒤 전달 기록에서 결과를 확인해 주세요.'); return }
    setTestResult(delivery.status === 'delivered'
      ? `전달됨 · HTTP ${delivery.lastStatusCode ?? 200}`
      : `${DELIVERY_STATUS_LABELS[delivery.status] ?? delivery.status} · ${delivery.lastError ?? '사유 없음'}`)
  }

  const removeEndpoint = async () => {
    if (!form?.id) return
    const result = await call(`/${form.id}`, { method: 'DELETE' }, '외부 연동을 지우지 못했습니다.')
    if (result) { setForm(null); setConfirmDelete(false); onToast('외부 연동을 지웠습니다.') }
  }

  const retryDelivery = async (id: string) => {
    const result = await call(`/deliveries/${id}/retry`, { method: 'POST' }, '다시 보내지 못했습니다.')
    if (result?.delivery) onToast(result.delivery.status === 'delivered' ? '다시 보냈습니다.' : '다시 시도했지만 아직 도착하지 않았습니다.')
  }

  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); onToast('복사했습니다.') }
    catch { onToast('복사하지 못했습니다. 값을 직접 선택해 주세요.') }
  }

  const eventLabel = (id: string) => feed?.events.find((item) => item.id === id)?.label ?? EVENT_LABELS[id] ?? id
  const channelLabel = (id: string) => feed?.channels?.find((item) => item.id === id)?.label ?? CHANNEL_LABELS[id] ?? id
  const endpointName = (id: string | null) => feed?.endpoints.find((item) => item.id === id)?.label ?? '—'

  const endpoints = (feed?.endpoints ?? []).filter((item) => filter === 'all' || item.direction === filter)
  /** 지금 화면이 실제로 재고 있는 범위. 문장이 이 값을 그대로 말한다 — 재지 않은 범위를 두고 '없다'고 하지 않는다. */
  const serverFiltered = statusFilter !== 'all' && statusRows !== null
  const deliveries = serverFiltered
    ? statusRows
    : (feed?.deliveries ?? []).filter((item) => statusFilter === 'all' || item.status === statusFilter)
  const logScope = serverFiltered ? DELIVERY_PAGE : 100

  /** 저장된 '받을 곳'이 고르개에 없다 = 그 채널이 지워졌다. 목록이 아직 오지 않았을 때는 아무 말도 하지 않는다. */
  const missingRoom = Boolean(form && form.direction === 'inbound' && form.conversationId
    && optionsReady && !rooms.some((room) => room.id === form.conversationId))
  /** 기본 담당자도 같은 판정이다. 명단은 비활성 계정을 걸러 오므로, 담당자가 퇴사·비활성이 되면
   *  고르개에서 사라진다 — 감추면 화면은 '지정 안 함'을 보여 주는데 저장된 값은 그대로다. */
  const missingOwner = Boolean(form && form.direction === 'inbound' && form.defaultOwnerId
    && optionsReady && !members.some((member) => member.id === form.defaultOwnerId))

  return <section className="webhook-settings" aria-labelledby="webhook-title">
    <div className="people-subsection-head">
      <div>
        <h3 id="webhook-title">외부 연동</h3>
        <p>다른 시스템이 보낸 요청을 채널·업무로 받고, 우리 쪽 사건을 지정한 주소로 내보냅니다.</p>
      </div>
      <div className="webhook-head-actions">
        <Button tone="quiet" size="sm" type="button" onClick={() => void reload()}><RefreshCw size={15} /> 새로 읽기</Button>
        <Button tone="secondary" type="button" onClick={(event) => openCreate('inbound', event.currentTarget)}><Plus size={17} /> 엔드포인트 추가</Button>
      </div>
    </div>

    {loadError && <p className="webhook-note" role="status">{loadError}</p>}
    {feed && !feed.secretBoxAvailable && <p className="webhook-note" role="status">{feed.secretBoxMessage}</p>}
    {/* 목록은 성한 행만 보여 준다. 그 사실을 여기서 말하지 않으면, 멀쩡해 보이는 화면에서 누른
        저장·삭제·토큰이 전부 같은 문장으로 막히는데 그 둘을 이어 줄 것이 화면에 없다. */}
    {feed?.dataIssueMessage && <p className="webhook-note" role="status">{feed.dataIssueMessage}</p>}

    <div className="webhook-filter" role="group" aria-label="연동 방향">
      {([['all', '전체'], ['inbound', '받기'], ['outbound', '보내기']] as const).map(([value, label]) => (
        <Button key={value} tone={filter === value ? 'secondary' : 'quiet'} size="sm" type="button"
          aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</Button>
      ))}
    </div>

    {/* 못 찾은 것과 못 보는 것을 구분한다 — 아직 못 읽었을 때도, 거른 결과가 빌 때도 '없다'고 말하지 않는다. */}
    {feed && feed.endpoints.length === 0 && <div className="people-empty-state"><Webhook size={22} /><strong>아직 연결된 외부 시스템이 없습니다</strong><span>엔드포인트 추가에서 받을 주소를 만들거나 보낼 주소를 등록하세요.</span></div>}
    {feed && feed.endpoints.length > 0 && endpoints.length === 0 && <p className="webhook-note" role="status">이 조건에 맞는 연동이 없습니다.</p>}
    {endpoints.length > 0 && <ul className="webhook-list">{endpoints.map((endpoint) => (
      <li key={endpoint.id}>
        <span className="webhook-dot" data-state={stateOf(endpoint)} aria-hidden="true" />
        <span className="webhook-list-copy">
          <strong>{endpoint.label}</strong>
          <small>{endpoint.direction === 'inbound'
            ? `받기 · ${endpoint.conversationId ? '채널에 게시' : '업무로 만들기'}${endpoint.hasToken ? '' : ' · 토큰 없음'}`
            : `보내기 · ${hostOf(endpoint.url)} · 사건 ${endpoint.events.length}개`}</small>
        </span>
        <span className="webhook-state">{stateLabel(endpoint)}</span>
        <Button tone="quiet" size="sm" type="button" onClick={(event) => openEdit(endpoint, event.currentTarget)}>설정</Button>
      </li>
    ))}</ul>}

    <section className="webhook-delivery-log" aria-labelledby="webhook-log-title">
      <div className="people-subsection-head">
        <div>
          <h4 id="webhook-log-title">전달 기록</h4>
          <p>보낸 시각·응답 코드·실패 사유가 남습니다.</p>
        </div>
        <label className="webhook-log-filter">
          <span className="sr-only">전달 상태로 거르기</span>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
            <option value="all">전체 상태</option>
            <option value="pending">대기</option>
            <option value="delivered">전달됨</option>
            <option value="failed">실패</option>
            <option value="gave-up">포기</option>
          </select>
        </label>
      </div>
      {logNote && <p className="webhook-note" role="status">{logNote}</p>}
      {/* 두 번째 조건은 죽은 줄이 아니다 — 목록 응답과 상태별 조회는 다른 시각에 도착하므로,
          그 사이에 생긴 행이 표에는 있는데 위에서는 '아직 없습니다'라고 말하는 순간이 생긴다. */}
      {feed && feed.deliveries.length === 0 && deliveries.length === 0 && <div className="people-empty-state"><Send size={22} /><strong>아직 보낸 기록이 없습니다</strong><span>사건이 일어나면 이곳에 시각과 응답이 남습니다.</span></div>}
      {/* 재지 않은 범위를 두고 '없다'고 말하지 않는다 — 그리고 잰 범위를 재지 않은 척하지도 않는다.
          서버가 답했으면 그 상태의 저장된 행 전부를 걸러 본 것이므로 '없습니다'가 맞는 문장이고,
          '최근 200건 안에는'이라고 물러서면 관리자가 있지도 않은 실패를 찾아 나선다.
          범위를 밝혀야 하는 것은 목록 응답 100건만 손에 쥔 화면 필터 쪽이다. */}
      {feed && feed.deliveries.length > 0 && deliveries.length === 0 && <p className="webhook-note" role="status">
        {serverFiltered ? '이 상태의 기록이 없습니다.' : `최근 ${logScope}건 안에는 이 상태의 기록이 없습니다.`}
      </p>}
      {deliveries.length > 0 && <div className="webhook-log-scroll">
          <table>
            <thead><tr>
              <th scope="col">시각</th><th scope="col">사건</th><th scope="col">받는 곳</th>
              <th scope="col">채널</th><th scope="col">상태</th><th scope="col">응답</th><th scope="col"><span className="sr-only">다시 보내기</span></th>
            </tr></thead>
            <tbody>{deliveries.map((delivery) => (
              <tr key={delivery.id}>
                <td>{formatListDateTime(delivery.requestedAt)}</td>
                <td>{eventLabel(delivery.eventType)}</td>
                <td>{delivery.channel === 'webhook' ? `${endpointName(delivery.endpointId)} · ${delivery.target}` : delivery.target}</td>
                <td>{channelLabel(delivery.channel)}</td>
                <td>{DELIVERY_STATUS_LABELS[delivery.status] ?? delivery.status}</td>
                {/* 코드가 있으면 사유를 감추던 자리다. 302는 코드와 사유가 둘 다 있어야 뜻이 되고
                    ('리다이렉트는 따라가지 않습니다'), 사유만 있는 실패도 그대로 남아야 한다. */}
                <td className="webhook-log-reason">{[delivery.lastStatusCode ? `HTTP ${delivery.lastStatusCode}` : '', delivery.lastError ?? ''].filter(Boolean).join(' · ') || '—'}</td>
                <td>{delivery.status !== 'delivered' && <Button tone="quiet" size="sm" type="button" disabled={busy === `/deliveries/${delivery.id}/retry`} onClick={() => void retryDelivery(delivery.id)}>다시 보내기</Button>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>}
    </section>

    {/* 한 번에 하나만 뜬다. 설정 대화상자는 발급 값을 보여 주는 동안 잠시 물러났다가 그대로 돌아온다. */}
    {form && !revealed && <div className="webhook-dialog-backdrop" role="presentation">
      <section ref={dialogRef} className="modal-card people-modal" role="dialog" aria-modal="true" aria-labelledby="webhook-modal-title" tabIndex={-1}>
        <header>
          <div>
            <span className="eyebrow">{form.direction === 'inbound' ? 'INBOUND WEBHOOK' : 'OUTBOUND WEBHOOK'}</span>
            <h2 id="webhook-modal-title">{form.id ? '외부 연동 설정' : '외부 연동 추가'}</h2>
            <p>{form.direction === 'inbound'
              ? '외부 시스템이 이 주소로 POST하면 고른 채널에 게시하거나 업무로 만듭니다.'
              : '고른 사건이 일어나면 이 주소로 서명된 요청을 보냅니다.'}</p>
          </div>
          <IconButton tone="ghost" type="button" aria-label="닫기" onClick={() => { setForm(null); setConfirmDelete(false); setTestResult('') }}><X size={21} /></IconButton>
        </header>

        {/* 대화상자 본문은 form이다 — Enter가 저장으로 이어지고, .modal-card form의 안쪽 여백이 붙어
            footer의 음수 마진이 카드 테두리에 정확히 얹힌다(div였을 때는 16px 밖으로 삐져나갔다). */}
        <form className="webhook-form" onSubmit={(event) => { event.preventDefault(); void save() }}>
          {!form.id && <div className="webhook-direction" role="radiogroup" aria-label="연동 방향 고르기">
            {([['inbound', '받기'], ['outbound', '보내기']] as const).map(([value, label]) => (
              <label key={value}>
                <input type="radio" name="webhook-direction" value={value} checked={form.direction === value}
                  onChange={() => setForm({ ...emptyForm(value), label: form.label })} />
                <span>{label}</span>
              </label>
            ))}
          </div>}

          <label className="webhook-field">
            <span>이름</span>
            <input type="text" value={form.label} maxLength={60} placeholder="설비 모니터링"
              onKeyDown={(event) => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault() }}
              onChange={(event) => setForm({ ...form, label: event.target.value })} />
          </label>

          {form.direction === 'inbound' ? <>
            <label className="webhook-field">
              <span>받을 곳</span>
              <select value={form.conversationId} onChange={(event) => setForm({ ...form, conversationId: event.target.value })}>
                <option value="">업무로 만들기</option>
                {/* 저장된 채널이 그사이 지워졌으면 값을 감추지 않고 고를 수 없는 칸으로 보여 준다.
                    감추면 고르개가 빈 채로 보이고, 무엇이 지정돼 있었는지도 알 수 없다. */}
                {missingRoom && <option value={form.conversationId} disabled>지워진 채널</option>}
                {/* 목록을 못 읽었을 때도 마찬가지다. 이 칸이 없으면 브라우저가 첫 항목('업무로 만들기')을
                    보여 주는데, 저장되는 값은 여전히 지금의 채널이라 화면이 거짓을 말하게 된다. */}
                {optionsError && form.conversationId && <option value={form.conversationId} disabled>지금 지정된 채널</option>}
                {rooms.map((room) => <option key={room.id} value={room.id}>{room.name} 채널에 게시</option>)}
              </select>
            </label>
            {missingRoom && <p className="webhook-note" role="status">이 연동이 쓰던 채널이 지워졌습니다. 받을 곳을 다시 골라야 저장할 수 있습니다.</p>}
            {optionsError && <p className="webhook-note" role="status">채널과 구성원 목록을 불러오지 못했습니다. 이 창을 닫았다 다시 열면 다시 읽습니다.</p>}
            <label className="webhook-field">
              <span>기본 담당자</span>
              <select value={form.defaultOwnerId} onChange={(event) => setForm({ ...form, defaultOwnerId: event.target.value })}>
                <option value="">지정 안 함 (본문에서 정함)</option>
                {/* 채널 쪽과 같은 규칙이다 — 저장된 값은 언제나 칸에 보인다. */}
                {missingOwner && <option value={form.defaultOwnerId} disabled>지금은 배정할 수 없는 담당자</option>}
                {optionsError && form.defaultOwnerId && <option value={form.defaultOwnerId} disabled>지금 지정된 담당자</option>}
                {members.map((member) => <option key={member.id} value={member.id}>{member.name} · {member.team}</option>)}
              </select>
            </label>
            {missingOwner && <p className="webhook-note" role="status">이 연동의 기본 담당자가 지금은 배정할 수 없는 계정입니다. 본문에 담당자가 없는 요청은 업무가 되지 않으니 다른 담당자를 골라 주세요.</p>}
            <div className="webhook-token">
              {!form.id && <p>먼저 저장하면 수신 주소를 발급할 수 있습니다.</p>}
              {form.id && !current?.hasToken && <>
                <p>아직 수신 주소가 없습니다. 발급하면 그 자리에서 한 번만 보여 줍니다.</p>
                <Button tone="secondary" size="sm" type="button" disabled={busy !== ''} onClick={() => void issueToken()}><Link2 size={15} /> 토큰 발급</Button>
              </>}
              {form.id && current?.hasToken && <>
                <p>발급된 주소가 있습니다. 값은 서버에도 남지 않으므로 다시 볼 수 없습니다 — 잃어버렸다면 재발급하세요.</p>
                <div className="webhook-token-actions">
                  <Button tone="secondary" size="sm" type="button" disabled={busy !== ''} onClick={() => void issueToken()}><RefreshCw size={15} /> 토큰 재발급</Button>
                  <Button tone="quiet" size="sm" type="button" disabled={busy !== ''} onClick={() => void revokeToken()}>토큰 회수</Button>
                </div>
              </>}
              <p className="webhook-sample">보낼 수 있는 본문 두 가지</p>
              <pre>{'{"text": "3호기 온도 이상"}'}</pre>
              <pre>{'{"task": {"title": "3호기 점검", "ownerId": "USR-..."}}'}</pre>
            </div>
          </> : <>
            <label className="webhook-field">
              <span>보낼 주소</span>
              <input type="url" value={form.url} placeholder="https://" maxLength={500}
                onKeyDown={(event) => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault() }}
                onChange={(event) => setForm({ ...form, url: event.target.value })} />
            </label>
            <fieldset className="webhook-events">
              <legend>보낼 사건</legend>
              {(feed?.events ?? []).map((item) => (
                <label key={item.id}>
                  <input type="checkbox" checked={form.events.includes(item.id)}
                    onChange={() => setForm({
                      ...form,
                      events: form.events.includes(item.id) ? form.events.filter((id) => id !== item.id) : [...form.events, item.id],
                    })} />
                  <span>{item.label}</span>
                </label>
              ))}
            </fieldset>
            {form.id && <div className="webhook-token">
              {/* 보내는 연동은 만들어질 때 서명키를 함께 갖고, 그것을 지우는 길은 없다 —
                  '없습니다' 갈래는 저장된 연동에서 절대 그려지지 않는 문장이라 두지 않는다. */}
              <p>서명 비밀키가 있습니다. 받는 쪽이 값을 잃었다면 재발급하세요 — 재발급하면 이전 키로는 검증되지 않습니다.</p>
              <div className="webhook-token-actions">
                <Button tone="secondary" size="sm" type="button" disabled={busy !== ''} onClick={() => void rotateSecret()}><RefreshCw size={15} /> 서명 비밀키 재발급</Button>
                <Button tone="quiet" size="sm" type="button" disabled={busy !== ''} onClick={() => void sendTest()}><Send size={15} /> 테스트 보내기</Button>
              </div>
              {testResult && <p className="webhook-test-result" role="status">{testResult}</p>}
            </div>}
          </>}

          <label className="webhook-toggle">
            <input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />
            <span>사용</span>
          </label>

          {form.id && <div className="webhook-danger">
            {confirmDelete
              ? <>
                <p>이 연동을 지우면 발급된 주소는 즉시 무효가 되고, 아직 보내지 못한 전달은 모두 포기 처리됩니다.</p>
                <div className="webhook-token-actions">
                  <Button tone="danger" size="sm" type="button" disabled={busy !== ''} onClick={() => void removeEndpoint()}><Trash2 size={15} /> 지웁니다</Button>
                  <Button tone="quiet" size="sm" type="button" onClick={() => setConfirmDelete(false)}>그만두기</Button>
                </div>
              </>
              : <Button tone="quiet" size="sm" type="button" onClick={() => setConfirmDelete(true)}>이 연동 지우기</Button>}
          </div>}

          <footer>
            <Button tone="ghost" type="button" onClick={() => { setForm(null); setConfirmDelete(false); setTestResult('') }}>닫기</Button>
            <Button
              tone="primary"
              type="submit"
              aria-disabled={blockedByKey || busy !== ''}
              title={blockedByKey ? feed?.secretBoxMessage : undefined}
            >저장</Button>
          </footer>
        </form>
      </section>
    </div>}

    {revealed && <div className="webhook-dialog-backdrop" role="presentation">
      <section ref={dialogRef} className="modal-card people-modal" role="dialog" aria-modal="true" aria-labelledby="webhook-reveal-title" tabIndex={-1}>
        <header>
          <div>
            <span className="eyebrow">ONE-TIME VALUE</span>
            <h2 id="webhook-reveal-title">{revealed.title}</h2>
            <p>{revealed.hint}</p>
          </div>
          <IconButton tone="ghost" type="button" aria-label="닫기" onClick={() => setRevealed(null)}><X size={21} /></IconButton>
        </header>
        {/* 본문에 안쪽 여백이 있어야 footer의 음수 마진이 카드 테두리에 얹힌다. */}
        <div className="webhook-reveal">
          <div className="credential-reveal">
            <code>{revealed.value}</code>
            <Button tone="secondary" size="sm" type="button" onClick={() => void copy(revealed.value)}><Copy size={15} /> 복사</Button>
          </div>
          <p className="webhook-note">이 창을 닫으면 다시 볼 수 없습니다. 지금 외부 시스템에 붙여 넣으세요.</p>
          <footer>
            <Button tone="ghost" type="button" onClick={() => setRevealed(null)}>닫기</Button>
          </footer>
        </div>
      </section>
    </div>}
  </section>
}

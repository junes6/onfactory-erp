import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, BellOff, BellRing, CalendarClock, CheckCircle2, ClipboardCheck, ListChecks, Megaphone, MessageCircle, MessagesSquare, Moon, Radar, Settings2, ShieldAlert, Smartphone, Sparkles, Webhook } from 'lucide-react'
import { formatDateTime, formatListDateTime } from '../utils/dateTime'
import { Button, IconButton } from './ui/Button'
import './NotificationCenter.css'

export type NotificationType =
  | 'task-assigned' | 'approval-requested' | 'changes-requested'
  | 'mention' | 'proposal-pending' | 'sentinel-warning' | 'opportunity-new' | 'quiet-digest'
  // R16-D: 공지 게시·필독 확인 요청·미확인 명단.
  | 'notice-posted' | 'notice-reminder' | 'notice-unconfirmed-summary'
  // R16-J: 스레드 답글. 그 스레드에 있던 사람에게만 간다.
  | 'thread-reply'
  // R16-L: 외부 연동이 연속 실패로 자동 중지됐다. 관리자가 주소를 고쳐야 다시 흐른다.
  | 'webhook-disabled'
  // R16-E: 구글 캘린더 연결이 끊겼다. 다시 잇는 것은 사람만 할 수 있어 기본으로 울린다.
  | 'calendar-reauth'

export type AppNotification = {
  id: string
  type: NotificationType
  title: string
  body: string
  page: string
  focusId: string
  source: { kind: string; id: string; label: string } | null
  readAt: string | null
  createdAt: string
}

type QuietHours = { enabled: boolean; start: string; end: string }
type NotificationSettings = {
  muted: NotificationType[]
  push: NotificationType[]
  /** R15-I: 이 시간에는 울리지 않고 아침에 한 건으로 묶어 보낸다. */
  quietHours: QuietHours
  /** 방해 금지 시간에도 지나가는 유형. */
  urgentTypes: NotificationType[]
  rooms: Record<string, 'all' | 'mention' | 'off'>
  /** R16-L: 외부 채널(알림톡·메일…)은 채널 id를 그대로 키로 갖는다. 기본은 꺼짐이다 —
   *  건당 요금이 나가는 통로를 동의 없이 켜지 않는다. 채널 이름을 여기 박아 두지 않는 이유는,
   *  서버가 채널을 하나 늘렸을 때 이 파일이 함께 바뀌어야 한다면 그 목록이 한 벌이 아니기 때문이다. */
  [channel: string]: unknown
}
/** 서버가 실어 보낸 채널 한 칸. id는 설정 키이고 label은 표의 열 제목이다. */
type ChannelMeta = { id: string; label: string }
/** 이 채널로 받기로 한 유형들. 설정은 서버가 정한 키를 그대로 쓰므로 여기서만 좁혀 읽는다. */
const channelTypes = (settings: NotificationSettings, channel: string): NotificationType[] => {
  const value = settings[channel]
  return Array.isArray(value) ? value as NotificationType[] : []
}
type TypeMeta = { id: NotificationType; label: string; pushByDefault: boolean }
type PushDevice = { id: string; endpoint: string; userAgent: string; createdAt: string }

export type NotificationFeed = {
  items: AppNotification[]
  unread: number
  settings: NotificationSettings
  types: TypeMeta[]
  push: { configured: boolean; publicKey: string; devices: PushDevice[] }
  /** 서버에 어댑터가 있는 채널만 실려 온다. 켤 수도 끌 수도 없는 빈 체크박스를 그리지 않는다. */
  channels?: ChannelMeta[]
}

const typeIcon: Record<NotificationType, typeof ListChecks> = {
  'task-assigned': ListChecks,
  'approval-requested': ClipboardCheck,
  'changes-requested': AlertTriangle,
  mention: MessageCircle,
  'proposal-pending': ClipboardCheck,
  'sentinel-warning': ShieldAlert,
  'opportunity-new': Radar,
  'quiet-digest': Moon,
  'notice-posted': Megaphone,
  'notice-reminder': BellRing,
  'notice-unconfirmed-summary': ListChecks,
  'thread-reply': MessagesSquare,
  'webhook-disabled': Webhook,
  'calendar-reauth': CalendarClock,
}

const typeTone: Record<NotificationType, string> = {
  'task-assigned': 'blue',
  'approval-requested': 'amber',
  'changes-requested': 'red',
  mention: 'violet',
  'proposal-pending': 'blue',
  'sentinel-warning': 'amber',
  'opportunity-new': 'green',
  'quiet-digest': 'violet',
  'notice-posted': 'amber',
  'notice-reminder': 'amber',
  'notice-unconfirmed-summary': 'blue',
  'thread-reply': 'violet',
  'webhook-disabled': 'red',
  'calendar-reauth': 'amber',
}

/** base64url 공개키 → Uint8Array. 브라우저 구독 API가 요구하는 형식이다. */
function decodeVapidKey(base64: string) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(padded)
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)))
}

export function NotificationCenter({ workspaceScope, feed, onReload, onNavigate, onToast, onClose }: {
  workspaceScope?: string
  feed: NotificationFeed
  onReload: () => Promise<void> | void
  onNavigate: (page: string, focusId: string) => void
  onToast: (message: string) => void
  onClose: () => void
}) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const headers = useMemo(() => ({
    'content-type': 'application/json',
    ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}),
  }), [workspaceScope])

  const markRead = async (ids: string[]) => {
    try {
      await fetch('/api/notifications/read', { method: 'POST', headers, body: JSON.stringify({ ids }) })
      await onReload()
    } catch { onToast('알림을 읽음으로 표시하지 못했습니다.') }
  }

  const open = (item: AppNotification) => {
    void markRead([item.id])
    onClose()
    onNavigate(item.page, item.focusId)
  }

  const saveSettings = async (next: NotificationSettings) => {
    setBusy(true)
    try {
      await fetch('/api/notifications/settings', { method: 'PUT', headers, body: JSON.stringify({ settings: next }) })
      await onReload()
    } catch { onToast('알림 설정을 저장하지 못했습니다.') } finally { setBusy(false) }
  }

  const toggle = (list: NotificationType[], type: NotificationType) =>
    (list.includes(type) ? list.filter((item) => item !== type) : [...list, type])

  /** 서버에 어댑터가 있는 채널만. 목록이 비면 표에 그 열이 아예 서지 않는다(가짜 체크박스를 만들지 않는다). */
  const channels: ChannelMeta[] = Array.isArray(feed.channels) ? feed.channels : []

  /** 브라우저 권한 → 구독 생성 → 서버 저장. 권한을 거부하면 그 사실을 그대로 알린다. */
  const enablePush = async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      onToast('이 브라우저는 웹푸시를 지원하지 않습니다.')
      return
    }
    setBusy(true)
    try {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        onToast('브라우저에서 알림을 허용해야 푸시를 받을 수 있습니다.')
        return
      }
      const registration = await navigator.serviceWorker.ready
      const existing = await registration.pushManager.getSubscription()
      const subscription = existing ?? await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeVapidKey(feed.push.publicKey),
      })
      const response = await fetch('/api/notifications/subscribe', {
        method: 'POST', headers,
        body: JSON.stringify({ subscription: { ...subscription.toJSON(), userAgent: navigator.userAgent } }),
      })
      if (!response.ok) throw new Error((await response.json())?.error?.message ?? '기기를 등록하지 못했습니다.')
      await onReload()
      onToast('이 기기로 푸시 알림을 받습니다.')
    } catch (reason) {
      onToast(reason instanceof Error ? reason.message : '푸시 알림을 켜지 못했습니다.')
    } finally { setBusy(false) }
  }

  const disablePush = async (endpoint: string) => {
    setBusy(true)
    try {
      await fetch('/api/notifications/unsubscribe', { method: 'POST', headers, body: JSON.stringify({ endpoint }) })
      const registration = await navigator.serviceWorker?.ready
      const subscription = await registration?.pushManager.getSubscription()
      if (subscription) await subscription.unsubscribe()
      await onReload()
      onToast('이 기기의 푸시를 껐습니다.')
    } catch { onToast('푸시를 끄지 못했습니다.') } finally { setBusy(false) }
  }

  return <section className="notification-panel" id="notification-panel" aria-label="알림">
    <header>
      <div>
        <h2>알림</h2>
        <p>{feed.unread > 0 ? `읽지 않은 알림 ${feed.unread}개` : '모두 읽었습니다.'}</p>
      </div>
      <div className="notification-head-actions">
        <IconButton tone="ghost" size="sm" type="button" aria-label="알림 설정" aria-pressed={settingsOpen} onClick={() => setSettingsOpen((value) => !value)}><Settings2 size={17} /></IconButton>
        <Button tone="quiet" size="sm" type="button" disabled={feed.unread === 0} onClick={() => void markRead([])}>모두 읽음</Button>
      </div>
    </header>

    {settingsOpen && <div className="notification-settings">
      {/* 채널 이름을 문장에 박아 두지 않는다 — 서버가 켠 채널만 이름을 대고, 없으면 그 문장이 아예 없다. */}
      <p className="notification-settings-note">유형별로 화면 표시와 푸시를 따로 정합니다. 끈 유형은 아예 쌓이지 않습니다.{channels.length ? ` ${channels.map((channel) => channel.label).join('·')}은 켠 유형만 나갑니다.` : ''}</p>

      {/* R15-I: 밤에는 울리지 않고, 아침에 한 건으로 묶어 전한다. */}
      <div className="notification-quiet">
        <label className="notification-quiet-toggle">
          <input
            type="checkbox"
            checked={feed.settings.quietHours?.enabled !== false}
            disabled={busy}
            onChange={(event) => void saveSettings({ ...feed.settings, quietHours: { ...feed.settings.quietHours, enabled: event.target.checked } })}
          />
          <span><Moon size={15} /> 방해 금지 시간</span>
        </label>
        <div className="notification-quiet-range">
          <input
            type="time"
            value={feed.settings.quietHours?.start ?? '22:00'}
            disabled={busy || feed.settings.quietHours?.enabled === false}
            aria-label="방해 금지 시작"
            onChange={(event) => void saveSettings({ ...feed.settings, quietHours: { ...feed.settings.quietHours, start: event.target.value } })}
          />
          <span>부터</span>
          <input
            type="time"
            value={feed.settings.quietHours?.end ?? '07:00'}
            disabled={busy || feed.settings.quietHours?.enabled === false}
            aria-label="방해 금지 끝"
            onChange={(event) => void saveSettings({ ...feed.settings, quietHours: { ...feed.settings.quietHours, end: event.target.value } })}
          />
          <span>까지</span>
        </div>
        <p>이 시간에 온 알림은 사라지지 않고 쌓였다가 아침에 한 건으로 묶여 옵니다. 아래에서 고른 유형만 그때도 울립니다.</p>
      </div>
      <div className="notification-settings-table">
        <table>
          <thead><tr>
            <th scope="col">유형</th><th scope="col">받기</th><th scope="col">푸시</th>
            {/* 열은 서버가 준 채널 목록에서 나온다. 채널 이름을 여기 적어 두면 새 채널이 표에 못 들어온다. */}
            {channels.map((channel) => <th key={channel.id} scope="col">{channel.label}</th>)}
            <th scope="col">밤에도</th>
          </tr></thead>
          <tbody>{feed.types.map((type) => {
            const muted = feed.settings.muted.includes(type.id)
            return <tr key={type.id}>
              <th scope="row">{type.label}</th>
              <td><label><input type="checkbox" checked={!muted} disabled={busy} onChange={() => void saveSettings({ ...feed.settings, muted: toggle(feed.settings.muted, type.id) })} /><span className="sr-only">{type.label} 받기</span></label></td>
              <td><label><input type="checkbox" checked={feed.settings.push.includes(type.id)} disabled={busy || muted} onChange={() => void saveSettings({ ...feed.settings, push: toggle(feed.settings.push, type.id) })} /><span className="sr-only">{type.label} 푸시</span></label></td>
              {channels.map((channel) => <td key={channel.id}><label><input type="checkbox" checked={channelTypes(feed.settings, channel.id).includes(type.id)} disabled={busy || muted} onChange={() => void saveSettings({ ...feed.settings, [channel.id]: toggle(channelTypes(feed.settings, channel.id), type.id) })} /><span className="sr-only">{type.label} {channel.label}</span></label></td>)}
              <td><label><input type="checkbox" checked={(feed.settings.urgentTypes ?? []).includes(type.id)} disabled={busy || muted || feed.settings.quietHours?.enabled === false} onChange={() => void saveSettings({ ...feed.settings, urgentTypes: toggle(feed.settings.urgentTypes ?? [], type.id) })} /><span className="sr-only">{type.label}은 방해 금지 시간에도 알림</span></label></td>
            </tr>
          })}</tbody>
        </table>
      </div>
      <div className="notification-push-devices">
        <strong><Smartphone size={15} /> 푸시 받는 기기</strong>
        {!feed.push.configured && <p>서버에 웹푸시 키(VAPID)가 설정되지 않아 푸시를 켤 수 없습니다.</p>}
        {feed.push.configured && feed.push.devices.length === 0 && <p>등록된 기기가 없습니다.</p>}
        {feed.push.devices.map((device) => <div key={device.id}>
          <span>{device.userAgent || '기기'} · {formatDateTime(device.createdAt)}</span>
          <Button tone="quiet" size="sm" type="button" disabled={busy} onClick={() => void disablePush(device.endpoint)}>끄기</Button>
        </div>)}
        {feed.push.configured && <Button tone="secondary" size="sm" type="button" disabled={busy} onClick={() => void enablePush()}>이 기기 등록</Button>}
      </div>
    </div>}

    <div className="notification-list">
      {feed.items.length === 0 && <div className="notification-empty"><BellOff size={22} /><strong>새 알림이 없습니다</strong><span>업무 배정·결재 요청·멘션이 생기면 여기에 표시됩니다.</span></div>}
      {feed.items.map((item) => {
        const Icon = typeIcon[item.type] ?? CheckCircle2
        return <button
          type="button"
          key={item.id}
          className={item.readAt ? 'is-read' : 'is-unread'}
          aria-label={`${item.readAt ? '읽음' : '읽지 않음'} · ${item.title}`}
          onClick={() => open(item)}
        >
          <span className={`notice-icon ${typeTone[item.type] ?? 'blue'}`}><Icon size={17} /></span>
          <div>
            <strong>{item.title}</strong>
            {item.body && <p>{item.body}</p>}
            <small>{feed.types.find((type) => type.id === item.type)?.label ?? item.type} · {formatListDateTime(item.createdAt)}</small>
          </div>
          <i className="notice-state" aria-hidden="true" />
        </button>
      })}
    </div>
  </section>
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, BellOff, CheckCircle2, ClipboardCheck, ListChecks, MessageCircle, Radar, Settings2, ShieldAlert, Smartphone } from 'lucide-react'
import { formatDateTime } from '../utils/dateTime'
import { Button, IconButton } from './ui/Button'
import './NotificationCenter.css'

export type NotificationType =
  | 'task-assigned' | 'approval-requested' | 'changes-requested'
  | 'mention' | 'proposal-pending' | 'sentinel-warning' | 'opportunity-new'

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

type NotificationSettings = { muted: NotificationType[]; push: NotificationType[] }
type TypeMeta = { id: NotificationType; label: string; pushByDefault: boolean }
type PushDevice = { id: string; endpoint: string; userAgent: string; createdAt: string }

export type NotificationFeed = {
  items: AppNotification[]
  unread: number
  settings: NotificationSettings
  types: TypeMeta[]
  push: { configured: boolean; publicKey: string; devices: PushDevice[] }
}

const typeIcon: Record<NotificationType, typeof ListChecks> = {
  'task-assigned': ListChecks,
  'approval-requested': ClipboardCheck,
  'changes-requested': AlertTriangle,
  mention: MessageCircle,
  'proposal-pending': ClipboardCheck,
  'sentinel-warning': ShieldAlert,
  'opportunity-new': Radar,
}

const typeTone: Record<NotificationType, string> = {
  'task-assigned': 'blue',
  'approval-requested': 'amber',
  'changes-requested': 'red',
  mention: 'violet',
  'proposal-pending': 'blue',
  'sentinel-warning': 'amber',
  'opportunity-new': 'green',
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
      <p className="notification-settings-note">유형별로 화면 표시와 푸시를 따로 정합니다. 끈 유형은 아예 쌓이지 않습니다.</p>
      <table>
        <thead><tr><th scope="col">유형</th><th scope="col">받기</th><th scope="col">푸시</th></tr></thead>
        <tbody>{feed.types.map((type) => {
          const muted = feed.settings.muted.includes(type.id)
          return <tr key={type.id}>
            <th scope="row">{type.label}</th>
            <td><label><input type="checkbox" checked={!muted} disabled={busy} onChange={() => void saveSettings({ ...feed.settings, muted: toggle(feed.settings.muted, type.id) })} /><span className="sr-only">{type.label} 받기</span></label></td>
            <td><label><input type="checkbox" checked={feed.settings.push.includes(type.id)} disabled={busy || muted} onChange={() => void saveSettings({ ...feed.settings, push: toggle(feed.settings.push, type.id) })} /><span className="sr-only">{type.label} 푸시</span></label></td>
          </tr>
        })}</tbody>
      </table>
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
            <small>{feed.types.find((type) => type.id === item.type)?.label ?? item.type} · {formatDateTime(item.createdAt)}</small>
          </div>
          <i className="notice-state" aria-hidden="true" />
        </button>
      })}
    </div>
  </section>
}

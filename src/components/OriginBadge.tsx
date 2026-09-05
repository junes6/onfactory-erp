import { ArrowUpRight, LayoutTemplate, Radar, ShieldAlert, Sparkles } from 'lucide-react'
import './OriginBadge.css'

export type WorkOrigin = {
  kind: string
  label?: string
  detail?: string
  page?: string
  focusId?: string
}

const kindIcon = (kind: string) => (
  kind === 'template' ? LayoutTemplate
    : kind === 'sentinel-task' ? ShieldAlert
      : kind === 'opportunity' ? Radar
        : Sparkles
)

/**
 * 출처 배지. "이 업무는 어디서 비롯됐는가"를 한 줄로 밝히고, 누르면 원인으로 간다.
 * 출처가 없는 항목(사람이 직접 만든 것)에는 아무것도 표시하지 않는다 — 없는 근거를 지어내지 않는다.
 */
export function OriginBadge({ origin, onOpen }: {
  origin?: WorkOrigin | null
  onOpen?: (page: string, focusId: string) => void
}) {
  if (!origin?.kind) return null
  const Icon = kindIcon(origin.kind)
  const label = origin.label || 'AI 제안에서 생성'
  const text = origin.detail ? `${label} · ${origin.detail}` : label
  const canOpen = Boolean(onOpen && origin.page && origin.focusId)

  if (!canOpen) return <span className="origin-badge" title={text}><Icon size={13} /> {label}</span>

  return <button
    type="button"
    className="origin-badge is-link"
    title={text}
    aria-label={`출처로 이동 · ${text}`}
    onClick={() => onOpen?.(origin.page as string, origin.focusId as string)}
  >
    <Icon size={13} /> {label} <ArrowUpRight size={12} />
  </button>
}

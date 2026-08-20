import type { ReactNode } from 'react'
import './StatusBadge.css'

export type StatusBadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export interface StatusBadgeProps {
  children: ReactNode
  tone?: StatusBadgeTone
  icon?: ReactNode
  dot?: boolean
  className?: string
}

export function StatusBadge({
  children,
  tone = 'neutral',
  icon,
  dot = false,
  className = '',
}: StatusBadgeProps) {
  const classes = ['unified-status-badge', `unified-status-badge--${tone}`, className]
    .filter(Boolean)
    .join(' ')

  return (
    <span className={classes}>
      {dot && <span className="unified-status-badge__dot" aria-hidden="true" />}
      {icon && <span className="unified-status-badge__icon" aria-hidden="true">{icon}</span>}
      <span className="unified-status-badge__label">{children}</span>
    </span>
  )
}

export default StatusBadge

import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

export function ChatBubbleIcon({ size = 22, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path d="M20.25 11.35c0 4.35-3.69 7.6-8.25 7.6-1.04 0-2.04-.17-2.96-.5L4.2 20.2l1.53-3.7a7.1 7.1 0 0 1-1.98-5.15c0-4.34 3.69-7.6 8.25-7.6s8.25 3.26 8.25 7.6Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M8.15 11.5h.01M12 11.5h.01M15.85 11.5h.01" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" />
    </svg>
  )
}

export function NotificationBellIcon({ size = 22, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path d="M18.1 9.65c0-3.33-2.05-5.65-5.1-6.02V2.7a1 1 0 0 0-2 0v.93c-3.05.37-5.1 2.69-5.1 6.02 0 3.84-1.4 5.36-2.15 6.17-.3.32-.07.85.37.85h15.76c.44 0 .67-.53.37-.85-.75-.81-2.15-2.33-2.15-6.17Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M9.25 19.1a2.9 2.9 0 0 0 5.5 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

export function OnFactoryMark({ size = 38, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 38 38" fill="none" aria-hidden="true" {...props}>
      <rect width="38" height="38" rx="11" fill="currentColor" />
      <path d="M9.5 27.5v-15l6.2 3.6v-3.6l6.1 3.6v-6l6.7 3.9v13.5h-19Z" fill="#143d34" stroke="#143d34" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M14 22h2.5M20 22h2.5M14 25h2.5M20 25h2.5" stroke="#d9f38d" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

import type { ReactNode } from 'react'
import { AlertTriangle, Inbox, RotateCcw } from 'lucide-react'
import { Button } from './Button'
import './States.css'

/**
 * 화면이 "지금 어떤 상태인가"를 말하는 세 가지.
 *
 * 지금까지는 화면마다 제각각이었다 — 어디는 "데이터 없음", 어디는 빈 표,
 * 어디는 아무것도 안 나오고 끝. 같은 상황을 같은 모양으로 보여 주지 않으면
 * 사용자는 매번 "이게 고장인가 없는 건가"를 새로 판단해야 한다.
 *
 * 셋 다 한 가지를 지킨다: 무슨 일이 있었는지 말하고, 다음에 무엇을 할 수 있는지 준다.
 */

/**
 * 불러오는 중.
 *
 * 빙글빙글 도는 표시 대신 들어올 내용의 모양을 미리 그린다. 목록이 들어올
 * 자리에 목록 모양이 있으면 화면이 덜컥 바뀌지 않는다.
 */
export function Skeleton({ rows = 3, variant = 'list', label = '불러오는 중' }: {
  rows?: number
  variant?: 'list' | 'card' | 'text'
  label?: string
}) {
  return (
    <div className={`ui-skeleton is-${variant}`} role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      {Array.from({ length: Math.max(1, Math.min(12, rows)) }, (_, index) => (
        <div className="ui-skeleton-row" key={index} aria-hidden="true">
          <span className="ui-skeleton-block is-lead" />
          <span className="ui-skeleton-lines">
            <span className="ui-skeleton-block is-title" />
            <span className="ui-skeleton-block is-meta" />
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * 비어 있음.
 *
 * "데이터 없음"만 쓰면 사용자는 자기가 뭘 잘못했는지 의심한다. 왜 비었는지와
 * 무엇을 하면 채워지는지를 함께 말한다.
 */
export function EmptyState({ title, description, action, icon }: {
  title: string
  description?: string
  action?: ReactNode
  icon?: ReactNode
}) {
  return (
    <div className="ui-empty" role="status">
      <span className="ui-empty-icon">{icon ?? <Inbox size={22} />}</span>
      <strong>{title}</strong>
      {description && <p>{description}</p>}
      {action}
    </div>
  )
}

/**
 * 잘못됐음.
 *
 * 다시 시도 단추를 반드시 준다. 실패를 알리기만 하고 길을 주지 않으면
 * 사용자가 할 수 있는 일은 새로 고침뿐이고, 그러면 쓰던 것이 날아간다.
 */
export function ErrorState({ title = '불러오지 못했습니다', detail, onRetry, retrying = false }: {
  title?: string
  detail?: string
  onRetry?: () => void
  retrying?: boolean
}) {
  return (
    <div className="ui-error" role="alert">
      <span className="ui-error-icon"><AlertTriangle size={22} /></span>
      <div>
        <strong>{title}</strong>
        {detail && <p>{detail}</p>}
      </div>
      {onRetry && (
        <Button tone="secondary" size="sm" disabled={retrying} onClick={onRetry}>
          <RotateCcw size={15} /> {retrying ? '다시 시도 중…' : '다시 시도'}
        </Button>
      )}
    </div>
  )
}

/**
 * 저장 상태.
 *
 * 자동 저장은 조용해서 좋지만, 조용하기만 하면 사용자가 저장됐는지 알 수 없어
 * 창을 닫지 못한다. 마지막으로 저장된 시각을 늘 보이게 둔다.
 */
export function SaveState({ status, savedAt, error }: {
  status: 'idle' | 'saving' | 'saved' | 'dirty' | 'error'
  savedAt?: string
  error?: string
}) {
  if (status === 'idle' && !savedAt) return null
  const text = status === 'saving' ? '저장 중…'
    : status === 'dirty' ? '저장되지 않은 변경이 있습니다'
      : status === 'error' ? (error || '저장하지 못했습니다')
        : savedAt ? `${savedAt}에 저장됨` : '저장됨'
  return <span className={`ui-save-state is-${status}`} role="status" aria-live="polite">{text}</span>
}

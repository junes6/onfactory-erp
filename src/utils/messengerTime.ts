import { seoulDateInputValue } from './dateTime.ts'

/**
 * 메신저의 날짜·시각 표기. 전에는 모든 방 위에 날짜와 무관하게 '오늘'이 붙고, 목록 시각은 시:분만 있어
 * 지난주 대화도 '오늘 14:05'처럼 읽혔다. 방 목록도 저장 순서 그대로라 최근 대화가 아래에 묻혔다.
 * 판단은 모두 서울 날짜로 한다(자정 넘어 보낸 말이 어제로 보이지 않게).
 */

type WithTime = { createdAt?: string; threadRootId?: string }
type WithActivity<T extends WithTime> = { lastAt?: string; messages?: T[] }

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']

const validIso = (value: string | undefined) => Boolean(value) && Number.isFinite(Date.parse(String(value)))

/** 서울 기준 'YYYY-MM-DD'. 시각이 없으면 ''. */
export function seoulDay(iso: string | undefined): string {
  return validIso(iso) ? seoulDateInputValue(new Date(String(iso))) : ''
}

function dayOffset(day: string, now: Date) {
  const today = seoulDateInputValue(now)
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000)
}

/** 말 사이의 날짜 구분선: 오늘 / 어제 / 9월 16일 (화) / 2025년 12월 3일 (수). */
export function dayDividerLabel(iso: string | undefined, now = new Date()): string {
  const day = seoulDay(iso)
  if (!day) return ''
  const offset = dayOffset(day, now)
  if (offset === 0) return '오늘'
  if (offset === 1) return '어제'
  const [year, month, date] = day.split('-').map(Number)
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, date)).getUTCDay()]
  const sameYear = day.slice(0, 4) === seoulDateInputValue(now).slice(0, 4)
  return `${sameYear ? '' : `${year}년 `}${month}월 ${date}일 (${weekday})`
}

/** 방 목록의 시각: 오늘이면 시:분, 어제면 '어제', 올해면 '9월 16일', 그 전이면 '2025. 12. 3.'. 시각을 모르면 저장된 글자 그대로. */
export function listTimeLabel(iso: string | undefined, fallback = '', now = new Date()): string {
  const day = seoulDay(iso)
  if (!day) return fallback
  const offset = dayOffset(day, now)
  if (offset === 0) {
    return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(String(iso)))
  }
  if (offset === 1) return '어제'
  const [year, month, date] = day.split('-').map(Number)
  return day.slice(0, 4) === seoulDateInputValue(now).slice(0, 4) ? `${month}월 ${date}일` : `${year}. ${month}. ${date}.`
}

/**
 * 방의 마지막 활동 시각 — 서버가 적은 lastAt과 본채널 마지막 말의 시각 중 늦은 것.
 * lastAt은 사람이 보낸 말에만 붙는다(예전 방·시스템 알림·외부 연동 글에는 없다) — 그래서 둘을 함께 본다.
 */
export function lastActivityAt<T extends WithTime>(conversation: WithActivity<T>): string {
  const stored = validIso(conversation.lastAt) ? String(conversation.lastAt) : ''
  const messages = Array.isArray(conversation.messages) ? conversation.messages : []
  let latest = ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message?.threadRootId && validIso(message?.createdAt)) { latest = String(message.createdAt); break }
  }
  if (!stored) return latest
  if (!latest) return stored
  return Date.parse(latest) > Date.parse(stored) ? latest : stored
}

/** 최근 활동순. 시각을 모르는 방은 뒤로, 같은 시각끼리는 원래 순서를 지킨다. */
export function byRecentActivity<T extends WithActivity<WithTime>>(conversations: readonly T[]): T[] {
  return conversations
    .map((conversation, index) => ({ conversation, index, at: Date.parse(lastActivityAt(conversation)) }))
    .sort((left, right) => {
      const l = Number.isFinite(left.at) ? left.at : -Infinity
      const r = Number.isFinite(right.at) ? right.at : -Infinity
      return r === l ? left.index - right.index : r - l
    })
    .map((entry) => entry.conversation)
}

/** 이 말 앞에 날짜 구분선을 둘까 — 첫 말이거나 앞 말과 서울 날짜가 다르면 그 날짜의 이름. */
export function dividerBefore<T extends WithTime>(messages: readonly T[], index: number, now = new Date()): string {
  const current = seoulDay(messages[index]?.createdAt)
  if (!current) return ''
  const previous = index > 0 ? seoulDay(messages[index - 1]?.createdAt) : ''
  return current === previous ? '' : dayDividerLabel(messages[index].createdAt, now)
}

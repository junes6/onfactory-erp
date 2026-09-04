// Node가 .ts를 직접 실행하는 테스트 경로에서는 import attribute가 없으면 거부한다.
// Vite는 없어도 통과하므로 빌드만 보고 넘기면 서버 테스트에서만 터진다.
import holidayData from '../../shared/korean-holidays.json' with { type: 'json' }

/**
 * 대한민국 법정 공휴일 (2024–2027).
 *
 * 값은 shared/korean-holidays.json 한 곳에 있다. 서버의 반복 업무 일정도 같은 파일을 읽는다 —
 * 달력이 빨간 날이라고 표시한 날에 서버가 업무를 만들어 버리면 두 화면이 서로를 반박한다.
 */
const KOREAN_HOLIDAYS: Record<string, string> = holidayData.holidays

/** 'YYYY-MM-DD' → 공휴일 이름 (아니면 null). */
export function holidayName(dateKey: string): string | null {
  return KOREAN_HOLIDAYS[dateKey] ?? null
}

/** 달력 칠 때 쓰는 하루 성격: 공휴일 > 일요일 > 토요일 > 평일. */
export type DayKind = 'holiday' | 'sunday' | 'saturday' | 'weekday'

export function dayKind(dateKey: string): DayKind {
  if (KOREAN_HOLIDAYS[dateKey]) return 'holiday'
  const day = new Date(`${dateKey}T00:00:00Z`).getUTCDay()
  if (day === 0) return 'sunday'
  if (day === 6) return 'saturday'
  return 'weekday'
}

/** 근무일 여부 (주말·공휴일 제외). */
export function isWorkingDay(dateKey: string): boolean {
  return dayKind(dateKey) === 'weekday'
}

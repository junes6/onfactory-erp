import { dayKeyDiff, seoulDateInputValue } from './dateTime.ts'

/**
 * 만료일이 있는 기록의 상태는 **볼 때마다** 날짜에서 계산한다. 저장해 둔 상태값은 믿지 않는다.
 *
 * 전에는 식품안전·인증 항목의 상태를 저장하는 순간에만 계산해, 만료일이 지나도 다시 저장하기 전까지
 * 초록 '정상'과 '지금 필요한 조치가 없습니다'가 떠 있었다(같은 날 생존 센티널은 날짜로 판정해 '만료'
 * 제안을 올렸다 — 화면과 승인 큐가 서로 다른 말을 했다). 지식재산은 사람이 '등록'을 골라 두면
 * 만료 12일이 지나도 초록 '등록' 배지가 그대로였다.
 */

/** 서울 오늘부터 dateKey(YYYY-MM-DD)까지 남은 날. 오늘이면 0, 지났으면 음수. 날짜가 없거나 틀리면 null. */
export function daysUntil(dateKey: string | undefined, today = seoulDateInputValue()): number | null {
  const key = typeof dateKey === 'string' ? dateKey.trim() : ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || Number.isNaN(Date.parse(`${key}T00:00:00Z`))) return null
  return dayKeyDiff(today, key)
}

// ── 식품안전·인증 ─────────────────────────────────────────────

export type ComplianceStatus = '유효' | '갱신예정' | '보완필요' | '만료'

/** 다음 검토일 90일 전부터 '갱신 준비'. 증빙이 없거나 검토일을 읽을 수 없으면 '증빙 필요'. */
export const COMPLIANCE_RENEWAL_WINDOW_DAYS = 90

export function deriveComplianceStatus(expiresAt: string | undefined, attachmentCount: number, today = seoulDateInputValue()): ComplianceStatus {
  if (!attachmentCount) return '보완필요'
  const remaining = daysUntil(expiresAt, today)
  if (remaining === null) return '보완필요'
  if (remaining < 0) return '만료'
  if (remaining <= COMPLIANCE_RENEWAL_WINDOW_DAYS) return '갱신예정'
  return '유효'
}

// ── 지식재산·인증 ─────────────────────────────────────────────

/** 사람이 고르는 진행 단계. 등록 뒤의 상태(갱신 필요·만료)는 고르지 않는다 — 만료일에서 계산한다. */
export const IP_STAGES = ['준비', '출원', '심사 중', '등록'] as const
export type IpStage = typeof IP_STAGES[number]
export type IpDisplayStatus = IpStage | '갱신 필요' | '만료'

/** 만료 60일 전부터 '갱신 필요'. */
export const IP_RENEWAL_WINDOW_DAYS = 60

/** 저장값을 진행 단계로 되돌린다. 예전에 사람이 고른 '갱신 필요'·'만료'는 등록된 권리였다는 뜻이다. */
export function ipStageOf(stored: string | undefined): IpStage {
  if (stored === '준비' || stored === '출원' || stored === '심사 중') return stored
  if (stored === '등록' || stored === '갱신 필요' || stored === '만료') return '등록'
  return '준비'
}

export function deriveIpStatus(stored: string | undefined, expiresAt: string | undefined, today = seoulDateInputValue()): IpDisplayStatus {
  const stage = ipStageOf(stored)
  if (stage !== '등록') return stage
  const remaining = daysUntil(expiresAt, today)
  if (remaining === null) {
    // 만료일이 없으면 날짜로 판정할 근거가 없다. 예전에 사람이 직접 '갱신 필요'·'만료'라고 적어 둔 것은 그대로 존중한다.
    return stored === '만료' || stored === '갱신 필요' ? stored : '등록'
  }
  if (remaining < 0) return '만료'
  if (remaining <= IP_RENEWAL_WINDOW_DAYS) return '갱신 필요'
  return '등록'
}

import { dayKeyDiff, seoulDateInputValue, toIsoUtc } from './dateTime.ts'

/**
 * 판매채널 화면의 기간별 집계 — 이 화면에 등록했거나 CSV로 올린 출고 주문(sales-shipments)에서 센다.
 *
 * 전에는 저장된 채널 합계에 기간별 고정 배수(오늘 0.16 · 7일 1 · 30일 4.18)를 곱해 '오늘'·'최근 30일' 숫자를
 * 만들어 냈다. 그 합계를 채우는 곳도 없었다. 기간은 서울 날짜로 자른다: '오늘'은 오늘 하루, '최근 7일'은
 * 오늘을 포함한 7일, '최근 30일'은 오늘을 포함한 30일이다.
 *
 * 매출은 여기서 만들지 않는다. 출고 주문에는 결제 금액이 없다 — 제품 판매가를 곱해 '매출'이라고 부르면
 * 할인·채널 수수료를 모르는 추정값이 실적처럼 보인다.
 */

export type SalesPeriod = 'today' | 'week' | 'month'

export const SALES_PERIODS: ReadonlyArray<{ id: SalesPeriod; label: string; days: number }> = [
  { id: 'today', label: '오늘', days: 1 },
  { id: 'week', label: '최근 7일', days: 7 },
  { id: 'month', label: '최근 30일', days: 30 },
]

export type PeriodShipment = { channelId: string; quantity: number; orderedAt: string }

export type ChannelPeriodTotals = { orders: number; units: number }

export type PeriodSummary = ChannelPeriodTotals & {
  byChannel: Record<string, ChannelPeriodTotals>
}

export function salesPeriodDays(period: SalesPeriod) {
  return SALES_PERIODS.find((item) => item.id === period)?.days ?? 7
}

/** 주문 시각이 기간 안에 드는가. 시각을 읽을 수 없거나 미래(오늘 이후)면 넣지 않는다. */
export function isInSalesPeriod(orderedAt: string, period: SalesPeriod, now = new Date()) {
  const iso = toIsoUtc(orderedAt, now)
  if (!iso) return false
  const age = dayKeyDiff(seoulDateInputValue(new Date(iso)), seoulDateInputValue(now))
  return age >= 0 && age < salesPeriodDays(period)
}

export function summarizeShipments(shipments: ReadonlyArray<PeriodShipment>, period: SalesPeriod, now = new Date()): PeriodSummary {
  const summary: PeriodSummary = { orders: 0, units: 0, byChannel: {} }
  for (const shipment of shipments) {
    if (!isInSalesPeriod(shipment.orderedAt, period, now)) continue
    const units = Number.isFinite(shipment.quantity) && shipment.quantity > 0 ? shipment.quantity : 0
    const channel = summary.byChannel[shipment.channelId] ??= { orders: 0, units: 0 }
    channel.orders += 1
    channel.units += units
    summary.orders += 1
    summary.units += units
  }
  return summary
}

import { isWorkingDay } from './koreanHolidays.ts'

export type TaxEntityType = 'corporation' | 'individual'
export type VatType = 'general' | 'simplified' | 'exempt'
export type WithholdingCycle = 'monthly' | 'semiannual'

export type TaxProfile = {
  entityType: TaxEntityType
  fiscalYearEndMonth: number
  vatType: VatType
  hasPayroll: boolean
  withholdingCycle: WithholdingCycle
}

export type ProvidedTaxSchedule = {
  id: string
  ruleId: string
  year: number
  kind: '부가가치세' | '원천세' | '법인세' | '종합소득세'
  title: string
  dueDate: string
  description: string
  appliesTo: string
  evidenceBucket: '매출' | '매입' | '급여' | '경비' | '신고·납부' | '기타'
  sourceLabel: string
  sourceUrl: string
  checkedAt: string
}

export const TAX_RULES_CHECKED_AT = '2026-08-24'
export const NTS_YEAR_CALENDAR_URL = (year: number) => `https://www.nts.go.kr/nts/ad/taxSchdul/selectList.do?mi=135747&taxMonth=&taxYear=${year}`
export const NTS_CORPORATE_TAX_URL = 'https://www.nts.go.kr/nts/cm/cntnts/cntntsView.do?cntntsId=7975'
export const NTS_VAT_URL = 'https://d.nts.go.kr/nts/cm/cntnts/cntntsView.do?cntntsId=238927&mi=2402'
export const NTS_INCOME_TAX_URL = 'https://nts.go.kr/nts/cm/cntnts/cntntsView.do?cntntsId=7665&mi=2224'

function dateKey(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function shiftDate(date: string, days: number) {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

/** 국세기본법상 토요일·공휴일 등에 걸린 기한을 다음 근무일로 이월한다. */
export function rollTaxDeadline(date: string) {
  let result = date
  for (let attempts = 0; attempts < 10 && !isWorkingDay(result); attempts += 1) result = shiftDate(result, 1)
  return result
}

function endOfMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function scheduleItem(year: number, ruleId: string, value: Omit<ProvidedTaxSchedule, 'id' | 'ruleId' | 'year' | 'checkedAt'>): ProvidedTaxSchedule {
  return { ...value, id: `TAX-${year}-${ruleId}`, ruleId, year, checkedAt: TAX_RULES_CHECKED_AT }
}

function vatSchedules(profile: TaxProfile, year: number) {
  if (profile.vatType === 'exempt') return []
  const source = { sourceLabel: '국세청 부가가치세 신고 안내', sourceUrl: NTS_VAT_URL, evidenceBucket: '신고·납부' as const }
  if (profile.vatType === 'simplified') {
    return [scheduleItem(year, 'vat-annual', {
      kind: '부가가치세', title: `${year - 1}년 간이과세 부가가치세 확정신고`, dueDate: rollTaxDeadline(dateKey(year, 1, 25)),
      description: '직전 과세기간 매출·매입 자료와 카드·현금영수증 내역을 모아 확정신고를 준비합니다.',
      appliesTo: '간이과세 사업자', ...source,
    })]
  }
  const quarters = profile.entityType === 'corporation'
    ? [[1, 25, `${year - 1}년 2기 확정`], [4, 25, `${year}년 1기 예정`], [7, 25, `${year}년 1기 확정`], [10, 25, `${year}년 2기 예정`]] as const
    : [[1, 25, `${year - 1}년 2기 확정`], [7, 25, `${year}년 1기 확정`]] as const
  return quarters.map(([month, day, period]) => scheduleItem(year, `vat-${String(month).padStart(2, '0')}`, {
    kind: '부가가치세', title: `${period} 부가가치세 신고·납부`, dueDate: rollTaxDeadline(dateKey(year, month, day)),
    description: '매출·매입 세금계산서, 카드매출, 현금영수증과 공제 증빙을 기간별로 확인합니다.',
    appliesTo: profile.entityType === 'corporation' ? '일반과세 법인' : '일반과세 개인사업자', ...source,
  }))
}

function withholdingSchedules(profile: TaxProfile, year: number) {
  if (!profile.hasPayroll) return []
  const months = profile.withholdingCycle === 'semiannual' ? [1, 7] : Array.from({ length: 12 }, (_, index) => index + 1)
  return months.map((month) => scheduleItem(year, `withholding-${String(month).padStart(2, '0')}`, {
    kind: '원천세',
    title: profile.withholdingCycle === 'semiannual'
      ? `${month === 1 ? '전년도 하반기' : '상반기'} 원천세 신고·납부`
      : `${month}월 원천세 신고·납부`,
    dueDate: rollTaxDeadline(dateKey(year, month, 10)),
    description: '급여·사업소득 지급명세와 원천징수 내역을 대조하고 납부서를 보관합니다.',
    appliesTo: profile.withholdingCycle === 'semiannual' ? '원천세 반기납부 승인을 받은 원천징수의무자' : '급여·용역 대가를 지급하는 원천징수의무자',
    evidenceBucket: '급여', sourceLabel: `${year} 국세청 세무일정`, sourceUrl: NTS_YEAR_CALENDAR_URL(year),
  }))
}

function annualIncomeSchedule(profile: TaxProfile, year: number) {
  if (profile.entityType === 'individual') {
    return scheduleItem(year, 'income-tax', {
      kind: '종합소득세', title: `${year - 1}년 귀속 종합소득세 신고·납부`, dueDate: rollTaxDeadline(dateKey(year, 5, 31)),
      description: '사업소득과 필요경비, 소득공제·세액공제 증빙을 모아 연간 신고를 준비합니다.',
      appliesTo: '종합소득이 있는 개인사업자', evidenceBucket: '신고·납부', sourceLabel: '국세청 종합소득세 안내', sourceUrl: NTS_INCOME_TAX_URL,
    })
  }
  const closingMonth = Math.min(12, Math.max(1, Math.trunc(profile.fiscalYearEndMonth || 12)))
  const dueMonth = ((closingMonth + 2) % 12) + 1
  const closingYear = dueMonth <= closingMonth ? year - 1 : year
  const dueYear = closingYear + (dueMonth <= closingMonth ? 1 : 0)
  return scheduleItem(year, 'corporate-tax', {
    kind: '법인세', title: `${closingYear}사업연도 법인세 신고·납부`, dueDate: rollTaxDeadline(dateKey(dueYear, dueMonth, endOfMonth(dueYear, dueMonth))),
    description: `결산월(${closingMonth}월) 말일부터 3개월 이내 신고 기준입니다. 재무제표·세무조정 자료와 납부서를 함께 보관합니다.`,
    appliesTo: `${closingMonth}월 결산 법인`, evidenceBucket: '신고·납부', sourceLabel: '국세청 법인세 신고기한 안내', sourceUrl: NTS_CORPORATE_TAX_URL,
  })
}

export function buildProvidedTaxSchedule(profile: TaxProfile, year: number): ProvidedTaxSchedule[] {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return []
  return [annualIncomeSchedule(profile, year), ...vatSchedules(profile, year), ...withholdingSchedules(profile, year)]
    .sort((left, right) => left.dueDate.localeCompare(right.dueDate) || left.id.localeCompare(right.id))
}

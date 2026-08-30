import { isWorkingDay } from './koreanHolidays.ts'

export type TaxEntityType = 'corporation' | 'individual'
export type VatType = 'general' | 'simplified' | 'exempt'
export type WithholdingCycle = 'monthly' | 'semiannual'
export type TaxIndustryType = 'food_manufacturing' | 'it_services'

export type TaxProfile = {
  entityType: TaxEntityType
  fiscalYearEndMonth: number
  vatType: VatType
  hasPayroll: boolean
  withholdingCycle: WithholdingCycle
}

export type TaxKind = '부가가치세' | '원천세' | '법인세' | '종합소득세' | '지급명세서' | '4대보험' | '사업장현황신고'
export type EvidenceBucket = '매출' | '매입' | '급여' | '경비' | '신고·납부' | '기타'

export type ProvidedTaxSchedule = {
  id: string
  ruleId: string
  year: number
  kind: TaxKind
  title: string
  dueDate: string
  description: string
  appliesTo: string
  evidenceBucket: EvidenceBucket
  /** 신고 전에 모아야 하는 서류 목록. 업종·법인 구분에 따라 달라진다. */
  preparation: string[]
  sourceLabel: string
  sourceUrl: string
  checkedAt: string
}

export const TAX_RULES_CHECKED_AT = '2026-08-30'
export const NTS_YEAR_CALENDAR_URL = (year: number) => `https://www.nts.go.kr/nts/ad/taxSchdul/selectList.do?mi=135747&taxMonth=&taxYear=${year}`
export const NTS_CORPORATE_TAX_URL = 'https://www.nts.go.kr/nts/cm/cntnts/cntntsView.do?cntntsId=7975'
export const NTS_VAT_URL = 'https://d.nts.go.kr/nts/cm/cntnts/cntntsView.do?cntntsId=238927&mi=2402'
export const NTS_INCOME_TAX_URL = 'https://nts.go.kr/nts/cm/cntnts/cntntsView.do?cntntsId=7665&mi=2224'
export const SOCIAL_INSURANCE_URL = 'https://www.4insure.or.kr/'

/**
 * 아무것도 등록하지 않은 신규 고객사에도 일정을 보여주기 위한 기본 조건.
 * 국내 사업자 다수가 해당하는 값(법인 · 일반과세 · 12월 결산 · 급여 지급)으로 시작하고,
 * 다르면 회사 조건 화면에서 한 번만 고쳐 잡는다. 업종은 준비물 목록을 갈라 준다.
 */
export const DEFAULT_TAX_PROFILE: TaxProfile = Object.freeze({
  entityType: 'corporation',
  fiscalYearEndMonth: 12,
  vatType: 'general',
  hasPayroll: true,
  withholdingCycle: 'monthly',
})

export function defaultTaxProfile(): TaxProfile {
  return { ...DEFAULT_TAX_PROFILE }
}

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

/**
 * 업종별 추가 준비물. 공통 목록 뒤에 붙여, 같은 신고라도 우리 업종에서 빠뜨리기 쉬운 서류를 짚어 준다.
 */
const industryPreparation: Readonly<Record<TaxIndustryType, Partial<Record<TaxKind, readonly string[]>>>> = {
  food_manufacturing: {
    부가가치세: ['원재료·부자재 매입 세금계산서', '임가공·위탁생산 계산서', '면세 농수산물 의제매입 자료'],
    원천세: ['일용직 근로내역서', '생산직 야간·연장근로수당 지급 내역'],
    법인세: ['원재료·제품 재고 실사표', '식품 인증·자가품질검사 수수료 영수증'],
    종합소득세: ['원재료·제품 재고 실사표', '식품 인증·자가품질검사 수수료 영수증'],
  },
  it_services: {
    부가가치세: ['외주 개발·용역 계산서', '클라우드·소프트웨어 구독 인보이스', '해외 결제 카드 명세(영세율·대리납부 확인)'],
    원천세: ['프리랜서 사업소득 3.3% 원천징수 내역', '외주 용역 계약서와 지급 내역'],
    법인세: ['프로젝트별 매출·원가 집계표', '연구·인력개발비 명세(세액공제 대상)'],
    종합소득세: ['프로젝트별 매출·원가 집계표', '연구·인력개발비 명세(세액공제 대상)'],
  },
}

const commonPreparation: Readonly<Record<TaxKind, readonly string[]>> = {
  부가가치세: ['매출 세금계산서·계산서', '매입 세금계산서·계산서', '신용카드 매출·매입 집계', '현금영수증 발행 내역'],
  원천세: ['급여대장', '원천징수이행상황신고서', '4대보험 공제 내역', '사업·기타소득 지급 내역'],
  법인세: ['재무제표(재무상태표·손익계산서)', '합계잔액시산표', '고정자산·감가상각 명세', '접대비·기부금 증빙'],
  종합소득세: ['수입금액 명세', '필요경비 증빙', '소득·세액공제 증빙(보험료·의료비 등)'],
  지급명세서: ['근로·퇴직소득 지급명세서', '사업·기타소득 지급명세서', '연말정산 결과 자료'],
  '4대보험': ['전년도 보수총액 집계', '입·퇴사자 명단', '보수총액 신고서'],
  사업장현황신고: ['수입금액 검토표', '매출 계산서 합계표', '매입처별 세금계산서 합계표'],
}

function preparationFor(kind: TaxKind, industryType?: string | null): string[] {
  const industry: TaxIndustryType | null = industryType === 'it_services' ? 'it_services' : industryType === 'food_manufacturing' ? 'food_manufacturing' : null
  const extra = industry ? industryPreparation[industry][kind] ?? [] : []
  return [...commonPreparation[kind], ...extra]
}

function vatSchedules(profile: TaxProfile, year: number, industryType?: string | null) {
  if (profile.vatType === 'exempt') return []
  const source = { sourceLabel: '국세청 부가가치세 신고 안내', sourceUrl: NTS_VAT_URL, evidenceBucket: '신고·납부' as const, preparation: preparationFor('부가가치세', industryType) }
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

function withholdingSchedules(profile: TaxProfile, year: number, industryType?: string | null) {
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
    evidenceBucket: '급여', preparation: preparationFor('원천세', industryType),
    sourceLabel: `${year} 국세청 세무일정`, sourceUrl: NTS_YEAR_CALENDAR_URL(year),
  }))
}

/** 급여를 지급하는 사업장의 연 1회 정산 일정: 지급명세서 제출과 4대보험 보수총액 신고. */
function payrollAnnualSchedules(profile: TaxProfile, year: number, industryType?: string | null) {
  if (!profile.hasPayroll) return []
  return [
    scheduleItem(year, 'payment-statement', {
      kind: '지급명세서', title: `${year - 1}년 귀속 지급명세서 제출`, dueDate: rollTaxDeadline(dateKey(year, 3, 10)),
      description: '연말정산을 마친 근로·퇴직소득과 사업·기타소득 지급명세서를 함께 제출합니다.',
      appliesTo: '급여·용역 대가를 지급한 원천징수의무자', evidenceBucket: '급여',
      preparation: preparationFor('지급명세서', industryType),
      sourceLabel: `${year} 국세청 세무일정`, sourceUrl: NTS_YEAR_CALENDAR_URL(year),
    }),
    scheduleItem(year, 'social-insurance', {
      kind: '4대보험', title: `${year - 1}년 보수총액 신고`, dueDate: rollTaxDeadline(dateKey(year, 3, 10)),
      description: '건강보험 보수총액은 3월 10일, 고용·산재 보수총액은 3월 15일까지 신고합니다. 먼저 오는 기한에 맞춰 준비하세요.',
      appliesTo: '4대보험 사업장 가입 사업장', evidenceBucket: '급여',
      preparation: preparationFor('4대보험', industryType),
      sourceLabel: '4대사회보험 정보연계센터', sourceUrl: SOCIAL_INSURANCE_URL,
    }),
  ]
}

/** 면세사업자의 사업장현황신고 (부가가치세 신고 대신 매년 2월 10일). */
function exemptBusinessSchedules(profile: TaxProfile, year: number, industryType?: string | null) {
  if (profile.vatType !== 'exempt') return []
  return [scheduleItem(year, 'exempt-status-report', {
    kind: '사업장현황신고', title: `${year - 1}년 사업장현황신고`, dueDate: rollTaxDeadline(dateKey(year, 2, 10)),
    description: '부가가치세가 면세되는 사업자는 직전 연도 수입금액과 계산서 합계표를 사업장현황신고로 제출합니다.',
    appliesTo: '부가가치세 면세사업자', evidenceBucket: '신고·납부',
    preparation: preparationFor('사업장현황신고', industryType),
    sourceLabel: `${year} 국세청 세무일정`, sourceUrl: NTS_YEAR_CALENDAR_URL(year),
  })]
}

function annualIncomeSchedules(profile: TaxProfile, year: number, industryType?: string | null) {
  if (profile.entityType === 'individual') {
    return [
      scheduleItem(year, 'income-tax', {
        kind: '종합소득세', title: `${year - 1}년 귀속 종합소득세 신고·납부`, dueDate: rollTaxDeadline(dateKey(year, 5, 31)),
        description: '사업소득과 필요경비, 소득공제·세액공제 증빙을 모아 연간 신고를 준비합니다.',
        appliesTo: '종합소득이 있는 개인사업자', evidenceBucket: '신고·납부',
        preparation: preparationFor('종합소득세', industryType),
        sourceLabel: '국세청 종합소득세 안내', sourceUrl: NTS_INCOME_TAX_URL,
      }),
      scheduleItem(year, 'income-interim', {
        kind: '종합소득세', title: `${year}년 종합소득세 중간예납`, dueDate: rollTaxDeadline(dateKey(year, 11, 30)),
        description: '직전 연도 실적으로 고지된 중간예납세액을 납부합니다. 실적이 크게 줄었다면 추계액 신고를 검토하세요.',
        appliesTo: '종합소득세 중간예납 고지 대상 개인사업자', evidenceBucket: '신고·납부',
        preparation: preparationFor('종합소득세', industryType),
        sourceLabel: '국세청 종합소득세 안내', sourceUrl: NTS_INCOME_TAX_URL,
      }),
    ]
  }
  const closingMonth = Math.min(12, Math.max(1, Math.trunc(profile.fiscalYearEndMonth || 12)))
  const dueMonth = ((closingMonth + 2) % 12) + 1
  const closingYear = dueMonth <= closingMonth ? year - 1 : year
  const dueYear = closingYear + (dueMonth <= closingMonth ? 1 : 0)
  // 중간예납: 사업연도 개시일부터 6개월을 중간예납기간으로 하고 그 종료일부터 2개월 이내 신고·납부한다.
  const interimDueMonth = ((closingMonth + 7) % 12) + 1
  const interimPeriodEndMonth = ((interimDueMonth - 3 + 12) % 12) + 1
  const interimPeriodEndYear = interimPeriodEndMonth < interimDueMonth ? year : year - 1
  const interimStartMonth = ((interimPeriodEndMonth - 6 + 12) % 12) + 1
  const interimStartYear = interimStartMonth <= interimPeriodEndMonth ? interimPeriodEndYear : interimPeriodEndYear - 1
  return [
    scheduleItem(year, 'corporate-tax', {
      kind: '법인세', title: `${closingYear}사업연도 법인세 신고·납부`, dueDate: rollTaxDeadline(dateKey(dueYear, dueMonth, endOfMonth(dueYear, dueMonth))),
      description: `결산월(${closingMonth}월) 말일부터 3개월 이내 신고 기준입니다. 재무제표·세무조정 자료와 납부서를 함께 보관합니다.`,
      appliesTo: `${closingMonth}월 결산 법인`, evidenceBucket: '신고·납부',
      preparation: preparationFor('법인세', industryType),
      sourceLabel: '국세청 법인세 신고기한 안내', sourceUrl: NTS_CORPORATE_TAX_URL,
    }),
    scheduleItem(year, 'corporate-interim', {
      kind: '법인세', title: `${interimStartYear}사업연도 법인세 중간예납`, dueDate: rollTaxDeadline(dateKey(year, interimDueMonth, endOfMonth(year, interimDueMonth))),
      description: `사업연도 개시 후 6개월(${interimStartMonth}월~${interimPeriodEndMonth}월)에 대한 중간예납입니다. 직전 사업연도 산출세액 기준과 가결산 기준 중 유리한 방법을 세무사와 확인하세요.`,
      appliesTo: `${closingMonth}월 결산 법인`, evidenceBucket: '신고·납부',
      preparation: preparationFor('법인세', industryType),
      sourceLabel: '국세청 법인세 신고기한 안내', sourceUrl: NTS_CORPORATE_TAX_URL,
    }),
  ]
}

export function buildProvidedTaxSchedule(profile: TaxProfile, year: number, industryType?: string | null): ProvidedTaxSchedule[] {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return []
  return [
    ...annualIncomeSchedules(profile, year, industryType),
    ...vatSchedules(profile, year, industryType),
    ...exemptBusinessSchedules(profile, year, industryType),
    ...withholdingSchedules(profile, year, industryType),
    ...payrollAnnualSchedules(profile, year, industryType),
  ].sort((left, right) => left.dueDate.localeCompare(right.dueDate) || left.id.localeCompare(right.id))
}

/** 오늘 이후로 아직 남은 일정. 신규 고객사도 첫 화면에서 "남은 일정"을 바로 본다. */
export function remainingTaxSchedule(schedule: readonly ProvidedTaxSchedule[], today: string) {
  return schedule.filter((item) => item.dueDate >= today)
}

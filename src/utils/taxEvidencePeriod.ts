/**
 * 세무사 전달용 증빙 기간. 사용자는 목록에서 기간 하나만 고르고, 실제 시작·종료일은 여기서 만든다.
 * 서버(server/tax-evidence-export.mjs)에도 같은 규칙이 있으므로 함께 바꾼다.
 */
export type TaxPeriodPreset =
  | 'year' | 'h1' | 'h2'
  | 'q1' | 'q2' | 'q3' | 'q4'
  | 'm01' | 'm02' | 'm03' | 'm04' | 'm05' | 'm06'
  | 'm07' | 'm08' | 'm09' | 'm10' | 'm11' | 'm12'

export type TaxPeriodRange = { from: string; to: string; label: string }

const MONTH_PRESETS = Array.from({ length: 12 }, (_, index) => `m${String(index + 1).padStart(2, '0')}` as TaxPeriodPreset)

export const TAX_PERIOD_PRESETS: readonly TaxPeriodPreset[] = ['year', 'h1', 'h2', 'q1', 'q2', 'q3', 'q4', ...MONTH_PRESETS]

const RANGE_MONTHS: Readonly<Record<string, [number, number]>> = {
  year: [1, 12], h1: [1, 6], h2: [7, 12], q1: [1, 3], q2: [4, 6], q3: [7, 9], q4: [10, 12],
}

const RANGE_LABELS: Readonly<Record<string, string>> = {
  year: '한 해 전체', h1: '상반기 (1~6월)', h2: '하반기 (7~12월)',
  q1: '1분기 (1~3월)', q2: '2분기 (4~6월)', q3: '3분기 (7~9월)', q4: '4분기 (10~12월)',
}

function lastDayOfMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

export function isTaxPeriodPreset(value: unknown): value is TaxPeriodPreset {
  return typeof value === 'string' && TAX_PERIOD_PRESETS.includes(value as TaxPeriodPreset)
}

export function taxPeriodRange(preset: TaxPeriodPreset, year: number): TaxPeriodRange {
  const months = RANGE_MONTHS[preset]
  const [startMonth, endMonth] = months ?? [Number(preset.slice(1)), Number(preset.slice(1))]
  const pad = (value: number) => String(value).padStart(2, '0')
  return {
    from: `${year}-${pad(startMonth)}-01`,
    to: `${year}-${pad(endMonth)}-${pad(lastDayOfMonth(year, endMonth))}`,
    label: months ? `${year}년 ${RANGE_LABELS[preset]}` : `${year}년 ${startMonth}월`,
  }
}

export function taxPeriodOptions(year: number) {
  return TAX_PERIOD_PRESETS.map((preset) => ({ preset, ...taxPeriodRange(preset, year) }))
}

/** 증빙 파일의 귀속일. 업로드할 때 붙인 tax-date 태그가 우선이고, 없으면 연도 태그·업로드 시각을 쓴다. */
export function evidenceDateOf(document: { tags?: string[]; uploadedAt?: string }, fallbackDate: string) {
  const tags = Array.isArray(document.tags) ? document.tags : []
  const tagged = tags.find((tag) => tag.startsWith('tax-date:'))?.slice('tax-date:'.length) ?? ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(tagged)) return tagged
  const taggedYear = tags.find((tag) => tag.startsWith('tax-year:'))?.slice('tax-year:'.length) ?? ''
  if (/^\d{4}$/.test(taggedYear) && fallbackDate.slice(0, 4) !== taggedYear) return `${taggedYear}-12-31`
  return fallbackDate
}

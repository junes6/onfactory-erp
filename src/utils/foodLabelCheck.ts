/**
 * 식품 표시사항 필수항목 점검 — 규칙이다. AI가 아니다.
 *
 * 이 점검이 하는 일은 딱 하나다: 표시에 꼭 들어가야 하는 칸 7개가 채워졌는지(바코드는 숫자 13자리인지) 센다.
 * 문구가 법 기준에 맞는지, 알레르기 유발물질이 빠졌는지는 **보지 않는다** — 그것을 확인한 것처럼 보이는
 * 칸이나 점수를 화면에 두지 않는다. 전에는 칸 네 개가 고정 배열이라 원재료가 비어도 '내부 기준과 일치'가 떴고,
 * 검사하지도 않는 알레르기 칸에만 경고가 붙었으며, `100 - 문제 수 × 11`(최저 45) 공식을 'AI 점수'라고 불렀다.
 */

export type LabelCheckInput = {
  name: string
  storage: string
  fact: {
    foodType: string
    ingredients: string
    origin: string
    shelfLife: string
    barcode: string
    labelIssue?: string
  }
}

export type LabelFieldId = 'name' | 'foodType' | 'ingredients' | 'origin' | 'shelfLife' | 'storage' | 'barcode'

export type LabelCheckItem = {
  id: LabelFieldId
  label: string
  ok: boolean
  /** 칸 아래 한 줄. 채워졌으면 '입력됨', 아니면 무엇이 문제인지. */
  note: string
  /** 목록·이력에 남기는 문장. 채워졌으면 빈 문자열. */
  message: string
}

type FieldRule = { id: LabelFieldId; label: string; missing: string; short: string; read: (input: LabelCheckInput) => string; valid?: (value: string) => boolean }

const FIELD_RULES: FieldRule[] = [
  { id: 'name', label: '제품명', missing: '제품명이 비어 있습니다.', short: '비어 있음', read: (input) => input.name },
  { id: 'foodType', label: '식품유형', missing: '식품유형을 입력해 주세요.', short: '비어 있음', read: (input) => input.fact.foodType },
  { id: 'ingredients', label: '원재료명·함량', missing: '원재료명과 함량을 입력해 주세요.', short: '비어 있음', read: (input) => input.fact.ingredients },
  { id: 'origin', label: '원산지', missing: '원산지 표시를 입력해 주세요.', short: '비어 있음', read: (input) => input.fact.origin },
  { id: 'shelfLife', label: '소비기한', missing: '소비기한 표시 기준을 입력해 주세요.', short: '비어 있음', read: (input) => input.fact.shelfLife },
  { id: 'storage', label: '보관방법', missing: '보관방법을 입력해 주세요.', short: '비어 있음', read: (input) => input.storage },
  { id: 'barcode', label: '바코드', missing: '바코드는 숫자 13자리로 입력해 주세요.', short: '숫자 13자리가 아님', read: (input) => input.fact.barcode, valid: (value) => /^\d{13}$/.test(value) },
]

export const LABEL_REQUIRED_COUNT = FIELD_RULES.length

/**
 * 예전 검증이 사람의 메모 칸(labelIssue)에 **자기 문장**을 덮어써 두었다.
 * 그 문장이 남아 있으면 칸을 채운 뒤에도 같은 문제가 영영 '열린 메모'로 세어졌다 — 사람이 쓴 말이 아니므로 무시한다.
 */
const SYSTEM_MEMO_SENTENCES = new Set([
  '표시정보를 입력한 뒤 검증을 실행해 주세요.',
  '현재 확인된 수정 항목이 없습니다.',
  ...FIELD_RULES.map((rule) => rule.missing),
])

/** 메모가 '문제 없음'을 뜻하는 말. 입력칸 안내문이 권하는 '수정 항목 없음'도 여기 든다(전에는 이 말 자체가 문제로 세어졌다). */
const MEMO_CLEAR_PATTERN = /(수정 항목 없음|이상 없음|해당 없음|없습니다)/

const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''

export function checkLabelFields(input: LabelCheckInput): LabelCheckItem[] {
  return FIELD_RULES.map((rule) => {
    const value = text(rule.read(input))
    const ok = rule.valid ? rule.valid(value) : value.length > 0
    return { id: rule.id, label: rule.label, ok, note: ok ? '입력됨' : rule.short, message: ok ? '' : rule.missing }
  })
}

/** 표시 검토 담당자가 적어 둔, 아직 풀리지 않은 메모. 없으면 빈 문자열. */
export function openLabelMemo(input: LabelCheckInput): string {
  const memo = text(input.fact.labelIssue)
  if (!memo || SYSTEM_MEMO_SENTENCES.has(memo) || MEMO_CLEAR_PATTERN.test(memo)) return ''
  return memo
}

/** 빠진 필수항목 문장 + 열린 담당자 메모. 검토 이력에 그대로 남는다. */
export function collectLabelIssues(input: LabelCheckInput): string[] {
  const issues = checkLabelFields(input).filter((item) => !item.ok).map((item) => item.message)
  const memo = openLabelMemo(input)
  if (memo) issues.push(memo)
  return Array.from(new Set(issues))
}

export type LabelSummary = {
  filled: number
  total: number
  missing: number
  memo: string
  complete: boolean
  /** 목록·배지에 쓰는 짧은 말. '승인'이라고 부르지 않는다 — 사람이 승인한 것이 아니다. */
  label: string
  /** 상단 한 줄. */
  headline: string
}

export function summarizeLabel(input: LabelCheckInput): LabelSummary {
  const checks = checkLabelFields(input)
  const filled = checks.filter((item) => item.ok).length
  const total = checks.length
  const missing = total - filled
  const memo = openLabelMemo(input)
  const complete = missing === 0 && !memo
  const label = missing > 0 ? `빠진 항목 ${missing}개` : memo ? '담당자 메모 확인' : '필수항목 채움'
  const headline = missing > 0
    ? `표시 필수항목 ${total}개 중 ${missing}개가 비어 있거나 형식이 맞지 않습니다.`
    : memo
      ? `필수항목 ${total}개는 채워졌고, 담당자가 남긴 메모가 있습니다.`
      : `표시 필수항목 ${total}개가 모두 채워져 있습니다.`
  return { filled, total, missing, memo, complete, label, headline }
}

/**
 * 저장용 표시 상태. 저장값의 이름('승인')은 홈 화면 점검 목록이 읽는 기존 계약이라 그대로 두되,
 * 뜻은 '필수항목이 다 채워졌고 열린 메모가 없다'뿐이다. 화면에는 summarizeLabel().label을 쓴다.
 */
export function storedLabelStatus(input: LabelCheckInput): '승인' | '수정필요' {
  return collectLabelIssues(input).length === 0 ? '승인' : '수정필요'
}

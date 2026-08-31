/**
 * 기회 관련성 판정 — 순수 함수.
 *
 * 공고 목록을 마감순으로만 주면 "우리와 상관없는 공고"가 맨 위에 온다.
 * 여기서는 고객사가 이미 등록한 감시 설정(키워드·지역·금액 하한)과 업종을 프로필로 삼아
 * 공고 한 건마다 관련성 점수를 매기고, **왜 그 점수인지를 사람이 읽을 수 있는 근거로 함께 돌려준다.**
 * 점수만 보여 주고 근거를 감추면 사용자는 정렬을 신뢰할 수 없다(DECISIONS §3.4 파생 규칙 원칙).
 */

/** 신호별 가중치. 합이 1을 넘어도 되며 최종 점수는 1로 자른다. */
export const RELEVANCE_WEIGHTS = Object.freeze({
  titleKeyword: 0.45,
  bodyKeyword: 0.2,
  region: 0.15,
  industryKeyword: 0.12,
  amountFit: 0.08,
})

/** 업종 모듈이 주는 보조 키워드. 고객사가 등록한 키워드가 우선이고 이건 배경 신호다. */
export const INDUSTRY_HINT_KEYWORDS = Object.freeze({
  food_manufacturing: ['식품', '급식', '수산', '가공', '위생', 'HACCP', '제조', '농식품'],
  it_services: ['소프트웨어', 'SW', '콘텐츠', '시스템', '플랫폼', '디지털', 'IT', '정보화', '용역'],
})

const normalize = (value) => String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim()

/** 한국어는 형태소 경계가 없으므로 부분 문자열 포함으로 본다. 2자 미만은 오탐이 많아 버린다. */
function matches(haystack, term) {
  const needle = normalize(term)
  if (needle.length < 2) return false
  return haystack.includes(needle)
}

function uniqueMatches(haystack, terms) {
  const hits = []
  for (const term of terms ?? []) {
    if (!matches(haystack, term)) continue
    const label = String(term).trim()
    if (!hits.includes(label)) hits.push(label)
  }
  return hits
}

/**
 * 고객사 프로필로 공고 한 건을 채점한다.
 * @returns {{score:number, reasons:string[], matchedKeywords:string[], signals:object}}
 */
export function scoreOpportunity(item, profile = {}) {
  const keywords = Array.isArray(profile.keywords) ? profile.keywords : []
  const regions = Array.isArray(profile.regions) ? profile.regions : []
  const minAmount = Number.isFinite(profile.minAmount) && profile.minAmount > 0 ? profile.minAmount : 0
  const hintKeywords = INDUSTRY_HINT_KEYWORDS[profile.industryType] ?? []

  const title = normalize(item?.title)
  const body = normalize([item?.summary, item?.target, item?.category, item?.agency, item?.operator].filter(Boolean).join(' '))
  const region = normalize([item?.region, item?.agency, item?.operator].filter(Boolean).join(' '))
  const amount = Number.isFinite(item?.amount) && item.amount > 0 ? item.amount : 0

  const titleHits = uniqueMatches(title, keywords)
  const bodyHits = uniqueMatches(body, keywords).filter((term) => !titleHits.includes(term))
  const regionHits = uniqueMatches(region, regions)
  // 업종 힌트는 고객사 키워드가 이미 맞은 건에는 더하지 않는다. 같은 근거를 두 번 세지 않기 위해서다.
  const industryHits = titleHits.length || bodyHits.length ? [] : uniqueMatches(`${title} ${body}`, hintKeywords)

  const signals = {
    titleKeyword: titleHits.length > 0,
    bodyKeyword: bodyHits.length > 0,
    region: regionHits.length > 0,
    industryKeyword: industryHits.length > 0,
    amountFit: minAmount > 0 && amount > 0 && amount >= minAmount,
  }

  let score = 0
  if (signals.titleKeyword) score += RELEVANCE_WEIGHTS.titleKeyword
  if (signals.bodyKeyword) score += RELEVANCE_WEIGHTS.bodyKeyword
  if (signals.region) score += RELEVANCE_WEIGHTS.region
  if (signals.industryKeyword) score += RELEVANCE_WEIGHTS.industryKeyword
  if (signals.amountFit) score += RELEVANCE_WEIGHTS.amountFit
  // 하한을 정해 뒀는데 금액이 그보다 작으면 관련성을 깎는다. 목록에서 지우지는 않는다.
  if (minAmount > 0 && amount > 0 && amount < minAmount) score -= RELEVANCE_WEIGHTS.amountFit

  const reasons = []
  if (titleHits.length) reasons.push(`제목에 감시 키워드 ${titleHits.map((term) => `'${term}'`).join(' · ')} 일치`)
  if (bodyHits.length) reasons.push(`내용에 감시 키워드 ${bodyHits.map((term) => `'${term}'`).join(' · ')} 일치`)
  if (regionHits.length) reasons.push(`관심 지역 ${regionHits.join(' · ')} 관련`)
  if (industryHits.length) reasons.push(`업종 연관어 ${industryHits.slice(0, 3).join(' · ')} 포함`)
  if (signals.amountFit) reasons.push(`지원 규모가 하한 ${minAmount.toLocaleString('ko-KR')}원 이상`)
  if (minAmount > 0 && amount > 0 && amount < minAmount) reasons.push(`지원 규모가 하한 ${minAmount.toLocaleString('ko-KR')}원 미만`)
  if (!reasons.length) reasons.push('일치하는 감시 조건이 없습니다')

  return {
    score: Math.max(0, Math.min(1, Math.round(score * 1000) / 1000)),
    reasons,
    matchedKeywords: [...titleHits, ...bodyHits],
    signals,
  }
}

/** 마감까지 남은 일수. 마감이 없으면 null. */
export function daysToDeadline(endsOn, todayKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(endsOn ?? ''))) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(todayKey ?? ''))) return null
  return Math.round((Date.parse(`${endsOn}T00:00:00Z`) - Date.parse(`${todayKey}T00:00:00Z`)) / 86_400_000)
}

/**
 * 공고 목록에 관련성을 붙이고 정렬한다.
 * - recommended: 관련성 높은 순 → 마감 임박 순 → 제목
 * - deadline: 마감 임박 순 (마감 없는 건은 뒤로)
 * 마감이 지난 건은 어느 정렬에서도 뒤로 보낸다.
 */
export function rankOpportunities(items, { profile = {}, sort = 'recommended', todayKey = '' } = {}) {
  const ranked = (items ?? []).map((item) => {
    const relevance = scoreOpportunity(item, profile)
    const days = daysToDeadline(item?.endsOn, todayKey)
    return { ...item, relevance: { ...relevance, daysToDeadline: days, closed: days !== null && days < 0 } }
  })

  const deadlineRank = (entry) => {
    const days = entry.relevance.daysToDeadline
    if (days === null) return Number.MAX_SAFE_INTEGER - 1
    if (days < 0) return Number.MAX_SAFE_INTEGER
    return days
  }

  return ranked.sort((left, right) => {
    if (left.relevance.closed !== right.relevance.closed) return left.relevance.closed ? 1 : -1
    if (sort === 'recommended' && right.relevance.score !== left.relevance.score) return right.relevance.score - left.relevance.score
    const byDeadline = deadlineRank(left) - deadlineRank(right)
    if (byDeadline) return byDeadline
    if (sort !== 'recommended' && right.relevance.score !== left.relevance.score) return right.relevance.score - left.relevance.score
    return String(left.title ?? '').localeCompare(String(right.title ?? ''), 'ko')
  })
}

/** 대시보드 상단 요약. 목록을 열지 않고도 "지금 무엇이 급한가"를 알 수 있어야 한다. */
export function opportunitySummary(rankedItems, { recommendedThreshold = 0.4, closingWithinDays = 7 } = {}) {
  const open = (rankedItems ?? []).filter((item) => !item.relevance?.closed)
  const closingSoon = open.filter((item) => {
    const days = item.relevance?.daysToDeadline
    return days !== null && days !== undefined && days <= closingWithinDays
  })
  const recommended = open.filter((item) => (item.relevance?.score ?? 0) >= recommendedThreshold)
  return {
    total: (rankedItems ?? []).length,
    open: open.length,
    closed: (rankedItems ?? []).length - open.length,
    closingSoon: closingSoon.length,
    recommended: recommended.length,
    top: recommended[0] ?? open[0] ?? null,
  }
}

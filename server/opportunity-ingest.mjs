import { randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * 외부 기회 신호(입찰·지원사업) 인제스트.
 * 수집·판정 엔진은 이 저장소 밖의 워커가 담당한다. 여기서는 워커가 밀어넣은 결과를
 * 받아 검증하고, 테넌트 임계값을 넘은 건만 기존 승인 큐에 제안으로 올린다.
 */
export const OPPORTUNITIES_KEY = 'opportunities'
export const OPPORTUNITY_SETTINGS_KEY = 'opportunity-settings'
export const MAX_OPPORTUNITIES = 500
const MAX_BATCH = 50

/** 업종 모듈이 주는 초기 감시 키워드. 테넌트가 바꾸면 그 값이 우선한다. */
export const DEFAULT_WATCH_KEYWORDS = Object.freeze({
  food_manufacturing: ['급식', '수산물 납품', '식품 R&D'],
  it_services: ['콘텐츠', '소프트웨어 개발 용역', '안전교육'],
})
export const DEFAULT_SCORE_THRESHOLD = 0.6

export class OpportunityIngestError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'OpportunityIngestError'
    this.code = code
    this.status = status
  }
}

function plainText(value, maxLength = 200) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

function isoDate(value) {
  const candidate = plainText(value, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return ''
  const [year, month, day] = candidate.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (year < 2000 || year > 2100) return ''
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day ? candidate : ''
}

function httpsLink(value) {
  const candidate = plainText(value, 500)
  if (!/^https?:\/\/[^\s]+$/i.test(candidate)) return ''
  return candidate
}

function score(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 1 ? Math.round(numeric * 1000) / 1000 : null
}

/** 서버 간 토큰 비교. 길이 노출을 막기 위해 해시 없이 고정 길이 비교를 쓴다. */
export function ingestTokenMatches(expected, provided) {
  const left = Buffer.from(String(expected ?? ''), 'utf8')
  const right = Buffer.from(String(provided ?? ''), 'utf8')
  if (!left.length || left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export function defaultOpportunitySettings(industryType) {
  const keywords = DEFAULT_WATCH_KEYWORDS[industryType] ?? DEFAULT_WATCH_KEYWORDS.food_manufacturing
  return {
    keywords: [...keywords],
    regions: [],
    minAmount: 0,
    scoreThreshold: DEFAULT_SCORE_THRESHOLD,
    updatedAt: '',
    updatedBy: '',
  }
}

export function normalizeOpportunitySettings(value, industryType) {
  const base = defaultOpportunitySettings(industryType)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return base
  const list = (input, max, limit) => Array.isArray(input)
    ? [...new Set(input.map((item) => plainText(item, max)).filter(Boolean))].slice(0, limit)
    : null
  const keywords = list(value.keywords, 40, 30)
  const regions = list(value.regions, 30, 20)
  const minAmount = Number(value.minAmount)
  const threshold = Number(value.scoreThreshold)
  return {
    // 키워드를 통째로 비우는 것도 사용자의 선택이므로 존중한다 (없으면 업종 기본값).
    keywords: keywords ?? base.keywords,
    regions: regions ?? base.regions,
    minAmount: Number.isFinite(minAmount) && minAmount >= 0 ? Math.min(Math.round(minAmount), 1_000_000_000_000) : base.minAmount,
    scoreThreshold: Number.isFinite(threshold) && threshold >= 0 && threshold <= 1 ? Math.round(threshold * 100) / 100 : base.scoreThreshold,
    updatedAt: plainText(value.updatedAt, 40),
    updatedBy: plainText(value.updatedBy, 80),
  }
}

/** 워커가 보낸 한 건을 저장 가능한 모양으로 검증한다. 필수는 공고번호·제목·대상 테넌트다. */
export function normalizeIngestItem(value) {
  const noticeNo = plainText(value?.noticeNo ?? value?.notice_no, 80)
  const title = plainText(value?.title, 200)
  const tenantId = plainText(value?.tenantId ?? value?.tenant_id, 80)
  if (!noticeNo || !title || !tenantId) {
    throw new OpportunityIngestError('INVALID_OPPORTUNITY', '공고번호 · 제목 · 대상 테넌트는 필수입니다.')
  }
  const amount = Number(value?.amount)
  return {
    noticeNo,
    title,
    tenantId,
    source: plainText(value?.source, 40) || '외부',
    agency: plainText(value?.agency, 120),
    deadline: isoDate(value?.deadline),
    amount: Number.isFinite(amount) && amount >= 0 ? Math.min(Math.round(amount), 1_000_000_000_000) : 0,
    link: httpsLink(value?.link ?? value?.url),
    score: score(value?.score),
    rationale: plainText(value?.rationale ?? value?.reason, 500),
  }
}

export function normalizeIngestBatch(body) {
  const items = Array.isArray(body?.opportunities) ? body.opportunities : Array.isArray(body) ? body : [body]
  if (!items.length) throw new OpportunityIngestError('INVALID_OPPORTUNITY', '보낼 기회 건이 없습니다.')
  if (items.length > MAX_BATCH) throw new OpportunityIngestError('OPPORTUNITY_BATCH_TOO_LARGE', `한 번에 ${MAX_BATCH}건까지 보낼 수 있습니다.`, 413)
  const normalized = items.map(normalizeIngestItem)
  const seen = new Set()
  return normalized.filter((item) => {
    const key = `${item.tenantId}:${item.source}:${item.noticeNo}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export const opportunityKey = (item) => `${item.source}:${item.noticeNo}`

export function newOpportunityId() {
  return `OPP-${Date.now()}-${randomBytes(3).toString('hex')}`
}

/**
 * 임계값 판정: 점수가 없거나 임계 미만이면 목록에만 남기고 승인 큐에는 올리지 않는다.
 * 금액 하한도 같은 규칙으로 본다 (하한 미만이면 목록에만).
 */
export function opportunityStatusFor(item, settings) {
  if (item.score === null) return 'below-threshold'
  if (item.score < settings.scoreThreshold) return 'below-threshold'
  if (settings.minAmount > 0 && item.amount > 0 && item.amount < settings.minAmount) return 'below-threshold'
  return 'queued'
}

export function opportunityRecord(item, settings, receivedAt) {
  return {
    id: newOpportunityId(),
    key: opportunityKey(item),
    source: item.source,
    noticeNo: item.noticeNo,
    title: item.title,
    agency: item.agency,
    deadline: item.deadline,
    amount: item.amount,
    link: item.link,
    score: item.score,
    rationale: item.rationale,
    status: opportunityStatusFor(item, settings),
    receivedAt,
  }
}

/** 승인 큐에 올릴 제안. 승인하면 기존 흐름대로 검토 업무가 만들어진다. */
export function opportunityProposal(record, { now, proposalId }) {
  const detail = [
    record.agency && `기관 ${record.agency}`,
    record.deadline && `마감 ${record.deadline}`,
    record.amount > 0 && `금액 ${record.amount.toLocaleString('ko-KR')}원`,
  ].filter(Boolean).join(' · ')
  return {
    id: proposalId,
    kind: 'opportunity',
    status: 'pending',
    confidence: record.score,
    sourceKey: `opportunity:${record.key}`,
    summary: `${record.title} 검토`,
    evidence: [detail, record.rationale, record.link].filter(Boolean).join('\n'),
    payload: {
      title: `${record.title} 검토`,
      description: [detail, record.rationale, record.link && `공고 링크: ${record.link}`].filter(Boolean).join('\n'),
      // 마감 3일 전을 검토 기한으로 둔다. 마감이 없으면 결정 라우트의 기본값(+2일)을 쓴다.
      due: record.deadline ? new Date(Date.parse(`${record.deadline}T09:00:00+09:00`) - 3 * 24 * 60 * 60 * 1_000).toISOString() : '',
      priority: '보통',
      category: '외부 기회',
      opportunityId: record.id,
      noticeNo: record.noticeNo,
      source: record.source,
      link: record.link,
    },
    createdAt: now,
    createdBy: 'opportunity-ingest',
  }
}

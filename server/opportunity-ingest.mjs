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

/**
 * 판정 점수는 두 스케일을 모두 받는다. 워커마다 0~1 비율과 0~100 백분율을 섞어 쓰기 때문에
 * 한쪽만 받으면 88점짜리 공고가 조용히 "점수 없음"으로 떨어진다.
 * 1을 넘는 값은 백분율로 보고 100으로 나눈다. 1 이하는 그대로 비율이다
 * (1은 비율 만점 1.0으로 읽는다. 백분율 1%로 해석하지 않는다).
 * 100을 넘는 값은 어느 스케일로도 성립하지 않으므로 점수 없음으로 둔다.
 */
export function normalizeScore(value) {
  if (value === null || value === undefined || value === '') return null
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) return null
  const scale = numeric > 1 ? 'percent' : 'ratio'
  const confidence = scale === 'percent' ? numeric / 100 : numeric
  if (confidence > 1) return null
  return { confidence: Math.round(confidence * 1000) / 1000, scale, raw: numeric }
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

export const ELIGIBILITY_VERDICTS = Object.freeze(['eligible', 'ineligible', 'unclear'])

/**
 * 워커의 자격 판정. 셋 중 하나이며 근거 문장이 반드시 함께 온다.
 * 근거 없는 판정은 신뢰할 수 없으므로 판정만 있고 근거가 없으면 통째로 버린다.
 */
function normalizeEligibility(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const verdict = plainText(value.verdict, 20)
  if (!ELIGIBILITY_VERDICTS.includes(verdict)) return null
  const reasons = Array.isArray(value.reasons)
    ? value.reasons.map((reason) => plainText(reason, 200)).filter(Boolean).slice(0, 10)
    : []
  if (!reasons.length) return null
  const unmet = Array.isArray(value.unmet) ? value.unmet.map((item) => plainText(item, 120)).filter(Boolean).slice(0, 10) : []
  return { verdict, reasons, unmet }
}

/** 제출 서류 체크리스트. 보유·미보유·갱신 필요 세 상태와 충족률. */
function normalizeDocumentChecklist(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const items = Array.isArray(value.items) ? value.items : []
  const rows = items.map((item) => {
    const name = plainText(item?.name, 120)
    const state = plainText(item?.state, 20)
    if (!name || !['held', 'missing', 'renew'].includes(state)) return null
    return { name, state, note: plainText(item?.note, 160), documentId: plainText(item?.documentId, 120) }
  }).filter(Boolean).slice(0, 40)
  if (!rows.length) return null
  const held = rows.filter((row) => row.state === 'held').length
  return { items: rows, held, total: rows.length }
}

/** 초안 문서 참조. 기업 자료실에 올라간 파일을 가리킨다. */
function normalizeDraftRef(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const documentId = plainText(value.documentId, 120)
  const name = plainText(value.name, 160)
  if (!documentId && !name) return null
  return { documentId, name, sections: Math.max(0, Math.min(50, Number(value.sections) || 0)), needsInput: Math.max(0, Math.min(50, Number(value.needsInput) || 0)) }
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
  const scored = normalizeScore(value?.score)
  return {
    noticeNo,
    title,
    tenantId,
    source: plainText(value?.source, 40) || '외부',
    agency: plainText(value?.agency, 120),
    deadline: isoDate(value?.deadline),
    amount: Number.isFinite(amount) && amount >= 0 ? Math.min(Math.round(amount), 1_000_000_000_000) : 0,
    link: httpsLink(value?.link ?? value?.url),
    // score는 언제나 0~1 정규화값이다. 워커가 보낸 원본과 스케일은 판정 근거로 함께 남긴다.
    score: scored?.confidence ?? null,
    scoreScale: scored?.scale ?? null,
    rawScore: scored?.raw ?? null,
    rationale: plainText(value?.rationale ?? value?.reason, 500),
    // P6 워커가 함께 보내는 판정 결과. 없으면 지금까지와 똑같이 동작한다.
    eligibility: normalizeEligibility(value?.eligibility),
    documents: normalizeDocumentChecklist(value?.documents),
    draft: normalizeDraftRef(value?.draft),
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

const amountText = (value) => `${Number(value).toLocaleString('ko-KR')}원`

/**
 * 임계값 판정: 점수가 없거나 임계 미만이면 목록에만 남기고 승인 큐에는 올리지 않는다.
 * 금액 하한도 같은 규칙으로 본다 (하한 미만이면 목록에만).
 * 워커가 "왜 큐에 안 올랐는지"를 알아야 판정 프롬프트를 고칠 수 있으므로 비교 결과를 함께 돌려준다.
 */
export function opportunityVerdict(item, settings) {
  const threshold = Number.isFinite(settings?.scoreThreshold) ? settings.scoreThreshold : DEFAULT_SCORE_THRESHOLD
  const minAmount = Number.isFinite(settings?.minAmount) && settings.minAmount > 0 ? settings.minAmount : 0
  const amount = Number.isFinite(item?.amount) && item.amount > 0 ? item.amount : 0
  const scored = item?.score !== null && item?.score !== undefined
  const thresholdMet = scored && item.score >= threshold
  const amountMet = !(minAmount > 0 && amount > 0 && amount < minAmount)
  const reason = !scored
    ? '판정 점수가 없어 목록에만 남겼습니다.'
    : !thresholdMet
      ? `판정 점수 ${item.score}이(가) 기준 ${threshold} 미만입니다.`
      : !amountMet
        ? `금액 ${amountText(amount)}이(가) 하한 ${amountText(minAmount)} 미만입니다.`
        : `판정 점수 ${item.score}이(가) 기준 ${threshold} 이상입니다.`
  return {
    status: thresholdMet && amountMet ? 'queued' : 'below-threshold',
    threshold,
    minAmount,
    thresholdMet,
    amountMet,
    reason,
  }
}

export function opportunityStatusFor(item, settings) {
  return opportunityVerdict(item, settings).status
}

export function opportunityRecord(item, settings, receivedAt) {
  const verdict = opportunityVerdict(item, settings)
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
    scoreScale: item.scoreScale ?? null,
    rawScore: item.rawScore ?? null,
    rationale: item.rationale,
    eligibility: item.eligibility ?? null,
    documents: item.documents ?? null,
    draft: item.draft ?? null,
    status: verdict.status,
    statusReason: verdict.reason,
    receivedAt,
  }
}

/**
 * 워커에게 돌려줄 건별 처리 결과 한 줄. 큐에 오르지 못한 이유를 스스로 알 수 있어야
 * 판정 프롬프트를 고칠 수 있으므로 정규화 결과와 임계값 비교를 모두 담는다.
 */
export function ingestResultLine(item, { outcome, settings = null, reason = '' }) {
  const verdict = settings ? opportunityVerdict(item, settings) : null
  return {
    tenantId: item.tenantId,
    source: item.source,
    noticeNo: item.noticeNo,
    outcome,
    // 정규화 결과: 워커가 보낸 원본과 스케일 판정, 내부에서 쓰는 0~1 신뢰도.
    rawScore: item.rawScore ?? null,
    scoreScale: item.scoreScale ?? null,
    score: item.score ?? null,
    // 임계값 비교 결과.
    threshold: verdict ? verdict.threshold : null,
    thresholdMet: verdict ? verdict.thresholdMet : null,
    minAmount: verdict ? verdict.minAmount : null,
    amountMet: verdict ? verdict.amountMet : null,
    reason: reason || (verdict ? verdict.reason : ''),
  }
}

const ELIGIBILITY_LABEL = Object.freeze({ eligible: '자격 충족', ineligible: '자격 미달', unclear: '판단 불가' })

/** 카드에서 한 줄로 읽는 자격 판정. 근거를 함께 붙여 점수만 남지 않게 한다. */
function eligibilityLine(record) {
  if (!record.eligibility) return ''
  const { verdict, reasons, unmet } = record.eligibility
  const head = `${ELIGIBILITY_LABEL[verdict] ?? verdict}: ${reasons.slice(0, 2).join(' / ')}`
  return unmet.length ? `${head} · 확인 필요 ${unmet.join(', ')}` : head
}

/** 서류 충족률. "몇 개 중 몇 개를 이미 갖고 있는가"가 지원 여부 판단의 핵심이다. */
function documentLine(record) {
  if (!record.documents) return ''
  const { held, total, items } = record.documents
  const missing = items.filter((item) => item.state !== 'held').map((item) => item.name).slice(0, 3)
  return `제출서류 ${held}/${total} 보유${missing.length ? ` · 준비 필요 ${missing.join(', ')}` : ''}`
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
    evidence: [detail, eligibilityLine(record), documentLine(record), record.rationale, record.link].filter(Boolean).join('\n'),
    payload: {
      title: `${record.title} 검토`,
      description: [
        detail,
        eligibilityLine(record),
        documentLine(record),
        record.rationale,
        record.link && `공고 링크: ${record.link}`,
        record.draft?.name && `신청서 초안: ${record.draft.name}${record.draft.needsInput ? ` (확인 필요 ${record.draft.needsInput}곳)` : ''}`,
      ].filter(Boolean).join('\n'),
      // 마감 3일 전을 검토 기한으로 둔다. 마감이 없으면 결정 라우트의 기본값(+2일)을 쓴다.
      due: record.deadline ? new Date(Date.parse(`${record.deadline}T09:00:00+09:00`) - 3 * 24 * 60 * 60 * 1_000).toISOString() : '',
      priority: '보통',
      category: '외부 기회',
      opportunityId: record.id,
      noticeNo: record.noticeNo,
      source: record.source,
      link: record.link,
      eligibility: record.eligibility ?? null,
      documents: record.documents ?? null,
      draft: record.draft ?? null,
    },
    createdAt: now,
    createdBy: 'opportunity-ingest',
  }
}

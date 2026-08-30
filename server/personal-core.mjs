import { randomBytes } from 'node:crypto'

/**
 * 개인 지식 코어 — 테넌트 격리 "위에" 얹는 계정 소유 계층.
 *
 * 경계: 테넌트 데이터는 그대로 테넌트에 갇혀 있다. 여기에 쌓이는 것은 사람의 판단 기록
 * (규범 카드·노트·교정 이유·모르는 것)뿐이며 소유자는 계정이다. 한 계정이 여러 고객사를
 * 오갈 때 자기 판단 기록은 따라오지만, 다른 계정의 기록은 존재 자체를 조회할 수 없다.
 *
 * 원문이 정본이다. 규범·노트·결정은 자연어 원문으로 저장하고, 요약·임베딩은 언제든
 * 다시 만들 수 있는 파생물로만 다룬다.
 */
export const PRINCIPLE_VALID_DAYS = 180
export const PRINCIPLE_REVIEW_LEAD_DAYS = 30
export const PRINCIPLE_REJECT_COOLDOWN_DAYS = 60
export const PRINCIPLE_MIN_EVIDENCE = 3
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.6
const DAY_MS = 24 * 60 * 60 * 1_000
const MAX_ROWS = 500

export class PersonalCoreError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'PersonalCoreError'
    this.code = code
    this.status = status
  }
}

const text = (value, max = 200) => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max)

const iso = (value) => {
  const parsed = Date.parse(String(value ?? ''))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : ''
}

export const newPersonalId = (prefix) => `${prefix}-${Date.now()}-${randomBytes(3).toString('hex')}`

export function emptyPersonalCore() {
  return { principles: [], notes: [], corrections: [], gaps: [], settings: { confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD } }
}

/** 소유자 격리의 유일한 관문. 이 함수를 거치지 않고 personal 저장소를 읽지 않는다. */
export function personalCoreOf(store, accountId) {
  const owner = text(accountId, 80)
  if (!owner) throw new PersonalCoreError('PERSONAL_OWNER_REQUIRED', '개인 지식 코어는 로그인한 계정만 사용할 수 있습니다.', 401)
  store.personal ??= {}
  store.personal[owner] ??= emptyPersonalCore()
  const core = store.personal[owner]
  core.principles ??= []
  core.notes ??= []
  core.corrections ??= []
  core.gaps ??= []
  core.settings ??= { confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD }
  return core
}

export function normalizeSettings(value) {
  const threshold = Number(value?.confidenceThreshold)
  return {
    confidenceThreshold: Number.isFinite(threshold) && threshold >= 0 && threshold <= 1
      ? Math.round(threshold * 100) / 100
      : DEFAULT_CONFIDENCE_THRESHOLD,
  }
}

// ---------------------------------------------------------------------------
// 규범 카드
// ---------------------------------------------------------------------------

export function principleStatus(principle, now = new Date()) {
  if (principle?.status === 'retired') return 'retired'
  const expires = Date.parse(principle?.expiresAt ?? '')
  if (!Number.isFinite(expires)) return 'active'
  if (expires <= now.getTime()) return 'expired'
  if (expires - now.getTime() <= PRINCIPLE_REVIEW_LEAD_DAYS * DAY_MS) return 'review-due'
  return 'active'
}

export function normalizePrinciple(value, { now = new Date() } = {}) {
  const statement = text(value?.statement, 200)
  if (!statement) return null
  const confirmedAt = iso(value?.confirmedAt) || now.toISOString()
  return {
    id: text(value?.id, 80) || newPersonalId('PRN'),
    statement,
    kind: text(value?.kind, 40),
    confidence: Number.isFinite(Number(value?.confidence)) ? Math.min(1, Math.max(0, Number(value.confidence))) : null,
    evidence: (Array.isArray(value?.evidence) ? value.evidence : []).slice(0, 5).map((entry) => ({
      proposalId: text(entry?.proposalId, 80),
      summary: text(entry?.summary, 120),
      decidedAt: iso(entry?.decidedAt),
      tenantId: text(entry?.tenantId, 80),
    })).filter((entry) => entry.proposalId),
    confirmedAt,
    expiresAt: iso(value?.expiresAt) || new Date(Date.parse(confirmedAt) + PRINCIPLE_VALID_DAYS * DAY_MS).toISOString(),
    status: value?.status === 'retired' ? 'retired' : 'active',
    retiredAt: iso(value?.retiredAt),
    source: text(value?.source, 40) || 'decision-pattern',
  }
}

/**
 * 결정 이력에서 규범 후보를 찾는다.
 * 같은 kind에서 같은 방향(같은 필드를 같은 값으로 고침)의 ✏수정이 3회 이상이면 후보다.
 */
export function principleCandidates(decisions, { now = new Date(), existing = [], rejections = [] } = {}) {
  const buckets = new Map()
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    if (decision?.status !== 'edited' || !decision.decisionDiff) continue
    for (const [field, change] of Object.entries(decision.decisionDiff)) {
      const after = text(change?.after, 60)
      if (!after) continue
      const key = `${decision.kind}:${field}:${after}`
      const bucket = buckets.get(key) ?? { kind: decision.kind, field, after, decisions: [] }
      bucket.decisions.push(decision)
      buckets.set(key, bucket)
    }
  }

  const activeStatements = new Set(existing.filter((item) => item?.status !== 'retired').map((item) => item.statement))
  const blocked = new Map(rejections.map((entry) => [entry.key, Date.parse(entry.until ?? '') || 0]))
  const candidates = []
  for (const [key, bucket] of buckets) {
    if (bucket.decisions.length < PRINCIPLE_MIN_EVIDENCE) continue
    const until = blocked.get(key)
    if (until && until > now.getTime()) continue
    const statement = `${kindLabel(bucket.kind)}에서 ‘${bucket.field}’은(는) 항상 ‘${bucket.after}’(으)로 한다.`
    if (activeStatements.has(statement)) continue
    const evidence = bucket.decisions
      .sort((left, right) => String(right.decidedAt).localeCompare(String(left.decidedAt)))
      .slice(0, PRINCIPLE_MIN_EVIDENCE)
      .map((decision) => ({ proposalId: decision.id, summary: text(decision.summary, 120), decidedAt: iso(decision.decidedAt), tenantId: text(decision.tenantId, 80) }))
    candidates.push({
      key,
      statement,
      kind: bucket.kind,
      field: bucket.field,
      value: bucket.after,
      confidence: Math.min(0.95, 0.6 + (bucket.decisions.length - PRINCIPLE_MIN_EVIDENCE) * 0.1),
      evidence,
    })
  }
  return candidates.sort((left, right) => right.confidence - left.confidence)
}

function kindLabel(kind) {
  if (kind === 'document-classification') return '문서 분류'
  if (kind === 'task-from-message') return '업무 제안'
  if (kind === 'sentinel-task') return '생존 센티널'
  if (kind === 'lens-task') return '문서 렌즈'
  if (kind === 'opportunity') return '외부 기회'
  return '제안'
}

export function principleProposal(candidate, { now, proposalId, ownerAccountId }) {
  return {
    id: proposalId,
    kind: 'principle',
    status: 'pending',
    confidence: candidate.confidence,
    sourceKey: `principle:${ownerAccountId}:${candidate.key}`,
    summary: candidate.statement,
    evidence: `같은 방향으로 ${candidate.evidence.length}번 고치셨습니다 — ${candidate.evidence.map((entry) => entry.summary).join(' / ')}`,
    payload: {
      statement: candidate.statement,
      kind: candidate.kind,
      field: candidate.field,
      value: candidate.value,
      confidence: candidate.confidence,
      evidence: candidate.evidence,
      candidateKey: candidate.key,
      ownerAccountId,
    },
    createdAt: now,
    createdBy: 'personal-core',
  }
}

export function rejectionUntil(now = new Date()) {
  return new Date(now.getTime() + PRINCIPLE_REJECT_COOLDOWN_DAYS * DAY_MS).toISOString()
}

// ---------------------------------------------------------------------------
// 노트 · 교정 로그 · 지식 공백
// ---------------------------------------------------------------------------

export function normalizeNote(value, { now = new Date() } = {}) {
  const body = text(value?.body, 1_000)
  if (!body) throw new PersonalCoreError('PERSONAL_NOTE_REQUIRED', '알려줄 내용을 한 줄 이상 적어 주세요.')
  return {
    id: text(value?.id, 80) || newPersonalId('NOTE'),
    body,
    topic: text(value?.topic, 80),
    source: text(value?.source, 40) || 'manual',
    gapId: text(value?.gapId, 80),
    createdAt: iso(value?.createdAt) || now.toISOString(),
  }
}

export function normalizeCorrection(value, { now = new Date() } = {}) {
  return {
    id: text(value?.id, 80) || newPersonalId('COR'),
    proposalId: text(value?.proposalId, 80),
    kind: text(value?.kind, 40),
    reason: text(value?.reason, 300),
    diff: value?.diff && typeof value.diff === 'object' ? value.diff : null,
    tenantId: text(value?.tenantId, 80),
    createdAt: iso(value?.createdAt) || now.toISOString(),
  }
}

export function normalizeGap(value, { now = new Date() } = {}) {
  const question = text(value?.question, 200)
  if (!question) return null
  return {
    id: text(value?.id, 80) || newPersonalId('GAP'),
    question,
    topic: text(value?.topic, 80),
    source: text(value?.source, 40) || 'ai',
    reference: text(value?.reference, 160),
    confidence: Number.isFinite(Number(value?.confidence)) ? Math.min(1, Math.max(0, Number(value.confidence))) : null,
    status: value?.status === 'resolved' ? 'resolved' : 'open',
    resolvedAt: iso(value?.resolvedAt),
    noteId: text(value?.noteId, 80),
    createdAt: iso(value?.createdAt) || now.toISOString(),
    seenCount: Number.isFinite(Number(value?.seenCount)) ? Math.max(1, Math.trunc(Number(value.seenCount))) : 1,
  }
}

/** 같은 질문이 반복되면 새 줄을 만들지 않고 횟수만 올린다. */
export function upsertGap(gaps, gap) {
  const rows = Array.isArray(gaps) ? gaps : []
  const index = rows.findIndex((item) => item?.status === 'open' && item.question === gap.question)
  if (index < 0) return [gap, ...rows].slice(0, MAX_ROWS)
  const merged = { ...rows[index], seenCount: (Number(rows[index].seenCount) || 1) + 1, reference: gap.reference || rows[index].reference }
  return [merged, ...rows.filter((_, position) => position !== index)].slice(0, MAX_ROWS)
}

export const trimRows = (rows) => (Array.isArray(rows) ? rows : []).slice(0, MAX_ROWS)

// ---------------------------------------------------------------------------
// 컨텍스트 조립기
// ---------------------------------------------------------------------------

const APPROX_CHARS_PER_TOKEN = 3

/**
 * 주입 우선순위: 규범 카드 → 최근 관련 결정 3건 → 개인 노트 → 현재 화면 데이터.
 * 토큰 상한을 넘으면 낮은 것부터 뺀다. 무엇이 들어갔는지 그대로 돌려줘 화면에 접어 보여 준다.
 */
export function assemblePersonalContext({ principles = [], decisions = [], notes = [], screen = '', tokenBudget = 1_200, now = new Date() } = {}) {
  const layers = []
  const activePrinciples = principles
    .filter((item) => ['active', 'review-due'].includes(principleStatus(item, now)))
    .slice(0, 8)
  if (activePrinciples.length) {
    layers.push({
      id: 'principles',
      label: '확정된 규범',
      priority: 1,
      items: activePrinciples.map((item) => ({ id: item.id, text: item.statement })),
    })
  }
  const recentDecisions = decisions.slice(0, 3)
  if (recentDecisions.length) {
    layers.push({
      id: 'decisions',
      label: '최근 결정',
      priority: 2,
      items: recentDecisions.map((item) => ({ id: item.id, text: `${text(item.summary, 100)} → ${item.status === 'rejected' ? '거절' : item.status === 'edited' ? '수정 후 승인' : '승인'}` })),
    })
  }
  const recentNotes = notes.slice(0, 5)
  if (recentNotes.length) {
    layers.push({ id: 'notes', label: '내 메모', priority: 3, items: recentNotes.map((item) => ({ id: item.id, text: text(item.body, 200) })) })
  }
  const screenText = text(screen, 4_000)
  if (screenText) {
    layers.push({ id: 'screen', label: '현재 화면', priority: 4, items: [{ id: 'screen', text: screenText }] })
  }

  const budgetChars = Math.max(0, tokenBudget) * APPROX_CHARS_PER_TOKEN
  const kept = []
  const dropped = []
  let used = 0
  for (const layer of [...layers].sort((left, right) => left.priority - right.priority)) {
    const rendered = `${layer.label}\n${layer.items.map((item) => `- ${item.text}`).join('\n')}`
    if (used + rendered.length > budgetChars && kept.length) { dropped.push(layer.id); continue }
    kept.push({ ...layer, rendered })
    used += rendered.length
  }
  // 우선순위가 낮은 층부터 빠지도록, 남은 층은 원래 순서로 되돌린다.
  kept.sort((left, right) => left.priority - right.priority)
  return {
    text: kept.map((layer) => layer.rendered).join('\n\n'),
    used: Math.ceil(used / APPROX_CHARS_PER_TOKEN),
    tokenBudget,
    injected: kept.map((layer) => ({ id: layer.id, label: layer.label, count: layer.items.length, items: layer.items.map((item) => item.text) })),
    dropped,
  }
}

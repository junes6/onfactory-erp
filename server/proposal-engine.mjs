// AI 제안(승인 큐) 엔진 — 순수 함수 모음.
// 제안은 절대 직접 실행되지 않는다. 사람이 ✓/✏/✗로 결정하고, 결정 이력이 자동화 승급의 원료가 된다.
import { randomBytes } from 'node:crypto'

export const PROPOSAL_KINDS = Object.freeze(['document-classification', 'task-from-message', 'sentinel-task', 'lens-task', 'opportunity'])
export const PROPOSAL_STATUSES = Object.freeze(['pending', 'approved', 'edited', 'rejected', 'expired'])
export const PROPOSALS_KEY = 'ai-proposals'
export const AUTOMATION_POLICIES_KEY = 'automation-policies'
export const APPROVAL_WINDOW_DAYS = 28

const DAY_MS = 24 * 60 * 60 * 1_000

export function newProposalId() {
  return `PRP-${Date.now()}-${randomBytes(3).toString('hex')}`
}

function seoulDateKey(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return new Date(date.getTime() + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10)
}

function daysUntil(dateKey, now) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey))) return null
  const today = seoulDateKey(now)
  return Math.round((Date.parse(`${dateKey}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS)
}

function seoulDateTimeIso(dateKey, hour = 18) {
  // 서울 기준 YYYY-MM-DD HH:00 → UTC ISO
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) - 9 * 60 * 60 * 1_000 + hour * 60 * 60 * 1_000).toISOString()
}

function addDaysKey(now, days) {
  const today = seoulDateKey(now)
  return new Date(Date.parse(`${today}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// 1) 문서 업로드 → 유형·귀속 분류 제안
// ---------------------------------------------------------------------------
const DOCUMENT_RULES = [
  { category: '식품안전·인증', weight: .95, patterns: [/haccp/i, /인증서/, /성적서/, /자가품질/, /검교정/, /위생교육/, /수료증/, /iso\s?22000/i, /fssc/i] },
  { category: '공장도면', weight: .9, patterns: [/도면/, /배치도/, /layout/i, /평면도/] },
  { category: '재고·물류', weight: .85, patterns: [/입고/, /출고/, /재고/, /거래명세/, /송장/, /lot/i, /팔레트/] },
  { category: '제품', weight: .85, patterns: [/표시사항/, /라벨/, /원재료/, /영양성분/, /품목제조/, /제품명세/] },
  { category: '판매·주문', weight: .8, patterns: [/주문/, /정산/, /쿠팡/, /네이버/, /스마트스토어/, /발주/, /견적/] },
  { category: '인사·노무', weight: .85, patterns: [/근로계약/, /급여/, /연차/, /휴가/, /4대보험/, /인사/] },
  { category: '계약 · 거래처', weight: .85, patterns: [/계약서/, /계약/, /nda/i, /협약/, /mou/i] },
  { category: '회의·업무일지', weight: .75, patterns: [/회의록/, /회의/, /업무일지/, /주간보고/, /보고서/] },
]
const GENERIC_CATEGORIES = new Set(['공통자료', '기타', ''])
const SYSTEM_CATEGORIES = new Set(['개발운영지원', '사내메신저', '프로젝트 산출물'])

/** 파일명·기존 분류·태그로 유형을 추정한다. 0.85 이상이면 '높음'. */
export function classifyDocument(document) {
  const haystack = `${document?.name ?? ''} ${document?.originalName ?? ''} ${(document?.tags ?? []).join(' ')} ${document?.summary ?? ''}`
  let best = null
  for (const rule of DOCUMENT_RULES) {
    const hits = rule.patterns.filter((pattern) => pattern.test(haystack)).length
    if (!hits) continue
    const confidence = Math.min(.98, rule.weight + (hits - 1) * .03)
    if (!best || confidence > best.confidence) best = { category: rule.category, confidence }
  }
  return best
}

export function proposeDocumentClassification(document, { now = new Date() } = {}) {
  if (!document?.id || SYSTEM_CATEGORIES.has(document.category)) return null
  const guess = classifyDocument(document)
  if (!guess) return null
  const currentCategory = String(document.category ?? '')
  if (guess.category === currentCategory) return null
  // 사용자가 이미 구체적 분류를 지정했는데 확신도가 낮으면 제안하지 않는다.
  if (!GENERIC_CATEGORIES.has(currentCategory) && guess.confidence < .85) return null
  const suggestedTags = Array.from(new Set([...(document.tags ?? []), guess.category.replace(/\s*·\s*/g, '·')])).slice(0, 10)
  return {
    id: newProposalId(),
    kind: 'document-classification',
    status: 'pending',
    confidence: Math.round(guess.confidence * 100) / 100,
    sourceKey: `doc:${document.id}`,
    summary: `‘${document.name}’ 문서를 [${guess.category}]로 분류`,
    evidence: `파일명·태그 패턴 일치 (현재 분류: ${currentCategory || '미지정'})`,
    payload: { documentId: document.id, documentName: document.name, currentCategory, category: guess.category, tags: suggestedTags },
    createdAt: now.toISOString(),
    createdBy: 'ai:document-classifier',
  }
}

// ---------------------------------------------------------------------------
// 2) 메신저 지시 문형 → 업무 생성 제안
// ---------------------------------------------------------------------------
const INSTRUCTION_PATTERN = /(주세요|주시겠어요|주실래요|주십시오|줘요|부탁(?:드립니다|드려요|해요|합니다|드릴게요|해)|처리\s?바랍니다|확인\s?바랍니다|요청\s?드립니다|까지\s?(?:부탁|처리|완료|제출|보내|정리|올려|마무리))/
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']

export function isInstructionMessage(text) {
  return INSTRUCTION_PATTERN.test(String(text ?? ''))
}

/** "내일까지", "금요일까지", "8월 25일까지", "25일까지" 에서 마감일을 추정한다. 없으면 2영업일 뒤. */
export function estimateDue(text, now = new Date()) {
  const today = seoulDateKey(now)
  const source = String(text ?? '')
  let dateKey = null
  let reason = '기본 마감(2영업일)'
  const monthDay = source.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/)
  const dayOnly = source.match(/(?<!\d)(\d{1,2})\s*일\s*까지/)
  if (monthDay) {
    const year = Number(today.slice(0, 4))
    dateKey = `${year}-${String(monthDay[1]).padStart(2, '0')}-${String(monthDay[2]).padStart(2, '0')}`
    if (dateKey < today) dateKey = `${year + 1}${dateKey.slice(4)}`
    reason = `메시지의 날짜 "${monthDay[0]}"`
  } else if (dayOnly) {
    const day = Number(dayOnly[1])
    const candidate = `${today.slice(0, 8)}${String(day).padStart(2, '0')}`
    dateKey = candidate >= today ? candidate : addDaysKey(new Date(Date.parse(`${today.slice(0, 7)}-01T00:00:00Z`) + 32 * DAY_MS), 0).slice(0, 8) + String(day).padStart(2, '0')
    reason = `메시지의 날짜 "${dayOnly[0]}"`
  } else if (/오늘/.test(source)) { dateKey = today; reason = '메시지의 "오늘"' }
  else if (/내일/.test(source)) { dateKey = addDaysKey(now, 1); reason = '메시지의 "내일"' }
  else if (/모레/.test(source)) { dateKey = addDaysKey(now, 2); reason = '메시지의 "모레"' }
  else {
    const weekday = source.match(/([월화수목금토일])요일/)
    if (weekday) {
      const target = WEEKDAYS.indexOf(weekday[1])
      const current = new Date(`${today}T00:00:00Z`).getUTCDay()
      let delta = (target - current + 7) % 7
      if (delta === 0) delta = 7
      dateKey = addDaysKey(now, delta)
      reason = `메시지의 "${weekday[0]}"`
    } else if (/이번\s?주/.test(source)) {
      const current = new Date(`${today}T00:00:00Z`).getUTCDay()
      dateKey = addDaysKey(now, Math.max(0, 5 - current))
      reason = '메시지의 "이번 주"'
    }
  }
  if (!dateKey) {
    let cursor = today
    let added = 0
    while (added < 2) {
      cursor = addDaysKey(new Date(Date.parse(`${cursor}T00:00:00Z`)), 1)
      const day = new Date(`${cursor}T00:00:00Z`).getUTCDay()
      if (day !== 0 && day !== 6) added += 1
    }
    dateKey = cursor
  }
  return { dueDate: dateKey, dueIso: seoulDateTimeIso(dateKey, 18), reason }
}

export function instructionTitle(text) {
  const firstLine = String(text ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? ''
  const trimmed = firstLine
    .replace(/(해\s?주세요|해\s?주시겠어요|해\s?주실래요|부탁(?:드립니다|드려요|해요|합니다|드릴게요)|처리\s?바랍니다|확인\s?바랍니다|요청\s?드립니다|진행해\s?주세요)[.!~]*$/, '')
    .replace(/^[\s,]+|[\s,.]+$/g, '')
  const title = trimmed || firstLine
  return title.length > 60 ? `${title.slice(0, 57)}…` : title
}

export function proposeTaskFromMessage({ message, conversation, recipients = [], now = new Date() }) {
  if (!message?.text || !isInstructionMessage(message.text)) return null
  const due = estimateDue(message.text, now)
  const owner = recipients.length === 1 ? recipients[0] : null
  return {
    id: newProposalId(),
    kind: 'task-from-message',
    status: 'pending',
    confidence: owner ? .8 : .6,
    sourceKey: `msg:${message.id}`,
    summary: `업무 생성: “${instructionTitle(message.text)}”`,
    evidence: `${conversation?.name ?? '대화'}에서 ${message.senderName}의 지시 문형 감지 · 마감 ${due.dueDate} (${due.reason})`,
    payload: {
      title: instructionTitle(message.text),
      description: `메신저 지시에서 생성 · 원문: ${String(message.text).slice(0, 300)}`,
      ownerId: owner?.id ?? null,
      owner: owner?.name ?? '',
      requesterId: message.senderId,
      requestedBy: message.senderName,
      due: due.dueIso,
      priority: /긴급|급히|asap|지금 바로/i.test(message.text) ? '긴급' : '보통',
      category: '일반',
      conversationId: conversation?.id ?? null,
      messageId: message.id,
    },
    createdAt: now.toISOString(),
    createdBy: 'ai:messenger-instruction',
  }
}

// ---------------------------------------------------------------------------
// 3) 생존 센티널 — 업종 모듈이 규칙팩을 등록한다
// ---------------------------------------------------------------------------
function complianceRecords(tenantStore) { return Array.isArray(tenantStore?.['compliance-records']?.data) ? tenantStore['compliance-records'].data : [] }
function products(tenantStore) { return Array.isArray(tenantStore?.['product-catalog']?.data) ? tenantStore['product-catalog'].data : [] }
function workItems(tenantStore) { return Array.isArray(tenantStore?.['work-items']?.data) ? tenantStore['work-items'].data : [] }

function taskProposal({ ruleId, ruleLabel, sourceKey, title, evidence, ownerId, owner, dueIso, priority = '높음', confidence = .9, now }) {
  return {
    id: newProposalId(),
    kind: 'sentinel-task',
    status: 'pending',
    confidence,
    sourceKey,
    summary: `업무 생성: ${title}`,
    evidence,
    payload: { ruleId, ruleLabel, title, description: `생존 센티널 제안 · 근거: ${evidence}`, ownerId, owner, due: dueIso, priority, category: '일반' },
    createdAt: now.toISOString(),
    createdBy: 'sentinel:food_manufacturing',
  }
}

const foodRulePack = [
  {
    id: 'compliance-expiry',
    label: '인증·검사 만료 D-30/D-7',
    evaluate({ tenantStore, resolveOwner, now }) {
      const out = []
      for (const record of complianceRecords(tenantStore)) {
        const days = daysUntil(record?.expiresAt, now)
        if (days === null || days > 30) continue
        const stage = days <= 7 ? 'd7' : 'd30'
        const owner = resolveOwner(record.owner)
        const dLabel = days < 0 ? `D+${Math.abs(days)}` : `D-${days}`
        out.push(taskProposal({
          ruleId: 'compliance-expiry', ruleLabel: '인증·검사 만료',
          sourceKey: `sentinel:compliance:${record.id}:${stage}`,
          title: `${record.name} ${days < 0 ? '만료 후속 조치' : '갱신 준비'} (${dLabel})`,
          evidence: `${record.name} ${days < 0 ? '만료됨' : '만료'} ${dLabel} · 다음 검토일 ${record.expiresAt}`,
          ownerId: owner?.id ?? null, owner: owner?.name ?? record.owner ?? '',
          dueIso: seoulDateTimeIso(days < 0 ? addDaysKey(now, 1) : record.expiresAt, 18),
          priority: days <= 7 ? '긴급' : '높음', confidence: .95, now,
        }))
      }
      return out
    },
  },
  {
    id: 'inventory-safety',
    label: '재고 안전선 이하',
    evaluate({ tenantStore, defaultOwner, now }) {
      const out = []
      for (const product of products(tenantStore)) {
        const stock = Number(product?.stock ?? 0)
        const safety = Number(product?.safetyStock ?? 0)
        if (!(safety > 0) || !(stock <= safety)) continue
        out.push(taskProposal({
          ruleId: 'inventory-safety', ruleLabel: '재고 안전선',
          sourceKey: `sentinel:stock:${product.id}`,
          title: `${product.name} 재고 보충 (현재 ${stock} / 안전 ${safety})`,
          evidence: `${product.name} 재고 ${stock}이(가) 안전재고 ${safety} 이하`,
          ownerId: defaultOwner?.id ?? null, owner: defaultOwner?.name ?? '',
          dueIso: seoulDateTimeIso(addDaysKey(now, 3), 18), priority: stock <= 0 ? '긴급' : '높음', confidence: .9, now,
        }))
      }
      return out
    },
  },
  {
    id: 'approval-backlog',
    label: '결재 48시간 초과 적체',
    evaluate({ tenantStore, resolveOwnerById, now }) {
      const out = []
      for (const item of workItems(tenantStore)) {
        if (item?.status !== '결재대기') continue
        const submittedAt = item.completion?.submittedAt
        if (!submittedAt || now.getTime() - Date.parse(submittedAt) < 48 * 60 * 60 * 1_000) continue
        const hours = Math.floor((now.getTime() - Date.parse(submittedAt)) / (60 * 60 * 1_000))
        const owner = resolveOwnerById(item.requesterId)
        out.push(taskProposal({
          ruleId: 'approval-backlog', ruleLabel: '결재 적체',
          sourceKey: `sentinel:backlog:${item.id}`,
          title: `결재 처리: ${item.title}`,
          evidence: `‘${item.title}’ 완료 보고 후 ${hours}시간째 결재 대기`,
          ownerId: owner?.id ?? item.requesterId ?? null, owner: owner?.name ?? item.requestedBy ?? '',
          dueIso: seoulDateTimeIso(addDaysKey(now, 1), 18), priority: '높음', confidence: .9, now,
        }))
      }
      return out
    },
  },
  {
    id: 'work-overdue',
    label: '업무 마감 초과',
    evaluate({ tenantStore, resolveOwnerById, now }) {
      const out = []
      for (const item of workItems(tenantStore)) {
        if (!item || item.status === '결재완료') continue
        const dueAt = Date.parse(item.due)
        if (!Number.isFinite(dueAt) || dueAt >= now.getTime()) continue
        const days = Math.floor((now.getTime() - dueAt) / DAY_MS)
        const owner = resolveOwnerById(item.ownerId)
        out.push(taskProposal({
          ruleId: 'work-overdue', ruleLabel: '마감 초과',
          sourceKey: `sentinel:overdue:${item.id}`,
          title: `마감 초과 점검: ${item.title}`,
          evidence: `‘${item.title}’ 마감 ${days === 0 ? '오늘' : `${days}일`} 경과 · 상태 ${item.status}`,
          ownerId: owner?.id ?? item.ownerId ?? null, owner: owner?.name ?? item.owner ?? '',
          dueIso: seoulDateTimeIso(addDaysKey(now, 1), 18), priority: '긴급', confidence: .85, now,
        }))
      }
      return out
    },
  },
]

export const sentinelRulePacks = Object.freeze({
  food_manufacturing: foodRulePack,
  it_services: [], // 1차에서는 코어 규칙 없음. 다음 단계에서 계약 만료·마감 규칙을 등록한다.
})

export function rulePackFor(industryType) {
  return sentinelRulePacks[industryType] ?? sentinelRulePacks.food_manufacturing
}

/**
 * 센티널 평가: 현재 상태 기준 제안 목록을 만들고, 기존 제안과 합친다.
 * - 같은 sourceKey의 미결 제안이 있으면 새로 만들지 않는다(중복 금지).
 * - 조건이 해소된 미결 센티널 제안은 expired로 닫는다.
 * 반환: { proposals: 갱신된 전체 목록, created: 새로 만든 수, expired: 닫힌 수 }
 */
export function evaluateSentinel({ tenantStore, existing = [], industryType, accounts = [], tenantId, now = new Date() }) {
  const tenantAccounts = accounts.filter((account) => account?.tenantId === tenantId && account.approved)
  const resolveOwner = (name) => tenantAccounts.find((account) => account.name === name) ?? null
  const resolveOwnerById = (id) => tenantAccounts.find((account) => account.id === id) ?? null
  const defaultOwner = tenantAccounts.find((account) => account.role === 'tenant-admin') ?? null
  const pack = rulePackFor(industryType)
  const detected = pack.flatMap((rule) => rule.evaluate({ tenantStore, resolveOwner, resolveOwnerById, defaultOwner, now }))
  const detectedKeys = new Set(detected.map((proposal) => proposal.sourceKey))
  const pendingKeys = new Set(existing.filter((proposal) => proposal.kind === 'sentinel-task' && proposal.status === 'pending').map((proposal) => proposal.sourceKey))
  let expired = 0
  const next = existing.map((proposal) => {
    if (proposal.kind === 'sentinel-task' && proposal.status === 'pending' && !detectedKeys.has(proposal.sourceKey)) {
      expired += 1
      return { ...proposal, status: 'expired', decidedAt: now.toISOString(), decidedBy: 'sentinel', decisionDiff: null, resolutionNote: '조건 해소' }
    }
    return proposal
  })
  // 이미 결정(승인/수정/거절)된 사안은 해소 전 다시 올리지 않는다.
  const decidedKeys = new Set(existing.filter((proposal) => proposal.kind === 'sentinel-task' && proposal.status !== 'pending' && proposal.status !== 'expired').map((proposal) => proposal.sourceKey))
  const created = detected.filter((proposal) => !pendingKeys.has(proposal.sourceKey) && !decidedKeys.has(proposal.sourceKey))
  return { proposals: [...created, ...next], created: created.length, expired }
}

// ---------------------------------------------------------------------------
// 4) 승인률 집계 (automation_policies) — 유형별 최근 4주
// ---------------------------------------------------------------------------
export function approvalStatistics(proposals, { now = new Date(), windowDays = APPROVAL_WINDOW_DAYS } = {}) {
  const since = now.getTime() - windowDays * DAY_MS
  const stats = new Map()
  for (const kind of PROPOSAL_KINDS) stats.set(kind, { approved: 0, edited: 0, rejected: 0 })
  for (const proposal of proposals) {
    if (!stats.has(proposal.kind)) continue
    if (!['approved', 'edited', 'rejected'].includes(proposal.status)) continue
    const decidedAt = Date.parse(proposal.decidedAt ?? '')
    if (!Number.isFinite(decidedAt) || decidedAt < since) continue
    stats.get(proposal.kind)[proposal.status] += 1
  }
  return PROPOSAL_KINDS.map((kind) => {
    const row = stats.get(kind)
    const total = row.approved + row.edited + row.rejected
    return {
      id: `POL-${kind}`,
      kind,
      windowDays,
      windowStart: new Date(since).toISOString(),
      approved: row.approved,
      edited: row.edited,
      rejected: row.rejected,
      total,
      approvalRate: total ? Math.round(((row.approved + row.edited) / total) * 100) : null,
      // 자동 승급은 다음 단계. 지금은 집계만 저장한다.
      autoApprove: false,
      updatedAt: now.toISOString(),
    }
  })
}

export function diffProposalPayload(before, after) {
  const changed = {}
  for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
    const left = JSON.stringify(before?.[key] ?? null)
    const right = JSON.stringify(after?.[key] ?? null)
    if (left !== right) changed[key] = { before: before?.[key] ?? null, after: after?.[key] ?? null }
  }
  return Object.keys(changed).length ? changed : null
}

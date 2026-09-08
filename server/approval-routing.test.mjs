import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  APPROVAL_ERRORS,
  MAX_APPROVERS_PER_STEP,
  MAX_CC,
  MAX_COMMENT,
  MAX_FIELDS_PER_FORM,
  MAX_HELP,
  MAX_HISTORY,
  MAX_LABEL,
  MAX_LINE_STEPS,
  MAX_MONEY,
  MAX_OPTIONS_PER_FIELD,
  MAX_OPTION_VALUE,
  MAX_POSTING_MONTHS,
  MAX_REJECTION_REASON,
  MAX_TEXT_VALUE,
  MAX_TITLE,
  MIN_POSTING_MONTHS,
  TAX_EVIDENCE_CATEGORIES,
  applyApprovalDecision,
  approvalPosting,
  approvalSeatFor,
  canDecide,
  canEditDraft,
  canRecall,
  currentStepOf,
  normalizeApprovalForm,
  normalizeApprovalLine,
  normalizeApprovalValues,
  normalizeDelegate,
  pendingApproverIds,
  summarizePostings,
} from './approval-routing.mjs'
import { billingMonth } from './billing-service.mjs'

/**
 * 순수 함수만 검사한다 — 서버도 저장소도 띄우지 않는다.
 * 모든 시각은 주입한다. 이 파일 어디에도 new Date() 가 없어야 자정 무렵에만 빨개지는 테스트가 생기지 않는다.
 */
const NOW = '2026-03-10T02:00:00.000Z'
const LATER = '2026-03-10T05:00:00.000Z'
const ACTOR = { id: 'ADMIN', name: '관리자' }
const ACCOUNTS = [
  { id: 'AA', name: '가결재' },
  { id: 'BB', name: '나결재' },
  { id: 'CC', name: '다결재' },
  { id: 'DD', name: '라결재' },
  { id: 'DRAFT', name: '기안자' },
]

function buildLine(steps) {
  const result = normalizeApprovalLine(steps, { drafterId: 'DRAFT', approverIds: ACCOUNTS })
  assert.equal(result.error, undefined, '결재선 픽스처가 정규화를 통과해야 한다')
  return result.line
}

function pendingDocument(line, overrides = {}) {
  return {
    id: 'APD-TEST-0001',
    formId: 'AFM-TEST-0001',
    formName: '지출결의서',
    formVersion: 1,
    kind: '지출결의',
    title: '3월 출장비',
    values: { amount: 120_000 },
    attachments: [],
    line,
    ccIds: [],
    drafterId: 'DRAFT',
    drafterName: '기안자',
    status: '결재중',
    currentStep: 1,
    rejectionReason: null,
    evidenceId: null,
    posting: null,
    history: [],
    version: 1,
    clientRequestId: 'REQ-1',
    createdAt: NOW,
    updatedAt: NOW,
    submittedAt: NOW,
    completedAt: null,
    ...overrides,
  }
}

function approve(document, actorId, extra = {}) {
  return applyApprovalDecision(document, { actorId, actorName: actorId, decision: 'approve', now: LATER, ...extra })
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const entry of Object.values(value)) deepFreeze(entry)
  }
  return value
}

const sampleForm = (() => {
  const built = normalizeApprovalForm({
    name: '지출결의서',
    kind: '지출결의',
    description: '경비를 쓴 뒤 올린다.',
    fields: [
      { key: 'purpose', label: '사유', type: 'text', required: true },
      { key: 'amount', label: '금액', type: 'money' },
      { key: 'spent_on', label: '지출일', type: 'date' },
      { key: 'method', label: '결제수단', type: 'select', options: ['법인카드', '계좌이체'] },
      { key: 'receipt', label: '영수증', type: 'attachment' },
      { key: 'nights', label: '숙박일수', type: 'number' },
    ],
    amountFieldKey: 'amount',
    evidenceCategory: '경비',
  }, { actor: ACTOR, now: NOW })
  assert.equal(built.error, undefined, '양식 픽스처가 정규화를 통과해야 한다')
  return built.form
})()

test('1) 순차 3단계 — 1단계 승인이면 다음 단계로만 넘어간다', () => {
  const document = pendingDocument(buildLine([
    { mode: 'sequential', approvers: ['AA'] },
    { mode: 'sequential', approvers: ['BB'] },
    { mode: 'sequential', approvers: ['CC'] },
  ]))
  const first = approve(document, 'AA')
  assert.equal(first.document.currentStep, 2)
  assert.equal(first.document.status, '결재중')
  assert.equal(first.document.completedAt, null)
  assert.equal(first.document.version, 2)
  assert.equal(first.document.history.at(-1).action, '1단계 승인')
})

test('2) 순차 3단계 — 마지막 승인에서만 「승인」이 되고 completedAt 이 찍힌다', () => {
  const document = pendingDocument(buildLine([
    { mode: 'sequential', approvers: ['AA'] },
    { mode: 'sequential', approvers: ['BB'] },
    { mode: 'sequential', approvers: ['CC'] },
  ]))
  const second = approve(approve(document, 'AA').document, 'BB')
  assert.equal(second.document.currentStep, 3)
  assert.equal(second.document.status, '결재중')

  const third = approve(second.document, 'CC')
  assert.equal(third.document.status, '승인')
  assert.equal(third.document.currentStep, 3)
  assert.equal(third.document.completedAt, LATER)
  assert.equal(third.document.version, 4)
  assert.equal(third.document.history.at(-1).action, '최종 승인')
})

test('3) 병렬 2인 중 1인 승인 — 단계가 그대로 있고 나머지는 pending 이다', () => {
  const document = pendingDocument(buildLine([
    { mode: 'parallel', approvers: ['AA', 'BB'] },
    { mode: 'sequential', approvers: ['CC'] },
  ]))
  const first = approve(document, 'AA')
  assert.equal(first.document.status, '결재중')
  assert.equal(first.document.currentStep, 1)
  const approvers = currentStepOf(first.document).approvers
  assert.equal(approvers.find((entry) => entry.accountId === 'AA').decision, 'approved')
  assert.equal(approvers.find((entry) => entry.accountId === 'BB').decision, 'pending')
  assert.deepEqual(pendingApproverIds(first.document), ['BB'])
})

test('4) 병렬 2인 전원 승인 — 그때 비로소 다음 단계로 간다', () => {
  const document = pendingDocument(buildLine([
    { mode: 'parallel', approvers: ['AA', 'BB'] },
    { mode: 'sequential', approvers: ['CC'] },
  ]))
  const both = approve(approve(document, 'AA').document, 'BB')
  assert.equal(both.document.currentStep, 2)
  assert.equal(both.document.status, '결재중')
  assert.equal(both.document.history.at(-1).action, '1단계 승인')
})

test('5) 병렬 1인 반려 — 즉시 반려되고 아직 보지 않은 사람은 pending 으로 남는다', () => {
  // 결재자가 셋이라야 「아직 보지 않은 사람」이 남는다. 2인 픽스처로는 반려가 결재선을 지워도 아무도 눈치채지 못한다.
  const document = pendingDocument(buildLine([{ mode: 'parallel', approvers: ['AA', 'BB', 'CC'] }]))
  const approved = approve(document, 'AA').document
  const rejected = applyApprovalDecision(approved, {
    actorId: 'BB', actorName: 'BB', decision: 'reject', reason: '증빙이 없습니다', now: LATER,
  })
  assert.equal(rejected.document.status, '반려')
  assert.equal(rejected.document.rejectionReason, '증빙이 없습니다')
  assert.equal(rejected.document.completedAt, LATER)
  const approvers = currentStepOf(rejected.document).approvers
  assert.equal(approvers.length, 3, '반려가 결재선의 자리를 지우지 않는다')
  assert.equal(approvers.find((entry) => entry.accountId === 'AA').decision, 'approved')
  assert.equal(approvers.find((entry) => entry.accountId === 'BB').decision, 'rejected')
  assert.equal(approvers.find((entry) => entry.accountId === 'CC').decision, 'pending', '아직 보지 않은 사람이 그대로 남는다')
})

test('6) 반려 사유는 5자 이상 — 4자는 거절, 5자는 통과', () => {
  const document = pendingDocument(buildLine([{ mode: 'sequential', approvers: ['AA'] }]))
  const short = applyApprovalDecision(document, { actorId: 'AA', actorName: 'AA', decision: 'reject', reason: '네글자다', now: LATER })
  assert.equal(short.error.code, APPROVAL_ERRORS.REASON_REQUIRED.code)
  assert.equal(short.document, undefined)

  const enough = applyApprovalDecision(document, { actorId: 'AA', actorName: 'AA', decision: 'reject', reason: '다섯글자다', now: LATER })
  assert.equal(enough.error, undefined)
  assert.equal(enough.document.rejectionReason, '다섯글자다')
})

test('7) 결재선 밖 사람은 거절된다 — 관리자여도 같은 거절이다', () => {
  const document = pendingDocument(buildLine([{ mode: 'sequential', approvers: ['AA'] }]))
  const outsider = approve(document, 'DD')
  const admin = approve(document, ACTOR.id)
  assert.equal(outsider.error.code, APPROVAL_ERRORS.NOT_APPROVER.code)
  // 이 함수에는 역할 인자가 아예 없다. 관리자에게 예외를 줄 자리가 코드에 존재하지 않는다.
  assert.deepEqual(admin.error, outsider.error)
})

test('8) 이미 승인한 사람이 다시 누르면 「이미 한 자리를 결재했다」고 답한다', () => {
  const document = pendingDocument(buildLine([
    { mode: 'parallel', approvers: ['AA', 'BB'] },
  ]))
  const once = approve(document, 'AA').document
  const twice = approve(once, 'AA')
  // 결재선 밖 사람이 받는 NOT_APPROVER 와 구별한다. 이 답을 받는 사람은 이미 이 문서에서 한 자리를
  // 눌렀거나 이름이 적혀 있어 결재선 구성을 이미 아는 사람이므로, 구별해도 밖으로 새는 사실이 없다.
  assert.equal(twice.error.code, APPROVAL_ERRORS.SEAT_TAKEN.code)
  assert.equal(twice.document, undefined)
})

test('9) 끝난 문서와 아직 상신하지 않은 문서는 둘 다 결재할 수 없되, 다른 사실로 답한다', () => {
  const line = buildLine([{ mode: 'sequential', approvers: ['AA'] }])
  for (const status of ['승인', '반려', '회수']) {
    const result = approve(pendingDocument(line, { status }), 'AA')
    assert.equal(result.error.code, APPROVAL_ERRORS.ALREADY_DECIDED.code, `${status} 상태에서 결재가 막혀야 한다`)
  }
  // 「아직 시작하지 않았다」를 「이미 끝났다」로 말하면 같은 응답에 실린 상태(기안)와 어긋난다.
  // 결재선에 이름이 적힌 사람은 상신 전 문서도 목록에서 보므로 실제로 눌러 볼 수 있는 자리다.
  const draft = approve(pendingDocument(line, { status: '기안' }), 'AA')
  assert.equal(draft.error.code, APPROVAL_ERRORS.NOT_SUBMITTED.code)
  assert.notEqual(draft.error.code, APPROVAL_ERRORS.ALREADY_DECIDED.code)
  assert.match(draft.error.message, /상신/)
})

test('9-1) 결재선 오류 문구는 이 파일의 상한 상수를 그대로 말한다 — 6명을 넣고 「2명 이상」을 듣지 않는다', () => {
  const message = APPROVAL_ERRORS.LINE_INVALID.message
  // 규칙 11: 범위를 말하는 문장은 돌아가는 코드에 대고 잰다. 상수를 고치면 이 단언이 먼저 빨개진다.
  assert.ok(message.includes(`2~${MAX_APPROVERS_PER_STEP}명`), `병렬 상한(${MAX_APPROVERS_PER_STEP})을 말하지 않는다 — ${message}`)
  assert.ok(message.includes(`${MAX_LINE_STEPS}개까지`), `단계 상한(${MAX_LINE_STEPS})을 말하지 않는다 — ${message}`)
  // 그 문장이 실제로 그 값에서 나온다: 6명은 거절, 5명은 통과.
  const tooMany = normalizeApprovalLine([{ mode: 'parallel', approvers: ['AA', 'BB', 'CC', 'DD', 'EE', 'FF'] }])
  assert.equal(tooMany.error.code, APPROVAL_ERRORS.LINE_INVALID.code)
  assert.equal(normalizeApprovalLine([{ mode: 'parallel', approvers: ['AA', 'BB', 'CC', 'DD', 'EE'] }]).error, undefined)
  const tooDeep = normalizeApprovalLine(Array.from({ length: MAX_LINE_STEPS + 1 }, (_value, index) => ({ mode: 'sequential', approvers: [`U${index}`] })))
  assert.equal(tooDeep.error.code, APPROVAL_ERRORS.LINE_INVALID.code)
})

test('10) 대결자가 대신 결재하면 결재자 칸과 이력에 원결재자가 남는다', () => {
  const document = pendingDocument(buildLine([{ mode: 'sequential', approvers: ['BB'] }]))
  const result = approve(document, 'CC', { actorName: '다결재', delegateFor: ['BB'] })
  assert.equal(result.error, undefined)
  const approver = currentStepOf(result.document).approvers[0]
  assert.equal(approver.decision, 'approved')
  assert.equal(approver.accountId, 'BB')
  assert.equal(approver.delegateOf, 'BB')
  assert.equal(result.document.history.at(-1).delegateOf, 'BB')
  assert.equal(result.document.history.at(-1).actorId, 'CC')
})

test('11) 대결 기간 밖이면 같은 요청이 거절된다 — delegateFor 가 비어 있을 뿐이다', () => {
  const document = pendingDocument(buildLine([{ mode: 'sequential', approvers: ['BB'] }]))
  const result = approve(document, 'CC', { delegateFor: [] })
  assert.equal(result.error.code, APPROVAL_ERRORS.NOT_APPROVER.code)
})

test('12) 입력 문서를 변형하지 않는다 — 깊게 얼린 문서도 던지지 않는다', () => {
  const document = deepFreeze(pendingDocument(buildLine([
    { mode: 'sequential', approvers: ['AA'] },
    { mode: 'sequential', approvers: ['BB'] },
  ])))
  const result = approve(document, 'AA')
  assert.equal(result.error, undefined)
  assert.equal(document.currentStep, 1, '원본의 단계가 그대로여야 한다')
  assert.equal(document.line[0].approvers[0].decision, 'pending', '원본 결재자가 그대로여야 한다')
  assert.equal(document.history.length, 0)
  assert.notEqual(result.document, document)
})

test('13) 이력은 상한에서 오래된 것부터 잘린다', () => {
  const history = Array.from({ length: MAX_HISTORY }, (unused, index) => ({
    at: NOW, actorId: 'X', actorName: 'X', action: `h${index}`, comment: '', delegateOf: null,
  }))
  const document = pendingDocument(buildLine([
    { mode: 'sequential', approvers: ['AA'] },
    { mode: 'sequential', approvers: ['BB'] },
  ]), { history })
  const result = approve(document, 'AA')
  assert.equal(result.document.history.length, MAX_HISTORY)
  assert.equal(result.document.history[0].action, 'h1')
  assert.equal(result.document.history.at(-1).action, '1단계 승인')
})

test('14) 회수는 아무도 결재하지 않았을 때만, 수정은 기안 상태에서만', () => {
  const line = buildLine([
    { mode: 'sequential', approvers: ['AA'] },
    { mode: 'sequential', approvers: ['BB'] },
  ])
  const untouched = pendingDocument(line)
  assert.equal(canRecall(untouched, 'DRAFT'), true)
  assert.equal(canRecall(approve(untouched, 'AA').document, 'DRAFT'), false)
  assert.equal(canRecall(pendingDocument(line, { status: '기안' }), 'DRAFT'), false)
  assert.equal(canRecall(untouched, 'AA'), false)
  assert.equal(canEditDraft(pendingDocument(line, { status: '기안' }), 'DRAFT'), true)
  assert.equal(canEditDraft(untouched, 'DRAFT'), false)
})

test('15) 결재선 정규화 — 모드별 인원·중복·본인·단계 수·번호 재부여', () => {
  const options = { drafterId: 'DRAFT', approverIds: ACCOUNTS }
  assert.equal(normalizeApprovalLine([{ mode: 'sequential', approvers: ['AA', 'BB'] }], options).error.code, APPROVAL_ERRORS.LINE_INVALID.code)
  assert.equal(normalizeApprovalLine([{ mode: 'parallel', approvers: ['AA'] }], options).error.code, APPROVAL_ERRORS.LINE_INVALID.code)
  assert.equal(normalizeApprovalLine([
    { mode: 'sequential', approvers: ['AA'] },
    { mode: 'sequential', approvers: ['AA'] },
  ], options).error.code, APPROVAL_ERRORS.LINE_DUPLICATE.code)
  assert.equal(normalizeApprovalLine([{ mode: 'sequential', approvers: ['DRAFT'] }], options).error.code, APPROVAL_ERRORS.LINE_SELF.code)
  assert.equal(normalizeApprovalLine([{ mode: 'sequential', approvers: ['ZZZ'] }], options).error.code, APPROVAL_ERRORS.LINE_UNKNOWN.code)

  const renumbered = normalizeApprovalLine([
    { step: 5, mode: 'sequential', approvers: ['AA'] },
    { step: 9, mode: 'sequential', approvers: ['BB'] },
  ], options)
  assert.deepEqual(renumbered.line.map((step) => step.step), [1, 2])
  assert.equal(renumbered.line[0].approvers[0].name, '가결재', '이름은 계정 표에서만 온다')
  assert.equal(renumbered.line[0].approvers[0].decision, 'pending')

  const nine = Array.from({ length: 9 }, () => ({ mode: 'sequential', approvers: ['AA'] }))
  assert.equal(normalizeApprovalLine(nine, options).error.code, APPROVAL_ERRORS.LINE_INVALID.code)

  assert.deepEqual(normalizeApprovalLine([], options).line, [], '빈 결재선은 양식 저장에서 허용된다')
  assert.equal(normalizeApprovalLine([], { ...options, requireSteps: true }).error.code, APPROVAL_ERRORS.LINE_REQUIRED.code)
  const fallback = normalizeApprovalLine(null, { ...options, defaultLine: [{ mode: 'sequential', approvers: ['BB'] }] })
  assert.equal(fallback.line[0].approvers[0].accountId, 'BB')

  // 본문이 「이미 승인된 자리」를 실어 보내도 결재선은 언제나 새로 pending 으로 만들어진다.
  const forged = normalizeApprovalLine([{
    mode: 'sequential',
    approvers: [{ accountId: 'AA', name: '가짜이름', decision: 'approved', decidedAt: NOW, comment: '통과', delegateOf: 'ZZ', decidedById: 'ZZ' }],
  }], options)
  const seat = forged.line[0].approvers[0]
  assert.equal(seat.decision, 'pending')
  assert.equal(seat.decidedAt, null)
  assert.equal(seat.comment, '')
  assert.equal(seat.delegateOf, null)
  assert.equal(seat.decidedById, null)
  assert.equal(seat.name, '가결재', '이름은 계정 표에서만 온다')
})

test('16) 값 정규화 — 필수·금액·날짜·선택지·미지의 키·글자 절단', () => {
  const missing = normalizeApprovalValues(sampleForm, { amount: 1000 })
  assert.equal(missing.error.code, APPROVAL_ERRORS.VALUE_REQUIRED.code)
  assert.equal(missing.error.key, 'purpose')

  for (const amount of [-1, Number.NaN, 1e13]) {
    const result = normalizeApprovalValues(sampleForm, { purpose: '출장', amount })
    assert.equal(result.error.code, APPROVAL_ERRORS.VALUE_INVALID.code)
    assert.equal(result.error.key, 'amount')
  }

  const badDate = normalizeApprovalValues(sampleForm, { purpose: '출장', spent_on: '2026-02-30' })
  assert.equal(badDate.error.key, 'spent_on')
  const badSelect = normalizeApprovalValues(sampleForm, { purpose: '출장', method: '현금' })
  assert.equal(badSelect.error.key, 'method')

  const unknown = normalizeApprovalValues(sampleForm, { purpose: '출장', zzz: 1 })
  assert.equal(unknown.error.code, APPROVAL_ERRORS.VALUE_INVALID.code)
  assert.equal(unknown.error.key, 'zzz')
  assert.equal(unknown.error.reason, 'unknown-field')

  const clipped = normalizeApprovalValues(sampleForm, { purpose: 'ㄱ'.repeat(1_001) })
  assert.equal(clipped.values.purpose.length, 1_000)

  const ok = normalizeApprovalValues(sampleForm, {
    purpose: '출장비', amount: 1_234.6, spent_on: '2026-03-02', method: '법인카드', receipt: 'DOC-2026-0001',
  })
  assert.equal(ok.error, undefined)
  assert.equal(ok.values.amount, 1_235, '금액은 원 단위로 반올림한다')
  assert.equal('nights' in ok.values, false, '비운 선택 항목은 키 자체를 남기지 않는다')
})

test('17) 금액 게시 — 집계 항목이 없거나 0이면 만들지 않는다', () => {
  const document = pendingDocument(buildLine([{ mode: 'sequential', approvers: ['AA'] }]), { values: { amount: 120_000 } })
  assert.equal(approvalPosting({ ...sampleForm, amountFieldKey: null }, document, NOW), null)
  assert.equal(approvalPosting(sampleForm, { ...document, values: { amount: 0 } }, NOW), null)
  assert.equal(approvalPosting(sampleForm, { ...document, values: {} }, NOW), null)

  const posting = approvalPosting(sampleForm, document, '2026-01-31T15:30:00.000Z')
  assert.equal(posting.month, '2026-02', 'KST 월 경계를 따른다')
  assert.equal(posting.amount, 120_000)
  assert.equal(posting.currency, 'KRW')
  assert.equal(posting.fieldKey, 'amount')
  assert.equal(posting.kind, '지출결의')
})

test('18) 게시의 월은 billingMonth 가 만든 월과 같은 값이다', () => {
  const document = pendingDocument(buildLine([{ mode: 'sequential', approvers: ['AA'] }]))
  for (const at of ['2026-01-31T15:30:00.000Z', '2026-01-31T14:30:00.000Z', '2026-12-31T23:59:00.000Z']) {
    assert.equal(approvalPosting(sampleForm, document, at).month, billingMonth(at))
  }
})

test('19) 승인된 지출 집계 — 6개월 창·종류별 합·창 밖 제외·본인 범위·「승인」만·창 크기 상한', () => {
  const documents = [
    { drafterId: 'U1', kind: '지출결의', status: '승인', posting: { month: '2026-03', amount: 100_000, currency: 'KRW', kind: '지출결의' } },
    { drafterId: 'U2', kind: '구매요청', status: '승인', posting: { month: '2026-03', amount: 50_000, currency: 'KRW', kind: '구매요청' } },
    { drafterId: 'U1', kind: '지출결의', status: '승인', posting: { month: '2026-01', amount: 70_000, currency: 'KRW', kind: '지출결의' } },
    { drafterId: 'U1', kind: '지출결의', status: '승인', posting: { month: '2025-09', amount: 999_000, currency: 'KRW', kind: '지출결의' } },
    { drafterId: 'U1', kind: '지출결의', status: '승인', posting: null },
  ]
  const all = summarizePostings(documents, { now: NOW })
  assert.equal(all.months.length, 6)
  assert.deepEqual(all.months.map((entry) => entry.month), ['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03'])

  const march = all.months.at(-1)
  assert.equal(march.amount, 150_000)
  assert.equal(march.count, 2)
  assert.deepEqual(march.byKind, [
    { kind: '지출결의', amount: 100_000, count: 1 },
    { kind: '구매요청', amount: 50_000, count: 1 },
  ])
  for (const entry of all.months) {
    assert.equal(entry.byKind.reduce((sum, kind) => sum + kind.amount, 0), entry.amount, `${entry.month} 종류별 합이 월 합계와 같아야 한다`)
    assert.equal(entry.byKind.reduce((sum, kind) => sum + kind.count, 0), entry.count, `${entry.month} 종류별 건수가 월 건수와 같아야 한다`)
  }
  assert.equal(all.months.reduce((sum, entry) => sum + entry.amount, 0), 220_000, '창 밖(2025-09) 문서는 세지 않는다')

  const mine = summarizePostings(documents, { now: NOW, scopeIds: ['U1'] })
  assert.equal(mine.months.at(-1).amount, 100_000)
  assert.equal(mine.months.at(-1).count, 1)
  assert.equal(mine.months.find((entry) => entry.month === '2026-01').amount, 70_000)

  // 「승인된 지출」이라고 이름 붙은 함수는 status 를 직접 읽는다. 게시가 언제 찍히든 집계가 흔들리지 않는다.
  const notApproved = summarizePostings([
    { drafterId: 'U1', kind: '지출결의', status: '반려', posting: { month: '2026-03', amount: 7_000_000, currency: 'KRW', kind: '지출결의' } },
    { drafterId: 'U1', kind: '지출결의', status: '회수', posting: { month: '2026-03', amount: 3_000_000, currency: 'KRW', kind: '지출결의' } },
    { drafterId: 'U1', kind: '지출결의', status: '결재중', posting: { month: '2026-03', amount: 1_000_000, currency: 'KRW', kind: '지출결의' } },
    { drafterId: 'U1', kind: '지출결의', posting: { month: '2026-03', amount: 5_000_000, currency: 'KRW', kind: '지출결의' } },
    { drafterId: 'U1', kind: '지출결의', status: '승인', posting: { month: '2026-03', amount: 20_000, currency: 'KRW', kind: '지출결의' } },
  ], { now: NOW }).months.at(-1)
  assert.equal(notApproved.amount, 20_000, '반려·회수·결재중·status 없는 문서의 게시는 세지 않는다')
  assert.equal(notApproved.count, 1)

  // 창 크기는 선언된 상한 안에서만 받는다 — 자르지 않고 거절한다(구조는 거절한다).
  assert.equal(summarizePostings(documents, { now: NOW, months: MAX_POSTING_MONTHS }).months.length, MAX_POSTING_MONTHS)
  assert.equal(summarizePostings(documents, { now: NOW, months: MIN_POSTING_MONTHS }).months.length, MIN_POSTING_MONTHS)
  for (const months of [MAX_POSTING_MONTHS + 1, MIN_POSTING_MONTHS - 1, -5, 6.7, '12', null, Number.NaN]) {
    const rejected = summarizePostings(documents, { now: NOW, months })
    assert.equal(rejected.error.code, APPROVAL_ERRORS.VALUE_INVALID.code, `months=${String(months)} 는 조용히 잘리지 않는다`)
    assert.equal(rejected.error.key, 'months')
    assert.equal(rejected.months, undefined)
  }
})

test('20) 증빙 분류 여섯은 세무 내보내기의 TAX_BUCKETS 와 문자 그대로 같다', () => {
  const source = readFileSync(new URL('./tax-evidence-export.mjs', import.meta.url), 'utf8')
  const match = source.match(/const TAX_BUCKETS = new Set\(\[([^\]]*)\]\)/)
  assert.ok(match, 'tax-evidence-export.mjs 에서 TAX_BUCKETS 선언을 찾지 못했다')
  const buckets = match[1].split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => entry.slice(1, -1))
  assert.deepEqual(buckets, [...TAX_EVIDENCE_CATEGORIES])
})

test('21) 양식 정규화 — 종류·금액 항목·증빙 분류·항목 순서', () => {
  assert.equal(sampleForm.id.startsWith('AFM-'), true)
  assert.equal(sampleForm.version, 1)
  assert.equal(sampleForm.createdById, ACTOR.id)
  assert.deepEqual(sampleForm.fields.map((field) => field.position), [0, 1, 2, 3, 4, 5])

  const badKind = normalizeApprovalForm({ name: '아무거나', kind: '없는종류', fields: [{ key: 'a', label: 'ㄱ', type: 'text' }] }, { actor: ACTOR, now: NOW })
  assert.equal(badKind.error.code, APPROVAL_ERRORS.FORM_KIND_INVALID.code)

  const badAmount = normalizeApprovalForm({
    name: '지출결의서', kind: '지출결의', amountFieldKey: 'purpose',
    fields: [{ key: 'purpose', label: '사유', type: 'text' }],
  }, { actor: ACTOR, now: NOW })
  assert.equal(badAmount.error.code, APPROVAL_ERRORS.AMOUNT_FIELD_INVALID.code)

  const badEvidence = normalizeApprovalForm({
    name: '지출결의서', kind: '지출결의', evidenceCategory: '접대비',
    fields: [{ key: 'purpose', label: '사유', type: 'text' }],
  }, { actor: ACTOR, now: NOW })
  assert.equal(badEvidence.error.code, APPROVAL_ERRORS.EVIDENCE_INVALID.code)

  const badKey = normalizeApprovalForm({
    name: '지출결의서', kind: '지출결의', fields: [{ key: 'Purpose', label: '사유', type: 'text' }],
  }, { actor: ACTOR, now: NOW })
  assert.equal(badKey.error.code, APPROVAL_ERRORS.FIELD_INVALID.code)

  const updated = normalizeApprovalForm({ ...sampleForm, name: '지출결의서(개정)' }, { actor: ACTOR, now: LATER, previous: sampleForm })
  assert.equal(updated.form.id, sampleForm.id, '갱신은 id 를 그대로 쓴다')
  assert.equal(updated.form.version, 2)
  assert.equal(updated.form.createdAt, sampleForm.createdAt)
  assert.equal(updated.form.updatedAt, LATER)

  // id·순서·작성자·시각은 본문이 정하지 못한다. 본문이 정하는 것은 「무엇을 적었는가」뿐이다.
  const forged = normalizeApprovalForm({
    id: 'AFM-ATTACKER-0001',
    version: 99,
    createdById: 'ATTACKER',
    createdByName: '공격자',
    createdAt: '1999-01-01T00:00:00.000Z',
    updatedAt: '1999-01-01T00:00:00.000Z',
    updatedById: 'ATTACKER',
    name: '지출결의서', kind: '지출결의',
    fields: [
      { key: 'second', label: '둘째', type: 'text', position: 9 },
      { key: 'first', label: '첫째', type: 'text', position: 0 },
    ],
  }, { actor: ACTOR, now: NOW })
  assert.notEqual(forged.form.id, 'AFM-ATTACKER-0001', '본문이 보낸 id 는 쓰이지 않는다')
  assert.equal(forged.form.id.startsWith(`AFM-${new Date(NOW).getTime().toString(36).toUpperCase()}-`), true, 'id 는 주입한 시계로 서버가 만든다')
  assert.deepEqual(forged.form.fields.map((field) => field.position), [0, 1], 'position 은 배열 순서로 재부여된다')
  assert.equal(forged.form.fields[0].key, 'second', '본문의 position 값이 순서를 뒤집지 못한다')
  assert.equal(forged.form.version, 1)
  assert.equal(forged.form.createdById, ACTOR.id)
  assert.equal(forged.form.createdByName, ACTOR.name)
  assert.equal(forged.form.createdAt, NOW, '작성 시각은 주입한 시계에서만 온다')
  assert.equal(forged.form.updatedAt, NOW)
  assert.equal(forged.form.updatedById, ACTOR.id)

  // 갱신에서도 최초 작성자·최초 시각은 이전 판이 이긴다.
  const forgedUpdate = normalizeApprovalForm(
    { ...sampleForm, id: 'AFM-ATTACKER-0002', createdById: 'ATTACKER', createdAt: '1999-01-01T00:00:00.000Z' },
    { actor: { id: 'OTHER', name: '딴사람' }, now: LATER, previous: sampleForm },
  )
  assert.equal(forgedUpdate.form.id, sampleForm.id)
  assert.equal(forgedUpdate.form.createdById, sampleForm.createdById)
  assert.equal(forgedUpdate.form.createdAt, sampleForm.createdAt)
  assert.equal(forgedUpdate.form.updatedById, 'OTHER', '고친 사람은 세션이 정한다')
})

test('22) 대결자 지정 — 본인 지정 거절·기간 역전 거절·사슬 거절', () => {
  const base = { accountId: 'BB', accounts: ACCOUNTS, now: NOW, actor: { id: 'BB' } }
  assert.equal(normalizeDelegate({ delegateId: 'BB', from: '2026-03-01', to: '2026-03-31' }, base).error.code, APPROVAL_ERRORS.DELEGATE_INVALID.code)
  assert.equal(normalizeDelegate({ delegateId: 'ZZZ', from: '2026-03-01', to: '2026-03-31' }, base).error.code, APPROVAL_ERRORS.DELEGATE_INVALID.code)
  assert.equal(normalizeDelegate({ delegateId: 'CC', from: '2026-03-31', to: '2026-03-01' }, base).error.code, APPROVAL_ERRORS.DELEGATE_INVALID.code)
  assert.equal(normalizeDelegate({ delegateId: 'CC', from: '2026-02-30', to: '2026-03-01' }, base).error.code, APPROVAL_ERRORS.DELEGATE_INVALID.code)
  assert.equal(normalizeDelegate({ delegateId: 'CC', from: '2026-03-01', to: '2026-03-31' }, { ...base, accountId: 'GONE' }).error.code,
    APPROVAL_ERRORS.DELEGATE_INVALID.code, '맡기는 사람도 이 회사의 계정이어야 한다')

  const chained = normalizeDelegate({ delegateId: 'CC', from: '2026-03-01', to: '2026-03-31' }, {
    ...base,
    existingDelegates: [{ accountId: 'CC', delegateId: 'DD', from: '2026-03-10', to: '2026-03-20' }],
  })
  assert.equal(chained.error.code, APPROVAL_ERRORS.DELEGATE_CYCLE.code, '고른 대결자가 이미 대결자를 두면 사슬이다')

  const alreadyDelegate = normalizeDelegate({ delegateId: 'CC', from: '2026-03-01', to: '2026-03-31' }, {
    ...base,
    existingDelegates: [{ accountId: 'AA', delegateId: 'BB', from: '2026-03-05', to: '2026-03-06' }],
  })
  assert.equal(alreadyDelegate.error.code, APPROVAL_ERRORS.DELEGATE_CYCLE.code, '이미 남의 대결자면 사슬이다')

  const apart = normalizeDelegate({ delegateId: 'CC', from: '2026-03-01', to: '2026-03-31' }, {
    ...base,
    existingDelegates: [{ accountId: 'CC', delegateId: 'DD', from: '2026-05-01', to: '2026-05-10' }],
  })
  assert.equal(apart.error, undefined, '기간이 겹치지 않으면 사슬이 아니다')
  assert.equal(apart.delegate.id, 'ADG-BB')
  assert.equal(apart.delegate.accountId, 'BB')
  assert.equal(apart.delegate.delegateName, '다결재')
  assert.equal(apart.delegate.updatedAt, NOW)
})

test('23) 시계를 주지 않으면 던진다 — 이 파일은 벽시계를 읽지 않는다', () => {
  const document = pendingDocument(buildLine([{ mode: 'sequential', approvers: ['AA'] }]))
  assert.throws(() => applyApprovalDecision(document, { actorId: 'AA', decision: 'approve' }), TypeError)
  assert.throws(() => approvalPosting(sampleForm, document, undefined), TypeError)
  assert.throws(() => summarizePostings([], {}), TypeError)
  assert.throws(() => normalizeApprovalForm({ name: 'ㄱ', kind: '기안', fields: [] }, { actor: ACTOR }), TypeError)
})

test('24) 승인·반려가 아닌 결정은 값 오류로 거절된다', () => {
  const document = pendingDocument(buildLine([{ mode: 'sequential', approvers: ['AA'] }]))
  const result = applyApprovalDecision(document, { actorId: 'AA', decision: 'maybe', now: LATER })
  assert.equal(result.error.code, APPROVAL_ERRORS.VALUE_INVALID.code)
  assert.equal(result.error.key, 'decision')
})

test('25) 결재선이 끊긴 문서는 손상으로 답한다', () => {
  const document = pendingDocument(buildLine([{ mode: 'sequential', approvers: ['AA'] }]), { currentStep: 7 })
  assert.equal(approve(document, 'AA').error.code, APPROVAL_ERRORS.LINE_BROKEN.code)
  assert.equal(currentStepOf(document), null)
  assert.deepEqual(pendingApproverIds(document), [])

  // 결재선이 멀쩡해도 「결재중」이 아니면 대기 결재자는 없다. 이 가드가 무너지면 끝난 문서가 승인 큐에 계속 남는다.
  const sound = buildLine([{ mode: 'sequential', approvers: ['AA'] }])
  assert.deepEqual(pendingApproverIds(pendingDocument(sound)), ['AA'])
  for (const status of ['승인', '반려', '회수', '기안']) {
    assert.deepEqual(pendingApproverIds(pendingDocument(sound, { status })), [], `${status} 문서는 대기 결재자가 없다`)
  }

  // 단계 번호가 없는 결재선 — undefined === undefined 로 아무 단계나 골라선 안 된다.
  // 골라 버리면 결재 반영이 단계를 번호로 되찾지 못해 결재선 전체를 한 단계로 덮어쓴다.
  const numberless = buildLine([
    { mode: 'sequential', approvers: ['AA'] },
    { mode: 'sequential', approvers: ['BB'] },
  ]).map(({ mode, approvers }) => ({ mode, approvers }))
  const noStep = pendingDocument(numberless, { currentStep: undefined })
  assert.equal(currentStepOf(noStep), null, '번호가 없으면 단계를 고르지 않는다')
  const wrecked = approve(noStep, 'AA')
  assert.equal(wrecked.error.code, APPROVAL_ERRORS.LINE_BROKEN.code)
  assert.equal(wrecked.document, undefined, '결재선을 한 단계로 덮어쓴 문서를 만들지 않는다')
  assert.equal(currentStepOf(pendingDocument(sound, { currentStep: '1' })), null, '문자열 번호도 단계를 고르지 못한다')

  // currentStep 만 앞서 있고 앞 단계가 pending 인 문서 — 한 사람의 클릭으로 「승인」이 되어선 안 된다.
  const jumped = pendingDocument(buildLine([
    { mode: 'sequential', approvers: ['AA'] },
    { mode: 'sequential', approvers: ['BB'] },
  ]), { currentStep: 2 })
  const skipped = approve(jumped, 'BB')
  assert.equal(skipped.error.code, APPROVAL_ERRORS.LINE_BROKEN.code, '앞 단계가 끝나지 않은 문서는 손상이다')
  assert.equal(skipped.document, undefined)

  // 앞 단계가 실제로 끝난 문서는 그대로 진행한다 — 손상 판정이 정상 경로를 막지 않는다.
  const twoStep = pendingDocument(buildLine([
    { mode: 'sequential', approvers: ['AA'] },
    { mode: 'sequential', approvers: ['BB'] },
  ]))
  const second = approve(approve(twoStep, 'AA').document, 'BB')
  assert.equal(second.error, undefined)
  assert.equal(second.document.status, '승인')
})

test('26) 기안자는 대결로도 자기 문서를 결재하지 못한다', () => {
  // 결재선에 이름이 적혔을 때(LINE_SELF)와 대결자로 들어올 때는 같은 사실이다 —
  // 「기안자는 자기 문서를 결재하지 않는다」. 그래서 판정도 한 곳에 있어야 한다.
  const document = pendingDocument(buildLine([{ mode: 'sequential', approvers: ['BB'] }]))
  const asDelegate = approve(document, 'DRAFT', { actorName: '기안자', delegateFor: ['BB'] })
  assert.equal(asDelegate.error.code, APPROVAL_ERRORS.NOT_APPROVER.code)
  assert.equal(asDelegate.document, undefined)

  // 여러 자리의 대결을 한꺼번에 쥐어도 마찬가지다.
  const wide = pendingDocument(buildLine([
    { mode: 'sequential', approvers: ['AA'] },
    { mode: 'parallel', approvers: ['BB', 'CC'] },
    { mode: 'sequential', approvers: ['DD'] },
  ]))
  const swept = approve(wide, 'DRAFT', { delegateFor: ['AA', 'BB', 'CC', 'DD'] })
  assert.equal(swept.error.code, APPROVAL_ERRORS.NOT_APPROVER.code)

  // 반려도 같은 문장이 막는다 — 기안자가 자기 문서를 스스로 되돌리는 뒷문도 없다.
  const rejected = applyApprovalDecision(document, {
    actorId: 'DRAFT', actorName: '기안자', decision: 'reject', reason: '내가 무를게요', now: LATER, delegateFor: ['BB'],
  })
  assert.equal(rejected.error.code, APPROVAL_ERRORS.NOT_APPROVER.code)
})

test('27) 한 사람은 이 결재선에서 자리 하나만 채운다 — 단계를 옮겨도 같다', () => {
  // 자기 자리도 있고 다른 결재자의 대결자이기도 한 사람이 두 번 눌러 합의를 혼자 만드는 길.
  const both = pendingDocument(buildLine([{ mode: 'parallel', approvers: ['BB', 'CC'] }]))
  const once = approve(both, 'CC', { delegateFor: ['BB'] })
  assert.equal(once.error, undefined)
  assert.equal(once.document.status, '결재중', '자기 자리가 먼저다 — 대결 자리는 잡지 않는다')
  assert.deepEqual(pendingApproverIds(once.document), ['BB'])
  assert.equal(approve(once.document, 'CC', { delegateFor: ['BB'] }).error.code, APPROVAL_ERRORS.SEAT_TAKEN.code)

  // 두 결재자가 같은 사람을 대결자로 지정해도, 그 한 사람이 2인 합의를 혼자 완성하지 못한다.
  const line = buildLine([
    { mode: 'parallel', approvers: ['AA', 'BB'] },
    { mode: 'sequential', approvers: ['DD'] },
  ])
  const first = approve(pendingDocument(line), 'CC', { delegateFor: ['AA', 'BB'] })
  assert.equal(first.error, undefined)
  const filled = currentStepOf(first.document).approvers.find((entry) => entry.accountId === 'AA')
  assert.equal(filled.decision, 'approved')
  assert.equal(filled.delegateOf, 'AA')
  assert.equal(filled.decidedById, 'CC', '자리를 실제로 채운 사람이 자리에 남는다')

  const second = approve(first.document, 'CC', { delegateFor: ['AA', 'BB'] })
  assert.equal(second.error.code, APPROVAL_ERRORS.SEAT_TAKEN.code)
  assert.equal(first.document.currentStep, 1, '단계가 혼자 완결되지 않는다')
  assert.deepEqual(pendingApproverIds(first.document), ['BB'])
})

test('32) 대결을 몰아 쥐어도 다단계 결재선을 혼자 끝내지 못한다', () => {
  // 관리자는 결재선 밖에서 직접 결재하지 못하지만, 모든 결재자의 대결자로 자기를 지정하면
  // 「자리 하나」 규칙이 단계 범위이던 시절에는 단계를 옮겨 가며 결재선 전체를 혼자 채웠다.
  const line = buildLine([
    { mode: 'sequential', approvers: ['AA'] },
    { mode: 'sequential', approvers: ['BB'] },
    { mode: 'sequential', approvers: ['CC'] },
  ])
  const delegateFor = ['AA', 'BB', 'CC']
  const first = approve(pendingDocument(line), ACTOR.id, { delegateFor })
  assert.equal(first.error, undefined, '첫 자리는 대결로 정상 결재된다')
  assert.equal(first.document.currentStep, 2)

  const second = approve(first.document, ACTOR.id, { delegateFor })
  assert.equal(second.error.code, APPROVAL_ERRORS.SEAT_TAKEN.code, '두 번째 단계의 자리는 같은 사람이 잡지 못한다')
  assert.equal(first.document.status, '결재중')
  const pressers = first.document.line.flatMap((step) => step.approvers).map((entry) => entry.decidedById).filter(Boolean)
  assert.deepEqual(pressers, [ACTOR.id], '한 사람이 채운 자리는 끝까지 하나뿐이다')

  // 자기 이름이 뒤 단계에 적힌 사람은 앞 단계의 대결 자리를 애초에 잡지 못한다.
  // (잡게 두면 자기 자리에서 스스로 잠겨 아무도 풀 수 없는 교착이 된다.)
  const mixed = pendingDocument(normalizeApprovalLine([
    { mode: 'sequential', approvers: ['AA'] },
    { mode: 'sequential', approvers: ['CC'] },
  ], { drafterId: 'DD', approverIds: ACCOUNTS }).line, { drafterId: 'DD', drafterName: '라결재' })
  const jump = approve(mixed, 'CC', { delegateFor: ['AA'] })
  assert.equal(jump.error.code, APPROVAL_ERRORS.NOT_APPROVER.code, '자기 차례가 아니라고 답한다 — 자리를 뺏은 것이 아니다')
  assert.equal(currentStepOf(mixed).approvers[0].decision, 'pending', 'AA 의 자리는 AA 나 다른 대결자를 위해 그대로 남는다')

  // 두 사람이 나눠 누르면 정상 진행한다 — 규칙이 정상 경로를 막지 않는다.
  const shared = approve(first.document, 'DD', { delegateFor: ['BB'] })
  assert.equal(shared.error, undefined)
  assert.equal(shared.document.currentStep, 3)
})

test('33) 이미 한 자리를 채운 사람에게는 참인 이유를 말하고, 목록도 같은 술어를 쓴다', () => {
  // 병렬 두 자리가 같은 대결자를 둔 모양. CC 가 한 자리를 채우면 남은 자리는 CC 로는 못 채운다.
  const line = buildLine([{ mode: 'parallel', approvers: ['AA', 'BB'] }])
  const stuck = approve(pendingDocument(line), 'CC', { delegateFor: ['AA', 'BB'] }).document

  const blocked = approve(stuck, 'CC', { delegateFor: ['AA', 'BB'] })
  assert.equal(blocked.error.code, APPROVAL_ERRORS.SEAT_TAKEN.code)
  assert.match(blocked.error.message, /이미 한 자리를 결재/, '화면이 「대결자를 바꾸거나 원결재자를 기다리라」고 말할 수 있어야 한다')
  assert.notEqual(blocked.error.code, APPROVAL_ERRORS.NOT_APPROVER.code)

  // 「내 차례인가」를 묻는 술어와 실제 결재가 같은 답을 준다 — 배지·대기함과 결재 가능 여부가 갈리지 않는다.
  assert.equal(canDecide(stuck, 'CC', ['AA', 'BB']), false, '남은 자리를 못 잡는 사람은 목록에도 오르지 않는다')
  assert.equal(canDecide(stuck, 'BB', []), true, '원결재자 본인은 그대로 누를 수 있다')
  assert.equal(canDecide(stuck, 'DD', ['BB']), true, '결재선 밖의 다른 대결자를 지정하면 그 사람이 풀 수 있다')
  assert.equal(canDecide(stuck, 'DRAFT', ['AA', 'BB']), false, '기안자는 대결로도 잡지 못한다')
  assert.equal(canDecide(pendingDocument(line, { status: '승인' }), 'AA', []), false, '끝난 문서는 아무도 누를 수 없다')

  const seat = approvalSeatFor(stuck, { actorId: 'DD', delegateFor: ['BB'] })
  assert.equal(seat.seat.accountId, 'BB')
  assert.equal(seat.delegateOf, 'BB')
  assert.equal(approvalSeatFor(stuck, { actorId: 'CC', delegateFor: ['AA', 'BB'] }).error.code, APPROVAL_ERRORS.SEAT_TAKEN.code)
  assert.equal(approvalSeatFor(stuck, { actorId: 'ZZ', delegateFor: [] }).error.code, APPROVAL_ERRORS.NOT_APPROVER.code)
})

test('28) 행위자 없이는 결재가 만들어지지 않는다 — 자격은 세션에서만 온다', () => {
  const document = pendingDocument(buildLine([{ mode: 'sequential', approvers: ['AA'] }]))
  assert.throws(() => applyApprovalDecision(document, { decision: 'approve', now: LATER, delegateFor: ['AA'] }), TypeError)
  assert.throws(() => applyApprovalDecision(document, { actorId: '   ', decision: 'approve', now: LATER, delegateFor: ['AA'] }), TypeError)
})

test('29) 결재선은 모양이 어긋나면 거절한다 — 조용히 기본 결재선으로 떨어지지 않는다', () => {
  const options = { drafterId: 'DRAFT', approverIds: ACCOUNTS, defaultLine: [{ mode: 'sequential', approvers: ['AA'] }] }
  for (const shape of [{ mode: 'sequential', approvers: ['BB'] }, 'sequential:BB', 42, true]) {
    assert.equal(normalizeApprovalLine(shape, options).error.code, APPROVAL_ERRORS.LINE_INVALID.code, `${JSON.stringify(shape)} 는 거절되어야 한다`)
  }
  assert.equal(
    normalizeApprovalLine(null, { ...options, defaultLine: { mode: 'sequential', approvers: ['AA'] } }).error.code,
    APPROVAL_ERRORS.LINE_INVALID.code,
    '기본 결재선도 모양이 어긋나면 빈 배열로 조용히 저장되지 않는다',
  )
  // 아예 고르지 않았을 때(null)만 기본 결재선으로 떨어진다. 빈 배열은 테스트 34 가 맡는다.
  assert.equal(normalizeApprovalLine(null, options).line[0].approvers[0].accountId, 'AA')

  const form = normalizeApprovalForm({
    name: '지출결의서', kind: '지출결의', defaultLine: { mode: 'sequential', approvers: ['AA'] },
    fields: [{ key: 'purpose', label: '사유', type: 'text' }],
  }, { actor: ACTOR, now: NOW })
  assert.equal(form.error.code, APPROVAL_ERRORS.LINE_INVALID.code, '양식 저장도 같은 문장을 쓴다')
})

test('30) 항목 key 가 프로토타입 이름이어도 제 값만 읽는다', () => {
  // 건설 도메인에서 「시공사」를 constructor 로 두는 것은 실제로 있을 수 있다.
  const built = normalizeApprovalForm({
    name: '공사 품의서', kind: '품의',
    fields: [
      { key: 'item', label: '품목', type: 'text', required: true },
      { key: 'constructor', label: '시공사', type: 'text' },
    ],
  }, { actor: ACTOR, now: NOW })
  assert.equal(built.error, undefined)

  const partial = normalizeApprovalValues(built.form, { item: '철근 20t' })
  assert.equal(partial.error, undefined, '비운 선택 항목이 프로토타입 값을 집어 400 이 되지 않는다')
  assert.equal(Object.hasOwn(partial.values, 'constructor'), false)
  const filled = normalizeApprovalValues(built.form, { item: '철근 20t', constructor: '가나건설' })
  assert.deepEqual(filled.values, { item: '철근 20t', constructor: '가나건설' })

  const required = normalizeApprovalForm({
    name: '공사 품의서', kind: '품의', fields: [{ key: 'constructor', label: '시공사', type: 'text', required: true }],
  }, { actor: ACTOR, now: NOW })
  const empty = normalizeApprovalValues(required.form, {})
  assert.equal(empty.error.code, APPROVAL_ERRORS.VALUE_REQUIRED.code, '필수인데 비면 「필수」라고 답한다')
  assert.equal(empty.error.key, 'constructor')
})

test('31) 선언한 상한은 상한에서 받고 그 너머에서 거절하거나 자른다', () => {
  const formOf = (patch) => normalizeApprovalForm({
    name: '상한시험', kind: '기안', fields: [{ key: 'purpose', label: '사유', type: 'text' }], ...patch,
  }, { actor: ACTOR, now: NOW })

  // 항목 수 — 0개도 상한+1개도 같은 거절이다. key 중복도 같다.
  const manyFields = Array.from({ length: MAX_FIELDS_PER_FORM }, (unused, index) => ({ key: `f${index}`, label: 'ㄱ', type: 'text' }))
  assert.equal(formOf({ fields: manyFields }).error, undefined)
  assert.equal(formOf({ fields: [...manyFields, { key: 'over', label: 'ㄱ', type: 'text' }] }).error.code, APPROVAL_ERRORS.FIELD_INVALID.code)
  assert.equal(formOf({ fields: [] }).error.code, APPROVAL_ERRORS.FIELD_INVALID.code)
  assert.equal(formOf({ fields: [{ key: 'a', label: 'ㄱ', type: 'text' }, { key: 'a', label: 'ㄴ', type: 'text' }] }).error.code, APPROVAL_ERRORS.FIELD_INVALID.code)

  // 선택지 — 개수 상한·빈 값·중복은 거절, 한 줄 길이는 절단.
  const optionList = Array.from({ length: MAX_OPTIONS_PER_FIELD }, (unused, index) => `o${index}`)
  const selectOf = (options) => formOf({ fields: [{ key: 'pick', label: '고르기', type: 'select', options }] })
  assert.equal(selectOf(optionList).error, undefined)
  assert.equal(selectOf([...optionList, 'over']).error.code, APPROVAL_ERRORS.FIELD_INVALID.code)
  assert.equal(selectOf([]).error.code, APPROVAL_ERRORS.FIELD_INVALID.code)
  assert.equal(selectOf(['ㄱ', '']).error.code, APPROVAL_ERRORS.FIELD_INVALID.code)
  assert.equal(selectOf(['ㄱ', 'ㄱ']).error.code, APPROVAL_ERRORS.FIELD_INVALID.code)
  assert.equal(selectOf(['ㄱ'.repeat(MAX_OPTION_VALUE + 1)]).form.fields[0].options[0].length, MAX_OPTION_VALUE)

  // 참조자
  const cc = Array.from({ length: MAX_CC }, (unused, index) => `C${index}`)
  assert.equal(formOf({ ccIds: cc }).form.ccIds.length, MAX_CC)
  assert.equal(formOf({ ccIds: [...cc, 'OVER'] }).error.code, APPROVAL_ERRORS.FORM_INVALID.code)

  // 사람이 읽는 글자는 자른다(거절하지 않는다).
  assert.equal(formOf({ name: 'ㄱ'.repeat(MAX_TITLE + 1) }).form.name.length, MAX_TITLE)
  assert.equal(formOf({ description: 'ㄱ'.repeat(MAX_HELP + 1) }).form.description.length, MAX_HELP)
  const clipped = formOf({ fields: [{ key: 'purpose', label: 'ㄱ'.repeat(MAX_LABEL + 1), type: 'text', help: 'ㄴ'.repeat(MAX_HELP + 1) }] }).form.fields[0]
  assert.equal(clipped.label.length, MAX_LABEL)
  assert.equal(clipped.help.length, MAX_HELP)

  // 결재선 — 단계 수와 한 단계 결재자 수
  const anyone = { drafterId: null, approverIds: null }
  const steps = (count) => Array.from({ length: count }, (unused, index) => ({ mode: 'sequential', approvers: [`P${index}`] }))
  assert.equal(normalizeApprovalLine(steps(MAX_LINE_STEPS), anyone).line.length, MAX_LINE_STEPS)
  assert.equal(normalizeApprovalLine(steps(MAX_LINE_STEPS + 1), anyone).error.code, APPROVAL_ERRORS.LINE_INVALID.code)
  const parallelOf = (count) => [{ mode: 'parallel', approvers: Array.from({ length: count }, (unused, index) => `P${index}`) }]
  assert.equal(normalizeApprovalLine(parallelOf(MAX_APPROVERS_PER_STEP), anyone).line[0].approvers.length, MAX_APPROVERS_PER_STEP)
  assert.equal(normalizeApprovalLine(parallelOf(MAX_APPROVERS_PER_STEP + 1), anyone).error.code, APPROVAL_ERRORS.LINE_INVALID.code)

  // 값 — 금액·수·첨부 id
  const valueForm = formOf({ fields: [
    { key: 'amount', label: '금액', type: 'money' },
    { key: 'count', label: '개수', type: 'number' },
    { key: 'receipt', label: '영수증', type: 'attachment' },
  ] }).form
  assert.equal(normalizeApprovalValues(valueForm, { amount: MAX_MONEY }).values.amount, MAX_MONEY)
  assert.equal(normalizeApprovalValues(valueForm, { amount: MAX_MONEY + 1 }).error.code, APPROVAL_ERRORS.VALUE_INVALID.code)
  assert.equal(normalizeApprovalValues(valueForm, { count: 1e12 }).values.count, 1e12)
  assert.equal(normalizeApprovalValues(valueForm, { count: -1e12 }).values.count, -1e12)
  for (const count of [1e12 + 1, -(1e12 + 1)]) {
    assert.equal(normalizeApprovalValues(valueForm, { count }).error.code, APPROVAL_ERRORS.VALUE_INVALID.code)
  }
  assert.equal(normalizeApprovalValues(valueForm, { receipt: 'DOC-abcd' }).values.receipt, 'DOC-abcd')
  assert.equal(normalizeApprovalValues(valueForm, { receipt: 'DOC-abc' }).error.code, APPROVAL_ERRORS.VALUE_INVALID.code)

  // 0 은 한 가지 모양뿐이다 — -0 이 남으면 ko-KR 서식이 인쇄물 금액 칸에 「-0원」을 찍는다.
  for (const amount of [-0, -0.4, -0.5, -0.49]) {
    const zero = normalizeApprovalValues(valueForm, { amount }).values.amount
    assert.equal(zero, 0)
    assert.ok(Object.is(zero, 0), `money ${amount} → -0 이 남지 않는다`)
    assert.equal(zero.toLocaleString('ko-KR'), '0')
  }
  const negZero = normalizeApprovalValues(valueForm, { count: -0 }).values.count
  assert.ok(Object.is(negZero, 0), 'number 도 같다 — 같은 사실이므로 같은 답이어야 한다')

  // 의견·반려 사유도 자른다.
  const document = pendingDocument(buildLine([{ mode: 'sequential', approvers: ['AA'] }]))
  const long = approve(document, 'AA', { comment: 'ㄱ'.repeat(MAX_COMMENT + 1) })
  assert.equal(long.document.history.at(-1).comment.length, MAX_COMMENT)
  assert.equal(currentStepOf(long.document).approvers[0].comment.length, MAX_COMMENT)
  const rejected = applyApprovalDecision(document, {
    actorId: 'AA', actorName: 'AA', decision: 'reject', reason: 'ㄱ'.repeat(MAX_REJECTION_REASON + 1), now: LATER,
  })
  assert.equal(rejected.document.rejectionReason.length, MAX_REJECTION_REASON)

  // 집계는 원화만 더한다 — 통화가 섞이면 더한 수가 아무 뜻이 없다.
  const mixed = summarizePostings([
    { drafterId: 'U1', status: '승인', posting: { month: '2026-03', amount: 10_000, currency: 'KRW', kind: '기안' } },
    { drafterId: 'U1', status: '승인', posting: { month: '2026-03', amount: 99_000, currency: 'USD', kind: '기안' } },
  ], { now: NOW })
  assert.equal(mixed.months.at(-1).amount, 10_000)
  assert.equal(mixed.months.at(-1).count, 1)
})

test('34) 결재선을 비운 채로 보내면 양식 기본값으로 조용히 떨어지지 않는다', () => {
  const options = { drafterId: 'DRAFT', approverIds: ACCOUNTS, defaultLine: [{ mode: 'sequential', approvers: ['AA'] }] }
  // 「고르지 않았다」(null)와 「전부 지웠다」([])는 다른 말이다. 지운 결재선을 기본값으로 채우면
  // 기안자가 고르지 않은 사람에게 문서가 상신되고 응답은 200 이라, 상신 때 LINE_REQUIRED 가 영원히 울리지 않는다.
  assert.equal(normalizeApprovalLine(null, options).line[0].approvers[0].accountId, 'AA', '고르지 않았을 때만 기본 결재선을 쓴다')
  assert.deepEqual(normalizeApprovalLine([], options).line, [], '비운 결재선은 비운 채로 남는다')
  assert.equal(normalizeApprovalLine([], { ...options, requireSteps: true }).error.code, APPROVAL_ERRORS.LINE_REQUIRED.code)
  assert.equal(normalizeApprovalLine(null, { ...options, defaultLine: null, requireSteps: true }).error.code, APPROVAL_ERRORS.LINE_REQUIRED.code)

  // 배열이 아닌 것은 지금까지처럼 거절이다 — 같은 「고르지 않았다」에 세 가지 답이 나오지 않게.
  for (const shape of ['', {}, 0, false]) {
    assert.equal(normalizeApprovalLine(shape, options).error.code, APPROVAL_ERRORS.LINE_INVALID.code, `${JSON.stringify(shape)} 는 거절이다`)
  }

  // 양식은 기본 결재선이 비어도 저장된다(§1.5 의 지출결의 씨앗이 그렇다).
  const form = normalizeApprovalForm({
    name: '지출결의서', kind: '지출결의', defaultLine: [], fields: [{ key: 'purpose', label: '사유', type: 'text' }],
  }, { actor: ACTOR, now: NOW })
  assert.equal(form.error, undefined)
  assert.deepEqual(form.form.defaultLine, [])
})

test('35) 단계 번호가 배열 순서와 어긋난 결재선은 진행하지 않는다', () => {
  const seat = (accountId) => ({ accountId, name: accountId, decision: 'pending', decidedAt: null, decidedById: null, comment: '', delegateOf: null })

  // 번호가 겹치면 currentStepOf 가 앞의 것만 골라, 한 사람의 승인으로 뒷 단계가 통째로 건너뛰어진다.
  const duplicated = pendingDocument([
    { step: 1, mode: 'sequential', approvers: [seat('AA')] },
    { step: 1, mode: 'sequential', approvers: [seat('BB')] },
  ])
  const wrecked = approve(duplicated, 'AA')
  assert.equal(wrecked.error.code, APPROVAL_ERRORS.LINE_BROKEN.code)
  assert.equal(wrecked.document, undefined, '「승인」+completedAt 이 찍힌 문서를 만들지 않는다')
  assert.equal(canDecide(duplicated, 'AA', []), false, '목록도 같은 답을 준다')

  // 번호가 역순인 결재선도 같다.
  const reversed = pendingDocument([
    { step: 2, mode: 'sequential', approvers: [seat('AA')] },
    { step: 1, mode: 'sequential', approvers: [seat('BB')] },
  ], { currentStep: 2 })
  assert.equal(approve(reversed, 'AA').error.code, APPROVAL_ERRORS.LINE_BROKEN.code)

  // 1..N 인 결재선은 그대로 진행한다 — 손상 판정이 정상 경로를 막지 않는다.
  const sound = pendingDocument(buildLine([
    { mode: 'sequential', approvers: ['AA'] },
    { mode: 'sequential', approvers: ['BB'] },
  ]))
  const first = approve(sound, 'AA')
  assert.equal(first.document.currentStep, 2)
  assert.equal(approve(first.document, 'BB').document.status, '승인')
})

test('36) 목록·배지 술어는 세션 id 를 아직 모를 때 false 다 — 쓰기는 던지고 읽기는 답한다', () => {
  const document = pendingDocument(buildLine([{ mode: 'sequential', approvers: ['AA'] }]))
  for (const actorId of [undefined, null, '', '   ']) {
    assert.equal(canDecide(document, actorId, []), false, `${JSON.stringify(actorId)} 때문에 배지 하나가 화면을 깨뜨리지 않는다`)
  }
  assert.equal(canDecide(document, 'AA', []), true)
  assert.equal(canDecide(null, 'AA', []), false, '문서 쪽이 없을 때와 같은 답이다')

  // 문서를 실제로 바꾸는 두 함수는 그대로 던진다 — 「행위자가 빈 문자열인 승인」을 남기지 않기 위해서다.
  assert.throws(() => approvalSeatFor(document, { actorId: '', delegateFor: [] }), TypeError)
  assert.throws(() => applyApprovalDecision(document, { decision: 'approve', now: LATER }), TypeError)
})

test('37) 선언된 shape 로 저장·재적재해도 대결을 몰아 쥔 사람이 혼자 끝내지 못한다', () => {
  const line = buildLine([{ mode: 'sequential', approvers: ['AA'] }, { mode: 'sequential', approvers: ['BB'] }])
  const delegateFor = ['AA', 'BB']
  const first = approve(pendingDocument(line), ACTOR.id, { delegateFor })
  assert.equal(first.error, undefined)
  const seat = first.document.line[0].approvers[0]
  assert.equal(seat.decidedById, ACTOR.id, '자리를 실제로 채운 사람이 자리에 남는다')
  assert.equal(seat.delegateOf, 'AA')

  // 저장 계층이 §1.3 에 적힌 여섯 필드만 남기고 결재선을 다시 만든 문서 — decidedById 가 떨어져 나갔다.
  const reloaded = {
    ...first.document,
    line: first.document.line.map((step) => ({
      step: step.step,
      mode: step.mode,
      approvers: step.approvers.map(({ accountId, name, decision, decidedAt, comment, delegateOf }) => (
        { accountId, name, decision, decidedAt, comment, delegateOf }
      )),
    })),
  }
  assert.equal(Object.hasOwn(reloaded.line[0].approvers[0], 'decidedById'), false, '왕복이 그 필드를 실제로 지웠다')

  const second = approve(reloaded, ACTOR.id, { delegateFor })
  assert.equal(second.error.code, APPROVAL_ERRORS.SEAT_TAKEN.code, '이력이 두 번째 증인이다 — 「내가 남을 대신해 눌렀다」는 사실은 남아 있다')
  assert.equal(second.document, undefined)
  assert.equal(canDecide(reloaded, ACTOR.id, delegateFor), false)

  // 다른 사람이 대결을 맡으면 그대로 이어 간다 — 규칙이 정상 경로를 막지 않는다.
  assert.equal(approve(reloaded, 'DD', { delegateFor: ['BB'] }).document.status, '승인')
})

test('38) 오류 사전은 항목까지 얼어 있다 — 한 번의 덮어쓰기가 모든 테넌트의 문구를 바꾸지 않는다', () => {
  for (const [key, entry] of Object.entries(APPROVAL_ERRORS)) {
    assert.ok(Object.isFrozen(entry), `${key} 항목이 얼어 있어야 한다`)
  }
  const returned = normalizeApprovalLine([{ mode: 'sequential', approvers: ['AA', 'BB'] }], { drafterId: 'DRAFT', approverIds: ACCOUNTS })
  assert.equal(returned.error, APPROVAL_ERRORS.LINE_INVALID, '갈래 대부분이 사전 항목 그 자체를 돌려준다')
  assert.throws(() => { returned.error.message = 'HACKED' }, TypeError, '받은 오류에 한 글자라도 쓰면 던진다')
  assert.match(APPROVAL_ERRORS.LINE_INVALID.message, /결재선을 확인/)

  // key·reason 이 붙는 갈래는 사본이다 — 사본이 아니면 얼어 있어 붙지 않는다.
  const keyed = normalizeApprovalValues(sampleForm, { unknown: 1 })
  assert.equal(keyed.error.key, 'unknown')
  assert.notEqual(keyed.error, APPROVAL_ERRORS.VALUE_INVALID)
  assert.equal(APPROVAL_ERRORS.VALUE_INVALID.key, undefined, '사전 항목에는 key 가 붙지 않는다')
})

test('39) 이모지가 상한에 걸쳐도 반쪽 글자를 남기지 않는다', () => {
  const document = pendingDocument(buildLine([{ mode: 'sequential', approvers: ['AA'] }]))
  const lone = /[\uD800-\uDBFF]$/

  const cut = approve(document, 'AA', { comment: 'ㄱ'.repeat(MAX_COMMENT - 1) + '😀x' }).document.history.at(-1).comment
  assert.equal(lone.test(cut), false, '짝 잃은 서로게이트가 남으면 JSON 에 짝 없는 escape 가 나간다')
  assert.equal(JSON.stringify(cut).includes('\\ud83d'), false)
  assert.equal(cut.length, MAX_COMMENT - 1)

  // 상한 안에 온전히 들어가는 이모지는 그대로 둔다 — 자르는 김에 한 글자를 더 먹지 않는다.
  const kept = approve(document, 'AA', { comment: 'ㄱ'.repeat(MAX_COMMENT - 2) + '😀' }).document.history.at(-1).comment
  assert.equal(kept.length, MAX_COMMENT)
  assert.equal(kept.endsWith('😀'), true)

  // 본문 text 도 같은 정규화기를 쓴다 — 상한이 다르다고 다른 답이 나오지 않는다.
  const text = normalizeApprovalValues(sampleForm, { purpose: 'a'.repeat(MAX_TEXT_VALUE - 1) + '😀b' }).values.purpose
  assert.equal(lone.test(text), false)
  assert.equal(text.length, MAX_TEXT_VALUE - 1)
})

test('40) 시각 칸에는 시각처럼 생긴 값만 앉는다', () => {
  const document = pendingDocument(buildLine([{ mode: 'sequential', approvers: ['AA'] }]))
  // Date.parse 는 '5' 를 2001년 5월로 읽는다. 그 값이 그대로 decidedAt·completedAt·history.at 에 앉으면
  // 결재 이력이 「5」라는 시각을 갖고, 게시 월은 '2001-05' 가 된다.
  for (const now of ['5', '0', '2026', 'Mar 10 2026', '2026-3-10']) {
    assert.throws(() => approve(document, 'AA', { now }), TypeError, `${JSON.stringify(now)} 는 시각이 아니다`)
    assert.throws(() => approvalPosting(sampleForm, { values: { amount: 1000 } }, now), TypeError)
  }
  for (const now of ['2026-03-10', '2026-03-10T02:00:00.000Z', '2026-03-10 02:00:00', new Date(NOW)]) {
    assert.equal(approve(document, 'AA', { now }).error, undefined, `${String(now)} 는 시각이다`)
  }
  assert.equal(approve(document, 'AA', { now: '2026-03-10' }).document.line[0].approvers[0].decidedAt, '2026-03-10')
})

test('41) 대결 자리를 못 받은 이유를 구별해 말한다', () => {
  // 1단계 병렬 [AA,BB] 에서 BB 가 먼저 승인했고 AA 가 자리를 비웠다. CC 는 2단계에 이름이 있다.
  const line = buildLine([
    { mode: 'parallel', approvers: ['AA', 'BB'] },
    { mode: 'sequential', approvers: ['CC'] },
  ])
  const started = approve(pendingDocument(line), 'BB').document

  const blocked = approve(started, 'CC', { delegateFor: ['AA'] })
  assert.equal(blocked.error.code, APPROVAL_ERRORS.NOT_APPROVER.code, '자리를 뺏은 것이 아니므로 코드는 같다')
  assert.equal(blocked.error.reason, 'delegate-has-own-seat', '화면이 「그 결재선에 이미 이름이 있는 사람은 대결로 눌러 줄 수 없다」를 말할 수 있어야 한다')
  assert.equal(APPROVAL_ERRORS.NOT_APPROVER.reason, undefined, '사전은 사본만 내준다')

  // 결재선 밖 사람에게는 이유가 붙지 않는다 — 결재선 구성이 새어 나가지 않는다.
  assert.equal(approve(started, 'ZZ', { delegateFor: [] }).error.reason, undefined)
  // 결재선 밖의 다른 사람을 대결자로 바꾸면 그대로 풀린다(D17 의 관리자 재지정이 푸는 길이다).
  assert.equal(approve(started, 'DD', { delegateFor: ['AA'] }).error, undefined)
})

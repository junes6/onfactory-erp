import assert from 'node:assert/strict'
import test from 'node:test'

import { applyAiNarrative, buildPerformancePrompt, calculatePerformanceReport, normalizePerformanceSettings, previousMonthPeriod, resolvePerformancePeriod } from './performance-service.mjs'

const period = resolvePerformancePeriod({ periodType: 'month', anchor: '2026-08-20' })
const employee = { id: 'USR-1', name: '김직원', team: '생산', jobRole: '반장', role: 'tenant-member' }

test('performance metrics are derived only from existing work and journal records', () => {
  const report = calculatePerformanceReport({
    employee, period, now: new Date('2026-08-20T12:00:00.000Z'),
    workItems: [
      { id: 'WK-1', title: '포장 점검', ownerId: 'USR-1', requesterId: 'USR-2', status: '결재완료', due: '2026-08-10T09:00:00.000Z', createdAt: '2026-08-08T00:00:00.000Z', completion: { submittedAt: '2026-08-10T08:00:00.000Z' } },
      { id: 'WK-2', title: '포장 점검 2', ownerId: 'USR-1', requesterId: 'USR-2', status: '결재완료', due: '2026-08-12T09:00:00.000Z', createdAt: '2026-08-10T00:00:00.000Z', completion: { submittedAt: '2026-08-12T10:00:00.000Z' }, review: { decision: 'changes-requested' } },
      { id: 'WK-3', title: '다른 직원 업무', ownerId: 'USR-OTHER', status: '결재완료', completion: { submittedAt: '2026-08-11T10:00:00.000Z' } },
    ],
    journals: [
      { id: 'J-1', authorId: 'USR-1', status: '결재요청', submittedAt: '2026-08-11T09:00:00.000Z' },
      { id: 'J-2', authorId: 'USR-OTHER', status: '결재완료', submittedAt: '2026-08-12T09:00:00.000Z' },
    ],
  })
  assert.equal(report.metrics.completedTasks, 2)
  assert.equal(report.metrics.dueCompliance, 50)
  assert.equal(report.metrics.revisionRate, 50)
  assert.equal(report.narrative.evidence.length, 3)
  assert.ok(report.score >= 0 && report.score <= 100)
})

test('weights must total 100 and employee visibility defaults to private', () => {
  assert.equal(normalizePerformanceSettings({}).employeeVisible, false)
  assert.throws(() => normalizePerformanceSettings({ weights: { completedTasks: 99 } }), /100%/)
})

test('zero-sample metrics are N/A and factual evidence is required for a score or praise', () => {
  const report = calculatePerformanceReport({
    employee, period, workItems: [], journals: [], now: new Date('2026-08-20T12:00:00.000Z'),
  })
  assert.deepEqual(report.metrics, {
    completedTasks: null,
    dueCompliance: null,
    revisionRate: null,
    averageCycleHours: null,
    journalSubmission: null,
    approvalResponseHours: null,
  })
  assert.equal(report.score, null)
  assert.deepEqual(report.narrative.evidence, [])
  assert.equal(report.narrative.mode, 'rule-based')
  assert.match(report.narrative.strengths.join(' '), /근거/)
  assert.match(`${report.narrative.improvement} ${report.narrative.suggestion}`, /축적/)
  assert.doesNotMatch(report.narrative.strengths.join(' '), /기여|안정적|완성도|잘했/)
})

test('an evidence row with no scorable metric produces four distinct record-quality statements', () => {
  const report = calculatePerformanceReport({
    employee, period, journals: [], now: new Date('2026-08-20T12:00:00.000Z'),
    workItems: [{
      id: 'WK-UNSCORABLE', title: '시각이 누락된 결재 기록', requesterId: employee.id,
      review: { reviewedAt: '2026-08-10T08:00:00.000Z', decision: 'approved' },
    }],
  })
  const lines = [...report.narrative.strengths, report.narrative.improvement, report.narrative.suggestion]
  assert.equal(report.narrative.evidence.length, 1)
  assert.equal(report.score, null)
  assert.equal(Object.values(report.metrics).every((value) => value === null), true)
  assert.equal(new Set(lines).size, 4)
  assert.match(lines[0], /실제 .*기록은 1건/)
  assert.match(lines[1], /산정.*없어.*N\/A/)
  assert.match(lines[2], /기록 품질을 보완/)
  assert.match(lines[3], /다음 기간/)
})

test('a single scorable metric uses a different factual second line', () => {
  const report = calculatePerformanceReport({
    employee, period, workItems: [], now: new Date('2026-08-20T12:00:00.000Z'),
    journals: [{ id: 'JR-ONLY', title: '단일 업무일지', authorId: employee.id, status: '결재요청', submittedAt: '2026-08-10T08:00:00.000Z' }],
  })
  const lines = [...report.narrative.strengths, report.narrative.improvement, report.narrative.suggestion]
  assert.notEqual(report.score, null)
  assert.equal(report.narrative.evidence.length, 1)
  assert.equal(new Set(lines).size, 4)
  assert.notEqual(report.narrative.strengths[0], report.narrative.strengths[1])
  assert.match(report.narrative.strengths[0], /업무일지 제출률/)
  assert.match(report.narrative.strengths[1], /실제 .*기록은 1건/)
})

test('available metric weights are re-normalized instead of treating N/A as zero', () => {
  const report = calculatePerformanceReport({
    employee, period, journals: [], now: new Date('2026-08-20T12:00:00.000Z'),
    workItems: [{
      id: 'WK-ONLY', title: '단일 완료 근거', ownerId: employee.id, status: '결재완료',
      completion: { submittedAt: '2026-08-10T08:00:00.000Z' },
    }],
  })
  assert.equal(report.metrics.completedTasks, 1)
  assert.equal(report.metrics.revisionRate, 0)
  assert.equal(report.metrics.dueCompliance, null)
  assert.equal(report.metrics.journalSubmission, null)
  assert.equal(report.score, 50)
  assert.equal(report.narrative.evidence.length, 1)
})

test('monthly snapshot period is deterministic and AI output keeps evidence links', () => {
  const previous = previousMonthPeriod(new Date('2026-08-21T00:00:00.000Z'))
  assert.equal(previous.label, '2026년 7월')
  const base = calculatePerformanceReport({ employee, period, workItems: [], journals: [], now: new Date('2026-09-01T00:00:00.000Z') })
  const prompt = buildPerformancePrompt(base, [{ title: '점검', journal: '이상 없음' }])
  assert.match(prompt, /평가 근거가 없으므로/)
  const ignored = applyAiNarrative(base, ['강점1', '강점2', '보완1', '제안1'])
  assert.equal(ignored.narrative.mode, 'rule-based')

  const evidenced = calculatePerformanceReport({
    employee, period, journals: [], now: new Date('2026-08-20T12:00:00.000Z'),
    workItems: [{ id: 'WK-AI', title: 'AI 근거 업무', ownerId: employee.id, status: '결재완료', completion: { submittedAt: '2026-08-10T08:00:00.000Z' } }],
  })
  const evidencedPrompt = buildPerformancePrompt(evidenced, [{ id: 'WK-AI', title: 'AI 근거 업무' }])
  assert.match(evidencedPrompt, /인사 결정을 내리지 말고/)
  assert.match(evidencedPrompt, /추정하거나 칭찬하지 마세요/)
  const ai = applyAiNarrative(evidenced, ['강점1', '강점2', '보완1', '제안1'])
  assert.equal(ai.narrative.mode, 'ai')
  assert.deepEqual(ai.narrative.strengths, ['강점1', '강점2'])
})

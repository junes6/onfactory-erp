import { createHash } from 'node:crypto'

export const PERFORMANCE_METRIC_KEYS = Object.freeze([
  'completedTasks', 'dueCompliance', 'revisionRate', 'averageCycleHours', 'journalSubmission', 'approvalResponseHours',
])

export const DEFAULT_PERFORMANCE_SETTINGS = Object.freeze({
  weights: Object.freeze({ completedTasks: 20, dueCompliance: 25, revisionRate: 15, averageCycleHours: 15, journalSubmission: 15, approvalResponseHours: 10 }),
  employeeVisible: false,
})

function round(value, precision = 1) {
  const factor = 10 ** precision
  return Math.round(value * factor) / factor
}

function finiteNumber(value, fallback = 0) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

export function normalizePerformanceSettings(value) {
  const candidate = value && typeof value === 'object' ? value : {}
  const weights = Object.fromEntries(PERFORMANCE_METRIC_KEYS.map((key) => [key, Math.max(0, Math.min(100, finiteNumber(candidate.weights?.[key], DEFAULT_PERFORMANCE_SETTINGS.weights[key]))) ]))
  const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0)
  if (round(total, 4) !== 100) throw new TypeError('성과 지표 가중치 합계는 100%여야 합니다.')
  return { weights, employeeVisible: candidate.employeeVisible === true }
}

function dateKey(value) {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
}

function utcFromSeoulDate(year, monthIndex, day = 1) {
  return new Date(Date.UTC(year, monthIndex, day, -9, 0, 0, 0))
}

export function resolvePerformancePeriod({ periodType = 'month', anchor = new Date().toISOString().slice(0, 10) } = {}) {
  if (!['month', 'quarter'].includes(periodType)) throw new TypeError('성과 조회 기간은 month 또는 quarter여야 합니다.')
  const anchorMatch = String(anchor).match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!anchorMatch) throw new TypeError('성과 기준일은 YYYY-MM-DD 형식이어야 합니다.')
  const year = Number(anchorMatch[1])
  const monthIndex = Number(anchorMatch[2]) - 1
  const startMonth = periodType === 'quarter' ? Math.floor(monthIndex / 3) * 3 : monthIndex
  const duration = periodType === 'quarter' ? 3 : 1
  const start = utcFromSeoulDate(year, startMonth, 1)
  const end = utcFromSeoulDate(year, startMonth + duration, 1)
  const endDate = new Date(end.getTime() - 1)
  const calendarStart = new Date(Date.UTC(year, startMonth, 1))
  return {
    type: periodType,
    start: start.toISOString(),
    end: end.toISOString(),
    startDate: calendarStart.toISOString().slice(0, 10),
    endDate: dateKey(new Date(endDate.getTime() + 9 * 60 * 60 * 1000)),
    label: periodType === 'quarter' ? `${year}년 ${Math.floor(startMonth / 3) + 1}분기` : `${year}년 ${startMonth + 1}월`,
  }
}

function timeInPeriod(value, period) {
  const time = new Date(value).getTime()
  return Number.isFinite(time) && time >= new Date(period.start).getTime() && time < new Date(period.end).getTime()
}

function parseDue(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const direct = new Date(value)
  if (!Number.isNaN(direct.getTime())) return direct
  const local = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/)
  if (!local) return null
  return new Date(Date.UTC(Number(local[1]), Number(local[2]) - 1, Number(local[3]), Number(local[4]) - 9, Number(local[5])))
}

function hoursBetween(start, end) {
  const startTime = new Date(start).getTime()
  const endTime = new Date(end).getTime()
  return Number.isFinite(startTime) && Number.isFinite(endTime) && endTime >= startTime ? (endTime - startTime) / 3_600_000 : null
}

function expectedWorkdays(period, now = new Date()) {
  const start = new Date(period.start)
  const endExclusive = new Date(Math.min(new Date(period.end).getTime(), now.getTime() + 1))
  let count = 0
  for (let cursor = new Date(start); cursor < endExclusive; cursor = new Date(cursor.getTime() + 86_400_000)) {
    const seoulDay = new Date(cursor.getTime() + 9 * 60 * 60 * 1000).getUTCDay()
    if (seoulDay !== 0 && seoulDay !== 6) count += 1
  }
  return Math.max(1, count)
}

function normalizedTitle(title) {
  return String(title ?? '').replace(/[\d\s()[\]{}_-]+/g, '').toLocaleLowerCase('ko-KR')
}

function performanceComponents(metrics) {
  return {
    completedTasks: metrics.completedTasks === null ? null : Math.min(100, metrics.completedTasks / 8 * 100),
    dueCompliance: metrics.dueCompliance,
    revisionRate: metrics.revisionRate === null ? null : 100 - metrics.revisionRate,
    averageCycleHours: metrics.averageCycleHours === null ? null : Math.max(0, Math.min(100, 120 - metrics.averageCycleHours * 2.5)),
    journalSubmission: metrics.journalSubmission,
    approvalResponseHours: metrics.approvalResponseHours === null ? null : Math.max(0, Math.min(100, 110 - metrics.approvalResponseHours * 5)),
  }
}

function performanceScore(metrics, settings) {
  const components = performanceComponents(metrics)
  const valid = PERFORMANCE_METRIC_KEYS
    .map((key) => ({ score: components[key], weight: settings.weights[key] }))
    .filter(({ score, weight }) => typeof score === 'number' && Number.isFinite(score) && weight > 0)
  const validWeight = valid.reduce((sum, item) => sum + item.weight, 0)
  if (validWeight <= 0) return null
  return round(valid.reduce((sum, item) => sum + item.score * item.weight, 0) / validWeight)
}

function insufficientEvidenceNarrative() {
  return {
    strengths: [
      '이 기간에는 평가에 사용할 완료 업무·결재·업무일지 근거가 없습니다.',
      '근거가 부족해 강점이나 성과를 사실로 단정할 수 없습니다.',
    ],
    improvement: '평가 근거가 부족하므로 업무 완료 결과와 승인 기록을 먼저 축적해 주세요.',
    suggestion: '다음 기간에는 완료 기준과 증빙을 남기고 업무일지를 제출해 평가 가능한 데이터를 축적해 주세요.',
    evidence: [],
    mode: 'rule-based',
  }
}

function metricNarrative(metrics, completed, employeeName, evidence) {
  if (evidence.length === 0) return insufficientEvidenceNarrative()
  const components = performanceComponents(metrics)
  const strengthCandidates = [
    metrics.completedTasks === null ? null : { score: components.completedTasks, text: `결재 완료로 확인된 업무는 ${metrics.completedTasks}건입니다.` },
    metrics.dueCompliance === null ? null : { score: components.dueCompliance, text: `기한이 확인되는 완료 업무의 준수율은 ${metrics.dueCompliance}%입니다.` },
    metrics.revisionRate === null ? null : { score: components.revisionRate, text: `완료 업무의 보완 재제출 비율은 ${metrics.revisionRate}%입니다.` },
    metrics.averageCycleHours === null ? null : { score: components.averageCycleHours, text: `완료 업무의 평균 처리 시간은 ${metrics.averageCycleHours}시간입니다.` },
    metrics.journalSubmission === null ? null : { score: components.journalSubmission, text: `제출 기록 기준 업무일지 제출률은 ${metrics.journalSubmission}%입니다.` },
    metrics.approvalResponseHours === null ? null : { score: components.approvalResponseHours, text: `결재 응답 평균 시간은 ${metrics.approvalResponseHours}시간입니다.` },
  ].filter(Boolean).sort((a, b) => b.score - a.score)
  const improvementCandidates = [
    metrics.dueCompliance === null ? null : { score: components.dueCompliance, text: '마감 전 중간 점검 시점을 정해 기한 준수율을 높여 보세요.' },
    metrics.revisionRate === null ? null : { score: components.revisionRate, text: '제출 전 완료 기준과 증빙을 대조해 보완 재제출을 줄여 보세요.' },
    metrics.journalSubmission === null ? null : { score: components.journalSubmission, text: '업무 종료 전에 일지를 작성하는 루틴으로 기록 누락을 줄여 보세요.' },
    metrics.averageCycleHours === null ? null : { score: components.averageCycleHours, text: '업무 시작·완료 시점을 꾸준히 기록해 처리 흐름을 점검해 보세요.' },
    metrics.approvalResponseHours === null ? null : { score: components.approvalResponseHours, text: '결재 요청 확인 시점을 정해 응답 시간을 안정적으로 관리해 보세요.' },
  ].filter(Boolean).sort((a, b) => a.score - b.score)
  const titleCounts = new Map()
  for (const item of completed) {
    const key = normalizedTitle(item.title)
    if (key) titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1)
  }
  const mostRepeated = Math.max(0, ...titleCounts.values())
  const repetitive = completed.length >= 5 && mostRepeated / completed.length >= .6
  const actualRecordStatement = `평가 기간에 확인된 실제 업무·결재·일지 기록은 ${evidence.length}건입니다.`
  const unscorableStatement = '확인된 기록에는 점수 산정에 필요한 완료·제출·응답 시각이나 유효 표본이 없어 모든 지표가 N/A입니다.'
  const recordQualityImprovement = '업무 상태와 완료 시각, 기한, 결재 응답, 증빙을 빠짐없이 남겨 기록 품질을 보완해 주세요.'
  const nextPeriodSuggestion = `${employeeName}님의 다음 기간 업무에는 측정 가능한 완료 기준과 시각·증빙을 함께 기록해 주세요.`
  if (strengthCandidates.length === 0) {
    return {
      strengths: [actualRecordStatement, unscorableStatement],
      improvement: recordQualityImprovement,
      suggestion: nextPeriodSuggestion,
      evidence: evidence.slice(0, 6),
      mode: 'rule-based',
    }
  }
  return {
    strengths: [strengthCandidates[0].text, strengthCandidates[1]?.text ?? actualRecordStatement],
    improvement: improvementCandidates[0]?.text ?? '현재 표본만으로 개선 지표를 단정하기 어려우므로 평가 가능한 기록을 더 축적해 주세요.',
    suggestion: nextPeriodSuggestion,
    ...(repetitive ? { conflictNote: `완료 건수는 많지만 유사 제목의 반복 업무가 ${mostRepeated}건으로 비중이 높아, 건수만으로 난이도나 영향도를 판단하기 어렵습니다.` } : {}),
    evidence: evidence.slice(0, 6),
    mode: 'rule-based',
  }
}

function reportId(employeeId, period) {
  return `PERF-${createHash('sha256').update(`${employeeId}:${period.type}:${period.start}`).digest('hex').slice(0, 18).toUpperCase()}`
}

export function calculatePerformanceReport({ employee, workItems = [], journals = [], period, settings = DEFAULT_PERFORMANCE_SETTINGS, now = new Date() }) {
  const normalizedSettings = normalizePerformanceSettings(settings)
  const completed = workItems.filter((item) => item?.ownerId === employee.id && item.status === '결재완료'
    && timeInPeriod(item.review?.reviewedAt || item.completion?.submittedAt, period))
  const comparableDue = completed.map((item) => ({ item, due: parseDue(item.due), submitted: new Date(item.completion?.submittedAt) })).filter(({ due, submitted }) => due && !Number.isNaN(submitted.getTime()))
  const onTime = comparableDue.filter(({ due, submitted }) => submitted <= due).length
  const revisions = completed.filter((item) => (item.reviewHistory ?? []).some((review) => review?.decision === 'changes-requested')
    || item.review?.decision === 'changes-requested').length
  const cycleHours = completed.map((item) => hoursBetween(item.createdAt, item.completion?.submittedAt)).filter((value) => value !== null)
  const submittedJournals = journals.filter((journal) => journal?.authorId === employee.id && journal.status !== '임시저장' && timeInPeriod(journal.submittedAt || journal.updatedAt || journal.date, period))
  const approvalItems = workItems.filter((item) => item?.requesterId === employee.id && item.review?.reviewedAt && timeInPeriod(item.review.reviewedAt, period))
  const approvalDurations = approvalItems.map((item) => hoursBetween(item.completion?.submittedAt, item.review.reviewedAt)).filter((value) => value !== null)
  const evidenceById = new Map()
  for (const item of [...completed, ...approvalItems]) evidenceById.set(item.id, { id: item.id, title: item.title || '업무 기록', kind: 'work' })
  for (const journal of submittedJournals) {
    const date = dateKey(journal.submittedAt || journal.updatedAt || journal.date) || '기간 내'
    evidenceById.set(journal.id, { id: journal.id, title: journal.title || `${date} 업무일지`, kind: 'journal' })
  }
  const evidence = [...evidenceById.values()]
  const metrics = {
    completedTasks: completed.length ? completed.length : null,
    dueCompliance: comparableDue.length ? round(onTime / comparableDue.length * 100) : null,
    revisionRate: completed.length ? round(revisions / completed.length * 100) : null,
    averageCycleHours: cycleHours.length ? round(cycleHours.reduce((sum, value) => sum + value, 0) / cycleHours.length) : null,
    journalSubmission: submittedJournals.length ? round(Math.min(100, submittedJournals.length / expectedWorkdays(period, now) * 100)) : null,
    approvalResponseHours: approvalDurations.length ? round(approvalDurations.reduce((sum, value) => sum + value, 0) / approvalDurations.length) : null,
  }
  const score = evidence.length ? performanceScore(metrics, normalizedSettings) : null
  return {
    id: reportId(employee.id, period), employeeId: employee.id, employeeName: employee.name, team: employee.team || '미지정', jobRole: employee.jobRole || '',
    periodType: period.type, periodStart: period.start, periodEnd: period.end, score, metrics,
    narrative: metricNarrative(metrics, completed, employee.name, evidence), generatedAt: now.toISOString(), snapshot: period.type === 'month' && new Date(period.end) <= now,
  }
}

export function generatePerformanceReports({ employees = [], workItems = [], journals = [], period, settings, now = new Date() }) {
  return employees.filter((employee) => employee?.id && employee.role !== 'platform-operator').map((employee) => calculatePerformanceReport({ employee, workItems, journals, period, settings, now }))
}

export function previousMonthPeriod(now = new Date()) {
  const seoul = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  const previous = new Date(Date.UTC(seoul.getUTCFullYear(), seoul.getUTCMonth() - 1, 15))
  return resolvePerformancePeriod({ periodType: 'month', anchor: previous.toISOString().slice(0, 10) })
}

export function buildPerformancePrompt(report, evidenceDetails = []) {
  if (report?.score === null || report?.narrative?.evidence?.length === 0 || evidenceDetails.length === 0) {
    return [
      '당신은 직원의 업무기록을 공정하게 요약하는 조직 운영 보조자입니다. 인사 결정을 내리지 말고, 아래 기록의 유무만 사실대로 설명하세요.',
      '평가 근거가 없으므로 강점·성과·기여를 추정하거나 칭찬하지 마세요.',
      '정확히 다음 의미의 4줄 JSON 배열만 반환하세요: 평가 근거 부족, 성과 단정 불가, 기록 축적 필요, 다음 기간 데이터 축적 제안.',
      JSON.stringify({ score: null, metrics: report?.metrics ?? {}, evidence: [] }),
    ].join('\n')
  }
  return [
    '당신은 직원의 업무기록을 공정하게 요약하는 조직 운영 보조자입니다.',
    '인사 결정을 내리지 말고, 아래 수치와 실제 업무/일지 근거만 사용하세요.',
    'null 지표는 N/A이며 평가에서 제외되었습니다. 제공된 근거가 없는 강점·성과·기여를 추정하거나 칭찬하지 마세요.',
    '정확히 4줄 JSON 배열로 답하세요: 근거로 확인되는 사실 2개, 개선 제안 1개, 다음 기간 데이터 축적 제안 1개.',
    '완료 건수와 업무 난이도·반복성이 상충하면 아쉬운 점에 반드시 명시하세요.',
    JSON.stringify({ metrics: report.metrics, evidence: evidenceDetails.slice(0, 20) }),
  ].join('\n')
}

export function applyAiNarrative(report, lines) {
  if (report?.score === null || report?.narrative?.evidence?.length === 0) return report
  if (!Array.isArray(lines) || lines.length !== 4 || !lines.every((line) => typeof line === 'string' && line.trim())) return report
  return { ...report, narrative: { ...report.narrative, strengths: [lines[0].trim(), lines[1].trim()], improvement: lines[2].trim(), suggestion: lines[3].trim(), mode: 'ai' } }
}

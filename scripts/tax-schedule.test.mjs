import assert from 'node:assert/strict'
import test from 'node:test'

import { buildProvidedTaxSchedule, defaultTaxProfile, remainingTaxSchedule, rollTaxDeadline } from '../src/utils/taxSchedule.ts'
import { evidenceDateOf, isTaxPeriodPreset, taxPeriodRange } from '../src/utils/taxEvidencePeriod.ts'

test('2026 corporate schedule applies official VAT, withholding and fiscal-year rules without manual entries', () => {
  const schedule = buildProvidedTaxSchedule({
    entityType: 'corporation', fiscalYearEndMonth: 12, vatType: 'general', hasPayroll: true, withholdingCycle: 'monthly',
  }, 2026, 'food_manufacturing')
  assert.equal(schedule.length, 20)
  assert.equal(schedule.find((item) => item.ruleId === 'corporate-tax')?.dueDate, '2026-03-31')
  assert.equal(schedule.find((item) => item.ruleId === 'corporate-interim')?.dueDate, '2026-08-31')
  assert.equal(schedule.find((item) => item.ruleId === 'vat-01')?.dueDate, '2026-01-26')
  assert.equal(schedule.find((item) => item.ruleId === 'vat-04')?.dueDate, '2026-04-27')
  assert.equal(schedule.find((item) => item.ruleId === 'vat-07')?.dueDate, '2026-07-27')
  assert.equal(schedule.find((item) => item.ruleId === 'vat-10')?.dueDate, '2026-10-26')
  assert.equal(schedule.find((item) => item.ruleId === 'withholding-08')?.dueDate, '2026-08-10')
  assert.equal(schedule.find((item) => item.ruleId === 'payment-statement')?.dueDate, '2026-03-10')
  assert.equal(schedule.find((item) => item.ruleId === 'social-insurance')?.dueDate, '2026-03-10')
  assert.equal(new Set(schedule.map((item) => item.id)).size, schedule.length)
  assert.ok(schedule.every((item) => item.sourceUrl.startsWith('https://') && item.checkedAt === '2026-08-30'))
  assert.ok(schedule.every((item) => item.preparation.length > 0))
})

test('preparation checklists follow the tenant industry module', () => {
  const profile = { entityType: 'corporation', fiscalYearEndMonth: 12, vatType: 'general', hasPayroll: true, withholdingCycle: 'monthly' }
  const vatOf = (industry) => buildProvidedTaxSchedule(profile, 2026, industry).find((item) => item.ruleId === 'vat-04').preparation
  assert.ok(vatOf('food_manufacturing').includes('원재료·부자재 매입 세금계산서'))
  assert.ok(vatOf('it_services').includes('외주 개발·용역 계산서'))
  assert.equal(vatOf('it_services').includes('원재료·부자재 매입 세금계산서'), false)
  // 업종을 모르는 고객사도 공통 준비물은 그대로 받는다.
  assert.ok(vatOf(null).includes('매출 세금계산서·계산서'))
})

test('a tenant that registered nothing still sees the remaining schedule from the default profile', () => {
  const schedule = buildProvidedTaxSchedule(defaultTaxProfile(), 2026, 'it_services')
  assert.ok(schedule.length > 0)
  const remaining = remainingTaxSchedule(schedule, '2026-08-30')
  assert.ok(remaining.length > 0)
  assert.ok(remaining.every((item) => item.dueDate >= '2026-08-30'))
  assert.deepEqual(remaining.map((item) => item.ruleId).slice(0, 3), ['corporate-interim', 'withholding-09', 'withholding-10'])
})

test('individual, simplified and exempt profiles only receive applicable schedules', () => {
  const simplified = buildProvidedTaxSchedule({
    entityType: 'individual', fiscalYearEndMonth: 12, vatType: 'simplified', hasPayroll: false, withholdingCycle: 'monthly',
  }, 2026)
  assert.deepEqual(simplified.map((item) => item.ruleId), ['vat-annual', 'income-tax', 'income-interim'])
  assert.equal(simplified.find((item) => item.ruleId === 'income-tax')?.dueDate, '2026-06-01')
  assert.equal(simplified.find((item) => item.ruleId === 'income-interim')?.dueDate, '2026-11-30')

  const exempt = buildProvidedTaxSchedule({
    entityType: 'individual', fiscalYearEndMonth: 12, vatType: 'exempt', hasPayroll: true, withholdingCycle: 'semiannual',
  }, 2026)
  assert.equal(exempt.some((item) => item.kind === '부가가치세'), false)
  assert.equal(exempt.find((item) => item.ruleId === 'exempt-status-report')?.dueDate, '2026-02-10')
  assert.deepEqual(exempt.filter((item) => item.kind === '원천세').map((item) => item.ruleId), ['withholding-01', 'withholding-07'])
})

test('non-december closings move the corporate deadlines together', () => {
  const june = buildProvidedTaxSchedule({
    entityType: 'corporation', fiscalYearEndMonth: 6, vatType: 'general', hasPayroll: false, withholdingCycle: 'monthly',
  }, 2026)
  assert.equal(june.find((item) => item.ruleId === 'corporate-tax')?.dueDate, '2026-09-30')
  assert.equal(june.find((item) => item.ruleId === 'corporate-interim')?.dueDate, '2026-03-03')
})

test('deadline rollover skips Korean holidays and weekends deterministically', () => {
  assert.equal(rollTaxDeadline('2026-01-25'), '2026-01-26')
  assert.equal(rollTaxDeadline('2026-10-09'), '2026-10-12')
})

test('one period choice resolves to an exact start and end date', () => {
  assert.deepEqual(taxPeriodRange('year', 2026), { from: '2026-01-01', to: '2026-12-31', label: '2026년 한 해 전체' })
  assert.deepEqual(taxPeriodRange('h1', 2026), { from: '2026-01-01', to: '2026-06-30', label: '2026년 상반기 (1~6월)' })
  assert.deepEqual(taxPeriodRange('q3', 2026), { from: '2026-07-01', to: '2026-09-30', label: '2026년 3분기 (7~9월)' })
  assert.deepEqual(taxPeriodRange('m02', 2024), { from: '2024-02-01', to: '2024-02-29', label: '2024년 2월' })
  assert.equal(isTaxPeriodPreset('m13'), false)
  assert.equal(isTaxPeriodPreset('q2'), true)
})

test('evidence date prefers the tagged evidence day and falls back to the tagged year', () => {
  assert.equal(evidenceDateOf({ tags: ['tax-evidence', 'tax-date:2026-03-04', 'tax-year:2026'] }, '2026-08-30'), '2026-03-04')
  assert.equal(evidenceDateOf({ tags: ['tax-evidence', 'tax-year:2025'] }, '2026-08-30'), '2025-12-31')
  assert.equal(evidenceDateOf({ tags: ['tax-evidence', 'tax-year:2026'] }, '2026-08-30'), '2026-08-30')
  assert.equal(evidenceDateOf({ tags: [] }, '2026-08-30'), '2026-08-30')
})

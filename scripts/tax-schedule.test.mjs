import assert from 'node:assert/strict'
import test from 'node:test'

import { buildProvidedTaxSchedule, rollTaxDeadline } from '../src/utils/taxSchedule.ts'

test('2026 corporate schedule applies official VAT, withholding and fiscal-year rules without manual entries', () => {
  const schedule = buildProvidedTaxSchedule({
    entityType: 'corporation', fiscalYearEndMonth: 12, vatType: 'general', hasPayroll: true, withholdingCycle: 'monthly',
  }, 2026)
  assert.equal(schedule.length, 17)
  assert.equal(schedule.find((item) => item.ruleId === 'corporate-tax')?.dueDate, '2026-03-31')
  assert.equal(schedule.find((item) => item.ruleId === 'vat-01')?.dueDate, '2026-01-26')
  assert.equal(schedule.find((item) => item.ruleId === 'vat-04')?.dueDate, '2026-04-27')
  assert.equal(schedule.find((item) => item.ruleId === 'vat-07')?.dueDate, '2026-07-27')
  assert.equal(schedule.find((item) => item.ruleId === 'vat-10')?.dueDate, '2026-10-26')
  assert.equal(schedule.find((item) => item.ruleId === 'withholding-08')?.dueDate, '2026-08-10')
  assert.equal(new Set(schedule.map((item) => item.id)).size, schedule.length)
  assert.ok(schedule.every((item) => item.sourceUrl.startsWith('https://') && item.checkedAt === '2026-08-24'))
})

test('individual, simplified and exempt profiles only receive applicable schedules', () => {
  const simplified = buildProvidedTaxSchedule({
    entityType: 'individual', fiscalYearEndMonth: 12, vatType: 'simplified', hasPayroll: false, withholdingCycle: 'monthly',
  }, 2026)
  assert.deepEqual(simplified.map((item) => item.ruleId), ['vat-annual', 'income-tax'])
  assert.equal(simplified.find((item) => item.ruleId === 'income-tax')?.dueDate, '2026-06-01')

  const exempt = buildProvidedTaxSchedule({
    entityType: 'individual', fiscalYearEndMonth: 12, vatType: 'exempt', hasPayroll: true, withholdingCycle: 'semiannual',
  }, 2026)
  assert.equal(exempt.some((item) => item.kind === '부가가치세'), false)
  assert.deepEqual(exempt.filter((item) => item.kind === '원천세').map((item) => item.ruleId), ['withholding-01', 'withholding-07'])
})

test('deadline rollover skips Korean holidays and weekends deterministically', () => {
  assert.equal(rollTaxDeadline('2026-01-25'), '2026-01-26')
  assert.equal(rollTaxDeadline('2026-10-09'), '2026-10-12')
})

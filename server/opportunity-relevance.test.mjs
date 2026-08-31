import assert from 'node:assert/strict'
import test from 'node:test'

import { daysToDeadline, opportunitySummary, rankOpportunities, scoreOpportunity } from './opportunity-relevance.mjs'

const IT_PROFILE = { keywords: ['콘텐츠', '소프트웨어 개발 용역'], regions: ['울산'], minAmount: 50_000_000, industryType: 'it_services' }

test('a title keyword match scores higher than a body-only match, and both name their evidence', () => {
  const inTitle = scoreOpportunity({ title: '2026 실감 콘텐츠 제작 지원', summary: '' }, IT_PROFILE)
  const inBody = scoreOpportunity({ title: '2026 창업도약패키지', summary: '콘텐츠 분야 기업 우대' }, IT_PROFILE)
  assert.ok(inTitle.score > inBody.score)
  assert.match(inTitle.reasons[0], /제목에 감시 키워드 '콘텐츠' 일치/)
  assert.match(inBody.reasons[0], /내용에 감시 키워드 '콘텐츠' 일치/)
  assert.deepEqual(inTitle.matchedKeywords, ['콘텐츠'])
})

test('region and amount are separate signals and a below-floor amount costs relevance', () => {
  const withRegion = scoreOpportunity({ title: '콘텐츠 지원', region: '울산광역시', amount: 80_000_000 }, IT_PROFILE)
  const withoutRegion = scoreOpportunity({ title: '콘텐츠 지원', region: '제주', amount: 80_000_000 }, IT_PROFILE)
  assert.ok(withRegion.score > withoutRegion.score)
  assert.ok(withRegion.reasons.some((reason) => /관심 지역 울산 관련/.test(reason)))

  const small = scoreOpportunity({ title: '콘텐츠 지원', amount: 1_000_000 }, IT_PROFILE)
  const big = scoreOpportunity({ title: '콘텐츠 지원', amount: 80_000_000 }, IT_PROFILE)
  assert.ok(small.score < big.score)
  assert.ok(small.reasons.some((reason) => /하한 .* 미만/.test(reason)))
})

test('industry hint keywords only apply when the tenant keywords did not match', () => {
  const hintOnly = scoreOpportunity({ title: '정보화 시스템 구축 용역' }, IT_PROFILE)
  assert.ok(hintOnly.score > 0)
  assert.ok(hintOnly.reasons.some((reason) => /업종 연관어/.test(reason)))

  // 고객사 키워드가 맞은 건에는 업종 힌트를 더하지 않는다 (같은 근거 이중 계산 금지).
  const both = scoreOpportunity({ title: '콘텐츠 소프트웨어 플랫폼 지원' }, IT_PROFILE)
  assert.equal(both.signals.industryKeyword, false)

  // 업종이 다르면 같은 공고의 연관어 신호가 사라진다.
  const foodView = scoreOpportunity({ title: '정보화 시스템 구축 용역' }, { ...IT_PROFILE, keywords: [], industryType: 'food_manufacturing' })
  assert.equal(foodView.signals.industryKeyword, false)
})

test('a notice with no matching condition says so instead of pretending to be relevant', () => {
  const none = scoreOpportunity({ title: '축산 분뇨 처리시설 개선' }, { keywords: ['콘텐츠'], regions: [], industryType: 'it_services' })
  assert.equal(none.score, 0)
  assert.deepEqual(none.reasons, ['일치하는 감시 조건이 없습니다'])
})

test('recommended sorting puts relevance first and deadline sorting puts the nearest first', () => {
  const today = '2026-08-31'
  const items = [
    { title: '무관한 공고', endsOn: '2026-09-02' },
    { title: '콘텐츠 제작 지원', endsOn: '2026-10-30' },
    { title: '이미 마감된 콘텐츠 공고', endsOn: '2026-08-01' },
  ]
  const recommended = rankOpportunities(items, { profile: IT_PROFILE, sort: 'recommended', todayKey: today })
  assert.deepEqual(recommended.map((item) => item.title), ['콘텐츠 제작 지원', '무관한 공고', '이미 마감된 콘텐츠 공고'])
  assert.equal(recommended[0].relevance.daysToDeadline, 60)
  assert.equal(recommended.at(-1).relevance.closed, true, '마감된 건은 어느 정렬에서도 뒤로 간다')

  const byDeadline = rankOpportunities(items, { profile: IT_PROFILE, sort: 'deadline', todayKey: today })
  assert.deepEqual(byDeadline.map((item) => item.title), ['무관한 공고', '콘텐츠 제작 지원', '이미 마감된 콘텐츠 공고'])
})

test('a notice with no deadline sorts after dated open notices but before closed ones', () => {
  const ranked = rankOpportunities([
    { title: '상시 모집', endsOn: null },
    { title: '마감 있는 건', endsOn: '2026-09-10' },
    { title: '마감된 건', endsOn: '2026-08-01' },
  ], { profile: {}, sort: 'deadline', todayKey: '2026-08-31' })
  assert.deepEqual(ranked.map((item) => item.title), ['마감 있는 건', '상시 모집', '마감된 건'])
})

test('the summary counts what the dashboard header claims', () => {
  const ranked = rankOpportunities([
    { title: '콘텐츠 제작 지원', endsOn: '2026-09-03' },
    { title: '소프트웨어 개발 용역 공고', endsOn: '2026-12-01' },
    { title: '무관한 공고', endsOn: '2026-09-05' },
    { title: '마감된 건', endsOn: '2026-08-01' },
  ], { profile: IT_PROFILE, sort: 'recommended', todayKey: '2026-08-31' })
  const summary = opportunitySummary(ranked)
  assert.deepEqual(
    { total: summary.total, open: summary.open, closed: summary.closed, closingSoon: summary.closingSoon, recommended: summary.recommended },
    { total: 4, open: 3, closed: 1, closingSoon: 2, recommended: 2 },
  )
  assert.equal(summary.top.title, '콘텐츠 제작 지원', '가장 관련성 높은 건이 대표로 올라온다')
})

test('deadline arithmetic rejects malformed dates instead of guessing', () => {
  assert.equal(daysToDeadline('2026-09-10', '2026-08-31'), 10)
  assert.equal(daysToDeadline('2026-08-31', '2026-08-31'), 0)
  assert.equal(daysToDeadline('접수기간 확인', '2026-08-31'), null)
  assert.equal(daysToDeadline(null, '2026-08-31'), null)
  assert.equal(daysToDeadline('2026-09-10', ''), null)
})

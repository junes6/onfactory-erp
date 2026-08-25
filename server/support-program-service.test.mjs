import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createMemorySupportProgramCache,
  createSupportProgramService,
  normalizeBizinfoPrograms,
  normalizeKStartupPrograms,
} from './support-program-service.mjs'

test('K-Startup official feed accepts current and legacy payload shapes and sanitizes untrusted content', () => {
  const row = {
    pbanc_sn: '123', biz_pbanc_nm: '<b>2026 창업 지원</b>', pbanc_ctnt: '<p>사업 &amp; 설명</p>',
    sprv_inst: '중소벤처기업부', pbanc_rcpt_bgng_dt: '20260801', pbanc_rcpt_end_dt: '2026-08-31',
    detl_pg_url: 'https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do',
  }
  for (const body of [{ data: [row] }, { data: { data: [row] } }]) {
    const [item] = normalizeKStartupPrograms(body)
    assert.equal(item.title, '2026 창업 지원')
    assert.equal(item.summary, '사업 & 설명')
    assert.equal(item.startsOn, '2026-08-01')
    assert.equal(item.endsOn, '2026-08-31')
    assert.match(item.detailUrl, /^https:\/\/www\.k-startup\.go\.kr\//)
  }
})

test('Bizinfo aliases normalize without allowing an off-domain detail URL', () => {
  const [item] = normalizeBizinfoPrograms({ jsonArray: [{
    seq: 'B-1', title: '수출 바우처', author: '중소벤처기업부', description: '<script>bad()</script>지원 내용',
    reqstDt: '2026-08-20 ~ 2026-09-10', link: 'https://malicious.example/collect',
  }] })
  assert.equal(item.title, '수출 바우처')
  assert.equal(item.endsOn, '2026-09-10')
  assert.equal(item.detailUrl, 'https://www.bizinfo.go.kr/sii/siia/selectSIIA200View.do')
  assert.doesNotMatch(item.summary, /<script>/)
  assert.doesNotMatch(item.summary, /bad\(\)/)
})

test('unconfigured sources perform zero network calls and return honest official fallbacks', async () => {
  let calls = 0
  const service = createSupportProgramService({ fetchImpl: async () => { calls += 1; throw new Error('must not call') }, cache: createMemorySupportProgramCache() })
  const result = await service.list()
  assert.equal(calls, 0)
  assert.deepEqual(result.items, [])
  assert.equal(result.sources.kstartup.state, 'unconfigured')
  assert.equal(result.sources.bizinfo.state, 'unconfigured')
  assert.equal(result.officialLinks.length, 2)
})

test('configured K-Startup uses one cached request while Bizinfo remains permission gated', async () => {
  let calls = 0
  const service = createSupportProgramService({
    kstartupServiceKey: 'secret-key',
    bizinfoCertKey: 'biz-secret',
    bizinfoCommercialUseApproved: false,
    cache: createMemorySupportProgramCache(),
    fetchImpl: async (url) => {
      calls += 1
      assert.equal(String(url).includes('secret-key'), true)
      return { ok: true, json: async () => ({ data: [{ pbanc_sn: '1', biz_pbanc_nm: '공식 공고', pbanc_rcpt_end_dt: '20260901' }] }) }
    },
    clock: () => new Date('2026-08-25T00:00:00.000Z'),
  })
  const first = await service.list({ limit: 4 })
  const second = await service.list({ limit: 4 })
  assert.equal(calls, 1)
  assert.equal(first.items.length, 1)
  assert.equal(second.items.length, 1)
  assert.equal(first.sources.bizinfo.state, 'permission-required')
  assert.equal(JSON.stringify(first).includes('secret-key'), false)
})

test('an upstream outage serves a recent cached feed as stale without leaking the failure', async () => {
  const cache = createMemorySupportProgramCache()
  await cache.put('kstartup', {
    items: [{ id: 'kstartup:cached', source: 'kstartup', sourceLabel: 'K-Startup', title: '캐시 공고', agency: '', operator: '', category: '', target: '', region: '', summary: '', startsOn: null, endsOn: '2026-09-30', periodRaw: null, publishedAt: null, detailUrl: 'https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do' }],
    fetchedAt: '2026-08-24T23:00:00.000Z', expiresAt: Date.parse('2026-08-24T23:30:00.000Z'), lastErrorCode: null,
  })
  const service = createSupportProgramService({
    kstartupServiceKey: 'hidden', cache, clock: () => new Date('2026-08-25T00:00:00.000Z'),
    fetchImpl: async () => { throw new Error('network detail') },
  })
  const result = await service.list({ source: 'kstartup' })
  assert.equal(result.stale, true)
  assert.equal(result.sources.kstartup.state, 'stale')
  assert.equal(result.items[0].title, '캐시 공고')
  assert.doesNotMatch(JSON.stringify(result), /network detail|hidden/)
})

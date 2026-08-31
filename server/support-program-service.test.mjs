import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createMemorySupportProgramCache,
  createSupportProgramService,
  normalizeBizinfoPrograms,
  normalizeKStartupHtmlPrograms,
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

test('Bizinfo official nested item shape normalizes without allowing an off-domain detail URL', () => {
  const [item] = normalizeBizinfoPrograms({ jsonArray: { item: [{
    seq: 'B-1', title: '수출 바우처', author: '중소벤처기업부', description: '<script>bad()</script>지원 내용',
    reqstDt: '2026-08-20 ~ 2026-09-10', link: 'https://malicious.example/collect',
  }] } })
  assert.equal(item.title, '수출 바우처')
  assert.equal(item.endsOn, '2026-09-10')
  assert.equal(item.detailUrl, 'https://www.bizinfo.go.kr/sii/siia/selectSIIA200View.do')
  assert.doesNotMatch(item.summary, /<script>/)
  assert.doesNotMatch(item.summary, /bad\(\)/)
})

test('K-Startup public summary exposes real official titles without a key while Bizinfo stays unconfigured', async () => {
  let calls = 0
  const html = `<div class="public_box public_box01"><a href="/web/contents/bizpbanc-ongoing.do?schM=view&pbancSn=178987">2026 공식 창업교육 참가자 모집</a></div>`
  const service = createSupportProgramService({
    fetchImpl: async (url) => {
      calls += 1
      assert.match(String(url), /mainSection0\.do/)
      return { ok: true, text: async () => html }
    },
    cache: createMemorySupportProgramCache(),
    clock: () => new Date('2026-08-26T00:00:00.000Z'),
  })
  const result = await service.list()
  const repeated = await service.list()
  assert.equal(calls, 1)
  assert.equal(result.items[0].title, '2026 공식 창업교육 참가자 모집')
  assert.equal(repeated.items.length, 1)
  assert.equal(result.sources.kstartup.state, 'public')
  assert.equal(result.sources.bizinfo.state, 'unconfigured')
  // 키가 없는 출처는 요청 전에 차단되므로 fetch 호출은 K-Startup 1건뿐이다.
  assert.equal(result.sources.g2b.state, 'unconfigured')
  assert.equal(result.sources.ulsan.state, 'unconfigured')
  assert.deepEqual(result.officialLinks.map((link) => link.source), ['kstartup', 'bizinfo', 'g2b', 'ulsan'])
})

test('나라장터 and 울산광역시 notices normalize into the same shape and keep their links on the official domain', async () => {
  const g2bBody = {
    response: {
      header: { resultCode: '00' },
      body: {
        items: {
          item: [{
            bidNtceNo: '20260831-001', bidNtceNm: '통합관제 시스템 유지관리 용역', ntceInsttNm: '울산광역시',
            dminsttNm: '울산정보산업진흥원', prtcptPsblRgnNm: '울산광역시', ntceKindNm: '일반입찰',
            bidNtceDt: '2026-08-25', bidClseDt: '2026-09-15', presmptPrce: '250000000',
            bidNtceDtlUrl: 'https://www.g2b.go.kr/notice/20260831-001',
          }],
        },
      },
    },
  }
  const ulsanBody = { response: { header: { resultCode: '00' }, body: { items: { item: [{
    nttNo: 'U-2026-77', title: '2026 지역 콘텐츠 기업 지원 공고', deptNm: '문화예술과',
    bgngDe: '2026-09-01', endDe: '2026-09-30', cn: '지역 콘텐츠 제작 기업을 지원합니다.',
    url: 'http://malicious.example.com/phish',
  }] } } } }
  const service = createSupportProgramService({
    fetchImpl: async (url) => ({ ok: true, json: async () => (String(url).includes('BidPublicInfo') ? g2bBody : ulsanBody) }),
    cache: createMemorySupportProgramCache(),
    clock: () => new Date('2026-08-31T00:00:00.000Z'),
    g2bServiceKey: 'g2b-key', ulsanServiceKey: 'ulsan-key',
  })

  const bids = await service.list({ source: 'g2b' })
  assert.equal(bids.items.length, 1)
  assert.deepEqual(
    { source: bids.items[0].source, label: bids.items[0].sourceLabel, endsOn: bids.items[0].endsOn, amount: bids.items[0].amount, region: bids.items[0].region },
    { source: 'g2b', label: '나라장터', endsOn: '2026-09-15', amount: 250_000_000, region: '울산광역시' },
  )
  assert.equal(bids.items[0].detailUrl, 'https://www.g2b.go.kr/notice/20260831-001')

  const notices = await service.list({ source: 'ulsan' })
  assert.equal(notices.items[0].sourceLabel, '울산광역시')
  assert.equal(notices.items[0].region, '울산광역시')
  assert.equal(notices.items[0].endsOn, '2026-09-30')
  assert.equal(notices.items[0].detailUrl, 'https://www.ulsan.go.kr/u/rep/bbs/list.ulsan?bbsId=BBS_0000000000000129', '도메인 밖 링크는 공식 페이지로 되돌린다')
  assert.doesNotMatch(JSON.stringify(notices), /ulsan-key|g2b-key/, '서비스 키는 응답에 새지 않는다')
})

test('a bad service key on the new sources surfaces as an error state, not a crash', async () => {
  const service = createSupportProgramService({
    fetchImpl: async () => ({ ok: true, json: async () => ({ response: { header: { resultCode: '30' } } }) }),
    cache: createMemorySupportProgramCache(),
    clock: () => new Date('2026-08-31T00:00:00.000Z'),
    g2bServiceKey: 'wrong-key',
  })
  const result = await service.list({ source: 'g2b' })
  assert.deepEqual(result.items, [])
  assert.equal(result.sources.g2b.state, 'error')
  assert.doesNotMatch(JSON.stringify(result), /wrong-key|UPSTREAM_AUTH/)
})

test('K-Startup public summary parser reads official direct links and rejects waiting pages', () => {
  const html = `<div class="public_box public_box02"><a href="/web/contents/bizpbanc-ongoing.do?schM=view&pbancSn=178283">[제64차] IR 참여기업 모집</a><span class="deadline">오늘마감</span></div>`
  const [item] = normalizeKStartupHtmlPrograms(html, new Date('2026-08-26T00:00:00.000Z'))
  assert.equal(item.id, 'kstartup:178283')
  assert.equal(item.title, '[제64차] IR 참여기업 모집')
  assert.equal(item.endsOn, '2026-08-26')
  assert.equal(item.feedMode, 'public-html')
  assert.match(item.detailUrl, /^https:\/\/www\.k-startup\.go\.kr\/web\/contents\//)
  assert.deepEqual(normalizeKStartupHtmlPrograms('<div class="public_box01">서비스 접속 대기</div>'), [])
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

test('Bizinfo HTTP 200 auth errors never become a live empty cache', async () => {
  const service = createSupportProgramService({
    bizinfoCertKey: 'bad-key', bizinfoCommercialUseApproved: true,
    cache: createMemorySupportProgramCache(),
    fetchImpl: async (url) => {
      if (String(url).includes('bizinfo')) return { ok: true, json: async () => ({ reqErr: '인증키를 입력해주세요.' }) }
      return { ok: true, text: async () => '<div class="public_box01"><a href="/web/contents/bizpbanc-ongoing.do?pbancSn=1">공식 공고</a></div>' }
    },
  })
  const result = await service.list({ source: 'bizinfo' })
  assert.deepEqual(result.items, [])
  assert.equal(result.sources.bizinfo.state, 'error')
})

test('revoked Bizinfo permission hides a previously approved cache immediately', async () => {
  const cache = createMemorySupportProgramCache()
  await cache.put('bizinfo', {
    items: [{ id: 'bizinfo:cached', source: 'bizinfo', sourceLabel: '기업마당', title: '허가 시 캐시', agency: '', operator: '', category: '', target: '', region: '', summary: '', startsOn: null, endsOn: '2026-09-30', periodRaw: null, publishedAt: null, detailUrl: 'https://www.bizinfo.go.kr/sii/siia/selectSIIA200View.do', feedMode: 'api' }],
    fetchedAt: '2026-08-26T00:00:00.000Z', expiresAt: Date.parse('2026-08-26T01:00:00.000Z'), lastErrorCode: null,
  })
  const service = createSupportProgramService({
    bizinfoCertKey: 'configured', bizinfoCommercialUseApproved: false, cache,
    clock: () => new Date('2026-08-26T00:10:00.000Z'),
    fetchImpl: async () => { throw new Error('permission gate must run before fetch') },
  })
  const result = await service.list({ source: 'bizinfo' })
  assert.deepEqual(result.items, [])
  assert.equal(result.sources.bizinfo.state, 'permission-required')
})

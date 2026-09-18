import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createApp } from './app.mjs'
import {
  DEFAULT_WATCH_KEYWORDS,
  defaultOpportunitySettings,
  ingestTokenMatches,
  normalizeIngestBatch,
  normalizeOpportunitySettings,
  normalizeScore,
  opportunityStatusFor,
  opportunityVerdict,
} from './opportunity-ingest.mjs'
import { withServer } from './test-server.mjs'

const TOKEN = 'ingest-token-for-tests-0123456789'

async function login(origin, email) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: 'tenant', email, password: 'demo1234' }),
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  return { cookie: response.headers.get('set-cookie').split(';')[0], account: body.account, identity: `${body.account.tenantId}:${body.account.id}` }
}

const ingest = (origin, body, token = TOKEN) => fetch(`${origin}/api/opportunities/ingest`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
})

test('industry modules seed the watch keywords and the tenant can override them', () => {
  assert.deepEqual(defaultOpportunitySettings('food_manufacturing').keywords, DEFAULT_WATCH_KEYWORDS.food_manufacturing)
  assert.deepEqual(defaultOpportunitySettings('it_services').keywords, DEFAULT_WATCH_KEYWORDS.it_services)
  assert.equal(defaultOpportunitySettings('it_services').scoreThreshold, 0.6)
  const custom = normalizeOpportunitySettings({ keywords: ['수산물 납품', '수산물 납품', ''], regions: ['경북'], minAmount: '50000000', scoreThreshold: 0.85 }, 'food_manufacturing')
  assert.deepEqual(custom.keywords, ['수산물 납품'])
  assert.deepEqual(custom.regions, ['경북'])
  assert.equal(custom.minAmount, 50_000_000)
  assert.equal(custom.scoreThreshold, 0.85)
  // 잘못된 값은 업종 기본값으로 되돌린다.
  assert.equal(normalizeOpportunitySettings({ scoreThreshold: 5 }, 'it_services').scoreThreshold, 0.6)
})

test('ingest payloads are validated and deduplicated inside one batch', () => {
  assert.throws(() => normalizeIngestBatch({ opportunities: [{ title: '제목만' }] }), /공고번호/)
  const items = normalizeIngestBatch({
    opportunities: [
      { source: '나라장터', noticeNo: '2026-1', title: '급식 위탁 용역', tenantId: 'T1', deadline: '2026-09-30', amount: '120000000', link: 'https://example.gov/1', score: 0.8, rationale: '급식 키워드 일치' },
      { source: '나라장터', noticeNo: '2026-1', title: '중복', tenantId: 'T1' },
      { source: '기업마당', noticeNo: '2026-1', title: '같은 번호 다른 출처', tenantId: 'T1', deadline: '2026-02-30' },
    ],
  })
  assert.equal(items.length, 2)
  assert.equal(items[0].amount, 120_000_000)
  assert.equal(items[1].deadline, '', '달력에 없는 마감일은 버린다')
  assert.equal(items[0].score, 0.8)
})

test('a score arrives as either a 0~1 ratio or a 0~100 percentage and lands on the same confidence', () => {
  const percent = normalizeIngestBatch({ opportunities: [{ noticeNo: 'P-1', title: '백분율 워커', tenantId: 'T1', score: 88 }] })[0]
  const ratio = normalizeIngestBatch({ opportunities: [{ noticeNo: 'R-1', title: '비율 워커', tenantId: 'T1', score: 0.88 }] })[0]
  assert.equal(percent.score, 0.88)
  assert.equal(ratio.score, 0.88)
  assert.equal(percent.score, ratio.score, '88과 0.88은 같은 신뢰도로 정규화된다')

  // 원본과 스케일 판정은 근거로 남긴다.
  assert.deepEqual({ raw: percent.rawScore, scale: percent.scoreScale }, { raw: 88, scale: 'percent' })
  assert.deepEqual({ raw: ratio.rawScore, scale: ratio.scoreScale }, { raw: 0.88, scale: 'ratio' })

  // 임계값 판정도 동일해야 한다.
  const settings = { scoreThreshold: 0.6, minAmount: 0 }
  assert.equal(opportunityStatusFor(percent, settings), 'queued')
  assert.equal(opportunityStatusFor(ratio, settings), 'queued')
})

test('score scale edges are read the way a worker would expect', () => {
  assert.deepEqual(normalizeScore(1), { confidence: 1, scale: 'ratio', raw: 1 }, '1은 비율 만점이지 1%가 아니다')
  assert.deepEqual(normalizeScore(100), { confidence: 1, scale: 'percent', raw: 100 })
  assert.equal(normalizeScore(0).confidence, 0)
  assert.equal(normalizeScore(101), null, '어느 스케일로도 성립하지 않는 값은 점수 없음')
  assert.equal(normalizeScore(-1), null)
  assert.equal(normalizeScore('88').confidence, 0.88, '문자열로 와도 같은 규칙을 쓴다')
  assert.equal(normalizeScore(undefined), null)
  assert.equal(normalizeScore('알 수 없음'), null)
})

test('a verdict explains why a signal missed the queue', () => {
  const settings = { scoreThreshold: 0.6, minAmount: 50_000_000 }
  const low = opportunityVerdict({ score: 0.4, amount: 80_000_000 }, settings)
  assert.equal(low.status, 'below-threshold')
  assert.equal(low.thresholdMet, false)
  assert.equal(low.amountMet, true)
  assert.match(low.reason, /0\.4.*0\.6 미만/)

  const small = opportunityVerdict({ score: 0.9, amount: 1_000_000 }, settings)
  assert.equal(small.thresholdMet, true)
  assert.equal(small.amountMet, false)
  assert.match(small.reason, /하한/)

  assert.match(opportunityVerdict({ score: null, amount: 0 }, settings).reason, /판정 점수가 없어/)
  assert.equal(opportunityVerdict({ score: 0.7, amount: 80_000_000 }, settings).status, 'queued')
})

test('score and amount thresholds decide whether a signal reaches the approval queue', () => {
  const settings = { scoreThreshold: 0.6, minAmount: 50_000_000 }
  assert.equal(opportunityStatusFor({ score: 0.7, amount: 80_000_000 }, settings), 'queued')
  assert.equal(opportunityStatusFor({ score: 0.4, amount: 80_000_000 }, settings), 'below-threshold')
  assert.equal(opportunityStatusFor({ score: null, amount: 80_000_000 }, settings), 'below-threshold')
  assert.equal(opportunityStatusFor({ score: 0.9, amount: 1_000_000 }, settings), 'below-threshold')
})

test('ingest token comparison rejects wrong and empty tokens', () => {
  assert.equal(ingestTokenMatches('abc123', 'abc123'), true)
  assert.equal(ingestTokenMatches('abc123', 'abc124'), false)
  assert.equal(ingestTokenMatches('abc123', 'abc'), false)
  assert.equal(ingestTokenMatches('', ''), false)
})

test('an ingested opportunity reaches the approval queue once and creates a review task when approved', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inthefield-opportunity-'))
  try {
    await withServer(createApp({ apiKey: '', workspaceStoreFile: path.join(directory, 'state.json'), env: { OPPORTUNITY_INGEST_TOKEN: TOKEN } }), async (origin) => {
      const admin = await login(origin, 'admin@sunsea.co.kr')
      const headers = { cookie: admin.cookie, 'x-workspace-identity': admin.identity, 'content-type': 'application/json' }
      const tenantId = admin.account.tenantId

      assert.equal((await ingest(origin, { opportunities: [] }, '')).status, 401)
      assert.equal((await ingest(origin, { opportunities: [{ noticeNo: '1', title: 'x', tenantId }] }, 'wrong-token-length-mismatch')).status, 401)

      const first = await ingest(origin, {
        opportunities: [
          { source: '나라장터', noticeNo: 'G2026-0001', title: '학교 급식 식자재 납품', tenantId, agency: '○○교육청', deadline: '2026-10-15', amount: 240_000_000, link: 'https://www.g2b.go.kr/notice/1', score: 0.82, rationale: '감시 키워드 "급식" 일치 · 납품 품목 3종 일치' },
          { source: '기업마당', noticeNo: 'B2026-0007', title: '스마트공장 컨설팅 지원', tenantId, agency: '중소벤처기업부', deadline: '2026-09-20', amount: 30_000_000, link: 'https://www.bizinfo.go.kr/notice/7', score: 0.31, rationale: '업종은 맞지만 품목 불일치' },
        ],
      })
      assert.equal(first.status, 201)
      const firstBody = await first.json()
      assert.deepEqual(
        { accepted: firstBody.accepted, queued: firstBody.queued, belowThreshold: firstBody.belowThreshold, duplicate: firstBody.duplicate, unknownTenant: firstBody.unknownTenant },
        { accepted: 2, queued: 1, belowThreshold: 1, duplicate: 0, unknownTenant: 0 },
      )

      // 워커는 응답만 보고 왜 큐에 안 올랐는지 알 수 있어야 한다.
      const rejected = firstBody.results.find((line) => line.noticeNo === 'B2026-0007')
      assert.deepEqual(
        { outcome: rejected.outcome, score: rejected.score, scale: rejected.scoreScale, threshold: rejected.threshold, thresholdMet: rejected.thresholdMet },
        { outcome: 'below-threshold', score: 0.31, scale: 'ratio', threshold: 0.6, thresholdMet: false },
      )
      assert.match(rejected.reason, /기준 0\.6 미만/)
      assert.equal(firstBody.results.find((line) => line.noticeNo === 'G2026-0001').outcome, 'queued')

      const listed = await (await fetch(`${origin}/api/opportunities`, { headers })).json()
      assert.equal(listed.opportunities.length, 2)
      assert.equal(listed.queuedCount, 1)
      assert.equal(listed.ingestConfigured, true)
      assert.deepEqual(listed.settings.keywords, DEFAULT_WATCH_KEYWORDS.food_manufacturing)

      const queue = await (await fetch(`${origin}/api/proposals`, { headers })).json()
      const proposal = queue.proposals.find((item) => item.kind === 'opportunity')
      assert.ok(proposal, '임계값을 넘은 기회만 승인 큐에 올라간다')
      assert.match(proposal.summary, /학교 급식 식자재 납품 검토/)
      assert.equal(queue.proposals.filter((item) => item.kind === 'opportunity').length, 1, '임계 미만 건은 큐에 올리지 않는다')

      // 같은 공고번호를 다시 보내도 중복되지 않는다.
      const again = await ingest(origin, { opportunities: [{ source: '나라장터', noticeNo: 'G2026-0001', title: '학교 급식 식자재 납품', tenantId, score: 0.9 }] })
      const againBody = await again.json()
      assert.equal(againBody.duplicate, 1)
      assert.equal(againBody.results[0].outcome, 'duplicate')
      assert.match(againBody.results[0].reason, /이미 등록/)
      const afterDuplicate = await (await fetch(`${origin}/api/opportunities`, { headers })).json()
      assert.equal(afterDuplicate.opportunities.length, 2)

      // 승인하면 기존 결재 흐름대로 검토 업무가 만들어진다.
      const decided = await fetch(`${origin}/api/proposals/${proposal.id}/decide`, { method: 'POST', headers, body: JSON.stringify({ decision: 'approve' }) })
      assert.equal(decided.status, 200)
      const decidedBody = await decided.json()
      assert.equal(decidedBody.resultRef.type, 'work-item')
      const workItems = await (await fetch(`${origin}/api/workspace/work-items`, { headers })).json()
      const created = workItems.data.find((item) => item.id === decidedBody.resultRef.id)
      assert.match(created.title, /학교 급식 식자재 납품 검토/)
      assert.equal(created.category, '외부 기회')

      // 임계값을 낮추면 다음 인제스트부터 큐에 올라간다.
      const saved = await fetch(`${origin}/api/opportunities/settings`, { method: 'PUT', headers, body: JSON.stringify({ settings: { keywords: ['급식', '수산물 납품'], scoreThreshold: 0.3, minAmount: 0 } }) })
      assert.equal(saved.status, 200)
      assert.equal((await saved.json()).settings.scoreThreshold, 0.3)
      // 워커가 백분율로 보내도 같은 임계값 판정을 받는다 (35점 = 0.35 ≥ 0.3).
      const third = await ingest(origin, { opportunities: [{ source: '기업마당', noticeNo: 'B2026-0009', title: '수산물 가공 R&D', tenantId, score: 35 }] })
      const thirdBody = await third.json()
      assert.deepEqual(
        { accepted: thirdBody.accepted, queued: thirdBody.queued, belowThreshold: thirdBody.belowThreshold, duplicate: thirdBody.duplicate, unknownTenant: thirdBody.unknownTenant },
        { accepted: 1, queued: 1, belowThreshold: 0, duplicate: 0, unknownTenant: 0 },
      )
      assert.deepEqual(
        { raw: thirdBody.results[0].rawScore, scale: thirdBody.results[0].scoreScale, score: thirdBody.results[0].score },
        { raw: 35, scale: 'percent', score: 0.35 },
      )
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('ingest never crosses tenants and generic writes cannot forge opportunities', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inthefield-opportunity-auth-'))
  try {
    await withServer(createApp({ apiKey: '', workspaceStoreFile: path.join(directory, 'state.json'), env: { OPPORTUNITY_INGEST_TOKEN: TOKEN } }), async (origin) => {
      const admin = await login(origin, 'admin@sunsea.co.kr')
      const other = await login(origin, 'admin@pohangcoop.co.kr')
      const headers = { cookie: admin.cookie, 'x-workspace-identity': admin.identity, 'content-type': 'application/json' }

      const unknown = await ingest(origin, { opportunities: [{ noticeNo: 'X-1', title: '없는 고객사', tenantId: 'TENANT-DOES-NOT-EXIST' }] })
      assert.equal(unknown.status, 404)
      assert.equal((await unknown.json()).unknownTenant, 1)

      await ingest(origin, { opportunities: [{ source: '나라장터', noticeNo: 'G-100', title: '햇살 전용 공고', tenantId: admin.account.tenantId, score: 0.9 }] })
      const mine = await (await fetch(`${origin}/api/opportunities`, { headers })).json()
      assert.equal(mine.opportunities.length, 1)
      const theirs = await (await fetch(`${origin}/api/opportunities`, { headers: { cookie: other.cookie, 'x-workspace-identity': other.identity } })).json()
      assert.deepEqual(theirs.opportunities, [], '다른 고객사의 기회는 보이지 않는다')

      const forged = await fetch(`${origin}/api/workspace/opportunities`, { method: 'PUT', headers, body: JSON.stringify({ data: [{ id: 'FORGED' }] }) })
      assert.equal(forged.status, 403)
      assert.equal((await forged.json()).error.code, 'OPPORTUNITY_ROUTE_REQUIRED')
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('ingest is disabled until a token is configured', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inthefield-opportunity-off-'))
  try {
    await withServer(createApp({ apiKey: '', workspaceStoreFile: path.join(directory, 'state.json'), env: {} }), async (origin) => {
      const response = await ingest(origin, { opportunities: [{ noticeNo: '1', title: 'x', tenantId: 'T' }] })
      assert.equal(response.status, 503)
      assert.equal((await response.json()).error.code, 'INGEST_NOT_CONFIGURED')
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('나라장터 참가 조건(기초금액·면허제한·참가가능지역)이 저장되고 승인 큐 카드와 목록에 같은 문장으로 실린다', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inthefield-opportunity-conditions-'))
  try {
    await withServer(createApp({ apiKey: '', workspaceStoreFile: path.join(directory, 'state.json'), env: { OPPORTUNITY_INGEST_TOKEN: TOKEN } }), async (origin) => {
      const admin = await login(origin, 'admin@sunsea.co.kr')
      const headers = { cookie: admin.cookie, 'x-workspace-identity': admin.identity, 'content-type': 'application/json' }
      const tenantId = admin.account.tenantId
      const conditions = {
        source: 'g2b',
        baseAmount: { fetched: true, amount: 0, openedAt: '', rangeRate: '', note: '비예가(협상에 의한 계약) — 기초금액이 없는 공고입니다' },
        licenses: { fetched: true, restricted: true, groups: [{ group: '1', items: [{ name: '소프트웨어사업자(컴퓨터관련서비스사업)', code: '1468' }] }], permittedIndustries: [] },
        regions: { fetched: true, allowed: ['전북특별자치도'] },
        errors: [],
      }
      const failedLookup = { source: 'g2b', baseAmount: { fetched: true, amount: 215_600_000, openedAt: '2026-09-14', rangeRate: '-2% ~ +2%' }, licenses: { fetched: false }, regions: { fetched: false }, errors: ['면허제한 조회 실패: 상류 오류 08'] }
      const response = await ingest(origin, {
        opportunities: [
          { source: '나라장터', noticeNo: 'R26BK01726578-000', title: '홈페이지 리뉴얼 구축 용역', tenantId, score: 0.9, conditions, extraction: { attempted: true, succeeded: true, files: [{ name: '공고문.hwp', format: 'hwp', ok: true, chars: 5200 }], chars: 5200 } },
          { source: '나라장터', noticeNo: 'R26BK00000001-000', title: '폐기물 처리 용역', tenantId, score: 0.1, conditions: failedLookup },
        ],
      })
      assert.equal(response.status, 201)

      const listed = await (await fetch(`${origin}/api/opportunities`, { headers })).json()
      const homepage = listed.opportunities.find((item) => item.noticeNo === 'R26BK01726578-000')
      assert.equal(homepage.conditions.licenses.groups[0].items[0].code, '1468')
      assert.equal(homepage.extraction.files[0].name, '공고문.hwp', '워커가 보낸 첨부 읽기 결과를 버리지 않는다')
      assert.deepEqual(homepage.conditionLines, [
        '기초금액 없음 — 비예가(협상에 의한 계약) — 기초금액이 없는 공고입니다',
        '면허제한 소프트웨어사업자(컴퓨터관련서비스사업)[1468]',
        '참가가능지역 전북특별자치도',
      ])
      // 조회에 실패한 항목은 "제한 없음"이 아니라 "확인 필요"로 말한다.
      const failed = listed.opportunities.find((item) => item.noticeNo === 'R26BK00000001-000')
      assert.deepEqual(failed.conditionLines, [
        '기초금액 215,600,000원 (2026-09-14 공개) · 예비가격 -2% ~ +2%',
        '면허·업종 제한 확인 필요(조회 실패)',
        '참가가능지역 확인 필요(조회 실패)',
      ])

      const queue = await (await fetch(`${origin}/api/proposals`, { headers })).json()
      const proposal = queue.proposals.find((item) => item.kind === 'opportunity')
      assert.match(proposal.evidence, /면허제한 소프트웨어사업자\(컴퓨터관련서비스사업\)\[1468\] · 참가가능지역 전북특별자치도/)
      assert.match(proposal.payload.description, /참가가능지역 전북특별자치도/)
      assert.equal(proposal.payload.conditions.regions.allowed[0], '전북특별자치도')
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('조건 정규화는 모양이 어긋난 값을 걸러 내고, 아무것도 조회하지 않았으면 조건 자체를 두지 않는다', () => {
  const [item] = normalizeIngestBatch({ opportunities: [{ noticeNo: 'N1', title: '제목', tenantId: 'T', conditions: { source: 'g2b', licenses: { fetched: 'yes', groups: [{ items: [{ name: '<b>정보통신공사업</b>', code: '0036' }, { code: '9' }] }] }, regions: 'x' } }] })
  assert.equal(item.conditions, null, 'fetched가 true가 아닌 값은 조회한 것으로 치지 않는다')
  const [kept] = normalizeIngestBatch({ opportunities: [{ noticeNo: 'N2', title: '제목', tenantId: 'T', conditions: { source: 'g2b', licenses: { fetched: true, groups: [{ items: [{ name: '<b>정보통신공사업</b>', code: '0036' }, { code: '9' }] }] } } }] })
  assert.deepEqual(kept.conditions.licenses.groups, [{ group: '1', items: [{ name: '정보통신공사업', code: '0036' }] }])
  assert.equal(kept.conditions.regions.fetched, false)
})

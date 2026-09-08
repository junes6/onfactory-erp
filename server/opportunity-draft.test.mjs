import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createApp } from './app.mjs'
import {
  DRAFT_CATEGORY,
  DRAFT_TAG,
  DRAFT_TICKET_TTL_MS,
  draftDocumentFields,
  draftUploadSlot,
  signDraftTicket,
  verifyDraftTicket,
} from './opportunity-draft.mjs'
import { withServer } from './test-server.mjs'

const TOKEN = 'ingest-token-for-tests-0123456789'
const NOW = Date.parse('2026-09-08T00:00:00.000Z')

async function login(origin, email) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: 'tenant', email, password: 'demo1234' }),
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  return { cookie: response.headers.get('set-cookie').split(';')[0], account: body.account, identity: `${body.account.tenantId}:${body.account.id}` }
}

const ingest = (origin, opportunities, token = TOKEN) => fetch(`${origin}/api/opportunities/ingest`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify({ opportunities }),
})

const uploadDraft = (origin, slot, markdown, { ticket = slot?.ticket, query = '' } = {}) => fetch(`${origin}${slot.path}${query}`, {
  method: 'POST',
  headers: { authorization: `Bearer ${ticket}`, 'content-type': 'text/markdown' },
  body: markdown,
})

const withApp = async (label, run, env = { OPPORTUNITY_INGEST_TOKEN: TOKEN }) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), `inthefield-${label}-`))
  try {
    await withServer(createApp({ apiKey: '', workspaceStoreFile: path.join(directory, 'state.json'), env }), run)
  } finally { await rm(directory, { recursive: true, force: true }) }
}

const draftNotice = (tenantId, noticeNo, extra = {}) => ({
  source: '나라장터', noticeNo, title: `${noticeNo} 판로개척 지원사업`, tenantId, score: 0.9,
  draft: { name: `${noticeNo} 신청서 초안.md`, sections: 5, needsInput: 2 },
  ...extra,
})

// ------------------------------------------------------------------
// 1) 자리표 자체
// ------------------------------------------------------------------

test('자리표는 테넌트·기회·만료를 함께 서명하고, 한 글자만 달라도 열리지 않는다', () => {
  const expiresAt = NOW + DRAFT_TICKET_TTL_MS
  const ticket = signDraftTicket({ secret: TOKEN, tenantId: 'TENANT-A', opportunityId: 'OPP-1', expiresAt })

  const opened = verifyDraftTicket({ secret: TOKEN, ticket, now: NOW })
  assert.deepEqual(
    { ok: opened.ok, tenantId: opened.tenantId, opportunityId: opened.opportunityId },
    { ok: true, tenantId: 'TENANT-A', opportunityId: 'OPP-1' },
  )

  // 본문만 바꿔치기하면 서명이 맞지 않는다 — 워커가 테넌트를 스스로 고를 길이 없다.
  const [version, payload, signature] = ticket.split('.')
  const forgedPayload = Buffer.from(JSON.stringify({ t: 'TENANT-B', o: 'OPP-1', x: expiresAt }), 'utf8').toString('base64url')
  assert.equal(verifyDraftTicket({ secret: TOKEN, ticket: `${version}.${forgedPayload}.${signature}`, now: NOW }).code, 'DRAFT_TICKET_INVALID')

  // 인제스트 토큰이 바뀌면(회전) 남아 있던 자리표가 함께 닫힌다.
  assert.equal(verifyDraftTicket({ secret: `${TOKEN}-rotated`, ticket, now: NOW }).code, 'DRAFT_TICKET_INVALID')

  assert.equal(verifyDraftTicket({ secret: TOKEN, ticket, now: expiresAt + 1 }).code, 'DRAFT_TICKET_EXPIRED')
  assert.equal(verifyDraftTicket({ secret: TOKEN, ticket: '', now: NOW }).code, 'DRAFT_TICKET_REQUIRED')
  assert.equal(verifyDraftTicket({ secret: TOKEN, ticket: TOKEN, now: NOW }).code, 'DRAFT_TICKET_INVALID', '인제스트 토큰은 자리표가 아니다')
})

test('자리는 초안을 예고했고 아직 문서가 붙지 않은 건에만 발급된다', () => {
  const base = { id: 'OPP-1', key: '나라장터:G-1', title: '판로개척' }
  const slot = draftUploadSlot({ secret: TOKEN, tenantId: 'TENANT-A', record: { ...base, draft: { documentId: '', name: '초안.md' } }, now: NOW })
  assert.equal(slot.opportunityId, 'OPP-1')
  assert.equal(slot.path, '/api/opportunities/OPP-1/draft')
  assert.equal(slot.expiresAt, new Date(NOW + DRAFT_TICKET_TTL_MS).toISOString())

  assert.equal(draftUploadSlot({ secret: TOKEN, tenantId: 'TENANT-A', record: { ...base, draft: null }, now: NOW }), null, '예고 없는 건에는 자리가 없다')
  assert.equal(draftUploadSlot({ secret: TOKEN, tenantId: 'TENANT-A', record: { ...base, draft: { documentId: 'DOC-1' } }, now: NOW }), null, '이미 붙은 건에도 자리가 없다')
  assert.equal(draftUploadSlot({ secret: '', tenantId: 'TENANT-A', record: { ...base, draft: { documentId: '' } }, now: NOW }), null)
})

test('초안 문서의 분류·태그·열람 범위는 기록에서만 나온다', () => {
  const fields = draftDocumentFields({ id: 'OPP-1', key: '나라장터:G-1' })
  assert.equal(fields.category, DRAFT_CATEGORY)
  assert.equal(fields.visibility, 'all')
  assert.deepEqual(fields.departments, [])
  assert.deepEqual(fields.allowedUserIds, [])
  assert.deepEqual(fields.tags, [DRAFT_TAG, 'opportunity:나라장터:G-1'])
})

// ------------------------------------------------------------------
// 2) 라우트
// ------------------------------------------------------------------

test('인제스트가 자리를 돌려주고, 사람 세션 없이 초안 하나가 그 기회에 묶인다', async () => {
  await withApp('opportunity-draft-happy', async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const headers = { cookie: admin.cookie, 'x-workspace-identity': admin.identity }
    const tenantId = admin.account.tenantId

    const response = await ingest(origin, [draftNotice(tenantId, 'G-1')])
    assert.equal(response.status, 201)
    const line = (await response.json()).results[0]
    assert.ok(line.draftUpload?.ticket, '수용된 건은 초안 자리를 함께 받는다')
    assert.equal(line.draftUpload.path, `/api/opportunities/${line.draftUpload.opportunityId}/draft`)

    /**
     * 워커가 분류·태그·열람 범위를 함께 보내도 서버는 자기 기록만 본다.
     * 여기서 보낸 값은 통과했다면 **공장 도면**이 되는 값이다 — 회사 관리자만 만들 수 있는 자료다.
     */
    const uploaded = await uploadDraft(origin, line.draftUpload, '# 판로개척 신청서 초안\n\n확인 필요 2곳', {
      query: '?category=%EA%B3%B5%EC%9E%A5%EB%8F%84%EB%A9%B4&visibility=restricted&tags=factory-drawing&allowedUserIds=USR-X',
    })
    assert.equal(uploaded.status, 201)
    const documentId = (await uploaded.json()).document.id

    const documents = (await (await fetch(`${origin}/api/documents`, { headers })).json()).documents
    const stored = documents.find((item) => item.id === documentId)
    assert.equal(stored.category, DRAFT_CATEGORY, '워커가 보낸 분류를 믿지 않는다')
    assert.equal(stored.visibility, 'all')
    assert.deepEqual(stored.allowedUserIds, [])
    assert.deepEqual(stored.tags, [DRAFT_TAG, 'opportunity:나라장터:G-1'])
    assert.equal(stored.name, 'G-1 신청서 초안.md')
    assert.equal(stored.mime, 'text/markdown')
    assert.equal(stored.uploadedByRole, 'opportunity-ingest', '사람이 올린 것처럼 꾸미지 않는다')

    // 기회와 승인 큐의 제안이 같은 문서를 가리킨다.
    const opportunity = (await (await fetch(`${origin}/api/opportunities`, { headers })).json())
      .opportunities.find((item) => item.id === line.draftUpload.opportunityId)
    assert.equal(opportunity.draft.documentId, documentId)
    const proposal = (await (await fetch(`${origin}/api/proposals`, { headers })).json())
      .proposals.find((item) => item.kind === 'opportunity' && item.payload?.opportunityId === opportunity.id)
    assert.equal(proposal.payload.draft.documentId, documentId, '큐의 제안도 같은 문서를 가리킨다')

    // 내려받으면 워커가 보낸 바이트 그대로다.
    const download = await fetch(`${origin}/api/documents/${documentId}/download`, { headers })
    assert.equal(download.status, 200)
    assert.match(await download.text(), /판로개척 신청서 초안/)
  })
})

test('한 자리는 한 번만 쓰인다 — 같은 자리표로 두 번째 초안을 밀어 넣을 수 없다', async () => {
  await withApp('opportunity-draft-once', async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const headers = { cookie: admin.cookie, 'x-workspace-identity': admin.identity }

    const line = (await (await ingest(origin, [draftNotice(admin.account.tenantId, 'G-2')])).json()).results[0]
    assert.equal((await uploadDraft(origin, line.draftUpload, '# 첫 초안')).status, 201)

    const again = await uploadDraft(origin, line.draftUpload, '# 두 번째 초안')
    assert.equal(again.status, 409)
    assert.equal((await again.json()).error.code, 'DRAFT_ALREADY_UPLOADED')

    const documents = (await (await fetch(`${origin}/api/documents`, { headers })).json()).documents
    assert.equal(documents.filter((item) => item.tags?.includes(DRAFT_TAG)).length, 1, '두 번째 바이트는 저장소에 남지 않는다')
  })
})

test('인제스트 토큰은 초안 라우트도 자료실도 열지 못한다', async () => {
  await withApp('opportunity-draft-token-scope', async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const line = (await (await ingest(origin, [draftNotice(admin.account.tenantId, 'G-3')])).json()).results[0]

    // 인제스트 토큰을 자리표 자리에 넣어도 열리지 않는다.
    const raw = await uploadDraft(origin, line.draftUpload, '# 초안', { ticket: TOKEN })
    assert.equal(raw.status, 401)
    assert.equal((await raw.json()).error.code, 'DRAFT_TICKET_INVALID')

    // 자리표로도 일반 자료실은 열리지 않는다 — 초안 하나, 그 기회에 묶인 것뿐이다.
    for (const credential of [TOKEN, line.draftUpload.ticket]) {
      const general = await fetch(`${origin}/api/documents?name=%EB%AC%B4%EB%8B%A8.md`, {
        method: 'POST',
        headers: { authorization: `Bearer ${credential}`, 'content-type': 'text/markdown', 'x-file-name': 'x.md' },
        body: '# 무단',
      })
      assert.equal(general.status, 401, '세션 없는 자료실 업로드는 여전히 닫혀 있다')
    }
  })
})

test('자리표는 그것이 지목한 테넌트 밖으로 한 바이트도 나가지 않는다', async () => {
  await withApp('opportunity-draft-tenant', async (origin) => {
    const mine = await login(origin, 'admin@sunsea.co.kr')
    const other = await login(origin, 'admin@pohangcoop.co.kr')
    const otherHeaders = { cookie: other.cookie, 'x-workspace-identity': other.identity }

    const results = (await (await ingest(origin, [
      draftNotice(mine.account.tenantId, 'G-4'),
      draftNotice(other.account.tenantId, 'G-5'),
    ])).json()).results
    const mineSlot = results.find((item) => item.tenantId === mine.account.tenantId).draftUpload
    const otherSlot = results.find((item) => item.tenantId === other.account.tenantId).draftUpload

    // 내 자리표를 남의 기회 주소에 들이민다.
    const crossed = await fetch(`${origin}/api/opportunities/${otherSlot.opportunityId}/draft`, {
      method: 'POST',
      headers: { authorization: `Bearer ${mineSlot.ticket}`, 'content-type': 'text/markdown' },
      body: '# 남의 자료실로',
    })
    assert.equal(crossed.status, 403)
    assert.equal((await crossed.json()).error.code, 'DRAFT_TICKET_MISMATCH')

    const theirDocuments = (await (await fetch(`${origin}/api/documents`, { headers: otherHeaders })).json()).documents
    assert.deepEqual(theirDocuments.filter((item) => item.tags?.includes(DRAFT_TAG)), [], '남의 자료실에는 아무것도 남지 않는다')

    // 자기 자리표는 자기 기회에서만 연다.
    assert.equal((await uploadDraft(origin, otherSlot, '# 제 초안')).status, 201)
  })
})

test('초안을 예고하지 않았거나 이미 있는 건에는 자리가 없다', async () => {
  await withApp('opportunity-draft-noslot', async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const tenantId = admin.account.tenantId

    const first = (await (await ingest(origin, [
      { source: '나라장터', noticeNo: 'G-6', title: '초안 없는 공고', tenantId, score: 0.9 },
      draftNotice(tenantId, 'G-7'),
      draftNotice(tenantId, 'G-8', { score: 0.1 }),
    ])).json()).results
    assert.equal(first[0].draftUpload, null, '초안을 예고하지 않은 건에는 자리가 없다')
    assert.ok(first[1].draftUpload, '큐에 오른 건에는 자리가 있다')
    assert.ok(first[2].draftUpload, '임계 미만이어도 목록에는 남으므로 초안은 붙는다')

    // 같은 공고를 다시 보내면 중복이라 아무것도 저장되지 않는다 — 자리도 없다.
    const second = (await (await ingest(origin, [draftNotice(tenantId, 'G-7')])).json()).results
    assert.equal(second[0].outcome, 'duplicate')
    assert.equal(second[0].draftUpload, null, '중복 건에 자리를 주면 있던 초안을 덮어쓴다')

    // 없는 고객사에도 자리는 없다.
    const unknown = (await (await ingest(origin, [draftNotice('TENANT-DOES-NOT-EXIST', 'G-9')])).json()).results
    assert.equal(unknown[0].draftUpload, null)
  })
})

test('없는 기회·만료된 자리·빈 본문은 사유가 붙은 채로 거절된다', async () => {
  await withApp('opportunity-draft-refusals', async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const line = (await (await ingest(origin, [draftNotice(admin.account.tenantId, 'G-10')])).json()).results[0]

    const empty = await uploadDraft(origin, line.draftUpload, '')
    assert.equal(empty.status, 400)
    assert.equal((await empty.json()).error.code, 'DRAFT_FILE_REQUIRED')

    const expired = signDraftTicket({
      secret: TOKEN, tenantId: admin.account.tenantId, opportunityId: line.draftUpload.opportunityId, expiresAt: Date.now() - 1,
    })
    const stale = await uploadDraft(origin, line.draftUpload, '# 초안', { ticket: expired })
    assert.equal(stale.status, 401)
    assert.equal((await stale.json()).error.code, 'DRAFT_TICKET_EXPIRED')
    assert.match((await (await uploadDraft(origin, line.draftUpload, '# 초안', { ticket: expired })).json()).error.message, /인제스트/, '무엇을 다시 하면 되는지 말한다')

    // 기회가 사라진 뒤의 자리표(기록을 지운 경우)는 404다.
    const orphan = signDraftTicket({
      secret: TOKEN, tenantId: admin.account.tenantId, opportunityId: 'OPP-GONE', expiresAt: Date.now() + DRAFT_TICKET_TTL_MS,
    })
    const missing = await fetch(`${origin}/api/opportunities/OPP-GONE/draft`, {
      method: 'POST', headers: { authorization: `Bearer ${orphan}`, 'content-type': 'text/markdown' }, body: '# 초안',
    })
    assert.equal(missing.status, 404)
    assert.equal((await missing.json()).error.code, 'OPPORTUNITY_NOT_FOUND')
  })
})

test('인제스트 토큰이 없으면 초안 경로도 함께 닫혀 있다', async () => {
  await withApp('opportunity-draft-off', async (origin) => {
    const response = await fetch(`${origin}/api/opportunities/OPP-1/draft`, {
      method: 'POST', headers: { authorization: 'Bearer whatever', 'content-type': 'text/markdown' }, body: '# 초안',
    })
    assert.equal(response.status, 503)
    assert.equal((await response.json()).error.code, 'INGEST_NOT_CONFIGURED')
  }, {})
})

test('게스트 세션으로는 초안 경로에 닿을 수 없다', async () => {
  await withApp('opportunity-draft-guest', async (origin) => {
    // 게스트 라우트 allowlist에 이 경로를 넣지 않았다는 사실을 게이트가 대신 말한다.
    const { isGuestRouteAllowed } = await import('./guest-access.mjs')
    assert.equal(isGuestRouteAllowed('POST', '/api/opportunities/OPP-1/draft'), false)
    assert.equal(isGuestRouteAllowed('POST', '/api/opportunities/ingest'), false)
  })
})

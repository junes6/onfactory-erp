import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createApp } from './app.mjs'
import { withServer } from './test-server.mjs'

async function login(origin, email) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: 'tenant', email, password: 'demo1234' }),
  })
  assert.equal(response.status, 200)
  const account = (await response.json()).account
  return {
    account,
    headers: {
      cookie: response.headers.get('set-cookie'),
      'x-workspace-identity': `${account.tenantId}:${account.id}`,
      'content-type': 'application/json',
    },
  }
}

const put = (origin, headers, key, data) =>
  fetch(`${origin}/api/workspace/${key}`, { method: 'PUT', headers, body: JSON.stringify({ data }) })

test('an ordinary employee cannot wipe or rewrite other people rows in the industry module lists', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inthefield-member-guard-'))
  try {
    await withServer(createApp({ apiKey: '', workspaceStoreFile: path.join(directory, 'state.json') }), async (origin) => {
      const admin = await login(origin, 'admin@sunsea.co.kr')
      const member = await login(origin, 'taesik.oh@sunsea.co.kr')

      const adminsProject = { id: 'PJ-ADMIN', name: '대표 담당 프로젝트', client: 'A사', status: '진행 중', ownerId: admin.account.id, dueDate: '2026-12-01' }
      const membersProject = { id: 'PJ-MINE', name: '내 프로젝트', client: 'B사', status: '진행 중', ownerId: member.account.id, dueDate: '2026-12-01' }
      assert.equal((await put(origin, admin.headers, 'it-projects', [adminsProject, membersProject])).status, 200)

      // 전체 비우기 시도 → 본인 행만 지워지고 남의 행은 살아남는다.
      // 이전에는 이 요청이 회사 프로젝트 목록을 통째로 없앴다.
      assert.equal((await put(origin, member.headers, 'it-projects', [])).status, 200)
      const afterWipe = await (await fetch(`${origin}/api/workspace/it-projects`, { headers: admin.headers })).json()
      assert.deepEqual(afterWipe.data.map((row) => row.id), ['PJ-ADMIN'], '남의 프로젝트는 지울 수 없다')
      // 다시 채워 놓고 나머지 경로를 본다.
      assert.equal((await put(origin, admin.headers, 'it-projects', [adminsProject, membersProject])).status, 200)

      // 남의 행 수정 → 거부.
      const hijack = await put(origin, member.headers, 'it-projects', [{ ...adminsProject, name: '가로챈 이름' }, membersProject])
      assert.equal(hijack.status, 403)

      // 남의 행을 자기 것으로 바꾸는 것도 거부.
      const steal = await put(origin, member.headers, 'it-projects', [{ ...adminsProject, ownerId: member.account.id }, membersProject])
      assert.equal(steal.status, 403)

      // 남의 이름으로 새 행 등록 → 거부.
      const forge = await put(origin, member.headers, 'it-projects', [adminsProject, membersProject, { id: 'PJ-NEW', name: '남의 이름으로', ownerId: admin.account.id, status: '진행 중' }])
      assert.equal(forge.status, 403)

      // 본인 행 수정 + 본인 행 추가 → 허용, 남의 행은 그대로 남는다.
      const ok = await put(origin, member.headers, 'it-projects', [
        { ...membersProject, name: '내 프로젝트 (수정)' },
        { id: 'PJ-NEW', name: '내가 만든 새 건', ownerId: member.account.id, status: '수주 검토' },
      ])
      assert.equal(ok.status, 200)
      const saved = await (await fetch(`${origin}/api/workspace/it-projects`, { headers: admin.headers })).json()
      const byId = new Map(saved.data.map((row) => [row.id, row]))
      assert.equal(byId.get('PJ-ADMIN').name, '대표 담당 프로젝트', '남의 행은 보존된다')
      assert.equal(byId.get('PJ-MINE').name, '내 프로젝트 (수정)')
      assert.equal(byId.get('PJ-NEW').name, '내가 만든 새 건')
      assert.equal(saved.data.length, 3)

      // 산출물은 createdBy로 소유를 판정한다.
      const deliverable = { id: 'DL-1', projectId: 'PJ-ADMIN', name: '설계서', version: 'v1', attachments: [], note: '', createdBy: admin.account.id, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' }
      assert.equal((await put(origin, admin.headers, 'it-deliverables', [deliverable])).status, 200)
      assert.equal((await put(origin, member.headers, 'it-deliverables', [{ ...deliverable, name: '가로챈 산출물' }])).status, 403)
      assert.equal((await put(origin, member.headers, 'it-deliverables', [])).status, 200)
      const deliverables = await (await fetch(`${origin}/api/workspace/it-deliverables`, { headers: admin.headers })).json()
      assert.deepEqual(deliverables.data.map((row) => row.id), ['DL-1'], '남이 올린 산출물은 지울 수 없다')
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('the briefing history is not readable through the generic workspace route', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inthefield-digest-read-'))
  try {
    await withServer(createApp({ apiKey: '', workspaceStoreFile: path.join(directory, 'state.json') }), async (origin) => {
      const admin = await login(origin, 'admin@sunsea.co.kr')
      const member = await login(origin, 'taesik.oh@sunsea.co.kr')
      // 관리자가 먼저 오늘 브리핑을 만들어 저장시킨다.
      assert.equal((await fetch(`${origin}/api/digest`, { headers: admin.headers })).status, 200)

      // 전용 라우트는 관리자 전용이고, 일반 라우트로도 우회할 수 없다.
      assert.equal((await fetch(`${origin}/api/digest`, { headers: member.headers })).status, 403)
      for (const session of [member, admin]) {
        const bypass = await fetch(`${origin}/api/workspace/digests`, { headers: session.headers })
        assert.equal(bypass.status, 403)
        assert.equal((await bypass.json()).error.code, 'DIGEST_ROUTE_REQUIRED')
      }
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('an oversized payload says so instead of reporting a server error', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inthefield-payload-'))
  try {
    await withServer(createApp({ apiKey: '', workspaceStoreFile: path.join(directory, 'state.json') }), async (origin) => {
      const admin = await login(origin, 'admin@sunsea.co.kr')
      // express.json 한도(4MB)를 넘기는 본문.
      const huge = [{ id: 'P-BIG', name: 'x'.repeat(5 * 1024 * 1024) }]
      const response = await put(origin, admin.headers, 'product-catalog', huge)
      assert.equal(response.status, 413)
      const body = await response.json()
      assert.equal(body.error.code, 'PAYLOAD_TOO_LARGE')
      assert.match(body.error.message, /크기/)
      assert.doesNotMatch(body.error.message, /서버 처리 중 오류/)
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

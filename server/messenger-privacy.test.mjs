import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createApp } from './app.mjs'
import { withServer } from './test-server.mjs'
import {
  DM_PROPOSAL_REDACTED_SUMMARY,
  conversationIdOfDocument,
  privateConversationOfDocument,
  redactDirectMessageProposals,
} from './messenger-privacy.mjs'

const directRoom = { id: 'direct-1', type: 'direct', participantIds: ['A', 'B'], messages: [] }
const teamRoom = { id: 'team-1', type: 'team', participantIds: ['A', 'B', 'C'], messages: [] }

function storeWithLeak() {
  return {
    tenants: {
      T: {
        'messenger-conversations': { data: [directRoom, teamRoom] },
        'ai-proposals': {
          data: [
            { id: 'P-dm-pending', kind: 'task-from-message', status: 'pending', summary: '업무 생성: “병원 서류 보내 주세요”', evidence: '박지현에서 김대표의 지시', payload: { title: '병원 서류 보내 주세요', description: '원문: 내일까지 병원 서류 보내 주세요', conversationId: 'direct-1' } },
            { id: 'P-dm-approved', kind: 'task-from-message', status: 'approved', summary: '업무 생성: “견적서”', evidence: 'x', payload: { title: '견적서', description: '원문: 견적서', conversationId: 'direct-1' }, resultRef: { type: 'work-item', id: 'WK-1' } },
            { id: 'P-team', kind: 'task-from-message', status: 'pending', summary: '업무 생성: “라벨 교체”', evidence: '품질팀', payload: { title: '라벨 교체', description: '원문: 라벨 교체해 주세요', conversationId: 'team-1' } },
            { id: 'P-doc', kind: 'document-classification', status: 'pending', summary: '분류', evidence: '', payload: {} },
          ],
        },
        notifications: {
          data: [
            { id: 'N1', type: 'proposal-pending', title: '업무 생성: “병원 서류 보내 주세요”', body: '박지현에서 김대표의 지시', source: { kind: 'proposal', id: 'P-dm-pending' } },
            { id: 'N2', type: 'proposal-pending', title: '업무 생성: “라벨 교체”', body: '품질팀', source: { kind: 'proposal', id: 'P-team' } },
          ],
        },
      },
    },
  }
}

test('이미 쌓인 1:1 출처 제안과 알림에서 원문을 거두고, 업무 채널 제안은 그대로 둔다 — 두 번 돌려도 같다', () => {
  const store = storeWithLeak()
  const first = redactDirectMessageProposals(store, { now: '2026-09-18T00:00:00.000Z' })
  assert.deepEqual(first, { changed: true, proposals: 2, notifications: 1 })
  const rows = store.tenants.T['ai-proposals'].data
  const pending = rows.find((row) => row.id === 'P-dm-pending')
  assert.equal(pending.status, 'expired', '대기 중이던 1:1 제안은 만료된다')
  assert.equal(pending.summary, DM_PROPOSAL_REDACTED_SUMMARY)
  assert.equal(pending.payload.description, '')
  assert.doesNotMatch(JSON.stringify(pending), /병원/)
  const approved = rows.find((row) => row.id === 'P-dm-approved')
  assert.equal(approved.status, 'approved', '결정된 제안의 결정은 그대로다')
  assert.deepEqual(approved.resultRef, { type: 'work-item', id: 'WK-1' }, '만들어진 업무로 가는 길은 남는다')
  assert.doesNotMatch(JSON.stringify(approved.payload), /원문/)
  assert.equal(rows.find((row) => row.id === 'P-team').summary, '업무 생성: “라벨 교체”', '업무 채널 제안은 건드리지 않는다')
  const notices = store.tenants.T.notifications.data
  assert.equal(notices.find((row) => row.id === 'N1').title, DM_PROPOSAL_REDACTED_SUMMARY)
  assert.equal(notices.find((row) => row.id === 'N1').body, '')
  assert.equal(notices.find((row) => row.id === 'N2').title, '업무 생성: “라벨 교체”')

  const second = redactDirectMessageProposals(store)
  assert.deepEqual(second, { changed: false, proposals: 0, notifications: 0 })
})

test('자료의 대화 태그로 1:1 첨부를 알아본다 — 대화가 지워져도 넓게 열지 않는다', () => {
  assert.equal(conversationIdOfDocument({ tags: ['messenger', 'conversation:direct-1'] }), 'direct-1')
  assert.equal(conversationIdOfDocument({ tags: ['공통'] }), '')
  assert.equal(privateConversationOfDocument({ tags: ['conversation:direct-1'] }, [directRoom, teamRoom]).id, 'direct-1')
  assert.equal(privateConversationOfDocument({ tags: ['conversation:team-1'] }, [directRoom, teamRoom]), null)
  const orphan = privateConversationOfDocument({ tags: ['conversation:gone'] }, [directRoom])
  assert.equal(orphan.missing, true)
  assert.deepEqual(orphan.participantIds, [])
})

async function login(origin, email) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: 'tenant', email, password: 'demo1234' }),
  })
  assert.equal(response.status, 200)
  const account = (await response.json()).account
  return { account, headers: { cookie: response.headers.get('set-cookie').split(';')[0], 'x-workspace-identity': `${account.tenantId}:${account.id}` } }
}

test('관리자라도 남의 1:1에 붙은 파일은 열 수 없다 — 대화 참여자는 연다', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dm-privacy-'))
  try {
    const app = createApp({ apiKey: '', workspaceStoreFile: path.join(directory, 'state.json'), documentUploadDirectory: path.join(directory, 'documents') })
    await withServer(app, async (origin) => {
      const admin = await login(origin, 'admin@sunsea.co.kr')
      const park = await login(origin, 'jihyun.park@sunsea.co.kr')
      const oh = await login(origin, 'taesik.oh@sunsea.co.kr')
      const json = (who) => ({ ...who.headers, 'content-type': 'application/json' })
      const opened = await fetch(`${origin}/api/messenger/conversations/direct`, { method: 'POST', headers: json(park), body: JSON.stringify({ participantId: oh.account.id }) })
      const room = (await opened.json()).conversation

      const query = new URLSearchParams({ name: '진단서.pdf', category: '사내메신저', visibility: 'restricted', tags: `messenger,conversation:${room.id}` })
      const uploaded = await fetch(`${origin}/api/documents?${query}`, {
        method: 'POST',
        headers: { ...park.headers, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('진단서.pdf'), 'x-file-type': 'application/pdf' },
        body: Buffer.from('%PDF-1.4 개인 서류'),
      })
      assert.equal(uploaded.status, 201)
      const document = (await uploaded.json()).document
      const sent = await fetch(`${origin}/api/messenger/conversations/${room.id}/messages`, {
        method: 'POST', headers: json(park), body: JSON.stringify({ text: '서류 보냅니다', attachments: [{ id: document.id, name: document.name, size: '1 KB' }] }),
      })
      assert.equal(sent.status, 201, await sent.clone().text())

      assert.equal((await fetch(`${origin}/api/documents/${document.id}/download`, { headers: oh.headers })).status, 200, '받은 사람은 연다')
      const byAdmin = await fetch(`${origin}/api/documents/${document.id}/download`, { headers: admin.headers })
      assert.ok([403, 404].includes(byAdmin.status), `관리자에게 남의 1:1 첨부가 열렸다 (${byAdmin.status})`)
      const listed = (await (await fetch(`${origin}/api/documents`, { headers: admin.headers })).json()).documents
      assert.ok(!listed.some((item) => item.id === document.id), '관리자 자료실 목록에도 없다')

      // 관리자 일반 조회에는 남의 1:1이 없다.
      const rooms = (await (await fetch(`${origin}/api/workspace/messenger-conversations`, { headers: admin.headers })).json()).data
      assert.ok(!rooms.some((item) => item.id === room.id))
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

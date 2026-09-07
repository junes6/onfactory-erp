import assert from 'node:assert/strict'
import test from 'node:test'

import {
  attachBlocksToLatestUserMessage,
  ChatAttachmentError,
  normalizeChatAttachmentRequest,
  resolveChatAttachments,
} from './chat-attachments.mjs'

test('chat attachments validate ids, permissions and hydrate text content', async () => {
  const storage = { get: async () => Buffer.from('LOT 2026-08 report') }
  const account = { id: 'USR-1', tenantId: 'TENANT-1', role: 'tenant-admin' }
  const source = { id: 'DOC-20260820-A', name: '검사결과.txt', mime: 'text/plain', size: 20, tenantId: 'TENANT-1' }
  const resolved = await resolveChatAttachments({
    requested: [{ documentId: source.id }],
    documents: [source],
    account,
    canReadDocument: () => true,
    canUseForAi: () => true,
    storage,
  })
  assert.equal(resolved.documents[0].id, source.id)
  assert.match(resolved.blocks[0].text, /LOT 2026-08 report/)
  const messages = attachBlocksToLatestUserMessage([{ role: 'user', content: '검토해줘' }], resolved.blocks)
  assert.equal(messages[0].content.length, 2)
})

test('chat attachments never allow duplicate or unauthorized document ids', async () => {
  assert.throws(
    () => normalizeChatAttachmentRequest([{ documentId: 'DOC-ABCD' }, { documentId: 'DOC-ABCD' }]),
    ChatAttachmentError,
  )
  await assert.rejects(
    resolveChatAttachments({
      requested: [{ documentId: 'DOC-ABCD' }],
      documents: [{ id: 'DOC-ABCD' }],
      account: { tenantId: 'TENANT-1' },
      canReadDocument: () => false,
      canUseForAi: () => true,
      storage: { get: async () => Buffer.alloc(0) },
    }),
    { code: 'CHAT_ATTACHMENT_FORBIDDEN' },
  )
})

test('the AI level gate is a required argument and answers apart from the read permission', async () => {
  const base = {
    requested: [{ documentId: 'DOC-ABCD' }],
    documents: [{ id: 'DOC-ABCD', name: '계약서.txt', mime: 'text/plain', size: 10, tenantId: 'TENANT-1' }],
    account: { id: 'USR-1', tenantId: 'TENANT-1', role: 'tenant-member' },
    canReadDocument: () => true,
    storage: { get: async () => Buffer.from('본문') },
  }
  // 기본값 () => true 를 두면 주입을 잊은 호출부가 조용히 열린다 — 그 자리는 어떤 테스트도 잡지 못한다.
  await assert.rejects(resolveChatAttachments(base), TypeError)
  // 볼 수는 있지만 AI가 열 수 없는 자료다. '권한 없음'과 갈라 답해야 화면이 옳은 문장을 고른다.
  await assert.rejects(
    resolveChatAttachments({ ...base, canUseForAi: () => false }),
    (error) => error.code === 'CHAT_ATTACHMENT_AI_LOCKED' && error.status === 403,
  )
})


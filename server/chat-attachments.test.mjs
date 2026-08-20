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
      storage: { get: async () => Buffer.alloc(0) },
    }),
    { code: 'CHAT_ATTACHMENT_FORBIDDEN' },
  )
})


import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createApp } from './app.mjs'
import { withServer } from './test-server.mjs'

async function login(origin, email) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'demo1234' }),
  })
  assert.equal(response.status, 200)
  return response.headers.get('set-cookie').split(';')[0]
}

test('AI chat reads only the explicitly selected, authorized stored document', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'onfactory-chat-doc-'))
  const storeFile = path.join(directory, 'workspace-state.json')
  let capturedMessages
  const client = {
    messages: {
      create: async ({ messages }) => {
        capturedMessages = messages
        return { model: 'claude-test', content: [{ type: 'text', text: '첨부 내용을 확인했습니다.' }], usage: {} }
      },
    },
  }
  try {
    await withServer(createApp({ apiKey: 'test-key', client, workspaceStoreFile: storeFile }), async (origin) => {
      const adminCookie = await login(origin, 'admin@sunsea.co.kr')
      const upload = await fetch(`${origin}/api/documents?name=${encodeURIComponent('검사 메모.txt')}&visibility=restricted`, {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          'content-type': 'application/octet-stream',
          'x-file-type': 'text/plain',
          'x-file-name': encodeURIComponent('검사 메모.txt'),
        },
        body: Buffer.from('냉동창고 온도는 영하 18도이며 이상 없음'),
      })
      assert.equal(upload.status, 201)
      const documentId = (await upload.json()).document.id

      const chat = await fetch(`${origin}/api/chat`, {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: '첨부를 요약해줘' }],
          attachments: [{ documentId }],
        }),
      })
      assert.equal(chat.status, 200)
      const result = await chat.json()
      assert.equal(result.attachmentMode, 'content')
      assert.equal(result.attachmentsProcessed, 1)
      assert.equal(Array.isArray(capturedMessages.at(-1).content), true)
      assert.match(JSON.stringify(capturedMessages.at(-1).content), /냉동창고 온도/)

      const otherTenantCookie = await login(origin, 'admin@pohangcoop.co.kr')
      const forbidden = await fetch(`${origin}/api/chat`, {
        method: 'POST',
        headers: { cookie: otherTenantCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: '첨부를 읽어줘' }], attachments: [{ documentId }] }),
      })
      assert.equal(forbidden.status, 403)
      assert.equal((await forbidden.json()).error.code, 'CHAT_ATTACHMENT_FORBIDDEN')
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

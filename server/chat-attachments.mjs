import { tenantStorageKey } from './storage/index.mjs'

const MAX_CHAT_ATTACHMENTS = 5
const MAX_CHAT_ATTACHMENT_BYTES = 10 * 1024 * 1024
const MAX_TEXT_ATTACHMENT_CHARS = 80_000
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

export class ChatAttachmentError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'ChatAttachmentError'
    this.code = code
    this.status = status
  }
}

export function normalizeChatAttachmentRequest(value) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_CHAT_ATTACHMENTS) {
    throw new ChatAttachmentError('INVALID_CHAT_ATTACHMENTS', `첨부파일은 최대 ${MAX_CHAT_ATTACHMENTS}개까지 선택할 수 있습니다.`)
  }
  const result = []
  const seen = new Set()
  for (const entry of value) {
    const documentId = String(entry?.documentId ?? entry?.id ?? '').trim()
    if (!/^DOC-[A-Za-z0-9_-]{4,160}$/.test(documentId) || seen.has(documentId)) {
      throw new ChatAttachmentError('INVALID_CHAT_ATTACHMENTS', '첨부파일 식별자를 확인해 주세요.')
    }
    seen.add(documentId)
    result.push({ documentId })
  }
  return result
}

export async function resolveChatAttachments({
  requested,
  documents,
  account,
  canReadDocument,
  storage,
}) {
  const normalized = normalizeChatAttachmentRequest(requested)
  if (!normalized.length) return { documents: [], blocks: [], contentDocuments: 0 }
  if (!account?.tenantId || !storage) {
    throw new ChatAttachmentError('CHAT_ATTACHMENT_STORAGE_UNAVAILABLE', '첨부파일 저장소를 사용할 수 없습니다.', 503)
  }
  const byId = new Map((Array.isArray(documents) ? documents : []).map((document) => [document.id, document]))
  const selected = normalized.map(({ documentId }) => {
    const document = byId.get(documentId)
    if (!document || !canReadDocument(document, account)) {
      throw new ChatAttachmentError('CHAT_ATTACHMENT_FORBIDDEN', '첨부파일을 찾을 수 없거나 열람 권한이 없습니다.', 403)
    }
    return document
  })
  const total = selected.reduce((sum, document) => sum + Number(document.size || 0), 0)
  if (total > MAX_CHAT_ATTACHMENT_BYTES) {
    throw new ChatAttachmentError('CHAT_ATTACHMENT_TOO_LARGE', 'AI 채팅 첨부파일 전체 크기는 10MB 이하여야 합니다.', 413)
  }

  const blocks = []
  let contentDocuments = 0
  for (const document of selected) {
    const key = document.storageKey || tenantStorageKey(account.tenantId, document.id)
    let contents
    try {
      contents = await storage.get(key)
    } catch (error) {
      if (error?.code === 'STORAGE_NOT_FOUND') {
        throw new ChatAttachmentError('CHAT_ATTACHMENT_MISSING', `${document.name || document.originalName} 원본을 찾을 수 없습니다.`, 410)
      }
      throw error
    }
    const mime = String(document.mime || 'application/octet-stream').toLowerCase()
    if (IMAGE_MIME_TYPES.has(mime)) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: mime, data: contents.toString('base64') } })
      contentDocuments += 1
    } else if (mime === 'application/pdf') {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: mime, data: contents.toString('base64') }, title: String(document.name || document.originalName || 'PDF').slice(0, 120) })
      contentDocuments += 1
    } else if (mime.startsWith('text/') || ['application/json', 'application/xml', 'text/csv'].includes(mime)) {
      const text = contents.toString('utf8').slice(0, MAX_TEXT_ATTACHMENT_CHARS)
      blocks.push({ type: 'text', text: `<attachment name="${String(document.name || document.originalName || 'text').replaceAll('"', '&quot;')}">\n${text}\n</attachment>` })
      contentDocuments += 1
    } else {
      blocks.push({ type: 'text', text: `첨부파일 메타데이터: ${document.name || document.originalName} · ${mime} · ${document.size || contents.length} bytes. 이 형식의 본문 분석은 지원하지 않는다.` })
    }
  }
  return {
    documents: selected.map(({ id, name, originalName, mime, size, category, tags, summary }) => ({ id, name, originalName, mime, size, category, tags, summary })),
    blocks,
    contentDocuments,
  }
}

export function attachBlocksToLatestUserMessage(messages, blocks) {
  if (!blocks.length) return messages
  const targetIndex = messages.findLastIndex((message) => message.role === 'user')
  if (targetIndex < 0) return messages
  return messages.map((message, index) => index === targetIndex
    ? { ...message, content: [{ type: 'text', text: message.content }, ...blocks] }
    : message)
}

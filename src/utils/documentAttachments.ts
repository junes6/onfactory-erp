export type StoredDocumentAttachment = {
  id: string
  name: string
  size: string
}

type UploadAttachmentOptions = {
  workspaceScope?: string
  category: string
  summary?: string
  tags?: string[]
  allowedUserIds?: string[]
}

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024

function workspaceHeaders(workspaceScope?: string): Record<string, string> {
  return workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}
}

async function responseError(response: Response, fallback: string) {
  try {
    const body = await response.json() as { error?: { message?: string } }
    return body.error?.message || fallback
  } catch {
    return fallback
  }
}

export function isStoredDocumentAttachment(attachment: Pick<StoredDocumentAttachment, 'id'>) {
  return attachment.id.startsWith('DOC-')
}

export function formatDocumentSize(size: number) {
  return size < 1024 * 1024
    ? `${Math.max(1, Math.round(size / 1024))} KB`
    : `${(size / 1024 / 1024).toFixed(1)} MB`
}

export async function uploadDocumentAttachment(file: File, options: UploadAttachmentOptions): Promise<StoredDocumentAttachment> {
  if (!file.size) throw new Error(`${file.name}: 비어 있는 파일은 업로드할 수 없습니다.`)
  if (file.size > MAX_DOCUMENT_BYTES) throw new Error(`${file.name}: 파일은 10MB 이하만 첨부할 수 있습니다.`)

  const params = new URLSearchParams({
    name: file.name,
    category: options.category,
    visibility: 'restricted',
    summary: options.summary ?? '',
    tags: (options.tags ?? []).join(','),
    ...(options.allowedUserIds?.length ? { allowedUserIds: [...new Set(options.allowedUserIds)].join(',') } : {}),
  })
  const response = await fetch(`/api/documents?${params}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-file-type': file.type || 'application/octet-stream',
      'x-file-name': encodeURIComponent(file.name),
      ...workspaceHeaders(options.workspaceScope),
    },
    body: file,
  })
  if (!response.ok) throw new Error(await responseError(response, `${file.name} 파일을 저장하지 못했습니다.`))
  const body = await response.json() as { document?: { id?: string; name?: string; size?: number } }
  if (!body.document?.id?.startsWith('DOC-')) throw new Error(`${file.name} 파일 저장 응답이 올바르지 않습니다.`)
  return {
    id: body.document.id,
    name: body.document.name || file.name,
    size: formatDocumentSize(body.document.size ?? file.size),
  }
}

export async function deleteDocumentAttachment(id: string, workspaceScope?: string) {
  const response = await fetch(`/api/documents/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: workspaceHeaders(workspaceScope),
  })
  if (!response.ok) throw new Error(await responseError(response, '첨부파일을 삭제하지 못했습니다.'))
}

export async function deleteDocumentAttachments(ids: Iterable<string>, workspaceScope?: string) {
  const uniqueIds = [...new Set(ids)].filter((id) => id.startsWith('DOC-'))
  const results = await Promise.all(uniqueIds.map(async (id) => {
    try {
      await deleteDocumentAttachment(id, workspaceScope)
      return { id, ok: true as const }
    } catch (error) {
      return { id, ok: false as const, message: error instanceof Error ? error.message : '첨부파일을 삭제하지 못했습니다.' }
    }
  }))
  return {
    deleted: results.filter((result) => result.ok).map((result) => result.id),
    failed: results.filter((result) => !result.ok).map((result) => ({ id: result.id, message: result.message })),
  }
}

export async function uploadDocumentAttachments(files: File[], options: UploadAttachmentOptions) {
  const uploaded: StoredDocumentAttachment[] = []
  try {
    for (const file of files) uploaded.push(await uploadDocumentAttachment(file, options))
    return uploaded
  } catch (error) {
    const rollback = await deleteDocumentAttachments(uploaded.map((attachment) => attachment.id), options.workspaceScope)
    const reason = error instanceof Error ? error.message : '첨부파일을 업로드하지 못했습니다.'
    if (rollback.failed.length) throw new Error(`${reason} 업로드 롤백 중 ${rollback.failed.length}개 파일을 정리하지 못했습니다. 다시 시도해 주세요.`)
    throw new Error(`${reason} 이번에 선택한 파일은 모두 롤백했습니다.`)
  }
}

export async function downloadDocumentAttachment(attachment: StoredDocumentAttachment, workspaceScope?: string) {
  if (!isStoredDocumentAttachment(attachment)) throw new Error('이전 버전에서 파일 정보만 등록된 자료라 원본을 내려받을 수 없습니다.')
  const response = await fetch(`/api/documents/${encodeURIComponent(attachment.id)}/download`, {
    headers: workspaceHeaders(workspaceScope),
  })
  if (!response.ok) throw new Error(await responseError(response, `${attachment.name} 파일을 내려받지 못했습니다.`))
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = attachment.name
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}

import type { ToastMessage } from '../components/ui/Toast'

/**
 * 대장에서 지운 기록(30일). 서버 server/deleted-rows.mjs와 짝이다 — generic 저장이 뺀 행을 커밋 전에 보관하고,
 * 여기서 목록을 읽고 되살린다. 되살리면 휴지통에 간 첨부도 함께 돌아온다.
 */
/** 지운 행이 보관된 뒤(저장이 끝난 뒤) 알리는 신호. [지운 항목] 단추가 듣고 다시 센다. */
export const DELETED_ROWS_EVENT = 'itf:deleted-rows'

export type DeletedRow = {
  id: string
  key: string
  rowId: string
  label: string
  deletedAt: string
  deletedByName: string
  purgeAt: string
}

const headers = (workspaceScope?: string): Record<string, string> => ({
  'content-type': 'application/json',
  ...(workspaceScope ? { 'x-workspace-identity': workspaceScope } : {}),
})

async function readBody<T>(response: Response, fallback: string): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: { message?: string } }
  if (!response.ok) throw new Error(body.error?.message || fallback)
  return body
}

export async function listDeletedRows(key: string, workspaceScope?: string) {
  const response = await fetch(`/api/deleted-rows?key=${encodeURIComponent(key)}`, { headers: headers(workspaceScope) })
  return readBody<{ items: DeletedRow[]; days: number }>(response, '지운 기록을 읽지 못했습니다.')
}

export async function restoreDeletedRow(id: string, workspaceScope?: string) {
  const response = await fetch(`/api/deleted-rows/${encodeURIComponent(id)}/restore`, { method: 'POST', headers: headers(workspaceScope), body: '{}' })
  return readBody<{ label: string; restoredFiles: number }>(response, '되살리지 못했습니다.')
}

export async function restoreLatestDeletedRow(key: string, rowId: string, workspaceScope?: string) {
  const response = await fetch('/api/deleted-rows/restore-latest', { method: 'POST', headers: headers(workspaceScope), body: JSON.stringify({ key, rowId }) })
  return readBody<{ label: string; restoredFiles: number }>(response, '되살리지 못했습니다.')
}

/**
 * 지운 뒤 알림 한 줄 — 묻지 않고 지우고, [되돌리기]를 단다. 되살릴 수 있는 일은 묻지 않는다(자료실 휴지통과 같은 원칙).
 * `onRestored`는 목록을 다시 읽게 한다(부르는 쪽의 reloadToken).
 */
export function deletedToast({ text, storeKey, rowId, workspaceScope, onRestored, onToast }: {
  text: string
  storeKey: string
  rowId: string
  workspaceScope?: string
  onRestored: () => void
  onToast: (message: string | ToastMessage) => void
}): ToastMessage {
  // 이 알림은 저장이 끝난 뒤에 만들어진다 — 그때에야 보관함에 행이 있다. 화면의 목록이 줄어든 순간(저장 전)에 세면 0이다.
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(DELETED_ROWS_EVENT, { detail: { key: storeKey } }))
  return {
    text: `${text} 30일 동안 [지운 항목]에서 되살릴 수 있습니다.`,
    undo: {
      label: '되돌리기',
      run: async () => {
        try {
          const restored = await restoreLatestDeletedRow(storeKey, rowId, workspaceScope)
          onRestored()
          onToast(`‘${restored.label}’을(를) 되살렸습니다.${restored.restoredFiles ? ` 첨부 ${restored.restoredFiles}개도 함께 돌아왔습니다.` : ''}`)
        } catch (error) { onToast(error instanceof Error ? error.message : '되살리지 못했습니다.') }
      },
    },
  }
}

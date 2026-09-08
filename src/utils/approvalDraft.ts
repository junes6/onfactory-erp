/**
 * 「이어서 작성」의 저장 순서 — 화면에서 떼어 낸 순수한 절차.
 *
 * 왜 떼어냈는가: 이 절차는 **두 요청에 걸친 상태**(version)를 다루는데, 그것을 대화상자 안에
 * 두면 프롭 스냅샷(`draft.version`)을 계속 다시 쓰는 실수가 눈에 띄지 않는다. 실제로 그렇게
 * 됐다 — PATCH 는 성공해 서버 version 이 1→2 가 되는데 다음 요청이 다시 1을 보내, 사람이
 * 지적받은 칸을 채우고 「상신」을 누를 때마다 「다른 곳에서 먼저 저장되었습니다」가 떴다.
 * 아무도 먼저 저장하지 않았는데 그렇게 말하는 거짓 문장이고(규칙 3), 대화상자 안에는 빠져나갈
 * 길이 없었다(규칙 5).
 *
 * 그래서 이 함수는 **언제나 지금 아는 가장 새 version 을 함께 돌려준다** — 실패했을 때도.
 * 부르는 쪽은 그 값을 그대로 들고 다음 시도를 하면 되고, 그것이 이 절차의 전부다.
 */

export type ApprovalDraftResponse = {
  ok: boolean
  body: {
    document?: { version?: number } | null
    error?: { message?: string; currentVersion?: number | null } | null
  }
}

/** HTTP 한 번. 화면은 fetch 로, 시험은 가짜 서버로 채운다. */
export type ApprovalDraftCall = (
  method: 'PATCH' | 'POST',
  path: string,
  body: unknown,
) => Promise<ApprovalDraftResponse>

export type ApprovalDraftOutcome =
  | { ok: true; version: number; submitted: boolean }
  | { ok: false; version: number; message: string }

const PATCH_FAILED = '결재 내용을 저장하지 못했습니다.'
const SUBMIT_FAILED = '결재를 상신하지 못했습니다.'

/**
 * 서버가 409 와 함께 알려 준 지금 version 을 받아 적는다. 없으면 들고 있던 값을 그대로 둔다 —
 * 짐작으로 +1 하면 다음 시도가 또 어긋나고, 그때는 이유를 아무도 모른다.
 */
function versionFrom(response: ApprovalDraftResponse, fallback: number): number {
  const saved = response.body?.document?.version
  if (Number.isInteger(saved)) return Number(saved)
  const current = response.body?.error?.currentVersion
  if (Number.isInteger(current)) return Number(current)
  return fallback
}

/**
 * 이미 있는 기안을 저장하고, `submit` 이면 이어서 상신한다.
 *
 * 상신이 거절돼도(필수 항목이 비었다 등) 그 앞의 PATCH 는 이미 확정됐다. 그 사실을 version 으로
 * 돌려주지 않으면 같은 대화상자에서 다시 저장할 길이 없다.
 */
export async function saveApprovalDraft({ id, version, payload, submit, call }: {
  id: string
  version: number
  payload: Record<string, unknown>
  submit: boolean
  call: ApprovalDraftCall
}): Promise<ApprovalDraftOutcome> {
  const path = `/api/approval-documents/${encodeURIComponent(id)}`
  const patched = await call('PATCH', path, { ...payload, version })
  const afterPatch = versionFrom(patched, version)
  if (!patched.ok || !patched.body?.document) {
    return { ok: false, version: afterPatch, message: patched.body?.error?.message || PATCH_FAILED }
  }
  if (!submit) return { ok: true, version: afterPatch, submitted: false }

  const sent = await call('POST', `${path}/submit`, { version: afterPatch })
  if (!sent.ok) {
    return { ok: false, version: versionFrom(sent, afterPatch), message: sent.body?.error?.message || SUBMIT_FAILED }
  }
  return { ok: true, version: versionFrom(sent, afterPatch), submitted: true }
}

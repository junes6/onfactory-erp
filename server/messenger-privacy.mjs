/**
 * 1:1 대화(DM)의 사생활 — 가입 동의가 약속한 한 줄을 코드로 지킨다.
 *
 *   「1:1 개인 DM은 열람 대상이 아닙니다」 (server/policies/consent-terms.mjs)
 *   「1:1 개인 DM은 절대 열지 않는다… 기록되지 않는 열람은 없다」 (server/oversight-routes.mjs)
 *
 * 2026-09-18 감사에서 이 약속이 세 군데로 새고 있었다.
 *   1) 일반 조회(GET /api/workspace/messenger-conversations)가 회사 관리자에게는 전 직원의 DM 원문을 통째로 줬다
 *      (화면은 자기 방만 그렸지만 브라우저 저장소에는 통째로 캐시됐다).
 *   2) DM의 "지시 문형"이 원문과 함께 관리자 승인 큐·관리자 알림으로 올라갔다.
 *   3) DM에 붙인 파일을 관리자가 자료실에서 열 수 있었다.
 * 이 파일은 그 셋을 막는 판정과, 이미 새어 나가 쌓인 원문을 거두는 정리를 담는다.
 * 판정만 담는다 — 저장·HTTP는 app.mjs가 한다.
 */

export const DM_PROPOSAL_REDACTED_SUMMARY = '1:1 대화에서 감지된 지시 — 원문은 대화 참여자만 볼 수 있습니다'
export const DM_PROPOSAL_REDACTED_EVIDENCE = '1:1 대화의 원문은 관리자 승인 큐에 올리지 않습니다(가입 동의 약속). 이 제안은 만료 처리했습니다.'

/** 자료의 `conversation:<id>` 태그. 메신저 화면이 첨부를 올릴 때 단다(CollaborationSuite). */
export function conversationIdOfDocument(document) {
  const tag = (Array.isArray(document?.tags) ? document.tags : []).find((value) => typeof value === 'string' && value.startsWith('conversation:'))
  return tag ? tag.slice('conversation:'.length) : ''
}

export function directConversationIdsOf(conversations) {
  return new Set((Array.isArray(conversations) ? conversations : [])
    .filter((conversation) => conversation?.type === 'direct' && conversation?.id)
    .map((conversation) => conversation.id))
}

/**
 * 이 자료가 **1:1 대화에 붙은 파일**인가. 그렇다면 그 대화를 돌려준다(참여자 판정은 부르는 쪽이 한다).
 * 대화가 지워져 찾을 수 없어도 태그가 DM을 가리켰다면 여전히 DM 첨부다 — 모르는 쪽을 열린 쪽으로 두지 않는다.
 */
export function privateConversationOfDocument(document, conversations) {
  const id = conversationIdOfDocument(document)
  if (!id) return null
  const conversation = (Array.isArray(conversations) ? conversations : []).find((item) => item?.id === id)
  if (conversation) return conversation.type === 'direct' ? conversation : null
  // 대화 기록이 사라진 첨부: 팀 채널이었는지 DM이었는지 알 수 없다. 참여자 목록도 없으므로 아무도 넓게 열지 않는다.
  return { id, type: 'direct', participantIds: [], missing: true }
}

/**
 * 이미 쌓인 DM 출처 제안과 그 알림에서 원문을 거둔다. 같은 저장소에 두 번 돌려도 결과가 같다.
 * - 제안: 제목·근거·설명의 원문을 지우고, 대기 중이면 만료 처리한다(결정된 것은 결정 기록만 남긴다).
 * - 알림: 그 제안을 가리키는 알림의 제목·본문을 같은 문장으로 바꾼다.
 * 만들어진 업무는 건드리지 않는다 — 관리자가 승인해 만든 업무는 담당자·요청자(곧 대화 참여자)의 것이다.
 * @returns {{ changed: boolean, proposals: number, notifications: number }}
 */
export function redactDirectMessageProposals(workspaceStore, { now = new Date().toISOString() } = {}) {
  let proposals = 0
  let notifications = 0
  for (const tenantStore of Object.values(workspaceStore?.tenants ?? {})) {
    const conversations = Array.isArray(tenantStore?.['messenger-conversations']?.data) ? tenantStore['messenger-conversations'].data : []
    const directIds = directConversationIdsOf(conversations)
    const rows = Array.isArray(tenantStore?.['ai-proposals']?.data) ? tenantStore['ai-proposals'].data : null
    if (!rows) continue
    const redactedIds = new Set()
    let redactedHere = 0
    const next = rows.map((proposal) => {
      if (proposal?.kind !== 'task-from-message') return proposal
      const conversationId = proposal?.payload?.conversationId
      if (!conversationId || !directIds.has(conversationId)) return proposal
      if (proposal.redactedAt) { redactedIds.add(proposal.id); return proposal }
      redactedIds.add(proposal.id)
      proposals += 1
      redactedHere += 1
      return {
        ...proposal,
        status: proposal.status === 'pending' ? 'expired' : proposal.status,
        summary: DM_PROPOSAL_REDACTED_SUMMARY,
        evidence: DM_PROPOSAL_REDACTED_EVIDENCE,
        payload: { ...proposal.payload, title: '1:1 대화에서 감지된 지시', description: '' },
        redactedAt: now,
        ...(proposal.status === 'pending' ? { expiredReason: 'dm-privacy' } : {}),
      }
    })
    if (redactedHere) tenantStore['ai-proposals'] = { ...tenantStore['ai-proposals'], data: next }
    const notices = Array.isArray(tenantStore?.notifications?.data) ? tenantStore.notifications.data : null
    if (!notices || !redactedIds.size) continue
    tenantStore.notifications = {
      ...tenantStore.notifications,
      data: notices.map((row) => {
        if (row?.source?.kind !== 'proposal' || !redactedIds.has(row?.source?.id)) return row
        if (row.title === DM_PROPOSAL_REDACTED_SUMMARY) return row
        notifications += 1
        return { ...row, title: DM_PROPOSAL_REDACTED_SUMMARY, body: '' }
      }),
    }
  }
  return { changed: proposals + notifications > 0, proposals, notifications }
}

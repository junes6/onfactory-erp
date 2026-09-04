/**
 * 감독 열람 — 회사 관리자와 지정된 열람 권한자가 업무 대화를 확인하는 통로.
 *
 * 세 가지가 이 모듈의 전부다.
 *
 * 1. **1:1 개인 DM은 절대 열지 않는다.** 목록에도 넣지 않고, 방 id를 직접 넣어도 거절한다.
 *    "권한이 있으니 다 볼 수 있다"가 되는 순간 이 기능은 감독이 아니라 감시가 된다.
 * 2. **모든 열람은 기록한다.** 열람자·대상 방·시각. 기록되지 않는 열람은 없다.
 *    권한을 주고 거두는 일 자체도 같은 기록에 남는다.
 * 3. **열람해도 참여자에게 알림은 가지 않는다.** 대신 그 사실을 가입 동의 항목으로
 *    공개한다(policies/consent-terms.mjs의 channelOversight). 알림이 없을수록
 *    정책은 더 크게 공개돼야 한다.
 *
 * 3단 권한과 테넌트 격리는 건드리지 않는다. 열람 권한은 역할이 아니라 계정에 붙는
 * 별도의 표시이고, 조회 범위는 언제나 자기 테넌트 안이다.
 */

const CONVERSATIONS_KEY = 'messenger-conversations'

/** 열람할 수 있는 방인가. 업무용 채널과 그룹방만이다. */
export const isOverseeable = (conversation) =>
  conversation?.type === 'team' && conversation?.systemChannel !== 'developer-support'

/** 이 계정이 감독 열람을 할 수 있는가. 관리자이거나, 관리자가 지정한 사람이다. */
export const canOversee = (account) =>
  account?.role === 'tenant-admin' || account?.oversight === true

const summarize = (conversation) => ({
  id: conversation.id,
  name: conversation.name,
  kind: conversation.kind ?? 'channel',
  icon: conversation.icon ?? '',
  participantCount: Array.isArray(conversation.participantIds) ? conversation.participantIds.length : 0,
  messageCount: Array.isArray(conversation.messages) ? conversation.messages.length : 0,
  lastMessage: conversation.lastMessage ?? '',
  lastTime: conversation.lastTime ?? '',
})

export function registerOversightRoutes({
  app,
  requireAuth,
  requireTenantAdmin,
  requireMatchingWorkspaceIdentity,
  workspaceStore,
  accounts,
  commitWorkspaceStore,
  appendPlatformAudit,
  persistAccountProfile,
  clock = () => new Date(),
}) {
  const conversationsOf = (tenantId) => {
    const record = workspaceStore.tenants[tenantId]?.[CONVERSATIONS_KEY]
    return Array.isArray(record?.data) ? record.data : []
  }

  /** 열람 권한이 있어야 지나간다. 없으면 이 기능이 있다는 사실도 알리지 않는다. */
  const requireOversight = (request, response, next) => {
    if (!canOversee(request.auth)) {
      response.status(403).json({ error: { code: 'OVERSIGHT_FORBIDDEN', message: '대화 열람 권한이 없습니다.' } })
      return
    }
    next()
  }

  const guards = [requireAuth, requireMatchingWorkspaceIdentity, requireOversight]

  // ── 열람 가능한 방 목록 ──────────────────────────────────────────
  app.get('/api/oversight/rooms', ...guards, (request, response) => {
    const rooms = conversationsOf(request.auth.tenantId)
      .filter((conversation) => isOverseeable(conversation) && (conversation.lifecycle ?? 'active') === 'active')
      .map(summarize)
      .sort((left, right) => right.messageCount - left.messageCount)
    // 몇 개가 목록에서 빠졌는지는 알려 준다. "안 보이는 것이 있다"는 사실 자체는 숨기지 않는다.
    const excluded = conversationsOf(request.auth.tenantId).filter((conversation) => conversation?.type === 'direct').length
    response.json({ rooms, excludedDirectCount: excluded, policy: '1:1 개인 대화는 열람 대상이 아닙니다.' })
  })

  // ── 방 하나 열람 (기록을 남긴다) ─────────────────────────────────
  app.get('/api/oversight/rooms/:id', ...guards, async (request, response) => {
    const conversation = conversationsOf(request.auth.tenantId).find((item) => item?.id === request.params.id)
    if (!conversation) {
      response.status(404).json({ error: { code: 'ROOM_NOT_FOUND', message: '대화방을 찾을 수 없습니다.' } })
      return
    }
    if (!isOverseeable(conversation)) {
      response.status(403).json({ error: { code: 'DIRECT_NOT_OVERSEEABLE', message: '1:1 개인 대화는 열람할 수 없습니다.' } })
      return
    }
    const limit = Math.min(Math.max(Number.parseInt(String(request.query?.limit ?? ''), 10) || 200, 1), 1_000)
    const messages = conversation.messages.slice(-limit)

    const audit = appendPlatformAudit(workspaceStore.platform, {
      tenantId: request.auth.tenantId,
      event: '대화 감독 열람',
      scope: `${conversation.name} · 메시지 ${messages.length}건`,
      actor: request.auth.name,
      reference: conversation.id,
    })
    // 기록을 저장하지 못하면 내용을 보여 주지 않는다. 기록 없는 열람을 만들지 않기 위해서다.
    try {
      await commitWorkspaceStore()
    } catch {
      workspaceStore.platform.auditEvents = workspaceStore.platform.auditEvents.filter((item) => item.id !== audit.id)
      response.status(503).json({ error: { code: 'OVERSIGHT_AUDIT_FAILED', message: '열람 기록을 남기지 못해 내용을 열지 않았습니다. 잠시 후 다시 시도해 주세요.' } })
      return
    }

    response.json({
      room: summarize(conversation),
      messages,
      participants: (conversation.participantIds ?? []).map((id) => {
        const account = accounts.find((candidate) => candidate.id === id && candidate.tenantId === request.auth.tenantId)
        return { id, name: account?.name ?? id, team: account?.team ?? '', active: account?.approvalStatus !== 'inactive' }
      }),
      auditId: audit.id,
      notice: '이 열람은 기록되었습니다. 대화 참여자에게 개별 알림은 가지 않습니다.',
    })
  })

  // ── 열람 기록 조회 (회사 관리자) ─────────────────────────────────
  app.get('/api/oversight/audit', requireAuth, requireTenantAdmin, requireMatchingWorkspaceIdentity, (request, response) => {
    const limit = Math.min(Math.max(Number.parseInt(String(request.query?.limit ?? ''), 10) || 100, 1), 500)
    // 자기 회사 기록만 본다. 플랫폼 감사 기록 전체가 아니라 tenantId로 거른 것이다.
    const events = (workspaceStore.platform.auditEvents ?? [])
      .filter((item) => item?.tenantId === request.auth.tenantId
        && ['대화 감독 열람', '대화 열람 권한 부여', '대화 열람 권한 회수'].includes(item.event))
      .slice(0, limit)
    response.json({ events, total: events.length })
  })

  // ── 열람 권한 부여·회수 (회사 관리자) ────────────────────────────
  app.post('/api/admin/accounts/:id/oversight', requireAuth, requireTenantAdmin, requireMatchingWorkspaceIdentity, async (request, response) => {
    const granted = request.body?.granted === true
    const account = accounts.find((candidate) => candidate.id === request.params.id && candidate.tenantId === request.auth.tenantId)
    if (!account) {
      response.status(404).json({ error: { code: 'ACCOUNT_NOT_FOUND', message: '대상 계정을 찾을 수 없습니다.' } })
      return
    }
    if (account.role === 'tenant-admin') {
      response.status(409).json({ error: { code: 'ADMIN_ALWAYS_OVERSEES', message: '회사 관리자는 별도 지정 없이 열람할 수 있습니다.' } })
      return
    }
    const previousFlag = account.oversight === true
    const previousAudits = workspaceStore.platform.auditEvents
    const previousAccounts = Array.isArray(workspaceStore.accounts) ? [...workspaceStore.accounts] : undefined

    account.oversight = granted
    persistAccountProfile(account)
    appendPlatformAudit(workspaceStore.platform, {
      tenantId: request.auth.tenantId,
      event: granted ? '대화 열람 권한 부여' : '대화 열람 권한 회수',
      scope: `${account.name} (${account.email})`,
      actor: request.auth.name,
      reference: account.id,
    })
    try {
      await commitWorkspaceStore()
    } catch {
      account.oversight = previousFlag
      workspaceStore.platform.auditEvents = previousAudits
      if (previousAccounts) workspaceStore.accounts = previousAccounts
      response.status(500).json({ error: { code: 'OVERSIGHT_GRANT_FAILED', message: '열람 권한을 저장하지 못했습니다.' } })
      return
    }
    response.json({ account: { id: account.id, name: account.name, oversight: granted }, at: clock().toISOString() })
  })
}

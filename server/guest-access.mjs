import { createHash, randomBytes } from 'node:crypto'

/**
 * 외부 게스트(거래처) 접근 — 초대·격리·수명주기.
 *
 * 왜 별도 역할인가: 게스트를 tenant-member로 만들면 TENANT_MEMBER_READ_KEYS에 따라
 * 재고·일정·자산 같은 회사 데이터가 그대로 열린다. 그래서 'tenant-guest'라는 더 좁은
 * 역할 문자열을 두고, 기존 분기(=== 'tenant-member' / === 'tenant-admin') 어느 쪽도
 * 타지 않는 요청은 이 파일의 게이트가 **기본 거부**한다.
 *
 * 1차 방어는 라우트 게이트(allowlist 밖 전부 403), 2차 방어는 허용 라우트 안의 행 필터다.
 * 기존 네 가드(requireAuth 등)의 코드는 건드리지 않고 app.use('/api')로 "추가"만 한다.
 */

export const GUEST_ROLE = 'tenant-guest'

/** 게스트 세션이 부를 수 있는 /api 라우트 전부. 여기 없는 것은 전부 403이다. */
export const GUEST_ROUTE_ALLOWLIST = [
  // 로그인은 세션을 새로 만드는 행위라 게스트 쿠키가 남아 있어도 막지 않는다 (다른 계정으로 다시 로그인).
  ['POST', /^\/api\/auth\/login$/],
  ['GET', /^\/api\/auth\/session$/], ['POST', /^\/api\/auth\/logout$/], ['POST', /^\/api\/auth\/password\/change$/],
  ['PATCH', /^\/api\/me\/profile$/], ['POST', /^\/api\/me\/password$/],
  ['GET', /^\/api\/guest\/me$/], ['GET', /^\/api\/guest\/invitations\/[^/]+$/], ['POST', /^\/api\/guest\/invitations\/[^/]+\/accept$/],
  ['GET', /^\/api\/projects$/], ['GET', /^\/api\/projects\/[^/]+$/],
  ['POST', /^\/api\/projects\/[^/]+\/posts\/[^/]+\/comments$/], ['DELETE', /^\/api\/projects\/[^/]+\/posts\/[^/]+\/comments\/[^/]+$/],
  ['GET', /^\/api\/workspace\/(work-items|messenger-conversations)$/],
  ['POST', /^\/api\/work-items\/[^/]+\/(transition|checklist)$/],
  ['GET', /^\/api\/documents$/], ['POST', /^\/api\/documents$/], ['GET', /^\/api\/documents\/[^/]+\/download$/], ['DELETE', /^\/api\/documents\/[^/]+$/],
  ['POST', /^\/api\/messenger\/conversations\/[^/]+\/(read|messages|mute)$/],
  ['GET', /^\/api\/messenger\/conversations\/[^/]+\/(messages|search)$/],
  ['POST', /^\/api\/messenger\/conversations\/[^/]+\/messages\/[^/]+\/reactions$/],
  ['GET', /^\/api\/notifications$/], ['POST', /^\/api\/notifications\/(read|subscribe|unsubscribe)$/], ['PUT', /^\/api\/notifications\/settings$/],
  ['GET', /^\/api\/events$/],
]

export const isGuestRouteAllowed = (method, path) => GUEST_ROUTE_ALLOWLIST.some(([m, re]) => m === method && re.test(path))

/** generic 저장소(GET /api/workspace/:key)에서 게스트가 읽을 수 있는 키. 그 외는 403. */
export const GUEST_READ_KEYS = new Set(['work-items', 'messenger-conversations'])

export const GUEST_SCOPE_FORBIDDEN = { code: 'GUEST_SCOPE_FORBIDDEN', message: '초대된 프로젝트 안에서만 사용할 수 있습니다.' }
export const GUEST_ACCESS_ENDED = { code: 'GUEST_ACCESS_ENDED', message: '초대 기간이 끝났거나 접근이 해지되었습니다.' }
const INVITATION_NOT_FOUND = { code: 'INVITATION_NOT_FOUND', message: '유효하지 않은 초대 링크입니다. 초대한 회사에 재발송을 요청하세요.' }

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,100}$/
const MAX_PROJECTS_PER_GRANT = 20
const DEFAULT_INVITE_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1_000

const tokenDigest = (token) => createHash('sha256').update(String(token)).digest('hex')
const nowIso = (clock) => clock().toISOString()

/** 초대 메일 미리보기·감사에 쓰는 가린 이메일. 앞 두 글자와 도메인만 남긴다. */
export const maskEmail = (email) => {
  const [local = '', domain = ''] = String(email ?? '').split('@')
  if (!domain) return '***'
  return `${local.slice(0, 2)}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`
}

/** request.auth에 실리는 게스트 범위. 헬퍼(projectRoleOf 등)가 auth 하나만 받으므로 여기에 싣는다. */
export const guestScopeOf = (grant) => ({
  grantId: grant?.id ?? null,
  projectIds: Array.isArray(grant?.projectIds) ? [...grant.projectIds] : [],
  orgName: grant?.orgName ?? '',
  accessExpiresAt: grant?.accessExpiresAt ?? null,
  invitedByName: grant?.invitedByName ?? '',
})

/** 접근이 끝났는가 — grant가 없거나 active가 아니거나 접속 종료일이 지났으면 끝. */
export const isGuestGrantEnded = (grant, now = new Date()) => !grant
  || grant.status !== 'active'
  || (Boolean(grant.accessExpiresAt) && Date.parse(grant.accessExpiresAt) <= now.getTime())

/** 게스트에게 보이는 업무: 범위 안 프로젝트에 귀속되고 본인이 담당자인 것만. 요청자인 것은 보지 않는다. */
export const isGuestWorkItem = (item, auth) => Boolean(item?.projectId)
  && (auth?.guestScope?.projectIds ?? []).includes(item.projectId)
  && item?.ownerId === auth?.id

/** 과금 이벤트 metadata 태그. 스키마를 바꾸지 않고 역할별 집계 축을 만든다. */
export const usageMetadataFor = (auth) => ({
  actorRole: auth?.role ?? 'unknown',
  ...(auth?.guestScope?.grantId ? { guestGrantId: auth.guestScope.grantId } : {}),
})

/**
 * 관리자가 업무를 저장할 때 게스트 관련 제약. 정규화(normalizeAdminWorkItems) 뒤에 부른다.
 * 게스트는 결재자가 될 수 없고(요청자 불가), 담당자가 되려면 범위 안 프로젝트에 귀속돼야 한다.
 */
export function guestWorkItemViolation(items, accounts, guestGrantOf) {
  const guestIds = new Set(accounts.filter((account) => account.role === GUEST_ROLE).map((account) => account.id))
  if (!guestIds.size) return null
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.requesterId && guestIds.has(item.requesterId)) {
      return { code: 'GUEST_CANNOT_REQUEST', message: '외부 게스트는 업무를 지시하거나 결재할 수 없습니다. 요청자를 회사 구성원으로 바꿔 주세요.' }
    }
    if (item?.ownerId && guestIds.has(item.ownerId)) {
      const grant = guestGrantOf(item.ownerId)
      if (!item.projectId || !(grant?.projectIds ?? []).includes(item.projectId)) {
        return { code: 'GUEST_PROJECT_REQUIRED', message: '외부 게스트에게 배정하는 업무는 그 게스트가 초대된 프로젝트에 귀속돼야 합니다.' }
      }
    }
  }
  return null
}

/**
 * 게스트 행위 감사. 운영자 모드(recordOperatorActivity)와 같은 관례 —
 * actor '게스트 <이름>', reference = grant id, 조회는 같은 경로 10분에 1건, 변경은 건별.
 */
export function createGuestActivityRecorder({ platformOf, appendPlatformAudit, scheduleAuditCommit, clock = () => new Date() }) {
  const readLog = new Map()
  return (request, account, grant) => {
    if (!grant) return
    const isRead = request.method === 'GET' || request.method === 'HEAD'
    const path = String(request.originalUrl ?? request.url ?? '').split('?')[0]
    const routePath = path.replace(/\/[A-Z][A-Z0-9-]{5,}(?=\/|$)/g, '/:id').replace(/\/(grp|dm|m|PP|PC|DOC|WK|GST)-[^/]+(?=\/|$)/g, '/:id')
    if (isRead) {
      const key = `guest:${account.id}:${routePath}`
      const last = readLog.get(key) ?? 0
      if (clock().getTime() - last < 10 * 60_000) return
      readLog.set(key, clock().getTime())
    }
    appendPlatformAudit(platformOf(), {
      tenantId: account.tenantId,
      event: isRead ? '게스트 조회' : '게스트 변경',
      scope: `${request.method} ${routePath}`,
      actor: `게스트 ${account.name}`,
      reference: grant.id,
    })
    scheduleAuditCommit()
  }
}

/**
 * 게스트 라우트 게이트. app.use('/api', …)로 등록한다.
 * 게스트가 아닌 세션은 그대로 통과 — 기존 가드·라우트의 동작이 1비트도 바뀌지 않는다.
 */
export function createGuestRouteGate({ authenticatedContext, guestGrantOf, recordGuestActivity = () => {}, clock = () => new Date() }) {
  return (request, response, next) => {
    const { account } = authenticatedContext(request)
    if (!account || account.role !== GUEST_ROLE) { next(); return }
    // app.use('/api') 안에서 request.path는 '/api'가 잘린다. originalUrl로 판정한다.
    const path = String(request.originalUrl ?? '').split('?')[0]
    const grant = guestGrantOf(account.id)
    if (isGuestGrantEnded(grant, clock()) && !/^\/api\/auth\/(session|logout|login)$/.test(path)) {
      response.status(403).json({ error: GUEST_ACCESS_ENDED })
      return
    }
    if (!isGuestRouteAllowed(request.method, path)) {
      response.status(403).json({ error: GUEST_SCOPE_FORBIDDEN })
      return
    }
    recordGuestActivity(request, account, grant)
    next()
  }
}

/**
 * 초대 수명주기 라우트. 저장은 workspaceStore.guestGrants(최상위 컬렉션) + invitedAccounts(role 보존).
 * 반환값의 syncGuestMembership·expireGuestGrants는 app.mjs가 스케줄러·다른 라우트에서 재사용한다.
 */
export function registerGuestRoutes({
  app,
  requireAuth,
  requireTenantAdmin,
  requireMatchingWorkspaceIdentity,
  workspaceStore,
  accounts,
  sessions,
  commitWorkspaceStore,
  appendPlatformAudit,
  passwordDigest,
  validNewPassword,
  guestInviteDelivery = null,
  publicUrlOf = null,
  // 첨부 접근을 members와 함께 맞추기 위한 app.mjs 헬퍼. 없으면(옛 호출자·단위 시험) members·participantIds만 맞춘다.
  grantDocumentAccess = null,
  projectMemberIds = null,
  linkedDocumentIds = null,
  clock = () => new Date(),
  logger = console,
}) {
  workspaceStore.guestGrants ??= []
  const grants = () => workspaceStore.guestGrants
  const guestGrantOf = (accountId) => grants().find((grant) => grant?.accountId === accountId) ?? null
  const grantById = (tenantId, id) => grants().find((grant) => grant?.id === id && grant.tenantId === tenantId) ?? null
  const accountOf = (grant) => accounts.find((account) => account.id === grant?.accountId) ?? null
  const projectsOf = (tenantId) => (Array.isArray(workspaceStore.tenants[tenantId]?.['project-spaces']?.data) ? workspaceStore.tenants[tenantId]['project-spaces'].data : [])
  const postsOf = (tenantId) => (Array.isArray(workspaceStore.tenants[tenantId]?.['project-posts']?.data) ? workspaceStore.tenants[tenantId]['project-posts'].data : [])
  const documentsOf = (tenantId) => (Array.isArray(workspaceStore.tenants[tenantId]?.['company-documents']?.data) ? workspaceStore.tenants[tenantId]['company-documents'].data : [])
  const tenantName = (tenantId) => workspaceStore.platform?.tenants?.find((tenant) => tenant?.id === tenantId)?.name ?? ''
  const fail = (response, status, code, message) => response.status(status).json({ error: { code, message } })
  const snapshot = () => structuredClone({ grants: workspaceStore.guestGrants, approvals: workspaceStore.accountApprovals, invited: workspaceStore.invitedAccounts, credentials: workspaceStore.accountCredentials })
  const restore = (saved) => {
    workspaceStore.guestGrants = saved.grants
    workspaceStore.accountApprovals = saved.approvals
    workspaceStore.invitedAccounts = saved.invited
    workspaceStore.accountCredentials = saved.credentials
  }

  const audit = (tenantId, event, scope, actor, reference) => appendPlatformAudit(workspaceStore.platform, { tenantId, event, scope, actor, reference })
  const guestActor = (account) => `게스트 ${account?.name ?? ''}`.trim()

  /** 게스트의 열린 세션을 전부 끊는다. 비활성·해지·만료는 로그인만 막아서는 이미 들어온 창이 계속 돈다. */
  const dropSessions = (accountId) => {
    for (const [token, session] of sessions.entries()) {
      if (session?.accountId === accountId) sessions.delete(token)
    }
  }

  /**
   * grant 범위와 프로젝트 멤버·대화 참여자·첨부 접근을 맞춘다.
   * 범위 안 프로젝트에는 viewer로 들어가고, 범위 밖(또는 remove)에서는 members·participantIds에서 빠진다.
   *
   * 첨부(company-documents)도 여기서 함께 맞춰야 한다. grantDocumentAccess는 게시·댓글·프로젝트 PATCH 시점에만
   * 멤버에게 문서를 열어 주므로, 그 뒤에 초대된 게스트는 기존 첨부를 못 열고, 범위에서 빠진 게스트는
   * 예전에 열린 첨부를 계속 읽게 된다. "초대된 프로젝트 밖은 존재조차 보이지 않는다"가 범위 변경 시점부터 깨진다.
   */
  const syncGuestMembership = (grant, { remove = false } = {}) => {
    const account = accountOf(grant)
    if (!account) return false
    const tenantStore = workspaceStore.tenants[grant.tenantId] ??= {}
    const inScope = new Set(remove ? [] : grant.projectIds ?? [])
    let changed = false
    const projects = projectsOf(grant.tenantId).map((project) => {
      const members = Array.isArray(project?.members) ? project.members : []
      const has = members.some((member) => member?.id === account.id)
      if (inScope.has(project.id) && !has) {
        changed = true
        return { ...project, members: [...members, { id: account.id, name: account.name, team: grant.orgName, role: 'viewer', kind: 'guest' }], updatedAt: nowIso(clock) }
      }
      if (!inScope.has(project.id) && has) {
        changed = true
        return { ...project, members: members.filter((member) => member?.id !== account.id), updatedAt: nowIso(clock) }
      }
      return project
    })
    if (changed) tenantStore['project-spaces'] = { data: projects, updatedAt: nowIso(clock), updatedBy: 'system:guest-membership' }

    // 대화방: 프로젝트 채널(projectId 있는 방)에서 범위 밖이면 빠진다. 해지 시에는 참여한 모든 그룹·팀 방에서 빠지되,
    // 1:1 대화는 상대 직원의 기록으로 남긴다 — 참여자 한 명짜리 방을 만들지 않는다.
    const record = tenantStore['messenger-conversations']
    if (Array.isArray(record?.data)) {
      let roomsChanged = false
      const conversations = record.data.map((conversation) => {
        if (!Array.isArray(conversation?.participantIds) || !conversation.participantIds.includes(account.id)) return conversation
        if (conversation.type === 'direct') return conversation
        const keep = !remove && conversation.projectId && inScope.has(conversation.projectId)
        if (keep) return conversation
        roomsChanged = true
        const participantIds = conversation.participantIds.filter((id) => id !== account.id)
        return { ...conversation, participantIds, subtitle: conversation.kind === 'group' ? `${participantIds.length}명` : conversation.subtitle }
      })
      if (roomsChanged) tenantStore['messenger-conversations'] = { data: conversations, updatedAt: nowIso(clock), updatedBy: 'system:guest-membership' }
      changed = changed || roomsChanged
    }

    // 첨부 (a): 범위 밖 프로젝트에 귀속된 문서의 allowedUserIds에서 게스트를 뺀다. 해지(remove)면 모든 문서에서 뺀다 —
    // 계정은 inactive라 로그인이 안 되지만, 저장된 권한 목록에 외부인이 남아 있을 이유가 없다.
    // 게스트가 직접 올린 문서는 uploadedById 기준으로 본인에게만 계속 보인다(본인의 기록).
    const documentRecord = tenantStore['company-documents']
    if (Array.isArray(documentRecord?.data)) {
      let documentsChanged = false
      const documents = documentRecord.data.map((document) => {
        if (!Array.isArray(document?.allowedUserIds) || !document.allowedUserIds.includes(account.id)) return document
        const outOfScope = remove || (Boolean(document.projectId) && !inScope.has(document.projectId))
        if (!outOfScope) return document
        documentsChanged = true
        return { ...document, allowedUserIds: document.allowedUserIds.filter((id) => id !== account.id) }
      })
      if (documentsChanged) tenantStore['company-documents'] = { data: documents, updatedAt: nowIso(clock), updatedBy: 'system:guest-membership' }
      changed = changed || documentsChanged
    }

    // 첨부 (b): 범위 안 프로젝트의 기존 게시글·댓글 첨부를 프로젝트 멤버(이제 게스트 포함)에게 연다.
    // 초대 전에 올라간 도면·사양서를 게스트 자료 탭에서 열 수 있어야 한다.
    if (!remove && typeof grantDocumentAccess === 'function') {
      const posts = postsOf(grant.tenantId)
      for (const project of projects) {
        if (!inScope.has(project?.id)) continue
        const projectPosts = posts.filter((post) => post?.projectId === project.id)
        const documentIds = typeof linkedDocumentIds === 'function'
          ? linkedDocumentIds(projectPosts)
          : projectPosts.flatMap((post) => [...(post?.attachments ?? []), ...(post?.comments ?? []).flatMap((comment) => comment?.attachments ?? [])].map((attachment) => attachment?.id))
        const memberIds = typeof projectMemberIds === 'function'
          ? projectMemberIds(project)
          : [...new Set([project.ownerId, ...(project.members ?? []).map((member) => member?.id)].filter(Boolean))]
        if (grantDocumentAccess(grant.tenantId, documentIds, memberIds, { projectId: project.id })) changed = true
      }
    }
    return changed
  }

  const issueToken = (grant, days) => {
    const token = randomBytes(32).toString('base64url')
    grant.tokenHash = tokenDigest(token)
    grant.tokenIssuedAt = nowIso(clock)
    grant.tokenExpiresAt = new Date(clock().getTime() + days * DAY_MS).toISOString()
    return token
  }

  const inviteUrl = (request, token) => {
    const base = typeof publicUrlOf === 'function' ? publicUrlOf(request) : null
    const origin = String(base || `${request.protocol}://${request.get('host')}`).replace(/\/+$/, '')
    return `${origin}/?guestInvite=${encodeURIComponent(token)}`
  }

  /** 발송 훅. 없거나 실패하면 'link-only'로 강등하고 화면이 링크를 복사하게 한다. 초대 자체는 저장된다. */
  const deliver = async ({ request, grant, account, token }) => {
    const url = inviteUrl(request, token)
    const base = { url, expiresAt: grant.tokenExpiresAt, delivery: 'link-only' }
    if (typeof guestInviteDelivery !== 'function') return base
    try {
      const result = await guestInviteDelivery({
        email: account.email,
        name: account.name,
        tenantName: tenantName(grant.tenantId) || account.tenantName || '',
        inviterName: grant.invitedByName,
        orgName: grant.orgName,
        projectNames: projectsOf(grant.tenantId).filter((project) => grant.projectIds.includes(project.id)).map((project) => project.name),
        inviteUrl: url,
        expiresAt: grant.tokenExpiresAt,
      })
      return result?.delivered ? { ...base, delivery: 'sent', channel: result.channel ?? 'mail' } : base
    } catch (error) {
      logger.warn?.('[guest-invite] 초대 메일 발송 실패 — 링크 전달로 강등', { message: error?.message })
      return base
    }
  }

  const parseDays = (value) => {
    if (value === undefined || value === null || value === '') return DEFAULT_INVITE_DAYS
    const days = Number(value)
    return Number.isInteger(days) && days >= 1 && days <= 30 ? days : null
  }
  const parseAccessExpiresAt = (value) => {
    if (value === undefined || value === null || value === '') return null
    const parsed = Date.parse(String(value))
    if (!Number.isFinite(parsed)) return undefined
    return new Date(parsed).toISOString()
  }
  const parseProjectIds = (tenantId, value) => {
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PROJECTS_PER_GRANT) return null
    const ids = [...new Set(value.map((id) => String(id ?? '').trim()).filter(Boolean))]
    const known = new Set(projectsOf(tenantId).map((project) => project?.id))
    return ids.length && ids.every((id) => known.has(id)) ? ids : null
  }

  const lastActivityOf = (grant) => (workspaceStore.platform?.auditEvents ?? [])
    .find((event) => event?.tenantId === grant.tenantId && event.reference === grant.id)?.at ?? null

  const publicGrant = (grant) => {
    const account = accountOf(grant)
    const projects = projectsOf(grant.tenantId)
    const inviteExpired = grant.status === 'invited' && (!grant.tokenHash || Date.parse(grant.tokenExpiresAt ?? 0) <= clock().getTime())
    const commentCount = postsOf(grant.tenantId).reduce((sum, post) => sum + (post?.comments ?? []).filter((comment) => comment?.authorId === grant.accountId).length, 0)
    const attachmentCount = documentsOf(grant.tenantId).filter((document) => document?.uploadedById === grant.accountId).length
    const { tokenHash: _tokenHash, ...rest } = grant
    return {
      ...rest,
      email: account?.email ?? grant.email,
      name: account?.name ?? grant.name,
      hasInvitationToken: Boolean(grant.tokenHash),
      inviteExpired,
      projects: grant.projectIds.map((id) => projects.find((project) => project?.id === id)).filter(Boolean).map((project) => ({ id: project.id, name: project.name, stage: project.stage ?? '', status: project.status ?? 'active' })),
      lastActivityAt: lastActivityOf(grant),
      commentCount,
      attachmentCount,
    }
  }

  const adminGuards = [requireAuth, requireTenantAdmin, requireMatchingWorkspaceIdentity]

  app.get('/api/admin/guests', ...adminGuards, (request, response) => {
    const rows = grants().filter((grant) => grant?.tenantId === request.auth.tenantId).map(publicGrant)
    rows.sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))
    response.json({ guests: rows })
  })

  app.post('/api/admin/guests', ...adminGuards, async (request, response) => {
    const email = String(request.body?.email ?? '').trim().toLowerCase()
    const name = String(request.body?.name ?? '').trim().slice(0, 40)
    const orgName = String(request.body?.orgName ?? '').trim().slice(0, 80)
    if (!/^\S+@\S+\.\S+$/.test(email) || name.length < 2) { fail(response, 400, 'INVALID_GUEST_INVITE', '이름(2~40자)과 이메일을 입력해 주세요.'); return }
    if (!orgName) { fail(response, 400, 'INVALID_GUEST_INVITE', '거래처(소속) 이름을 입력해 주세요.'); return }
    const projectIds = parseProjectIds(request.auth.tenantId, request.body?.projectIds)
    if (!projectIds) { fail(response, 400, 'INVALID_GUEST_PROJECTS', `초대할 프로젝트를 1~${MAX_PROJECTS_PER_GRANT}개 골라 주세요. 이 회사의 프로젝트만 지정할 수 있습니다.`); return }
    const days = parseDays(request.body?.inviteExpiresInDays)
    if (days === null) { fail(response, 400, 'INVALID_GUEST_INVITE', '초대 링크 유효기간은 1~30일 사이여야 합니다.'); return }
    const accessExpiresAt = parseAccessExpiresAt(request.body?.accessExpiresAt)
    if (accessExpiresAt === undefined || (accessExpiresAt && Date.parse(accessExpiresAt) <= clock().getTime())) { fail(response, 400, 'INVALID_GUEST_INVITE', '접속 종료일은 오늘 이후 날짜여야 합니다.'); return }
    // core_accounts.email은 전역 UNIQUE라 다른 워크스페이스의 계정과도 겹칠 수 없다.
    if (accounts.some((account) => account.email.toLowerCase() === email)) {
      fail(response, 409, 'ACCOUNT_EXISTS', '이미 다른 워크스페이스에 등록된 이메일이거나 이 회사에 있는 계정입니다. 게스트는 새 이메일로만 초대할 수 있습니다.')
      return
    }
    const now = nowIso(clock)
    const hex = () => randomBytes(6).toString('hex').toUpperCase()
    const accountId = `USR-${request.auth.tenantId}-${hex()}`
    const grant = {
      id: `GST-${request.auth.tenantId}-${hex()}`,
      tenantId: request.auth.tenantId,
      accountId,
      email, name, orgName,
      projectIds,
      invitedById: request.auth.id,
      invitedByName: request.auth.name,
      status: 'invited',
      tokenHash: null, tokenIssuedAt: null, tokenExpiresAt: null,
      resendCount: 0, lastResentAt: null,
      accessExpiresAt,
      acceptedAt: null, revokedAt: null, revokedById: null, deactivatedAt: null,
      createdAt: now, updatedAt: now,
    }
    const token = issueToken(grant, days)
    const account = {
      id: accountId,
      name, email,
      role: GUEST_ROLE,
      tenantId: request.auth.tenantId,
      tenantName: request.auth.tenantName,
      team: orgName,
      jobRole: '외부 게스트',
      requested: '게스트 초대',
      approved: false,
      approvalStatus: 'pending',
      guestGrantId: grant.id,
      // 수락 때 게스트가 직접 정한다. 그 전에는 아무도 모르는 값이어야 한다.
      password: passwordDigest(randomBytes(32).toString('base64url'), accountId),
    }
    const saved = snapshot()
    const previousProjects = workspaceStore.tenants[request.auth.tenantId]?.['project-spaces']
    const previousDocuments = workspaceStore.tenants[request.auth.tenantId]?.['company-documents']
    accounts.push(account)
    workspaceStore.invitedAccounts.push({
      id: accountId, email, name, tenantId: account.tenantId, tenantName: account.tenantName,
      team: orgName, jobRole: account.jobRole, requested: account.requested,
      // 이 두 필드를 빠뜨리면 재기동 시 부트 조립이 게스트를 일반 직원(tenant-member)으로 되살린다.
      role: GUEST_ROLE, guestGrantId: grant.id,
    })
    workspaceStore.guestGrants.push(grant)
    syncGuestMembership(grant)
    audit(request.auth.tenantId, '게스트 초대', `${name} (${orgName}) · 프로젝트 ${projectIds.length}개`, request.auth.name, grant.id)
    try {
      await commitWorkspaceStore()
    } catch (error) {
      accounts.splice(accounts.indexOf(account), 1)
      restore(saved)
      const tenantStore = workspaceStore.tenants[request.auth.tenantId]
      if (tenantStore) {
        if (previousProjects) tenantStore['project-spaces'] = previousProjects; else delete tenantStore['project-spaces']
        if (previousDocuments) tenantStore['company-documents'] = previousDocuments; else delete tenantStore['company-documents']
      }
      logger.error?.('[guest-invite] 초대를 저장하지 못했습니다.', { message: error?.message })
      fail(response, 500, 'GUEST_INVITE_WRITE_FAILED', '게스트 초대를 저장하지 못했습니다.')
      return
    }
    const invitation = await deliver({ request, grant, account, token })
    response.status(201).json({ guest: publicGrant(grant), invitation })
  })

  app.post('/api/admin/guests/:id/resend', ...adminGuards, async (request, response) => {
    const grant = grantById(request.auth.tenantId, request.params.id)
    if (!grant) { fail(response, 404, 'GUEST_NOT_FOUND', '게스트를 찾을 수 없습니다.'); return }
    if (grant.status !== 'invited') { fail(response, 409, 'GUEST_NOT_INVITED', '초대 대기 상태의 게스트에게만 다시 보낼 수 있습니다.'); return }
    const days = parseDays(request.body?.inviteExpiresInDays)
    if (days === null) { fail(response, 400, 'INVALID_GUEST_INVITE', '초대 링크 유효기간은 1~30일 사이여야 합니다.'); return }
    const account = accountOf(grant)
    if (!account) { fail(response, 404, 'GUEST_NOT_FOUND', '게스트 계정을 찾을 수 없습니다.'); return }
    const saved = snapshot()
    // 이전 토큰은 즉시 무효 — 해시가 바뀌므로 옛 링크는 404가 된다.
    const token = issueToken(grant, days)
    grant.resendCount = (grant.resendCount ?? 0) + 1
    grant.lastResentAt = nowIso(clock)
    grant.updatedAt = grant.lastResentAt
    audit(request.auth.tenantId, '게스트 초대 재발송', `${grant.name} (${grant.orgName}) · ${grant.resendCount}회`, request.auth.name, grant.id)
    try { await commitWorkspaceStore() } catch { restore(saved); fail(response, 500, 'GUEST_INVITE_WRITE_FAILED', '재발송 내용을 저장하지 못했습니다.'); return }
    const invitation = await deliver({ request, grant, account, token })
    response.json({ guest: publicGrant(grant), invitation })
  })

  app.post('/api/admin/guests/:id/revoke-invitation', ...adminGuards, async (request, response) => {
    const grant = grantById(request.auth.tenantId, request.params.id)
    if (!grant) { fail(response, 404, 'GUEST_NOT_FOUND', '게스트를 찾을 수 없습니다.'); return }
    if (grant.status !== 'invited') { fail(response, 409, 'GUEST_NOT_INVITED', '초대 대기 상태에서만 초대를 회수할 수 있습니다.'); return }
    const saved = snapshot()
    grant.tokenHash = null
    grant.updatedAt = nowIso(clock)
    audit(request.auth.tenantId, '게스트 초대 회수', `${grant.name} (${grant.orgName})`, request.auth.name, grant.id)
    try { await commitWorkspaceStore() } catch { restore(saved); fail(response, 500, 'GUEST_INVITE_WRITE_FAILED', '초대 회수를 저장하지 못했습니다.'); return }
    response.json({ guest: publicGrant(grant) })
  })

  app.patch('/api/admin/guests/:id', ...adminGuards, async (request, response) => {
    const grant = grantById(request.auth.tenantId, request.params.id)
    if (!grant) { fail(response, 404, 'GUEST_NOT_FOUND', '게스트를 찾을 수 없습니다.'); return }
    if (['revoked', 'expired'].includes(grant.status)) { fail(response, 409, 'GUEST_ENDED', '해지되었거나 만료된 게스트의 범위는 바꿀 수 없습니다.'); return }
    const account = accountOf(grant)
    const next = { ...grant }
    if (request.body?.projectIds !== undefined) {
      const projectIds = parseProjectIds(request.auth.tenantId, request.body.projectIds)
      if (!projectIds) { fail(response, 400, 'INVALID_GUEST_PROJECTS', `프로젝트를 1~${MAX_PROJECTS_PER_GRANT}개 골라 주세요. 이 회사의 프로젝트만 지정할 수 있습니다.`); return }
      next.projectIds = projectIds
    }
    if (request.body?.accessExpiresAt !== undefined) {
      const accessExpiresAt = parseAccessExpiresAt(request.body.accessExpiresAt)
      if (accessExpiresAt === undefined) { fail(response, 400, 'INVALID_GUEST_INVITE', '접속 종료일 형식을 확인해 주세요.'); return }
      next.accessExpiresAt = accessExpiresAt
    }
    if (request.body?.orgName !== undefined) {
      const orgName = String(request.body.orgName).trim().slice(0, 80)
      if (!orgName) { fail(response, 400, 'INVALID_GUEST_INVITE', '거래처(소속) 이름을 입력해 주세요.'); return }
      next.orgName = orgName
    }
    if (request.body?.name !== undefined) {
      const name = String(request.body.name).trim().slice(0, 40)
      if (name.length < 2) { fail(response, 400, 'INVALID_GUEST_INVITE', '이름은 2자 이상 입력해 주세요.'); return }
      next.name = name
    }
    const saved = snapshot()
    const tenantStore = workspaceStore.tenants[request.auth.tenantId] ?? {}
    const previousProjects = tenantStore['project-spaces']
    const previousRooms = tenantStore['messenger-conversations']
    const previousDocuments = tenantStore['company-documents']
    const previousAccount = account ? { name: account.name, team: account.team } : null
    Object.assign(grant, next, { updatedAt: nowIso(clock) })
    if (account) { account.name = grant.name; account.team = grant.orgName }
    const invited = workspaceStore.invitedAccounts.find((item) => item?.id === grant.accountId)
    if (invited) { invited.name = grant.name; invited.team = grant.orgName }
    syncGuestMembership(grant)
    audit(request.auth.tenantId, '게스트 범위 변경', `${grant.name} (${grant.orgName}) · 프로젝트 ${grant.projectIds.length}개${grant.accessExpiresAt ? ` · 종료 ${grant.accessExpiresAt.slice(0, 10)}` : ''}`, request.auth.name, grant.id)
    try {
      await commitWorkspaceStore()
    } catch {
      restore(saved)
      if (account && previousAccount) Object.assign(account, previousAccount)
      if (previousProjects) tenantStore['project-spaces'] = previousProjects
      if (previousRooms) tenantStore['messenger-conversations'] = previousRooms
      if (previousDocuments) tenantStore['company-documents'] = previousDocuments
      fail(response, 500, 'GUEST_WRITE_FAILED', '게스트 범위를 저장하지 못했습니다.')
      return
    }
    response.json({ guest: publicGrant(grant) })
  })

  app.post('/api/admin/guests/:id/status', ...adminGuards, async (request, response) => {
    const grant = grantById(request.auth.tenantId, request.params.id)
    if (!grant) { fail(response, 404, 'GUEST_NOT_FOUND', '게스트를 찾을 수 없습니다.'); return }
    const wanted = request.body?.status
    if (!['inactive', 'active'].includes(wanted)) { fail(response, 400, 'INVALID_GUEST_STATUS', "상태는 'inactive' 또는 'active'만 가능합니다."); return }
    const account = accountOf(grant)
    if (!account) { fail(response, 404, 'GUEST_NOT_FOUND', '게스트 계정을 찾을 수 없습니다.'); return }
    if (wanted === 'inactive' && grant.status !== 'active') { fail(response, 409, 'GUEST_NOT_ACTIVE', '활성 상태의 게스트만 비활성화할 수 있습니다.'); return }
    if (wanted === 'active' && grant.status !== 'inactive') { fail(response, 409, 'GUEST_NOT_INACTIVE', '비활성 상태의 게스트만 다시 활성화할 수 있습니다.'); return }
    const saved = snapshot()
    const previousAccount = { approved: account.approved, approvalStatus: account.approvalStatus }
    const now = nowIso(clock)
    if (wanted === 'inactive') {
      // 로그인 라우트는 건드리지 않는다. approvals 'inactive'면 기존 ACCOUNT_INACTIVE 분기가 막는다.
      grant.status = 'inactive'; grant.deactivatedAt = now
      account.approved = false; account.approvalStatus = 'inactive'
      workspaceStore.accountApprovals[account.id] = 'inactive'
      dropSessions(account.id)
    } else {
      grant.status = 'active'; grant.deactivatedAt = null
      account.approved = true; account.approvalStatus = 'approved'
      workspaceStore.accountApprovals[account.id] = 'approved'
    }
    grant.updatedAt = now
    audit(request.auth.tenantId, wanted === 'inactive' ? '게스트 비활성' : '게스트 재활성', `${grant.name} (${grant.orgName})`, request.auth.name, grant.id)
    try {
      await commitWorkspaceStore()
      await sessions.flush?.()
    } catch {
      restore(saved); Object.assign(account, previousAccount)
      fail(response, 500, 'GUEST_WRITE_FAILED', '게스트 상태를 저장하지 못했습니다.')
      return
    }
    response.json({ guest: publicGrant(grant) })
  })

  app.delete('/api/admin/guests/:id', ...adminGuards, async (request, response) => {
    const grant = grantById(request.auth.tenantId, request.params.id)
    if (!grant) { fail(response, 404, 'GUEST_NOT_FOUND', '게스트를 찾을 수 없습니다.'); return }
    if (grant.status === 'revoked') { response.json({ guest: publicGrant(grant) }); return }
    const account = accountOf(grant)
    const saved = snapshot()
    const tenantStore = workspaceStore.tenants[request.auth.tenantId] ?? {}
    const previousProjects = tenantStore['project-spaces']
    const previousRooms = tenantStore['messenger-conversations']
    const previousDocuments = tenantStore['company-documents']
    const previousAccount = account ? { approved: account.approved, approvalStatus: account.approvalStatus } : null
    const now = nowIso(clock)
    // 계정·grant는 감사 추적용으로 남긴다 — 지우면 그 게스트가 남긴 댓글·첨부가 이름 없는 기록이 된다.
    grant.status = 'revoked'; grant.revokedAt = now; grant.revokedById = request.auth.id; grant.tokenHash = null; grant.updatedAt = now
    if (account) {
      account.approved = false; account.approvalStatus = 'inactive'
      workspaceStore.accountApprovals[account.id] = 'inactive'
      dropSessions(account.id)
    }
    syncGuestMembership(grant, { remove: true })
    audit(request.auth.tenantId, '게스트 해지', `${grant.name} (${grant.orgName})`, request.auth.name, grant.id)
    try {
      await commitWorkspaceStore()
      await sessions.flush?.()
    } catch {
      restore(saved)
      if (account && previousAccount) Object.assign(account, previousAccount)
      if (previousProjects) tenantStore['project-spaces'] = previousProjects
      if (previousRooms) tenantStore['messenger-conversations'] = previousRooms
      if (previousDocuments) tenantStore['company-documents'] = previousDocuments
      fail(response, 500, 'GUEST_WRITE_FAILED', '게스트 해지를 저장하지 못했습니다.')
      return
    }
    response.json({ guest: publicGrant(grant) })
  })

  app.get('/api/admin/guests/:id/audit', ...adminGuards, (request, response) => {
    const grant = grantById(request.auth.tenantId, request.params.id)
    if (!grant) { fail(response, 404, 'GUEST_NOT_FOUND', '게스트를 찾을 수 없습니다.'); return }
    const events = (workspaceStore.platform?.auditEvents ?? [])
      .filter((event) => event?.tenantId === request.auth.tenantId && (event.reference === grant.id || event.reference === grant.accountId))
      .slice(0, 200)
    response.json({ events })
  })

  // ── 공개 라우트: 초대 링크 ───────────────────────────────────────
  // 없음/만료/회수/수락 완료를 구분해 답하면 토큰을 대고 상태를 캘 수 있다. 전부 같은 404다.
  const invitationByToken = (token) => {
    if (!TOKEN_PATTERN.test(String(token ?? ''))) return null
    const hash = tokenDigest(token)
    const grant = grants().find((item) => item?.tokenHash === hash && item.status === 'invited')
    if (!grant || !grant.tokenExpiresAt || Date.parse(grant.tokenExpiresAt) <= clock().getTime()) return null
    return grant
  }

  app.get('/api/guest/invitations/:token', (request, response) => {
    const grant = invitationByToken(request.params.token)
    const account = grant ? accountOf(grant) : null
    if (!grant || !account) { response.status(404).json({ error: INVITATION_NOT_FOUND }); return }
    response.json({
      tenantName: tenantName(grant.tenantId) || account.tenantName || '',
      projectNames: projectsOf(grant.tenantId).filter((project) => grant.projectIds.includes(project.id)).map((project) => project.name),
      inviterName: grant.invitedByName,
      orgName: grant.orgName,
      maskedEmail: maskEmail(account.email),
      expiresAt: grant.tokenExpiresAt,
    })
  })

  app.post('/api/guest/invitations/:token/accept', async (request, response) => {
    const grant = invitationByToken(request.params.token)
    const account = grant ? accountOf(grant) : null
    if (!grant || !account) { response.status(404).json({ error: INVITATION_NOT_FOUND }); return }
    const password = String(request.body?.password ?? '')
    if (!validNewPassword(password, account)) { fail(response, 400, 'WEAK_PASSWORD', '10자 이상이며 영문 대·소문자, 숫자와 특수문자를 모두 포함해 주세요.'); return }
    const saved = snapshot()
    const previousAccount = { approved: account.approved, approvalStatus: account.approvalStatus, password: account.password, mustChangePassword: account.mustChangePassword }
    const now = nowIso(clock)
    account.password = passwordDigest(password, account.id)
    account.mustChangePassword = false
    account.temporaryPasswordExpiresAt = null
    account.approved = true
    account.approvalStatus = 'approved'
    workspaceStore.accountApprovals[account.id] = 'approved'
    workspaceStore.accountCredentials[account.id] = { passwordHash: account.password.toString('hex'), mustChangePassword: false, temporaryPasswordExpiresAt: null, changedAt: now }
    grant.status = 'active'; grant.acceptedAt = now; grant.tokenHash = null; grant.updatedAt = now
    audit(grant.tenantId, '게스트 수락', `${grant.name} (${grant.orgName})`, guestActor(account), grant.id)
    try {
      await commitWorkspaceStore()
    } catch {
      restore(saved); Object.assign(account, previousAccount)
      fail(response, 500, 'GUEST_ACCEPT_WRITE_FAILED', '초대 수락을 저장하지 못했습니다. 다시 시도해 주세요.')
      return
    }
    response.json({ email: account.email })
  })

  // ── 게스트 본인 화면용 ───────────────────────────────────────────
  app.get('/api/guest/me', requireAuth, requireMatchingWorkspaceIdentity, (request, response) => {
    if (request.auth.role !== GUEST_ROLE) { fail(response, 404, 'NOT_FOUND', '요청한 자원을 찾을 수 없습니다.'); return }
    const grant = guestGrantOf(request.auth.id)
    const scope = guestScopeOf(grant)
    const projects = projectsOf(request.auth.tenantId)
      .filter((project) => scope.projectIds.includes(project?.id) && (project.members ?? []).some((member) => member?.id === request.auth.id))
      .map((project) => ({ id: project.id, name: project.name, stage: project.stage ?? '', status: project.status ?? 'active' }))
    response.json({
      account: request.auth,
      scope: { projects, orgName: scope.orgName, accessExpiresAt: scope.accessExpiresAt, invitedByName: scope.invitedByName, tenantName: tenantName(request.auth.tenantId) || request.auth.tenantName || '' },
    })
  })

  /** 접속 종료일이 지난 active grant를 만료시킨다. 일 1회 스케줄러 잡. 초대 토큰 만료는 저장하지 않고 조회 때 판정한다. */
  const expireGuestGrants = async ({ now = clock() } = {}) => {
    const due = grants().filter((grant) => grant?.status === 'active' && grant.accessExpiresAt && Date.parse(grant.accessExpiresAt) <= now.getTime())
    if (!due.length) return { expired: 0 }
    const saved = snapshot()
    const touched = []
    for (const grant of due) {
      const account = accountOf(grant)
      grant.status = 'expired'; grant.updatedAt = now.toISOString()
      if (account) {
        touched.push([account, { approved: account.approved, approvalStatus: account.approvalStatus }])
        account.approved = false; account.approvalStatus = 'inactive'
        workspaceStore.accountApprovals[account.id] = 'inactive'
        dropSessions(account.id)
      }
      audit(grant.tenantId, '게스트 만료', `${grant.name} (${grant.orgName}) · 종료 ${String(grant.accessExpiresAt).slice(0, 10)}`, 'system:guest-expiry', grant.id)
    }
    try {
      await commitWorkspaceStore()
      await sessions.flush?.()
    } catch (error) {
      restore(saved)
      for (const [account, previous] of touched) Object.assign(account, previous)
      throw error
    }
    return { expired: due.length }
  }

  return { guestGrantOf, syncGuestMembership, expireGuestGrants }
}

import { randomBytes } from 'node:crypto'

/**
 * 그룹 대화방과 메시지 조작 — 답장·반응·고정·수정·삭제.
 *
 * 왜 전용 라우트인가: 일반 저장 경로(PUT /api/workspace/messenger-conversations)는
 * 메신저에 대해 사실상 읽기 전용이다. 데이터가 한 번 생기면 관리자도 "완전히 같은 배열"만
 * 통과하고, 구성원은 방 개수·참여자·방 이름을 못 바꾸며 메시지는 순수 append만 된다.
 * 그 제약이 발신자 위조와 이력 조작을 막고 있으므로 풀지 않는다. 대신 조작마다
 * 서버가 규칙을 아는 전용 라우트를 낸다.
 *
 * 삭제 규약: 메시지는 지우지 않는다. deletedAt과 삭제자만 남기고 본문을 비운다.
 * 대화의 흐름에서 무엇이 사라졌는지는 남아야 한다 — 흔적 없는 삭제는 나중에
 * "그런 말 한 적 없다"를 만든다.
 */

const CONVERSATIONS_KEY = 'messenger-conversations'

/** 방 이름·아이콘 한도. 사람이 알아보는 이름이면 충분하다. */
const MAX_NAME = 60
const MAX_ICON = 8
const MAX_REACTION_EMOJI = 16
const MAX_REACTIONS_PER_MESSAGE = 12
const MAX_PINNED = 20
/** 한 번에 내려주는 메시지 수. 가상 스크롤이 위로 올라가며 더 받아 간다. */
export const MESSAGE_PAGE_SIZE = 50

const text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const nowIso = () => new Date().toISOString()
const seoulTime = (iso) => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso))

const newId = (prefix) => `${prefix}-${Date.now()}-${randomBytes(3).toString('hex')}`

/** 이 방이 자유 생성 그룹방인가. 시드된 팀 채널과 구분해야 방장·초대 규칙이 엇갈리지 않는다. */
export const isGroupRoom = (conversation) => conversation?.kind === 'group'

/**
 * 이모지 하나인가. 반응은 이모지만 받는다 — 문자열을 받으면 그건 반응이 아니라 또 하나의 메시지다.
 * 국기·가족 이모지처럼 여러 코드포인트가 결합된 것도 하나로 센다.
 */
export function isSingleEmoji(value) {
  const raw = String(value ?? '')
  if (!raw || raw.length > MAX_REACTION_EMOJI) return false
  const segmenter = new Intl.Segmenter('ko', { granularity: 'grapheme' })
  if ([...segmenter.segment(raw)].length !== 1) return false
  // 국기는 그림문자가 아니라 지역표시 문자 두 개의 조합이라 Extended_Pictographic에 걸리지 않는다.
  return /\p{Extended_Pictographic}/u.test(raw) || /^\p{Regional_Indicator}{2}$/u.test(raw)
}

/** 방에서 이 계정이 무엇을 할 수 있는가. 방장·테넌트 관리자·참여자 순으로 넓어진다. */
export function roomRole(conversation, auth) {
  if (!conversation) return 'none'
  if (conversation.ownerId && conversation.ownerId === auth?.id) return 'owner'
  if (auth?.role === 'tenant-admin') return 'admin'
  const participants = Array.isArray(conversation.participantIds) ? conversation.participantIds : []
  return participants.includes(auth?.id) ? 'member' : 'none'
}

const canManageRoom = (conversation, auth) => ['owner', 'admin'].includes(roomRole(conversation, auth))

/**
 * 읽음 집계. 방에 몇 명이 읽었는지만 세고 누가 읽었는지는 굳이 펼치지 않는다.
 * 인원이 많은 방에서 "누가 안 읽었나"를 보여 주면 그 자체가 압박이 된다.
 */
export function readSummary(message, conversation) {
  const participants = Array.isArray(conversation?.participantIds) ? conversation.participantIds : []
  const readers = Array.isArray(message?.readBy) ? message.readBy : []
  const others = readers.filter((id) => id !== message?.senderId)
  return {
    count: others.length,
    total: Math.max(0, participants.filter((id) => id !== message?.senderId).length),
  }
}

/** 삭제된 메시지는 본문을 지우되 자리는 남긴다. */
const tombstoneMessage = (message, actorId, at) => ({
  ...message,
  text: '삭제된 메시지',
  attachments: undefined,
  reactions: undefined,
  deletedAt: at,
  deletedBy: actorId,
})

const stripUndefined = (value) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))

export function registerMessengerRoomRoutes({
  app,
  requireAuth,
  requireMatchingWorkspaceIdentity,
  workspaceStore,
  accounts,
  commitConversationData,
  isConversationVisibleToMember,
  isDeveloperSupportConversation,
  notify,
  events,
  clock = () => new Date(),
  // 외부 게스트·프로젝트 채널. 주입되지 않으면(옛 호출자) 게스트가 없는 것으로 동작한다.
  guestGrantOf = () => null,
  projectSpacesOf = () => [],
  projectRoleOf = () => null,
}) {
  const conversationsOf = (tenantId) => {
    const record = workspaceStore.tenants[tenantId]?.[CONVERSATIONS_KEY]
    return Array.isArray(record?.data) ? record.data : []
  }

  // 초대할 수 있는 사람. 비활성(퇴사) 계정은 새로 부르지 않는다 —
  // 이미 있는 방의 기록은 그대로 두되 새 방에 넣지는 않는다.
  const tenantAccounts = (tenantId) => accounts.filter((account) => account.tenantId === tenantId
    && account.approved && account.approvalStatus !== 'inactive')

  /**
   * 게스트가 이 방에 들어올 수 있는가 — 방이 프로젝트 채널(projectId)이고 그 프로젝트가 게스트의 초대 범위 안일 때만.
   * projectId 없는 일반 그룹방·팀방에 게스트를 넣으면 회사 내부 대화가 외부로 열린다.
   */
  const guestOutsideProject = (roster, invitedIds, projectId) => invitedIds.some((id) => {
    const account = roster.find((candidate) => candidate.id === id)
    if (account?.role !== 'tenant-guest') return false
    const grant = guestGrantOf(id)
    return !projectId || !grant || grant.status !== 'active' && grant.status !== 'invited' || !(grant.projectIds ?? []).includes(projectId)
  })
  const GUEST_OUTSIDE_PROJECT = { code: 'GUEST_OUTSIDE_PROJECT', message: '외부 게스트는 초대된 프로젝트의 채널(projectId가 있는 방)에만 참여할 수 있습니다.' }

  /** 방을 찾고 볼 수 있는지까지 확인한다. 못 찾은 것과 못 보는 것을 응답에서 구분하지 않는다. */
  const locate = (request, response) => {
    const conversations = conversationsOf(request.auth.tenantId)
    const conversation = conversations.find((item) => item?.id === request.params.id)
    if (!conversation || !isConversationVisibleToMember(conversation, request.auth, accounts)) {
      response.status(404).json({ error: { code: 'CONVERSATION_NOT_FOUND', message: '참여 중인 대화를 찾을 수 없습니다.' } })
      return null
    }
    if (isDeveloperSupportConversation(conversation)) {
      response.status(403).json({ error: { code: 'SYSTEM_CONVERSATION_IMMUTABLE', message: '개발운영진 지원 채널은 이 기능을 쓸 수 없습니다.' } })
      return null
    }
    return { conversations, conversation }
  }

  const save = async (request, response, conversations, next, failureCode) => {
    try {
      await commitConversationData(request.auth.tenantId, conversations.map((item) => (item.id === next.id ? next : item)), request.auth.id)
    } catch {
      response.status(500).json({ error: { code: failureCode, message: '변경 내용을 저장하지 못했습니다. 다시 시도해 주세요.' } })
      return false
    }
    events?.publish?.(request.auth.tenantId, 'message', { key: CONVERSATIONS_KEY, conversationId: next.id })
    return true
  }

  // ── 그룹방 만들기 ────────────────────────────────────────────────
  // 인원 상한을 두지 않는다. 테넌트 전원이 들어오는 공지방이 정상적인 쓰임이다.
  app.post('/api/messenger/conversations/group', requireAuth, requireMatchingWorkspaceIdentity, async (request, response) => {
    const name = text(request.body?.name, MAX_NAME)
    if (!name) {
      response.status(400).json({ error: { code: 'INVALID_ROOM_NAME', message: '방 이름을 입력해 주세요.' } })
      return
    }
    const roster = tenantAccounts(request.auth.tenantId)
    const requested = Array.isArray(request.body?.participantIds) ? request.body.participantIds : []
    const invited = requested.filter((id) => roster.some((account) => account.id === id))
    if (invited.length !== requested.length) {
      response.status(400).json({ error: { code: 'INVALID_PARTICIPANT', message: '같은 회사 구성원만 초대할 수 있습니다.' } })
      return
    }
    // 프로젝트 채널: projectId를 주면 그 프로젝트의 owner/editor만 만들 수 있고, 참여자는 프로젝트 멤버 안에서만 고른다.
    // 게스트는 이런 방에만 들어올 수 있다.
    const projectId = text(request.body?.projectId, 80)
    let project = null
    if (projectId) {
      project = projectSpacesOf(request.auth.tenantId).find((item) => item?.id === projectId) ?? null
      if (!project) {
        response.status(400).json({ error: { code: 'INVALID_PROJECT', message: '프로젝트를 찾을 수 없습니다.' } })
        return
      }
      if (!['owner', 'editor'].includes(projectRoleOf(project, request.auth))) {
        response.status(403).json({ error: { code: 'PROJECT_EDITOR_REQUIRED', message: '프로젝트 채널은 그 프로젝트의 소유자 또는 편집자만 만들 수 있습니다.' } })
        return
      }
      const memberIds = new Set([project.ownerId, ...(project.members ?? []).map((member) => member?.id)].filter(Boolean))
      if (invited.some((id) => !memberIds.has(id))) {
        response.status(400).json({ error: { code: 'INVALID_PARTICIPANT', message: '프로젝트 채널에는 그 프로젝트 멤버만 초대할 수 있습니다.' } })
        return
      }
    }
    if (guestOutsideProject(roster, invited, projectId)) {
      response.status(400).json({ error: GUEST_OUTSIDE_PROJECT })
      return
    }
    const participantIds = Array.from(new Set([request.auth.id, ...invited]))
    const createdAt = nowIso()
    const conversation = {
      id: newId('grp'),
      type: 'team',
      kind: 'group',
      name,
      subtitle: `${participantIds.length}명`,
      unread: 0,
      lastMessage: '',
      lastTime: seoulTime(createdAt),
      messages: [],
      participantIds,
      ownerId: request.auth.id,
      createdBy: request.auth.id,
      createdAt,
      ...(projectId ? { projectId } : {}),
      ...(text(request.body?.icon, MAX_ICON) ? { icon: text(request.body.icon, MAX_ICON) } : {}),
    }
    const conversations = conversationsOf(request.auth.tenantId)
    try {
      await commitConversationData(request.auth.tenantId, [...conversations, conversation], request.auth.id)
    } catch {
      response.status(500).json({ error: { code: 'MESSENGER_ROOM_CREATE_FAILED', message: '대화방을 만들지 못했습니다.' } })
      return
    }
    notify?.(request.auth.tenantId, participantIds.filter((id) => id !== request.auth.id).map((id) => ({
      type: 'mention', recipientId: id, actorId: request.auth.id,
      title: `새 대화방: ${name}`,
      body: `${request.auth.name}님이 초대했습니다.`,
      page: 'messenger', focusId: conversation.id,
      source: { kind: 'conversation', id: conversation.id, label: '대화방' },
    })))
    events?.publish?.(request.auth.tenantId, 'message', { key: CONVERSATIONS_KEY, conversationId: conversation.id })
    response.status(201).json({ conversation })
  })

  // ── 이름·아이콘 바꾸기 ───────────────────────────────────────────
  app.patch('/api/messenger/conversations/:id', requireAuth, requireMatchingWorkspaceIdentity, async (request, response) => {
    const found = locate(request, response)
    if (!found) return
    const { conversations, conversation } = found
    if (!isGroupRoom(conversation)) {
      response.status(403).json({ error: { code: 'ROOM_NOT_EDITABLE', message: '자유 생성 그룹방만 이름을 바꿀 수 있습니다.' } })
      return
    }
    if (!canManageRoom(conversation, request.auth)) {
      response.status(403).json({ error: { code: 'ROOM_MANAGE_FORBIDDEN', message: '방장 또는 회사 관리자만 바꿀 수 있습니다.' } })
      return
    }
    const name = request.body?.name === undefined ? conversation.name : text(request.body.name, MAX_NAME)
    if (!name) {
      response.status(400).json({ error: { code: 'INVALID_ROOM_NAME', message: '방 이름을 입력해 주세요.' } })
      return
    }
    const icon = request.body?.icon === undefined ? conversation.icon : text(request.body.icon, MAX_ICON)
    const next = stripUndefined({ ...conversation, name, icon: icon || undefined })
    if (await save(request, response, conversations, next, 'MESSENGER_ROOM_UPDATE_FAILED')) response.json({ conversation: next })
  })

  // ── 초대 ────────────────────────────────────────────────────────
  app.post('/api/messenger/conversations/:id/participants', requireAuth, requireMatchingWorkspaceIdentity, async (request, response) => {
    const found = locate(request, response)
    if (!found) return
    const { conversations, conversation } = found
    if (!isGroupRoom(conversation)) {
      response.status(403).json({ error: { code: 'ROOM_NOT_EDITABLE', message: '자유 생성 그룹방만 초대할 수 있습니다.' } })
      return
    }
    if (roomRole(conversation, request.auth) === 'none') {
      response.status(403).json({ error: { code: 'ROOM_MANAGE_FORBIDDEN', message: '참여 중인 방에만 초대할 수 있습니다.' } })
      return
    }
    const roster = tenantAccounts(request.auth.tenantId)
    const requested = Array.isArray(request.body?.participantIds) ? request.body.participantIds : []
    const invited = requested.filter((id) => roster.some((account) => account.id === id))
    if (!invited.length || invited.length !== requested.length) {
      response.status(400).json({ error: { code: 'INVALID_PARTICIPANT', message: '같은 회사 구성원만 초대할 수 있습니다.' } })
      return
    }
    if (guestOutsideProject(roster, invited, conversation.projectId)) {
      response.status(400).json({ error: GUEST_OUTSIDE_PROJECT })
      return
    }
    const participantIds = Array.from(new Set([...(conversation.participantIds ?? []), ...invited]))
    // 나갔던 사람을 다시 부르면 숨김도 함께 푼다. 아니면 초대해도 목록에 안 보인다.
    const hiddenFor = (conversation.hiddenFor ?? []).filter((id) => !invited.includes(id))
    const next = stripUndefined({
      ...conversation,
      participantIds,
      hiddenFor: hiddenFor.length ? hiddenFor : undefined,
      subtitle: `${participantIds.length}명`,
    })
    if (!(await save(request, response, conversations, next, 'MESSENGER_ROOM_INVITE_FAILED'))) return
    notify?.(request.auth.tenantId, invited.map((id) => ({
      type: 'mention', recipientId: id, actorId: request.auth.id,
      title: `대화방 초대: ${conversation.name}`,
      body: `${request.auth.name}님이 초대했습니다.`,
      page: 'messenger', focusId: conversation.id,
      source: { kind: 'conversation', id: conversation.id, label: '대화방' },
    })))
    response.json({ conversation: next })
  })

  // ── 내보내기 ────────────────────────────────────────────────────
  app.delete('/api/messenger/conversations/:id/participants/:accountId', requireAuth, requireMatchingWorkspaceIdentity, async (request, response) => {
    const found = locate(request, response)
    if (!found) return
    const { conversations, conversation } = found
    if (!isGroupRoom(conversation) || !canManageRoom(conversation, request.auth)) {
      response.status(403).json({ error: { code: 'ROOM_MANAGE_FORBIDDEN', message: '방장 또는 회사 관리자만 내보낼 수 있습니다.' } })
      return
    }
    const target = String(request.params.accountId ?? '')
    if (target === conversation.ownerId) {
      response.status(409).json({ error: { code: 'OWNER_CANNOT_BE_REMOVED', message: '방장은 내보낼 수 없습니다. 먼저 방장을 위임해 주세요.' } })
      return
    }
    const participantIds = (conversation.participantIds ?? []).filter((id) => id !== target)
    const next = { ...conversation, participantIds, subtitle: `${participantIds.length}명` }
    if (await save(request, response, conversations, next, 'MESSENGER_ROOM_REMOVE_FAILED')) response.json({ conversation: next })
  })

  // ── 방장 위임 ───────────────────────────────────────────────────
  app.post('/api/messenger/conversations/:id/owner', requireAuth, requireMatchingWorkspaceIdentity, async (request, response) => {
    const found = locate(request, response)
    if (!found) return
    const { conversations, conversation } = found
    if (!isGroupRoom(conversation) || !canManageRoom(conversation, request.auth)) {
      response.status(403).json({ error: { code: 'ROOM_MANAGE_FORBIDDEN', message: '방장 또는 회사 관리자만 위임할 수 있습니다.' } })
      return
    }
    const target = String(request.body?.ownerId ?? '')
    if (!(conversation.participantIds ?? []).includes(target)) {
      response.status(400).json({ error: { code: 'INVALID_OWNER', message: '방에 참여 중인 사람에게만 위임할 수 있습니다.' } })
      return
    }
    const next = { ...conversation, ownerId: target }
    if (!(await save(request, response, conversations, next, 'MESSENGER_ROOM_OWNER_FAILED'))) return
    notify?.(request.auth.tenantId, [{
      type: 'mention', recipientId: target, actorId: request.auth.id,
      title: `방장이 되었습니다: ${conversation.name}`,
      body: `${request.auth.name}님이 방장을 위임했습니다.`,
      page: 'messenger', focusId: conversation.id,
      source: { kind: 'conversation', id: conversation.id, label: '대화방' },
    }])
    response.json({ conversation: next })
  })

  // ── 방별 알림 조절 (I절과 함께 쓰는 자리) ────────────────────────
  app.post('/api/messenger/conversations/:id/mute', requireAuth, requireMatchingWorkspaceIdentity, async (request, response) => {
    const found = locate(request, response)
    if (!found) return
    const { conversations, conversation } = found
    const muted = request.body?.muted === true
    const mutedFor = muted
      ? Array.from(new Set([...(conversation.mutedFor ?? []), request.auth.id]))
      : (conversation.mutedFor ?? []).filter((id) => id !== request.auth.id)
    const next = stripUndefined({ ...conversation, mutedFor: mutedFor.length ? mutedFor : undefined })
    if (await save(request, response, conversations, next, 'MESSENGER_ROOM_MUTE_FAILED')) response.json({ muted, conversationId: next.id })
  })

  // ── 메시지 수정 ─────────────────────────────────────────────────
  // 작성자 본인만. 관리자도 남의 말을 고칠 수는 없다 — 고칠 수 있으면 기록이 아니다.
  app.patch('/api/messenger/conversations/:id/messages/:messageId', requireAuth, requireMatchingWorkspaceIdentity, async (request, response) => {
    const found = locate(request, response)
    if (!found) return
    const { conversations, conversation } = found
    const body = String(request.body?.text ?? '').trim()
    if (!body || body.length > 4_000) {
      response.status(400).json({ error: { code: 'INVALID_MESSAGE', message: '메시지는 1자 이상 4,000자 이하로 입력해 주세요.' } })
      return
    }
    const target = conversation.messages.find((message) => message?.id === request.params.messageId)
    if (!target) {
      response.status(404).json({ error: { code: 'MESSAGE_NOT_FOUND', message: '메시지를 찾을 수 없습니다.' } })
      return
    }
    if (target.senderId !== request.auth.id) {
      response.status(403).json({ error: { code: 'MESSAGE_EDIT_FORBIDDEN', message: '본인이 보낸 메시지만 수정할 수 있습니다.' } })
      return
    }
    if (target.deletedAt) {
      response.status(409).json({ error: { code: 'MESSAGE_DELETED', message: '삭제된 메시지는 수정할 수 없습니다.' } })
      return
    }
    const at = clock().toISOString()
    const edited = { ...target, text: body, editedAt: at }
    const messages = conversation.messages.map((message) => (message.id === edited.id ? edited : message))
    const isLast = conversation.messages[conversation.messages.length - 1]?.id === edited.id
    const next = { ...conversation, messages, ...(isLast ? { lastMessage: body } : {}) }
    if (await save(request, response, conversations, next, 'MESSENGER_MESSAGE_EDIT_FAILED')) response.json({ message: edited })
  })

  // ── 메시지 삭제 (흔적 남김) ─────────────────────────────────────
  app.delete('/api/messenger/conversations/:id/messages/:messageId', requireAuth, requireMatchingWorkspaceIdentity, async (request, response) => {
    const found = locate(request, response)
    if (!found) return
    const { conversations, conversation } = found
    const target = conversation.messages.find((message) => message?.id === request.params.messageId)
    if (!target) {
      response.status(404).json({ error: { code: 'MESSAGE_NOT_FOUND', message: '메시지를 찾을 수 없습니다.' } })
      return
    }
    // 남의 말은 방장·관리자도 지울 수 있다. 공개 대화에는 치워야 할 것이 생기기 때문이다.
    if (target.senderId !== request.auth.id && !canManageRoom(conversation, request.auth)) {
      response.status(403).json({ error: { code: 'MESSAGE_DELETE_FORBIDDEN', message: '본인 메시지이거나 방장·관리자여야 삭제할 수 있습니다.' } })
      return
    }
    if (target.deletedAt) {
      response.json({ message: target })
      return
    }
    const at = clock().toISOString()
    const removed = stripUndefined(tombstoneMessage(target, request.auth.id, at))
    const messages = conversation.messages.map((message) => (message.id === removed.id ? removed : message))
    const isLast = conversation.messages[conversation.messages.length - 1]?.id === removed.id
    const next = stripUndefined({
      ...conversation,
      messages,
      ...(isLast ? { lastMessage: '삭제된 메시지' } : {}),
      pinnedMessageIds: (conversation.pinnedMessageIds ?? []).filter((id) => id !== removed.id).length
        ? (conversation.pinnedMessageIds ?? []).filter((id) => id !== removed.id)
        : undefined,
    })
    if (await save(request, response, conversations, next, 'MESSENGER_MESSAGE_DELETE_FAILED')) response.json({ message: removed })
  })

  // ── 이모지 반응 (누르면 켜지고 다시 누르면 꺼진다) ──────────────
  app.post('/api/messenger/conversations/:id/messages/:messageId/reactions', requireAuth, requireMatchingWorkspaceIdentity, async (request, response) => {
    const found = locate(request, response)
    if (!found) return
    const { conversations, conversation } = found
    const emoji = String(request.body?.emoji ?? '').trim()
    if (!isSingleEmoji(emoji)) {
      response.status(400).json({ error: { code: 'INVALID_REACTION', message: '반응은 이모지 하나만 쓸 수 있습니다.' } })
      return
    }
    const target = conversation.messages.find((message) => message?.id === request.params.messageId)
    if (!target || target.deletedAt) {
      response.status(404).json({ error: { code: 'MESSAGE_NOT_FOUND', message: '메시지를 찾을 수 없습니다.' } })
      return
    }
    const reactions = Array.isArray(target.reactions) ? target.reactions.map((row) => ({ ...row, by: [...(row.by ?? [])] })) : []
    const existing = reactions.find((row) => row.emoji === emoji)
    if (existing) {
      existing.by = existing.by.includes(request.auth.id)
        ? existing.by.filter((id) => id !== request.auth.id)
        : [...existing.by, request.auth.id]
    } else {
      if (reactions.length >= MAX_REACTIONS_PER_MESSAGE) {
        response.status(409).json({ error: { code: 'TOO_MANY_REACTIONS', message: `한 메시지에는 반응을 ${MAX_REACTIONS_PER_MESSAGE}종류까지 붙일 수 있습니다.` } })
        return
      }
      reactions.push({ emoji, by: [request.auth.id] })
    }
    const kept = reactions.filter((row) => row.by.length)
    const updated = stripUndefined({ ...target, reactions: kept.length ? kept : undefined })
    const next = { ...conversation, messages: conversation.messages.map((message) => (message.id === updated.id ? updated : message)) }
    if (await save(request, response, conversations, next, 'MESSENGER_REACTION_FAILED')) response.json({ message: updated })
  })

  // ── 고정(공지) ──────────────────────────────────────────────────
  app.post('/api/messenger/conversations/:id/messages/:messageId/pin', requireAuth, requireMatchingWorkspaceIdentity, async (request, response) => {
    const found = locate(request, response)
    if (!found) return
    const { conversations, conversation } = found
    const pin = request.body?.pinned !== false
    const target = conversation.messages.find((message) => message?.id === request.params.messageId)
    if (!target || target.deletedAt) {
      response.status(404).json({ error: { code: 'MESSAGE_NOT_FOUND', message: '메시지를 찾을 수 없습니다.' } })
      return
    }
    const current = conversation.pinnedMessageIds ?? []
    if (pin && current.length >= MAX_PINNED && !current.includes(target.id)) {
      response.status(409).json({ error: { code: 'TOO_MANY_PINNED', message: `고정은 ${MAX_PINNED}건까지 가능합니다. 먼저 하나를 풀어 주세요.` } })
      return
    }
    const pinnedMessageIds = pin
      ? Array.from(new Set([...current, target.id]))
      : current.filter((id) => id !== target.id)
    const next = stripUndefined({ ...conversation, pinnedMessageIds: pinnedMessageIds.length ? pinnedMessageIds : undefined })
    if (await save(request, response, conversations, next, 'MESSENGER_PIN_FAILED')) response.json({ pinned: pin, pinnedMessageIds })
  })

  // ── 방 안 검색 ──────────────────────────────────────────────────
  app.get('/api/messenger/conversations/:id/search', requireAuth, requireMatchingWorkspaceIdentity, (request, response) => {
    const found = locate(request, response)
    if (!found) return
    const query = String(request.query?.q ?? '').trim().toLowerCase()
    if (query.length < 2) {
      response.status(400).json({ error: { code: 'QUERY_TOO_SHORT', message: '두 글자 이상 입력해 주세요.' } })
      return
    }
    const matches = found.conversation.messages
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => !message.deletedAt && String(message.text ?? '').toLowerCase().includes(query))
      .slice(-100)
      .reverse()
      .map(({ message, index }) => ({
        id: message.id, index, text: message.text, senderName: message.senderName,
        time: message.time, createdAt: message.createdAt ?? '',
      }))
    response.json({ query, total: matches.length, matches })
  })

  // ── 메시지 페이지 (가상 스크롤이 위로 올라가며 받아 간다) ────────
  app.get('/api/messenger/conversations/:id/messages', requireAuth, requireMatchingWorkspaceIdentity, (request, response) => {
    const found = locate(request, response)
    if (!found) return
    const all = found.conversation.messages
    const limit = Math.min(Math.max(Number.parseInt(String(request.query?.limit ?? ''), 10) || MESSAGE_PAGE_SIZE, 1), 200)
    const beforeId = String(request.query?.before ?? '')
    const end = beforeId ? all.findIndex((message) => message?.id === beforeId) : all.length
    const stop = end < 0 ? all.length : end
    const start = Math.max(0, stop - limit)
    response.json({
      messages: all.slice(start, stop),
      hasMore: start > 0,
      total: all.length,
      readSummaries: Object.fromEntries(all.slice(start, stop).map((message) => [message.id, readSummary(message, found.conversation)])),
    })
  })
}

/**
 * AI 대화 히스토리.
 *
 * 지금까지 대화는 브라우저 안에만 있었다. 새로 고치면 사라지고, 어제 물어본 것을
 * 오늘 다시 물어야 했다. 대화를 서버에 두어 계정을 따라다니게 한다.
 *
 * 소유는 사람이다. 같은 회사 관리자도 남의 AI 대화는 보지 못한다 — 업무 대화방은
 * 감독 열람 대상이지만(R15-B), 개인이 AI에게 던진 질문은 1:1 개인 대화와 성격이
 * 같아서 같은 선을 긋는다.
 */

/** 대화가 무엇을 보고 있는가. 배지로 그대로 보여 준다. */
export const CONVERSATION_SCOPES = Object.freeze(['all', 'project', 'file'])
export const SCOPE_LABELS = Object.freeze({ all: '전체', project: '프로젝트', file: '파일' })

/** 지운 대화가 휴지통에 머무는 기간. */
export const TRASH_RETENTION_DAYS = 30

/**
 * 모델에 실어 보낼 컨텍스트 상한.
 *
 * 대화가 길어져도 매번 처음부터 다 보내면 비용이 대화 길이의 제곱으로 늘고,
 * 언젠가는 모델 한계에 부딪혀 통째로 실패한다. 상한을 넘으면 앞부분을 요약으로
 * 접고 최근 대화만 원문으로 보낸다.
 */
export const CONTEXT_TOKEN_BUDGET = 6_000
/** 요약으로 접기 전에 반드시 원문으로 남기는 최근 메시지 수. */
export const KEEP_RECENT_MESSAGES = 8
/** 한 대화에 쌓아 두는 메시지 상한. 넘으면 오래된 것부터 요약에 흡수된다. */
export const MAX_STORED_MESSAGES = 400
export const MAX_TITLE_LENGTH = 60
export const MAX_MESSAGE_LENGTH = 20_000

export const CONVERSATIONS_KEY = 'ai-conversations'

/**
 * 대략적인 토큰 수.
 *
 * 정확할 필요는 없다. 상한을 넘겼는지 판단하는 용도이고, 한국어는 글자당
 * 토큰이 영어보다 많아 넉넉하게 잡는 편이 안전하다. 한글은 글자당 1.5,
 * 나머지는 4글자당 1로 센다.
 */
export function estimateTokens(text) {
  const value = String(text ?? '')
  let hangul = 0
  for (const character of value) {
    const code = character.codePointAt(0)
    if (code >= 0xac00 && code <= 0xd7a3) hangul += 1
  }
  const rest = value.length - hangul
  return Math.ceil(hangul * 1.5 + rest / 4)
}

const GREETINGS = /^(안녕하세요|안녕|저기|혹시|잠깐|음|어|저기요)[,.\s]*/u

/**
 * 자동 제목.
 *
 * 첫 질문의 첫 문장을 쓴다. 모델에게 제목을 따로 물으면 돈과 시간이 들고,
 * 목록에서 대화를 알아보는 데는 사람이 실제로 쓴 말이 제일 낫다.
 */
export function autoTitle(text) {
  const cleaned = String(text ?? '').replace(/\s+/gu, ' ').trim().replace(GREETINGS, '')
  if (!cleaned) return '새 대화'
  const sentence = cleaned.split(/(?<=[.?!。？！])\s/u)[0] ?? cleaned
  const candidate = sentence.length <= MAX_TITLE_LENGTH ? sentence : `${sentence.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`
  return candidate.replace(/[?？]$/u, '') || '새 대화'
}

/** 새 대화 한 건. */
export function newConversation({ id, ownerId, tenantId, scope, now }) {
  return {
    id,
    ownerId,
    tenantId,
    title: '새 대화',
    titleSource: 'auto',
    pinned: false,
    scope: normalizeScope(scope),
    messages: [],
    summary: '',
    summarizedThrough: 0,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    promoted: [],
  }
}

export function normalizeScope(scope) {
  const kind = CONVERSATION_SCOPES.includes(scope?.kind) ? scope.kind : 'all'
  if (kind === 'all') return { kind: 'all', id: '', label: SCOPE_LABELS.all }
  return {
    kind,
    id: String(scope?.id ?? '').slice(0, 120),
    label: String(scope?.label ?? SCOPE_LABELS[kind]).slice(0, 80) || SCOPE_LABELS[kind],
  }
}

/**
 * 모델에 보낼 메시지를 상한 안에서 고른다.
 *
 * 뒤에서부터 담되 최근 몇 건은 상한과 무관하게 넣는다. 마지막 질문이 상한에
 * 걸려 빠지면 대화가 성립하지 않기 때문이다. 접힌 앞부분은 요약 한 줄로 대신한다.
 *
 * @returns {{ messages: object[], foldedCount: number, usedTokens: number, summaryUsed: boolean }}
 */
export function buildContext(conversation, budget = CONTEXT_TOKEN_BUDGET) {
  const all = Array.isArray(conversation?.messages) ? conversation.messages : []
  const summary = String(conversation?.summary ?? '').trim()
  const summaryTokens = summary ? estimateTokens(summary) + 16 : 0

  const chosen = []
  let used = summaryTokens
  for (let index = all.length - 1; index >= 0; index -= 1) {
    const message = all[index]
    const cost = estimateTokens(message.content)
    const mustKeep = all.length - index <= KEEP_RECENT_MESSAGES
    if (!mustKeep && used + cost > budget) break
    chosen.unshift(message)
    used += cost
  }

  const foldedCount = all.length - chosen.length
  const messages = []
  if (summary && foldedCount > 0) {
    messages.push({
      role: 'user',
      content: `[이 대화의 앞부분 ${foldedCount}건 요약]\n${summary}`,
    })
  }
  for (const message of chosen) messages.push({ role: message.role, content: message.content })
  return { messages, foldedCount, usedTokens: used, summaryUsed: Boolean(summary && foldedCount > 0) }
}

/**
 * 접을 메시지를 고른다.
 *
 * 상한을 넘겼을 때만, 최근 것을 남기고 앞부분을 넘긴다. 넘길 것이 없으면
 * null을 돌려주어 호출 쪽이 요약을 만들지 않게 한다.
 */
export function messagesToFold(conversation, budget = CONTEXT_TOKEN_BUDGET) {
  const all = Array.isArray(conversation?.messages) ? conversation.messages : []
  const total = all.reduce((sum, message) => sum + estimateTokens(message.content), 0)
  if (total <= budget && all.length <= MAX_STORED_MESSAGES) return null
  const foldable = all.slice(0, Math.max(0, all.length - KEEP_RECENT_MESSAGES))
  return foldable.length ? foldable : null
}

/**
 * 모델 없이 만드는 요약.
 *
 * 데모 모드이거나 요약 호출이 실패했을 때 쓴다. 지어내지 않고 실제 오간 말에서
 * 뽑기만 한다 — 요약이랍시고 없는 말을 넣으면 다음 대화가 그 위에서 굴러간다.
 */
export function extractiveSummary(messages) {
  const questions = messages.filter((message) => message.role === 'user').map((message) => message.content.replace(/\s+/gu, ' ').trim())
  const answers = messages.filter((message) => message.role === 'assistant').map((message) => message.content.replace(/\s+/gu, ' ').trim())
  const lines = []
  if (questions.length) lines.push(`물어본 것: ${questions.slice(0, 5).map((text) => text.slice(0, 80)).join(' / ')}`)
  if (answers.length) lines.push(`마지막 답: ${answers[answers.length - 1].slice(0, 300)}`)
  lines.push(`(앞부분 ${messages.length}건을 이렇게 접었습니다. 원문은 대화에 그대로 남아 있습니다.)`)
  return lines.join('\n')
}

/**
 * 전문 검색.
 *
 * 제목과 본문을 함께 본다. 검색어를 공백으로 끊어 전부 들어 있는 대화만
 * 남긴다 — 하나라도 걸리면 되는 방식은 흔한 낱말 하나에 목록이 다 나온다.
 */
export function searchConversations(conversations, query) {
  const terms = String(query ?? '').toLowerCase().split(/\s+/u).filter(Boolean)
  // 검색어가 없어도 모양은 같게 돌려준다. 호출하는 쪽이 두 가지 모양을 다루게 하면
  // 검색하지 않은 목록에서만 터지는 길이 생긴다.
  if (terms.length === 0) return conversations.map((conversation) => ({ conversation, excerpt: '' }))
  return conversations
    .map((conversation) => {
      const haystack = [conversation.title, conversation.summary, ...(conversation.messages ?? []).map((message) => message.content)]
        .join('\n')
        .toLowerCase()
      if (!terms.every((term) => haystack.includes(term))) return null
      // 어디서 걸렸는지 한 줄 보여 준다. 제목만 나열하면 왜 나왔는지 알 수 없다.
      const hit = (conversation.messages ?? []).find((message) => message.content.toLowerCase().includes(terms[0]))
      return { conversation, excerpt: hit ? excerptAround(hit.content, terms[0]) : '' }
    })
    .filter(Boolean)
}

function excerptAround(content, term) {
  const flat = content.replace(/\s+/gu, ' ')
  const at = flat.toLowerCase().indexOf(term)
  if (at < 0) return flat.slice(0, 120)
  const start = Math.max(0, at - 40)
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + 140)}${start + 140 < flat.length ? '…' : ''}`
}

/** 목록 정렬: 고정 먼저, 그다음 최근 순. */
export function sortConversations(conversations) {
  return [...conversations].sort((left, right) => {
    if (Boolean(left.pinned) !== Boolean(right.pinned)) return left.pinned ? -1 : 1
    return String(right.updatedAt).localeCompare(String(left.updatedAt))
  })
}

/** 목록에 실어 보낼 요약 형태. 본문 전체를 목록마다 보낼 이유가 없다. */
export function toListItem(conversation, excerpt = '') {
  const last = conversation.messages?.[conversation.messages.length - 1]
  return {
    id: conversation.id,
    title: conversation.title,
    titleSource: conversation.titleSource,
    pinned: Boolean(conversation.pinned),
    scope: conversation.scope,
    messageCount: conversation.messages?.length ?? 0,
    preview: last ? last.content.replace(/\s+/gu, ' ').slice(0, 120) : '',
    excerpt,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    deletedAt: conversation.deletedAt ?? null,
    promotedCount: conversation.promoted?.length ?? 0,
  }
}

/** 휴지통에서 완전히 사라질 때까지 남은 날. */
export function daysLeftInTrash(conversation, now = new Date()) {
  if (!conversation?.deletedAt) return null
  const elapsed = (now.getTime() - new Date(conversation.deletedAt).getTime()) / 86_400_000
  return Math.max(0, Math.ceil(TRASH_RETENTION_DAYS - elapsed))
}

export function expiredTrash(conversations, now = new Date()) {
  return conversations.filter((conversation) => conversation.deletedAt && daysLeftInTrash(conversation, now) === 0)
}

export function registerAiConversationRoutes({
  app,
  requireAuth,
  requireMatchingWorkspaceIdentity,
  workspaceStore,
  commitWorkspaceStore,
  createTaskFromConclusion,
  createDecisionFromConclusion,
  createDocumentFromConclusion,
  clock = () => new Date(),
}) {
  const listOf = (tenantId) => {
    const record = workspaceStore.tenants[tenantId]?.[CONVERSATIONS_KEY]
    return Array.isArray(record?.data) ? record.data : []
  }

  const save = async (tenantId, conversations, actorId) => {
    const tenantStore = workspaceStore.tenants[tenantId] ?? {}
    const previous = tenantStore[CONVERSATIONS_KEY]
    tenantStore[CONVERSATIONS_KEY] = { data: conversations, updatedAt: clock().toISOString(), updatedBy: actorId }
    workspaceStore.tenants[tenantId] = tenantStore
    try {
      await commitWorkspaceStore()
      return true
    } catch {
      if (previous) tenantStore[CONVERSATIONS_KEY] = previous
      else delete tenantStore[CONVERSATIONS_KEY]
      return false
    }
  }

  /** 내 것이 아니면 있는지조차 알려 주지 않는다. */
  const findOwn = (request) => {
    const conversations = listOf(request.auth.tenantId)
    const conversation = conversations.find((item) => item.id === request.params.id && item.ownerId === request.auth.id)
    return { conversations, conversation }
  }

  const requireTenant = (request, response) => {
    if (request.auth.tenantId) return true
    response.status(403).json({ error: { code: 'TENANT_REQUIRED', message: '고객사 워크스페이스에서만 사용할 수 있습니다.' } })
    return false
  }

  app.get('/api/ai/conversations', requireAuth, requireMatchingWorkspaceIdentity, (request, response) => {
    if (!requireTenant(request, response)) return
    const now = clock()
    const mine = listOf(request.auth.tenantId).filter((item) => item.ownerId === request.auth.id)
    const trashed = String(request.query.trash ?? '') === '1'
    const scoped = mine.filter((item) => Boolean(item.deletedAt) === trashed)
    const matches = searchConversations(scoped, request.query.q)
    const items = sortConversations(matches.map(({ conversation }) => conversation))
      .map((conversation) => {
        const excerpt = matches.find((match) => match.conversation.id === conversation.id)?.excerpt ?? ''
        return { ...toListItem(conversation, excerpt), daysLeft: daysLeftInTrash(conversation, now) }
      })
    response.json({ conversations: items, trashCount: mine.filter((item) => item.deletedAt).length })
  })

  app.get('/api/ai/conversations/:id', requireAuth, requireMatchingWorkspaceIdentity, (request, response) => {
    if (!requireTenant(request, response)) return
    const { conversation } = findOwn(request)
    if (!conversation) { response.status(404).json({ error: { code: 'CONVERSATION_NOT_FOUND', message: '대화를 찾을 수 없습니다.' } }); return }
    response.json({ conversation: { ...conversation, daysLeft: daysLeftInTrash(conversation, clock()) } })
  })

  app.post('/api/ai/conversations', requireAuth, requireMatchingWorkspaceIdentity, async (request, response) => {
    if (!requireTenant(request, response)) return
    const now = clock().toISOString()
    const conversation = newConversation({
      id: `AIC-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      ownerId: request.auth.id,
      tenantId: request.auth.tenantId,
      scope: request.body?.scope,
      now,
    })
    const conversations = [conversation, ...listOf(request.auth.tenantId)]
    if (!await save(request.auth.tenantId, conversations, request.auth.id)) {
      response.status(500).json({ error: { code: 'CONVERSATION_WRITE_FAILED', message: '대화를 만들지 못했습니다.' } })
      return
    }
    response.status(201).json({ conversation })
  })

  app.patch('/api/ai/conversations/:id', requireAuth, requireMatchingWorkspaceIdentity, async (request, response) => {
    if (!requireTenant(request, response)) return
    const { conversations, conversation } = findOwn(request)
    if (!conversation) { response.status(404).json({ error: { code: 'CONVERSATION_NOT_FOUND', message: '대화를 찾을 수 없습니다.' } }); return }

    const next = { ...conversation }
    if (typeof request.body?.title === 'string') {
      const title = request.body.title.trim().slice(0, MAX_TITLE_LENGTH)
      if (!title) { response.status(400).json({ error: { code: 'TITLE_REQUIRED', message: '제목을 입력해 주세요.' } }); return }
      next.title = title
      // 손으로 고친 제목은 다음 질문 때 자동 제목이 덮어쓰지 않는다.
      next.titleSource = 'manual'
    }
    if (typeof request.body?.pinned === 'boolean') next.pinned = request.body.pinned
    if (request.body?.scope) next.scope = normalizeScope(request.body.scope)
    next.updatedAt = clock().toISOString()

    const updated = conversations.map((item) => (item.id === next.id ? next : item))
    if (!await save(request.auth.tenantId, updated, request.auth.id)) {
      response.status(500).json({ error: { code: 'CONVERSATION_WRITE_FAILED', message: '대화를 고치지 못했습니다.' } })
      return
    }
    response.json({ conversation: next })
  })

  /** 지우기는 휴지통으로. 30일 뒤 사라진다. */
  app.delete('/api/ai/conversations/:id', requireAuth, requireMatchingWorkspaceIdentity, async (request, response) => {
    if (!requireTenant(request, response)) return
    const { conversations, conversation } = findOwn(request)
    if (!conversation) { response.status(404).json({ error: { code: 'CONVERSATION_NOT_FOUND', message: '대화를 찾을 수 없습니다.' } }); return }

    const purge = String(request.query.purge ?? '') === '1'
    const updated = purge && conversation.deletedAt
      ? conversations.filter((item) => item.id !== conversation.id)
      : conversations.map((item) => (item.id === conversation.id ? { ...item, deletedAt: clock().toISOString(), pinned: false } : item))
    if (!await save(request.auth.tenantId, updated, request.auth.id)) {
      response.status(500).json({ error: { code: 'CONVERSATION_WRITE_FAILED', message: '대화를 지우지 못했습니다.' } })
      return
    }
    response.json({ ok: true, purged: purge, retentionDays: TRASH_RETENTION_DAYS })
  })

  app.post('/api/ai/conversations/:id/restore', requireAuth, requireMatchingWorkspaceIdentity, async (request, response) => {
    if (!requireTenant(request, response)) return
    const { conversations, conversation } = findOwn(request)
    if (!conversation?.deletedAt) { response.status(404).json({ error: { code: 'CONVERSATION_NOT_FOUND', message: '휴지통에서 찾을 수 없습니다.' } }); return }
    const updated = conversations.map((item) => (item.id === conversation.id ? { ...item, deletedAt: null, updatedAt: clock().toISOString() } : item))
    if (!await save(request.auth.tenantId, updated, request.auth.id)) {
      response.status(500).json({ error: { code: 'CONVERSATION_WRITE_FAILED', message: '되살리지 못했습니다.' } })
      return
    }
    response.json({ ok: true })
  })

  /**
   * 결론을 업무·결정·자료로 올린다.
   *
   * 대화에서 나온 답이 대화 안에만 남으면 아무 일도 일어나지 않는다. 어느
   * 메시지를 무엇으로 올렸는지는 대화에 기록해 두어, 같은 결론을 두 번 올리지
   * 않게 한다.
   */
  app.post('/api/ai/conversations/:id/promote', requireAuth, requireMatchingWorkspaceIdentity, async (request, response) => {
    if (!requireTenant(request, response)) return
    const { conversations, conversation } = findOwn(request)
    if (!conversation) { response.status(404).json({ error: { code: 'CONVERSATION_NOT_FOUND', message: '대화를 찾을 수 없습니다.' } }); return }

    const messageId = String(request.body?.messageId ?? '')
    const message = conversation.messages.find((item) => item.id === messageId && item.role === 'assistant')
    if (!message) { response.status(404).json({ error: { code: 'MESSAGE_NOT_FOUND', message: '올릴 답을 찾을 수 없습니다.' } }); return }

    const kind = String(request.body?.kind ?? '')
    const makers = { task: createTaskFromConclusion, decision: createDecisionFromConclusion, document: createDocumentFromConclusion }
    const make = makers[kind]
    if (typeof make !== 'function') {
      response.status(400).json({ error: { code: 'UNSUPPORTED_PROMOTION', message: '업무·결정·자료 중에서 골라 주세요.' } })
      return
    }

    let created
    try {
      created = await make({
        auth: request.auth,
        conversation,
        message,
        title: String(request.body?.title ?? '').trim(),
      })
    } catch (error) {
      response.status(500).json({ error: { code: 'PROMOTION_FAILED', message: error?.message || '올리지 못했습니다.' } })
      return
    }

    const stamp = { kind, messageId, refId: created?.id ?? '', label: created?.label ?? '', at: clock().toISOString() }
    const updated = conversations.map((item) => (item.id === conversation.id
      ? { ...item, promoted: [...(item.promoted ?? []), stamp], updatedAt: stamp.at }
      : item))
    await save(request.auth.tenantId, updated, request.auth.id)
    response.status(201).json({ promoted: stamp, created })
  })

  /** 만료된 휴지통 비우기. 스케줄러가 부른다. */
  return async function sweepConversationTrash(at) {
    const now = at ?? clock()
    let removed = 0
    for (const [tenantId, tenantStore] of Object.entries(workspaceStore.tenants ?? {})) {
      const conversations = Array.isArray(tenantStore?.[CONVERSATIONS_KEY]?.data) ? tenantStore[CONVERSATIONS_KEY].data : []
      const expired = expiredTrash(conversations, now)
      if (expired.length === 0) continue
      const kept = conversations.filter((item) => !expired.includes(item))
      removed += expired.length
      await save(tenantId, kept, 'system:trash-sweep')
    }
    return { removed }
  }
}

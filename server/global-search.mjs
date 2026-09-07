/**
 * 전역 검색.
 *
 * 지금까지 위쪽 검색창은 화면이 이미 들고 있던 것(제품·업무)만 뒤졌다. 정작
 * 사람들이 찾는 것 — 지난주 회의록, 누가 올린 계약서, 그때 그 대화 — 은 걸리지
 * 않았고, 그래서 결국 메뉴를 하나씩 열어 보게 됐다.
 *
 * 검색을 서버로 옮긴 이유는 권한 때문이다. 문서는 공개 범위가 있고, 메신저는
 * 참여자만 볼 수 있고, AI 대화는 본인 것뿐이다. 이 규칙을 화면에서 다시 구현하면
 * 언젠가 한 곳이 어긋나 남의 것이 검색에 뜬다. 권한 판정을 하는 쪽에서 검색한다.
 */

import { NOTICES_KEY, noticeFocusId, noticeVisibleTo, readNotices } from './notices.mjs'
import { MAX_SEARCH_SCAN_DOCUMENTS, removeLinks } from './wiki-blocks.mjs'

/** 유형 하나에서 가져오는 최대 건수. 한 유형이 목록을 다 차지하지 않게 한다. */
export const PER_TYPE_LIMIT = 5
export const MIN_QUERY_LENGTH = 2

export const SEARCH_TYPES = Object.freeze([
  { id: 'task', label: '업무', page: 'tasks' },
  // R16-H: 문서(위키). id에 하이픈을 쓰지 않는다 — 아래 KIND_LABEL 동치 테스트의 파서가 `/^\s*([a-zA-Z_]+):/`라
  // `wiki-doc` 같은 id는 화면 사전에서 조용히 탈락한다.
  { id: 'wiki', label: '문서', page: 'wiki' },
  // 위키 배지와 나란히 서면 '문서' 두 개로는 갈래가 구별되지 않는다. 자료실 화면은 이미 전부 '자료'라고 쓴다.
  { id: 'document', label: '자료', page: 'documents' },
  { id: 'journal', label: '일지', page: 'journal' },
  { id: 'message', label: '메신저', page: 'ai' },
  { id: 'conversation', label: 'AI 대화', page: 'ai' },
  { id: 'opportunity', label: '기회', page: 'approvals' },
  { id: 'person', label: '인물', page: 'people' },
  { id: 'notice', label: '공지', page: 'messenger' },
])

/**
 * 검색어를 낱말로 끊는다.
 *
 * 전부 들어 있어야 걸린다. 하나만 걸려도 되는 방식은 "김 대리 견적"처럼 치면
 * 김씨가 나오는 모든 것이 쏟아진다.
 */
export function terms(query) {
  return String(query ?? '').toLowerCase().split(/\s+/u).filter(Boolean).slice(0, 6)
}

export function matches(haystack, words) {
  const text = String(haystack ?? '').toLowerCase()
  return words.every((word) => text.includes(word))
}

/** 걸린 자리를 한 줄로 보여 준다. 제목만 나열하면 왜 나왔는지 알 수 없다. */
export function excerpt(text, word, span = 120) {
  const flat = String(text ?? '').replace(/\s+/gu, ' ').trim()
  if (!word) return flat.slice(0, span)
  const at = flat.toLowerCase().indexOf(word)
  if (at < 0) return flat.slice(0, span)
  const start = Math.max(0, at - 30)
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + span)}${start + span < flat.length ? '…' : ''}`
}

/** 결과 항목의 유형 이름. SEARCH_TYPES의 id와 같은 낱말을 쓴다. */
export const SEARCH_KINDS = Object.freeze(SEARCH_TYPES.map((type) => type.id))

/**
 * 결과 항목 하나.
 *
 * 유형은 `kind`로 내려보낸다. 소비 측(화면·휴대폰·최근 연 항목 저장)이 `kind`를
 * 기준으로 묶고 배지를 그리기 때문이다. `type`은 한 릴리스 동안 같은 값으로 함께
 * 내려보낸다 — 이미 배포된 화면과 localStorage에 남은 "최근 연 항목"이 `type`을
 * 읽고 있어, 한꺼번에 끊으면 옛 화면에서 유형이 비어 보인다. 다음 릴리스에 `type`을 뺀다.
 */
function hit({ kind, id, title, meta, owner, page, focusId, snippet }) {
  // 유형이 비면 화면에서 '기타'로 떠서 눈에 띄긴 하지만, 서버에서 먼저 막는 게 맞다.
  if (!SEARCH_KINDS.includes(kind)) throw new Error(`알 수 없는 검색 유형: ${kind}`)
  return { kind, type: kind, id, title: String(title ?? '').slice(0, 160), meta: String(meta ?? '').slice(0, 120), owner: String(owner ?? '').slice(0, 60), page, focusId: focusId ?? id, snippet: String(snippet ?? '').slice(0, 160) }
}

/**
 * 한 테넌트 안에서 찾는다.
 *
 * 권한 판정 함수는 호출하는 쪽(app.mjs)에서 그대로 받는다. 여기서 다시 만들면
 * 규칙이 두 벌이 된다.
 */
export function searchTenant({ query, auth, tenantStore, accounts, canReadDocument, canReadWikiDocument, isConversationVisibleToMember, projectRoleOf }) {
  // 위키 인가는 기본값을 두지 않는다 — `() => true`로 두면 주입을 잊은 배포에서 검색만 조용히 열린다.
  if (typeof canReadWikiDocument !== 'function') throw new TypeError('searchTenant: canReadWikiDocument 판정을 주입해야 합니다.')
  const words = terms(query)
  if (words.length === 0 || query.trim().length < MIN_QUERY_LENGTH) return { groups: [], total: 0 }
  // 외부 게스트는 전역 검색이 없다. 사람 검색 한 갈래만으로도 직원 명단이 열거되기 때문이다. 게이트가 먼저 막지만 여기서도 끊는다.
  if (auth?.role === 'tenant-guest') return { groups: [], total: 0 }
  const first = words[0]
  const rows = (key) => (Array.isArray(tenantStore?.[key]?.data) ? tenantStore[key].data : [])
  const isAdmin = auth.role === 'tenant-admin'
  const found = new Map(SEARCH_TYPES.map((type) => [type.id, []]))
  const push = (type, item) => { const bucket = found.get(type); if (bucket.length < PER_TYPE_LIMIT) bucket.push(item) }

  // 업무 — 일반 직원은 자기가 맡았거나 자기가 지시한 것만 본다. 목록 화면과 같은 규칙이다.
  const workItems = rows('work-items')
  const workItemById = new Map(workItems.map((task) => [task?.id, task]))
  for (const task of workItems) {
    if (!isAdmin && task.ownerId !== auth.id && task.requesterId !== auth.id) continue
    // 매치 텍스트에 상위 제목은 넣지 않는다 — 자식이 많으면 PER_TYPE_LIMIT에서 상위가 밀린다. meta에만, 볼 수 있는 상위일 때만.
    if (!matches(`${task.title} ${task.description} ${task.owner} ${task.category} ${task.status} ${task.id}`, words)) continue
    const parent = task.parentId ? workItemById.get(task.parentId) : null
    const parentVisible = parent && (isAdmin || parent.ownerId === auth.id || parent.requesterId === auth.id)
    push('task', hit({
      kind: 'task', id: task.id, title: task.title,
      meta: `${task.status} · ${task.due ? String(task.due).slice(0, 10) : '기한 없음'}${parentVisible ? ` · 상위: ${parent.title}` : ''}`,
      owner: task.owner, page: 'tasks', focusId: task.id,
      snippet: excerpt(task.description, first),
    }))
  }

  // 문서(위키) — 본문을 색인하는 첫 갈래다. 매 질의마다 500문서 × 200KB를 훑지 않으려고 저장해 둔
  // 파생값 `searchText`를 읽고, 최근 수정순 상한(300)으로 한 질의의 최악 비용을 묶는다.
  // 스니펫은 색인값을 그대로 쓰지 않고 `removeLinks`를 한 번 더 지난다 — 색인을 만드는 자리(buildSearchText)가
  // 이미 토큰을 지우지만, 옛 형식으로 저장된 행 하나가 링크 라벨을 스니펫으로 흘리는 갈래를 여기서 닫는다.
  //
  // **권한 필터가 스캔 상한보다 앞에 온다.** 뒤에 두면 내가 못 보는 문서가 더 최근이라는 이유만으로
  // 상한 300칸을 다 먹고, 같은 질의가 문서 목록(`GET /api/wiki?q=`)에서는 걸리는데 전역 검색에서만
  // 통째로 사라진다. 권한 판정은 프로젝트 조회 한 번이라 본문(`searchText`) 스캔보다 훨씬 싸므로
  // 최악 비용은 그대로고, 상한이 "내가 볼 수 있는 최근 300건"을 뜻하게 된다.
  const wikiDocuments = rows('wiki-documents')
    .filter((document) => document && !document.archivedAt && !document.isTemplate && canReadWikiDocument(document, auth))
    .sort((left, right) => String(right.lastEditedAt ?? '').localeCompare(String(left.lastEditedAt ?? '')))
    .slice(0, MAX_SEARCH_SCAN_DOCUMENTS)
  for (const document of wikiDocuments) {
    const indexed = removeLinks(document.searchText ?? '')
    // 요약도 색인과 같은 문을 지난다. 여기만 날 것으로 두면 프로젝트 문서를 전사로 옮기는 순간
    // 요약에 남은 라벨(볼 수 없는 대상의 제목)이 매칭 오라클이 되고 스니펫으로도 그대로 나간다.
    const summary = removeLinks(document.summary ?? '')
    if (!matches(`${document.title ?? ''} ${summary} ${indexed}`, words)) continue
    push('wiki', hit({
      kind: 'wiki', id: document.id, title: document.title || '제목 없는 문서',
      meta: `${(document.blocks ?? []).length}개 문단${document.lastEditedAt ? ` · ${String(document.lastEditedAt).slice(0, 10)}` : ''}`,
      owner: document.lastEditedByName, page: 'wiki', focusId: document.id,
      snippet: excerpt(summary ? `${summary} ${indexed}` : indexed, first),
    }))
  }

  // 자료 — 공개 범위를 그대로 따른다.
  for (const document of rows('company-documents')) {
    if (!canReadDocument(document, auth)) continue
    if (!matches(`${document.name} ${document.category} ${(document.tags ?? []).join(' ')} ${document.summary}`, words)) continue
    push('document', hit({
      kind: 'document', id: document.id, title: document.name,
      meta: `${document.category}${document.uploadedAt ? ` · ${String(document.uploadedAt).slice(0, 10)}` : ''}`,
      owner: document.uploadedByName, page: 'documents', focusId: document.id,
      snippet: excerpt(document.summary, first),
    }))
  }

  // 일지 — 쓴 사람과 관리자만. 결재자도 자기가 볼 일지는 결재 화면에서 본다.
  for (const journal of rows('daily-journals')) {
    if (!isAdmin && journal.authorId !== auth.id && journal.author !== auth.name) continue
    const body = [journal.title, journal.completed, journal.issue, journal.nextPlan, journal.feedback].filter(Boolean).join(' ')
    if (!matches(`${journal.author} ${journal.department} ${journal.date} ${body}`, words)) continue
    push('journal', hit({
      kind: 'journal', id: journal.id, title: journal.title || `${journal.date} 업무일지`,
      meta: `${journal.date} · ${journal.status ?? '작성됨'}`, owner: journal.author,
      page: 'journal', focusId: journal.id,
      snippet: excerpt(body, first),
    }))
  }

  // 메신저 — 내가 들어가 있는 방의 메시지만. 방 밖의 말은 검색으로도 새면 안 된다.
  for (const conversation of rows('messenger-conversations')) {
    if (!isConversationVisibleToMember(conversation, auth, accounts)) continue
    const roomName = conversation.name ?? ''
    for (const message of (conversation.messages ?? []).slice(-300).reverse()) {
      if (message?.deletedAt) continue
      if (!matches(`${message?.text ?? ''} ${message?.senderName ?? ''} ${roomName}`, words)) continue
      push('message', hit({
        kind: 'message', id: `${conversation.id}:${message.id}`, title: roomName || '대화',
        // 스레드 답글은 본채널에 없다. 어디 있는 말인지 적어 두지 않으면 눌러도 찾지 못한다.
        meta: `${message.createdAt ? String(message.createdAt).slice(0, 10) : String(message.time ?? '')}${message.threadRootId ? ' · 스레드' : ''}`,
        // 공지와 같은 focusId 규약('<방>:<종류>:<id>')을 쓴다. 방 id만 실으면 화면이 그것을 해석하지 못해
        // 결과를 눌러도 마지막으로 보던 방이 열린다 — 그 결손을 여기서 닫는다.
        owner: message.senderName, page: 'ai',
        focusId: message.threadRootId ? `${conversation.id}:thread:${message.threadRootId}` : `${conversation.id}:message:${message.id}`,
        snippet: excerpt(message.text, first),
      }))
      if (found.get('message').length >= PER_TYPE_LIMIT) break
    }
  }

  // AI 대화 — 본인 것만. 휴지통에 있는 것은 빼고.
  for (const conversation of rows('ai-conversations')) {
    if (conversation.ownerId !== auth.id || conversation.deletedAt) continue
    const body = [conversation.title, conversation.summary, ...(conversation.messages ?? []).map((message) => message.content)].join('\n')
    if (!matches(body, words)) continue
    push('conversation', hit({
      kind: 'conversation', id: conversation.id, title: conversation.title,
      meta: `${conversation.messages?.length ?? 0}개 · ${String(conversation.updatedAt ?? '').slice(0, 10)}`,
      owner: auth.name, page: 'ai', focusId: conversation.id,
      snippet: excerpt(body, first),
    }))
  }

  // 기회 — 회사 전체가 본다.
  for (const opportunity of rows('opportunities')) {
    if (!matches(`${opportunity.title} ${opportunity.agency} ${opportunity.source} ${opportunity.noticeNo} ${opportunity.rationale}`, words)) continue
    push('opportunity', hit({
      kind: 'opportunity', id: opportunity.id, title: opportunity.title,
      meta: `${opportunity.agency ?? opportunity.source ?? ''}${opportunity.deadline ? ` · ~${String(opportunity.deadline).slice(0, 10)}` : ''}`,
      owner: opportunity.source ?? '외부', page: 'approvals', focusId: opportunity.id,
      snippet: excerpt(opportunity.rationale, first),
    }))
  }

  // 인물 — 같은 회사 사람. 퇴사 처리된 계정도 이름은 찾을 수 있어야 지난 기록을 되짚는다.
  for (const person of accounts) {
    if (person.tenantId !== auth.tenantId) continue
    if (!matches(`${person.name} ${person.team} ${person.jobRole} ${person.email}`, words)) continue
    push('person', hit({
      kind: 'person', id: person.id, title: person.name,
      meta: [person.team, person.jobRole].filter(Boolean).join(' · ') || '소속 미지정',
      owner: person.approvalStatus === 'inactive' ? '비활성 계정' : '', page: 'people', focusId: person.id,
      snippet: person.email ?? '',
    }))
  }

  // 공지 — 가시성은 notices.mjs 한 곳에서 판정한다. 여기서 규칙을 다시 쓰면 목록과 검색이 어긋난다.
  // 행을 고르는 문도 같은 곳이다: readNotices가 거른 성한 행만 본다. 저장소 배열을 그대로 읽으면
  // 목록이 "형식이 깨져 다루지 않는다"고 판정한 행 위에서 scope·projectId를 믿고 권한을 판정하게 된다.
  const projects = rows('project-spaces')
  // deps 세 개를 그대로 채운다. 하나라도 빠지면 여기서만 판정이 느슨해져 목록과 검색이 어긋난다
  // (게스트는 위에서 이미 빈 결과이므로 conversationById는 지금 쓰이지 않지만, 시그니처가 한 벌이어야
  //  게스트 갈래가 열리는 날 검색만 조용히 옛 규칙으로 남지 않는다).
  const conversations = rows('messenger-conversations')
  const noticeDeps = {
    projectById: (id) => projects.find((item) => item?.id === id) ?? null,
    projectRoleOf,
    conversationById: (id) => conversations.find((item) => item?.id === id) ?? null,
  }
  for (const notice of readNotices(tenantStore?.[NOTICES_KEY]).rows) {
    if (!noticeVisibleTo(notice, auth, noticeDeps)) continue
    if (!matches(`${notice.title} ${notice.body} ${notice.authorName}`, words)) continue
    push('notice', hit({
      kind: 'notice', id: notice.id, title: notice.title,
      meta: `${notice.scope === 'company' ? '회사 공지' : '프로젝트 공지'}${notice.mustRead ? ' · 필독' : ''} · ${String(notice.createdAt).slice(0, 10)}${notice.archivedAt ? ' · 보관' : ''}`,
      owner: notice.authorName, page: 'messenger', focusId: noticeFocusId(notice),
      snippet: excerpt(notice.body, first),
    }))
  }

  const groups = SEARCH_TYPES
    // 그룹도 항목과 같은 이유로 `kind`와 `type`을 함께 내려보낸다(hit() 주석 참고).
    .map((type) => ({ kind: type.id, type: type.id, label: type.label, items: found.get(type.id) }))
    .filter((group) => group.items.length > 0)
  return { groups, total: groups.reduce((sum, group) => sum + group.items.length, 0) }
}

export function registerGlobalSearchRoute({ app, requireAuth, requireMatchingWorkspaceIdentity, workspaceStore, accounts, canReadDocument, canReadWikiDocument, isConversationVisibleToMember, projectRoleOf }) {
  app.get('/api/search', requireAuth, requireMatchingWorkspaceIdentity, (request, response) => {
    if (!request.auth.tenantId) { response.json({ groups: [], total: 0 }); return }
    const tenantStore = workspaceStore.tenants[request.auth.tenantId] ?? {}
    const result = searchTenant({
      query: String(request.query.q ?? ''),
      auth: request.auth,
      tenantStore,
      accounts,
      canReadDocument,
      canReadWikiDocument,
      isConversationVisibleToMember,
      projectRoleOf,
    })
    response.json(result)
  })
}

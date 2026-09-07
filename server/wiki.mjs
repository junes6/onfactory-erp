import { AI_LEVEL_LABELS, aiLevelLowered, aiLevelOf, aiMayList, aiMayReadBody, normalizeAiLevel } from './ai-policy.mjs'
import { GUEST_ROLE, guestWorkItemViolation } from './guest-access.mjs'
import { AUTOMATION_POLICIES_KEY, PROPOSALS_KEY } from './proposal-engine.mjs'
import {
  ARCHIVE_RETENTION_DAYS, BLOCK_ID_RE, LINK_ID_PREFIX, MAX_DOCUMENTS_PER_TENANT, MAX_ICON, MAX_OPS_PER_BATCH,
  MAX_SUMMARY, MAX_TITLE, PRESENCE_MIN_INTERVAL_MS, PRESENCE_TTL_MS,
  buildSearchText, excerptOf, linkTokensIn, neutralizeLinks, newBlockId, newDocumentId, redactLinks, removeLinks, stripLinks, wikiPlainText,
} from './wiki-blocks.mjs'
import { mergeOps } from './wiki-merge.mjs'
import {
  buildRevision, diffBlocks, diffToOps, oldestRevisionVersion, pruneRevisions, pruneTenantRevisions,
  reconstructBlocks, reinstateSource, revisionHeaderAt, revisionListItem, revisionRetention,
} from './wiki-revisions.mjs'
import { instantiateTemplateBlocks, missingSystemTemplates } from './wiki-templates.mjs'

/**
 * 문서(위키) 라우트 한 벌.
 *
 * app.mjs에 라우트를 새로 쓰지 않는다 — 문서의 권한·병합·이력·링크 인가가 한 파일 안에 모여 있어야
 * "이 문장을 볼 수 있는가"라는 질문의 답이 한 곳에서 나온다. 저장소 키(`wiki-documents`·`wiki-revisions`)는
 * WORKSPACE_STORE_KEYS에 없으므로 generic GET/PUT은 404다: 이 파일이 유일한 문이다.
 *
 * 이 모듈이 지키는 두 가지:
 *  1. **권한은 읽을 때마다 다시 계산한다.** 자료(grantDocumentAccess 스탬프)와 달리 프로젝트에서 빠지면
 *     그 순간 문서가 보이지 않는다. 스탬프는 첨부 파일에만 찍고 본문 권한에는 절대 찍지 않는다.
 *  2. **볼 수 없는 것의 이름은 어떤 경로로도 나가지 않는다.** 본문이 나가는 경로마다 `redactLinks`가 선다 —
 *     목록 발췌·문서 본문·리비전 본문·diff·내보내기·렌즈 입력·AI 대화 컨텍스트 일곱 곳이다.
 */

const WIKI_DOCUMENTS_KEY = 'wiki-documents'
const WIKI_REVISIONS_KEY = 'wiki-revisions'
const WORK_ITEMS_KEY = 'work-items'
const COMPANY_DOCUMENTS_KEY = 'company-documents'

const UNTITLED = '제목 없는 문서'
const MAX_ROSTER = 10
const MAX_CHANGED_BROADCAST = 50
const MAX_REVISION_PAGE = 50
const MAX_IDLE_ROOMS = 200

/** 병합기가 배치 전체를 되돌릴 때 쓰는 코드 → HTTP 상태. 여기 없으면 400이다. */
const MERGE_ERROR_STATUS = Object.freeze({
  WIKI_OPS_INVALID: 400,
  WIKI_BLOCK_INVALID: 400,
  WIKI_BLOCK_TYPE_CHANGE_FORBIDDEN: 400,
  WIKI_BLOCK_TOO_LONG_FOR_TYPE: 400,
  WIKI_BLOCK_LIMIT: 409,
  WIKI_DOCUMENT_TOO_LARGE: 413,
})

const MERGE_ERROR_MESSAGE = Object.freeze({
  WIKI_OPS_INVALID: '편집 내용을 확인해 주세요.',
  WIKI_BLOCK_INVALID: '문단 내용이나 길이를 확인해 주세요.',
  WIKI_BLOCK_TYPE_CHANGE_FORBIDDEN: '이 문단 종류로는 바꿀 수 없습니다.',
  WIKI_BLOCK_TOO_LONG_FOR_TYPE: '이 문단 종류에 비해 내용이 깁니다.',
  WIKI_BLOCK_LIMIT: '문단은 문서당 500개까지입니다. 문서를 나눠 주세요.',
  WIKI_DOCUMENT_TOO_LARGE: '문서가 너무 큽니다. 일부를 다른 문서로 옮겨 주세요.',
})

/**
 * 본문·저장소에서 온 값 하나를 문자열로 본다. **문자열이 아니면 없는 값이다.**
 *
 * `String(value)`를 바로 걸면 원시형 변환이 막힌 JSON 객체(`{"toString":null,"valueOf":null}`)에서
 * 던진다 — 설계표가 약속한 400 대신 500 INTERNAL_ERROR와 처리되지 않은 TypeError가 남는다.
 * 숫자나 객체를 `'42'`·`'[object Object]'`로 받아 적을 이유도 없으므로, 강제 변환 대신 형을 본다.
 * 그러면 값이 빠진 것과 모양이 틀린 것이 **같은 자리에서 같은 답**을 받는다(제목은 기본값, 이름이
 * 필요한 곳은 `WIKI_TITLE_REQUIRED`, 프레즌스는 `WIKI_PRESENCE_INVALID`).
 */
const asText = (value) => (typeof value === 'string' ? value : '')
const clip = (value, limit) => asText(value).slice(0, limit)
const trimmed = (value, limit) => asText(value).trim().slice(0, limit)

/**
 * 요청이 준 마감일 하나(못 읽으면 null). `Date.parse`도 인자에 ToString을 걸므로
 * 위 `asText`를 지나지 않으면 같은 자리에서 같은 500이 난다.
 */
const dueAt = (value) => {
  const parsed = Date.parse(asText(value))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

/** 오류 한 줄. 코드와 문장을 한 자리에서 만든다 — 두 곳에서 만들면 같은 사실이 두 문장이 된다. */
const fail = (response, status, code, message, extra = {}) => {
  response.status(status).json({ error: { code, message, ...extra } })
}

const isSystemTemplate = (document) => Boolean(document?.isTemplate) && document?.origin?.kind === 'system'

/**
 * 내보내기 파일 이름. 헤더 줄을 끊을 수 있는 글자는 지운다(`safeDownloadName`과 같은 규칙) —
 * 제목은 사람이 적은 값이고, 그대로 붙이면 응답 헤더가 갈라진다.
 */
const exportFileName = (document) => `${String(document?.title || '문서').replace(/[\r\n"]/g, '_').slice(0, 120)}.md`

export function registerWikiRoutes({
  app, requireAuth, requireMatchingWorkspaceIdentity,
  workspaceStore, accounts, commitWorkspaceStore, events,
  documentStorage, documentRecord, getTenantDocument, canReadDocument, grantDocumentAccess,
  projectSpacesOf, projectRoleOf, projectMemberIds,
  normalizeAdminWorkItems, operatorAwareAccounts, prependWithinCap, newWorkItemId, isMemberWorkItem,
  uniqueTenantAccountByName, guestGrantOf,
  enqueueProposal, announceProposal, newProposalId, proposalsOf, writeProposals,
  clock = () => new Date(),
}) {
  const guards = [requireAuth, requireMatchingWorkspaceIdentity]
  const nowIso = () => clock().toISOString()

  // ── 저장소 ────────────────────────────────────────────────────────────────
  const tenantStoreOf = (tenantId) => (workspaceStore.tenants[tenantId] ??= {})
  const rowsOf = (tenantId, key) => {
    const record = workspaceStore.tenants[tenantId]?.[key]
    return Array.isArray(record?.data) ? record.data : []
  }
  const documentsOf = (tenantId) => rowsOf(tenantId, WIKI_DOCUMENTS_KEY)
  const revisionsOf = (tenantId) => rowsOf(tenantId, WIKI_REVISIONS_KEY)
  const workItemsOf = (tenantId) => rowsOf(tenantId, WORK_ITEMS_KEY)

  /**
   * 문서 배열과(필요하면) 이력 배열을 한 번의 커밋으로 쓴다. 실패하면 **두 키 모두** 되돌린다.
   * 한쪽만 되돌리면 본문에는 있는 버전의 이력이 없거나 그 반대가 되어, 되돌리기가 조용히 410이 된다.
   */
  const saveWiki = async (tenantId, documents, revisions, actorId) => {
    const tenantStore = tenantStoreOf(tenantId)
    const beforeDocuments = tenantStore[WIKI_DOCUMENTS_KEY]
    const beforeRevisions = tenantStore[WIKI_REVISIONS_KEY]
    const at = nowIso()
    tenantStore[WIKI_DOCUMENTS_KEY] = { data: documents, updatedAt: at, updatedBy: actorId }
    if (revisions) tenantStore[WIKI_REVISIONS_KEY] = { data: revisions, updatedAt: at, updatedBy: actorId }
    try {
      await commitWorkspaceStore()
      return true
    } catch (error) {
      if (beforeDocuments) tenantStore[WIKI_DOCUMENTS_KEY] = beforeDocuments
      else delete tenantStore[WIKI_DOCUMENTS_KEY]
      if (revisions) {
        if (beforeRevisions) tenantStore[WIKI_REVISIONS_KEY] = beforeRevisions
        else delete tenantStore[WIKI_REVISIONS_KEY]
      }
      console.error('[wiki] 문서를 저장하지 못했습니다', { message: error?.message })
      return false
    }
  }

  /**
   * 한 테넌트의 **문서 쓰기 전부**를 한 줄로 세운다.
   *
   * 읽기→병합→대입은 동기라 그 사이에 잃어버린 갱신은 없다. 직렬화가 필요한 이유는 **커밋 실패 시
   * 롤백**이다 — `saveWiki`가 되돌리는 단위는 `wiki-documents` **레코드 전체**이므로, 문서 단위로만
   * 줄을 세우면 A의 커밋 실패가 그 사이 200을 받은 B의 저장을 말없이 지운다(커밋이 비동기인 PG
   * 배포에서 실제로 성립한다). **직렬화 단위는 롤백 단위와 같아야 한다** — 그래서 키가 테넌트다.
   * 위키 쓰기는 사람 손 속도라 처리량 손실이 사실상 없다.
   * 한계: 단일 프로세스 안에서만 유효하다(다중 프로세스·워커 배포에서는 성립하지 않는다).
   */
  const wikiLocks = new Map()
  /**
   * 문서 쓰기에 딸린 부수효과(첨부 열람 확대·파생 제안 파기)를 되돌릴 수 있게 지금 모습을 붙잡아 둔다.
   * 부수효과는 본문 저장과 **한 커밋**에 들어가고 실패하면 함께 되돌아간다 —
   * 갈라지면 저장되지 않은 문서 때문에 파일만 열려 있거나, 낮추지도 못한 수준 때문에 제안만 사라진다.
   */
  const snapshotSideEffects = (tenantId) => {
    const tenantStore = tenantStoreOf(tenantId)
    const before = new Map([COMPANY_DOCUMENTS_KEY, PROPOSALS_KEY, AUTOMATION_POLICIES_KEY].map((key) => [key, tenantStore[key]]))
    return () => {
      for (const [key, record] of before) {
        if (record) tenantStore[key] = record
        else delete tenantStore[key]
      }
    }
  }

  /** 키를 부르는 쪽이 정하지 않는다 — 문서 단위 키를 실수로 넘길 자리를 없앤다. */
  const withWikiLock = (tenantId, run) => {
    const key = `${tenantId}:wiki`
    const previous = wikiLocks.get(key) ?? Promise.resolve()
    const current = previous.then(run, run)
    // settled는 성공·실패를 모두 흡수한다 — 뒤에 선 요청이 앞 요청의 실패로 끌려가지 않고,
    // 이 체인에는 언제나 핸들러가 붙어 있어 unhandled rejection이 나지 않는다.
    const settled = current.then(() => {}, () => {})
    wikiLocks.set(key, settled)
    settled.then(() => { if (wikiLocks.get(key) === settled) wikiLocks.delete(key) })
    return current
  }

  // ── 권한 ──────────────────────────────────────────────────────────────────
  const projectOf = (tenantId, projectId) => projectSpacesOf(tenantId).find((project) => project?.id === projectId) ?? null

  /**
   * 이 사람이 이 문서를 읽을 수 있는가. **테넌트 비교는 무조건 한다** —
   * `doc.tenantId &&`로 단락하면 tenantId가 빈 행이 어느 테넌트에서도 통과한다.
   */
  const canReadWikiDocument = (document, auth) => {
    if (!document || !auth) return false
    if (document.tenantId !== auth.tenantId) return false
    // 이번 절에서 게스트에게 문서를 열지 않는다. 라우트 게이트(guest-access)가 먼저 403을 내지만,
    // 이 판정은 검색·AI 컨텍스트처럼 게이트 밖에서도 불린다 — 이중 방어다.
    if (auth.role === GUEST_ROLE) return false
    if (document.projectId) {
      const project = projectOf(auth.tenantId, document.projectId)
      // 가리키던 프로젝트가 사라진 **미아 문서**. 아무에게도 열지 않으면 그 행은 목록·상세·검색·
      // 내보내기·이력·PATCH·보관·완전삭제 어느 문으로도 닿지 않은 채 회사 문서 상한 한 칸을 영원히
      // 먹고, 보관 스윕도(보관된 적이 없으므로) 걷어내지 못한다. 관리자에게만 열어 두어 전사로
      // 되돌리거나 보관·완전삭제로 걷어낼 수 있게 한다 — 사람이 손댈 수 있으면 막다른 길이 아니다.
      // (정상 경로에서는 프로젝트 삭제가 같은 커밋에서 이미 보관 처리하므로 이 갈래는 옛 행만 만난다.)
      if (!project) return auth.role === 'tenant-admin'
      return projectRoleOf(project, auth) !== null
    }
    return true
  }

  /**
   * 역할만 본다(보관·시스템 템플릿 같은 문서 상태는 `writeRefusal`이 갈라 답한다).
   *
   * **작성자 예외는 프로젝트 판정 뒤에 온다.** 앞에 두면 문서를 자기가 속하지 않은 프로젝트로 옮겨도
   * 작성자가 계속 읽고 쓰게 되어 상속이 무너진다. 프로젝트 문서의 작성자는 프로젝트 역할이 전부다.
   */
  const canEditWikiDocument = (document, auth) => {
    if (!canReadWikiDocument(document, auth)) return false
    if (auth.role === 'tenant-admin') return true
    if (document.projectId) return ['owner', 'editor'].includes(projectRoleOf(projectOf(auth.tenantId, document.projectId), auth))
    if (document.createdById && document.createdById === auth.id) return true
    return document.writeScope === 'tenant'
  }

  /** 프로젝트 연결·AI 처리 수준처럼 문서의 성격을 바꾸는 조작. */
  const canManageWikiDocument = (document, auth) => canEditWikiDocument(document, auth)
    && (auth.role === 'tenant-admin' || (Boolean(document.createdById) && document.createdById === auth.id))

  /**
   * 쓰기를 거절할 이유 한 줄(없으면 null). 코드와 상태를 한 자리에서 정한다 —
   * 라우트마다 따로 적으면 같은 상황이 어디서는 403, 어디서는 404가 된다.
   */
  const writeRefusal = (document, auth, { allowArchived = false } = {}) => {
    if (!canReadWikiDocument(document, auth)) {
      return { status: 404, code: 'WIKI_NOT_FOUND', message: '문서를 찾을 수 없거나 열람 권한이 없습니다.' }
    }
    if (isSystemTemplate(document)) {
      return { status: 409, code: 'WIKI_TEMPLATE_READONLY', message: '기본 템플릿은 고칠 수 없습니다. 템플릿으로 새 문서를 만들어 주세요.' }
    }
    if (!allowArchived && document.archivedAt) {
      return { status: 409, code: 'WIKI_ARCHIVED', message: '보관한 문서입니다. 보관함에서 꺼낸 뒤 고쳐 주세요.' }
    }
    if (!canEditWikiDocument(document, auth)) {
      return { status: 403, code: 'WIKI_FORBIDDEN', message: '이 문서를 고칠 권한이 없습니다.' }
    }
    return null
  }

  const refuse = (response, refusal) => fail(response, refusal.status, refusal.code, refusal.message)

  /**
   * 지금 더 만들 수 있는 비보관 문서 행 수. 상한을 말하는 문장과 시드가 **같은 수를 본다** —
   * 세는 자리가 둘이면 한쪽이 "500건까지"라고 답하는 동안 다른 쪽이 504건을 만든다.
   */
  const documentRoom = (documents) => MAX_DOCUMENTS_PER_TENANT - documents.filter((row) => !row?.archivedAt).length

  /**
   * 문서 수 상한 한 문장(넘지 않았으면 null). **문서 행을 새로 만드는 문이 모두** 이 한 자리를 부른다 —
   * 생성 라우트에만 두면 '내 템플릿으로 저장'이 같은 배열에 행을 얼마든지 더 넣어 상한이 실효를 잃는다.
   */
  const documentLimitRefusal = (documents) => (documentRoom(documents) <= 0
    ? { status: 409, code: 'WIKI_LIMIT', message: `문서는 회사당 ${MAX_DOCUMENTS_PER_TENANT}건까지입니다. 쓰지 않는 문서를 보관해 주세요.` }
    : null)

  /** 상위 문서와 하위 문서의 프로젝트가 어긋났다는 **한 문장**. 생성과 PATCH가 같이 쓴다. */
  const PARENT_PROJECT_MISMATCH = '상위 문서와 같은 프로젝트에만 하위 문서를 둘 수 있습니다.'

  /**
   * 내 조작이 **딸린 하위 문서까지 고쳐 쓰게 될 때**의 거절 한 줄. 프로젝트 이동과 부모 보관이
   * 같이 쓴다 — 두 절이 각자 적으면 같은 사실(그 문서는 내가 못 고친다)에 반대로 답하게 된다.
   */
  const MOVE_BLOCKED = {
    status: 409, code: 'WIKI_MOVE_BLOCKED',
    message: '하위 문서 중에 고칠 권한이 없는 문서가 있습니다. 그 문서를 먼저 옮기거나 정리해 주세요.',
  }

  // ── 링크 ──────────────────────────────────────────────────────────────────
  const accountOf = (tenantId, id) => accounts.find((account) => account?.id === id
    && account?.tenantId === tenantId && account?.role !== 'platform-operator') ?? null

  const nameOfAccount = (tenantId) => (id) => accountOf(tenantId, id)?.name ?? ''

  /**
   * 링크 대상 하나를 지금 이 사람의 눈으로 푼다.
   * `'gone'`은 테넌트에 그 id가 아예 없을 때만이다 — 쓰기 시점에 이미 400으로 드러나는 정보라
   * 새로 새는 것이 없다. 볼 수 없는 대상은 언제나 `'hidden'`이다.
   */
  const resolveFor = (auth) => (kind, id) => {
    if (!auth?.tenantId) return 'hidden'
    if (kind === 'doc') {
      const target = documentsOf(auth.tenantId).find((row) => row?.id === id)
      if (!target) return 'gone'
      return canReadWikiDocument(target, auth) ? { title: target.title || UNTITLED } : 'hidden'
    }
    if (kind === 'task') {
      const target = workItemsOf(auth.tenantId).find((row) => row?.id === id)
      if (!target) return 'gone'
      return (auth.role === 'tenant-admin' || isMemberWorkItem(target, auth)) ? { title: target.title ?? '' } : 'hidden'
    }
    if (kind === 'person') {
      const target = accountOf(auth.tenantId, id)
      return target ? { title: target.name ?? '' } : 'gone'
    }
    return 'gone'
  }

  /**
   * 쓰기 시점 링크 인가. 존재하지 않는 대상과 볼 수 없는 대상을 **같은 코드**로 거절한다 —
   * 갈라 답하면 링크 하나로 "그 업무가 있는가"를 떠볼 수 있는 존재 오라클이 된다.
   */
  const linkViolation = (text, auth) => {
    const resolve = resolveFor(auth)
    for (const token of linkTokensIn(text)) {
      if (!token.id.startsWith(LINK_ID_PREFIX[token.kind])) return `${token.kind}:${token.id}`
      const found = resolve(token.kind, token.id)
      if (!found || typeof found !== 'object') return `${token.kind}:${token.id}`
    }
    return null
  }

  /** 인가를 통과한 토큰의 라벨을 대상의 **현재** 제목으로 바꿔 저장한다(낡은 라벨을 믿지 않는다). */
  const normalizeLinks = (text, auth) => redactLinks(text, resolveFor(auth))

  const eachOpText = (block) => {
    const texts = []
    if (typeof block?.text === 'string') texts.push(block.text)
    if (Array.isArray(block?.rows)) for (const row of block.rows) for (const cell of row ?? []) if (typeof cell === 'string') texts.push(cell)
    return texts
  }

  /**
   * 클라이언트가 보낸 ops의 본문을 인가하고 라벨을 정규화한다.
   *
   * 서버가 스스로 만든 ops(복원·문장 되살리기·템플릿 복제)에는 걸지 않는다: 그 본문은 이미 쓰인
   * 시점에 인가를 받았고, 지금 되돌리는 사람이 그 대상을 볼 수 없다는 이유로 복원이 막히면
   * "이력은 남는다"는 약속이 깨진다. 새어 나갈 위험은 렌더 시점 `redactLinks`가 막는다.
   */
  const authorizeOps = (ops, auth) => {
    const prepared = []
    for (const op of ops) {
      if (!op || typeof op !== 'object' || !op.block) { prepared.push(op); continue }
      for (const text of eachOpText(op.block)) {
        const violation = linkViolation(text, auth)
        if (violation) return { token: violation }
      }
      const block = { ...op.block }
      if (typeof block.text === 'string') block.text = normalizeLinks(block.text, auth)
      if (Array.isArray(block.rows)) block.rows = block.rows.map((row) => (Array.isArray(row) ? row.map((cell) => (typeof cell === 'string' ? normalizeLinks(cell, auth) : cell)) : row))
      prepared.push({ ...op, block })
    }
    return { ops: prepared }
  }

  // ── 첨부 ──────────────────────────────────────────────────────────────────
  const attachmentIdsIn = (ops) => [...new Set(ops
    .map((op) => op?.block?.attachmentId)
    .filter((id) => typeof id === 'string' && id.startsWith('DOC-')))]

  /**
   * 첨부 무결성 1/3 — 쓰기 시점. `canReadDocument`(열람)과 `getTenantDocument`(원본 존재) 둘 다
   * 통과해야 한다. `canReferenceDocuments`(app.mjs)와 같은 강도다.
   */
  const attachmentViolation = async (ids, auth) => {
    if (!ids.length) return null
    if (!documentStorage) return ids[0]
    const files = Array.isArray(documentRecord(auth.tenantId)?.data) ? documentRecord(auth.tenantId).data : []
    const byId = new Map(files.map((file) => [file.id, file]))
    for (const id of ids) {
      const file = byId.get(id)
      if (!file || !canReadDocument(file, auth)) return id
      try { await getTenantDocument(documentStorage, file, auth.tenantId) } catch { return id }
    }
    return null
  }

  /**
   * 첨부 무결성 2/3 — 열람 확대. 프로젝트 문서에 한해 **그 문서를 읽을 수 있는** 구성원에게 파일을 연다.
   * **문서 본문 권한은 절대 스탬프하지 않는다**(본문 인가는 읽을 때마다 다시 계산한다).
   *
   * 두 가지를 명단·대상 양쪽에서 갈라 둔다.
   *
   *  1. **명단은 SSE 청중과 같은 술어에서 나온다**(`audienceOf`가 쓰는 `canReadWikiDocument`).
   *     `projectMemberIds`를 그대로 넘기면 프로젝트에 초대된 **외부 게스트**가 그 명단에 들어간다 —
   *     게스트는 이 절의 어떤 위키 라우트에서도 403(§7-6)인데, 문서에 붙었다는 이유만으로 회사 파일
   *     본문을 받아 가게 된다. "읽을 수 있는 사람 = 신호를 받는 사람"은 파일에도 똑같이 걸린다.
   *  2. **넓히는 대상은 restricted 파일뿐이다.** `grantDocumentAccess`는 visibility를 restricted로
   *     강제하므로, 부서 공개(department) 파일을 넘기면 그 파일을 보던 **같은 부서 전원이 끊긴다**.
   *     확대가 축소를 겸하는 셈이라 어느 쪽으로도 틀린다. 부서·전사 공개는 자기 범위가 이미 답이다.
   */
  const shareAttachments = (ids, document, auth) => {
    if (!ids.length || !document.projectId) return
    const project = projectOf(auth.tenantId, document.projectId)
    if (!project) return
    const readers = projectMemberIds(project)
      .map((id) => accounts.find((account) => account?.id === id && account?.tenantId === auth.tenantId) ?? null)
      .filter((account) => canReadWikiDocument(document, account))
      .map((account) => account.id)
    if (!readers.length) return
    const files = Array.isArray(documentRecord(auth.tenantId)?.data) ? documentRecord(auth.tenantId).data : []
    const widenable = ids.filter((id) => files.find((file) => file?.id === id)?.visibility === 'restricted')
    if (!widenable.length) return
    grantDocumentAccess(auth.tenantId, widenable, readers, { projectId: project.id })
  }

  // ── 프레즌스 ──────────────────────────────────────────────────────────────
  /**
   * `${tenantId}:${documentId}` → Map<accountId, { name, blockId, at }>.
   *
   * 워크스페이스 저장소에 두지 않는다 — 영속되면 안 되는 값이고, 저장하면 15초마다 감사 커밋이 돈다.
   * 프로세스 로컬이라 다중 프로세스에서는 서로의 접속자를 보지 못한다(화면은 1명이면 아무것도
   * 그리지 않으므로 거짓말은 하지 않는다).
   */
  const presence = new Map()
  const roomKey = (tenantId, documentId) => `${tenantId}:${documentId}`
  const sweepRoom = (key, now) => {
    const room = presence.get(key)
    if (!room) return []
    for (const [id, entry] of room) if (now - entry.at > PRESENCE_TTL_MS) room.delete(id)
    // 빈 방을 남기지 않는다 — 남기면 Map이 문서 수만큼 늘어난 뒤 영영 줄지 않는다.
    if (room.size === 0) { presence.delete(key); return [] }
    return [...room].map(([accountId, entry]) => ({
      accountId, name: entry.name, blockId: entry.blockId, at: new Date(entry.at).toISOString(),
    })).slice(0, MAX_ROSTER)
  }
  /**
   * 아무도 다시 찾지 않는 방을 걷어낸다. 타이머를 두지 않는 이유: 이 서버는 프로세스마다 여러 앱
   * 인스턴스로 시험되고, 인스턴스마다 살아 있는 interval을 남기면 그 수만큼 타이머가 쌓인다.
   * 방 수가 상한을 넘을 때만 한 번 훑는다(문서 수로 묶여 있어 최악도 짧다).
   */
  const sweepIdleRooms = (now) => {
    if (presence.size <= MAX_IDLE_ROOMS) return
    for (const key of [...presence.keys()]) sweepRoom(key, now)
  }
  const rosterOf = (tenantId, documentId) => sweepRoom(roomKey(tenantId, documentId), clock().getTime())

  // ── 응답 모양 ─────────────────────────────────────────────────────────────
  const redactBlock = (block, resolve) => {
    if (!block) return block
    const next = { ...block }
    if (typeof block.text === 'string') next.text = redactLinks(block.text, resolve)
    if (Array.isArray(block.rows)) next.rows = block.rows.map((row) => (row ?? []).map((cell) => redactLinks(cell, resolve)))
    return next
  }

  /**
   * 응답용 문서. `tenantId`는 지운다(자료 라우트 관례) — 본문은 반드시 재인가를 지난다.
   * 요약도 본문이다: 링크 토큰이 사는 자리가 블록만이라고 보면 같은 이름이 요약을 타고 그대로 나간다.
   */
  const publicDocument = (document, auth) => {
    const resolve = resolveFor(auth)
    const { tenantId, clientRequestId, ...rest } = document
    return {
      ...rest,
      summary: redactLinks(document.summary ?? '', resolve),
      blocks: (document.blocks ?? []).map((block) => redactBlock(block, resolve)),
    }
  }

  const listItem = (document, auth, childCount) => ({
    id: document.id,
    title: document.title,
    icon: document.icon ?? '',
    parentId: document.parentId ?? null,
    projectId: document.projectId ?? null,
    aiLevel: aiLevelOf(document),
    // 요약에도 링크 토큰이 산다. 본문과 같은 재인가를 거치지 않으면, 프로젝트 문서를 전사로 옮기는
    // 순간 그 안에 남은 라벨(볼 수 없는 대상의 제목)이 목록으로 열린다.
    summary: redactLinks(document.summary ?? '', resolveFor(auth)),
    writeScope: document.writeScope ?? 'author',
    isTemplate: Boolean(document.isTemplate),
    templateId: document.templateId ?? null,
    origin: document.origin ?? null,
    version: Number(document.version ?? 1),
    blockCount: (document.blocks ?? []).length,
    childCount,
    archivedAt: document.archivedAt ?? null,
    createdById: document.createdById ?? '',
    createdByName: document.createdByName ?? '',
    createdAt: document.createdAt ?? null,
    lastEditedById: document.lastEditedById ?? '',
    lastEditedByName: document.lastEditedByName ?? '',
    lastEditedAt: document.lastEditedAt ?? null,
    excerpt: excerptOf(redactLinks(document.searchText ?? '', resolveFor(auth)), 200),
  })

  const breadcrumbOf = (document, auth) => {
    const documents = documentsOf(auth.tenantId)
    const trail = []
    const seen = new Set([document.id])
    let cursor = document.parentId
    while (cursor && !seen.has(cursor) && trail.length < 20) {
      seen.add(cursor)
      const parent = documents.find((row) => row?.id === cursor)
      if (!parent || !canReadWikiDocument(parent, auth)) break
      trail.unshift({ id: parent.id, title: parent.title, icon: parent.icon ?? '' })
      cursor = parent.parentId
    }
    return trail
  }

  const tocOf = (document, resolve) => (document.blocks ?? [])
    .filter((block) => block?.type === 'heading')
    .map((block) => ({ id: block.id, level: Number(block.level) || 2, text: redactLinks(block.text ?? '', resolve) }))
    .slice(0, 200)

  /** 문서가 가리키는 링크 목록. 라벨은 이미 재인가를 거친 값이라 볼 수 없는 대상은 '접근 권한 없음'이다. */
  const linksOf = (document, resolve) => {
    const found = new Map()
    for (const block of document.blocks ?? []) {
      for (const text of eachOpText(block)) {
        for (const token of linkTokensIn(redactLinks(text, resolve))) {
          if (!found.has(token.token)) found.set(token.token, { kind: token.kind, id: token.id, label: token.label })
        }
      }
    }
    return [...found.values()].slice(0, 200)
  }

  /** 문서가 쓰는 첨부 중 **이 사람이 볼 수 있는 것만**. 볼 수 없는 파일의 이름은 나가지 않는다. */
  const attachmentsOf = (document, auth) => {
    const ids = [...new Set((document.blocks ?? []).map((block) => block?.attachmentId).filter(Boolean))]
    if (!ids.length) return []
    const files = Array.isArray(documentRecord(auth.tenantId)?.data) ? documentRecord(auth.tenantId).data : []
    return ids.map((id) => {
      const file = files.find((row) => row?.id === id)
      if (!file || !canReadDocument(file, auth)) return { id, name: null, readable: false }
      return { id, name: clip(file.name || file.originalName, 180) || '첨부파일', mime: clip(file.mime, 180), size: Number(file.size ?? 0), readable: true }
    })
  }

  // ── 이력 ──────────────────────────────────────────────────────────────────
  /** 이력 한 줄을 배열에 넣고 그 문서의 사슬만 잘라낸다(다른 문서의 이력은 건드리지 않는다). */
  const appendRevision = (rows, revision) => {
    const isMine = (row) => row?.documentId === revision.documentId && row?.tenantId === revision.tenantId
    const others = rows.filter((row) => !isMine(row))
    // 결정론적 id라 같은 배치를 두 번 처리해도 행이 둘이 되지 않는다.
    const mine = rows.filter(isMine).filter((row) => row.id !== revision.id)
    return [...others, ...pruneRevisions([...mine, revision])]
  }

  const revisionsFor = (tenantId, documentId) => revisionsOf(tenantId)
    .filter((row) => row?.documentId === documentId && row?.tenantId === tenantId)
    .slice()
    .sort((left, right) => Number(right.version) - Number(left.version))

  const emptyChange = () => ({ inserted: [], updated: [], deleted: [], moved: [] })

  /** 메타데이터 한 칸이 바뀐 배치의 결과 모양. 본문은 그대로이므로 역패치가 비어 있다. */
  const metaResult = () => ({ changed: emptyChange(), changedCount: 0, inverse: [], overwrites: [], lostEdits: [], versionBumped: true })

  /**
   * 부모가 목록에서 사라질 때(보관·완전 삭제) 자식을 어떻게 할지 정하는 **한 벌**.
   *
   * 보관하는 문이 둘이라(`PATCH {archived:true}`·`DELETE`) 이 절이 한 자리에 없으면 같은 사실에 두 답이
   * 나온다 — 한 문은 409로 막고, 다른 문은 보관된 부모 아래에 자식을 남긴 뒤 30일 뒤 스윕이 그 부모를
   * 지워 **없는 문서를 가리키는 parentId**를 만든다.
   *
   * 자식 판정은 목록의 `childCount`와 **같은 술어**다(보이고 + 보관 안 된 것). 어긋나면 "자식 0"이라고
   * 본 사람에게 409가 돌아가고, 그 응답 코드가 못 보는 문서의 존재를 말한다.
   */
  const archiveChildPlan = (document, documents, auth, now) => {
    const children = documents.filter((row) => row?.parentId === document.id)
    if (children.some((row) => canReadWikiDocument(row, auth) && !row.archivedAt)) {
      return { refusal: { status: 409, code: 'WIKI_HAS_CHILDREN', message: '하위 문서를 먼저 옮기거나 정리해 주세요.' } }
    }
    // 남는 자식(= 이 사람에게 안 보이거나 이미 보관된 것)은 **같은 커밋에서** 루트로 올린다.
    // 사라지거나 보관될 부모 아래에 남겨 두면, 그 자식의 주인은 부모를 바꿀 길이 없다(문서 밖에서 못 하는 일이다).
    //
    // 그러나 **내 이름으로 남의 문서를 고칠 수는 없다.** 정문(PATCH)이 403 `WIKI_FORBIDDEN`을 내는
    // 문서를 '부모 보관'이라는 뒷문으로 고쳐 쓰면 같은 사람·같은 문서·같은 필드에 두 답이 생긴다.
    // 프로젝트 이동 경로가 이미 고른 답이 있고(`WIKI_MOVE_BLOCKED`), 여기도 같은 술어·같은 문장을 쓴다.
    if (children.some((row) => canReadWikiDocument(row, auth) && writeRefusal(row, auth, { allowArchived: true }) !== null)) {
      return { refusal: MOVE_BLOCKED }
    }
    // 안 보이는 자식은 거절하지 못한다 — 409 자체가 그 문서의 존재를 말하고, 목록은 같은 사람에게
    // '자식 0'이라고 답했다(존재 오라클 차단). 매달릴 parentId만 끊되, 하지 않은 편집을 그 사람
    // 이름으로 적지는 않는다: 이 한 줄은 사람의 편집이 아니라 시스템의 참조 수리다.
    const orphanActor = (row) => (canReadWikiDocument(row, auth)
      ? { id: auth.id, name: auth.name ?? '' }
      : { id: 'system:wiki-reparent', name: '' })
    const orphans = children.map((row) => ({
      ...row, parentId: null, version: Number(row.version) + 1,
      lastEditedById: orphanActor(row).id, lastEditedByName: orphanActor(row).name, lastEditedAt: now,
    }))
    const orphanById = new Map(orphans.map((row) => [row.id, row]))
    return {
      refusal: null,
      orphans,
      reparentedIds: orphans.map((row) => row.id),
      withOrphans: (rows) => rows.map((row) => orphanById.get(row?.id) ?? row),
      withOrphanRevisions: (rows) => orphans.reduce((accumulated, row) => appendRevision(accumulated, buildRevision({
        document: row, result: metaResult(), actorId: auth.id, actorName: auth.name ?? '', now,
        meta: { field: 'parentId', before: document.id, after: null },
      })), rows),
      publishOrphans: () => { for (const row of orphans) publishMeta(auth.tenantId, row, 'parentId') },
    }
  }

  /** 이 회사의 관리자 계정 id들. 관리자는 어느 프로젝트 문서든 읽는다(`projectRoleOf`가 'owner'를 준다). */
  const tenantAdminIds = (tenantId) => accounts
    .filter((account) => account?.tenantId === tenantId && account?.role === 'tenant-admin')
    .map((account) => account.id)

  /**
   * 이 문서의 신호를 받을 사람들. **명단은 열람 판정에서 파생한다**(`canReadWikiDocument`).
   *
   * 페이로드에 본문·제목은 없지만, 문서 id·버전·바뀐 블록 id와 "지금 누가 어느 문단에 있는지(이름)"는
   * 그것만으로 못 읽는 문서의 존재와 그 안의 움직임을 말한다. 이 모듈의 첫 번째 약속("권한은 읽을
   * 때마다 다시 계산한다")이 이 채널에서만 계산되지 않을 이유가 없다.
   *
   * 판정을 두 벌로 두면 **양쪽으로** 틀린다 — 예전에는 명단을 `projectMemberIds`로만 재서, 회사 전체
   * 공개(visibility:'company') 프로젝트의 문서를 읽을 수 있는 비멤버 직원과 프로젝트 밖 관리자가
   * 그 문서의 편집·프레즌스 신호를 한 건도 받지 못했다. 아래 세 갈래는 `canReadWikiDocument`의
   * 프로젝트 분기와 한 줄씩 짝이 맞는다.
   *
   * 명단을 붙이지 않는 것(`{}`)은 "이 회사 직원 전부"라는 뜻이다. 외부 게스트는 문서를 읽지 못하지만
   * 명단으로 거를 필요가 없다 — `event-stream`의 restricted 필터가 게스트에게 'wiki' 종류를 아예 주지 않는다.
   */
  const audienceOf = (tenantId, document) => {
    const projectId = document?.projectId ?? null
    if (!projectId) return {}
    const project = projectOf(tenantId, projectId)
    // 미아 문서(가리키던 프로젝트가 사라졌다) — 지금 읽을 수 있는 사람은 관리자뿐이다.
    if (!project) return { accountIds: tenantAdminIds(tenantId) }
    // 회사 전체 공개 프로젝트 — 비멤버 직원도 'viewer'로 읽는다.
    if (project.visibility === 'company') return {}
    return { accountIds: [...new Set([...projectMemberIds(project), ...tenantAdminIds(tenantId)])] }
  }

  const publishOps = (tenantId, document, actorId, changed) => {
    // 본문·제목은 싣지 않는다. 클라이언트는 이 신호를 재조회 트리거로만 쓴다.
    events.publish(tenantId, 'wiki', {
      change: 'ops', documentId: document.id, version: document.version, byId: actorId,
      changed: changed.slice(0, MAX_CHANGED_BROADCAST),
    }, audienceOf(tenantId, document))
  }
  // 청중을 넘길 수 있게 열어 둔다 — 프로젝트가 **막 사라진** 순간에는 `audienceOf`가 그 프로젝트를
  // 찾지 못해 관리자만 남는다. 지우기 직전에 잡아 둔 멤버 명단이 그때의 정답이다.
  const publishMeta = (tenantId, document, field, audience = audienceOf(tenantId, document)) => {
    events.publish(tenantId, 'wiki', { change: 'meta', documentId: document.id, version: document.version, field }, audience)
  }

  // ── 템플릿 시드 ───────────────────────────────────────────────────────────
  /**
   * 아직 없는 기본 템플릿만 만든다. **id별로 없을 때만** 만들므로 사용자가 지운(=보관한) 템플릿은
   * 행이 남아 되살아나지 않는다.
   */
  const seedTemplates = async (auth) => {
    const documents = documentsOf(auth.tenantId)
    // 흔한 경우(이미 다 있다)는 락을 잡지 않는다 — 목록 조회가 남의 쓰기 뒤에 줄 서지 않게.
    if (!missingSystemTemplates(documents, { tenantId: auth.tenantId, now: nowIso() }).length) return documents
    // 시드도 `wiki-documents` 레코드를 통째로 쓴다 — 다른 쓰기와 같은 줄에 선다.
    return withWikiLock(auth.tenantId, async () => {
      const current = documentsOf(auth.tenantId)
      const missing = missingSystemTemplates(current, { tenantId: auth.tenantId, now: nowIso() })
      if (!missing.length) return current
      // 시드도 문서 행을 새로 만드는 문이다 — 정문이 409를 내는 상태에서 목록 조회 한 번이 상한을
      // 넘기면 '회사당 500건'이라는 문장이 거짓이 된다. 자리가 나면 다음 조회에서 나머지가 마저 선다
      // (`missingSystemTemplates`는 id별 판정이라 이어 만들어도 중복되지 않는다).
      const room = documentRoom(current)
      if (room <= 0) return current
      const next = [...current, ...missing.slice(0, room)]
      const saved = await saveWiki(auth.tenantId, next, null, 'system:wiki-templates')
      return saved ? next : current
    })
  }

  // ── 라우트 ────────────────────────────────────────────────────────────────
  const requireTenant = (request, response) => {
    if (request.auth?.tenantId) return true
    fail(response, 403, 'TENANT_REQUIRED', '회사 워크스페이스에서만 쓸 수 있습니다.')
    return false
  }

  const findDocument = (auth, id) => documentsOf(auth.tenantId).find((row) => row?.id === id) ?? null

  /**
   * 저장 직전에 겹침을 한 번 더 본다. 난수 폭(8바이트)만으로도 사실상 겹치지 않지만, 이 배열에서
   * 문서를 찾는 술어는 전부 `find`(첫 행)라 **id가 겹치는 순간 두 번째 행은 아무도 손댈 수 없는
   * 유령이 되고, 첫 행이 남의 권한을 대신 판정한다.** 값싼 검사 하나로 그 갈래를 닫는다.
   */
  const freshDocumentId = (documents) => {
    let id = newDocumentId()
    for (let attempt = 1; documents.some((row) => row?.id === id); attempt += 1) id = `${newDocumentId()}${attempt}`
    return id
  }

  const readable = (auth, id, response) => {
    const document = findDocument(auth, id)
    if (!document || !canReadWikiDocument(document, auth)) {
      fail(response, 404, 'WIKI_NOT_FOUND', '문서를 찾을 수 없거나 열람 권한이 없습니다.')
      return null
    }
    return document
  }

  // 1. 목록
  app.get('/api/wiki', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const auth = request.auth
    const documents = await seedTemplates(auth)
    const visible = documents.filter((row) => canReadWikiDocument(row, auth))
    const childCounts = new Map()
    for (const row of visible) {
      if (!row.parentId || row.archivedAt) continue
      childCounts.set(row.parentId, (childCounts.get(row.parentId) ?? 0) + 1)
    }
    const archived = String(request.query?.archived ?? '') === '1'
    const projectFilter = String(request.query?.projectId ?? '').trim()
    const words = String(request.query?.q ?? '').trim().toLowerCase().split(/\s+/u).filter(Boolean).slice(0, 8)
    // 요약도 색인(`searchText`)과 같은 규칙으로 토큰을 지운 뒤 맞춘다 — 남겨 두면 볼 수 없는 대상의
    // 제목을 검색어로 넣어 히트 유무로 존재를 떠보는 오라클이 된다(D10을 요약에서 닫는다).
    const matches = (row) => words.every((word) => `${row.title} ${removeLinks(row.summary ?? '')} ${row.searchText ?? ''}`.toLowerCase().includes(word))

    const pages = visible
      .filter((row) => !row.isTemplate)
      .filter((row) => Boolean(row.archivedAt) === archived)
      .filter((row) => (projectFilter ? row.projectId === projectFilter : true))
      .filter(matches)
      .sort((left, right) => String(right.lastEditedAt ?? '').localeCompare(String(left.lastEditedAt ?? '')))
      .map((row) => listItem(row, auth, childCounts.get(row.id) ?? 0))

    const templates = visible
      .filter((row) => row.isTemplate && !row.archivedAt)
      .sort((left, right) => String(left.title).localeCompare(String(right.title), 'ko'))
      .map((row) => listItem(row, auth, 0))

    response.json({ documents: pages, templates, aiLevels: AI_LEVEL_LABELS })
  })

  // 2. 문서 한 건
  app.get('/api/wiki/:id', ...guards, (request, response) => {
    if (!requireTenant(request, response)) return
    const auth = request.auth
    const document = readable(auth, request.params.id, response)
    if (!document) return
    const since = Number.parseInt(String(request.query?.since ?? ''), 10)
    // 같은 버전이면 본문을 다시 보내지 않는다 — SSE가 깨운 재조회가 매번 200KB를 왕복하지 않게.
    if (Number.isInteger(since) && since === Number(document.version)) { response.status(204).end(); return }
    const resolve = resolveFor(auth)
    response.json({
      document: publicDocument(document, auth),
      role: document.projectId ? projectRoleOf(projectOf(auth.tenantId, document.projectId), auth) : null,
      permissions: { canWrite: writeRefusal(document, auth) === null, canManage: canManageWikiDocument(document, auth) },
      breadcrumb: breadcrumbOf(document, auth),
      links: linksOf(document, resolve),
      attachments: attachmentsOf(document, auth),
      presence: rosterOf(auth.tenantId, document.id),
      toc: tocOf(document, resolve),
      revisionCount: revisionsFor(auth.tenantId, document.id).length,
    })
  })

  // 3. 생성
  app.post('/api/wiki', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const auth = request.auth
    // 생성도 `wiki-documents` 레코드를 통째로 쓴다 — 다른 쓰기와 같은 줄에 선다.
    await withWikiLock(auth.tenantId, async () => {
      const body = request.body ?? {}
      const clientRequestId = trimmed(body.clientRequestId, 120)
      const documents = documentsOf(auth.tenantId)
      if (clientRequestId) {
        const replayed = documents.find((row) => row?.clientRequestId === clientRequestId && row?.createdById === auth.id)
        // **만든 사람이라는 사실은 지금 읽을 수 있다는 뜻이 아니다.** 만든 뒤 프로젝트로 옮겨졌으면
        // 정문(GET)은 404다 — 재전송이 뒷문이 되면 같은 문서에 두 답이 생기고, 그 뒷문으로 나가는 것은
        // 만들 때의 본문이 아니라 **지금 본문 전체**다.
        if (replayed && !canReadWikiDocument(replayed, auth)) {
          fail(response, 404, 'WIKI_NOT_FOUND', '문서를 찾을 수 없거나 열람 권한이 없습니다.')
          return
        }
        // 보관된 문서는 그대로 답한다(`archivedAt`이 응답에 실린다) — 재전송의 목적은 "그 만들기는 이미
        // 끝났다"를 알리는 것이라, 여기서 409를 내면 클라이언트가 id를 잃고 같은 문서를 또 만든다.
        if (replayed) { response.json({ document: publicDocument(replayed, auth), replayed: true }); return }
      }
      const limit = documentLimitRefusal(documents)
      if (limit) { refuse(response, limit); return }

      const parentId = trimmed(body.parentId, 60) || null
      // **주지 않으면 부모의 것을 물려받는다**(PATCH와 같은 답이다) — 하위 문서를 만드는 정직한 요청은
      // 부모의 프로젝트를 알 필요가 없다. `Object.hasOwn`으로 가르는 이유: 안 준 것과 `null`을 준 것은
      // 다른 뜻이다(뒤엣것은 "전사 문서로 빼내라"라는 요구라 부모와 어긋난다).
      const requestedProjectId = Object.hasOwn(body, 'projectId') ? (trimmed(body.projectId, 60) || null) : undefined
      let projectId = requestedProjectId ?? null
      let parent = null
      if (parentId) {
        parent = documents.find((row) => row?.id === parentId) ?? null
        const refusal = writeRefusal(parent, auth)
        if (refusal) {
          // 부모를 못 쓰는 사람은 그 아래에 문서를 만들 수 없다. 존재 자체를 모르는 사람에게는 404다.
          if (refusal.status === 404) { fail(response, 404, 'WIKI_PARENT_NOT_FOUND', '상위 문서를 찾을 수 없습니다.'); return }
          refuse(response, refusal)
          return
        }
        // 명시했는데 부모와 어긋날 때만 400이다 — PATCH의 판정과 같은 문장·같은 코드다.
        if (requestedProjectId !== undefined && requestedProjectId !== (parent.projectId ?? null)) {
          fail(response, 400, 'WIKI_PARENT_PROJECT_MISMATCH', PARENT_PROJECT_MISMATCH)
          return
        }
        projectId = parent.projectId ?? null
      }
      if (projectId && !['owner', 'editor'].includes(projectRoleOf(projectOf(auth.tenantId, projectId), auth))) {
        fail(response, 403, 'WIKI_PROJECT_FORBIDDEN', '이 프로젝트에 문서를 만들 권한이 없습니다.')
        return
      }

      const templateId = trimmed(body.templateId, 60) || null
      let templateBlocks = null
      let templateSource = null
      if (templateId) {
        templateSource = documents.find((row) => row?.id === templateId && row?.isTemplate) ?? null
        if (!templateSource || !canReadWikiDocument(templateSource, auth)) {
          fail(response, 404, 'WIKI_TEMPLATE_NOT_FOUND', '템플릿을 찾을 수 없습니다.')
          return
        }
        // 블록 id를 전부 새로 발급한다 — 같은 id를 공유하면 한쪽 문서의 op이 다른 쪽 블록을 가리킨다.
        templateBlocks = instantiateTemplateBlocks(templateSource, { newBlockId })
      }

      const now = nowIso()
      const title = trimmed(body.title, MAX_TITLE) || (templateSource ? clip(templateSource.title, MAX_TITLE) : UNTITLED)
      const blocks = (templateBlocks ?? [{ id: newBlockId(), type: 'text', text: '' }])
        .map((block, index) => ({ ...block, seq: index + 1, editedById: auth.id, editedAt: now }))
      const document = {
        id: freshDocumentId(documents),
        tenantId: auth.tenantId,
        title,
        icon: trimmed(body.icon, MAX_ICON) || (templateSource ? clip(templateSource.icon, MAX_ICON) : ''),
        parentId,
        projectId,
        spaceId: null,
        blocks,
        version: 1,
        blockSeq: blocks.length,
        tombstones: [],
        recentOpIds: [],
        recentLostOpIds: [],
        searchText: buildSearchText(blocks),
        aiLevel: 'indexed',
        summary: '',
        summarySource: 'manual',
        writeScope: 'author',
        isTemplate: false,
        templateId: templateSource ? templateSource.id : null,
        origin: null,
        clientRequestId: clientRequestId || null,
        createdById: auth.id,
        createdByName: auth.name ?? '',
        createdAt: now,
        lastEditedById: auth.id,
        lastEditedByName: auth.name ?? '',
        lastEditedAt: now,
        archivedAt: null,
      }
      // v1에도 이력 한 줄을 남긴다 — 남기지 않으면 가장 오래된 버전이 2가 되어 v1로는 되돌릴 수 없다.
      const revision = buildRevision({
        document,
        result: { ...metaResult(), changed: { ...emptyChange(), inserted: blocks.map((block) => block.id) }, changedCount: blocks.length },
        actorId: auth.id, actorName: auth.name ?? '', now,
      })
      const saved = await saveWiki(auth.tenantId, [document, ...documents], appendRevision(revisionsOf(auth.tenantId), revision), auth.id)
      if (!saved) { fail(response, 500, 'WIKI_WRITE_FAILED', '문서를 저장하지 못했습니다.'); return }
      publishOps(auth.tenantId, document, auth.id, blocks.map((block) => block.id))
      response.status(201).json({ document: publicDocument(document, auth) })
    })
  })

  // 4. 메타데이터 수정
  app.patch('/api/wiki/:id', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const auth = request.auth
    await withWikiLock(auth.tenantId, async () => {
      const documents = documentsOf(auth.tenantId)
      const document = documents.find((row) => row?.id === request.params.id) ?? null
      const body = request.body ?? {}
      // 보관 해제도 PATCH다 — 보관됐다는 이유로 막으면 꺼낼 길이 없다.
      const unarchiving = body.archived === false
      const refusal = writeRefusal(document, auth, { allowArchived: unarchiving })
      if (refusal) { refuse(response, refusal); return }
      if (!Number.isInteger(body.version) || body.version !== Number(document.version)) {
        fail(response, 409, 'WIKI_VERSION_CONFLICT', '그 사이 문서가 바뀌었습니다. 새로 고친 뒤 다시 시도해 주세요.', { currentVersion: Number(document.version) })
        return
      }

      // 한 요청에 시각 하나. 보관 시각과 그때 루트로 올라가는 자식의 시각이 갈라지면 같은 커밋이
      // 두 순간에 일어난 것처럼 이력에 남는다.
      const now = nowIso()
      const next = { ...document }
      let meta = null
      const change = (field, before, after) => { if (!meta) meta = { field, before, after } }

      if (Object.hasOwn(body, 'title')) {
        const title = trimmed(body.title, MAX_TITLE) || UNTITLED
        if (title !== document.title) { next.title = title; change('title', document.title, title) }
      }
      if (Object.hasOwn(body, 'icon')) {
        const icon = trimmed(body.icon, MAX_ICON)
        if (icon !== (document.icon ?? '')) { next.icon = icon; change('icon', document.icon ?? '', icon) }
      }
      if (Object.hasOwn(body, 'summary')) {
        // 요약도 본문이다 — 링크 토큰이 들어오면 본문과 **같은 문**을 지난다(§0-2 계약 5).
        // 쓰기 시점에 인가하지 않으면 볼 수 없는 대상을 가리키는 라벨이 그대로 저장되고,
        // 그 라벨은 목록·검색·AI 컨텍스트 세 곳으로 한꺼번에 나간다.
        const raw = trimmed(body.summary, MAX_SUMMARY)
        const violation = linkViolation(raw, auth)
        if (violation) {
          fail(response, 400, 'WIKI_LINK_UNKNOWN', '연결한 대상을 찾을 수 없거나 열람 권한이 없습니다.', { token: violation })
          return
        }
        const summary = normalizeLinks(raw, auth)
        if (summary !== (document.summary ?? '')) { next.summary = summary; next.summarySource = 'manual' }
      }
      if (Object.hasOwn(body, 'writeScope')) {
        const scope = body.writeScope === 'tenant' ? 'tenant' : 'author'
        if (scope !== (document.writeScope ?? 'author')) { next.writeScope = scope; change('writeScope', document.writeScope ?? 'author', scope) }
      }
      // 보관은 문이 둘이다(여기와 DELETE) — 자식 규칙도 한 벌이어야 한다(`archiveChildPlan`).
      let archivePlan = null
      if (Object.hasOwn(body, 'archived')) {
        const archivedAt = body.archived ? (document.archivedAt ?? now) : null
        if (archivedAt !== (document.archivedAt ?? null)) { next.archivedAt = archivedAt; change('archivedAt', document.archivedAt ?? null, archivedAt) }
        if (body.archived && !document.archivedAt) {
          archivePlan = archiveChildPlan(document, documents, auth, now)
          if (archivePlan.refusal) { refuse(response, archivePlan.refusal); return }
        }
      }

      let aiLevel = aiLevelOf(document)
      if (Object.hasOwn(body, 'aiLevel')) {
        const level = normalizeAiLevel(body.aiLevel)
        if (!level) { fail(response, 400, 'WIKI_AI_LEVEL_INVALID', 'AI 처리 수준을 확인해 주세요.'); return }
        if (level !== aiLevel && !canManageWikiDocument(document, auth)) {
          fail(response, 403, 'WIKI_FORBIDDEN', 'AI 처리 수준은 관리자 또는 작성자만 바꿀 수 있습니다.')
          return
        }
        if (level !== aiLevel) { next.aiLevel = level; change('aiLevel', aiLevel, level); aiLevel = level }
      }

      // 부모·프로젝트는 하위 트리를 함께 움직인다 — 조용히 권한이 바뀌지 않게 movedIds로 말한다.
      let movedIds = []
      let nextProjectId = document.projectId ?? null
      if (Object.hasOwn(body, 'parentId')) {
        const parentId = trimmed(body.parentId, 60) || null
        if (parentId === document.id) { fail(response, 400, 'WIKI_PARENT_SELF', '문서를 자기 자신 아래로 옮길 수 없습니다.'); return }
        if (parentId !== (document.parentId ?? null)) {
          let parent = null
          if (parentId) {
            parent = documents.find((row) => row?.id === parentId) ?? null
            // 새 부모는 **쓸 수 있어야** 한다(생성 라우트와 같은 문장이다) — 읽기만 되는 문서 아래로
            // 남의 문서를 끼워 넣으면 그 부모의 하위 트리를 못 쓰는 사람이 바꾸는 셈이 된다.
            const parentRefusal = writeRefusal(parent, auth)
            if (parentRefusal) {
              if (parentRefusal.status === 404) { fail(response, 404, 'WIKI_PARENT_NOT_FOUND', '상위 문서를 찾을 수 없습니다.'); return }
              refuse(response, parentRefusal)
              return
            }
            if (descendantIds(documents, document.id).has(parentId)) {
              fail(response, 400, 'WIKI_PARENT_CYCLE', '하위 문서 아래로는 옮길 수 없습니다.')
              return
            }
            nextProjectId = parent.projectId ?? null
          }
          next.parentId = parentId
          change('parentId', document.parentId ?? null, parentId)
        }
      }
      if (Object.hasOwn(body, 'projectId')) {
        const requested = trimmed(body.projectId, 60) || null
        // 상속을 덮어쓰지 않는다 — **실효 부모**(이 요청에서 바뀌었으면 새 부모)의 프로젝트와 어긋나면
        // 생성 라우트와 같은 코드·같은 문장으로 거절한다. 한 번 어긋난 트리를 만들면 그 뒤 부모를 옮길 때
        // 하위 문서가 남의 프로젝트에서 통째로 끌려 나온다.
        const effectiveParent = next.parentId ? documents.find((row) => row?.id === next.parentId) ?? null : null
        if (effectiveParent && (effectiveParent.projectId ?? null) !== requested) {
          fail(response, 400, 'WIKI_PARENT_PROJECT_MISMATCH', PARENT_PROJECT_MISMATCH)
          return
        }
        nextProjectId = requested
      }
      // 판정은 '본문에 projectId 필드가 왔는가'가 아니라 **실효 projectId가 바뀌는가**에 건다.
      // parentId 상속으로도 같은 변경이 일어나므로, 두 문 중 어디로 들어와도 같은 답이 나와야 한다
      // (한 자리에만 두지 않으면 한쪽 문이 프로젝트 전용 문서를 전사 공개하는 뒷길이 된다).
      if (nextProjectId !== (document.projectId ?? null)) {
        if (!canManageWikiDocument(document, auth)) {
          fail(response, 403, 'WIKI_FORBIDDEN', '프로젝트 연결은 관리자 또는 작성자만 바꿀 수 있습니다.')
          return
        }
        if (nextProjectId && !['owner', 'editor'].includes(projectRoleOf(projectOf(auth.tenantId, nextProjectId), auth))) {
          fail(response, 403, 'WIKI_PROJECT_FORBIDDEN', '이 프로젝트로 문서를 옮길 권한이 없습니다.')
          return
        }
        // 동반 이동은 **실제로 옮길 수 있는 것**에만 건다. 못 고치는 하위 문서까지 끌고 가면
        // 이 요청과 무관한 사람들의 열람 권한이 조용히 바뀐다 — 하나라도 걸리면 통째로 거절한다.
        // (보관된 자식은 옮긴다. 남겨 두면 부모와 프로젝트가 갈라진 채로 굳는다.)
        // 부모·자식의 프로젝트가 늘 같으므로 여기서 걸리는 자식은 **이 사람에게 보이는** 문서다 —
        // 못 보는 자식이 걸리는 경우는 그 규칙이 없던 시절의 행뿐이고, 그때도 답은 거절이 맞다.
        const descendants = [...descendantIds(documents, document.id)]
        const blocked = descendants.some((id) => writeRefusal(documents.find((row) => row?.id === id), auth, { allowArchived: true }) !== null)
        if (blocked) { refuse(response, MOVE_BLOCKED); return }
        next.projectId = nextProjectId
        change('projectId', document.projectId ?? null, nextProjectId)
        movedIds = [document.id, ...descendants]
      }

      const summaryChanged = (next.summary ?? '') !== (document.summary ?? '')
      if (!meta && !summaryChanged) {
        // 바뀐 것이 없다 — 버전을 태우지 않는다(재전송이 200칸 이력 창을 갉아먹지 않게).
        response.json({ document: publicDocument(document, auth), version: Number(document.version), movedIds: [] })
        return
      }
      if (!meta) {
        // 요약만 바뀌었다. 이력에 남길 사실이 아니라(§1-5의 meta 필드 목록에 요약은 없다) 버전도 올리지 않는다 —
        // 올리면 그 순간 편집 중인 모든 사람의 baseVersion이 무효가 되고, 되돌릴 수 없는 리비전 한 줄이
        // '바뀐 내용이 없습니다'라는 거짓 문장으로 목록에 남는다.
        const saved = await saveWiki(auth.tenantId, documents.map((row) => (row?.id === document.id ? next : row)), null, auth.id)
        if (!saved) { fail(response, 500, 'WIKI_WRITE_FAILED', '문서를 저장하지 못했습니다.'); return }
        response.json({ document: publicDocument(next, auth), version: Number(document.version), movedIds: [] })
        return
      }

      next.version = Number(document.version) + 1
      next.lastEditedById = auth.id
      next.lastEditedByName = auth.name ?? ''
      next.lastEditedAt = now

      // 수준을 낮추면 같은 커밋에서 AI 파생물을 파기한다 — 낮췄다는 말과 남아 있는 파생물은 함께 설 수 없다.
      const rollbackSideEffects = snapshotSideEffects(auth.tenantId)
      const discarded = { summary: false, proposals: 0 }
      if (aiLevelLowered(aiLevelOf(document), aiLevel)) {
        if (next.summarySource === 'ai' && (next.summary ?? '')) { next.summary = ''; next.summarySource = 'manual'; discarded.summary = true }
        discarded.proposals = dropDerivedProposals(auth.tenantId, document.id)
      }

      // 보관하면서 루트로 올라가는 자식도 **이 커밋에** 함께 들어간다(DELETE와 같은 자리, 같은 규칙).
      const reparented = archivePlan ? archivePlan.withOrphans(documents) : documents
      // 딸려 가는 하위 문서에도 **버전과 이력 한 줄**을 남긴다(루트로 올라가는 자식과 같은 규칙).
      // 그 문서의 `projectId`는 곧 그 문서의 열람 범위다 — 조용히 바꾸면 열린 편집 화면이
      // `?since=<옛 버전>`에 204를 받아 범위가 바뀐 사실을 영영 모르고, 되돌리기로도 옛 프로젝트를
      // 되살릴 수 없다(§4-1 원칙 2: 메타데이터 변경도 버전을 올리고 리비전을 남긴다).
      // 같은 커밋에서 루트로도 올라간 자식이라면 **그 결과 위에** 얹는다(두 사실이 각자 한 줄씩 남는다).
      const movedRows = movedIds
        .filter((id) => id !== document.id)
        .map((id) => reparented.find((row) => row?.id === id))
        .filter(Boolean)
        .map((row) => ({
          ...row, projectId: nextProjectId, version: Number(row.version) + 1,
          lastEditedById: auth.id, lastEditedByName: auth.name ?? '', lastEditedAt: now,
        }))
      const movedById = new Map(movedRows.map((row) => [row.id, row]))
      const nextDocuments = reparented.map((row) => {
        if (row?.id === document.id) return next
        return movedById.get(row?.id) ?? row
      })
      const revision = buildRevision({ document: next, result: metaResult(), actorId: auth.id, actorName: auth.name ?? '', now, meta })
      const baseRevisions = appendRevision(revisionsOf(auth.tenantId), revision)
      const withOrphans = archivePlan ? archivePlan.withOrphanRevisions(baseRevisions) : baseRevisions
      const nextRevisions = movedRows.reduce((accumulated, row) => appendRevision(accumulated, buildRevision({
        document: row, result: metaResult(), actorId: auth.id, actorName: auth.name ?? '', now,
        meta: { field: 'projectId', before: document.projectId ?? null, after: nextProjectId },
      })), withOrphans)
      const saved = await saveWiki(auth.tenantId, nextDocuments, nextRevisions, auth.id)
      if (!saved) {
        rollbackSideEffects()
        fail(response, 500, 'WIKI_WRITE_FAILED', '문서를 저장하지 못했습니다.')
        return
      }
      if (archivePlan) { presence.delete(roomKey(auth.tenantId, document.id)); archivePlan.publishOrphans() }
      publishMeta(auth.tenantId, next, meta?.field ?? 'summary')
      for (const row of movedRows) publishMeta(auth.tenantId, row, 'projectId')
      response.json({
        document: publicDocument(next, auth),
        version: next.version,
        movedIds,
        ...(archivePlan ? { reparentedIds: archivePlan.reparentedIds } : {}),
        ...(discarded.summary || discarded.proposals ? { discarded } : {}),
      })
    })
  })

  // 5. 편집(ops)
  app.post('/api/wiki/:id/ops', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const auth = request.auth
    const body = request.body ?? {}
    if (!Number.isInteger(body.baseVersion) || body.baseVersion < 1) {
      fail(response, 400, 'WIKI_OPS_INVALID', '편집 기준 버전을 확인해 주세요.')
      return
    }
    if (!Array.isArray(body.ops) || body.ops.length < 1 || body.ops.length > MAX_OPS_PER_BATCH) {
      fail(response, 400, 'WIKI_OPS_INVALID', `편집은 한 번에 ${MAX_OPS_PER_BATCH}건까지 보낼 수 있습니다.`)
      return
    }
    await withWikiLock(auth.tenantId, async () => {
      const document = documentsOf(auth.tenantId).find((row) => row?.id === request.params.id) ?? null
      const refusal = writeRefusal(document, auth)
      if (refusal) { refuse(response, refusal); return }
      if (body.baseVersion > Number(document.version)) {
        // 서버가 낸 적 없는 버전이다. 낡은 값은 거절하지 않지만 앞선 값은 클라이언트 버그다.
        fail(response, 400, 'WIKI_BASE_VERSION_AHEAD', '서버보다 앞선 버전으로 저장할 수 없습니다. 새로 고쳐 주세요.', { currentVersion: Number(document.version) })
        return
      }

      const attachmentIds = attachmentIdsIn(body.ops)
      const badAttachment = await attachmentViolation(attachmentIds, auth)
      if (badAttachment) {
        fail(response, 400, 'WIKI_ATTACHMENT_FORBIDDEN', '첨부한 자료를 찾을 수 없거나 열람 권한이 없습니다.', { attachmentId: badAttachment })
        return
      }
      const authorized = authorizeOps(body.ops, auth)
      if (authorized.token) {
        fail(response, 400, 'WIKI_LINK_UNKNOWN', '연결한 대상을 찾을 수 없거나 열람 권한이 없습니다.', { token: authorized.token })
        return
      }

      const now = nowIso()
      const result = mergeOps(document, authorized.ops, {
        actorId: auth.id, actorName: auth.name ?? '', now, nameOf: nameOfAccount(auth.tenantId),
      })
      if (result.error) {
        fail(response, MERGE_ERROR_STATUS[result.error] ?? 400, result.error, MERGE_ERROR_MESSAGE[result.error] ?? '편집 내용을 확인해 주세요.', {
          ...(result.blockId ? { blockId: result.blockId } : {}),
          ...(result.field ? { field: result.field } : {}),
          ...(result.reason ? { field: result.reason } : {}),
        })
        return
      }

      if (result.document !== document) {
        // 첨부 검사는 파일 I/O다 — **await를 건넌 뒤에 배열을 다시 읽는다.** 위에서 붙잡아 둔 스냅샷에
        // 대입하면 그 사이 다른 문서에 들어온 저장이 200을 받고도 통째로 되감긴다.
        const nextDocuments = documentsOf(auth.tenantId).map((row) => (row?.id === document.id ? result.document : row))
        let revisions = null
        if (result.versionBumped) {
          const revision = buildRevision({ document: result.document, result, actorId: auth.id, actorName: auth.name ?? '', now })
          revisions = appendRevision(revisionsOf(auth.tenantId), revision)
        }
        const rollbackSideEffects = snapshotSideEffects(auth.tenantId)
        if (attachmentIds.length) shareAttachments(attachmentIds, result.document, auth)
        const saved = await saveWiki(auth.tenantId, nextDocuments, revisions, auth.id)
        if (!saved) {
          rollbackSideEffects()
          fail(response, 500, 'WIKI_WRITE_FAILED', '편집 내용을 저장하지 못했습니다.')
          return
        }
        if (result.versionBumped) {
          const changed = [...result.changed.inserted, ...result.changed.updated, ...result.changed.deleted, ...result.changed.moved]
          publishOps(auth.tenantId, result.document, auth.id, changed)
        }
      }

      const resolve = resolveFor(auth)
      response.json({
        document: publicDocument(result.document, auth),
        version: Number(result.document.version),
        applied: result.applied,
        rejected: result.rejected,
        overwrites: result.overwrites.map((row) => ({ ...row, previousText: redactLinks(row.previousText, resolve) })),
        lostEditCount: result.lostEdits.length,
        presence: rosterOf(auth.tenantId, document.id),
      })
    })
  })

  // 6. 보관 · 완전 삭제
  app.delete('/api/wiki/:id', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const auth = request.auth
    const purge = String(request.query?.purge ?? '') === '1'
    await withWikiLock(auth.tenantId, async () => {
      const documents = documentsOf(auth.tenantId)
      const document = documents.find((row) => row?.id === request.params.id) ?? null
      const refusal = writeRefusal(document, auth, { allowArchived: true })
      if (refusal) { refuse(response, refusal); return }
      const now = nowIso()
      const plan = archiveChildPlan(document, documents, auth, now)
      if (plan.refusal) { refuse(response, plan.refusal); return }
      const { orphans, reparentedIds, withOrphans, withOrphanRevisions, publishOrphans } = plan

      if (purge) {
        if (auth.role !== 'tenant-admin') { fail(response, 403, 'WIKI_FORBIDDEN', '완전 삭제는 회사 관리자만 할 수 있습니다.'); return }
        if (!document.archivedAt) { fail(response, 409, 'WIKI_PURGE_REQUIRES_ARCHIVE', '먼저 보관한 뒤에 완전히 지울 수 있습니다.'); return }
        const nextDocuments = withOrphans(documents).filter((row) => row?.id !== document.id)
        // 이력도 함께 지운다 — 고아 이력은 되돌릴 문서가 없는 채로 테넌트 상한만 먹는다.
        const nextRevisions = withOrphanRevisions(revisionsOf(auth.tenantId).filter((row) => row?.documentId !== document.id))
        const saved = await saveWiki(auth.tenantId, nextDocuments, nextRevisions, auth.id)
        if (!saved) { fail(response, 500, 'WIKI_WRITE_FAILED', '문서를 지우지 못했습니다.'); return }
        presence.delete(roomKey(auth.tenantId, document.id))
        publishMeta(auth.tenantId, document, 'archivedAt')
        publishOrphans()
        // 첨부 원본은 자료실이 정본이라 자동으로 지우지 않는다. 무엇이 남았는지만 알려 준다.
        const orphanCandidates = [...new Set((document.blocks ?? []).map((block) => block?.attachmentId).filter(Boolean))]
        response.json({ ok: true, archived: true, purged: true, orphanCandidates, reparentedIds })
        return
      }
      if (document.archivedAt && !orphans.length) {
        response.json({ ok: true, archived: true, purged: false, orphanCandidates: [], reparentedIds: [] })
        return
      }
      const alreadyArchived = Boolean(document.archivedAt)
      const next = alreadyArchived ? document : {
        ...document, archivedAt: now, version: Number(document.version) + 1,
        lastEditedById: auth.id, lastEditedByName: auth.name ?? '', lastEditedAt: now,
      }
      const baseRevisions = alreadyArchived ? revisionsOf(auth.tenantId) : appendRevision(revisionsOf(auth.tenantId), buildRevision({
        document: next, result: metaResult(), actorId: auth.id, actorName: auth.name ?? '', now,
        meta: { field: 'archivedAt', before: null, after: now },
      }))
      const nextDocuments = withOrphans(documents).map((row) => (row?.id === document.id ? next : row))
      const saved = await saveWiki(auth.tenantId, nextDocuments, withOrphanRevisions(baseRevisions), auth.id)
      if (!saved) { fail(response, 500, 'WIKI_WRITE_FAILED', '문서를 보관하지 못했습니다.'); return }
      presence.delete(roomKey(auth.tenantId, document.id))
      if (!alreadyArchived) publishMeta(auth.tenantId, next, 'archivedAt')
      publishOrphans()
      response.json({ ok: true, archived: true, purged: false, orphanCandidates: [], reparentedIds })
    })
  })

  // 7. 프레즌스
  app.post('/api/wiki/:id/presence', ...guards, (request, response) => {
    if (!requireTenant(request, response)) return
    const auth = request.auth
    const document = readable(auth, request.params.id, response)
    if (!document) return
    const body = request.body ?? {}
    const leaving = body.leaving === true
    // 규격은 `string | null`이다 — 다른 형은 강제로 문자열로 만들지 않고 그 자리에서 400으로 접는다.
    const blockId = body.blockId == null ? null : body.blockId
    if (!leaving && blockId !== null) {
      if (typeof blockId !== 'string' || !BLOCK_ID_RE.test(blockId) || !(document.blocks ?? []).some((block) => block?.id === blockId)) {
        fail(response, 400, 'WIKI_PRESENCE_INVALID', '이 문서에 없는 문단입니다.')
        return
      }
    }
    const key = roomKey(auth.tenantId, document.id)
    const at = clock().getTime()
    sweepIdleRooms(at)
    sweepRoom(key, at)
    const room = presence.get(key) ?? new Map()
    const before = room.get(auth.id)
    if (leaving) {
      room.delete(auth.id)
      if (room.size) presence.set(key, room)
      else presence.delete(key)
      if (before) events.publishEphemeral(auth.tenantId, 'wiki', { change: 'presence', documentId: document.id, roster: rosterOf(auth.tenantId, document.id) }, audienceOf(auth.tenantId, document))
      response.json({ roster: rosterOf(auth.tenantId, document.id), version: Number(document.version), ttlMs: PRESENCE_TTL_MS })
      return
    }
    // 같은 자리에서 너무 자주 부르면 갱신도 발행도 하지 않는다(429는 로그만 시끄럽고 화면이 할 일이 없다).
    const tooSoon = before && before.blockId === blockId && at - before.at < PRESENCE_MIN_INTERVAL_MS
    if (!tooSoon) {
      room.set(auth.id, { name: auth.name ?? '', blockId, at })
      presence.set(key, room)
      if (!before || before.blockId !== blockId) {
        events.publishEphemeral(auth.tenantId, 'wiki', { change: 'presence', documentId: document.id, roster: rosterOf(auth.tenantId, document.id) }, audienceOf(auth.tenantId, document))
      }
    }
    response.json({ roster: rosterOf(auth.tenantId, document.id), version: Number(document.version), ttlMs: PRESENCE_TTL_MS })
  })

  // 8. 이력 목록
  app.get('/api/wiki/:id/revisions', ...guards, (request, response) => {
    if (!requireTenant(request, response)) return
    const auth = request.auth
    const document = readable(auth, request.params.id, response)
    if (!document) return
    const rows = revisionsFor(auth.tenantId, document.id)
    const before = Number.parseInt(String(request.query?.before ?? ''), 10)
    const limit = Math.min(Math.max(Number.parseInt(String(request.query?.limit ?? ''), 10) || MAX_REVISION_PAGE, 1), MAX_REVISION_PAGE)
    const page = (Number.isInteger(before) ? rows.filter((row) => Number(row.version) < before) : rows).slice(0, limit)
    response.json({
      revisions: page.map(revisionListItem),
      oldestVersion: oldestRevisionVersion(rows),
      retention: revisionRetention(),
    })
  })

  // 9. 이력 한 건
  app.get('/api/wiki/:id/revisions/:version', ...guards, (request, response) => {
    if (!requireTenant(request, response)) return
    const auth = request.auth
    const document = readable(auth, request.params.id, response)
    if (!document) return
    const version = Number.parseInt(String(request.params.version), 10)
    if (!Number.isInteger(version) || version < 1) { fail(response, 400, 'WIKI_VERSION_INVALID', '버전 번호를 확인해 주세요.'); return }
    const rows = revisionsFor(auth.tenantId, document.id)
    const blocks = reconstructBlocks(document, rows, version)
    if (!blocks) { fail(response, 410, 'WIKI_REVISION_UNAVAILABLE', '보관 기간이 지나 이 버전은 더 이상 되살릴 수 없습니다.'); return }
    const previous = version > 1 ? reconstructBlocks(document, rows, version - 1) : []
    const header = revisionHeaderAt(rows, version)
    const row = rows.find((entry) => Number(entry.version) === version) ?? null
    const resolve = resolveFor(auth)
    response.json({
      version,
      title: header?.title ?? document.title,
      icon: header?.icon ?? '',
      blocks: blocks.map((block) => redactBlock(block, resolve)),
      diff: diffBlocks(previous ?? [], blocks, resolve),
      overwrites: (row?.overwrites ?? []).map((entry) => ({ ...entry, previousText: redactLinks(entry.previousText, resolve) })),
      lostEdits: (row?.lostEdits ?? []).map((entry) => ({ ...entry, text: redactLinks(entry.text, resolve) })),
    })
  })

  // 10. 되돌리기
  app.post('/api/wiki/:id/restore', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const auth = request.auth
    await withWikiLock(auth.tenantId, async () => {
      const documents = documentsOf(auth.tenantId)
      const document = documents.find((row) => row?.id === request.params.id) ?? null
      const refusal = writeRefusal(document, auth)
      if (refusal) { refuse(response, refusal); return }
      const body = request.body ?? {}
      const version = Number(body.version)
      if (!Number.isInteger(version) || version < 1) { fail(response, 400, 'WIKI_VERSION_INVALID', '버전 번호를 확인해 주세요.'); return }
      // ops와 달리 되돌리기는 거절한다 — 그 뒤의 모든 변경을 문서에서 걷어내는 파괴적 조작이다.
      if (!Number.isInteger(body.expectedCurrentVersion) || body.expectedCurrentVersion !== Number(document.version)) {
        fail(response, 409, 'WIKI_RESTORE_STALE', '그 사이 문서가 바뀌었습니다. 다시 확인한 뒤 되돌려 주세요.', { currentVersion: Number(document.version) })
        return
      }
      const rows = revisionsFor(auth.tenantId, document.id)
      const target = reconstructBlocks(document, rows, version)
      if (!target) { fail(response, 410, 'WIKI_REVISION_UNAVAILABLE', '보관 기간이 지나 이 버전은 더 이상 되살릴 수 없습니다.'); return }

      const now = nowIso()
      const ops = diffToOps(document.blocks ?? [], target)
      const result = mergeOps(document, ops, {
        actorId: auth.id, actorName: auth.name ?? '', now, nameOf: nameOfAccount(auth.tenantId), restore: true,
      })
      if (result.error) {
        fail(response, MERGE_ERROR_STATUS[result.error] ?? 400, result.error, MERGE_ERROR_MESSAGE[result.error] ?? '되돌리지 못했습니다.')
        return
      }
      if (!result.versionBumped) {
        response.json({ document: publicDocument(document, auth), version: Number(document.version), restoredFrom: version })
        return
      }
      const header = revisionHeaderAt(rows, version)
      const restored = { ...result.document, ...(header ? { title: header.title || UNTITLED, icon: header.icon } : {}) }
      const revision = buildRevision({ document: restored, result, actorId: auth.id, actorName: auth.name ?? '', now, restoredFrom: version })
      const saved = await saveWiki(
        auth.tenantId,
        documents.map((row) => (row?.id === document.id ? restored : row)),
        appendRevision(revisionsOf(auth.tenantId), revision),
        auth.id,
      )
      if (!saved) { fail(response, 500, 'WIKI_WRITE_FAILED', '되돌린 내용을 저장하지 못했습니다.'); return }
      const changed = [...result.changed.inserted, ...result.changed.updated, ...result.changed.deleted, ...result.changed.moved]
      publishOps(auth.tenantId, restored, auth.id, changed)
      response.json({ document: publicDocument(restored, auth), version: Number(restored.version), restoredFrom: version })
    })
  })

  // 11. 문장 하나만 되살리기
  app.post('/api/wiki/:id/revisions/:version/blocks/:blockId/reinstate', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const auth = request.auth
    await withWikiLock(auth.tenantId, async () => {
      const documents = documentsOf(auth.tenantId)
      const document = documents.find((row) => row?.id === request.params.id) ?? null
      const refusal = writeRefusal(document, auth)
      if (refusal) { refuse(response, refusal); return }
      const version = Number.parseInt(String(request.params.version), 10)
      if (!Number.isInteger(version) || version < 1) { fail(response, 400, 'WIKI_VERSION_INVALID', '버전 번호를 확인해 주세요.'); return }
      const rows = revisionsFor(auth.tenantId, document.id)
      const row = rows.find((entry) => Number(entry.version) === version)
      if (!row) { fail(response, 410, 'WIKI_REVISION_UNAVAILABLE', '보관 기간이 지나 이 버전은 더 이상 되살릴 수 없습니다.'); return }
      const source = reinstateSource(row, request.params.blockId)
      const current = (document.blocks ?? []).find((block) => block?.id === request.params.blockId)
      if (!source || !current || typeof current.text !== 'string') {
        fail(response, 404, 'WIKI_BLOCK_NOT_FOUND', '되살릴 문단을 찾을 수 없습니다.')
        return
      }
      const now = nowIso()
      const ops = [{
        opId: `OP-RST${String(version)}-${Date.now().toString(36).toUpperCase()}`,
        kind: 'update',
        blockId: current.id,
        baseSeq: Number(current.seq ?? 0),
        block: { type: current.type, text: source.text },
      }]
      const result = mergeOps(document, ops, {
        actorId: auth.id, actorName: auth.name ?? '', now, nameOf: nameOfAccount(auth.tenantId), restore: true,
      })
      if (result.error) {
        fail(response, MERGE_ERROR_STATUS[result.error] ?? 400, result.error, MERGE_ERROR_MESSAGE[result.error] ?? '되살리지 못했습니다.')
        return
      }
      if (!result.versionBumped) {
        response.json({ document: publicDocument(document, auth), version: Number(document.version) })
        return
      }
      const revision = buildRevision({ document: result.document, result, actorId: auth.id, actorName: auth.name ?? '', now })
      const saved = await saveWiki(
        auth.tenantId,
        documents.map((entry) => (entry?.id === document.id ? result.document : entry)),
        appendRevision(revisionsOf(auth.tenantId), revision),
        auth.id,
      )
      if (!saved) { fail(response, 500, 'WIKI_WRITE_FAILED', '되살린 문장을 저장하지 못했습니다.'); return }
      publishOps(auth.tenantId, result.document, auth.id, [current.id])
      response.json({ document: publicDocument(result.document, auth), version: Number(result.document.version) })
    })
  })

  // 12. 내 템플릿으로 저장
  app.post('/api/wiki/:id/save-as-template', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const auth = request.auth
    await withWikiLock(auth.tenantId, async () => {
      const documents = documentsOf(auth.tenantId)
      const document = documents.find((row) => row?.id === request.params.id) ?? null
      if (!document || !canReadWikiDocument(document, auth)) { fail(response, 404, 'WIKI_NOT_FOUND', '문서를 찾을 수 없거나 열람 권한이 없습니다.'); return }
      // 이 문만의 조건이 먼저다 — 남의 문서를 내 서식으로 가져가지 않는다.
      // (읽기 판정 뒤에 둔다. 앞에 두면 `createdById`를 읽는 것만으로 못 보는 문서의 존재가 드러난다.)
      if (auth.role !== 'tenant-admin' && document.createdById !== auth.id) {
        fail(response, 403, 'WIKI_TEMPLATE_FORBIDDEN', '내가 만든 문서만 템플릿으로 저장할 수 있습니다.')
        return
      }
      // 문서 상태(보관·시스템 템플릿)와 프로젝트 역할은 **PATCH·ops와 같은 한 자리**가 답한다.
      // 여기서 따로 적으면 같은 문서에 대해 한 문은 409/403인데 이 문만 201이 되고, 그 프로젝트에
      // 문서를 만들 수 없는 뷰어가 이 문으로 그 프로젝트의 문서 행을 만든다(템플릿도 문서 행이다).
      const refusal = writeRefusal(document, auth)
      if (refusal) { refuse(response, refusal); return }
      const name = trimmed(request.body?.name, MAX_TITLE)
      if (!name) { fail(response, 400, 'WIKI_TITLE_REQUIRED', '템플릿 이름을 입력해 주세요.'); return }
      // 템플릿도 문서 행이다 — 정문이 409를 내는 상태에서 이 문으로 상한을 넘길 수 없다.
      const limit = documentLimitRefusal(documents)
      if (limit) { refuse(response, limit); return }
      const now = nowIso()
      // 링크는 **이름 없는 자리표시자**가 된다. 라벨만 벗기면(`stripLinks`) 서버가 채워 넣은 대상의
      // 현재 제목이 재인가할 수 없는 평문으로 남아, 볼 수 없는 문서·업무·사람의 이름이 템플릿을 통해
      // 테넌트 전원에게 열린다. 템플릿은 빈 서식이므로 특정 대상을 가리키는 링크를 옮길 이유도 없다.
      // `attachmentId`는 그대로 둔다 — image·file 블록의 필수 필드라 지우면 규격을 벗어난 블록이 되고,
      // 파일 이름·내용은 어느 경로에서든 `canReadDocument`로 다시 인가한다(§D7).
      const blocks = (document.blocks ?? []).map((block, index) => {
        const next = { ...block, id: newBlockId(), seq: index + 1, editedById: auth.id, editedAt: now }
        if (typeof block.text === 'string') next.text = neutralizeLinks(block.text)
        if (Array.isArray(block.rows)) next.rows = block.rows.map((row) => (row ?? []).map((cell) => neutralizeLinks(cell)))
        delete next.workItemId
        return next
      })
      const template = {
        ...document,
        id: freshDocumentId(documents),
        tenantId: auth.tenantId,
        title: name,
        parentId: null,
        blocks,
        version: 1,
        blockSeq: blocks.length,
        tombstones: [],
        recentOpIds: [],
        recentLostOpIds: [],
        searchText: buildSearchText(blocks),
        // 요약도 본문과 같은 규칙이다 — 템플릿에서는 링크가 자리표시자가 된다.
        summary: neutralizeLinks(trimmed(request.body?.description, MAX_SUMMARY)),
        summarySource: 'manual',
        isTemplate: true,
        templateId: null,
        origin: { kind: 'user', label: '내 템플릿' },
        clientRequestId: null,
        createdById: auth.id,
        createdByName: auth.name ?? '',
        createdAt: now,
        lastEditedById: auth.id,
        lastEditedByName: auth.name ?? '',
        lastEditedAt: now,
        archivedAt: null,
      }
      const saved = await saveWiki(auth.tenantId, [template, ...documents], null, auth.id)
      if (!saved) { fail(response, 500, 'WIKI_WRITE_FAILED', '템플릿을 저장하지 못했습니다.'); return }
      response.status(201).json({ template: publicDocument(template, auth) })
    })
  })

  // 13. 블록 → 업무
  app.post('/api/wiki/:id/blocks/:blockId/task', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const auth = request.auth
    await withWikiLock(auth.tenantId, async () => {
      const documents = documentsOf(auth.tenantId)
      const document = documents.find((row) => row?.id === request.params.id) ?? null
      const refusal = writeRefusal(document, auth)
      if (refusal) { refuse(response, refusal); return }
      const block = (document.blocks ?? []).find((entry) => entry?.id === request.params.blockId)
      if (!block) { fail(response, 404, 'WIKI_BLOCK_NOT_FOUND', '문단을 찾을 수 없습니다.'); return }
      const resolve = resolveFor(auth)
      const fallback = stripLinks(redactLinks(typeof block.text === 'string' ? block.text : '', resolve)).split('\n')[0]
      const title = trimmed(request.body?.title, 120) || trimmed(fallback, 120)
      if (!title) { fail(response, 400, 'WIKI_TITLE_REQUIRED', '업무 제목을 입력해 주세요.'); return }
      const now = nowIso()
      const origin = {
        kind: 'wiki',
        label: '문서에서 만든 업무',
        detail: clip(document.title, 120),
        page: 'wiki',
        focusId: document.id,
      }
      /**
       * 담당자 이름 → 계정. **승인 큐와 같은 규칙 한 벌**을 쓴다(`uniqueTenantAccountByName`:
       * 같은 이름이 둘이면 고르지 않는다). 따로 적으면 같은 '박지현'이 이 문에서는 첫 행,
       * 승인 큐에서는 아무에게도 가지 않아 문마다 다른 사람에게 문서 제목이 배달된다.
       * 못 고르면 승인 큐와 같이 요청자에게 떨어진다.
       */
      const ownerName = trimmed(request.body?.owner, 60)
      const ownerAccount = ownerName ? uniqueTenantAccountByName(auth.tenantId, ownerName) : null

      if (auth.role === 'tenant-admin') {
        if (block.workItemId) { fail(response, 409, 'WIKI_TASK_DUPLICATE', '이 문단에서 만든 업무가 이미 있습니다.'); return }
        const due = dueAt(request.body?.due) ?? new Date(clock().getTime() + 2 * 24 * 60 * 60 * 1_000).toISOString()
        const workItem = {
          id: newWorkItemId(workItemsOf(auth.tenantId)),
          title,
          description: clip(document.title, 2_000),
          owner: ownerAccount?.name ?? auth.name ?? '',
          ownerId: ownerAccount?.id ?? auth.id,
          requestedBy: auth.name ?? '',
          requesterId: auth.id,
          due,
          priority: '보통',
          status: '업무요청',
          category: '문서 검토',
          createdAt: now,
          origin,
        }
        const normalized = normalizeAdminWorkItems([workItem], auth.tenantId, operatorAwareAccounts(auth))
        if (!normalized) { fail(response, 400, 'WIKI_TITLE_REQUIRED', '담당자 또는 업무 정보를 확인해 주세요.'); return }
        // 배열 저장 문(`app.mjs` PUT /api/workspace/work-items)이 정규화 뒤에 거는 것과 **같은 한 벌**이다.
        // 여기서 빼면 정문이 거절하는 행(외부 게스트 담당 + projectId 없음)이 이 문으로 들어와,
        // 그 행 하나 때문에 업무 화면이 **읽은 그대로 되쓰기조차** 400으로 막힌다.
        const guestRefusal = guestWorkItemViolation(normalized, accounts, guestGrantOf)
        if (guestRefusal) { fail(response, 400, guestRefusal.code, guestRefusal.message); return }
        const tenantStore = tenantStoreOf(auth.tenantId)
        const previousWork = tenantStore[WORK_ITEMS_KEY]
        const current = Array.isArray(previousWork?.data) ? previousWork.data : []
        tenantStore[WORK_ITEMS_KEY] = { data: prependWithinCap(current, normalized[0], 1_000), updatedAt: now, updatedBy: auth.id }
        // 업무 생성과 블록 역링크 스탬프는 한 커밋에 들어간다 — 갈라지면 업무는 있는데
        // 문서에서 되짚을 수 없거나, 링크는 있는데 업무가 없는 상태가 남는다.
        const nextDocument = {
          ...document,
          blocks: (document.blocks ?? []).map((entry) => (entry?.id === block.id ? { ...entry, workItemId: normalized[0].id } : entry)),
          version: Number(document.version) + 1,
          lastEditedById: auth.id,
          lastEditedByName: auth.name ?? '',
          lastEditedAt: now,
        }
        const revision = buildRevision({
          document: nextDocument,
          result: { ...metaResult(), changed: { ...emptyChange(), updated: [block.id] }, changedCount: 1 },
          actorId: auth.id, actorName: auth.name ?? '', now,
        })
        const saved = await saveWiki(
          auth.tenantId,
          documents.map((row) => (row?.id === document.id ? nextDocument : row)),
          appendRevision(revisionsOf(auth.tenantId), revision),
          auth.id,
        )
        if (!saved) {
          if (previousWork) tenantStore[WORK_ITEMS_KEY] = previousWork
          else delete tenantStore[WORK_ITEMS_KEY]
          fail(response, 500, 'WIKI_WRITE_FAILED', '업무를 저장하지 못했습니다.')
          return
        }
        events.publish(auth.tenantId, 'work', { key: WORK_ITEMS_KEY, taskId: normalized[0].id })
        publishOps(auth.tenantId, nextDocument, auth.id, [block.id])
        response.status(201).json({ mode: 'created', workItem: normalized[0], document: publicDocument(nextDocument, auth), version: nextDocument.version })
        return
      }

      // 직원은 승인 큐를 거친다. 막는 수준은 '보관만' **하나**다(§3-8) —
      // 이 승격은 AI 파생이 아니라 사람이 누른 것이고 제목도 사람이 쓴 문단에서 온다.
      // `aiMayDerive`('활용'만 참)로 막으면 기본값 '정리'로 태어나는 **모든 새 문서**에서
      // 직원의 주 경로가 죽고, 수준을 올리는 것은 canManage라 스스로 풀 수도 없다.
      if (aiLevelOf(document) === 'locked') {
        fail(response, 403, 'AI_DERIVATION_LOCKED', `AI 처리 수준이 ‘${AI_LEVEL_LABELS.locked}’인 문서에서는 업무 제안을 만들 수 없습니다.`)
        return
      }
      // 승인하는 순간 만들어질 업무를 지금 미리 재 본다. 제안이 담고 있는 배정이 승인 문에서
      // 어차피 거절될 것이라면, 관리자를 기다리게 하지 말고 누른 사람에게 **같은 문장**으로 답한다.
      const queuedGuestRefusal = guestWorkItemViolation(
        [{ ownerId: ownerAccount?.id ?? auth.id, requesterId: auth.id }], accounts, guestGrantOf,
      )
      if (queuedGuestRefusal) { fail(response, 400, queuedGuestRefusal.code, queuedGuestRefusal.message); return }
      const rollbackSideEffects = snapshotSideEffects(auth.tenantId)
      // 알림·SSE는 커밋 뒤에 낸다(`announce:false`) — 되돌릴 수 없는 것은 되돌릴 수 있는 것 **뒤에** 선다.
      // 앞에 세우면 커밋 실패로 제안이 사라진 뒤에도 그 제안을 가리키는 알림만 관리자에게 남는다.
      const proposal = {
        id: newProposalId(),
        kind: 'wiki-task',
        status: 'pending',
        // 같은 문단에서 두 번 눌러도 대기 중인 제안은 하나다.
        sourceKey: `wiki:${document.id}:${block.id}`,
        summary: title,
        evidence: `${document.title} · 문서 문단`,
        confidence: null,
        payload: {
          title,
          description: clip(document.title, 2_000),
          owner: ownerName,
          due: dueAt(request.body?.due) ?? '',
          priority: '보통',
          category: '문서 검토',
          documentId: document.id,
          blockId: block.id,
        },
        createdAt: now,
        createdBy: auth.id,
      }
      const queued = enqueueProposal(auth.tenantId, proposal, { announce: false })
      if (queued) {
        try { await commitWorkspaceStore() } catch {
          // 저장하지 못한 제안을 '올렸습니다'라고 답하면, 사람은 승인 큐에서 그것을 찾다가 못 찾는다.
          rollbackSideEffects()
          fail(response, 500, 'WIKI_WRITE_FAILED', '업무 제안을 저장하지 못했습니다.')
          return
        }
        announceProposal(auth.tenantId, proposal)
      }
      const pendingCount = proposalsOf(auth.tenantId).filter((item) => item?.status === 'pending').length
      // 아직 업무가 아니므로 블록에 역링크를 찍지 않는다.
      response.status(201).json({ mode: 'queued', queued, pendingCount, document: publicDocument(document, auth), version: Number(document.version) })
    })
  })

  // 14. 내보내기
  app.get('/api/wiki/:id/export', ...guards, (request, response) => {
    if (!requireTenant(request, response)) return
    const auth = request.auth
    const document = readable(auth, request.params.id, response)
    if (!document) return
    // 사용자가 쓴 본문을 앱 오리진에서 그대로 내보낸다 — 자료 내려받기(`GET /api/documents/:id/download`)와
    // **같은 두 줄**을 두른다. 브라우저가 이 응답을 문서로 열지 않게 하고(`attachment`), 선언한
    // content-type 말고 다른 것으로 스니핑하지 않게 한다(`nosniff`). 화면의 말('문서를 내려받습니다')과
    // 파일 이름이 맞는 것은 덤이다.
    response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(exportFileName(document))}`)
    response.type('text/markdown; charset=utf-8').send(wikiPlainText(document, resolveFor(auth)))
  })

  // ── 문서 트리 도우미 ──────────────────────────────────────────────────────
  function descendantIds(documents, rootId) {
    const found = new Set()
    let frontier = [rootId]
    while (frontier.length) {
      const next = []
      for (const row of documents) {
        if (!row?.parentId || found.has(row.id) || row.id === rootId) continue
        if (frontier.includes(row.parentId)) { found.add(row.id); next.push(row.id) }
      }
      frontier = next
    }
    return found
  }

  /** AI 처리 수준을 낮췄을 때 이 문서를 가리키는 대기 중 파생 제안을 걷어낸다. */
  function dropDerivedProposals(tenantId, documentId) {
    const existing = proposalsOf(tenantId)
    const derived = new Set(['document-classification', 'lens-task', 'wiki-task'])
    const next = existing.filter((item) => !(item?.status === 'pending' && derived.has(item?.kind)
      && (item?.payload?.documentId === documentId || item?.sourceKey === `doc:${documentId}` || String(item?.sourceKey ?? '').startsWith(`wiki:${documentId}:`))))
    if (next.length === existing.length) return 0
    writeProposals(tenantId, next, 'system:ai-policy')
    return existing.length - next.length
  }

  // ── app.mjs가 쓰는 손잡이 ─────────────────────────────────────────────────

  /**
   * 렌즈 입력. `POST /api/documents/:id/lens`가 `WDOC-` id를 받을 때 부른다.
   * 못 읽는 문서는 null(라우트가 자료와 **같은 404**로 답한다 — 위키 코드가 새지 않는다).
   */
  const wikiLensSourceOf = (auth, id) => {
    if (!auth?.tenantId) return null
    const document = findDocument(auth, id)
    if (!document || !canReadWikiDocument(document, auth)) return null
    if (!aiMayReadBody(aiLevelOf(document))) return { blocked: true, document, name: document.title || UNTITLED, text: '' }
    return { blocked: false, document, name: document.title || UNTITLED, text: wikiPlainText(document, resolveFor(auth)) }
  }

  /**
   * `/api/chat` 컨텍스트에 실을 문서 목록. **제목과 사람이 적은 요약만** 나간다.
   *
   * 요약이 비었다고 본문 앞 200자로 채우지 않는다 — 그 200자도 본문이고, 이 배열은 시스템 프롬프트에
   * 통째로 실려 매 대화마다 모델로 간다. "본문은 명시 첨부로만 모델에 간다"는 선은 자료에 이미 그어져
   * 있고(`chat-document-integration.test.mjs`), 문서라고 느슨해질 이유가 없다.
   * 템플릿도 뺀다: 회사의 내용이 아니라 빈 서식이고 40칸 중 네 칸을 먹는다.
   */
  const wikiAiContext = (auth, limit = 40) => {
    if (!auth?.tenantId) return []
    return documentsOf(auth.tenantId)
      .filter((row) => !row?.archivedAt && !row?.isTemplate && canReadWikiDocument(row, auth) && aiMayList(aiLevelOf(row)))
      .sort((left, right) => String(right.lastEditedAt ?? '').localeCompare(String(left.lastEditedAt ?? '')))
      .slice(0, limit)
      .map((row) => ({
        id: row.id,
        title: row.title,
        // 요약은 사람이 적은 문장이고 링크 토큰이 섞일 수 있다 — 모델로 보내기 전에도 재인가한다.
        summary: redactLinks(row.summary ?? '', resolveFor(auth)),
        updatedAt: row.lastEditedAt ?? null,
        editedBy: row.lastEditedByName ?? '',
      }))
  }

  /**
   * 프로젝트가 지워질 때 그 프로젝트의 문서를 **보관 처리**한다.
   *
   * 왜 이 문이 있는가: 프로젝트 행이 사라지면 그 프로젝트를 가리키는 문서는 열람 판정에서 미아가 된다.
   * 손대지 않고 두면 그 행은 목록·상세·검색·내보내기·이력·PATCH·보관·완전삭제 어디로도 사실상 닿지
   * 않은 채 회사 문서 상한 한 칸을 계속 먹고, 보관된 적이 없으니 스윕도 걷어 가지 않는다.
   *
   * 왜 `projectId: null`(전사)이 아니라 보관인가: 멤버 전용 프로젝트를 지우는 것만으로 그 안의 문서가
   * 회사 전체 공개가 되면, 삭제가 열람 범위를 넓히는 뒷문이 된다. 보관은 아무 범위도 넓히지 않고,
   * 30일 뒤 스윕이 스스로 걷어 가며, 그 사이 관리자가 꺼내 전사로 올릴 수 있다(미아도 관리자에게는 열려 있다).
   *
   * **커밋은 부르는 쪽이 한다**(규칙 9) — 프로젝트 행 삭제와 이 보관은 한 커밋에 들어가고 함께 되돌아간다.
   * 갈라 두면 프로젝트만 사라지고 문서는 그대로거나, 그 반대가 된다.
   *
   * @param commit 커밋 함수(성공하면 true). 실패하면 여기서 위키 두 키를 되돌리고 null을 돌려준다.
   * @param audienceIds 지우기 직전 그 프로젝트를 읽을 수 있던 사람들. 보관 신호가 갈 곳이다.
   */
  const archiveProjectWikiDocuments = (tenantId, projectId, actor, { commit, audienceIds = [] }) => (
    withWikiLock(tenantId, async () => {
      const tenantStore = tenantStoreOf(tenantId)
      const beforeDocuments = tenantStore[WIKI_DOCUMENTS_KEY]
      const beforeRevisions = tenantStore[WIKI_REVISIONS_KEY]
      const now = nowIso()
      const doomedIds = new Set(documentsOf(tenantId)
        .filter((row) => row?.projectId === projectId && !row?.archivedAt)
        .map((row) => row.id))
      let archived = []
      if (doomedIds.size) {
        const nextDocuments = documentsOf(tenantId).map((row) => (doomedIds.has(row?.id) ? {
          ...row, archivedAt: now, version: Number(row.version) + 1,
          lastEditedById: actor.id, lastEditedByName: actor.name ?? '', lastEditedAt: now,
        } : row))
        archived = nextDocuments.filter((row) => doomedIds.has(row.id))
        const nextRevisions = archived.reduce((rows, row) => appendRevision(rows, buildRevision({
          document: row, result: metaResult(), actorId: actor.id, actorName: actor.name ?? '', now,
          meta: { field: 'archivedAt', before: null, after: now },
        })), revisionsOf(tenantId))
        tenantStore[WIKI_DOCUMENTS_KEY] = { data: nextDocuments, updatedAt: now, updatedBy: actor.id }
        tenantStore[WIKI_REVISIONS_KEY] = { data: nextRevisions, updatedAt: now, updatedBy: actor.id }
      }
      if (!(await commit())) {
        if (beforeDocuments) tenantStore[WIKI_DOCUMENTS_KEY] = beforeDocuments
        else delete tenantStore[WIKI_DOCUMENTS_KEY]
        if (beforeRevisions) tenantStore[WIKI_REVISIONS_KEY] = beforeRevisions
        else delete tenantStore[WIKI_REVISIONS_KEY]
        return null
      }
      const audience = { accountIds: [...new Set([...audienceIds, ...tenantAdminIds(tenantId)])] }
      for (const row of archived) {
        presence.delete(roomKey(tenantId, row.id))
        publishMeta(tenantId, row, 'archivedAt', audience)
      }
      return { archivedIds: archived.map((row) => row.id) }
    })
  )

  /** 보관한 지 30일이 지난 문서와 그 이력을 완전히 없앤다(스케줄러). */
  const sweepWikiArchive = async (at) => {
    const now = at instanceof Date ? at : new Date(at ?? clock())
    if (!Number.isFinite(now.getTime())) throw new TypeError('sweepWikiArchive: now(Date 또는 ISO 문자열)를 확인해 주세요.')
    const cutoff = new Date(now.getTime() - ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1_000).toISOString()
    let removed = 0
    for (const tenantId of Object.keys(workspaceStore.tenants ?? {})) {
      // 흔한 경우(지울 것이 없다)는 락을 잡지 않는다 — 매일 두 번 도는 잡이 남의 쓰기 앞을 막지 않게.
      if (!documentsOf(tenantId).some((row) => row?.archivedAt && String(row.archivedAt) < cutoff)) continue
      // 스윕도 `wiki-documents` 레코드를 **통째로** 쓴다. 라우트와 같은 줄에 서지 않으면 이 스윕의
      // 커밋 실패 롤백이 그 사이 201/200을 받은 사람의 저장을 말없이 지운다 —
      // 직렬화 단위는 롤백 단위와 같아야 한다(`withWikiLock` 주석). 하루 두 번이라 처리량 손실이 없다.
      removed += await withWikiLock(tenantId, async () => {
        const documents = documentsOf(tenantId)
        const doomed = documents.filter((row) => row?.archivedAt && String(row.archivedAt) < cutoff)
        if (!doomed.length) return 0
        const doomedIds = new Set(doomed.map((row) => row.id))
        // 안전망: 지워지는 문서를 가리키는 parentId를 여기서 끊는다. 정문(보관)이 이미 자식을 루트로
        // 올려 두지만, 그 규칙이 없던 시절의 행이 남아 있으면 부모 없는 parentId가 영영 매달린다.
        const keptDocuments = documents
          .filter((row) => !doomedIds.has(row?.id))
          .map((row) => (row?.parentId && doomedIds.has(row.parentId) ? { ...row, parentId: null } : row))
        const keptRevisions = revisionsOf(tenantId).filter((row) => !doomedIds.has(row?.documentId))
        return await saveWiki(tenantId, keptDocuments, keptRevisions, 'system:wiki-archive-sweep') ? doomed.length : 0
      })
    }
    return { removed }
  }

  /** 1년이 지났거나 테넌트 상한을 넘은 이력을 오래된 것부터 정리한다(스케줄러). */
  const sweepWikiRevisions = async (at) => {
    const now = at instanceof Date ? at : new Date(at ?? clock())
    if (!Number.isFinite(now.getTime())) throw new TypeError('sweepWikiRevisions: now(Date 또는 ISO 문자열)를 확인해 주세요.')
    const iso = now.toISOString()
    let removed = 0
    for (const tenantId of Object.keys(workspaceStore.tenants ?? {})) {
      if (!revisionsOf(tenantId).length) continue
      // 이력만 줄여도 `saveWiki`는 두 키를 함께 쓰고 롤백도 함께 되돌린다 — 문서 스윕과 같은 이유로
      // 같은 줄에 선다(위 `sweepWikiArchive` 주석).
      removed += await withWikiLock(tenantId, async () => {
        const rows = revisionsOf(tenantId)
        if (!rows.length) return 0
        const result = pruneTenantRevisions(rows, { now: iso })
        if (!result.removed) return 0
        return await saveWiki(tenantId, documentsOf(tenantId), result.kept, 'system:wiki-revision-sweep') ? result.removed : 0
      })
    }
    return { removed }
  }

  return { canReadWikiDocument, wikiLensSourceOf, wikiAiContext, archiveProjectWikiDocuments, sweepWikiArchive, sweepWikiRevisions }
}

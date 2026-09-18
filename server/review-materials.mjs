import { createHash, randomBytes } from 'node:crypto'
import { Worker } from 'node:worker_threads'

import { deleteTenantDocument, getTenantDocument, putTenantDocument } from './document-storage-service.mjs'
import { GUEST_ROLE } from './guest-access.mjs'
import { frameDocument } from './material-bridge.mjs'
import { decodeMaterialBytes } from './material-html.mjs'
import { AUTHORING_RULES, DECISIONS, decisionRecordBlocks, decisionSummaryMarkdown, decisionsCsv, extractReviewBlocks, nextVersionRequestMarkdown, planImportedReviews } from './material-decisions.mjs'
import { createStoredZip, safeArchiveSegment } from './stored-zip.mjs'
import { carryOverSummary, finalizeLinks, matchAnchors, wordDiff } from './material-lineage.mjs'
import { newMeetingBlockId } from './meeting-summary.mjs'
import { buildItemSynthesisPrompt, ruleOverview, validateItemSynthesis } from './material-synthesis.mjs'

/**
 * 검토 자료 — AI가 만든 HTML 회의 자료를 올려 함께 읽고, 항목마다 의견을 남기고, 판을 이어 가는 곳.
 *
 * 원칙(설계 design-0):
 *  - **원본은 바꾸지 않는다.** 올린 파일은 자료실 문서(DOC)로 그대로 보관하고(삭제 잠금), 그리기용 사본·항목·그림은
 *    파일 저장소에 따로 둔다. 파생물은 원본에서 언제든 다시 만들 수 있다.
 *  - **본문은 저장소(JSON) 파일에 넣지 않는다.** 자료 한 건은 수 MB라, 넣으면 쓰기마다 저장소 전체가 그만큼 무거워진다.
 *    행에는 제목·판 목록·항목 계보(제목까지)만 둔다.
 *  - **자료는 격리된 칸에서만 돈다**(material-bridge.mjs). 자료의 스크립트는 앱의 쿠키·API에 닿지 못한다.
 *  - 판이 바뀌어도 항목은 **계보(lineage)** 로 이어진다 — 의견과 결정은 계보에 붙는다(material-lineage.mjs).
 */

export const MATERIALS_KEY = 'review-materials'
export const MATERIAL_FEEDBACK_KEY = 'review-feedback'
export const MATERIAL_SOURCE_CATEGORY = '검토 자료 원본'
export const MATERIAL_UPLOAD_BYTES = 30 * 1024 * 1024
/** 한 회사에서 보관하지 않은 자료 수. 넘으면 지우지 않고 거절한다. */
export const MATERIALS_CAP = 300
const PARSE_TIMEOUT_MS = 30_000
const MAX_CONCURRENT_PARSES = 2

const refusal = (status, code, message) => Object.freeze({ status, code, message })
export const MATERIAL_ERRORS = Object.freeze({
  TENANT_REQUIRED: refusal(403, 'TENANT_REQUIRED', '고객사 워크스페이스에서만 사용할 수 있습니다.'),
  STORAGE_UNAVAILABLE: refusal(503, 'DOCUMENT_STORAGE_UNAVAILABLE', '파일 저장소가 설정되지 않아 자료를 올릴 수 없습니다.'),
  FILE_REQUIRED: refusal(400, 'MATERIAL_FILE_REQUIRED', '올릴 HTML 파일을 골라 주세요.'),
  TOO_LARGE: refusal(413, 'MATERIAL_TOO_LARGE', '파일이 30MB보다 큽니다. 그림 크기를 줄이거나 자료를 둘로 나눠 올려 주세요.'),
  NOT_HTML: refusal(415, 'MATERIAL_NOT_HTML', 'HTML 파일만 검토 자료로 올릴 수 있습니다. AI가 만든 자료를 .html 파일로 저장해 올려 주세요. (PDF·PPT는 기업 자료실에 올려 주세요.)'),
  NOT_FOUND: refusal(404, 'MATERIAL_NOT_FOUND', '검토 자료를 찾을 수 없습니다.'),
  VERSION_NOT_FOUND: refusal(404, 'MATERIAL_VERSION_NOT_FOUND', '그 판을 찾을 수 없습니다.'),
  ASSET_NOT_FOUND: refusal(404, 'MATERIAL_ASSET_NOT_FOUND', '그림을 찾을 수 없습니다.'),
  MANAGE_FORBIDDEN: refusal(403, 'MATERIAL_MANAGE_FORBIDDEN', '자료를 올린 사람이나 회사 관리자만 할 수 있습니다.'),
  PROJECT_FORBIDDEN: refusal(403, 'MATERIAL_PROJECT_FORBIDDEN', '그 프로젝트의 구성원만 프로젝트에 자료를 올릴 수 있습니다.'),
  SAME_VERSION: refusal(409, 'MATERIAL_SAME_VERSION', '지난 판과 똑같은 파일입니다. 바뀐 파일을 올려 주세요.'),
  KEY_EXISTS: refusal(409, 'MATERIAL_KEY_EXISTS', '같은 자료의 이전 판이 이미 있습니다. 그 자료의 새 판으로 올릴지 골라 주세요.'),
  FULL: refusal(409, 'MATERIALS_FULL', '검토 자료가 300건에 닿아 더 올릴 수 없습니다. 끝난 자료를 보관한 뒤 다시 올려 주세요.'),
  PARSE_FAILED: refusal(422, 'MATERIAL_PARSE_FAILED', '자료를 읽지 못했습니다. 파일이 온전한 HTML인지 확인해 주세요.'),
  BUSY: refusal(503, 'MATERIAL_BUSY', '다른 자료를 읽는 중입니다. 잠시 뒤 다시 올려 주세요.'),
  WRITE_FAILED: refusal(500, 'MATERIAL_WRITE_FAILED', '검토 자료를 저장하지 못했습니다. 잠시 뒤 다시 올려 주세요.'),
  SOURCE_NOT_HTML: refusal(415, 'MATERIAL_SOURCE_NOT_HTML', '이 자료는 HTML이 아니라서 함께 검토할 수 없습니다.'),
})

const SHA = /^[a-f0-9]{64}$/
/** 내 생각. 화면에서는 찬성 · 수정해서 · 반대 · 질문(글자와 아이콘을 함께). */
export const STANCES = Object.freeze(['agree', 'amend', 'oppose', 'question'])

/** 엔진이 던지는 한도 오류를 사람 말로 옮긴다. 엔진의 문장이 이미 한국어면 그대로 쓴다. */
const engineRefusal = (error) => {
  const code = String(error?.code ?? '')
  if (code === 'MATERIAL_PARSE_TIMEOUT') return refusal(422, code, '자료가 너무 복잡해 30초 안에 읽지 못했습니다. 자료를 둘로 나눠 올려 주세요.')
  if (/^MATERIAL_(RENDER_TOO_LARGE|ASSET_TOO_LARGE|TOO_MANY_ASSETS)$/.test(code)) return refusal(413, code, error.message || MATERIAL_ERRORS.TOO_LARGE.message)
  return MATERIAL_ERRORS.PARSE_FAILED
}

let activeParses = 0
/**
 * 분석을 별도 스레드에서 돌린다(시간 제한 30초, 동시 2건). 넘치면 기다리지 않고 바로 알린다 —
 * 30MB짜리 자료 서너 개를 한꺼번에 받으면 서버 메모리가 튄다.
 */
export function prepareMaterialInWorker(html, { timeoutMs = PARSE_TIMEOUT_MS } = {}) {
  if (activeParses >= MAX_CONCURRENT_PARSES) return Promise.reject(Object.assign(new Error(MATERIAL_ERRORS.BUSY.message), { code: 'MATERIAL_BUSY' }))
  activeParses += 1
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./material-worker.mjs', import.meta.url), {
      workerData: { html },
      resourceLimits: { maxOldGenerationSizeMb: 768 },
    })
    let settled = false
    const finish = (callback) => { if (settled) return; settled = true; clearTimeout(timer); activeParses -= 1; worker.terminate().catch(() => undefined); callback() }
    const timer = setTimeout(() => finish(() => reject(Object.assign(new Error('timeout'), { code: 'MATERIAL_PARSE_TIMEOUT' }))), timeoutMs)
    worker.once('message', (message) => finish(() => {
      if (!message?.ok) { reject(Object.assign(new Error(message?.error?.message ?? '분석 실패'), { code: message?.error?.code ?? 'MATERIAL_PARSE_FAILED' })); return }
      resolve({ ...message.result, assets: message.result.assets.map((asset) => ({ ...asset, bytes: Buffer.from(asset.bytes) })) })
    }))
    worker.once('error', (error) => finish(() => reject(Object.assign(error instanceof Error ? error : new Error(String(error)), { code: error?.code ?? 'MATERIAL_PARSE_FAILED' }))))
    worker.once('exit', (code) => { if (code !== 0) finish(() => reject(Object.assign(new Error(`worker exit ${code}`), { code: 'MATERIAL_PARSE_FAILED' }))) })
  })
}

const materialStorageBase = (tenantId, materialId, version) => `materials/${tenantId}/${materialId}/v${version}`
const assetStorageKey = (tenantId, sha) => `materials/${tenantId}/assets/${sha}`

/** 판 사이에 이어 붙일 때 쓰는 항목 모양(본문 포함). */
const comparable = (anchor) => ({ id: anchor.id, key: anchor.key, kind: anchor.kind, title: anchor.title, text: anchor.text, textHash: anchor.textHash, simhash: anchor.simhash, order: anchor.order })

export function registerMaterialRoutes({
  app, express, requireAuth, requireMatchingWorkspaceIdentity,
  workspaceStore, commitWorkspaceStore, documentStorage,
  documentRecord, projectSpacesOf, projectMemberIds, canReadDocument,
  accounts = [], notify = null, createWikiDocument = null,
  client = null, model = '', billingService = null, usageMetadataFor = () => ({}), extractText = null, mapAnthropicError = null,
  enqueueProposal = null, announceProposal = null, newProposalId = null, proposalsOf = null,
  appendAudit = null,
  events = null,
  prepare = prepareMaterialInWorker,
  clock = () => new Date(),
}) {
  const guards = [requireAuth, requireMatchingWorkspaceIdentity]
  const nowIso = () => clock().toISOString()
  const fail = (response, error) => { response.status(error.status).json({ error: { code: error.code, message: error.message } }) }

  const tenantStoreOf = (tenantId) => (workspaceStore.tenants[tenantId] ??= {})
  const materialsOf = (tenantId) => {
    const record = workspaceStore.tenants[tenantId]?.[MATERIALS_KEY]
    return Array.isArray(record?.data) ? record.data : []
  }
  const documentsOf = (tenantId) => (Array.isArray(documentRecord(tenantId)?.data) ? documentRecord(tenantId).data : [])
  const projectOf = (tenantId, projectId) => (projectId ? projectSpacesOf(tenantId).find((project) => project?.id === projectId) ?? null : null)

  // ── 권한 ──────────────────────────────────────────────────────────────────
  /**
   * 볼 수 있는가. 프로젝트에 붙은 자료는 그 프로젝트 구성원(과 관리자)만, 아니면 회사 전원이 본다.
   * 게스트는 1차에서 제외한다(자료 전체가 회사 내부 논의다). 못 보는 사람에게는 없는 자료와 같은 답이다.
   */
  const canSee = (material, auth) => {
    if (!material || !auth?.tenantId || material.tenantId !== auth.tenantId) return false
    if (auth.role === GUEST_ROLE) return false
    if (auth.role === 'tenant-admin' || material.ownerId === auth.id) return true
    if (!material.projectId) return true
    const project = projectOf(auth.tenantId, material.projectId)
    return Boolean(project && projectMemberIds(project).includes(auth.id))
  }
  const canManage = (material, auth) => Boolean(material) && (material.ownerId === auth?.id || auth?.role === 'tenant-admin')
  const findMaterial = (auth, id) => {
    const material = materialsOf(auth.tenantId).find((row) => row?.id === id) ?? null
    return canSee(material, auth) ? material : null
  }
  const requireTenant = (request, response) => {
    if (request.auth?.tenantId && request.auth.role !== GUEST_ROLE) return true
    fail(response, MATERIAL_ERRORS.TENANT_REQUIRED)
    return false
  }

  // ── 공개 모양 ─────────────────────────────────────────────────────────────
  const publicVersion = (version) => ({
    version: version.version,
    sourceDocumentId: version.sourceDocumentId,
    size: version.size,
    anchorCount: version.anchorCount,
    assetCount: version.assetCount,
    renderBytes: version.renderBytes,
    versionNote: version.versionNote ?? '',
    report: version.report ?? {},
    links: version.links ?? null,
    importedAt: version.importedAt,
    importedByName: version.importedByName,
  })
  const publicMaterial = (material, auth, { full = false } = {}) => {
    const current = material.versions?.find((version) => version.version === material.currentVersion) ?? null
    const project = projectOf(material.tenantId, material.projectId)
    return {
      id: material.id,
      title: material.title,
      projectId: material.projectId ?? null,
      projectName: project?.name ?? null,
      materialKey: material.materialKey ?? '',
      ownerId: material.ownerId,
      ownerName: material.ownerName,
      status: material.status,
      currentVersion: material.currentVersion,
      versionCount: material.versions?.length ?? 0,
      anchorCount: current?.anchorCount ?? 0,
      decisionAnchorCount: (material.lineages ?? []).filter((lineage) => lineage.decisionEnabled && lineage.lastVersion === material.currentVersion).length,
      dueAt: material.dueAt ?? null,
      createdAt: material.createdAt,
      updatedAt: material.updatedAt,
      archivedAt: material.archivedAt ?? null,
      canManage: canManage(material, auth),
      canDecide: canManage(material, auth) || (material.deciderIds ?? []).includes(auth?.id),
      deciders: [material.ownerName, ...(material.deciderIds ?? []).map((id) => accounts.find((account) => account.id === id)?.name).filter(Boolean)],
      deciderIds: material.deciderIds ?? [],
      reviewRequestedAt: material.reviewRequestedAt ?? null,
      decisionDocId: material.decisionDocId ?? null,
      aiAvailable: Boolean(client),
      ...(full ? {
        versions: (material.versions ?? []).map(publicVersion).sort((left, right) => right.version - left.version),
        lineages: material.lineages ?? [],
      } : {}),
    }
  }

  // ── 파일 저장소 ───────────────────────────────────────────────────────────
  const manifestCache = new Map()
  const readJson = async (key) => JSON.parse((await documentStorage.get(key)).toString('utf8'))
  const manifestOf = async (tenantId, material, version) => {
    const cacheKey = `${tenantId}:${material.id}:${version.version}`
    if (!manifestCache.has(cacheKey)) {
      manifestCache.set(cacheKey, await readJson(version.manifestKey))
      if (manifestCache.size > 200) manifestCache.delete(manifestCache.keys().next().value)
    }
    return manifestCache.get(cacheKey)
  }
  const anchorsOf = async (version) => (await readJson(version.anchorsKey)).anchors ?? []

  /**
   * 파생물(그리기 사본·항목·그림 목록)과 그림을 파일 저장소에 쓴다. 그림은 내용 주소라 이미 있으면 다시 쓰지 않는다.
   * 쓴 키 목록을 돌려준다 — 커밋이 실패하면 부르는 쪽이 지운다(그림은 다른 판이 쓸 수 있어 지우지 않는다).
   */
  const writeDerived = async (tenantId, materialId, version, prepared, anchorsWithLineage, proposals = []) => {
    const base = materialStorageBase(tenantId, materialId, version)
    const written = []
    for (const asset of prepared.assets) {
      if (!SHA.test(asset.sha256)) continue
      const key = assetStorageKey(tenantId, asset.sha256)
      if (!(await documentStorage.exists?.(key))) await documentStorage.put(key, asset.bytes, { contentType: asset.mime })
    }
    const files = [
      [`${base}/render.html`, Buffer.from(prepared.renderHtml, 'utf8'), 'text/html; charset=utf-8'],
      [`${base}/anchors.json`, Buffer.from(JSON.stringify({ version, anchors: anchorsWithLineage })), 'application/json'],
      [`${base}/manifest.json`, Buffer.from(JSON.stringify({ version, assets: prepared.assets.map(({ sha256, mime, size }) => ({ sha256, mime, size })) })), 'application/json'],
      [`${base}/mapping.json`, Buffer.from(JSON.stringify({ version, proposals })), 'application/json'],
    ]
    for (const [key, body, contentType] of files) {
      await documentStorage.put(key, body, { contentType })
      written.push(key)
    }
    return { base, written }
  }

  /**
   * 새 판의 항목을 계보에 잇는다. 첫 판이면 항목마다 새 계보다. 다음 판이면 지난 판 항목과 짝을 짓고
   * **확실한 짝(같음·바뀜·옮김)만** 잇는다 — 애매한 짝은 사람이 확인하기 전까지 다른 항목으로 둔다(의견이 엉뚱한 항목으로 옮겨 가지 않게).
   */
  const assignLineages = async (material, prepared, version) => {
    const lineages = [...(material?.lineages ?? [])]
    const newLineage = (anchor) => {
      const lineage = {
        id: `LIN-${randomBytes(5).toString('hex')}`,
        key: anchor.key,
        kind: anchor.kind,
        title: String(anchor.title ?? '').slice(0, 120),
        decisionEnabled: Boolean(anchor.decisionEnabled),
        firstVersion: version,
        lastVersion: version,
      }
      lineages.push(lineage)
      return lineage.id
    }
    const previousVersion = material?.versions?.find((row) => row.version === material.currentVersion) ?? null
    let links = null
    let pending = []
    const lineageByAnchor = new Map()
    if (previousVersion) {
      const previousAnchors = (await anchorsOf(previousVersion)).filter((anchor) => anchor.lineageId)
      const result = matchAnchors(previousAnchors.map((anchor) => ({ ...comparable(anchor), lineageId: anchor.lineageId })), prepared.anchors.map(comparable))
      const final = finalizeLinks(result)
      for (const [nextId, link] of final.byNextId) lineageByAnchor.set(nextId, link.lineageId)
      pending = result.links.filter((link) => link.status === 'uncertain' || link.status === 'key-reused')
      links = { ...result.summary, proposals: pending.length }
    }
    const anchors = prepared.anchors.map((anchor) => {
      const lineageId = lineageByAnchor.get(anchor.id) ?? newLineage(anchor)
      const lineage = lineages.find((row) => row.id === lineageId)
      if (lineage) {
        lineage.lastVersion = version
        lineage.title = String(anchor.title ?? lineage.title).slice(0, 120)
        lineage.key = anchor.key
        lineage.decisionEnabled = lineage.decisionEnabled || Boolean(anchor.decisionEnabled)
      }
      return { ...anchor, lineageId }
    })
    // 사람이 확인할 짝: 새 항목은 아직 새 계보이고, 옛 계보는 이 판의 어떤 항목과도 이어지지 않은 것만.
    const linkedLineages = new Set(anchors.map((anchor) => anchor.lineageId))
    const anchorById = new Map(anchors.map((anchor) => [anchor.id, anchor]))
    const proposals = pending
      .filter((link) => anchorById.has(link.nextId) && !linkedLineages.has(link.lineageId))
      .map((link) => {
        const next = anchorById.get(link.nextId)
        const previous = lineages.find((row) => row.id === link.lineageId)
        return { nextId: link.nextId, lineageId: link.lineageId, status: link.status, score: Math.round((link.score ?? 0) * 100) / 100, nextKey: next.key, nextTitle: next.title, previousKey: previous?.key ?? '', previousTitle: previous?.title ?? '' }
      })
    if (links) links.proposals = proposals.length
    return { anchors, lineages, links, proposals }
  }

  /** 자료실 원본 문서의 열람 범위는 자료를 따른다 — 프로젝트 자료면 그 구성원만. */
  const sourceVisibility = (tenantId, projectId, auth) => {
    const project = projectOf(tenantId, projectId)
    if (!project) return { visibility: 'all', departments: [], allowedUserIds: [] }
    return { visibility: 'restricted', departments: [], allowedUserIds: [...new Set([auth.id, ...projectMemberIds(project)])], projectId }
  }

  /**
   * 올리기·새 판·자료실에서 가져오기가 함께 쓰는 한 벌.
   * 파생물을 먼저 쓰고, 자료 행과 자료실 문서 목록을 **한 커밋**으로 넣는다. 실패하면 둘 다 되돌리고 쓴 파일을 지운다.
   */
  const importMaterial = async ({ auth, bytes, fileName, title: requestedTitle, projectId, material, existingDocument = null }) => {
    const decoded = decodeMaterialBytes(bytes)
    if (!decoded.ok) return { error: existingDocument ? MATERIAL_ERRORS.SOURCE_NOT_HTML : MATERIAL_ERRORS.NOT_HTML }
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (material?.versions?.some((version) => version.sha256 === sha256)) return { error: MATERIAL_ERRORS.SAME_VERSION }
    let prepared
    try { prepared = await prepare(decoded.text) } catch (error) {
      if (error?.code === 'MATERIAL_BUSY') return { error: MATERIAL_ERRORS.BUSY }
      console.warn('[materials] 자료를 읽지 못했습니다', { code: error?.code, message: error?.message })
      return { error: engineRefusal(error) }
    }

    const tenantId = auth.tenantId
    const materialId = material?.id ?? `MAT-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`
    const version = (material?.currentVersion ?? 0) + 1
    const { anchors, lineages, links, proposals } = await assignLineages(material, prepared, version)
    let derived = null
    let storedSource = null
    try {
      derived = await writeDerived(tenantId, materialId, version, prepared, anchors, proposals)
    } catch (error) {
      console.error('[materials] 파생물을 쓰지 못했습니다', { message: error?.message })
      return { error: MATERIAL_ERRORS.WRITE_FAILED }
    }

    const now = nowIso()
    const title = String(requestedTitle || material?.title || prepared.meta?.title || fileName || '검토 자료').replace(/\s+/g, ' ').trim().slice(0, 120) || '검토 자료'
    const effectiveProjectId = material ? material.projectId ?? null : projectId ?? null
    let sourceDocumentId = existingDocument?.id ?? null
    const tenantStore = tenantStoreOf(tenantId)
    const previousDocuments = tenantStore['company-documents']
    const previousMaterials = tenantStore[MATERIALS_KEY]
    try {
      if (!existingDocument) {
        sourceDocumentId = `DOC-${Date.now()}-${randomBytes(4).toString('hex')}`
        storedSource = await putTenantDocument(documentStorage, { tenantId, id: sourceDocumentId, body: bytes, contentType: 'text/html' })
        const document = {
          id: sourceDocumentId,
          tenantId,
          name: `${title} · ${version}판`,
          originalName: String(fileName || `${title}.html`).replace(/[\r\n"]/g, '_').slice(0, 180),
          mime: 'text/html',
          size: bytes.length,
          category: MATERIAL_SOURCE_CATEGORY,
          ...sourceVisibility(tenantId, effectiveProjectId, auth),
          tags: ['review-material', `material:${materialId}`],
          summary: String(prepared.meta?.versionNote ?? '').slice(0, 200),
          uploadedAt: now,
          uploadedById: auth.id,
          uploadedByName: auth.name,
          uploadedByRole: auth.role,
          checksum: sha256,
          storage: documentStorage.backend,
          ...storedSource,
        }
        tenantStore['company-documents'] = { data: [document, ...documentsOf(tenantId)], updatedAt: now, updatedBy: auth.id }
      }
      const versionRecord = {
        version,
        sourceDocumentId,
        sha256,
        size: bytes.length,
        renderKey: `${derived.base}/render.html`,
        anchorsKey: `${derived.base}/anchors.json`,
        manifestKey: `${derived.base}/manifest.json`,
        mappingKey: `${derived.base}/mapping.json`,
        resolvedLinks: [],
        anchorCount: anchors.length,
        assetCount: prepared.assets.length,
        renderBytes: Buffer.byteLength(prepared.renderHtml, 'utf8'),
        charset: decoded.charset,
        versionNote: String(prepared.meta?.versionNote ?? '').slice(0, 200),
        report: {
          scripts: prepared.report?.scripts ?? 0,
          externalRefs: prepared.report?.externalRefs ?? 0,
          nativeReviewControls: prepared.report?.nativeReviewControls ?? 0,
          truncatedAnchors: Boolean(prepared.report?.truncatedAnchors),
          skippedDataUris: prepared.report?.skippedDataUris ?? 0,
          // 빈 상태({})는 모은 의견이 없다는 뜻이다.
          hasEmbeddedFeedback: Boolean(prepared.embeddedFeedback?.sharedState && Object.keys(prepared.embeddedFeedback.sharedState).length),
        },
        links,
        importedAt: now,
        importedById: auth.id,
        importedByName: auth.name,
      }
      const next = material
        ? { ...material, title: requestedTitle ? title : material.title, currentVersion: version, versions: [...material.versions, versionRecord], lineages, updatedAt: now }
        : {
          id: materialId,
          tenantId,
          title,
          projectId: effectiveProjectId,
          materialKey: String(prepared.meta?.materialKey ?? '').slice(0, 120),
          ownerId: auth.id,
          ownerName: auth.name,
          status: 'open',
          currentVersion: version,
          versions: [versionRecord],
          lineages,
          dueAt: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
        }
      const rows = materialsOf(tenantId)
      tenantStore[MATERIALS_KEY] = { data: material ? rows.map((row) => (row.id === material.id ? next : row)) : [next, ...rows], updatedAt: now, updatedBy: auth.id }
      await commitWorkspaceStore()
      events?.publish(tenantId, 'material', { materialId, what: 'version', version })
      return { material: next, version: versionRecord }
    } catch (error) {
      if (previousDocuments) tenantStore['company-documents'] = previousDocuments; else delete tenantStore['company-documents']
      if (previousMaterials) tenantStore[MATERIALS_KEY] = previousMaterials; else delete tenantStore[MATERIALS_KEY]
      if (storedSource) await deleteTenantDocument(documentStorage, { id: sourceDocumentId, ...storedSource }, tenantId).catch(() => undefined)
      for (const key of derived?.written ?? []) await Promise.resolve().then(() => documentStorage.delete?.(key)).catch(() => undefined)
      console.error('[materials] 자료를 저장하지 못했습니다', { message: error?.message })
      return { error: MATERIAL_ERRORS.WRITE_FAILED }
    }
  }

  // ── 라우트 ────────────────────────────────────────────────────────────────
  app.get('/api/materials', ...guards, (request, response) => {
    if (!requireTenant(request, response)) return
    const includeArchived = String(request.query.archived ?? '') === '1'
    const rows = materialsOf(request.auth.tenantId)
      .filter((material) => canSee(material, request.auth) && (includeArchived || material.status !== 'archived'))
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
      .map((material) => publicMaterial(material, request.auth))
    response.json({ materials: rows, uploadLimitBytes: MATERIAL_UPLOAD_BYTES })
  })

  app.post('/api/materials/import', ...guards, express.raw({ type: '*/*', limit: '31mb' }), async (request, response) => {
    if (!requireTenant(request, response)) return
    if (!documentStorage) { fail(response, MATERIAL_ERRORS.STORAGE_UNAVAILABLE); return }
    const bytes = request.body
    if (!Buffer.isBuffer(bytes) || !bytes.length) { fail(response, MATERIAL_ERRORS.FILE_REQUIRED); return }
    if (bytes.length > MATERIAL_UPLOAD_BYTES) { fail(response, MATERIAL_ERRORS.TOO_LARGE); return }
    let fileName = 'material.html'
    try { fileName = decodeURIComponent(String(request.get('x-file-name') || fileName)) } catch { /* 이름을 못 읽으면 기본값 */ }
    const tenantId = request.auth.tenantId
    const materialId = String(request.query.materialId ?? '').trim()
    let material = null
    if (materialId) {
      material = findMaterial(request.auth, materialId)
      if (!material) { fail(response, MATERIAL_ERRORS.NOT_FOUND); return }
      if (!canManage(material, request.auth)) { fail(response, MATERIAL_ERRORS.MANAGE_FORBIDDEN); return }
    } else if (materialsOf(tenantId).filter((row) => row.status !== 'archived').length >= MATERIALS_CAP) {
      fail(response, MATERIAL_ERRORS.FULL); return
    }
    const projectId = material ? null : String(request.query.projectId ?? '').trim() || null
    if (projectId) {
      const project = projectOf(tenantId, projectId)
      if (!project || (request.auth.role !== 'tenant-admin' && !projectMemberIds(project).includes(request.auth.id))) { fail(response, MATERIAL_ERRORS.PROJECT_FORBIDDEN); return }
    }
    // 같은 자료의 다음 판을 새 자료로 따로 올리면 의견이 두 곳으로 갈라진다 — 한 번 묻는다.
    if (!material && String(request.query.newMaterial ?? '') !== '1') {
      const decoded = decodeMaterialBytes(bytes.subarray(0, 256 * 1024))
      const keyMatch = /<meta[^>]+name\s*=\s*["']?itf:material["']?[^>]*content\s*=\s*["']([^"']{1,120})["']/i.exec(decoded.text ?? '')
        ?? /<meta[^>]+content\s*=\s*["']([^"']{1,120})["'][^>]*name\s*=\s*["']?itf:material/i.exec(decoded.text ?? '')
      const candidate = keyMatch
        ? materialsOf(tenantId).find((row) => row.materialKey === keyMatch[1].trim() && row.status !== 'archived' && canManage(row, request.auth))
        : null
      if (candidate) {
        response.status(409).json({ error: { code: MATERIAL_ERRORS.KEY_EXISTS.code, message: MATERIAL_ERRORS.KEY_EXISTS.message }, candidate: { id: candidate.id, title: candidate.title, currentVersion: candidate.currentVersion } })
        return
      }
    }
    const result = await importMaterial({ auth: request.auth, bytes, fileName, title: String(request.query.title ?? '').trim(), projectId, material })
    if (result.error) { fail(response, result.error); return }
    response.status(201).json({ material: publicMaterial(result.material, request.auth, { full: true }) })
  })

  /** 기업 자료실에 이미 있는 HTML을 원본으로 검토 자료를 만든다(파일을 다시 올리지 않는다). */
  app.post('/api/materials/from-document/:documentId', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    if (!documentStorage) { fail(response, MATERIAL_ERRORS.STORAGE_UNAVAILABLE); return }
    const tenantId = request.auth.tenantId
    const document = documentsOf(tenantId).find((row) => row?.id === request.params.documentId) ?? null
    // 볼 수 없는 자료는 없는 자료와 같은 답이다. 자료실의 판정을 그대로 쓴다.
    if (!document || !canReadDocument(document, request.auth)) {
      response.status(404).json({ error: { code: 'DOCUMENT_NOT_FOUND', message: '자료를 찾을 수 없습니다.' } })
      return
    }
    const existing = materialsOf(tenantId).find((row) => row.versions?.some((version) => version.sourceDocumentId === document.id) && canSee(row, request.auth))
    if (existing) { response.json({ material: publicMaterial(existing, request.auth, { full: true }), existing: true }); return }
    if (materialsOf(tenantId).filter((row) => row.status !== 'archived').length >= MATERIALS_CAP) { fail(response, MATERIAL_ERRORS.FULL); return }
    let bytes
    try { bytes = await getTenantDocument(documentStorage, document, tenantId) } catch { fail(response, MATERIAL_ERRORS.NOT_FOUND); return }
    const result = await importMaterial({ auth: request.auth, bytes, fileName: document.originalName || document.name, title: String(document.name ?? '').replace(/\.html?$/i, ''), projectId: document.projectId ?? null, material: null, existingDocument: document })
    if (result.error) { fail(response, result.error); return }
    response.status(201).json({ material: publicMaterial(result.material, request.auth, { full: true }) })
  })

  app.get('/api/materials/:id', ...guards, (request, response) => {
    if (!requireTenant(request, response)) return
    const material = findMaterial(request.auth, request.params.id)
    if (!material) { fail(response, MATERIAL_ERRORS.NOT_FOUND); return }
    response.json({ material: publicMaterial(material, request.auth, { full: true }) })
  })

  const versionOf = (material, value) => {
    const number = Number.parseInt(String(value ?? ''), 10)
    return material.versions?.find((version) => version.version === (Number.isFinite(number) ? number : material.currentVersion)) ?? null
  }

  /**
   * iframe srcdoc에 넣을 문서. **HTML로 내려주지 않는다** — 누가 이 주소를 직접 열어도 앱 출처에서
   * 자료가 그려지지 않게 text/plain + 첨부로 준다. 화면은 fetch로 받아 격리된 칸에 넣는다.
   */
  app.get('/api/materials/:id/versions/:version/frame', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const material = findMaterial(request.auth, request.params.id)
    if (!material) { fail(response, MATERIAL_ERRORS.NOT_FOUND); return }
    const version = versionOf(material, request.params.version)
    if (!version) { fail(response, MATERIAL_ERRORS.VERSION_NOT_FOUND); return }
    try {
      const render = (await documentStorage.get(version.renderKey)).toString('utf8')
      response.setHeader('content-type', 'text/plain; charset=utf-8')
      response.setHeader('x-content-type-options', 'nosniff')
      response.setHeader('content-disposition', 'attachment; filename="material-frame.txt"')
      response.send(frameDocument(render, { hideNativeReview: String(request.query.native ?? '') !== '1' }))
    } catch (error) {
      console.error('[materials] 그리기 사본을 읽지 못했습니다', { message: error?.message })
      fail(response, MATERIAL_ERRORS.VERSION_NOT_FOUND)
    }
  })

  /** 떼어 둔 그림. 그 판의 목록에 있는 것만 준다(다른 회사·다른 자료의 그림을 sha로 찍어 읽지 못하게). */
  app.get('/api/materials/:id/versions/:version/assets/:sha', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const material = findMaterial(request.auth, request.params.id)
    if (!material) { fail(response, MATERIAL_ERRORS.NOT_FOUND); return }
    const version = versionOf(material, request.params.version)
    const sha = String(request.params.sha ?? '')
    if (!version || !SHA.test(sha)) { fail(response, MATERIAL_ERRORS.ASSET_NOT_FOUND); return }
    try {
      const manifest = await manifestOf(request.auth.tenantId, material, version)
      const asset = (manifest.assets ?? []).find((row) => row.sha256 === sha)
      if (!asset) { fail(response, MATERIAL_ERRORS.ASSET_NOT_FOUND); return }
      const bytes = await documentStorage.get(assetStorageKey(request.auth.tenantId, sha))
      response.setHeader('content-type', asset.mime || 'application/octet-stream')
      response.setHeader('x-content-type-options', 'nosniff')
      response.setHeader('content-disposition', 'attachment')
      // 내용 주소라 바뀌지 않는다 — 같은 사람의 브라우저가 다시 받지 않게 한다(공유 캐시에는 두지 않는다).
      response.setHeader('cache-control', 'private, max-age=31536000, immutable')
      response.send(bytes)
    } catch (error) {
      console.error('[materials] 그림을 읽지 못했습니다', { message: error?.message })
      fail(response, MATERIAL_ERRORS.ASSET_NOT_FOUND)
    }
  })

  /** 읽기 모드와 의견 칸이 쓰는 항목 목록(본문 포함). */
  app.get('/api/materials/:id/versions/:version/anchors', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const material = findMaterial(request.auth, request.params.id)
    if (!material) { fail(response, MATERIAL_ERRORS.NOT_FOUND); return }
    const version = versionOf(material, request.params.version)
    if (!version) { fail(response, MATERIAL_ERRORS.VERSION_NOT_FOUND); return }
    try {
      response.json({ version: version.version, anchors: await anchorsOf(version) })
    } catch (error) {
      console.error('[materials] 항목을 읽지 못했습니다', { message: error?.message })
      fail(response, MATERIAL_ERRORS.VERSION_NOT_FOUND)
    }
  })

  const saveMaterial = async (auth, next) => {
    const tenantStore = tenantStoreOf(auth.tenantId)
    const previous = tenantStore[MATERIALS_KEY]
    tenantStore[MATERIALS_KEY] = { data: materialsOf(auth.tenantId).map((row) => (row.id === next.id ? next : row)), updatedAt: nowIso(), updatedBy: auth.id }
    try {
      await commitWorkspaceStore()
      events?.publish(auth.tenantId, 'material', { materialId: next.id, what: 'meta' })
      return true
    } catch (error) {
      if (previous) tenantStore[MATERIALS_KEY] = previous; else delete tenantStore[MATERIALS_KEY]
      console.error('[materials] 자료를 저장하지 못했습니다', { message: error?.message })
      return false
    }
  }

  app.patch('/api/materials/:id', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const material = findMaterial(request.auth, request.params.id)
    if (!material) { fail(response, MATERIAL_ERRORS.NOT_FOUND); return }
    if (!canManage(material, request.auth)) { fail(response, MATERIAL_ERRORS.MANAGE_FORBIDDEN); return }
    const next = { ...material, updatedAt: nowIso() }
    if (typeof request.body?.title === 'string') {
      const title = request.body.title.replace(/\s+/g, ' ').trim().slice(0, 120)
      if (title.length < 2) { response.status(400).json({ error: { code: 'MATERIAL_TITLE_REQUIRED', message: '자료 이름은 2자 이상 적어 주세요.' } }); return }
      next.title = title
    }
    if (request.body?.dueAt !== undefined) {
      const due = request.body.dueAt === null || request.body.dueAt === '' ? null : String(request.body.dueAt)
      if (due !== null && !Number.isFinite(Date.parse(due))) { response.status(400).json({ error: { code: 'MATERIAL_DUE_INVALID', message: '의견 마감 날짜를 확인해 주세요.' } }); return }
      next.dueAt = due
    }
    if (!(await saveMaterial(request.auth, next))) { fail(response, MATERIAL_ERRORS.WRITE_FAILED); return }
    response.json({ material: publicMaterial(next, request.auth, { full: true }) })
  })

  /** 보관: 목록에서 내리고 새 의견을 받지 않는다. 지우지 않는다(원본·의견·결정은 그대로). */
  app.post('/api/materials/:id/archive', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const material = findMaterial(request.auth, request.params.id)
    if (!material) { fail(response, MATERIAL_ERRORS.NOT_FOUND); return }
    if (!canManage(material, request.auth)) { fail(response, MATERIAL_ERRORS.MANAGE_FORBIDDEN); return }
    const archive = request.body?.restore !== true
    const next = { ...material, status: archive ? 'archived' : 'open', archivedAt: archive ? nowIso() : null, archivedById: archive ? request.auth.id : null, updatedAt: nowIso() }
    if (!archive && materialsOf(request.auth.tenantId).filter((row) => row.status !== 'archived').length >= MATERIALS_CAP) { fail(response, MATERIAL_ERRORS.FULL); return }
    if (!(await saveMaterial(request.auth, next))) { fail(response, MATERIAL_ERRORS.WRITE_FAILED); return }
    response.json({ material: publicMaterial(next, request.auth, { full: true }) })
  })

  /** 자료실의 삭제 잠금이 읽는다: 검토 자료가 원본으로 쓰는 문서 id. */
  const sourceDocumentIds = (tenantId) => new Set(materialsOf(tenantId).flatMap((material) => (material.versions ?? []).map((version) => version.sourceDocumentId)).filter(Boolean))

  // ── 의견·찬반 ─────────────────────────────────────────────────────────────
  /**
   * 의견과 찬반은 **추가만 하는 기록**이다. 지금의 찬반은 "사람별·항목별 마지막 찬반 줄"이다 —
   * 그래서 바꾼 이력이 저절로 남는다. 의견을 고치면 이전 글이 남고(최근 5개), 지우면 흔적만 남는다.
   * 의견은 판이 아니라 **계보**에 붙는다 — 새 판이 와도 같은 항목을 따라간다.
   */
  const feedbackOf = (tenantId) => {
    const record = workspaceStore.tenants[tenantId]?.[MATERIAL_FEEDBACK_KEY]
    return Array.isArray(record?.data) ? record.data : []
  }
  const materialFeedback = (tenantId, materialId) => feedbackOf(tenantId).filter((row) => row?.materialId === materialId)

  const summarizeFeedback = (rows, auth) => {
    const byLineage = {}
    const slot = (lineageId) => (byLineage[lineageId ?? '_material'] ??= { comments: 0, openQuestions: 0, stances: { agree: 0, amend: 0, oppose: 0, question: 0 }, myStance: null, lastActivityAt: null })
    const latest = new Map()
    const ordered = [...rows].sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
    for (const row of ordered) {
      const target = slot(row.lineageId)
      target.lastActivityAt = row.createdAt
      if (row.type === 'stance') latest.set(`${row.lineageId}\u0000${row.authorId}`, row)
      else if (row.type === 'comment' && !row.deletedAt) target.comments += 1
    }
    for (const row of latest.values()) {
      if (!STANCES.includes(row.stance)) continue
      const target = slot(row.lineageId)
      target.stances[row.stance] += 1
      if (row.authorId === auth.id) target.myStance = row.stance
    }
    // 질문으로 남긴 뒤 아무도 답하지 않은 항목(규칙으로 센다 — AI 없이도 쟁점이 보인다).
    const answered = new Set(ordered.filter((row) => row.type === 'comment' && row.parentId && !row.deletedAt).map((row) => row.parentId))
    for (const row of ordered) {
      if (row.type === 'comment' && !row.parentId && !row.deletedAt && row.question && !answered.has(row.id)) slot(row.lineageId).openQuestions += 1
    }
    return byLineage
  }

  const publicFeedback = (row) => ({
    id: row.id,
    lineageId: row.lineageId ?? null,
    version: row.version,
    type: row.type,
    authorId: row.authorId,
    authorName: row.authorName,
    body: row.deletedAt ? '' : row.body ?? '',
    stance: row.stance ?? null,
    question: Boolean(row.question),
    parentId: row.parentId ?? null,
    createdAt: row.createdAt,
    editedAt: row.editedAt ?? null,
    editHistory: row.deletedAt ? [] : (row.editHistory ?? []),
    deleted: Boolean(row.deletedAt),
  })

  const feedbackRefusal = {
    ARCHIVED: refusal(409, 'MATERIAL_ARCHIVED', '보관한 자료에는 의견을 남길 수 없습니다. 자료를 다시 진행으로 돌리면 남길 수 있습니다.'),
    LINEAGE_NOT_FOUND: refusal(404, 'MATERIAL_ITEM_NOT_FOUND', '그 항목을 찾을 수 없습니다. 새 판에서 빠진 항목일 수 있습니다.'),
    BODY_REQUIRED: refusal(400, 'MATERIAL_FEEDBACK_REQUIRED', '의견을 한 글자 이상 적어 주세요. (2,000자까지)'),
    PARENT_INVALID: refusal(400, 'MATERIAL_REPLY_INVALID', '답글은 같은 항목의 의견에만 달 수 있습니다.'),
    STANCE_INVALID: refusal(400, 'MATERIAL_STANCE_INVALID', '찬성·수정해서·반대·질문 중 하나를 골라 주세요.'),
    FULL: refusal(409, 'MATERIAL_FEEDBACK_FULL', '이 자료의 의견이 3,000개에 닿았습니다. 새 판을 올려 이어 가 주세요.'),
    NOT_FOUND: refusal(404, 'MATERIAL_FEEDBACK_NOT_FOUND', '그 의견을 찾을 수 없습니다.'),
    NOT_AUTHOR: refusal(403, 'MATERIAL_FEEDBACK_FORBIDDEN', '자기 의견만 고칠 수 있습니다.'),
    DELETE_FORBIDDEN: refusal(403, 'MATERIAL_FEEDBACK_DELETE_FORBIDDEN', '자기 의견이나, 관리자라면 지울 수 있습니다.'),
  }

  /** 의견 한 줄을 더하고 커밋한다. 실패하면 되돌린다. 실시간 신호는 커밋 **뒤에** 보낸다. */
  const saveFeedback = async (auth, materialId, nextRows, what, lineageId) => {
    const tenantStore = tenantStoreOf(auth.tenantId)
    const previous = tenantStore[MATERIAL_FEEDBACK_KEY]
    tenantStore[MATERIAL_FEEDBACK_KEY] = { data: nextRows, updatedAt: nowIso(), updatedBy: auth.id }
    try {
      await commitWorkspaceStore()
    } catch (error) {
      if (previous) tenantStore[MATERIAL_FEEDBACK_KEY] = previous; else delete tenantStore[MATERIAL_FEEDBACK_KEY]
      console.error('[materials] 의견을 저장하지 못했습니다', { message: error?.message })
      return false
    }
    events?.publish(auth.tenantId, 'material', { materialId, what, lineageId: lineageId ?? null })
    return true
  }

  const writableMaterial = (request, response) => {
    if (!requireTenant(request, response)) return null
    const material = findMaterial(request.auth, request.params.id)
    if (!material) { fail(response, MATERIAL_ERRORS.NOT_FOUND); return null }
    if (material.status === 'archived') { fail(response, feedbackRefusal.ARCHIVED); return null }
    return material
  }

  const lineageIdFrom = (material, value) => {
    if (value === null || value === undefined || value === '') return { ok: true, lineageId: null }
    const lineageId = String(value)
    return (material.lineages ?? []).some((lineage) => lineage.id === lineageId) ? { ok: true, lineageId } : { ok: false }
  }

  app.get('/api/materials/:id/feedback', ...guards, (request, response) => {
    if (!requireTenant(request, response)) return
    const material = findMaterial(request.auth, request.params.id)
    if (!material) { fail(response, MATERIAL_ERRORS.NOT_FOUND); return }
    const rows = materialFeedback(request.auth.tenantId, material.id)
    const lineageFilter = String(request.query.lineageId ?? '')
    const comments = rows
      .filter((row) => row.type === 'comment' && (!lineageFilter || row.lineageId === lineageFilter))
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
      .map(publicFeedback)
    const decisions = rows.filter((row) => row.type === 'decision').sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt))).map(publicDecision)
    const aiOutputs = {}
    for (const row of rows.filter((item) => item.type === 'ai-output').sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))) {
      aiOutputs[row.lineageId ?? '_material'] = { id: row.id, output: row.output, model: row.model, runByName: row.authorName, createdAt: row.createdAt, version: row.version }
    }
    response.json({ comments, decisions, aiOutputs, summary: summarizeFeedback(rows, request.auth), currentVersion: material.currentVersion })
  })

  app.post('/api/materials/:id/feedback', ...guards, async (request, response) => {
    const material = writableMaterial(request, response)
    if (!material) return
    const lineage = lineageIdFrom(material, request.body?.lineageId)
    if (!lineage.ok) { fail(response, feedbackRefusal.LINEAGE_NOT_FOUND); return }
    const body = String(request.body?.body ?? '').replace(/\r\n/g, '\n').trim().slice(0, 2_000)
    if (!body) { fail(response, feedbackRefusal.BODY_REQUIRED); return }
    const tenantId = request.auth.tenantId
    const all = feedbackOf(tenantId)
    const rows = all.filter((row) => row?.materialId === material.id)
    // 같은 요청을 두 번 보내도(네트워크가 흔들려 다시 누름) 한 번만 남는다.
    const clientRequestId = String(request.body?.clientRequestId ?? '').slice(0, 80)
    if (clientRequestId) {
      const known = rows.find((row) => row.clientRequestId === clientRequestId && row.authorId === request.auth.id)
      if (known) { response.json({ comment: publicFeedback(known), duplicate: true }); return }
    }
    let parentId = null
    if (request.body?.parentId) {
      const parent = rows.find((row) => row.id === String(request.body.parentId) && row.type === 'comment')
      // 답글은 한 단계까지(스레드 규칙과 같다). 답글에 단 답글은 그 답글이 달린 의견에 붙인다.
      const root = parent?.parentId ? rows.find((row) => row.id === parent.parentId) : parent
      if (!root || root.lineageId !== lineage.lineageId) { fail(response, feedbackRefusal.PARENT_INVALID); return }
      parentId = root.id
    }
    if (rows.length >= 3_000 || all.length >= 30_000) { fail(response, feedbackRefusal.FULL); return }
    const comment = {
      id: `MFB-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
      materialId: material.id,
      lineageId: lineage.lineageId,
      version: material.currentVersion,
      type: 'comment',
      authorId: request.auth.id,
      authorName: request.auth.name,
      body,
      question: request.body?.question === true,
      parentId,
      clientRequestId: clientRequestId || undefined,
      createdAt: nowIso(),
    }
    if (!(await saveFeedback(request.auth, material.id, [...all, comment], 'feedback', comment.lineageId))) { fail(response, MATERIAL_ERRORS.WRITE_FAILED); return }
    response.status(201).json({ comment: publicFeedback(comment), summary: summarizeFeedback([...rows, comment], request.auth) })
  })

  /** 내 생각(찬성·수정해서·반대·질문). null이면 거둔다. 바꾼 이력은 줄로 남는다. */
  app.post('/api/materials/:id/stance', ...guards, async (request, response) => {
    const material = writableMaterial(request, response)
    if (!material) return
    const lineage = lineageIdFrom(material, request.body?.lineageId)
    if (!lineage.ok || !lineage.lineageId) { fail(response, feedbackRefusal.LINEAGE_NOT_FOUND); return }
    const stance = request.body?.stance === null ? null : String(request.body?.stance ?? '')
    if (stance !== null && !STANCES.includes(stance)) { fail(response, feedbackRefusal.STANCE_INVALID); return }
    const tenantId = request.auth.tenantId
    const all = feedbackOf(tenantId)
    const rows = all.filter((row) => row?.materialId === material.id)
    const mine = rows.filter((row) => row.type === 'stance' && row.lineageId === lineage.lineageId && row.authorId === request.auth.id)
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
    const current = mine.at(-1)?.stance ?? null
    if (current === stance) { response.json({ stance, summary: summarizeFeedback(rows, request.auth) }); return }
    if (rows.length >= 3_000 || all.length >= 30_000) { fail(response, feedbackRefusal.FULL); return }
    const row = {
      id: `MFB-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
      materialId: material.id,
      lineageId: lineage.lineageId,
      version: material.currentVersion,
      type: 'stance',
      authorId: request.auth.id,
      authorName: request.auth.name,
      stance,
      createdAt: nowIso(),
    }
    if (!(await saveFeedback(request.auth, material.id, [...all, row], 'stance', row.lineageId))) { fail(response, MATERIAL_ERRORS.WRITE_FAILED); return }
    response.json({ stance, summary: summarizeFeedback([...rows, row], request.auth) })
  })

  app.patch('/api/materials/:id/feedback/:feedbackId', ...guards, async (request, response) => {
    const material = writableMaterial(request, response)
    if (!material) return
    const all = feedbackOf(request.auth.tenantId)
    const target = all.find((row) => row?.id === request.params.feedbackId && row.materialId === material.id && row.type === 'comment' && !row.deletedAt)
    if (!target) { fail(response, feedbackRefusal.NOT_FOUND); return }
    if (target.authorId !== request.auth.id) { fail(response, feedbackRefusal.NOT_AUTHOR); return }
    const body = String(request.body?.body ?? '').replace(/\r\n/g, '\n').trim().slice(0, 2_000)
    if (!body) { fail(response, feedbackRefusal.BODY_REQUIRED); return }
    if (body === target.body) { response.json({ comment: publicFeedback(target) }); return }
    const next = { ...target, body, editedAt: nowIso(), editHistory: [...(target.editHistory ?? []), { body: target.body, until: nowIso() }].slice(-5) }
    if (!(await saveFeedback(request.auth, material.id, all.map((row) => (row.id === target.id ? next : row)), 'feedback', target.lineageId))) { fail(response, MATERIAL_ERRORS.WRITE_FAILED); return }
    response.json({ comment: publicFeedback(next) })
  })

  /** 지우면 흔적만 남는다(누가 언제 지웠는지). 답글이 있어도 줄은 남아 대화가 끊기지 않는다. */
  app.delete('/api/materials/:id/feedback/:feedbackId', ...guards, async (request, response) => {
    const material = writableMaterial(request, response)
    if (!material) return
    const all = feedbackOf(request.auth.tenantId)
    const target = all.find((row) => row?.id === request.params.feedbackId && row.materialId === material.id && row.type === 'comment' && !row.deletedAt)
    if (!target) { fail(response, feedbackRefusal.NOT_FOUND); return }
    if (target.authorId !== request.auth.id && request.auth.role !== 'tenant-admin') { fail(response, feedbackRefusal.DELETE_FORBIDDEN); return }
    const next = { ...target, body: '', editHistory: [], deletedAt: nowIso(), deletedById: request.auth.id }
    if (!(await saveFeedback(request.auth, material.id, all.map((row) => (row.id === target.id ? next : row)), 'feedback', target.lineageId))) { fail(response, MATERIAL_ERRORS.WRITE_FAILED); return }
    response.json({ comment: publicFeedback(next) })
  })

  // ── 결정 ─────────────────────────────────────────────────────────────────
  /**
   * 결정권자: 올린 사람 · 회사 관리자 · 올린 사람이 지정한 사람. 화면 맨 위에 "결정은 ○○님이 합니다"라고 적는다.
   * 결정은 지우지 않는다 — 새 줄로만 덮는다. 그래서 "언제 누가 반영에서 보류로 바꿨는가"가 저절로 남는다.
   */
  const canDecide = (material, auth) => canManage(material, auth) || (material.deciderIds ?? []).includes(auth?.id)
  const decisionRefusal = {
    FORBIDDEN: refusal(403, 'MATERIAL_DECIDE_FORBIDDEN', '결정은 자료를 올린 사람, 회사 관리자, 결정권자로 지정된 사람만 할 수 있습니다.'),
    INVALID: refusal(400, 'MATERIAL_DECISION_INVALID', `결정은 ${DECISIONS.join(' · ')} 중 하나를 골라 주세요.`),
  }
  const publicDecision = (row) => ({
    id: row.id, lineageId: row.lineageId, version: row.version, status: row.decision?.status ?? null, note: row.decision?.note ?? '',
    decidedById: row.authorId, decidedByName: row.authorName, decidedAt: row.createdAt, imported: Boolean(row.imported),
  })
  const latestDecisions = (rows) => {
    const latest = new Map()
    for (const row of [...rows].filter((item) => item.type === 'decision').sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))) latest.set(row.lineageId, row)
    return latest
  }

  app.post('/api/materials/:id/decision', ...guards, async (request, response) => {
    const material = writableMaterial(request, response)
    if (!material) return
    if (!canDecide(material, request.auth)) { fail(response, decisionRefusal.FORBIDDEN); return }
    const lineage = lineageIdFrom(material, request.body?.lineageId)
    if (!lineage.ok || !lineage.lineageId) { fail(response, feedbackRefusal.LINEAGE_NOT_FOUND); return }
    const status = String(request.body?.status ?? '')
    if (!DECISIONS.includes(status)) { fail(response, decisionRefusal.INVALID); return }
    const note = String(request.body?.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 500)
    const all = feedbackOf(request.auth.tenantId)
    const rows = all.filter((row) => row?.materialId === material.id)
    const current = latestDecisions(rows).get(lineage.lineageId)
    if (current && current.decision?.status === status && (current.decision?.note ?? '') === note && current.version === material.currentVersion) {
      response.json({ decision: publicDecision(current), unchanged: true })
      return
    }
    if (rows.length >= 3_000 || all.length >= 30_000) { fail(response, feedbackRefusal.FULL); return }
    // AI 초안에서 왔는가 — 그대로 채택했는지, 고쳐서 채택했는지 남긴다(북극성: 사람이 덜 판단하게 되었는가의 원료).
    const draft = request.body?.draftedBy ? rows.find((item) => item.id === String(request.body.draftedBy) && item.type === 'ai-output' && item.lineageId === lineage.lineageId) : null
    const adoption = draft?.output?.draftDecision
      ? (draft.output.draftDecision.status === status && (draft.output.draftDecision.note ?? '') === note ? 'adopted' : 'edited')
      : null
    const row = {
      id: `MFB-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
      materialId: material.id, lineageId: lineage.lineageId, version: material.currentVersion,
      type: 'decision', authorId: request.auth.id, authorName: request.auth.name,
      decision: { status, note }, createdAt: nowIso(),
      ...(draft ? { draftedBy: draft.id, adoption } : {}),
    }
    if (!(await saveFeedback(request.auth, material.id, [...all, row], 'decision', row.lineageId))) { fail(response, MATERIAL_ERRORS.WRITE_FAILED); return }
    response.json({ decision: publicDecision(row) })
  })

  /** 결정권자 지정(올린 사람·관리자). 같은 회사의 사람만, 20명까지. */
  app.put('/api/materials/:id/deciders', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const material = findMaterial(request.auth, request.params.id)
    if (!material) { fail(response, MATERIAL_ERRORS.NOT_FOUND); return }
    if (!canManage(material, request.auth)) { fail(response, MATERIAL_ERRORS.MANAGE_FORBIDDEN); return }
    const members = new Set(tenantMembers(request.auth.tenantId).map((account) => account.id))
    const deciderIds = [...new Set((Array.isArray(request.body?.deciderIds) ? request.body.deciderIds : []).map(String))].filter((id) => members.has(id)).slice(0, 20)
    const next = { ...material, deciderIds, updatedAt: nowIso() }
    if (!(await saveMaterial(request.auth, next))) { fail(response, MATERIAL_ERRORS.WRITE_FAILED); return }
    response.json({ material: publicMaterial(next, request.auth, { full: true }) })
  })

  // ── 알림 ──────────────────────────────────────────────────────────────────
  /** 이 회사에서 로그인해 쓰는 사람(게스트 제외). */
  const tenantMembers = (tenantId) => accounts.filter((account) => account?.tenantId === tenantId && account.approved !== false && (account.role === 'tenant-admin' || account.role === 'tenant-member'))
  /** 이 자료를 볼 수 있는 사람. 검토 요청·마감 알림을 받을 사람들이다. */
  const audienceOf = (material) => tenantMembers(material.tenantId).filter((account) => canSee(material, { ...account, tenantId: material.tenantId }))

  /** [검토 요청 보내기] — 볼 수 있는 사람에게 한 번씩. 마감을 함께 정할 수 있다. */
  app.post('/api/materials/:id/request-review', ...guards, async (request, response) => {
    const material = writableMaterial(request, response)
    if (!material) return
    if (!canManage(material, request.auth)) { fail(response, MATERIAL_ERRORS.MANAGE_FORBIDDEN); return }
    const next = { ...material, reviewRequestedAt: nowIso(), dueRemindedAt: null, updatedAt: nowIso() }
    if (request.body?.dueAt !== undefined) {
      const due = request.body.dueAt ? String(request.body.dueAt) : null
      if (due && !Number.isFinite(Date.parse(due))) { response.status(400).json({ error: { code: 'MATERIAL_DUE_INVALID', message: '의견 마감 날짜를 확인해 주세요.' } }); return }
      next.dueAt = due
    }
    if (!(await saveMaterial(request.auth, next))) { fail(response, MATERIAL_ERRORS.WRITE_FAILED); return }
    const recipients = audienceOf(next).filter((account) => account.id !== request.auth.id)
    const due = next.dueAt ? ` · 마감 ${next.dueAt.slice(0, 10)}` : ''
    const sent = notify?.(request.auth.tenantId, recipients.map((account) => ({
      type: 'material-review', recipientId: account.id, actorId: request.auth.id,
      title: `검토 요청: ${next.title}`,
      body: `${request.auth.name}님이 ${next.currentVersion}판에 대한 의견을 부탁했습니다${due}. 항목마다 찬성·수정해서·반대·질문 중 하나를 눌러 주세요.`,
      page: 'wiki', focusId: `material:${next.id}`, source: { kind: 'material', id: next.id, label: next.title },
    }))) ?? []
    response.json({ material: publicMaterial(next, request.auth, { full: true }), notified: sent.length })
  })

  /**
   * 마감 하루 전 알림 — **아직 결정 받을 항목에 한 번도 반응하지 않은 사람에게만**(공지 확인 요청과 같은 방식).
   * 이미 반응한 사람에게 또 울리면 알림을 끄게 된다. 자료마다 한 번만 보낸다.
   */
  const remindDue = async (now = clock()) => {
    let reminded = 0
    for (const tenantId of Object.keys(workspaceStore.tenants ?? {})) {
      const rows = materialsOf(tenantId)
      let changed = false
      const next = rows.map((material) => {
        if (material.status !== 'open' || !material.dueAt || material.dueRemindedAt) return material
        const dueAt = Date.parse(material.dueAt)
        if (!Number.isFinite(dueAt) || dueAt <= now.getTime() || dueAt - now.getTime() > 24 * 60 * 60 * 1_000) return material
        const reacted = new Set(feedbackOf(tenantId).filter((row) => row.materialId === material.id && (row.type === 'stance' || row.type === 'comment')).map((row) => row.authorId))
        const recipients = audienceOf(material).filter((account) => !reacted.has(account.id) && account.id !== material.ownerId)
        const sent = notify?.(tenantId, recipients.map((account) => ({
          type: 'material-due', recipientId: account.id, actorId: null,
          title: `내일 의견 마감: ${material.title}`,
          body: `아직 의견을 남기지 않았습니다. 마감 ${material.dueAt.slice(0, 10)}.`,
          page: 'wiki', focusId: `material:${material.id}`, source: { kind: 'material', id: material.id, label: material.title },
        }))) ?? []
        reminded += sent.length
        changed = true
        return { ...material, dueRemindedAt: now.toISOString() }
      })
      if (changed) {
        const tenantStore = tenantStoreOf(tenantId)
        tenantStore[MATERIALS_KEY] = { ...tenantStore[MATERIALS_KEY], data: next, updatedAt: now.toISOString(), updatedBy: 'system:material-due' }
      }
    }
    if (reminded) await commitWorkspaceStore()
    return { reminded }
  }

  // ── 자료 속 의견 가져오기 ─────────────────────────────────────────────────
  /**
   * AI 자료 안의 자체 검토 기능으로 모은 의견(복사해 붙여 넣은 글)을 앱의 기록으로 옮긴다 —
   * localStorage 시절의 의견이 사라지지 않게. 이름은 회사 사람과 정확히 하나가 맞을 때만 그 사람으로 잇고,
   * 아니면 "가져온 의견 · 이름"으로 남긴다. 같은 글을 두 번 붙여 넣어도 한 번만 들어간다.
   */
  app.post('/api/materials/:id/import-opinions', ...guards, async (request, response) => {
    const material = writableMaterial(request, response)
    if (!material) return
    if (!canManage(material, request.auth)) { fail(response, MATERIAL_ERRORS.MANAGE_FORBIDDEN); return }
    const blocks = extractReviewBlocks(String(request.body?.text ?? '').slice(0, 2_000_000))
    if (!blocks.length) { response.status(400).json({ error: { code: 'MATERIAL_IMPORT_EMPTY', message: '붙여 넣은 글에서 가져올 의견 묶음을 찾지 못했습니다. 자료의 [내 의견 복사]로 만든 글 전체를 붙여 넣어 주세요.' } }); return }
    const version = material.versions.find((row) => row.version === material.currentVersion)
    let anchors = []
    try { anchors = await anchorsOf(version) } catch { fail(response, MATERIAL_ERRORS.VERSION_NOT_FOUND); return }
    const lineageByKey = new Map(anchors.map((anchor) => [String(anchor.key), anchor.lineageId]))
    const plan = planImportedReviews(blocks, { lineageByKey })
    const members = tenantMembers(request.auth.tenantId)
    const personOf = (name) => {
      const matches = members.filter((account) => account.name === name)
      return matches.length === 1 ? { authorId: matches[0].id, authorName: matches[0].name } : { authorId: `imported:${name}`, authorName: `가져온 의견 · ${name}` }
    }
    const all = feedbackOf(request.auth.tenantId)
    const existing = new Set(all.filter((row) => row.materialId === material.id && row.imported).map((row) => row.importKey))
    const stamp = (value) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : nowIso())
    const added = []
    const add = (importKey, row) => {
      if (existing.has(importKey)) return
      existing.add(importKey)
      added.push({ id: `MFB-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`, materialId: material.id, version: material.currentVersion, imported: true, importKey, ...row })
    }
    for (const item of plan.stances) add(`s|${item.person}|${item.lineageId}|${item.stance}`, { type: 'stance', lineageId: item.lineageId, stance: item.stance, ...personOf(item.person), createdAt: stamp(item.at) })
    for (const item of plan.comments) add(`c|${item.person}|${item.lineageId}|${item.body}`, { type: 'comment', lineageId: item.lineageId, body: item.body, ...personOf(item.person), createdAt: stamp(item.at) })
    for (const item of plan.decisions) add(`d|${item.lineageId}|${item.status}|${item.note}`, { type: 'decision', lineageId: item.lineageId, decision: { status: item.status, note: item.note }, authorId: request.auth.id, authorName: `${request.auth.name}(가져온 결정)`, createdAt: stamp(item.at) })
    const rowsForMaterial = all.filter((row) => row?.materialId === material.id).length
    if (rowsForMaterial + added.length > 3_000 || all.length + added.length > 30_000) { fail(response, feedbackRefusal.FULL); return }
    if (added.length && !(await saveFeedback(request.auth, material.id, [...all, ...added], 'feedback', null))) { fail(response, MATERIAL_ERRORS.WRITE_FAILED); return }
    response.json({
      imported: { stances: added.filter((row) => row.type === 'stance').length, comments: added.filter((row) => row.type === 'comment').length, decisions: added.filter((row) => row.type === 'decision').length },
      people: plan.people,
      unmatchedKeys: plan.unmatchedKeys,
    })
  })

  // ── 결정 요약 · 결정 기록 문서 ────────────────────────────────────────────
  const decisionItems = async (material) => {
    const version = material.versions.find((row) => row.version === material.currentVersion)
    const anchors = await anchorsOf(version)
    const rows = materialFeedback(material.tenantId, material.id)
    const summary = summarizeFeedback(rows, { id: '' })
    const decisions = latestDecisions(rows)
    return anchors.filter((anchor) => anchor.decisionEnabled || decisions.has(anchor.lineageId)).map((anchor) => {
      const decision = decisions.get(anchor.lineageId)
      return {
        key: anchor.key, title: anchor.title,
        decision: decision ? { status: decision.decision?.status, note: decision.decision?.note ?? '', decidedByName: decision.authorName, decidedAt: decision.createdAt } : null,
        stances: summary[anchor.lineageId]?.stances ?? {}, comments: summary[anchor.lineageId]?.comments ?? 0,
      }
    })
  }

  app.get('/api/materials/:id/decision-summary', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const material = findMaterial(request.auth, request.params.id)
    if (!material) { fail(response, MATERIAL_ERRORS.NOT_FOUND); return }
    try {
      const items = await decisionItems(material)
      const markdown = decisionSummaryMarkdown({ title: material.title, version: material.currentVersion, generatedAt: nowIso().slice(0, 16).replace('T', ' '), items })
      response.json({ markdown, items })
    } catch (error) {
      console.error('[materials] 결정 요약을 만들지 못했습니다', { message: error?.message })
      fail(response, MATERIAL_ERRORS.VERSION_NOT_FOUND)
    }
  })

  /** [결정 기록 문서로 남기기] — 문서(위키)로 만들어 검색과 AI 맥락에 저절로 들어가게 한다. */
  app.post('/api/materials/:id/decision-record', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const material = findMaterial(request.auth, request.params.id)
    if (!material) { fail(response, MATERIAL_ERRORS.NOT_FOUND); return }
    if (!canDecide(material, request.auth)) { fail(response, decisionRefusal.FORBIDDEN); return }
    if (typeof createWikiDocument !== 'function') { fail(response, MATERIAL_ERRORS.WRITE_FAILED); return }
    const items = await decisionItems(material)
    const decidedCount = items.filter((item) => item.decision).length
    const fingerprint = createHash('sha256').update(JSON.stringify(items.map((item) => [item.key, item.decision?.status, item.decision?.note]))).digest('hex').slice(0, 16)
    const result = await createWikiDocument({
      auth: request.auth,
      title: `${material.title} — 결정 기록 (${material.currentVersion}판)`,
      blocks: decisionRecordBlocks({ title: material.title, version: material.currentVersion, items, newBlockId: newMeetingBlockId }),
      projectId: material.projectId ?? null,
      origin: { kind: 'material', label: '검토 자료 결정', detail: `${material.title} ${material.currentVersion}판`, page: 'wiki', focusId: `material:${material.id}` },
      // 같은 결정 상태로 두 번 누르면 새 문서를 또 만들지 않는다.
      systemRequestId: `material:${material.id}:v${material.currentVersion}:${fingerprint}`,
    })
    if (result?.refusal) { response.status(result.refusal.status).json({ error: { code: result.refusal.code, message: result.refusal.message } }); return }
    const documentId = result?.document?.id ?? null
    if (documentId && material.decisionDocId !== documentId) await saveMaterial(request.auth, { ...material, decisionDocId: documentId, updatedAt: nowIso() })
    response.status(result?.replayed ? 200 : 201).json({ documentId, decidedCount, replayed: Boolean(result?.replayed) })
  })

  // ── 판 사이 짝 확인 ──────────────────────────────────────────────────────
  /**
   * 애매한 짝(비슷하지만 확실하지 않음 · 번호는 같은데 내용이 다름)은 **사람이 확인하기 전까지 다른 항목**이다 —
   * 의견이 엉뚱한 항목으로 옮겨 가면 되돌리기 어렵다. 여기서 [같은 항목]을 누르면 그 새 항목을 지난 판의 계보에 잇는다.
   */
  const unresolvedProposals = async (version) => {
    if (!version?.mappingKey) return []
    let mapping = null
    try { mapping = await readJson(version.mappingKey) } catch { return [] }
    const resolved = new Set((version.resolvedLinks ?? []).map((row) => row.nextId))
    return (mapping?.proposals ?? []).filter((row) => !resolved.has(row.nextId))
  }

  app.get('/api/materials/:id/versions/:version/links', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const material = findMaterial(request.auth, request.params.id)
    if (!material) { fail(response, MATERIAL_ERRORS.NOT_FOUND); return }
    const version = versionOf(material, request.params.version)
    if (!version) { fail(response, MATERIAL_ERRORS.VERSION_NOT_FOUND); return }
    const proposals = await unresolvedProposals(version)
    // 두 줄씩 견줘 볼 수 있게 앞부분 글을 붙인다(본문 전체는 싣지 않는다).
    let excerpts = new Map()
    if (proposals.length) {
      try {
        const current = await anchorsOf(version)
        const previousVersion = material.versions.filter((row) => row.version < version.version).sort((left, right) => right.version - left.version)[0]
        const previous = previousVersion ? await anchorsOf(previousVersion) : []
        const byLineage = new Map(previous.map((anchor) => [anchor.lineageId, anchor]))
        const byId = new Map(current.map((anchor) => [anchor.id, anchor]))
        excerpts = new Map(proposals.map((row) => [row.nextId, { before: String(byLineage.get(row.lineageId)?.text ?? '').slice(0, 240), after: String(byId.get(row.nextId)?.text ?? '').slice(0, 240) }]))
      } catch { /* 글이 없어도 제목으로 고를 수 있다 */ }
    }
    response.json({ proposals: proposals.map((row) => ({ ...row, ...(excerpts.get(row.nextId) ?? {}) })) })
  })

  app.post('/api/materials/:id/versions/:version/links', ...guards, async (request, response) => {
    const material = writableMaterial(request, response)
    if (!material) return
    if (!canManage(material, request.auth)) { fail(response, MATERIAL_ERRORS.MANAGE_FORBIDDEN); return }
    const version = versionOf(material, request.params.version)
    if (!version) { fail(response, MATERIAL_ERRORS.VERSION_NOT_FOUND); return }
    const pending = new Map((await unresolvedProposals(version)).map((row) => [row.nextId, row]))
    const choices = (Array.isArray(request.body?.choices) ? request.body.choices : []).slice(0, 500)
      .map((choice) => ({ nextId: String(choice?.nextId ?? ''), same: choice?.same === true }))
      .filter((choice) => pending.has(choice.nextId))
    if (!choices.length) { response.status(400).json({ error: { code: 'MATERIAL_LINKS_EMPTY', message: '확인할 짝을 골라 주세요. 이미 확인한 짝일 수 있습니다.' } }); return }
    let anchors
    try { anchors = await anchorsOf(version) } catch { fail(response, MATERIAL_ERRORS.VERSION_NOT_FOUND); return }
    const originalAnchors = JSON.stringify({ version: version.version, anchors })
    const lineages = (material.lineages ?? []).map((row) => ({ ...row }))
    const all = feedbackOf(request.auth.tenantId)
    let feedback = all
    let joined = 0
    for (const choice of choices) {
      if (!choice.same) continue
      const proposal = pending.get(choice.nextId)
      const anchor = anchors.find((row) => row.id === choice.nextId)
      const target = lineages.find((row) => row.id === proposal.lineageId)
      // 그 사이 옛 계보가 다른 항목과 이어졌으면 잇지 않는다(한 계보에 한 항목).
      if (!anchor || !target || anchors.some((row) => row.lineageId === target.id)) continue
      const orphan = anchor.lineageId
      anchor.lineageId = target.id
      target.lastVersion = version.version
      target.title = String(anchor.title ?? target.title).slice(0, 120)
      target.key = anchor.key
      target.decisionEnabled = target.decisionEnabled || Boolean(anchor.decisionEnabled)
      // 짝을 확인하기 전에 새 계보에 남은 의견은 옛 계보로 옮긴다(버리지 않는다). 옮긴 사실은 줄에 남는다.
      feedback = feedback.map((row) => (row.materialId === material.id && row.lineageId === orphan ? { ...row, lineageId: target.id, movedFromLineageId: orphan } : row))
      const index = lineages.findIndex((row) => row.id === orphan)
      if (index >= 0) lineages.splice(index, 1)
      joined += 1
    }
    const now = nowIso()
    const resolvedLinks = [...(version.resolvedLinks ?? []), ...choices.map((choice) => ({ nextId: choice.nextId, lineageId: pending.get(choice.nextId).lineageId, same: choice.same, byId: request.auth.id, at: now }))]
    const nextVersion = { ...version, resolvedLinks, links: version.links ? { ...version.links, proposals: Math.max(0, (version.links.proposals ?? 0) - choices.length), moved: (version.links.moved ?? 0) + joined, added: Math.max(0, (version.links.added ?? 0) - joined) } : version.links }
    const next = { ...material, lineages, versions: material.versions.map((row) => (row.version === version.version ? nextVersion : row)), updatedAt: now }
    try {
      if (joined) await documentStorage.put(version.anchorsKey, Buffer.from(JSON.stringify({ version: version.version, anchors })), { contentType: 'application/json' })
    } catch (error) {
      console.error('[materials] 항목 파일을 고치지 못했습니다', { message: error?.message })
      fail(response, MATERIAL_ERRORS.WRITE_FAILED); return
    }
    const tenantStore = tenantStoreOf(request.auth.tenantId)
    const previousMaterials = tenantStore[MATERIALS_KEY]
    const previousFeedback = tenantStore[MATERIAL_FEEDBACK_KEY]
    tenantStore[MATERIALS_KEY] = { data: materialsOf(request.auth.tenantId).map((row) => (row.id === material.id ? next : row)), updatedAt: now, updatedBy: request.auth.id }
    if (feedback !== all) tenantStore[MATERIAL_FEEDBACK_KEY] = { data: feedback, updatedAt: now, updatedBy: request.auth.id }
    try {
      await commitWorkspaceStore()
    } catch (error) {
      if (previousMaterials) tenantStore[MATERIALS_KEY] = previousMaterials; else delete tenantStore[MATERIALS_KEY]
      if (previousFeedback) tenantStore[MATERIAL_FEEDBACK_KEY] = previousFeedback; else delete tenantStore[MATERIAL_FEEDBACK_KEY]
      if (joined) await documentStorage.put(version.anchorsKey, Buffer.from(originalAnchors), { contentType: 'application/json' }).catch(() => undefined)
      console.error('[materials] 짝 확인을 저장하지 못했습니다', { message: error?.message })
      fail(response, MATERIAL_ERRORS.WRITE_FAILED); return
    }
    events?.publish(request.auth.tenantId, 'material', { materialId: material.id, what: 'version', version: version.version })
    response.json({ joined, separate: choices.length - joined, remaining: pending.size - choices.length, material: publicMaterial(next, request.auth, { full: true }) })
  })

  // ── 판 비교 ──────────────────────────────────────────────────────────────
  /**
   * 두 판을 계보로 맞대어 본다: 그대로 · 바뀜 · 새 항목 · 빠진 항목, 바뀐 항목은 어절 단위 비교.
   * **반영 확인(AI 없이 계산)**: 지난 판에서 반영·수정 후 반영으로 결정한 항목 중 이번 판에서도 그대로인 것 —
   * "결정했는데 AI가 고치지 않은 곳"이 여기서 드러난다.
   */
  app.get('/api/materials/:id/compare', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const material = findMaterial(request.auth, request.params.id)
    if (!material) { fail(response, MATERIAL_ERRORS.NOT_FOUND); return }
    const to = versionOf(material, request.query.to)
    const fromNumber = Number.parseInt(String(request.query.from ?? ''), 10)
    const from = Number.isFinite(fromNumber)
      ? material.versions.find((row) => row.version === fromNumber)
      : material.versions.filter((row) => row.version < (to?.version ?? 0)).sort((left, right) => right.version - left.version)[0]
    if (!to || !from || from.version === to.version) { response.status(400).json({ error: { code: 'MATERIAL_COMPARE_INVALID', message: '비교할 두 판을 골라 주세요.' } }); return }
    let before
    let after
    try { [before, after] = await Promise.all([anchorsOf(from), anchorsOf(to)]) } catch { fail(response, MATERIAL_ERRORS.VERSION_NOT_FOUND); return }
    const beforeByLineage = new Map(before.map((anchor) => [anchor.lineageId, anchor]))
    const afterByLineage = new Map(after.map((anchor) => [anchor.lineageId, anchor]))
    const items = []
    const summary = { same: 0, changed: 0, added: 0, removed: 0 }
    for (const anchor of after) {
      const previous = beforeByLineage.get(anchor.lineageId)
      if (!previous) { summary.added += 1; items.push({ lineageId: anchor.lineageId, status: 'added', key: anchor.key, title: anchor.title, after: anchor.text.slice(0, 1_200) }); continue }
      if (previous.textHash === anchor.textHash) { summary.same += 1; continue }
      summary.changed += 1
      items.push({ lineageId: anchor.lineageId, status: 'changed', key: anchor.key, title: anchor.title, previousTitle: previous.title, diff: wordDiff(previous.text, anchor.text, { maxChars: 4_000 }) })
    }
    for (const anchor of before) {
      if (afterByLineage.has(anchor.lineageId)) continue
      summary.removed += 1
      items.push({ lineageId: anchor.lineageId, status: 'removed', key: anchor.key, title: anchor.title, before: anchor.text.slice(0, 1_200) })
    }
    // 지난 판까지의 결정 중 반영·수정 후 반영 — 이번 판에서 그대로인 항목을 짚는다.
    const decisions = [...latestDecisions(materialFeedback(material.tenantId, material.id).filter((row) => row.version <= from.version)).values()]
      .map((row) => ({ lineageId: row.lineageId, status: row.decision?.status }))
    const linkStatus = after.filter((anchor) => beforeByLineage.has(anchor.lineageId)).map((anchor) => ({ lineageId: anchor.lineageId, status: beforeByLineage.get(anchor.lineageId).textHash === anchor.textHash ? 'same' : 'changed' }))
    const reflection = carryOverSummary({ decisions, links: linkStatus })
    const titleOf = (lineageId) => afterByLineage.get(lineageId)?.title ?? beforeByLineage.get(lineageId)?.title ?? ''
    response.json({
      from: from.version,
      to: to.version,
      summary,
      items: items.slice(0, 400),
      truncated: items.length > 400,
      reflection: {
        decided: decisions.filter((row) => row.status === '반영' || row.status === '수정 후 반영').length,
        reflected: reflection.reflected,
        unchanged: reflection.unchangedAfterDecision.map((lineageId) => ({ lineageId, title: titleOf(lineageId) })),
      },
    })
  })

  // ── 정리: 규칙(누구나) · AI(올린 사람·결정권자) ────────────────────────────
  /** 회의 준비표 — 의견이 갈린 항목, 답 없는 질문, 아무도 반응하지 않은 결정 항목, 규칙 제안. AI 없이 센다. */
  app.get('/api/materials/:id/overview', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const material = findMaterial(request.auth, request.params.id)
    if (!material) { fail(response, MATERIAL_ERRORS.NOT_FOUND); return }
    const version = material.versions.find((row) => row.version === material.currentVersion)
    let anchors
    try { anchors = await anchorsOf(version) } catch { fail(response, MATERIAL_ERRORS.VERSION_NOT_FOUND); return }
    const rows = materialFeedback(material.tenantId, material.id)
    const overview = ruleOverview({
      items: anchors.map((anchor) => ({ lineageId: anchor.lineageId, key: anchor.key, title: anchor.title, decisionEnabled: anchor.decisionEnabled })),
      summary: summarizeFeedback(rows, request.auth),
      decisions: latestDecisions(rows),
      comments: rows.filter((row) => row.type === 'comment').map((row) => ({ id: row.id, lineageId: row.lineageId, parentId: row.parentId ?? null, question: Boolean(row.question), body: row.body ?? '', authorName: row.authorName, deleted: Boolean(row.deletedAt) })),
    })
    response.json({ ...overview, aiAvailable: Boolean(client) })
  })

  const aiRefusal = {
    UNAVAILABLE: refusal(409, 'MATERIAL_AI_UNAVAILABLE', 'AI 연결이 없어 AI 정리를 쓸 수 없습니다. [회의 준비]의 규칙 정리를 보세요.'),
    FORBIDDEN: refusal(403, 'MATERIAL_AI_FORBIDDEN', 'AI 정리(비용이 드는 일)는 자료를 올린 사람, 결정권자, 회사 관리자만 실행할 수 있습니다.'),
    EMPTY: refusal(400, 'MATERIAL_AI_NOTHING', '정리할 의견이 아직 없습니다.'),
    INVALID: refusal(502, 'MATERIAL_AI_INVALID', 'AI 정리가 근거를 제대로 대지 못해 버렸습니다. 잠시 뒤 다시 눌러 주세요.'),
  }

  /**
   * 항목 하나의 AI 정리. 결과는 **초안**으로 기록에 남고(누가·언제·어느 모델), 근거 없는 문장은 버린다.
   * 사용량은 원장에 예약 → 기록한다(회의록 요약과 같은 한 벌).
   */
  app.post('/api/materials/:id/ai-synthesis', ...guards, async (request, response) => {
    const material = writableMaterial(request, response)
    if (!material) return
    if (!client) { fail(response, aiRefusal.UNAVAILABLE); return }
    if (!canDecide(material, request.auth)) { fail(response, aiRefusal.FORBIDDEN); return }
    const lineage = lineageIdFrom(material, request.body?.lineageId)
    if (!lineage.ok || !lineage.lineageId) { fail(response, feedbackRefusal.LINEAGE_NOT_FOUND); return }
    const version = material.versions.find((row) => row.version === material.currentVersion)
    let anchors
    try { anchors = await anchorsOf(version) } catch { fail(response, MATERIAL_ERRORS.VERSION_NOT_FOUND); return }
    const anchor = anchors.find((row) => row.lineageId === lineage.lineageId)
    if (!anchor) { fail(response, feedbackRefusal.LINEAGE_NOT_FOUND); return }
    const rows = materialFeedback(request.auth.tenantId, material.id)
    const stanceByAuthor = new Map()
    for (const row of rows.filter((item) => item.type === 'stance' && item.lineageId === lineage.lineageId).sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))) stanceByAuthor.set(row.authorId, row.stance)
    const comments = rows.filter((row) => row.type === 'comment' && row.lineageId === lineage.lineageId && !row.deletedAt)
      .map((row) => ({ id: row.id, authorName: row.authorName, body: row.body, question: Boolean(row.question), stance: stanceByAuthor.get(row.authorId) ?? null }))
    if (!comments.length) { fail(response, aiRefusal.EMPTY); return }
    const stances = summarizeFeedback(rows, request.auth)[lineage.lineageId]?.stances ?? { agree: 0, amend: 0, oppose: 0, question: 0 }
    const { system, user } = buildItemSynthesisPrompt({ materialTitle: material.title, item: anchor, comments, stances })
    const startedAt = clock()
    const usageActor = { id: 'server:material-synthesis', role: 'system', trusted: true, tenantId: request.auth.tenantId }
    let reservation = null
    let providerSucceeded = false
    try {
      const messages = [{ role: 'user', content: user }]
      if (billingService) {
        const counted = typeof client.messages.countTokens === 'function'
          ? await client.messages.countTokens({ model, system, messages })
          : { input_tokens: Math.ceil(JSON.stringify({ system, messages }).length / 4) }
        reservation = (await billingService.reserveUsage(usageActor, {
          id: `material-synthesis-res:${request.auth.tenantId}:${request.auth.id}:${randomBytes(12).toString('hex')}`,
          tenantId: request.auth.tenantId, userId: request.auth.id, feature: 'material-synthesis', model,
          estimatedInputTokens: Number(counted.input_tokens || 0), estimatedOutputTokens: 1_500, occurredAt: startedAt.toISOString(),
        })).reservation
      }
      const result = await client.messages.create({ model, max_tokens: 1_500, system, messages })
      providerSucceeded = true
      if (billingService) {
        try {
          await billingService.recordUsageEvent(usageActor, {
            id: `anthropic:${result.id || randomBytes(12).toString('hex')}`, tenantId: request.auth.tenantId, userId: request.auth.id,
            feature: 'material-synthesis', model: reservation?.model ?? model,
            inputTokens: Number(result.usage?.input_tokens || 0), outputTokens: Number(result.usage?.output_tokens || 0),
            occurredAt: startedAt.toISOString(), durationMs: Math.max(0, clock().getTime() - startedAt.getTime()),
            metadata: { materialId: material.id, lineageId: lineage.lineageId, ...usageMetadataFor(request.auth) },
            reservationId: reservation?.id ?? null,
          })
        } catch (error) { console.error('[materials] AI 정리 사용량을 남기지 못했습니다', { message: error?.message }) }
      }
      const text = typeof extractText === 'function' ? extractText(result) : (result.content ?? []).map((block) => block?.text ?? '').join('')
      const output = validateItemSynthesis(text, comments.map((row) => row.id))
      if (!output) { fail(response, aiRefusal.INVALID); return }
      const all = feedbackOf(request.auth.tenantId)
      const row = {
        id: `MFB-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
        materialId: material.id, lineageId: lineage.lineageId, version: material.currentVersion,
        type: 'ai-output', authorId: request.auth.id, authorName: request.auth.name,
        output, model: result.model || model, readFeedbackIds: comments.map((item) => item.id).slice(0, 200), createdAt: nowIso(),
      }
      if (!(await saveFeedback(request.auth, material.id, [...all, row], 'feedback', lineage.lineageId))) { fail(response, MATERIAL_ERRORS.WRITE_FAILED); return }
      response.json({ aiOutput: { id: row.id, output, model: row.model, runByName: row.authorName, createdAt: row.createdAt, version: row.version } })
    } catch (error) {
      if (!providerSucceeded && reservation && billingService) {
        try { await billingService.releaseUsageReservation(usageActor, { tenantId: request.auth.tenantId, reservationId: reservation.id }) } catch { /* 예약은 만료로 풀린다 */ }
      }
      if (error?.name === 'BillingServiceError') { response.status(error.status).json({ error: { code: error.code, message: error.message } }); return }
      console.error('[materials] AI 정리에 실패했습니다', { message: error?.message })
      const mapped = typeof mapAnthropicError === 'function' ? mapAnthropicError(error) : { status: 502, code: 'CLAUDE_API_ERROR', message: 'Claude 응답을 가져오지 못했습니다. 잠시 후 다시 시도해 주세요.' }
      response.status(mapped.status).json({ error: { code: mapped.code, message: mapped.message } })
    }
  })

  // ── 결정 → 업무 ──────────────────────────────────────────────────────────
  /**
   * 반영·수정 후 반영으로 결정한 항목을 업무로. **길은 하나다**: 승인 큐에 material-task 제안으로 올린다.
   * 관리자는 화면에서 그 자리의 [바로 승인]으로 기존 결정 라우트(POST /api/proposals/:id/decide)를 부른다 — 새 승인 문을 만들지 않는다.
   */
  const taskRefusal = {
    NOT_DECIDED: refusal(409, 'MATERIAL_TASK_NOT_DECIDED', '반영 또는 수정 후 반영으로 결정한 항목만 업무로 만들 수 있습니다.'),
    TITLE: refusal(400, 'MATERIAL_TASK_TITLE', '업무 제목을 2자 이상 적어 주세요.'),
    OWNER: refusal(400, 'MATERIAL_TASK_OWNER', '담당자를 이 회사 사람 중에서 골라 주세요.'),
    DUPLICATE: refusal(409, 'MATERIAL_TASK_PENDING', '이 항목의 업무 제안이 이미 승인 큐에서 기다리고 있습니다.'),
    UNAVAILABLE: refusal(503, 'MATERIAL_TASK_UNAVAILABLE', '승인 큐에 연결되지 않아 업무를 만들 수 없습니다.'),
  }
  const materialTasksOf = (tenantId, materialId) => (typeof proposalsOf === 'function' ? proposalsOf(tenantId) : [])
    .filter((row) => row?.kind === 'material-task' && row.payload?.materialId === materialId)

  app.get('/api/materials/:id/tasks', ...guards, (request, response) => {
    if (!requireTenant(request, response)) return
    const material = findMaterial(request.auth, request.params.id)
    if (!material) { fail(response, MATERIAL_ERRORS.NOT_FOUND); return }
    const workItems = Array.isArray(workspaceStore.tenants[request.auth.tenantId]?.['work-items']?.data) ? workspaceStore.tenants[request.auth.tenantId]['work-items'].data : []
    const tasks = materialTasksOf(request.auth.tenantId, material.id).map((proposal) => {
      const workItemId = proposal.resultRef?.type === 'work-item' ? proposal.resultRef.id : null
      const workItem = workItemId ? workItems.find((row) => row?.id === workItemId) : null
      return {
        proposalId: proposal.id, lineageId: proposal.payload.lineageId, title: proposal.payload.title, owner: proposal.payload.owner,
        status: proposal.status, workItemId, workStatus: workItem?.status ?? (workItemId ? '보관됨' : null), createdAt: proposal.createdAt,
      }
    })
    response.json({ tasks, canApprove: request.auth.role === 'tenant-admin' })
  })

  app.post('/api/materials/:id/tasks', ...guards, async (request, response) => {
    const material = writableMaterial(request, response)
    if (!material) return
    if (!canDecide(material, request.auth)) { fail(response, decisionRefusal.FORBIDDEN); return }
    if (typeof enqueueProposal !== 'function' || typeof newProposalId !== 'function') { fail(response, taskRefusal.UNAVAILABLE); return }
    const lineage = lineageIdFrom(material, request.body?.lineageId)
    if (!lineage.ok || !lineage.lineageId) { fail(response, feedbackRefusal.LINEAGE_NOT_FOUND); return }
    const decision = latestDecisions(materialFeedback(request.auth.tenantId, material.id)).get(lineage.lineageId)
    if (!decision || !['반영', '수정 후 반영'].includes(decision.decision?.status)) { fail(response, taskRefusal.NOT_DECIDED); return }
    const title = String(request.body?.title ?? '').replace(/s+/g, ' ').trim().slice(0, 120)
    if (title.length < 2) { fail(response, taskRefusal.TITLE); return }
    const owner = tenantMembers(request.auth.tenantId).find((account) => account.id === String(request.body?.ownerId || request.auth.id))
    if (!owner) { fail(response, taskRefusal.OWNER); return }
    const due = request.body?.due && Number.isFinite(Date.parse(String(request.body.due))) ? new Date(String(request.body.due)).toISOString() : ''
    const lineageRow = material.lineages.find((row) => row.id === lineage.lineageId)
    const existing = materialTasksOf(request.auth.tenantId, material.id).filter((row) => row.payload?.lineageId === lineage.lineageId)
    if (existing.some((row) => row.status === 'pending')) { fail(response, taskRefusal.DUPLICATE); return }
    const now = nowIso()
    const note = decision.decision?.note ? ` — ${decision.decision.note}` : ''
    const proposal = {
      id: newProposalId(),
      kind: 'material-task',
      status: 'pending',
      sourceKey: `mat:${material.id}:${lineage.lineageId}:${existing.length + 1}`,
      summary: title,
      evidence: `${material.title} ${material.currentVersion}판 · ${lineageRow?.key ? `${lineageRow.key} ` : ''}${lineageRow?.title ?? ''}\n결정: ${decision.decision?.status}${note} (${decision.authorName})`,
      confidence: null,
      payload: {
        title,
        description: String(request.body?.description ?? '').trim().slice(0, 2_000) || `검토 자료 「${material.title}」의 결정(${decision.decision?.status}${note})을 실행합니다.`,
        owner: owner.name,
        due,
        priority: '보통',
        category: '검토 자료',
        materialId: material.id,
        lineageId: lineage.lineageId,
        version: material.currentVersion,
      },
      createdAt: now,
      createdBy: request.auth.id,
    }
    const tenantStore = tenantStoreOf(request.auth.tenantId)
    const before = ['ai-proposals', 'automation-policies'].map((key) => [key, tenantStore[key]])
    if (!enqueueProposal(request.auth.tenantId, proposal, { announce: false })) { fail(response, taskRefusal.DUPLICATE); return }
    try {
      await commitWorkspaceStore()
    } catch (error) {
      for (const [key, record] of before) { if (record) tenantStore[key] = record; else delete tenantStore[key] }
      console.error('[materials] 업무 제안을 저장하지 못했습니다', { message: error?.message })
      fail(response, MATERIAL_ERRORS.WRITE_FAILED); return
    }
    announceProposal?.(request.auth.tenantId, proposal)
    events?.publish(request.auth.tenantId, 'material', { materialId: material.id, what: 'task', lineageId: lineage.lineageId })
    response.status(201).json({ proposalId: proposal.id, canApprove: request.auth.role === 'tenant-admin' })
  })

  // ── 한 바퀴 닫기: 다음 판 요청서 · 전체 기록 ──────────────────────────────
  /**
   * 다음 판 요청서 — 결정·업무 상태·답 없는 질문·의견 요약·항목 번호 규칙을 한 글로. AI 없이 규칙으로 조립한다.
   * 이 글을 앱 밖의 AI(Claude 등)에 붙여 넣어 다음 판을 받는다. 규칙을 지킨 판은 번호만으로 정확히 이어진다.
   */
  app.get('/api/materials/:id/next-version-request', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const material = findMaterial(request.auth, request.params.id)
    if (!material) { fail(response, MATERIAL_ERRORS.NOT_FOUND); return }
    const version = material.versions.find((row) => row.version === material.currentVersion)
    let anchors
    try { anchors = await anchorsOf(version) } catch { fail(response, MATERIAL_ERRORS.VERSION_NOT_FOUND); return }
    const rows = materialFeedback(material.tenantId, material.id)
    const summary = summarizeFeedback(rows, request.auth)
    const decisions = latestDecisions(rows)
    const tasks = materialTasksOf(request.auth.tenantId, material.id)
    const workItems = Array.isArray(workspaceStore.tenants[request.auth.tenantId]?.['work-items']?.data) ? workspaceStore.tenants[request.auth.tenantId]['work-items'].data : []
    const stanceOf = new Map()
    for (const row of rows.filter((item) => item.type === 'stance').sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))) stanceOf.set(`${row.lineageId}|${row.authorId}`, row.stance)
    const answered = new Set(rows.filter((row) => row.type === 'comment' && row.parentId && !row.deletedAt).map((row) => row.parentId))
    const TASK_WORDS = { pending: '승인 대기', approved: '업무로 생성', edited: '업무로 생성', rejected: '거절됨', expired: '만료됨' }
    const items = anchors.filter((anchor) => anchor.decisionEnabled || decisions.has(anchor.lineageId) || summary[anchor.lineageId]).map((anchor) => {
      const decision = decisions.get(anchor.lineageId)
      const task = tasks.filter((row) => row.payload?.lineageId === anchor.lineageId).at(0)
      const workItem = task?.resultRef?.type === 'work-item' ? workItems.find((row) => row?.id === task.resultRef.id) : null
      const comments = rows.filter((row) => row.type === 'comment' && row.lineageId === anchor.lineageId && !row.deletedAt && !row.parentId)
      return {
        key: anchor.key, title: anchor.title,
        decision: decision ? { status: decision.decision?.status, note: decision.decision?.note ?? '' } : null,
        task: task ? { status: TASK_WORDS[task.status] ?? task.status, workStatus: workItem?.status ?? null } : null,
        stances: summary[anchor.lineageId]?.stances ?? {},
        comments: summary[anchor.lineageId]?.comments ?? 0,
        openQuestions: comments.filter((row) => row.question && !answered.has(row.id)).map((row) => String(row.body).replace(/\s+/g, ' ').slice(0, 200)),
        samples: comments.filter((row) => !row.question).slice(-3).map((row) => ({ stance: stanceOf.get(`${anchor.lineageId}|${row.authorId}`) ?? null, body: String(row.body).replace(/\s+/g, ' ').slice(0, 200) })),
      }
    })
    response.json({ markdown: nextVersionRequestMarkdown({ title: material.title, version: material.currentVersion, materialKey: material.materialKey || material.id, items }), rules: AUTHORING_RULES })
  })

  /**
   * 전체 기록 ZIP — 원본(판마다) · 항목 · 의견/결정 기록(지운 흔적 포함) · 결정 CSV · AI 기록 · 설명서.
   * 회사 전체 내보내기(나중)에 이 묶음을 그대로 끼운다. 내보낸 사실은 감사 기록에 남긴다.
   */
  app.get('/api/materials/:id/export', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const material = findMaterial(request.auth, request.params.id)
    if (!material) { fail(response, MATERIAL_ERRORS.NOT_FOUND); return }
    try {
      const entries = []
      const anchorsByVersion = new Map()
      for (const version of [...material.versions].sort((left, right) => left.version - right.version).slice(-60)) {
        const document = documentsOf(material.tenantId).find((row) => row?.id === version.sourceDocumentId)
        if (document) {
          try { entries.push({ name: `original/v${version.version}.html`, body: await getTenantDocument(documentStorage, document, material.tenantId), modifiedAt: version.importedAt }) }
          catch { entries.push({ name: `original/v${version.version}-missing.txt`, body: '원본 파일을 저장소에서 찾지 못했습니다.' }) }
        }
        const anchors = await anchorsOf(version).catch(() => [])
        anchorsByVersion.set(version.version, anchors)
        entries.push({ name: `anchors/v${version.version}.json`, body: JSON.stringify(anchors, null, 2), modifiedAt: version.importedAt })
      }
      const rows = [...materialFeedback(material.tenantId, material.id)].sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
      const humanRows = rows.filter((row) => row.type !== 'ai-output')
      entries.push({ name: 'feedback.jsonl', body: humanRows.map((row) => JSON.stringify(row)).join('\n') + (humanRows.length ? '\n' : '') })
      const lineageTitle = (lineageId, version) => {
        const anchor = (anchorsByVersion.get(version) ?? []).find((row) => row.lineageId === lineageId)
        const lineage = material.lineages.find((row) => row.id === lineageId)
        return { key: anchor?.key ?? lineage?.key ?? '', title: anchor?.title ?? lineage?.title ?? '' }
      }
      entries.push({
        name: 'decisions.csv',
        body: decisionsCsv(rows.filter((row) => row.type === 'decision').map((row) => ({ version: row.version, ...lineageTitle(row.lineageId, row.version), status: row.decision?.status, note: row.decision?.note, decidedByName: row.authorName, decidedAt: row.createdAt, adoption: row.adoption }))),
      })
      const aiRows = rows.filter((row) => row.type === 'ai-output')
      entries.push({ name: 'ai-runs.jsonl', body: aiRows.map((row) => JSON.stringify(row)).join('\n') + (aiRows.length ? '\n' : '') })
      entries.push({ name: 'material.json', body: JSON.stringify({ id: material.id, title: material.title, materialKey: material.materialKey, ownerName: material.ownerName, currentVersion: material.currentVersion, versions: material.versions.map((version) => ({ version: version.version, versionNote: version.versionNote, importedAt: version.importedAt, importedByName: version.importedByName, sha256: version.sha256, size: version.size, links: version.links })), lineages: material.lineages }, null, 2) })
      entries.push({
        name: 'README.txt',
        body: [
          `「${material.title}」 검토 기록 (${nowIso()} 내보냄)`,
          '',
          'original/v{n}.html   각 판의 원본(올린 그대로)',
          'anchors/v{n}.json    앱이 찾은 항목과 계보(lineageId). 판이 바뀌어도 같은 항목은 같은 계보다',
          'feedback.jsonl       찬반·의견·결정의 모든 줄(고친 이력·지운 흔적 포함). 한 줄이 한 기록',
          'decisions.csv        결정 이력(엑셀에서 열림). AI 초안 칸: adopted=초안 그대로, edited=고쳐서 채택',
          'ai-runs.jsonl        AI 정리 기록(초안). 모든 주장에 근거 의견 id가 붙어 있다',
          'material.json        판 목록과 항목 계보',
          '',
        ].join('\r\n'),
      })
      const zip = createStoredZip(entries)
      appendAudit?.({ tenantId: material.tenantId, event: '검토 자료 내보내기', scope: `${material.title} · 판 ${material.versions.length}개 · 기록 ${rows.length}줄`, actor: request.auth.name, reference: material.id })
      const fileName = `${safeArchiveSegment(material.title, 'material')}-검토기록.zip`
      response.setHeader('content-type', 'application/zip')
      response.setHeader('content-disposition', `attachment; filename="material-export.zip"; filename*=UTF-8''${encodeURIComponent(fileName)}`)
      response.send(zip)
    } catch (error) {
      console.error('[materials] 내보내기에 실패했습니다', { message: error?.message })
      response.status(500).json({ error: { code: 'MATERIAL_EXPORT_FAILED', message: '기록을 묶지 못했습니다. 잠시 뒤 다시 눌러 주세요.' } })
    }
  })

  return { materialsOf, sourceDocumentIds, canSee, findMaterial, publicMaterial, feedbackOf, remindDue }
}

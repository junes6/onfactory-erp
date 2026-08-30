import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  normalizeGap,
  normalizeNote,
  normalizeSettings,
  PersonalCoreError,
  personalCoreOf,
  principleStatus,
  trimRows,
  upsertGap,
} from './personal-core.mjs'

/**
 * 개인 지식 코어 라우트. 소유자는 언제나 "로그인한 계정 자신"이며,
 * 요청 본문이나 쿼리로 다른 소유자를 지정할 방법을 두지 않는다 (존재 자체가 조회되지 않는다).
 */
export function registerPersonalCoreRoutes({ app, requireAuth, workspaceStore, commitWorkspaceStore, clock = () => new Date() }) {
  /** 개인 코어는 고객사 관리자 이상만 갖는다 (플랫폼 운영자 포함). */
  const requirePersonalCore = (request, response, next) => {
    if (!['tenant-admin', 'platform-operator'].includes(request.auth?.role)) {
      response.status(403).json({ error: { code: 'PERSONAL_CORE_FORBIDDEN', message: '내 판단 기록은 회사 관리자 이상 계정에서 사용할 수 있습니다.' } })
      return
    }
    next()
  }

  const owner = (request) => request.sessionAccount?.id ?? request.auth?.id
  const publicCore = (core, now) => ({
    principles: core.principles.map((item) => ({ ...item, state: principleStatus(item, now) })),
    notes: core.notes,
    corrections: core.corrections.slice(0, 50),
    gaps: core.gaps,
    settings: { confidenceThreshold: core.settings?.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD },
  })

  const persist = async (response, mutate) => {
    const snapshot = JSON.stringify(workspaceStore.personal ?? {})
    try {
      const result = mutate()
      await commitWorkspaceStore()
      return result
    } catch (error) {
      workspaceStore.personal = JSON.parse(snapshot)
      if (error instanceof PersonalCoreError) {
        response.status(error.status).json({ error: { code: error.code, message: error.message } })
        return null
      }
      response.status(500).json({ error: { code: 'PERSONAL_WRITE_FAILED', message: '내 판단 기록을 저장하지 못했습니다.' } })
      return null
    }
  }

  app.get('/api/personal/core', requireAuth, requirePersonalCore, (request, response) => {
    const now = clock()
    response.json(publicCore(personalCoreOf(workspaceStore, owner(request)), now))
  })

  app.put('/api/personal/settings', requireAuth, requirePersonalCore, async (request, response) => {
    const core = personalCoreOf(workspaceStore, owner(request))
    const result = await persist(response, () => {
      core.settings = normalizeSettings(request.body?.settings)
      return core.settings
    })
    if (result) response.json({ settings: result })
  })

  app.post('/api/personal/notes', requireAuth, requirePersonalCore, async (request, response) => {
    const now = clock()
    const core = personalCoreOf(workspaceStore, owner(request))
    let note
    try { note = normalizeNote(request.body, { now }) }
    catch (error) {
      if (error instanceof PersonalCoreError) { response.status(error.status).json({ error: { code: error.code, message: error.message } }); return }
      throw error
    }
    const gapId = String(request.body?.gapId ?? '').trim()
    const result = await persist(response, () => {
      core.notes = trimRows([{ ...note, gapId }, ...core.notes])
      if (gapId) {
        // "지금 알려주기"로 채운 공백은 해소로 표시하고 노트와 연결한다.
        core.gaps = core.gaps.map((gap) => gap.id === gapId
          ? { ...gap, status: 'resolved', resolvedAt: now.toISOString(), noteId: note.id }
          : gap)
      }
      return note
    })
    if (result) response.status(201).json({ note: result, core: publicCore(core, now) })
  })

  app.delete('/api/personal/notes/:id', requireAuth, requirePersonalCore, async (request, response) => {
    const core = personalCoreOf(workspaceStore, owner(request))
    if (!core.notes.some((note) => note.id === request.params.id)) {
      response.status(404).json({ error: { code: 'PERSONAL_NOTE_NOT_FOUND', message: '메모를 찾을 수 없습니다.' } })
      return
    }
    const result = await persist(response, () => {
      core.notes = core.notes.filter((note) => note.id !== request.params.id)
      return true
    })
    if (result) response.json({ deleted: true })
  })

  app.post('/api/personal/gaps', requireAuth, requirePersonalCore, async (request, response) => {
    const now = clock()
    const core = personalCoreOf(workspaceStore, owner(request))
    const gap = normalizeGap({ ...request.body, source: 'manual' }, { now })
    if (!gap) { response.status(400).json({ error: { code: 'PERSONAL_GAP_REQUIRED', message: '무엇을 모르는지 한 줄로 적어 주세요.' } }); return }
    const result = await persist(response, () => {
      core.gaps = upsertGap(core.gaps, gap)
      return gap
    })
    if (result) response.status(201).json({ gap: result, core: publicCore(core, now) })
  })

  app.patch('/api/personal/principles/:id', requireAuth, requirePersonalCore, async (request, response) => {
    const now = clock()
    const core = personalCoreOf(workspaceStore, owner(request))
    const principle = core.principles.find((item) => item.id === request.params.id)
    if (!principle) { response.status(404).json({ error: { code: 'PRINCIPLE_NOT_FOUND', message: '규범 카드를 찾을 수 없습니다.' } }); return }
    const action = String(request.body?.action ?? '')
    if (!['retire', 'renew'].includes(action)) {
      response.status(400).json({ error: { code: 'INVALID_PRINCIPLE_ACTION', message: '폐기(retire) 또는 재확정(renew)만 할 수 있습니다.' } })
      return
    }
    const result = await persist(response, () => {
      core.principles = core.principles.map((item) => {
        if (item.id !== principle.id) return item
        // 폐기해도 카드를 지우지 않는다. 이력은 남기고 비활성으로만 바꾼다.
        if (action === 'retire') return { ...item, status: 'retired', retiredAt: now.toISOString() }
        return {
          ...item,
          status: 'active',
          retiredAt: '',
          confirmedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 180 * 24 * 60 * 60 * 1_000).toISOString(),
        }
      })
      return core.principles.find((item) => item.id === principle.id)
    })
    if (result) response.json({ principle: { ...result, state: principleStatus(result, now) }, core: publicCore(core, now) })
  })
}

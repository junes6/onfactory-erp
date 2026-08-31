import { opportunitySummary, rankOpportunities } from './opportunity-relevance.mjs'
import { SUPPORT_PROGRAM_SOURCES } from './support-program-service.mjs'

const seoulDateKey = (now = new Date()) => new Date(now.getTime() + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10)

export function registerSupportProgramRoutes({ app, requireAuth, requireMatchingWorkspaceIdentity, service, profileFor = () => ({}) }) {
  app.get('/api/support-programs', requireAuth, requireMatchingWorkspaceIdentity, async (request, response) => {
    if (!request.auth?.tenantId) {
      response.status(403).json({ error: { code: 'TENANT_REQUIRED', message: '고객사 워크스페이스에서만 사용할 수 있습니다.' } })
      return
    }
    const source = String(request.query?.source ?? 'all')
    const known = Array.isArray(service.sources) ? service.sources : SUPPORT_PROGRAM_SOURCES
    if (source !== 'all' && !known.includes(source)) {
      response.status(400).json({ error: { code: 'SUPPORT_PROGRAM_SOURCE_INVALID', message: '지원하지 않는 공고 출처입니다.' } })
      return
    }
    const sort = String(request.query?.sort ?? 'recommended')
    if (!['recommended', 'deadline'].includes(sort)) {
      response.status(400).json({ error: { code: 'SUPPORT_PROGRAM_SORT_INVALID', message: '정렬 기준은 recommended 또는 deadline입니다.' } })
      return
    }
    const limit = Math.min(30, Math.max(1, Number.parseInt(String(request.query?.limit ?? '4'), 10) || 4))
    try {
      // 관련성은 자르기 전에 매긴다. 마감순 상위 N건만 채점하면 아래에 묻힌 적합 공고를 놓친다.
      const result = await service.list({ source, limit: Math.max(limit, 30) })
      const profile = profileFor(request.auth.tenantId) ?? {}
      const ranked = rankOpportunities(result.items, { profile, sort, todayKey: seoulDateKey() })
      response.set('Cache-Control', 'private, max-age=300')
      response.json({
        ...result,
        items: ranked.slice(0, limit),
        summary: opportunitySummary(ranked),
        sort,
        // 어떤 조건으로 순위를 매겼는지 화면이 그대로 보여 줄 수 있어야 한다.
        profile: { keywords: profile.keywords ?? [], regions: profile.regions ?? [], minAmount: profile.minAmount ?? 0 },
      })
    } catch {
      response.status(503).json({ error: { code: 'SUPPORT_PROGRAM_UNAVAILABLE', message: '지원사업 공고를 불러오지 못했습니다.' } })
    }
  })
}

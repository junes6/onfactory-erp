export function registerSupportProgramRoutes({ app, requireAuth, requireMatchingWorkspaceIdentity, service }) {
  app.get('/api/support-programs', requireAuth, requireMatchingWorkspaceIdentity, async (request, response) => {
    if (!request.auth?.tenantId) {
      response.status(403).json({ error: { code: 'TENANT_REQUIRED', message: '고객사 워크스페이스에서만 사용할 수 있습니다.' } })
      return
    }
    const source = String(request.query?.source ?? 'all')
    if (!['all', 'kstartup', 'bizinfo'].includes(source)) {
      response.status(400).json({ error: { code: 'SUPPORT_PROGRAM_SOURCE_INVALID', message: '지원하지 않는 공고 출처입니다.' } })
      return
    }
    const limit = Math.min(12, Math.max(1, Number.parseInt(String(request.query?.limit ?? '4'), 10) || 4))
    try {
      const result = await service.list({ source, limit })
      response.set('Cache-Control', 'private, max-age=300')
      response.json(result)
    } catch {
      response.status(503).json({ error: { code: 'SUPPORT_PROGRAM_UNAVAILABLE', message: '지원사업 공고를 불러오지 못했습니다.' } })
    }
  })
}

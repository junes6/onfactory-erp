import { BillingServiceError } from './billing-service.mjs'

function billingRoute(handler) {
  return async (request, response) => {
    try { await handler(request, response) }
    catch (error) {
      if (error instanceof BillingServiceError) {
        response.status(error.status).json({ error: { code: error.code, message: error.message, details: error.details } })
        return
      }
      console.error('[billing] route failed', { message: error?.message })
      response.status(500).json({ error: { code: 'BILLING_INTERNAL_ERROR', message: '비용·포인트 데이터를 처리하지 못했습니다.' } })
    }
  }
}

/**
 * Registers browser-facing billing routes. Usage reservations/events remain
 * direct server-to-service calls and must never be registered as public routes.
 */
export function registerBillingRoutes(app, {
  service,
  requireAuth,
  requirePlatformOperator,
  requireMatchingWorkspaceIdentity,
  listPlatformTenantIds = async () => [],
} = {}) {
  if (!app || !service || typeof requireAuth !== 'function' || typeof requirePlatformOperator !== 'function') {
    throw new TypeError('billing routes require app, service and auth middleware')
  }
  const tenantIdentity = typeof requireMatchingWorkspaceIdentity === 'function' ? requireMatchingWorkspaceIdentity : (_request, _response, next) => next()

  app.get('/api/billing/dashboard', requireAuth, tenantIdentity, billingRoute(async (request, response) => {
    const tenantId = String(request.query?.tenantId ?? '').trim() || undefined
    const month = String(request.query?.month ?? '').trim() || undefined
    const tenantIds = request.auth?.role === 'platform-operator' && !tenantId ? await listPlatformTenantIds(request) : undefined
    response.json(await service.getDashboard(request.auth, { month, tenantId, tenantIds }))
  }))

  app.get('/api/billing/configuration', requireAuth, requirePlatformOperator, billingRoute(async (request, response) => {
    response.json(await service.getConfiguration(request.auth))
  }))

  app.put('/api/billing/model-rates/:model', requireAuth, requirePlatformOperator, billingRoute(async (request, response) => {
    response.json(await service.upsertModelRate(request.auth, { ...request.body, model: request.params.model }))
  }))

  app.put('/api/billing/plans/:id', requireAuth, requirePlatformOperator, billingRoute(async (request, response) => {
    response.json(await service.upsertPlan(request.auth, { ...request.body, id: request.params.id }))
  }))

  app.put('/api/billing/tenant-assignments/:tenantId', requireAuth, requirePlatformOperator, billingRoute(async (request, response) => {
    response.json(await service.assignPlan(request.auth, { ...request.body, tenantId: request.params.tenantId }))
  }))

  app.post('/api/billing/monthly-snapshots', requireAuth, requirePlatformOperator, billingRoute(async (request, response) => {
    response.status(201).json(await service.createMonthlySnapshot(request.auth, request.body))
  }))
}

export default registerBillingRoutes


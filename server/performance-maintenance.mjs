import { materializePreviousMonthPerformance } from './performance-routes.mjs'

function tenantList(values) {
  return [...new Set(Array.from(values ?? []).map((value) => String(value ?? '').trim()).filter(Boolean))]
}

export async function runPerformanceMonthlyMaintenance({
  workspaceStore,
  accounts,
  tenantIds,
  commitWorkspaceStore,
  materialize = materializePreviousMonthPerformance,
  ...options
}) {
  const results = []
  for (const tenantId of tenantList(tenantIds)) {
    try {
      const result = await materialize({
        ...options,
        workspaceStore,
        accounts,
        tenantId,
        commitWorkspaceStore,
      })
      results.push({ tenantId, ...result })
    } catch (error) {
      results.push({ tenantId, created: false, error })
    }
  }
  return results
}

export function performanceMaintenanceErrors(results) {
  return (results ?? []).filter((result) => result?.error).map((result) => {
    const error = result.error instanceof Error ? result.error : new Error(String(result.error))
    return Object.assign(error, { tenantId: result.tenantId })
  })
}

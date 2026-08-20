import assert from 'node:assert/strict'
import test from 'node:test'

import { performanceMaintenanceErrors, runPerformanceMonthlyMaintenance } from './performance-maintenance.mjs'

test('monthly performance maintenance isolates tenant failures and de-duplicates tenant ids', async () => {
  const calls = []
  const marker = new Error('tenant unavailable')
  const results = await runPerformanceMonthlyMaintenance({
    workspaceStore: { tenants: {} },
    accounts: [],
    tenantIds: ['TENANT-A', 'TENANT-A', '', 'TENANT-B'],
    commitWorkspaceStore: async () => {},
    clock: () => new Date('2026-08-21T00:00:00.000Z'),
    materialize: async ({ tenantId, clock }) => {
      calls.push([tenantId, clock().toISOString()])
      if (tenantId === 'TENANT-A') throw marker
      return { created: true, snapshot: { id: 'PERFS-B' } }
    },
  })

  assert.deepEqual(calls, [
    ['TENANT-A', '2026-08-21T00:00:00.000Z'],
    ['TENANT-B', '2026-08-21T00:00:00.000Z'],
  ])
  assert.equal(results[0].error, marker)
  assert.equal(results[1].created, true)
  assert.equal(performanceMaintenanceErrors(results)[0].tenantId, 'TENANT-A')
})

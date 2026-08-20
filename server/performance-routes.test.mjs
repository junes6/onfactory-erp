import assert from 'node:assert/strict'
import test from 'node:test'

import express from 'express'

import { registerPerformanceRoutes } from './performance-routes.mjs'
import { withServer } from './test-server.mjs'

const tenantId = 'TENANT-PERFORMANCE'
const admin = { id: 'ADMIN-1', name: '관리자', tenantId, role: 'tenant-admin' }
const member = { id: 'MEMBER-1', name: '직원', tenantId, role: 'tenant-member' }
const platform = { id: 'PLATFORM-1', name: '플랫폼 운영자', tenantId: null, role: 'platform-operator' }

function fixture() {
  const workspaceStore = {
    version: 2,
    tenants: {
      [tenantId]: {
        'work-items': { data: [{
          id: 'WORK-JULY', title: '7월 품질 점검', description: '점검 완료', owner: member.name, ownerId: member.id,
          requestedBy: admin.name, requesterId: admin.id, status: '결재완료', priority: '보통', category: '품질',
          due: '2026-07-15T09:00:00.000Z', createdAt: '2026-07-10T01:00:00.000Z',
          completion: { submittedAt: '2026-07-15T08:00:00.000Z' },
          review: { decision: 'approved', reviewedAt: '2026-07-15T08:30:00.000Z' },
          reviewHistory: [{ decision: 'changes-requested', reviewedAt: '2026-07-14T08:00:00.000Z' }],
        }] },
        'daily-journals': { data: [{ id: 'JR-JULY', authorId: member.id, status: '승인', submittedAt: '2026-07-15T08:00:00.000Z' }] },
      },
    },
  }
  const accounts = [
    { ...admin, approved: true, team: '경영지원', jobRole: '대표' },
    { ...member, approved: true, team: '품질', jobRole: '담당자' },
  ]
  return { workspaceStore, accounts }
}

function testApp(state, overrides = {}) {
  const app = express()
  app.use(express.json())
  const requireAuth = (request, response, next) => {
    request.auth = request.get('x-test-role') === 'member' ? member : request.get('x-test-role') === 'platform' ? platform : admin
    next()
  }
  const requireTenantAdmin = (request, response, next) => {
    if (request.auth?.role !== 'tenant-admin') { response.status(403).json({ error: { code: 'FORBIDDEN' } }); return }
    next()
  }
  registerPerformanceRoutes({
    app, requireAuth, requireTenantAdmin, requireMatchingWorkspaceIdentity: (_request, _response, next) => next(),
    workspaceStore: state.workspaceStore, accounts: state.accounts,
    commitWorkspaceStore: async () => { state.commits += 1 },
    clock: () => new Date('2026-08-21T03:00:00.000Z'),
    ...overrides,
  })
  return app
}

test('performance routes isolate admin reports, preserve closed revisions, and gate employee self visibility', async () => {
  const state = { ...fixture(), commits: 0 }
  await withServer(testApp(state), async (origin) => {
    const forbidden = await fetch(`${origin}/api/performance/reports?periodType=month&anchor=2026-07-15`, { headers: { 'x-test-role': 'member' } })
    assert.equal(forbidden.status, 403)
    const memberGenerate = await fetch(`${origin}/api/performance/reports/generate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-role': 'member' }, body: JSON.stringify({ periodType: 'month', anchor: '2026-07-15' }) })
    assert.equal(memberGenerate.status, 403)
    const memberSettings = await fetch(`${origin}/api/performance/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-test-role': 'member' }, body: '{}' })
    assert.equal(memberSettings.status, 403)
    const platformReports = await fetch(`${origin}/api/performance/reports?periodType=month&anchor=2026-07-15`, { headers: { 'x-test-role': 'platform' } })
    assert.equal(platformReports.status, 403)
    const platformSelf = await fetch(`${origin}/api/performance/me?periodType=month&anchor=2026-07-15`, { headers: { 'x-test-role': 'platform' } })
    assert.equal(platformSelf.status, 403)

    const first = await fetch(`${origin}/api/performance/reports?periodType=month&anchor=2026-07-15`)
    assert.equal(first.status, 200)
    const firstBody = await first.json()
    assert.equal(firstBody.reports.length, 2)
    assert.equal(firstBody.reports.find((report) => report.employeeId === member.id).metrics.completedTasks, 1)
    assert.equal(firstBody.reports.find((report) => report.employeeId === member.id).metrics.revisionRate, 100)
    assert.equal(state.workspaceStore.tenants[tenantId]['performance-reports'].data.length, 1)
    assert.equal(state.workspaceStore.tenants[tenantId]['performance-reports'].data[0].immutable, true)

    const hidden = await fetch(`${origin}/api/performance/me?periodType=month&anchor=2026-07-15`, { headers: { 'x-test-role': 'member' } })
    assert.equal(hidden.status, 403)

    const settings = await fetch(`${origin}/api/performance/settings`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        employeeVisible: true,
        weights: { completedTasks: 20, dueCompliance: 25, revisionRate: 15, averageCycleHours: 15, journalSubmission: 15, approvalResponseHours: 10 },
      }),
    })
    assert.equal(settings.status, 200)
    const visible = await fetch(`${origin}/api/performance/me?periodType=month&anchor=2026-07-15`, { headers: { 'x-test-role': 'member' } })
    assert.equal(visible.status, 200)
    const visibleBody = await visible.json()
    assert.deepEqual(visibleBody.reports.map((report) => report.employeeId), [member.id])
    assert.equal(visibleBody.visibility, 'public')
    assert.equal(visibleBody.settings, undefined)

    const regenerate = await fetch(`${origin}/api/performance/reports/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ periodType: 'month', anchor: '2026-07-15' }),
    })
    assert.equal(regenerate.status, 201)
    const snapshots = state.workspaceStore.tenants[tenantId]['performance-reports'].data
    assert.equal(snapshots.length, 2)
    assert.deepEqual(snapshots.map((snapshot) => snapshot.revision), [1, 2])
    assert.equal(snapshots[0].immutable, true)
    assert.ok(state.commits >= 3)
  })
})

test('performance AI preserves the generated narrative and queues reconciliation after ledger failure', async () => {
  const state = { ...fixture(), commits: 0 }
  const calls = { pending: [], released: [], provider: 0 }
  const client = {
    messages: {
      create: async () => {
        calls.provider += 1
        return {
          id: `performance-provider-${calls.provider}`,
          model: 'claude-test',
          content: [{ type: 'text', text: JSON.stringify(['AI 요약', 'AI 강점', 'AI 개선', 'AI 제안']) }],
          usage: { input_tokens: 20, output_tokens: 10 },
        }
      },
    },
  }
  const billingService = {
    reserveUsage: async (_actor, input) => ({ reservation: { ...input, status: 'pending' } }),
    recordUsageEvent: async () => { throw new Error('ledger temporarily unavailable') },
    recordReconciliationPending: async (_actor, input) => { calls.pending.push(input); return { reconciliation: { ...input, status: 'pending' } } },
    releaseUsageReservation: async (_actor, input) => { calls.released.push(input) },
  }
  await withServer(testApp(state, { client, model: 'claude-test', billingService }), async (origin) => {
    const response = await fetch(`${origin}/api/performance/reports/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ periodType: 'month', anchor: '2026-07-15' }),
    })
    const body = await response.json()
    assert.equal(response.status, 201)
    assert.equal(body.reports.length, 2)
    assert.equal(body.reports.every((report) => report.narrative.mode === 'ai' && report.narrative.strengths[0] === 'AI 요약'), true)
    assert.equal(calls.provider, 2)
    assert.equal(calls.pending.length, 2)
    assert.equal(calls.released.length, 0)
  })
})

test('performance generation skips AI and returns N/A when every employee lacks factual evidence', async () => {
  const source = fixture()
  source.workspaceStore.tenants[tenantId]['work-items'].data = []
  source.workspaceStore.tenants[tenantId]['daily-journals'].data = []
  const state = { ...source, commits: 0 }
  let providerCalls = 0
  const client = { messages: { create: async () => { providerCalls += 1; throw new Error('provider must not be called without evidence') } } }

  await withServer(testApp(state, { client, model: 'claude-test' }), async (origin) => {
    const response = await fetch(`${origin}/api/performance/reports/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ periodType: 'month', anchor: '2026-07-15' }),
    })
    const body = await response.json()
    assert.equal(response.status, 201)
    assert.equal(providerCalls, 0)
    assert.equal(body.reports.every((report) => report.score === null), true)
    assert.equal(body.reports.every((report) => report.narrative.mode === 'rule-based' && report.narrative.evidence.length === 0), true)
    assert.equal(body.reports.every((report) => report.narrative.strengths.join(' ').includes('근거')), true)
  })
})

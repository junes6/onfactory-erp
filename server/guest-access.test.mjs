import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createApp } from './app.mjs'
import { GUEST_ROUTE_ALLOWLIST, isGuestRouteAllowed, isGuestWorkItem, guestWorkItemViolation, maskEmail } from './guest-access.mjs'
import { withServer } from './test-server.mjs'

/**
 * 외부 게스트 격리 — 판정 1("초대된 프로젝트 밖은 존재조차 보이지 않는다")을 증명하는 시험.
 *
 * 픽스처는 초대 라우트를 거치지 않고 store에 grant·계정·승인·비밀번호를 직접 심는다.
 * 그래야 "저장된 것을 부트가 어떻게 되살리는가"(role 보존)가 함께 검증된다.
 */

const TENANT = 'TENANT-SUNSEA'
const ADMIN = { id: 'USR-SUNSEA-ADMIN', name: '김서원', email: 'admin@sunsea.co.kr' }
const PARK = { id: 'USR-SUNSEA-PARK', name: '박지현', email: 'jihyun.park@sunsea.co.kr' }
const OH = { id: 'USR-SUNSEA-OH', name: '오태식', email: 'taesik.oh@sunsea.co.kr' }
const GUEST = { id: 'USR-TENANT-SUNSEA-GUEST01', name: '홍거래', email: 'guest@partner.example', password: 'Guest!Pass2026' }
const GRANT_ID = 'GST-TENANT-SUNSEA-000001'
const ORG = '파트너상사'
// 게스트에게 절대 보이면 안 되는 문자열 — 범위 밖 직원·프로젝트 이름.
const FORBIDDEN_STRINGS = ['오태식', '회사공개 프로젝트', '비공개 프로젝트 C', 'taesik.oh']
const GUEST_FORBIDDEN_BODY = { error: { code: 'GUEST_SCOPE_FORBIDDEN', message: '초대된 프로젝트 안에서만 사용할 수 있습니다.' } }

// app.mjs의 passwordDigest와 같은 계산. 시험이 서버 내부 함수를 import하지 않고도 로그인 가능한 해시를 심을 수 있어야 한다.
const digestHex = (password, accountId) => scryptSync(String(password), `onfactory:${accountId}`, 32).toString('hex')

const workItem = (overrides) => ({
  id: 'WK-X', title: '업무', description: '', owner: GUEST.name, ownerId: GUEST.id, requestedBy: ADMIN.name, requesterId: ADMIN.id,
  due: '2026-12-31', priority: '보통', status: '업무요청', category: '일반', createdAt: '2026-09-01T00:00:00.000Z', ...overrides,
})
const room = (overrides) => ({ type: 'team', kind: 'group', name: '방', subtitle: '', unread: 0, lastMessage: '', lastTime: '', messages: [], ...overrides })

function seedStore({ grantOverrides = {}, approvals = 'approved' } = {}) {
  return {
    version: 2,
    tenants: {
      [TENANT]: {
        'project-spaces': { data: [
          { id: 'PRJ-A', name: '파트너 협업 A', description: '', visibility: 'members', status: 'active', stage: '진행 중', client: '파트너상사', amount: 12_000_000, ownerId: ADMIN.id, ownerName: ADMIN.name,
            members: [{ id: ADMIN.id, name: ADMIN.name, role: 'owner' }, { id: PARK.id, name: PARK.name, team: '품질관리', role: 'editor' }, { id: GUEST.id, name: GUEST.name, team: ORG, role: 'viewer', kind: 'guest' }], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
          { id: 'PRJ-B', name: '회사공개 프로젝트', description: '', visibility: 'company', status: 'active', stage: '준비', client: '', amount: 0, ownerId: ADMIN.id, ownerName: ADMIN.name,
            members: [{ id: ADMIN.id, name: ADMIN.name, role: 'owner' }], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
          { id: 'PRJ-C', name: '비공개 프로젝트 C', description: '', visibility: 'members', status: 'active', stage: '준비', client: '', amount: 0, ownerId: ADMIN.id, ownerName: ADMIN.name,
            members: [{ id: ADMIN.id, name: ADMIN.name, role: 'owner' }, { id: OH.id, name: OH.name, team: '생산 1팀', role: 'editor' }], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
        ], updatedAt: '2026-09-01T00:00:00.000Z' },
        'project-posts': { data: [
          { id: 'PP-A1', projectId: 'PRJ-A', title: 'A 킥오프', body: '일정 공유', attachments: [{ id: 'DOC-A-ATT', name: 'A 도면.pdf', size: '1 KB' }], authorId: ADMIN.id, author: ADMIN.name, pinned: false, comments: [{ id: 'PC-ADMIN', authorId: ADMIN.id, author: ADMIN.name, text: '관리자 댓글', attachments: [], createdAt: '2026-09-01T00:00:00.000Z' }], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
          // C의 기존 게시글 첨부 — 게스트가 초대되기 전에 올라간 자료. 초대·범위 변경 뒤 열려야 한다.
          { id: 'PP-C1', projectId: 'PRJ-C', title: 'C 사양 공유', body: '사양서 첨부', attachments: [{ id: 'DOC-C-ATT', name: 'C 사양서.pdf', size: '1 KB' }], authorId: ADMIN.id, author: ADMIN.name, pinned: false, comments: [], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
        ], updatedAt: '2026-09-01T00:00:00.000Z' },
        'work-items': { data: [
          workItem({ id: 'WK-W1', title: 'W1 도면 검토', projectId: 'PRJ-A' }),
          workItem({ id: 'WK-W2', title: 'W2 내부 검수', projectId: 'PRJ-A', owner: PARK.name, ownerId: PARK.id }),
          workItem({ id: 'WK-W3', title: 'W3 프로젝트 없는 업무' }),
        ], updatedAt: '2026-09-01T00:00:00.000Z' },
        'messenger-conversations': { data: [
          room({ id: 'grp-R1', name: 'A 프로젝트 채널', projectId: 'PRJ-A', participantIds: [ADMIN.id, PARK.id, GUEST.id], ownerId: ADMIN.id }),
          room({ id: 'grp-R2', name: 'C 프로젝트 채널', projectId: 'PRJ-C', participantIds: [ADMIN.id, OH.id], ownerId: ADMIN.id }),
          room({ id: 'team-ops', kind: undefined, name: '운영', messages: [{ id: 'm-ops-1', senderId: OH.id, senderName: OH.name, text: '전사 공지: 오태식 작성', time: '09:00', createdAt: '2026-09-01T00:00:00.000Z', readBy: [] }] }),
          room({ id: 'dm-D1', type: 'direct', kind: undefined, name: PARK.name, participantIds: [PARK.id, GUEST.id] }),
        ], updatedAt: '2026-09-01T00:00:00.000Z' },
        'company-documents': { data: [
          { id: 'DOC-ALL', tenantId: TENANT, name: '전사 공지문.pdf', originalName: '전사 공지문.pdf', mime: 'application/pdf', size: 10, category: '공통자료', visibility: 'all', departments: [], allowedUserIds: [], tags: [], uploadedAt: '2026-09-01T00:00:00.000Z', uploadedById: ADMIN.id, uploadedByName: ADMIN.name },
          { id: 'DOC-R', tenantId: TENANT, name: '프로젝트 사양서.pdf', originalName: '프로젝트 사양서.pdf', mime: 'application/pdf', size: 10, category: '프로젝트', visibility: 'restricted', departments: [], allowedUserIds: [GUEST.id, ADMIN.id], tags: [], uploadedAt: '2026-09-01T00:00:00.000Z', uploadedById: ADMIN.id, uploadedByName: ADMIN.name },
          // A 게시글 첨부(게스트에게 열려 있음)와 C 게시글 첨부(아직 멤버에게만).
          { id: 'DOC-A-ATT', tenantId: TENANT, name: 'A 도면.pdf', originalName: 'A 도면.pdf', mime: 'application/pdf', size: 10, category: '프로젝트', visibility: 'restricted', departments: [], allowedUserIds: [GUEST.id, ADMIN.id, PARK.id], projectId: 'PRJ-A', tags: [], uploadedAt: '2026-09-01T00:00:00.000Z', uploadedById: ADMIN.id, uploadedByName: ADMIN.name },
          { id: 'DOC-C-ATT', tenantId: TENANT, name: 'C 사양서.pdf', originalName: 'C 사양서.pdf', mime: 'application/pdf', size: 10, category: '프로젝트', visibility: 'restricted', departments: [], allowedUserIds: [ADMIN.id, OH.id], projectId: 'PRJ-C', tags: [], uploadedAt: '2026-09-01T00:00:00.000Z', uploadedById: ADMIN.id, uploadedByName: ADMIN.name },
        ], updatedAt: '2026-09-01T00:00:00.000Z' },
      },
      'TENANT-POHANG': {},
    },
    platform: {},
    accountApprovals: { [GUEST.id]: approvals },
    accountCredentials: { [GUEST.id]: { passwordHash: digestHex(GUEST.password, GUEST.id), mustChangePassword: false, temporaryPasswordExpiresAt: null } },
    invitedAccounts: [{ id: GUEST.id, email: GUEST.email, name: GUEST.name, tenantId: TENANT, tenantName: '햇살바다', team: ORG, jobRole: '외부 게스트', requested: '게스트 초대', role: 'tenant-guest', guestGrantId: GRANT_ID }],
    passwordResetRequests: [],
    guestGrants: [{
      id: GRANT_ID, tenantId: TENANT, accountId: GUEST.id, email: GUEST.email, name: GUEST.name, orgName: ORG, projectIds: ['PRJ-A'],
      invitedById: ADMIN.id, invitedByName: ADMIN.name, status: 'active', tokenHash: null, tokenIssuedAt: null, tokenExpiresAt: null,
      resendCount: 0, lastResentAt: null, accessExpiresAt: null, acceptedAt: '2026-09-01T00:00:00.000Z', revokedAt: null, revokedById: null, deactivatedAt: null,
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', ...grantOverrides,
    }],
  }
}

const uploadDir = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onfactory-guest-')), 'documents')
const buildApp = (store, extra = {}) => createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {}, documentUploadDirectory: uploadDir(), ...extra })
const readJson = async (response) => { const text = await response.text(); try { return JSON.parse(text) } catch { return { raw: text } } }

async function login(origin, email, password = 'demo1234') {
  const response = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: 'tenant', email, password }) })
  const body = await readJson(response)
  const cookie = response.headers.get('set-cookie') ?? ''
  const account = body.account ?? null
  return {
    response, body, cookie, account,
    headers: { 'content-type': 'application/json', cookie, ...(account ? { 'x-workspace-identity': `${account.tenantId}:${account.id}` } : {}) },
  }
}
const api = (origin, session) => async (method, route, body) => {
  const response = await fetch(`${origin}${route}`, { method, headers: session.headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return { status: response.status, body: await readJson(response), response }
}
const assertNoLeak = (payload, where) => {
  const text = JSON.stringify(payload)
  for (const needle of FORBIDDEN_STRINGS) assert.ok(!text.includes(needle), `${where}: 응답에 '${needle}'가 새었다 — ${text.slice(0, 300)}`)
}
const auditEvents = (store) => store.platform.auditEvents ?? []

// ─────────────────────────── 순수 함수 ───────────────────────────

test('allowlist는 메서드+경로 정규식으로 판정하고, 밖은 전부 거부다', () => {
  assert.equal(isGuestRouteAllowed('GET', '/api/projects'), true)
  assert.equal(isGuestRouteAllowed('POST', '/api/projects'), false, '프로젝트 생성은 게스트에게 없다')
  assert.equal(isGuestRouteAllowed('GET', '/api/workspace/work-items'), true)
  assert.equal(isGuestRouteAllowed('GET', '/api/workspace/product-catalog'), false)
  assert.equal(isGuestRouteAllowed('PUT', '/api/workspace/work-items'), false)
  assert.equal(isGuestRouteAllowed('GET', '/api/directory'), false)
  assert.equal(isGuestRouteAllowed('POST', '/api/messenger/conversations/direct'), false)
  assert.equal(isGuestRouteAllowed('POST', '/api/messenger/conversations/grp-1/messages'), true)
  assert.ok(GUEST_ROUTE_ALLOWLIST.every(([method, pattern]) => typeof method === 'string' && pattern instanceof RegExp))
})

test('게스트 업무 판정과 관리자 저장 제약은 프로젝트 귀속을 본다', () => {
  const auth = { id: 'G', role: 'tenant-guest', guestScope: { projectIds: ['PRJ-A'] } }
  assert.equal(isGuestWorkItem({ projectId: 'PRJ-A', ownerId: 'G' }, auth), true)
  assert.equal(isGuestWorkItem({ projectId: 'PRJ-A', ownerId: 'E' }, auth), false, '남의 업무는 아니다')
  assert.equal(isGuestWorkItem({ ownerId: 'G' }, auth), false, '프로젝트 없는 업무는 보이지 않는다')
  assert.equal(isGuestWorkItem({ projectId: 'PRJ-A', requesterId: 'G', ownerId: 'E' }, auth), false, '요청자인 업무도 보이지 않는다')
  const accounts = [{ id: 'G', role: 'tenant-guest' }, { id: 'E', role: 'tenant-member' }]
  const grantOf = () => ({ projectIds: ['PRJ-A'] })
  assert.equal(guestWorkItemViolation([{ ownerId: 'E', requesterId: 'G' }], accounts, grantOf)?.code, 'GUEST_CANNOT_REQUEST')
  assert.equal(guestWorkItemViolation([{ ownerId: 'G', requesterId: 'E' }], accounts, grantOf)?.code, 'GUEST_PROJECT_REQUIRED')
  assert.equal(guestWorkItemViolation([{ ownerId: 'G', requesterId: 'E', projectId: 'PRJ-B' }], accounts, grantOf)?.code, 'GUEST_PROJECT_REQUIRED')
  assert.equal(guestWorkItemViolation([{ ownerId: 'G', requesterId: 'E', projectId: 'PRJ-A' }], accounts, grantOf), null)
  assert.equal(maskEmail('guest@partner.example'), 'gu***@partner.example')
})

// ─────────────────────────── #5 #6 #7 #9 #10 #11 판정 1 ───────────────────────────

test('#5/#6/#18 게스트 로그인: role·guestScope가 내려오고, 재기동 후에도 직원으로 승격되지 않는다', async () => {
  const store = seedStore()
  const check = async (origin) => {
    const guest = await login(origin, GUEST.email, GUEST.password)
    assert.equal(guest.response.status, 200, JSON.stringify(guest.body))
    assert.equal(guest.account.role, 'tenant-guest')
    assert.equal(guest.account.requiresPasswordChange, false)
    assert.deepEqual(guest.account.guestScope.projectIds, ['PRJ-A'])
    assert.equal(guest.account.guestScope.grantId, GRANT_ID)
    assert.equal(guest.account.guestScope.orgName, ORG)
    const call = api(origin, guest)
    const projects = await call('GET', '/api/projects')
    assert.equal(projects.status, 200)
    assert.deepEqual(projects.body.projects.map((project) => project.id), ['PRJ-A'], 'B(company)·C(미참여)는 목록에 없다')
    assert.equal('amount' in projects.body.projects[0], false, '계약 금액은 외부인에게 내려가지 않는다')
    assert.equal('client' in projects.body.projects[0], false)
    assert.equal(projects.body.projects[0].role, 'viewer')
    const memberIds = new Set([ADMIN.id, PARK.id, GUEST.id])
    assert.ok(projects.body.directory.length > 0)
    assert.ok(projects.body.directory.every((entry) => memberIds.has(entry.id)), 'directory는 보이는 프로젝트 멤버로만')
    assert.equal(projects.body.directory.find((entry) => entry.id === GUEST.id)?.kind, 'guest')
    assert.deepEqual(projects.body.directory.find((entry) => entry.id === GUEST.id)?.projectIds, ['PRJ-A'], '게스트 항목에는 초대 범위가 실린다')
    assertNoLeak(projects.body, 'GET /api/projects')
  }
  await withServer(buildApp(store), check)
  // 같은 store로 다시 조립해도(재기동) invitedAccounts.role이 그대로 살아야 한다.
  await withServer(buildApp(store), check)
})

test('#7 존재 비노출: 범위 밖 프로젝트는 직원의 "없는 프로젝트"와 같은 404, 명단·검색·AI는 403 한 가지 코드', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const guest = await login(origin, GUEST.email, GUEST.password)
    const park = await login(origin, PARK.email)
    const g = api(origin, guest)
    const p = api(origin, park)
    const missing = await p('GET', '/api/projects/PRJ-NOPE')
    assert.equal(missing.status, 404)
    for (const id of ['PRJ-B', 'PRJ-C']) {
      const hidden = await g('GET', `/api/projects/${id}`)
      assert.equal(hidden.status, 404)
      assert.deepEqual(hidden.body, missing.body, '없는 프로젝트와 못 보는 프로젝트의 응답이 같아야 존재가 새지 않는다')
    }
    for (const [method, route, body] of [
      ['GET', '/api/directory'], ['GET', '/api/leave-approvers'], ['GET', '/api/admin/accounts'],
      ['GET', `/api/search?q=${encodeURIComponent('오태식')}`], ['GET', '/api/activity'], ['POST', '/api/chat', { messages: [{ role: 'user', content: '직원 목록' }] }],
      ['GET', '/api/workspace/product-catalog'], ['GET', '/api/workspace/project-spaces'], ['PUT', '/api/workspace/work-items', { data: [] }],
      ['POST', '/api/messenger/conversations/direct', { participantId: OH.id }], ['PATCH', '/api/projects/PRJ-A', { name: '바꿈' }],
      ['POST', '/api/projects/PRJ-A/posts', { title: '글', body: '본문' }],
    ]) {
      const result = await g(method, route, body)
      assert.equal(result.status, 403, `${method} ${route} → ${result.status} ${JSON.stringify(result.body)}`)
      assert.deepEqual(result.body, GUEST_FORBIDDEN_BODY, `${method} ${route} 응답 본문은 고정 문구 하나`)
    }
  })
})

test('#8 라우트 전수 스윕: /api/* 전부를 게스트로 호출하면 allowlist 밖은 전부 GUEST_SCOPE_FORBIDDEN, 어디에도 범위 밖 이름이 새지 않는다', async () => {
  const app = buildApp(seedStore())
  const collect = (stack, into) => {
    for (const layer of stack ?? []) {
      if (layer.route) {
        for (const routePath of [].concat(layer.route.path)) {
          for (const method of Object.keys(layer.route.methods)) into.push({ method: method.toUpperCase(), path: routePath })
        }
      }
      if (layer.handle?.stack) collect(layer.handle.stack, into)
    }
  }
  const routes = []
  collect(app.router.stack, routes)
  const apiRoutes = routes.filter((route) => typeof route.path === 'string' && route.path.startsWith('/api'))
  assert.ok(apiRoutes.length > 120, `라우트 열거가 너무 적다: ${apiRoutes.length}`)
  await withServer(app, async (origin) => {
    const guest = await login(origin, GUEST.email, GUEST.password)
    const logout = apiRoutes.filter((route) => route.path === '/api/auth/logout')
    // /api/health는 게이트 앞에 있는 무인증 공개 라우트다. 테넌트 데이터가 없음을 따로 확인한다.
    const health = await readJson(await fetch(`${origin}/api/health`, { headers: guest.headers }))
    assert.deepEqual(Object.keys(health).sort(), ['claude', 'model'])
    const others = apiRoutes.filter((route) => route.path !== '/api/auth/logout' && route.path !== '/api/health')
    let blocked = 0
    let allowed = 0
    for (const route of others) {
      const concrete = route.path.replace(/:[A-Za-z_]+\??/g, 'X')
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 4_000)
      let status; let body
      try {
        const response = await fetch(`${origin}${concrete}`, {
          method: route.method, headers: guest.headers, signal: controller.signal,
          ...(['GET', 'HEAD'].includes(route.method) ? {} : { body: '{}' }),
        })
        status = response.status
        // SSE는 끝나지 않는다. 헤더만 보고 끊는다.
        if (concrete === '/api/events') { controller.abort(); body = {} } else body = await readJson(response)
      } finally { clearTimeout(timer) }
      const label = `${route.method} ${concrete}`
      if (isGuestRouteAllowed(route.method, concrete)) {
        allowed += 1
        assert.notEqual(body?.error?.code, 'GUEST_SCOPE_FORBIDDEN', `${label}는 allowlist인데 게이트에 막혔다`)
        assertNoLeak(body, label)
      } else {
        blocked += 1
        assert.equal(status, 403, `${label} → ${status} ${JSON.stringify(body)}`)
        assert.deepEqual(body, GUEST_FORBIDDEN_BODY, `${label} 본문이 고정 문구가 아니다`)
      }
    }
    assert.ok(blocked > 90, `차단 라우트 수가 이상하다: ${blocked}`)
    assert.ok(allowed >= 20, `허용 라우트 수가 이상하다: ${allowed}`)
    // 세션을 끊는 로그아웃은 맨 마지막에.
    assert.equal(logout.length, 1)
    const out = await fetch(`${origin}/api/auth/logout`, { method: 'POST', headers: guest.headers })
    assert.equal(out.status, 204)
  })
})

test('#9 generic 저장소: 업무는 범위 프로젝트 + 본인 담당만, 다른 키·쓰기는 403', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const guest = await login(origin, GUEST.email, GUEST.password)
    const g = api(origin, guest)
    const items = await g('GET', '/api/workspace/work-items')
    assert.equal(items.status, 200)
    assert.deepEqual(items.body.data.map((item) => item.id), ['WK-W1'], 'W2(직원 담당)·W3(프로젝트 없음)는 없다')
    const memberKeys = ['inventory-locations', 'calendar-events', 'daily-journals', 'leave-requests', 'leave-management', 'factory-locations', 'factory-layouts', 'work-rules', 'product-catalog', 'inventory-movements', 'calendar-departments',
      'compliance-records', 'it-projects', 'it-deliverables', 'it-contracts', 'it-clients', 'it-support-programs', 'company-assets', 'tax-events', 'ip-rights', 'tax-deliveries', 'document-lenses', 'opportunities', 'opportunity-settings', 'project-spaces', 'project-posts', 'sales-channels']
    for (const key of memberKeys) {
      const result = await g('GET', `/api/workspace/${key}`)
      assert.equal(result.status, 403, `${key} → ${result.status}`)
      assert.equal(result.body.error.code, 'GUEST_SCOPE_FORBIDDEN')
    }
    const put = await g('PUT', '/api/workspace/work-items', { data: items.body.data })
    assert.equal(put.status, 403)
  })
})

test('#10 메신저: 참여 중인 프로젝트 채널과 1:1만, team-ops·범위 밖 방은 존재하지 않는다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const guest = await login(origin, GUEST.email, GUEST.password)
    const g = api(origin, guest)
    const rooms = await g('GET', '/api/workspace/messenger-conversations')
    assert.equal(rooms.status, 200)
    assert.deepEqual(rooms.body.data.map((item) => item.id).sort(), ['dm-D1', 'grp-R1'])
    assertNoLeak(rooms.body, 'GET messenger-conversations')
    const outside = await g('POST', '/api/messenger/conversations/grp-R2/messages', { text: '안녕하세요' })
    assert.equal(outside.status, 404)
    assert.equal(outside.body.error.code, 'CONVERSATION_NOT_FOUND')
    const ops = await g('POST', '/api/messenger/conversations/team-ops/messages', { text: '전사방' })
    assert.equal(ops.status, 404)
    const sent = await g('POST', '/api/messenger/conversations/grp-R1/messages', { text: '도면 확인했습니다' })
    assert.equal(sent.status, 201, JSON.stringify(sent.body))
    assert.equal(sent.body.message.senderRole, 'tenant-guest')
    const direct = await g('POST', '/api/messenger/conversations/direct', { participantId: PARK.id })
    assert.equal(direct.status, 403)
    assert.equal(direct.body.error.code, 'GUEST_SCOPE_FORBIDDEN')
  })
})

test('#11 문서: restricted로 본인에게 열린 것만 보이고, 업로드는 항상 restricted + 범위 멤버로 잘린다', async () => {
  const store = seedStore()
  await withServer(buildApp(store), async (origin) => {
    const guest = await login(origin, GUEST.email, GUEST.password)
    const g = api(origin, guest)
    const list = await g('GET', '/api/documents')
    assert.equal(list.status, 200)
    assert.deepEqual(list.body.documents.map((document) => document.id).sort(), ['DOC-A-ATT', 'DOC-R'], 'DOC-ALL·C 첨부는 존재하지 않는다')
    const all = await fetch(`${origin}/api/documents/DOC-ALL/download`, { headers: guest.headers })
    assert.equal(all.status, 404, "visibility 'all' 문서는 게스트에게 없는 문서다")
    const query = new URLSearchParams({ name: '검토의견.pdf', category: '공통자료', visibility: 'all', allowedUserIds: `${PARK.id},${OH.id},USR-OUTSIDE` })
    const upload = await fetch(`${origin}/api/documents?${query}`, {
      method: 'POST', headers: { ...guest.headers, 'content-type': 'application/octet-stream', 'x-file-type': 'application/pdf', 'x-file-name': encodeURIComponent('검토의견.pdf') }, body: Buffer.from('%PDF-1.4 guest'),
    })
    const uploaded = await readJson(upload)
    assert.equal(upload.status, 201, JSON.stringify(uploaded))
    assert.equal(uploaded.document.visibility, 'restricted')
    assert.equal(uploaded.document.category, '프로젝트')
    assert.equal(uploaded.document.uploadedByRole, 'tenant-guest')
    assert.deepEqual([...uploaded.document.allowedUserIds].sort(), [GUEST.id, PARK.id].sort(), '본인 ∪ (A 멤버 ∩ 요청값) — 오태식·외부 id는 빠진다')
    assert.ok(auditEvents(store).some((event) => event.event === '게스트 첨부 업로드' && event.reference === GRANT_ID && event.actor === `게스트 ${GUEST.name}`))
  })
})

test('#12 프로젝트 쓰기: 댓글은 authorRole과 감사가 남고, 글 작성·설정 변경은 닫혀 있고, 남의 댓글은 못 지운다', async () => {
  const store = seedStore()
  await withServer(buildApp(store), async (origin) => {
    const guest = await login(origin, GUEST.email, GUEST.password)
    const g = api(origin, guest)
    const comment = await g('POST', '/api/projects/PRJ-A/posts/PP-A1/comments', { text: '도면 3페이지 치수 확인 부탁드립니다' })
    assert.equal(comment.status, 201, JSON.stringify(comment.body))
    assert.equal(comment.body.comment.authorRole, 'tenant-guest')
    assert.ok(auditEvents(store).some((event) => event.event === '게스트 댓글' && event.reference === GRANT_ID))
    const post = await g('POST', '/api/projects/PRJ-A/posts', { title: '글', body: '본문' })
    assert.equal(post.status, 403)
    assert.equal(post.body.error.code, 'GUEST_SCOPE_FORBIDDEN')
    const patch = await g('PATCH', '/api/projects/PRJ-A', { name: '이름 바꿈' })
    assert.equal(patch.status, 403)
    const foreign = await g('DELETE', '/api/projects/PRJ-A/posts/PP-A1/comments/PC-ADMIN')
    assert.equal(foreign.status, 403)
    assert.equal(foreign.body.error.code, 'COMMENT_DELETE_FORBIDDEN')
    const own = await g('DELETE', `/api/projects/PRJ-A/posts/PP-A1/comments/${comment.body.comment.id}`)
    assert.equal(own.status, 200)
  })
})

test('#13 업무 전이: accept·submit만, approve는 GUEST_REVIEW_FORBIDDEN, 관리자 저장은 게스트 결재자·귀속 없는 배정을 400으로 막는다', async () => {
  const store = seedStore()
  await withServer(buildApp(store), async (origin) => {
    const guest = await login(origin, GUEST.email, GUEST.password)
    const admin = await login(origin, ADMIN.email)
    const g = api(origin, guest)
    const a = api(origin, admin)
    const accept = await g('POST', '/api/work-items/WK-W1/transition', { action: 'accept' })
    assert.equal(accept.status, 200, JSON.stringify(accept.body))
    assert.equal(accept.body.task?.status ?? accept.body.item?.status ?? accept.body.status, '수행중')
    const hidden = await g('POST', '/api/work-items/WK-W3/transition', { action: 'accept' })
    assert.equal(hidden.status, 404, '프로젝트 귀속 없는 업무는 게스트에게 없는 업무다')
    const submit = await g('POST', '/api/work-items/WK-W1/transition', { action: 'submit', completion: { summary: '도면 검토 완료', evidence: [{ id: 'EV-1', name: '검토서.pdf', size: '12 KB', type: 'application/pdf' }] } })
    assert.equal(submit.status, 200, JSON.stringify(submit.body))
    const stored = store.tenants[TENANT]['work-items'].data.find((item) => item.id === 'WK-W1')
    assert.equal(stored.status, '결재대기')
    assert.equal(stored.completion.submittedByRole, 'tenant-guest')
    assert.ok(auditEvents(store).some((event) => event.event === '게스트 완료 보고' && event.reference === GRANT_ID))
    const approve = await g('POST', '/api/work-items/WK-W1/transition', { action: 'approve', review: { comment: '' } })
    assert.equal(approve.status, 403)
    assert.equal(approve.body.error.code, 'GUEST_REVIEW_FORBIDDEN')
    // 관리자가 게스트를 요청자(결재자)로 두는 저장
    const current = store.tenants[TENANT]['work-items'].data
    const [w1, w2] = current
    const badRequester = await a('PUT', '/api/workspace/work-items', { data: [w1, w2, workItem({ id: 'WK-BAD', title: '게스트가 요청', projectId: 'PRJ-A', owner: PARK.name, ownerId: PARK.id, requestedBy: GUEST.name, requesterId: GUEST.id })] })
    assert.equal(badRequester.status, 400)
    assert.equal(badRequester.body.error.code, 'GUEST_CANNOT_REQUEST')
    // 프로젝트 귀속 없이 게스트에게 배정 (시드된 W3가 바로 그 경우)
    const noProject = await a('PUT', '/api/workspace/work-items', { data: current })
    assert.equal(noProject.status, 400)
    assert.equal(noProject.body.error.code, 'GUEST_PROJECT_REQUIRED')
    // 귀속을 채우면 저장된다
    const fixed = await a('PUT', '/api/workspace/work-items', { data: current.map((item) => item.id === 'WK-W3' ? { ...item, projectId: 'PRJ-A' } : item) })
    assert.equal(fixed.status, 200, JSON.stringify(fixed.body))
  })
})

test('#14 멘션: 게스트가 방에 없는 직원을 @로 불러도 알림이 가지 않는다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const guest = await login(origin, GUEST.email, GUEST.password)
    const oh = await login(origin, OH.email)
    const park = await login(origin, PARK.email)
    const g = api(origin, guest)
    const sent = await g('POST', '/api/messenger/conversations/grp-R1/messages', { text: `@${OH.name} @${PARK.name} 확인 부탁드립니다` })
    assert.equal(sent.status, 201)
    const ohInbox = await api(origin, oh)('GET', '/api/notifications')
    assert.equal(ohInbox.body.items.filter((item) => item.type === 'mention').length, 0, '비참여 직원에게는 멘션 알림이 없다')
    const parkInbox = await api(origin, park)('GET', '/api/notifications')
    assert.equal(parkInbox.body.items.filter((item) => item.type === 'mention').length, 1, '참여 직원에게는 간다')
  })
})

test('#15 SSE: 게스트 스트림에는 남의 업무 제목이 실리지 않고, 본인 앞으로 온 알림은 온다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const guest = await login(origin, GUEST.email, GUEST.password)
    const park = await login(origin, PARK.email)
    const controller = new AbortController()
    const stream = await fetch(`${origin}/api/events`, { headers: guest.headers, signal: controller.signal })
    assert.equal(stream.status, 200)
    const chunks = []
    const reader = stream.body.getReader()
    const pump = (async () => { try { for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(Buffer.from(value).toString('utf8')) } } catch { /* abort */ } })()
    const p = api(origin, park)
    const accept = await p('POST', '/api/work-items/WK-W2/transition', { action: 'accept' })
    assert.equal(accept.status, 200, JSON.stringify(accept.body))
    const mention = await p('POST', '/api/messenger/conversations/dm-D1/messages', { text: `@${GUEST.name} 자료 확인해 주세요` })
    assert.equal(mention.status, 201, JSON.stringify(mention.body))
    await new Promise((resolve) => setTimeout(resolve, 300))
    controller.abort()
    await pump
    const text = chunks.join('')
    assert.ok(!text.includes('W2 내부 검수'), `게스트 스트림에 남의 업무 제목이 실렸다: ${text}`)
    assert.ok(text.includes('event: work'), 'work 이벤트는 종류·번호만 온다')
    assert.ok(text.includes('event: notification') && text.includes('언급'), `본인 알림은 내용째 온다: ${text}`)
    assertNoLeak(text, 'SSE')
  })
})

test('#22 하위 업무: /parent는 게이트 403, 게스트 담당 자식은 상위와 같은 프로젝트에 귀속돼야 하고, 게스트 GET·SSE에 상위 제목이 없다', async () => {
  const store = seedStore()
  await withServer(buildApp(store), async (origin) => {
    const guest = await login(origin, GUEST.email, GUEST.password)
    const admin = await login(origin, ADMIN.email)
    const g = api(origin, guest)
    const a = api(origin, admin)
    // 이동 라우트는 allowlist 밖 — 게이트가 고정 문구 하나로 막는다.
    const gated = await g('POST', '/api/work-items/WK-W1/parent', { parentId: null })
    assert.equal(gated.status, 403)
    assert.deepEqual(gated.body, GUEST_FORBIDDEN_BODY)
    // 관리자가 WK-W1(게스트 담당, PRJ-A) 아래 게스트 담당 자식을 둔다. 시드의 W3는 귀속이 없어 먼저 채운다.
    const base = store.tenants[TENANT]['work-items'].data.map((row) => (row.id === 'WK-W3' ? { ...row, projectId: 'PRJ-A' } : row))
    const child = workItem({ id: 'WK-W1-C', title: 'W1 하위 치수 확인', projectId: 'PRJ-A', parentId: 'WK-W1' })
    const saved = await a('PUT', '/api/workspace/work-items', { data: [...base, child] })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    // 상위에 projectId가 없으면 게스트 자식도 귀속을 잃는다 — 트리 검증보다 게스트 제약이 먼저 말한다.
    const bare = workItem({ id: 'WK-NP', title: '귀속 없는 상위', owner: PARK.name, ownerId: PARK.id })
    const noProject = await a('PUT', '/api/workspace/work-items', { data: [...base, child, bare, workItem({ id: 'WK-NP-C', title: '귀속 없는 게스트 자식', parentId: 'WK-NP' })] })
    assert.equal(noProject.status, 400)
    assert.equal(noProject.body.error.code, 'GUEST_PROJECT_REQUIRED')
    // 게스트 GET: 자기 담당 행만이고, 직원에게 가는 상위 제목 envelope는 없다.
    const items = await g('GET', '/api/workspace/work-items')
    assert.equal(items.status, 200)
    assert.deepEqual(items.body.data.map((row) => row.id).sort(), ['WK-W1', 'WK-W1-C', 'WK-W3'])
    assert.equal('parents' in items.body, false)
    assertNoLeak(items.body, 'GET work-items (게스트 하위 업무)')
    // 관리자가 게스트 자식을 다른 상위로 옮기면 게스트 스트림에는 key·version만 온다.
    const controller = new AbortController()
    const stream = await fetch(`${origin}/api/events`, { headers: guest.headers, signal: controller.signal })
    const chunks = []
    const reader = stream.body.getReader()
    const pump = (async () => { try { for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(Buffer.from(value).toString('utf8')) } } catch { /* abort */ } })()
    const moved = await a('POST', '/api/work-items/WK-W1-C/parent', { parentId: 'WK-W2' })
    assert.equal(moved.status, 200, JSON.stringify(moved.body))
    assert.equal(moved.body.item.projectId, 'PRJ-A')
    await new Promise((resolve) => setTimeout(resolve, 300))
    controller.abort()
    await pump
    const text = chunks.join('')
    assert.ok(text.includes('data: {"key":"work-items","version":null}'), `work 이벤트는 종류·번호만 온다: ${text}`)
    assert.ok(!text.includes('W1 하위 치수 확인') && !text.includes('W2 내부 검수'), `게스트 스트림에 업무 제목이 실렸다: ${text}`)
    assertNoLeak(text, 'SSE (하위 업무 이동)')
  })
})

test('프로필: 게스트는 소속·직책을 바꿀 수 없고(거래처명·외부 게스트 고정), 이름 변경은 grant·초대 기록에도 반영된다', async () => {
  const store = seedStore()
  await withServer(buildApp(store), async (origin) => {
    const guest = await login(origin, GUEST.email, GUEST.password)
    const patched = await api(origin, guest)('PATCH', '/api/me/profile', { name: '김서원', team: '경영진', jobRole: '운영 관리자', phone: '010-0000-0000', bio: '외부' })
    assert.equal(patched.status, 200, JSON.stringify(patched.body))
    assert.equal(patched.body.account.team, ORG, '소속은 거래처명으로 고정')
    assert.equal(patched.body.account.jobRole, '외부 게스트', '직책은 외부 게스트로 고정')
    assert.equal(patched.body.account.name, '김서원')
    assert.equal(patched.body.account.phone, '010-0000-0000')
    assert.equal(store.guestGrants[0].name, '김서원', 'grant 이름이 함께 바뀐다')
    assert.equal(store.invitedAccounts.find((item) => item.id === GUEST.id).name, '김서원', '초대 기록 이름이 함께 바뀐다')
    // 직원이 보는 명단에도 관리자 직책·부서를 달 수 없다.
    const admin = await login(origin, ADMIN.email)
    const directory = await api(origin, admin)('GET', '/api/directory')
    const entry = directory.body.members.find((member) => member.id === GUEST.id)
    assert.equal(entry.team, ORG)
    assert.equal(entry.role, '외부 게스트')
    assert.equal(entry.kind, 'guest')
  })
})

test('#20 identity 헤더: 게스트 자신의 값은 통과하고 다른 값은 기존 가드가 401로 막는다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const guest = await login(origin, GUEST.email, GUEST.password)
    const ok = await fetch(`${origin}/api/projects`, { headers: { cookie: guest.cookie, 'x-workspace-identity': `${TENANT}:${GUEST.id}` } })
    assert.equal(ok.status, 200)
    const bad = await fetch(`${origin}/api/projects`, { headers: { cookie: guest.cookie, 'x-workspace-identity': `${TENANT}:${PARK.id}` } })
    assert.equal(bad.status, 401)
    assert.equal((await readJson(bad)).error.code, 'WORKSPACE_IDENTITY_MISMATCH')
  })
})

test('접근이 끝난 grant(만료일 경과)로는 세션·로그아웃 외 전부 GUEST_ACCESS_ENDED', async () => {
  await withServer(buildApp(seedStore({ grantOverrides: { accessExpiresAt: '2020-01-01T00:00:00.000Z' } })), async (origin) => {
    const guest = await login(origin, GUEST.email, GUEST.password)
    assert.equal(guest.response.status, 200)
    const session = await fetch(`${origin}/api/auth/session`, { headers: guest.headers })
    assert.equal(session.status, 200)
    const projects = await api(origin, guest)('GET', '/api/projects')
    assert.equal(projects.status, 403)
    assert.equal(projects.body.error.code, 'GUEST_ACCESS_ENDED')
  })
})

// ─────────────────────────── #1~#4 #16 #17 #19 #21 초대 수명주기 ───────────────────────────

const inviteBody = (overrides = {}) => ({ email: 'new.guest@partner.example', name: '신규게스트', orgName: '새거래처', projectIds: ['PRJ-A'], inviteExpiresInDays: 3, ...overrides })
const tokenOf = (invitation) => new URL(invitation.url).searchParams.get('guestInvite')

test('#1/#2/#3/#4 초대 → 공개 조회 → 수락 → 로그인, 그리고 재발송·회수는 옛 토큰을 죽인다', async () => {
  const store = seedStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const a = api(origin, admin)
    const created = await a('POST', '/api/admin/guests', inviteBody())
    assert.equal(created.status, 201, JSON.stringify(created.body))
    assert.equal(created.body.invitation.delivery, 'link-only', '발송 어댑터가 없으면 링크만')
    assert.ok(created.body.invitation.url.includes('?guestInvite='))
    assert.equal(created.body.guest.status, 'invited')
    assert.equal('tokenHash' in created.body.guest, false, '해시는 응답에 내려가지 않는다')
    const grant = store.guestGrants.find((item) => item.id === created.body.guest.id)
    assert.ok(grant?.tokenHash, '해시가 저장된다')
    const invited = store.invitedAccounts.find((item) => item.email === 'new.guest@partner.example')
    assert.equal(invited.role, 'tenant-guest')
    assert.equal(invited.guestGrantId, grant.id)
    const projectA = store.tenants[TENANT]['project-spaces'].data.find((project) => project.id === 'PRJ-A')
    const member = projectA.members.find((item) => item.id === grant.accountId)
    assert.equal(member?.role, 'viewer')
    assert.equal(member?.kind, 'guest')
    assert.ok(auditEvents(store).some((event) => event.event === '게스트 초대' && event.reference === grant.id))
    // 중복 이메일
    const duplicate = await a('POST', '/api/admin/guests', inviteBody())
    assert.equal(duplicate.status, 409)
    assert.equal(duplicate.body.error.code, 'ACCOUNT_EXISTS')
    // 다른 회사 프로젝트 id
    const foreign = await a('POST', '/api/admin/guests', inviteBody({ email: 'other@partner.example', projectIds: ['PRJ-NOPE'] }))
    assert.equal(foreign.status, 400)
    assert.equal(foreign.body.error.code, 'INVALID_GUEST_PROJECTS')

    // #2 공개 조회
    const token = tokenOf(created.body.invitation)
    const peek = await fetch(`${origin}/api/guest/invitations/${token}`)
    assert.equal(peek.status, 200)
    const peekBody = await readJson(peek)
    assert.equal(peekBody.tenantName, '햇살바다')
    assert.deepEqual(peekBody.projectNames, ['파트너 협업 A'])
    assert.equal(peekBody.inviterName, ADMIN.name)
    assert.equal(peekBody.maskedEmail, 'ne*******@partner.example')
    assert.equal(typeof peekBody.expiresAt, 'string')
    const notFound = await readJson(await fetch(`${origin}/api/guest/invitations/not-a-real-token-value-0000000000000000000000`))
    const badFormat = await fetch(`${origin}/api/guest/invitations/short`)
    assert.equal(badFormat.status, 404)
    assert.deepEqual(await readJson(badFormat), notFound, '형식 오류와 없는 토큰의 본문이 같다')

    // #4 재발송 → 옛 토큰 404, 새 토큰 200
    const resent = await a('POST', `/api/admin/guests/${grant.id}/resend`, {})
    assert.equal(resent.status, 200, JSON.stringify(resent.body))
    assert.equal(resent.body.guest.resendCount, 1)
    const newToken = tokenOf(resent.body.invitation)
    assert.notEqual(newToken, token)
    assert.equal((await fetch(`${origin}/api/guest/invitations/${token}`)).status, 404)
    assert.equal((await fetch(`${origin}/api/guest/invitations/${newToken}`)).status, 200)
    assert.ok(auditEvents(store).some((event) => event.event === '게스트 초대 재발송'))
    // 회수 → 404
    const revoked = await a('POST', `/api/admin/guests/${grant.id}/revoke-invitation`, {})
    assert.equal(revoked.status, 200)
    assert.equal((await fetch(`${origin}/api/guest/invitations/${newToken}`)).status, 404)
    assert.ok(auditEvents(store).some((event) => event.event === '게스트 초대 회수'))
    // 다시 보내서 수락까지
    const again = await a('POST', `/api/admin/guests/${grant.id}/resend`, {})
    const finalToken = tokenOf(again.body.invitation)

    // #3 수락
    const weak = await fetch(`${origin}/api/guest/invitations/${finalToken}/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'short' }) })
    assert.equal(weak.status, 400)
    assert.equal((await readJson(weak)).error.code, 'WEAK_PASSWORD')
    const accepted = await fetch(`${origin}/api/guest/invitations/${finalToken}/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'NewGuest!2026' }) })
    const acceptedBody = await readJson(accepted)
    assert.equal(accepted.status, 200, JSON.stringify(acceptedBody))
    assert.deepEqual(acceptedBody, { email: 'new.guest@partner.example' })
    assert.equal(store.accountApprovals[grant.accountId], 'approved')
    assert.equal(store.accountCredentials[grant.accountId].mustChangePassword, false)
    assert.equal(grant.status, 'active')
    assert.equal(grant.tokenHash, null)
    assert.ok(auditEvents(store).some((event) => event.event === '게스트 수락' && event.actor === '게스트 신규게스트'))
    assert.equal((await fetch(`${origin}/api/guest/invitations/${finalToken}/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'NewGuest!2026' }) })).status, 404, '재수락은 404')

    // 로그인 → 게스트 전용 화면 데이터
    const guest = await login(origin, 'new.guest@partner.example', 'NewGuest!2026')
    assert.equal(guest.response.status, 200, JSON.stringify(guest.body))
    assert.equal(guest.account.role, 'tenant-guest')
    assert.deepEqual(guest.account.guestScope.projectIds, ['PRJ-A'])
    const me = await api(origin, guest)('GET', '/api/guest/me')
    assert.equal(me.status, 200)
    assert.deepEqual(me.body.scope.projects.map((project) => project.id), ['PRJ-A'])
    assert.equal(me.body.scope.orgName, '새거래처')
    assert.equal(me.body.scope.tenantName, '햇살바다')
    // 직원에게 /api/guest/me는 없는 라우트다
    assert.equal((await api(origin, admin)('GET', '/api/guest/me')).status, 404)
    // 목록
    const list = await a('GET', '/api/admin/guests')
    assert.equal(list.status, 200)
    const row = list.body.guests.find((item) => item.id === grant.id)
    assert.equal(row.status, 'active')
    assert.deepEqual(row.projects.map((project) => project.name), ['파트너 협업 A'])
  })
})

test('#16 범위 변경: 빠진 프로젝트의 members·participantIds에서 빠지고 새 프로젝트에 viewer로 들어간다', async () => {
  const store = seedStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const patched = await api(origin, admin)('PATCH', `/api/admin/guests/${GRANT_ID}`, { projectIds: ['PRJ-C'] })
    assert.equal(patched.status, 200, JSON.stringify(patched.body))
    const spaces = store.tenants[TENANT]['project-spaces'].data
    assert.equal(spaces.find((project) => project.id === 'PRJ-A').members.some((member) => member.id === GUEST.id), false)
    const inC = spaces.find((project) => project.id === 'PRJ-C').members.find((member) => member.id === GUEST.id)
    assert.equal(inC?.role, 'viewer')
    const r1 = store.tenants[TENANT]['messenger-conversations'].data.find((item) => item.id === 'grp-R1')
    assert.equal(r1.participantIds.includes(GUEST.id), false, 'A 채널에서 빠진다')
    const d1 = store.tenants[TENANT]['messenger-conversations'].data.find((item) => item.id === 'dm-D1')
    assert.equal(d1.participantIds.includes(GUEST.id), true, '1:1 기록은 남는다')
    assert.ok(auditEvents(store).some((event) => event.event === '게스트 범위 변경'))
    const guest = await login(origin, GUEST.email, GUEST.password)
    const projects = await api(origin, guest)('GET', '/api/projects')
    assert.deepEqual(projects.body.projects.map((project) => project.id), ['PRJ-C'])
    // 첨부도 범위를 따라간다: A 첨부는 목록·다운로드에서 사라지고(404), C의 기존 게시글 첨부는 열린다.
    const documents = await api(origin, guest)('GET', '/api/documents')
    assert.equal(documents.body.documents.some((document) => document.id === 'DOC-A-ATT'), false, 'A 첨부는 더 이상 보이지 않는다')
    assert.ok(documents.body.documents.some((document) => document.id === 'DOC-C-ATT'), 'C의 기존 첨부가 열린다')
    assert.equal((await fetch(`${origin}/api/documents/DOC-A-ATT/download`, { headers: guest.headers })).status, 404, '권한 검사에서 막힌다(파일 없음 410이 아니다)')
    assert.notEqual((await fetch(`${origin}/api/documents/DOC-C-ATT/download`, { headers: guest.headers })).status, 404, 'C 첨부는 권한 검사를 통과한다(픽스처에 파일 원본이 없어 410)')
    const docA = store.tenants[TENANT]['company-documents'].data.find((document) => document.id === 'DOC-A-ATT')
    assert.equal(docA.allowedUserIds.includes(GUEST.id), false)
    // 관리자가 프로젝트 설정에서 게스트를 범위 밖 프로젝트(A)에 다시 넣으려 하면 조용히 빠진다
    const put = await api(origin, admin)('PATCH', '/api/projects/PRJ-A', { members: [{ id: GUEST.id, role: 'editor' }, { id: PARK.id, role: 'editor' }] })
    assert.equal(put.status, 200)
    assert.equal(put.body.project.members.some((member) => member.id === GUEST.id), false)
  })
})

test('#17 비활성·해지·만료: 세션이 끊기고 로그인이 ACCOUNT_INACTIVE로 막힌다', async () => {
  const store = seedStore()
  const app = buildApp(store)
  await withServer(app, async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const a = api(origin, admin)
    let guest = await login(origin, GUEST.email, GUEST.password)
    assert.equal((await api(origin, guest)('GET', '/api/projects')).status, 200)
    const inactive = await a('POST', `/api/admin/guests/${GRANT_ID}/status`, { status: 'inactive' })
    assert.equal(inactive.status, 200, JSON.stringify(inactive.body))
    assert.equal((await fetch(`${origin}/api/projects`, { headers: guest.headers })).status, 401, '기존 세션은 끊긴다')
    const blocked = await login(origin, GUEST.email, GUEST.password)
    assert.equal(blocked.response.status, 403)
    assert.equal(blocked.body.error.code, 'ACCOUNT_INACTIVE')
    assert.ok(auditEvents(store).some((event) => event.event === '게스트 비활성'))
    const active = await a('POST', `/api/admin/guests/${GRANT_ID}/status`, { status: 'active' })
    assert.equal(active.status, 200)
    guest = await login(origin, GUEST.email, GUEST.password)
    assert.equal(guest.response.status, 200)
    // 해지
    const revoked = await a('DELETE', `/api/admin/guests/${GRANT_ID}`)
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body))
    assert.equal(revoked.body.guest.status, 'revoked')
    assert.equal((await fetch(`${origin}/api/projects`, { headers: guest.headers })).status, 401)
    assert.equal((await login(origin, GUEST.email, GUEST.password)).body.error.code, 'ACCOUNT_INACTIVE')
    const spaces = store.tenants[TENANT]['project-spaces'].data
    assert.ok(spaces.every((project) => !(project.members ?? []).some((member) => member.id === GUEST.id)), '모든 프로젝트 멤버에서 빠진다')
    const r1 = store.tenants[TENANT]['messenger-conversations'].data.find((item) => item.id === 'grp-R1')
    assert.equal(r1.participantIds.includes(GUEST.id), false)
    assert.ok(store.tenants[TENANT]['company-documents'].data.every((document) => !(document.allowedUserIds ?? []).includes(GUEST.id)), '해지되면 모든 문서 권한 목록에서 빠진다')
    assert.ok(auditEvents(store).some((event) => event.event === '게스트 해지'))
    // 기존 계정 관리 라우트로 게스트를 되살릴 수 없다 — grant는 '해지'인데 계정만 활성인 모순을 막는다.
    const revive = await a('POST', `/api/admin/accounts/${GUEST.id}/status`, { status: 'active' })
    assert.equal(revive.status, 409)
    assert.equal(revive.body.error.code, 'GUEST_MANAGED_ELSEWHERE')
    assert.equal((await login(origin, GUEST.email, GUEST.password)).body.error.code, 'ACCOUNT_INACTIVE')
    assert.ok(store.guestGrants.some((grant) => grant.id === GRANT_ID), 'grant는 감사 추적용으로 남는다')
    // 해지 뒤 범위 변경은 409
    assert.equal((await a('PATCH', `/api/admin/guests/${GRANT_ID}`, { projectIds: ['PRJ-A'] })).status, 409)
    // 감사 조회
    const audit = await a('GET', `/api/admin/guests/${GRANT_ID}/audit`)
    assert.equal(audit.status, 200)
    assert.ok(audit.body.events.some((event) => event.event === '게스트 해지'))
  })
  // 만료 스케줄러
  const expiring = seedStore({ grantOverrides: { accessExpiresAt: '2026-09-04T00:00:00.000Z' } })
  const app2 = buildApp(expiring)
  await withServer(app2, async (origin) => {
    const guest = await login(origin, GUEST.email, GUEST.password)
    assert.equal(guest.response.status, 200)
    const result = await app2.locals.guestAccess.expireGuestGrants({ now: new Date('2026-09-05T00:00:00.000Z') })
    assert.deepEqual(result, { expired: 1 })
    assert.equal(expiring.guestGrants[0].status, 'expired')
    assert.equal(expiring.accountApprovals[GUEST.id], 'inactive')
    assert.equal((await fetch(`${origin}/api/projects`, { headers: guest.headers })).status, 401)
    assert.equal((await login(origin, GUEST.email, GUEST.password)).body.error.code, 'ACCOUNT_INACTIVE')
    assert.ok(auditEvents(expiring).some((event) => event.event === '게스트 만료'))
    assert.ok(app2.locals.scheduler.has('guest-grant-expiry'), '일 1회 만료 잡이 등록된다')
  })
})

test('#19 감사 디바운스: 같은 경로 GET 5회는 1건, 변경 2회는 2건, 관리자 감사 조회에 나온다', async () => {
  const store = seedStore()
  await withServer(buildApp(store), async (origin) => {
    const guest = await login(origin, GUEST.email, GUEST.password)
    const g = api(origin, guest)
    for (let index = 0; index < 5; index += 1) assert.equal((await g('GET', '/api/workspace/work-items')).status, 200)
    for (let index = 0; index < 2; index += 1) assert.equal((await g('POST', '/api/messenger/conversations/grp-R1/messages', { text: `메시지 ${index}` })).status, 201)
    const reads = auditEvents(store).filter((event) => event.event === '게스트 조회' && event.scope === 'GET /api/workspace/work-items')
    assert.equal(reads.length, 1)
    assert.equal(reads[0].actor, `게스트 ${GUEST.name}`)
    assert.equal(reads[0].reference, GRANT_ID)
    const writes = auditEvents(store).filter((event) => event.event === '게스트 변경' && event.scope === 'POST /api/messenger/conversations/:id/messages')
    assert.equal(writes.length, 2)
    const admin = await login(origin, ADMIN.email)
    const audit = await api(origin, admin)('GET', `/api/admin/guests/${GRANT_ID}/audit`)
    assert.ok(audit.body.events.some((event) => event.event === '게스트 조회'))
    assert.ok(audit.body.events.some((event) => event.event === '게스트 변경'))
  })
})

test('#21 이메일 어댑터: 성공이면 delivery sent, throw면 link-only로 강등되고 초대는 저장된다', async () => {
  const sentStore = seedStore()
  const calls = []
  await withServer(buildApp(sentStore, { guestInviteDelivery: async (payload) => { calls.push(payload); return { delivered: true, channel: 'test' } } }), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const created = await api(origin, admin)('POST', '/api/admin/guests', inviteBody())
    assert.equal(created.status, 201)
    assert.equal(created.body.invitation.delivery, 'sent')
    assert.equal(created.body.invitation.channel, 'test')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].email, 'new.guest@partner.example')
    assert.equal(calls[0].tenantName, '햇살바다')
    assert.deepEqual(calls[0].projectNames, ['파트너 협업 A'])
    assert.ok(calls[0].inviteUrl.includes('?guestInvite='))
  })
  const failStore = seedStore()
  await withServer(buildApp(failStore, { guestInviteDelivery: async () => { throw new Error('smtp down') } }), async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const created = await api(origin, admin)('POST', '/api/admin/guests', inviteBody())
    assert.equal(created.status, 201)
    assert.equal(created.body.invitation.delivery, 'link-only')
    assert.ok(failStore.guestGrants.some((grant) => grant.email === 'new.guest@partner.example'), '발송 실패가 초대를 되돌리지 않는다')
  })
})

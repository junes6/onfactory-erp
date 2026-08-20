import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createApp, DEFAULT_MODEL } from './app.mjs'

async function withServer(app, run) {
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()

  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
}

async function login(origin, email, workspace = 'tenant', password = 'demo1234') {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace, email, password }),
  })
  return { response, cookie: response.headers.get('set-cookie') }
}

test('health exposes safe Claude configuration status', async () => {
  await withServer(createApp({ apiKey: '' }), async (origin) => {
    const response = await fetch(`${origin}/api/health`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { claude: false, model: DEFAULT_MODEL })
  })
})

test('createApp reuses injected workspace state and sessions while publishing synchronous store commits', async () => {
  const initialWorkspaceStore = {
    version: 2,
    tenants: { 'TENANT-SUNSEA': {} },
    platform: {},
    accountApprovals: {},
    accountCredentials: {},
    invitedAccounts: [],
    passwordResetRequests: [],
  }
  const sessions = new Map()
  const committedStores = []
  const appOptions = {
    apiKey: '',
    initialWorkspaceStore,
    sessions,
    onWorkspaceStoreChange: (store) => committedStores.push(store),
  }
  let cookie = ''
  const firstApp = createApp(appOptions)
  assert.ok(committedStores.length >= 1)
  assert.equal(committedStores.at(-1), initialWorkspaceStore)

  await withServer(firstApp, async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    assert.equal(admin.response.status, 200)
    cookie = admin.cookie
    assert.ok(sessions.size > 0)
    const commitsBeforeWrite = committedStores.length
    const save = await fetch(`${origin}/api/workspace/calendar-departments`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ data: ['전사', '배포운영팀'] }),
    })
    assert.equal(save.status, 200)
    assert.ok(committedStores.length > commitsBeforeWrite)
    assert.equal(committedStores.at(-1), initialWorkspaceStore)
    assert.deepEqual(initialWorkspaceStore.tenants['TENANT-SUNSEA']['calendar-departments'].data, ['전사', '배포운영팀'])
  })

  await withServer(createApp(appOptions), async (origin) => {
    const session = await fetch(`${origin}/api/auth/session`, { headers: { cookie } })
    assert.equal(session.status, 200)
    assert.equal((await session.json()).account.id, 'USR-SUNSEA-ADMIN')
  })
})

test('chat returns a usable demo response without an API key', async () => {
  await withServer(createApp({ apiKey: '', authDisabled: true }), async (origin) => {
    const response = await fetch(`${origin}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: '오늘 생산 우선순위를 정리해줘' }],
        context: { delayedLots: 2 },
      }),
    })
    const body = await response.json()

    assert.equal(response.status, 200)
    assert.equal(body.mode, 'demo')
    assert.equal(body.model, DEFAULT_MODEL)
    assert.match(body.text, /데모 모드/)
  })
})

test('chat rejects requests without a user message', async () => {
  await withServer(createApp({ apiKey: '', authDisabled: true }), async (origin) => {
    const response = await fetch(`${origin}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    })

    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, 'INVALID_MESSAGES')
  })
})

test('chat uses the configured Claude client and response contract', async () => {
  const fakeClient = {
    messages: {
      create: async (request) => {
        assert.equal(request.model, 'claude-test')
        assert.equal(request.messages[0].content, '재고를 검토해줘')
        assert.match(request.system, /<context>/)
        return {
          model: 'claude-test',
          content: [{ type: 'text', text: '안전재고 미달 품목 2건입니다.' }],
          usage: { input_tokens: 10, output_tokens: 8 },
        }
      },
    },
  }

  await withServer(
    createApp({ apiKey: 'test-key', model: 'claude-test', client: fakeClient, authDisabled: true }),
    async (origin) => {
      const response = await fetch(`${origin}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: '재고를 검토해줘' }],
          context: { lowStock: 2 },
        }),
      })
      const body = await response.json()

      assert.equal(response.status, 200)
      assert.equal(body.mode, 'claude')
      assert.equal(body.model, 'claude-test')
      assert.equal(body.text, '안전재고 미달 품목 2건입니다.')
    },
  )
})

test('login validates approval, workspace role and creates an HttpOnly session', async () => {
  await withServer(createApp({ apiKey: '' }), async (origin) => {
    const invalid = await fetch(`${origin}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: 'tenant', email: 'admin@sunsea.co.kr', password: 'wrong' }),
    })
    assert.equal(invalid.status, 401)

    const pending = await fetch(`${origin}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: 'tenant', email: 'newstaff@sunsea.co.kr', password: 'demo1234' }),
    })
    assert.equal(pending.status, 403)
    assert.equal((await pending.json()).error.code, 'ACCOUNT_PENDING')

    const adminLogin = await fetch(`${origin}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: 'tenant', email: 'admin@sunsea.co.kr', password: 'demo1234' }),
    })
    assert.equal(adminLogin.status, 200)
    assert.match(adminLogin.headers.get('set-cookie'), /HttpOnly/)
    assert.equal((await adminLogin.clone().json()).account.role, 'tenant-admin')

    const session = await fetch(`${origin}/api/auth/session`, { headers: { cookie: adminLogin.headers.get('set-cookie') } })
    assert.equal(session.status, 200)
    assert.equal((await session.json()).account.tenantName, '햇살바다')

    const accountList = await fetch(`${origin}/api/admin/accounts`, { headers: { cookie: adminLogin.headers.get('set-cookie') } })
    assert.equal(accountList.status, 200)
    assert.equal((await accountList.json()).accounts[0].status, '승인대기')

    const approval = await fetch(`${origin}/api/admin/accounts/USR-SUNSEA-PENDING/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminLogin.headers.get('set-cookie') },
      body: JSON.stringify({ decision: 'approve' }),
    })
    assert.equal(approval.status, 200)
    const approved = await approval.json()
    assert.equal(approved.account.onboardingStatus, '초기설정대기')
    assert.equal(approved.onboarding.requiresPasswordChange, true)
    assert.notEqual(approved.onboarding.temporaryPassword, 'demo1234')
    assert.ok(Date.parse(approved.onboarding.expiresAt) > Date.now())

    const commonPasswordLogin = await fetch(`${origin}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: 'tenant', email: 'newstaff@sunsea.co.kr', password: 'demo1234' }),
    })
    assert.equal(commonPasswordLogin.status, 401)

    const initialLogin = await login(origin, 'newstaff@sunsea.co.kr', 'tenant', approved.onboarding.temporaryPassword)
    assert.equal(initialLogin.response.status, 200)
    assert.equal((await initialLogin.response.json()).account.requiresPasswordChange, true)
    const blockedWorkspace = await fetch(`${origin}/api/directory`, { headers: { cookie: initialLogin.cookie } })
    assert.equal(blockedWorkspace.status, 428)
    assert.equal((await blockedWorkspace.json()).error.code, 'PASSWORD_CHANGE_REQUIRED')

    const weakChange = await fetch(`${origin}/api/auth/password/change`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: initialLogin.cookie }, body: JSON.stringify({ newPassword: 'short' }),
    })
    assert.equal(weakChange.status, 400)
    const changed = await fetch(`${origin}/api/auth/password/change`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: initialLogin.cookie }, body: JSON.stringify({ newPassword: 'Factory!Secure2026' }),
    })
    assert.equal(changed.status, 200)
    assert.equal((await changed.json()).account.requiresPasswordChange, false)
    assert.equal((await fetch(`${origin}/api/directory`, { headers: { cookie: initialLogin.cookie } })).status, 200)
    assert.equal((await login(origin, 'newstaff@sunsea.co.kr', 'tenant', approved.onboarding.temporaryPassword)).response.status, 401)
    assert.equal((await login(origin, 'newstaff@sunsea.co.kr', 'tenant', 'Factory!Secure2026')).response.status, 200)
  })
})

test('password reset requests use a non-enumerating response', async () => {
  let deliveredReset
  await withServer(createApp({
    apiKey: '',
    exposePasswordResetTokens: false,
    passwordResetDelivery: async (delivery) => { deliveredReset = delivery },
  }), async (origin) => {
    const known = await fetch(`${origin}/api/auth/password-reset`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@sunsea.co.kr' }),
    })
    const unknown = await fetch(`${origin}/api/auth/password-reset`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'unknown@example.com' }),
    })
    assert.equal(known.status, 202)
    assert.equal(unknown.status, 202)
    assert.deepEqual(await known.json(), await unknown.json())
    assert.ok(deliveredReset?.resetUrl)
    assert.equal(deliveredReset.email, 'admin@sunsea.co.kr')
    const deliveredToken = new URL(deliveredReset.resetUrl).searchParams.get('reset')
    const completed = await fetch(`${origin}/api/auth/password-reset/confirm`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: deliveredToken, newPassword: 'Delivered!Secure2026' }),
    })
    assert.equal(completed.status, 200)
  })
})

test('local password reset tokens expire, are single-use and persist only as hashes', async () => {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'onfactory-password-reset-'))
  const storeFile = path.join(temporaryDirectory, 'workspace-state.json')
  let expiredToken = ''
  try {
    await withServer(createApp({ apiKey: '', workspaceStoreFile: storeFile, exposePasswordResetTokens: true }), async (origin) => {
      const issued = await fetch(`${origin}/api/auth/password-reset`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@sunsea.co.kr' }),
      })
      const body = await issued.json()
      expiredToken = body.developmentReset.token
      assert.equal(issued.status, 202)
      assert.ok(expiredToken.length >= 40)
      assert.equal(readFileSync(storeFile, 'utf8').includes(expiredToken), false)
    })

    const stored = JSON.parse(readFileSync(storeFile, 'utf8'))
    stored.passwordResetRequests[0].expiresAt = '2000-01-01T00:00:00.000Z'
    writeFileSync(storeFile, JSON.stringify(stored, null, 2))

    await withServer(createApp({ apiKey: '', workspaceStoreFile: storeFile, exposePasswordResetTokens: true }), async (origin) => {
      const expired = await fetch(`${origin}/api/auth/password-reset/confirm`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: expiredToken, newPassword: 'Reset!Secure2026' }),
      })
      assert.equal(expired.status, 400)
      assert.equal((await expired.json()).error.code, 'RESET_TOKEN_EXPIRED')

      const issuedAgain = await fetch(`${origin}/api/auth/password-reset`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@sunsea.co.kr' }),
      })
      const resetToken = (await issuedAgain.json()).developmentReset.token
      const weak = await fetch(`${origin}/api/auth/password-reset/confirm`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: resetToken, newPassword: 'weak' }),
      })
      assert.equal(weak.status, 400)
      const completed = await fetch(`${origin}/api/auth/password-reset/confirm`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: resetToken, newPassword: 'Reset!Secure2026' }),
      })
      assert.equal(completed.status, 200)
      const replay = await fetch(`${origin}/api/auth/password-reset/confirm`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: resetToken, newPassword: 'Another!Secure2027' }),
      })
      assert.equal(replay.status, 400)
      assert.equal((await login(origin, 'admin@sunsea.co.kr')).response.status, 401)
      assert.equal((await login(origin, 'admin@sunsea.co.kr', 'tenant', 'Reset!Secure2026')).response.status, 200)
      const persisted = readFileSync(storeFile, 'utf8')
      assert.equal(persisted.includes(resetToken), false)
      assert.equal(persisted.includes('Reset!Secure2026'), false)
    })
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

test('workspace data is tenant scoped and survives page-level reads', async () => {
  await withServer(createApp({ apiKey: '' }), async (origin) => {
    const login = await fetch(`${origin}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: 'tenant', email: 'admin@sunsea.co.kr', password: 'demo1234' }),
    })
    const cookie = login.headers.get('set-cookie')

    const saved = await fetch(`${origin}/api/workspace/calendar-events`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ data: [{ id: 'CAL-TEST', title: '공유 일정' }] }),
    })
    assert.equal(saved.status, 200)

    const loaded = await fetch(`${origin}/api/workspace/calendar-events`, { headers: { cookie } })
    assert.equal(loaded.status, 200)
    assert.deepEqual((await loaded.json()).data, [{ id: 'CAL-TEST', title: '공유 일정' }])

    const platformLogin = await fetch(`${origin}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: 'platform', email: 'operator@onfactory.co.kr', password: 'demo1234' }),
    })
    const forbidden = await fetch(`${origin}/api/workspace/calendar-events`, {
      headers: { cookie: platformLogin.headers.get('set-cookie') },
    })
    assert.equal(forbidden.status, 403)
  })
})

test('workspace identity header rejects a stale tab after the session account changes', async () => {
  await withServer(createApp({ apiKey: '' }), async (origin) => {
    const sunseaAdmin = await login(origin, 'admin@sunsea.co.kr')
    const pohangAdmin = await login(origin, 'admin@pohangcoop.co.kr')
    const staleIdentity = 'TENANT-SUNSEA:USR-SUNSEA-ADMIN'

    const staleRead = await fetch(`${origin}/api/workspace/calendar-events`, {
      headers: { cookie: pohangAdmin.cookie, 'x-workspace-identity': staleIdentity },
    })
    assert.equal(staleRead.status, 401)
    assert.equal((await staleRead.json()).error.code, 'WORKSPACE_IDENTITY_MISMATCH')

    const staleWrite = await fetch(`${origin}/api/workspace/calendar-events`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: pohangAdmin.cookie, 'x-workspace-identity': staleIdentity },
      body: JSON.stringify({ data: [{ id: 'CROSS-TENANT', title: '잘못된 일정' }] }),
    })
    assert.equal(staleWrite.status, 401)

    const pohangAfterRejectedWrite = await fetch(`${origin}/api/workspace/calendar-events`, {
      headers: { cookie: pohangAdmin.cookie, 'x-workspace-identity': 'TENANT-POHANG:USR-POHANG-ADMIN' },
    })
    assert.equal(pohangAfterRejectedWrite.status, 200)
    assert.equal((await pohangAfterRejectedWrite.json()).data, null)

    const correctRead = await fetch(`${origin}/api/workspace/calendar-events`, {
      headers: { cookie: sunseaAdmin.cookie, 'x-workspace-identity': staleIdentity },
    })
    assert.equal(correctRead.status, 200)
  })
})

test('invited members are tenant isolated and limited to safe collaboration operations', async () => {
  await withServer(createApp({ apiKey: '' }), async (origin) => {
    const sunseaAdmin = await login(origin, 'admin@sunsea.co.kr')
    const pohangAdmin = await login(origin, 'admin@pohangcoop.co.kr')
    assert.equal(sunseaAdmin.response.status, 200)
    assert.equal(pohangAdmin.response.status, 200)

    const namelessInvite = await fetch(`${origin}/api/admin/accounts/invite`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: sunseaAdmin.cookie },
      body: JSON.stringify({ email: 'nameless@sunsea.co.kr', team: '생산 1팀', role: '생산 작업자' }),
    })
    assert.equal(namelessInvite.status, 400)
    assert.equal((await namelessInvite.json()).error.code, 'INVALID_INVITE')

    const inviteResponse = await fetch(`${origin}/api/admin/accounts/invite`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: sunseaAdmin.cookie },
      body: JSON.stringify({ name: '이민수', email: 'minsu@sunsea.co.kr', team: '생산 1팀', role: '생산 작업자' }),
    })
    const invite = await inviteResponse.json()
    assert.equal(inviteResponse.status, 201)
    assert.equal(invite.account.name, '이민수')
    assert.equal(invite.onboarding.requiresAdminApproval, true)
    assert.equal(invite.onboarding.temporaryPassword, undefined)

    const pendingLogin = await login(origin, 'minsu@sunsea.co.kr')
    assert.equal(pendingLogin.response.status, 401)
    assert.equal((await pendingLogin.response.json()).error.code, 'INVALID_CREDENTIALS')

    const crossTenantApproval = await fetch(`${origin}/api/admin/accounts/${invite.account.id}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: pohangAdmin.cookie },
      body: JSON.stringify({ decision: 'approve' }),
    })
    assert.equal(crossTenantApproval.status, 404)

    const approval = await fetch(`${origin}/api/admin/accounts/${invite.account.id}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: sunseaAdmin.cookie },
      body: JSON.stringify({ decision: 'approve' }),
    })
    assert.equal(approval.status, 200)
    const approved = await approval.json()
    assert.notEqual(approved.onboarding.temporaryPassword, 'demo1234')

    assert.equal((await login(origin, 'minsu@sunsea.co.kr')).response.status, 401)
    const memberLogin = await login(origin, 'minsu@sunsea.co.kr', 'tenant', approved.onboarding.temporaryPassword)
    const member = await memberLogin.response.json()
    assert.equal(memberLogin.response.status, 200)
    assert.equal(member.account.role, 'tenant-member')
    assert.equal(member.account.tenantId, 'TENANT-SUNSEA')
    assert.equal(member.account.name, '이민수')
    assert.equal(member.account.requiresPasswordChange, true)

    const beforePasswordChange = await fetch(`${origin}/api/directory`, { headers: { cookie: memberLogin.cookie } })
    assert.equal(beforePasswordChange.status, 428)
    const passwordChange = await fetch(`${origin}/api/auth/password/change`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: memberLogin.cookie }, body: JSON.stringify({ newPassword: 'Worker!Secure2026' }),
    })
    assert.equal(passwordChange.status, 200)

    const directoryResponse = await fetch(`${origin}/api/directory`, { headers: { cookie: memberLogin.cookie } })
    const directory = await directoryResponse.json()
    assert.equal(directoryResponse.status, 200)
    assert.ok(directory.members.some((item) => item.id === 'USR-SUNSEA-OH' && item.name === '오태식'))
    assert.equal(directory.members.some((item) => item.email), false)

    for (const key of ['account-requests', 'sales-channels']) {
      const forbiddenRead = await fetch(`${origin}/api/workspace/${key}`, { headers: { cookie: memberLogin.cookie } })
      assert.equal(forbiddenRead.status, 403, `${key} member read must be forbidden`)
      assert.equal((await forbiddenRead.json()).error.code, 'STORE_READ_FORBIDDEN')

      const forbiddenWrite = await fetch(`${origin}/api/workspace/${key}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie: memberLogin.cookie },
        body: JSON.stringify({ data: [{ id: 'FORGED' }] }),
      })
      assert.equal(forbiddenWrite.status, 403, `${key} member write must be forbidden`)
      assert.equal((await forbiddenWrite.json()).error.code, 'STORE_WRITE_FORBIDDEN')
    }

    for (const key of ['inventory-locations', 'factory-locations']) {
      const fixture = [{ id: `${key}-READ-ONLY`, label: '현장 조회 데이터' }]
      const seedReadOnly = await fetch(`${origin}/api/workspace/${key}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie: sunseaAdmin.cookie },
        body: JSON.stringify({ data: fixture }),
      })
      assert.equal(seedReadOnly.status, 200)
      const allowedRead = await fetch(`${origin}/api/workspace/${key}`, { headers: { cookie: memberLogin.cookie } })
      assert.equal(allowedRead.status, 200, `${key} member read must be allowed`)
      assert.deepEqual((await allowedRead.json()).data, fixture)
      const forbiddenWrite = await fetch(`${origin}/api/workspace/${key}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie: memberLogin.cookie },
        body: JSON.stringify({ data: [{ id: 'FORGED' }] }),
      })
      assert.equal(forbiddenWrite.status, 403, `${key} member write must be forbidden`)
      assert.equal((await forbiddenWrite.json()).error.code, 'STORE_WRITE_FORBIDDEN')
    }

    const teamConversation = {
      id: 'team-ops', type: 'team', name: '전사 운영 공지', subtitle: '햇살바다 · 전사', unread: 1,
      lastMessage: '작업 전 안전점검 바랍니다.', lastTime: '09:00',
      messages: [{ id: 'MSG-BASE', senderId: 'USR-SUNSEA-ADMIN', senderName: '김서원', text: '작업 전 안전점검 바랍니다.', time: '09:00' }],
    }
    const privateConversation = {
      id: 'direct-admin', type: 'direct', name: '관리자 대화', subtitle: '1:1 대화', unread: 0,
      lastMessage: '비공개', lastTime: '09:10', participantIds: ['USR-SUNSEA-ADMIN', 'USR-SUNSEA-OH'],
      messages: [{ id: 'MSG-PRIVATE', senderId: 'USR-SUNSEA-ADMIN', senderName: '김서원', text: '비공개', time: '09:10' }],
    }
    const legacyQualityConversation = {
      id: 'team-quality', type: 'team', name: '품질관리팀', subtitle: '팀 대화', unread: 0,
      lastMessage: '품질팀 전용', lastTime: '09:05',
      messages: [{ id: 'MSG-QUALITY', senderId: 'USR-SUNSEA-PARK', senderName: '박지현', text: '품질팀 전용', time: '09:05' }],
    }
    const legacyDirectConversation = {
      id: 'direct-oh-legacy', type: 'direct', name: '오태식', subtitle: '생산 1팀', memberId: 'oh', unread: 0,
      lastMessage: '기존 개인 대화', lastTime: '09:07',
      messages: [{ id: 'MSG-OH-LEGACY', senderId: 'oh', senderName: '오태식', text: '기존 개인 대화', time: '09:07' }],
    }
    const seedMessenger = await fetch(`${origin}/api/workspace/messenger-conversations`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: sunseaAdmin.cookie },
      body: JSON.stringify({ data: [teamConversation, legacyQualityConversation, privateConversation, legacyDirectConversation] }),
    })
    assert.equal(seedMessenger.status, 200)
    const memberMessengerRead = await fetch(`${origin}/api/workspace/messenger-conversations`, { headers: { cookie: memberLogin.cookie } })
    assert.deepEqual((await memberMessengerRead.json()).data, [teamConversation])
    const colleagueLogin = await login(origin, 'taesik.oh@sunsea.co.kr')
    assert.equal(colleagueLogin.response.status, 200)
    const colleagueMessengerRead = await fetch(`${origin}/api/workspace/messenger-conversations`, { headers: { cookie: colleagueLogin.cookie } })
    assert.deepEqual((await colleagueMessengerRead.json()).data, [teamConversation, privateConversation, legacyDirectConversation])

    const forgedMessage = { id: 'MSG-MEMBER', senderId: 'me', senderName: '관리자 사칭', text: '원료 입고 확인했습니다.', time: '10:00' }
    const sendMessage = await fetch(`${origin}/api/workspace/messenger-conversations`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: memberLogin.cookie },
      body: JSON.stringify({ data: [{ ...teamConversation, unread: 0, lastMessage: forgedMessage.text, lastTime: forgedMessage.time, messages: [...teamConversation.messages, forgedMessage] }] }),
    })
    assert.equal(sendMessage.status, 200)
    const messengerAfterSend = await fetch(`${origin}/api/workspace/messenger-conversations`, { headers: { cookie: memberLogin.cookie } })
    const storedTeamConversation = (await messengerAfterSend.json()).data[0]
    assert.equal(storedTeamConversation.unread, 1)
    assert.equal(storedTeamConversation.messages.at(-1).senderId, member.account.id)
    assert.equal(storedTeamConversation.messages.at(-1).senderName, '이민수')

    const deleteConversation = await fetch(`${origin}/api/workspace/messenger-conversations`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie: memberLogin.cookie }, body: JSON.stringify({ data: [] }),
    })
    assert.equal(deleteConversation.status, 403)
    const mutateOldMessage = await fetch(`${origin}/api/workspace/messenger-conversations`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: memberLogin.cookie },
      body: JSON.stringify({ data: [{ ...storedTeamConversation, messages: [{ ...storedTeamConversation.messages[0], text: '과거 메시지 조작' }, ...storedTeamConversation.messages.slice(1)] }] }),
    })
    assert.equal(mutateOldMessage.status, 403)
    const injectPrivateConversation = await fetch(`${origin}/api/workspace/messenger-conversations`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie: memberLogin.cookie },
      body: JSON.stringify({ data: [storedTeamConversation, privateConversation] }),
    })
    assert.equal(injectPrivateConversation.status, 403)

    const companyEvent = { id: 'EV-COMPANY', title: '전사 안전교육', date: '2026-08-20', start: '09:00', end: '10:00', scope: 'company', department: '전사', location: '교육장', owner: '김서원', note: '전 직원 참석' }
    const departmentEvent = { id: 'EV-PRODUCTION', title: '생산팀 교대회의', date: '2026-08-20', start: '10:00', end: '10:30', scope: 'department', department: '생산 1팀', location: '현장', owner: '오태식', ownerId: 'USR-OTHER', note: '' }
    const hiddenEvent = { id: 'EV-QUALITY', title: '품질팀 회의', date: '2026-08-20', start: '11:00', end: '11:30', scope: 'department', department: '품질관리', location: '회의실', owner: '박지현', ownerId: 'USR-QUALITY', note: '' }
    const privateEvent = { id: 'EV-PRIVATE', title: '관리자 개인 일정', date: '2026-08-20', start: '12:00', end: '12:30', scope: 'personal', department: '경영지원', location: '', owner: '김서원', ownerId: 'USR-SUNSEA-ADMIN', note: '' }
    const seedCalendar = await fetch(`${origin}/api/workspace/calendar-events`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie: sunseaAdmin.cookie },
      body: JSON.stringify({ data: [companyEvent, departmentEvent, hiddenEvent, privateEvent] }),
    })
    assert.equal(seedCalendar.status, 200)
    const memberCalendarRead = await fetch(`${origin}/api/workspace/calendar-events`, { headers: { cookie: memberLogin.cookie } })
    assert.deepEqual((await memberCalendarRead.json()).data, [companyEvent, departmentEvent])

    const newMemberEvent = { id: 'EV-MEMBER', title: '원료 계량 일정', date: '2026-08-21', start: '08:00', end: '09:00', scope: 'department', department: '위조 부서', location: '계량실', owner: '관리자 사칭', note: '' }
    const createCalendarEvent = await fetch(`${origin}/api/workspace/calendar-events`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie: memberLogin.cookie },
      body: JSON.stringify({ data: [companyEvent, departmentEvent, newMemberEvent] }),
    })
    assert.equal(createCalendarEvent.status, 200)
    const calendarAfterCreate = await fetch(`${origin}/api/workspace/calendar-events`, { headers: { cookie: memberLogin.cookie } })
    const visibleCalendar = (await calendarAfterCreate.json()).data
    const storedMemberEvent = visibleCalendar.find((event) => event.id === newMemberEvent.id)
    assert.equal(storedMemberEvent.ownerId, member.account.id)
    assert.equal(storedMemberEvent.owner, '이민수')
    assert.equal(storedMemberEvent.department, '생산 1팀')

    const editMemberEvent = await fetch(`${origin}/api/workspace/calendar-events`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie: memberLogin.cookie },
      body: JSON.stringify({ data: visibleCalendar.map((event) => event.id === storedMemberEvent.id ? { ...event, title: '원료 계량·검수 일정' } : event) }),
    })
    assert.equal(editMemberEvent.status, 200)
    const forgeOtherEvent = await fetch(`${origin}/api/workspace/calendar-events`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie: memberLogin.cookie },
      body: JSON.stringify({ data: visibleCalendar.map((event) => event.id === companyEvent.id ? { ...event, title: '전사 일정 조작' } : event) }),
    })
    assert.equal(forgeOtherEvent.status, 403)

    const latestCalendarRead = await fetch(`${origin}/api/workspace/calendar-events`, { headers: { cookie: memberLogin.cookie } })
    const latestVisibleCalendar = (await latestCalendarRead.json()).data
    const deleteOwnEvent = await fetch(`${origin}/api/workspace/calendar-events`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie: memberLogin.cookie },
      body: JSON.stringify({ data: latestVisibleCalendar.filter((event) => event.id !== newMemberEvent.id) }),
    })
    assert.equal(deleteOwnEvent.status, 200)
    const deleteOtherEvent = await fetch(`${origin}/api/workspace/calendar-events`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie: memberLogin.cookie },
      body: JSON.stringify({ data: latestVisibleCalendar.filter((event) => event.id !== departmentEvent.id) }),
    })
    assert.equal(deleteOtherEvent.status, 403)

    const journalColleague = await login(origin, 'jihyun.park@sunsea.co.kr')
    assert.equal(journalColleague.response.status, 200)
    const otherJournal = {
      id: 'JR-OTHER', date: '2026-08-19', title: '다른 직원 일지', author: '박지현', department: '품질관리',
      completed: '재고 실사', issue: '', nextPlan: '차이 확인', approver: '김서원', status: '결재요청',
      updatedAt: '방금', feedback: '', attachments: [],
    }
    const seedJournal = await fetch(`${origin}/api/workspace/daily-journals`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: journalColleague.cookie },
      body: JSON.stringify({ data: [otherJournal] }),
    })
    assert.equal(seedJournal.status, 200)
    const privateJournalRead = await fetch(`${origin}/api/workspace/daily-journals`, { headers: { cookie: memberLogin.cookie } })
    assert.deepEqual((await privateJournalRead.json()).data, [])

    const memberJournal = {
      id: 'JR-MEMBER', date: '2026-08-19', title: '생산 업무일지', author: '위조 이름', department: '위조 부서',
      completed: '원료 계량 완료', issue: '', nextPlan: '포장 작업', approver: '김서원', status: '임시저장',
      updatedAt: '방금', feedback: '', attachments: [],
    }
    const createJournal = await fetch(`${origin}/api/workspace/daily-journals`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: memberLogin.cookie },
      body: JSON.stringify({ data: [memberJournal] }),
    })
    assert.equal(createJournal.status, 200)
    const memberJournalRead = await fetch(`${origin}/api/workspace/daily-journals`, { headers: { cookie: memberLogin.cookie } })
    const storedMemberJournal = (await memberJournalRead.json()).data[0]
    assert.equal(storedMemberJournal.author, '이민수')
    assert.equal(storedMemberJournal.department, '생산 1팀')
    assert.equal(storedMemberJournal.authorId, member.account.id)
    assert.match(storedMemberJournal.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

    const forgeJournalApproval = await fetch(`${origin}/api/workspace/daily-journals`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: memberLogin.cookie },
      body: JSON.stringify({ data: [{ ...storedMemberJournal, status: '승인' }] }),
    })
    assert.equal(forgeJournalApproval.status, 403)
    assert.equal((await forgeJournalApproval.json()).error.code, 'JOURNAL_WRITE_FORBIDDEN')

    const requestJournalApproval = await fetch(`${origin}/api/workspace/daily-journals`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: memberLogin.cookie },
      body: JSON.stringify({ data: [{ ...storedMemberJournal, status: '결재요청' }] }),
    })
    assert.equal(requestJournalApproval.status, 200)

    const journalAdminRead = await fetch(`${origin}/api/workspace/daily-journals`, { headers: { cookie: sunseaAdmin.cookie } })
    const journalsBeforeAdminAttack = (await journalAdminRead.json()).data
    const forgedReview = {
      id: 'JR-REVIEW-FORGED', decision: '승인', comment: '위조된 승인 이력',
      reviewedAt: new Date().toISOString(), reviewerId: 'USR-SUNSEA-ADMIN', reviewerName: '김서원',
    }
    const adminJournalAttacks = [
      (journal) => ({ ...journal, completed: '관리자 generic PUT 본문 조작' }),
      (journal) => ({ ...journal, status: '승인', feedback: '전용 결재 API 우회' }),
      (journal) => ({ ...journal, reviews: [...journal.reviews, forgedReview] }),
    ]
    for (const mutate of adminJournalAttacks) {
      const adminApprovalBypass = await fetch(`${origin}/api/workspace/daily-journals`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie: sunseaAdmin.cookie },
        body: JSON.stringify({
          data: journalsBeforeAdminAttack.map((journal) => journal.id === storedMemberJournal.id ? mutate(journal) : journal),
        }),
      })
      assert.equal(adminApprovalBypass.status, 403)
      assert.equal((await adminApprovalBypass.json()).error.code, 'JOURNAL_ADMIN_WRITE_FORBIDDEN')
    }
    const memberJournalAfterAdminAttack = await fetch(`${origin}/api/workspace/daily-journals`, { headers: { cookie: memberLogin.cookie } })
    const journalAfterAdminAttack = (await memberJournalAfterAdminAttack.json()).data[0]
    assert.equal(journalAfterAdminAttack.completed, storedMemberJournal.completed)
    assert.equal(journalAfterAdminAttack.status, '결재요청')
    assert.match(journalAfterAdminAttack.submittedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    assert.equal(journalAfterAdminAttack.feedback, '')
    assert.deepEqual(journalAfterAdminAttack.reviews, [])

    const editSubmittedJournal = await fetch(`${origin}/api/workspace/daily-journals`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: memberLogin.cookie },
      body: JSON.stringify({ data: [{ ...storedMemberJournal, status: '결재요청', completed: '제출 후 조작' }] }),
    })
    assert.equal(editSubmittedJournal.status, 403)

    const memberRejectJournal = await fetch(`${origin}/api/daily-journals/${storedMemberJournal.id}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: memberLogin.cookie },
      body: JSON.stringify({ decision: 'reject', comment: '관리자 사칭 반려' }),
    })
    assert.equal(memberRejectJournal.status, 403)

    const missingJournalComment = await fetch(`${origin}/api/daily-journals/${storedMemberJournal.id}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: sunseaAdmin.cookie },
      body: JSON.stringify({ decision: 'reject', comment: '' }),
    })
    assert.equal(missingJournalComment.status, 400)
    assert.equal((await missingJournalComment.json()).error.code, 'JOURNAL_COMMENT_REQUIRED')

    const rejectJournal = await fetch(`${origin}/api/daily-journals/${storedMemberJournal.id}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: sunseaAdmin.cookie },
      body: JSON.stringify({ decision: 'reject', comment: 'LOT 번호와 조치 결과를 보완해 주세요.' }),
    })
    const rejectedJournal = (await rejectJournal.json()).journal
    assert.equal(rejectJournal.status, 200)
    assert.equal(rejectedJournal.status, '반려')
    assert.match(rejectedJournal.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    assert.equal(rejectedJournal.reviews.length, 1)
    assert.equal(rejectedJournal.reviews[0].reviewerId, 'USR-SUNSEA-ADMIN')

    const resubmitJournal = await fetch(`${origin}/api/workspace/daily-journals`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: memberLogin.cookie },
      body: JSON.stringify({ data: [{ ...rejectedJournal, status: '결재요청', completed: '원료 계량 완료 · LOT 번호와 조치 결과 보완' }] }),
    })
    assert.equal(resubmitJournal.status, 200)

    const approveJournal = await fetch(`${origin}/api/daily-journals/${storedMemberJournal.id}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: sunseaAdmin.cookie },
      body: JSON.stringify({ decision: 'approve', comment: '보완된 LOT 기록과 조치 결과를 확인했습니다.' }),
    })
    assert.equal(approveJournal.status, 200)
    const approvedJournal = (await approveJournal.json()).journal
    assert.equal(approvedJournal.status, '승인')
    assert.match(approvedJournal.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    assert.deepEqual(approvedJournal.reviews.map((review) => review.decision), ['반려', '승인'])

    const adminJournalRead = await fetch(`${origin}/api/workspace/daily-journals`, { headers: { cookie: sunseaAdmin.cookie } })
    const adminJournals = (await adminJournalRead.json()).data
    assert.equal(adminJournals.length, 2)
    assert.equal(adminJournals.find((journal) => journal.id === storedMemberJournal.id).reviews.length, 2)

    const assignedTask = {
      id: 'WK-MEMBER-01', title: '원료 계량 확인', description: '작업표 기준으로 계량합니다.',
      owner: '이민수', requestedBy: '김서원', due: '오늘 17:00', priority: '높음',
      status: '업무요청', category: '생산', ownerId: member.account.id, requesterId: 'USR-SUNSEA-ADMIN',
    }
    const unrelatedTask = {
      ...assignedTask,
      id: 'WK-ADMIN-ONLY',
      title: '경영회의 자료 확인',
      owner: '김서원',
      requestedBy: '박지현',
      ownerId: 'USR-SUNSEA-ADMIN',
      requesterId: 'USR-SUNSEA-PARK',
    }
    const seedTask = await fetch(`${origin}/api/workspace/work-items`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: sunseaAdmin.cookie },
      body: JSON.stringify({ data: [assignedTask, unrelatedTask] }),
    })
    assert.equal(seedTask.status, 200)

    const memberTaskRead = await fetch(`${origin}/api/workspace/work-items`, { headers: { cookie: memberLogin.cookie } })
    assert.deepEqual((await memberTaskRead.json()).data, [assignedTask])

    const acceptTask = await fetch(`${origin}/api/workspace/work-items`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: memberLogin.cookie },
      body: JSON.stringify({ data: [{ ...assignedTask, status: '수행중' }] }),
    })
    assert.equal(acceptTask.status, 200)

    const adminTaskRead = await fetch(`${origin}/api/workspace/work-items`, { headers: { cookie: sunseaAdmin.cookie } })
    const adminTasks = (await adminTaskRead.json()).data
    assert.equal(adminTasks.length, 2)
    assert.equal(adminTasks.find((item) => item.id === assignedTask.id).status, '수행중')
    assert.deepEqual(adminTasks.find((item) => item.id === unrelatedTask.id), unrelatedTask)

    const tamperTask = await fetch(`${origin}/api/workspace/work-items`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: memberLogin.cookie },
      body: JSON.stringify({ data: [{ ...assignedTask, title: '관리자 지시 조작', status: '수행중' }] }),
    })
    assert.equal(tamperTask.status, 403)
    assert.equal((await tamperTask.json()).error.code, 'WORK_ITEM_TRANSITION_FORBIDDEN')

    const addTask = await fetch(`${origin}/api/workspace/work-items`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: memberLogin.cookie },
      body: JSON.stringify({ data: [{ ...assignedTask, status: '수행중' }, { ...assignedTask, id: 'WK-FORGED' }] }),
    })
    assert.equal(addTask.status, 403)

    const seedOtherLeave = await fetch(`${origin}/api/workspace/leave-requests`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: sunseaAdmin.cookie },
      body: JSON.stringify({ data: [{ id: 'LV-OTHER', name: '다른 직원', team: '물류팀', type: '연차', period: '8월 25일', days: 1, reason: '개인 일정', status: '결재대기' }] }),
    })
    assert.equal(seedOtherLeave.status, 200)

    const privateLeaveRead = await fetch(`${origin}/api/workspace/leave-requests`, { headers: { cookie: memberLogin.cookie } })
    assert.deepEqual((await privateLeaveRead.json()).data, [])

    const leaveResponse = await fetch(`${origin}/api/leave-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: memberLogin.cookie },
      body: JSON.stringify({ type: '연차', period: '8월 27일', days: 1, reason: '개인 일정' }),
    })
    const leave = await leaveResponse.json()
    assert.equal(leaveResponse.status, 201)
    assert.equal(leave.leave.name, '이민수')
    assert.equal(leave.leave.status, '결재대기')

    const overwriteLeave = await fetch(`${origin}/api/workspace/leave-requests`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: memberLogin.cookie },
      body: JSON.stringify({ data: [{ ...leave.leave, status: '승인' }] }),
    })
    assert.equal(overwriteLeave.status, 403)

    const scopedLeaveRead = await fetch(`${origin}/api/workspace/leave-requests`, { headers: { cookie: memberLogin.cookie } })
    const scopedLeaves = (await scopedLeaveRead.json()).data
    assert.equal(scopedLeaves.length, 1)
    assert.equal(scopedLeaves[0].requesterId, member.account.id)

    const seedLeaveManagement = await fetch(`${origin}/api/workspace/leave-management`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: sunseaAdmin.cookie },
      body: JSON.stringify({ data: {
        policy: { mode: 'yearly', annualDays: 15, monthlyDays: 1, carryOverLimit: 0, renewalDate: '01-01' },
        balances: [{ name: '이민수', team: '생산 1팀', total: 15, used: 0, updatedAt: '2026-08-19' }],
        ledger: [],
      } }),
    })
    assert.equal(seedLeaveManagement.status, 200)

    const leaveDecision = await fetch(`${origin}/api/leave-requests/${leave.leave.id}/decision`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: sunseaAdmin.cookie },
      body: JSON.stringify({ decision: 'approve' }),
    })
    assert.equal(leaveDecision.status, 200)
    const leaveDecisionBody = await leaveDecision.json()
    assert.equal(leaveDecisionBody.leave.status, '승인')
    assert.equal(leaveDecisionBody.leaveManagement.balances[0].used, 1)
    assert.equal(leaveDecisionBody.leaveManagement.ledger[0].type, '사용')

    const memberLeaveManagement = await fetch(`${origin}/api/workspace/leave-management`, { headers: { cookie: memberLogin.cookie } })
    const memberLeaveLedger = (await memberLeaveManagement.json()).data
    assert.equal(memberLeaveManagement.status, 200)
    assert.deepEqual(memberLeaveLedger.balances.map((balance) => balance.name), ['이민수'])
    assert.equal(memberLeaveLedger.balances[0].used, 1)
    assert.deepEqual(memberLeaveLedger.ledger.map((entry) => entry.type), ['사용'])

    const approverResponse = await fetch(`${origin}/api/leave-approvers`, { headers: { cookie: memberLogin.cookie } })
    const approverBody = await approverResponse.json()
    assert.equal(approverResponse.status, 200)
    assert.deepEqual(approverBody.approvers.map((approver) => approver.id), ['USR-SUNSEA-ADMIN'])

    const weekendOnlyLeave = await fetch(`${origin}/api/leave-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: memberLogin.cookie },
      body: JSON.stringify({ type: '연차', startDate: '2026-08-29', endDate: '2026-08-30', approverId: 'USR-SUNSEA-ADMIN', reason: '주말 신청 검증' }),
    })
    assert.equal(weekendOnlyLeave.status, 400)

    const rangeLeaveResponse = await fetch(`${origin}/api/leave-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: memberLogin.cookie },
      body: JSON.stringify({ type: '연차', startDate: '2026-08-27', endDate: '2026-08-31', approverId: 'USR-SUNSEA-ADMIN', reason: '가족 일정' }),
    })
    const rangeLeave = await rangeLeaveResponse.json()
    assert.equal(rangeLeaveResponse.status, 201)
    assert.equal(rangeLeave.leave.days, 3)
    assert.equal(rangeLeave.leave.period, '2026-08-27 ~ 2026-08-31')
    assert.equal(rangeLeave.leave.approverName, '김서원')
    assert.equal(rangeLeave.leave.calendarVisibility, 'pending')

    const rangeDecision = await fetch(`${origin}/api/leave-requests/${rangeLeave.leave.id}/decision`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: sunseaAdmin.cookie },
      body: JSON.stringify({ decision: 'approve' }),
    })
    const rangeDecisionBody = await rangeDecision.json()
    assert.equal(rangeDecision.status, 200)
    assert.equal(rangeDecisionBody.leave.calendarVisibility, 'company')
    assert.equal(rangeDecisionBody.leave.decidedById, 'USR-SUNSEA-ADMIN')
    assert.equal(rangeDecisionBody.leaveManagement.balances[0].used, 4)

    const factoryBlock = {
      id: 'BLOCK-TEST-01', factoryId: 'FAC-TEST-01', zoneId: 'production', name: '생산 테스트 블록',
      purpose: '생산', kind: '생산', x: 5, y: 5, width: 30, height: 30, color: '#e8eee9',
      item: '테스트 설비', current: 1, capacity: 10, unit: '라인', note: '좌표 검증',
    }
    const validFactoryLayout = await fetch(`${origin}/api/workspace/factory-layouts`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: sunseaAdmin.cookie },
      body: JSON.stringify({ data: { 'FAC-TEST-01': [factoryBlock] } }),
    })
    assert.equal(validFactoryLayout.status, 200)

    const collidingFactoryLayout = await fetch(`${origin}/api/workspace/factory-layouts`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: sunseaAdmin.cookie },
      body: JSON.stringify({ data: { 'FAC-TEST-01': [factoryBlock, { ...factoryBlock, id: 'BLOCK-TEST-02', x: 20, y: 20 }] } }),
    })
    assert.equal(collidingFactoryLayout.status, 400)
    assert.equal((await collidingFactoryLayout.json()).error.code, 'INVALID_FACTORY_LAYOUTS')

    const outOfBoundsFactoryLayout = await fetch(`${origin}/api/workspace/factory-layouts`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: sunseaAdmin.cookie },
      body: JSON.stringify({ data: { 'FAC-TEST-01': [{ ...factoryBlock, x: 85, width: 30 }] } }),
    })
    assert.equal(outOfBoundsFactoryLayout.status, 400)

    const sunseaCalendar = await fetch(`${origin}/api/workspace/calendar-events`, { headers: { cookie: memberLogin.cookie, 'x-tenant-id': 'TENANT-POHANG' } })
    assert.deepEqual((await sunseaCalendar.json()).data.map((event) => event.id), ['EV-COMPANY', 'EV-PRODUCTION'])

    const pohangEvent = { id: 'POHANG-ONLY', title: '조합 공동 일정', date: '2026-08-21', start: '13:00', end: '14:00', scope: 'company', department: '전사', location: '조합 회의실', owner: '박해진', note: '' }
    const pohangCalendarWrite = await fetch(`${origin}/api/workspace/calendar-events`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: pohangAdmin.cookie },
      body: JSON.stringify({ data: [pohangEvent] }),
    })
    assert.equal(pohangCalendarWrite.status, 200)
    const pohangCalendar = await fetch(`${origin}/api/workspace/calendar-events`, { headers: { cookie: pohangAdmin.cookie } })
    assert.deepEqual((await pohangCalendar.json()).data, [pohangEvent])
    const sunseaCalendarAgain = await fetch(`${origin}/api/workspace/calendar-events`, { headers: { cookie: memberLogin.cookie } })
    assert.deepEqual((await sunseaCalendarAgain.json()).data.map((event) => event.id), ['EV-COMPANY', 'EV-PRODUCTION'])
  })
})

test('invited account credentials survive restart, reissue invalidates old access and plaintext is never stored', async () => {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'onfactory-onboarding-'))
  const storeFile = path.join(temporaryDirectory, 'workspace-state.json')
  let accountId = ''
  let firstTemporaryPassword = ''
  let expiredReplacementPassword = ''
  let secondTemporaryPassword = ''
  try {
    await withServer(createApp({ apiKey: '', workspaceStoreFile: storeFile }), async (origin) => {
      const admin = await login(origin, 'admin@sunsea.co.kr')
      const invite = await fetch(`${origin}/api/admin/accounts/invite`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie: admin.cookie },
        body: JSON.stringify({ name: '정하늘', email: 'haneul@sunsea.co.kr', team: '품질관리', role: '품질 담당' }),
      })
      const invited = await invite.json()
      accountId = invited.account.id
      const approval = await fetch(`${origin}/api/admin/accounts/${accountId}/decision`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie: admin.cookie }, body: JSON.stringify({ decision: 'approve' }),
      })
      firstTemporaryPassword = (await approval.json()).onboarding.temporaryPassword
      assert.equal(approval.status, 200)
      const persisted = readFileSync(storeFile, 'utf8')
      assert.equal(persisted.includes(firstTemporaryPassword), false)
      assert.equal(persisted.includes('demo1234'), false)
      assert.match(JSON.parse(persisted).accountCredentials[accountId].passwordHash, /^[0-9a-f]{64}$/)
    })

    const expiredStore = JSON.parse(readFileSync(storeFile, 'utf8'))
    expiredStore.accountCredentials[accountId].temporaryPasswordExpiresAt = '2000-01-01T00:00:00.000Z'
    writeFileSync(storeFile, JSON.stringify(expiredStore, null, 2))

    await withServer(createApp({ apiKey: '', workspaceStoreFile: storeFile }), async (origin) => {
      const expiredLogin = await login(origin, 'haneul@sunsea.co.kr', 'tenant', firstTemporaryPassword)
      assert.equal(expiredLogin.response.status, 403)
      assert.equal((await expiredLogin.response.json()).error.code, 'TEMPORARY_PASSWORD_EXPIRED')
      const admin = await login(origin, 'admin@sunsea.co.kr')
      const accountList = await fetch(`${origin}/api/admin/accounts`, { headers: { cookie: admin.cookie } })
      assert.equal((await accountList.json()).accounts.find((account) => account.id === accountId).onboardingStatus, '초기암호만료')
      const replaceExpired = await fetch(`${origin}/api/admin/accounts/${accountId}/onboarding-credential`, { method: 'POST', headers: { cookie: admin.cookie } })
      expiredReplacementPassword = (await replaceExpired.json()).onboarding.temporaryPassword
      assert.equal(replaceExpired.status, 200)

      const member = await login(origin, 'haneul@sunsea.co.kr', 'tenant', expiredReplacementPassword)
      assert.equal(member.response.status, 200)
      assert.equal((await member.response.json()).account.requiresPasswordChange, true)
      const changed = await fetch(`${origin}/api/auth/password/change`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie: member.cookie }, body: JSON.stringify({ newPassword: 'Quality!Secure2026' }),
      })
      assert.equal(changed.status, 200)
      const reissued = await fetch(`${origin}/api/admin/accounts/${accountId}/onboarding-credential`, { method: 'POST', headers: { cookie: admin.cookie } })
      const reissueBody = await reissued.json()
      secondTemporaryPassword = reissueBody.onboarding.temporaryPassword
      assert.equal(reissued.status, 200)
      assert.notEqual(secondTemporaryPassword, firstTemporaryPassword)
      assert.equal((await login(origin, 'haneul@sunsea.co.kr', 'tenant', 'Quality!Secure2026')).response.status, 401)
      const secondInitialLogin = await login(origin, 'haneul@sunsea.co.kr', 'tenant', secondTemporaryPassword)
      assert.equal(secondInitialLogin.response.status, 200)
      const finalChange = await fetch(`${origin}/api/auth/password/change`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie: secondInitialLogin.cookie }, body: JSON.stringify({ newPassword: 'Final!Secure2027' }),
      })
      assert.equal(finalChange.status, 200)
    })

    await withServer(createApp({ apiKey: '', workspaceStoreFile: storeFile }), async (origin) => {
      assert.equal((await login(origin, 'haneul@sunsea.co.kr', 'tenant', secondTemporaryPassword)).response.status, 401)
      assert.equal((await login(origin, 'haneul@sunsea.co.kr', 'tenant', 'Final!Secure2027')).response.status, 200)
      const persisted = readFileSync(storeFile, 'utf8')
      assert.equal(persisted.includes(firstTemporaryPassword), false)
      assert.equal(persisted.includes(secondTemporaryPassword), false)
      assert.equal(persisted.includes('Final!Secure2027'), false)
    })
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

test('work-item authorization uses account IDs and never a duplicated display name', async () => {
  await withServer(createApp({ apiKey: '' }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    assert.equal(admin.response.status, 200)

    const createDuplicateAccount = async (email) => {
      const inviteResponse = await fetch(`${origin}/api/admin/accounts/invite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: admin.cookie },
        body: JSON.stringify({ name: '김동명', email, team: '생산 1팀', role: '생산 작업자' }),
      })
      const invite = await inviteResponse.json()
      assert.equal(inviteResponse.status, 201)
      const approval = await fetch(`${origin}/api/admin/accounts/${invite.account.id}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: admin.cookie },
        body: JSON.stringify({ decision: 'approve' }),
      })
      assert.equal(approval.status, 200)
      const approved = await approval.json()
      const signedIn = await login(origin, email, 'tenant', approved.onboarding.temporaryPassword)
      assert.equal(signedIn.response.status, 200)
      const changed = await fetch(`${origin}/api/auth/password/change`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie: signedIn.cookie }, body: JSON.stringify({ newPassword: 'Namesake!Secure2026' }),
      })
      assert.equal(changed.status, 200)
      return { id: invite.account.id, cookie: signedIn.cookie }
    }

    const first = await createDuplicateAccount('same-name-1@sunsea.co.kr')
    const second = await createDuplicateAccount('same-name-2@sunsea.co.kr')
    assert.notEqual(first.id, second.id)

    const firstTask = {
      id: 'WK-SAME-NAME-1', title: '1호 계정 담당 업무', description: '동명이인 1호에게만 배정',
      owner: '김동명', ownerId: first.id, requestedBy: '김서원', requesterId: 'USR-SUNSEA-ADMIN',
      due: '오늘 15:00', priority: '높음', status: '업무요청', category: '생산',
    }
    const secondTask = {
      ...firstTask,
      id: 'WK-SAME-NAME-2',
      title: '2호 계정 담당 업무',
      description: '동명이인 2호에게만 배정',
      ownerId: second.id,
    }
    const secondRequestedTask = {
      ...firstTask,
      id: 'WK-SAME-NAME-REQUESTER-2',
      title: '2호 계정 결재 업무',
      description: '동명이인 2호만 요청자 권한 보유',
      owner: '김서원',
      ownerId: 'USR-SUNSEA-ADMIN',
      requestedBy: '김동명',
      requesterId: second.id,
      status: '결재대기',
    }
    const ambiguousLegacyTask = {
      id: 'WK-SAME-NAME-LEGACY', title: '동명이인 미지정 레거시 업무', description: '계정 ID가 없어 자동 귀속하면 안 됨',
      owner: '김동명', requestedBy: '김서원', due: '오늘 18:00', priority: '보통', status: '업무요청', category: '생산',
    }
    const seed = await fetch(`${origin}/api/workspace/work-items`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ data: [firstTask, secondTask, secondRequestedTask, ambiguousLegacyTask] }),
    })
    assert.equal(seed.status, 200)

    const firstRead = await fetch(`${origin}/api/workspace/work-items`, { headers: { cookie: first.cookie } })
    const firstItems = (await firstRead.json()).data
    assert.deepEqual(firstItems.map((item) => item.id), [firstTask.id])
    assert.equal(firstItems[0].ownerId, first.id)

    const secondRead = await fetch(`${origin}/api/workspace/work-items`, { headers: { cookie: second.cookie } })
    const secondItems = (await secondRead.json()).data
    assert.deepEqual(secondItems.map((item) => item.id), [secondTask.id, secondRequestedTask.id])
    assert.equal(secondItems[0].ownerId, second.id)
    assert.equal(secondItems[1].requesterId, second.id)

    const acceptOwn = await fetch(`${origin}/api/workspace/work-items`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: first.cookie },
      body: JSON.stringify({ data: [{ ...firstItems[0], status: '수행중' }] }),
    })
    assert.equal(acceptOwn.status, 200)

    const transitionNamesakeTask = await fetch(`${origin}/api/workspace/work-items`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: first.cookie },
      body: JSON.stringify({ data: [{ ...secondTask, status: '수행중' }] }),
    })
    assert.equal(transitionNamesakeTask.status, 403)
    assert.equal((await transitionNamesakeTask.json()).error.code, 'WORK_ITEM_TRANSITION_FORBIDDEN')

    const stealByChangingId = await fetch(`${origin}/api/workspace/work-items`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: first.cookie },
      body: JSON.stringify({ data: [{ ...firstItems[0], ownerId: second.id, status: '수행중' }] }),
    })
    assert.equal(stealByChangingId.status, 403)

    const approveOwnRequest = await fetch(`${origin}/api/work-items/${secondRequestedTask.id}/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: second.cookie },
      body: JSON.stringify({ action: 'approve', review: { comment: '요청한 업무 결과를 확인했습니다.' } }),
    })
    assert.equal(approveOwnRequest.status, 200)

    const adminRead = await fetch(`${origin}/api/workspace/work-items`, { headers: { cookie: admin.cookie } })
    const allItems = (await adminRead.json()).data
    assert.equal(allItems.find((item) => item.id === firstTask.id).status, '수행중')
    assert.equal(allItems.find((item) => item.id === secondTask.id).status, '업무요청')
    assert.equal(allItems.find((item) => item.id === secondRequestedTask.id).status, '결재완료')
    const legacy = allItems.find((item) => item.id === ambiguousLegacyTask.id)
    assert.equal(legacy.ownerId, undefined)
    assert.equal(legacy.requesterId, 'USR-SUNSEA-ADMIN')
  })
})

test('audited work transitions and recurring rules enforce evidence, comments and calendar schedules', async () => {
  await withServer(createApp({ apiKey: '' }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const owner = await login(origin, 'jihyun.park@sunsea.co.kr')
    const unrelated = await login(origin, 'taesik.oh@sunsea.co.kr')
    assert.equal(admin.response.status, 200)
    assert.equal(owner.response.status, 200)
    assert.equal(unrelated.response.status, 200)

    const task = {
      id: 'WK-AUDIT-FLOW', title: 'HACCP 점검 결과 제출', description: '점검표와 보완 결과를 결재 요청합니다.',
      owner: '박지현', ownerId: 'USR-SUNSEA-PARK', requestedBy: '김서원', requesterId: 'USR-SUNSEA-ADMIN',
      due: '오늘 17:00', priority: '높음', status: '업무요청', category: '품질',
    }
    const seed = await fetch(`${origin}/api/workspace/work-items`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie: admin.cookie }, body: JSON.stringify({ data: [task] }),
    })
    assert.equal(seed.status, 200)

    const unrelatedAccept = await fetch(`${origin}/api/work-items/${task.id}/transition`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: unrelated.cookie }, body: JSON.stringify({ action: 'accept' }),
    })
    assert.equal(unrelatedAccept.status, 403)

    const accept = await fetch(`${origin}/api/work-items/${task.id}/transition`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: owner.cookie }, body: JSON.stringify({ action: 'accept' }),
    })
    assert.equal(accept.status, 200)
    const accepted = (await accept.json()).item
    assert.equal(accepted.status, '수행중')

    const wholeArraySubmissionBypass = await fetch(`${origin}/api/workspace/work-items`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie: owner.cookie },
      body: JSON.stringify({ data: [{ ...accepted, status: '결재대기' }] }),
    })
    assert.equal(wholeArraySubmissionBypass.status, 403)

    const missingCompletion = await fetch(`${origin}/api/work-items/${task.id}/transition`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: owner.cookie },
      body: JSON.stringify({ action: 'submit', completion: { summary: '', evidence: [] } }),
    })
    assert.equal(missingCompletion.status, 400)
    assert.equal((await missingCompletion.json()).error.code, 'INVALID_COMPLETION')

    const submit = await fetch(`${origin}/api/work-items/${task.id}/transition`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: owner.cookie },
      body: JSON.stringify({ action: 'submit', completion: { summary: '점검표 확인과 보완 조치를 완료했습니다.', evidence: [{ id: 'EV-1', name: 'HACCP_점검표.pdf', size: '320 KB', type: 'application/pdf' }] } }),
    })
    assert.equal(submit.status, 200)
    const submitted = (await submit.json()).item
    assert.equal(submitted.status, '결재대기')
    assert.equal(submitted.completion.submittedById, 'USR-SUNSEA-PARK')
    assert.equal(submitted.completion.evidence[0].name, 'HACCP_점검표.pdf')

    const missingCorrectionDetails = await fetch(`${origin}/api/work-items/${task.id}/transition`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ action: 'request-changes', review: { comment: '보완 필요' } }),
    })
    assert.equal(missingCorrectionDetails.status, 400)

    const correction = await fetch(`${origin}/api/work-items/${task.id}/transition`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ action: 'request-changes', review: { comment: '사진에서 측정값이 보이지 않습니다.', requestedChanges: '측정값이 보이는 현장 사진을 추가해 주세요.' } }),
    })
    assert.equal(correction.status, 200)
    assert.equal((await correction.json()).item.status, '수행중')

    const resubmit = await fetch(`${origin}/api/work-items/${task.id}/transition`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: owner.cookie },
      body: JSON.stringify({ action: 'submit', completion: { summary: '측정값이 보이는 현장 사진까지 보완했습니다.', evidence: [{ id: 'EV-2', name: '측정값_현장사진.jpg', size: '1.2 MB', type: 'image/jpeg' }] } }),
    })
    assert.equal(resubmit.status, 200)

    const missingApprovalComment = await fetch(`${origin}/api/work-items/${task.id}/transition`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ action: 'approve', review: { comment: '' } }),
    })
    assert.equal(missingApprovalComment.status, 400)

    const approve = await fetch(`${origin}/api/work-items/${task.id}/transition`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ action: 'approve', review: { comment: '보완 사진과 측정값을 확인했습니다.' } }),
    })
    assert.equal(approve.status, 200)
    const approved = (await approve.json()).item
    assert.equal(approved.status, '결재완료')
    assert.equal(approved.review.decision, 'approved')
    assert.equal(approved.review.reviewerId, 'USR-SUNSEA-ADMIN')

    const todayParts = Object.fromEntries(new Intl.DateTimeFormat('en', {
      timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date()).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
    const today = `${todayParts.year}-${todayParts.month}-${todayParts.day}`
    const todayWeekday = new Date(`${today}T00:00:00Z`).getUTCDay()
    const weeklyResponse = await fetch(`${origin}/api/work-rules`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({
        title: '주간 품질 점검', description: '매주 지정 요일에 품질 기록을 확인합니다.', ownerId: 'USR-SUNSEA-PARK',
        frequency: 'weekly', interval: 1, weekday: todayWeekday, startDate: today, dueTime: '16:00', priority: '높음', category: '품질',
      }),
    })
    const weekly = await weeklyResponse.json()
    assert.equal(weeklyResponse.status, 201)
    assert.equal(weekly.rule.weekday, todayWeekday)
    assert.ok(weekly.rule.nextRun > today)
    assert.equal(weekly.created.length, 1)
    assert.equal(weekly.created[0].ruleOccurrence, today)

    const materializeAgain = await fetch(`${origin}/api/work-rules/materialize`, { method: 'POST', headers: { cookie: admin.cookie } })
    assert.equal(materializeAgain.status, 200)
    assert.equal((await materializeAgain.json()).created.length, 0)

    const monthlyResponse = await fetch(`${origin}/api/work-rules`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({
        title: '월말 안전 점검', description: '매월 마지막 주 월요일에 안전 기록을 확인합니다.', ownerId: 'USR-SUNSEA-PARK',
        frequency: 'monthly', interval: 1, monthlyMode: 'last-weekday', weekday: 1, startDate: today, dueTime: '15:00', priority: '보통', category: '품질',
      }),
    })
    const monthly = await monthlyResponse.json()
    assert.equal(monthlyResponse.status, 201)
    assert.equal(monthly.rule.monthlyMode, 'last-weekday')
    assert.equal(monthly.rule.weekday, 1)
    const monthlyDate = new Date(`${monthly.rule.nextRun}T00:00:00Z`)
    assert.equal(monthlyDate.getUTCDay(), 1)
    const sevenDaysLater = new Date(monthlyDate)
    sevenDaysLater.setUTCDate(sevenDaysLater.getUTCDate() + 7)
    assert.notEqual(sevenDaysLater.getUTCMonth(), monthlyDate.getUTCMonth())
    assert.ok(monthly.rule.nextRun >= today)

    const invalidLastWeekday = await fetch(`${origin}/api/work-rules`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({
        title: '잘못된 월간 규칙', description: '허용되지 않는 요일입니다.', ownerId: 'USR-SUNSEA-PARK',
        frequency: 'monthly', interval: 1, monthlyMode: 'last-weekday', weekday: 9, startDate: today, dueTime: '15:00', priority: '보통', category: '품질',
      }),
    })
    assert.equal(invalidLastWeekday.status, 400)

    const memberRuleRead = await fetch(`${origin}/api/workspace/work-rules`, { headers: { cookie: owner.cookie } })
    assert.equal(memberRuleRead.status, 200)
    const visibleRules = (await memberRuleRead.json()).data
    assert.ok(visibleRules.some((rule) => rule.id === weekly.rule.id))
    const memberRuleOverwrite = await fetch(`${origin}/api/workspace/work-rules`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie: owner.cookie }, body: JSON.stringify({ data: visibleRules }),
    })
    assert.equal(memberRuleOverwrite.status, 403)
    const memberPause = await fetch(`${origin}/api/work-rules/${weekly.rule.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', cookie: owner.cookie }, body: JSON.stringify({ active: false }),
    })
    assert.equal(memberPause.status, 403)
    const pause = await fetch(`${origin}/api/work-rules/${weekly.rule.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', cookie: admin.cookie }, body: JSON.stringify({ active: false }),
    })
    assert.equal(pause.status, 200)
    assert.equal((await pause.json()).rule.active, false)
  })
})

test('legacy work items migrate only when a tenant account name resolves uniquely', async () => {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'onfactory-work-migration-'))
  const storeFile = path.join(temporaryDirectory, 'workspace-state.json')
  const legacyTask = {
    id: 'WK-LEGACY-UNIQUE', title: '레거시 품질 검토', description: '기존 이름 필드를 계정 ID로 안전하게 보강',
    owner: '박지현', requestedBy: '김서원', due: '오늘 16:00', priority: '높음', status: '업무요청', category: '품질',
  }
  writeFileSync(storeFile, JSON.stringify({
    version: 1,
    tenants: {
      'TENANT-SUNSEA': {
        'work-items': { data: [legacyTask], updatedAt: '2026-08-19T00:00:00.000Z', updatedBy: 'legacy' },
      },
    },
    accountApprovals: {}, invitedAccounts: [], passwordResetRequests: [],
  }))

  try {
    await withServer(createApp({ apiKey: '', workspaceStoreFile: storeFile }), async (origin) => {
      const park = await login(origin, 'jihyun.park@sunsea.co.kr')
      assert.equal(park.response.status, 200)
      const response = await fetch(`${origin}/api/workspace/work-items`, { headers: { cookie: park.cookie } })
      const items = (await response.json()).data
      assert.equal(items.length, 1)
      assert.equal(items[0].ownerId, 'USR-SUNSEA-PARK')
      assert.equal(items[0].requesterId, 'USR-SUNSEA-ADMIN')
    })

    const persisted = JSON.parse(readFileSync(storeFile, 'utf8'))
    const migrated = persisted.tenants['TENANT-SUNSEA']['work-items'].data[0]
    assert.equal(migrated.ownerId, 'USR-SUNSEA-PARK')
    assert.equal(migrated.requesterId, 'USR-SUNSEA-ADMIN')
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

test('product image data and sales shipments are validated and persisted per tenant', async () => {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'onfactory-commerce-'))
  const storeFile = path.join(temporaryDirectory, 'workspace-state.json')

  try {
    await withServer(createApp({ apiKey: '', workspaceStoreFile: storeFile }), async (origin) => {
      const admin = await login(origin, 'admin@sunsea.co.kr')
      const member = await login(origin, 'taesik.oh@sunsea.co.kr')
      assert.equal(admin.response.status, 200)
      assert.equal(member.response.status, 200)

      const imageDataUrl = 'data:image/png;base64,iVBORw0KGgo='
      const catalog = [{
        id: 'PRD-TEST', code: 'FG-TEST-001', name: '테스트 제품', shortName: '테스트', category: '기타',
        specification: '100g', price: 1000, stock: 10, available: 8, safetyStock: 2, storage: '실온',
        labelStatus: '검토중', status: '정상', channels: 0, visual: 1, fact: {}, imageDataUrl, imageFileName: 'product.png',
      }]
      const saveCatalog = await fetch(`${origin}/api/workspace/product-catalog`, {
        method: 'PUT', headers: { 'content-type': 'application/json', cookie: admin.cookie }, body: JSON.stringify({ data: catalog }),
      })
      assert.equal(saveCatalog.status, 200)
      const catalogRead = await fetch(`${origin}/api/workspace/product-catalog`, { headers: { cookie: admin.cookie } })
      assert.equal((await catalogRead.json()).data[0].imageDataUrl, imageDataUrl)

      const invalidCatalog = await fetch(`${origin}/api/workspace/product-catalog`, {
        method: 'PUT', headers: { 'content-type': 'application/json', cookie: admin.cookie },
        body: JSON.stringify({ data: [{ ...catalog[0], imageDataUrl: 'blob:http://localhost/transient' }] }),
      })
      assert.equal(invalidCatalog.status, 400)
      assert.equal((await invalidCatalog.json()).error.code, 'INVALID_PRODUCT_CATALOG')

      const shipment = {
        id: 'SHIP-TEST', orderNo: 'ORDER-001', channelId: 'naver', channelName: '네이버 스마트스토어',
        recipient: '홍길동', phone: '010-0000-0000', address: '경북 포항시', productName: '테스트 제품', quantity: 1,
        courier: 'CJ대한통운', trackingNo: '123456789012', status: '송장등록', orderedAt: '2026-08-20 10:00',
      }
      const saveShipment = await fetch(`${origin}/api/workspace/sales-shipments`, {
        method: 'PUT', headers: { 'content-type': 'application/json', cookie: admin.cookie }, body: JSON.stringify({ data: [shipment] }),
      })
      assert.equal(saveShipment.status, 200)
      const shipmentRead = await fetch(`${origin}/api/workspace/sales-shipments`, { headers: { cookie: admin.cookie } })
      assert.equal((await shipmentRead.json()).data[0].trackingNo, shipment.trackingNo)

      const invalidShipment = await fetch(`${origin}/api/workspace/sales-shipments`, {
        method: 'PUT', headers: { 'content-type': 'application/json', cookie: admin.cookie },
        body: JSON.stringify({ data: [{ ...shipment, trackingNo: 'bad number!' }] }),
      })
      assert.equal(invalidShipment.status, 400)
      assert.equal((await invalidShipment.json()).error.code, 'INVALID_SALES_SHIPMENTS')

      const memberShipmentRead = await fetch(`${origin}/api/workspace/sales-shipments`, { headers: { cookie: member.cookie } })
      assert.equal(memberShipmentRead.status, 403)
    })
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

test('sales channel health checks enforce tenant admin scope and report missing server credentials honestly', async () => {
  await withServer(createApp({ apiKey: '' }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const member = await login(origin, 'taesik.oh@sunsea.co.kr')
    const otherTenant = await login(origin, 'admin@pohangcoop.co.kr')
    assert.equal(admin.response.status, 200)
    const channels = [
      { id: 'naver-missing', name: '네이버 스마트스토어', connectionStatus: 'setup-required' },
      { id: 'coupang-hinted', name: '쿠팡', connectionStatus: 'test-pending', credentialHint: '•••• 1234', credentialFields: { vendorId: 'A001' } },
    ]
    const seed = await fetch(`${origin}/api/workspace/sales-channels`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie: admin.cookie }, body: JSON.stringify({ data: channels }),
    })
    assert.equal(seed.status, 200)

    const anonymous = await fetch(`${origin}/api/sales-channels/coupang-hinted/health`)
    assert.equal(anonymous.status, 401)
    const memberCheck = await fetch(`${origin}/api/sales-channels/coupang-hinted/health`, { headers: { cookie: member.cookie } })
    assert.equal(memberCheck.status, 403)
    assert.equal((await memberCheck.json()).error.code, 'TENANT_ADMIN_REQUIRED')
    const staleWorkspace = await fetch(`${origin}/api/sales-channels/coupang-hinted/health`, {
      headers: { cookie: admin.cookie, 'x-workspace-identity': 'TENANT-SUNSEA:USR-SUNSEA-OH' },
    })
    assert.equal(staleWorkspace.status, 401)
    assert.equal((await staleWorkspace.json()).error.code, 'WORKSPACE_IDENTITY_MISMATCH')

    const missingChannel = await fetch(`${origin}/api/sales-channels/not-registered/health`, { headers: { cookie: admin.cookie } })
    assert.equal(missingChannel.status, 404)
    assert.equal((await missingChannel.json()).error.code, 'SALES_CHANNEL_NOT_FOUND')
    const crossTenant = await fetch(`${origin}/api/sales-channels/coupang-hinted/health`, { headers: { cookie: otherTenant.cookie } })
    assert.equal(crossTenant.status, 404)

    const missingCredentials = await fetch(`${origin}/api/sales-channels/naver-missing/health`, { headers: { cookie: admin.cookie } })
    const missingCredentialsBody = await missingCredentials.json()
    assert.equal(missingCredentials.status, 422)
    assert.equal(missingCredentialsBody.error.code, 'SALES_CHANNEL_CREDENTIALS_REQUIRED')
    assert.equal(missingCredentialsBody.mappedProducts, 0)
    assert.ok(missingCredentialsBody.checkedAt)

    const missingVault = await fetch(`${origin}/api/sales-channels/coupang-hinted/health`, {
      headers: { cookie: admin.cookie, 'x-workspace-identity': 'TENANT-SUNSEA:USR-SUNSEA-ADMIN' },
    })
    const missingVaultBody = await missingVault.json()
    assert.equal(missingVault.status, 424)
    assert.equal(missingVaultBody.error.code, 'SALES_CHANNEL_SECRET_UNAVAILABLE')
    assert.deepEqual(Object.keys(missingVaultBody).sort(), ['checkedAt', 'error', 'mappedProducts', 'mappingIssues', 'message'])
    assert.equal(JSON.stringify(missingVaultBody).includes('1234'), false)
    assert.equal(JSON.stringify(missingVaultBody).includes('A001'), false)
  })
})

test('sales channel health connector returns only whitelisted public results', async () => {
  let connectorContext
  const salesChannelHealthCheck = async (context) => {
    connectorContext = context
    return {
      secretAvailable: true,
      message: '쿠팡 API 정상',
      mappedProducts: 128,
      mappingIssues: 2,
      checkedAt: '2026-08-20T08:30:00.000Z',
      accessToken: 'must-never-leak',
      credentialHint: '•••• 9999',
    }
  }
  await withServer(createApp({ apiKey: '', salesChannelHealthCheck }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const seed = await fetch(`${origin}/api/workspace/sales-channels`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ data: [{
        id: 'coupang', name: '쿠팡', connectionStatus: 'test-pending', sellerAccount: 'A-SUNSEA',
        credentialHint: '•••• 4321', credentialFields: { vendorId: 'V-SUNSEA', secretKey: 'stored-in-wrong-place' },
      }] }),
    })
    assert.equal(seed.status, 200)
    const health = await fetch(`${origin}/api/sales-channels/coupang/health`, { headers: { cookie: admin.cookie } })
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), {
      message: '쿠팡 API 정상', mappedProducts: 128, mappingIssues: 2, checkedAt: '2026-08-20T08:30:00.000Z',
    })
    assert.equal(connectorContext.tenantId, 'TENANT-SUNSEA')
    assert.equal(connectorContext.channelId, 'coupang')
    assert.equal(connectorContext.requestedById, 'USR-SUNSEA-ADMIN')
    assert.equal(connectorContext.signal instanceof AbortSignal, true)
    assert.deepEqual(Object.keys(connectorContext.channel).sort(), ['connectionStatus', 'id', 'name', 'sellerAccount'])
    assert.equal(JSON.stringify(connectorContext).includes('4321'), false)
    assert.equal(JSON.stringify(connectorContext).includes('stored-in-wrong-place'), false)
  })
})

test('sales channel health requires a channel secret contract, redacts connector text, and times out safely', async () => {
  const callback = async ({ channelId }) => {
    if (channelId === 'missing-secret') return { secretAvailable: false }
    return {
      secretAvailable: true,
      message: '정상 token=SECRET-LEAK authorization:Bearer-SECRET',
      mappedProducts: 4,
      mappingIssues: 0,
      checkedAt: 'not-a-timestamp',
    }
  }
  await withServer(createApp({ apiKey: '', salesChannelHealthCheck: callback }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const seed = await fetch(`${origin}/api/workspace/sales-channels`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ data: [
        { id: 'missing-secret', name: 'Secret 없음', credentialHint: '•••• 1111' },
        { id: 'unsafe-message', name: '응답 정화', credentialHint: '•••• 2222' },
      ] }),
    })
    assert.equal(seed.status, 200)
    const missing = await fetch(`${origin}/api/sales-channels/missing-secret/health`, { headers: { cookie: admin.cookie } })
    assert.equal(missing.status, 424)
    assert.equal((await missing.json()).error.code, 'SALES_CHANNEL_SECRET_UNAVAILABLE')

    const unsafe = await fetch(`${origin}/api/sales-channels/unsafe-message/health`, { headers: { cookie: admin.cookie } })
    const unsafeBody = await unsafe.json()
    assert.equal(unsafe.status, 200)
    assert.equal(JSON.stringify(unsafeBody).includes('SECRET-LEAK'), false)
    assert.equal(JSON.stringify(unsafeBody).includes('Bearer-SECRET'), false)
    assert.match(unsafeBody.message, /\[redacted\]/)
    assert.match(unsafeBody.checkedAt, /^\d{4}-\d{2}-\d{2}T/)
  })

  let aborted = false
  const hangingCallback = ({ signal }) => new Promise((resolve) => {
    signal.addEventListener('abort', () => {
      aborted = true
      resolve({ secretAvailable: true, mappedProducts: 0, mappingIssues: 0 })
    }, { once: true })
  })
  await withServer(createApp({ apiKey: '', salesChannelHealthCheck: hangingCallback, salesChannelHealthTimeoutMs: 20 }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    await fetch(`${origin}/api/workspace/sales-channels`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ data: [{ id: 'timeout', name: '지연 채널', credentialHint: '•••• 3333' }] }),
    })
    const timeout = await fetch(`${origin}/api/sales-channels/timeout/health`, { headers: { cookie: admin.cookie } })
    assert.equal(timeout.status, 504)
    assert.equal((await timeout.json()).error.code, 'SALES_CHANNEL_HEALTH_TIMEOUT')
    assert.equal(aborted, true)
  })
})

test('messenger direct rooms keep one conversation, record reads, and enforce leave/delete permissions while leave calendars stay private', async () => {
  await withServer(createApp({ apiKey: '' }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const member = await login(origin, 'taesik.oh@sunsea.co.kr')
    const otherTenant = await login(origin, 'admin@pohangcoop.co.kr')
    assert.equal(admin.response.status, 200)
    assert.equal(member.response.status, 200)

    const createDirect = await fetch(`${origin}/api/messenger/conversations/direct`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ participantId: 'USR-SUNSEA-OH' }),
    })
    const firstRoom = await createDirect.json()
    assert.equal(createDirect.status, 201)
    assert.equal(firstRoom.created, true)

    const openSameDirect = await fetch(`${origin}/api/messenger/conversations/direct`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ participantId: 'USR-SUNSEA-OH' }),
    })
    const sameRoom = await openSameDirect.json()
    assert.equal(openSameDirect.status, 200)
    assert.equal(sameRoom.created, false)
    assert.equal(sameRoom.conversation.id, firstRoom.conversation.id)

    const send = await fetch(`${origin}/api/messenger/conversations/${firstRoom.conversation.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ text: '생산 계획을 확인해 주세요.' }),
    })
    const sent = await send.json()
    assert.equal(send.status, 201)
    assert.deepEqual(sent.message.readBy, ['USR-SUNSEA-ADMIN'])

    const read = await fetch(`${origin}/api/messenger/conversations/${firstRoom.conversation.id}/read`, {
      method: 'POST', headers: { cookie: member.cookie },
    })
    const readRoom = await read.json()
    assert.equal(read.status, 200)
    assert.deepEqual(readRoom.conversation.messages.at(-1).readBy.sort(), ['USR-SUNSEA-ADMIN', 'USR-SUNSEA-OH'])

    const memberDelete = await fetch(`${origin}/api/messenger/conversations/${firstRoom.conversation.id}`, {
      method: 'DELETE', headers: { cookie: member.cookie },
    })
    assert.equal(memberDelete.status, 403)

    const leaveRoom = await fetch(`${origin}/api/messenger/conversations/${firstRoom.conversation.id}/leave`, {
      method: 'POST', headers: { cookie: member.cookie },
    })
    assert.equal(leaveRoom.status, 200)
    const roomsAfterLeave = await fetch(`${origin}/api/workspace/messenger-conversations`, { headers: { cookie: member.cookie } })
    assert.deepEqual((await roomsAfterLeave.json()).data, [])

    const reopenRoom = await fetch(`${origin}/api/messenger/conversations/direct`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: member.cookie },
      body: JSON.stringify({ participantId: 'USR-SUNSEA-ADMIN' }),
    })
    const reopened = await reopenRoom.json()
    assert.equal(reopenRoom.status, 201)
    assert.equal(reopened.created, true)
    assert.notEqual(reopened.conversation.id, firstRoom.conversation.id)
    assert.equal(reopened.conversation.generation, 2)
    assert.deepEqual(reopened.conversation.messages, [])
    assert.ok(reopened.closedConversationIds.includes(firstRoom.conversation.id))

    const closedRoomMessage = await fetch(`${origin}/api/messenger/conversations/${firstRoom.conversation.id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: admin.cookie }, body: JSON.stringify({ text: '종료된 방 쓰기 시도' }),
    })
    assert.equal(closedRoomMessage.status, 404)
    const closedRoomRead = await fetch(`${origin}/api/messenger/conversations/${firstRoom.conversation.id}/read`, {
      method: 'POST', headers: { cookie: admin.cookie },
    })
    assert.equal(closedRoomRead.status, 404)

    const activeRooms = await fetch(`${origin}/api/workspace/messenger-conversations`, { headers: { cookie: member.cookie } })
    assert.deepEqual((await activeRooms.json()).data.map((conversation) => conversation.id), [reopened.conversation.id])
    const rawAfterReopen = await fetch(`${origin}/api/workspace/messenger-conversations`, { headers: { cookie: admin.cookie } })
    const rawAfterReopenData = (await rawAfterReopen.json()).data
    assert.equal(rawAfterReopenData.find((conversation) => conversation.id === firstRoom.conversation.id).lifecycle, 'closed')
    assert.equal(rawAfterReopenData.filter((conversation) => conversation.lifecycle === 'active').length, 1)

    const sendFresh = await fetch(`${origin}/api/messenger/conversations/${reopened.conversation.id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: member.cookie }, body: JSON.stringify({ text: '새 대화에서 다시 시작합니다.' }),
    })
    assert.equal(sendFresh.status, 201)

    const approvedLeave = {
      id: 'LV-CALENDAR-PRIVATE', requesterId: 'USR-SUNSEA-OH', name: '오태식', team: '생산 1팀', type: '병가',
      period: '8월 24일 ~ 25일', startDate: '2026-08-24', endDate: '2026-08-25', days: 2,
      reason: '외부에 노출되면 안 되는 진료 정보', status: '승인', calendarVisibility: 'company',
    }
    const seedLeave = await fetch(`${origin}/api/workspace/leave-requests`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ data: [approvedLeave] }),
    })
    assert.equal(seedLeave.status, 200)
    const calendar = await fetch(`${origin}/api/calendar/approved-leaves`, { headers: { cookie: member.cookie } })
    const calendarBody = await calendar.json()
    assert.equal(calendar.status, 200)
    assert.deepEqual(calendarBody.events.map((event) => event.title), ['오태식 · 휴가', '오태식 · 휴가'])
    assert.deepEqual(calendarBody.events.map((event) => event.date), ['2026-08-24', '2026-08-25'])
    assert.equal(JSON.stringify(calendarBody).includes(approvedLeave.reason), false)
    assert.equal(JSON.stringify(calendarBody).includes(approvedLeave.type), false)

    const crossTenantCalendar = await fetch(`${origin}/api/calendar/approved-leaves`, { headers: { cookie: otherTenant.cookie } })
    assert.deepEqual((await crossTenantCalendar.json()).events, [])

    const saveDepartments = await fetch(`${origin}/api/workspace/calendar-departments`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ data: ['전사', '연구개발팀'] }),
    })
    assert.equal(saveDepartments.status, 200)
    const readDepartments = await fetch(`${origin}/api/workspace/calendar-departments`, { headers: { cookie: member.cookie } })
    assert.deepEqual((await readDepartments.json()).data, ['전사', '연구개발팀'])
    const memberDepartmentWrite = await fetch(`${origin}/api/workspace/calendar-departments`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie: member.cookie },
      body: JSON.stringify({ data: ['위조 부서'] }),
    })
    assert.equal(memberDepartmentWrite.status, 403)

    const deleteRoom = await fetch(`${origin}/api/messenger/conversations/${reopened.conversation.id}`, {
      method: 'DELETE', headers: { cookie: admin.cookie },
    })
    assert.equal(deleteRoom.status, 204)

    const createAfterDelete = await fetch(`${origin}/api/messenger/conversations/direct`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ participantId: 'USR-SUNSEA-OH' }),
    })
    const afterDelete = await createAfterDelete.json()
    assert.equal(createAfterDelete.status, 201)
    assert.equal(afterDelete.created, true)
    assert.notEqual(afterDelete.conversation.id, reopened.conversation.id)
    assert.equal(afterDelete.conversation.generation, 3)
    assert.deepEqual(afterDelete.conversation.messages, [])
    assert.equal(JSON.stringify(afterDelete.conversation).includes('생산 계획을 확인해 주세요.'), false)
    assert.equal(JSON.stringify(afterDelete.conversation).includes('새 대화에서 다시 시작합니다.'), false)

    const rawAfterDelete = await fetch(`${origin}/api/workspace/messenger-conversations`, { headers: { cookie: admin.cookie } })
    const rawAfterDeleteData = (await rawAfterDelete.json()).data
    const deletedTombstone = rawAfterDeleteData.find((conversation) => conversation.id === reopened.conversation.id)
    assert.equal(deletedTombstone.lifecycle, 'deleted')
    assert.deepEqual(deletedTombstone.messages, [])
    assert.equal(rawAfterDeleteData.filter((conversation) => conversation.lifecycle === 'active').length, 1)

    const sendCurrent = await fetch(`${origin}/api/messenger/conversations/${afterDelete.conversation.id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: admin.cookie }, body: JSON.stringify({ text: '현재 세대 원본 메시지' }),
    })
    assert.equal(sendCurrent.status, 201)
    const currentRaw = (await (await fetch(`${origin}/api/workspace/messenger-conversations`, { headers: { cookie: admin.cookie } })).json()).data
    const forgedSenderData = structuredClone(currentRaw)
    const forgedActive = forgedSenderData.find((conversation) => conversation.id === afterDelete.conversation.id)
    forgedActive.messages.at(-1).senderName = '위조 발신자'
    forgedActive.messages.at(-1).text = '관리자가 바꾼 메시지'
    const forgeSender = await fetch(`${origin}/api/workspace/messenger-conversations`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie: admin.cookie }, body: JSON.stringify({ data: forgedSenderData }),
    })
    assert.equal(forgeSender.status, 400)
    assert.equal((await forgeSender.json()).error.code, 'INVALID_CONVERSATIONS')

    const historical = currentRaw.find((conversation) => conversation.id === firstRoom.conversation.id)
    const revived = { ...structuredClone(historical), id: 'direct-forged-revival', lifecycle: 'active', generation: 4, hiddenFor: [] }
    delete revived.closedAt
    delete revived.deletedAt
    const reviveDeletedHistory = await fetch(`${origin}/api/workspace/messenger-conversations`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie: admin.cookie }, body: JSON.stringify({ data: [revived, ...currentRaw] }),
    })
    assert.equal(reviveDeletedHistory.status, 400)
    const forgedDeletedGenerationData = structuredClone(currentRaw)
    const forgedDeletedGeneration = forgedDeletedGenerationData.find((conversation) => conversation.id === reopened.conversation.id)
    forgedDeletedGeneration.generation += 10
    const alterDeletedGeneration = await fetch(`${origin}/api/workspace/messenger-conversations`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie: admin.cookie }, body: JSON.stringify({ data: forgedDeletedGenerationData }),
    })
    assert.equal(alterDeletedGeneration.status, 400)
    const dropActiveRoom = await fetch(`${origin}/api/workspace/messenger-conversations`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ data: currentRaw.filter((conversation) => conversation.id !== afterDelete.conversation.id) }),
    })
    assert.equal(dropActiveRoom.status, 400)
    const unchangedWrite = await fetch(`${origin}/api/workspace/messenger-conversations`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie: admin.cookie }, body: JSON.stringify({ data: currentRaw }),
    })
    assert.equal(unchangedWrite.status, 200)
    const memberAfterAttacks = await fetch(`${origin}/api/workspace/messenger-conversations`, { headers: { cookie: member.cookie } })
    assert.deepEqual((await memberAfterAttacks.json()).data[0].messages.map((message) => message.text), ['현재 세대 원본 메시지'])
  })
})

test('legacy hidden direct rooms create one clean successor and never reopen old history', async () => {
  await withServer(createApp({ apiKey: '' }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const park = await login(origin, 'jihyun.park@sunsea.co.kr')
    const legacyHiddenRoom = {
      id: 'direct-legacy-hidden', type: 'direct', name: '박지현', subtitle: '품질관리팀 · 품질 책임자',
      memberId: 'park', participantIds: ['USR-SUNSEA-ADMIN', 'park'], hiddenFor: ['park'], unread: 0,
      lastMessage: '과거 레거시 메시지', lastTime: '09:10',
      messages: [{ id: 'legacy-message', senderId: 'USR-SUNSEA-ADMIN', senderName: '김서원', text: '과거 레거시 메시지', time: '09:10' }],
    }
    const seedLegacy = await fetch(`${origin}/api/workspace/messenger-conversations`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ data: [legacyHiddenRoom] }),
    })
    assert.equal(seedLegacy.status, 200)

    const createFromLegacy = await fetch(`${origin}/api/messenger/conversations/direct`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: park.cookie },
      body: JSON.stringify({ participantId: 'USR-SUNSEA-ADMIN' }),
    })
    const cleanLegacyRoom = await createFromLegacy.json()
    assert.equal(createFromLegacy.status, 201)
    assert.equal(cleanLegacyRoom.created, true)
    assert.equal(cleanLegacyRoom.conversation.generation, 2)
    assert.deepEqual(cleanLegacyRoom.conversation.messages, [])
    assert.ok(cleanLegacyRoom.closedConversationIds.includes(legacyHiddenRoom.id))
    assert.equal(JSON.stringify(cleanLegacyRoom.conversation).includes('과거 레거시 메시지'), false)

    const reopenCleanLegacy = await fetch(`${origin}/api/messenger/conversations/direct`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ participantId: 'USR-SUNSEA-PARK' }),
    })
    const sameCleanLegacyRoom = await reopenCleanLegacy.json()
    assert.equal(reopenCleanLegacy.status, 200)
    assert.equal(sameCleanLegacyRoom.created, false)
    assert.equal(sameCleanLegacyRoom.conversation.id, cleanLegacyRoom.conversation.id)
  })
})

test('messenger capacity rejects a new room without truncating existing records', async () => {
  await withServer(createApp({ apiKey: '' }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const fullStore = Array.from({ length: 2_000 }, (_, index) => ({
      id: `team-capacity-${index}`, type: 'team', name: `보관 대화 ${index}`, subtitle: '보관됨',
      participantIds: ['USR-SUNSEA-ADMIN'], unread: 0, lastMessage: '', lastTime: '', messages: [],
    }))
    const seed = await fetch(`${origin}/api/workspace/messenger-conversations`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie: admin.cookie }, body: JSON.stringify({ data: fullStore }),
    })
    assert.equal(seed.status, 200)
    const create = await fetch(`${origin}/api/messenger/conversations/direct`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ participantId: 'USR-SUNSEA-OH' }),
    })
    assert.equal(create.status, 409)
    assert.equal((await create.json()).error.code, 'MESSENGER_CAPACITY_REACHED')
    const after = await fetch(`${origin}/api/workspace/messenger-conversations`, { headers: { cookie: admin.cookie } })
    const afterData = (await after.json()).data
    assert.equal(afterData.length, 2_000)
    assert.equal(afterData.at(-1).id, 'team-capacity-1999')
  })
})

test('company library stores real files and enforces tenant document permissions', async () => {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'onfactory-documents-'))
  const storeFile = path.join(temporaryDirectory, 'workspace-state.json')
  try {
    await withServer(createApp({ apiKey: '', workspaceStoreFile: storeFile }), async (origin) => {
      const admin = await login(origin, 'admin@sunsea.co.kr')
      const allowedMember = await login(origin, 'taesik.oh@sunsea.co.kr')
      const blockedMember = await login(origin, 'jihyun.park@sunsea.co.kr')
      const otherTenant = await login(origin, 'admin@pohangcoop.co.kr')
      const params = new URLSearchParams({
        name: '생산 점검표.txt', category: '생산·품질', visibility: 'restricted',
        allowedUserIds: 'USR-SUNSEA-OH', tags: '생산,점검', summary: '생산팀 일일 점검표',
      })
      const payload = Buffer.from('온팩토리 생산 점검 자료', 'utf8')
      const upload = await fetch(`${origin}/api/documents?${params}`, {
        method: 'POST',
        headers: {
          cookie: admin.cookie,
          'content-type': 'application/octet-stream',
          'x-file-type': 'text/plain; charset=utf-8',
          'x-file-name': encodeURIComponent('생산 점검표.txt'),
        },
        body: payload,
      })
      const uploaded = await upload.json()
      assert.equal(upload.status, 201)
      assert.equal(uploaded.document.visibility, 'restricted')

      const allowedList = await fetch(`${origin}/api/documents`, { headers: { cookie: allowedMember.cookie } })
      assert.deepEqual((await allowedList.json()).documents.map((document) => document.id), [uploaded.document.id])
      const blockedList = await fetch(`${origin}/api/documents`, { headers: { cookie: blockedMember.cookie } })
      assert.deepEqual((await blockedList.json()).documents, [])
      const crossTenantList = await fetch(`${origin}/api/documents`, { headers: { cookie: otherTenant.cookie } })
      assert.deepEqual((await crossTenantList.json()).documents, [])

      const download = await fetch(`${origin}/api/documents/${uploaded.document.id}/download`, { headers: { cookie: allowedMember.cookie } })
      assert.equal(download.status, 200)
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), payload)

      const forbiddenDelete = await fetch(`${origin}/api/documents/${uploaded.document.id}`, { method: 'DELETE', headers: { cookie: allowedMember.cookie } })
      assert.equal(forbiddenDelete.status, 403)
      const removed = await fetch(`${origin}/api/documents/${uploaded.document.id}`, { method: 'DELETE', headers: { cookie: admin.cookie } })
      assert.equal(removed.status, 200)
      assert.equal((await removed.json()).deleted, true)
      assert.equal(JSON.parse(readFileSync(storeFile, 'utf8')).version, 2)
    })
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

test('factory drawings persist across restarts and only tenant administrators can replace or detach them', async () => {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'onfactory-factory-drawing-'))
  const storeFile = path.join(temporaryDirectory, 'workspace-state.json')
  const payload = Buffer.from('persistent factory drawing fixture', 'utf8')
  let drawingId = ''
  try {
    await withServer(createApp({ apiKey: '', workspaceStoreFile: storeFile }), async (origin) => {
      const admin = await login(origin, 'admin@sunsea.co.kr')
      const member = await login(origin, 'taesik.oh@sunsea.co.kr')
      const otherTenant = await login(origin, 'admin@pohangcoop.co.kr')
      const params = new URLSearchParams({
        name: '포항1공장.png', category: '공장도면', visibility: 'all',
        tags: 'factory-drawing,factory:FAC-POH-01', summary: '공장 배치 편집기 배경',
      })
      const memberUpload = await fetch(`${origin}/api/documents?${params}`, {
        method: 'POST', headers: { cookie: member.cookie, 'content-type': 'application/octet-stream', 'x-file-type': 'image/png', 'x-file-name': encodeURIComponent('위조.png') }, body: payload,
      })
      assert.equal(memberUpload.status, 403)
      assert.equal((await memberUpload.json()).error.code, 'FACTORY_DRAWING_WRITE_FORBIDDEN')

      const upload = await fetch(`${origin}/api/documents?${params}`, {
        method: 'POST', headers: { cookie: admin.cookie, 'content-type': 'application/octet-stream', 'x-file-type': 'image/png', 'x-file-name': encodeURIComponent('포항1공장.png') }, body: payload,
      })
      assert.equal(upload.status, 201)
      const document = (await upload.json()).document
      drawingId = document.id
      assert.deepEqual(document.tags, ['factory-drawing', 'factory:FAC-POH-01'])
      const memberDocuments = await fetch(`${origin}/api/documents`, { headers: { cookie: member.cookie } })
      assert.ok((await memberDocuments.json()).documents.some((item) => item.id === drawingId))
      assert.deepEqual(Buffer.from(await (await fetch(`${origin}/api/documents/${drawingId}/download`, { headers: { cookie: member.cookie } })).arrayBuffer()), payload)
      assert.deepEqual((await (await fetch(`${origin}/api/documents`, { headers: { cookie: otherTenant.cookie } })).json()).documents, [])
      assert.equal((await fetch(`${origin}/api/documents/${drawingId}`, { method: 'DELETE', headers: { cookie: member.cookie } })).status, 403)
    })

    await withServer(createApp({ apiKey: '', workspaceStoreFile: storeFile }), async (origin) => {
      const admin = await login(origin, 'admin@sunsea.co.kr')
      const member = await login(origin, 'taesik.oh@sunsea.co.kr')
      const restored = await fetch(`${origin}/api/documents`, { headers: { cookie: member.cookie } })
      assert.ok((await restored.json()).documents.some((item) => item.id === drawingId))
      const download = await fetch(`${origin}/api/documents/${drawingId}/download`, { headers: { cookie: member.cookie } })
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), payload)
      const directDelete = await fetch(`${origin}/api/documents/${drawingId}`, { method: 'DELETE', headers: { cookie: admin.cookie } })
      assert.equal(directDelete.status, 409)
      assert.equal((await directDelete.json()).error.code, 'DOCUMENT_IN_USE')
      const detach = await fetch(`${origin}/api/documents/${drawingId}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json', cookie: admin.cookie }, body: JSON.stringify({ category: '공장자료', tags: ['공장도면-연결해제'] }),
      })
      assert.equal(detach.status, 200)
      assert.equal((await fetch(`${origin}/api/documents/${drawingId}`, { method: 'DELETE', headers: { cookie: admin.cookie } })).status, 200)
    })
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

test('journal and compliance attachments keep real files through approval with tenant and reference protection', async () => {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'onfactory-linked-documents-'))
  const storeFile = path.join(temporaryDirectory, 'workspace-state.json')
  try {
    await withServer(createApp({ apiKey: '', workspaceStoreFile: storeFile }), async (origin) => {
      const admin = await login(origin, 'admin@sunsea.co.kr')
      const author = await login(origin, 'taesik.oh@sunsea.co.kr')
      const unrelatedMember = await login(origin, 'jihyun.park@sunsea.co.kr')
      const otherTenantAdmin = await login(origin, 'admin@pohangcoop.co.kr')
      const upload = async (cookie, name, payload, category) => {
        const params = new URLSearchParams({ name, category, visibility: 'restricted' })
        const response = await fetch(`${origin}/api/documents?${params}`, {
          method: 'POST',
          headers: {
            cookie,
            'content-type': 'application/octet-stream',
            'x-file-type': 'text/plain; charset=utf-8',
            'x-file-name': encodeURIComponent(name),
          },
          body: payload,
        })
        const body = await response.json()
        assert.equal(response.status, 201)
        return body.document
      }

      const journalPayload = Buffer.from('LOT A-260820 생산실적 120박스', 'utf8')
      const journalDocument = await upload(author.cookie, '생산실적.txt', journalPayload, '일일업무일지')
      const journal = {
        id: 'JR-FILE-01', date: '2026-08-20', title: '2026-08-20_오태식_업무일지', author: '오태식', department: '생산팀',
        completed: 'LOT 생산실적 등록', issue: '', nextPlan: '포장 수율 확인', approver: '김서원', status: '결재요청',
        updatedAt: '방금', feedback: '', attachments: [{ id: journalDocument.id, name: journalDocument.name, size: '35 KB' }], reviews: [],
      }
      const submitJournal = await fetch(`${origin}/api/workspace/daily-journals`, {
        method: 'PUT', headers: { 'content-type': 'application/json', cookie: author.cookie }, body: JSON.stringify({ data: [journal] }),
      })
      assert.equal(submitJournal.status, 200)

      const referencedDelete = await fetch(`${origin}/api/documents/${journalDocument.id}`, { method: 'DELETE', headers: { cookie: author.cookie } })
      assert.equal(referencedDelete.status, 409)
      assert.equal((await referencedDelete.json()).error.code, 'DOCUMENT_IN_USE')
      const unrelatedDownload = await fetch(`${origin}/api/documents/${journalDocument.id}/download`, { headers: { cookie: unrelatedMember.cookie } })
      assert.equal(unrelatedDownload.status, 404)
      const crossTenantDownload = await fetch(`${origin}/api/documents/${journalDocument.id}/download`, { headers: { cookie: otherTenantAdmin.cookie } })
      assert.equal(crossTenantDownload.status, 404)
      const adminDownload = await fetch(`${origin}/api/documents/${journalDocument.id}/download`, { headers: { cookie: admin.cookie } })
      assert.equal(adminDownload.status, 200)
      assert.deepEqual(Buffer.from(await adminDownload.arrayBuffer()), journalPayload)

      const reject = await fetch(`${origin}/api/daily-journals/${journal.id}/review`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie: admin.cookie },
        body: JSON.stringify({ decision: 'reject', comment: 'LOT별 포장 수율을 보완해 주세요.' }),
      })
      assert.equal(reject.status, 200)
      const rejected = (await reject.json()).journal
      assert.equal(rejected.status, '반려')
      assert.deepEqual(rejected.attachments, journal.attachments)

      const resubmit = await fetch(`${origin}/api/workspace/daily-journals`, {
        method: 'PUT', headers: { 'content-type': 'application/json', cookie: author.cookie },
        body: JSON.stringify({ data: [{ ...rejected, status: '결재요청', completed: 'LOT 생산실적 및 포장 수율 등록' }] }),
      })
      assert.equal(resubmit.status, 200)
      const approve = await fetch(`${origin}/api/daily-journals/${journal.id}/review`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie: admin.cookie },
        body: JSON.stringify({ decision: 'approve', comment: '생산실적과 포장 수율을 확인했습니다.' }),
      })
      assert.equal(approve.status, 200)
      assert.deepEqual((await approve.json()).journal.attachments, journal.attachments)
      const approvedDownload = await fetch(`${origin}/api/documents/${journalDocument.id}/download`, { headers: { cookie: author.cookie } })
      assert.deepEqual(Buffer.from(await approvedDownload.arrayBuffer()), journalPayload)

      const compliancePayload = Buffer.from('HACCP certificate binary fixture', 'utf8')
      const complianceDocument = await upload(admin.cookie, 'HACCP_인증서.txt', compliancePayload, '식품안전·인증')
      const complianceRecord = {
        id: 'CERT-FILE-01', category: 'HACCP', name: '수산가공식품 HACCP 인증', authority: '인증원', certificateNo: 'H-001',
        issuedAt: '2026-08-20', expiresAt: '2027-08-19', owner: '김서원', status: '유효', checklist: ['인증서 원본 확인'],
        attachments: [{ id: complianceDocument.id, name: complianceDocument.name, size: '32 KB' }], note: '', updatedAt: '2026-08-20',
      }
      const saveCompliance = await fetch(`${origin}/api/workspace/compliance-records`, {
        method: 'PUT', headers: { 'content-type': 'application/json', cookie: admin.cookie }, body: JSON.stringify({ data: [complianceRecord] }),
      })
      assert.equal(saveCompliance.status, 200)
      const complianceReferencedDelete = await fetch(`${origin}/api/documents/${complianceDocument.id}`, { method: 'DELETE', headers: { cookie: admin.cookie } })
      assert.equal(complianceReferencedDelete.status, 409)
      const complianceMemberDownload = await fetch(`${origin}/api/documents/${complianceDocument.id}/download`, { headers: { cookie: unrelatedMember.cookie } })
      assert.equal(complianceMemberDownload.status, 404)
      const complianceAdminDownload = await fetch(`${origin}/api/documents/${complianceDocument.id}/download`, { headers: { cookie: admin.cookie } })
      assert.deepEqual(Buffer.from(await complianceAdminDownload.arrayBuffer()), compliancePayload)

      const detachCompliance = await fetch(`${origin}/api/workspace/compliance-records`, {
        method: 'PUT', headers: { 'content-type': 'application/json', cookie: admin.cookie },
        body: JSON.stringify({ data: [{ ...complianceRecord, attachments: [] }] }),
      })
      assert.equal(detachCompliance.status, 200)
      const deleteDetachedCompliance = await fetch(`${origin}/api/documents/${complianceDocument.id}`, { method: 'DELETE', headers: { cookie: admin.cookie } })
      assert.equal(deleteDetachedCompliance.status, 200)

      const workDocument = await upload(admin.cookie, '업무완료증빙.txt', Buffer.from('work evidence', 'utf8'), '회의·업무일지')
      const workItem = {
        id: 'WK-FILE-01', title: '생산기록 검토', description: '생산기록을 검토합니다.', owner: '김서원', requestedBy: '김서원',
        due: '2026-08-20 18:00', priority: '보통', status: '결재대기', category: '품질', ownerId: 'USR-SUNSEA-ADMIN', requesterId: 'USR-SUNSEA-ADMIN',
        completion: { summary: '생산기록 검토 완료', evidence: [{ id: workDocument.id, name: workDocument.name, size: '1 KB', type: 'text/plain' }], submittedAt: '2026-08-20T09:00:00.000Z', submittedById: 'USR-SUNSEA-ADMIN', submittedByName: '김서원' },
      }
      const saveWork = await fetch(`${origin}/api/workspace/work-items`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie: admin.cookie }, body: JSON.stringify({ data: [workItem] }) })
      assert.equal(saveWork.status, 200)
      assert.equal((await fetch(`${origin}/api/documents/${workDocument.id}`, { method: 'DELETE', headers: { cookie: admin.cookie } })).status, 409)
      assert.equal((await fetch(`${origin}/api/workspace/work-items`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie: admin.cookie }, body: JSON.stringify({ data: [] }) })).status, 200)
      assert.equal((await fetch(`${origin}/api/documents/${workDocument.id}`, { method: 'DELETE', headers: { cookie: admin.cookie } })).status, 200)
      const transitionItem = { ...workItem, id: 'WK-INVALID-EVIDENCE', owner: '오태식', ownerId: 'USR-SUNSEA-OH', status: '수행중' }
      delete transitionItem.completion
      assert.equal((await fetch(`${origin}/api/workspace/work-items`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie: admin.cookie }, body: JSON.stringify({ data: [transitionItem] }) })).status, 200)
      const forgedEvidence = await fetch(`${origin}/api/work-items/${transitionItem.id}/transition`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie: author.cookie },
        body: JSON.stringify({ action: 'submit', completion: { summary: '위조 증빙 제출', evidence: [{ id: 'DOC-CROSS-TENANT', name: '위조.txt', size: '1 KB', type: 'text/plain' }] } }),
      })
      assert.equal(forgedEvidence.status, 400)
      assert.equal((await forgedEvidence.json()).error.code, 'INVALID_DOCUMENT_REFERENCE')
      assert.equal((await fetch(`${origin}/api/workspace/work-items`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie: admin.cookie }, body: JSON.stringify({ data: [] }) })).status, 200)

      const movementDocument = await upload(admin.cookie, '입고검수증빙.txt', Buffer.from('inventory evidence', 'utf8'), '재고·물류')
      const movement = { id: 'MOV-FILE-01', direction: '입고', product: '냉동 멍게', lot: 'LOT-01', quantity: 10, unit: 'KG', warehouseId: 'WH-01', occurredAt: '2026-08-20 09:00', reason: '검수 완료', evidence: movementDocument.name, evidenceId: movementDocument.id }
      assert.equal((await fetch(`${origin}/api/workspace/inventory-movements`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie: admin.cookie }, body: JSON.stringify({ data: [movement] }) })).status, 200)
      assert.equal((await fetch(`${origin}/api/documents/${movementDocument.id}`, { method: 'DELETE', headers: { cookie: admin.cookie } })).status, 409)
      assert.equal((await fetch(`${origin}/api/workspace/inventory-movements`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie: admin.cookie }, body: JSON.stringify({ data: [] }) })).status, 200)
      assert.equal((await fetch(`${origin}/api/documents/${movementDocument.id}`, { method: 'DELETE', headers: { cookie: admin.cookie } })).status, 200)

      const factoryParams = new URLSearchParams({ name: '공장도면.png', category: '공장도면', visibility: 'all', tags: 'factory-drawing,factory:FAC-01' })
      const factoryUpload = await fetch(`${origin}/api/documents?${factoryParams}`, {
        method: 'POST', headers: { cookie: admin.cookie, 'content-type': 'application/octet-stream', 'x-file-type': 'image/png', 'x-file-name': encodeURIComponent('공장도면.png') }, body: Buffer.from('png fixture'),
      })
      assert.equal(factoryUpload.status, 201)
      const factoryDocument = (await factoryUpload.json()).document
      assert.equal((await fetch(`${origin}/api/documents/${factoryDocument.id}`, { method: 'DELETE', headers: { cookie: admin.cookie } })).status, 409)
      const detachFactory = await fetch(`${origin}/api/documents/${factoryDocument.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: admin.cookie }, body: JSON.stringify({ category: '공장자료', tags: ['공장도면-연결해제'] }) })
      assert.equal(detachFactory.status, 200)
      assert.equal((await fetch(`${origin}/api/documents/${factoryDocument.id}`, { method: 'DELETE', headers: { cookie: admin.cookie } })).status, 200)

      const rollbackPayload = Buffer.from('rollback candidate', 'utf8')
      const rollbackDocument = await upload(author.cookie, '롤백대상.txt', rollbackPayload, '일일업무일지')
      const invalidReferenceSave = await fetch(`${origin}/api/workspace/daily-journals`, {
        method: 'PUT', headers: { 'content-type': 'application/json', cookie: author.cookie },
        body: JSON.stringify({ data: [{ ...journal, id: 'JR-INVALID-REF', status: '임시저장', attachments: [{ id: 'DOC-CROSS-TENANT', name: '위조.txt', size: '1 KB' }] }] }),
      })
      assert.equal(invalidReferenceSave.status, 400)
      assert.equal((await invalidReferenceSave.json()).error.code, 'INVALID_DOCUMENT_REFERENCE')
      const rollbackDelete = await fetch(`${origin}/api/documents/${rollbackDocument.id}`, { method: 'DELETE', headers: { cookie: author.cookie } })
      assert.equal(rollbackDelete.status, 200)
    })
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

test('document upload rolls back binary and metadata when the workspace commit fails', async () => {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'onfactory-document-rollback-'))
  const storeFile = path.join(temporaryDirectory, 'workspace-state.json')
  const app = createApp({ apiKey: '', workspaceStoreFile: storeFile })
  rmSync(storeFile, { force: true })
  mkdirSync(storeFile)
  try {
    await withServer(app, async (origin) => {
      const admin = await login(origin, 'admin@sunsea.co.kr')
      const failed = await fetch(`${origin}/api/documents?name=${encodeURIComponent('롤백.txt')}&visibility=restricted`, {
        method: 'POST',
        headers: { cookie: admin.cookie, 'content-type': 'application/octet-stream', 'x-file-type': 'text/plain', 'x-file-name': encodeURIComponent('롤백.txt') },
        body: Buffer.from('must be rolled back'),
      })
      assert.equal(failed.status, 500)
      assert.equal((await failed.json()).error.code, 'DOCUMENT_UPLOAD_FAILED')

      rmSync(storeFile, { recursive: true, force: true })
      const list = await fetch(`${origin}/api/documents`, { headers: { cookie: admin.cookie } })
      assert.deepEqual((await list.json()).documents, [])
      const retry = await fetch(`${origin}/api/documents?name=${encodeURIComponent('재시도.txt')}&visibility=restricted`, {
        method: 'POST',
        headers: { cookie: admin.cookie, 'content-type': 'application/octet-stream', 'x-file-type': 'text/plain', 'x-file-name': encodeURIComponent('재시도.txt') },
        body: Buffer.from('retry succeeds'),
      })
      assert.equal(retry.status, 201)
      const retriedDocument = (await retry.json()).document

      rmSync(storeFile, { force: true })
      mkdirSync(storeFile)
      const failedDelete = await fetch(`${origin}/api/documents/${retriedDocument.id}`, { method: 'DELETE', headers: { cookie: admin.cookie } })
      assert.equal(failedDelete.status, 500)
      assert.equal((await failedDelete.json()).error.code, 'DOCUMENT_DELETE_FAILED')
      rmSync(storeFile, { recursive: true, force: true })
      const preservedDownload = await fetch(`${origin}/api/documents/${retriedDocument.id}/download`, { headers: { cookie: admin.cookie } })
      assert.equal(preservedDownload.status, 200)
      assert.equal(Buffer.from(await preservedDownload.arrayBuffer()).toString('utf8'), 'retry succeeds')
    })
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

test('workspace writes reject stale versions and recover from the last verified backup', async () => {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'onfactory-workspace-safety-'))
  const storeFile = path.join(temporaryDirectory, 'workspace-state.json')
  const originalLocations = [{ id: 'WH-SAFE-1', name: '안전 창고', description: '원본' }]
  writeFileSync(storeFile, JSON.stringify({
    version: 2,
    tenants: {
      'TENANT-SUNSEA': {
        'inventory-locations': { data: originalLocations, updatedAt: '2026-08-20T00:00:00.000Z', updatedBy: 'seed' },
      },
    },
    accountApprovals: {}, invitedAccounts: [], passwordResetRequests: [],
  }))

  try {
    await withServer(createApp({ apiKey: '', workspaceStoreFile: storeFile }), async (origin) => {
      const admin = await login(origin, 'admin@sunsea.co.kr')
      const initialRead = await fetch(`${origin}/api/workspace/inventory-locations`, { headers: { cookie: admin.cookie } })
      const initialBody = await initialRead.json()
      assert.equal(typeof initialBody.version, 'string')

      const firstWrite = await fetch(`${origin}/api/workspace/inventory-locations`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie: admin.cookie, 'if-match': `"${initialBody.version}"` },
        body: JSON.stringify({ data: [{ ...originalLocations[0], description: '첫 저장' }] }),
      })
      assert.equal(firstWrite.status, 200)

      const staleWrite = await fetch(`${origin}/api/workspace/inventory-locations`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie: admin.cookie, 'if-match': `"${initialBody.version}"` },
        body: JSON.stringify({ data: [{ ...originalLocations[0], description: '덮어쓰기' }] }),
      })
      assert.equal(staleWrite.status, 409)
      assert.equal((await staleWrite.json()).error.code, 'WORKSPACE_VERSION_CONFLICT')
    })

    // The atomic writer rotated the verified pre-write state into .bak. If the
    // main file is damaged, startup must recover that backup instead of seeding
    // an empty store that could erase all tenant data on the next write.
    writeFileSync(storeFile, '{broken-json')
    await withServer(createApp({ apiKey: '', workspaceStoreFile: storeFile }), async (origin) => {
      const admin = await login(origin, 'admin@sunsea.co.kr')
      const recovered = await fetch(`${origin}/api/workspace/inventory-locations`, { headers: { cookie: admin.cookie } })
      const recoveredBody = await recovered.json()
      assert.deepEqual(recoveredBody.data, originalLocations)
      const healedWrite = await fetch(`${origin}/api/workspace/inventory-locations`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie: admin.cookie, 'if-match': `"${recoveredBody.version}"` },
        body: JSON.stringify({ data: [{ ...originalLocations[0], description: '복구 후 저장' }] }),
      })
      assert.equal(healedWrite.status, 200)
    })
    assert.equal(JSON.parse(readFileSync(storeFile, 'utf8')).tenants['TENANT-SUNSEA']['inventory-locations'].data[0].description, '복구 후 저장')
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

test('platform operations persist tenants, administrator credentials, CS evidence, actions, and audit history across restarts', async () => {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'onfactory-platform-'))
  const storeFile = path.join(temporaryDirectory, 'workspace-state.json')
  const documentUploadDirectory = path.join(temporaryDirectory, 'documents')
  const evidencePayload = Buffer.from('platform evidence: order sync failed', 'utf8')
  const administratorEmail = 'platform-admin@eastsea.test'
  const permanentPassword = 'EastSea!Secure2026'
  let createdTenantId = ''
  let createdTicketId = ''
  let createdActionId = ''
  let temporaryPassword = ''

  try {
    await withServer(createApp({ apiKey: '', workspaceStoreFile: storeFile, documentUploadDirectory }), async (origin) => {
      const operator = await login(origin, 'operator@onfactory.co.kr', 'platform')
      assert.equal(operator.response.status, 200)
      const customerAdmin = await login(origin, 'admin@sunsea.co.kr')
      assert.equal(customerAdmin.response.status, 200)

      const forbiddenState = await fetch(`${origin}/api/platform/state`, { headers: { cookie: customerAdmin.cookie } })
      assert.equal(forbiddenState.status, 403)
      assert.equal((await forbiddenState.json()).error.code, 'PLATFORM_OPERATOR_REQUIRED')

      const seededStateResponse = await fetch(`${origin}/api/platform/state`, { headers: { cookie: operator.cookie } })
      assert.equal(seededStateResponse.status, 200)
      const seededState = await seededStateResponse.json()
      assert.ok(seededState.tenants.some((tenant) => tenant.id === 'TENANT-SUNSEA'))
      assert.ok(seededState.tenants.some((tenant) => tenant.id === 'TENANT-POHANG'))
      assert.ok(seededState.supportTickets.length >= 4)

      const tenantPayload = {
        companyName: '동해수산가공', industry: '수산식품 제조', plan: 'Growth',
        adminName: '이운영', adminEmail: administratorEmail, targetDate: '2026-09-01',
      }
      const tenantCreate = await fetch(`${origin}/api/platform/tenants`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie: operator.cookie }, body: JSON.stringify(tenantPayload),
      })
      assert.equal(tenantCreate.status, 201)
      const createdTenant = await tenantCreate.json()
      createdTenantId = createdTenant.tenant.id
      temporaryPassword = createdTenant.onboarding.temporaryPassword
      assert.match(createdTenantId, /^TENANT-[0-9A-F]{12}$/)
      assert.equal(createdTenant.tenant.users, 1)
      assert.equal(createdTenant.onboarding.requiresPasswordChange, true)
      assert.notEqual(createdTenant.onboarding.temporaryPassword, 'demo1234')
      assert.ok(Date.parse(createdTenant.onboarding.expiresAt) > Date.now())
      assert.equal(Object.hasOwn(createdTenant.tenant, 'adminAccount'), false)

      const duplicateName = await fetch(`${origin}/api/platform/tenants`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie: operator.cookie }, body: JSON.stringify({ ...tenantPayload, adminEmail: 'another-admin@eastsea.test' }),
      })
      assert.equal(duplicateName.status, 409)
      assert.equal((await duplicateName.json()).error.code, 'PLATFORM_TENANT_EXISTS')

      const duplicateEmail = await fetch(`${origin}/api/platform/tenants`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie: operator.cookie }, body: JSON.stringify({ ...tenantPayload, companyName: '동해수산가공 제2공장' }),
      })
      assert.equal(duplicateEmail.status, 409)
      assert.equal((await duplicateEmail.json()).error.code, 'PLATFORM_ADMIN_EMAIL_EXISTS')

      const initialAdmin = await login(origin, administratorEmail, 'tenant', createdTenant.onboarding.temporaryPassword)
      assert.equal(initialAdmin.response.status, 200)
      assert.equal((await initialAdmin.response.clone().json()).account.requiresPasswordChange, true)
      const blockedUntilPasswordChange = await fetch(`${origin}/api/directory`, { headers: { cookie: initialAdmin.cookie } })
      assert.equal(blockedUntilPasswordChange.status, 428)
      assert.equal((await blockedUntilPasswordChange.json()).error.code, 'PASSWORD_CHANGE_REQUIRED')
      const passwordChange = await fetch(`${origin}/api/auth/password/change`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie: initialAdmin.cookie }, body: JSON.stringify({ newPassword: permanentPassword }),
      })
      assert.equal(passwordChange.status, 200)
      assert.equal((await fetch(`${origin}/api/directory`, { headers: { cookie: initialAdmin.cookie } })).status, 200)

      const ticketParams = new URLSearchParams({
        tenantId: createdTenantId, title: '스마트스토어 주문 동기화 지연',
        description: '신규 고객사의 주문 수집이 30분 이상 지연됩니다.', priority: 'P1', owner: '플랫폼 운영팀', evidenceName: '동기화-오류.txt',
      })
      const ticketCreate = await fetch(`${origin}/api/platform/tickets?${ticketParams}`, {
        method: 'POST',
        headers: { cookie: operator.cookie, 'content-type': 'application/octet-stream', 'x-file-type': 'text/plain; charset=utf-8', 'x-file-name': encodeURIComponent('동기화-오류.txt') },
        body: evidencePayload,
      })
      assert.equal(ticketCreate.status, 201)
      const createdTicket = (await ticketCreate.json()).ticket
      createdTicketId = createdTicket.id
      assert.equal(createdTicket.tenantId, createdTenantId)
      assert.equal(createdTicket.evidence.name, '동기화-오류.txt')
      assert.equal(createdTicket.evidence.size, evidencePayload.length)

      const evidenceDownload = await fetch(`${origin}/api/platform/tickets/${createdTicketId}/evidence`, { headers: { cookie: operator.cookie } })
      assert.equal(evidenceDownload.status, 200)
      assert.deepEqual(Buffer.from(await evidenceDownload.arrayBuffer()), evidencePayload)
      const forbiddenEvidence = await fetch(`${origin}/api/platform/tickets/${createdTicketId}/evidence`, { headers: { cookie: customerAdmin.cookie } })
      assert.equal(forbiddenEvidence.status, 403)

      const ticketUpdate = await fetch(`${origin}/api/platform/tickets/${createdTicketId}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json', cookie: operator.cookie },
        body: JSON.stringify({ status: '해결', priority: 'P2', owner: 'CS 책임자' }),
      })
      assert.equal(ticketUpdate.status, 200)
      const updatedTicket = (await ticketUpdate.json()).ticket
      assert.equal(updatedTicket.status, '해결')
      assert.equal(updatedTicket.owner, 'CS 책임자')
      assert.ok(updatedTicket.history.some((entry) => entry.title === '티켓 변경'))

      const actionCreate = await fetch(`${origin}/api/platform/actions`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie: operator.cookie },
        body: JSON.stringify({ tenantId: createdTenantId, kind: '지원 세션 요청', target: '동해수산가공 · 연동 로그 읽기 전용', message: '동기화 지연 원인과 재발 방지 조치를 확인하는 15분 지원 세션', reference: createdTicketId }),
      })
      assert.equal(actionCreate.status, 201)
      createdActionId = (await actionCreate.json()).action.id

      const updatedState = await fetch(`${origin}/api/platform/state`, { headers: { cookie: operator.cookie } }).then((response) => response.json())
      assert.ok(updatedState.tenants.some((tenant) => tenant.id === createdTenantId))
      assert.ok(updatedState.supportTickets.some((ticket) => ticket.id === createdTicketId && ticket.status === '해결'))
      assert.ok(updatedState.actions.some((action) => action.id === createdActionId))
      assert.ok(updatedState.auditEvents.some((event) => event.reference === createdTenantId && event.event === '고객사 온보딩 완료'))
      assert.ok(updatedState.auditEvents.some((event) => event.reference === createdTicketId))
    })

    const persistedStoreText = readFileSync(storeFile, 'utf8')
    assert.equal(persistedStoreText.includes(temporaryPassword), false)
    const persistedStore = JSON.parse(persistedStoreText)
    const administratorId = persistedStore.platform.tenants.find((tenant) => tenant.id === createdTenantId).adminAccount.id
    assert.match(persistedStore.accountCredentials[administratorId].passwordHash, /^[0-9a-f]{64}$/)

    await withServer(createApp({ apiKey: '', workspaceStoreFile: storeFile, documentUploadDirectory }), async (origin) => {
      const operator = await login(origin, 'operator@onfactory.co.kr', 'platform')
      assert.equal(operator.response.status, 200)
      const persistedStateResponse = await fetch(`${origin}/api/platform/state`, { headers: { cookie: operator.cookie } })
      assert.equal(persistedStateResponse.status, 200)
      const persistedState = await persistedStateResponse.json()
      assert.ok(persistedState.tenants.some((tenant) => tenant.id === createdTenantId))
      assert.ok(persistedState.supportTickets.some((ticket) => ticket.id === createdTicketId && ticket.evidence?.size === evidencePayload.length))
      assert.ok(persistedState.actions.some((action) => action.id === createdActionId))

      const persistedEvidence = await fetch(`${origin}/api/platform/tickets/${createdTicketId}/evidence`, { headers: { cookie: operator.cookie } })
      assert.equal(persistedEvidence.status, 200)
      assert.deepEqual(Buffer.from(await persistedEvidence.arrayBuffer()), evidencePayload)

      const persistedAdmin = await login(origin, administratorEmail, 'tenant', permanentPassword)
      assert.equal(persistedAdmin.response.status, 200)
      const persistedAdminBody = await persistedAdmin.response.json()
      assert.equal(persistedAdminBody.account.tenantId, createdTenantId)
      assert.equal(persistedAdminBody.account.requiresPasswordChange, false)
      assert.equal((await fetch(`${origin}/api/directory`, { headers: { cookie: persistedAdmin.cookie } })).status, 200)
    })
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

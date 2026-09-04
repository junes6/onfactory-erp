import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createApp } from './app.mjs'
import { withServer } from './test-server.mjs'
import { canOversee, isOverseeable } from './oversight-routes.mjs'
import { CONSENT_ITEM_IDS, CONSENT_TERMS_VERSION, publicConsentTerms } from './policies/consent-terms.mjs'

const ADMIN = { email: 'admin@sunsea.co.kr', password: 'demo1234' }
const PARK = { email: 'jihyun.park@sunsea.co.kr', password: 'demo1234' }
const OH = { email: 'taesik.oh@sunsea.co.kr', password: 'demo1234' }

async function signIn(origin, who) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: 'tenant', ...who }),
  })
  assert.equal(response.status, 200, `${who.email} 로그인 실패`)
  const account = (await response.json()).account
  return {
    account,
    headers: {
      cookie: response.headers.get('set-cookie'),
      'x-workspace-identity': `${account.tenantId}:${account.id}`,
      'content-type': 'application/json',
    },
  }
}

async function withApp(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oversight-'))
  try {
    const app = createApp({ apiKey: '', workspaceStoreFile: path.join(directory, 'state.json'), documentUploadDirectory: path.join(directory, 'documents') })
    await withServer(app, run)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

// ─────────────────────────── 순수 규칙 ───────────────────────────

test('열람 대상은 업무용 채널과 그룹방뿐이다', () => {
  assert.equal(isOverseeable({ type: 'team' }), true)
  assert.equal(isOverseeable({ type: 'team', kind: 'group' }), true)
  assert.equal(isOverseeable({ type: 'direct' }), false, '1:1 개인 대화는 감독 대상이 아니다')
  assert.equal(isOverseeable({ type: 'team', systemChannel: 'developer-support' }), false, '지원 채널은 요청자 개인 통로다')
})

test('열람 권한은 관리자이거나 관리자가 지정한 사람이다', () => {
  assert.equal(canOversee({ role: 'tenant-admin' }), true)
  assert.equal(canOversee({ role: 'tenant-member', oversight: true }), true)
  assert.equal(canOversee({ role: 'tenant-member' }), false)
  assert.equal(canOversee({ role: 'tenant-member', oversight: 'yes' }), false, '참인 척하는 값은 권한이 아니다')
})

// ─────────────────────────── 정책 고지 ───────────────────────────

test('감독 열람 정책이 동의 항목으로 공개되고 버전이 올랐다', () => {
  assert.ok(CONSENT_ITEM_IDS.includes('channelOversight'), '알림이 없을수록 정책은 더 크게 공개돼야 한다')
  const item = publicConsentTerms().items.find((entry) => entry.id === 'channelOversight')
  assert.match(item.summary, /개인 DM은 열람 대상이 아닙니다/)
  assert.match(item.summary, /개별 알림은 가지 않습니다/)
  assert.notEqual(CONSENT_TERMS_VERSION, '2026-08-22.1', '항목이 늘면 재동의를 받아야 한다')
})

// ─────────────────────────── 열람 동작 ───────────────────────────

test('관리자는 업무 채널을 열람할 수 있고 1:1 개인 대화는 목록에도 없다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)

    // 1:1 대화를 하나 만들어 둔다. 이 방은 절대 열람 대상이 되면 안 된다.
    const direct = await fetch(`${origin}/api/messenger/conversations/direct`, {
      method: 'POST', headers: park.headers, body: JSON.stringify({ participantId: admin.account.id }),
    })
    const directRoom = (await direct.json()).conversation
    await fetch(`${origin}/api/messenger/conversations/${directRoom.id}/messages`, {
      method: 'POST', headers: park.headers, body: JSON.stringify({ text: '개인적으로 드릴 말씀이 있습니다' }),
    })

    const group = await fetch(`${origin}/api/messenger/conversations/group`, {
      method: 'POST', headers: park.headers, body: JSON.stringify({ name: '생산 점검', participantIds: [] }),
    })
    const groupRoom = (await group.json()).conversation
    await fetch(`${origin}/api/messenger/conversations/${groupRoom.id}/messages`, {
      method: 'POST', headers: park.headers, body: JSON.stringify({ text: '오늘 점검 완료했습니다' }),
    })

    const listed = await (await fetch(`${origin}/api/oversight/rooms`, { headers: admin.headers })).json()
    assert.ok(listed.rooms.some((room) => room.id === groupRoom.id), '업무 그룹방은 열람 목록에 있다')
    assert.ok(!listed.rooms.some((room) => room.id === directRoom.id), '1:1 개인 대화는 목록에 없다')
    assert.ok(listed.excludedDirectCount >= 1, '몇 개가 빠졌는지는 숨기지 않는다')

    const blocked = await fetch(`${origin}/api/oversight/rooms/${directRoom.id}`, { headers: admin.headers })
    assert.equal(blocked.status, 403, '방 id를 직접 넣어도 개인 대화는 열리지 않는다')
    assert.equal((await blocked.json()).error.code, 'DIRECT_NOT_OVERSEEABLE')

    const opened = await (await fetch(`${origin}/api/oversight/rooms/${groupRoom.id}`, { headers: admin.headers })).json()
    assert.equal(opened.messages.length, 1)
    assert.equal(opened.messages[0].text, '오늘 점검 완료했습니다')
    assert.match(opened.notice, /개별 알림은 가지 않습니다/)
  })
})

test('열람하면 기록이 남고 회사 관리자 화면에서 조회된다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)
    const group = await fetch(`${origin}/api/messenger/conversations/group`, {
      method: 'POST', headers: park.headers, body: JSON.stringify({ name: '감사 대상방', participantIds: [] }),
    })
    const room = (await group.json()).conversation

    await fetch(`${origin}/api/oversight/rooms/${room.id}`, { headers: admin.headers })

    const audit = await (await fetch(`${origin}/api/oversight/audit`, { headers: admin.headers })).json()
    const entry = audit.events.find((item) => item.event === '대화 감독 열람')
    assert.ok(entry, '기록되지 않는 열람은 없다')
    assert.equal(entry.actor, admin.account.name)
    assert.equal(entry.reference, room.id)
    assert.match(entry.scope, /감사 대상방/)
    assert.ok(entry.at, '언제 열람했는지가 남는다')
  })
})

test('열람은 참여자에게 알림을 보내지 않는다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)
    const group = await fetch(`${origin}/api/messenger/conversations/group`, {
      method: 'POST', headers: park.headers, body: JSON.stringify({ name: '조용한 방', participantIds: [] }),
    })
    const room = (await group.json()).conversation
    const before = (await (await fetch(`${origin}/api/notifications`, { headers: park.headers })).json()).items.length

    await fetch(`${origin}/api/oversight/rooms/${room.id}`, { headers: admin.headers })

    const after = (await (await fetch(`${origin}/api/notifications`, { headers: park.headers })).json()).items
    assert.equal(after.length, before, '열람 사실을 알리지 않는다 — 대신 정책으로 공개한다')
    assert.ok(!after.some((item) => /열람/.test(item.title ?? '')), '열람 알림이 있으면 안 된다')
  })
})

// ─────────────────────── 권한 부여·회수 ───────────────────────

test('권한 없는 구성원은 열람할 수 없고, 부여·회수가 기록된다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)
    const group = await fetch(`${origin}/api/messenger/conversations/group`, {
      method: 'POST', headers: park.headers, body: JSON.stringify({ name: '권한 시험방', participantIds: [] }),
    })
    const room = (await group.json()).conversation

    const oh = await signIn(origin, OH)
    const denied = await fetch(`${origin}/api/oversight/rooms`, { headers: oh.headers })
    assert.equal(denied.status, 403)
    assert.equal((await denied.json()).error.code, 'OVERSIGHT_FORBIDDEN')

    const granted = await fetch(`${origin}/api/admin/accounts/${oh.account.id}/oversight`, {
      method: 'POST', headers: admin.headers, body: JSON.stringify({ granted: true }),
    })
    assert.equal(granted.status, 200)
    assert.equal((await granted.json()).account.oversight, true)

    // 권한이 붙은 세션으로 다시 들어온다.
    const ohAgain = await signIn(origin, OH)
    const allowed = await fetch(`${origin}/api/oversight/rooms/${room.id}`, { headers: ohAgain.headers })
    assert.equal(allowed.status, 200, '지정된 열람 권한자는 볼 수 있다')

    const revoked = await fetch(`${origin}/api/admin/accounts/${oh.account.id}/oversight`, {
      method: 'POST', headers: admin.headers, body: JSON.stringify({ granted: false }),
    })
    assert.equal(revoked.status, 200)

    const audit = await (await fetch(`${origin}/api/oversight/audit`, { headers: admin.headers })).json()
    assert.ok(audit.events.some((item) => item.event === '대화 열람 권한 부여'), '권한을 준 일도 기록이다')
    assert.ok(audit.events.some((item) => item.event === '대화 열람 권한 회수'), '거둔 일도 기록이다')
  })
})

test('관리자에게는 따로 권한을 줄 수 없다 — 이미 볼 수 있다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const response = await fetch(`${origin}/api/admin/accounts/${admin.account.id}/oversight`, {
      method: 'POST', headers: admin.headers, body: JSON.stringify({ granted: true }),
    })
    assert.equal(response.status, 409)
    assert.equal((await response.json()).error.code, 'ADMIN_ALWAYS_OVERSEES')
  })
})

test('열람 기록은 자기 회사 것만 보인다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const audit = await (await fetch(`${origin}/api/oversight/audit`, { headers: admin.headers })).json()
    assert.ok(audit.events.every((item) => item.tenantId === admin.account.tenantId), '테넌트 격리는 감사 기록에서도 지켜진다')
  })
})

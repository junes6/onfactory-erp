import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createApp } from './app.mjs'
import { UNKNOWN_ACTOR_NAME } from './notices.mjs'
import { withServer } from './test-server.mjs'

/**
 * 공지 라우트 — 판정 4("필독 공지를 올리면 대상자별 확인/미확인이 기록된다")의 서버 쪽 증명.
 *
 * 여기서 지키는 세 가지:
 *  1. 명단은 증거다 — 확인은 사람당 한 번, 두 번 눌러도 기록이 흔들리지 않는다.
 *  2. 남의 미확인 사실은 새지 않는다 — 대상자의 응답에는 다른 사람 이름이 하나도 없다.
 *  3. 못 찾은 것과 못 보는 것을 구분하지 않는다 — 안 보이는 공지는 404다.
 */

const TENANT = 'TENANT-SUNSEA'
const ADMIN = { id: 'USR-SUNSEA-ADMIN', name: '김서원', email: 'admin@sunsea.co.kr' }
const PARK = { id: 'USR-SUNSEA-PARK', name: '박지현', email: 'jihyun.park@sunsea.co.kr' }
const OH = { id: 'USR-SUNSEA-OH', name: '오태식', email: 'taesik.oh@sunsea.co.kr' }
/** 방에 남아 있는 퇴사 계정. 계정 비활성화는 participantIds를 정리하지 않으므로 이 자리는 평범하다. */
const RETIRED = { id: 'USR-SUNSEA-RETIRED', name: '한퇴직', email: 'retired@sunsea.co.kr' }
const GUEST = { id: 'USR-TENANT-SUNSEA-GUEST01', name: '홍거래', email: 'guest@partner.example', password: 'Guest!Pass2026' }
const GRANT_ID = 'GST-TENANT-SUNSEA-000001'
const ORG = '파트너상사'
/** 회사 로스터에서 승인된 내부 구성원 수(데모 계정 기준). 게스트와 승인 대기 계정은 빠진다. */
const COMPANY_ROSTER = 7
/** 회사 공지의 기본 대상 수 — 로스터에서 작성자 본인을 뺀다(자기 글을 자기가 확인할 일은 없다). */
const COMPANY_TARGETS = COMPANY_ROSTER - 1

const digestHex = (password, accountId) => scryptSync(String(password), `onfactory:${accountId}`, 32).toString('hex')
const room = (overrides) => ({ type: 'team', kind: 'group', name: '방', subtitle: '', unread: 0, lastMessage: '', lastTime: '', messages: [], ...overrides })

function seedStore() {
  return {
    version: 2,
    tenants: {
      [TENANT]: {
        'project-spaces': { data: [
          { id: 'PRJ-A', name: '파트너 협업 A', description: '', visibility: 'members', status: 'active', stage: '진행 중', client: ORG, amount: 0, ownerId: ADMIN.id, ownerName: ADMIN.name,
            members: [
              { id: ADMIN.id, name: ADMIN.name, role: 'owner' },
              { id: PARK.id, name: PARK.name, team: '품질관리', role: 'editor' },
              { id: OH.id, name: OH.name, team: '생산 1팀', role: 'viewer' },
              { id: GUEST.id, name: GUEST.name, team: ORG, role: 'viewer', kind: 'guest' },
            ], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
          { id: 'PRJ-B', name: '사내 프로젝트 B', description: '', visibility: 'members', status: 'active', stage: '준비', client: '', amount: 0, ownerId: ADMIN.id, ownerName: ADMIN.name,
            members: [{ id: ADMIN.id, name: ADMIN.name, role: 'owner' }, { id: PARK.id, name: PARK.name, role: 'editor' }], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
        ], updatedAt: '2026-09-01T00:00:00.000Z' },
        'messenger-conversations': { data: [
          room({ id: 'grp-R1', name: 'A 프로젝트 채널', projectId: 'PRJ-A', participantIds: [ADMIN.id, PARK.id, OH.id, GUEST.id], ownerId: ADMIN.id }),
          room({ id: 'grp-R2', name: '자유 그룹방', participantIds: [ADMIN.id, PARK.id], ownerId: ADMIN.id }),
          room({ id: 'grp-R3', name: 'B 프로젝트 채널', projectId: 'PRJ-B', participantIds: [ADMIN.id, PARK.id], ownerId: ADMIN.id }),
          // 같은 PRJ-A인데 게스트가 참여자가 아닌 '내부 전용' 방. 퇴사 계정과 시스템 계정도 남아 있다 —
          // 게스트 가시성과 기본 확인 대상, 두 규칙이 방을 실제로 보는지 이 방 하나가 함께 잰다.
          room({ id: 'grp-R4', name: 'A 프로젝트 내부방', projectId: 'PRJ-A', participantIds: [ADMIN.id, PARK.id, RETIRED.id, 'SYS-DEVELOPER-OPS'], ownerId: ADMIN.id }),
          {
            id: 'dm-support', type: 'direct', name: '개발운영진', subtitle: '', memberId: 'SYS-DEVELOPER-OPS',
            participantIds: ['SYS-DEVELOPER-OPS', ADMIN.id], systemChannel: 'developer-support', supportRequesterId: ADMIN.id,
            unread: 0, lastMessage: '', lastTime: '', messages: [],
          },
        ], updatedAt: '2026-09-01T00:00:00.000Z' },
      },
      'TENANT-POHANG': {},
    },
    platform: {},
    accountApprovals: { [GUEST.id]: 'approved', [RETIRED.id]: 'inactive' },
    accountCredentials: { [GUEST.id]: { passwordHash: digestHex(GUEST.password, GUEST.id), mustChangePassword: false, temporaryPasswordExpiresAt: null } },
    invitedAccounts: [
      { id: GUEST.id, email: GUEST.email, name: GUEST.name, tenantId: TENANT, tenantName: '햇살바다', team: ORG, jobRole: '외부 게스트', requested: '게스트 초대', role: 'tenant-guest', guestGrantId: GRANT_ID },
      { id: RETIRED.id, email: RETIRED.email, name: RETIRED.name, tenantId: TENANT, tenantName: '햇살바다', team: '생산 1팀', jobRole: '작업자', requested: '초대', role: 'tenant-member' },
    ],
    passwordResetRequests: [],
    guestGrants: [{
      id: GRANT_ID, tenantId: TENANT, accountId: GUEST.id, email: GUEST.email, name: GUEST.name, orgName: ORG, projectIds: ['PRJ-A'],
      invitedById: ADMIN.id, invitedByName: ADMIN.name, status: 'active', tokenHash: null, tokenIssuedAt: null, tokenExpiresAt: null,
      resendCount: 0, lastResentAt: null, accessExpiresAt: null, acceptedAt: '2026-09-01T00:00:00.000Z', revokedAt: null, revokedById: null, deactivatedAt: null,
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    }],
  }
}

const uploadDir = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onfactory-notice-')), 'documents')

async function withApp(run, { store = seedStore(), ...extra } = {}) {
  const app = createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {}, documentUploadDirectory: uploadDir(), ...extra })
  // app을 함께 넘긴다 — 24시간·48시간 잡은 app.locals.runNoticeAckWatch로만 손에 잡힌다(가짜 시계 주입).
  await withServer(app, (origin) => run(origin, store, app))
}

async function login(origin, email, password = 'demo1234') {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: 'tenant', email, password }),
  })
  assert.equal(response.status, 200, `${email} 로그인 실패`)
  const account = (await response.json()).account
  return {
    account,
    headers: { 'content-type': 'application/json', cookie: response.headers.get('set-cookie'), 'x-workspace-identity': `${account.tenantId}:${account.id}` },
  }
}

const post = (origin, session, path_, body) => fetch(`${origin}/api/notices${path_}`, {
  method: 'POST', headers: session.headers, body: JSON.stringify(body ?? {}),
})
const patch = (origin, session, path_, body) => fetch(`${origin}/api/notices${path_}`, {
  method: 'PATCH', headers: session.headers, body: JSON.stringify(body ?? {}),
})
const list = async (origin, session, query = '') => (await (await fetch(`${origin}/api/notices${query}`, { headers: session.headers })).json()).notices
const readJson = async (response) => { try { return await response.json() } catch { return null } }

/**
 * 응답 본문을 한 번만 읽고 상태를 확인한 뒤 파싱한다.
 * assert의 메시지 인자는 통과할 때도 평가되므로 `assert.equal(res.status, 201, await res.text())` 뒤에
 * `await res.json()`을 부르면 두 번째가 이미 읽힌 몸을 만나 TypeError가 난다.
 */
const expectJson = async (response, status) => {
  const text = await response.text()
  assert.equal(response.status, status, text)
  return JSON.parse(text)
}

const createCompanyNotice = async (origin, session, body = {}) => {
  const response = await post(origin, session, '', { scope: 'company', title: '9월 안전교육', body: '9월 12일 09:00\n대강당', mustRead: true, ...body })
  return (await expectJson(response, 201)).notice
}

// ─────────────────────────── 회사 공지 ───────────────────────────

test('회사 공지는 관리자만 올린다 — 구성원은 403, 게스트는 게이트가 먼저 막는다', async () => {
  await withApp(async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const park = await login(origin, PARK.email)
    const guest = await login(origin, GUEST.email, GUEST.password)

    const notice = await createCompanyNotice(origin, admin)
    assert.equal(notice.scope, 'company')
    assert.equal(notice.conversationId, null)
    assert.equal(notice.targetCount, COMPANY_TARGETS, '승인된 내부 구성원만 대상이다(게스트·승인 대기 제외)')
    assert.equal(notice.canAck, false, '작성자 자신은 확인 대상이 아니다')

    const memberTry = await post(origin, park, '', { scope: 'company', title: '몰래', body: '본문' })
    assert.equal(memberTry.status, 403)
    assert.equal((await memberTry.json()).error.code, 'NOTICE_ADMIN_REQUIRED')

    const guestTry = await post(origin, guest, '', { scope: 'company', title: '몰래', body: '본문' })
    assert.equal(guestTry.status, 403)
    assert.deepEqual(await guestTry.json(), { error: { code: 'GUEST_SCOPE_FORBIDDEN', message: '초대된 프로젝트 안에서만 사용할 수 있습니다.' } })

    // 작성자 자신에게는 게시 알림이 가지 않는다.
    const feed = await (await fetch(`${origin}/api/notifications`, { headers: admin.headers })).json()
    assert.equal(feed.items.filter((item) => item.type === 'notice-posted').length, 0)
    const parkFeed = await (await fetch(`${origin}/api/notifications`, { headers: park.headers })).json()
    const posted = parkFeed.items.filter((item) => item.type === 'notice-posted')
    assert.equal(posted.length, 1)
    assert.match(posted[0].title, /^\[필독\] /)
    assert.equal(posted[0].focusId, `company:notice:${notice.id}`)
  })
})

test('대상자는 기본 집합 안에서만 고를 수 있다 — 밖의 id는 조용히 버리지 않고 400이다', async () => {
  await withApp(async (origin) => {
    const admin = await login(origin, ADMIN.email)
    for (const targetIds of [[PARK.id, 'USR-POHANG-ADMIN'], [PARK.id, GUEST.id], [PARK.id, 'USR-NOBODY']]) {
      const response = await post(origin, admin, '', { scope: 'company', title: '대상 실험', body: '본문', targetIds })
      assert.equal(response.status, 400, JSON.stringify(targetIds))
      assert.equal((await response.json()).error.code, 'INVALID_NOTICE_TARGETS')
    }
    const narrowed = await createCompanyNotice(origin, admin, { targetIds: [PARK.id, OH.id] })
    assert.equal(narrowed.targetCount, 2, '좁히는 것만 통과한다')

    // 전원을 체크 해제한 것은 '밖에서 골랐다'와 다른 사실이다. 한 문장이 둘을 겸하면
    // 기본 대상자 안에만 머문 사람이 자기가 하지 않은 잘못을 읽는다.
    const empty = await post(origin, admin, '', { scope: 'company', title: '빈 대상', body: '본문', targetIds: [] })
    assert.equal(empty.status, 400)
    const emptyError = (await empty.json()).error
    assert.equal(emptyError.code, 'NOTICE_TARGETS_EMPTY')
    assert.match(emptyError.message, /한 명도 남지 않았습니다/)
    assert.doesNotMatch(emptyError.message, /기본 대상자 안에서만/)
  })
})

test('승인된 사람이 관리자 하나뿐인 테넌트도 공지를 올린다 — 지울 사람이 없던 것은 지운 것이 아니다', async () => {
  // 워크스페이스의 첫날. 직원 승인 전에는 기본 대상이 비어 있는데, 여기서 400을 내면 그 회사는
  // 공지를 한 건도 못 올린다 — 게다가 화면에는 되돌릴 '체크 해제'가 없어 문장이 시키는 일을 할 수 없다.
  await withApp(async (origin) => {
    const admin = await login(origin, 'admin@pohangcoop.co.kr')
    assert.equal(admin.account.tenantId, 'TENANT-POHANG')

    const plain = await post(origin, admin, '', { scope: 'company', title: '첫 공지', body: '환영합니다.' })
    const created = (await expectJson(plain, 201)).notice
    assert.equal(created.targetCount, 0)

    // 필독도 같다. 빈 명단은 저장해도 안전하다 — 확인할 사람이 없으니 canAck는 false고,
    // 다시 알림은 '보낼 사람이 없다'로 답한다(따를 수 없는 문장을 보내지 않는다).
    const mustRead = await post(origin, admin, '', { scope: 'company', title: '첫 필독', body: '읽어 주세요.', mustRead: true })
    const strict = (await expectJson(mustRead, 201)).notice
    assert.equal(strict.targetCount, 0)
    assert.equal(strict.canAck, false)
    const remind = await post(origin, admin, `/${strict.id}/remind`)
    assert.equal(remind.status, 409)
    assert.equal((await remind.json()).error.code, 'NOTICE_ALL_CONFIRMED')

    // 저장된 행이 shape 게이트를 통과해야 다음 쓰기가 막히지 않는다(빈 targetIds도 성한 행이다).
    assert.equal((await list(origin, admin)).length, 2)
    const again = await patch(origin, admin, `/${created.id}`, { body: '환영합니다. 잘 부탁드립니다.' })
    assert.equal(again.status, 200)
  })
})

test('기본 대상만으로 상한을 넘으면 그 사실을 말한다 — 아무도 고르지 않은 사람에게 "밖에서 골랐다"고 하지 않는다', async () => {
  const store = seedStore()
  // 승인된 내부 구성원 521명(관리자 1 + 초대 520). 작성자를 뺀 기본 대상이 520명이라 상한(500)을 넘는다.
  for (let index = 0; index < 520; index += 1) {
    const id = `USR-POHANG-BULK-${String(index).padStart(3, '0')}`
    store.invitedAccounts.push({ id, email: `bulk${index}@pohangcoop.co.kr`, name: `직원${index}`, tenantId: 'TENANT-POHANG', tenantName: '포항시수산가공협동조합', team: '가공팀', jobRole: '작업자', requested: '초대', role: 'tenant-member' })
    store.accountApprovals[id] = 'approved'
  }
  await withApp(async (origin) => {
    const admin = await login(origin, 'admin@pohangcoop.co.kr')
    const response = await post(origin, admin, '', { scope: 'company', title: '전사 공지', body: '본문' })
    assert.equal(response.status, 400)
    const error = (await response.json()).error
    assert.equal(error.code, 'NOTICE_TARGETS_TOO_MANY')
    assert.match(error.message, /500명까지/)
    // '밖에서 골랐다'는 다른 사실이다. 아무것도 고르지 않은 사람이 그 문장을 읽으면 안 된다.
    assert.doesNotMatch(error.message, /기본 대상자 안에서만/)
    // 문장은 화면이 할 수 있는 일만 시킨다. '채널 공지로 나눠 올려 주세요'는 회사 전원에게 닿지 않고
    // (전사 채널에는 projectId가 없어 400이다), 확인 대상 목록은 필독일 때만 열려 좁힐 길도 없다.
    assert.doesNotMatch(error.message, /채널 공지로 나눠/)
    assert.match(error.message, /개발운영진/)
  }, { store })
})

test('컴포저가 그리는 명단과 서버의 기본 대상 집합이 같은 사람들이다', async () => {
  await withApp(async (origin) => {
    const admin = await login(origin, ADMIN.email)
    // 컴포저(NoticeCenter.tsx)가 회사 공지의 '확인 대상'을 만드는 규칙 그대로: 시스템 계정·비활성·게스트를 빼고,
    // 작성자 본인을 뺀다. 이 집합을 그대로 보내면 201이어야 화면의 '한 명 체크 해제'가 동작한다.
    const { members } = await (await fetch(`${origin}/api/directory`, { headers: admin.headers })).json()
    const roster = members.filter((person) => !person.system && person.active !== false && person.kind !== 'guest')
    const audience = roster.filter((person) => person.id !== ADMIN.id).map((person) => person.id)
    assert.equal(audience.length, COMPANY_TARGETS, '화면이 세는 인원과 서버가 세는 인원이 같아야 한다')

    const all = await createCompanyNotice(origin, admin, { targetIds: audience })
    assert.equal(all.targetCount, COMPANY_TARGETS)
    const narrowed = await createCompanyNotice(origin, admin, { targetIds: audience.slice(0, -1) })
    assert.equal(narrowed.targetCount, COMPANY_TARGETS - 1, '한 명을 빼는 것이 이 목록의 유일한 조작이다')

    // 작성자를 남겨 두면 기본 대상자 밖이라 400이다 — 화면이 작성자를 빼야 하는 이유가 이것이다.
    const withAuthor = await post(origin, admin, '', { scope: 'company', title: '작성자 포함', body: '본문', targetIds: [...audience, ADMIN.id] })
    assert.equal(withAuthor.status, 400)
    assert.equal((await withAuthor.json()).error.code, 'INVALID_NOTICE_TARGETS')
  })
})

test('프로젝트 채널의 기본 확인 대상도 로스터를 지난다 — 방에 남은 퇴사·시스템 계정은 대상이 아니다', async () => {
  await withApp(async (origin) => {
    const admin = await login(origin, ADMIN.email)
    // 컴포저(NoticeCenter.tsx)가 채널 공지의 '확인 대상'을 만드는 규칙 그대로:
    // /api/directory에서 system·active===false를 빼고, 그 방의 participantIds와 교집합하고, 작성자를 뺀다.
    const { members } = await (await fetch(`${origin}/api/directory`, { headers: admin.headers })).json()
    assert.ok(members.some((person) => person.id === RETIRED.id && person.active === false), '퇴사 계정은 명단에 남되 active:false다')
    const participants = new Set([ADMIN.id, PARK.id, RETIRED.id, 'SYS-DEVELOPER-OPS'])
    const audience = members
      .filter((person) => !person.system && person.active !== false && participants.has(person.id) && person.id !== ADMIN.id)
      .map((person) => person.id)
    assert.deepEqual(audience, [PARK.id], '화면이 그리는 명단은 살아 있는 참여자 한 사람뿐이다')

    const created = await post(origin, admin, '', { scope: 'project', conversationId: 'grp-R4', title: '내부 점검', body: '본문', mustRead: true })
    const notice = (await expectJson(created, 201)).notice
    assert.equal(notice.targetCount, audience.length, '작성자가 화면에서 센 인원과 서버가 센 인원이 같아야 한다')
    assert.deepEqual(notice.targetIds, audience)

    // 미확인 명단에도 죽은 계정이 실리지 않는다 — 실리면 그 수는 영영 0이 되지 않고,
    // 다시 알림과 48시간 요약이 계속 그들을 나른다.
    const detail = await (await fetch(`${origin}/api/notices/${notice.id}`, { headers: admin.headers })).json()
    assert.deepEqual(detail.unconfirmed.map((row) => row.accountId), audience)
    assert.equal(JSON.stringify(detail).includes(UNKNOWN_ACTOR_NAME), false, '이름을 못 찾는 대상이 명단에 남아 있으면 안 된다')
  })
})

test('제목과 본문은 같은 문을 지난다 — 상한을 넘긴 글은 조용히 잘리지 않고 400이다', async () => {
  await withApp(async (origin) => {
    const admin = await login(origin, ADMIN.email)

    const tooLong = await post(origin, admin, '', { scope: 'company', title: '긴 글', body: 'ㄱ'.repeat(20_001) })
    assert.equal(tooLong.status, 400, '20,000자를 넘긴 본문은 잘려 저장되지 않는다')
    assert.equal((await tooLong.json()).error.code, 'NOTICE_BODY_INVALID')

    const scripted = await post(origin, admin, '', { scope: 'company', title: '경고 <script>alert(1)</script>', body: '본문' })
    assert.equal(scripted.status, 400, '제목은 알림·요약·검색·웹훅으로 그대로 흘러간다')
    assert.equal((await scripted.json()).error.code, 'NOTICE_TITLE_INVALID')

    const notice = await createCompanyNotice(origin, admin, { title: '9월\n안전교육' })
    assert.equal(notice.title, '9월 안전교육', '제목의 줄바꿈은 한 칸으로 접힌다')

    // 탭도 같은 한 칸이다. 정제와 판정이 서로 다른 제어문자 범위를 들면 이 입력이 라우트의 400을
    // 지나 자체검사(도달 불가능해야 하는 자리)에 걸려 500 NOTICE_WRITE_FAILED로 되돌아온다 —
    // 표에서 제목을 붙여 넣는 평범한 길이고, 그 문장은 무엇을 고쳐야 하는지 한 마디도 하지 않는다.
    const tabbed = await createCompanyNotice(origin, admin, { title: '9월\t안전교육' })
    assert.equal(tabbed.title, '9월 안전교육')
    const tabbedPatch = await patch(origin, admin, `/${tabbed.id}`, { title: '수정\t제목' })
    assert.equal((await expectJson(tabbedPatch, 200)).notice.title, '수정 제목')

    const patched = await patch(origin, admin, `/${notice.id}`, { body: 'ㄱ'.repeat(20_001) })
    assert.equal(patched.status, 400)
    assert.equal((await patched.json()).error.code, 'NOTICE_BODY_INVALID')
  })
})

// ─────────────────────────── 프로젝트 공지 ───────────────────────────

test('프로젝트 공지는 채널이 프로젝트에 붙어 있고 owner/editor일 때만 올라간다', async () => {
  await withApp(async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const park = await login(origin, PARK.email)
    const oh = await login(origin, OH.email)

    const created = await post(origin, park, '', { scope: 'project', conversationId: 'grp-R1', title: '도면 확인 요청', body: '금요일까지 확인 부탁드립니다.' })
    const notice = (await expectJson(created, 201)).notice
    assert.equal(notice.projectId, 'PRJ-A')
    assert.equal(notice.conversationId, 'grp-R1')

    const viewer = await post(origin, oh, '', { scope: 'project', conversationId: 'grp-R1', title: 'viewer', body: '본문' })
    assert.equal(viewer.status, 403)
    assert.equal((await viewer.json()).error.code, 'PROJECT_EDITOR_REQUIRED')

    const freeRoom = await post(origin, admin, '', { scope: 'project', conversationId: 'grp-R2', title: '자유방', body: '본문' })
    assert.equal(freeRoom.status, 400)
    assert.equal((await freeRoom.json()).error.code, 'NOTICE_CHANNEL_NOT_PROJECT')

    const support = await post(origin, admin, '', { scope: 'project', conversationId: 'dm-support', title: '지원', body: '본문' })
    assert.equal(support.status, 403)
    assert.equal((await support.json()).error.code, 'SYSTEM_CONVERSATION_IMMUTABLE')

    // 안 보이는 방은 404다 — 403이면 "그 방이 있다"를 알려 주는 존재 오라클이 된다.
    const hidden = await post(origin, oh, '', { scope: 'project', conversationId: 'grp-R3', title: '남의 방', body: '본문' })
    assert.equal(hidden.status, 404)
    assert.equal((await hidden.json()).error.code, 'CONVERSATION_NOT_FOUND')

    // 회사 공지에 채널을 끼워 넣을 수 없다.
    const mixed = await post(origin, admin, '', { scope: 'company', conversationId: 'grp-R1', title: '섞기', body: '본문' })
    assert.equal(mixed.status, 400)
    assert.equal((await mixed.json()).error.code, 'INVALID_NOTICE_SCOPE')
  })
})

// ─────────────────────────── 확인 ───────────────────────────

test('확인은 사람당 한 번이고, 두 번 눌러도 기록과 updatedAt이 흔들리지 않는다', async () => {
  await withApp(async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const park = await login(origin, PARK.email)
    const oh = await login(origin, OH.email)
    const notice = await createCompanyNotice(origin, admin, { targetIds: [PARK.id] })

    const first = await post(origin, park, `/${notice.id}/ack`)
    assert.equal(first.status, 200)
    const afterFirst = (await first.json()).notice
    assert.ok(afterFirst.acknowledgedAt)

    const second = await post(origin, park, `/${notice.id}/ack`)
    assert.equal(second.status, 200, '멱등이다 — 두 번째는 커밋 없이 200이다')
    const afterSecond = (await second.json()).notice
    assert.equal(afterSecond.acknowledgedAt, afterFirst.acknowledgedAt)
    assert.equal(afterSecond.updatedAt, afterFirst.updatedAt)
    // 인원수는 관리 권한이 있는 쪽에서만 센다 — 대상자의 응답에는 실리지 않는다.
    assert.equal(afterSecond.confirmedCount, undefined)
    const byAuthor = await (await fetch(`${origin}/api/notices/${notice.id}`, { headers: admin.headers })).json()
    assert.equal(byAuthor.notice.confirmedCount, 1)

    const notTargeted = await post(origin, oh, `/${notice.id}/ack`)
    assert.equal(notTargeted.status, 403)
    assert.equal((await notTargeted.json()).error.code, 'NOTICE_NOT_TARGETED')

    const optional = await createCompanyNotice(origin, admin, { mustRead: false, targetIds: [PARK.id] })
    const optionalAck = await post(origin, park, `/${optional.id}/ack`)
    assert.equal(optionalAck.status, 409)
    assert.equal((await optionalAck.json()).error.code, 'NOTICE_ACK_NOT_REQUIRED')

    await post(origin, admin, `/${notice.id}/archive`, { archived: true })
    const archivedAck = await post(origin, park, `/${notice.id}/ack`)
    assert.equal(archivedAck.status, 409)
    assert.equal((await archivedAck.json()).error.code, 'NOTICE_ARCHIVED')
  })
})

test('명단은 관리 권한이 있을 때만 실린다 — 대상자의 응답에는 다른 사람 이름이 하나도 없다', async () => {
  await withApp(async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const park = await login(origin, PARK.email)
    const notice = await createCompanyNotice(origin, admin, { targetIds: [PARK.id, OH.id] })

    const authorView = await (await fetch(`${origin}/api/notices/${notice.id}`, { headers: admin.headers })).json()
    assert.equal(authorView.confirmed.length, 0)
    assert.equal(authorView.unconfirmed.length, 2)
    assert.ok(authorView.notice.targetIds)

    const targetView = await (await fetch(`${origin}/api/notices/${notice.id}`, { headers: park.headers })).json()
    assert.deepEqual(targetView.confirmed, [])
    assert.deepEqual(targetView.unconfirmed, [])
    assert.equal(targetView.notice.targetIds, undefined)
    assert.equal(targetView.notice.acknowledgements, undefined)
    // 인원수도 명단이다. 이름이 없어도 '아직 1명이 안 눌렀다'는 남의 근태를 짐작하게 한다.
    assert.equal(targetView.notice.targetCount, undefined)
    assert.equal(targetView.notice.confirmedCount, undefined)
    const serialized = JSON.stringify(targetView)
    assert.equal(serialized.includes(OH.name), false, '다른 사람 이름이 새면 안 된다')
    assert.equal(serialized.includes(OH.id), false)
  })
})

// ─────────────────────────── 게스트 ───────────────────────────

test('게스트는 초대된 프로젝트 채널의 공지만 보고, 확인만 누른다', async () => {
  await withApp(async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const guest = await login(origin, GUEST.email, GUEST.password)

    const company = await createCompanyNotice(origin, admin)
    const projectNotice = (await (await post(origin, admin, '', { scope: 'project', conversationId: 'grp-R1', title: '현장 출입 안내', body: '정문으로 오세요.', mustRead: true })).json()).notice
    await post(origin, admin, '', { scope: 'project', conversationId: 'grp-R3', title: '사내 전용', body: '본문' })
    // 초대된 프로젝트(PRJ-A)지만 게스트가 참여자가 아닌 방. 프로젝트 소속만 보면 이 공지가 통째로 샌다 —
    // 같은 방의 메시지는 이미 404인데(participantIds) 공지만 다른 문을 쓰면 안 된다.
    const insideRoom = (await (await post(origin, admin, '', { scope: 'project', conversationId: 'grp-R4', title: '내부 전용', body: '목표 단가 8% 인하 검토' })).json()).notice

    const seen = await list(origin, guest)
    assert.deepEqual(seen.map((item) => item.id), [projectNotice.id], '회사 공지와 안 들어가는 방의 공지는 목록에 없다')
    assert.equal(JSON.stringify(seen).includes('사내 전용'), false)
    assert.equal(JSON.stringify(seen).includes('목표 단가'), false, '초대되지 않은 채널의 본문은 한 글자도 내려가지 않는다')

    const companyDetail = await fetch(`${origin}/api/notices/${company.id}`, { headers: guest.headers })
    assert.equal(companyDetail.status, 404, '못 보는 공지는 404다')
    const insideDetail = await fetch(`${origin}/api/notices/${insideRoom.id}`, { headers: guest.headers })
    assert.equal(insideDetail.status, 404, '같은 프로젝트라도 참여자가 아닌 방의 공지는 404다')
    // 같은 방의 메시지가 이미 그렇게 답한다 — 두 문이 같은 조건을 본다는 것이 이 절의 요지다.
    const insideMessages = await fetch(`${origin}/api/messenger/conversations/grp-R4/messages`, { headers: guest.headers })
    assert.equal(insideMessages.status, 404)
    // 내부 구성원의 규칙은 좁히지 않았다 — 오태식은 grp-R4 참여자가 아니지만 PRJ-A 멤버이므로 본다.
    const oh = await login(origin, OH.email)
    assert.ok((await list(origin, oh)).some((item) => item.id === insideRoom.id), '프로젝트 멤버는 방에 없어도 그 프로젝트의 공지를 본다')

    const ack = await post(origin, guest, `/${projectNotice.id}/ack`)
    assert.equal(ack.status, 200)
    assert.ok((await ack.json()).notice.acknowledgedAt)

    for (const [method, path_] of [['POST', `/${projectNotice.id}/remind`], ['POST', `/${projectNotice.id}/archive`], ['PATCH', `/${projectNotice.id}`]]) {
      const blocked = await fetch(`${origin}/api/notices${path_}`, { method, headers: guest.headers, body: JSON.stringify({}) })
      assert.equal(blocked.status, 403, `${method} ${path_}`)
      assert.deepEqual(await blocked.json(), { error: { code: 'GUEST_SCOPE_FORBIDDEN', message: '초대된 프로젝트 안에서만 사용할 수 있습니다.' } })
    }
  })
})

// ─────────────────────────── 수정·보관 ───────────────────────────

test('PATCH는 범위·작성자·확인 기록을 건드리지 못하고, 대상을 좁히면 밖으로 나간 기록도 함께 지운다', async () => {
  await withApp(async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const park = await login(origin, PARK.email)
    const oh = await login(origin, OH.email)
    const notice = await createCompanyNotice(origin, admin, { targetIds: [PARK.id, OH.id] })
    await post(origin, park, `/${notice.id}/ack`)
    await post(origin, oh, `/${notice.id}/ack`)

    const immutable = await patch(origin, admin, `/${notice.id}`, { scope: 'project' })
    assert.equal(immutable.status, 400)
    assert.equal((await immutable.json()).error.code, 'NOTICE_SCOPE_IMMUTABLE')

    const narrowed = await patch(origin, admin, `/${notice.id}`, { title: '9월 안전교육(변경)', targetIds: [PARK.id] })
    const updated = (await expectJson(narrowed, 200)).notice
    assert.equal(updated.title, '9월 안전교육(변경)')
    assert.equal(updated.targetCount, 1)
    assert.equal(updated.confirmedCount, 1, '대상에서 빠진 사람의 확인 기록도 함께 사라진다')
    assert.deepEqual(updated.acknowledgements.map((row) => row.accountId), [PARK.id])

    // 저장된 행이 여전히 shape 게이트를 통과해야 다음 쓰기가 막히지 않는다.
    const again = await patch(origin, admin, `/${notice.id}`, { body: '장소가 바뀌었습니다.' })
    assert.equal(again.status, 200)

    // 다룰 수 없는 사람은 403이다(볼 수는 있으므로 404로 숨기지 않는다).
    const byOther = await patch(origin, park, `/${notice.id}`, { title: '남의 공지' })
    assert.equal(byOther.status, 403)
    assert.equal((await byOther.json()).error.code, 'NOTICE_MANAGE_FORBIDDEN')
  })
})

test('보관하면 목록에서 내려가고 보관함에만 남으며, 되살릴 수 있다', async () => {
  await withApp(async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const notice = await createCompanyNotice(origin, admin)

    assert.equal((await post(origin, admin, `/${notice.id}/archive`, { archived: true })).status, 200)
    assert.deepEqual((await list(origin, admin)).map((item) => item.id), [])
    assert.deepEqual((await list(origin, admin, '?archived=1')).map((item) => item.id), [notice.id])

    assert.equal((await post(origin, admin, `/${notice.id}/archive`, { archived: false })).status, 200)
    assert.deepEqual((await list(origin, admin)).map((item) => item.id), [notice.id])
  })
})

test('보관한 필독에는 다시 알림이 나가지 않는다 — ack가 거절하는 공지를 확인하라고 부를 수는 없다', async () => {
  await withApp(async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const park = await login(origin, PARK.email)
    const notice = await createCompanyNotice(origin, admin, { title: '보관 실험', targetIds: [PARK.id] })
    assert.equal((await post(origin, admin, `/${notice.id}/archive`, { archived: true })).status, 200)

    const remind = await post(origin, admin, `/${notice.id}/remind`)
    assert.equal(remind.status, 409)
    // ack 라우트와 같은 코드·같은 문장이다(둘 다 같은 상수를 쓴다).
    assert.equal((await remind.json()).error.code, 'NOTICE_ARCHIVED')

    // 알림함에 따를 수 없는 문장이 쌓이지 않는다. 눌러 봤자 그 공지는 목록에 없고 ack는 409다.
    const feed = await (await fetch(`${origin}/api/notifications`, { headers: park.headers })).json()
    assert.equal(feed.items.filter((item) => item.type === 'notice-reminder').length, 0)
    const ack = await post(origin, park, `/${notice.id}/ack`)
    assert.equal(ack.status, 409)
    assert.equal((await ack.json()).error.code, 'NOTICE_ARCHIVED')
    assert.deepEqual(await list(origin, park), [], '보관된 공지는 대상자 목록에서 아예 내려간다')
  })
})

// ─────────────────────────── 다시 알림 ───────────────────────────

test('다시 알림은 미확인자에게만 가고, 한 시간 안에 다시 부르면 409에 남은 분이 실린다', async () => {
  await withApp(async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const park = await login(origin, PARK.email)
    const notice = await createCompanyNotice(origin, admin, { targetIds: [PARK.id, OH.id] })

    const first = await post(origin, admin, `/${notice.id}/remind`)
    assert.equal(first.status, 200)
    assert.equal((await first.json()).reminded, 2)

    const tooSoon = await post(origin, admin, `/${notice.id}/remind`)
    assert.equal(tooSoon.status, 409, '429가 아니다 — 전송 레이트 리밋이 아니라 업무 규칙 거절이다')
    const error = (await tooSoon.json()).error
    assert.equal(error.code, 'NOTICE_REMIND_TOO_SOON')
    assert.ok(Number.isInteger(error.retryAfterMinutes) && error.retryAfterMinutes > 0)

    const parkFeed = await (await fetch(`${origin}/api/notifications`, { headers: park.headers })).json()
    assert.equal(parkFeed.items.filter((item) => item.type === 'notice-reminder').length, 1)

    // 다룰 수 없는 사람은 403이다.
    const byMember = await post(origin, park, `/${notice.id}/remind`)
    assert.equal(byMember.status, 403)
  })
})

test('필독이 아닌 공지에는 다시 알림이 나가지 않는다 — 받는 사람이 따를 수 없는 문장이다', async () => {
  await withApp(async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const park = await login(origin, PARK.email)
    const notice = await createCompanyNotice(origin, admin, { mustRead: false, targetIds: [PARK.id] })

    const response = await post(origin, admin, `/${notice.id}/remind`)
    assert.equal(response.status, 409)
    // ack 라우트와 같은 코드·같은 문장이다.
    assert.equal((await response.json()).error.code, 'NOTICE_ACK_NOT_REQUIRED')

    const feed = await (await fetch(`${origin}/api/notifications`, { headers: park.headers })).json()
    assert.equal(feed.items.filter((item) => item.type === 'notice-reminder').length, 0)
  })
})

test('전원이 확인했으면 다시 알림은 409다 — 보낼 사람이 없다', async () => {
  await withApp(async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const park = await login(origin, PARK.email)
    const notice = await createCompanyNotice(origin, admin, { targetIds: [PARK.id] })
    await post(origin, park, `/${notice.id}/ack`)

    const response = await post(origin, admin, `/${notice.id}/remind`)
    assert.equal(response.status, 409)
    assert.equal((await response.json()).error.code, 'NOTICE_ALL_CONFIRMED')
  })
})

// ─────────────────────────── 저장소 방어 ───────────────────────────

test('깨진 공지 행이 있으면 읽기는 성한 행만, 쓰기는 409로 멈춘다', async () => {
  const store = seedStore()
  const healthy = {
    id: 'NTC-seed-0011aa', scope: 'company', conversationId: null, projectId: null,
    title: '성한 공지', body: '본문', attachments: [], authorId: ADMIN.id, authorName: ADMIN.name,
    mustRead: true, targetIds: [PARK.id], acknowledgements: [],
    reminders: { remindedAt: {}, summary48SentAt: null, lastManualRemindAt: null },
    archivedAt: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  }
  store.tenants[TENANT].notices = { data: [healthy, { ...healthy, id: 'NTC-bad-0011bb', extraKey: 1 }], updatedAt: '2026-09-01T00:00:00.000Z' }
  await withApp(async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const park = await login(origin, PARK.email)
    assert.deepEqual((await list(origin, admin)).map((item) => item.id), [healthy.id], '읽기는 성한 행만 내보낸다')

    for (const response of [
      await post(origin, admin, '', { scope: 'company', title: '새 공지', body: '본문' }),
      await patch(origin, admin, `/${healthy.id}`, { title: '고치기' }),
      await post(origin, park, `/${healthy.id}/ack`),
    ]) {
      assert.equal(response.status, 409)
      assert.equal((await response.json()).error.code, 'NOTICE_DATA_INVALID')
    }
  }, { store })
})

test('generic 저장 경로는 공지의 존재 자체를 모른다 — 403이 아니라 404다', async () => {
  await withApp(async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const get = await fetch(`${origin}/api/workspace/notices`, { headers: admin.headers })
    assert.equal(get.status, 404)
    assert.equal((await get.json()).error.code, 'STORE_KEY_NOT_FOUND')
    const put = await fetch(`${origin}/api/workspace/notices`, { method: 'PUT', headers: admin.headers, body: JSON.stringify({ data: [] }) })
    assert.equal(put.status, 404)
    assert.equal((await put.json()).error.code, 'STORE_KEY_NOT_FOUND')
  })
})

test('저장에 실패하면 500이고 공지 건수는 그대로다', async () => {
  const store = seedStore()
  let armed = false
  await withApp(async (origin) => {
    const admin = await login(origin, ADMIN.email)
    await createCompanyNotice(origin, admin)
    armed = true
    const response = await post(origin, admin, '', { scope: 'company', title: '실패할 공지', body: '본문' })
    assert.equal(response.status, 500)
    assert.equal((await response.json()).error.code, 'NOTICE_WRITE_FAILED')
    armed = false
    assert.equal((await list(origin, admin)).length, 1, '실패한 쓰기는 목록에 남지 않는다')
  }, { store, onWorkspaceStoreChange: () => { if (armed) throw new Error('disk full') } })
})

// ─────────────────────────── 첨부 ───────────────────────────

test('첨부는 서버가 이름·용량을 다시 채우고, 보관 전까지 그 문서를 지울 수 없다', async () => {
  await withApp(async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const park = await login(origin, PARK.email)

    const params = new URLSearchParams({ name: '점검표.pdf', category: '사내공지', visibility: 'restricted', summary: '', tags: 'notice' })
    const upload = await fetch(`${origin}/api/documents?${params}`, {
      method: 'POST',
      headers: { ...admin.headers, 'content-type': 'application/octet-stream', 'x-file-type': 'application/pdf', 'x-file-name': encodeURIComponent('점검표.pdf') },
      body: 'hello-notice',
    })
    const document = (await expectJson(upload, 201)).document

    const created = await post(origin, admin, '', {
      scope: 'company', title: '첨부 공지', body: '점검표를 확인해 주세요.', mustRead: true, targetIds: [PARK.id],
      attachments: [{ id: document.id, name: '가짜.pdf', size: '999 GB' }],
    })
    const notice = (await expectJson(created, 201)).notice
    assert.equal(notice.attachments[0].name, '점검표.pdf', '클라이언트가 보낸 이름을 그대로 믿지 않는다')
    assert.notEqual(notice.attachments[0].size, '999 GB')

    // 대상자에게 열람 권한이 붙는다.
    const download = await fetch(`${origin}/api/documents/${document.id}/download`, { headers: park.headers })
    assert.equal(download.status, 200)

    const inUse = await fetch(`${origin}/api/documents/${document.id}`, { method: 'DELETE', headers: admin.headers })
    assert.equal(inUse.status, 409)
    assert.equal((await readJson(inUse)).error.code, 'DOCUMENT_IN_USE')

    // 보관한 공지의 첨부는 참조에서 빠진다 — 그러지 않으면 삭제 라우트가 없어 영영 못 지운다.
    await post(origin, admin, `/${notice.id}/archive`, { archived: true })
    const removable = await fetch(`${origin}/api/documents/${document.id}`, { method: 'DELETE', headers: admin.headers })
    assert.equal(removable.status, 200, await removable.text())
  })
})

test('첨부는 열 수 있는 사람에게만 목록으로 실린다 — 보이는데 눌러도 404가 나는 자리를 두지 않는다', async () => {
  await withApp(async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const park = await login(origin, PARK.email)
    const oh = await login(origin, OH.email)

    const params = new URLSearchParams({ name: '임원자료.pdf', category: '사내공지', visibility: 'restricted', summary: '', tags: 'notice' })
    const upload = await fetch(`${origin}/api/documents?${params}`, {
      method: 'POST',
      headers: { ...admin.headers, 'content-type': 'application/octet-stream', 'x-file-type': 'application/pdf', 'x-file-name': encodeURIComponent('임원자료.pdf') },
      body: 'hello-restricted',
    })
    const document = (await expectJson(upload, 201)).document

    // 대상을 박지현 한 명으로 좁힌 회사 공지. 오태식은 공지 자체는 보지만 첨부는 열 수 없다.
    const notice = (await expectJson(await post(origin, admin, '', {
      scope: 'company', title: '임원 대상 공지', body: '본문', mustRead: true, targetIds: [PARK.id],
      attachments: [{ id: document.id, name: '임원자료.pdf', size: '1 KB' }],
    }), 201)).notice

    const seenByTarget = (await list(origin, park)).find((item) => item.id === notice.id)
    assert.equal(seenByTarget.attachments.length, 1)
    assert.equal((await fetch(`${origin}/api/documents/${document.id}/download`, { headers: park.headers })).status, 200)

    const seenByOther = (await list(origin, oh)).find((item) => item.id === notice.id)
    assert.deepEqual(seenByOther.attachments, [], '열 수 없는 첨부는 목록에 싣지 않는다')
    assert.equal(seenByOther.attachmentCount, 1, '몇 개가 붙어 있는지는 알려 준다 — 가짜 0을 만들지 않는다')
    assert.equal((await fetch(`${origin}/api/documents/${document.id}/download`, { headers: oh.headers })).status, 404)

    // 작성자는 언제나 자기 공지의 첨부를 본다.
    const seenByAuthor = (await list(origin, admin)).find((item) => item.id === notice.id)
    assert.equal(seenByAuthor.attachments.length, 1)
  })
})

test('첨부 열람 권한은 공지와 같은 커밋에 실린다 — 재기동 뒤에 권한만 사라지지 않는다', async () => {
  const commits = []
  await withApp(async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const park = await login(origin, PARK.email)

    const params = new URLSearchParams({ name: '점검표2.pdf', category: '사내공지', visibility: 'restricted', summary: '', tags: 'notice' })
    const upload = await fetch(`${origin}/api/documents?${params}`, {
      method: 'POST',
      headers: { ...admin.headers, 'content-type': 'application/octet-stream', 'x-file-type': 'application/pdf', 'x-file-name': encodeURIComponent('점검표2.pdf') },
      body: 'hello-commit',
    })
    const document = (await expectJson(upload, 201)).document
    const notice = await createCompanyNotice(origin, admin, { targetIds: [PARK.id] })

    commits.length = 0
    const patched = await patch(origin, admin, `/${notice.id}`, { attachments: [{ id: document.id, name: 'x', size: '1 KB' }] })
    assert.equal(patched.status, 200, await patched.text())

    // 커밋 스냅샷 자체에 allowedUserIds가 들어 있어야 한다. 커밋 뒤에 부여하면 이 배열이 비어 있고,
    // 재기동하면 공지에는 첨부가 실려 있는데 대상자는 그 파일을 못 받는다.
    const snapshot = commits.at(-1)
    const stored = snapshot.tenants[TENANT]['company-documents'].data.find((item) => item.id === document.id)
    assert.ok(stored.allowedUserIds.includes(PARK.id), '대상자의 열람 권한이 같은 커밋에 실려야 한다')
  }, { onWorkspaceStoreChange: (store) => { commits.push(JSON.parse(JSON.stringify(store))) } })
})

test('열람할 수 없는 문서를 첨부하면 400이다', async () => {
  await withApp(async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const response = await post(origin, admin, '', { scope: 'company', title: '없는 첨부', body: '본문', attachments: [{ id: 'DOC-NOPE', name: 'x', size: '1 KB' }] })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, 'INVALID_NOTICE_ATTACHMENTS')
  })
})

// ─────────────────────────── 목록·검색 ───────────────────────────

test('목록은 필독을 앞에 두고, 두 글자 미만 검색어는 무시한다', async () => {
  await withApp(async (origin) => {
    const admin = await login(origin, ADMIN.email)
    await createCompanyNotice(origin, admin, { title: '일반 안내', mustRead: false })
    const urgent = await createCompanyNotice(origin, admin, { title: '필독 안전교육', mustRead: true })

    const rows = await list(origin, admin)
    assert.equal(rows[0].id, urgent.id, '필독이 먼저 온다')

    assert.equal((await list(origin, admin, '?q=안')).length, 2, '두 글자 미만은 걸러지 않는다')
    const found = await list(origin, admin, `?q=${encodeURIComponent('안전교육')}`)
    assert.deepEqual(found.map((item) => item.id), [urgent.id])
    assert.equal((await list(origin, admin, `?q=${encodeURIComponent('없는낱말')}`)).length, 0)
    assert.equal((await list(origin, admin, '?scope=project')).length, 0)
  })
})

test('전역 검색에 공지 갈래가 함께 나온다', async () => {
  await withApp(async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const notice = await createCompanyNotice(origin, admin, { title: '냉장창고 점검 공지', body: '냉장창고 온도를 확인합니다.' })
    const result = await (await fetch(`${origin}/api/search?q=${encodeURIComponent('냉장창고')}`, { headers: admin.headers })).json()
    const group = result.groups.find((item) => item.kind === 'notice')
    assert.ok(group, '공지 갈래가 결과에 있어야 한다')
    assert.equal(group.items[0].id, notice.id)
    assert.equal(group.items[0].focusId, `company:notice:${notice.id}`)
  })
})

test('24시간 리마인드와 48시간 미확인 요약이 실제 라우트 위에서 도착한다 (판정 4의 뒷문장)', async () => {
  // 진짜 시간을 기다릴 수 없으므로 createApp의 noticeClock 이음매로 시계를 민다.
  // 멱등은 전적으로 저장된 데이터(reminders.remindedAt · summary48SentAt)에서 나온다 —
  // 같은 시각에 두 번 돌려도 두 번째는 0건이어야 한다.
  let fakeNow = new Date('2026-09-01T09:00:00.000Z')
  const feedOf = async (origin, session, type) =>
    (await (await fetch(`${origin}/api/notifications`, { headers: session.headers })).json()).items.filter((item) => item.type === type)

  await withApp(async (origin, _store, app) => {
    const admin = await login(origin, ADMIN.email)
    const park = await login(origin, PARK.email)
    const notice = await createCompanyNotice(origin, admin, { targetIds: [PARK.id, OH.id] })
    const at = (hours) => new Date(Date.parse(notice.createdAt) + hours * 60 * 60 * 1_000)

    fakeNow = at(23)
    assert.deepEqual(await app.locals.runNoticeAckWatch(fakeNow), { reminded: 0, summaries: 0 }, '23시간에는 아직 부르지 않는다')

    fakeNow = at(25)
    assert.deepEqual(await app.locals.runNoticeAckWatch(fakeNow), { reminded: 2, summaries: 0 })
    assert.deepEqual(await app.locals.runNoticeAckWatch(fakeNow), { reminded: 0, summaries: 0 }, '같은 시각에 다시 돌려도 두 번은 울리지 않는다')
    assert.equal((await feedOf(origin, park, 'notice-reminder')).length, 1)

    // 25시간과 48시간 사이에 확인한 사람은 요약 명단에서 빠진다.
    assert.equal((await post(origin, park, `/${notice.id}/ack`)).status, 200)

    fakeNow = at(49)
    assert.deepEqual(await app.locals.runNoticeAckWatch(fakeNow), { reminded: 0, summaries: 1 })
    const summary = await feedOf(origin, admin, 'notice-unconfirmed-summary')
    assert.equal(summary.length, 1, '작성자에게 미확인 명단이 한 건 도착한다')
    assert.equal(summary[0].title, `미확인 1명 · ${notice.title}`)
    assert.equal(summary[0].body, OH.name)
    assert.equal(summary[0].focusId, `company:notice:${notice.id}`)

    assert.deepEqual(await app.locals.runNoticeAckWatch(fakeNow), { reminded: 0, summaries: 0 }, '요약도 공지당 한 번이다')
    assert.equal((await feedOf(origin, admin, 'notice-unconfirmed-summary')).length, 1)
  }, { noticeClock: () => fakeNow })
})

test('스케줄러에 필독 확인 챙기기 잡이 등록돼 있고 운영자가 손으로 돌릴 수 있다', async () => {
  await withApp(async (origin) => {
    const operator = await login(origin, 'operator@onfactory.co.kr')
    const jobs = await (await fetch(`${origin}/api/platform/scheduler`, { headers: operator.headers })).json()
    const job = jobs.jobs.find((item) => item.id === 'notice-ack-watch')
    assert.ok(job, '잡이 등록돼 있어야 한다')
    const run = await fetch(`${origin}/api/platform/scheduler/notice-ack-watch/run`, { method: 'POST', headers: operator.headers })
    assert.equal(run.status, 200, await run.text())
  })
})

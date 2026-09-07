import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createApp } from './app.mjs'
import { withServer } from './test-server.mjs'
import { MAX_BLOCKS_PER_DOCUMENT, MAX_DOCUMENTS_PER_TENANT, MAX_OPS_PER_BATCH } from './wiki-blocks.mjs'

/**
 * 문서(위키) 라우트 — 권한·병합·이력·프레즌스·승격을 HTTP 밖에서 본다.
 *
 * 시계를 주입한다(`wikiClock`) — 프레즌스 TTL과 보관 만료를 벽시계로 재면 그 시험은 밤에만 깨진다.
 */

const TENANT = 'TENANT-SUNSEA'
const ADMIN = { id: 'USR-SUNSEA-ADMIN', name: '김서원', email: 'admin@sunsea.co.kr' }
const PARK = { id: 'USR-SUNSEA-PARK', name: '박지현', email: 'jihyun.park@sunsea.co.kr' }
const OH = { id: 'USR-SUNSEA-OH', name: '오태식', email: 'taesik.oh@sunsea.co.kr' }
/** 박지현과 같은 부서(품질관리)이지만 어느 프로젝트에도 없다 — 부서 파일의 열람이 끊겼는지 재는 눈금. */
const LEE = { id: 'USR-SUNSEA-LEE', name: '이정민', email: 'jungmin.lee@sunsea.co.kr' }
const GUEST = { id: 'USR-TENANT-SUNSEA-GUEST01', name: '홍거래', email: 'guest@partner.example', password: 'Guest!Pass2026' }
const GRANT_ID = 'GST-TENANT-SUNSEA-000001'
const POHANG_ADMIN = { id: 'USR-POHANG-ADMIN', email: 'admin@pohangcoop.co.kr' }

const digestHex = (password, accountId) => scryptSync(String(password), `onfactory:${accountId}`, 32).toString('hex')
const readJson = async (response) => { const text = await response.text(); try { return JSON.parse(text) } catch { return { raw: text } } }
const uploadDir = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onfactory-wiki-')), 'documents')

let blockCounter = 0
const blockId = () => `BLK-TEST${String(blockCounter += 1).padStart(4, '0')}`
let opCounter = 0
const opId = () => `OP-TEST${String(opCounter += 1).padStart(4, '0')}`

const project = (id, name, members, visibility = 'members') => ({
  id, name, description: '', visibility, status: 'active', stage: '', client: '', amount: 0,
  ownerId: ADMIN.id, ownerName: ADMIN.name, members,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
})

function seedStore() {
  return {
    version: 2,
    tenants: {
      [TENANT]: {
        'project-spaces': {
          data: [
            project('PRJ-A', '협업 A', [
              { id: ADMIN.id, name: ADMIN.name, role: 'owner' },
              { id: PARK.id, name: PARK.name, role: 'editor' },
              { id: OH.id, name: OH.name, role: 'viewer' },
              { id: GUEST.id, name: GUEST.name, role: 'viewer', kind: 'guest' },
            ]),
            project('PRJ-B', '협업 B', [{ id: ADMIN.id, name: ADMIN.name, role: 'owner' }, { id: PARK.id, name: PARK.name, role: 'editor' }]),
            // 회사 전체 열람: 오태식은 멤버가 아니지만 `projectRoleOf`가 'viewer'를 준다 — 읽을 수 있다.
            project('PRJ-OPEN', '회사 전체 열람', [{ id: ADMIN.id, name: ADMIN.name, role: 'owner' }], 'company'),
          ],
          updatedAt: '2026-09-01T00:00:00.000Z',
        },
        'work-items': {
          data: [{
            id: 'WK-ADMINONLY', title: '관리자만 보는 업무', description: '', owner: ADMIN.name, ownerId: ADMIN.id,
            requestedBy: ADMIN.name, requesterId: ADMIN.id, due: '2026-12-31', priority: '보통',
            status: '업무요청', category: '일반', createdAt: '2026-09-01T00:00:00.000Z',
          }],
          updatedAt: '2026-09-01T00:00:00.000Z',
        },
      },
      'TENANT-POHANG': {},
    },
    platform: {},
    accountApprovals: { [GUEST.id]: 'approved' },
    accountCredentials: { [GUEST.id]: { passwordHash: digestHex(GUEST.password, GUEST.id), mustChangePassword: false, temporaryPasswordExpiresAt: null } },
    invitedAccounts: [{
      id: GUEST.id, email: GUEST.email, name: GUEST.name, tenantId: TENANT, tenantName: '햇살바다',
      team: '파트너상사', jobRole: '외부 게스트', requested: '게스트 초대', role: 'tenant-guest', guestGrantId: GRANT_ID,
    }],
    passwordResetRequests: [],
    guestGrants: [{
      id: GRANT_ID, tenantId: TENANT, accountId: GUEST.id, email: GUEST.email, name: GUEST.name, orgName: '파트너상사',
      projectIds: ['PRJ-A'], invitedById: ADMIN.id, invitedByName: ADMIN.name, status: 'active',
      tokenHash: null, tokenIssuedAt: null, tokenExpiresAt: null, resendCount: 0, lastResentAt: null,
      accessExpiresAt: null, acceptedAt: '2026-09-01T00:00:00.000Z', revokedAt: null, revokedById: null, deactivatedAt: null,
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    }],
  }
}

/** 주입 가능한 시계. 테스트가 `advance(ms)`로 앞으로 민다. */
function testClock(start = '2026-09-07T00:00:00.000Z') {
  let current = new Date(start).getTime()
  return { now: () => new Date(current), advance: (ms) => { current += ms } }
}

/**
 * 붙잡아 둘 수 있는 커밋. `arm()` 뒤 **첫 커밋**을 `release()`가 불릴 때까지 매달아 두었다가 실패시킨다.
 *
 * 왜 필요한가: 락이 실제로 하는 일은 "커밋 실패 롤백이 그 사이 들어온 남의 저장을 되돌리지 못하게"다.
 * 동기 throw로는 그 창이 열리지 않아, 락을 통째로 빼도 스위트가 녹색이 된다(무의미 테스트).
 * 무장하지 않았을 때는 **동기로** 끝난다 — `createApp`의 startup commit이 promise를 거부한다.
 */
function gatedCommit() {
  const state = { armed: null, release: null }
  return {
    onChange: () => {
      if (!state.armed) return undefined
      const held = state.armed
      state.armed = null
      return held.then(() => { throw new Error('커밋 실패(테스트)') })
    },
    arm: () => { state.armed = new Promise((resolve) => { state.release = resolve }) },
    release: () => { state.release?.() },
  }
}

const buildApp = (store, extra = {}) => createApp({
  apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {},
  documentUploadDirectory: uploadDir(), ...extra,
})

async function login(origin, email, password = 'demo1234') {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: 'tenant', email, password }),
  })
  const body = await readJson(response)
  const account = body.account ?? null
  return {
    account,
    headers: {
      'content-type': 'application/json',
      cookie: response.headers.get('set-cookie') ?? '',
      ...(account ? { 'x-workspace-identity': `${account.tenantId}:${account.id}` } : {}),
    },
  }
}
const api = (origin, session) => async (method, route, body) => {
  const response = await fetch(`${origin}${route}`, {
    method, headers: session.headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: response.status, body: await readJson(response), response }
}

const insertOp = (text, after = null, type = 'text') => ({
  opId: opId(), kind: 'insert', after, block: { id: blockId(), type, text, ...(type === 'todo' ? { checked: false } : {}) },
})
const updateOp = (id, baseSeq, patch) => ({ opId: opId(), kind: 'update', blockId: id, baseSeq, block: patch })

const createDocument = async (call, body = {}) => {
  const created = await call('POST', '/api/wiki', { title: '문서', ...body })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  return created.body.document
}

/**
 * 실패한 순간에만 부른다 — 응답 본문과 **그 시점 문서 id 목록**을 함께 남긴다.
 *
 * 왜 id 목록인가: 권한 판정이 뒤집히는 유일한 길은 `documents.find(row => row.id === …)`가 다른 행을
 * 잡는 것이다(문서 id가 겹치면 그렇게 된다). 겹쳤다면 같은 id가 목록에 두 번 찍힌다 —
 * 저빈도 실패를 다시 만나기 전에 원인을 갈라 놓기 위한 덤프다.
 */
const diagnose = async (call, label, extra = {}) => {
  const list = await call('GET', '/api/wiki')
  const rows = [...(list.body?.documents ?? []), ...(list.body?.templates ?? [])].map((row) => `${row.id}=${row.title}`)
  const duplicated = rows.map((row) => row.split('=')[0]).filter((id, index, all) => all.indexOf(id) !== index)
  return `${label}\n  응답 = ${JSON.stringify(extra)}\n  문서 id = ${JSON.stringify(rows)}\n  겹친 id = ${JSON.stringify(duplicated)}`
}

// ── 1. 생성 · 트리 ──────────────────────────────────────────────────────────
test('문서 생성은 빈 문단 하나로 시작하고, 트리와 자식 수가 목록에 나온다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const call = api(origin, await login(origin, ADMIN.email))
    const root = await createDocument(call, { title: '품질 표준' })
    assert.match(root.id, /^WDOC-/)
    assert.equal(root.version, 1)
    assert.equal(root.blocks.length, 1)
    assert.equal(root.aiLevel, 'indexed')
    assert.equal('tenantId' in root, false, '응답에 테넌트 id가 실리면 안 된다')

    const child = await createDocument(call, { title: '하위 절차', parentId: root.id })
    assert.equal(child.parentId, root.id)

    const list = await call('GET', '/api/wiki')
    assert.equal(list.status, 200)
    assert.equal(list.body.documents.length, 2)
    assert.equal(list.body.documents.find((row) => row.id === root.id).childCount, 1)
    assert.equal(list.body.templates.length, 4, '기본 템플릿 4종이 lazy 시드된다')
  })
})

test('부모 무결성: 자기 자신·자손·다른 프로젝트는 각각 다른 코드로 거절된다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const call = api(origin, await login(origin, ADMIN.email))
    const root = await createDocument(call, { title: '루트' })
    const child = await createDocument(call, { title: '자식', parentId: root.id })
    const grandchild = await createDocument(call, { title: '손자', parentId: child.id })

    const self = await call('PATCH', `/api/wiki/${root.id}`, { version: root.version, parentId: root.id })
    assert.equal(self.status, 400)
    assert.equal(self.body.error.code, 'WIKI_PARENT_SELF')

    const cycle = await call('PATCH', `/api/wiki/${root.id}`, { version: root.version, parentId: grandchild.id })
    assert.equal(cycle.status, 400)
    assert.equal(cycle.body.error.code, 'WIKI_PARENT_CYCLE')

    const projectDoc = await createDocument(call, { title: '프로젝트 문서', projectId: 'PRJ-A' })
    const mismatch = await call('POST', '/api/wiki', { title: '섞인 하위', parentId: projectDoc.id, projectId: 'PRJ-B' })
    assert.equal(mismatch.status, 400)
    assert.equal(mismatch.body.error.code, 'WIKI_PARENT_PROJECT_MISMATCH')
  })
})

test('프로젝트를 바꾸면 하위 트리가 함께 옮겨지고 movedIds가 그 사실을 말한다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const call = api(origin, await login(origin, ADMIN.email))
    const root = await createDocument(call, { title: '루트' })
    const child = await createDocument(call, { title: '자식', parentId: root.id })
    const grandchild = await createDocument(call, { title: '손자', parentId: child.id })

    const moved = await call('PATCH', `/api/wiki/${root.id}`, { version: root.version, projectId: 'PRJ-A' })
    assert.equal(moved.status, 200, JSON.stringify(moved.body))
    assert.equal(moved.body.movedIds.length, 3, '3단 트리 전체가 함께 옮겨진다')
    const list = await call('GET', '/api/wiki?projectId=PRJ-A')
    assert.deepEqual(
      list.body.documents.map((row) => row.id).sort(),
      [root.id, child.id, grandchild.id].sort(),
    )
  })
})

test('부모와 자식의 프로젝트는 어느 문으로도 어긋나지 않는다 — PATCH도 생성과 같은 코드로 거절한다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const call = api(origin, await login(origin, ADMIN.email))
    const parent = await createDocument(call, { title: '부모', projectId: 'PRJ-A' })
    const child = await createDocument(call, { title: '자식', parentId: parent.id, projectId: 'PRJ-A' })

    // ① 자식만 다른 프로젝트로 옮기기.
    const split = await call('PATCH', `/api/wiki/${child.id}`, { version: child.version, projectId: 'PRJ-B' })
    assert.equal(split.status, 400, JSON.stringify(split.body))
    assert.equal(split.body.error.code, 'WIKI_PARENT_PROJECT_MISMATCH')

    // ② parentId와 projectId를 한 요청에 보내도 뒤에 온 값이 상속을 덮지 않는다.
    const loose = await createDocument(call, { title: '떠 있는 문서' })
    const both = await call('PATCH', `/api/wiki/${loose.id}`, { version: loose.version, parentId: parent.id, projectId: '' })
    assert.equal(both.status, 400, JSON.stringify(both.body))
    assert.equal(both.body.error.code, 'WIKI_PARENT_PROJECT_MISMATCH')
    assert.equal((await call('GET', `/api/wiki/${loose.id}`)).body.document.parentId, null, '거절된 요청은 아무것도 바꾸지 않는다')

    // ③ 정말 떼어내려면 부모를 함께 비운다.
    const detached = await call('PATCH', `/api/wiki/${child.id}`, { version: child.version, parentId: '', projectId: '' })
    assert.equal(detached.status, 200, JSON.stringify(detached.body))
    assert.equal(detached.body.document.parentId, null)
    assert.equal(detached.body.document.projectId, null)
  })
})

test('못 쓰는 하위 문서가 있으면 부모의 프로젝트 이동이 거절된다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const member = api(origin, await login(origin, PARK.email))   // PRJ-B editor
    const root = await createDocument(member, { title: '박지현 루트' })
    const opened = await member('PATCH', `/api/wiki/${root.id}`, { version: root.version, writeScope: 'tenant' })
    assert.equal(opened.status, 200, JSON.stringify(opened.body))
    // 관리자가 그 아래에 자기 문서를 단다 — 박지현은 읽을 수는 있고 고칠 수는 없다.
    const others = await createDocument(admin, { title: '관리자 문서', parentId: root.id })
    assert.equal((await member('GET', `/api/wiki/${others.id}`)).body.permissions.canWrite, false)

    const move = await member('PATCH', `/api/wiki/${root.id}`, { version: opened.body.version, projectId: 'PRJ-B' })
    assert.equal(move.status, 409, JSON.stringify(move.body))
    assert.equal(move.body.error.code, 'WIKI_MOVE_BLOCKED')
    assert.equal((await admin('GET', `/api/wiki/${others.id}`)).body.document.projectId, null, '하위 문서는 그대로다')
    assert.equal((await admin('GET', `/api/wiki/${root.id}`)).body.document.projectId, null, '부모도 그대로다')
  })
})

// ── 2. 권한 ────────────────────────────────────────────────────────────────
test('프로젝트 없는 문서: 작성자만 쓰고, writeScope를 회사 전체로 열면 구성원도 쓴다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const member = api(origin, await login(origin, PARK.email))
    const document = await createDocument(admin, { title: '사내 안내' })

    assert.equal((await member('GET', `/api/wiki/${document.id}`)).status, 200)
    const blocked = await member('POST', `/api/wiki/${document.id}/ops`, { baseVersion: 1, ops: [insertOp('직원이 씀')] })
    assert.equal(blocked.status, 403)
    assert.equal(blocked.body.error.code, 'WIKI_FORBIDDEN')

    const opened = await admin('PATCH', `/api/wiki/${document.id}`, { version: 1, writeScope: 'tenant' })
    assert.equal(opened.status, 200, JSON.stringify(opened.body))
    const allowed = await member('POST', `/api/wiki/${document.id}/ops`, { baseVersion: opened.body.version, ops: [insertOp('직원이 씀')] })
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body))
  })
})

test('프로젝트 문서: 비멤버에게는 제목조차 없는 404이고, 프로젝트에서 빠지면 작성자라도 즉시 404다', async () => {
  const store = seedStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const editor = api(origin, await login(origin, PARK.email))
    const viewer = api(origin, await login(origin, OH.email))
    const document = await createDocument(admin, { title: '대외비 설계도', projectId: 'PRJ-B' })

    // PRJ-B에 없는 오태식에게는 존재하지 않는다.
    const hidden = await viewer('GET', `/api/wiki/${document.id}`)
    assert.equal(hidden.status, 404)
    assert.doesNotMatch(JSON.stringify(hidden.body), /대외비 설계도/)

    assert.equal((await editor('GET', `/api/wiki/${document.id}`)).status, 200)
    const write = await editor('POST', `/api/wiki/${document.id}/ops`, { baseVersion: 1, ops: [insertOp('편집자가 씀')] })
    assert.equal(write.status, 200, JSON.stringify(write.body))

    // 프로젝트에서 빼면 그 순간부터 안 보인다 — 권한을 스탬프하지 않고 읽을 때마다 다시 계산하기 때문이다.
    const projects = store.tenants[TENANT]['project-spaces'].data
    projects[1] = { ...projects[1], members: projects[1].members.filter((entry) => entry.id !== PARK.id) }
    assert.equal((await editor('GET', `/api/wiki/${document.id}`)).status, 404)

    // 작성자 예외는 프로젝트 판정 뒤에 온다 — 관리자가 아닌 작성자가 프로젝트에서 빠지면 역시 404다.
    const parkDoc = await (async () => {
      projects[1] = { ...projects[1], members: [...projects[1].members, { id: PARK.id, name: PARK.name, role: 'editor' }] }
      return createDocument(editor, { title: '박지현 문서', projectId: 'PRJ-B' })
    })()
    projects[1] = { ...projects[1], members: projects[1].members.filter((entry) => entry.id !== PARK.id) }
    assert.equal((await editor('GET', `/api/wiki/${parkDoc.id}`)).status, 404, '작성자라도 프로젝트에서 빠지면 못 본다')
  })
})

test('프로젝트 viewer 는 자기가 만든 문서라도 쓰지 못한다 — 작성자 예외는 프로젝트 판정 뒤에 온다', async () => {
  const store = seedStore()
  await withServer(buildApp(store), async (origin) => {
    const author = api(origin, await login(origin, PARK.email))
    const document = await createDocument(author, { title: '내가 만든 프로젝트 문서', projectId: 'PRJ-B' })
    // 같은 사람을 viewer로 낮춘다. 작성자 예외를 프로젝트 역할 **앞**에 두면 여기서 쓰기가 열린다.
    const projects = store.tenants[TENANT]['project-spaces'].data
    projects[1] = { ...projects[1], members: projects[1].members.map((entry) => (entry.id === PARK.id ? { ...entry, role: 'viewer' } : entry)) }

    const seen = await author('GET', `/api/wiki/${document.id}`)
    assert.equal(seen.status, 200, '프로젝트 구성원이므로 읽기는 된다')
    assert.equal(seen.body.permissions.canWrite, false, '작성자 예외가 프로젝트 역할을 앞지르면 안 된다')
    assert.equal(seen.body.permissions.canManage, false)
    const write = await author('POST', `/api/wiki/${document.id}/ops`, { baseVersion: document.version, ops: [insertOp('viewer가 쓴다')] })
    assert.equal(write.status, 403, JSON.stringify(write.body))
    assert.equal(write.body.error.code, 'WIKI_FORBIDDEN')
  })
})

test('프로젝트 연결은 parentId로도 바꿀 수 없다 — 관리자·작성자가 아니면 어느 문으로 들어와도 403이다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const editor = api(origin, await login(origin, PARK.email))    // PRJ-B editor, 작성자 아님
    const outsider = api(origin, await login(origin, OH.email))    // PRJ-B 비멤버

    // 부모 후보는 박지현이 **쓸 수 있는** 전사 문서로 둔다 — 부모 쓰기 검사가 아니라
    // 프로젝트 연결 판정이 막는다는 것을 보이기 위해서다.
    const open = await createDocument(admin, { title: '전사 루트' })
    const opened = await admin('PATCH', `/api/wiki/${open.id}`, { version: open.version, writeScope: 'tenant' })
    assert.equal(opened.status, 200, JSON.stringify(opened.body))
    const secret = await createDocument(admin, { title: 'PRJ-B 대외비', projectId: 'PRJ-B' })
    const secretChild = await createDocument(admin, { title: 'PRJ-B 대외비 하위', parentId: secret.id, projectId: 'PRJ-B' })
    assert.equal((await editor('GET', `/api/wiki/${secret.id}`)).body.permissions.canManage, false)

    const escalate = await editor('PATCH', `/api/wiki/${secret.id}`, { version: secret.version, parentId: open.id })
    if (escalate.status !== 403) {
      assert.fail(await diagnose(admin, 'parentId만 바꿔 프로젝트를 벗길 수 있으면 안 된다', {
        status: escalate.status, body: escalate.body, open: open.id, secret: secret.id, secretChild: secretChild.id,
      }))
    }
    assert.equal(escalate.body.error.code, 'WIKI_FORBIDDEN')
    assert.equal((await outsider('GET', `/api/wiki/${secret.id}`)).status, 404)
    assert.equal((await outsider('GET', `/api/wiki/${secretChild.id}`)).status, 404, '하위 트리도 그대로 숨어 있다')

    // 반대 방향(전사 문서를 프로젝트 안으로 격리)도 같은 판정이다.
    const hide = await editor('PATCH', `/api/wiki/${open.id}`, { version: opened.body.version, parentId: secret.id })
    assert.equal(hide.status, 403, JSON.stringify(hide.body))
    assert.equal(hide.body.error.code, 'WIKI_FORBIDDEN')
    assert.equal((await outsider('GET', `/api/wiki/${open.id}`)).status, 200, '보던 문서가 조용히 사라지면 안 된다')

    // 막힌 것은 '이동'이 아니라 '권한 없는 이동'이다 — 작성자는 같은 이동을 한다.
    const allowed = await admin('PATCH', `/api/wiki/${secret.id}`, { version: secret.version, parentId: open.id })
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body))
    assert.equal(allowed.body.document.projectId, null)
    assert.equal(allowed.body.movedIds.length, 2, '하위 트리가 함께 움직인다')
  })
})

test('새 부모는 읽을 수 있는 것만으로 부족하다 — 쓸 수 있어야 그 아래로 옮긴다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const member = api(origin, await login(origin, PARK.email))
    const locked = await createDocument(admin, { title: '관리자만 쓰는 루트' })   // writeScope 'author'
    const mine = await createDocument(member, { title: '내 문서' })
    assert.equal((await member('GET', `/api/wiki/${locked.id}`)).status, 200, '읽기는 된다')

    const graft = await member('PATCH', `/api/wiki/${mine.id}`, { version: mine.version, parentId: locked.id })
    assert.equal(graft.status, 403, JSON.stringify(graft.body))
    assert.equal(graft.body.error.code, 'WIKI_FORBIDDEN')
  })
})

test('게스트는 모든 문서 라우트에서 같은 한 가지 코드로 막힌다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const document = await createDocument(admin, { title: '사내 문서', projectId: 'PRJ-A' })
    const guest = api(origin, await login(origin, GUEST.email, GUEST.password))
    const routes = [
      ['GET', '/api/wiki'],
      ['GET', `/api/wiki/${document.id}`],
      ['POST', '/api/wiki', { title: '게스트 문서' }],
      ['PATCH', `/api/wiki/${document.id}`, { version: 1, title: '바꿈' }],
      ['POST', `/api/wiki/${document.id}/ops`, { baseVersion: 1, ops: [insertOp('게스트')] }],
      ['DELETE', `/api/wiki/${document.id}`],
      ['POST', `/api/wiki/${document.id}/presence`, { blockId: null }],
      ['GET', `/api/wiki/${document.id}/revisions`],
      ['GET', `/api/wiki/${document.id}/revisions/1`],
      ['POST', `/api/wiki/${document.id}/restore`, { version: 1, expectedCurrentVersion: 1 }],
      ['POST', `/api/wiki/${document.id}/revisions/1/blocks/BLK-X/reinstate`],
      ['POST', `/api/wiki/${document.id}/save-as-template`, { name: '템플릿' }],
      ['POST', `/api/wiki/${document.id}/blocks/BLK-X/task`, { title: '업무' }],
      ['GET', `/api/wiki/${document.id}/export`],
    ]
    assert.equal(routes.length, 14)
    for (const [method, route, body] of routes) {
      const result = await guest(method, route, body)
      assert.equal(result.status, 403, `${method} ${route}`)
      assert.equal(result.body.error.code, 'GUEST_SCOPE_FORBIDDEN', `${method} ${route}`)
    }
  })
})

test('generic 저장소 라우트는 문서 키를 모른다 — 전용 라우트만 문이다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const call = api(origin, await login(origin, ADMIN.email))
    for (const key of ['wiki-documents', 'wiki-revisions']) {
      const read = await call('GET', `/api/workspace/${key}`)
      assert.equal(read.status, 404)
      assert.equal(read.body.error.code, 'STORE_KEY_NOT_FOUND')
      const write = await call('PUT', `/api/workspace/${key}`, { data: [] })
      assert.equal(write.status, 404)
      assert.equal(write.body.error.code, 'STORE_KEY_NOT_FOUND')
    }
  })
})

test('다른 테넌트의 문서 id는 존재하지 않고, 그 레코드는 손대지 못한다', async () => {
  const store = seedStore()
  await withServer(buildApp(store), async (origin) => {
    const sunsea = api(origin, await login(origin, ADMIN.email))
    const document = await createDocument(sunsea, { title: '햇살바다 문서' })
    const before = JSON.stringify(store.tenants[TENANT]['wiki-documents'])

    const pohang = api(origin, await login(origin, POHANG_ADMIN.email))
    assert.equal((await pohang('GET', `/api/wiki/${document.id}`)).status, 404)
    assert.equal((await pohang('POST', `/api/wiki/${document.id}/ops`, { baseVersion: 1, ops: [insertOp('침입') ] })).status, 404)
    assert.equal(JSON.stringify(store.tenants[TENANT]['wiki-documents']), before)
  })
})

// ── 3. 병합 (판정 8) ───────────────────────────────────────────────────────
test('같은 기준 버전에서 다른 문단을 동시에 고치면 둘 다 남는다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const member = api(origin, await login(origin, PARK.email))
    const document = await createDocument(admin, { title: '동시 편집', projectId: 'PRJ-A' })

    const [first, second] = await Promise.all([
      admin('POST', `/api/wiki/${document.id}/ops`, { baseVersion: 1, ops: [insertOp('관리자 문단')] }),
      member('POST', `/api/wiki/${document.id}/ops`, { baseVersion: 1, ops: [insertOp('직원 문단')] }),
    ])
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.equal(second.status, 200, JSON.stringify(second.body))

    const after = await admin('GET', `/api/wiki/${document.id}`)
    const texts = after.body.document.blocks.map((block) => block.text)
    assert.ok(texts.includes('관리자 문단'), JSON.stringify(texts))
    assert.ok(texts.includes('직원 문단'), JSON.stringify(texts))
    assert.equal(after.body.document.version, 3)
    const revisions = await admin('GET', `/api/wiki/${document.id}/revisions`)
    assert.equal(revisions.body.revisions.length, 3, '생성 1건 + 편집 2건')
    assert.equal(revisions.body.revisions.every((row) => row.overwriteCount === 0), true)
  })
})

test('같은 문단을 동시에 고치면 나중 값이 남고, 밀린 문장이 이력에 그대로 있다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const member = api(origin, await login(origin, PARK.email))
    const document = await createDocument(admin, { title: '충돌', projectId: 'PRJ-A' })
    const target = document.blocks[0]

    const first = await admin('POST', `/api/wiki/${document.id}/ops`, {
      baseVersion: 1, ops: [updateOp(target.id, target.seq, { type: 'text', text: '박지현 안' })],
    })
    assert.equal(first.status, 200, JSON.stringify(first.body))
    // 낡은 baseSeq로 같은 문단을 고친다 — 뒤가 이기되 앞의 원문이 이력에 실린다.
    const second = await member('POST', `/api/wiki/${document.id}/ops`, {
      baseVersion: 1, ops: [updateOp(target.id, target.seq, { type: 'text', text: '오태식 안' })],
    })
    assert.equal(second.status, 200, JSON.stringify(second.body))
    assert.equal(second.body.overwrites.length, 1)
    assert.equal(second.body.overwrites[0].previousText, '박지현 안')

    const detail = await admin('GET', `/api/wiki/${document.id}/revisions/${second.body.version}`)
    assert.equal(detail.status, 200)
    assert.ok(JSON.stringify(detail.body).includes('박지현 안'), '진 글이 이력에 남아야 한다')
  })
})

test('앞선 baseVersion은 거절하되 낡은 것은 거절하지 않는다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const call = api(origin, await login(origin, ADMIN.email))
    const document = await createDocument(call, { title: '기준' })
    const ahead = await call('POST', `/api/wiki/${document.id}/ops`, { baseVersion: 9, ops: [insertOp('앞선 요청')] })
    assert.equal(ahead.status, 400)
    assert.equal(ahead.body.error.code, 'WIKI_BASE_VERSION_AHEAD')

    await call('POST', `/api/wiki/${document.id}/ops`, { baseVersion: 1, ops: [insertOp('첫 문단')] })
    const stale = await call('POST', `/api/wiki/${document.id}/ops`, { baseVersion: 1, ops: [insertOp('낡은 기준으로 온 편집')] })
    assert.equal(stale.status, 200, '낡았다는 이유로는 사람이 친 글자를 버리지 않는다')
  })
})

test('같은 문서로 몰린 20개 배치가 하나도 유실되지 않는다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const call = api(origin, await login(origin, ADMIN.email))
    const document = await createDocument(call, { title: '동시 저장' })
    const batches = Array.from({ length: 20 }, (_unused, index) => ({ text: `문단 ${index}`, op: insertOp(`문단 ${index}`) }))
    const results = await Promise.all(batches.map((batch) => call('POST', `/api/wiki/${document.id}/ops`, { baseVersion: 1, ops: [batch.op] })))
    assert.ok(results.every((result) => result.status === 200), JSON.stringify(results.find((result) => result.status !== 200)?.body))

    const after = await call('GET', `/api/wiki/${document.id}`)
    assert.equal(after.body.document.version, 21)
    const texts = new Set(after.body.document.blocks.map((block) => block.text))
    for (const batch of batches) assert.ok(texts.has(batch.text), `${batch.text} 유실`)
    const revisions = await call('GET', `/api/wiki/${document.id}/revisions`)
    assert.equal(revisions.body.revisions.length, 21)
  })
})

test('첨부가 든 배치는 파일 I/O를 기다리는 동안 다른 문서의 저장을 지우지 않는다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const session = await login(origin, ADMIN.email)
    const call = api(origin, session)
    const upload = await fetch(`${origin}/api/documents?${new URLSearchParams({ name: '도면.pdf', category: '일반', visibility: 'tenant', tags: '' })}`, {
      method: 'POST',
      headers: { cookie: session.headers.cookie, 'content-type': 'application/octet-stream', 'x-file-type': 'application/pdf', 'x-file-name': encodeURIComponent('도면.pdf') },
      body: Buffer.from('%PDF-1.4 wiki'),
    })
    const uploaded = await readJson(upload)
    assert.equal(upload.status, 201, JSON.stringify(uploaded))

    const withAttachment = await createDocument(call, { title: '첨부 문서' })
    const plain = await createDocument(call, { title: '평범한 문서' })
    // 첨부 검사(`getTenantDocument`)는 실제 파일 I/O라 여기서 이벤트 루프가 넘어간다.
    const [attached, saved] = await Promise.all([
      call('POST', `/api/wiki/${withAttachment.id}/ops`, {
        baseVersion: withAttachment.version,
        ops: [{ opId: opId(), kind: 'insert', after: null, block: { id: blockId(), type: 'image', attachmentId: uploaded.document.id, text: '도면' } }],
      }),
      call('POST', `/api/wiki/${plain.id}/ops`, { baseVersion: plain.version, ops: [insertOp('사라지면 안 되는 문장')] }),
    ])
    assert.equal(attached.status, 200, JSON.stringify(attached.body))
    assert.equal(saved.status, 200, JSON.stringify(saved.body))

    const after = await call('GET', `/api/wiki/${plain.id}`)
    assert.equal(after.body.document.version, saved.body.version, '200을 받은 저장이 사라졌다')
    assert.ok(after.body.document.blocks.some((block) => block.text === '사라지면 안 되는 문장'))
  })
})

test('앞 배치의 커밋 실패 롤백은 그 사이 200을 받은 저장을 지우지 못한다 — 같은 문서든 다른 문서든', async () => {
  for (const sameDocument of [true, false]) {
    const gate = gatedCommit()
    await withServer(buildApp(seedStore(), { onWorkspaceStoreChange: gate.onChange }), async (origin) => {
      const call = api(origin, await login(origin, ADMIN.email))
      const first = await createDocument(call, { title: '앞 문서' })
      const second = sameDocument ? first : await createDocument(call, { title: '뒤 문서' })

      // 앞 배치의 커밋을 매달아 둔 채 뒤 배치를 보낸다. 락이 없으면 뒤 배치가 그 창에서 저장되고,
      // 앞 배치의 롤백이 `wiki-documents` 레코드를 통째로 되감아 그 저장을 지운다.
      gate.arm()
      const pendingFirst = call('POST', `/api/wiki/${first.id}/ops`, { baseVersion: first.version, ops: [insertOp('앞 배치')] })
      await new Promise((resolve) => { setTimeout(resolve, 30) })
      const pendingSecond = call('POST', `/api/wiki/${second.id}/ops`, { baseVersion: second.version, ops: [insertOp('뒤 배치')] })
      await new Promise((resolve) => { setTimeout(resolve, 30) })
      gate.release()
      const [failed, kept] = await Promise.all([pendingFirst, pendingSecond])
      assert.equal(failed.status, 500, `sameDocument=${sameDocument}`)
      assert.equal(failed.body.error.code, 'WIKI_WRITE_FAILED')
      assert.equal(kept.status, 200, JSON.stringify(kept.body))

      const after = await call('GET', `/api/wiki/${second.id}`)
      const texts = after.body.document.blocks.map((block) => block.text)
      assert.ok(texts.includes('뒤 배치'), `앞 배치의 롤백이 뒤 배치를 지웠다(sameDocument=${sameDocument})`)
      assert.equal(texts.includes('앞 배치'), false, '저장하지 못한 문장이 남으면 안 된다')
      const firstAfter = await call('GET', `/api/wiki/${first.id}`)
      assert.equal(firstAfter.body.document.blocks.some((block) => block.text === '앞 배치'), false)
    })
  }
})

// ── 4. 되돌리기 ────────────────────────────────────────────────────────────
test('되돌리기는 새 버전을 만들고 그 사이 버전을 목록에 남긴다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const call = api(origin, await login(origin, ADMIN.email))
    const document = await createDocument(call, { title: '이력' })
    const first = document.blocks[0]
    let version = 1
    let seq = first.seq
    for (let index = 1; index <= 5; index += 1) {
      const result = await call('POST', `/api/wiki/${document.id}/ops`, {
        baseVersion: version, ops: [updateOp(first.id, seq, { type: 'text', text: `${index}번째 내용` })],
      })
      assert.equal(result.status, 200, JSON.stringify(result.body))
      version = result.body.version
      seq = result.body.document.blocks.find((block) => block.id === first.id).seq
    }
    assert.equal(version, 6)
    const v3 = await call('GET', `/api/wiki/${document.id}/revisions/3`)
    assert.equal(v3.status, 200)

    const restored = await call('POST', `/api/wiki/${document.id}/restore`, { version: 3, expectedCurrentVersion: 6 })
    assert.equal(restored.status, 200, JSON.stringify(restored.body))
    assert.equal(restored.body.version, 7)
    assert.equal(restored.body.restoredFrom, 3)
    assert.deepEqual(
      restored.body.document.blocks.map((block) => block.text),
      v3.body.blocks.map((block) => block.text),
    )
    const revisions = await call('GET', `/api/wiki/${document.id}/revisions`)
    const versions = revisions.body.revisions.map((row) => row.version)
    for (const kept of [4, 5, 6]) assert.ok(versions.includes(kept), `버전 ${kept}이 목록에 남아 있어야 한다`)

    const stale = await call('POST', `/api/wiki/${document.id}/restore`, { version: 3, expectedCurrentVersion: 5 })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.error.code, 'WIKI_RESTORE_STALE')
    assert.equal(stale.body.error.currentVersion, 7)
  })
})

test('문장 하나만 되살리면 그 문단만 바뀐다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const call = api(origin, await login(origin, ADMIN.email))
    const document = await createDocument(call, { title: '문장 복구' })
    const first = document.blocks[0]
    const one = await call('POST', `/api/wiki/${document.id}/ops`, {
      baseVersion: 1, ops: [updateOp(first.id, first.seq, { type: 'text', text: '살리고 싶은 문장' }), insertOp('곁 문단')],
    })
    assert.equal(one.status, 200, JSON.stringify(one.body))
    const seq = one.body.document.blocks.find((block) => block.id === first.id).seq
    const two = await call('POST', `/api/wiki/${document.id}/ops`, {
      baseVersion: one.body.version, ops: [updateOp(first.id, seq, { type: 'text', text: '덮어쓴 문장' })],
    })
    assert.equal(two.status, 200)

    const reinstated = await call('POST', `/api/wiki/${document.id}/revisions/${two.body.version}/blocks/${first.id}/reinstate`)
    assert.equal(reinstated.status, 200, JSON.stringify(reinstated.body))
    assert.equal(reinstated.body.version, two.body.version + 1)
    const blocks = reinstated.body.document.blocks
    assert.equal(blocks.find((block) => block.id === first.id).text, '살리고 싶은 문장')
    assert.ok(blocks.some((block) => block.text === '곁 문단'), '나머지 문단은 그대로다')

    const missing = await call('POST', `/api/wiki/${document.id}/revisions/${two.body.version}/blocks/BLK-NOTHERE01/reinstate`)
    assert.equal(missing.status, 404)
    assert.equal(missing.body.error.code, 'WIKI_BLOCK_NOT_FOUND')
    const gone = await call('POST', `/api/wiki/${document.id}/revisions/999/blocks/${first.id}/reinstate`)
    assert.equal(gone.status, 410)
  })
})

// ── 5. 링크 인가 ───────────────────────────────────────────────────────────
test('볼 수 없는 대상의 제목은 본문·내보내기 어디에도 나가지 않는다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const member = api(origin, await login(origin, PARK.email))
    const document = await createDocument(admin, { title: '링크 문서', projectId: 'PRJ-A' })
    const written = await admin('POST', `/api/wiki/${document.id}/ops`, {
      baseVersion: 1, ops: [insertOp('참고: [[task:WK-ADMINONLY|아무 라벨]]')],
    })
    assert.equal(written.status, 200, JSON.stringify(written.body))

    const asAdmin = await admin('GET', `/api/wiki/${document.id}`)
    assert.ok(JSON.stringify(asAdmin.body).includes('관리자만 보는 업무'), '관리자에게는 현재 제목이 보인다')

    const asMember = await member('GET', `/api/wiki/${document.id}`)
    assert.ok(JSON.stringify(asMember.body).includes('접근 권한 없음'))
    assert.doesNotMatch(JSON.stringify(asMember.body), /관리자만 보는 업무/)

    const exported = await fetch(`${origin}/api/wiki/${document.id}/export`, { headers: (await login(origin, PARK.email)).headers })
    const markdown = await exported.text()
    assert.equal(exported.status, 200)
    assert.ok(markdown.includes('접근 권한 없음'))
    assert.doesNotMatch(markdown, /관리자만 보는 업무/)

    // 없는 대상과 못 보는 대상은 **같은 코드**로 거절된다 — 갈라 답하면 존재 오라클이 된다.
    const unknown = await member('POST', `/api/wiki/${document.id}/ops`, {
      baseVersion: written.body.version, ops: [insertOp('[[task:WK-NOSUCH|없는 업무]]')],
    })
    assert.equal(unknown.status, 400)
    assert.equal(unknown.body.error.code, 'WIKI_LINK_UNKNOWN')
    const hidden = await member('POST', `/api/wiki/${document.id}/ops`, {
      baseVersion: written.body.version, ops: [insertOp('[[task:WK-ADMINONLY|엿보기]]')],
    })
    assert.equal(hidden.status, 400)
    assert.equal(hidden.body.error.code, 'WIKI_LINK_UNKNOWN')
    assert.deepEqual(hidden.body.error.code, unknown.body.error.code)
  })
})

test('링크 라벨은 저장된 값이 아니라 대상의 현재 제목으로 그려진다', async () => {
  const store = seedStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const document = await createDocument(admin, { title: '라벨 최신화' })
    await admin('POST', `/api/wiki/${document.id}/ops`, { baseVersion: 1, ops: [insertOp('[[task:WK-ADMINONLY|옛 라벨]]')] })
    store.tenants[TENANT]['work-items'].data[0].title = '이름이 바뀐 업무'
    const after = await admin('GET', `/api/wiki/${document.id}`)
    assert.ok(JSON.stringify(after.body).includes('이름이 바뀐 업무'))
    assert.doesNotMatch(JSON.stringify(after.body), /옛 라벨/)
  })
})

test('요약도 본문과 같은 문을 지난다 — 볼 수 없는 대상의 이름이 목록·검색·문서 검색으로 나가지 않는다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const member = api(origin, await login(origin, PARK.email))
    const document = await createDocument(admin, { title: '요약 유출' })
    // 관리자는 그 업무를 볼 수 있으므로 라벨에 실제 제목을 적을 수 있다. 문제는 **읽는 쪽**이다.
    const patched = await admin('PATCH', `/api/wiki/${document.id}`, {
      version: document.version, summary: '요약메모 [[task:WK-ADMINONLY|관리자만 보는 업무]] 끝',
    })
    assert.equal(patched.status, 200, JSON.stringify(patched.body))
    await admin('POST', `/api/wiki/${document.id}/ops`, { baseVersion: patched.body.version, ops: [insertOp('공개본문 낱말 유출확인용')] })

    // 1) 문서 상세(publicDocument)
    const detail = await member('GET', `/api/wiki/${document.id}`)
    assert.equal(detail.status, 200, JSON.stringify(detail.body))
    assert.equal(detail.body.document.summary.includes('관리자만 보는 업무'), false, `상세 요약으로 제목이 나갔다: ${detail.body.document.summary}`)
    assert.ok(detail.body.document.summary.includes('접근 권한 없음'))

    // 2) 목록(listItem)
    const list = await member('GET', '/api/wiki')
    const row = list.body.documents.find((entry) => entry.id === document.id)
    assert.ok(row, '박지현도 이 문서를 본다(전사 문서)')
    assert.equal(row.summary.includes('관리자만 보는 업무'), false, `목록 요약으로 볼 수 없는 업무의 제목이 나갔다: ${row.summary}`)
    assert.ok(row.summary.includes('접근 권한 없음'), `요약도 본문과 같이 재인가돼야 한다: ${row.summary}`)

    // 2) 전역 검색 — 스니펫과 매칭 오라클 둘 다
    const wikiHits = (body) => (body.groups ?? []).flatMap((group) => group.items).filter((entry) => entry.kind === 'wiki')
    const searched = await member('GET', `/api/search?q=${encodeURIComponent('유출확인용')}`)
    assert.equal(searched.status, 200, JSON.stringify(searched.body))
    const hit = wikiHits(searched.body).find((entry) => entry.id === document.id)
    assert.ok(hit, `본문 낱말로는 걸려야 한다: ${JSON.stringify(searched.body).slice(0, 300)}`)
    assert.equal(hit.snippet.includes('관리자만 보는 업무'), false, `검색 스니펫으로 제목이 나갔다: ${hit.snippet}`)
    const oracle = await member('GET', `/api/search?q=${encodeURIComponent('관리자만 보는 업무')}`)
    assert.equal(wikiHits(oracle.body).length, 0, '요약에 남은 라벨이 존재 오라클이 된다')

    // 3) 문서 화면 안의 검색
    const inWiki = await member('GET', `/api/wiki?q=${encodeURIComponent('관리자만')}`)
    assert.equal(inWiki.body.documents.some((entry) => entry.id === document.id), false, '문서 목록 검색도 같은 오라클이다')
  })
})

// ── 6. 첨부 ────────────────────────────────────────────────────────────────
test('첨부는 볼 수 있는 파일만 걸리고, 문서가 쓰는 파일은 자료실에서 지워지지 않는다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const adminSession = await login(origin, ADMIN.email)
    const admin = api(origin, adminSession)
    const member = api(origin, await login(origin, PARK.email))
    const upload = await fetch(`${origin}/api/documents?${new URLSearchParams({ name: '도면.pdf', category: '프로젝트', visibility: 'restricted', tags: '' })}`, {
      method: 'POST',
      headers: { cookie: adminSession.headers.cookie, 'content-type': 'application/octet-stream', 'x-file-type': 'application/pdf', 'x-file-name': encodeURIComponent('도면.pdf') },
      body: Buffer.from('%PDF-1.4 wiki'),
    })
    const uploaded = await readJson(upload)
    assert.equal(upload.status, 201, JSON.stringify(uploaded))

    const document = await createDocument(admin, { title: '첨부 문서', projectId: 'PRJ-A' })
    const forbidden = await member('POST', `/api/wiki/${document.id}/ops`, {
      baseVersion: 1,
      ops: [{ opId: opId(), kind: 'insert', after: null, block: { id: blockId(), type: 'image', attachmentId: uploaded.document.id, text: '도면' } }],
    })
    assert.equal(forbidden.status, 400, JSON.stringify(forbidden.body))
    assert.equal(forbidden.body.error.code, 'WIKI_ATTACHMENT_FORBIDDEN')

    const attached = await admin('POST', `/api/wiki/${document.id}/ops`, {
      baseVersion: 1,
      ops: [{ opId: opId(), kind: 'insert', after: null, block: { id: blockId(), type: 'image', attachmentId: uploaded.document.id, text: '도면' } }],
    })
    assert.equal(attached.status, 200, JSON.stringify(attached.body))
    // 프로젝트 구성원에게 그 파일이 열린다.
    assert.equal((await member('GET', `/api/documents/${uploaded.document.id}/download`)).status, 200)
    // 문서가 쓰는 자료는 자료실에서 지워지지 않는다.
    const removal = await admin('DELETE', `/api/documents/${uploaded.document.id}`)
    assert.equal(removal.status, 409)
    assert.equal(removal.body.error.code, 'DOCUMENT_IN_USE')
  })
})

// ── 7. 업무 승격 ───────────────────────────────────────────────────────────
test('관리자는 문단에서 바로 업무를 만들고, 그 업무는 문서로 되짚어 간다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const document = await createDocument(admin, { title: '회의 결과' })
    const added = await admin('POST', `/api/wiki/${document.id}/ops`, { baseVersion: 1, ops: [insertOp('보고서 초안 쓰기', null, 'todo')] })
    const todo = added.body.document.blocks.find((block) => block.type === 'todo')

    const created = await admin('POST', `/api/wiki/${document.id}/blocks/${todo.id}/task`, {})
    assert.equal(created.status, 201, JSON.stringify(created.body))
    assert.equal(created.body.mode, 'created')
    assert.equal(created.body.workItem.title, '보고서 초안 쓰기')
    assert.deepEqual(created.body.workItem.origin, {
      kind: 'wiki', label: '문서에서 만든 업무', detail: '회의 결과', page: 'wiki', focusId: document.id,
    })
    assert.equal(created.body.version, added.body.version + 1)
    assert.equal(created.body.document.blocks.find((block) => block.id === todo.id).workItemId, created.body.workItem.id)

    const duplicate = await admin('POST', `/api/wiki/${document.id}/blocks/${todo.id}/task`, {})
    assert.equal(duplicate.status, 409)
    assert.equal(duplicate.body.error.code, 'WIKI_TASK_DUPLICATE')
  })
})

test('직원이 만든 업무는 승인 큐를 거치고, 같은 문단을 두 번 눌러도 제안은 하나다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const member = api(origin, await login(origin, PARK.email))
    const document = await createDocument(admin, { title: '직원 승격', projectId: 'PRJ-A' })
    // 제안은 AI 파생물이라 '활용'에서만 만들어진다.
    const raised = await admin('PATCH', `/api/wiki/${document.id}`, { version: 1, aiLevel: 'active' })
    assert.equal(raised.status, 200, JSON.stringify(raised.body))
    const added = await member('POST', `/api/wiki/${document.id}/ops`, { baseVersion: raised.body.version, ops: [insertOp('샘플 재검사', null, 'todo')] })
    const todo = added.body.document.blocks.find((block) => block.type === 'todo')

    const queued = await member('POST', `/api/wiki/${document.id}/blocks/${todo.id}/task`, {})
    assert.equal(queued.status, 201, JSON.stringify(queued.body))
    assert.equal(queued.body.mode, 'queued')
    assert.equal(queued.body.document.blocks.find((block) => block.id === todo.id).workItemId, undefined, '아직 업무가 아니므로 역링크를 찍지 않는다')

    const again = await member('POST', `/api/wiki/${document.id}/blocks/${todo.id}/task`, {})
    assert.equal(again.status, 201)
    const proposals = await admin('GET', '/api/proposals')
    const mine = proposals.body.proposals.filter((row) => row.kind === 'wiki-task')
    assert.equal(mine.length, 1, '같은 문단의 제안은 하나뿐이다')
    assert.equal(mine[0].payload.documentId, document.id)
  })
})

test('직원 승격을 막는 수준은 보관만 하나다 — 기본 수준(정리)에서는 그대로 승인 큐로 간다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const member = api(origin, await login(origin, PARK.email))
    const document = await createDocument(admin, { title: '기본 수준', projectId: 'PRJ-A' })
    assert.equal(document.aiLevel, 'indexed', '새 문서는 정리 수준으로 태어난다')
    const added = await member('POST', `/api/wiki/${document.id}/ops`, { baseVersion: 1, ops: [insertOp('할 일', null, 'todo')] })
    const todo = added.body.document.blocks.find((block) => block.type === 'todo')

    // 이 승격은 사람이 누른 것이다 — 기본값에서 막히면 직원의 주 경로가 통째로 죽는다.
    const queued = await member('POST', `/api/wiki/${document.id}/blocks/${todo.id}/task`, {})
    assert.equal(queued.status, 201, JSON.stringify(queued.body))
    assert.equal(queued.body.mode, 'queued')

    const locked = await admin('PATCH', `/api/wiki/${document.id}`, { version: added.body.version, aiLevel: 'locked' })
    assert.equal(locked.status, 200, JSON.stringify(locked.body))
    const blocked = await member('POST', `/api/wiki/${document.id}/blocks/${todo.id}/task`, { title: '보관만에서 다시' })
    if (blocked.status !== 403) {
      assert.fail(await diagnose(admin, '보관만 수준에서는 직원 승격이 막힌다', {
        status: blocked.status, body: blocked.body, document: document.id, todo: todo.id, aiLevel: locked.body?.document?.aiLevel,
      }))
    }
    assert.equal(blocked.body.error.code, 'AI_DERIVATION_LOCKED')
    assert.match(blocked.body.error.message, /보관만/)
  })
})

// ── 8. 프레즌스 ────────────────────────────────────────────────────────────
test('프레즌스는 저장소를 건드리지 않고 TTL로 스스로 사라진다', async () => {
  const store = seedStore()
  const clock = testClock()
  await withServer(buildApp(store, { wikiClock: clock.now }), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const member = api(origin, await login(origin, PARK.email))
    const document = await createDocument(admin, { title: '함께 보기', projectId: 'PRJ-A' })
    const target = document.blocks[0].id

    const first = await admin('POST', `/api/wiki/${document.id}/presence`, { blockId: target })
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.equal(first.body.roster.length, 1)
    assert.equal(first.body.version, 1)

    clock.advance(6_000)
    const second = await member('POST', `/api/wiki/${document.id}/presence`, { blockId: target })
    assert.equal(second.body.roster.length, 2)

    // 5초 이내 재호출은 갱신하지 않는다.
    const soon = await member('POST', `/api/wiki/${document.id}/presence`, { blockId: target })
    assert.equal(soon.status, 200)
    assert.equal(soon.body.roster.length, 2)

    clock.advance(46_000)
    const later = await member('POST', `/api/wiki/${document.id}/presence`, { blockId: target })
    assert.equal(later.body.roster.length, 1, 'TTL이 지난 사람은 사라진다')
    assert.equal(later.body.roster[0].accountId, PARK.id)

    const leaving = await member('POST', `/api/wiki/${document.id}/presence`, { leaving: true })
    assert.equal(leaving.body.roster.length, 0)

    const invalid = await admin('POST', `/api/wiki/${document.id}/presence`, { blockId: 'BLK-NOTHERE01' })
    assert.equal(invalid.status, 400)
    assert.equal(invalid.body.error.code, 'WIKI_PRESENCE_INVALID')

    assert.equal('presence' in store.tenants[TENANT], false, '프레즌스는 저장소에 남지 않는다')
  })
})

test('SSE는 문서 제목·본문을 싣지 않고, 프레즌스는 재연결 커서를 밀어내지 않는다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const session = await login(origin, ADMIN.email)
    const admin = api(origin, session)
    const document = await createDocument(admin, { title: '스트림에 새면 안 되는 제목', projectId: 'PRJ-A' })

    const controller = new AbortController()
    const stream = await fetch(`${origin}/api/events`, { headers: session.headers, signal: controller.signal })
    assert.equal(stream.status, 200)
    const reader = stream.body.getReader()
    let text = ''
    const drained = (async () => {
      try {
        while (!text.includes('event: wiki')) {
          const { done, value } = await reader.read()
          if (done) break
          text += Buffer.from(value).toString('utf8')
        }
      } catch { /* abort */ }
    })()
    const guard = setTimeout(() => controller.abort(), 5_000)
    const written = await admin('POST', `/api/wiki/${document.id}/ops`, { baseVersion: 1, ops: [insertOp('스트림에 새면 안 되는 본문')] })
    assert.equal(written.status, 200, JSON.stringify(written.body))
    await drained
    clearTimeout(guard)
    controller.abort()

    assert.match(text, /event: wiki/)
    const frame = text.split('\n\n').find((chunk) => chunk.includes('event: wiki')) ?? ''
    const data = JSON.parse(frame.match(/^data: (.*)$/m)?.[1] ?? '{}')
    assert.equal(data.change, 'ops')
    assert.equal(data.documentId, document.id)
    assert.ok(!text.includes('스트림에 새면 안 되는 제목'), `SSE에 제목이 실렸다: ${text}`)
    assert.ok(!text.includes('스트림에 새면 안 되는 본문'), `SSE에 본문이 실렸다: ${text}`)

    // 프레즌스를 링버퍼에 쌓으면 200칸이 몇 분 만에 밀려, 잠깐 끊겼던 다른 화면 전부가 resync를 받는다.
    const lastEventId = Number(text.match(/^id: (\d+)$/m)?.[1] ?? '0')
    for (let index = 0; index < 300; index += 1) {
      const beat = await admin('POST', `/api/wiki/${document.id}/presence`, { blockId: index % 2 ? null : document.blocks[0].id })
      assert.equal(beat.status, 200)
    }
    const reconnect = new AbortController()
    const again = await fetch(`${origin}/api/events`, {
      headers: { ...session.headers, 'last-event-id': String(lastEventId) }, signal: reconnect.signal,
    })
    const chunk = await again.body.getReader().read()
    reconnect.abort()
    const replay = Buffer.from(chunk.value ?? []).toString('utf8')
    assert.equal(replay.includes('event: resync'), false, `프레즌스가 링버퍼를 밀어냈다: ${replay}`)
  })
})

// ── 9. 보관 · 삭제 ─────────────────────────────────────────────────────────
test('보관한 문서는 목록에서 빠지고, 완전 삭제는 관리자만 · 보관 뒤에만 가능하다', async () => {
  const store = seedStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const root = await createDocument(admin, { title: '부모' })
    const child = await createDocument(admin, { title: '자식', parentId: root.id })

    const hasChildren = await admin('DELETE', `/api/wiki/${root.id}`)
    assert.equal(hasChildren.status, 409)
    assert.equal(hasChildren.body.error.code, 'WIKI_HAS_CHILDREN')

    const early = await admin('DELETE', `/api/wiki/${child.id}?purge=1`)
    assert.equal(early.status, 409)
    assert.equal(early.body.error.code, 'WIKI_PURGE_REQUIRES_ARCHIVE')

    const archived = await admin('DELETE', `/api/wiki/${child.id}`)
    assert.equal(archived.status, 200, JSON.stringify(archived.body))
    const list = await admin('GET', '/api/wiki')
    assert.equal(list.body.documents.some((row) => row.id === child.id), false)
    const archivedList = await admin('GET', '/api/wiki?archived=1')
    assert.equal(archivedList.body.documents.some((row) => row.id === child.id), true)

    const blocked = await admin('POST', `/api/wiki/${child.id}/ops`, { baseVersion: 2, ops: [insertOp('보관 뒤 편집')] })
    assert.equal(blocked.status, 409)
    assert.equal(blocked.body.error.code, 'WIKI_ARCHIVED')

    const purged = await admin('DELETE', `/api/wiki/${child.id}?purge=1`)
    assert.equal(purged.status, 200, JSON.stringify(purged.body))
    assert.equal(purged.body.purged, true)
    const revisions = store.tenants[TENANT]['wiki-revisions'].data
    assert.equal(revisions.some((row) => row.documentId === child.id), false, '고아 이력이 남으면 안 된다')
  })
})

test('보관 응답은 목록이 보여 준 자식 수와 같은 말을 한다 — 못 보는 자식은 루트로 올린다', async () => {
  const store = seedStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const editor = api(origin, await login(origin, PARK.email))   // PRJ-B editor
    const outsider = api(origin, await login(origin, OH.email))   // PRJ-B 비멤버

    const withHidden = await createDocument(admin, { title: '숨은 자식이 있는 부모' })
    const clean = await createDocument(admin, { title: '자식 없는 부모' })
    const child = await createDocument(admin, { title: '숨은 자식', parentId: withHidden.id })
    // 부모와 자식의 프로젝트가 어긋난 트리는 이제 어느 문으로도 만들 수 없다(그 자체가 잠금 테스트다).
    // 옛 데이터에는 남아 있을 수 있으므로 저장소에 직접 심어, 그 행을 만난 보관·삭제가 무엇을 하는지 본다.
    assert.equal((await admin('PATCH', `/api/wiki/${child.id}`, { version: child.version, projectId: 'PRJ-B' })).status, 400)
    const rows = store.tenants[TENANT]['wiki-documents'].data
    const index = rows.findIndex((row) => row.id === child.id)
    rows[index] = { ...rows[index], projectId: 'PRJ-B' }
    for (const row of [withHidden, clean]) {
      const opened = await admin('PATCH', `/api/wiki/${row.id}`, { version: row.version, writeScope: 'tenant' })
      assert.equal(opened.status, 200, JSON.stringify(opened.body))
    }

    const list = await outsider('GET', '/api/wiki')
    const counts = [withHidden.id, clean.id].map((id) => list.body.documents.find((row) => row.id === id).childCount)
    assert.deepEqual(counts, [0, 0], '못 보는 자식은 숫자에도 없다')

    // 같은 사람에게 목록이 '자식 0'이라고 말했다면 삭제도 같은 말을 해야 한다(존재 오라클 차단).
    const removedHidden = await outsider('DELETE', `/api/wiki/${withHidden.id}`)
    const removedClean = await outsider('DELETE', `/api/wiki/${clean.id}`)
    assert.equal(removedHidden.status, 200, JSON.stringify(removedHidden.body))
    assert.equal(removedClean.status, 200, JSON.stringify(removedClean.body))
    assert.deepEqual(removedHidden.body.reparentedIds, [child.id])
    assert.deepEqual(removedClean.body.reparentedIds, [])

    // 고아가 될 자식은 같은 커밋에서 루트로 올라가고, 프로젝트 구성원에게는 그대로 보인다.
    const seen = await editor('GET', `/api/wiki/${child.id}`)
    assert.equal(seen.status, 200)
    assert.equal(seen.body.document.parentId, null)
    assert.equal(seen.body.document.projectId, 'PRJ-B')
    assert.equal(seen.body.document.version, child.version + 1, '부모가 바뀐 사실이 이력에 남는다')
    const revisions = await editor('GET', `/api/wiki/${child.id}/revisions`)
    assert.equal(revisions.body.revisions[0].version, child.version + 1)

    // 보이는 자식은 여전히 409다.
    const visibleChild = await createDocument(admin, { title: '보이는 자식', parentId: child.id, projectId: 'PRJ-B' })
    assert.equal(visibleChild.parentId, child.id)
    const refused = await editor('DELETE', `/api/wiki/${child.id}`)
    assert.equal(refused.status, 409)
    assert.equal(refused.body.error.code, 'WIKI_HAS_CHILDREN')
  })
})

test('보관하는 문은 둘이지만 자식 규칙은 하나다 — PATCH도 DELETE와 같은 답을 한다', async () => {
  const store = seedStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const editor = api(origin, await login(origin, PARK.email))     // PRJ-B editor
    const outsider = api(origin, await login(origin, OH.email))     // PRJ-B 비멤버

    // ① 보이는 자식이 있으면 두 문이 같은 코드로 막는다.
    const parent = await createDocument(admin, { title: '보관할 부모' })
    const visible = await createDocument(admin, { title: '보이는 자식', parentId: parent.id })
    const patched = await admin('PATCH', `/api/wiki/${parent.id}`, { version: parent.version, archived: true })
    assert.equal(patched.status, 409, JSON.stringify(patched.body))
    assert.equal(patched.body.error.code, 'WIKI_HAS_CHILDREN')
    assert.equal((await admin('DELETE', `/api/wiki/${parent.id}`)).body.error.code, 'WIKI_HAS_CHILDREN')
    assert.equal((await admin('GET', `/api/wiki/${parent.id}`)).body.document.archivedAt, null, '거절된 보관은 아무것도 바꾸지 않는다')

    // ② 안 보이는 자식은 같은 커밋에서 루트로 올라가고 reparentedIds가 그 사실을 말한다.
    //    (어긋난 트리는 이제 만들 수 없으므로 옛 데이터를 저장소에 직접 심는다.)
    const hiddenParent = await createDocument(admin, { title: '숨은 자식이 있는 부모' })
    const hiddenChild = await createDocument(admin, { title: '숨은 자식', parentId: hiddenParent.id })
    const rows = store.tenants[TENANT]['wiki-documents'].data
    rows[rows.findIndex((row) => row.id === hiddenChild.id)] = { ...rows.find((row) => row.id === hiddenChild.id), projectId: 'PRJ-B' }
    const opened = await admin('PATCH', `/api/wiki/${hiddenParent.id}`, { version: hiddenParent.version, writeScope: 'tenant' })
    assert.equal(opened.status, 200, JSON.stringify(opened.body))

    // 자식이 안 보이는 사람이 보관한다 — 목록이 '자식 0'이라고 말한 그 사람이다.
    const archived = await outsider('PATCH', `/api/wiki/${hiddenParent.id}`, { version: opened.body.version, archived: true })
    assert.equal(archived.status, 200, JSON.stringify(archived.body))
    assert.deepEqual(archived.body.reparentedIds, [hiddenChild.id], '보관도 삭제와 같은 말을 한다')

    // 보관된 부모를 가리키는 parentId가 남으면 30일 뒤 스윕이 매달린 참조를 만든다.
    const orphan = await editor('GET', `/api/wiki/${hiddenChild.id}`)
    assert.equal(orphan.status, 200)
    assert.equal(orphan.body.document.parentId, null)
    assert.equal(orphan.body.document.version, hiddenChild.version + 1)
    assert.equal(visible.parentId, parent.id, '막힌 쪽의 자식은 그대로다')
  })
})

// ── 10. 상한 ───────────────────────────────────────────────────────────────
test('상한은 자르지 않고 거절한다 — 제목만 잘린다', async () => {
  const store = seedStore()
  await withServer(buildApp(store), async (origin) => {
    const call = api(origin, await login(origin, ADMIN.email))
    const long = await createDocument(call, { title: 'ㄱ'.repeat(250) })
    assert.equal(long.title.length, 200, '제목은 자른다(400이 아니다)')

    const document = await createDocument(call, { title: '상한' })
    const many = Array.from({ length: MAX_OPS_PER_BATCH + 1 }, () => insertOp('문단'))
    const tooMany = await call('POST', `/api/wiki/${document.id}/ops`, { baseVersion: 1, ops: many })
    assert.equal(tooMany.status, 400)
    assert.equal(tooMany.body.error.code, 'WIKI_OPS_INVALID')

    // 문서 총 길이 상한(200_000자)은 늘어나는 방향에만 걸린다.
    let version = 1
    for (let index = 0; index < 12; index += 1) {
      const result = await call('POST', `/api/wiki/${document.id}/ops`, {
        baseVersion: version, ops: [insertOp('가'.repeat(19_000), null, 'code')],
      })
      if (result.status === 413) {
        assert.equal(result.body.error.code, 'WIKI_DOCUMENT_TOO_LARGE')
        version = null
        break
      }
      assert.equal(result.status, 200, JSON.stringify(result.body))
      version = result.body.version
    }
    assert.equal(version, null, '총 길이 상한에 닿아야 한다')
  })
})

test('문단 수 상한과 문서 수 상한은 409로 답한다', async () => {
  const store = seedStore()
  const now = '2026-09-07T00:00:00.000Z'
  // 상한 근처를 HTTP로 만들면 시험이 분 단위로 늘어난다 — 저장소에 직접 심고 문 하나만 두드린다.
  const blocks = Array.from({ length: MAX_BLOCKS_PER_DOCUMENT }, (_unused, index) => ({
    id: `BLK-FULL${String(index).padStart(5, '0')}`, type: 'text', text: '', seq: index + 1, editedById: ADMIN.id, editedAt: now,
  }))
  const documents = [{
    id: 'WDOC-FULL', tenantId: TENANT, title: '가득 찬 문서', icon: '', parentId: null, projectId: null, spaceId: null,
    blocks, version: 1, blockSeq: blocks.length, tombstones: [], recentOpIds: [], recentLostOpIds: [],
    searchText: '', aiLevel: 'indexed', summary: '', summarySource: 'manual', writeScope: 'author',
    isTemplate: false, templateId: null, origin: null, clientRequestId: null,
    createdById: ADMIN.id, createdByName: ADMIN.name, createdAt: now,
    lastEditedById: ADMIN.id, lastEditedByName: ADMIN.name, lastEditedAt: now, archivedAt: null,
  }]
  for (let index = 0; index < MAX_DOCUMENTS_PER_TENANT - 1; index += 1) {
    documents.push({ ...documents[0], id: `WDOC-PAD${String(index).padStart(4, '0')}`, blocks: [blocks[0]], title: `채움 ${index}` })
  }
  store.tenants[TENANT]['wiki-documents'] = { data: documents, updatedAt: now, updatedBy: ADMIN.id }
  await withServer(buildApp(store), async (origin) => {
    const call = api(origin, await login(origin, ADMIN.email))
    const full = await call('POST', '/api/wiki/WDOC-FULL/ops', { baseVersion: 1, ops: [insertOp('한 개 더')] })
    assert.equal(full.status, 409, JSON.stringify(full.body))
    assert.equal(full.body.error.code, 'WIKI_BLOCK_LIMIT')

    const limited = await call('POST', '/api/wiki', { title: '한 건 더' })
    assert.equal(limited.status, 409)
    assert.equal(limited.body.error.code, 'WIKI_LIMIT')

    // 템플릿도 문서 행이다 — 정문이 409를 내는데 이 문이 열려 있으면 상한이 실효를 잃는다.
    const template = await call('POST', '/api/wiki/WDOC-FULL/save-as-template', { name: '상한 밖 템플릿' })
    assert.equal(template.status, 409, JSON.stringify(template.body))
    assert.equal(template.body.error.code, 'WIKI_LIMIT')
    assert.equal(store.tenants[TENANT]['wiki-documents'].data.length, MAX_DOCUMENTS_PER_TENANT)

    // 시스템 템플릿 lazy 시드도 문서 행을 새로 만드는 문이다 — 목록 조회 한 번이 상한을 넘기면
    // '문서는 회사당 500건까지'라는 문장이 거짓이 된다.
    const list = await call('GET', '/api/wiki')
    assert.equal(list.status, 200, '상한에 닿았다고 목록이 막히면 안 된다')
    assert.equal(
      store.tenants[TENANT]['wiki-documents'].data.length, MAX_DOCUMENTS_PER_TENANT,
      `lazy 시드가 상한을 넘겨 ${store.tenants[TENANT]['wiki-documents'].data.length}건이 되었다`,
    )
  })
})

// ── 11. 커밋 실패 ──────────────────────────────────────────────────────────
test('커밋이 실패하면 문서도 이력도 호출 전 그대로다', async () => {
  const store = seedStore()
  let failNext = false
  const app = createApp({
    apiKey: '', initialWorkspaceStore: store, documentUploadDirectory: uploadDir(),
    onWorkspaceStoreChange: () => { if (failNext) { failNext = false; throw new Error('디스크 오류') } },
  })
  await withServer(app, async (origin) => {
    const call = api(origin, await login(origin, ADMIN.email))
    const document = await createDocument(call, { title: '롤백' })
    const before = await call('GET', `/api/wiki/${document.id}`)
    const revisionsBefore = JSON.stringify(store.tenants[TENANT]['wiki-revisions'].data)

    failNext = true
    const failed = await call('POST', `/api/wiki/${document.id}/ops`, { baseVersion: 1, ops: [insertOp('저장 실패할 문단')] })
    assert.equal(failed.status, 500)
    assert.equal(failed.body.error.code, 'WIKI_WRITE_FAILED')

    const after = await call('GET', `/api/wiki/${document.id}`)
    assert.equal(after.body.document.version, before.body.document.version)
    assert.deepEqual(after.body.document.blocks, before.body.document.blocks)
    assert.equal(JSON.stringify(store.tenants[TENANT]['wiki-revisions'].data), revisionsBefore)
  })
})

test('커밋이 실패하면 그 쓰기에 딸린 부수효과도 함께 되돌아간다', async () => {
  const store = seedStore()
  let failNext = false
  const app = createApp({
    apiKey: '', initialWorkspaceStore: store, documentUploadDirectory: uploadDir(),
    onWorkspaceStoreChange: () => { if (failNext) { failNext = false; throw new Error('디스크 오류') } },
  })
  await withServer(app, async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const member = api(origin, await login(origin, PARK.email))
    const document = await createDocument(admin, { title: '부수효과', projectId: 'PRJ-A' })
    const active = await admin('PATCH', `/api/wiki/${document.id}`, { version: 1, aiLevel: 'active' })
    assert.equal(active.status, 200, JSON.stringify(active.body))
    const added = await member('POST', `/api/wiki/${document.id}/ops`, { baseVersion: active.body.version, ops: [insertOp('점검 예약', null, 'todo')] })
    const todo = added.body.document.blocks.find((block) => block.type === 'todo')
    assert.equal((await member('POST', `/api/wiki/${document.id}/blocks/${todo.id}/task`, {})).status, 201)
    const pendingOf = async () => (await admin('GET', '/api/proposals')).body.proposals.filter((row) => row.kind === 'wiki-task' && row.status === 'pending').length
    assert.equal(await pendingOf(), 1)

    // 수준을 낮추는 커밋이 실패하면, 수준도 그대로이고 파기했던 제안도 되살아나야 한다.
    failNext = true
    const failed = await admin('PATCH', `/api/wiki/${document.id}`, { version: added.body.version, aiLevel: 'locked' })
    assert.equal(failed.status, 500)
    assert.equal(failed.body.error.code, 'WIKI_WRITE_FAILED')
    assert.equal(await pendingOf(), 1, '저장되지 않은 수준 변경 때문에 제안이 사라지면 안 된다')
    const still = await admin('GET', `/api/wiki/${document.id}`)
    assert.equal(still.body.document.aiLevel, 'active')
  })
})

test('승격 커밋이 실패하면 그 제안을 가리키는 알림도 남지 않는다', async () => {
  const store = seedStore()
  let failNext = false
  const app = createApp({
    apiKey: '', initialWorkspaceStore: store, documentUploadDirectory: uploadDir(),
    onWorkspaceStoreChange: () => { if (failNext) { failNext = false; throw new Error('디스크 오류') } },
  })
  await withServer(app, async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const member = api(origin, await login(origin, PARK.email))
    const document = await createDocument(admin, { title: '불량률 재점검', projectId: 'PRJ-A' })
    const added = await member('POST', `/api/wiki/${document.id}/ops`, { baseVersion: 1, ops: [insertOp('불량률 재점검', null, 'todo')] })
    const todo = added.body.document.blocks.find((block) => block.type === 'todo')

    failNext = true
    const failed = await member('POST', `/api/wiki/${document.id}/blocks/${todo.id}/task`, {})
    assert.equal(failed.status, 500, JSON.stringify(failed.body))
    assert.equal(failed.body.error.code, 'WIKI_WRITE_FAILED')

    const proposals = (await admin('GET', '/api/proposals')).body.proposals.filter((row) => row.kind === 'wiki-task')
    assert.equal(proposals.length, 0, '되돌린 제안이 남으면 안 된다')
    // 되돌릴 수 없는 것(알림·SSE)은 되돌릴 수 있는 것 뒤에 서야 한다 —
    // 앞에 세우면 존재하지 않는 제안을 가리키는 알림만 관리자에게 남는다.
    const notifications = (await admin('GET', '/api/notifications')).body.items ?? []
    assert.equal(notifications.some((row) => row.type === 'proposal-pending'), false, JSON.stringify(notifications))

    // 같은 요청을 다시 보내면(이번에는 커밋이 성공) 제안과 알림이 함께 선다.
    const queued = await member('POST', `/api/wiki/${document.id}/blocks/${todo.id}/task`, {})
    assert.equal(queued.status, 201, JSON.stringify(queued.body))
    const after = (await admin('GET', '/api/notifications')).body.items ?? []
    assert.equal(after.some((row) => row.type === 'proposal-pending'), true, '성공한 승격은 알린다')
  })
})

// ── 12. 템플릿 ─────────────────────────────────────────────────────────────
test('기본 템플릿은 한 번만 시드되고, 지운 템플릿은 되살아나지 않는다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const call = api(origin, await login(origin, ADMIN.email))
    const first = await call('GET', '/api/wiki')
    assert.equal(first.body.templates.length, 4)
    const second = await call('GET', '/api/wiki')
    assert.equal(second.body.templates.length, 4)

    const meeting = second.body.templates.find((row) => row.id === 'WDOC-TPL-MEETING')
    const readonlyPatch = await call('PATCH', `/api/wiki/${meeting.id}`, { version: meeting.version, title: '고쳐보기' })
    assert.equal(readonlyPatch.status, 409)
    assert.equal(readonlyPatch.body.error.code, 'WIKI_TEMPLATE_READONLY')
    const readonlyOps = await call('POST', `/api/wiki/${meeting.id}/ops`, { baseVersion: meeting.version, ops: [insertOp('덧붙이기')] })
    assert.equal(readonlyOps.status, 409)
    assert.equal(readonlyOps.body.error.code, 'WIKI_TEMPLATE_READONLY')

    const fromTemplate = await createDocument(call, { title: '9월 회의록', templateId: meeting.id })
    const templateDetail = await call('GET', `/api/wiki/${meeting.id}`)
    const templateBlockIds = new Set(templateDetail.body.document.blocks.map((block) => block.id))
    assert.ok(fromTemplate.blocks.length > 1)
    assert.equal(fromTemplate.blocks.some((block) => templateBlockIds.has(block.id)), false, '블록 id를 공유하면 한쪽 편집이 다른 쪽을 건드린다')
  })
})

test('템플릿 본문에는 링크 대상의 제목이 남지 않는다 — 남의 문서는 저장할 수 없다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const member = api(origin, await login(origin, PARK.email))
    const document = await createDocument(admin, { title: '표준 절차' })
    await admin('POST', `/api/wiki/${document.id}/ops`, { baseVersion: 1, ops: [insertOp('담당 [[task:WK-ADMINONLY|어떤 업무]]')] })

    const forbidden = await member('POST', `/api/wiki/${document.id}/save-as-template`, { name: '남의 템플릿' })
    assert.equal(forbidden.status, 403)
    assert.equal(forbidden.body.error.code, 'WIKI_TEMPLATE_FORBIDDEN')

    const saved = await admin('POST', `/api/wiki/${document.id}/save-as-template`, { name: '표준 절차 템플릿' })
    assert.equal(saved.status, 201, JSON.stringify(saved.body))
    assert.equal(saved.body.template.origin.kind, 'user')
    assert.equal(JSON.stringify(saved.body.template.blocks).includes('[['), false, '템플릿 본문에 링크 토큰이 남으면 안 된다')
    // 저장된 라벨은 서버가 채워 넣은 **대상의 현재 제목**이다 — 토큰만 벗기면 그 제목이 평문으로 남는다.
    assert.equal(JSON.stringify(saved.body.template.blocks).includes('관리자만 보는 업무'), false, '못 보는 업무의 제목이 템플릿에 남으면 안 된다')
    assert.equal(saved.body.template.blocks.some((block) => String(block.text ?? '').includes('연결된 항목')), true)

    const missingName = await admin('POST', `/api/wiki/${document.id}/save-as-template`, { name: '  ' })
    assert.equal(missingName.status, 400)
    assert.equal(missingName.body.error.code, 'WIKI_TITLE_REQUIRED')
  })
})

test('못 보는 문서의 제목은 템플릿을 타고도 나가지 않는다 — 사본까지 따라간다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const member = api(origin, await login(origin, PARK.email))    // PRJ-B editor
    const outsider = api(origin, await login(origin, OH.email))    // PRJ-B 비멤버
    const secret = await createDocument(member, { title: 'B사 납품단가 협상안', projectId: 'PRJ-B' })
    const memo = await createDocument(member, { title: '전사 메모' })
    // 라벨은 'x'로 보내도 서버가 대상의 현재 제목으로 바꿔 저장한다(§3-4).
    const wrote = await member('POST', `/api/wiki/${memo.id}/ops`, { baseVersion: 1, ops: [insertOp(`검토 [[doc:${secret.id}|x]]`)] })
    assert.equal(wrote.status, 200, JSON.stringify(wrote.body))
    assert.equal(JSON.stringify(wrote.body.document.blocks).includes('B사 납품단가 협상안'), true, '작성자에게는 제목이 보인다')
    assert.equal((await outsider('GET', `/api/wiki/${secret.id}`)).status, 404)

    const saved = await member('POST', `/api/wiki/${memo.id}/save-as-template`, { name: '검토 서식' })
    assert.equal(saved.status, 201, JSON.stringify(saved.body))

    // 템플릿 자체도, 그것으로 만든 사본도 못 보는 문서의 이름을 싣지 않는다.
    const seen = await outsider('GET', `/api/wiki/${saved.body.template.id}`)
    assert.equal(seen.status, 200, JSON.stringify(seen.body))
    assert.equal(JSON.stringify(seen.body.document.blocks).includes('B사 납품단가'), false, '템플릿 본문이 이름을 흘리면 안 된다')

    const copied = await outsider('POST', '/api/wiki', { title: '내 검토', templateId: saved.body.template.id })
    assert.equal(copied.status, 201, JSON.stringify(copied.body))
    assert.equal(JSON.stringify(copied.body.document.blocks).includes('B사 납품단가'), false, '사본이 이름을 흘리면 안 된다')
    const exported = await outsider('GET', `/api/wiki/${copied.body.document.id}/export`)
    assert.equal(String(exported.body.raw ?? '').includes('B사 납품단가'), false, '내보내기도 마찬가지다')

    // 원본 메모는 여전히 렌더 시점에 재인가된다(토큰이 살아 있는 쪽은 그대로다).
    const rendered = await outsider('GET', `/api/wiki/${memo.id}`)
    assert.equal(JSON.stringify(rendered.body.document.blocks).includes('접근 권한 없음'), true)
  })
})

// ── 13. 재시도 · 버전 충돌 ─────────────────────────────────────────────────
test('같은 clientRequestId로 다시 만들면 문서가 늘지 않는다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const call = api(origin, await login(origin, ADMIN.email))
    const first = await call('POST', '/api/wiki', { title: '재시도', clientRequestId: 'REQ-1' })
    assert.equal(first.status, 201)
    const retry = await call('POST', '/api/wiki', { title: '재시도', clientRequestId: 'REQ-1' })
    assert.equal(retry.status, 200)
    assert.equal(retry.body.replayed, true)
    assert.equal(retry.body.document.id, first.body.document.id)
    const other = await call('POST', '/api/wiki', { title: '다른 요청', clientRequestId: 'REQ-2' })
    assert.equal(other.status, 201)
    assert.notEqual(other.body.document.id, first.body.document.id)
  })
})

test('만든 뒤 프로젝트로 옮겨진 문서는 같은 clientRequestId로도 돌아오지 않는다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const outsider = api(origin, await login(origin, OH.email))   // PRJ-B 비멤버
    const first = await outsider('POST', '/api/wiki', { title: '오태식의 메모', clientRequestId: 'REQ-OH-1' })
    assert.equal(first.status, 201, JSON.stringify(first.body))
    const moved = await admin('PATCH', `/api/wiki/${first.body.document.id}`, { version: 1, projectId: 'PRJ-B' })
    assert.equal(moved.status, 200, JSON.stringify(moved.body))
    const secret = await admin('POST', `/api/wiki/${first.body.document.id}/ops`, {
      baseVersion: moved.body.version, ops: [insertOp('B프로젝트 대외비 단가표')],
    })
    assert.equal(secret.status, 200, JSON.stringify(secret.body))

    // 정문이 404인데 뒷문이 열려 있으면, 나가는 것은 만들 때의 빈 문서가 아니라 **지금 본문 전체**다.
    assert.equal((await outsider('GET', `/api/wiki/${first.body.document.id}`)).status, 404)
    const replay = await outsider('POST', '/api/wiki', { title: '오태식의 메모', clientRequestId: 'REQ-OH-1' })
    assert.equal(replay.status, 404, JSON.stringify(replay.body))
    assert.equal(replay.body.error.code, 'WIKI_NOT_FOUND')
    assert.equal(JSON.stringify(replay.body).includes('대외비'), false)
    // 문서가 늘어나지도 않는다(재전송은 여전히 멱등이다).
    assert.equal((await admin('GET', '/api/wiki')).body.documents.length, 1)
  })
})

test('낡은 version으로 보낸 PATCH는 지금 버전을 알려 주며 거절된다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const call = api(origin, await login(origin, ADMIN.email))
    const document = await createDocument(call, { title: '충돌 확인' })
    await call('PATCH', `/api/wiki/${document.id}`, { version: 1, title: '새 제목' })
    const stale = await call('PATCH', `/api/wiki/${document.id}`, { version: 1, title: '더 새 제목' })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.error.code, 'WIKI_VERSION_CONFLICT')
    assert.equal(stale.body.error.currentVersion, 2)
  })
})

test('같은 버전이면 본문을 다시 보내지 않는다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const call = api(origin, await login(origin, ADMIN.email))
    const document = await createDocument(call, { title: '조건부 조회' })
    const unchanged = await call('GET', `/api/wiki/${document.id}?since=1`)
    assert.equal(unchanged.status, 204)
    const changed = await call('GET', `/api/wiki/${document.id}?since=0`)
    assert.equal(changed.status, 200)
  })
})

// ── 14. 스케줄러 ───────────────────────────────────────────────────────────
test('보관 30일이 지난 문서와 그 이력은 청소 작업이 완전히 지운다', async () => {
  const store = seedStore()
  const clock = testClock()
  const app = buildApp(store, { wikiClock: clock.now })
  await withServer(app, async (origin) => {
    const call = api(origin, await login(origin, ADMIN.email))
    const document = await createDocument(call, { title: '지워질 문서' })
    assert.equal((await call('DELETE', `/api/wiki/${document.id}`)).status, 200)

    // 두 잡이 실제로 등록돼 있어야 한다 — 러너만 있고 잡이 없으면 운영에서는 아무 일도 일어나지 않는다.
    const operator = api(origin, await login(origin, 'operator@onfactory.co.kr'))
    const jobs = await operator('GET', '/api/platform/scheduler')
    const jobIds = jobs.body.jobs.map((job) => job.id)
    assert.ok(jobIds.includes('wiki-archive-sweep'), JSON.stringify(jobIds))
    assert.ok(jobIds.includes('wiki-revision-sweep'), JSON.stringify(jobIds))

    // 시각은 직접 넣는다 — 벽시계로 재면 이 시험은 30일이 지나야만 통과한다.
    const early = await app.locals.sweepWikiArchive(clock.now())
    assert.equal(early.removed, 0, '30일 전에는 지우지 않는다')
    assert.ok(store.tenants[TENANT]['wiki-documents'].data.some((row) => row.id === document.id))

    clock.advance(31 * 24 * 60 * 60 * 1_000)
    const late = await app.locals.sweepWikiArchive(clock.now())
    assert.equal(late.removed, 1)
    assert.equal(store.tenants[TENANT]['wiki-documents'].data.some((row) => row.id === document.id), false)
    assert.equal(store.tenants[TENANT]['wiki-revisions'].data.some((row) => row.documentId === document.id), false)

    const revisionSweep = await app.locals.sweepWikiRevisions(clock.now())
    assert.equal(typeof revisionSweep.removed, 'number')

    // 안전망: 지우는 문서를 가리키는 parentId는 스윕이 끊는다.
    // 정문(보관)이 이미 자식을 루트로 올리므로 이 상태는 옛 데이터로만 만들어진다 — 그래서 직접 심는다.
    const parent = await createDocument(call, { title: '먼저 보관될 부모' })
    const orphan = await createDocument(call, { title: '매달릴 자식' })
    const archivedAt = clock.now().toISOString()
    store.tenants[TENANT]['wiki-documents'] = {
      data: store.tenants[TENANT]['wiki-documents'].data.map((row) => {
        if (row.id === parent.id) return { ...row, archivedAt }
        if (row.id === orphan.id) return { ...row, parentId: parent.id }
        return row
      }),
      updatedAt: archivedAt, updatedBy: ADMIN.id,
    }
    clock.advance(31 * 24 * 60 * 60 * 1_000)
    await app.locals.sweepWikiArchive(clock.now())
    const survivor = store.tenants[TENANT]['wiki-documents'].data.find((row) => row.id === orphan.id)
    assert.equal(store.tenants[TENANT]['wiki-documents'].data.some((row) => row.id === parent.id), false)
    assert.equal(survivor.parentId, null, '없는 문서를 가리키는 parentId가 남으면 안 된다')
  })
})

// ── 13. 3회차 검증에서 잡힌 것 ──────────────────────────────────────────────
test('스케줄러 스윕도 라우트와 같은 줄에 선다 — 스윕의 롤백이 그 사이 201을 받은 저장을 지우지 않는다', async () => {
  const clock = testClock()
  const gate = gatedCommit()
  const store = seedStore()
  const app = buildApp(store, { onWorkspaceStoreChange: gate.onChange, wikiClock: clock.now })
  await withServer(app, async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const doomed = await createDocument(admin, { title: '30일 뒤 지워질 문서' })
    assert.equal((await admin('DELETE', `/api/wiki/${doomed.id}`)).status, 200)
    clock.advance(31 * 24 * 60 * 60 * 1_000)

    gate.arm()
    const sweeping = app.locals.sweepWikiArchive(clock.now())
    // 스윕이 커밋 앞에서 붙잡혀 있는 동안 사람이 문서를 만든다.
    const creating = admin('POST', '/api/wiki', { title: '스윕 도중에 만든 문서' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    gate.release()
    const swept = await sweeping.catch((error) => ({ threw: error?.message }))
    const created = await creating

    assert.equal(created.status, 201, JSON.stringify(created.body))
    // 스윕은 커밋에 실패했으니 통째로 되돌아간다 — 보관 문서가 살아 있는 것이 정상이다.
    assert.deepEqual(swept, { removed: 0 })
    assert.ok(store.tenants[TENANT]['wiki-documents'].data.some((row) => row.id === doomed.id), '스윕이 롤백되지 않았다')
    const after = await admin('GET', `/api/wiki/${created.body.document.id}`)
    assert.equal(after.status, 200, `201을 받은 문서를 스윕 롤백이 지웠다: ${JSON.stringify(after.body)}`)
  })
})

test('이력 정리 스윕도 같은 줄에 선다 — 그 롤백도 남의 저장을 지우지 않는다', async () => {
  const clock = testClock()
  const gate = gatedCommit()
  const store = seedStore()
  const app = buildApp(store, { onWorkspaceStoreChange: gate.onChange, wikiClock: clock.now })
  await withServer(app, async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const document = await createDocument(admin, { title: '이력 있는 문서' })
    assert.equal((await admin('POST', `/api/wiki/${document.id}/ops`, { baseVersion: 1, ops: [insertOp('한 줄')] })).status, 200)
    clock.advance(400 * 24 * 60 * 60 * 1_000)

    gate.arm()
    const sweeping = app.locals.sweepWikiRevisions(clock.now())
    const creating = admin('POST', '/api/wiki', { title: '이력 스윕 도중에 만든 문서' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    gate.release()
    const swept = await sweeping.catch((error) => ({ threw: error?.message }))
    const created = await creating

    assert.equal(created.status, 201, JSON.stringify(created.body))
    assert.deepEqual(swept, { removed: 0 })
    const after = await admin('GET', `/api/wiki/${created.body.document.id}`)
    assert.equal(after.status, 200, `201을 받은 문서를 이력 스윕 롤백이 지웠다: ${JSON.stringify(after.body)}`)
  })
})

test('부모 보관은 내가 고칠 수 없는 자식을 대신 고쳐 쓰지 않는다 — 정문 403과 같은 답을 한다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const park = api(origin, await login(origin, PARK.email))
    const outsider = api(origin, await login(origin, OH.email))

    // 부모는 전사 쓰기 — 오태식도 고칠 수 있다. 자식은 박지현이 만든 기본(작성자) 문서다.
    const parent = await createDocument(admin, { title: '보관할 부모' })
    const opened = await admin('PATCH', `/api/wiki/${parent.id}`, { version: parent.version, writeScope: 'tenant' })
    assert.equal(opened.status, 200, JSON.stringify(opened.body))
    const child = await createDocument(park, { title: '남이 만든 자식', parentId: parent.id })

    // 전제: 같은 사람이 정문으로 그 자식을 고치면 403이다.
    const frontDoor = await outsider('PATCH', `/api/wiki/${child.id}`, { version: child.version, title: '남이 고침' })
    assert.equal(frontDoor.status, 403, JSON.stringify(frontDoor.body))
    assert.equal(frontDoor.body.error.code, 'WIKI_FORBIDDEN')
    // 자식이 보관돼 있어야 WIKI_HAS_CHILDREN을 지나 재부모화 경로로 들어간다.
    assert.equal((await park('DELETE', `/api/wiki/${child.id}`)).status, 200)
    const archivedChild = (await park('GET', `/api/wiki/${child.id}`)).body.document

    const parentNow = (await outsider('GET', `/api/wiki/${parent.id}`)).body.document
    const patched = await outsider('PATCH', `/api/wiki/${parent.id}`, { version: parentNow.version, archived: true })
    assert.equal(patched.status, 409, JSON.stringify(patched.body))
    assert.equal(patched.body.error.code, 'WIKI_MOVE_BLOCKED', '뒷문이 정문과 다른 답을 했다')
    const deleted = await outsider('DELETE', `/api/wiki/${parent.id}`)
    assert.equal(deleted.status, 409, JSON.stringify(deleted.body))
    assert.equal(deleted.body.error.code, 'WIKI_MOVE_BLOCKED', 'DELETE도 PATCH와 같은 자리에서 갈라졌다')

    // 거절된 조작은 자식도 부모도 한 글자 바꾸지 않는다.
    const untouched = (await park('GET', `/api/wiki/${child.id}`)).body.document
    assert.equal(untouched.parentId, parent.id)
    assert.equal(untouched.version, archivedChild.version)
    assert.equal(untouched.lastEditedByName, PARK.name, '못 쓰는 사람이 남의 문서 마지막 편집자가 됐다')
    assert.equal((await outsider('GET', `/api/wiki/${parent.id}`)).body.document.archivedAt, null)

    // 자식을 고칠 수 있는 사람(작성자)은 그대로 보관할 수 있다 — 막는 것은 권한이지 보관이 아니다.
    const byOwner = await park('PATCH', `/api/wiki/${parent.id}`, { version: parentNow.version, archived: true })
    assert.equal(byOwner.status, 200, JSON.stringify(byOwner.body))
    assert.deepEqual(byOwner.body.reparentedIds, [child.id])
  })
})

test('프로젝트 동반 이동은 하위 문서에도 버전과 이력을 남긴다 — 열람 범위가 바뀐 사실이 그 문서에 적힌다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const parent = await createDocument(admin, { title: '옮길 부모' })
    const child = await createDocument(admin, { title: '딸려 갈 자식', parentId: parent.id })

    const moved = await admin('PATCH', `/api/wiki/${parent.id}`, { version: parent.version, projectId: 'PRJ-A' })
    assert.equal(moved.status, 200, JSON.stringify(moved.body))
    assert.deepEqual(moved.body.movedIds, [parent.id, child.id])

    const after = (await admin('GET', `/api/wiki/${child.id}`)).body.document
    assert.equal(after.projectId, 'PRJ-A')
    assert.equal(after.version, child.version + 1, '열람 범위가 바뀌었는데 그 문서의 버전이 그대로다')
    // 열린 편집 화면은 `?since=<옛 버전>`으로 되묻는다 — 204면 바뀐 사실을 영영 모른다.
    const since = await admin('GET', `/api/wiki/${child.id}?since=${child.version}`)
    assert.equal(since.status, 200, '204를 받으면 열린 화면이 범위 변경을 모른다')

    const revisions = await admin('GET', `/api/wiki/${child.id}/revisions`)
    assert.equal(revisions.body.revisions.length, 2)
    assert.equal(revisions.body.revisions[0].version, child.version + 1)
    assert.equal(revisions.body.revisions[0].summary, '프로젝트를 바꿨습니다')
    assert.equal(revisions.body.revisions[0].byId, ADMIN.id)
    const detail = await admin('GET', `/api/wiki/${child.id}/revisions/${child.version + 1}`)
    assert.equal(detail.status, 200, JSON.stringify(detail.body))

    // 한 PATCH가 보관과 프로젝트 이동을 함께 하면, 그 자식에게 일어난 두 일이 서로를 지우지 않는다.
    const holder = await createDocument(admin, { title: '보관하며 옮길 부모' })
    const archivedChild = await createDocument(admin, { title: '보관된 자식', parentId: holder.id })
    assert.equal((await admin('DELETE', `/api/wiki/${archivedChild.id}`)).status, 200)
    const archivedVersion = (await admin('GET', `/api/wiki/${archivedChild.id}`)).body.document.version
    const both = await admin('PATCH', `/api/wiki/${holder.id}`, { version: holder.version, archived: true, projectId: 'PRJ-A' })
    assert.equal(both.status, 200, JSON.stringify(both.body))
    const composed = (await admin('GET', `/api/wiki/${archivedChild.id}`)).body.document
    assert.equal(composed.parentId, null)
    assert.equal(composed.projectId, 'PRJ-A')
    assert.equal(composed.version, archivedVersion + 2, '두 사실이 한 줄로 뭉개졌다')
    const composedRevisions = await admin('GET', `/api/wiki/${archivedChild.id}/revisions`)
    assert.deepEqual(
      composedRevisions.body.revisions.slice(0, 2).map((row) => row.summary),
      ['프로젝트를 바꿨습니다', '최상위로 옮겼습니다'],
    )
  })
})

test('원시형으로 바꿀 수 없는 본문 값도 500이 아니라 그 라우트의 답으로 접힌다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const call = api(origin, await login(origin, ADMIN.email))
    // JSON으로 올 수 있는 값 중 `String(value)`가 던지는 모양이다(원시형 변환 불가).
    const evil = { toString: null, valueOf: null }
    const document = await createDocument(call, { title: '이상한 값' })
    const block = document.blocks[0].id
    const cases = [
      ['POST', '/api/wiki', { title: evil }],
      ['POST', '/api/wiki', { title: '문서', icon: evil }],
      ['POST', '/api/wiki', { title: '문서', parentId: evil }],
      ['POST', '/api/wiki', { title: '문서', projectId: evil }],
      ['POST', '/api/wiki', { title: '문서', templateId: evil }],
      ['POST', '/api/wiki', { title: '문서', clientRequestId: evil }],
      ['PATCH', `/api/wiki/${document.id}`, { version: 1, title: evil }],
      ['PATCH', `/api/wiki/${document.id}`, { version: 1, icon: evil }],
      ['PATCH', `/api/wiki/${document.id}`, { version: 1, summary: evil }],
      ['PATCH', `/api/wiki/${document.id}`, { version: 1, parentId: evil }],
      ['PATCH', `/api/wiki/${document.id}`, { version: 1, projectId: evil }],
      ['POST', `/api/wiki/${document.id}/presence`, { blockId: evil }],
      ['POST', `/api/wiki/${document.id}/presence`, { leaving: true, blockId: evil }],
      ['POST', `/api/wiki/${document.id}/save-as-template`, { name: evil }],
      ['POST', `/api/wiki/${document.id}/save-as-template`, { name: '이름', description: evil }],
      ['POST', `/api/wiki/${document.id}/blocks/${block}/task`, { title: evil }],
      ['POST', `/api/wiki/${document.id}/blocks/${block}/task`, { title: '업무', owner: evil }],
    ]
    const crashed = []
    for (const [method, route, body] of cases) {
      const result = await call(method, route, body)
      if (result.status >= 500) crashed.push(`${method} ${route} ${JSON.stringify(body)} → ${result.status} ${JSON.stringify(result.body)}`)
    }
    assert.deepEqual(crashed, [], `500을 낸 자리\n  ${crashed.join('\n  ')}`)

    // 설계표의 코드로 접힌다: 프레즌스는 400, 이름이 필요한 곳은 400, 나머지는 '없는 값'이다.
    const presence = await call('POST', `/api/wiki/${document.id}/presence`, { blockId: evil })
    assert.equal(presence.status, 400)
    assert.equal(presence.body.error.code, 'WIKI_PRESENCE_INVALID')
    const template = await call('POST', `/api/wiki/${document.id}/save-as-template`, { name: evil })
    assert.equal(template.status, 400)
    assert.equal(template.body.error.code, 'WIKI_TITLE_REQUIRED')
  })
})

test('프로젝트 문서의 SSE는 그 프로젝트 사람에게만 간다 — 문서 id도 프레즌스 이름도', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const adminSession = await login(origin, ADMIN.email)
    const admin = api(origin, adminSession)
    const outsiderSession = await login(origin, OH.email)      // PRJ-B 비멤버
    const secret = await createDocument(admin, { title: 'PRJ-B 문서', projectId: 'PRJ-B' })
    const open = await createDocument(admin, { title: '전사 문서' })

    const controller = new AbortController()
    const stream = await fetch(`${origin}/api/events`, { headers: outsiderSession.headers, signal: controller.signal })
    assert.equal(stream.status, 200)
    const reader = stream.body.getReader()
    let text = ''
    // 경계 신호: **읽을 수 있는** 문서의 프레임이 도착하면 그보다 먼저 난 프레임들은 오지 않은 것이다.
    const drained = (async () => {
      try {
        while (!text.includes(open.id)) {
          const { done, value } = await reader.read()
          if (done) break
          text += Buffer.from(value).toString('utf8')
        }
      } catch { /* abort */ }
    })()
    const guard = setTimeout(() => controller.abort(), 5_000)
    const written = await admin('POST', `/api/wiki/${secret.id}/ops`, { baseVersion: 1, ops: [insertOp('비공개 본문')] })
    assert.equal(written.status, 200, JSON.stringify(written.body))
    const beat = await admin('POST', `/api/wiki/${secret.id}/presence`, { blockId: written.body.document.blocks[0].id })
    assert.equal(beat.status, 200, JSON.stringify(beat.body))
    const fence = await admin('POST', `/api/wiki/${open.id}/ops`, { baseVersion: 1, ops: [insertOp('전사 본문')] })
    assert.equal(fence.status, 200, JSON.stringify(fence.body))
    await drained
    clearTimeout(guard)
    controller.abort()

    assert.ok(text.includes(open.id), `경계 신호가 오지 않았다: ${text}`)
    assert.equal(text.includes(secret.id), false, `못 읽는 문서의 id가 스트림에 실렸다: ${text}`)
    assert.equal(text.includes(ADMIN.name), false, `못 읽는 문서의 프레즌스 이름이 스트림에 실렸다: ${text}`)
  })
})

test('ops 응답은 라우트 표가 선언한 필드만 싣는다 — 되살아난 블록이라는 개념은 없다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const call = api(origin, await login(origin, ADMIN.email))
    const document = await createDocument(call, { title: '응답 모양' })
    const written = await call('POST', `/api/wiki/${document.id}/ops`, { baseVersion: 1, ops: [insertOp('한 줄')] })
    assert.equal(written.status, 200, JSON.stringify(written.body))
    assert.deepEqual(
      Object.keys(written.body).sort(),
      ['applied', 'document', 'lostEditCount', 'overwrites', 'presence', 'rejected', 'version'],
      '서버와 라우트 표가 다른 말을 한다',
    )
  })
})

test('프루닝 창 밖의 버전은 목록·본문·되돌리기가 모두 410으로 같은 말을 한다', async () => {
  const clock = testClock()
  const store = seedStore()
  const app = buildApp(store, { wikiClock: clock.now })
  await withServer(app, async (origin) => {
    const call = api(origin, await login(origin, ADMIN.email))
    const document = await createDocument(call, { title: '오래된 이력' })
    for (const text of ['둘', '셋']) {
      const baseVersion = (await call('GET', `/api/wiki/${document.id}`)).body.document.version
      const written = await call('POST', `/api/wiki/${document.id}/ops`, { baseVersion, ops: [insertOp(text)] })
      assert.equal(written.status, 200, JSON.stringify(written.body))
    }
    const current = (await call('GET', `/api/wiki/${document.id}`)).body.document.version
    assert.equal(current, 3)

    // 실제 정리 경로로 창을 좁힌다(손으로 행을 지우지 않는다) — 1년이 지나면 문서당 최신 한 줄만 남는다.
    clock.advance(400 * 24 * 60 * 60 * 1_000)
    const swept = await app.locals.sweepWikiRevisions(clock.now())
    assert.ok(swept.removed > 0, JSON.stringify(swept))

    const list = await call('GET', `/api/wiki/${document.id}/revisions`)
    assert.equal(list.status, 200, JSON.stringify(list.body))
    assert.equal(list.body.oldestVersion, current, '목록이 말하는 가장 오래된 버전이 남은 줄과 다르다')
    assert.deepEqual(list.body.retention, { maxRevisions: 200, budgetChars: 2_000_000 })

    // 목록이 말한 버전은 반드시 되살아난다(§4-4 불변식 R).
    assert.equal((await call('GET', `/api/wiki/${document.id}/revisions/${current}`)).status, 200)
    const gone = await call('GET', `/api/wiki/${document.id}/revisions/${current - 1}`)
    assert.equal(gone.status, 410, JSON.stringify(gone.body))
    assert.equal(gone.body.error.code, 'WIKI_REVISION_UNAVAILABLE')
    const restoreGone = await call('POST', `/api/wiki/${document.id}/restore`, { version: current - 1, expectedCurrentVersion: current })
    assert.equal(restoreGone.status, 410, JSON.stringify(restoreGone.body))
    assert.equal(restoreGone.body.error.code, 'WIKI_REVISION_UNAVAILABLE')
    const reinstateGone = await call('POST', `/api/wiki/${document.id}/revisions/${current - 1}/blocks/${document.blocks[0].id}/reinstate`)
    assert.equal(reinstateGone.status, 410, JSON.stringify(reinstateGone.body))
    assert.equal(reinstateGone.body.error.code, 'WIKI_REVISION_UNAVAILABLE')
    const restoreOk = await call('POST', `/api/wiki/${document.id}/restore`, { version: current, expectedCurrentVersion: current })
    assert.equal(restoreOk.status, 200, JSON.stringify(restoreOk.body))
  })
})

test('하위 문서 생성은 부모의 프로젝트를 물려받는다 — PATCH와 같은 답을 한다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const call = api(origin, await login(origin, ADMIN.email))
    const parent = await createDocument(call, { title: '프로젝트 루트', projectId: 'PRJ-A' })

    // ① 정직한 클라이언트는 부모의 프로젝트를 모른다 — 그래도 하위 문서를 만들 수 있어야 한다.
    const inherited = await call('POST', '/api/wiki', { title: '하위 문서', parentId: parent.id })
    assert.equal(inherited.status, 201, JSON.stringify(inherited.body))
    assert.equal(inherited.body.document.projectId, 'PRJ-A', '상속하지 않으면 상속 줄이 죽은 코드가 된다')

    // ② 같은 일을 PATCH로 해도 같은 답이다.
    const loose = await createDocument(call, { title: '전사 문서' })
    const patched = await call('PATCH', `/api/wiki/${loose.id}`, { version: loose.version, parentId: parent.id })
    assert.equal(patched.status, 200, JSON.stringify(patched.body))
    assert.equal(patched.body.document.projectId, 'PRJ-A')

    // ③ 명시했는데 부모와 어긋나면 그때가 400이다(어긋난 트리는 어느 문으로도 만들 수 없다).
    const explicit = await call('POST', '/api/wiki', { title: '어긋난 하위', parentId: parent.id, projectId: 'PRJ-B' })
    assert.equal(explicit.status, 400, JSON.stringify(explicit.body))
    assert.equal(explicit.body.error.code, 'WIKI_PARENT_PROJECT_MISMATCH')
    const nulled = await call('POST', '/api/wiki', { title: '전사로 빼내기', parentId: parent.id, projectId: null })
    assert.equal(nulled.status, 400, JSON.stringify(nulled.body))
    assert.equal(nulled.body.error.code, 'WIKI_PARENT_PROJECT_MISMATCH')
  })
})

// ── 12. 읽을 수 있는 사람 = 신호를 받는 사람 (판정 한 벌) ────────────────────
/**
 * 실제 SSE 하나를 열고 도착한 텍스트를 모은다. 발행 경로를 흉내 내지 않는다 —
 * 청중 판정은 `events.publish`의 accountIds 필터에서 실제로 걸리므로 그 자리를 지나야 잰 것이다.
 */
async function collectStream(origin, session) {
  const controller = new AbortController()
  const stream = await fetch(`${origin}/api/events`, { headers: session.headers, signal: controller.signal })
  assert.equal(stream.status, 200)
  const reader = stream.body.getReader()
  let text = ''
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        text += Buffer.from(value).toString('utf8')
      }
    } catch { /* abort */ }
  })()
  return { seen: () => text, close: async () => { controller.abort(); await pump } }
}

/** 프레임이 도착할 시간을 준다(폴링 — 고정 sleep은 느린 기계에서 야간 실패의 씨앗이다). */
const waitForFrame = async (stream, needle) => {
  for (let attempt = 0; attempt < 60 && !stream.seen().includes(needle); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test('회사 전체 열람 프로젝트: 읽을 수 있는 직원에게 편집 신호가 간다 — 판정은 한 벌이다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const adminSession = await login(origin, ADMIN.email)
    const admin = api(origin, adminSession)
    const ohSession = await login(origin, OH.email)          // PRJ-OPEN 비멤버, PRJ-B 비멤버
    const oh = api(origin, ohSession)
    const open = await createDocument(admin, { title: '회사 전체 열람 문서', projectId: 'PRJ-OPEN' })
    const secret = await createDocument(admin, { title: 'PRJ-B 문서', projectId: 'PRJ-B' })

    // 전제: 오태식은 이 문서를 **실제로 읽는다**. 읽지 못하면 아래 단언은 아무것도 재지 않는다.
    assert.equal((await oh('GET', `/api/wiki/${open.id}`)).status, 200)

    const ohStream = await collectStream(origin, ohSession)
    const written = await admin('POST', `/api/wiki/${open.id}/ops`, { baseVersion: 1, ops: [insertOp('전사 공개 본문')] })
    assert.equal(written.status, 200, JSON.stringify(written.body))
    // 못 읽는 문서도 같은 창에서 함께 흔든다 — 새는 쪽과 안 가는 쪽을 한 번에 잰다.
    const leak = await admin('POST', `/api/wiki/${secret.id}/ops`, { baseVersion: 1, ops: [insertOp('비공개 본문')] })
    assert.equal(leak.status, 200, JSON.stringify(leak.body))
    await waitForFrame(ohStream, open.id)
    await ohStream.close()

    assert.ok(
      ohStream.seen().includes(open.id),
      `읽을 수 있는 직원에게 편집 신호가 가지 않았다 — 열람 판정과 청중 판정이 두 벌이다: ${ohStream.seen()}`,
    )
    assert.equal(ohStream.seen().includes(secret.id), false, `못 읽는 문서의 id가 스트림에 실렸다: ${ohStream.seen()}`)
  })
})

test('멤버 전용 프로젝트 문서의 신호는 프로젝트 밖 관리자에게도 간다 — 관리자는 그 문서를 읽는다', async () => {
  const store = seedStore()
  // 관리자를 어느 프로젝트의 멤버도 아니게 둔다. 그래도 `projectRoleOf`가 'owner'를 주므로 읽는다.
  store.tenants[TENANT]['project-spaces'].data = [{
    ...project('PRJ-PARKONLY', '박지현만', [{ id: PARK.id, name: PARK.name, role: 'owner' }]),
    ownerId: PARK.id, ownerName: PARK.name,
  }]
  await withServer(buildApp(store), async (origin) => {
    const parkSession = await login(origin, PARK.email)
    const park = api(origin, parkSession)
    const adminSession = await login(origin, ADMIN.email)
    const admin = api(origin, adminSession)
    const document = await createDocument(park, { title: '박지현 프로젝트 문서', projectId: 'PRJ-PARKONLY' })
    assert.equal((await admin('GET', `/api/wiki/${document.id}`)).status, 200, '관리자는 이 문서를 읽는다(전제)')

    const adminStream = await collectStream(origin, adminSession)
    const written = await park('POST', `/api/wiki/${document.id}/ops`, { baseVersion: 1, ops: [insertOp('박지현이 쓴 줄')] })
    assert.equal(written.status, 200, JSON.stringify(written.body))
    await waitForFrame(adminStream, document.id)
    await adminStream.close()
    assert.ok(adminStream.seen().includes(document.id), `읽을 수 있는 관리자에게 신호가 가지 않았다: ${adminStream.seen()}`)
  })
})

// ── 13. 프로젝트가 사라진 뒤에도 문서에 닿는 문이 남는다 ─────────────────────
test('프로젝트를 지우면 그 문서는 같은 커밋에서 보관되고, 상한 칸도 돌려준다', async () => {
  const store = seedStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const document = await createDocument(admin, { title: '프로젝트 원가표', projectId: 'PRJ-B' })
    const before = (await admin('GET', '/api/wiki')).body.documents.length

    const deleted = await admin('DELETE', '/api/projects/PRJ-B')
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body))
    assert.deepEqual(deleted.body.archivedWikiIds, [document.id], '프로젝트 삭제가 위키를 손대지 않았다')

    // 프로젝트 행 삭제와 문서 보관은 **한 커밋**이다 — 저장소에서 둘 다 확인한다.
    const rows = store.tenants[TENANT]['wiki-documents'].data
    assert.equal(rows.filter((row) => row.id === document.id).length, 1)
    assert.ok(rows.find((row) => row.id === document.id).archivedAt, '문서가 보관되지 않았다 — 아무도 닿지 못하는 행이 남는다')
    assert.equal(store.tenants[TENANT]['project-spaces'].data.some((row) => row.id === 'PRJ-B'), false)

    // 사람이 볼 수 있는 자리에 있다: 보관함에 있고, 상한 칸은 돌려받았다.
    const active = await admin('GET', '/api/wiki')
    assert.equal(active.body.documents.length, before - 1, '보관된 문서가 활성 목록에 남아 있다')
    const archived = await admin('GET', '/api/wiki?archived=1')
    assert.ok((archived.body.documents ?? []).some((row) => row.id === document.id), `보관함에도 없다: ${JSON.stringify(archived.body)}`)

    // 구해 낼 수 있다 — 꺼낸 뒤 전사로 올린다(닿지 않는 막다른 길이 아니다).
    const current = (await admin('GET', `/api/wiki/${document.id}`)).body.document
    const unarchived = await admin('PATCH', `/api/wiki/${document.id}`, { version: Number(current.version), archived: false })
    assert.equal(unarchived.status, 200, JSON.stringify(unarchived.body))
    const movedOut = await admin('PATCH', `/api/wiki/${document.id}`, { version: Number(unarchived.body.version), projectId: null })
    assert.equal(movedOut.status, 200, JSON.stringify(movedOut.body))
    assert.equal(movedOut.body.document.projectId, null)
  })
})

/** 저장소에 직접 심는 위키 행 한 줄(옛 데이터·복구본을 흉내 낸다). */
const wikiRow = (id, overrides = {}) => ({
  id, tenantId: TENANT, title: '심은 문서', icon: '', summary: '', summarySource: 'auto',
  searchText: '', projectId: null, parentId: null,
  blocks: [{ id: `BLK-${id.slice(-8)}`, type: 'text', text: '', seq: 1 }],
  version: 1, aiLevel: 'indexed', writeScope: 'author', isTemplate: false, archivedAt: null,
  createdById: ADMIN.id, createdByName: ADMIN.name, createdAt: '2026-09-01T00:00:00.000Z',
  lastEditedById: ADMIN.id, lastEditedByName: ADMIN.name, lastEditedAt: '2026-09-01T00:00:00.000Z',
  recentOpIds: [], recentLostOpIds: [], origin: null,
  ...overrides,
})

test('가리키던 프로젝트가 사라진 미아 문서는 관리자에게만 열리고, 걷어낼 수 있다', async () => {
  const store = seedStore()
  store.tenants[TENANT]['wiki-documents'] = {
    data: [wikiRow('WDOC-ORPHANTEST0001', { projectId: 'PRJ-GONE', title: '사라진 프로젝트의 문서', searchText: '미아유일낱말' })],
    updatedAt: '2026-09-01T00:00:00.000Z',
  }
  await withServer(buildApp(store), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const oh = api(origin, await login(origin, OH.email))

    // 관리자에게는 보인다 — **세는 칸과 보이는 칸이 같아야** 상한 문장이 거짓말을 하지 않는다.
    const list = await admin('GET', '/api/wiki')
    assert.ok(
      (list.body.documents ?? []).some((row) => row.id === 'WDOC-ORPHANTEST0001'),
      `관리자 목록에 없다 — 보이지 않는 행이 상한 한 칸을 먹는다: ${JSON.stringify(list.body.documents)}`,
    )
    assert.equal((await admin('GET', '/api/wiki/WDOC-ORPHANTEST0001')).status, 200)
    // 그 밖의 직원에게는 그대로 없는 문서다(프로젝트 문서였다는 사실이 삭제로 뒤집히지 않는다).
    assert.equal((await oh('GET', '/api/wiki/WDOC-ORPHANTEST0001')).status, 404)
    assert.equal(((await oh('GET', '/api/wiki')).body.documents ?? []).some((row) => row.id === 'WDOC-ORPHANTEST0001'), false)

    // 걷어낼 수 있다: 보관 → 완전 삭제. 보관만 해도 30일 뒤 스윕이 스스로 가져간다.
    assert.equal((await admin('DELETE', '/api/wiki/WDOC-ORPHANTEST0001')).status, 200)
    const purged = await admin('DELETE', '/api/wiki/WDOC-ORPHANTEST0001?purge=1')
    assert.equal(purged.status, 200, JSON.stringify(purged.body))
    assert.equal(store.tenants[TENANT]['wiki-documents'].data.some((row) => row.id === 'WDOC-ORPHANTEST0001'), false)
  })
})

test('미아 문서도 보관하면 스윕이 걷어 간다 — 영영 남는 행은 없다', async () => {
  const clock = testClock()
  const store = seedStore()
  store.tenants[TENANT]['wiki-documents'] = {
    data: [wikiRow('WDOC-ORPHANTEST0002', { projectId: 'PRJ-GONE' })],
    updatedAt: '2026-09-01T00:00:00.000Z',
  }
  const app = buildApp(store, { wikiClock: clock.now })
  await withServer(app, async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    assert.equal((await admin('DELETE', '/api/wiki/WDOC-ORPHANTEST0002')).status, 200)
  })
  clock.advance(31 * 24 * 60 * 60 * 1_000)
  const swept = await app.locals.sweepWikiArchive(clock.now())
  assert.equal(swept.removed, 1, '보관한 미아를 스윕이 걷어 가지 않았다')
  assert.equal(store.tenants[TENANT]['wiki-documents'].data.some((row) => row.id === 'WDOC-ORPHANTEST0002'), false)
})

// ── 14. 업무 승격 id는 벽시계에서 나오지 않는다 ─────────────────────────────
test('문단 → 업무 승격을 연달아 눌러도 업무 id가 겹치지 않는다 — 겹치면 업무 저장이 통째로 막힌다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const document = await createDocument(admin, { title: '체크리스트' })
    let current = document
    for (let index = 0; index < 12; index += 1) {
      const sent = await admin('POST', `/api/wiki/${document.id}/ops`, {
        baseVersion: Number(current.version), ops: [insertOp(`할 일 ${index}`, null, 'todo')],
      })
      assert.equal(sent.status, 200, JSON.stringify(sent.body))
      current = sent.body.document
    }
    // 같은 밀리초 안에 잇달아 들어오게 한다(화면에서 12번 연달아 누르는 것과 같다).
    const promoted = await Promise.all(current.blocks
      .filter((block) => block.type === 'todo')
      .map((block) => admin('POST', `/api/wiki/${document.id}/blocks/${block.id}/task`, { title: `업무 ${block.id}` })))
    const ids = promoted.filter((result) => result.status === 201).map((result) => result.body.workItem.id)
    assert.equal(ids.length, 12, JSON.stringify(promoted.map((result) => [result.status, result.body?.error?.code])))
    assert.equal(new Set(ids).size, ids.length, `업무 id가 겹쳤다 — 그 순간부터 업무 저장이 400이 된다: ${JSON.stringify(ids)}`)

    // 겹치지 않았음을 사람이 겪는 자리에서 한 번 더 확인한다: 읽은 그대로 되쓴다.
    const readBack = await admin('GET', '/api/workspace/work-items')
    assert.equal(readBack.status, 200, JSON.stringify(readBack.body))
    const written = await admin('PUT', '/api/workspace/work-items', { data: readBack.body.data, version: readBack.body.version })
    assert.equal(written.status, 200, `읽은 그대로 되쓰는 것조차 막혔다: ${JSON.stringify(written.body)}`)
  })
})

// ── 15. 내보내기는 자료 내려받기와 같은 방어를 두른다 ───────────────────────
test('문서 내보내기는 첨부로 내려가고 스니핑을 막는다 — 자료 내려받기와 같은 두 줄', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const document = await createDocument(admin, { title: '내보내기 시험' })
    const exported = await admin('GET', `/api/wiki/${document.id}/export`)
    assert.equal(exported.status, 200)
    assert.equal(exported.response.headers.get('x-content-type-options'), 'nosniff')
    const disposition = exported.response.headers.get('content-disposition') ?? ''
    assert.match(disposition, /^attachment; filename\*=UTF-8''/u, `사용자 본문이 인라인으로 나간다: ${disposition}`)
    assert.match(disposition, /\.md$/u, `파일 이름이 화면의 말과 다르다: ${disposition}`)
  })
})

// ── 16. 전역 검색의 스캔 상한은 '내가 볼 수 있는' 문서에 걸린다 ──────────────
test('내가 못 보는 문서가 아무리 최근이어도 내 문서는 전역 검색에서 사라지지 않는다', async () => {
  const store = seedStore()
  // 못 보는 프로젝트 문서로 스캔 상한(300)을 통째로 채운다. 전부 나보다 최근이다.
  store.tenants[TENANT]['wiki-documents'] = {
    data: Array.from({ length: 300 }, (_, index) => wikiRow(`WDOC-HIDE${String(index).padStart(6, '0')}`, {
      title: `멤버 전용 ${index}`, projectId: 'PRJ-B', searchText: '멤버들만보는말',
      lastEditedAt: '2026-12-31T00:00:00.000Z',
    })),
    updatedAt: '2026-09-01T00:00:00.000Z',
  }
  await withServer(buildApp(store), async (origin) => {
    const oh = api(origin, await login(origin, OH.email))     // PRJ-B 비멤버
    const mine = await createDocument(oh, { title: '오태식 개인 메모' })
    const written = await oh('POST', `/api/wiki/${mine.id}/ops`, { baseVersion: 1, ops: [insertOp('내가찾을유일낱말 회의 정리')] })
    assert.equal(written.status, 200, JSON.stringify(written.body))

    // 정문(문서 목록)에서 걸리는 질의가 전역 검색에서도 걸려야 한다 — 두 문이 다른 답을 하면 안 된다.
    const inList = await oh('GET', `/api/wiki?q=${encodeURIComponent('내가찾을유일낱말')}`)
    assert.deepEqual((inList.body.documents ?? []).map((row) => row.id), [mine.id], JSON.stringify(inList.body).slice(0, 300))
    const found = await oh('GET', `/api/search?q=${encodeURIComponent('내가찾을유일낱말')}`)
    const hits = (found.body?.groups ?? []).find((group) => group.kind === 'wiki')?.items ?? []
    assert.deepEqual(
      hits.map((item) => item.id), [mine.id],
      `스캔 상한이 권한 필터보다 앞에 있으면 내 문서가 통째로 사라진다: ${JSON.stringify(found.body).slice(0, 300)}`,
    )
  })
})

test('프로젝트 삭제가 커밋에 실패하면 프로젝트도 문서 보관도 함께 되돌아간다 — 한 커밋, 한 롤백', async () => {
  const gate = gatedCommit()
  const store = seedStore()
  await withServer(buildApp(store, { onWorkspaceStoreChange: gate.onChange }), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const document = await createDocument(admin, { title: '되돌아갈 문서', projectId: 'PRJ-B' })

    gate.arm()
    const pending = admin('DELETE', '/api/projects/PRJ-B')
    await new Promise((resolve) => { setTimeout(resolve, 30) })
    gate.release()
    const failed = await pending
    assert.equal(failed.status, 500, JSON.stringify(failed.body))
    assert.equal(failed.body.error.code, 'PROJECT_WRITE_FAILED')

    // 프로젝트도 그대로, 문서도 보관되지 않은 그대로다. 한쪽만 남으면 상태가 갈라진다.
    assert.ok(store.tenants[TENANT]['project-spaces'].data.some((row) => row.id === 'PRJ-B'), '프로젝트가 되돌아오지 않았다')
    const row = store.tenants[TENANT]['wiki-documents'].data.find((entry) => entry.id === document.id)
    assert.equal(row.archivedAt ?? null, null, '커밋에 실패했는데 문서만 보관됐다')
    assert.equal(Number(row.version), Number(document.version), '커밋에 실패했는데 버전이 올랐다')
    assert.equal((await admin('GET', `/api/wiki/${document.id}`)).status, 200, '문서가 여전히 살아 있어야 한다')
  })
})

// ── 17. H3 3회차 검증에서 잡힌 것 ───────────────────────────────────────────
/**
 * 파일 하나를 올린다. 자료 라우트는 쿼리로 이름·공개 범위를 받고 본문은 옥텟 스트림이다.
 * 부서 공개(department)는 올린 사람의 부서 하나로 스탬프된다(app.mjs `visibility === 'department'`).
 */
const uploadDocument = async (origin, session, name, visibility) => {
  const response = await fetch(`${origin}/api/documents?${new URLSearchParams({ name, category: '프로젝트', visibility, tags: '' })}`, {
    method: 'POST',
    headers: {
      cookie: session.headers.cookie,
      'content-type': 'application/octet-stream',
      'x-file-type': 'text/plain',
      'x-file-name': encodeURIComponent(name),
    },
    body: Buffer.from('wiki attachment body'),
  })
  const body = await readJson(response)
  assert.equal(response.status, 201, JSON.stringify(body))
  return body.document
}

const fileBlock = (attachmentId, text) => ({
  opId: opId(), kind: 'insert', after: null, block: { id: blockId(), type: 'file', attachmentId, text },
})

test('첨부 열람 확대 명단은 그 문서를 읽을 수 있는 사람까지다 — 게스트에게 열리지 않고, 부서 파일의 부서를 끊지 않는다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const adminSession = await login(origin, ADMIN.email)
    const parkSession = await login(origin, PARK.email)
    const admin = api(origin, adminSession)
    const park = api(origin, parkSession)
    const lee = api(origin, await login(origin, LEE.email))
    const guest = api(origin, await login(origin, GUEST.email, GUEST.password))

    const department = await uploadDocument(origin, parkSession, '품질감사보고.txt', 'department')
    assert.equal(department.visibility, 'department', '부서 공개로 올라가지 않으면 이 시험의 전제가 틀렸다')
    const restricted = await uploadDocument(origin, adminSession, '설계도.txt', 'restricted')

    // 첨부 전: 부서 사람은 보고, 게스트는 못 본다.
    assert.equal((await lee('GET', `/api/documents/${department.id}/download`)).status, 200)
    assert.equal((await guest('GET', `/api/documents/${department.id}/download`)).status, 404)

    const document = await createDocument(admin, { title: '첨부가 붙는 문서', projectId: 'PRJ-A' })
    const first = await park('POST', `/api/wiki/${document.id}/ops`, { baseVersion: 1, ops: [fileBlock(department.id, '감사 보고')] })
    assert.equal(first.status, 200, JSON.stringify(first.body))
    const second = await admin('POST', `/api/wiki/${document.id}/ops`, { baseVersion: first.body.version, ops: [fileBlock(restricted.id, '설계도')] })
    assert.equal(second.status, 200, JSON.stringify(second.body))

    // 1) 부서 파일은 부서 범위 그대로다. 확대가 restricted로 뒤집으면 같은 부서가 끊긴다.
    assert.equal(
      (await lee('GET', `/api/documents/${department.id}/download`)).status, 200,
      '문서에 붙였다는 이유로 같은 부서 사람이 그 파일을 잃었다',
    )
    // 2) 그 문서를 어떤 문으로도 읽지 못하는 외부 게스트에게는 그 문서의 파일도 열리지 않는다.
    const guestDocument = await guest('GET', `/api/wiki/${document.id}`)
    assert.equal(guestDocument.status, 403, '이 절에서 게스트에게 문서를 열지 않는다(§7-6)')
    assert.equal((await guest('GET', `/api/documents/${department.id}/download`)).status, 404, '게스트가 회사 부서 파일을 받아 갔다')
    assert.equal((await guest('GET', `/api/documents/${restricted.id}/download`)).status, 404, '게스트가 못 읽는 문서의 첨부를 받아 갔다')
    const guestFiles = await guest('GET', '/api/documents')
    assert.deepEqual(
      (guestFiles.body.documents ?? []).map((row) => row.name), [],
      `게스트 자료 목록에 회사 파일이 실렸다: ${JSON.stringify(guestFiles.body).slice(0, 300)}`,
    )
    // 3) 기능 자체는 살아 있다 — 프로젝트 구성원(직원)에게는 restricted 첨부가 열린다.
    assert.equal((await park('GET', `/api/documents/${restricted.id}/download`)).status, 200, '프로젝트 구성원에게는 열려야 한다')
  })
})

test('문단에서 만든 업무는 배열 저장 문과 같은 문장으로 답한다 — 외부 게스트 담당·동명이인', async () => {
  const store = seedStore()
  // 같은 이름의 계정을 하나 더 심는다. '모호하면 고르지 않는다'가 두 문에서 같은 답을 내는지 잰다.
  store.invitedAccounts.push({
    id: 'USR-SUNSEA-PARK2', email: 'jihyun.park.2@sunsea.co.kr', name: PARK.name, tenantId: TENANT, tenantName: '햇살바다',
    team: '품질관리', jobRole: '품질 담당', requested: '초대 계정', role: 'tenant-member',
  })
  store.accountApprovals['USR-SUNSEA-PARK2'] = 'approved'
  await withServer(buildApp(store), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const document = await createDocument(admin, { title: '승격 규칙', projectId: 'PRJ-A' })
    const added = await admin('POST', `/api/wiki/${document.id}/ops`, {
      baseVersion: 1, ops: [insertOp('게스트에게', null, 'todo'), insertOp('동명이인에게', null, 'todo')],
    })
    assert.equal(added.status, 200, JSON.stringify(added.body))
    const toGuest = added.body.document.blocks.find((block) => block.text === '게스트에게')
    const toTwin = added.body.document.blocks.find((block) => block.text === '동명이인에게')

    // 1) 게스트 담당 — 정문(PUT /api/workspace/work-items)이 내는 코드·문장 그대로.
    const guestOwner = await admin('POST', `/api/wiki/${document.id}/blocks/${toGuest.id}/task`, { owner: GUEST.name })
    assert.equal(guestOwner.status, 400, JSON.stringify(guestOwner.body))
    assert.equal(guestOwner.body.error.code, 'GUEST_PROJECT_REQUIRED')
    assert.equal(guestOwner.body.error.message, '외부 게스트에게 배정하는 업무는 그 게스트가 초대된 프로젝트에 귀속돼야 합니다.')

    const items = await admin('GET', '/api/workspace/work-items')
    assert.equal((items.body.data ?? []).some((row) => row.ownerId === GUEST.id), false, '정문이 거절하는 행을 이 문이 만들었다')
    // 그런 행이 하나라도 있으면 업무 화면은 **읽은 그대로 되쓰기**조차 못 한다.
    const rewrite = await admin('PUT', '/api/workspace/work-items', { data: items.body.data })
    assert.equal(rewrite.status, 200, `읽은 그대로 되쓰기가 막혔다: ${JSON.stringify(rewrite.body)}`)

    // 2) 동명이인 — 승인 큐(uniqueTenantAccountByName)와 같은 규칙. 모호하면 고르지 않고 요청자에게 떨어진다.
    const twin = await admin('POST', `/api/wiki/${document.id}/blocks/${toTwin.id}/task`, { owner: PARK.name })
    assert.equal(twin.status, 201, JSON.stringify(twin.body))
    assert.equal(twin.body.workItem.ownerId, ADMIN.id, '모호한 이름을 조용히 첫 계정에 배정했다')
    assert.equal(twin.body.workItem.owner, ADMIN.name)
  })
})

test('승인 큐가 만드는 업무도 배열 저장 문과 같은 게스트 규칙을 지난다', async () => {
  const store = seedStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const member = api(origin, await login(origin, PARK.email))
    const document = await createDocument(admin, { title: '직원 승격', projectId: 'PRJ-A' })
    const added = await member('POST', `/api/wiki/${document.id}/ops`, { baseVersion: 1, ops: [insertOp('게스트에게 맡길 일', null, 'todo')] })
    const todo = added.body.document.blocks.find((block) => block.type === 'todo')

    const queued = await member('POST', `/api/wiki/${document.id}/blocks/${todo.id}/task`, { owner: GUEST.name })
    assert.equal(queued.status, 400, JSON.stringify(queued.body))
    assert.equal(queued.body.error.code, 'GUEST_PROJECT_REQUIRED', '제안 단계에서 이미 정문과 같은 답을 해야 한다')

    // 제안을 억지로 심어 승인까지 가더라도 업무 배열에는 들어가지 않는다.
    const proposals = await admin('GET', '/api/proposals')
    assert.equal((proposals.body.proposals ?? []).some((row) => row.kind === 'wiki-task'), false, '거절한 요청이 제안으로 남았다')

    const okQueued = await member('POST', `/api/wiki/${document.id}/blocks/${todo.id}/task`, {})
    assert.equal(okQueued.status, 201, JSON.stringify(okQueued.body))
    const pending = await admin('GET', '/api/proposals')
    const proposal = (pending.body.proposals ?? []).find((row) => row.kind === 'wiki-task')
    assert.ok(proposal, '정상 제안은 그대로 큐로 간다')
    const decided = await admin('POST', `/api/proposals/${proposal.id}/decide`, {
      decision: 'edit', payload: { ...proposal.payload, owner: GUEST.name },
    })
    assert.equal(decided.status, 400, JSON.stringify(decided.body))
    assert.equal(decided.body.error.code, 'GUEST_PROJECT_REQUIRED')
    const items = await admin('GET', '/api/workspace/work-items')
    assert.equal((items.body.data ?? []).some((row) => row.ownerId === GUEST.id), false)
  })
})

test('내 템플릿으로 저장은 PATCH·ops와 같은 문에서 답한다 — 보관 상태와 프로젝트 역할', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const oh = api(origin, await login(origin, OH.email))

    // 1) 보관된 문서: PATCH가 409면 이 문도 409다. 같은 문서 상태에 두 문이 다른 답을 하면 안 된다.
    const archived = await createDocument(admin, { title: '보관될 문서' })
    assert.equal((await admin('DELETE', `/api/wiki/${archived.id}`)).status, 200)
    const patched = await admin('PATCH', `/api/wiki/${archived.id}`, { version: 1, title: '보관 뒤 제목' })
    assert.equal(patched.status, 409)
    assert.equal(patched.body.error.code, 'WIKI_ARCHIVED')
    const fromArchived = await admin('POST', `/api/wiki/${archived.id}/save-as-template`, { name: '보관 템플릿' })
    assert.equal(fromArchived.status, 409, JSON.stringify(fromArchived.body))
    assert.equal(fromArchived.body.error.code, 'WIKI_ARCHIVED')

    // 2) 프로젝트 뷰어: 그 문서를 고칠 수도, 그 프로젝트에 문서를 만들 수도 없다.
    const mine = await createDocument(oh, { title: '오태식 문서' })
    const moved = await admin('PATCH', `/api/wiki/${mine.id}`, { version: 1, projectId: 'PRJ-A' })
    assert.equal(moved.status, 200, JSON.stringify(moved.body))
    const direct = await oh('POST', '/api/wiki', { title: '뷰어 문서', projectId: 'PRJ-A' })
    assert.equal(direct.status, 403)
    assert.equal(direct.body.error.code, 'WIKI_PROJECT_FORBIDDEN')
    const viaTemplate = await oh('POST', `/api/wiki/${mine.id}/save-as-template`, { name: '뷰어 템플릿' })
    assert.equal(viaTemplate.status, 403, JSON.stringify(viaTemplate.body))
    assert.equal(viaTemplate.body.error.code, 'WIKI_FORBIDDEN')

    // 3) 작성자이면서 고칠 수 있는 사람에게는 그대로 열려 있다.
    const own = await createDocument(oh, { title: '전사 메모' })
    const saved = await oh('POST', `/api/wiki/${own.id}/save-as-template`, { name: '내 서식' })
    assert.equal(saved.status, 201, JSON.stringify(saved.body))
  })
})

test('이력 목록은 한 쪽에서 끊기고 그 뒤로 가는 문이 열려 있다 — 화면이 닿을 수 없는 버전을 남기지 않는다', async () => {
  await withServer(buildApp(seedStore()), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const document = await createDocument(admin, { title: '오래 고친 문서' })
    const target = document.blocks[0].id
    let version = Number(document.version)
    for (let step = 0; step < 60; step += 1) {
      const wrote = await admin('POST', `/api/wiki/${document.id}/ops`, {
        baseVersion: version, ops: [updateOp(target, step, { text: `${step}번째 고침` })],
      })
      assert.equal(wrote.status, 200, JSON.stringify(wrote.body))
      version = Number(wrote.body.version)
    }

    // 화면이 인자 없이 부르는 그대로 — 한 쪽만 온다.
    const first = await admin('GET', `/api/wiki/${document.id}/revisions`)
    assert.equal(first.status, 200, JSON.stringify(first.body))
    const firstPage = first.body.revisions.map((row) => Number(row.version))
    assert.ok(firstPage.length < version, '이 시험의 전제: 한 쪽에 다 담기지 않는다')
    const oldestShown = Math.min(...firstPage)
    assert.ok(
      oldestShown > Number(first.body.oldestVersion),
      '보관돼 있는데 첫 쪽에 없는 버전이 있어야 이 시험이 뜻을 가진다',
    )

    // 서랍의 '더 보기'가 부르는 그대로.
    const next = await admin('GET', `/api/wiki/${document.id}/revisions?before=${oldestShown}`)
    assert.equal(next.status, 200, JSON.stringify(next.body))
    const nextPage = next.body.revisions.map((row) => Number(row.version))
    assert.ok(nextPage.length > 0, '다음 쪽으로 가는 문이 닫혀 있다 — 그 버전들은 화면에서 닿을 수 없다')
    // 서랍의 버튼은 '더 보기 (버전 N-1부터)'라고 말한다 — 그 문장이 참인지 여기서 잰다.
    assert.equal(Math.max(...nextPage), oldestShown - 1, '다음 쪽이 바로 앞 버전에서 시작하지 않는다')
    const all = [...firstPage, ...nextPage]
    assert.equal(new Set(all).size, all.length, '두 쪽에 같은 버전이 겹쳤다')
    assert.equal(Math.min(...all), Number(first.body.oldestVersion), '두 쪽을 이어도 가장 오래된 버전에 닿지 못한다')
    // 목록의 끝을 말하는 데 쓰는 값이 그대로 온다(화면이 지어내지 않는다).
    assert.deepEqual(next.body.retention, { maxRevisions: 200, budgetChars: 2_000_000 })
    // 목록에서 닿을 수만 있으면 그 버전은 상세도 복원도 살아 있다.
    assert.equal((await admin('GET', `/api/wiki/${document.id}/revisions/${first.body.oldestVersion}`)).status, 200)
  })
})

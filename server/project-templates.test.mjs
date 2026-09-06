import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import test from 'node:test'

import { createApp } from './app.mjs'
import {
  assertNoAccountReference, hasProjectTemplateShape, systemTemplatesFor, validateTemplateInput,
} from './project-templates.mjs'
import { withServer } from './test-server.mjs'

/**
 * 프로젝트 템플릿 — 판정 2("템플릿으로 프로젝트를 만들면 업무·하위 업무·채널·폴더가 생기고 역할이 사람에게 매핑된다").
 *
 * 이 시험이 붙잡는 두 가지: ⑴ 템플릿 본문에는 사람이 없다(역할 문자열만), ⑵ 실체화는 네 키를
 * 한 번에 저장하거나 아무것도 저장하지 않는다.
 */

const TENANT = 'TENANT-SUNSEA'
const IT_TENANT = 'TENANT-3DMUSE'
const ADMIN = { id: 'USR-SUNSEA-ADMIN', name: '김서원', email: 'admin@sunsea.co.kr' }
const PARK = { id: 'USR-SUNSEA-PARK', name: '박지현', email: 'jihyun.park@sunsea.co.kr' }
const OH = { id: 'USR-SUNSEA-OH', name: '오태식', email: 'taesik.oh@sunsea.co.kr' }
const SEO = { id: 'USR-SUNSEA-SEO', name: '서동현', email: 'donghyun.seo@sunsea.co.kr' }
const IT_ADMIN = { email: 'admin@3dmuse.demo' }
const GUEST = { id: 'USR-TENANT-SUNSEA-GUEST01', name: '홍거래', email: 'guest@partner.example', password: 'Guest!Pass2026' }
const GRANT_ID = 'GST-TENANT-SUNSEA-000001'
const PRIORITIES = new Set(['긴급', '높음', '보통'])
const FOOD_TEMPLATE = 'PT-SYS-FOOD-NEW-PRODUCT'
const IT_TEMPLATE = 'PT-SYS-IT-OUTSOURCED-DEV'

const freshStore = () => ({
  version: 2,
  tenants: { [TENANT]: {}, 'TENANT-POHANG': {}, [IT_TENANT]: {} },
  platform: {}, accountApprovals: {}, accountCredentials: {}, invitedAccounts: [], passwordResetRequests: [], guestGrants: [],
})
const readJson = async (response) => { const text = await response.text(); try { return JSON.parse(text) } catch { return { raw: text } } }
const buildApp = (store, extra = {}) => createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {}, ...extra })

async function login(origin, email, password = 'demo1234', workspace = 'tenant') {
  const response = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace, email, password }) })
  const body = await readJson(response)
  const cookie = response.headers.get('set-cookie') ?? ''
  const account = body.account ?? null
  return {
    account,
    headers: { 'content-type': 'application/json', cookie, ...(account?.tenantId ? { 'x-workspace-identity': `${account.tenantId}:${account.id}` } : {}) },
  }
}
const api = (origin, session) => async (method, route, body) => {
  const response = await fetch(`${origin}${route}`, { method, headers: session.headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return { status: response.status, body: await readJson(response) }
}

// 템플릿 본문에 사람이 남아 있지 않다는 것을 한 문장으로 확인한다. '@'까지 금지해 이메일 조각도 잡는다.
const NAME_LEAK = /USR-[A-Z0-9-]+|김서원|박지현|오태식|서동현|윤서진|이정민|한예린|김뮤즈|햇살바다|demo1234|@/
const assertNoNames = (payload, where = 'template') => {
  assert.doesNotMatch(JSON.stringify(payload), NAME_LEAK, `${where}: 템플릿 본문에 사람이 남았다`)
}

const TENANT_ACCOUNTS = [
  { id: PARK.id, name: PARK.name, email: PARK.email },
  { id: OH.id, name: OH.name, email: OH.email },
]
const validate = (body, options = {}) => validateTemplateInput(body, { priorities: PRIORITIES, ...options })
const baseBody = (overrides = {}) => ({
  name: '표준 진행',
  description: '설명',
  roles: ['PM', '개발'],
  tasks: [{
    key: 'a', title: '요구 정리', role: 'PM', dueOffsetDays: 7, priority: '높음', category: '프로젝트',
    children: [{ key: 'a1', title: '인터뷰 정리', role: '개발', dueOffsetDays: 3 }],
  }],
  channels: [{ name: '진행 공유' }],
  documentCategories: ['프로젝트', '프로젝트'],
  rules: [],
  ...overrides,
})
const taskOf = (overrides = {}) => ({ key: 'a', title: '요구 정리', role: 'PM', dueOffsetDays: 7, priority: '높음', category: '프로젝트', children: [], ...overrides })
const ruleOf = (overrides = {}) => ({
  key: 'r1', title: '주간 보고', description: '이번 주 진행을 정리한다.', role: 'PM',
  frequency: 'weekly', interval: 1, weekday: 5, dueTime: '17:00', priority: '보통', category: '프로젝트', ...overrides,
})

const workItem = (overrides) => ({
  id: 'WK-1', title: '업무', description: '', owner: PARK.name, ownerId: PARK.id, requestedBy: ADMIN.name, requesterId: ADMIN.id,
  due: '2026-09-08T09:00:00.000Z', priority: '보통', status: '업무요청', category: '품질', createdAt: '2026-09-01T00:00:00.000Z', ...overrides,
})

// ─────────────────────────── 1) 순수 검증 ───────────────────────────

test('템플릿 본문 검증: 형식 오류는 코드와 path를 함께 돌려준다', () => {
  assert.equal(validate(baseBody({ name: '가' })).error.code, 'TEMPLATE_INVALID')
  const duplicateRole = validate(baseBody({ roles: ['PM', 'PM'] })).error
  assert.equal(duplicateRole.code, 'TEMPLATE_INVALID')
  assert.equal(duplicateRole.path, 'roles')

  const unknownRole = validate(baseBody({ tasks: [taskOf({ role: 'QA' })] })).error
  assert.equal(unknownRole.code, 'TEMPLATE_TASK_ROLE_UNKNOWN')
  assert.equal(unknownRole.path, 'tasks[0].role')

  const duplicateKey = validate(baseBody({ tasks: [taskOf({ children: [{ key: 'a', title: '인터뷰 정리', role: '개발', dueOffsetDays: 3 }] })] })).error
  assert.equal(duplicateKey.code, 'TEMPLATE_KEY_DUPLICATE')

  assert.equal(validate(baseBody({ tasks: [taskOf({ key: '한글키' })] })).error.code, 'TEMPLATE_KEY_INVALID')

  const lateChild = validate(baseBody({ tasks: [taskOf({ dueOffsetDays: 7, children: [{ key: 'a1', title: '인터뷰 정리', role: '개발', dueOffsetDays: 8 }] })] })).error
  assert.equal(lateChild.code, 'TEMPLATE_CHILD_DUE_AFTER_PARENT')

  const manyChildren = Array.from({ length: 21 }, (_item, index) => ({ key: `c${index}`, title: '자식 업무', role: '개발', dueOffsetDays: 3 }))
  assert.equal(validate(baseBody({ tasks: [taskOf({ children: manyChildren })] })).error.code, 'TEMPLATE_CHILDREN_LIMIT')

  const manyTasks = Array.from({ length: 101 }, (_item, index) => taskOf({ key: `k${index}` }))
  assert.equal(validate(baseBody({ tasks: manyTasks })).error.code, 'TEMPLATE_INVALID')

  assert.equal(validate(baseBody({ rules: [ruleOf({ interval: 13 })] })).error.path, 'rules[0].interval')
  assert.equal(validate(baseBody({ rules: [ruleOf({ description: '' })] })).error.path, 'rules[0].description')

  // 정상 입력: 공백은 저장 시점에 한 번 다듬고, 같은 자료 분류는 조용히 합친다.
  const ok = validate(baseBody({ name: '  표준 진행  ' }))
  assert.equal(ok.error, undefined)
  assert.equal(ok.template.name, '표준 진행')
  assert.deepEqual(ok.template.documentCategories, ['프로젝트'])
  assert.equal(ok.template.tasks[0].children[0].priority, '높음', '자식은 상위의 중요도를 물려받는다')
  assert.equal(ok.template.tasks[0].children[0].category, '프로젝트')
})

test('템플릿 본문에 사람이 들어가면 저장 전에 거절하고 어디인지 알려 준다', () => {
  const withPersonRole = validate(baseBody({ roles: [PARK.name, '개발'], tasks: [taskOf({ role: PARK.name })] }))
  assert.equal(withPersonRole.error, undefined)
  const roleHit = assertNoAccountReference(withPersonRole.template, TENANT_ACCOUNTS)
  assert.equal(roleHit.code, 'TEMPLATE_CONTAINS_PERSON')
  assert.equal(roleHit.path, 'roles[0]')

  const withEmail = validate(baseBody({ tasks: [taskOf({ title: `메일 ${PARK.email} 로 회신` })] }))
  const emailHit = assertNoAccountReference(withEmail.template, TENANT_ACCOUNTS)
  assert.equal(emailHit.code, 'TEMPLATE_CONTAINS_PERSON')
  assert.equal(emailHit.path, 'tasks[0].title')

  // history의 byId/byName은 "누가 고쳤는가"라 예외다.
  const clean = validate(baseBody()).template
  clean.history = [{ version: 1, at: '2026-09-01T00:00:00.000Z', byId: PARK.id, byName: PARK.name, summary: '만들기' }]
  assert.equal(assertNoAccountReference(clean, TENANT_ACCOUNTS), null)
})

// ─────────────────────────── 2) 업종 기본 템플릿 ───────────────────────────

test('업종 기본 템플릿은 역할과 상대 마감일만 담고, 모르는 업종은 식품제조로 본다', () => {
  const it = systemTemplatesFor('it_services')
  assert.equal(it.length, 1)
  assert.equal(it[0].id, IT_TEMPLATE)
  assert.equal(it[0].tasks.length, 5)
  assert.equal(it[0].tasks.reduce((sum, task) => sum + task.children.length, 0), 12)
  assert.deepEqual(it[0].roles, ['PM', '디자이너', '개발'])

  const food = systemTemplatesFor('food_manufacturing')
  assert.equal(food[0].id, FOOD_TEMPLATE)
  assert.equal(food[0].tasks.length, 5)
  assert.equal(food[0].tasks.reduce((sum, task) => sum + task.children.length, 0), 13)
  assert.deepEqual(food[0].roles, ['PM', '품질', '생산'])

  for (const template of [it[0], food[0]]) {
    assert.ok(hasProjectTemplateShape(template, { priorities: PRIORITIES }), `${template.id} 규격`)
    for (const task of template.tasks) {
      assert.ok(template.roles.includes(task.role))
      for (const child of task.children) {
        assert.ok(template.roles.includes(child.role))
        assert.ok(child.dueOffsetDays <= task.dueOffsetDays, `${child.key} 마감은 상위보다 늦을 수 없다`)
      }
    }
    for (const rule of template.rules) {
      assert.ok(template.roles.includes(rule.role))
      assert.ok(rule.description.length >= 2)
    }
    assertNoNames(template, template.id)
  }

  assert.equal(systemTemplatesFor('unknown-industry')[0].id, FOOD_TEMPLATE)
})

// ─────────────────────────── 3) 시드·권한 ───────────────────────────

test('기본 템플릿은 목록을 열 때 한 번만 생기고, 업종별로 다르며, generic 저장소는 닫혀 있다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const member = api(origin, await login(origin, PARK.email))

    const first = await admin('GET', '/api/project-templates')
    assert.equal(first.status, 200)
    assert.equal(first.body.templates.length, 1)
    assert.equal(first.body.templates[0].id, FOOD_TEMPLATE)
    assert.equal(first.body.templates[0].origin, 'system')
    assert.equal(first.body.industryType, 'food_manufacturing')
    assert.equal('history' in first.body.templates[0], false, '목록 요약에는 이력을 싣지 않는다')
    assert.equal(first.body.templates[0].taskCount, 5)
    assert.equal(first.body.templates[0].childCount, 13)

    const second = await admin('GET', '/api/project-templates')
    assert.equal(second.body.templates.length, 1)
    assert.equal(store.tenants[TENANT]['project-templates'].data.length, 1, '두 번째 조회가 같은 템플릿을 또 만들지 않는다')

    const itAdmin = api(origin, await login(origin, IT_ADMIN.email))
    const itList = await itAdmin('GET', '/api/project-templates')
    assert.deepEqual(itList.body.templates.map((item) => item.id), [IT_TEMPLATE])
    assert.equal(store.tenants[TENANT]['project-templates'].data.length, 1, 'IT 테넌트 시드가 다른 회사 스토어에 새지 않는다')

    // 구성원은 읽을 수 있다 — 어떤 틀로 일하는지는 회사 안에서 공유되는 정보다.
    assert.equal((await member('GET', '/api/project-templates')).status, 200)
    const detail = await member('GET', `/api/project-templates/${FOOD_TEMPLATE}`)
    assert.equal(detail.status, 200)
    assert.equal(detail.body.template.history.length, 1)
    assert.equal((await member('GET', '/api/project-templates/PT-NONE')).status, 404)

    // generic 저장소는 양쪽 다 닫혀 있다.
    assert.equal((await admin('GET', '/api/workspace/project-templates')).body.error.code, 'PROJECT_TEMPLATE_ROUTE_REQUIRED')
    assert.equal((await admin('PUT', '/api/workspace/project-templates', { data: [] })).body.error.code, 'PROJECT_TEMPLATE_ROUTE_REQUIRED')
    const memberWrite = await member('PUT', '/api/workspace/project-templates', { data: [] })
    assert.equal(memberWrite.status, 403)
    assert.equal(memberWrite.body.error.code, 'STORE_WRITE_FORBIDDEN')

    // 쓰기·실체화는 관리자만.
    for (const [method, route, body] of [
      ['POST', '/api/project-templates', baseBody()],
      ['POST', `/api/project-templates/${FOOD_TEMPLATE}/instantiate`, { name: '테스트' }],
      ['POST', '/api/projects/PRJ-X/save-as-template', {}],
      ['GET', '/api/projects/PRJ-X/template-draft', undefined],
    ]) {
      const result = await member(method, route, body)
      assert.equal(result.status, 403, `${method} ${route}`)
      assert.equal(result.body.error.code, 'TENANT_ADMIN_REQUIRED')
    }
  })
})

test('업종을 바꾸면 새 업종 팩이 더해지고 기존 템플릿은 남는다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    assert.equal((await admin('GET', '/api/project-templates')).body.templates.length, 1)

    const operator = api(origin, await login(origin, 'operator@onfactory.co.kr', 'demo1234', 'platform'))
    const patched = await operator('PATCH', `/api/platform/tenants/${TENANT}`, { industryType: 'it_services' })
    assert.equal(patched.status, 200, JSON.stringify(patched.body))

    const after = await admin('GET', '/api/project-templates')
    assert.equal(after.body.templates.length, 2)
    assert.deepEqual([...after.body.templates.map((item) => item.id)].sort(), [FOOD_TEMPLATE, IT_TEMPLATE].sort())
  })
})

// ─────────────────────────── 5) CRUD·이력 ───────────────────────────

test('사용자 템플릿은 만들고 고치고 복사하고 지울 수 있고, 기본 템플릿은 복사만 된다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    await admin('GET', '/api/project-templates')

    const created = await admin('POST', '/api/project-templates', baseBody())
    assert.equal(created.status, 201, JSON.stringify(created.body))
    assert.equal(created.body.template.version, 1)
    assert.equal(created.body.template.history.length, 1)
    assert.equal(created.body.template.history[0].summary, '템플릿 만들기')
    assert.equal(created.body.template.history[0].byName, ADMIN.name)
    const id = created.body.template.id

    const renamed = await admin('PATCH', `/api/project-templates/${id}`, { name: '표준 진행 v2', version: 1, summary: '이름 변경' })
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body))
    assert.equal(renamed.body.template.version, 2)
    assert.equal(renamed.body.template.history[0].summary, '이름 변경')
    assert.equal(renamed.body.template.history[0].byName, ADMIN.name)

    const stale = await admin('PATCH', `/api/project-templates/${id}`, { name: '되돌리기', version: 1 })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.error.code, 'TEMPLATE_VERSION_CONFLICT')
    assert.equal(stale.body.error.currentVersion, 2)

    // 역할을 지우면 그 역할을 쓰던 업무가 갈 곳을 잃는다 — 저장 전에 막는다.
    const orphanRole = await admin('PATCH', `/api/project-templates/${id}`, { roles: ['개발'], version: 2 })
    assert.equal(orphanRole.status, 400)
    assert.equal(orphanRole.body.error.code, 'TEMPLATE_TASK_ROLE_UNKNOWN')

    // 사람 이름은 PATCH로도 들어오지 못한다.
    const person = await admin('PATCH', `/api/project-templates/${id}`, { roles: [PARK.name, '개발'], tasks: [taskOf({ role: PARK.name })], version: 2 })
    assert.equal(person.body.error.code, 'TEMPLATE_CONTAINS_PERSON')

    // 같은 key 두 개는 실체화까지 오지 않는다.
    const duplicateKey = await admin('PATCH', `/api/project-templates/${id}`, { tasks: [taskOf({ key: 'a' }), taskOf({ key: 'a', title: '또 다른 업무' })], version: 2 })
    assert.equal(duplicateKey.body.error.code, 'TEMPLATE_KEY_DUPLICATE')

    let version = 2
    for (let round = 0; round < 51; round += 1) {
      const step = await admin('PATCH', `/api/project-templates/${id}`, { description: `수정 ${round}`, version })
      assert.equal(step.status, 200, JSON.stringify(step.body))
      version = step.body.template.version
    }
    const capped = await admin('GET', `/api/project-templates/${id}`)
    assert.equal(capped.body.template.history.length, 50, '이력은 50건까지만 남는다')

    for (const method of ['PATCH', 'DELETE']) {
      const blocked = await admin(method, `/api/project-templates/${FOOD_TEMPLATE}`, method === 'PATCH' ? { name: '고치기', version: 1 } : undefined)
      assert.equal(blocked.status, 409)
      assert.equal(blocked.body.error.code, 'TEMPLATE_SYSTEM_READONLY')
    }

    const copy = await admin('POST', `/api/project-templates/${FOOD_TEMPLATE}/duplicate`)
    assert.equal(copy.status, 201, JSON.stringify(copy.body))
    assert.equal(copy.body.template.origin, 'custom')
    assert.equal(copy.body.template.sourceTemplateId, FOOD_TEMPLATE)
    assert.equal(copy.body.template.name, '신제품 출시 (복사)')
    assert.equal(copy.body.template.version, 1)
    assert.equal(copy.body.template.history.length, 1)

    assert.equal((await admin('DELETE', `/api/project-templates/${id}`)).status, 200)
    const remaining = await admin('GET', '/api/project-templates')
    assert.equal(remaining.body.templates.some((item) => item.id === id), false)
    assert.equal(remaining.body.templates[0].origin, 'system', '기본 템플릿이 목록 맨 앞이다')
  })
})

test('id와 출처는 본문에서 정할 수 없다 — 기본 템플릿과 같은 id의 그림자 행이 생기지 않는다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    await admin('GET', '/api/project-templates')

    // 본문의 id를 받아 주면 기본 템플릿과 같은 id의 행이 하나 더 생기고, 그 뒤로는 find()가 그림자 행을 집는다
    // ('기본 템플릿은 고칠 수 없다'가 무너지고, 지우기 한 번이 두 행을 함께 지운다).
    const forged = await admin('POST', '/api/project-templates', baseBody({
      id: FOOD_TEMPLATE, name: '가짜 신제품', sourceProjectId: 'PRJ-FAKE', sourceTemplateId: IT_TEMPLATE,
    }))
    assert.equal(forged.status, 201, JSON.stringify(forged.body))
    assert.notEqual(forged.body.template.id, FOOD_TEMPLATE)
    assert.match(forged.body.template.id, /^PT-[0-9A-Z]+-[0-9A-F]{4}$/)
    assert.equal(forged.body.template.sourceProjectId, undefined, '출처는 서버가 아는 경로에서만 붙는다')
    assert.equal(forged.body.template.sourceTemplateId, undefined)

    const rows = store.tenants[TENANT]['project-templates'].data
    assert.equal(new Set(rows.map((item) => item.id)).size, rows.length, '같은 id의 행이 둘 있으면 안 된다')

    // 기본 템플릿은 여전히 자기 id로 닿고, 여전히 고칠 수 없다.
    const system = await admin('GET', `/api/project-templates/${FOOD_TEMPLATE}`)
    assert.equal(system.body.template.origin, 'system')
    assert.equal(system.body.template.name, '신제품 출시')
    const removed = await admin('DELETE', `/api/project-templates/${FOOD_TEMPLATE}`)
    assert.equal(removed.status, 409)
    assert.equal(removed.body.error.code, 'TEMPLATE_SYSTEM_READONLY')
    assert.equal(store.tenants[TENANT]['project-templates'].data.some((item) => item.id === FOOD_TEMPLATE), true)
  })
})

// ─────────────────────────── 6) 초안·템플릿으로 저장 ───────────────────────────

test('프로젝트를 템플릿으로 저장하면 사람은 역할이 되고 상대 마감일만 남는다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const created = await admin('POST', '/api/projects', { name: '표시사항 개선', startDate: '2026-09-01', members: [{ id: OH.id, role: 'viewer' }] })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const projectId = created.body.project.id

    const put = await admin('PUT', '/api/workspace/work-items', {
      data: [
        workItem({ id: 'WK-P', title: '표시사항 검토', ownerId: PARK.id, owner: PARK.name, due: '2026-09-08T00:00:00.000Z', projectId, category: '품질' }),
        workItem({ id: 'WK-C', title: '원재료 확인', ownerId: OH.id, owner: OH.name, due: '2026-09-05T00:00:00.000Z', projectId, parentId: 'WK-P', category: '생산' }),
      ],
    })
    assert.equal(put.status, 200, JSON.stringify(put.body))
    const room = await admin('POST', '/api/messenger/conversations/group', { name: '설계 채널', projectId, participantIds: [OH.id] })
    assert.equal(room.status, 201, JSON.stringify(room.body))

    const draft = await admin('GET', `/api/projects/${projectId}/template-draft`)
    assert.equal(draft.status, 200, JSON.stringify(draft.body))
    assert.deepEqual(draft.body.people.map((person) => person.suggestedRole), ['품질 책임자', '생산 반장'])
    assert.deepEqual(draft.body.people.map((person) => person.accountId), [PARK.id, OH.id])
    assert.deepEqual(draft.body.people.map((person) => person.taskCount), [1, 1])
    assert.equal(draft.body.draft.tasks.length, 1)

    const saved = await admin('POST', `/api/projects/${projectId}/save-as-template`, {
      name: '품질 루틴', roleMap: { [PARK.id]: '품질', [OH.id]: '생산' },
    })
    assert.equal(saved.status, 201, JSON.stringify(saved.body))
    assert.deepEqual(saved.body.template.roles, ['품질', '생산'])
    assert.equal(saved.body.template.tasks[0].dueOffsetDays, 7)
    assert.equal(saved.body.template.tasks[0].children[0].dueOffsetDays, 4)
    assert.equal(saved.body.template.channels[0].name, '설계 채널')
    assert.equal(saved.body.template.sourceProjectId, projectId)
    assert.equal(saved.body.template.history[0].summary, '프로젝트 ‘표시사항 개선’에서 저장')
    // 이력의 byId/byName은 "누가 저장했는가"라 예외다. 본문에는 사람이 없어야 한다.
    const { history: _history, ...savedBody } = saved.body.template
    assertNoNames(savedBody, 'save-as-template')

    const named = await admin('POST', `/api/projects/${projectId}/save-as-template`, { name: '실명 루틴', roleMap: { [PARK.id]: PARK.name } })
    assert.equal(named.status, 400)
    assert.equal(named.body.error.code, 'TEMPLATE_CONTAINS_PERSON')

    const missing = await admin('GET', '/api/projects/PRJ-NONE/template-draft')
    assert.equal(missing.status, 404)
    assert.equal(missing.body.error.code, 'PROJECT_NOT_FOUND')
  })
})

test('업무가 없는 프로젝트는 초안도 저장도 같은 말로 이유를 댄다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    const created = await admin('POST', '/api/projects', { name: '아직 빈 프로젝트' })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const projectId = created.body.project.id

    const draft = await admin('GET', `/api/projects/${projectId}/template-draft`)
    assert.equal(draft.status, 200, JSON.stringify(draft.body))
    assert.equal(draft.body.draft.tasks.length, 0)
    const reason = draft.body.warnings[0]
    assert.match(reason, /업무가 없습니다/)

    // 저장이 '역할을 1~20개로 정해 주세요'라고 답하면, 사람은 건드린 적 없는 역할표를 들여다보게 된다.
    const saved = await admin('POST', `/api/projects/${projectId}/save-as-template`, { name: '빈 템플릿' })
    assert.equal(saved.status, 400)
    assert.equal(saved.body.error.code, 'TEMPLATE_INVALID')
    assert.equal(saved.body.error.path, 'tasks')
    assert.equal(saved.body.error.message, reason, '초안 경고와 저장 오류는 한 문장에서 나온다')
  })
})

// ─────────────────────────── 7·8·10) 실체화 ───────────────────────────

const instantiateBody = (overrides = {}) => ({
  name: '가을 신제품',
  startDate: '2026-10-01',
  roleMap: { PM: PARK.id, 품질: OH.id, 생산: SEO.id },
  clientRequestId: 'req-1',
  ...overrides,
})

test('판정 2 — 템플릿으로 프로젝트를 만들면 업무·하위 업무·채널·자료 분류가 함께 생기고 역할이 사람에게 붙는다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    await admin('GET', '/api/project-templates')

    const made = await admin('POST', `/api/project-templates/${FOOD_TEMPLATE}/instantiate`, instantiateBody())
    assert.equal(made.status, 201, JSON.stringify(made.body))
    const project = made.body.project
    assert.deepEqual(project.origin, {
      kind: 'template', templateId: FOOD_TEMPLATE, templateName: '신제품 출시', templateVersion: 1, clientRequestId: 'req-1',
    })
    assert.deepEqual(project.documentCategories, ['제품·표시사항', '생산·품질', '식품안전·인증'])
    assert.equal(project.startDate, '2026-10-01')
    for (const person of [PARK, OH, SEO]) {
      const member = project.members.find((item) => item.id === person.id)
      assert.equal(member?.role, 'editor', `${person.id} 역할`)
    }

    const rows = made.body.workItems
    assert.equal(rows.length, 18)
    assert.ok(rows.every((row) => row.projectId === project.id && row.origin.kind === 'template'))
    const parentIds = new Set(rows.filter((row) => !row.parentId).map((row) => row.id))
    assert.equal(parentIds.size, 5)
    const children = rows.filter((row) => row.parentId)
    assert.equal(children.length, 13)
    assert.ok(children.every((row) => parentIds.has(row.parentId)))
    assert.match(rows[0].id, /^WK-T-PT-SYS-FOOD-NEW-PRODUCT-[A-Z0-9]+-[A-F0-9]{4}-/)

    const prototype = rows.find((row) => row.origin.detail === 'prototype')
    assert.equal(prototype.due, '2026-10-15T09:00:00.000Z')
    const recipe = rows.find((row) => row.origin.detail === 'prototype-recipe')
    assert.equal(recipe.ownerId, SEO.id)
    assert.equal(recipe.owner, SEO.name)

    assert.equal(made.body.channels.length, 2)
    const memberIds = new Set([project.ownerId, ...project.members.map((item) => item.id)])
    for (const [index, channel] of made.body.channels.entries()) {
      assert.equal(channel.projectId, project.id)
      assert.ok(channel.participantIds.every((id) => memberIds.has(id)), '채널 참여자는 프로젝트 멤버 안에서만 나온다')
      assert.ok(channel.participantIds.includes(OH.id))
      assert.match(channel.id, new RegExp(`-${index + 1}$`))
    }

    assert.equal(made.body.rules.length, 1)
    assert.equal(made.body.rules[0].ownerId, SEO.id)
    assert.equal(made.body.rules[0].owner, SEO.name)
    assert.match(made.body.rules[0].title, /^\[.+\] 생산 라인 일일 점검$/)
    assert.equal(made.body.rules[0].nextRun, '2026-10-01')
    assert.equal(made.body.rules[0].checklist.length, 2)

    const detail = await admin('GET', `/api/projects/${project.id}`)
    assert.equal(detail.body.project.origin.kind, 'template')

    const stored = await admin('GET', '/api/workspace/work-items')
    assert.equal(stored.body.data.filter((row) => row.projectId === project.id).length, 18)

    // 자식만 보이는 직원에게는 상위 '제목'만 간다(R16-C의 parents envelope).
    const oh = api(origin, await login(origin, OH.email))
    const mine = await oh('GET', '/api/workspace/work-items')
    assert.equal(mine.body.data.length, 7, '품질 역할 행만 보인다')
    assert.ok(Object.keys(mine.body.parents ?? {}).length > 0)

    // 알림은 사람당 한 건으로 묶인다. 실행자 본인에게는 가지 않는다.
    const inbox = await oh('GET', '/api/notifications')
    const assigned = inbox.body.items.filter((item) => item.type === 'task-assigned')
    assert.equal(assigned.length, 1)
    assert.match(assigned[0].title, /새 업무 7건/)
    assert.ok(parentIds.has(assigned[0].focusId), '대표는 상위 업무다')
    assert.equal(inbox.body.items.filter((item) => item.type === 'mention').length, 0)

    const park = api(origin, await login(origin, PARK.email))
    assert.equal((await park('GET', '/api/notifications')).body.items.filter((item) => item.type === 'task-assigned').length, 1)
    assert.equal((await admin('GET', '/api/notifications')).body.items.filter((item) => item.type === 'task-assigned').length, 0)
  })
})

test('실체화 음성: 역할 매핑·이름·템플릿이 어긋나면 아무것도 만들지 않고, 같은 요청 id는 한 번만 만든다', async () => {
  const store = freshStore()
  await withServer(buildApp(store), async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    await admin('GET', '/api/project-templates')

    const unmapped = await admin('POST', `/api/project-templates/${FOOD_TEMPLATE}/instantiate`, instantiateBody({ roleMap: { PM: PARK.id, 품질: OH.id } }))
    assert.equal(unmapped.status, 400)
    assert.equal(unmapped.body.error.code, 'TEMPLATE_ROLE_UNMAPPED')
    assert.deepEqual(unmapped.body.error.roles, ['생산'])

    const foreign = await admin('POST', `/api/project-templates/${FOOD_TEMPLATE}/instantiate`, instantiateBody({ roleMap: { PM: PARK.id, 품질: OH.id, 생산: 'USR-POHANG-ADMIN' } }))
    assert.equal(foreign.status, 400)
    assert.equal(foreign.body.error.code, 'TEMPLATE_ROLE_INVALID')

    assert.equal((await admin('POST', `/api/project-templates/${FOOD_TEMPLATE}/instantiate`, instantiateBody({ name: 'A' }))).body.error.code, 'INVALID_PROJECT')
    assert.equal((await admin('POST', '/api/project-templates/PT-NONE/instantiate', instantiateBody())).status, 404)
    assert.equal((await admin('GET', '/api/projects')).body.projects.length, 0, '거절된 요청은 프로젝트를 남기지 않는다')

    const first = await admin('POST', `/api/project-templates/${FOOD_TEMPLATE}/instantiate`, instantiateBody())
    assert.equal(first.status, 201)
    const replay = await admin('POST', `/api/project-templates/${FOOD_TEMPLATE}/instantiate`, instantiateBody())
    assert.equal(replay.status, 200)
    assert.equal(replay.body.replayed, true)
    assert.equal(replay.body.project.id, first.body.project.id)
    assert.equal(replay.body.workItems.length, 18)
    assert.equal(store.tenants[TENANT]['work-items'].data.length, 18, '재시도는 업무를 더 만들지 않는다')

    const other = await admin('POST', `/api/project-templates/${FOOD_TEMPLATE}/instantiate`, instantiateBody({ clientRequestId: 'req-2' }))
    assert.equal(other.status, 201)
    assert.notEqual(other.body.project.id, first.body.project.id)
    assert.equal(store.tenants[TENANT]['work-items'].data.length, 36)
    assert.equal(new Set(store.tenants[TENANT]['work-items'].data.map((row) => row.id)).size, 36, 'id가 겹치지 않는다')
  })
})

test('실체화는 네 키를 한 번에 저장하거나 아무것도 저장하지 않는다', async () => {
  const store = freshStore()
  let failNext = false
  const app = buildApp(store, {
    onWorkspaceStoreChange: () => { if (failNext) { failNext = false; throw new Error('disk full') } },
  })
  await withServer(app, async (origin) => {
    const admin = api(origin, await login(origin, ADMIN.email))
    await admin('GET', '/api/project-templates')
    const keys = ['project-spaces', 'work-items', 'messenger-conversations', 'work-rules']
    const before = structuredClone(Object.fromEntries(keys.map((key) => [key, store.tenants[TENANT][key] ?? null])))

    failNext = true
    const failed = await admin('POST', `/api/project-templates/${FOOD_TEMPLATE}/instantiate`, instantiateBody())
    assert.equal(failed.status, 500)
    assert.equal(failed.body.error.code, 'TEMPLATE_INSTANTIATE_FAILED')
    for (const key of keys) {
      assert.deepEqual(store.tenants[TENANT][key] ?? null, before[key], `${key}는 호출 전 그대로다`)
    }
    assert.equal((await admin('GET', '/api/projects')).body.projects.length, 0)
    assert.equal(((await admin('GET', '/api/workspace/work-items')).body.data ?? []).length, 0)
  })
})

// ─────────────────────────── 12) 게스트 ───────────────────────────

const digestHex = (password, accountId) => scryptSync(String(password), `onfactory:${accountId}`, 32).toString('hex')

test('게스트에게는 템플릿 라우트도, 프로젝트의 템플릿 출처도 보이지 않는다', async () => {
  const store = freshStore()
  store.tenants[TENANT]['project-spaces'] = {
    data: [{
      id: 'PRJ-A', name: '파트너 협업 A', description: '', visibility: 'members', status: 'active', stage: '진행 중', client: '파트너상사', amount: 1_000, link: '', category: '',
      ownerId: ADMIN.id, ownerName: ADMIN.name,
      origin: { kind: 'template', templateId: FOOD_TEMPLATE, templateName: '신제품 출시', templateVersion: 1 },
      members: [{ id: ADMIN.id, name: ADMIN.name, role: 'owner' }, { id: GUEST.id, name: GUEST.name, team: '파트너상사', role: 'viewer', kind: 'guest' }],
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    }],
    updatedAt: '2026-09-01T00:00:00.000Z',
  }
  store.accountApprovals[GUEST.id] = 'approved'
  store.accountCredentials[GUEST.id] = { passwordHash: digestHex(GUEST.password, GUEST.id), mustChangePassword: false, temporaryPasswordExpiresAt: null }
  store.invitedAccounts.push({ id: GUEST.id, email: GUEST.email, name: GUEST.name, tenantId: TENANT, tenantName: '햇살바다', team: '파트너상사', jobRole: '외부 게스트', requested: '게스트 초대', role: 'tenant-guest', guestGrantId: GRANT_ID })
  store.guestGrants.push({
    id: GRANT_ID, tenantId: TENANT, accountId: GUEST.id, email: GUEST.email, name: GUEST.name, orgName: '파트너상사', projectIds: ['PRJ-A'],
    invitedById: ADMIN.id, invitedByName: ADMIN.name, status: 'active', tokenHash: null, tokenIssuedAt: null, tokenExpiresAt: null,
    resendCount: 0, lastResentAt: null, accessExpiresAt: null, acceptedAt: '2026-09-01T00:00:00.000Z', revokedAt: null, revokedById: null, deactivatedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  })

  await withServer(buildApp(store), async (origin) => {
    const guest = api(origin, await login(origin, GUEST.email, GUEST.password))
    const forbidden = { error: { code: 'GUEST_SCOPE_FORBIDDEN', message: '초대된 프로젝트 안에서만 사용할 수 있습니다.' } }
    for (const [method, route, body] of [
      ['GET', '/api/project-templates', undefined],
      ['GET', `/api/project-templates/${FOOD_TEMPLATE}`, undefined],
      ['POST', `/api/project-templates/${FOOD_TEMPLATE}/instantiate`, { name: '몰래 만들기' }],
      ['GET', '/api/projects/PRJ-A/template-draft', undefined],
      ['POST', '/api/projects/PRJ-A/save-as-template', { name: '가져가기' }],
    ]) {
      const result = await guest(method, route, body)
      assert.equal(result.status, 403, `${method} ${route}`)
      assert.deepEqual(result.body, forbidden)
    }

    // 템플릿 이름은 회사의 내부 프로세스 이름이다 — 계약 금액·거래처와 같은 취급으로 지운다.
    const detail = await guest('GET', '/api/projects/PRJ-A')
    assert.equal(detail.status, 200, JSON.stringify(detail.body))
    assert.equal(detail.body.project.origin, undefined)
    assert.equal(detail.body.project.amount, undefined)
    assert.doesNotMatch(JSON.stringify(detail.body), /신제품 출시/)
  })
})

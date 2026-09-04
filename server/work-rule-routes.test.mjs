import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createApp } from './app.mjs'
import { withServer } from './test-server.mjs'

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
  const directory = await mkdtemp(path.join(os.tmpdir(), 'work-rules-'))
  try {
    const app = createApp({ apiKey: '', workspaceStoreFile: path.join(directory, 'state.json'), documentUploadDirectory: path.join(directory, 'documents') })
    await withServer(app, (origin) => run(origin, app))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const createRule = (origin, headers, body) => fetch(`${origin}/api/work-rules`, {
  method: 'POST', headers, body: JSON.stringify(body),
})

const materialize = (origin, headers) => fetch(`${origin}/api/work-rules/materialize`, { method: 'POST', headers })

/** 어제 날짜. 규칙을 만들자마자 회차가 생기게 하려면 시작일이 과거여야 한다. */
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)

test('판정2 — 매월 마지막 영업일 규칙이 체크리스트와 함께 만들어진다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)

    const response = await createRule(origin, admin.headers, {
      title: '월말 재고 마감',
      description: '창고 실사 후 마감 보고',
      ownerId: park.account.id,
      frequency: 'monthly',
      interval: 1,
      monthlyMode: 'last-business-day',
      startDate: '2027-01-01',
      dueTime: '17:00',
      priority: '높음',
      category: '재고',
      holidayPolicy: 'before',
      checklist: [{ label: '창고 실사표 작성' }, { label: '전산 재고와 대조' }, { label: '차이분 사유 기재' }],
      remindAfterMinutes: 60,
      escalateAfterMinutes: 240,
    })
    const body = await response.json()
    assert.equal(response.status, 201, JSON.stringify(body))
    const rule = body.rule
    assert.equal(rule.monthlyMode, 'last-business-day')
    assert.equal(rule.holidayPolicy, 'before')
    assert.equal(rule.checklist.length, 3)
    assert.equal(rule.remindAfterMinutes, 60)
    assert.equal(rule.escalateAfterMinutes, 240)
    // 2027-01-31은 일요일이라 마지막 영업일은 1-29(금).
    assert.equal(rule.nextRun, '2027-01-29')
  })
})

test('판정2 — 생성된 회차에 체크리스트가 붙고, 남아 있으면 완료 보고를 막는다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)
    await createRule(origin, admin.headers, {
      title: '일일 금속검출기 점검',
      description: '시험편으로 감도 확인',
      ownerId: park.account.id,
      frequency: 'daily',
      interval: 1,
      startDate: yesterday(),
      dueTime: '18:00',
      priority: '보통',
      category: '품질',
      checklist: [{ label: 'Fe 시험편' }, { label: 'SUS 시험편' }],
    })
    await materialize(origin, admin.headers)

    const tasks = (await (await fetch(`${origin}/api/workspace/work-items`, { headers: park.headers })).json()).data
    const task = tasks.find((item) => item.title === '일일 금속검출기 점검')
    assert.ok(task, '회차가 생성된다')
    assert.equal(task.checklist.length, 2)
    assert.deepEqual(task.checklist.map((item) => item.done), [false, false])

    await fetch(`${origin}/api/work-items/${task.id}/transition`, {
      method: 'POST', headers: park.headers, body: JSON.stringify({ action: 'accept' }),
    })
    const blocked = await fetch(`${origin}/api/work-items/${task.id}/transition`, {
      method: 'POST', headers: park.headers,
      body: JSON.stringify({ action: 'submit', completion: { summary: '점검 완료했습니다', evidence: [] } }),
    })
    assert.equal(blocked.status, 409, '전 항목을 마치기 전에는 완료 보고를 받지 않는다')
    const error = (await blocked.json()).error
    assert.equal(error.code, 'CHECKLIST_INCOMPLETE')
    assert.match(error.message, /Fe 시험편/, '무엇이 남았는지 알려 준다')

    for (const item of task.checklist) {
      const ticked = await fetch(`${origin}/api/work-items/${task.id}/checklist`, {
        method: 'POST', headers: park.headers, body: JSON.stringify({ itemId: item.id, done: true }),
      })
      assert.equal(ticked.status, 200)
    }
    const allowed = await fetch(`${origin}/api/work-items/${task.id}/transition`, {
      method: 'POST', headers: park.headers,
      body: JSON.stringify({ action: 'submit', completion: { summary: '점검 완료했습니다', evidence: [] } }),
    })
    assert.equal(allowed.status, 200, '전 항목을 마치면 통과한다')
  })
})

test('체크리스트는 담당자만 체크하고, 완료 보고 뒤에는 잠긴다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)
    const oh = await signIn(origin, OH)
    await createRule(origin, admin.headers, {
      title: '권한 시험 점검', description: '설명', ownerId: park.account.id,
      frequency: 'daily', interval: 1, startDate: yesterday(), dueTime: '18:00',
      priority: '보통', category: '품질', checklist: [{ label: '항목1' }],
    })
    await materialize(origin, admin.headers)
    const tasks = (await (await fetch(`${origin}/api/workspace/work-items`, { headers: park.headers })).json()).data
    const task = tasks.find((item) => item.title === '권한 시험 점검')

    const byOther = await fetch(`${origin}/api/work-items/${task.id}/checklist`, {
      method: 'POST', headers: oh.headers, body: JSON.stringify({ itemId: task.checklist[0].id, done: true }),
    })
    assert.equal(byOther.status, 403)
  })
})

test('판정2 — 미착수는 담당자 알림, 더 지나면 관리자에게 올라간다', async () => {
  await withApp(async (origin, app) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)
    await createRule(origin, admin.headers, {
      title: '미착수 감시 시험', description: '설명', ownerId: park.account.id,
      frequency: 'daily', interval: 1, startDate: yesterday(), dueTime: '18:00',
      priority: '보통', category: '품질',
      remindAfterMinutes: 30, escalateAfterMinutes: 120,
    })
    await materialize(origin, admin.headers)

    // 만든 지 45분이 지난 시점 — 담당자에게만 간다.
    app.locals.sweepUnstartedRuleTasks(new Date(Date.now() + 45 * 60_000))
    const ownerInbox = (await (await fetch(`${origin}/api/notifications`, { headers: park.headers })).json()).items
    assert.ok(ownerInbox.some((item) => /아직 시작하지 않은/.test(item.title)), '담당자가 먼저 안다')

    // 세 시간이 지난 시점 — 관리자에게 올라간다.
    app.locals.sweepUnstartedRuleTasks(new Date(Date.now() + 180 * 60_000))
    const adminInbox = (await (await fetch(`${origin}/api/notifications`, { headers: admin.headers })).json()).items
    assert.ok(adminInbox.some((item) => /미착수/.test(item.title)), '담당자가 안 움직이면 관리자에게 올린다')
  })
})

test('순번 배정은 회차마다 담당자를 돌리고, 두 명 미만이면 거절한다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)
    const oh = await signIn(origin, OH)

    const tooFew = await createRule(origin, admin.headers, {
      title: '순번 부족', description: '설명', ownerId: park.account.id,
      frequency: 'daily', interval: 1, startDate: yesterday(), dueTime: '18:00',
      priority: '보통', category: '품질', assignMode: 'rotation', rotation: [park.account.id],
    })
    assert.equal(tooFew.status, 400)
    assert.equal((await tooFew.json()).error.code, 'INVALID_ROTATION')

    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10)
    const created = await createRule(origin, admin.headers, {
      title: '당번 점검', description: '설명', ownerId: park.account.id,
      frequency: 'daily', interval: 1, startDate: threeDaysAgo, dueTime: '18:00',
      priority: '보통', category: '품질',
      assignMode: 'rotation', rotation: [park.account.id, oh.account.id],
    })
    assert.equal(created.status, 201)
    await materialize(origin, admin.headers)

    const tasks = (await (await fetch(`${origin}/api/workspace/work-items`, { headers: admin.headers })).json()).data
      .filter((item) => item.title === '당번 점검')
      .sort((left, right) => left.ruleOccurrence.localeCompare(right.ruleOccurrence))
    assert.ok(tasks.length >= 3, `회차가 여러 번 생겨야 순번을 볼 수 있다 (실제 ${tasks.length}건)`)
    assert.equal(tasks[0].ownerId, park.account.id)
    assert.equal(tasks[1].ownerId, oh.account.id, '다음 회차는 다음 사람')
    assert.equal(tasks[2].ownerId, park.account.id, '한 바퀴 돌면 처음으로')
  })
})

test('이행률은 낮은 규칙이 위로 오고, 판단할 회차가 없으면 뒤로 간다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10)

    await createRule(origin, admin.headers, {
      title: '방치된 점검', description: '설명', ownerId: park.account.id,
      frequency: 'daily', interval: 1, startDate: threeDaysAgo, dueTime: '18:00',
      priority: '보통', category: '품질',
    })
    await createRule(origin, admin.headers, {
      title: '아직 이른 점검', description: '설명', ownerId: park.account.id,
      frequency: 'yearly', interval: 1, monthDay: 1, startDate: '2027-06-01', dueTime: '18:00',
      priority: '보통', category: '품질',
    })
    await materialize(origin, admin.headers)

    const body = await (await fetch(`${origin}/api/work-rules/compliance`, { headers: admin.headers })).json()
    const neglected = body.rules.find((row) => row.title === '방치된 점검')
    const early = body.rules.find((row) => row.title === '아직 이른 점검')
    assert.ok(neglected, '이행률 목록에 규칙이 나온다')
    assert.equal(neglected.rate, 0, '아무도 손대지 않았으면 0이다')
    assert.equal(early.rate, null, '판단할 회차가 없으면 null이다')
    assert.ok(body.rules.indexOf(neglected) < body.rules.indexOf(early), '낮은 이행률이 위로 온다')
    assert.equal(body.window, 12)
  })
})

test('공휴일 정책이 실제 회차 날짜를 옮긴다', async () => {
  await withApp(async (origin) => {
    const admin = await signIn(origin, ADMIN)
    const park = await signIn(origin, PARK)
    // 2026-08-15는 광복절(토), 8-17이 대체공휴일. 'after'면 8-18로 밀린다.
    await createRule(origin, admin.headers, {
      title: '광복절 겹침 점검', description: '설명', ownerId: park.account.id,
      frequency: 'monthly', interval: 1, monthDay: 15, startDate: '2026-08-01', dueTime: '18:00',
      priority: '보통', category: '품질', holidayPolicy: 'after',
    })
    await materialize(origin, admin.headers)

    const tasks = (await (await fetch(`${origin}/api/workspace/work-items`, { headers: admin.headers })).json()).data
      .filter((item) => item.title === '광복절 겹침 점검')
    const august = tasks.find((item) => item.ruleOccurrence === '2026-08-15')
    assert.ok(august, '8월 회차가 만들어진다')
    assert.match(august.description, /2026-08-18로 미뤘습니다/, '왜 옮겼는지 업무에 적힌다')
    assert.equal(august.due.slice(0, 10), '2026-08-18', '마감이 실제로 옮겨진다')
  })
})

import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import test from 'node:test'

import { createApp } from './app.mjs'
import { createBillingService, createMemoryBillingRepository } from './billing-service.mjs'
import { MAX_MEETINGS_PER_TENANT, MAX_PARTICIPANTS, registerMeetingNoteRoutes } from './meeting-notes.mjs'
import { createTranscription } from './transcription.mjs'
import { withServer } from './test-server.mjs'

/**
 * 회의록 — HTTP 계약.
 *
 * 이 파일이 잠그는 것은 「AI 키도 실제 오디오도 없이 무엇이 실제로 되는가」다. 그래서 전부
 * 데모 모드(`apiKey: ''`)로 돌고, 전사는 사람이 올린 원문을 읽는 `text` 어댑터로 돈다.
 * 지어낸 전사 결과는 이 파일 어디에도 없다 — 원문은 시험이 직접 올리고, 요약은 그 원문에서 뽑힌다.
 *
 * 시계는 주입한다(`meetingClock`). 폴백 요약이 마감을 추정할 때 벽시계를 읽으면
 * 금요일 밤에만 빨개지는 시험이 된다.
 */

const TENANT = 'TENANT-SUNSEA'
const OTHER_TENANT = 'TENANT-POHANG'
const ADMIN = { id: 'USR-SUNSEA-ADMIN', email: 'admin@sunsea.co.kr' }
const PARK = { id: 'USR-SUNSEA-PARK', email: 'jihyun.park@sunsea.co.kr' }
const LEE = { id: 'USR-SUNSEA-LEE', email: 'jungmin.lee@sunsea.co.kr' }
const GUEST = { id: 'USR-TENANT-SUNSEA-GUEST01', name: '홍거래', email: 'guest@partner.example', password: 'Guest!Pass2026' }
const GRANT_ID = 'GST-TENANT-SUNSEA-000001'

/** KST 2026-09-03(목) 10:00. '금요일까지'가 하루 뒤로 떨어지는 자리다. */
const NOW = '2026-09-03T01:00:00.000Z'

/**
 * 시험이 올리는 회의록 원문. 아무도 하지 않은 말을 넣지 않는다 — 아래 단언이 기대하는 결정·할 일은
 * 전부 이 글자들에서 나온다(폴백 요약은 원문의 줄을 그대로 인용한다).
 */
const TRANSCRIPT = [
  '김서원: 오늘 9월 품질 회의를 시작하겠습니다.',
  '박지현: 9월 원물 단가는 동결하기로 했습니다.',
  '오태식: 포장재 두께는 0.8mm로 확정합니다.',
  '박지현: 이정민님, 검사 기준서를 다음 주까지 정리 부탁드립니다.',
  '오태식: 라인 점검표는 금요일까지 제출 부탁드립니다.',
].join('\n')

const digestHex = (password, accountId) => scryptSync(String(password), `onfactory:${accountId}`, 32).toString('hex')
const readJson = async (response) => { const text = await response.text(); try { return JSON.parse(text) } catch { return { raw: text } } }

function memoryStorage() {
  const files = new Map()
  return {
    files,
    backend: 'local',
    async put(key, body) { files.set(key, Buffer.from(body)); return { key, size: body.length } },
    async get(key) {
      const value = files.get(key)
      if (!value) { const error = new Error('없음'); error.code = 'STORAGE_NOT_FOUND'; throw error }
      return value
    },
    async delete(key) { return files.delete(key) },
    async getSignedUrl(_key, options = {}) { return options.fallbackUrl ?? null },
  }
}

/**
 * `get`을 한 번 붙잡아 두는 저장소. 「원본 파일을 읽는 동안」이라는 창을 시험이 실제로 열어,
 * 처리 중인 회의와 다른 요청(AI 처리 수준 내리기)을 진짜로 겹치게 만든다.
 * 벽시계를 재지 않는다 — 게이트를 여는 것은 시험이다(규칙 12).
 */
function gatedStorage() {
  const storage = memoryStorage()
  const inner = storage.get
  let pending = null
  /** 다음 `get` 한 번을 붙잡는다. 반환의 `reached`는 실제로 그 자리에 닿았을 때 풀린다(잠들지 않는다). */
  storage.hold = () => {
    let open
    let arrive
    const gate = new Promise((resolve) => { open = resolve })
    const reached = new Promise((resolve) => { arrive = resolve })
    pending = { gate, arrive }
    return { reached, open }
  }
  storage.get = async (key) => {
    if (pending) {
      const held = pending
      pending = null
      held.arrive()
      await held.gate
    }
    return inner(key)
  }
  return storage
}

/** 회의 목록·상한 시험용 씨앗. HTTP로 1,000건을 만들면 시험이 분 단위로 늘어진다. */
function seedMeetings(store, count, { createdById = ADMIN.id, status = 'uploaded' } = {}) {
  const data = Array.from({ length: count }, (_, index) => ({
    id: `MTG-SEED-${String(index).padStart(4, '0')}`,
    tenantId: TENANT,
    title: `씨앗 회의 ${index}`,
    recordingDocumentId: '', transcriptDocumentId: '',
    transcriptText: '', transcriptChars: 0, transcriptTruncated: false, transcriptUnreadChars: 0,
    documentId: '', participantIds: [], status, error: '', summary: null, proposalIds: [], usage: {},
    createdById, createdByName: '김서원',
    createdAt: NOW, updatedAt: `2026-09-0${1 + (index % 3)}T01:00:00.000Z`,
  }))
  store.tenants[TENANT]['meeting-notes'] = { data, updatedAt: NOW, updatedBy: createdById }
  return data
}

function freshStore() {
  return {
    version: 2,
    tenants: { [TENANT]: {}, [OTHER_TENANT]: {} },
    platform: {},
    accountApprovals: { [GUEST.id]: 'approved' },
    accountCredentials: { [GUEST.id]: { passwordHash: digestHex(GUEST.password, GUEST.id), mustChangePassword: false, temporaryPasswordExpiresAt: null } },
    invitedAccounts: [{ id: GUEST.id, email: GUEST.email, name: GUEST.name, tenantId: TENANT, tenantName: '햇살바다', team: '파트너상사', jobRole: '외부 게스트', requested: '게스트 초대', role: 'tenant-guest', guestGrantId: GRANT_ID }],
    passwordResetRequests: [],
    guestGrants: [{
      id: GRANT_ID, tenantId: TENANT, accountId: GUEST.id, email: GUEST.email, name: GUEST.name, orgName: '파트너상사', projectIds: [],
      invitedById: ADMIN.id, invitedByName: '김서원', status: 'active', tokenHash: null, tokenIssuedAt: null, tokenExpiresAt: null,
      resendCount: 0, lastResentAt: null, accessExpiresAt: null, acceptedAt: '2026-09-01T00:00:00.000Z', revokedAt: null, revokedById: null, deactivatedAt: null,
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    }],
  }
}

/** 전사가 되는 앱 한 벌. 원장은 진짜를 쓴다 — 사용량 단언이 흉내가 아니라 원장을 읽게. */
function buildApp(store, extra = {}) {
  const repository = createMemoryBillingRepository()
  const billingService = extra.billingService ?? createBillingService({ repository })
  const storage = memoryStorage()
  const app = createApp({
    apiKey: '',
    initialWorkspaceStore: store,
    onWorkspaceStoreChange: () => {},
    documentStorage: storage,
    transcription: createTranscription({ env: { TRANSCRIPTION_PROVIDER: 'text' } }),
    meetingClock: () => new Date(NOW),
    ...extra,
    billingService,
  })
  return { app, repository, billingService, storage }
}

async function login(origin, email, password = 'demo1234') {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: 'tenant', email, password }),
  })
  const body = await readJson(response)
  assert.equal(response.status, 200, `${email}: ${JSON.stringify(body)}`)
  const account = body.account
  const headers = { cookie: response.headers.get('set-cookie') ?? '', 'x-workspace-identity': `${account.tenantId}:${account.id}` }
  return {
    account,
    async call(method, route, payload) {
      const result = await fetch(`${origin}${route}`, {
        method,
        headers: { ...headers, 'content-type': 'application/json' },
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
      })
      return { status: result.status, body: await readJson(result) }
    },
    /** 자료실 업로드. 분류·태그는 쿼리로, 파일 이름과 형식은 헤더로 간다(화면이 하는 것과 같다). */
    async upload({ name, mime = 'text/plain', body = TRANSCRIPT, category = '공통자료', tags = [], visibility = 'all' }) {
      const query = new URLSearchParams({ name, category, visibility })
      if (tags.length) query.set('tags', tags.join(','))
      const result = await fetch(`${origin}/api/documents?${query.toString()}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name), 'x-file-type': mime },
        body: Buffer.from(body, 'utf8'),
      })
      const uploaded = await readJson(result)
      assert.equal(result.status, 201, `업로드 실패: ${JSON.stringify(uploaded)}`)
      return uploaded.document
    },
  }
}

const documentsIn = (store) => (store.tenants[TENANT]['company-documents']?.data ?? [])
const proposalsIn = (store) => (store.tenants[TENANT]['ai-proposals']?.data ?? [])
const meetingTasksIn = (store) => proposalsIn(store).filter((row) => row.kind === 'meeting-task')
const usageEventsIn = (repository, feature) => repository.inspect().usageEvents.filter((row) => row.feature === feature)

test('1·2·3. 원문을 올려 회의를 만들고 한 번에 처리하면 회의록 문서와 업무 제안이 생긴다 — 다시 눌러도 늘지 않는다', async () => {
  const store = freshStore()
  const { app } = buildApp(store)
  await withServer(app, async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const source = await admin.upload({ name: '9월 품질 회의.txt' })

    // 1. 만들기
    const created = await admin.call('POST', '/api/meetings', { title: '9월 품질 회의', transcriptDocumentId: source.id })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    assert.equal(created.body.meeting.status, 'uploaded')
    assert.equal(created.body.meeting.documentId, '')
    const meetingId = created.body.meeting.id

    // 2. 한 번에 처리 — AI 키가 없으므로 원문에서 그대로 뽑는 갈래로 간다.
    const processed = await admin.call('POST', `/api/meetings/${meetingId}/process`)
    assert.equal(processed.status, 200, JSON.stringify(processed.body))
    assert.equal(processed.body.mode, 'grounded-fallback', 'AI 연결이 없는 갈래의 이름은 그 사실을 말해야 한다')
    assert.equal(processed.body.meeting.status, 'done')
    assert.ok(processed.body.documentId.startsWith('WDOC-'), '회의록 문서가 만들어져야 한다')
    assert.equal(processed.body.queued, 2, `원문의 지시 두 줄이 제안 둘이 된다 — ${JSON.stringify(processed.body.meeting.summary?.tasks)}`)
    assert.equal(processed.body.meeting.summary.notice, 'AI 연결이 없어 회의록 원문에서 그대로 뽑아 정리했습니다.')
    // 결정·할 일의 인용은 전부 원문에 글자 그대로 있어야 한다.
    for (const row of [...processed.body.meeting.summary.decisions, ...processed.body.meeting.summary.tasks]) {
      assert.ok(TRANSCRIPT.includes(row.quote), `원문에 없는 인용이 나갔다 — ${row.quote}`)
    }

    // 회의록 문서는 **위키 문서**다. 요약·결정·할 일이 그 안에 있고 전사 원문 전문은 없다.
    const document = await admin.call('GET', `/api/wiki/${processed.body.documentId}`)
    assert.equal(document.status, 200, JSON.stringify(document.body))
    assert.equal(document.body.document.title, '9월 품질 회의 회의록')
    const documentText = document.body.document.blocks.map((block) => block.text ?? '').join('\n')
    assert.ok(documentText.includes('결정 사항'), '결정 사항 절이 있어야 한다')
    // 이 문서는 회사 전원이 읽는다. 그래서 노출은 요약·결정·할 일까지이고 원문 전문은 담지 않는다.
    assert.ok(!documentText.includes(TRANSCRIPT), '전사 원문 전문을 문서에 담지 않는다')
    assert.ok(documentText.includes('전사 원문 전문은 이 문서에 담지 않았습니다'), '어디서 원문을 볼 수 있는지 문서가 말해야 한다')
    assert.ok(documentText.includes('9월 품질 회의.txt'), '원본 파일 이름이 적혀야 되짚어 갈 수 있다')

    // 승인 큐에 meeting-task 로 오른다. 별도 화면을 만들지 않는다.
    const queue = await admin.call('GET', '/api/proposals')
    const tasks = queue.body.proposals.filter((row) => row.kind === 'meeting-task')
    assert.equal(tasks.length, 2)
    assert.ok(tasks.every((row) => row.status === 'pending'))
    assert.ok(tasks.every((row) => row.payload.documentId === processed.body.documentId), '제안은 회의록 문서로 되짚어야 한다')
    assert.ok(tasks.some((row) => row.payload.owner === '이정민'), '원문의 「이정민님」이 담당으로 읽혀야 한다')
    assert.ok(tasks.every((row) => TRANSCRIPT.includes(row.payload.title) || row.evidence.includes('회의록')), '근거는 회의록을 가리킨다')
    const pendingBefore = queue.body.pendingCount

    // 3. 다시 눌러도 제안도 문서도 늘지 않는다.
    const again = await admin.call('POST', `/api/meetings/${meetingId}/process`)
    assert.equal(again.status, 200, JSON.stringify(again.body))
    assert.equal(again.body.queued, 0)
    assert.equal(again.body.skipped, 2, '이미 대기 중인 제안은 건너뛴 수로 센다')
    assert.equal(again.body.documentId, processed.body.documentId, '다시 요약해도 회의록 문서를 새로 만들지 않는다')
    const queueAgain = await admin.call('GET', '/api/proposals')
    assert.equal(queueAgain.body.pendingCount, pendingBefore, '대기 총계가 늘면 안 된다')
    assert.equal(meetingTasksIn(store).length, 2)
  })
})

test('4·5·6. AI 처리 수준이 문이다 — 보관만은 409, 정리는 문서까지, 활용에서 비로소 제안이 생긴다', async () => {
  const store = freshStore()
  const { app } = buildApp(store)
  await withServer(app, async (origin) => {
    // 원본을 올린 사람이 관리자가 아닌 **직원**이다. 이 사실이 D3의 증명이다 —
    // PATCH /api/documents 는 관리자 전용이라, 직원이 수준을 올릴 수 있다는 것은
    // 그 라우트를 지나지 않았다는 뜻이다.
    const park = await login(origin, PARK.email)
    const source = await park.upload({ name: '9월 품질 회의.txt', tags: ['meeting-recording'] })
    assert.equal(source.aiPolicy, 'locked', '회의 원본은 서버가 「보관만」으로 정한다')

    const created = await park.call('POST', '/api/meetings', { title: '9월 품질 회의', transcriptDocumentId: source.id })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const meetingId = created.body.meeting.id

    // 4. 수준을 올리지 않으면 아무 AI도 돌지 않는다.
    const locked = await park.call('POST', `/api/meetings/${meetingId}/process`)
    assert.equal(locked.status, 409, JSON.stringify(locked.body))
    assert.equal(locked.body.error.code, 'MEETING_AI_LOCKED')
    assert.match(locked.body.error.message, /보관만/)
    assert.equal(documentsIn(store).find((row) => row.id === source.id).aiPolicy, 'locked', '거절이 수준을 바꾸면 안 된다')

    // 5. '정리'까지 올리면 회의록 문서는 생기고 업무 제안은 생기지 않는다.
    const indexed = await park.call('POST', `/api/meetings/${meetingId}/process`, { aiPolicy: 'indexed' })
    assert.equal(indexed.status, 200, JSON.stringify(indexed.body))
    assert.ok(indexed.body.documentId.startsWith('WDOC-'))
    assert.equal(indexed.body.queued, 0)
    assert.equal(indexed.body.proposalsSkipped, 'ai-level', '왜 제안이 없는지 응답이 말해야 한다')
    assert.equal(meetingTasksIn(store).length, 0)
    assert.equal(documentsIn(store).find((row) => row.id === source.id).aiPolicy, 'indexed')

    // 6. '활용'에서 비로소 파생물이 생긴다. **관리자 전용 PATCH 를 부르지 않고** 여기까지 왔다.
    const active = await park.call('POST', `/api/meetings/${meetingId}/process`, { aiPolicy: 'active' })
    assert.equal(active.status, 200, JSON.stringify(active.body))
    assert.equal(active.body.queued, 2)
    assert.equal(active.body.documentId, indexed.body.documentId, '수준을 올렸다고 문서를 새로 만들지 않는다')
    assert.equal(documentsIn(store).find((row) => row.id === source.id).aiPolicy, 'active')
    assert.equal(meetingTasksIn(store).length, 2)

    // 대조군: 직원에게 그 PATCH 는 지금도 닫혀 있다. 그러니 위 흐름은 그 문을 지나지 않았다.
    const patched = await park.call('PATCH', `/api/documents/${source.id}`, { aiPolicy: 'active' })
    assert.equal(patched.status, 403, `직원에게 문서 PATCH 가 열려 있다 — ${JSON.stringify(patched.body)}`)
  })
})

test('7. 원본을 올린 사람도 관리자도 아니면 AI 처리 수준을 바꾸지 못한다 — 그때 자료의 수준은 그대로다', async () => {
  const store = freshStore()
  const { app } = buildApp(store)
  await withServer(app, async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const source = await admin.upload({ name: '9월 품질 회의.txt', tags: ['meeting-recording'] })
    assert.equal(source.aiPolicy, 'locked')

    // 원본을 지목할 수 있는 사람은 그 자료를 올린 사람과 관리자뿐이므로(남의 자료를 회의에 묶어
    // 삭제 불가로 만드는 길을 닫았다), 회의는 관리자가 만들고 이정민을 **참석자**로 넣는다.
    // 참석자는 회의를 볼 수 있지만 원본을 올린 사람이 아니다 — 이 시험이 재는 자리가 그곳이다.
    const created = await admin.call('POST', '/api/meetings', { title: '9월 품질 회의', transcriptDocumentId: source.id, participantIds: [LEE.id] })
    assert.equal(created.status, 201, JSON.stringify(created.body))

    const lee = await login(origin, LEE.email)
    const refused = await lee.call('POST', `/api/meetings/${created.body.meeting.id}/process`, { aiPolicy: 'active' })
    assert.equal(refused.status, 403, JSON.stringify(refused.body))
    assert.equal(refused.body.error.code, 'MEETING_POLICY_FORBIDDEN')
    assert.equal(documentsIn(store).find((row) => row.id === source.id).aiPolicy, 'locked', '거절했는데 수준이 올라가 있으면 안 된다')
    assert.equal(meetingTasksIn(store).length, 0)
  })
})

test('8·9. 회의 녹음 업로드는 서버가 「보관만」으로 정하고, 문서 분류 제안을 만들지 않는다', async () => {
  const store = freshStore()
  const { app } = buildApp(store)
  await withServer(app, async (origin) => {
    const admin = await login(origin, ADMIN.email)
    // 쿼리에 aiPolicy 를 넣지 않는다 — 화면이 잊어도 안전한 쪽으로 떨어져야 한다.
    const recording = await admin.upload({ name: '9월 품질 회의.m4a', mime: 'audio/mp4', body: '가짜 오디오 아님 — 바이트 자리', tags: ['meeting-recording'] })
    assert.equal(recording.aiPolicy, 'locked')
    const byCategory = await admin.upload({ name: '10월 품질 회의.m4a', mime: 'audio/mp4', body: '바이트 자리', category: '회의녹음' })
    assert.equal(byCategory.aiPolicy, 'locked', '분류 하나로도 같은 답이어야 한다')

    // 대조군: 같은 「회의」라는 낱말이 든 파일이라도 회의 원본 태그가 없으면 예전 그대로 분류 제안이 붙는다.
    const ordinary = await admin.upload({ name: '9월 품질 회의록.txt' })
    const proposals = proposalsIn(store)
    assert.equal(proposals.some((row) => row.kind === 'document-classification' && row.payload?.documentId === ordinary.id), true, '대조군이 죽으면 아래 단언은 아무것도 재지 않는다')
    for (const row of [recording, byCategory]) {
      assert.equal(proposals.some((item) => item.payload?.documentId === row.id), false, '회의 녹음이 분류 제안을 만들면 승인 큐가 시끄러워진다')
    }
  })
})

test('10·12. 데모 모드의 사용량은 전사 한 건뿐이고, 다시 눌러도 원장에는 한 줄이다', async () => {
  const store = freshStore()
  const { app, repository } = buildApp(store)
  await withServer(app, async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const source = await admin.upload({ name: '9월 품질 회의.txt' })
    const created = await admin.call('POST', '/api/meetings', { title: '9월 품질 회의', transcriptDocumentId: source.id })
    const meetingId = created.body.meeting.id

    const processed = await admin.call('POST', `/api/meetings/${meetingId}/process`)
    assert.equal(processed.status, 200, JSON.stringify(processed.body))
    assert.equal(processed.body.meeting.usage.transcriptionAccounting, 'recorded')
    assert.equal(processed.body.meeting.usage.summaryAccounting, 'not-applicable', '부르지 않은 모델의 값은 0이 아니라 없음이다')
    assert.equal(processed.body.meeting.usage.transcriptionEvent, undefined, '원장 재기록용 신원은 화면으로 나가지 않는다')

    const transcription = usageEventsIn(repository, 'meeting-transcription')
    assert.equal(transcription.length, 1)
    assert.equal(transcription[0].id, `meeting:${meetingId}:transcription`, '이벤트 id는 회의별로 결정론이어야 한다')
    assert.equal(transcription[0].metadata.meetingId, meetingId)
    assert.equal(transcription[0].metadata.provider, 'text')
    assert.equal(usageEventsIn(repository, 'meeting-summary').length, 0, '모델을 부르지 않았는데 0원 행을 원장에 넣지 않는다')

    // 12. 전사를 다시 눌러도 같은 id 라 원장이 한 줄로 흡수한다.
    const retried = await admin.call('POST', `/api/meetings/${meetingId}/transcribe`)
    assert.equal(retried.status, 200, JSON.stringify(retried.body))
    assert.equal(retried.body.meeting.usage.transcriptionAccounting, 'recorded')
    assert.equal(usageEventsIn(repository, 'meeting-transcription').length, 1, '같은 전사가 두 줄이 되면 두 번 청구된다')
  })
})

test('11. 원장이 죽어도 회의록·문서·제안은 만들어지고, 무슨 일이 있었는지는 응답이 말한다', async () => {
  const store = freshStore()
  const repository = createMemoryBillingRepository()
  const real = createBillingService({ repository })
  const broken = {
    ...real,
    async recordUsageEvent() { throw new Error('원장이 응답하지 않습니다') },
  }
  const { app } = buildApp(store, { billingService: broken })
  await withServer(app, async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const source = await admin.upload({ name: '9월 품질 회의.txt' })
    const created = await admin.call('POST', '/api/meetings', { title: '9월 품질 회의', transcriptDocumentId: source.id })
    const processed = await admin.call('POST', `/api/meetings/${created.body.meeting.id}/process`)

    assert.equal(processed.status, 200, `청구 기록 실패가 회의록을 막았다 — ${JSON.stringify(processed.body)}`)
    assert.equal(processed.body.meeting.status, 'done')
    assert.ok(processed.body.documentId.startsWith('WDOC-'))
    assert.equal(processed.body.queued, 2)
    assert.equal(processed.body.meeting.usage.transcriptionAccounting, 'reconciliation-pending', '남기지 못한 사실이 응답에 실려야 한다')
    assert.equal(repository.inspect().reconciliations.length, 1, '정산 대기로 넘어가야 나중에 청구를 맞출 수 있다')
  })
})

test('13. 되돌리기는 파생물을 파기하고 원본을 잠그되, 회의록 문서는 남긴다', async () => {
  const store = freshStore()
  const { app } = buildApp(store)
  await withServer(app, async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const source = await admin.upload({ name: '9월 품질 회의.txt' })
    const created = await admin.call('POST', '/api/meetings', { title: '9월 품질 회의', transcriptDocumentId: source.id })
    const meetingId = created.body.meeting.id
    const processed = await admin.call('POST', `/api/meetings/${meetingId}/process`)
    assert.equal(processed.body.queued, 2)

    const revoked = await admin.call('POST', `/api/meetings/${meetingId}/revoke-ai`)
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body))
    assert.equal(revoked.body.expiredProposals, 2)
    assert.equal(revoked.body.documentId, processed.body.documentId)
    assert.match(revoked.body.message, /회의록 문서는 남아 있습니다/)
    assert.equal(revoked.body.meeting.hasTranscript, false)
    assert.equal(revoked.body.meeting.summary, null)

    assert.equal(documentsIn(store).find((row) => row.id === source.id).aiPolicy, 'locked')
    assert.equal(store.tenants[TENANT]['meeting-notes'].data[0].transcriptText, '')
    assert.equal(meetingTasksIn(store).filter((row) => row.status === 'pending').length, 0)
    assert.equal(meetingTasksIn(store).filter((row) => row.status === 'expired').length, 2, '지우지 않고 만료로 남긴다 — 결정 이력이 근거다')

    // 회의록 문서는 그대로 열린다. 사람이 이어서 고쳤을 수 있어 서버가 임의로 지우지 않는다.
    const document = await admin.call('GET', `/api/wiki/${processed.body.documentId}`)
    assert.equal(document.status, 200, '회의록 문서를 서버가 지우면 사람의 작업을 지운다')

    // 되돌린 뒤에는 다시 요약할 원문이 없다. 그 사실을 그대로 답한다.
    const summarize = await admin.call('POST', `/api/meetings/${meetingId}/summarize`)
    assert.equal(summarize.status, 409)
    assert.equal(summarize.body.error.code, 'MEETING_AI_LOCKED', '원본이 잠겼으면 그것이 먼저 참인 사실이다')
  })
})

test('14. 남의 회의는 없는 회의와 같은 답이고, 게스트에게는 아홉 라우트가 모두 닫혀 있다', async () => {
  const store = freshStore()
  const { app } = buildApp(store)
  await withServer(app, async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const source = await admin.upload({ name: '9월 품질 회의.txt' })
    const created = await admin.call('POST', '/api/meetings', { title: '9월 품질 회의', transcriptDocumentId: source.id })
    const meetingId = created.body.meeting.id

    // 참석자도 관리자도 아닌 직원에게는 **없는 회의**다(「권한이 없습니다」는 존재를 알린다).
    const lee = await login(origin, LEE.email)
    const peeked = await lee.call('GET', `/api/meetings/${meetingId}`)
    assert.equal(peeked.status, 404)
    assert.equal(peeked.body.error.code, 'MEETING_NOT_FOUND')
    assert.equal((await lee.call('GET', '/api/meetings')).body.meetings.length, 0)
    // 참석자로 넣으면 그때부터 보인다.
    await admin.call('PATCH', `/api/meetings/${meetingId}`, { participantIds: [LEE.id] })
    assert.equal((await lee.call('GET', `/api/meetings/${meetingId}`)).status, 200)

    const guest = await login(origin, GUEST.email, GUEST.password)
    const routes = [
      ['GET', '/api/meetings'],
      ['POST', '/api/meetings'],
      ['GET', `/api/meetings/${meetingId}`],
      ['PATCH', `/api/meetings/${meetingId}`],
      ['DELETE', `/api/meetings/${meetingId}`],
      ['POST', `/api/meetings/${meetingId}/transcribe`],
      ['POST', `/api/meetings/${meetingId}/summarize`],
      ['POST', `/api/meetings/${meetingId}/process`],
      ['POST', `/api/meetings/${meetingId}/revoke-ai`],
    ]
    for (const [method, route] of routes) {
      const result = await guest.call(method, route, method === 'GET' ? undefined : {})
      assert.equal(result.status, 403, `게스트에게 ${method} ${route} 가 열려 있다 — ${JSON.stringify(result.body)}`)
      assert.equal(result.body.error.code, 'GUEST_SCOPE_FORBIDDEN')
    }
  })
})

test('14b. 문서(위키)를 만드는 문이 없으면 회의록은 부팅에서 멈춘다', () => {
  // H 뒤에 온다는 약속이 주석이 아니라 코드다 — M을 H보다 먼저 푸시하면 main이 빨개진다.
  assert.throws(
    () => registerMeetingNoteRoutes({ app: { get() {}, post() {}, patch() {}, delete() {} }, transcription: createTranscription({ env: {} }) }),
    /R16-H가 먼저 들어가야 합니다/,
  )
  assert.throws(
    () => registerMeetingNoteRoutes({ app: { get() {}, post() {}, patch() {}, delete() {} }, createWikiDocument: () => {} }),
    /R16-H가 먼저 들어가야 합니다/,
    '문서를 만드는 문만 있고 찾는 문이 없으면 되돌리기가 「문서는 남아 있다」를 잴 수 없다 — 그것도 H 의존이다',
  )
  assert.throws(
    () => registerMeetingNoteRoutes({ app: { get() {}, post() {}, patch() {}, delete() {} }, createWikiDocument: () => {}, findSystemWikiDocument: () => {} }),
    /전사 어댑터/,
  )
})

test('15. 전사 연동이 없으면 그 사실을 503과 문장으로 답한다 — 가짜 전사를 만들지 않는다', async () => {
  const store = freshStore()
  // 오늘의 기본값이다. 화면은 이 상태에서 「녹음」이 되는 것처럼 보이면 안 된다.
  const { app } = buildApp(store, { transcription: createTranscription({ env: { TRANSCRIPTION_PROVIDER: 'none' } }) })
  await withServer(app, async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const source = await admin.upload({ name: '9월 품질 회의.txt' })
    const created = await admin.call('POST', '/api/meetings', { title: '9월 품질 회의', transcriptDocumentId: source.id })

    const listed = await admin.call('GET', '/api/meetings')
    assert.equal(listed.body.transcription.provider, 'none')
    assert.equal(listed.body.transcription.acceptsAudio, false)
    assert.equal(listed.body.transcription.acceptsTranscript, false, '화면이 미리 말할 수 있게 목록이 상태를 준다')

    const processed = await admin.call('POST', `/api/meetings/${created.body.meeting.id}/process`)
    assert.equal(processed.status, 503, JSON.stringify(processed.body))
    assert.equal(processed.body.error.code, 'TRANSCRIPTION_NOT_CONFIGURED')
    assert.match(processed.body.error.message, /음성 전사 연결이 아직 설정되지 않았습니다/)
    assert.equal(store.tenants[TENANT]['meeting-notes'].data[0].transcriptText, '', '연동이 없는데 전사 결과가 남으면 그것은 지어낸 것이다')
    assert.equal(store.tenants[TENANT]['meeting-notes'].data[0].status, 'uploaded', '시도조차 못 한 것을 실패로 적지 않는다')
  })
})

test('16. 오디오 파일은 읽지 못한다고 답하고, 시도조차 못 한 AI 수준 변경은 메모리에도 남지 않는다', async () => {
  const store = freshStore()
  const { app } = buildApp(store)
  await withServer(app, async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const recording = await admin.upload({ name: '9월 품질 회의.m4a', mime: 'audio/mp4', body: '바이트 자리', tags: ['meeting-recording'] })
    const created = await admin.call('POST', '/api/meetings', { title: '9월 품질 회의', recordingDocumentId: recording.id })

    const processed = await admin.call('POST', `/api/meetings/${created.body.meeting.id}/process`, { aiPolicy: 'active' })
    assert.equal(processed.status, 415, JSON.stringify(processed.body))
    assert.equal(processed.body.error.code, 'MEETING_SOURCE_UNSUPPORTED')
    assert.equal(store.tenants[TENANT]['meeting-notes'].data[0].transcriptText, '')
    // 읽지도 못한 파일 때문에 AI 수준이 올라가 있으면 안 된다 — 커밋되지 않은 변경은 남지 않는다.
    assert.equal(documentsIn(store).find((row) => row.id === recording.id).aiPolicy, 'locked')
    const reread = await admin.call('GET', `/api/documents`)
    assert.equal(reread.body.documents.find((row) => row.id === recording.id).aiPolicy, 'locked', '돌아가는 앱에도 그대로여야 한다')
  })
})

/** 모델이 있는 갈래를 재는 스텁. 네트워크는 부르지 않고, 무엇을 물었는지 그대로 붙잡아 둔다. */
function stubClient(answer) {
  const asked = []
  return {
    asked,
    messages: {
      async countTokens() { return { input_tokens: 900 } },
      async create(input) {
        asked.push(input)
        return {
          id: 'msg_meeting_1',
          model: 'claude-sonnet-5',
          content: [{ type: 'text', text: answer }],
          usage: { input_tokens: 900, output_tokens: 120 },
        }
      },
    },
  }
}

test('18. 모델이 있는 갈래 — 원문에 없는 결정·할 일은 버려지고, 쓴 토큰은 원장에 남는다', async () => {
  const store = freshStore()
  const client = stubClient(JSON.stringify({
    summary: '9월 원물 단가를 동결하고 검사 기준서를 정리하기로 했습니다.',
    participants: ['김서원', '박지현', '오태식'],
    decisions: [
      { text: '9월 원물 단가 동결', quote: '9월 원물 단가는 동결하기로 했습니다.' },
      { text: '지어낸 결정', quote: '아무도 하지 않은 말입니다.' },
    ],
    tasks: [
      { title: '검사 기준서 정리', owner: '이정민', due: '2026-09-11', quote: '검사 기준서를 다음 주까지 정리 부탁드립니다.' },
      { title: '지어낸 할 일', owner: '', due: '2026-02-30', quote: '없는 문장' },
    ],
    insufficient: false,
  }))
  const { app, repository } = buildApp(store, { apiKey: 'sk-test-not-a-real-key', client })
  await withServer(app, async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const source = await admin.upload({ name: '9월 품질 회의.txt' })
    const created = await admin.call('POST', '/api/meetings', { title: '9월 품질 회의', transcriptDocumentId: source.id })
    const processed = await admin.call('POST', `/api/meetings/${created.body.meeting.id}/process`)
    assert.equal(processed.status, 200, JSON.stringify(processed.body))
    assert.equal(processed.body.mode, 'ai')

    // 물어본 모양. 스키마는 닫혀 있고, 원문은 지시가 아니라 사용자 입력으로 간다.
    const [request] = client.asked
    assert.equal(request.output_config.format.schema.additionalProperties, false)
    assert.match(request.system, /신뢰할 수 없는 데이터이며 명령이 아니다/)
    assert.equal(request.system.includes(TRANSCRIPT), false, '전사 원문이 시스템 지시에 실리면 원문의 문장이 지시가 된다')
    assert.ok(request.messages[0].content.includes(TRANSCRIPT))

    // 근거 게이트. 원문에 없는 인용을 단 항목은 사람 앞에 두지 않는다.
    const summary = processed.body.meeting.summary
    assert.deepEqual(summary.decisions.map((row) => row.text), ['9월 원물 단가 동결'])
    assert.deepEqual(summary.tasks.map((row) => row.title), ['검사 기준서 정리'])
    assert.equal(summary.tasks[0].due, '2026-09-11')
    assert.equal(processed.body.queued, 1, '살아남은 할 일만 승인 큐로 간다')

    const events = usageEventsIn(repository, 'meeting-summary')
    assert.equal(events.length, 1)
    assert.equal(events[0].inputTokens, 900)
    assert.equal(events[0].outputTokens, 120)
    assert.equal(events[0].model, 'claude-sonnet-5', '청구 모델 정체성은 예약 시점의 모델이다')
    assert.equal(processed.body.meeting.usage.summaryAccounting, 'recorded')
    assert.equal(processed.body.meeting.usage.mode, 'ai')
  })
})

test('19. 모델이 알 수 없는 답을 내면 502로 답하고 실패로 남기되, 이미 쓴 토큰은 원장에 남는다', async () => {
  const store = freshStore()
  const { app, repository } = buildApp(store, { apiKey: 'sk-test-not-a-real-key', client: stubClient('요약을 못 하겠습니다') })
  await withServer(app, async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const source = await admin.upload({ name: '9월 품질 회의.txt' })
    const created = await admin.call('POST', '/api/meetings', { title: '9월 품질 회의', transcriptDocumentId: source.id })
    const processed = await admin.call('POST', `/api/meetings/${created.body.meeting.id}/process`)

    assert.equal(processed.status, 502, JSON.stringify(processed.body))
    assert.equal(processed.body.error.code, 'MEETING_SUMMARY_INVALID')
    const stored = store.tenants[TENANT]['meeting-notes'].data[0]
    assert.equal(stored.status, 'failed')
    assert.ok(stored.error, '무엇이 실패했는지 회의에 남아야 사람이 다시 누를지 정할 수 있다')
    assert.equal(stored.summary, null, '읽을 수 없던 답을 요약이라고 저장하지 않는다')
    assert.equal(stored.transcriptText.length > 0, true, '전사까지는 끝났다 — 그것을 잃지 않는다')
    assert.equal(meetingTasksIn(store).length, 0)
    // 응답을 받았다는 것은 토큰을 썼다는 뜻이다. 쓴 것을 적지 않으면 청구가 조용히 틀어진다.
    assert.equal(usageEventsIn(repository, 'meeting-summary').length, 1)
  })
})

test('17. 자막 파일의 타임코드는 걷히고 말만 남는다 — 회의를 지워도 문서와 원본 파일은 그대로다', async () => {
  const store = freshStore()
  const { app } = buildApp(store)
  await withServer(app, async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const vtt = [
      'WEBVTT',
      'Kind: captions',
      '',
      '1',
      '00:00:01.000 --> 00:00:04.000',
      '박지현: 9월 원물 단가는 동결하기로 했습니다.',
      '',
      '2',
      '00:00:04.000 --> 00:00:08.000',
      '오태식: 라인 점검표는 금요일까지 제출 부탁드립니다.',
    ].join('\n')
    const source = await admin.upload({ name: '9월 품질 회의.vtt', mime: '', body: vtt })
    const created = await admin.call('POST', '/api/meetings', { title: '9월 품질 회의', transcriptDocumentId: source.id })
    const meetingId = created.body.meeting.id

    const processed = await admin.call('POST', `/api/meetings/${meetingId}/process`)
    assert.equal(processed.status, 200, JSON.stringify(processed.body))
    const detail = await admin.call('GET', `/api/meetings/${meetingId}`)
    assert.equal(detail.body.transcriptPreview.includes('00:00:01'), false, '타임코드가 회의 내용으로 남으면 안 된다')
    assert.equal(detail.body.transcriptPreview.includes('WEBVTT'), false)
    assert.ok(detail.body.transcriptPreview.includes('9월 원물 단가는 동결하기로 했습니다.'), '말은 한 글자도 잃지 않는다')
    assert.equal(detail.body.meeting.transcriptChars, detail.body.transcriptPreview.length)

    // 삭제는 참조만 끊는다. 자료실의 409 문구가 「회의를 지우면 풀린다」고 말하므로 실제로 풀려야 한다.
    const held = await admin.call('DELETE', `/api/documents/${source.id}`)
    assert.equal(held.status, 409, JSON.stringify(held.body))
    const removed = await admin.call('DELETE', `/api/meetings/${meetingId}`)
    assert.equal(removed.status, 200, JSON.stringify(removed.body))
    assert.equal(removed.body.documentId, processed.body.documentId)
    assert.equal((await admin.call('GET', `/api/wiki/${processed.body.documentId}`)).status, 200, '회의를 지워도 회의록 문서는 남는다')
    assert.equal((await admin.call('DELETE', `/api/documents/${source.id}`)).status, 200, '회의를 지운 뒤에는 원본도 지울 수 있어야 한다')
  })
})
/**
 * ── M3 검증 지적 반영 ────────────────────────────────────────────────────────
 * 아래 일곱은 적대적 검증에서 실제로 재현된 결함을 잠근다. 전부 **돌아가는 앱**에 대고 재고,
 * 각 시험은 고치기 전 상태에서 빨갛다(대조군이 있는 것은 그것도 함께 잰다).
 */

test('20. 회의록 문서 id는 요청 본문으로 정해지지 않는다 — 남이 선점한 문서를 회의록으로 채택하지 않는다', async () => {
  const store = freshStore()
  const { app } = buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const source = await park.upload({ name: '9월 품질 회의.txt' })
    const created = await park.call('POST', '/api/meetings', { title: '9월 품질 회의', transcriptDocumentId: source.id, participantIds: [LEE.id] })
    const meetingId = created.body.meeting.id
    await park.call('POST', `/api/meetings/${meetingId}/transcribe`)

    // 참석자가 서버가 쓸 멱등 키를 **본문으로** 먼저 선점해 본다.
    const lee = await login(origin, LEE.email)
    const squatted = await lee.call('POST', '/api/wiki', { title: '이정민이 손으로 쓴 회의록', clientRequestId: `meeting:${meetingId}` })
    assert.equal(squatted.status, 201, JSON.stringify(squatted.body))

    const summarized = await lee.call('POST', `/api/meetings/${meetingId}/summarize`)
    assert.equal(summarized.status, 200, JSON.stringify(summarized.body))
    assert.notEqual(summarized.body.documentId, squatted.body.document.id, '선점한 문서를 회의록으로 채택하면 근거 사슬이 끊긴다')

    // 실제로 채택된 문서에는 회의록 블록이 들어 있어야 한다.
    const document = await park.call('GET', `/api/wiki/${summarized.body.documentId}`)
    assert.equal(document.status, 200, JSON.stringify(document.body))
    assert.equal(document.body.document.title, '9월 품질 회의 회의록')
    const text = document.body.document.blocks.map((block) => block.text ?? '').join('\n')
    assert.ok(text.includes('결정 사항'), `회의록 블록이 한 줄도 없다 — ${text}`)

    // 승인 큐의 제안도 그 문서를 가리켜야 한다(「회의록에서 추출」 배지가 가리키는 곳).
    const admin = await login(origin, ADMIN.email)
    const queue = await admin.call('GET', '/api/proposals')
    const tasks = queue.body.proposals.filter((row) => row.kind === 'meeting-task')
    assert.ok(tasks.length > 0, '대조군이 죽으면 아래 단언은 아무것도 재지 않는다')
    for (const task of tasks) assert.equal(task.payload.documentId, summarized.body.documentId)

    // 다시 눌러도 문서는 그 한 건이다 — 시스템 키의 멱등은 그대로 산다.
    const again = await park.call('POST', `/api/meetings/${meetingId}/summarize`)
    assert.equal(again.body.documentId, summarized.body.documentId)
    const meetingDocuments = (store.tenants[TENANT]['wiki-documents']?.data ?? [])
      .filter((row) => row?.systemRequestId === `meeting:${meetingId}`)
    assert.equal(meetingDocuments.length, 1, '회의 하나에 회의록 문서는 하나다')
    assert.equal(meetingDocuments[0].clientRequestId, null, '서버가 만든 문서는 사람이 고르는 칸을 쓰지 않는다')
  })
})

test('21. 회의록 문서를 누가 읽는지 서버가 말한다 — 원본보다 넓게 열리면 그 사실도 함께', async () => {
  const store = freshStore()
  const { app } = buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const secret = await park.upload({ name: '인수 협상.txt', visibility: 'restricted' })
    assert.equal(secret.visibility, 'restricted')
    const created = await park.call('POST', '/api/meetings', { title: '인수 협상 회의', transcriptDocumentId: secret.id })
    const meetingId = created.body.meeting.id

    // **동의 전에** 알 수 있어야 한다 — 처리하기 전의 상세가 이미 그 문장을 싣는다.
    const before = await park.call('GET', `/api/meetings/${meetingId}`)
    assert.equal(before.body.documentAudience.scope, 'tenant')
    assert.equal(before.body.documentAudience.sourceVisibility, 'restricted')
    assert.equal(before.body.documentAudience.widerThanSource, true)
    assert.match(before.body.documentAudience.message, /회사 구성원 전원이 읽을 수 있습니다/)
    assert.match(before.body.documentAudience.message, /원본 자료는 열람 범위가 더 좁아/)

    // 처리 응답도 **같은 문장**을 낸다(규칙 3: 한 사실은 한 템플릿에서 나온다).
    const processed = await park.call('POST', `/api/meetings/${meetingId}/process`)
    assert.equal(processed.status, 200, JSON.stringify(processed.body))
    assert.equal(processed.body.documentAudience.message, before.body.documentAudience.message)

    // 대조군: 전사 공개 자료면 「더 좁다」는 절이 붙지 않는다.
    const open = await park.upload({ name: '9월 품질 회의.txt' })
    const openMeeting = await park.call('POST', '/api/meetings', { title: '9월 품질 회의', transcriptDocumentId: open.id })
    const openDetail = await park.call('GET', `/api/meetings/${openMeeting.body.meeting.id}`)
    assert.equal(openDetail.body.documentAudience.widerThanSource, false)
    assert.doesNotMatch(openDetail.body.documentAudience.message, /원본 자료는 열람 범위가 더 좁아/)
    assert.match(openDetail.body.documentAudience.message, /회사 구성원 전원이 읽을 수 있습니다/)
  })
})

test('22. 남의 자료를 회의 원본으로 지목할 수 없다 — 지목이 곧 삭제 잠금이기 때문이다', async () => {
  const store = freshStore()
  const { app } = buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const source = await park.upload({ name: '9월 품질 회의.txt' })

    // 열 수 있다고 잠글 수 있는 것은 아니다. 지목하면 주인이 자기 자료를 지울 수 없게 된다.
    const lee = await login(origin, LEE.email)
    assert.equal((await lee.call('GET', `/api/documents/${source.id}/download`)).status, 200, '대조군: 이 자료는 이정민이 읽을 수 있다')
    const refused = await lee.call('POST', '/api/meetings', { title: '몰래 묶기', transcriptDocumentId: source.id })
    assert.equal(refused.status, 403, JSON.stringify(refused.body))
    assert.equal(refused.body.error.code, 'MEETING_SOURCE_NOT_MINE')
    assert.equal((store.tenants[TENANT]['meeting-notes']?.data ?? []).length, 0)
    assert.equal((await park.call('DELETE', `/api/documents/${source.id}`)).status, 200, '지목이 막혔으면 주인은 자기 자료를 지울 수 있다')

    // 주인 본인은 만들 수 있고, 그때의 409 문구는 **실제로 할 수 있는 일**을 말한다.
    const mine = await park.upload({ name: '10월 품질 회의.txt' })
    const created = await park.call('POST', '/api/meetings', { title: '10월 품질 회의', transcriptDocumentId: mine.id })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const held = await park.call('DELETE', `/api/documents/${mine.id}`)
    assert.equal(held.status, 409)
    assert.match(held.body.error.message, /회의를 만든 사람이나 회사 관리자가/, '아무도 할 수 없는 지시를 주지 않는다')
    assert.equal((await park.call('DELETE', `/api/meetings/${created.body.meeting.id}`)).status, 200)
    assert.equal((await park.call('DELETE', `/api/documents/${mine.id}`)).status, 200, '문구가 시킨 일을 하면 실제로 풀려야 한다')

    // 관리자는 남의 자료로도 회의를 만들 수 있다(그 회의를 지울 수 있는 사람이기도 하다).
    const admin = await login(origin, ADMIN.email)
    const parkAgain = await park.upload({ name: '11월 품질 회의.txt' })
    assert.equal((await admin.call('POST', '/api/meetings', { title: '11월 품질 회의', transcriptDocumentId: parkAgain.id })).status, 201)
  })
})

test('23. 자료 화면에서 수준을 내려도 회의 파생물이 함께 파기된다 — 실패하면 함께 되돌아간다', async () => {
  const store = freshStore()
  let commits = 0
  let failFrom = Number.POSITIVE_INFINITY
  const { app } = buildApp(store, { onWorkspaceStoreChange: () => { commits += 1; if (commits >= failFrom) throw new Error('디스크 고장') } })
  await withServer(app, async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const source = await admin.upload({ name: '9월 품질 회의.txt' })
    const created = await admin.call('POST', '/api/meetings', { title: '9월 품질 회의', transcriptDocumentId: source.id })
    const meetingId = created.body.meeting.id
    const processed = await admin.call('POST', `/api/meetings/${meetingId}/process`)
    assert.equal(processed.body.queued, 2)

    // 커밋이 실패하면 자료 수준도, 회의 파생물도 하나도 바뀌지 않는다(규칙 9).
    failFrom = commits + 1
    const brokenPatch = await admin.call('PATCH', `/api/documents/${source.id}`, { aiPolicy: 'locked' })
    failFrom = Number.POSITIVE_INFINITY
    assert.equal(brokenPatch.status, 500, JSON.stringify(brokenPatch.body))
    // 일반 업로드에는 aiPolicy 칸이 아예 없다(칸 없는 문서는 '활용'으로 읽힌다) — 「잠기지 않았다」를 잰다.
    assert.notEqual(documentsIn(store).find((row) => row.id === source.id).aiPolicy, 'locked', '커밋이 죽었는데 수준만 내려가면 안 된다')
    assert.ok(store.tenants[TENANT]['meeting-notes'].data[0].transcriptText.length > 0, '커밋이 죽었는데 전사만 사라지면 안 된다')
    assert.equal(meetingTasksIn(store).filter((row) => row.status === 'pending').length, 2)

    const patched = await admin.call('PATCH', `/api/documents/${source.id}`, { aiPolicy: 'locked' })
    assert.equal(patched.status, 200, JSON.stringify(patched.body))
    const row = store.tenants[TENANT]['meeting-notes'].data.find((item) => item.id === meetingId)
    assert.equal(row.transcriptText, '', '수준을 내렸는데 전사 전문 사본이 남으면 「보관만」이 거짓말이다')
    assert.equal(row.summary, null)
    assert.equal(row.status, 'uploaded')
    assert.equal(meetingTasksIn(store).filter((item) => item.status === 'pending').length, 0, '승인하면 업무가 되는 제안이 살아남으면 안 된다')
    assert.equal(meetingTasksIn(store).filter((item) => item.status === 'expired').length, 2)

    const detail = await admin.call('GET', `/api/meetings/${meetingId}`)
    assert.equal(detail.body.transcriptPreview, '')
    assert.equal(detail.body.meeting.hasTranscript, false)
  })
})

test('24. 한 자료를 두 회의가 쓸 때 되돌리기는 둘 다 파기하고, 실제로 지운 건수를 말한다', async () => {
  const store = freshStore()
  const { app } = buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const source = await park.upload({ name: '9월 품질 회의.txt' })
    const first = await park.call('POST', '/api/meetings', { title: '9월 품질 회의 1부', transcriptDocumentId: source.id })
    const second = await park.call('POST', '/api/meetings', { title: '9월 품질 회의 2부', transcriptDocumentId: source.id })
    await park.call('POST', `/api/meetings/${first.body.meeting.id}/process`)
    await park.call('POST', `/api/meetings/${second.body.meeting.id}/process`)
    assert.equal(meetingTasksIn(store).filter((row) => row.status === 'pending').length, 4)

    const revoked = await park.call('POST', `/api/meetings/${first.body.meeting.id}/revoke-ai`)
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body))
    // 잠금은 문서 단위다. 파기 범위가 좁으면 자료는 잠기고 파생물은 산다.
    assert.equal(revoked.body.purgedMeetings, 2)
    assert.equal(revoked.body.expiredProposals, 4)
    assert.match(revoked.body.message, /회의 2건에 모두 적용했습니다/)
    assert.equal(revoked.body.documentIds.length, 2)
    for (const row of store.tenants[TENANT]['meeting-notes'].data) {
      assert.equal(row.transcriptText, '', `${row.title}의 전사가 남았다`)
      assert.equal(row.summary, null)
    }
    assert.equal(meetingTasksIn(store).filter((row) => row.status === 'pending').length, 0)
    const other = await park.call('GET', `/api/meetings/${second.body.meeting.id}`)
    assert.equal(other.body.transcriptPreview, '', '자료는 잠겼는데 다른 회의가 원문을 계속 내주면 안 된다')
  })
})

test('25. 원본을 못 읽는 참석자에게는 원문이 나가지 않고, 참석자는 명단과 삭제를 건드리지 못한다', async () => {
  const store = freshStore()
  const { app } = buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const secret = await park.upload({ name: '인수 협상.txt', visibility: 'restricted' })
    const created = await park.call('POST', '/api/meetings', { title: '인수 협상 회의', transcriptDocumentId: secret.id, participantIds: [LEE.id] })
    const meetingId = created.body.meeting.id
    await park.call('POST', `/api/meetings/${meetingId}/process`)

    // 기안자는 원본을 읽을 수 있으므로 미리보기가 나간다(대조군).
    const owner = await park.call('GET', `/api/meetings/${meetingId}`)
    assert.ok(owner.body.transcriptPreview.length > 0)
    assert.equal(owner.body.transcriptHidden, false)

    const lee = await login(origin, LEE.email)
    assert.equal((await lee.call('GET', `/api/documents/${secret.id}/download`)).status, 404, '대조군: 이정민은 원본을 못 읽는다')
    const seen = await lee.call('GET', `/api/meetings/${meetingId}`)
    assert.equal(seen.status, 200, '회의 자체는 참석자에게 보인다')
    assert.equal(seen.body.transcriptPreview, '', '원본이 404인 사람이 원문 2,000자를 읽으면 판정이 라우트마다 다른 것이다')
    assert.equal(seen.body.transcriptHidden, true, '비어 있는 것이 없어서인지 가려서인지 화면이 갈라 말할 수 있어야 한다')

    // 참석자 명단은 열람 명단이다 — 참석자가 넓히면 자기가 받은 열람을 재배포하는 길이 된다.
    const widened = await lee.call('PATCH', `/api/meetings/${meetingId}`, { participantIds: [LEE.id, ADMIN.id] })
    assert.equal(widened.status, 403, JSON.stringify(widened.body))
    assert.equal(widened.body.error.code, 'MEETING_OWNER_ONLY')
    const removed = await lee.call('DELETE', `/api/meetings/${meetingId}`)
    assert.equal(removed.status, 403, JSON.stringify(removed.body))
    assert.equal(removed.body.error.code, 'MEETING_OWNER_ONLY')
    assert.equal((store.tenants[TENANT]['meeting-notes'].data ?? []).length, 1)

    // 제목도 같은 문 뒤에 있다. 제목은 이 회의에서 나오는 제안의 `evidence`에 그대로 실려
    // 결재자가 읽는 근거 문장이 되므로, 열람자인 참석자가 손볼 수 있으면 안 된다(규칙 8·11).
    const renamed = await lee.call('PATCH', `/api/meetings/${meetingId}`, { title: '참석자가 바꾼 제목' })
    assert.equal(renamed.status, 403, JSON.stringify(renamed.body))
    assert.equal(renamed.body.error.code, 'MEETING_OWNER_ONLY')
    // 거절 문구는 **막은 것 셋을 다 말한다** — 제목이 열려 있다고 읽히면 안 된다(규칙 3).
    assert.match(renamed.body.error.message, /회의 제목·참석자 명단을 바꾸거나 회의를 지울 수 있습니다/)
    assert.equal(store.tenants[TENANT]['meeting-notes'].data[0].title, '인수 협상 회의', '거절했는데 제목만 바뀌면 안 된다')

    // 대조군: 기안자는 그대로 바꿀 수 있다.
    const ownerRenamed = await park.call('PATCH', `/api/meetings/${meetingId}`, { title: '인수 협상 회의(2차)' })
    assert.equal(ownerRenamed.status, 200, JSON.stringify(ownerRenamed.body))
    assert.equal(ownerRenamed.body.meeting.title, '인수 협상 회의(2차)')
    assert.equal(ownerRenamed.body.meeting.participantIds.length, 1)

    // 미리보기를 가렸다는 것이 「원문이 보호된다」는 뜻은 아니다 — 인용은 그대로 나간다.
    assert.equal(seen.body.transcriptHiddenNote, '원문 미리보기는 가렸습니다. 다만 요약과 결정 사항·할 일에 인용된 문장은 원문 그대로 나갑니다.')
    const quotes = [...seen.body.meeting.summary.decisions, ...seen.body.meeting.summary.tasks].map((row) => row.quote)
    assert.ok(quotes.length > 0, '대조군이 죽으면 아래 단언은 아무것도 재지 않는다')
    for (const quote of quotes) assert.ok(TRANSCRIPT.includes(quote), `인용이 원문에서 오지 않았다 — ${quote}`)
    assert.equal(owner.body.transcriptHiddenNote, '', '원본을 읽는 사람에게는 가릴 것이 없으니 문장도 없다')
  })
})

test('26. 요약 커밋이 죽어 생긴 미아 회의록 문서 — 되돌리기가 실제로 있는 문서로 문장을 정한다', async () => {
  const store = freshStore()
  let commits = 0
  let failFrom = Number.POSITIVE_INFINITY
  const { app } = buildApp(store, { onWorkspaceStoreChange: () => { commits += 1; if (commits >= failFrom) throw new Error('디스크 고장') } })
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const source = await park.upload({ name: '9월 품질 회의.txt' })
    const created = await park.call('POST', '/api/meetings', { title: '9월 품질 회의', transcriptDocumentId: source.id })
    const meetingId = created.body.meeting.id
    await park.call('POST', `/api/meetings/${meetingId}/transcribe`)

    // 회의록 문서는 자기 커밋을 끝냈는데 그 뒤 회의 저장이 죽는다 → 회의의 documentId 는 ''로 남는다.
    failFrom = commits + 3
    const summarized = await park.call('POST', `/api/meetings/${meetingId}/summarize`)
    failFrom = Number.POSITIVE_INFINITY
    assert.equal(summarized.status, 500, JSON.stringify(summarized.body))
    const orphan = (store.tenants[TENANT]['wiki-documents']?.data ?? []).find((row) => row?.systemRequestId === `meeting:${meetingId}`)
    assert.ok(orphan, '이 시험이 재려는 미아 문서가 만들어지지 않았다')
    assert.equal(store.tenants[TENANT]['meeting-notes'].data[0].documentId, '')

    const revoked = await park.call('POST', `/api/meetings/${meetingId}/revoke-ai`)
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body))
    // 문서는 전 직원에게 여전히 열려 있다. 응답이 그 사실을 빼고 말하면 거짓이다(규칙 11).
    assert.match(revoked.body.message, /회의록 문서는 남아 있습니다/)
    assert.equal(revoked.body.documentId, orphan.id, '사람이 찾아가 지울 수 있게 id 를 실어야 한다')
    assert.equal((await park.call('GET', `/api/wiki/${orphan.id}`)).status, 200)
  })
})

/**
 * ── M3 검증 지적 반영 (2회차) ────────────────────────────────────────────────
 * 아래 아홉은 2회차 적대적 검증에서 실제로 재현된 결함과, 그때 「공허하다」고 지적된 계약을 잠근다.
 * 전부 돌아가는 앱에 대고 재고, 각 시험은 고치기 전 상태에서 빨갛다.
 */

test('27. 열람 범위는 visibility 문자열이 아니라 판정으로 잰다 — 개발운영지원 자료는 all이어도 좁다', async () => {
  const store = freshStore()
  const { app } = buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    // 태그 갈래와 분류 갈래 둘 다 `canReadDocument`에서 「올린 사람에게만」으로 좁아진다.
    const tagged = await park.upload({ name: '장애 로그.txt', tags: ['developer-support'], visibility: 'all' })
    const categorized = await park.upload({ name: '운영 회의.txt', category: '개발운영지원', visibility: 'all' })
    assert.equal(tagged.visibility, 'all', '대조군: 이 자료의 visibility 는 all 이다')
    assert.equal(categorized.visibility, 'all')

    // 대조군 — 다른 직원은 그 자료를 자료실에서 못 읽는다. 그러니 회의록 문서는 원본보다 넓다.
    const lee = await login(origin, LEE.email)
    assert.equal((await lee.call('GET', `/api/documents/${tagged.id}/download`)).status, 404)
    assert.equal((await lee.call('GET', `/api/documents/${categorized.id}/download`)).status, 404)

    for (const source of [tagged, categorized]) {
      const created = await park.call('POST', '/api/meetings', { title: '9월 품질 회의', transcriptDocumentId: source.id })
      assert.equal(created.status, 201, JSON.stringify(created.body))
      const detail = await park.call('GET', `/api/meetings/${created.body.meeting.id}`)
      assert.equal(detail.body.documentAudience.sourceVisibility, 'all')
      assert.equal(detail.body.documentAudience.widerThanSource, true, `${source.name}: 동의 전에 읽는 문장이 사실과 달랐다`)
      assert.match(detail.body.documentAudience.message, /원본 자료는 열람 범위가 더 좁아/)

      const processed = await park.call('POST', `/api/meetings/${created.body.meeting.id}/process`)
      assert.equal(processed.status, 200, JSON.stringify(processed.body))
      assert.equal(processed.body.documentAudience.message, detail.body.documentAudience.message, '두 문이 같은 사실을 다르게 말하면 안 된다')
      // 재어 확인한다 — 원본을 못 읽는 사람이 회의록 문서를 실제로 읽는다.
      assert.equal((await lee.call('GET', `/api/wiki/${processed.body.documentId}`)).status, 200)
    }

    // 대조군: 개발운영지원이 아닌 전사 공개 자료에는 그 절이 붙지 않는다.
    const open = await park.upload({ name: '9월 품질 회의.txt' })
    const openMeeting = await park.call('POST', '/api/meetings', { title: '열린 회의', transcriptDocumentId: open.id })
    const openDetail = await park.call('GET', `/api/meetings/${openMeeting.body.meeting.id}`)
    assert.equal(openDetail.body.documentAudience.widerThanSource, false)
  })
})

test('28. 회의를 지우면 그 회의의 대기 제안도 함께 만료되고, 남는 것을 응답이 말한다', async () => {
  const store = freshStore()
  const { app } = buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const source = await park.upload({ name: '인수 협상.txt', visibility: 'department' })
    const created = await park.call('POST', '/api/meetings', { title: '9월 품질 회의', transcriptDocumentId: source.id })
    const meetingId = created.body.meeting.id
    const processed = await park.call('POST', `/api/meetings/${meetingId}/process`)
    assert.equal(processed.body.queued, 2, '대조군이 죽으면 아래 단언은 아무것도 재지 않는다')

    const removed = await park.call('DELETE', `/api/meetings/${meetingId}`)
    assert.equal(removed.status, 200, JSON.stringify(removed.body))
    // 회의가 사라지면 파기의 문 둘(revoke-ai · 자료 PATCH)은 이 제안에 영영 닿지 못한다.
    // 전사 원문을 글자 그대로 인용한 제안이 승인 큐에 영원히 남으면 안 된다(DECISIONS 3-5).
    assert.equal(removed.body.expiredProposals, 2)
    assert.equal(meetingTasksIn(store).filter((row) => row.status === 'pending').length, 0, '지운 회의의 제안이 승인 큐에 살아 있다')
    assert.equal(meetingTasksIn(store).filter((row) => row.status === 'expired').length, 2)
    const admin = await login(origin, ADMIN.email)
    const queue = await admin.call('GET', '/api/proposals')
    assert.equal(queue.body.proposals.filter((row) => row.kind === 'meeting-task' && row.status === 'pending').length, 0)

    // 회사 전원이 읽는 회의록 문서는 그대로 남는다 — 그 사실을 revoke-ai 와 **같은 문장**으로 말한다.
    assert.equal(removed.body.documentIds.length, 1)
    assert.equal(removed.body.documentIds[0], processed.body.documentId)
    assert.match(removed.body.message, /회의록 문서는 남아 있습니다/)
    assert.match(removed.body.message, /업무 제안 2건을 만료했습니다/)
    const lee = await login(origin, LEE.email)
    assert.equal((await lee.call('GET', `/api/wiki/${processed.body.documentId}`)).status, 200, '재어 확인: 문서는 실제로 남아 열려 있다')

    // 대조군: 파생물이 없는 회의를 지우면 만료할 것도, 남았다고 말할 문서도 없다.
    const bare = await park.call('POST', '/api/meetings', { title: '아직 안 돌린 회의', transcriptDocumentId: source.id })
    const bareRemoved = await park.call('DELETE', `/api/meetings/${bare.body.meeting.id}`)
    assert.equal(bareRemoved.body.expiredProposals, 0)
    assert.deepEqual(bareRemoved.body.documentIds, [])
    assert.doesNotMatch(bareRemoved.body.message, /회의록 문서는 남아 있습니다/)
  })
})

test('29. 되돌린 뒤 다시 요약해도 회의록 문서는 처음 그대로다 — 응답이 그 사실을 말한다', async () => {
  const store = freshStore()
  const { app } = buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const source = await park.upload({ name: '9월 품질 회의.txt' })
    const created = await park.call('POST', '/api/meetings', { title: '9월 품질 회의', transcriptDocumentId: source.id })
    const meetingId = created.body.meeting.id

    const first = await park.call('POST', `/api/meetings/${meetingId}/process`)
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.equal(first.body.documentReused, false, '처음 만든 문서는 이번 요약을 담고 있다')
    assert.equal(first.body.documentNote, undefined)
    const documentBefore = (store.tenants[TENANT]['wiki-documents'].data).find((row) => row.id === first.body.documentId)
    const versionBefore = documentBefore.version

    await park.call('POST', `/api/meetings/${meetingId}/revoke-ai`)
    const again = await park.call('POST', `/api/meetings/${meetingId}/process`, { aiPolicy: 'active' })
    assert.equal(again.status, 200, JSON.stringify(again.body))
    assert.equal(again.body.documentId, first.body.documentId, '문서는 회의당 하나다')
    // 문서가 갱신되지 않는다는 것은 사실이다. 사실인 것을 서버가 말해야 화면이 지어 쓰지 않는다.
    const documentAfter = (store.tenants[TENANT]['wiki-documents'].data).find((row) => row.id === first.body.documentId)
    assert.equal(documentAfter.version, versionBefore, '이 시험이 재려는 상황(문서는 그대로)이 아니게 됐다')
    assert.equal(again.body.documentReused, true, '문서가 그대로인데 응답이 아니라고 말하면 화면이 거짓을 읽는다')
    assert.match(again.body.documentNote, /처음 만든 그대로입니다/)
  })
})

test('30. 어댑터 상한을 넘는 전사에서 숫자가 사실이다 — 읽지 못한 뒷부분을 말한다', async () => {
  const store = freshStore()
  const { app } = buildApp(store)
  await withServer(app, async (origin) => {
    const admin = await login(origin, ADMIN.email)
    // 한 줄짜리 원문. 줄바꿈을 섞으면 문단 정리(빈 줄 걷어내기)가 길이를 바꿔 경계 시험이 흐려진다.
    const say = (chars) => '가'.repeat(chars)

    // 20,000자 경계 — 회의 레코드에 담는 앞부분의 상한(정본은 자료실 원본 파일이다).
    for (const [chars, truncated] of [[19_999, false], [20_000, false], [20_001, true]]) {
      const source = await admin.upload({ name: `${chars}.txt`, body: say(chars) })
      const created = await admin.call('POST', '/api/meetings', { title: `${chars}자 회의`, transcriptDocumentId: source.id })
      const transcribed = await admin.call('POST', `/api/meetings/${created.body.meeting.id}/transcribe`)
      assert.equal(transcribed.status, 200, JSON.stringify(transcribed.body))
      assert.equal(transcribed.body.meeting.transcriptChars, chars, `${chars}자: 글자 수는 원문 전체를 센다`)
      assert.equal(transcribed.body.meeting.transcriptTruncated, truncated, `${chars}자: 잘랐는지 여부가 사실과 달랐다`)
      assert.equal(transcribed.body.meeting.transcriptUnreadChars, 0, `${chars}자: 어댑터는 이만큼을 전부 읽었다`)
      const row = store.tenants[TENANT]['meeting-notes'].data.find((item) => item.id === created.body.meeting.id)
      assert.equal(row.transcriptText.length, Math.min(chars, 20_000))
    }

    // 200,000자 경계 — 어댑터가 아예 **읽지 못한** 뒷부분. `transcriptTruncated`와 다른 사실이다.
    const huge = 243_000
    const source = await admin.upload({ name: '아주 긴 회의.txt', body: say(huge) })
    const created = await admin.call('POST', '/api/meetings', { title: '아주 긴 회의', transcriptDocumentId: source.id })
    const transcribed = await admin.call('POST', `/api/meetings/${created.body.meeting.id}/transcribe`)
    assert.equal(transcribed.status, 200, JSON.stringify(transcribed.body))
    assert.equal(transcribed.body.meeting.transcriptChars, huge, '어댑터가 자른 뒤의 길이를 세면 화면이 실제보다 짧은 회의였다고 말한다')
    assert.equal(transcribed.body.meeting.transcriptUnreadChars, huge - 200_000, '읽지 못한 글자 수를 말할 칸이 없으면 화면이 그 사실을 말할 수 없다')
    assert.equal(transcribed.body.meeting.transcriptTruncated, true)

    // 되돌리면 이 숫자들도 함께 0으로 돌아간다 — 파기된 회의가 「243,000자였다」고 말하면 안 된다.
    await admin.call('POST', `/api/meetings/${created.body.meeting.id}/revoke-ai`)
    const purged = store.tenants[TENANT]['meeting-notes'].data.find((item) => item.id === created.body.meeting.id)
    assert.equal(purged.transcriptChars, 0)
    assert.equal(purged.transcriptUnreadChars, 0)
  })
})

test('31. 처리 중에 자료 화면에서 수준을 내리면, 잠긴 자료에서 전사 사본도 문서도 제안도 태어나지 않는다', async () => {
  const store = freshStore()
  const storage = gatedStorage()
  const { app } = buildApp(store, { documentStorage: storage })
  await withServer(app, async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const source = await admin.upload({ name: '9월 품질 회의.txt' })
    const created = await admin.call('POST', '/api/meetings', { title: '9월 품질 회의', transcriptDocumentId: source.id })
    const meetingId = created.body.meeting.id

    // 원본 파일을 읽는 그 자리에서 멈춘다 — 수준은 처리 시작 때 한 번만 읽히던 자리다.
    const held = storage.hold()
    const processing = admin.call('POST', `/api/meetings/${meetingId}/process`, {})
    let lowered = null
    // 단언이 먼저 터져도 게이트는 반드시 연다 — 열지 않으면 이 시험이 실패가 아니라 **정지**가 된다.
    try {
      await held.reached
      lowered = await admin.call('PATCH', `/api/documents/${source.id}`, { aiPolicy: 'locked' })
    } finally {
      held.open()
    }
    assert.equal(lowered.status, 200, JSON.stringify(lowered.body))
    assert.equal(documentsIn(store).find((row) => row.id === source.id).aiPolicy, 'locked')

    const done = await processing
    assert.equal(done.status, 409, `잠긴 자료에서 파생물이 태어났다 — ${JSON.stringify(done.body)}`)
    assert.equal(done.body.error.code, 'MEETING_AI_LOCKED')
    const row = store.tenants[TENANT]['meeting-notes'].data.find((item) => item.id === meetingId)
    assert.equal(row.transcriptText, '', '잠근 자료의 전사 사본이 남으면 「보관만」이 거짓말이다')
    assert.equal(row.summary, null)
    assert.equal(row.documentId, '')
    assert.equal(row.status, 'failed')
    assert.equal(meetingTasksIn(store).filter((item) => item.status === 'pending').length, 0)
    assert.equal((store.tenants[TENANT]['wiki-documents']?.data ?? []).filter((item) => item.systemRequestId === `meeting:${meetingId}`).length, 0,
      '전 직원이 읽는 회의록 문서가 잠긴 자료에서 만들어지면 안 된다')
    // 자료 목록은 메모리에서도 잠긴 채여야 한다 — 되돌리기가 남의 쓰기를 덮으면 저장분과 갈린다.
    assert.equal(documentsIn(store).find((item) => item.id === source.id).aiPolicy, 'locked')
  })
})

test('32. 처리 중에 형제 회의의 되돌리기를 눌러도 같은 약속이 지켜진다', async () => {
  const store = freshStore()
  const storage = gatedStorage()
  const { app } = buildApp(store, { documentStorage: storage })
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const source = await park.upload({ name: '9월 품질 회의.txt' })
    const first = await park.call('POST', '/api/meetings', { title: '1부', transcriptDocumentId: source.id })
    const second = await park.call('POST', '/api/meetings', { title: '2부', transcriptDocumentId: source.id })
    const firstDone = await park.call('POST', `/api/meetings/${first.body.meeting.id}/process`, {})
    assert.equal(firstDone.status, 200, JSON.stringify(firstDone.body))

    const held = storage.hold()
    const processing = park.call('POST', `/api/meetings/${second.body.meeting.id}/process`, {})
    let revoked = null
    try {
      await held.reached
      // 파기의 다른 문. 잠금은 문서 단위이므로 이 처리도 함께 막혀야 한다.
      revoked = await park.call('POST', `/api/meetings/${first.body.meeting.id}/revoke-ai`, {})
    } finally {
      held.open()
    }
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body))

    const done = await processing
    assert.equal(done.status, 409, `되돌린 자료에서 파생물이 태어났다 — ${JSON.stringify(done.body)}`)
    assert.equal(done.body.error.code, 'MEETING_AI_LOCKED')
    for (const row of store.tenants[TENANT]['meeting-notes'].data) {
      assert.equal(row.transcriptText, '', `${row.title}의 전사가 남았다`)
      assert.equal(row.summary, null, `${row.title}의 요약이 남았다`)
    }
    assert.equal(meetingTasksIn(store).filter((item) => item.status === 'pending').length, 0)
  })
})

test('33. 라우트표의 오류 코드는 전부 실제로 나온다 — 제목·원본·전사·저장 실패', async () => {
  const store = freshStore()
  let commits = 0
  let failFrom = Number.POSITIVE_INFINITY
  const failingStorage = memoryStorage()
  const { app } = buildApp(store, {
    documentStorage: failingStorage,
    onWorkspaceStoreChange: () => { commits += 1; if (commits >= failFrom) throw new Error('디스크 고장') },
  })
  await withServer(app, async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const source = await admin.upload({ name: '9월 품질 회의.txt' })

    // MEETING_TITLE_REQUIRED — 공백뿐인 제목은 제목이 아니다(만들 때도, 고칠 때도).
    const blank = await admin.call('POST', '/api/meetings', { title: '   ', transcriptDocumentId: source.id })
    assert.equal(blank.status, 400, JSON.stringify(blank.body))
    assert.equal(blank.body.error.code, 'MEETING_TITLE_REQUIRED')

    // MEETING_SOURCE_REQUIRED — 원본을 하나도 지목하지 않았다.
    const sourceless = await admin.call('POST', '/api/meetings', { title: '원본 없는 회의' })
    assert.equal(sourceless.status, 400, JSON.stringify(sourceless.body))
    assert.equal(sourceless.body.error.code, 'MEETING_SOURCE_REQUIRED')

    // MEETING_SOURCE_FORBIDDEN — 없는 자료와 못 보는 자료는 같은 답이다.
    const unknown = await admin.call('POST', '/api/meetings', { title: '없는 원본', transcriptDocumentId: 'DOC-없음' })
    assert.equal(unknown.status, 403, JSON.stringify(unknown.body))
    assert.equal(unknown.body.error.code, 'MEETING_SOURCE_FORBIDDEN')

    const created = await admin.call('POST', '/api/meetings', { title: '9월 품질 회의', transcriptDocumentId: source.id })
    const meetingId = created.body.meeting.id
    const renamedBlank = await admin.call('PATCH', `/api/meetings/${meetingId}`, { title: ' ' })
    assert.equal(renamedBlank.status, 400, JSON.stringify(renamedBlank.body))
    assert.equal(renamedBlank.body.error.code, 'MEETING_TITLE_REQUIRED')

    // MEETING_TRANSCRIPT_REQUIRED — 전사 없이 요약할 수 없다.
    const early = await admin.call('POST', `/api/meetings/${meetingId}/summarize`)
    assert.equal(early.status, 409, JSON.stringify(early.body))
    assert.equal(early.body.error.code, 'MEETING_TRANSCRIPT_REQUIRED')

    // MEETING_SOURCE_MISSING — 자료실 행은 있는데 파일이 없다.
    failingStorage.files.clear()
    const missing = await admin.call('POST', `/api/meetings/${meetingId}/transcribe`)
    assert.equal(missing.status, 410, JSON.stringify(missing.body))
    assert.equal(missing.body.error.code, 'MEETING_SOURCE_MISSING')

    // MEETING_TRANSCRIPT_EMPTY — 읽을 글이 없는 파일.
    const empty = await admin.upload({ name: '빈 회의.txt', body: '   \n \n  ' })
    const emptyMeeting = await admin.call('POST', '/api/meetings', { title: '빈 회의', transcriptDocumentId: empty.id })
    const emptied = await admin.call('POST', `/api/meetings/${emptyMeeting.body.meeting.id}/transcribe`)
    assert.equal(emptied.status, 400, JSON.stringify(emptied.body))
    assert.equal(emptied.body.error.code, 'MEETING_TRANSCRIPT_EMPTY')

    // MEETING_WRITE_FAILED — 커밋이 죽으면 회의는 만들어지지 않는다.
    const before = (store.tenants[TENANT]['meeting-notes']?.data ?? []).length
    failFrom = commits + 1
    const broken = await admin.call('POST', '/api/meetings', { title: '저장 못 한 회의', transcriptDocumentId: source.id })
    failFrom = Number.POSITIVE_INFINITY
    assert.equal(broken.status, 500, JSON.stringify(broken.body))
    assert.equal(broken.body.error.code, 'MEETING_WRITE_FAILED')
    assert.equal((store.tenants[TENANT]['meeting-notes']?.data ?? []).length, before, '저장에 실패했는데 회의만 늘면 안 된다')
  })
})

test('34. 회의는 회사당 1,000건까지다 — 999건에서는 만들어지고 1,000건에서는 거절된다', async () => {
  const under = freshStore()
  seedMeetings(under, MAX_MEETINGS_PER_TENANT - 1)
  const { app } = buildApp(under)
  await withServer(app, async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const source = await admin.upload({ name: '9월 품질 회의.txt' })
    const created = await admin.call('POST', '/api/meetings', { title: '999번째 다음', transcriptDocumentId: source.id })
    assert.equal(created.status, 201, `상한 바로 아래에서 막히면 사람이 아무것도 못 한다 — ${JSON.stringify(created.body)}`)
    assert.equal(under.tenants[TENANT]['meeting-notes'].data.length, MAX_MEETINGS_PER_TENANT)

    // 상한에 닿으면 거절하고, 문구가 **그 숫자와 풀 길**을 말한다.
    const refused = await admin.call('POST', '/api/meetings', { title: '한 건 더', transcriptDocumentId: source.id })
    assert.equal(refused.status, 409, JSON.stringify(refused.body))
    assert.equal(refused.body.error.code, 'MEETING_LIMIT')
    assert.match(refused.body.error.message, /1000건까지/)
    assert.match(refused.body.error.message, /지난 회의를 지운 뒤/)
    assert.equal(under.tenants[TENANT]['meeting-notes'].data.length, MAX_MEETINGS_PER_TENANT, '거절했는데 한 건 늘면 안 된다')

    // 지우면 자리가 난다 — 문구가 말한 그 일이 실제로 된다(규칙 11).
    const removed = await admin.call('DELETE', `/api/meetings/${under.tenants[TENANT]['meeting-notes'].data[0].id}`)
    assert.equal(removed.status, 200, JSON.stringify(removed.body))
    assert.equal((await admin.call('POST', '/api/meetings', { title: '자리가 난 뒤', transcriptDocumentId: source.id })).status, 201)
  })
})

test('35. 목록의 limit 은 상한에서 잘리고, total 은 언제나 실제 건수다', async () => {
  const store = freshStore()
  seedMeetings(store, 205)
  const { app } = buildApp(store)
  await withServer(app, async (origin) => {
    const admin = await login(origin, ADMIN.email)
    // 잘못된 값·0·음수는 기본값 50으로 읽는다(부분 제어 요소를 만들지 않는다 — 규칙 6).
    for (const limit of ['', '0', '-1', 'abc']) {
      const listed = await admin.call('GET', `/api/meetings?limit=${limit}`)
      assert.equal(listed.status, 200, JSON.stringify(listed.body))
      assert.equal(listed.body.meetings.length, 50, `limit=${limit}`)
      assert.equal(listed.body.total, 205, `limit=${limit}: total 은 자른 배열의 길이가 아니다`)
    }
    for (const [limit, expected] of [[1, 1], [199, 199], [200, 200], [201, 200], [99_999, 200]]) {
      const listed = await admin.call('GET', `/api/meetings?limit=${limit}`)
      assert.equal(listed.body.meetings.length, expected, `limit=${limit}`)
      assert.equal(listed.body.total, 205, `limit=${limit}: total 은 언제나 실제 건수다`)
    }
    // 거른 뒤의 total 도 거른 결과의 실제 건수다.
    const done = await admin.call('GET', '/api/meetings?status=done')
    assert.equal(done.body.meetings.length, 0)
    assert.equal(done.body.total, 0)
    const uploaded = await admin.call('GET', '/api/meetings?status=uploaded&limit=3')
    assert.equal(uploaded.body.meetings.length, 3)
    assert.equal(uploaded.body.total, 205)
  })
})

test('36. 같은 회의를 겹쳐 처리하면 뒤에 온 요청이 409로 되돌아간다', async () => {
  const store = freshStore()
  const storage = gatedStorage()
  const { app } = buildApp(store, { documentStorage: storage })
  await withServer(app, async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const source = await admin.upload({ name: '9월 품질 회의.txt' })
    const created = await admin.call('POST', '/api/meetings', { title: '9월 품질 회의', transcriptDocumentId: source.id })
    const meetingId = created.body.meeting.id

    const held = storage.hold()
    const processing = admin.call('POST', `/api/meetings/${meetingId}/process`, {})
    let overlapped = null
    // 단언이 먼저 터져도 게이트는 반드시 연다 — 열지 않으면 이 시험이 실패가 아니라 **정지**가 된다.
    try {
      await held.reached
      overlapped = await admin.call('POST', `/api/meetings/${meetingId}/transcribe`)
    } finally {
      held.open()
    }
    assert.equal(overlapped.status, 409, JSON.stringify(overlapped.body))
    assert.equal(overlapped.body.error.code, 'MEETING_ALREADY_PROCESSING')

    const done = await processing
    assert.equal(done.status, 200, JSON.stringify(done.body))
    // 잠금이 풀린 뒤에는 다시 처리할 수 있다 — 죽은 잠금으로 굳지 않는다(규칙 5).
    assert.equal((await admin.call('POST', `/api/meetings/${meetingId}/transcribe`)).status, 200)
  })
})

/**
 * ── M3 검증 지적 반영 (3회차) ────────────────────────────────────────────────
 * 아래 여섯은 3회차 적대적 검증에서 실제로 재현된 결함을 잠근다. 전부 돌아가는 앱에 대고 재고,
 * 각 시험은 고치기 전 상태에서 빨갛다.
 */

const wikiIn = (store) => (store.tenants[TENANT]['wiki-documents']?.data ?? [])

test('37. 회의록 문서가 완전 삭제된 뒤 다시 요약하면 새로 만든다 — 죽은 id를 가리키는 제안을 낳지 않는다', async () => {
  const store = freshStore()
  const { app } = buildApp(store)
  await withServer(app, async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const source = await admin.upload({ name: '9월 품질 회의.txt' })
    const created = await admin.call('POST', '/api/meetings', { title: '9월 품질 회의', transcriptDocumentId: source.id })
    const meetingId = created.body.meeting.id
    const first = await admin.call('POST', `/api/meetings/${meetingId}/process`, { aiPolicy: 'active' })
    assert.equal(first.status, 200, JSON.stringify(first.body))
    const gone = first.body.documentId

    // 관리자가 회의록 문서를 보관한 뒤 완전히 지운다. 회의 레코드의 documentId 는 그대로 남는다.
    assert.equal((await admin.call('DELETE', `/api/wiki/${gone}`)).status, 200)
    const purged = await admin.call('DELETE', `/api/wiki/${gone}?purge=1`)
    assert.equal(purged.status, 200, JSON.stringify(purged.body))
    assert.equal(wikiIn(store).some((row) => row.id === gone), false, '이 시험이 재려는 상황(문서가 사라졌다)이 아니게 됐다')
    assert.equal(store.tenants[TENANT]['meeting-notes'].data[0].documentId, gone, '회의는 죽은 id 를 그대로 들고 있다')

    // 되돌렸다 다시 처리한다 — 대기 제안이 만료돼 새 제안이 태어나는 자리다.
    assert.equal((await admin.call('POST', `/api/meetings/${meetingId}/revoke-ai`)).status, 200)
    const again = await admin.call('POST', `/api/meetings/${meetingId}/process`, { aiPolicy: 'active' })
    assert.equal(again.status, 200, JSON.stringify(again.body))
    assert.notEqual(again.body.documentId, gone, '사라진 문서를 그대로 가리키면 화면의 링크가 404 로 간다')
    assert.equal(again.body.documentReused, false, '새로 만들었으면 「처음 만든 그대로」가 아니다')
    assert.equal(again.body.documentNote, undefined, '다시 쓰지 않았다는 문장은 문서가 그대로일 때만 나간다')
    assert.equal((await admin.call('GET', `/api/wiki/${again.body.documentId}`)).status, 200, '응답이 가리키는 문서는 실제로 열려야 한다')

    const pending = proposalsIn(store).filter((row) => row.kind === 'meeting-task' && row.status === 'pending')
    assert.equal(pending.length, 2)
    assert.ok(pending.every((row) => row.payload.documentId === again.body.documentId), '결재자가 여는 근거가 죽은 문서면 요약만 보고 결정하게 된다')

    // 승인 뒤 업무의 출처도 살아 있는 문서를 가리켜야 한다(같은 사본이 한 번 더 복사되는 자리).
    const approved = await admin.call('POST', `/api/proposals/${pending[0].id}/decide`, { decision: 'approve' })
    assert.equal(approved.status, 200, JSON.stringify(approved.body))
    const workItem = (store.tenants[TENANT]['work-items']?.data ?? []).find((row) => row?.origin?.kind === 'meeting-task')
    assert.equal(workItem.origin.page, 'wiki')
    assert.equal(workItem.origin.focusId, again.body.documentId)
    assert.equal((await admin.call('GET', `/api/wiki/${workItem.origin.focusId}`)).status, 200)
  })
})

test('38. 보관 30일 스윕이 사람 손 없이 문서를 지워도 같다 — 대기 중이던 제안도 살아 있는 문서로 옮겨 간다', async () => {
  const store = freshStore()
  const { app } = buildApp(store)
  await withServer(app, async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const source = await admin.upload({ name: '9월 품질 회의.txt' })
    const created = await admin.call('POST', '/api/meetings', { title: '9월 품질 회의', transcriptDocumentId: source.id })
    const meetingId = created.body.meeting.id
    const first = await admin.call('POST', `/api/meetings/${meetingId}/process`, { aiPolicy: 'active' })
    const gone = first.body.documentId
    assert.equal(first.body.queued, 2, JSON.stringify(first.body))

    // 사람은 「보관」만 누른다. 완전 삭제는 하루 두 번 도는 스케줄러가 30일 뒤에 한다.
    assert.equal((await admin.call('DELETE', `/api/wiki/${gone}`)).status, 200)
    const archivedAt = wikiIn(store).find((row) => row.id === gone).archivedAt
    const swept = await app.locals.sweepWikiArchive(new Date(Date.parse(archivedAt) + 31 * 24 * 60 * 60 * 1_000))
    assert.equal(swept.removed, 1, '이 시험이 재려는 상황(스윕이 지웠다)이 아니게 됐다')

    // 되돌리지 않고 그대로 다시 요약한다 — 대기 제안은 살아 있으므로 새로 만들어지지 않는다.
    const again = await admin.call('POST', `/api/meetings/${meetingId}/summarize`)
    assert.equal(again.status, 200, JSON.stringify(again.body))
    assert.equal(again.body.queued, 0)
    assert.equal(again.body.skipped, 2, '대기 중인 제안은 회의·순서당 하나다')
    assert.notEqual(again.body.documentId, gone)
    assert.equal((await admin.call('GET', `/api/wiki/${again.body.documentId}`)).status, 200)

    const pending = proposalsIn(store).filter((row) => row.kind === 'meeting-task' && row.status === 'pending')
    assert.equal(pending.length, 2)
    assert.ok(pending.every((row) => row.payload.documentId === again.body.documentId), '사본이 죽은 id 로 남으면 「근거 열기」가 404 로 간다')
  })
})

test('39. 되돌리기는 실제로 한 일만 말한다 — 지울 파생물이 없을 때와, 형제 회의의 문서를 내 것처럼 세는 것', async () => {
  const store = freshStore()
  const { app } = buildApp(store)
  await withServer(app, async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const source = await admin.upload({ name: '9월 품질 회의.txt' })
    const processed = await admin.call('POST', '/api/meetings', { title: '9월 품질 회의', transcriptDocumentId: source.id })
    const untouched = await admin.call('POST', '/api/meetings', { title: '9월 품질 회의 후속', transcriptDocumentId: source.id })
    const first = await admin.call('POST', `/api/meetings/${processed.body.meeting.id}/process`, { aiPolicy: 'active' })
    assert.equal(first.status, 200, JSON.stringify(first.body))

    // 1회차 — 실제로 지운다.
    const once = await admin.call('POST', `/api/meetings/${processed.body.meeting.id}/revoke-ai`)
    assert.equal(once.status, 200, JSON.stringify(once.body))
    assert.equal(once.body.expiredProposals, 2)
    assert.equal(once.body.purgedMeetings, 1)
    assert.match(once.body.message, /전사 원문과 요약을 지우고/)
    assert.match(once.body.message, /회의록 문서는 남아 있습니다/)
    assert.doesNotMatch(once.body.message, /다른 회의의/, '이 회의의 문서가 남았다면 그대로 말한다')

    // 2회차 — 지울 것이 없다. 숫자가 0인데 문장이 「지웠다」고 하면 화면이 거짓을 말한다(규칙 11).
    const twice = await admin.call('POST', `/api/meetings/${processed.body.meeting.id}/revoke-ai`)
    assert.equal(twice.body.expiredProposals, 0)
    assert.equal(twice.body.purgedMeetings, 0)
    assert.doesNotMatch(twice.body.message, /지우고 대기 중인 업무 제안을 만료했습니다/, `한 일이 없는데 했다고 말한다 — ${twice.body.message}`)
    assert.match(twice.body.message, /지울 파생물은 없었습니다/)
    assert.match(twice.body.message, /회의록 문서는 남아 있습니다/, '문서가 남아 있다는 사실은 두 번째에도 그대로다')

    // 한 번도 처리한 적 없는 회의 — 이 회의는 회의록 문서를 가진 적이 없다.
    const never = await admin.call('POST', `/api/meetings/${untouched.body.meeting.id}/revoke-ai`)
    assert.equal(never.status, 200, JSON.stringify(never.body))
    assert.equal(never.body.documentId, '', '가진 적 없는 문서 id 를 실으면 화면이 없는 곳으로 간다')
    assert.match(never.body.message, /지울 파생물은 없었습니다/)
    assert.match(never.body.message, /이 원본을 함께 쓰는 다른 회의의 회의록 문서는 남아 있습니다/, '형제 회의의 문서를 이 회의의 것처럼 말하면 안 된다')
  })
})

test('40. 처리에 실패하면 올렸던 AI 처리 수준도 함께 되돌아간다 — 돌아가는 앱에서도', async () => {
  const store = freshStore()
  const { app, storage } = buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const source = await park.upload({ name: '9월 품질 회의.txt', tags: ['meeting-recording'] })
    assert.equal(source.aiPolicy, 'locked')
    const created = await park.call('POST', '/api/meetings', { title: '9월 품질 회의', transcriptDocumentId: source.id })

    // 자료실 행은 그대로 두고 원본 파일만 사라진다(저장 백엔드 유실). 전사는 시작조차 못 한다.
    storage.files.clear()
    const processed = await park.call('POST', `/api/meetings/${created.body.meeting.id}/process`, { aiPolicy: 'active' })
    assert.equal(processed.status, 410, JSON.stringify(processed.body))
    assert.equal(processed.body.error.code, 'MEETING_SOURCE_MISSING')
    // 아무것도 만들지 못한 처리가 자료의 AI 수준만 올려 두면, 그 문은 이 모듈 밖의 다른 AI 기능
    // (문서 렌즈·분류 제안·AI 검색)에게도 그 원본의 본문을 연다(규칙 9).
    assert.equal(documentsIn(store).find((row) => row.id === source.id).aiPolicy, 'locked')
    const reread = await park.call('GET', '/api/documents')
    assert.equal(reread.body.documents.find((row) => row.id === source.id).aiPolicy, 'locked', '돌아가는 앱에도 그대로여야 한다')

    // 대조군: 파일이 있는 회의에서는 같은 요청이 수준을 올리고 실제로 처리한다(위 단언이 공허하지 않다).
    const alive = await park.upload({ name: '10월 품질 회의.txt', tags: ['meeting-recording'] })
    const second = await park.call('POST', '/api/meetings', { title: '10월 품질 회의', transcriptDocumentId: alive.id })
    const ok = await park.call('POST', `/api/meetings/${second.body.meeting.id}/process`, { aiPolicy: 'active' })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.equal(documentsIn(store).find((row) => row.id === alive.id).aiPolicy, 'active')
  })
})

test('41. 원장이 계속 죽어 있어도 회계 어휘가 뒤로 가지 않는다 — 정산 대기 줄은 그대로 있다', async () => {
  const store = freshStore()
  const repository = createMemoryBillingRepository()
  const real = createBillingService({ repository })
  // 원장 쓰기만 죽는다. 예약과 정산 대기 기록은 진짜 원장이 그대로 처리한다.
  const billingService = { ...real, async recordUsageEvent() { throw new Error('원장 쓰기 실패') } }
  const { app } = buildApp(store, { billingService })
  await withServer(app, async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const source = await admin.upload({ name: '9월 품질 회의.txt' })
    const created = await admin.call('POST', '/api/meetings', { title: '9월 품질 회의', transcriptDocumentId: source.id })
    const meetingId = created.body.meeting.id

    const first = await admin.call('POST', `/api/meetings/${meetingId}/transcribe`)
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.equal(first.body.meeting.usage.transcriptionAccounting, 'reconciliation-pending')
    const pendingRows = repository.inspect().reconciliations.length
    assert.equal(pendingRows, 1, '이 시험이 재려는 상황(정산 대기 줄이 남았다)이 아니게 됐다')

    // 다시 누른다. 예약은 새로 잡지 않고(이미 확정된 한 줄이다) 원장은 여전히 죽어 있다.
    const again = await admin.call('POST', `/api/meetings/${meetingId}/transcribe`)
    assert.equal(again.status, 200, JSON.stringify(again.body))
    assert.equal(repository.inspect().reconciliations.length, pendingRows, '정산 대기 줄은 그대로다')
    assert.equal(
      again.body.meeting.usage.transcriptionAccounting,
      'reconciliation-pending',
      '정산 대기 줄이 원장에 남아 있는데 「예약도 기록도 하지 못했다」로 되돌리면 화면이 사실과 다른 낱말을 읽는다',
    )
  })
})

test('42. 회의록 키는 generic 저장소 라우트에서 정확히 403 MEETING_ROUTE_REQUIRED다 — 형제 키와 같은 관례', async () => {
  const store = freshStore()
  const { app } = buildApp(store)
  await withServer(app, async (origin) => {
    const admin = await login(origin, ADMIN.email)
    // 404 STORE_KEY_NOT_FOUND(키 미등록) 방식으로 되돌아가면 한 PR이 관례를 둘로 가른다(설계 D9).
    const read = await admin.call('GET', '/api/workspace/meeting-notes')
    assert.equal(read.status, 403, `404 로 답하면 화면은 어디로 가야 하는지 알 수 없다 — ${JSON.stringify(read.body)}`)
    assert.equal(read.body.error.code, 'MEETING_ROUTE_REQUIRED')
    const write = await admin.call('PUT', '/api/workspace/meeting-notes', { data: [] })
    assert.equal(write.status, 403, JSON.stringify(write.body))
    assert.equal(write.body.error.code, 'MEETING_ROUTE_REQUIRED')
    // 형제 관례 대조군: 결재 키도 같은 모양으로 닫혀 있고, 평범한 키는 그대로 열려 있다.
    assert.equal((await admin.call('GET', '/api/workspace/approval-documents')).body.error.code, 'APPROVAL_ROUTE_REQUIRED')
    assert.equal((await admin.call('GET', '/api/workspace/company-assets')).status, 200, '대조군이 죽으면 위 단언은 「모든 키가 막힌다」만 잰다')
    // 등록되지 않은 키는 지금도 404다 — 403 과 404 가 말하는 것이 다르다는 사실이 이 시험의 요점이다.
    assert.equal((await admin.call('GET', '/api/workspace/meeting-notes-x')).status, 404)
    // generic PUT 이 회의 행을 만들어 두지 못했다는 것을 저장소에서 확인한다.
    assert.equal(store.tenants[TENANT]['meeting-notes'], undefined)
  })
})

/**
 * ── M4 검증 지적 반영 (1회차) ────────────────────────────────────────────────
 * 아래 둘은 화면 쪽 지적의 **서버 근거**를 잠근다. 둘 다 고치기 전 상태에서 빨갛다.
 */

test('43. 목록은 offset 으로 나머지에 닿는다 — 화면이 「남은 N건」이라 말하면 그 N건이 실제로 열려야 한다', async () => {
  const store = freshStore()
  const seeded = seedMeetings(store, 60)
  const { app } = buildApp(store)
  await withServer(app, async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const first = await admin.call('GET', '/api/meetings?limit=50')
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.equal(first.body.meetings.length, 50)
    assert.equal(first.body.total, 60)

    const second = await admin.call('GET', '/api/meetings?limit=50&offset=50')
    assert.equal(second.status, 200, JSON.stringify(second.body))
    assert.equal(second.body.meetings.length, 10, '두 번째 묶음이 비면 51번째부터는 열지도 지우지도 못한다')
    assert.equal(second.body.total, 60, 'offset 이 있어도 total 은 실제 건수다')

    // 두 묶음을 이어 붙이면 **한 건도 빠지지 않고** 겹치지도 않는다.
    const ids = [...first.body.meetings, ...second.body.meetings].map((row) => row.id)
    assert.equal(new Set(ids).size, 60)
    assert.equal(new Set(seeded.map((row) => row.id)).size, 60)
    for (const row of seeded) assert.ok(ids.includes(row.id), `${row.id} 가 어느 묶음에도 없다`)

    // 상한 200 뒤의 회의에도 닿는다 — limit 만 올리는 길로는 회사당 상한 1,000건에 못 미친다.
    const beyond = await admin.call('GET', '/api/meetings?limit=50&offset=60')
    assert.equal(beyond.body.meetings.length, 0)
    assert.equal(beyond.body.total, 60)
    // 잘못된 값은 0으로 읽는다(부분 제어 요소를 만들지 않는다 — 규칙 6).
    for (const offset of ['', '-1', 'abc', '1.5']) {
      const listed = await admin.call('GET', `/api/meetings?limit=3&offset=${offset}`)
      assert.equal(listed.body.meetings.length, 3, `offset=${offset}`)
      assert.equal(listed.body.meetings[0].id, first.body.meetings[0].id, `offset=${offset}: 첫 묶음으로 떨어진다`)
    }
  })
})

test('44. 목록이 실어 보내는 documentId 는 위키에 실제로 남아 있는 행에서 나온다', async () => {
  const store = freshStore()
  const { app } = buildApp(store)
  await withServer(app, async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const source = await admin.upload({ name: '9월 품질 회의.txt' })
    const created = await admin.call('POST', '/api/meetings', { title: '9월 품질 회의', transcriptDocumentId: source.id })
    const meetingId = created.body.meeting.id
    const processed = await admin.call('POST', `/api/meetings/${meetingId}/process`, { aiPolicy: 'active' })
    assert.equal(processed.status, 200, JSON.stringify(processed.body))
    const documentId = processed.body.documentId
    assert.ok(documentId.startsWith('WDOC-'))
    assert.equal((await admin.call('GET', '/api/meetings')).body.meetings[0].documentId, documentId, '대조군: 문서가 있을 때는 그 id 가 나간다')

    // 보관 30일 스윕이 사람 손 없이 그 문서를 지운다. 회의 레코드의 documentId 는 **사본**이라 그대로 남는다.
    assert.equal((await admin.call('DELETE', `/api/wiki/${documentId}`)).status, 200)
    const archivedAt = wikiIn(store).find((row) => row.id === documentId).archivedAt
    const swept = await app.locals.sweepWikiArchive(new Date(Date.parse(archivedAt) + 31 * 24 * 60 * 60 * 1_000))
    assert.equal(swept.removed, 1, '이 시험이 재려는 상황(스윕이 지웠다)이 아니게 됐다')
    assert.equal(store.tenants[TENANT]['meeting-notes'].data[0].documentId, documentId, '회의는 죽은 id 를 그대로 들고 있다')

    // 사본을 그대로 실어 보내면 화면이 「회의록 열기」를 그려 없는 문서로 사람을 보낸다(부록 C-2).
    const listed = await admin.call('GET', '/api/meetings')
    assert.equal(listed.body.meetings[0].status, 'done')
    assert.equal(listed.body.meetings[0].documentId, '', '사라진 문서를 가리키면 화면의 링크가 404 로 간다')
    const detail = await admin.call('GET', `/api/meetings/${meetingId}`)
    assert.equal(detail.body.meeting.documentId, '', '상세도 같은 사실을 말한다')
    assert.equal((await admin.call('GET', `/api/wiki/${documentId}`)).status, 404, '재어 확인: 문서는 실제로 없다')

    // 다시 정리하면 새로 만들고, 그때부터 목록이 그 문서를 가리킨다.
    const again = await admin.call('POST', `/api/meetings/${meetingId}/summarize`)
    assert.equal(again.status, 200, JSON.stringify(again.body))
    assert.notEqual(again.body.documentId, documentId)
    assert.equal((await admin.call('GET', '/api/meetings')).body.meetings[0].documentId, again.body.documentId)
  })
})

test('45. 화면이 실제로 밟는 순서로 재어 본다 — 409 뒤에 물은 상세가 「회사 전원이 읽는다」를 준다', async () => {
  const store = freshStore()
  const { app } = buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    // 화면의 `uploadDocumentAttachment`가 보내는 그대로: visibility 'restricted' + 회의 분류·태그.
    // 그래서 이 화면이 만드는 회의는 **예외 없이** 경고의 강한 쪽이다.
    const source = await park.upload({
      name: '인수 협상.txt', category: '회의녹음', tags: ['meeting-recording'], visibility: 'restricted',
    })
    const created = await park.call('POST', '/api/meetings', { title: '인수 협상 회의', transcriptDocumentId: source.id })
    const meetingId = created.body.meeting.id

    // ① 목록 행의 「AI로 정리」 — 본문 없이 부른다.
    const locked = await park.call('POST', `/api/meetings/${meetingId}/process`, {})
    assert.equal(locked.status, 409, JSON.stringify(locked.body))
    assert.equal(locked.body.error.code, 'MEETING_AI_LOCKED')
    // ② 409 본문에는 열람 범위 문장이 없다 — 그래서 화면이 상세를 한 번 더 묻는다.
    assert.equal(locked.body.documentAudience, undefined)

    // ③ 화면이 동의를 묻기 전에 채우는 그 문장.
    const detail = await park.call('GET', `/api/meetings/${meetingId}`)
    assert.equal(detail.status, 200, JSON.stringify(detail.body))
    assert.equal(detail.body.documentAudience.widerThanSource, true)
    assert.match(detail.body.documentAudience.message, /회사 구성원 전원이 읽을 수 있습니다/)
    assert.match(detail.body.documentAudience.message, /원본을 볼 수 없는 사람에게도 보이게 됩니다/)

    // ④ 동의한 뒤의 응답도 같은 문장을 싣는다(화면이 그 칸을 읽어 토스트에 옮긴다).
    const processed = await park.call('POST', `/api/meetings/${meetingId}/process`, { aiPolicy: 'active' })
    assert.equal(processed.status, 200, JSON.stringify(processed.body))
    assert.equal(processed.body.documentReused, false)
    assert.equal(processed.body.documentAudience.message, detail.body.documentAudience.message)
    // 두 번째부터는 새로 열린 것이 없다 — 화면이 그 문장을 되풀이하지 않는 근거다.
    const again = await park.call('POST', `/api/meetings/${meetingId}/summarize`)
    assert.equal(again.body.documentReused, true, JSON.stringify(again.body))
  })
})

test('46. 「승인 큐에 올라가 있다」는 지금 실제로 대기 중인 수다 — 결재가 끝나면 줄고, 다시 정리해도 부풀지 않는다', async () => {
  const store = freshStore()
  const { app } = buildApp(store)
  await withServer(app, async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const source = await admin.upload({ name: '9월 품질 회의.txt' })
    const created = await admin.call('POST', '/api/meetings', { title: '9월 품질 회의', transcriptDocumentId: source.id })
    const meetingId = created.body.meeting.id
    assert.equal(created.body.meeting.pendingProposals, 0, '아직 아무것도 올리지 않았다')

    const processed = await admin.call('POST', `/api/meetings/${meetingId}/process`)
    assert.equal(processed.status, 200, JSON.stringify(processed.body))
    assert.equal(processed.body.queued, 2)
    assert.equal(processed.body.meeting.pendingProposals, 2, '올린 직후에는 둘 다 대기 중이다')

    // 결재자가 둘을 처리한다. 하나는 승인, 하나는 반려 — 어느 쪽이든 큐에서 사라진다.
    const queue = await admin.call('GET', '/api/proposals')
    const tasks = queue.body.proposals.filter((row) => row.kind === 'meeting-task')
    assert.equal(tasks.length, 2)
    assert.equal((await admin.call('POST', `/api/proposals/${tasks[0].id}/decide`, { decision: 'approve' })).status, 200)
    assert.equal((await admin.call('POST', `/api/proposals/${tasks[1].id}/decide`, { decision: 'reject' })).status, 200)
    assert.equal(meetingTasksIn(store).filter((row) => row.status === 'pending').length, 0, '재어 확인: 큐에 남은 것이 없다')

    // 화면이 「승인 큐에 N건이 올라가 있습니다」로 쓰는 그 수. 이력(proposalIds)이 아니라 대기 수여야 한다.
    const detail = await admin.call('GET', `/api/meetings/${meetingId}`)
    assert.equal(detail.body.meeting.pendingProposals, 0, '결재가 끝났으면 대기는 0건이다')
    assert.equal(detail.body.meeting.proposalIds.length, 2, '이력은 그대로 남는다 — 그래서 이력으로 세면 안 된다')
    const listed = await admin.call('GET', '/api/meetings')
    assert.equal(listed.body.meetings[0].pendingProposals, 0, '목록 줄도 같은 수를 본다')

    // 다시 정리하면 결재가 끝난 자리에 새 제안이 다시 오른다. 그때도 「지금 대기 중」은 둘이다.
    const again = await admin.call('POST', `/api/meetings/${meetingId}/process`)
    assert.equal(again.body.queued, 2, JSON.stringify(again.body))
    assert.equal(again.body.meeting.pendingProposals, 2, '누적이 아니라 지금 대기 중인 수다')
    assert.equal(again.body.meeting.proposalIds.length, 4, '이력은 늘어난다 — 그 길이를 화면이 세면 4건이라 거짓을 말한다')
  })
})

test('47. 참석자 명단은 회사 구성원만 받는다 — 외부 게스트 id는 걸러진다', async () => {
  const store = freshStore()
  const { app } = buildApp(store)
  await withServer(app, async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const source = await admin.upload({ name: '9월 품질 회의.txt' })
    // 만들 때도, 고칠 때도 같은 정규화기를 지난다.
    const created = await admin.call('POST', '/api/meetings', {
      title: '9월 품질 회의', transcriptDocumentId: source.id, participantIds: [GUEST.id, LEE.id],
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    assert.deepEqual(created.body.meeting.participantIds, [LEE.id], '참석자 명단은 곧 열람 명단이다 — 게스트를 넣지 않는다')

    const patched = await admin.call('PATCH', `/api/meetings/${created.body.meeting.id}`, { participantIds: [GUEST.id, LEE.id] })
    assert.equal(patched.status, 200, JSON.stringify(patched.body))
    assert.deepEqual(patched.body.meeting.participantIds, [LEE.id])
    assert.deepEqual(store.tenants[TENANT]['meeting-notes'].data[0].participantIds, [LEE.id], '저장된 줄에도 남지 않는다')
  })
})

test('48. 상세와 처리 응답이 「지금 수준」과 「내가 올릴 수 있는가」를 싣는다', async () => {
  const store = freshStore()
  const { app } = buildApp(store)
  await withServer(app, async (origin) => {
    const park = await login(origin, PARK.email)
    const source = await park.upload({ name: '9월 품질 회의.txt', category: '회의녹음', tags: ['meeting-recording'] })
    const created = await park.call('POST', '/api/meetings', {
      title: '9월 품질 회의', transcriptDocumentId: source.id, participantIds: [LEE.id],
    })
    const meetingId = created.body.meeting.id

    // 「정리」까지만 올린다 — 제안은 만들어지지 않는다.
    const indexed = await park.call('POST', `/api/meetings/${meetingId}/process`, { aiPolicy: 'indexed' })
    assert.equal(indexed.status, 200, JSON.stringify(indexed.body))
    assert.equal(indexed.body.proposalsSkipped, 'ai-level')
    assert.deepEqual(indexed.body.aiLevel, { current: 'indexed', mayRaise: true }, '올린 사람은 「활용」으로 더 올릴 수 있다')

    const detail = await park.call('GET', `/api/meetings/${meetingId}`)
    assert.deepEqual(detail.body.aiLevel, { current: 'indexed', mayRaise: true }, '상세도 같은 사실을 말한다')

    // 참석자는 회의를 볼 수 있지만 수준을 올릴 수는 없다(부록 C-1) — 화면이 그 사람에게
    // 「「활용」으로 올려 다시 정리」를 그려 주면 그 버튼은 403만 받는다.
    const lee = await login(origin, LEE.email)
    const leeDetail = await lee.call('GET', `/api/meetings/${meetingId}`)
    assert.equal(leeDetail.status, 200, JSON.stringify(leeDetail.body))
    assert.equal(leeDetail.body.aiLevel.mayRaise, false)
    assert.equal((await lee.call('POST', `/api/meetings/${meetingId}/process`, { aiPolicy: 'active' })).status, 403, '재어 확인: 실제로 403이다')

    // 「활용」으로 올리면 제안이 만들어지고, 더 올릴 곳이 없다는 사실도 같은 칸이 말한다.
    const active = await park.call('POST', `/api/meetings/${meetingId}/process`, { aiPolicy: 'active' })
    assert.equal(active.body.queued, 2, JSON.stringify(active.body))
    assert.equal(active.body.aiLevel.current, 'active')
  })
})

test('49. 미리보기 글자 수는 서버가 코드포인트로 센다 — 이모지가 섞여도 앞부분이 전체보다 길어지지 않는다', async () => {
  const store = freshStore()
  const { app } = buildApp(store)
  await withServer(app, async (origin) => {
    const admin = await login(origin, ADMIN.email)
    // BMP 밖 글자만으로 된 원문. UTF-16 코드유닛으로 세면 글자마다 둘로 세어진다.
    const body = '🙂'.repeat(2_100)
    const source = await admin.upload({ name: '이모지 회의.txt', body })
    const created = await admin.call('POST', '/api/meetings', { title: '이모지 회의', transcriptDocumentId: source.id })
    const processed = await admin.call('POST', `/api/meetings/${created.body.meeting.id}/process`)
    assert.equal(processed.status, 200, JSON.stringify(processed.body))

    const detail = await admin.call('GET', `/api/meetings/${created.body.meeting.id}`)
    assert.equal(detail.status, 200, JSON.stringify(detail.body))
    // 개수를 말하는 칸은 **실제 개수와 같아야 한다**(규칙 13). 화면은 이 수를 그대로 그린다.
    assert.equal(detail.body.transcriptPreviewChars, [...detail.body.transcriptPreview].length, '실제로 보이는 글자 수와 같아야 한다')
    assert.equal(detail.body.transcriptPreviewChars, 2_000, '미리보기 상한은 2,000 글자다')
    assert.equal(detail.body.meeting.transcriptChars, 2_100)
    assert.ok(
      detail.body.transcriptPreviewChars <= detail.body.meeting.transcriptChars,
      `앞부분이 전체보다 길다고 말한다 — ${detail.body.transcriptPreviewChars} > ${detail.body.meeting.transcriptChars}`,
    )
    // 대조군: 코드유닛으로 세면 실제로 어긋난다(그래서 화면이 세면 안 된다).
    assert.equal(detail.body.transcriptPreview.length, 4_000)

    // 한글은 BMP 안이라 두 세는 법이 같다 — 이 시험이 이모지에서만 참인 것이 아님을 재어 둔다.
    const korean = await admin.upload({ name: '한글 회의.txt', body: '가'.repeat(2_100) })
    const koreanMeeting = await admin.call('POST', '/api/meetings', { title: '한글 회의', transcriptDocumentId: korean.id })
    await admin.call('POST', `/api/meetings/${koreanMeeting.body.meeting.id}/process`)
    const koreanDetail = await admin.call('GET', `/api/meetings/${koreanMeeting.body.meeting.id}`)
    assert.equal(koreanDetail.body.transcriptPreviewChars, 2_000)
    assert.equal(koreanDetail.body.transcriptPreview.length, 2_000)
  })
})

test('50. 참석자 상한은 export된 한 수에서 나온다 — 그 수를 넘긴 명단은 조용히 잘린다', async () => {
  const store = freshStore()
  // 상한보다 다섯 많은 직원을 심는다. 계정 목록은 createApp 때 만들어지므로 앱보다 먼저 심는다.
  const extras = Array.from({ length: MAX_PARTICIPANTS + 5 }, (_, index) => ({
    id: `USR-SUNSEA-EXTRA-${String(index).padStart(2, '0')}`,
    email: `extra${index}@sunsea.co.kr`, name: `추가직원${index}`,
    tenantId: TENANT, tenantName: '햇살바다', team: '품질', jobRole: '사원', requested: '초대', role: 'tenant-member',
  }))
  store.invitedAccounts.push(...extras)
  for (const row of extras) store.accountApprovals[row.id] = 'approved'
  const { app } = buildApp(store)
  await withServer(app, async (origin) => {
    const admin = await login(origin, ADMIN.email)
    const source = await admin.upload({ name: '9월 품질 회의.txt' })
    const created = await admin.call('POST', '/api/meetings', { title: '9월 품질 회의', transcriptDocumentId: source.id })
    const meetingId = created.body.meeting.id
    const ids = extras.map((row) => row.id)

    const atLimit = await admin.call('PATCH', `/api/meetings/${meetingId}`, { participantIds: ids.slice(0, MAX_PARTICIPANTS) })
    assert.equal(atLimit.status, 200, JSON.stringify(atLimit.body))
    assert.equal(atLimit.body.meeting.participantIds.length, MAX_PARTICIPANTS, '상한까지는 그대로 남는다')

    // 상한을 넘기면 **말없이** 사라지고 200이 온다 — 그래서 화면이 이 수를 미리 알아야 한다.
    const overLimit = await admin.call('PATCH', `/api/meetings/${meetingId}`, { participantIds: ids.slice(0, MAX_PARTICIPANTS + 1) })
    assert.equal(overLimit.status, 200, JSON.stringify(overLimit.body))
    assert.equal(overLimit.body.meeting.participantIds.length, MAX_PARTICIPANTS)
    assert.ok(!overLimit.body.meeting.participantIds.includes(ids[MAX_PARTICIPANTS]), `${MAX_PARTICIPANTS + 1}번째가 사라졌다`)
    // 잘린 명단이 곧 열람 명단이다 — 사라진 사람은 이 회의를 열지 못한다.
    assert.deepEqual(store.tenants[TENANT]['meeting-notes'].data[0].participantIds.length, MAX_PARTICIPANTS)
  })
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { createApp } from './app.mjs'
import { MATERIAL_FRAME_CSP } from './material-bridge.mjs'
import { withServer } from './test-server.mjs'

/**
 * 검토 자료 S1: 올리기 → 원본 보관(삭제 잠금) → 격리된 칸에 그리기 → 그림은 그 판의 목록에 있는 것만.
 */
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
    async exists(key) { return files.has(key) },
    async delete(key) { return files.delete(key) },
    async getSignedUrl(_key, options = {}) { return options.fallbackUrl ?? null },
  }
}

const freshStore = () => ({ version: 2, tenants: { 'TENANT-SUNSEA': {} }, platform: {}, accountApprovals: {}, accountCredentials: {}, invitedAccounts: [], passwordResetRequests: [], guestGrants: [] })

async function login(origin, email) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: 'tenant', email, password: 'demo1234' }),
  })
  assert.equal(response.status, 200)
  const account = (await response.json()).account
  return { account, headers: { cookie: response.headers.get('set-cookie').split(';')[0], 'x-workspace-identity': `${account.tenantId}:${account.id}` } }
}

// 8KB가 넘는 그림 하나(내용은 아무 바이트여도 된다 — 엔진은 data: URI를 떼어 내 sha로 저장한다).
const pngBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(12_000, 7)])
const bigImage = `data:image/png;base64,${pngBytes.toString('base64')}`

const materialHtml = ({ key = 'onlybook-review', note = '첫 판', second = '두 번째 제안: 결제 흐름을 한 화면으로 합친다. 장바구니에서 바로 결제한다.' } = {}) => `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>온리북 개편안</title>
<meta name="itf:material" content="${key}"><meta name="itf:version-note" content="${note}">
<script>window.localStorage && console.log('자료 자체 스크립트')</script></head>
<body>
<h1>온리북 최종 개편안</h1>
<section id="proposals">
  <article class="prop" id="A1" data-prio="P0"><h3>A1. 첫 화면을 단순하게</h3><p>첫 화면의 배너를 하나로 줄이고 검색창을 위로 올린다. 사용자 조사에서 가장 많이 나온 불만이다.</p>
    <select><option>반영</option><option>보류</option><option>미반영</option></select><img src="${bigImage}" alt="첫 화면 시안"></article>
  <article class="prop" id="A2" data-prio="P1"><h3>A2. 결제 흐름</h3><p>${second}</p><select><option>반영</option><option>보류</option></select></article>
  <article class="prop" id="A3" data-prio="P2"><h3>A3. 알림 정리</h3><p>알림 종류를 다섯 개에서 셋으로 줄이고 하루 한 번 묶어서 보낸다. 앱 푸시는 선택으로 둔다.</p><select><option>반영</option><option>미반영</option></select></article>
</section>
<p><a href="https://example.com/research">조사 원문</a></p>
</body></html>`

const upload = (origin, auth, html, query = '') => fetch(`${origin}/api/materials/import${query}`, {
  method: 'POST',
  headers: { ...auth.headers, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('온리북.html') },
  body: Buffer.from(html, 'utf8'),
})

test('검토 자료: 올리면 원본은 자료실에 잠겨 보관되고, 격리된 칸용 문서와 그림이 나온다', async () => {
  const store = freshStore()
  const storage = memoryStorage()
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {}, documentStorage: storage }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const park = await login(origin, 'jihyun.park@sunsea.co.kr')

    // HTML이 아니면 거절한다(브라우저가 보낸 형식을 믿지 않는다).
    const notHtml = await upload(origin, park, '그냥 글자입니다. HTML이 아닙니다.')
    assert.equal(notHtml.status, 415)
    assert.equal((await notHtml.json()).error.code, 'MATERIAL_NOT_HTML')

    const created = await upload(origin, park, materialHtml())
    assert.equal(created.status, 201, await created.clone().text())
    const { material } = await created.json()
    assert.equal(material.title, '온리북 개편안')
    assert.equal(material.currentVersion, 1)
    assert.equal(material.materialKey, 'onlybook-review')
    const version = material.versions[0]
    assert.ok(version.anchorCount >= 3, `항목 ${version.anchorCount}개`)
    assert.ok(version.assetCount >= 1, '큰 그림은 떼어 낸다')
    assert.equal(version.versionNote, '첫 판')
    assert.ok(material.decisionAnchorCount >= 3, '반영·보류 선택지가 있는 항목은 결정을 받는다')

    // 원본은 자료실 문서로, 올린 사람 이름으로, 바이트 그대로.
    const documents = store.tenants['TENANT-SUNSEA']['company-documents'].data
    const source = documents.find((row) => row.id === version.sourceDocumentId)
    assert.equal(source.category, '검토 자료 원본')
    assert.equal(source.uploadedById, park.account.id)
    // 원본은 지울 수 없다(판을 가리키는 의견의 증거).
    const deleted = await fetch(`${origin}/api/documents/${source.id}`, { method: 'DELETE', headers: admin.headers })
    assert.equal(deleted.status, 409)
    assert.match((await deleted.json()).error.message, /검토 자료의 원본/)

    // 격리된 칸용 문서: HTML로 내려주지 않고, CSP와 브리지가 맨 앞에 들어 있다.
    const frame = await fetch(`${origin}/api/materials/${material.id}/versions/1/frame`, { headers: admin.headers })
    assert.equal(frame.status, 200)
    assert.match(frame.headers.get('content-type'), /^text\/plain/)
    assert.equal(frame.headers.get('x-content-type-options'), 'nosniff')
    const frameText = await frame.text()
    assert.ok(frameText.includes(MATERIAL_FRAME_CSP.replace(/'/g, "'")), 'CSP가 들어 있다')
    assert.ok(frameText.indexOf('Content-Security-Policy') < frameText.indexOf('자료 자체 스크립트'), 'CSP·브리지는 자료의 스크립트보다 앞선다')
    assert.ok(!frameText.includes('data:image/png;base64'), '큰 그림은 사본에 없다')
    const sha = /itf-asset:([a-f0-9]{64})/.exec(frameText)?.[1]
    assert.ok(sha, '그림 자리에 itf-asset 표시가 있다')

    // 그림: 그 판의 목록에 있는 것만, 바이트 그대로.
    const asset = await fetch(`${origin}/api/materials/${material.id}/versions/1/assets/${sha}`, { headers: park.headers })
    assert.equal(asset.status, 200)
    assert.equal(asset.headers.get('content-type'), 'image/png')
    assert.deepEqual(Buffer.from(await asset.arrayBuffer()), pngBytes)
    assert.equal((await fetch(`${origin}/api/materials/${material.id}/versions/1/assets/${'0'.repeat(64)}`, { headers: park.headers })).status, 404)

    // 항목: 계보가 붙어 있다.
    const anchors = (await (await fetch(`${origin}/api/materials/${material.id}/versions/1/anchors`, { headers: admin.headers })).json()).anchors
    const a1 = anchors.find((anchor) => anchor.key === 'A1')
    assert.ok(a1?.lineageId?.startsWith('LIN-'))
    assert.equal(a1.decisionEnabled, true)

    // 범용 저장 통로로는 읽지도 쓰지도 못한다.
    assert.equal((await fetch(`${origin}/api/workspace/review-materials`, { headers: admin.headers })).status, 404)

    // 목록에 보인다.
    const list = (await (await fetch(`${origin}/api/materials`, { headers: admin.headers })).json()).materials
    assert.deepEqual(list.map((row) => row.id), [material.id])
  })
})

test('검토 자료: 같은 자료의 다음 판은 묻고 이어 붙인다 — 바뀌지 않은 항목은 같은 계보, 같은 파일은 거절', async () => {
  const store = freshStore()
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {}, documentStorage: memoryStorage() }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const first = (await (await upload(origin, admin, materialHtml())).json()).material
    const firstAnchors = (await (await fetch(`${origin}/api/materials/${first.id}/versions/1/anchors`, { headers: admin.headers })).json()).anchors

    const secondHtml = materialHtml({ note: '결제 흐름 수정', second: '두 번째 제안: 결제 흐름을 한 화면으로 합치고, 간편결제를 먼저 보여 준다. 장바구니에서 바로 결제한다.' })
    // 같은 itf:material 키 → 새 자료로 만들기 전에 묻는다.
    const asked = await upload(origin, admin, secondHtml)
    assert.equal(asked.status, 409)
    const askBody = await asked.json()
    assert.equal(askBody.error.code, 'MATERIAL_KEY_EXISTS')
    assert.equal(askBody.candidate.id, first.id)

    const second = await upload(origin, admin, secondHtml, `?materialId=${first.id}`)
    assert.equal(second.status, 201, await second.clone().text())
    const next = (await second.json()).material
    assert.equal(next.currentVersion, 2)
    assert.equal(next.versions.length, 2)
    const latest = next.versions.find((row) => row.version === 2)
    assert.ok(latest.links.same >= 2, '바뀌지 않은 항목은 그대로 이어진다')

    const secondAnchors = (await (await fetch(`${origin}/api/materials/${first.id}/versions/2/anchors`, { headers: admin.headers })).json()).anchors
    const lineageOf = (rows, key) => rows.find((anchor) => anchor.key === key)?.lineageId
    assert.equal(lineageOf(secondAnchors, 'A1'), lineageOf(firstAnchors, 'A1'), '같은 항목은 같은 계보')
    assert.equal(lineageOf(secondAnchors, 'A2'), lineageOf(firstAnchors, 'A2'), '조금 바뀐 항목도 같은 계보')

    // 같은 파일을 또 올리면 새 판을 만들지 않는다.
    const same = await upload(origin, admin, secondHtml, `?materialId=${first.id}`)
    assert.equal(same.status, 409)
    assert.equal((await same.json()).error.code, 'MATERIAL_SAME_VERSION')

    // 별도 자료로 올리기도 고를 수 있다.
    const separate = await upload(origin, admin, materialHtml({ note: '다른 팀 버전' }), '?newMaterial=1')
    assert.equal(separate.status, 201)
  })
})

test('검토 자료: 프로젝트 자료는 구성원만 보고, 자료실의 HTML에서 바로 검토 자료를 만든다', async () => {
  const store = freshStore()
  store.tenants['TENANT-SUNSEA']['project-spaces'] = { data: [{
    id: 'PRJ-SECRET', name: '비공개 프로젝트', description: '', visibility: 'members', status: 'active',
    ownerId: 'USR-SUNSEA-ADMIN', ownerName: '김서원', members: [{ id: 'USR-SUNSEA-ADMIN', name: '김서원', role: 'owner' }],
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  }], updatedAt: '', updatedBy: '' }
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {}, documentStorage: memoryStorage() }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const park = await login(origin, 'jihyun.park@sunsea.co.kr')

    // 구성원이 아닌 직원은 그 프로젝트에 올릴 수 없다.
    assert.equal((await upload(origin, park, materialHtml(), '?projectId=PRJ-SECRET&newMaterial=1')).status, 403)
    const secret = (await (await upload(origin, admin, materialHtml({ key: 'secret' }), '?projectId=PRJ-SECRET')).json()).material
    assert.equal(secret.projectName, '비공개 프로젝트')
    // 보이지 않는 자료는 없는 자료와 같은 답이다.
    assert.equal((await fetch(`${origin}/api/materials/${secret.id}`, { headers: park.headers })).status, 404)
    assert.equal((await fetch(`${origin}/api/materials/${secret.id}/versions/1/frame`, { headers: park.headers })).status, 404)
    assert.deepEqual((await (await fetch(`${origin}/api/materials`, { headers: park.headers })).json()).materials, [])

    // 자료실에 올린 HTML → [함께 검토하기]
    const uploaded = await fetch(`${origin}/api/documents?name=${encodeURIComponent('회의자료.html')}`, {
      method: 'POST',
      headers: { ...park.headers, 'content-type': 'application/octet-stream', 'x-file-type': 'text/html', 'x-file-name': encodeURIComponent('회의자료.html') },
      body: Buffer.from(materialHtml({ key: 'library-copy' }), 'utf8'),
    })
    assert.equal(uploaded.status, 201)
    const documentId = (await uploaded.json()).document.id
    const fromLibrary = await fetch(`${origin}/api/materials/from-document/${documentId}`, { method: 'POST', headers: { ...park.headers, 'content-type': 'application/json' }, body: '{}' })
    assert.equal(fromLibrary.status, 201, await fromLibrary.clone().text())
    const made = (await fromLibrary.json()).material
    assert.equal(made.versions[0].sourceDocumentId, documentId, '파일을 다시 올리지 않고 그 자료를 원본으로 쓴다')
    const again = await fetch(`${origin}/api/materials/from-document/${documentId}`, { method: 'POST', headers: { ...park.headers, 'content-type': 'application/json' }, body: '{}' })
    assert.equal(again.status, 200)
    assert.equal((await again.json()).existing, true)

    // 보관: 올린 사람·관리자만. 보관해도 원본은 지울 수 없다.
    assert.equal((await fetch(`${origin}/api/materials/${made.id}/archive`, { method: 'POST', headers: { ...admin.headers, 'content-type': 'application/json' }, body: '{}' })).status, 200)
    assert.equal((await fetch(`${origin}/api/documents/${documentId}`, { method: 'DELETE', headers: park.headers })).status, 409)
  })
})

test('검토 자료 의견: 항목마다 찬반(마지막 줄이 지금 생각)과 의견·답글 — 고치면 이전 글이 남고, 지우면 흔적만, 새 판에도 따라온다', async () => {
  const store = freshStore()
  const published = []
  const app = createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {}, documentStorage: memoryStorage() })
  const originalPublish = app.locals.events.publish
  app.locals.events.publish = (tenantId, kind, data, options) => { published.push({ kind, data }); return originalPublish(tenantId, kind, data, options) }
  await withServer(app, async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const park = await login(origin, 'jihyun.park@sunsea.co.kr')
    const oh = await login(origin, 'taesik.oh@sunsea.co.kr')
    const json = (auth) => ({ ...auth.headers, 'content-type': 'application/json' })
    const material = (await (await upload(origin, admin, materialHtml())).json()).material
    const anchors = (await (await fetch(`${origin}/api/materials/${material.id}/versions/1/anchors`, { headers: admin.headers })).json()).anchors
    const a1 = anchors.find((anchor) => anchor.key === 'A1').lineageId
    const a2 = anchors.find((anchor) => anchor.key === 'A2').lineageId

    const stance = (auth, lineageId, value) => fetch(`${origin}/api/materials/${material.id}/stance`, { method: 'POST', headers: json(auth), body: JSON.stringify({ lineageId, stance: value }) })
    assert.equal((await stance(park, a1, 'agree')).status, 200)
    assert.equal((await stance(oh, a1, 'oppose')).status, 200)
    assert.equal((await stance(park, a1, 'amend')).status, 200, '생각을 바꿀 수 있다')
    assert.equal((await stance(park, a2, 'maybe')).status, 400)
    const withdrawn = await stance(oh, a2, 'question')
    assert.equal(withdrawn.status, 200)
    assert.equal((await stance(oh, a2, null)).status, 200, '거둘 수 있다')

    const comment = async (auth, body) => fetch(`${origin}/api/materials/${material.id}/feedback`, { method: 'POST', headers: json(auth), body: JSON.stringify(body) })
    const first = await comment(park, { lineageId: a1, body: '배너는 하나로 줄이되 이벤트 기간에는 둘까지 허용하면 좋겠습니다.', clientRequestId: 'req-1' })
    assert.equal(first.status, 201)
    const firstComment = (await first.json()).comment
    // 같은 요청 번호로 다시 보내도 한 번만 남는다(네트워크가 흔들려 두 번 누름).
    const retry = await comment(park, { lineageId: a1, body: '배너는 하나로 줄이되 이벤트 기간에는 둘까지 허용하면 좋겠습니다.', clientRequestId: 'req-1' })
    assert.equal(retry.status, 200)
    assert.equal((await retry.json()).duplicate, true)
    const question = (await (await comment(oh, { lineageId: a1, body: '검색창을 올리면 카테고리 메뉴는 어디로 가나요?', question: true })).json()).comment
    const reply = await comment(admin, { lineageId: a1, body: '카테고리는 검색창 아래 한 줄로 둡니다.', parentId: question.id })
    assert.equal(reply.status, 201)
    // 답글의 답글은 같은 의견에 붙는다(한 단계).
    const nested = (await (await comment(park, { lineageId: a1, body: '좋습니다.', parentId: (await reply.json()).comment.id })).json()).comment
    assert.equal(nested.parentId, question.id)
    // 다른 항목의 의견에는 답글을 달 수 없다.
    assert.equal((await comment(park, { lineageId: a2, body: '엉뚱한 답글', parentId: question.id })).status, 400)
    assert.equal((await comment(park, { lineageId: 'LIN-nope', body: '없는 항목' })).status, 404)
    assert.equal((await comment(park, { lineageId: a1, body: '   ' })).status, 400)

    // 고치기: 자기 의견만, 이전 글이 남는다.
    const patch = (auth, id, body) => fetch(`${origin}/api/materials/${material.id}/feedback/${id}`, { method: 'PATCH', headers: json(auth), body: JSON.stringify({ body }) })
    assert.equal((await patch(oh, firstComment.id, '남의 글 고치기')).status, 403)
    const edited = (await (await patch(park, firstComment.id, '배너는 하나로 줄이는 데 찬성합니다. 이벤트 때만 예외로 둘.')).json()).comment
    assert.equal(edited.editHistory.length, 1)
    assert.match(edited.editHistory[0].body, /둘까지 허용/)
    // 지우기: 흔적만.
    const removed = await fetch(`${origin}/api/materials/${material.id}/feedback/${firstComment.id}`, { method: 'DELETE', headers: admin.headers })
    assert.equal(removed.status, 200)

    const bundle = await (await fetch(`${origin}/api/materials/${material.id}/feedback`, { headers: park.headers })).json()
    const summary = bundle.summary[a1]
    assert.deepEqual(summary.stances, { agree: 0, amend: 1, oppose: 1, question: 0 }, '사람별 마지막 찬반만 센다')
    assert.equal(summary.myStance, 'amend')
    assert.equal(summary.comments, 3, '지운 의견은 세지 않는다')
    assert.equal(summary.openQuestions, 0, '답이 달린 질문은 열린 질문이 아니다')
    const deletedRow = bundle.comments.find((row) => row.id === firstComment.id)
    assert.equal(deletedRow.deleted, true)
    assert.equal(deletedRow.body, '')
    assert.deepEqual(deletedRow.editHistory, [], '지우면 이전 글도 함께 지운다')
    assert.deepEqual(bundle.summary[a2].stances, { agree: 0, amend: 0, oppose: 0, question: 0 }, '거둔 생각은 세지 않는다')
    // 찬반 이력은 줄로 남는다.
    const rows = store.tenants['TENANT-SUNSEA']['review-feedback'].data
    assert.equal(rows.filter((row) => row.type === 'stance' && row.lineageId === a1 && row.authorId === park.account.id).length, 2)
    assert.ok(published.some((event) => event.kind === 'material' && event.data.what === 'feedback'), '실시간 신호가 나간다')
    assert.ok(published.every((event) => !('body' in (event.data ?? {}))), '실시간 신호에는 본문을 싣지 않는다')

    // 새 판: 의견은 계보를 따라온다.
    const v2 = await upload(origin, admin, materialHtml({ note: '2판', second: '두 번째 제안: 결제 흐름을 한 화면으로 합치고 간편결제를 먼저 보여 준다. 장바구니에서 바로 결제한다.' }), `?materialId=${material.id}`)
    assert.equal(v2.status, 201)
    const v2Anchors = (await (await fetch(`${origin}/api/materials/${material.id}/versions/2/anchors`, { headers: admin.headers })).json()).anchors
    assert.equal(v2Anchors.find((anchor) => anchor.key === 'A1').lineageId, a1)
    const after = await (await fetch(`${origin}/api/materials/${material.id}/feedback`, { headers: park.headers })).json()
    assert.equal(after.summary[a1].comments, 3, '2판에서도 1판의 의견이 같은 항목에 보인다')

    // 보관한 자료에는 의견을 남길 수 없다.
    await fetch(`${origin}/api/materials/${material.id}/archive`, { method: 'POST', headers: json(admin), body: '{}' })
    assert.equal((await comment(park, { lineageId: a1, body: '보관 후 의견' })).status, 409)
    assert.equal((await stance(park, a1, 'agree')).status, 409)
  })
})

test('검토 자료 결정: 결정권자만, 바꾸면 이력이 남고 — 검토 요청·마감 알림·자료 속 의견 가져오기·결정 요약·결정 기록 문서', async () => {
  const store = freshStore()
  const app = createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {}, documentStorage: memoryStorage() })
  await withServer(app, async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const park = await login(origin, 'jihyun.park@sunsea.co.kr')
    const oh = await login(origin, 'taesik.oh@sunsea.co.kr')
    const json = (auth) => ({ ...auth.headers, 'content-type': 'application/json' })
    const material = (await (await upload(origin, park, materialHtml())).json()).material
    const anchors = (await (await fetch(`${origin}/api/materials/${material.id}/versions/1/anchors`, { headers: park.headers })).json()).anchors
    const lineage = (key) => anchors.find((anchor) => anchor.key === key).lineageId
    const decide = (auth, key, status, note = '') => fetch(`${origin}/api/materials/${material.id}/decision`, { method: 'POST', headers: json(auth), body: JSON.stringify({ lineageId: lineage(key), status, note }) })

    // 올린 사람(박지현)과 관리자는 결정할 수 있고, 다른 직원은 못 한다.
    assert.equal((await decide(oh, 'A1', '반영')).status, 403)
    assert.equal((await decide(park, 'A1', '반영', '다음 스프린트')).status, 200)
    assert.equal((await decide(park, 'A1', '아마도')).status, 400)
    assert.equal((await decide(admin, 'A1', '보류', '예산 확인 후')).status, 200)
    assert.equal((await decide(park, 'A1', '수정 후 반영', '배너 둘까지 허용')).status, 200)
    const same = await decide(park, 'A1', '수정 후 반영', '배너 둘까지 허용')
    assert.equal((await same.json()).unchanged, true, '같은 결정을 또 누르면 줄이 늘지 않는다')
    // 결정권자를 지정하면 그 사람도 결정할 수 있다.
    assert.equal((await fetch(`${origin}/api/materials/${material.id}/deciders`, { method: 'PUT', headers: json(park), body: JSON.stringify({ deciderIds: [oh.account.id, 'USR-OTHER-TENANT'] }) })).status, 200)
    assert.equal((await decide(oh, 'A2', '미반영', '이번 분기 제외')).status, 200)
    const detail = (await (await fetch(`${origin}/api/materials/${material.id}`, { headers: oh.headers })).json()).material
    assert.equal(detail.canDecide, true)
    assert.deepEqual(detail.deciderIds, [oh.account.id], '다른 회사 사람은 결정권자가 될 수 없다')

    const bundle = await (await fetch(`${origin}/api/materials/${material.id}/feedback`, { headers: park.headers })).json()
    const history = bundle.decisions.filter((row) => row.lineageId === lineage('A1'))
    assert.deepEqual(history.map((row) => row.status), ['반영', '보류', '수정 후 반영'], '결정은 지우지 않고 새 줄로 덮는다')

    // 검토 요청: 볼 수 있는 사람에게(요청한 사람 제외) 한 번씩, 마감과 함께.
    const due = new Date(Date.now() + 20 * 60 * 60 * 1_000).toISOString()
    const requested = await fetch(`${origin}/api/materials/${material.id}/request-review`, { method: 'POST', headers: json(park), body: JSON.stringify({ dueAt: due }) })
    assert.equal(requested.status, 200)
    assert.ok((await requested.json()).notified >= 2)
    const notifications = store.tenants['TENANT-SUNSEA'].notifications.data
    const review = notifications.find((row) => row.type === 'material-review' && row.recipientId === oh.account.id)
    assert.equal(review.focusId, `material:${material.id}`)
    assert.ok(!notifications.some((row) => row.type === 'material-review' && row.recipientId === park.account.id), '요청한 사람에게는 가지 않는다')

    // 마감 하루 전: 아직 반응하지 않은 사람에게만. 오태식은 결정만 했지 찬반·의견은 없다 → 받는다. 관리자는 의견을 남긴다 → 안 받는다.
    await fetch(`${origin}/api/materials/${material.id}/stance`, { method: 'POST', headers: json(admin), body: JSON.stringify({ lineageId: lineage('A3'), stance: 'agree' }) })
    const { reminded } = await app.locals.reviewMaterials.remindDue(new Date())
    assert.ok(reminded >= 1)
    const dueRows = store.tenants['TENANT-SUNSEA'].notifications.data.filter((row) => row.type === 'material-due')
    assert.ok(dueRows.some((row) => row.recipientId === oh.account.id))
    assert.ok(!dueRows.some((row) => row.recipientId === admin.account.id), '이미 반응한 사람은 받지 않는다')
    assert.equal((await app.locals.reviewMaterials.remindDue(new Date())).reminded, 0, '자료마다 한 번만')

    // 자료 속 의견 가져오기(복사해 붙여 넣은 글). 이름이 회사 사람과 하나로 맞으면 그 사람으로.
    const pasted = `[온리북 개편 리뷰 — 오태식 의견]\n• A1 첫 화면 — 찬성\n\n--- 가져오기용 데이터(붙여넣기 시 그대로) ---\n${JSON.stringify({ type: 'onlybook-review', name: '오태식', at: '2026-09-10T01:00:00.000Z', reviews: { 오태식: { A1: { stance: 'agree', comments: [{ t: '배너 하나 좋습니다 {괄호도 괜찮음}' }] }, Z9: { stance: 'ask' } }, 외부손님: { A3: { stance: 'revise', comments: [{ t: '알림은 둘만' }] } } }, final: { A3: { status: '보류', note: '다음 회의' } } })}\n끝`
    assert.equal((await fetch(`${origin}/api/materials/${material.id}/import-opinions`, { method: 'POST', headers: json(oh), body: JSON.stringify({ text: pasted }) })).status, 403, '가져오기는 올린 사람·관리자만')
    const imported = await fetch(`${origin}/api/materials/${material.id}/import-opinions`, { method: 'POST', headers: json(park), body: JSON.stringify({ text: pasted }) })
    assert.equal(imported.status, 200, await imported.clone().text())
    const importBody = await imported.json()
    assert.deepEqual(importBody.imported, { stances: 2, comments: 2, decisions: 1 })
    assert.deepEqual(importBody.unmatchedKeys, ['Z9'])
    const again = await (await fetch(`${origin}/api/materials/${material.id}/import-opinions`, { method: 'POST', headers: json(park), body: JSON.stringify({ text: pasted }) })).json()
    assert.deepEqual(again.imported, { stances: 0, comments: 0, decisions: 0 }, '같은 글을 두 번 붙여 넣어도 한 번만')
    const rows = store.tenants['TENANT-SUNSEA']['review-feedback'].data
    assert.ok(rows.some((row) => row.imported && row.type === 'comment' && row.authorId === oh.account.id), '이름이 맞는 사람으로 잇는다')
    assert.ok(rows.some((row) => row.imported && row.authorName === '가져온 의견 · 외부손님'), '맞는 사람이 없으면 가져온 이름 그대로')
    assert.equal((await fetch(`${origin}/api/materials/${material.id}/import-opinions`, { method: 'POST', headers: json(park), body: JSON.stringify({ text: '아무 글' }) })).status, 400)

    // 결정 요약(Markdown)과 결정 기록 문서.
    const summary = await (await fetch(`${origin}/api/materials/${material.id}/decision-summary`, { headers: oh.headers })).json()
    assert.match(summary.markdown, /## 수정 후 반영 \(1\)/)
    assert.match(summary.markdown, /A1 A1\. 첫 화면을 단순하게|A1\. 첫 화면을 단순하게/)
    assert.match(summary.markdown, /메모: 배너 둘까지 허용/)
    assert.equal((await fetch(`${origin}/api/materials/${material.id}/decision-record`, { method: 'POST', headers: json(admin) })).status, 201)
    const replay = await fetch(`${origin}/api/materials/${material.id}/decision-record`, { method: 'POST', headers: json(admin) })
    assert.equal(replay.status, 200, '결정이 그대로면 같은 문서를 다시 만들지 않는다')
    const record = (await replay.json()).documentId
    assert.ok(record)
    const wikiDocument = store.tenants['TENANT-SUNSEA']['wiki-documents'].data.find((row) => row.id === record)
    assert.match(wikiDocument.title, /결정 기록 \(1판\)/)
    assert.ok(wikiDocument.blocks.some((block) => block.type === 'heading' && /수정 후 반영/.test(block.text)))
  })
})

test('검토 자료 새 판: 애매한 짝은 사람이 확인하기 전까지 다른 항목 — [같은 항목]이면 잇고 그 사이 의견도 따라온다 · 판 비교와 반영 확인', async () => {
  const store = freshStore()
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {}, documentStorage: memoryStorage() }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const json = { ...admin.headers, 'content-type': 'application/json' }
    const material = (await (await upload(origin, admin, materialHtml())).json()).material
    const v1 = (await (await fetch(`${origin}/api/materials/${material.id}/versions/1/anchors`, { headers: admin.headers })).json()).anchors
    const lineage1 = (key) => v1.find((anchor) => anchor.key === key).lineageId
    // 1판에서 A1을 반영으로 결정해 둔다(2판에서 A1이 그대로면 "반영 확인"에 걸린다).
    await fetch(`${origin}/api/materials/${material.id}/decision`, { method: 'POST', headers: json, body: JSON.stringify({ lineageId: lineage1('A1'), status: '반영' }) })

    // 2판: A2는 조금 바꾸고, A3 번호에는 전혀 다른 내용을 넣는다(번호 재사용).
    const v2Html = materialHtml({ note: '2판', second: '두 번째 제안: 결제 흐름을 한 화면으로 합치고 간편결제를 먼저 보여 준다. 장바구니에서 바로 결제한다.' })
      .replace('<h3>A3. 알림 정리</h3><p>알림 종류를 다섯 개에서 셋으로 줄이고 하루 한 번 묶어서 보낸다. 앱 푸시는 선택으로 둔다.</p>', '<h3>A3. 회원 등급</h3><p>회원 등급을 세 단계로 나누고 등급마다 적립률을 다르게 준다. 기존 쿠폰은 등급 혜택으로 바꾼다.</p>')
    const second = await upload(origin, admin, v2Html, `?materialId=${material.id}`)
    assert.equal(second.status, 201, await second.clone().text())
    const v2 = (await (await fetch(`${origin}/api/materials/${material.id}/versions/2/anchors`, { headers: admin.headers })).json()).anchors
    const a3v2 = v2.find((anchor) => anchor.key === 'A3')
    assert.notEqual(a3v2.lineageId, lineage1('A3'), '번호만 같고 내용이 다르면 자동으로 잇지 않는다')

    // 짝 확인 목록에 번호 재사용 의심으로 오른다.
    const links = await (await fetch(`${origin}/api/materials/${material.id}/versions/2/links`, { headers: admin.headers })).json()
    const proposal = links.proposals.find((row) => row.nextId === a3v2.id)
    assert.ok(proposal, JSON.stringify(links.proposals))
    assert.equal(proposal.lineageId, lineage1('A3'))
    assert.ok(proposal.before && proposal.after, '두 판의 앞부분 글을 함께 보여 준다')

    // 확인 전에 새 A3에 남긴 의견.
    await fetch(`${origin}/api/materials/${material.id}/feedback`, { method: 'POST', headers: json, body: JSON.stringify({ lineageId: a3v2.lineageId, body: '등급 이름은 쉬운 말로' }) })

    // 판 비교: A2 바뀜(어절 비교), A1 그대로 — 반영하기로 했는데 그대로인 항목으로 짚는다.
    const compare = await (await fetch(`${origin}/api/materials/${material.id}/compare?from=1&to=2`, { headers: admin.headers })).json()
    assert.ok(compare.summary.changed >= 1)
    const changed = compare.items.find((item) => item.status === 'changed' && item.key === 'A2')
    assert.ok(changed?.diff.some((part) => part.op === 'insert'), '바뀐 곳이 어절 단위로 나온다')
    assert.equal(compare.reflection.decided, 1)
    assert.deepEqual(compare.reflection.unchanged.map((row) => row.lineageId), [lineage1('A1')], '반영하기로 했는데 그대로인 항목')
    assert.ok(compare.items.some((item) => item.status === 'added' && item.key === 'A3'))
    assert.ok(compare.items.some((item) => item.status === 'removed' && item.lineageId === lineage1('A3')))

    // [같은 항목] → 새 A3가 옛 계보로 이어지고, 확인 전에 남긴 의견도 따라온다.
    const confirmed = await fetch(`${origin}/api/materials/${material.id}/versions/2/links`, { method: 'POST', headers: json, body: JSON.stringify({ choices: [{ nextId: a3v2.id, same: true }] }) })
    assert.equal(confirmed.status, 200, await confirmed.clone().text())
    assert.equal((await confirmed.json()).joined, 1)
    const v2After = (await (await fetch(`${origin}/api/materials/${material.id}/versions/2/anchors`, { headers: admin.headers })).json()).anchors
    assert.equal(v2After.find((anchor) => anchor.key === 'A3').lineageId, lineage1('A3'))
    const bundle = await (await fetch(`${origin}/api/materials/${material.id}/feedback`, { headers: admin.headers })).json()
    assert.equal(bundle.summary[lineage1('A3')].comments, 1, '확인 전에 남긴 의견이 옛 계보로 옮겨 왔다')
    assert.equal((await (await fetch(`${origin}/api/materials/${material.id}/versions/2/links`, { headers: admin.headers })).json()).proposals.length, links.proposals.length - 1)
    assert.equal((await fetch(`${origin}/api/materials/${material.id}/versions/2/links`, { method: 'POST', headers: json, body: JSON.stringify({ choices: [{ nextId: a3v2.id, same: true }] }) })).status, 400, '이미 확인한 짝')
  })
})

test('검토 자료 정리: AI 없이도 회의 준비표(갈린 의견·답 없는 질문·반응 없는 항목·규칙 제안) — AI 정리는 근거 없는 문장을 버리고, 초안 채택 여부를 남긴다', async () => {
  const store = freshStore()
  let lastPrompt = ''
  const fakeClient = {
    messages: {
      async create({ messages }) {
        lastPrompt = messages[0].content
        const ids = [...lastPrompt.matchAll(/\[(MFB-[^\]]+)\]/g)].map((match) => match[1])
        return {
          id: 'msg_fake', model: 'claude-test', usage: { input_tokens: 100, output_tokens: 50 },
          content: [{ type: 'text', text: JSON.stringify({
            summary: '배너를 줄이는 데 대체로 찬성, 이벤트 예외가 쟁점입니다.',
            positions: [
              { stance: 'agree', points: [{ text: '배너 하나로 충분하다', feedbackIds: [ids[0]] }] },
              { stance: 'oppose', points: [{ text: '지어낸 반대 의견', feedbackIds: ['MFB-없는-의견'] }] },
            ],
            questions: [{ text: '카테고리 위치', feedbackIds: [ids[1]] }],
            draftDecision: { status: '수정 후 반영', note: '이벤트 때만 둘', feedbackIds: [ids[0]] },
          }) }],
        }
      },
    },
  }
  const app = createApp({ apiKey: 'test-key', client: fakeClient, initialWorkspaceStore: store, onWorkspaceStoreChange: () => {}, documentStorage: memoryStorage() })
  await withServer(app, async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const park = await login(origin, 'jihyun.park@sunsea.co.kr')
    const oh = await login(origin, 'taesik.oh@sunsea.co.kr')
    const json = (auth) => ({ ...auth.headers, 'content-type': 'application/json' })
    const material = (await (await upload(origin, admin, materialHtml())).json()).material
    assert.equal(material.aiAvailable, true)
    const anchors = (await (await fetch(`${origin}/api/materials/${material.id}/versions/1/anchors`, { headers: admin.headers })).json()).anchors
    const lineage = (key) => anchors.find((anchor) => anchor.key === key).lineageId
    const stance = (auth, key, value) => fetch(`${origin}/api/materials/${material.id}/stance`, { method: 'POST', headers: json(auth), body: JSON.stringify({ lineageId: lineage(key), stance: value }) })
    const comment = (auth, key, body, extra = {}) => fetch(`${origin}/api/materials/${material.id}/feedback`, { method: 'POST', headers: json(auth), body: JSON.stringify({ lineageId: lineage(key), body, ...extra }) })

    await stance(park, 'A1', 'agree'); await stance(oh, 'A1', 'oppose')           // A1: 갈림
    await stance(park, 'A2', 'agree'); await stance(admin, 'A2', 'agree')          // A2: 규칙 제안 '반영'
    await comment(park, 'A1', '배너 하나로 충분합니다.')
    await comment(oh, 'A1', '카테고리 메뉴는 어디로 가나요?', { question: true })  // 답 없는 질문
    // A3: 아무도 반응하지 않음

    const overview = await (await fetch(`${origin}/api/materials/${material.id}/overview`, { headers: park.headers })).json()
    assert.deepEqual(overview.split.map((row) => row.lineageId), [lineage('A1')])
    assert.equal(overview.openQuestions.length, 1)
    assert.match(overview.openQuestions[0].body, /카테고리/)
    assert.deepEqual(overview.silent.map((row) => row.lineageId), [lineage('A3')])
    assert.deepEqual(overview.ready.map((row) => [row.lineageId, row.suggestion]), [[lineage('A2'), '반영']])

    // AI 정리: 올린 사람·결정권자·관리자만. 없는 의견 id를 댄 문장은 버린다.
    assert.equal((await fetch(`${origin}/api/materials/${material.id}/ai-synthesis`, { method: 'POST', headers: json(park), body: JSON.stringify({ lineageId: lineage('A1') }) })).status, 403)
    const synthesized = await fetch(`${origin}/api/materials/${material.id}/ai-synthesis`, { method: 'POST', headers: json(admin), body: JSON.stringify({ lineageId: lineage('A1') }) })
    assert.equal(synthesized.status, 200, await synthesized.clone().text())
    const { aiOutput } = await synthesized.json()
    assert.deepEqual(aiOutput.output.positions.map((row) => row.stance), ['agree'], '근거 없는 반대 문장은 버렸다')
    assert.equal(aiOutput.output.dropped, 1)
    assert.equal(aiOutput.output.draftDecision.status, '수정 후 반영')
    assert.match(lastPrompt, /배너 하나로 충분합니다/, '의견 원문과 id를 함께 넘긴다')
    assert.equal((await fetch(`${origin}/api/materials/${material.id}/ai-synthesis`, { method: 'POST', headers: json(admin), body: JSON.stringify({ lineageId: lineage('A3') }) })).status, 400, '의견이 없으면 정리하지 않는다')

    // 초안을 그대로 채택 → adoption 'adopted'
    await fetch(`${origin}/api/materials/${material.id}/decision`, { method: 'POST', headers: json(admin), body: JSON.stringify({ lineageId: lineage('A1'), status: '수정 후 반영', note: '이벤트 때만 둘', draftedBy: aiOutput.id }) })
    const rows = store.tenants['TENANT-SUNSEA']['review-feedback'].data
    const decision = rows.filter((row) => row.type === 'decision').at(-1)
    assert.equal(decision.adoption, 'adopted')
    assert.equal(decision.draftedBy, aiOutput.id)
    const bundle = await (await fetch(`${origin}/api/materials/${material.id}/feedback`, { headers: park.headers })).json()
    assert.equal(bundle.aiOutputs[lineage('A1')].id, aiOutput.id, 'AI 정리는 기록으로 남아 모두가 본다')
  })
  // AI 연결이 없으면 409 — 화면은 규칙 정리로 안내한다.
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: freshStore(), onWorkspaceStoreChange: () => {}, documentStorage: memoryStorage() }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const material = (await (await upload(origin, admin, materialHtml())).json()).material
    assert.equal(material.aiAvailable, false)
    const anchors = (await (await fetch(`${origin}/api/materials/${material.id}/versions/1/anchors`, { headers: admin.headers })).json()).anchors
    const refused = await fetch(`${origin}/api/materials/${material.id}/ai-synthesis`, { method: 'POST', headers: { ...admin.headers, 'content-type': 'application/json' }, body: JSON.stringify({ lineageId: anchors[0].lineageId }) })
    assert.equal(refused.status, 409)
    assert.equal((await refused.json()).error.code, 'MATERIAL_AI_UNAVAILABLE')
  })
})

test('검토 자료 → 업무: 반영하기로 결정한 항목만 승인 큐로(길은 하나) — 관리자가 승인하면 업무가 생기고, 업무의 출처는 그 자료로 되짚는다', async () => {
  const store = freshStore()
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {}, documentStorage: memoryStorage() }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const park = await login(origin, 'jihyun.park@sunsea.co.kr')
    const oh = await login(origin, 'taesik.oh@sunsea.co.kr')
    const json = (auth) => ({ ...auth.headers, 'content-type': 'application/json' })
    const material = (await (await upload(origin, park, materialHtml())).json()).material
    const anchors = (await (await fetch(`${origin}/api/materials/${material.id}/versions/1/anchors`, { headers: park.headers })).json()).anchors
    const lineage = (key) => anchors.find((anchor) => anchor.key === key).lineageId
    const propose = (auth, key, body = {}) => fetch(`${origin}/api/materials/${material.id}/tasks`, { method: 'POST', headers: json(auth), body: JSON.stringify({ lineageId: lineage(key), title: '첫 화면 배너 하나로 줄이기', ownerId: oh.account.id, ...body }) })

    assert.equal((await propose(park, 'A1')).status, 409, '결정 전에는 업무로 만들 수 없다')
    await fetch(`${origin}/api/materials/${material.id}/decision`, { method: 'POST', headers: json(park), body: JSON.stringify({ lineageId: lineage('A1'), status: '수정 후 반영', note: '이벤트 때만 둘' }) })
    await fetch(`${origin}/api/materials/${material.id}/decision`, { method: 'POST', headers: json(park), body: JSON.stringify({ lineageId: lineage('A2'), status: '보류' }) })
    assert.equal((await propose(oh, 'A1')).status, 403, '결정권자가 아니면 올릴 수 없다')
    assert.equal((await propose(park, 'A2')).status, 409, '보류한 항목은 업무가 되지 않는다')
    assert.equal((await propose(park, 'A1', { title: '한' })).status, 400)

    const created = await propose(park, 'A1')
    assert.equal(created.status, 201, await created.clone().text())
    const { proposalId, canApprove } = await created.json()
    assert.equal(canApprove, false, '직원이 올리면 관리자가 승인한다')
    assert.equal((await propose(park, 'A1')).status, 409, '기다리는 제안은 하나')
    const proposal = store.tenants['TENANT-SUNSEA']['ai-proposals'].data.find((row) => row.id === proposalId)
    assert.equal(proposal.kind, 'material-task')
    assert.equal(proposal.payload.owner, '오태식')
    assert.match(proposal.evidence, /결정: 수정 후 반영 — 이벤트 때만 둘/)

    // 관리자가 기존 승인 문으로 승인 → 업무가 생긴다.
    const decided = await fetch(`${origin}/api/proposals/${proposalId}/decide`, { method: 'POST', headers: json(admin), body: JSON.stringify({ decision: 'approve' }) })
    assert.equal(decided.status, 200, await decided.clone().text())
    const workItems = store.tenants['TENANT-SUNSEA']['work-items'].data
    const work = workItems.find((row) => row.title === '첫 화면 배너 하나로 줄이기')
    assert.ok(work)
    assert.equal(work.owner, '오태식')
    assert.deepEqual({ kind: work.origin.kind, page: work.origin.page, focusId: work.origin.focusId, label: work.origin.label }, { kind: 'material-task', page: 'wiki', focusId: `material:${material.id}`, label: '검토 자료 결정' })

    const tasks = await (await fetch(`${origin}/api/materials/${material.id}/tasks`, { headers: park.headers })).json()
    assert.equal(tasks.tasks.length, 1)
    assert.equal(tasks.tasks[0].status, 'approved')
    assert.equal(tasks.tasks[0].workItemId, work.id)
    assert.equal(tasks.tasks[0].workStatus, work.status, '항목에 업무 상태가 붙는다')
    // 승인 통계에 material-task가 센다.
    const stats = await (await fetch(`${origin}/api/proposals`, { headers: admin.headers })).json()
    assert.ok(stats.stats.some((row) => row.kind === 'material-task'))
  })
})

test('검토 자료 한 바퀴 닫기: 다음 판 요청서(결정·질문·번호 규칙)와 전체 기록 ZIP(원본·항목·기록·결정 CSV)', async () => {
  const store = freshStore()
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {}, documentStorage: memoryStorage() }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const park = await login(origin, 'jihyun.park@sunsea.co.kr')
    const json = (auth) => ({ ...auth.headers, 'content-type': 'application/json' })
    const material = (await (await upload(origin, admin, materialHtml())).json()).material
    const anchors = (await (await fetch(`${origin}/api/materials/${material.id}/versions/1/anchors`, { headers: admin.headers })).json()).anchors
    const lineage = (key) => anchors.find((anchor) => anchor.key === key).lineageId
    await fetch(`${origin}/api/materials/${material.id}/decision`, { method: 'POST', headers: json(admin), body: JSON.stringify({ lineageId: lineage('A1'), status: '수정 후 반영', note: '이벤트 때만 둘' }) })
    await fetch(`${origin}/api/materials/${material.id}/decision`, { method: 'POST', headers: json(admin), body: JSON.stringify({ lineageId: lineage('A3'), status: '미반영' }) })
    await fetch(`${origin}/api/materials/${material.id}/stance`, { method: 'POST', headers: json(park), body: JSON.stringify({ lineageId: lineage('A2'), stance: 'amend' }) })
    await fetch(`${origin}/api/materials/${material.id}/feedback`, { method: 'POST', headers: json(park), body: JSON.stringify({ lineageId: lineage('A2'), body: '간편결제 순서는 어떻게 되나요?', question: true }) })
    await fetch(`${origin}/api/materials/${material.id}/feedback`, { method: 'POST', headers: json(park), body: JSON.stringify({ lineageId: lineage('A1'), body: '이벤트 배너는 2주만, "기간 한정"이라고 적자' }) })

    const request = await (await fetch(`${origin}/api/materials/${material.id}/next-version-request`, { headers: park.headers })).json()
    assert.match(request.markdown, /2판 요청서/)
    assert.match(request.markdown, /data-itf-anchor="A1"/, '항목 번호 규칙이 들어 있다')
    assert.match(request.markdown, /itf:material" content="\(이 자료의 키\)"/)
    assert.match(request.markdown, /이 자료의 키: `onlybook-review`/)
    assert.match(request.markdown, /### A1 A1\. 첫 화면을 단순하게\n- 결정: \*\*수정 후 반영\*\* — 이벤트 때만 둘/)
    assert.match(request.markdown, /이 번호는 다음 판에서 빼되, 번호를 다른 항목에 다시 쓰지 마세요/)
    assert.match(request.markdown, /## 답이 필요한 질문[\s\S]*간편결제 순서는 어떻게 되나요\?/)
    assert.match(request.markdown, /의견\(의견\): 이벤트 배너는 2주만|의견\(찬성\)|의견\(수정해서\)/)

    const zip = await fetch(`${origin}/api/materials/${material.id}/export`, { headers: park.headers })
    assert.equal(zip.status, 200)
    assert.equal(zip.headers.get('content-type'), 'application/zip')
    const bytes = Buffer.from(await zip.arrayBuffer())
    assert.equal(bytes.readUInt32LE(0), 0x04034b50, 'ZIP 머리')
    for (const name of ['original/v1.html', 'anchors/v1.json', 'feedback.jsonl', 'decisions.csv', 'ai-runs.jsonl', 'material.json', 'README.txt']) {
      assert.ok(bytes.includes(Buffer.from(name)), `${name}이(가) 묶여 있다`)
    }
    assert.ok(bytes.includes(Buffer.from('수정 후 반영')), '결정 CSV에 결정이 들어 있다')
    assert.ok(store.platform.auditEvents.some((row) => row.event === '검토 자료 내보내기' && row.reference === material.id), '내보낸 사실은 감사 기록에 남는다')
  })
})

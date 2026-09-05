import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createApp } from './app.mjs'
import { withServer } from './test-server.mjs'

async function login(origin, email, workspace = 'tenant', password = 'demo1234') {
  const response = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace, email, password }) })
  return { response, cookie: response.headers.get('set-cookie') ?? '' }
}
const freshStore = () => ({ version: 2, tenants: { 'TENANT-SUNSEA': {}, 'TENANT-POHANG': {} }, platform: {}, accountApprovals: {}, accountCredentials: {}, invitedAccounts: [], passwordResetRequests: [], guestGrants: [] })
const json = (cookie, identity) => ({ 'content-type': 'application/json', cookie, ...(identity ? { 'x-workspace-identity': identity } : {}) })
const readJson = async (response) => { const text = await response.text(); try { return JSON.parse(text) } catch { return { raw: text } } }
const uploadDir = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onfactory-r7-')), 'documents')
const journalOf = (overrides) => ({
  id: `JR-${Math.random().toString(36).slice(2, 8)}`, date: '2026-08-24', title: '2026-08-24_박지현_업무일지', authorId: 'USR-SUNSEA-PARK', author: '박지현', department: '품질관리',
  completed: '• 냉장창고 온도 점검', issue: '', nextPlan: '', approver: '김서원', status: '임시저장', updatedAt: '2026-08-24T01:00:00.000Z', feedback: '', attachments: [], reviews: [],
  ...overrides,
})

test('journal: same author + same day is rejected; comments (text/file) are stored via dedicated route and survive generic PUT', async () => {
  const store = freshStore()
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {}, documentUploadDirectory: uploadDir() }), async (origin) => {
    const member = await login(origin, 'jihyun.park@sunsea.co.kr')
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const identity = 'TENANT-SUNSEA:USR-SUNSEA-PARK'
    const first = journalOf({ id: 'JR-DAY-1' })
    const put1 = await fetch(`${origin}/api/workspace/daily-journals`, { method: 'PUT', headers: json(member.cookie, identity), body: JSON.stringify({ data: [first] }) })
    assert.equal(put1.status, 200, await put1.text())
    // 같은 날 두 번째 일지 → 409 + 기존 일지 id 안내
    const duplicate = await fetch(`${origin}/api/workspace/daily-journals`, { method: 'PUT', headers: json(member.cookie, identity), body: JSON.stringify({ data: [first, journalOf({ id: 'JR-DAY-2' })] }) })
    assert.equal(duplicate.status, 409)
    const duplicateBody = await readJson(duplicate)
    assert.equal(duplicateBody.error.code, 'JOURNAL_DUPLICATE_DAY')
    assert.equal(duplicateBody.error.journalId, 'JR-DAY-1')
    // 자동 저장(draft)도 같은 규칙
    const draftDuplicate = await fetch(`${origin}/api/daily-journals/JR-DAY-3/draft`, { method: 'PUT', headers: json(member.cookie, identity), body: JSON.stringify({ journal: journalOf({ id: 'JR-DAY-3' }) }) })
    assert.equal(draftDuplicate.status, 409)
    // 다른 날짜는 허용
    const other = await fetch(`${origin}/api/workspace/daily-journals`, { method: 'PUT', headers: json(member.cookie, identity), body: JSON.stringify({ data: [first, journalOf({ id: 'JR-DAY-4', date: '2026-08-25', title: '2026-08-25_박지현_업무일지' })] }) })
    assert.equal(other.status, 200, await other.text())

    // 댓글: 관리자(결재자)가 파일과 함께 남김
    const upload = await fetch(`${origin}/api/documents?${new URLSearchParams({ name: '보완자료.pdf', category: '일일업무일지', visibility: 'restricted', tags: '' })}`, {
      method: 'POST', headers: { cookie: admin.cookie, 'content-type': 'application/octet-stream', 'x-file-type': 'application/pdf', 'x-file-name': encodeURIComponent('보완자료.pdf') }, body: Buffer.from('%PDF-1.4 comment'),
    })
    const uploaded = await readJson(upload)
    assert.equal(upload.status, 201, JSON.stringify(uploaded))
    const comment = await readJson(await fetch(`${origin}/api/daily-journals/JR-DAY-1/comments`, { method: 'POST', headers: json(admin.cookie), body: JSON.stringify({ text: 'LOT 번호를 보완해 주세요', attachments: [{ id: uploaded.document.id }] }) }))
    assert.equal(comment.comment?.author, '김서원', JSON.stringify(comment))
    assert.equal(comment.comment.attachments.length, 1)
    // 작성자(직원)는 첨부를 내려받을 수 있어야 한다 (접근 부여)
    const download = await fetch(`${origin}/api/documents/${uploaded.document.id}/download`, { headers: { cookie: member.cookie, 'x-workspace-identity': identity } })
    assert.equal(download.status, 200)
    // 빈 댓글 거부
    const empty = await fetch(`${origin}/api/daily-journals/JR-DAY-1/comments`, { method: 'POST', headers: json(member.cookie, identity), body: JSON.stringify({ text: '   ' }) })
    assert.equal(empty.status, 400)
    // 직원이 일반 PUT으로 댓글을 지워도 서버가 보존한다
    const stripped = { ...store.tenants['TENANT-SUNSEA']['daily-journals'].data.find((item) => item.id === 'JR-DAY-1') }
    delete stripped.comments
    const rewrite = await fetch(`${origin}/api/workspace/daily-journals`, { method: 'PUT', headers: json(member.cookie, identity), body: JSON.stringify({ data: [stripped, journalOf({ id: 'JR-DAY-4', date: '2026-08-25', title: '2026-08-25_박지현_업무일지' })] }) })
    assert.equal(rewrite.status, 200, await rewrite.text())
    const after = store.tenants['TENANT-SUNSEA']['daily-journals'].data.find((item) => item.id === 'JR-DAY-1')
    assert.equal(after.comments.length, 1)
    // 다른 직원은 댓글 불가
    const colleague = await login(origin, 'taesik.oh@sunsea.co.kr')
    const forbidden = await fetch(`${origin}/api/daily-journals/JR-DAY-1/comments`, { method: 'POST', headers: json(colleague.cookie, 'TENANT-SUNSEA:USR-SUNSEA-OH'), body: JSON.stringify({ text: '끼어들기' }) })
    assert.equal(forbidden.status, 403)
    // 댓글 삭제: 본인 또는 관리자
    const remove = await fetch(`${origin}/api/daily-journals/JR-DAY-1/comments/${comment.comment.id}`, { method: 'DELETE', headers: { cookie: admin.cookie } })
    assert.equal(remove.status, 200)
  })
})

test('profile: name/team/phone update persists and password change verifies the current password', async () => {
  const store = freshStore()
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {} }), async (origin) => {
    const member = await login(origin, 'jihyun.park@sunsea.co.kr')
    const bad = await fetch(`${origin}/api/me/profile`, { method: 'PATCH', headers: json(member.cookie), body: JSON.stringify({ name: '박' }) })
    assert.equal(bad.status, 400)
    const ok = await readJson(await fetch(`${origin}/api/me/profile`, { method: 'PATCH', headers: json(member.cookie), body: JSON.stringify({ name: '박지현', team: '품질보증', jobRole: '품질 팀장', phone: '010-1234-5678', bio: '오전 회의 후 연락 가능' }) }))
    assert.equal(ok.account.team, '품질보증')
    assert.equal(ok.account.phone, '010-1234-5678')
    const session = await readJson(await fetch(`${origin}/api/auth/session`, { headers: { cookie: member.cookie } }))
    assert.equal(session.account.jobRole, '품질 팀장')
    assert.ok(store.accounts.some((item) => item.id === 'USR-SUNSEA-PARK' && item.team === '품질보증'))
    // 비밀번호: 현재 비밀번호 틀리면 거부, 맞으면 변경 후 새 비밀번호로 로그인
    const wrong = await fetch(`${origin}/api/me/password`, { method: 'POST', headers: json(member.cookie), body: JSON.stringify({ currentPassword: 'nope', newPassword: 'Strong!Pass123' }) })
    assert.equal(wrong.status, 400)
    const changed = await fetch(`${origin}/api/me/password`, { method: 'POST', headers: json(member.cookie), body: JSON.stringify({ currentPassword: 'demo1234', newPassword: 'Strong!Pass123' }) })
    assert.equal(changed.status, 200, await changed.text())
    const relogin = await login(origin, 'jihyun.park@sunsea.co.kr', 'tenant', 'Strong!Pass123')
    assert.equal(relogin.response.status, 200)
  })
})

test('projects: membership-scoped visibility, role-based posting, comments with files, generic store access blocked', async () => {
  const store = freshStore()
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {}, documentUploadDirectory: uploadDir() }), async (origin) => {
    const owner = await login(origin, 'jihyun.park@sunsea.co.kr')
    const viewer = await login(origin, 'taesik.oh@sunsea.co.kr')
    const outsider = await login(origin, 'donghyun.seo@sunsea.co.kr')
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const ownerId = 'TENANT-SUNSEA:USR-SUNSEA-PARK', viewerId = 'TENANT-SUNSEA:USR-SUNSEA-OH', outsiderId = 'TENANT-SUNSEA:USR-SUNSEA-SEO'

    const created = await readJson(await fetch(`${origin}/api/projects`, { method: 'POST', headers: json(owner.cookie, ownerId), body: JSON.stringify({ name: 'HACCP 갱신', description: '2026 갱신 준비', visibility: 'members', members: [{ id: 'USR-SUNSEA-OH', role: 'viewer' }] }) }))
    assert.equal(created.project?.role, 'owner', JSON.stringify(created))
    const projectId = created.project.id
    assert.equal(created.project.members.length, 2)

    // 가시성: 멤버 아닌 직원에게는 보이지 않음, 관리자는 전체
    const outsiderList = await readJson(await fetch(`${origin}/api/projects`, { headers: json(outsider.cookie, outsiderId) }))
    assert.equal(outsiderList.projects.length, 0)
    const adminList = await readJson(await fetch(`${origin}/api/projects`, { headers: json(admin.cookie) }))
    assert.equal(adminList.projects.length, 1)
    assert.equal(adminList.projects[0].role, 'owner')
    const outsiderDetail = await fetch(`${origin}/api/projects/${projectId}`, { headers: json(outsider.cookie, outsiderId) })
    assert.equal(outsiderDetail.status, 404)

    // 글: 열람 권한은 불가, 소유자는 파일과 함께 가능
    const upload = await fetch(`${origin}/api/documents?${new URLSearchParams({ name: '갱신계획.xlsx', category: '프로젝트', visibility: 'restricted', tags: '' })}`, {
      method: 'POST', headers: { cookie: owner.cookie, 'x-workspace-identity': ownerId, 'content-type': 'application/octet-stream', 'x-file-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('갱신계획.xlsx') }, body: Buffer.from('xlsx-bytes'),
    })
    const uploaded = await readJson(upload)
    assert.equal(upload.status, 201, JSON.stringify(uploaded))
    const viewerPost = await fetch(`${origin}/api/projects/${projectId}/posts`, { method: 'POST', headers: json(viewer.cookie, viewerId), body: JSON.stringify({ title: '불가', body: 'x' }) })
    assert.equal(viewerPost.status, 403)
    const post = await readJson(await fetch(`${origin}/api/projects/${projectId}/posts`, { method: 'POST', headers: json(owner.cookie, ownerId), body: JSON.stringify({ title: '갱신 일정 공유', body: '첨부 참고', attachments: [{ id: uploaded.document.id }] }) }))
    assert.equal(post.post?.attachments.length, 1, JSON.stringify(post))
    // 열람 멤버가 첨부를 내려받을 수 있다 (멤버 접근 부여)
    const viewerDownload = await fetch(`${origin}/api/documents/${uploaded.document.id}/download`, { headers: { cookie: viewer.cookie, 'x-workspace-identity': viewerId } })
    assert.equal(viewerDownload.status, 200)
    // 비멤버는 불가
    const outsiderDownload = await fetch(`${origin}/api/documents/${uploaded.document.id}/download`, { headers: { cookie: outsider.cookie, 'x-workspace-identity': outsiderId } })
    assert.notEqual(outsiderDownload.status, 200)
    // 열람 멤버도 댓글은 가능
    const comment = await readJson(await fetch(`${origin}/api/projects/${projectId}/posts/${post.post.id}/comments`, { method: 'POST', headers: json(viewer.cookie, viewerId), body: JSON.stringify({ text: '확인했습니다' }) }))
    assert.equal(comment.post?.comments.length, 1, JSON.stringify(comment))
    // 소유자가 멤버 권한 변경 (viewer → editor) 후 글쓰기 가능
    const patched = await readJson(await fetch(`${origin}/api/projects/${projectId}`, { method: 'PATCH', headers: json(owner.cookie, ownerId), body: JSON.stringify({ members: [{ id: 'USR-SUNSEA-OH', role: 'editor' }] }) }))
    assert.equal(patched.project.members.find((member) => member.id === 'USR-SUNSEA-OH').role, 'editor')
    const editorPost = await fetch(`${origin}/api/projects/${projectId}/posts`, { method: 'POST', headers: json(viewer.cookie, viewerId), body: JSON.stringify({ title: '이제 가능', body: 'ok' }) })
    assert.equal(editorPost.status, 201)
    // 비소유자는 설정 변경 불가
    const forbiddenPatch = await fetch(`${origin}/api/projects/${projectId}`, { method: 'PATCH', headers: json(viewer.cookie, viewerId), body: JSON.stringify({ name: '탈취' }) })
    assert.equal(forbiddenPatch.status, 403)
    // 회사 전체 공개로 바꾸면 비멤버도 열람 가능(글쓰기는 불가)
    await fetch(`${origin}/api/projects/${projectId}`, { method: 'PATCH', headers: json(owner.cookie, ownerId), body: JSON.stringify({ visibility: 'company' }) })
    const outsiderDetail2 = await readJson(await fetch(`${origin}/api/projects/${projectId}`, { headers: json(outsider.cookie, outsiderId) }))
    assert.equal(outsiderDetail2.project?.role, 'viewer')
    // 일반 스토어 경로는 차단
    assert.equal((await fetch(`${origin}/api/workspace/project-posts`, { headers: json(admin.cookie) })).status, 403)
    assert.equal((await fetch(`${origin}/api/workspace/project-spaces`, { method: 'PUT', headers: json(admin.cookie), body: JSON.stringify({ data: [] }) })).status, 403)
  })
})

test('platform control center: tenant accounts listing, briefing findings and rule-based assistant', async () => {
  const store = freshStore()
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {} }), async (origin) => {
    const operator = await login(origin, 'operator@onfactory.co.kr', 'platform')
    const state = await readJson(await fetch(`${origin}/api/platform/state`, { headers: { cookie: operator.cookie } }))
    const sunsea = state.tenants.find((tenant) => tenant.id === 'TENANT-SUNSEA')
    assert.ok(Array.isArray(sunsea.admins) && sunsea.admins.some((admin) => admin.email === 'admin@sunsea.co.kr'))
    assert.equal(typeof sunsea.metrics.pendingProposals, 'number')
    assert.equal(sunsea.consentCurrent, false)
    const accounts = await readJson(await fetch(`${origin}/api/platform/tenants/TENANT-SUNSEA/accounts`, { headers: { cookie: operator.cookie } }))
    assert.ok(accounts.accounts.length >= 3)
    assert.equal(accounts.accounts[0].role, 'tenant-admin')
    assert.ok(accounts.accounts.every((row) => !('password' in row)))
    const briefing = await readJson(await fetch(`${origin}/api/platform/briefing`, { headers: { cookie: operator.cookie } }))
    assert.equal(briefing.summary.tenants, state.tenants.length)
    assert.ok(briefing.findings.some((finding) => finding.title === '약관 동의 필요'))
    assert.ok(briefing.headline.length > 0)
    const answer = await readJson(await fetch(`${origin}/api/platform/assistant`, { method: 'POST', headers: json(operator.cookie), body: JSON.stringify({ question: '햇살바다 상태 알려줘' }) }))
    assert.equal(answer.mode, 'rules')
    assert.match(answer.answer, /햇살바다/)
    // 일반 계정은 접근 불가
    const member = await login(origin, 'jihyun.park@sunsea.co.kr')
    assert.equal((await fetch(`${origin}/api/platform/briefing`, { headers: { cookie: member.cookie } })).status, 403)
  })
})

test('projects: management fields are stored and legacy it-projects migrate once for IT tenants', async () => {
  const store = { version: 2, tenants: { 'TENANT-SUNSEA': {}, 'TENANT-POHANG': {}, 'TENANT-3DMUSE': { 'it-projects': { data: [{ id: 'ITP-1', name: '레거시 SI 구축', client: '한국도로공사', status: '진행 중', owner: '김서원', startDate: '2026-07-01', dueDate: '2026-12-31', amount: 50000000, note: '기존 IT 프로젝트', createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' }], updatedAt: '2026-07-01T00:00:00.000Z' } } }, platform: {}, accountApprovals: {}, accountCredentials: {}, invitedAccounts: [], passwordResetRequests: [] }
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {} }), async (origin) => {
    // 관리 정보 저장
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const created = await readJson(await fetch(`${origin}/api/projects`, { method: 'POST', headers: json(admin.cookie), body: JSON.stringify({ name: '신제품 출시', stage: '진행 중', client: '자사', startDate: '2026-09-01', endDate: '2026-11-30', amount: 1000000 }) }))
    assert.equal(created.project?.stage, '진행 중', JSON.stringify(created))
    assert.equal(created.project.client, '자사')
    assert.equal(created.project.amount, 1000000)
    const patched = await readJson(await fetch(`${origin}/api/projects/${created.project.id}`, { method: 'PATCH', headers: json(admin.cookie), body: JSON.stringify({ stage: '검수', amount: 2000000 }) }))
    assert.equal(patched.project.stage, '검수')
    assert.equal(patched.project.amount, 2000000)
    // IT 테넌트: 레거시 it-projects가 프로젝트 공간으로 1회 이관
    const itAdmin = await login(origin, 'admin@3dmuse.demo')
    assert.equal(itAdmin.response.status, 200)
    const first = await readJson(await fetch(`${origin}/api/projects`, { headers: json(itAdmin.cookie) }))
    const migrated = first.projects.find((project) => project.legacyId === 'ITP-1')
    assert.ok(migrated, JSON.stringify(first.projects))
    assert.equal(migrated.name, '레거시 SI 구축')
    assert.equal(migrated.stage, '진행 중')
    assert.equal(migrated.client, '한국도로공사')
    assert.equal(migrated.endDate, '2026-12-31')
    const second = await readJson(await fetch(`${origin}/api/projects`, { headers: json(itAdmin.cookie) }))
    assert.equal(second.projects.filter((project) => project.legacyId === 'ITP-1').length, 1, '두 번 이관되지 않는다')
  })
})

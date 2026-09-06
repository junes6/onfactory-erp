import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { excerpt, matches, PER_TYPE_LIMIT, SEARCH_KINDS, searchTenant, terms } from './global-search.mjs'

const ADMIN = { id: 'U-ADMIN', name: '김서원', role: 'tenant-admin', tenantId: 'T1', team: '경영' }
const MEMBER = { id: 'U-PARK', name: '박지현', role: 'tenant-member', tenantId: 'T1', team: '품질' }
const OTHER = { id: 'U-OH', name: '오태식', role: 'tenant-member', tenantId: 'T1', team: '생산' }

const ACCOUNTS = [ADMIN, MEMBER, OTHER].map((account) => ({ ...account, email: `${account.id.toLowerCase()}@sunsea.co.kr`, jobRole: '담당' }))

const canReadDocument = (document, account) => {
  if (account.role === 'tenant-admin' || document.uploadedById === account.id) return true
  if (document.visibility === 'all') return true
  return document.visibility === 'department' && (document.departments ?? []).includes(account.team)
}
const isConversationVisibleToMember = (conversation, account) => (conversation.participantIds ?? []).includes(account.id)

const STORE = {
  'work-items': { data: [
    { id: 'WK-1', title: '냉장창고 온도 점검', description: '매일 09시 확인', owner: '박지현', ownerId: 'U-PARK', requesterId: 'U-ADMIN', status: '수행중', category: '품질', due: '2026-09-10' },
    { id: 'WK-2', title: '냉장창고 전등 교체', description: '', owner: '오태식', ownerId: 'U-OH', requesterId: 'U-OH', status: '업무요청', category: '설비', due: '2026-09-12' },
  ] },
  'company-documents': { data: [
    { id: 'DOC-1', name: '냉장창고 관리 지침.pdf', category: '품질', tags: [], summary: '온도 기록 주기와 이상 대응', visibility: 'all', uploadedById: 'U-ADMIN', uploadedByName: '김서원', uploadedAt: '2026-08-01T00:00:00.000Z' },
    { id: 'DOC-2', name: '냉장창고 임대 계약.pdf', category: '계약', tags: [], summary: '경영팀만 봅니다', visibility: 'department', departments: ['경영'], uploadedById: 'U-ADMIN', uploadedByName: '김서원', uploadedAt: '2026-08-02T00:00:00.000Z' },
  ] },
  'daily-journals': { data: [
    { id: 'JN-1', date: '2026-09-04', title: '품질 일지', authorId: 'U-PARK', author: '박지현', department: '품질', completed: '냉장창고 점검 완료', issue: '', nextPlan: '', status: '승인' },
    { id: 'JN-2', date: '2026-09-04', title: '생산 일지', authorId: 'U-OH', author: '오태식', department: '생산', completed: '냉장창고 정리', issue: '', nextPlan: '', status: '승인' },
  ] },
  'messenger-conversations': { data: [
    { id: 'CV-1', name: '품질관리팀', participantIds: ['U-PARK', 'U-ADMIN'], messages: [{ id: 'M1', senderId: 'U-ADMIN', senderName: '김서원', text: '냉장창고 점검표 올렸습니다', time: '14:00', createdAt: '2026-09-04T05:00:00.000Z' }] },
    { id: 'CV-2', name: '생산팀', participantIds: ['U-OH'], messages: [{ id: 'M2', senderId: 'U-OH', senderName: '오태식', text: '냉장창고 문이 안 닫힙니다', time: '15:00', createdAt: '2026-09-04T06:00:00.000Z' }] },
  ] },
  'ai-conversations': { data: [
    { id: 'AIC-1', ownerId: 'U-PARK', title: '냉장창고 기준', summary: '', deletedAt: null, updatedAt: '2026-09-04T00:00:00.000Z', messages: [{ id: 'x', role: 'user', content: '냉장창고 온도 기준이 뭔가요' }] },
    { id: 'AIC-2', ownerId: 'U-OH', title: '냉장창고 정리', summary: '', deletedAt: null, updatedAt: '2026-09-04T00:00:00.000Z', messages: [] },
    { id: 'AIC-3', ownerId: 'U-PARK', title: '냉장창고 옛 대화', summary: '', deletedAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', messages: [] },
  ] },
  'opportunities': { data: [
    { id: 'OP-1', title: '냉장창고 설비 지원사업', agency: '중소벤처기업부', source: 'bizinfo', noticeNo: '2026-1', deadline: '2026-10-01', rationale: '설비 투자 대상' },
  ] },
  'project-spaces': { data: [
    { id: 'PRJ-A', name: '창고 개선', visibility: 'members', members: [{ id: 'U-ADMIN', role: 'owner' }, { id: 'U-PARK', role: 'editor' }] },
  ] },
  'notices': { data: [
    {
      id: 'NTC-srch-0011aa', scope: 'company', conversationId: null, projectId: null,
      title: '냉장창고 점검 공지', body: '이번 주 냉장창고 점검을 합니다.', attachments: [],
      authorId: 'U-ADMIN', authorName: '김서원', mustRead: true, targetIds: ['U-PARK'], acknowledgements: [],
      reminders: { remindedAt: {}, summary48SentAt: null, lastManualRemindAt: null },
      archivedAt: null, createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z',
    },
    {
      // 스키마 밖 키가 하나 섞인 행. 목록(readNotices)은 이런 행을 다루지 않는다고 판정하므로
      // 검색만 그 위에서 scope·projectId를 믿고 권한을 판정하면 '가장 좁은 문' 규약이 한 곳에서만 뚫린다.
      id: 'NTC-brok-0011bb', scope: 'company', conversationId: null, projectId: null,
      title: '냉장창고 깨진 공지', body: '형식이 깨진 행입니다.', attachments: [],
      authorId: 'U-ADMIN', authorName: '김서원', mustRead: false, targetIds: [], acknowledgements: [],
      reminders: { remindedAt: {}, summary48SentAt: null, lastManualRemindAt: null },
      archivedAt: null, createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z',
      extraKey: '스키마 밖',
    },
    {
      // 프로젝트 공지. 이 한 건이 없으면 noticeVisibleTo의 project 갈래(projectById·projectRoleOf·
      // conversationById)가 검색에서 한 번도 불리지 않아, 배선이 사라져도 테스트가 초록으로 남는다.
      id: 'NTC-proj-0011cc', scope: 'project', conversationId: 'CV-1', projectId: 'PRJ-A',
      title: '냉장창고 개선 회의', body: '창고 개선 프로젝트 회의록입니다.', attachments: [],
      authorId: 'U-ADMIN', authorName: '김서원', mustRead: false, targetIds: ['U-PARK'], acknowledgements: [],
      reminders: { remindedAt: {}, summary48SentAt: null, lastManualRemindAt: null },
      archivedAt: null, createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z',
    },
  ] },
}

// 공지 갈래는 프로젝트 역할 판정을 그대로 받는다 — 검색이 자기 규칙을 새로 짜면 목록과 어긋난다.
const projectRoleOf = (project, auth) => {
  if (!project) return null
  if (auth.role === 'tenant-admin') return 'owner'
  return (project.members ?? []).find((member) => member.id === auth.id)?.role ?? null
}

const search = (query, auth) => searchTenant({ query, auth, tenantStore: STORE, accounts: ACCOUNTS, canReadDocument, isConversationVisibleToMember, projectRoleOf })
const typeItems = (result, type) => result.groups.find((group) => group.type === type)?.items ?? []

test('낱말은 모두 들어 있어야 걸린다', () => {
  assert.deepEqual(terms('냉장창고 온도'), ['냉장창고', '온도'])
  assert.equal(matches('냉장창고 온도 점검', ['냉장창고', '온도']), true)
  assert.equal(matches('냉장창고 전등 교체', ['냉장창고', '온도']), false)
})

test('짧은 검색어로는 목록을 쏟지 않는다', () => {
  assert.equal(search('냉', ADMIN).total, 0)
  assert.ok(search('냉장창고', ADMIN).total > 0)
})

test('한 검색어로 여덟 갈래를 함께 찾는다', () => {
  const result = search('냉장창고', ADMIN)
  const kinds = result.groups.map((group) => group.type)
  for (const expected of ['task', 'document', 'journal', 'message', 'opportunity', 'notice']) {
    assert.ok(kinds.includes(expected), `${expected}가 결과에 없다`)
  }
})

test('공지는 볼 수 있는 사람에게만 검색된다 — 게스트는 앞머리에서 이미 빈 결과다', () => {
  const seen = typeItems(search('냉장창고', MEMBER), 'notice')
  // 형식이 깨진 행은 목록과 같은 문(readNotices)에서 걸러진다 — 검색만 저장소 배열을 그대로 읽으면,
  // "다루지 않는다"고 판정한 데이터 위에서 검증되지 않은 scope로 권한을 판정하게 된다.
  assert.deepEqual(seen.map((item) => item.id), ['NTC-srch-0011aa', 'NTC-proj-0011cc'])
  assert.deepEqual(typeItems(search('냉장창고', ADMIN), 'notice').map((item) => item.id), ['NTC-srch-0011aa', 'NTC-proj-0011cc'])
  assert.match(seen[0].meta, /회사 공지 · 필독/)
  assert.equal(seen[0].focusId, 'company:notice:NTC-srch-0011aa', '알림·검색·웹푸시가 같은 focusId 규약을 쓴다')

  // 프로젝트 공지는 프로젝트 역할로 판정한다. 오태식은 PRJ-A 멤버가 아니므로 회사 공지만 본다 —
  // 이 단언이 있어야 searchTenant의 projectRoleOf 배선이 사라지는 순간 빨개진다.
  assert.deepEqual(typeItems(search('냉장창고', OTHER), 'notice').map((item) => item.id), ['NTC-srch-0011aa'])
  const project = seen[1]
  assert.match(project.meta, /프로젝트 공지/)
  assert.equal(project.focusId, 'CV-1:notice:NTC-proj-0011cc', '방 공지의 딥링크는 그 방을 연다')

  // 제목이 약속하는 것: 게스트는 갈래를 돌기 전에 이미 빈 결과다(프로젝트 공지 한 건이 있어도 그렇다).
  const GUEST = { id: 'U-GUEST', name: '홍거래', role: 'tenant-guest', tenantId: 'T1', team: '파트너상사', guestScope: { projectIds: ['PRJ-A'] } }
  assert.equal(search('냉장창고', GUEST).total, 0)
})

test('일반 직원은 자기 업무만 본다', () => {
  const mine = typeItems(search('냉장창고', MEMBER), 'task').map((item) => item.id)
  assert.deepEqual(mine, ['WK-1'], '남이 맡고 남이 지시한 업무는 검색에도 나오지 않는다')
  const all = typeItems(search('냉장창고', ADMIN), 'task').map((item) => item.id)
  assert.deepEqual(all.sort(), ['WK-1', 'WK-2'])
})

test('문서 공개 범위를 검색이 뚫지 않는다', () => {
  const seen = typeItems(search('냉장창고', MEMBER), 'document').map((item) => item.id)
  assert.deepEqual(seen, ['DOC-1'], '경영팀 전용 계약서는 품질팀에게 보이지 않는다')
})

test('일지는 쓴 사람과 관리자만 찾는다', () => {
  assert.deepEqual(typeItems(search('냉장창고', MEMBER), 'journal').map((item) => item.id), ['JN-1'])
  assert.equal(typeItems(search('냉장창고', ADMIN), 'journal').length, 2)
})

test('참여하지 않은 방의 말은 검색으로도 새지 않는다', () => {
  const seen = typeItems(search('냉장창고', MEMBER), 'message')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].title, '품질관리팀')
  assert.match(seen[0].snippet, /점검표/)
  // 공지와 같은 규약이어야 화면이 그 방을 열고 그 말로 뛴다. 방 id만 실으면 해석되지 않는다.
  assert.equal(seen[0].focusId, 'CV-1:message:M1')
})

test('AI 대화는 본인 것만, 휴지통은 빼고', () => {
  const seen = typeItems(search('냉장창고', MEMBER), 'conversation').map((item) => item.id)
  assert.deepEqual(seen, ['AIC-1'])
  // 관리자라도 남의 AI 대화는 못 본다.
  assert.deepEqual(typeItems(search('냉장창고', ADMIN), 'conversation'), [])
})

test('사람은 이름·팀·직무로 찾는다', () => {
  const people = typeItems(search('박지현', MEMBER), 'person')
  assert.equal(people.length, 1)
  assert.equal(people[0].title, '박지현')
  assert.match(people[0].meta, /품질/)
})

test('한 갈래가 목록을 다 차지하지 않는다', () => {
  const many = { ...STORE, 'work-items': { data: Array.from({ length: 20 }, (_, index) => ({ id: `WK-${index}`, title: '냉장창고 점검', description: '', owner: '김서원', ownerId: 'U-ADMIN', requesterId: 'U-ADMIN', status: '수행중', category: '품질', due: '' })) } }
  const result = searchTenant({ query: '냉장창고', auth: ADMIN, tenantStore: many, accounts: ACCOUNTS, canReadDocument, isConversationVisibleToMember, projectRoleOf })
  assert.equal(result.groups.find((group) => group.type === 'task').items.length, PER_TYPE_LIMIT)
})

test('걸린 자리를 잘라 보여 준다', () => {
  const text = '앞부분입니다. '.repeat(10) + '냉장창고 온도 기록' + ' 뒷부분입니다.'.repeat(10)
  const piece = excerpt(text, '냉장창고')
  assert.match(piece, /냉장창고 온도 기록/)
  assert.ok(piece.startsWith('…'), '앞을 잘랐으면 잘랐다고 보여 준다')
})

test('모든 항목과 그룹에 kind가 채워져 있고 SEARCH_TYPES 안의 값이다', () => {
  // 사람까지 여덟 갈래가 전부 걸리도록 두 검색어를 합친다.
  // 관리자는 AI 대화를 못 보고, 사람은 이름으로만 걸린다. 셋을 합쳐야 여덟 갈래가 모두 나온다.
  const results = [search('냉장창고', ADMIN), search('냉장창고', MEMBER), search('박지현', MEMBER)]
  const seen = new Set()
  for (const result of results) {
    assert.ok(result.groups.length > 0)
    for (const group of result.groups) {
      assert.ok(SEARCH_KINDS.includes(group.kind), `그룹 kind가 비었거나 낯설다: ${String(group.kind)}`)
      // 호환용 type은 한 릴리스 동안 kind와 같은 값이어야 한다.
      assert.equal(group.type, group.kind)
      for (const item of group.items) {
        assert.ok(SEARCH_KINDS.includes(item.kind), `${group.kind} 그룹의 ${item.id} 항목 kind가 비었거나 낯설다: ${String(item.kind)}`)
        assert.equal(item.kind, group.kind, '항목의 kind는 자기 그룹과 같아야 한다')
        assert.equal(item.type, item.kind)
        seen.add(item.kind)
      }
    }
  }
  // 어느 한 갈래가 kind를 빼먹으면 위 단언에서 걸리지만, 갈래 자체가 결과에 안 나와 검사를 피하는 일도 막는다.
  assert.deepEqual([...seen].sort(), [...SEARCH_KINDS].sort(), '여덟 갈래가 모두 검사를 거쳐야 한다')
})

test('SEARCH_KINDS 와 클라이언트 KIND_LABEL 사전의 키가 같다', async () => {
  // 서버에 갈래를 더하고 화면 사전을 잊으면, 어긋난 항목이 영문 id를 배지에 달고 나온다.
  // 화면 모듈은 React를 끌어와서 여기서 import할 수 없으니 소스를 문자열로 읽어 키만 뽑는다.
  const source = await readFile(new URL('../src/components/GlobalSearch.tsx', import.meta.url), 'utf8')
  const block = source.match(/const KIND_LABEL: Record<SearchKind, string> = \{([\s\S]*?)\n\}/u)
  assert.ok(block, 'GlobalSearch.tsx 에 KIND_LABEL 사전이 있어야 한다')
  const keys = [...block[1].matchAll(/^\s*([a-zA-Z_]+):\s*'[^']+',?\s*$/gmu)].map((match) => match[1])
  assert.deepEqual(keys.sort(), [...SEARCH_KINDS].sort(), '서버 갈래와 화면 사전의 키가 어긋났다')
})

test('외부 게스트는 전역 검색으로 아무것도 찾지 못한다 — 사람 검색 한 갈래로도 직원 명단이 열거되기 때문', () => {
  const GUEST = { id: 'U-GUEST', name: '홍거래', role: 'tenant-guest', tenantId: 'T1', team: '파트너상사', guestScope: { projectIds: ['PRJ-A'] } }
  assert.deepEqual(search('냉장창고', GUEST), { groups: [], total: 0 })
  assert.deepEqual(search('박지현', GUEST), { groups: [], total: 0 })
  assert.equal(typeItems(search('박지현', MEMBER), 'person').length, 1, '직원은 여전히 찾는다')
})

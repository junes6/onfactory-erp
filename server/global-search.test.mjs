import assert from 'node:assert/strict'
import test from 'node:test'

import { excerpt, matches, PER_TYPE_LIMIT, searchTenant, terms } from './global-search.mjs'

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
}

const search = (query, auth) => searchTenant({ query, auth, tenantStore: STORE, accounts: ACCOUNTS, canReadDocument, isConversationVisibleToMember })
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

test('한 검색어로 일곱 갈래를 함께 찾는다', () => {
  const result = search('냉장창고', ADMIN)
  const kinds = result.groups.map((group) => group.type)
  for (const expected of ['task', 'document', 'journal', 'message', 'opportunity']) {
    assert.ok(kinds.includes(expected), `${expected}가 결과에 없다`)
  }
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
  const result = searchTenant({ query: '냉장창고', auth: ADMIN, tenantStore: many, accounts: ACCOUNTS, canReadDocument, isConversationVisibleToMember })
  assert.equal(result.groups.find((group) => group.type === 'task').items.length, PER_TYPE_LIMIT)
})

test('걸린 자리를 잘라 보여 준다', () => {
  const text = '앞부분입니다. '.repeat(10) + '냉장창고 온도 기록' + ' 뒷부분입니다.'.repeat(10)
  const piece = excerpt(text, '냉장창고')
  assert.match(piece, /냉장창고 온도 기록/)
  assert.ok(piece.startsWith('…'), '앞을 잘랐으면 잘랐다고 보여 준다')
})

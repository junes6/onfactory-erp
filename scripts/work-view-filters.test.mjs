import assert from 'node:assert/strict'
import test from 'node:test'

import { boardDropAction, boardDropTargets, checklistBlockMessage } from '../src/utils/workBoardDrop.ts'
import { subtaskBlockReason } from '../src/utils/workTree.ts'
import {
  activeFilterCount, applyDueQuick, applyWorkFilters, customFieldValue, describeFilters, DEFAULT_WORK_SORT,
  dueQuickId, EMPTY_WORK_FILTERS, filtersEqual, readStoredWorkView, sortWorkItems, WORK_SORT_FIELD_LABELS,
} from '../src/utils/workViews.ts'
import { SAVED_VIEW_SORT_FIELDS } from '../server/saved-views.mjs'

/**
 * 보드 드롭 판정과 목록 필터·정렬 — 순수 규칙.
 *
 * 드롭 판정은 서버 전이표(server/app.mjs의 /transition)의 거울이다. 그 표를 이 파일에 리터럴로
 * 한 번 더 적고 1:1로 대조한다 — 두 곳이 갈리는 날 이 시험이 먼저 실패해야 한다.
 * 시계는 주입한다. 시계를 읽는 시험은 어느 밤에 저절로 실패한다.
 */

const NOW = new Date('2026-09-05T06:00:00.000Z') // KST 2026-09-05 15:00
const OWNER = 'USR-OWNER'
const REQUESTER = 'USR-REQ'
const THIRD = 'USR-THIRD'
const STATUSES = ['업무요청', '수행중', '결재대기', '결재완료']

const task = (overrides = {}) => ({
  id: 'W1', title: '설비 점검', description: '', owner: '담당자', ownerId: OWNER,
  requestedBy: '지시자', requesterId: REQUESTER, due: '2026-09-10T09:00:00.000Z',
  priority: '보통', status: '업무요청', category: '일반', ...overrides,
})

/**
 * 서버 전이표를 글자 그대로 옮긴 것. 조건 넷 말고는 어떤 이동도 없고, 결재완료에서 나가는 문도 없다.
 * [action, from, to, 자격]
 */
const SERVER_TRANSITIONS = [
  ['accept', '업무요청', '수행중', 'owner'],
  ['submit', '수행중', '결재대기', 'owner'],
  ['approve', '결재대기', '결재완료', 'requester'],
  ['request-changes', '결재대기', '수행중', 'requester'],
]

test('1. 보드 드롭 판정 48조합이 서버 전이표와 1:1로 같다', () => {
  const roles = [['owner', OWNER], ['requester', REQUESTER], ['third', THIRD]]
  let actions = 0
  let nones = 0
  let blocked = 0
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      for (const [roleName, userId] of roles) {
        const item = task({ status: from })
        const drop = boardDropAction(item, to, userId, [item])
        const legal = SERVER_TRANSITIONS.find(([, transitionFrom, transitionTo, needs]) => (
          transitionFrom === from && transitionTo === to && needs === roleName
        ))
        if (from === to) {
          assert.equal(drop.kind, 'none', `${from}→${to}/${roleName}`)
          nones += 1
        } else if (legal) {
          assert.equal(drop.kind, 'action', `${from}→${to}/${roleName}: ${JSON.stringify(drop)}`)
          assert.equal(drop.action, legal[0])
          assert.equal(drop.needsDialog, legal[0] === 'accept' ? null : legal[0] === 'submit' ? 'completion' : 'review')
          actions += 1
        } else {
          assert.equal(drop.kind, 'blocked', `${from}→${to}/${roleName}: ${JSON.stringify(drop)}`)
          // 짧은 사유는 사유가 아니다 — 왜 안 되는지와 대신 무엇을 하면 되는지가 한 문장에 있어야 한다.
          assert.ok(drop.reason.length >= 12, `${from}→${to}/${roleName}: ${drop.reason}`)
          blocked += 1
        }
      }
    }
  }
  assert.equal(nones, 12, '같은 칼럼 4상태 × 3역할')
  assert.equal(actions, 4, '합법은 정확히 네 칸이고, 각각 자기 자격일 때만이다')
  assert.equal(blocked, 32)
})

test('2. 결재완료에서 나가는 문도, 시작 전으로 되돌아가는 문도 없다', () => {
  for (const to of ['업무요청', '수행중', '결재대기']) {
    const item = task({ status: '결재완료' })
    const drop = boardDropAction(item, to, OWNER, [item])
    assert.equal(drop.kind, 'blocked')
    assert.match(drop.reason, /완료된 업무는 다시 열 수 없습니다/)
  }
  for (const from of ['수행중', '결재대기']) {
    const item = task({ status: from })
    assert.match(boardDropAction(item, '업무요청', REQUESTER, [item]).reason, /되돌릴 수는 없습니다/)
  }
})

test('3. 점검 항목·하위 업무가 남으면 문을 잠그지 않고 이유만 미리 말한다', () => {
  const checklist = [
    { id: 'C1', label: '금속검출기 시험편 통과', done: false },
    { id: 'C2', label: '기록지 서명', done: false },
    { id: 'C3', label: '세척 확인', done: false },
    { id: 'C4', label: '온도 기록', done: false },
  ]
  const item = task({ status: '수행중', checklist })
  const drop = boardDropAction(item, '결재대기', OWNER, [item])
  // 화면을 연 순간의 사본이라 그 사이 끝났을 수 있다 — 남았는지는 제출 시점에 서버가 409로 판정한다.
  assert.equal(drop.kind, 'action')
  assert.equal(drop.needsDialog, 'completion')
  assert.equal(drop.warning, '점검 항목 4건이 남아 있습니다: 금속검출기 시험편 통과, 기록지 서명, 세척 확인 외')
  assert.equal(drop.warning, checklistBlockMessage(checklist.map((entry) => entry.label)))

  const parent = task({ id: 'P1', status: '수행중' })
  const child = task({ id: 'C-1', title: '비밀 하위 제목', parentId: 'P1', status: '수행중' })
  const withChild = boardDropAction(parent, '결재대기', OWNER, [parent, child])
  assert.equal(withChild.kind, 'action')
  // 문장은 subtaskBlockReason 하나에서만 나오고, 그 문장에는 자식 제목이 없다(범위 밖 제목이 새지 않게).
  assert.equal(withChild.warning, subtaskBlockReason([parent, child], 'P1'))
  assert.equal(withChild.warning.includes('비밀 하위 제목'), false)
})

test('4. 갈 곳이 하나도 없는 카드는 잡히지 않는다', () => {
  assert.deepEqual(boardDropTargets(task({ status: '업무요청' }), OWNER, []), ['수행중'])
  assert.deepEqual(boardDropTargets(task({ status: '결재대기' }), REQUESTER, []), ['수행중', '결재완료'])
  assert.deepEqual(boardDropTargets(task({ status: '업무요청' }), THIRD, []), [])
  assert.deepEqual(boardDropTargets(task({ status: '결재완료' }), OWNER, []), [])
})

const items = [
  task({ id: 'A', title: '설비 점검', status: '수행중', priority: '긴급', category: '설비', due: '2026-09-04T09:00:00.000Z', ownerId: OWNER, requesterId: REQUESTER }),
  task({ id: 'B', title: 'HACCP 서류', status: '업무요청', priority: '보통', category: '문서', due: '2026-09-20T09:00:00.000Z', ownerId: THIRD, requesterId: OWNER, projectId: 'PRJ-A', fields: { vendor: 'A', amount: 12, ship_on: '2026-09-15' } }),
  task({ id: 'C', title: '납품 정산', status: '결재완료', priority: '높음', category: '문서', due: '2026-09-01T09:00:00.000Z', ownerId: OWNER, requesterId: THIRD, fields: { vendor: 'B', amount: 3 } }),
  task({ id: 'D', title: '마감 없는 업무', status: '수행중', priority: '보통', due: '', ownerId: OWNER, requesterId: REQUESTER, parentId: 'A' }),
]
const ids = (list) => list.map((item) => item.id)
const filters = (patch) => ({ ...EMPTY_WORK_FILTERS, ...patch })

test('5. 필터는 축마다 하나씩, 그리고 AND로 겹친다', () => {
  assert.deepEqual(ids(applyWorkFilters(items, EMPTY_WORK_FILTERS, OWNER, NOW)), ['A', 'B', 'C', 'D'])
  assert.deepEqual(ids(applyWorkFilters(items, filters({ scope: 'mine' }), OWNER, NOW)), ['A', 'C', 'D'])
  assert.deepEqual(ids(applyWorkFilters(items, filters({ scope: 'requested' }), OWNER, NOW)), ['B'])
  assert.deepEqual(ids(applyWorkFilters(items, filters({ statuses: ['수행중'] }), OWNER, NOW)), ['A', 'D'])
  assert.deepEqual(ids(applyWorkFilters(items, filters({ priorities: ['긴급', '높음'] }), OWNER, NOW)), ['A', 'C'])
  assert.deepEqual(ids(applyWorkFilters(items, filters({ categories: ['문서'] }), OWNER, NOW)), ['B', 'C'])
  assert.deepEqual(ids(applyWorkFilters(items, filters({ projectIds: ['PRJ-A'] }), OWNER, NOW)), ['B'])
  assert.deepEqual(ids(applyWorkFilters(items, filters({ hasParent: true }), OWNER, NOW)), ['D'])
  assert.deepEqual(ids(applyWorkFilters(items, filters({ hasParent: false }), OWNER, NOW)), ['A', 'B', 'C'])
  assert.deepEqual(ids(applyWorkFilters(items, filters({ ownerIds: [THIRD] }), OWNER, NOW)), ['B'])
  // AND: 내가 담당이면서 수행중인 것
  assert.deepEqual(ids(applyWorkFilters(items, filters({ scope: 'mine', statuses: ['수행중'] }), OWNER, NOW)), ['A', 'D'])
})

test('6. 마감 경계는 KST 날짜다', () => {
  const early = task({ id: 'EARLY', due: '2026-10-08T14:59:59.000Z' }) // KST 10/8 23:59
  const late = task({ id: 'LATE', due: '2026-10-08T15:00:00.000Z' }) // KST 10/9 00:00
  const range = filters({ dueFrom: '2026-10-01', dueTo: '2026-10-08' })
  assert.deepEqual(ids(applyWorkFilters([early, late], range, OWNER, NOW)), ['EARLY'])
  // 마감 축이 켜지면 마감을 못 읽는 업무는 빠진다 — 언제인지 모르는 업무가 섞여 나오면 그 목록은 답이 아니다.
  assert.deepEqual(ids(applyWorkFilters(items, range, OWNER, NOW)), [])
})

test('7. overdueOnly는 완료를 세지 않고, 절대 범위가 상대 범위를 이긴다', () => {
  // C는 마감이 지났지만 결재완료다 — 끝난 일은 지연이 아니다.
  assert.deepEqual(ids(applyWorkFilters(items, filters({ overdueOnly: true }), OWNER, NOW)), ['A'])
  // 오늘(0일 안)과 9월 전체가 함께 오면 사람이 직접 적은 절대 범위가 이긴다.
  const both = filters({ dueWithinDays: 0, dueFrom: '2026-09-01', dueTo: '2026-09-30' })
  assert.deepEqual(ids(applyWorkFilters(items, both, OWNER, NOW)), ['A', 'B', 'C'])
  assert.deepEqual(ids(applyWorkFilters(items, filters({ dueWithinDays: 0 }), OWNER, NOW)), [])
  assert.deepEqual(ids(applyWorkFilters(items, filters({ dueWithinDays: 30 }), OWNER, NOW)), ['B'])
})

test('8. 검색어는 부분일치·대소문자 무시이고 입력값을 변형하지 않는다', () => {
  const typed = filters({ text: '  haccp  ' })
  assert.deepEqual(ids(applyWorkFilters(items, typed, OWNER, NOW)), ['B'])
  assert.equal(typed.text, '  haccp  ', '필터 객체는 손대지 않는다 — onChange에서 값을 바꾸면 한글 IME가 끊긴다')
  assert.deepEqual(ids(applyWorkFilters(items, filters({ text: '점검' }), OWNER, NOW)), ['A'])
  assert.deepEqual(ids(applyWorkFilters(items, filters({ text: '없는말' }), OWNER, NOW)), [])
})

test('8-b. 텍스트 커스텀 필드의 값도 검색 칸에 걸린다', () => {
  /*
   * 필터 바는 텍스트 타입에 축을 만들지 않는다. 그러면서 검색 haystack이 제목·담당·분류·설명 넷뿐이던 동안
   * 관리자가 만든 '발주번호'·'메모' 항목은 **어떤 방법으로도** 좁힐 수 없었다(정렬 축에는 나오는데도).
   */
  const memo = task({ id: 'M', title: '납품 준비', fields: { po_no: 'PO-2026-0917', reviewer: THIRD } })
  assert.deepEqual(ids(applyWorkFilters([memo], filters({ text: 'PO-2026-0917' }), OWNER, NOW, ['po_no'])), ['M'])
  assert.deepEqual(ids(applyWorkFilters([memo], filters({ text: 'po-2026' }), OWNER, NOW, ['po_no'])), ['M'], '부분일치·대소문자 무시는 그대로다')
  // 사람 항목의 값은 계정 id 그 자체다 — 텍스트 키 목록에 없으므로 id 조각이 검색 결과의 근거가 되지 않는다.
  assert.deepEqual(ids(applyWorkFilters([memo], filters({ text: THIRD }), OWNER, NOW, ['po_no'])), [])
  // 정의를 아직 못 받았으면(빈 목록) 예전과 같다 — 검색이 죽지 않고 값만 안 걸린다.
  assert.deepEqual(ids(applyWorkFilters([memo], filters({ text: 'PO-2026-0917' }), OWNER, NOW)), [])
  assert.deepEqual(ids(applyWorkFilters([memo], filters({ text: '납품' }), OWNER, NOW)), ['M'])
})

test('9. 커스텀 필드 축 세 형태 — 다중 선택·숫자 범위·날짜 범위', () => {
  assert.deepEqual(ids(applyWorkFilters(items, filters({ fields: { vendor: ['A', 'B'] } }), OWNER, NOW)), ['B', 'C'])
  assert.deepEqual(ids(applyWorkFilters(items, filters({ fields: { vendor: ['A'] } }), OWNER, NOW)), ['B'])
  assert.deepEqual(ids(applyWorkFilters(items, filters({ fields: { amount: { min: 5 } } }), OWNER, NOW)), ['B'])
  assert.deepEqual(ids(applyWorkFilters(items, filters({ fields: { amount: { min: 1, max: 5 } } }), OWNER, NOW)), ['C'])
  assert.deepEqual(ids(applyWorkFilters(items, filters({ fields: { ship_on: { from: '2026-09-01', to: '2026-09-30' } } }), OWNER, NOW)), ['B'])
  assert.deepEqual(ids(applyWorkFilters(items, filters({ fields: { ship_on: { from: '2026-10-01' } } }), OWNER, NOW)), [])
  assert.equal(customFieldValue(items[1], 'amount'), 12)
  assert.equal(customFieldValue(items[0], 'amount'), undefined)
})

test('10. 정렬 — 값 없는 행은 언제나 뒤에 선다', () => {
  assert.deepEqual(ids(sortWorkItems(items, DEFAULT_WORK_SORT, NOW)), ['C', 'A', 'B', 'D'])
  // 마감도 cf:와 같은 규율을 지난다 — 내림차순에서 마감 미정(D)이 맨 위로 올라오면
  // '가장 늦게 끝나는 일'을 물었는데 '언제인지 모르는 일'이 답으로 나온다.
  assert.deepEqual(ids(sortWorkItems(items, { field: 'due', direction: 'desc' }, NOW)), ['B', 'A', 'C', 'D'])
  assert.deepEqual(ids(sortWorkItems(items, { field: 'priority', direction: 'asc' }, NOW)), ['A', 'C', 'B', 'D'])
  assert.deepEqual(ids(sortWorkItems(items, { field: 'status', direction: 'asc' }, NOW)), ['B', 'A', 'D', 'C'])
  // cf: 값이 없는 행은 오름차순에서도 내림차순에서도 뒤다. '없음'이 '0'이나 'ㄱ'보다 앞에 오면 거짓말이다.
  // 값이 있는 둘(C=3, B=12)만 방향을 따라 뒤집히고, 값이 없는 A·D는 두 방향 모두 뒤에서 마감순으로 선다.
  assert.deepEqual(ids(sortWorkItems(items, { field: 'cf:amount', direction: 'asc' }, NOW)), ['C', 'B', 'A', 'D'])
  assert.deepEqual(ids(sortWorkItems(items, { field: 'cf:amount', direction: 'desc' }, NOW)), ['B', 'C', 'A', 'D'])
})

test('11. 필터 개수·동치·이름 제안', () => {
  assert.equal(activeFilterCount(EMPTY_WORK_FILTERS), 0)
  assert.equal(activeFilterCount(filters({ scope: 'mine', overdueOnly: true, fields: { vendor: ['A'] } })), 3)
  assert.equal(activeFilterCount(filters({ text: '   ' })), 0, '공백만 적은 것은 조건이 아니다')

  assert.equal(filtersEqual(EMPTY_WORK_FILTERS, filters({})), true)
  assert.equal(filtersEqual(filters({ statuses: ['수행중', '업무요청'] }), filters({ statuses: ['업무요청', '수행중'] })), true, '키 순서에 기대지 않는다')
  assert.equal(filtersEqual(filters({ scope: 'mine' }), EMPTY_WORK_FILTERS), false)
  assert.equal(filtersEqual(filters({ fields: { vendor: ['A'] } }), filters({ fields: { vendor: ['B'] } })), false)

  // 빈 필터의 제안이 ' · '로 시작하면 이름 칸이 구분자부터 보인다.
  assert.equal(describeFilters(EMPTY_WORK_FILTERS), '')
  assert.equal(describeFilters(filters({ scope: 'mine', overdueOnly: true })), '내가 담당 · 지연')
  assert.equal(describeFilters(filters({ dueWithinDays: 7 })), '7일 안 마감')
  assert.equal(describeFilters(filters({ ownerIds: [OWNER] }), { owners: { [OWNER]: '박지현' } }), '박지현')

  /*
   * 제안된 이름은 화면이 쓰는 말로 적힌다. 내부 enum을 그대로 넣던 동안 상태 칩 '시작 전' 하나를 켜고
   * 저장을 누르면 이름 칸의 기본값이 '업무요청 · 목록'이었다 — '업무요청'은 화면 어디에도 없는 단어다.
   */
  assert.equal(describeFilters(filters({ statuses: ['업무요청'] })), '시작 전')
  assert.equal(describeFilters(filters({ statuses: ['결재대기', '결재완료'] })), '확인 기다리는 중·완료')
})

test('11-b. 마감 빠른 버튼 네 개가 전부 실제로 무언가를 한다', () => {
  // '직접'이 값(빈 문자열)으로 표현돼 있던 동안 이 버튼은 눌러도 아무 일이 없었고,
  // 켜 둔 다른 조건만 지웠다. 그 결함을 여기서 붙잡는다 — 어떤 시험도 이 버튼을 누르지 않았었다.
  const none = EMPTY_WORK_FILTERS
  assert.equal(dueQuickId(none), '')

  const today = applyDueQuick(none, 'today', dueQuickId(none))
  assert.equal(dueQuickId(today), 'today')
  assert.equal(activeFilterCount(today), 1)
  const week = applyDueQuick(today, 'week', dueQuickId(today))
  assert.equal(dueQuickId(week), 'week')
  assert.equal(week.dueWithinDays, 7)
  const overdue = applyDueQuick(week, 'overdue', dueQuickId(week))
  assert.equal(dueQuickId(overdue), 'overdue')
  assert.equal(overdue.dueWithinDays, null, '축 하나가 켜지면 나머지 마감 축은 꺼진다')

  // '직접'은 화면 상태다: 값이 비어 있어도 켜졌다고 말할 수 있어야 날짜 칸이 열린다.
  const custom = applyDueQuick(overdue, 'custom', dueQuickId(overdue))
  assert.equal(custom.overdueOnly, false)
  assert.equal(custom.dueFrom, null, '빈 문자열을 넣지 않는다 — 같은 없음이 두 가지가 되면 변경됨 배지가 거짓으로 켜진다')
  assert.equal(dueQuickId(custom), '', '값만 보면 아직 꺼져 있다')
  assert.equal(dueQuickId(custom, true), 'custom', '열려 있다는 사실은 부르는 쪽이 들고 온다')

  // 범위를 적어 두면 그 값이 이기고, 같은 버튼을 다시 누를 때만 범위가 지워진다.
  const ranged = { ...custom, dueFrom: '2026-09-01', dueTo: '2026-09-30' }
  assert.equal(dueQuickId(ranged), 'custom')
  assert.equal(activeFilterCount(ranged), 1)
  const reopened = applyDueQuick(ranged, 'custom', '')
  assert.equal(reopened.dueFrom, '2026-09-01', '직접을 다시 켤 때 적어 둔 범위를 지우지 않는다')
  const closed = applyDueQuick(ranged, 'custom', 'custom')
  assert.equal(closed.dueFrom, null)
  assert.equal(activeFilterCount(closed), 0)
  // 다른 버튼으로 갈아타면 절대 범위도 함께 꺼진다(두 마감 축이 동시에 켜져 있지 않게).
  assert.equal(applyDueQuick(ranged, 'today', 'custom').dueFrom, null)
})

test('11-d. boardDropAction은 업무가 없으면 던진다 — 그래서 렌더가 없는 카드를 넘기면 안 된다', () => {
  // 잡아 둔 카드가 목록에서 사라지는 일(다른 관리자의 삭제·재배정 뒤 재조회)은 드물지만,
  // 렌더 경로의 예외는 화면 전체를 빈 화면으로 만든다. 그래서 App.tsx는 찾은 값을 먼저 확인하고 넘긴다.
  assert.throws(() => boardDropAction(undefined, '수행중', OWNER, []), TypeError)
})

test('11-e. 같은 범위는 키 순서가 달라도 같은 조건이다', () => {
  // 사고: 저장된 보기의 `{min,max}`에서 최소 칸을 지우고 같은 숫자를 다시 치면 WorkFilterBar의
  // writeNumberRange가 그 객체를 `{max,min}` 순서로 다시 짓는다. 직렬화한 글자로 비교하던 동안에는
  // 뜻이 한 글자도 안 바뀐 보기에 '변경됨' 배지와 되돌리기·변경 저장이 나타났다.
  assert.equal(filtersEqual(
    filters({ fields: { amount: { min: 100, max: 500 } } }),
    filters({ fields: { amount: { max: 500, min: 100 } } }),
  ), true)
  assert.equal(filtersEqual(
    filters({ fields: { shipday: { from: '2026-01-01', to: '2026-02-01' } } }),
    filters({ fields: { shipday: { to: '2026-02-01', from: '2026-01-01' } } }),
  ), true)
  // 값이 다르면 여전히 다르다 — 순서를 무시하는 것과 내용을 무시하는 것은 다른 일이다.
  assert.equal(filtersEqual(filters({ fields: { amount: { min: 100 } } }), filters({ fields: { amount: { min: 101 } } })), false)
  assert.equal(filtersEqual(filters({ fields: { amount: { min: 100 } } }), filters({ fields: { amount: { min: 100, max: 500 } } })), false)
  assert.equal(filtersEqual(filters({ fields: { amount: { min: 100 } } }), filters({ fields: { amount: ['100'] } })), false, '목록과 범위는 다른 형태다')
  assert.equal(filtersEqual(filters({ fields: { vendor: ['A', 'B'] } }), filters({ fields: { vendor: ['B', 'A'] } })), true, '목록은 순서를 보지 않는다')
})

test('11-f. 세는 축은 하나도 빠짐없이 이름 제안에도 나온다', () => {
  // 세는 축과 부르는 축이 갈리면, 그 조건 하나로 만든 보기의 이름 제안이 빈 줄이 되는 동안
  // 바로 옆에서 필터 바는 '필터 1개'라고 말한다(출처 축이 실제로 그랬다).
  const axes = [
    ['scope', { scope: 'mine' }, {}],
    ['ownerIds', { ownerIds: [OWNER] }, { owners: { [OWNER]: '박지현' } }],
    ['statuses', { statuses: ['수행중'] }, {}],
    ['priorities', { priorities: ['긴급'] }, {}],
    ['categories', { categories: ['설비'] }, {}],
    ['projectIds', { projectIds: ['PRJ-1'] }, { projects: { 'PRJ-1': '3동 증설' } }],
    ['originKinds', { originKinds: ['ai'] }, { origins: { ai: 'AI 제안' } }],
    ['dueFrom', { dueFrom: '2026-09-01' }, {}],
    ['dueWithinDays', { dueWithinDays: 7 }, {}],
    ['overdueOnly', { overdueOnly: true }, {}],
    ['hasParent', { hasParent: true }, {}],
    ['text', { text: '납품' }, {}],
    ['fields', { fields: { vendor: ['A'] } }, { fields: { vendor: '거래처' } }],
  ]
  for (const [name, patch, names] of axes) {
    assert.equal(activeFilterCount(filters(patch)), 1, `${name}: 세는 쪽`)
    assert.notEqual(describeFilters(filters(patch), names), '', `${name} 축이 이름 제안에서 빠졌다`)
  }
  assert.equal(describeFilters(filters({ originKinds: ['ai'] }), { origins: { ai: 'AI 제안' } }), 'AI 제안')
  // 이름표를 못 받았으면 내부 값이라도 적는다 — 이름 제안이 빈 줄이 되는 것보다 낫다.
  assert.equal(describeFilters(filters({ originKinds: ['ai'] })), 'ai')
})

test('11-c. 화면의 정렬 축은 서버가 받는 일곱 개와 한 글자도 다르지 않다', () => {
  // 화면에만 있는 축을 저장하면 400이 되고, 서버에만 있는 축은 아무도 고를 수 없다.
  assert.deepEqual(Object.keys(WORK_SORT_FIELD_LABELS).sort(), [...SAVED_VIEW_SORT_FIELDS].sort())
  assert.equal(Object.values(WORK_SORT_FIELD_LABELS).every((label) => label.length > 0), true)
  assert.equal(WORK_SORT_FIELD_LABELS[DEFAULT_WORK_SORT.field], '마감')
})

test('12. 저장된 보기 기본값은 목록이고, 저장소를 못 읽어도 화면이 죽지 않는다', () => {
  // Node에는 window가 없다 — 사생활 보호 모드·저장 차단과 같은 갈래를 여기서 지난다.
  assert.equal(readStoredWorkView('TENANT:USER'), 'list')
})

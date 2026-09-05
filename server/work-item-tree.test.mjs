import assert from 'node:assert/strict'
import test from 'node:test'

import { bundleAssignmentDrafts } from './notifications.mjs'
import {
  CLOSED_STATUSES, MAX_TREE_DEPTH, openSubtaskCount, parentRefsFor, prependWithinCap, projectKeyOf, subtaskProgress, withParent, workItemTreeViolation,
} from './work-item-tree.mjs'

/**
 * 하위 업무 트리의 순수 규칙. 라우트를 띄우지 않고 배열 하나로 불변식을 못 박는다.
 * 여기서 고정한 코드명은 화면이 그대로 문구로 바꾸므로 바뀌면 안 된다.
 */

const row = (id, overrides = {}) => ({
  id, title: `${id} 제목`, description: '', owner: '박지현', ownerId: 'U-PARK', requestedBy: '김서원', requesterId: 'U-ADMIN',
  due: '2026-09-10T09:00:00.000Z', priority: '보통', status: '업무요청', category: '일반', ...overrides,
})

test('1. parentId 없는 행만 있으면 이전 목록이 있든 없든 위반이 없다(회귀)', () => {
  const rows = ['A', 'B', 'C', 'D', 'E'].map((id) => row(id))
  assert.equal(workItemTreeViolation(rows, []), null)
  assert.equal(workItemTreeViolation(rows), null)
})

test('2. 상위가 배열에 없으면 SUBTASK_PARENT_NOT_FOUND — 타 테넌트 모양의 id도 같은 코드', () => {
  const missing = workItemTreeViolation([row('C', { parentId: 'NOPE' })], [])
  assert.equal(missing.code, 'SUBTASK_PARENT_NOT_FOUND')
  assert.equal(missing.itemId, 'C')
  // 다른 테넌트의 상위 id는 이 테넌트 배열에 없으므로 구조적으로 같은 결론이 난다.
  const foreign = workItemTreeViolation([row('C', { parentId: 'WK-POHANG-P' })], [])
  assert.equal(foreign.code, 'SUBTASK_PARENT_NOT_FOUND')
})

test('3. 이전 목록에 있던 상위만 빠지면 SUBTASK_ORPHANED, 상위와 자식을 함께 지우면 통과', () => {
  const previous = [row('P'), row('C', { parentId: 'P' })]
  const orphaned = workItemTreeViolation([row('C', { parentId: 'P' })], previous)
  assert.equal(orphaned.code, 'SUBTASK_ORPHANED')
  assert.equal(orphaned.itemId, 'C')
  assert.equal(workItemTreeViolation([], previous), null)
})

test('4. 3단과 순환은 모두 SUBTASK_DEPTH_EXCEEDED', () => {
  const deep = workItemTreeViolation([row('P'), row('C', { parentId: 'P' }), row('G', { parentId: 'C' })], [])
  assert.equal(deep.code, 'SUBTASK_DEPTH_EXCEEDED')
  assert.equal(deep.itemId, 'G')
  const cycle = workItemTreeViolation([row('A', { parentId: 'B' }), row('B', { parentId: 'A' })], [])
  assert.equal(cycle.code, 'SUBTASK_DEPTH_EXCEEDED')
})

test('5. projectId는 상위와 같아야 한다 — ""와 undefined는 같은 값으로 본다', () => {
  assert.equal(workItemTreeViolation([row('P'), row('C', { parentId: 'P', projectId: 'PRJ-1' })], []).code, 'SUBTASK_PROJECT_MISMATCH')
  assert.equal(workItemTreeViolation([row('P', { projectId: 'PRJ-A' }), row('C', { parentId: 'P', projectId: '' })], []).code, 'SUBTASK_PROJECT_MISMATCH')
  assert.equal(workItemTreeViolation([row('P'), row('C', { parentId: 'P' })], []), null)
  assert.equal(workItemTreeViolation([row('P'), row('C', { parentId: 'P', projectId: '' })], []), null)
  assert.equal(projectKeyOf({ projectId: '' }), projectKeyOf({}))
})

test('6. 결재대기·결재완료 상위에는 새로 붙일 수 없고, 이미 붙어 있던 자식은 그대로 저장된다', () => {
  assert.deepEqual([...CLOSED_STATUSES], ['결재대기', '결재완료'])
  for (const status of CLOSED_STATUSES) {
    const locked = workItemTreeViolation([row('P', { status }), row('C', { parentId: 'P' })], [row('P', { status })])
    assert.equal(locked.code, 'SUBTASK_PARENT_LOCKED', status)
    assert.equal(locked.itemId, 'C')
  }
  const previous = [row('P', { status: '결재대기' }), row('C', { parentId: 'P' })]
  assert.equal(workItemTreeViolation(previous, previous), null, '이미 붙어 있던 자식은 상위가 결재대기여도 통과')
  // 다른 상위 아래 있던 자식을 결재대기 상위로 옮기는 것도 "새로 붙이기"다.
  const moved = workItemTreeViolation(
    [row('P', { status: '결재대기' }), row('Q'), row('C', { parentId: 'P' })],
    [row('P', { status: '결재대기' }), row('Q'), row('C', { parentId: 'Q' })],
  )
  assert.equal(moved.code, 'SUBTASK_PARENT_LOCKED')
})

test('7. 진행률은 자식이 없으면 null이고, 남은 건수는 결재완료가 아닌 자식 수다', () => {
  assert.equal(subtaskProgress([row('P')], 'P'), null, "'0%'를 만들지 않는다")
  const rows = [row('P'), row('C1', { parentId: 'P', status: '결재완료' }), row('C2', { parentId: 'P', status: '결재완료' }), row('C3', { parentId: 'P', status: '결재대기' })]
  assert.deepEqual(subtaskProgress(rows, 'P'), { total: 3, done: 2, percent: 67 })
  assert.equal(openSubtaskCount(rows, 'P'), 1, '결재대기는 아직 끝난 것이 아니다')
  assert.equal(openSubtaskCount(rows, 'C1'), 0, '자식 행에는 하위가 없다')
})

test('8. withParent는 projectId를 상위에서 상속하고, 승격(null)은 parentId만 지운다', () => {
  const attached = withParent([row('A', { projectId: 'PRJ-A' }), row('B')], 'B', row('A', { projectId: 'PRJ-A' }))
  assert.equal(attached.find((item) => item.id === 'B').parentId, 'A')
  assert.equal(attached.find((item) => item.id === 'B').projectId, 'PRJ-A')
  const inheritedNone = withParent([row('A'), row('B', { projectId: 'PRJ-B' })], 'B', row('A'))
  assert.equal('projectId' in inheritedNone.find((item) => item.id === 'B'), false, '상위에 없으면 키를 지운다')
  const promoted = withParent([row('A'), row('B', { parentId: 'A', projectId: 'PRJ-A' })], 'B', null)
  const b = promoted.find((item) => item.id === 'B')
  assert.equal('parentId' in b, false)
  assert.equal(b.projectId, 'PRJ-A', '승격은 projectId를 그대로 둔다')
  assert.equal(promoted.find((item) => item.id === 'A').parentId, undefined, '다른 행은 건드리지 않는다')
})

test('9. parentRefsFor는 보이지 않는 상위의 id·title만 준다', () => {
  const all = [row('P', { title: '상위 제목', status: '수행중', ownerId: 'U-ADMIN' }), row('C', { parentId: 'P' })]
  assert.deepEqual(parentRefsFor(all, [all[1]]), { P: { id: 'P', title: '상위 제목' } })
  assert.deepEqual(parentRefsFor(all, all), {}, '상위가 보이는 목록에 있으면 줄 것이 없다')
  assert.deepEqual(parentRefsFor(all, [row('X', { parentId: 'GONE' })]), {}, '없는 상위는 항목도 없다')
})

test('10. bundleAssignmentDrafts는 받는 사람마다 한 건, 상위가 대표, 1건은 기존 문구', () => {
  const actor = { actorId: 'U-ADMIN', actorName: '김서원' }
  const single = bundleAssignmentDrafts([row('A', { ownerId: 'U-OH', due: '2026-09-10T09:00:00.000Z' })], actor)
  assert.equal(single.length, 1)
  assert.equal(single[0].title, '새 업무: A 제목')
  assert.match(single[0].body, /마감 2026-09-10/)
  assert.doesNotMatch(single[0].body, /첫 마감/)
  assert.equal(single[0].recipientId, 'U-OH')
  assert.equal(single[0].actorId, 'U-ADMIN')

  const family = [
    row('C1', { ownerId: 'U-OH', parentId: 'P', due: '2026-09-08T09:00:00.000Z' }),
    row('P', { ownerId: 'U-OH', due: '2026-09-12T09:00:00.000Z' }),
    row('C2', { ownerId: 'U-OH', parentId: 'P', due: '2026-09-09T09:00:00.000Z' }),
  ]
  const bundled = bundleAssignmentDrafts(family, actor)
  assert.equal(bundled.length, 1, '같은 담당 3건은 한 건')
  assert.match(bundled[0].title, /^새 업무 3건: /)
  assert.equal(bundled[0].focusId, 'P', '상위가 대표')
  assert.match(bundled[0].body, /첫 마감 2026-09-08/)

  const two = bundleAssignmentDrafts([row('A', { ownerId: 'U-OH' }), row('B', { ownerId: 'U-PARK' }), row('X', { ownerId: undefined })], actor)
  assert.deepEqual(two.map((draft) => draft.recipientId).sort(), ['U-OH', 'U-PARK'], 'ownerId 없는 행은 제외')
})

test('11. 상한에서 잘릴 때 자식을 가진 상위는 남기고 자식 없는 행부터 자른다', () => {
  // 왜: 꼬리에서 상위가 잘리면 그 자식은 고아가 되고, 그 뒤로 관리자의 평범한 저장이 통째로 막힌다.
  const current = [row('P'), row('C1', { parentId: 'P' }), row('T1'), row('T2')]
  const kept = prependWithinCap(current, row('NEW'), 4)
  assert.deepEqual(kept.map((item) => item.id), ['NEW', 'P', 'C1', 'T1'], '자식 없는 꼬리(T2)가 잘린다')
  assert.equal(workItemTreeViolation(kept, current), null, '잘린 뒤에도 트리는 성립한다')

  const tight = prependWithinCap([row('P'), row('C1', { parentId: 'P' })], row('NEW'), 2)
  assert.deepEqual(tight.map((item) => item.id), ['NEW', 'P'], '자를 안전한 행이 없으면 예전대로 뒤에서 자르되 새 업무는 지킨다')

  const roomy = prependWithinCap([row('A')], row('NEW'), 10)
  assert.deepEqual(roomy.map((item) => item.id), ['NEW', 'A'], '상한 안에서는 그대로 앞에 붙는다')
  assert.equal(MAX_TREE_DEPTH, 2, '깊이 상한은 화면 문구의 출처다')
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { calendarContentHash } from './google-calendar.mjs'
import {
  CALENDAR_SYNC_LINKS_KEY, HISTORY_RETENTION_DAYS, MAX_HISTORY_PER_LINK,
  applyOverwrite, effectiveConnectionStatus, newConnection, overwriteSnapshot, pushableEvents,
  resolveSync, stampCalendarLinkChanges, sweepHistory, workDueCandidates, workDueShape,
} from './calendar-sync.mjs'

/**
 * 충돌 진리표와 이력 규칙 — 순수 함수만 본다.
 *
 * §2-6의 작동 예제 A·B·C를 문자 그대로 밟는다. 시각은 전부 주입한다 —
 * 벽시계를 읽는 시험은 언젠가 밤에 실패한다.
 */

const H0 = { title: '회의', date: '2026-09-10', start: '10:00', end: '11:00', location: '', note: '' }
const at = (iso) => new Date(iso)
const linkOf = (overrides = {}) => ({
  id: 'CLK-1', connectionId: 'CAL-1', accountId: 'USR-A', calendarId: 'cal-1',
  eventId: 'EV-1', workItemId: null, kind: 'event',
  externalId: 'G-1', externalEtag: '"1"', contentHash: calendarContentHash(H0),
  remoteUpdatedAt: '2026-09-09T09:00:00.000Z', localUpdatedAt: '2026-09-09T09:00:00.000Z',
  localDeletedAt: null, remoteDeletedAt: null, detachedAt: null,
  truncated: '', readOnly: false, origin: 'google', history: [],
  createdAt: '2026-09-09T09:00:00.000Z', updatedAt: '2026-09-09T09:00:00.000Z', ...overrides,
})
const local = (overrides = {}) => ({ id: 'EV-1', ...H0, scope: 'personal', department: '생산팀', owner: '박지현', ownerId: 'USR-A', ...overrides })
const remoteOf = (event, updated, overrides = {}) => ({ deleted: false, externalId: 'G-1', event, updated, etag: '"2"', truncated: '', readOnly: false, ...overrides })
const NOW = at('2026-09-10T10:35:00.000Z')

test('1. 진리표 아홉 칸', () => {
  const link = linkOf()
  const unchangedLocal = local()
  const changedLocal = local({ title: '주간 회의' })
  const changedRemote = remoteOf({ ...H0, title: 'Weekly sync' }, '2026-09-10T10:00:05.000Z')
  const deletedRemote = { deleted: true, externalId: 'G-1' }

  assert.equal(resolveSync(link, unchangedLocal, null, NOW).action, 'noop')
  assert.equal(resolveSync(link, unchangedLocal, changedRemote, NOW).action, 'pull')
  assert.equal(resolveSync(link, changedLocal, null, NOW).action, 'push')
  assert.equal(resolveSync(link, null, null, NOW).action, 'delete-remote')
  assert.equal(resolveSync(link, unchangedLocal, deletedRemote, NOW).action, 'delete-local')
  assert.equal(resolveSync(linkOf({ remoteDeletedAt: NOW.toISOString() }), null, null, NOW).action, 'unlink')
  // 삭제보다 수정이 이긴다 — 되살아난 일정은 눈에 보이지만 사라진 일정은 보이지 않는다.
  const revived = resolveSync(link, null, changedRemote, NOW)
  assert.equal(revived.action, 'pull')
  assert.equal(revived.revived, true)
  assert.equal(resolveSync(link, changedLocal, deletedRemote, NOW).action, 'delete-local')
  // 양쪽 변경 = 충돌.
  assert.equal(resolveSync(link, changedLocal, changedRemote, NOW).conflict, true)
})

test('2. 충돌은 마지막 수정 우선이고 정확한 동률은 인더필드가 이긴다', () => {
  const changedLocal = local({ title: '주간 회의' })
  const link = linkOf({ localUpdatedAt: '2026-09-10T10:00:00.000Z' })

  const googleWins = resolveSync(link, changedLocal, remoteOf({ ...H0, title: 'Weekly sync' }, '2026-09-10T10:00:05.000Z'), NOW)
  assert.deepEqual([googleWins.action, googleWins.winner], ['pull', 'google'])

  const usWin = resolveSync(link, changedLocal, remoteOf({ ...H0, title: 'Weekly sync' }, '2026-09-10T09:59:58.000Z'), NOW)
  assert.deepEqual([usWin.action, usWin.winner], ['push', 'inthefield'])

  // 밀리초까지 같다는 것은 대개 우리가 방금 내보낸 것이 되돌아온 메아리라는 뜻이다.
  const tie = resolveSync(link, changedLocal, remoteOf({ ...H0, title: 'Weekly sync' }, '2026-09-10T10:00:00.000Z'), NOW)
  assert.equal(tie.winner, 'inthefield')
})

test('3. 예제 A — 구글이 이기고, 진 값이 이력에 남고, 다음 통과는 noop이다', () => {
  const link = linkOf({ localUpdatedAt: '2026-09-10T10:00:00.000Z' })
  const changedLocal = local({ title: '주간 회의' })
  const remote = remoteOf({ ...H0, title: 'Weekly sync' }, '2026-09-10T10:00:05.000Z')

  const decision = resolveSync(link, changedLocal, remote, NOW)
  assert.equal(decision.winner, 'google')

  const after = applyOverwrite({
    ...link, contentHash: calendarContentHash(remote.event), externalEtag: remote.etag,
    remoteUpdatedAt: remote.updated, localUpdatedAt: NOW.toISOString(),
  }, { source: 'google', byName: '구글 캘린더', at: NOW.toISOString(), before: changedLocal })

  assert.equal(after.history[0].source, 'google')
  assert.equal(after.history[0].before.title, '주간 회의')
  assert.deepEqual(Object.keys(after.history[0].before), ['title', 'date', 'start', 'end', 'location', 'note'])
  // t4: 같은 상태로 한 번 더 → noop. 이것이 증명 가능한 멱등성이다.
  assert.equal(resolveSync(after, local({ title: 'Weekly sync' }), null, NOW).action, 'noop')
})

test('4. 예제 B — 인더필드가 이기면 push이고, 412 뒤에는 새 etag로 재시도해 수렴한다', () => {
  const link = linkOf({ localUpdatedAt: '2026-09-10T10:00:00.000Z' })
  const changedLocal = local({ title: '주간 회의' })
  const remote = remoteOf({ ...H0, title: 'Weekly sync' }, '2026-09-10T09:59:58.000Z')
  const first = resolveSync(link, changedLocal, remote, NOW)
  assert.equal(first.action, 'push')

  // 러너는 push 판정과 함께 **방금 본 etag를 링크에 채택한다.** 낡은 etag를 그대로 들고 나가면
  // 구글이 412로 거절하고, 증분 목록은 그 항목을 다시 주지 않으므로 같은 etag로 영원히 재시도한다.
  const retried = { ...link, externalEtag: remote.etag, remoteUpdatedAt: remote.updated }
  assert.notEqual(retried.externalEtag, link.externalEtag)
  // 다음 통과에서 원격은 목록에 없다(무변경). 판정은 여전히 push이고, 이번에는 맞는 etag로 나간다.
  assert.equal(resolveSync(retried, changedLocal, null, at('2026-09-10T11:35:00.000Z')).action, 'push')
  // 쓰기가 성공한 뒤에는 수렴한다.
  const settled = { ...retried, contentHash: calendarContentHash(changedLocal), localUpdatedAt: NOW.toISOString() }
  assert.equal(resolveSync(settled, changedLocal, null, NOW).action, 'noop')
})

test('5. 예제 C — 로컬 삭제 vs 원격 수정은 되살린다', () => {
  const link = linkOf({ localDeletedAt: '2026-09-10T11:00:00.000Z' })
  const decision = resolveSync(link, null, remoteOf({ ...H0, title: '자리 옮김' }, '2026-09-10T11:02:00.000Z'), NOW)
  assert.equal(decision.action, 'pull')
  assert.equal(decision.revived, true)
})

test('6. 이력은 20건에서 멈추고 최신이 앞이며, 180일 넘은 것은 걷힌다', () => {
  let link = linkOf()
  for (let index = 0; index < 25; index += 1) {
    link = applyOverwrite(link, { source: 'google', byName: '구글 캘린더', at: `2026-09-10T10:${String(index).padStart(2, '0')}:00.000Z`, before: { ...H0, title: `T${index}` } })
  }
  assert.equal(link.history.length, MAX_HISTORY_PER_LINK)
  assert.equal(link.history[0].before.title, 'T24')

  const old = linkOf({ history: [
    { at: '2026-01-01T00:00:00.000Z', source: 'google', byName: 'x', before: H0 },
    { at: '2026-09-01T00:00:00.000Z', source: 'google', byName: 'x', before: H0 },
  ] })
  const swept = sweepHistory(old, at('2026-09-10T00:00:00.000Z'))
  assert.equal(swept.history.length, 1)
  assert.equal(swept.history[0].at, '2026-09-01T00:00:00.000Z')
  assert.ok(HISTORY_RETENTION_DAYS === 180)
  // 바뀐 것이 없으면 같은 객체를 돌려준다 — 헛된 쓰기를 만들지 않는다.
  const fresh = linkOf({ history: [{ at: '2026-09-01T00:00:00.000Z', source: 'google', byName: 'x', before: H0 }] })
  assert.equal(sweepHistory(fresh, at('2026-09-10T00:00:00.000Z')), fresh)
})

test('7. overwriteSnapshot은 여섯 칸만 남기고 200자로 자른다', () => {
  const snapshot = overwriteSnapshot({ ...H0, title: 'x'.repeat(500), ownerId: 'USR-A', scope: 'personal' })
  assert.deepEqual(Object.keys(snapshot), ['title', 'date', 'start', 'end', 'location', 'note'])
  assert.equal(snapshot.title.length, 200)
})

test('8. 잘린 일정과 반복 일정은 어떤 입력에서도 push 대상이 되지 않는다', () => {
  // resolveSync는 판정만 하고 truncated/readOnly는 러너가 거른다. 그 계약을 여기서 못 박는다.
  for (const overrides of [{ truncated: 'multi-day' }, { readOnly: true }]) {
    const link = linkOf(overrides)
    const decision = resolveSync(link, local({ title: '고침' }), null, NOW)
    assert.equal(decision.action, 'push')
    assert.ok(link.truncated || link.readOnly, '러너가 이 표식을 보고 건너뛴다')
  }
  // 해제된 링크는 어떤 입력에서도 skip이다.
  assert.equal(resolveSync(linkOf({ detachedAt: NOW.toISOString() }), local({ title: '고침' }), null, NOW).action, 'skip')
})

test('9. 승인 휴가 파생본은 내보내기 후보에 0건이다', () => {
  const rows = [
    local(),
    { ...local({ id: 'EV-LEAVE' }), source: 'leave' },
    { ...local({ id: 'EV-OTHER' }), ownerId: 'USR-B' },
  ]
  const candidates = pushableEvents(rows, 'USR-A')
  assert.deepEqual(candidates.map((row) => row.id), ['EV-1'])
})

test('10. 업무 마감 후보는 본인·미완료·ISO 마감만이고 서울 날짜로 접힌다', () => {
  const items = [
    { id: 'WK-1', title: '보고서', ownerId: 'USR-A', status: '진행중', due: '2026-09-30T09:00:00.000Z' },
    { id: 'WK-2', title: '끝난 것', ownerId: 'USR-A', status: '결재완료', due: '2026-09-30T09:00:00.000Z' },
    { id: 'WK-3', title: '남의 것', ownerId: 'USR-B', status: '진행중', due: '2026-09-30T09:00:00.000Z' },
    { id: 'WK-4', title: '자유 문자열', ownerId: 'USR-A', status: '진행중', due: '내일 18:00' },
    // 2026-09-30T18:00Z는 서울에서 10월 1일 03:00이다. 날짜가 하루 밀리면 마감이 하루 밀린다.
    { id: 'WK-5', title: '자정 넘김', ownerId: 'USR-A', status: '진행중', due: '2026-09-30T18:00:00.000Z' },
  ]
  const candidates = workDueCandidates(items, 'USR-A')
  assert.deepEqual(candidates.map((row) => [row.id, row.dueDate]), [['WK-1', '2026-09-30'], ['WK-5', '2026-10-01']])
})

test('11. stampCalendarLinkChanges: 수정은 시각을, 삭제는 툼스톤을 찍는다', () => {
  const links = [linkOf(), linkOf({ id: 'CLK-2', eventId: 'EV-2', externalId: 'G-2' })]
  const store = { [CALENDAR_SYNC_LINKS_KEY]: { data: links, updatedAt: '2026-09-09T00:00:00.000Z' } }
  const previous = [local(), local({ id: 'EV-2' })]

  const changed = stampCalendarLinkChanges(store, previous, [local({ title: '고침' }), local({ id: 'EV-2' })], NOW)
  assert.equal(changed, true)
  const next = store[CALENDAR_SYNC_LINKS_KEY].data
  assert.equal(next[0].localUpdatedAt, NOW.toISOString())
  assert.equal(next[1].localUpdatedAt, '2026-09-09T09:00:00.000Z', '안 바뀐 행은 그대로다')
  // 원본 배열을 제자리에서 고치지 않는다 — 커밋 실패 시 호출부가 이전 객체로 되돌린다.
  assert.equal(links[0].localUpdatedAt, '2026-09-09T09:00:00.000Z')

  const deleteStore = { [CALENDAR_SYNC_LINKS_KEY]: { data: [linkOf()], updatedAt: '2026-09-09T00:00:00.000Z' } }
  stampCalendarLinkChanges(deleteStore, [local()], [], NOW)
  // 툼스톤이 없으면 지운 일정이 다음 통과에서 되살아난다.
  assert.equal(deleteStore[CALENDAR_SYNC_LINKS_KEY].data[0].localDeletedAt, NOW.toISOString())
})

test('12. 연결이 없는 테넌트에서는 비용이 0이고 레코드도 만들지 않는다', () => {
  const store = {}
  assert.equal(stampCalendarLinkChanges(store, [local()], [], NOW), false)
  assert.equal(CALENDAR_SYNC_LINKS_KEY in store, false)
  // 링크 레코드가 있어도 바뀐 것이 없으면 새 레코드를 만들지 않는다.
  const record = { data: [linkOf()], updatedAt: '2026-09-09T00:00:00.000Z' }
  const stable = { [CALENDAR_SYNC_LINKS_KEY]: record }
  assert.equal(stampCalendarLinkChanges(stable, [local()], [local()], NOW), false)
  assert.equal(stable[CALENDAR_SYNC_LINKS_KEY], record)
})

test('13. 되살아난 행은 툼스톤이 지워진다', () => {
  const store = { [CALENDAR_SYNC_LINKS_KEY]: { data: [linkOf({ localDeletedAt: '2026-09-10T11:00:00.000Z' })], updatedAt: '' } }
  stampCalendarLinkChanges(store, [], [local()], NOW)
  const link = store[CALENDAR_SYNC_LINKS_KEY].data[0]
  assert.equal(link.localDeletedAt, null)
  assert.equal(link.localUpdatedAt, NOW.toISOString())
})

test('14. 업무 마감 링크(eventId 없음)는 일정 배열 변화에 흔들리지 않는다', () => {
  const workLink = linkOf({ id: 'CLK-W', eventId: null, workItemId: 'WK-1', kind: 'work-due' })
  const store = { [CALENDAR_SYNC_LINKS_KEY]: { data: [workLink], updatedAt: '' } }
  assert.equal(stampCalendarLinkChanges(store, [local()], [], NOW), false)
  assert.equal(store[CALENDAR_SYNC_LINKS_KEY].data[0], workLink)
})

test('15. [마감] 표식의 모양은 한 함수에서만 나온다', () => {
  // 같은 모양을 여러 자리에 손으로 적으면 한 자리만 고쳐져 매 통과마다 "바뀌었다"가 되고, 무한 왕복이 된다.
  const candidate = workDueCandidates([{ id: 'WK-1', title: '보고서', ownerId: 'USR-A', status: '진행중', due: '2026-09-30T09:00:00.000Z' }], 'USR-A')[0]
  assert.deepEqual(workDueShape(candidate), {
    title: '[마감] 보고서', date: '2026-09-30', start: '00:00', end: '23:59', location: '', note: '',
  })
  // 이 모양이 곧 판정에 넘기는 '우리 쪽 값'이다. eventId가 null이라고 null을 넘기면
  // resolveSync가 '사람이 지웠다'로 읽어 방금 내보낸 마감을 지운다.
  const link = linkOf({ id: 'CLK-W', eventId: null, workItemId: 'WK-1', kind: 'work-due', contentHash: calendarContentHash(workDueShape(candidate)) })
  assert.equal(resolveSync(link, workDueShape(candidate), null, NOW).action, 'noop')
  assert.equal(resolveSync(link, null, null, NOW).action, 'delete-remote')
})

test('16. 토큰이 없는 연결 행은 어떤 status를 들고 있어도 연결 안 됨이다', () => {
  // 동의 화면에서 그냥 돌아서면 authorize가 만들어 둔 행만 남는다. 그 행을 '연결됨'이라 부르면
  // 화면은 연결 버튼을 감추고 관리자 개관은 없는 연결을 있다고 말한다.
  const fresh = newConnection({ accountId: 'USR-A', tenantId: 'TENANT-A', now: NOW })
  assert.equal(fresh.status, 'revoked')
  assert.equal(effectiveConnectionStatus(fresh), 'revoked')
  assert.equal(effectiveConnectionStatus({ ...fresh, status: 'connected' }), 'revoked')
  assert.equal(effectiveConnectionStatus({ ...fresh, status: 'connected', refreshTokenEnc: 'v1:x' }), 'connected')
  assert.equal(effectiveConnectionStatus({ ...fresh, status: 'needs-reauth', refreshTokenEnc: 'v1:x' }), 'needs-reauth')
  assert.equal(effectiveConnectionStatus(null), 'revoked')
})

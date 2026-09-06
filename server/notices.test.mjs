import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_NOTICE_BODY,
  acknowledgedAt,
  canManageNotice,
  canOpenNoticeAttachments,
  canWriteNotice,
  hasNoticeShape,
  isTarget,
  noticeAttachmentReaders,
  noticeFocusId,
  noticeTargetsFor,
  noticeVisibleTo,
  normalizeNoticeBody,
  normalizeNoticeTitle,
  prependNotice,
  readNotices,
  resolveNoticeTargets,
  unconfirmedTargets,
} from './notices.mjs'

/**
 * 공지의 순수 규칙 — shape 게이트와 권한 판정.
 *
 * shape는 저장 직전과 읽은 직후 양쪽에서 도는 가장 좁은 문이다. 여기서 한 갈래가 느슨해지면
 * 확인 명단에 없는 사람의 확인 기록이나 대상 밖의 리마인드가 조용히 저장된다.
 */

const ADMIN = { id: 'U-ADMIN', name: '관리자', role: 'tenant-admin', tenantId: 'T1' }
const MEMBER = { id: 'U-MEMBER', name: '구성원', role: 'tenant-member', tenantId: 'T1' }
const OTHER = { id: 'U-OTHER', name: '다른 구성원', role: 'tenant-member', tenantId: 'T1' }
const GUEST = { id: 'U-GUEST', name: '외부 게스트', role: 'tenant-guest', tenantId: 'T1', guestScope: { projectIds: ['PRJ-A'] } }

const PROJECT = { id: 'PRJ-A', name: '협업', members: [{ id: 'U-ADMIN', role: 'owner' }, { id: 'U-MEMBER', role: 'editor' }, { id: 'U-GUEST', role: 'viewer' }] }
const projectRoleOf = (project, auth) => {
  if (!project) return null
  if (auth.role === 'tenant-admin') return 'owner'
  return (project.members ?? []).find((member) => member.id === auth.id)?.role ?? null
}
/** 같은 PRJ-A의 두 방. grp-1은 게스트가 초대된 방, grp-2는 내부 구성원끼리의 방이다. */
const ROOMS = [
  { id: 'grp-1', projectId: 'PRJ-A', participantIds: ['U-ADMIN', 'U-MEMBER', 'U-GUEST'] },
  { id: 'grp-2', projectId: 'PRJ-A', participantIds: ['U-ADMIN', 'U-MEMBER'] },
]
const DEPS = {
  projectById: (id) => (id === PROJECT.id ? PROJECT : null),
  projectRoleOf,
  conversationById: (id) => ROOMS.find((item) => item.id === id) ?? null,
}

const companyNotice = (overrides = {}) => ({
  id: 'NTC-abc-0011ff', scope: 'company', conversationId: null, projectId: null,
  title: '9월 안전교육', body: '9월 12일 09:00\n대강당', attachments: [],
  authorId: 'U-ADMIN', authorName: '관리자', mustRead: true,
  targetIds: ['U-MEMBER', 'U-OTHER'], acknowledgements: [],
  reminders: { remindedAt: {}, summary48SentAt: null, lastManualRemindAt: null },
  archivedAt: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  ...overrides,
})
const projectNotice = (overrides = {}) => companyNotice({
  scope: 'project', conversationId: 'grp-1', projectId: 'PRJ-A', ...overrides,
})

test('hasNoticeShape는 키 집합·값 타입·교차 불변식을 한 문에서 본다', () => {
  assert.equal(hasNoticeShape(companyNotice()), true)
  assert.equal(hasNoticeShape(projectNotice()), true)

  // 키가 하나 더/덜
  assert.equal(hasNoticeShape({ ...companyNotice(), extra: 1 }), false, '목록 밖 키는 통과할 수 없다')
  const missing = companyNotice()
  delete missing.reminders
  assert.equal(hasNoticeShape(missing), false)

  // id 규약
  assert.equal(hasNoticeShape(companyNotice({ id: 'PT-abc-0011' })), false)
  assert.equal(hasNoticeShape(companyNotice({ id: 'NTC-a' })), false, '접두만 맞고 길이가 모자라면 거절한다')

  // 범위 교차 불변식
  assert.equal(hasNoticeShape(companyNotice({ conversationId: 'grp-1' })), false, '회사 공지는 채널을 갖지 않는다')
  assert.equal(hasNoticeShape(companyNotice({ projectId: 'PRJ-A' })), false)
  assert.equal(hasNoticeShape(projectNotice({ projectId: null })), false, '프로젝트 공지는 projectId가 반드시 있다')
  assert.equal(hasNoticeShape(projectNotice({ conversationId: null })), false)
  assert.equal(hasNoticeShape(companyNotice({ scope: 'team' })), false)

  // 제목·본문
  assert.equal(hasNoticeShape(companyNotice({ title: '   ' })), false)
  assert.equal(hasNoticeShape(companyNotice({ title: 'ㄱ'.repeat(121) })), false)
  assert.equal(hasNoticeShape(companyNotice({ body: '' })), false)
  assert.equal(hasNoticeShape(companyNotice({ body: 'ㄱ'.repeat(MAX_NOTICE_BODY + 1) })), false)

  // 태그 검사는 닫는 태그·실행 태그 두 형태만 — 평범한 부등호 문장을 400으로 되돌리지 않는다.
  assert.equal(hasNoticeShape(companyNotice({ body: '굵게 <b>강조</b>' })), false)
  assert.equal(hasNoticeShape(companyNotice({ body: '<script src="x">' })), false)
  assert.equal(hasNoticeShape(companyNotice({ body: '<iframe>' })), false)
  assert.equal(hasNoticeShape(companyNotice({ body: 'a<b 이면 참' })), true, '평범한 부등호 문장은 통과한다')
  assert.equal(hasNoticeShape(companyNotice({ body: '<b2b 채널> 정리' })), true)

  // 첨부
  assert.equal(hasNoticeShape(companyNotice({ attachments: [{ id: 'DOC-1', name: '도면.pdf', size: '1 KB' }] })), true)
  assert.equal(hasNoticeShape(companyNotice({ attachments: [{ id: 'X-1', name: '도면.pdf', size: '1 KB' }] })), false)
  assert.equal(hasNoticeShape(companyNotice({ attachments: [{ id: 'DOC-1', name: '도면.pdf', size: '1 KB', extra: 1 }] })), false)

  // 대상·확인
  assert.equal(hasNoticeShape(companyNotice({ targetIds: ['U-MEMBER', 'U-MEMBER'] })), false, '같은 대상이 두 번 있을 수 없다')
  assert.equal(hasNoticeShape(companyNotice({ acknowledgements: [{ accountId: 'U-NOBODY', at: '2026-09-02T00:00:00.000Z' }] })), false, '대상 아닌 사람의 확인 기록은 존재할 수 없다')
  assert.equal(hasNoticeShape(companyNotice({
    acknowledgements: [{ accountId: 'U-MEMBER', at: '2026-09-02T00:00:00.000Z' }, { accountId: 'U-MEMBER', at: '2026-09-03T00:00:00.000Z' }],
  })), false, '확인은 사람당 한 번이다')
  assert.equal(hasNoticeShape(companyNotice({ acknowledgements: [{ accountId: 'U-MEMBER', at: '어제' }] })), false)
  assert.equal(hasNoticeShape(companyNotice({ acknowledgements: [{ accountId: 'U-MEMBER' }] })), false)

  // 리마인더
  assert.equal(hasNoticeShape(companyNotice({ reminders: { remindedAt: {}, summary48SentAt: null } })), false, '리마인더 키가 모자라면 거절한다')
  assert.equal(hasNoticeShape(companyNotice({ reminders: { remindedAt: { 'U-MEMBER': '어제' }, summary48SentAt: null, lastManualRemindAt: null } })), false)
  assert.equal(hasNoticeShape(companyNotice({ reminders: { remindedAt: { 'U-MEMBER': '2026-09-02T00:00:00.000Z' }, summary48SentAt: '2026-09-03T00:00:00.000Z', lastManualRemindAt: null } })), true)

  // 시각
  assert.equal(hasNoticeShape(companyNotice({ archivedAt: '어제' })), false)
  assert.equal(hasNoticeShape(companyNotice({ createdAt: 'nope' })), false)
  assert.equal(hasNoticeShape(companyNotice({ mustRead: 'true' })), false)
  assert.equal(hasNoticeShape(null), false)
  assert.equal(hasNoticeShape([companyNotice()]), false)
})

test('readNotices는 성한 행만 내보내고 깨진 행 수를 함께 돌려준다', () => {
  const { rows, dropped } = readNotices({ data: [companyNotice(), { ...companyNotice({ id: 'NTC-bad-0022ee' }), extra: 1 }] })
  assert.equal(rows.length, 1)
  assert.equal(dropped, 1, '깨진 행은 세어서 쓰기를 막는 데 쓴다')
  assert.deepEqual(readNotices(null), { rows: [], dropped: 0 })
})

test('noticeVisibleTo — 회사 공지는 내부 구성원만, 프로젝트 공지는 그 프로젝트 역할이 있는 사람만', () => {
  assert.equal(noticeVisibleTo(companyNotice(), ADMIN, DEPS), true)
  assert.equal(noticeVisibleTo(companyNotice(), MEMBER, DEPS), true)
  assert.equal(noticeVisibleTo(companyNotice(), GUEST, DEPS), false, '회사 공지는 외부 게스트에게 존재하지 않는다')

  assert.equal(noticeVisibleTo(projectNotice(), MEMBER, DEPS), true)
  assert.equal(noticeVisibleTo(projectNotice(), GUEST, DEPS), true, '초대된 프로젝트의 채널 공지는 게스트도 본다')
  assert.equal(noticeVisibleTo(projectNotice(), OTHER, DEPS), false, '프로젝트 역할이 없으면 못 본다')
  assert.equal(noticeVisibleTo(projectNotice({ projectId: 'PRJ-GONE' }), MEMBER, DEPS), false)

  // 게스트는 방까지 본다. 같은 PRJ-A라도 참여자가 아닌 방('내부 전용')의 공지는 남의 방 이야기다 —
  // 같은 방의 메시지는 이미 그렇게 판정하므로(isConversationVisibleToMember) 공지만 다른 문을 쓰면 샌다.
  const insideRoom = projectNotice({ conversationId: 'grp-2' })
  assert.equal(noticeVisibleTo(insideRoom, GUEST, DEPS), false, '초대되지 않은 채널의 공지는 게스트에게 없다')
  assert.equal(noticeVisibleTo(insideRoom, MEMBER, DEPS), true, '내부 구성원의 규칙은 그대로 — 프로젝트 멤버면 본다')
  assert.equal(noticeVisibleTo(projectNotice({ conversationId: 'grp-gone' }), GUEST, DEPS), false, '없는 방의 공지도 마찬가지다')
  // 배선이 끊기면 '허락'이 아니라 '모른다' 쪽으로 넘어진다.
  assert.equal(noticeVisibleTo(projectNotice(), GUEST, { projectById: DEPS.projectById, projectRoleOf }), false)

  // 보관한 공지는 목록에서 내려가지만 작성자·관리자·프로젝트 owner에게는 남는다(되살릴 길).
  const archived = projectNotice({ archivedAt: '2026-09-05T00:00:00.000Z', authorId: 'U-MEMBER' })
  assert.equal(noticeVisibleTo(archived, OTHER, DEPS), false)
  assert.equal(noticeVisibleTo(archived, MEMBER, DEPS), true, '작성자에게는 보관분이 남는다')
  assert.equal(noticeVisibleTo(archived, ADMIN, DEPS), true)
  assert.equal(noticeVisibleTo(archived, GUEST, DEPS), false)
})

test('canWriteNotice / canManageNotice — 쓰는 권한과 다루는 권한은 다르다', () => {
  assert.equal(canWriteNotice('company', ADMIN, null, DEPS), true)
  assert.equal(canWriteNotice('company', MEMBER, null, DEPS), false)
  assert.equal(canWriteNotice('company', GUEST, null, DEPS), false)
  assert.equal(canWriteNotice('project', MEMBER, PROJECT, DEPS), true, 'editor는 프로젝트 공지를 쓴다')
  assert.equal(canWriteNotice('project', GUEST, PROJECT, DEPS), false, '게스트는 viewer라서 쓸 수 없다')
  assert.equal(canWriteNotice('project', OTHER, PROJECT, DEPS), false)

  const byMember = projectNotice({ authorId: 'U-MEMBER' })
  assert.equal(canManageNotice(byMember, MEMBER, DEPS), true, '작성자는 다룰 수 있다')
  assert.equal(canManageNotice(byMember, ADMIN, DEPS), true)
  assert.equal(canManageNotice(byMember, OTHER, DEPS), false)
  assert.equal(canManageNotice(byMember, GUEST, DEPS), false)
  // editor는 쓸 수는 있어도 남의 공지의 확인 명단을 볼 수는 없다.
  const byAdmin = projectNotice({ authorId: 'U-ADMIN' })
  assert.equal(canManageNotice(byAdmin, MEMBER, DEPS), false)
})

test('noticeTargetsFor — 회사는 승인된 내부 구성원만, 프로젝트는 채널 참여자', () => {
  const roster = [
    { id: 'U-ADMIN', tenantId: 'T1', role: 'tenant-admin', approved: true, approvalStatus: 'approved' },
    { id: 'U-MEMBER', tenantId: 'T1', role: 'tenant-member', approved: true, approvalStatus: 'approved' },
    { id: 'U-PENDING', tenantId: 'T1', role: 'tenant-member', approved: false, approvalStatus: 'pending' },
    { id: 'U-INACTIVE', tenantId: 'T1', role: 'tenant-member', approved: false, approvalStatus: 'inactive' },
    { id: 'U-GUEST', tenantId: 'T1', role: 'tenant-guest', approved: true, approvalStatus: 'approved' },
    { id: 'U-OTHERTENANT', tenantId: 'T2', role: 'tenant-member', approved: true, approvalStatus: 'approved' },
  ]
  assert.deepEqual(noticeTargetsFor({ scope: 'company', tenantId: 'T1', conversation: null, roster }), ['U-ADMIN', 'U-MEMBER'])
  assert.deepEqual(
    noticeTargetsFor({ scope: 'project', tenantId: 'T1', conversation: { participantIds: ['U-ADMIN', 'U-GUEST', 'U-ADMIN'] }, roster }),
    ['U-ADMIN', 'U-GUEST'],
    '프로젝트 공지는 게스트도 참여자면 받는다',
  )
  assert.deepEqual(noticeTargetsFor({ scope: 'project', tenantId: 'T1', conversation: {}, roster }), [])
  // 프로젝트 갈래도 로스터를 지난다. 계정 비활성화는 방의 participantIds를 정리하지 않고, 시스템 계정
  // (SYS-DEVELOPER-OPS)은 로스터에 아예 없다 — 거르지 않으면 컴포저가 그린 명단과 서버의 대상 수가
  // 어긋나고 미확인이 영영 0이 되지 않는다.
  assert.deepEqual(
    noticeTargetsFor({
      scope: 'project', tenantId: 'T1', roster,
      conversation: { participantIds: ['U-MEMBER', 'U-INACTIVE', 'U-PENDING', 'SYS-DEVELOPER-OPS', 'U-OTHERTENANT'] },
    }),
    ['U-MEMBER'],
    '퇴사·승인 대기·시스템·남의 테넌트 계정은 확인 대상이 아니다',
  )
})

test('resolveNoticeTargets는 좁히기만 허용한다 — 밖의 id가 하나라도 있으면 거절이다', () => {
  const audience = ['A', 'B', 'C']
  assert.deepEqual(resolveNoticeTargets(audience, undefined), audience, '주지 않으면 기본 집합 그대로다')
  assert.deepEqual(resolveNoticeTargets(audience, ['B', 'A', 'B']), ['B', 'A'])
  assert.equal(resolveNoticeTargets(audience, ['A', 'Z']), null, '권한 상승 시도를 침묵으로 넘기지 않는다')
  assert.equal(resolveNoticeTargets(audience, 'A'), null)
  assert.deepEqual(resolveNoticeTargets(audience, []), [])
})

test('normalizeNoticeBody는 줄바꿈을 지키고 제어문자만 버린다 — text()와 다르다', () => {
  assert.equal(normalizeNoticeBody('첫 줄\r\n둘째 줄'), '첫 줄\n둘째 줄')
  assert.equal(normalizeNoticeBody('앞뒤'), '앞뒤')
  assert.equal(normalizeNoticeBody('탭\t유지'), '탭\t유지')
  // 자르지 않는다. 자르면 라우트의 길이 판정이 죽은 코드가 되고 5,000자가 조용히 사라진다 —
  // 넘긴 글은 400으로 되돌려 보내야 사람이 자기 글이 사라진 것을 안다.
  assert.equal(normalizeNoticeBody('ㄱ'.repeat(MAX_NOTICE_BODY + 10)).length, MAX_NOTICE_BODY + 10)
  assert.equal(hasNoticeShape(companyNotice({ body: 'ㄱ'.repeat(MAX_NOTICE_BODY + 10) })), false, '상한을 넘긴 본문은 저장 문을 통과하지 못한다')
  assert.equal(normalizeNoticeBody(null), '')
})

test('normalizeNoticeTitle은 제목을 한 줄로 만들고 제어문자를 버린다 — 본문과 같은 정제다', () => {
  assert.equal(normalizeNoticeTitle('  9월\r\n안전교육  '), '9월 안전교육')
  assert.equal(normalizeNoticeTitle('경고 알림'), '경고 알림')
  assert.equal(normalizeNoticeTitle(null), '')
  // 제목은 알림·48시간 요약·전역 검색·발신 웹훅으로 그대로 흘러간다. 실행 태그가 섞이면 저장 문에서 막힌다.
  assert.equal(hasNoticeShape(companyNotice({ title: '경고 <script>alert(1)</script>' })), false)
  assert.equal(hasNoticeShape(companyNotice({ title: '줄\n바꿈' })), false)
  assert.equal(hasNoticeShape(companyNotice({ title: 'a<b 이면 참' })), true, '평범한 문장을 오탐하지 않는다')

  // 정제와 판정은 같은 제어문자 한 벌을 본다. 두 벌이면 한쪽이 남긴 글자를 다른 쪽이 거절해
  // 라우트의 400을 지난 입력이 자체검사(도달 불가능해야 하는 자리)에 걸려 500으로 되돌아온다.
  // 탭 한 글자가 그랬다 — 엑셀 칸이나 두 칸짜리 표에서 제목을 붙여 넣으면 딸려 온다.
  assert.equal(normalizeNoticeTitle('9월\t안전교육'), '9월 안전교육', '탭은 지우지 않고 한 칸으로 접는다')
  assert.equal(hasNoticeShape(companyNotice({ title: normalizeNoticeTitle('9월\t안전교육') })), true)
  assert.equal(hasNoticeShape(companyNotice({ title: '9월\t안전교육' })), false, '정제를 지나지 않은 탭은 저장 모양이 아니다')
})

test('noticeAttachmentReaders는 대상자·작성자·프로젝트 owner를 한 집합으로 모은다', () => {
  // 첨부를 열 수 있는 사람과 화면이 첨부 버튼을 그리는 사람은 같아야 한다 — 아니면 눌러도 404다.
  const company = noticeAttachmentReaders({ scope: 'company', targetIds: ['U-MEMBER', 'U-OTHER'], authorId: 'U-ADMIN', project: null })
  assert.deepEqual(company, ['U-MEMBER', 'U-OTHER', 'U-ADMIN'])
  const project = noticeAttachmentReaders({ scope: 'project', targetIds: ['U-MEMBER'], authorId: 'U-MEMBER', project: PROJECT })
  assert.deepEqual(project, ['U-MEMBER', 'U-ADMIN'], '작성자가 이미 대상이면 한 번만, 프로젝트 owner는 더해진다')

  const notice = companyNotice({ authorId: 'U-ADMIN', targetIds: ['U-MEMBER'] })
  assert.equal(canOpenNoticeAttachments(notice, MEMBER, false), true, '대상자는 연다')
  assert.equal(canOpenNoticeAttachments(notice, OTHER, false), false, '대상 밖에는 목록을 싣지 않는다')
  assert.equal(canOpenNoticeAttachments(notice, ADMIN, true), true, '다룰 수 있는 사람은 언제나 연다')
})

test('unconfirmedTargets는 확인한 사람과 작성자를 뺀다', () => {
  const notice = companyNotice({
    authorId: 'U-ADMIN',
    targetIds: ['U-ADMIN', 'U-MEMBER', 'U-OTHER'],
    acknowledgements: [{ accountId: 'U-MEMBER', at: '2026-09-02T00:00:00.000Z' }],
  })
  assert.deepEqual(unconfirmedTargets(notice), ['U-OTHER'])
  assert.equal(isTarget(notice, 'U-OTHER'), true)
  assert.equal(isTarget(notice, 'U-NOBODY'), false)
  assert.equal(isTarget(notice, undefined), false)
  assert.equal(acknowledgedAt(notice, 'U-MEMBER'), '2026-09-02T00:00:00.000Z')
  assert.equal(acknowledgedAt(notice, 'U-OTHER'), null)
})

test('prependNotice는 앞에 얹고 상한에서 오래된 것부터 잘라 낸다', () => {
  const rows = [companyNotice({ id: 'NTC-old-0011aa' }), companyNotice({ id: 'NTC-old-0011bb' })]
  const next = prependNotice(rows, companyNotice({ id: 'NTC-new-0011cc' }), 2)
  assert.deepEqual(next.map((item) => item.id), ['NTC-new-0011cc', 'NTC-old-0011aa'])
})

test('focusId 규약은 한 벌이다 — 회사 공지는 room 자리에 company가 들어간다', () => {
  assert.equal(noticeFocusId(companyNotice()), 'company:notice:NTC-abc-0011ff')
  assert.equal(noticeFocusId(projectNotice()), 'grp-1:notice:NTC-abc-0011ff')
})

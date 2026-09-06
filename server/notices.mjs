import { randomBytes } from 'node:crypto'

import { GUEST_ROLE } from './guest-access.mjs'
import { createNoticeAckWatch } from './notice-ack-watch.mjs'

/**
 * 공지 게시글 + 필독 확인 — 채널 안에 살지만 메시지가 아니다.
 *
 * 왜 메시지에 얹지 않는가: 말풍선은 4,000자 상한과 방당 5,000건 상한 안에서 산다. 공지는 장문이고,
 * 확인 명단과 리마인더 이력을 함께 들고 다닌다. 그것을 messages 배열에 우겨넣으면 방 하나가
 * 한도에 먼저 닿아 대화가 막힌다. 그래서 저장소 키를 따로 둔다.
 *
 * 왜 전용 라우트인가: generic /api/workspace/notices 는 404다(WORKSPACE_STORE_KEYS 밖).
 * 확인 명단은 증거이므로 "배열 통째로 교체"가 통하면 안 된다 — 한 번의 PUT이 누가 언제 확인했는지를
 * 조용히 갈아 치울 수 있기 때문이다. 그래서 삭제 라우트도 만들지 않고 보관만 둔다.
 */

export const NOTICES_KEY = 'notices'
export const MAX_NOTICE_TITLE = 120
export const MAX_NOTICE_BODY = 20_000
export const MAX_NOTICE_ATTACHMENTS = 10
// 알림 테넌트 상한 5,000(notifications.mjs)의 10%를 공지 한 건이 넘지 않게 한다.
// 수신자당 상한 300에 밀려 다른 알림이 사라지는 것을 이 숫자가 늦춘다.
export const MAX_NOTICE_TARGETS = 500
export const MAX_NOTICES_PER_TENANT = 2_000
export const NOTICE_SCOPES = new Set(['project', 'company'])
export const REMIND_AFTER_MS = 24 * 60 * 60 * 1_000
export const SUMMARY_AFTER_MS = 48 * 60 * 60 * 1_000
export const MANUAL_REMIND_COOLDOWN_MS = 60 * 60 * 1_000
export const SUMMARY_NAME_LIMIT = 10
export const MAX_REMINDERS_PER_RUN = 500
export const NOTICE_ID_PATTERN = /^NTC-[A-Za-z0-9-]{4,60}$/
export const newNoticeId = () => `NTC-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`

export const NOTICE_FIELDS = Object.freeze([
  'id', 'scope', 'conversationId', 'projectId', 'title', 'body', 'attachments',
  'authorId', 'authorName', 'mustRead', 'targetIds', 'acknowledgements', 'reminders',
  'archivedAt', 'createdAt', 'updatedAt',
])

/** 사람 이름을 못 찾았을 때. id를 그대로 노출하지 않는다. */
export const UNKNOWN_ACTOR_NAME = '퇴사한 계정'

// app.mjs의 hasExactFields와 같은 규칙이다. 공지 저장소는 app.mjs 밖에 있으므로 여기 한 벌 더 둔다 —
// "키가 정확히 이 목록"이라는 문장이 두 파일에 각각 있어야, 한쪽만 늘어난 필드가 조용히 저장되지 않는다.
const hasExactFields = (value, fields) => {
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}
const isIso = (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value))
const isId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 120

/**
 * 제어문자 범위 두 벌 — 제목용과 본문용. 이름이 "무엇을 남기는가"의 차이를 말한다.
 *
 * 왜 상수로 빼는가: 정제(normalize)와 판정(hasNoticeShape)이 서로 다른 범위를 들고 있으면,
 * 한쪽이 남긴 글자를 다른 쪽이 거절한다 — 라우트의 400은 통과하고 자체검사(도달 불가능해야 하는 자리)가
 * 걸려 사용자 입력이 500 NOTICE_WRITE_FAILED에 닿는다. 제목의 탭 한 글자가 정확히 그랬다
 * (엑셀 칸이나 두 칸짜리 표에서 제목을 붙여 넣으면 탭이 딸려 온다).
 */
const CONTROL_CHARS = /[\x00-\x1f]/
/** 같은 범위의 정제용 사본. source에서 만들어 두 문장이 갈라질 수 없게 한다
 *  (g 플래그를 붙인 정규식은 test()의 lastIndex가 움직이므로 판정에 그대로 쓰지 않는다). */
const CONTROL_CHARS_GLOBAL = new RegExp(CONTROL_CHARS.source, 'g')
/** 본문만 쓰는 범위 — \t(\x09)와 \n(\x0a)은 글의 일부이므로 남긴다. */
const CONTROL_CHARS_KEEP_TAB_NEWLINE = /[\x00-\x08\x0b-\x1f]/g

/** 공지 본문을 저장 모양으로 고른다. 줄바꿈만 지키고 제어문자는 버린다.
 *  messenger-rooms.mjs의 text()를 쓰면 안 된다 — 그 함수는 \s+를 공백 하나로 접어 줄바꿈을 없앤다.
 *
 *  여기서 자르지 않는다. 자르면 라우트의 길이 판정이 도달 불가능한 죽은 코드가 되고,
 *  25,000자를 보낸 사람은 5,000자가 사라진 줄 모른 채 201을 받는다 — 긴 글이 이 절의 핵심인데
 *  긴 글이 조용히 사라지는 편이 400보다 나쁘다. 길이는 라우트가 보고 400으로 답한다. */
export const normalizeNoticeBody = (value) =>
  String(value ?? '').replace(/\r\n/g, '\n').replace(CONTROL_CHARS_KEEP_TAB_NEWLINE, '')

/** 제목도 본문과 같은 정제를 받는다. 제목은 알림·48시간 요약·전역 검색·발신 웹훅으로 그대로 흘러가므로
 *  줄바꿈과 제어문자를 여기 한 곳에서 걷어 낸다(길이·태그 판정은 라우트가 한다).
 *
 *  제목은 한 줄이므로 탭도 남기지 않는다 — 다만 지우지 않고 공백 하나로 접는다.
 *  표에서 붙여 넣은 '9월\t안전교육'을 '9월안전교육'으로 만들면 낱말이 붙어 버린다.
 *  남는 범위는 hasNoticeShape가 보는 것과 같은 CONTROL_CHARS 한 벌이다. */
export const normalizeNoticeTitle = (value) =>
  String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(CONTROL_CHARS_GLOBAL, '').trim()

/** 공지 배열에 새 글을 얹고 상한을 지킨다. 하위 업무용 prependWithinCap을 빌려 쓰지 않는다 —
 *  그 함수의 '고아 방지'는 공지에 없는 의미다. */
export const prependNotice = (rows, notice, cap = MAX_NOTICES_PER_TENANT) => [notice, ...rows].slice(0, cap)

/** 본문에 실행 가능한 마크업이 섞였는가. 화면은 pre-wrap 텍스트 노드로만 그리므로 '<'를 통째로 막지 않는다 —
 *  'a<b 이면' 같은 평범한 문장을 400으로 되돌리는 편이 더 나쁘다. 닫는 태그와 실행 태그 두 형태만 거절한다. */
export const hasMarkupBody = (value) => /<\/[a-zA-Z]|<(?:script|iframe|object|embed|style|svg|link|meta)\b/i.test(String(value ?? ''))

export function hasNoticeShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (!hasExactFields(value, NOTICE_FIELDS)) return false
  if (!NOTICE_ID_PATTERN.test(String(value.id))) return false
  if (!NOTICE_SCOPES.has(value.scope)) return false
  if (value.scope === 'company') {
    if (value.conversationId !== null || value.projectId !== null) return false
  } else {
    // 프로젝트 공지는 반드시 projectId를 가진다 — RLS(app_guest_project_ids)가 이 값 하나로 판정하므로
    // null이면 게스트에게 안 보이거나(다행) 정책 밖으로 새는(치명) 두 갈래가 생긴다.
    if (!isId(value.conversationId) || !isId(value.projectId)) return false
  }
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > MAX_NOTICE_TITLE) return false
  // 제목도 본문과 같은 문을 지난다. 제목만 느슨하면 알림·요약·검색·웹훅이 태그 섞인 문자열을 그대로 나른다.
  // 범위는 normalizeNoticeTitle이 지우는 것과 같은 한 벌이다(CONTROL_CHARS) — 두 벌이면 정제가 남긴 글자를
  // 여기서 거절해 라우트의 400을 지나친 입력이 500에 닿는다.
  if (CONTROL_CHARS.test(value.title) || hasMarkupBody(value.title)) return false
  if (typeof value.body !== 'string' || !value.body.trim() || value.body.length > MAX_NOTICE_BODY) return false
  if (hasMarkupBody(value.body)) return false
  if (!Array.isArray(value.attachments) || value.attachments.length > MAX_NOTICE_ATTACHMENTS) return false
  if (!value.attachments.every((item) => item && hasExactFields(item, ['id', 'name', 'size'])
    && typeof item.id === 'string' && item.id.startsWith('DOC-')
    && typeof item.name === 'string' && item.name.trim() && item.name.length <= 180
    && typeof item.size === 'string' && item.size.length <= 40)) return false
  if (!isId(value.authorId) || typeof value.authorName !== 'string' || value.authorName.length > 120) return false
  if (typeof value.mustRead !== 'boolean') return false
  if (!Array.isArray(value.targetIds) || value.targetIds.length > MAX_NOTICE_TARGETS) return false
  if (!value.targetIds.every(isId) || new Set(value.targetIds).size !== value.targetIds.length) return false
  if (!Array.isArray(value.acknowledgements) || value.acknowledgements.length > MAX_NOTICE_TARGETS) return false
  const acked = new Set()
  for (const row of value.acknowledgements) {
    if (!row || !hasExactFields(row, ['accountId', 'at']) || !isId(row.accountId) || !isIso(row.at)) return false
    if (acked.has(row.accountId)) return false                  // 확인은 사람당 한 번이다
    if (!value.targetIds.includes(row.accountId)) return false   // 대상 아닌 사람의 확인 기록은 존재할 수 없다
    acked.add(row.accountId)
  }
  const reminders = value.reminders
  if (!reminders || typeof reminders !== 'object' || Array.isArray(reminders)) return false
  if (!hasExactFields(reminders, ['remindedAt', 'summary48SentAt', 'lastManualRemindAt'])) return false
  if (!reminders.remindedAt || typeof reminders.remindedAt !== 'object' || Array.isArray(reminders.remindedAt)) return false
  const remindedKeys = Object.keys(reminders.remindedAt)
  if (remindedKeys.length > MAX_NOTICE_TARGETS) return false
  if (!remindedKeys.every((key) => isId(key) && isIso(reminders.remindedAt[key]))) return false
  if (reminders.summary48SentAt !== null && !isIso(reminders.summary48SentAt)) return false
  if (reminders.lastManualRemindAt !== null && !isIso(reminders.lastManualRemindAt)) return false
  if (value.archivedAt !== null && !isIso(value.archivedAt)) return false
  return isIso(value.createdAt) && isIso(value.updatedAt)
}

/**
 * 저장된 행을 읽는다.
 *
 * 알림(notification-routes.mjs)은 한 행만 깨져도 전체를 500으로 막는데, 그러면 그 테넌트의
 * 알림 센터가 통째로 죽는다. 공지는 다르게 한다 — 읽기는 성한 행만 내보내고, 쓰기는 거절한다.
 * 깨진 행을 덮어써서 확인 명단을 잃는 것이 500보다 나쁘다.
 */
export function readNotices(record) {
  const raw = Array.isArray(record?.data) ? record.data : []
  const rows = raw.filter(hasNoticeShape)
  return { rows, dropped: raw.length - rows.length }
}

// ---------------------------------------------------------------------------
// 가시성·권한 — 함수 하나씩, 시그니처 한 벌
//
// 규칙이 두 벌이 되면 목록과 검색이 어긋난다. 라우트도 전역 검색도 아래 시그니처 그대로 부른다.
// deps는 언제나 { projectById, projectRoleOf, conversationById } 세 개다 — 호출부마다 인자 수가 다르면
// 검색 갈래가 조용히 전량 통과하거나 전량 탈락한다(권한 판정이므로 전자가 치명적).
// ---------------------------------------------------------------------------

export function noticeVisibleTo(notice, auth, deps) {
  if (!notice || !auth) return false
  // 보관한 공지는 목록에서 내려가지만 작성자·관리자에게는 남는다(되살릴 길을 화면에 두기 위해).
  if (notice.archivedAt && !canManageNotice(notice, auth, deps)) return false
  if (notice.scope === 'company') return auth.role === 'tenant-admin' || auth.role === 'tenant-member'
  const project = deps.projectById(notice.projectId)
  if (!project || deps.projectRoleOf(project, auth) === null) return false
  // 내부 구성원은 여기서 끝난다 — 프로젝트 멤버면 그 프로젝트의 공지를 본다(방 참여 여부와 무관하다).
  // 게스트는 한 문을 더 지난다: 초대된 프로젝트라도 '내부 전용' 채널의 공지는 남의 방 이야기다.
  // 같은 방의 메시지는 이미 그렇게 판정한다(isConversationVisibleToMember는 participantIds를 요구한다).
  // 공지만 프로젝트 소속으로 판정하면, 게스트가 못 들어가는 방의 제목·본문을 통째로 읽는다.
  if (auth.role !== GUEST_ROLE) return true
  const conversation = deps.conversationById?.(notice.conversationId) ?? null
  // conversationById가 없으면 '모른다'이지 '허락'이 아니다. 배선이 끊기면 게스트에게 안 보이는 쪽으로 넘어진다.
  return Boolean(conversation) && Array.isArray(conversation.participantIds)
    && conversation.participantIds.includes(auth.id)
}

/** 이 채널·범위에 공지를 쓸 수 있는가. 회사 공지는 관리자만, 프로젝트 공지는 owner/editor. */
export function canWriteNotice(scope, auth, project, deps) {
  if (!auth || auth.role === GUEST_ROLE) return false   // 게이트가 먼저 막지만 라우트도 같은 결론을 낸다
  if (scope === 'company') return auth.role === 'tenant-admin'
  return ['owner', 'editor'].includes(deps.projectRoleOf(project, auth))
}

/** 확인 명단·다시 알림·수정·보관을 다룰 수 있는가 — 작성자 ∪ 테넌트 관리자 ∪ 프로젝트 owner. */
export function canManageNotice(notice, auth, deps) {
  if (!notice || !auth || auth.role === GUEST_ROLE) return false
  if (notice.authorId === auth.id || auth.role === 'tenant-admin') return true
  if (notice.scope !== 'project') return false
  const project = deps.projectById(notice.projectId)
  return Boolean(project) && deps.projectRoleOf(project, auth) === 'owner'
}

export const unconfirmedTargets = (notice) => {
  const done = new Set((notice.acknowledgements ?? []).map((row) => row.accountId))
  return (notice.targetIds ?? []).filter((id) => !done.has(id) && id !== notice.authorId)
}
export const isTarget = (notice, accountId) => Boolean(accountId) && (notice.targetIds ?? []).includes(accountId)
export const acknowledgedAt = (notice, accountId) =>
  (notice.acknowledgements ?? []).find((row) => row.accountId === accountId)?.at ?? null

/**
 * 공지를 받는 사람들의 기본 집합.
 *
 * 회사 공지는 승인된 내부 구성원 전부(게스트·비활성·승인 대기 제외), 프로젝트 공지는 그 채널 참여자다.
 * 계정의 실제 필드는 approved(boolean)와 approvalStatus('approved'|'pending'|'rejected'|'inactive')다.
 *
 * 두 갈래 모두 roster를 지난다. participantIds를 그대로 쓰면 방에 남아 있는 퇴사 계정과 시스템 계정
 * (SYS-DEVELOPER-OPS)이 대상이 된다 — 계정 비활성화는 방 참여자 목록을 정리하지 않으므로 '방에 있던
 * 사람이 퇴사한다'는 평범한 경로로 도달한다. 그러면 컴포저가 그린 명단(/api/directory에서 system·
 * active=false를 뺀다)과 서버의 대상 수가 어긋나 작성자는 '1명'을 보고 올린 뒤 '0/3명'을 읽고,
 * 미확인은 영영 0이 되지 않으며, 다시 알림과 48시간 요약이 죽은 계정을 계속 싣는다.
 * 게스트는 프로젝트 공지의 정상 대상이므로 회사 갈래와 달리 role은 거르지 않는다.
 */
export function noticeTargetsFor({ scope, tenantId, conversation, roster }) {
  const active = new Set((roster ?? [])
    .filter((account) => account?.tenantId === tenantId && account.approved === true
      && account.approvalStatus !== 'inactive')
    .map((account) => account.id))
  if (scope === 'company') {
    return [...new Set((roster ?? [])
      .filter((account) => active.has(account?.id) && account.role !== GUEST_ROLE)
      .map((account) => account.id))]
  }
  return [...new Set((conversation?.participantIds ?? []).filter((id) => id && active.has(id)))]
}

/**
 * 첨부 문서를 열 수 있어야 하는 사람들.
 *
 * 공지를 볼 수 있는 사람과 첨부를 열 수 있는 사람이 어긋나면 화면이 눌러도 404가 나는 버튼을 그린다.
 * 그래서 이 집합과 publicNotice가 첨부를 싣는 조건을 한 문장으로 맞춘다 — 대상자 ∪ 작성자 ∪ 프로젝트 owner.
 * 테넌트 관리자는 자료실 전부를 읽으므로(canReadDocument) 여기 넣지 않는다.
 * 대상자를 좁힌 공지의 첨부를 회사 전원에게 열어 주지도 않는다 — 좁혔다는 뜻이 파일에서 뒤집히면 안 된다.
 */
export const noticeAttachmentReaders = ({ scope, targetIds, authorId, project }) => [...new Set([
  ...(targetIds ?? []),
  authorId,
  ...(scope === 'project' && project
    ? [project.ownerId, ...(project.members ?? []).filter((member) => member?.role === 'owner').map((member) => member?.id)]
    : []),
].filter(Boolean))]

/** 이 사람에게 첨부 목록을 실어도 되는가. noticeAttachmentReaders와 같은 문장이다(관리자는 canManage로 들어온다). */
export const canOpenNoticeAttachments = (notice, auth, manage) => Boolean(manage) || isTarget(notice, auth?.id)

/** 알림·전역 검색·웹푸시가 공유하는 focusId 규약: '<conversationId|company>:notice:<id>'.
 *  buildNotification이 focusId를 120자로 자르므로 NTC-<base36>-<hex6>도 여유 있게 들어간다. */
export const noticeFocusId = (notice) => `${notice.conversationId ?? 'company'}:notice:${notice.id}`

const noticeSource = (notice) => ({ kind: 'notice', id: notice.id, label: '공지' })

/** 게시 알림 한 벌. 문구가 두 곳에 흩어지지 않게 초안도 여기서만 만든다. */
export const noticePostedDraft = (notice, recipientId) => ({
  type: 'notice-posted', recipientId, actorId: notice.authorId,
  title: `${notice.mustRead ? '[필독] ' : ''}${notice.title}`,
  body: notice.mustRead ? `${notice.authorName}님이 올렸습니다. 확인 버튼을 눌러 주세요.` : `${notice.authorName}님이 올렸습니다.`,
  page: 'messenger', focusId: noticeFocusId(notice), source: noticeSource(notice),
})

/** 24시간 리마인드와 '다시 알림'이 같은 문장을 쓴다 — 사람이 받는 알림은 한 종류이기 때문이다. */
export const noticeReminderDraft = (notice, recipientId) => ({
  type: 'notice-reminder', recipientId, actorId: null,
  title: `아직 확인하지 않은 공지: ${notice.title}`,
  body: '[확인했습니다]를 누르면 기록됩니다.',
  page: 'messenger', focusId: noticeFocusId(notice), source: noticeSource(notice),
})

/** 48시간 작성자 요약. 이름은 최대 SUMMARY_NAME_LIMIT명까지 적고 나머지는 '외 N명'으로 접는다. */
export const noticeSummaryDraft = (notice, names) => ({
  type: 'notice-unconfirmed-summary', recipientId: notice.authorId, actorId: null,
  title: `미확인 ${names.length}명 · ${notice.title}`,
  body: `${names.slice(0, SUMMARY_NAME_LIMIT).join(', ')}${names.length > SUMMARY_NAME_LIMIT ? ` 외 ${names.length - SUMMARY_NAME_LIMIT}명` : ''}`,
  page: 'messenger', focusId: noticeFocusId(notice), source: noticeSource(notice),
})

const NOT_FOUND = { code: 'NOTICE_NOT_FOUND', message: '공지를 찾을 수 없습니다.' }
// 볼 수는 있지만 다룰 수는 없는 자리. 존재를 이미 아는 사람이므로 404로 숨기지 않는다 —
// 여기서 404를 내면 화면이 "공지가 사라졌다"고 잘못 말하게 된다.
const MANAGE_FORBIDDEN = { code: 'NOTICE_MANAGE_FORBIDDEN', message: '작성자와 관리자만 공지를 고치거나 다시 알릴 수 있습니다.' }
const DATA_INVALID = { code: 'NOTICE_DATA_INVALID', message: '저장된 공지 중 형식이 깨진 것이 있어 쓰기를 멈췄습니다. 개발운영진에게 알려 주세요.' }
const WRITE_FAILED = { code: 'NOTICE_WRITE_FAILED', message: '공지를 저장하지 못했습니다.' }
// 화면의 낱말과 같아야 한다. 컴포저는 이 목록을 '확인 대상'이라 부른다 —
// 공지 자체는 회사(또는 프로젝트) 전원이 보고, 이 목록은 확인 기록과 첨부 열람의 범위다.
const TARGETS_INVALID = { code: 'INVALID_NOTICE_TARGETS', message: '확인 대상 목록을 확인해 주세요. 기본 대상자 안에서만 고를 수 있습니다.' }
// '한 명도 안 남았다'와 '기본 대상자 밖을 골랐다'는 다른 사실이다. 한 문장이 둘을 겸하면
// 전원을 체크 해제한 사람이 자기가 하지 않은 잘못("밖에서 골랐다")을 읽는다.
// 이 문장은 '작성자가 지웠다'일 때만 쓴다 — 애초에 남길 사람이 없던 테넌트에게 이 말을 하면
// 화면에 없는 행동을 시키는 것이 된다(그 경우는 아래 audience.length > 0 조건이 걸러 낸다).
const TARGETS_EMPTY = { code: 'NOTICE_TARGETS_EMPTY', message: '확인 대상이 한 명도 남지 않았습니다. 최소 한 사람은 남겨 주세요.' }
// 반대쪽 끝도 같은 이유로 자기 문장을 가진다. 아무것도 고르지 않은 사람에게 '밖에서 골랐다'고
// 말하면, 사람이 많아서 막혔다는 사실이 문장 어디에도 남지 않는다.
//
// 문장은 화면이 할 수 있는 일만 말한다. '채널 공지로 나눠 올려 주세요'는 회사 전원에게 닿지 않고
// (전사 채널 team-ops에는 projectId가 없어 400이다), 컴포저의 확인 대상 목록은 필독일 때만 열린다 —
// 기본 대상만으로 상한을 넘긴 사람에게 그 말을 하면 화면에 없는 행동을 시키는 것이 된다.
// 상한은 알림 팬아웃을 묶는 의도된 상수이므로(MAX_NOTICE_TARGETS 주석) 여기서 풀지 않고, 대신
// 이 규모에서 실제로 할 수 있는 한 가지 — 개발운영진에게 알리는 길 — 을 가리킨다.
const TARGETS_TOO_MANY = { code: 'NOTICE_TARGETS_TOO_MANY', message: `확인 대상은 ${MAX_NOTICE_TARGETS.toLocaleString('ko-KR')}명까지입니다. 이 인원의 회사 전체 공지는 아직 올릴 수 없으니 개발운영진에게 알려 주세요.` }
// 제목 판정은 POST·PATCH가 같은 문장을 쓴다.
const TITLE_INVALID_MESSAGE = `제목은 1~${MAX_NOTICE_TITLE}자로 적어 주세요. 줄바꿈과 태그는 넣을 수 없습니다.`
// ack 라우트와 remind 라우트가 같은 문장을 쓴다 — 필독이 아닌 공지에는 확인 기록이 없다.
const ACK_NOT_REQUIRED = { code: 'NOTICE_ACK_NOT_REQUIRED', message: '필독 공지가 아니라 확인 기록을 남기지 않습니다.' }
// 같은 이유로 보관 판정도 한 문장이다. ack는 거절하는데 remind만 200을 내면, 받은 사람은
// '[확인했습니다]를 누르라'는 알림을 받고도 그 공지를 목록에서 찾을 수 없고 눌러도 409를 만난다.
const ARCHIVED = { code: 'NOTICE_ARCHIVED', message: '보관된 공지입니다.' }
const BODY_INVALID_MESSAGE = `본문은 1~${MAX_NOTICE_BODY.toLocaleString('ko-KR')}자의 글로 적어 주세요. 태그는 넣을 수 없습니다.`

/** 요청 본문의 targetIds를 audience 안으로 좁힌다. 밖의 id가 하나라도 있으면 null(=거절)이다. */
export function resolveNoticeTargets(audience, requested) {
  if (requested === undefined || requested === null) return audience
  if (!Array.isArray(requested)) return null
  const allowed = new Set(audience)
  const picked = []
  for (const raw of requested) {
    const id = String(raw ?? '')
    if (!allowed.has(id)) return null          // 권한 상승 시도를 침묵으로 넘기지 않는다
    if (!picked.includes(id)) picked.push(id)
  }
  return picked
}

export function publicNotice(notice, auth, deps) {
  const manage = canManageNotice(notice, auth, deps)
  const acked = acknowledgedAt(notice, auth?.id)
  // 열 수 없는 첨부는 목록에 싣지 않는다 — 화면이 눌러도 404가 나는 버튼을 그리게 된다.
  // 대신 몇 개가 붙어 있는지는 알려 준다(가짜 0을 만들지 않는다).
  const openable = canOpenNoticeAttachments(notice, auth, manage)
  return {
    id: notice.id,
    scope: notice.scope,
    conversationId: notice.conversationId,
    projectId: notice.projectId,
    title: notice.title,
    body: notice.body,
    attachments: openable ? notice.attachments.map((item) => ({ ...item })) : [],
    attachmentCount: notice.attachments.length,
    authorId: notice.authorId,
    authorName: notice.authorName,
    mustRead: notice.mustRead,
    archivedAt: notice.archivedAt,
    createdAt: notice.createdAt,
    updatedAt: notice.updatedAt,
    acknowledgedAt: acked,
    canAck: Boolean(notice.mustRead && isTarget(notice, auth?.id) && !acked && !notice.archivedAt),
    canManage: manage,
    // 명단도, 그 명단의 인원수도 관리 권한이 있을 때만 실린다 — 아니면 다른 사람의 미확인 사실이
    // 전 직원에게 샌다. 이름이 없어도 '아직 N명이 안 눌렀다'는 남의 근태를 짐작하게 하는 정보다.
    // 화면은 두 값을 canManage 안에서만 그리므로(NoticeCenter.tsx) 여기서 가려도 보이는 것은 그대로다.
    ...(manage
      ? {
        targetCount: notice.targetIds.length,
        confirmedCount: notice.acknowledgements.length,
        targetIds: [...notice.targetIds],
        acknowledgements: notice.acknowledgements.map((row) => ({ ...row })),
        lastRemindAt: notice.reminders.lastManualRemindAt,
      }
      : {}),
  }
}

export function registerNoticeRoutes({
  app, requireAuth, requireMatchingWorkspaceIdentity,
  workspaceStore, accounts, commitWorkspaceStore,
  resolveMessengerAttachments, grantDocumentAccess, guestVisibleRows,
  projectSpacesOf, projectRoleOf, isConversationVisibleToMember, isDeveloperSupportConversation,
  notify, events, emitWebhookEvent,
  clock = () => new Date(),
}) {
  const nowIso = () => clock().toISOString()
  const recordOf = (tenantId) => workspaceStore.tenants[tenantId]?.[NOTICES_KEY]
  const noticesOf = (tenantId) => readNotices(recordOf(tenantId))
  const conversationsOf = (tenantId) => {
    const record = workspaceStore.tenants[tenantId]?.['messenger-conversations']
    return Array.isArray(record?.data) ? record.data : []
  }
  const depsFor = (tenantId) => {
    const projects = projectSpacesOf(tenantId)
    const conversations = conversationsOf(tenantId)
    return {
      projectById: (id) => projects.find((item) => item?.id === id) ?? null,
      projectRoleOf,
      // 게스트의 프로젝트 공지 판정이 '그 방에 초대되었는가'까지 본다(noticeVisibleTo).
      conversationById: (id) => conversations.find((item) => item?.id === id) ?? null,
    }
  }
  const nameOf = (tenantId, accountId) =>
    accounts.find((item) => item?.id === accountId && item.tenantId === tenantId)?.name ?? UNKNOWN_ACTOR_NAME

  const requireTenant = (request, response) => {
    if (!request.auth?.tenantId) {
      response.status(403).json({ error: { code: 'TENANT_REQUIRED', message: '고객사 워크스페이스에서만 사용할 수 있습니다.' } })
      return false
    }
    return true
  }

  /** 쓰기 전에 저장된 행이 전부 성한지 본다. 깨진 행 위에 덮어쓰면 그 행의 확인 명단이 사라진다. */
  const readableRows = (tenantId, response) => {
    const { rows, dropped } = noticesOf(tenantId)
    if (dropped > 0) { response.status(409).json({ error: DATA_INVALID }); return null }
    return rows
  }

  /**
   * 공지를 저장한다. **문서 접근 부여와 공지 저장은 한 커밋이다.**
   *
   * grantDocumentAccess는 메모리의 company-documents만 바꾸고 스스로 커밋하지 않는다. 그래서
   * 그 호출을 grant 콜백으로 받아 커밋 '앞'에서 돌리고, 실패하면 두 키를 함께 되돌린다.
   * 그러지 않으면 재기동 뒤 공지에는 첨부가 실려 있는데 대상자는 그 파일을 못 받는다
   * (app.mjs의 다른 다섯 호출부도 전부 이 순서다).
   */
  const writeNotices = async (tenantId, data, actorId, response, grant) => {
    const tenantStore = workspaceStore.tenants[tenantId] ??= {}
    const previous = tenantStore[NOTICES_KEY]
    const previousDocuments = tenantStore['company-documents']
    tenantStore[NOTICES_KEY] = { data, updatedAt: nowIso(), updatedBy: actorId }
    grant?.()
    try {
      await commitWorkspaceStore()
    } catch {
      if (previous) tenantStore[NOTICES_KEY] = previous
      else delete tenantStore[NOTICES_KEY]
      if (previousDocuments) tenantStore['company-documents'] = previousDocuments
      response.status(500).json({ error: WRITE_FAILED })
      return false
    }
    return true
  }

  const publishChange = (tenantId, notice) => {
    // 새 SSE 종류를 만들지 않는다. 화면은 'message'를 받으면 공지도 함께 다시 읽는다.
    try { events.publish(tenantId, 'message', { key: NOTICES_KEY, conversationId: notice.conversationId ?? '' }) }
    catch { /* 이벤트를 못 보낸 것이 저장을 되돌릴 이유는 아니다 */ }
  }

  /** 목록·상세가 함께 쓰는 조회. 못 보는 공지와 없는 공지를 구분하지 않는다(둘 다 404). */
  /**
   * 공지 한 건을 찾아 가시성까지 판정한다.
   *
   * allowArchived: 보관된 공지는 목록에서 내려가지만, 그 공지를 눈앞에 두고 있던 대상자가
   * [확인했습니다]를 누른 순간에는 "없는 글"이 아니라 "보관된 글"이라고 답해야 한다.
   * 그래야 NOTICE_ARCHIVED가 도달 가능한 코드가 되고, 사람은 왜 안 되는지 안다.
   */
  const locate = async (request, response, { allowArchived = false } = {}) => {
    const tenantId = request.auth.tenantId
    const { rows } = noticesOf(tenantId)
    const deps = depsFor(tenantId)
    const notice = rows.find((item) => item.id === request.params.id)
    const visible = notice
      && (noticeVisibleTo(notice, request.auth, deps)
        || (allowArchived && Boolean(notice.archivedAt) && noticeVisibleTo({ ...notice, archivedAt: null }, request.auth, deps)))
    if (!visible) {
      response.status(404).json({ error: NOT_FOUND })
      return null
    }
    if (request.auth.role === GUEST_ROLE) {
      const visible = await guestVisibleRows(request.auth, NOTICES_KEY, [notice])
      if (!visible.length) { response.status(404).json({ error: NOT_FOUND }); return null }
    }
    return { tenantId, rows, deps, notice }
  }

  // ── 목록 ────────────────────────────────────────────────────
  app.get('/api/notices', requireAuth, requireMatchingWorkspaceIdentity, async (request, response) => {
    if (!requireTenant(request, response)) return
    const tenantId = request.auth.tenantId
    const deps = depsFor(tenantId)
    const { rows } = noticesOf(tenantId)
    const archivedOnly = String(request.query.archived ?? '') === '1'
    let visible = rows.filter((notice) => noticeVisibleTo(notice, request.auth, deps)
      && Boolean(notice.archivedAt) === archivedOnly)
    if (request.query.scope && NOTICE_SCOPES.has(String(request.query.scope))) {
      visible = visible.filter((notice) => notice.scope === String(request.query.scope))
    }
    if (request.query.projectId) {
      visible = visible.filter((notice) => notice.projectId === String(request.query.projectId))
    }
    if (request.query.conversationId) {
      visible = visible.filter((notice) => notice.conversationId === String(request.query.conversationId))
    }
    // 2자 미만이면 무시한다(400이 아니다) — 타이핑 중에 목록이 깜빡이면 안 된다.
    const words = String(request.query.q ?? '').toLowerCase().split(/\s+/u).filter(Boolean)
    if (String(request.query.q ?? '').trim().length >= 2 && words.length) {
      visible = visible.filter((notice) => {
        const haystack = `${notice.title} ${notice.body} ${notice.authorName}`.toLowerCase()
        return words.every((word) => haystack.includes(word))
      })
    }
    visible = await guestVisibleRows(request.auth, NOTICES_KEY, visible)
    visible = [...visible].sort((left, right) => Number(right.mustRead) - Number(left.mustRead)
      || String(right.createdAt).localeCompare(String(left.createdAt))).slice(0, 200)
    response.json({ notices: visible.map((notice) => publicNotice(notice, request.auth, deps)) })
  })

  // ── 상세 ────────────────────────────────────────────────────
  app.get('/api/notices/:id', requireAuth, requireMatchingWorkspaceIdentity, async (request, response) => {
    if (!requireTenant(request, response)) return
    const found = await locate(request, response)
    if (!found) return
    const { tenantId, deps, notice } = found
    const manage = canManageNotice(notice, request.auth, deps)
    // 명단은 관리 권한이 있을 때만 채운다. 아니면 두 배열 모두 비운다 —
    // '몇 명 미확인'조차 다른 사람에게는 남의 근태를 짐작하게 하는 정보다.
    const confirmed = manage
      ? notice.acknowledgements.map((row) => ({ accountId: row.accountId, name: nameOf(tenantId, row.accountId), at: row.at }))
      : []
    const unconfirmed = manage
      ? notice.targetIds
        .filter((id) => !notice.acknowledgements.some((row) => row.accountId === id))
        .map((id) => ({ accountId: id, name: nameOf(tenantId, id) }))
      : []
    response.json({ notice: publicNotice(notice, request.auth, deps), confirmed, unconfirmed })
  })

  // ── 만들기 ──────────────────────────────────────────────────
  app.post('/api/notices', requireAuth, requireMatchingWorkspaceIdentity, async (request, response) => {
    if (!requireTenant(request, response)) return
    const tenantId = request.auth.tenantId
    const deps = depsFor(tenantId)

    const scope = String(request.body?.scope ?? '')
    if (!NOTICE_SCOPES.has(scope)) {
      response.status(400).json({ error: { code: 'INVALID_NOTICE_SCOPE', message: '공지를 올릴 곳을 골라 주세요.' } })
      return
    }
    const title = normalizeNoticeTitle(request.body?.title)
    if (!title || title.length > MAX_NOTICE_TITLE || hasMarkupBody(title)) {
      response.status(400).json({ error: { code: 'NOTICE_TITLE_INVALID', message: TITLE_INVALID_MESSAGE } })
      return
    }
    const body = normalizeNoticeBody(request.body?.body).trim()
    if (!body || body.length > MAX_NOTICE_BODY || hasMarkupBody(body)) {
      response.status(400).json({ error: { code: 'NOTICE_BODY_INVALID', message: BODY_INVALID_MESSAGE } })
      return
    }

    let conversation = null
    if (scope === 'company') {
      if (request.auth.role !== 'tenant-admin') {
        response.status(403).json({ error: { code: 'NOTICE_ADMIN_REQUIRED', message: '회사 전체 공지는 회사 관리자만 올릴 수 있습니다.' } })
        return
      }
      if (request.body?.conversationId !== undefined || request.body?.projectId !== undefined) {
        response.status(400).json({ error: { code: 'INVALID_NOTICE_SCOPE', message: '회사 전체 공지에는 채널을 지정할 수 없습니다.' } })
        return
      }
    } else {
      const conversationId = String(request.body?.conversationId ?? '')
      conversation = conversationsOf(tenantId).find((item) => item?.id === conversationId
        && isConversationVisibleToMember(item, request.auth, accounts)) ?? null
      if (!conversation) {
        response.status(404).json({ error: { code: 'CONVERSATION_NOT_FOUND', message: '대화를 찾을 수 없습니다.' } })
        return
      }
      if (isDeveloperSupportConversation(conversation)) {
        response.status(403).json({ error: { code: 'SYSTEM_CONVERSATION_IMMUTABLE', message: '개발운영진 지원 채널에는 공지를 올릴 수 없습니다.' } })
        return
      }
      if (!conversation.projectId) {
        response.status(400).json({ error: { code: 'NOTICE_CHANNEL_NOT_PROJECT', message: '프로젝트 채널에만 공지를 올릴 수 있습니다. 회사 전체 공지는 공지 화면에서 올려 주세요.' } })
        return
      }
      const project = deps.projectById(conversation.projectId)
      if (!project) {
        response.status(404).json({ error: { code: 'CONVERSATION_NOT_FOUND', message: '대화를 찾을 수 없습니다.' } })
        return
      }
      if (!canWriteNotice(scope, request.auth, project, deps)) {
        response.status(403).json({ error: { code: 'PROJECT_EDITOR_REQUIRED', message: '이 프로젝트의 owner 또는 editor만 공지를 올릴 수 있습니다.' } })
        return
      }
    }

    // 이름·용량은 서버가 다시 채운다 — 클라이언트가 보낸 값을 그대로 믿지 않는다.
    const attachments = await resolveMessengerAttachments(request.body?.attachments, request.auth)
    if (attachments === null || attachments.length > MAX_NOTICE_ATTACHMENTS) {
      response.status(400).json({ error: { code: 'INVALID_NOTICE_ATTACHMENTS', message: '첨부할 수 없는 파일이 있습니다.' } })
      return
    }

    // 작성자는 자기 공지의 확인 대상이 아니다 — 자기가 쓴 글을 읽었다고 스스로 눌러야 한다면,
    // 48시간 뒤 작성자에게 가는 미확인 명단에 작성자 본인이 실린다.
    const audience = noticeTargetsFor({ scope, tenantId, conversation, roster: accounts }).filter((id) => id !== request.auth.id)
    const targetIds = resolveNoticeTargets(audience, request.body?.targetIds)
    if (!targetIds) { response.status(400).json({ error: TARGETS_INVALID }); return }
    if (targetIds.length > MAX_NOTICE_TARGETS) { response.status(400).json({ error: TARGETS_TOO_MANY }); return }
    // 지울 사람이 있었는데 다 지운 것만 거절한다. 승인된 사람이 관리자 하나뿐인 테넌트(워크스페이스의
    // 첫날)에서는 기본 대상이 원래 비어 있으므로, 여기서 막으면 그 회사는 공지를 한 건도 못 올린다 —
    // 게다가 화면에는 되돌릴 '체크 해제'가 없어 문장이 시키는 일을 할 수가 없다.
    // 빈 명단은 저장해도 안전하다: hasNoticeShape가 받고, canAck는 false, 다시 알림은 409로 답한다.
    if (audience.length > 0 && targetIds.length === 0) {
      response.status(400).json({ error: TARGETS_EMPTY })
      return
    }

    const rows = readableRows(tenantId, response)
    if (!rows) return
    if (rows.filter((notice) => !notice.archivedAt).length >= MAX_NOTICES_PER_TENANT) {
      response.status(409).json({ error: { code: 'NOTICE_CAPACITY_REACHED', message: `공지는 ${MAX_NOTICES_PER_TENANT.toLocaleString('ko-KR')}건까지 둘 수 있습니다. 지난 공지를 보관해 주세요.` } })
      return
    }

    const now = nowIso()
    const notice = {
      id: newNoticeId(),
      scope,
      conversationId: scope === 'company' ? null : conversation.id,
      projectId: scope === 'company' ? null : conversation.projectId,
      title,
      body,
      attachments,
      authorId: request.auth.id,
      authorName: request.auth.name,
      mustRead: request.body?.mustRead === true,
      targetIds,
      acknowledgements: [],
      reminders: { remindedAt: {}, summary48SentAt: null, lastManualRemindAt: null },
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    // 자체검사. 여기서 걸리면 코드 결함이므로 저장하지 않는다.
    if (!hasNoticeShape(notice)) { response.status(500).json({ error: WRITE_FAILED }); return }
    // 첨부 열람 권한은 공지와 같은 커밋에 실린다(writeNotices 주석 참고).
    const readers = noticeAttachmentReaders({ scope, targetIds, authorId: notice.authorId, project: deps.projectById(notice.projectId) })
    if (!await writeNotices(tenantId, prependNotice(rows, notice), request.auth.id, response,
      () => grantDocumentAccess(tenantId, attachments.map((item) => item.id), readers, { projectId: notice.projectId }))) return

    publishChange(tenantId, notice)
    notify(tenantId, targetIds.filter((id) => id !== notice.authorId).map((id) => noticePostedDraft(notice, id)))
    // L절 이후에만 존재한다. 없으면 아무 일도 하지 않는다.
    // fields allowlist가 약속한 여섯 칸을 전부 채운다 — 빠뜨린 칸은 null로 나가므로,
    // '무엇이 바깥으로 나가는가'를 말해야 할 목록이 없는 값을 있다고 말하게 된다.
    emitWebhookEvent?.(tenantId, 'notice.posted', {
      aggregateId: notice.id,
      actor: notice.authorId,
      data: {
        id: notice.id,
        scope: notice.scope,
        title: notice.title,
        mustRead: notice.mustRead,
        targetCount: notice.targetIds.length,
        authorId: notice.authorId,
      },
    })
    response.status(201).json({ notice: publicNotice(notice, request.auth, depsFor(tenantId)) })
  })

  // ── 고치기 ──────────────────────────────────────────────────
  app.patch('/api/notices/:id', requireAuth, requireMatchingWorkspaceIdentity, async (request, response) => {
    if (!requireTenant(request, response)) return
    const found = await locate(request, response)
    if (!found) return
    const { tenantId, deps, notice } = found
    if (!canManageNotice(notice, request.auth, deps)) { response.status(403).json({ error: MANAGE_FORBIDDEN }); return }
    // 대상 집합이 통째로 바뀌면 이미 누른 확인이 무의미해진다. 범위·작성자·확인 기록은 고칠 수 없다.
    for (const field of ['scope', 'conversationId', 'projectId', 'authorId', 'authorName', 'createdAt', 'acknowledgements', 'reminders', 'id']) {
      if (Object.prototype.hasOwnProperty.call(request.body ?? {}, field)) {
        response.status(400).json({ error: { code: 'NOTICE_SCOPE_IMMUTABLE', message: '공지의 범위·작성자·확인 기록은 바꿀 수 없습니다. 새 공지로 올려 주세요.' } })
        return
      }
    }
    const rows = readableRows(tenantId, response)
    if (!rows) return

    const next = { ...notice }
    if (Object.prototype.hasOwnProperty.call(request.body ?? {}, 'title')) {
      const title = normalizeNoticeTitle(request.body.title)
      if (!title || title.length > MAX_NOTICE_TITLE || hasMarkupBody(title)) {
        response.status(400).json({ error: { code: 'NOTICE_TITLE_INVALID', message: TITLE_INVALID_MESSAGE } })
        return
      }
      next.title = title
    }
    if (Object.prototype.hasOwnProperty.call(request.body ?? {}, 'body')) {
      const body = normalizeNoticeBody(request.body.body).trim()
      if (!body || body.length > MAX_NOTICE_BODY || hasMarkupBody(body)) {
        response.status(400).json({ error: { code: 'NOTICE_BODY_INVALID', message: BODY_INVALID_MESSAGE } })
        return
      }
      next.body = body
    }
    if (Object.prototype.hasOwnProperty.call(request.body ?? {}, 'attachments')) {
      const attachments = await resolveMessengerAttachments(request.body.attachments, request.auth)
      if (attachments === null || attachments.length > MAX_NOTICE_ATTACHMENTS) {
        response.status(400).json({ error: { code: 'INVALID_NOTICE_ATTACHMENTS', message: '첨부할 수 없는 파일이 있습니다.' } })
        return
      }
      next.attachments = attachments
    }
    if (Object.prototype.hasOwnProperty.call(request.body ?? {}, 'mustRead')) {
      next.mustRead = request.body.mustRead === true
    }
    if (Object.prototype.hasOwnProperty.call(request.body ?? {}, 'targetIds')) {
      const targetIds = resolveNoticeTargets(notice.targetIds, request.body.targetIds)
      if (!targetIds) { response.status(400).json({ error: TARGETS_INVALID }); return }
      // POST와 같은 규칙이다 — 원래 비어 있던 명단은 비운 것이 아니므로 이 문장을 쓰지 않는다.
      if (notice.targetIds.length > 0 && targetIds.length === 0) { response.status(400).json({ error: TARGETS_EMPTY }); return }
      next.targetIds = targetIds
      // 대상에서 빠진 사람의 확인 기록과 리마인드 이력도 함께 지운다 — 남겨 두면 shape 불변식이 깨진다.
      const kept = new Set(targetIds)
      next.acknowledgements = notice.acknowledgements.filter((row) => kept.has(row.accountId))
      next.reminders = {
        ...notice.reminders,
        remindedAt: Object.fromEntries(Object.entries(notice.reminders.remindedAt).filter(([id]) => kept.has(id))),
      }
    }
    next.updatedAt = nowIso()
    if (!hasNoticeShape(next)) { response.status(500).json({ error: WRITE_FAILED }); return }
    // 대상에서 빠진 사람의 grantDocumentAccess는 되돌리지 않는다. 이미 열어 본 자료를
    // 소급해 못 보게 만드는 것은 공지 수정이 할 일이 아니고, 회수 경로는 자료실 쪽에 있어야 한다.
    const readers = noticeAttachmentReaders({ scope: next.scope, targetIds: next.targetIds, authorId: next.authorId, project: deps.projectById(next.projectId) })
    if (!await writeNotices(tenantId, rows.map((item) => item.id === next.id ? next : item), request.auth.id, response,
      () => grantDocumentAccess(tenantId, next.attachments.map((item) => item.id), readers, { projectId: next.projectId }))) return
    publishChange(tenantId, next)
    response.json({ notice: publicNotice(next, request.auth, deps) })
  })

  // ── 확인했습니다 ────────────────────────────────────────────
  app.post('/api/notices/:id/ack', requireAuth, requireMatchingWorkspaceIdentity, async (request, response) => {
    if (!requireTenant(request, response)) return
    const found = await locate(request, response, { allowArchived: true })
    if (!found) return
    const { tenantId, deps, notice } = found
    if (!isTarget(notice, request.auth.id)) {
      response.status(403).json({ error: { code: 'NOTICE_NOT_TARGETED', message: '이 공지의 확인 대상이 아닙니다.' } })
      return
    }
    if (!notice.mustRead) { response.status(409).json({ error: ACK_NOT_REQUIRED }); return }
    if (notice.archivedAt) { response.status(409).json({ error: ARCHIVED }); return }
    // 이미 눌렀으면 커밋 없이 200이다. 두 번째 클릭이 updatedAt을 흔들면 '언제 확인했나'가 흐려진다.
    if (acknowledgedAt(notice, request.auth.id)) {
      response.json({ notice: publicNotice(notice, request.auth, deps) })
      return
    }
    const rows = readableRows(tenantId, response)
    if (!rows) return
    const now = nowIso()
    const next = {
      ...notice,
      acknowledgements: [...notice.acknowledgements, { accountId: request.auth.id, at: now }],
      updatedAt: now,
    }
    if (!hasNoticeShape(next)) { response.status(500).json({ error: WRITE_FAILED }); return }
    if (!await writeNotices(tenantId, rows.map((item) => item.id === next.id ? next : item), request.auth.id, response)) return
    publishChange(tenantId, next)
    response.json({ notice: publicNotice(next, request.auth, deps) })
  })

  // ── 다시 알림 ───────────────────────────────────────────────
  app.post('/api/notices/:id/remind', requireAuth, requireMatchingWorkspaceIdentity, async (request, response) => {
    if (!requireTenant(request, response)) return
    const found = await locate(request, response)
    if (!found) return
    const { tenantId, deps, notice } = found
    if (!canManageNotice(notice, request.auth, deps)) { response.status(403).json({ error: MANAGE_FORBIDDEN }); return }
    // 필독이 아닌 공지에 리마인드를 보내면 "[확인했습니다]를 누르라"는 문장이 가는데,
    // 받은 사람에게는 그 버튼이 없고 ack 라우트는 409다. 따를 수 없는 문장을 보내지 않는다 —
    // ack 라우트와 같은 코드·같은 문장으로 거절한다.
    if (!notice.mustRead) { response.status(409).json({ error: ACK_NOT_REQUIRED }); return }
    // 보관한 공지도 같은 이유로 막는다 — ack 라우트가 거절하는 공지를 '확인하라'고 다시 알릴 수는 없다.
    // 보관된 공지는 관리자가 아니면 목록에도 없어 알림을 눌러도 딥링크가 공지 보드로 떨어진다.
    // 24시간 잡도 !notice.archivedAt으로 건너뛴다(notice-ack-watch.mjs) — remind만 규약 밖이었다.
    if (notice.archivedAt) { response.status(409).json({ error: ARCHIVED }); return }
    const pending = unconfirmedTargets(notice)
    if (!pending.length) {
      response.status(409).json({ error: { code: 'NOTICE_ALL_CONFIRMED', message: '모두 확인했습니다. 보낼 사람이 없습니다.' } })
      return
    }
    const now = clock()
    const last = notice.reminders.lastManualRemindAt ? Date.parse(notice.reminders.lastManualRemindAt) : null
    if (last !== null && Number.isFinite(last) && now.getTime() - last < MANUAL_REMIND_COOLDOWN_MS) {
      // 429가 아니다 — 전송 레이트 리밋이 아니라 업무 규칙 거절이다.
      // 남은 분까지 서버가 문장에 넣는다. 화면이 retryAfterMinutes로 문장을 다시 지으면
      // 같은 사실에 대한 문장이 두 파일에 각각 남아 한쪽만 고쳐도 갈라진다.
      const retryAfterMinutes = Math.max(1, Math.ceil((MANUAL_REMIND_COOLDOWN_MS - (now.getTime() - last)) / 60_000))
      response.status(409).json({ error: { code: 'NOTICE_REMIND_TOO_SOON', message: `방금 알렸습니다. ${retryAfterMinutes}분 뒤에 다시 보낼 수 있습니다.`, retryAfterMinutes } })
      return
    }
    const rows = readableRows(tenantId, response)
    if (!rows) return
    const at = now.toISOString()
    const next = {
      ...notice,
      reminders: {
        ...notice.reminders,
        remindedAt: { ...notice.reminders.remindedAt, ...Object.fromEntries(pending.map((id) => [id, at])) },
        lastManualRemindAt: at,
      },
      updatedAt: at,
    }
    if (!hasNoticeShape(next)) { response.status(500).json({ error: WRITE_FAILED }); return }
    // 기록을 먼저 커밋하고 그다음에 발송한다. 중복 알림보다 누락이 낫다.
    if (!await writeNotices(tenantId, rows.map((item) => item.id === next.id ? next : item), request.auth.id, response)) return
    notify(tenantId, pending.map((id) => noticeReminderDraft(next, id)))
    publishChange(tenantId, next)
    response.json({ reminded: pending.length, notice: publicNotice(next, request.auth, deps) })
  })

  // ── 보관 / 보관 해제 ────────────────────────────────────────
  app.post('/api/notices/:id/archive', requireAuth, requireMatchingWorkspaceIdentity, async (request, response) => {
    if (!requireTenant(request, response)) return
    const found = await locate(request, response)
    if (!found) return
    const { tenantId, deps, notice } = found
    if (!canManageNotice(notice, request.auth, deps)) { response.status(403).json({ error: MANAGE_FORBIDDEN }); return }
    const rows = readableRows(tenantId, response)
    if (!rows) return
    const now = nowIso()
    const archived = request.body?.archived !== false
    const next = { ...notice, archivedAt: archived ? (notice.archivedAt ?? now) : null, updatedAt: now }
    if (!hasNoticeShape(next)) { response.status(500).json({ error: WRITE_FAILED }); return }
    if (!await writeNotices(tenantId, rows.map((item) => item.id === next.id ? next : item), request.auth.id, response)) return
    publishChange(tenantId, next)
    response.json({ notice: publicNotice(next, request.auth, deps) })
  })

  return {
    runNoticeAckWatch: createNoticeAckWatch({ workspaceStore, accounts, commitWorkspaceStore, notify, clock }),
  }
}

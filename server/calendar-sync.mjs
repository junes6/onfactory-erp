import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import { BRAND } from './brand.mjs'
import { GUEST_ROLE, GUEST_SCOPE_FORBIDDEN } from './guest-access.mjs'
import {
  GOOGLE_EVENTS_SCOPE,
  MAX_PAGES_PER_PASS, PULL_WINDOW_FUTURE_DAYS, PULL_WINDOW_PAST_DAYS, TOKEN_REFRESH_MARGIN_MS,
  calendarContentHash, createPkcePair, fromGoogleEvent, scrubUpstreamError,
  syncLinkId, toGoogleEvent,
} from './google-calendar.mjs'

/**
 * 구글 캘린더 양방향 동기화 — 규칙·라우트·러너.
 *
 * 두 개의 저장소 키를 쓴다.
 *  - calendar-connections: 계정당 한 행. 봉인된 토큰과 어느 캘린더를 볼지가 여기 산다.
 *  - calendar-sync-links:  항목당 한 행. 외부 id·해시·덮어쓴 내역이 여기 산다.
 *
 * **왜 링크를 일정 행에 얹지 않는가**: hasCalendarShape(server/app.mjs)가 CALENDAR_FIELDS와 ownerId 밖의
 * 키를 하나라도 만나면 false다. 동기화 메타를 일정 행에 넣는 순간 mergeMemberCalendarEvents가
 * 전 직원의 일정 저장을 CALENDAR_WRITE_FORBIDDEN으로 막는다. 그래서 그림자 키를 하나 더 둔다.
 *
 * **왜 툼스톤이 필요한가**: 앱 층의 삭제는 '배열에서 빠짐'이라 JSON 모드에 흔적이 0이다.
 * 링크 행이 localDeletedAt을 들고 있어야 "지운 것"과 "아직 안 가져온 것"을 구별하고,
 * 지운 일정이 다음 통과에 되살아나지 않는다.
 *
 * **멱등성**: 통과가 끝나면 툼스톤 아닌 모든 링크에서 link.contentHash === hash(로컬) === hash(원격)이
 * 성립한다. 그러므로 같은 상태의 2회차는 증분 목록 호출 외에 아무 요청도 내지 않는다.
 */

export const CALENDAR_CONNECTIONS_KEY = 'calendar-connections'
export const CALENDAR_SYNC_LINKS_KEY = 'calendar-sync-links'
export const CALENDAR_EVENTS_KEY = 'calendar-events'
export const WORK_ITEMS_KEY = 'work-items'

export const MAX_HISTORY_PER_LINK = 20
export const HISTORY_RETENTION_DAYS = 180
export const MAX_SYNC_LINKS_PER_ACCOUNT = 2_000
export const MAX_CALENDARS = 50
export const MAX_SELECTED_CALENDARS = 10
export const MAX_PUSH_PER_RUN = 300
export const MAX_PULL_PER_RUN = 500
export const MAX_CALENDAR_EVENTS_PER_TENANT = 5_000
export const MAX_EXTERNAL_IDS_IN_STATUS = 500
export const MAX_CONNECTIONS_PER_PASS = 20
export const PENDING_AUTH_TTL_MS = 10 * 60 * 1_000
/** 손으로 누르는 '지금 동기화'의 하한. 사람이 연타해도 구글 할당량을 태우지 않는다. */
export const MIN_MANUAL_SYNC_INTERVAL_MS = 10_000
/** 화면 진입 자동 동기화의 기준(클라이언트와 같은 값). 워커 배포에 폴링이 없어 이 한 겹이 자동 경로다. */
export const AUTO_SYNC_STALE_MS = 60 * 60 * 1_000
/**
 * 캘린더 목록을 다시 가져오는 주기.
 *
 * 목록을 연결 시점에 한 번만 읽으면 그 뒤 구글에서 만들거나 공유받은 캘린더는 **영원히** 화면에 없다 —
 * PATCH는 CALENDAR_UNKNOWN_ID로 거절하고, 카드에는 '다시 연결' 말고 되돌릴 길이 없다.
 * 그렇다고 통과마다 부르면 "같은 상태의 2회차는 증분 목록 외에 요청이 없다"는 이 모듈의 멱등성이 깨진다.
 * 그래서 오래된 목록만 갱신하고, 지금 당장 필요한 사람에게는 라우트 4b(손으로 새로 고침)를 준다.
 */
export const CALENDAR_LIST_REFRESH_MS = 6 * 60 * 60 * 1_000

export const CALENDAR_LIMIT_MESSAGE = '일정 상한(5,000건)에 도달해 일부를 가져오지 못했습니다.'
/**
 * 캘린더 상한 문장. **화면의 미리 알림과 서버의 400이 이 한 문장에서 나온다** —
 * 두 벌로 적으면 한쪽만 고쳐져 사람이 다른 말을 두 번 듣게 된다.
 * 화면 쪽 사본은 src/components/CalendarConnection.tsx에 있고 계약 시험이 두 값을 맞춰 둔다.
 */
export const CALENDAR_TOO_MANY_MESSAGE = `동기화할 캘린더는 최대 ${MAX_SELECTED_CALENDARS}개까지 고를 수 있습니다.`
/**
 * 읽기 전용 캘린더에서 가져온 일정은 그쪽으로 되돌려 보낼 수 없다(구글이 403을 낸다).
 * 조용히 건너뛰면 사람은 고쳐 놓고 '내보냄 0건'만 보고 나간다 — 카드의 lastError 줄에 이 한 문장을 띄운다.
 */
export const CALENDAR_SOURCE_READ_ONLY_MESSAGE = '읽기 전용 캘린더에서 가져온 일정은 구글로 보내지 않습니다.'
/**
 * 동기화 대상에서 뺀 캘린더. 화면은 체크박스 밑에 "선택하지 않은 캘린더는 읽지 않고, 그 캘린더의 일정은
 * 구글로 되돌려 보내지도 않습니다"라고 적는다 — 그 약속을 지키는 자리가 여기다.
 */
export const CALENDAR_SOURCE_UNSELECTED_MESSAGE = '동기화 대상에서 뺀 캘린더의 일정이라 이 변경은 구글로 보내지 않았습니다.'
/**
 * 연결 목록에서 사라진 캘린더(구글에서 구독을 끊고 다시 연결한 경우).
 * 이것을 '읽기 전용'이라고 부르면 존재하지도 않는 캘린더의 권한을 말하는 셈이다 — 사실이 다르면 문장도 다르다.
 */
export const CALENDAR_SOURCE_UNKNOWN_MESSAGE = '구글 계정에서 사라진 캘린더의 일정이라 이 변경은 구글로 보내지 않았습니다.'
/** 내보낼 캘린더가 '내보내지 않음'. 그 선택은 새 일정뿐 아니라 이미 연결된 일정의 수정·삭제에도 걸린다. */
export const CALENDAR_EXPORT_OFF_MESSAGE = '내보낼 캘린더를 ‘내보내지 않음’으로 두어 이 변경은 구글로 보내지 않았습니다.'
/**
 * 원격 쓰기를 막은 이유 → 카드에 뜨는 한 문장. **한 벌뿐이다.**
 * 다섯 계획 자리(패치 2·삭제 3)가 같은 표를 읽는다 — 자리마다 문장을 적으면 한쪽만 고쳐진다.
 */
export const CALENDAR_BLOCK_MESSAGES = Object.freeze({
  'no-export': CALENDAR_EXPORT_OFF_MESSAGE,
  unknown: CALENDAR_SOURCE_UNKNOWN_MESSAGE,
  unselected: CALENDAR_SOURCE_UNSELECTED_MESSAGE,
  'read-only': CALENDAR_SOURCE_READ_ONLY_MESSAGE,
})
/** 퇴사(비활성) 계정의 연결은 스스로 끝난다. 카드가 다시 열릴 일은 없지만 개관에는 이유가 남는다. */
export const CALENDAR_ACCOUNT_INACTIVE_MESSAGE = '비활성 계정이어서 구글 캘린더 연결을 해제했습니다.'

export const CALENDAR_ERRORS = Object.freeze({
  NOT_CONFIGURED: { code: 'GOOGLE_CALENDAR_NOT_CONFIGURED', message: '연동키 설정 후 사용할 수 있습니다.' },
  SECRET_BOX_MISSING: { code: 'SECRET_BOX_KEY_MISSING', message: '서버에 비밀 보관 키(SECRET_BOX_KEY)가 없어 외부 연동 토큰을 안전하게 보관할 수 없습니다. 운영 담당자에게 문의해 주세요.' },
  NOT_FOUND: { code: 'CALENDAR_CONNECTION_NOT_FOUND', message: '연결된 구글 캘린더가 없습니다.' },
  MEMBER_REQUIRED: { code: 'CALENDAR_MEMBER_REQUIRED', message: '이 워크스페이스의 구성원 계정만 구글 캘린더를 연결할 수 있습니다.' },
  RUNNING: { code: 'CALENDAR_SYNC_RUNNING', message: '이미 동기화가 진행 중입니다. 잠시 후 다시 시도해 주세요.' },
  TOO_SOON: { code: 'CALENDAR_SYNC_TOO_SOON', message: '방금 동기화했습니다. 잠시 후 다시 시도해 주세요.' },
  NEEDS_REAUTH: { code: 'CALENDAR_NEEDS_REAUTH', message: '구글 캘린더 연결이 끊어졌습니다. 다시 연결해 주세요.' },
  NOT_WRITABLE: { code: 'CALENDAR_NOT_WRITABLE', message: '읽기 전용 캘린더에는 내보낼 수 없습니다.' },
  UNKNOWN_ID: { code: 'CALENDAR_UNKNOWN_ID', message: '연결된 계정에 없는 캘린더입니다.' },
  TOO_MANY_SELECTED: { code: 'CALENDAR_TOO_MANY_SELECTED', message: CALENDAR_TOO_MANY_MESSAGE },
  UPSTREAM: { code: 'CALENDAR_UPSTREAM_UNAVAILABLE', message: '구글에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.' },
  WRITE_FAILED: { code: 'CALENDAR_SYNC_WRITE_FAILED', message: '동기화 결과를 저장하지 못했습니다.' },
  OVERWRITES_NOT_FOUND: { code: 'CALENDAR_OVERWRITES_NOT_FOUND', message: '덮어쓴 내역을 찾을 수 없습니다.' },
})

/** 콜백이 화면으로 돌려보내는 이유값. 사용자에게는 클라이언트가 문장으로 바꿔 보여 준다. */
export const CALLBACK_REASONS = Object.freeze(['session', 'forbidden', 'tenant', 'state', 'scope', 'exchange', 'norefresh', 'key', 'upstream'])

const DAY_MS = 24 * 60 * 60 * 1_000
const STATE_PATTERN = /^[A-Za-z0-9_-]{40,100}$/

const rowsOf = (tenantStore, key) => (Array.isArray(tenantStore?.[key]?.data) ? tenantStore[key].data : [])
const digest = (value) => createHash('sha256').update(String(value)).digest('hex')

/** 봉인 AAD. A 계정의 암호문을 B 계정 행에 복사해 붙여도 인증 태그가 맞지 않아 열리지 않는다. */
export const tokenAad = (tenantId, accountId) => `google-calendar:${tenantId}:${accountId}`
export const pkceAad = (tenantId, accountId) => `google-oauth-pkce:${tenantId}:${accountId}`

/**
 * 구글 쪽 동의를 최선 노력으로 거둔다.
 *
 * **세 자리가 같은 함수를 쓴다**: 해제·연결 기록 완전 삭제·비활성 계정 종료. 사본이 갈라지면
 * 어느 한 자리만 revoke를 빠뜨리는데, 그 자리는 같은 호출로 암호문까지 지우므로 **나중에 되돌릴 방법이 없다** —
 * 사용자의 구글 계정에는 취소할 수 없는 허가가 영원히 남는다.
 * 최선 노력이다: 구글이 500을 내도 우리 쪽 해제는 끝난다. 키가 바뀌어 못 열어도 예외를 밖으로 내지 않는다.
 */
export async function revokeBestEffort({ secretBox, google, tenantId, row }) {
  let refreshToken = null
  try {
    refreshToken = row?.refreshTokenEnc ? secretBox?.open?.(row.refreshTokenEnc, { aad: tokenAad(tenantId, row.accountId) }) : null
  } catch { refreshToken = null }
  if (!refreshToken || !google?.configured) return false
  try {
    const result = await google.revoke({ refreshToken })
    // **구글이 거절한 것도 '거두지 못했다'다.** 예외가 없었다는 것을 성공으로 읽으면, 되돌릴 수 없는
    // 허가가 남은 바로 그 자리에서 화면은 '해제했습니다'만 말한다. 돌려주는 값은 화면의 한 문장이 된다.
    return result?.outcome === 'ok'
  } catch { return false }
}

const text = (value, max) => String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max)

/** 화면·이력에 남기는 여섯 칸만 뽑는다. ownerId·scope는 동기화가 바꾸지 않으므로 넣지 않는다. */
export function overwriteSnapshot(event) {
  return {
    title: text(event?.title, 200), date: text(event?.date, 200), start: text(event?.start, 200),
    end: text(event?.end, 200), location: text(event?.location, 200), note: text(event?.note, 200),
  }
}

/**
 * 덮어쓴 내역 한 줄을 앞에 붙인다. 최신이 앞이고 20건을 넘지 않는다.
 * 왜 상한이 있는가: 개인 일정 본문이 링크 행에 영구 적재되면 안 된다. 스케줄러가 180일 넘은 항목도 걷어낸다.
 */
export function applyOverwrite(link, { source, byName, before, at }) {
  const entry = { at, source, byName: text(byName, 60), before: overwriteSnapshot(before) }
  return { ...link, history: [entry, ...(Array.isArray(link?.history) ? link.history : [])].slice(0, MAX_HISTORY_PER_LINK) }
}

/** 180일 넘은 이력 제거. 바뀐 게 없으면 같은 객체를 돌려준다 — 헛된 쓰기를 만들지 않는다. */
export function sweepHistory(link, now) {
  const history = Array.isArray(link?.history) ? link.history : []
  if (!history.length) return link
  const cutoff = now.getTime() - HISTORY_RETENTION_DAYS * DAY_MS
  const kept = history.filter((entry) => (Date.parse(entry?.at) || 0) >= cutoff)
  return kept.length === history.length ? link : { ...link, history: kept }
}

/**
 * 한 항목의 다음 행동. 순수 함수 — 라우트도 러너도 이 표 하나만 본다.
 *
 * local  : 지금 저장소에 있는 일정 행(없으면 null)
 * remote : 이번 통과에 구글이 돌려준 매핑 결과(안 돌려줬으면 null = 원격 무변경)
 *
 * etag은 변경 감지에 쓰지 않는다. 구글은 참석자 응답·알림 설정처럼 우리와 무관한 변화에도 etag을 올린다.
 * etag은 오직 내보내기의 If-Match 조건부 쓰기에만 쓴다.
 */
export function resolveSync(link, local, remote, now) {
  if (!link) return { action: 'skip', reason: 'no-link' }
  if (link.detachedAt) return { action: 'skip', reason: 'detached' }

  const localHash = local ? calendarContentHash(local) : null
  const remoteHash = remote && !remote.deleted ? calendarContentHash(remote.event) : null
  const remoteDeleted = Boolean(remote?.deleted) || Boolean(link.remoteDeletedAt)
  // 로컬 행이 사라졌다 = 지웠다. 툼스톤이 없어도(관리자 배열 PUT) 같은 뜻으로 읽는다.
  const localDeleted = !local
  const localChanged = local ? localHash !== link.contentHash : true
  const remoteChanged = remote ? (remote.deleted ? true : remoteHash !== link.contentHash) : false

  if (localDeleted && remoteDeleted) return { action: 'unlink', reason: 'both-deleted' }
  if (localDeleted && remoteChanged) {
    // 삭제보다 수정이 이긴다 — 되살아난 일정은 눈에 보이지만 사라진 일정은 보이지 않는다.
    return { action: 'pull', winner: 'google', revived: true, reason: 'local-deleted-remote-changed' }
  }
  if (localDeleted) return { action: 'delete-remote', reason: 'local-deleted' }
  if (remoteDeleted) return { action: 'delete-local', reason: 'remote-deleted' }

  if (localChanged && remoteChanged) {
    const remoteAt = Date.parse(remote?.updated ?? '') || 0
    const localAt = Date.parse(link.localUpdatedAt ?? link.updatedAt ?? '') || 0
    // 동률은 우리 쪽이 이긴다. 밀리초까지 같다는 것은 대개 우리가 방금 내보낸 것이 되돌아온 메아리라는 뜻이고,
    // 원격을 이기게 하면 우리가 쓴 값을 우리가 다시 덮어쓰는 무의미한 쓰기가 생긴다.
    const winner = remoteAt > localAt ? 'google' : 'inthefield'
    return { action: winner === 'google' ? 'pull' : 'push', winner, conflict: true, reason: 'both-changed' }
  }
  if (remoteChanged) return { action: 'pull', winner: 'google', reason: 'remote-changed' }
  if (localChanged) return { action: 'push', winner: 'inthefield', reason: 'local-changed' }
  return { action: 'noop', reason: 'in-sync' }
}

/**
 * generic PUT 꼬리에서 부른다 — 일정 레코드에는 수정 시각이 없으므로 링크 행이 대신 기억한다.
 * hasCalendarShape도 mergeMemberCalendarEvents도 건드리지 않고 '마지막 수정 우선'을 지키는 유일한 자리다.
 *
 * 제자리 변형을 하지 않고 레코드 객체를 통째로 갈아 끼운다 — 커밋 실패 시 호출부가 이전 객체로 되돌린다.
 * 연결이 하나도 없는 테넌트에서는 즉시 return이라 비용이 0이고 레코드도 만들지 않는다.
 */
export function stampCalendarLinkChanges(tenantStore, previousData, nextData, now) {
  const record = tenantStore?.[CALENDAR_SYNC_LINKS_KEY]
  const links = Array.isArray(record?.data) ? record.data : []
  if (!links.length) return false

  const previousById = new Map((Array.isArray(previousData) ? previousData : []).map((row) => [row?.id, row]))
  const nextById = new Map((Array.isArray(nextData) ? nextData : []).map((row) => [row?.id, row]))
  const stamp = now.toISOString()
  let changed = false

  const nextLinks = links.map((link) => {
    if (!link?.eventId) return link
    const after = nextById.get(link.eventId)
    const before = previousById.get(link.eventId)
    if (!after) {
      if (!before || link.localDeletedAt) return link
      changed = true
      return { ...link, localDeletedAt: stamp, updatedAt: stamp }
    }
    const afterHash = calendarContentHash(after)
    if (afterHash === link.contentHash && !link.localDeletedAt) return link
    changed = true
    // 되살아난 행은 툼스톤을 지운다. 남겨 두면 다음 통과가 멀쩡한 일정을 다시 지운다.
    return { ...link, localDeletedAt: null, localUpdatedAt: stamp, updatedAt: stamp }
  })

  if (!changed) return false
  tenantStore[CALENDAR_SYNC_LINKS_KEY] = { data: nextLinks, updatedAt: stamp, updatedBy: 'system:calendar-sync' }
  return true
}

/**
 * 화면·개관이 함께 쓰는 단 하나의 상태 판정.
 *
 * **토큰이 없는 행은 어떤 status 값을 들고 있어도 '연결 안 됨'이다.** 동의 화면에서 그냥 돌아서면
 * authorize가 만들어 둔 행만 남는데, 그 행을 '연결됨'이라고 부르는 순간 화면은 연결 버튼을 감추고
 * 관리자 개관은 없는 연결을 있다고 말한다. 두 자리가 따로 판정하면 반드시 어긋나므로 한 함수만 둔다.
 */
export function effectiveConnectionStatus(connection) {
  if (!connection) return 'revoked'
  return connection.refreshTokenEnc ? (connection.status ?? 'connected') : 'revoked'
}

/**
 * 새 연결 행. 토큰 자리는 null로 시작한다 — 봉인 전에는 아무것도 들어오지 않는다.
 * status도 'revoked'로 시작한다: 토큰을 받기 전까지 이 행은 '연결을 시작해 봤다'는 기록일 뿐이다.
 * 'connected'로 쓰는 자리는 콜백 한 곳뿐이어야 한다.
 */
export function newConnection({ accountId, tenantId, now }) {
  const stamp = now.toISOString()
  return {
    id: `CAL-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
    accountId, tenantId, provider: 'google',
    email: '', calendars: [], calendarsListedAt: null, writeCalendarId: '', pushWorkDue: true,
    accessTokenEnc: null, refreshTokenEnc: null, keyFingerprint: '',
    tokenExpiresAt: null, scope: '',
    // 구글의 nextSyncToken은 캘린더별·파라미터별로 유효하다. 한 문자열로 뭉치면 두 번째 캘린더의 증분이 조용히 어긋난다.
    syncTokens: {}, pending: {},
    pendingAuth: null,
    status: 'revoked', lastSyncAt: null, lastError: '', lastErrorAt: null,
    reauthNotifiedAt: null, disconnectedAt: null, createdAt: stamp, updatedAt: stamp,
  }
}

/** 화면이 받는 연결 요약. **토큰 필드는 어떤 경우에도 이 함수를 통과하지 못한다.** */
export function publicConnection(connection, links = []) {
  if (!connection) return null
  const own = links.filter((link) => link?.connectionId === connection.id && !link.detachedAt)
  return {
    id: connection.id,
    email: connection.email ?? '',
    status: effectiveConnectionStatus(connection),
    calendars: (connection.calendars ?? []).map((calendar) => ({
      id: calendar.id, summary: calendar.summary, selected: Boolean(calendar.selected),
      primary: Boolean(calendar.primary), accessRole: calendar.accessRole ?? 'reader',
    })),
    writeCalendarId: connection.writeCalendarId ?? '',
    pushWorkDue: connection.pushWorkDue !== false,
    lastSyncAt: connection.lastSyncAt ?? null,
    lastError: connection.lastError ?? '',
    // tokenExpiresAt은 싣지 않는다. 화면이 쓸 데가 없고, 토큰의 수명은 사용자에게 알릴 값이 아니다.
    counts: {
      // **일정 링크만 센다.** work-due 링크에는 대응하는 일정 행이 없다 —
      // 함께 세면 카드가 '연결된 일정 4건'이라 적는데 화면에는 한 건뿐인 일이 생긴다.
      linked: own.filter((link) => link.eventId).length,
      workDue: own.filter((link) => link.kind === 'work-due').length,
      truncated: own.filter((link) => link.truncated).length,
      readOnly: own.filter((link) => link.readOnly).length,
    },
  }
}

const isWritable = (calendar) => calendar?.accessRole === 'owner' || calendar?.accessRole === 'writer'

/**
 * 지금 내보낼 수 있는 캘린더. 없으면 이 연결은 구글에 아무것도 쓰지 않는다
 * ('내보내지 않음'을 골랐거나, 고른 캘린더의 권한이 내려갔거나, 그 캘린더가 사라졌다).
 * 새 일정을 만드는 자리와 'no-export' 판정이 **같은 함수**를 읽는다 — 두 벌이면 한쪽만 고쳐진다.
 */
export function exportTargetOf(connection) {
  const target = (connection?.calendars ?? []).find((calendar) => calendar.id === connection?.writeCalendarId)
  return target && isWritable(target) ? target : null
}

/**
 * 이 링크의 변경을 구글로 낼 수 있는가. 못 내면 그 이유 한 낱말을 돌려준다.
 *
 * **판정하는 자리는 하나, 계획하는 자리는 다섯이다**(가져오기 고리의 패치·마감 되돌리기·삭제,
 * 내보내기 후보의 패치, 마감 걷기, 툼스톤 쓸이). 자리마다 조건을 적으면 한 자리만 고쳐진다 —
 * 실제로 그렇게 됐다: 읽기 전용 판정이 패치 두 곳에만 붙어 있어서 삭제 세 곳은 매 통과 403을 맞았다.
 *
 * 읽기 전용 캘린더를 '보기'로 고르는 것은 정식으로 지원하는 경우다(화면이 읽기 전용 칩을 그린다).
 * 거기서 가져온 일정을 앱에서 고치거나 지우면 진짜 구글은 403을 낸다. contentHash도 툼스톤도
 * 그대로 남으므로 **같은 요청이 매 통과마다 영원히 다시 나간다.** 계획 자체를 만들지 않고,
 * 대신 카드에 한 문장을 남긴다(조용한 누락 금지).
 *
 * 이유를 넷으로 나누는 까닭: '연결 목록에서 사라진 캘린더'를 '읽기 전용'이라고 부르면
 * 다이얼로그가 존재하지 않는 캘린더의 권한을 이야기하게 된다. 사실이 다르면 문장도 달라야 한다.
 *
 * **모듈 바깥에 둔 까닭**: 통과와 라우트 8(다이얼로그가 읽는 자리)이 같은 함수를 부른다.
 * 이유를 링크 행에 새겨 두면 그것을 지우는 자리가 '패치가 실제로 통했을 때' 하나뿐이라,
 * 막힘이 풀렸는데 마침 나갈 쓰기가 없던 경우 표식이 그대로 남아 다이얼로그가 이미 없는 제약을
 * 계속 설명한다. 사실은 기억하지 않고 그때그때 계산한다.
 */
export function remoteWriteBlockOf(connection, link) {
  if (!exportTargetOf(connection)) return 'no-export'
  const calendar = (connection?.calendars ?? []).find((item) => item.id === link?.calendarId)
  if (!calendar) return 'unknown'
  // 내보내기 대상은 정의상 쓰기 범위 안이다. 여기서 빼면 그 캘린더에 방금 만든 일정을
  // 다음 통과부터 영영 고치지 못하게 된다 — 만들 수는 있는데 고칠 수는 없는 상태가 생긴다.
  if (!calendar.selected && calendar.id !== connection?.writeCalendarId) return 'unselected'
  if (!isWritable(calendar)) return 'read-only'
  return ''
}

/**
 * 이 테넌트에서 아직 일하는 사람인가.
 *
 * 러너(통과를 돌지 말지)와 authorize 라우트(연결을 시작하게 할지)가 **같은 함수**를 쓴다.
 * 두 자리가 각자 판정하면 한쪽만 고쳐져 "연결은 되는데 동기화는 즉시 끊기는" 상태가 생긴다.
 * 명단에 없는 계정(운영자 모드로 들어온 플랫폼 운영자)도 여기서 걸린다 — 남의 회사 저장소에
 * 자기 개인 일정을 부어 넣을 자리가 아니다.
 */
export function isActiveTenantMember(accounts, tenantId, accountId) {
  const account = (accounts ?? []).find((item) => item?.id === accountId && item.tenantId === tenantId)
  return Boolean(account && account.approved !== false && account.approvalStatus !== 'inactive')
}

/** 구글 캘린더 목록 → 저장 형태. 상한을 넘으면 자른다(조용한 무한 증식 금지). */
export function normalizeCalendars(items, { previous = [] } = {}) {
  const previousById = new Map(previous.map((calendar) => [calendar.id, calendar]))
  return (items ?? []).slice(0, MAX_CALENDARS).map((item) => {
    const id = text(item?.id, 200)
    const before = previousById.get(id)
    return {
      id,
      summary: text(item?.summary ?? item?.summaryOverride, 120) || id,
      primary: Boolean(item?.primary),
      accessRole: text(item?.accessRole, 20) || 'reader',
      selected: before ? Boolean(before.selected) : Boolean(item?.primary),
    }
  }).filter((calendar) => calendar.id)
}

const seoulDateOf = (iso) => {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return ''
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(parsed)
}

/**
 * 내보낼 업무 마감 후보. 본인 담당·미완료·ISO 마감만.
 * 되가져오지는 않는다 — 달력에서 마감을 바꾸면 결재 흐름을 우회한다.
 */
export function workDueCandidates(items, accountId) {
  return (items ?? [])
    .filter((item) => item?.ownerId === accountId && item.status !== '결재완료' && !item.deletedAt)
    .map((item) => ({ id: item.id, title: item.title, note: '', dueDate: seoulDateOf(item.due) }))
    .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.dueDate))
}

/**
 * [마감] 표식의 여섯 칸. 해시·판정·내보내기가 전부 이 한 함수에서 나온다 —
 * 같은 모양을 네 자리에 손으로 적어 두면 한 자리만 고쳐져 매 통과마다 '바뀌었다'가 된다.
 */
export function workDueShape(candidate) {
  return {
    title: `[마감] ${candidate?.title ?? ''}`, date: candidate?.dueDate ?? '',
    start: '00:00', end: '23:59', location: '', note: '',
  }
}

/**
 * 내보낼 일정 후보.
 * 승인 휴가 파생본(source:'leave')은 절대 내보내지 않는다 — 인사 정보를 회사 밖 구글 계정으로 내보내지 않는다.
 */
export function pushableEvents(events, accountId) {
  return (events ?? []).filter((event) => event?.ownerId === accountId && event.source !== 'leave' && event.id)
}

export function createCalendarSyncRunner({
  workspaceStore, accounts = [], commitWorkspaceStore, google, secretBox, notify = () => [],
  events: eventStream = { publish: () => {} }, clock = () => new Date(), logger = console,
  recordVersion = () => '',
  // app.mjs의 잠긴 판정 그대로를 받는다. 매핑이 어긋난 행이 calendar-events에 한 줄이라도 들어가면
  // mergeMemberCalendarEvents가 **전 직원의 일정 저장**을 403으로 막는다 — 마지막 문턱을 여기 둔다.
  hasCalendarShape = () => true,
}) {
  /**
   * 같은 연결의 통과가 겹치지 않게 한다.
   * 프로세스 사이의 배타는 보장하지 않는다(워커는 요청마다 앱을 새로 만든다). 대신 모든 단계가
   * 멱등이고 링크 id가 결정론이라, 겹쳐 돌아도 두 번째 통과가 첫 번째의 결과를 다시 확인하는 데서 끝난다.
   */
  const inFlight = new Set()
  const runKeyOf = (tenantId, accountId) => `${tenantId}:${accountId}`

  const tenantStoreOf = (tenantId) => (workspaceStore.tenants[tenantId] ??= {})
  const accountOf = (tenantId, accountId) => accounts.find((item) => item?.id === accountId && item.tenantId === tenantId) ?? null

  const writeConnections = (tenantStore, rows, now) => {
    tenantStore[CALENDAR_CONNECTIONS_KEY] = { data: rows, updatedAt: now.toISOString(), updatedBy: 'system:calendar-sync' }
  }

  /**
   * 아직 일하는 사람인가.
   * 비활성(퇴사) 계정의 연결이 계속 돌면 그 사람의 개인 구글 일정이 회사 저장소로 계속 흘러들고,
   * 관리자는 그것을 일정 화면에서 본다. 본인은 세션이 끊겨 해제할 수도 없다(해제는 본인 세션을 요구한다).
   */
  const isActiveAccount = (tenantId, accountId) => isActiveTenantMember(accounts, tenantId, accountId)

  /**
   * 연결을 끝낸다 — 멈추는 것이 아니라 끊는다.
   * 건너뛰기만 하면 봉인된 refresh token이 저장소에 영원히 남는다. 해제 라우트와 같은 모양으로
   * 토큰을 지우고 구글에도 최선 노력으로 알린다. 일정과 링크는 그대로 둔다(고정 결정: 해제해도 데이터 유지).
   */
  const retireConnection = async (tenantId, row, now, message) => {
    const tenantStore = tenantStoreOf(tenantId)
    const rows = rowsOf(tenantStore, CALENDAR_CONNECTIONS_KEY)
    const index = rows.findIndex((candidate) => candidate?.accountId === row.accountId)
    if (index < 0) return false
    await revokeBestEffort({ secretBox, google, tenantId, row })
    const stamp = now.toISOString()
    const retired = {
      ...rows[index], accessTokenEnc: null, refreshTokenEnc: null, tokenExpiresAt: null,
      syncTokens: {}, pending: {}, pendingAuth: null,
      status: 'revoked', disconnectedAt: stamp, lastError: message, lastErrorAt: stamp, updatedAt: stamp,
    }
    const previous = tenantStore[CALENDAR_CONNECTIONS_KEY]
    writeConnections(tenantStore, rows.map((candidate, at) => (at === index ? retired : candidate)), now)
    try {
      await commitWorkspaceStore()
      return true
    } catch {
      if (previous) tenantStore[CALENDAR_CONNECTIONS_KEY] = previous
      else delete tenantStore[CALENDAR_CONNECTIONS_KEY]
      return false
    }
  }

  /**
   * 재연결 알림은 상태가 '연결됨 → 재연결 필요'로 넘어가는 그 한 번만 나간다.
   *
   * 상태값만으로는 부족하다: 액세스 토큰 갱신이 성공하면 status가 'connected'로 돌아오므로,
   * 갱신은 되는데 캘린더 API가 401을 내는 연결은 통과마다 새 알림을 밀어 보낸다.
   * 그래서 '이미 알렸는가'라는 사실 자체(reauthNotifiedAt)로 막는다 — 이 값은 통과가 실제로
   * 성공했을 때와 다시 연결했을 때만 지워진다.
   */
  const notifyReauthOnce = (tenantId, connection, previousStatus, now) => {
    if (previousStatus === 'needs-reauth' || connection.reauthNotifiedAt) return
    // 토큰을 한 번도 쥔 적이 없는 행은 '끊긴' 것이 아니다. 동의 화면에서 그냥 돌아선 사람에게
    // "연결이 끊겼습니다 · 지금까지 가져온 일정은 그대로 있습니다"를 밀어 보내면 없던 일을 통보하는 셈이다.
    if (!connection.accessTokenEnc && !connection.refreshTokenEnc) return
    notify(tenantId, [{
      type: 'calendar-reauth', recipientId: connection.accountId,
      title: '구글 캘린더 연결이 끊겼습니다',
      body: '일정 화면에서 다시 연결해 주세요. 지금까지 가져온 일정은 그대로 있습니다.',
      page: 'schedule', focusId: connection.id,
    }], { now })
    connection.reauthNotifiedAt = now.toISOString()
  }

  /**
   * 유효한 access token을 만든다. 실패 종류를 status로 옮기고 null을 돌려준다.
   *
   * 429·5xx가 status를 바꾸지 않는 것이 이 함수에서 가장 중요한 음성 케이스다. 구글이 잠깐 흔들렸다고
   * 멀쩡한 연결을 '재연결 필요'로 만들면 사용자는 매주 다시 로그인하게 된다.
   *
   * 갱신 결과를 **API 호출 전에 커밋한다**: 회전된 refresh token을 쓰기 전에 크래시하면
   * 옛 토큰은 이미 무효라 계정이 영구히 끊긴다.
   */
  const ensureAccessToken = async (tenantId, connection, now) => {
    const aad = tokenAad(tenantId, connection.accountId)
    const expiresAt = Date.parse(connection.tokenExpiresAt ?? '') || 0
    if (connection.accessTokenEnc && expiresAt > now.getTime() + TOKEN_REFRESH_MARGIN_MS) {
      const token = secretBox.open(connection.accessTokenEnc, { aad })
      if (token) return { token }
    }
    const refreshToken = connection.refreshTokenEnc ? secretBox.open(connection.refreshTokenEnc, { aad }) : null
    if (!refreshToken) {
      const previousStatus = connection.status
      connection.status = 'needs-reauth'
      connection.lastError = '저장된 갱신 토큰을 열지 못했습니다. 다시 연결해 주세요.'
      connection.lastErrorAt = now.toISOString()
      notifyReauthOnce(tenantId, connection, previousStatus, now)
      return { token: null, code: CALENDAR_ERRORS.NEEDS_REAUTH.code }
    }

    const result = await google.refresh({ refreshToken })
    if (result.outcome === 'ok') {
      connection.accessTokenEnc = secretBox.seal(result.tokens.accessToken, { aad })
      connection.tokenExpiresAt = new Date(now.getTime() + Math.max(result.tokens.expiresIn, 60) * 1_000 - 60_000).toISOString()
      // 구글이 refresh token을 회전시키면 새 값이 함께 온다. 안 오면 기존 값을 그대로 둔다.
      if (result.tokens.refreshToken) connection.refreshTokenEnc = secretBox.seal(result.tokens.refreshToken, { aad })
      if (result.tokens.scope) connection.scope = result.tokens.scope
      connection.status = 'connected'
      connection.lastError = ''
      // reauthNotifiedAt은 여기서 지우지 않는다. 토큰 갱신이 됐다는 것은 아직 연결이 살아 있다는 뜻이
      // 아니다(캘린더 API가 401을 내는 경우가 그렇다). 통과가 끝까지 성공했을 때만 지운다.
      connection.updatedAt = now.toISOString()
      return { token: result.tokens.accessToken, refreshed: true }
    }
    if (result.outcome === 'reauth' || result.outcome === 'denied') {
      const previousStatus = connection.status
      connection.status = 'needs-reauth'
      connection.lastError = scrubUpstreamError(result.reason) || '구글이 연결을 거절했습니다.'
      connection.lastErrorAt = now.toISOString()
      notifyReauthOnce(tenantId, connection, previousStatus, now)
      return { token: null, code: CALENDAR_ERRORS.NEEDS_REAUTH.code }
    }
    connection.lastError = scrubUpstreamError(result.reason) || '구글에 연결하지 못했습니다.'
    connection.lastErrorAt = now.toISOString()
    return { token: null, code: CALENDAR_ERRORS.UPSTREAM.code }
  }

  /**
   * 선택된 캘린더에서 이번 통과에 볼 원격 항목을 모은다.
   *
   * fullListed는 '이 캘린더는 증분이 아니라 전량으로 읽었고 끝까지 읽었다'는 표식이다.
   * 증분 목록에서 '없음'은 무변경이지만 전량 목록(showDeleted=false)에서 '없음'은 삭제다 —
   * 이 구분이 없으면 410이 한 번 끼는 순간 구글에서 지운 일정이 우리 쪽에 영원히 남는다.
   */
  const pullRemote = async (connection, accessToken, now, result) => {
    const byCalendar = new Map()
    const fullListed = new Set()
    const nextSyncTokens = { ...(connection.syncTokens ?? {}) }
    const nextPending = { ...(connection.pending ?? {}) }
    const selected = (connection.calendars ?? []).filter((calendar) => calendar.selected).slice(0, MAX_SELECTED_CALENDARS)
    let upstreamDown = false

    for (const calendar of selected) {
      const collected = []
      let pageToken = nextPending[calendar.id]?.pageToken ?? ''
      let syncToken = nextSyncTokens[calendar.id] ?? ''
      let resynced = false
      // 전량으로 시작했는가. 중간에 410을 만나 되돌아가도 전량이 된다.
      let full = !syncToken
      /**
       * **이어 읽기로 시작한 전량 목록은 '전량'이 아니다.**
       * 앞 페이지는 지난 통과에서 읽었고 collected에는 이번 통과의 페이지만 있다. 그걸 전량으로 치면
       * 아래의 "목록에 없으면 지워졌다" 쓸이가 앞 페이지의 멀쩡한 일정을 전부 지운다 —
       * 페이지가 둘로 나뉜 캘린더에서 구글이 한 번 흔들리기만 하면 되는, 재현이 쉬운 자료 손실이다.
       */
      let resumedFull = Boolean(pageToken)
      let complete = false
      for (let page = 0; page < MAX_PAGES_PER_PASS; page += 1) {
        const window = {
          timeMin: new Date(now.getTime() - PULL_WINDOW_PAST_DAYS * DAY_MS).toISOString(),
          timeMax: new Date(now.getTime() + PULL_WINDOW_FUTURE_DAYS * DAY_MS).toISOString(),
        }
        const listed = await google.listEvents({
          accessToken, calendarId: calendar.id, syncToken, pageToken,
          ...(syncToken ? {} : window),
        })
        if (listed.outcome === 'resync' && !resynced) {
          // 410: 그 토큰은 이제 못 쓴다. 그 통과 안에서 한 번만 전량으로 되돌린다.
          resynced = true
          full = true
          syncToken = ''
          pageToken = ''
          // 여기서부터는 첫 페이지부터 다시 읽는다 — 이어 읽기가 아니라 진짜 전량이다.
          resumedFull = false
          // 증분으로 모아 둔 앞 페이지는 버린다 — 전량 목록이 그것까지 다시 준다.
          collected.length = 0
          delete nextSyncTokens[calendar.id]
          continue
        }
        if (listed.outcome !== 'ok') {
          if (listed.outcome === 'reauth') return { outcome: 'reauth' }
          upstreamDown = true
          break
        }
        for (const item of listed.items) collected.push({ ...item, __calendarId: calendar.id })
        pageToken = listed.nextPageToken
        if (listed.nextSyncToken) nextSyncTokens[calendar.id] = listed.nextSyncToken
        if (!pageToken) { complete = true; break }
      }
      if (pageToken) nextPending[calendar.id] = { pageToken, startedAt: now.toISOString() }
      else delete nextPending[calendar.id]
      // 잘라 낸 목록도 이어 읽은 목록도 '전량'이 아니다. 못 본 항목을 '지워졌다'로 읽으면 안 된다.
      // 잃는 것은 없다: 마지막 페이지에서 nextSyncToken을 받아 두므로 원격 삭제는 다음 통과의
      // 증분 목록(showDeleted=true)이 그대로 알려 준다.
      if (full && complete && !resumedFull && collected.length <= MAX_PULL_PER_RUN) fullListed.add(calendar.id)
      if (collected.length > MAX_PULL_PER_RUN) {
        result.skipped += collected.length - MAX_PULL_PER_RUN
        collected.length = MAX_PULL_PER_RUN
      }
      byCalendar.set(calendar.id, collected)
    }
    return { outcome: upstreamDown ? 'partial' : 'ok', byCalendar, fullListed, nextSyncTokens, nextPending }
  }

  /**
   * 한 연결의 한 통과.
   *
   * 커밋은 마지막 한 번뿐이고 세 레코드(일정·링크·연결)가 함께 들어가 함께 되돌아간다.
   * 중간에 죽어도 잃는 것은 이 계정의 이 통과분이고, 모든 단계가 멱등이라 다음 통과가 이어받는다.
   */
  const pass = async (tenantId, accountId, now, trigger, { forceCalendarList = false } = {}) => {
    const result = { pulled: 0, pushed: 0, conflicts: 0, deletedLocal: 0, deletedRemote: 0, skipped: 0 }
    const tenantStore = tenantStoreOf(tenantId)
    const connections = rowsOf(tenantStore, CALENDAR_CONNECTIONS_KEY)
    const index = connections.findIndex((row) => row?.accountId === accountId)
    if (index < 0) return { ok: false, status: 404, error: CALENDAR_ERRORS.NOT_FOUND, result }

    // 퇴사한 사람의 연결은 통과를 돌지 않는다. 그냥 멈추는 것이 아니라 여기서 끊는다 —
    // 본인은 세션이 없어 해제할 수 없고, 관리자에게도 남의 연결을 끊는 라우트는 없다.
    if (!isActiveAccount(tenantId, accountId)) {
      await retireConnection(tenantId, connections[index], now, CALENDAR_ACCOUNT_INACTIVE_MESSAGE)
      return { ok: false, status: 404, error: CALENDAR_ERRORS.NOT_FOUND, result }
    }

    const account = accountOf(tenantId, accountId)
    const connection = structuredClone(connections[index])
    let previousConnectionRecord = tenantStore[CALENDAR_CONNECTIONS_KEY]
    const previousLinkRecord = tenantStore[CALENDAR_SYNC_LINKS_KEY]
    const previousEventRecord = tenantStore[CALENDAR_EVENTS_KEY]

    /**
     * 통과가 도는 동안 사용자가 이 연결을 끊었는가.
     * '지금 상태'가 아니라 '통과가 시작할 때와 달라졌는가'로 본다 — 동의 화면에서 그냥 돌아선
     * 토큰 없는 행은 처음부터 토큰이 없었을 뿐이지 사용자가 방금 끊은 것이 아니다.
     */
    const connectionAbandoned = (row) => !row
      || (Boolean(connection.refreshTokenEnc) && !row.refreshTokenEnc)
      || (!connection.disconnectedAt && Boolean(row.disconnectedAt))

    /**
     * **통과가 쥔 사본을 통째로 대입하지 않는다.**
     * 사본은 첫 네트워크 호출 앞에서 뜬 것이고, 그 사이 사용자는 같은 행을 바꿀 수 있다 —
     * 연결 해제·캘린더 선택·내보낼 캘린더·마감 보내기. 사본을 그대로 쓰면 그 변경이 조용히 되돌아간다.
     * 살아 있는 행을 다시 읽고 이 통과가 소유한 칸만 얹는다. 저장 자리 넷이 전부 이 함수를 지난다.
     * calendarItems만은 '얹기'가 아니라 살아 있는 행 **위에서 다시 계산한다.** 어떤 캘린더가
     * 있는지는 구글의 사실이지만 어느 것을 볼지는 사용자의 것이다 — 통과가 시작할 때의 선택으로
     * 덮으면 그 사이 누른 '선택 적용'이 조용히 되돌아간다.
     * @returns {{rows: object[], merged: object}|null} 그 사이 해제됐거나 행이 사라졌으면 null
     */
    const mergeLive = ({ calendarItems, ...fields }) => {
      const rows = rowsOf(tenantStore, CALENDAR_CONNECTIONS_KEY)
      const at = rows.findIndex((row) => row?.accountId === accountId)
      if (at < 0 || connectionAbandoned(rows[at])) return null
      const derived = calendarItems
        ? { calendars: normalizeCalendars(calendarItems, { previous: rows[at].calendars ?? [] }) }
        : {}
      const merged = { ...rows[at], ...fields, ...derived, updatedAt: now.toISOString() }
      return { rows: rows.map((row, position) => (position === at ? merged : row)), merged }
    }

    const { token: accessToken, code, refreshed } = await ensureAccessToken(tenantId, connection, now)
    if (!accessToken) {
      // 토큰 상태 변화는 그 자체로 저장할 값이다. 실패해도 다음 통과가 같은 곳에서 다시 시작한다.
      const next = mergeLive({
        status: connection.status, lastError: connection.lastError,
        lastErrorAt: connection.lastErrorAt, reauthNotifiedAt: connection.reauthNotifiedAt,
      })
      if (next) {
        writeConnections(tenantStore, next.rows, now)
        try { await commitWorkspaceStore() } catch { /* 상태 기록 실패가 원인을 덮지 않게 한다 */ }
      }
      return {
        ok: false,
        status: code === CALENDAR_ERRORS.NEEDS_REAUTH.code ? 409 : 502,
        error: code === CALENDAR_ERRORS.NEEDS_REAUTH.code ? CALENDAR_ERRORS.NEEDS_REAUTH : CALENDAR_ERRORS.UPSTREAM,
        result,
      }
    }

    /**
     * **회전된 refresh token은 쓰기 전에 저장한다.**
     * 구글이 refresh token을 회전시키면 옛 값은 그 순간 무효다. 새 값을 손에 쥔 채 이번 통과의
     * 마지막 커밋까지 갔다가 그 커밋이 실패하면(또는 프로세스가 죽으면) 저장소에는 이미 무효인
     * 옛 값만 남고, 그 계정은 다음 통과에서 invalid_grant로 영구히 끊긴다 — 사람이 다시 로그인해야만 풀린다.
     * 갱신은 연결당 한 시간에 한 번뿐이라 '연결 1개당 커밋 1회'의 취지를 해치지 않는다.
     */
    if (refreshed) {
      const next = mergeLive({
        accessTokenEnc: connection.accessTokenEnc, refreshTokenEnc: connection.refreshTokenEnc,
        tokenExpiresAt: connection.tokenExpiresAt, scope: connection.scope,
        status: connection.status, lastError: connection.lastError,
        lastErrorAt: connection.lastError ? connection.lastErrorAt : null,
      })
      // 그 사이 사용자가 끊었다면 방금 회전된 토큰을 저장하지 않는다 — 저장하면 해제가 지운 봉인이 되살아난다.
      if (!next) return { ok: false, status: 409, error: CALENDAR_ERRORS.NOT_FOUND, result }
      writeConnections(tenantStore, next.rows, now)
      try {
        await commitWorkspaceStore()
        // 되돌리기 기준을 방금 저장한 레코드로 옮긴다. 옮기지 않으면 마지막 커밋 실패의 롤백이
        // 방금 저장한 새 토큰을 도로 지운다.
        previousConnectionRecord = tenantStore[CALENDAR_CONNECTIONS_KEY]
      } catch {
        // 저장 실패는 이번 통과를 막지 않는다(다음 통과가 다시 갱신한다). 커밋되지 않은 값을 메모리에 남기지 않는다.
        if (previousConnectionRecord) tenantStore[CALENDAR_CONNECTIONS_KEY] = previousConnectionRecord
        else delete tenantStore[CALENDAR_CONNECTIONS_KEY]
      }
    }

    /**
     * 캘린더 목록을 다시 가져온다 — 연결 시점의 스냅샷으로 얼어붙지 않게.
     *
     * 구글에서 새로 만들거나 공유받은 캘린더는 이 한 겹이 없으면 화면에 영원히 나타나지 않고
     * (PATCH는 CALENDAR_UNKNOWN_ID로 거절한다), 권한이 writer로 올라간 캘린더도 '내보내기 불가'로 남는다.
     * **실패는 조용히 넘긴다**: 구글이 한 번 흔들렸다고 목록을 비우면 사용자의 선택이 통째로 사라진다.
     * 통과마다 부르지는 않는다 — 오래됐을 때(CALENDAR_LIST_REFRESH_MS)와 사람이 새로 고침을 눌렀을 때만.
     */
    const listedAt = Date.parse(connection.calendarsListedAt ?? connection.createdAt ?? '') || 0
    let refreshedCalendars = null
    if (forceCalendarList || now.getTime() - listedAt >= CALENDAR_LIST_REFRESH_MS) {
      const listed = await google.listCalendars({ accessToken })
      if (listed.outcome === 'ok') {
        refreshedCalendars = listed.items
        // 이 통과의 사본도 새 목록으로 본다 — 사라진 캘린더를 계속 읽거나, 방금 권한이 오른
        // 캘린더를 '읽기 전용'이라고 부르는 한 통과가 생기지 않게.
        connection.calendars = normalizeCalendars(listed.items, { previous: connection.calendars ?? [] })
      }
    }

    const pulled = await pullRemote(connection, accessToken, now, result)
    if (pulled.outcome === 'reauth') {
      const previousStatus = connection.status
      connection.status = 'needs-reauth'
      connection.lastError = '구글이 연결을 거절했습니다. 다시 연결해 주세요.'
      connection.lastErrorAt = now.toISOString()
      notifyReauthOnce(tenantId, connection, previousStatus, now)
      const next = mergeLive({
        status: connection.status, lastError: connection.lastError,
        lastErrorAt: connection.lastErrorAt, reauthNotifiedAt: connection.reauthNotifiedAt,
      })
      if (next) {
        writeConnections(tenantStore, next.rows, now)
        try { await commitWorkspaceStore() } catch { /* 위와 같다 */ }
      }
      return { ok: false, status: 409, error: CALENDAR_ERRORS.NEEDS_REAUTH, result }
    }

    // ---- 여기부터는 저장소를 다시 읽고 병합까지 동기 구간이다. await 뒤의 값은 낡았다고 본다. ----
    const localEvents = rowsOf(tenantStore, CALENDAR_EVENTS_KEY)
    const workItems = rowsOf(tenantStore, WORK_ITEMS_KEY)
    const links = rowsOf(tenantStore, CALENDAR_SYNC_LINKS_KEY).map((link) => sweepHistory(link, now))
    const linkById = new Map(links.map((link) => [link.id, link]))
    const eventsById = new Map(localEvents.map((event) => [event?.id, event]))
    const stamp = now.toISOString()
    const ownerName = account?.name ?? ''
    const team = account?.team ?? ''

    const eventUpdates = new Map()
    const eventDeletes = new Set()
    const linkUpdates = new Map()
    const linkRemovals = new Set()
    const remoteWrites = []
    let limitHit = false

    // 이 통과에서 방금 만든 링크까지 함께 본다. 스냅샷만 보면 갓 가져온 일정이
    // 링크 없는 새 일정으로 읽혀 구글로 되돌아 나간다.
    const linkFor = (predicate) => [...linkById.values()].find(predicate) ?? null
    const upsertLink = (link) => { linkUpdates.set(link.id, link); linkById.set(link.id, link) }

    /**
     * 판정에 넘길 '지금 우리 쪽 값'.
     *
     * work-due 링크에는 대응하는 일정 행이 없다(eventId가 null). 일정 배열로 판정하면 언제나
     * '사람이 지웠다'로 읽혀 방금 내보낸 [마감] 표식을 다음 통과가 구글에서 지운다 — 그러고는
     * 다시 만들고 다시 지우는 왕복이 된다. 업무 행에서 같은 여섯 칸을 만들어 그것을 로컬로 삼는다.
     * 업무가 정말 사라졌거나 결재완료돼야만 null이 되고, 그때 delete-remote가 옳은 판정이 된다.
     */
    const workDueLocalOf = (link) => {
      const item = workItems.find((row) => row?.id === link.workItemId)
      const candidate = item ? workDueCandidates([item], accountId)[0] : null
      return candidate ? workDueShape(candidate) : null
    }
    const localOf = (link) => {
      if (link.kind === 'work-due') return workDueLocalOf(link)
      if (!link.eventId || eventDeletes.has(link.eventId)) return null
      return eventUpdates.get(link.eventId) ?? eventsById.get(link.eventId) ?? null
    }

    /**
     * 원격 쓰기 가능 여부는 모듈의 remoteWriteBlockOf 하나가 판정한다(라우트 8도 같은 함수를 부른다).
     * 여기서는 이 통과가 쥔 연결 사본을 물려 부르기만 한다 — 조건을 다시 적지 않는다.
     */
    const writeCalendarId = connection.writeCalendarId
    /** 내보내기 대상이 없으면('내보내지 않음' 또는 권한이 내려간 캘린더) 이 통과는 구글에 아무것도 쓰지 않는다. */
    const exportEnabled = Boolean(exportTargetOf(connection))
    const blockOf = (link) => remoteWriteBlockOf(connection, link)

    /** 이번 통과에 이미 손댄 링크. 한 링크에 두 계획을 내면 두 번째가 첫 번째를 되돌린다. */
    const handled = new Set()
    let blockedReason = ''

    /**
     * 막힌 사실을 이 통과에 남긴다 — blockedReason은 카드의 한 줄이 된다.
     * **링크 행에는 새기지 않는다.** 이유는 연결 설정에서 매번 다시 계산되는 값이라(remoteWriteBlockOf),
     * 새겨 두면 그것을 지우는 자리가 '패치가 실제로 통했을 때' 하나뿐이라 막힘이 풀린 뒤에도
     * 다이얼로그가 이미 없는 제약을 계속 설명한다.
     */
    const noteBlocked = (reason) => {
      if (!blockedReason && CALENDAR_BLOCK_MESSAGES[reason]) blockedReason = reason
      result.skipped += 1
    }

    /**
     * 원격 삭제 계획 한 줄. 삭제 자리 셋이 전부 이 함수를 지난다 — 게이트 없는 넷째 자리가 생길 수 없다.
     * @returns {boolean} 계획에 들어갔는가
     */
    const planDelete = (link) => {
      if (handled.has(link.id)) return false
      handled.add(link.id)
      const blocked = blockOf(link)
      if (blocked) { noteBlocked(blocked); return false }
      /**
       * 여러 날 일정은 우리 쪽에 첫날만 있고, 반복 일정 인스턴스는 규칙을 우리가 모른다.
       * 그 한 줄을 지웠다고 구글의 사흘짜리 원본을 지우면 **사람이 본 적 없는 것을 지우는 셈이다.**
       * 다이얼로그가 삭제 버튼 바로 위에서 '여기서 고치거나 지운 내용은 구글로 보내지 않습니다'라고
       * 미리 말하는 그 경우다 — 카드에 영구히 붙는 오류 줄은 더하지 않는다(툼스톤은 계속 남으므로 지워지지 않는다).
       */
      if (link.truncated || link.readOnly) { result.skipped += 1; return false }
      remoteWrites.push({ kind: 'delete', link })
      return true
    }

    /** 원격 패치 계획 한 줄. 같은 게이트를 지난다. @returns {boolean} 계획에 들어갔는가 */
    const planPatch = (write) => {
      const link = write.link
      if (handled.has(link.id)) return false
      handled.add(link.id)
      const blocked = blockOf(link)
      if (blocked) { noteBlocked(blocked); return false }
      remoteWrites.push(write)
      return true
    }

    // ---- 가져오기: 원격 항목을 링크에 물린다. 순서가 곧 중복 방지다. ----
    for (const [calendarId, items] of pulled.byCalendar ?? new Map()) {
      for (const item of items) {
        const mapped = fromGoogleEvent(item, { accountId, ownerName, team })
        // 매핑 결과를 저장 직전에 한 번 더 잰다. 여기서 새는 행 하나가 전 직원의 일정 저장을 막는다.
        if (!mapped || (!mapped.deleted && !hasCalendarShape(mapped.event))) { result.skipped += 1; continue }
        const externalId = mapped.externalId

        // (a) 같은 외부 id의 링크 — 캘린더가 달라졌어도 같은 일정이다(캘린더 간 이동).
        // (c) 해제된 링크도 여기서 되찾는다 — 해제→재연결에서 일정이 두 벌이 되지 않는다.
        let link = linkFor((row) => row.accountId === accountId && row.externalId === externalId)
        if (link && (link.calendarId !== calendarId || link.detachedAt)) {
          link = { ...link, calendarId, detachedAt: null, updatedAt: stamp }
          upsertLink(link)
        }
        // (b) 링크를 잃었어도 원격 본문의 표식이 남아 있으면 그 행을 되찾는다.
        //
        // **표식은 공격자가 쓰는 값이다.** extendedProperties.private는 자기 캘린더의 일정에 아무나 적을 수 있다.
        // 그래서 되찾기는 '우리가 내보낸 우리 행'에만 허용한다: 이 테넌트가 찍은 표식이고, 그 행의 주인이
        // 지금 동기화 중인 계정 본인이며, 그 링크가 원격을 잃은 상태일 때만. 이 세 조건이 없으면
        // 남의(또는 자기) 일정 id를 적어 넣는 것만으로 그 일정을 끌어오거나 통째로 덮어쓸 수 있다.
        if (!link) {
          const markedId = String(item?.extendedProperties?.private?.inthefieldEventId ?? '')
          const markedTenant = String(item?.extendedProperties?.private?.inthefieldTenantId ?? '')
          const marked = eventsById.get(markedId) ?? null
          // 테넌트 표식은 두 갈래 **모두**의 전제다. 되찾기 갈래에만 빠뜨리면 공유 캘린더에
          // 표식 한 줄을 심는 것만으로 남의 행을 통째로 덮어쓸 수 있다.
          if (markedId && markedTenant === tenantId) {
            const candidate = linkFor((row) => row.accountId === accountId && (row.eventId === markedId || row.workItemId === markedId))
            /**
             * **되찾기는 원격을 잃은 링크에만 허용한다.**
             * 멀쩡히 살아 있는 링크를 다른 외부 항목으로 옮기면 그 뒤의 모든 판정이 새 항목을 따라간다 —
             * 공격자의 본문이 사용자의 행을 덮어쓰고(이력도 남지 않는다), 진짜 구글 원본은 고아가 되어
             * 다음 전량 목록에서 사본으로 다시 들어온다. 옮길 이유가 있는 링크는 원격이 없는 링크뿐이다.
             */
            if (candidate && (!candidate.externalId || candidate.detachedAt || candidate.remoteDeletedAt)) {
              link = {
                ...candidate, externalId, calendarId, externalEtag: mapped.etag ?? '',
                // 원격이 다시 생겼다 — 툼스톤을 그대로 두면 판정이 곧바로 '원격에서 지워졌다'로 읽어
                // 방금 되찾은 로컬 행을 지운다.
                detachedAt: null, remoteDeletedAt: null, updatedAt: stamp,
              }
              upsertLink(link)
            } else if (!candidate && marked && marked.ownerId === accountId) {
              link = {
                id: syncLinkId(accountId, calendarId, externalId), connectionId: connection.id, accountId, calendarId,
                eventId: markedId, workItemId: null, kind: 'event',
                externalId, externalEtag: mapped.etag ?? '', contentHash: '',
                remoteUpdatedAt: mapped.updated ?? null, localUpdatedAt: stamp,
                localDeletedAt: null, remoteDeletedAt: null, detachedAt: null,
                truncated: mapped.truncated ?? '', readOnly: Boolean(mapped.readOnly),
                origin: 'inthefield', history: [], createdAt: stamp, updatedAt: stamp,
              }
              upsertLink(link)
            }
          }
        }

        if (!link) {
          // (e) 처음 보는 원격 일정. 취소된 것은 가져올 것이 없다.
          if (mapped.deleted) continue
          if (linkUpdates.size + links.length >= MAX_SYNC_LINKS_PER_ACCOUNT) { result.skipped += 1; continue }
          if (eventsById.size + eventUpdates.size >= MAX_CALENDAR_EVENTS_PER_TENANT) { limitHit = true; result.skipped += 1; continue }
          const event = mapped.event
          eventUpdates.set(event.id, event)
          upsertLink({
            id: syncLinkId(accountId, calendarId, externalId), connectionId: connection.id, accountId, calendarId,
            eventId: event.id, workItemId: null, kind: 'event',
            externalId, externalEtag: mapped.etag ?? '', contentHash: calendarContentHash(event),
            remoteUpdatedAt: mapped.updated ?? null, localUpdatedAt: stamp,
            localDeletedAt: null, remoteDeletedAt: null, detachedAt: null,
            truncated: mapped.truncated ?? '', readOnly: Boolean(mapped.readOnly),
            origin: 'google', history: [], createdAt: stamp, updatedAt: stamp,
          })
          result.pulled += 1
          continue
        }

        const local = localOf(link)
        const decision = resolveSync(link, local, mapped, now)
        if (decision.action === 'unlink') { linkRemovals.add(link.id); continue }
        if (decision.action === 'skip' || decision.action === 'noop') continue
        if (decision.conflict) result.conflicts += 1

        // 업무 마감은 어떤 판정이 나와도 되가져오지 않는다 — 달력에서 마감을 바꾸면 결재 흐름을 우회한다.
        // 우리 값으로 되돌리고 이력만 남긴다.
        if (link.kind === 'work-due' && (decision.action === 'pull' || decision.action === 'push')) {
          const workItem = workItems.find((row) => row?.id === link.workItemId)
          if (!workItem) { result.skipped += 1; continue }
          // 되돌리기도 구글로 나가는 쓰기다. 같은 게이트를 지나야 '내보내지 않음'이 절대적이 된다.
          if (!planPatch({ kind: 'work-due', link, item: workItem })) continue
          if (decision.action === 'pull') {
            upsertLink(applyOverwrite({ ...link, updatedAt: stamp }, {
              source: 'inthefield', byName: ownerName || BRAND.name, at: stamp,
              before: { title: mapped.event?.title ?? '', date: mapped.event?.date ?? '', start: '', end: '', location: '', note: '' },
            }))
          }
          continue
        }

        if (decision.action === 'pull') {
          const previous = local
          // 이미 우리 쪽에 있는 행이면 여섯 칸만 갈아 끼운다.
          // fromGoogleEvent는 scope:'personal'·department·owner를 강제한다 — 구글에서 처음 온 행에는 옳지만,
          // 우리가 내보냈던 전사·부서 일정에 그대로 씌우면 그 일정이 조용히 개인 일정이 되어
          // 다른 직원의 달력에서 사라진다(isCalendarEventVisibleToMember). 공개 범위는 동기화가 건드릴 값이 아니다.
          const event = previous
            ? {
                ...previous,
                title: mapped.event.title, date: mapped.event.date, start: mapped.event.start,
                end: mapped.event.end, location: mapped.event.location, note: mapped.event.note,
              }
            : { ...mapped.event, id: link.eventId ?? mapped.event.id }
          eventDeletes.delete(event.id)
          eventUpdates.set(event.id, event)
          const next = {
            ...link, contentHash: calendarContentHash(event), externalEtag: mapped.etag ?? link.externalEtag,
            remoteUpdatedAt: mapped.updated ?? link.remoteUpdatedAt, localUpdatedAt: stamp,
            localDeletedAt: null, remoteDeletedAt: null,
            truncated: mapped.truncated ?? '', readOnly: Boolean(mapped.readOnly), updatedAt: stamp,
          }
          // 덮어쓴 것이 있을 때만 이력을 남긴다. 우리 쪽에 변경이 없었으면 남길 '진 값'이 없다.
          upsertLink(decision.conflict || decision.revived
            ? applyOverwrite(next, { source: 'google', byName: '구글 캘린더', at: stamp, before: previous ?? {} })
            : next)
          result.pulled += 1
          continue
        }

        if (decision.action === 'delete-local') {
          if (link.eventId) { eventDeletes.add(link.eventId); eventUpdates.delete(link.eventId) }
          upsertLink(applyOverwrite({ ...link, remoteDeletedAt: stamp, localDeletedAt: stamp, updatedAt: stamp }, {
            source: 'google', byName: '구글 캘린더', at: stamp, before: local ?? {},
          }))
          result.deletedLocal += 1
          continue
        }

        if (decision.action === 'delete-remote') {
          planDelete(link)
          continue
        }

        if (decision.action === 'push') {
          if (link.truncated || link.readOnly) { result.skipped += 1; continue }
          // **방금 본 etag를 채택하고 그것으로 If-Match를 건다.** If-Match는 '우리가 못 본 변경'을 막는
          // 장치인데 이 변경은 방금 이 목록에서 봤다. 낡은 etag를 그대로 들고 나가면 구글이 412로 거절하고,
          // 증분 목록은 그 항목을 다시 주지 않으므로 같은 낡은 etag로 영원히 재시도한다 —
          // 두 쪽이 어긋난 채 매 통과마다 할당량만 태우는 상태가 된다.
          const fresh = {
            ...link,
            externalEtag: mapped.etag || link.externalEtag,
            remoteUpdatedAt: mapped.updated ?? link.remoteUpdatedAt,
            updatedAt: stamp,
          }
          if (!planPatch({ kind: 'patch', link: fresh, event: local, before: mapped.event })) continue
          upsertLink(fresh)
        }
      }
    }

    // ---- 전량으로 읽은 캘린더: 목록에 없는 링크는 원격에서 지워진 것이다 ----
    //
    // 증분 목록에서 '없음'은 무변경이지만, 전량 목록은 showDeleted=false로 나가므로 '없음'은 삭제다.
    // 이 한 겹이 없으면 구글이 정기적으로 일으키는 410(토큰 만료) 한 번에 원격 삭제가 영영 묻힌다.
    //
    // 조회 창(과거 90일~미래 365일) 밖의 일정은 살아 있어도 목록에 안 나온다. 창 밖은 판정에서 뺀다 —
    // 안 그러면 작년 일정이 '구글에서 지워졌다'로 읽혀 우리 쪽에서 사라진다.
    const windowFrom = seoulDateOf(new Date(now.getTime() - PULL_WINDOW_PAST_DAYS * DAY_MS).toISOString())
    const windowTo = seoulDateOf(new Date(now.getTime() + PULL_WINDOW_FUTURE_DAYS * DAY_MS).toISOString())
    // 한 캘린더라도 응답을 못 받은 통과에서는 아예 판정하지 않는다. 다른 캘린더로 옮겨 간 일정이
    // '어느 목록에도 없다'는 이유로 지워지는 일이 생긴다.
    for (const calendarId of (pulled.outcome === 'partial' ? [] : pulled.fullListed ?? [])) {
      const seen = new Set((pulled.byCalendar?.get(calendarId) ?? []).map((item) => String(item?.id ?? '')))
      for (const link of [...linkById.values()]) {
        if (link.accountId !== accountId || link.calendarId !== calendarId) continue
        if (link.detachedAt || link.remoteDeletedAt || linkRemovals.has(link.id)) continue
        if (!link.externalId || seen.has(link.externalId)) continue
        const local = localOf(link)
        const decision = resolveSync(link, local, { deleted: true, externalId: link.externalId }, now)
        if (decision.action === 'unlink') { linkRemovals.add(link.id); continue }
        if (decision.action !== 'delete-local') continue
        if (local?.date && (local.date < windowFrom || local.date > windowTo)) continue
        if (link.eventId) { eventDeletes.add(link.eventId); eventUpdates.delete(link.eventId) }
        upsertLink(applyOverwrite({ ...link, remoteDeletedAt: stamp, localDeletedAt: stamp, updatedAt: stamp }, {
          source: 'google', byName: '구글 캘린더', at: stamp, before: local ?? {},
        }))
        result.deletedLocal += 1
      }
    }

    // ---- 내보내기 후보: 아직 링크가 없거나 로컬만 바뀐 것 ----
    //
    // **쓸이는 exportEnabled 안팎을 가리지 않는다.** '내보내지 않음'은 새 일정을 만들지 않는다는 뜻이면서
    // 이미 연결된 일정의 수정·삭제도 나가지 않는다는 뜻이다 — 그 판정은 게이트가 하고 문장은 카드가 말한다.
    // 새로 만들 일정(insert)만 조용히 넘긴다: '내보내지 않음'이라고 적힌 드롭다운이 바로 그 자리에 있어
    // 카드에 영구히 붙는 오류 줄은 사람에게 새 사실을 하나도 주지 않는다.
    for (const event of pushableEvents(localEvents, accountId)) {
      if (eventDeletes.has(event.id)) continue
      const link = linkById.get(syncLinkId(accountId, writeCalendarId, event.id))
        ?? linkFor((row) => row.accountId === accountId && row.eventId === event.id && !row.detachedAt)
      if (!link) {
        if (!exportEnabled) continue
        if (remoteWrites.length >= MAX_PUSH_PER_RUN) { result.skipped += 1; continue }
        remoteWrites.push({ kind: 'insert', event, localId: event.id, linkKind: 'event' })
        continue
      }
      if (handled.has(link.id) || link.truncated || link.readOnly || link.detachedAt) continue
      const current = eventUpdates.get(event.id) ?? event
      if (calendarContentHash(current) === link.contentHash) continue
      if (remoteWrites.length >= MAX_PUSH_PER_RUN) { result.skipped += 1; continue }
      planPatch({ kind: 'patch', link, event: current })
    }
    if (connection.pushWorkDue !== false) {
      for (const candidate of workDueCandidates(workItems, accountId)) {
        const link = linkFor((row) => row.accountId === accountId && row.workItemId === candidate.id && !row.detachedAt)
        if (!link) {
          if (!exportEnabled) continue
          if (remoteWrites.length >= MAX_PUSH_PER_RUN) { result.skipped += 1; continue }
          remoteWrites.push({ kind: 'insert', event: candidate, localId: candidate.id, linkKind: 'work-due' })
          continue
        }
        if (handled.has(link.id)) continue
        const hash = calendarContentHash(workDueShape(candidate))
        if (hash === link.contentHash) continue
        if (remoteWrites.length >= MAX_PUSH_PER_RUN) { result.skipped += 1; continue }
        planPatch({ kind: 'patch', link, event: candidate, workDue: true })
      }
      // 결재완료·삭제된 업무의 [마감] 표식은 구글에서도 걷는다. 안 걷으면 끝난 마감이 달력에 영원히 남는다.
      // 구글에서 이미 지워진 것(remoteDeletedAt)은 건드리지 않는다.
      //
      // **이 통과의 계정 것만 본다.** links는 이 테넌트 전원의 링크다. 계정을 거르지 않으면 한 사람의
      // 통과가 자기 토큰으로 남의 캘린더 항목에 DELETE를 쏘고, 남의 링크 행까지 지운다.
      // 가져오기가 끝난 뒤의 맵을 도는 이유는 아래 툼스톤 쓸이와 같다 — 이번 통과에 바뀐 링크가 낡은 채로 읽히면 안 된다.
      for (const link of [...linkById.values()]) {
        if (link.accountId !== accountId) continue
        if (link.kind !== 'work-due' || link.detachedAt || link.remoteDeletedAt) continue
        if (linkRemovals.has(link.id) || handled.has(link.id)) continue
        if (workDueLocalOf(link)) continue
        if (remoteWrites.length >= MAX_PUSH_PER_RUN) { result.skipped += 1; continue }
        planDelete(link)
      }
    }
    // 로컬에서 사라진 마감·일정은 원격에서도 지운다(툼스톤이 있는 링크).
    //
    // **가져오기가 끝난 뒤의 맵을 돈다**(그 자리에서 한 번 뜬 사본이라 쓸이 중의 표식이 순회를 흔들지 않는다).
    // links는 통과 맨 앞의 스냅샷이라 이번 통과에서 되살아난 링크가
    // 아직 툼스톤을 달고 있는 것으로 보인다 — '삭제보다 수정이 이긴다'로 방금 되살린 일정의
    // 구글 원본을 같은 통과에서 지워 버리고, 다음 통과가 그것을 알맹이 없는 새 일정으로 다시 만든다.
    // 그 사이 참석자·주최자·알림·id가 전부 사라진다.
    // **계정도 거른다.** 남의 툼스톤을 내 토큰으로 지우면 그 사람의 삭제는 영영 전달되지 않고
    // 링크만 사라져 다음 통과에 같은 일정이 두 벌이 된다.
    for (const link of [...linkById.values()]) {
      if (link.accountId !== accountId) continue
      if (link.detachedAt || linkRemovals.has(link.id) || handled.has(link.id)) continue
      if (!link.localDeletedAt || link.remoteDeletedAt) continue
      planDelete(link)
    }

    // ---- 원격 쓰기 ----
    // 가져오기 고리에서 쌓인 쓰기(삭제·마감 되돌리기·충돌 패치)는 상한을 세지 않고 들어온다.
    // 세지 않고 자르면 통과는 '성공'이라고 말하면서 시킨 일보다 적게 한다. 넘친 만큼 skipped로 센다.
    const overflow = Math.max(0, remoteWrites.length - MAX_PUSH_PER_RUN)
    if (overflow) result.skipped += overflow
    for (const write of remoteWrites.slice(0, MAX_PUSH_PER_RUN)) {
      if (write.kind === 'insert') {
        const body = toGoogleEvent(write.event, { kind: write.linkKind, tenantId })
        const inserted = await google.insertEvent({ accessToken, calendarId: writeCalendarId, body })
        if (inserted.outcome !== 'ok') { result.skipped += 1; continue }
        const hash = write.linkKind === 'work-due' ? calendarContentHash(workDueShape(write.event)) : calendarContentHash(write.event)
        upsertLink({
          id: syncLinkId(accountId, writeCalendarId, write.localId), connectionId: connection.id, accountId, calendarId: writeCalendarId,
          eventId: write.linkKind === 'event' ? write.localId : null,
          workItemId: write.linkKind === 'work-due' ? write.localId : null,
          kind: write.linkKind,
          externalId: String(inserted.event?.id ?? ''), externalEtag: String(inserted.event?.etag ?? ''),
          contentHash: hash, remoteUpdatedAt: String(inserted.event?.updated ?? '') || null, localUpdatedAt: stamp,
          localDeletedAt: null, remoteDeletedAt: null, detachedAt: null,
          truncated: '', readOnly: false, origin: 'inthefield', history: [], createdAt: stamp, updatedAt: stamp,
        })
        result.pushed += 1
        continue
      }
      if (write.kind === 'patch') {
        const body = toGoogleEvent(write.event, { kind: write.workDue || write.link.kind === 'work-due' ? 'work-due' : 'event', tenantId })
        const patched = await google.patchEvent({
          accessToken, calendarId: write.link.calendarId, eventId: write.link.externalId, body, etag: write.link.externalEtag,
        })
        // 412: 그 사이 저쪽이 바뀌었다. 이 통과에서는 아무것도 쓰지 않고 다음 통과에서 재평가한다.
        if (patched.outcome !== 'ok') {
          /**
           * **읽지 않는 캘린더의 412는 스스로 풀리지 않는다.**
           * 보통은 다음 통과의 증분 목록이 새 etag를 알려 주지만, 이번 통과에 그 캘린더를 아예
           * 읽지 않았다면(동기화 목록 밖인데 내보내기 대상으로만 고른 캘린더) 새 etag를 배울 자리가
           * 어디에도 없다 — 같은 낡은 etag로 매 통과 412를 맞으며 사용자의 수정은 영원히 도착하지 않고
           * 할당량만 탄다. 그 경우에만 etag를 비운다: 읽지 않는 캘린더에서 '마지막 수정 우선'은
           * 조건 없는 쓰기를 뜻한다.
           */
          if (patched.outcome === 'conflict' && !pulled.byCalendar?.has(write.link.calendarId)) {
            upsertLink({ ...(linkById.get(write.link.id) ?? write.link), externalEtag: '', updatedAt: stamp })
          }
          result.skipped += 1
          continue
        }
        const hash = write.workDue || write.link.kind === 'work-due'
          ? calendarContentHash(workDueShape(write.event))
          : calendarContentHash(write.event)
        const next = {
          ...(linkById.get(write.link.id) ?? write.link),
          externalEtag: String(patched.event?.etag ?? write.link.externalEtag),
          remoteUpdatedAt: String(patched.event?.updated ?? '') || write.link.remoteUpdatedAt,
          contentHash: hash, localUpdatedAt: stamp, updatedAt: stamp,
        }
        upsertLink(write.before
          ? applyOverwrite(next, { source: 'inthefield', byName: ownerName || BRAND.name, at: stamp, before: write.before })
          : next)
        result.pushed += 1
        continue
      }
      if (write.kind === 'delete') {
        const removed = await google.deleteEvent({ accessToken, calendarId: write.link.calendarId, eventId: write.link.externalId })
        if (removed.outcome !== 'ok') { result.skipped += 1; continue }
        linkRemovals.add(write.link.id)
        result.deletedRemote += 1
        continue
      }
      if (write.kind === 'work-due') {
        // 구글에서 손댄 마감을 우리 값으로 되돌린다. 본문도 해시도 같은 후보 한 벌에서 나온다 —
        // 둘이 어긋나면 다음 통과가 또 '바뀌었다'로 읽어 같은 쓰기를 영원히 반복한다.
        const candidate = workDueCandidates([write.item], accountId)[0]
          ?? { id: write.item.id, title: write.item.title, dueDate: seoulDateOf(write.item.due) }
        const patched = await google.patchEvent({
          accessToken, calendarId: write.link.calendarId, eventId: write.link.externalId,
          body: toGoogleEvent(candidate, { kind: 'work-due', tenantId }), etag: '',
        })
        if (patched.outcome !== 'ok') { result.skipped += 1; continue }
        const existing = linkById.get(write.link.id) ?? write.link
        upsertLink({
          ...existing,
          externalEtag: String(patched.event?.etag ?? existing.externalEtag),
          remoteUpdatedAt: String(patched.event?.updated ?? '') || existing.remoteUpdatedAt,
          contentHash: calendarContentHash(workDueShape(candidate)),
          localUpdatedAt: stamp, updatedAt: stamp,
        })
        result.pushed += 1
      }
    }

    // ---- 조립: 세 레코드를 한 번에 대입하고 한 번만 커밋한다 ----
    const currentEvents = rowsOf(tenantStore, CALENDAR_EVENTS_KEY)
    const mergedEvents = new Map(currentEvents.map((event) => [event?.id, event]))
    for (const id of eventDeletes) mergedEvents.delete(id)
    for (const [id, event] of eventUpdates) {
      if (!mergedEvents.has(id) && mergedEvents.size >= MAX_CALENDAR_EVENTS_PER_TENANT) { limitHit = true; continue }
      mergedEvents.set(id, event)
    }
    const nextEvents = [...mergedEvents.values()]

    const currentLinks = rowsOf(tenantStore, CALENDAR_SYNC_LINKS_KEY)
    const mergedLinks = new Map(currentLinks.map((link) => [link?.id, sweepHistory(link, now)]))
    for (const id of linkRemovals) mergedLinks.delete(id)
    for (const [id, link] of linkUpdates) if (!linkRemovals.has(id)) mergedLinks.set(id, link)
    // 여기서 자르지 않는다. 링크 하나가 조용히 빠지면 그 일정은 '연결 없는 새 일정'이 되어
    // 다음 통과에 구글로 다시 나간다 — 상한은 링크를 만드는 자리에서만 건다.
    const nextLinks = [...mergedLinks.values()]

    const lastError = limitHit
      ? CALENDAR_LIMIT_MESSAGE
      : pulled.outcome === 'partial'
        ? '구글의 일부 응답을 받지 못했습니다. 다음 동기화에서 이어서 가져옵니다.'
        : CALENDAR_BLOCK_MESSAGES[blockedReason] ?? ''
    /**
     * 이 통과가 소유한 칸만 얹는다. 토큰과 '어느 캘린더를 볼지'는 얹지 않는다 —
     * 회전된 토큰은 위에서 따로 커밋했고(그 커밋이 실패했으면 메모리에도 남기지 않았다),
     * 캘린더 선택과 내보낼 캘린더는 사용자의 것이다(calendarItems는 살아 있는 선택 위에서 다시 계산한다).
     */
    const next = mergeLive({
      syncTokens: pulled.nextSyncTokens ?? connection.syncTokens,
      pending: pulled.nextPending ?? connection.pending,
      ...(refreshedCalendars ? { calendarItems: refreshedCalendars, calendarsListedAt: stamp } : {}),
      lastSyncAt: stamp,
      lastError,
      lastErrorAt: lastError ? stamp : null,
      /**
       * **통과가 끝까지 성공했다 = 연결이 실제로 살아 있다.** 상태와 '이미 알렸다'는 같은 사실이므로
       * 한 자리에서 함께 쓴다. 상태만 빼 두면 캘린더 API가 낸 401 한 번(시계 오차·갓 발급된 토큰·
       * 일시적 흔들림)으로 'needs-reauth'가 된 행이 **동기화가 멀쩡히 되는데도** 거기서 굳는다:
       * runAll은 'connected'만 돌리고 화면의 자동 동기화도 같은 조건에서 멈추므로 자동 경로가 둘 다
       * 죽고, 배너는 방금 오간 변경을 두고 '아직 오가지 않았습니다'라고 말한다.
       * 안전하다: 그 사이 해제됐으면 mergeLive가 null을 돌려주고, 토큰 없는 행은
       * effectiveConnectionStatus가 여전히 'revoked'로 읽는다.
       */
      status: 'connected',
      reauthNotifiedAt: null,
      keyFingerprint: secretBox.fingerprint ?? connection.keyFingerprint ?? '',
    })
    if (!next) {
      /**
       * 통과가 도는 동안 사용자가 해제했다(또는 행이 사라졌다). **이 통과분을 통째로 버린다** —
       * 일정도 링크도 쓰지 않는다. 링크를 쓰면 해제가 방금 찍은 detachedAt이 풀려 다시 붙고,
       * 연결을 쓰면 해제가 지운 봉인된 토큰이 되살아나 앱이 계속 그 사람의 구글 캘린더를 읽는다.
       * 되돌리기(restore)도 하지 않는다: 되돌릴 대상은 통과 시작 시점의 레코드라 해제 자체를 무른다.
       */
      logger.warn?.('[calendar-sync] 통과 도중 연결이 끊겨 결과를 버렸습니다', { tenantId })
      return { ok: false, status: 409, error: CALENDAR_ERRORS.NOT_FOUND, result }
    }

    tenantStore[CALENDAR_EVENTS_KEY] = { data: nextEvents, updatedAt: stamp, updatedBy: 'system:calendar-sync' }
    tenantStore[CALENDAR_SYNC_LINKS_KEY] = { data: nextLinks, updatedAt: stamp, updatedBy: 'system:calendar-sync' }
    writeConnections(tenantStore, next.rows, now)
    try {
      await commitWorkspaceStore()
    } catch (error) {
      // 세 키가 한 커밋에 실렸으므로 되돌릴 때도 셋을 함께 되돌린다. 하나만 되돌리면 툼스톤이 메모리에 남아
      // 다음 통과가 멀쩡한 일정을 지운다.
      const restore = (key, record) => { if (record) tenantStore[key] = record; else delete tenantStore[key] }
      restore(CALENDAR_EVENTS_KEY, previousEventRecord)
      restore(CALENDAR_SYNC_LINKS_KEY, previousLinkRecord)
      restore(CALENDAR_CONNECTIONS_KEY, previousConnectionRecord)
      logger.error?.('[calendar-sync] Failed to persist sync result', { message: error?.message })
      return { ok: false, status: 500, error: CALENDAR_ERRORS.WRITE_FAILED, result }
    }
    // version은 다른 publish와 같은 뜻이어야 한다 — 배열 길이를 실으면 길이가 같은 다른 배열이 같은 '버전'이 된다.
    eventStream.publish?.(tenantId, 'calendar', { key: CALENDAR_EVENTS_KEY, version: recordVersion(tenantStore[CALENDAR_EVENTS_KEY]) })
    return { ok: true, result, connection: next.merged, links: nextLinks, events: nextEvents, trigger }
  }

  return {
    isRunning: (tenantId, accountId) => inFlight.has(runKeyOf(tenantId, accountId)),
    async runForConnection(tenantId, accountId, { now = clock(), trigger = 'manual', forceCalendarList = false } = {}) {
      const key = runKeyOf(tenantId, accountId)
      if (inFlight.has(key)) return { ok: false, status: 409, error: CALENDAR_ERRORS.RUNNING, result: null }
      inFlight.add(key)
      try {
        return await pass(tenantId, accountId, now, trigger, { forceCalendarList })
      } catch (error) {
        logger.error?.('[calendar-sync] pass threw', { message: error?.message })
        return { ok: false, status: 500, error: CALENDAR_ERRORS.WRITE_FAILED, result: null }
      } finally {
        inFlight.delete(key)
      }
    },
    /** 스케줄러 한 통과. 오래 안 돈 연결부터 정해진 수만큼만 본다. */
    async runAll({ now = clock() } = {}) {
      const summary = { connections: 0, pulled: 0, pushed: 0, conflicts: 0, needsReauth: 0, retired: 0 }
      if (!google.configured || !secretBox.available) return { ...summary, skipped: '연동키 또는 암호화 키가 없어 건너뜀' }
      for (const [tenantId, tenantStore] of Object.entries(workspaceStore.tenants ?? {})) {
        // 먼저 명단에서 사라진 사람의 연결을 끝낸다. 상태와 무관하게 훑는 이유: 'needs-reauth'로 멈춰 선
        // 행도 봉인된 refresh token을 그대로 들고 있고, 본인은 세션이 없어 해제할 수 없다.
        const retiring = rowsOf(tenantStore, CALENDAR_CONNECTIONS_KEY)
          .filter((row) => row?.accountId && (row.refreshTokenEnc || row.accessTokenEnc) && !isActiveAccount(tenantId, row.accountId))
          .slice(0, MAX_CONNECTIONS_PER_PASS)
        for (const row of retiring) {
          if (await retireConnection(tenantId, row, now, CALENDAR_ACCOUNT_INACTIVE_MESSAGE)) summary.retired += 1
        }

        const rows = rowsOf(tenantStore, CALENDAR_CONNECTIONS_KEY)
          .filter((row) => row?.status === 'connected' && row.accessTokenEnc && isActiveAccount(tenantId, row.accountId))
          .sort((a, b) => String(a.lastSyncAt ?? '').localeCompare(String(b.lastSyncAt ?? '')))
          .slice(0, MAX_CONNECTIONS_PER_PASS)
        for (const row of rows) {
          const outcome = await this.runForConnection(tenantId, row.accountId, { now, trigger: 'scheduler' })
          summary.connections += 1
          if (outcome.ok) {
            summary.pulled += outcome.result.pulled
            summary.pushed += outcome.result.pushed
            summary.conflicts += outcome.result.conflicts
          } else if (outcome.error?.code === CALENDAR_ERRORS.NEEDS_REAUTH.code) summary.needsReauth += 1
        }
      }
      return summary
    },
  }
}

/**
 * 라우트 열 개.
 *
 * 격리: 1·2·4·4b·5·6·7·8은 전부 accountId === request.auth.id로만 행을 찾는다. 남의 것·다른 테넌트 것은
 * **404**다(403이 아니다 — "그런 연결이 있다"는 존재 오라클을 만들지 않는다).
 * 게스트: /api 아홉 개는 GUEST_ROUTE_ALLOWLIST 밖이라 게이트가 먼저 403을 낸다.
 * /oauth/google/callback은 게이트 **밖**이므로 핸들러가 직접 막는다 — 스윕이 못 보는 유일한 문이다.
 */
export function registerCalendarSyncRoutes({
  app, requireAuth, requireTenantAdmin, requireMatchingWorkspaceIdentity,
  workspaceStore, accounts, commitWorkspaceStore, secretBox, google, notify, events, resolveAuth,
  maskEmail, publicUrlOf = () => null, clock = () => new Date(), logger = console,
  workspaceRecordVersion, hasCalendarShape,
}) {
  const runner = createCalendarSyncRunner({
    workspaceStore, accounts, commitWorkspaceStore, google, secretBox, notify, events, clock, logger,
    ...(typeof workspaceRecordVersion === 'function' ? { recordVersion: workspaceRecordVersion } : {}),
    ...(typeof hasCalendarShape === 'function' ? { hasCalendarShape } : {}),
  })

  const tenantStoreOf = (tenantId) => (workspaceStore.tenants[tenantId] ??= {})
  const connectionsOf = (tenantId) => rowsOf(tenantStoreOf(tenantId), CALENDAR_CONNECTIONS_KEY)
  const linksOf = (tenantId) => rowsOf(tenantStoreOf(tenantId), CALENDAR_SYNC_LINKS_KEY)
  const connectionFor = (auth) => connectionsOf(auth.tenantId).find((row) => row?.accountId === auth.id) ?? null

  const saveConnections = async (tenantId, rows, now) => {
    const tenantStore = tenantStoreOf(tenantId)
    const previous = tenantStore[CALENDAR_CONNECTIONS_KEY]
    tenantStore[CALENDAR_CONNECTIONS_KEY] = { data: rows, updatedAt: now.toISOString(), updatedBy: 'system:calendar-sync' }
    try {
      await commitWorkspaceStore()
      return true
    } catch (error) {
      if (previous) tenantStore[CALENDAR_CONNECTIONS_KEY] = previous
      else delete tenantStore[CALENDAR_CONNECTIONS_KEY]
      logger.error?.('[calendar-sync] Failed to persist connection', { message: error?.message })
      return false
    }
  }

  const tenantGuard = (request, response) => {
    if (!request.auth?.tenantId) {
      response.status(403).json({ error: { code: 'TENANT_REQUIRED', message: '고객사 워크스페이스에서만 사용할 수 있습니다.' } })
      return false
    }
    if (request.auth.role === GUEST_ROLE) {
      response.status(403).json({ error: GUEST_SCOPE_FORBIDDEN })
      return false
    }
    return true
  }

  const guards = [requireAuth, requireMatchingWorkspaceIdentity]

  // 1. 상태. 화면은 이 응답 하나로 어떤 문구를 보여 줄지 정한다.
  app.get('/api/integrations/google/calendar', ...guards, (request, response) => {
    if (!tenantGuard(request, response)) return
    const connection = connectionFor(request.auth)
    const links = connection ? linksOf(request.auth.tenantId).filter((link) => link.connectionId === connection.id && !link.detachedAt) : []
    const externalEventIds = links.map((link) => link.eventId).filter(Boolean)
    response.json({
      configured: Boolean(google.configured),
      secretBoxReady: Boolean(secretBox?.available),
      secretBoxMessage: secretBox?.available ? '' : CALENDAR_ERRORS.SECRET_BOX_MISSING.message,
      connection: publicConnection(connection, links),
      externalEventIds: externalEventIds.slice(0, MAX_EXTERNAL_IDS_IN_STATUS),
      externalEventIdsTruncated: externalEventIds.length > MAX_EXTERNAL_IDS_IN_STATUS,
      syncing: connection ? runner.isRunning(request.auth.tenantId, request.auth.id) : false,
      autoSyncStaleMs: AUTO_SYNC_STALE_MS,
    })
  })

  /**
   * 2. 동의 화면 주소를 만든다.
   * **키가 없으면 구글로 보내기 전에 503**이다 — 콜백에서 토큰을 손에 쥐고 저장 못 하는 경로를
   * 구조적으로 만들지 않는다.
   */
  app.get('/api/integrations/google/calendar/authorize', ...guards, async (request, response) => {
    if (!tenantGuard(request, response)) return
    if (!google.configured) { response.status(503).json({ error: CALENDAR_ERRORS.NOT_CONFIGURED }); return }
    if (!secretBox?.available) { response.status(503).json({ error: CALENDAR_ERRORS.SECRET_BOX_MISSING }); return }
    // 러너와 같은 판정이다. 여기서 막지 않으면 '연결은 됐는데 첫 통과에서 조용히 끊기는' 상태가 생긴다.
    if (!isActiveTenantMember(accounts, request.auth.tenantId, request.auth.id)) {
      response.status(403).json({ error: CALENDAR_ERRORS.MEMBER_REQUIRED })
      return
    }

    const now = clock()
    const state = randomBytes(32).toString('base64url')
    const { verifier, challenge } = createPkcePair()
    const rows = connectionsOf(request.auth.tenantId)
    const existing = rows.find((row) => row?.accountId === request.auth.id)
    const connection = existing ? { ...existing } : newConnection({ accountId: request.auth.id, tenantId: request.auth.tenantId, now })
    const expiresAt = new Date(now.getTime() + PENDING_AUTH_TTL_MS).toISOString()
    // state는 평문으로 저장하지 않는다(sha256만). verifier는 봉인한다. 둘 다 **연결 행에** 둔다 —
    // 워커는 요청마다 앱을 새로 만들므로 모듈 메모리 Map은 배포에서 100% 실패한다.
    connection.pendingAuth = {
      stateHash: digest(state),
      pkceVerifierSecretEnc: secretBox.seal(verifier, { aad: pkceAad(request.auth.tenantId, request.auth.id) }),
      createdAt: now.toISOString(), expiresAt,
    }
    connection.updatedAt = now.toISOString()
    const next = existing ? rows.map((row) => (row?.accountId === request.auth.id ? connection : row)) : [...rows, connection]
    if (!await saveConnections(request.auth.tenantId, next, now)) {
      response.status(500).json({ error: CALENDAR_ERRORS.WRITE_FAILED })
      return
    }
    response.json({
      authorizeUrl: google.authorizeUrl({ challenge, state, loginHint: connection.email ?? '' }),
      expiresAt,
    })
  })

  /**
   * 3. OAuth 콜백. 순서가 곧 보안이다.
   * 이 경로는 /api 밖이라 게스트 게이트도 no-store 미들웨어도 타지 않는다 — 둘 다 손으로 붙인다.
   */
  const callback = async (request, response) => {
    response.setHeader('cache-control', 'private, no-store, max-age=0')
    response.setHeader('vary', 'Cookie')
    // 뒤 슬래시를 떼고 잇는다(server/webhook-routes.mjs와 같은 손질). APP_PUBLIC_URL을 'https://app/'로 적는 것은
    // 흔한 표기인데, 그대로 이으면 '//?calendar=connected'가 되어 주소창이 경로 '//'로 남는다.
    const home = String(publicUrlOf() ?? '').replace(/\/+$/, '')
    // 리다이렉트 목적지는 APP_PUBLIC_URL 또는 경로뿐이다. request.get('host')도 query 값도 쓰지 않는다(오픈 리다이렉트 차단).
    // response.redirect를 쓰지 않는 이유: Express가 Accept에 따라 본문을 골라 Vary에 Accept를 더한다.
    // 세션에 따라 달라지는 응답의 Vary는 Cookie 하나여야 한다(server/api-cache-headers.test.mjs).
    const back = (query) => { response.setHeader('location', `${home}/?${query}`); response.status(302).end() }
    /**
     * 이유값은 목록에 있는 것만 나간다. 목록을 **읽는 자리**가 여기 하나라도 있어야
     * CALLBACK_REASONS가 장식이 아니게 된다 — 계약 시험은 클라이언트의 문장 표와 이 목록을 맞춰 두는데,
     * 핸들러가 목록에 없는 낱말을 그냥 내보내면 사용자는 아무 문장도 없는 화면을 본다.
     */
    const fail = (reason) => back(`calendar=error&reason=${CALLBACK_REASONS.includes(reason) ? reason : 'upstream'}`)
    /**
     * 교환에 성공한 뒤의 실패는 **손에 쥔 구글 허가를 버리는 일**이다.
     * authorize는 prompt=consent로 나가므로 재시도마다 새 refresh token이 발급된다 — 거두지 않으면
     * 사용자 계정에 우리도 그도 볼 수 없는 허가가 쌓이고(구글은 사용자·클라이언트당 개수 상한을 넘으면
     * 오래된 것부터 조용히 무효화한다), 'scope' 화면은 "권한을 허용하지 않았습니다"라고 말하는데
     * 정작 계정에는 살아 있는 허가가 남는다. 최선 노력이다 — 구글이 500을 내도 화면은 같은 곳으로 간다.
     */
    const failAfterExchange = async (reason, tokens) => {
      if (tokens?.refreshToken && google?.configured) {
        try { await google.revoke({ refreshToken: tokens.refreshToken }) } catch { /* 최선 노력 */ }
      }
      return fail(reason)
    }

    const auth = resolveAuth(request)
    if (!auth) return fail('session')
    if (auth.role === GUEST_ROLE) return fail('forbidden')
    if (!auth.tenantId) return fail('tenant')
    if (request.query?.error) return back('calendar=cancelled')

    const state = String(request.query?.state ?? '')
    if (!STATE_PATTERN.test(state)) return fail('state')

    const now = clock()
    const rows = connectionsOf(auth.tenantId)
    // **이 계정의 행만** 본다. 다른 계정 행을 조회 대상에 넣는 순간 로그인-CSRF가 열린다.
    const connection = rows.find((row) => row?.accountId === auth.id)
    const pending = connection?.pendingAuth
    if (!pending?.stateHash) return fail('state')
    const supplied = Buffer.from(digest(state), 'utf8')
    const stored = Buffer.from(String(pending.stateHash), 'utf8')
    if (supplied.length !== stored.length || !timingSafeEqual(supplied, stored)) return fail('state')
    if ((Date.parse(pending.expiresAt) || 0) < now.getTime()) return fail('state')

    // 1회용 소각: 교환 전에 지우고 커밋한다. 같은 state로 두 번 오는 재사용을 여기서 끝낸다.
    const burned = { ...connection, pendingAuth: null, updatedAt: now.toISOString() }
    if (!await saveConnections(auth.tenantId, rows.map((row) => (row?.accountId === auth.id ? burned : row)), now)) return fail('upstream')

    if (!secretBox?.available) return fail('key')
    const verifier = secretBox.open(pending.pkceVerifierSecretEnc, { aad: pkceAad(auth.tenantId, auth.id) })
    if (!verifier) return fail('key')

    const exchanged = await google.exchangeCode({ code: String(request.query?.code ?? ''), verifier })
    if (exchanged.outcome !== 'ok') {
      // 이유값은 언제나 문자열 그대로 적는다 — 계약 시험이 여기서 나가는 낱말과 CALLBACK_REASONS를
      // 실제로 맞춰 보고, 삼항 안에 숨은 낱말은 그 대조를 빠져나간다.
      if (exchanged.outcome === 'unavailable') return fail('upstream')
      return fail('exchange')
    }
    // refresh_token이 없으면 저장하지 않는다. 저장하면 한 시간 뒤 조용히 끊긴 연결이 남는다.
    if (!exchanged.tokens.refreshToken) return failAfterExchange('norefresh', exchanged.tokens)
    /**
     * **낱말 단위로 정확히 비교한다.** 'calendar.events'를 substring으로 재면
     * 'calendar.events.readonly'가 그대로 통과한다 — authorize가 include_granted_scopes=true로 나가므로
     * 예전에 준 읽기 전용 허가가 응답의 scope 문자열에 섞여 들어오는 일이 실제로 생긴다.
     * 통과시키면 연결은 '연결됨'이 되고 모든 내보내기가 구글에서 403으로 조용히 사라진다.
     */
    const granted = new Set(String(exchanged.tokens.scope ?? '').split(/\s+/).filter(Boolean))
    if (!granted.has(GOOGLE_EVENTS_SCOPE)) return failAfterExchange('scope', exchanged.tokens)

    const listed = await google.listCalendars({ accessToken: exchanged.tokens.accessToken })
    if (listed.outcome !== 'ok') return failAfterExchange('upstream', exchanged.tokens)
    const calendars = normalizeCalendars(listed.items, { previous: connection.calendars ?? [] })
    const primary = calendars.find((calendar) => calendar.primary) ?? calendars[0] ?? null
    /**
     * **재연결은 처음 연결이 아니다.**
     * 배너가 시키는 대로 '다시 연결'을 누른 사람의 캘린더 선택과 내보낼 캘린더를 여기서 초기화하면,
     * 사람은 아무것도 고르지 않았는데 선택이 기본 캘린더 하나로 되돌아가고 — 더 나쁘게는
     * '내보내지 않음'으로 꺼 두었던 내보내기가 스스로 켜져 다음 통과에 개인 일정이 구글로 나간다.
     * normalizeCalendars가 previous의 selected를 이미 이어 왔으므로 재연결에서는 그것을 그대로 쓴다.
     */
    const firstConnect = !(connection.calendars ?? []).length

    const aad = tokenAad(auth.tenantId, auth.id)
    const next = {
      ...burned,
      email: exchanged.tokens.email || primary?.id || '',
      calendars: firstConnect ? calendars.map((calendar) => ({ ...calendar, selected: calendar.id === primary?.id })) : calendars,
      writeCalendarId: firstConnect
        ? (primary && isWritable(primary) ? primary.id : '')
        // 재연결: 고르던 캘린더가 여전히 있고 쓸 수 있으면 그대로. 사라졌거나 권한이 내려갔으면 비운다.
        : (calendars.some((calendar) => calendar.id === connection.writeCalendarId && isWritable(calendar)) ? connection.writeCalendarId : ''),
      accessTokenEnc: secretBox.seal(exchanged.tokens.accessToken, { aad }),
      refreshTokenEnc: secretBox.seal(exchanged.tokens.refreshToken, { aad }),
      keyFingerprint: secretBox.fingerprint ?? '',
      tokenExpiresAt: new Date(now.getTime() + Math.max(exchanged.tokens.expiresIn, 60) * 1_000 - 60_000).toISOString(),
      scope: exchanged.tokens.scope,
      // 목록을 방금 읽었다. 러너는 이 시각을 보고 다시 부를지 정한다(CALENDAR_LIST_REFRESH_MS).
      calendarsListedAt: now.toISOString(),
      status: 'connected', lastError: '', lastErrorAt: null, reauthNotifiedAt: null, disconnectedAt: null,
      updatedAt: now.toISOString(),
    }
    const saved = await saveConnections(auth.tenantId, connectionsOf(auth.tenantId).map((row) => (row?.accountId === auth.id ? next : row)), now)
    if (!saved) return failAfterExchange('upstream', exchanged.tokens)
    return back('calendar=connected')
  }
  app.get('/oauth/google/callback', callback)
  // 배포 대비 별칭. 고정 결정은 non-/api 경로이고, 이 별칭은 리버스 프록시가 /api만 넘길 때를 위한 것이다.
  app.get('/api/integrations/google/calendar/callback', callback)

  // 4. 어느 캘린더를 볼지·어디로 내보낼지.
  app.patch('/api/integrations/google/calendar/calendars', ...guards, async (request, response) => {
    if (!tenantGuard(request, response)) return
    const rows = connectionsOf(request.auth.tenantId)
    const connection = rows.find((row) => row?.accountId === request.auth.id)
    if (!connection) { response.status(404).json({ error: CALENDAR_ERRORS.NOT_FOUND }); return }

    const body = request.body ?? {}
    const next = { ...connection, updatedAt: clock().toISOString() }
    if (Array.isArray(body.selected)) {
      // **자르기 전에 말한다.** 조용히 잘라 저장하면 사람은 '저장했습니다'를 보고 나서
      // 체크 하나가 스스로 풀리는 것을 보게 되고, 어디에도 그 이유가 적혀 있지 않다.
      if (body.selected.length > MAX_SELECTED_CALENDARS) {
        response.status(400).json({ error: CALENDAR_ERRORS.TOO_MANY_SELECTED })
        return
      }
      const wanted = new Set(body.selected.map((id) => String(id)))
      for (const id of wanted) {
        if (!connection.calendars?.some((calendar) => calendar.id === id)) { response.status(400).json({ error: CALENDAR_ERRORS.UNKNOWN_ID }); return }
      }
      next.calendars = (connection.calendars ?? []).map((calendar) => ({ ...calendar, selected: wanted.has(calendar.id) }))
    }
    if (typeof body.writeCalendarId === 'string') {
      const target = (next.calendars ?? []).find((calendar) => calendar.id === body.writeCalendarId)
      if (body.writeCalendarId && !target) { response.status(400).json({ error: CALENDAR_ERRORS.UNKNOWN_ID }); return }
      if (body.writeCalendarId && !isWritable(target)) { response.status(400).json({ error: CALENDAR_ERRORS.NOT_WRITABLE }); return }
      next.writeCalendarId = body.writeCalendarId
    }
    if (typeof body.pushWorkDue === 'boolean') next.pushWorkDue = body.pushWorkDue

    const now = clock()
    if (!await saveConnections(request.auth.tenantId, rows.map((row) => (row?.accountId === request.auth.id ? next : row)), now)) {
      response.status(500).json({ error: CALENDAR_ERRORS.WRITE_FAILED })
      return
    }
    response.json({ connection: publicConnection(next, linksOf(request.auth.tenantId)) })
  })

  /**
   * 4b. 캘린더 목록 새로 고침.
   *
   * 목록은 연결 시점의 스냅샷이라 구글에서 새로 만들거나 공유받은 캘린더가 화면에 없다.
   * 러너가 여섯 시간마다 알아서 갱신하지만, 방금 캘린더를 만든 사람에게 여섯 시간은 '방법이 없다'와 같다.
   * **목록만 따로 가져오는 사본을 만들지 않는다** — 토큰 갱신·상태 판정·해제 경합 처리가 전부 통과
   * 한 자리에 있고, 여기서 흉내 내면 두 자리가 조용히 어긋난다. 같은 통과를 목록 강제로 한 번 돌린다.
   */
  app.post('/api/integrations/google/calendar/calendars/refresh', ...guards, async (request, response) => {
    if (!tenantGuard(request, response)) return
    if (!google.configured) { response.status(503).json({ error: CALENDAR_ERRORS.NOT_CONFIGURED }); return }
    if (!secretBox?.available) { response.status(503).json({ error: CALENDAR_ERRORS.SECRET_BOX_MISSING }); return }
    const connection = connectionFor(request.auth)
    if (!connection) { response.status(404).json({ error: CALENDAR_ERRORS.NOT_FOUND }); return }

    const now = clock()
    // 동기화와 같은 하한을 건다 — 연타로 구글 할당량을 태우는 문을 하나 더 만들지 않는다.
    const sinceLast = now.getTime() - (Date.parse(connection.lastSyncAt ?? '') || 0)
    if (connection.lastSyncAt && sinceLast < MIN_MANUAL_SYNC_INTERVAL_MS) {
      response.status(429).json({
        error: CALENDAR_ERRORS.TOO_SOON,
        retryAfterSeconds: Math.ceil((MIN_MANUAL_SYNC_INTERVAL_MS - sinceLast) / 1_000),
      })
      return
    }
    const outcome = await runner.runForConnection(request.auth.tenantId, request.auth.id, { now, trigger: 'manual', forceCalendarList: true })
    if (!outcome.ok) { response.status(outcome.status ?? 500).json({ error: outcome.error }); return }
    response.json({
      connection: publicConnection(outcome.connection, linksOf(request.auth.tenantId).filter((link) => link.connectionId === outcome.connection.id && !link.detachedAt)),
    })
  })

  // 5. 지금 동기화.
  app.post('/api/integrations/google/calendar/sync', ...guards, async (request, response) => {
    if (!tenantGuard(request, response)) return
    if (!google.configured) { response.status(503).json({ error: CALENDAR_ERRORS.NOT_CONFIGURED }); return }
    if (!secretBox?.available) { response.status(503).json({ error: CALENDAR_ERRORS.SECRET_BOX_MISSING }); return }
    const connection = connectionFor(request.auth)
    if (!connection) { response.status(404).json({ error: CALENDAR_ERRORS.NOT_FOUND }); return }

    const now = clock()
    const sinceLast = now.getTime() - (Date.parse(connection.lastSyncAt ?? '') || 0)
    if (connection.lastSyncAt && sinceLast < MIN_MANUAL_SYNC_INTERVAL_MS) {
      response.status(429).json({
        error: CALENDAR_ERRORS.TOO_SOON,
        retryAfterSeconds: Math.ceil((MIN_MANUAL_SYNC_INTERVAL_MS - sinceLast) / 1_000),
      })
      return
    }
    const outcome = await runner.runForConnection(request.auth.tenantId, request.auth.id, { now, trigger: 'manual' })
    if (!outcome.ok) { response.status(outcome.status ?? 500).json({ error: outcome.error }); return }
    const links = linksOf(request.auth.tenantId).filter((link) => link.connectionId === outcome.connection.id && !link.detachedAt)
    response.json({
      result: outcome.result,
      connection: publicConnection(outcome.connection, links),
      // 일정 배열은 싣지 않는다. 화면은 reloadToken으로 GET을 한 번 더 쳐서 서버가 가진 그대로를 받는다 —
      // 여기서 걸러 보낸 사본과 다음 GET의 결과가 어긋나면 어느 쪽이 진실인지 알 수 없어진다.
      externalEventIds: links.map((link) => link.eventId).filter(Boolean).slice(0, MAX_EXTERNAL_IDS_IN_STATUS),
    })
  })

  // 6. 연결 해제. 일정은 그대로 남고 링크 행은 detachedAt으로 살아 이력이 보존된다.
  app.post('/api/integrations/google/calendar/disconnect', ...guards, async (request, response) => {
    if (!tenantGuard(request, response)) return
    const rows = connectionsOf(request.auth.tenantId)
    const connection = rows.find((row) => row?.accountId === request.auth.id)
    if (!connection) { response.status(404).json({ error: CALENDAR_ERRORS.NOT_FOUND }); return }

    const now = clock()
    // 최선 노력이다. 구글이 500을 내도 우리 쪽 해제는 끝난다 — 사용자가 끊겠다고 했으면 끊긴다.
    // 다만 **거두지 못했다는 사실은 화면까지 간다**: 이 호출 뒤 암호문을 지우므로 두 번째 기회가 없고,
    // 아무 말도 없으면 사용자는 구글 계정에 살아 있는 쓰기 권한을 남긴 채 '해제했습니다'만 읽는다.
    const hadToken = Boolean(connection.refreshTokenEnc)
    const revoked = await revokeBestEffort({ secretBox, google, tenantId: request.auth.tenantId, row: connection })

    const detached = {
      ...connection, accessTokenEnc: null, refreshTokenEnc: null, tokenExpiresAt: null,
      syncTokens: {}, pending: {}, pendingAuth: null,
      status: 'revoked', disconnectedAt: now.toISOString(), lastError: '', lastErrorAt: null, updatedAt: now.toISOString(),
    }
    const tenantStore = tenantStoreOf(request.auth.tenantId)
    const previousLinks = tenantStore[CALENDAR_SYNC_LINKS_KEY]
    const links = linksOf(request.auth.tenantId)
    const nextLinks = links.map((link) => (link.connectionId === connection.id && !link.detachedAt ? { ...link, detachedAt: now.toISOString(), updatedAt: now.toISOString() } : link))
    const detachedCount = nextLinks.filter((link) => link.connectionId === connection.id && link.detachedAt).length
    tenantStore[CALENDAR_SYNC_LINKS_KEY] = { data: nextLinks, updatedAt: now.toISOString(), updatedBy: 'system:calendar-sync' }
    if (!await saveConnections(request.auth.tenantId, rows.map((row) => (row?.accountId === request.auth.id ? detached : row)), now)) {
      if (previousLinks) tenantStore[CALENDAR_SYNC_LINKS_KEY] = previousLinks
      else delete tenantStore[CALENDAR_SYNC_LINKS_KEY]
      response.status(500).json({ error: CALENDAR_ERRORS.WRITE_FAILED })
      return
    }
    // 화면은 이 수를 '가져온 일정 N건'이라고 읽는다. 그러니 정말 구글에서 온 것만 센다 —
    // 테넌트의 모든 일정을 세면 손으로 만든 전사 행사·팀 회식까지 '가져온 일정'이 된다.
    const importedIds = new Set(nextLinks.filter((link) => link.connectionId === connection.id && link.eventId).map((link) => link.eventId))
    response.json({
      disconnected: true,
      keptEvents: rowsOf(tenantStore, CALENDAR_EVENTS_KEY).filter((event) => importedIds.has(event?.id)).length,
      detachedLinks: detachedCount,
      hadToken,
      revoked,
    })
  })

  // 7. 연결 기록 완전 삭제. 일정은 남는다 — 지우는 것은 '어디서 왔는가'뿐이다.
  app.delete('/api/integrations/google/calendar', ...guards, async (request, response) => {
    if (!tenantGuard(request, response)) return
    const rows = connectionsOf(request.auth.tenantId)
    const connection = rows.find((row) => row?.accountId === request.auth.id)
    if (!connection) { response.status(404).json({ error: CALENDAR_ERRORS.NOT_FOUND }); return }

    const now = clock()
    // **암호문을 지우기 전에 구글에 알린다.** 이 호출이 행을 통째로 없애므로, 여기서 거두지 않으면
    // 그 허가는 되돌릴 수 없다 — '완전히 지우기'라고 적어 놓고 구글 계정에는 허가를 남기는 셈이 된다.
    // 거두지 못했으면(키가 바뀌어 못 열었다 등) 그 사실을 응답에 실어 화면이 직접 해제를 안내한다.
    const hadToken = Boolean(connection.refreshTokenEnc)
    const revoked = await revokeBestEffort({ secretBox, google, tenantId: request.auth.tenantId, row: connection })

    const tenantStore = tenantStoreOf(request.auth.tenantId)
    const previousLinks = tenantStore[CALENDAR_SYNC_LINKS_KEY]
    const links = linksOf(request.auth.tenantId)
    const kept = links.filter((link) => link.connectionId !== connection.id)
    tenantStore[CALENDAR_SYNC_LINKS_KEY] = { data: kept, updatedAt: now.toISOString(), updatedBy: 'system:calendar-sync' }
    if (!await saveConnections(request.auth.tenantId, rows.filter((row) => row?.accountId !== request.auth.id), now)) {
      if (previousLinks) tenantStore[CALENDAR_SYNC_LINKS_KEY] = previousLinks
      else delete tenantStore[CALENDAR_SYNC_LINKS_KEY]
      response.status(500).json({ error: CALENDAR_ERRORS.WRITE_FAILED })
      return
    }
    response.json({ removedLinks: links.length - kept.length, hadToken, revoked })
  })

  // 8. 덮어쓴 내역. 목록 응답에 싣지 않으므로 일정 GET의 payload와 version 계산이 전혀 바뀌지 않는다.
  app.get('/api/calendar/events/:eventId/overwrites', ...guards, (request, response) => {
    if (!tenantGuard(request, response)) return
    const link = linksOf(request.auth.tenantId).find((row) => row?.eventId === request.params.eventId && row.accountId === request.auth.id)
    if (!link) { response.status(404).json({ error: CALENDAR_ERRORS.OVERWRITES_NOT_FOUND }); return }
    response.json({
      overwrites: (link.history ?? []).map((entry) => ({ at: entry.at, source: entry.source, byName: entry.byName, before: entry.before })),
      truncated: link.truncated ?? '',
      readOnly: Boolean(link.readOnly),
      /**
       * 이 일정의 변경이 구글로 못 나가는 이유. 다이얼로그가 그중 맞는 한 문장만 그린다.
       * '읽기 전용'과 '구글 계정에서 사라진 캘린더'와 '동기화 대상에서 뺌'은 서로 다른 사실이다 —
       * 불리언 하나로 뭉치면 없는 캘린더를 두고 권한 이야기를 하게 된다.
       *
       * **기억하지 않고 지금 계산한다.** 통과가 링크에 새겨 두면 그 표식을 지우는 자리가
       * '패치가 실제로 통했을 때' 하나뿐이라, 캘린더를 다시 고른 뒤에도 마침 나갈 쓰기가 없으면
       * 다이얼로그가 이미 없는 제약을 계속 설명한다(러너와 같은 함수를 부른다).
       * 해제된 링크는 아무것도 오가지 않는 상태라 이유를 말하지 않는다.
       */
      sourceBlocked: link.detachedAt ? '' : remoteWriteBlockOf(connectionFor(request.auth) ?? {}, link),
      externalId: link.externalId ?? '',
    })
  })

  // 9. 관리자 개관. 상태만 본다 — 토큰은 어떤 형태로도 나가지 않는다.
  app.get('/api/integrations/google/calendar/overview', requireAuth, requireTenantAdmin, requireMatchingWorkspaceIdentity, (request, response) => {
    const rows = connectionsOf(request.auth.tenantId)
    response.json({
      rows: rows.map((row) => ({
        accountId: row.accountId,
        name: accounts.find((item) => item?.id === row.accountId)?.name ?? '',
        // 빈 값을 maskEmail에 넣으면 '***'가 나온다 — 아직 계정이 붙지 않은 행이 '가려진 주소'로 읽힌다.
        email: row.email ? maskEmail(row.email) : '',
        // 화면과 같은 판정을 쓴다. 여기만 row.status를 그대로 읽으면 동의 화면에서 그냥 돌아선 사람이
        // 관리자에게 '연결됨'으로 보인다 — 관리자가 볼 이유가 있는 바로 그 자리에서 틀린 상태가 된다.
        status: effectiveConnectionStatus(row),
        lastSyncAt: row.lastSyncAt ?? null,
        calendarCount: (row.calendars ?? []).filter((calendar) => calendar.selected).length,
      })),
      keyFingerprint: secretBox?.fingerprint ?? '',
      // 옛 키로 봉인된 채 남아 있는 연결 수. 키를 교체한 뒤 이 값이 0이 되면 옛 키를 비울 수 있다.
      // 오늘도 계산되는 진짜 사실이다 — 재봉인을 아직 안 만들었다는 이유로 필드를 비워 두면 다음 사람이 구멍을 못 본다.
      staleCount: rows.filter((row) => row.keyFingerprint && row.keyFingerprint !== (secretBox?.fingerprint ?? '')).length,
    })
  })

  return runner
}

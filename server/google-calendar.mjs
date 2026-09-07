import { createHash, randomBytes } from 'node:crypto'

import { KOREA_OFFSET } from './store/temporal-codec.mjs'

/**
 * 구글 캘린더 전송 어댑터 + 순수 매핑.
 *
 * web-push.mjs의 sendPush와 mail-delivery.mjs의 createMailDelivery를 합친 태도다:
 * **예외를 던지지 않고 분류된 결과를 돌려주고**, 연동키가 없으면 죽지 않고 기능을 닫는다.
 * 네트워크 한 번의 실패가 일정 화면 전체를 500으로 만들면 안 된다 — 구글이 흔들리는 동안에도
 * 우리 쪽 일정은 평소대로 보여야 한다.
 *
 * 이 파일에는 저장소도 라우트도 없다. 그래서 계약을 스텁 fetch만으로 전부 시험할 수 있다.
 */

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
export const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke'
export const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3'

/**
 * 쓰기까지 되는 단 하나의 범위. **동의 요청과 콜백의 검사가 이 한 값을 읽는다** —
 * 콜백이 substring으로 재면 'calendar.events.readonly'가 그대로 통과해서, 읽기 전용 허가를
 * '연결됨'으로 저장하고 모든 내보내기가 구글에서 403으로 조용히 사라진다.
 */
export const GOOGLE_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events'

/** 필요한 것만 요구한다. calendar 전체 권한을 받으면 사용자가 동의 화면에서 멈춘다. */
export const GOOGLE_SCOPES = Object.freeze([
  GOOGLE_EVENTS_SCOPE,
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'openid',
  'email',
])

export const REQUEST_TIMEOUT_MS = 15_000
export const TOKEN_REFRESH_MARGIN_MS = 120_000
export const PAGE_SIZE = 250
export const MAX_PAGES_PER_PASS = 10
export const PULL_WINDOW_PAST_DAYS = 90
export const PULL_WINDOW_FUTURE_DAYS = 365

// KOREA_OFFSET은 store/temporal-codec.mjs가 단일 출처다. 여기에 사본을 두면 두 값이 조용히 어긋난다.
export { KOREA_OFFSET }
export const MAX_TITLE = 200
export const MAX_LOCATION = 200
export const MAX_NOTE = 2_000

/** 사람이 보고 고치는 여섯 칸. 해시도 이력도 이 목록 하나에서 나온다. */
export const CALENDAR_SYNC_FIELDS = Object.freeze(['title', 'date', 'start', 'end', 'location', 'note'])

/**
 * 로그·저장에 남기기 전에 토큰처럼 생긴 것을 지운다.
 * lastError에 들어가는 모든 값과 console.warn 한 줄이 이 함수를 지난다 —
 * 구글의 오류 본문에는 종종 요청 본문이 그대로 메아리쳐 돌아온다.
 */
export function scrubUpstreamError(text) {
  return String(text ?? '')
    .replace(/(ya29\.[\w-]+|1\/\/[\w-]+|"(?:access|refresh|id)_token"\s*:\s*"[^"]*"|client_secret=[^&\s]*)/g, '[제거됨]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

/** 연동키 세 개가 다 있어야 켜진다. 하나라도 비면 화면은 '연동키 설정 후 사용할 수 있습니다'만 본다. */
export function googleSettings(env = process.env) {
  const clientId = String(env?.GOOGLE_OAUTH_CLIENT_ID ?? '').trim()
  const clientSecret = String(env?.GOOGLE_OAUTH_CLIENT_SECRET ?? '').trim()
  const redirectUri = String(env?.GOOGLE_OAUTH_REDIRECT_URI ?? '').trim()
  return { configured: Boolean(clientId && clientSecret && redirectUri), clientId, clientSecret, redirectUri }
}

/**
 * PKCE 한 쌍. verifier는 저장소에 봉인해 두고, challenge만 구글로 간다.
 * 왜 PKCE인가: 콜백의 code를 가로챈 상대가 verifier 없이는 토큰으로 바꾸지 못한다.
 */
export function createPkcePair(randomBytesImpl = randomBytes) {
  const verifier = randomBytesImpl(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** 응답 상태를 결과 종류로 옮긴다. 이 표 하나가 '다시 로그인'과 '잠시 후'를 가른다. */
function classify(status, body) {
  const error = String(body?.error?.message ?? body?.error ?? '')
  const reason = String(body?.error?.errors?.[0]?.reason ?? '')
  if (status === 401 || error === 'invalid_grant') return 'reauth'
  if (error === 'access_denied') return 'denied'
  if (status === 404) return 'gone'
  if (status === 410) return 'resync'
  if (status === 412) return 'conflict'
  if (status === 429) return 'retry'
  if (status === 403 && /rateLimit|userRateLimit|quotaExceeded/i.test(reason)) return 'retry'
  if (status >= 500) return 'retry'
  return 'failed'
}

/**
 * id_token의 email만 꺼낸다. **서명은 검증하지 않는다.**
 * 근거: 이 토큰은 브라우저가 아니라 구글 토큰 엔드포인트에서 TLS로 직접 받은 것이라 전달 과정에
 * 제3자가 없다. 우리는 이 값을 인증에 쓰지 않고 화면에 "어느 계정에 붙었나"를 적는 데만 쓴다.
 * 인증에 쓰기 시작하는 날 이 함수는 JWKS 검증으로 바뀌어야 한다.
 */
export function emailFromIdToken(idToken) {
  const part = String(idToken ?? '').split('.')[1]
  if (!part) return ''
  try {
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    const email = String(payload?.email ?? '').trim()
    return /^[^\s@]+@[^\s@]+$/.test(email) ? email.slice(0, 160) : ''
  } catch {
    return ''
  }
}

const clean = (value, max) => String(value ?? '')
  .normalize('NFC')
  .replace(/[\u0000-\u001f]/g, ' ')
  .trim()
  .slice(0, max)

/**
 * 양쪽이 같은가를 판정하는 해시.
 *
 * 왜 \u001f로 잇는가: 값 안에 나올 수 없는 문자라야 {title:'a|b'}와 {title:'a', location:'b'}가
 * 같은 해시가 되지 않는다.
 * 왜 NFC 정규화가 필수인가: macOS가 만든 한글 제목은 NFD, 구글이 돌려주는 값은 NFC다.
 * 정규화하지 않으면 같은 글자가 다른 해시가 되어 매 통과마다 '양쪽 다 바뀜'으로 판정되는 무한 왕복이 생긴다.
 */
export function calendarContentHash(source) {
  const canonical = CALENDAR_SYNC_FIELDS
    .map((field) => String(source?.[field] ?? '').normalize('NFC').replace(/[\u0000-\u001f]/g, ' ').trim())
    .join('\u001f')
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32)
}

/**
 * 결정론적 로컬 id. 같은 원격 일정을 두 번 가져와도 행이 늘지 않는다.
 *
 * **계정이 키에 반드시 들어간다.** 한 회사의 두 사람이 같은 공유 캘린더(팀·회의실)를 고르면
 * 계정 없는 키는 두 사람에게 같은 값을 준다 — 링크도 일정도 한 벌뿐이라 나중에 동기화한 사람이
 * 앞사람의 행을 통째로 빼앗는다. 덮어쓴 내역이 사라지고, 가져온 행은 scope:'personal'이라
 * 앞사람의 달력에서는 그 일정이 아예 사라진다. 링크·연결 레코드가 이미 계정별이므로 id도 계정별이어야 한다.
 */
export function syncedEventId(accountId, calendarId, externalId) {
  return `EV-G-${createHash('sha256').update(`${accountId}\u0000${calendarId}\u0000${externalId}`).digest('hex').slice(0, 16)}`
}

/** 링크 행 id도 같은 이유로 계정을 포함한 결정론이다 — 재시도가 링크를 늘리지 않는다. */
export function syncLinkId(accountId, calendarId, externalId) {
  return `CLK-${createHash('sha256').update(`${accountId}\u0000${calendarId}\u0000${externalId}`).digest('hex').slice(0, 16)}`
}

function addDays(date, delta) {
  const [year, month, day] = String(date).split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + delta)).toISOString().slice(0, 10)
}

function seoulParts(value) {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(parsed)
  const part = (type) => parts.find((candidate) => candidate.type === type)?.value
  const hour = part('hour') === '24' ? '00' : part('hour')
  return { date: `${part('year')}-${part('month')}-${part('day')}`, time: `${hour}:${part('minute')}` }
}

const clockAt = (minutes) => {
  const total = Math.min(Math.max(minutes, 0), 23 * 60 + 59)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}
const minutesOf = (time) => {
  const [hour, minute] = String(time).split(':').map(Number)
  return hour * 60 + minute
}

/**
 * hasCalendarShape는 end > start를 요구한다. 길이 0인 일정을 그대로 넣으면 그 행은 저장조차 되지 않는다.
 * 끝을 1분 미루되, 23:59에 걸린 것은 시작을 1분 당긴다 — 하루의 마지막 1분에 잡힌 0분 일정도 들어와야 한다.
 */
function widen(start, end) {
  if (end > start) return [start, end]
  const later = clockAt(minutesOf(start) + 1)
  if (later > start) return [start, later]
  return [clockAt(minutesOf(end) - 1), end]
}

/**
 * 구글 일정 한 건 → 우리 쪽 일정 행.
 *
 * 반환은 hasCalendarShape가 그대로 통과해야 하는 10필드 + ownerId다. 그 밖의 키를 하나라도
 * 얹으면 그 순간 **전 직원의 일정 쓰기가 403**이 된다(mergeMemberCalendarEvents → CALENDAR_WRITE_FORBIDDEN).
 * 동기화 메타는 전부 calendar-sync-links 쪽에 산다.
 *
 * 표현 손실은 감추지 않는다: 여러 날 일정은 첫날로 자르고 truncated를 남기며 note 첫 줄에 원래 기간을 적는다.
 */
export function fromGoogleEvent(remote, { accountId = '', ownerName = '', team = '' } = {}) {
  const externalId = String(remote?.id ?? '')
  if (!externalId) return null
  if (remote?.status === 'cancelled') return { deleted: true, externalId }

  const startDate = remote?.start?.date ? String(remote.start.date) : ''
  const endDate = remote?.end?.date ? String(remote.end.date) : ''
  let truncated = ''
  let date = ''
  let start = ''
  let end = ''
  let noteLead = ''

  if (startDate) {
    // 종일 일정. 구글의 end.date는 배타(다음 날)이므로 하루짜리면 start + 1일이다.
    date = startDate
    start = '00:00'
    end = '23:59'
    if (endDate && endDate > addDays(startDate, 1)) {
      truncated = 'multi-day'
      noteLead = `${startDate}~${addDays(endDate, -1)} (여러 날 일정)`
    }
  } else {
    const startParts = seoulParts(remote?.start?.dateTime)
    const endParts = seoulParts(remote?.end?.dateTime ?? remote?.start?.dateTime)
    if (!startParts || !endParts) return null
    date = startParts.date
    start = startParts.time
    if (endParts.date !== startParts.date) {
      truncated = 'multi-day'
      end = '23:59'
      noteLead = `${startParts.date} ${startParts.time}~${endParts.date} ${endParts.time} (여러 날 일정)`
    } else {
      end = endParts.time
    }
  }

  ;[start, end] = widen(start, end)

  const description = clean(remote?.description, MAX_NOTE)
  const note = noteLead ? clean(`${noteLead}\n${description}`.trim(), MAX_NOTE) : description

  const event = {
    id: syncedEventId(accountId, String(remote?.__calendarId ?? ''), externalId),
    title: clean(remote?.summary, MAX_TITLE) || '제목 없음',
    date,
    start,
    end,
    // 가져온 일정이 company가 되면 한 사람의 사생활 캘린더가 전사에 노출된다. 이 한 줄이 그 사고를 막는다.
    scope: 'personal',
    department: team || '미지정',
    location: clean(remote?.location, MAX_LOCATION),
    owner: ownerName || '',
    note,
    ownerId: accountId,
  }
  return {
    deleted: false,
    externalId,
    event,
    truncated,
    readOnly: Boolean(remote?.recurringEventId),
    etag: String(remote?.etag ?? ''),
    updated: String(remote?.updated ?? ''),
  }
}

/**
 * 우리 쪽 일정·업무 마감 → 구글 일정 본문.
 *
 * extendedProperties.private의 표식이 **링크 행을 잃었을 때 중복 생성을 막는 유일한 근거다.**
 * 링크가 사라져도 원격 일정 본문에 우리 id가 남아 있으면 다음 통과가 그 행을 되찾는다(adopt).
 */
export function toGoogleEvent(item, { kind = 'event', tenantId = '' } = {}) {
  const shared = {
    extendedProperties: {
      private: {
        inthefieldEventId: String(item?.id ?? ''),
        inthefieldTenantId: String(tenantId ?? ''),
        inthefieldKind: kind,
      },
    },
  }
  if (kind === 'work-due') {
    const due = String(item?.dueDate ?? '')
    return {
      ...shared,
      summary: `[마감] ${clean(item?.title, MAX_TITLE) || '제목 없음'}`,
      description: clean(item?.note, MAX_NOTE),
      // 구글 종일 end는 배타다. 하루짜리 마감이면 다음 날을 적어야 그날 하루로 그려진다.
      start: { date: due },
      end: { date: addDays(due, 1) },
      // 마감 표시가 '바쁨'으로 잡히면 회의 잡기가 막힌다. 마감은 일정이 아니라 표식이다.
      transparency: 'transparent',
    }
  }
  return {
    ...shared,
    summary: clean(item?.title, MAX_TITLE) || '제목 없음',
    location: clean(item?.location, MAX_LOCATION),
    description: clean(item?.note, MAX_NOTE),
    start: { dateTime: `${item?.date}T${item?.start}:00${KOREA_OFFSET}`, timeZone: 'Asia/Seoul' },
    end: { dateTime: `${item?.date}T${item?.end}:00${KOREA_OFFSET}`, timeZone: 'Asia/Seoul' },
  }
}

/** authorizeUrl은 순수 함수다 — 문자열만 만들고 네트워크를 타지 않는다. */
export function buildAuthorizeUrl({ clientId, redirectUri, challenge, state, loginHint = '' }) {
  const url = new URL(GOOGLE_AUTH_ENDPOINT)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', GOOGLE_SCOPES.join(' '))
  url.searchParams.set('access_type', 'offline')
  // prompt=consent가 없으면 재동의에서 refresh_token이 오지 않아 해제→재연결이 조용히 망가진다.
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('include_granted_scopes', 'true')
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  if (loginHint) url.searchParams.set('login_hint', loginHint)
  return url.toString()
}

const NOT_CONFIGURED = Object.freeze({ outcome: 'not-configured', status: 0, reason: '연동키가 없습니다.' })

export function createGoogleCalendarClient({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const settings = googleSettings(env)

  /** 한 번의 요청. 던지지 않는다 — 타임아웃도 네트워크 오류도 결과 객체로 돌아온다. */
  const call = async (url, init = {}) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal })
      const status = Number(response?.status) || 0
      const text = await response.text()
      let body = null
      try { body = text ? JSON.parse(text) : null } catch { body = null }
      if (status >= 200 && status < 300) return { outcome: 'ok', status, body }
      return { outcome: classify(status, body), status, reason: scrubUpstreamError(body ? JSON.stringify(body) : text) }
    } catch (error) {
      return { outcome: 'unavailable', status: 0, reason: error?.name === 'AbortError' ? '구글 응답이 없습니다(시간 초과).' : scrubUpstreamError(error?.message) }
    } finally {
      clearTimeout(timer)
    }
  }

  const form = (fields) => ({
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  })

  const authed = (accessToken, extra = {}) => ({
    ...extra,
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', ...(extra.headers ?? {}) },
  })

  const tokens = (body) => ({
    accessToken: String(body?.access_token ?? ''),
    refreshToken: String(body?.refresh_token ?? ''),
    expiresIn: Number(body?.expires_in) || 0,
    scope: String(body?.scope ?? ''),
    email: emailFromIdToken(body?.id_token),
  })

  return {
    configured: settings.configured,
    redirectUri: settings.redirectUri,

    authorizeUrl({ challenge, state, loginHint = '' }) {
      if (!settings.configured) return ''
      return buildAuthorizeUrl({ clientId: settings.clientId, redirectUri: settings.redirectUri, challenge, state, loginHint })
    },

    async exchangeCode({ code, verifier }) {
      if (!settings.configured) return NOT_CONFIGURED
      const result = await call(GOOGLE_TOKEN_ENDPOINT, form({
        code, client_id: settings.clientId, client_secret: settings.clientSecret,
        redirect_uri: settings.redirectUri, grant_type: 'authorization_code', code_verifier: verifier,
      }))
      return result.outcome === 'ok' ? { outcome: 'ok', status: result.status, tokens: tokens(result.body) } : result
    },

    async refresh({ refreshToken }) {
      if (!settings.configured) return NOT_CONFIGURED
      const result = await call(GOOGLE_TOKEN_ENDPOINT, form({
        refresh_token: refreshToken, client_id: settings.clientId, client_secret: settings.clientSecret, grant_type: 'refresh_token',
      }))
      return result.outcome === 'ok' ? { outcome: 'ok', status: result.status, tokens: tokens(result.body) } : result
    },

    /** 최선 노력. 구글이 거절해도 우리 쪽 해제는 진행한다 — 사용자가 끊겠다고 했으면 끊긴다. */
    async revoke({ refreshToken }) {
      if (!settings.configured) return NOT_CONFIGURED
      return call(GOOGLE_REVOKE_ENDPOINT, form({ token: refreshToken }))
    },

    async listCalendars({ accessToken }) {
      if (!settings.configured) return NOT_CONFIGURED
      const result = await call(`${GOOGLE_CALENDAR_API}/users/me/calendarList?maxResults=250`, authed(accessToken))
      if (result.outcome !== 'ok') return result
      return { outcome: 'ok', status: result.status, items: Array.isArray(result.body?.items) ? result.body.items : [] }
    },

    /**
     * 증분 목록. syncToken과 timeMin/timeMax를 **같이 보내면 구글이 400을 낸다** — 절대 함께 보내지 않는다.
     * 410은 '그 토큰은 이제 못 쓴다'이므로 전량 재조회 신호(resync)로 올린다.
     */
    async listEvents({ accessToken, calendarId, syncToken = '', timeMin = '', timeMax = '', pageToken = '' }) {
      if (!settings.configured) return NOT_CONFIGURED
      const url = new URL(`${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`)
      url.searchParams.set('singleEvents', 'true')
      url.searchParams.set('maxResults', String(PAGE_SIZE))
      if (syncToken) {
        url.searchParams.set('syncToken', syncToken)
        url.searchParams.set('showDeleted', 'true')
      } else {
        url.searchParams.set('timeMin', timeMin)
        url.searchParams.set('timeMax', timeMax)
        url.searchParams.set('showDeleted', 'false')
      }
      if (pageToken) url.searchParams.set('pageToken', pageToken)
      const result = await call(url.toString(), authed(accessToken))
      if (result.outcome !== 'ok') return result
      return {
        outcome: 'ok',
        status: result.status,
        items: Array.isArray(result.body?.items) ? result.body.items : [],
        nextPageToken: String(result.body?.nextPageToken ?? ''),
        nextSyncToken: String(result.body?.nextSyncToken ?? ''),
      }
    },

    async insertEvent({ accessToken, calendarId, body }) {
      if (!settings.configured) return NOT_CONFIGURED
      const result = await call(`${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`, authed(accessToken, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }))
      return result.outcome === 'ok' ? { outcome: 'ok', status: result.status, event: result.body } : result
    },

    /** If-Match 조건부 쓰기. 412는 '그 사이 저쪽이 바뀌었다'이고, 그 통과에서는 아무것도 쓰지 않는다. */
    async patchEvent({ accessToken, calendarId, eventId, body, etag = '' }) {
      if (!settings.configured) return NOT_CONFIGURED
      const result = await call(`${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, authed(accessToken, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...(etag ? { 'if-match': etag } : {}) },
        body: JSON.stringify(body),
      }))
      return result.outcome === 'ok' ? { outcome: 'ok', status: result.status, event: result.body } : result
    },

    /** 404·410은 성공으로 본다 — 이미 없는 것을 지우라고 했으니 목적은 달성됐다. */
    async deleteEvent({ accessToken, calendarId, eventId }) {
      if (!settings.configured) return NOT_CONFIGURED
      const result = await call(`${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, authed(accessToken, { method: 'DELETE' }))
      if (result.outcome === 'gone' || result.outcome === 'resync') return { outcome: 'ok', status: result.status }
      return result
    },
  }
}

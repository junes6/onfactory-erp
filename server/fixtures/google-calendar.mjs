/**
 * 상태를 가진 가짜 구글. 실키·실계정 없이 E절 전부를 시험한다.
 *
 * 왜 fetch 스텁이 아니라 상태 기계인가: 멱등성("2회차에 새 요청 0건")과 412 수렴과 410 재동기화는
 * '저쪽이 값을 기억한다'는 전제 위에서만 시험할 수 있다. 요청은 전부 requests에 남아
 * **몇 번 불렀는가를 직접 단언**할 수 있다.
 *
 * 실제 자격은 이 파일에 없다. access token은 'fake-access-N', refresh token은 'fake-refresh-N'이다.
 */

const ISO = (value) => new Date(value).toISOString()

export const FIXTURE_CALENDARS = Object.freeze([
  { id: 'primary@example.test', summary: '내 캘린더', primary: true, accessRole: 'owner' },
  { id: 'shared@example.test', summary: '공유 캘린더(읽기)', primary: false, accessRole: 'reader' },
])

/** 시험용 원격 일정 다섯 벌. 실명·실메일 0. */
export const fixtureEvents = () => ([
  { id: 'EV-TIMED', summary: '회의', status: 'confirmed', start: { dateTime: '2026-09-10T10:00:00+09:00' }, end: { dateTime: '2026-09-10T11:00:00+09:00' }, location: '', description: '', updated: ISO('2026-09-09T09:00:00Z'), etag: '"1"' },
  { id: 'EV-ALLDAY', summary: '종일 행사', status: 'confirmed', start: { date: '2026-09-11' }, end: { date: '2026-09-12' }, updated: ISO('2026-09-09T09:00:00Z'), etag: '"1"' },
  { id: 'EV-MULTIDAY', summary: '워크숍', status: 'confirmed', start: { date: '2026-09-12' }, end: { date: '2026-09-15' }, updated: ISO('2026-09-09T09:00:00Z'), etag: '"1"' },
  { id: 'EV-RECUR', summary: '주간 정례', status: 'confirmed', recurringEventId: 'EV-RECUR-ROOT', start: { dateTime: '2026-09-14T09:00:00+09:00' }, end: { dateTime: '2026-09-14T09:30:00+09:00' }, updated: ISO('2026-09-09T09:00:00Z'), etag: '"1"' },
  { id: 'EV-UTC', summary: 'UTC 일정', status: 'confirmed', start: { dateTime: '2026-03-01T15:30:00Z' }, end: { dateTime: '2026-03-01T16:30:00Z' }, updated: ISO('2026-02-28T09:00:00Z'), etag: '"1"' },
])

/**
 * @returns {{ transport, state, requests, setEvent, removeEvent, failNext, rotateRefreshToken, tokenCount }}
 */
export function createFakeGoogle({
  now = () => new Date('2026-09-10T01:00:00.000Z'),
  calendars = FIXTURE_CALENDARS,
  events = [],
  email = 'owner@example.test',
  /**
   * 전량 목록을 몇 건씩 끊어 줄지. 0이면 끊지 않는다(기존 시험의 모양 그대로).
   * **실제 구글은 nextSyncToken을 마지막 페이지에서만 준다** — 첫 페이지에도 주면
   * '이어 읽는 중'과 '다 읽었다'를 구별할 수 없어, 이어 읽기를 전량으로 착각하는 결함을 시험이 못 본다.
   */
  pageSize = 0,
} = {}) {
  const state = {
    calendars: calendars.map((calendar) => ({ ...calendar })),
    /** calendarId → Map<eventId, event> */
    events: new Map([[calendars[0].id, new Map(events.map((event) => [event.id, { ...event }]))]]),
    syncTokens: new Map(),
    etag: 1,
    /**
     * 쓰기마다 1ms씩 앞으로 간다.
     * **실제 구글은 자기 클라이언트가 방금 쓴 항목도 다음 증분 목록에 돌려준다.** updated를 목록 시점과
     * 같은 고정 시계로 찍으면 그 되돌림이 재현되지 않아, 내보낸 항목이 다음 통과에 다시 들어올 때
     * 무슨 일이 벌어지는지를 시험이 영영 보지 못한다(그 눈먼 구간에서 마감 왕복 결함이 살아남았다).
     */
    writeSeq: 0,
    tokens: 0,
    refreshRotation: 0,
    revoked: 0,
  }
  const requests = []
  let failures = []

  const calendarEvents = (calendarId) => {
    if (!state.events.has(calendarId)) state.events.set(calendarId, new Map())
    return state.events.get(calendarId)
  }
  const bumpEtag = () => `"${(state.etag += 1)}"`
  /**
   * 읽기 전용 캘린더에 쓰면 진짜 구글은 403을 낸다("You need to have writer access to this calendar").
   * 가짜가 조용히 성공하면 시험은 **못 나가야 할 요청이 나간 것**을 영영 보지 못한다 —
   * 그 눈먼 구간에서 삭제 세 자리의 읽기 전용 판정 누락이 살아남았다.
   * 아는 캘린더에만 건다. 목록에 없는 id는 실제 구글도 404이므로 여기서 판정하지 않는다.
   */
  const forbidsWrite = (calendarId) => {
    const calendar = state.calendars.find((item) => item.id === calendarId)
    return Boolean(calendar) && calendar.accessRole !== 'owner' && calendar.accessRole !== 'writer'
  }
  const forbidden = { outcome: 'failed', status: 403, reason: 'You need to have writer access to this calendar.' }
  /** 쓰기의 updated는 그 순간의 목록 시점보다 반드시 뒤다 — 그래야 다음 증분 목록이 돌려준다. */
  const writeStamp = () => new Date(now().getTime() + (state.writeSeq += 1)).toISOString()
  const takeFailure = (label) => {
    const index = failures.findIndex((failure) => failure.label === label || failure.label === '*')
    if (index < 0) return null
    return failures.splice(index, 1)[0]
  }

  const record = (method, pathname, extra = {}) => { requests.push({ method, pathname, ...extra }); return requests.length }

  const transport = {
    configured: true,
    redirectUri: 'http://127.0.0.1:8787/oauth/google/callback',

    authorizeUrl({ challenge, state: oauthState, loginHint = '' }) {
      record('GET', '/authorize', { query: { challenge, state: oauthState, loginHint } })
      return `https://accounts.google.com/o/oauth2/v2/auth?state=${oauthState}&code_challenge=${challenge}&code_challenge_method=S256`
    },

    async exchangeCode({ code, verifier }) {
      record('POST', '/token', { body: { grant_type: 'authorization_code', code, code_verifier: verifier } })
      const failure = takeFailure('token')
      if (failure) return failure.result
      state.tokens += 1
      return {
        outcome: 'ok',
        status: 200,
        tokens: {
          accessToken: `fake-access-${state.tokens}`,
          refreshToken: `fake-refresh-${state.refreshRotation + 1}`,
          expiresIn: 3_600,
          scope: 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly openid email',
          email,
        },
      }
    },

    async refresh({ refreshToken }) {
      record('POST', '/token', { body: { grant_type: 'refresh_token', refresh_token: refreshToken } })
      const failure = takeFailure('refresh')
      if (failure) return failure.result
      state.tokens += 1
      const rotated = state.refreshRotation > 0
      return {
        outcome: 'ok',
        status: 200,
        tokens: {
          accessToken: `fake-access-${state.tokens}`,
          refreshToken: rotated ? `fake-refresh-${state.refreshRotation + 1}` : '',
          expiresIn: 3_600,
          scope: 'https://www.googleapis.com/auth/calendar.events openid email',
          email,
        },
      }
    },

    async revoke() { record('POST', '/revoke'); state.revoked += 1; const failure = takeFailure('revoke'); return failure ? failure.result : { outcome: 'ok', status: 200 } },

    async listCalendars() {
      record('GET', '/calendarList')
      const failure = takeFailure('calendarList')
      if (failure) return failure.result
      return { outcome: 'ok', status: 200, items: state.calendars.map((calendar) => ({ ...calendar })) }
    },

    async listEvents({ calendarId, syncToken = '', timeMin = '', timeMax = '', pageToken = '' }) {
      record('GET', '/events.list', { query: { calendarId, syncToken, timeMin, timeMax, pageToken } })
      const failure = takeFailure('events.list')
      if (failure) return failure.result
      const rows = [...calendarEvents(calendarId).values()]
      if (syncToken) {
        const known = state.syncTokens.get(calendarId)
        // 모르는 토큰은 410이다. 러너가 전량 재조회로 되돌리는지 그 자리에서 확인할 수 있다.
        if (syncToken !== known) return { outcome: 'resync', status: 410, reason: 'sync token expired' }
        const changedSince = state.syncTokens.get(`${calendarId}:at`) ?? 0
        const items = rows.filter((event) => (Date.parse(event.updated) || 0) > changedSince)
        const token = `sync-${calendarId}-${state.etag}`
        state.syncTokens.set(calendarId, token)
        state.syncTokens.set(`${calendarId}:at`, now().getTime())
        return { outcome: 'ok', status: 200, items, nextPageToken: '', nextSyncToken: token }
      }
      // 초기 전량에서는 취소된 항목을 주지 않는다(showDeleted=false).
      const live = rows.filter((event) => event.status !== 'cancelled')
      const offset = Number(String(pageToken).replace('page-', '')) || 0
      const page = pageSize ? live.slice(offset, offset + pageSize) : live
      const nextPageToken = pageSize && offset + page.length < live.length ? `page-${offset + page.length}` : ''
      // 마지막 페이지에서만 토큰을 준다. 중간 페이지에서 주면 러너가 다 읽지 않고도 증분으로 넘어간다.
      if (nextPageToken) return { outcome: 'ok', status: 200, items: page, nextPageToken, nextSyncToken: '' }
      const token = `sync-${calendarId}-${state.etag}`
      state.syncTokens.set(calendarId, token)
      state.syncTokens.set(`${calendarId}:at`, now().getTime())
      return { outcome: 'ok', status: 200, items: page, nextPageToken: '', nextSyncToken: token }
    },

    async insertEvent({ calendarId, body }) {
      record('POST', '/events.insert', { query: { calendarId }, body })
      const failure = takeFailure('events.insert')
      if (failure) return failure.result
      if (forbidsWrite(calendarId)) return forbidden
      const id = `EV-REMOTE-${calendarEvents(calendarId).size + 1}`
      const event = { ...body, id, status: 'confirmed', etag: bumpEtag(), updated: writeStamp() }
      calendarEvents(calendarId).set(id, event)
      return { outcome: 'ok', status: 200, event }
    },

    async patchEvent({ calendarId, eventId, body, etag = '' }) {
      record('PATCH', '/events.patch', { query: { calendarId, eventId }, headers: { 'if-match': etag }, body })
      const failure = takeFailure('events.patch')
      if (failure) return failure.result
      if (forbidsWrite(calendarId)) return forbidden
      const existing = calendarEvents(calendarId).get(eventId)
      if (!existing) return { outcome: 'gone', status: 404, reason: 'not found' }
      // If-Match는 조건부 쓰기다. 그 사이 저쪽이 바뀌었으면 412로 거절한다.
      if (etag && etag !== existing.etag) return { outcome: 'conflict', status: 412, reason: 'etag mismatch' }
      const event = { ...existing, ...body, id: eventId, etag: bumpEtag(), updated: writeStamp() }
      calendarEvents(calendarId).set(eventId, event)
      return { outcome: 'ok', status: 200, event }
    },

    async deleteEvent({ calendarId, eventId }) {
      record('DELETE', '/events.delete', { query: { calendarId, eventId } })
      const failure = takeFailure('events.delete')
      if (failure) return failure.result
      if (forbidsWrite(calendarId)) return forbidden
      const existing = calendarEvents(calendarId).get(eventId)
      if (!existing) return { outcome: 'ok', status: 404 }
      calendarEvents(calendarId).set(eventId, { ...existing, status: 'cancelled', etag: bumpEtag(), updated: writeStamp() })
      return { outcome: 'ok', status: 200 }
    },
  }

  return {
    transport,
    state,
    requests,
    /** 저쪽에서 사람이 손댄 것을 흉내낸다. updated를 올려 주어야 '변경'으로 읽힌다. */
    setEvent(calendarId, event) {
      const existing = calendarEvents(calendarId).get(event.id)
      calendarEvents(calendarId).set(event.id, { ...existing, ...event, etag: bumpEtag(), updated: event.updated ?? writeStamp() })
    },
    removeEvent(calendarId, eventId) {
      const existing = calendarEvents(calendarId).get(eventId)
      if (existing) calendarEvents(calendarId).set(eventId, { ...existing, status: 'cancelled', etag: bumpEtag(), updated: writeStamp() })
    },
    /** 다음 호출 한 번만 실패시킨다. label은 '*'로 아무 호출이나 지정할 수 있다. */
    failNext(label, result) { failures.push({ label, result }) },
    clearFailures() { failures = [] },
    rotateRefreshToken() { state.refreshRotation += 1 },
    tokenCount: () => state.tokens,
    eventsOf: (calendarId) => [...calendarEvents(calendarId).values()],
  }
}

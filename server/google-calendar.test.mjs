import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  GOOGLE_SCOPES, buildAuthorizeUrl, calendarContentHash, createGoogleCalendarClient, createPkcePair,
  emailFromIdToken, fromGoogleEvent, googleSettings, scrubUpstreamError, syncLinkId, syncedEventId, toGoogleEvent,
} from './google-calendar.mjs'
import { fixtureEvents } from './fixtures/google-calendar.mjs'

/**
 * 구글 캘린더 어댑터 — 순수 계약과 스텁 fetch.
 *
 * 이 파일은 네트워크를 타지 않는다. 실제 자격도 없다. 여기서 잠그는 것은 세 가지다:
 * (1) 어떤 실패도 예외로 새어 나오지 않는다, (2) 토큰 문자열이 로그·오류에 남지 않는다,
 * (3) 매핑이 hasCalendarShape가 요구하는 모양을 벗어나지 않는다.
 */

const ENV = {
  GOOGLE_OAUTH_CLIENT_ID: 'client-id.apps.googleusercontent.test',
  GOOGLE_OAUTH_CLIENT_SECRET: 'test-client-secret',
  GOOGLE_OAUTH_REDIRECT_URI: 'http://127.0.0.1:8787/oauth/google/callback',
}
const OWNER = { accountId: 'USR-A', ownerName: '박지현', team: '생산팀' }
const eventById = (id) => ({ ...fixtureEvents().find((event) => event.id === id), __calendarId: 'cal-1' })

const stub = (responses) => {
  const calls = []
  const queue = [...responses]
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ?? null })
    const next = queue.shift() ?? { status: 200, body: {} }
    if (next.throws) throw next.throws
    return { status: next.status, async text() { return typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {}) } }
  }
  return { fetchImpl, calls }
}

test('1. googleSettings는 세 값이 다 있을 때만 켜진다', () => {
  assert.equal(googleSettings(ENV).configured, true)
  assert.equal(googleSettings({ ...ENV, GOOGLE_OAUTH_CLIENT_SECRET: '' }).configured, false)
  assert.equal(googleSettings({}).configured, false)
})

test('2. createPkcePair는 매번 다르고 challenge는 verifier의 S256이다', async () => {
  const { createHash } = await import('node:crypto')
  const first = createPkcePair()
  const second = createPkcePair()
  assert.notEqual(first.verifier, second.verifier)
  assert.ok(first.verifier.length >= 43 && first.verifier.length <= 128)
  assert.equal(first.challenge, createHash('sha256').update(first.verifier).digest('base64url'))
})

test('3. authorizeUrl에는 client_secret이 없고 필수 파라미터가 전부 있다', () => {
  const url = new URL(buildAuthorizeUrl({ clientId: ENV.GOOGLE_OAUTH_CLIENT_ID, redirectUri: ENV.GOOGLE_OAUTH_REDIRECT_URI, challenge: 'CH', state: 'ST' }))
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('access_type'), 'offline')
  // prompt=consent가 없으면 재동의에서 refresh_token이 오지 않아 해제→재연결이 조용히 망가진다.
  assert.equal(url.searchParams.get('prompt'), 'consent')
  assert.equal(url.searchParams.get('include_granted_scopes'), 'true')
  assert.equal(url.searchParams.get('redirect_uri'), ENV.GOOGLE_OAUTH_REDIRECT_URI)
  assert.deepEqual(url.searchParams.get('scope').split(' '), [...GOOGLE_SCOPES])
  assert.equal(url.toString().includes(ENV.GOOGLE_OAUTH_CLIENT_SECRET), false)
})

test('4. exchangeCode는 form-urlencoded로 code_verifier를 보내고 어떤 실패에서도 던지지 않는다', async () => {
  const ok = stub([{ status: 200, body: { access_token: 'ya29.abc', refresh_token: '1//zzz', expires_in: 3600, scope: 'a b' } }])
  const client = createGoogleCalendarClient({ env: ENV, fetchImpl: ok.fetchImpl })
  const result = await client.exchangeCode({ code: 'CODE', verifier: 'VER' })
  assert.equal(result.outcome, 'ok')
  assert.equal(result.tokens.refreshToken, '1//zzz')
  assert.equal(ok.calls[0].headers['content-type'], 'application/x-www-form-urlencoded')
  assert.match(ok.calls[0].body, /code_verifier=VER/)

  const cases = [
    [{ status: 400, body: { error: 'invalid_grant' } }, 'reauth'],
    [{ status: 400, body: { error: 'access_denied' } }, 'denied'],
    [{ status: 500, body: {} }, 'retry'],
    [{ status: 429, body: {} }, 'retry'],
    [{ throws: new Error('socket hang up') }, 'unavailable'],
  ]
  for (const [response, outcome] of cases) {
    const scenario = stub([response])
    const failing = createGoogleCalendarClient({ env: ENV, fetchImpl: scenario.fetchImpl })
    assert.equal((await failing.exchangeCode({ code: 'C', verifier: 'V' })).outcome, outcome)
  }
})

test('5. refresh 응답에 refresh_token이 없으면 빈 문자열로 알려 준다(호출부가 기존 값을 유지한다)', async () => {
  const scenario = stub([{ status: 200, body: { access_token: 'ya29.new', expires_in: 3600 } }])
  const client = createGoogleCalendarClient({ env: ENV, fetchImpl: scenario.fetchImpl })
  const result = await client.refresh({ refreshToken: '1//old' })
  assert.equal(result.outcome, 'ok')
  assert.equal(result.tokens.refreshToken, '')
})

test('6. listEvents: syncToken을 주면 timeMin/timeMax가 없고, 410은 resync다', async () => {
  const incremental = stub([{ status: 200, body: { items: [], nextSyncToken: 'T2' } }])
  const client = createGoogleCalendarClient({ env: ENV, fetchImpl: incremental.fetchImpl })
  await client.listEvents({ accessToken: 'ya29.x', calendarId: 'cal-1', syncToken: 'T1' })
  const withToken = new URL(incremental.calls[0].url)
  assert.equal(withToken.searchParams.get('syncToken'), 'T1')
  // syncToken과 timeMin/timeMax를 함께 보내면 구글이 400을 낸다.
  assert.equal(withToken.searchParams.has('timeMin'), false)
  assert.equal(withToken.searchParams.has('timeMax'), false)
  assert.equal(withToken.searchParams.get('showDeleted'), 'true')

  const initial = stub([{ status: 200, body: { items: [] } }])
  const fresh = createGoogleCalendarClient({ env: ENV, fetchImpl: initial.fetchImpl })
  await fresh.listEvents({ accessToken: 'ya29.x', calendarId: 'cal-1', timeMin: 'A', timeMax: 'B' })
  const full = new URL(initial.calls[0].url)
  assert.equal(full.searchParams.get('timeMin'), 'A')
  assert.equal(full.searchParams.get('singleEvents'), 'true')
  assert.equal(full.searchParams.get('showDeleted'), 'false')

  const gone = stub([{ status: 410, body: { error: { message: 'Sync token is no longer valid' } } }])
  const stale = createGoogleCalendarClient({ env: ENV, fetchImpl: gone.fetchImpl })
  assert.equal((await stale.listEvents({ accessToken: 'x', calendarId: 'c', syncToken: 'old' })).outcome, 'resync')
})

test('7. patchEvent는 If-Match를 붙이고 412는 conflict, deleteEvent의 404는 성공이다', async () => {
  const patched = stub([{ status: 412, body: {} }])
  const client = createGoogleCalendarClient({ env: ENV, fetchImpl: patched.fetchImpl })
  const result = await client.patchEvent({ accessToken: 'x', calendarId: 'c', eventId: 'e', body: {}, etag: '"7"' })
  assert.equal(result.outcome, 'conflict')
  assert.equal(patched.calls[0].headers['if-match'], '"7"')

  const missing = stub([{ status: 404, body: {} }])
  const deleter = createGoogleCalendarClient({ env: ENV, fetchImpl: missing.fetchImpl })
  // 이미 없는 것을 지우라고 했으니 목적은 달성됐다.
  assert.equal((await deleter.deleteEvent({ accessToken: 'x', calendarId: 'c', eventId: 'e' })).outcome, 'ok')
})

test('8. 타임아웃은 unavailable이고 configured가 false면 fetch를 한 번도 부르지 않는다', async () => {
  const hang = { fetchImpl: async (_url, init) => new Promise((_resolve, reject) => { init.signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error) }) }) }
  const client = createGoogleCalendarClient({ env: ENV, fetchImpl: hang.fetchImpl, timeoutMs: 10 })
  assert.equal((await client.listCalendars({ accessToken: 'x' })).outcome, 'unavailable')

  let calls = 0
  const off = createGoogleCalendarClient({ env: {}, fetchImpl: async () => { calls += 1; return { status: 200, async text() { return '{}' } } } })
  assert.equal(off.configured, false)
  for (const result of [await off.exchangeCode({}), await off.refresh({}), await off.listCalendars({}), await off.listEvents({}), await off.insertEvent({}), await off.patchEvent({}), await off.deleteEvent({})]) {
    assert.equal(result.outcome, 'not-configured')
  }
  assert.equal(calls, 0)
  assert.equal(off.authorizeUrl({ challenge: 'c', state: 's' }), '')
})

test('9. scrubUpstreamError가 토큰처럼 생긴 것을 전부 지운다', () => {
  const raw = 'failed ya29.a0AfB_x1 and 1//0gAbC-d with "refresh_token":"1//zzz" and client_secret=abc123&x=1'
  const scrubbed = scrubUpstreamError(raw)
  for (const secret of ['ya29.', '1//', 'refresh_token":"', 'client_secret=abc']) assert.equal(scrubbed.includes(secret), false, secret)
  assert.ok(scrubbed.length <= 200)
})

test('10. 소스에 토큰을 찍는 로그가 없다', async () => {
  const source = await (await import('node:fs/promises')).readFile(new URL('./google-calendar.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /console\.[a-z]+\([^)]*(accessToken|refreshToken|client_secret)/)
})

test('11. calendarContentHash: NFD와 NFC가 같고, 칸이 다르면 해시가 다르다', () => {
  const nfd = { title: '한글'.normalize('NFD'), date: '2026-09-10', start: '10:00', end: '11:00', location: '', note: '' }
  const nfc = { ...nfd, title: '한글'.normalize('NFC') }
  assert.equal(calendarContentHash(nfd), calendarContentHash(nfc))
  assert.equal(calendarContentHash(nfd).length, 32)
  // 'a|b'와 ('a','b')가 같은 해시가 되면 칸 경계를 넘긴 수정이 조용히 무시된다.
  assert.notEqual(calendarContentHash({ title: 'a|b' }), calendarContentHash({ title: 'a', location: 'b' }))
})

test('12. fromGoogleEvent: 시각·종일·여러 날·반복·UTC·취소', () => {
  const timed = fromGoogleEvent(eventById('EV-TIMED'), OWNER)
  assert.equal(timed.event.date, '2026-09-10')
  assert.equal(timed.event.start, '10:00')
  assert.equal(timed.event.end, '11:00')
  // 가져온 일정이 company가 되면 한 사람의 사생활 캘린더가 전사에 노출된다.
  assert.equal(timed.event.scope, 'personal')
  assert.equal(timed.event.ownerId, 'USR-A')
  assert.equal(timed.event.department, '생산팀')

  const allDay = fromGoogleEvent(eventById('EV-ALLDAY'), OWNER)
  assert.deepEqual([allDay.event.start, allDay.event.end, allDay.truncated], ['00:00', '23:59', ''])

  const multi = fromGoogleEvent(eventById('EV-MULTIDAY'), OWNER)
  assert.equal(multi.event.date, '2026-09-12')
  assert.equal(multi.truncated, 'multi-day')
  // 손실을 감추지 않는다 — note 첫 줄에 원래 기간이 남는다.
  assert.match(multi.event.note, /2026-09-12~2026-09-14/)

  assert.equal(fromGoogleEvent(eventById('EV-RECUR'), OWNER).readOnly, true)
  assert.equal(fromGoogleEvent(eventById('EV-UTC'), OWNER).event.date, '2026-03-02')
  assert.equal(fromGoogleEvent(eventById('EV-UTC'), OWNER).event.start, '00:30')
  assert.deepEqual(fromGoogleEvent({ id: 'X', status: 'cancelled' }, OWNER), { deleted: true, externalId: 'X' })
})

test('13. fromGoogleEvent 결과는 언제나 hasCalendarShape가 요구하는 모양이다', async () => {
  const { createApp } = await import('./app.mjs')
  assert.equal(typeof createApp, 'function')  // 앱은 부르지 않는다 — 여기서는 모양만 손으로 확인한다.
  const CALENDAR_FIELDS = ['id', 'title', 'date', 'start', 'end', 'scope', 'department', 'location', 'owner', 'note']
  const cases = [
    { id: 'A', summary: '', start: { dateTime: '2026-09-10T10:00:00+09:00' }, end: { dateTime: '2026-09-10T10:00:00+09:00' } },
    { id: 'B', summary: 'x'.repeat(5_000), start: { date: '2026-09-10' }, end: { date: '2026-09-11' } },
    { id: 'C', summary: '줄바꿈\n포함', description: '탭\t포함', location: '', start: { dateTime: '2026-09-10T23:59:00+09:00' }, end: { dateTime: '2026-09-10T23:59:00+09:00' } },
  ]
  for (const remote of cases) {
    const mapped = fromGoogleEvent({ ...remote, __calendarId: 'cal-1' }, OWNER)
    const keys = Object.keys(mapped.event)
    assert.deepEqual(keys.filter((key) => !CALENDAR_FIELDS.includes(key) && key !== 'ownerId'), [], remote.id)
    for (const field of CALENDAR_FIELDS) assert.equal(typeof mapped.event[field], 'string', `${remote.id}.${field}`)
    assert.match(mapped.event.date, /^\d{4}-\d{2}-\d{2}$/)
    // hasCalendarShape는 end > start를 요구한다. 0분짜리도 반드시 통과해야 한다.
    assert.ok(mapped.event.end > mapped.event.start, remote.id)
    assert.ok(mapped.event.title.length > 0 && mapped.event.title.length <= 200)
  }
  assert.equal(fromGoogleEvent({ id: 'A', summary: '', start: { dateTime: '2026-09-10T10:00:00+09:00' }, end: { dateTime: '2026-09-10T10:00:00+09:00' }, __calendarId: 'c' }, OWNER).event.title, '제목 없음')
})

test('14. toGoogleEvent: 일정은 +09:00, 업무 마감은 종일 + 배타 end + 표식', () => {
  const body = toGoogleEvent({ id: 'EV-1', title: '회의', date: '2026-09-10', start: '10:00', end: '11:00', location: '3층', note: '' }, { kind: 'event', tenantId: 'T' })
  assert.equal(body.start.dateTime, '2026-09-10T10:00:00+09:00')
  assert.equal(body.start.timeZone, 'Asia/Seoul')
  assert.equal(body.extendedProperties.private.inthefieldEventId, 'EV-1')
  assert.equal(body.extendedProperties.private.inthefieldTenantId, 'T')

  const due = toGoogleEvent({ id: 'WK-1', title: '보고서', dueDate: '2026-09-30' }, { kind: 'work-due', tenantId: 'T' })
  assert.equal(due.summary, '[마감] 보고서')
  // 구글 종일 end는 배타다. 다음 날을 적어야 그날 하루로 그려진다.
  assert.equal(due.end.date, '2026-10-01')
  assert.equal(due.transparency, 'transparent')
})

test('15. syncedEventId는 결정론이고 emailFromIdToken은 서명 없이 email만 뽑는다', () => {
  assert.equal(syncedEventId('USR-A', 'cal-1', 'EV-X'), syncedEventId('USR-A', 'cal-1', 'EV-X'))
  assert.notEqual(syncedEventId('USR-A', 'cal-1', 'EV-X'), syncedEventId('USR-A', 'cal-2', 'EV-X'))
  // 같은 공유 캘린더의 같은 일정이라도 사람이 다르면 다른 행이다 — 안 그러면 한쪽이 다른 쪽의 행을 빼앗는다.
  assert.notEqual(syncedEventId('USR-A', 'cal-1', 'EV-X'), syncedEventId('USR-B', 'cal-1', 'EV-X'))
  assert.notEqual(syncLinkId('USR-A', 'cal-1', 'EV-X'), syncLinkId('USR-B', 'cal-1', 'EV-X'))
  const payload = Buffer.from(JSON.stringify({ email: 'owner@example.test', sub: '1' })).toString('base64url')
  assert.equal(emailFromIdToken(`header.${payload}.sig`), 'owner@example.test')
  assert.equal(emailFromIdToken('garbage'), '')
  assert.equal(emailFromIdToken(''), '')
})

test('16. KOREA_OFFSET은 temporal-codec 한 곳에서만 정의된다', async () => {
  // 타임존 오프셋 사본 두 벌은 조용히 어긋난다 — 한쪽만 고쳐지면 시각이 아홉 시간 밀린다.
  const source = readFileSync(new URL('./google-calendar.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /const KOREA_OFFSET = /)
  assert.ok(source.includes("import { KOREA_OFFSET } from './store/temporal-codec.mjs'"))
  const codec = await import('./store/temporal-codec.mjs')
  assert.equal(codec.KOREA_OFFSET, '+09:00')
  assert.equal((await import('./google-calendar.mjs')).KOREA_OFFSET, codec.KOREA_OFFSET)
})

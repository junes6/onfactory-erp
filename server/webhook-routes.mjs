import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import { SEALED_PATTERN } from './secret-box.mjs'
import { bundleAssignmentDrafts } from './notifications.mjs'
import { NOTIFICATION_CHANNEL_IDS } from './notification-delivery.mjs'

/**
 * 외부 연동 — 받는 웹훅·보내는 웹훅·봉인된 비밀.
 *
 * 왜 테넌트 저장소 키인가: platform 컬렉션은 PG에서 다섯 개만 동기화되고, stripSensitivePayload가
 * token/secret이 든 키를 지운다. 그래서 엔드포인트를 platform.integrations에 두면 재기동과 함께
 * tokenHash와 봉인된 서명키가 조용히 사라진다 — 그날부터 모든 수신 주소가 404가 되고 아무도 이유를
 * 모른다. 테넌트 workspace 행에는 stripping이 없으므로 여기 둔다(라운드트립을 테스트가 잠근다).
 *
 * 저장되는 비밀값은 두 가지뿐이고 둘 다 원문이 아니다:
 *   - 수신 토큰: sha256 해시(tokenHash). 평문은 발급 응답에서 딱 한 번 보인다.
 *   - 발신 서명키: AES-256-GCM 봉인문(signingSecretEnc, AAD=엔드포인트 id). 키는 env에만 있다.
 *
 * 수신 실패는 전부 404 고정 본문이다. 401은 "그 토큰은 있는데 틀렸다"를 알려 주는 존재 오라클이 된다.
 */

export const WEBHOOK_ENDPOINTS_KEY = 'webhook-endpoints'
export const WEBHOOK_DELIVERIES_KEY = 'webhook-deliveries'

export const ENDPOINT_FIELDS = Object.freeze([
  'id', 'direction', 'label', 'conversationId', 'defaultOwnerId', 'tokenHash', 'tokenIssuedAt',
  'url', 'events', 'signingSecretEnc', 'enabled', 'consecutiveFailures', 'disabledAt',
  'createdById', 'createdAt', 'updatedAt', 'lastDeliveredAt', 'lastReceivedAt', 'receivedCount',
])

/**
 * payload·actor는 설계서의 필드 목록에 없던 두 칸이다. 없으면 보낼 내용을 저장할 곳이 없어
 * 재시도가 불가능하다 — 재기동 뒤 'pending' 행만 남고 무엇을 보내려 했는지는 사라진다.
 * 대신 payload에 들어갈 수 있는 키를 이벤트별 fields로 못박아, 이 칸이 본문·첨부·연락처를
 * 저장소로 끌어들이는 문이 되지 않게 한다.
 */
export const DELIVERY_FIELDS = Object.freeze([
  'id', 'endpointId', 'channel', 'eventType', 'eventId', 'aggregateId', 'target', 'status',
  'attempts', 'nextAttemptAt', 'lastStatusCode', 'lastError', 'requestedAt', 'deliveredAt',
  'payload', 'actor',
])

export const DELIVERY_STATUSES = new Set(['pending', 'delivered', 'failed', 'gave-up'])
/**
 * 저장할 수 있는 전달 채널. 알림 채널 목록은 어댑터 등록부(notification-delivery.mjs)에서 그대로 온다.
 * 여기에 낱말을 다시 적어 두면 채널이 하나 늘었을 때 이 게이트가 그 채널의 행을 전부 조용히 버리고,
 * 다음 읽기에서 dropped > 0이 되어 그 고객사의 전달이 통째로 멈춘다.
 */
export const DELIVERY_CHANNELS = new Set(['webhook', ...NOTIFICATION_CHANNEL_IDS])
export const WEBHOOK_DIRECTIONS = new Set(['inbound', 'outbound'])

export const MAX_ENDPOINTS_PER_TENANT = 50
export const MAX_DELIVERIES_PER_TENANT = 2_000
/** 1m 5m 30m 2h 6h. 여섯 번째 실패에서 포기한다. */
export const BACKOFF_MS = Object.freeze([60_000, 300_000, 1_800_000, 7_200_000, 21_600_000])
export const DISABLE_AFTER_FAILURES = 20
export const HOOK_BODY_LIMIT = '64kb'
export const HOOK_BODY_LIMIT_BYTES = 64 * 1024
export const HOOK_RATE_PER_MINUTE = 60
/**
 * 토큰이 틀린 요청만 이 버킷을 쓴다.
 *
 * 정상 배달이 이 버킷을 함께 쓰면, 아무 인증 없이 초당 두 건씩 엉터리 토큰을 던지는 것만으로
 * 이 프로세스의 모든 고객사 수신이 멈춘다(실측: 120건 뒤 유효 토큰이 429). 그래서 문을 지나는
 * 순서를 바꿨다 — 토큰을 먼저 찾고, 못 찾은 요청만 여기서 센다.
 *
 * 역조회 비용을 막는 총량 문은 두지 않는다. 문이 아니라 비용 쪽을 없앴다 —
 * 토큰 역조회는 색인 한 번이라(endpointByToken) 낯선 요청이 훑을 것이 남아 있지 않다.
 * 다시 세우는 비용은 엔드포인트를 **쓸 때** 한 번뿐이다: 수신 집계(markReceived)는 자기가 만든
 * 새 레코드를 색인에 물려주므로, 성공한 배달이 다음 요청에게 훑기를 떠넘기지 않는다.
 * 총량 문을 하나라도 남기면 그것이 곧 모든 고객사가 공유하는 정지 스위치가 된다.
 */
export const UNKNOWN_TOKEN_RATE_PER_MINUTE = 120
export const MAX_RATE_BUCKETS = 5_000
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,100}$/
export const TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/
export const ENDPOINT_ID_PATTERN = /^WHK-[A-Za-z0-9-]{4,60}$/
export const DELIVERY_ID_PATTERN = /^WHD-[A-Za-z0-9-]{4,60}$/
export const MAX_ENDPOINT_LABEL = 60
export const MAX_ENDPOINT_URL = 500
export const MAX_DELIVERY_ERROR = 500
export const DELIVERY_ID_HEADER = 'x-inthefield-delivery-id'
export const DELIVERY_KEY_PATTERN = /^[A-Za-z0-9_-]{1,120}$/
/** 봇 신원. MESSAGE_FIELDS가 senderId·senderName을 필수 string으로 요구하므로 상수로 못박는다. */
export const WEBHOOK_SENDER_ID = 'SYS-WEBHOOK'

/**
 * 발신 이벤트 어휘와 이벤트별 fields allowlist.
 * fields가 **바깥으로 나가는 전부**다 — 본문·설명·첨부·이메일·전화번호는 어떤 이벤트에도 실리지 않는다.
 * (아웃박스 events 테이블의 '민감 본문 없음' 규율과 같은 태도다.)
 */
export const WEBHOOK_EVENTS = Object.freeze({
  'work.created': { label: '업무 생성', fields: Object.freeze(['id', 'title', 'status', 'ownerId', 'due']) },
  'work.transitioned': { label: '업무 상태 변경', fields: Object.freeze(['id', 'title', 'beforeState', 'afterState', 'ownerId']) },
  'work.approved': { label: '업무 결재 완료', fields: Object.freeze(['id', 'title', 'ownerId', 'requesterId', 'approvedAt']) },
  'approval.completed': { label: '결재 완료(휴가·일지 포함)', fields: Object.freeze(['id', 'kind', 'decision', 'decidedById', 'decidedAt']) },
  'sentinel.alert': { label: '센티널 경고', fields: Object.freeze(['id', 'kind', 'summary', 'severity']) },
  'notice.posted': { label: '공지 게시', fields: Object.freeze(['id', 'scope', 'title', 'mustRead', 'targetCount', 'authorId']) },
})
export const WEBHOOK_EVENT_IDS = Object.freeze(Object.keys(WEBHOOK_EVENTS))

/** 목록 밖의 예약어다 — '테스트 보내기'가 그 엔드포인트 하나에만 보내는 별도 경로. */
export const WEBHOOK_TEST_EVENT = 'webhook.test'
const WEBHOOK_TEST_FIELDS = Object.freeze(['endpointId'])

export const webhookEventFields = (eventType) => (
  eventType === WEBHOOK_TEST_EVENT ? WEBHOOK_TEST_FIELDS : (WEBHOOK_EVENTS[eventType]?.fields ?? null)
)

export const newEndpointId = () => `WHK-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
export const newDeliveryId = () => `WHD-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
export const tokenDigest = (token) => createHash('sha256').update(String(token)).digest('hex')

const hasExactFields = (value, fields) => {
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}
const isIso = (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value))
const isId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 120
const CONTROL_CHARS = /[\x00-\x1f]/

/**
 * 이 계정에 일을 맡길 수 있는가 — 같은 고객사 · 승인됨 · 비활성 아님 · 게스트 아님.
 *
 * 인증 없는 웹훅이 누구에게 업무를 배정할 수 있는지를 정하는 판정이라 사본을 두지 않는다.
 * 같은 뜻의 조건을 세 군데에 적어 두면, 다음 사람이 차원 하나(정지 플래그 같은)를 더할 때
 * 세 곳 중 두 곳만 고치고 그 한 곳이 권한 구멍이 된다.
 */
export const isAssignableAccount = (account, tenantId) => Boolean(account)
  && account.tenantId === tenantId
  && account.approved === true
  && account.approvalStatus !== 'inactive'
  && account.role !== 'tenant-guest'
const clean = (value, max) => String(value ?? '').replace(/[\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)

// ---------------------------------------------------------------------------
// shape — 저장 직전과 읽은 직후 양쪽에서 같은 문을 지난다
// ---------------------------------------------------------------------------

export function hasEndpointShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (!hasExactFields(value, ENDPOINT_FIELDS)) return false
  if (!ENDPOINT_ID_PATTERN.test(String(value.id))) return false
  if (!WEBHOOK_DIRECTIONS.has(value.direction)) return false
  if (typeof value.label !== 'string' || !value.label.trim() || value.label.length > MAX_ENDPOINT_LABEL) return false
  if (CONTROL_CHARS.test(value.label)) return false
  if (typeof value.enabled !== 'boolean') return false
  if (!Number.isInteger(value.consecutiveFailures) || value.consecutiveFailures < 0) return false
  if (!Number.isInteger(value.receivedCount) || value.receivedCount < 0) return false
  if (!isId(value.createdById)) return false
  if (!isIso(value.createdAt) || !isIso(value.updatedAt)) return false
  for (const key of ['disabledAt', 'tokenIssuedAt', 'lastDeliveredAt', 'lastReceivedAt']) {
    if (value[key] !== null && !isIso(value[key])) return false
  }
  // 평문 토큰이 들어갈 수 없는 형태로 못박는다 — 64자 소문자 hex 아니면 저장되지 않는다.
  if (value.tokenHash !== null && !TOKEN_HASH_PATTERN.test(String(value.tokenHash))) return false
  if (value.tokenHash === null && value.tokenIssuedAt !== null) return false
  // 같은 이유로 서명키도 봉투 형식만 통과한다. 평문 문자열은 이 정규식을 지날 수 없다.
  if (value.signingSecretEnc !== null && !SEALED_PATTERN.test(String(value.signingSecretEnc))) return false
  if (!Array.isArray(value.events) || value.events.length > WEBHOOK_EVENT_IDS.length) return false
  if (!value.events.every((id) => WEBHOOK_EVENT_IDS.includes(id))) return false
  if (new Set(value.events).size !== value.events.length) return false
  if (value.conversationId !== null && !isId(value.conversationId)) return false
  if (value.defaultOwnerId !== null && !isId(value.defaultOwnerId)) return false
  if (value.url !== null && (typeof value.url !== 'string' || !value.url || value.url.length > MAX_ENDPOINT_URL)) return false
  if (value.direction === 'inbound') {
    // 받는 주소에는 보낼 곳도, 서명키도, 구독 사건도 없다.
    return value.url === null && value.signingSecretEnc === null && value.events.length === 0 && value.lastDeliveredAt === null
  }
  // 보내는 주소에는 받을 채널도, 기본 담당자도, 수신 토큰도 없다.
  return value.conversationId === null && value.defaultOwnerId === null && value.tokenHash === null
    && value.tokenIssuedAt === null && value.lastReceivedAt === null && value.receivedCount === 0
    && typeof value.url === 'string' && value.url.length > 0
}

export function hasDeliveryShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (!hasExactFields(value, DELIVERY_FIELDS)) return false
  if (!DELIVERY_ID_PATTERN.test(String(value.id))) return false
  if (!DELIVERY_CHANNELS.has(value.channel)) return false
  if (!DELIVERY_STATUSES.has(value.status)) return false
  // URL 전달은 엔드포인트가 있어야 하고, 알림 채널은 엔드포인트를 갖지 않는다.
  if (value.channel === 'webhook') {
    if (!ENDPOINT_ID_PATTERN.test(String(value.endpointId))) return false
  } else if (value.endpointId !== null) return false
  if (typeof value.eventType !== 'string' || !value.eventType || value.eventType.length > 60) return false
  if (typeof value.eventId !== 'string' || !value.eventId || value.eventId.length > 300) return false
  if (typeof value.aggregateId !== 'string' || value.aggregateId.length > 120) return false
  if (typeof value.target !== 'string' || value.target.length > 200) return false
  if (!Number.isInteger(value.attempts) || value.attempts < 0 || value.attempts > 50) return false
  if (value.nextAttemptAt !== null && !isIso(value.nextAttemptAt)) return false
  if (value.deliveredAt !== null && !isIso(value.deliveredAt)) return false
  if (!isIso(value.requestedAt)) return false
  if (value.lastStatusCode !== null && (!Number.isInteger(value.lastStatusCode) || value.lastStatusCode < 100 || value.lastStatusCode > 599)) return false
  if (value.lastError !== null && (typeof value.lastError !== 'string' || value.lastError.length > MAX_DELIVERY_ERROR || CONTROL_CHARS.test(value.lastError))) return false
  if (value.actor !== null && !isId(value.actor)) return false
  if (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) return false
  if (value.channel !== 'webhook') return Object.keys(value.payload).length === 0
  const fields = webhookEventFields(value.eventType)
  if (!fields || !hasExactFields(value.payload, fields)) return false
  // 바깥으로 나가는 값은 문자열·숫자·불리언·null뿐이다. 중첩 객체를 허용하면 fields allowlist가
  // "무엇이 나가는가"를 더 이상 말해 주지 못한다.
  return Object.values(value.payload).every((item) => item === null
    || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')
}

/** 읽기는 성한 행만 내보내고, 쓰기는 거절한다(notices.readNotices와 같은 규율). */
export function readEndpoints(record) {
  const raw = Array.isArray(record?.data) ? record.data : []
  const rows = raw.filter(hasEndpointShape)
  return { rows, dropped: raw.length - rows.length }
}
export function readDeliveries(record) {
  const raw = Array.isArray(record?.data) ? record.data : []
  const rows = raw.filter(hasDeliveryShape)
  return { rows, dropped: raw.length - rows.length }
}

// ---------------------------------------------------------------------------
// SSRF 판정 — 순수 함수
// ---------------------------------------------------------------------------

/** 0/8 10/8 100.64/10 127/8 169.254/16 172.16/12 192.0.0/24 192.168/16 198.18/15 224/4 240/4 */
export function isPrivateIpv4(value) {
  const parts = String(value ?? '').split('.')
  if (parts.length !== 4) return false
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN))
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false
  const [a, b] = octets
  if (a === 0 || a === 127 || a >= 224) return true                 // 0/8 · 127/8 · 224/4 · 240/4
  if (a === 10) return true
  if (a === 100 && b >= 64 && b <= 127) return true                 // CGNAT
  if (a === 169 && b === 254) return true                           // 링크 로컬(클라우드 메타데이터)
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && b === 0) return true                             // 192.0.0/24 · 192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return true              // 벤치마크 대역
  return false
}

/**
 * 사설·특수 IPv6인가.
 *
 * 이 판정이 없으면 ':'이 들어간 주소를 전부 사내망으로 몰아 거절하게 된다. IPv6가 열린 곳에서는
 * getaddrinfo가 AAAA를 먼저 돌려주므로(듀얼스택 수신처가 대부분 그렇다) 정상 주소가 통째로
 * '사내망 주소로 확인되어 보내지 않았습니다'가 되고, 그 행은 사다리를 다 올라 포기가 되며,
 * 20번째에 엔드포인트가 자동 중지된다 — 거짓 사유가 붙어 있어 기록만 보고는 원인을 찾을 수 없다.
 *
 * 그래서 '콜론이 있으면 거절'이 아니라 실제 대역으로 판정한다. v4를 품은 표기(::ffff:, 6to4, NAT64)는
 * 품고 있는 v4로 되돌려 본다 — v6 표기를 썼다고 사설 주소가 공인이 되지는 않는다.
 */
export function isPrivateIpv6(value) {
  // 존 id(fe80::1%eth0)와 대괄호는 주소의 일부가 아니다.
  const text = String(value ?? '').trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/%.*$/, '')
  if (!text.includes(':')) return false
  if (text === '::' || text === '::1') return true
  // ::로 시작하는 것은 전부 특수 주소다(::ffff:127.0.0.1 · ::ffff:7f00:1 · ::/96 v4 호환).
  if (text.startsWith('::')) {
    const dotted = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/)
    return dotted ? isPrivateIpv4(dotted[1]) : true
  }
  const parts = text.split(':')
  const hextet = (index) => {
    const part = parts[index] ?? ''
    return /^[0-9a-f]{1,4}$/.test(part) ? Number.parseInt(part, 16) : Number.NaN
  }
  const first = hextet(0)
  if (!Number.isInteger(first)) return true                          // 읽을 수 없는 주소로는 보내지 않는다
  // 0000::/16은 예약 대역이다 — 공인 유니캐스트는 2000::/3에서 시작한다. 위의 '::' 갈래는 압축 표기만
  // 잡으므로, 0:0:0:0:0:0:0:1이나 0:0:0:0:0:ffff:10.0.0.1처럼 펼쳐 적은 같은 주소가 여기로 흘러왔다.
  // lookupImpl은 주입할 수 있고 이 판정이 SSRF의 마지막 문이라, 표기 하나에 문이 열리게 두지 않는다.
  if (first === 0) return true
  if ((first & 0xfe00) === 0xfc00) return true                       // fc00::/7 유니크 로컬
  if ((first & 0xffc0) === 0xfe80) return true                       // fe80::/10 링크 로컬
  if ((first & 0xffc0) === 0xfec0) return true                       // fec0::/10 사이트 로컬(폐기됐지만 여전히 응답한다)
  if ((first & 0xff00) === 0xff00) return true                       // ff00::/8 멀티캐스트 — 배달할 곳이 아니다
  if (first === 0x64 && hextet(1) === 0xff9b) return true            // 64:ff9b::/96 NAT64는 v4로 번역돼 나간다
  if (first === 0x2002) {
    // 6to4는 다음 두 칸이 v4 주소다. 2002:7f00:1::은 127.0.0.1로 가는 길이다.
    const high = hextet(1)
    const low = hextet(2)
    if (!Number.isInteger(high) || !Number.isInteger(low)) return true
    return isPrivateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
  }
  return false
}

/**
 * 사내망 판정 한 벌. v4·v6 어느 표기로 와도 같은 문을 지난다.
 * 읽을 수 없는 값은 '공인'이 아니라 '보내지 않는다'로 접는다 — 모르는 것을 통과시키는 쪽이 더 나쁘다.
 */
export const isPrivateAddress = (value) => {
  const text = String(value ?? '').trim()
  if (!text) return true
  if (text.includes(':')) return isPrivateIpv6(text)
  const octets = text.split('.')
  if (octets.length !== 4 || !octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)) return true
  return isPrivateIpv4(text)
}

export function webhookUrlViolation(raw) {
  const text = String(raw ?? '')
  if (text.length > MAX_ENDPOINT_URL) return 'WEBHOOK_URL_INVALID'
  let url
  try { url = new URL(text) } catch { return 'WEBHOOK_URL_INVALID' }
  if (url.protocol !== 'https:') return 'WEBHOOK_URL_NOT_HTTPS'
  if (url.username || url.password) return 'WEBHOOK_URL_HAS_CREDENTIALS'
  // 443 고정. '≥1024는 허용' 같은 완화를 두면 5432·6379·9200 같은 내부 서비스가 사거리에 들어온다.
  if (url.port && url.port !== '443') return 'WEBHOOK_URL_PORT_FORBIDDEN'
  // 끝의 점은 루트를 명시한 같은 이름이다(`localhost.` = `localhost`). 떼지 않으면 아래 이름 검사가
  // 전부 빗나가 사내 주소가 등록까지는 통과한다 — 발신 직전 DNS 검사가 막아 주긴 하지만,
  // 그때는 이미 '보낼 수 없는 연동'이 저장된 뒤다.
  const host = url.hostname.toLowerCase().replace(/\.+$/, '')
  if (!host) return 'WEBHOOK_URL_INVALID'
  if (host.startsWith('[')) return 'WEBHOOK_URL_PRIVATE'                        // IPv6 리터럴은 받지 않는다
  if (host === 'localhost' || /\.(localhost|local|internal|home|lan)$/.test(host)) return 'WEBHOOK_URL_PRIVATE'
  if (/^0[xX]/.test(host) || /^\d+$/.test(host)) return 'WEBHOOK_URL_PRIVATE'   // 2130706433 · 0x7f000001 같은 표기
  if (isPrivateIpv4(host)) return 'WEBHOOK_URL_PRIVATE'
  return null
}

export const WEBHOOK_URL_MESSAGES = Object.freeze({
  WEBHOOK_URL_INVALID: '보낼 주소를 읽을 수 없습니다. https://로 시작하는 전체 주소를 적어 주세요.',
  WEBHOOK_URL_NOT_HTTPS: 'https 주소만 쓸 수 있습니다.',
  WEBHOOK_URL_HAS_CREDENTIALS: '주소에 아이디·비밀번호를 넣을 수 없습니다.',
  WEBHOOK_URL_PORT_FORBIDDEN: '443 포트만 쓸 수 있습니다.',
  WEBHOOK_URL_PRIVATE: '사내망·로컬 주소로는 보낼 수 없습니다.',
})

const NOT_FOUND = Object.freeze({ code: 'WEBHOOK_NOT_FOUND', message: '알 수 없는 수신 주소입니다.' })
const ENDPOINT_NOT_FOUND = Object.freeze({ code: 'WEBHOOK_ENDPOINT_NOT_FOUND', message: '외부 연동을 찾을 수 없습니다.' })
const DELIVERY_NOT_FOUND = Object.freeze({ code: 'WEBHOOK_DELIVERY_NOT_FOUND', message: '전달 기록을 찾을 수 없습니다.' })
const DATA_INVALID = Object.freeze({ code: 'WEBHOOK_DATA_INVALID', message: '저장된 외부 연동 중 형식이 깨진 것이 있어 쓰기를 멈췄습니다. 개발운영진에게 알려 주세요.' })
const WRITE_FAILED = Object.freeze({ code: 'WEBHOOK_WRITE_FAILED', message: '외부 연동을 저장하지 못했습니다.' })
const RATE_LIMITED = Object.freeze({ code: 'WEBHOOK_RATE_LIMITED', message: '요청이 너무 잦습니다. 잠시 후 다시 보내 주세요.' })
/**
 * 크기 초과는 한 사실이므로 문장도 한 벌이다 — 그 한 벌이 이 함수다.
 *
 * content-type이 application/json이면 64KB 파서가 먼저 잡아 app.mjs의 전역 에러 핸들러가 답하고,
 * 그렇지 않은 요청(text/plain 같은)은 어느 파서도 잡지 않으므로 핸들러 첫머리에서 한 번 더 본다.
 * 두 자리가 각자 문장을 지어 두면 한쪽만 손봐도 같은 잘못에 두 가지 말이 돌아온다.
 * MB로만 말하면 64KB 상한이 '0MB'가 되어 문장에서 사라지므로 KB까지 말한다.
 */
export const payloadTooLargeMessage = (bytes) => {
  const kb = Number.isFinite(Number(bytes)) ? Math.round(Number(bytes) / 1024) : 0
  const size = !kb ? '' : kb >= 1024 ? `${Math.round(kb / 1024)}MB` : `${kb}KB`
  return size
    ? `보내려는 내용이 한 번에 저장할 수 있는 크기(${size})를 넘었습니다. 파일 크기를 줄이거나 나눠서 저장해 주세요.`
    : '보내려는 내용이 한 번에 저장할 수 있는 크기를 넘었습니다. 파일 크기를 줄이거나 나눠서 저장해 주세요.'
}
const PAYLOAD_TOO_LARGE = Object.freeze({
  code: 'PAYLOAD_TOO_LARGE',
  message: payloadTooLargeMessage(HOOK_BODY_LIMIT_BYTES),
})
const PAYLOAD_INVALID = Object.freeze({ code: 'WEBHOOK_PAYLOAD_INVALID', message: '본문은 {"text": "..."} 또는 {"task": {"title": "..."}} 중 하나여야 합니다.' })
// 존재 오라클 금지 — 다른 고객사 계정 id와 없는 id, 게스트 id가 하나의 문장으로 거절된다.
const OWNER_REQUIRED = Object.freeze({ code: 'WEBHOOK_OWNER_REQUIRED', message: '담당자를 찾을 수 없습니다. 이 연동의 기본 담당자를 정하거나 본문에 담당자를 지정해 주세요.' })
// 꺼졌거나 지워진 연동으로는 다시 보낼 수 없다. 이 한 문장을 '다시 보내기'와 '테스트 보내기'가 함께 쓴다.
const ENDPOINT_DISABLED = Object.freeze({ code: 'WEBHOOK_ENDPOINT_DISABLED', message: '이 연동이 꺼져 있거나 삭제되어 다시 보낼 수 없습니다.' })
const DELIVERY_ALREADY_SENT = Object.freeze({ code: 'WEBHOOK_DELIVERY_ALREADY_SENT', message: '이미 전달된 기록입니다. 같은 사건을 두 번 보내지 않습니다.' })

/** 목록·상세 응답. tokenHash·signingSecretEnc는 절대 싣지 않고 있다/없다만 내려보낸다. */
export function safeEndpoint(endpoint) {
  return {
    id: endpoint.id,
    direction: endpoint.direction,
    label: endpoint.label,
    conversationId: endpoint.conversationId,
    defaultOwnerId: endpoint.defaultOwnerId,
    url: endpoint.url,
    events: [...endpoint.events],
    enabled: endpoint.enabled,
    consecutiveFailures: endpoint.consecutiveFailures,
    disabledAt: endpoint.disabledAt,
    createdAt: endpoint.createdAt,
    updatedAt: endpoint.updatedAt,
    lastDeliveredAt: endpoint.lastDeliveredAt,
    lastReceivedAt: endpoint.lastReceivedAt,
    receivedCount: endpoint.receivedCount,
    hasToken: Boolean(endpoint.tokenHash),
    tokenIssuedAt: endpoint.tokenIssuedAt,
    hasSecret: Boolean(endpoint.signingSecretEnc),
  }
}

/** 전달 기록도 payload를 내보내지 않는다 — 화면이 그리는 것은 시각·사건·상태·응답뿐이다. */
export const safeDelivery = (row) => ({
  id: row.id,
  endpointId: row.endpointId,
  channel: row.channel,
  eventType: row.eventType,
  aggregateId: row.aggregateId,
  target: row.target,
  status: row.status,
  attempts: row.attempts,
  nextAttemptAt: row.nextAttemptAt,
  lastStatusCode: row.lastStatusCode,
  lastError: row.lastError,
  requestedAt: row.requestedAt,
  deliveredAt: row.deliveredAt,
})

/**
 * 프로세스 안 토큰 버킷.
 *
 * Express에는 레이트 리밋이 없고 trust proxy도 꺼져 있어 IP는 믿을 수 없다. 그래서 버킷 둘만 둔다:
 * '엔드포인트별'(정상 트래픽의 유일한 상한)과 '토큰이 틀린 요청 전체'.
 * 뒤엣것은 역조회가 실패한 뒤에만 센다 — 낯선 사람이 던지는 요청이 정상 배달의 몫을 쓸 자리가 없다.
 * 프로세스 단위라 다중 인스턴스에서는 총량이 인스턴스 수만큼 는다.
 */
export function createRateBuckets({ max = MAX_RATE_BUCKETS } = {}) {
  const buckets = new Map()
  return (key, perMinute, now) => {
    const bucket = buckets.get(key) ?? { tokens: perMinute, at: now }
    const refill = (Math.max(0, now - bucket.at) / 60_000) * perMinute
    const tokens = Math.min(perMinute, bucket.tokens + refill)
    if (tokens < 1) { buckets.set(key, { tokens, at: now }); return false }
    buckets.set(key, { tokens: tokens - 1, at: now })
    // Map은 삽입 순서를 지킨다 — 넘치면 가장 먼저 들어온 것부터 버린다.
    if (buckets.size > max) buckets.delete(buckets.keys().next().value)
    return true
  }
}

export function registerWebhookRoutes({
  app, requireAuth, requireTenantAdmin, requireMatchingWorkspaceIdentity,
  workspaceStore, accounts, commitWorkspaceStore, commitConversationData,
  normalizeAdminWorkItems, prependWithinCap,
  workItemPriorities, notify, events, appendPlatformAudit,
  secretBox, dispatch, notificationDelivery, publicUrlOf = () => null,
  clock = () => new Date(), logger = console,
}) {
  const nowIso = () => clock().toISOString()
  const guards = [requireAuth, requireTenantAdmin, requireMatchingWorkspaceIdentity]
  const take = createRateBuckets()

  const tenantStoreOf = (tenantId) => (workspaceStore.tenants[tenantId] ??= {})
  const endpointsOf = (tenantId) => readEndpoints(workspaceStore.tenants[tenantId]?.[WEBHOOK_ENDPOINTS_KEY])
  const deliveriesOf = (tenantId) => readDeliveries(workspaceStore.tenants[tenantId]?.[WEBHOOK_DELIVERIES_KEY])
  const conversationsOf = (tenantId) => {
    const record = workspaceStore.tenants[tenantId]?.['messenger-conversations']
    return Array.isArray(record?.data) ? record.data : []
  }

  const requireTenant = (request, response) => {
    if (!request.auth?.tenantId) {
      response.status(403).json({ error: { code: 'TENANT_REQUIRED', message: '고객사 워크스페이스에서만 사용할 수 있습니다.' } })
      return false
    }
    return true
  }

  /** 쓰기 전에 저장된 행이 전부 성한지 본다. 깨진 행 위에 덮어쓰면 그 행의 전달 이력이 사라진다. */
  const readableEndpoints = (tenantId, response) => {
    const { rows, dropped } = endpointsOf(tenantId)
    if (dropped > 0) { response.status(409).json({ error: DATA_INVALID }); return null }
    return rows
  }

  /**
   * 엔드포인트 목록과 운영 감사 기록은 한 쓰기다 — 커밋이 실패하면 둘 다 되돌아간다.
   *
   * 감사 기록을 여기서 남기는 이유: appendPlatformAudit은 배열을 **새로 만들어 대입**한다.
   * 그래서 라우트가 먼저 audit(...)을 부르고 나면, 이 함수가 뜨는 스냅샷에는 이미 그 항목이 들어 있어
   * 복원이 자기 자신을 되돌려 놓는 죽은 코드가 된다(실측: 500을 받은 요청의 감사 기록만 남았다).
   * 스냅샷을 먼저 뜨고 그다음에 남긴다.
   */
  const writeEndpoints = async (tenantId, rows, actorId, response, recordAudit = null) => {
    const tenantStore = tenantStoreOf(tenantId)
    const previous = tenantStore[WEBHOOK_ENDPOINTS_KEY]
    const hadAudits = Boolean(workspaceStore.platform && Array.isArray(workspaceStore.platform.auditEvents))
    const previousAudits = hadAudits ? workspaceStore.platform.auditEvents : null
    recordAudit?.()
    tenantStore[WEBHOOK_ENDPOINTS_KEY] = { data: rows, updatedAt: nowIso(), updatedBy: actorId }
    try {
      await commitWorkspaceStore()
    } catch {
      if (previous) tenantStore[WEBHOOK_ENDPOINTS_KEY] = previous
      else delete tenantStore[WEBHOOK_ENDPOINTS_KEY]
      if (hadAudits) workspaceStore.platform.auditEvents = previousAudits
      response.status(500).json({ error: WRITE_FAILED })
      return false
    }
    return true
  }

  const audit = (request, event, endpoint) => {
    appendPlatformAudit?.(workspaceStore.platform, {
      tenantId: request.auth.tenantId, event, scope: `${endpoint.direction === 'inbound' ? '받기' : '보내기'} · ${endpoint.label}`,
      actor: request.auth.name, reference: endpoint.id,
    })
  }

  // ── 수신 웹훅 ───────────────────────────────────────────────

  /**
   * 수신 토큰 역조회 색인 — tokenHash → { tenantId, endpoint }.
   *
   * 색인이 없으면 요청 한 건이 모든 고객사의 모든 엔드포인트를 훑고, 그 훑기가 행마다
   * hasEndpointShape를 다시 돌린다(readEndpoints). 인증이 필요 없는 문이라 100 고객사 × 50개면
   * 낯선 요청 한 건이 5,000번의 shape 검사가 된다 — 남의 CPU를 마음대로 쓰는 증폭기다.
   * 그 비용이 사라져야 앞에 총량 문을 세울 이유도 사라진다(그 문이 곧 전체 정지 스위치였다).
   *
   * 신선도는 '무효화 호출'이 아니라 저장된 레코드의 동일성으로 판정한다. 이 키를 쓰는 곳은
   * writeEndpoints·markReceived와 드레인의 자동 중지 셋이고 마지막 하나는 다른 모듈에 있다.
   * 셋 다 레코드 객체를 통째로 새로 대입하므로 객체 하나만 비교하면 어느 쪽이 썼든 알아챈다 —
   * 무효화를 부르는 것을 잊은 네 번째 쓰기가 회수된 토큰을 계속 살려 두는 일이 없다.
   */
  const tokenIndex = new Map()
  const indexedRecords = new Map()

  const tokenIndexIsFresh = () => {
    const tenants = workspaceStore.tenants ?? {}
    let seen = 0
    for (const tenantId of Object.keys(tenants)) {
      const record = tenants[tenantId]?.[WEBHOOK_ENDPOINTS_KEY]
      if (!record) continue
      seen += 1
      if (indexedRecords.get(tenantId) !== record) return false
    }
    // 레코드가 통째로 사라진 고객사(초기화·복원)도 여기서 걸린다.
    return seen === indexedRecords.size
  }

  const rebuildTokenIndex = () => {
    tokenIndex.clear()
    indexedRecords.clear()
    const tenants = workspaceStore.tenants ?? {}
    for (const tenantId of Object.keys(tenants)) {
      const record = tenants[tenantId]?.[WEBHOOK_ENDPOINTS_KEY]
      if (!record) continue
      indexedRecords.set(tenantId, record)
      for (const endpoint of readEndpoints(record).rows) {
        if (endpoint.direction !== 'inbound' || !endpoint.tokenHash) continue
        // 꺼진 연동은 색인에 넣지 않는다 — 회수·중지·위조가 모두 '못 찾음' 한 갈래로 모인다.
        if (!endpoint.enabled || endpoint.disabledAt) continue
        tokenIndex.set(endpoint.tokenHash, { tenantId, endpoint })
      }
    }
  }

  /**
   * 평문 토큰은 어디에도 저장되지 않으므로 해시로 역조회한다.
   * 회수·비활성·위조·오타가 전부 같은 404 본문으로 끝난다.
   */
  const endpointByToken = (token) => {
    if (!TOKEN_PATTERN.test(String(token))) return null
    if (!tokenIndexIsFresh()) rebuildTokenIndex()
    const digest = createHash('sha256').update(String(token)).digest()
    const found = tokenIndex.get(digest.toString('hex'))
    if (!found) return null
    const stored = Buffer.from(found.endpoint.tokenHash, 'hex')
    // 색인은 문자열로 찾지만 마지막 확인은 timingSafeEqual이다(비교 대상이 해시라 길이가 늘 같다).
    if (stored.length !== digest.length || !timingSafeEqual(stored, digest)) return null
    return found
  }

  const deterministicId = (prefix, endpointId, deliveryKey) =>
    `${prefix}${createHash('sha256').update(`${endpointId}:${deliveryKey}`).digest('hex').slice(0, 12)}`

  const markReceived = async (tenantId, endpointId) => {
    const { rows, dropped } = endpointsOf(tenantId)
    // 깨진 행이 있으면 집계만 포기한다. 여기서 덮어쓰면 읽기에서 걸러진 그 행이 영영 사라진다.
    if (dropped > 0) return
    const at = nowIso()
    const next = rows.map((item) => (item.id === endpointId
      ? { ...item, receivedCount: item.receivedCount + 1, lastReceivedAt: at, updatedAt: at }
      : item))
    const tenantStore = tenantStoreOf(tenantId)
    const previous = tenantStore[WEBHOOK_ENDPOINTS_KEY]
    tenantStore[WEBHOOK_ENDPOINTS_KEY] = { data: next, updatedAt: at, updatedBy: `webhook:${endpointId}` }
    try { await commitWorkspaceStore() } catch {
      // 집계를 못 적은 것이 이미 게시된 메시지를 되돌릴 이유는 아니다. 다음 요청에서 다시 센다.
      if (previous) tenantStore[WEBHOOK_ENDPOINTS_KEY] = previous
      else delete tenantStore[WEBHOOK_ENDPOINTS_KEY]
      return
    }
    // 색인을 스스로 무효화하고 끝내지 않는다.
    //
    // 신선도는 레코드 객체의 동일성으로 판정한다. 방금 새 객체를 대입했으므로 여기서 손을 놓으면
    // **성공한 수신마다** 다음 요청이 전 고객사의 엔드포인트를 다시 훑는다 — 낯선 요청의 훑기를
    // 없애려고 만든 색인이 정작 정상 트래픽에서는 한 번도 재사용되지 않는다.
    // 바뀐 것은 이 엔드포인트의 집계 세 값뿐이고 tokenHash·enabled·받을 곳은 그대로다.
    // 물려주는 조건이 '아까 그 레코드를 색인했다'인 이유: 신선하지 않던 색인에 신선 도장을 찍으면
    // 회수·중지가 한 판 늦게 반영된다(그 자리에서 죽어야 한다).
    // !previous를 함께 보는 이유: 둘 다 undefined면 '같다'가 되어, 색인이 본 적 없는 고객사에
    // 신선 도장이 찍힌다(그 뒤로는 그 고객사 토큰이 영영 조회되지 않는다).
    if (!previous || indexedRecords.get(tenantId) !== previous) return
    indexedRecords.set(tenantId, tenantStore[WEBHOOK_ENDPOINTS_KEY])
    const refreshed = next.find((item) => item.id === endpointId)
    if (refreshed?.tokenHash && tokenIndex.has(refreshed.tokenHash)) {
      tokenIndex.set(refreshed.tokenHash, { tenantId, endpoint: refreshed })
    }
  }

  app.post('/api/hooks/:token', async (request, response) => {
    const now = clock().getTime()
    // 1) content-type이 json이 아니면 어느 파서도 잡지 않는다. 여기서 한 번 더 본다(버킷을 쓰지 않는다).
    if (Number(request.headers['content-length'] ?? 0) > HOOK_BODY_LIMIT_BYTES) {
      response.status(413).json({ error: PAYLOAD_TOO_LARGE })
      return
    }
    // 2) 역조회는 색인 한 번이다. 그 앞에는 아무 문도 두지 않는다 —
    //    거기 놓인 총량 버킷은 인증 없는 요청이 모든 고객사의 수신을 함께 멈추는 스위치가 된다.
    const found = endpointByToken(request.params.token)
    if (!found) {
      // 3) 틀린 토큰만 이 버킷을 쓴다. 토큰을 찾기 전에 세면, 낯선 사람이 던지는 요청이
      //    모든 고객사의 정상 배달 몫을 대신 써 버려 수신이 통째로 멈춘다.
      if (!take('hooks:unknown', UNKNOWN_TOKEN_RATE_PER_MINUTE, now)) {
        response.status(429).set('Retry-After', '60').json({ error: RATE_LIMITED })
        return
      }
      response.status(404).json({ error: NOT_FOUND })
      return
    }
    const { tenantId, endpoint } = found
    // 4) 엔드포인트별 상한. 정상 트래픽이 실제로 걸리는 유일한 문이다.
    if (!take(`ep:${endpoint.id}`, HOOK_RATE_PER_MINUTE, now)) {
      response.status(429).set('Retry-After', '60').json({ error: RATE_LIMITED })
      return
    }

    const body = request.body
    if (!body || typeof body !== 'object' || Array.isArray(body)) { response.status(400).json({ error: PAYLOAD_INVALID }); return }
    const wantsMessage = body.text !== undefined
    const wantsTask = body.task !== undefined
    if (wantsMessage === wantsTask) { response.status(400).json({ error: PAYLOAD_INVALID }); return }

    const rawKey = String(request.headers[DELIVERY_ID_HEADER] ?? '').trim()
    const deliveryKey = DELIVERY_KEY_PATTERN.test(rawKey) ? rawKey : ''

    if (wantsMessage) {
      const text = String(body.text ?? '').trim()
      if (!text || text.length > 4_000) {
        response.status(400).json({ error: { code: 'INVALID_MESSAGE', message: '메시지는 1~4,000자로 보내 주세요.' } })
        return
      }
      const conversations = conversationsOf(tenantId)
      const previous = conversations.find((item) => item?.id === endpoint.conversationId
        && (item.lifecycle ?? 'active') === 'active') ?? null
      if (!previous) {
        response.status(409).json({ error: { code: 'WEBHOOK_CHANNEL_MISSING', message: '이 연동이 게시할 채널이 없습니다. 외부 연동 설정에서 받을 곳을 다시 골라 주세요.' } })
        return
      }
      const messageId = deliveryKey ? deterministicId('m-wh-', endpoint.id, deliveryKey) : `m-wh-${randomBytes(6).toString('hex')}`
      // 외부 시스템의 재시도가 중복 게시로 번지지 않게 한다.
      if (previous.messages.some((item) => item?.id === messageId)) {
        response.json({ ok: true, replayed: true, kind: 'message', id: messageId })
        return
      }
      if (previous.messages.length >= 5_000) {
        response.status(409).json({ error: { code: 'MESSENGER_MESSAGE_CAPACITY_REACHED', message: '이 대화의 메시지 보관 한도(스레드 답글 포함 5,000건)에 도달했습니다. 개발운영진에게 보관 처리를 요청해 주세요.' } })
        return
      }
      const createdAt = nowIso()
      const message = {
        id: messageId,
        senderId: WEBHOOK_SENDER_ID,
        senderName: endpoint.label.slice(0, 60),
        senderRole: 'system',
        text,
        time: new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(createdAt)),
        createdAt,
        readBy: [],
      }
      const conversation = { ...previous, messages: [...previous.messages, message], lastMessage: text, lastTime: message.time }
      try {
        await commitConversationData(tenantId, conversations.map((item) => (item.id === conversation.id ? conversation : item)), `webhook:${endpoint.id}`)
      } catch {
        response.status(500).json({ error: WRITE_FAILED })
        return
      }
      // notifyMentions·proposeTaskFromMessage는 부르지 않는다 — 기계가 보낸 "처리 바랍니다"가
      // INSTRUCTION_PATTERN에 걸려 승인 큐에 제안을 쌓으면 모니터링 한 대가 결재 화면을 채운다.
      // @이름 흉내로 알림을 쏘는 길도 함께 막는다.
      try { events?.publish?.(tenantId, 'message', { key: 'messenger-conversations', conversationId: conversation.id }) } catch { /* 이벤트 실패가 게시를 되돌릴 이유는 아니다 */ }
      await markReceived(tenantId, endpoint.id)
      response.status(202).json({ ok: true, kind: 'message', id: message.id })
      return
    }

    const task = body.task && typeof body.task === 'object' && !Array.isArray(body.task) ? body.task : null
    if (!task) { response.status(400).json({ error: PAYLOAD_INVALID }); return }
    const title = clean(task.title, 120)
    if (!title) { response.status(400).json({ error: { code: 'WEBHOOK_TASK_INVALID', message: '업무 제목은 1~120자로 보내 주세요.' } }); return }
    const description = String(task.description ?? '').replace(/[\x00-\x08\x0b-\x1f]/g, '').slice(0, 2_000)
    const ownerId = String(task.ownerId ?? endpoint.defaultOwnerId ?? '')
    const owner = accounts.find((item) => item?.id === ownerId && isAssignableAccount(item, tenantId))
    if (!owner) { response.status(400).json({ error: OWNER_REQUIRED }); return }
    const dueRaw = String(task.due ?? '').trim()
    const dueMs = dueRaw ? Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(dueRaw) ? `${dueRaw}T09:00:00+09:00` : dueRaw) : Number.NaN
    const due = Number.isFinite(dueMs) ? new Date(dueMs).toISOString() : new Date(clock().getTime() + 2 * 24 * 60 * 60 * 1_000).toISOString()
    const priority = workItemPriorities.has(task.priority) ? task.priority : '보통'
    // 결재자는 이 연동을 만든 관리자다. requesterId를 비워 두면 담당자가 완료 보고를 올린 뒤
    // 승인할 사람이 없어 업무가 결재대기에서 영영 멈춘다(전이 라우트는 isRequester만 승인시킨다).
    // 그 관리자가 퇴사했으면 담당자 본인으로 접는다 — 멈춘 업무보다 자기 승인이 낫다.
    const requester = accounts.find((item) => item?.id === endpoint.createdById && isAssignableAccount(item, tenantId)) ?? owner
    const workId = deliveryKey ? deterministicId('WK-WH-', endpoint.id, deliveryKey).toUpperCase() : `WK-WH-${randomBytes(6).toString('hex').toUpperCase()}`

    const tenantStore = tenantStoreOf(tenantId)
    const current = Array.isArray(tenantStore['work-items']?.data) ? tenantStore['work-items'].data : []
    if (current.some((item) => item?.id === workId)) {
      response.json({ ok: true, replayed: true, kind: 'task', id: workId })
      return
    }
    const workItem = {
      id: workId,
      title,
      description,
      owner: owner.name,
      ownerId: owner.id,
      requestedBy: requester.name,
      requesterId: requester.id,
      due,
      // 상태는 '업무요청' 고정이다 — 외부에서 결재 상태머신을 건너뛰지 못한다.
      priority,
      status: '업무요청',
      category: '일반',
      createdAt: nowIso(),
      origin: { kind: 'webhook', label: '외부 연동에서 생성', detail: endpoint.label, page: 'people', focusId: endpoint.id },
    }
    const normalized = normalizeAdminWorkItems([workItem], tenantId, accounts)
    if (!normalized) { response.status(400).json({ error: { code: 'WEBHOOK_TASK_INVALID', message: '업무 정보를 확인해 주세요.' } }); return }
    const previousRecord = tenantStore['work-items']
    const previousDeliveries = tenantStore[WEBHOOK_DELIVERIES_KEY]
    tenantStore['work-items'] = { data: prependWithinCap(current, normalized[0], 1_000), updatedAt: workItem.createdAt, updatedBy: `webhook:${endpoint.id}` }
    // 받은 업무가 다시 발신 사건이 된다. 상태 변경과 배송 행은 한 커밋이고, 실패하면 함께 되돌아간다.
    dispatch.queueWebhookDeliveries(tenantId, 'work.created', {
      aggregateId: normalized[0].id, actor: null, occurredAt: workItem.createdAt,
      data: { id: normalized[0].id, title: normalized[0].title, status: normalized[0].status, ownerId: normalized[0].ownerId, due: normalized[0].due },
    })
    try {
      await commitWorkspaceStore()
    } catch {
      if (previousRecord) tenantStore['work-items'] = previousRecord
      else delete tenantStore['work-items']
      if (previousDeliveries) tenantStore[WEBHOOK_DELIVERIES_KEY] = previousDeliveries
      else delete tenantStore[WEBHOOK_DELIVERIES_KEY]
      response.status(500).json({ error: WRITE_FAILED })
      return
    }
    dispatch.kick(tenantId)
    notify(tenantId, bundleAssignmentDrafts([normalized[0]], { actorId: null, actorName: endpoint.label }))
    try { events?.publish?.(tenantId, 'work', { id: normalized[0].id, status: normalized[0].status, title: normalized[0].title }) } catch { /* 같은 이유 */ }
    await markReceived(tenantId, endpoint.id)
    response.status(202).json({ ok: true, kind: 'task', id: normalized[0].id })
  })

  // ── 관리 라우트 ─────────────────────────────────────────────

  // 로컬에는 TLS가 없다. 거기에 https를 적어 건네면 '이 주소로 POST하면 도착합니다'가
  // 붙여 넣는 그 자리에서 거짓이 된다(핸드셰이크에서 끊긴다). 그 한 예외를 두 갈래가 함께 쓴다.
  const isLoopbackHost = (host) => /^(?:localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])(?::\d+)?$/i.test(String(host ?? ''))
  // 같은 잘못된 설정값을 발급마다 다시 외치지 않는다 — 반복되는 줄은 읽히지 않는다.
  const warnedPublicUrls = new Set()

  const hookUrlFor = (request, token) => {
    // 토큰이 경로에 실린 주소다. 정확한 도메인은 APP_PUBLIC_URL이 정한다.
    const configured = String(publicUrlOf() ?? '').replace(/\/+$/, '')
    if (configured) {
      // 이 토큰은 인증 그 자체다 — 이 주소로 오는 POST에는 다른 자격이 없다. 그래서 설정값이라고
      // 그대로 믿지 않는다: APP_PUBLIC_URL 한 줄이 http면 관리자가 붙여 넣는 순간부터 토큰이
      // 매 호출마다 평문으로 흐르고, 그 사실을 말해 줄 화면이 바로 그 주소를 옳다고 인쇄한다.
      // 읽을 수 없거나 https가 아닌 값(로컬 제외)은 아래 요청 기반 갈래로 떨어뜨린다.
      let origin = null
      try { origin = new URL(configured) } catch { origin = null }
      if (origin && (origin.protocol === 'https:' || isLoopbackHost(origin.host))) {
        return `${configured}/api/hooks/${token}`
      }
      if (!warnedPublicUrls.has(configured)) {
        warnedPublicUrls.add(configured)
        logger.warn?.(`[webhook] APP_PUBLIC_URL이 https가 아니라 수신 주소를 요청 기준으로 만듭니다: ${configured}`)
      }
    }
    const host = String(request.get('host') ?? 'localhost')
    // trust proxy가 꺼져 있어 프록시 뒤에서는 request.protocol이 늘 http로 보인다. 그 주소를 그대로
    // 건네면 관리자가 외부 시스템에 http 주소를 붙여 넣고 토큰이 매 호출마다 평문으로 흐른다 —
    // 그래서 기본은 https다.
    const forwarded = String(request.get('x-forwarded-proto') ?? '').split(',')[0].trim().toLowerCase()
    const scheme = request.secure || forwarded === 'https' ? 'https' : isLoopbackHost(host) ? 'http' : 'https'
    return `${scheme}://${host}/api/hooks/${token}`
  }

  const locate = (request, response) => {
    const tenantId = request.auth.tenantId
    const rows = readableEndpoints(tenantId, response)
    if (!rows) return null
    const endpoint = rows.find((item) => item.id === request.params.id)
    if (!endpoint) { response.status(404).json({ error: ENDPOINT_NOT_FOUND }); return null }
    return { tenantId, rows, endpoint }
  }

  app.get('/api/webhooks', ...guards, (request, response) => {
    if (!requireTenant(request, response)) return
    const tenantId = request.auth.tenantId
    // 목록은 성한 행만 보여 준다(500으로 화면을 통째로 막지 않는다). 다만 걸러 냈다는 사실은
    // 함께 실어 보낸다 — 아무 말도 하지 않으면 화면은 멀쩡해 보이는데 저장·삭제·토큰은 전부
    // 409 '형식이 깨진 것이 있어 쓰기를 멈췄습니다'로 끝나고, 그 둘을 이어 줄 것이 화면에 없다.
    const { rows, dropped } = endpointsOf(tenantId)
    const deliveries = deliveriesOf(tenantId).rows
      .slice()
      .sort((left, right) => String(right.requestedAt).localeCompare(String(left.requestedAt)))
      .slice(0, 100)
    response.json({
      endpoints: rows.map(safeEndpoint),
      deliveries: deliveries.map(safeDelivery),
      events: WEBHOOK_EVENT_IDS.map((id) => ({ id, label: WEBHOOK_EVENTS[id].label })),
      // 503만 던지면 관리자가 목록 화면에서 왜 막혔는지 알 수 없다. 화면이 먼저 이유를 말한다.
      // 그 문장은 서버가 실어 보낸다 — 화면이 같은 뜻의 문장을 따로 쓰면 한쪽만 고쳐도 둘이 갈라진다.
      secretBoxAvailable: Boolean(secretBox?.available),
      secretBoxMessage: secretBox?.available ? '' : (secretBox?.unavailable?.message ?? ''),
      // 쓰기를 막을 때 나갈 그 문장 그대로다 — 화면이 같은 사실을 다른 낱말로 두 번 말하지 않는다.
      dataIssueMessage: dropped > 0 ? DATA_INVALID.message : '',
      // 설정된 채널만, 이름표까지 어댑터 등록부에서 온다.
      channels: notificationDelivery?.catalog ?? [],
    })
  })

  app.get('/api/webhooks/deliveries', ...guards, (request, response) => {
    if (!requireTenant(request, response)) return
    const limit = Math.min(200, Math.max(1, Number.parseInt(String(request.query.limit ?? '100'), 10) || 100))
    let rows = deliveriesOf(request.auth.tenantId).rows
    if (request.query.endpointId) rows = rows.filter((row) => row.endpointId === String(request.query.endpointId))
    if (request.query.status && DELIVERY_STATUSES.has(String(request.query.status))) {
      rows = rows.filter((row) => row.status === String(request.query.status))
    }
    rows = rows.slice().sort((left, right) => String(right.requestedAt).localeCompare(String(left.requestedAt))).slice(0, limit)
    response.json({ deliveries: rows.map(safeDelivery) })
  })

  /** 만들기와 고치기가 같은 문을 지난다 — 두 벌이 되면 한쪽만 느슨해진다. */
  const readInboundTarget = (tenantId, body, response) => {
    const conversationId = String(body?.conversationId ?? '').trim()
    if (conversationId) {
      const conversation = conversationsOf(tenantId).find((item) => item?.id === conversationId
        && (item.lifecycle ?? 'active') === 'active')
      // 단둘이 나누는 대화(direct)는 고를 수 없다. 화면의 고르개는 이미 팀 채널만 보여 주지만,
      // 서버가 더 느슨하면 관리자가 id 하나로 남의 1:1 대화를 지정할 수 있고, 그 순간부터
      // 토큰을 쥔 외부 시스템이 두 사람만의 방에 말을 넣는다.
      // systemChannel 유무 하나로 지원 채널까지 함께 걸린다 — hasConversationShape가 그 값에
      // 지원 채널 말고는 아무것도 허락하지 않으므로, 같은 뜻의 조건을 하나 더 두면 죽은 줄이 된다.
      if (!conversation || conversation.type !== 'team' || conversation.systemChannel) {
        response.status(404).json({ error: { code: 'CONVERSATION_NOT_FOUND', message: '대화를 찾을 수 없습니다.' } })
        return null
      }
    }
    const defaultOwnerId = String(body?.defaultOwnerId ?? '').trim()
    if (defaultOwnerId && !accounts.some((item) => item?.id === defaultOwnerId && isAssignableAccount(item, tenantId))) {
      response.status(400).json({ error: OWNER_REQUIRED })
      return null
    }
    return { conversationId: conversationId || null, defaultOwnerId: defaultOwnerId || null }
  }

  const readOutboundTarget = (body, response) => {
    const url = String(body?.url ?? '').trim()
    const violation = webhookUrlViolation(url)
    if (violation) { response.status(400).json({ error: { code: violation, message: WEBHOOK_URL_MESSAGES[violation] } }); return null }
    const requested = Array.isArray(body?.events) ? body.events.map(String) : []
    if (requested.some((id) => !WEBHOOK_EVENT_IDS.includes(id))) {
      response.status(400).json({ error: { code: 'WEBHOOK_EVENTS_INVALID', message: '보낼 사건 중 알 수 없는 것이 있습니다.' } })
      return null
    }
    return { url, events: [...new Set(requested)] }
  }

  const readLabel = (body, response) => {
    const label = clean(body?.label, MAX_ENDPOINT_LABEL)
    if (!label) {
      response.status(400).json({ error: { code: 'WEBHOOK_LABEL_INVALID', message: `이름은 1~${MAX_ENDPOINT_LABEL}자로 적어 주세요.` } })
      return null
    }
    return label
  }

  app.post('/api/webhooks', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const direction = String(request.body?.direction ?? '')
    if (!WEBHOOK_DIRECTIONS.has(direction)) {
      response.status(400).json({ error: { code: 'WEBHOOK_DIRECTION_INVALID', message: '받기와 보내기 중 하나를 골라 주세요.' } })
      return
    }
    // 서명키를 봉인할 수 없으면 보내는 주소를 아예 만들지 않는다 — 서명 없는 발신은 만들지 않는다.
    if (direction === 'outbound' && !secretBox?.available) {
      response.status(503).json({ error: secretBox?.unavailable ?? { code: 'SECRET_BOX_UNAVAILABLE', message: '서명 비밀값을 보관할 수 없습니다.' } })
      return
    }
    const label = readLabel(request.body, response)
    if (!label) return
    const target = direction === 'outbound'
      ? readOutboundTarget(request.body, response)
      : readInboundTarget(request.auth.tenantId, request.body, response)
    if (!target) return
    const rows = readableEndpoints(request.auth.tenantId, response)
    if (!rows) return
    if (rows.length >= MAX_ENDPOINTS_PER_TENANT) {
      response.status(409).json({ error: { code: 'WEBHOOK_ENDPOINT_CAPACITY_REACHED', message: `외부 연동은 ${MAX_ENDPOINTS_PER_TENANT}개까지 둘 수 있습니다.` } })
      return
    }
    const now = nowIso()
    const endpoint = {
      id: newEndpointId(),
      direction,
      label,
      conversationId: direction === 'inbound' ? target.conversationId : null,
      defaultOwnerId: direction === 'inbound' ? target.defaultOwnerId : null,
      tokenHash: null,
      tokenIssuedAt: null,
      url: direction === 'outbound' ? target.url : null,
      events: direction === 'outbound' ? target.events : [],
      signingSecretEnc: null,
      enabled: request.body?.enabled !== false,
      consecutiveFailures: 0,
      disabledAt: null,
      createdById: request.auth.id,
      createdAt: now,
      updatedAt: now,
      lastDeliveredAt: null,
      lastReceivedAt: null,
      receivedCount: 0,
    }
    // 보내는 주소는 만들어질 때 서명키를 함께 갖는다. 나중에 발급하는 길만 두면 '서명 없는 엔드포인트'가
    // 존재할 수 있는 시간이 생기고, 그 시간에 나간 요청은 받는 쪽이 검증할 수 없다.
    // 평문은 이 응답에서 딱 한 번 나간다 — 내려보내지 않으면 받는 쪽은 열쇠를 가진 적이 없고,
    // 첫 배달부터 검증할 수 없는 서명이 붙는다(같은 실패의 다른 얼굴이다).
    let secret = null
    if (direction === 'outbound') {
      secret = randomBytes(32).toString('base64url')
      // seal이 null을 주는 경우는 키가 없을 때 하나뿐이고, 그것은 위의 available 문이 이미 503으로
      // 돌려보냈다. 여기서 한 번 더 보면 절대 실행되지 않는 줄이 된다 — 봉투가 이상한 모양이면
      // 바로 아래 hasEndpointShape가 SEALED_PATTERN으로 잡아 저장 전에 500으로 멈춘다.
      endpoint.signingSecretEnc = secretBox.seal(secret, { aad: endpoint.id })
    }
    if (!hasEndpointShape(endpoint)) { response.status(500).json({ error: WRITE_FAILED }); return }
    if (!await writeEndpoints(request.auth.tenantId, [endpoint, ...rows], request.auth.id, response,
      () => audit(request, '외부 연동 추가', endpoint))) return
    response.status(201).json({ endpoint: safeEndpoint(endpoint), ...(secret ? { secret } : {}) })
  })

  app.patch('/api/webhooks/:id', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const found = locate(request, response)
    if (!found) return
    const { tenantId, rows, endpoint } = found
    if (request.body?.direction !== undefined && request.body.direction !== endpoint.direction) {
      response.status(400).json({ error: { code: 'WEBHOOK_DIRECTION_IMMUTABLE', message: '연동 방향은 바꿀 수 없습니다. 새 연동을 만들어 주세요.' } })
      return
    }
    const has = (field) => Object.prototype.hasOwnProperty.call(request.body ?? {}, field)
    const next = { ...endpoint }
    if (has('label')) {
      const label = readLabel(request.body, response)
      if (!label) return
      next.label = label
    }
    if (endpoint.direction === 'outbound') {
      if (has('url') || has('events')) {
        const target = readOutboundTarget({
          url: has('url') ? request.body.url : endpoint.url,
          events: has('events') ? request.body.events : endpoint.events,
        }, response)
        if (!target) return
        next.url = target.url
        next.events = target.events
      }
    } else if (has('conversationId') || has('defaultOwnerId')) {
      const submitted = has('conversationId') ? String(request.body.conversationId ?? '').trim() : (endpoint.conversationId ?? '')
      const ownerSubmitted = has('defaultOwnerId') ? String(request.body.defaultOwnerId ?? '').trim() : (endpoint.defaultOwnerId ?? '')
      // 바뀌지 않은 값은 다시 검사하지 않는다. **채널과 기본 담당자 두 값 모두에 같은 규칙이다.**
      //
      // 화면의 [저장]은 늘 두 값을 함께 보낸다. 그래서 그 채널이 보관되거나 그 담당자가 비활성이 되면,
      // 이름만 고치는 저장도 이 연동을 끄는 저장도 404/400이 되어 — 가장 안전한 수습(끄기)이 막힌다.
      // 한쪽에만 두면 다른 쪽이 그대로 같은 덫이다(담당자 비활성이 실제로 그랬다).
      // 남겨 두어 열리는 문은 없다: 수신 라우트가 살아 있지 않은 대화를 409로, 배정할 수 없는 담당자를
      // isAssignableAccount로 매 배달마다 다시 거절하므로, 검사를 미룬 값으로는 아무것도 도착하지 않는다.
      const unchanged = submitted === (endpoint.conversationId ?? '')
      const ownerUnchanged = ownerSubmitted === (endpoint.defaultOwnerId ?? '')
      const target = readInboundTarget(tenantId, {
        conversationId: unchanged ? '' : submitted,
        defaultOwnerId: ownerUnchanged ? '' : ownerSubmitted,
      }, response)
      if (!target) return
      next.conversationId = unchanged ? endpoint.conversationId : target.conversationId
      next.defaultOwnerId = ownerUnchanged ? (endpoint.defaultOwnerId ?? null) : target.defaultOwnerId
    }
    if (has('enabled')) {
      next.enabled = request.body.enabled === true
      // 다시 켜면 실패 이력을 지운다. 지우지 않으면 다음 한 번의 실패로 곧장 다시 꺼진다.
      if (next.enabled) { next.consecutiveFailures = 0; next.disabledAt = null }
    }
    next.updatedAt = nowIso()
    if (!hasEndpointShape(next)) { response.status(500).json({ error: WRITE_FAILED }); return }
    if (!await writeEndpoints(tenantId, rows.map((item) => (item.id === next.id ? next : item)), request.auth.id, response,
      () => audit(request, '외부 연동 변경', next))) return
    response.json({ endpoint: safeEndpoint(next) })
  })

  app.delete('/api/webhooks/:id', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const found = locate(request, response)
    if (!found) return
    const { tenantId, rows, endpoint } = found
    const { rows: deliveries, dropped } = deliveriesOf(tenantId)
    if (dropped > 0) { response.status(409).json({ error: DATA_INVALID }); return }
    const at = nowIso()
    // 지운 주소로 가는 행은 끝나지 않은 것 **전부**를 닫는다. 'pending'만 닫으면, 관리자가 지우는
    // 시점에 대개 'failed'인(그래서 지우는) 행들이 살아남아 영영 열 수 없는 봉투로 남고,
    // 화면은 그 행에 '다시 보내기'를 계속 그린다.
    const nextDeliveries = deliveries.map((row) => (row.endpointId === endpoint.id
      && row.status !== 'delivered' && row.status !== 'gave-up'
      ? { ...row, status: 'gave-up', nextAttemptAt: null, lastError: '연동이 삭제되어 보내지 않았습니다.' }
      : row))
    const tenantStore = tenantStoreOf(tenantId)
    const previousDeliveries = tenantStore[WEBHOOK_DELIVERIES_KEY]
    tenantStore[WEBHOOK_DELIVERIES_KEY] = { data: nextDeliveries, updatedAt: at, updatedBy: request.auth.id }
    if (!await writeEndpoints(tenantId, rows.filter((item) => item.id !== endpoint.id), request.auth.id, response,
      () => audit(request, '외부 연동 삭제', endpoint))) {
      if (previousDeliveries) tenantStore[WEBHOOK_DELIVERIES_KEY] = previousDeliveries
      else delete tenantStore[WEBHOOK_DELIVERIES_KEY]
      return
    }
    response.status(204).end()
  })

  app.post('/api/webhooks/:id/token', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const found = locate(request, response)
    if (!found) return
    const { tenantId, rows, endpoint } = found
    if (endpoint.direction !== 'inbound') {
      response.status(400).json({ error: { code: 'WEBHOOK_DIRECTION_IMMUTABLE', message: '받는 연동에만 수신 토큰을 발급합니다.' } })
      return
    }
    const token = randomBytes(32).toString('base64url')
    const at = nowIso()
    // 사용 스위치는 건드리지 않는다. 발급이 조용히 켜 버리면, 대화상자의 '사용' 체크는 열 때 담아 둔
    // 값 그대로 꺼져 있어 그다음 [저장]이 다시 끄고 — 관리자는 두 번 다 부탁한 적이 없는 변경을 받는다.
    const next = { ...endpoint, tokenHash: tokenDigest(token), tokenIssuedAt: at, updatedAt: at }
    if (!hasEndpointShape(next)) { response.status(500).json({ error: WRITE_FAILED }); return }
    if (!await writeEndpoints(tenantId, rows.map((item) => (item.id === next.id ? next : item)), request.auth.id, response,
      () => audit(request, endpoint.tokenHash ? '수신 웹훅 토큰 회전' : '수신 웹훅 토큰 발급', next))) return
    // 평문은 이 응답에서 딱 한 번 나간다. 저장되는 것은 해시뿐이다.
    response.status(201).json({ token, hookUrl: hookUrlFor(request, token), endpoint: safeEndpoint(next) })
  })

  app.delete('/api/webhooks/:id/token', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const found = locate(request, response)
    if (!found) return
    const { tenantId, rows, endpoint } = found
    const at = nowIso()
    // disabledAt은 '연속 실패로 스스로 멈췄다'는 뜻이다. 사람이 회수한 토큰에 그 자국을 찍으면
    // 화면이 '중지됨 · 연속 실패 0회'라고, 일어나지도 않은 원인을 말한다. 여기서는 끄기만 한다 —
    // 이유는 목록의 '· 토큰 없음'이 이미 말한다.
    const next = { ...endpoint, tokenHash: null, tokenIssuedAt: null, enabled: false, disabledAt: null, updatedAt: at }
    if (!hasEndpointShape(next)) { response.status(500).json({ error: WRITE_FAILED }); return }
    if (!await writeEndpoints(tenantId, rows.map((item) => (item.id === next.id ? next : item)), request.auth.id, response,
      () => audit(request, '수신 웹훅 토큰 회수', next))) return
    response.json({ endpoint: safeEndpoint(next) })
  })

  app.post('/api/webhooks/:id/secret', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const found = locate(request, response)
    if (!found) return
    const { tenantId, rows, endpoint } = found
    if (endpoint.direction !== 'outbound') {
      response.status(400).json({ error: { code: 'WEBHOOK_DIRECTION_IMMUTABLE', message: '보내는 연동에만 서명 비밀키가 있습니다.' } })
      return
    }
    if (!secretBox?.available) { response.status(503).json({ error: secretBox?.unavailable ?? { code: 'SECRET_BOX_UNAVAILABLE', message: '서명 비밀값을 보관할 수 없습니다.' } }); return }
    const secret = randomBytes(32).toString('base64url')
    // 만들기와 같은 이유로 seal의 null을 다시 보지 않는다 — 바로 위 available 문이 그 유일한 경우다.
    const sealed = secretBox.seal(secret, { aad: endpoint.id })
    const at = nowIso()
    const next = { ...endpoint, signingSecretEnc: sealed, updatedAt: at }
    if (!hasEndpointShape(next)) { response.status(500).json({ error: WRITE_FAILED }); return }
    if (!await writeEndpoints(tenantId, rows.map((item) => (item.id === next.id ? next : item)), request.auth.id, response,
      () => audit(request, '발신 웹훅 서명키 재발급', next))) return
    response.status(201).json({ secret, endpoint: safeEndpoint(next) })
  })

  app.post('/api/webhooks/:id/test', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const found = locate(request, response)
    if (!found) return
    const { tenantId, endpoint } = found
    if (endpoint.direction !== 'outbound') {
      response.status(400).json({ error: { code: 'WEBHOOK_DIRECTION_IMMUTABLE', message: '보내는 연동에만 테스트를 보낼 수 있습니다.' } })
      return
    }
    // 꺼진 연동은 드레인이 집지 않는다. 그대로 적재하면 화면에는 '대기 · 사유 없음'만 남는다 —
    // 사유가 있어야 할 자리에 만든 가짜 상태다.
    if (!endpoint.enabled || endpoint.disabledAt) { response.status(409).json({ error: ENDPOINT_DISABLED }); return }
    const tenantStore = tenantStoreOf(tenantId)
    const previousDeliveries = tenantStore[WEBHOOK_DELIVERIES_KEY]
    const queued = dispatch.queueTestDelivery(tenantId, endpoint)
    if (!queued) { response.status(409).json({ error: DATA_INVALID }); return }
    try { await commitWorkspaceStore() } catch {
      // 적재는 메모리를 이미 바꿨다. 되돌리지 않으면 '보내지 못했습니다'라고 답한 요청의 행이
      // 그대로 남아 다음 커밋에 실려 가고, 몇 분 뒤 쓸기가 그 요청을 실제로 바깥으로 보낸다.
      if (previousDeliveries) tenantStore[WEBHOOK_DELIVERIES_KEY] = previousDeliveries
      else delete tenantStore[WEBHOOK_DELIVERIES_KEY]
      response.status(500).json({ error: WRITE_FAILED })
      return
    }
    await dispatch.drainWebhookDeliveries(tenantId)
    const row = deliveriesOf(tenantId).rows.find((item) => item.id === queued.id) ?? queued
    // 아직 'pending'이면 이 요청이 보낸 것이 아니다 — 같은 고객사의 드레인이 이미 돌고 있어
    // 다음 판으로 넘어갔거나(coalesce) 한 판의 상한에 밀렸다. 그 행을 그대로 내려보내면 화면은
    // '대기 · 사유 없음'을 그린다. 사유가 있어야 할 자리에 만든 가짜 상태다 — 사실대로 '보내는 중'이라 말한다.
    response.status(201).json({ delivery: safeDelivery(row), ...(row.status === 'pending' ? { queued: true } : {}) })
  })

  app.post('/api/webhooks/deliveries/:id/retry', ...guards, async (request, response) => {
    if (!requireTenant(request, response)) return
    const tenantId = request.auth.tenantId
    const { rows, dropped } = deliveriesOf(tenantId)
    if (dropped > 0) { response.status(409).json({ error: DATA_INVALID }); return }
    const row = rows.find((item) => item.id === request.params.id)
    if (!row) { response.status(404).json({ error: DELIVERY_NOT_FOUND }); return }
    // 이미 도착한 사건을 한 번 더 보내지 않는다.
    if (row.status === 'delivered') { response.status(409).json({ error: DELIVERY_ALREADY_SENT }); return }
    // 보낼 곳이 없으면 'pending'으로 되돌리지 않는다. 드레인의 due 조건이 살아 있는 엔드포인트만
    // 집으므로, 그렇게 쓴 행은 영영 대기 상태로 남고 lastError까지 지워져 왜 실패했는지도 사라진다.
    if (row.channel === 'webhook') {
      const endpoints = readableEndpoints(tenantId, response)
      if (!endpoints) return
      const target = endpoints.find((item) => item.id === row.endpointId)
      if (!target || !target.enabled || target.disabledAt) { response.status(409).json({ error: ENDPOINT_DISABLED }); return }
    }
    const at = nowIso()
    // 사람이 누른 다시 보내기는 새 시도다. 자동 재시도용 백오프 사다리의 횟수를 물려받으면
    // 몇 번 누르는 것만으로 저장 상한(50)을 넘겨 그 행이 shape 게이트에 걸린다.
    const next = { ...row, status: 'pending', attempts: 0, nextAttemptAt: at, lastError: null }
    if (!hasDeliveryShape(next)) { response.status(500).json({ error: WRITE_FAILED }); return }
    const tenantStore = tenantStoreOf(tenantId)
    const previous = tenantStore[WEBHOOK_DELIVERIES_KEY]
    tenantStore[WEBHOOK_DELIVERIES_KEY] = { data: rows.map((item) => (item.id === next.id ? next : item)), updatedAt: at, updatedBy: request.auth.id }
    try { await commitWorkspaceStore() } catch {
      if (previous) tenantStore[WEBHOOK_DELIVERIES_KEY] = previous
      else delete tenantStore[WEBHOOK_DELIVERIES_KEY]
      response.status(500).json({ error: WRITE_FAILED })
      return
    }
    await dispatch.drainWebhookDeliveries(tenantId)
    const sent = deliveriesOf(tenantId).rows.find((item) => item.id === next.id) ?? next
    response.json({ delivery: safeDelivery(sent) })
  })
}

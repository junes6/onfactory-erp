import { createECDH, createHmac, createCipheriv, createPrivateKey, generateKeyPairSync, randomBytes, sign as signBuffer } from 'node:crypto'

/**
 * 웹푸시 발송 — RFC 8291(메시지 암호화) + RFC 8292(VAPID)를 node:crypto로 직접 구현한다.
 *
 * 외부 라이브러리를 넣지 않은 이유: 푸시 본문은 업무 제목·담당자 이름을 담는 고객사 데이터이고,
 * 그 값이 지나가는 경로는 우리가 읽을 수 있어야 한다. 구현은 RFC의 시험 벡터로 검증한다.
 *
 * 브라우저(푸시 서비스)로 보내는 것은 암호문뿐이며, 서버 개인키는 절대 응답에 실리지 않는다.
 */

const CURVE = 'prime256v1'
/** 푸시 서비스가 요구하는 고정 레코드 크기. 본문은 이보다 작아야 한다. */
export const RECORD_SIZE = 4096
export const MAX_PAYLOAD_BYTES = RECORD_SIZE - 103

export const b64url = (buffer) => Buffer.from(buffer).toString('base64url')
export const fromB64url = (value) => Buffer.from(String(value ?? ''), 'base64url')

const hmac = (key, ...parts) => {
  const mac = createHmac('sha256', key)
  for (const part of parts) mac.update(part)
  return mac.digest()
}

/** HKDF(RFC 5869) — 웹푸시는 언제나 32바이트 salt/PRK에 1블록만 뽑는다. */
const hkdf = (salt, ikm, info, length) => hmac(hmac(salt, ikm), info, Buffer.from([1])).subarray(0, length)

/** 서버 신원 키 한 쌍. 한 번 만들어 환경변수에 넣고 계속 쓴다. */
export function generateVapidKeys() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: CURVE })
  const jwk = privateKey.export({ format: 'jwk' })
  const point = Buffer.concat([Buffer.from([4]), fromB64url(jwk.x), fromB64url(jwk.y)])
  return {
    publicKey: b64url(point),
    privateKey: b64url(fromB64url(jwk.d)),
    // 공개키는 브라우저 구독에 그대로 쓰이므로 확인용으로 형식을 함께 남긴다.
    publicKeyBytes: point.length,
    createdFrom: publicKey.asymmetricKeyType,
  }
}

/** 비압축 EC 점(65바이트) → JWK. 개인키 스칼라(32바이트)가 있으면 개인키로 만든다. */
function jwkFromRaw(publicPoint, privateScalar = null) {
  if (publicPoint.length !== 65 || publicPoint[0] !== 4) throw new Error('P-256 공개키는 비압축 65바이트여야 합니다.')
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: b64url(publicPoint.subarray(1, 33)),
    y: b64url(publicPoint.subarray(33, 65)),
  }
  return privateScalar ? { ...jwk, d: b64url(privateScalar) } : jwk
}

/**
 * VAPID 인증 헤더. 푸시 서비스에 "이 서버가 보냈다"를 증명한다.
 * audience는 엔드포인트의 오리진이고, 만료는 12시간을 넘기지 않는다.
 */
export function vapidAuthorization({ endpoint, subject, publicKey, privateKey, now = new Date(), expiresInSeconds = 12 * 60 * 60 }) {
  const audience = new URL(endpoint).origin
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64url(Buffer.from(JSON.stringify({
    aud: audience,
    exp: Math.floor(now.getTime() / 1_000) + Math.min(expiresInSeconds, 24 * 60 * 60),
    sub: subject,
  })))
  const signingInput = Buffer.from(`${header}.${claims}`)
  const point = fromB64url(publicKey)
  const key = createPrivateKey({ key: jwkFromRaw(point, fromB64url(privateKey)), format: 'jwk' })
  // ES256은 DER이 아니라 r||s 원시 형식(P1363)이다.
  const signature = signBuffer('sha256', signingInput, { key, dsaEncoding: 'ieee-p1363' })
  return { authorization: `vapid t=${header}.${claims}.${b64url(signature)}, k=${publicKey}`, audience }
}

/**
 * RFC 8291 aes128gcm 본문 생성.
 * 반환값은 푸시 서비스에 그대로 보낼 바이트열이다: salt(16) | rs(4) | idlen(1) | 발신 공개키(65) | 암호문
 */
export function encryptPayload({ payload, userPublicKey, userAuth, salt = randomBytes(16), senderKeys = null }) {
  const plaintext = Buffer.from(String(payload), 'utf8')
  if (plaintext.length > MAX_PAYLOAD_BYTES) throw new Error(`푸시 본문은 ${MAX_PAYLOAD_BYTES}바이트를 넘을 수 없습니다.`)
  const uaPublic = fromB64url(userPublicKey)
  // 형식은 ECDH에 넣기 전에 본다. OpenSSL 오류를 그대로 흘리면 원인을 알 수 없다.
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('구독 p256dh는 비압축 65바이트여야 합니다.')
  const authSecret = fromB64url(userAuth)
  if (authSecret.length !== 16) throw new Error('구독 auth 값은 16바이트여야 합니다.')

  const ecdh = createECDH(CURVE)
  if (senderKeys) ecdh.setPrivateKey(fromB64url(senderKeys.privateKey))
  else ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey()
  const sharedSecret = ecdh.computeSecret(uaPublic)

  // 인증 비밀로 한 번 늘린 뒤(IKM), salt로 다시 늘려 키와 nonce를 뽑는다.
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic])
  const ikm = hkdf(authSecret, sharedSecret, keyInfo, 32)
  const contentEncryptionKey = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16)
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12)

  const cipher = createCipheriv('aes-128-gcm', contentEncryptionKey, nonce)
  // 0x02는 "마지막 레코드"를 뜻하는 패딩 구분자다.
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])

  const recordSize = Buffer.alloc(4)
  recordSize.writeUInt32BE(RECORD_SIZE, 0)
  return Buffer.concat([salt, recordSize, Buffer.from([asPublic.length]), asPublic, ciphertext])
}

/** 구독 레코드가 발송에 쓸 수 있는 모양인가. */
export function isSendableSubscription(subscription) {
  try {
    if (!subscription?.endpoint || !/^https:\/\//i.test(subscription.endpoint)) return false
    new URL(subscription.endpoint)
    return fromB64url(subscription.keys?.p256dh).length === 65 && fromB64url(subscription.keys?.auth).length === 16
  } catch { return false }
}

/** 410/404는 구독이 사라진 것이므로 저장소에서 지워야 한다. 429/5xx는 나중에 다시 시도한다. */
export function classifyPushResponse(status) {
  if (status >= 200 && status < 300) return 'delivered'
  if (status === 404 || status === 410) return 'expired'
  if (status === 429 || status >= 500) return 'retry'
  return 'failed'
}

export function vapidSettings(env = process.env) {
  const publicKey = String(env.VAPID_PUBLIC_KEY ?? '').trim()
  const privateKey = String(env.VAPID_PRIVATE_KEY ?? '').trim()
  const subject = String(env.VAPID_SUBJECT ?? '').trim()
  const configured = Boolean(publicKey && privateKey && subject)
  return { configured, publicKey, privateKey, subject: subject || 'mailto:ops@inthefield.local' }
}

/**
 * 한 구독에 한 건 발송. 네트워크 오류도 예외로 던지지 않고 분류해 돌려준다 —
 * 한 기기의 실패가 나머지 기기 발송을 막아서는 안 된다.
 */
export async function sendPush(subscription, payload, { vapid, ttlSeconds = 12 * 60 * 60, fetchImpl = globalThis.fetch, now = new Date(), urgency = 'normal' } = {}) {
  if (!isSendableSubscription(subscription)) return { outcome: 'failed', reason: '구독 형식이 올바르지 않습니다.' }
  if (!vapid?.configured) return { outcome: 'skipped', reason: 'VAPID 키가 설정되지 않았습니다.' }
  let body
  let authorization
  try {
    body = encryptPayload({ payload, userPublicKey: subscription.keys.p256dh, userAuth: subscription.keys.auth })
    authorization = vapidAuthorization({ endpoint: subscription.endpoint, subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey, now }).authorization
  } catch (error) {
    return { outcome: 'failed', reason: String(error?.message ?? error) }
  }
  try {
    const response = await fetchImpl(subscription.endpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(ttlSeconds),
        urgency,
      },
      body,
    })
    return { outcome: classifyPushResponse(response.status), status: response.status }
  } catch (error) {
    return { outcome: 'retry', reason: String(error?.message ?? error) }
  }
}

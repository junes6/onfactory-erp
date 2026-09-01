import assert from 'node:assert/strict'
import test from 'node:test'

import {
  b64url,
  classifyPushResponse,
  encryptPayload,
  fromB64url,
  generateVapidKeys,
  isSendableSubscription,
  MAX_PAYLOAD_BYTES,
  sendPush,
  vapidAuthorization,
  vapidSettings,
} from './web-push.mjs'

/**
 * RFC 8291 §5의 공개 시험 벡터.
 * 이 값이 맞으면 키 유도·nonce·AES-GCM·헤더 조립이 규격대로라는 뜻이다.
 */
const RFC8291 = {
  plaintext: 'When I grow up, I want to be a watermelon',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

test('payload encryption matches the RFC 8291 published vector', () => {
  const body = encryptPayload({
    payload: RFC8291.plaintext,
    userPublicKey: RFC8291.uaPublic,
    userAuth: RFC8291.authSecret,
    salt: fromB64url(RFC8291.salt),
    senderKeys: { privateKey: RFC8291.asPrivate, publicKey: RFC8291.asPublic },
  })
  assert.equal(b64url(body), RFC8291.body)

  // 헤더 부분을 따로 확인한다: salt(16) | rs(4)=4096 | idlen(1)=65 | 발신 공개키(65)
  assert.equal(b64url(body.subarray(0, 16)), RFC8291.salt)
  assert.equal(body.readUInt32BE(16), 4096)
  assert.equal(body[20], 65)
  assert.equal(b64url(body.subarray(21, 86)), RFC8291.asPublic)
})

test('each send uses a fresh ephemeral key and salt, so two identical messages differ', () => {
  const options = { payload: '같은 문장', userPublicKey: RFC8291.uaPublic, userAuth: RFC8291.authSecret }
  const first = encryptPayload(options)
  const second = encryptPayload(options)
  assert.notEqual(b64url(first), b64url(second), '같은 본문이라도 암호문이 같으면 안 된다')
  assert.equal(first.length, second.length)
})

test('malformed subscription material is rejected before anything is sent', () => {
  assert.throws(() => encryptPayload({ payload: 'x', userPublicKey: RFC8291.uaPublic, userAuth: b64url(Buffer.alloc(8)) }), /auth 값은 16바이트/)
  assert.throws(() => encryptPayload({ payload: 'x', userPublicKey: b64url(Buffer.alloc(10)), userAuth: RFC8291.authSecret }), /비압축 65바이트/)
  assert.throws(() => encryptPayload({ payload: 'ㄱ'.repeat(MAX_PAYLOAD_BYTES), userPublicKey: RFC8291.uaPublic, userAuth: RFC8291.authSecret }), /바이트를 넘을 수 없습니다/)
})

test('a subscription is only sendable when both keys have the right shape', () => {
  const valid = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret } }
  assert.equal(isSendableSubscription(valid), true)
  assert.equal(isSendableSubscription({ ...valid, endpoint: 'http://insecure.example/x' }), false, 'https만 허용한다')
  assert.equal(isSendableSubscription({ ...valid, keys: { ...valid.keys, auth: b64url(Buffer.alloc(8)) } }), false)
  assert.equal(isSendableSubscription({ endpoint: valid.endpoint }), false)
  assert.equal(isSendableSubscription(null), false)
})

test('VAPID keys round-trip into a signed ES256 header bound to the endpoint origin', () => {
  const keys = generateVapidKeys()
  assert.equal(fromB64url(keys.publicKey).length, 65)
  assert.equal(fromB64url(keys.privateKey).length, 32)

  const { authorization, audience } = vapidAuthorization({
    endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/abc123',
    subject: 'mailto:ops@example.com',
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    now: new Date('2026-09-01T00:00:00.000Z'),
  })
  assert.equal(audience, 'https://updates.push.services.mozilla.com')
  const [, token] = authorization.match(/^vapid t=([^,]+), k=(.+)$/) ?? []
  assert.ok(token, 'Authorization 형식이 vapid t=..., k=... 이어야 한다')
  assert.ok(authorization.endsWith(`k=${keys.publicKey}`))

  const [header, claims, signature] = token.split('.')
  assert.deepEqual(JSON.parse(fromB64url(header).toString()), { typ: 'JWT', alg: 'ES256' })
  const payload = JSON.parse(fromB64url(claims).toString())
  assert.equal(payload.aud, 'https://updates.push.services.mozilla.com')
  assert.equal(payload.sub, 'mailto:ops@example.com')
  assert.equal(payload.exp, Math.floor(Date.parse('2026-09-01T00:00:00.000Z') / 1000) + 12 * 60 * 60)
  assert.equal(fromB64url(signature).length, 64, 'ES256 서명은 r||s 64바이트다')
})

test('response codes decide whether to keep, drop or retry a subscription', () => {
  assert.equal(classifyPushResponse(201), 'delivered')
  assert.equal(classifyPushResponse(200), 'delivered')
  assert.equal(classifyPushResponse(410), 'expired', '구독이 사라졌으면 저장소에서 지운다')
  assert.equal(classifyPushResponse(404), 'expired')
  assert.equal(classifyPushResponse(429), 'retry')
  assert.equal(classifyPushResponse(503), 'retry')
  assert.equal(classifyPushResponse(400), 'failed')
})

test('sending posts an encrypted body with the required headers and never leaks the key', async () => {
  const keys = generateVapidKeys()
  const vapid = { configured: true, subject: 'mailto:ops@example.com', publicKey: keys.publicKey, privateKey: keys.privateKey }
  const subscription = { endpoint: 'https://push.example.com/s/1', keys: { p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret } }
  let captured = null
  const result = await sendPush(subscription, JSON.stringify({ title: '새 업무' }), {
    vapid,
    fetchImpl: async (url, init) => { captured = { url, init }; return { status: 201 } },
  })
  assert.deepEqual({ outcome: result.outcome, status: result.status }, { outcome: 'delivered', status: 201 })
  assert.equal(captured.url, subscription.endpoint)
  assert.equal(captured.init.headers['content-encoding'], 'aes128gcm')
  assert.equal(captured.init.headers.ttl, String(12 * 60 * 60))
  assert.ok(Buffer.isBuffer(captured.init.body))
  assert.equal(captured.init.body.readUInt32BE(16), 4096)
  // 평문도 개인키도 요청에 그대로 실리지 않는다.
  assert.doesNotMatch(captured.init.body.toString('utf8'), /새 업무/)
  assert.doesNotMatch(JSON.stringify(captured.init.headers), new RegExp(keys.privateKey))
})

test('a push failure is reported, not thrown, so one dead device cannot stop the rest', async () => {
  const keys = generateVapidKeys()
  const vapid = { configured: true, subject: 'mailto:ops@example.com', publicKey: keys.publicKey, privateKey: keys.privateKey }
  const subscription = { endpoint: 'https://push.example.com/s/1', keys: { p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret } }

  const network = await sendPush(subscription, 'x', { vapid, fetchImpl: async () => { throw new Error('연결 실패') } })
  assert.deepEqual({ outcome: network.outcome, reason: network.reason }, { outcome: 'retry', reason: '연결 실패' })

  const gone = await sendPush(subscription, 'x', { vapid, fetchImpl: async () => ({ status: 410 }) })
  assert.equal(gone.outcome, 'expired')

  const unconfigured = await sendPush(subscription, 'x', { vapid: { configured: false } })
  assert.equal(unconfigured.outcome, 'skipped')

  const broken = await sendPush({ endpoint: 'not-a-url' }, 'x', { vapid })
  assert.equal(broken.outcome, 'failed')
})

test('vapid settings read from the environment and report whether push can run at all', () => {
  assert.equal(vapidSettings({}).configured, false)
  const configured = vapidSettings({ VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'mailto:a@b.c' })
  assert.deepEqual(configured, { configured: true, publicKey: 'pub', privateKey: 'priv', subject: 'mailto:a@b.c' })
})

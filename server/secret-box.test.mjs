import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { SEALED_PATTERN, createSecretBox, generateSecretBoxKey } from './secret-box.mjs'

/**
 * 봉인 헬퍼 — "복원 가능하지만 저장소만으로는 못 읽는" 한 단계.
 *
 * 키는 테스트 안에서 만든다. 어떤 실제 키도 픽스처로 들어오지 않는다.
 * 지키는 것 셋:
 *  1. 키가 없거나 길이가 다르면 기능이 꺼진다(평문 폴백이 없다).
 *  2. 봉투는 매번 다르고, 한 비트라도 손대면 열리지 않는다 — throw가 아니라 null이다.
 *  3. AAD가 다르면 열리지 않는다 — A 엔드포인트의 봉투를 B 행에 붙여 넣을 수 없다.
 */

const quiet = { warn: () => {}, log: () => {}, error: () => {} }
const freshKey = () => randomBytes(32).toString('base64')
const boxWith = (key) => createSecretBox({ env: { SECRET_BOX_KEY: key }, logger: quiet })

test('키가 없으면 기능이 꺼지고, 평문으로 되돌아가지 않는다', () => {
  for (const key of ['', '   ', undefined]) {
    const box = createSecretBox({ env: key === undefined ? {} : { SECRET_BOX_KEY: key }, logger: quiet })
    assert.equal(box.available, false)
    assert.equal(box.seal('비밀', { aad: 'WHK-1' }), null, '키가 없으면 봉인 결과도 없다')
    assert.equal(box.open('v1:a:b:c', { aad: 'WHK-1' }), null)
    assert.equal(box.unavailable.code, 'SECRET_BOX_UNAVAILABLE')
  }
})

test('32바이트가 아닌 키는 조용히 늘리거나 자르지 않고 거절한다', () => {
  for (const bytes of [16, 31, 33, 64]) {
    const box = boxWith(randomBytes(bytes).toString('base64'))
    assert.equal(box.available, false, `${bytes}바이트 키는 쓰지 않는다`)
  }
  assert.equal(boxWith(randomBytes(32).toString('base64')).available, true)
  // base64가 아닌 문자열도 32바이트로 해석되지 않으면 거절이다.
  assert.equal(boxWith('not-a-key').available, false)
})

test('한글과 긴 문자열이 왕복하고, 봉투 형식은 네 토막이다', () => {
  const box = boxWith(freshKey())
  for (const plaintext of ['서명키-한글-비밀', 'x'.repeat(4_096), '{"a":1}']) {
    const sealed = box.seal(plaintext, { aad: 'WHK-1' })
    assert.match(sealed, SEALED_PATTERN, '봉투는 v1:iv:tag:body 네 토막이다')
    assert.equal(sealed.split(':').length, 4)
    assert.equal(box.open(sealed, { aad: 'WHK-1' }), plaintext)
  }
})

test('같은 평문을 두 번 봉인하면 결과가 다르다 — IV가 난수다', () => {
  const box = boxWith(freshKey())
  const first = box.seal('같은 비밀', { aad: 'WHK-1' })
  const second = box.seal('같은 비밀', { aad: 'WHK-1' })
  assert.notEqual(first, second)
  assert.equal(box.open(first, { aad: 'WHK-1' }), '같은 비밀')
  assert.equal(box.open(second, { aad: 'WHK-1' }), '같은 비밀')
})

test('변조·다른 키·다른 AAD는 전부 null이다(throw가 아니다)', () => {
  const key = freshKey()
  const box = boxWith(key)
  const sealed = box.seal('서명키', { aad: 'WHK-1' })

  // 태그 한 글자를 바꾼다.
  const parts = sealed.split(':')
  const tag = Buffer.from(parts[2], 'base64url')
  tag[0] ^= 0x01
  const tampered = [parts[0], parts[1], tag.toString('base64url'), parts[3]].join(':')
  assert.equal(box.open(tampered, { aad: 'WHK-1' }), null, '변조된 봉투는 열리지 않는다')

  // 다른 키로는 열리지 않는다(키를 잃으면 되살릴 길이 없다는 뜻이기도 하다).
  assert.equal(boxWith(freshKey()).open(sealed, { aad: 'WHK-1' }), null)

  // AAD가 다르면 열리지 않는다 — 저장소를 만질 수 있어도 봉투를 옮겨 붙일 수 없다.
  assert.equal(box.open(sealed, { aad: 'WHK-2' }), null)
  assert.equal(box.open(sealed, { aad: '' }), null)

  // 형식이 아예 다른 문자열도 예외 없이 null이다.
  for (const junk of ['', 'plaintext', 'v2:a:b:c', 'v1:a:b', null, 42]) {
    assert.equal(box.open(junk, { aad: 'WHK-1' }), null)
  }
})

test('봉인 결과에 평문 조각이 남지 않는다', () => {
  const box = boxWith(freshKey())
  const plaintext = 'SUPER-SECRET-SIGNING-KEY-0123456789'
  const sealed = box.seal(plaintext, { aad: 'WHK-1' })
  assert.ok(!sealed.includes(plaintext))
  for (const chunk of ['SUPER', 'SECRET', 'SIGNING', '0123456789']) {
    assert.ok(!sealed.includes(chunk), `봉투에 '${chunk}'가 보이면 안 된다`)
  }
})

test('generateSecretBoxKey는 .env.example이 시키는 그대로 쓸 수 있는 키를 만든다', () => {
  // .env.example의 '키 생성' 줄이 이 함수를 가리킨다. 가리키는 곳이 실제로 쓸 수 있는 값을
  // 내놓는지 재지 않으면, 운영자가 그 한 줄을 복사해 붙인 뒤에야 서버가 KEY_INVALID로 닫힌다.
  const generated = generateSecretBoxKey()
  assert.equal(Buffer.from(generated, 'base64').length, 32)
  // 부를 때마다 달라야 한다 — 상수를 돌려주는 '생성기'는 모든 설치가 같은 키를 쓰게 만든다.
  assert.notEqual(generated, generateSecretBoxKey())
  // 그리고 그 값으로 만든 상자는 실제로 열린다.
  const box = createSecretBox({ env: { SECRET_BOX_KEY: generated }, logger: { warn: () => {} } })
  assert.equal(box.available, true)
  assert.equal(box.open(box.seal('열려라', { aad: 'WHK-1' }), { aad: 'WHK-1' }), '열려라')
})

test('.env.example의 키 생성 한 줄이 실제 함수 이름을 가리킨다', () => {
  // 주석이 가리키는 곳이 없으면 그 주석은 다음 사람을 잘못된 길로 보낸다.
  const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8')
  assert.match(example, /generateSecretBoxKey/)
})

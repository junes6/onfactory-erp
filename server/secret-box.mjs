import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * 서버에 보관해야 하는 외부 비밀값을 봉인한다.
 *
 * 지금까지 이 저장소에 평문 비밀값은 0건이었다 — 비밀번호·초대 토큰·세션은 전부 sha256 해시다.
 * 그런데 발신 웹훅의 HMAC 서명키는 서명할 때 원문이 필요해 해시로 둘 수 없다. 그래서
 * "복원 가능하지만 저장소만으로는 못 읽는" 한 단계를 만든다 — 키는 env에만 있다.
 *
 * 키가 없으면 봉인 자체를 하지 않는다(available: false). 라우트는 503으로 거절하고,
 * 평문 폴백은 만들지 않는다 — '서명 없는 발신 웹훅'은 받는 쪽이 위조를 가려낼 길이 없는 물건이다.
 */

export const SECRET_BOX_VERSION = 'v1'
export const SECRET_BOX_KEY_BYTES = 32
export const SECRET_BOX_UNAVAILABLE = Object.freeze({
  code: 'SECRET_BOX_UNAVAILABLE',
  message: '서버에 SECRET_BOX_KEY(32바이트 base64)가 없어 서명 비밀값을 안전하게 보관할 수 없습니다. 서명 없는 발신 웹훅은 만들지 않습니다 — 운영자에게 키 설정을 요청해 주세요.',
})

/** 봉투 형식. shape 게이트가 '평문이 들어갈 수 없는 형태'로 이 정규식을 그대로 쓴다. */
export const SEALED_PATTERN = /^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/

export function createSecretBox({ env = process.env, logger = console } = {}) {
  const raw = String(env.SECRET_BOX_KEY ?? '').trim()
  let key = null
  if (raw) {
    // 길이가 다른 키는 조용히 자르지 않는다. 16바이트를 32바이트인 척 늘리면 그날부터
    // 봉인은 되는데 아무도 그 사실을 모른다.
    const decoded = Buffer.from(raw, 'base64')
    if (decoded.length === SECRET_BOX_KEY_BYTES) key = decoded
    else logger.warn?.(`[secret-box] SECRET_BOX_KEY가 ${SECRET_BOX_KEY_BYTES}바이트가 아닙니다(${decoded.length}) — 외부 비밀값 저장이 꺼졌습니다.`)
  } else {
    logger.warn?.('[secret-box] SECRET_BOX_KEY 없음 — 외부 비밀값 저장이 꺼졌습니다.')
  }

  return {
    available: Boolean(key),
    unavailable: SECRET_BOX_UNAVAILABLE,

    /**
     * 봉투에 엔드포인트 id를 AAD로 묶는다. 저장소를 만질 수 있는 상대가 A 엔드포인트의
     * 봉인된 서명키를 B 엔드포인트 행에 복사해 붙여도 열리지 않게 하기 위해서다.
     */
    seal(plaintext, { aad = '' } = {}) {
      if (!key) return null
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'))
      const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
      return [
        SECRET_BOX_VERSION,
        iv.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
        body.toString('base64url'),
      ].join(':')
    },

    open(sealed, { aad = '' } = {}) {
      if (!key || typeof sealed !== 'string') return null
      const parts = sealed.split(':')
      if (parts.length !== 4 || parts[0] !== SECRET_BOX_VERSION) return null
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64url'))
        if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'))
        decipher.setAuthTag(Buffer.from(parts[2], 'base64url'))
        return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8')
      } catch {
        // 키가 바뀌었거나 변조됐다 — 평문으로 되돌리지 않고 '못 연다'로 답한다.
        return null
      }
    },
  }
}

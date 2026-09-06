/**
 * 알림 채널 어댑터 슬롯 — 카카오 알림톡·이메일.
 *
 * **채널 목록은 이 파일 한 곳에서만 정한다.** 아래 NOTIFICATION_CHANNELS가 유일한 원본이고,
 * 나머지는 전부 여기서 파생된다 — 전달 기록의 shape 게이트(webhook-routes.mjs의 DELIVERY_CHANNELS),
 * 알림 설정의 기본값과 정규화(notifications.mjs), 알림 설정 표의 열(NotificationCenter.tsx는
 * 서버가 실어 보낸 목록을 그대로 돈다). 그래서 세 번째 채널은 이 배열에 한 줄과 그 아래 어댑터
 * 한 벌이면 끝난다 — 네 군데를 찾아다니며 같은 낱말을 다시 적을 일이 없다.
 *
 * 켜고 끄는 것은 환경변수 하나다(KAKAO_TRANSPORT · MAIL_TRANSPORT). notify()는 손대지 않는다:
 * 알림이 저장된 다음 queueChannelDeliveries가 이 어댑터에게 물어보고, 어댑터가 없으면 아무 행도
 * 만들지 않는다. 그래서 채널이 없는 배포는 '실패한 전달 기록'조차 쌓이지 않는다.
 *
 * 지금은 콘솔 구현만 둔다. 실제 발신자는 자격증명과 발신 프로필(알림톡 템플릿 승인, 발신 도메인)이
 * 정해진 뒤에 만든다 — 그 전에 만든 코드는 아무도 검증하지 못한다(mail-delivery.mjs와 같은 판단).
 *
 * 인터페이스: send(channel, { notification, recipient, tenantId }) → Promise<{ delivered, channel }>
 * 실패는 throw — 부르는 쪽(webhook-dispatch)이 재시도 대상으로 기록한다.
 */

/** id와 사람에게 보일 이름이 한 줄에 함께 있다 — 목록과 이름표가 따로 놀 자리를 만들지 않는다. */
export const NOTIFICATION_CHANNELS = Object.freeze([
  Object.freeze({ id: 'kakao', label: '알림톡' }),
  Object.freeze({ id: 'email', label: '메일' }),
])
export const NOTIFICATION_CHANNEL_IDS = Object.freeze(NOTIFICATION_CHANNELS.map((channel) => channel.id))
export const KAKAO_TRANSPORTS = Object.freeze(['console'])
export const NOTIFICATION_MAIL_TRANSPORTS = Object.freeze(['console'])

/** 화면과 전달 기록에 남는 '받는 곳'. 주소 전체를 남기지 않는다 — 기록은 증거지 주소록이 아니다. */
export function maskEmail(value) {
  const text = String(value ?? '').trim()
  const at = text.lastIndexOf('@')
  if (at <= 0) return text ? `${text.slice(0, 2)}***` : ''
  const name = text.slice(0, at)
  const domain = text.slice(at + 1)
  const head = name.slice(0, Math.min(2, name.length))
  return `${head}${'*'.repeat(Math.max(1, name.length - head.length))}@${domain}`
}

/** 알림톡은 전화번호로 나가지만 여기 남기는 것은 계정 id뿐이다(전화번호를 전달 기록에 쓰지 않는다). */
export const maskAccount = (accountId) => String(accountId ?? '').slice(0, 40)

export function createNotificationDelivery({ env = process.env, logger = console } = {}) {
  const adapters = new Map()

  const kakao = String(env.KAKAO_TRANSPORT ?? '').trim().toLowerCase()
  if (kakao) {
    if (kakao === 'console') {
      adapters.set('kakao', {
        transport: 'console',
        async send({ notification, recipient }) {
          logger.log?.(`[kakao:console] 알림톡 → ${recipient?.name ?? notification.recipientId}\n  ${notification.title}\n  ${notification.body}`)
          return { delivered: true, channel: 'kakao' }
        },
        target: (notification) => maskAccount(notification.recipientId),
      })
    } else {
      // 잘못 적힌 값으로 서버가 죽는 것보다, 경고를 남기고 그 채널만 꺼진 채 도는 편이 안전하다.
      logger.warn?.(`[notification-delivery] 지원하지 않는 KAKAO_TRANSPORT='${kakao}' — 알림톡 채널이 꺼집니다. (지원: ${KAKAO_TRANSPORTS.join(', ')})`)
    }
  }

  // 메일은 게스트 초대·비밀번호 재설정과 같은 환경변수를 쓴다 — 한 배포에 발신 수단이 둘이면
  // '메일이 왜 어떤 것만 나가는가'를 아무도 설명할 수 없다.
  const mail = String(env.MAIL_TRANSPORT ?? '').trim().toLowerCase()
  if (mail) {
    if (mail === 'console') {
      adapters.set('email', {
        transport: 'console',
        async send({ notification, recipient }) {
          logger.log?.(`[notify-mail:console] 알림 메일 → ${maskEmail(recipient?.email)}\n  ${notification.title}\n  ${notification.body}`)
          return { delivered: true, channel: 'email' }
        },
        target: (notification, recipient) => maskEmail(recipient?.email) || maskAccount(notification.recipientId),
      })
    } else {
      logger.warn?.(`[notification-delivery] 지원하지 않는 MAIL_TRANSPORT='${mail}' — 알림 메일 채널이 꺼집니다. (지원: ${NOTIFICATION_MAIL_TRANSPORTS.join(', ')})`)
    }
  }

  const configured = NOTIFICATION_CHANNELS.filter((channel) => adapters.has(channel.id))

  return {
    /** 설정된 채널의 id만. 적재(queueChannelDeliveries)가 도는 목록이다. */
    channels: configured.map((channel) => channel.id),
    /** 화면이 열을 그릴 목록. 이름표까지 서버가 실어 보낸다 — 화면이 같은 낱말을 따로 적지 않는다. */
    catalog: configured.map((channel) => ({ id: channel.id, label: channel.label })),
    has: (channel) => adapters.has(channel),
    transportOf: (channel) => adapters.get(channel)?.transport ?? null,
    /** 전달 기록에 남길 '받는 곳'. 채널마다 다르지만 어느 쪽도 원문 주소를 남기지 않는다. */
    targetFor(channel, notification, recipient) {
      const adapter = adapters.get(channel)
      return adapter ? String(adapter.target(notification, recipient) ?? '').slice(0, 120) : ''
    },
    async send(channel, payload) {
      const adapter = adapters.get(channel)
      if (!adapter) throw new Error(`설정되지 않은 알림 채널입니다: ${channel}`)
      return adapter.send(payload)
    },
  }
}

/**
 * 메일 발송 어댑터.
 *
 * 라우트는 이 인터페이스만 안다 — 발송 수단(콘솔·SMTP·SES)은 환경변수 MAIL_TRANSPORT로 고른다.
 * 어댑터가 없으면(null) 라우트는 링크를 응답에 실어 화면에서 복사하게 한다('link-only').
 * 초기 구현은 'console'(stdout 출력)만 있다. SMTP/SES는 자리만 남긴다 — 자격증명과 발신 도메인이
 * 정해지기 전에 코드를 만들면 그 코드는 아무도 검증하지 못한다.
 *
 * 시그니처:
 *   sendGuestInvitation({ email, name, tenantName, inviterName, orgName, projectNames, inviteUrl, expiresAt })
 *     → Promise<{ delivered: boolean, channel: string }>
 *   sendPasswordReset({ account, email, resetUrl, expiresAt }) → Promise<{ delivered, channel }>
 * 실패는 throw — 호출한 라우트가 'link-only'로 강등한다.
 */

export const MAIL_TRANSPORTS = Object.freeze(['console'])

const stamp = (value) => (value ? String(value).slice(0, 16).replace('T', ' ') : '—')

export function createMailDelivery({ env = process.env, logger = console } = {}) {
  const transport = String(env.MAIL_TRANSPORT ?? '').trim().toLowerCase()
  if (!transport) return null
  if (transport === 'console') {
    return {
      channel: 'console',
      async sendGuestInvitation({ email, name, tenantName, inviterName, orgName, projectNames = [], inviteUrl, expiresAt }) {
        logger.log?.(
          `[mail:console] 게스트 초대 → ${email}\n`
          + `  ${tenantName}의 ${inviterName}님이 ${name}님(${orgName})을 프로젝트에 초대했습니다.\n`
          + `  프로젝트: ${projectNames.join(', ') || '—'}\n`
          + `  링크: ${inviteUrl}\n`
          + `  만료: ${stamp(expiresAt)}`,
        )
        return { delivered: true, channel: 'console' }
      },
      async sendPasswordReset({ email, resetUrl, expiresAt }) {
        logger.log?.(`[mail:console] 비밀번호 재설정 → ${email}\n  링크: ${resetUrl}\n  만료: ${stamp(expiresAt)}`)
        return { delivered: true, channel: 'console' }
      },
    }
  }
  // smtp / ses: 아직 없음. 잘못 적힌 값으로 서버가 죽는 것보다, 경고를 남기고 링크 전달로 동작하는 편이 안전하다.
  logger.warn?.(`[mail] 지원하지 않는 MAIL_TRANSPORT='${transport}' — 초대 메일은 발송되지 않고 링크로 전달됩니다. (지원: ${MAIL_TRANSPORTS.join(', ')})`)
  return null
}

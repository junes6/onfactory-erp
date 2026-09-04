import { BRAND } from '../brand.mjs'

// 가입(테넌트 생성) 필수 동의 3항 — 본문은 placeholder, 버전은 문서 교체 시 올린다.
// 버전이 바뀌면 기존 테넌트 관리자에게 재동의를 요구한다(consentIsCurrent === false).
export const CONSENT_TERMS_VERSION = '2026-09-04.1'

export const CONSENT_ITEMS = Object.freeze([
  {
    id: 'dataAccess',
    title: '운영사의 데이터 접근·활용 범위',
    summary: '${BRAND.name} 운영사는 장애 대응·지원·서비스 개선을 위해 귀사 워크스페이스에 운영자 모드로 접속할 수 있으며, 모든 접속·조회·변경은 감사 기록으로 남아 귀사 관리자에게 공개됩니다.',
    body: '[placeholder] 제1조(목적) … 제2조(접근 범위) 운영사는 다음 경우에 한하여 고객사 데이터에 접근한다: 장애 복구, 고객 요청 지원, 보안 점검. 제3조(기록) 모든 접근은 시각·행위·운영자 신원과 함께 기록되며 고객사 관리자 화면에서 열람할 수 있다. 제4조(활용 한계) 운영사는 고객사 업무 원문을 제3자에게 제공하지 않는다. … (정식 약관 문서로 교체 예정)',
  },
  {
    id: 'privacyOutsourcing',
    title: '개인정보 처리위탁',
    summary: '귀사가 등록한 구성원·거래처의 개인정보는 서비스 제공 목적 범위에서 ${BRAND.name}가 위탁 처리하며, 위탁 범위·보관 기간·파기 절차는 약관을 따릅니다.',
    body: '[placeholder] 개인정보 처리위탁 계약 — 위탁 업무: 계정 관리, 메신저·일정·결재 데이터 저장, 파일 보관. 보관 기간: 계약 종료 후 30일. 재위탁: 클라우드 인프라 제공자에 한함. … (정식 문서로 교체 예정)',
  },
  {
    id: 'aiProcessing',
    title: 'AI 처리 사실',
    summary: '업무 문맥(문서명·메시지·업무 데이터)은 분류·요약·제안을 위해 AI 모델로 처리될 수 있습니다. AI 제안은 승인 큐에서 사람이 결정하기 전까지 실행되지 않습니다.',
    body: '[placeholder] AI 처리 고지 — 처리 목적: 문서 분류 제안, 업무 생성 제안, 성과 요약, 안전 점검 제안. 처리 주체: ${BRAND.name} 및 연동 AI 제공자. 거부권: 고객사 관리자는 AI 기능을 비활성화할 수 있다. … (정식 문서로 교체 예정)',
  },
  {
    // 감독 열람은 알림 없이 이루어진다. 알림이 없을수록 정책은 더 크게 공개돼야 한다 —
    // 열람 사실을 모른 채 쓰는 것과, 열람될 수 있음을 알고 쓰는 것은 완전히 다른 일이다.
    id: 'channelOversight',
    title: '업무 채널 감독 열람',
    summary: '업무용 채널과 그룹 대화방의 대화는 회사 관리자와 지정된 열람 권한자가 볼 수 있습니다. 1:1 개인 DM은 열람 대상이 아닙니다. 모든 열람은 열람자·대상 방·시각이 기록되어 회사 관리자 화면에서 확인할 수 있으며, 열람 시 대화 참여자에게 개별 알림은 가지 않습니다.',
    body: '[placeholder] 감독 열람 고지 — 대상: 업무용 채널(team)과 자유 생성 그룹방. 제외: 구성원 간 1:1 개인 대화(direct). 권한자: 고객사 관리자, 그리고 관리자가 계정별로 지정한 열람 권한자. 기록: 모든 열람 행위는 열람자 신원·대상 방·시각과 함께 감사 기록에 남으며 고객사 관리자 화면에서 조회할 수 있다. 권한 부여·회수 자체도 같은 기록에 남는다. 통지: 열람 시 해당 방 참여자에게 개별 알림은 발송되지 않으나, 본 정책은 가입 동의와 사내 이용 안내에 상시 공개된다. … (정식 문서로 교체 예정)',
  },
])

export const CONSENT_ITEM_IDS = Object.freeze(CONSENT_ITEMS.map((item) => item.id))

export function consentIsCurrent(consent) {
  if (!consent || consent.version !== CONSENT_TERMS_VERSION || !Array.isArray(consent.items)) return false
  return CONSENT_ITEM_IDS.every((id) => consent.items.some((item) => item?.id === id && item.agreed === true))
}

/** 요청 본문의 동의 입력을 검증해 저장 형태로 만든다. 하나라도 빠지면 null. */
export function buildConsentRecord(input, agreedBy, now = new Date()) {
  const accepted = input && typeof input === 'object' ? input : {}
  const items = CONSENT_ITEMS.map((item) => ({ id: item.id, title: item.title, agreed: accepted[item.id] === true }))
  if (!items.every((item) => item.agreed)) return null
  return {
    version: CONSENT_TERMS_VERSION,
    agreedAt: now.toISOString(),
    agreedBy: { id: agreedBy?.id ?? '', name: agreedBy?.name ?? '', email: agreedBy?.email ?? '' },
    items,
  }
}

export function publicConsentTerms() {
  return { version: CONSENT_TERMS_VERSION, items: CONSENT_ITEMS.map((item) => ({ ...item })) }
}

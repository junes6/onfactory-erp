/**
 * 자료의 'AI 처리 수준' — 보관만 · 정리 · 활용.
 *
 * 왜 별도 파일인가: 이 판정을 부르는 자리가 네 곳(분류 제안·렌즈·항목 판독·채팅 첨부)이고,
 * 네 곳이 각자 `document.aiPolicy === 'locked'`를 적으면 언젠가 한 곳만 빠진다.
 * 빠진 한 곳이 곧 '보관만'이라는 약속이 거짓말이 되는 자리다 — 벌크로 올린 계약서를
 * 'AI에게 물어보기' 한 번으로 모델에 보낼 수 있게 된다.
 *
 * 왜 기본값이 'active'인가: 이 값이 생기기 전에 올라간 문서에는 aiPolicy 칸이 아예 없다.
 * 그 문서들을 조용히 잠그면 어제까지 되던 렌즈가 오늘 409가 된다 — 기능이 깨졌다고 읽힌다.
 * 새로 잠기는 것은 벌크 이관으로 들어온 문서뿐이고, 그 사실은 화면 배지가 말한다.
 *
 * 저장 위치: 진실은 문서 payload의 aiPolicy다. PG의 items.ai_policy 컬럼은
 * documentColumns(store/postgres-store.mjs)가 payload에서 투영하는 인덱스·조회용 사본이고,
 * 로드는 payload를 복원한다. 컬럼을 고쳐도 앱은 그 값을 보지 않는다.
 */

export const AI_POLICIES = Object.freeze(['locked', 'indexed', 'active'])
export const AI_POLICY_LABELS = Object.freeze({ locked: '보관만', indexed: '정리', active: '활용' })
export const AI_POLICY_RANK = Object.freeze({ locked: 0, indexed: 1, active: 2 })
export const DEFAULT_BULK_AI_POLICY = 'locked'

/** 문서 하나의 실효 수준. 값이 없거나 모르는 값이면 'active'(이 값이 생기기 전의 문서). */
export const documentAiPolicy = (document) => (
  AI_POLICIES.includes(document?.aiPolicy) ? document.aiPolicy : 'active'
)

/** need 이상인가. 렌즈·판독은 'indexed', 채팅 첨부는 'active'를 요구한다. */
export const aiPolicyAllows = (document, need) => (
  AI_POLICY_RANK[documentAiPolicy(document)] >= (AI_POLICY_RANK[need] ?? AI_POLICY_RANK.active)
)

/**
 * 역할에 따라 다른 문장을 주는 이유: PATCH /api/documents/:id가 requireTenantAdmin이라
 * 직원은 자기 손으로 수준을 올릴 수 없다. '올린 뒤 다시 시도하세요'는 직원에게 막다른 길이다.
 *
 * document를 받는 이유: 게이트마다 요구 수준이 다르다(렌즈·판독은 '정리', 채팅 첨부는 '활용').
 * 문장을 '보관만'으로 고정해 두면 **'정리' 자료를 채팅에 첨부했을 때 라우트가 거짓을 말한다** —
 * 그 자료의 수준은 '보관만'이 아니다. 지금 수준을 문장에 그대로 적는다.
 */
export const aiLockedError = (isAdmin, document = null) => {
  const level = AI_POLICY_LABELS[document ? documentAiPolicy(document) : 'locked']
  return {
    code: 'DOCUMENT_AI_LOCKED',
    message: `AI 처리 수준이 ‘${level}’인 자료입니다. ${isAdmin
      ? '자료 정보에서 수준을 올린 뒤 다시 시도해 주세요.'
      : '회사 관리자에게 수준 상향을 요청해 주세요.'}`,
  }
}

/** 요청 본문이 보낸 수준. 모르는 값이면 null(부르는 쪽이 400을 낸다). */
export const normalizeAiPolicy = (value) => (AI_POLICIES.includes(value) ? value : null)

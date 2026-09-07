/**
 * AI 처리 수준 3단 — 보관만 · 정리 · 활용.
 *
 * 왜 `document-ai-policy.mjs`와 따로 두는가: 그 파일은 '자료(파일)' 한 종류의 판정이고 필드 이름이
 * `aiPolicy`다. 문서(위키)는 필드 이름이 `aiLevel`이고, 앞으로 다른 레코드도 같은 3단을 갖는다.
 * 어휘는 하나(`db/postgres-schema.sql:52`의 CHECK)이되 판정 함수는 '무엇을 할 수 있는가'로 나눈다 —
 * 목록에 이름을 낼 수 있는가 / 본문을 읽힐 수 있는가 / 파생물을 만들 수 있는가.
 *
 * 왜 랭크 비교(`>= need`)가 아니라 세 개의 이름 있는 술어인가: 부르는 쪽이 `aiPolicyAllows(doc, 'indexed')`
 * 라고 쓰면 '정리 수준이면 무엇이 되는지'를 그 자리에서 다시 떠올려야 한다. `aiMayDerive(level)`은
 * 그 자리에서 읽힌다. 수준이 넷이 되는 날에도 부르는 쪽을 고칠 필요가 없다.
 *
 * 저장은 영문, 표시는 한국어다. 한국어를 저장하면 DB enum과 앱이 두 어휘가 된다.
 */

/** DB 정본(`db/postgres-schema.sql:52` `items.ai_policy` CHECK)과 같은 순서·같은 값. */
export const AI_LEVELS = Object.freeze(['locked', 'indexed', 'active'])
export const AI_LEVEL_LABELS = Object.freeze({ locked: '보관만', indexed: '정리', active: '활용' })

/** 목록·제목·요약을 AI에게 보여도 되는가. '보관만'은 이름조차 내지 않는다. */
export const aiMayList = (level) => level !== 'locked'
/** 본문을 AI 입력에 실어도 되는가(렌즈·명시 첨부). */
export const aiMayReadBody = (level) => level !== 'locked'
/** AI가 이 레코드에서 새 물건(제안·요약·업무 초안)을 만들어도 되는가. '활용'만 허용한다. */
export const aiMayDerive = (level) => level === 'active'

/**
 * 레코드 하나의 실효 수준.
 *
 * `aiLevel`(문서) → `aiPolicy`(자료) 순으로 읽고, 둘 다 모르는 값이면 'active'.
 * 기본값이 'active'인 이유는 `document-ai-policy.mjs`와 같다 — 이 값이 생기기 전에 올라간 레코드를
 * 조용히 잠그면 어제까지 되던 기능이 오늘 403이 되고, 사람은 그것을 고장으로 읽는다.
 * 문서(위키)는 생성 시점에 'indexed'를 반드시 채우므로 이 기본값에 걸리지 않는다.
 */
export const aiLevelOf = (row) => (
  AI_LEVELS.includes(row?.aiLevel) ? row.aiLevel
    : AI_LEVELS.includes(row?.aiPolicy) ? row.aiPolicy
      : 'active'
)

/** 요청 본문이 보낸 수준. 모르는 값이면 null — 부르는 쪽이 400을 낸다. */
export const normalizeAiLevel = (value) => (AI_LEVELS.includes(value) ? value : null)

/** 낮추는 변경인가. 낮추면 같은 커밋에서 AI 파생물을 파기해야 한다(DECISIONS.md:45). */
export const aiLevelLowered = (before, after) => AI_LEVELS.indexOf(after) < AI_LEVELS.indexOf(before)

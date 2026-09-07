import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { AI_POLICIES, AI_POLICY_LABELS, AI_POLICY_RANK, DEFAULT_BULK_AI_POLICY, aiLockedError, aiPolicyAllows, documentAiPolicy, normalizeAiPolicy } from './document-ai-policy.mjs'

/** 'AI 처리 수준' 3단 — 라벨·순위·기본값·문장이 한 곳에서 나온다. */

test('1. 세 수준과 라벨은 DECISIONS의 문자열과 같다', () => {
  assert.deepEqual(AI_POLICIES, ['locked', 'indexed', 'active'])
  assert.deepEqual({ ...AI_POLICY_LABELS }, { locked: '보관만', indexed: '정리', active: '활용' })
  assert.deepEqual({ ...AI_POLICY_RANK }, { locked: 0, indexed: 1, active: 2 })
  assert.equal(DEFAULT_BULK_AI_POLICY, 'locked')
})

test('2. 값이 없는 옛 문서는 활용이다 — 어제까지 되던 렌즈가 오늘 막히지 않는다', () => {
  assert.equal(documentAiPolicy(undefined), 'active')
  assert.equal(documentAiPolicy({}), 'active')
  assert.equal(documentAiPolicy({ aiPolicy: '보관만' }), 'active', '모르는 값은 값이 없는 것과 같다')
  assert.equal(documentAiPolicy({ aiPolicy: 'locked' }), 'locked')
})

test('3. 렌즈·판독은 정리, 채팅 첨부는 활용을 요구한다', () => {
  const locked = { aiPolicy: 'locked' }
  const indexed = { aiPolicy: 'indexed' }
  const active = { aiPolicy: 'active' }
  assert.equal(aiPolicyAllows(locked, 'indexed'), false)
  assert.equal(aiPolicyAllows(indexed, 'indexed'), true)
  assert.equal(aiPolicyAllows(indexed, 'active'), false, '정리는 본문을 통째로 모델에 보내는 단계가 아니다')
  assert.equal(aiPolicyAllows(active, 'active'), true)
  assert.equal(aiPolicyAllows({}, 'active'), true)
  // 첨부가 아예 없는(찾지 못한) 자리는 '활용'을 통과시키지 않는다.
  assert.equal(aiPolicyAllows(undefined, 'active'), true, '옛 문서와 같은 취급 — 존재 판정은 부르는 쪽이 먼저 한다')
})

test('4. 잠긴 자료의 문장은 역할에 따라 다르다 — 직원에게 막다른 길을 주지 않는다', () => {
  const admin = aiLockedError(true)
  const member = aiLockedError(false)
  assert.equal(admin.code, 'DOCUMENT_AI_LOCKED')
  assert.equal(member.code, 'DOCUMENT_AI_LOCKED')
  assert.match(admin.message, /자료 정보에서 수준을 올린 뒤/)
  assert.match(member.message, /회사 관리자에게 수준 상향을 요청/)
  assert.notEqual(admin.message, member.message)
  /**
   * 문장은 **그 자료의 지금 수준**을 말한다. '보관만'으로 고정해 두면 '정리' 자료를 채팅에 첨부했을 때
   * 라우트가 거짓을 말한다 — 그 자료의 수준은 '보관만'이 아니고, 사람은 화면 배지와 다른 이유를 듣는다.
   */
  assert.match(aiLockedError(true, { aiPolicy: 'locked' }).message, /‘보관만’인 자료입니다/)
  assert.match(aiLockedError(true, { aiPolicy: 'indexed' }).message, /‘정리’인 자료입니다/)
  assert.equal(aiLockedError(true, { aiPolicy: 'locked' }).message, admin.message, '문서를 주지 않으면 잠긴 자료의 문장 그대로다')
})

test('5. 요청 본문의 수준은 닫힌 집합 안일 때만 받는다', () => {
  assert.equal(normalizeAiPolicy('indexed'), 'indexed')
  assert.equal(normalizeAiPolicy('보관만'), null)
  assert.equal(normalizeAiPolicy(undefined), null)
  assert.equal(normalizeAiPolicy(2), null)
})

test('6. 게이트 다섯 곳이 모두 이 모듈을 부른다 — 한 곳이 빠지면 보관만은 거짓말이다', async () => {
  const source = await readFile(new URL('./app.mjs', import.meta.url), 'utf8')
  // 분류 제안·렌즈·항목 판독·채팅 첨부, 그리고 **채팅에 실리는 자료 목록**.
  // 다섯 번째가 빠지면 본문은 막히는데 파일 이름·분류·태그·요약이 매 대화마다 모델로 나간다.
  //
  // R16-H에서 세 개가 늘어 여덟이다. 늘어난 셋은 `resolveChatAttachments`의 **필수 인자** `canUseForAi`로,
  // 라우트 게이트 뒤에 서는 두 번째 겹이다(주입을 잊으면 그 자리에서 TypeError로 죽는다).
  // 아래 정규식 셋이 "다섯 곳이 각자 무엇을 지키는가"를 그대로 잡고 있으므로 숫자만 늘린다.
  assert.equal(source.split('aiPolicyAllows(').length - 1, 8, 'aiPolicyAllows 호출이 여덟 곳이어야 한다')
  assert.equal(source.split('canUseForAi: (file) => aiPolicyAllows(file,').length - 1, 3, '첨부 해석 호출부 셋이 모두 AI 수준 판정을 주입한다')
  assert.match(source, /aiPolicyAllows\(document, 'indexed'\)[\s\S]{0,400}enqueueProposal/)
  assert.match(source, /const accessibleDocuments = [\s\S]{0,200}aiPolicyAllows\(document, 'indexed'\)[\s\S]{0,80}slice\(0, 100\)/)
  assert.equal(source.split('aiLockedError(').length - 1, 3, '409를 내는 세 라우트가 같은 문장을 쓴다')
  // 세 곳 모두 **그 자료**를 함께 넘긴다 — 넘기지 않으면 '정리' 자료에 '보관만'이라고 답하게 된다.
  assert.equal(source.split(/aiLockedError\(request\.auth\.role === 'tenant-admin', \w+\)/).length - 1, 3)
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { AI_LEVELS, AI_LEVEL_LABELS, aiLevelOf, aiMayDerive, aiMayList, aiMayReadBody } from './ai-policy.mjs'
import {
  BLOCK_TYPES, CODE_LANGUAGES, LINK_HIDDEN_LABEL, LINK_GONE_LABEL, MAX_ANY_BLOCK_TEXT, MAX_BLOCK_TEXT, MAX_CAPTION,
  MAX_CODE_TEXT, MAX_SEARCH_TEXT, MAX_TITLE,
  TEXTUAL_TYPES, WIKI_BLOCK_TOO_LONG_FOR_TYPE, WIKI_BLOCK_TYPE_CHANGE_FORBIDDEN,
  applyPatch, blockPreview, buildSearchText, linkTokenRe, linkTokensIn, neutralizeLinks, redactLinks, stripLinks, validateNewBlock,
  wikiPlainText,
} from './wiki-blocks.mjs'
import { WIKI_TEMPLATES } from './wiki-templates.mjs'

/**
 * 블록 규격·링크·파생 텍스트의 순수 규칙. 라우트를 띄우지 않고 값 하나로 못 박는다.
 *
 * 여기서 고정한 것이 무너지면 나중에 조용히 드러난다 — 미지 키를 무시하면 클라 버그가 서버에 저장되고,
 * 링크 라벨을 그대로 믿으면 볼 수 없는 업무의 제목이 본문에 남는다.
 */

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8')
const bid = (suffix) => `BLK-TEST${String(suffix).padStart(4, '0')}`
const repeat = (count, letter = 'ㄱ') => letter.repeat(count)

const MINIMAL = {
  heading: { type: 'heading', text: '제목' },
  text: { type: 'text', text: '문단' },
  bulleted: { type: 'bulleted', text: '항목' },
  numbered: { type: 'numbered', text: '항목' },
  todo: { type: 'todo', text: '할 일', checked: false },
  table: { type: 'table', rows: [['가', '나']] },
  image: { type: 'image', attachmentId: 'DOC-abcd' },
  file: { type: 'file', attachmentId: 'DOC-abcd' },
  code: { type: 'code', text: 'const a = 1' },
  quote: { type: 'quote', text: '인용' },
  divider: { type: 'divider' },
}

test('1. 11개 타입의 최소 유효 블록이 통과하고, 필수 필드가 빠지면 그 필드 이름으로 거절한다', () => {
  assert.equal(BLOCK_TYPES.length, 11)
  for (const type of BLOCK_TYPES) {
    const result = validateNewBlock({ id: bid(1), ...MINIMAL[type] })
    assert.equal(result.ok, true, `${type} 최소 블록이 거절됐다: ${result.field}`)
    assert.equal(result.block.type, type)
    assert.equal(result.block.id, bid(1))
  }
  // 기본값은 채워지되 그 타입에 없는 필드는 아예 생기지 않는다.
  assert.equal(validateNewBlock({ id: bid(1), ...MINIMAL.heading }).block.level, 2)
  assert.equal(validateNewBlock({ id: bid(1), ...MINIMAL.bulleted }).block.indent, 0)
  assert.equal(Object.hasOwn(validateNewBlock({ id: bid(1), ...MINIMAL.text }).block, 'level'), false)
  assert.deepEqual(Object.keys(validateNewBlock({ id: bid(1), ...MINIMAL.divider }).block), ['id', 'type'])

  assert.deepEqual(validateNewBlock({ id: bid(2), type: 'heading' }), { ok: false, field: 'text', code: 'WIKI_BLOCK_INVALID' })
  assert.equal(validateNewBlock({ id: bid(2), type: 'todo', text: '할 일' }).field, 'checked')
  assert.equal(validateNewBlock({ id: bid(2), type: 'table' }).field, 'rows')
  assert.equal(validateNewBlock({ id: bid(2), type: 'image' }).field, 'attachmentId')
  assert.equal(validateNewBlock({ id: 'BLK-짧', type: 'text', text: '가' }).field, 'id')
  assert.equal(validateNewBlock({ id: bid(2), type: 'sticker', text: '가' }).field, 'type')
})

test('2. 미지 키와 서버 소유 필드는 그 키 이름으로 거절한다 — 무시하면 클라 버그가 영영 안 드러난다', () => {
  assert.equal(validateNewBlock({ id: bid(3), type: 'text', text: '가', foo: 1 }).field, 'foo')
  // 그 타입에 없는 필드도 미지 키다 — text 블록에 level은 존재할 수 없다.
  assert.equal(validateNewBlock({ id: bid(3), type: 'text', text: '가', level: 2 }).field, 'level')
  for (const field of ['seq', 'editedById', 'editedAt', 'workItemId']) {
    const sent = { id: bid(3), type: 'todo', text: '가', checked: false, [field]: 1 }
    assert.equal(validateNewBlock(sent).field, field, `${field}를 클라가 보냈는데 통과했다`)
  }
  const before = validateNewBlock({ id: bid(3), ...MINIMAL.text }).block
  assert.equal(applyPatch(before, { text: '나', seq: 99 }).field, 'seq')
})

test('3. heading level은 1·2·3만, 목록 indent는 0..3만', () => {
  for (const level of [1, 2, 3]) {
    assert.equal(validateNewBlock({ id: bid(4), type: 'heading', text: '제목', level }).ok, true)
  }
  for (const level of [0, 4, '2', 2.5, null]) {
    assert.equal(validateNewBlock({ id: bid(4), type: 'heading', text: '제목', level }).field, 'level', `level ${level}이 통과했다`)
  }
  assert.equal(validateNewBlock({ id: bid(4), type: 'bulleted', text: '가', indent: 3 }).ok, true)
  assert.equal(validateNewBlock({ id: bid(4), type: 'bulleted', text: '가', indent: 4 }).field, 'indent')
  assert.equal(validateNewBlock({ id: bid(4), type: 'bulleted', text: '가', indent: -1 }).field, 'indent')
})

test('4. 표는 행 길이가 모두 같아야 하고 30행·8열·셀 200자를 넘지 않는다', () => {
  assert.equal(validateNewBlock({ id: bid(5), type: 'table', rows: [['가', '나'], ['다']] }).field, 'rows')
  assert.equal(validateNewBlock({ id: bid(5), type: 'table', rows: Array.from({ length: 31 }, () => ['가']) }).field, 'rows')
  assert.equal(validateNewBlock({ id: bid(5), type: 'table', rows: [Array.from({ length: 9 }, () => '가')] }).field, 'rows')
  assert.equal(validateNewBlock({ id: bid(5), type: 'table', rows: [[repeat(201)]] }).field, 'rows')
  assert.equal(validateNewBlock({ id: bid(5), type: 'table', rows: [] }).field, 'rows')
  assert.equal(validateNewBlock({ id: bid(5), type: 'table', rows: [[repeat(200)]] }).ok, true)
  assert.equal(validateNewBlock({ id: bid(5), type: 'table', rows: Array.from({ length: 30 }, () => Array.from({ length: 8 }, () => '가')) }).ok, true)
})

test('5. code language는 목록 안에서만, 본문은 20_000자까지', () => {
  assert.equal(validateNewBlock({ id: bid(6), type: 'code', text: 'a', language: 'ruby' }).field, 'language')
  assert.equal(validateNewBlock({ id: bid(6), type: 'code', text: 'a', language: '' }).ok, true)
  for (const language of CODE_LANGUAGES) {
    assert.equal(validateNewBlock({ id: bid(6), type: 'code', text: 'a', language }).ok, true)
  }
  assert.equal(validateNewBlock({ id: bid(6), type: 'code', text: repeat(20_000, 'a') }).ok, true)
  assert.equal(validateNewBlock({ id: bid(6), type: 'code', text: repeat(20_001, 'a') }).field, 'text')
  // 일반 문단은 4_000자, 제목은 200자.
  assert.equal(validateNewBlock({ id: bid(6), type: 'text', text: repeat(4_001, 'a') }).field, 'text')
  assert.equal(validateNewBlock({ id: bid(6), type: 'heading', text: repeat(201, 'a') }).field, 'text')
})

test('6. image·file의 attachmentId는 자료실 문서 id 형식이어야 한다', () => {
  for (const type of ['image', 'file']) {
    assert.equal(validateNewBlock({ id: bid(7), type, attachmentId: 'WDOC-1234' }).field, 'attachmentId')
    assert.equal(validateNewBlock({ id: bid(7), type, attachmentId: 'DOC-x' }).field, 'attachmentId')
    assert.equal(validateNewBlock({ id: bid(7), type, attachmentId: 'DOC-abcd' }).ok, true)
    // 캡션은 200자까지.
    assert.equal(validateNewBlock({ id: bid(7), type, attachmentId: 'DOC-abcd', text: repeat(201) }).field, 'text')
  }
})

test('7. 타입 변경은 TEXTUAL_TYPES 안에서만 — 새 타입에 없는 필드는 사라지고 있는 필드는 기본값이 찬다', () => {
  const heading = validateNewBlock({ id: bid(8), type: 'heading', text: '제목', level: 3 }).block
  const paragraph = validateNewBlock({ id: bid(8), ...MINIMAL.text }).block
  const divider = validateNewBlock({ id: bid(8), ...MINIMAL.divider }).block

  const toHeading = applyPatch(paragraph, { type: 'heading' })
  assert.equal(toHeading.ok, true)
  assert.equal(toHeading.block.level, 2)

  const toTodo = applyPatch(heading, { type: 'todo' })
  assert.equal(toTodo.ok, true)
  assert.equal(toTodo.block.checked, false)
  assert.equal(toTodo.block.indent, 0)
  assert.equal(Object.hasOwn(toTodo.block, 'level'), false)
  assert.equal(toTodo.block.text, '제목')

  for (const [before, patch] of [[paragraph, { type: 'table', rows: [['가']] }], [divider, { type: 'text', text: '가' }]]) {
    const result = applyPatch(before, patch)
    assert.equal(result.ok, false)
    assert.equal(result.field, 'type')
    assert.equal(result.code, WIKI_BLOCK_TYPE_CHANGE_FORBIDDEN)
  }
  for (const type of TEXTUAL_TYPES) {
    assert.equal(applyPatch(paragraph, { type }).ok, true, `${type}로 바꾸지 못했다`)
  }
  // 블록에서 만든 업무와의 연결은 규격 표 밖의 서버 필드라 타입을 바꿔도 끊기지 않는다.
  const linked = { ...validateNewBlock({ id: bid(8), type: 'todo', text: '가', checked: true }).block, workItemId: 'WK-1' }
  assert.equal(applyPatch(linked, { type: 'text' }).block.workItemId, 'WK-1')
})

test('8. 링크 토큰은 라벨에 `]`·개행을 허용하지 않고 80자까지만 받는다', () => {
  const matches = (text) => [...String(text).matchAll(linkTokenRe())]
  assert.equal(matches('[[doc:WDOC-1|가]]').length, 1)
  assert.equal(matches('[[doc:WDOC-1|가]]')[0][3], '가')
  // 라벨이 `]`를 삼키지 않는다 — 삼키면 토큰 안에서 토큰을 만들 수 있다.
  assert.equal(matches('[[doc:WDOC-1|가]]]')[0][3], '가')
  assert.equal(matches('[[doc:WDOC-1|가\n나]]').length, 0)
  assert.equal(matches(`[[doc:WDOC-1|${repeat(81, 'a')}]]`).length, 0)
  assert.equal(matches(`[[doc:WDOC-1|${repeat(80, 'a')}]]`).length, 1)
  assert.equal(matches('[[note:X|가]]').length, 0)
  assert.equal(matches('[[task:WK-1|업무]] [[person:USR-1|사람]]').length, 2)
})

test('9. redactLinks는 저장 라벨을 믿지 않는다 — 보이면 현재 제목, 못 보면 접근 권한 없음, 없으면 삭제된 항목', () => {
  const resolve = (kind, id) => {
    if (id === 'WK-VISIBLE') return { title: '지금 제목' }
    if (id === 'WK-HIDDEN') return 'hidden'
    return 'gone'
  }
  assert.equal(redactLinks('[[task:WK-VISIBLE|낡은 제목]]', resolve), '[[task:WK-VISIBLE|지금 제목]]')
  assert.equal(redactLinks('[[task:WK-HIDDEN|비밀 업무]]', resolve), `[[task:WK-HIDDEN|${LINK_HIDDEN_LABEL}]]`)
  assert.equal(redactLinks('[[task:WK-NONE|사라진 것]]', resolve), `[[task:WK-NONE|${LINK_GONE_LABEL}]]`)
  // 주입을 잊으면 열리는 쪽이 아니라 닫히는 쪽으로 넘어진다.
  assert.equal(redactLinks('[[task:WK-VISIBLE|낡은 제목]]'), `[[task:WK-VISIBLE|${LINK_HIDDEN_LABEL}]]`)
  // 제목이 토큰을 깨뜨리지 못한다.
  assert.equal(
    redactLinks('[[doc:WDOC-1|x]]', () => ({ title: '나쁜]]제목\n둘째 줄' })),
    '[[doc:WDOC-1|나쁜 제목 둘째 줄]]',
  )
})

test('10. stripLinks는 토큰을 라벨만 남기고, neutralizeLinks는 이름조차 남기지 않는다', () => {
  // stripLinks는 **재인가를 이미 마친 뒤**에만 선다(`wikiPlainText`) — 그 자리에서 라벨은 안전한 값이다.
  assert.equal(stripLinks('앞 [[doc:WDOC-1|계약 검토]] 뒤'), '앞 계약 검토 뒤')
  assert.equal(stripLinks('링크 없음'), '링크 없음')
  // 템플릿 복제는 재인가할 근거(토큰)를 버리는 자리라, 라벨을 남기면 그 이름이 영구히 평문이 된다.
  assert.equal(neutralizeLinks('앞 [[doc:WDOC-1|계약 검토]] 뒤'), '앞 연결된 항목 뒤')
  assert.equal(neutralizeLinks('셋 [[task:WK-1|급여 인상안]]·[[person:USR-1|박지현]]'), '셋 연결된 항목·연결된 항목')
  assert.equal(neutralizeLinks('링크 없음'), '링크 없음')
})

test('11. buildSearchText는 링크 토큰을 라벨까지 통째로 지운다(존재 오라클 차단)', () => {
  const blocks = [
    { id: bid(9), type: 'text', text: '앞[[task:WK-SECRET|급여 인상안]]뒤' },
    { id: bid(10), type: 'image', attachmentId: 'DOC-abcd', text: '설계도 캡션' },
    { id: bid(11), type: 'divider' },
    { id: bid(12), type: 'table', rows: [['지표', '목표']] },
    // 표 셀에도 토큰이 들어온다 — wikiPlainText가 셀마다 redactLinks를 거는 것이 그 증거다.
    { id: bid(13), type: 'table', rows: [['담당', '[[task:WK-TABLE|인수합병 검토]]'], ['보조', '[[person:USR-Z|김비밀]]']] },
  ]
  const searchText = buildSearchText(blocks)
  assert.equal(searchText.includes('급여 인상안'), false)
  assert.equal(searchText.includes('[['), false)
  assert.equal(searchText.includes('WK-SECRET'), false)
  // 표 갈래로 열린 존재 오라클 — 라벨도 대상 id도 색인에 남지 않는다.
  assert.equal(searchText.includes('인수합병 검토'), false)
  assert.equal(searchText.includes('WK-TABLE'), false)
  assert.equal(searchText.includes('김비밀'), false)
  assert.equal(searchText.includes('USR-Z'), false)
  assert.equal(searchText.includes('담당'), true)
  // 첨부 id는 색인에 들어가지 않는다 — 캡션만 들어간다.
  assert.equal(searchText.includes('DOC-abcd'), false)
  assert.equal(searchText.includes('설계도 캡션'), true)
  assert.deepEqual(searchText.split('\n'), ['앞 뒤', '설계도 캡션', '지표 목표', '담당 보조'])

  const long = Array.from({ length: 6 }, (_, index) => ({ id: bid(20 + index), type: 'text', text: repeat(4_000, 'a') }))
  assert.equal(buildSearchText(long).length, MAX_SEARCH_TEXT)
})

test('12. wikiPlainText는 마크다운으로 내리고 링크는 표시이름만 남긴다', () => {
  const document = {
    title: '운영 문서',
    blocks: [
      { id: bid(30), type: 'heading', text: '개요', level: 3 },
      { id: bid(31), type: 'text', text: '[[doc:WDOC-2|이웃 문서]]를 함께 본다' },
      { id: bid(32), type: 'todo', text: '점검', checked: true, indent: 0 },
      { id: bid(33), type: 'todo', text: '보고', checked: false, indent: 1 },
      { id: bid(34), type: 'table', rows: [['가', '나'], ['1', '2']] },
      { id: bid(35), type: 'divider' },
      { id: bid(36), type: 'code', text: 'select 1', language: 'sql' },
      { id: bid(37), type: 'bulleted', text: '항목', indent: 0 },
      { id: bid(38), type: 'quote', text: '인용' },
    ],
  }
  const text = wikiPlainText(document, () => ({ title: '이웃 문서' }))
  assert.equal(text.includes('# 운영 문서'), true)
  assert.equal(text.includes('### 개요'), true)
  assert.equal(text.includes('- [x] 점검'), true)
  assert.equal(text.includes('  - [ ] 보고'), true)
  assert.equal(text.includes('| 가 | 나 |'), true)
  assert.equal(text.includes('| --- | --- |'), true)
  assert.equal(text.includes('\n---\n'), true)
  assert.equal(text.includes('```sql'), true)
  assert.equal(text.includes('- 항목'), true)
  assert.equal(text.includes('> 인용'), true)
  // 토큰 문법은 남지 않고 표시이름만 남는다.
  assert.equal(text.includes('[['), false)
  assert.equal(text.includes('이웃 문서를 함께 본다'), true)
  // 렌더 시점 인가는 옛 본문에도 그대로 걸린다.
  assert.equal(wikiPlainText(document, () => 'hidden').includes(LINK_HIDDEN_LABEL), true)
})

test('13. 미리보기는 본문 없는 타입을 라벨로 답한다', () => {
  assert.equal(blockPreview({ type: 'table', rows: [['가', '나'], ['1', '2'], ['3', '4']] }), '표 3×2')
  assert.equal(blockPreview({ type: 'divider' }), '구분선')
  assert.equal(blockPreview({ type: 'image', attachmentId: 'DOC-abcd' }), '이미지')
  assert.equal(blockPreview({ type: 'file', attachmentId: 'DOC-abcd', text: '계약서' }), '파일 · 계약서')
  assert.equal(blockPreview({ type: 'text', text: '  여러   칸이\n  한 칸으로  ' }), '여러 칸이 한 칸으로')
  assert.equal(blockPreview({ type: 'text', text: repeat(200) }).length, 120)
})

test('14. AI 처리 수준은 DB CHECK와 같은 어휘를 쓰고, 표시어는 보관만·정리·활용 셋뿐이다', () => {
  assert.deepEqual([...AI_LEVELS], ['locked', 'indexed', 'active'])
  assert.deepEqual({ ...AI_LEVEL_LABELS }, { locked: '보관만', indexed: '정리', active: '활용' })
  assert.equal(Object.values(AI_LEVEL_LABELS).includes('분석'), false)

  const schema = read('../db/postgres-schema.sql')
  const check = schema.match(/ai_policy\s+TEXT[^\n]*CHECK\s*\(ai_policy\s+IN\s*\(([^)]*)\)\)/i)
  assert.ok(check, 'db/postgres-schema.sql에서 ai_policy CHECK를 찾지 못했다')
  const values = check[1].split(',').map((piece) => piece.trim().replace(/^'|'$/g, ''))
  assert.deepEqual(values, [...AI_LEVELS])

  assert.deepEqual([aiMayList('locked'), aiMayReadBody('locked'), aiMayDerive('locked')], [false, false, false])
  assert.deepEqual([aiMayList('indexed'), aiMayReadBody('indexed'), aiMayDerive('indexed')], [true, true, false])
  assert.deepEqual([aiMayList('active'), aiMayReadBody('active'), aiMayDerive('active')], [true, true, true])
  // 이 값이 생기기 전의 레코드는 오늘 동작을 유지한다.
  assert.equal(aiLevelOf({}), 'active')
  assert.equal(aiLevelOf({ aiPolicy: 'locked' }), 'locked')
  assert.equal(aiLevelOf({ aiLevel: 'indexed', aiPolicy: 'locked' }), 'indexed')
})

test('15. 기본 템플릿 4종은 블록 규격을 통과하고, 어휘는 이 데이터에만 있으며 실명·데모 문자열이 없다', () => {
  assert.equal(WIKI_TEMPLATES.length, 4)
  const ids = WIKI_TEMPLATES.map((template) => template.id)
  assert.deepEqual(ids, ['WDOC-TPL-MEETING', 'WDOC-TPL-WEEKLY', 'WDOC-TPL-PLAN', 'WDOC-TPL-MANUAL'])
  const blockIds = new Set()
  for (const template of WIKI_TEMPLATES) {
    for (const block of template.blocks) {
      const result = validateNewBlock(block)
      assert.equal(result.ok, true, `${template.id} ${block.id} 거절: ${result.field}`)
      assert.equal(blockIds.has(block.id), false, `${block.id}가 두 번 쓰였다`)
      blockIds.add(block.id)
    }
  }
  const dump = JSON.stringify(WIKI_TEMPLATES)
  for (const forbidden of ['USR-', 'demo1234', '햇살바다', '@sunsea', '박지현', '오태식']) {
    assert.equal(dump.includes(forbidden), false, `템플릿 시드에 ${forbidden}가 들어 있다`)
  }
})

test('16. 위키 모듈은 AI 수준을 부르는 말로 「분석」을 쓰지 않는다', () => {
  // 저장 어휘는 DB CHECK와 같은 셋뿐이고, 표시어는 보관만·정리·활용 셋뿐이다.
  // (`분석`은 저장소의 다른 곳에서 렌즈·리뷰 문구로 쓰이므로 저장소 전체 부재를 요구하지 않는다.)
  for (const file of ['ai-policy.mjs', 'wiki-blocks.mjs', 'wiki-merge.mjs', 'wiki-revisions.mjs', 'wiki-templates.mjs']) {
    const source = read(`./${file}`)
    assert.equal(source.includes('분석'), false, `server/${file}에 '분석'이 남아 있다`)
  }
})

// ── 17..19 검증 2회차에서 잡힌 것 ───────────────────────────────────────────

test('17. 링크 정규식은 상태를 나눠 갖지 않는다 — 앞선 `.test()`가 쓰기 시점 인가의 토큰을 건너뛰게 하지 못한다', () => {
  const text = '[[task:WK-SECRET1|극비A]] 사이 [[task:WK-SECRET2|극비B]]'
  assert.deepEqual(linkTokensIn(text).map((token) => token.id), ['WK-SECRET1', 'WK-SECRET2'])

  // 이 저장소의 지배적 관용구는 `.test()`다(BLOCK_ID_RE·OP_ID_RE·ATTACHMENT_ID_RE 전부 그렇게 쓰인다).
  // 공용 /g 정규식을 내보내면 그 한 번이 lastIndex를 남겨 다음 matchAll이 앞쪽 토큰을 통째로 건너뛰고,
  // 건너뛴 링크는 인가를 받지 않은 채 저장된다 — §3-4가 쓰기 시점에 닫아 둔 존재 오라클이 다시 열린다.
  const shared = linkTokenRe()
  assert.equal(shared.test(text), true)
  assert.ok(shared.lastIndex > 0, '이 테스트가 재는 위험(lastIndex가 남는 상태)이 사라졌다')
  assert.deepEqual(linkTokensIn(text).map((token) => token.id), ['WK-SECRET1', 'WK-SECRET2'])
  assert.equal(redactLinks(text, () => 'hidden'), `[[task:WK-SECRET1|${LINK_HIDDEN_LABEL}]] 사이 [[task:WK-SECRET2|${LINK_HIDDEN_LABEL}]]`)

  // 팩토리는 호출마다 새 객체다 — 두 사용처가 서로의 커서를 물려받지 않는다.
  const first = linkTokenRe()
  first.test(text)
  assert.equal(linkTokenRe().lastIndex, 0)
  assert.equal([...text.matchAll(linkTokenRe())].length, 2)
})

test('18. applyPatch는 「남이 모양을 바꿨다」와 「클라이언트가 틀렸다」를 갈라 답한다', () => {
  const paragraph = { id: bid(1), type: 'text', text: '문단', seq: 1 }
  const table = { id: bid(1), type: 'table', rows: [['가']], seq: 1 }

  // 다른 타입에는 있는 필드가 왔다 = 클라이언트가 보던 모양이 그 사이 바뀌었다.
  for (const [before, patch, field] of [
    [paragraph, { checked: true }, 'checked'],
    [paragraph, { level: 2 }, 'level'],
    [paragraph, { language: 'sql' }, 'language'],
    [table, { text: '내 문장' }, 'text'],
  ]) {
    const result = applyPatch(before, patch)
    assert.equal(result.ok, false)
    assert.equal(result.field, field)
    assert.equal(result.staleShape, true, `${field}가 클라 버그로 분류됐다`)
  }
  // 슬래시 메뉴가 낼 수 있는 변환을 요청했는데 지금 타입이 표라면, 튕긴 이유는 지금 블록의 타입이다.
  const fenced = applyPatch(table, { type: 'text', text: '가' })
  assert.equal(fenced.code, WIKI_BLOCK_TYPE_CHANGE_FORBIDDEN)
  assert.equal(fenced.staleShape, true)

  // 반대쪽: 어떤 모양에도 얹힐 수 없는 patch는 표시가 붙지 않는다(= 배치 전체 400으로 남는다).
  const heading = { id: bid(1), type: 'heading', text: '제목', level: 2, seq: 1 }
  for (const [before, patch] of [
    [paragraph, { 아무거나: 1 }],
    [paragraph, { seq: 9 }],
    [paragraph, { workItemId: 'WK-1' }],
    [paragraph, { type: 'table' }],
    [heading, { level: 9 }],
    [paragraph, { text: repeat(MAX_CODE_TEXT + 1, 'a') }],
    [paragraph, undefined],
  ]) {
    const result = applyPatch(before, patch)
    assert.equal(result.ok, false, `${JSON.stringify(patch ?? null)}가 통과했다`)
    assert.notEqual(result.staleShape, true, `${JSON.stringify(patch ?? null)}가 '남이 바꿨다'로 분류됐다`)
  }
})

test('18-b. 길이 축도 「지금 타입 때문인가」를 되묻는다 — 타입마다 다른 상한은 클라 버그의 근거가 아니다', () => {
  // 본문 상한만이 타입에 따라 달라진다(제목 200 · 문단 4_000 · 코드 20_000). 그래서 "지금 타입에서는
  // 너무 길다"는 클라이언트가 틀렸다는 뜻이 아니라, 남이 타입을 좁혔거나 이 patch가 좁히는 중이라는 뜻이다.
  const heading = { id: bid(1), type: 'heading', text: '제목', level: 2, seq: 1 }
  const paragraph = { id: bid(1), type: 'text', text: repeat(300), seq: 1 }
  const code = { id: bid(1), type: 'code', text: repeat(5_000, 'x'), language: 'javascript', seq: 1 }
  const image = { id: bid(1), type: 'image', attachmentId: 'DOC-0001', text: '설명', seq: 1 }

  for (const [before, patch, label] of [
    // (a) 남이 문단을 제목으로 바꿨고, 문단 시절에는 적법하던 길이가 도착했다.
    [heading, { text: repeat(1_000) }, '남이 좁힌 타입'],
    // (b) 이 patch가 스스로 좁힌다 — 기존 본문이 목표 타입 상한을 넘는다(300자 문단 → 제목).
    [paragraph, { type: 'heading' }, '스스로 좁히는 변환'],
    [code, { type: 'text' }, '코드 → 문단'],
    // (c) 캡션 상한도 같은 축이다.
    [image, { text: repeat(MAX_CAPTION + 1) }, '캡션'],
  ]) {
    const result = applyPatch(before, patch)
    assert.equal(result.ok, false, `${label}가 통과했다`)
    assert.equal(result.field, 'text')
    assert.equal(result.staleShape, true, `${label}가 클라 버그로 분류됐다`)
    assert.equal(result.code, WIKI_BLOCK_TOO_LONG_FOR_TYPE, `${label}의 사유가 뭉개졌다`)
  }
  assert.ok(MAX_TITLE < 300 && MAX_BLOCK_TEXT < 5_000)

  // 경계: 목표 타입의 상한 자체는 통과한다.
  assert.equal(applyPatch({ id: bid(1), type: 'text', text: repeat(MAX_TITLE), seq: 1 }, { type: 'heading' }).ok, true)

  // 반대쪽 문: 어떤 타입에도 얹힐 수 없는 길이만이 클라 버그다(병합기가 그 앞에서 배치 전체를 400으로 막는다).
  const tooLong = applyPatch({ id: bid(1), type: 'text', text: '가', seq: 1 }, { text: repeat(MAX_ANY_BLOCK_TEXT + 1) })
  assert.equal(tooLong.ok, false)
  assert.notEqual(tooLong.staleShape, true)

  // 길이가 아닌 축은 여전히 클라 버그다 — 값 자체가 어떤 타입에서도 틀렸기 때문이다.
  for (const [before, patch] of [[heading, { level: 9 }], [{ id: bid(1), type: 'bulleted', text: '가', indent: 0, seq: 1 }, { indent: 99 }]]) {
    assert.notEqual(applyPatch(before, patch).staleShape, true, `${JSON.stringify(patch)}가 '남이 바꿨다'로 분류됐다`)
  }

  // 삽입은 다르다 — 새 블록은 클라이언트가 타입을 직접 정하므로 상한을 넘긴 본문은 진짜 클라 버그다.
  assert.equal(validateNewBlock({ id: bid(1), type: 'heading', text: repeat(MAX_TITLE + 1) }).staleShape, undefined)
})

test('19. 어떤 타입에도 얹힐 수 없는 본문 길이는 규격 표에서 계산된다', () => {
  // 손으로 적은 숫자가 아니라 BLOCK_SPEC의 최댓값이다 — 규격이 바뀌면 함께 움직인다.
  assert.equal(MAX_ANY_BLOCK_TEXT, MAX_CODE_TEXT)
  assert.equal(validateNewBlock({ id: bid(1), type: 'code', text: repeat(MAX_ANY_BLOCK_TEXT, 'a') }).ok, true)
  assert.equal(validateNewBlock({ id: bid(1), type: 'code', text: repeat(MAX_ANY_BLOCK_TEXT + 1, 'a') }).ok, false)
})

test('20. 위키 소스에 날 제어문자가 없다 — grep에게 바이너리로 보이는 파일은 검색에서 통째로 빠진다', () => {
  // 실제로 이 저장소에서 한 번 일어났다: 문자열 구분자로 쓴 날 NUL 두 개 때문에 `file(1)`이 그 파일을
  // "data"로 읽고 grep/rg가 매치 줄 대신 "Binary file … matches"만 답해, import 줄을 놓친 채 검증이 지나갔다.
  // 기능은 멀쩡했으므로 다른 어떤 테스트도 이것을 잡지 못한다 — 소스 위생은 소스로 재야 한다.
  // 탭(9)·개행(10)·캐리지리턴(13)만 허용한다. 정규식 대신 코드로 세는 이유는 이 테스트 파일 자체에
  // 날 제어문자를 들이지 않기 위해서다.
  const isControl = (code) => (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127
  for (const file of ['ai-policy.mjs', 'wiki-blocks.mjs', 'wiki-merge.mjs', 'wiki-revisions.mjs', 'wiki-templates.mjs']) {
    const source = read(`./${file}`)
    let offender = -1
    for (let index = 0; index < source.length && offender < 0; index += 1) {
      if (isControl(source.charCodeAt(index))) offender = index
    }
    const code = offender < 0 ? '' : source.charCodeAt(offender).toString(16).padStart(4, '0')
    assert.equal(offender, -1, `server/${file} ${offender}번째 글자가 제어문자 U+${code}다`)
  }
})

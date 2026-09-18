import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import test from 'node:test'

import {
  applyHumanChoices,
  carryOverSummary,
  finalizeLinks,
  matchAnchors,
  normalizeForCompare,
  shingles,
  similarity,
  wordDiff,
} from './material-lineage.mjs'

// 항목 인식 모듈이 만드는 모양을 흉내 낸다. 해시는 NFKC 전문 해시(설계서 §6 지문).
const textHash = (text) => createHash('sha256').update(String(text).normalize('NFKC')).digest('hex').slice(0, 32)
const anchor = ({ id, key, title, text, kind = 'item', order = 0, lineageId }) => ({
  id, key, kind, title, text, textHash: textHash(text), simhash: '0000000000000000', order,
  ...(lineageId ? { lineageId } : {}),
})
/** 지난 판: 계보 id는 'L-키'. */
const oldVersion = (rows) => rows.map((row, order) => anchor({ id: `v1-${row.key}`, lineageId: `L-${row.key}`, order, ...row }))
/** 새 판: id는 'v2-키'. */
const newVersion = (rows) => rows.map((row, order) => anchor({ id: `v2-${row.key}`, order, ...row }))

const T = {
  payment: '결제 화면에서 카드 등록이 실패하면 사용자에게 다시 시도하라는 안내를 보여 주고, 세 번 실패하면 고객센터 연락처를 함께 띄웁니다.',
  paymentReworded: '결제 화면에서 카드 등록이 실패하면 사용자에게 다시 시도하도록 안내를 보여 주고, 세 번 실패하면 고객센터 전화번호를 함께 띄웁니다.',
  login: '로그인은 휴대폰 번호와 인증 문자로 합니다. 인증 문자는 3분 안에 입력해야 하고, 다섯 번 틀리면 10분 동안 잠깁니다.',
  leave: '연차 신청은 팀장이 먼저 승인하고, 사흘 이상이면 대표가 한 번 더 승인합니다. 승인되면 달력에 자동으로 표시됩니다.',
  report: '월말 보고서는 매달 마지막 금요일 오후 3시까지 올리고, 늦으면 다음 주 월요일 회의에서 사유를 말합니다.',
  withdraw: '회원 탈퇴를 누르면 30일 동안 계정을 보관했다가 지웁니다. 그 사이에 다시 로그인하면 탈퇴가 취소됩니다.',
  workshop: '다음 달 워크숍 장소는 제주도로 정했고, 숙소 예약과 항공권은 총무팀이 한꺼번에 맡습니다.',
}

const findLink = (result, nextId, lineageId) => result.links.find((entry) => entry.nextId === nextId && (!lineageId || entry.lineageId === lineageId))

test('정규화는 전각·대소문자·문장부호·띄어쓰기 폭을 지운다', () => {
  assert.equal(normalizeForCompare('  “결제”  →  화면 · ＡＢＣ  ①\n\t끝. '), '결제 화면 abc 1 끝')
  assert.equal(normalizeForCompare(null), '')
  assert.deepEqual([...shingles('가나 다라')], ['가나다', '나다라'], '공백은 빼고 글자 3개씩 자른다')
  assert.deepEqual([...shingles('가나')], ['가나'], '3글자보다 짧으면 글 전체가 조각 하나')
  assert.equal(shingles('').size, 0)
})

test('한국어 유사도: 고쳐 쓴 문장이 관계없는 문장보다 확실히 높다', () => {
  const reworded = similarity(T.payment, T.paymentReworded)
  const unrelated = similarity(T.payment, T.workshop)
  assert.ok(reworded > 0.5, `고쳐 쓴 문장 ${reworded}`)
  assert.ok(unrelated < 0.1, `관계없는 문장 ${unrelated}`)
  assert.equal(similarity(T.payment, T.payment), 1)
  // 조사·띄어쓰기만 바뀐 문장은 거의 같다고 본다.
  assert.ok(similarity('결제 화면에서 카드를 등록합니다', '결제화면에서 카드를 등록 합니다') > 0.9)
  // 제목 0.4 + 본문 0.6
  const score = similarity({ title: '결제 실패 안내', text: T.payment }, { title: '회원 탈퇴', text: T.payment })
  assert.ok(score >= 0.6 && score < 0.7, `본문만 같으면 0.6 근처 ${score}`)
})

test('유사도는 문자열 조각으로 센 값과 같다(제목 2글자 Dice, 본문 3글자 Jaccard)', () => {
  const dice = (a, b) => (2 * [...a].filter((item) => b.has(item)).length) / (a.size + b.size)
  const jaccard = (a, b) => {
    const shared = [...a].filter((item) => b.has(item)).length
    return shared / (a.size + b.size - shared)
  }
  const pairs = [
    [{ title: '결제 실패 안내', text: T.payment }, { title: '결제 실패 시 안내', text: T.paymentReworded }],
    [{ title: 'A1 로그인', text: T.login }, { title: '로그인 방식', text: T.leave }],
    [{ title: '가', text: '나다' }, { title: '가', text: '나다라' }],
  ]
  for (const [a, b] of pairs) {
    const expected = dice(shingles(a.title, 2), shingles(b.title, 2)) * 0.4 + jaccard(shingles(a.text), shingles(b.text)) * 0.6
    assert.ok(Math.abs(similarity(a, b) - expected) < 1e-12, `${a.title} / ${b.title}`)
  }
})

test('같은 판을 다시 올리면 모두 "같음"이다', () => {
  const rows = [
    { key: 'A1', title: '결제 실패 안내', text: T.payment },
    { key: 'A2', title: '로그인 방식', text: T.login },
    { key: 'A3', title: '연차 승인', text: T.leave },
  ]
  const result = matchAnchors(oldVersion(rows), newVersion(rows))
  assert.deepEqual(result.links.map((entry) => [entry.nextId, entry.lineageId, entry.status, entry.score, entry.textChanged]), [
    ['v2-A1', 'L-A1', 'same', 1, false],
    ['v2-A2', 'L-A2', 'same', 1, false],
    ['v2-A3', 'L-A3', 'same', 1, false],
  ])
  assert.deepEqual(result.added, [])
  assert.deepEqual(result.removed, [])
  assert.deepEqual(result.summary, { same: 3, changed: 0, moved: 0, uncertain: 0, keyReused: 0, added: 0, removed: 0 })
})

test('조금 고쳐 쓴 항목은 같은 번호로 "바뀜"이 된다', () => {
  const result = matchAnchors(
    oldVersion([{ key: 'A1', title: '결제 실패 안내', text: T.payment }]),
    newVersion([{ key: 'A1', title: '결제 실패 안내', text: T.paymentReworded }]),
  )
  const entry = findLink(result, 'v2-A1')
  assert.equal(entry.status, 'changed')
  assert.equal(entry.lineageId, 'L-A1')
  assert.equal(entry.textChanged, true)
  assert.ok(entry.score >= 0.5 && entry.score < 1)
  assert.deepEqual(result.summary, { same: 0, changed: 1, moved: 0, uncertain: 0, keyReused: 0, added: 0, removed: 0 })
})

test('AI가 A1 자리에 다른 내용을 넣으면 "번호 재사용 의심"으로 묻고, 잇지는 않는다', () => {
  const result = matchAnchors(
    oldVersion([
      { key: 'A1', title: '결제 실패 안내', text: T.payment },
      { key: 'A2', title: '로그인 방식', text: T.login },
    ]),
    newVersion([
      { key: 'A1', title: '회원 탈퇴 절차', text: T.withdraw },
      { key: 'A2', title: '로그인 방식', text: T.login },
    ]),
  )
  const reused = findLink(result, 'v2-A1')
  assert.equal(reused.status, 'key-reused')
  assert.equal(reused.lineageId, 'L-A1', '화면이 "이 둘이 같은 항목인가요?"를 물을 수 있게 옛 계보를 알려 준다')
  assert.ok(reused.score < 0.5)
  assert.deepEqual(result.added, ['v2-A1'], '확인 전에는 새 항목')
  assert.deepEqual(result.removed, ['L-A1'])
  assert.equal(result.summary.keyReused, 1)
  assert.equal(finalizeLinks(result).byNextId.has('v2-A1'), false)
})

test('AI가 번호만 서로 바꿔 매기면 내용이 계보를 따라간다(번호 재사용 의심은 남지 않는다)', () => {
  const result = matchAnchors(
    oldVersion([
      { key: 'A1', title: '결제 실패 안내', text: T.payment },
      { key: 'A2', title: '로그인 방식', text: T.login },
    ]),
    newVersion([
      { key: 'A1', title: '로그인 방식', text: T.login },
      { key: 'A2', title: '결제 실패 안내', text: T.payment },
    ]),
  )
  assert.deepEqual(result.links.map((entry) => [entry.nextId, entry.lineageId, entry.status]), [
    ['v2-A1', 'L-A2', 'moved'],
    ['v2-A2', 'L-A1', 'moved'],
  ])
  assert.equal(result.summary.keyReused, 0)
  assert.deepEqual(result.added, [])
  assert.deepEqual(result.removed, [])
})

test('번호와 제목이 바뀌어도 내용이 같으면 "옮김"으로 이어진다', () => {
  const result = matchAnchors(
    oldVersion([
      { key: 'A1', title: '로그인 방식', text: T.login },
      { key: 'A3', title: '결제 실패 안내', text: T.payment },
    ]),
    newVersion([
      { key: 'A1', title: '로그인 방식', text: T.login },
      { key: 'C7', title: '결제 실패 시 안내', text: T.payment },
    ]),
  )
  const moved = findLink(result, 'v2-C7')
  assert.equal(moved.status, 'moved')
  assert.equal(moved.lineageId, 'L-A3')
  assert.equal(moved.textChanged, false, '자리만 옮겼고 내용은 그대로')
  assert.ok(moved.score >= 0.75)
  assert.deepEqual(result.summary, { same: 1, changed: 0, moved: 1, uncertain: 0, keyReused: 0, added: 0, removed: 0 })
})

test('종류가 달라도 내용이 같으면 0.1 감점하고 잇는다', () => {
  const result = matchAnchors(
    oldVersion([{ key: 'A3', title: '결제 실패 안내', text: T.payment, kind: 'item' }]),
    newVersion([{ key: 'row-9', title: '결제 실패 안내', text: T.payment, kind: 'row' }]),
  )
  const moved = findLink(result, 'v2-row-9')
  assert.equal(moved.status, 'moved')
  assert.ok(Math.abs(moved.score - 0.9) < 1e-9)
})

test('빠진 항목은 removed, 새로 생긴 항목은 added', () => {
  const result = matchAnchors(
    oldVersion([
      { key: 'B1', title: '로그인 방식', text: T.login },
      { key: 'B2', title: '월말 보고', text: T.report },
    ]),
    newVersion([
      { key: 'B1', title: '로그인 방식', text: T.login },
      { key: 'B9', title: '워크숍 준비', text: T.workshop },
    ]),
  )
  assert.deepEqual(result.links.map((entry) => [entry.nextId, entry.status]), [['v2-B1', 'same']])
  assert.deepEqual(result.added, ['v2-B9'])
  assert.deepEqual(result.removed, ['L-B2'])
  assert.deepEqual(result.summary, { same: 1, changed: 0, moved: 0, uncertain: 0, keyReused: 0, added: 1, removed: 1 })
})

const splitHalfA = '로그인은 휴대폰 번호와 인증 문자로 합니다. 인증 문자는 3분 안에 입력해야 합니다.'
const splitHalfB = '비밀번호를 다섯 번 틀리면 10분 동안 잠기고, 잠긴 동안에는 관리자가 풀어 줄 수 있습니다.'

test('쪼개진 항목: 더 비슷한 쪽이 잇고, 다른 쪽은 같은 계보를 가리키는 "비슷한 새 항목" 제안이 된다', () => {
  const previous = oldVersion([
    { key: 'A1', title: '로그인 흐름', text: `${splitHalfA} ${splitHalfB}` },
    { key: 'A2', title: '월말 보고', text: T.report },
  ])
  const result = matchAnchors(previous, newVersion([
    { key: 'B1', title: '로그인 흐름', text: `${splitHalfA} ${splitHalfB} 잠금은 기록에 남습니다.` },
    { key: 'B2', title: '로그인 흐름 잠금', text: `${splitHalfB}` },
    { key: 'A2', title: '월말 보고', text: T.report },
  ]))
  const winner = findLink(result, 'v2-B1')
  const other = findLink(result, 'v2-B2')
  assert.equal(winner.status, 'moved')
  assert.equal(winner.lineageId, 'L-A1')
  assert.equal(other.status, 'uncertain')
  assert.equal(other.lineageId, 'L-A1', '같은 계보를 가리킨다')
  assert.equal(other.similar, true)
  assert.ok(other.score >= 0.45 && other.score < winner.score)
  assert.deepEqual(result.added, ['v2-B2'], '확인 전에는 새 항목')
  assert.deepEqual(result.removed, [])
  assert.equal(result.summary.uncertain, 1)
})

test('쪼개진 반쪽이 번호를 지켜도 나머지 반쪽에 "비슷한 새 항목"을 알린다', () => {
  const result = matchAnchors(
    oldVersion([{ key: 'A1', title: '로그인 흐름', text: `${splitHalfA} ${splitHalfB}` }]),
    newVersion([
      { key: 'A1', title: '로그인 흐름', text: splitHalfA },
      { key: 'A1-2', title: '로그인 흐름 잠금', text: splitHalfB },
    ]),
  )
  assert.equal(findLink(result, 'v2-A1').status, 'changed')
  const other = findLink(result, 'v2-A1-2')
  assert.equal(other.status, 'uncertain')
  assert.equal(other.lineageId, 'L-A1')
  assert.equal(other.similar, true)
})

test('애매한 쌍(0.45~0.75)은 "확인 필요" 제안이고 진짜 연결이 아니다', () => {
  const result = matchAnchors(
    oldVersion([{ key: 'A3', title: '결제 실패 안내', text: T.payment }]),
    newVersion([{ key: 'Z1', title: '카드 등록 오류 처리', text: T.payment }]),
  )
  const entry = findLink(result, 'v2-Z1')
  assert.equal(entry.status, 'uncertain')
  assert.equal(entry.similar, undefined)
  assert.ok(entry.score >= 0.45 && entry.score < 0.75, `${entry.score}`)
  assert.deepEqual(result.added, ['v2-Z1'])
  assert.deepEqual(result.removed, ['L-A3'])
})

test('사람의 선택: [같은 항목]은 진짜 연결로, [다른 항목]은 새 항목으로, 고르지 않은 제안은 그대로', () => {
  const previous = oldVersion([
    { key: 'A1', title: '결제 실패 안내', text: T.payment },
    { key: 'A3', title: '연차 승인', text: T.leave },
  ])
  const result = matchAnchors(previous, newVersion([
    { key: 'A1', title: '회원 탈퇴 절차', text: T.withdraw },
    { key: 'Z1', title: '휴가 결재 순서', text: T.leave },
  ]))
  assert.equal(findLink(result, 'v2-A1').status, 'key-reused')
  assert.equal(findLink(result, 'v2-Z1').status, 'uncertain')
  const snapshot = JSON.stringify(result)

  const confirmed = applyHumanChoices(result, [
    { nextId: 'v2-A1', lineageId: 'L-A1', same: true },
    { nextId: 'v2-Z1', lineageId: 'L-A3', same: true },
  ])
  assert.equal(findLink(confirmed, 'v2-A1').status, 'changed', '같은 번호 → 바뀜')
  assert.equal(findLink(confirmed, 'v2-Z1').status, 'moved', '다른 번호 → 옮김')
  assert.equal(findLink(confirmed, 'v2-Z1').confirmed, true)
  assert.deepEqual(confirmed.added, [])
  assert.deepEqual(confirmed.removed, [])
  assert.deepEqual(confirmed.summary, { same: 0, changed: 1, moved: 1, uncertain: 0, keyReused: 0, added: 0, removed: 0 })
  assert.equal(JSON.stringify(result), snapshot, '원래 결과는 바꾸지 않는다')

  const rejected = applyHumanChoices(result, [{ nextId: 'v2-A1', lineageId: 'L-A1', same: false }])
  assert.equal(findLink(rejected, 'v2-A1'), undefined, '[다른 항목]이면 줄이 사라진다')
  assert.deepEqual(rejected.added, ['v2-A1', 'v2-Z1'], '고르지 않은 Z1은 여전히 제안 → 새 항목 취급')
  assert.equal(findLink(rejected, 'v2-Z1').status, 'uncertain')
  assert.deepEqual(rejected.summary, { same: 0, changed: 0, moved: 0, uncertain: 1, keyReused: 0, added: 2, removed: 2 })

  const ignored = applyHumanChoices(result, [{ nextId: 'v2-A1', lineageId: 'L-없음', same: true }, { nextId: 'v2-A1' }])
  assert.deepEqual(ignored.links, result.links, '목록에 없는 쌍·답 없는 선택은 무시')
})

test('사람이 "비슷한 새 항목" 쪽을 고르면 그쪽이 잇고, 먼저 잇던 쪽은 제안으로 내려온다', () => {
  const result = matchAnchors(
    oldVersion([{ key: 'A1', title: '로그인 흐름', text: `${splitHalfA} ${splitHalfB}` }]),
    newVersion([
      { key: 'B1', title: '로그인 흐름', text: `${splitHalfA} ${splitHalfB} 잠금은 기록에 남습니다.` },
      { key: 'B2', title: '로그인 흐름 잠금', text: splitHalfB },
    ]),
  )
  const switched = applyHumanChoices(result, [{ nextId: 'v2-B2', lineageId: 'L-A1', same: true }])
  assert.equal(findLink(switched, 'v2-B2').status, 'moved')
  const demoted = findLink(switched, 'v2-B1')
  assert.equal(demoted.status, 'uncertain')
  assert.equal(demoted.similar, true)
  const final = finalizeLinks(switched)
  assert.equal(final.byNextId.get('v2-B2').lineageId, 'L-A1')
  assert.deepEqual(final.added, ['v2-B1'])
  assert.deepEqual(final.removed, [])
})

test('게시할 때: 확인받지 못한 제안은 "다른 항목" — 새 항목은 added, 옛 계보는 removed', () => {
  const result = matchAnchors(
    oldVersion([
      { key: 'A1', title: '결제 실패 안내', text: T.payment },
      { key: 'A2', title: '로그인 방식', text: T.login },
      { key: 'A3', title: '연차 승인', text: T.leave },
    ]),
    newVersion([
      { key: 'A1', title: '회원 탈퇴 절차', text: T.withdraw },
      { key: 'A2', title: '로그인 방식', text: T.login },
      { key: 'Z1', title: '휴가 결재 순서', text: T.leave },
    ]),
  )
  const final = finalizeLinks(result)
  assert.deepEqual([...final.byNextId.entries()], [['v2-A2', { lineageId: 'L-A2', status: 'same', score: 1, textChanged: false }]])
  assert.deepEqual(final.added, ['v2-A1', 'v2-Z1'])
  assert.deepEqual(final.removed, ['L-A1', 'L-A3'])
})

test('같은 내용이 두 번 있으면 문서 순서대로 짝짓는다', () => {
  const result = matchAnchors(
    oldVersion([
      { key: 'P1', title: '확인', text: T.report },
      { key: 'P2', title: '확인', text: T.report },
    ]),
    newVersion([
      { key: 'Q1', title: '확인', text: T.report },
      { key: 'Q2', title: '확인', text: T.report },
    ]),
  )
  assert.deepEqual(result.links.filter((entry) => entry.status === 'moved').map((entry) => [entry.nextId, entry.lineageId]), [
    ['v2-Q1', 'L-P1'],
    ['v2-Q2', 'L-P2'],
  ])
})

test('내용이 똑같은 행이 아주 많아 흔한 조각이 색인에서 빠져도, 내용 해시로 찾아 순서대로 잇는다', () => {
  const rows = Array.from({ length: 400 }, (_, index) => ({ key: `R${index}`, title: '확인 사항', text: '해당 없음. 다음 회의에서 다시 확인합니다.' }))
  const previous = oldVersion(rows)
  const next = newVersion(rows.map((row, index) => ({ ...row, key: `S${index}` })))
  const result = matchAnchors(previous, next, { exactPairLimit: 0 })
  assert.equal(result.summary.moved, 400)
  assert.ok(result.links.every((entry) => entry.lineageId === `L-R${entry.nextId.slice('v2-S'.length)}`), '문서 순서대로 짝')
})

// ── 합성 자료 ──────────────────────────────────────────────

function random(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

const SYLLABLES = [...'가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허고노도로모보소오조초코토포호구누두루무부수우주추쿠투푸후기니디리미비시이지치키티피히결제화면등록실패안내회의일정검토']

function vocabulary(next, size) {
  const words = new Set()
  while (words.size < size) {
    const length = 2 + Math.floor(next() * 3)
    let word = ''
    for (let index = 0; index < length; index += 1) word += SYLLABLES[Math.floor(next() * SYLLABLES.length)]
    words.add(word)
  }
  return [...words]
}

/**
 * 지난 판 count개, 새 판은 키를 전부 바꾸고 순서를 섞은 것(1단계로는 하나도 못 잇는 최악의 경우).
 * 15%는 어절 3개를 바꾸고, 10%는 제목 끝을 고치고, 5%는 빼고 전혀 새 항목을 넣는다.
 */
function syntheticVersions(count, { seed = 7, template = '', words: wordCount = 50 } = {}) {
  const next = random(seed)
  const words = vocabulary(next, 1500)
  const pick = () => words[Math.floor(next() * words.length)]
  const sentence = (length) => Array.from({ length }, pick).join(' ')
  const previous = []
  for (let index = 0; index < count; index += 1) {
    const kind = index % 5 === 0 ? 'section' : 'item'
    previous.push(anchor({
      id: `v1-${index}`, key: `K-${index}`, lineageId: `L-${index}`, kind, order: index,
      title: `${pick()} ${pick()} ${index}`, text: `${template}${sentence(wordCount)}`,
    }))
  }
  const expected = new Map()
  const rows = []
  for (const [index, old] of previous.entries()) {
    const roll = next()
    if (roll < 0.05) {
      rows.push({ key: `N-new-${index}`, kind: old.kind, title: `${pick()} ${pick()} 새 ${index}`, text: `${template}${sentence(wordCount)}` })
      continue
    }
    let text = old.text
    let title = old.title
    if (roll < 0.2) {
      const tokens = text.split(' ')
      for (let edit = 0; edit < 3; edit += 1) tokens[tokens.length - 1 - Math.floor(next() * 45)] = pick()
      text = tokens.join(' ')
    } else if (roll < 0.3) title = `${title} 수정`
    rows.push({ key: `N-${index}`, kind: old.kind, title, text })
    expected.set(`v2-N-${index}`, old.lineageId)
  }
  for (let index = rows.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1))
    ;[rows[index], rows[swap]] = [rows[swap], rows[index]]
  }
  return { previous, next: newVersion(rows), expected }
}

function accuracy(result, expected) {
  const final = finalizeLinks(result)
  let correct = 0
  for (const [nextId, lineageId] of expected) if (final.byNextId.get(nextId)?.lineageId === lineageId) correct += 1
  return { correct, total: expected.size, wrong: [...final.byNextId].filter(([nextId, value]) => expected.get(nextId) !== value.lineageId).length }
}

test('후보 줄이기(색인)를 써도 전부 정밀 계산한 결과와 같다', () => {
  const { previous, next, expected } = syntheticVersions(300, { seed: 11 })
  const exact = matchAnchors(previous, next, { exactPairLimit: Infinity })
  const indexed = matchAnchors(previous, next, { exactPairLimit: 0 })
  assert.deepEqual(finalizeLinks(indexed), finalizeLinks(exact))
  assert.deepEqual(indexed.summary, exact.summary)
  const score = accuracy(indexed, expected)
  assert.equal(score.wrong, 0)
  assert.equal(score.correct, score.total)
})

test('성능: 2000×2000 항목(키 전부 바뀜)도 2초 안에 잇는다', () => {
  const scenarios = [
    ['서로 다른 글', syntheticVersions(2000, { seed: 3 })],
    ['표 머리글처럼 공통 문구가 많은 글', syntheticVersions(2000, { seed: 5, template: '심각도 높음 담당 개발팀 상태 열림 재현 절차 첨부 확인 필요 비고 없음 ' })],
    ['항목마다 약 1,500자인 긴 글', syntheticVersions(2000, { seed: 13, words: 375 })],
  ]
  for (const [label, { previous, next, expected }] of scenarios) {
    const started = performance.now()
    const result = matchAnchors(previous, next)
    const elapsed = performance.now() - started
    const score = accuracy(result, expected)
    console.log(`[material-lineage] ${label}: ${previous.length}×${next.length} ${elapsed.toFixed(0)}ms, 맞게 이음 ${score.correct}/${score.total}, 잘못 이음 ${score.wrong}, 요약 ${JSON.stringify(result.summary)}`)
    assert.ok(elapsed < 2000, `${label}: ${elapsed.toFixed(0)}ms`)
    assert.equal(score.wrong, 0, `${label}: 잘못 이은 항목이 없어야 한다`)
    assert.ok(score.correct / score.total >= 0.99, `${label}: ${score.correct}/${score.total}`)
  }
})

// ── 글자 비교 ──────────────────────────────────────────────

const rebuildSide = (ops, side, separator = ' ') => ops.filter((entry) => entry.op === 'equal' || entry.op === side).map((entry) => entry.text).join(separator)

test('어절 비교: 한국어 어절을 쪼개지 않고, 바뀐 곳은 삭제 다음 추가로 모은다', () => {
  assert.deepEqual(wordDiff('회의는 월요일 오전 10시에 합니다', '회의는 화요일 오전 10시에 합니다'), [
    { op: 'equal', text: '회의는' },
    { op: 'delete', text: '월요일' },
    { op: 'insert', text: '화요일' },
    { op: 'equal', text: '오전 10시에 합니다' },
  ])
  assert.deepEqual(wordDiff('가 나 다', '가 나 다'), [{ op: 'equal', text: '가 나 다' }])
  assert.deepEqual(wordDiff('', '가 나'), [{ op: 'insert', text: '가 나' }])
  assert.deepEqual(wordDiff('가 나', ''), [{ op: 'delete', text: '가 나' }])
  assert.deepEqual(wordDiff('', ''), [])
  assert.deepEqual(wordDiff('가\n나   다', '가 나 다'), [{ op: 'equal', text: '가 나 다' }], '공백 모양 차이는 차이가 아니다')
})

test('어절 비교: 무작위 입력에서 양쪽 글이 되살아나고 같은 어절 수가 최대(LCS)다', () => {
  const next = random(42)
  const alphabet = ['가', '나', '다', '라', '마']
  const lcs = (a, b) => {
    const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
    for (let i = 1; i <= a.length; i += 1) {
      for (let j = 1; j <= b.length; j += 1) table[i][j] = a[i - 1] === b[j - 1] ? table[i - 1][j - 1] + 1 : Math.max(table[i - 1][j], table[i][j - 1])
    }
    return table[a.length][b.length]
  }
  for (let round = 0; round < 300; round += 1) {
    const a = Array.from({ length: Math.floor(next() * 12) }, () => alphabet[Math.floor(next() * alphabet.length)])
    const b = Array.from({ length: Math.floor(next() * 12) }, () => alphabet[Math.floor(next() * alphabet.length)])
    const ops = wordDiff(a.join(' '), b.join(' '))
    assert.equal(rebuildSide(ops, 'delete'), a.join(' '))
    assert.equal(rebuildSide(ops, 'insert'), b.join(' '))
    const equalCount = ops.filter((entry) => entry.op === 'equal').reduce((sum, entry) => sum + entry.text.split(' ').length, 0)
    assert.equal(equalCount, lcs(a, b), `${a.join('')} → ${b.join('')}`)
    for (let index = 1; index < ops.length; index += 1) assert.notEqual(ops[index].op, ops[index - 1].op, '같은 종류 조각은 합친다')
  }
})

test('어절 비교: 4,000자에서 자르고 마지막 조각에 표시한다', () => {
  const before = Array.from({ length: 2000 }, (_, index) => `어절${index}`).join(' ')
  const after = `${before} 끝에추가`
  const ops = wordDiff(before, after)
  const total = ops.reduce((sum, entry) => sum + entry.text.length, 0)
  assert.ok(total <= 4000, `${total}`)
  assert.equal(ops.at(-1).truncated, true)
  assert.ok(ops.at(-1).text.endsWith('…'))
  assert.deepEqual(wordDiff('가 나 다다다 라', '가 나 마 라', { maxChars: 5 }), [
    { op: 'equal', text: '가 나' },
    { op: 'delete', text: '다…', truncated: true },
  ])
  assert.deepEqual(wordDiff('가 나 다 라', '가 나 마 라', { maxChars: 3 }), [{ op: 'equal', text: '가 나', truncated: true }], '딱 찼으면 앞 조각에 표시')
})

test('긴 글: 한 곳만 고쳤으면 어절 비교, 여기저기 많이 바뀌었으면 문단 단위로 거칠게 비교한다', () => {
  const paragraph = (index, variant = '') => Array.from({ length: 40 }, (_, word) => `문단${index}어절${word}${variant}`).join(' ')
  const beforeParagraphs = Array.from({ length: 100 }, (_, index) => paragraph(index))
  const before = beforeParagraphs.join('\n')
  assert.ok(before.split(/\s+/).length > 3000)

  // 한 어절만 고친 4,000어절 글 — 앞뒤 같은 부분을 떼면 가운데는 한 어절이다.
  const oneEdit = before.replace('문단50어절7 ', '문단50어절칠 ')
  const fine = wordDiff(before, oneEdit, { maxChars: 1e9 })
  assert.equal(fine.some((entry) => entry.coarse), false)
  assert.deepEqual(fine.filter((entry) => entry.op !== 'equal'), [{ op: 'delete', text: '문단50어절7' }, { op: 'insert', text: '문단50어절칠' }])

  // 맨 앞과 맨 뒤 문단을 고치면 가운데가 3,000어절을 넘는다 → 문단 단위.
  const afterParagraphs = [...beforeParagraphs]
  afterParagraphs[0] = paragraph(0, '고침')
  afterParagraphs[99] = paragraph(99, '고침')
  afterParagraphs.splice(50, 1)
  const started = performance.now()
  const coarse = wordDiff(before, afterParagraphs.join('\n'), { maxChars: 1e9 })
  assert.ok(performance.now() - started < 500)
  assert.ok(coarse.every((entry) => entry.coarse === true))
  assert.deepEqual(coarse.map((entry) => [entry.op, entry.text.split('\n').length]), [
    ['delete', 1], ['insert', 1], ['equal', 49], ['delete', 1], ['equal', 48], ['delete', 1], ['insert', 1],
  ])
  assert.equal(rebuildSide(coarse, 'delete', '\n'), before)
  assert.equal(rebuildSide(coarse, 'insert', '\n'), afterParagraphs.join('\n'))
})

// ── 반영 확인 ──────────────────────────────────────────────

test('반영 확인: 반영하기로 한 항목 중 바뀐 것과 그대로인 것을 센다', () => {
  const links = [
    { nextId: 'n1', lineageId: 'L1', status: 'changed', score: 0.8, textChanged: true },
    { nextId: 'n2', lineageId: 'L2', status: 'same', score: 1, textChanged: false },
    { nextId: 'n3', lineageId: 'L3', status: 'changed', score: 0.7, textChanged: true },
    { nextId: 'n4', lineageId: 'L4', status: 'moved', score: 0.9, textChanged: true },
    { nextId: 'n6', lineageId: 'L6', status: 'uncertain', score: 0.6, textChanged: true },
    { nextId: 'n7', lineageId: 'L7', status: 'moved', score: 0.8, textChanged: false },
  ]
  const decisions = [
    { lineageId: 'L1', status: '반영' },
    { lineageId: 'L2', status: '보류' },
    { lineageId: 'L2', status: '수정 후 반영' }, // 나중 결정이 이긴다
    { lineageId: 'L3', status: '보류' }, // 반영이 아니면 세지 않는다
    { lineageId: 'L4', status: '반영' },
    { lineageId: 'L5', status: '반영' }, // 새 판에서 빠짐
    { lineageId: 'L6', status: '반영' }, // 확인 대기 제안은 "다른 항목"
    { lineageId: 'L7', status: '반영' }, // 자리만 옮기고 내용은 그대로
  ]
  assert.deepEqual(carryOverSummary({ decisions, links }), { reflected: 2, unchangedAfterDecision: ['L2', 'L7'], decided: 6 })
  assert.deepEqual(carryOverSummary({ decisions: [], links }), { reflected: 0, unchangedAfterDecision: [], decided: 0 })
  assert.deepEqual(carryOverSummary({}), { reflected: 0, unchangedAfterDecision: [], decided: 0 })
})

test('반영 확인: finalizeLinks의 byNextId를 그대로 넘겨도 같다', () => {
  const result = matchAnchors(
    oldVersion([
      { key: 'A1', title: '결제 실패 안내', text: T.payment },
      { key: 'A2', title: '로그인 방식', text: T.login },
    ]),
    newVersion([
      { key: 'A1', title: '결제 실패 안내', text: T.paymentReworded },
      { key: 'A2', title: '로그인 방식', text: T.login },
    ]),
  )
  const decisions = [{ lineageId: 'L-A1', status: '반영' }, { lineageId: 'L-A2', status: '수정 후 반영' }]
  const expected = { reflected: 1, unchangedAfterDecision: ['L-A2'], decided: 2 }
  assert.deepEqual(carryOverSummary({ decisions, links: result.links }), expected)
  assert.deepEqual(carryOverSummary({ decisions, links: finalizeLinks(result).byNextId }), expected)
})

// ── 적대적 검토에서 찾은 것 ─────────────────────────────────────

const REAL = new Set(['same', 'changed', 'moved'])
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

test('겹친 id·겹친 계보: 앞의 것만 보고, 결과가 서로 어긋나지 않는다', () => {
  const previous = [
    anchor({ id: 'p1', key: 'A1', lineageId: 'L1', title: '로그인 방식', text: T.login }),
    anchor({ id: 'p2', key: 'A2', lineageId: 'L1', title: '월말 보고', text: T.report }), // 계보가 겹친 깨진 자료
  ]
  const next = [
    anchor({ id: 'x', key: 'A1', title: '로그인 방식', text: T.login }),
    anchor({ id: 'x', key: 'B7', title: '로그인 방식', text: T.login }), // id가 겹친 새 항목
    anchor({ id: 'n2', key: 'A2', title: '월말 보고', text: T.report }),
  ]
  const result = matchAnchors(previous, next)
  const real = result.links.filter((entry) => REAL.has(entry.status))
  assert.equal(new Set(real.map((entry) => entry.lineageId)).size, real.length, '한 계보에 진짜 연결은 하나')
  for (const entry of real) assert.equal(result.added.includes(entry.nextId), false, `${entry.nextId}는 이어졌는데 added에도 있다`)
  assert.equal(result.links.filter((entry) => entry.nextId === 'x').length, 1, '같은 쌍이 진짜 연결과 제안으로 두 번 나오면 안 된다')
  assert.deepEqual(result.nextIds, ['x', 'n2'])
  const final = finalizeLinks(result)
  assert.deepEqual(final.added, result.added, '게시 결과와 matchAnchors 결과가 같아야 한다')
  assert.deepEqual(final.removed, result.removed)
  assert.deepEqual(result.summary, { same: 1, changed: 0, moved: 0, uncertain: 0, keyReused: 0, added: 1, removed: 0 })
})

test('밖에서 들어온 결과: 모르는 상태나 깨진 줄이 요약을 부풀리거나 멈추게 하지 않는다', () => {
  const stored = {
    links: [
      null,
      { nextId: 'n1', lineageId: 'L1', status: 'added' },
      { nextId: 'n2', lineageId: 'L2', status: 'removed' },
      { nextId: 'n3', lineageId: 'L3', status: '__proto__' },
      { nextId: 'n4', lineageId: 'L4', status: 'moved', score: 0.9, textChanged: true },
    ],
    nextIds: ['n1', 'n2', 'n3', 'n4'],
    lineageIds: ['L1', 'L2', 'L3', 'L4'],
  }
  const applied = applyHumanChoices(stored, [{ nextId: 'n1', lineageId: 'L1', same: true }])
  assert.deepEqual(applied.summary, { same: 0, changed: 0, moved: 1, uncertain: 0, keyReused: 0, added: 3, removed: 3 })
  const final = finalizeLinks(stored)
  assert.deepEqual([...final.byNextId.keys()], ['n4'])
  assert.deepEqual(final.added, ['n1', 'n2', 'n3'])
  assert.deepEqual(finalizeLinks({ links: [null, undefined, 3] }).added, [])
  assert.deepEqual(applyHumanChoices({ links: [null] }, null).links, [])
})

test('옵션 자리에 null이 와도 멈추지 않는다', () => {
  const previous = oldVersion([{ key: 'A1', title: '로그인 방식', text: T.login }])
  assert.equal(matchAnchors(previous, newVersion([{ key: 'A1', title: '로그인 방식', text: T.login }]), null).summary.same, 1)
  assert.deepEqual(wordDiff('가 나', '가 다', null), [{ op: 'equal', text: '가' }, { op: 'delete', text: '나' }, { op: 'insert', text: '다' }])
  assert.deepEqual(carryOverSummary(null), { reflected: 0, unchangedAfterDecision: [], decided: 0 })
})

test('글자 비교 자르기: 이모지를 반으로 자르지 않고, 아주 작은 한도에서도 잘렸다는 표시를 남긴다', () => {
  const ops = wordDiff('😀😀😀😀 가', '가', { maxChars: 4 })
  for (const entry of ops) assert.equal(loneSurrogate.test(entry.text), false, `깨진 글자: ${JSON.stringify(entry.text)}`)
  assert.equal(ops.at(-1).truncated, true)
  for (const maxChars of [1, 0.5]) {
    const tiny = wordDiff('가나다', '라마바', { maxChars })
    assert.ok(tiny.length > 0, `maxChars ${maxChars}: 빈 배열이면 "바뀐 곳 없음"과 구별되지 않는다`)
    assert.equal(tiny.at(-1).truncated, true)
    assert.ok(tiny.reduce((sum, entry) => sum + entry.text.length, 0) <= 1)
  }
})

test('통째로 고쳐 쓴 긴 글: 잘려도 새 글(추가)이 사라지지 않는다', () => {
  // 항목 글은 줄바꿈이 없다(항목 인식이 공백을 하나로 모은다). 문단 비교로 넘어가면 삭제 하나·추가 하나가 된다.
  const before = Array.from({ length: 4000 }, (_, index) => `앞글${index}`).join(' ')
  const after = Array.from({ length: 4000 }, (_, index) => `뒷글${index}`).join(' ')
  const cases = [
    ['문단 비교(3,000어절 넘음)', before, after],
    ['어절 비교(약 900어절)', before.slice(0, 5000), after.slice(0, 5000)],
  ]
  for (const [label, a, b] of cases) {
    const ops = wordDiff(a, b)
    const total = ops.reduce((sum, entry) => sum + entry.text.length, 0)
    assert.ok(total <= 4000, `${label}: ${total}`)
    const deleted = ops.find((entry) => entry.op === 'delete')
    const inserted = ops.find((entry) => entry.op === 'insert')
    assert.ok(inserted && inserted.text.length > 1000, `${label}: 새 글이 적어도 일부는 보여야 한다`)
    assert.ok(b.startsWith(inserted.text.replace(/…$/, '')), label)
    assert.ok(a.startsWith(deleted.text.replace(/…$/, '')), label)
    assert.equal(ops.at(-1).truncated, true, label)
  }
  // 추가가 짧으면 남는 자리는 삭제가 쓴다.
  const short = wordDiff(before, '짧은 새 글')
  assert.deepEqual(short.at(-1), { op: 'insert', text: '짧은 새 글', coarse: true, truncated: true })
  assert.equal(short.reduce((sum, entry) => sum + entry.text.length, 0), 4000)
})

test('성능: 쌍은 적어도(141×141) 항목마다 2만 자인 긴 글이면 2초 안에 잇는다', () => {
  const next = random(21)
  const words = vocabulary(next, 3000)
  const pick = () => words[Math.floor(next() * words.length)]
  const long = () => {
    const parts = []
    let length = 0
    while (length < 20000) {
      const word = pick()
      parts.push(word)
      length += word.length + 1
    }
    return parts.join(' ')
  }
  const previous = Array.from({ length: 141 }, (_, index) => anchor({
    id: `v1-${index}`, key: `K-${index}`, lineageId: `L-${index}`, order: index, title: `원문 ${index}`, text: long(),
  }))
  const nextRows = previous.map((old, index) => {
    const tokens = old.text.split(' ')
    for (let edit = 0; edit < 5; edit += 1) tokens[Math.floor(next() * tokens.length)] = pick()
    return anchor({ id: `v2-${index}`, key: `N-${index}`, order: index, title: old.title, text: tokens.join(' ') })
  })
  const started = performance.now()
  const result = matchAnchors(previous, nextRows)
  const elapsed = performance.now() - started
  console.log(`[material-lineage] 긴 원문 141×141(항목마다 2만 자): ${elapsed.toFixed(0)}ms, 요약 ${JSON.stringify(result.summary)}`)
  assert.ok(elapsed < 2000, `${elapsed.toFixed(0)}ms`)
  assert.equal(result.summary.moved, 141)
  assert.ok(result.links.every((entry) => entry.lineageId === `L-${entry.nextId.slice('v2-'.length)}`))
})

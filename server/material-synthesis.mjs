/**
 * 검토 자료의 정리 — 규칙 정리(AI 없이)와 AI 정리의 프롬프트·검증. 저장소를 모르는 순수 함수.
 *
 * 원칙:
 *  - **AI 없이도 한 바퀴가 돈다.** 쟁점(의견 갈림)·답 없는 질문·아무도 반응하지 않은 결정 항목은 규칙으로 센다.
 *  - **AI의 정리는 초안이다.** 모든 주장에 근거 의견 id가 붙어야 하고, 없는 id를 댄 주장은 버린다.
 *    결정·찬반은 AI가 하지 않는다 — 결정 초안은 사람이 [이대로 결정]을 눌러야 결정이 된다.
 */

export const STANCE_WORDS = Object.freeze({ agree: '찬성', amend: '수정해서', oppose: '반대', question: '질문' })
const DECISION_WORDS = ['반영', '수정 후 반영', '보류', '미반영']

/**
 * 규칙으로 만든 회의 준비표.
 * items: [{ lineageId, key, title, decisionEnabled }] (이번 판 순서)
 * summary: { [lineageId]: { comments, openQuestions, stances } }
 * decisions: Map<lineageId, { status }>
 * comments: [{ id, lineageId, parentId, question, body, authorName, deleted }]
 */
export function ruleOverview({ items, summary, decisions, comments }) {
  const answered = new Set(comments.filter((row) => row.parentId && !row.deleted).map((row) => row.parentId))
  const split = []
  const openQuestions = []
  const silent = []
  const ready = []
  for (const item of items) {
    const tally = summary[item.lineageId]?.stances ?? { agree: 0, amend: 0, oppose: 0, question: 0 }
    const reactions = tally.agree + tally.amend + tally.oppose + tally.question
    const commentCount = summary[item.lineageId]?.comments ?? 0
    if (tally.agree > 0 && (tally.oppose > 0 || tally.amend > 0)) split.push({ lineageId: item.lineageId, key: item.key, title: item.title, stances: tally })
    for (const question of comments.filter((row) => row.lineageId === item.lineageId && !row.parentId && !row.deleted && row.question && !answered.has(row.id))) {
      openQuestions.push({ lineageId: item.lineageId, key: item.key, title: item.title, commentId: question.id, body: String(question.body).slice(0, 200), authorName: question.authorName })
    }
    if (!item.decisionEnabled || decisions.has(item.lineageId)) continue
    if (!reactions && !commentCount) { silent.push({ lineageId: item.lineageId, key: item.key, title: item.title }); continue }
    // 규칙 제안 — 사람이 결정하기 쉽게 한 줄만. "AI가 정했다"로 읽히지 않도록 화면에 '규칙'이라고 적는다.
    let suggestion = null
    if (tally.oppose === 0 && tally.amend === 0 && tally.agree >= 2) suggestion = '반영'
    else if (tally.amend > 0 && tally.oppose === 0) suggestion = '수정 후 반영'
    else if (tally.oppose > tally.agree + tally.amend) suggestion = '미반영'
    else if (tally.question > 0 && tally.agree + tally.amend + tally.oppose === 0) suggestion = '보류'
    if (suggestion) ready.push({ lineageId: item.lineageId, key: item.key, title: item.title, suggestion, stances: tally })
  }
  return { split, openQuestions, silent, ready }
}

/** 한 항목의 AI 정리 프롬프트. 의견 원문과 id를 함께 준다(근거로 되짚을 수 있게). */
export function buildItemSynthesisPrompt({ materialTitle, item, comments, stances }) {
  const system = [
    '당신은 회사 회의 자료의 한 항목에 대한 직원 의견을 정리하는 비서다.',
    '규칙:',
    '1) 의견에 없는 내용을 지어내지 않는다. 모든 문장에 근거가 된 의견 id를 feedbackIds로 붙인다.',
    '2) 결정은 사람이 한다. draftDecision은 초안일 뿐이며, 근거가 부족하면 null로 둔다.',
    `3) draftDecision.status는 ${DECISION_WORDS.join(' · ')} 중 하나다.`,
    '4) 쉬운 한국어로, 짧게. summary는 두 문장 이내.',
    '5) 반드시 JSON 하나만 출력한다: {"summary":string,"positions":[{"stance":"agree|amend|oppose|question","points":[{"text":string,"feedbackIds":[string]}]}],"questions":[{"text":string,"feedbackIds":[string]}],"draftDecision":{"status":string,"note":string,"feedbackIds":[string]}|null}',
  ].join('\n')
  const lines = comments.slice(0, 120).map((row) => `- [${row.id}] ${row.authorName}${row.stance ? `(${STANCE_WORDS[row.stance]})` : ''}${row.question ? '(질문)' : ''}: ${String(row.body).replace(/\s+/g, ' ').slice(0, 600)}`)
  const user = [
    `자료: ${materialTitle}`,
    `항목: ${item.key ? `${item.key} ` : ''}${item.title}`,
    `항목 내용(앞부분): ${String(item.text ?? '').replace(/\s+/g, ' ').slice(0, 2_500)}`,
    `찬반 집계: 찬성 ${stances.agree} · 수정해서 ${stances.amend} · 반대 ${stances.oppose} · 질문 ${stances.question}`,
    '의견:',
    ...(lines.length ? lines : ['(의견 없음)']),
  ].join('\n')
  return { system, user }
}

const parseJson = (text) => {
  const source = String(text ?? '').trim()
  const start = source.indexOf('{')
  const end = source.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(source.slice(start, end + 1)) } catch { return null }
}

/**
 * AI 출력 검증. **없는 의견 id를 댄 주장은 버린다**(근거 없는 문장은 사람에게 보이지 않는다).
 * 결정 초안도 근거가 하나도 남지 않으면 버린다.
 * @returns {{ summary, positions, questions, draftDecision, dropped } | null}
 */
export function validateItemSynthesis(text, commentIds) {
  const parsed = parseJson(text)
  if (!parsed || typeof parsed !== 'object') return null
  const known = new Set(commentIds)
  let dropped = 0
  const cleanIds = (ids) => [...new Set((Array.isArray(ids) ? ids : []).map(String).filter((id) => known.has(id)))].slice(0, 20)
  const point = (row) => {
    const text = String(row?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 400)
    const feedbackIds = cleanIds(row?.feedbackIds)
    if (!text || !feedbackIds.length) { dropped += 1; return null }
    return { text, feedbackIds }
  }
  const positions = (Array.isArray(parsed.positions) ? parsed.positions : [])
    .filter((row) => Object.hasOwn(STANCE_WORDS, row?.stance))
    .map((row) => ({ stance: row.stance, points: (Array.isArray(row.points) ? row.points : []).map(point).filter(Boolean).slice(0, 8) }))
    .filter((row) => row.points.length)
  const questions = (Array.isArray(parsed.questions) ? parsed.questions : []).map(point).filter(Boolean).slice(0, 8)
  let draftDecision = null
  if (parsed.draftDecision && DECISION_WORDS.includes(String(parsed.draftDecision.status))) {
    const feedbackIds = cleanIds(parsed.draftDecision.feedbackIds)
    if (feedbackIds.length) draftDecision = { status: String(parsed.draftDecision.status), note: String(parsed.draftDecision.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 500), feedbackIds }
    else dropped += 1
  }
  const summary = String(parsed.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 400)
  if (!summary && !positions.length && !questions.length) return null
  return { summary, positions, questions, draftDecision, dropped }
}

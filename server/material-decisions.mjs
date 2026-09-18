/**
 * 검토 자료의 결정·가져오기·요약 — 저장소를 모르는 순수 함수들.
 * 라우트는 review-materials.mjs에 있다.
 */

/** 결정. 화면에서도 이 말 그대로 쓴다. 결정은 지우지 않고 새 줄로만 덮는다(이력이 저절로 남는다). */
export const DECISIONS = Object.freeze(['반영', '수정 후 반영', '보류', '미반영'])

/**
 * AI가 만든 자료 속 검토 기능이 쓰던 찬반 코드 → 앱의 찬반.
 * (예시 자료: agree 찬성 · revise 수정해서 · disagree 반대 · ask 질문)
 */
const STANCE_ALIASES = Object.freeze({
  agree: 'agree', yes: 'agree', approve: 'agree', 찬성: 'agree',
  revise: 'amend', amend: 'amend', modify: 'amend', 수정: 'amend', 수정해서: 'amend',
  disagree: 'oppose', oppose: 'oppose', no: 'oppose', reject: 'oppose', 반대: 'oppose',
  ask: 'question', question: 'question', 질문: 'question',
})
export const importedStance = (value) => STANCE_ALIASES[String(value ?? '').trim().toLowerCase()] ?? STANCE_ALIASES[String(value ?? '').trim()] ?? null
const importedDecision = (value) => (DECISIONS.includes(String(value ?? '').trim()) ? String(value).trim() : null)

/**
 * 붙여 넣은 글에서 `{"type":"…-review", …}` 묶음을 모두 꺼낸다. 앞뒤에 사람이 쓴 글이 섞여 있어도 된다.
 * 중괄호 균형을 세어 자르고(문자열 안의 중괄호는 무시), JSON으로 읽히는 것만 받는다.
 */
export function extractReviewBlocks(text, { maxBlocks = 50 } = {}) {
  const source = String(text ?? '')
  const blocks = []
  const pattern = /\{\s*"type"\s*:\s*"[A-Za-z0-9_-]*review"/g
  let match
  while ((match = pattern.exec(source)) && blocks.length < maxBlocks) {
    let depth = 0
    let inString = false
    let escaped = false
    let end = -1
    for (let index = match.index; index < source.length; index += 1) {
      const char = source[index]
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') inString = true
      else if (char === '{') depth += 1
      else if (char === '}') {
        depth -= 1
        if (depth === 0) { end = index + 1; break }
      }
    }
    if (end < 0) break
    try {
      const parsed = JSON.parse(source.slice(match.index, end))
      if (parsed && typeof parsed === 'object') blocks.push(parsed)
    } catch { /* 잘린 묶음은 건너뛴다 */ }
    pattern.lastIndex = end
  }
  return blocks
}

/**
 * 가져온 묶음 → 앱의 기록 줄 초안. 항목 번호(자료 속 id)를 앵커 키로 계보에 잇는다.
 * 같은 사람·같은 항목의 같은 글은 한 번만 들어간다(여러 사람이 같은 묶음을 붙여 넣어도).
 * @returns {{ stances: Array, comments: Array, decisions: Array, unmatchedKeys: string[], people: string[] }}
 */
export function planImportedReviews(blocks, { lineageByKey }) {
  const stances = []
  const comments = []
  const decisions = []
  const unmatched = new Set()
  const people = new Set()
  const seen = new Set()
  const once = (key) => { if (seen.has(key)) return false; seen.add(key); return true }
  for (const block of blocks) {
    const reviews = block?.reviews && typeof block.reviews === 'object' ? block.reviews : {}
    for (const [name, byItem] of Object.entries(reviews)) {
      const person = String(name ?? '').trim().slice(0, 40)
      if (!person || !byItem || typeof byItem !== 'object') continue
      people.add(person)
      for (const [itemKey, review] of Object.entries(byItem)) {
        const lineageId = lineageByKey.get(String(itemKey))
        if (!lineageId) { unmatched.add(String(itemKey)); continue }
        const stance = importedStance(review?.stance)
        if (stance && once(`s|${person}|${lineageId}|${stance}`)) stances.push({ person, lineageId, stance, at: review?.at ?? block?.at ?? null })
        for (const comment of Array.isArray(review?.comments) ? review.comments : []) {
          const body = String(comment?.t ?? comment?.text ?? comment?.body ?? '').replace(/\r\n/g, '\n').trim().slice(0, 2_000)
          if (body && once(`c|${person}|${lineageId}|${body}`)) comments.push({ person, lineageId, body, at: comment?.at ?? block?.at ?? null })
        }
      }
    }
    const finals = block?.final && typeof block.final === 'object' ? block.final : {}
    for (const [itemKey, final] of Object.entries(finals)) {
      const lineageId = lineageByKey.get(String(itemKey))
      if (!lineageId) { unmatched.add(String(itemKey)); continue }
      const status = importedDecision(final?.status)
      if (status && once(`d|${lineageId}|${status}|${final?.note ?? ''}`)) decisions.push({ lineageId, status, note: String(final?.note ?? '').trim().slice(0, 500), at: block?.at ?? null })
    }
  }
  return { stances, comments, decisions, unmatchedKeys: [...unmatched].slice(0, 50), people: [...people] }
}

const stanceWord = { agree: '찬성', amend: '수정해서', oppose: '반대', question: '질문' }

/**
 * 결정 요약(Markdown). 인쇄·내려받기·결정 기록 문서가 같은 한 벌을 쓴다.
 * items: [{ key, title, decision: { status, note, decidedByName, decidedAt } | null, stances: {agree,amend,oppose,question}, comments }]
 */
export function decisionSummaryMarkdown({ title, version, generatedAt, items }) {
  const lines = [`# ${title} — 결정 요약`, '', `${version}판 기준 · ${generatedAt}`, '']
  const groups = [...DECISIONS, '미정']
  for (const group of groups) {
    const rows = items.filter((item) => (item.decision?.status ?? '미정') === group)
    if (!rows.length) continue
    lines.push(`## ${group} (${rows.length})`, '')
    for (const item of rows) {
      const tally = Object.entries(item.stances ?? {}).filter(([, count]) => count > 0).map(([stance, count]) => `${stanceWord[stance]} ${count}`).join(' · ')
      lines.push(`- **${item.key ? `${item.key} ` : ''}${item.title}**${tally ? ` — ${tally}` : ''}${item.comments ? ` · 의견 ${item.comments}` : ''}`)
      if (item.decision?.note) lines.push(`  - 메모: ${item.decision.note}`)
      if (item.decision?.decidedByName) lines.push(`  - 결정: ${item.decision.decidedByName}${item.decision.decidedAt ? ` · ${item.decision.decidedAt.slice(0, 10)}` : ''}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/** AI에게 다음 판을 만들게 할 때 함께 주는 항목 번호 규칙. 지키면 다음 판의 항목이 번호만으로 정확히 이어진다. */
export const AUTHORING_RULES = Object.freeze([
  '`<meta name="itf:material" content="(이 자료의 키)">`와 `<meta name="itf:version-note" content="(이번 판에서 바뀐 것 한 줄)">`을 넣는다.',
  '결정 받을 항목은 `<article data-itf-anchor="A1" data-itf-kind="proposal">`로 감싸고 제목은 하나만 둔다.',
  '지난 판과 같은 항목은 같은 번호를 쓰고, 없앤 번호는 다시 쓰지 않는다.',
  '파일은 30MB 이하로 만든다(그림은 앱이 떼어 따로 보관한다).',
  '자료 안에 의견·결정 저장 기능(localStorage, 복사·붙여넣기 공유 등)을 만들지 않는다 — 의견은 앱에서 남긴다.',
  '글꼴 외에는 외부로 통신하지 않는다(앱은 외부 통신을 막는다).',
])

/**
 * 다음 판 요청서(Markdown). AI 없이 규칙으로 조립한다 — 결정·업무 상태·남은 질문·의견 요약·번호 규칙.
 * items: [{ key, title, decision: {status, note}|null, task: {status, workStatus}|null, stances, comments, openQuestions: [text], samples: [{stance, body}] }]
 */
export function nextVersionRequestMarkdown({ title, version, materialKey, items }) {
  const lines = [
    `# 「${title}」 ${version + 1}판 요청서`,
    '',
    `아래는 ${version}판에 대한 팀의 결정과 의견입니다. 이것을 반영해 ${version + 1}판을 HTML 한 파일로 만들어 주세요.`,
    '',
    '## 지켜 주세요 (항목 번호 규칙)',
    '',
    ...AUTHORING_RULES.map((rule, index) => `${index + 1}. ${rule}`),
    materialKey ? `\n이 자료의 키: \`${materialKey}\`` : '',
    '',
  ]
  const decided = items.filter((item) => item.decision)
  const pending = items.filter((item) => !item.decision && (item.comments || Object.values(item.stances ?? {}).some(Boolean)))
  if (decided.length) {
    lines.push('## 결정된 항목 — 이대로 반영해 주세요', '')
    for (const item of decided) {
      lines.push(`### ${item.key ? `${item.key} ` : ''}${item.title}`)
      lines.push(`- 결정: **${item.decision.status}**${item.decision.note ? ` — ${item.decision.note}` : ''}`)
      if (item.task) lines.push(`- 업무: ${item.task.status}${item.task.workStatus ? ` (${item.task.workStatus})` : ''}`)
      for (const sample of item.samples ?? []) lines.push(`- 의견(${stanceWord[sample.stance] ?? '의견'}): ${sample.body}`)
      if (item.decision.status === '미반영') lines.push('- 이 번호는 다음 판에서 빼되, 번호를 다른 항목에 다시 쓰지 마세요.')
      lines.push('')
    }
  }
  if (pending.length) {
    lines.push('## 아직 결정 전 — 의견을 참고해 다듬어 주세요', '')
    for (const item of pending) {
      const tally = Object.entries(item.stances ?? {}).filter(([, count]) => count > 0).map(([stance, count]) => `${stanceWord[stance]} ${count}`).join(' · ')
      lines.push(`### ${item.key ? `${item.key} ` : ''}${item.title}`)
      if (tally) lines.push(`- 반응: ${tally}`)
      for (const sample of item.samples ?? []) lines.push(`- 의견(${stanceWord[sample.stance] ?? '의견'}): ${sample.body}`)
      lines.push('')
    }
  }
  const questions = items.flatMap((item) => (item.openQuestions ?? []).map((text) => `- ${item.key ? `${item.key} ` : ''}${item.title}: ${text}`))
  if (questions.length) lines.push('## 답이 필요한 질문 — 다음 판에서 답해 주세요', '', ...questions, '')
  return lines.filter((line) => line !== null).join('\n')
}

/** 엑셀이 UTF-8로 읽게 하는 표식(보이지 않는 글자라 코드에는 번호로 적는다). */
const UTF8_BOM = String.fromCharCode(0xfeff)

/** 결정 이력 CSV. 엑셀에서 한글이 깨지지 않게 UTF-8 BOM을 붙인다. */
export function decisionsCsv(rows) {
  const escape = (value) => {
    const text = String(value ?? '')
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const header = ['판', '항목 번호', '항목', '결정', '메모', '결정한 사람', '결정 시각', 'AI 초안']
  const body = rows.map((row) => [row.version, row.key, row.title, row.status, row.note, row.decidedByName, row.decidedAt, row.adoption ?? ''].map(escape).join(','))
  return `${UTF8_BOM}${[header.join(','), ...body].join('\r\n')}\r\n`
}

/** 결정 기록 문서(위키) 블록. 블록 id는 부르는 쪽이 만든다(위키 규격). */
export function decisionRecordBlocks({ title, version, items, newBlockId }) {
  const blocks = []
  const push = (block) => blocks.push({ id: newBlockId(), ...block })
  push({ type: 'text', text: `「${title}」 ${version}판의 결정 기록입니다. 검토 자료 화면에서 [결정 기록 문서로 남기기]를 누를 때마다 새로 만들어집니다.` })
  for (const group of [...DECISIONS, '미정']) {
    const rows = items.filter((item) => (item.decision?.status ?? '미정') === group)
    if (!rows.length) continue
    push({ type: 'heading', level: 2, text: `${group} (${rows.length})` })
    for (const item of rows.slice(0, 300)) {
      const note = item.decision?.note ? ` — ${item.decision.note}` : ''
      push({ type: 'bulleted', text: `${item.key ? `${item.key} ` : ''}${item.title}${note}`.slice(0, 1_900) })
    }
  }
  return blocks.slice(0, 480)
}

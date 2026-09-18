/**
 * AI 답의 마크다운을 읽기 쉬운 글로 — 제목·목록·굵게·코드·줄바꿈만, HTML은 해석하지 않는다.
 * 전에는 답이 `**중요**`·`## 요약`·`- 항목` 기호 그대로 보였다(감사 ai-23). 화면은 이 구조를 React 요소로 그린다
 * (dangerouslySetInnerHTML을 쓰지 않는다 — 답에 섞인 태그는 글자로 남는다).
 */
export type AnswerInline = { text: string; bold?: boolean; code?: boolean }
export type AnswerBlock =
  | { type: 'paragraph'; lines: AnswerInline[][] }
  | { type: 'heading'; inline: AnswerInline[] }
  | { type: 'list'; ordered: boolean; items: AnswerInline[][] }

export function parseInline(text: string): AnswerInline[] {
  const parts: AnswerInline[] = []
  const pattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > last) parts.push({ text: text.slice(last, index) })
    const token = match[0]
    parts.push(token.startsWith('**') ? { text: token.slice(2, -2), bold: true } : { text: token.slice(1, -1), code: true })
    last = index + token.length
  }
  if (last < text.length) parts.push({ text: text.slice(last) })
  return parts.length ? parts : [{ text }]
}

export function parseAnswer(text: string): AnswerBlock[] {
  const blocks: AnswerBlock[] = []
  let paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', lines: paragraph.map(parseInline) })
    paragraph = []
  }
  const flushList = () => {
    if (list) blocks.push({ type: 'list', ordered: list.ordered, items: list.items.map(parseInline) })
    list = null
  }
  for (const raw of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd()
    if (!line.trim() || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushParagraph(); flushList(); continue }
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line)
    if (heading) { flushParagraph(); flushList(); blocks.push({ type: 'heading', inline: parseInline(heading[1].replace(/\s*#+\s*$/, '')) }); continue }
    const bullet = /^\s*[-*•·]\s+(.*)$/.exec(line)
    const numbered = /^\s*\d{1,3}[.)]\s+(.*)$/.exec(line)
    if (bullet || numbered) {
      flushParagraph()
      const ordered = Boolean(numbered)
      if (!list || list.ordered !== ordered) { flushList(); list = { ordered, items: [] } }
      list.items.push((bullet ?? numbered)![1])
      continue
    }
    flushList()
    paragraph.push(line)
  }
  flushParagraph()
  flushList()
  return blocks
}

import { Fragment } from 'react'
import { parseAnswer, type AnswerInline } from '../utils/answerMarkdown'

function Inline({ parts }: { parts: AnswerInline[] }) {
  return <>{parts.map((part, index) => part.bold ? <strong key={index}>{part.text}</strong> : part.code ? <code key={index}>{part.text}</code> : <Fragment key={index}>{part.text}</Fragment>)}</>
}

/** AI 답을 제목·목록·굵게로 읽기 쉽게. 구조는 utils/answerMarkdown.ts가 정하고, HTML은 해석하지 않는다. */
export function AnswerText({ text }: { text: string }) {
  return <div className="answer-text">{parseAnswer(text).map((block, index) => {
    if (block.type === 'heading') return <p className="answer-heading" key={index}><strong><Inline parts={block.inline} /></strong></p>
    if (block.type === 'list') {
      const items = block.items.map((item, itemIndex) => <li key={itemIndex}><Inline parts={item} /></li>)
      return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>
    }
    return <p key={index}>{block.lines.map((line, lineIndex) => <Fragment key={lineIndex}>{lineIndex > 0 && <br />}<Inline parts={line} /></Fragment>)}</p>
  })}</div>
}

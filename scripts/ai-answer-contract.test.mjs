import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { parseAnswer } from '../src/utils/answerMarkdown.ts'
import { isInstructionMessage } from '../server/proposal-engine.mjs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('AI 답의 마크다운을 제목·목록·굵게로 — 기호 그대로 보이지 않는다(감사 ai-23)', () => {
  const blocks = parseAnswer('## 오늘 요약\n**중요**: 원가표 마감\n\n- 첫째 `A-1`\n- 둘째\n\n1. 확인\n2. 보고\n---\n끝')
  assert.deepEqual(blocks.map((block) => block.type), ['heading', 'paragraph', 'list', 'list', 'paragraph'])
  assert.equal(blocks[0].type === 'heading' && blocks[0].inline[0].text, '오늘 요약')
  assert.deepEqual(blocks[1].type === 'paragraph' && blocks[1].lines[0].map((part) => [part.text, Boolean(part.bold)]), [['중요', true], [': 원가표 마감', false]])
  assert.equal(blocks[2].type === 'list' && blocks[2].ordered, false)
  assert.equal(blocks[2].type === 'list' && blocks[2].items[0][1].code, true)
  assert.equal(blocks[3].type === 'list' && blocks[3].ordered, true)
  // HTML은 해석하지 않는다 — 글자로 남는다.
  assert.equal(parseAnswer('<img src=x onerror=alert(1)>')[0].type === 'paragraph' && parseAnswer('<img src=x onerror=alert(1)>')[0].lines[0][0].text, '<img src=x onerror=alert(1)>')
  const chat = read('src/components/AIChat.tsx')
  assert.match(chat, /message\.role === 'assistant' \? <AnswerText text=\{message\.content\} \/>/)
  assert.doesNotMatch(read('src/components/AnswerText.tsx'), /dangerouslySetInnerHTML/)
})

test('답 아래 업무 만들기는 하나, 모델 ID·개발자 말은 화면에 두지 않는다(감사 ai-13·live-ui-16)', () => {
  const chat = read('src/components/AIChat.tsx')
  assert.match(chat, /\.filter\(\(kind\) => !\(kind === 'task' && canCreateTask && message\.sourcePrompt\)\)/)
  assert.doesNotMatch(chat, /<small>\{message\.model\}<\/small>/)
  assert.doesNotMatch(chat, /'데모 모드'/)
  const server = read('server/app.mjs')
  assert.doesNotMatch(server, /ANTHROPIC_API_KEY를 설정한 뒤/)
  assert.doesNotMatch(server, /message: 'Claude API 인증에 실패했습니다/)
  // '자료로' 올린 AI 답은 기본이 나만 보기(감사 ai-10).
  assert.match(read('server/ai-conversations.mjs'), /\.\.\.\(kind === 'document' \? \{ visibility: 'restricted' \} : \{\}\)/)
})

test('인사말은 업무 지시가 아니다 — 일의 단서가 남을 때만(감사 ai-16)', () => {
  for (const text of ['잘 부탁드립니다', '앞으로 잘 부탁드려요', '좋은 주말 보내 주세요', '참고해 주세요', '수고하셨습니다 푹 쉬세요', '양해 부탁드립니다']) assert.equal(isInstructionMessage(text), false, text)
  for (const text of ['내일까지 원가표 정리해 주세요', '확인 부탁드립니다', '잘 부탁드려요. 내일까지 견적서 보내 주세요', '금요일까지 HACCP 점검표 제출 부탁드립니다']) assert.equal(isInstructionMessage(text), true, text)
})

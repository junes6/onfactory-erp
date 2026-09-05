import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { aiTaskDraftFromAnswer } from '../src/utils/aiTaskDraft.ts'

test('AI answer creates a concise task title and carries its full content into completion criteria', () => {
  const answer = '### 처리 순서\n1. 부족 재고를 확인한다\n2. 발주 필요 수량을 담당자에게 공유한다'
  const draft = aiTaskDraftFromAnswer(answer, '재고를 분석해줘')
  assert.equal(draft.title, '부족 재고를 확인한다')
  assert.equal(draft.completionCriteria, answer)
  assert.notEqual(draft.completionCriteria, '재고를 분석해줘')
})

test('AI work action passes the answer and opens the optional completion criteria in the task sheet', async () => {
  const chat = await readFile(new URL('../src/components/AIChat.tsx', import.meta.url), 'utf8')
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(chat, /aiTaskDraftFromAnswer\(message\.content, message\.sourcePrompt\)/)
  assert.match(chat, /onCreateTask\(draft\.title, draft\.completionCriteria\)/)
  assert.doesNotMatch(chat, /onCreateTask\(message\.sourcePrompt/)
  assert.match(app, /initialDescription=\{taskDraft\.completionCriteria\}/)
  assert.match(app, /useState\(initialDescription\)/)
  // 상위 업무를 들고 열 때도 같은 선택 항목이 펼쳐진다(R16-C2).
  assert.match(app, /open=\{Boolean\(initialDescription\) \|\| Boolean\(initialParentId\)\}/)
})

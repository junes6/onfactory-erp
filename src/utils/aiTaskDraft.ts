export type AiTaskDraft = {
  title: string
  completionCriteria: string
}

function plainLine(value: string) {
  return value
    .replace(/^\s*(?:#{1,6}|[-*•]|\d+[.)])\s*/, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function aiTaskDraftFromAnswer(answer: string, sourcePrompt = ''): AiTaskDraft {
  const completionCriteria = String(answer ?? '').trim().slice(0, 2_000)
  const rawLines = completionCriteria.split(/\r?\n/).filter((line) => line.trim())
  const firstAction = rawLines.find((line) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(line))
  const answerLines = rawLines.map(plainLine).filter(Boolean)
  const actionableLine = plainLine(firstAction ?? '')
    || answerLines.find((line) => !/^(?:요약|정리|답변|분석|처리 순서|확인 결과)\s*[:：]?$/.test(line))
  const fallback = plainLine(sourcePrompt) || 'AI 제안 업무'
  const title = (actionableLine || fallback).slice(0, 100)
  return { title, completionCriteria }
}

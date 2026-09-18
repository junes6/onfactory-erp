/**
 * 운영사 접속 이력을 "방문" 단위로 묶는다.
 *
 * 서버는 운영자가 부른 경로마다 한 줄을 남긴다(같은 경로의 조회는 10분에 한 번). 그래서 운영자가 한 번 들어와
 * 화면을 열면 조회 20줄 가까이가 같은 분에 쌓이고, 고객사 관리자는 "무엇을 바꿨는가"를 그 사이에서 찾아야 했다.
 * 같은 운영자의 줄이 30분 안에 이어지면 한 방문으로 묶고, 변경이 있었는지를 머리에 먼저 말한다.
 * 원래 줄은 하나도 버리지 않는다 — 방문을 펼치면 전부 보인다.
 */
export type OperatorAccessRow = { id: string; at: string; event: string; scope: string; actor: string; reference?: string }

export type OperatorVisit = {
  id: string
  actor: string
  /** 방문의 첫 줄(가장 오래된) 시각 */
  startedAt: string
  /** 방문의 마지막 줄(가장 새로운) 시각 */
  endedAt: string
  reads: number
  writes: number
  rows: OperatorAccessRow[]
}

export const OPERATOR_VISIT_GAP_MS = 30 * 60_000

const timeOf = (value: string) => {
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : null
}

/** 새것이 앞인 줄 목록을 받아, 새것이 앞인 방문 목록을 돌려준다. */
export function groupOperatorVisits(rows: OperatorAccessRow[], gapMs = OPERATOR_VISIT_GAP_MS): OperatorVisit[] {
  const visits: OperatorVisit[] = []
  let current: OperatorVisit | null = null
  let previousAt: number | null = null
  for (const row of rows) {
    const at = timeOf(row.at)
    const sameVisit = current !== null
      && current.actor === row.actor
      && at !== null && previousAt !== null
      && previousAt - at <= gapMs
    if (!sameVisit) {
      current = { id: row.id, actor: row.actor, startedAt: row.at, endedAt: row.at, reads: 0, writes: 0, rows: [] }
      visits.push(current)
    }
    const visit = current as OperatorVisit
    visit.rows.push(row)
    visit.startedAt = row.at
    if (row.event.includes('변경')) visit.writes += 1
    else visit.reads += 1
    previousAt = at
  }
  return visits
}

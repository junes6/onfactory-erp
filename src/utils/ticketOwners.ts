/**
 * CS 티켓 담당자 선택지 — 저장된 기록에서만 만든다.
 *
 * 전에는 '이민지·박하늘·김도윤'이 코드에 박혀 있었고(데모 시드 티켓의 담당자 이름) 새 CS의 기본값이
 * '이민지'였다. 그러면 실제 운영에서도 존재하지 않는 사람이 담당자로 기록에 남는다.
 *
 * 지금은 ① 미배정(기본값) ② 지금 로그인한 운영자 ③ 서버가 쓰는 '개발운영진'(고객사 1:1 지원 채널의 답변 주체)
 * ④ 이미 저장된 티켓에 적힌 담당자 ⑤ 이 티켓의 현재 담당자 — 이것만 보여 준다.
 * 운영자 계정 목록을 주는 서버 경로가 생기면 ④를 그것으로 바꾼다.
 */
export const UNASSIGNED_OWNER = '미배정'
export const DEVELOPER_OPERATIONS_OWNER = '개발운영진'

export function ticketOwnerOptions(
  tickets: ReadonlyArray<{ owner?: string }>,
  currentOperatorName?: string,
  currentOwner?: string,
): string[] {
  const names = new Set<string>([UNASSIGNED_OWNER])
  const add = (value: unknown) => {
    const name = typeof value === 'string' ? value.trim() : ''
    if (name && name.length <= 80) names.add(name)
  }
  add(currentOperatorName)
  add(DEVELOPER_OPERATIONS_OWNER)
  add(currentOwner)
  const stored = tickets
    .map((ticket) => (typeof ticket.owner === 'string' ? ticket.owner.trim() : ''))
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, 'ko'))
  for (const name of stored) add(name)
  return [...names]
}

/**
 * 딥링크(알림·전역 검색)가 가리킨 공지를 "지금 목록에는 없다"고 판정해도 되는 순간인가.
 *
 * 메신저 서랍은 닫혀도 마운트된 채 남는다 — `if (!open) return null`이 훅보다 뒤에 있어서
 * 목록과 그 상태가 닫는 동안 그대로 살아 있다. 그래서 닫아 둔 사이에 올라온 공지의 알림을 누르면,
 * 화면이 손에 쥔 목록은 '지난번에 받은 것'인데 상태만 'ready'라 "그런 공지 없다"로 판정해 버린다.
 * 그 판정은 focus를 소비하고(onFocusHandled), 새 목록이 도착해 effect가 다시 돌 때는 focus가
 * 이미 null이라 재시도가 영영 오지 않는다 — 사용자는 공지가 아니라 공지 보드에 떨어진다.
 *
 * 그래서 판정 자격을 상태가 아니라 시각으로 정한다: 클릭 시각(focus.at)보다 나중에 도착한 목록만
 * 그 말을 할 수 있다. 목록을 못 받은 경우(error)는 기다려도 오지 않으므로 그때는 지금 판정한다 —
 * 아니면 딥링크가 영원히 열리지 않는 채로 남는다.
 *
 * 여는 순간 상태를 'loading'으로 되돌리는 방법은 듣지 않는다. 알림 클릭은 focus와 open을 한 번에
 * 바꾸므로(App.tsx의 한 핸들러), 같은 커밋에서 도는 effect의 눈에는 되돌리기 전 값이 그대로 보인다.
 */

export type NoticeListState = 'loading' | 'ready' | 'error'

export function canJudgeMissingNotice(state: NoticeListState, loadedAt: number, focusAt: number): boolean {
  if (state === 'error') return true
  return loadedAt >= focusAt
}

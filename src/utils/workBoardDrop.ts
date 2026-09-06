import type { WorkItem } from '../domainData'
// .ts 확장자를 붙인다 — Node가 이 파일을 직접 실행하는 테스트 경로(--experimental-strip-types)에서는 확장자 없는 값 import를 해석하지 못한다.
import { subtaskBlockReason } from './workTree.ts'

/**
 * 보드에서 카드를 끌어 단계를 옮길 때의 판정 — 서버 전이표(server/app.mjs의 /transition)의 거울.
 *
 * 상태머신은 한 줄도 바뀌지 않는다. 카드 이동은 **반드시** 기존 POST /api/work-items/:id/transition을
 * 지난다 — generic PUT /api/workspace/work-items를 쓰면 관리자 계정에서 normalizeAdminWorkItems가
 * 이전 상태를 비교하지 않아 review 없는 결재완료가 저장되고, 센티널·SSE 형태·결재 알림 셋이 함께 빠지는데,
 * outbox는 status 차이만으로 work.transitioned를 만들어 감사 로그만 그럴듯하게 남는다.
 *
 * 이 파일이 하는 일은 하나뿐이다: **놓기 전에** 답한다. 끌어다 놓고 나서야 거절되는 화면은
 * 사람에게 '왜 안 되는지'를 알려 줄 자리가 없다.
 *
 * blocked와 warning을 나눈 이유(이 화면이 이미 정한 규율): 역할·상태로 정해지는 거절은 이 payload가
 * 그대로 말해 주는 사실이라 미리 막아도 서버와 어긋나지 않는다. 반대로 '하위 업무 N건 남음'·'점검 항목 N건 남음'은
 * 화면을 연 순간의 사본이라 그 사이에 끝났을 수 있다 — 그래서 이유는 미리 보여 주되 문은 잠그지 않고,
 * 남았는지 아닌지는 제출 시점에 서버가 409로 판정한다(App.tsx primaryAction의 blocked와 같은 판단).
 */

export type WorkTransitionAction = 'accept' | 'submit' | 'approve' | 'request-changes'

export type BoardDrop =
  | { kind: 'none' }
  | { kind: 'action'; action: WorkTransitionAction; needsDialog: 'completion' | 'review' | null; warning?: string }
  | { kind: 'blocked'; reason: string }

export const BOARD_DROP_REASONS = Object.freeze({
  OWNER_ONLY_START: '이 업무는 담당자만 시작할 수 있습니다.',
  OWNER_ONLY_SUBMIT: '이 업무는 담당자만 완료 보고할 수 있습니다.',
  REQUESTER_ONLY: '이 업무는 지시한 사람만 확인할 수 있습니다.',
  NOT_STARTED: '아직 시작하지 않은 업무는 완료 보고할 수 없습니다. 담당자가 업무를 시작한 뒤 완료 보고를 합니다.',
  NEEDS_REVIEW: '완료는 지시한 사람의 확인을 거쳐야 합니다. 완료 보고 → 확인 순서로 진행하세요.',
  NO_REWIND: '이미 시작한 업무를 시작 전으로 되돌릴 수는 없습니다. 보완이 필요하면 확인 단계에서 보완 요청을 하세요.',
  CLOSED: '완료된 업무는 다시 열 수 없습니다. 이어지는 일이 있으면 새 업무로 지시하세요.',
})

/**
 * 남은 점검 항목 안내. 서버 CHECKLIST_INCOMPLETE(409)와 **글자 그대로** 같은 문장을 만든다 —
 * 놓기 전 경고와 서버가 돌려주는 토스트가 다른 말을 하면 사람은 두 가지 일이 일어난 줄 안다.
 */
export function checklistBlockMessage(labels: string[]): string {
  return `점검 항목 ${labels.length}건이 남아 있습니다: ${labels.slice(0, 3).join(', ')}${labels.length > 3 ? ' 외' : ''}`
}

const openChecklist = (item: WorkItem) => (item.checklist ?? []).filter((entry) => !entry.done).map((entry) => entry.label)

/**
 * 이 카드를 저 칼럼에 놓으면 무슨 일이 일어나는가.
 *
 * 하위 업무가 남았을 때의 문장은 subtaskBlockReason 하나에서만 나온다 — 그 문장에는 자식 제목이 없다.
 * 게스트가 상위 담당자면 범위 밖 자식 제목이 새기 때문이고(서버 SUBTASKS_INCOMPLETE도 건수만 싣는다),
 * 드래그 UI가 '친절하게' 목록을 붙이면 그 결정이 무효가 된다.
 */
export function boardDropAction(item: WorkItem, target: WorkItem['status'], currentUserId: string, items: WorkItem[]): BoardDrop {
  if (item.status === target) return { kind: 'none' }
  if (item.status === '결재완료') return { kind: 'blocked', reason: BOARD_DROP_REASONS.CLOSED }
  if (target === '업무요청') return { kind: 'blocked', reason: BOARD_DROP_REASONS.NO_REWIND }

  const isOwner = item.ownerId === currentUserId
  const isRequester = item.requesterId === currentUserId

  if (item.status === '업무요청') {
    if (target === '수행중') {
      return isOwner ? { kind: 'action', action: 'accept', needsDialog: null } : { kind: 'blocked', reason: BOARD_DROP_REASONS.OWNER_ONLY_START }
    }
    if (target === '결재대기') return { kind: 'blocked', reason: BOARD_DROP_REASONS.NOT_STARTED }
    return { kind: 'blocked', reason: BOARD_DROP_REASONS.NEEDS_REVIEW }
  }

  if (item.status === '수행중') {
    if (target === '결재완료') return { kind: 'blocked', reason: BOARD_DROP_REASONS.NEEDS_REVIEW }
    if (!isOwner) return { kind: 'blocked', reason: BOARD_DROP_REASONS.OWNER_ONLY_SUBMIT }
    const checklist = openChecklist(item)
    const warning = checklist.length ? checklistBlockMessage(checklist) : subtaskBlockReason(items, item.id)
    return { kind: 'action', action: 'submit', needsDialog: 'completion', ...(warning ? { warning } : {}) }
  }

  // 결재대기: 승인(결재완료)과 보완 요청(수행중) 둘 다 지시한 사람의 확인이다.
  if (!isRequester) return { kind: 'blocked', reason: BOARD_DROP_REASONS.REQUESTER_ONLY }
  return target === '결재완료'
    ? { kind: 'action', action: 'approve', needsDialog: 'review' }
    : { kind: 'action', action: 'request-changes', needsDialog: 'review' }
}

/**
 * 이 카드를 끌어서 갈 수 있는 칼럼들. 하나도 없으면 카드에 draggable을 주지 않는다 —
 * 잡히기만 하고 어디에도 놓을 수 없는 카드는 고장으로 읽힌다.
 */
export function boardDropTargets(item: WorkItem, currentUserId: string, items: WorkItem[]): WorkItem['status'][] {
  const stages: WorkItem['status'][] = ['업무요청', '수행중', '결재대기', '결재완료']
  return stages.filter((status) => boardDropAction(item, status, currentUserId, items).kind === 'action')
}

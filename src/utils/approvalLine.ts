import type { ApprovalDocument, ApprovalStep } from '../components/approval/approvalTypes'

/**
 * 서버 `server/approval-routing.mjs`의 거울(순수 · I/O 0).
 *
 * 목록에 「결재하기」 버튼을 그릴지, 「회수」를 보여 줄지처럼 **화면이 미리 말하는 것**만 여기서 답한다.
 * 실제 판정은 언제나 서버가 하고(`approvalSeatFor`), 이 파일이 틀리면 서버가 403·409로 막는다 —
 * 그래서 여기서 false 가 나와도 버튼을 영구히 잠그지 않는다(규칙 1: 서버가 정하고 클라이언트는 경고만).
 *
 * 그럼에도 같은 규칙을 그대로 옮겨 적는 이유: 「내 결재 3건」이라 써 놓고 눌렀더니 403이 나오는 화면은
 * 사람에게 거짓말을 한 것이다. 규칙이 갈리지 않게 서버 함수와 같은 순서·같은 조건으로 적는다.
 */

/**
 * 결재 문서 id 의 모양. 서버 `server/approval-routing.mjs` 의 `DOCUMENT_ID_RE` 와 **같은 글자**여야 한다
 * (`scripts/approval-ui-contract.test.mjs` 가 두 글자를 맞대 본다).
 */
export const APPROVAL_DOCUMENT_ID_RE = /^APD-[A-Z0-9-]{4,40}$/

/**
 * 이 focusId 가 결재 문서를 가리키는가.
 *
 * `page: 'approvals'` 알림은 결재 문서만의 자리가 아니다 — AI 제안(`PRP-`)·센티널·외부 기회(`OPP-`)가
 * 같은 page 로 온다(server/notifications.mjs 의 NOTIFICATION_TYPES · server/activity-feed.mjs).
 * 그 id 를 결재 상세에 그대로 넘기면 서버가 404 를 주고, 사람은 알림을 눌렀을 뿐인데
 * 「결재 문서를 찾을 수 없거나 열람 권한이 없습니다.」 오류 대화상자만 본다.
 * 그래서 **결재 문서 id 일 때만** 문서를 열고, 그 밖에는 결재 화면으로 이동만 한다.
 */
export function isApprovalDocumentFocus(focusId: string | null | undefined): boolean {
  return APPROVAL_DOCUMENT_ID_RE.test(String(focusId ?? ''))
}

/** 알림 하나를 눌렀을 때 어디를 열 것인가. 세 값이 함께 나와야 두 갈래가 서로 다른 답을 하지 않는다. */
export type NotificationFocusTarget = { page: string; approvalFocusId: string; workFocusId: string }

/**
 * **판정은 page 가 아니라 id 의 모양으로 한다.**
 *
 * 결재 문서 id 는 오직 결재 자리에서만 뜻이 있다. 그런데 `page` 는 결재 문서를 가리키면서도
 * 'approvals' 가 아닐 수 있다 — 아침 요약(`buildQuietDigest`)이 그렇고, 알림 유형표
 * (`NOTIFICATION_TYPES['approval-requested'].page`)는 업무 결재 시절의 'tasks' 를 아직 들고 있다.
 * page 로 먼저 가르면 그런 알림이 업무 id 자리(`workFocusId`)로 흘러들어, 사람은 알림을 눌러
 * 업무지시 화면에 떨어지고 기다리던 결재는 열리지 않는다.
 *
 * 반대 방향도 함께 막는다: `page:'approvals'` 로 오는 알림이 전부 결재 문서인 것은 아니다
 * (AI 제안 `PRP-`·센티널·외부 기회 `OPP-`). 그 id 를 결재 상세에 넘기면 서버가 404 를 주고
 * 사람은 오류 대화상자만 본다 — 그래서 결재 화면으로 이동만 하고 문서는 열지 않는다.
 */
export function notificationFocusTarget(
  page: string | null | undefined,
  focusId: string | null | undefined,
): NotificationFocusTarget {
  const id = String(focusId ?? '')
  if (isApprovalDocumentFocus(id)) return { page: 'approvals', approvalFocusId: id, workFocusId: '' }
  const target = String(page ?? '')
  return { page: target, approvalFocusId: '', workFocusId: target === 'approvals' ? '' : id }
}

/**
 * 결재선에서 **사람이 실제로 정해진 단계**만 남긴다.
 *
 * 「단계 추가」를 누르면 결재자 자리가 빈 채로 한 단계가 생긴다. 그 빈 단계를 그대로 보내면
 * 서버는 구조로 거절하고(순차는 결재자 정확히 1명) 임시저장 한 번이 400 으로 튕겨 **적어 둔 것이
 * 한 글자도 저장되지 않는다** — 「기안은 메모장」이라는 약속이 그 자리에서 깨진다.
 * 그래서 화면이 보내기 전에 빈 단계를 걷어내고, 「결재선이 비었는가」도 이 결과로 판정한다
 * (그래야 aria-disabled 와 핸들러의 거절이 같은 것을 말한다 — 규칙 2·3).
 */
export function filledLineSteps<T extends { approverIds: string[] }>(steps: readonly T[] | null | undefined): T[] {
  return (Array.isArray(steps) ? steps : []).filter((step) => (step?.approverIds ?? []).some(Boolean))
}

/** 탭마다 「무엇이 없는가」가 다르므로 문장도 갈린다. 가짜 0을 크게 쓰지 않는다. */
const EMPTY_TEXT: Record<string, string> = {
  waiting: '지금 결재할 문서가 없습니다',
  drafted: '아직 올린 결재가 없습니다',
  cc: '참조로 받은 문서가 없습니다',
  all: '아직 결재 문서가 없습니다',
}

/**
 * 목록이 비었을 때의 한 문장.
 *
 * 상태 필터는 탭을 바꿔도 남는다. 그래서 「전체」에서 '승인'으로 좁혀 둔 채 「내 결재」를 누르면
 * 탭에는 「내 결재 3」(필터를 타지 않는 요약)이, 본문에는 「지금 결재할 문서가 없습니다」가 함께
 * 그려진다 — 두 문장이 서로를 부정하고 어느 쪽도 **필터 때문이다**를 말하지 않는다(규칙 11·13).
 * 필터가 걸려 있으면 그 사실을 말하고, 화면은 그 자리에서 필터를 푸는 버튼을 함께 그린다.
 */
export function approvalListEmptyText(tab: string, status: string): string {
  if (status) return `‘${status}’ 상태로 좁힌 결과가 없습니다`
  return EMPTY_TEXT[tab] ?? '결재 문서가 없습니다'
}

/** 지금 결재를 기다리는 단계. 번호는 양쪽 다 정수일 때만 맞춘다(서버와 같은 조건). */
export function currentStepOf(document: Pick<ApprovalDocument, 'line' | 'currentStep'> | null | undefined): ApprovalStep | null {
  const line = Array.isArray(document?.line) ? document.line : []
  const no = document?.currentStep
  if (!Number.isInteger(no)) return null
  return line.find((step) => Number.isInteger(step?.step) && step.step === no) ?? null
}

/** 지금 이 문서가 기다리는 사람들. 결재중이 아니면 빈 배열이다. */
export function pendingApproverIds(document: ApprovalDocument | null | undefined): string[] {
  if (document?.status !== '결재중') return []
  const approvers = currentStepOf(document)?.approvers ?? []
  return approvers.filter((approver) => approver?.decision === 'pending').map((approver) => approver.accountId)
}

const isDrafter = (document: ApprovalDocument | null | undefined, accountId: string) => {
  const owner = String(document?.drafterId ?? '').trim()
  const who = String(accountId ?? '').trim()
  return Boolean(owner) && owner === who
}

const approversOf = (step: ApprovalStep | null | undefined) => (Array.isArray(step?.approvers) ? step.approvers : [])

/**
 * 지금 이 사람이 이 문서를 결재할 수 있는가 — 서버 `approvalSeatFor`의 판정 순서를 그대로 따른다.
 * `delegateFor`는 이 사람이 대결자로 지정된 **원결재자 id 집합**이다.
 */
export function canDecideNow(
  document: ApprovalDocument | null | undefined,
  actorId: string,
  delegateFor: ReadonlySet<string> = new Set(),
): boolean {
  const actor = String(actorId ?? '').trim()
  if (!actor) return false
  if (document?.status !== '결재중') return false

  const line = Array.isArray(document.line) ? document.line : []
  // 번호가 배열 순서대로 1..N 인가. 어긋난 결재선은 서버가 LINE_BROKEN 으로 막으므로 화면도 권하지 않는다.
  if (line.some((entry, position) => entry?.step !== position + 1)) return false
  const step = currentStepOf(document)
  if (!step || !Array.isArray(step.approvers)) return false
  const behind = line.slice(0, line.indexOf(step))
  if (behind.some((entry) => !approversOf(entry).every((approver) => approver?.decision === 'approved'))) return false

  if (isDrafter(document, actor)) return false

  const held = line.flatMap(approversOf).filter(
    (approver) => approver?.accountId === actor || approver?.decidedById === actor,
  )
  const pressedForOther = (Array.isArray(document.history) ? document.history : []).some(
    (entry) => String(entry?.actorId ?? '').trim() === actor && Boolean(entry?.delegateOf),
  )
  // 한 사람은 이 결재선에서 자리 하나다(서버 SEAT_TAKEN).
  if (pressedForOther || held.some((approver) => approver.decision !== 'pending')) return false

  const waiting = step.approvers.filter((approver) => approver?.decision === 'pending')
  if (waiting.some((approver) => held.includes(approver))) return true

  // 대결 자리는 이 결재선에 아직 아무 자리도 갖지 않은 사람만 맡는다.
  if (!waiting.some((approver) => delegateFor.has(approver.accountId))) return false
  return held.length === 0
}

/** 회수는 아직 아무도 결정하지 않았을 때만. 한 명이라도 승인했으면 이력이 거짓말을 하게 된다. */
export function canRecall(document: ApprovalDocument | null | undefined, actorId: string): boolean {
  if (!isDrafter(document, actorId) || document?.status !== '결재중') return false
  return (Array.isArray(document.line) ? document.line : []).every(
    (step) => approversOf(step).every((approver) => approver?.decision === 'pending'),
  )
}

export function canEditDraft(document: ApprovalDocument | null | undefined, actorId: string): boolean {
  return isDrafter(document, actorId) && document?.status === '기안'
}

/** 몇 단계까지 끝났는가. 「전원 승인된 단계」만 센다 — 병렬 단계에서 한 명만 눌러도 끝난 것으로 세지 않는다. */
export function lineProgress(document: ApprovalDocument | null | undefined): { done: number; total: number } {
  const line = Array.isArray(document?.line) ? document.line : []
  const done = line.filter((step) => {
    const approvers = approversOf(step)
    return approvers.length > 0 && approvers.every((approver) => approver?.decision === 'approved')
  }).length
  return { done, total: line.length }
}

/** 목록 한 줄이 말하는 진행 문구. 상태마다 사람이 다음에 할 수 있는 일이 다르므로 문장도 갈린다. */
export function stepLabel(document: ApprovalDocument | null | undefined): string {
  if (!document) return ''
  const { done, total } = lineProgress(document)
  if (document.status === '기안') return total > 0 ? `상신 전 · 결재선 ${total}단계` : '상신 전 · 결재선 없음'
  if (document.status === '승인') return `결재 완료 · ${total}단계`
  if (document.status === '반려') return `반려 · ${done}/${total}단계에서 멈춤`
  if (document.status === '회수') return '기안자가 회수'
  const waiting = currentStepOf(document)?.approvers.filter((approver) => approver.decision === 'pending') ?? []
  const names = waiting.map((approver) => approver.name).filter(Boolean).join(' · ')
  return names ? `${done}/${total}단계 · ${names} 대기` : `${done}/${total}단계 진행 중`
}

/** 목록의 단계 점 하나가 어떤 상태인가. 클래스 조각을 돌려준다(빈 문자열이면 아직 오지 않은 단계). */
export function stepState(step: ApprovalStep, document: ApprovalDocument): string {
  const approvers = approversOf(step)
  if (approvers.some((approver) => approver.decision === 'rejected')) return ' is-rejected'
  if (approvers.length > 0 && approvers.every((approver) => approver.decision === 'approved')) return ' is-done'
  if (document.status === '결재중' && step.step === document.currentStep) return ' is-current'
  return ''
}

/**
 * 원 표기. `toLocaleString`을 쓰지 않는다 — 브라우저 로케일에 따라 같은 값이 다른 글자로 찍히면
 * 화면의 금액과 인쇄물의 금액이 갈린다.
 */
export function formatKrw(amount: number | null | undefined): string {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—'
  const rounded = Math.round(amount)
  const sign = rounded < 0 ? '-' : ''
  return `${sign}${String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}원`
}

/** 'YYYY-MM' → '2026년 2월'. 월 라벨을 만드는 곳은 여기 하나다. */
export function formatApprovalMonth(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(String(month ?? ''))
  if (!match) return String(month ?? '')
  return `${match[1]}년 ${Number(match[2])}월`
}

const seenKey = (accountId: string) => `approval-seen:${accountId}`

/**
 * 「내가 올린 것」의 결과를 마지막으로 본 시각. 읽기·쓰기 모두 try/catch —
 * 저장소가 막힌 브라우저에서 빈 문자열로 떨어지면 서버는 「끝난 내 기안 전부」를 센다(점이 켜진다).
 * 조용히 0으로 떨어뜨리면 점이 반대로 영영 켜지지 않아, 최종 승인이 사람에게 도달하지 않는다.
 */
export function approvalSeenAt(accountId: string): string {
  if (!accountId) return ''
  try {
    return window.localStorage.getItem(seenKey(accountId)) ?? ''
  } catch {
    return ''
  }
}

export function markApprovalSeen(accountId: string, at: string) {
  if (!accountId || !at) return
  try {
    window.localStorage.setItem(seenKey(accountId), at)
  } catch {
    /* 저장소가 막힌 브라우저에서는 점이 계속 켜져 있을 뿐, 화면은 그대로 돈다 */
  }
}

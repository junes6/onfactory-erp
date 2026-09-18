import { isApprovalDocumentFocus } from './approvalLine.ts'

/**
 * 화면 주소와 "무엇을 열 것인가"의 규칙 — 알림·웹푸시·전역 검색·출처 배지·근거 링크·주소창이 이 하나를 쓴다.
 *
 * 전에는 다섯 곳이 제각각 갈랐다. 웹푸시는 메신저·인사·문서·검토 자료 갈래가 없어 그 알림을 눌러도
 * 목적지에 닿지 못했고, 닫혀 있던 앱을 연 푸시는 주소의 page·focus를 아무도 읽지 않아 늘 첫 화면이 떴다.
 * 주소창도 화면을 따라가지 않아 새로 고침·뒤로 가기·링크 공유가 되지 않았다.
 */

/** 한 번의 "열기"가 바꿀 것들. 값이 없는 칸은 건드리지 않는다. */
export type OpenPlan = {
  /** 이동할 화면. 빈 문자열이면 화면은 그대로 두고 서랍만 연다(메신저). */
  page: string
  /** 메신저 서랍을 연다. 값은 '<방>:<종류>:<id>' 규약의 focusId, null이면 목록. */
  messenger?: string | null
  workFocusId?: string
  approvalFocusId?: string
  wikiFocusId?: string
  materialFocusId?: string
  projectFocusId?: string
  /** 인사·조직에서 처음 열 탭(외부 연동 중지 → 외부 연동, 휴가 결재 요청·결과 → 휴가). */
  peopleTab?: 'integrations' | 'leave'
}

/** '<방|company>:<notice|thread|message>:<id>' — 공지·메신저 메시지·스레드를 가리키는 focusId의 모양. */
const MESSENGER_FOCUS_RE = /^[^:]*:(notice|thread|message):[^:]+$/
/** 외부 연동(웹훅) 엔드포인트 id. 인사·조직의 사람 id와 구별해야 탭을 잘못 열지 않는다. */
const WEBHOOK_ENDPOINT_RE = /^WHK-/
const MATERIAL_PREFIX = 'material:'

/**
 * 어디를 열지 정한다. **판정은 page보다 id의 모양이 먼저다** — 결재 문서·메신저 메시지는
 * 어느 page로 와도 그 자리에서만 뜻이 있다(예전 알림 전용 규칙을 모든 입구로 넓혔다).
 */
export function planOpen(page: string | null | undefined, focusId: string | null | undefined): OpenPlan {
  const target = String(page ?? '').trim()
  const id = String(focusId ?? '').trim()
  if (isApprovalDocumentFocus(id)) return { page: 'approvals', approvalFocusId: id }
  if (MESSENGER_FOCUS_RE.test(id)) return { page: '', messenger: id }
  if (target === 'messenger') return { page: '', messenger: null }
  if (target === 'wiki' && id.startsWith(MATERIAL_PREFIX)) return { page: 'wiki', materialFocusId: id.slice(MATERIAL_PREFIX.length) }
  if (target === 'wiki' && id) return { page: 'wiki', wikiFocusId: id }
  if (target === 'projects' && id) return { page: 'projects', projectFocusId: id }
  if (target === 'people' && WEBHOOK_ENDPOINT_RE.test(id)) return { page: 'people', peopleTab: 'integrations' }
  // 휴가 알림(신청·결과): '휴가' 탭 — 결재 대기 목록과 내 신청이 함께 있는 자리다('휴가 정책·원장'이 아니다).
  if (target === 'people' && id.startsWith('leave:')) return { page: 'people', peopleTab: 'leave' }
  // 업무 id는 업무 화면에서만 연다. 다른 화면으로 가는 링크의 id를 업무 자리에 넣으면
  // 나중에 업무 화면에 들어갈 때 엉뚱한 업무가 펼쳐진다.
  if (target === 'tasks' && id) return { page: 'tasks', workFocusId: id }
  return { page: target }
}

export type AppRoute = { page: string; focus: string }

const PAGE_RE = /^[a-z][a-z-]{1,30}$/

/** 주소창의 ?page=&focus= 를 읽는다. 모양이 틀리면 null(아무 화면도 강제로 열지 않는다). */
export function readRoute(search: string): AppRoute | null {
  const params = new URLSearchParams(search)
  const page = (params.get('page') ?? '').trim()
  if (!PAGE_RE.test(page)) return null
  return { page, focus: (params.get('focus') ?? '').trim().slice(0, 200) }
}

/** 화면 하나의 주소. 서비스워커(public/sw.js notificationTarget)와 같은 모양이다. */
export function routeSearch(page: string, focus = ''): string {
  const params = new URLSearchParams({ page })
  if (focus) params.set('focus', focus)
  return `?${params.toString()}`
}

/**
 * 지금 보고 있는 화면을 주소 한 칸으로. 휴대폰은 아래 네 칸이 화면을 정한다 —
 * 오늘은 'ai'(데스크톱의 첫 화면과 같은 자리), 채팅은 'messenger', 더보기는 그 아래 연 화면.
 */
export function currentRoutePage(input: { phone: boolean; mobileTab: string; page: string }): string {
  if (!input.phone) return input.page
  if (input.mobileTab === 'today') return 'ai'
  if (input.mobileTab === 'tasks') return 'tasks'
  if (input.mobileTab === 'chat') return 'messenger'
  return input.page
}

import { MessagesSquare } from 'lucide-react'

import { formatListDateTime } from '../utils/dateTime'
import './ThreadPanel.css'

/**
 * 스레드 패널의 작은 조각들 — 본채널에 남는 한 줄, 답글 구분선, 빈 상태.
 *
 * 패널의 뼈대(3열 배치·헤더·컴포저)는 메신저 서랍 안에 있으므로 CollaborationSuite가 그린다.
 * 여기 있는 것은 그 뼈대와 무관하게 혼자 서는 조각들이다 — 본채널 말풍선 아래에 붙는 요약 한 줄은
 * 스레드 패널이 닫혀 있을 때도 그려져야 하고, 그래서 패널의 상태를 하나도 알면 안 된다.
 */

/**
 * 스레드 GET이 돌려주는 것 전부. 서버 응답과 글자 그대로 같은 세 칸이다 —
 * 화면이 읽지 않는 필드는 여기에도 서버에도 두지 않는다(참여자 명단은 공유·승격 403이 서버 안에서 쓰는
 * 사실이고, 읽음 표시는 본채널의 것이라 답글에 그리지 않으며, 답글 수와 마지막 시각은 본채널 요약 줄이
 * 대화 배열에서 직접 읽는 값이다 — 패널은 replies를 그대로 센다).
 */
export type ThreadData<Message> = {
  root: Message
  replies: Message[]
  /** 지워지지 않고 남아 있는 답글 수. 공유·승격이 '빈 스레드'를 판정하는 수와 같은 것이어야 한다. */
  liveReplyCount: number
}

/* focusId 규약('<방|company>:<notice|thread|message>:<id>')을 만드는 쪽은 전부 서버이고
   (app.mjs·global-search.mjs·messenger-rooms.mjs), 읽는 쪽은 NoticeCenter.tsx의 parseMessengerFocus 한 곳이다.
   화면이 이 문자열을 만들 자리가 없으므로 여기에 만드는 헬퍼를 두지 않는다 — 아무도 부르지 않는
   조립 함수가 있으면 다음 사람이 "서버도 이걸 쓰겠거니" 하고 규약이 두 벌이 된다. */

/**
 * 본채널 말풍선 아래 한 줄. 답글이 0이면 부르는 쪽이 아예 그리지 않는다 —
 * '답글 0개'는 아무것도 알려 주지 않으면서 자리만 차지하는 가짜 0이다.
 */
export function ThreadSummaryButton({
  replyCount,
  lastReplyAt,
  open,
  onOpen,
}: {
  replyCount: number
  lastReplyAt?: string
  open: boolean
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      className={'messenger-thread-summary' + (open ? ' is-open' : '')}
      aria-expanded={open}
      aria-label={`스레드 열기 · 답글 ${replyCount}개`}
      onClick={onOpen}
    >
      <MessagesSquare size={14} aria-hidden="true" />
      <span>답글 {replyCount}개</span>
      {lastReplyAt && <time dateTime={lastReplyAt}>{formatListDateTime(lastReplyAt)}</time>}
    </button>
  )
}

/** [채널에 공유]로 올라온 요약. 눌러서 그 결론이 나온 자리로 되돌아간다. */
export function ThreadOriginButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" className="messenger-thread-origin" onClick={onOpen}>
      <MessagesSquare size={13} aria-hidden="true" />
      <span>스레드에서 공유됨</span>
    </button>
  )
}

/**
 * 루트와 답글 사이의 구분선.
 *
 * 본채널의 '오늘' 구분선을 복제하지 않는다 — 그 문구는 하드코딩이라 작년 답글에도 '오늘'이 붙는다.
 * 스레드가 말해야 하는 것은 날짜가 아니라 '여기서부터 답글'이다.
 */
export function ThreadReplyDivider({ count }: { count: number }) {
  return (
    <hr className="messenger-thread-divider" aria-label={`답글 ${count}개`} data-label={`답글 ${count}개`} />
  )
}

export function ThreadEmpty() {
  return (
    <div className="collab-empty compact">
      <MessagesSquare size={26} aria-hidden="true" />
      <strong>아직 답글이 없습니다</strong>
      <span>여기 쓴 답글은 본 채널을 어지럽히지 않습니다.</span>
    </div>
  )
}

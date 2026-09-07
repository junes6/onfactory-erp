import { Fragment, type ReactNode } from 'react'

/**
 * 본문 안의 `[[doc:…|보이는 이름]]` 링크를 그린다.
 *
 * 서버가 이미 렌더 시점에 재인가를 마쳐서, 볼 수 없는 대상의 라벨은 '접근 권한 없음'으로 바뀌어 온다.
 * 화면은 그 라벨을 그대로 쓰고 다시 판정하지 않는다 — 판정이 두 벌이 되면 언젠가 한쪽이 낡는다.
 *
 * `dangerouslySetInnerHTML`을 쓰지 않는다. 본문은 사람이 친 글이고, 그 안에 태그가 있으면
 * 태그로 보여야 한다.
 */

/**
 * 상태를 가진 `/g` 정규식을 모듈에 두지 않는다 — 누가 한 번 `.test()`를 부르면 `lastIndex`가 남아
 * 그 다음 훑기가 앞쪽 토큰을 건너뛴다. 서버 `wiki-blocks.mjs`가 같은 이유로 같은 모양을 쓴다.
 */
const linkTokenRe = () => /\[\[(doc|task|person):([A-Za-z0-9_-]{1,64})\|([^\]\n]{0,80})\]\]/gu

const UNAVAILABLE = new Set(['접근 권한 없음', '삭제된 항목'])

export type WikiLinkTarget = { kind: 'doc' | 'task' | 'person'; id: string; label: string }

export function WikiLinkText({ text, onOpen }: {
  text: string
  onOpen?: (target: WikiLinkTarget) => void
}) {
  const source = typeof text === 'string' ? text : ''
  if (!source.includes('[[')) return <>{source}</>
  const pieces: ReactNode[] = []
  let cursor = 0
  let index = 0
  for (const match of source.matchAll(linkTokenRe())) {
    const at = match.index ?? 0
    if (at > cursor) pieces.push(<Fragment key={`t${index}`}>{source.slice(cursor, at)}</Fragment>)
    const kind = match[1] as WikiLinkTarget['kind']
    const id = match[2]
    const label = match[3] || '제목 없음'
    // 열 수 없는 대상은 단추로 만들지 않는다. 눌러도 아무 일이 없는 초점 자리를 만들면
    // 키보드 사용자에게 "여기로 갈 수 있다"는 거짓말이 된다.
    if (!onOpen || UNAVAILABLE.has(label)) {
      pieces.push(<span className="wiki-link is-muted" key={`l${index}`}>{label}</span>)
    } else {
      pieces.push(
        <button className="wiki-link" type="button" key={`l${index}`} onClick={() => onOpen({ kind, id, label })}>
          {label}
        </button>,
      )
    }
    cursor = at + match[0].length
    index += 1
  }
  if (cursor < source.length) pieces.push(<Fragment key={`t${index}`}>{source.slice(cursor)}</Fragment>)
  return <>{pieces}</>
}

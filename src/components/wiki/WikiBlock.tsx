import { useLayoutEffect, useRef, type ClipboardEvent, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { CheckSquare, Eye, FileDown, GripVertical, ListPlus, MoreHorizontal, Square } from 'lucide-react'
import { Button, IconButton } from '../ui/Button'
import { StatusBadge } from '../StatusBadge'
import { WikiLinkText, type WikiLinkTarget } from './WikiLinkText'
import { maxTextOf, type BlockType, type WikiBlock as Block } from './wikiBlocks'
import type { WikiNotice } from './wikiOps'

/**
 * 블록 하나.
 *
 * 편집 상자는 언제나 진짜 `<textarea>`(표는 `<input>`)다. `contentEditable`을 쓰지 않는 이유는
 * 하나다 — 한글은 조합이 끝나기 전까지 글자가 완성되지 않는데, 편집 가능한 DOM은 그 사이에도
 * 브라우저마다 다른 시점에 DOM을 갈아 끼운다. 그 순간 캐럿이 튀고 음절이 깨진다.
 *
 * 값은 부모(`WikiEditor`)가 들고 있고 여기서는 `event.target.value`를 그대로 올려보낸다.
 * `trim`도 자동 서식 변환도 하지 않는다 — 조합 중에 값을 바꾸면 같은 문제가 다시 생긴다.
 */

export type BlockAttachment = { id: string; name: string | null; readable: boolean; mime?: string; size?: number }

/**
 * 이 문단에서 지금 벌어진 일 한 줄. 토스트로 띄우지 않는다 — 어느 문단의 이야기인지가 중요하다.
 * 모양과 문장은 `wikiOps.ts`가 한 자리에서 정한다(서버가 말한 사실과 짝이 어긋나면 안 된다).
 */
export type BlockNotice = WikiNotice

export function WikiBlockRow({
  block, editable, readMode, attachment, watchers, notice, taskLinked, indent,
  onText, onCell, onToggleTodo, onKeyDown, onCellKeyDown, onFocusBlock, onBlurBlock,
  onComposition, onPasteText, onPasteCell, onOpenLink, onPromoteTask, onOpenTask, onOpenNotice, onOpenMenu,
  onDragStart, onDragOver, onDrop, onDragEnd,
}: {
  block: Block
  editable: boolean
  readMode: boolean
  attachment: BlockAttachment | null
  /** 지금 이 문단을 보고 있는 **다른** 사람들. 나 혼자면 빈 배열이라 아무것도 그리지 않는다. */
  watchers: readonly string[]
  notice: BlockNotice | null
  taskLinked: boolean
  indent: number
  onText: (blockId: string, value: string) => void
  onCell: (blockId: string, row: number, column: number, value: string) => void
  onToggleTodo: (blockId: string, checked: boolean) => void
  onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>, block: Block) => void
  onCellKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>, block: Block, row: number, column: number) => void
  onFocusBlock: (blockId: string) => void
  onBlurBlock: (blockId: string) => void
  onComposition: (blockId: string, composing: boolean) => void
  onPasteText: (event: ClipboardEvent<HTMLTextAreaElement>, block: Block) => void
  onPasteCell: (event: ClipboardEvent<HTMLInputElement>, block: Block, row: number, column: number) => void
  onOpenLink: (target: WikiLinkTarget) => void
  onPromoteTask: (block: Block) => void
  onOpenTask: (taskId: string) => void
  onOpenNotice: (version: number | null) => void
  onOpenMenu: (block: Block) => void
  onDragStart: (blockId: string) => void
  onDragOver: (event: ReactDragEvent<HTMLLIElement>, blockId: string) => void
  onDrop: (event: ReactDragEvent<HTMLLIElement>, blockId: string) => void
  onDragEnd: () => void
}) {
  const boxRef = useRef<HTMLTextAreaElement>(null)
  const text = typeof block.text === 'string' ? block.text : ''

  // 자동 높이. 바뀐 블록의 상자에만 돈다(컴포넌트가 블록마다 하나라 이 효과도 블록마다 하나다).
  useLayoutEffect(() => {
    const element = boxRef.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }, [text, block.type])

  const editBox = (placeholder: string, label: string) => (
    <textarea
      ref={boxRef}
      rows={1}
      value={text}
      maxLength={maxTextOf(block.type)}
      placeholder={placeholder}
      aria-label={label}
      data-wiki-block={block.id}
      onChange={(event) => onText(block.id, event.target.value)}
      onKeyDown={(event) => { if (event.nativeEvent.isComposing) return; onKeyDown(event, block) }}
      onCompositionStart={() => onComposition(block.id, true)}
      onCompositionEnd={(event) => { onComposition(block.id, false); onText(block.id, event.currentTarget.value) }}
      onFocus={() => onFocusBlock(block.id)}
      onBlur={() => onBlurBlock(block.id)}
      onPaste={(event) => onPasteText(event, block)}
    />
  )

  const readText = <WikiLinkText text={text} onOpen={onOpenLink} />

  const attachmentBody = () => {
    if (!attachment) return <p className="wiki-block-missing">첨부를 찾을 수 없습니다.</p>
    if (!attachment.readable) return <p className="wiki-block-missing">이 파일을 볼 권한이 없습니다.</p>
    if (block.type === 'image') {
      return <img src={`/api/documents/${encodeURIComponent(attachment.id)}/download`} alt={text || attachment.name || '문서에 붙인 이미지'} />
    }
    return (
      <a className="wiki-block-file" href={`/api/documents/${encodeURIComponent(attachment.id)}/download`}>
        <FileDown size={15} aria-hidden="true" /> {attachment.name || '첨부파일'}
      </a>
    )
  }

  const body = () => {
    if (block.type === 'divider') return <hr />
    if (block.type === 'heading') {
      const level = Math.min(3, Math.max(1, Number(block.level) || 2))
      if (readMode || !editable) {
        if (level === 1) return <h2 className="wiki-h1">{readText}</h2>
        if (level === 2) return <h3 className="wiki-h2">{readText}</h3>
        return <h4 className="wiki-h3">{readText}</h4>
      }
      return <div className="wiki-heading-box" data-level={level}>{editBox('제목', `제목 ${level}단계`)}</div>
    }
    if (block.type === 'todo') {
      return (
        <div className="wiki-todo">
          <button
            type="button"
            className="wiki-todo-check"
            aria-pressed={Boolean(block.checked)}
            aria-label={block.checked ? '완료 표시 해제' : '완료로 표시'}
            disabled={!editable}
            onClick={() => onToggleTodo(block.id, !block.checked)}
          >{block.checked ? <CheckSquare size={16} /> : <Square size={16} />}</button>
          {readMode || !editable
            ? <span className={block.checked ? 'wiki-todo-text is-done' : 'wiki-todo-text'}>{readText}</span>
            : editBox('할 일', '할 일 내용')}
          {taskLinked
            ? <Button tone="quiet" size="sm" onClick={() => onOpenTask(String(block.workItemId))}><StatusBadge tone="success">업무 있음</StatusBadge></Button>
            : editable && <Button tone="quiet" size="sm" onClick={() => onPromoteTask(block)}><ListPlus size={14} /> 업무로 만들기</Button>}
        </div>
      )
    }
    if (block.type === 'table') {
      const rows = block.rows ?? []
      const header = rows[0] ?? []
      return (
        <div className="wiki-table-scroll">
          <table>
            <caption className="sr-only">{text || '문서 안의 표'}</caption>
            <thead>
              <tr>
                {header.map((cell, column) => (
                  <th scope="col" key={`h${column}`}>
                    {readMode || !editable ? cell : (
                      <input
                        value={cell}
                        data-wiki-cell={`${block.id}:0:${column}`}
                        aria-label={`${column + 1}번째 열 이름`}
                        onChange={(event) => onCell(block.id, 0, column, event.target.value)}
                        onKeyDown={(event) => { if (event.nativeEvent.isComposing) return; onCellKeyDown(event, block, 0, column) }}
                        onFocus={() => onFocusBlock(block.id)}
                        onBlur={() => onBlurBlock(block.id)}
                        onPaste={(event) => onPasteCell(event, block, 0, column)}
                      />
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(1).map((row, rowIndex) => (
                <tr key={`r${rowIndex}`}>
                  {row.map((cell, column) => (
                    <td key={`c${column}`}>
                      {readMode || !editable ? cell : (
                        <input
                          value={cell}
                          data-wiki-cell={`${block.id}:${rowIndex + 1}:${column}`}
                          aria-label={`${rowIndex + 2}행 ${column + 1}열`}
                          onChange={(event) => onCell(block.id, rowIndex + 1, column, event.target.value)}
                          onKeyDown={(event) => { if (event.nativeEvent.isComposing) return; onCellKeyDown(event, block, rowIndex + 1, column) }}
                          onFocus={() => onFocusBlock(block.id)}
                          onBlur={() => onBlurBlock(block.id)}
                          onPaste={(event) => onPasteCell(event, block, rowIndex + 1, column)}
                        />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }
    if (block.type === 'image' || block.type === 'file') {
      return (
        <figure className="wiki-attachment">
          {attachmentBody()}
          {readMode || !editable
            ? (text ? <figcaption>{readText}</figcaption> : null)
            : <figcaption>{editBox('설명(선택)', '첨부 설명')}</figcaption>}
        </figure>
      )
    }
    if (block.type === 'code') {
      if (readMode || !editable) return <pre className="wiki-code"><code>{text}</code></pre>
      return <div className="wiki-code">{editBox('코드', '코드 블록')}</div>
    }
    if (block.type === 'quote') {
      if (readMode || !editable) return <blockquote className="wiki-quote">{readText}</blockquote>
      return <div className="wiki-quote">{editBox('인용', '인용 문단')}</div>
    }
    if (block.type === 'bulleted' || block.type === 'numbered') {
      if (readMode || !editable) return <span className="wiki-list-text">{readText}</span>
      return editBox(block.type === 'numbered' ? '번호 항목' : '항목', '목록 항목')
    }
    if (readMode || !editable) return <p className="wiki-text">{readText}</p>
    return editBox('내용을 입력하세요. / 를 누르면 종류를 바꿉니다.', '문단 내용')
  }

  return (
    <li
      className="wiki-block"
      data-type={block.type}
      data-indent={Math.min(3, Math.max(0, indent))}
      draggable={editable && !readMode}
      onDragStart={() => onDragStart(block.id)}
      onDragOver={(event) => onDragOver(event, block.id)}
      onDrop={(event) => onDrop(event, block.id)}
      onDragEnd={onDragEnd}
    >
      {watchers.length > 0 && (
        <span className="wiki-block-watch" title={`${watchers.join(', ')}님이 이 문단을 보고 있습니다`}>
          <Eye size={12} aria-hidden="true" />
          <span className="sr-only">{watchers.join(', ')}님이 이 문단을 보고 있습니다</span>
        </span>
      )}
      {editable && !readMode && (
        <span className="wiki-block-gutter">
          {/* 끄는 손잡이는 마우스 전용이라 단추로 만들지 않는다 — 눌러도 아무 일이 없는 초점 자리가 된다.
              키보드로 옮기는 길은 Alt+↑/↓와 아래 문단 메뉴 두 곳에 있다. */}
          <span className="wiki-block-grip" aria-hidden="true"><GripVertical size={15} /></span>
          <IconButton aria-label="이 문단의 메뉴" tone="quiet" size="sm" data-wiki-gutter={block.id} onClick={() => onOpenMenu(block)}><MoreHorizontal size={15} /></IconButton>
        </span>
      )}
      <div className="wiki-block-body">{body()}</div>
      {notice && (
        <p className="wiki-block-notice" data-code={notice.code}>
          {notice.message}
          {notice.version !== null && (
            <button type="button" onClick={() => onOpenNotice(notice.version)}>이력에서 보기</button>
          )}
        </p>
      )}
    </li>
  )
}

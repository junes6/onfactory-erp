import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ArrowDown, ArrowUp, Copy, Trash2 } from 'lucide-react'
import { Button } from '../ui/Button'
import { WikiBlockRow, type BlockAttachment, type BlockNotice } from './WikiBlock'
import { WikiLinkMenu, WikiSlashMenu, slashMatches, type LinkCandidate, type SlashItem } from './WikiSlashMenu'
import { WikiLinkText, type WikiLinkTarget } from './WikiLinkText'
import {
  MAX_TABLE_COLS, MAX_TABLE_ROWS, clientBlockPayload, groupBlocksForRead, indentDelta, isList, isTextual,
  mergeIntoPrevious, newBlockId, parseTsv, splitAt, type BlockType, type WikiBlock as Block,
} from './wikiBlocks'
import { newDeleteOp, newInsertOp, newMoveOp, newUpdateOp, orphanNotices, type WikiOp } from './wikiOps'

/**
 * 블록 목록과 키보드 모델.
 *
 * 모든 `onKeyDown`의 첫 줄은 조합 가드다. 한글을 치는 동안 브라우저는 Enter·Backspace를 조합
 * 확정으로도 쓰기 때문에, 가드가 없으면 '가나다'를 확정하려고 누른 Enter가 문단을 쪼갠다.
 * 블록 컴포넌트에서 한 번 거르고 여기서 다시 한 번 거른다 — 두 겹으로 두는 이유는, 이 핸들러가
 * 나중에 다른 자리에서도 불릴 수 있고 그때 가드를 잊으면 증상이 "가끔 한글이 깨진다"로만 나타나서다.
 *
 * 마크다운 자동 변환(`- `를 목록으로 바꾸는 것)은 넣지 않는다. 조합이 끝난 뒤에 바꿔도 캐럿이 튀고,
 * 한글로 쓰는 사람에게는 얻는 것이 거의 없다.
 */

type MenuState =
  | { kind: 'slash'; blockId: string; query: string; index: number; at: number }
  | { kind: 'link'; blockId: string; query: string; index: number; at: number }
  | { kind: 'block'; blockId: string }
  | null

const focusWikiBlock = (blockId: string, caret?: number) => {
  window.setTimeout(() => {
    const box = document.querySelector<HTMLTextAreaElement>(`textarea[data-wiki-block="${blockId}"]`)
    if (!box) return
    box.focus()
    if (typeof caret === 'number') box.setSelectionRange(caret, caret)
  }, 0)
}

export function WikiEditor({
  blocks, editable, readMode, attachments, presence, notices, currentUserId, headers,
  onApply, onFlushBefore, onFocusedBlock, onComposing, onPromoteTask, onOpenTask, onOpenLink, onOpenNotice, onAttach,
}: {
  blocks: readonly Block[]
  editable: boolean
  readMode: boolean
  attachments: ReadonlyMap<string, BlockAttachment>
  presence: readonly { accountId: string; name: string; blockId: string | null }[]
  notices: ReadonlyMap<string, BlockNotice>
  currentUserId: string
  headers: Record<string, string>
  /** 낙관 반영과 서버 전송을 한 번에. 블록 배열과 그 배열을 만든 조각을 함께 넘긴다. */
  onApply: (nextBlocks: Block[], ops: WikiOp[]) => void
  /** 구조를 바꾸기 직전에 밀린 본문 편집을 먼저 올린다 — 순서가 뒤바뀌면 앵커가 어긋난다. */
  onFlushBefore: () => void
  onFocusedBlock: (blockId: string | null) => void
  onComposing: (composing: boolean) => void
  onPromoteTask: (block: Block) => void
  onOpenTask: (taskId: string) => void
  onOpenLink: (target: WikiLinkTarget) => void
  onOpenNotice: (version: number | null) => void
  onAttach: (kind: 'image' | 'file', afterBlockId: string) => void
}) {
  const [menu, setMenu] = useState<MenuState>(null)
  const [candidates, setCandidates] = useState<LinkCandidate[]>([])
  const [candidateLoading, setCandidateLoading] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const dragIdRef = useRef<string | null>(null)
  /** 한글을 조합하는 중인가. ClipboardEvent에는 isComposing이 없어 이 값으로 대신 판정한다. */
  const composingRef = useRef(false)
  const [dropTarget, setDropTarget] = useState<{ id: string; before: boolean } | null>(null)

  const indexOf = useCallback((blockId: string) => blocks.findIndex((block) => block.id === blockId), [blocks])

  /** 이 문단을 보고 있는 **다른** 사람들. 나 자신은 빼고 센다 — 나까지 세면 늘 한 명이 붙어 있다. */
  const watchersOf = useCallback((blockId: string) => presence
    .filter((entry) => entry.blockId === blockId && entry.accountId !== currentUserId)
    .map((entry) => entry.name || '이름 없음'), [presence, currentUserId])

  // ── 조각 만들기 ───────────────────────────────────────────────────────────
  const replaceBlock = (blockId: string, patch: Partial<Block>) => {
    const at = indexOf(blockId)
    if (at < 0) return
    const before = blocks[at]
    const next = blocks.map((block) => (block.id === blockId ? { ...block, ...patch } : block))
    onApply(next, [newUpdateOp(blockId, Number(before.seq ?? 0), patch)])
  }

  const onText = (blockId: string, value: string) => replaceBlock(blockId, { text: value })

  const onCell = (blockId: string, row: number, column: number, value: string) => {
    const block = blocks[indexOf(blockId)]
    if (!block?.rows) return
    const rows = block.rows.map((line, lineIndex) => (lineIndex === row ? line.map((cell, cellIndex) => (cellIndex === column ? value : cell)) : line))
    replaceBlock(blockId, { rows })
  }

  const onToggleTodo = (blockId: string, checked: boolean) => replaceBlock(blockId, { checked })

  const insertAfter = (afterId: string | null, seed: Partial<Block> & { type?: BlockType }, focusCaret = 0) => {
    onFlushBefore()
    const block = clientBlockPayload({ ...seed, id: newBlockId(), type: seed.type ?? 'text' })
    const at = afterId === null ? -1 : indexOf(afterId)
    const next = [...blocks]
    next.splice(at + 1, 0, block)
    onApply(next, [newInsertOp(block, afterId)])
    focusWikiBlock(block.id, focusCaret)
    return block
  }

  const removeBlock = (blockId: string) => {
    onFlushBefore()
    const at = indexOf(blockId)
    if (at < 0) return
    if (blocks.length <= 1) return
    onApply(blocks.filter((block) => block.id !== blockId), [newDeleteOp(blockId)])
    const neighbour = blocks[at - 1] ?? blocks[at + 1]
    if (neighbour) focusWikiBlock(neighbour.id, (neighbour.text ?? '').length)
  }

  const moveBlock = (blockId: string, direction: -1 | 1) => {
    onFlushBefore()
    const at = indexOf(blockId)
    const target = at + direction
    if (at < 0 || target < 0 || target >= blocks.length) return
    const next = [...blocks]
    const [moved] = next.splice(at, 1)
    next.splice(target, 0, moved)
    const after = target === 0 ? null : next[target - 1].id
    onApply(next, [newMoveOp(blockId, after)])
    setAnnouncement(`문단을 ${direction < 0 ? '위로' : '아래로'} 옮겼습니다. 지금 ${target + 1}번째입니다.`)
    focusWikiBlock(blockId)
  }

  /**
   * 이 문단을 다른 종류로 바꾼다.
   *
   * **글자 계열(TEXTUAL_TYPES) 안에서만 '변경'이다.** 표·이미지·파일·구분선으로 가는 것은 서버가
   * 수정으로 받아 주지 않는다 — 그 울타리 밖은 삭제 + 삽입이고, 수정으로 보내면 배치 전체가 400이 되어
   * 같은 배치에 실린 남의 멀쩡한 편집까지 함께 죽는다.
   */
  const changeType = (blockId: string, type: BlockType, nextText?: string) => {
    onFlushBefore()
    const at = indexOf(blockId)
    const block = blocks[at]
    if (!block) return
    // 본문 손질(슬래시 메뉴가 걷어 낸 `/`)과 종류 변경은 **한 조각**으로 나간다. 둘로 나눠 부르면
    // 두 번째 호출이 이 렌더의 낡은 `blocks`를 보고 앞의 손질을 덮어써, 서버 응답이 올 때까지 글이 되돌아간다.
    const text = nextText ?? block.text ?? ''
    if (type === 'image' || type === 'file') { onAttach(type, blockId); return }
    if (!isTextual(type) || !isTextual(block.type)) {
      const made = clientBlockPayload({
        id: newBlockId(), type,
        ...(type === 'table' ? { rows: [['', '', ''], ['', '', '']] } : {}),
        ...(isTextual(type) ? { text } : {}),
      })
      const next = [...blocks]
      next.splice(at + 1, 0, made)
      const ops: WikiOp[] = [newInsertOp(made, blockId)]
      // 빈 문단이었으면 자리를 비켜 준다. 내용이 있으면 남긴다 — 종류를 바꾸려다 글을 지우지 않는다.
      const dropOld = text.length === 0 && !block.rows && !block.attachmentId && blocks.length > 1
      onApply(dropOld ? next.filter((entry) => entry.id !== blockId) : next, dropOld ? [...ops, newDeleteOp(blockId)] : ops)
      focusWikiBlock(made.id, 0)
      return
    }
    const patch: Partial<Block> = { type }
    if (nextText !== undefined) patch.text = nextText
    if (type === 'heading') patch.level = 2
    if (isList(type)) patch.indent = Number(block.indent ?? 0)
    if (type === 'code') patch.language = ''
    if (type === 'todo') patch.checked = false
    replaceBlock(blockId, patch)
    focusWikiBlock(blockId, text.length)
  }

  // ── `@` 연결 후보 ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (menu?.kind !== 'link') { setCandidates([]); return }
    const word = menu.query.trim()
    if (word.length < 2) { setCandidates([]); setCandidateLoading(false); return }
    let cancelled = false
    setCandidateLoading(true)
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          // 후보 목록도 전역 검색을 그대로 쓴다. 권한 판정을 다시 만들면 언젠가 한쪽이 낡아
          // 볼 수 없는 업무 제목이 자동완성에 뜬다.
          const response = await fetch(`/api/search?q=${encodeURIComponent(word)}`, { headers })
          const body = await response.json().catch(() => ({})) as { groups?: { kind: string; items: { id: string; title: string; meta: string }[] }[] }
          if (cancelled) return
          const wanted: Record<string, LinkCandidate['kind']> = { wiki: 'doc', task: 'task', person: 'person' }
          const found: LinkCandidate[] = []
          for (const group of body.groups ?? []) {
            const kind = wanted[group.kind]
            if (!kind) continue
            for (const item of group.items) found.push({ kind, id: item.id, title: item.title, meta: item.meta })
          }
          setCandidates(found.slice(0, 12))
        } catch {
          if (!cancelled) setCandidates([])
        } finally {
          if (!cancelled) setCandidateLoading(false)
        }
      })()
    }, 220)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [menu, headers])

  const pickLink = (candidate: LinkCandidate) => {
    if (menu?.kind !== 'link') return
    const block = blocks[indexOf(menu.blockId)]
    if (!block) return
    const text = block.text ?? ''
    const label = candidate.title.slice(0, 80).replaceAll(']', ')').replaceAll('\n', ' ')
    const token = `[[${candidate.kind}:${candidate.id}|${label}]]`
    const nextText = `${text.slice(0, menu.at)}${token}${text.slice(menu.at + 1 + menu.query.length)}`
    setMenu(null)
    replaceBlock(menu.blockId, { text: nextText })
    focusWikiBlock(menu.blockId, menu.at + token.length)
  }

  const pickSlash = (item: SlashItem) => {
    if (menu?.kind !== 'slash') return
    const blockId = menu.blockId
    const block = blocks[indexOf(blockId)]
    setMenu(null)
    if (!block) return
    // 메뉴를 부른 `/`와 그 뒤 검색어를 본문에서 걷어낸다. 값 치환은 조합이 끝난 뒤의 개별 명령이라 안전하다.
    //
    // 자리는 **메뉴를 열 때 적어 둔 그 자리**여야 한다. 여기서 `lastIndexOf('/')`로 다시 찾으면
    // 본문 어딘가에 이미 있던 슬래시(주소·분수·날짜)를 잘라 낸다 — 실제로 문장 끝의 슬래시를 지웠다.
    const text = block.text ?? ''
    const marker = text.slice(menu.at, menu.at + 1) === '/' ? menu.at : -1
    const cleaned = marker >= 0 ? `${text.slice(0, marker)}${text.slice(marker + 1 + menu.query.length)}` : text
    changeType(blockId, item.type, cleaned)
  }

  // ── 붙여넣기 ──────────────────────────────────────────────────────────────
  const onPasteText = (event: ClipboardEvent<HTMLTextAreaElement>, block: Block) => {
    // 조합 중에는 손대지 않고 브라우저 기본 동작에 맡긴다. ClipboardEvent에는 isComposing이 없어 상위 상태를 본다.
    if (composingRef.current) return
    const raw = event.clipboardData.getData('text/plain')
    if (!raw.includes('\n') || !isTextual(block.type) || block.type === 'code') return
    event.preventDefault()
    const box = event.currentTarget
    const [head, tail] = splitAt(block.text ?? '', box.selectionStart ?? 0)
    const lines = raw.replace(/\r\n?/gu, '\n').split('\n')
    const first = `${head}${lines[0]}`
    const rest = lines.slice(1)
    const ops: WikiOp[] = [newUpdateOp(block.id, Number(block.seq ?? 0), { text: first })]
    const made: Block[] = []
    let anchor = block.id
    for (const [index, line] of rest.entries()) {
      const line1 = clientBlockPayload({
        id: newBlockId(), type: block.type,
        text: index === rest.length - 1 ? `${line}${tail}` : line,
        ...(isList(block.type) ? { indent: Number(block.indent ?? 0) } : {}),
        ...(block.type === 'heading' ? { level: Number(block.level ?? 2) } : {}),
      })
      ops.push(newInsertOp(line1, anchor))
      made.push(line1)
      anchor = line1.id
    }
    const at = indexOf(block.id)
    const next = [...blocks]
    next[at] = { ...block, text: first }
    next.splice(at + 1, 0, ...made)
    onApply(next, ops)
    const last = made[made.length - 1]
    if (last) focusWikiBlock(last.id, Math.max(0, (last.text ?? '').length - tail.length))
  }

  const onPasteCell = (event: ClipboardEvent<HTMLInputElement>, block: Block, row: number, column: number) => {
    // 조합 중에는 격자를 채우지 않는다 — 값 치환은 조합이 끝난 뒤의 개별 명령이어야 한다.
    if (composingRef.current) return
    const raw = event.clipboardData.getData('text/plain')
    if (!raw.includes('\t') && !raw.includes('\n')) return
    event.preventDefault()
    const grid = parseTsv(raw)
    const rows = (block.rows ?? []).map((line) => [...line])
    for (const [lineIndex, line] of grid.entries()) {
      const target = row + lineIndex
      if (target >= MAX_TABLE_ROWS) break
      if (!rows[target]) rows[target] = Array.from({ length: rows[0]?.length ?? line.length }, () => '')
      for (const [cellIndex, cell] of line.entries()) {
        const targetColumn = column + cellIndex
        if (targetColumn >= MAX_TABLE_COLS || targetColumn >= rows[target].length) break
        rows[target][targetColumn] = cell
      }
    }
    replaceBlock(block.id, { rows })
  }

  // ── 키보드 ────────────────────────────────────────────────────────────────
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>, block: Block) => {
    if (event.nativeEvent.isComposing) return
    const box = event.currentTarget
    const caret = box.selectionStart ?? 0
    const hasSelection = (box.selectionStart ?? 0) !== (box.selectionEnd ?? 0)
    const at = indexOf(block.id)
    const previous = at > 0 ? blocks[at - 1] : null
    const next = at >= 0 && at + 1 < blocks.length ? blocks[at + 1] : null
    const openMenu = menu && (menu.kind === 'slash' || menu.kind === 'link') && menu.blockId === block.id ? menu : null

    if (openMenu) {
      const size = openMenu.kind === 'slash' ? slashMatches(openMenu.query).length : candidates.length
      if (event.key === 'Escape') { event.preventDefault(); setMenu(null); return }
      if (event.key === 'ArrowDown' && size) { event.preventDefault(); setMenu({ ...openMenu, index: (openMenu.index + 1) % size }); return }
      if (event.key === 'ArrowUp' && size) { event.preventDefault(); setMenu({ ...openMenu, index: (openMenu.index - 1 + size) % size }); return }
      if (event.key === 'Enter' && size) {
        event.preventDefault()
        if (openMenu.kind === 'slash') pickSlash(slashMatches(openMenu.query)[openMenu.index])
        else pickLink(candidates[openMenu.index])
        return
      }
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      if (menu) { setMenu(null); return }
      document.querySelector<HTMLButtonElement>(`[data-wiki-gutter="${block.id}"]`)?.focus()
      return
    }

    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault()
      moveBlock(block.id, event.key === 'ArrowUp' ? -1 : 1)
      return
    }

    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      insertAfter(block.id, { type: 'text', text: '' })
      return
    }

    if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
      if (block.type === 'code') return
      if (!isTextual(block.type)) return
      const text = block.text ?? ''
      if (isList(block.type) && text.length === 0) {
        event.preventDefault()
        const indent = Number(block.indent ?? 0)
        if (indent > 0) replaceBlock(block.id, { indent: indent - 1 })
        else changeType(block.id, 'text')
        return
      }
      event.preventDefault()
      const [head, tail] = splitAt(text, caret)
      const seed: Partial<Block> = isList(block.type)
        ? { type: block.type, text: tail, indent: Number(block.indent ?? 0), ...(block.type === 'todo' ? { checked: false } : {}) }
        : { type: 'text', text: tail }
      onFlushBefore()
      const made = clientBlockPayload({ ...seed, id: newBlockId(), type: seed.type ?? 'text' })
      const nextBlocks = [...blocks]
      nextBlocks[at] = { ...block, text: head }
      nextBlocks.splice(at + 1, 0, made)
      onApply(nextBlocks, [newUpdateOp(block.id, Number(block.seq ?? 0), { text: head }), newInsertOp(made, block.id)])
      focusWikiBlock(made.id, 0)
      return
    }

    if (event.key === 'Backspace' && caret === 0 && !hasSelection) {
      if (at === 0) { event.preventDefault(); return }
      const indent = Number(block.indent ?? 0)
      if (isList(block.type) && indent > 0) { event.preventDefault(); replaceBlock(block.id, { indent: indent - 1 }); return }
      // 캡션(이미지·파일)에서는 서식을 벗길 것이 없다. 그대로 두고 브라우저 기본 동작에 맡긴다.
      if (!isTextual(block.type)) return
      if (block.type !== 'text') {
        // 첫 Backspace는 서식만 벗긴다. 글이 먼저 사라지면 사람은 무엇을 지웠는지 모른다.
        event.preventDefault()
        changeType(block.id, 'text')
        return
      }
      if (!previous) { event.preventDefault(); return }
      if (isTextual(previous.type)) {
        event.preventDefault()
        onFlushBefore()
        const merged = mergeIntoPrevious(previous.text ?? '', block.text ?? '')
        const nextBlocks = blocks.filter((entry) => entry.id !== block.id)
          .map((entry) => (entry.id === previous.id ? { ...entry, text: merged.text } : entry))
        onApply(nextBlocks, [newUpdateOp(previous.id, Number(previous.seq ?? 0), { text: merged.text }), newDeleteOp(block.id)])
        focusWikiBlock(previous.id, merged.caret)
        return
      }
      // 표·이미지·파일·구분선은 한 번에 지우지 않는다. 한 번 누르면 지목하고, 다시 누르면 지운다.
      event.preventDefault()
      if (pendingDelete === previous.id) { setPendingDelete(null); removeBlock(previous.id); return }
      setPendingDelete(previous.id)
      setAnnouncement('앞 문단을 지웁니다. 지우려면 한 번 더 누르세요.')
      return
    }

    if (event.key === 'Delete' && caret === (block.text ?? '').length && !hasSelection && next && isTextual(next.type) && isTextual(block.type)) {
      event.preventDefault()
      onFlushBefore()
      const merged = mergeIntoPrevious(block.text ?? '', next.text ?? '')
      const nextBlocks = blocks.filter((entry) => entry.id !== next.id)
        .map((entry) => (entry.id === block.id ? { ...entry, text: merged.text } : entry))
      onApply(nextBlocks, [newUpdateOp(block.id, Number(block.seq ?? 0), { text: merged.text }), newDeleteOp(next.id)])
      focusWikiBlock(block.id, merged.caret)
      return
    }

    if (event.key === 'Tab' && isList(block.type)) {
      event.preventDefault()
      const previousIndent = previous && isList(previous.type) ? Number(previous.indent ?? 0) : null
      const wanted = indentDelta(Number(block.indent ?? 0), event.shiftKey ? -1 : 1, previousIndent)
      if (wanted !== Number(block.indent ?? 0)) replaceBlock(block.id, { indent: wanted })
      return
    }
    // 목록 밖의 Tab은 막지 않는다 — 키보드만 쓰는 사람이 편집기 안에 갇히지 않게.

    if (event.key === 'ArrowUp' && !event.altKey && caret === 0 && previous) {
      event.preventDefault()
      focusWikiBlock(previous.id, (previous.text ?? '').length)
      return
    }
    if (event.key === 'ArrowDown' && !event.altKey && caret === (block.text ?? '').length && next) {
      event.preventDefault()
      focusWikiBlock(next.id, 0)
    }
  }

  const handleCellKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>, block: Block, row: number, column: number) => {
    if (event.nativeEvent.isComposing) return
    const rows = block.rows ?? []
    if (event.key === 'Tab') {
      const lastColumn = (rows[row]?.length ?? 1) - 1
      if (!event.shiftKey && column === lastColumn && row === rows.length - 1) return
      event.preventDefault()
      const nextColumn = event.shiftKey ? column - 1 : column + 1
      const target = nextColumn < 0
        ? { row: row - 1, column: (rows[row - 1]?.length ?? 1) - 1 }
        : nextColumn > lastColumn ? { row: row + 1, column: 0 } : { row, column: nextColumn }
      window.setTimeout(() => {
        document.querySelector<HTMLInputElement>(`input[data-wiki-cell="${block.id}:${target.row}:${target.column}"]`)?.focus()
      }, 0)
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      if (rows.length >= MAX_TABLE_ROWS) return
      const width = rows[0]?.length ?? 1
      const nextRows = [...rows.map((line) => [...line])]
      nextRows.splice(row + 1, 0, Array.from({ length: width }, () => ''))
      replaceBlock(block.id, { rows: nextRows })
      window.setTimeout(() => {
        document.querySelector<HTMLInputElement>(`input[data-wiki-cell="${block.id}:${row + 1}:0"]`)?.focus()
      }, 0)
    }
  }

  // ── 끌어 옮기기 ───────────────────────────────────────────────────────────
  const onDragStart = (blockId: string) => { dragIdRef.current = blockId }
  const onDragOver = (event: ReactDragEvent<HTMLLIElement>, blockId: string) => {
    if (!dragIdRef.current || dragIdRef.current === blockId) return
    event.preventDefault()
    const box = event.currentTarget.getBoundingClientRect()
    setDropTarget({ id: blockId, before: event.clientY < box.top + box.height / 2 })
  }
  const onDrop = (event: ReactDragEvent<HTMLLIElement>, blockId: string) => {
    event.preventDefault()
    const dragged = dragIdRef.current
    dragIdRef.current = null
    const target = dropTarget
    setDropTarget(null)
    if (!dragged || dragged === blockId || !target) return
    onFlushBefore()
    const from = indexOf(dragged)
    const rest = blocks.filter((block) => block.id !== dragged)
    const anchorIndex = rest.findIndex((block) => block.id === blockId)
    const insertAt = target.before ? anchorIndex : anchorIndex + 1
    const nextBlocks = [...rest]
    nextBlocks.splice(insertAt, 0, blocks[from])
    const after = insertAt === 0 ? null : nextBlocks[insertAt - 1].id
    onApply(nextBlocks, [newMoveOp(dragged, after)])
    setAnnouncement(`문단을 ${insertAt + 1}번째로 옮겼습니다.`)
  }
  const onDragEnd = () => { dragIdRef.current = null; setDropTarget(null) }

  // ── 본문 입력에서 메뉴 열기 ───────────────────────────────────────────────
  const handleText = (blockId: string, value: string) => {
    onText(blockId, value)
    const box = document.querySelector<HTMLTextAreaElement>(`textarea[data-wiki-block="${blockId}"]`)
    const caret = box?.selectionStart ?? value.length
    const before = value.slice(0, caret)
    const slash = before.lastIndexOf('/')
    const mention = before.lastIndexOf('@')
    if (mention >= 0 && !/\s/u.test(before.slice(mention + 1))) {
      setMenu({ kind: 'link', blockId, query: before.slice(mention + 1), index: 0, at: mention })
      return
    }
    if (slash >= 0 && (slash === 0 || /\s/u.test(before[slash - 1])) && !/\s/u.test(before.slice(slash + 1))) {
      setMenu({ kind: 'slash', blockId, query: before.slice(slash + 1), index: 0, at: slash })
      return
    }
    if (menu?.kind === 'slash' || menu?.kind === 'link') setMenu(null)
  }

  const readGroups = useMemo(() => groupBlocksForRead([...blocks]), [blocks])

  /**
   * 붙을 문단이 사라진 안내들.
   *
   * `BLOCK_DELETED`는 **그 문단이 없다는 사실 자체**가 거절 사유라, 같은 응답의 문서에 그 문단이 이미
   * 없다. 안내를 문단 목록 안에서만 그리면 그 문장은 그려질 자리가 없어 사람이 방금 친 문장이
   * 아무 말 없이 사라진다. 그래서 목록 **밖**에 한 줄로 남기고, 이력으로 가는 길도 여기서 준다.
   */
  const orphans = orphanNotices(notices, blocks)
  const orphanList = orphans.length > 0 && (
    <ul className="wiki-orphan-notices" aria-live="polite">
      {orphans.map(({ blockId, notice }) => (
        <li key={blockId} data-code={notice.code}>
          {notice.message}
          {notice.version !== null && (
            <button type="button" onClick={() => onOpenNotice(notice.version)}>이력에서 보기</button>
          )}
        </li>
      ))}
    </ul>
  )

  if (readMode) {
    return (
      <div className="wiki-read">
        {orphanList}
        {readGroups.map((group, index) => {
          if (group.type === 'single') {
            const block = group.items[0]
            return (
              <ul className="wiki-block-list" key={block.id}>
                <WikiBlockRow
                  block={block} editable={editable} readMode
                  attachment={attachments.get(block.attachmentId ?? '') ?? null}
                  watchers={watchersOf(block.id)} notice={notices.get(block.id) ?? null}
                  taskLinked={Boolean(block.workItemId)} indent={Number(block.indent ?? 0)}
                  onText={handleText} onCell={onCell} onToggleTodo={onToggleTodo}
                  onKeyDown={handleKeyDown} onCellKeyDown={handleCellKeyDown}
                  onFocusBlock={onFocusedBlock} onBlurBlock={() => onFocusedBlock(null)}
                  onComposition={(_id, composing) => { composingRef.current = composing; onComposing(composing) }}
                  onPasteText={onPasteText} onPasteCell={onPasteCell}
                  onOpenLink={onOpenLink} onPromoteTask={onPromoteTask} onOpenTask={onOpenTask}
                  onOpenNotice={onOpenNotice} onOpenMenu={(target) => setMenu({ kind: 'block', blockId: target.id })}
                  onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop} onDragEnd={onDragEnd}
                />
              </ul>
            )
          }
          const ListTag = group.type === 'numbered' ? 'ol' : 'ul'
          return (
            <ListTag className="wiki-read-list" data-kind={group.type} key={`g${index}`}>
              {group.items.map((block) => (
                <li key={block.id} data-indent={Math.min(3, Number(block.indent ?? 0))}>
                  {block.type === 'todo' && (
                    <button
                      type="button"
                      className="wiki-todo-check"
                      aria-pressed={Boolean(block.checked)}
                      aria-label={block.checked ? '완료 표시 해제' : '완료로 표시'}
                      disabled={!editable}
                      onClick={() => onToggleTodo(block.id, !block.checked)}
                    >{block.checked ? '☑' : '☐'}</button>
                  )}
                  <WikiLinkText text={block.text ?? ''} onOpen={onOpenLink} />
                </li>
              ))}
            </ListTag>
          )
        })}
      </div>
    )
  }

  const menuBlock = menu?.kind === 'block' ? blocks[indexOf(menu.blockId)] : null

  return (
    <div className="wiki-editor">
      <p className="sr-only" aria-live="polite">{announcement}</p>
      {orphanList}
      <ul className="wiki-block-list">
        {blocks.map((block) => (
          <WikiBlockRow
            key={block.id}
            block={block} editable={editable} readMode={false}
            attachment={attachments.get(block.attachmentId ?? '') ?? null}
            watchers={watchersOf(block.id)} notice={notices.get(block.id) ?? null}
            taskLinked={Boolean(block.workItemId)} indent={Number(block.indent ?? 0)}
            onText={handleText} onCell={onCell} onToggleTodo={onToggleTodo}
            onKeyDown={handleKeyDown} onCellKeyDown={handleCellKeyDown}
            onFocusBlock={onFocusedBlock} onBlurBlock={() => onFocusedBlock(null)}
            onComposition={(_id, composing) => { composingRef.current = composing; onComposing(composing) }}
            onPasteText={onPasteText} onPasteCell={onPasteCell}
            onOpenLink={onOpenLink} onPromoteTask={onPromoteTask} onOpenTask={onOpenTask}
            onOpenNotice={onOpenNotice} onOpenMenu={(target) => setMenu({ kind: 'block', blockId: target.id })}
            onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop} onDragEnd={onDragEnd}
          />
        ))}
      </ul>
      {dropTarget && <p className="sr-only" aria-live="polite">여기에 놓으면 {dropTarget.before ? '앞' : '뒤'}에 들어갑니다.</p>}
      {editable && (
        <Button tone="quiet" size="sm" onClick={() => insertAfter(blocks[blocks.length - 1]?.id ?? null, { type: 'text', text: '' })}>
          문단 추가
        </Button>
      )}
      {menu?.kind === 'slash' && (
        <div className="wiki-menu-anchor">
          <WikiSlashMenu items={slashMatches(menu.query)} activeIndex={menu.index} onPick={pickSlash} label="문단 종류 고르기" />
        </div>
      )}
      {menu?.kind === 'link' && (
        <div className="wiki-menu-anchor">
          <WikiLinkMenu candidates={candidates} activeIndex={menu.index} onPick={pickLink} query={menu.query} loading={candidateLoading} />
        </div>
      )}
      {menuBlock && (
        <div className="wiki-block-menu" role="group" aria-label="문단 다루기">
          <Button tone="quiet" size="sm" onClick={() => { setMenu(null); moveBlock(menuBlock.id, -1) }}><ArrowUp size={14} /> 위로 옮기기</Button>
          <Button tone="quiet" size="sm" onClick={() => { setMenu(null); moveBlock(menuBlock.id, 1) }}><ArrowDown size={14} /> 아래로 옮기기</Button>
          <Button tone="quiet" size="sm" onClick={() => {
            setMenu(null)
            // 서버 소유 필드를 떨구고 그 타입의 필드만 남긴다 — 그대로 복사하면 삽입이 400이다.
            const { id: _id, seq: _seq, editedById: _by, editedAt: _at, workItemId: _work, ...rest } = menuBlock
            insertAfter(menuBlock.id, rest)
          }}><Copy size={14} /> 아래에 복제</Button>
          <Button tone="quiet" size="sm" onClick={() => { setMenu(null); removeBlock(menuBlock.id) }}><Trash2 size={14} /> 문단 지우기</Button>
        </div>
      )}
    </div>
  )
}

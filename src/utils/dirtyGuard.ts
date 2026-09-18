/**
 * 쓰던 내용을 지키는 문지기(감사 shell-ux-25). 대화상자의 입력칸에 무언가를 쓴 뒤 Esc 한 번이나 바깥 한 번 누름으로
 * 창이 닫히면, 쓴 것이 말없이 사라졌다 — 손이 떨리거나 화면을 잘못 누르기 쉬운 사람에게 가장 아픈 일이다.
 *
 * 모든 대화상자(role="dialog")에 한 번에 건다: 폼 안의 입력칸에 입력이 생기면 그 창에 data-dirty를 달고,
 * 그 창을 Esc·바깥 누름으로 닫으려 하면 먼저 묻는다. [취소]·[닫기]처럼 뜻이 분명한 단추는 묻지 않는다.
 * 창마다 코드를 고치지 않으려고 window의 캡처 단계에서 가로챈다(화면들의 닫기 처리보다 먼저 돈다).
 */
export const DIRTY_ATTRIBUTE = 'data-dirty'
export const DISCARD_QUESTION = '작성 중인 내용이 있습니다. 닫으면 쓴 내용이 사라집니다. 닫을까요?'

/** 손댄 칸에 아직 글이 남아 있는가 — 보낸 뒤 비운 입력칸(대화창 등)은 물을 것이 없다. */
const hasTypedContent = (dialog: HTMLElement) => Array.from(dialog.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('form textarea, form input'))
  .some((field) => (field instanceof HTMLTextAreaElement || !['search', 'checkbox', 'radio', 'range', 'file', 'hidden', 'submit', 'button'].includes(field.type)) && field.value.trim() !== '')

const dirtyDialogOf = (node: EventTarget | null): HTMLElement | null => {
  if (!(node instanceof Element)) return null
  const dialog = node.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]')
  return dialog?.getAttribute(DIRTY_ATTRIBUTE) === 'true' ? dialog : null
}

const anyDirtyDialog = (): HTMLElement | null => document.querySelector<HTMLElement>(`[role="dialog"][${DIRTY_ATTRIBUTE}="true"], [role="alertdialog"][${DIRTY_ATTRIBUTE}="true"]`)

/** 설치하고, 떼는 함수를 돌려준다. `confirm`은 시험에서 바꿔 끼운다. */
export function installDirtyGuard(confirm: (question: string) => boolean = (question) => window.confirm(question)) {
  const onInput = (event: Event) => {
    const target = event.target
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) return
    if (target instanceof HTMLInputElement && ['search', 'checkbox', 'radio', 'range', 'file'].includes(target.type)) return
    if (!target.closest('form')) return
    target.closest('[role="dialog"], [role="alertdialog"]')?.setAttribute(DIRTY_ATTRIBUTE, 'true')
  }
  const ask = (dialog: HTMLElement, event: Event) => {
    if (!hasTypedContent(dialog)) return
    if (confirm(DISCARD_QUESTION)) { dialog.removeAttribute(DIRTY_ATTRIBUTE); return }
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.isComposing) return
    const dialog = dirtyDialogOf(event.target) ?? anyDirtyDialog()
    if (dialog) ask(dialog, event)
  }
  const onPointerDown = (event: MouseEvent) => {
    const target = event.target
    if (!(target instanceof Element) || target.closest('[role="dialog"], [role="alertdialog"]')) return
    // 바깥(막) 누름: 누른 요소 안에 손댄 대화상자가 들어 있다.
    const dialog = target.querySelector<HTMLElement>(`[role="dialog"][${DIRTY_ATTRIBUTE}="true"], [role="alertdialog"][${DIRTY_ATTRIBUTE}="true"]`)
    if (dialog) ask(dialog, event)
  }
  window.addEventListener('input', onInput, true)
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('mousedown', onPointerDown, true)
  return () => {
    window.removeEventListener('input', onInput, true)
    window.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('mousedown', onPointerDown, true)
  }
}

import type { ComponentPropsWithRef, ReactNode } from 'react'
import './Button.css'

/**
 * 전 화면 공용 버튼. 버튼 톤앤매너의 유일한 출처이며, 화면별 버튼 스타일 정의는 두지 않는다.
 * - primary: 화면당 하나인 기본 행동
 * - secondary: 기본 행동 옆의 보조 행동 (포인트 컬러 연한 면)
 * - ghost: 취소·이동 등 중립 행동 (흰 면 + 테두리)
 * - quiet: 목록·헤더 안의 가벼운 이동 (테두리 없음)
 * - danger: 삭제처럼 되돌릴 수 없는 행동
 */
export type ButtonTone = 'primary' | 'secondary' | 'ghost' | 'quiet' | 'danger'
export type ButtonSize = 'md' | 'sm'

type SharedProps = {
  tone?: ButtonTone
  size?: ButtonSize
  /** 가로 전체를 채운다 (모바일 시트·모달 바닥 등). */
  full?: boolean
  children?: ReactNode
}

export function buttonClassName({ tone = 'ghost', size = 'md', full = false, className }: SharedProps & { className?: string }) {
  return ['ui-button', `is-${tone}`, size === 'sm' ? 'is-sm' : '', full ? 'is-full' : '', className].filter(Boolean).join(' ')
}

export type ButtonProps = SharedProps & Omit<ComponentPropsWithRef<'button'>, 'children'>

export function Button({ tone, size, full, className, type = 'button', ...rest }: ButtonProps) {
  return <button {...rest} type={type} className={buttonClassName({ tone, size, full, className })} />
}

export type ButtonLinkProps = SharedProps & Omit<ComponentPropsWithRef<'a'>, 'children'>

/** 다른 화면·외부 문서로 이동하는 링크를 버튼과 같은 톤으로 보여 준다. */
export function ButtonLink({ tone, size, full, className, ...rest }: ButtonLinkProps) {
  return <a {...rest} className={buttonClassName({ tone, size, full, className })} />
}

export type IconButtonProps = Omit<ComponentPropsWithRef<'button'>, 'children'> & {
  tone?: Extract<ButtonTone, 'ghost' | 'quiet' | 'danger'>
  size?: ButtonSize
  /** 접근성상 아이콘 버튼은 이름이 필수다. */
  'aria-label': string
  children?: ReactNode
}

export function IconButton({ tone = 'ghost', size = 'md', className, type = 'button', ...rest }: IconButtonProps) {
  return <button {...rest} type={type} className={['ui-icon-button', `is-${tone}`, size === 'sm' ? 'is-sm' : '', className].filter(Boolean).join(' ')} />
}

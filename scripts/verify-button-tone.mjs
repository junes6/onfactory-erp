import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

/**
 * 버튼 톤앤매너 단일화 게이트.
 * 1) 화면 코드는 레거시 버튼 클래스를 쓰지 않는다 — 공용 Button/IconButton만 쓴다.
 * 2) 공용 버튼의 모양(높이·여백·색·테두리·타입)은 src/components/ui/Button.css에서만 정한다.
 *    화면 CSS는 배치(폭·flex·grid·margin)만 조정할 수 있다.
 */
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1))), '..')
const sourceRoot = path.join(root, 'src')
const buttonCss = path.join(sourceRoot, 'components', 'ui', 'Button.css')

const LEGACY_CLASSES = [
  'button', 'primary-button', 'secondary-button', 'small-button', 'text-button', 'text-action-button',
  'danger-text-button', 'collab-button', 'pc-button', 'pc-row-button', 'factory-button', 'icon-button',
  'close-button', 'channel-sync-button', 'journal-view-button',
]
const LAYOUT_PROPERTIES = new Set([
  'width', 'min-width', 'max-width', 'flex', 'flex-grow', 'flex-shrink', 'flex-basis',
  'grid-column', 'grid-row', 'grid-area', 'justify-self', 'align-self', 'place-self', 'order',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'margin-inline', 'margin-block',
  'justify-content', 'visibility', 'position', 'inset', 'top', 'right', 'bottom', 'left', 'z-index',
])

function walk(directory, extension) {
  const files = []
  for (const entry of readdirSync(directory)) {
    const target = path.join(directory, entry)
    if (statSync(target).isDirectory()) files.push(...walk(target, extension))
    else if (target.endsWith(extension)) files.push(target)
  }
  return files.sort()
}

const relative = (file) => path.relative(root, file).replaceAll('\\', '/')
const lineAt = (source, index) => source.slice(0, index).split('\n').length

const errors = []

const legacySet = new Set(LEGACY_CLASSES)
for (const file of walk(sourceRoot, '.tsx')) {
  if (relative(file).includes('/ui/Button')) continue
  const source = readFileSync(file, 'utf8')
  // className에 실제로 들어가는 문자열 조각만 본다 (문자열 리터럴 · 템플릿 리터럴 안의 고정 부분).
  for (const attribute of source.matchAll(/className=(?:"([^"]*)"|\{([^}]*)\})/g)) {
    const literals = attribute[1] !== undefined
      ? [attribute[1]]
      : [...(attribute[2] ?? '').matchAll(/['"`]([^'"`]*)['"`]/g)].map((match) => match[1])
    for (const literal of literals) {
      for (const token of literal.split(/\s+/).filter(Boolean)) {
        if (legacySet.has(token)) {
          errors.push(`${relative(file)}:${lineAt(source, attribute.index)} 레거시 버튼 클래스 '${token}' — 공용 Button/IconButton을 쓰세요.`)
        }
      }
    }
  }
}

for (const file of walk(sourceRoot, '.css')) {
  const source = readFileSync(file, 'utf8')
  const isShared = path.resolve(file) === path.resolve(buttonCss)
  if (!isShared) {
    for (const legacy of LEGACY_CLASSES) {
      const pattern = new RegExp(`\\.${legacy}(?![\\w-])`, 'g')
      for (const match of source.matchAll(pattern)) {
        errors.push(`${relative(file)}:${lineAt(source, match.index)} 화면 CSS가 레거시 버튼 클래스 '.${legacy}'를 정의합니다.`)
      }
    }
  }
  if (isShared) continue
  for (const rule of source.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const [, selector, body] = rule
    if (!/\.ui-(?:icon-)?button(?![\w-])/.test(selector)) continue
    for (const declaration of body.matchAll(/([\w-]+)\s*:\s*([^;]+)/g)) {
      const property = declaration[1].toLowerCase()
      const value = declaration[2].trim()
      if (LAYOUT_PROPERTIES.has(property)) continue
      if (property === 'display' && /^(?:none|contents)$/.test(value)) continue
      errors.push(`${relative(file)}:${lineAt(source, rule.index)} 화면 CSS는 공용 버튼의 배치만 바꿀 수 있습니다 (${selector.trim().slice(0, 60)} → ${property}). 크기·색은 tone/size prop으로 지정하세요.`)
    }
  }
}

if (errors.length) {
  console.error(`[button-tone] ${errors.length}개 위반을 발견했습니다.`)
  console.error(errors.join('\n'))
  process.exitCode = 1
} else {
  console.log('[button-tone] 전 화면 버튼이 공용 컴포넌트 하나를 쓰고, 모양 정의는 Button.css에만 있습니다.')
}

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const workspaceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1))), '..')
const sourceRoot = path.join(workspaceRoot, 'src')
const tokenFile = path.join(sourceRoot, 'tokens.css')
const fixMode = process.argv.includes('--fix')
const verboseTsx = process.argv.includes('--verbose-tsx')

const allowedPalette = new Set([
  '#f4f4f2', '#ffffff', '#1c1c1b', '#16324f', '#2f6b8f', '#1d9e75', '#ef9f27', '#e24b4a',
  '#f2f2f0', '#d9d9d5', '#a7a7a1', '#6b6b67', '#3b3b39',
  '#e2e2dd',
])
const fontTokens = new Set(['var(--font-22)', 'var(--font-15)', 'var(--font-13)', 'var(--font-11)'])
const weightTokens = new Set(['var(--weight-regular)', 'var(--weight-medium)'])
const spaceTokens = new Set(['var(--space-0)', 'var(--space-4)', 'var(--space-8)', 'var(--space-12)', 'var(--space-16)', 'var(--space-24)', 'var(--space-32)'])
const allowedNamedColors = new Set(['transparent', 'currentcolor'])
const namedColorPattern = /(?<![\w-])(?:white|black|red|green|blue|orange|yellow|gray|grey|purple|pink|teal|navy|maroon|silver)(?![\w-])/gi
const colorFunctionPattern = /\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\([^)]*\)/gi
const hexPattern = /#[0-9a-f]{3,8}\b/gi
const tsxNamedColorAttributePattern = /(?:fill|stroke)=["'](?:white|black|red|green|blue|orange|yellow|gray|grey|purple|pink|teal|navy|maroon|silver)["']/i
const tsxNamedInlineStylePattern = /style\s*=\s*\{\{[^}]*\b(?:color|backgroundColor|background|borderColor|fill|stroke)\s*:\s*["'](?:white|black|red|green|blue|orange|yellow|gray|grey|purple|pink|teal|navy|maroon|silver)["']/i
const tsxInlineTypePattern = /\b(?:fontSize|fontWeight)\s*(?::|=)\s*\{?\s*["']?\d/i
const tsxEmbeddedTypePattern = /font-(?:size|weight)\s*:\s*(?!var\()/i

function walk(directory, extension) {
  const files = []
  for (const entry of readdirSync(directory)) {
    const target = path.join(directory, entry)
    if (statSync(target).isDirectory()) files.push(...walk(target, extension))
    else if (target.endsWith(extension)) files.push(target)
  }
  return files.sort()
}

function relative(file) {
  return path.relative(workspaceRoot, file).replaceAll('\\', '/')
}

function lineAt(source, index) {
  return source.slice(0, index).split('\n').length
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
}

function splitTopLevel(value) {
  const tokens = []
  let depth = 0
  let start = 0
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character === '(') depth += 1
    else if (character === ')') depth = Math.max(0, depth - 1)
    else if (/\s/.test(character) && depth === 0) {
      if (value.slice(start, index).trim()) tokens.push(value.slice(start, index).trim())
      start = index + 1
    }
  }
  if (value.slice(start).trim()) tokens.push(value.slice(start).trim())
  return tokens
}

function nearestSpace(pixelValue) {
  const values = [0, 4, 8, 12, 16, 24, 32]
  return values.reduce((best, candidate) => Math.abs(candidate - pixelValue) < Math.abs(best - pixelValue) ? candidate : best, 0)
}

function numericPixels(token) {
  const match = token.match(/-?(\d*\.?\d+)\s*(px|rem|em|vw|vh|%)?/i)
  if (!match) return 12
  const number = Number(match[1])
  const unit = String(match[2] || 'px').toLowerCase()
  if (unit === 'rem' || unit === 'em') return number * 15
  if (unit === 'vw' || unit === 'vh' || unit === '%') return Math.min(32, Math.max(4, number))
  return number
}

function spacingToken(token) {
  const normalized = token.trim()
  if (normalized === 'auto') return 'auto'
  if (spaceTokens.has(normalized)) return normalized
  if (/^calc\(var\(--space-(?:4|8|12|16|24|32)\) \* -1\)$/.test(normalized)) return normalized
  if (/^(?:inherit|initial|unset|revert|normal)$/.test(normalized)) return 'var(--space-0)'
  const negative = /^-/.test(normalized)
  const nearest = nearestSpace(numericPixels(normalized))
  if (nearest === 0) return 'var(--space-0)'
  return negative ? `calc(var(--space-${nearest}) * -1)` : `var(--space-${nearest})`
}

function transformSpacing(value) {
  const important = /\s*!important\s*$/.test(value)
  const clean = value.replace(/\s*!important\s*$/, '').trim()
  const tokens = splitTopLevel(clean)
  const transformed = (tokens.length && tokens.length <= 4 ? tokens : [clean]).map(spacingToken).join(' ')
  return `${transformed}${important ? ' !important' : ''}`
}

function transformFontSize(value) {
  const important = /\s*!important\s*$/.test(value)
  const clean = value.replace(/\s*!important\s*$/, '').trim()
  if (fontTokens.has(clean)) return `${clean}${important ? ' !important' : ''}`
  if (clean === 'var(--compact-meta-font)' || clean === 'var(--compact-label-font)') return `var(--font-13)${important ? ' !important' : ''}`
  if (clean === 'var(--compact-primary-font)') return `var(--font-15)${important ? ' !important' : ''}`
  const numbers = [...clean.matchAll(/(\d*\.?\d+)px/gi)].map((match) => Number(match[1]))
  const size = numbers.length ? Math.max(...numbers) : 15
  const token = size >= 18 ? '--font-22' : size >= 14 ? '--font-15' : size >= 12 ? '--font-13' : '--font-11'
  return `var(${token})${important ? ' !important' : ''}`
}

function parseHex(literal) {
  const value = literal.slice(1)
  const expanded = value.length <= 4 ? [...value].map((character) => character + character).join('') : value
  if (![6, 8].includes(expanded.length)) return null
  return {
    r: Number.parseInt(expanded.slice(0, 2), 16),
    g: Number.parseInt(expanded.slice(2, 4), 16),
    b: Number.parseInt(expanded.slice(4, 6), 16),
    a: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
  }
}

function parseRgb(literal) {
  const values = literal.match(/[\d.]+%?/g)
  if (!values || values.length < 3) return null
  const channel = (value) => value.endsWith('%') ? Number(value.slice(0, -1)) * 2.55 : Number(value)
  return { r: channel(values[0]), g: channel(values[1]), b: channel(values[2]), a: values[3] === undefined ? 1 : Number(values[3]) }
}

function rgbToHsl({ r, g, b }) {
  const red = r / 255
  const green = g / 255
  const blue = b / 255
  const maximum = Math.max(red, green, blue)
  const minimum = Math.min(red, green, blue)
  const lightness = (maximum + minimum) / 2
  if (maximum === minimum) return { h: 0, s: 0, l: lightness }
  const delta = maximum - minimum
  const saturation = lightness > .5 ? delta / (2 - maximum - minimum) : delta / (maximum + minimum)
  let hue = maximum === red ? (green - blue) / delta + (green < blue ? 6 : 0) : maximum === green ? (blue - red) / delta + 2 : (red - green) / delta + 4
  hue *= 60
  return { h: hue, s: saturation, l: lightness }
}

function colorToken(literal) {
  const lower = literal.toLowerCase()
  if (lower === 'white') return 'var(--color-surface)'
  if (lower === 'black') return 'var(--color-ink)'
  if (allowedNamedColors.has(lower)) return literal
  const rgb = lower.startsWith('#') ? parseHex(lower) : lower.startsWith('rgb') ? parseRgb(lower) : null
  if (!rgb) return 'var(--color-blue)'
  if (rgb.a < .3) return 'var(--color-overlay-subtle)'
  if (rgb.a < .8) return 'var(--color-overlay)'
  const { h, s, l } = rgbToHsl(rgb)
  if (s < .12) {
    if (l > .94) return 'var(--color-surface)'
    if (l > .84) return 'var(--color-gray-50)'
    if (l > .68) return 'var(--color-gray-200)'
    if (l > .48) return 'var(--color-gray-400)'
    if (l > .28) return 'var(--color-gray-600)'
    if (l > .15) return 'var(--color-gray-800)'
    return 'var(--color-ink)'
  }
  if (h < 16 || h >= 340) return l > .72 ? 'var(--color-danger-soft)' : 'var(--color-danger)'
  if (h < 76) return l > .72 ? 'var(--color-warning-soft)' : 'var(--color-warning)'
  if (h < 176) {
    if (l > .72) return 'var(--color-blue-soft)'
    if (l > .36 && s > .3) return 'var(--color-success)'
    return 'var(--color-blue-deep)'
  }
  if (h < 285) return l > .72 ? 'var(--color-blue-soft)' : l < .28 ? 'var(--color-blue-deep)' : 'var(--color-blue)'
  return l > .72 ? 'var(--color-blue-soft)' : 'var(--color-blue)'
}

function replaceNamedColorValues(source) {
  return source.replace(/([\w-]+\s*:\s*)([^;{}]+)/g, (_declaration, prefix, value) => (
    `${prefix}${value.replace(namedColorPattern, colorToken)}`
  ))
}

function replaceColors(source) {
  return source
    .replace(colorFunctionPattern, colorToken)
    .replace(hexPattern, colorToken)
    .replace(/([\w-]+\s*:\s*)([^;{}]+)/g, (_declaration, prefix, value) => (
      `${prefix}${value.replace(namedColorPattern, colorToken)}`
    ))
}

// The first development run of this script used a word-boundary expression for
// named colours. A hyphen is not a regex "word" character, so that expression
// also touched identifiers such as --color-blue and the white-space property.
// Keep this repair idempotent so an interrupted local conversion can safely be
// resumed without reverting concurrent stylesheet work.
function repairInitialNamedColorPass(source) {
  return source
    .replaceAll('var(--color-surface)-space', 'white-space')
    .replace(/var\(--color-var\(--color-blue\)-(50|200|400|600|800)\)/g, 'var(--color-gray-$1)')
    .replaceAll('var(--color-var(--color-blue)-deep)', 'var(--color-blue-deep)')
    .replaceAll('var(--color-var(--color-blue)-soft)', 'var(--color-blue-soft)')
    .replaceAll('var(--color-var(--color-blue))', 'var(--color-blue)')
    .replaceAll('var(--var(--color-blue)-soft)', 'var(--color-blue-soft)')
    .replaceAll('var(--var(--color-blue))', 'var(--color-blue)')
    .replace('--var(--color-blue): var(--color-blue);', '--blue: var(--color-blue);')
    .replace('--var(--color-blue)-soft: var(--color-blue-soft);', '--blue-soft: var(--color-blue-soft);')
    .replace('--var(--color-blue): var(--color-danger);', '--red: var(--color-danger);')
    .replace('--var(--color-blue)-soft: var(--color-danger-soft);', '--red-soft: var(--color-danger-soft);')
    .replace('--var(--color-blue)-soft: var(--color-blue-deep);', '--blue-soft: var(--color-blue-deep);')
    .replace('--var(--color-blue): var(--color-danger-soft);', '--red: var(--color-danger-soft);')
    .replace('--var(--color-blue)-soft: var(--color-danger);', '--red-soft: var(--color-danger);')
}

function fixCss(source) {
  let output = repairInitialNamedColorPass(source)
  output = output.replace(/box-shadow\s*:\s*([^;}]+)/gi, (_match, value) => `box-shadow: var(--shadow-none)${/!important/.test(value) ? ' !important' : ''}`)
  output = output.replace(/text-shadow\s*:\s*([^;}]+)/gi, (_match, value) => `text-shadow: var(--shadow-none)${/!important/.test(value) ? ' !important' : ''}`)
  output = output.replace(/font-size\s*:\s*([^;}]+)/gi, (_match, value) => `font-size: ${transformFontSize(value)}`)
  output = output.replace(/font-weight\s*:\s*([^;}]+)/gi, (_match, value) => {
    const important = /!important/.test(value)
    const numeric = Number(value.match(/\d+/)?.[0] ?? 500)
    return `font-weight: var(--weight-${numeric <= 400 ? 'regular' : 'medium'})${important ? ' !important' : ''}`
  })
  output = output.replace(/((?:margin|padding|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?)\s*:\s*([^;}]+)/gi, (_match, property, value) => `${property}: ${transformSpacing(value)}`)
  output = output.replace(/border-radius\s*:\s*([^;}]+)/gi, (_match, value) => `border-radius: var(--radius-8)${/!important/.test(value) ? ' !important' : ''}`)
  output = output.replace(/(--(?:radius|space|shadow)[\w-]*\s*:)\s*([^;}]+)/gi, (_match, property) => {
    if (/radius/i.test(property)) return `${property} var(--radius-8)`
    if (/shadow/i.test(property)) return `${property} var(--shadow-none)`
    return `${property} var(--space-32)`
  })
  output = output.replace(/(--compact-meta-font\s*:)\s*([^;}]+)/gi, '$1 var(--font-13)')
  output = output.replace(/(--compact-label-font\s*:)\s*([^;}]+)/gi, '$1 var(--font-13)')
  output = output.replace(/(--compact-primary-font\s*:)\s*([^;}]+)/gi, '$1 var(--font-15)')
  output = output.replace(/((?:border|outline)(?:-[\w-]+)?\s*:)\s*([^;}]+)/gi, (_match, property, value) => {
    if (/^(?:0|none)(?:\s*!important)?\s*$/i.test(value.trim())) return `${property} none${/!important/.test(value) ? ' !important' : ''}`
    const transformed = value.replace(/(?<![\w-])-?\d*\.?\d+(?:px|rem|em)\b/gi, 'var(--hairline)')
    return `${property} ${transformed}`
  })
  output = replaceColors(output)
  return output
}

function importantFree(value) {
  return value.replace(/\s*!important\s*$/, '').trim()
}

function validSpacing(value, property) {
  const tokens = splitTopLevel(importantFree(value))
  if (!tokens.length || tokens.length > 4) return false
  return tokens.every((token) => spaceTokens.has(token)
    || (token === 'var(--dashboard-spacing)' && /^(?:gap|row-gap|column-gap|margin(?:-top)?)$/.test(property))
    || (token === 'var(--card-inset)' && /^padding/.test(property))
    || (/^margin/.test(property) && token === 'auto')
    || /^calc\(var\(--space-(?:4|8|12|16|24|32)\) \* -1\)$/.test(token))
}

function verifyCss(file, source) {
  const errors = []
  const clean = stripComments(source)
  const isTokens = path.resolve(file) === path.resolve(tokenFile)
  for (const match of clean.matchAll(hexPattern)) {
    if (!isTokens || !allowedPalette.has(match[0].toLowerCase())) errors.push([match.index, `허용되지 않은 색상 ${match[0]}`])
  }
  for (const match of clean.matchAll(colorFunctionPattern)) errors.push([match.index, `하드코딩 색상 함수 ${match[0]}`])
  for (const declaration of clean.matchAll(/([\w-]+\s*:\s*)([^;{}]+)/g)) {
    for (const match of declaration[2].matchAll(namedColorPattern)) {
      errors.push([declaration.index + declaration[1].length + match.index, `하드코딩 색상 이름 ${match[0]}`])
    }
  }
  for (const match of clean.matchAll(/font-size\s*:\s*([^;}]+)/gi)) {
    if (!fontTokens.has(importantFree(match[1]))) errors.push([match.index, `font-size 토큰 위반: ${match[1].trim()}`])
  }
  for (const match of clean.matchAll(/font-weight\s*:\s*([^;}]+)/gi)) {
    if (!weightTokens.has(importantFree(match[1]))) errors.push([match.index, `font-weight 토큰 위반: ${match[1].trim()}`])
  }
  for (const match of clean.matchAll(/(?<!-)\bfont\s*:\s*([^;}]+)/gi)) {
    if (!['inherit', 'initial', 'unset'].includes(importantFree(match[1]))) errors.push([match.index, `font shorthand 금지: ${match[1].trim()}`])
  }
  for (const match of clean.matchAll(/((?:margin|padding|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?)\s*:\s*([^;}]+)/gi)) {
    if (!validSpacing(match[2], match[1])) errors.push([match.index, `spacing 토큰 위반: ${match[1]}: ${match[2].trim()}`])
  }
  for (const match of clean.matchAll(/border-radius\s*:\s*([^;}]+)/gi)) {
    if (importantFree(match[1]) !== 'var(--radius-8)') errors.push([match.index, `radius 토큰 위반: ${match[1].trim()}`])
  }
  for (const match of clean.matchAll(/(?:box-shadow|text-shadow)\s*:\s*([^;}]+)/gi)) {
    if (!['none', 'var(--shadow-none)'].includes(importantFree(match[1]))) errors.push([match.index, `shadow 토큰 위반: ${match[1].trim()}`])
  }
  for (const match of clean.matchAll(/((?:border|outline)(?:-[\w-]+)?)\s*:\s*([^;}]+)/gi)) {
    const value = importantFree(match[2])
    if (/(?:^|\s)-?\d*\.?\d+(?:px|rem|em)\b/i.test(value)) errors.push([match.index, `hairline 토큰 위반: ${match[1]}: ${value}`])
  }
  return errors.map(([index, message]) => `${relative(file)}:${lineAt(clean, index)} ${message}`)
}

function verifyTokenContract(source) {
  const required = [
    '--font-22: 22px', '--font-15: 15px', '--font-13: 13px', '--font-11: 11px',
    '--weight-regular: 400', '--weight-medium: 500', '--color-page: #F4F4F2', '--color-surface: #FFFFFF',
    '--card-inset: 20px', '--radius-12: 12px', '--radius-8: var(--radius-12)', '--hairline: .5px', '--shadow-none: none',
    '--dashboard-spacing: 20px', '--dashboard-stroke: 1px', '--color-card-line: #E2E2DD',
    '--space-4: 4px', '--space-8: 8px', '--space-12: 12px', '--space-16: 16px', '--space-24: 24px', '--space-32: 32px',
  ]
  return required.filter((contract) => !source.includes(contract)).map((contract) => `src/tokens.css:1 필수 토큰 누락: ${contract}`)
}

function reportTsx() {
  const findings = []
  for (const file of walk(sourceRoot, '.tsx')) {
    const source = readFileSync(file, 'utf8')
    const lines = source.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      const reasons = []
      if (/(?:#[0-9a-f]{3,8}\b|rgba?\(|hsla?\()/i.test(line)
        || tsxNamedColorAttributePattern.test(line)
        || tsxNamedInlineStylePattern.test(line)) reasons.push('inline color')
      if (tsxInlineTypePattern.test(line) || tsxEmbeddedTypePattern.test(line)) reasons.push('inline type')
      if (/\bstyle\s*=\s*\{/.test(line)) reasons.push('inline style')
      if (/\bStatusPill\b/.test(line)) reasons.push('StatusPill')
      if (reasons.length) findings.push({
        file: relative(file),
        line: index + 1,
        reasons,
        snippet: line.trim().slice(0, 180),
      })
    }
  }
  return findings
}

const cssFiles = walk(sourceRoot, '.css')
if (fixMode) {
  let changed = 0
  for (const file of cssFiles) {
    if (path.resolve(file) === path.resolve(tokenFile)) continue
    const source = readFileSync(file, 'utf8')
    const fixed = fixCss(source)
    if (fixed !== source) {
      writeFileSync(file, fixed, 'utf8')
      changed += 1
    }
  }
  console.log(`[design-tokens] ${changed}개 CSS 파일을 토큰 규칙으로 변환했습니다.`)
}

const errors = [
  ...verifyTokenContract(readFileSync(tokenFile, 'utf8')),
  ...cssFiles.flatMap((file) => verifyCss(file, readFileSync(file, 'utf8'))),
]
const tsxFindings = reportTsx()
errors.push(...tsxFindings
  .filter((finding) => finding.reasons.includes('inline color') || finding.reasons.includes('inline type'))
  .map((finding) => `${finding.file}:${finding.line} TSX 하드코딩 ${finding.reasons.includes('inline color') ? '색상' : '타입'}은 CSS 토큰 이름으로 전환해야 합니다.`))
if (tsxFindings.length) {
  console.log(`[design-tokens] TSX 후속 검토 ${tsxFindings.length}건 (inline color/type은 차단, 동적 style/StatusPill은 보고):`)
  const grouped = new Map()
  for (const finding of tsxFindings) {
    const byReason = grouped.get(finding.file) ?? new Map()
    for (const reason of finding.reasons) {
      const lines = byReason.get(reason) ?? []
      lines.push(finding.line)
      byReason.set(reason, lines)
    }
    grouped.set(finding.file, byReason)
  }
  for (const [file, byReason] of grouped) {
    console.log(`${file}: ${[...byReason].map(([reason, lines]) => `${reason} ${lines.join(',')}`).join(' / ')}`)
  }
  if (verboseTsx) {
    console.log(tsxFindings.map((finding) => `${finding.file}:${finding.line} [${finding.reasons.join(', ')}] ${finding.snippet}`).join('\n'))
  }
}
if (errors.length) {
  console.error(`[design-tokens] ${errors.length}개 위반을 발견했습니다.`)
  console.error(errors.join('\n'))
  process.exitCode = 1
} else {
  console.log(`[design-tokens] CSS ${cssFiles.length}개가 팔레트·타입·spacing·radius·shadow·hairline 규칙을 통과했습니다.`)
}

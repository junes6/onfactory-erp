import { createHash } from 'node:crypto'

/**
 * 검토 자료(AI가 만든 한 파일짜리 HTML)에서 **그리기 사본**과 **항목 목록**을 만든다.
 *
 * 원본 바이트는 다른 곳에 그대로 둔다. 여기서도 원본 문자열을 파서로 읽고 다시 쓰지 않는다 —
 * 다시 쓰면 공백·따옴표·속성 순서가 달라져 자료 자체 스크립트(탭, 시안 불러오기)가 깨질 수 있다.
 * 그래서 태그마다 원본 위치를 적어 두고, **바꿀 자리만 한 번에 고친다**(큰 data: 값 떼어 내기, 항목 표시 붙이기).
 * 파서 라이브러리를 들이지 않으려고 관대한 토크나이저를 직접 둔다. 브라우저 규칙 중 표·목록·문단에 필요한 만큼만 따른다.
 */

export const MATERIAL_LIMITS = Object.freeze({
  maxSourceBytes: 30 * 1024 * 1024,
  maxRenderBytes: 3 * 1024 * 1024,
  maxAssetBytes: 10 * 1024 * 1024,
  maxAssets: 500,
  maxAnchors: 2000,
  assetThresholdBytes: 8 * 1024,
  srcdocThresholdBytes: 32 * 1024,
  maxAnchorText: 20000,
})

export class MaterialHtmlError extends Error {
  constructor(code, message, status = 413) {
    super(message)
    this.name = 'MaterialHtmlError'
    this.code = code
    this.status = status
  }
}

const ASSET_PREFIX = 'itf-asset:'
const ANCHOR_ATTRIBUTE = 'data-itf-a'
const SRCDOC_MIME = 'text/html; charset=utf-8'
// 떼어 낼 수 있는 형식만 받는다. svg는 앱이 <img>·blob으로만 넣으므로 안의 스크립트가 돌지 않는다.
const EXTRACTABLE_MIME = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml',
  'font/woff2', 'font/woff', 'application/font-woff', 'font/ttf', 'font/otf',
])
// 'image/jpg'는 표준 이름이 아니지만 AI가 자주 쓰고 브라우저도 그림으로 그린다 — 같은 형식으로 본다.
const MIME_ALIASES = new Map([['image/jpg', 'image/jpeg']])

const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(1)
const sha256Hex = (value) => createHash('sha256').update(value).digest('hex')
// 태그 이름으로 찾는 표는 원형(prototype)이 없어야 한다 — 그렇지 않으면 <constructor>가 제목(h1~h6)으로 읽힌다.
const lookup = (entries) => Object.freeze(Object.assign(Object.create(null), entries))

// ---------------------------------------------------------------------------
// 문자 참조(&amp; 같은 것) 풀기 — 제목·글·속성 값을 사람이 읽는 글자로 바꿀 때만 쓴다(원본은 그대로 둔다).
// ---------------------------------------------------------------------------

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '©', reg: '®', trade: '™',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„',
  laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›', middot: '·', bull: '•', times: '×', divide: '÷', minus: '−',
  plusmn: '±', deg: '°', micro: 'µ', para: '¶', sect: '§', euro: '€', cent: '¢', pound: '£', yen: '¥', curren: '¤',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', lArr: '⇐', rArr: '⇒', hArr: '⇔', uArr: '⇑', dArr: '⇓',
  le: '≤', ge: '≥', ne: '≠', asymp: '≈', infin: '∞', sum: '∑', prod: '∏', radic: '√', prime: '′', Prime: '″',
  ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', zwnj: '\u200c', zwj: '\u200d', lrm: '\u200e', rlm: '\u200f', shy: '\u00ad',
  iexcl: '¡', iquest: '¿', frac12: '½', frac14: '¼', frac34: '¾', sup1: '¹', sup2: '²', sup3: '³', ordf: 'ª', ordm: 'º',
  not: '¬', macr: '¯', acute: '´', cedil: '¸', uml: '¨', dagger: '†', Dagger: '‡', permil: '‰', loz: '◊',
  spades: '♠', clubs: '♣', hearts: '♥', diams: '♦', check: '✓', cross: '✗', star: '☆', starf: '★', hyphen: '‐',
  horbar: '―', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', pi: 'π', mu: 'μ', sigma: 'σ', omega: 'ω', Omega: 'Ω',
  tab: '\t', NewLine: '\n', colon: ':', comma: ',', period: '.', excl: '!', quest: '?', num: '#', dollar: '$',
  percnt: '%', lpar: '(', rpar: ')', ast: '*', plus: '+', equals: '=', sol: '/', bsol: '\\', lsqb: '[', rsqb: ']',
  lbrack: '[', rbrack: ']', lcub: '{', rcub: '}', vert: '|', verbar: '|', grave: '`', Hat: '^', lowbar: '_',
  semi: ';', commat: '@',
}
// 세미콜론 없이도 브라우저가 푸는 옛 이름(자주 보이는 것만).
const LEGACY_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'nbsp', 'copy', 'reg'])
// &#128; ~ &#159;는 브라우저가 windows-1252 글자로 읽는다.
const C1_REMAP = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6,
  0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c,
  0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a,
  0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
}
const ENTITY_RE = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]{0,31}))(;?)/g

function codePointText(code) {
  if (!Number.isFinite(code) || code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\ufffd'
  return String.fromCodePoint(C1_REMAP[code] ?? code)
}

export function decodeHtmlEntities(text) {
  const value = String(text ?? '')
  if (value.indexOf('&') < 0) return value
  return value.replace(ENTITY_RE, (whole, decimal, hex, name, semicolon, offset) => {
    if (decimal !== undefined) return codePointText(Number.parseInt(decimal, 10))
    if (hex !== undefined) return codePointText(Number.parseInt(hex, 16))
    if (semicolon) return Object.hasOwn(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : whole
    if (!LEGACY_ENTITIES.has(name)) return whole
    const next = value.charCodeAt(offset + whole.length)
    const alnumOrEquals = (next >= 48 && next <= 57) || (next >= 65 && next <= 90) || (next >= 97 && next <= 122) || next === 61
    return alnumOrEquals ? whole : NAMED_ENTITIES[name]
  })
}

// ---------------------------------------------------------------------------
// 토크나이저 + 가벼운 요소 나무
// ---------------------------------------------------------------------------

const isSpace = (c) => c === 32 || c === 10 || c === 9 || c === 13 || c === 12
const isAlpha = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122)

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'keygen', 'basefont', 'bgsound', 'frame'])
// 안의 글자를 태그로 읽지 않는 요소. noscript는 스크립트가 켜진 브라우저(자료 칸)처럼 글자로 본다.
const RAW_TEXT_TAGS = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'textarea', 'title'])
const HEAD_CONTENT = new Set(['base', 'basefont', 'bgsound', 'link', 'meta', 'noframes', 'script', 'style', 'template', 'title', 'noscript'])
const HEADING_LEVEL = lookup({ h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 })
const MAX_OPEN_DEPTH = 512
const DEFAULT_SCOPE = new Set(['applet', 'caption', 'html', 'table', 'td', 'th', 'marquee', 'object', 'template'])
const LIST_SCOPE = new Set([...DEFAULT_SCOPE, 'ol', 'ul'])
const BUTTON_SCOPE = new Set([...DEFAULT_SCOPE, 'button'])
const TABLE_SCOPE = new Set(['html', 'table', 'template'])
const HTML_SCOPE = new Set(['html', 'template'])
const ROW_SCOPE = new Set(['html', 'table', 'template', 'tbody', 'thead', 'tfoot'])
const CELL_SCOPE = new Set([...ROW_SCOPE, 'tr'])
const TABLE_PARTS = new Set(['table', 'tbody', 'thead', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup'])
const CLOSES_P = new Set(['address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'dir', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'ul', 'li', 'dd', 'dt', 'listing', 'plaintext', 'xmp', 'search'])
// li·dd·dt를 자동으로 닫을 때 이 요소를 만나면 더 내려가지 않는다(브라우저의 'special' 요소 중 address·div·p 제외).
const LIST_ITEM_STOP = new Set(['applet', 'article', 'aside', 'blockquote', 'body', 'button', 'caption', 'center', 'details', 'dialog', 'dir', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'html', 'iframe', 'listing', 'main', 'marquee', 'menu', 'nav', 'object', 'ol', 'pre', 'search', 'section', 'select', 'summary', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'tr', 'ul', 'dd', 'dt', 'li'])

/**
 * 태그 하나를 읽는다. pos는 태그 이름의 첫 글자.
 * 속성마다 이름의 시작 ns와 값의 원본 위치 [vs, ve)를 적는다(값 없는 속성은 -1). 따옴표 안의 '>'는 태그 끝이 아니다.
 */
function readTag(html, pos) {
  const length = html.length
  let p = pos
  while (p < length) {
    const c = html.charCodeAt(p)
    if (isSpace(c) || c === 47 || c === 62) break
    p += 1
  }
  const name = html.slice(pos, p).toLowerCase()
  const nameEnd = p
  const attrs = []
  let selfClosing = false
  while (p < length) {
    const c = html.charCodeAt(p)
    if (isSpace(c)) { p += 1; continue }
    if (c === 62) return { name, nameEnd, attrs, selfClosing, end: p + 1 }
    if (c === 47) {
      if (html.charCodeAt(p + 1) === 62) { selfClosing = true; return { name, nameEnd, attrs, selfClosing, end: p + 2 } }
      p += 1
      continue
    }
    const nameStart = p
    p += 1 // 첫 글자는 '='여도 이름의 일부다(브라우저 규칙)
    while (p < length) {
      const d = html.charCodeAt(p)
      if (isSpace(d) || d === 47 || d === 62 || d === 61) break
      p += 1
    }
    const attr = { name: html.slice(nameStart, p).toLowerCase(), ns: nameStart, vs: -1, ve: -1 }
    let q = p
    while (q < length && isSpace(html.charCodeAt(q))) q += 1
    if (html.charCodeAt(q) === 61) {
      q += 1
      while (q < length && isSpace(html.charCodeAt(q))) q += 1
      const quote = html.charCodeAt(q)
      if (quote === 34 || quote === 39) {
        const close = html.indexOf(quote === 34 ? '"' : "'", q + 1)
        if (close < 0) return { name, nameEnd, attrs, selfClosing, end: length, eof: true }
        attr.vs = q + 1
        attr.ve = close
        p = close + 1
      } else {
        const start = q
        while (q < length) {
          const d = html.charCodeAt(q)
          if (isSpace(d) || d === 62) break
          q += 1
        }
        attr.vs = start
        attr.ve = q
        p = q
      }
    } else {
      p = q
    }
    attrs.push(attr)
  }
  return { name, nameEnd, attrs, selfClosing, end: length, eof: true }
}

// <script> 안의 글: '<!--' 뒤에서 '<script'를 만나면 브라우저는 그다음 '</script>'를 끝으로 보지 않는다
// (옛 document.write 관용구, 명세의 script data escaped 상태). 이 규칙을 따르지 않으면 스크립트 글 한가운데를
// 태그로 읽어 항목 표시를 끼워 넣거나 JS 문자열 속 그림을 떼어 내게 된다.
const SCRIPT_DATA = /<!--|<\/script[\t\n\f\r />]/gi
const SCRIPT_ESCAPED = /-->|<(\/?)script[\t\n\f\r />]/gi
const SCRIPT_DOUBLE_ESCAPED = /-->|<\/script[\t\n\f\r />]/gi

/** 스크립트를 닫는 '</script'의 위치. 없으면 -1. */
function scriptCloseIndex(html, from) {
  let state = SCRIPT_DATA
  let p = from
  for (;;) {
    state.lastIndex = p
    const match = state.exec(html)
    if (!match) return -1
    if (state === SCRIPT_DATA) {
      if (match[0] !== '<!--') return match.index
      state = SCRIPT_ESCAPED
      p = match.index + 2 // '<!-->'처럼 여는 '--'가 곧바로 닫힐 수 있다
    } else if (match[0] === '-->') {
      state = SCRIPT_DATA
      p = match.index + 3
    } else if (state === SCRIPT_ESCAPED) {
      if (match[1]) return match.index
      state = SCRIPT_DOUBLE_ESCAPED
      p = match.index + 7
    } else {
      state = SCRIPT_ESCAPED
      p = match.index + 8
    }
  }
}

/**
 * HTML 문자열을 가벼운 요소 나무로 읽는다. 원본은 건드리지 않고 위치만 적는다.
 * - 요소: { tag, start, nameEnd, tagEnd, end, attrs, parent, children, index }
 *   start = '<' 위치, nameEnd = 태그 이름 바로 뒤(속성을 끼울 자리), tagEnd = 여는 태그 '>' 다음, end = 닫힌 자리
 * - 글 조각: { tag: '#text', start, end, parent }
 * 짝이 안 맞는 닫는 태그는 가장 가까운 같은 이름까지 닫고, 열린 적 없는 닫는 태그는 버린다.
 */
export function parseMaterialHtml(source) {
  const html = String(source ?? '')
  const length = html.length
  const root = { tag: '#root', start: 0, nameEnd: 0, tagEnd: 0, end: length, attrs: [], parent: null, children: [], index: -1 }
  const elements = []
  const stack = []
  const seen = { html: null, head: null, body: null }
  const rawCloseRes = new Map()

  const current = () => (stack.length ? stack[stack.length - 1] : root)

  function addText(start, end) {
    if (end <= start) return
    const parent = current()
    const last = parent.children[parent.children.length - 1]
    if (last && last.tag === '#text' && last.end === start) last.end = end
    else parent.children.push({ tag: '#text', start, end, parent })
  }
  // 태그 이름별·범위 경계별로 지금 열린 요소의 자리(stack 번호)를 쌓아 둔다. 닫을 대상과 그 위의 경계를 목록을 훑지 않고
  // 바로 찾으려는 것이다 — 512단으로 겹친 뒤 짝 없는 닫는 태그를 수백만 개 붙인 파일이 분석을 붙잡지 못하게.
  const openAt = new Map()
  const scopeAt = new Map([DEFAULT_SCOPE, LIST_SCOPE, BUTTON_SCOPE, TABLE_SCOPE, HTML_SCOPE, ROW_SCOPE, CELL_SCOPE, LIST_ITEM_STOP].map((scope) => [scope, []]))
  const scopesByTag = new Map()
  const scopesOf = (tag) => {
    let lists = scopesByTag.get(tag)
    if (!lists) {
      lists = []
      for (const [scope, marks] of scopeAt) if (scope.has(tag)) lists.push(marks)
      scopesByTag.set(tag, lists)
    }
    return lists
  }
  const topOf = (list) => (list && list.length ? list[list.length - 1] : -1)
  const openTotal = (name) => openAt.get(name)?.length ?? 0
  function push(el) {
    const index = stack.length
    stack.push(el)
    let list = openAt.get(el.tag)
    if (!list) openAt.set(el.tag, (list = []))
    list.push(index)
    for (const marks of scopesOf(el.tag)) marks.push(index)
  }
  function popTo(index, targetEnd, aboveEnd) {
    for (let k = stack.length - 1; k >= index; k -= 1) {
      const el = stack[k]
      el.end = k === index ? targetEnd : aboveEnd
      openAt.get(el.tag).pop()
      for (const marks of scopesOf(el.tag)) marks.pop()
    }
    stack.length = index
  }
  // 가장 안쪽에 열린 name. 그보다 안쪽에 범위 경계(표·칸 등)가 열려 있으면 없는 것으로 본다(브라우저의 'in scope' 규칙).
  function findOpen(name, boundary) {
    const k = topOf(openAt.get(name))
    return k >= 0 && k >= topOf(scopeAt.get(boundary)) ? k : -1
  }
  function findOpenAny(names, boundary) {
    let k = -1
    for (const name of names) k = Math.max(k, topOf(openAt.get(name)))
    return k >= 0 && k >= topOf(scopeAt.get(boundary)) ? k : -1
  }
  const inForeign = () => openTotal('svg') + openTotal('math') > openTotal('foreignobject')
  function closeIfOpen(name, boundary, at) {
    const k = findOpen(name, boundary)
    if (k >= 0) popTo(k, at, at)
  }

  const LI = new Set(['li'])
  const DD_DT = new Set(['dd', 'dt'])
  const CELLS = new Set(['td', 'th'])
  const SECTIONS = new Set(['tbody', 'thead', 'tfoot'])
  const HEADINGS = new Set(Object.keys(HEADING_LEVEL))

  function openElement(tag, lt) {
    const name = tag.name
    if (current().tag === 'head' && !HEAD_CONTENT.has(name)) popTo(stack.length - 1, lt, lt)
    if (name === 'html' && (seen.html || stack.length)) return null
    if (name === 'head' && (seen.head || seen.body)) return null
    if (name === 'body') {
      if (seen.body) return null
      closeIfOpen('head', HTML_SCOPE, lt)
    }
    // 브라우저가 알아서 닫는 태그(</p>, </li>, </tr> …)를 흉내 낸다.
    if (CLOSES_P.has(name)) closeIfOpen('p', BUTTON_SCOPE, lt)
    if (HEADING_LEVEL[name] && HEADING_LEVEL[current().tag]) popTo(stack.length - 1, lt, lt)
    if (name === 'li' || name === 'dd' || name === 'dt') {
      const k = findOpenAny(name === 'li' ? LI : DD_DT, LIST_ITEM_STOP)
      if (k >= 0) popTo(k, lt, lt)
    } else if (name === 'tr') {
      closeIfOpen('tr', ROW_SCOPE, lt)
    } else if (name === 'td' || name === 'th') {
      const k = findOpenAny(CELLS, CELL_SCOPE)
      if (k >= 0) popTo(k, lt, lt)
    } else if (SECTIONS.has(name)) {
      const k = findOpenAny(SECTIONS, TABLE_SCOPE)
      if (k >= 0) popTo(k, lt, lt)
    } else if (name === 'option') {
      if (current().tag === 'option') popTo(stack.length - 1, lt, lt)
    } else if (name === 'optgroup') {
      if (current().tag === 'option') popTo(stack.length - 1, lt, lt)
      if (current().tag === 'optgroup') popTo(stack.length - 1, lt, lt)
    } else if (name === 'a' || name === 'button' || name === 'select') {
      closeIfOpen(name, DEFAULT_SCOPE, lt)
    }
    const parent = current()
    const el = { tag: name, start: lt, nameEnd: tag.nameEnd, tagEnd: tag.end, end: tag.end, attrs: tag.attrs, parent, children: [], index: elements.length, childIndex: parent.children.length }
    parent.children.push(el)
    elements.push(el)
    if (name === 'html' || name === 'head' || name === 'body') seen[name] = el
    if (VOID_TAGS.has(name) || (tag.selfClosing && (inForeign() || name === 'svg' || name === 'math'))) return el
    // 브라우저처럼 512단보다 깊게는 쌓지 않는다(더 깊은 요소는 그 자리의 형제로 붙는다). 글자 요소는 바로 닫히므로 예외.
    if (stack.length >= MAX_OPEN_DEPTH && !RAW_TEXT_TAGS.has(name)) return el
    push(el)
    return el
  }

  function closeElement(name, lt, end) {
    // </body>·</html> 뒤에 온 내용도 브라우저는 body에 붙인다 — 닫지 않고 넘긴다.
    if (name === 'html' || name === 'body' || name === 'br') return
    if (HEADING_LEVEL[name]) {
      const k = findOpenAny(HEADINGS, DEFAULT_SCOPE)
      if (k >= 0) popTo(k, end, lt)
      return
    }
    let boundary = DEFAULT_SCOPE
    if (name === 'li') boundary = LIST_SCOPE
    else if (name === 'p') boundary = BUTTON_SCOPE
    else if (name === 'table' || name === 'template' || name === 'head') boundary = HTML_SCOPE
    else if (TABLE_PARTS.has(name)) boundary = TABLE_SCOPE
    const k = findOpen(name, boundary)
    if (k >= 0) popTo(k, end, lt)
  }

  // script·style 같은 요소는 '</이름' 이 나올 때까지 글자로 삼킨다(안에 든 '</div>' 문자열은 태그가 아니다).
  function consumeRaw(el) {
    let close = -1
    if (el.tag === 'script') {
      close = scriptCloseIndex(html, el.tagEnd)
    } else {
      let re = rawCloseRes.get(el.tag)
      if (!re) {
        re = new RegExp(`</${el.tag}(?=[\\t\\n\\f\\r />])`, 'gi')
        rawCloseRes.set(el.tag, re)
      }
      re.lastIndex = el.tagEnd
      const match = re.exec(html)
      if (match) close = match.index
    }
    if (close < 0) {
      addText(el.tagEnd, length)
      popTo(stack.length - 1, length, length)
      return length
    }
    addText(el.tagEnd, close)
    const closing = readTag(html, close + 2)
    const end = closing.eof ? length : closing.end
    popTo(stack.length - 1, end, end)
    return end
  }

  function commentEnd(lt) {
    if (html.startsWith('<!-->', lt)) return lt + 5
    if (html.startsWith('<!--->', lt)) return lt + 6
    let p = lt + 4
    while (p < length) {
      const k = html.indexOf('--', p)
      if (k < 0) return length
      if (html.charCodeAt(k + 2) === 62) return k + 3
      if (html.charCodeAt(k + 2) === 33 && html.charCodeAt(k + 3) === 62) return k + 4
      p = k + 1
    }
    return length
  }
  function bogusEnd(from) {
    const gt = html.indexOf('>', from)
    return gt < 0 ? length : gt + 1
  }

  let i = 0
  while (i < length) {
    const lt = html.indexOf('<', i)
    if (lt < 0) { addText(i, length); break }
    if (lt > i) addText(i, lt)
    const c1 = html.charCodeAt(lt + 1)
    if (isAlpha(c1)) {
      const tag = readTag(html, lt + 1)
      if (tag.eof) { i = length; break } // 끝나지 않은 태그는 브라우저도 버린다
      const el = openElement(tag, lt)
      i = tag.end
      if (el && stack[stack.length - 1] === el) {
        if (RAW_TEXT_TAGS.has(el.tag)) i = consumeRaw(el)
        else if (el.tag === 'plaintext') { addText(i, length); i = length }
      }
      continue
    }
    if (c1 === 47) {
      const c2 = html.charCodeAt(lt + 2)
      if (isAlpha(c2)) {
        const tag = readTag(html, lt + 2)
        if (tag.eof) { i = length; break }
        closeElement(tag.name, lt, tag.end)
        i = tag.end
      } else if (c2 === 62) {
        i = lt + 3
      } else {
        i = bogusEnd(lt + 2)
      }
      continue
    }
    if (c1 === 33) {
      if (html.startsWith('<!--', lt)) { i = commentEnd(lt); continue }
      if (html.startsWith('<![CDATA[', lt) && inForeign()) {
        const close = html.indexOf(']]>', lt + 9)
        addText(lt + 9, close < 0 ? length : close)
        i = close < 0 ? length : close + 3
        continue
      }
      i = bogusEnd(lt + 2)
      continue
    }
    if (c1 === 63) { i = bogusEnd(lt + 1); continue }
    addText(lt, lt + 1)
    i = lt + 1
  }
  for (const el of stack) el.end = length
  stack.length = 0

  return {
    html,
    root,
    elements,
    head: seen.head,
    body: seen.body,
    attr: (el, name) => attrValue(html, el, name),
    text: (el, limit = 200000) => normalizeSpace(collectText(html, [el], limit)),
  }
}

function findAttr(el, name) {
  const attrs = el.attrs
  for (let k = 0; k < attrs.length; k += 1) if (attrs[k].name === name) return attrs[k]
  return null
}
function hasAttr(el, name) {
  return findAttr(el, name) !== null
}
// 같은 이름이 두 번 나오면 브라우저처럼 첫 번째를 쓴다.
function attrValue(html, el, name) {
  const attr = findAttr(el, name)
  if (!attr) return undefined
  return attr.vs < 0 ? '' : decodeHtmlEntities(html.slice(attr.vs, attr.ve))
}

// ---------------------------------------------------------------------------
// 보이는 글 모으기
// ---------------------------------------------------------------------------

const WS_RUN = /\s+/g
const TEXT_SKIP = new Set(['script', 'style', 'template', 'noscript', 'iframe', 'noembed', 'noframes', 'title', 'head'])
const INLINE_TAGS = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'big', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i', 'ins', 'kbd', 'label', 'mark', 'nobr', 'output', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var', 'wbr'])
const BLOCK_BREAK = { tag: '#break' }
const CELL_BREAK = { tag: '#cell' }
const INLINE_GAP = { tag: '#gap' }
const CELL_TAGS = new Set(['td', 'th'])
const isElement = (node) => node && node.tag !== '#text' && node.tag !== '#comment'

const normalizeSpace = (text) => String(text ?? '').replace(WS_RUN, ' ').trim()

/**
 * 여러 노드의 보이는 글을 모은다. limit 글자쯤에서 멈춘다.
 *   - 문단·목록·행 같은 덩어리 사이는 줄을 바꾼다(읽기 모드에서 한 덩어리 글이 되지 않게).
 *   - 표의 칸 사이는 띄어 쓴다(한 행은 한 줄로 읽힌다).
 *   - 붙어 있는 두 인라인 요소(칩·배지: <span>C-02</span><span>C-05</span>) 사이도 띄어 쓴다 —
 *     전에는 "C-02C-05"처럼 붙어 버렸다. 글자와 붙은 강조(<b>핵심</b>은)는 사이에 글이 있으므로 그대로 붙는다.
 * maxNodes를 주면 그만큼만 훑고, 다 못 훑었으면 null을 돌려준다(짧아야 할 글 — 버튼·선택지·번호 칸 — 에 쓴다).
 */
function collectText(html, nodes, limit, maxNodes = Infinity) {
  const parts = []
  let size = 0
  let visited = 0
  const work = []
  for (let k = nodes.length - 1; k >= 0; k -= 1) work.push(nodes[k])
  while (work.length && size <= limit) {
    visited += 1
    if (visited > maxNodes) return null
    const node = work.pop()
    if (node === BLOCK_BREAK) { parts.push('\n'); continue }
    if (node === CELL_BREAK || node === INLINE_GAP) { parts.push(' '); continue }
    if (node.tag === '#text') {
      let piece = html.slice(node.start, node.end)
      if (piece.indexOf('&') >= 0) piece = decodeHtmlEntities(piece)
      piece = piece.replace(WS_RUN, ' ')
      parts.push(piece)
      size += piece.length
      continue
    }
    if (TEXT_SKIP.has(node.tag)) continue
    if (CELL_TAGS.has(node.tag)) { parts.push(' '); work.push(CELL_BREAK) }
    else if (!INLINE_TAGS.has(node.tag)) { parts.push('\n'); work.push(BLOCK_BREAK) }
    const children = node.children
    for (let k = children.length - 1; k >= 0; k -= 1) {
      work.push(children[k])
      const before = children[k - 1]
      if (k > 0 && isElement(before) && isElement(children[k]) && INLINE_TAGS.has(before.tag) && INLINE_TAGS.has(children[k].tag)) work.push(INLINE_GAP)
    }
  }
  return parts.join('')
}

/** 줄 바꿈은 살리고 줄 안의 공백만 하나로 — 빈 줄은 버린다. */
const normalizeLines = (text) => String(text ?? '').split('\n').map((line) => line.replace(WS_RUN, ' ').trim()).filter(Boolean).join('\n')

function clip(text, max) {
  if (text.length <= max) return text
  let cut = text.slice(0, max)
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
  return cut
}

/**
 * 항목 글: NFKC로 맞추고, 덩어리 사이 줄 바꿈은 살리고(읽기 모드), 상한에서 자른다.
 * 지문(textHash·simhash)은 이 글이 아니라 공백을 하나로 편 글에서 뜬다 — 줄 바꿈만 바뀐 판을 "고쳐졌다"고 보지 않는다.
 */
function normalizeAnchorText(raw, max) {
  return clip(normalizeLines(String(raw ?? '').normalize('NFKC')), max)
}

// ---------------------------------------------------------------------------
// 문자 인코딩 확인 — 서버는 브라우저가 보낸 파일 형식을 믿지 않고 내용을 직접 본다.
// ---------------------------------------------------------------------------

const EUC_KR_ALIASES = new Set(['cp949', 'ms949', 'uhc', 'x-windows-949', 'ks_c_5601', 'euckr', 'x-euc-kr'])
const CONTENT_CHARSET_RE = /charset\s*=\s*["']?\s*([A-Za-z0-9_.:-]+)/i

function toBytes(buffer) {
  if (buffer instanceof Uint8Array) return buffer
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer)
  if (ArrayBuffer.isView(buffer)) return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  if (typeof buffer === 'string') return Buffer.from(buffer, 'utf8')
  return new Uint8Array(0)
}

function normalizeCharsetLabel(label) {
  const value = String(label || '').trim().toLowerCase()
  // 메타에 적힌 utf-16은 브라우저도 utf-8로 읽는다(바이트 순서 표시가 없으면 utf-16일 수 없다).
  if (!value || value.startsWith('utf-16') || value === 'utf16') return 'utf-8'
  if (EUC_KR_ALIASES.has(value)) return 'euc-kr'
  try {
    return new TextDecoder(value).encoding
  } catch {
    return 'utf-8'
  }
}

/**
 * 앞부분에서 브라우저처럼 인코딩 선언을 찾는다: <meta charset>, 또는 http-equiv="content-type"인 meta의 content 속 charset=.
 * 주석 안의 meta, 다른 태그의 속성 값, 설명글(content="… charset=euc-kr …")에 적힌 글자는 선언이 아니다 —
 * 그런 글자를 믿으면 멀쩡한 utf-8 자료의 한글이 모두 깨진다.
 */
function sniffMetaCharset(head) {
  let p = 0
  while (p < head.length) {
    const lt = head.indexOf('<', p)
    if (lt < 0) return null
    const c1 = head.charCodeAt(lt + 1)
    if (head.startsWith('<!--', lt)) {
      const close = head.indexOf('-->', lt + 2)
      if (close < 0) return null
      p = close + 3
    } else if (isAlpha(c1) || (c1 === 47 && isAlpha(head.charCodeAt(lt + 2)))) {
      const tag = readTag(head, lt + (c1 === 47 ? 2 : 1))
      if (tag.eof) return null
      if (c1 !== 47 && tag.name === 'meta') {
        const value = (name) => {
          const attr = tag.attrs.find((item) => item.name === name)
          return attr && attr.vs >= 0 ? head.slice(attr.vs, attr.ve).trim() : ''
        }
        if (value('charset')) return value('charset')
        if (value('http-equiv').toLowerCase() === 'content-type') {
          const match = CONTENT_CHARSET_RE.exec(value('content'))
          if (match) return match[1]
        }
      }
      p = tag.end
    } else if (c1 === 33 || c1 === 47 || c1 === 63) {
      const gt = head.indexOf('>', lt + 2)
      if (gt < 0) return null
      p = gt + 1
    } else {
      p = lt + 1
    }
  }
  return null
}

function sniffCharset(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8'
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(4096, bytes.length)).toString('latin1')
  const label = sniffMetaCharset(head)
  return label ? normalizeCharsetLabel(label) : 'utf-8'
}

/**
 * 올라온 바이트를 글로 읽는다. 순서: 바이트 순서 표시(BOM) → 앞 4KB의 meta charset → utf-8.
 * HTML인지는 앞 64KB에 '<!doctype html', '<html', '<body' 중 하나가 있는지로만 본다.
 */
export function decodeMaterialBytes(buffer) {
  const bytes = toBytes(buffer)
  if (!bytes.length) return { ok: false, reason: 'EMPTY', charset: 'utf-8', text: '' }
  const label = sniffCharset(bytes)
  let decoder
  try {
    decoder = new TextDecoder(label, { fatal: false })
  } catch {
    decoder = new TextDecoder('utf-8', { fatal: false })
  }
  const text = decoder.decode(bytes)
  const charset = decoder.encoding
  if (!text.trim()) return { ok: false, reason: 'EMPTY', charset, text }
  const head = text.slice(0, 64 * 1024).toLowerCase()
  if (!head.includes('<!doctype html') && !head.includes('<html') && !head.includes('<body')) {
    return { ok: false, reason: 'NOT_HTML', charset, text }
  }
  return { ok: true, charset, text }
}

// ---------------------------------------------------------------------------
// data: 값 풀기
// ---------------------------------------------------------------------------

const hexValue = (c) => (c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1)

/** %XX를 바이트로 푼다. %가 아닌 글자는 UTF-8 바이트 그대로 둔다(%는 ASCII라 바이트 단위로 풀어도 같다). */
function percentDecode(text) {
  const input = Buffer.from(text, 'utf8')
  if (input.indexOf(37) < 0) return input
  const out = Buffer.allocUnsafe(input.length)
  let o = 0
  for (let k = 0; k < input.length; k += 1) {
    const b = input[k]
    if (b === 37 && k + 2 < input.length) {
      const high = hexValue(input[k + 1])
      const low = hexValue(input[k + 2])
      if (high >= 0 && low >= 0) {
        out[o] = high * 16 + low
        o += 1
        k += 2
        continue
      }
    }
    out[o] = b
    o += 1
  }
  return Buffer.from(out.subarray(0, o))
}

function dataUriHeader(value) {
  // '#' 뒤는 주소의 조각(fragment)이라 브라우저가 내용으로 읽지 않는다 — 떼어 낸 바이트도 브라우저가 그리던 것과 같아야 한다.
  const hash = value.indexOf('#')
  const uri = hash < 0 ? value : value.slice(0, hash)
  const comma = uri.indexOf(',')
  if (comma < 5) return null
  const params = uri.slice(5, comma).split(';')
  const declared = params[0].trim().toLowerCase() || 'text/plain'
  const mime = MIME_ALIASES.get(declared) ?? declared
  const base64 = params.slice(1).some((param) => param.trim().toLowerCase() === 'base64')
  return { mime, base64, payload: uri.slice(comma + 1) }
}

function dataUriBytes(header) {
  const { payload } = header
  if (header.base64) {
    // 브라우저처럼 %를 먼저 풀고 base64를 읽는다. 줄바꿈·공백은 Buffer가 건너뛴다.
    const text = payload.indexOf('%') >= 0 ? percentDecode(payload).toString('latin1') : payload
    return Buffer.from(text, 'base64')
  }
  return percentDecode(/[\t\n\r]/.test(payload) ? payload.replace(/[\t\n\r]/g, '') : payload)
}

// ---------------------------------------------------------------------------
// 지문: 글자 3개 조각으로 만든 simhash64 — 띄어쓰기가 적은 한글에도 맞는다.
// ---------------------------------------------------------------------------

function mix32(value) {
  let h = value
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h
}

function simhash64(text) {
  const points = Array.from(text, (ch) => ch.codePointAt(0))
  if (!points.length) return '0'.repeat(16)
  const votes = new Int32Array(64)
  const count = points.length < 3 ? 1 : points.length - 2
  for (let k = 0; k < count; k += 1) {
    const a = points[k]
    const b = points[k + 1] ?? 0
    const c = points[k + 2] ?? 0
    let low = 0x811c9dc5
    low = Math.imul(low ^ a, 0x01000193)
    low = Math.imul(low ^ b, 0x01000193)
    low = mix32(Math.imul(low ^ c, 0x01000193))
    let high = 0x9e3779b9
    high = Math.imul(high ^ c, 0x01000193)
    high = Math.imul(high ^ a, 0x01000193)
    high = mix32(Math.imul(high ^ b, 0x01000193) ^ 0x5bd1e995)
    for (let bit = 0; bit < 32; bit += 1) {
      votes[bit] += (low >>> bit) & 1 ? 1 : -1
      votes[bit + 32] += (high >>> bit) & 1 ? 1 : -1
    }
  }
  let low = 0
  let high = 0
  for (let bit = 0; bit < 32; bit += 1) {
    if (votes[bit] > 0) low |= 1 << bit
    if (votes[bit + 32] > 0) high |= 1 << bit
  }
  return (high >>> 0).toString(16).padStart(8, '0') + (low >>> 0).toString(16).padStart(8, '0')
}

// ---------------------------------------------------------------------------
// 큰 값 떼어 내기·바깥 주소 세기
// ---------------------------------------------------------------------------

const URL_ATTRIBUTES = new Set(['src', 'href', 'xlink:href', 'poster'])
const ENTITY_QUOTES = ['&quot;', '&#34;', '&#x22;', '&#39;', '&#x27;', '&apos;']
const JS_TYPES = new Set(['', 'module', 'text/javascript', 'application/javascript', 'application/x-javascript', 'text/ecmascript', 'application/ecmascript', 'text/x-javascript', 'text/x-ecmascript', 'text/jscript', 'text/livescript'])

function startsWithFold(html, pos, word) {
  return html.slice(pos, pos + word.length).toLowerCase() === word
}

function isExternal(html, start, end) {
  if (end - start < 2) return false
  if (html.charCodeAt(start) === 47 && html.charCodeAt(start + 1) === 47) return true
  return startsWithFold(html, start, 'http:') || startsWithFold(html, start, 'https:')
}

function trimRange(html, start, end) {
  let s = start
  let e = end
  while (s < e && isSpace(html.charCodeAt(s))) s += 1
  while (e > s && isSpace(html.charCodeAt(e - 1))) e -= 1
  return [s, e]
}

function createScanner(html, limits) {
  const assets = new Map()
  const edits = []
  const occurrences = []
  const counts = { externalRefs: 0, skippedDataUris: 0 }

  function addAsset(mime, bytes) {
    if (bytes.length > limits.maxAssetBytes) {
      throw new MaterialHtmlError('MATERIAL_ASSET_TOO_LARGE', `자료 속 그림(또는 파일) 하나가 ${mb(bytes.length)}MB라서 받을 수 없어요. 하나에 ${mb(limits.maxAssetBytes)}MB까지 받을 수 있어요.`)
    }
    const sha = sha256Hex(bytes)
    if (!assets.has(sha)) {
      if (assets.size >= limits.maxAssets) {
        throw new MaterialHtmlError('MATERIAL_TOO_MANY_ASSETS', `자료에서 떼어 낸 그림이 ${limits.maxAssets}개를 넘어요. 그림 수를 줄여서 다시 올려 주세요.`)
      }
      assets.set(sha, { sha256: sha, mime, size: bytes.length, bytes })
    }
    return sha
  }

  function replaceWithAsset(start, end, mime, bytes) {
    const sha = addAsset(mime, bytes)
    edits.push({ start, end, text: ASSET_PREFIX + sha })
    occurrences.push({ pos: start, sha })
  }

  /** 주소 하나를 본다: 큰 data:면 떼어 내고, 바깥 주소면 센다. decode는 속성 값일 때만(스타일 블록 글은 문자 참조가 아님). */
  function url(start, end, { decode, countExternal = true }) {
    if (end - start >= 5 && startsWithFold(html, start, 'data:')) {
      if (end - start <= limits.assetThresholdBytes) return
      const raw = html.slice(start, end)
      const header = dataUriHeader(decode && raw.indexOf('&') >= 0 ? decodeHtmlEntities(raw) : raw)
      if (!header || !EXTRACTABLE_MIME.has(header.mime)) { counts.skippedDataUris += 1; return }
      replaceWithAsset(start, end, header.mime, dataUriBytes(header))
      return
    }
    if (countExternal && isExternal(html, start, end)) counts.externalRefs += 1
  }

  // srcset: "주소 설명, 주소 설명" — data: 주소 안에는 쉼표가 있으므로 공백까지를 주소로 읽는다(브라우저 규칙).
  function srcset(vs, ve) {
    let p = vs
    while (p < ve) {
      while (p < ve && (isSpace(html.charCodeAt(p)) || html.charCodeAt(p) === 44)) p += 1
      if (p >= ve) break
      const us = p
      while (p < ve && !isSpace(html.charCodeAt(p))) p += 1
      let ue = p
      while (ue > us && html.charCodeAt(ue - 1) === 44) ue -= 1
      url(us, ue, { decode: true })
      if (ue < p) continue
      let depth = 0
      while (p < ve) {
        const c = html.charCodeAt(p)
        p += 1
        if (c === 40) depth += 1
        else if (c === 41 && depth) depth -= 1
        else if (c === 44 && !depth) break
      }
    }
  }

  /**
   * CSS 안의 url(...)과 @import "…" 를 본다. 속성 안이면 &quot; 같은 따옴표도 따옴표로 친다.
   * 주석(/* … *\/)과 글(따옴표)은 건너뛴다 — 주석 속 "url('" 한 줄 때문에 뒤의 큰 그림을 못 떼어 내지 않게.
   */
  function css(start, end, inAttribute) {
    if (end - start < 5) return
    const text = html.slice(start, end)
    const re = /\/\*[\s\S]*?(?:\*\/|$)|"(?:[^"\\\n]|\\[\s\S])*"?|'(?:[^'\\\n]|\\[\s\S])*'?|url\(/gi
    let match
    while ((match = re.exec(text))) {
      const first = match[0][0]
      if (first !== 'u' && first !== 'U') continue // 주석이나 글
      let p = match.index + 4
      while (p < text.length && isSpace(text.charCodeAt(p))) p += 1
      let quote = ''
      const ch = text[p]
      if (ch === '"' || ch === "'") quote = ch
      else if (inAttribute && ch === '&') quote = ENTITY_QUOTES.find((candidate) => text.startsWith(candidate, p)) ?? ''
      const us = p + quote.length
      let ue
      if (quote) {
        ue = text.indexOf(quote, us)
        if (ue < 0) { re.lastIndex = us; continue } // 닫히지 않은 따옴표 — 뒤의 url()은 계속 본다
      } else {
        ue = text.indexOf(')', us)
        if (ue < 0) break
        while (ue > us && isSpace(text.charCodeAt(ue - 1))) ue -= 1
      }
      url(start + us, start + ue, { decode: inAttribute })
      re.lastIndex = ue + quote.length // 닫는 따옴표 뒤에서 이어 본다(따옴표를 새 글의 시작으로 읽지 않게)
    }
    const imports = /@import\s+(["'])/gi
    while ((match = imports.exec(text))) {
      const us = match.index + match[0].length
      const ue = text.indexOf(match[1], us)
      if (ue < 0) break
      if (isExternal(html, start + us, start + ue)) counts.externalRefs += 1
      imports.lastIndex = ue
    }
  }

  // srcdoc: 시안 칸의 HTML 글. 크면 통째로 떼어 내고, 앱이 글로 돌려준다(브리지가 속성에 다시 넣음).
  function srcdoc(attr) {
    const rawLength = attr.ve - attr.vs
    if (rawLength * 3 <= limits.srcdocThresholdBytes) return
    const text = decodeHtmlEntities(html.slice(attr.vs, attr.ve))
    const bytes = Buffer.from(text, 'utf8')
    if (bytes.length <= limits.srcdocThresholdBytes) return
    replaceWithAsset(attr.vs, attr.ve, SRCDOC_MIME, bytes)
  }

  function attributes(el) {
    for (const attr of el.attrs) {
      const name = attr.name
      // 자료에 미리 적힌 data-itf-a는 앱이 붙이는 항목 표시로 오인된다(브리지가 [data-itf-a]로 항목을 찾는다).
      // 예전 그리기 사본을 다시 올렸거나 일부러 심은 것 — 이름만 바꿔 두어 항목 표시는 앱이 붙인 것뿐이게 한다.
      if (name === ANCHOR_ATTRIBUTE) edits.push({ start: attr.ns, end: attr.ns + name.length, text: `${ANCHOR_ATTRIBUTE}-old` })
      if (attr.vs < 0) continue
      if (name === 'style') { css(attr.vs, attr.ve, true); continue }
      if (name === 'srcdoc' || name === 'data-srcdoc') { srcdoc(attr); continue }
      if (name === 'srcset' || name === 'data-srcset') { srcset(attr.vs, attr.ve); continue }
      if (URL_ATTRIBUTES.has(name) || name.startsWith('data-')) {
        const [s, e] = trimRange(html, attr.vs, attr.ve)
        url(s, e, { decode: true, countExternal: URL_ATTRIBUTES.has(name) })
      }
    }
  }

  return { assets, edits, occurrences, counts, attributes, css }
}

function rawTextOf(html, el) {
  const first = el.children[0]
  return first && first.tag === '#text' ? html.slice(first.start, first.end) : ''
}

function isJavaScript(type) {
  if (type === undefined) return true
  return JS_TYPES.has(type.split(';')[0].trim().toLowerCase())
}

function insideSvg(el) {
  for (let node = el.parent; node; node = node.parent) if (node.tag === 'svg') return true
  return false
}

function parseJsonObject(text) {
  try {
    const value = JSON.parse(text)
    return value !== null && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

/** 문서 전체를 한 번 훑으며 큰 값 떼어 내기·스크립트 수·제목·자료 키·자료 속 의견(shared-state)을 모은다. */
function scanDocument(doc, limits) {
  const { html, elements } = doc
  const scanner = createScanner(html, limits)
  const meta = { title: '', materialKey: null, versionNote: null }
  let scripts = 0
  let sharedState = null
  let sharedSeen = false
  for (const el of elements) {
    const tag = el.tag
    if (tag === 'script') {
      if (attrValue(html, el, 'id') === 'shared-state') {
        if (!sharedSeen) { sharedSeen = true; sharedState = parseJsonObject(rawTextOf(html, el)) }
      } else if (isJavaScript(attrValue(html, el, 'type'))) {
        scripts += 1
      }
    } else if (tag === 'style') {
      const first = el.children[0]
      if (first && first.tag === '#text') scanner.css(first.start, first.end, false)
    } else if (tag === 'title') {
      if (!meta.title && !insideSvg(el)) meta.title = clip(normalizeSpace(decodeHtmlEntities(rawTextOf(html, el))), 200)
    } else if (tag === 'meta') {
      const name = (attrValue(html, el, 'name') ?? '').trim().toLowerCase()
      if (name === 'itf:material' && meta.materialKey === null) meta.materialKey = clip(normalizeSpace(attrValue(html, el, 'content') ?? ''), 200) || null
      if (name === 'itf:version-note' && meta.versionNote === null) meta.versionNote = clip(normalizeSpace(attrValue(html, el, 'content') ?? ''), 200) || null
    }
    if (el.attrs.length) scanner.attributes(el)
  }
  return { scanner, meta, scripts, sharedState }
}

// ---------------------------------------------------------------------------
// 항목 인식(설계서 6절). 규칙은 위에서부터: 명시 → 반복 항목 → 절 → id 없는 표.
// ---------------------------------------------------------------------------

const EXCLUDED_TAGS = new Set(['head', 'script', 'style', 'template', 'noscript', 'nav', 'aside', 'dialog'])
// 반복 항목으로 볼 수 있는 틀 요소. 버튼·링크·입력 칸이 id를 달고 줄지어 있어도 검토 항목은 아니다.
const REPEAT_TAGS = new Set(['article', 'section', 'div', 'li', 'tr', 'details', 'figure', 'p', 'blockquote', 'dd', 'dt', 'dl', 'form', 'fieldset', 'table', 'tbody', 'ul', 'ol', 'pre', 'main'])
const REPEAT_KIND = lookup({ tr: 'row', article: 'item', li: 'item', div: 'item', details: 'doc', figure: 'figure', section: 'section' })
// 제목의 글이 이어지는 범위를 끊는 요소 — section·article은 제 나름의 절을 연다.
const SECTIONING = new Set(['section', 'article', 'aside', 'nav'])
const CONTAINER_KINDS = new Set(['section', 'doc'])
const ROW_CODE = /^[A-Z]{1,4}[-_]?\d{1,3}$/
const TITLE_SLOT = lookup({ h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', figcaption: 'figcaption', summary: 'summary', strong: 'bold', b: 'bold', td: 'cell', th: 'cell' })
const DECISION_OPTIONS = new Set(['반영', '보류', '미반영'])
const STANCE_BUTTONS = new Set(['찬성', '반대'])
const NATIVE_BUTTON_WORDS = ['내보내기', '가져오기', '초기화', '공유저장']
const MIN_ANCHOR_TEXT = 12
const MAX_DEPTH = 3
// 버튼·선택지·번호 칸처럼 짧아야 할 이름표는 요소를 이만큼만 훑는다(안에 표가 또 든 칸을 끝까지 훑지 않게).
const SHORT_LABEL_NODES = 256
const byStart = (a, b) => a.start - b.start || b.end - a.end
const MAX_KEY = 200
const MAX_RELATIONS = 20
const MAX_ATTRIBUTES = 8

const lettersOnly = (text) => String(text ?? '').replace(/[^\p{L}\p{N}]/gu, '')
const cleanKey = (value) => clip(normalizeSpace(value ?? ''), MAX_KEY)

function slugify(text) {
  return clip(String(text ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, ''), 48) || 'x'
}

function tableRows(table) {
  const rows = []
  for (const child of table.children) {
    if (child.tag === 'tr') rows.push(child)
    else if (child.tag === 'tbody' || child.tag === 'thead' || child.tag === 'tfoot') {
      for (const row of child.children) if (row.tag === 'tr') rows.push(row)
    }
  }
  return rows
}

/** 위치 목록(오름차순)마다 그 자리를 품은 가장 안쪽 항목을 찾는다. 항목 범위는 서로 겹치지 않고 포개지기만 한다. */
function innermostAnchors(positions, anchors) {
  const owners = new Array(positions.length)
  const open = []
  let next = 0
  for (let k = 0; k < positions.length; k += 1) {
    const pos = positions[k]
    while (next < anchors.length && anchors[next].start <= pos) {
      const anchor = anchors[next]
      next += 1
      while (open.length && open[open.length - 1].end <= anchor.start) open.pop()
      open.push(anchor)
    }
    while (open.length && open[open.length - 1].end <= pos) open.pop()
    owners[k] = open.length ? open[open.length - 1] : null
  }
  return owners
}

function buildAnchors(doc, limits, occurrences) {
  const { html, root, elements, body } = doc
  const textLimit = limits.maxAnchorText
  const nodeText = (node, max = 120) => clip(normalizeSpace(collectText(html, [node], max * 4 + 64)), max)
  const anchorText = (candidate) => normalizeAnchorText(collectText(html, candidate.nodes, textLimit + 64), textLimit)
  const shortLabel = (node, limit) => collectText(html, [node], limit, SHORT_LABEL_NODES) ?? ''

  /**
   * 후보의 글을 문서 순서로 모아 12자 기준을 넘는지(pass) 정한다. fixed는 이미 정한 후보들(시작 위치 순)이다.
   * 겹친 후보마다 같은 글을 다시 모으면, 수백 단으로 겹친 파일 하나가 분석을 몇십 초씩 붙잡는다. 그래서
   *  - 이미 통과한 조상이 셋이면(깊이 4 이상) 어차피 빠지므로 글을 모으지 않고 버린다(돌려주는 목록에도 없다).
   *  - 글이 모자라 떨어진 조상 안의 후보는 조상보다 글이 많을 수 없으므로 모으지 않고 떨어뜨린다(명시 규약은 예외).
   */
  function judgeInOrder(fixed, fresh) {
    const result = []
    const open = []
    let passing = 0
    let failing = 0
    let next = 0
    const leave = (pos) => {
      while (open.length && open[open.length - 1].end <= pos) {
        if (open.pop().pass) passing -= 1
        else failing -= 1
      }
    }
    const enter = (candidate) => {
      leave(candidate.start)
      open.push(candidate)
      if (candidate.pass) passing += 1
      else failing += 1
    }
    for (const candidate of fresh) {
      while (next < fixed.length && fixed[next].start <= candidate.start) enter(fixed[next++])
      leave(candidate.start)
      if (passing >= MAX_DEPTH) continue
      if (failing && candidate.rule !== 1) {
        candidate.pass = false
      } else {
        candidate.text = anchorText(candidate)
        candidate.pass = candidate.rule === 1 || candidate.text.length >= MIN_ANCHOR_TEXT
      }
      enter(candidate)
      result.push(candidate)
    }
    return result
  }

  // 0. 제외할 곳: 목차·머리글·숨긴 칸 안의 요소는 항목이 되지 않는다.
  root.excluded = false
  for (const el of elements) {
    let excluded = el.parent.excluded === true || EXCLUDED_TAGS.has(el.tag) || hasAttr(el, 'hidden')
    if (!excluded) {
      const role = ` ${(attrValue(html, el, 'role') ?? '').toLowerCase()} `
      if (role.includes(' navigation ') || role.includes(' status ')) excluded = true
    }
    if (!excluded && (el.tag === 'header' || el.tag === 'footer')) {
      const parent = el.parent
      excluded = body ? parent === body : parent === root || parent.tag === 'html'
    }
    el.excluded = excluded
  }

  const candidates = new Map()
  const addCandidate = (el, key, kind, rule, nodes = [el]) => {
    const candidate = { el, key, kind, rule, nodes, start: el.start, end: nodes[nodes.length - 1].end, heading: false }
    candidates.set(el, candidate)
    return candidate
  }

  // 1. 명시 규약: data-itf-anchor
  for (const el of elements) {
    if (el.excluded) continue
    const explicit = attrValue(html, el, 'data-itf-anchor')
    if (explicit === undefined) continue
    const key = cleanKey(explicit) || cleanKey(attrValue(html, el, 'data-id')) || cleanKey(attrValue(html, el, 'id'))
    if (!key) continue
    const kind = clip(normalizeSpace(attrValue(html, el, 'data-itf-kind') ?? ''), 32) || 'item'
    addCandidate(el, key, kind, 1)
  }

  // 2. 반복 항목: 같은 태그·클래스의 형제가 3개 이상이고 저마다 id나 data-id가 있음
  const repeatKey = (el) => {
    if (el.excluded || !REPEAT_TAGS.has(el.tag) || candidates.has(el)) return ''
    return cleanKey(attrValue(html, el, 'data-id')) || cleanKey(attrValue(html, el, 'id'))
  }
  const classSignature = (el) => normalizeSpace(attrValue(html, el, 'class') ?? '').split(' ').filter(Boolean).sort().join(' ')
  const groupedClasses = new Set()
  for (const parent of [root, ...elements]) {
    if (parent.excluded || parent.children.length < 3) continue
    let groups = null
    for (const child of parent.children) {
      if (child.tag === '#text') continue
      const key = repeatKey(child)
      if (!key) continue
      const signature = `${child.tag}|${classSignature(child)}`
      groups ??= new Map()
      if (!groups.has(signature)) groups.set(signature, [])
      groups.get(signature).push({ child, key })
    }
    if (!groups) continue
    for (const [signature, group] of groups) {
      if (group.length < 3) continue
      if (!signature.endsWith('|')) groupedClasses.add(signature)
      for (const { child, key } of group) addCandidate(child, key, REPEAT_KIND[child.tag] ?? 'item', 2)
    }
  }
  // 같은 무리가 절마다 나뉘어 있으면 어떤 절에는 2개뿐일 수 있다(예시 자료의 F·H묶음).
  // 이미 3개 이상으로 확인된 '태그+클래스'면 형제 수와 관계없이 같은 무리로 본다. 클래스가 없는 모양은 넓히지 않는다.
  if (groupedClasses.size) {
    for (const el of elements) {
      const key = repeatKey(el)
      if (key && groupedClasses.has(`${el.tag}|${classSignature(el)}`)) addCandidate(el, key, REPEAT_KIND[el.tag] ?? 'item', 2)
    }
  }

  // 3a. 절: section[id]
  for (const el of elements) {
    if (el.tag !== 'section' || el.excluded || candidates.has(el)) continue
    const key = cleanKey(attrValue(html, el, 'id'))
    if (key) addCandidate(el, key, 'section', 3)
  }

  // 글이 12자 미만이면 뺀다. 명시 규약은 쓴 사람의 뜻이므로 남긴다.
  const judged = judgeInOrder([], [...candidates.values()].sort(byStart))
  for (const candidate of [...candidates.values()]) if (!candidate.pass) candidates.delete(candidate.el)
  // 절·원문의 이름표로 쓰인 제목은 따로 항목이 되지 않는다(같은 것이 두 번 잡히지 않게).
  const labelHeadings = new Set()
  for (const candidate of candidates.values()) {
    const title = anchorTitle(candidate)
    candidate.title = title.text
    if (CONTAINER_KINDS.has(candidate.kind) && title.source && HEADING_LEVEL[title.source.tag]) labelHeadings.add(title.source)
  }

  // 3b. 항목 밖의 h1~h3: 다음 같은 급(또는 더 높은 급) 제목 앞까지를 한 절로 본다.
  //     절·원문(section/doc) 안의 제목은 하위 절로 잡는다 — 원문 5편 속 제목이 여기에 해당한다.
  const itemElements = new Set()
  for (const candidate of candidates.values()) if (!CONTAINER_KINDS.has(candidate.kind)) itemElements.add(candidate.el)
  for (let k = elements.length - 1; k >= 0; k -= 1) {
    const el = elements[k]
    const own = Math.min(HEADING_LEVEL[el.tag] ?? 9, el.minHeading ?? 9)
    el.minHeading = own
    const parent = el.parent
    if (parent && parent !== root && own < (parent.minHeading ?? 9)) parent.minHeading = own
  }
  // 항목 안에 있는지는 위에서 아래로 한 번에 적어 둔다(제목마다 조상을 끝까지 거슬러 오르지 않게).
  for (const el of elements) el.inItem = itemElements.has(el.parent) || el.parent.inItem === true
  const headingCandidates = []
  for (const el of elements) {
    const level = HEADING_LEVEL[el.tag]
    if (!level || level > 3 || el.excluded || el.inItem || candidates.has(el) || labelHeadings.has(el)) continue
    const siblings = el.parent.children
    const nodes = [el]
    for (let k = el.childIndex + 1; k < siblings.length; k += 1) {
      const sibling = siblings[k]
      if (sibling.tag !== '#text' && (SECTIONING.has(sibling.tag) || (sibling.minHeading ?? 9) <= level)) break
      nodes.push(sibling)
    }
    while (nodes.length > 1 && nodes[nodes.length - 1].tag === '#text' && !html.slice(nodes[nodes.length - 1].start, nodes[nodes.length - 1].end).trim()) nodes.pop()
    headingCandidates.push({ el, key: '', kind: 'section', rule: 3, nodes, start: el.start, end: nodes[nodes.length - 1].end, heading: true })
  }
  const judgedHeadings = judgeInOrder(judged, headingCandidates)
  const slugOrdinals = new Map()
  for (const candidate of judgedHeadings) {
    if (!candidate.pass) continue
    const el = candidate.el
    candidate.title = nodeText(el)
    const id = cleanKey(attrValue(html, el, 'id'))
    if (id) {
      candidate.key = id
    } else {
      const slug = slugify(candidate.title)
      const ordinal = (slugOrdinals.get(slug) ?? 0) + 1
      slugOrdinals.set(slug, ordinal)
      candidate.key = `h:${slug}#${ordinal}`
    }
    candidates.set(el, candidate)
  }

  // 4. id 없는 표: 첫 칸이 'AB-01' 모양인 행이 3개 이상이면 행 하나가 항목 하나
  const rowCandidates = []
  for (const table of elements) {
    if (table.tag !== 'table' || table.excluded) continue
    const matches = []
    for (const row of tableRows(table)) {
      if (row.excluded || candidates.has(row)) continue
      const cell = row.children.find((child) => child.tag === 'td' || child.tag === 'th')
      if (!cell) continue
      // 번호 칸은 작다 — 요소가 많은 칸(안에 표가 또 든 칸 등)은 끝까지 훑지 않고 번호가 아닌 것으로 본다.
      const code = normalizeSpace(shortLabel(cell, 64))
      if (ROW_CODE.test(code)) matches.push({ row, code })
    }
    if (matches.length < 3) continue
    for (const { row, code } of matches) rowCandidates.push({ el: row, key: code, kind: 'row', rule: 4, nodes: [row], start: row.start, end: row.end, heading: false })
  }
  // 표 안의 표는 바깥 표의 행을 다 본 뒤에 나오므로 문서 순서로 다시 늘어놓는다.
  for (const candidate of judgeInOrder([...judged, ...judgedHeadings].sort(byStart), rowCandidates.sort(byStart))) {
    if (!candidate.pass) continue
    candidate.title = anchorTitle(candidate).text
    candidates.set(candidate.el, candidate)
  }

  // 깊이 3단까지(절 > 항목 > 하위 항목). 문서 순서대로 늘어놓고 품은 관계로 부모를 정한다.
  const ordered = [...candidates.values()].sort(byStart)
  const open = []
  let kept = []
  for (const candidate of ordered) {
    while (open.length && open[open.length - 1].end <= candidate.start) open.pop()
    const parent = open.length ? open[open.length - 1] : null
    candidate.parent = parent
    candidate.depth = parent ? parent.depth + 1 : 1
    open.push(candidate)
    if (candidate.depth <= MAX_DEPTH) kept.push(candidate)
  }
  const truncatedAnchors = kept.length > limits.maxAnchors
  if (truncatedAnchors) kept = kept.slice(0, limits.maxAnchors)

  // 키가 겹치면 뒤에 오는 것에 ~2, ~3을 붙인다. id는 키에서 나온 짧은 해시(한글·공백이 있어도 주소에 안전).
  let keyCollisions = 0
  const usedKeys = new Set()
  const nextSuffix = new Map()
  const usedIds = new Set()
  for (const candidate of kept) {
    const base = candidate.key
    if (usedKeys.has(base)) {
      let n = nextSuffix.get(base) ?? 2
      while (usedKeys.has(`${base}~${n}`)) n += 1
      nextSuffix.set(base, n + 1)
      candidate.key = `${base}~${n}`
      keyCollisions += 1
    }
    usedKeys.add(candidate.key)
    const hex = sha256Hex(candidate.key)
    let size = 12
    let id = `a-${hex.slice(0, size)}`
    while (usedIds.has(id) && size < 64) {
      size += 4
      id = `a-${hex.slice(0, size)}`
    }
    usedIds.add(id)
    candidate.id = id
    candidate.relations = new Set()
    candidate.assetShas = new Set()
    candidate.decision = false
  }

  // 결정 칸·관계는 **가장 안쪽 항목**의 것으로 친다. 제안 42개를 품은 절이 결정 항목이 되지 않게 하려는 것이다.
  const owners = innermostAnchors(elements.map((el) => el.start), kept)
  let nativeReviewControls = 0
  const textareas = []
  const idIndex = new Map()
  for (let k = 0; k < elements.length; k += 1) {
    const el = elements[k]
    const owner = owners[k]
    const id = findAttr(el, 'id') ? attrValue(html, el, 'id') : ''
    if (id && !idIndex.has(id)) idIndex.set(id, k)
    let native = false
    if (el.tag === 'select' && isDecisionSelect(el)) {
      native = true
      if (owner) owner.decision = true
    }
    if (hasAttr(el, 'data-stance')) {
      native = true
      if (owner) owner.decision = true
    }
    if (el.tag === 'button') {
      const label = lettersOnly(shortLabel(el, 80))
      if (owner && STANCE_BUTTONS.has(label)) owner.decision = true
      if (NATIVE_BUTTON_WORDS.some((word) => label.includes(word))) native = true
    }
    if (el.tag === 'textarea') textareas.push(k)
    if (native) nativeReviewControls += 1
  }
  for (const candidate of kept) {
    if (candidate.kind === 'proposal' || (attrValue(html, candidate.el, 'data-itf-kind') ?? '').trim().toLowerCase() === 'proposal') candidate.decision = true
  }
  for (const k of textareas) if (owners[k]?.decision && !hasAttr(elements[k], 'data-stance')) nativeReviewControls += 1

  // 관계: 항목 안의 href="#x" → x를 품은 항목의 키. 자기 자신·자기를 품은 절로 가는 링크(맨 위로 등)는 뺀다.
  for (let k = 0; k < elements.length; k += 1) {
    const owner = owners[k]
    if (!owner || owner.relations.size >= MAX_RELATIONS) continue
    const el = elements[k]
    if (!findAttr(el, 'href')) continue
    const href = (attrValue(html, el, 'href') ?? '').trim()
    if (href.length < 2 || href[0] !== '#') continue
    let fragment = href.slice(1)
    try {
      fragment = decodeURIComponent(fragment)
    } catch {
      // 잘못된 %는 그대로 둔다
    }
    const targetIndex = idIndex.get(fragment)
    if (targetIndex === undefined) continue
    const target = owners[targetIndex]
    if (!target || target === owner) continue
    let enclosing = false
    for (let node = owner.parent; node; node = node.parent) if (node === target) enclosing = true
    if (!enclosing) owner.relations.add(target.key)
  }

  // 그림 sha: 그 항목 안(하위 항목 포함)에서 떼어 낸 것 모두
  const sortedOccurrences = [...occurrences].sort((a, b) => a.pos - b.pos)
  const occurrenceOwners = innermostAnchors(sortedOccurrences.map((item) => item.pos), kept)
  sortedOccurrences.forEach((item, k) => {
    for (let node = occurrenceOwners[k]; node; node = node.parent) node.assetShas.add(item.sha)
  })

  const anchors = kept.map((candidate, order) => ({
    id: candidate.id,
    key: candidate.key,
    kind: candidate.kind,
    title: candidate.title ?? '',
    text: candidate.text,
    textHash: sha256Hex(normalizeSpace(candidate.text)),
    simhash: simhash64(normalizeSpace(candidate.text)),
    depth: candidate.depth,
    parentId: candidate.parent ? candidate.parent.id : null,
    decisionEnabled: candidate.decision,
    relations: [...candidate.relations],
    attributes: anchorAttributes(html, candidate.el),
    assetShas: [...candidate.assetShas],
    order,
  }))
  const edits = kept.map((candidate) => ({ start: candidate.el.nameEnd, end: candidate.el.nameEnd, text: ` data-itf-a="${candidate.id}"` }))
  return { anchors, edits, nativeReviewControls, truncatedAnchors, keyCollisions }

  function isDecisionSelect(select) {
    const work = [...select.children]
    while (work.length) {
      const node = work.pop()
      if (node.tag === 'option') {
        if (DECISION_OPTIONS.has(lettersOnly(shortLabel(node, 40)))) return true
      } else if (node.tag === 'optgroup') {
        work.push(...node.children)
      }
    }
    return false
  }

  // 이름표가 <span>번호</span><span>설명</span>처럼 조각으로만 되어 있으면 CSS가 띄워 보여 주던 것을 ' · '로 잇는다.
  function labelText(label) {
    const parts = []
    for (const child of label.children) {
      if (child.tag === '#text') {
        if (html.slice(child.start, child.end).trim()) return nodeText(label)
        continue
      }
      if (TEXT_SKIP.has(child.tag)) continue
      const text = nodeText(child)
      if (text) parts.push(text)
    }
    return parts.length > 1 ? clip(parts.join(' · '), 120) : nodeText(label)
  }

  /** 제목: 첫 h1~h4 → figcaption → summary → 첫 굵은 글자 → 첫 칸 → 본문 앞 60자. 표의 행은 따로 본다. */
  function anchorTitle(candidate) {
    const el = candidate.el
    if (candidate.heading) return { text: nodeText(el), source: el }
    if (el.tag === 'tr') return { text: rowTitle(el, candidate.text), source: null }
    // 접힌 글·그림은 제 이름표(summary·figcaption)가 곧 제목이다.
    if (el.tag === 'details' || el.tag === 'figure') {
      const labelTag = el.tag === 'details' ? 'summary' : 'figcaption'
      const own = el.children.find((child) => child.tag === labelTag)
      const text = own ? labelText(own) : ''
      if (text) return { text, source: own }
    }
    const found = {}
    const work = [...candidate.nodes].reverse()
    while (work.length) {
      const node = work.pop()
      if (node.tag === '#text' || TEXT_SKIP.has(node.tag)) continue
      const slot = TITLE_SLOT[node.tag]
      if (slot && !found[slot]) {
        const text = nodeText(node)
        if (text) {
          found[slot] = { text, source: node }
          if (slot === 'heading') break
        }
      }
      for (let k = node.children.length - 1; k >= 0; k -= 1) work.push(node.children[k])
    }
    return found.heading ?? found.figcaption ?? found.summary ?? found.bold ?? found.cell ?? { text: clip(normalizeSpace(candidate.text), 60), source: null }
  }

  // 표의 행: 첫 칸이 'BR-01' 같은 번호면 "번호 · 본문 제목". 행 안의 '근거 · 해결' 같은 접힘 이름표는 제목으로 쓰지 않는다.
  function rowTitle(row, text) {
    const cells = row.children.filter((child) => child.tag === 'td' || child.tag === 'th')
    const first = cells.length ? nodeText(cells[0]) : ''
    let bold = ''
    const work = [...row.children].reverse()
    while (work.length && !bold) {
      const node = work.pop()
      if (node.tag === '#text' || TEXT_SKIP.has(node.tag) || node.tag === 'summary') continue
      if (node.tag === 'b' || node.tag === 'strong') bold = nodeText(node)
      for (let k = node.children.length - 1; k >= 0; k -= 1) work.push(node.children[k])
    }
    if (first && ROW_CODE.test(first)) {
      let main = bold
      for (let k = 1; k < cells.length && !main; k += 1) {
        const cellText = nodeText(cells[k])
        if (cellText.length >= 8) main = cellText
      }
      return main ? clip(`${first} · ${main}`, 120) : first
    }
    return bold || first || clip(normalizeSpace(text), 60)
  }
}

/** 항목 요소의 data-* 속성(필터용) 최대 8개. 값은 40자까지. */
function anchorAttributes(html, el) {
  const result = {}
  let count = 0
  for (const attr of el.attrs) {
    if (count >= MAX_ATTRIBUTES) break
    const name = attr.name
    if (!name.startsWith('data-') || name.startsWith('data-itf-') || name === 'data-id' || name.startsWith('data-src')) continue
    if (Object.hasOwn(result, name)) continue
    const raw = attr.vs < 0 ? '' : html.slice(attr.vs, Math.min(attr.ve, attr.vs + 400))
    const value = normalizeSpace(decodeHtmlEntities(raw))
    if (/^(data:|itf-asset:)/i.test(value)) continue
    result[name] = clip(value, 40)
    count += 1
  }
  return result
}

// ---------------------------------------------------------------------------
// 조립
// ---------------------------------------------------------------------------

/** 고칠 자리 목록을 원본에 한 번에 적용한다. 긴 문자열을 거듭 이어 붙이지 않는다. */
function applyEdits(html, edits) {
  if (!edits.length) return html
  edits.sort((a, b) => a.start - b.start || a.end - b.end)
  const parts = []
  let cursor = 0
  for (const edit of edits) {
    if (edit.start < cursor) continue // 겹치는 수정은 버린다 — 원본을 망가뜨리느니 덜 고친다
    parts.push(html.slice(cursor, edit.start), edit.text)
    cursor = edit.end
  }
  parts.push(html.slice(cursor))
  return parts.join('')
}

/**
 * 자료 HTML에서 그리기 사본·떼어 낸 파일·항목 목록을 만든다.
 * options.limits로 한도를 바꿀 수 있고(시험용), options.charset·options.originalBytes는 보고서에 그대로 적는다.
 * 한도를 넘으면 code가 붙은 MaterialHtmlError를 던진다(사람이 읽을 한국어 문장 포함).
 */
export function prepareMaterial(html, options = {}) {
  const source = String(html ?? '')
  const opts = options ?? {}
  const limits = { ...MATERIAL_LIMITS, ...(opts.limits ?? {}) }
  const originalBytes = Number.isFinite(opts.originalBytes) ? opts.originalBytes : Buffer.byteLength(source, 'utf8')
  if (originalBytes > limits.maxSourceBytes) {
    throw new MaterialHtmlError('MATERIAL_SOURCE_TOO_LARGE', `자료 파일이 ${mb(originalBytes)}MB라서 받을 수 없어요. ${mb(limits.maxSourceBytes)}MB까지 올릴 수 있어요.`)
  }
  const doc = parseMaterialHtml(source)
  const { scanner, meta, scripts, sharedState } = scanDocument(doc, limits)
  const found = buildAnchors(doc, limits, scanner.occurrences)
  const renderHtml = applyEdits(source, [...scanner.edits, ...found.edits])
  const renderBytes = Buffer.byteLength(renderHtml, 'utf8')
  if (renderBytes > limits.maxRenderBytes) {
    throw new MaterialHtmlError('MATERIAL_RENDER_TOO_LARGE', `그림을 떼어 낸 뒤에도 본문이 ${mb(renderBytes)}MB라서 화면에 그릴 수 없어요. 본문은 ${mb(limits.maxRenderBytes)}MB까지 받을 수 있어요. 스크립트나 글 속에 큰 데이터가 들어 있지 않은지 확인해 주세요.`)
  }
  const assets = [...scanner.assets.values()]
  const report = {
    scripts,
    externalRefs: scanner.counts.externalRefs,
    skippedDataUris: scanner.counts.skippedDataUris,
    nativeReviewControls: found.nativeReviewControls,
    originalBytes,
    renderBytes,
    assetCount: assets.length,
    anchorCount: found.anchors.length,
    truncatedAnchors: found.truncatedAnchors,
    keyCollisions: found.keyCollisions,
  }
  if (opts.charset) report.charset = String(opts.charset)
  return {
    renderHtml,
    assets,
    anchors: found.anchors,
    meta,
    report,
    embeddedFeedback: { sharedState },
  }
}

/** 검색용 글: 항목마다 제목과 본문 앞 200자. 모두 합쳐 2만 자까지. */
export function materialSearchText(anchors) {
  const lines = []
  let size = 0
  for (const anchor of Array.isArray(anchors) ? anchors : []) {
    const line = normalizeSpace(`${anchor?.title ?? ''} ${String(anchor?.text ?? '').slice(0, 200)}`)
    if (!line) continue
    lines.push(line)
    size += line.length + 1
    if (size >= 20000) break
  }
  return clip(lines.join('\n'), 20000)
}

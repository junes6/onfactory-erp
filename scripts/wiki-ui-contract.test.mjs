import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'

import { BLOCK_TYPES, fieldsOf } from '../src/components/wiki/wikiBlocks.ts'

/**
 * 문서(위키) 화면 계약(설계서 H절 §6·§8-6).
 *
 * 이 절의 최우선 제약은 **한글 조합 안전**이다(AGENTS.md:16). 조합 중에 값을 갈아 끼우거나
 * 편집 중인 값에서 React key를 뽑으면 증상이 "가끔 글자가 깨진다"로만 나타나, 브라우저에서
 * 재현하기 어렵고 리뷰에서도 눈에 띄지 않는다. 그래서 소스에서 그 모양을 직접 고정한다.
 *
 * 나머지 검사는 "화면이 두 벌이 되는 자리"를 잠근다 — 블록 타입 목록, 라우트 배선 여섯 자리,
 * 검색 갈래 사전, 스트림 종류. 어느 쪽 하나만 고치면 컴파일은 되고 화면만 조용히 틀어진다.
 */
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

const wikiDirectory = new URL('../src/components/wiki/', import.meta.url)
const wikiFileNames = (await readdir(wikiDirectory)).sort()
const wikiFiles = new Map(await Promise.all(wikiFileNames.map(async (name) => (
  [name, await readFile(new URL(name, wikiDirectory), 'utf8')]
))))
const wikiTsx = [...wikiFiles].filter(([name]) => name.endsWith('.tsx'))
const wikiSources = [...wikiFiles].filter(([name]) => name.endsWith('.tsx') || name.endsWith('.ts'))
let wikiCode = []

const block = wikiFiles.get('WikiBlock.tsx')
const editor = wikiFiles.get('WikiEditor.tsx')
const page = wikiFiles.get('WikiPage.tsx')
const menu = wikiFiles.get('WikiSlashMenu.tsx')
const tree = wikiFiles.get('WikiTree.tsx')
const ops = wikiFiles.get('wikiOps.ts')
const blocksModule = wikiFiles.get('wikiBlocks.ts')
const css = wikiFiles.get('Wiki.css')

const app = await read('src/App.tsx')
const globalSearch = await read('src/components/GlobalSearch.tsx')
const styles = await read('src/styles.css')
const registry = await read('src/modules/registry.ts')
const approvalQueue = await read('src/components/ApprovalQueue.tsx')
const originBadge = await read('src/components/OriginBadge.tsx')
const eventStreamHook = await read('src/hooks/useEventStream.ts')
const serverBlocks = await read('server/wiki-blocks.mjs')
const serverEventStream = await read('server/event-stream.mjs')

const count = (source, pattern) => (source.match(pattern) ?? []).length

/**
 * 주석을 지운 소스.
 *
 * 이 파일의 검사 대부분이 "이 낱말이 코드에 있으면 안 된다"는 모양이다. 그런데 좋은 코드는
 * **왜 그 낱말을 쓰지 않는지 주석으로 적어 둔다** — 그 설명이 검사에 걸리면, 통과하는 길은
 * 설명을 지우는 것뿐이 된다. 그래서 검사 전에 주석을 걷어 낸다.
 *
 * 줄 주석은 앞 글자가 콜론이면 지우지 않는다(주소에 들어 있는 슬래시 둘).
 */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//gu, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/gu, '$1')

// 주석을 걷어 낸 화면 소스. 아래 '이 낱말이 있으면 안 된다' 검사는 전부 이 쪽을 본다.
wikiCode = wikiSources.map(([name, source]) => [name, stripComments(source)])

/** `attribute={…}`의 중괄호를 세어 값 전체를 떼어 온다. 한 줄만 보면 여러 줄 핸들러가 검사를 빠져나간다. */
function attributeValues(source, attribute) {
  const values = []
  const opener = `${attribute}={`
  let from = source.indexOf(opener)
  while (from >= 0) {
    let depth = 0
    let at = from + opener.length - 1
    for (; at < source.length; at += 1) {
      if (source[at] === '{') depth += 1
      else if (source[at] === '}') { depth -= 1; if (depth === 0) break }
    }
    values.push(source.slice(from, at + 1))
    from = source.indexOf(opener, at + 1)
  }
  return values
}

/**
 * 이름 붙은 화살표 함수의 몸통을 중괄호 짝으로 떼어 온다.
 * 한 줄만 정규식으로 보면 갈래 하나가 검사를 조용히 빠져나간다 — 이 절에서 실제로 그렇게 새어 나갔다.
 */
function functionBody(source, declaration) {
  const at = source.indexOf(declaration)
  assert.ok(at >= 0, `${declaration} 선언을 찾지 못했다`)
  const open = at + declaration.length - 1
  let depth = 0
  for (let cursor = open; cursor < source.length; cursor += 1) {
    if (source[cursor] === '{') depth += 1
    else if (source[cursor] === '}') { depth -= 1; if (depth === 0) return source.slice(open, cursor + 1) }
  }
  throw new Error(`${declaration}의 몸통이 닫히지 않았다`)
}

/** 배열 리터럴에서 문자열 원소만 뽑는다. 서버 `.mjs`와 화면 `.ts`가 같은 낱말을 쓰는지 비교할 때 쓴다. */
function stringArray(source, name) {
  const at = source.indexOf(name)
  assert.ok(at >= 0, `${name} 선언을 찾지 못했다`)
  // `=` 뒤부터 찾는다 — 타입 표기(`StreamEventKind[]`)의 빈 대괄호를 배열로 잘못 잡지 않게.
  const open = source.indexOf('[', source.indexOf('=', at))
  const close = source.indexOf(']', open)
  assert.ok(open >= 0 && close > open, `${name} 배열 리터럴을 찾지 못했다`)
  return [...source.slice(open, close).matchAll(/'([^']+)'/gu)].map((match) => match[1])
}

test('한글 조합 중에는 키 입력을 가로채지 않는다 — 모든 onKeyDown이 조합 가드 뒤에 있다', () => {
  for (const [name, source] of [['WikiBlock.tsx', block], ['WikiEditor.tsx', editor]]) {
    const handlers = count(source, /onKeyDown=\{/gu)
    const guards = count(source, /event\.nativeEvent\.isComposing/gu)
    assert.ok(handlers > 0, `${name}에 키 처리가 있어야 한다`)
    assert.ok(handlers <= guards, `${name}: onKeyDown ${handlers}개에 조합 가드는 ${guards}개뿐이다`)
  }
  assert.ok(count(block, /onCompositionStart/gu) >= 1, 'onCompositionStart가 있어야 조합 시작을 안다')
  assert.ok(count(block, /onCompositionEnd/gu) >= 1, 'onCompositionEnd에서만 값을 다시 읽는다')
})

test('onChange는 값을 손보지 않는다 — trim·replace·slice가 하나도 없다', () => {
  for (const [name, source] of wikiTsx) {
    for (const handler of attributeValues(source, 'onChange')) {
      for (const forbidden of ['.trim()', '.replace(', '.slice(']) {
        assert.equal(handler.includes(forbidden), false, `${name}의 onChange가 값을 변형한다: ${forbidden}`)
      }
    }
  }
})

test('편집 가능한 DOM을 쓰지 않는다 — 조합 중 캐럿이 튀는 유일한 원인을 원천에서 뺀다', () => {
  for (const [name, source] of wikiCode) {
    for (const forbidden of ['contentEditable', 'dangerouslySetInnerHTML', 'execCommand']) {
      assert.equal(source.includes(forbidden), false, `${name}에 ${forbidden}가 있으면 안 된다`)
    }
  }
})

test('React key를 편집 중인 값에서 뽑지 않는다 — 한 글자 칠 때마다 포커스가 날아간다', () => {
  const forbidden = ['.text', '.title', '.value', 'draft', 'query']
  for (const [name, source] of wikiTsx) {
    for (const key of attributeValues(source, 'key')) {
      for (const token of forbidden) {
        assert.equal(key.includes(token), false, `${name}의 key가 편집되는 값에서 나온다: ${key}`)
      }
    }
  }
})

test('화면당 기본 버튼은 하나뿐이고, 블록은 카드가 아니다', () => {
  assert.equal(count(page, /tone="primary"/gu), 1, '문서 화면의 기본 버튼은 헤더의 하나뿐이다')
  for (const [name, source] of wikiCode.filter(([name]) => name.endsWith('.tsx'))) {
    assert.equal(source.includes('<article'), false, `${name}에 <article> 중첩을 만들지 않는다`)
    assert.equal(source.includes('style={{'), false, `${name}에 인라인 style을 두지 않는다`)
  }
  for (const [name, source] of [['WikiBlock.tsx', block], ['WikiEditor.tsx', editor]]) {
    assert.equal(source.includes('className="panel'), false, `${name}의 블록은 면을 갖지 않는다`)
  }
})

test('Wiki.css는 토큰만 쓴다', () => {
  const clean = css.replace(/\/\*[\s\S]*?\*\//gu, '')
  assert.doesNotMatch(clean, /#[0-9a-fA-F]{3,8}\b/u, '색상 리터럴 금지')
  assert.doesNotMatch(clean, /\brgba?\(/u, 'rgb 색상 함수 금지')
  assert.equal(clean.includes('.ui-button {'), false, '공용 버튼의 모양은 Button.css에서만 정한다')
  for (const match of clean.matchAll(/border-radius:\s*([^;}]+)/gu)) {
    assert.equal(match[1].trim(), 'var(--radius-8)', `radius 토큰 위반: ${match[1]}`)
  }
  const fontTokens = new Set(['var(--font-22)', 'var(--font-15)', 'var(--font-13)', 'var(--font-11)'])
  for (const match of clean.matchAll(/font-size:\s*([^;}]+)/gu)) {
    assert.ok(fontTokens.has(match[1].trim()), `타이포 4단 밖의 크기: ${match[1]}`)
  }
  for (const match of clean.matchAll(/box-shadow:\s*([^;}]+)/gu)) {
    assert.equal(match[1].trim(), 'var(--shadow-none)', `그림자 금지: ${match[1]}`)
  }
  assert.match(css.split('\n')[0], /^\/\*.*문서/u, '첫 줄은 이 파일이 무엇인지 한국어로 말한다')
})

test('편집기는 특정 업무 어휘를 모른다 — 같은 컴포넌트가 어떤 종류의 문서에도 쓰인다', () => {
  for (const [name, source] of [['WikiEditor.tsx', editor], ['WikiBlock.tsx', block], ['wikiBlocks.ts', blocksModule]]) {
    assert.doesNotMatch(source, /회의록|주간보고|기획서|업무 매뉴얼|세무|기회/u, `${name}에 문서 종류의 이름이 굳어 있다`)
  }
})

test('편집 조각은 낡았다는 이유로 거절되지 않는다', () => {
  assert.match(ops, /baseVersion/u, '기준 버전을 함께 보낸다')
  assert.match(ops, /opId/u, '조각마다 id가 있어야 재전송이 멱등이다')
  assert.match(ops, /keepalive: true/u, '탭을 닫을 때의 마지막 한 번')
  assert.equal(stripComments(ops).includes('409'), false, 'ops에는 편집 충돌 상태 코드를 다루는 갈래가 없어야 한다')
  assert.match(ops, /export function canApplyServerDocument/u, '덮어도 되는지 판정은 순수 함수로 뺀다')
})

test('키보드만으로 문단을 옮길 수 있고, 옮겼다는 사실을 말한다', () => {
  assert.match(editor, /event\.altKey/u)
  assert.match(editor, /ArrowUp/u)
  assert.match(editor, /ArrowDown/u)
  assert.match(editor, /aria-live="polite"/u)
  assert.match(editor, /위로 옮기기/u, '단축키가 막힌 환경을 위해 메뉴에도 같은 길을 둔다')
})

test('끌어 옮기기는 놓을 자리를 좌표로 판정한다', () => {
  for (const needle of ['onDragStart', 'onDragOver', 'onDrop', 'getBoundingClientRect()']) {
    assert.ok(editor.includes(needle), `WikiEditor.tsx에 ${needle}가 있어야 한다`)
  }
})

test('메뉴는 목록 롤을 갖추고, 누를 때 편집 상자의 초점을 뺏지 않는다', () => {
  assert.match(menu, /role="listbox"/u)
  assert.match(menu, /role="option"/u)
  assert.match(menu, /aria-selected/u)
  assert.match(menu, /onMouseDown=\{\(event\) => \{ event\.preventDefault\(\);/u, '초점을 뺏으면 조합 중이던 글자가 사라진다')
  assert.equal(menu.includes('MessengerExtras'), false, '메신저 컴포넌트를 끌어오지 않는다(그 파일의 문자열은 다른 계약이 고정한다)')
})

test('표는 머리글과 설명을 스크린리더에 준다', () => {
  assert.match(block, /<caption className="sr-only">/u)
  assert.match(block, /scope="col"/u)
  assert.match(block, /wiki-table-scroll/u, '넘치는 표는 표 안에서만 스크롤한다')
})

test('문서 목록은 지키지 못할 트리 롤을 붙이지 않는다', () => {
  for (const [name, source] of wikiCode.filter(([name]) => name.endsWith('.tsx'))) {
    assert.equal(source.includes('role="tree"'), false, `${name}에 role="tree"를 쓰지 않는다`)
  }
  assert.match(tree, /aria-current=\{item\.id === activeId \? 'page' : undefined\}/u)
})

test('없는 것을 0으로 그리지 않는다', () => {
  assert.match(page, /roster\.length > 1/u, '나 혼자면 함께 보는 사람을 아예 그리지 않는다')
  for (const [name, source] of wikiCode) {
    assert.equal(source.includes('0건'), false, `${name}에 '0건' 리터럴을 두지 않는다`)
    assert.equal(source.includes('0%'), false, `${name}에 '0%' 리터럴을 두지 않는다`)
  }
})

test('날짜는 공용 유틸 한 곳에서만 만든다', () => {
  for (const [name, source] of wikiCode) {
    assert.equal(source.includes('Intl.DateTimeFormat'), false, `${name}: 화면별 날짜 형식 금지`)
    assert.equal(source.includes('toLocaleDateString'), false, `${name}: 화면별 날짜 형식 금지`)
  }
  assert.match(page, /formatDateTime/u)
})

test('문서 화면은 세 번째 이벤트 스트림을 열지 않는다', () => {
  for (const [name, source] of wikiCode) {
    assert.equal(source.includes('useEventStream('), false, `${name}이 스트림을 새로 열면 안 된다`)
    assert.equal(/import[^\n]*useWorkspaceState/u.test(source), false, `${name}: 배열 전체 PUT 훅은 op 큐와 계약이 다르다`)
  }
  assert.match(app, /const wikiStreamRef = useRef<\(\(event: StreamEvent\) => void\) \| null>\(null\)/u)
  assert.match(app, /if \(event\.kind === 'wiki' \|\| event\.kind === 'resync'\) wikiStreamRef\.current\?\.\(event\)/u)
})

test('라우트 배선 여섯 자리가 모두 있다 — 하나라도 빠지면 컴파일은 되고 화면만 조용히 틀어진다', () => {
  // 1·2·3: 모듈 레지스트리(유니온·라벨·코어 모듈)
  assert.match(registry, /\| 'wiki'/u)
  assert.match(registry, /wiki: \{ id: 'wiki', label: '문서'/u)
  assert.match(registry, /routes: \[[^\]]*'wiki'[^\]]*\]/u)
  // 4·5: App의 페이지 유니온과 직원 허용 목록
  assert.match(app, /type TenantPage = [^\n]*\| 'wiki' \|/u)
  assert.match(app, /const tenantMemberPages = new Set<PageId>\(\[[^\]]*'wiki'[^\]]*\]\)/u)
  // 6: 실제 화면
  assert.match(app, /case 'wiki': return <WikiPage/u)
  // App 최상위에 훅을 더하지 않았다(게스트 계약이 이 수를 고정한다).
  assert.equal(count(app, /enabled: tenantDataEnabled,/gu), 3)
})

test('검색 결과와 출처 배지가 문서로 돌아온다', () => {
  assert.match(app, /hit\.kind === 'wiki'/u)
  // 출처 배지의 이동은 두 WorkPage 렌더가 공유하는 한 함수를 지난다 — 그 함수에 문서 갈래가 있고,
  // 두 렌더가 모두 그 함수를 넘겨야 배지가 양쪽에서 살아난다.
  const body = functionBody(app, 'const openWorkOrigin = (originPage: string, focusId: string) => {')
  assert.match(body, /originPage === 'wiki'/u)
  assert.match(body, /setWikiFocusId\(focusId\)/u)
  assert.equal(count(app, /onOpenOrigin=\{openWorkOrigin\}/gu), 2, '데스크톱·휴대폰 두 렌더가 같은 이동 함수를 쓴다')
  assert.match(approvalQueue, /proposal\.kind === 'wiki-task'/u)
  // 승인 큐를 지나 만들어진 업무의 출처 kind는 'wiki'가 아니라 'wiki-task'다(제안 kind를 그대로 쓴다).
  // 직원의 기본 경로가 그쪽이므로 한쪽만 알면 대다수가 보는 배지에 엉뚱한 아이콘이 붙는다.
  const bookOpen = originBadge.slice(0, originBadge.indexOf('? BookOpen'))
  assert.ok(bookOpen.includes("kind === 'wiki'"), '즉시 승격(관리자)의 출처 아이콘')
  assert.ok(bookOpen.includes("kind === 'wiki-task'"), '승인 큐를 지난 승격의 출처 아이콘')
})

test('출처 배지는 실제로 도착한다 — 휴대폰 탭까지 옮기고, 안내 문장은 목적지를 아는 곳에서 고른다', () => {
  const body = functionBody(app, 'const openWorkOrigin = (originPage: string, focusId: string) => {')
  const lastBranch = body.lastIndexOf("originPage === '")
  // 휴대폰은 아래 네 칸(mobileTab)이 화면을 정한다. 탭 이동이 어느 한 갈래 안에 갇히면
  // 나머지 갈래는 page만 바뀐 채 업무 탭에 남아, 눌러도 목적지에 닿지 못한다.
  const tabMoves = [...body.matchAll(/setMobileTab\('more'\)/gu)]
  assert.equal(tabMoves.length, 1, '휴대폰 탭 이동은 갈래마다가 아니라 한 자리에 있어야 한다')
  assert.ok(tabMoves[0].index > lastBranch, '탭 이동이 갈래 안에 갇히면 그 밖의 출처는 업무 탭에 남는다')
  assert.ok(body.indexOf("setWorkFocusId('')") > lastBranch, '업무 상세가 남아 있으면 탭을 옮겨도 업무 화면이 계속 그려진다')
  // 한 클릭이 두 목적지를 말하지 않는다 — 배지 쪽에는 안내 문장이 없다.
  const badge = attributeValues(app, 'onOpen').find((value) => value.includes('onOpenOrigin'))
  assert.ok(badge, '업무 상세의 출처 배지를 찾지 못했다')
  assert.equal(/onToast\(|setToast\(/u.test(badge), false, '목적지를 아는 곳(openWorkOrigin)이 안내 문장까지 고른다')
  assert.match(body, /원본 문서를 엽니다\./u, '문서를 열면서 승인 큐를 가리키면 안 된다')
})

test('블록 필드 표가 서버 규격과 같다 — 조각을 접을 때 이 표에 대고 거른다', () => {
  const serverFieldsOf = (type) => {
    const found = serverBlocks.match(new RegExp(`\\n\\s*${type}: \\{ required: \\[([^\\]]*)\\], optional: \\[([^\\]]*)\\]`, 'u'))
    assert.ok(found, `서버 BLOCK_SPEC에 ${type}가 없다`)
    return [...`${found[1]},${found[2]}`.matchAll(/'([^']+)'/gu)].map((match) => match[1])
  }
  for (const type of BLOCK_TYPES) {
    assert.deepEqual([...fieldsOf(type)], serverFieldsOf(type), `${type}의 필드 표가 서버와 어긋났다 — 접힌 조각이 400을 맞는다`)
  }
})

test('검색 갈래 사전 세 곳이 함께 있다 — KIND_ICON을 빠뜨리면 그 갈래가 통째로 기타로 떨어진다', () => {
  assert.match(globalSearch, /wiki: '문서',/u)
  assert.match(globalSearch, /document: '자료',/u)
  const icons = globalSearch.slice(globalSearch.indexOf('const KIND_ICON'))
  assert.match(icons.slice(0, icons.indexOf('}')), /wiki:/u, 'KNOWN_KINDS가 KIND_ICON 키에서 파생된다')
  assert.match(styles, /\.search-badge\.kind-wiki \{ color: var\(--color-rose\); background: var\(--color-rose-soft\); \}/u)
})

test('블록 종류 목록이 서버와 한 낱말도 다르지 않다', () => {
  assert.deepEqual(stringArray(blocksModule, 'BLOCK_TYPES'), stringArray(serverBlocks, 'BLOCK_TYPES'))
  assert.deepEqual(stringArray(blocksModule, 'TEXTUAL_TYPES'), stringArray(serverBlocks, 'TEXTUAL_TYPES'))
  assert.deepEqual(stringArray(blocksModule, 'LIST_TYPES'), stringArray(serverBlocks, 'LIST_TYPES'))
})

test('스트림 종류 목록이 서버와 같다 — 하나만 빠져도 그 프레임은 조용히 버려진다', () => {
  const server = stringArray(serverEventStream, 'EVENT_KINDS')
  const union = [...eventStreamHook.slice(eventStreamHook.indexOf('StreamEventKind ='), eventStreamHook.indexOf('\n', eventStreamHook.indexOf('StreamEventKind =')))
    .matchAll(/'([a-z]+)'/gu)].map((match) => match[1])
  const kinds = stringArray(eventStreamHook, 'const kinds: StreamEventKind[]')
  assert.deepEqual(union, server, 'StreamEventKind 유니온이 서버 목록과 어긋났다')
  assert.deepEqual(kinds, server, 'addEventListener를 거는 배열이 서버 목록과 어긋났다')
  assert.ok(server.includes('wiki'))
})

// ── 못 보낸 편집이 나가는 자리 · 413 문장 한 벌 ─────────────────────────────
const serverWiki = await read('server/wiki.mjs')
/** 주석을 걷어 낸 화면 소스 하나. 아래 검사는 코드만 본다(설명을 지워야 통과하는 검사를 만들지 않는다). */
const codeOf = (name) => new Map(wikiCode).get(name)

test('못 보낸 편집을 내보내는 자리는 효과의 정리 안이다 — 본문 첫 줄의 flush는 죽은 코드다', () => {
  // React는 deps가 바뀌면 **앞 효과의 정리**를 먼저 돌리고 그다음에 새 본문을 돌린다. 그래서
  // 본문 첫 줄에서 `queueRef.current`를 flush하면 이미 dispose된 큐에 닿아 아무것도 보내지 못하고,
  // 문서를 바꾸거나 화면을 떠날 때마다 사람이 방금 친 문장이 통째로 사라진다.
  // (`scripts/wiki-ops.test.mjs`가 같은 사실을 진짜 큐로 재고, 여기서는 그 순서를 소스에 못 박는다.)
  const source = codeOf('WikiPage.tsx')
  const beacon = source.indexOf('queue.flushBeacon()')
  const dispose = source.indexOf('queue.dispose()')
  assert.ok(beacon >= 0, '큐를 버리기 전에 못 보낸 편집을 내보내는 줄이 없다')
  assert.ok(dispose > beacon, 'dispose가 flushBeacon보다 앞에 있다 — 그 flush는 아무것도 보내지 못한다')
  assert.equal(
    /queueRef\.current\?\.flush\(\)\s*\n\s*queueRef\.current\?\.dispose\(\)/u.test(source), false,
    '버려진 큐에 대고 flush하는 옛 모양이 남아 있다',
  )
})

test('flush 시점 네 곳이 화면에 실제로 걸려 있다 — 디바운스·blur·구조 변경·탭 숨김', () => {
  const source = codeOf('WikiPage.tsx')
  assert.match(codeOf('wikiOps.ts'), /OP_FLUSH_DEBOUNCE_MS = \d/u, '디바운스 상수가 사라졌다')
  // blur: onFocusedBlock(null)이 오는 갈래에서 보낸다. 700ms 타이머만 믿으면 마지막 글자를 치고
  // 곧바로 화면을 떠난 사람의 편집이 타이머가 울리기 전에 큐째 사라진다(설계 §6-4.4).
  assert.match(source, /if \(blockId\) \{ void beat\(blockId\); return \}[\s\S]{0,300}?queueRef\.current\?\.flush\(\)/u, 'blur에서 flush하지 않는다')
  assert.match(source, /onFlushBefore=\{\(\) => \{ void queueRef\.current\?\.flush\(\) \}\}/u, '구조 op 직전에 flush하지 않는다')
  assert.match(source, /visibilityState === 'hidden'[\s\S]{0,80}flushBeacon\(\)/u, '탭을 숨길 때 flushBeacon하지 않는다')
})

test('413 문장은 서버 한 곳에서만 나온다 — 화면의 폴백도 그 문장과 한 글자까지 같다', () => {
  // 사람이 이 사실을 만나는 문은 둘이다(편집 저장의 413, 이력 서랍의 되살리기 413). 되살리기는
  // 서버 문장을 그대로 쓰므로, 저장 쪽이 다른 처방을 지어내면 같은 사실이 두 문장이 된다.
  const serverMessage = /WIKI_DOCUMENT_TOO_LARGE: '([^']+)'/u.exec(serverWiki)?.[1]
  assert.ok(serverMessage, '서버 413 문장을 찾지 못했다')
  const source = codeOf('wikiOps.ts')
  const branch = source.slice(source.indexOf('response.status === 413'), source.indexOf('response.status >= 500'))
  assert.match(branch, /failFatal\(body\.error\?\.message \|\|/u, '413만 서버 문장을 버리고 있다(다른 4xx 갈래는 그대로 쓴다)')
  const fallback = /failFatal\(body\.error\?\.message \|\| '([^']+)'\)/u.exec(branch)?.[1]
  assert.equal(fallback, serverMessage, `같은 사실에 문장이 두 벌이다\n  서버: ${serverMessage}\n  화면: ${fallback}`)
})

// ── 3회차 검증에서 잡힌 것 ─────────────────────────────────────────────────
const serverMerge = await read('server/wiki-merge.mjs')
test('BLOCK_DELETED 안내가 문단 목록 밖에서도 나온다 — 붙을 자리가 사라졌다고 문장을 버리지 않는다', () => {
  // 서버가 그 문단이 지워졌다고 답한 그 응답에는 그 문단이 이미 없다. 안내를 blocks.map 안에서만
  // 그리면 그 문장은 어떤 경로로도 렌더되지 않고, 사람이 방금 친 문장은 아무 말 없이 사라진다.
  const editor = codeOf('WikiEditor.tsx')
  assert.match(editor, /orphanNotices\(notices, blocks\)/u, '붙을 자리가 없는 안내를 고르는 자리가 없다')
  assert.ok(editor.includes('const orphanList'), '목록 밖에 그릴 안내 묶음이 없다')
  assert.match(editor, /<ul className="wiki-orphan-notices"/u, '안내를 그리는 자리가 없다')
  assert.equal(
    count(editor, /\{orphanList\}/gu), 2,
    '읽기 모드와 편집 모드 **양쪽**에서 그려야 한다(한쪽만이면 그 모드에서는 문장이 사라진다)',
  )
  // 두 자리 모두 문단 묶음 **밖**의 첫 줄이다 — 묶음 안이면 지워진 문단에는 그려질 자리가 없다.
  assert.match(editor, /className="wiki-read">\s*\{orphanList\}/u, '읽기 모드에서 안내가 문단 묶음 안에 있다')
  assert.match(editor, /\{announcement\}<\/p>\s*\{orphanList\}/u, '편집 모드에서 안내가 문단 목록 안에 있다')
  // 안내 문장 자체는 화면 컴포넌트가 아니라 한 자리(wikiOps)에서 나온다.
  assert.equal(
    /이 문단을 지웠습니다/u.test(editor) || /이 문단을 지웠습니다/u.test(codeOf('WikiPage.tsx')), false,
    '문장이 화면 컴포넌트에 흩어져 있다 — 서버가 말한 사실과 짝을 맞출 자리가 두 곳이 된다',
  )
  assert.match(codeOf('wikiOps.ts'), /이 문단을 지웠습니다/u, '문장을 고르는 한 자리가 없다')
})

test('서버 lostTextDropped와 화면 문장이 짝이다 — 이력에 없는 문장을 이력에 있다고 말하지 않는다', () => {
  const merge = serverMerge
  assert.match(merge, /lostTextDropped: true/u, '서버가 그 사실을 말하지 않으면 이 계약의 전제가 틀렸다')
  const ops = codeOf('wikiOps.ts')
  assert.match(ops, /rejection\.lostTextDropped/u, '화면이 그 사실을 읽지 않는다 — 두 갈래가 한 문장으로 답한다')
  const notice = ops.slice(ops.indexOf('export function rejectionNotice'), ops.indexOf('export function orphanNotices'))
  const dropped = /lostTextDropped\) \{\s*return \{ code: 'dropped', message: '([^']+)'/u.exec(notice)?.[1]
  assert.ok(dropped, '이력에도 담기지 못한 갈래의 문장을 찾지 못했다')
  assert.equal(/이력에 있습니다/u.test(dropped), false, `이력에도 없는 문장을 이력에 있다고 말한다: ${dropped}`)
  assert.match(notice, /BLOCK_DELETED[\s\S]{0,200}이력에 있습니다/u, '이력에 실린 갈래의 문장이 사라졌다')
})

test('이력 서랍은 첫 쪽에서 끊긴 사실을 말하고 다음 쪽으로 갈 길을 준다', () => {
  const revisions = codeOf('WikiRevisions.tsx')
  const page = /MAX_REVISION_PAGE = (\d+)/u.exec(serverWiki)?.[1]
  assert.ok(page, '서버 페이지 상한을 찾지 못했다')
  assert.match(revisions, /\?before=\$\{encodeURIComponent/u, '페이지 인자를 보내지 않으면 첫 쪽 뒤로는 어떤 길도 없다')
  assert.match(revisions, /더 보기/u, '다음 쪽으로 갈 길이 없다')
  // 설계 §4-4가 요구한 문장 — 목록이 어디서 끝났는지 사람이 알아야 한다.
  assert.match(revisions, /여기까지 보관합니다/u, '목록의 끝을 말하지 않는다')
  assert.match(revisions, /retention\.maxRevisions/u, '보관 한도를 서버가 말한 값이 아니라 화면이 지어낸다')
  // 되돌리기 확인 문구가 세는 수도 한 쪽에서 끊기면 안 된다(목록에서 세면 50에서 멈춘다).
  assert.match(revisions, /const dropCount = \(version: number\) => Math\.max\(0, currentVersion - version\)/u,
    '되돌리기 확인 문구가 한 쪽만 세고 있다 — 121번째 버전에서 "49개가 사라집니다"라고 말한다')
  // 첫 쪽 밖의 버전을 인라인 안내가 지목했을 때 상세가 통째로 사라지는 갈래도 닫는다.
  assert.match(revisions, /focusOutsidePage/u, '목록 밖 버전을 펼칠 자리가 없다')
})

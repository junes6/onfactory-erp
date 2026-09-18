import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const read = (file) => readFileSync(path.join(root, file), 'utf8')
const tokens = read('src/tokens.css')
const styles = read('src/styles.css')

function walk(directory, found = []) {
  for (const name of readdirSync(directory)) {
    const full = path.join(directory, name)
    if (statSync(full).isDirectory()) walk(full, found)
    else if (/\.(css|tsx|ts)$/.test(name)) found.push(full)
  }
  return found
}

const tokenValue = (name) => Number(tokens.match(new RegExp(`${name}:\\s*(\\d+)`))?.[1])
/** `z-index: var(--layer-x)` 또는 `calc(var(--layer-x) + n)`을 숫자로 푼다. */
function layerOf(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rule = css.match(new RegExp(`${escaped}\\s*\\{[^}]*?z-index:\\s*([^;]+);`))
  assert.ok(rule, `${selector}의 z-index를 찾지 못했다`)
  const value = rule[1].trim()
  const plain = value.match(/^var\((--layer-[\w-]+)\)$/)
  if (plain) return tokenValue(plain[1])
  const sum = value.match(/^calc\(var\((--layer-[\w-]+)\)\s*\+\s*(\d+)\)$/)
  if (sum) return tokenValue(sum[1]) + Number(sum[2])
  return Number(value)
}

test('겹침 순서: 메신저 < 더보기 시트 < 아래 탭 막대 < 대화상자·서랍 < 알림 한 줄', () => {
  const messenger = layerOf(read('src/components/CollaborationSuite.css'), '.collab-overlay')
  const sheet = layerOf(styles, '.mobile-sheet')
  const tabbar = layerOf(styles, '.mobile-tabbar')
  const toast = layerOf(styles, '.toast')
  assert.ok(messenger < sheet && sheet < tabbar, `메신저 ${messenger} < 시트 ${sheet} < 탭 막대 ${tabbar}`)
  const dialogs = [
    ['src/styles.css', '.modal-backdrop'], ['src/styles.css', '.workflow-drawer-backdrop'], ['src/styles.css', '.settings-drawer'],
    ['src/styles.css', '.chat-drawer'], ['src/styles.css', '.drawer-scrim'], ['src/styles.css', '.product-detail-layer'],
    ['src/components/CompanyLibrary.css', '.library-modal-backdrop'], ['src/components/BulkImport.css', '.bulk-import-backdrop'],
    ['src/components/ComplianceCenter.css', '.compliance-modal-backdrop'], ['src/components/DashboardWorkspace.css', '.dashboard-modal-backdrop'],
    ['src/components/FactoryManagement.css', '.factory-modal-layer'], ['src/components/PlatformConsole.css', '.pc-modal-backdrop'],
    ['src/components/WorkspaceNavigation.css', '.workspace-nav-backdrop'], ['src/components/LensPanel.css', '.lens-panel'],
    ['src/components/WebhookSettings.css', '.webhook-dialog-backdrop'], ['src/components/wiki/Wiki.css', '.wiki-dialog-backdrop'],
    ['src/components/wiki/Wiki.css', '.wiki-revisions'],
  ]
  for (const [file, selector] of dialogs) {
    const layer = layerOf(read(file), selector)
    assert.ok(layer > tabbar, `${selector}(${layer})는 아래 탭 막대(${tabbar}) 위에 떠야 [저장]·[닫기]가 가려지지 않는다`)
    assert.ok(layer < toast, `${selector}(${layer})는 알림 한 줄(${toast}) 아래다`)
  }
  // 휴대폰에서 알림 한 줄은 탭 막대 위에 뜬다.
  assert.match(styles, /\.app-shell:has\(\.mobile-tabbar\) \.toast \{ bottom: calc\(56px \+ env\(safe-area-inset-bottom\) \+ var\(--space-12\)\); \}/)
})

test('쓰는 CSS 변수는 모두 어딘가에 정의돼 있다 — 정의 없는 변수는 조용히 투명·상속으로 떨어진다', () => {
  const files = walk(path.join(root, 'src'))
  const defined = new Set()
  const used = new Map()
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/(--[a-z0-9-]+)\s*:/gi)) defined.add(match[1])
    for (const match of source.matchAll(/['"`](--[a-z0-9-]+)['"`]\s*[:\]]/gi)) defined.add(match[1]) // style={{ '--x': … }}
    for (const match of source.matchAll(/setProperty\(\s*['"`](--[a-z0-9-]+)/gi)) defined.add(match[1])
    for (const match of source.matchAll(/var\((--[a-z0-9-]+)\s*([,)])/gi)) {
      if (match[2] === ',') continue // 대체값이 있는 var()는 정의가 없어도 안전하다
      if (!used.has(match[1])) used.set(match[1], path.relative(root, file))
    }
  }
  const missing = [...used].filter(([name]) => !defined.has(name)).map(([name, file]) => `${name} (${file})`)
  assert.deepEqual(missing, [])
})

test('키보드 초점은 눈에 보인다 — 공용 초점 링과 버튼은 --focus-width 두께의 포인트 색', () => {
  assert.match(tokens, /--focus-width: 2px;/)
  assert.match(styles, /button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible, \[tabindex\]:focus-visible, a:focus-visible, summary:focus-visible \{\s*outline: var\(--focus-width\) solid var\(--color-primary\);/)
  const button = read('src/components/ui/Button.css')
  assert.match(button, /\.ui-button:focus-visible \{ outline: var\(--focus-width\) solid var\(--color-primary\);/)
  assert.match(button, /\.ui-icon-button:focus-visible \{ outline: var\(--focus-width\) solid var\(--color-primary\);/)
})

test('알림 한 줄: 보통 알림은 저절로 닫히고(멈춤 가능), 실패 알림은 남는다', () => {
  const toast = read('src/components/ui/Toast.tsx')
  assert.match(toast, /export const AUTO_CLOSE_SECONDS = 7/)
  assert.match(toast, /if \(message\.undo \|\| message\.tone === 'error' \|\| paused\) return/)
  assert.match(toast, /onMouseEnter=\{\(\) => setPaused\(true\)\}/)
  assert.match(toast, /onFocus=\{\(\) => setPaused\(true\)\}/)
  assert.match(toast, /role=\{message\.tone === 'error' \? 'alert' : 'status'\}/)
  const failure = new RegExp(toast.match(/const FAILURE_TEXT = \/(.+)\/u/)[1], 'u')
  for (const text of ['증빙 파일을 다운로드하지 못했습니다.', '업무 처리 서버에 연결할 수 없습니다.', '정리에 실패했습니다.']) assert.ok(failure.test(text), text)
  for (const text of ['업무를 시작했습니다.', '저장했습니다.', '검토 요청을 보냈습니다.']) assert.ok(!failure.test(text), text)
  const app = read('src/App.tsx')
  assert.match(app, /if \(typeof value === 'string'\) \{ setToastMessage\(toastFromText\(value\)\); return \}/)
  // 닫는 시각은 Toast 한 곳에서만 정한다 — App이 따로 타이머를 걸면 되돌리기·실패 알림이 잘린다.
  assert.doesNotMatch(app, /setTimeout\(\(\) => setToast\(''\)/)
})

test('휴대폰 더보기: 매일 쓰는 화면을 사이드바에서 골라 담고, 다른 화면으로 가면 닫힌다', () => {
  const shell = read('src/components/MobileShell.tsx')
  for (const id of ['approvals', 'schedule', 'wiki', 'journal', 'people', 'documents', 'projects']) {
    assert.match(shell, new RegExp(`\\{ id: '${id}', hint: '`), `${id}가 더보기에 있어야 한다`)
  }
  assert.match(shell, /const found = nav\.find\(\(item\) => item\.id === id\)/, '사이드바에 없는 화면(권한·업종·숨김)은 더보기에도 없다')
  assert.match(shell, /className="mobile-sheet-scrim"/)
  const app = read('src/App.tsx')
  assert.match(app, /items=\{mobileMoreItems\(personalizedTenantNav\)\}/)
  assert.match(app, /setMessengerOpen\(false\); setMoreSheetOpen\(false\) \}/)
})

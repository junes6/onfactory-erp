import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('대화상자에 쓰던 내용은 Esc·바깥 누름으로 말없이 사라지지 않는다(감사 shell-ux-25)', () => {
  const guard = read('src/utils/dirtyGuard.ts')
  assert.ok(guard.includes("window.addEventListener('keydown', onKeyDown, true)"), '화면들의 닫기 처리보다 먼저(캡처 단계)')
  assert.ok(guard.includes("window.addEventListener('mousedown', onPointerDown, true)"))
  assert.ok(guard.includes("if (!target.closest('form')) return"), '폼 안의 입력만 — 검색칸은 묻지 않는다')
  assert.ok(guard.includes('if (!hasTypedContent(dialog)) return'), '보낸 뒤 비운 칸은 묻지 않는다')
  assert.ok(read('src/App.tsx').includes('useEffect(() => installDirtyGuard(), [])'))
})

test('[새 문서]는 제목부터 묻고, 누가 보는지 말한다(감사 live-ui-14)', () => {
  const wiki = read('src/components/wiki/WikiPage.tsx')
  assert.ok(wiki.includes("<Button tone=\"primary\" disabled={busy} onClick={() => setNewTitle('')}>새 문서</Button>"))
  assert.ok(wiki.includes('만든 문서는 회사 구성원 모두가 볼 수 있습니다.'))
  assert.ok(!wiki.includes('onClick={() => void createDocument()}'), '누르자마자 만들지 않는다')
})

test('휴대폰에서 목록 줄 단추도 44px, 대장 파일 칩 글자는 13px(감사 business-admin-23·live-ui-21)', () => {
  const styles = read('src/styles.css')
  assert.ok(styles.includes(':is(.it-row-actions, .compliance-row-actions, .library-file-actions, .approval-actions, .journal-attachment-actions, .factory-location-card__actions, .dashboard-link-manage-actions) > button { min-width: 44px; min-height: 44px; }'))
  assert.ok(!/\.it-row-files button \{[^}]*font-size: var\(--font-11\)/.test(read('src/components/ItServices.css')))
})

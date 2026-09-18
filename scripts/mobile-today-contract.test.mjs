import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('휴대폰: 내려도 상단바가 붙어 있다 — overflow-x는 clip(감사 shell-ux-17)', () => {
  const styles = read('src/styles.css')
  assert.ok(styles.includes('html, body { max-width: 100%; overflow-x: hidden; overflow-x: clip; }'), 'hidden만 두면 body가 스크롤 상자가 되어 sticky가 풀린다')
})

test("휴대폰 '오늘' 맨 위에서 출퇴근을 찍는다 — 퇴근을 빠뜨린 날은 그 자리에서(감사 business-admin-16)", () => {
  const card = read('src/components/MobileAttendanceCard.tsx')
  const app = read('src/App.tsx')
  assert.ok(app.includes("attendance={account?.role !== 'tenant-guest' ? <MobileAttendanceCard workspaceScope={workspaceScope} currentUserId={account?.id ?? ''} onToast={setToast} /> : undefined}"))
  assert.ok(card.includes("run('clock-in', { previousClockOutTime: missedTime }"))
  assert.ok(card.includes("if (!records || !canClock) return null"), '찍을 수 없는 계정(운영자 모드 등)에는 그리지 않는다')
})

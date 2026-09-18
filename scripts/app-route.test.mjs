import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { currentRoutePage, planOpen, readRoute, routeSearch } from '../src/utils/appRoute.ts'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const app = read('src/App.tsx')
const sw = read('public/sw.js')
const count = (text, pattern) => (text.match(pattern) ?? []).length

test('주소 한 칸: 읽고 쓰는 모양이 같고, 모양이 틀린 주소로는 아무 화면도 강제로 열지 않는다', () => {
  assert.deepEqual(readRoute(routeSearch('wiki', 'material:MAT-1')), { page: 'wiki', focus: 'material:MAT-1' })
  assert.deepEqual(readRoute('?page=tasks'), { page: 'tasks', focus: '' })
  assert.equal(readRoute(''), null)
  assert.equal(readRoute('?page=../../etc'), null)
  assert.equal(readRoute('?page=<script>'), null)
  assert.equal(readRoute(`?page=wiki&focus=${'x'.repeat(500)}`).focus.length, 200)
  // 서비스워커가 만드는 푸시 주소와 같은 모양이다 — 닫힌 앱을 연 푸시가 이 함수로 읽힌다.
  assert.match(sw, /const params = new URLSearchParams\(\{ page: payload\.page \}\)\s*if \(payload\.focusId\) params\.set\('focus', payload\.focusId\)\s*return '\/\?' \+ params\.toString\(\)/)
})

test('휴대폰은 아래 네 칸이 주소를 정한다 — 오늘은 첫 화면(ai), 채팅은 messenger', () => {
  assert.equal(currentRoutePage({ phone: true, mobileTab: 'today', page: 'wiki' }), 'ai')
  assert.equal(currentRoutePage({ phone: true, mobileTab: 'tasks', page: 'wiki' }), 'tasks')
  assert.equal(currentRoutePage({ phone: true, mobileTab: 'chat', page: 'wiki' }), 'messenger')
  assert.equal(currentRoutePage({ phone: true, mobileTab: 'more', page: 'wiki' }), 'wiki')
  assert.equal(currentRoutePage({ phone: false, mobileTab: 'today', page: 'schedule' }), 'schedule')
})

test('업무 id는 업무 화면으로 가는 링크에서만 업무 자리에 들어간다', () => {
  assert.deepEqual(planOpen('tasks', 'WK-1'), { page: 'tasks', workFocusId: 'WK-1' })
  // 아침 요약(page 'ai')·일정 알림의 id를 업무 자리에 넣으면, 나중에 업무 화면에 들어갈 때 엉뚱한 업무가 펼쳐진다.
  assert.deepEqual(planOpen('ai', 'WK-1'), { page: 'ai' })
  assert.deepEqual(planOpen('schedule', 'EVT-1'), { page: 'schedule' })
  assert.deepEqual(planOpen('projects', 'PRJ-1'), { page: 'projects', projectFocusId: 'PRJ-1' })
  assert.deepEqual(planOpen('', ''), { page: '' })
})

test('알림·푸시·검색·출처 배지·근거 링크·주소창이 모두 openTarget 하나로 연다', () => {
  assert.equal(count(app, /const plan = planOpen\(targetPage, focusId\)/g), 1)
  assert.match(app, /onNavigate=\{\(page, focusId\) => openTarget\(page, focusId\)\}/) // 알림 센터
  assert.match(app, /openTarget\(params\.get\('page'\) \?\? '', params\.get\('focus'\)\)/) // 웹푸시(열린 앱)
  assert.match(app, /openTarget\(hit\.page, hit\.focusId\)/) // 전역 검색
  assert.match(app, /onOpenEvidence=\{\(page, focusId\) => openTarget\(page, focusId\)\}/) // 결재 근거
  assert.match(app, /openTarget\(originPage, focusId\)/) // 업무 출처 배지
  assert.match(app, /openTarget\(route\.page, route\.focus\)/) // 처음 연 주소(닫힌 앱의 푸시·공유 링크·새로 고침)
})

test('주소가 화면을 따라가고, [뒤로]는 상세를 닫고 화면을 되돌린다', () => {
  assert.match(app, /const initialRouteRef = useRef<AppRoute \| null>\(readRoute\(window\.location\.search\)\)/)
  // 처음 연 주소는 로그인해 회사 데이터가 준비된 그 한 번만 연다.
  assert.match(app, /initialRouteRef\.current = null\s*skipRouteSyncRef\.current = true/)
  // 상세를 닫을 때 방금 연 상세의 앞 주소면 새 칸을 쌓지 않고 되돌린다 — [뒤로]가 닫은 상세를 다시 열지 않게.
  assert.match(app, /if \(current && current\.page === routePage && current\.focus && !routeFocus && pushedFocus\) \{ window\.history\.back\(\); return \}/)
  assert.match(app, /window\.history\.pushState\(\{ itfFocus: Boolean\(routeFocus\) && current\.page === routePage && !current\.focus \}, '', url\)/)
  // 로그인 전 주소(초대·비밀번호 재설정·캘린더 콜백)는 건드리지 않는다.
  assert.match(app, /if \(params\.has\('guestInvite'\) \|\| params\.has\('reset'\) \|\| params\.has\('calendar'\)\) return/)
  // [뒤로]
  assert.match(app, /window\.addEventListener\('popstate', onPop\)/)
  assert.match(app, /else \{ setWorkFocusId\(''\); setTaskCloseSignal\(\(value\) => value \+ 1\) \}/)
  // 업무 상세는 처음 그릴 때의 '닫힘'을 알리지 않는다 — 알리면 휴대폰에서 상세가 열리기도 전에 목록으로 돌아간다.
  assert.match(app, /if \(reportedDrawerRef\.current === drawerId\) return/)
  assert.equal(count(app, /closeSignal=\{taskCloseSignal\} onDrawerChange=\{handleTaskDrawerChange\}/g), 2, '데스크톱·휴대폰 두 마운트')
})

test('[AI에게 묻기]는 어느 화면에서나 열리고, 홈 AI 칸과 같은 근거를 본다', () => {
  assert.match(app, /className=\{'top-icon-button ai-trigger ' \+ \(aiDrawerOpen \? 'active' : ''\)\} aria-label="AI에게 묻기"/)
  assert.match(app, /<span className="ai-trigger-label">AI에게 묻기<\/span>/)
  assert.equal(count(app, /buildAiContext\(\{/g), 3, '정의 1 + 홈 AI 칸 1 + 서랍 1')
  assert.match(app, /<aside ref=\{aiDrawerRef\} className="chat-drawer" role="dialog" aria-modal="true"/)
  // 휴대폰 첫 화면은 '오늘'이다.
  assert.match(app, /useState<MobileTab>\('today'\)/)
})

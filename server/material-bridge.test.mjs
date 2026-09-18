import assert from 'node:assert/strict'
import test from 'node:test'

import { doctypeEnd, frameDocument, MATERIAL_FRAME_CSP } from './material-bridge.mjs'

const CSP_TAG = '<meta http-equiv="Content-Security-Policy"'

test('CSP는 문서형 선언 바로 뒤에 들어간다 — 선언을 앞지르지 않아 표준 모드가 그대로다', () => {
  const frame = frameDocument('<!DOCTYPE html><html lang="ko"><head><title>t</title></head><body>본문</body></html>')
  assert.ok(frame.startsWith(`<!DOCTYPE html>${CSP_TAG}`))
  assert.ok(frame.includes('<html lang="ko">'), '자료의 html 태그는 고치지 않는다')
})

test('주석 속 <head>·<html>에 속지 않는다 — CSP가 주석 안으로 들어가 꺼지던 구멍', () => {
  const tricky = '<!-- <head> <html> --><!doctype html><html><head><script>window.leak = 1</script></head><body></body></html>'
  const frame = frameDocument(tricky)
  const at = frame.indexOf(CSP_TAG)
  assert.equal(at, tricky.indexOf('<html>', 20), '문서형 선언 뒤, 진짜 <html> 앞')
  const before = frame.slice(0, at)
  assert.equal(before.split('<!--').length, before.split('-->').length, '앞부분에 닫히지 않은 주석이 없다')
  assert.ok(at < frame.indexOf('window.leak'), '자료의 스크립트보다 앞선다')
})

test('문서형 선언이 없으면 맨 앞, 주석이 끝나지 않으면 맨 앞', () => {
  assert.equal(doctypeEnd('<html><head></head></html>'), 0)
  assert.equal(doctypeEnd('<!-- 끝나지 않는 주석 <!doctype html>'), 0)
  assert.equal(doctypeEnd('   \n<!-- a -- b --><!---><!-->\n<!DOCTYPE html>x'), '   \n<!-- a -- b --><!---><!-->\n<!DOCTYPE html>'.length)
  assert.equal(doctypeEnd('<?xml version="1.0"?><!DOCTYPE html>x'), '<?xml version="1.0"?><!DOCTYPE html>'.length)
  assert.equal(doctypeEnd('본문<!DOCTYPE html>'), 0, '글자 뒤의 선언은 브라우저도 무시한다')
  assert.equal(doctypeEnd(String.fromCharCode(0xfeff) + '<!doctype html>'), 16)
  assert.ok(frameDocument('<p>그냥 조각</p>').startsWith(CSP_TAG))
})

test('자료 자체 검토 기능 숨김은 스크립트로 달고, 원본 보기에서는 달지 않는다', () => {
  assert.ok(frameDocument('<!doctype html><p>x</p>').includes("setAttribute('data-itf-hide-native'"))
  assert.ok(!frameDocument('<!doctype html><p>x</p>', { hideNativeReview: false }).includes("setAttribute('data-itf-hide-native'"))
})

test('자료 안의 칸(iframe)이 앱 자신의 주소를 불러오지 못한다', () => {
  const frameSrc = MATERIAL_FRAME_CSP.split('; ').find((part) => part.startsWith('frame-src'))
  assert.equal(frameSrc, 'frame-src data: blob:')
  assert.match(MATERIAL_FRAME_CSP, /connect-src 'none'/)
})

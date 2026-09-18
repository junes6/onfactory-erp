/**
 * 검토 자료(AI가 만든 HTML)를 앱 안에서 **격리해 그리는** 틀.
 *
 * 자료는 `<iframe sandbox="allow-scripts" srcdoc>` 안에서만 돈다 — allow-same-origin이 없으므로 자료의 스크립트는
 * 앱의 쿠키·저장소·API에 닿지 못한다(출처가 'null'). 그 위에 두 겹을 더 씌운다:
 *   1) CSP: 밖으로 나가는 통신을 전부 막는다(connect-src 'none', 외부 그림·폰트·스크립트 불가).
 *   2) 브리지: 떼어 둔 큰 그림(itf-asset:<sha>)을 **앱이 대신 받아** 건네주고, 링크·높이·항목 위치를 앱에 알린다.
 * 브리지와 CSP는 **그릴 때마다** 끼워 넣는다(저장본에는 없다) — 브리지를 고쳐도 자료를 다시 올릴 필요가 없다.
 * 브리지를 거친 메시지로는 아무것도 저장되지 않는다. 앱은 보낸 창이 그 iframe인지 확인하고, 그림은 그 판의 목록에 있는 것만 준다.
 */

export const MATERIAL_FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'media-src data: blob:',
  'font-src data: blob:',
  // 자료 속 시안 칸은 브리지가 srcdoc으로 채운다(그 칸도 이 정책을 물려받는다). 앱 자신의 주소('self')는 열어 두지 않는다 —
  // 자료가 앱 화면을 칸 안에 불러오면 같은 사이트라 로그인 쿠키가 실려 간다.
  "frame-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
].join('; ')

/**
 * 자료 안에서 도는 브리지. 앱 코드와 같은 저장소에 있지만 **자료의 출처('null')에서** 돈다.
 * 받는 메시지는 부모 창이 보낸 것만, 보내는 메시지는 부모 창에게만.
 */
export const MATERIAL_BRIDGE_SCRIPT = String.raw`(function () {
  'use strict'
  if (window.__itfBridge) return
  window.__itfBridge = true
  var parentWindow = window.parent
  var PREFIX = 'itf-asset:'
  var SHA = /itf-asset:([a-f0-9]{64})/g
  var resolved = {}
  var waiting = {}
  var requested = {}
  function post(message) { try { parentWindow.postMessage(message, '*') } catch (error) { /* 부모가 없으면 조용히 */ } }
  function shasIn(text) { var found = []; String(text || '').replace(SHA, function (_, sha) { found.push(sha); return _ }); return found }
  function replaceIn(text) { return String(text || '').replace(SHA, function (whole, sha) { return resolved[sha] && resolved[sha].url ? resolved[sha].url : whole }) }
  function wait(sha, apply) {
    if (resolved[sha]) { apply(resolved[sha]); return }
    (waiting[sha] = waiting[sha] || []).push(apply)
    if (!requested[sha]) { requested[sha] = true; post({ itf: 'asset', sha: sha }) }
  }
  var ATTRIBUTES = ['src', 'href', 'poster', 'srcset', 'style']
  function wire(element) {
    if (!element || element.nodeType !== 1) return
    var names = element.getAttributeNames ? element.getAttributeNames() : []
    names.forEach(function (name) {
      var value = element.getAttribute(name)
      if (!value || value.indexOf(PREFIX) < 0) return
      var isText = name === 'srcdoc' || name === 'data-srcdoc'
      var lazy = !isText && (element.tagName === 'IMG' || element.tagName === 'SOURCE') && 'IntersectionObserver' in window
      var run = function () {
        shasIn(value).forEach(function (sha) {
          wait(sha, function () {
            var current = element.getAttribute(name) || ''
            if (isText) {
              var asset = resolved[sha]
              if (asset && typeof asset.text === 'string' && current === PREFIX + sha) element.setAttribute(name, asset.text)
            } else if (current.indexOf(PREFIX) >= 0) {
              element.setAttribute(name, replaceIn(current))
            }
          })
        })
      }
      if (lazy) lazyQueue.push({ element: element, run: run })
      else run()
    })
  }
  var lazyQueue = []
  function wireStyles() {
    Array.prototype.forEach.call(document.querySelectorAll('style'), function (style) {
      var text = style.textContent || ''
      if (text.indexOf(PREFIX) < 0) return
      shasIn(text).forEach(function (sha) {
        wait(sha, function () { style.textContent = replaceIn(style.textContent) })
      })
    })
  }
  function wireAll(root) {
    var all = (root || document).querySelectorAll('*')
    for (var i = 0; i < all.length; i += 1) wire(all[i])
    if ('IntersectionObserver' in window && lazyQueue.length) {
      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return
          observer.unobserve(entry.target)
          var item = entry.target.__itfRun
          if (item) item()
        })
      }, { rootMargin: '800px 0px' })
      lazyQueue.splice(0).forEach(function (item) { item.element.__itfRun = item.run; observer.observe(item.element) })
    }
  }
  window.addEventListener('message', function (event) {
    if (event.source !== parentWindow) return
    var data = event.data
    if (!data || typeof data !== 'object' || typeof data.itf !== 'string') return
    if (data.itf === 'asset-data' && /^[a-f0-9]{64}$/.test(data.sha || '')) {
      var asset = { mime: String(data.mime || '') }
      if (typeof data.text === 'string') asset.text = data.text
      else if (data.buffer) asset.url = URL.createObjectURL(new Blob([data.buffer], { type: asset.mime }))
      resolved[data.sha] = asset
      var callbacks = waiting[data.sha] || []
      delete waiting[data.sha]
      callbacks.forEach(function (callback) { try { callback(asset) } catch (error) { /* 한 칸의 실패가 나머지를 막지 않게 */ } })
    } else if (data.itf === 'scroll' && typeof data.a === 'string') {
      var target = document.querySelector('[data-itf-a="' + data.a.replace(/"/g, '') + '"]')
      if (target) { target.scrollIntoView({ block: 'start', behavior: data.smooth ? 'smooth' : 'auto' }); flash(target) }
    } else if (data.itf === 'zoom' && typeof data.factor === 'number') {
      var factor = Math.max(0.3, Math.min(2.5, data.factor))
      document.documentElement.style.zoom = String(factor)
    } else if (data.itf === 'native-review') {
      document.documentElement.toggleAttribute('data-itf-hide-native', Boolean(data.hidden))
    }
  })
  function flash(element) {
    element.setAttribute('data-itf-flash', '')
    setTimeout(function () { element.removeAttribute('data-itf-flash') }, 1600)
  }
  // 링크: 밖으로 나가는 링크는 앱이 먼저 묻는다(격리된 칸은 새 창을 열 수 없다).
  document.addEventListener('click', function (event) {
    var link = event.target && event.target.closest ? event.target.closest('a[href]') : null
    if (!link) return
    var href = link.getAttribute('href') || ''
    if (href.charAt(0) === '#') return
    if (/^(https?:|mailto:|tel:)/i.test(href)) { event.preventDefault(); post({ itf: 'link', href: href }) }
    else if (href.indexOf('javascript:') !== 0) { event.preventDefault() }
  }, true)
  // 지금 보고 있는 항목 — 옆 칸(의견)이 따라온다.
  function watchAnchors() {
    if (!('IntersectionObserver' in window)) return
    var visible = {}
    var timer = null
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var key = entry.target.getAttribute('data-itf-a')
        if (entry.isIntersecting) visible[key] = entry.boundingClientRect.top
        else delete visible[key]
      })
      clearTimeout(timer)
      timer = setTimeout(function () {
        var list = Object.keys(visible).sort(function (a, b) { return visible[a] - visible[b] })
        post({ itf: 'visible', a: list.slice(0, 12) })
      }, 120)
    }, { rootMargin: '-10% 0px -55% 0px' })
    Array.prototype.forEach.call(document.querySelectorAll('[data-itf-a]'), function (element) { observer.observe(element) })
  }
  /**
   * 자료 자체의 검토 기능(반영·보류 선택, 찬반 버튼, 의견 칸, 내보내기·가져오기·초기화·공유 저장 버튼)을 표시한다.
   * 앱의 의견 기능과 두 벌이 되지 않게 기본으로 숨기고, 앱에서 [자료 자체 기능 보이기]로 되살린다.
   */
  function markNativeReview() {
    var count = 0
    function mark(element) { if (element && !element.hasAttribute('data-itf-native')) { element.setAttribute('data-itf-native', ''); count += 1 } }
    Array.prototype.forEach.call(document.querySelectorAll('select'), function (select) {
      var text = Array.prototype.map.call(select.options || [], function (option) { return option.textContent || '' }).join('|')
      if (/반영|보류|미반영/.test(text)) mark(select)
    })
    Array.prototype.forEach.call(document.querySelectorAll('[data-stance]'), mark)
    // 인쇄는 격리된 칸에서 어차피 열리지 않는다(allow-modals를 주지 않는다) — 눌러도 아무 일이 없는 버튼을 남기지 않는다.
    Array.prototype.forEach.call(document.querySelectorAll('button, [role=button]'), function (button) {
      var label = (button.textContent || '').replace(/\s+/g, ' ').trim()
      if (label.length <= 20 && /(내보내기|가져오기|초기화|공유 저장|의견 저장|결정 요약|요약 복사|인쇄|JSON)/.test(label)) mark(button)
    })
    Array.prototype.forEach.call(document.querySelectorAll('[data-itf-a] textarea'), mark)
    // 자료 속 "내 이름" 칸 — 자료의 자체 의견 기능이 누구 의견인지 적던 자리다. 앱은 로그인한 사람을 안다.
    Array.prototype.forEach.call(document.querySelectorAll('label'), function (label) {
      var text = (label.textContent || '').replace(/\s+/g, ' ').trim()
      var box = label.parentElement
      if (/^(내\s*)?이름$/.test(text) && box && box.querySelector('input') && box.children.length <= 3) mark(box)
    })
    // 반영·보류·미반영 집계 줄 — 자료 속 기능이 숨겨지면 영영 0으로 멈춰 있어 틀린 숫자가 된다.
    Array.prototype.forEach.call(document.querySelectorAll('div, ul, p, span'), function (box) {
      var children = box.children
      if (!children || children.length < 3 || children.length > 8) return
      var hits = 0
      for (var i = 0; i < children.length; i += 1) {
        if (/^(미정|반영|수정|수정 후 반영|보류|미반영|의견)(\s*\d+\s*(명|개|건)?)?$/.test((children[i].textContent || '').replace(/\s+/g, ' ').trim())) hits += 1
      }
      if (hits >= 3) mark(box)
    })
    return count
  }
  function start() {
    var style = document.createElement('style')
    style.setAttribute('data-itf', 'bridge')
    style.textContent = '[data-itf-flash]{outline:3px solid #2f6fed!important;outline-offset:4px;transition:outline-color .6s}'
      + 'html[data-itf-hide-native] [data-itf-native]{display:none!important}'
    document.head && document.head.appendChild(style)
    var nativeControls = markNativeReview()
    wireStyles()
    wireAll(document)
    watchAnchors()
    post({ itf: 'ready', anchors: document.querySelectorAll('[data-itf-a]').length, width: document.documentElement.scrollWidth, nativeControls: nativeControls })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
})()`

const escapeAttribute = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/**
 * 문서 맨 앞의 "머리말"(BOM·공백·주석·문서형 선언)을 브라우저 토크나이저 규칙대로 건너뛰고,
 * 문서형 선언(<!DOCTYPE …>)이 있으면 그 끝 위치를, 없으면 0을 돌려준다.
 *
 * 전에는 `/<head>/`를 글자로 찾아 그 뒤에 CSP를 끼웠다. 자료가 `<!-- <head> -->`로 시작하면 CSP와 브리지가
 * **주석 안으로** 들어가 꺼졌다 — 자료가 밖으로 통신할 수 있게 된다. 이제 위치는 글자 모양이 아니라 토큰으로 정한다.
 * 문서형 선언 바로 뒤에 넣으면 브라우저가 html·head를 스스로 열고 우리 meta를 head 첫 줄에 둔다 —
 * 자료의 `<html>`·`<head>` 태그가 뒤에 와도 속성만 합쳐지고 무시된다. 선언을 앞지르지 않으므로 표준/호환 모드도 원본 그대로다.
 */
export function doctypeEnd(html) {
  const text = String(html ?? '')
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0
  const length = text.length
  while (index < length) {
    const code = text.charCodeAt(index)
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) { index += 1; continue }
    if (text[index] !== '<') return 0
    if (text.startsWith('<!--', index)) {
      // <!--> 와 <!---> 는 곧바로 닫히는 빈 주석이다.
      if (text.startsWith('<!-->', index)) { index += 5; continue }
      if (text.startsWith('<!--->', index)) { index += 6; continue }
      let cursor = index + 4
      let closed = -1
      while (cursor < length) {
        const dash = text.indexOf('--', cursor)
        if (dash === -1) break
        if (text[dash + 2] === '>') { closed = dash + 3; break }
        if (text[dash + 2] === '!' && text[dash + 3] === '>') { closed = dash + 4; break }
        cursor = dash + 1
      }
      if (closed === -1) return 0 // 끝나지 않는 주석 — 문서 전체가 주석이다
      index = closed
      continue
    }
    if (/^<!doctype/i.test(text.slice(index, index + 9))) {
      const end = text.indexOf('>', index)
      return end === -1 ? 0 : end + 1
    }
    // <? … > 와 <!… > (주석·선언이 아닌 것)는 '가짜 주석'으로 > 까지 읽힌다.
    if (text[index + 1] === '?' || text[index + 1] === '!') {
      const end = text.indexOf('>', index)
      if (end === -1) return 0
      index = end + 1
      continue
    }
    return 0
  }
  return 0
}

/**
 * 저장된 그리기 사본에 CSP와 브리지를 끼운 **iframe srcdoc용 문서**를 만든다.
 * 문서형 선언 바로 뒤(없으면 맨 앞)에 넣는다 — 자료의 어떤 태그·스크립트보다 먼저 head에 자리 잡는다.
 */
export function frameDocument(renderHtml, { hideNativeReview = true } = {}) {
  const html = String(renderHtml ?? '')
  // 자료 자체의 검토 기능(반영/보류 선택·의견 칸·내보내기 버튼)은 앱의 의견 기능과 겹친다 — 기본으로 숨긴다.
  // 표시는 <html> 태그를 글자로 고치지 않고 스크립트로 단다(같은 이유 — 주석 속 <html>에 속지 않는다).
  const hideFlag = hideNativeReview ? "document.documentElement.setAttribute('data-itf-hide-native','');" : ''
  const injection = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(MATERIAL_FRAME_CSP)}">`
    + '<meta name="referrer" content="no-referrer">'
    + `<script data-itf="bridge">${hideFlag}${MATERIAL_BRIDGE_SCRIPT.replace(/<\/script/gi, '<\\/script')}</script>`
  const at = doctypeEnd(html)
  return html.slice(0, at) + injection + html.slice(at)
}

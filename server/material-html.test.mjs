import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

import {
  decodeHtmlEntities,
  decodeMaterialBytes,
  MATERIAL_LIMITS,
  materialSearchText,
  parseMaterialHtml,
  prepareMaterial,
} from './material-html.mjs'

const page = (body, head = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const tags = (doc) => doc.elements.map((el) => el.tag)
const byKey = (result) => new Map(result.anchors.map((anchor) => [anchor.key, anchor]))
const countOf = (text, needle) => text.split(needle).length - 1

// ---------------------------------------------------------------------------
// 토크나이저
// ---------------------------------------------------------------------------

test('tokenizer keeps quoted > inside values, reads unquoted/valueless/duplicate attributes and uppercase tags', () => {
  const source = '<DIV CLASS=box ID="a>b" data-x = \'1>2\' hidden id="second">\n<A\n  HREF="#x"\n  title="줄\n바꿈">링크</A></DIV>'
  const doc = parseMaterialHtml(source)
  assert.deepEqual(tags(doc), ['div', 'a'])
  const [div, link] = doc.elements
  assert.equal(doc.attr(div, 'class'), 'box')
  assert.equal(doc.attr(div, 'id'), 'a>b', '같은 이름이 두 번이면 첫 번째가 이긴다')
  assert.equal(doc.attr(div, 'data-x'), '1>2')
  assert.equal(doc.attr(div, 'hidden'), '')
  assert.equal(doc.attr(div, 'missing'), undefined)
  assert.equal(link.parent, div)
  assert.equal(doc.attr(link, 'href'), '#x')
  assert.equal(doc.attr(link, 'title'), '줄\n바꿈')
  assert.equal(doc.text(link), '링크')
  // 위치는 원본을 그대로 가리킨다 — 다시 쓰지 않고 제자리만 고치기 위해서다.
  const id = div.attrs.find((attr) => attr.name === 'id')
  assert.equal(source.slice(id.vs, id.ve), 'a>b')
  assert.equal(source.slice(div.start, div.tagEnd), '<DIV CLASS=box ID="a>b" data-x = \'1>2\' hidden id="second">')
  assert.equal(source.slice(div.start, div.nameEnd), '<DIV')
  assert.equal(div.end, source.length)
})

test('tokenizer skips comments (even with tags inside), doctype and bogus markup', () => {
  const doc = parseMaterialHtml('<!DOCTYPE html><div id="a"><!-- <div id="nope"> </div> --><p>글</p></div><!--> <span>x</span><?xml nope?><![CDATA[ <b>junk</b> ]]><i>끝</i>')
  assert.deepEqual(tags(doc), ['div', 'p', 'span', 'i'], 'CDATA는 HTML 안에서 첫 > 까지의 주석이다')
  assert.equal(doc.elements[1].parent, doc.elements[0])
  assert.equal(doc.text(doc.elements[0]), '글')
})

test('raw text elements swallow fake tags until their own end tag', () => {
  const source = '<div id="a"><script>var s = "</div><p>"; if (a < b) {}</script><style>.x::after{content:"</div>"}</style><textarea><b>굵게 &amp; 그대로</b></textarea><p>뒤</p></div><div id="b"></div>'
  const doc = parseMaterialHtml(source)
  assert.deepEqual(tags(doc), ['div', 'script', 'style', 'textarea', 'p', 'div'])
  const [outer, script, , textarea, after, second] = doc.elements
  const scriptText = script.children[0]
  assert.equal(source.slice(scriptText.start, scriptText.end), 'var s = "</div><p>"; if (a < b) {}')
  assert.equal(doc.text(textarea), '<b>굵게 & 그대로</b>')
  assert.equal(after.parent, outer)
  assert.equal(second.parent, doc.root)
})

test('implied end tags for p, li, dt/dd, tr/td, option like a browser', () => {
  const para = parseMaterialHtml('<p>하나<p>둘<div>셋</div>')
  assert.ok(para.elements.every((el) => el.parent === para.root))

  const list = parseMaterialHtml('<ul><li>가<li>나<ul><li>안</ul><li>다</ul>')
  const [outer] = list.elements
  const items = outer.children.filter((child) => child.tag === 'li')
  assert.equal(items.length, 3)
  assert.equal(items[1].children.find((child) => child.tag === 'ul').children.length, 1)

  const table = parseMaterialHtml('<table><tr><td>1<td>2<tr><td>3</table><p>after')
  const rows = table.elements.filter((el) => el.tag === 'tr')
  assert.equal(rows.length, 2)
  assert.ok(rows.every((row) => row.parent === table.elements[0]))
  assert.equal(rows[0].children.length, 2)
  assert.equal(table.elements.at(-1).parent, table.root)

  const sections = parseMaterialHtml('<table><thead><tr><th>h</thead><tbody><tr><td>1<tr><td>2</tbody></table>')
  const tbody = sections.elements.find((el) => el.tag === 'tbody')
  assert.equal(tbody.parent.tag, 'table')
  assert.equal(tbody.children.filter((child) => child.tag === 'tr').length, 2)

  const defs = parseMaterialHtml('<dl><dt>a<dd>b<dt>c<dd>d</dl>')
  assert.equal(defs.elements[0].children.length, 4)

  const select = parseMaterialHtml('<select><option>a<option>b<optgroup label="g"><option>c</select><p>x</p>')
  const options = select.elements.filter((el) => el.tag === 'option')
  assert.equal(options[0].parent.tag, 'select')
  assert.equal(options[1].parent.tag, 'select')
  assert.equal(options[2].parent.tag, 'optgroup')
  assert.equal(select.elements.at(-1).parent, select.root)
})

test('mismatched end tags pop to the nearest match and stray ones are ignored', () => {
  const doc = parseMaterialHtml('<div id="a"><span>글</div><p>밖</p></section></div>')
  const [div, span, p] = doc.elements
  assert.equal(span.parent, div)
  assert.equal(p.parent, doc.root, '</div>가 span까지 닫는다')
  // 표 칸 밖에서 열린 div는 칸 안의 </div>로 닫히지 않는다(브라우저의 범위 규칙).
  const cell = parseMaterialHtml('<div id="o"><table><tr><td></div>안</td></tr></table><p>뒤</p></div>')
  const outer = cell.elements[0]
  const td = cell.elements.find((el) => el.tag === 'td')
  assert.equal(cell.text(td), '안')
  assert.equal(cell.elements.find((el) => el.tag === 'p').parent, outer)
})

test('deeply nested, unclosed or cut-off markup stays fast and does not throw', () => {
  const started = performance.now()
  const deep = parseMaterialHtml(`${'<div>'.repeat(100000)}<p>끝</p>${'<span>'.repeat(50000)}${'<li>항목'.repeat(20000)}`)
  assert.ok(performance.now() - started < 3000, '깊게 겹친 파일도 목록을 매번 끝까지 훑지 않는다')
  assert.equal(deep.elements.at(-1).tag, 'li')
  assert.deepEqual(tags(parseMaterialHtml('<div><script>var a = "</scrip"; <p>안')), ['div', 'script'])
  assert.deepEqual(tags(parseMaterialHtml('<p>앞</p><img src="a.png')), ['p'], '끝나지 않은 태그는 버린다')
})

test('entities decode common names and numbers; unknown ones stay as written', () => {
  assert.equal(decodeHtmlEntities('&lt;회의&gt; &amp; 자료 &#54620;&#xD55C; &unknown; &amp &copy2 &#150; &#0;'), '<회의> & 자료 한한 &unknown; & &copy2 – \ufffd')
  assert.equal(decodeHtmlEntities('A&nbsp;B&middot;C&hellip;'), 'A\u00a0B·C…')
})

test('a page with nothing to change comes back byte for byte', () => {
  const source = '<!DOCTYPE html>\r\n<HTML><Head><TITLE>짧은</TITLE></Head><BODY class=x>\n<!-- 주석 --><p>짧다</p><img src=a.png alt=\'\'></BODY></HTML>\n'
  const result = prepareMaterial(source)
  assert.equal(result.renderHtml, source)
  assert.equal(result.anchors.length, 0)
  assert.equal(result.assets.length, 0)
})

// ---------------------------------------------------------------------------
// 큰 값 떼어 내기
// ---------------------------------------------------------------------------

test('large data: URIs are extracted from src, srcset, href, data-*, style attributes and <style>, de-duplicated, bytes intact', () => {
  const png = randomBytes(12000)
  const png2 = randomBytes(9000)
  const font = randomBytes(10000)
  const pdf = randomBytes(9000)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><title>한글 &amp; 그림</title>${'<rect width="1" height="1" fill="#abc"/>'.repeat(300)}</svg>`
  const pngUri = `data:image/png;base64,${png.toString('base64')}`
  const png2Uri = `data:image/png;base64,${png2.toString('base64')}`
  const fontUri = `data:font/woff2;base64,${font.toString('base64')}`
  const svgUri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  const smallUri = `data:image/png;base64,${randomBytes(90).toString('base64')}`
  const pdfUri = `data:application/pdf;base64,${pdf.toString('base64')}`
  const source = page(
    `<img src="${pngUri}" alt="a"><IMG SRC='${pngUri}'>`
      + `<a class="zoom" data-src="${pngUri}">크게</a>`
      + `<div style="background:url(&quot;${pngUri}&quot;) no-repeat"></div>`
      + `<img srcset="${pngUri} 1x, ${png2Uri} 2x" src="${smallUri}">`
      + `<a href="${pdfUri}">pdf</a><img src="${svgUri}">`,
    `<style>.hero{background:url('${pngUri}')} @font-face{src:url(${fontUri}) format("woff2")}</style>`,
  )
  const result = prepareMaterial(source)
  const bySha = new Map(result.assets.map((asset) => [asset.sha256, asset]))
  assert.equal(result.assets.length, 4, 'png·png2·svg·font — 같은 그림은 한 번만')
  const pngAsset = bySha.get(sha256(png))
  assert.ok(pngAsset)
  assert.equal(pngAsset.mime, 'image/png')
  assert.equal(pngAsset.size, png.length)
  assert.ok(Buffer.isBuffer(pngAsset.bytes))
  assert.ok(Buffer.compare(pngAsset.bytes, png) === 0, '떼어 낸 바이트가 원본과 같아야 한다')
  assert.ok(Buffer.compare(bySha.get(sha256(png2)).bytes, png2) === 0)
  assert.ok(Buffer.compare(bySha.get(sha256(font)).bytes, font) === 0)
  assert.equal(bySha.get(sha256(font)).mime, 'font/woff2')
  const svgAsset = bySha.get(sha256(Buffer.from(svg, 'utf8')))
  assert.equal(svgAsset.mime, 'image/svg+xml')
  assert.equal(svgAsset.bytes.toString('utf8'), svg)

  const ref = `itf-asset:${sha256(png)}`
  assert.equal(countOf(result.renderHtml, ref), 6)
  assert.ok(result.renderHtml.includes(`style="background:url(&quot;${ref}&quot;) no-repeat"`), '따옴표 표기는 그대로 둔다')
  assert.ok(result.renderHtml.includes(`srcset="${ref} 1x, itf-asset:${sha256(png2)} 2x"`))
  assert.ok(result.renderHtml.includes(smallUri), '8KB 이하는 그대로 둔다')
  assert.ok(result.renderHtml.includes(pdfUri), '허용하지 않는 형식은 그대로 둔다')
  assert.equal(result.report.skippedDataUris, 1)
  assert.equal(result.report.assetCount, 4)
  assert.ok(result.report.renderBytes < result.report.originalBytes)

  // 표시를 원래 값으로 되돌리면 원본과 한 글자도 다르지 않다.
  const originals = new Map([[sha256(png), pngUri], [sha256(png2), png2Uri], [sha256(font), fontUri], [svgAsset.sha256, svgUri]])
  const restored = result.renderHtml.replace(/itf-asset:([0-9a-f]{64})/g, (_, sha) => originals.get(sha))
  assert.equal(restored, source)
})

test('large srcdoc / data-srcdoc strings become text/html assets holding the decoded document', () => {
  const inner = `<!doctype html><html><body><h1>시안 "큰" 칸 &amp; 표</h1>${'<p>가나다라마바사아자차</p>'.repeat(1200)}</body></html>`
  const escaped = inner.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const small = '&lt;p&gt;작은 칸&lt;/p&gt;'
  const source = page(`<iframe title="a" data-srcdoc="${escaped}"></iframe><iframe srcdoc="${escaped}"></iframe><iframe srcdoc="${small}"></iframe>`)
  const result = prepareMaterial(source)
  assert.equal(result.assets.length, 1)
  const [asset] = result.assets
  assert.equal(asset.mime, 'text/html; charset=utf-8')
  assert.equal(asset.bytes.toString('utf8'), inner)
  assert.equal(asset.sha256, sha256(Buffer.from(inner, 'utf8')))
  assert.ok(result.renderHtml.includes(`data-srcdoc="itf-asset:${asset.sha256}"`))
  assert.ok(result.renderHtml.includes(`<iframe srcdoc="itf-asset:${asset.sha256}">`))
  assert.ok(result.renderHtml.includes(`srcdoc="${small}"`))
})

// ---------------------------------------------------------------------------
// 항목 인식
// ---------------------------------------------------------------------------

test('rule 1: data-itf-anchor is the key, data-itf-kind the kind — kept even when short', () => {
  const result = prepareMaterial(page('<div data-itf-anchor=" Q-1 " data-itf-kind="proposal" data-prio="P0"><h3>예산 승인</h3></div>'))
  assert.equal(result.anchors.length, 1)
  const [anchor] = result.anchors
  assert.equal(anchor.key, 'Q-1')
  assert.equal(anchor.kind, 'proposal')
  assert.equal(anchor.title, '예산 승인')
  assert.equal(anchor.decisionEnabled, true)
  assert.match(anchor.id, /^a-[0-9a-f]{12}$/)
  assert.ok(result.renderHtml.includes(`<div data-itf-a="${anchor.id}" data-itf-anchor=" Q-1 "`))
})

test('rule 2: three or more siblings with the same tag+class and ids become items; kinds follow the tag', () => {
  const meeting = '회의 1 — 아주 긴 값은 사십 자에서 자릅니다 아주 긴 값은 사십 자에서 자릅니다'
  const article = (id, cls = 'prop card') => `<article class="${cls}" id="${id}" data-id="${id}" data-prio="P1" data-group="A" data-src="x.png" data-itf-x="y" data-meeting="${meeting}"><h3>${id} 제안의 제목입니다</h3><p>제안 본문은 충분히 길게 씁니다.</p></article>`
  const body = `<section class="group"><h2>제안 묶음</h2>${article('A1')}${article('A2', 'card  prop')}${article('A3')}</section>`
    + `<div><article class="other" id="o1"><p>형제가 둘뿐인 글은 항목이 아닙니다</p></article><article class="other" id="o2"><p>형제가 둘뿐인 글은 항목이 아닙니다</p></article></div>`
    + `<div>${[1, 2, 3].map((n) => `<details class="doc" id="d${n}"><summary><span>0${n} 원문</span><span>블록 ${n}개</span></summary><p>원문 내용이 여기에 길게 들어갑니다.</p></details>`).join('')}</div>`
    + `<div>${[1, 2, 3].map((n) => `<figure class="shot" id="s${n}"><img src="a.png"><figcaption>화면 ${n} — 첫 화면 모습</figcaption></figure>`).join('')}</div>`
    + `<table><tbody>${[1, 2, 3].map((n) => `<tr id="r-${n}" data-sev="P${n}"><td>R-0${n}</td><td><b>행 ${n}의 굵은 제목</b><details><summary>근거 · 해결</summary><p>근거</p></details></td></tr>`).join('')}</tbody></table>`
    + `<ul>${[1, 2, 3].map((n) => `<li class="todo" data-id="t${n}">할 일 ${n}번은 이렇게 처리합니다</li>`).join('')}</ul>`
    + '<div class="acts"><button class="btn" id="b1">내보내기 버튼입니다</button><button class="btn" id="b2">가져오기 버튼입니다</button><button class="btn" id="b3">초기화 버튼입니다</button></div>'
  const result = prepareMaterial(page(body))
  const anchors = byKey(result)
  for (const key of ['A1', 'A2', 'A3']) assert.equal(anchors.get(key)?.kind, 'item', key)
  assert.equal(anchors.get('A1').title, 'A1 제안의 제목입니다')
  assert.deepEqual(anchors.get('A1').attributes, { 'data-prio': 'P1', 'data-group': 'A', 'data-meeting': meeting.slice(0, 40) })
  assert.equal(anchors.has('o1'), false)
  assert.equal(anchors.get('d1').kind, 'doc')
  assert.equal(anchors.get('d1').title, '01 원문 · 블록 1개', '제 이름표 조각은 · 로 잇는다')
  assert.equal(anchors.get('s2').kind, 'figure')
  assert.equal(anchors.get('s2').title, '화면 2 — 첫 화면 모습')
  assert.equal(anchors.get('r-1').kind, 'row')
  assert.equal(anchors.get('r-1').title, 'R-01 · 행 1의 굵은 제목', '행 안의 접힘 이름표는 제목이 아니다')
  assert.deepEqual(anchors.get('r-3').attributes, { 'data-sev': 'P3' })
  assert.equal(anchors.get('t2').kind, 'item')
  assert.equal(anchors.has('b1'), false, '버튼은 줄지어 있어도 항목이 아니다')
  assert.equal([...anchors.keys()].some((key) => key.startsWith('h:')), false, '항목 안의 제목은 항목의 일부다')
  // 문서 순서와 order
  assert.deepEqual(result.anchors.map((anchor) => anchor.order), result.anchors.map((_, index) => index))
  assert.ok(result.renderHtml.includes(`<article data-itf-a="${anchors.get('A2').id}" class="card  prop"`))
})

test('rule 2 extends a confirmed tag+class group to other sections where it has fewer than three siblings', () => {
  const item = (id) => `<article class="prop" id="${id}"><h3>${id} 번 제안은 이것입니다</h3></article>`
  const result = prepareMaterial(page(`<section id="g-a"><h2>첫 묶음의 제목</h2>${item('A1')}${item('A2')}${item('A3')}</section><section id="g-f"><h2>둘뿐인 묶음 제목</h2>${item('F1')}${item('F2')}</section>`))
  const anchors = byKey(result)
  assert.equal(anchors.get('F1')?.kind, 'item')
  assert.equal(anchors.get('F1').parentId, anchors.get('g-f').id)
})

test('rule 3: section[id] and headings outside items; a heading covers its following siblings until the next same-level heading', () => {
  const body = '<section id="intro"><h2>들어가며 — 이 자료의 목적</h2><p>이 자료는 개편안을 검토하려고 만들었습니다.</p></section>'
    + '<div class="doc"><h2>배경과 문제</h2><p>문제는 여러 가지가 있습니다. 첫째는 이것입니다.</p>'
    + '<h3>세부 문제 하나</h3><p>세부 내용 설명이 길게 이어집니다.</p>'
    + '<h2 id="bg-2">배경과 문제</h2><p>같은 제목이 다시 나오는 두 번째 절입니다.</p>'
    + '<h2>배경과 문제</h2><p>같은 제목이 세 번째로 나오는 절입니다.</p></div>'
  const result = prepareMaterial(page(body))
  const anchors = byKey(result)
  assert.equal(anchors.get('intro').kind, 'section')
  assert.equal(anchors.get('intro').title, '들어가며 — 이 자료의 목적')
  assert.equal(result.anchors.filter((anchor) => anchor.title === '들어가며 — 이 자료의 목적').length, 1, '절의 이름표 제목은 따로 항목이 되지 않는다')
  const first = anchors.get('h:배경과-문제#1')
  assert.ok(first, [...anchors.keys()].join(', '))
  assert.equal(first.depth, 1)
  // 문단·제목 사이는 줄을 바꾼다(읽기 모드에서 한 덩어리가 되지 않게).
  assert.match(first.text, /^배경과 문제\n문제는 여러 가지가 있습니다\. 첫째는 이것입니다\.\n세부 문제 하나\n세부 내용/)
  assert.ok(!first.text.includes('두 번째 절'))
  const sub = anchors.get('h:세부-문제-하나#1')
  assert.equal(sub.parentId, first.id)
  assert.equal(sub.depth, 2)
  assert.equal(anchors.get('bg-2').kind, 'section', 'id가 있으면 id가 키')
  assert.ok(anchors.get('h:배경과-문제#2'), '같은 제목은 순번으로 구분한다')
  assert.ok(result.renderHtml.includes(`<h2 data-itf-a="${first.id}">배경과 문제</h2>`))
})

test('rule 4: tables without ids anchor rows whose first cell looks like an item code', () => {
  const rows = (codes) => codes.map((code) => `<tr><td>${code}</td><td>${code} 행의 내용을 적었습니다</td></tr>`).join('')
  const result = prepareMaterial(page(`<table><tr><th>ID</th><th>내용</th></tr>${rows(['AB-01', 'AB-02', 'C_3', 'nope'])}</table><table>${rows(['X-1', 'X-2'])}</table>`))
  assert.deepEqual(result.anchors.map((anchor) => anchor.key), ['AB-01', 'AB-02', 'C_3'])
  assert.ok(result.anchors.every((anchor) => anchor.kind === 'row'))
  assert.equal(result.anchors[0].title, 'AB-01 · AB-01 행의 내용을 적었습니다')
})

test('excluded regions, short text, depth over 3 and key collisions', () => {
  const long = '충분히 긴 본문 글을 여기에 씁니다'
  const body = `<header><section id="top"><h1>머리글 안의 큰 제목입니다</h1></section></header>`
    + `<nav><section id="toc">${long}</section></nav><aside><section id="side">${long}</section></aside>`
    + `<div hidden><section id="hid">${long}</section></div><dialog><section id="dlg">${long}</section></dialog>`
    + `<div role="status"><section id="st">${long}</section></div><div role="navigation"><section id="rn">${long}</section></div>`
    + '<section id="tiny">짧은 글</section>'
    + `<section id="l1">${long}<section id="l2">${long}<section id="l3">${long}<section id="l4">${long}</section></section></section></section>`
    + `<div data-itf-anchor="X">${long} 하나</div><div data-itf-anchor="X">${long} 둘</div><div data-itf-anchor="X">${long} 셋</div>`
  const result = prepareMaterial(page(body))
  const keys = result.anchors.map((anchor) => anchor.key)
  assert.deepEqual(keys, ['l1', 'l2', 'l3', 'X', 'X~2', 'X~3'])
  const anchors = byKey(result)
  assert.equal(anchors.get('l1').depth, 1)
  assert.equal(anchors.get('l3').depth, 3)
  assert.equal(anchors.get('l3').parentId, anchors.get('l2').id)
  assert.equal(anchors.get('l1').parentId, null)
  assert.equal(result.report.keyCollisions, 2)
  assert.equal(new Set(result.anchors.map((anchor) => anchor.id)).size, result.anchors.length)
  assert.ok(!result.renderHtml.includes('id="l4" data-itf-a') && !/<section data-itf-a="[^"]+" id="l4"/.test(result.renderHtml))
})

test('titles fall back figcaption → summary → bold → cell → first 60 chars; text is NFKC-normalized and hashed', () => {
  const body = '<div data-itf-anchor="f"><p>그림 설명 앞의 글입니다</p><figure><figcaption>그림 이름표</figcaption></figure><b>굵게</b></div>'
    + '<div data-itf-anchor="s"><details><summary>접힌 글 이름</summary>내용</details><strong>굵게</strong></div>'
    + '<div data-itf-anchor="b"><p>앞의 글 <strong>굵은 제목</strong> 뒤의 글</p><table><tr><td>칸</td></tr></table></div>'
    + '<div data-itf-anchor="c"><table><tr><td>첫 칸 글</td><td>다음 칸</td></tr></table></div>'
    + `<div data-itf-anchor="t"><p>ＡＢＣ　전각 글자와 ${'긴 문장 '.repeat(20)}</p></div>`
  const anchors = byKey(prepareMaterial(page(body)))
  assert.equal(anchors.get('f').title, '그림 이름표')
  assert.equal(anchors.get('s').title, '접힌 글 이름')
  assert.equal(anchors.get('b').title, '굵은 제목')
  assert.equal(anchors.get('c').title, '첫 칸 글')
  const plain = anchors.get('t')
  assert.ok(plain.text.startsWith('ABC 전각 글자와 긴 문장'), 'NFKC: 전각 글자·전각 공백을 보통 글자로')
  assert.equal(plain.title, plain.text.slice(0, 60))
  assert.equal(plain.textHash, sha256(plain.text))
  assert.match(plain.simhash, /^[0-9a-f]{16}$/)
})

test('simhash stays close for small edits and far for different text', () => {
  const base = '이용권 차감 시점을 완성 후로 옮기고 경고 모달과 체크박스를 없앤다. 실패하면 자동으로 되돌린다. 사용자는 돈이 먼저 나간다고 느끼지 않는다.'
  const edited = base.replace('자동으로', '곧바로')
  const other = '표지 제목과 작가 이름을 그림에서 분리해 글자 레이어로 만든다. 번역본은 언어별 표지를 따로 저장한다. 글꼴은 두 가지로 줄인다.'
  const result = prepareMaterial(page(`<div data-itf-anchor="a">${base}</div><div data-itf-anchor="b">${edited}</div><div data-itf-anchor="c">${other}</div>`))
  const [a, b, c] = result.anchors.map((anchor) => BigInt(`0x${anchor.simhash}`))
  const distance = (x, y) => (x ^ y).toString(2).replace(/0/g, '').length
  assert.ok(distance(a, b) < distance(a, c), `${distance(a, b)} < ${distance(a, c)}`)
  assert.ok(distance(a, b) <= 12)
})

test('decisionEnabled belongs to the innermost anchor that holds the review controls', () => {
  const card = (id, inner) => `<article class="prop" id="${id}"><h3>${id} 제안의 제목입니다</h3>${inner}</article>`
  const body = '<div class="top"><button>내 의견 내보내기</button><button>가져오기</button><button>초기화</button><button>공유 저장</button><button>인쇄</button></div>'
    + '<section id="g1"><h2>제안 묶음의 제목입니다</h2>'
    + card('P1', '<select class="fsel"><option value="">미정</option><option>반영</option><option>수정 후 반영</option><option>보류</option><option>미반영</option></select><textarea>의견</textarea>')
    + card('P2', '<button type="button">👍 찬성</button><button type="button">👎 반대</button>')
    + card('P3', '<span data-stance="agree">좋아요</span>')
    + card('P4', '<select><option>전체</option><option>회의 1</option></select><textarea>메모</textarea><button>찬성합니다 모두</button>')
    + '</section>'
  const result = prepareMaterial(page(body))
  const anchors = byKey(result)
  assert.equal(anchors.get('P1').decisionEnabled, true)
  assert.equal(anchors.get('P2').decisionEnabled, true)
  assert.equal(anchors.get('P3').decisionEnabled, true)
  assert.equal(anchors.get('P4').decisionEnabled, false)
  assert.equal(anchors.get('g1').decisionEnabled, false, '제안을 품은 절은 결정 항목이 아니다')
  // select 1 + data-stance 1 + 결정 항목 안 textarea 1 + 머리글 버튼 4
  assert.equal(result.report.nativeReviewControls, 7)
})

test('relations map #links to anchor keys, deduped, without self or enclosing links', () => {
  const rows = [1, 2, 3].map((n) => `<tr id="f-${n}"><td>F-0${n}</td><td>발견 ${n}번 <span id="inner-${n}">세부</span> 설명입니다</td></tr>`).join('')
  const body = `<section id="g"><h2>제안 묶음의 제목입니다</h2>`
    + ['A1', 'A2', 'A3'].map((id) => `<article class="prop" id="${id}"><h3>${id} 제안의 제목입니다</h3>`
      + (id === 'A1' ? '<a href="#f-1">F-01</a><a href="#f-1">again</a><a href="#inner-3">세부</a><a href="#A2">A2</a><a href="#nowhere">x</a><a href="#A1">self</a><a href="#g">up</a><a href="https://x.example/#f-2">out</a>' : '')
      + '</article>').join('')
    + `</section><section id="t"><h2>발견 사항 표의 제목</h2><table>${rows}</table></section>`
  const anchors = byKey(prepareMaterial(page(body)))
  assert.deepEqual(anchors.get('A1').relations, ['f-1', 'f-3', 'A2'])
  assert.deepEqual(anchors.get('A2').relations, [])
})

// ---------------------------------------------------------------------------
// 문자 인코딩·HTML 확인
// ---------------------------------------------------------------------------

test('charset sniffing: meta charset, http-equiv, BOM, then utf-8', () => {
  const eucKr = Buffer.concat([Buffer.from('<html><head><meta charset="euc-kr"></head><body>'), Buffer.from([0xc7, 0xd1]), Buffer.from('</body></html>')])
  const decoded = decodeMaterialBytes(eucKr)
  assert.equal(decoded.ok, true)
  assert.equal(decoded.charset, 'euc-kr')
  assert.ok(decoded.text.includes('<body>한</body>'))

  const httpEquiv = Buffer.concat([Buffer.from('<!DOCTYPE HTML><html><head><meta http-equiv="Content-Type" content="text/html; charset=ks_c_5601-1987">'), Buffer.from([0xc7, 0xd1])])
  assert.equal(decodeMaterialBytes(httpEquiv).charset, 'euc-kr')
  const cp949 = Buffer.from('<html><meta charset=CP949><body>x</body></html>')
  assert.equal(decodeMaterialBytes(cp949).charset, 'euc-kr')

  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<!DOCTYPE html><p>한</p>')])
  const withBom = decodeMaterialBytes(bom)
  assert.equal(withBom.charset, 'utf-8')
  assert.ok(withBom.text.startsWith('<!DOCTYPE html>'), 'BOM은 글에 남지 않는다')

  const utf16 = Buffer.from('\ufeff<html><body>한</body></html>', 'utf16le')
  const sixteen = decodeMaterialBytes(utf16)
  assert.equal(sixteen.charset, 'utf-16le')
  assert.ok(sixteen.text.includes('<body>한</body>'))

  assert.equal(decodeMaterialBytes(Buffer.from('<html><meta charset="utf-16"><body>한</body>')).charset, 'utf-8')
  assert.equal(decodeMaterialBytes(Buffer.from('<html><meta charset="klingon"><body>x</body>')).charset, 'utf-8')
  assert.equal(decodeMaterialBytes(new Uint8Array(Buffer.from('<body>한</body>'))).text, '<body>한</body>')
})

test('files that are not HTML are rejected no matter what the browser said', () => {
  assert.deepEqual(decodeMaterialBytes(Buffer.alloc(0)), { ok: false, reason: 'EMPTY', charset: 'utf-8', text: '' })
  assert.equal(decodeMaterialBytes(Buffer.from('  \n\t ')).reason, 'EMPTY')
  assert.equal(decodeMaterialBytes(Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >>')).reason, 'NOT_HTML')
  assert.equal(decodeMaterialBytes(Buffer.from('회의록 메모입니다. <b>굵게</b>')).reason, 'NOT_HTML')
  assert.equal(decodeMaterialBytes(Buffer.from(`${'a'.repeat(70 * 1024)}<html>`)).reason, 'NOT_HTML', '앞 64KB 안에서만 찾는다')
  assert.equal(decodeMaterialBytes(Buffer.from('<!DocType HTML><title>x</title>')).ok, true)
})

// ---------------------------------------------------------------------------
// 한도
// ---------------------------------------------------------------------------

test('limits are fixed and exceeding them throws coded errors with Korean messages', () => {
  assert.ok(Object.isFrozen(MATERIAL_LIMITS))
  assert.equal(MATERIAL_LIMITS.maxSourceBytes, 30 * 1024 * 1024)
  assert.equal(MATERIAL_LIMITS.maxRenderBytes, 3 * 1024 * 1024)
  assert.equal(MATERIAL_LIMITS.maxAnchors, 2000)

  const image = (bytes) => `<img src="data:image/jpeg;base64,${bytes.toString('base64')}">`
  const one = page(image(randomBytes(12000)))
  assert.throws(() => prepareMaterial(one, { limits: { maxAssetBytes: 10000 } }), (error) => error.code === 'MATERIAL_ASSET_TOO_LARGE' && /MB/.test(error.message))
  const two = page(image(randomBytes(9000)) + image(randomBytes(9000)))
  assert.throws(() => prepareMaterial(two, { limits: { maxAssets: 1 } }), (error) => error.code === 'MATERIAL_TOO_MANY_ASSETS' && /그림/.test(error.message))
  assert.doesNotThrow(() => prepareMaterial(two, { limits: { maxAssets: 2 } }))
  const bigSrcdoc = page(`<iframe srcdoc="${'&lt;p&gt;가나다&lt;/p&gt;'.repeat(3000)}"></iframe>`)
  assert.throws(() => prepareMaterial(bigSrcdoc, { limits: { maxAssetBytes: 20000 } }), { code: 'MATERIAL_ASSET_TOO_LARGE' })

  // 실제 한도: 그림을 떼어 낸 뒤에도 3MB가 넘는 본문
  const huge = page(`<p>${'가'.repeat(1_100_000)}</p>`)
  assert.throws(() => prepareMaterial(huge), (error) => error.code === 'MATERIAL_RENDER_TOO_LARGE' && /3\.0MB/.test(error.message))
  assert.throws(() => prepareMaterial(page('<p>x</p>'), { originalBytes: 31 * 1024 * 1024 }), { code: 'MATERIAL_SOURCE_TOO_LARGE' })
})

test('anchors are capped at maxAnchors in document order', () => {
  const items = Array.from({ length: 12 }, (_, n) => `<div data-itf-anchor="k${n}">항목 ${n}번의 본문은 충분히 깁니다</div>`).join('')
  const result = prepareMaterial(page(items), { limits: { maxAnchors: 5 } })
  assert.deepEqual(result.anchors.map((anchor) => anchor.key), ['k0', 'k1', 'k2', 'k3', 'k4'])
  assert.equal(result.report.truncatedAnchors, true)
  assert.equal(countOf(result.renderHtml, 'data-itf-a='), 5)
})

// ---------------------------------------------------------------------------
// 제목·자료 키·자료 속 의견·보고서
// ---------------------------------------------------------------------------

test('meta, embedded shared-state and the import report', () => {
  const head = '<title>회의 &amp; 자료</title><meta name="itf:material" content=" onlybook-plan "><meta name="ITF:version-note" content="' + '가'.repeat(300) + '">'
    + '<script id="shared-state" type="application/json">{"reviews":{"A1":[1]}}</script><script>var x = 1</script><script type="application/ld+json">{}</script>'
    + '<script type="module">1</script><script src="https://cdn.example.com/x.js"></script><link rel="stylesheet" href="//fonts.example.com/a.css">'
    + '<style>@import "https://x.example/y.css"; .a{background:url(https://img.example/a.png)} .b{background:url(local.png)}</style>'
  const body = '<svg><title>그림 설명</title></svg><img src="http://a.example/b.png"><a href="https://site.example">x</a><a href="#local">y</a><img srcset="https://a.example/1.png 1x, /local.png 2x">'
  const result = prepareMaterial(page(body, head), { charset: 'euc-kr' })
  assert.deepEqual(result.meta, { title: '회의 & 자료', materialKey: 'onlybook-plan', versionNote: '가'.repeat(200) })
  assert.deepEqual(result.embeddedFeedback, { sharedState: { reviews: { A1: [1] } } })
  assert.equal(result.report.scripts, 3, 'JSON·shared-state 스크립트는 세지 않는다')
  assert.equal(result.report.externalRefs, 7)
  assert.equal(result.report.charset, 'euc-kr')
  assert.equal(result.report.originalBytes, Buffer.byteLength(page(body, head)))

  const broken = prepareMaterial(page('<p>x</p>', '<script id="shared-state" type="application/json">{broken</script>'))
  assert.equal(broken.embeddedFeedback.sharedState, null)
  assert.deepEqual(prepareMaterial(page('<p>x</p>')).meta, { title: '', materialKey: null, versionNote: null })
  assert.equal(prepareMaterial(page('<p>x</p>')).report.charset, undefined)
})

test('materialSearchText joins titles and the start of each text, capped at 20,000 chars', () => {
  const text = materialSearchText([{ title: '제안 A1', text: `본문 ${'가'.repeat(300)}` }, { title: '행 BR-01', text: '짧은 본문' }, { title: '', text: '' }])
  assert.equal(text, `제안 A1 본문 ${'가'.repeat(197)}\n행 BR-01 짧은 본문`)
  const many = Array.from({ length: 500 }, (_, n) => ({ title: `항목 ${n}`, text: 'x'.repeat(500) }))
  assert.ok(materialSearchText(many).length <= 20000)
  assert.equal(materialSearchText(null), '')
})

// ---------------------------------------------------------------------------
// 실제 예시 자료(9.9MB) — 있을 때만
// ---------------------------------------------------------------------------

const SAMPLE = 'C:/Users/Sewon/Downloads/온리북_최종개편안_통합본.html'

test('real sample: 9.9MB material becomes a small render copy with anchors', { skip: !existsSync(SAMPLE) && '예시 자료 파일이 없음' }, () => {
  const buffer = readFileSync(SAMPLE)
  const started = performance.now()
  const decoded = decodeMaterialBytes(buffer)
  assert.equal(decoded.ok, true)
  const result = prepareMaterial(decoded.text, { charset: decoded.charset, originalBytes: buffer.length })
  const elapsed = performance.now() - started

  const kinds = {}
  for (const anchor of result.anchors) kinds[anchor.kind] = (kinds[anchor.kind] ?? 0) + 1
  const decisions = result.anchors.filter((anchor) => anchor.decisionEnabled).length
  console.log('[예시 자료]', JSON.stringify({
    ms: Math.round(elapsed),
    originalBytes: result.report.originalBytes,
    renderBytes: result.report.renderBytes,
    assets: result.assets.length,
    anchors: result.anchors.length,
    kinds,
    decisions,
    nativeReviewControls: result.report.nativeReviewControls,
  }))

  assert.ok(result.renderHtml.length < 3 * 1024 * 1024)
  // 예시 자료의 그림은 108곳이지만 서로 다른 그림은 26장이고, 32KB가 넘는 시안 글은 7편이다(같은 것은 한 번만 저장).
  assert.ok(result.assets.length >= 30, `assets ${result.assets.length}`)
  assert.ok(elapsed < 5000, `${elapsed}ms`)
  assert.ok(result.anchors.length >= 100 && result.anchors.length <= 2000, `anchors ${result.anchors.length}`)
  assert.ok(decisions >= 30, `decisions ${decisions}`)
  const shas = new Set(result.assets.map((asset) => asset.sha256))
  for (const match of result.renderHtml.matchAll(/itf-asset:([0-9a-f]{64})/g)) assert.ok(shas.has(match[1]), match[1])
  assert.ok(!/data:image\/[a-z+]+;base64,[A-Za-z0-9+/]{9000}/.test(result.renderHtml), '큰 그림은 모두 떼어 냈다')
  assert.equal(countOf(result.renderHtml, 'data-itf-a="'), result.anchors.length)
})

// ---------------------------------------------------------------------------
// 적대적 검토에서 찾은 결함 — 고치기 전에는 아래 시험이 실패했다
// ---------------------------------------------------------------------------

test('tag names that are Object.prototype keys are ordinary elements, not headings', () => {
  const doc = parseMaterialHtml('<h2>제목<constructor>안</constructor>뒤</h2><p>다음</p>')
  const [h2, custom, p] = doc.elements
  assert.equal(custom.parent, h2, '<constructor>가 열린 제목을 닫지 않는다')
  assert.equal(p.parent, doc.root)
  const result = prepareMaterial(page('<div><constructor>이것은 제목이 아닌 그냥 글입니다 충분히 길게</constructor></div>'))
  assert.deepEqual(result.anchors, [], '<constructor>는 절 제목이 아니다')
})

test('script escape states: after <!-- a nested <script> keeps the next </script> inside the script', () => {
  const inner = '<!-- document.write("<script src=x.js></script>"); var card = "<div data-itf-anchor=\'q\'>충분히 긴 가짜 항목 글입니다</div>"; -->'
  const source = page(`<script>${inner}</script><p>스크립트 뒤의 글입니다</p>`)
  const doc = parseMaterialHtml(source)
  assert.deepEqual(tags(doc), ['html', 'head', 'body', 'script', 'p'])
  const script = doc.elements.find((el) => el.tag === 'script')
  assert.equal(source.slice(script.children[0].start, script.children[0].end), inner)
  const result = prepareMaterial(source)
  assert.equal(result.renderHtml, source, '스크립트 글 속에 항목 표시를 끼워 넣지 않는다')
  assert.equal(result.anchors.length, 0)

  assert.deepEqual(tags(parseMaterialHtml('<script><!--<script></script><p>x</p>--></script><p>y</p>')), ['script', 'p'])
  // 이스케이프 상태라도 끝나는 자리는 브라우저와 같다
  assert.deepEqual(tags(parseMaterialHtml('<script><!-- a --></script><p>x</p>')), ['script', 'p'])
  assert.deepEqual(tags(parseMaterialHtml('<script>var s = "<!--"; </script><p>x</p>')), ['script', 'p'], '이스케이프 안의 </script>는 닫는다')
  assert.deepEqual(tags(parseMaterialHtml('<script><!--<script>--></script><p>x</p>')), ['script', 'p'], '--> 는 겹 이스케이프도 끝낸다')
  assert.deepEqual(tags(parseMaterialHtml('<script><!--<script></script></script><p>x</p>')), ['script', 'p'])
  assert.deepEqual(tags(parseMaterialHtml('<script><!--><p>x</p></script>')), ['script'], "'<!-->'는 곧바로 닫힌다")
})

test('data-itf-a written in the material itself is renamed, so only the app marks anchors', () => {
  const source = page('<p data-itf-a="a-e8bc163c82ee">심어 둔 가짜 표시</p><section id="s1" DATA-ITF-A="old"><h2>제목은 이렇습니다</h2><p>본문이 충분히 깁니다</p></section><i data-itf-a>값 없음</i>')
  const result = prepareMaterial(source)
  const marks = [...result.renderHtml.matchAll(/data-itf-a="([^"]*)"/g)].map((match) => match[1])
  assert.deepEqual(marks, result.anchors.map((anchor) => anchor.id))
  assert.equal(result.anchors.length, 1)
  assert.ok(result.renderHtml.includes('<p data-itf-a-old="a-e8bc163c82ee">'))
  assert.ok(result.renderHtml.includes(`<section data-itf-a="${result.anchors[0].id}" id="s1" data-itf-a-old="old">`))
  assert.ok(result.renderHtml.includes('<i data-itf-a-old>'))
})

test('deeply nested anchor candidates do not re-collect the same text once per ancestor', () => {
  const filler = '<i></i>'.repeat(100000)
  const long = '충분히 긴 본문 글을 여기에 씁니다'
  const cases = [
    [page(Array.from({ length: 500 }, (_, n) => `<section id="s${n}">${long}`).join('') + filler), ['s0', 's1', 's2']],
    [page(Array.from({ length: 500 }, (_, n) => `<section id="s${n}">`).join('') + filler + '짧다'), []],
    [page(Array.from({ length: 250 }, (_, n) => `<section id="s${n}"><div data-itf-anchor="k${n}">`).join('') + filler), ['k0', 'k1', 'k2']],
    [page('<table><tr><td>'.repeat(160) + filler), []],
    [page('<article data-itf-anchor="k">본문 본문 본문 본문<button><table><tr><td>'.repeat(160) + filler), ['k', 'k~2', 'k~3']],
  ]
  for (const [source, keys] of cases) {
    const started = performance.now()
    const result = prepareMaterial(source)
    const elapsed = performance.now() - started
    assert.ok(elapsed < 1500, `${Math.round(elapsed)}ms`)
    assert.deepEqual(result.anchors.map((anchor) => anchor.key), keys)
    assert.ok(result.anchors.every((anchor) => anchor.depth <= 3))
  }
})

test('end tags that cannot match are rejected without walking every open element each time', () => {
  for (const source of [
    `<span><table>${'<div>'.repeat(505)}${'</span>'.repeat(600000)}`,
    `<p><button>${'<span>'.repeat(505)}${'<div></div>'.repeat(200000)}`,
  ]) {
    const started = performance.now()
    parseMaterialHtml(source)
    const elapsed = performance.now() - started
    assert.ok(elapsed < 900, `${Math.round(elapsed)}ms`)
  }
  // 범위 규칙은 그대로다: 버튼 안의 </p>는 바깥 p를 닫지 않고, 표 칸 안의 </span>은 표 밖 span을 닫지 않는다.
  const doc = parseMaterialHtml('<p>a<button>b</p>c</button>d</p><span><table><tr><td></span>e</td></tr></table>f</span><i>g</i>')
  const find = (tag) => doc.elements.find((el) => el.tag === tag)
  assert.equal(find('button').parent, find('p'))
  assert.equal(doc.text(find('button')), 'bc')
  assert.equal(find('table').parent, find('span'))
  assert.equal(doc.text(find('td')), 'e')
  assert.equal(find('i').parent, doc.root)
})

test('charset sniffing trusts only <meta charset> and http-equiv content-type, not charset= written elsewhere', () => {
  const utf8 = (head) => Buffer.from(`<!doctype html><html><head>${head}</head><body>한글</body></html>`)
  for (const head of [
    '<meta name="description" content="이 문서는 charset=euc-kr 이야기입니다"><meta charset="utf-8">',
    '<!-- <meta charset="euc-kr"> 예전 선언 -->',
    '<meta data-charset="euc-kr" name="x">',
    '<link title="<meta charset=euc-kr>" rel="x">',
  ]) {
    const decoded = decodeMaterialBytes(utf8(head))
    assert.equal(decoded.charset, 'utf-8', head)
    assert.ok(decoded.text.includes('<body>한글</body>'), head)
  }
  const eucKr = Buffer.concat([Buffer.from('<!-- 주석 --><html><head><META HTTP-EQUIV=content-type CONTENT="text/html;charset=euc-kr"></head><body>'), Buffer.from([0xc7, 0xd1]), Buffer.from('</body></html>')])
  const decoded = decodeMaterialBytes(eucKr)
  assert.equal(decoded.charset, 'euc-kr', '진짜 선언은 그대로 따른다')
  assert.ok(decoded.text.includes('<body>한</body>'))
})

test('CSS comments and strings do not stop the url() scan in <style> blocks', () => {
  const png = randomBytes(9000)
  const uri = `data:image/png;base64,${png.toString('base64')}`
  for (const sheet of [
    `/* don't use url(' here */ .a{background:url(${uri})}`,
    `/* url(" */ .a{background:url(${uri})} /* " */`,
    `.q{content:"url("} .a{background:url('${uri}')}`,
    `.a{background:url("x.png")} .b{font-family:"Noto Sans"} .c{background:url("${uri}")}`,
  ]) {
    const result = prepareMaterial(page('<p>x</p>', `<style>${sheet}</style>`))
    assert.equal(result.assets.length, 1, sheet.slice(0, 40))
    assert.ok(result.renderHtml.includes(`itf-asset:${sha256(png)}`))
    assert.ok(!result.renderHtml.includes(uri))
  }
})

test('the #fragment of a data: URI is not part of the extracted bytes (browsers do not read it)', () => {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg'>${"<rect width='1' height='1'/>".repeat(400)}</svg>`
  const png = randomBytes(9000)
  const source = page(`<img src="data:image/svg+xml,${svg}#view"><img src="data:image/png;base64,${png.toString('base64')}#ZGVm">`)
  const result = prepareMaterial(source, null)
  const bySha = new Map(result.assets.map((asset) => [asset.sha256, asset]))
  assert.equal(result.assets.length, 2)
  assert.equal(bySha.get(sha256(Buffer.from(svg)))?.bytes.toString('utf8'), svg)
  assert.ok(Buffer.compare(bySha.get(sha256(png))?.bytes ?? Buffer.alloc(0), png) === 0, "'#' 뒤의 글자를 base64로 읽어 붙이지 않는다")
})

test('patching never changes how the page parses: seeded mutations of a synthetic material', () => {
  const imageA = `data:image/png;base64,${randomBytes(9000).toString('base64')}`
  const imageB = `data:image/jpeg;base64,${randomBytes(9500).toString('base64')}`
  const skeleton = '<!doctype html><html><head><title>퍼즈 자료</title><style>.hero{background:url(@A@)} /* url(" */ .x{color:red}</style></head><body>'
    + '<header><h1>머리글 제목은 항목이 아닙니다</h1></header>'
    + '<section id="s-a"><h2>첫 절의 제목입니다</h2><p>첫 절의 본문은 충분히 깁니다.</p>'
    + ['A1', 'A2', 'A3'].map((id) => `<article class="prop" id="${id}"><h3>${id} 제안의 제목입니다</h3><select><option>반영</option><option>보류</option></select><a href="#f-2">F-02</a>@B@</article>`).join('')
    + '</section><section id="s-b"><h2>발견 사항 표입니다</h2><table><tbody>'
    + [1, 2, 3, 4].map((n) => `<tr><td>F-0${n}</td><td id="f-${n}">발견 ${n}번의 설명은 충분히 깁니다</td></tr>`).join('')
    + '</tbody></table></section><div><h2>이름 없는 절의 제목</h2><p>이름 없는 절의 본문 글입니다.</p><h3>하위 절 제목입니다</h3><p>하위 절 본문 글입니다 충분히.</p></div>'
    + '<script>var s = "</div><p>"; if (a < b) {}</script><footer>바닥글</footer></body></html>'
  const junk = ['<', '>', '"', "'", '<!--', '-->', '</script>', '<script>', '</div>', '<div>', '<p>', '</td>', '<tr>', '<table>', '</table>', '<h2>', '</h2>', '<section id="z">', '=', '/', '<svg>', '</svg>', '&amp;', '<textarea>', '<li>', '<template>', '<!-->', '<style>', '</style>', ' data-itf-a="a-0"']
  const originals = new Map([[sha256(Buffer.from(imageA.slice(22), 'base64')), imageA], [sha256(Buffer.from(imageB.slice(23), 'base64')), imageB]])
  let seed = 20260918
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  for (let round = 0; round < 120; round += 1) {
    let text = skeleton
    const edits = 1 + Math.floor(random() * 6)
    for (let k = 0; k < edits; k += 1) {
      const at = Math.floor(random() * text.length)
      text = random() < 0.75 ? text.slice(0, at) + junk[Math.floor(random() * junk.length)] + text.slice(at) : text.slice(0, at) + text.slice(at + Math.floor(random() * 80))
    }
    const source = text.replaceAll('@A@', imageA).replaceAll('@B@', `<img src="${imageB}">`)
    const result = prepareMaterial(source)
    const before = parseMaterialHtml(source)
    const after = parseMaterialHtml(result.renderHtml)
    assert.deepEqual(tags(after), tags(before), `round ${round}`)
    assert.deepEqual(after.elements.map((el) => el.parent.index), before.elements.map((el) => el.parent.index), `round ${round}`)
    const marked = after.elements.filter((el) => el.attrs.some((attr) => attr.name === 'data-itf-a')).map((el) => after.attr(el, 'data-itf-a'))
    assert.deepEqual(marked, result.anchors.map((anchor) => anchor.id), `round ${round}: 항목마다 표시 하나, 다른 곳에는 없음`)
    const byId = new Map(result.anchors.map((anchor) => [anchor.id, anchor]))
    for (const anchor of result.anchors) {
      assert.ok(anchor.depth >= 1 && anchor.depth <= 3)
      assert.equal(anchor.parentId ? byId.get(anchor.parentId).depth + 1 : 1, anchor.depth)
    }
    // 표시를 걷어 내고 그림 자리를 원래 값으로 되돌리면 원본과 한 글자도 다르지 않다(되돌릴 수 있는 경우만).
    const shas = [...result.renderHtml.matchAll(/itf-asset:([0-9a-f]{64})/g)].map((match) => match[1])
    if (shas.every((sha) => originals.has(sha))) {
      const restored = result.renderHtml
        .replace(/ data-itf-a="a-[0-9a-f]{12,}"/g, '')
        .replaceAll('data-itf-a-old', 'data-itf-a')
        .replace(/itf-asset:([0-9a-f]{64})/g, (_, sha) => originals.get(sha))
      assert.equal(restored, source, `round ${round}`)
    }
  }
})

test('항목 글: 덩어리는 줄을 바꾸고, 표의 칸과 붙은 칩은 띄어 쓰고, 글자에 붙은 강조는 그대로 붙는다 — 지문은 줄 바꿈에 흔들리지 않는다', () => {
  const body = '<section id="s1"><h2>결정 항목 하나의 제목</h2>'
    + '<p>관련 과제 <span class="chip">C-02</span><span class="chip">C-05</span><span class="chip">PC-15</span></p>'
    + '<p><strong>핵심</strong>은 이것입니다.</p>'
    + '<table><tr><td>BR-01</td><td>첫 칸 설명</td><td>P0</td></tr></table>'
    + '<ul><li>하나</li><li>둘</li></ul></section>'
  const anchor = byKey(prepareMaterial(page(body))).get('s1')
  assert.equal(anchor.text, '결정 항목 하나의 제목\n관련 과제 C-02 C-05 PC-15\n핵심은 이것입니다.\nBR-01 첫 칸 설명 P0\n하나\n둘')
  const sameWords = byKey(prepareMaterial(page(body.replace('<ul><li>하나</li><li>둘</li></ul>', '<p>하나 둘</p>')))).get('s1')
  assert.notEqual(sameWords.text, anchor.text)
  assert.equal(sameWords.textHash, anchor.textHash, '줄 바꿈만 달라진 판은 같은 글로 본다')
  assert.equal(sameWords.simhash, anchor.simhash)
})

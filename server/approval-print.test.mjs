import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createApp } from './app.mjs'
import { escapeApprovalHtml, formatKrw, renderApprovalMarkdown, renderApprovalPrintHtml } from './approval-print.mjs'
import { withServer } from './test-server.mjs'

/**
 * 인쇄물과 증빙 본문 — 종이에 무엇이 찍히는가.
 *
 * 이 파일은 서버를 거의 띄우지 않는다. 인쇄 모듈이 순수하기 때문에 「대결로 결재한 사람의 이름이
 * 종이에 나오는가」 같은 질문을 값 하나로 물을 수 있다. 서버가 필요한 것은 둘뿐이다 —
 * content-type 과 「못 읽는 사람에게는 404」.
 */

const TENANT = 'TENANT-SUNSEA'
const ADMIN = { id: 'USR-SUNSEA-ADMIN', email: 'admin@sunsea.co.kr' }
const OH = { id: 'USR-SUNSEA-OH', email: 'taesik.oh@sunsea.co.kr' }
const SEO = { id: 'USR-SUNSEA-SEO', email: 'donghyun.seo@sunsea.co.kr' }
const YOON = { id: 'USR-SUNSEA-YOON', email: 'seojin.yoon@sunsea.co.kr' }

const FORM = {
  recordType: 'form', id: 'AFM-PRINT-01', name: '지출결의서', kind: '지출결의', description: '',
  fields: [
    { key: 'spent_on', label: '지출일', type: 'date', required: true, options: [], help: '', position: 0 },
    { key: 'vendor', label: '거래처', type: 'text', required: true, options: [], help: '', position: 1 },
    { key: 'amount', label: '금액', type: 'money', required: true, options: [], help: '', position: 2 },
  ],
  defaultLine: [], ccIds: [], amountFieldKey: 'amount', evidenceCategory: '경비',
  active: true, version: 1, createdById: ADMIN.id, createdByName: '김서원',
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', updatedById: ADMIN.id,
}

/**
 * 2단계 결재선. 1단계는 본인(서동현)이 승인했고, 2단계는 **윤서진의 대결자인 오태식**이 반려했다.
 * 그래서 이 한 문서로 「결재 이력 표 · 대결 표기 · 반려 사유」 셋을 함께 잰다.
 */
const DOCUMENT = {
  id: 'APD-PRINT-01', formId: FORM.id, formName: FORM.name, formVersion: 1, kind: '지출결의',
  title: '<b>evil</b> 9월 원부자재 대금', values: { spent_on: '2026-09-02', vendor: '동해수산', amount: 1_240_000 },
  attachments: ['DOC-PRINT-RECEIPT'],
  line: [
    { step: 1, mode: 'sequential', approvers: [{ accountId: SEO.id, name: '서동현', decision: 'approved', decidedAt: '2026-09-03T01:00:00.000Z', decidedById: SEO.id, comment: '확인했습니다', delegateOf: null }] },
    { step: 2, mode: 'sequential', approvers: [{ accountId: YOON.id, name: '윤서진', decision: 'rejected', decidedAt: '2026-09-03T02:00:00.000Z', decidedById: OH.id, comment: '', delegateOf: YOON.id }] },
  ],
  ccIds: [], drafterId: ADMIN.id, drafterName: '김서원', status: '반려', currentStep: 2,
  rejectionReason: '견적서를 함께 올려 주세요.', evidenceId: null, posting: null,
  history: [
    { at: '2026-09-03T01:00:00.000Z', actorId: SEO.id, actorName: '서동현', action: '1단계 승인', comment: '확인했습니다', delegateOf: null },
    { at: '2026-09-03T02:00:00.000Z', actorId: OH.id, actorName: '오태식', action: '반려', comment: '견적서를 함께 올려 주세요.', delegateOf: YOON.id },
  ],
  version: 4, clientRequestId: '', createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-03T02:00:00.000Z',
  submittedAt: '2026-09-02T01:00:00.000Z', completedAt: '2026-09-03T02:00:00.000Z',
}

const html = () => renderApprovalPrintHtml({
  document: DOCUMENT, form: FORM, tenantName: '햇살바다', printedAt: '2026-09-04T05:00:00.000Z',
  attachments: [{ id: 'DOC-PRINT-RECEIPT', name: '영수증.pdf' }],
  names: new Map([[SEO.id, '서동현'], [YOON.id, '윤서진'], [OH.id, '오태식']]),
})

test('1. 이력의 각 줄(단계·결재자·결정·시각)이 인쇄물에 그대로 있다', () => {
  const page = html()
  // 시각은 한국 시간이다(01:00Z → 10:00 KST). 시험 13이 그 사실 자체를 잰다.
  for (const fragment of ['1단계 · 순차', '2단계 · 순차', '서동현', '승인', '반려', '2026-09-03 10:00', '2026-09-03 11:00', '확인했습니다']) {
    assert.ok(page.includes(fragment), `인쇄물에 '${fragment}'가 없다`)
  }
  // 표 머리 다섯 칸 + 결재선 두 줄. 이력이 통째로 빠지면 이 단언이 먼저 빨개진다.
  assert.equal(page.match(/<tr>/g)?.length, 3)
})

test('2. 대결로 누른 사람이 「오태식(대결 윤서진)」으로 찍힌다 — decidedById 하나가 근거다', () => {
  assert.match(html(), /오태식\(대결 윤서진\)/)
  // decidedById 가 저장에서 떨어지면 종이에는 결재하지 않은 사람의 이름만 남는다.
  const stripped = { ...DOCUMENT, line: DOCUMENT.line.map((step) => ({ ...step, approvers: step.approvers.map(({ decidedById: _drop, ...rest }) => rest) })) }
  const page = renderApprovalPrintHtml({ document: stripped, form: FORM, tenantName: '햇살바다', printedAt: '2026-09-04T05:00:00.000Z' })
  assert.doesNotMatch(page, /대결/, '이 시험이 잠그는 것은 decidedById 가 살아 있을 때만 대결이 찍힌다는 사실이다')
})

test('3. 반려 사유가 인쇄물에 있고, 승인 문서에는 그 칸이 아예 없다', () => {
  assert.match(html(), /반려 사유/)
  assert.ok(html().includes('견적서를 함께 올려 주세요.'))
  const approved = renderApprovalPrintHtml({ document: { ...DOCUMENT, status: '승인' }, form: FORM, tenantName: '햇살바다', printedAt: '2026-09-04T05:00:00.000Z' })
  assert.doesNotMatch(approved, /<blockquote/)
  assert.ok(!approved.includes('견적서를 함께 올려 주세요.'))
})

test('4. <script>가 0회이고 외부 리소스를 부르지 않는다', () => {
  const page = renderApprovalPrintHtml({
    document: { ...DOCUMENT, title: '<script>alert(1)</script>', rejectionReason: '</style><script>x</script>' },
    form: FORM, tenantName: '<script>bad</script>', printedAt: '2026-09-04T05:00:00.000Z',
  })
  assert.equal(page.match(/<script/gi)?.length ?? 0, 0)
  assert.doesNotMatch(page, /https?:\/\//)
  assert.doesNotMatch(page, /<link/i)
})

test('5. 제목의 <b>evil</b>이 &lt;b&gt;로 이스케이프된다', () => {
  const page = html()
  assert.ok(page.includes('&lt;b&gt;evil&lt;/b&gt;'))
  assert.ok(!page.includes('<b>evil</b>'))
  assert.equal(escapeApprovalHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;')
})

test('6. @page와 @media print가 있고 금액이 ko-KR 서식으로 찍힌다', () => {
  const page = html()
  assert.match(page, /@page \{ size:A4/)
  assert.match(page, /@media print/)
  assert.ok(page.includes('1,240,000원'), '금액 칸이 formatKrw 를 지나야 한다')
  assert.equal(formatKrw(0), '0원')
  // 수가 아닌 값에 「0원」을 만들어 내지 않는다 — 없는 사실을 종이에 찍는 셈이다.
  assert.equal(formatKrw(null), '')
  assert.equal(formatKrw(Number.NaN), '')
})

test('7. 인쇄 CSS 안의 모든 #hex 가 src/tokens.css 에 있다 — 서버는 verify-design-tokens 범위 밖이다', () => {
  const tokens = readFileSync(fileURLToPath(new URL('../src/tokens.css', import.meta.url)), 'utf8').toLowerCase()
  const page = html()
  const style = page.slice(page.indexOf('<style>'), page.indexOf('</style>'))
  const hexes = [...new Set((style.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).map((hex) => hex.toLowerCase()))]
  assert.ok(hexes.length >= 3, `인쇄 CSS에서 색을 하나도 못 찾았다 — 정규식이 낡았다 (${hexes.length}개)`)
  for (const hex of hexes) assert.ok(tokens.includes(hex), `인쇄 CSS의 ${hex} 가 src/tokens.css 에 없다`)
})

test('8. 증빙 마크다운은 인쇄물과 같은 사실을 담는다 — 표의 파이프는 깨지지 않는다', () => {
  const body = renderApprovalMarkdown({
    document: { ...DOCUMENT, history: [{ ...DOCUMENT.history[0], comment: 'a|b' }] },
    form: FORM, tenantName: '햇살바다',
    attachments: [{ id: 'DOC-PRINT-RECEIPT', name: '영수증.pdf' }],
    names: new Map([[SEO.id, '서동현'], [YOON.id, '윤서진'], [OH.id, '오태식']]),
  })
  for (const fragment of ['# <b>evil</b> 9월 원부자재 대금', '햇살바다', 'APD-PRINT-01', '1,240,000원', '영수증.pdf', '오태식(대결 윤서진)', '견적서를 함께 올려 주세요.']) {
    assert.ok(body.includes(fragment), `증빙 본문에 '${fragment}'가 없다`)
  }
  // 표 줄마다 칸이 다섯이어야 한다. 의견에 든 파이프를 그대로 두면 그 줄만 칸이 늘어 표가 깨진다.
  const rows = body.split('\n').filter((line) => line.startsWith('| '))
  assert.ok(rows.length >= 4)
  for (const row of rows) assert.equal(row.split(/(?<!\\)\|/).length, 7, `표 한 줄의 칸 수가 다르다: ${row}`)
})

test('9. 인쇄 라우트는 text/html 로 나가고, 못 읽는 사람에게는 404다', async () => {
  const store = {
    version: 2,
    tenants: {
      [TENANT]: {
        'approval-forms': { data: [FORM], updatedAt: '2026-09-01T00:00:00.000Z' },
        'approval-documents': { data: [DOCUMENT], updatedAt: '2026-09-03T02:00:00.000Z' },
      },
    },
    platform: {}, accountApprovals: {}, accountCredentials: {}, invitedAccounts: [], passwordResetRequests: [],
  }
  const app = createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {} })
  await withServer(app, async (origin) => {
    const login = async (email) => {
      const response = await fetch(`${origin}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace: 'tenant', email, password: 'demo1234' }),
      })
      assert.equal(response.status, 200, email)
      const account = (await response.json()).account
      return { cookie: response.headers.get('set-cookie') ?? '', identity: `${account.tenantId}:${account.id}` }
    }
    const get = (session) => fetch(`${origin}/api/approval-documents/APD-PRINT-01/print`, {
      headers: { cookie: session.cookie, 'x-workspace-identity': session.identity },
    })

    const drafter = await get(await login(ADMIN.email))
    assert.equal(drafter.status, 200)
    assert.equal(drafter.headers.get('content-type'), 'text/html; charset=utf-8')
    const page = await drafter.text()
    assert.ok(page.startsWith('<!doctype html>'))
    assert.ok(page.includes('PDF로 저장'), 'PDF 를 어떻게 만드는지 문서 자신이 말해야 한다')

    // 결재선에도 참조에도 없는 직원에게는 「없는 문서」와 같은 답이다(존재 오라클 차단).
    const stranger = await get(await login('jihyun.park@sunsea.co.kr'))
    assert.equal(stranger.status, 404)
    assert.equal((await stranger.json()).error.code, 'APPROVAL_DOCUMENT_NOT_FOUND')
    // 대결로 눌러 준 사람은 대결 기간이 끝난 뒤에도 자기가 결재한 문서를 본다(decidedById).
    const delegate = await get(await login(OH.email))
    assert.equal(delegate.status, 200, '대결로 결재한 사람이 자기가 누른 문서를 못 본다')
  })
})

/**
 * 「첨부」 **항목**(type:'attachment')으로 붙인 파일. 씨앗 지출결의서의 「영수증」이 이 모양이고,
 * 첨부 배열은 비어 있다. 무엇이 첨부인지는 라우트가 attachmentIdsOf 로 이미 답했으므로
 * 렌더러는 그 목록을 받아 이름을 붙일 뿐, 두 번째로 판정하지 않는다.
 */
const FIELD_FORM = {
  ...FORM,
  id: 'AFM-PRINT-02',
  fields: [...FORM.fields, { key: 'receipt', label: '영수증', type: 'attachment', required: false, options: [], help: '', position: 3 }],
}
const FIELD_DOCUMENT = {
  ...DOCUMENT,
  id: 'APD-PRINT-02', formId: FIELD_FORM.id, title: '항목으로 붙인 영수증',
  attachments: [],
  values: { ...DOCUMENT.values, receipt: 'DOC-PRINT-RECEIPT' },
}

test('10. 「첨부」 항목 값으로 붙인 파일도 첨부 구역에 파일 이름으로 나온다 — 이름표를 만들어 놓고 버리지 않는다', async () => {
  const passed = { attachments: [{ id: 'DOC-PRINT-RECEIPT', name: '영수증.pdf' }], attachmentIds: ['DOC-PRINT-RECEIPT'] }
  const body = renderApprovalMarkdown({ document: FIELD_DOCUMENT, form: FIELD_FORM, tenantName: '햇살바다', names: new Map(), ...passed })
  assert.ok(body.includes('## 첨부'), '증빙 본문에 첨부 절이 없다 — 세무사가 받는 것은 이 마크다운이다')
  assert.ok(body.includes('- 영수증.pdf'), `증빙 본문에 첨부 파일 이름이 없다\n${body}`)
  const page = renderApprovalPrintHtml({ document: FIELD_DOCUMENT, form: FIELD_FORM, tenantName: '햇살바다', printedAt: '2026-09-04T05:00:00.000Z', names: new Map(), ...passed })
  assert.ok(page.includes('영수증.pdf'), '인쇄물의 첨부 구역에 파일 이름이 없다')

  // 자료실에서 이름을 못 찾은 id 는 지금까지처럼 id 그대로 찍는다 — 붙어 있다는 사실 자체는 남는다.
  const orphan = renderApprovalMarkdown({ document: FIELD_DOCUMENT, form: FIELD_FORM, tenantName: '햇살바다', attachments: [], attachmentIds: ['DOC-PRINT-RECEIPT'], names: new Map() })
  assert.ok(orphan.includes('- DOC-PRINT-RECEIPT'))

  // 돌아가는 앱으로 같은 사실을 잰다(규칙 11). 인쇄 라우트가 목록의 원천이다.
  const store = {
    version: 2,
    tenants: {
      [TENANT]: {
        'approval-forms': { data: [FIELD_FORM], updatedAt: '2026-09-01T00:00:00.000Z' },
        'approval-documents': { data: [FIELD_DOCUMENT], updatedAt: '2026-09-03T02:00:00.000Z' },
        'company-documents': {
          data: [{
            id: 'DOC-PRINT-RECEIPT', tenantId: TENANT, name: '영수증-2026-09-02.pdf', originalName: '영수증-2026-09-02.pdf',
            mime: 'application/pdf', size: 12, category: '공통자료', visibility: 'all', departments: [], allowedUserIds: [],
            tags: [], summary: '', uploadedAt: '2026-09-01T00:00:00.000Z', uploadedById: ADMIN.id, uploadedByName: '김서원', storage: 'local',
          }],
          updatedAt: '2026-09-01T00:00:00.000Z',
        },
      },
    },
    platform: {}, accountApprovals: {}, accountCredentials: {}, invitedAccounts: [], passwordResetRequests: [],
  }
  const app = createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {} })
  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: 'tenant', email: ADMIN.email, password: 'demo1234' }),
    })
    assert.equal(response.status, 200)
    const account = (await response.json()).account
    const printed = await fetch(`${origin}/api/approval-documents/APD-PRINT-02/print`, {
      headers: { cookie: response.headers.get('set-cookie') ?? '', 'x-workspace-identity': `${account.tenantId}:${account.id}` },
    })
    assert.equal(printed.status, 200)
    const html = await printed.text()
    assert.ok(html.includes('영수증-2026-09-02.pdf'), '인쇄 라우트가 「첨부」 항목의 파일 이름을 찍지 않았다')
  })
})

/**
 * 「첨부」 타입 항목의 **값 칸**도 파일 이름이다.
 *
 * 같은 문서 안에서 첨부 절은 이름을 쓰고 항목 표는 내부 id 를 쓰면, 한 사실을 한 장의 종이가
 * 두 가지로 말한다. 하필 씨앗 양식(지출결의서)의 「영수증」이 그 타입이라 대표 경로가 전부 이 모양이고,
 * 증빙 마크다운은 회사 밖 세무사에게 나간다.
 */
test('11. 「첨부」 항목의 값 칸도 파일 이름으로 찍힌다 — 첨부 절과 항목 표가 같은 말을 한다', async () => {
  const passed = { attachments: [{ id: 'DOC-PRINT-RECEIPT', name: '영수증.pdf' }], attachmentIds: ['DOC-PRINT-RECEIPT'] }
  const body = renderApprovalMarkdown({ document: FIELD_DOCUMENT, form: FIELD_FORM, tenantName: '햇살바다', names: new Map(), ...passed })
  assert.ok(body.includes('- 영수증: 영수증.pdf'), `증빙 마크다운의 항목 줄이 내부 id 로 찍혔다\n${body}`)
  assert.ok(!body.includes('- 영수증: DOC-PRINT-RECEIPT'), '항목 줄에 내부 id 가 남았다')

  const page = renderApprovalPrintHtml({ document: FIELD_DOCUMENT, form: FIELD_FORM, tenantName: '햇살바다', printedAt: '2026-09-04T05:00:00.000Z', names: new Map(), ...passed })
  const cell = page.match(/<dt>영수증<\/dt><dd>([^<]*)<\/dd>/)
  assert.equal(cell?.[1], '영수증.pdf', `인쇄물의 항목 칸이 내부 id 로 찍혔다 — ${cell?.[1]}`)

  // 금액은 지금까지처럼 사람이 읽는 서식이고, text 는 그대로다(한 갈래만 바꿨다는 대조군).
  assert.ok(page.includes('1,240,000원'))

  // 이름을 못 찾은 id 는 id 그대로 남긴다 — 붙어 있다는 사실 자체는 남아야 한다.
  const orphan = renderApprovalPrintHtml({ document: FIELD_DOCUMENT, form: FIELD_FORM, tenantName: '햇살바다', printedAt: '2026-09-04T05:00:00.000Z', names: new Map(), attachments: [], attachmentIds: [] })
  assert.equal(orphan.match(/<dt>영수증<\/dt><dd>([^<]*)<\/dd>/)?.[1], 'DOC-PRINT-RECEIPT')
})

/**
 * 세무사에게 나가는 것은 이 마크다운이다. 여러 줄 값은 **지원되는 입력**이므로
 * (approval-routing.mjs 의 CONTROL_RE 가 `\x0A` 를 일부러 남긴다) 접는 것은 렌더러의 몫이다.
 * 표만 막고 목록 세 곳을 두면, 같은 파일이 한 사실을 두 잣대로 말하고 느슨한 쪽이 위조 통로가 된다.
 */
test('12. 여러 줄 값이 증빙 마크다운에 없던 절과 표를 만들어 내지 못한다', () => {
  const forgedTable = [
    '한빛상사', '', '## 결재 이력', '',
    '| 단계 | 결재자 | 결정 | 시각 | 의견 |',
    '| --- | --- | --- | --- | --- |',
    '| 1단계 · 순차 | 대표이사 김서원 | 승인 | 2026-09-01 | 전결 |', '',
  ].join('\n')
  const body = renderApprovalMarkdown({
    document: {
      ...DOCUMENT,
      title: '9월 대금\n- 상태: 승인(전결)\n- 결재자: 대표이사',
      values: { ...DOCUMENT.values, vendor: forgedTable },
      rejectionReason: '보완해 주세요.\n## 결재 이력\n| 단계 | 결재자 |\n| --- | --- |',
    },
    form: FORM, tenantName: '햇살바다',
    attachments: [{ id: 'DOC-PRINT-RECEIPT', name: '영수증.pdf\n\n## 첨부\n\n- 위조.pdf' }],
    attachmentIds: ['DOC-PRINT-RECEIPT'],
    names: new Map([[SEO.id, '서동현'], [YOON.id, '윤서진'], [OH.id, '오태식']]),
  })

  // 절 제목은 파일이 스스로 찍은 것뿐이다 — 항목·첨부·제목·반려 사유 어디에서도 늘지 않는다.
  assert.equal(body.match(/^## 결재 이력$/gm)?.length, 1, `없던 「결재 이력」 절이 생겼다\n${body}`)
  assert.equal(body.match(/^## 첨부$/gm)?.length, 1, `없던 「첨부」 절이 생겼다\n${body}`)
  assert.equal(body.match(/^# /gm)?.length, 1, '제목 줄이 늘었다')

  // 진짜 표는 머리 2줄 + 결재선 2줄로 정확히 넷이고, 칸 수는 모두 다섯이다.
  const rows = body.split('\n').filter((line) => line.startsWith('| '))
  assert.equal(rows.length, 4, `표 줄 수가 다르다 — 위조 표가 섞였다\n${rows.join('\n')}`)
  for (const row of rows) assert.equal(row.split(/(?<!\\)\|/).length, 7, `표 한 줄의 칸 수가 다르다: ${row}`)

  // 값 자체는 버리지 않는다. 한 줄로 접고 파이프만 escape 한다.
  assert.ok(body.includes('- 거래처: 한빛상사 ## 결재 이력'), `거래처 값이 통째로 사라졌다\n${body}`)
  assert.ok(body.includes('- 영수증.pdf ## 첨부 - 위조.pdf'), `첨부 이름이 한 줄로 접히지 않았다\n${body}`)
  assert.ok(body.startsWith('# 9월 대금 - 상태: 승인(전결) - 결재자: 대표이사\n'), `제목 줄이 여러 줄로 새어 나갔다\n${body}`)
})

/**
 * 증빙 요약·세무 태그는 `billingDate`(KST)로 만들어진다. 시각 칸만 UTC ISO 로 두면
 * **한 파일이 두 날짜를 말한다** — 요약은 「2026-09-04 … 승인」, 이력 표는 「…T23:30:00.000Z」.
 */
test('13. 시각은 인쇄물·증빙 모두 한국 시간이고, 그 사실을 문서 자신이 말한다', () => {
  const morning = {
    ...DOCUMENT,
    status: '승인',
    submittedAt: '2026-09-03T22:00:00.000Z',    // KST 2026-09-04 07:00
    completedAt: '2026-09-03T23:30:00.000Z',    // KST 2026-09-04 08:30
    line: [{
      step: 1, mode: 'sequential',
      approvers: [{ accountId: SEO.id, name: '서동현', decision: 'approved', decidedAt: '2026-09-03T23:30:00.000Z', decidedById: SEO.id, comment: '', delegateOf: null }],
    }],
  }
  const body = renderApprovalMarkdown({ document: morning, form: FORM, tenantName: '햇살바다', names: new Map() })
  assert.ok(body.includes('- 상신: 2026-09-04 07:00'), `상신 시각이 KST 가 아니다\n${body}`)
  assert.ok(body.includes('- 완료: 2026-09-04 08:30'), `완료 시각이 KST 가 아니다\n${body}`)
  assert.ok(body.includes('| 2026-09-04 08:30 |'), `이력 표의 시각이 KST 가 아니다\n${body}`)
  assert.doesNotMatch(body, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, 'UTC ISO 문자열이 증빙에 그대로 남았다')
  assert.ok(body.includes('한국 표준시(KST)'), '어떤 시간대인지 문서 자신이 말해야 한다')

  const page = renderApprovalPrintHtml({ document: morning, form: FORM, tenantName: '햇살바다', printedAt: '2026-09-03T23:40:00.000Z', names: new Map() })
  assert.ok(page.includes('상신 2026-09-04 07:00'), `인쇄물 머리의 상신 시각이 KST 가 아니다`)
  assert.ok(page.includes('<td>2026-09-04 08:30</td>'), '인쇄물 이력 표의 시각이 KST 가 아니다')
  assert.ok(page.includes('2026-09-04 08:40 출력'), '인쇄 시각이 KST 가 아니다')
  assert.doesNotMatch(page, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, 'UTC ISO 문자열이 인쇄물에 그대로 남았다')
  assert.ok(page.includes('한국 표준시(KST)'), '어떤 시간대인지 인쇄물 자신이 말해야 한다')
})

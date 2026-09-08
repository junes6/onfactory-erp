/**
 * 결재 문서를 사람이 읽는 두 가지 모양으로 찍는다 — 인쇄용 HTML과 증빙용 마크다운.
 *
 * **의존성 0**이다. 저장소도, 계정 목록도, 시계도 읽지 않는다. 넘겨받은 문서·양식·이름표만 읽는다.
 * 그래야 「무엇이 종이에 찍히는가」를 서버를 띄우지 않고 값으로 확인할 수 있고, 같은 정보를
 * 증빙 파일(마크다운)과 인쇄물(HTML)이 서로 어긋나지 않게 낼 수 있다.
 *
 * 왜 PDF 라이브러리를 넣지 않는가: 브라우저의 인쇄 대화상자에 이미 「PDF로 저장」이 있다.
 * 새 의존성 하나는 빌드·보안 갱신·번들 크기를 영구히 지고 가는 값이고, 그 값을 치르고 얻는 것이
 * 「저장」 버튼 한 번을 줄이는 것뿐이다. 대신 **문서 자신이 그 사실을 말한다** — footer 한 줄이
 * 어떻게 PDF를 만드는지 적어 두므로, 사용자가 「PDF 내보내기가 없다」고 헤매지 않는다.
 *
 * 이 파일에서 나가는 HTML에는 `<script>` 도 외부 리소스도 없다. 값은 전부 escapeApprovalHtml 을
 * 지나간다 — 결재 제목·의견은 사람이 자유롭게 쓰는 칸이고, 인쇄물은 회사 밖으로도 나간다.
 */

/** 인쇄 잉크·보조·선. 세 값 모두 src/tokens.css 에 있는 색이다(approval-print.test.mjs 가 그 파일을 읽어 대조한다). */
const PRINT_INK = '#1a1d23'
const PRINT_MUTED = '#545862'
const PRINT_LINE = '#d9dce3'

const DECISION_LABEL = { pending: '대기', approved: '승인', rejected: '반려' }
const STEP_MODE_LABEL = { sequential: '순차', parallel: '병렬' }

/** &·<·>·"·' 다섯. `'`까지 막는 이유: 이 파일이 속성값을 홑따옴표로 쓰지 않더라도, 나중에 쓰는 사람이 있다. */
export function escapeApprovalHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** 금액 한 칸. 수가 아니면 빈 문자열이다 — 「0원」이라고 적으면 없는 사실을 만들어 낸다. */
export function formatKrw(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''
  return `${new Intl.NumberFormat('ko-KR').format(value)}원`
}

/**
 * id 하나를 사람 이름으로. 순서가 곧 신뢰도다.
 * 1) 부르는 쪽이 준 계정 표(가장 최신) → 2) 이력에 남은 이름 → 3) 결재선에 적힌 이름 → 4) id 그대로.
 *
 * 4)까지 내려가도 **빈칸으로 두지 않는다**. 인쇄물에서 이름 칸이 비면 「아무도 결재하지 않았다」로
 * 읽히는데, 사실은 「누군지 이름을 못 찾았다」다. 두 사실은 다르다.
 */
function nameOf(document, id, names) {
  const key = String(id ?? '').trim()
  if (!key) return ''
  const fromTable = names instanceof Map ? names.get(key) : names?.[key]
  if (fromTable) return String(fromTable)
  const history = Array.isArray(document?.history) ? document.history : []
  const logged = history.find((entry) => String(entry?.actorId ?? '') === key && String(entry?.actorName ?? '').trim())
  if (logged) return String(logged.actorName)
  for (const step of Array.isArray(document?.line) ? document.line : []) {
    for (const approver of Array.isArray(step?.approvers) ? step.approvers : []) {
      if (approver?.accountId === key && String(approver?.name ?? '').trim()) return String(approver.name)
    }
  }
  return key
}

/**
 * 결재자 한 칸의 표기. 대결이면 **누른 사람(대결 원결재자)** 이다.
 *
 * 누른 사람이 나오는 곳은 `decidedById` 하나뿐이다 — 자리에 남는 `delegateOf` 는 원결재자 id 라서
 * 그것만으로는 「누가 대신 눌렀는가」를 만들 수 없다. 그 필드가 저장에서 떨어지면 이 칸은
 * 조용히 원결재자 이름 하나로 돌아가고, 종이에는 결재하지 않은 사람의 이름만 남는다.
 */
function approverLabel(document, approver, names) {
  const owner = nameOf(document, approver?.accountId, names) || String(approver?.name ?? '')
  const pressedBy = String(approver?.decidedById ?? '').trim()
  if (!pressedBy || pressedBy === String(approver?.accountId ?? '')) return owner
  return `${nameOf(document, pressedBy, names)}(대결 ${owner})`
}

/** 양식 항목 순서대로 label/value 쌍을 만든다. 양식이 없으면 저장된 값의 키를 그대로 쓴다(사라지는 것보다 낫다). */
function fieldRows(document, form) {
  const values = document?.values && typeof document.values === 'object' && !Array.isArray(document.values) ? document.values : {}
  const fields = Array.isArray(form?.fields) ? form.fields : null
  if (!fields) {
    return Object.entries(values).map(([key, value]) => ({ label: key, value: String(value ?? '') }))
  }
  return fields.map((field) => {
    const raw = Object.hasOwn(values, field.key) ? values[field.key] : undefined
    if (raw === undefined || raw === null || raw === '') return { label: field.label, value: '' }
    return { label: field.label, value: field.type === 'money' ? formatKrw(raw) : String(raw) }
  })
}

/** 결재선을 표 한 줄씩 펼친다. 인쇄물과 증빙 마크다운이 같은 배열을 읽어 같은 사실을 적는다. */
function lineRows(document, names) {
  const rows = []
  for (const step of Array.isArray(document?.line) ? document.line : []) {
    for (const approver of Array.isArray(step?.approvers) ? step.approvers : []) {
      rows.push({
        step: `${step?.step ?? ''}단계 · ${STEP_MODE_LABEL[step?.mode] ?? ''}`,
        approver: approverLabel(document, approver, names),
        decision: DECISION_LABEL[approver?.decision] ?? '대기',
        at: String(approver?.decidedAt ?? ''),
        comment: String(approver?.comment ?? ''),
      })
    }
  }
  return rows
}

function attachmentNames(document, attachments) {
  const ids = Array.isArray(document?.attachments) ? document.attachments : []
  const table = new Map((Array.isArray(attachments) ? attachments : []).map((entry) => [String(entry?.id ?? ''), String(entry?.name ?? '')]))
  return ids.map((id) => table.get(String(id)) || String(id))
}

/**
 * 증빙 파일의 본문. **인쇄물과 같은 정보**를 담는다 — 세무사에게 가는 것은 이 마크다운이고,
 * 회사에 남는 것은 인쇄물이다. 둘이 다른 사실을 말하면 나중에 어느 쪽이 맞는지 아무도 모른다.
 */
export function renderApprovalMarkdown({ document, form, tenantName, attachments, names } = {}) {
  const title = String(document?.title ?? '제목 없음')
  const lines = [
    `# ${title}`,
    '',
    `- 회사: ${String(tenantName ?? '')}`,
    `- 양식: ${String(form?.name ?? document?.formName ?? '')} (${String(document?.kind ?? '')})`,
    `- 문서번호: ${String(document?.id ?? '')}`,
    `- 기안자: ${String(document?.drafterName ?? '')}`,
    `- 상태: ${String(document?.status ?? '')}`,
    `- 상신: ${String(document?.submittedAt ?? '')}`,
    `- 완료: ${String(document?.completedAt ?? '')}`,
    '',
    '## 항목',
    '',
  ]
  for (const row of fieldRows(document, form)) lines.push(`- ${row.label}: ${row.value}`)
  const files = attachmentNames(document, attachments)
  if (files.length) {
    lines.push('', '## 첨부', '')
    for (const name of files) lines.push(`- ${name}`)
  }
  lines.push('', '## 결재 이력', '', '| 단계 | 결재자 | 결정 | 시각 | 의견 |', '| --- | --- | --- | --- | --- |')
  for (const row of lineRows(document, names)) {
    // 표 칸에 든 파이프는 표를 부순다. 사람이 의견에 `|`를 쓰는 일은 실제로 있다.
    const cell = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
    lines.push(`| ${cell(row.step)} | ${cell(row.approver)} | ${cell(row.decision)} | ${cell(row.at)} | ${cell(row.comment)} |`)
  }
  if (document?.status === '반려' && document?.rejectionReason) {
    lines.push('', '## 반려 사유', '', String(document.rejectionReason))
  }
  lines.push('', `이 문서는 ${String(tenantName ?? '')}의 전자결재 승인 기록에서 자동으로 만들어졌습니다.`, '')
  return lines.join('\n')
}

/**
 * 인쇄용 HTML 한 장. `<script>` 없음, 외부 리소스 없음, 모든 값은 escapeApprovalHtml 을 지난다.
 * `@page`(A4·여백)와 `@media print`(화면 전용 요소 감추기)가 있어야 브라우저 인쇄가 한 장으로 떨어진다.
 */
export function renderApprovalPrintHtml({ document, form, tenantName, printedAt, attachments, names } = {}) {
  const title = String(document?.title ?? '제목 없음')
  const company = String(tenantName ?? '')
  const rows = lineRows(document, names)
  const files = attachmentNames(document, attachments)
  const escape = escapeApprovalHtml
  const fields = fieldRows(document, form)
    .map((row) => `<div class="field"><dt>${escape(row.label)}</dt><dd>${escape(row.value)}</dd></div>`)
    .join('')
  const history = rows
    .map((row) => `<tr><td>${escape(row.step)}</td><td>${escape(row.approver)}</td><td>${escape(row.decision)}</td><td>${escape(row.at)}</td><td>${escape(row.comment)}</td></tr>`)
    .join('')
  const attachmentSection = files.length
    ? `<section class="attachments"><h2>첨부</h2><ul>${files.map((name) => `<li>${escape(name)}</li>`).join('')}</ul></section>`
    : ''
  const reason = document?.status === '반려' && document?.rejectionReason
    ? `<blockquote class="reason"><strong>반려 사유</strong><p>${escape(document.rejectionReason)}</p></blockquote>`
    : ''

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} 결재문서</title>
<style>
:root { --print-ink:${PRINT_INK}; --print-muted:${PRINT_MUTED}; --print-line:${PRINT_LINE} }
@page { size:A4; margin:14mm }
* { box-sizing:border-box }
body { margin:0; padding:24px; color:var(--print-ink); font-family:'Malgun Gothic','맑은 고딕',system-ui,sans-serif; font-size:12px; line-height:1.6 }
header { border-bottom:2px solid var(--print-ink); padding-bottom:12px; margin-bottom:16px }
header h1 { margin:0 0 6px; font-size:20px }
header .meta { color:var(--print-muted); font-size:11px }
header .status { display:inline-block; border:1px solid var(--print-line); border-radius:999px; padding:1px 10px; margin-left:6px }
dl.fields { display:grid; grid-template-columns:1fr 1fr; gap:0; margin:0 0 16px; border-top:1px solid var(--print-line) }
dl.fields .field { display:flex; gap:8px; border-bottom:1px solid var(--print-line); padding:7px 4px }
dl.fields dt { width:96px; flex:none; color:var(--print-muted); margin:0 }
dl.fields dd { margin:0; flex:1; word-break:break-all }
section.attachments h2, h2 { font-size:13px; margin:0 0 6px }
section.attachments ul { margin:0 0 16px; padding-left:18px }
table.history { width:100%; border-collapse:collapse; margin-bottom:16px }
table.history th, table.history td { border:1px solid var(--print-line); padding:6px 8px; text-align:left; vertical-align:top }
table.history th { background:none; color:var(--print-muted); font-weight:600 }
blockquote.reason { border-left:3px solid var(--print-line); margin:0 0 16px; padding:4px 12px }
blockquote.reason p { margin:4px 0 0 }
footer { border-top:1px solid var(--print-line); padding-top:10px; color:var(--print-muted); font-size:11px }
@media print { body{padding:0} .no-print{display:none} }
</style>
</head>
<body>
<header>
<h1>${escape(title)}</h1>
<p class="meta">${escape(company)} · ${escape(String(form?.name ?? document?.formName ?? ''))} · ${escape(String(document?.id ?? ''))}<span class="status">${escape(String(document?.status ?? ''))}</span></p>
<p class="meta">기안자 ${escape(String(document?.drafterName ?? ''))} · 상신 ${escape(String(document?.submittedAt ?? ''))}</p>
</header>
<dl class="fields">${fields}</dl>
${attachmentSection}
<h2>결재 이력</h2>
<table class="history">
<thead><tr><th>단계</th><th>결재자</th><th>결정</th><th>시각</th><th>의견</th></tr></thead>
<tbody>${history}</tbody>
</table>
${reason}
<footer>이 문서는 브라우저의 인쇄 대화상자에서 «대상: PDF로 저장»을 고르면 PDF 파일이 됩니다. ${escape(company)} · ${escape(String(printedAt ?? ''))} 출력.</footer>
</body>
</html>
`
}

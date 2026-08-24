import assert from 'node:assert/strict'
import test from 'node:test'

import { canExtractDocumentFile, parseComplianceDocumentDraft, parseIpDocumentDraft } from '../src/utils/documentExtraction.ts'

test('client extraction parser accepts one fenced draft and discards untrusted fields', () => {
  const draft = parseIpDocumentDraft(`\`\`\`json
  {"kind":"특허","title":"<b>저온 건조 장치</b>","number":"10-2026-0001","holder":"주식회사 햇살바다","issuer":"특허청","filedAt":"2025-01-02","registeredAt":"2026-03-04","expiresAt":"2046-03-04","confidence":0.91,"warnings":["원본 대조 필요"],"tenantId":"FORGED","attachments":["DOC-FORGED"]}
  \`\`\``)
  assert.equal(draft.title, '저온 건조 장치')
  assert.equal(draft.kind, '특허')
  assert.equal(draft.confidence, 0.91)
  assert.equal('tenantId' in draft, false)
  assert.equal('attachments' in draft, false)
})

test('client extraction parser rejects malformed records and clears impossible or reversed dates', () => {
  assert.throws(() => parseIpDocumentDraft('not-json'), /입력값|형식/)
  assert.throws(() => parseComplianceDocumentDraft('[{"name":"복수"}]'), /한 건|입력값/)
  const draft = parseComplianceDocumentDraft(JSON.stringify({ category: 'HACCP', name: 'HACCP 인증', authority: '인증원', certificateNo: 'A-1', issuedAt: '2026-02-30', expiresAt: '2025-01-01', confidence: 5, warnings: [] }))
  assert.equal(draft.issuedAt, '')
  assert.equal(draft.expiresAt, '2025-01-01')
  assert.equal(draft.confidence, null)
})

test('only certificate PDF and supported image MIME types trigger automatic reading', () => {
  for (const type of ['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp']) assert.equal(canExtractDocumentFile({ type }), true)
  for (const type of ['text/plain', 'application/zip', 'application/vnd.ms-excel', '']) assert.equal(canExtractDocumentFile({ type }), false)
})

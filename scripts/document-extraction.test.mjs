import assert from 'node:assert/strict'
import test from 'node:test'

import { canExtractDocumentFile, DOCUMENT_EXTRACTION_FIELDS, parseDocumentDraft, readFormValues } from '../src/utils/documentExtraction.ts'

test('client extraction parser keeps values with source evidence and discards untrusted fields', () => {
  const draft = parseDocumentDraft({
    fields: {
      kind: { value: '특허', evidence: '특허증' },
      title: { value: '<b>저온 건조 장치</b>', evidence: '발명의 명칭: 저온 건조 장치' },
      number: { value: '10-2026-0001', evidence: '등록번호 10-2026-0001' },
      holder: { value: '주식회사 온팩토리', evidence: '특허권자: 주식회사 온팩토리' },
      filedAt: { value: '2025-01-02', evidence: '출원일 2025.01.02' },
      registeredAt: { value: '2026-03-04', evidence: '등록일 2026.03.04' },
      expiresAt: { value: '2046-03-04', evidence: '존속기간 만료일 2046.03.04' },
    },
    confidence: 0.91,
    warnings: ['원본 대조 필요'],
    tenantId: 'FORGED',
    attachments: ['DOC-FORGED'],
  }, 'ip-right')
  assert.equal(draft.fields.title.value, '저온 건조 장치')
  assert.equal(draft.fields.title.evidence, '발명의 명칭: 저온 건조 장치')
  assert.equal(draft.fields.kind.value, '특허')
  assert.equal(draft.confidence, 0.91)
  assert.equal('tenantId' in draft, false)
  assert.equal('attachments' in draft, false)
})

test('a value without source evidence is never offered for approval', () => {
  const draft = parseDocumentDraft({
    fields: {
      name: { value: 'HACCP 인증', evidence: 'HACCP 적용업소 인증서' },
      authority: { value: '한국식품안전관리인증원', evidence: '' },
      certificateNo: { value: 'A-1', evidence: '인증번호 A-1' },
    },
    confidence: 0.8,
    warnings: [],
  }, 'compliance')
  assert.equal(draft.fields.name.value, 'HACCP 인증')
  assert.equal('authority' in draft.fields, false)
})

test('client extraction parser rejects malformed records and clears impossible or reversed dates', () => {
  assert.throws(() => parseDocumentDraft('not-json', 'ip-right'), /한 건|입력값/)
  assert.throws(() => parseDocumentDraft([{ name: '복수' }], 'compliance'), /한 건|입력값/)
  assert.throws(() => parseDocumentDraft({ fields: { authority: { value: '인증원', evidence: '발급기관 인증원' } } }, 'compliance'), /인증 명칭|인증번호/)
  const draft = parseDocumentDraft({
    fields: {
      category: { value: 'HACCP', evidence: 'HACCP' },
      name: { value: 'HACCP 인증', evidence: '인증서' },
      certificateNo: { value: 'A-1', evidence: '인증번호 A-1' },
      issuedAt: { value: '2026-02-30', evidence: '발급일 2026-02-30' },
      expiresAt: { value: '2025-01-01', evidence: '유효기간 2025-01-01' },
    },
    confidence: 5,
    warnings: [],
  }, 'compliance')
  assert.equal('issuedAt' in draft.fields, false)
  assert.equal(draft.fields.expiresAt.value, '2025-01-01')
  assert.equal(draft.confidence, null)
})

test('reversed contract dates drop both dates instead of saving a wrong period', () => {
  const draft = parseDocumentDraft({
    fields: {
      title: { value: '유지보수 연간 계약', evidence: '계약명: 유지보수 연간 계약' },
      client: { value: '○○주식회사', evidence: '“갑” ○○주식회사' },
      startDate: { value: '2026-12-01', evidence: '계약기간 2026-12-01부터' },
      endDate: { value: '2026-01-31', evidence: '2026-01-31까지' },
      amount: { value: '12,000,000원', evidence: '계약금액 일금 일천이백만원(₩12,000,000)' },
    },
    confidence: 0.5,
    warnings: [],
  }, 'contract')
  assert.equal('startDate' in draft.fields, false)
  assert.equal('endDate' in draft.fields, false)
  assert.equal(draft.fields.amount.value, '12000000')
  assert.ok(draft.warnings.some((warning) => warning.includes('날짜 순서')))
})

test('every extraction target declares the fields its review screen renders', () => {
  assert.deepEqual(DOCUMENT_EXTRACTION_FIELDS['ip-right'].map((field) => field.name), ['kind', 'title', 'number', 'holder', 'issuer', 'filedAt', 'registeredAt', 'expiresAt'])
  assert.deepEqual(DOCUMENT_EXTRACTION_FIELDS.compliance.map((field) => field.name), ['category', 'name', 'authority', 'certificateNo', 'issuedAt', 'expiresAt'])
  assert.deepEqual(DOCUMENT_EXTRACTION_FIELDS.contract.map((field) => field.name), ['title', 'client', 'number', 'startDate', 'endDate', 'amount'])
  for (const fields of Object.values(DOCUMENT_EXTRACTION_FIELDS)) {
    assert.ok(fields.every((field) => field.label && field.type))
  }
})

test('readFormValues keeps what the user already typed and ignores empty controls', () => {
  assert.deepEqual(readFormValues(null, ['title']), {})
})

test('only certificate PDF and supported image MIME types trigger automatic reading', () => {
  for (const type of ['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp']) assert.equal(canExtractDocumentFile({ type }), true)
  for (const type of ['text/plain', 'application/zip', 'application/vnd.ms-excel', '']) assert.equal(canExtractDocumentFile({ type }), false)
})

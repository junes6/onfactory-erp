import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('대장의 [삭제]는 묻지 않고 [되돌리기]·[지운 항목]으로 되살린다(감사 business-admin-19)', () => {
  const ledgers = [
    ['src/components/TaxAssets.tsx', ['company-assets']],
    ['src/components/IpRights.tsx', ['ip-rights']],
    ['src/components/ComplianceCenter.tsx', ['compliance-records']],
    ['src/components/ItServices.tsx', ['it-projects', 'it-deliverables', 'it-clients', 'it-support-programs', 'it-contracts']],
  ]
  for (const [file, keys] of ledgers) {
    const source = read(file)
    for (const key of keys) assert.match(source, new RegExp(`<DeletedRowsButton storeKey="${key}"`), `${file}: ${key} 대장에 [지운 항목]`)
    assert.match(source, /reloadToken: restoreToken/, `${file}: 되살리면 다시 읽는다`)
    assert.doesNotMatch(source, /window\.confirm\([^)]*삭제할까요/, `${file}: 되살릴 수 있는 삭제는 묻지 않는다`)
  }
  const server = read('server/app.mjs')
  assert.match(server, /if \(DELETED_ROW_KEYS\.has\(key\)\) \{/)
  assert.match(server, /await archive\.append\(request\.auth\.tenantId, DELETED_ROWS_COLLECTION, envelopes/)
  assert.match(read('server/archive.mjs'), /'deleted-rows': '지운 기록'/)
})

test('동료가 못 여는 파일은 잠금 표시로, 산출물·지원사업 파일은 행을 읽는 모두에게(감사 business-admin-05)', () => {
  const it = read('src/components/ItServices.tsx')
  assert.match(it, /tags: \['it-deliverable'\], visibility: 'all' \}/)
  assert.match(it, /tags: \['support-program'\], visibility: 'all' \}/)
  assert.doesNotMatch(it, /tags: \['it-contract', 'AI-판독대상'\], visibility: 'all'/, '계약 문서는 그대로 올린 사람·관리자')
  for (const list of ['deliverable', 'program', 'contract']) assert.ok(it.includes(`${list}.attachments.map(fileChip)`), `${list} 파일 칩`)
  assert.match(it, /className="it-file-locked"/)
  assert.match(read('src/utils/documentAttachments.ts'), /visibility: options\.visibility \?\? 'restricted'/)
})

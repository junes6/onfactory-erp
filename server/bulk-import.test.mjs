import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  ABANDONED_MESSAGE, MAX_ENTRIES_PER_SESSION, MAX_MANIFEST_PAGE, MAX_PATH_LENGTH, MAX_TAGS_PER_MAPPING, MAX_USER_TAGS_PER_MAPPING, OVERSIZE_MESSAGE,
  canBulkImport, completionReport, documentFieldsFor, documentOpensToProject, matchMappingRow, nextStatus, normalizeImportPath, normalizeMapping,
  pageEntries, planManifest, recomputeTotals, resolveMapping, sameRunAnchorKey,
} from './bulk-import.mjs'

/**
 * 벌크 이관의 순수 규칙 — 경로·매핑·중복·전이·집계.
 *
 * HTTP를 태우지 않고 여기서 다 잠근다. 라우트 시험은 이 규칙들이 실제 앱에서 이어지는지를 본다.
 */

const sha = (value) => createHash('sha256').update(value).digest('hex')

test('1. 경로 정규화 다섯 갈래: 상위 참조·절대 경로·제어문자·길이 초과·빈 문자열', () => {
  // 상위 참조는 폴더 구조를 거슬러 올라간다는 뜻이라 표시용 문자열로도 받지 않는다.
  assert.equal(normalizeImportPath('Flow/../계약/a.pdf'), null)
  assert.equal(normalizeImportPath('..'), null)
  // 절대 경로는 거절이 아니라 정규화다 — 선행 /를 떼고 연속 //를 접는다.
  assert.equal(normalizeImportPath('/Flow//계약/2025/a.pdf'), 'Flow/계약/2025/a.pdf')
  assert.equal(normalizeImportPath('Flow\\계약\\a.pdf'), 'Flow/계약/a.pdf')
  // 제어문자 한 글자가 목록 한 줄을 깨뜨린다.
  assert.equal(normalizeImportPath('Flow/\u0000계약/a.pdf'), null)
  assert.equal(normalizeImportPath('Flow/계\u001f약/a.pdf'), null)
  // 상한 경계: 400자는 통과, 401자는 거절.
  const long = `${'a'.repeat(MAX_PATH_LENGTH - 4)}/x.p`
  assert.equal(long.length, MAX_PATH_LENGTH)
  assert.equal(normalizeImportPath(long), long)
  assert.equal(normalizeImportPath(`${long}x`), null)
  // 빈 문자열·공백만·세그먼트 0개.
  assert.equal(normalizeImportPath(''), null)
  assert.equal(normalizeImportPath('   '), null)
  assert.equal(normalizeImportPath('///'), null)
  assert.equal(normalizeImportPath('Flow/  /a.pdf'), null, '공백만인 세그먼트는 폴더 이름이 아니다')
})

test('2. 매핑은 가장 긴 접두가 이기고, 경계를 넘어 삼키지 않는다', () => {
  const mapping = [
    { folderPrefix: '', projectId: null, tags: ['공통'], aiLevel: 'locked' },
    { folderPrefix: 'Flow', projectId: 'PRJ-A', tags: [], aiLevel: 'locked' },
    { folderPrefix: 'Flow/계약', projectId: 'PRJ-B', tags: ['계약'], aiLevel: 'indexed' },
  ]
  assert.equal(resolveMapping('Flow/계약/2025/a.pdf', mapping).projectId, 'PRJ-B')
  assert.equal(resolveMapping('Flow/설계/a.pdf', mapping).projectId, 'PRJ-A')
  assert.equal(resolveMapping('그 밖/a.pdf', mapping).projectId, null)
  // 'Flow/계약'이 'Flow/계약서'를 삼키면 남의 프로젝트에 파일이 들어간다.
  assert.equal(resolveMapping('Flow/계약서/a.pdf', mapping).projectId, 'PRJ-A')
  // 길이가 같으면 먼저 선언된 것.
  const tie = [{ folderPrefix: 'A/B', projectId: 'PRJ-1' }, { folderPrefix: 'A/B', projectId: 'PRJ-2' }]
  assert.equal(resolveMapping('A/B/x.pdf', tie).projectId, 'PRJ-1')
  // 어디에도 걸리지 않으면 기본 행 — 기본 AI 수준은 '보관만'이다.
  assert.deepEqual(resolveMapping('X/y.pdf', []), { folderPrefix: '', projectId: null, tags: [], aiLevel: 'locked' })
  /**
   * '기본 행으로 떨어졌다'와 '사람이 그 행을 선언했다'는 다른 사실이다. 앞의 것은 projectId가 없는
   * 채로 전 직원 공개를 만드는 행위(관리자 권한)이고, 뒤의 것은 사람이 그렇게 고른 것이다.
   * 두 경우가 같은 값으로 보이면 업로드가 그 차이를 판정할 수 없다.
   */
  assert.equal(matchMappingRow('X/y.pdf', mapping)?.projectId, null, "''행은 선언된 행이라 걸린다")
  assert.equal(matchMappingRow('X/y.pdf', []), null)
  assert.equal(matchMappingRow('그 밖/a.pdf', [{ folderPrefix: 'Flow', projectId: 'PRJ-A' }]), null)
  assert.equal(matchMappingRow('Flow/a.pdf', [{ folderPrefix: 'Flow', projectId: 'PRJ-A' }])?.projectId, 'PRJ-A')
})

test('3. 매핑 입력 검증은 어느 칸이 문제인지 이름으로 돌려준다', () => {
  assert.deepEqual(normalizeMapping(undefined), { mapping: [] })
  assert.equal(normalizeMapping({}).path, 'mapping')
  assert.equal(normalizeMapping([{ folderPrefix: '../x' }]).path, 'mapping[0].folderPrefix')
  assert.equal(normalizeMapping([{ folderPrefix: 'A' }, { folderPrefix: 'A' }]).path, 'mapping[1].folderPrefix')
  assert.equal(normalizeMapping([{ folderPrefix: 'A', aiLevel: '보관만' }]).path, 'mapping[0].aiLevel')
  assert.equal(normalizeMapping([{ folderPrefix: 'A', tags: 'x' }]).path, 'mapping[0].tags')
  assert.equal(normalizeMapping([{ folderPrefix: 'A', tags: Array.from({ length: 21 }, (_, index) => `t${index}`) }]).path, 'mapping[0].tags')
  /**
   * 예약 태그 두 칸('bulk-import'·'import:<세션>')을 남겨 둔다. 20개를 받아 두면 documentFieldsFor의
   * slice가 **마지막 두 개를 말없이 버려** 그 행이 올린 모든 문서에서 태그가 사라진다.
   */
  const tags = (count) => Array.from({ length: count }, (_, index) => `t${index}`)
  assert.equal(MAX_USER_TAGS_PER_MAPPING, MAX_TAGS_PER_MAPPING - 2)
  assert.equal(normalizeMapping([{ folderPrefix: 'A', tags: tags(MAX_USER_TAGS_PER_MAPPING + 1) }]).path, 'mapping[0].tags', '어느 칸이 문제인지 화면이 가리킬 수 있어야 한다')
  const full = normalizeMapping([{ folderPrefix: 'A', tags: tags(MAX_USER_TAGS_PER_MAPPING) }])
  assert.equal(full.mapping[0].tags.length, MAX_USER_TAGS_PER_MAPPING)
  const stamped = documentFieldsFor(full.mapping[0], { sessionId: 'IMP-1' })
  assert.equal(stamped.tags.length, MAX_TAGS_PER_MAPPING)
  assert.equal(stamped.tags.includes(`t${MAX_USER_TAGS_PER_MAPPING - 1}`), true, '받아 준 태그는 하나도 사라지지 않는다')
  const ok = normalizeMapping([{ folderPrefix: '/Flow/계약/', projectId: 'PRJ-A', tags: [' 계약 ', '계약'], aiLevel: 'indexed' }])
  assert.deepEqual(ok.mapping, [{ folderPrefix: 'Flow/계약', projectId: 'PRJ-A', tags: ['계약'], aiLevel: 'indexed' }])
})

test('4. 매핑이 문서에 남기는 값은 한 함수가 정한다', () => {
  const withProject = documentFieldsFor({ folderPrefix: 'Flow/계약', projectId: 'PRJ-A', tags: ['계약'], aiLevel: 'indexed' }, { sessionId: 'IMP-1', projectMemberIds: ['USR-A', 'USR-B'] })
  assert.equal(withProject.category, '프로젝트')
  assert.equal(withProject.visibility, 'restricted')
  assert.deepEqual(withProject.allowedUserIds, ['USR-A', 'USR-B'])
  assert.deepEqual(withProject.tags, ['bulk-import', 'import:IMP-1', '계약'])
  assert.equal(withProject.aiPolicy, 'indexed')

  const withoutProject = documentFieldsFor({ folderPrefix: '', projectId: null, tags: [], aiLevel: 'locked' }, { sessionId: 'IMP-1' })
  assert.equal(withoutProject.category, '공통자료')
  assert.equal(withoutProject.visibility, 'all')
  assert.deepEqual(withoutProject.allowedUserIds, [])
  assert.equal(withoutProject.projectId, null)
})

test('5. 중복 판정: 기존 문서·같은 묶음 안·읽을 수 없는 문서', () => {
  const existing = new Map([[sha('이미 있는 파일'), 'DOC-OLD']])
  const knownByChecksum = new Map()
  const knownEntries = new Map()
  const planned = planManifest({
    entries: [
      { path: 'Flow/a.pdf', name: 'a.pdf', size: 10, sha256: sha('이미 있는 파일') },
      { path: 'Flow/b.pdf', name: 'b.pdf', size: 10, sha256: sha('새 파일') },
      { path: 'Flow/c.pdf', name: 'c.pdf', size: 10, sha256: sha('새 파일') },
      { path: 'Flow/d.pdf', name: 'd.pdf', size: 20 * 1024 * 1024, sha256: sha('큰 파일') },
    ],
    existingByChecksum: existing,
    knownByChecksum,
    knownEntries,
  })
  assert.deepEqual(planned.verdicts.map((entry) => entry.status), ['duplicate', 'pending', 'duplicate', 'failed'])
  assert.equal(planned.verdicts[0].duplicateOf, 'DOC-OLD')
  // 아직 올라가지 않은 것을 id로 가리킬 수는 없다.
  assert.equal(planned.verdicts[2].duplicateOfPath, 'Flow/b.pdf')
  assert.equal(planned.verdicts[2].duplicateOf, undefined)
  assert.equal(planned.verdicts[3].error, OVERSIZE_MESSAGE)

  // 볼 수 없는 문서는 인덱스에 애초에 들어오지 않는다(라우트가 canReadDocument로 거른다).
  // 그러면 중복이 아니라 새 업로드가 된다 — 사본 하나가 늘 뿐, 그 문서의 존재는 새지 않는다.
  const hidden = planManifest({ entries: [{ path: 'Flow/e.pdf', name: 'e.pdf', size: 10, sha256: sha('비밀 문서') }], existingByChecksum: new Map() })
  assert.equal(hidden.verdicts[0].status, 'pending')
})

/**
 * 재개는 같은 폴더를 다시 골라 같은 매니페스트를 다시 보내는 흐름이다. 이 갈래에서
 * 아는 경로를 무조건 'duplicate'라고 답하면 아직 올리지 않은 파일이 '이미 올라갔다'가 되어
 * 재개가 한 건도 올리지 못하고 전부 실패로 마감된다 — 브라우저 판정에서 실제로 그렇게 됐다.
 */
test('5-1. 이미 아는 경로는 엔트리를 늘리지 않고 그 엔트리의 실제 상태를 답한다', () => {
  const knownEntries = new Map([
    ['A/pending.pdf', { path: 'A/pending.pdf', status: 'pending', sha256: sha('본문1'), duplicateOf: '', error: '' }],
    ['A/done.pdf', { path: 'A/done.pdf', status: 'uploaded', sha256: sha('본문2'), duplicateOf: '', error: '' }],
    ['A/dup.pdf', { path: 'A/dup.pdf', status: 'duplicate', sha256: sha('본문3'), duplicateOf: 'DOC-OLD', error: '' }],
    ['A/bad.pdf', { path: 'A/bad.pdf', status: 'failed', sha256: sha('본문4'), duplicateOf: '', error: OVERSIZE_MESSAGE }],
  ])
  const again = planManifest({
    entries: [
      { path: 'A/pending.pdf', name: 'pending.pdf', size: 1, sha256: sha('본문1') },
      { path: 'A/done.pdf', name: 'done.pdf', size: 1, sha256: sha('본문2') },
      { path: 'A/dup.pdf', name: 'dup.pdf', size: 1, sha256: sha('본문3') },
      { path: 'A/bad.pdf', name: 'bad.pdf', size: 1, sha256: sha('본문4') },
    ],
    knownEntries,
  })
  assert.deepEqual(again.verdicts.map((entry) => entry.status), ['pending', 'uploaded', 'duplicate', 'failed'])
  assert.equal(again.entries.length, 0, '아는 경로는 엔트리를 두 번 만들지 않는다')
  assert.equal(again.verdicts[2].duplicateOf, 'DOC-OLD')
  assert.equal(again.verdicts[3].error, OVERSIZE_MESSAGE)

  // 다시 고른 파일의 내용이 바뀌었으면 새 지문으로 갈아 끼운다 — 옛 지문으로는 업로드가 400이 된다.
  const changed = planManifest({
    entries: [{ path: 'A/pending.pdf', name: 'pending.pdf', size: 1, sha256: sha('고친 본문') }],
    knownEntries: new Map([['A/pending.pdf', { path: 'A/pending.pdf', status: 'pending', sha256: sha('본문1'), duplicateOf: '', error: '' }]]),
  })
  assert.equal(changed.verdicts[0].status, 'pending')
  assert.equal(changed.verdicts[0].changed, true)
  assert.deepEqual(changed.updates, [{ path: 'A/pending.pdf', sha256: sha('고친 본문'), changed: true }])

  /**
   * 실패한 엔트리도 같다. resolveUpload가 failed를 다시 받아 주므로 지문도 함께 갈아 끼워야 한다 —
   * 갈지 않으면 화면에는 새 지문이 보이고 서버에는 옛 지문이 남아, 올릴 때마다 400 HASH_MISMATCH가 나고
   * 그 문장이 시키는 대로 폴더를 다시 골라도 같은 답이 돌아온다(빠져나갈 길이 없는 자리).
   */
  const retried = planManifest({
    entries: [{ path: 'A/bad.pdf', name: 'bad.pdf', size: 1, sha256: sha('고쳐 다시 고른 본문') }],
    knownEntries: new Map([['A/bad.pdf', { path: 'A/bad.pdf', status: 'failed', sha256: sha('본문4'), duplicateOf: '', error: '연결이 끊겨 올리지 못했습니다.' }]]),
  })
  assert.equal(retried.verdicts[0].status, 'failed')
  assert.equal(retried.verdicts[0].changed, true)
  assert.deepEqual(retried.updates, [{ path: 'A/bad.pdf', sha256: sha('고쳐 다시 고른 본문'), changed: true }])
  // 이미 끝난 엔트리는 갈지 않는다 — 그 문서는 저장된 바이트로 확정돼 있다.
  const settled = planManifest({
    entries: [{ path: 'A/done.pdf', name: 'done.pdf', size: 1, sha256: sha('다른 본문') }],
    knownEntries: new Map([['A/done.pdf', { path: 'A/done.pdf', status: 'uploaded', sha256: sha('본문2'), duplicateOf: '', error: '' }]]),
  })
  assert.deepEqual(settled.updates, [])
})

test('5-2. 보고서는 그때 적용된 행으로 묶는다 — 나중에 고친 매핑이 이력을 바꾸지 않는다', () => {
  /**
   * 올라간 엔트리에는 그때 걸린 행이 새겨져 있다(markUploaded). 지금 매핑으로 다시 풀면
   * 이미 저장된 파일에 대해 하지 않은 일을 말한다. 아직 안 올라간 엔트리는 반대로 지금 매핑이 진실이다 —
   * 그 파일에 앞으로 적용될 행이 실제로 그 행이기 때문이다.
   */
  const entries = [
    // 묶음의 첫 줄이 아직 안 올라간 엔트리인 경우까지 본다 — 새겨진 값이 언제나 이겨야 한다.
    { path: 'Flow/계약/b.pdf', name: 'b.pdf', size: 5, status: 'failed', error: '연결이 끊겨 올리지 못했습니다.' },
    { path: 'Flow/계약/a.pdf', name: 'a.pdf', size: 10, status: 'uploaded', appliedPrefix: 'Flow/계약', appliedProjectId: 'PRJ-CONTRACT', appliedAiLevel: 'locked' },
    { path: 'Flow/설계/c.pdf', name: 'c.pdf', size: 7, status: 'pending' },
  ]
  // 같은 행의 대상만 바꿨다: 올라간 파일은 PRJ-CONTRACT·보관만으로 저장돼 있고, 표만 PRJ-DESIGN·활용이다.
  const session = {
    mapping: [
      { folderPrefix: 'Flow/계약', projectId: 'PRJ-DESIGN', tags: [], aiLevel: 'active' },
      { folderPrefix: 'Flow/설계', projectId: 'PRJ-DESIGN', tags: [], aiLevel: 'active' },
    ],
  }
  const report = completionReport(session, entries)
  const applied = report.folders.find((row) => row.folderPrefix === 'Flow/계약')
  assert.equal(applied.projectId, 'PRJ-CONTRACT', '저장된 파일의 이력이 표의 현재 값에 덮이지 않는다')
  assert.equal(applied.aiLevel, 'locked')
  assert.deepEqual([applied.files, applied.uploaded, applied.failed], [2, 1, 1])
  assert.equal('stamped' in applied, false, '집계용 표시는 화면에 나가지 않는다')
  // 아직 올라가지 않은 파일은 반대로 지금 매핑이 진실이다 — 그 행이 앞으로 적용될 행이다.
  const future = report.folders.find((row) => row.folderPrefix === 'Flow/설계')
  assert.equal(future.projectId, 'PRJ-DESIGN')
  assert.equal(future.aiLevel, 'active')
  assert.equal(future.files, 1)

  // 새겨진 값이 없는 옛 세션은 지금까지처럼 매핑으로 푼다 — 이력이 없다고 보고서가 비지 않는다.
  const legacy = completionReport(session, [{ path: 'Flow/계약/a.pdf', name: 'a.pdf', size: 10, status: 'uploaded' }])
  assert.deepEqual(legacy.folders.map((row) => [row.folderPrefix, row.projectId]), [['Flow/계약', 'PRJ-DESIGN']])
})

test('6. 매니페스트 형식 위반은 몇 번째 항목인지 알려 주고 페이지 전체를 거절한다', () => {
  const bad = planManifest({ entries: [{ path: 'A/a.pdf', size: 1, sha256: sha('x') }, { path: '../b.pdf', size: 1, sha256: sha('y') }] })
  assert.equal(bad.error.code, 'BULK_IMPORT_PATH_INVALID')
  assert.equal(bad.error.index, 1)

  const upper = planManifest({ entries: [{ path: 'A/a.pdf', size: 1, sha256: sha('x').toUpperCase() }] })
  assert.equal(upper.error.code, 'BULK_IMPORT_ENTRY_INVALID')
  assert.equal(upper.error.field, 'sha256')

  const short = planManifest({ entries: [{ path: 'A/a.pdf', size: 1, sha256: 'abc' }] })
  assert.equal(short.error.field, 'sha256')

  // 빈 지문은 형식 오류가 아니라 사실이다 — http로 연 브라우저에는 crypto.subtle이 없다.
  // 거절하면 사내 LAN에서 연 사람만 기능 전체를 쓰지 못한다.
  const blind = planManifest({
    entries: [{ path: 'A/a.pdf', name: 'a.pdf', size: 1, sha256: '' }, { path: 'A/b.pdf', name: 'b.pdf', size: 1, sha256: '' }],
    existingByChecksum: new Map([['', 'DOC-WRONG']]),
  })
  assert.equal(blind.error, undefined)
  assert.deepEqual(blind.verdicts.map((entry) => entry.status), ['pending', 'pending'])
  assert.equal(blind.verdicts[0].duplicateOf, undefined, '지문이 없으면 중복 색인을 타지 않는다')
  assert.equal(blind.verdicts[1].duplicateOfPath, undefined, '빈 지문끼리 같은 파일로 묶이면 파일을 잃는다')

  for (const size of [-1, 1.5, '10', Number.MAX_SAFE_INTEGER + 2]) {
    const wrong = planManifest({ entries: [{ path: 'A/a.pdf', size, sha256: sha('x') }] })
    assert.equal(wrong.error.field, 'size', String(size))
  }

  const tooMany = planManifest({ entries: Array.from({ length: MAX_MANIFEST_PAGE + 1 }, (_, index) => ({ path: `A/${index}.pdf`, size: 1, sha256: sha(String(index)) })) })
  assert.equal(tooMany.error.code, 'BULK_IMPORT_PAGE_TOO_LARGE')
})

test('7. 엔트리 페이지는 경계에서 중복도 누락도 없다', () => {
  const entries = Array.from({ length: 220 }, (_, index) => ({ path: `A/${index}.pdf`, status: 'pending' }))
  const seen = []
  let cursor = 0
  for (let guard = 0; guard < 10; guard += 1) {
    const page = pageEntries(entries, cursor, 100)
    seen.push(...page.entries.map((entry) => entry.path))
    if (page.nextCursor === null) break
    cursor = page.nextCursor
  }
  assert.equal(seen.length, 220)
  assert.equal(new Set(seen).size, 220)
  assert.deepEqual(seen, entries.map((entry) => entry.path))
  // limit는 서버 상한을 넘지 못한다 — 4mb 본문 한계를 클라이언트가 정하게 두지 않는다.
  assert.equal(pageEntries(entries, 0, 1_000).entries.length, 100)
  assert.equal(pageEntries(entries, 200, 100).nextCursor, null)
})

test('8. 상태 전이표: 표 안은 통과, 표 밖은 null, 같은 상태는 멱등', () => {
  const table = [
    ['draft', 'mapping', 'mapping'], ['draft', 'uploading', 'uploading'], ['draft', 'done', null],
    ['mapping', 'uploading', 'uploading'], ['mapping', 'draft', null],
    ['uploading', 'paused', 'paused'], ['uploading', 'done', 'done'], ['uploading', 'failed', 'failed'],
    ['paused', 'uploading', 'uploading'], ['paused', 'mapping', null],
    ['done', 'uploading', null], ['failed', 'uploading', null],
  ]
  for (const [from, to, expected] of table) assert.equal(nextStatus(from, to), expected, `${from} → ${to}`)
  assert.equal(nextStatus('done', 'done'), 'done', '같은 상태는 멱등이어야 마감 재요청이 500이 되지 않는다')
  assert.equal(nextStatus('uploading', '없는상태'), null)
  assert.equal(nextStatus('없는상태', 'done'), null)
})

test('9. 집계는 순서·재전송에 무관하고, 완료 보고의 네 숫자가 맞아떨어진다', () => {
  const entries = [
    { path: 'A/1.pdf', name: '1.pdf', size: 100, status: 'uploaded' },
    { path: 'A/2.pdf', name: '2.pdf', size: 200, status: 'duplicate' },
    { path: 'B/3.pdf', name: '3.pdf', size: 300, status: 'failed', error: OVERSIZE_MESSAGE },
    { path: 'B/4.pdf', name: '4.pdf', size: 400, status: 'uploaded' },
  ]
  const totals = recomputeTotals(entries)
  assert.deepEqual(totals, { files: 4, bytes: 500, uploaded: 2, skippedDuplicate: 1, failed: 1 })
  // 순서를 뒤집어도 같은 숫자다 — 누적(+1)으로 세면 배치 재전송 한 번에 어긋난다.
  assert.deepEqual(recomputeTotals([...entries].reverse()), totals)

  const session = { mapping: [{ folderPrefix: 'A', projectId: 'PRJ-A', tags: [], aiLevel: 'locked' }] }
  const report = completionReport(session, entries)
  assert.equal(report.uploaded + report.skippedDuplicate + report.failed + report.pending, report.files)
  assert.deepEqual(report.failures, [{ path: 'B/3.pdf', name: '3.pdf', error: OVERSIZE_MESSAGE }])
  assert.equal(report.failuresTruncated, false)
  assert.deepEqual(report.folders.map((row) => [row.folderPrefix, row.files]), [['', 2], ['A', 2]])

  // 실패 201건이면 200건만 보관하고 잘렸다고 말한다 — 조용히 줄이지 않는다.
  const many = Array.from({ length: 201 }, (_, index) => ({ path: `C/${index}.pdf`, name: `${index}.pdf`, size: 1, status: 'failed', error: '실패' }))
  const bigReport = completionReport({ mapping: [] }, many)
  assert.equal(bigReport.failed, 201)
  assert.equal(bigReport.failures.length, 200)
  assert.equal(bigReport.failuresTruncated, true)
})

test('10. 이관 권한 다섯 갈래 — 메시지에 프로젝트 이름이 없다', () => {
  const projects = [
    { id: 'PRJ-A', ownerId: 'USR-OWNER', members: [{ id: 'USR-EDITOR', role: 'editor' }, { id: 'USR-VIEWER', role: 'viewer' }] },
    { id: 'PRJ-B', ownerId: 'USR-OTHER', members: [] },
  ]
  const projectRoleOf = (project, auth) => {
    if (auth.role === 'tenant-admin') return 'owner'
    const member = (project.members ?? []).find((item) => item.id === auth.id)
    return member ? member.role : (project.ownerId === auth.id ? 'owner' : null)
  }
  const call = (auth, mapping) => canBulkImport({ auth, mapping, projects, projectRoleOf })

  const admin = { id: 'USR-ADMIN', role: 'tenant-admin', tenantId: 'T' }
  const editor = { id: 'USR-EDITOR', role: 'tenant-member', tenantId: 'T' }
  const viewer = { id: 'USR-VIEWER', role: 'tenant-member', tenantId: 'T' }
  const guest = { id: 'USR-GUEST', role: 'tenant-guest', tenantId: 'T' }

  assert.equal(call(admin, [{ projectId: null }]).ok, true, '관리자는 언제나 가능하다')
  assert.equal(call(editor, [{ projectId: 'PRJ-A' }]).ok, true)
  assert.equal(call(viewer, [{ projectId: 'PRJ-A' }]).ok, false, 'viewer는 파일을 넣을 자리가 아니다')
  // projectId가 비어 있는 행 하나면 회사 전체 자료실에 넣는 행위가 된다 — 관리자 권한이다.
  assert.equal(call(editor, [{ projectId: 'PRJ-A' }, { projectId: null }]).ok, false)
  assert.equal(call(guest, [{ projectId: 'PRJ-A' }]).ok, false)
  assert.equal(call(editor, [{ projectId: 'PRJ-B' }]).ok, false, '범위 밖 프로젝트')

  const denied = call(editor, [{ projectId: 'PRJ-B' }]).error
  assert.equal(denied.code, 'BULK_IMPORT_FORBIDDEN')
  assert.doesNotMatch(denied.message, /PRJ-/, '범위 밖 프로젝트의 존재를 메시지가 알리지 않는다')
})

test('11. 세션 상한과 마감 문구는 상수 하나에서 나온다', () => {
  assert.equal(MAX_ENTRIES_PER_SESSION, 5_000)
  assert.equal(MAX_MANIFEST_PAGE, 200)
  // 재개할 때 다시 고르지 않은 파일은 영원히 pending으로 남지 않는다.
  assert.match(ABANDONED_MESSAGE, /다시 선택하지 않았습니다/)
  assert.match(OVERSIZE_MESSAGE, /10MB/)
})

test('5-3. 그 프로젝트에서 열리는 자료인가 — 중복을 닫아도 되는지의 유일한 근거', () => {
  const members = ['USR-A', 'USR-B', 'USR-GUEST']
  // 전 직원 자료는 프로젝트 구성원도 본다.
  assert.equal(documentOpensToProject({ visibility: 'all' }, members), true)
  // 부서 공개는 그 부서 밖의 구성원이 못 본다 — 열린다고 말할 수 없다.
  assert.equal(documentOpensToProject({ visibility: 'department', departments: ['품질관리'] }, members), false)
  assert.equal(documentOpensToProject({ visibility: 'restricted', allowedUserIds: ['USR-A', 'USR-B'] }, members), false, '한 명이라도 빠지면 그 프로젝트에 구멍이 남는다')
  assert.equal(documentOpensToProject({ visibility: 'restricted', allowedUserIds: members }, members), true)
  // 올린 사람은 목록에 없어도 자기 자료를 읽는다(canReadDocument와 같은 사실).
  assert.equal(documentOpensToProject({ visibility: 'restricted', allowedUserIds: ['USR-A', 'USR-GUEST'], uploadedById: 'USR-B' }, members), true)
  assert.equal(documentOpensToProject(null, members), false)
  assert.equal(documentOpensToProject({ visibility: 'restricted', allowedUserIds: [] }, []), true, '구성원이 없으면 빠질 사람도 없다')
})

test('5-4. 닫을 수 없는 중복은 pending으로 남는다 — 새 사본이 그 프로젝트로 간다', () => {
  const body = sha('같은 내용')
  /**
   * '이미 있으니 안 올렸다'와 '그 프로젝트에는 없다'가 다른 사실이 되지 않게, 판정을 주입받는다.
   * 여기서는 DOC-CLOSED만 닫을 수 있다고 답하게 하고, 나머지는 다시 올릴 대상으로 남는지 본다.
   */
  const planned = planManifest({
    entries: [
      { path: '계약/a.pdf', name: 'a.pdf', size: 10, sha256: body },
      { path: '계약/b.pdf', name: 'b.pdf', size: 10, sha256: body },
      { path: '설계/c.pdf', name: 'c.pdf', size: 10, sha256: sha('열린 자료') },
    ],
    existingByChecksum: new Map([[body, 'DOC-BLOCKED'], [sha('열린 자료'), 'DOC-CLOSED']]),
    // 같은 묶음 안의 중복(otherPath)은 여기서 다루지 않는다 — 아래 split에서 따로 본다.
    canCloseDuplicate: (_path, { documentId, otherPath }) => (otherPath ? true : documentId === 'DOC-CLOSED'),
  })
  assert.deepEqual(planned.verdicts.map((entry) => entry.status), ['pending', 'duplicate', 'duplicate'])
  assert.equal(planned.verdicts[0].duplicateOf, undefined, '닫지 않은 판정에는 중복 표시가 남지 않는다')
  // 되돌아온 첫 파일이 같은 묶음의 기준이 된다 — 사본이 두 벌 올라가지 않는다.
  assert.equal(planned.verdicts[1].duplicateOfPath, '계약/a.pdf')
  // 라우트가 넓힐 대상은 **실제로 닫은 것**뿐이다.
  assert.deepEqual(planned.duplicates, [{ path: '설계/c.pdf', duplicateOf: 'DOC-CLOSED' }])

  // 같은 묶음 안의 중복도 목적지가 다르면 닫지 않는다(먼저 올라갈 파일이 다른 프로젝트로 간다).
  const split = planManifest({
    entries: [
      { path: '계약/a.pdf', name: 'a.pdf', size: 10, sha256: body },
      { path: '설계/a.pdf', name: 'a.pdf', size: 10, sha256: body },
    ],
    canCloseDuplicate: (path, { otherPath }) => (otherPath ? path.split('/')[0] === otherPath.split('/')[0] : true),
  })
  assert.deepEqual(split.verdicts.map((entry) => entry.status), ['pending', 'pending'])
  assert.deepEqual(split.duplicates, [])
})

test('5-5. 닫아 둔 중복은 매핑이 바뀌면 다시 판정한다 — 표를 고치는 것은 첫 판정 뒤다', () => {
  const knownEntries = new Map([
    ['Flow/a.pdf', { path: 'Flow/a.pdf', status: 'duplicate', sha256: sha('본문'), duplicateOf: 'DOC-OLD', error: '' }],
    ['Flow/b.pdf', { path: 'Flow/b.pdf', status: 'duplicate', sha256: sha('본문2'), duplicateOf: 'DOC-OPEN', error: '' }],
  ])
  const entries = [
    { path: 'Flow/a.pdf', name: 'a.pdf', size: 10, sha256: sha('본문') },
    { path: 'Flow/b.pdf', name: 'b.pdf', size: 10, sha256: sha('본문2') },
  ]
  const planned = planManifest({
    entries, knownEntries,
    canCloseDuplicate: (_path, { documentId }) => documentId === 'DOC-OPEN',
  })
  assert.deepEqual(planned.verdicts.map((entry) => entry.status), ['pending', 'duplicate'])
  assert.equal(planned.verdicts[0].duplicateOf, undefined)
  assert.deepEqual(planned.entries, [], '아는 경로는 엔트리를 늘리지 않는다')
  // 저장된 엔트리도 함께 열려야 한다 — 응답만 pending이면 업로드가 '이미 끝났다'로 거절된다.
  assert.deepEqual(planned.updates, [{ path: 'Flow/a.pdf', reopen: true }])
  // 여전히 닫혀 있는 것은 넓힐 대상으로 라우트에 넘어간다(첫 매니페스트 때는 대상 프로젝트가 없었다).
  assert.deepEqual(planned.duplicates, [{ path: 'Flow/b.pdf', duplicateOf: 'DOC-OPEN' }])

  // 기본값은 '닫는다'다 — 판정을 주지 않으면 예전과 같은 답이 나온다.
  const untouched = planManifest({ entries, knownEntries })
  assert.deepEqual(untouched.verdicts.map((entry) => entry.status), ['duplicate', 'duplicate'])
  assert.deepEqual(untouched.updates, [])
})

test('5-6. 같은 묶음 안의 중복도 다시 판정한다 — 첫 판정은 대상 프로젝트 없이 전부 닫는다', () => {
  /**
   * 자료실 문서로 닫은 중복(duplicateOf)만 다시 보면, **같은 묶음의 파일로 닫은 중복
   * (duplicateOfPath)은 영영 다시 판정되지 않는다.** 첫 매니페스트는 언제나 대상 프로젝트가 없는
   * 자동 감지 매핑으로 가므로 그때는 전부 닫히고, 사람이 표를 나눈 뒤에는 두 번째 프로젝트에
   * 그 파일이 없다 — 한 파일을 두 프로젝트 폴더에 복사해 둔 내보내기에서 바로 걸린다.
   */
  const body = sha('두 폴더에 복사해 둔 같은 파일')
  const destination = (path) => (path.startsWith('계약') ? 'PRJ-C' : 'PRJ-D')
  const canCloseDuplicate = (path, { documentId, otherPath }) => (otherPath ? destination(otherPath) === destination(path) : Boolean(documentId))
  const stored = (path, duplicateOfPath) => [path, { path, status: duplicateOfPath ? 'duplicate' : 'pending', sha256: body, duplicateOf: '', duplicateOfPath, error: '' }]
  const knownEntries = new Map([
    stored('계약/a.pdf', ''),
    stored('설계/a.pdf', '계약/a.pdf'),
    stored('설계/b.pdf', '계약/a.pdf'),
    stored('계약/b.pdf', '계약/a.pdf'),
  ])
  // 라우트가 아직 pending인 엔트리로 채워 넘기는 색인. 키 모양의 출처는 한 함수뿐이다.
  const knownByChecksum = new Map([[sameRunAnchorKey('PRJ-C', body), '계약/a.pdf']])
  const entries = [...knownEntries.keys()].map((path) => ({ path, name: path.split('/').at(-1), size: 10, sha256: body }))
  const planned = planManifest({ entries, knownEntries, knownByChecksum, anchorKeyFor: destination, canCloseDuplicate })

  assert.deepEqual(planned.verdicts.map((entry) => entry.status), ['pending', 'pending', 'duplicate', 'duplicate'])
  assert.deepEqual(planned.entries, [], '아는 경로는 엔트리를 늘리지 않는다')
  // 되돌아온 파일이 그 프로젝트의 새 기준이 되고, 뒤따르는 같은 파일은 그쪽을 가리킨다(사본 두 벌 금지).
  assert.equal(planned.verdicts[2].duplicateOfPath, '설계/a.pdf')
  assert.equal(planned.verdicts[3].duplicateOfPath, '계약/a.pdf', '같은 프로젝트로 가는 중복은 그대로 닫힌다')
  assert.deepEqual(planned.updates, [
    { path: '설계/a.pdf', reopen: true },
    { path: '설계/b.pdf', duplicateOfPath: '설계/a.pdf' },
  ], '저장된 엔트리도 함께 바뀌어야 업로드가 ENTRY_SETTLED로 거절되지 않는다')
  assert.deepEqual(planned.duplicates, [], '같은 묶음 안의 기준에는 넓힐 문서가 없다')

  // 기본값은 '닫는다'다 — 판정을 주지 않으면 예전과 같은 답이 나온다.
  const untouched = planManifest({ entries, knownEntries: new Map(knownEntries), knownByChecksum: new Map() })
  assert.deepEqual(untouched.verdicts.map((entry) => entry.status), ['pending', 'duplicate', 'duplicate', 'duplicate'])
  assert.deepEqual(untouched.updates, [])
})

test('5-7. 지문 색인은 목적지별로 나뉘고, 먼저 정해진 기준을 덮지 않는다', () => {
  const body = sha('세 번 복사된 파일')
  const destination = (path) => (path.startsWith('계약') ? 'PRJ-C' : 'PRJ-D')
  const entry = (path) => ({ path, name: path.split('/').at(-1), size: 10, sha256: body })
  const canCloseDuplicate = (path, { otherPath }) => (otherPath ? destination(otherPath) === destination(path) : true)

  const planned = planManifest({
    entries: [entry('계약/1.pdf'), entry('설계/1.pdf'), entry('계약/2.pdf'), entry('설계/2.pdf')],
    anchorKeyFor: destination, canCloseDuplicate,
  })
  // 목적지가 다른 파일은 서로의 기준이 되지 않고, 같은 목적지의 두 번째 파일은 첫 파일로 닫힌다.
  assert.deepEqual(planned.verdicts.map((entry_) => entry_.status), ['pending', 'pending', 'duplicate', 'duplicate'])
  assert.equal(planned.verdicts[2].duplicateOfPath, '계약/1.pdf')
  assert.equal(planned.verdicts[3].duplicateOfPath, '설계/1.pdf')

  /**
   * 목적지를 모르는 채로도(주입 없음) 기준은 **먼저 정해진 것이 살아남는다.** 닫히지 못한 파일이
   * 기준을 가로채면 뒤따르는 같은 프로젝트의 파일이 엉뚱한 기준과 견주어져 사본이 두 벌 올라간다.
   */
  const shared = planManifest({
    entries: [entry('계약/1.pdf'), entry('설계/1.pdf'), entry('계약/2.pdf')],
    canCloseDuplicate,
  })
  assert.deepEqual(shared.verdicts.map((entry_) => entry_.status), ['pending', 'pending', 'duplicate'])
  assert.equal(shared.verdicts[2].duplicateOfPath, '계약/1.pdf')
})

test('5-8. 저장된 세션의 표는 한 행 때문에 통째로 비워지지 않는다', () => {
  /**
   * 빈 표에서는 모든 경로가 기본 행(대상 프로젝트 없음)으로 떨어진다 — 못 읽었다는 사실이
   * '전 직원 공개'로 조용히 번역되는 자리다. 상한이 내려가기 전에 저장된 태그 행은 잘라서 읽는다.
   */
  const legacy = [{ folderPrefix: 'Flow/계약', projectId: 'PRJ-CONTRACT', tags: Array.from({ length: MAX_TAGS_PER_MAPPING }, (_, index) => `t${index}`), aiLevel: 'locked' }]
  assert.equal(normalizeMapping(legacy).path, 'mapping[0].tags', '쓰기 경로는 말없이 버리지 않는다')
  const lenient = normalizeMapping(legacy, { lenient: true })
  assert.equal(lenient.path, undefined)
  assert.equal(lenient.mapping[0].projectId, 'PRJ-CONTRACT', '프로젝트 귀속이 살아남아야 전사 공개로 떨어지지 않는다')
  assert.equal(lenient.mapping[0].tags.length, MAX_USER_TAGS_PER_MAPPING)
  // 예약 태그 두 칸을 더해도 문서 상한 안이다 — 자르는 곳은 normalizeMapping 한 곳뿐이다.
  assert.equal(documentFieldsFor(lenient.mapping[0], { sessionId: 'IMP-1' }).tags.length, MAX_TAGS_PER_MAPPING)
})

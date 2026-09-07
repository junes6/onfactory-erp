import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { appendUncoveredRows, childFolders, countByMapping, detectFolders, withRowIds } from '../src/utils/bulkImport.ts'

/**
 * 벌크 이관 화면의 계약.
 *
 * 브라우저 없이 잠글 수 있는 것만 여기서 잠근다: 상수의 동치, IME 규칙, 순차 업로드,
 * 접근성 속성, 그리고 '롤백하지 않는다'는 결정. 눈으로 봐야 하는 것은 브라우저 판정으로 남긴다.
 */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const count = (source, needle) => source.split(needle).length - 1

test('1. 클라이언트 상수는 서버 상수와 같은 값이다', async () => {
  const client = await read('src/utils/bulkImport.ts')
  const server = await read('server/bulk-import.mjs')
  const serverPage = Number(/export const MAX_MANIFEST_PAGE = ([\d_]+)/.exec(server)?.[1]?.replaceAll('_', ''))
  const clientPage = Number(/export const MANIFEST_CHUNK = ([\d_]+)/.exec(client)?.[1]?.replaceAll('_', ''))
  assert.equal(clientPage, serverPage, '매니페스트 페이지 크기가 다르면 화면이 보낸 목록을 서버가 413으로 거절한다')
  const serverBytes = /export const MAX_BULK_FILE_BYTES = ([^\n]+)/.exec(server)?.[1]?.trim()
  const clientBytes = /export const MAX_BULK_FILE_BYTES = ([^\n]+)/.exec(client)?.[1]?.trim()
  assert.equal(clientBytes, serverBytes, '10MB 상한이 다르면 올렸다가 500을 받는다')
  // 서버 라우트가 받는 진행 보고 상한보다 배치가 크면 그 요청은 통째로 거절된다.
  const serverResults = Number(/export const MAX_PROGRESS_RESULTS = ([\d_]+)/.exec(server)?.[1]?.replaceAll('_', ''))
  const clientBatch = Number(/export const PROGRESS_BATCH = ([\d_]+)/.exec(client)?.[1]?.replaceAll('_', ''))
  assert.ok(clientBatch <= serverResults, `${clientBatch} <= ${serverResults}`)
})

test("2. AI 처리 수준 라벨은 서버와 글자까지 같다", async () => {
  const client = await read('src/utils/bulkImport.ts')
  const server = await read('server/document-ai-policy.mjs')
  assert.match(client, /AI_POLICY_LABELS: Record<BulkAiLevel, string> = \{ locked: '보관만', indexed: '정리', active: '활용' \}/)
  assert.match(server, /AI_POLICY_LABELS = Object\.freeze\(\{ locked: '보관만', indexed: '정리', active: '활용' \}\)/)
  assert.match(client, /AI_POLICY_ORDER: BulkAiLevel\[\] = \['locked', 'indexed', 'active'\]/)
})

test('3. webkitdirectory는 ref로 켠다 — JSX 속성으로는 조용히 무시된다', async () => {
  const source = await read('src/components/BulkImport.tsx')
  assert.match(source, /setAttribute\('webkitdirectory', ''\)/)
  assert.equal(count(source, 'webkitdirectory='), 0, 'JSX 속성으로 적으면 타입 오류이거나 무시된다')
})

test('4. 드로어 층의 primary는 하나뿐이고, 목록 카드를 흉내 내지 않는다', async () => {
  const source = await read('src/components/BulkImport.tsx')
  assert.equal(count(source, 'tone="primary"'), 1)
  assert.equal(count(source, '<article'), 0, '드로어는 자료실 목록 카드가 아니다')
  assert.match(source, /tone="primary"[\s\S]{0,120}\{paused \? '이어서 올리기' : '이관 시작'\}/)
})

test('5. 진행률은 스크린리더가 읽을 수 있고, 파일명은 읽어 주지 않는다', async () => {
  const source = await read('src/components/BulkImport.tsx')
  assert.match(source, /role="progressbar"/)
  assert.match(source, /aria-valuenow=\{counterValue\}/)
  assert.match(source, /aria-valuemin=\{0\}/)
  assert.match(source, /aria-valuemax=\{total\}/)
  // 숫자 줄 하나만 polite다. 200개 파일명이 스크린리더로 쏟아지면 아무도 그 화면을 쓰지 못한다.
  assert.equal(count(source, 'aria-live="polite"'), 1)
  assert.equal(count(source, 'aria-live="off"'), 1)
  assert.match(source, /aria-current': 'step'/)
  assert.match(source, /role="dialog" aria-modal="true" aria-labelledby="bulk-import-title"/)
})

test('6-1. 화면은 이미 한 일을 계속 시키지 않는다 — 안내와 임시 입력을 제때 지운다', async () => {
  const source = await read('src/components/BulkImport.tsx')
  /**
   * '같은 폴더를 다시 선택해 주세요'는 그렇게 한 순간 사실이 아니게 된다. 지우지 않으면 확인·매핑·
   * 올리기·보고서까지 따라다니며 이미 한 일을 계속 시킨다. 지문 없는 주소의 경고는 그 뒤에 다시 뜬다.
   */
  assert.match(source, /setProblem\(''\)\s*(?:\/\/[^\n]*\n\s*)*setNotice\(''\)[\s\S]{0,900}if \(!subtleAvailable\(\)\) setNotice\(NO_SUBTLE_MESSAGE\)/)
  // blur의 정규화 결과가 칸에도 보여야 한다 — 'a, a, '가 남아 있으면 표가 보낼 값과 다른 것을 보여 준다.
  assert.match(source, /const tags = splitTags\(event\.target\.value\)[\s\S]{0,400}delete next\[rowKey\(row, index\)\]/)
})

test('6. 태그 입력의 onChange는 쪼개지 않는다 (IME 규칙)', async () => {
  const source = await read('src/components/BulkImport.tsx')
  const onChange = /onChange=\{\(event\) => \{\s*const draft = event\.target\.value\s*setTagDrafts\(\(previous\) => \(\{ \.\.\.previous, \[rowKey\(row, index\)\]: draft \}\)\)\s*\}\}/
  assert.match(source, onChange, '태그 onChange는 값을 그대로 담기만 한다')
  // 쉼표 분해는 blur에서만 한다 — onChange에서 하면 한글 조합 중에 입력이 끊긴다.
  assert.match(source, /onBlur=\{\(event\) => \{\s*const tags = splitTags\(event\.target\.value\)/)
  const splitTagsBody = /export function splitTags[\s\S]*?\n\}/.exec(await read('src/utils/bulkImport.ts'))?.[0] ?? ''
  assert.match(splitTagsBody, /\.split\(','\)/, '분해는 유틸 한 곳에서만 한다')
})

test('7. 업로드는 순차이고, 실패해도 앞선 성공을 되돌리지 않는다', async () => {
  const source = await read('src/components/BulkImport.tsx')
  // 동시성 1: 서버가 파일 전체를 힙 Buffer로 받으므로 벌크가 서버를 밀어내면 안 된다.
  assert.equal(count(source, 'Promise.all('), 0)
  // 200개짜리 이관에서 전량 롤백은 재앙이다(190개 성공 뒤 하나 실패하면 190개를 지운다).
  assert.equal(count(source, 'uploadDocumentAttachments'), 0)
  assert.match(source, /\*\*롤백하지 않는다\.\*\*/)
})

test('8. 정직하게 말하는 문장들이 화면에 있다', async () => {
  const utils = await read('src/utils/bulkImport.ts')
  const source = await read('src/components/BulkImport.tsx')
  assert.match(utils, /이 주소\(http\)에서는/)
  assert.match(utils, /같은 폴더를 다시 선택해 주세요/)
  assert.match(source, /실패한 파일만 다시 시도/)
  assert.match(source, /연결이 불안정해 잠시 멈췄습니다/)
  assert.match(source, /매핑은 폴더 접두 기준이고, 가장 깊은 행이 이깁니다/)
  assert.match(source, /보관만: AI가 열지 않습니다/)
  // 끝난 보고서에서 나가는 문이 있어야 이 드로어가 한 번 쓰고 마는 화면이 되지 않는다.
  assert.match(source, /새 폴더 고르기/)
  // 같은 화면에 뜻이 다른 '취소'가 둘이면 무엇이 멈추는지 알 수 없다.
  assert.match(source, /이관 중단/)
  assert.equal(count(source, '>취소<'), 1)
})

test('8-1. 한 사실은 한 문장에서 나온다 — 서버 상수와 글자까지 같다', async () => {
  const utils = await read('src/utils/bulkImport.ts')
  const source = await read('src/components/BulkImport.tsx')
  const server = await read('server/bulk-import.mjs')
  const pick = (text, name) => new RegExp(`${name} = '([^']*)'`).exec(text)?.[1]
  for (const name of ['ABANDONED_MESSAGE', 'OVERSIZE_MESSAGE', 'UNMAPPED_MESSAGE', 'UNFINISHED_MESSAGE']) {
    const serverText = pick(server, `export const ${name}`)
    assert.ok(serverText, `${name}을 서버 소스에서 찾지 못했다`)
    assert.equal(pick(utils, `export const ${name}`), serverText, `${name}이 두 곳에서 다르면 화면과 보고서가 다른 말을 한다`)
  }
  // 문장을 화면이 다시 쓰지 않고 상수를 쓴다.
  assert.match(source, /error: ABANDONED_MESSAGE/)
  assert.match(utils, /reason: OVERSIZE_MESSAGE/)
  assert.match(source, /\{canChooseLibrary \? '자료실\(전 직원\)로 올라갑니다\.' : UNMAPPED_MESSAGE\}/)
  // 되돌릴 수 없는 '이관 중단'은 한 번 묻고, 그 확인 문장이 말하는 결과는 서버가 새기는 문장 그대로다.
  assert.match(source, /window\.confirm\([\s\S]{0,200}\$\{UNFINISHED_MESSAGE\}[\s\S]{0,40}\)\) return\s*cancelledRef\.current = true/)
  // 상한을 두 이름으로 적지 않는다: 문장은 '10MB', 다른 줄은 '10.0 MB'가 되지 않게 같은 표기를 쓴다.
  assert.match(utils, /MAX_BULK_FILE_LABEL = '10MB'/)
  assert.ok(pick(server, 'export const OVERSIZE_MESSAGE').startsWith('10MB'))
  assert.match(source, /\{MAX_BULK_FILE_LABEL\}까지 올릴 수 있습니다/)
  // 이미 끝난 엔트리의 409는 연결 실패가 아니다 — 코드가 어긋나면 재개가 스스로 멈춘다.
  const serverCode = /ENTRY_SETTLED: \{ status: 409, code: '([^']+)'/.exec(server)?.[1]
  assert.equal(pick(utils, 'export const ENTRY_SETTLED_CODE'), serverCode)
  // 매핑 행 상한도 같은 값이어야 한다 — 넘겨 보내면 표 전체가 400으로 거절된다.
  const serverRows = Number(/export const MAX_MAPPING_ROWS = ([\d_]+)/.exec(server)?.[1]?.replaceAll('_', ''))
  const clientRows = Number(/export const MAX_MAPPING_ROWS = ([\d_]+)/.exec(utils)?.[1]?.replaceAll('_', ''))
  assert.equal(clientRows, serverRows)
  // 마감이 남긴 파일의 문장은 '다시 선택하지 않았습니다'가 아니다 — 중단한 사람은 폴더를 고른 채 멈췄다.
  assert.ok(pick(server, 'export const UNFINISHED_MESSAGE'))
  assert.notEqual(pick(server, 'export const UNFINISHED_MESSAGE'), pick(server, 'export const ABANDONED_MESSAGE'))
})

test('8-2. 올릴 목록은 한 건이 끝날 때마다 갱신된다 — 재개가 이미 올린 파일을 다시 보내지 않는다', async () => {
  const source = await read('src/components/BulkImport.tsx')
  // 큐는 매니페스트 판정이 아니라 **지금까지의 결과가 반영된 목록**에서 만든다.
  assert.match(source, /const queue = plannedRef\.current\.filter/)
  assert.match(source, /entry\.status === 'pending' \|\| entry\.status === 'failed'/)
  assert.match(source, /!settledRef\.current\.has\(entry\.path\)/)
  // 성공한 것만 settled다 — 실패는 다시 시도해야 화면의 문장이 사실이 된다.
  assert.match(source, /if \(status === 'uploaded' \|\| status === 'duplicate'\) settledRef\.current\.add\(path\)/)
  // 이미 끝났다는 409는 연속 실패로 세지 않는다.
  assert.match(source, /code === ENTRY_SETTLED_CODE[\s\S]{0,600}clearStreak\(\)/)
  /**
   * 서버가 답한 거절(매핑에 없는 폴더 등)은 연결 문제가 아니다. 한 counter로 세면 화면이
   * '연결이 불안정해 잠시 멈췄습니다'라고 거짓말을 한다 — 멈춘 이유는 서버의 문장 그대로 말한다.
   */
  assert.match(source, /let consecutiveRefusals = 0/)
  assert.match(source, /consecutiveRefusals >= MAX_CONSECUTIVE_FAILURES[\s\S]{0,400}\$\{lastRefusal\}/)
})

test('9. 모르면 남은 시간을 아예 쓰지 않는다', async () => {
  const utils = await read('src/utils/bulkImport.ts')
  const body = /export function remainingLabel[\s\S]*?\n\}/.exec(utils)?.[0] ?? ''
  assert.match(body, /if \(recentMs\.length < 3 \|\| remaining <= 0\) return ''/)
  assert.match(body, /남은 시간 약/)
})

test('10. 자료실 화면: 진입은 secondary 하나, 드로어는 한 번만 붙는다', async () => {
  const source = await read('src/components/CompanyLibrary.tsx')
  assert.equal(count(source, '<BulkImportDialog'), 1)
  assert.match(source, /<Button tone="secondary" type="button" onClick=\{\(\) => openBulk\(null\)\}><FolderUp size=\{18\} \/> 폴더 통째로 올리기<\/Button>/)
  // 화면의 기본 행동은 여전히 '자료 업로드' 하나다(모달 층의 제출 버튼은 그 층의 기본 행동이다).
  assert.equal(count(source, '<Button tone="primary" type="button" onClick={() => setEditing(\'new\')}>'), 1)
  assert.match(source, /className="library-import-strip"/)
  /**
   * 문이 둘이면 여는 것도 둘이다. '폴더 통째로 올리기'가 언제나 마지막 세션을 넘기면
   * 이관을 한 번 끝낸 워크스페이스에서는 새 이관을 시작할 수 없다 — 드로어가 끝난 보고서로 열린다.
   */
  assert.match(source, /openBulk\(session\.id\)/)
  assert.equal(count(source, 'openBulk(lastImport'), 0)
  assert.match(source, /resumeSessionId=\{bulkResumeId\}/)
  assert.equal(count(source, 'resumeSessionId={lastImport'), 0)
  /**
   * 마지막 이관만 열 수 있으면, 두 번째 이관이 끝나는 순간 첫 이관의 폴더는 '정리 수준으로 올리기'를
   * 영영 못 만난다(그 버튼은 보고서 화면에만 있다). 그래서 그 앞의 이관도 접힌 목록으로 남긴다.
   */
  assert.match(source, /const olderImports = bulkSessions\.slice\(1\)/)
  assert.match(source, /olderImports\.map\(\(session\) => <li key=\{session\.id\}/)
  assert.equal(count(source, '<Button tone="quiet" size="sm" type="button" onClick={() => openBulk('), 1, '줄마다 같은 문을 그리므로 버튼은 한 벌만 적는다')
})

test("11. 목록은 원본 경로를 보여 주고, '보관만'에는 AI 버튼을 그리지 않는다", async () => {
  const source = await read('src/components/CompanyLibrary.tsx')
  assert.match(source, /className="library-source-path" title=\{document\.sourcePath\}/)
  assert.match(source, /className="library-ai-locked"/)
  // 눌렀다가 409를 받는 대신 애초에 없다.
  assert.match(source, /canRunLensOn\(document\.mime\) && aiLevelOf\(document\) !== 'locked'/)
  // 값이 없는 옛 문서는 '활용' — 어제까지 되던 버튼이 오늘 사라지지 않는다.
  assert.match(source, /const aiLevelOf = [\s\S]{0,200}: 'active'/)
  // AI 검색이 보내는 후보 목록에서도 '보관만'은 빠진다 — 이름·태그·요약만으로도 상대와 금액이 드러난다.
  assert.match(source, /accessibleDocuments: documents\.filter\(\(item\) => aiLevelOf\(item\) !== 'locked'\)\.map/)
  const css = await read('src/components/CompanyLibrary.css')
  assert.match(css, /\.library-source-path/)
  assert.match(css, /\.library-ai-locked/)
  assert.match(css, /\.library-import-strip/)
})

test('12. 게스트 화면은 원본 경로를 아예 읽지 않는다', async () => {
  const source = await read('src/components/GuestWorkspace.tsx')
  assert.match(source, /sourcePath\?: never/)
  assert.match(source, /importId\?: never/)
  // 타입만 막는 것이 아니라 서버가 지운다 — 그 사실이 app.mjs에도 남아 있어야 한다.
  const server = await read('server/app.mjs')
  assert.match(server, /const \{ sourcePath: _sourcePath, importId: _importId, \.\.\.safe \} = document/)
})

test('13. CSS는 토큰만 쓰고 공용 버튼의 모양을 다시 정의하지 않는다', async () => {
  const css = await read('src/components/BulkImport.css')
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/)
  // 공용 버튼은 배치만 바꿀 수 있다 — 크기·색은 tone/size prop이 정한다(verify-button-tone과 같은 규칙).
  for (const rule of css.matchAll(/([^{}]*\.ui-button[^{}]*)\{([^{}]*)\}/g)) {
    for (const declaration of rule[2].matchAll(/([\w-]+)\s*:/g)) {
      assert.match(declaration[1], /^(?:margin|width|min-width|max-width|flex|order)/, `${rule[1].trim()} → ${declaration[1]}`)
    }
  }
  assert.match(css, /var\(--radius-8\)/)
  assert.match(css, /var\(--hairline\)/)
})

const bulkFiles = (paths) => paths.map((path) => ({ file: null, path, name: path.split('/').at(-1), size: 1 }))

test('14. 표는 더 깊은 폴더로 나눌 수 있다 — 첫 단계 이름 하나로 통째 이관이 되지 않는다', () => {
  /**
   * webkitdirectory로 폴더를 고르면 **모든 경로가 같은 첫 단계**를 갖는다('Flow/…').
   * 첫 단계만으로 표를 만들면 행이 하나뿐이라 '계약 → 프로젝트A, 설계 → 프로젝트B'를 화면에서 만들 수 없다.
   * 서버는 그 매핑을 이미 이해한다(가장 긴 접두가 이긴다) — 화면만 못 만들고 있었다.
   */
  const files = bulkFiles(['Flow/계약/2025/a.pdf', 'Flow/계약/2024/b.pdf', 'Flow/설계/도면/c.dwg', 'Flow/잡자료/d.txt'])
  assert.deepEqual(detectFolders(files), ['Flow'], '첫 행은 하나뿐이다 — 그래서 나누는 칸이 필요하다')
  assert.deepEqual(childFolders(files, 'Flow'), [
    { folderPrefix: 'Flow/계약', files: 2 },
    { folderPrefix: 'Flow/설계', files: 1 },
    { folderPrefix: 'Flow/잡자료', files: 1 },
  ])
  // 나눈 행은 서버와 같은 규칙으로 세어진다 — 표의 합이 고른 파일 수와 맞는다.
  const row = (folderPrefix) => ({ folderPrefix, projectId: null, tags: [], aiLevel: 'locked' })
  const counts = countByMapping(files, [row('Flow'), row('Flow/계약')])
  assert.deepEqual(counts.counts, [2, 2])
  assert.equal(counts.unmapped, 0)
  // 더 깊은 폴더도 계속 나눌 수 있다.
  assert.deepEqual(childFolders(files, 'Flow/계약'), [{ folderPrefix: 'Flow/계약/2024', files: 1 }, { folderPrefix: 'Flow/계약/2025', files: 1 }])
  // 파일만 있는 폴더에는 나눌 것이 없다 — 빈 칸을 그리지 않는다.
  assert.deepEqual(childFolders(files, 'Flow/잡자료'), [])
  // 최상위 행('')에서도 첫 단계가 나온다(파일 선택으로 고른 목록).
  assert.deepEqual(childFolders(files, ''), [{ folderPrefix: 'Flow', files: 4 }])
})

test('14-1. 행의 키는 폴더 이름이 아니다 — 행이 끼어들어도 입력이 다시 마운트되지 않는다', () => {
  const rows = withRowIds([{ folderPrefix: 'Flow', projectId: null, tags: [], aiLevel: 'locked' }, { folderPrefix: '', projectId: null, tags: [], aiLevel: 'locked' }])
  assert.equal(new Set(rows.map((item) => item.rowId)).size, 2)
  assert.ok(rows.every((item) => item.rowId))
  // 이미 키가 있는 행은 그대로 둔다 — 새로 만들면 렌더마다 표 전체가 다시 마운트된다.
  assert.deepEqual(withRowIds(rows).map((item) => item.rowId), rows.map((item) => item.rowId))
  // 규칙을 불러와도(서버가 준 행에는 키가 없다) 키가 채워진다.
  const loaded = appendUncoveredRows([{ folderPrefix: '작년폴더', projectId: null, tags: [], aiLevel: 'locked' }], bulkFiles(['Flow/a.pdf']))
  assert.ok(loaded.every((item) => item.rowId))
  assert.deepEqual(loaded.map((item) => item.folderPrefix), ['작년폴더', 'Flow'])
})

test('15. 실행 중에는 목록을 갈지 않는다 — 화면의 숫자가 거짓이 되지 않게', async () => {
  const source = await read('src/components/BulkImport.tsx')
  /**
   * acceptFiles는 plannedRef를 비운다. 올리는 중에 그것이 비면 진행 표시가 0에서 멈추고,
   * 이어서 올리기가 빈 목록을 걸은 뒤 마감을 불러 시도조차 하지 않은 파일을 실패로 닫는다.
   */
  assert.match(source, /const acceptFiles = \(picked: BulkFile\[\]\) => \{[\s\S]{0,600}if \(busy \|\| phase === 'scan' \|\| phase === 'upload'\) return/)
  assert.match(source, /const onDrop = async \(event: DragEvent<HTMLDivElement>\) => \{[\s\S]{0,400}if \(busy \|\| phase === 'scan' \|\| phase === 'upload'\) return/)
  // 버튼과 드롭 영역이 같은 방식으로 거절한다.
  assert.match(source, /<Button tone="secondary" disabled=\{busy\} onClick=\{\(\) => folderInputRef\.current\?\.click\(\)\}>폴더 선택<\/Button>/)
  assert.match(source, /<Button tone="ghost" disabled=\{busy\} onClick=\{\(\) => fileInputRef\.current\?\.click\(\)\}>파일 선택<\/Button>/)
  // 같은 폴더를 다시 고를 수 있어야 한다 — 값을 비우지 않으면 change가 아예 발생하지 않는다.
  assert.equal(count(source, "event.target.value = ''"), 2)
})

test('16. 올릴 목록이 비면 마감하지 않는다 — 마감은 되돌릴 수 없다', async () => {
  const source = await read('src/components/BulkImport.tsx')
  /**
   * 매니페스트 한 페이지가 실패하면 plannedRef가 빈 채로 매핑 표에 서게 된다. 그대로 '이관 시작'을
   * 누르면 아무것도 올리지 않고 마감이 불려 서버가 전량을 '실패'로 닫고 세션은 종료 상태가 된다.
   */
  // 목록이 고른 파일을 다 담고 있지 않으면 다시 훑는다 — 빈 목록도, 표에서 더 고른 폴더도 여기 걸린다.
  assert.match(source, /const plannedPaths = new Set\(plannedRef\.current\.map\(\(entry\) => entry\.path\)\)/)
  assert.match(source, /const planIncomplete = files\.some\(\(item\) => !plannedPaths\.has\(item\.path\)\)/)
  assert.match(source, /if \(!sessionRef\.current \|\| planIncomplete\) await scanFiles\(files, mapping\)/)
  assert.equal(count(source, 'if (!plannedRef.current.length && files.length > 0)'), 2, '다시 훑은 뒤에도, 마감 직전에도 본다')
  assert.match(source, /PLAN_MISSING_MESSAGE/)
})

test('17. 중단은 멈춤이 아니다 — 두 버튼이 같은 결과를 내지 않는다', async () => {
  const source = await read('src/components/BulkImport.tsx')
  // 멈춤만 paused로 돌아간다. 중단은 아래로 흘러 마감으로 간다(재개 버튼이 남지 않는다).
  assert.match(source, /if \(pausedRef\.current && !cancelledRef\.current\) \{\s*await call\('PATCH', `\/api\/bulk-imports\/\$\{active\.id\}`, \{ status: 'paused' \}\)/)
  // 드로어를 닫으면 이 화면이 시작한 일도 멈춘다 — 다만 올리는 중이면 재개할 수 있게 세운다.
  assert.match(source, /if \(phase === 'scan'\) cancelledRef\.current = true\s*if \(phase === 'upload'\) \{ pausedRef\.current = true; setPaused\(true\) \}/)
  // 확인 단계의 반복문도 그 표시를 본다 — 닫힌 화면 뒤에서 계속 해싱하지 않는다.
  assert.equal(count(source, 'if (cancelledRef.current) return'), 2)
  /**
   * 닫는 문은 넷(Esc · 배경 · 머리말 X · 바닥의 '취소')이고 **한 handler를 함께 쓴다**.
   * 각자 닫으면 Esc로 닫은 화면 뒤에서 1.4GB를 계속 해싱하거나 업로드가 끝까지 굴러 저 혼자 마감된다.
   */
  assert.match(source, /const closeDrawer = \(\) => \{/)
  assert.match(source, /useDrawer\(closeDrawer\)/)
  assert.match(source, /onMouseDown=\{\(event\) => event\.target === event\.currentTarget && closeDrawer\(\)\}/)
  assert.match(source, /<IconButton aria-label="닫기" onClick=\{closeDrawer\}>/)
  assert.match(source, /<Button tone="ghost" onClick=\{closeDrawer\}>취소<\/Button>/)
  assert.equal(count(source, 'onClose()'), 1, '닫는 일 자체는 한 곳에서만 부른다')
})

test('17-1. 일시 중지 뒤의 ‘이관 중단’도 실제로 끝낸다 — 표시만 세우면 아무 일도 일어나지 않는다', async () => {
  const source = await read('src/components/BulkImport.tsx')
  /**
   * 멈춰 있을 때 cancelledRef만 세우면 그 표시를 읽을 루프가 없다. 세션은 paused로 남고
   * 자료실 목록에는 '이어서 올리기'가 다시 뜬다 — 확인 문장('다시 이어서 올릴 수 없습니다')이 거짓이 된다.
   */
  assert.match(source, /cancelledRef\.current = true\s*(?:\/\/[^\n]*\n\s*)*if \(!busy\) void abortImport\(\)/)
  assert.match(source, /const abortImport = async \(\) => \{[\s\S]{0,400}await finishImport\(active\)/)
  // 마감은 한 함수에서만 부른다 — 루프의 꼬리와 중단 버튼이 갈라지면 한쪽만 고쳐진다.
  assert.match(source, /const finishImport = async \(active: SessionView\) => \{\s*const finished = await call\('POST', `\/api\/bulk-imports\/\$\{active\.id\}\/finish`\)/)
  assert.equal(count(source, '/finish`'), 1)
  // 끝난 이관 위에 '이어서 올리기'가 남지 않는다.
  assert.match(source, /setReport\(finished\.body\?\.report as ReportView\)[\s\S]{0,200}setPaused\(false\)/)
})

test('24. 보고서 화면은 알 수 없는 숫자를 그리지 않고, 넓힌 사실은 남는다', async () => {
  const source = await read('src/components/BulkImport.tsx')
  /**
   * 다시 연 보고서에는 파일 목록이 없다(서버는 매핑과 보고서만 돌려준다). 그 위에 매핑 표를 그리면
   * 모든 행이 '0개'가 되고, 바로 아래 보고서 표는 같은 폴더에 110개라고 적는다 — 한 화면의 두 표가 다투게 된다.
   */
  assert.match(source, /\{\(phase === 'map' \|\| phase === 'upload'\) && <section className="bulk-import-mapping">/)
  /**
   * 넓힌 건수는 더한다. grantDocumentAccess는 멱등이라 두 번째 판정은 0을 돌려주고,
   * 갈아 끼우면 방금 사람에게 알린 범위 변경의 기록이 같은 화면에서 사라진다.
   */
  assert.match(source, /setWidened\(\(previous\) => previous \+ accessWidened\)/)
  assert.equal(count(source, 'setWidened(0)'), 3, '세션이 바뀔 때(새 폴더·처음부터·실패분 재시도)만 0이다')
  // 한 사실은 한 문장에서 나온다 — 확인 화면과 보고서가 같은 함수를 쓴다.
  assert.equal(count(source, '{widenedSentence(widened)}'), 2)
  assert.equal(count(source, '범위를 넓혔습니다.'), 1)
  assert.match(source, /초대된 외부 게스트 포함/)
})

test('18. 보고서의 실패 목록에는 보내지 않은 파일도 있다', async () => {
  const source = await read('src/components/BulkImport.tsx')
  const utils = await read('src/utils/bulkImport.ts')
  const server = await read('server/bulk-import.mjs')
  /**
   * 10MB를 넘는 파일과 경로가 400자를 넘는 파일은 매니페스트에 담기지 않으므로 서버의 실패 목록에 없다.
   * 그 목록만 그리면 '올라가지 않은 파일'의 일부가 보고서 어디에도 없다. 이유는 파일마다 다르므로
   * 한 줄로 뭉뚱그리지 않고 그 파일의 이유를 그대로 적는다.
   */
  assert.match(source, /\{\(report\.failed > 0 \|\| notSent\.length > 0\) && <details/)
  assert.match(source, /보내지 않은 파일 \$\{notSent\.length\}개/)
  // 동료에게 붙여 넣는 글에도 같은 줄이 들어간다.
  assert.match(source, /\.\.\.notSent\.map\(\(item\) => `\$\{item\.path\} — \$\{item\.reason\}`\)/)
  /**
   * 경로가 긴 파일 한 건은 그 페이지 **200건을 통째로** 400으로 만든다. 미리 가르지 않으면
   * 나머지 199건도 올라가지 못하고, 서버 문장('폴더를 다시 선택해 주세요')대로 해도 결과가 같다.
   */
  const serverLength = Number(/export const MAX_PATH_LENGTH = ([\d_]+)/.exec(server)?.[1]?.replaceAll('_', ''))
  const clientLength = Number(/export const MAX_PATH_LENGTH = ([\d_]+)/.exec(utils)?.[1]?.replaceAll('_', ''))
  assert.equal(clientLength, serverLength)
  assert.match(utils, /item\.path\.length > MAX_PATH_LENGTH\) notSent\.push\(\{ \.\.\.item, reason: PATH_TOO_LONG_MESSAGE \}\)/)
  assert.match(source, /const \{ sendable: withinLimit, notSent: skipped \} = splitSendable\(picked\)/)
  // 그래도 서버가 페이지를 거절하면 몇 번째 항목인지를 경로로 옮겨 적는다 — 제어문자 같은 갈래가 남는다.
  assert.match(source, /const culprit = Number\.isSafeInteger\(index\) \? page\[index\]\?\.path : ''/)
})

test('20. 태그 상한은 서버가 예약 칸을 뺀 수와 같다 — 말없이 사라지는 태그가 없다', async () => {
  const utils = await read('src/utils/bulkImport.ts')
  const server = await read('server/bulk-import.mjs')
  const serverTags = Number(/export const MAX_TAGS_PER_MAPPING = ([\d_]+)/.exec(server)?.[1]?.replaceAll('_', ''))
  const clientTags = Number(/export const MAX_MAPPING_TAGS = ([\d_]+)/.exec(utils)?.[1]?.replaceAll('_', ''))
  assert.equal(clientTags, serverTags - 2, "서버는 'bulk-import'와 'import:<세션>' 두 칸을 예약한다")
  assert.match(utils, /\.slice\(0, MAX_MAPPING_TAGS\)/)
})

test('21. 죽은 저장·죽은 타입을 남기지 않는다', async () => {
  const source = await read('src/components/BulkImport.tsx')
  const utils = await read('src/utils/bulkImport.ts')
  /**
   * 재개의 진실은 서버 목록(GET /api/bulk-imports)이다. 아무도 읽지 않는 sessionStorage 저장은
   * '복구 경로가 있다'는 인상만 남기고, 다음 사람이 그 인상 위에 코드를 얹는다.
   */
  assert.equal(count(source, 'window.sessionStorage'), 0)
  assert.equal(count(source, 'SESSION_STORAGE_KEY'), 0)
  assert.equal(count(utils, 'ManifestVerdict'), 0, '아무도 쓰지 않는 타입은 계약이 아니다')
})

test('22. 되돌릴 수 없는 거절에는 화면 안에 나가는 문이 있다', async () => {
  const source = await read('src/components/BulkImport.tsx')
  const utils = await read('src/utils/bulkImport.ts')
  const server = await read('server/bulk-import.mjs')
  // 엔트리 상한에 걸린 세션은 무엇을 다시 보내도 같은 답이다 — '폴더를 나눠 올려 주세요'를 여기서 할 수 있어야 한다.
  const serverCode = /ENTRY_LIMIT: \{ status: 409, code: '([^']+)'/.exec(server)?.[1]
  assert.equal(/export const ENTRY_LIMIT_CODE = '([^']*)'/.exec(utils)?.[1], serverCode)
  assert.match(source, /if \(errorCode\(result\.body\) === ENTRY_LIMIT_CODE\) setDeadEnd\(true\)/)
  assert.match(source, /\{deadEnd && <Button tone="secondary" onClick=\{\(\) => startOver\(\)\}>새 폴더 고르기<\/Button>\}/)
  // 세션 기록 상한의 문장이 시키는 일('끝난 이관 기록을 지워 주세요')도 화면에 문이 있어야 한다.
  const library = await read('src/components/CompanyLibrary.tsx')
  assert.match(library, /이관 기록 지우기/)
  assert.match(library, /method: 'DELETE' \}\)\s*const body = await response\.json\(\) as \{ message\?: string/)
  /**
   * 그 문은 **끝난 줄이면 어느 줄에나** 있어야 한다. 맨 위 한 줄에만 두면, 맨 위가 아직 올리는 중인
   * 테넌트는 상한에 닿은 채로 '끝난 이관 기록을 지워 주세요'라는 문장 앞에서 할 수 있는 일이 없다.
   */
  assert.match(library, /const importRow = \(session: BulkSessionSummary\) => \{[\s\S]{0,900}이관 기록 지우기/)
  assert.match(library, /const unfinished = session\.status !== 'done' && session\.status !== 'failed'/)
})

test('23. 매핑을 고치면 다시 판정한다 — 지문은 다시 만들지 않는다', async () => {
  const source = await read('src/components/BulkImport.tsx')
  /**
   * 첫 매니페스트는 자동 감지 매핑(대상 프로젝트 없음)으로 간다. 표는 그 뒤에 그려지므로,
   * 매핑이 바뀐 채로 올리면 '이미 있는 자료의 열람 범위를 넓혔습니다'가 관리자에게는 영영 일어나지 않고
   * 그 프로젝트에서 열리지 않는 중복은 건너뛴 채로 남는다.
   */
  assert.match(source, /if \(mappingSignature\(active\.mapping \?\? \[\]\) !== judgedMappingRef\.current\)/)
  assert.match(source, /const rejudge = async \(active: SessionView\) => \{[\s\S]{0,400}submitManifest\(active, entries, \{ resuming: false/)
  // 다시 판정할 때 파일을 다시 해싱하지 않는다 — 1.4GB짜리 폴더에서 그 한 줄이 화면을 멈춰 세운다.
  assert.equal(count(source, 'sha256File('), 1)
  // 재개 큐는 서버가 아직 pending으로 아는 엔트리 전부다 — 다시 고르지 않은 파일도 화면이 셀 수 있어야 한다.
  assert.match(source, /\.\.\.\[\.\.\.resumed\.pending\.values\(\)\]\.filter\(\(entry\) => !judged\.has\(entry\.path\)\)/)
  assert.match(source, /선택한 폴더에서 \{queueSize - missing\.length\}개를 찾았습니다/)
})

test('19. 서버가 읽지 않는 지문 헤더는 보내지 않는다', async () => {
  /**
   * 서버는 **매니페스트에 적힌 해시**와 본문을 대조한다(app.mjs의 bulk.entry.sha256).
   * 요청이 스스로 주장하는 헤더는 어느 라우트도 읽지 않는다 — 보내 두면 다음 사람이
   * '검사하고 있다'고 믿고, 매니페스트 없는 업로드 경로에 그 믿음을 그대로 얹는다.
   */
  const source = await read('src/components/BulkImport.tsx')
  const server = await read('server/app.mjs')
  assert.equal(count(source, 'x-file-sha256'), 0)
  assert.equal(count(server, 'x-file-sha256'), 0)
  assert.match(server, /bulk\?\.entry\?\.sha256 && bodyHash !== bulk\.entry\.sha256/)
})

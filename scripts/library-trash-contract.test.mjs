import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const library = read('src/components/CompanyLibrary.tsx')
const server = read('server/app.mjs')

test('자료실 [삭제]는 휴지통으로 — 묻지 않고 되돌리기를 달고, 완전히 지우기만 한 번 묻는다', () => {
  const remove = library.slice(library.indexOf('const remove = async'), library.indexOf('const restore = async'))
  assert.doesNotMatch(remove, /window\.confirm/, '되살릴 수 있는 일은 묻지 않는다')
  assert.match(remove, /undo: \{ label: '되돌리기', run: \(\) => restore\(document\) \}/)
  assert.doesNotMatch(library, /이 작업은 되돌릴 수 없습니다/)
  const purge = library.slice(library.indexOf('const purge = async'))
  assert.match(purge, /window\.confirm\(`‘\$\{document\.name\}’ 자료를 완전히 지울까요\?/)
  assert.match(purge, /\?permanent=1/)
  assert.match(library, /\{canManage && <Button tone="danger" size="sm" type="button" onClick=\{\(\) => void purge\(document\)\}>/, '완전히 지우기는 관리자 화면에만')
  assert.match(library, /libraryFetch\('\/api\/documents\?trash=1', workspaceScope\)/)
  // 서버: 삭제는 표시만, 휴지통 자료는 어디서도 읽히지 않는다(판정은 한 곳).
  assert.match(server, /const canReadDocument = \(document, account\) => !isTrashedDocument\(document\) && canSeeDocument\(document, account\)/)
  assert.match(server, /id: 'document-trash-sweep',/)
})

test('올리기 대화상자: 부서·사람은 골라서, 설명은 선택, 드문 칸은 접어서', () => {
  assert.doesNotMatch(library, /허용 계정 ID/, '화면 어디에도 보이지 않는 계정 ID를 쳐 넣게 하지 않는다')
  assert.doesNotMatch(library, /허용 부서 · 쉼표 구분/)
  assert.match(library, /<legend>볼 수 있는 부서<\/legend>/)
  assert.match(library, /<legend>볼 수 있는 사람<\/legend>/)
  assert.match(library, /const VISIBILITY_LABEL: Record<DocumentVisibility, string> = \{ all: '회사 전체', department: '정한 부서만', restricted: '정한 사람만' \}/)
  assert.match(library, /<textarea name="summary" rows=\{3\} defaultValue=\{document\?\.summary\} placeholder="[^"]+" \/>/, '설명은 required가 아니다')
  assert.match(library, /<details className="library-more-fields"/)
  // 직원이 올릴 때는 서버가 범위를 '내 부서'·'나'로 고정한다 — 고를 칸 대신 그 사실을 말한다.
  assert.match(library, /'나만 볼 수 있습니다\.'/)
})

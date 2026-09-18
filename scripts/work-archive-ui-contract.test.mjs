import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('업무 화면에서 보관함을 연다 — 보기 모드(규칙 제외) 어디서나 같은 자리', async () => {
  const app = await read('src/App.tsx')
  assert.match(app, /import \{ WorkArchiveDialog \} from '\.\/components\/WorkArchiveDialog'/)
  assert.match(app, /onClick=\{\(\) => setArchiveOpen\(true\)\}><Archive size=\{15\} aria-hidden="true" \/> 보관함<\/Button>/)
})

test('보관함 화면은 서버 라우트 셋만 부르고, 지워지지 않는다는 사실을 먼저 말한다', async () => {
  const dialog = await read('src/components/WorkArchiveDialog.tsx')
  assert.match(dialog, /\/api\/work-items\/archive\?\$\{params\}/)
  assert.match(dialog, /'\/api\/work-items\/archive', 'archive-now'/)
  assert.match(dialog, /\/api\/work-items\/archive\/\$\{encodeURIComponent\(row\.id\)\}\/restore/)
  assert.match(dialog, /지워지지 않습니다/)
  // 한 화면에 primary는 하나 이하 — 보관함은 보조 행동뿐이다.
  assert.doesNotMatch(dialog, /tone="primary"/)
})

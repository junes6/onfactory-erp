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

test('운영사 접속 이력은 총계를 말하고 보관분까지 더 불러온다 — 화면이 50건에서 자르지 않는다', async () => {
  const people = await read('src/components/PeopleOperations.tsx')
  const section = people.slice(people.indexOf('<section className="operator-access-log"'), people.indexOf('</section>', people.indexOf('<section className="operator-access-log"')))
  assert.doesNotMatch(section, /operatorAccessLog\.slice\(/, '목록을 화면에서 자르지 않는다')
  assert.match(section, /operatorAccessTotal\.toLocaleString\('ko-KR'\)\}건/, '머리의 건수는 불러온 수가 아니라 전체 수다')
  assert.match(section, /이전 기록 더 보기/)
  assert.match(section, /formatDateTime\(visit\.startedAt\)/, '시각은 ISO 원문이 아니라 읽을 수 있는 형태다')
  assert.match(section, /operatorVisits\.map/, '같은 운영자의 연속된 줄은 한 방문으로 묶어 보인다')
  assert.match(section, /<details>/, '방문을 펼치면 원래 줄이 전부 보인다')
  assert.match(section, /변경 \{visit\.writes\}건/, '변경이 있었는지를 머리에서 먼저 말한다')
  assert.match(people, /\/api\/operator-access-log\?offset=\$\{offset\}&limit=/)
})

test('휴가 원장은 화면에서도 자르지 않는다 — 영구 이력', async () => {
  const people = await read('src/components/PeopleOperations.tsx')
  assert.doesNotMatch(people, /ledger\]\.slice\(0, \d+\)|current\.ledger\]\.slice\(/)
})

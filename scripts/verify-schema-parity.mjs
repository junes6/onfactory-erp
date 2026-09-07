/**
 * 스키마가 두 곳에 적히는 계약 중 **행 수준 보안**만 기계가 지킨다.
 *
 * 이 저장소에서 테이블은 두 곳에 선언된다:
 *   1) db/postgres-schema.sql — 빈 데이터베이스를 한 번에 세우는 베이스라인
 *   2) supabase/migrations/<타임스탬프>_*.sql — 이미 도는 데이터베이스를 따라오게 하는 증분
 *
 * 한쪽에서 RLS를 켜고 다른 쪽에서 잊어도 **아무 시험도 빨개지지 않는다**. 실제로 그렇게 됐다:
 * 개인 지식 코어 네 테이블(principles·personal_notes·correction_log·knowledge_gaps)은
 * 마이그레이션에서만 소유자 정책이 걸려 있었고, 베이스라인 하나로 세운 데이터베이스에서는
 * 그 네 테이블이 행 수준 보안 없이 떴다. 그 사실은 배포 뒤 운영에서만 드러난다.
 *
 * **왜 RLS만 보는가.** 테이블·컬럼·인덱스까지 견주면 지금 38건이 어긋나는데, 그 대부분은
 * 결함이 아니라 의도한 차이다(청구 원장은 마이그레이션 사슬에만 있고, 베이스라인이 뒤늦은
 * ALTER를 CREATE 본문에 이미 담고 있는 자리도 있다). 어느 쪽이 옳은지는 사람이 정할 일이라
 * 여기서 실패로 만들지 않는다 — 대신 `--report` 로 그 목록을 뽑아 볼 수 있게 해 둔다.
 * RLS는 다르다: 한쪽에만 있으면 그것은 언제나 결함이고, 열리는 쪽이 어디인지도 분명하다.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baselineFile = path.join('db', 'postgres-schema.sql')
const migrationsDirectory = path.join(root, 'supabase', 'migrations')

const baseline = readFileSync(path.join(root, baselineFile), 'utf8')
const migrations = readdirSync(migrationsDirectory).filter((name) => name.endsWith('.sql')).sort()

/**
 * 이 파일이 행 수준 보안을 켜는 테이블 전부.
 *
 * 두 가지 모양을 다 읽어야 한다. 글자 그대로 쓴 `ALTER TABLE x ENABLE ROW LEVEL SECURITY` 와,
 * 표 이름을 배열로 돌리는 `DO $$ ... FOREACH t IN ARRAY ARRAY['a','b'] ... EXECUTE format(...)`.
 * 앞의 것만 읽으면 루프로 켜 둔 테이블을 '안 켰다'고 잘못 말한다(notices에서 실제로 그랬다).
 */
function rlsTablesOf(sql) {
  const tables = new Set()
  for (const match of sql.matchAll(/ALTER\s+TABLE\s+(\w+)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi)) {
    tables.add(match[1].toLowerCase())
  }
  for (const block of sql.matchAll(/DO\s+\$\$[\s\S]*?END\s*\$\$\s*;/gi)) {
    const body = block[0]
    // 루프가 실제로 RLS를 켜는 블록만 본다. 정책만 다시 그리는 루프도 있다.
    if (!/ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(body)) continue
    for (const array of body.matchAll(/IN\s+ARRAY\s+ARRAY\[([^\]]*)\]/gi)) {
      for (const name of array[1].matchAll(/'([^']+)'/g)) tables.add(name[1].toLowerCase())
    }
  }
  return tables
}

/** 이 파일이 만드는 정책을 `테이블:정책이름` 으로. 루프의 `%I_owner_only` 는 표의 각 테이블로 펼친다. */
function policiesOf(sql) {
  const policies = new Set()
  for (const match of sql.matchAll(/CREATE\s+POLICY\s+(\w+)\s+ON\s+(\w+)/gi)) {
    policies.add(`${match[2].toLowerCase()}:${match[1].toLowerCase()}`)
  }
  for (const block of sql.matchAll(/DO\s+\$\$[\s\S]*?END\s*\$\$\s*;/gi)) {
    const body = block[0]
    const suffixes = [...body.matchAll(/CREATE\s+POLICY\s+%I_(\w+)\s+ON\s+%I/gi)].map((match) => match[1].toLowerCase())
    if (!suffixes.length) continue
    for (const array of body.matchAll(/IN\s+ARRAY\s+ARRAY\[([^\]]*)\]/gi)) {
      for (const name of array[1].matchAll(/'([^']+)'/g)) {
        for (const suffix of suffixes) policies.add(`${name[1].toLowerCase()}:${name[1].toLowerCase()}_${suffix}`)
      }
    }
  }
  return policies
}

const baselineRls = rlsTablesOf(baseline)
const basePolicies = policiesOf(baseline)

const errors = []
let checkedTables = 0
let checkedPolicies = 0

for (const name of migrations) {
  const file = `supabase/migrations/${name}`
  const sql = readFileSync(path.join(migrationsDirectory, name), 'utf8')

  for (const table of rlsTablesOf(sql)) {
    checkedTables += 1
    if (!baselineRls.has(table)) {
      errors.push(`${file}:1 ${table} 은(는) 여기서 행 수준 보안을 켜는데 ${baselineFile} 에서는 켜지 않습니다 — 베이스라인으로 세운 데이터베이스는 이 테이블을 격리 없이 띄웁니다.`)
    }
  }
  for (const policy of policiesOf(sql)) {
    checkedPolicies += 1
    if (!basePolicies.has(policy)) {
      const [table, policyName] = policy.split(':')
      errors.push(`${file}:1 정책 ${policyName} (${table}) 가 ${baselineFile} 에 없습니다.`)
    }
  }
}

/** `--report` 는 실패시키지 않고 나머지 어긋남(테이블·컬럼·인덱스)을 보여 주기만 한다. */
if (process.argv.includes('--report')) {
  const squeeze = (value) => String(value).replace(/\s+/g, ' ').trim()
  const bodyOf = (text) => squeeze(text).replace(/^\(/, '').replace(/\)$/, '').trim()
  const baseTables = new Map()
  for (const match of baseline.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)\s*(\([\s\S]*?\))\s*;/g)) {
    baseTables.set(match[1].toLowerCase(), bodyOf(match[2]))
  }
  const squeezedBaseline = squeeze(baseline).toLowerCase()
  const notes = []
  for (const name of migrations) {
    const sql = readFileSync(path.join(migrationsDirectory, name), 'utf8')
    for (const match of sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)\s*(\([\s\S]*?\))\s*;/g)) {
      const table = match[1].toLowerCase()
      if (!baseTables.has(table)) notes.push(`${name}: 테이블 ${table} 이 베이스라인에 없음`)
      else if (baseTables.get(table) !== bodyOf(match[2])) notes.push(`${name}: 테이블 ${table} 본문 상이`)
    }
    for (const match of sql.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS\s+(\w+)\b/gi)) {
      const index = match[1].toLowerCase()
      if (!new RegExp(`create (?:unique )?index if not exists ${index}\\b`).test(squeezedBaseline)) {
        notes.push(`${name}: 인덱스 ${index} 가 베이스라인에 없음`)
      }
    }
  }
  console.log(`[schema-parity] 참고 — RLS 밖의 어긋남 ${notes.length}건(실패로 세지 않습니다):`)
  for (const note of notes) console.log(`  · ${note}`)
}

if (errors.length) {
  console.error(`[schema-parity] ${errors.length}개 위반을 발견했습니다.`)
  console.error(errors.join('\n'))
  process.exitCode = 1
} else {
  console.log(`[schema-parity] 마이그레이션 ${migrations.length}개가 켠 행 수준 보안 ${checkedTables}건과 정책 ${checkedPolicies}개가 모두 ${baselineFile} 에도 있습니다.`)
}

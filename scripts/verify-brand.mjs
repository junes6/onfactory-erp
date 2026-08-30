import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

/**
 * 브랜드 단일화 게이트.
 * 1) 저장소 어디에도 옛 서비스명이 남아 있지 않다.
 * 2) 화면·서버 코드는 서비스명을 문자열로 직접 쓰지 않고 shared/brand.json을 참조한다.
 * 3) 정적 파일(index.html · manifest · offline)은 brand.json과 같은 문구를 쓴다.
 */
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1))), '..')
const brand = JSON.parse(readFileSync(path.join(root, 'shared', 'brand.json'), 'utf8'))

const RETIRED_NAMES = ['온팩토리', 'ONFACTORY PLATFORM', 'FOOD OPERATIONS CLOUD', 'FOOD ERP']
const SCAN_ROOTS = ['src', 'server', 'scripts', 'worker', 'public', 'db', 'shared', 'supabase', 'drizzle']
const SCAN_FILES = ['index.html', 'README.md', 'PRODUCT.md', 'AGENTS.md', 'DECISIONS.md', 'start-erp.bat', 'package.json']
const SKIP_SEGMENTS = new Set(['node_modules', 'data', 'backups', 'dist', '.wrangler'])
const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js', '.json', '.md', '.css', '.html', '.sql', '.bat', '.webmanifest'])
/** 서비스명을 문자열로 써도 되는 곳: 단일 출처와 이 검증 스크립트. */
/** 옛 이름을 문자열로 담아야 하는 가드 파일 — 자기 자신과 부재 검증 테스트. */
const RETIRED_NAME_ALLOWED = new Set(['scripts/verify-brand.mjs', 'scripts/product-surface-contract.test.mjs'])
const LITERAL_ALLOWED = new Set(['shared/brand.json', 'scripts/verify-brand.mjs', 'index.html', 'public/manifest.webmanifest', 'public/offline.html', 'public/sw.js', 'start-erp.bat', 'README.md', 'PRODUCT.md', 'AGENTS.md', 'DECISIONS.md'])

function walk(directory) {
  const files = []
  let entries
  try { entries = readdirSync(directory) } catch { return files }
  for (const entry of entries) {
    if (SKIP_SEGMENTS.has(entry)) continue
    const target = path.join(directory, entry)
    if (statSync(target).isDirectory()) files.push(...walk(target))
    else if (TEXT_EXTENSIONS.has(path.extname(target))) files.push(target)
  }
  return files
}

const relative = (file) => path.relative(root, file).replaceAll('\\', '/')
const lineAt = (source, index) => source.slice(0, index).split('\n').length

const files = [
  ...SCAN_ROOTS.flatMap((directory) => walk(path.join(root, directory))),
  ...SCAN_FILES.map((file) => path.join(root, file)).filter((file) => { try { return statSync(file).isFile() } catch { return false } }),
]

const errors = []
for (const file of files) {
  const source = readFileSync(file, 'utf8')
  const name = relative(file)
  if (!RETIRED_NAME_ALLOWED.has(name)) for (const retired of RETIRED_NAMES) {
    let index = source.indexOf(retired)
    while (index >= 0) {
      errors.push(`${name}:${lineAt(source, index)} 옛 서비스명 '${retired}'가 남아 있습니다.`)
      index = source.indexOf(retired, index + retired.length)
    }
  }
  // 테스트 픽스처·배포 시드는 서비스명을 데이터로 담을 수 있다.
  if (LITERAL_ALLOWED.has(name) || name.endsWith('.test.mjs') || name === 'worker/initial-workspace-state.json' || name === 'server/store/demo-seed.mjs') continue
  let index = source.indexOf(brand.name)
  while (index >= 0) {
    errors.push(`${name}:${lineAt(source, index)} 서비스명을 직접 쓰지 말고 BRAND(shared/brand.json)를 참조하세요.`)
    index = source.indexOf(brand.name, index + brand.name.length)
  }
}

// 정적 파일은 import를 못 하므로 문구 일치만 검사한다.
const staticChecks = [
  ['index.html', `<title>${brand.title}</title>`],
  ['index.html', `content="${brand.name}"`],
  ['index.html', `content="${brand.description}"`],
  ['public/manifest.webmanifest', `"name": "${brand.manifestName}"`],
  ['public/manifest.webmanifest', `"short_name": "${brand.name}"`],
  ['public/manifest.webmanifest', `"description": "${brand.description}"`],
  ['public/offline.html', `<title>${brand.offlineTitle}</title>`],
]
for (const [file, needle] of staticChecks) {
  const source = readFileSync(path.join(root, file), 'utf8')
  if (!source.includes(needle)) errors.push(`${file}:1 brand.json과 어긋납니다 — '${needle}'가 없습니다.`)
}

if (errors.length) {
  console.error(`[brand] ${errors.length}개 위반을 발견했습니다.`)
  console.error(errors.join('\n'))
  process.exitCode = 1
} else {
  console.log(`[brand] 서비스명 '${brand.name}'이 shared/brand.json 한 곳에서만 정의되고 정적 파일과 일치합니다.`)
}

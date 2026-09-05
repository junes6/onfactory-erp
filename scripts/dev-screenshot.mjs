// 개발용 스크린샷 도구 — 헤드리스 Chrome(CDP, 의존성 0)으로 로그인 세션을 심어 1280x800 실측 캡처를 뜬다. AGENTS.md의 "셀프 스크린샷 판정"에 쓴다.
// 사용: node scripts/dev-screenshot.mjs --out shots/a.png [--as operator|member|guest] [--email x --password y] [--tenant TENANT-SUNSEA] [--path /] [--prep @file.js | "js"] [--wait 1800] [--full true]
//   --as operator : 데모 운영자로 로그인해 --tenant 에 들어간 뒤 캡처(기본). member는 데모 직원, guest는 --email/--password 필수.
//   --prep        : 캡처 직전에 페이지에서 실행할 JS(async, return 값이 결과에 찍힘). 메뉴 클릭·모달 열기 등에 쓴다. 데모 자격은 server/store/demo-seed.mjs의 것이다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, token, index, all) => {
  if (!token.startsWith('--')) return acc
  const next = all[index + 1]
  acc.push([token.slice(2), next && !next.startsWith('--') ? next : 'true'])
  return acc
}, []))
const base = args.base ?? 'http://localhost:8787'
const out = path.resolve(args.out ?? 'shot.png')
const as = args.as ?? 'operator'
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p))
if (!CHROME) throw new Error('Chrome/Edge를 찾지 못했다')

// 1. 로그인해 세션 쿠키를 받는다.
const creds = as === 'operator' ? { workspace: 'platform', email: 'operator@onfactory.co.kr', password: 'demo1234' }
  : as === 'member' ? { workspace: 'tenant', email: 'jihyun.park@sunsea.co.kr', password: 'demo1234' }
  : { workspace: args.workspace ?? 'tenant', email: args.email, password: args.password }
const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(creds) })
if (!login.ok) throw new Error(`로그인 실패 ${login.status} ${await login.text()}`)
const setCookie = login.headers.get('set-cookie') ?? ''
const [cookiePair] = setCookie.split(';')
const [cookieName, ...rest] = cookiePair.split('=')
const cookieValue = rest.join('=')
const account = (await login.json()).account
if (as === 'operator' && args.tenant !== 'none') {
  const tenant = args.tenant ?? 'TENANT-SUNSEA'
  const enter = await fetch(`${base}/api/platform/tenants/${tenant}/enter`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookiePair }, body: JSON.stringify({ reason: '절별 스크린샷 캡처' }) })
  if (!enter.ok) throw new Error(`테넌트 진입 실패 ${enter.status}`)
}

// 2. 헤드리스 Chrome을 띄우고 CDP로 붙는다.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-profile-'))
const port = 9300 + Math.floor(Math.random() * 400)
const chrome = spawn(CHROME, [`--headless=new`, `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1280,800', '--hide-scrollbars', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' })
const cleanup = () => { try { chrome.kill() } catch {} ; try { fs.rmSync(profile, { recursive: true, force: true }) } catch {} }
process.on('exit', cleanup)
let targets = []
for (let attempt = 0; attempt < 50 && targets.length === 0; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 200))
  try { targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter((t) => t.type === 'page') } catch {}
}
if (targets.length === 0) throw new Error('Chrome DevTools에 붙지 못했다')
const ws = new WebSocket(targets[0].webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let seq = 0
const pending = new Map()
const events = []
ws.onmessage = (message) => {
  const data = JSON.parse(message.data)
  if (data.id && pending.has(data.id)) { const { resolve, reject } = pending.get(data.id); pending.delete(data.id); data.error ? reject(new Error(data.error.message)) : resolve(data.result) }
  else if (data.method) events.push(data)
}
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) })
const waitEvent = (name, timeout = 15000) => new Promise((resolve) => {
  const started = Date.now()
  const tick = () => { const index = events.findIndex((e) => e.method === name); if (index >= 0) { resolve(events.splice(index, 1)[0]); return } if (Date.now() - started > timeout) { resolve(null); return } setTimeout(tick, 50) }
  tick()
})

await send('Page.enable')
await send('Network.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: Number(args.scale ?? 1), mobile: false })
await send('Network.setCookie', { name: cookieName.trim(), value: cookieValue, url: base, path: '/' })
await send('Page.navigate', { url: `${base}${args.path ?? '/'}` })
await waitEvent('Page.loadEventFired')
await new Promise((resolve) => setTimeout(resolve, Number(args.wait ?? 1800)))

// 3. 준비 스크립트(메뉴 이동·모달 열기) → 캡처.
let prepResult = null
if (args.prep && args.prep !== 'true') {
  const prep = args.prep.startsWith('@') ? fs.readFileSync(args.prep.slice(1), 'utf8') : args.prep
  const evaluated = await send('Runtime.evaluate', { expression: `(async () => { ${prep} })()`, awaitPromise: true, returnByValue: true })
  prepResult = evaluated.result?.value ?? evaluated.exceptionDetails?.text ?? null
  if (evaluated.exceptionDetails) prepResult = `prep 예외: ${JSON.stringify(evaluated.exceptionDetails).slice(0, 400)}`
  await new Promise((resolve) => setTimeout(resolve, Number(args.settle ?? 700)))
}
const snippet = await send('Runtime.evaluate', { expression: 'document.body.innerText.replace(/\\s+/g, " ").slice(0, 240)', returnByValue: true })
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: args.full === 'true' })
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
console.log(JSON.stringify({ out, bytes: fs.statSync(out).size, account: account?.name, prepResult, snippet: snippet.result?.value }))
ws.close()
cleanup()
process.exit(0)

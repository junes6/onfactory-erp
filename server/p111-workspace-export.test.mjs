import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { createApp } from './app.mjs'
import { withServer } from './test-server.mjs'
import { toCsv } from './workspace-export.mjs'

/**
 * P1-11(감사 data-core-13): 회사가 자기 데이터를 통째로 가져간다. 관리자만, 한 번 쓰는 2분짜리 주소로.
 * 1:1 대화·한 사람의 것·판단 기록·연결 자격·휴지통은 담지 않고, 비밀 칸은 가린다.
 */

const TENANT = 'TENANT-SUNSEA'
const readJson = async (response) => { const text = await response.text(); try { return JSON.parse(text) } catch { return { raw: text } } }
async function login(origin, email) {
  const response = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: 'tenant', email, password: 'demo1234' }) })
  assert.equal(response.status, 200, email)
  return (response.headers.get('set-cookie') ?? '').split(';')[0]
}
function memoryStorage() {
  const files = new Map()
  return {
    files, backend: 'local',
    async put(key, body) { files.set(key, Buffer.from(body)); return { key, size: body.length } },
    async get(key) { const value = files.get(key); if (!value) { const error = new Error('없음'); error.code = 'STORAGE_NOT_FOUND'; throw error } return value },
    async delete(key) { return files.delete(key) },
    async exists(key) { return files.has(key) },
    async getSignedUrl(_key, options = {}) { return options.fallbackUrl ?? null },
  }
}
/** 무압축 ZIP의 로컬 헤더를 차례로 읽는다. */
function unzip(buffer) {
  const entries = new Map()
  let offset = 0
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const size = buffer.readUInt32LE(offset + 18)
    const nameLength = buffer.readUInt16LE(offset + 26)
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8')
    const start = offset + 30 + nameLength
    entries.set(name, buffer.subarray(start, start + size))
    offset = start + size
  }
  return entries
}

test('관리자 전체 내보내기: 영역별 JSON·CSV·원본 파일·manifest — 1:1 대화·개인 것·비밀은 빠진다', async () => {
  const store = { version: 2, tenants: { [TENANT]: {
    'messenger-conversations': { data: [
      { id: 'C-TEAM', type: 'group', name: '품질팀', participantIds: ['USR-SUNSEA-ADMIN', 'USR-SUNSEA-OH'], messages: [{ id: 'M1', text: '점검 끝', senderId: 'USR-SUNSEA-OH' }] },
      { id: 'C-DM', type: 'direct', name: '', participantIds: ['USR-SUNSEA-OH', 'USR-SUNSEA-PARK'], messages: [{ id: 'M2', text: '사적인 말', senderId: 'USR-SUNSEA-OH' }] },
    ], updatedAt: '2026-09-18T00:00:00.000Z', updatedBy: 'seed' },
    'personal-todos': { data: [{ id: 'T1', title: '개인 할 일' }], updatedAt: '2026-09-18T00:00:00.000Z', updatedBy: 'seed' },
    'calendar-connections': { data: [{ id: 'CC1', refreshTokenEnc: 'v1:secret' }], updatedAt: '2026-09-18T00:00:00.000Z', updatedBy: 'seed' },
    'webhook-endpoints': { data: [{ id: 'WH1', url: 'https://hooks.example/x', secret: 'shh-123' }], updatedAt: '2026-09-18T00:00:00.000Z', updatedBy: 'seed' },
    'ai-proposals': { data: [{ id: 'P1', kind: 'lens-task', summary: '회사 제안' }, { id: 'P2', kind: 'principle', summary: '남의 판단 기록' }], updatedAt: '2026-09-18T00:00:00.000Z', updatedBy: 'seed' },
    'product-catalog': { data: [{ id: 'PR1', name: '=HYPERLINK("x")', price: 1200 }], updatedAt: '2026-09-18T00:00:00.000Z', updatedBy: 'seed' },
  } }, platform: {}, accountApprovals: {}, accountCredentials: {}, invitedAccounts: [], passwordResetRequests: [], guestGrants: [] }
  await withServer(createApp({ apiKey: '', initialWorkspaceStore: store, onWorkspaceStoreChange: () => {}, documentStorage: memoryStorage() }), async (origin) => {
    const admin = await login(origin, 'admin@sunsea.co.kr')
    const member = await login(origin, 'taesik.oh@sunsea.co.kr')
    const upload = (cookie, name, tags = '') => fetch(`${origin}/api/documents?name=${encodeURIComponent(name)}&visibility=all&category=${encodeURIComponent('공통자료')}${tags ? `&tags=${encodeURIComponent(tags)}` : ''}`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-type': 'text/plain', 'x-file-name': encodeURIComponent(name) }, body: Buffer.from(`${name} 내용`),
    }).then(readJson)
    const shared = await upload(admin, '위생 점검표.txt')
    await upload(member, '연봉 협상.txt', 'conversation:C-DM')

    assert.equal((await fetch(`${origin}/api/export/workspace`, { method: 'POST', headers: { cookie: member } })).status, 403, '관리자만')
    const ticket = await readJson(await fetch(`${origin}/api/export/workspace`, { method: 'POST', headers: { cookie: admin } }))
    assert.match(ticket.url, /^\/api\/export\/workspace\/download\?ticket=/)
    assert.equal((await fetch(`${origin}${ticket.url}`, { headers: { cookie: member } })).status, 403, '주소를 얻어도 관리자 세션이어야 한다')
    const download = await fetch(`${origin}${ticket.url}`, { headers: { cookie: admin } })
    assert.equal(download.status, 200)
    assert.match(decodeURIComponent(download.headers.get('content-disposition')), /_전체자료_\d{4}-\d{2}-\d{2}\.zip/)
    const zip = unzip(Buffer.from(await download.arrayBuffer()))
    assert.equal((await fetch(`${origin}${ticket.url}`, { headers: { cookie: admin } })).status, 410, '주소는 한 번만 쓴다')

    const names = [...zip.keys()]
    assert.ok(names.includes('README.txt') && names.includes('manifest.json'))
    const rooms = JSON.parse(zip.get('data/messenger-conversations.json').toString('utf8'))
    assert.deepEqual(rooms.map((room) => room.id), ['C-TEAM'], '1:1 대화는 담지 않는다')
    assert.ok(!names.includes('data/personal-todos.json'), '한 사람의 것은 담지 않는다')
    assert.ok(!names.includes('data/calendar-connections.json'), '연결 자격은 담지 않는다')
    assert.equal(JSON.parse(zip.get('data/webhook-endpoints.json').toString('utf8'))[0].secret, '[가림]')
    assert.deepEqual(JSON.parse(zip.get('data/ai-proposals.json').toString('utf8')).map((row) => row.id), ['P1'], '판단 기록 제안은 빼고')
    const csv = zip.get('data/product-catalog.csv').toString('utf8')
    assert.equal(csv.charCodeAt(0), 0xfeff, '엑셀이 한글을 읽도록 BOM')
    assert.match(csv, /"'=HYPERLINK\(""x""\)"/, '수식으로 읽히지 않게')

    const files = names.filter((name) => name.startsWith('files/'))
    assert.equal(files.length, 1, '1:1 대화 첨부는 담지 않는다')
    assert.equal(zip.get(files[0]).toString('utf8'), '위생 점검표.txt 내용')
    const manifest = JSON.parse(zip.get('manifest.json').toString('utf8'))
    assert.equal(manifest.files[0].id, shared.document.id)
    assert.equal(manifest.files[0].sha256, createHash('sha256').update(zip.get(files[0])).digest('hex'))
    assert.ok(manifest.skipped.some((entry) => entry.key === 'messenger-conversations' && /1:1 대화 1개/.test(entry.reason)))
  })
})

test('CSV: 평평한 행만, 따옴표·줄바꿈을 감싼다', () => {
  assert.equal(toCsv([{ a: 1 }, [1]]), null)
  const csv = toCsv([{ name: '가,나', note: '줄\n바꿈' }, { name: '다', extra: { x: 1 } }])
  assert.ok(csv.includes('"가,나","줄\n바꿈",'))
  assert.ok(csv.includes('다,,"{""x"":1}"'))
})

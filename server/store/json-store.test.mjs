import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { JsonStoreAdapter, writeJsonAtomically } from './json-store.mjs'
import { PersistentSessionMap, hashSessionToken } from './persistent-session-map.mjs'

const store = (marker) => ({ version: 2, tenants: {}, platform: { tenants: [], supportTickets: [], integrations: [], actions: [], auditEvents: [], marker }, accountApprovals: {}, accountCredentials: {}, invitedAccounts: [], passwordResetRequests: [], guestGrants: [] })

test('본 파일이 깨졌으면 백업으로 시작하고, 다음 저장은 성공한다 — 깨진 파일은 지우지 않고 보존, .bak은 마지막 정상본 그대로', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inthefield-json-corrupt-'))
  const file = path.join(directory, 'workspace-state.json')
  try {
    await writeFile(file, '{"version":2,"tenants":{')
    await writeFile(`${file}.bak`, JSON.stringify(store('last-good')))
    const adapter = new JsonStoreAdapter({ file, readOnly: false })
    const loaded = await adapter.loadSnapshot()
    assert.equal(loaded.platform.marker, 'last-good')
    assert.equal(adapter.health.loadedFrom, 'backup')
    assert.ok(adapter.health.loadError)

    // 전에는 여기서 SyntaxError가 나고, 그 뒤 모든 저장이 영구히 실패했다.
    adapter.commitSnapshot(store('after-recovery'))
    assert.equal(JSON.parse(await readFile(`${file}.bak`, 'utf8')).platform.marker, 'last-good', '첫 저장은 마지막 정상본(.bak)을 건드리지 않는다')
    adapter.commitSnapshot(store('second-write'))
    assert.equal(JSON.parse(await readFile(file, 'utf8')).platform.marker, 'second-write')
    const names = await readdir(directory)
    const corrupt = names.filter((name) => name.includes('.corrupt-'))
    assert.equal(corrupt.length, 1, '깨진 본 파일은 한 번만, 지우지 않고 보존된다')
    assert.equal(await readFile(path.join(directory, corrupt[0]), 'utf8'), '{"version":2,"tenants":{')
    assert.equal(adapter.health.quarantined.length, 1)
    assert.equal(adapter.health.lastCommitError, null)
    assert.equal(JSON.parse(await readFile(`${file}.bak`, 'utf8')).platform.marker, 'after-recovery', '둘째 저장부터는 정상 회전한다')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('이 프로세스가 쓴 본 파일은 다시 읽어 검증하지 않고 이름만 바꿔 회전한다', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inthefield-json-rotate-'))
  const file = path.join(directory, 'workspace-state.json')
  try {
    const state = { mainVerified: false }
    writeJsonAtomically(file, JSON.stringify({ n: 1 }), state)
    assert.equal(state.mainVerified, true)
    writeJsonAtomically(file, JSON.stringify({ n: 2 }), state)
    writeJsonAtomically(file, JSON.stringify({ n: 3 }), state)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).n, 3)
    assert.equal(JSON.parse(await readFile(`${file}.bak`, 'utf8')).n, 2)
    assert.deepEqual((await readdir(directory)).sort(), ['workspace-state.json', 'workspace-state.json.bak'], '임시 파일이 남지 않는다')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('JSON 모드 세션은 파일에 남아 다시 켜도 로그인이 유지된다 — 토큰 원문은 저장하지 않는다', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inthefield-json-sessions-'))
  const file = path.join(directory, 'workspace-state.json')
  try {
    const first = new JsonStoreAdapter({ file, readOnly: false })
    await first.loadSnapshot()
    const sessions = await first.createSessionMap()
    const token = 'raw-session-token-abcdef'
    sessions.set(token, { accountId: 'USR-1', remember: true, expiresAt: Date.now() + 60_000 })
    sessions.set('expired-token', { accountId: 'USR-2', expiresAt: Date.now() + 5 })
    await sessions.flush()
    const raw = await readFile(path.join(directory, 'sessions.json'), 'utf8')
    assert.ok(!raw.includes(token), '토큰 원문이 파일에 없다')
    assert.ok(raw.includes(hashSessionToken(token)))

    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = new JsonStoreAdapter({ file, readOnly: false })
    await second.loadSnapshot()
    const restored = await second.createSessionMap()
    assert.equal(restored.get(token)?.accountId, 'USR-1', '다시 켜도 같은 토큰으로 세션을 찾는다')
    assert.equal(restored.get('expired-token'), undefined, '만료된 세션은 싣지 않는다')
    restored.delete(token)
    await restored.flush()
    const third = await new JsonStoreAdapter({ file, readOnly: false }).createSessionMap()
    assert.equal(third.get(token), undefined, '로그아웃이 파일에도 남는다')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('끊긴 저장이 남긴 오래된 임시 파일만 치운다 — 방금 것·남의 이름·본 파일은 그대로', async () => {
  const { cleanStaleTemporaryFiles } = await import('./json-store.mjs')
  const { utimes } = await import('node:fs/promises')
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inthefield-json-tmp-'))
  const file = path.join(directory, 'workspace-state.json')
  try {
    await writeFile(file, '{}')
    const old = path.join(directory, 'workspace-state.json.4242.1700000000000.tmp')
    const fresh = path.join(directory, 'workspace-state.json.4243.1700000000001.tmp')
    const mine = path.join(directory, `workspace-state.json.${process.pid}.1700000000002.tmp`)
    const other = path.join(directory, 'notes.json.4242.1700000000000.tmp')
    for (const target of [old, fresh, mine, other]) await writeFile(target, 'x')
    const hourAgo = new Date(Date.now() - 2 * 60 * 60 * 1_000)
    for (const target of [old, mine, other]) await utimes(target, hourAgo, hourAgo)
    const removed = cleanStaleTemporaryFiles(file)
    assert.deepEqual(removed, ['workspace-state.json.4242.1700000000000.tmp'])
    assert.deepEqual((await readdir(directory)).sort(), ['notes.json.4242.1700000000000.tmp', 'workspace-state.json', `workspace-state.json.${process.pid}.1700000000002.tmp`, 'workspace-state.json.4243.1700000000001.tmp'].sort())
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('읽기 전용 저장소는 세션 파일을 쓰지 않는다', async () => {
  const adapter = new JsonStoreAdapter({ file: path.join(os.tmpdir(), 'never-written', 'workspace-state.json'), readOnly: true })
  const sessions = await adapter.createSessionMap()
  assert.ok(sessions instanceof Map)
  assert.equal(typeof sessions.flush, 'undefined')
})

test('세션 저장이 한 번 실패해도 다음 저장은 돈다 — 사슬이 거절 상태로 굳지 않는다', async () => {
  let fail = true
  const written = []
  const map = new PersistentSessionMap([], { onSet: (key) => { if (fail) throw new Error('disk'); written.push(key) } })
  map.set('a', { accountId: 'A', expiresAt: Date.now() + 1_000 })
  await assert.rejects(() => map.flush(), /disk/)
  fail = false
  map.set('b', { accountId: 'B', expiresAt: Date.now() + 1_000 })
  await map.flush()
  assert.equal(written.length, 1)
})

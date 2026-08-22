import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createApp } from './app.mjs'
import { initializeRuntimeStore } from './store/index.mjs'
import { withServer } from './test-server.mjs'

// index.mjs와 동일한 조립 순서로, 환경변수가 하나도 없는 "기본 기동"을 재현한다.
// 이전 회귀(DATABASE_URL 부재 → 읽기 전용 폴백 → 모든 쓰기 500)는 스토어를 직접
// 생성하던 테스트로는 잡히지 않았으므로, 반드시 HTTP 경로로 검사한다.
async function bootLikeIndex(workspaceStoreFile, env = {}) {
  const runtimeStore = await initializeRuntimeStore({ env, workspaceStoreFile })
  const app = createApp({
    apiKey: '',
    initialWorkspaceStore: runtimeStore.workspaceStore,
    sessions: runtimeStore.sessions,
    workspaceStoreFile,
    onWorkspaceStoreChange: (store) => runtimeStore.adapter.commitSnapshot(store),
    seedPlatformFixtures: runtimeStore.adapter.kind === 'json' && !runtimeStore.adapter.readOnly,
    seedDemoAccounts: runtimeStore.adapter.kind === 'json',
    storeStatus: {
      kind: runtimeStore.adapter.kind,
      readOnly: Boolean(runtimeStore.adapter.readOnly),
      fallbackReason: runtimeStore.adapter.fallbackReason ?? null,
    },
  })
  return { app, runtimeStore }
}

async function login(origin, email = 'admin@sunsea.co.kr') {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: 'tenant', email, password: 'demo1234' }),
  })
  assert.equal(response.status, 200, `login failed: ${await response.text()}`)
  return response.headers.get('set-cookie')
}

const identity = 'TENANT-SUNSEA:USR-SUNSEA-ADMIN'
const warehouse = { id: 'WH-E2E', name: '냉장 1창고', type: '냉장', temperature: '3.0℃', condition: '3.0℃ · 정상', items: '등록 재고 0개', utilization: 20, alert: '이상 없음' }
const layouts = {
  'FAC-E2E': [{
    id: 'BLOCK-E2E', factoryId: 'FAC-E2E', zoneId: 'production', name: '생산 1라인', purpose: '생산', kind: '생산',
    x: 10, y: 10, width: 30, height: 24, color: 'var(--color-warning-soft)', item: '', current: 0, capacity: 100, unit: 'ea', note: '',
  }],
}

test('default boot (no env) runs the JSON store read-write and keeps writes across a restart', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'onfactory-default-boot-'))
  const workspaceStoreFile = path.join(directory, 'workspace-state.json')
  try {
    const first = await bootLikeIndex(workspaceStoreFile)
    assert.equal(first.runtimeStore.adapter.kind, 'json')
    assert.equal(first.runtimeStore.adapter.readOnly, false, '환경변수 없는 기본 기동은 읽기·쓰기여야 한다')

    await withServer(first.app, async (origin) => {
      const health = await (await fetch(`${origin}/api/health`)).json()
      assert.equal(health.store.kind, 'json')
      assert.equal(health.store.readOnly, false)

      const cookie = await login(origin)
      const headers = { 'content-type': 'application/json', cookie, 'x-workspace-identity': identity }
      const saveWarehouse = await fetch(`${origin}/api/workspace/inventory-locations`, { method: 'PUT', headers, body: JSON.stringify({ data: [warehouse] }) })
      assert.equal(saveWarehouse.status, 200, await saveWarehouse.text())
      const saveLayout = await fetch(`${origin}/api/workspace/factory-layouts`, { method: 'PUT', headers, body: JSON.stringify({ data: layouts }) })
      assert.equal(saveLayout.status, 200, await saveLayout.text())
    })

    // 재기동: 같은 파일에서 새 프로세스처럼 다시 조립한다.
    const second = await bootLikeIndex(workspaceStoreFile)
    await withServer(second.app, async (origin) => {
      const cookie = await login(origin)
      const headers = { cookie, 'x-workspace-identity': identity }
      const warehouses = await (await fetch(`${origin}/api/workspace/inventory-locations`, { headers })).json()
      assert.deepEqual(warehouses.data, [warehouse], '창고 등록이 재기동 후 유지되어야 한다')
      const savedLayouts = await (await fetch(`${origin}/api/workspace/factory-layouts`, { headers })).json()
      assert.deepEqual(savedLayouts.data, layouts, '공장 배치가 재기동 후 유지되어야 한다')
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('STORE_READ_ONLY=1 makes the JSON store read-only and writes fail loudly', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'onfactory-readonly-boot-'))
  const workspaceStoreFile = path.join(directory, 'workspace-state.json')
  try {
    // 먼저 읽기·쓰기로 한 번 기동해 데모 계정·플랫폼 시드가 파일에 존재하도록 만든다.
    const seeded = await bootLikeIndex(workspaceStoreFile)
    await withServer(seeded.app, async (origin) => { await login(origin) })

    const readOnly = await bootLikeIndex(workspaceStoreFile, { STORE_READ_ONLY: '1' })
    assert.equal(readOnly.runtimeStore.adapter.readOnly, true)
    await withServer(readOnly.app, async (origin) => {
      const health = await (await fetch(`${origin}/api/health`)).json()
      assert.equal(health.store.readOnly, true)
      const cookie = await login(origin)
      const save = await fetch(`${origin}/api/workspace/inventory-locations`, {
        method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'x-workspace-identity': identity }, body: JSON.stringify({ data: [warehouse] }),
      })
      assert.equal(save.status, 500)
      assert.equal((await save.json()).error.code, 'STORE_WRITE_FAILED')
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

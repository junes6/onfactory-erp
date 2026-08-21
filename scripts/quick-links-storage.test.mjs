import assert from 'node:assert/strict'
import test from 'node:test'

import {
  defaultQuickLinks,
  quickLinksStorageKey,
  readQuickLinks,
  writeQuickLinks,
} from '../src/utils/quickLinksStorage.ts'

class MemoryStorage {
  values = new Map()
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null }
  setItem(key, value) { this.values.set(key, String(value)) }
}

test('AI 업무허브 바로가기는 create → 재구성 → update → 재구성 → delete를 같은 tenant/user 키에 보존한다', () => {
  const storage = new MemoryStorage()
  const key = quickLinksStorageKey('TENANT-SUNSEA:USR-SUNSEA-ADMIN')
  assert.equal(key, 'onfactory-dashboard-links:TENANT-SUNSEA:USR-SUNSEA-ADMIN')

  const created = [{ id: 'LINK-SMOKE', name: '식품안전나라', url: 'https://foodsafetykorea.go.kr/', color: 'green' }]
  writeQuickLinks(storage, key, created)
  assert.deepEqual(readQuickLinks(storage, key), created, 'a reconstructed widget hydrates the created link')

  const updated = readQuickLinks(storage, key).map((link) => link.id === 'LINK-SMOKE'
    ? { ...link, name: '식품안전나라 수정', color: 'blue' }
    : link)
  writeQuickLinks(storage, key, updated)
  assert.deepEqual(readQuickLinks(storage, key), updated, 'a reconstructed widget hydrates the updated link')

  writeQuickLinks(storage, key, updated.filter((link) => link.id !== 'LINK-SMOKE'))
  assert.deepEqual(readQuickLinks(storage, key), [], 'a reconstructed widget keeps the deletion')
  assert.deepEqual(readQuickLinks(storage, quickLinksStorageKey('TENANT-OTHER:USR-OTHER')), defaultQuickLinks)
})

test('invalid or corrupt quick-link storage falls back without leaking a previous scope', () => {
  const storage = new MemoryStorage()
  const corruptKey = quickLinksStorageKey('TENANT-BROKEN:USR-BROKEN')
  storage.setItem(corruptKey, '{not-json')
  assert.deepEqual(readQuickLinks(storage, corruptKey), defaultQuickLinks)
  storage.setItem(corruptKey, JSON.stringify([{ id: 'unsafe', name: 'unsafe', url: 'javascript:alert(1)', color: 'red' }]))
  assert.deepEqual(readQuickLinks(storage, corruptKey), [])
})

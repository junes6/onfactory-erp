import assert from 'node:assert/strict'
import test from 'node:test'

import { WORKSPACE_CACHE_PREFIX, clearWorkspaceCaches } from '../src/hooks/useWorkspaceState.ts'

function memoryStorage(entries) {
  const map = new Map(Object.entries(entries))
  return {
    get length() { return map.size },
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => { map.delete(key) },
    keys: () => [...map.keys()],
  }
}

test('로그아웃하면 회사 업무 데이터 캐시만 지우고, 개인 화면 설정은 남긴다', () => {
  const storage = memoryStorage({
    [`${WORKSPACE_CACHE_PREFIX}TENANT-SUNSEA:USR-1:work-items`]: '[]',
    [`${WORKSPACE_CACHE_PREFIX}TENANT-SUNSEA:USR-1:messenger-conversations`]: '[]',
    'onfactory-accent': 'green',
    'onfactory-easy-mode': 'on',
  })
  assert.equal(clearWorkspaceCaches(storage), 2)
  assert.deepEqual(storage.keys().sort(), ['onfactory-accent', 'onfactory-easy-mode'])
  assert.equal(clearWorkspaceCaches(storage), 0, '두 번 불러도 안전하다')
  assert.equal(clearWorkspaceCaches(null), 0, '저장소가 없는 환경(서버 렌더)에서도 던지지 않는다')
})

test('App은 어느 길로 로그아웃하든(버튼·세션 만료·다른 탭) 같은 한 자리에서 캐시를 지운다', async () => {
  const { readFile } = await import('node:fs/promises')
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(app, /useEffect\(\(\) => \{ if \(authStatus === 'signed-out'\) clearWorkspaceCaches\(\) \}, \[authStatus\]\)/)
  assert.doesNotMatch(app, /setMessengerUnread\(4\)/, '로그아웃 뒤 가짜 안 읽음 4가 뜨지 않는다')
})

/* 인더필드 서비스워커 — 설치 가능성(PWA) 확보 + 오프라인 "연결 없음" 안내.
 * 데이터·API는 절대 캐시하지 않는다(네트워크 우선, 실패 시 문서 탐색에만 offline.html).
 * 푸시 알림은 아래 push 핸들러가 처리한다. 본문은 서버가 RFC 8291로 암호화해 보낸 것이다. */
const CACHE = 'onfactory-shell-v1'
const OFFLINE_URL = '/offline.html'
const SHELL = [OFFLINE_URL, '/manifest.webmanifest', '/icons/icon-192.png']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return // API는 서비스워커를 거치지 않는다
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)))
    return
  }
  if (SHELL.includes(url.pathname)) {
    event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request)))
  }
})

// ---------------------------------------------------------------------------
// 웹푸시. 알림을 누르면 이미 열려 있는 탭을 앞으로 가져오고, 없으면 새 창을 연다.
// ---------------------------------------------------------------------------
function notificationTarget(payload) {
  if (!payload || !payload.page) return '/'
  const params = new URLSearchParams({ page: payload.page })
  if (payload.focusId) params.set('focus', payload.focusId)
  return '/?' + params.toString()
}

self.addEventListener('push', (event) => {
  let payload = {}
  try { payload = event.data ? event.data.json() : {} } catch (error) { payload = {} }
  event.waitUntil(self.registration.showNotification(payload.title || '인더필드', {
    body: payload.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    // 같은 알림이 두 번 도착하면 덮어쓴다.
    tag: payload.id || payload.type || 'inthefield',
    data: { url: notificationTarget(payload) },
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of clients) {
      if (new URL(client.url).origin !== self.location.origin) continue
      await client.focus()
      // 이미 열린 앱은 새로고침 없이 해당 화면으로 이동한다.
      client.postMessage({ kind: 'notification-click', url })
      return
    }
    await self.clients.openWindow(url)
  })())
})

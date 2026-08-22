/* 온팩토리 서비스워커 — 설치 가능성(PWA) 확보 + 오프라인 "연결 없음" 안내만.
 * 데이터·API는 절대 캐시하지 않는다(네트워크 우선, 실패 시 문서 탐색에만 offline.html). 푸시 없음. */
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

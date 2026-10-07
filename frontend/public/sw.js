const CACHE = 'pkbm-cbt-shell-v2-forms'
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))))
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/realtime')) return
  // Do not persist SSO tickets or access-link tokens as cache keys. The
  // canonical shell contains no authenticated data; draft data lives in IDB.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(()=>caches.match('/index.html').then(cached=>cached||new Response('Offline',{status:503}))))
    return
  }
  if (!['script','style','font','image','manifest'].includes(request.destination)) return
  event.respondWith(caches.match(request).then((cached) => {
    const refresh = fetch(request).then((response) => {
      if (response.ok && response.type === 'basic') {
        const copy = response.clone()
        void caches.open(CACHE).then((cache) => cache.put(request, copy))
      }
      return response
    }).catch(() => cached || new Response('Offline', { status: 503, statusText: 'Offline' }))
    return cached || refresh
  }))
})

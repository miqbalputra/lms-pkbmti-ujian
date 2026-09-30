const CACHE = 'pkbm-cbt-shell-v1'
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
  if (request.method !== 'GET' || new URL(request.url).pathname.startsWith('/api/')) return
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

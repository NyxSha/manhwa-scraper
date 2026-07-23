const CACHE = 'manhwafuta-v3';
const ASSETS = [
  '/',
  '/index.html',
  '/login.html',
  '/favicon.gif',
  '/favicon.ico',
  '/manifest.json',
  '/icon-192x192.png',
  '/icon-512x512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
});

self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET') return;

  if (request.url.startsWith(self.location.origin + '/api/')) {
    e.respondWith(networkFirst(request));
  } else if (request.mode === 'navigate') {
    e.respondWith(networkFirstOrFallback(request));
  } else {
    e.respondWith(cacheFirst(request));
  }
});

async function cacheFirst(request) {
  try {
    const cached = await caches.match(request);
    if (cached) return cached;
    const res = await fetch(request);
    if (res.ok) {
      const cache = await caches.open(CACHE);
      cache.put(request, res.clone());
    }
    return res;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('Offline', { status: 503 });
  }
}

async function networkFirst(request) {
  try {
    const res = await fetch(request);
    if (res.ok || res.type === 'opaqueredirect') {
      const cache = await caches.open(CACHE);
      cache.put(request, res.clone());
    }
    return res;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (request.url.includes('/api/')) {
      return new Response(JSON.stringify({ error: 'offline' }), {
        status: 503, headers: { 'Content-Type': 'application/json' }
      });
    }
    return caches.match('/');
  }
}

async function networkFirstOrFallback(request) {
  try {
    const res = await fetch(request);
    if (res.ok || res.type === 'opaqueredirect') {
      const cache = await caches.open(CACHE);
      cache.put(request, res.clone());
    }
    return res;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return caches.match('/');
  }
}

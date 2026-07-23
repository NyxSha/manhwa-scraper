const CACHE = 'manhwafuta-v4';

self.addEventListener('install', e => {
  const ASSETS = [
    '/', '/index.html', '/login.html',
    '/favicon.gif', '/favicon.ico',
    '/manifest.json', '/icon-192x192.png', '/icon-512x512.png'
  ];
  e.waitUntil(
    caches.open(CACHE).then(async c => {
      await c.addAll(ASSETS).catch(() => {});
      const cdnUrls = [
        'https://cdn.tailwindcss.com',
        'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap'
      ];
      for (const url of cdnUrls) {
        try { const r = await fetch(url); if (r.ok) await c.put(url, r); } catch (_) {}
      }
    }).then(() => self.skipWaiting())
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
  } else {
    e.respondWith(cacheFirstWithFallback(request));
  }
});

async function cacheFirstWithFallback(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res.ok || res.type === 'opaqueredirect') {
      const cache = await caches.open(CACHE);
      cache.put(request, res.clone());
    }
    return res;
  } catch {
    if (request.mode === 'navigate') {
      const fallback = await caches.match('/');
      if (fallback) return fallback;
    }
    return new Response('', { status: 204 });
  }
}

async function networkFirst(request) {
  try {
    const res = await fetch(request);
    if (res.ok) {
      const cache = await caches.open(CACHE);
      cache.put(request, res.clone());
    }
    return res;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: 'offline' }), {
      status: 503, headers: { 'Content-Type': 'application/json' }
    });
  }
}

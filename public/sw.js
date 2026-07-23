const CACHE = 'manhwafuta-v2';
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
const CDN_ASSETS = [
  'https://cdn.tailwindcss.com',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => {
      // best-effort cache of CDN resources (non-blocking)
      caches.open(CACHE).then(c => c.addAll(CDN_ASSETS)).catch(() => {});
      self.skipWaiting();
    })
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
    e.respondWith(cacheFirst(request));
  }
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  return cached || fetch(request);
}

async function networkFirst(request) {
  try {
    const res = await fetch(request);
    const cache = await caches.open(CACHE);
    cache.put(request, res.clone());
    return res;
  } catch {
    return caches.match(request);
  }
}

/* Caches only the app's own static files (code + models) for offline use. User images are never fetched, so they never reach this cache. */
const CACHE = 'nukki-v2';
const IMMUTABLE = /\/(models|vendor)\//;
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'worker.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'vendor/ort.wasm.min.js', 'vendor/ort-wasm-simd-threaded.mjs',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // 모델/런타임: 캐시 우선. 앱 코드: 네트워크 우선(업데이트 반영), 오프라인이면 캐시.
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      if (IMMUTABLE.test(new URL(req.url).pathname)) {
        const hit = await cache.match(req, { ignoreSearch: true });
        if (hit) return hit;
      }
      try {
        const res = await fetch(req);
        if (res.status === 200) cache.put(req, res.clone());
        return res;
      } catch (err) {
        const hit = await cache.match(req, { ignoreSearch: true });
        if (hit) return hit;
        throw err;
      }
    }),
  );
});

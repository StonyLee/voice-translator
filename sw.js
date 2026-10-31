// 온라인이면 항상 서버에서 확인한 최신 파일을 쓰고, 오프라인일 때만 저장본을 쓴다. OpenAI 요청은 건드리지 않는다.
const CACHE = 'rt-translator-v8';
const FILES = ['./', 'index.html', 'styles.css', 'app.js', 'api.js', 'engine.js', 'worklet.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // 브라우저 HTTP 캐시(GitHub Pages 10분) 때문에 새 파일과 옛 파일이 섞이지 않도록 매번 서버에 확인한다
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    try {
      const res = await fetch(url.href, { cache: 'no-cache' });
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch (err) {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      if (cached) return cached;
      throw err;
    }
  }));
});

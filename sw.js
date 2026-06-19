const CACHE = 'sukimemo-v31';
const ASSETS = [
  '/sukimemo/',
  '/sukimemo/index.html',
  '/sukimemo/css/style.css',
  '/sukimemo/js/db.js',
  '/sukimemo/js/import.js',
  '/sukimemo/js/app.js',
  '/sukimemo/manifest.json',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
  // 新バージョンがアクティブになったら全クライアントに通知
  self.clients.matchAll().then(clients => {
    clients.forEach(c => c.postMessage({ type: 'sw-updated', version: CACHE }));
  });
});

self.addEventListener('fetch', e => {
  if (e.request.url.includes('note.com')) return;
  if (e.request.url.includes('workers.dev')) return;
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});

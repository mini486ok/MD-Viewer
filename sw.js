/* sw.js — 앱 셸 + 라이브러리 오프라인 캐시 (정적 자산만, 사용자 업로드 문서는 캐시하지 않음) */
const CACHE = 'md-viewer-v4';
const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/hwpx.js',
  './vendor/marked.min.js',
  './vendor/purify.min.js',
  './vendor/jszip.min.js',
  './vendor/highlight.min.js',
  './vendor/hljs-styles/github.min.css',
  './vendor/hljs-styles/github-dark.min.css',
  './favicon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  './manifest.webmanifest',
  './sample.md'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return; // 원격(이미지 등)은 가로채지 않음

  // 페이지 내비게이션: 앱 셸(index.html)로 폴백 (오프라인 단일 페이지)
  if (req.mode === 'navigate') {
    e.respondWith(
      caches.match('./index.html').then((cached) => cached || fetch(req).catch(() => caches.match('./index.html')))
    );
    return;
  }

  // 그 외 동일 출처 자산: 캐시 우선, 없으면 네트워크 그대로(실패를 은폐하지 않음).
  // 런타임에 임의 응답을 캐시에 넣지 않는다(오염 고착·문서 캐시 방지). 자산은 install 에서 선캐시됨.
  e.respondWith(caches.match(req).then((cached) => cached || fetch(req)));
});

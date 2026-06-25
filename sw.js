// sw.js — service worker for Math Galaxy.
//
// Makes the app installable and fully usable OFFLINE via the keypad. (The mic
// uses a cloud recognizer, so voice answers still need internet — but the game,
// progress, and tap input all work with no connection.)
//
// Strategy: precache the app shell on install; serve same-origin GETs
// cache-first with a background refresh (stale-while-revalidate). Bump CACHE
// whenever shell files change so clients pick up the new version.

const CACHE = 'math-galaxy-v4';

// Paths are relative to this file's location, so it works under any base path
// (e.g. a GitHub Pages project subpath like /math-galaxy/).
const CORE = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/engine.js',
  './js/levels.js',
  './js/numbers.js',
  './js/speech.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // Navigations: try network first (fresh app), fall back to cached shell offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(() => caches.match('./index.html', { ignoreSearch: true }))
    );
    return;
  }

  // Everything else: stale-while-revalidate. Serve cache immediately if present,
  // refresh it in the background. Works for same-origin shell and (after first
  // online load) the cross-origin web font too.
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          // Cache successful or opaque (cross-origin font) responses.
          if (res && (res.ok || res.type === 'opaque')) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached); // offline: fall back to whatever we have
      return cached || network;
    })
  );
});

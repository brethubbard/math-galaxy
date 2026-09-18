// sw.js — service worker for Math Galaxy.
//
// Makes the app installable and fully usable OFFLINE. Voice recognition is
// on-device (Vosk), so once the model is cached the whole experience — game,
// progress, tap AND voice — works with no connection at all.
//
// Strategy: precache the app shell on install, then serve the shell
// NETWORK-FIRST with a cache fallback. Cache-first (stale-while-revalidate) was
// wrong for the shell: navigations are network-first, so a returning child got
// the NEW index.html running the OLD cached js/*.js + styles.css for a whole
// load. That version skew is what made the Fluency Run button render (the old
// styles.css has no `[hidden]` override, and `.btn` sets display:flex) while
// doing nothing when tapped (the old app.js binds no handler for it). Serving
// the shell from the network keeps HTML, JS and CSS on the same deploy; the
// cache is the offline fallback, not the default source.
//
// The ~40 MB Vosk model lives in a SEPARATE, persistent cache (MODEL_CACHE,
// populated by the app at boot — see js/vosk-engine.js). It stays CACHE-FIRST —
// it is immutable and far too big to revalidate — and we never delete it on
// activate, so bumping the shell version never forces a re-download.
//
// Bump CACHE whenever shell files change so installed clients reinstall.

const CACHE = 'math-galaxy-v10';
const MODEL_CACHE = 'math-galaxy-model';

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
  './js/tts.js',
  './js/vosk-engine.js',
  './js/multiplayer.js',
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
      // Drop old shell caches, but KEEP the persistent model cache so the 40 MB
      // voice model survives shell-version bumps.
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE && k !== MODEL_CACHE).map((k) => caches.delete(k))
      ))
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

  // The voice model: cache-first out of the persistent MODEL_CACHE. It never
  // changes and it is ~40 MB, so it must never be re-fetched to revalidate.
  // caches.match() is global, which is how vosk-browser's worker gets it offline.
  if (sameOrigin && url.pathname.includes('/models/')) {
    e.respondWith(caches.match(req).then((cached) => cached || fetch(req)));
    return;
  }

  // The app shell (js, css, manifest, icons): NETWORK-FIRST, cache fallback, so
  // every file on a given load comes from the same deploy. Refresh the cache on
  // each success; fall back to it when offline.
  if (sameOrigin) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }))
    );
    return;
  }

  // Cross-origin (the web font): stale-while-revalidate is fine — it is
  // versioned by URL, so a stale copy can't disagree with our own code.
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
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

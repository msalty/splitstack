/* ==========================================================================
   SplitStack service worker

   Caching strategy, and why it matters for staleness:

     · code (HTML / JS / manifest)  → NETWORK FIRST, cache as fallback
       So a reload always picks up a new build when you're online, and still
       works instantly when you're not. This is the important one: serving
       app.js cache-first is what makes a PWA feel permanently out of date.

     · artwork (icons, images)      → CACHE FIRST
       These effectively never change, and they're the ones worth having
       instantly.

     · the API                      → never touched
       app.js owns offline behaviour there, via IndexedDB and the outbox.

   Bump SW_BUILD whenever you re-upload the app. It isn't load-bearing —
   network-first means fresh code arrives regardless — but it makes the
   service worker itself update and gives Settings something to display.
   ========================================================================== */

const SW_BUILD = '2026-08-08.3';
const CACHE    = 'splitstack-' + SW_BUILD;

const SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png'
];

/* How long we'll wait for the network before falling back to cache. Keeps a
   flaky connection from making the app feel frozen. */
const NET_TIMEOUT = 3500;

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(SHELL.map(u => c.add(new Request(u, { cache: 'reload' })))))
    // deliberately no skipWaiting(): the app asks the user first, so an update
    // can't swap code out from under someone mid-edit
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', e => {
  const msg = e.data;
  if (msg === 'skipWaiting') return self.skipWaiting();

  if (msg === 'version') {
    e.source && e.source.postMessage({ type: 'version', build: SW_BUILD, cache: CACHE });
    return;
  }

  if (msg === 'clearCaches') {
    e.waitUntil(
      caches.keys()
        .then(keys => Promise.all(keys.map(k => caches.delete(k))))
        .then(() => { e.source && e.source.postMessage({ type: 'cachesCleared' }); })
    );
  }
});

function fromNetworkFirst(req) {
  const net = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('slow')), NET_TIMEOUT);
    fetch(req).then(r => { clearTimeout(t); resolve(r); }, err => { clearTimeout(t); reject(err); });
  });

  return net
    .then(r => {
      if (r && r.status === 200 && r.type === 'basic') {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return r;
    })
    .catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')));
}

function fromCacheFirst(req) {
  return caches.match(req).then(hit => {
    if (hit) return hit;
    return fetch(req).then(r => {
      if (r && r.status === 200 && r.type === 'basic') {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return r;
    });
  });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // The API is app.js's problem, not ours.
  if (/script\.google(usercontent)?\.com/.test(req.url)) return;

  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') { e.respondWith(fromNetworkFirst(req)); return; }

  if (/\.(js|css|webmanifest|json)$/i.test(url.pathname)) {
    e.respondWith(fromNetworkFirst(req));
    return;
  }

  e.respondWith(fromCacheFirst(req));
});

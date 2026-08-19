/**
 * TRACE rider service worker. FR-OFF-004, FR-RDR-015.
 *
 * The shell is precached so the app launches and functions with no network at
 * all. Delivery DATA is deliberately NOT cached here — it lives in IndexedDB
 * where FR-AUT-008 can delete it synchronously when the rider goes off shift.
 * A Cache Storage copy would survive that teardown and quietly break the
 * privacy guarantee.
 */
const SHELL = 'trace-shell-v1';
const SHELL_URLS = ['/rider', '/rider/login', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(SHELL_URLS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Never cache API or auth traffic: a stale delivery state is worse than no
  // delivery state, and a cached auth response is a security problem.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/rest/') || url.pathname.startsWith('/auth/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/rider').then((r) => r ?? Response.error())),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ??
        fetch(request).then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            void caches.open(SHELL).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});

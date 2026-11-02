/* Bump the shell version when shipping changes to a precached file. */
const CACHE_PREFIX = 'gone-shell-';
const CACHE_NAME = `${CACHE_PREFIX}v3`;
const SHELL_FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './task-store.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];
const SHELL_URLS = new Set(
  SHELL_FILES.map((path) => new URL(path, self.location.href).href),
);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // addAll rejects a partial or unsuccessful download: never activate an
    // incomplete offline shell in place of a working previous installation.
    await cache.addAll(SHELL_FILES);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) return response;
      } catch {
        // A previously verified shell works without a network connection.
      }
      const cache = await caches.open(CACHE_NAME);
      const fallback = await cache.match(new URL('./index.html', self.location.href));
      return fallback || Response.error();
    })());
    return;
  }

  // Cache only this app's known shell. Never persist arbitrary local API data.
  if (!SHELL_URLS.has(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      await cache.put(request, response.clone());
    }
    return response;
  })());
});

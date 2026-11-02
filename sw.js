/* Bump the shell version when shipping changes to a precached file. */
const CACHE_PREFIX = 'gone-shell-';
const CACHE_NAME = `${CACHE_PREFIX}v8`;
const READER_PATH = new URL('./reader/', self.location.href).pathname;
const SHELL_FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './task-store.js',
  './completion-sound.js',
  './styles.css?v=8',
  './app.js?v=8',
  './task-store.js?v=8',
  './completion-sound.js?v=8',
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
    await cache.addAll(SHELL_FILES.map(path => new Request(path, { cache: 'reload' })));
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
    // An older Gone worker may have served its shell at the new reader URL.
    // Keep an already running Slidecast tab; refresh only a stale app shell.
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    await Promise.all(windows.filter(client => new URL(client.url).pathname.startsWith(READER_PATH)).map(async client => {
      const isReader = await new Promise(resolve => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => { channel.port1.close(); resolve(false); }, 500);
        channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data?.app === 'slidecast'); };
        client.postMessage({ type: 'identify-slidecast' }, [channel.port2]);
      });
      if (!isReader) await client.navigate(client.url).catch(() => {});
    }));
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname === READER_PATH.slice(0, -1) || url.pathname.startsWith(READER_PATH)) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      // A cached document and its imports must always belong to the same release.
      const cache = await caches.open(CACHE_NAME);
      const fallback = await cache.match(new URL('./index.html', self.location.href));
      return fallback || fetch(request);
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

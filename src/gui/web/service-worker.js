'use strict';

const SHELL_CACHE = 'tguserbot-shell-v1';
const STATIC_FILE = /\.(?:html|css|js|svg|png|jpe?g|webp|woff2?)$/i;
const PRIVATE_PATH = /^(?:api|media|upload|ws)(?:\/|$)/i;

function isPrivatePath(pathname, scopePath) {
  return PRIVATE_PATH.test(pathname.slice(scopePath.length).replace(/^\/+/, ''));
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const scope = new URL(self.registration.scope);
    const root = new URL('./', scope);
    const cache = await caches.open(SHELL_CACHE);
    const response = await fetch(root, { cache: 'no-store' });
    if (!response.ok) throw new Error('Unable to load the offline shell');
    await cache.put(root, response.clone());
    const html = await response.text();
    const assets = new Set();
    for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/gi)) {
      try {
        const asset = new URL(match[1], root);
        if (asset.origin === scope.origin && asset.pathname.startsWith(scope.pathname) && !isPrivatePath(asset.pathname, scope.pathname) && STATIC_FILE.test(asset.pathname)) assets.add(asset.href);
      } catch (_) {}
    }
    await Promise.all([...assets].map(async asset => {
      try {
        const file = await fetch(asset, { cache: 'no-store' });
        if (file.ok) await cache.put(asset, file);
      } catch (_) {}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('tguserbot-shell-') && key !== SHELL_CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const scope = new URL(self.registration.scope);
  const url = new URL(request.url);
  // Never persist API, media, upload, or cross-origin content.
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname) || isPrivatePath(url.pathname, scope.pathname) ||
      !(request.mode === 'navigate' || STATIC_FILE.test(url.pathname))) return;

  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(SHELL_CACHE);
        await cache.put(request, response.clone());
      }
      return response;
    } catch (error) {
      const cached = await caches.match(request);
      if (cached) return cached;
      if (request.mode === 'navigate') {
        const shell = await caches.match(new URL('./', scope).href);
        if (shell) return shell;
      }
      throw error;
    }
  })());
});

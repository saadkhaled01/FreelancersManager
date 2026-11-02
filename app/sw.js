/* App shell cache. Network first so updates show up immediately; cache is the offline fallback. API calls are never cached here. */
const CACHE = "fm-shell-v1";
const SHELL = ["/", "/app.css", "/app.js", "/i18n.js", "/manifest.webmanifest", "/icon.svg", "/icon-192.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api/")) return;
  const sameOrigin = url.origin === location.origin;
  const isFont = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (!sameOrigin && !isFont) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(e.request);
      if (res.ok || res.type === "opaque") cache.put(e.request.mode === "navigate" ? "/" : e.request, res.clone());
      return res;
    } catch {
      return (await cache.match(e.request.mode === "navigate" ? "/" : e.request)) || Response.error();
    }
  })());
});

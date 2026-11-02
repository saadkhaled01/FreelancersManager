/* App shell cache. Network first so updates show up immediately; cache is the offline fallback. API calls are never cached here. */
const CACHE = "fm-shell-v4";
const SHELL = [
  "/", "/app.css", "/app.js", "/i18n.js", "/fonts.css", "/doc.css", "/doc-data.js", "/doc-render.js",
  "/manifest.webmanifest", "/icon.svg", "/icon-192.png",
  "/fonts/readex-pro-arabic.woff2", "/fonts/readex-pro-latin.woff2", "/fonts/alexandria-arabic.woff2", "/fonts/alexandria-latin.woff2",
  "/fonts/ibm-plex-mono-500.woff2", "/fonts/ibm-plex-mono-600.woff2",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api/")) return;
  // Shared documents (/d/…) always come from the network: they are someone else's live data.
  if (url.origin !== location.origin || url.pathname.startsWith("/d/")) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(e.request);
      if (res.ok) cache.put(e.request.mode === "navigate" ? "/" : e.request, res.clone());
      return res;
    } catch {
      return (await cache.match(e.request.mode === "navigate" ? "/" : e.request)) || Response.error();
    }
  })());
});

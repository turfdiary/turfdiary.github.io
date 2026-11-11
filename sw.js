/* TurfDiary service worker: keeps the app working offline.
   Change VERSION whenever you upload new app files so phones pick up the update. */
const VERSION = "turfdiary-v11";
const FILES = ["./", "./index.html", "./app.js", "./styles.css", "./manifest.webmanifest",
  "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)));
  self.skipWaiting();
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return; // soil data always comes fresh from the network
  e.respondWith(caches.open(VERSION).then(cache =>
    cache.match(e.request).then(hit => {
      const fresh = fetch(e.request).then(res => { if (res.ok) cache.put(e.request, res.clone()); return res; })
        .catch(() => hit || cache.match("./index.html"));
      return hit || fresh;
    })
  ));
});

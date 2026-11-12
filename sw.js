/* TurfDiary service worker: keeps the app working offline.
   Change VERSION whenever you upload new app files so phones pick up the update. */
const VERSION = "turfdiary-v24";
const FILES = ["./", "./index.html", "./app.js", "./styles.css", "./manifest.webmanifest",
  "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png",
  "./sc-mow.png", "./sc-receipt.png", "./sc-log.png"];

self.addEventListener("install", e => {
  /* cache: "reload" skips the browser's own short-term cache so the newest files are stored */
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES.map(f => new Request(f, { cache: "reload" })))));
  self.skipWaiting();
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  /* "Share to TurfDiary": a receipt photo or PDF shared from another app */
  if (e.request.method === "POST" && url.pathname.endsWith("/share-target")) {
    e.respondWith((async () => {
      try {
        const form = await e.request.formData();
        const file = form.get("receipt");
        if (file && file.size) {
          const c = await caches.open("turfdiary-share");
          await c.put("./shared-receipt", new Response(file, { headers: { "Content-Type": file.type || "application/octet-stream", "X-Name": encodeURIComponent(file.name || "") } }));
        }
      } catch (err) {}
      return Response.redirect("./?action=shared", 303);
    })());
    return;
  }
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return; // soil data always comes fresh from the network
  e.respondWith(caches.open(VERSION).then(cache =>
    cache.match(e.request, { ignoreSearch: e.request.mode === "navigate" }).then(hit => {
      const fresh = fetch(e.request).then(res => { if (res.ok) cache.put(e.request, res.clone()); return res; })
        .catch(() => hit || cache.match("./index.html"));
      return hit || fresh;
    })
  ));
});

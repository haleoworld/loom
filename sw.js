/* Loom service worker — keep the app openable offline; never cache data. */
const CACHE = "loom-shell-v4";
const SHELL = ["./", "./index.html", "./sw.js"];

self.addEventListener("install", e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET") return;                       // never touch PUTs
  if (url.pathname.replace(/^\/loom/, "").endsWith("/data")) return; // data: always network
  // stale-while-revalidate for the shell
  e.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(req, { ignoreSearch: true }).then(cached => {
        const net = fetch(req).then(resp => {
          if (resp && resp.status === 200 && resp.type === "basic") cache.put(req, resp.clone());
          return resp;
        }).catch(() => cached);
        return cached || net;
      })
    )
  );
});

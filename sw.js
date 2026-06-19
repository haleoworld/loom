/* Loom service worker — keep the app openable offline; never cache data.
   Navigations are network-first (always load the latest app when the Mini is
   reachable; fall back to cache only when offline). Other assets: SWR. */
const CACHE = "loom-shell-v20";
const SHELL = ["./", "./index.html", "./sw.js", "./docs/workflow.svg"];

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
  if (req.method !== "GET") return;                                  // never touch PUTs
  if (url.pathname.replace(/^\/loom/, "").endsWith("/data")) return; // data: always network

  const isNav = req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html");
  if (isNav) {
    // network-first: latest app when online, cache fallback when offline
    e.respondWith(
      fetch(req).then(resp => {
        if (resp && resp.status === 200) { const c = resp.clone(); caches.open(CACHE).then(cache => cache.put(req, c)); }
        return resp;
      }).catch(() =>
        caches.open(CACHE).then(cache => cache.match(req, { ignoreSearch: true }).then(r => r || cache.match("./")))
      )
    );
    return;
  }

  // other assets: stale-while-revalidate
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

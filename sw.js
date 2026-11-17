/* Service worker: network-first for everything (fresh data, avatars and app code),
   falling back to the last cached copy only when offline. */
const VERSION = "v14";
const SHELL = `shell-${VERSION}`;
const DATA = `data-${VERSION}`;
const SHELL_FILES = ["./", "index.html", "styles.css", "app.js", "styles.css?v=13", "app.js?v=13", "vendor/fflate.js?v=0.8.3", "manifest.json",
  "icons/icon.svg", "icons/icon-192.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL)
    .then((c) => c.addAll(SHELL_FILES.map((u) => new Request(u, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k))
  )).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // GitHub API, fonts, thumbnails: browser default
  // Google's OAuth return carries a one-time code in the query: never cache it, never touch it
  if (url.pathname.endsWith("/oauth.html")) return;
  const isData = url.pathname.endsWith(".json") || url.pathname.includes("/data/");
  if (isData) {
    // data/*.json and data/avatars/*: always the network (no HTTP cache), offline copy as fallback
    const key = url.origin + url.pathname; // ignore cache-busting query
    e.respondWith(fetch(e.request, { cache: "no-store" }).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(DATA).then((c) => c.put(key, copy)); }
      return res;
    }).catch(() => caches.match(key)));
    return;
  }
  e.respondWith(fetch(e.request, { cache: "no-cache" }).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then((hit) => hit || caches.match("index.html"))));
});

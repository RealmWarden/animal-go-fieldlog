/* Offline shell for the Animal Go field log.

   Two caching strategies, split by whether the file changes between releases.
   The split is not a micro-optimisation: a uniformly cache-first service worker
   masked a broken deploy three separate times in this project — a stale model
   file that looked like a model bug, an old taxonomy on the phone, and a
   scanner that could not start while the page insisted everything was fine.
   Cache-first is exactly wrong for code, because it means the newest version of
   the app is the last thing the app will show you.

     code and markup  -> NETWORK FIRST, cache as a fallback.
                         Costs a few hundred milliseconds on a cold launch with
                         signal. Buys: what you see is what was deployed, and
                         full function with no signal at all.
     data and assets  -> CACHE FIRST.
                         The species data (~670 KB), the 22 MB classifier, the
                         Wikipedia photographs, the fonts and the classifier
                         runtime. These are immutable per release, large, or
                         both. The model is deliberately NOT in the shell list:
                         installing it would mean a 22 MB download before the
                         app first opens. It lands in the cache the first time
                         the scanner loads it.

   Bump CACHE on every deploy; the old cache is deleted on activate. */
const CACHE = "animalgo-v14";

const SHELL = [
  "./", "./index.html", "./app.js", "./place.js", "./walk.js", "./rollup.js", "./engine.js", "./scan.js",
  "./worker.js", "./styles.css", "./manifest.webmanifest",
  "./data/stat_grid.json", "./data/taxonomy.json", "./data/species.json",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-180.png",
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE)
      // addAll is all-or-nothing; one bad entry would leave the app uninstallable
      .then(c => Promise.allSettled(SHELL.map(u => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const put = (req, res) => {
  if (res && res.ok) {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
  }
  return res;
};

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Immutable, cross-origin: fonts, Wikipedia photographs, the classifier
  // runtime. Caching the photos is what keeps a record illustrated out of
  // signal; caching the runtime is what keeps the scanner working out of
  // signal while the runtime still lives on a CDN.
  const immutableRemote =
    /fonts\.(googleapis|gstatic)\.com/.test(req.url) ||
    /(thumb\.wikimedia\.org|upload\.wikimedia\.org)/.test(req.url) ||
    /cdn\.jsdelivr\.net\/npm\/@litertjs/.test(req.url);

  if (immutableRemote) {
    e.respondWith(caches.match(req).then(hit =>
      hit || fetch(req).then(res => put(req, res)).catch(() => Response.error())));
    return;
  }

  if (url.origin !== location.origin) return;

  // Immutable, same-origin: the model parts and the species data.
  if (/\/(model|data)\//.test(url.pathname)) {
    e.respondWith(caches.match(req).then(hit =>
      hit || fetch(req).then(res => put(req, res))));
    return;
  }

  // The diagnostics are never cached at all, so a newer one cannot be masked.
  if (/\/(bench[\w-]*|scan-test)\.html$/.test(url.pathname)) return;

  // Everything else — the app itself. Network first.
  e.respondWith(
    fetch(req).then(res => put(req, res))
      .catch(() => caches.match(req).then(hit => hit || caches.match("./index.html")))
  );
});

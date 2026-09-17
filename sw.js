/* Offline shell for the Animal Go field log.
   Cache-first: once installed, the app runs with no network at all. The species
   data is ~670 KB and never changes between releases, so it is cached with the
   shell rather than fetched each launch. Bump CACHE on every deploy — the old
   cache is deleted on activate. */
const CACHE = "animalgo-v5";
const SHELL = [
  "./", "./index.html", "./app.js", "./styles.css", "./manifest.webmanifest",
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

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;

  // Fonts from a CDN, and species photos from Wikimedia: serve from cache,
  // refresh in the background. Caching the photos is what keeps a record
  // illustrated when you are out of signal.
  const isFont = /fonts\.(googleapis|gstatic)\.com/.test(req.url);
  const isPhoto = /(thumb\.wikimedia\.org|upload\.wikimedia\.org)/.test(req.url);
  if (isFont || isPhoto) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => hit || Response.error())));
    return;
  }

  if (new URL(req.url).origin !== location.origin) return;

  // The benchmark page is a diagnostic: always take the network copy so a newer
  // version is never masked by the offline cache.
  if (/\/bench\.html$/.test(new URL(req.url).pathname)) return;

  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match("./index.html")))
  );
});

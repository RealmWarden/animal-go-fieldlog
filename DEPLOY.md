# Getting the field log onto your iPhone

Everything in this folder is the app. No build step, no npm, no bundler — it's
plain HTML, CSS, JS and JSON. You need to put it behind **HTTPS**, because service
workers and geolocation refuse to run otherwise. That's the only requirement.

## Fastest route: GitHub Pages (free)

1. Make a new repo, e.g. `animal-go-fieldlog`. Public is simplest; Pages on a
   private repo needs a paid plan.
2. Upload **the contents of this `pwa/` folder to the repo root** — so
   `index.html` sits at the top level, with `data/` and `icons/` beside it.
   Drag-and-drop in the GitHub web UI works; it keeps folder structure.
3. Repo → **Settings → Pages** → Source: *Deploy from a branch* → branch `main`,
   folder `/ (root)` → Save.
4. Wait a minute or two. Your URL will be
   `https://<your-username>.github.io/animal-go-fieldlog/`.

### Then, on your iPhone

1. Open that URL in **Safari** (it must be Safari — Chrome on iOS can't install
   web apps).
2. Tap the **Share** button, scroll down, tap **Add to Home Screen**.
3. It installs as "Field Log" with its own icon, opens without browser chrome,
   and works with no signal once it's loaded itself the first time.

## Other hosts

Any static host works and the files need no changes:

- **Netlify** / **Cloudflare Pages** — drag the folder onto their dashboard.
- **Vercel** — `vercel deploy` in this directory.

## Updating it later

The service worker caches aggressively, which is what makes it work offline. When
you deploy a new version, **bump `CACHE` in `sw.js`** (e.g. `animalgo-v1` →
`animalgo-v2`). The old cache is deleted automatically on activation. Without the
bump, installed copies keep serving the old files.

## Checking it actually installed right

- Offline test: turn on Airplane Mode and open it from the home screen. It should
  load fully.
- If it opens in a browser tab with an address bar, the manifest didn't load —
  check that `manifest.webmanifest` is being served and the paths are right.
- Fonts come from Google Fonts on first load. If you install while offline the
  layout falls back to system fonts, which is fine but looks different.

## What this version does and doesn't do

**Does:** the whole collection loop — record a species, roll an individual, the
wild/captive rules, uncertain identification with genus records and promotion, the
dex, the roster with filters, the active squad, distance to XP, export/import.

**Doesn't yet:** use the camera (species picker stands in for the scan), use real
GPS (locality is typed; the GPS button fills coordinates but nothing is
reverse-geocoded), or run the actual classifier. Those are Phase 2 and 3.

## One caveat worth knowing

iOS can clear a web app's storage after a few weeks without use. Your records live
in `localStorage`, so **use the Export button now and then** — it's the only real
backup, and Import restores from it.

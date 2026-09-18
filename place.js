/* ============================================================
   Where you are, without being asked.

   The locality field used to be a text box. Standing in a field with a bee in
   front of you is the worst possible moment to think of a place name and type
   it, and it is the same flaw the species dropdown had: the phone already knows
   the answer. So the app watches position while it is open, names the place
   once, and the field becomes something you can correct rather than something
   you must fill.

   Two geocoders, in order:
     Nominatim (OpenStreetMap) -- names parks, trails and neighbourhoods, which
       is what a locality dex is actually about. "Griffith Park" is a place you
       remember; "Los Angeles" is not. Used within its policy: user-triggered,
       one request per new place, heavily cached, well under 1/second.
     BigDataCloud -- no key, client-side only by design, city-level. The
       fallback when Nominatim is unreachable or rate-limited.

   Raw coordinates are stored on every record regardless, so a better geocoder
   (or the park boundary data in design doc s5.2) can re-resolve names later
   without the records having lost anything.
   ============================================================ */
(function(global){
"use strict";

const CACHE_KEY = "animalgo.places.v1";
const GRID = 3;              // decimal places ~ 110 m; one lookup per place, not per scan
const STALE_MS = 60000;      // a fix older than this is not "where you are now"

let cache = {};
try{ cache = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}"); }catch(e){}
const saveCache = () => { try{ localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); }catch(e){} };

const gridKey = (lat, lon) => lat.toFixed(GRID) + "," + lon.toFixed(GRID);

let fix = null;              // {lat, lon, acc, at}
let watchId = null;
let listeners = [];
let denied = false;

const emit = () => listeners.forEach(f => { try{ f(); }catch(e){} });

/* --- naming ---------------------------------------------------------------- */

// Pick the most specific name that is still a place rather than an address.
// Nominatim's address object goes from building up to country; a house number
// is not a locality and "United States" is not either.
function nameFromNominatim(d){
  if (!d) return null;
  const a = d.address || {};
  const specific = a.leisure || a.park || a.nature_reserve || a.protected_area ||
                   a.tourism || a.garden || a.beach || a.water || a.wood ||
                   a.neighbourhood || a.suburb || a.hamlet || a.village ||
                   a.town || a.city_district || a.city || a.county;
  const region = a.state || a.province || a.region;
  if (!specific) return null;
  // A short region suffix disambiguates without turning the chip into an address.
  return region && region !== specific ? `${specific}, ${region}` : specific;
}

async function viaNominatim(lat, lon){
  const u = "https://nominatim.openstreetmap.org/reverse?format=jsonv2" +
            `&lat=${lat}&lon=${lon}&zoom=16&addressdetails=1`;
  const r = await fetch(u, {headers:{Accept:"application/json"}});
  if (!r.ok) return null;
  return nameFromNominatim(await r.json());
}

async function viaBigDataCloud(lat, lon){
  const u = "https://api.bigdatacloud.net/data/reverse-geocode-client" +
            `?latitude=${lat}&longitude=${lon}&localityLanguage=en`;
  const r = await fetch(u);
  if (!r.ok) return null;
  const d = await r.json();
  const specific = d.locality || d.city;
  const region = d.principalSubdivision;
  if (!specific) return region || null;
  return region && region !== specific ? `${specific}, ${region}` : specific;
}

/* Resolve one place name. Cached by a ~110 m grid square, so a walk around a
   park is one lookup, not one per animal. A miss is cached too: a spot with no
   name does not become a lookup every time you stand in it. */
async function nameFor(lat, lon){
  const k = gridKey(lat, lon);
  if (k in cache) return cache[k];
  let name = null;
  try{ name = await viaNominatim(lat, lon); }catch(e){}
  if (!name){ try{ name = await viaBigDataCloud(lat, lon); }catch(e){} }
  // Offline: don't cache the failure, or the place stays nameless forever.
  if (name === null && !navigator.onLine) return null;
  cache[k] = name; saveCache();
  return name;
}

/* --- position -------------------------------------------------------------- */

function start(){
  if (watchId !== null || !navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition(
    p => {
      denied = false;
      fix = {lat: p.coords.latitude, lon: p.coords.longitude,
             acc: p.coords.accuracy, at: Date.now()};
      emit();
      // Name it in the background; the chip fills in when it arrives.
      nameFor(fix.lat, fix.lon).then(n => { if (n !== undefined) emit(); });
    },
    err => { if (err.code === 1) denied = true; emit(); },
    {enableHighAccuracy: true, maximumAge: 15000, timeout: 20000}
  );
}

function stop(){
  if (watchId !== null){ navigator.geolocation.clearWatch(watchId); watchId = null; }
}

function current(){
  if (!fix) return null;
  return {...fix, stale: Date.now() - fix.at > STALE_MS,
          name: cache[gridKey(fix.lat, fix.lon)] ?? undefined};   // undefined = still looking
}

global.AGP = {
  start, stop, current, nameFor, denied: () => denied,
  onChange: f => listeners.push(f),
  // exposed for the test suite and for re-resolving old records later
  _cache: () => cache,
};
})(typeof window !== "undefined" ? window : globalThis);

/* ============================================================
   Distance, without keeping the app open.

   iOS gives a home-screen web app no background execution at all — no
   background geolocation, no Background Sync, no Periodic Background Sync, no
   waking a service worker on a schedule. Nothing this app does can measure a
   walk it did not witness. That is a platform fact, not a missing feature, and
   any design that pretends otherwise will quietly under-report forever.

   So the rule here is: CREDIT THE PROVABLE MINIMUM.

     while the app is open   the position watch gives a dense track, and the
                             distance between consecutive fixes is real walking
     while it was closed     the next fix is compared with the last one. The
                             straight line between them is the shortest path
                             you could possibly have taken, so crediting it can
                             never over-pay. Walk a 5 km loop back to where you
                             started and it credits nothing; walk 5 km out and
                             it credits nearly all of it.

   You are always credited less than you walked, never more, and you never have
   to do anything. Design doc s8.2 wanted anti-cheese measures bolted on; this
   shape gets them for free. A car journey fails the walking-speed test on the
   bridge and is discarded outright, and there is no way to inflate a number
   that is a lower bound on a measured displacement.

   For anyone who wants the true figure, ingest() accepts a day total from
   outside — an iOS Shortcut reading Walking + Running Distance out of Health,
   which the phone has been counting all along with its own always-on hardware.
   That is a one-time setup, and the app works without it.
   ============================================================ */
(function(global){
"use strict";

const MAX_WALK_MS = 2.5;      // m/s. ~9 km/h: a fast walk or a slow jog, not a car.
const MIN_STEP_M = 5;         // below this it is GPS jitter, not movement
const MIN_DT_MS = 2000;
const MAX_ACC_M = 50;         // a fix this vague cannot measure a 5 m step
const DAY_CAP_M = 60000;      // 60 km in a day is a bug or a bicycle

const today = () => new Date().toLocaleDateString("en-CA");   // local YYYY-MM-DD

/* The store is reached through a getter, not captured once. Loading a save and
   importing an export both REPLACE the store object, and a captured reference
   would keep accruing distance into an object nothing else can see. */
let getStore = null;
const ST = () => {
  const s = getStore && getStore();
  if (!s) throw new Error("walk.js: attach(() => store) first");
  return s;
};

function haversine(a, b){
  const R = 6371000, r = Math.PI/180;
  const dLat = (b.lat-a.lat)*r, dLon = (b.lon-a.lon)*r;
  const s = Math.sin(dLat/2)**2 +
            Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));
}

function state(){
  const s = ST();
  if (!s.walk) s.walk = {day: today(), m: 0, ext: 0, credited: 0, last: null};
  const w = s.walk;
  if (w.day !== today()){
    // A new day starts its own budget. `last` survives, so an overnight move
    // still bridges — it just counts against the new day.
    w.day = today(); w.m = 0; w.ext = 0; w.credited = 0;
  }
  return w;
}

let onGain = () => {};

/* Fold whatever we now believe about today into the all-time total, and report
   the difference. max() rather than sum(): the tracked distance and a Health
   figure are two measurements of the same day, not two days.

   What to DO with the gain — add it to the lifetime total, pay the squad, save
   — belongs to the app, not here. This file's job is to decide how far you
   walked, and it should be testable without a game attached. */
function settle(){
  const w = state();
  const want = Math.min(DAY_CAP_M, Math.max(w.m, w.ext));
  const gain = want - w.credited;
  if (gain <= 0) return 0;
  w.credited = want;
  onGain(gain / 1000);
  return gain;
}

/* One new position. Returns the metres accepted, and why if none. */
function fix(p){
  const w = state();
  const now = {lat: p.lat, lon: p.lon, t: p.at || Date.now(), acc: p.acc ?? 0};
  if (now.acc > MAX_ACC_M) return {m: 0, why: "fix too vague"};

  const prev = w.last;
  w.last = now;
  if (!prev) return {m: 0, why: "first fix"};

  const dt = now.t - prev.t;
  if (dt < MIN_DT_MS) { w.last = prev; return {m: 0, why: "too soon"}; }

  const d = haversine(prev, now);
  if (d < MIN_STEP_M) { w.last = prev; return {m: 0, why: "jitter"}; }
  if (d / (dt/1000) > MAX_WALK_MS) return {m: 0, why: "faster than walking"};

  w.m += d;
  settle();
  return {m: d, why: null};
}

/* A day total reported from outside — Health, via a Shortcut. Monotone: a
   later, larger figure for the same day tops up, a smaller one is ignored. */
function ingest(metres, day){
  const w = state();
  if (day && day !== w.day) return 0;
  const v = Number(metres);
  if (!isFinite(v) || v <= 0) return 0;
  w.ext = Math.max(w.ext, v);
  return settle();
}

/* Read a top-up out of the URL, so a Shortcut only has to open a link:
     ...?km=4.2   or   ?m=4200   (optionally &d=2026-09-17)
   The parameter is stripped afterwards so a reload cannot double-count it —
   though ingest() is idempotent anyway, being a max rather than a sum. */
function ingestFromUrl(){
  const q = new URLSearchParams(location.search);
  const km = q.get("km"), m = q.get("m");
  if (km === null && m === null) return 0;
  const metres = km !== null ? parseFloat(km) * 1000 : parseFloat(m);
  const got = ingest(metres, q.get("d"));
  q.delete("km"); q.delete("m"); q.delete("d");
  const rest = q.toString();
  history.replaceState({}, "", location.pathname + (rest ? "?"+rest : ""));
  return got;
}

global.AGW = {
  attach: fn => { getStore = fn; },
  fix, ingest, ingestFromUrl, settle,
  today: () => { const w = state(); return {m: Math.max(w.m, w.ext),
                                           tracked: w.m, external: w.ext}; },
  onGain: f => { onGain = f; },
  _consts: {MAX_WALK_MS, MIN_STEP_M, MAX_ACC_M, DAY_CAP_M},
};
})(typeof window !== "undefined" ? window : globalThis);

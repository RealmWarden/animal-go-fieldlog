/* ============================================================
   The classifier runtime and model, on the main thread.

   This started life as a Web Worker, which is where a 1.17 s inference belongs.
   It does not work: loadLiteRt() fetches its emscripten glue and evaluates it
   with importScripts(), which a MODULE worker forbids outright --
   "Module scripts don't support importScripts()" -- and the ESM-only bundle
   cannot be loaded into a CLASSIC worker at all. So the worker is a dead end
   until the runtime ships a worker-safe loader, and the model runs here.

   What that costs: JavaScript is blocked for the length of each inference. The
   camera preview is composited by the browser and keeps moving, but nothing
   else on the page can update or respond during it. scan.js pays for that by
   stopping the loop the moment an identification locks, so the Record button
   is fully responsive exactly when it is the thing you want to press.

   Found by running the deployed page rather than the test suite: the headless
   suite stubs the model, so it was green on a scanner that could not start.
   ============================================================ */
(function(global){
"use strict";

const RUNTIME_SOURCES = [
  { js: "./vendor/litert/index.js",                              wasm: "./vendor/litert/wasm/" },
  { js: "https://cdn.jsdelivr.net/npm/@litertjs/core@2.5.3/+esm", wasm: "https://cdn.jsdelivr.net/npm/@litertjs/core@2.5.3/wasm/" },
];

const SIDE = 299;

let L = null;          // the LiteRT module
let model = null;
let softmaxNeeded = null;   // determined from the first real output

let onStage = () => {};
const say = (m) => { if (m.t === "stage") onStage(m.s, m.note); };

async function loadRuntime(){
  let lastErr = null;
  for (const src of RUNTIME_SOURCES){
    try{
      const mod = await import(src.js);
      await mod.loadLiteRt(src.wasm);
      say({t:"stage", s:"runtime", note: src.js.startsWith("http") ? "cdn" : "local"});
      return mod;
    }catch(e){ lastErr = e; }
  }
  throw lastErr || new Error("no runtime");
}

async function loadModel(){
  const manifest = await fetch("model/model.json").then(r=>{
    if(!r.ok) throw new Error("model.json "+r.status); return r.json();
  });

  const parts = [];
  let got = 0;
  for (const p of manifest.parts){
    const buf = await fetch("model/"+p.file).then(r=>{
      if(!r.ok) throw new Error(p.file+" "+r.status); return r.arrayBuffer();
    });
    parts.push(new Uint8Array(buf));
    got++;
    say({t:"stage", s:"download", note:`${got}/${manifest.parts.length}`});
  }

  const total = parts.reduce((n,p)=>n+p.length,0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const p of parts){ joined.set(p, at); at += p.length; }

  // The checksum is cheap next to a 22 MB download and catches a truncated or
  // half-cached part, which otherwise shows up as a compile error with no clue
  // in it.
  if (manifest.sha256 && global.crypto?.subtle){
    try{
      const d = await crypto.subtle.digest("SHA-256", joined);
      const hex = [...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,"0")).join("");
      if (hex !== manifest.sha256) throw new Error("checksum mismatch");
      say({t:"stage", s:"verify", note:"ok"});
    }catch(e){
      if (String(e.message).includes("checksum")) throw e;   // real corruption
      // digest unavailable (non-secure context): not worth failing over
    }
  }

  model = await L.loadAndCompile(joined, {accelerator:"wasm"});
  say({t:"stage", s:"compile", note:"ok"});
}

/* Unwrap whatever loadAndCompile's model.run() hands back.

   This is the part that had to be learned from the runtime rather than its
   docs, and getting it wrong does not look like an error: run() may return a
   promise, the result may be an array or an object keyed by output name, and
   toTypedArray() is ASYNC. A synchronous read of it yields a zero-length array,
   which the rollup then reports as "nothing recognised" -- a broken pipeline
   that looks exactly like a model too weak to identify anything. */
async function toProbs(out){
  let r = out;
  if (r && r.then) r = await r;
  let f = Array.isArray(r) ? r[0] : (r && typeof r === "object" && !(r instanceof Float32Array)
            ? r[Object.keys(r)[0]] : r);
  let arr = f;
  if (arr && typeof arr.toTypedArray === "function") arr = await arr.toTypedArray();
  else if (arr && arr.data) arr = arr.data;
  if (!(arr instanceof Float32Array)) arr = Float32Array.from(arr || []);
  if (!arr.length) throw new Error("model returned an empty output");

  // The published iNat model already ends in softmax, but "already normalised"
  // is an assumption worth one cheap check rather than a silent 1/507 readout
  // if a future export drops the activation.
  if (softmaxNeeded === null){
    let s = 0; for (let i=0;i<arr.length;i++) s += arr[i];
    softmaxNeeded = !(s > 0.9 && s < 1.1);
    say({t:"stage", s:"outputs", note:`len ${arr.length}, sum ${s.toFixed(3)}${softmaxNeeded?" (softmaxing)":""}`});
  }
  if (softmaxNeeded){
    let mx = -Infinity;
    for (let i=0;i<arr.length;i++) if (arr[i] > mx) mx = arr[i];
    let s = 0;
    const o = new Float32Array(arr.length);
    for (let i=0;i<arr.length;i++){ o[i] = Math.exp(arr[i]-mx); s += o[i]; }
    for (let i=0;i<o.length;i++) o[i] /= s;
    arr = o;
  }
  return arr;
}

let ready = false;

async function init(stageCb){
  onStage = stageCb || (()=>{});
  L = await loadRuntime();
  await loadModel();
  ready = true;
}

/* One inference. Rejects rather than returning junk, because an empty output
   reads downstream as "nothing recognised" — a broken pipeline wearing the
   costume of a weak model. */
async function run(pixels){
  if (!ready) throw new Error("engine not ready");
  const t0 = performance.now();
  const input = L.Tensor.fromTypedArray(pixels, [1, SIDE, SIDE, 3]);
  let probs;
  try{ probs = await toProbs(model.run([input])); }
  finally{ try{ input.delete?.(); }catch(_){} }
  return {probs: new Float32Array(probs), ms: Math.round(performance.now()-t0)};
}

global.AGE = {init, run, get ready(){ return ready; }};
})(typeof window !== "undefined" ? window : globalThis);

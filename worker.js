/* ============================================================
   Inference worker.

   The model takes ~1.17 s per frame on the target device (iPhone, iOS 18.7,
   LiteRT wasm backend — measured, see bench.html). Run that on the main thread
   and the camera preview freezes for a second at a time, which makes the whole
   hold-the-camera interaction feel broken. So the model lives here and the main
   thread does nothing but grab frames and paint.

   The runtime is loaded from a vendored copy if one exists and from jsdelivr
   otherwise. The service worker caches the CDN response, so the CDN path still
   works offline after the first successful launch — vendoring is a hardening
   step, not a requirement.
   ============================================================ */

const RUNTIME_SOURCES = [
  { js: "./vendor/litert/index.js",                              wasm: "./vendor/litert/wasm/" },
  { js: "https://cdn.jsdelivr.net/npm/@litertjs/core@2.5.3/+esm", wasm: "https://cdn.jsdelivr.net/npm/@litertjs/core@2.5.3/wasm/" },
];

const SIDE = 299;
const FRAME_LEN = SIDE * SIDE * 3;

let L = null;          // the LiteRT module
let model = null;
let softmaxNeeded = null;   // determined from the first real output
let busy = false;

const say = (m) => self.postMessage(m);

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
  if (manifest.sha256 && self.crypto?.subtle){
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

function toProbs(out){
  // LiteRT hands back an array of output tensors; shapes vary by wrapper version.
  let v = out;
  while (v && typeof v.length === "number" && v.length === 1 && !(v instanceof Float32Array)) v = v[0];
  if (v && typeof v.toTypedArray === "function") v = v.toTypedArray();
  else if (v && v.data) v = v.data;
  let arr = v instanceof Float32Array ? v : Float32Array.from(v);

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

self.onmessage = async (e) => {
  const msg = e.data;

  if (msg.t === "init"){
    try{
      L = await loadRuntime();
      await loadModel();
      say({t:"ready"});
    }catch(err){
      say({t:"fail", why: String(err && err.message || err)});
    }
    return;
  }

  if (msg.t === "frame"){
    // Drop frames rather than queue them: a queued frame is a stale frame, and a
    // backlog would make the readout describe what the camera saw seconds ago.
    if (!model || busy){ say({t:"dropped", seq: msg.seq}); return; }
    busy = true;
    const t0 = performance.now();
    try{
      const input = L.Tensor.fromTypedArray(msg.pixels, [1, SIDE, SIDE, 3]);
      const out = model.run([input]);
      const probs = toProbs(out);
      const copy = new Float32Array(probs);         // detach from runtime memory
      try{ input.delete?.(); }catch(_){}
      say({t:"probs", seq: msg.seq, ms: Math.round(performance.now()-t0), probs: copy}, [copy.buffer]);
    }catch(err){
      say({t:"fail", why: String(err && err.message || err), seq: msg.seq});
    }finally{ busy = false; }
  }
};

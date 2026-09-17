/* ============================================================
   The camera scanner.

   Replaces the species dropdown, which was the prototype's worst idea: a list
   of 296 latin binomials is not something anyone will scroll through for fun.
   Design doc s3.4 also had an "observe longer" button that re-rolled the
   identification. That button is gone too, and for a better reason than
   clunkiness — it was simulating a camera instead of waiting for one. Holding
   the phone on the animal IS the observation. Evidence accumulates while you
   hold, the readout climbs the taxonomy as it narrows, and the record button
   unlocks when it reaches a species.

   Three things happen per frame:
     1. centre-crop the video to square, scale to 299x299, raw 0-255 RGB
     2. the worker returns 507 probabilities
     3. those are rolled up the taxonomy and the deepest confident node wins

   The reference photo appears the moment there is a name to show, which is the
   point of the whole screen: you learn what you found from where you are
   standing, without creeping closer.
   ============================================================ */

const SIDE = 299;

/* Frame-to-frame smoothing. A single 299x299 crop of a moving insect is a noisy
   observation, so the decision runs on an exponential mean rather than the last
   frame. DECAY 0.55 keeps roughly the last three frames (~3.5 s of hold) — long
   enough to steady the readout, short enough that panning to a different animal
   flushes the old one within a couple of seconds. */
const DECAY = 0.55;

/* A species has to hold for this many consecutive frames before the record
   button unlocks. At ~1.17 s/frame that is about 3.5 s of steady aim, which is
   what "point the camera at it until it identifies it" should feel like. */
const LOCK_FRAMES = 3;

/* If the model can only reach genus, it will keep only reaching genus — more
   holding will not fix an animal the classifier cannot split. After this many
   frames stuck at genus or family, offer the coarse record rather than letting
   the encounter end in nothing. */
const STUCK_FRAMES = 8;

const S = {
  worker: null, stream: null, video: null, canvas: null, ctx: null,
  running: false, seq: 0, inflight: false,
  acc: null,                 // accumulated probability vector
  frames: 0, lastMs: 0,
  best: null,                // {name, rank, p, tpl}
  lockCount: 0, coarseCount: 0, locked: null,
  ladder: [], status: "idle", fail: null,
};

/* --- camera --------------------------------------------------------------- */
async function startCamera(){
  S.canvas = document.createElement("canvas");
  S.canvas.width = S.canvas.height = SIDE;
  S.ctx = S.canvas.getContext("2d", {willReadFrequently:true});
  S.video = document.getElementById("cam");

  try{
    S.stream = await navigator.mediaDevices.getUserMedia({
      video: {facingMode:{ideal:"environment"}, width:{ideal:1280}, height:{ideal:720}},
      audio: false,
    });
  }catch(e){
    S.fail = e && e.name === "NotAllowedError"
      ? "Camera permission was denied. You can still record by picking a species below."
      : "No camera available on this device. Use the species picker below.";
    paintFail();
    return false;
  }
  S.video.srcObject = S.stream;
  // iOS needs both of these set as attributes or it opens a fullscreen player.
  S.video.setAttribute("playsinline","");
  S.video.muted = true;
  await S.video.play().catch(()=>{});
  // Show the viewfinder the moment the camera is live, not when the model has
  // finished loading. The model is 22 MB on first run; hiding the camera behind
  // a dark panel for that long reads as a broken app, and the status line under
  // it already says what is still loading.
  el("camwrap").dataset.state = "live";
  return true;
}

function stopCamera(){
  S.running = false;
  if (S.stream){ S.stream.getTracks().forEach(t=>t.stop()); S.stream = null; }
  if (S.video) S.video.srcObject = null;
}

/* Centre-crop to square BEFORE scaling. Drawing a 1280x720 frame straight into
   a 299x299 canvas squashes it by 1.8x horizontally, and the classifier was
   trained on undistorted crops — a stretched bee is a different animal to it. */
function grabFrame(){
  const v = S.video;
  const w = v.videoWidth, h = v.videoHeight;
  if (!w || !h) return null;
  const s = Math.min(w,h);
  S.ctx.drawImage(v, (w-s)/2, (h-s)/2, s, s, 0, 0, SIDE, SIDE);
  const d = S.ctx.getImageData(0,0,SIDE,SIDE).data;
  const out = new Float32Array(SIDE*SIDE*3);
  // Raw 0-255, RGB, no mean subtraction and no /127.5-1. Verified against the
  // real model: the Xception-style rescale returns near-uniform garbage, raw
  // bytes return sane predictions. Worth stating loudly because the wrong one
  // looks like a weak model rather than a broken pipeline.
  for (let i=0, j=0; i<d.length; i+=4){
    out[j++] = d[i]; out[j++] = d[i+1]; out[j++] = d[i+2];
  }
  return out;
}

/* --- the loop ------------------------------------------------------------- */
function pump(){
  if (!S.running) return;
  if (!S.inflight){
    const px = grabFrame();
    if (px){
      S.inflight = true;
      const seq = ++S.seq;
      S.worker.postMessage({t:"frame", seq, pixels:px}, [px.buffer]);
    }
  }
  requestAnimationFrame(pump);
}

function onProbs(probs, ms){
  S.inflight = false;
  S.lastMs = ms;
  S.frames++;

  if (!S.acc) S.acc = new Float32Array(probs.length);
  for (let i=0;i<probs.length;i++) S.acc[i] = S.acc[i]*DECAY + probs[i]*(1-DECAY);

  // Bias correction. An exponential mean that starts from zero reads 45% low on
  // its first frame and is still 3% low on its fifth, so without this the first
  // second of every scan reports less confidence than the model actually has --
  // and a clear, unambiguous animal takes an extra frame or two to lock for no
  // reason but arithmetic. Dividing by the accumulated weight (1 - d^n) makes
  // frame one read exactly what the model said. Same trick Adam uses.
  const corr = 1 / (1 - Math.pow(DECAY, S.frames));
  const view = new Float32Array(S.acc.length);
  for (let i=0;i<view.length;i++) view[i] = S.acc[i]*corr;

  const r = AGR.rollup(view);

  // Lock tracking. The same species has to come back several frames running —
  // one lucky frame is not an identification.
  const name = r.pick && r.pick.rank === "species" ? r.pick.name : null;
  if (name && S.best && S.best.rank === "species" && S.best.name === name) S.lockCount++;
  else S.lockCount = name ? 1 : 0;

  if (r.pick && r.pick.rank !== "species") S.coarseCount++;
  else if (!r.pick) S.coarseCount = 0;

  S.best = r.pick ? {...r.pick, tpl: TX[r.pick.name]} : null;
  S.locked = (S.lockCount >= LOCK_FRAMES && S.best && TX[S.best.name]) ? S.best : null;

  // Three rungs, never more, and never wrapped. The first version showed class,
  // family, genus and species, which on a phone wrapped to two rows and put
  // "Honey Bees, Bumble Bees, and Allies" across the viewfinder. The family is
  // only interesting while the genus is still unknown, so it takes the middle
  // slot only then.
  S.ladder = [];
  if (r.cl) S.ladder.push({t:"class", name:r.cl.name, p:r.cl.p});
  const mid = r.ge || r.fa;
  if (mid) S.ladder.push({t: r.ge ? "genus" : "family", name:mid.name, p:mid.p});
  if (r.sp) S.ladder.push({t:"species", name:r.sp.name, p:r.sp.p});
  S.roll = r;

  paint();
}

/* --- painting ------------------------------------------------------------- */
function el(id){ return document.getElementById(id); }

function paintFail(){
  el("camwrap").dataset.state = "fail";
  // The reason goes where the viewfinder was, not into the status line under it.
  // In the fail state the status line is below the fold on a phone, which is how
  // a denied camera looked like an app that had simply hung.
  el("camboot").textContent = S.fail || "";
  el("scanmsg").textContent = "Scanning is unavailable — use the list below.";
  el("pickerfall").hidden = false;
  el("togglepicker").textContent = "Hide the species list";
  const b = el("snap"); b.disabled = true; b.hidden = true;
}

function paint(){
  const r = S.roll, b = S.best;
  const msg = el("scanmsg"), led = el("ladder"), card = el("idcard"), btn = el("snap");

  // Ladder: the climb, shown as it happens. Insect -> bees -> Bombus -> species.
  led.innerHTML = S.ladder.map(s => {
    const on = b && s.t === b.rank && s.name === b.name;
    return `<span class="rung${on?" on":""}" data-r="${s.t}"><i>${AGR.niceName(s.name)}</i>`+
           `<b>${Math.round(s.p*100)}%</b></span>`;
  }).join("");

  if (r && r.notAnimal && (!b || r.notAnimal.p > 0.6)){
    msg.textContent = `That looks like a ${AGR.niceName(r.notAnimal.name)}, not an animal.`;
    card.innerHTML = ""; btn.disabled = true; btn.textContent = "Record";
    el("coarse").hidden = true;
    return;
  }

  if (!b){
    // Below the bar is not the same as blank. Measured against real photographs,
    // the near misses were all cases where the RIGHT species led at 45-53% —
    // a honey bee at 47%, a fence lizard at 53%. Reporting those as "nothing
    // recognised" is both discouraging and untrue, and it hides the one piece of
    // information that tells you to keep holding rather than give up. So the
    // leader is shown, dimmed, and explicitly not recordable.
    const lead = r && (r.sp && r.sp.p >= 0.20 ? r.sp : (r.ge && r.ge.p >= 0.25 ? r.ge : null));
    if (lead){
      const nm = AGR.niceName(lead.name);
      msg.textContent = `Leaning ${nm} — not sure enough yet. Keep holding.`;
      ensureImage(lead.name, ()=>{ if (!S.best) paint(); });
      card.innerHTML = `
        <div class="idshot">${imgMarkup(lead.name,"idimg")}</div>
        <div class="idtext">
          <div class="idsci">${lead.name}</div>
          <div class="idcommon">${nm !== lead.name ? nm : ""}</div>
          <div class="idbar"><i style="width:${Math.round(lead.p*100)}%"></i></div>
          <div class="idmeta">possible · ${Math.round(lead.p*100)}% — below the threshold to record</div>
        </div>`;
      card.dataset.state = "maybe";
    } else {
      msg.textContent = S.frames < 2 ? "Looking…" : "Keep it in frame — nothing recognised yet.";
      card.innerHTML = ""; card.removeAttribute("data-state");
    }
    btn.disabled = true; btn.textContent = "Record";
    el("coarse").hidden = true;
    return;
  }
  card.removeAttribute("data-state");

  const tpl = TX[b.name];
  const sci = b.rank === "genus" ? b.name + " sp." : b.name;
  const common = AGR.niceName(b.name);

  // The picture. This is the part that answers "what did I just find" from ten
  // feet away; everything else on screen is supporting detail.
  ensureImage(b.name, ()=>{ if (S.best && S.best.name === b.name) paint(); });

  card.innerHTML = `
    <div class="idshot">${imgMarkup(b.name,"idimg")}</div>
    <div class="idtext">
      <div class="idsci">${sci}</div>
      <div class="idcommon">${common !== sci ? common : ""}</div>
      <div class="idbar"><i style="width:${Math.min(100,Math.round(b.p*100))}%"></i></div>
      <div class="idmeta">${b.rank} · ${Math.round(b.p*100)}% confident</div>
    </div>`;

  if (S.locked){
    msg.textContent = "Identified. Record it.";
    btn.disabled = false;
    btn.textContent = `Record ${AGR.niceName(S.locked.name)}`;
    el("coarse").hidden = true;
  } else if (b.rank === "species"){
    msg.textContent = `Hold steady — confirming (${S.lockCount}/${LOCK_FRAMES})`;
    btn.disabled = true; btn.textContent = "Record";
    el("coarse").hidden = true;
  } else {
    msg.textContent = "Narrowing it down — hold the animal in frame.";
    btn.disabled = true; btn.textContent = "Record";
    // Stuck at genus is usually the honest answer, not impatience: the model
    // cannot split some genera at all. Offering the coarse record beats ending
    // the encounter with nothing, but it stays quiet and secondary.
    const stuck = S.coarseCount >= STUCK_FRAMES;
    el("coarse").hidden = !stuck;
    if (stuck) el("coarsebtn").textContent = `Record as ${sci} — not identified to species`;
  }
}

/* --- recording ------------------------------------------------------------ */
async function recordFrom(pick){
  const tpl = TX[pick.name];
  if (!tpl) return;
  const before = new Set(store.records.filter(r=>r.dex).map(r=>r.sn));
  const prevMax = Math.max(0, ...store.records.filter(r=>r.sn===tpl.n).map(r=>r.mass));

  const rec = makeCapture(tpl, {
    status, place: el("place").value.trim(),
    lat: lastCoords?.[0] ?? null, lon: lastCoords?.[1] ?? null,
    conf: Math.round(Math.min(0.99, pick.p)*100)/100,
    cands: tpl.r === "species" ? [] : (tpl.mem||[]).slice(0,6),
    trueSp: tpl.r === "species" ? tpl.n : "",
  });
  rec.byCamera = true;
  store.records.push(rec);
  await persist();

  const out = el("result"); out.innerHTML = "";
  out.appendChild(renderSpecimen(rec, {
    isNewDex: rec.dex && !before.has(rec.sn),
    isBest: rec.rank === "species" && rec.mass > prevMax &&
            store.records.filter(r=>r.sn===tpl.n).length > 1,
  }));
  renderAll();

  // A recorded animal should not instantly re-identify itself from the same
  // accumulated evidence, or one bee becomes six records while you lower the
  // phone. Clearing the accumulator restarts the observation.
  S.acc = null; S.frames = 0; S.lockCount = 0; S.coarseCount = 0;
  S.best = null; S.locked = null; S.ladder = []; S.roll = null;
  paint();
  out.scrollIntoView({behavior:"smooth", block:"nearest"});
}

/* --- boot ---------------------------------------------------------------- */
function stage(s, note){
  const m = el("scanmsg");
  const label = {runtime:"Loading the classifier runtime", download:"Downloading the model",
                 verify:"Verifying the model", compile:"Preparing the model",
                 outputs:""}[s];
  if (label) m.textContent = label + (note ? ` — ${note}` : "") + "…";
}

async function initScanner(){
  AGR.build(TAXONOMY);

  const ok = await startCamera();

  S.worker = new Worker("worker.js", {type:"module"});
  S.worker.onmessage = (e)=>{
    const m = e.data;
    if (m.t === "stage")   return stage(m.s, m.note);
    if (m.t === "ready"){
      if (ok){ S.running = true; requestAnimationFrame(pump); }
      else { S.fail = S.fail || "No camera."; paintFail(); }
      return;
    }
    if (m.t === "probs")   return onProbs(m.probs, m.ms);
    if (m.t === "dropped"){ S.inflight = false; return; }
    if (m.t === "fail"){
      S.inflight = false;
      S.fail = "The classifier couldn't start (" + m.why + "). You can still record by picking a species.";
      paintFail();
      return;
    }
  };
  S.worker.postMessage({t:"init"});

  el("snap").addEventListener("click", ()=>{ if (S.locked) recordFrom(S.locked); });
  el("coarsebtn").addEventListener("click", ()=>{ if (S.best) recordFrom(S.best); });
  el("togglepicker").addEventListener("click", ()=>{
    const p = el("pickerfall");
    p.hidden = !p.hidden;
    el("togglepicker").textContent = p.hidden ? "Can't scan it? Pick from the list"
                                              : "Hide the species list";
  });

  document.addEventListener("visibilitychange", ()=>{
    // Holding a camera stream open in the background drains the battery and iOS
    // may kill the tab for it.
    if (document.hidden) S.running = false;
    else if (S.stream && !S.fail){ S.running = true; requestAnimationFrame(pump); }
  });
}

window.__scan = S;   // for the test harness

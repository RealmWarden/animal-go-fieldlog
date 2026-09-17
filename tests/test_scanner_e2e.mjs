/* End-to-end test of the camera scanner, with the model stubbed.

   The real classifier cannot run in this container (the runtime is only
   reachable from the CDN, which this sandbox cannot fetch), so the worker is
   replaced by a stub that replays scripted probability vectors. That stub is
   only the 22 MB of matrix multiplication -- everything the test exercises is
   real: the live camera element, the centre-crop, the frame pump, the rollup,
   the ladder, the reference photo, the lock, and the record that comes out.

   What this CANNOT check is whether the model is any good at recognising a
   real bee. That needs the real runtime on real hardware, which is what
   scan-test.html is for.                                                     */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
// Playwright may be installed globally rather than beside this file, which a
// bare `import "playwright"` will not find. Try the normal resolution first.
const require_ = createRequire(import.meta.url);
let chromium;
for (const where of ["playwright", "playwright-core",
                     "/home/claude/.npm-global/lib/node_modules/playwright/index.js"]){
  try{ ({chromium} = require_(where)); break; }catch(e){}
}
if (!chromium){ console.error("playwright not found — npm i -D playwright"); process.exit(2); }

const ROOT = path.resolve(import.meta.dirname, "..", "pwa");
const TAXONOMY = JSON.parse(fs.readFileSync(path.join(ROOT,"data/taxonomy.json"),"utf8"));
const IDX = TAXONOMY.classIndex;
const at = sn => IDX.findIndex(e => e && e.sn === sn);

const MIME = {".html":"text/html",".js":"text/javascript",".css":"text/css",
              ".json":"application/json",".png":"image/png"};

let pass=0, fail=0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok?"ok  ":"FAIL"}  ${label}`.padEnd(64) + (ok?"":`got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
};
const checkT = (label, cond) => check(label, !!cond, true);

/* --- static server -------------------------------------------------------- */
const server = http.createServer((req,res)=>{
  let f = decodeURIComponent(req.url.split("?")[0]);
  if (f === "/") f = "/index.html";
  const full = path.join(ROOT, f);
  if (!full.startsWith(ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()){
    res.writeHead(404); res.end("nope"); return;
  }
  res.writeHead(200, {"content-type": MIME[path.extname(full)] || "application/octet-stream"});
  fs.createReadStream(full).pipe(res);
});
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

/* --- the stub engine -----------------------------------------------------
   Replaces engine.js, which is the 22 MB of matrix multiplication and the only
   part of the path that cannot run in this container. Everything else is the
   shipped code. Each SCRIPT entry is {sn: [index, prob]} and is replayed for
   one frame, paced to loosely mimic the real 1.17 s inference so intermediate
   states are observable rather than a blur.                                 */
function stubEngine(script){
  return `
window.AGE = (function(){
  const N = ${IDX.length};
  const SCRIPT = ${JSON.stringify(script)};
  let i = 0, ready = false;
  return {
    init: async (stage)=>{ if(stage) stage("runtime","stub"); ready = true; },
    run: async ()=>{
      await new Promise(r=>setTimeout(r,140));
      const spec = SCRIPT[Math.min(i, SCRIPT.length-1)]; i++;
      const p = new Float32Array(N);
      let used = 0;
      for (const k in spec){ p[spec[k][0]] = spec[k][1]; used += spec[k][1]; }
      const rest = Math.max(0, 1-used)/N;          // sum to 1, as a softmax does
      for (let j=0;j<N;j++) p[j] += rest;
      return {probs:p, ms:1170};
    },
    get ready(){ return ready; },
  };
})();`;
}
const enc = spec => Object.fromEntries(Object.entries(spec).map(([sn,p])=>[sn,[at(sn),p]]));

async function session(script, {photos=true}={}){
  const browser = await chromium.launch({args:[
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--no-sandbox",
  ]});
  const ctx = await browser.newContext({
    viewport:{width:390,height:844}, permissions:["camera","geolocation"],
  });
  // Wikipedia is not reachable from here; answer the photo lookups with a
  // plausible payload so the image path is still exercised.
  await ctx.route("**/api/rest_v1/page/summary/**", route => {
    if (!photos) return route.fulfill({status:404, body:""});
    const title = decodeURIComponent(route.request().url().split("/").pop()).replace(/_/g," ");
    route.fulfill({status:200, contentType:"application/json", body: JSON.stringify({
      title, description:"stub", type:"standard",
      thumbnail:{source:`${base}/icons/icon-192.png`},
      content_urls:{desktop:{page:"https://en.wikipedia.org/wiki/"+title}},
    })});
  });
  await ctx.route("https://fonts.googleapis.com/**", r=>r.fulfill({status:200, contentType:"text/css", body:""}));
  await ctx.route("https://fonts.gstatic.com/**", r=>r.abort());
  await ctx.route("**/engine.js", route => route.fulfill({
    status:200, contentType:"text/javascript", body: stubEngine(script),
  }));
  // The service worker would cache the stub and confuse later runs.
  await ctx.addInitScript(()=>{ try{ Object.defineProperty(navigator,"serviceWorker",{get:()=>undefined}); }catch(e){} });

  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e.message)));
  page.on("console", m => { if (m.type()==="error") errors.push(m.text()); });
  await page.goto(base + "/index.html");
  await page.waitForSelector("#app:not([hidden])", {timeout:20000});
  await page.click("#introSkip").catch(()=>{});
  return {browser, page, errors};
}

const waitFrames = (page, n) => page.waitForFunction(
  k => window.__scan && window.__scan.frames >= k, n, {timeout:30000});

/* Snapshot the UI at an exact frame count. Reading it with a separate evaluate()
   races the next frame, which made an earlier version of this test flaky in a
   way that had nothing to do with the app. */
const snapAt = (page, n, fn) => page.waitForFunction(
  ([k, src]) => window.__scan.frames !== k ? false : (0, eval)("(" + src + ")")(),
  [n, fn.toString()], {timeout:30000}).then(h => h.jsonValue());

/* ======================================================================= */
console.log("\n1. Camera starts, the loop runs, and a confident species locks");
{
  const {browser, page, errors} = await session([enc({"Bombus vosnesenskii":0.85})]);

  await page.waitForFunction(()=>document.getElementById("camwrap").dataset.state==="live",
                             null, {timeout:15000});
  checkT("the viewfinder goes live before the model has loaded",
         await page.getAttribute("#camwrap","data-state") === "live");
  const dims = await page.evaluate(()=>({w:document.getElementById("cam").videoWidth,
                                         h:document.getElementById("cam").videoHeight}));
  checkT("video has real dimensions", dims.w > 0 && dims.h > 0);

  const first = await snapAt(page, 1, ()=>({msg:document.getElementById("scanmsg").textContent,
                                            dis:document.getElementById("snap").disabled}));
  checkT("one frame is not enough to record", first.dis);
  checkT("it says it is confirming", /confirming/i.test(first.msg));

  await waitFrames(page, 3);
  await page.waitForFunction(()=>!document.getElementById("snap").disabled, null, {timeout:25000});
  const ui = await page.evaluate(()=>({
    btn: document.getElementById("snap").textContent.trim(),
    sci: document.querySelector(".idsci")?.textContent.trim(),
    meta: document.querySelector(".idmeta")?.textContent.trim(),
    rungs: [...document.querySelectorAll(".rung i")].map(r=>r.textContent.trim()),
    img: document.querySelector(".idimg")?.tagName,
  }));
  check("the card names the species", ui.sci, "Bombus vosnesenskii");
  checkT("the button names what it will record", /Bumble/i.test(ui.btn));
  checkT("the readout says species", /species/.test(ui.meta));
  checkT("a reference photo is shown", ui.img === "IMG");
  check("the ladder is exactly three rungs, on one row", ui.rungs.length, 3);
  check("the ladder starts at the class", ui.rungs[0], "insect");
  check("and ends at the species, named readably", ui.rungs[ui.rungs.length-1],
        "Yellow-faced Bumble Bee");

  // record it
  const nBefore = await page.evaluate(()=>store.records.length);   // 5 seeded examples
  await page.click("#snap");
  await page.waitForSelector("#result .specimen", {timeout:10000});
  const rec = await page.evaluate(()=>{
    const r = store.records[store.records.length-1];
    return {sn:r.sn, rank:r.rank, dex:r.dex, byCamera:!!r.byCamera, mass:r.mass, pct:r.pct};
  });
  check("the record is the identified species", rec.sn, "Bombus vosnesenskii");
  check("recorded at species rank", rec.rank, "species");
  check("it counts for the dex", rec.dex, true);
  check("it is marked as a camera record", rec.byCamera, true);
  checkT("it has a mass and a percentile", rec.mass > 0 && rec.pct >= 0 && rec.pct <= 100);

  const after = await page.evaluate(()=>({locked:!!window.__scan.locked,
                                          dis:document.getElementById("snap").disabled,
                                          n:store.records.length}));
  checkT("the button relocks so one animal is not recorded twice", after.dis && !after.locked);
  // And it has to be earned again from scratch, not handed back by the evidence
  // that was already on the pile.
  await page.waitForFunction(()=>!document.getElementById("snap").disabled, null, {timeout:30000});
  const again = await page.evaluate(()=>window.__scan.frames);
  checkT("a second record needs a fresh three frames", again >= 3);
  check("and exactly one record came out of that tap", after.n - nBefore, 1);

  check("no page errors", errors, []);
  await browser.close();
}

console.log("\n1b. The loop pauses on a lock, and the viewfinder restarts it");
{
  const {browser, page, errors} = await session([enc({"Bombus vosnesenskii":0.88})]);
  await page.waitForFunction(()=>!document.getElementById("snap").disabled, null, {timeout:30000});
  const paused = await page.evaluate(()=>({running:window.__scan.running,
                                           msg:document.getElementById("scanmsg").textContent}));
  checkT("scanning stops once it has an answer", paused.running === false);
  checkT("and says so, with the way back", /paused/.test(paused.msg) && /tap the view/i.test(paused.msg));
  const before = await page.evaluate(()=>window.__scan.frames);
  await page.click("#camwrap");
  await page.waitForFunction(()=>window.__scan.running === true, null, {timeout:10000});
  const restarted = await page.evaluate(()=>({frames:window.__scan.frames, locked:!!window.__scan.locked}));
  checkT("tapping the view starts over", restarted.frames === 0 && !restarted.locked);
  checkT("and it was actually scanning before", before >= 3);
  check("no page errors", errors, []);
  await browser.close();
}

console.log("\n2. A genus the model cannot split: no species record, coarse offered late");
{
  const amb = enc({"Bombus vosnesenskii":0.26,"Bombus impatiens":0.24,
                   "Bombus griseocollis":0.20,"Bombus bimaculatus":0.18});
  const {browser, page, errors} = await session([amb]);
  await waitFrames(page, 3);
  const mid = await page.evaluate(()=>({
    sci: document.querySelector(".idsci")?.textContent.trim(),
    dis: document.getElementById("snap").disabled,
    coarseHidden: document.getElementById("coarse").hidden,
    msg: document.getElementById("scanmsg").textContent,
  }));
  check("the card reads as a genus", mid.sci, "Bombus sp.");
  checkT("record stays locked at genus", mid.dis);
  checkT("no coarse escape hatch yet", mid.coarseHidden);
  checkT("it says it is narrowing", /narrowing/i.test(mid.msg));

  await waitFrames(page, 9);
  await page.waitForFunction(()=>!document.getElementById("coarse").hidden, null, {timeout:25000});
  const late = await page.evaluate(()=>({
    dis: document.getElementById("snap").disabled,
    label: document.getElementById("coarsebtn").textContent.trim(),
  }));
  checkT("the main record button is STILL locked", late.dis);
  checkT("the coarse option names the rank honestly", /not identified to species/.test(late.label));

  await page.click("#coarsebtn");
  await page.waitForSelector("#result .specimen", {timeout:10000});
  const rec = await page.evaluate(()=>{
    const r = store.records[store.records.length-1];
    return {sn:r.sn, rank:r.rank, dex:r.dex, cands:r.cands.length};
  });
  check("the coarse record is the genus", rec.sn, "Bombus");
  check("at genus rank", rec.rank, "genus");
  check("and does NOT fill a dex slot", rec.dex, false);
  checkT("it lists what it might be", rec.cands >= 2);
  check("no page errors", errors, []);
  await browser.close();
}

console.log("\n3. Pointed at a plant, it says so instead of guessing an animal");
{
  const {browser, page, errors} = await session([enc({"Acer platanoides":0.82})]);
  await waitFrames(page, 2);
  const ui = await page.evaluate(()=>({
    msg: document.getElementById("scanmsg").textContent,
    dis: document.getElementById("snap").disabled,
    card: document.getElementById("idcard").innerHTML.trim(),
  }));
  checkT("it names it as a plant", /flowering plant/.test(ui.msg));
  checkT("nothing can be recorded", ui.dis);
  check("no identification card", ui.card, "");
  check("no page errors", errors, []);
  await browser.close();
}

console.log("\n4. Panning from an ambiguous genus onto one clear species");
{
  const amb = enc({"Bombus vosnesenskii":0.26,"Bombus impatiens":0.24,"Bombus griseocollis":0.22});
  const clear = enc({"Bombus vosnesenskii":0.92});
  const {browser, page, errors} = await session([amb,amb,amb,clear,clear,clear,clear,clear,clear]);
  await waitFrames(page, 3);
  check("starts at the genus",
        await page.evaluate(()=>document.querySelector(".idsci")?.textContent.trim()), "Bombus sp.");
  await page.waitForFunction(()=>!document.getElementById("snap").disabled, null, {timeout:30000});
  const ui = await page.evaluate(()=>({
    sci: document.querySelector(".idsci")?.textContent.trim(),
    frames: window.__scan.frames,
  }));
  check("resolves to the species once the view improves", ui.sci, "Bombus vosnesenskii");
  checkT("and it took a few more frames, not one", ui.frames >= 5);
  check("no page errors", errors, []);
  await browser.close();
}

console.log("\n4b. A leading candidate below the bar is shown, dimmed, not recordable");
{
  // Measured near-misses from scan-test.html on real photographs: the right
  // species led at 45-53% and the old UI said "nothing recognised".
  const {browser, page, errors} = await session([enc({"Apis mellifera":0.47,"Halictus ligatus":0.10})]);
  await waitFrames(page, 2);
  const ui = await page.evaluate(()=>({
    state: document.getElementById("idcard").dataset.state,
    sci: document.querySelector(".idsci")?.textContent.trim(),
    meta: document.querySelector(".idmeta")?.textContent.trim(),
    msg: document.getElementById("scanmsg").textContent,
    dis: document.getElementById("snap").disabled,
  }));
  check("the card is marked provisional", ui.state, "maybe");
  check("it names the leader", ui.sci, "Apis mellifera");
  checkT("it says it is below the threshold", /below the threshold/.test(ui.meta));
  checkT("it tells you to keep holding", /keep holding/i.test(ui.msg));
  checkT("but nothing can be recorded", ui.dis);
  check("no page errors", errors, []);
  await browser.close();
}

console.log("\n5. The crop the classifier sees is square and undistorted");
{
  const {browser, page, errors} = await session([enc({"Bombus vosnesenskii":0.85})]);
  await waitFrames(page, 1);
  const g = await page.evaluate(()=>{
    const S = window.__scan;
    return {w:S.canvas.width, h:S.canvas.height,
            vw:S.video.videoWidth, vh:S.video.videoHeight};
  });
  check("the input canvas is 299x299", [g.w,g.h], [299,299]);
  checkT("the source frame is not square, so cropping matters", g.vw !== g.vh);
  check("no page errors", errors, []);
  await browser.close();
}

console.log("\n6. Camera denied: the app still works through the fallback list");
{
  const browser = await chromium.launch({args:["--no-sandbox"]});
  const ctx = await browser.newContext({viewport:{width:390,height:844}, permissions:[]});
  await ctx.route("https://fonts.googleapis.com/**", r=>r.fulfill({status:200, contentType:"text/css", body:""}));
  await ctx.route("https://fonts.gstatic.com/**", r=>r.abort());
  await ctx.route("**/engine.js", r=>r.fulfill({status:200, contentType:"text/javascript",
                                                body: stubEngine([enc({"Bombus vosnesenskii":0.85})])}));
  await ctx.addInitScript(()=>{
    try{ Object.defineProperty(navigator,"serviceWorker",{get:()=>undefined}); }catch(e){}
    navigator.mediaDevices.getUserMedia = () => Promise.reject(
      Object.assign(new Error("denied"), {name:"NotAllowedError"}));
  });
  const page = await ctx.newPage();
  const errors=[]; page.on("pageerror",e=>errors.push(String(e.message)));
  await page.goto(base+"/index.html");
  await page.waitForSelector("#app:not([hidden])",{timeout:20000});
  await page.click("#introSkip").catch(()=>{});
  await page.waitForFunction(()=>document.getElementById("camwrap").dataset.state==="fail",
                             null,{timeout:15000});
  const ui = await page.evaluate(()=>({
    msg: document.getElementById("camboot").textContent,
    pickerShown: !document.getElementById("pickerfall").hidden,
    options: document.getElementById("species").options.length,
  }));
  checkT("it explains the camera was refused, where the viewfinder was",
         /permission was denied/i.test(ui.msg));
  checkT("the fallback list is revealed automatically", ui.pickerShown);
  check("the list is fully populated", ui.options, 296);

  await page.selectOption("#species","Corvus brachyrhynchos");
  await page.click("#viewseg button[data-q=clear]");
  await page.click("#record");
  await page.waitForSelector("#result .specimen",{timeout:10000});
  checkT("a record can still be made", await page.evaluate(()=>store.records.length>0));
  check("no page errors", errors, []);
  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
server.close();
process.exit(fail ? 1 : 0);

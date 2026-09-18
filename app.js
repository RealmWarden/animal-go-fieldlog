/* ============================================================
   Species corpus (mirrors data/seed_traits.csv)
   ============================================================ */
let TAXONOMY;  // data/taxonomy.json
let SPECIES;   // data/species.json

/* ============================================================
   Stats: lookup, not formulas.
   Fixes design doc s11.7 — the allometry used to be reimplemented here and
   drifted from src/stats.py by construction. Python is now the only place the
   model exists; build_stat_grid.py samples it per taxon across the quantile
   range and this interpolates. Max deviation from the Python result: 1 point
   on a 1..100 scale, at a rounding boundary.
   ============================================================ */
let GRID;      // data/stat_grid.json

function gAt(arr,z){
  const f=(z-GRID.z0)/GRID.step;
  const i=Math.max(0,Math.min(GRID.n-2,Math.floor(f)));
  const w=f-i;
  return arr[i]*(1-w)+arr[i+1]*w;
}
function statsAt(taxonName,z){
  const g=GRID.g[taxonName];
  return {mass:Math.pow(10,gAt(g.lm,z)),
          hp:Math.round(gAt(g.hp,z)), atk:Math.round(gAt(g.atk,z)),
          spd:Math.round(gAt(g.spd,z)), dfn:Math.round(gAt(g.dfn,z)),
          ms:Math.round(gAt(g.ms,z)*100)/100,
          pct:Math.round(gAt(GRID.pct,z)*10)/10};
}

/* ============================================================
   Identification — port of src/identification.py
   ============================================================ */
const RANK_DEPTH={family:1,genus:2,species:3};
const VIEW_QUALITY={glimpse:0.18,partial:0.50,clear:0.85};
const FLUSH_CHANCE=0.30;
let TX, LINEAGE;

const speciesOdds=(base,n)=>base*Math.pow(0.72,Math.max(0,n-1));

// What this SPECIFIC record could weigh, given its fixed quantile and the species
// it might turn out to be. Better than the taxon's central band, because it is the
// range that actually collapses when the identification sharpens — the player is
// looking at their own uncertainty, not the genus's.
function candidateMassRange(rec){
  const t=TX[rec.sn];
  const masses=(t.mem||[]).filter(m=>GRID.g[m]).map(m=>statsAt(m,rec.z).mass);
  if(!masses.length){const s=statsAt(rec.sn,rec.z); return [s.mass,s.mass];}
  return [Math.min(...masses), Math.max(...masses)];
}
function simulateScan(sn, view){
  const base=VIEW_QUALITY[view]??0.5;
  const [spName,gName,famName]=LINEAGE[sn];
  const lin={species:TX[spName], genus:TX[gName], family:famName?TX[famName]:null};
  const pSpecies=speciesOdds(base, lin.genus.mem.length);
  const roll=Math.random();
  let rank;
  if(roll<pSpecies) rank="species";
  else if(roll<pSpecies+base*0.75) rank="genus";
  else if(roll<pSpecies+base*0.75+base*0.5) rank=lin.family?"family":"genus";
  else return {rank:null,tpl:null,conf:Math.round(base*40)/100};
  let tpl=lin[rank]||lin.genus;
  // A coarse hit with one candidate IS the species — 72% of the roster sits in a
  // singleton genus, so without this the dex is gated on ceremony.
  while(tpl.r!=="species" && tpl.mem.length===1) tpl=TX[tpl.mem[0]];
  const conf={species:0.80,genus:0.90,family:0.95}[tpl.r]*(0.6+0.4*base);
  return {rank:tpl.r, tpl, conf:Math.round(conf*100)/100,
          cands: tpl.r==="species"?[]:tpl.mem.slice(0,6)};
}
function observeAgain(currentRank, sn, attempts){
  let best=null, used=0;
  for(let i=0;i<attempts;i++){
    used++;
    const s=simulateScan(sn,"clear");
    if(s.rank && RANK_DEPTH[s.rank]>RANK_DEPTH[currentRank]){
      if(!best||RANK_DEPTH[s.rank]>RANK_DEPTH[best.rank]) best=s;
      if(s.rank==="species") break;
    }
    if(Math.random()<FLUSH_CHANCE) return {scan:best,left:true,used};
  }
  return {scan:best,left:false,used};
}

/* ============================================================
   Individual roll — port of src/individual.py
   ============================================================ */
const CLAMP=2.8;   // matches MASS_CLAMP_SIGMA in src/individual.py
const MASTERY=[[0,"Fledgling"],[500,"Seasoned"],[2000,"Veteran"],[6000,"Alpha"],[15000,"Apex"]];
const STAT_GROWTH=0.04, ABILITY_GROWTH=0.65, XP_PER_KM=100, SQUAD_MAX=6;

function hash32(str){let h=2166136261>>>0;for(let i=0;i<str.length;i++){h^=str.charCodeAt(i);h=Math.imul(h,16777619)>>>0}return h>>>0}
function mulberry(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
function gauss(rnd){let u=0,v=0;while(!u)u=rnd();while(!v)v=rnd();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v)}

function drawZ(uid){
  const rnd=mulberry(hash32(uid));
  return Math.max(-CLAMP,Math.min(CLAMP,gauss(rnd)));
}
function masteryFor(xp){let t=0,n=MASTERY[0][1];MASTERY.forEach(([th,l],i)=>{if(xp>=th){t=i;n=l}});return[t,n]}
function xpToNext(xp){for(const [th,l] of MASTERY){if(xp<th) return {need:th-xp, next:l};} return null;}
function sizeNote(p){return p>=95?"exceptional for its species":p>=75?"large for its species":
  p>=25?"typical for its species":p>=5?"small for its species":"a runt"}

function makeCapture(tpl,{status="wild",place="",lat=null,lon=null,when=null,uid=null,
                         conf=1,cands=[],trueSp=""}={}){
  when=when||new Date().toISOString();
  uid=uid||`${tpl.n}|${when}|${Math.random().toString(36).slice(2,10)}`;
  const z=drawZ(uid);
  const st=statsAt(tpl.n,z);
  const mass=st.mass, pct=st.pct;
  const captive=status==="captive";
  return {uid,sn:tpl.n,cn:tpl.c,cl:tpl.cl,mass:Math.round(mass*10000)/10000,pct,
    hp:st.hp,atk:st.atk,spd:st.spd,dfn:st.dfn,ms:st.ms,
    at:when,place,lat,lon,status,
    // s4 gates on ownership; identification rank gates the dex independently
    dex:!captive && tpl.r==="species", battle:!captive,
    rank:tpl.r, conf, cands:cands.slice(), z, trueSp:trueSp||(tpl.r==="species"?tpl.n:""),
    xp:0, ab:tpl.ab.slice(), te:tpl.te.slice(), squad:false};
}

function promote(rec, tpl){
  if(RANK_DEPTH[tpl.r]<=RANK_DEPTH[rec.rank]) return rec;
  const st=statsAt(tpl.n,rec.z);                  // SAME z — nothing is re-rolled
  const mass=st.mass, pct=st.pct;
  rec.sn=tpl.n; rec.cn=tpl.c; rec.rank=tpl.r;
  rec.mass=Math.round(mass*10000)/10000; rec.pct=pct;
  rec.hp=st.hp; rec.atk=st.atk; rec.spd=st.spd; rec.dfn=st.dfn; rec.ms=st.ms;
  rec.ab=tpl.ab.slice(); rec.te=tpl.te.slice();
  if(tpl.r==="species") rec.cands=[];
  rec.dex = rec.status!=="captive" && tpl.r==="species";
  return rec;
}

/* ============================================================
   Storage — localStorage, with explicit export/import.

   iOS can evict a PWA's storage after a few weeks of disuse, so the export
   button is not a nicety: it is the only durable backup. Every read and write
   is wrapped, because storage throws in private browsing.
   ============================================================ */
const LS="animalgo.v1";
let store={records:[],km:0,scans:[]};

function lsLoad(){
  try{ const r=localStorage.getItem(LS); if(r) store=JSON.parse(r); }catch(e){}
}
async function persist(){
  try{ localStorage.setItem(LS,JSON.stringify(store)); }
  catch(e){ toast("Couldn't save — device storage is full or blocked."); }
}
function exportJSON(){
  const blob=new Blob([JSON.stringify(store,null,2)],{type:"application/json"});
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download=`animal-go-${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
async function importJSON(file){
  try{
    const d=JSON.parse(await file.text());
    if(!Array.isArray(d.records)) throw new Error("not a field log export");
    store={records:d.records, km:d.km||0, scans:Array.isArray(d.scans)?d.scans:[]};
    await persist(); renderAll(); toast(`Imported ${d.records.length} records.`);
  }catch(e){ toast("That file isn't a field log export."); }
}
function toast(msg){
  const t=document.getElementById("toast");
  t.textContent=msg; t.hidden=false;
  clearTimeout(toast._t); toast._t=setTimeout(()=>{t.hidden=true},3200);
}

async function initStore(){
  lsLoad();
  if(!store.records.length) seedSamples();
}

function seedSamples(){
  const picks=[
    ["Corvus brachyrhynchos","species","wild","Ballona Wetlands, CA",1400],
    ["Sciurus carolinensis","species","wild","USC campus, Los Angeles",600],
    ["Danaus plexippus","species","wild","USC campus, Los Angeles",600],
    ["Bombus","genus","wild","Griffith Park, CA",0],
    ["Sceloporus occidentalis","species","wild","Malibu Creek SP, CA",0]];
  const now=Date.now();
  picks.forEach(([name,rank,status,place,xp],i)=>{
    const tpl=TX[name]; if(!tpl) return;
    const rec=makeCapture(tpl,{status,place,uid:`sample-${i}`,
      conf:rank==="species"?0.91:0.86,
      cands:rank==="species"?[]:tpl.mem.slice(0,6),
      trueSp:rank==="species"?name:"Bombus vosnesenskii",
      when:new Date(now-(5-i)*86400000).toISOString()});
    rec.xp=xp; rec.squad=xp>0; rec.sample=true;
    store.records.push(rec);
  });
  store.km=22.0;
}

/* ============================================================
   Reference images

   Knowing WHAT you just found is the point of the app, and a picture answers
   that better than a stat block. It also does two things the design needed
   anyway: it lets you confirm an animal from where you are standing rather than
   creeping closer (design doc s11.1), and it turns an unresolved genus record
   from a useless string — "Bombus sp., one of seven" — into seven photographs.

   Fetched from Wikipedia one species at a time, the first time you meet it, and
   remembered after. NEVER batched: a 296-species sweep gets HTTP 429 within
   seconds, while the natural one-at-a-time pattern never comes close.
   ============================================================ */
const IMG_KEY="animalgo.img.v1";
let IMGS={};
try{ IMGS=JSON.parse(localStorage.getItem(IMG_KEY)||"{}"); }catch(e){}
const imgPending=new Set();

function saveImgs(){ try{ localStorage.setItem(IMG_KEY,JSON.stringify(IMGS)); }catch(e){} }

// Use the thumbnail URL exactly as the API returns it. Rewriting the width in
// the path (330px -> 640px) looks like it should work and returns HTTP 400 from
// Wikimedia: only the width the API generated is served. Tested against the live
// API — the 330px URL returns 200, the rewritten 640px one returns 400.
function widen(u){ return u; }

async function wikiLookup(title){
  try{
    const r=await fetch("https://en.wikipedia.org/api/rest_v1/page/summary/"+
      encodeURIComponent(title.replace(/ /g,"_")),{headers:{Accept:"application/json"}});
    if(!r.ok) return null;                      // 404 = no page, 429 = slow down
    const d=await r.json();
    if(d.type==="disambiguation"||!d.thumbnail) return null;
    return {t:d.title, u:widen(d.thumbnail.source), d:d.description||"",
            p:(d.content_urls&&d.content_urls.desktop)?d.content_urls.desktop.page:""};
  }catch(e){ return null; }
}

// Resolve one taxon's picture. Species are looked up by binomial then common
// name; a genus or family record borrows its first member's picture, so a coarse
// record still shows you something.
async function ensureImage(name, onDone){
  if(IMGS[name]!==undefined || imgPending.has(name)) return;
  imgPending.add(name);
  const tx=TX[name];
  let hit=await wikiLookup(name);
  if(!hit && tx && tx.c && tx.c!==name && tx.r==="species") hit=await wikiLookup(tx.c);
  if(!hit && tx && tx.r!=="species" && tx.mem && tx.mem.length){
    const m=tx.mem[0];
    hit = IMGS[m] || await wikiLookup(m);
    if(hit) hit={...hit, borrowed:m};
  }
  IMGS[name]=hit||null;                          // null is a remembered miss
  imgPending.delete(name); saveImgs();
  if(onDone) onDone();
}

function capMarkup(name){
  const h=IMGS[name];
  if(!h) return "";
  const who = h.borrowed ? `${h.t} — photo of ${h.borrowed}` : h.t;
  return `<figcaption class="shotcap">${who} · <a href="${h.p}" target="_blank" rel="noopener">Wikipedia</a></figcaption>`;
}

function imgMarkup(name, cls){
  const h=IMGS[name];
  // A photo can fail even once resolved — offline on first sight, or a URL that
  // has moved. Degrade to the same neutral block as a known miss rather than
  // leaving the browser's broken-image icon and alt text on the card.
  const fail = "this.onerror=null;this.removeAttribute('src');this.classList.add('noimg');";
  const alt = cls === "shot" ? (h ? h.t : "") : "";   // small thumbs are decorative
  if(h) return `<img class="${cls}" src="${h.u}" alt="${alt}" loading="lazy" onerror="${fail}">`;
  if(IMGS[name]===null) return `<div class="${cls} noimg" aria-hidden="true"></div>`;
  return `<div class="${cls} loadimg" aria-hidden="true"></div>`;
}

/* ============================================================
   First-run walkthrough

   Design doc s9a listed "a tutorial is still needed" as an open task. It stopped
   being theoretical the first time someone opened this on a phone and could not
   tell what it wanted from them. Four cards, skippable, reopenable from the ?
   button — plus permanent one-line hints under each control, because a
   walkthrough you saw once is not documentation.
   ============================================================ */
const INTRO_KEY="animalgo.introSeen";
const INTRO=[
 {t:"Point your camera at an animal",
  b:"Hold it in frame. The classifier runs on your phone, several times a second, and narrows down what it is as it watches — <b>insect → bees → Bombus → the species</b>. Nothing is uploaded anywhere."},
 {t:"Hold until it names a species",
  b:"The readout climbs while you hold steady. <b>Record</b> unlocks once it settles on one species for a few frames running. If it can only reach a genus, it will say so — some genera the model genuinely cannot split."},
 {t:"You get that one individual",
  b:"Recording gives you that specific animal: its weight, how big it is for its species, and its stats. Record the same species twice and you get two different animals. The picture is from Wikipedia, so you can see what you found without getting closer."},
 {t:"Your collection",
  b:"<b>Collection</b> lists everything you've recorded — star up to six as your active squad, and only those gain experience when you walk. <b>Dex</b> tracks how many of the 296 species you've found. The records already in there are examples; Clear all removes them."},
];
let introAt=0;

function showIntro(from=0){
  introAt=from;
  paintIntro();
  document.getElementById("intro").hidden=false;
}
function paintIntro(){
  const s=INTRO[introAt];
  document.getElementById("introStep").textContent=`${introAt+1} of ${INTRO.length}`;
  document.getElementById("introTitle").textContent=s.t;
  document.getElementById("introBody").innerHTML=s.b;
  document.getElementById("introNext").textContent =
    introAt===INTRO.length-1 ? "Start recording" : "Next";
  document.getElementById("introSkip").hidden = introAt===INTRO.length-1;
}
function closeIntro(){
  document.getElementById("intro").hidden=true;
  try{ localStorage.setItem(INTRO_KEY,"1"); }catch(e){}
}
function wireIntro(){
  document.getElementById("introNext").addEventListener("click",()=>{
    if(introAt<INTRO.length-1){ introAt++; paintIntro(); } else closeIntro();
  });
  document.getElementById("introSkip").addEventListener("click",closeIntro);
  document.getElementById("help").addEventListener("click",()=>showIntro(0));
}
function maybeShowIntro(){
  let seen=false;
  try{ seen = localStorage.getItem(INTRO_KEY)==="1"; }catch(e){}
  if(!seen) showIntro(0);
}

/* ============================================================
   UI
   ============================================================ */
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
let byName;
let status="wild", viewQuality="partial", lastCoords=null;

// Display names come from the live taxonomy rather than the stored record, so a
// record captured before higher-taxon common names existed still reads well.
function displayName(rec){
  const t = TX[rec.sn];
  const sci = rec.rank === "genus" ? rec.sn + " sp." : rec.sn;
  return {sci, common: (t && t.c) || rec.cn || ""};
}

function fmtMass(g){
  if(g>=1000) return (g/1000).toFixed(g>=10000?0:2)+" kg";
  if(g>=1)    return g.toFixed(g>=100?0:1)+" g";
  if(g>=0.01) return g.toFixed(3)+" g";
  return (g*1000).toFixed(2)+" mg";
}
const fmtDate=iso=>new Date(iso).toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"});

/* --- species picker --- */
// A walkthrough you saw once isn't documentation — these stay on the controls.
function addHints(){
  const put=(sel,text)=>{
    const el=document.querySelector(sel); if(!el) return;
    const p=document.createElement("p"); p.className="hint"; p.textContent=text;
    el.insertAdjacentElement("afterend",p);
  };
  put("#viewseg","Only used by the fallback list. A worse view means a vaguer identification.");
  put("#placechip","Filled in from your phone's location. Tap Change to correct it.");
  put(".seg[role=group]:not(#viewseg)","Pets and zoo animals are collected but don't count toward the dex.");
}

function fillPicker(){
  const sel=$("#species");
  [...SPECIES].sort((a,b)=>a.cn.localeCompare(b.cn)).forEach(s=>{
    const o=document.createElement("option");
    o.value=s.sn; o.textContent=`${s.cn} — ${s.sn}`;
    sel.appendChild(o);
  });
  const cl=$("#f-clade");
  [...new Set(SPECIES.map(s=>s.cl))].sort().forEach(c=>{
    const o=document.createElement("option"); o.value=c;
    o.textContent=c[0].toUpperCase()+c.slice(1)+"s"; cl.appendChild(o);
  });
}

/* --- locality ---
   One place the rest of the app asks "where am I", so the camera path and the
   fallback list cannot disagree. A manual entry always wins: a GPS fix under
   tree cover is a guess, and the person standing there is not. */
function placeNow(){
  const manual = $("#placemanual").hidden ? "" : $("#place").value.trim();
  const f = window.AGP ? AGP.current() : null;
  const auto = f ? (f.name || `${f.lat.toFixed(4)}, ${f.lon.toFixed(4)}`) : "";
  return {place: manual || auto,
          lat: f ? f.lat : null, lon: f ? f.lon : null,
          acc: f ? Math.round(f.acc) : null,
          named: !!(f && f.name)};
}

function paintPlace(){
  const chip = $("#placechip"), nameEl = $("#placename"), accEl = $("#placeacc");
  if (!chip) return;
  const f = window.AGP ? AGP.current() : null;
  if (window.AGP && AGP.denied()){
    chip.dataset.state = "off";
    nameEl.textContent = "Location off — tap Change to type a place";
    accEl.textContent = "";
    if ($("#placemanual").hidden) toggleManualPlace(true);
    return;
  }
  if (!f){
    chip.dataset.state = "looking";
    nameEl.textContent = "Finding your location…";
    accEl.textContent = "";
    return;
  }
  chip.dataset.state = "fixed";
  // undefined means the name lookup is still out; null means this spot has no
  // name, which is a real answer and gets the coordinates rather than a spinner.
  nameEl.textContent = f.name === undefined ? "Naming this place…"
                     : (f.name || `${f.lat.toFixed(4)}, ${f.lon.toFixed(4)}`);
  accEl.textContent = f.acc ? `±${Math.round(f.acc)} m` : "";
}

function toggleManualPlace(on){
  const m = $("#placemanual");
  m.hidden = !on;
  $("#placeedit").textContent = on ? "Use my location" : "Change";
  if (on) $("#place").focus();
}

// A record can be made before the name lookup comes back. Rather than freeze
// the button or lose the place, the record keeps its coordinates and the name
// is patched in when it arrives.
function backfillPlaceName(rec){
  if (!window.AGP || rec.lat == null || rec.lon == null) return;
  if (rec.place && !/^-?\d+\.\d+, /.test(rec.place)) return;    // already named
  AGP.nameFor(rec.lat, rec.lon).then(n => {
    if (!n) return;
    rec.place = n;
    persist(); renderAll();
  }).catch(()=>{});
}

/* --- record --- */
function renderSpecimen(rec,{isNewDex,isBest,note}={}){
  const tpl=TX[rec.sn];
  const el=document.createElement("div");
  el.className="specimen"; el.dataset.status=rec.status; el.dataset.rank=rec.rank;
  const tier=masteryFor(rec.xp);
  const coarse=rec.rank!=="species";
  const [lo,hi]=coarse?candidateMassRange(rec):[0,0];

  const massLine = coarse
    ? `${rec.pct.toFixed(0)}th percentile for its kind, so
       <b class="approx">${fmtMass(lo)} – ${fmtMass(hi)}</b>
       depending on which it turns out to be.`
    : `Recorded at <b>${fmtMass(rec.mass)}</b> — ${rec.pct.toFixed(0)}th percentile,
       ${sizeNote(rec.pct)}.`;

  ensureImage(rec.sn, ()=>{ const out=document.getElementById("result");
    if(out && out.contains(el)) el.querySelector(".shotwrap").innerHTML =
      imgMarkup(rec.sn,"shot") + capMarkup(rec.sn); });

  el.innerHTML=`
    <div class="shotwrap">${imgMarkup(rec.sn,"shot")}${capMarkup(rec.sn)}</div>
    <div class="sci">${displayName(rec).sci}<span
      class="rank-pill" data-r="${rec.rank}">${rec.rank} · ${Math.round(rec.conf*100)}%</span></div>
    <div class="common">${displayName(rec).common}</div>
    <div class="tagline">${massLine}</div>
    ${coarse&&rec.cands.length?`<div class="cand">It is one of these:</div>
      <div class="candgrid">${rec.cands.map(m=>{
        ensureImage(m,()=>{const g=el.querySelector(`[data-cand="${m}"]`);
          if(g) g.innerHTML=imgMarkup(m,"candimg")+`<span>${(TX[m]&&TX[m].c)||m}</span>`;});
        return `<figure data-cand="${m}">${imgMarkup(m,"candimg")}<span>${(TX[m]&&TX[m].c)||m}</span></figure>`;
      }).join("")}</div>`:""}
    <div class="datagrid">
      <div class="cell"><div class="k">HP</div><div class="v">${rec.hp}</div></div>
      <div class="cell"><div class="k">Atk</div><div class="v">${rec.atk}</div></div>
      <div class="cell"><div class="k">Spd</div><div class="v">${rec.spd}</div></div>
      <div class="cell"><div class="k">Def</div><div class="v">${rec.dfn}</div></div>
    </div>
    <div class="chips">${rec.ab.map(a=>`<span class="chip on">${a.replace(/_/g," ")}</span>`).join("")}
      ${rec.te.slice(0,3).map(t=>`<span class="chip">${t}</span>`).join("")}</div>
    <div class="meta">${rec.status.toUpperCase()} · ${rec.place||"locality not recorded"} · ${fmtDate(rec.at)}<br>
      top speed ${rec.ms} m/s · ${tier[1]}${rec.dex?"":coarse?" · not a dex entry until identified to species":" · does not count toward dex"}</div>
    ${isNewDex?'<div class="banner">New dex entry</div>':""}
    ${isBest?'<div class="banner gold">Largest of its species you have recorded</div>':""}
    ${note?`<div class="banner ${note.kind||""}">${note.text}</div>`:""}`;

  if(coarse && rec.trueSp && !rec.gone){
    const bar=document.createElement("div"); bar.className="obsbar";
    bar.innerHTML=`<p class="note">Still in view. Watching longer may resolve it —
      but it may also leave.</p>`;
    const b=document.createElement("button");
    b.className="btn tiny"; b.textContent="Observe longer";
    b.addEventListener("click",()=>observeRecord(rec.uid));
    bar.appendChild(b); el.appendChild(bar);
  }
  return el;
}

async function observeRecord(uid){
  const rec=store.records.find(r=>r.uid===uid); if(!rec) return;
  const res=observeAgain(rec.rank, rec.trueSp, 2);
  let note=null;
  const before=new Set(store.records.filter(r=>r.dex&&r.uid!==uid).map(r=>r.sn));
  if(res.scan){
    promote(rec,res.scan.tpl);
    rec.conf=res.scan.conf; rec.cands=res.scan.cands||[];
    note={text:`Resolved to ${rec.rank}: ${rec.sn}. Mass reads ${fmtMass(rec.mass)} — still the
      ${rec.pct.toFixed(0)}th percentile it always was.`};
  }
  if(res.left){
    rec.gone=true;
    note={kind:"warn", text:(res.scan?"Resolved, then the animal moved off.":
      "The animal moved off before it could be identified further. The record stands as it is.")};
  }
  await persist();
  const out=$("#result"); out.innerHTML="";
  out.appendChild(renderSpecimen(rec,{isNewDex:rec.dex&&!before.has(rec.sn),note}));
  renderAll();
}

async function doRecord(){
  const sn=$("#species").value;
  const loc=placeNow();
  const scan=simulateScan(sn, viewQuality);
  const out=$("#result"); out.innerHTML="";

  if(!scan.rank){
    const d=document.createElement("div");
    d.className="specimen"; d.dataset.rank="none";
    d.innerHTML=`<div class="sci">No identification</div>
      <div class="tagline">The model couldn't place it (${Math.round(scan.conf*100)}% at best).
      Nothing was recorded. Try a longer look.</div>`;
    out.appendChild(d);
    return;
  }

  const before=new Set(store.records.filter(r=>r.dex).map(r=>r.sn));
  const prevMax=Math.max(0,...store.records.filter(r=>r.sn===scan.tpl.n).map(r=>r.mass));
  const rec=makeCapture(scan.tpl,{status,place:loc.place,lat:loc.lat,lon:loc.lon,
    conf:scan.conf, cands:scan.cands, trueSp:sn});
  rec.acc=loc.acc;
  store.records.push(rec);
  backfillPlaceName(rec);
  await persist();
  out.appendChild(renderSpecimen(rec,{
    isNewDex: rec.dex && !before.has(rec.sn),
    isBest: rec.rank==="species" && rec.mass>prevMax &&
            store.records.filter(r=>r.sn===scan.tpl.n).length>1
  }));
  renderAll();
}

/* --- collection --- */
function renderList(){
  const q=$("#q").value.toLowerCase().trim();
  const fs=$("#f-status").value, fc=$("#f-clade").value, sort=$("#f-sort").value;
  let rows=store.records.filter(r=>{
    if(fs==="unresolved"){ if(r.rank==="species") return false; }
    else if(fs&&r.status!==fs) return false;
    if(fc&&r.cl!==fc) return false;
    if(q){
      const hay=`${r.sn} ${r.cn} ${r.place} ${r.ab.join(" ")} ${r.te.join(" ")}`.toLowerCase();
      if(!hay.includes(q)) return false;
    }
    return true;
  });
  const cmp={recent:(a,b)=>b.at.localeCompare(a.at), mass:(a,b)=>b.mass-a.mass,
             pct:(a,b)=>b.pct-a.pct, xp:(a,b)=>b.xp-a.xp,
             near:(a,b)=>{const x=xpToNext(a.xp),y=xpToNext(b.xp);
                          return (x?x.need:1e9)-(y?y.need:1e9);},
             species:(a,b)=>a.sn.localeCompare(b.sn)||b.mass-a.mass}[sort];
  rows.sort(cmp);

  const el=$("#list");
  if(!rows.length){ el.innerHTML='<p class="empty">No records match.</p>'; return; }
  el.innerHTML="";
  rows.forEach(r=>{
    const [t,tn]=masteryFor(r.xp);
    const d=document.createElement("div"); d.className="rec";
    ensureImage(r.sn, ()=>{ const s=d.querySelector(".rowimgwrap");
      if(s) s.innerHTML=imgMarkup(r.sn,"rowimg"); });
    d.innerHTML=`
      <span class="rowimgwrap">${imgMarkup(r.sn,"rowimg")}</span>
      <button class="star" aria-pressed="${r.squad}" title="Active squad" data-uid="${r.uid}">${r.squad?"★":"☆"}</button>
      <div class="rec-main">
        <div class="rec-sci">${displayName(r).sci}${
          r.rank!=="species"?`<span class="rank-pill" data-r="${r.rank}">${r.rank}</span>`:""}</div>
        <div class="rec-sub">${(()=>{const d=displayName(r);
          return d.common && d.common!==d.sci ? d.common+" · " : "";})()}${r.status} · ${r.place||"—"} · ${fmtDate(r.at)}</div>
      </div>
      <div class="rec-right">
        <div class="mass">${fmtMass(r.mass)}</div>
        <div class="tier" data-t="${t}">${tn}</div>
        <div class="tier" style="color:var(--ink-3);font-weight:400">${
          (()=>{const n=xpToNext(r.xp);
            return n?`${n.need.toLocaleString()} to ${n.next}`:"max";})()}</div>
      </div>`;
    el.appendChild(d);
  });
  $("#squadn").textContent=store.records.filter(r=>r.squad).length;
}

/* --- dex --- */
function renderDex(){
  const got={};
  store.records.filter(r=>r.dex).forEach(r=>{ got[r.sn]=Math.max(got[r.sn]||0,r.mass); });
  const g=$("#dexgrid"); g.innerHTML="";
  [...SPECIES].sort((a,b)=>a.cl.localeCompare(b.cl)||a.cn.localeCompare(b.cn)).forEach(s=>{
    const d=document.createElement("div");
    d.className="dexcell"+(got[s.sn]?" got":"");
    if(got[s.sn]) ensureImage(s.sn, ()=>{ const w=d.querySelector(".dexthumbwrap");
      if(w) w.innerHTML=imgMarkup(s.sn,"dexthumb"); });
    d.innerHTML=`${got[s.sn]?`<span class="dexthumbwrap">${imgMarkup(s.sn,"dexthumb")}</span>`:""}
      <div class="dn">${got[s.sn]?s.sn:"—"}</div>
      <div class="dc">${got[s.sn]?((TX[s.sn]&&TX[s.sn].c)||s.cn):"unrecorded"}</div>
      ${got[s.sn]?`<div class="db">best ${fmtMass(got[s.sn])}</div>`:""}`;
    g.appendChild(d);
  });
  const n=Object.keys(got).length;
  $("#dexcount").textContent=`${n} / ${SPECIES.length}`;
  $("#dexfill").style.width=(100*n/SPECIES.length)+"%";
  const pend=store.records.filter(r=>r.rank!=="species").length;
  $("#pending").textContent = pend?`${pend} awaiting identification`:"";
  $("#obsn").textContent = store.records.length?`${store.records.length} records`:"";
}

/* What the scan log says so far, in one line. The point is not the number —
   it is that "identification usually stalls at genus" stops being a hunch. */
function renderScanStats(){
  const el=$("#scanstats"); if(!el) return;
  const xs=Array.isArray(store.scans)?store.scans:[];
  if(xs.length<3){ el.textContent=""; return; }
  const n=xs.length;
  const pct=k=>Math.round(100*xs.filter(x=>x.o===k).length/n);
  const held=xs.filter(x=>x.o==="record").map(x=>x.ms).sort((a,b)=>a-b);
  const med=held.length?Math.round(held[Math.floor(held.length/2)]/100)/10:null;
  const stalls={};
  xs.filter(x=>x.o!=="record"&&x.r).forEach(x=>{stalls[x.r]=(stalls[x.r]||0)+1});
  const worst=Object.entries(stalls).sort((a,b)=>b[1]-a[1])[0];
  el.textContent=`${n} scans · ${pct("record")}% reached a species`+
    (med!==null?`, median ${med}s of holding`:"")+
    ` · ${pct("abandon")+pct("lock-no-record")}% given up on`+
    (worst?` · most common stall: ${worst[0]} (${worst[1]})`:"");
}

function renderAll(){ renderList(); renderDex(); renderScanStats();
  $("#walked").textContent=store.km.toFixed(1)+" km"; }

/* --- events --- */
function wire(){
  $$(".tab").forEach(t=>t.addEventListener("click",()=>{
    $$(".tab").forEach(x=>x.setAttribute("aria-selected", String(x===t)));
    $$(".panel").forEach(p=>{p.hidden = p.id!==t.getAttribute("aria-controls")});
  }));
  $$(".seg button[data-v]").forEach(b=>b.addEventListener("click",()=>{
    status=b.dataset.v;
    $$(".seg button[data-v]").forEach(x=>x.setAttribute("aria-pressed",String(x===b)));
  }));
  $$("#viewseg button").forEach(b=>b.addEventListener("click",()=>{
    viewQuality=b.dataset.q;
    $$("#viewseg button").forEach(x=>x.setAttribute("aria-pressed",String(x===b)));
  }));
  $("#record").addEventListener("click",doRecord);
  ["#q","#f-status","#f-sort","#f-clade"].forEach(s=>
    $(s).addEventListener("input",renderList));

  $("#list").addEventListener("click",async e=>{
    const b=e.target.closest(".star"); if(!b) return;
    const r=store.records.find(x=>x.uid===b.dataset.uid); if(!r) return;
    const n=store.records.filter(x=>x.squad).length;
    if(!r.squad && n>=SQUAD_MAX) return;
    if(!r.battle && !r.squad) return;   // s4: captive animals can't be fielded
    r.squad=!r.squad; await persist(); renderList();
  });

  $$("[data-walk]").forEach(b=>b.addEventListener("click",async()=>{
    const km=parseFloat(b.dataset.walk);
    store.km+=km;
    const gained=Math.round(km*XP_PER_KM);
    store.records.filter(r=>r.squad).forEach(r=>r.xp+=gained);
    await persist(); renderAll();
  }));

  $("#placeedit").addEventListener("click",()=>toggleManualPlace($("#placemanual").hidden));

  $("#export").addEventListener("click",exportJSON);
  $("#importfile").addEventListener("change",e=>{
    if(e.target.files[0]) importJSON(e.target.files[0]);
    e.target.value="";
  });
  $("#reset").addEventListener("click",async()=>{
    store={records:[],km:0,scans:[]}; await persist(); $("#result").innerHTML=""; renderAll();
  });
}

async function loadData(){
  const [g,t,s] = await Promise.all([
    fetch("data/stat_grid.json").then(r=>r.json()),
    fetch("data/taxonomy.json").then(r=>r.json()),
    fetch("data/species.json").then(r=>r.json()),
  ]);
  GRID=g; TAXONOMY=t; SPECIES=s;
  TX=TAXONOMY.taxa; LINEAGE=TAXONOMY.lineage;
  byName=Object.fromEntries(SPECIES.map(x=>[x.sn,x]));
}

(async function start(){
  try{
    await loadData();
  }catch(e){
    document.getElementById("boot").textContent =
      "Couldn't load the species data. If this is the first run, you need to be online once.";
    return;
  }
  document.getElementById("boot").hidden = true;
  document.getElementById("app").hidden = false;
  fillPicker(); addHints(); wire(); wireIntro();
  await initStore();
  renderAll();
  maybeShowIntro();
  if (window.AGP){ AGP.onChange(paintPlace); AGP.start(); }
  paintPlace();

  // The scanner owns the camera, the worker and the Record button. It is started
  // after the UI is up so a camera prompt never blocks the app from rendering.
  try{ await initScanner(); }
  catch(e){ document.getElementById("scanmsg").textContent =
    "The scanner couldn't start. Use the species list below."; }

  if("serviceWorker" in navigator){
    try{ await navigator.serviceWorker.register("sw.js"); }catch(e){}
  }
})();

/* ============================================================
   507 model outputs -> one answer, as deep in the taxonomy as the evidence
   supports.

   Lives in its own file because two pages need exactly this and nothing else:
   the scanner, and scan-test.html, which measures the classifier against known
   photographs. Design doc s11.7 was about the allometry being reimplemented in
   two places and drifting; the same mistake was available here, so this is the
   one copy. Depends on nothing but the taxonomy data.

   Usage:  AGR.build(TAXONOMY);  const r = AGR.rollup(probabilities);
   ============================================================ */
(function(global){
"use strict";

/* --- confidence thresholds ------------------------------------------------
   A coarse node's score is the sum of every leaf beneath it, so it is always at
   least as large as its best child. Thresholds therefore rise as the rank gets
   coarser, or the answer would always be "an insect". Species and genus share a
   bar deliberately: at equal thresholds the deepest-first check reduces to "take
   the species if the model actually picked one, otherwise the genus it is sure
   of", which is the behaviour the interaction promises.                         */
const TH = { species: 0.55, genus: 0.55, family: 0.65, class: 0.70 };

/* --- taxonomy rollup ------------------------------------------------------ */
let IDX = null;      // classIndex, from data/taxonomy.json
let ROLL = null;     // precomputed per-leaf lineage, built once

let TXR = null, LIN = null;

function buildRollup(taxonomy){
  const T = taxonomy || global.TAXONOMY;
  TXR = T.taxa; LIN = T.lineage;
  IDX = T.classIndex;
  ROLL = IDX.map(e => {
    if (!e || !e.animal || !e.inDex) return null;
    const lin = LIN[e.sn];
    if (!lin) return null;
    return { sn: e.sn, cl: e.cl, genus: lin[1] || null, family: lin[2] || null };
  });
}

/* Sum the leaf probabilities into every node above them, then take the deepest
   node that clears its threshold. This is the same shape of answer the old
   simulateScan() faked, so promote(), makeCapture() and the dex rules all
   consume it unchanged. */
function rollup(p){
  const sp = new Map(), ge = new Map(), fa = new Map(), cls = new Map();
  let pAnimal = 0;

  for (let i=0;i<p.length;i++){
    const v = p[i];
    if (v < 1e-5) continue;
    const r = ROLL[i];
    if (!r){
      const e = IDX[i];
      if (e) cls.set(e.cl, (cls.get(e.cl)||0) + v);   // plants and fungi still get named
      continue;
    }
    pAnimal += v;
    sp.set(r.sn, (sp.get(r.sn)||0) + v);
    if (r.genus)  ge.set(r.genus,  (ge.get(r.genus)||0)  + v);
    if (r.family) fa.set(r.family, (fa.get(r.family)||0) + v);
    cls.set(r.cl, (cls.get(r.cl)||0) + v);
  }

  const top = m => {
    let bn=null, bv=0;
    for (const [k,v] of m) if (v > bv){ bn=k; bv=v; }
    return bn === null ? null : {name:bn, p:bv};
  };
  const tSp=top(sp), tGe=top(ge), tFa=top(fa), tCl=top(cls);

  // Deepest first: a species-level answer is worth more than the family it
  // implies, even though the family scores higher by construction.
  let pick = null;
  if (tSp && tSp.p >= TH.species)      pick = {...tSp, rank:"species"};
  else if (tGe && tGe.p >= TH.genus)   pick = {...tGe, rank:"genus"};
  else if (tFa && tFa.p >= TH.family)  pick = {...tFa, rank:"family"};

  // Singleton genera need no special handling, which is worth stating because
  // the prototype had a loop for it. 213 of the 245 genera here have exactly one
  // member in the model, and for those the genus score IS the species score --
  // they are the same sum. Since species is checked first at the same threshold,
  // such a hit always comes back as the species. The old walk-down-singletons
  // loop could never fire, and a test for it is what showed that.

  return {
    pick,
    animal: pAnimal,
    sp: tSp, ge: tGe, fa: tFa, cl: tCl,
    notAnimal: tCl && !isAnimalClass(tCl.name) ? tCl : null,
  };
}

const ANIMAL_CLASSES = new Set();
function isAnimalClass(c){
  if (!ANIMAL_CLASSES.size)
    IDX.forEach(e => { if (e && e.animal) ANIMAL_CLASSES.add(e.cl); });
  return ANIMAL_CLASSES.has(c);
}

/* Readable names for the climb. "Apidae" means nothing on a phone screen;
   "bees and relatives" does. The taxonomy file already carries common names for
   higher taxa, so this only has to fall back for model-only leaves. */
const CLASS_NAMES = {
  Insecta:"insect", Aves:"bird", Mammalia:"mammal", Reptilia:"reptile",
  Amphibia:"amphibian", Arachnida:"spider or relative", Gastropoda:"snail or slug",
  Malacostraca:"crab or relative", Actinopterygii:"fish", Bivalvia:"clam or mussel",
  Diplopoda:"millipede", Chilopoda:"centipede", Clitellata:"worm",
  Merostomata:"horseshoe crab", Anthozoa:"coral or anemone", Hydrozoa:"hydroid",
  Asteroidea:"sea star", Magnoliopsida:"flowering plant", Liliopsida:"flowering plant",
  Pinopsida:"conifer", Polypodiopsida:"fern", Agaricomycetes:"mushroom",
  Lecanoromycetes:"lichen", Tremellomycetes:"fungus", Myxomycetes:"slime mould",
  Phaeophyceae:"seaweed", Cyanophyceae:"algae",
};
function niceName(name){
  const t = TXR[name];
  if (t && t.c && t.c !== name) return t.c;
  return CLASS_NAMES[name] || name;
}

global.AGR = {build:buildRollup, rollup, niceName, TH,
              get idx(){ return IDX; }};
})(typeof window !== "undefined" ? window : globalThis);

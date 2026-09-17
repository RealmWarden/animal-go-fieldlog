/* Unit test for the taxonomy rollup in pwa/rollup.js.

   Loads the SHIPPED rollup.js rather than a copy, and
   feeds it hand-built probability vectors. The rollup is the piece that turns
   507 model outputs into "you found a bumblebee", so it is worth testing
   against vectors whose right answer is known by construction.                */

import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "pwa");
const TAXONOMY = JSON.parse(fs.readFileSync(path.join(ROOT,"data/taxonomy.json"),"utf8"));
const src = fs.readFileSync(path.join(ROOT,"rollup.js"),"utf8");

const ctx = {
  TAXONOMY, TX: TAXONOMY.taxa, LINEAGE: TAXONOMY.lineage,
  window:{}, document:{ getElementById:()=>({ innerHTML:"", textContent:"", dataset:{}, hidden:true,
                                              addEventListener(){}, scrollIntoView(){} }),
                        addEventListener(){} },
  navigator:{}, requestAnimationFrame(){}, performance:{now:()=>0},
  console, Worker: class {}, store:{records:[]},
  ensureImage(){}, imgMarkup:()=>"", makeCapture(){}, persist(){}, renderSpecimen(){},
  renderAll(){}, status:"wild", lastCoords:null,
};
vm.createContext(ctx);
vm.runInContext(src, ctx);
const T = ctx.window.AGR;
T.build(TAXONOMY);

const IDX = TAXONOMY.classIndex;
const at = sn => { const i = IDX.findIndex(e=>e && e.sn===sn);
                   if(i<0) throw new Error("not in model: "+sn); return i; };
const vec = (spec) => { const v=new Float32Array(IDX.length);
                        for(const [sn,p] of Object.entries(spec)) v[at(sn)]=p; return v; };

let pass=0, fail=0;
function check(label, got, want){
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok?"ok  ":"FAIL"}  ${label}`.padEnd(66) + (ok?"":`got ${got}, want ${want}`));
}

console.log("\n1. A confident single species");
{
  const r = T.rollup(vec({"Bombus vosnesenskii":0.88, "Bombus impatiens":0.04, "Apis mellifera":0.03}));
  check("rank is species", r.pick.rank, "species");
  check("name is the species", r.pick.name, "Bombus vosnesenskii");
}

console.log("\n2. Split across a genus — the case that must NOT claim a species");
{
  // No single bumblebee clears 0.50, but the genus sums to 0.86.
  const r = T.rollup(vec({"Bombus vosnesenskii":0.24,"Bombus impatiens":0.22,
                          "Bombus griseocollis":0.20,"Bombus bimaculatus":0.20,
                          "Apis mellifera":0.05}));
  check("rank is genus", r.pick.rank, "genus");
  check("name is the genus", r.pick.name, "Bombus");
  check("genus mass is the sum", Math.round(r.ge.p*100)/100, 0.86);
}

console.log("\n3. Split across a family — one rank coarser still");
{
  const spread = {};
  for (const m of TAXONOMY.taxa["Apidae"].mem.slice(0,8)) spread[m] = 0.09;
  const r = T.rollup(vec(spread));
  check("rank is family or genus", ["family","genus","species"].includes(r.pick?.rank), true);
  check("family node is Apidae", r.fa.name, "Apidae");
}

console.log("\n4. A singleton genus comes back as its species, with no special case");
{
  const single = Object.keys(TAXONOMY.taxa).filter(k =>
    TAXONOMY.taxa[k].r === "genus" && TAXONOMY.taxa[k].mem.length === 1);
  check("most genera are singletons", single.length > 200, true);
  const sp = TAXONOMY.taxa[single[0]].mem[0];
  const r = T.rollup(vec({[sp]:0.60}));
  check("rank is species", r.pick.rank, "species");
  check("name is the species", r.pick.name, sp);
  check("its genus scores the same", Math.abs(r.ge.p - r.sp.p) < 1e-6, true);
}

console.log("\n4b. A two-species genus can still be ambiguous");
{
  const two = Object.keys(TAXONOMY.taxa).find(k =>
    TAXONOMY.taxa[k].r === "genus" && TAXONOMY.taxa[k].mem.length === 2);
  const [a,b] = TAXONOMY.taxa[two].mem;
  const r = T.rollup(vec({[a]:0.40,[b]:0.38}));
  check("rank is genus", r.pick.rank, "genus");
  check("name is the genus", r.pick.name, two);
}

console.log("\n5. Nothing confident — no identification at all");
{
  const flat = new Float32Array(IDX.length).fill(1/IDX.length);
  const r = T.rollup(flat);
  check("no pick", r.pick, null);
}

console.log("\n6. A plant is named as a plant, not forced into an animal");
{
  const r = T.rollup(vec({"Acer platanoides":0.80, "Sassafras albidum":0.10}));
  check("no animal pick", r.pick, null);
  check("flagged as not-animal", r.notAnimal !== null, true);
  check("named as the plant class", T.niceName(r.notAnimal.name), "flowering plant");
  check("animal mass is near zero", r.animal < 0.01, true);
}

console.log("\n7. Thresholds never fall as the rank gets coarser");
{
  check("species <= genus", T.TH.species <= T.TH.genus, true);
  check("genus < family",   T.TH.genus   <  T.TH.family, true);
}

console.log("\n8. Every roster species in the model has a full lineage");
{
  let missing = 0;
  IDX.forEach(e => { if (e && e.animal && e.inDex && !TAXONOMY.lineage[e.sn]) missing++; });
  check("leaves without lineage", missing, 0);
  const rolled = IDX.filter((e,i)=>e&&e.animal&&e.inDex).length;
  check("animal leaves rolled up", rolled, 296);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

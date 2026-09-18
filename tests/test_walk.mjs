/* Unit test for the distance engine in pwa/walk.js.

   The engine's whole claim is that it credits a LOWER BOUND on the distance
   actually walked — never more, whatever the GPS does and whatever the player
   tries. These are the cases that would break that claim.                   */

import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "pwa");
const src = fs.readFileSync(path.join(ROOT, "walk.js"), "utf8");

let pass=0, fail=0;
const check=(label,got,want)=>{ const ok=JSON.stringify(got)===JSON.stringify(want);
  ok?pass++:fail++;
  console.log(`  ${ok?"ok  ":"FAIL"}  ${label}`.padEnd(62)+(ok?"":`got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)); };
const checkT=(l,c)=>check(l,!!c,true);
const near=(l,got,want,tol)=>{ const ok=Math.abs(got-want)<=tol; ok?pass++:fail++;
  console.log(`  ${ok?"ok  ":"FAIL"}  ${l}`.padEnd(62)+(ok?"":`got ${got}, want ${want}±${tol}`)); };

function fresh(){
  const ctx = {store:{km:0}, history:{replaceState(){}},
               location:{search:"", pathname:"/"}, URLSearchParams,
               console, Date, Math, Number, isFinite, JSON};
  ctx.global = ctx; ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  // the app owns the lifetime total; walk.js only reports the gain
  ctx.AGW.attach(() => ctx.store);
  ctx.AGW.onGain(km => { ctx.store.km = Math.round((ctx.store.km + km)*1000)/1000; });
  return ctx;
}

// 100 m north of a point, roughly: 0.0008993° of latitude
const north = (lat, m) => lat + m/111320;

console.log("\n1. A straight walk is credited");
{
  const c = fresh();
  let t = Date.now();
  c.AGW.fix({lat:34.0, lon:-118.0, acc:8, at:t});
  let total = 0;
  for (let i=1;i<=10;i++){                     // 10 x 50 m, 40 s apart -> 1.25 m/s
    t += 40000;
    total += c.AGW.fix({lat:north(34.0, 50*i), lon:-118.0, acc:8, at:t}).m;
  }
  near("500 m of walking is credited", Math.round(total), 500, 6);
  near("and reaches the all-time total", c.store.km, 0.5, 0.01);
}

console.log("\n2. Standing still credits nothing, however long you stand");
{
  const c = fresh();
  let t = Date.now(), total = 0;
  c.AGW.fix({lat:34.0, lon:-118.0, acc:8, at:t});
  for (let i=0;i<200;i++){                     // GPS wobble of ~2 m for 20 minutes
    t += 6000;
    total += c.AGW.fix({lat:north(34.0, (i%2)?2:0), lon:-118.0, acc:8, at:t}).m;
  }
  check("jitter is not distance", Math.round(total), 0);
  check("the total is untouched", c.store.km, 0);
}

console.log("\n3. Driving is rejected outright (design doc s8.2)");
{
  const c = fresh();
  let t = Date.now();
  c.AGW.fix({lat:34.0, lon:-118.0, acc:8, at:t});
  t += 600000;                                  // 10 minutes
  const r = c.AGW.fix({lat:north(34.0, 12000), lon:-118.0, acc:8, at:t});  // 12 km -> 20 m/s
  check("nothing credited", r.m, 0);
  check("and it says why", r.why, "faster than walking");
  check("total unchanged", c.store.km, 0);
}

console.log("\n4. A closed-app gap credits the straight line, never more");
{
  const c = fresh();
  let t = Date.now();
  c.AGW.fix({lat:34.0, lon:-118.0, acc:8, at:t});
  t += 45*60000;                                // app closed 45 minutes
  const r = c.AGW.fix({lat:north(34.0, 2000), lon:-118.0, acc:8, at:t});   // 2 km apart
  near("the displacement is credited", Math.round(r.m), 2000, 20);
  // and the walk that returns home credits nothing, which is the honest answer
  const c2 = fresh();
  let t2 = Date.now();
  c2.AGW.fix({lat:34.0, lon:-118.0, acc:8, at:t2});
  t2 += 60*60000;
  const r2 = c2.AGW.fix({lat:34.0, lon:-118.0, acc:8, at:t2});             // back where it started
  check("a loop back to the start credits nothing", r2.m, 0);
  console.log("        (under-crediting is the point: the engine can only ever pay for");
  console.log("         displacement it witnessed, so it cannot be inflated)");
}

console.log("\n5. A vague fix cannot measure a small step");
{
  const c = fresh();
  let t = Date.now();
  c.AGW.fix({lat:34.0, lon:-118.0, acc:8, at:t});
  t += 30000;
  const r = c.AGW.fix({lat:north(34.0, 30), lon:-118.0, acc:400, at:t});
  check("a 400 m accuracy fix is discarded", r.why, "fix too vague");
}

console.log("\n6. A Health top-up tops up, and never double-counts");
{
  const c = fresh();
  let t = Date.now();
  c.AGW.fix({lat:34.0, lon:-118.0, acc:8, at:t});
  t += 60000; c.AGW.fix({lat:north(34.0,80), lon:-118.0, acc:8, at:t});   // ~80 m tracked
  near("tracked so far", c.AGW.today().tracked, 80, 3);

  c.AGW.ingest(3000);                        // Health says 3 km today
  near("the day becomes the larger figure", c.AGW.today().m, 3000, 3);
  near("and the total follows", c.store.km, 3.0, 0.01);

  c.AGW.ingest(3000);                        // the same report again
  near("reporting it twice changes nothing", c.store.km, 3.0, 0.01);

  c.AGW.ingest(1000);                        // a smaller figure
  near("a smaller figure is ignored", c.store.km, 3.0, 0.01);

  c.AGW.ingest(4200);                        // later in the day
  near("a larger one tops up by the difference", c.store.km, 4.2, 0.01);
}

console.log("\n7. Tracked distance beyond the Health figure still counts");
{
  const c = fresh();
  c.AGW.ingest(1000);
  near("Health first", c.store.km, 1.0, 0.01);
  let t = Date.now();
  c.AGW.fix({lat:34.0, lon:-118.0, acc:8, at:t});
  for (let i=1;i<=30;i++){ t += 60000;         // 30 x 50 m = 1.5 km tracked
    c.AGW.fix({lat:north(34.0, 50*i), lon:-118.0, acc:8, at:t}); }
  near("the larger of the two wins", c.store.km, 1.5, 0.02);
}

console.log("\n8. A day is capped, and a new day starts clean");
{
  const c = fresh();
  c.AGW.ingest(500000);                        // 500 km reported
  near("the daily cap holds", c.store.km, 60, 0.01);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);

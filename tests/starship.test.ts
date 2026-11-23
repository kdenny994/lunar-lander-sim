// Headless Starship landings at the Shackleton rim with 3, 2 and 1 engines for braking.
import { readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { HeightGrid, TerrainData, decodeHeightPng, polarInverse } from '../src/sim/terrainData';
import { SS, SSState, stepStarship, massBudget, descentOrbitState, ascentDvAvailable } from '../src/sim/starship';
import { StarshipGuidance } from '../src/sim/starshipGuidance';
import { predictTouchdown, hoverslam } from '../src/sim/ssPredict';
import { vecToLLR } from '../src/sim/geo';
import { llrToVec } from '../src/sim/geo';
import { MOON } from '../src/sim/constants';

const base = 'public/data/shackleton/terrain';
async function load(n: string) {
  const meta = JSON.parse(readFileSync(`${base}/${n}.json`, 'utf8'));
  const data = await decodeHeightPng(new Blob([readFileSync(`${base}/${n}_h.png`)]), meta.width, meta.height);
  return new HeightGrid(meta, data);
}
let fails = 0;
const check = (name: string, ok: boolean, info: string) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${info}`); if (!ok) fails++; };

const terrain = new TerrainData(await load('corridor'), await load('site'));
const site = terrain.site.meta as any;
const sll = polarInverse(site.proj, site.siteX, site.siteY);
const siteGround = llrToVec(sll.lat, sll.lon, MOON.radius + terrain.heightAt(sll.lat, sll.lon));
const peri = polarInverse(site.proj, site.siteX, site.siteY - 110000);
const from = polarInverse(site.proj, site.siteX, site.siteY - 50000);
const fromV = llrToVec(from.lat, from.lon, MOON.radius);
const mb = massBudget();
console.log('budget', JSON.stringify(Object.fromEntries(Object.entries(mb).map(([k, v]) => [k, Math.round(v as number)]))));

type Case = { name: string; n: number; land?: number; toggleAt?: number; toggleTo?: number; cross?: number; massScale?: number };
const cases: Case[] = [
  { name: '3-engine braking', n: 3 },
  { name: '2-engine braking', n: 2 },
  { name: '1-engine braking', n: 1 },
  { name: 'crew toggles 3 -> 1 engine mid-braking', n: 3, toggleAt: 200, toggleTo: 1 },
  { name: 'crew toggles 1 -> 3 engines mid-braking', n: 1, toggleAt: 150, toggleTo: 3 },
  { name: 'orbit 1.5 km off the ground track, 2 engines', n: 2, cross: 1500 },
  { name: '5 % heavier than planned, 3 engines', n: 3, massScale: 1.05 },
  { name: '3-engine braking, 2-engine landing burn', n: 3, land: 2 },
  { name: '3-engine braking, 3-engine landing burn', n: 3, land: 3 },
];
for (const k of cases) {
  const s = new SSState();
  const periK = k.cross ? polarInverse(site.proj, site.siteX + k.cross, site.siteY - 110000) : peri;
  const sllK = k.cross ? polarInverse(site.proj, site.siteX + k.cross, site.siteY) : sll;
  descentOrbitState(s, periK, sllK, 260000);
  s.prop = (mb.pdiMass * (k.massScale ?? 1)) - SS.dryMass - SS.payload - mb.residual; s.residual = mb.residual;
  const m0 = s.mass;
  const g = new StarshipGuidance(siteGround, fromV);
  g.brakingEngines = k.n;
  if (k.land) g.landingEngines = k.land;
  g.groundRadius = (p) => { const q = p.clone().normalize(); const lat = Math.asin(q.z) * 180 / Math.PI, lon = Math.atan2(q.y, q.x) * 180 / Math.PI; return MOON.radius + terrain.heightAt(lat, lon); };
  let maxG = 0, pdiRange = 0, t = 0;
  const dt = 0.005;
  while (t < 1500 && !s.landed && !s.crashed) {
    if (k.toggleAt && t >= k.toggleAt && g.brakingEngines !== k.toggleTo) g.brakingEngines = k.toggleTo!;
    const prev = g.phase;
    const c = g.update(s, dt, null);
    stepStarship(s, c, dt, terrain);
    if (prev === 'coast' && g.phase === 'braking') pdiRange = s.r.clone().sub(siteGround).length() / 1000;
    maxG = Math.max(maxG, s.accel.length() / 9.80665);
    t += dt;
  }
  const td = s.touchdown;
  const rel = s.r.clone().sub(g.siteCG);
  const miss = rel.addScaledVector(g.siteUp, -rel.dot(g.siteUp)).length();
  const dvAsc = ascentDvAvailable(s.mass, s.residual);
  console.log(`  ${k.name}: PDI ${pdiRange.toFixed(0)} km out, touchdown t=${t.toFixed(0)} s, ${td ? `vv ${td.vVert.toFixed(2)} vh ${td.vHorz.toFixed(2)} tilt ${td.tilt.toFixed(1)}` : 'none'}, miss ${miss.toFixed(1)} m, ` +
    `descent dv ${s.dvUsed.toFixed(0)} m/s, used ${((m0 - s.mass) / 1000).toFixed(1)} t, landed ${(s.mass / 1000).toFixed(1)} t, ascent dv ${dvAsc.toFixed(0)} (need ${mb.ascentReq.toFixed(0)}), max ${maxG.toFixed(2)} g0${g.landLong > 50 ? `, landed ${(g.landLong / 1000).toFixed(1)} km long` : ""}`);
  check(`${k.name} lands`, s.landed && !s.crashed && miss < 30, `miss ${miss.toFixed(1)} m`);
  if (!k.massScale) check(`${k.name} keeps enough propellant for the 600 km orbit`, dvAsc >= mb.ascentReq, `${dvAsc.toFixed(0)} >= ${mb.ascentReq.toFixed(0)} m/s`);
}

// ---- Raptor start / cutoff transients (one engine, high above the surface so nothing touches) ----
{
  const s = new SSState();
  descentOrbitState(s, peri, sll, 260000);
  s.prop = 200000; s.residual = 0;
  const p0 = s.prop;
  const ctl = { engines: 1, throttle: 0.4, torque: new Vector3() };
  const dt = 0.005;
  let t = 0, tIgn = -1, tMin = -1;
  while (t < 4) { stepStarship(s, ctl, dt, terrain); t += dt; if (tIgn < 0 && s.eng[0] > 0) tIgn = t; if (tMin < 0 && s.engPhase[0] === 'run') tMin = t; }
  const thrRun = s.eng[0];
  ctl.engines = 0;
  t = 0; let tOff = -1;
  while (t < 2) { stepStarship(s, ctl, dt, terrain); t += dt; if (tOff < 0 && s.eng[0] === 0) tOff = t; }
  const expectImp = thrRun * SS.raptorThrustVac * SS.shutdownTau;
  console.log(`  transients: ignition ${tIgn.toFixed(2)} s, min thrust ${tMin.toFixed(2)} s, tail-off ${tOff.toFixed(2)} s, tail impulse ${(s.tailImpulse / 1000).toFixed(0)} kN s (expect ~${(expectImp / 1000).toFixed(0)}), start+stop propellant ${s.transientProp.toFixed(0)} kg, starts ${s.starts}`);
  check('Raptor start: no thrust until spin-up ends, minimum thrust at engineStart', Math.abs(tIgn - SS.engineSpin) < 0.02 && Math.abs(tMin - SS.engineStart) < 0.02, `${tIgn.toFixed(2)} / ${tMin.toFixed(2)} s`);
  check('Raptor cutoff: thrust tail-off under 1 s with its impulse', tOff > 0.3 && tOff < 1.0 && Math.abs(s.tailImpulse - expectImp) / expectImp < 0.1, `${tOff.toFixed(2)} s`);
  check('Raptor start and shutdown propellant charged', Math.abs(s.transientProp - SS.startProp - SS.shutdownProp) < 1 && p0 - s.prop > s.transientProp, `${s.transientProp.toFixed(0)} kg`);
}

// ---- predicted touchdown vs. the actual manual landing with the same settings held ----
{
  const s = new SSState();
  descentOrbitState(s, peri, sll, 260000);
  s.prop = mb.pdiMass - SS.dryMass - SS.payload - mb.residual; s.residual = mb.residual;
  const g = new StarshipGuidance(siteGround, fromV);
  g.groundRadius = (p) => { const q = p.clone().normalize(); return MOON.radius + terrain.heightAt(Math.asin(q.z) * 180 / Math.PI, Math.atan2(q.y, q.x) * 180 / Math.PI); };
  const dt = 0.005;
  let t = 0;
  while (t < 1500 && !(g.phase === 'landing' && !g.pitching && s.running > 0 && s.altitude(terrain) < 400)) { stepStarship(s, g.update(s, dt, null), dt, terrain); t += dt; }
  // crew takes over: 1 engine, hoverslam autothrottle, attitude held as it is
  console.log(`  handover t=${t.toFixed(1)} phase ${g.phase} alt ${s.altitude(terrain).toFixed(0)} vz ${s.v.dot(s.r.clone().normalize()).toFixed(1)} running ${s.running} landed ${s.landed}`);
  s.w.set(0, 0, 0);
  const pred = predictTouchdown(s, { engines: 1, throttle: null }, terrain);
  const ctl = { engines: 1, throttle: 0.4, torque: new Vector3() };
  let tt = 0, lit = s.running > 0;
  while (tt < 300 && !s.touchdown) {
    const u = s.r.clone().normalize();
    const aMax = SS.raptorThrustVac / s.mass;
    const hs = hoverslam(s.altitude(terrain), s.v.dot(u), new Vector3(1, 0, 0).applyQuaternion(s.q).dot(u), aMax, lit);
    lit = hs.on; ctl.engines = lit ? 1 : 0;
    ctl.throttle = Math.min(1, Math.max(SS.minThrottle, hs.accel / aMax));
    s.w.set(0, 0, 0);
    stepStarship(s, ctl, dt, terrain); tt += dt;
  }
  const actual = vecToLLR(s.r);
  const aPos = llrToVec(actual.lat, actual.lon, MOON.radius);
  const pPos = pred ? llrToVec(pred.lat, pred.lon, MOON.radius) : aPos.clone().addScalar(1e6);
  const err = aPos.distanceTo(pPos);
  console.log(`  prediction: ${pred ? `${pred.lat.toFixed(5)} ${pred.lon.toFixed(4)} in ${pred.t.toFixed(1)} s (${pred.vVert.toFixed(1)} m/s)` : 'none'}; actual ${actual.lat.toFixed(5)} ${actual.lon.toFixed(4)} after ${tt.toFixed(1)} s (${s.touchdown ? `${s.touchdown.vVert.toFixed(1)} m/s down ${s.touchdown.vHorz.toFixed(1)} across tilt ${s.touchdown.tilt.toFixed(1)}` : "-"}, crashed ${s.crashed}); error ${err.toFixed(1)} m`);
  check('predicted touchdown matches the flown one', !!pred && err < 15 && Math.abs(pred.t - tt) < 3, `${err.toFixed(1)} m, ${pred ? Math.abs(pred.t - tt).toFixed(1) : '-'} s`);
}
process.exit(fails ? 1 : 0);

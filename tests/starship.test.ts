// Headless Starship landings at the Shackleton rim with 3, 2 and 1 engines for braking.
import { readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { HeightGrid, TerrainData, decodeHeightPng, spsInverse } from '../src/sim/terrainData';
import { SS, SSState, stepStarship, massBudget, descentOrbitState, ascentDvAvailable } from '../src/sim/starship';
import { StarshipGuidance } from '../src/sim/starshipGuidance';
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
const sll = spsInverse(site.siteX, site.siteY);
const siteGround = llrToVec(sll.lat, sll.lon, MOON.radius + terrain.heightAt(sll.lat, sll.lon));
const peri = spsInverse(site.siteX, site.siteY - 110000);
const from = spsInverse(site.siteX, site.siteY - 50000);
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
  const periK = k.cross ? spsInverse(site.siteX + k.cross, site.siteY - 110000) : peri;
  const sllK = k.cross ? spsInverse(site.siteX + k.cross, site.siteY) : sll;
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
process.exit(fails ? 1 : 0);

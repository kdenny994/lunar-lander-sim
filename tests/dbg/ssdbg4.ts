import { readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { HeightGrid, TerrainData, decodeHeightPng, spsInverse } from '../../src/sim/terrainData';
import { SS, SSState, stepStarship, massBudget, descentOrbitState } from '../../src/sim/starship';
import { StarshipGuidance } from '../../src/sim/starshipGuidance';
import { llrToVec } from '../../src/sim/geo';
import { MOON } from '../../src/sim/constants';
const base = '/home/user/lunar-lander-sim/public/data/shackleton/terrain';
async function load(n: string) { const meta = JSON.parse(readFileSync(`${base}/${n}.json`, 'utf8')); return new HeightGrid(meta, await decodeHeightPng(new Blob([readFileSync(`${base}/${n}_h.png`)]), meta.width, meta.height)); }
const terrain = new TerrainData(await load('corridor'), await load('site'));
const site = terrain.site.meta as any;
const sll = spsInverse(site.siteX, site.siteY);
const siteGround = llrToVec(sll.lat, sll.lon, MOON.radius + terrain.heightAt(sll.lat, sll.lon));
const peri = spsInverse(site.siteX, site.siteY - 110000), from = spsInverse(site.siteX, site.siteY - 50000);
const mb = massBudget();
const [n0, tt, n1] = process.argv.slice(2).map(Number);
const s = new SSState(); descentOrbitState(s, peri, sll, 260000);
s.prop = mb.pdiMass - SS.dryMass - SS.payload - mb.residual; s.residual = mb.residual;
const g = new StarshipGuidance(siteGround, llrToVec(from.lat, from.lon, MOON.radius)); g.brakingEngines = n0;
g.groundRadius = (p) => { const q = p.clone().normalize(); const lat = Math.asin(q.z) * 180 / Math.PI, lon = Math.atan2(q.y, q.x) * 180 / Math.PI; return MOON.radius + terrain.heightAt(lat, lon); };
let t = 0, next = 0; const dt = 0.005;
while (t < 900 && !s.landed && !s.crashed) {
  if (t >= tt) g.brakingEngines = n1;
  const c = g.update(s, dt, null); stepStarship(s, c, dt, terrain); t += dt;
  if (t >= next) { next += 5; const rel = s.r.clone().sub(g.siteCG); const h = rel.dot(g.siteUp);
    console.log(t.toFixed(0), g.phase, g.status, 'h', h.toFixed(0), 'd', (rel.addScaledVector(g.siteUp, -h).length()/1000).toFixed(2), 'v', s.v.length().toFixed(0), 'eng', s.running, 'thr', c.throttle.toFixed(2), 'alt', s.altitude(terrain).toFixed(0)); }
}
console.log('end', t.toFixed(1), JSON.stringify(s.touchdown), s.landed, s.crashed);

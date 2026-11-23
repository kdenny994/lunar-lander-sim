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
const n = Number(process.argv[2] || 3);
const s = new SSState(); descentOrbitState(s, peri, sll, 260000);
s.prop = mb.pdiMass - SS.dryMass - SS.payload - mb.residual; s.residual = mb.residual;
const g = new StarshipGuidance(siteGround, llrToVec(from.lat, from.lon, MOON.radius)); g.brakingEngines = n;
let t = 0, next = 0; const dt = 0.005;
while (t < 900 && !s.landed && !s.crashed) {
  const c = g.update(s, dt, null); stepStarship(s, c, dt, terrain); t += dt;
  if (t >= next) { next += (g.phase==="landing") ? 1 : 5;
    const xb = new Vector3(1,0,0).applyQuaternion(s.q); const err = g.attTarget ? Math.acos(Math.min(1, xb.dot(g.attTarget)))*57.3 : 0;
    const rel = s.r.clone().sub(g.siteCG); const h = rel.dot(g.siteUp); const d = rel.addScaledVector(g.siteUp,-h).length();
    console.log(t.toFixed(0), g.phase, 'h', h.toFixed(0), 'd', (d/1000).toFixed(1), 'v', s.v.length().toFixed(0), 'vz', s.v.dot(g.siteUp).toFixed(1), 'thr', c.throttle.toFixed(2), 'eng', s.running, 'atterr', err.toFixed(1), 'tgo', g.tgo.toFixed(0), '|a|', g.aCmd.length().toFixed(1), 'm', (s.mass/1000).toFixed(0), 'w', (s.w.length()*57.3).toFixed(1)); }
}
console.log('end', t.toFixed(1), s.touchdown, s.landed, s.crashed);

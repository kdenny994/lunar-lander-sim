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
const n = Number(process.argv[2] || 3), t0 = Number(process.argv[3] || 0), t1 = Number(process.argv[4] || 900), step = Number(process.argv[5] || 1);
const s = new SSState(); descentOrbitState(s, peri, sll, 260000);
s.prop = mb.pdiMass - SS.dryMass - SS.payload - mb.residual; s.residual = mb.residual;
const g = new StarshipGuidance(siteGround, llrToVec(from.lat, from.lon, MOON.radius)); g.brakingEngines = n;
let t = 0, next = t0; const dt = 0.005;
const f = (v: Vector3) => `[${v.dot(g.uprange).toFixed(1)} ${v.dot(g.siteUp).toFixed(1)}]`;
while (t < t1 && !s.landed && !s.crashed) {
  const c = g.update(s, dt, null); stepStarship(s, c, dt, terrain); t += dt;
  if (t >= next) { next += step;
    const xb = new Vector3(1,0,0).applyQuaternion(s.q);
    const rel = s.r.clone().sub(g.siteCG);
    console.log(t.toFixed(1), g.phase, 'pos(up,h)', f(rel), 'vel', f(s.v), 'aCmd', f(g.aCmd), 'nose', f(xb), 'gate', f(g.hgPos.clone().sub(g.siteCG)), f(g.hgVel), 'tgo', g.tgo.toFixed(1), 'thr', c.throttle.toFixed(2));
  }
}
console.log('end', t.toFixed(1), JSON.stringify(s.touchdown), s.landed, s.crashed);

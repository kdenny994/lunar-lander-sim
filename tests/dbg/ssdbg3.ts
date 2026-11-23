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
const n = Number(process.argv[2] || 3), step = Number(process.argv[3] || 0.5);
const s = new SSState(); descentOrbitState(s, peri, sll, 260000);
s.prop = mb.pdiMass - SS.dryMass - SS.payload - mb.residual; s.residual = mb.residual;
const g = new StarshipGuidance(siteGround, llrToVec(from.lat, from.lon, MOON.radius)); g.brakingEngines = n;
let t = 0, next = 0; const dt = 0.005;
const cross = new Vector3().crossVectors(g.siteUp, g.uprange);
const ang = (v: Vector3) => Math.atan2(v.dot(g.uprange), v.dot(g.siteUp)) * 57.3;
const ang2 = (v: Vector3) => Math.atan2(v.dot(cross), v.dot(g.siteUp)) * 57.3;
while (t < 900 && !s.landed && !s.crashed) {
  const c = g.update(s, dt, null); stepStarship(s, c, dt, terrain); t += dt;
  if (g.phase === 'landing' && t >= next) { next = t + step;
    const xb = new Vector3(1,0,0).applyQuaternion(s.q);
    const rel = s.r.clone().sub(g.siteCG);
    console.log(t.toFixed(1), 'h', rel.dot(g.siteUp).toFixed(0), 'x', rel.dot(g.uprange).toFixed(1), 'y', rel.dot(cross).toFixed(1), 'vx', s.v.dot(g.uprange).toFixed(1), 'vy', s.v.dot(cross).toFixed(1), 'vz', s.v.dot(g.siteUp).toFixed(1),
      'tgtP', g.attTarget ? ang(g.attTarget).toFixed(1) : '-', 'noseP', ang(xb).toFixed(1), 'tgtY', g.attTarget ? ang2(g.attTarget).toFixed(1) : '-', 'noseY', ang2(xb).toFixed(1), 'thr', c.throttle.toFixed(2), 'eng', s.running, g.relightWait ? 'WAIT' : '');
  }
}
console.log('end', t.toFixed(1), JSON.stringify(s.touchdown), 'pads', s.padsDown, 'v', s.v.length().toFixed(3), 'w', s.w.length().toFixed(4), 'thr', s.thrustN.toFixed(0), 'eng', s.running, s.eng.map(x=>x.toFixed(2)).join(','));

// Headless checks of the flight model: replay consistency and a P66 landing flown by a simple pilot.
import { readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { HeightGrid, TerrainData } from '../src/sim/terrainData';
import { Replay } from '../src/sim/replay';
import { LMState, stepLM } from '../src/sim/lm';
import { DigitalAutopilot, type PilotInput } from '../src/sim/dap';
import { FT } from '../src/sim/constants';

const load = (n: string) => new HeightGrid(JSON.parse(readFileSync(`public/data/terrain/${n}.json`, 'utf8')),
  new Int16Array(readFileSync(`data-raw/terrain/${n}.bin`).buffer.slice(0)));
const terrain = new TerrainData(load('corridor'), load('site'));
const traj = JSON.parse(readFileSync('public/data/apollo11_trajectory.json', 'utf8'));
const replay = new Replay(traj, terrain);
let fails = 0;
const check = (name: string, ok: boolean, info: string) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${info}`); if (!ok) fails++; };

// 1. replay touchdown and mass
const end = replay.sample(replay.duration);
check('replay ends on the surface', Math.abs(end.r.length() - replay.siteRadius - 2.45) < 3, `${(end.r.length() - replay.siteRadius).toFixed(2)} m CG above site radius`);
check('landed mass plausible', end.mass > 6900 && end.mass < 7600, `${end.mass.toFixed(0)} kg`);

// 2. physics free-fall from rails matches rails over 2 s when thrust follows the rails (P63 at 100 s)
{
  const s0 = replay.sample(100), s1 = replay.sample(102);
  const lm = new LMState(); lm.r.copy(s0.r); lm.v.copy(s0.v); lm.q.copy(s0.q); lm.dryMass = s0.mass - s0.dpsProp - lm.rcsProp; lm.dpsProp = s0.dpsProp; lm.thrust = s0.thrust;
  for (let i = 0; i < 400; i++) {
    const s = replay.sample(100 + i * 0.005); lm.q.copy(s.q);
    stepLM(lm, { engineArmed: true, throttle: s.thrust > 0.65 ? 0.93 : s.thrust, rcsTorque: new Vector3(), rcsTranslate: new Vector3() }, 0.005, terrain);
  }
  check('physics tracks rails for 2 s in braking', lm.r.distanceTo(s1.r) < 30, `${lm.r.distanceTo(s1.r).toFixed(3)} m position error, moved ${lm.r.distanceTo(s0.r).toFixed(0)} m`);
}

// 3. P66 landing with a simple pilot: null forward speed, ROD to 3 ft/s
{
  const s0 = replay.sample(615);
  const lm = new LMState(); lm.r.copy(s0.r); lm.v.copy(s0.v); lm.q.copy(s0.q); lm.dryMass = s0.mass - s0.dpsProp - lm.rcsProp; lm.dpsProp = s0.dpsProp; lm.thrust = s0.thrust; lm.t = 615;
  const dap = new DigitalAutopilot(); dap.engage(lm); dap.throttleMode = 'p66';
  const inp: PilotInput = { pitch: 0, roll: 0, yaw: 0, throttle: 0.4, fwd: 0, right: 0, ullage: false };
  let t = 0;
  while (t < 200 && !lm.contact.touchdown) {
    const up = lm.r.clone().normalize();
    const alt = lm.altitude(terrain) - 2.45;
    // pitch to null horizontal velocity in body Z / Y
    const vb = lm.v.clone().applyQuaternion(lm.q.clone().invert());
    const xb = new Vector3(1, 0, 0).applyQuaternion(lm.q);
    const tiltZ = Math.asin(Math.max(-1, Math.min(1, new Vector3(0, 0, 1).applyQuaternion(lm.q).dot(up)))); // + when nose up/back
    const tiltY = Math.asin(Math.max(-1, Math.min(1, new Vector3(0, 1, 0).applyQuaternion(lm.q).dot(up))));
    const wantZ = Math.max(-0.25, Math.min(0.25, 0.04 * vb.z)), wantY = Math.max(-0.25, Math.min(0.25, 0.04 * vb.y));
    inp.pitch = Math.max(-1, Math.min(1, -(wantZ - tiltZ) * 6));
    inp.roll = Math.max(-1, Math.min(1, -(wantY - tiltY) * 6));
    void xb;
    const target = alt > 30 ? -3 * FT * Math.max(1, alt / 30) : -3 * FT;
    const want = Math.max(-20 * FT, target);
    while (dap.hdotCmd > want + FT / 2) dap.rodClick(-1);
    while (dap.hdotCmd < want - FT / 2) dap.rodClick(1);
    for (let k = 0; k < 10; k++) { stepLM(lm, dap.update(lm, inp, 0.005), 0.005, terrain); }
    t += 0.05;
  }
  const td = lm.contact.touchdown;
  check('P66 pilot lands', !!td && !lm.crashed, td ? `vVert ${(td.vVert / FT).toFixed(1)} ft/s, vHorz ${(td.vHorz / FT).toFixed(1)} ft/s, tilt ${td.tilt.toFixed(1)} deg at t=${td.t.toFixed(0)} s, DPS left ${lm.dpsProp.toFixed(0)} kg, contact light ${lm.contact.contactLight}` : 'no touchdown');
  // settle on the gear
  dap.engineArmed = false;
  for (let k = 0; k < 4000; k++) stepLM(lm, dap.update(lm, { ...inp, pitch: 0, roll: 0 }, 0.005), 0.005, terrain);
  check('LM settles on its gear', lm.landed || lm.v.length() < 0.2, `landed=${lm.landed} |v|=${lm.v.length().toFixed(3)} pads=${lm.contact.padsDown}`);
}
process.exit(fails ? 1 : 0);

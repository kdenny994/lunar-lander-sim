// Six-degree-of-freedom Lunar Module flight model in the Moon-fixed (rotating) frame.
import { Quaternion, Vector3 } from 'three';
import { G0, LM, MOON } from './constants';
import { gravity, vecToLLR } from './geo';
import type { TerrainData } from './terrainData';

export interface LMControls {
  engineArmed: boolean;
  throttle: number; // commanded fraction of 10,500 lbf (0..1); 0.65+ means fixed-throttle position
  /** jet couples per body axis (X yaw, Y pitch, Z roll), each in [-2, 2] */
  rcsTorque: Vector3;
  /** translation jets per body axis, each in [-1, 1] (X = +X ullage only) */
  rcsTranslate: Vector3;
}

export interface ContactState {
  contactLight: boolean;
  padsDown: number;
  touchdown: null | { vVert: number; vHorz: number; tilt: number; t: number };
}

const OMEGA = new Vector3(0, 0, MOON.omega);
const _a = new Vector3(), _b = new Vector3(), _c = new Vector3(), _d = new Vector3();
const _q = new Quaternion();

// footpads (+Z, -Z, +Y, -Y) and probe tips (no probe on +Z on Apollo 11)
const PADS: Vector3[] = [
  new Vector3(-LM.cgAboveFootpads, 0, LM.footpadRadius),
  new Vector3(-LM.cgAboveFootpads, 0, -LM.footpadRadius),
  new Vector3(-LM.cgAboveFootpads, LM.footpadRadius, 0),
  new Vector3(-LM.cgAboveFootpads, -LM.footpadRadius, 0),
];
const PROBES: Vector3[] = PADS.slice(1).map((p) => p.clone().add(new Vector3(-LM.probeLength, 0, 0)));

export class LMState {
  r = new Vector3();
  v = new Vector3();
  q = new Quaternion(); // body -> MCMF
  w = new Vector3(); // body rates rad/s
  dpsProp = LM.dpsPropPDI;
  rcsProp = LM.rcsProp;
  thrust = 0; // actual DPS thrust fraction
  dryMass = LM.massPDI - LM.dpsPropPDI - LM.rcsProp;
  t = 0;
  contact: ContactState = { contactLight: false, padsDown: 0, touchdown: null };
  landed = false;
  crashed = false;
  /** last forces for diagnostics */
  accel = new Vector3();

  get mass() { return this.dryMass + this.dpsProp + this.rcsProp; }

  inertia(out = new Vector3()) {
    const f = Math.min(1, Math.max(0, (this.mass - LM.dryLanded) / (LM.massPDI - LM.dryLanded)));
    const [a, b, c] = LM.inertiaFull, [d, e, g] = LM.inertiaLanded;
    return out.set(d + (a - d) * f, e + (b - e) * f, g + (c - g) * f);
  }

  copyFrom(o: LMState) {
    this.r.copy(o.r); this.v.copy(o.v); this.q.copy(o.q); this.w.copy(o.w);
    this.dpsProp = o.dpsProp; this.rcsProp = o.rcsProp; this.thrust = o.thrust; this.dryMass = o.dryMass; this.t = o.t;
    return this;
  }

  bodyToWorld(v: Vector3, out = new Vector3()) { return out.copy(v).applyQuaternion(this.q); }

  /** altitude of the CG above local terrain (m) */
  altitude(terrain: TerrainData) {
    const { lat, lon, r } = vecToLLR(this.r);
    return r - (MOON.radius + terrain.heightAt(lat, lon));
  }
}

/** Advance the LM state by dt seconds (use small steps, ~5 ms). */
export function stepLM(s: LMState, c: LMControls, dt: number, terrain: TerrainData) {
  if (s.landed) { s.t += dt; s.thrust = 0; s.w.set(0, 0, 0); s.v.set(0, 0, 0); return; }
  const m = s.mass;
  // --- DPS ---
  let cmd = 0;
  if (c.engineArmed && s.dpsProp > 0) {
    cmd = Math.max(LM.dpsMinThrottle, c.throttle);
    if (cmd > LM.dpsMaxThrottle) cmd = LM.dpsFTP;
  }
  s.thrust += (cmd - s.thrust) * Math.min(1, dt / LM.dpsLag);
  if (s.dpsProp <= 0) s.thrust = 0;
  const F = s.thrust * LM.dpsMaxThrust;
  s.dpsProp = Math.max(0, s.dpsProp - (F / (LM.dpsIsp * G0)) * dt);

  // --- RCS ---
  let jets = 0;
  const torque = _a.set(0, 0, 0);
  const tBody = _b.set(0, 0, 0);
  if (s.rcsProp > 0) {
    const k = 2 * LM.rcsThrust * LM.rcsArm;
    torque.set(c.rcsTorque.x * k, c.rcsTorque.y * k, c.rcsTorque.z * k);
    jets += 2 * (Math.abs(c.rcsTorque.x) + Math.abs(c.rcsTorque.y) + Math.abs(c.rcsTorque.z));
    tBody.set(Math.max(0, c.rcsTranslate.x) * 4 * LM.rcsThrust, c.rcsTranslate.y * 2 * LM.rcsThrust, c.rcsTranslate.z * 2 * LM.rcsThrust);
    jets += (Math.max(0, c.rcsTranslate.x) * 4 + Math.abs(c.rcsTranslate.y) * 2 + Math.abs(c.rcsTranslate.z) * 2);
    s.rcsProp = Math.max(0, s.rcsProp - (jets * LM.rcsThrust / (LM.rcsIsp * G0)) * dt);
  }
  tBody.x += F;

  // --- ground contact ---
  const contactF = _c.set(0, 0, 0);
  const contactT = _d.set(0, 0, 0);
  let padsDown = 0;
  for (const pad of PADS) {
    const arm = pad.clone().applyQuaternion(s.q);
    const p = arm.clone().add(s.r);
    const { lat, lon, r } = vecToLLR(p);
    const ground = MOON.radius + terrain.heightAt(lat, lon);
    const pen = ground - r;
    if (pen > 0) {
      padsDown++;
      const n = p.clone().normalize();
      const vPad = s.w.clone().applyQuaternion(s.q).cross(arm).add(s.v);
      const vn = vPad.dot(n);
      const fn = Math.max(0, 1.5e5 * pen - 3.0e4 * vn);
      const vt = vPad.clone().addScaledVector(n, -vn);
      const vtl = vt.length();
      const f = n.multiplyScalar(fn);
      if (vtl > 1e-6) f.addScaledVector(vt, (-0.6 * fn) / (vtl + 0.05));
      contactF.add(f);
      contactT.add(arm.cross(f));
    }
  }
  if (!s.contact.contactLight) {
    for (const pr of PROBES) {
      const p = pr.clone().applyQuaternion(s.q).add(s.r);
      const { lat, lon, r } = vecToLLR(p);
      if (r <= MOON.radius + terrain.heightAt(lat, lon)) { s.contact.contactLight = true; break; }
    }
  }
  if (padsDown > 0 && !s.contact.touchdown) {
    const up = s.r.clone().normalize();
    const vv = s.v.dot(up);
    const vh = s.v.clone().addScaledVector(up, -vv).length();
    const tilt = Math.acos(Math.min(1, new Vector3(1, 0, 0).applyQuaternion(s.q).dot(up))) * 180 / Math.PI;
    s.contact.touchdown = { vVert: -vv, vHorz: vh, tilt, t: s.t };
    if (-vv > 3.05 * 1.6 || vh > 1.22 * 2.5 || tilt > 18) s.crashed = true;
  }
  s.contact.padsDown = padsDown;

  // --- translational dynamics (rotating frame) ---
  const fWorld = tBody.applyQuaternion(s.q).add(contactF);
  const acc = gravity(s.r, s.accel).addScaledVector(fWorld, 1 / m);
  acc.addScaledVector(OMEGA.clone().cross(s.v), -2); // Coriolis
  acc.sub(OMEGA.clone().cross(OMEGA.clone().cross(s.r))); // centrifugal
  s.v.addScaledVector(acc, dt);
  s.r.addScaledVector(s.v, dt);

  // --- rotational dynamics (body frame) ---
  const I = s.inertia();
  const tq = torque.add(contactT.applyQuaternion(_q.copy(s.q).invert()));
  const Iw = new Vector3(I.x * s.w.x, I.y * s.w.y, I.z * s.w.z);
  const gyro = s.w.clone().cross(Iw);
  s.w.x += ((tq.x - gyro.x) / I.x) * dt;
  s.w.y += ((tq.y - gyro.y) / I.y) * dt;
  s.w.z += ((tq.z - gyro.z) / I.z) * dt;
  const wl = s.w.length();
  if (wl > 1e-12) {
    _q.setFromAxisAngle(_a.copy(s.w).divideScalar(wl), wl * dt);
    s.q.multiply(_q).normalize();
  }
  s.t += dt;

  // settle: on the ground, engine off, nearly stopped
  if (padsDown >= 3 && s.thrust < 0.02 && s.v.length() < 0.05 && s.w.length() < 0.01) s.landed = true;
}

export const LM_PADS = PADS;

// Starship HLS lunar lander: vehicle estimates, mass budget, and a 6-DOF flight model in the Moon-fixed frame.
//
// All vehicle numbers are public-domain estimates, not SpaceX data:
//  - Raptor 3 (sea-level nozzle): ~280 tf (2.75 MN) at sea level, about 2.88 MN in vacuum, Isp ~350 s in vacuum,
//    deep throttle to ~40 %, gimbal ~15 deg. Only the three inner (sea-level) engines are used, as requested.
//  - Starship HLS: 9 m diameter, ~50 m tall, dry mass ~120 t including landing legs and solar arrays (estimates
//    range 85-120 t; the high end is used), plus 10 t of crew cabin outfitting, crew and cargo.
import { Matrix4, Quaternion, Vector3 } from 'three';
import { G0, MOON } from './constants';
import { gravity, vecToLLR } from './geo';
import type { TerrainData } from './terrainData';

export const SS = {
  diameter: 9.0,
  length: 50.3,
  raptorThrustVac: 2.88e6, // N, Raptor 3 sea-level nozzle in vacuum (estimate)
  raptorIsp: 350, // s, vacuum
  minThrottle: 0.4,
  engineLag: 0.35, // s, throttle response
  engineStart: 2.0, // s, start-up to minimum throttle
  engineRadius: 1.3, // m, inner engines from the axis
  gimbalMax: 15 * Math.PI / 180,
  cgAboveEngines: 14.0, // m, gimbal plane below the CG (lightly loaded lander)
  cgAbovePads: 16.0, // m
  padRadius: 6.5, // m, six legs
  dryMass: 120000, // kg
  payload: 10000, // kg, crew cabin outfitting, crew, cargo
  residualFrac: 0.02, // unusable propellant fraction of the load
  rcsTorque: 6.0e5, // N m, attitude thrusters (engines off)
};

const MU = MOON.mu;
const R = MOON.radius;
const c = SS.raptorIsp * G0;

/** Δv and mass budget, worked backwards from a 600 km circular lunar orbit after ascent. */
export function massBudget() {
  const r600 = R + 600e3;
  const v600 = Math.sqrt(MU / r600);
  const siteR = R + 1734.5;
  // ascent: Hohmann-style from the surface to 600 km circular (no surface rotation help at the pole)
  const vSurf = Math.sqrt(MU / siteR);
  const vPeri = Math.sqrt(MU * 2 * r600 / (siteR * (siteR + r600)));
  const vApo = Math.sqrt(MU * 2 * siteR / (r600 * (siteR + r600)));
  const ascentIdeal = vPeri + (v600 - vApo); // ~1.91 km/s
  void vSurf;
  const ascentLosses = 90; // gravity and steering losses at T/W > 2
  const ascentReq = (ascentIdeal + ascentLosses) * 1.03; // 3 % reserve
  // deorbit from 600 km circular into a 600 x 15 km descent orbit
  const rp = R + 15e3;
  const vaDesc = Math.sqrt(MU * 2 * rp / (r600 * (r600 + rp)));
  const deorbit = v600 - vaDesc;
  const descentBudget = 2050; // powered descent incl. gravity losses and a terminal margin (the sim measures the real figure)
  // the unusable residual rides all the way to orbit, so it is part of the final mass (fixed-point solve)
  let residual = 0, final = 0, landedNeeded = 0, pdiMass = 0, lloMass = 0, propLoaded = 0;
  for (let i = 0; i < 20; i++) {
    final = SS.dryMass + SS.payload + residual;
    landedNeeded = final * Math.exp(ascentReq / c);
    pdiMass = landedNeeded * Math.exp(descentBudget / c);
    lloMass = pdiMass * Math.exp(deorbit / c);
    propLoaded = lloMass - SS.dryMass - SS.payload;
    residual = propLoaded * SS.residualFrac;
  }
  return {
    v600, ascentIdeal, ascentLosses, ascentReq, deorbit, descentBudget,
    final, landedNeeded, pdiMass, lloMass, propLoaded,
    residual,
    vPerilune: Math.sqrt(MU * 2 * r600 / (rp * (r600 + rp))),
  };
}

/** Δv available to ascend from the landed state. */
export function ascentDvAvailable(massNow: number, residual: number) {
  const final = SS.dryMass + SS.payload + residual;
  return massNow > final ? c * Math.log(massNow / final) : 0;
}

export interface SSControls {
  /** engines the crew/guidance wants running (0..3) */
  engines: number;
  /** throttle fraction 0.4..1 of each running engine */
  throttle: number;
  /** body torque command, N m (clamped by available authority) */
  torque: Vector3;
}

const OMEGA = new Vector3(0, 0, MOON.omega);
const PADS: Vector3[] = [];
for (let i = 0; i < 6; i++) {
  const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
  PADS.push(new Vector3(-SS.cgAbovePads, Math.cos(a) * SS.padRadius, Math.sin(a) * SS.padRadius));
}
export const SS_PADS = PADS;
/** engine positions in the body frame (gimbal points) */
export const SS_ENGINES: Vector3[] = [0, 1, 2].map((i) => {
  const a = (i / 3) * Math.PI * 2;
  return new Vector3(-SS.cgAboveEngines, Math.cos(a) * SS.engineRadius, Math.sin(a) * SS.engineRadius);
});

export class SSState {
  r = new Vector3();
  v = new Vector3();
  q = new Quaternion(); // body -> MCMF; body +X is the long axis (nose)
  w = new Vector3();
  prop = 0;
  residual = 0;
  /** per-engine thrust fraction (0 = off) and start-up timers */
  eng = [0, 0, 0];
  engStart = [0, 0, 0];
  engOn = [false, false, false];
  t = 0;
  touchdown: null | { vVert: number; vHorz: number; tilt: number; t: number } = null;
  padsDown = 0;
  landed = false;
  crashed = false;
  tipped = false;
  accel = new Vector3(); // non-gravitational, world (m/s^2)
  dvUsed = 0;

  get mass() { return SS.dryMass + SS.payload + this.prop + this.residual; }
  get thrustN() { return (this.eng[0] + this.eng[1] + this.eng[2]) * SS.raptorThrustVac; }
  get running() { return this.engOn.filter(Boolean).length; }
  inertia(out = new Vector3()) {
    const m = this.mass;
    return out.set(m * 10.1, m * 190, m * 190);
  }
  altitude(terrain: TerrainData) {
    const { lat, lon, r } = vecToLLR(this.r);
    return r - (MOON.radius + terrain.heightAt(lat, lon)) - SS.cgAbovePads;
  }
}

const _f = new Vector3(), _t = new Vector3(), _a = new Vector3(), _q = new Quaternion();

/** Max torque about a transverse axis from gimballing the running engines (N m). */
export function gimbalAuthority(s: SSState) {
  return s.thrustN * Math.sin(SS.gimbalMax * 0.6) * SS.cgAboveEngines;
}

export function stepStarship(s: SSState, c: SSControls, dt: number, terrain: TerrainData) {
  if (s.landed) { s.t += dt; s.v.set(0, 0, 0); s.w.set(0, 0, 0); s.eng = [0, 0, 0]; s.engOn = [false, false, false]; return; }
  const m = s.mass;
  // ---- engines: the first n are commanded on; start-up delay, then first-order throttle response ----
  const want = s.prop > 0 ? Math.max(0, Math.min(3, Math.round(c.engines))) : 0;
  const thr = Math.min(1, Math.max(SS.minThrottle, c.throttle));
  for (let i = 0; i < 3; i++) {
    const on = i < want;
    if (on && !s.engOn[i]) { s.engOn[i] = true; s.engStart[i] = 0; }
    if (!on) s.engOn[i] = false;
    let target = 0;
    if (s.engOn[i]) {
      s.engStart[i] += dt;
      target = s.engStart[i] < SS.engineStart ? SS.minThrottle * (s.engStart[i] / SS.engineStart) : thr;
    }
    s.eng[i] += (target - s.eng[i]) * Math.min(1, dt / SS.engineLag);
    if (!s.engOn[i] && s.eng[i] < 0.01) s.eng[i] = 0;
  }
  // net engine force: each engine gimbals so its line of action passes near the CG; axial component only
  let Fx = 0;
  for (let i = 0; i < 3; i++) {
    if (s.eng[i] <= 0) continue;
    const off = Math.atan2(SS.engineRadius, SS.cgAboveEngines);
    Fx += s.eng[i] * SS.raptorThrustVac * Math.cos(off);
  }
  const mdot = s.thrustN / (SS.raptorIsp * G0);
  s.prop = Math.max(0, s.prop - mdot * dt);
  if (s.prop <= 0) s.eng = [0, 0, 0];
  s.dvUsed += (Fx / m) * dt;

  // ---- torque: gimbal authority when engines run, attitude thrusters otherwise ----
  const auth = gimbalAuthority(s) + SS.rcsTorque;
  const tq = _t.copy(c.torque);
  tq.y = Math.max(-auth, Math.min(auth, tq.y));
  tq.z = Math.max(-auth, Math.min(auth, tq.z));
  tq.x = Math.max(-SS.rcsTorque, Math.min(SS.rcsTorque, tq.x));

  // ---- ground contact (six legs) ----
  const contactF = _a.set(0, 0, 0);
  const contactT = new Vector3();
  let padsDown = 0;
  const kS = 4.0e6, kD = 9.0e5;
  for (const pad of PADS) {
    const arm = pad.clone().applyQuaternion(s.q);
    const p = arm.clone().add(s.r);
    const { lat, lon, r } = vecToLLR(p);
    const pen = MOON.radius + terrain.heightAt(lat, lon) - r;
    if (pen > 0) {
      padsDown++;
      const n = p.clone().normalize();
      const vPad = s.w.clone().applyQuaternion(s.q).cross(arm).add(s.v);
      const vn = vPad.dot(n);
      const fn = Math.max(0, kS * pen - kD * vn);
      const vt = vPad.clone().addScaledVector(n, -vn);
      const vtl = vt.length();
      const f = n.multiplyScalar(fn);
      if (vtl > 1e-6) f.addScaledVector(vt, (-0.6 * fn) / (vtl + 0.05));
      contactF.add(f);
      contactT.add(arm.cross(f));
    }
  }
  const up = s.r.clone().normalize();
  if (padsDown > 0 && !s.touchdown) {
    const vv = s.v.dot(up);
    const vh = s.v.clone().addScaledVector(up, -vv).length();
    const tilt = Math.acos(Math.min(1, new Vector3(1, 0, 0).applyQuaternion(s.q).dot(up))) * 180 / Math.PI;
    s.touchdown = { vVert: -vv, vHorz: vh, tilt, t: s.t };
    if (-vv > 4.0 || vh > 2.0 || tilt > 12) s.crashed = true;
  }
  s.padsDown = padsDown;

  // ---- translation (rotating frame) ----
  _f.set(Fx, 0, 0).applyQuaternion(s.q);
  s.accel.copy(_f).add(contactF).divideScalar(m);
  const acc = gravity(s.r, new Vector3()).addScaledVector(_f.add(contactF), 1 / m);
  acc.addScaledVector(OMEGA.clone().cross(s.v), -2);
  acc.sub(OMEGA.clone().cross(OMEGA.clone().cross(s.r)));
  s.v.addScaledVector(acc, dt);
  s.r.addScaledVector(s.v, dt);

  // ---- rotation ----
  const I = s.inertia();
  const T = tq.add(contactT.applyQuaternion(_q.copy(s.q).invert()));
  const Iw = new Vector3(I.x * s.w.x, I.y * s.w.y, I.z * s.w.z);
  const gyro = s.w.clone().cross(Iw);
  s.w.x += ((T.x - gyro.x) / I.x) * dt;
  s.w.y += ((T.y - gyro.y) / I.y) * dt;
  s.w.z += ((T.z - gyro.z) / I.z) * dt;
  const wl = s.w.length();
  if (wl > 1e-12) { _q.setFromAxisAngle(_t.copy(s.w).divideScalar(wl), wl * dt); s.q.multiply(_q).normalize(); }
  s.t += dt;

  const tiltNow = Math.acos(Math.min(1, new Vector3(1, 0, 0).applyQuaternion(s.q).dot(up))) * 180 / Math.PI;
  if (padsDown > 0 && tiltNow > 22) { s.tipped = true; s.crashed = true; }
  if (padsDown >= 3 && s.thrustN < 1 && s.v.length() < 0.03 && s.w.length() < 0.005) s.landed = true;
}

/** Initial state: coasting on the 600 x 15 km polar descent orbit, `before` metres of arc ahead of perilune. */
export function descentOrbitState(s: SSState, periLatLon: { lat: number; lon: number }, towardLatLon: { lat: number; lon: number }, arcBefore: number) {
  const ra = R + 600e3, rp = R + 15e3;
  const a = (ra + rp) / 2, e = (ra - rp) / (ra + rp);
  const p = a * (1 - e * e);
  const toVec = (ll: { lat: number; lon: number }) => {
    const la = ll.lat * Math.PI / 180, lo = ll.lon * Math.PI / 180;
    return new Vector3(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la));
  };
  const e1 = toVec(periLatLon);
  const tw = toVec(towardLatLon);
  const h = new Vector3().crossVectors(e1, tw).normalize(); // orbit normal (motion from e1 toward tw)
  const e2 = new Vector3().crossVectors(h, e1);
  const nu = -arcBefore / rp;
  const r = p / (1 + e * Math.cos(nu));
  const rv = e1.clone().multiplyScalar(Math.cos(nu)).addScaledVector(e2, Math.sin(nu)).multiplyScalar(r);
  const k = Math.sqrt(MU / p);
  const vv = e1.clone().multiplyScalar(-Math.sin(nu) * k).addScaledVector(e2, (e + Math.cos(nu)) * k);
  // to the rotating Moon-fixed frame
  vv.sub(OMEGA.clone().cross(rv));
  s.r.copy(rv); s.v.copy(vv);
  // attitude: engines forward (retrograde), "up" toward the surface normal
  const fwd = vv.clone().normalize().negate();
  const upv = rv.clone().normalize();
  const z = new Vector3().crossVectors(fwd, upv).normalize();
  const y = new Vector3().crossVectors(z, fwd);
  s.q.setFromRotationMatrix(new Matrix4().makeBasis(fwd, y, z));
  s.w.set(0, 0, 0);
}

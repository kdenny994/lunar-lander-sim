// Predicted touchdown point for Starship in manual flight: a fast point-mass propagation of the current state with
// the crew's present settings held (attitude, engine count, throttle or the hoverslam autothrottle), until the
// pads reach the terrain. Moon rotation is ignored over these few minutes (Coriolis shifts the point < 1 m/min).
import { Vector3 } from 'three';
import { MOON } from './constants';
import { vecToLLR } from './geo';
import { SS, type SSState } from './starship';
import type { TerrainData } from './terrainData';

export interface SSPredictOptions {
  /** engines commanded on (0 = cut off) */
  engines: number;
  /** fixed throttle 0.4..1, or null for the hoverslam autothrottle (reach 1 m/s at the pads) */
  throttle: number | null;
}

export interface SSPrediction {
  lat: number; lon: number;
  /** touchdown point on the ground (Moon-fixed, m) */
  pos: Vector3;
  /** seconds from now */
  t: number;
  vVert: number; vHorz: number;
}

const G_MU = MOON.mu;
const G_MOON = 1.62;

/**
 * Hoverslam autothrottle used in manual flight. Raptors cannot throttle below 40 %, which on the Moon is more than the
 * landed ship weighs, so it cannot hover: like the guidance it holds the engines off until the braking need (after
 * their start-up time) reaches what minimum thrust gives, then brakes so the pads arrive at 1 m/s.
 * Returns whether the engines should be lit and the thrust acceleration wanted (m/s^2).
 */
export function hoverslam(h: number, vz: number, cosT: number, aMax: number, lit: boolean): { on: boolean; accel: number } {
  const aMin = aMax * SS.minThrottle;
  const need = Math.max(0, (vz * vz - 1) / (2 * Math.max(0.3, h + 0.5))) + G_MOON;
  const cos = Math.max(0.3, cosT);
  let on = lit;
  if (lit) {
    if ((h > 150 && need < 0.6 * aMin * cos) || (h > 3 && vz > 0)) on = false; // hysteresis vs. the light-up test below
  } else {
    const tS = SS.engineStart + 0.5;
    const h2 = h + vz * tS - 0.5 * G_MOON * tS * tS, vz2 = vz - G_MOON * tS;
    const need2 = h2 > 0.3 ? (vz2 * vz2 - 1) / (2 * (h2 + 0.5)) + G_MOON : Infinity;
    if (vz < 0 && (need2 >= aMin * cos || h2 < 8)) on = true;
  }
  return { on, accel: Math.min(aMax, Math.max(aMin, need / cos)) };
}

export function predictTouchdown(s: SSState, o: SSPredictOptions, terrain: TerrainData, maxT = 900): SSPrediction | null {
  const r = s.r.clone(), v = s.v.clone();
  const xb = new Vector3(1, 0, 0).applyQuaternion(s.q); // attitude held
  const m = s.mass;
  const n = Math.max(0, Math.min(3, o.engines));
  // engines not yet at minimum thrust come in after the rest of their start sequence
  let tOn = s.running > 0 ? 0 : Infinity;
  if (n > 0 && s.running > 0) for (let i = 0; i < n; i++) {
    const ph = s.engPhase[i];
    const left = ph === 'run' ? 0 : ph === 'start' ? SS.engineStart - s.engStart[i] : SS.engineStart + (ph === 'shutdown' ? 0.7 : 0);
    tOn = Math.max(tOn === Infinity ? 0 : tOn, left);
  }
  if (o.throttle !== null && n > 0 && tOn === Infinity) tOn = SS.engineStart; // fixed throttle: engines start now
  const aMax = (n * SS.raptorThrustVac) / m;
  const up = new Vector3(), acc = new Vector3();
  let t = 0;
  let lit = s.running > 0;
  for (let k = 0; k < 6000 && t < maxT; k++) {
    up.copy(r).normalize();
    const { lat, lon, r: rr } = vecToLLR(r);
    const h = rr - (MOON.radius + terrain.heightAt(lat, lon)) - SS.cgAbovePads;
    const vz = v.dot(up);
    if (h <= 0) {
      return { lat, lon, pos: r.clone().setLength(MOON.radius + terrain.heightAt(lat, lon)), t, vVert: -vz, vHorz: v.clone().addScaledVector(up, -vz).length() };
    }
    if (vz > 0 && h > 60000) return null; // climbing away: no touchdown with these settings
    let aT = 0;
    if (n > 0) {
      if (o.throttle === null) {
        const hs = hoverslam(h, vz, xb.dot(up), aMax, lit);
        if (hs.on && !lit) tOn = t + SS.engineStart; // a fresh start: thrust after the start sequence
        if (!hs.on && lit) tOn = Infinity;
        lit = hs.on;
        if (lit && t >= tOn) aT = hs.accel;
      } else if (t >= tOn) aT = aMax * Math.min(1, Math.max(SS.minThrottle, o.throttle));
    }
    const dt = Math.min(0.5, Math.max(0.02, h / Math.max(1, -vz) / 25));
    acc.copy(r).multiplyScalar(-G_MU / Math.pow(r.length(), 3)).addScaledVector(xb, aT);
    v.addScaledVector(acc, dt);
    r.addScaledVector(v, dt);
    t += dt;
  }
  return null;
}

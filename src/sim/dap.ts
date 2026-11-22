// LM digital autopilot: rate-command / attitude-hold via RCS jets, and P66 rate-of-descent throttle.
import { Quaternion, Vector3 } from 'three';
import { FT, LM, MOON } from './constants';
import { gravity } from './geo';
import type { LMControls, LMState } from './lm';

const D2R = Math.PI / 180;

export type ThrottleMode = 'manual' | 'p66';

export interface PilotInput {
  /** ACA deflections in [-1, 1]: pitch forward +, roll right +, yaw right + */
  pitch: number; roll: number; yaw: number;
  /** manual throttle lever 0..1 (fraction of 10,500 lbf) */
  throttle: number;
  /** TTCA translation: forward +, right + ; ullage (+X) */
  fwd: number; right: number; ullage: boolean;
}

export class DigitalAutopilot {
  throttleMode: ThrottleMode = 'p66';
  maxRate = 20 * D2R; // ACA full deflection (normal scaling)
  hdotCmd = 0; // m/s, P66 commanded altitude rate
  engineArmed = true;
  private hold: Quaternion | null = null;
  private firing = new Vector3();

  readonly controls: LMControls = {
    engineArmed: true, throttle: 0.4, rcsTorque: new Vector3(), rcsTranslate: new Vector3(),
  };

  /** ROD switch: each click changes the commanded descent rate by 1 ft/s (down = more descent). */
  rodClick(dir: 1 | -1) { this.hdotCmd += dir * FT; }

  engage(s: LMState) {
    const up = s.r.clone().normalize();
    this.hdotCmd = Math.round(s.v.dot(up) / FT) * FT;
    this.hold = s.q.clone();
  }

  update(s: LMState, inp: PilotInput, dt: number): LMControls {
    const c = this.controls;
    c.engineArmed = this.engineArmed;
    // ---- attitude: rate command with attitude hold ----
    const shape = (x: number) => Math.sign(x) * (0.35 * Math.abs(x) + 0.65 * x * x);
    const dz = (x: number) => (Math.abs(x) < 0.06 ? 0 : (x - Math.sign(x) * 0.06) / 0.94);
    const p = dz(inp.pitch), r = dz(inp.roll), y = dz(inp.yaw);
    const wCmd = new Vector3(-shape(y) * this.maxRate, -shape(p) * this.maxRate, shape(r) * this.maxRate);
    if (y !== 0 || p !== 0 || r !== 0 || !this.hold) {
      this.hold = s.q.clone();
    } else {
      // attitude error in body frame -> rate command
      const qe = this.hold.clone().premultiply(s.q.clone().invert()); // body-frame error rotation
      if (qe.w < 0) { qe.x = -qe.x; qe.y = -qe.y; qe.z = -qe.z; qe.w = -qe.w; }
      const err = new Vector3(qe.x, qe.y, qe.z).multiplyScalar(2);
      wCmd.copy(err.multiplyScalar(0.6)).clampLength(0, 4 * D2R);
    }
    const e = wCmd.sub(s.w);
    const tq = c.rcsTorque;
    for (const ax of ['x', 'y', 'z'] as const) {
      const ea = e[ax];
      const on = this.firing[ax] !== 0 ? Math.abs(ea) > 0.03 * D2R && Math.sign(ea) === Math.sign(this.firing[ax])
        : Math.abs(ea) > 0.25 * D2R;
      const n = on ? Math.sign(ea) * (Math.abs(ea) > 2 * D2R ? 2 : 1) : 0;
      this.firing[ax] = n;
      tq[ax] = n;
    }
    c.rcsTranslate.set(inp.ullage ? 1 : 0, inp.right, inp.fwd);

    // ---- throttle ----
    if (this.throttleMode === 'manual') {
      c.throttle = inp.throttle;
    } else {
      const up = s.r.clone().normalize();
      const hdot = s.v.dot(up);
      const xb = new Vector3(1, 0, 0).applyQuaternion(s.q);
      const cosT = Math.max(0.3, xb.dot(up));
      const g = -gravity(s.r).dot(up) - MOON.omega * MOON.omega * s.r.length(); // effective
      const aV = Math.max(-1.0, Math.min(1.5, 0.6 * (this.hdotCmd - hdot)));
      c.throttle = Math.min(LM.dpsMaxThrottle, Math.max(LM.dpsMinThrottle, (s.mass * (g + aV)) / cosT / LM.dpsMaxThrust));
    }
    void dt;
    return c;
  }
}

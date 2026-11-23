// Starship landing guidance.
//
// Two powered phases, shaped by what a Raptor can and cannot do:
//  - BRAKING on the selected 1, 2 or 3 engines: zero-effort-miss / zero-effort-velocity guidance
//        a = 6 ZEM / t^2 - 2 ZEV / t,  ZEM = r_f - (r + v t + g t^2 / 2),  ZEV = v_f - (v + g t)
//    (the closed-form energy-optimal law for a uniform field), with t_go re-solved every cycle from a constant
//    along-track deceleration, aimed at a gate straight above the pad. Ignition is timed so the braking runs
//    near 78 % of full thrust of the chosen engines, which keeps gravity losses low.
//  - LANDING BURN on one engine: a Raptor cannot throttle below 40 %, so even one engine pushes a landed-mass
//    Starship at roughly three times lunar gravity and the ship can never hover. The landing is therefore a
//    "hoverslam": the gate's sink rate is chosen so a constant deceleration on one engine reaches 1 m/s exactly
//    at the pads. Every cycle the vertical command is the constant deceleration still needed,
//        a_v = (v_z^2 - v_f^2) / 2h + g,
//    and drift is nulled by a tilt-limited velocity/position loop that leads the attitude lag. If the ship
//    is ever slower than the hoverslam needs (it would stop in mid-air and climb), the engine is cut and
//    relit when the predicted need after start-up reaches the design value.
import { Quaternion, Vector3 } from 'three';
import { MOON } from './constants';
import { gravity } from './geo';
import { SS, type SSControls, type SSState } from './starship';

export type SSPhase = 'coast' | 'braking' | 'landing' | 'touchdown';

const D2R = Math.PI / 180;
const OFF = Math.cos(Math.atan2(SS.engineRadius, SS.cgAboveEngines));

function zemzev(t: number, r: Vector3, v: Vector3, rf: Vector3, vf: Vector3, g: Vector3, out: Vector3) {
  const zem = rf.clone().sub(r).addScaledVector(v, -t).addScaledVector(g, -0.5 * t * t);
  const zev = vf.clone().sub(v).addScaledVector(g, -t);
  return out.copy(zem).multiplyScalar(6 / (t * t)).addScaledVector(zev, -2 / t);
}

/**
 * Horizontal velocity the ship sheds while it pitches its thrust axis from `theta0` (rad from vertical) up to
 * vertical: bang-bang rotation at the gimbal's angular acceleration, rate-capped like the attitude loop.
 * The braking engines run until the last 40 deg (accel), then the landing engine alone (accelLate).
 */
function pitchUpDv(theta0: number, alpha: number, alphaLate: number, accel: number, accelLate: number, wMax = 15 * D2R) {
  let th = theta0, w = 0, dv = 0, t = 0;
  const dt = 0.05;
  while (th > 2 * D2R && t < 30) {
    const al = th > 40 * D2R ? alpha : alphaLate;
    const stop = (w * w) / (2 * alphaLate);
    w = stop >= th ? Math.max(0, w - al * dt) : Math.min(wMax, w + al * dt);
    th -= w * dt;
    dv += (th > 40 * D2R ? accel : accelLate) * Math.sin(th) * dt;
    t += dt;
  }
  return { dv, t };
}

export class StarshipGuidance {
  phase: SSPhase = 'coast';
  /** engines for braking (crew choice at startup or in flight) */
  brakingEngines = 3;
  /** engines for the landing burn (1 keeps the minimum thrust lowest) */
  landingEngines = 1;
  /** gate height above the landing CG, m */
  static readonly GATE_H = 1500;
  /** touchdown sink rate, m/s */
  static readonly VF = 1.0;
  tgo = 0;
  aCmd = new Vector3();
  throttle = 0.4;
  engines = 0;
  readonly siteCG = new Vector3();
  readonly siteUp = new Vector3();
  readonly uprange = new Vector3();
  readonly hgPos = new Vector3();
  readonly hgVel = new Vector3();
  readonly controls: SSControls = { engines: 0, throttle: 0.4, torque: new Vector3() };
  /** desired body +X direction (world); null = hold current attitude */
  attTarget: Vector3 | null = null;
  /** landing burn: engine cut because the ship was too slow for a hoverslam; waiting to relight */
  relightWait = false;
  /** landing burn, first part: pitching the hull up to vertical on the braking engines */
  pitching = false;
  /** throttle held during the pitch-up */
  static readonly PITCH_THROTTLE = 0.6;
  status = '';

  /** how far the landing point has been moved downrange because the selected engines cannot stop in time, m */
  landLong = 0;
  /** surface radius under a point (m from the Moon's centre); lets the guidance re-target downrange */
  groundRadius: ((p: Vector3) => number) | null = null;

  constructor(siteGround: Vector3, approachFrom: Vector3) {
    this.siteUp.copy(siteGround).normalize();
    this.siteCG.copy(siteGround).addScaledVector(this.siteUp, SS.cgAbovePads);
    // uprange: horizontal direction from the site back toward where the ship comes from
    const d = approachFrom.clone().sub(siteGround);
    this.uprange.copy(d).addScaledVector(this.siteUp, -d.dot(this.siteUp)).normalize();
  }

  aMax(s: SSState, n: number) { return (n * SS.raptorThrustVac * OFF) / s.mass; }
  aMin(s: SSState, n: number) { return (n * SS.raptorThrustVac * OFF * SS.minThrottle) / s.mass; }

  /** acceleration the landing burn is designed to hold: well above the engine minimum, short of the maximum */
  landingAccel(s: SSState, n: number, mass = s.mass) {
    const aMax = (n * SS.raptorThrustVac * OFF) / mass, aMin = aMax * SS.minThrottle;
    return Math.min(0.85 * aMax, Math.max(1.35 * aMin, 0.6 * aMax));
  }

  /** Engage on an arbitrary state (e.g. after manual flight), choosing the phase from where the ship is. */
  resume(s: SSState) {
    const rel = s.r.clone().sub(this.siteCG);
    const h = rel.dot(this.siteUp);
    const d = rel.addScaledVector(this.siteUp, -h).length();
    const vh = s.v.clone().addScaledVector(this.siteUp, -s.v.dot(this.siteUp)).length();
    this.relightWait = false; this.pitching = false;
    this.phase = s.running === 0 && h > 8000 ? 'coast' : (d > 1500 || vh > 60 || h > 4000) ? 'braking' : 'landing';
  }

  /** horizontal and vertical parts of a vector relative to the site frame */
  private split(v: Vector3) {
    const vz = v.dot(this.siteUp);
    const vh = v.clone().addScaledVector(this.siteUp, -vz);
    return { vz, vh };
  }

  /**
   * Horizontal position and velocity predicted over the time the ship needs to turn its thrust to a new
   * direction (lead compensation): the current thrust keeps acting until the hull has rotated.
   */
  private leadState(s: SSState, rel: Vector3) {
    const xb = new Vector3(1, 0, 0).applyQuaternion(s.q);
    const err = this.attTarget ? Math.acos(Math.max(-1, Math.min(1, xb.dot(this.attTarget)))) : 0;
    const tau = Math.min(2.5, 0.4 + (err / (15 * D2R)) * 0.5);
    const { vh: aH } = this.split(s.accel);
    const { vh: rh } = this.split(rel);
    const { vh: vhv } = this.split(s.v);
    rh.addScaledVector(vhv, tau).addScaledVector(aH, 0.5 * tau * tau);
    vhv.addScaledVector(aH, tau);
    return { rh, vhv };
  }

  /** Gate: straight above the pad, no drift, sinking at the rate a constant-deceleration landing burn needs. */
  private gate(s: SSState, nLand: number) {
    const aNet = Math.max(0.5, this.landingAccel(s, nLand, s.mass * 0.95) - 1.62);
    const H = StarshipGuidance.GATE_H, vf = StarshipGuidance.VF;
    this.hgPos.copy(this.siteCG).addScaledVector(this.siteUp, H);
    this.hgVel.copy(this.siteUp).multiplyScalar(-Math.sqrt(2 * aNet * H + vf * vf));
  }

  update(s: SSState, dt: number, engineOverride: number | null): SSControls {
    void dt;
    const c = this.controls;
    const g = gravity(s.r, new Vector3());
    const rel = s.r.clone().sub(this.siteCG);
    const { vz: h } = this.split(rel);

    if (s.touchdown || s.landed) {
      this.phase = 'touchdown'; c.engines = 0; c.throttle = SS.minThrottle; this.attTarget = null; this.engines = 0;
      this.status = 'TOUCHDOWN · engines cut by leg sensors';
      return this.attitude(s, c);
    }
    const nLand = engineOverride ?? this.landingEngines;
    if (this.phase === 'coast' || this.phase === 'braking') this.gate(s, nLand);

    const toGate = this.hgPos.clone().sub(s.r);
    const { vh: dH } = this.split(toGate);
    const { vh: vH } = this.split(s.v);
    const dist = dH.length(), vh = vH.length();

    if (this.phase === 'coast') {
      const n = engineOverride ?? this.brakingEngines;
      const aReq = (vh * vh) / (2 * Math.max(1, dist - vh * SS.engineStart));
      const aCap = this.aMax(s, n) * 0.78;
      this.tgo = Math.max(0, (dist - (vh * vh) / (2 * aCap)) / Math.max(vh, 1) - SS.engineStart);
      this.status = `COAST · ignition in ${this.tgo.toFixed(0)} s`;
      zemzev(Math.max(30, (2 * dist) / Math.max(1, vh)), s.r, s.v, this.hgPos, this.hgVel, g, this.aCmd);
      this.attTarget = this.aCmd.clone().normalize();
      if (aReq >= aCap) this.phase = 'braking';
      c.engines = 0; this.engines = 0;
      return this.attitude(s, c);
    }

    let n: number;
    if (this.phase === 'braking') {
      n = engineOverride ?? this.brakingEngines;
      // more engines than the remaining braking needs: even at 40 % they would stop the ship short, so shut
      // down and coast to a later ignition point
      if (dist > 5000 && s.running > 0 && (vh * vh) / (2 * dist) < 0.9 * this.aMin(s, n)) {
        this.phase = 'coast';
        c.engines = 0; this.engines = 0;
        return this.attitude(s, c);
      }
      // fewer engines than the braking needs: the ship cannot stop at the site, so move the landing point
      // downrange to where the selected engines can stop it ("landing long")
      const aCap = 0.85 * this.aMax(s, n);
      if (this.groundRadius && dist > 1500 && (vh * vh) / (2 * dist) > aCap) {
        const shift = (vh * vh) / (2 * aCap) - dist;
        const p = this.siteCG.clone().addScaledVector(this.uprange, -shift);
        const ground = p.clone().setLength(this.groundRadius(p));
        this.siteUp.copy(ground).normalize();
        this.siteCG.copy(ground).addScaledVector(this.siteUp, SS.cgAbovePads);
        this.uprange.addScaledVector(this.siteUp, -this.uprange.dot(this.siteUp)).normalize();
        this.landLong += shift;
        this.gate(s, nLand);
      }
      this.tgo = Math.max(2, (2 * dist) / Math.max(1, vh));
      zemzev(this.tgo, s.r, s.v, this.hgPos, this.hgVel, g, this.aCmd);
      // Pitch-up point: the 50 m hull turns slowly (the gimbal gives a few deg/s^2), and the engines keep
      // braking while it turns. Start the pitch-up when the speed it will shed equals the drift that is left.
      const xb = new Vector3(1, 0, 0).applyQuaternion(s.q);
      const theta0 = Math.acos(Math.max(-1, Math.min(1, xb.dot(this.siteUp))));
      const thrN = n * SS.raptorThrustVac * StarshipGuidance.PITCH_THROTTLE;
      const thrL = nLand * SS.raptorThrustVac * StarshipGuidance.PITCH_THROTTLE;
      const arm = Math.sin(SS.gimbalMax * 0.6) * SS.cgAboveEngines, Iy = s.inertia().y;
      const pu = pitchUpDv(theta0, (thrN * arm + SS.rcsTorque) / Iy, (thrL * arm + SS.rcsTorque) / Iy, (thrN * OFF) / s.mass, (thrL * OFF) / s.mass);
      if (vh < pu.dv || this.tgo < 3 || dist < 5) { this.phase = 'landing'; this.relightWait = false; this.pitching = true; }
    } else {
      // ---- landing burn ----
      if (this.pitching) {
        const xb = new Vector3(1, 0, 0).applyQuaternion(s.q);
        if (xb.dot(this.siteUp) > Math.cos(12 * D2R) && s.w.length() < 2 * D2R) this.pitching = false;
      }
      if (this.pitching) {
        // turn on the braking engines (more gimbal authority), drop to the landing engine for the last 40 deg
        // so the near-vertical thrust does not stop the sink before the hoverslam
        const xb = new Vector3(1, 0, 0).applyQuaternion(s.q);
        n = xb.dot(this.siteUp) < Math.cos(40 * D2R) ? (engineOverride ?? this.brakingEngines) : nLand;
        this.engines = n; c.engines = n; c.throttle = StarshipGuidance.PITCH_THROTTLE; this.throttle = c.throttle;
        // in the last 30 deg, aim a little off vertical to trim the drift that is left (at most 10 deg)
        const tgt = this.siteUp.clone();
        if (xb.dot(this.siteUp) > Math.cos(30 * D2R)) {
          const { rh, vhv } = this.leadState(s, rel);
          const trim = vhv.multiplyScalar(-0.4).addScaledVector(rh, -0.02).multiplyScalar(1 / Math.max(1, this.aMax(s, n) * c.throttle));
          if (trim.length() > Math.tan(10 * D2R)) trim.setLength(Math.tan(10 * D2R));
          tgt.add(trim).normalize();
        }
        this.attTarget = tgt;
        this.aCmd.copy(tgt).multiplyScalar(this.aMax(s, n) * c.throttle);
        this.status = `PITCH-UP · ${n} engine${n > 1 ? 's' : ''}`;
        return this.attitude(s, c);
      }
      n = nLand;
      const vf = StarshipGuidance.VF;
      const { vz } = this.split(s.v);
      // aim 0.5 m below the surveyed pad height so the legs always find the ground (they stroke to absorb it)
      const hh = Math.max(0.05, h + 0.5);
      this.tgo = Math.max(0.4, (2 * hh) / Math.max(0.5, -vz + vf));
      const av = Math.max(0, (vz * vz - vf * vf) / (2 * hh)) + 1.62;
      // cut and relight if the ship is too slow for the hoverslam (it cannot hover, and pinned at minimum throttle
      // it has no margin left), coasting until the need has built back up to the design value
      const aDesign = this.landingAccel(s, n);
      if (s.running > 0 && !this.relightWait && ((h > 150 && av < 0.85 * aDesign) || (h > 3 && vz > 0))) this.relightWait = true;
      if (this.relightWait) {
        const tS = SS.engineStart + 0.5;
        const h2 = h + vz * tS - 0.81 * tS * tS, v2 = vz - 1.62 * tS;
        const need2 = h2 > 0.5 ? Math.max(0, (v2 * v2 - vf * vf) / (2 * h2)) + 1.62 : 99;
        if (need2 >= aDesign || h2 < 8) this.relightWait = false;
      }
      // drift: velocity/position loop on the lead-predicted state, tilt limited (25 deg high, 8 deg at the pads)
      const { rh, vhv } = this.leadState(s, rel);
      // position gain fades out over the last 150 m so the final metres only null velocity
      const kp = 0.035 * Math.min(1, Math.max(0, (h - 20) / 130));
      const ah = vhv.multiplyScalar(-0.4).addScaledVector(rh, -kp);
      const tiltLim = 8 + 17 * Math.min(1, Math.max(0, h / 600));
      const lim = av * Math.tan(tiltLim * D2R);
      if (ah.length() > lim) ah.setLength(lim);
      this.aCmd.copy(this.siteUp).multiplyScalar(av).add(ah);
      if (this.relightWait) {
        this.engines = 0; c.engines = 0; c.throttle = SS.minThrottle;
        // only the attitude thrusters steer now: lean (at most 10 deg) toward the drift correction so the
        // engine pushes the right way the moment it relights
        const pre = ah.clone();
        const pl = av * Math.tan(10 * D2R);
        if (pre.length() > pl) pre.setLength(pl);
        this.attTarget = this.siteUp.clone().multiplyScalar(av).add(pre).normalize();
        this.status = 'LANDING · engine off, relight for the hoverslam';
        return this.attitude(s, c);
      }
    }
    this.engines = n;
    const aMax = this.aMax(s, Math.max(1, n));
    const aMag = this.aCmd.length();
    c.engines = n;
    c.throttle = Math.min(1, Math.max(SS.minThrottle, aMag / aMax));
    this.throttle = c.throttle;
    this.attTarget = aMag > 0.1 ? this.aCmd.clone().normalize() : this.siteUp.clone();
    this.status = `${this.phase === 'braking' ? 'BRAKING' : 'LANDING BURN'} · t_go ${this.tgo.toFixed(0)} s${this.landLong > 50 ? ` · landing ${(this.landLong / 1000).toFixed(1)} km long` : ''}`;
    return this.attitude(s, c);
  }

  /** Attitude control: point body +X at attTarget (shortest rotation), damp roll. */
  attitude(s: SSState, c: SSControls, rateCmdBody?: Vector3) {
    const I = s.inertia();
    const wCmd = new Vector3();
    if (rateCmdBody) wCmd.copy(rateCmdBody);
    else if (this.attTarget) {
      const xb = new Vector3(1, 0, 0).applyQuaternion(s.q);
      const axis = new Vector3().crossVectors(xb, this.attTarget);
      const sinA = axis.length(), cosA = xb.dot(this.attTarget);
      const ang = Math.atan2(sinA, cosA);
      if (sinA > 1e-9) axis.divideScalar(sinA); else axis.set(0, 0, 0);
      const errBody = axis.multiplyScalar(ang).applyQuaternion(s.q.clone().invert());
      const wMax = 15 * D2R;
      wCmd.copy(errBody).multiplyScalar(1.0);
      if (wCmd.length() > wMax) wCmd.setLength(wMax);
      wCmd.x = 0;
    }
    const k = 3.0;
    c.torque.set(I.x * k * (wCmd.x - s.w.x), I.y * k * (wCmd.y - s.w.y), I.z * k * (wCmd.z - s.w.z));
    return c;
  }
}

/** Pilot attitude hold for manual flight: rate command, attitude hold when the stick is centred. */
export class SSManualAP {
  private hold: Quaternion | null = null;
  rateFull = 6 * D2R;
  update(s: SSState, g: StarshipGuidance, c: SSControls, pitch: number, yaw: number, roll: number) {
    const stick = Math.abs(pitch) + Math.abs(yaw) + Math.abs(roll) > 0.02;
    if (stick || !this.hold) {
      this.hold = s.q.clone();
      // body axes: +X nose, +Y and +Z transverse. Pitch about +Y, yaw about +Z, roll about +X.
      return g.attitude(s, c, new Vector3(roll * this.rateFull * 0.5, -pitch * this.rateFull, yaw * this.rateFull));
    }
    const dq = this.hold.clone().multiply(s.q.clone().invert()); // world-frame error
    const qb = s.q.clone().invert().multiply(dq).multiply(s.q); // body frame
    const ang = 2 * Math.acos(Math.min(1, Math.abs(qb.w)));
    const sgn = qb.w < 0 ? -1 : 1;
    const ax = new Vector3(qb.x, qb.y, qb.z);
    if (ax.lengthSq() > 1e-12) ax.normalize().multiplyScalar(ang * sgn); else ax.set(0, 0, 0);
    return g.attitude(s, c, ax.multiplyScalar(0.8));
  }
  reset() { this.hold = null; }
}

export { MOON };

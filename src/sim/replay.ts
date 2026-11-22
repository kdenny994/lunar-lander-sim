// On-rails Apollo 11 replay built from the reconstructed descent profile.
import { Quaternion, Vector3, Matrix4 } from 'three';
import { FT, G0, LM, MOON } from './constants';
import { destination, enu, gravity, llrToVec } from './geo';
import type { TerrainData } from './terrainData';

export interface TrajectoryFile {
  pdiGET: string; dt: number; t: number[]; d: number[]; h: number[]; theta: (number | null)[]; tP66: number;
  events: { get: string; tfi: number; label: string }[];
  landing: { lat: number; lon: number };
  approachAzimuthDeg: number;
  sources: string[];
}

export interface ReplaySample {
  t: number; r: Vector3; v: Vector3; q: Quaternion; thrust: number; mass: number; dpsProp: number;
  program: string; downrange: number;
}

const D2R = Math.PI / 180;
const OMEGA = new Vector3(0, 0, MOON.omega);

export class Replay {
  readonly n: number;
  readonly dt: number;
  readonly duration: number;
  readonly siteRadius: number;
  private r: Vector3[] = [];
  private v: Vector3[] = [];
  private q: Quaternion[] = [];
  private thr: number[] = [];
  private m: number[] = [];

  constructor(readonly file: TrajectoryFile, terrain: TerrainData) {
    const { landing } = file;
    this.dt = file.dt;
    this.n = file.t.length;
    this.duration = file.t[this.n - 1];
    // altitude reference: the guidance altitude is above the landing-site radius
    const siteH = terrain.heightAt(landing.lat, landing.lon);
    this.siteRadius = MOON.radius + siteH;
    // the TM's final altitude ends at the footpads ~ on the surface; CG sits cgAboveFootpads higher
    const backAz = (file.approachAzimuthDeg + 180) % 360; // from the site back up-track
    for (let i = 0; i < this.n; i++) {
      const ang = file.d[i] / this.siteRadius;
      const p = destination(landing.lat, landing.lon, backAz, ang);
      this.r.push(llrToVec(p.lat, p.lon, this.siteRadius + file.h[i] + LM.cgAboveFootpads));
    }
    // velocities (central differences)
    for (let i = 0; i < this.n; i++) {
      const a = this.r[Math.max(0, i - 1)], b = this.r[Math.min(this.n - 1, i + 1)];
      const span = (Math.min(this.n - 1, i + 1) - Math.max(0, i - 1)) * this.dt;
      this.v.push(b.clone().sub(a).divideScalar(span));
    }
    // thrust acceleration, smoothed over +-1 s
    const aT: Vector3[] = [];
    const W = Math.round(1.0 / this.dt);
    const W66 = Math.round(2.5 / this.dt);
    for (let i = 0; i < this.n; i++) {
      const w = file.t[i] > file.tP66 ? W66 : W;
      const i0 = Math.max(0, i - w), i1 = Math.min(this.n - 1, i + w);
      const acc = this.v[i1].clone().sub(this.v[i0]).divideScalar((i1 - i0) * this.dt);
      const g = gravity(this.r[i]);
      const cor = OMEGA.clone().cross(this.v[i]).multiplyScalar(2);
      const cen = OMEGA.clone().cross(OMEGA.clone().cross(this.r[i]));
      aT.push(acc.sub(g).add(cor).add(cen));
    }
    // attitude + mass
    let mass = LM.massPDI;
    const ev = (label: string) => file.events.find((e) => e.label.startsWith(label))!.tfi;
    const yawStart = ev('Yaw to windows-up'), yawEnd = ev('Windows-up maneuver complete');
    const blend0 = file.tP66 - 4, blend1 = file.tP66 + 2;
    for (let i = 0; i < this.n; i++) {
      const t = file.t[i];
      const p = this.r[i];
      const { e, n, u } = enuAt(p);
      // forward = direction of travel along the track (approach azimuth)
      const az = file.approachAzimuthDeg * D2R;
      const f = n.clone().multiplyScalar(Math.cos(az)).addScaledVector(e, Math.sin(az)).normalize();
      const lateral = u.clone().cross(f).normalize(); // U x F
      let xb = aT[i].clone().normalize();
      if (i < W) xb = aT[W].clone().normalize();
      const th = file.theta[i];
      if (th !== null && t >= blend0) {
        const xTM = u.clone().multiplyScalar(Math.cos(th * D2R)).addScaledVector(f, Math.sin(th * D2R)).normalize();
        const w = Math.min(1, Math.max(0, (t - blend0) / (blend1 - blend0)));
        xb = xb.multiplyScalar(1 - w).addScaledVector(xTM, w).normalize();
      }
      // windows down (face down) until the yaw manoeuvre, then windows up
      let roll = Math.PI;
      if (t >= yawEnd) roll = 0; else if (t > yawStart) roll = Math.PI * (1 - smooth((t - yawStart) / (yawEnd - yawStart)));
      const zUp = lateral.clone().cross(xb).normalize(); // windows-up Z
      const zb = zUp.applyAxisAngle(xb, roll).normalize();
      const yb = zb.clone().cross(xb).normalize();
      const q = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(xb, yb, zb));
      this.q.push(q);
      const thrustN = aT[i].length() * mass;
      this.thr.push(Math.min(1, thrustN / LM.dpsMaxThrust));
      this.m.push(mass);
      mass -= (thrustN / (LM.dpsIsp * G0)) * this.dt;
    }
    // ensure quaternion continuity for slerp
    for (let i = 1; i < this.n; i++) if (this.q[i].dot(this.q[i - 1]) < 0) {
      const q = this.q[i]; q.set(-q.x, -q.y, -q.z, -q.w);
    }
  }

  get landedMass() { return this.m[this.n - 1]; }

  sample(t: number, out?: ReplaySample): ReplaySample {
    t = Math.min(Math.max(t, 0), this.duration);
    const f = t / this.dt;
    const i = Math.min(this.n - 2, Math.floor(f));
    const a = f - i;
    const o = out ?? { t: 0, r: new Vector3(), v: new Vector3(), q: new Quaternion(), thrust: 0, mass: 0, dpsProp: 0, program: '', downrange: 0 };
    o.t = t;
    o.r.copy(this.r[i]).lerp(this.r[i + 1], a);
    o.v.copy(this.v[i]).lerp(this.v[i + 1], a);
    o.q.copy(this.q[i]).slerp(this.q[i + 1], a);
    o.thrust = t >= this.duration ? 0 : this.thr[i] * (1 - a) + this.thr[i + 1] * a;
    o.mass = this.m[i] * (1 - a) + this.m[i + 1] * a;
    o.dpsProp = LM.dpsPropPDI - (LM.massPDI - o.mass);
    o.downrange = this.file.d[i] * (1 - a) + this.file.d[i + 1] * a;
    o.program = t < 507 ? '63' : t < this.file.tP66 + 2 ? '64' : t < this.duration ? '66' : '68';
    return o;
  }

  eventsBetween(t0: number, t1: number) {
    return this.file.events.filter((e) => e.tfi > t0 && e.tfi <= t1);
  }
}

function smooth(x: number) { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); }
function enuAt(p: Vector3) {
  const r = p.length();
  return enu(Math.asin(p.z / r) / D2R, Math.atan2(p.y, p.x) / D2R);
}
export const FT_PER_M = 1 / FT;

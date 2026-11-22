import { Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import { MOON } from './constants';

const D2R = Math.PI / 180;

/** Moon-centred Moon-fixed (MCMF) position from planetocentric lat/lon (deg) and radius (m). */
export function llrToVec(latDeg: number, lonDeg: number, r: number, out = new Vector3()): Vector3 {
  const la = latDeg * D2R, lo = lonDeg * D2R;
  const c = Math.cos(la);
  return out.set(r * c * Math.cos(lo), r * c * Math.sin(lo), r * Math.sin(la));
}

export function vecToLLR(v: Vector3): { lat: number; lon: number; r: number } {
  const r = v.length();
  return { lat: Math.asin(v.z / r) / D2R, lon: Math.atan2(v.y, v.x) / D2R, r };
}

/** Local East/North/Up unit vectors at a lat/lon. */
export function enu(latDeg: number, lonDeg: number) {
  const la = latDeg * D2R, lo = lonDeg * D2R;
  const e = new Vector3(-Math.sin(lo), Math.cos(lo), 0);
  const n = new Vector3(-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la));
  const u = new Vector3(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la));
  return { e, n, u };
}

export function enuAt(p: Vector3) {
  const { lat, lon } = vecToLLR(p);
  return enu(lat, lon);
}

/** Point reached from (lat,lon) by travelling angular distance `ang` (rad) along initial azimuth `azDeg`. */
export function destination(latDeg: number, lonDeg: number, azDeg: number, ang: number) {
  const la = latDeg * D2R, lo = lonDeg * D2R, az = azDeg * D2R;
  const la2 = Math.asin(Math.sin(la) * Math.cos(ang) + Math.cos(la) * Math.sin(ang) * Math.cos(az));
  const lo2 = lo + Math.atan2(Math.sin(az) * Math.sin(ang) * Math.cos(la), Math.cos(ang) - Math.sin(la) * Math.sin(la2));
  return { lat: la2 / D2R, lon: lo2 / D2R };
}

/**
 * Render frame: a fixed rotation of MCMF so that the landing site's local Up is +Y, East is +X and
 * North is -Z (three.js convention). Positions are rendered relative to a floating origin.
 */
export class RenderFrame {
  readonly m = new Matrix3();
  readonly q = new Quaternion();
  constructor(latDeg: number, lonDeg: number) {
    const { e, n, u } = enu(latDeg, lonDeg);
    // rows: render axes expressed in MCMF
    this.m.set(e.x, e.y, e.z, u.x, u.y, u.z, -n.x, -n.y, -n.z);
    this.q.setFromRotationMatrix(new Matrix4().setFromMatrix3(this.m));
  }
  /** MCMF direction/offset -> render axes */
  dir(v: Vector3, out = new Vector3()): Vector3 {
    return out.copy(v).applyMatrix3(this.m);
  }
}

export function gravity(r: Vector3, out = new Vector3()): Vector3 {
  const d = r.length();
  return out.copy(r).multiplyScalar(-MOON.mu / (d * d * d));
}

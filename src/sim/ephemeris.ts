// Low-precision ephemeris for the Apollo 11 descent: Sun, Moon (geocentric), planets, and the Moon's
// orientation, all expressed in ICRF/J2000 equatorial axes so they share the star catalogue's frame.
//
// Sources (formulae, not code):
//  - Sun: Astronomical Almanac low-precision formula (~0.01 deg).
//  - Moon: Meeus, Astronomical Algorithms ch. 47, the larger terms of Table 47.A/B (~0.01 deg).
//  - Planets: JPL "Keplerian Elements for Approximate Positions of the Major Planets" (Standish), 1800-2050 set.
//  - Lunar orientation: IAU WGCCRE 2009 (Archinal et al. 2011) model for the Moon, mean-Earth/polar-axis frame,
//    the same frame the LOLA/LROC products are in.
import { Matrix3, Vector3 } from 'three';

const D2R = Math.PI / 180;
const sin = (d: number) => Math.sin(d * D2R);
const cos = (d: number) => Math.cos(d * D2R);
const AU_KM = 149597870.7;

/** Apollo 11 lift-off, 1969-07-16 13:32:00 UTC, is GET 0. PDI (sim t = 0) is GET 102:33:05. */
export const LAUNCH_UTC_MS = Date.UTC(1969, 6, 16, 13, 32, 0);
export const PDI_GET_S = 102 * 3600 + 33 * 60 + 5;
const DELTA_T_1969 = 39.7; // TT - UT1, seconds

export function jdUTFromSimTime(t: number) {
  const ms = LAUNCH_UTC_MS + (PDI_GET_S + t) * 1000;
  return ms / 86400000 + 2440587.5;
}

const OBL_J2000 = 23.4392911;
/** ecliptic (J2000) lon/lat in degrees, distance -> equatorial J2000 vector */
function eclToEq(lon: number, lat: number, dist: number, out = new Vector3()) {
  const x = dist * cos(lat) * cos(lon), y = dist * cos(lat) * sin(lon), z = dist * sin(lat);
  const ce = cos(OBL_J2000), se = sin(OBL_J2000);
  return out.set(x, y * ce - z * se, y * se + z * ce);
}
/** general precession in longitude from J2000 to the date (deg), T in Julian centuries from J2000 */
const precLon = (T: number) => 1.396971 * T + 0.0003086 * T * T;

/** Geocentric Sun, km, ICRF axes. */
export function sunGeocentric(jdTT: number, out = new Vector3()) {
  const n = jdTT - 2451545.0;
  const T = n / 36525;
  const L = 280.460 + 0.9856474 * n;
  const g = 357.528 + 0.9856003 * n;
  const lam = L + 1.915 * sin(g) + 0.020 * sin(2 * g) - precLon(T);
  const R = 1.00014 - 0.01671 * cos(g) - 0.00014 * cos(2 * g);
  return eclToEq(lam, 0, R * AU_KM, out);
}

// Meeus Table 47.A: [D, M, M', F, sigma_l (1e-6 deg), sigma_r (1e-3 km)]
const LR: number[][] = [
  [0, 0, 1, 0, 6288774, -20905355], [2, 0, -1, 0, 1274027, -3699111], [2, 0, 0, 0, 658314, -2955968],
  [0, 0, 2, 0, 213618, -569925], [0, 1, 0, 0, -185116, 48888], [0, 0, 0, 2, -114332, -3149],
  [2, 0, -2, 0, 58793, 246158], [2, -1, -1, 0, 57066, -152138], [2, 0, 1, 0, 53322, -170733],
  [2, -1, 0, 0, 45758, -204586], [0, 1, -1, 0, -40923, -129620], [1, 0, 0, 0, -34720, 108743],
  [0, 1, 1, 0, -30383, 104755], [2, 0, 0, -2, 15327, 10321], [0, 0, 1, 2, -12528, 0],
  [0, 0, 1, -2, 10980, 79661], [4, 0, -1, 0, 10675, -34782], [0, 0, 3, 0, 10034, -23210],
  [4, 0, -2, 0, 8548, -21636], [2, 1, -1, 0, -7888, 24208], [2, 1, 0, 0, -6766, 30824],
  [1, 0, -1, 0, -5163, -8379], [1, 1, 0, 0, 4987, -16675], [2, -1, 1, 0, 4036, -12831],
];
// Table 47.B: [D, M, M', F, sigma_b (1e-6 deg)]
const B: number[][] = [
  [0, 0, 0, 1, 5128122], [0, 0, 1, 1, 280602], [0, 0, 1, -1, 277693], [2, 0, 0, -1, 173237],
  [2, 0, -1, 1, 55413], [2, 0, -1, -1, 46271], [2, 0, 0, 1, 32573], [0, 0, 2, 1, 17198],
  [2, 0, 1, -1, 9266], [0, 0, 2, -1, 8822], [2, -1, 0, -1, 8216], [2, 0, -2, -1, 4324], [2, 0, 1, 1, 4200],
];

/** Geocentric Moon, km, ICRF axes. */
export function moonGeocentric(jdTT: number, out = new Vector3()) {
  const T = (jdTT - 2451545.0) / 36525;
  const Lp = 218.3164477 + 481267.88123421 * T;
  const D = 297.8501921 + 445267.1114034 * T;
  const M = 357.5291092 + 35999.0502909 * T;
  const Mp = 134.9633964 + 477198.8675055 * T;
  const F = 93.272095 + 483202.0175233 * T;
  const E = 1 - 0.002516 * T;
  let sl = 0, sr = 0, sb = 0;
  for (const [d, m, mp, f, l, r] of LR) {
    const a = d * D + m * M + mp * Mp + f * F;
    const e = Math.abs(m) === 1 ? E : Math.abs(m) === 2 ? E * E : 1;
    sl += l * e * sin(a); sr += r * e * cos(a);
  }
  for (const [d, m, mp, f, b] of B) {
    const e = Math.abs(m) === 1 ? E : 1;
    sb += b * e * sin(d * D + m * M + mp * Mp + f * F);
  }
  const lam = Lp + sl / 1e6 - precLon(T);
  const bet = sb / 1e6;
  const dist = 385000.56 + sr / 1000;
  return eclToEq(lam, bet, dist, out);
}

/** ICRF -> Moon mean-Earth body-fixed rotation (IAU 2009). */
export function moonIcrfToBody(jdTT: number, out = new Matrix3()) {
  const d = jdTT - 2451545.0;
  const T = d / 36525;
  const E = [0,
    125.045 - 0.0529921 * d, 250.089 - 0.1059842 * d, 260.008 + 13.0120009 * d, 176.625 + 13.3407154 * d,
    357.529 + 0.9856003 * d, 311.589 + 26.4057084 * d, 134.963 + 13.064993 * d, 276.617 + 0.3287146 * d,
    34.226 + 1.7484877 * d, 15.134 - 0.1589763 * d, 119.743 + 0.0036096 * d, 239.961 + 0.1643573 * d,
    25.053 + 12.9590088 * d];
  const a0 = 269.9949 + 0.0031 * T - 3.8787 * sin(E[1]) - 0.1204 * sin(E[2]) + 0.07 * sin(E[3]) - 0.0172 * sin(E[4])
    + 0.0072 * sin(E[6]) - 0.0052 * sin(E[10]) + 0.0043 * sin(E[13]);
  const d0 = 66.5392 + 0.013 * T + 1.5419 * cos(E[1]) + 0.0239 * cos(E[2]) - 0.0278 * cos(E[3]) + 0.0068 * cos(E[4])
    - 0.0029 * cos(E[6]) + 0.0009 * cos(E[7]) + 0.0008 * cos(E[10]) - 0.0009 * cos(E[13]);
  const W = 38.3213 + 13.17635815 * d - 1.4e-12 * d * d + 3.561 * sin(E[1]) + 0.1208 * sin(E[2]) - 0.0642 * sin(E[3])
    + 0.0158 * sin(E[4]) + 0.0252 * sin(E[5]) - 0.0066 * sin(E[6]) - 0.0047 * sin(E[7]) - 0.0046 * sin(E[8])
    + 0.0028 * sin(E[9]) + 0.0052 * sin(E[10]) + 0.004 * sin(E[11]) + 0.0019 * sin(E[12]) - 0.0044 * sin(E[13]);
  // body axes in ICRF: pole Z, prime meridian X (rotated W from the node of the equator on the ICRF equator)
  const zb = new Vector3(cos(d0) * cos(a0), cos(d0) * sin(a0), sin(d0));
  const node = new Vector3(-sin(a0), cos(a0), 0); // ascending node of body equator, at RA a0+90
  const q = new Vector3().crossVectors(zb, node);
  const xb = node.clone().multiplyScalar(cos(W)).addScaledVector(q, sin(W));
  const yb = new Vector3().crossVectors(zb, xb);
  return out.set(xb.x, xb.y, xb.z, yb.x, yb.y, yb.z, zb.x, zb.y, zb.z);
}

/** Greenwich mean sidereal time, degrees. */
export function gmstDeg(jdUT: number) {
  const d = jdUT - 2451545.0;
  return (((280.46061837 + 360.98564736629 * d) % 360) + 360) % 360;
}

// JPL approximate elements (1800-2050), J2000 ecliptic: a, e, I, L, varpi, Omega and their rates per century
const PLANETS: Record<string, { el: number[]; rate: number[]; V: number }> = {
  Mercury: { el: [0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593], rate: [3.7e-7, 1.906e-5, -0.00594749, 149472.67411175, 0.16047689, -0.12534081], V: -0.42 },
  Venus: { el: [0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255], rate: [3.9e-6, -4.107e-5, -0.0007889, 58517.81538729, 0.00268329, -0.27769418], V: -4.40 },
  EMB: { el: [1.00000261, 0.01671123, -1.531e-5, 100.46457166, 102.93768193, 0], rate: [5.62e-6, -4.392e-5, -0.01294668, 35999.37244981, 0.32327364, 0], V: 0 },
  Mars: { el: [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891], rate: [1.847e-5, 7.882e-5, -0.00813131, 19140.30268499, 0.44441088, -0.29257343], V: -1.52 },
  Jupiter: { el: [5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909], rate: [-1.1607e-4, -1.3253e-4, -0.00183714, 3034.74612775, 0.21252668, 0.20469106], V: -9.40 },
  Saturn: { el: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448], rate: [-1.2506e-3, -5.0991e-4, 0.00193609, 1222.49362201, -0.41897216, -0.28867794], V: -8.88 },
};

function helio(name: string, T: number, out: Vector3) {
  const p = PLANETS[name];
  const [a, e, I, L, wb, N] = p.el.map((v, i) => v + p.rate[i] * T);
  const w = wb - N;
  let M = (((L - wb) % 360) + 540) % 360 - 180;
  const eD = e / D2R;
  let Ea = M + eD * sin(M);
  for (let k = 0; k < 8; k++) Ea += (M - (Ea - eD * sin(Ea))) / (1 - e * cos(Ea));
  const xp = a * (cos(Ea) - e), yp = a * Math.sqrt(1 - e * e) * sin(Ea);
  const x = (cos(w) * cos(N) - sin(w) * sin(N) * cos(I)) * xp + (-sin(w) * cos(N) - cos(w) * sin(N) * cos(I)) * yp;
  const y = (cos(w) * sin(N) + sin(w) * cos(N) * cos(I)) * xp + (-sin(w) * sin(N) + cos(w) * cos(N) * cos(I)) * yp;
  const z = sin(w) * sin(I) * xp + cos(w) * sin(I) * yp;
  const ce = cos(OBL_J2000), se = sin(OBL_J2000);
  return out.set(x, y * ce - z * se, y * se + z * ce); // AU, ICRF axes
}

export interface PlanetPos { name: string; dir: Vector3; mag: number }

/** Planet directions and magnitudes as seen from the Moon, ICRF axes. */
export function planetsFromMoon(jdTT: number): PlanetPos[] {
  const T = (jdTT - 2451545.0) / 36525;
  const emb = helio('EMB', T, new Vector3());
  // Moon heliocentric ~ EMB + (Moon - EMB); EMB is 1/82.3 of the way from Earth to Moon
  const moonGeo = moonGeocentric(jdTT).divideScalar(AU_KM);
  const moon = emb.clone().addScaledVector(moonGeo, 1 - 1 / 82.3);
  const out: PlanetPos[] = [];
  for (const name of ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn']) {
    const h = helio(name, T, new Vector3());
    const rel = h.clone().sub(moon);
    const r = h.length(), dl = rel.length();
    const phase = Math.acos(Math.max(-1, Math.min(1, h.dot(rel) / (r * dl)))) / D2R;
    const mag = PLANETS[name].V + 5 * Math.log10(r * dl) + (name === 'Venus' || name === 'Mercury' ? 0.013 * phase : name === 'Mars' ? 0.016 * phase : 0.005 * phase);
    out.push({ name, dir: rel.normalize(), mag });
  }
  return out;
}

/** Everything the sky needs at a sim time. Directions are unit vectors in Moon-fixed (MCMF) axes. */
export interface SkyState {
  jdUT: number;
  icrfToMoon: Matrix3;
  sunDir: Vector3; earthDir: Vector3; earthDistKm: number; sunDistKm: number;
  /** Earth-fixed -> ICRF rotation angle (GMST, deg) */
  gmst: number;
}

export function skyAt(t: number): SkyState {
  const jdUT = jdUTFromSimTime(t);
  const jdTT = jdUT + DELTA_T_1969 / 86400;
  const R = moonIcrfToBody(jdTT);
  const moon = moonGeocentric(jdTT);
  const sun = sunGeocentric(jdTT);
  const sunFromMoon = sun.clone().sub(moon);
  const earthFromMoon = moon.clone().negate();
  return {
    jdUT, icrfToMoon: R,
    sunDistKm: sunFromMoon.length(), earthDistKm: earthFromMoon.length(),
    sunDir: sunFromMoon.normalize().applyMatrix3(R),
    earthDir: earthFromMoon.normalize().applyMatrix3(R),
    gmst: gmstDeg(jdUT),
  };
}

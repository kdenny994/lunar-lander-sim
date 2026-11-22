// Stars, planets, Sun and Earth, rendered at "infinity" around the camera.
//
// Brightness model: every star is drawn only if it is brighter than the current limiting magnitude,
// which depends on the sensor (eye, Hasselblad film, AOT) and, for the eye, on the adaptation
// luminance of what is in view plus the veiling glare from the Sun (Stiles-Holladay: L = 10 E / theta^2).
import * as THREE from 'three';
import type { SkyState, PlanetPos } from '../sim/ephemeris';
import type { RenderFrame } from '../sim/geo';

const D2R = Math.PI / 180;
export const SKY_DIST = 3.0e6; // m, inside the camera far plane, beyond any visible terrain
const SUN_E_LUX = 127000; // solar illuminance at 1 AU

export interface SkyData { stars: number[][]; named: [string, number, number, number][]; lines: number[][][] }

/** B-V colour index -> linear RGB (approximate blackbody). */
function bvToRGB(bv: number): [number, number, number] {
  const t = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
  // Tanner Helland's blackbody fit, normalised
  const k = t / 100;
  let r = k <= 66 ? 255 : 329.7 * Math.pow(k - 60, -0.1332);
  let g = k <= 66 ? 99.47 * Math.log(k) - 161.1 : 288.1 * Math.pow(k - 60, -0.0755);
  let b = k >= 66 ? 255 : k <= 19 ? 0 : 138.5 * Math.log(k - 10) - 305.0;
  r = Math.min(255, Math.max(0, r)); g = Math.min(255, Math.max(0, g)); b = Math.min(255, Math.max(0, b));
  const m = Math.max(r, g, b);
  return [r / m, g / m, b / m];
}

export function raDecToVec(raDeg: number, decDeg: number, out = new THREE.Vector3()) {
  const c = Math.cos(decDeg * D2R);
  return out.set(c * Math.cos(raDeg * D2R), c * Math.sin(raDeg * D2R), Math.sin(decDeg * D2R));
}

const starVert = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float mag;
  attribute vec3 color;
  uniform float uLim0, uSlope, uLa, uLa0, uGlare, uPx, uAperture;
  uniform vec3 uSunDir;
  varying vec3 vCol;
  varying float vA;
  void main() {
    vec3 dir = normalize(mat3(modelMatrix) * position);
    float th = max(acos(clamp(dot(dir, uSunDir), -1.0, 1.0)) * 57.29578, 0.5);
    float La = uLa + uGlare * 10.0 * ${SUN_E_LUX.toFixed(1)} / (th * th);
    float lim = uLim0 - uSlope * log(1.0 + La / uLa0) / log(10.0);
    float rel = lim - mag;              // magnitudes above the detection threshold
    vA = clamp(0.25 + rel / 1.0, 0.0, 1.0);
    vCol = color * clamp(0.8 + 0.35 * rel, 0.8, 3.0);
    gl_PointSize = rel > 0.0 ? clamp((2.6 + 0.8 * rel) * uAperture, 2.6, 12.0) * uPx : 0.0;
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }`;
const starFrag = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  varying vec3 vCol;
  varying float vA;
  void main() {
    #include <logdepthbuf_fragment>
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(p, p);
    if (r2 > 1.0) discard;
    float core = exp(-r2 * 4.0);
    gl_FragColor = vec4(vCol * core, core * vA);
  }`;

const sunFrag = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  uniform float uDiscR, uSpikes, uGlow;
  varying vec2 vUv;
  void main() {
    #include <logdepthbuf_fragment>
    vec2 p = (vUv - 0.5) * 2.0;          // 1.0 = quad edge
    float r = length(p) / uDiscR;        // 1.0 = solar limb
    float disc = 1.0 - smoothstep(0.92, 1.0, r);
    float glow = uGlow * (0.55 / (1.0 + r * r * 0.35) + 0.12 / (1.0 + r * 0.25));
    float a = atan(p.y, p.x);
    float spikes = uSpikes * pow(abs(cos(a * 3.0)), 600.0) * 1.6 * exp(-r / 14.0);
    float edge = 1.0 - smoothstep(0.75, 1.0, length(p));
    vec3 col = vec3(1.0, 0.98, 0.94) * (disc * 4.0 + (glow + spikes) * edge);
    gl_FragColor = vec4(col, 1.0);
  }`;

const earthVert = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vUv = uv;
    vN = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vV = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
    #include <logdepthbuf_vertex>
  }`;
const earthFrag = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D map;
  uniform vec3 uSun;
  uniform float uGain;
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    #include <logdepthbuf_fragment>
    vec3 albedo = texture2D(map, vUv).rgb;
    float mu = dot(normalize(vN), uSun);
    float lit = smoothstep(-0.04, 0.12, mu) * max(mu, 0.0) * 0.85 + smoothstep(-0.03, 0.05, mu) * 0.06;
    float limb = pow(1.0 - max(dot(normalize(vN), vV), 0.0), 3.0);
    vec3 atm = vec3(0.30, 0.50, 1.0) * limb * smoothstep(-0.1, 0.3, mu) * 0.6;
    vec3 surf = mix(albedo, vec3(0.42, 0.56, 0.86), 0.16); // Rayleigh haze over the whole disc
    gl_FragColor = vec4((surf * lit + atm) * uGain, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

export class SkyRenderer {
  /** placed at the camera every frame */
  readonly group = new THREE.Group();
  /** ICRF-oriented */
  readonly celestial = new THREE.Group();
  readonly starMat: THREE.ShaderMaterial;
  readonly lines: THREE.LineSegments;
  readonly sun: THREE.Mesh;
  readonly earth: THREE.Mesh;
  private earthAxis = new THREE.Group();
  private sunMat: THREE.ShaderMaterial;
  private earthMat: THREE.ShaderMaterial;
  readonly named: { name: string; dir: THREE.Vector3; mag: number }[] = [];
  planets: PlanetPos[] = [];
  private icrfToRender = new THREE.Matrix3();

  constructor(data: SkyData, planets: PlanetPos[], earthTex: THREE.Texture) {
    this.group.frustumCulled = false;
    this.celestial.matrixAutoUpdate = false;
    this.group.add(this.celestial);
    this.planets = planets;

    const pl: { dir: THREE.Vector3; mag: number; bv: number }[] = planets.map((p) => ({
      dir: p.dir, mag: p.mag, bv: p.name === 'Mars' ? 1.45 : p.name === 'Saturn' ? 1.05 : p.name === 'Jupiter' ? 0.85 : 0.75,
    }));
    const n = data.stars.length + pl.length;
    const pos = new Float32Array(n * 3), mag = new Float32Array(n), col = new Float32Array(n * 3);
    const v = new THREE.Vector3();
    const put = (i: number, d: THREE.Vector3, m: number, bv: number) => {
      pos.set([d.x * SKY_DIST, d.y * SKY_DIST, d.z * SKY_DIST], i * 3);
      mag[i] = m; col.set(bvToRGB(bv), i * 3);
    };
    data.stars.forEach(([ra, dec, m, bv], i) => put(i, raDecToVec(ra, dec, v), m, bv));
    pl.forEach((p, k) => put(data.stars.length + k, p.dir, p.mag, p.bv));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('mag', new THREE.BufferAttribute(mag, 1));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.starMat = new THREE.ShaderMaterial({
      vertexShader: starVert, fragmentShader: starFrag, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uLim0: { value: 6.5 }, uSlope: { value: 1.5 }, uLa: { value: 0.001 }, uLa0: { value: 0.001 }, uGlare: { value: 1 },
        uPx: { value: 1 }, uAperture: { value: 1 }, uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      },
    });
    const stars = new THREE.Points(g, this.starMat);
    stars.frustumCulled = false;
    stars.renderOrder = -10;
    this.celestial.add(stars);

    for (const [name, ra, dec, m] of data.named) this.named.push({ name, dir: raDecToVec(ra, dec), mag: m });

    // constellation figures (labels mode)
    const seg: number[] = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    for (const strip of data.lines) {
      for (let i = 0; i + 1 < strip.length; i++) {
        raDecToVec(strip[i][0], strip[i][1], a).multiplyScalar(SKY_DIST * 0.99);
        raDecToVec(strip[i + 1][0], strip[i + 1][1], b).multiplyScalar(SKY_DIST * 0.99);
        seg.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
    this.lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x3d6fa8, transparent: true, opacity: 0.45, depthWrite: false, toneMapped: false }));
    this.lines.frustumCulled = false;
    this.lines.visible = false;
    this.celestial.add(this.lines);

    // Sun: a camera-facing quad 40 deg across
    this.sunMat = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `#include <common>
        #include <logdepthbuf_pars_vertex>
        varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
        #include <logdepthbuf_vertex>
        }`,
      fragmentShader: sunFrag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
      uniforms: { uDiscR: { value: 0.2665 / 20 }, uSpikes: { value: 0 }, uGlow: { value: 1 } },
    });
    const sunSize = 2 * SKY_DIST * Math.tan(20 * D2R);
    this.sun = new THREE.Mesh(new THREE.PlaneGeometry(sunSize, sunSize), this.sunMat);
    this.sun.frustumCulled = false;
    this.sun.renderOrder = -9;
    this.group.add(this.sun);

    // Earth: textured sphere, Earth-fixed geometry (z north, x Greenwich)
    earthTex.colorSpace = THREE.SRGBColorSpace;
    earthTex.anisotropy = 4;
    this.earthMat = new THREE.ShaderMaterial({
      vertexShader: earthVert, fragmentShader: earthFrag,
      uniforms: { map: { value: earthTex }, uSun: { value: new THREE.Vector3(1, 0, 0) }, uGain: { value: 2.1 } },
    });
    const eg = new THREE.SphereGeometry(1, 96, 48);
    eg.rotateX(Math.PI / 2);
    this.earth = new THREE.Mesh(eg, this.earthMat);
    this.earth.frustumCulled = false;
    this.earth.renderOrder = -8;
    this.earthAxis.add(this.earth);
    this.group.add(this.earthAxis);
  }

  /** Direction (render axes) of a celestial (ICRF) unit vector. */
  toRender(icrf: THREE.Vector3, out = new THREE.Vector3()) {
    return out.copy(icrf).applyMatrix3(this.icrfToRender);
  }

  update(camera: THREE.Camera, frame: RenderFrame, sky: SkyState, sunDirR: THREE.Vector3, earthDirR: THREE.Vector3) {
    this.group.position.copy(camera.position);
    // ICRF -> MCMF -> render
    this.icrfToRender.multiplyMatrices(frame.m, sky.icrfToMoon);
    const m4 = new THREE.Matrix4().setFromMatrix3(this.icrfToRender);
    this.celestial.matrix.copy(m4);
    this.celestial.matrixWorldNeedsUpdate = true;
    this.starMat.uniforms.uSunDir.value.copy(sunDirR);

    this.sun.position.copy(sunDirR).multiplyScalar(SKY_DIST * 0.98);
    this.sun.quaternion.copy(camera.quaternion);

    // Earth: angular radius from distance; Earth-fixed -> ICRF is a rotation by GMST about z
    const angR = Math.asin(6378.137 / sky.earthDistKm);
    const d = SKY_DIST * 0.97;
    this.earthAxis.position.copy(earthDirR).multiplyScalar(d);
    this.earth.scale.setScalar(d * Math.tan(angR));
    const rz = new THREE.Matrix4().makeRotationZ(sky.gmst * D2R);
    this.earthAxis.matrixAutoUpdate = false;
    this.earthAxis.matrix.copy(m4).multiply(rz).setPosition(this.earthAxis.position);
    this.earthAxis.matrixWorldNeedsUpdate = true;
    this.earthMat.uniforms.uSun.value.copy(sunDirR);
  }

  setSensor(p: { lim0: number; slope: number; La: number; glare: number; aperture: number; spikes: number; glow: number }, pxRatio: number) {
    const u = this.starMat.uniforms;
    u.uLim0.value = p.lim0; u.uSlope.value = p.slope; u.uLa.value = p.La; u.uGlare.value = p.glare;
    u.uAperture.value = p.aperture; u.uPx.value = pxRatio;
    this.sunMat.uniforms.uSpikes.value = p.spikes;
    this.sunMat.uniforms.uGlow.value = p.glow;
  }

  /** limiting magnitude at a direction (render axes), for read-outs */
  limitAt(dirR: THREE.Vector3, sunDirR: THREE.Vector3) {
    const u = this.starMat.uniforms;
    const th = Math.max(Math.acos(Math.max(-1, Math.min(1, dirR.dot(sunDirR)))) / D2R, 0.5);
    const La = u.uLa.value + u.uGlare.value * 10 * SUN_E_LUX / (th * th);
    return u.uLim0.value - u.uSlope.value * Math.log10(1 + La / u.uLa0.value);
  }
}

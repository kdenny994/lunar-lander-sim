// Streaming, LOD'd lunar terrain: LOLA/WAC corridor + LROC NAC landing-site patch, with floating origin.
import * as THREE from 'three';
import { MOON } from '../sim/constants';
import { llrToVec, type RenderFrame } from '../sim/geo';
import type { HeightGrid, TerrainData } from '../sim/terrainData';

interface ChunkDef {
  grid: HeightGrid;
  r0: number; r1: number; c0: number; c1: number;
  center: Vector3d; // MCMF centre (on surface)
  radius: number; // bounding radius (m)
  texUrl: string;
  steps: number[];
  lodDist: number[]; // max distance for each LOD
  skirt: number;
  isSite: boolean;
}
type Vector3d = THREE.Vector3;
interface ChunkRec { def: ChunkDef; mesh: THREE.Mesh | null; geos: (THREE.BufferGeometry | null)[]; lod: number; mat: THREE.MeshLambertMaterial }

const RECT_SHADER_VERT_DECL = `
attribute vec2 aLL;
varying vec2 vLL;
`;
const RECT_SHADER_FRAG_DECL = `
varying vec2 vLL;
uniform vec4 uRect;
uniform float uDiscard;
uniform float uGain;
`;

function makeMaterial(rectUniforms: { uRect: { value: THREE.Vector4 }; uDiscard: { value: number } } | null, gain: number) {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const uGain = { value: gain };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uRect = rectUniforms ? rectUniforms.uRect : { value: new THREE.Vector4(0, 0, 0, 0) };
    sh.uniforms.uDiscard = rectUniforms ? rectUniforms.uDiscard : { value: 0 };
    sh.uniforms.uGain = uGain;
    sh.vertexShader = RECT_SHADER_VERT_DECL + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vLL = aLL;');
    sh.fragmentShader = RECT_SHADER_FRAG_DECL + sh.fragmentShader
      .replace('void main() {', `void main() {
  if (uDiscard > 0.5 && vLL.x > uRect.x && vLL.x < uRect.y && vLL.y > uRect.z && vLL.y < uRect.w) discard;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
  diffuseColor.rgb *= uGain;`);
  };
  mat.customProgramCacheKey = () => (rectUniforms ? 'terrain-rect' : 'terrain');
  return mat;
}

export class TerrainRenderer {
  readonly group = new THREE.Group();
  private chunks: ChunkRec[] = [];
  private rect = { uRect: { value: new THREE.Vector4() }, uDiscard: { value: 0 } };
  private background: THREE.Mesh;
  private loader = new THREE.TextureLoader();
  private pendingSiteTex = 0;
  anisotropy = 8;

  constructor(private data: TerrainData, private frame: RenderFrame, private base: string) {
    const sb = data.site.bounds;
    this.rect.uRect.value.set(sb.lonMin - 23, sb.lonMax - 23, sb.latMin, sb.latMax);
    this.addGrid(data.corridor, false);
    this.addGrid(data.site, true);
    this.background = this.makeBackground();
    this.group.add(this.background);
  }

  private addGrid(grid: HeightGrid, isSite: boolean) {
    const m = grid.meta as any;
    const per = isSite ? m.chunkSamples : Math.round(m.chunkDeg / m.dlon);
    for (let ri = 0; ri < m.chunkRows; ri++) {
      for (let ci = 0; ci < m.chunkCols; ci++) {
        const r0 = ri * per, c0 = ci * per;
        const r1 = Math.min((ri + 1) * per, m.height - 1), c1 = Math.min((ci + 1) * per, m.width - 1);
        const latC = m.lat0 + ((r0 + r1) / 2) * m.dlat, lonC = m.lon0 + ((c0 + c1) / 2) * m.dlon;
        const h = grid.sample(Math.round((r0 + r1) / 2), Math.round((c0 + c1) / 2));
        const center = llrToVec(latC, lonC, MOON.radius + h);
        const dLat = Math.abs((r1 - r0) * m.dlat), dLon = Math.abs((c1 - c0) * m.dlon);
        const radius = 0.5 * Math.hypot(dLat, dLon) * (Math.PI / 180) * MOON.radius;
        const def: ChunkDef = {
          grid, r0, r1, c0, c1, center, radius,
          texUrl: `${this.base}/${isSite ? 'site' : 'corridor'}/tex_${ri}_${ci}.jpg`,
          steps: isSite ? [1, 4, 16] : [1, 4, 16],
          lodDist: isSite ? [1200, 6000, 1e9] : [12000, 60000, 1e9],
          skirt: isSite ? 6 : 250,
          isSite,
        };
        const mat = makeMaterial(isSite ? null : this.rect, isSite ? 1.25 : 1.35);
        this.chunks.push({ def, mesh: null, geos: [null, null, null], lod: -1, mat });
      }
    }
  }

  /** Load every chunk texture (small JPEGs) up front. */
  async loadTextures(onProgress?: (done: number, total: number) => void) {
    let done = 0;
    const total = this.chunks.length;
    this.pendingSiteTex = this.chunks.filter((c) => c.def.isSite).length;
    await Promise.all(this.chunks.map((c) => new Promise<void>((res) => {
      this.loader.load(c.def.texUrl, (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = this.anisotropy;
        t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
        c.mat.map = t; c.mat.needsUpdate = true;
        if (c.def.isSite && --this.pendingSiteTex === 0) this.rect.uDiscard.value = 1;
        onProgress?.(++done, total); res();
      }, undefined, () => { onProgress?.(++done, total); res(); });
    })));
  }

  private buildGeometry(def: ChunkDef, step: number): THREE.BufferGeometry {
    const { grid, r0, r1, c0, c1 } = def;
    const m = grid.meta;
    const rows: number[] = [], cols: number[] = [];
    for (let r = r0; r < r1; r += step) rows.push(r); rows.push(r1);
    for (let c = c0; c < c1; c += step) cols.push(c); cols.push(c1);
    const nr = rows.length, nc = cols.length;
    const nMain = nr * nc;
    const nSkirt = 2 * (nr + nc);
    const pos = new Float32Array((nMain + nSkirt) * 3);
    const uv = new Float32Array((nMain + nSkirt) * 2);
    const ll = new Float32Array((nMain + nSkirt) * 2);
    const tmp = new THREE.Vector3();
    const rel = new THREE.Vector3();
    const put = (k: number, r: number, c: number, drop: number) => {
      const lat = m.lat0 + r * m.dlat, lon = m.lon0 + c * m.dlon;
      const h = grid.sample(r, c) - drop;
      llrToVec(lat, lon, MOON.radius + h, tmp);
      this.frame.dir(rel.copy(tmp).sub(def.center), tmp);
      pos[k * 3] = tmp.x; pos[k * 3 + 1] = tmp.y; pos[k * 3 + 2] = tmp.z;
      uv[k * 2] = (c - c0) / (c1 - c0); uv[k * 2 + 1] = 1 - (r - r0) / (r1 - r0);
      ll[k * 2] = lon - 23; ll[k * 2 + 1] = lat;
    };
    for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) put(i * nc + j, rows[i], cols[j], 0);
    const idx: number[] = [];
    for (let i = 0; i < nr - 1; i++) for (let j = 0; j < nc - 1; j++) {
      const a = i * nc + j, b = a + 1, c = a + nc, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    // skirts along the four edges
    let k = nMain;
    const edge = (list: [number, number, number][]) => {
      const start = k;
      for (const [vi, r, c] of list) { put(k++, r, c, def.skirt); void vi; }
      for (let s = 0; s < list.length - 1; s++) {
        const a = list[s][0], b = list[s + 1][0], a2 = start + s, b2 = start + s + 1;
        idx.push(a, a2, b, b, a2, b2, a, b, a2, b, b2, a2); // both windings
      }
    };
    edge(cols.map((c, j) => [j, rows[0], c]));
    edge(cols.map((c, j) => [(nr - 1) * nc + j, rows[nr - 1], c]));
    edge(rows.map((r, i) => [i * nc, r, cols[0]]));
    edge(rows.map((r, i) => [i * nc + nc - 1, r, cols[nc - 1]]));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('aLL', new THREE.BufferAttribute(ll, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    // skirt normals: copy from their source vertex so lighting matches
    const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
    let kk = nMain;
    const copyN = (srcs: number[]) => { for (const s of srcs) { nrm.setXYZ(kk++, nrm.getX(s), nrm.getY(s), nrm.getZ(s)); } };
    copyN(cols.map((_, j) => j));
    copyN(cols.map((_, j) => (nr - 1) * nc + j));
    copyN(rows.map((_, i) => i * nc));
    copyN(rows.map((_, i) => i * nc + nc - 1));
    g.computeBoundingSphere();
    return g;
  }

  private makeBackground(): THREE.Mesh {
    // whole Moon at 1/4 deg, WAC global mosaic; hidden inside the corridor footprint
    const NLON = 720, NLAT = 360;
    const R = MOON.radius - 2600;
    const pos = new Float32Array((NLON + 1) * (NLAT + 1) * 3);
    const uv = new Float32Array((NLON + 1) * (NLAT + 1) * 2);
    const ll = new Float32Array((NLON + 1) * (NLAT + 1) * 2);
    const v = new THREE.Vector3();
    let k = 0;
    for (let i = 0; i <= NLAT; i++) {
      const lat = 90 - (180 * i) / NLAT;
      for (let j = 0; j <= NLON; j++) {
        const lon = -180 + (360 * j) / NLON;
        llrToVec(lat, lon, R, v);
        pos.set([v.x, v.y, v.z], k * 3);
        uv.set([j / NLON, 1 - i / NLAT], k * 2);
        ll.set([lon - 23, lat], k * 2);
        k++;
      }
    }
    const idx: number[] = [];
    for (let i = 0; i < NLAT; i++) for (let j = 0; j < NLON; j++) {
      const a = i * (NLON + 1) + j, b = a + 1, c = a + NLON + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('aLL', new THREE.BufferAttribute(ll, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const cb = this.data.corridor.bounds;
    const rect = { uRect: { value: new THREE.Vector4(cb.lonMin - 23 + 0.01, cb.lonMax - 23 - 0.01, cb.latMin + 0.01, cb.latMax - 0.01) }, uDiscard: { value: 1 } };
    const mat = makeMaterial(rect, 1.35);
    this.loader.load(`${this.base}/moon_global.jpg`, (t) => { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = this.anisotropy; mat.map = t; mat.needsUpdate = true; });
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    mesh.receiveShadow = false;
    return mesh;
  }

  /** Position chunks relative to the floating origin and choose LODs. Call every frame. */
  update(origin: THREE.Vector3, camRender: THREE.Vector3, budgetMs = 6) {
    const tmp = new THREE.Vector3();
    const t0 = performance.now();
    // background: Moon centre relative to origin, rotated into render axes
    this.frame.dir(tmp.copy(origin).negate(), this.background.position);
    this.background.quaternion.copy(this.frame.q);
    const want: { ch: ChunkRec; lod: number; dist: number }[] = [];
    for (const ch of this.chunks) {
      const p = this.frame.dir(tmp.copy(ch.def.center).sub(origin));
      const dist = Math.max(0, p.distanceTo(camRender) - ch.def.radius);
      if (dist > 400_000) { if (ch.mesh) ch.mesh.visible = false; continue; }
      let lod = ch.def.lodDist.findIndex((d) => dist < d);
      if (lod < 0) lod = ch.def.lodDist.length - 1;
      const coarsest = ch.def.steps.length - 1;
      if (!ch.geos[coarsest]) ch.geos[coarsest] = this.buildGeometry(ch.def, ch.def.steps[coarsest]);
      if (!ch.mesh) {
        ch.mesh = new THREE.Mesh(ch.geos[coarsest]!, ch.mat);
        ch.mesh.receiveShadow = true;
        this.group.add(ch.mesh);
        ch.lod = coarsest;
      }
      ch.mesh.visible = true;
      ch.mesh.position.copy(p);
      if (!ch.geos[lod]) want.push({ ch, lod, dist });
      // use the finest available geometry that is not finer than wanted
      let use = lod;
      while (use < coarsest && !ch.geos[use]) use++;
      if (ch.lod !== use) { ch.mesh.geometry = ch.geos[use]!; ch.lod = use; }
      if (lod > 0 && ch.geos[0] && dist > ch.def.lodDist[0] * 3) { ch.geos[0].dispose(); ch.geos[0] = null; }
    }
    want.sort((a, b) => a.dist - b.dist);
    for (const w of want) {
      if (performance.now() - t0 > budgetMs) break;
      // refine one level at a time
      let l = w.ch.def.steps.length - 1;
      while (l > w.lod && w.ch.geos[l - 1]) l--;
      const target = Math.max(w.lod, l - 1);
      w.ch.geos[target] = this.buildGeometry(w.ch.def, w.ch.def.steps[target]);
    }
  }

  /** Pre-build geometry around a position so the first frames are complete. */
  warm(origin: THREE.Vector3, rounds = 40) {
    const cam = new THREE.Vector3();
    for (let i = 0; i < rounds; i++) this.update(origin, cam, 1e9);
  }
}

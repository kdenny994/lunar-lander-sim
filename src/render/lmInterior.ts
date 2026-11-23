// Simple LM crew-compartment interior for the commander's window view: a low-poly cabin whose surfaces carry flat
// "skins" cut from interior renders by Parth Bhakta (tools/build_lm_interior.py). The two triangular forward
// windows are real openings, so the terrain outside is seen through them.
//
// Built in a cabin frame with the commander's eye at the origin, three.js camera style: +x right, +y up, looking
// down -z (forward). The cabin centreline is 0.55 m to the commander's right. `group` maps the cabin frame onto the
// LM body frame (+X up, +Y right, +Z forward through the windows); place it at the eye point.
import * as THREE from 'three';

const CL = 0.55; // cabin centreline, m right of the commander's eye

export class LMInterior {
  readonly group = new THREE.Group();
  /** rotation cabin frame -> LM body frame */
  static readonly qCabinToBody = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
    new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1)));
  private loaded = 0;
  private total = 0;
  onReady: (() => void) | null = null;

  constructor(base: string) {
    const loader = new THREE.TextureLoader();
    const skin = (name: string, tint = 1) => {
      this.total++;
      const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(tint, tint, tint), side: THREE.DoubleSide });
      loader.load(`${base}/${name}.jpg`, (t) => {
        t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
        mat.map = t; mat.needsUpdate = true;
        if (++this.loaded === this.total) this.onReady?.();
      });
      return mat;
    };
    const plain = (hex: number) => new THREE.MeshBasicMaterial({ color: hex, side: THREE.DoubleSide });
    const quad = (mat: THREE.Material, p00: THREE.Vector3, p10: THREE.Vector3, p01: THREE.Vector3, p11: THREE.Vector3) => {
      // p00 bottom-left, p10 bottom-right, p01 top-left, p11 top-right (as seen from inside)
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([...p00.toArray(), ...p10.toArray(), ...p01.toArray(), ...p11.toArray()], 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
      g.setIndex([0, 1, 2, 2, 1, 3]);
      this.group.add(new THREE.Mesh(g, mat));
    };
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

    // ---- forward bulkhead around each window: a wall in the window's own (tilted) plane with a triangular hole ----
    const wall = plain(0x2b2724);
    const frame = plain(0x8a8378);
    const windowWall = (A: THREE.Vector3, B: THREE.Vector3, C: THREE.Vector3, flip: boolean) => {
      const u = B.clone().sub(A).normalize();
      const n = B.clone().sub(A).cross(C.clone().sub(A)).normalize();
      const v = u.clone().cross(n); // in-plane "up" (toward the top edge of the window)
      const to2 = (p: THREE.Vector3) => { const d = p.clone().sub(A); return new THREE.Vector2(d.dot(u), d.dot(v)); };
      const a = to2(A), b = to2(B), c = to2(C);
      // the wall wraps round the window opening on its outboard and upper sides only, so it never covers the
      // centre panels: top-left, top-right above B, down to B, along the window edges B -> A -> C, then down
      const outline = [new THREE.Vector2(-0.16, 0.55), new THREE.Vector2(b.x, 0.55), b, a, c, new THREE.Vector2(c.x, -1.3), new THREE.Vector2(-0.16, -1.3)];
      const outer = new THREE.Shape(THREE.ShapeUtils.isClockWise(outline) ? outline.reverse() : outline);
      const tri = [a, b, c];
      const g = new THREE.ShapeGeometry(outer);
      const pos = g.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const p = A.clone().addScaledVector(u, pos.getX(i)).addScaledVector(v, pos.getY(i));
        pos.setXYZ(i, flip ? 2 * CL - p.x : p.x, p.y, p.z);
      }
      g.computeBoundingSphere();
      this.group.add(new THREE.Mesh(g, wall));
      // window frame: a thin raised rim around the opening
      const inset = (p: THREE.Vector2, q: THREE.Vector2, r: THREE.Vector2) => p.clone().lerp(q.clone().add(r).multiplyScalar(0.5), -0.035);
      const ring = [inset(a, b, c), inset(b, a, c), inset(c, a, b)];
      const big = new THREE.Shape(THREE.ShapeUtils.isClockWise(ring) ? ring.reverse() : ring);
      big.holes.push(new THREE.Path(tri));
      const rg = new THREE.ShapeGeometry(big);
      const rp = rg.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < rp.count; i++) {
        const p = A.clone().addScaledVector(u, rp.getX(i)).addScaledVector(v, rp.getY(i)).addScaledVector(n, 0.004);
        rp.setXYZ(i, flip ? 2 * CL - p.x : p.x, p.y, p.z);
      }
      this.group.add(new THREE.Mesh(rg, frame));
    };
    // commander's window: top edge slightly above eye level, the apex low and inboard so the LPD scale (25-65 deg
    // below the horizon) is visible through it
    const A = V(-0.47, 0.25, -0.5), B = V(0.24, 0.3, -0.5), C = V(-0.02, -0.68, -0.28);
    windowWall(A, B, C, false);
    windowWall(A, B, C, true);

    // ---- flight panels 1 and 2 between the windows, panel 3 sloping below, then the DSKY / ACA stations ----
    const pw = 0.34; // half width of the centre panels
    quad(skin('panels12'), V(CL - pw, -0.38, -0.52), V(CL + pw, -0.38, -0.52), V(CL - pw, 0.62, -0.56), V(CL + pw, 0.62, -0.56));
    quad(skin('panel3'), V(CL - 0.36, -0.6, -0.3), V(CL + 0.36, -0.6, -0.3), V(CL - pw, -0.38, -0.52), V(CL + pw, -0.38, -0.52));
    quad(skin('lower', 0.9), V(-0.55, -1.55, 0.15), V(2 * CL + 0.55, -1.55, 0.15), V(-0.55, -0.6, -0.3), V(2 * CL + 0.55, -0.6, -0.3));

    // ---- side walls: circuit-breaker panels (forward edge toward the windows) ----
    const zf = -0.42, za = 0.9;
    quad(skin('cdr_wall'), V(-0.62, -0.45, za), V(-0.62, -0.45, zf), V(-0.62, 0.75, za), V(-0.62, 0.75, zf));
    const xr = 2 * CL + 0.62;
    quad(skin('lmp_wall'), V(xr, -0.45, zf), V(xr, -0.45, za), V(xr, 0.6, zf), V(xr, 0.6, za));
    // forward corners between the breaker panels and the window bulkheads
    quad(wall, V(-0.62, -1.55, zf), V(-0.62, -1.55, -0.75), V(-0.62, 0.75, zf), V(-0.62, 0.75, -0.75));
    quad(wall, V(xr, -1.55, -0.75), V(xr, -1.55, zf), V(xr, 0.75, -0.75), V(xr, 0.75, zf));
    // below the breaker panels
    const lowerWall = plain(0x221f1c);
    quad(lowerWall, V(-0.62, -1.55, za), V(-0.62, -1.55, zf), V(-0.62, -0.45, za), V(-0.62, -0.45, zf));
    quad(lowerWall, V(xr, -1.55, zf), V(xr, -1.55, za), V(xr, -0.45, zf), V(xr, -0.45, za));

    // ---- aft bulkhead, ceiling, floor ----
    quad(skin('aft', 0.85), V(xr, -1.0, za), V(-0.62, -1.0, za), V(xr, 0.75, za), V(-0.62, 0.75, za));
    const ceiling = plain(0x5a4a3c);
    quad(ceiling, V(-0.62, 0.75, -0.75), V(xr, 0.75, -0.75), V(-0.62, 0.75, za), V(xr, 0.75, za));
    quad(plain(0x1a1816), V(-0.62, -1.55, za), V(xr, -1.55, za), V(-0.62, -1.55, 0.15), V(xr, -1.55, 0.15));
    quad(lowerWall, V(-0.62, -1.55, za), V(xr, -1.55, za), V(-0.62, -1.0, za), V(xr, -1.0, za));
    // strip of bulkhead above the centre panels up to the ceiling
    quad(wall, V(CL - 0.4, 0.6, -0.56), V(CL + 0.4, 0.6, -0.56), V(CL - 0.4, 0.75, -0.6), V(CL + 0.4, 0.75, -0.6));

    for (const m of this.group.children as THREE.Mesh[]) { m.renderOrder = 10; m.frustumCulled = false; }
    this.group.visible = false;
  }

  get ready() { return this.total > 0 && this.loaded === this.total; }
}

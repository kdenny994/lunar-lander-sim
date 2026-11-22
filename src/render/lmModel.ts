// Apollo LM model (user-supplied GLB), DPS exhaust glow and surface dust.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { LM } from '../sim/constants';

export class LMModel {
  /** body frame object: +X up (thrust), +Y right, +Z forward. Set its quaternion to body->render. */
  readonly body = new THREE.Group();
  readonly model = new THREE.Group();
  private plume: THREE.Mesh;
  private dust: THREE.Points;
  private dustVel: Float32Array;
  private dustLife: Float32Array;
  /** yaw of the GLB about its up axis so that its ladder/front hatch faces body +Z */
  modelYawDeg = 0;

  constructor() {
    // model frame -> body frame: model +Y -> body +X, model +Z -> body +Z, model +X -> body -Y
    this.model.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(
      new THREE.Vector3(0, -1, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)));
    this.body.add(this.model);

    // exhaust: faint additive cone below the descent engine (body -X)
    const cone = new THREE.ConeGeometry(1.1, 6, 24, 1, true);
    cone.translate(0, -3, 0);
    cone.rotateZ(-Math.PI / 2); // base (-Y) -> body -X, apex at the engine
    const pm = new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.plume = new THREE.Mesh(cone, pm);
    this.plume.position.set(-LM.cgAboveFootpads + 1.25, 0, 0);
    this.plume.scale.set(1, 1, 1);
    this.body.add(this.plume);

    // dust sheet: particles in the render frame (added to scene separately)
    const N = 2500;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    this.dustVel = new Float32Array(N * 3);
    this.dustLife = new Float32Array(N);
    const dc = document.createElement('canvas'); dc.width = dc.height = 32;
    const dg = dc.getContext('2d')!; const gr = dg.createRadialGradient(16, 16, 0, 16, 16, 16);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); dg.fillStyle = gr; dg.fillRect(0, 0, 32, 32);
    const dm = new THREE.PointsMaterial({ color: 0x9d978c, size: 0.5, map: new THREE.CanvasTexture(dc), transparent: true, opacity: 0, depthWrite: false, sizeAttenuation: true });
    this.dust = new THREE.Points(g, dm);
    this.dust.frustumCulled = false;
  }

  get dustObject() { return this.dust; }

  /** Simple stand-in LM (descent stage box, ascent stage, legs) used if the glTF can't load. */
  addPlaceholder() {
    const mat = new THREE.MeshStandardMaterial({ color: 0xb8a060, roughness: 0.6, metalness: 0.3 });
    const grey = new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.7 });
    const g = new THREE.Group();
    const desc = new THREE.Mesh(new THREE.BoxGeometry(4.2, 1.7, 4.2), mat); desc.position.y = 0.1; g.add(desc);
    const asc = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.9, 2.8, 8), grey); asc.position.y = 2.3; g.add(asc);
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2 + Math.PI / 4;
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 4.2), grey);
      const fx = Math.cos(a) * 4.0, fz = Math.sin(a) * 4.0;
      leg.position.set(fx * 0.7, -1.0, fz * 0.7);
      leg.lookAt(fx, -LM.cgAboveFootpads, fz); leg.rotateX(Math.PI / 2);
      g.add(leg);
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.47, 0.47, 0.1, 12), grey);
      pad.position.set(fx, -LM.cgAboveFootpads + 0.05, fz); g.add(pad);
    }
    g.traverse((o) => { (o as THREE.Mesh).castShadow = true; });
    this.model.add(g);
  }

  async load(url: string) {
    const gltf = await new GLTFLoader().loadAsync(url);
    const root = gltf.scene;
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const s = LM.modelHeight / size.y;
    const holder = new THREE.Group();
    holder.add(root);
    root.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
    holder.scale.setScalar(s);
    holder.position.y = -LM.cgAboveFootpads;
    holder.rotation.y = (this.modelYawDeg * Math.PI) / 180;
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true; m.receiveShadow = true;
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mt of mats) (mt as THREE.MeshStandardMaterial).envMapIntensity = 0.4;
      }
    });
    this.model.add(holder);
    return { scale: s, size };
  }

  setThrust(frac: number) {
    const m = this.plume.material as THREE.MeshBasicMaterial;
    m.opacity = frac > 0.02 ? 0.015 + 0.045 * frac : 0;
    this.plume.scale.set(0.6 + frac, 1, 1);
  }

  /** Update dust in render coordinates. groundPoint: surface point under the engine; up: local up. */
  updateDust(dt: number, altitude: number, thrustFrac: number, groundPoint: THREE.Vector3, up: THREE.Vector3) {
    const pos = this.dust.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const N = this.dustLife.length;
    const intensity = thrustFrac > 0.03 ? Math.max(0, Math.min(1, (40 - altitude) / 30)) * Math.min(1, thrustFrac * 3) : 0;
    const t1 = new THREE.Vector3(), t2 = new THREE.Vector3();
    t1.set(1, 0, 0); if (Math.abs(up.x) > 0.9) t1.set(0, 0, 1);
    t2.crossVectors(up, t1).normalize(); t1.crossVectors(t2, up).normalize();
    const spawn = Math.floor(intensity * 900 * dt * 10);
    let spawned = 0;
    for (let i = 0; i < N; i++) {
      if (this.dustLife[i] <= 0) {
        if (spawned < spawn) {
          spawned++;
          const a = Math.random() * Math.PI * 2, r0 = 1 + Math.random() * (2 + altitude * 0.2);
          const dir = t1.clone().multiplyScalar(Math.cos(a)).addScaledVector(t2, Math.sin(a));
          const p = groundPoint.clone().addScaledVector(dir, r0).addScaledVector(up, 0.15 + Math.random() * 0.3);
          arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z;
          const sp = 25 + Math.random() * 35;
          const v = dir.multiplyScalar(sp).addScaledVector(up, Math.random() * 1.5);
          this.dustVel[i * 3] = v.x; this.dustVel[i * 3 + 1] = v.y; this.dustVel[i * 3 + 2] = v.z;
          this.dustLife[i] = 0.6 + Math.random() * 0.8;
        } else {
          arr[i * 3] = arr[i * 3 + 1] = arr[i * 3 + 2] = 1e7;
        }
        continue;
      }
      this.dustLife[i] -= dt;
      arr[i * 3] += this.dustVel[i * 3] * dt; arr[i * 3 + 1] += this.dustVel[i * 3 + 1] * dt; arr[i * 3 + 2] += this.dustVel[i * 3 + 2] * dt;
    }
    pos.needsUpdate = true;
    (this.dust.material as THREE.PointsMaterial).opacity = 0.22 * intensity;
  }

  /** shift dust particles when the floating origin moves */
  shiftDust(delta: THREE.Vector3) {
    const pos = this.dust.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    for (let i = 0; i < this.dustLife.length; i++) if (this.dustLife[i] > 0) {
      arr[i * 3] -= delta.x; arr[i * 3 + 1] -= delta.y; arr[i * 3 + 2] -= delta.z;
    }
  }
}

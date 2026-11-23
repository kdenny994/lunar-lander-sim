// Procedural Starship HLS: stainless hull with the white HLS upper section, solar array band, crew windows,
// six landing legs, three sea-level Raptors (the ones the sim fires) and three vacuum Raptors (not used),
// per-engine exhaust plumes. Built in a model frame with +Y along the hull, then mapped to the body frame
// (+X nose) used by the flight model, with the CG at the origin.
import * as THREE from 'three';
import { SS, SS_ENGINES } from '../sim/starship';

const BASE_Y = -14.6; // bottom of the aft skirt, m below the CG

export class StarshipModel {
  /** body frame object: +X nose, set its quaternion to body->render */
  readonly body = new THREE.Group();
  readonly model = new THREE.Group();
  private plumes: THREE.Mesh[] = [];
  private cores: THREE.Mesh[] = [];
  /** where on the hull the crew window view sits (body frame) */
  readonly windowEye = new THREE.Vector3(26.2, 0, 4.9);

  constructor() {
    // model +Y -> body +X; model +Z -> body +Z; model +X -> body -Y
    this.model.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(
      new THREE.Vector3(0, -1, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)));
    this.body.add(this.model);

    const R = SS.diameter / 2;
    const steel = new THREE.MeshStandardMaterial({ color: 0xb9bcc0, metalness: 0.85, roughness: 0.38, map: hullTexture() });
    const white = new THREE.MeshStandardMaterial({ color: 0xeeeeea, metalness: 0.1, roughness: 0.55 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1b2433, metalness: 0.5, roughness: 0.35, map: solarTexture() });
    const black = new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.6 });
    const engineMat = new THREE.MeshStandardMaterial({ color: 0x6e6a66, metalness: 0.8, roughness: 0.45, side: THREE.DoubleSide });
    const legMat = new THREE.MeshStandardMaterial({ color: 0x8f9296, metalness: 0.7, roughness: 0.5 });

    const add = (m: THREE.Mesh) => { m.castShadow = true; m.receiveShadow = true; this.model.add(m); return m; };
    // hull: stainless lower section, white upper section (HLS thermal coating), ogive nose
    const yWhite = 17.5, yNose = 27.0, yTop = BASE_Y + SS.length;
    add(new THREE.Mesh(new THREE.CylinderGeometry(R, R, yWhite - BASE_Y, 48, 1, true), steel)).position.y = (yWhite + BASE_Y) / 2;
    add(new THREE.Mesh(new THREE.CylinderGeometry(R, R, yNose - yWhite, 48, 1, true), white)).position.y = (yNose + yWhite) / 2;
    const prof: THREE.Vector2[] = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      prof.push(new THREE.Vector2(R * Math.sqrt(Math.max(0, 1 - t * t)) * (1 - 0.06 * t), yNose + t * (yTop - yNose)));
    }
    add(new THREE.Mesh(new THREE.LatheGeometry(prof, 48), white));
    // solar array band around the upper hull
    add(new THREE.Mesh(new THREE.CylinderGeometry(R + 0.04, R + 0.04, 3.2, 48, 1, true), dark)).position.y = 21.0;
    // crew windows and airlock (on the body +Z side)
    for (let i = -2; i <= 2; i++) {
      const w = add(new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.45, 0.12), black));
      const a = i * 0.16;
      w.position.set(Math.sin(a) * (R + 0.02), 26.2, Math.cos(a) * (R + 0.02)); w.rotation.y = a;
    }
    const lock = add(new THREE.Mesh(new THREE.BoxGeometry(1.6, 2.6, 0.12), new THREE.MeshStandardMaterial({ color: 0xcfcfca, roughness: 0.5 })));
    lock.position.set(0, 9.0, R + 0.03);
    // aft dome and skirt ring
    const dome = add(new THREE.Mesh(new THREE.CircleGeometry(R, 48), black)); dome.rotation.x = Math.PI / 2; dome.position.y = BASE_Y + 0.6;
    add(new THREE.Mesh(new THREE.TorusGeometry(R, 0.12, 6, 48), steel)).rotation.x = Math.PI / 2;
    this.model.children[this.model.children.length - 1].position.y = BASE_Y;

    // engines: 3 sea-level Raptors (inner) and 3 vacuum Raptors (outer, not fired)
    const bell = (rExit: number, len: number) => {
      const g = new THREE.CylinderGeometry(rExit * 0.38, rExit, len, 32, 1, true);
      g.translate(0, -len / 2, 0);
      return g;
    };
    const slBell = bell(0.65, 1.6);
    const gimbalY = -SS.cgAboveEngines;
    for (const e of SS_ENGINES) {
      // body (x, y, z) -> model (-y, x, z)
      const m = add(new THREE.Mesh(slBell, engineMat));
      m.position.set(-e.y, gimbalY, e.z);
    }
    const vacBell = bell(1.15, 2.4);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + Math.PI / 3;
      const m = add(new THREE.Mesh(vacBell, engineMat));
      m.position.set(Math.cos(a) * 3.05, gimbalY + 0.9, Math.sin(a) * 3.05);
    }

    // six landing legs down to the pad circle
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      // body pad (y, z) = (cos a, sin a) * padRadius -> model (x, z) = (-cos a, sin a) * padRadius
      const px = -Math.cos(a) * SS.padRadius, pz = Math.sin(a) * SS.padRadius;
      const top = new THREE.Vector3(-Math.cos(a) * (R - 0.2), BASE_Y + 4.5, Math.sin(a) * (R - 0.2));
      const foot = new THREE.Vector3(px, -SS.cgAbovePads + 0.35, pz);
      const leg = add(new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, 1, 10), legMat));
      leg.position.copy(top).add(foot).multiplyScalar(0.5);
      leg.scale.y = top.distanceTo(foot);
      leg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), top.clone().sub(foot).normalize());
      const pad = add(new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.95, 0.3, 16), legMat));
      pad.position.set(px, -SS.cgAbovePads + 0.15, pz);
    }

    // exhaust: methalox in vacuum is nearly transparent; a faint blue-violet cone and a bright core per engine
    for (const e of SS_ENGINES) {
      const cone = new THREE.ConeGeometry(2.2, 26, 24, 1, true);
      cone.translate(0, -13, 0); // apex at the nozzle exit, widening downward (model -Y)
      const pm = new THREE.MeshBasicMaterial({ color: 0x9fa8ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      const p = new THREE.Mesh(cone, pm);
      p.position.set(-e.y, gimbalY - 1.6, e.z);
      this.model.add(p); this.plumes.push(p);
      const core = new THREE.ConeGeometry(0.6, 4.5, 16, 1, true);
      core.translate(0, -2.25, 0);
      const cm = new THREE.MeshBasicMaterial({ color: 0xffd6a8, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      const c = new THREE.Mesh(core, cm);
      c.position.copy(p.position);
      this.model.add(c); this.cores.push(c);
    }
  }

  /** per-engine thrust fraction (0 = off, 0.4..1 running) */
  setEngines(eng: number[]) {
    for (let i = 0; i < 3; i++) {
      const f = eng[i] ?? 0;
      const on = f > 0.02;
      (this.plumes[i].material as THREE.MeshBasicMaterial).opacity = on ? 0.03 + 0.05 * f : 0;
      this.plumes[i].scale.set(0.7 + 0.5 * f, 0.6 + 0.6 * f, 0.7 + 0.5 * f);
      (this.cores[i].material as THREE.MeshBasicMaterial).opacity = on ? 0.35 + 0.4 * f : 0;
      this.cores[i].scale.set(1, 0.7 + 0.6 * f, 1);
    }
  }
}

function hullTexture() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#c4c7cb'; g.fillRect(0, 0, 256, 512);
  // stainless ring welds and a hint of streaking
  for (let y = 0; y < 512; y += 28) { g.fillStyle = 'rgba(60,60,60,0.35)'; g.fillRect(0, y, 256, 2); }
  for (let i = 0; i < 160; i++) {
    g.fillStyle = `rgba(${Math.random() < 0.5 ? '255,255,255' : '40,40,40'},${0.03 + Math.random() * 0.05})`;
    g.fillRect(Math.random() * 256, Math.random() * 512, 1 + Math.random() * 3, 20 + Math.random() * 80);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping; t.repeat.set(4, 1);
  return t;
}

function solarTexture() {
  const c = document.createElement('canvas'); c.width = 512; c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#1c2a44'; g.fillRect(0, 0, 512, 64);
  g.strokeStyle = 'rgba(160,180,220,0.35)';
  for (let x = 0; x < 512; x += 16) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 64); g.stroke(); }
  for (let y = 0; y < 64; y += 16) { g.beginPath(); g.moveTo(0, y); g.lineTo(512, y); g.stroke(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping; t.repeat.set(6, 1);
  return t;
}

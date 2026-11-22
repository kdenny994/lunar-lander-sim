import * as THREE from 'three';
import { FT, LM, MOON, SUBEARTH, SUBSOLAR } from './sim/constants';
import { RenderFrame, enuAt, llrToVec, vecToLLR } from './sim/geo';
import { TerrainData } from './sim/terrainData';
import { Replay, type ReplaySample, type TrajectoryFile } from './sim/replay';
import { LMState, stepLM } from './sim/lm';
import { DigitalAutopilot } from './sim/dap';
import { TerrainRenderer } from './render/terrain';
import { LMModel } from './render/lmModel';
import { InputManager, type Action } from './ui/input';
import { setupTouch } from './ui/touch';
import { Hud } from './ui/hud';

const BASE = './data';
const $ = (id: string) => document.getElementById(id)!;
const loadMsg = (m: string, frac?: number) => { $('ld-msg').textContent = m; if (frac !== undefined) ($('ld-bar') as HTMLElement).style.width = `${Math.round(frac * 100)}%`; };

type Mode = 'replay' | 'flight';
type View = 'chase' | 'cockpit' | 'ground';

async function main() {
  loadMsg('Loading trajectory…', 0.02);
  const traj: TrajectoryFile = await fetch(`${BASE}/apollo11_trajectory.json`).then((r) => r.json());
  const terrain = await TerrainData.load(`${BASE}/terrain`, (m) => loadMsg(m, 0.08));
  const replay = new Replay(traj, terrain);
  const frame = new RenderFrame(traj.landing.lat, traj.landing.lon);

  // ---------- renderer / scene ----------
  // phones and tablets: cap the pixel ratio and shadow resolution to keep frame rate and GPU memory in check
  const mobile = matchMedia('(pointer: coarse)').matches || /iPhone|iPad|Android/.test(navigator.userAgent);
  const renderer = new THREE.WebGLRenderer({ antialias: !mobile || window.devicePixelRatio < 2, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, mobile ? 1.5 : 2));
  renderer.domElement.addEventListener('webglcontextlost', (e) => { e.preventDefault(); loadMsg('The graphics context was lost (the device reclaimed GPU memory). Reload the page to continue.'); $('loading').hidden = false; });
  for (const ev of ['gesturestart', 'gesturechange', 'dblclick']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  $('app').appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 4e6);

  const sunDirW = llrToVec(SUBSOLAR.lat, SUBSOLAR.lon, 1); // MCMF unit
  const earthDirW = llrToVec(SUBEARTH.lat, SUBEARTH.lon, 1);
  const sun = new THREE.DirectionalLight(0xfff6ea, 3.2);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(mobile ? 1024 : 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.05;
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -16; sc.right = 16; sc.top = 16; sc.bottom = -16;
  scene.add(sun, sun.target);
  scene.add(new THREE.AmbientLight(0x9fb4d0, 0.05)); // earthshine
  // Earth: gibbous disc
  const earth = makeEarth();
  scene.add(earth);

  const terrainR = new TerrainRenderer(terrain, frame, `${BASE}/terrain`);
  terrainR.anisotropy = renderer.capabilities.getMaxAnisotropy();
  scene.add(terrainR.group);
  const lm = new LMModel();
  scene.add(lm.body, lm.dustObject);
  loadMsg('Loading lunar module…', 0.15);
  await lm.load('./models/apollo_lm.gltf.json', './draco/');
  loadMsg('Loading LROC imagery…', 0.2);
  await terrainR.loadTextures((d, n) => loadMsg(`Loading LROC imagery… ${d}/${n}`, 0.2 + 0.7 * (d / n)));

  // ---------- simulation state ----------
  const input = new InputManager();
  const touch = setupTouch(input);
  const dap = new DigitalAutopilot();
  const hud = new Hud(traj);
  const phys = new LMState();
  let mode: Mode = 'replay';
  let view: View = 'chase';
  let tRail = 0;
  let paused = false;
  const warps = [1, 2, 5, 10, 20];
  let warpI = 0;
  const rs: ReplaySample = replay.sample(0);
  const origin = new THREE.Vector3();
  const prevOrigin = new THREE.Vector3();
  let firstFrame = true;
  let lowLevelT = Infinity;

  const disp = { r: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Quaternion(), thrust: 0, mass: 0, dpsProp: 0, rcsProp: LM.rcsProp, t: 0, program: '63', contact: false };

  function setMode(m: Mode) {
    mode = m;
    if (m === 'flight') {
      replay.sample(tRail, rs);
      phys.r.copy(rs.r); phys.v.copy(rs.v); phys.q.copy(rs.q); phys.w.set(0, 0, 0);
      phys.dpsProp = rs.dpsProp; phys.rcsProp = disp.rcsProp; phys.thrust = rs.thrust; phys.t = tRail;
      phys.dryMass = rs.mass - rs.dpsProp - phys.rcsProp;
      phys.contact = { contactLight: false, padsDown: 0, touchdown: null }; phys.landed = false; phys.crashed = false;
      dap.engage(phys); dap.engineArmed = true;
      dap.throttleMode = tRail >= 500 ? 'p66' : 'manual';
      input.state.throttle = Math.max(LM.dpsMinThrottle, rs.thrust);
      if (warpI > 2) warpI = 2;
      hud.event('Manual control: rate command / attitude hold' + (dap.throttleMode === 'p66' ? ', P66 rate of descent' : ', manual throttle'), phys.t);
    } else {
      hud.event('Replay resumed', tRail);
    }
    hud.setMode(m, dap.throttleMode);
    touch.show(m === 'flight');
  }

  function restart(t: number, manual: boolean) {
    tRail = t; lowLevelT = Infinity;
    terrainR.warm(replay.sample(t).r, 2);
    hud.clearEvents(); hud.resetEvents(t);
    disp.rcsProp = LM.rcsProp;
    $('result').hidden = true;
    mode = 'replay';
    if (manual) setMode('flight'); else { hud.setMode('replay', dap.throttleMode); touch.show(false); }
  }

  input.on((a: Action) => {
    switch (a) {
      case 'takeControl': if (mode === 'replay') setMode('flight'); else { tRail = Math.min(phys.t, replay.duration); setMode('replay'); } break;
      case 'view': view = view === 'chase' ? 'cockpit' : view === 'cockpit' ? 'ground' : 'chase'; break;
      case 'pause': paused = !paused; break;
      case 'warpUp': warpI = Math.min(mode === 'flight' ? 2 : warps.length - 1, warpI + 1); break;
      case 'warpDown': warpI = Math.max(0, warpI - 1); break;
      case 'rodUp': if (mode === 'flight') { dap.rodClick(1); hud.flash(`ROD ${fmtRate(dap.hdotCmd)}`); } break;
      case 'rodDown': if (mode === 'flight') { dap.rodClick(-1); hud.flash(`ROD ${fmtRate(dap.hdotCmd)}`); } break;
      case 'throttleMode':
        if (mode === 'flight') {
          dap.throttleMode = dap.throttleMode === 'p66' ? 'manual' : 'p66';
          if (dap.throttleMode === 'p66') dap.engage(phys); else input.state.throttle = phys.thrust;
          hud.setMode(mode, dap.throttleMode);
        }
        break;
      case 'engineStop': if (mode === 'flight') { dap.engineArmed = !dap.engineArmed; hud.event(dap.engineArmed ? 'Engine armed' : 'Engine stop', phys.t); } break;
      case 'restart': restart(0, false); break;
    }
  });

  // ---------- buttons ----------
  $('btn-view').addEventListener('click', () => input.emit('view'));
  $('btn-pause').addEventListener('click', () => input.emit('pause'));
  $('btn-warp').addEventListener('click', () => { warpI = (warpI + 1) % (mode === 'flight' ? 3 : warps.length); });
  $('btn-take').addEventListener('click', () => input.emit('takeControl'));
  $('btn-help').addEventListener('click', () => { $('help').hidden = false; });
  $('help-close').addEventListener('click', () => { $('help').hidden = true; });
  $('res-close').addEventListener('click', () => { $('result').hidden = true; });
  $('btn-start').addEventListener('click', () => { $('start-menu').hidden = !$('start-menu').hidden; });
  for (const b of Array.from(document.querySelectorAll('#start-menu button'))) {
    b.addEventListener('click', () => {
      restart(Number((b as HTMLElement).dataset.t), ($('start-manual') as HTMLInputElement).checked);
      $('start-menu').hidden = true;
    });
  }
  $('credits').innerHTML = [
    ...traj.sources,
    (terrain.corridor.meta.source as string), (terrain.site.meta.source as string),
    'LM 3D model supplied by the project owner.',
  ].map((s) => `• ${s}`).join('<br>');

  // ---------- camera controls (drag / wheel / pinch) ----------
  const camCtl = { az: Math.PI, el: 0.25, dist: window.innerWidth < window.innerHeight ? 46 : 28, lookYaw: 0, lookPitch: -0.55 };
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch0 = 0;
  renderer.domElement.addEventListener('pointerdown', (e) => { pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); renderer.domElement.setPointerCapture(e.pointerId); });
  renderer.domElement.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch0) camCtl.dist = Math.min(5000, Math.max(8, camCtl.dist * (pinch0 / d)));
      pinch0 = d; return;
    }
    if (view === 'cockpit') {
      camCtl.lookYaw = Math.max(-1.2, Math.min(1.2, camCtl.lookYaw - dx * 0.004));
      camCtl.lookPitch = Math.max(-1.3, Math.min(0.6, camCtl.lookPitch - dy * 0.004));
    } else {
      camCtl.az -= dx * 0.006; camCtl.el = Math.max(-0.2, Math.min(1.5, camCtl.el + dy * 0.004));
    }
  });
  const up = (e: PointerEvent) => { pointers.delete(e.pointerId); pinch0 = 0; };
  renderer.domElement.addEventListener('pointerup', up);
  renderer.domElement.addEventListener('pointercancel', up);
  renderer.domElement.addEventListener('wheel', (e) => { camCtl.dist = Math.min(5000, Math.max(8, camCtl.dist * Math.exp(e.deltaY * 0.001))); e.preventDefault(); }, { passive: false });
  const onResize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', onResize);
  window.visualViewport?.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(onResize, 300));

  // ---------- loop ----------
  loadMsg('Building terrain…', 0.95);
  replay.sample(0, rs);
  origin.copy(rs.r);
  terrainR.warm(origin, 3);
  $('loading').hidden = true;
  hud.resetEvents(0);
  hud.setMode('replay', dap.throttleMode);
  touch.show(false);

  const clock = new THREE.Clock();
  const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
  const qRender = new THREE.Quaternion();
  let physAcc = 0;
  const PHYS_DT = 0.005;

  function frameLoop() {
    requestAnimationFrame(frameLoop);
    const dtReal = Math.min(0.1, clock.getDelta());
    input.update(dtReal);
    const warp = warps[warpI];
    const dt = paused ? 0 : dtReal * warp;

    if (mode === 'replay') {
      const t0 = tRail;
      tRail = Math.min(replay.duration + 30, tRail + dt);
      replay.sample(tRail, rs);
      disp.r.copy(rs.r); disp.v.copy(rs.v); disp.q.copy(rs.q); disp.thrust = rs.thrust; disp.mass = rs.mass; disp.dpsProp = rs.dpsProp;
      disp.t = tRail; disp.program = rs.program;
      disp.contact = tRail >= replay.duration - 1.0;
      for (const ev of replay.eventsBetween(t0, tRail)) hud.event(ev.label, ev.tfi, ev.get);
      if (tRail >= replay.duration) { disp.thrust = 0; disp.v.set(0, 0, 0); }
    } else {
      physAcc += dt;
      let n = 0;
      while (physAcc >= PHYS_DT && n < 4000) {
        const c = dap.update(phys, input.state, PHYS_DT);
        stepLM(phys, c, PHYS_DT, terrain);
        physAcc -= PHYS_DT; n++;
        if (phys.contact.contactLight && !disp.contact) { hud.event('Contact light', phys.t); }
        disp.contact = phys.contact.contactLight;
      }
      disp.r.copy(phys.r); disp.v.copy(phys.v); disp.q.copy(phys.q); disp.thrust = phys.thrust; disp.mass = phys.mass;
      disp.dpsProp = phys.dpsProp; disp.rcsProp = phys.rcsProp; disp.t = phys.t; disp.program = '66';
      if (phys.contact.touchdown && $('result').hidden && !hud.resultShown) showResult();
      if (phys.dpsProp < 520 && lowLevelT === Infinity) { lowLevelT = phys.t; hud.event('DES QTY low-level light', phys.t); }
    }

    // ---- floating origin at the LM CG ----
    prevOrigin.copy(origin);
    origin.copy(disp.r);
    if (!firstFrame) lm.shiftDust(frame.dir(tmp.copy(origin).sub(prevOrigin)));
    firstFrame = false;
    const { e: E, n: N, u: U } = enuAt(origin);
    const upR = frame.dir(U).normalize();
    const eastR = frame.dir(E).normalize();
    const northR = frame.dir(N).normalize();
    qRender.copy(frame.q).multiply(disp.q);
    lm.body.position.set(0, 0, 0);
    lm.body.quaternion.copy(qRender);
    lm.setThrust(disp.thrust);

    const { lat, lon, r } = vecToLLR(disp.r);
    const ground = MOON.radius + terrain.heightAt(lat, lon);
    const altCG = r - ground;
    const altPads = altCG - LM.cgAboveFootpads;

    // ---- sun / shadow ----
    const sunR = frame.dir(sunDirW).normalize();
    const sinEl = Math.max(0.05, sunR.dot(upR));
    const tGround = Math.min(2000, Math.max(0, altCG) / sinEl);
    const target = tmp.copy(sunR).multiplyScalar(-tGround);
    sun.target.position.copy(target);
    sun.position.copy(target).addScaledVector(sunR, 60);
    sc.near = 1; sc.far = 140; sc.updateProjectionMatrix();
    sun.castShadow = altCG < 1500;

    // ---- dust ----
    const groundPt = tmp2.copy(upR).multiplyScalar(-altCG);
    lm.updateDust(dt, altPads, disp.thrust, groundPt, upR);

    // ---- camera ----
    lm.model.visible = view !== 'cockpit';
    $('cockpit').hidden = view !== 'cockpit';
    if (view === 'cockpit') {
      camera.fov = 62;
      // commander's eye: left (-Y) station, looking out the forward window
      const eye = new THREE.Vector3(1.0, -0.55, 1.05).applyQuaternion(qRender);
      camera.position.copy(eye);
      const fwd = new THREE.Vector3(0, 0, 1), upB = new THREE.Vector3(1, 0, 0);
      const look = fwd.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), camCtl.lookPitch)
        .applyAxisAngle(new THREE.Vector3(1, 0, 0), camCtl.lookYaw);
      camera.up.copy(upB.applyQuaternion(qRender));
      camera.lookAt(eye.add(look.applyQuaternion(qRender)));
    } else if (view === 'chase') {
      camera.fov = 50;
      // orbit in local ENU, azimuth relative to the direction of travel
      const vh = frame.dir(disp.v).addScaledVector(upR, -frame.dir(disp.v).dot(upR));
      const heading = vh.lengthSq() > 1 ? Math.atan2(vh.dot(eastR), vh.dot(northR)) : -Math.PI / 2;
      const az = heading + camCtl.az;
      const dir = northR.clone().multiplyScalar(Math.cos(az) * Math.cos(camCtl.el))
        .addScaledVector(eastR, Math.sin(az) * Math.cos(camCtl.el)).addScaledVector(upR, Math.sin(camCtl.el));
      camera.position.copy(dir.multiplyScalar(camCtl.dist));
      // keep the camera above the ground
      const camAlt = camera.position.dot(upR) + altCG;
      if (camAlt < 1.6) camera.position.addScaledVector(upR, 1.6 - camAlt);
      camera.up.copy(upR);
      camera.lookAt(0, 0, 0);
    } else {
      // ground observer near Tranquility Base, 120 m south-west of the landing point
      camera.fov = 40;
      const site = llrToVec(traj.landing.lat - 0.0025, traj.landing.lon - 0.003, 0);
      const sh = terrain.heightAt(traj.landing.lat - 0.0025, traj.landing.lon - 0.003);
      site.setLength(MOON.radius + sh + 1.7);
      camera.position.copy(frame.dir(site.sub(origin)));
      camera.up.copy(upR);
      camera.lookAt(0, 0, 0);
    }
    camera.updateProjectionMatrix();

    // earth sprite far away along its direction
    const eR = frame.dir(earthDirW).normalize();
    earth.position.copy(camera.position).addScaledVector(eR, 3.0e5);
    earth.lookAt(camera.position);
    (earth.material as THREE.MeshBasicMaterial).needsUpdate = false;

    terrainR.update(origin, camera.position);
    renderer.render(scene, camera);

    // ---- HUD ----
    const vR = disp.v;
    const hdot = vR.dot(U);
    // cross-pointer axes: body +Z projected on the horizontal, or -X when the LM is tilted past 45 deg
    const xb = new THREE.Vector3(1, 0, 0).applyQuaternion(disp.q);
    const fwdDir = Math.abs(xb.dot(U)) < 0.7 ? xb.clone().negate() : new THREE.Vector3(0, 0, 1).applyQuaternion(disp.q);
    fwdDir.addScaledVector(U, -fwdDir.dot(U)).normalize();
    const latDir = fwdDir.clone().cross(U).normalize(); // to the right
    const pitchFromVert = Math.acos(Math.max(-1, Math.min(1, xb.dot(U)))) * 180 / Math.PI;
    const range = mode === 'replay' ? rs.downrange : surfaceDistance(disp.r, traj.landing.lat, traj.landing.lon);
    hud.update({
      t: disp.t, program: disp.program, altitude: Math.max(0, altPads), hdot,
      vFwd: vR.dot(fwdDir), vLat: vR.dot(latDir), thrust: disp.thrust, dpsProp: disp.dpsProp, rcsProp: disp.rcsProp,
      pitch: pitchFromVert, range, contact: disp.contact, mode, throttleMode: dap.throttleMode, hdotCmd: dap.hdotCmd,
      engineArmed: mode === 'replay' ? disp.thrust > 0 : dap.engineArmed, lowLevel: disp.t >= (mode === 'replay' ? 683 : lowLevelT),
      warp, paused, view,
      lpd: computeLPD(disp, traj, frame),
    });
    if (view === 'cockpit') hud.drawLPD(camera, qRender);
  }

  function showResult() {
    const td = phys.contact.touchdown!;
    hud.resultShown = true;
    const good = td.vVert <= 3.05 && td.vHorz <= 1.22 && td.tilt <= 12;
    $('res-title').textContent = phys.crashed ? 'Crash' : good ? 'The Eagle has landed' : 'Hard landing';
    const d = surfaceDistance(phys.r, traj.landing.lat, traj.landing.lon);
    $('res-body').innerHTML = [
      `Vertical speed: ${(td.vVert / FT).toFixed(1)} ft/s (limit 10)`,
      `Horizontal speed: ${(td.vHorz / FT).toFixed(1)} ft/s (limit 4)`,
      `Tilt: ${td.tilt.toFixed(1)}° (limit 12°)`,
      `DPS propellant left: ${Math.round(phys.dpsProp)} kg (${(phys.dpsProp / (phys.thrust * LM.dpsMaxThrust / (LM.dpsIsp * 9.80665) || 4)).toFixed(0)} s)`,
      `Distance from Tranquility Base: ${d.toFixed(0)} m`,
    ].join('<br>');
    $('result').hidden = false;
  }

  frameLoop();
  (window as any).__sim = { replay, phys, setMode, restart, get mode() { return mode; }, get t() { return disp.t; }, setView: (v: View) => { view = v; }, camCtl, renderer };
}

function fmtRate(v: number) { const f = v / FT; return `${f >= 0 ? '+' : ''}${f.toFixed(0)} ft/s`; }

function surfaceDistance(r: THREE.Vector3, lat: number, lon: number) {
  const s = llrToVec(lat, lon, 1);
  return Math.acos(Math.min(1, r.clone().normalize().dot(s))) * MOON.radius;
}

/** Landing point designator angle: angle below body +Z of the line of sight to the target (deg). */
function computeLPD(d: { r: THREE.Vector3; q: THREE.Quaternion }, traj: TrajectoryFile, _f: RenderFrame) {
  const target = llrToVec(traj.landing.lat, traj.landing.lon, d.r.length() - 0); // direction only near target
  const siteH = 0; void siteH;
  const los = target.setLength(MOON.radius - 1930).sub(d.r).normalize();
  const inv = d.q.clone().invert();
  const b = los.applyQuaternion(inv);
  return Math.atan2(-b.x, b.z) * 180 / Math.PI;
}

function makeEarth() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(110, 110, 20, 128, 128, 126);
  grd.addColorStop(0, '#d9ecff'); grd.addColorStop(0.5, '#5d8fd6'); grd.addColorStop(1, '#1d3c78');
  g.fillStyle = grd; g.beginPath(); g.arc(128, 128, 124, 0, Math.PI * 2); g.fill();
  g.fillStyle = 'rgba(255,255,255,0.55)';
  for (let i = 0; i < 40; i++) { g.beginPath(); g.ellipse(40 + Math.random() * 180, 40 + Math.random() * 180, 8 + Math.random() * 30, 4 + Math.random() * 8, Math.random() * 3, 0, Math.PI * 2); g.fill(); }
  // night side (gibbous, lit from the east)
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = 'rgba(0,0,0,0.92)';
  g.beginPath(); g.ellipse(128 - 70, 128, 60, 124, 0, 0, Math.PI * 2); g.rect(0, 0, 0, 0); g.fill();
  g.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const size = 2 * 3.0e5 * Math.tan((0.95 * Math.PI) / 180);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }));
  m.renderOrder = -1;
  return m;
}

main().catch((e) => { console.error(e); loadMsg(`Failed to start: ${e?.message ?? e}`); });
